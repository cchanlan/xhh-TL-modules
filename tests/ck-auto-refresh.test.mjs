import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = name => fs.readFileSync(path.join(root, 'modules/shared_account/files/utils', name), 'utf8')
const auth = read('auth.js').replace(/^import .*$/gm, '').replace(/export default \{[\s\S]*?\n\}/g, '').replace(/export (async )?function/g, '$1function')
const hook = read('ckAutoRefresh.js').split('// genshin 可独立存在')[0].replace(/^import .*$/gm, '').replace(/export (async )?function/g, '$1function').replace("await import('node:sqlite')", '({ DatabaseSync: globalThis.DatabaseSync })')
let DatabaseSync
try { ({ DatabaseSync } = await import('node:sqlite')) } catch (_) {}
const uid = '100000001', qq = 'owner', account = '101', secret = 'v2_unit_root_secret'
const oldCk = 'cookie_token=old;account_id=101;ltuid=101;'
const newCk = 'cookie_token=new;account_id=101;ltuid=101;'
const dead = { retcode: -100, message: '登录状态失效，请重新登录' }
const response = (json, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => json })
const good = () => ({ retcode: 0, data: { token: { token_type: 4, token: 'new' }, user_info: { aid: account, mid: 'unit-mid' } } })
function harness(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhh-ck-refresh-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'credentials.json'), calls = [], logs = [], replies = [], writes = [], clears = []
  const entry = opts.entry ?? { stuid: account, stoken: secret, mid: 'unit-mid', uid, ck: oldCk }
  fs.writeFileSync(file, JSON.stringify(opts.entries ?? { [uid]: entry }))
  const ctx = { fs, path, crypto, DatabaseSync, AbortSignal, AbortController, setTimeout, clearTimeout,
    process: { cwd: () => dir }, md5: s => crypto.createHash('md5').update(s).digest('hex'),
    YAML: { parse: JSON.parse, stringify: v => JSON.stringify(v) }, getStokenCandidateFiles: () => [file],
    logger: Object.fromEntries(['mark', 'debug', 'info', 'warn', 'error'].map(k => [k, s => logs.push(String(s))])),
    fetch: async (url, init) => { calls.push({ url, init }); return opts.fetch ? opts.fetch(url, init) : response(good()) },
  }
  vm.createContext(ctx)
  vm.runInContext(auth + '\nconst realRefreshCk = refreshCkDetailed;\n' + hook + '\nglobalThis.api={stokenToCookieDetailed,refreshCkDetailed,findStokenEntry,installCkAutoRefresh,installMiaoCkAutoRefresh,installMysApiCookieTracking,clearDeadStoken,clearDeadDb};', ctx)
  const ckUser = { ck: oldCk, ltuid: account, type: 'mys', device: 'preserved-device',
    setCkData(data) { writes.push({ kind: 'set', data }); this.ck = data.ck },
    async save() { writes.push({ kind: 'save' }) }, async initCache() { writes.push({ kind: 'cache' }) } }
  const info = { e: { user_id: qq, reply: async text => replies.push(text) }, userId: qq, uid, ckInfo: { uid, ck: oldCk, ltuid: account }, ckUser }
  return { api: ctx.api, ctx, dir, file, entry, calls, logs, replies, writes, clears, ckUser, info }
}
function infoHarness(t, opts = {}) {
  const h = harness(t, opts); let originalCalls = 0, deleted = 0, retries = 0
  class Info { async checkCode(res) { originalCalls++; if (res?.retcode === -100) deleted++; return res } }
  h.api.installCkAutoRefresh(Info, { refreshCk: opts.refreshCk ?? (async () => ({ ck: newCk, stokenDead: false })),
    clearStoken: (...args) => h.clears.push(['stoken', ...args]), clearDb: async (...args) => h.clears.push(['db', ...args]) })
  const instance = Object.assign(new Info(), h.info)
  const api = { cookie: oldCk, async getData(type, data) { retries++; return opts.retry ? opts.retry(this.cookie, type, data) : { retcode: 0, data: { ok: true } } } }
  return { ...h, instance, requestApi: api, counts: () => ({ originalCalls, deleted, retries }) }
}
function miaoHarness(t, opts = {}) {
  const h = harness(t, opts); const seen = []; let refreshes = 0, checks = 0
  class Miao { async checkCk() { checks++; seen.push(this.ckUser.ck); if (opts.original) return opts.original(this.ckUser.ck); return this.ckUser.ck === newCk } }
  h.api.installMiaoCkAutoRefresh(Miao, { refreshCk: opts.refreshCk ?? (async () => { refreshes++; return { ck: newCk, stokenDead: false } }), checkCookie: opts.checkCookie ?? (async () => dead) })
  const instance = Object.assign(new Miao(), { e: h.info.e, uid, ckUser: h.ckUser, ckInfo: h.info.ckInfo, mysInfo: h.info, mys: { cookie: oldCk, getData() {} } })
  return { ...h, instance, Miao, seen, counts: () => ({ refreshes, checks }) }
}

