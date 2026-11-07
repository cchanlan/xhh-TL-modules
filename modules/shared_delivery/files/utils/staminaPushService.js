import { scheduledEvent } from './delivery.js'
/**
 * 体力阈值推送
 *
 * 每个用户在群里各自设定「体力阈值」，体力恢复到该值(含)以上时，
 * 机器人在该群 @用户 并发一张体力立绘卡片（复用 TL 的查询与出图）。
 *
 * - 原神 / 星铁 / 绝区零 / 鸣潮分开指令、分开阈值、分开推送
 *   · 原神看「原粹树脂」(current_resin)
 *   · 星铁看「开拓力」(current_stamina)
 *   · 绝区零看「电量」(energy.progress.current)
 *   · 鸣潮看「结晶波片」(current_stamina)，数据走库街区（凭证借 gsuid_core 鸣潮插件），
 *     需锅巴先打开「启用鸣潮体力」
 * - 仅在群里 @ 提醒
 * - 达到阈值只 @ 一次；体力回落到阈值以下后自动重新武装，下次满足再提醒
 * - 两种监控范围：
 *   · 主号推送（默认）：只盯当前主 UID
 *   · 全推送：盯该游戏下绑定的全部 UID，每个号各自独立提醒（「全id推送」为兼容别名）
 *
 * 指令（群聊内，谁发就绑定谁；「开启/打开」前缀可省，关闭词前置后置都认）：
 *   #原神体力推送 130      —— 主 UID 原粹树脂达到 130 时提醒
 *   #星铁体力推送 200      —— 主 UID 开拓力达到 200 时提醒
 *   #绝区零体力推送 220    —— 主 UID 电量达到 220 时提醒
 *   #开启鸣潮体力推送 200  —— 主 UID 结晶波片达到 200 时提醒
 *   #原神体力全推送 130    —— 全部原神 UID 各自达到 130 时分别提醒
 *   #星铁体力全推送 200
 *   #绝区零体力全推送 220
 *   #鸣潮体力全推送 200
 *   #原神体力推送关闭 / #原神体力全推送关闭
 *   #星铁体力推送关闭 / #星铁体力全推送关闭
 *   #绝区零体力推送关闭 / #绝区零体力全推送关闭
 *   #关闭鸣潮体力推送 / #鸣潮体力全推送关闭
 *   #体力推送列表          —— 查看自己的订阅
 */

import fs from 'fs'
import path from 'path'
import plugin from '../../../lib/plugins/plugin.js'
import Runtime from '../../../lib/plugins/runtime.js'
import { StaminaService as TL } from './staminaService.js'
import { createUser } from './userBind.js'
import { config, getRenderScaleStyle, pluginDir } from './pluginConfig.js'
import { listWavesAccounts, fetchWavesStamina, isWavesTlEnabled, getWavesEnvError } from './moduleOptional.js'
import { quoteEnabled } from './replyHelper.js'
import { registerReminderHooks, scheduleTimers, refreshUidTimers, timerStats, timerSnapshot, evaluateSnapshot } from './moduleOptional.js'
import { isModuleEnabled } from './modules.js'

export const DATA_DIR = path.join(pluginDir, 'data')
export const CONFIG_FILE = path.join(DATA_DIR, 'resin_push.json')

export const DEFAULT_CRON = '*/10 * * * *' // 每 10 分钟检查一次

// 各游戏元信息：名称、单位、阈值合法上限、当前值/上限取值函数
// zzz 电量嵌套在 energy.progress 下，故统一用取值函数抹平差异
// name: 指令里可用的游戏别名（正则片段）
export const GAME_META = {
  gs: {
    label: '原神', name: '原神', unit: '原粹树脂', cap: 200, example: 130,
    getCur: (item) => Number(item?.current_resin) || 0,
    getMax: (item) => Number(item?.max_resin) || 0,
    hasField: (item) => item?.current_resin !== undefined && item?.current_resin !== null,
  },
  sr: {
    label: '星铁', name: '星铁', unit: '开拓力', cap: 300, example: 200,
    getCur: (item) => Number(item?.current_stamina) || 0,
    getMax: (item) => Number(item?.max_stamina) || 0,
    hasField: (item) => item?.current_stamina !== undefined && item?.current_stamina !== null,
  },
  zzz: {
    label: '绝区零', name: '绝区零|zzz', unit: '电量', cap: 240, example: 220,
    getCur: (item) => Number(item?.energy?.progress?.current) || 0,
    getMax: (item) => Number(item?.energy?.progress?.max) || 0,
    hasField: (item) => item?.energy?.progress?.current !== undefined && item?.energy?.progress?.current !== null,
  },
  // 鸣潮不走米游社：账号/凭证读 gsuid_core 鸣潮插件的库，体力直接问库街区
  ww: {
    label: '鸣潮', name: '鸣潮|mc', unit: '结晶波片', cap: 240, example: 200,
    getCur: (item) => Number(item?.current_stamina) || 0,
    getMax: (item) => Number(item?.max_stamina) || 0,
    hasField: (item) => item?.current_stamina !== undefined && item?.current_stamina !== null,
  },
}

