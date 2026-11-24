import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'modules/sr_gacha/files/apps/srGachaLog.js'), 'utf8')
const code = source.replace(/^import .*$/gm, '').replace('export class srGachaLog', 'class srGachaLog') +
  '\nglobalThis.apiTest = { fetchCookieToken, cookieFromEntry, prepareCookie, badgeLogin, lazyGachaCookie, srGachaLog };'
const uid = '100000001'
const secret = 'v2_unit_secret_not_a_real_credential'
const entry = { stuid: '101', stoken: secret, mid: 'unit-mid' }
const md5 = s => crypto.createHash('md5').update(s).digest('hex')
const response = (json, options = {}) => ({
  ok: options.status == null || (options.status >= 200 && options.status < 300),
  status: options.status ?? 200,
  json: async () => json,
  headers: { raw: () => ({ 'set-cookie': options.cookies ?? [] }) },
})
const exchange = (overrides = {}) => ({
  retcode: 0,
  data: { token: { token_type: 4, token: 'unit-cookie-token' }, user_info: { aid: '101', mid: 'unit-mid' } },
  ...overrides,
})
function harness(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xhh-sr-gacha-auth-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const calls = [], logs = [], fallbackCalls = [], replies = [], rendered = []
  const currentEntry = options.entry ?? entry
  const context = {
    fs, path, crypto, md5, AbortController, AbortSignal, URL, URLSearchParams, Buffer,
    setTimeout, clearTimeout, process: { cwd: () => directory }, pluginDir: directory,
    moment: () => ({ format: () => '2026-11-24 00:00:00' }),
    plugin: class { constructor(config) { this.config = config } },
    logger: Object.fromEntries(['debug', 'info', 'warn', 'error'].map(k => [k, s => logs.push(String(s))])),
    guardModule() {}, ensureRuntime: async () => {},
    getstoken: async () => options.raw ?? `stuid=${currentEntry.stuid};stoken=${currentEntry.stoken};mid=${currentEntry.mid || ''};`,
    findStokenEntry: () => currentEntry,
    loadStokenYaml: () => options.entries ?? { [uid]: currentEntry },
    stokenToCookie: async raw => { fallbackCalls.push(raw); return options.fallbackCookie ?? '' },
    cookiePart: (s, key) => (String(s || '').match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`)) || [])[1] || '',
    createUser: async () => ({ getUid: () => uid, getUidList: () => [uid] }),
    fetch: async (url, init) => {
      calls.push({ url: String(url), init })
      if (options.fetch) return options.fetch(String(url), init, calls)
      if (String(url).includes('/app/exchange')) return response(exchange())
      if (String(url).includes('getCookieAccountInfoBySToken')) return response({ retcode: 0, data: { uid: '101', cookie_token: 'legacy-cookie' } })
      if (String(url).includes('getUserGameRolesByCookie')) return response({ retcode: 0, data: { list: [{ game_uid: uid, region: 'prod_gf_cn' }] } })
      if (String(url).includes('/badge/')) return response({ retcode: 0 }, { cookies: ['e_hkrpg_token=unit-gacha-cookie; Path=/'] })
      throw new Error('Unexpected test URL')
    },
  }
  vm.createContext(context)
  vm.runInContext(code, context, { filename: 'srGachaLog.js' })
  const api = context.apiTest
  const app = new api.srGachaLog()
  app.e = { user_id: 'unit-user', msg: '*更新抽卡记录' }
  app.reply = async text => replies.push(text)
  app.renderAll = async value => rendered.push(value)
  app.runUpdate = options.runUpdate ?? (async () => ({ log: 'updated', pools: [], failed: false }))
  return { api, app, calls, logs, fallbackCalls, replies, rendered, directory }
}

test('v2 使用同账号 POST exchange，返回新票据且不走旧接口', async t => {
  const h = harness(t)
  assert.equal(await h.api.fetchCookieToken('101', secret, 'unit-mid'), 'unit-cookie-token')
  assert.equal(h.calls.length, 1)
  const { url, init } = h.calls[0]
  assert.ok(url.endsWith('/account/ma-cn-session/app/exchange'))
  assert.equal(init.method, 'POST')
  assert.ok(init.signal instanceof AbortSignal)
  assert.deepEqual(JSON.parse(init.body), { src_token: { token: secret, token_type: 1 }, mid: 'unit-mid', dst_token_type: 4 })
  assert.equal(init.headers.Cookie, `stuid=101;stoken=${secret};mid=unit-mid;`)
  assert.equal(init.headers['x-rpc-app_id'], 'bll8iq97cem8')
  assert.match(init.headers['x-rpc-device_id'], /^[0-9A-F]{32}$/)
  const [time, random, signature] = init.headers.DS.split(',')
  assert.ok(Number(random) >= 100001 && Number(random) <= 200000)
  assert.equal(signature, md5(`salt=JwYDpKvLj6MrMqqYU6jTKF17KNO2PXoS&t=${time}&r=${random}&b=${init.body}&q=`))
  assert.ok(!url.includes(secret))
})
for (const [name, token, mid] of [['旧版 stoken', 'unit-v1-token', 'unit-mid'], ['缺 mid 的旧存档', secret, '']]) {
  test(name + '保留兼容入口', async t => {
    const h = harness(t)
    assert.equal(await h.api.fetchCookieToken('101', token, mid), 'legacy-cookie')
    assert.equal(h.calls.length, 1)
    assert.ok(h.calls[0].url.endsWith('/getCookieAccountInfoBySToken'))
  })
}
for (const alias of ['aid', 'uid', 'account_id']) {
  test('exchange 按返回账号 ' + alias + ' 校验归属', async t => {
    const h = harness(t, { fetch: async () => response(exchange({ data: { token: { token_type: 4, token: 'good' }, user_info: { [alias]: 101 } } })) })
    assert.equal(await h.api.fetchCookieToken('101', secret, 'unit-mid'), 'good')
  })
}
for (const [name, data] of [
  ['其他账号', { token: { token_type: 4, token: 'bad' }, user_info: { aid: '202', mid: 'unit-mid' } }],
  ['其他 mid', { token: { token_type: 4, token: 'bad' }, user_info: { aid: '101', mid: 'other-mid' } }],
  ['错误票据类型', { token: { token_type: 1, token: 'bad' }, user_info: { aid: '101' } }],
  ['缺账号信息', { token: { token_type: 4, token: 'bad' } }],
  ['缺票据信息', { user_info: { aid: '101' } }],
  ...[undefined, null, '', ' ', 'null', 'undefined', 123].map(token => ['无效票据 ' + String(token), { token: { token_type: 4, token }, user_info: { aid: '101' } }]),
]) {
  test('拒绝 ' + name + '，不回退到坏票据', async t => {
    const h = harness(t, { fetch: async () => response(exchange({ data })) })
    await assert.rejects(h.api.cookieFromEntry({ ...entry, raw: { ck: 'cookie_token=stale' } }), e => e.code === 'XHH_GACHA_AUTH')
    assert.equal(h.calls.length, 1)
    assert.equal(h.fallbackCalls.length, 0)
    assert.ok(!h.logs.join('\n').includes(secret))
  })
}
for (const retcode of [-100, -464, -101]) {
  test('换票业务失败 ' + retcode + ' 给安全中文提示', async t => {
    const h = harness(t, { fetch: async () => response({ retcode, message: 'server-internal-detail ' + secret }) })
    await assert.rejects(h.api.fetchCookieToken('101', secret, 'unit-mid'), e => e.code === 'XHH_GACHA_AUTH' && !e.message.includes(secret))
    assert.ok(!h.logs.join('\n').includes(secret))
  })
}
for (const [name, fetch] of [
  ['HTTP错误', async () => response(exchange(), { status: 503 })],
  ['非JSON响应', async () => response(null)],
  ['超时', async () => { const e = new Error('request secret ' + secret); e.name = 'AbortError'; throw e }],
  ['网络异常', async () => { throw new Error('request secret ' + secret) }],
]) {
  test(name + ' 不冒充换票成功，也不泄露凭据', async t => {
    const h = harness(t, { fetch })
    await assert.rejects(h.api.fetchCookieToken('101', secret, 'unit-mid'), e => e.code === 'XHH_GACHA_AUTH' && !e.message.includes(secret))
    assert.ok(!h.logs.join('\n').includes(secret))
  })
}
test('旧入口也拒绝账号不匹配和空票据', async t => {
  for (const data of [{ uid: '202', cookie_token: 'bad' }, { uid: '101', cookie_token: '' }]) {
    const h = harness(t, { fetch: async () => response({ retcode: 0, data }) })
    await assert.rejects(h.api.fetchCookieToken('101', 'v1-token', ''), e => e.code === 'XHH_GACHA_AUTH')
  }
})
test('仅有完整旧 CK 的用户仍可走已有兜底', async t => {
  const h = harness(t, { fallbackCookie: 'account_id=101;cookie_token=existing' })
  assert.equal(await h.api.cookieFromEntry({ raw: { ck: 'existing' } }), 'account_id=101;cookie_token=existing')
  assert.equal(h.calls.length, 0)
  assert.equal(h.fallbackCalls.length, 1)
})
test('更新鉴权成功后使用正确 UID 更新和出图', async t => {
  const h = harness(t)
  await h.app.updateLog()
  assert.deepEqual(h.rendered, [uid])
  assert.equal(h.calls.filter(c => c.url.includes('/app/exchange')).length, 1)
  assert.equal(h.calls.filter(c => c.url.includes('/badge/')).length, 1)
  assert.equal(h.replies.length, 1)
})
test('多个候选账号：一个换票失败后继续尝试本用户的其他账号', async t => {
  const other = { stuid: '202', stoken: 'v2_other_unit', mid: 'other-mid' }
  const h = harness(t, { entries: { a: entry, b: other }, fetch: async (url, init) => {
    if (url.includes('/app/exchange')) return JSON.parse(init.body).mid === 'unit-mid'
      ? response({ retcode: -100 })
      : response(exchange({ data: { token: { token_type: 4, token: 'other-good' }, user_info: { aid: '202', mid: 'other-mid' } } }))
    if (url.includes('getUserGameRolesByCookie')) return response({ retcode: 0, data: { list: [{ game_uid: uid, region: 'prod_gf_cn' }] } })
    throw new Error('Unexpected URL')
  } })
  const value = await h.api.prepareCookie(h.app.e, uid, {}, { allowFix: false })
  assert.equal(value.cookie, 'account_id=202;cookie_token=other-good')
  assert.equal(value.uid, uid)
})
test('其他 UID 的凭据不能冒充目标 UID 的属主', async t => {
  const h = harness(t, { fetch: async url => url.includes('/app/exchange')
    ? response(exchange())
    : response({ retcode: 0, data: { list: [{ game_uid: '100000099', region: 'prod_gf_cn' }] } }) })
  await assert.rejects(h.api.prepareCookie(h.app.e, uid, {}, { allowFix: false }), e => e.code === 'XHH_GACHA_AUTH' && e.message.includes('不在'))
})
test('所有候选失败时保留可操作鉴权错误', async t => {
  const h = harness(t, { fetch: async () => response({ retcode: -100 }) })
  await h.app.updateLog()
  assert.ok(h.replies.at(-1).includes('#扫码登录'))
  assert.ok(!h.replies.at(-1).includes('XHH_GACHA_AUTH'))
  assert.equal(h.rendered.length, 0)
})
test('强制更新鉴权失败保留旧记录并给出登录步骤', async t => {
  let writes = 0
  const h = harness(t, { fetch: async () => response({ retcode: -100 }), runUpdate: async () => { writes++; throw new Error('must not write') } })
  h.app.e.msg = '*强制更新记录'
  await h.app.updateLog()
  assert.equal(writes, 0)
  assert.match(h.replies.at(-1), /旧记录已保留/)
  assert.match(h.replies.at(-1), /#扫码登录/)
})
test('badge 拒绝登录时直接给可操作提示', async t => {
  const h = harness(t, { fetch: async () => response({ retcode: -100, message: '未登录' }) })
  await assert.rejects(h.api.badgeLogin('cookie_token=unit', uid, 'prod_gf_cn'), e => e.code === 'XHH_GACHA_AUTH' && e.message.includes('#扫码登录'))
})
test('未知故障不把内部堆栈或错误字段发给用户', async t => {
  const h = harness(t, { runUpdate: async () => { throw new Error('private-stack-field') } })
  await h.app.updateLog()
  assert.equal(h.replies.at(-1), '崩铁抽卡记录更新失败，请稍后重试')
  assert.ok(!h.replies.join('\n').includes('private-stack-field'))
})
test('出图补垫抽也复用新鉴权链路，单次出图并发只换票一次', async t => {
  const h = harness(t)
  const get = h.api.lazyGachaCookie(h.app.e, uid)
  const values = await Promise.all([get(), get()])
  assert.equal(values[0], values[1])
  assert.ok(values[0].includes('e_hkrpg_token='))
  assert.equal(h.calls.filter(c => c.url.includes('/app/exchange')).length, 1)
  assert.equal(h.calls.filter(c => c.url.includes('/badge/')).length, 1)
})

test('缺登录凭证时给扫码命令，不把内部凭据字段发给用户', async t => {
  const h = harness(t, { raw: false })
  await h.app.updateLog()
  assert.match(h.replies.at(-1), /#扫码登录/)
  assert.ok(!h.replies.at(-1).includes('stoken'))
  assert.equal(h.calls.length, 0)
})
test('旧凭据转换也失败时保留可操作中文，不显示内部字段', async t => {
  const h = harness(t, { raw: 'account_id=101;cookie_token=stale', entry: {}, entries: {} })
  await h.app.updateLog()
  assert.match(h.replies.at(-1), /#扫码登录/)
  assert.ok(!h.replies.at(-1).includes('stoken'))
})
test('角色或区服校验失败时说明该确认账号，而非笼统稍后重试', async t => {
  const h = harness(t, { fetch: async () => response({ retcode: -1002 }) })
  await assert.rejects(h.api.badgeLogin('cookie_token=unit', uid, 'prod_gf_cn'), e => e.code === 'XHH_GACHA_AUTH' && e.message.includes(uid) && e.message.includes('#刷新ck'))
})
