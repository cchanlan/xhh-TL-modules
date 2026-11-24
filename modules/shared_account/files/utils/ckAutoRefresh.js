/**
 * CK 失效自愈：只在自有插件安装运行时补丁，不修改 genshin / miao 源码。
 * genshin.checkCode 与 miao.checkCk 是两条独立入口；均换取同账号的新 CK、
 * 重试一次且校验通过后再持久化。传输失败或未确认的坏票据不清理绑定。
 */
import fs from 'fs'
import path from 'path'
import YAML from 'yaml'
import fetch from 'node-fetch'
import { refreshCkDetailed as realRefreshCk, cookiePart } from './auth.js'
import { getStokenCandidateFiles } from './pluginConfig.js'

const CK_DEAD_CODES = [-1, -100, 1001, 10001, 10103]
const PATCH_FLAG = '__xhhCkAutoRefresh'
const MIAO_PATCH_FLAG = '__xhhMiaoCkAutoRefresh'
const CK_CACHE_TTL = 60 * 1000
const ckCache = new Map()
const refreshing = new Map()
// apiSync 的并行结果可能仍来自旧 CK；记录响应实际使用的凭据，不能用后来已换新的 api.cookie 误判缓存又失效。
const responseCookies = new WeakMap()
const API_PATCH_FLAG = '__xhhCkRequestCookie'

export function installMysApiCookieTracking(MysApi) {
  if (!MysApi?.prototype || MysApi.prototype[API_PATCH_FLAG] || typeof MysApi.prototype.getData !== 'function') return false
  const original = MysApi.prototype.getData
  MysApi.prototype.getData = async function (...args) {
    const cookie = this.cookie || ''
    const result = await original.apply(this, args)
    if (result && typeof result === 'object') responseCookies.set(result, cookie)
    return result
  }
  MysApi.prototype[API_PATCH_FLAG] = true
  return true
}

function isCkDead(res) {
  return !!res && CK_DEAD_CODES.includes(Number(res.retcode)) && /(登录|login)/i.test(res.message || '')
}
function refreshKey(qq, uid, accountId = '') {
  return `${qq}:${accountId ? `account:${accountId}` : `uid:${uid}`}`
}
function invalidateRefresh(qq, uid, accountId, ck) {
  const key = refreshKey(qq, uid, accountId)
  if (!ck || ckCache.get(key)?.ck === ck) ckCache.delete(key)
}
async function cachedRefreshCk(refreshFn, qq, uid, { accountId = '', rejectedCk = '' } = {}) {
  const key = refreshKey(qq, uid, accountId)
  const hit = ckCache.get(key)
  if (hit && Date.now() - hit.at < CK_CACHE_TTL && hit.ck !== rejectedCk) return { ck: hit.ck, stokenDead: false }
  ckCache.delete(key)
  if (refreshing.has(key)) return refreshing.get(key)
  const pending = (async () => {
    const result = await refreshFn(qq, uid, { accountId })
    const out = result && typeof result === 'object' ? result : { ck: result || '', stokenDead: false }
    const actualAccount = cookiePart(out.ck || '', 'account_id') || cookiePart(out.ck || '', 'ltuid')
    if (out.ck && accountId && actualAccount !== String(accountId)) return { ck: '', stokenDead: false }
    if (out.ck && out.ck !== rejectedCk) {
      ckCache.set(key, { ck: out.ck, at: Date.now() })
      return out
    }
    return { ...out, ck: '' }
  })()
  refreshing.set(key, pending)
  try { return await pending } finally { if (refreshing.get(key) === pending) refreshing.delete(key) }
}
function accountOf(context) {
  const ck = context.ckUser?.ck || context.ckInfo?.ck || ''
  return String(context.ckUser?.ltuid || context.ckInfo?.ltuid || cookiePart(ck, 'account_id') || cookiePart(ck, 'ltuid') || '')
}
async function writeBackCk(ckUser, newCk) {
  if (!ckUser) return false
  try {
    if (typeof ckUser.setCkData === 'function') ckUser.setCkData({ ck: newCk, device: ckUser.device })
    else ckUser.ck = newCk
    if (typeof ckUser.save === 'function') await ckUser.save()
    if (typeof ckUser.initCache === 'function') await ckUser.initCache()
    return true
  } catch (err) {
    globalThis.logger?.debug?.(`[xhh-TL][ckAutoRefresh] 写回凭据失败：${err?.name || 'Error'}`)
    return false
  }
}
function syncCookie(context, newCk) {
  if (context.ckInfo) context.ckInfo.ck = newCk
  if (context.mysInfo?.ckInfo) context.mysInfo.ckInfo.ck = newCk
  for (const api of [context.mys, context.mysApi]) {
    if (api && typeof api.getData === 'function') api.cookie = newCk
  }
}
async function refreshUnavailable(context) {
  await context.e?.reply?.(`UID:${context.ckInfo?.uid || context.uid}，米游社登录暂时无法自动刷新，请稍后重试；持续失败请发送 #扫码登录`)
  return false
}