export const GAMES = ['gs', 'sr', 'zzz', 'ww']

// 指令正则：「开启/打开」前缀可省，关闭词前置（#关闭鸣潮体力推送）后置（#鸣潮体力推送关闭）都认
export const setReg = (game, all) =>
  `^\\s*#?(?:开启|打开)?(?:${GAME_META[game].name})体力${all ? '全(?:id)?' : ''}推送\\s*(\\d{1,3})\\s*$`
export const offReg = (game, all) => {
  const body = `(?:${GAME_META[game].name})体力${all ? '全(?:id)?' : ''}推送`
  return `^\\s*#?(?:(?:关闭|关掉|取消|停止)${body}|${body}\\s*(?:关闭|关|取消|停止))\\s*$`
}

// 「全id推送」为每个游戏独立的一套订阅：监控该 QQ 名下所有绑定 UID，
// 每个 UID 各自记录 armed 状态（达到阈值只提醒一次，回落后自动重新武装）。
// 存储键：gs_all / sr_all / zzz_all
export const ALL_KEY = (game) => `${game}_all`

// ============ 配置读写 ============
export function ensureDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  } catch (_) {}
}

/**
 * 结构：
 * {
 *   // 主 UID 推送（只监控该 QQ 该游戏的主 UID）
 *   gs:  { "<qq>": { threshold: 130, group: "123", armed: true } },
 *   sr:  { "<qq>": { threshold: 200, group: "123", armed: true } },
 *   zzz: { "<qq>": { threshold: 220, group: "123", armed: true } },
 *   // 全 id 推送（监控该 QQ 该游戏名下所有绑定 UID，各 UID 独立 armed）
 *   gs_all:  { "<qq>": { threshold: 130, group: "123", uids: { "<uid>": { armed: true } } } },
 *   sr_all:  { ... },
 *   zzz_all: { ... }
 * }
 */
export function loadSubs() {
  const empty = () => {
    const o = {}
    for (const g of GAMES) {
      o[g] = {}
      o[ALL_KEY(g)] = {}
    }
    return o
  }
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}
      const subs = {}
      for (const g of GAMES) {
        subs[g] = data[g] || {}
        subs[ALL_KEY(g)] = data[ALL_KEY(g)] || {}
      }
      return subs
    }
  } catch (err) {
    logger?.error?.(`[xhh-TL][体力推送] 读取配置失败: ${err.message}`)
  }
  return empty()
}

export function saveSubs(subs) {
  try {
    ensureDir()
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(subs, null, 2))
  } catch (err) {
    logger?.error?.(`[xhh-TL][体力推送] 保存配置失败: ${err.message}`)
  }
}

// ============ 插件 ============
export class StaminaPushService extends plugin {
  constructor() { super({name:'[小火花]体力投递',rule:[]}) }
  // -------- 指令：设置 --------




  // -------- 指令：设置（全 id 推送）--------




  /** 功能总开关：锅巴里关闭 resin_push_enable 时，所有指令一并停用 */

  /** 鸣潮专用前置校验：锅巴总开关 + gsuid_core 里是否有可用凭证。通过返回 null，否则返回提示文案 */

  /** 查询失败（返回字符串/false）时的用户提示；鸣潮不走米游社，文案单独一套 */


  /** 全 id 推送：监控该 QQ 名下所有绑定 UID，每个 UID 各自到阈值各自 @ 一次 */

  // -------- 指令：关闭 --------










  // -------- 指令：用法 --------

  // -------- 指令：列表 --------

  // ============ 定时检查 ============