test('共享强制刷新绕过旧CK，同账号v2换票成功且签名精确匹配POST正文', async t => {
  const h = harness(t)
  const r = await h.api.refreshCkDetailed(qq, uid, { accountId: account })
  assert.equal(r.ck, newCk); assert.equal(r.stokenDead, false); assert.equal(h.calls.length, 1)
  const { url, init } = h.calls[0]
  assert.ok(url.endsWith('/app/exchange')); assert.ok(!url.includes(secret)); assert.equal(init.method, 'POST'); assert.ok(init.signal instanceof AbortSignal)
  assert.deepEqual(JSON.parse(init.body), { src_token: { token: secret, token_type: 1 }, mid: 'unit-mid', dst_token_type: 4 })
  const [time, random, signature] = init.headers.DS.split(',')
  assert.equal(signature, crypto.createHash('md5').update(`salt=JwYDpKvLj6MrMqqYU6jTKF17KNO2PXoS&t=${time}&r=${random}&b=${init.body}&q=`).digest('hex'))
})
test('普通转换保留缓存兼容，不强迫每次查询都换票', async t => {
  const h = harness(t); assert.equal((await h.api.stokenToCookieDetailed(h.entry)).ck, oldCk); assert.equal(h.calls.length, 0)
})
for (const [label, data] of [
  ['其他账号', { token: { token_type: 4, token: 'new' }, user_info: { aid: '202', mid: 'unit-mid' } }],
  ['其他mid', { token: { token_type: 4, token: 'new' }, user_info: { aid: account, mid: 'wrong' } }],
  ['其他类型', { token: { token_type: 1, token: 'new' }, user_info: { aid: account } }],
  ['缺账号', { token: { token_type: 4, token: 'new' } }],
  ...[undefined, null, '', ' ', 'null', 'undefined', 1].map(token => ['无效token ' + String(token), { token: { token_type: 4, token }, user_info: { aid: account } }]),
]) test('共享换票拒绝' + label + '，不把旧CK当成功', async t => {
  const h = harness(t, { fetch: async () => response({ retcode: 0, data }) }); const r = await h.api.refreshCkDetailed(qq, uid, { accountId: account }); assert.equal(r.ck, ''); assert.equal(r.stokenDead, false)
})
for (const key of ['aid', 'uid', 'account_id']) test('共享换票支持已验证账号字段 ' + key, async t => {
  const h = harness(t, { fetch: async () => { const r = good(); r.data.user_info = { [key]: account }; return response(r) } })
  assert.equal((await h.api.refreshCkDetailed(qq, uid, { accountId: account })).ck, newCk)
})
for (const [label, fetch] of [
  ['网络异常', async () => { throw new Error(secret + ' request-url') }],
  ['超时', async () => { const e = new Error(secret); e.name = 'AbortError'; throw e }],
  ['HTTP错误', async () => response(dead, 503)],
  ['空响应', async () => response(null)],
  ['接口迁移', async () => response({ retcode: -464, message: '请使用最新版' })],
]) test(label + '不判长期凭据死亡，不复用旧票据，不泄露凭据', async t => {
  const h = harness(t, { fetch }); const r = await h.api.refreshCkDetailed(qq, uid, { accountId: account }); assert.equal(r.ck, ''); assert.equal(r.stokenDead, false); assert.ok(!h.logs.join('\n').includes(secret))
})
test('只有明确登录失效响应才报告长期凭据死亡', async t => {
  const h = harness(t, { fetch: async () => response(dead) }); const r = await h.api.refreshCkDetailed(qq, uid, { accountId: account }); assert.equal(r.ck, ''); assert.equal(r.stokenDead, true)
})
test('缺mid的v2旧存档不能用老接口-100误判死亡', async t => {
  const h = harness(t, { entry: { stuid: account, stoken: secret }, fetch: async () => response(dead) }); const r = await h.api.refreshCkDetailed(qq, uid, { accountId: account }); assert.equal(r.ck, ''); assert.equal(r.stokenDead, false)
})
test('v1凭据保留旧换票兼容', async t => {
  const h = harness(t, { entry: { stuid: account, stoken: 'v1-test' }, fetch: async url => response({ retcode: 0, data: url.includes('getLToken') ? { ltoken: 'new-ltoken' } : { cookie_token: 'new' } }) })
  const r = await h.api.refreshCkDetailed(qq, uid, { accountId: account }); assert.ok(r.ck.includes('cookie_token=new')); assert.equal(h.calls.length, 2)
})
for (const [label, target, options] of [['错账号', uid, { accountId: '202' }], ['未知UID不借第一个账号', '100000099', {}]]) test('严格自愈选取：' + label, async t => {
  const h = harness(t); const r = await h.api.refreshCkDetailed(qq, target, options); assert.equal(r.ck, ''); assert.equal(h.calls.length, 0)
})
test('同一账号多游戏可按明确账号命中，旧的宽松查找行为保持兼容', async t => {
  const h = harness(t); assert.equal((await h.api.refreshCkDetailed(qq, '100000099', { accountId: account })).ck, newCk)
  assert.ok(h.api.findStokenEntry(qq, '100000099'))
})
test('无可刷新长期凭据时不把缓存CK冒充新CK', async t => {
  const h = harness(t, { entry: { stuid: account, ck_stoken: 'stuid=101;', ck: oldCk } }); const r = await h.api.refreshCkDetailed(qq, uid, { accountId: account }); assert.equal(r.ck, ''); assert.equal(h.calls.length, 0)
})
for (const [label, res, isTask, shared, overseas] of [
  ['正常请求', { retcode: 0 }, false, false, false], ['验证码', { retcode: 1034 }, false, false, false],
  ['任务', dead, true, false, false], ['公共CK', dead, false, true, false], ['海外服', dead, false, false, true],
]) test('genshin不介入' + label, async t => {
  let refresh = 0; const h = infoHarness(t, { refreshCk: async () => { refresh++; return newCk } }); if (shared) h.instance.ckInfo.uid = ''; if (overseas) h.ckUser.type = 'hoyolab'
  await h.instance.checkCode(res, 'detail', h.requestApi, {}, isTask); assert.equal(refresh, 0); assert.equal(h.counts().originalCalls, 1)
})
test('genshin自动刷新后只重试一次，成功后持久化并同步快照', async t => {
  const h = infoHarness(t); await h.instance.checkCode(dead, 'detail', h.requestApi, { id: 1 }); assert.equal(h.counts().retries, 1); assert.equal(h.counts().deleted, 0); assert.equal(h.ckUser.ck, newCk); assert.equal(h.instance.ckInfo.ck, newCk); assert.equal(h.requestApi.cookie, newCk); assert.deepEqual(h.writes.map(x => x.kind), ['set', 'save', 'cache']); assert.equal(h.writes[0].data.device, 'preserved-device')
})
for (const [label, opts] of [
  ['换票暂时失败', { refreshCk: async () => ({ ck: '', stokenDead: false }) }],
  ['新票据仍失效', { retry: async () => dead }],
  ['重试抛异常', { retry: async () => { throw new Error(secret) } }],
]) test('genshin' + label + '不删除或覆盖绑定', async t => {
  const h = infoHarness(t, opts); await h.instance.checkCode(dead, 'detail', h.requestApi); assert.equal(h.counts().deleted, 0); assert.equal(h.ckUser.ck, oldCk); assert.equal(h.writes.length, 0); assert.equal(h.clears.length, 0); assert.ok(h.replies[0].includes('稍后')); assert.ok(!h.logs.join('\n').includes(secret))
})
test('长期凭据确实失效时只按本用户/账号清理，不调全局delCk', async t => {
  const h = infoHarness(t, { refreshCk: async () => ({ ck: '', stokenDead: true }) }); await h.instance.checkCode(dead, 'detail', h.requestApi); assert.equal(h.counts().deleted, 0); assert.equal(h.clears.length, 2); assert.equal(h.clears[0][1], qq); assert.equal(h.clears[0][3].accountId, account); assert.match(h.replies[0], /#扫码登录/)
})
test('喵喵直接checkCk也可自动刷新，不先覆盖未验证票据', async t => {
  const h = miaoHarness(t, { original: ck => { if (ck === newCk) assert.equal(h.writes.length, 0); return ck === newCk } }); assert.equal(await h.instance.checkCk(), true); assert.deepEqual(h.seen, [oldCk, newCk]); assert.equal(h.ckUser.ck, newCk); assert.equal(h.instance.mysInfo.ckInfo.ck, newCk); assert.equal(h.instance.mys.cookie, newCk); assert.deepEqual(h.writes.map(x => x.kind), ['set', 'save', 'cache']); assert.equal(h.replies.length, 0)
})
test('喵喵正常CK不额外请求和换票', async t => {
  const h = miaoHarness(t, { original: () => true }); assert.equal(await h.instance.checkCk(), true); assert.equal(h.counts().refreshes, 0); assert.equal(h.counts().checks, 1)
})
for (const [label, status] of [['网络失败', null], ['验证码', { retcode: 1034 }], ['非登录错误', { retcode: -100, message: '其他错误' }]]) test('喵喵' + label + '不误刷新/清绑定', async t => {
  const h = miaoHarness(t, { checkCookie: async () => status }); assert.equal(await h.instance.checkCk(), false); assert.equal(h.counts().refreshes, 0); assert.equal(h.writes.length, 0); assert.equal(h.clears.length, 0)
})
test('喵喵初次校验网络异常不当成凭据失效', async t => {
  const h = miaoHarness(t, { original: () => { throw new Error(secret) } }); assert.equal(await h.instance.checkCk(), false); assert.equal(h.counts().refreshes, 0)
})
test('喵喵失败后复查已恢复时不换票', async t => {
  const h = miaoHarness(t, { checkCookie: async () => ({ retcode: 0 }) }); assert.equal(await h.instance.checkCk(), true); assert.equal(h.counts().refreshes, 0)
})
for (const label of ['任务', '海外', '公共', '缺账号']) test('喵喵不介入' + label, async t => {
  const h = miaoHarness(t); if (label === '任务') h.instance.e.isTask = true; if (label === '海外') h.ckUser.type = 'hoyolab'; if (label === '公共') h.instance.ckInfo.uid = ''; if (label === '缺账号') { h.ckUser.ltuid = ''; h.instance.ckInfo.ltuid = ''; h.ckUser.ck = 'cookie_token=old' }
  assert.equal(await h.instance.checkCk(), false); assert.equal(h.counts().refreshes, 0)
})
test('喵喵新票据无效不持久化，缓存作废后下一次会重新刷新', async t => {
  let refreshes = 0; const h = miaoHarness(t, { original: () => false, refreshCk: async () => { refreshes++; return { ck: newCk } } }); assert.equal(await h.instance.checkCk(), false); assert.equal(await h.instance.checkCk(), false); assert.equal(refreshes, 2); assert.equal(h.writes.length, 0); assert.equal(h.ckUser.ck, oldCk)
})
test('喵喵拒绝其他账号票据，不复验或持久化', async t => {
  const h = miaoHarness(t, { refreshCk: async () => ({ ck: 'cookie_token=wrong;account_id=202;' }) }); assert.equal(await h.instance.checkCk(), false); assert.equal(h.counts().checks, 1); assert.equal(h.writes.length, 0)
})
test('同账号并发自愈合并换票，避免重复刷新风控', async t => {
  let refreshes = 0; const h = miaoHarness(t, { refreshCk: async () => { refreshes++; await new Promise(r => setTimeout(r, 15)); return { ck: newCk } } }); const other = Object.assign(new h.Miao(), { e: h.info.e, uid: '100000002', ckInfo: { uid: '100000002', ltuid: account }, ckUser: { ...h.ckUser } }); assert.deepEqual(await Promise.all([h.instance.checkCk(), other.checkCk()]), [true, true]); assert.equal(refreshes, 1)
})
test('缓存票据本身被拒绝时重新换票，不在60秒内反复复用失效CK', async t => {
  let refreshes = 0; const third = 'cookie_token=third;account_id=101;ltuid=101;'; const h = miaoHarness(t, { original: ck => ck === newCk || ck === third, refreshCk: async () => { refreshes++; return { ck: refreshes === 1 ? newCk : third } } }); assert.equal(await h.instance.checkCk(), true)
  // 缓存拒绝路径由genshin错误收口触发，同账号缓存必须失效并重新换票。
  class Info { async checkCode(r) { return r } }
  h.api.installCkAutoRefresh(Info, { refreshCk: async () => { refreshes++; return { ck: third } } })
  const info = Object.assign(new Info(), h.info); const api = { cookie: newCk, getData: async function () { assert.equal(this.cookie, third); return { retcode: 0 } } }
  await info.checkCode(dead, 'detail', api); assert.equal(refreshes, 2)
})
test('两种补丁均幂等，缺宿主方法时不安装', t => {
  const h = harness(t); class A {} ; assert.equal(h.api.installCkAutoRefresh(A), false); assert.equal(h.api.installMiaoCkAutoRefresh(A), false); class B { checkCk() {} }; assert.equal(h.api.installMiaoCkAutoRefresh(B), true); assert.equal(h.api.installMiaoCkAutoRefresh(B), false)
})
test('清理YAML只动本QQ对应账号，保留其他账号和用户偏好', t => {
  const h = harness(t, { entries: { [uid]: { stuid: account, stoken: secret, ck: oldCk, is_sign: true }, another: { stuid: '202', stoken: 'other-root', is_sign: false } } }); h.api.clearDeadStoken(qq, uid, { accountId: account }); const after = JSON.parse(fs.readFileSync(h.file, 'utf8')); assert.equal(after[uid].stoken, undefined); assert.equal(after[uid].ck, undefined); assert.equal(after[uid].is_sign, true); assert.equal(after.another.stoken, 'other-root')
})
test('未知UID清理不能退回第一个账号', t => {
  const h = harness(t); const before = fs.readFileSync(h.file); h.api.clearDeadStoken(qq, '100000099'); assert.deepEqual(fs.readFileSync(h.file), before)
})
test('JiuLi清理只解绑本用户，其他用户共享记录和其他账号不删', { skip: !DatabaseSync }, async t => {
  const h = harness(t); fs.mkdirSync(path.join(h.dir, 'data/db'), { recursive: true }); const db = new DatabaseSync(path.join(h.dir, 'data/db/data.db')); db.exec('CREATE TABLE Users(id TEXT PRIMARY KEY,ltuids TEXT);CREATE TABLE MysUsers(ltuid TEXT PRIMARY KEY,uids TEXT);'); db.prepare('INSERT INTO Users VALUES(?,?)').run(qq, '101,202'); db.prepare('INSERT INTO Users VALUES(?,?)').run('other-user', '101,303'); for (const id of ['101', '202', '303']) db.prepare('INSERT INTO MysUsers VALUES(?,?)').run(id, JSON.stringify({ gs: [uid] })); db.close(); await h.api.clearDeadDb(qq, uid, { accountId: account }); const result = new DatabaseSync(path.join(h.dir, 'data/db/data.db')); assert.equal(result.prepare('SELECT ltuids FROM Users WHERE id=?').get(qq).ltuids, '202'); assert.equal(result.prepare('SELECT ltuids FROM Users WHERE id=?').get('other-user').ltuids, '101,303'); assert.equal(result.prepare('SELECT COUNT(*) AS n FROM MysUsers').get().n, 3); result.close()
})
test('JiuLi不删其他用户拥有的UID，不匹配账号时不清理', { skip: !DatabaseSync }, async t => {
  const h = harness(t); fs.mkdirSync(path.join(h.dir, 'data/db'), { recursive: true }); const db = new DatabaseSync(path.join(h.dir, 'data/db/data.db')); db.exec('CREATE TABLE Users(id TEXT PRIMARY KEY,ltuids TEXT);CREATE TABLE MysUsers(ltuid TEXT PRIMARY KEY,uids TEXT);'); db.prepare('INSERT INTO Users VALUES(?,?)').run('other-user', account); db.prepare('INSERT INTO MysUsers VALUES(?,?)').run(account, JSON.stringify({ gs: [uid] })); db.close(); await h.api.clearDeadDb(qq, uid, { accountId: account }); const result = new DatabaseSync(path.join(h.dir, 'data/db/data.db')); assert.equal(result.prepare('SELECT COUNT(*) AS n FROM MysUsers').get().n, 1); assert.equal(result.prepare('SELECT ltuids FROM Users').get().ltuids, account); result.close()
})

for (const token of ['undefined', 'null', ' ', 123]) test('v1强制刷新拒绝无效token ' + String(token), async t => {
  const h = harness(t, { entry: { stuid: account, stoken: 'v1-test', cookie_token: 'old', ltoken: 'old-ltoken' }, fetch: async url => response({ retcode: 0, data: url.includes('getLToken') ? { ltoken: 'new-ltoken' } : { cookie_token: token } }) })
  const result = await h.api.refreshCkDetailed(qq, uid, { accountId: account }); assert.equal(result.ck, ''); assert.equal(result.stokenDead, false)
})
test('旧接口一个判失效但另一个成功时不误清长期凭据', async t => {
  const h = harness(t, { entry: { stuid: account, stoken: 'v1-test' }, fetch: async url => response(url.includes('getLToken') ? { retcode: 0, data: { ltoken: 'alive' } } : dead) })
  const result = await h.api.refreshCkDetailed(qq, uid, { accountId: account }); assert.equal(result.ck, ''); assert.equal(result.stokenDead, false)
})
test('完整CK字符串里保存的stoken和mid也可按同账号刷新', async t => {
  const h = harness(t, { entry: { ck: `account_id=101;stoken=${secret};mid=unit-mid;cookie_token=old;` } })
  assert.equal((await h.api.refreshCkDetailed(qq, uid, { accountId: account })).ck, newCk)
})
test('喵喵长期凭据失效不会顺手删除其他插件的绑定', async t => {
  const h = miaoHarness(t, { refreshCk: async () => ({ ck: '', stokenDead: true }) }); assert.equal(await h.instance.checkCk(), false); assert.equal(h.clears.length, 0); assert.equal(h.writes.length, 0); assert.equal(h.ckUser.ck, oldCk)
})
test('genshin重试遇验证码交回原处理，不把它当登录失效或持久化未验证票据', async t => {
  const h = infoHarness(t, { retry: async () => ({ retcode: 1034, message: '验证' }) }); const result = await h.instance.checkCode(dead, 'detail', h.requestApi); assert.equal(result.retcode, 1034); assert.equal(h.counts().deleted, 0); assert.equal(h.writes.length, 0); assert.equal(h.clears.length, 0)
})
test('成功刷新但写库暂时异常仍可完成当前校验，异常日志不带凭据', async t => {
  const h = miaoHarness(t); h.ckUser.save = async () => { throw new Error(secret) }; assert.equal(await h.instance.checkCk(), true); assert.equal(h.instance.ckInfo.ck, newCk); assert.ok(!h.logs.join('\n').includes(secret))
})

test('缺少明确账号归属时即使长期凭据死亡也不按裸UID清理绑定', async t => {
  const h = infoHarness(t, { refreshCk: async () => ({ ck: '', stokenDead: true }) }); h.ckUser.ltuid = ''; h.instance.ckInfo.ltuid = ''; h.ckUser.ck = 'cookie_token=old'; await h.instance.checkCode(dead, 'detail', h.requestApi); assert.equal(h.clears.length, 0); assert.match(h.replies[0], /#扫码登录/)
})
test('JiuLi可清理本用户独占的已确认失效账号，仍保留其他账号', { skip: !DatabaseSync }, async t => {
  const h = harness(t); fs.mkdirSync(path.join(h.dir, 'data/db'), { recursive: true }); const db = new DatabaseSync(path.join(h.dir, 'data/db/data.db')); db.exec('CREATE TABLE Users(id TEXT PRIMARY KEY,ltuids TEXT);CREATE TABLE MysUsers(ltuid TEXT PRIMARY KEY,uids TEXT);'); db.prepare('INSERT INTO Users VALUES(?,?)').run(qq, account); db.prepare('INSERT INTO Users VALUES(?,?)').run('other-user', '202'); for (const id of [account, '202']) db.prepare('INSERT INTO MysUsers VALUES(?,?)').run(id, JSON.stringify({ gs: [uid] })); db.close(); await h.api.clearDeadDb(qq, uid, { accountId: account }); const result = new DatabaseSync(path.join(h.dir, 'data/db/data.db')); assert.equal(result.prepare('SELECT ltuids FROM Users WHERE id=?').get(qq).ltuids, ''); assert.equal(result.prepare('SELECT ltuids FROM Users WHERE id=?').get('other-user').ltuids, '202'); assert.equal(result.prepare('SELECT COUNT(*) AS n FROM MysUsers').get().n, 1); result.close()
})

test('apiSync多个旧响应在第一次刷新后复用新票据，不把新的api.cookie误当已被拒绝', async t => {
  let refreshes = 0
  const h = infoHarness(t, { refreshCk: async () => { refreshes++; return { ck: newCk } } })
  class Api { constructor() { this.cookie = oldCk } async getData() { return this.cookie === oldCk ? { ...dead } : { retcode: 0 } } }
  assert.equal(h.api.installMysApiCookieTracking(Api), true)
  const api = new Api(); const oldResponses = await Promise.all([api.getData(), api.getData(), api.getData()])
  for (const result of oldResponses) await h.instance.checkCode(result, 'detail', api)
  assert.equal(refreshes, 1); assert.equal(h.counts().deleted, 0); assert.equal(api.cookie, newCk)
})
test('响应凭据跟踪只做内部记录，保留返回值和参数且幂等', async t => {
  const h = harness(t)
  class Api { async getData(value) { return value } }
  assert.equal(h.api.installMysApiCookieTracking(Api), true); assert.equal(h.api.installMysApiCookieTracking(Api), false)
  const api = new Api(); const value = { retcode: 0 }; assert.equal(await api.getData(value), value); assert.deepEqual(Object.keys(value), ['retcode']); assert.equal(await api.getData(null), null); assert.equal(await api.getData(0), 0)
})