/** 确认根凭据失效后，只清理本 QQ 对应账号的凭据，不随便选第一个账号。 */
export function clearDeadStoken(qq, uid, { accountId = '' } = {}) {
  for (const file of getStokenCandidateFiles(String(qq))) {
    try {
      if (!fs.existsSync(file)) continue
      const data = YAML.parse(fs.readFileSync(file, 'utf8')) || {}
      let changed = false
      for (const [key, entry] of Object.entries(data)) {
        if (!entry || typeof entry !== 'object') continue
        const raw = entry.ck_stoken || entry.ck || entry.cookie || ''
        const account = String(entry.stuid || cookiePart(raw, 'stuid') || cookiePart(raw, 'account_id') || cookiePart(raw, 'ltuid') || '')
        if (accountId ? account !== String(accountId) : key !== String(uid) && String(entry.uid || '') !== String(uid)) continue
        for (const field of ['stoken', 'ck_stoken', 'cookie_token', 'ltoken', 'ck', 'cookie']) {
          if (Object.hasOwn(entry, field)) { delete entry[field]; changed = true }
        }
      }
      if (changed) fs.writeFileSync(file, YAML.stringify(data))
    } catch (err) {
      globalThis.logger?.debug?.(`[xhh-TL][ckAutoRefresh] 清理凭据失败：${err?.name || 'Error'}`)
    }
  }
}

/** JiuLi 存储适配：只解绑请求用户拥有的失效账号，共享给其他用户的记录不删。 */
export async function clearDeadDb(qq, uid, { accountId = '' } = {}) {
  const file = path.join(process.cwd(), 'data/db/data.db')
  if (!fs.existsSync(file)) return
  let db
  try {
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(file, { timeout: 5000 })
    db.exec('BEGIN IMMEDIATE')
    const user = db.prepare('SELECT ltuids FROM Users WHERE id = ?').get(String(qq))
    const owned = String(user?.ltuids || '').split(',').filter(Boolean)
    const dead = new Set()
    for (const id of owned) {
      if (accountId && id !== String(accountId)) continue
      const row = db.prepare('SELECT uids FROM MysUsers WHERE ltuid = ?').get(id)
      let uids = {}
      try { uids = JSON.parse(row?.uids || '{}') || {} } catch (_) {}
      if (Object.values(uids).some(list => Array.isArray(list) && list.map(String).includes(String(uid)))) dead.add(id)
    }
    if (dead.size) {
      db.prepare('UPDATE Users SET ltuids = ? WHERE id = ?').run(owned.filter(id => !dead.has(id)).join(','), String(qq))
      const users = db.prepare('SELECT ltuids FROM Users').all()
      for (const id of dead) {
        if (!users.some(row => String(row.ltuids || '').split(',').includes(id))) db.prepare('DELETE FROM MysUsers WHERE ltuid = ?').run(id)
      }
    }
    db.exec('COMMIT')
  } catch (err) {
    try { db?.exec('ROLLBACK') } catch (_) {}
    globalThis.logger?.debug?.(`[xhh-TL][ckAutoRefresh] 清理数据库凭据失败：${err?.name || 'Error'}`)
  } finally { db?.close() }
}

/** genshin 的请求错误收口。一次请求至多换票/重试一次，不递归进入包装层。 */
export function installCkAutoRefresh(MysInfo, { refreshCk, clearStoken = clearDeadStoken, clearDb = clearDeadDb } = {}) {
  if (!MysInfo?.prototype || MysInfo.prototype[PATCH_FLAG] || typeof MysInfo.prototype.checkCode !== 'function') return false
  const doRefresh = refreshCk || realRefreshCk
  const original = MysInfo.prototype.checkCode
  MysInfo.prototype.checkCode = async function (res, type, mysApi = {}, data = {}, isTask = false) {
    if (isTask || !isCkDead(res) || !this.ckInfo?.uid || typeof mysApi?.getData !== 'function' || this.ckUser?.type === 'hoyolab') {
      return original.call(this, res, type, mysApi, data, isTask)
    }
    const qq = this.userId, uid = this.ckInfo.uid, accountId = accountOf(this)
    try {
      const { ck: newCk, stokenDead } = await cachedRefreshCk(doRefresh, qq, uid, { accountId, rejectedCk: responseCookies.get(res) || mysApi.cookie || this.ckUser?.ck || '' })
      if (newCk) {
        const retryApi = Object.create(mysApi)
        retryApi.cookie = newCk
        const retryRes = await retryApi.getData(type, data)
        if (isCkDead(retryRes)) {
          invalidateRefresh(qq, uid, accountId, newCk)
          return refreshUnavailable(this)
        }
        if (Number(retryRes?.retcode) === 0) {
          mysApi.cookie = newCk
          await writeBackCk(this.ckUser, newCk)
          syncCookie(this, newCk)
          globalThis.logger?.mark?.(`[xhh-TL][ckAutoRefresh] 自动刷新并重试成功 [uid:${uid}][qq:${qq}]`)
        } else invalidateRefresh(qq, uid, accountId, newCk)
        return original.call(this, retryRes, type, retryApi, data, isTask)
      }
      if (stokenDead) {
        // 不调可能全局删除共享账号的 delCk；按当前用户/账号精确清理。
        if (accountId) {
          await clearStoken(qq, uid, { accountId })
          await clearDb(qq, uid, { accountId })
        }
        await this.e?.reply?.(`UID:${uid}，授权已过期，请发送 #扫码登录 重新绑定`)
        return false
      }
      return refreshUnavailable(this)
    } catch (err) {
      invalidateRefresh(qq, uid, accountId)
      globalThis.logger?.debug?.(`[xhh-TL][ckAutoRefresh] 自动刷新异常：${err?.name || 'Error'}`)
      return refreshUnavailable(this)
    }
  }
  MysInfo.prototype[PATCH_FLAG] = true
  return true
}

