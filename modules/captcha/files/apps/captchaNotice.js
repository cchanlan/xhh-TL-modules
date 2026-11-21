import { createHash } from 'node:crypto'
import { taskIsCurrent } from '../utils/taskLifecycle.js'
import plugin from '../../../lib/plugins/plugin.js'
import { config } from '../utils/pluginConfig.js'
import { quoteEnabled } from '../utils/replyHelper.js'
import { captchaTip } from '../utils/captchaTip.js'
import { isModuleEnabled } from '../utils/modules.js'

// 从 mys.req.err 恢复当前请求，让原指令继续执行；不向消息总线重复投递指令。
const CAPTCHA_RC = [1034, 5003, 10035, 10041]
const RETRY_GAPS = [0, 6000, 15000]
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const verifying = new Map()
const notices = new WeakMap()
const suppressions = new WeakMap()
const log = {
  mark: (...args) => globalThis.logger?.mark?.(...args),
  error: (...args) => globalThis.logger?.error?.(...args),
}

function header(headers, name) {
  const key = Object.keys(headers || {}).find(key => key.toLowerCase() === name)
  return key ? headers[key] : ''
}

// 只合并正在验证的同一凭据/设备/游戏；不共享查询结果，不留下阻止用户重试的冷却锁。
async function verify(key, options) {
  let pending = verifying.get(key)
  if (!pending) {
    pending = (async () => {
      const { solveByLocalService } = await import('../utils/mysVerify.js')
      const challengeOut = {}
      const ok = await solveByLocalService({ ...options, challengeOut })
      return { ok, challenge: challengeOut.challenge || '' }
    })()
    verifying.set(key, pending)
  }
  try {
    return await pending
  } finally {
    if (verifying.get(key) === pending) verifying.delete(key)
  }
}

export class captchaNotice extends plugin {
  constructor() {
    super({
      name: '[小火花]米游社撞码处理',
      dsc: '撞米游社验证码时自动过码并重试',
      namespace: 'xhh-TL',
      handler: [{ key: 'mys.req.err', fn: 'onMysReqErr' }],
    })
  }

  async onMysReqErr(e, args, reject) {
    if (!isModuleEnabled('captcha') || !CAPTCHA_RC.includes(Number(args?.res?.retcode))) return reject()
    const api = args?.mysApi
    const uid = String(args?.mysInfo?.uid || api?.uid || args?.data?.uid || '')
    const headers = args?.data?.headers || {}
    const game = api?.game || args?.mysInfo?.e?.game || (e?.isSr ? 'sr' : 'gs')
    const cookie = header(headers, 'cookie') || api?.cookie || args?.mysInfo?.ckInfo?.ck || ''
    const requestDevice = header(headers, 'x-rpc-device_id') || api?.device || ''
    const device = typeof requestDevice === 'object' ? requestDevice?.id || '' : requestDevice
    const deviceFp = header(headers, 'x-rpc-device_fp') || api?._device_fp?.data?.device_fp || (typeof requestDevice === 'object' ? requestDevice?.fp : '') || ''
    const server = String(api?.server || '')
    const clientType = header(headers, 'x-rpc-client_type') || (server ? (/cn_|_cn/.test(server) ? '5' : '2') : '')
    const autoVerifyAddr = config().auto_verify_addr || ''
    const key = createHash('sha256').update(JSON.stringify([cookie, uid, game, device, deviceFp, clientType, autoVerifyAddr])).digest('hex')
    if (!autoVerifyAddr || !cookie || typeof api?.getData !== 'function') {
      await this.notice(e, uid, key, captchaTip())
      return args.res
    }
    try {
      log.mark(`[xhh-TL][撞码] uid=${uid} 自动过码中…`)
      const { ok, challenge } = await verify(key, { cookie, autoVerifyAddr, device, deviceFp, clientType, game })
      if (!taskIsCurrent()) return args.res
      if (!ok) {
        await this.notice(e, uid, key, captchaTip())
        return args.res
      }
      // 仅复制本次参数，不能把另一查询的 challenge 写入共享 MysApi 或原始 data。
      const data = { ...(args.data || {}), headers: { ...headers } }
      if (challenge) {
        for (const name of Object.keys(data.headers)) {
          if (name.toLowerCase() === 'x-rpc-challenge') delete data.headers[name]
        }
        data.headers['x-rpc-challenge'] = challenge
      }
      let retry = args.res
      for (let i = 0; i < RETRY_GAPS.length; i++) {
        if (RETRY_GAPS[i]) await sleep(RETRY_GAPS[i])
        if (!taskIsCurrent()) return args.res
        retry = await api.getData(args.type, data)
        if (retry && Number(retry.retcode) === 0) {
          log.mark(`[xhh-TL][撞码] uid=${uid} 第 ${i + 1} 次重试成功`)
          return retry
        }
        log.mark(`[xhh-TL][撞码] uid=${uid} 第 ${i + 1} 次重试失败: retcode=${retry?.retcode}`)
        // 登录失效、隐私设置等业务错误不是继续过码能解决的，不重复请求。
        if (retry && !CAPTCHA_RC.includes(Number(retry.retcode))) break
      }
      await this.notice(e, uid, key, retry && CAPTCHA_RC.includes(Number(retry.retcode))
        ? '已尝试自动验证并重试，米游社仍要求验证码，请稍后再试'
        : '自动验证后查询仍未成功，请稍后再试')
      return retry || args.res
    } catch {
      log.error(`[xhh-TL][撞码] uid=${uid} 自动验证或重试异常`)
      await this.notice(e, uid, key, captchaTip())
      return args.res
    }
  }

  async notice(e, uid, key, text) {
    if (!e || typeof e.reply !== 'function') return
    // checkCode 会在 handler 返回后补旧提示；即使并发失败也只保留本事件的一条说明。
    suppressLegacyNotice(e, uid)
    if (e.noTips === true) return
    let sent = notices.get(e)
    if (!sent) notices.set(e, sent = new Set())
    if (sent.has(key)) return
    sent.add(key)
    try {
      await e.reply(`${uid ? `UID:${uid} ` : ''}${text}`, quoteEnabled())
    } catch {
      log.error('[xhh-TL][撞码提醒] 发送失败')
    } finally {
      suppressLegacyNotice(e, uid)
    }
  }
}

function suppressLegacyNotice(e, uid) {
  let state = suppressions.get(e)
  if (!state || e.reply !== state.wrapped) {
    const original = e.reply
    state = { original, uids: new Set(), timer: null }
    state.wrapped = function (msg, ...rest) {
      const parts = Array.isArray(msg) ? msg : [msg]
      const hit = parts.some(part => typeof part === 'string' && /米游社查询遇到验证码/.test(part)
        && [...state.uids].some(id => part.includes(`UID:${id}，`)))
      return hit ? Promise.resolve() : original.call(this, msg, ...rest)
    }
    suppressions.set(e, state)
    e.reply = state.wrapped
  }
  state.uids.add(uid)
  clearTimeout(state.timer)
  state.timer = setTimeout(() => {
    if (e.reply === state.wrapped) e.reply = state.original
    if (suppressions.get(e) === state) suppressions.delete(e)
  }, 0)
}