  /**
   * 查一个订阅目标的体力
   * - gs/sr/zzz：走 TL.note（定时场景用「假 e + Runtime」，uid 为空即主 UID）
   * - ww：不走米游社，凭证读 gsuid_core 鸣潮插件的库后直接问库街区
   * @param {object} opts { qq, groupId, uid 指定 UID（全推送用）, e 交互场景传真实事件 }
   * @returns {Promise<object|string|false>} item，或错误说明字符串
   */

  /** 鸣潮体力：uid 为空时取绑定列表第一个（主 UID）；返回 item 或错误说明字符串 */

  /** 出图并在群里 @ 用户发送；forceUid 指定时用于日志/渲染定位（全 id 推送） */

  // -------- 参量质变仪 / 洞天宝钱到期提醒 --------

  /**
   * 反查：这个真实账号（uid）有哪些人订阅了体力推送。
   * 同步纯读盘 —— 定时器到点时要立刻拿到，不能 await。
   * 同时覆盖「主号推送」（sub.uid 匹配）与「全推送」（sub.uids 里有该 uid）。
   * @returns {Array<{qq:string, group:string}>}
   */

  /**
   * 到点复核：拿一份**此刻的真身**，确认该提醒是不是真的到了。
   *
   * 为什么非做不可：定时器的到点时刻是照 dailyNote 的倒计时字段算的，
   * 而洞天宝钱的 home_coin_recovery_time 会和实际库存脱钩 —— 实测 cur 卡在
   * 990/2400 一个多小时不动，倒计时却一秒不差地走向归零。照倒计时推送就是
   * 「没满却 @ 人说满了」（2026-09-30 04:08 那条假推送）。
   *
   * 复核走用户查询同一条路（带明细、跳过视图缓存），判据回到唯一可信的 cur>=max。
   *
   * ⚠️ 查询失败（风控 1034 / 凭证过期 / 网络抖动）**不等于「已满」**。
   * 早期这里对失败返回 null、上层按「放行发送」处理 —— 那是错的：查不到就用
   * 「我不知道」推出「满了」，跟这次 bug 是同一个毛病。现在失败时退回到
   * **记录里存的上次快照**判断：快照说没满就按它接着等，快照也说满了才放行。
   * 实在一点信息都没有（快照也没有）才返回 null。
   *
   * @returns {{ready:boolean, dueAt?:number|null, snap?:object}|null}
   *   null = 连兜底快照都没有，判不了（会退化成旧的「照倒计时发」行为）
   */

  /**
   * 兜底判据：拿订阅记录里那份**上次查询的快照**判该提醒到没到。
   * 仅在复核查询失败时用（见 verifyReminder）。判不了返回 null。
   *
   * 判读逻辑直接复用 evaluateSnapshot —— 快照的结构和接口响应同源
   * （recordResinTimer 就是挑着存的这几个字段），没必要另写一套必然漂移的判据。
   */

  /**
   * 到期提醒：@用户 + 一张提醒卡（横幅 + 单条）。
   * 出图用的是记录里存下来的快照（见 resinTimer 的 dueAt 记录），不重查接口。
   *
   * ⚠️ 全部目标都失败时必须把错误抛出去，让 resinTimer.fire() 重试。
   * 典型场景是「重启补发」：scheduleTimers() 在插件构造期跑，那时适配器还没连上、
   * Bot 还是 undefined。这里若把异常吞掉，fire() 会以为发成功而落盘 fired，提醒就永久丢了。
   */

  /** 「体力推送列表」里附一行到期提醒状态；没记录/无 uid 时返回空串 */
  _timerTip(uid) {
    if (!uid) return ''
    let stats = null
    try { stats = timerStats('gs', uid) } catch (_) { return '' }
    if (!stats) return ''
    const fmt = (st) => {
      if (!st) return null
      if (st.state === 'fired') return '已提醒'
      if (!st.dueAt || st.dueAt <= Date.now()) return '即将提醒'
      return new Date(st.dueAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    }
    const parts = []
    const tf = fmt(stats.transformer)
    const hc = fmt(stats.homeCoin)
    if (tf) parts.push(`质变仪 ${tf}`)
    if (hc) parts.push(`洞天宝钱 ${hc}`)
    return parts.length ? `⏰ ${parts.join(' / ')}` : ''
  }

  /** 构造一个带 runtime、reply 无副作用的假事件，供 TL 查询/渲染复用 */
  makeFakeE(qq, groupId, route={}) {
    return scheduledEvent(qq,groupId,route,Runtime)
  }
}