async function inspectCookie(cookie) {
  try {
    const res = await fetch('https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie', {
      headers: { Cookie: cookie }, signal: AbortSignal.timeout(10000),
    })
    return res.ok ? await res.json().catch(() => null) : null
  } catch (_) { return null }
}

/** 喵喵的面板/深渊/剧诗等入口直接 checkCk，不经过 genshin.checkCode。 */
export function installMiaoCkAutoRefresh(MysApi, { refreshCk, checkCookie = inspectCookie } = {}) {
  if (!MysApi?.prototype || MysApi.prototype[MIAO_PATCH_FLAG] || typeof MysApi.prototype.checkCk !== 'function') return false
  const original = MysApi.prototype.checkCk, doRefresh = refreshCk || realRefreshCk
  MysApi.prototype.checkCk = async function (...args) {
    let result
    try { result = await original.apply(this, args) } catch (_) { return false }
    if (result) return result
    if (!this.e?.user_id || this.e.isTask || this.e.is_task || !this.ckInfo?.uid || !this.ckUser?.ck || this.ckUser.type === 'hoyolab') return result
    const qq = String(this.e.user_id), uid = String(this.ckInfo.uid), accountId = accountOf(this)
    if (!accountId) return result
    const rejectedCk = this.ckUser.ck
    try {
      // 原方法只回布尔值，先确认失败确实是登录失效，不能因网络故障刷新/删除绑定。
      const status = await checkCookie(rejectedCk)
      if (Number(status?.retcode) === 0) return true
      if (!isCkDead(status)) return result
      const { ck: newCk } = await cachedRefreshCk(doRefresh, qq, uid, { accountId, rejectedCk })
      if (!newCk) return result
      // 在独立接收者上复验，坏票据不能先覆盖共享 CK 对象或数据库。
      const probe = Object.create(this)
      probe.ckUser = Object.assign(Object.create(Object.getPrototypeOf(this.ckUser)), this.ckUser, { ck: newCk })
      probe.ckInfo = { ...this.ckInfo, ck: newCk }
      if (!await original.apply(probe, args)) {
        invalidateRefresh(qq, uid, accountId, newCk)
        return false
      }
      await writeBackCk(this.ckUser, newCk)
      syncCookie(this, newCk)
      globalThis.logger?.mark?.(`[xhh-TL][ckAutoRefresh] 喵喵自动刷新并校验成功 [uid:${uid}][qq:${qq}]`)
      return true
    } catch (err) {
      invalidateRefresh(qq, uid, accountId)
      globalThis.logger?.debug?.(`[xhh-TL][ckAutoRefresh] 喵喵自动刷新异常：${err?.name || 'Error'}`)
      return false
    }
  }
  MysApi.prototype[MIAO_PATCH_FLAG] = true
  return true
}

// genshin 可独立存在；喵喵异步挂接，避免它的模型索引循环依赖阻塞插件启动。
try {
  const mod = await import('../../genshin/model/mys/mysInfo.js')
  const api = await import('../../genshin/model/mys/mysApi.js')
  installMysApiCookieTracking(api?.default)
  if (installCkAutoRefresh(mod?.default)) globalThis.logger?.info?.('[xhh-TL] ck 失效自愈补丁已装载')
} catch (err) {
  globalThis.logger?.debug?.(`[xhh-TL][ckAutoRefresh] genshin 未就绪，跳过：${err?.name || 'Error'}`)
}
void (async () => {
  try {
    const mod = await import('../../miao-plugin/models/MysApi.js')
    if (installMiaoCkAutoRefresh(mod?.default)) globalThis.logger?.info?.('[xhh-TL] 喵喵 ck 失效自愈补丁已装载')
  } catch (err) {
    globalThis.logger?.debug?.(`[xhh-TL][ckAutoRefresh] 喵喵未就绪，跳过：${err?.name || 'Error'}`)
  }
})()
export default { installCkAutoRefresh, installMiaoCkAutoRefresh, installMysApiCookieTracking }
