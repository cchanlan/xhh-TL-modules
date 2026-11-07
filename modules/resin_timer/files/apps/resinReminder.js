import { taskIsCurrent } from '../utils/taskLifecycle.js'
import { deliveryGroup, mention, subscriptionMatches } from '../utils/delivery.js'
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
import { StaminaService as TL } from '../utils/staminaService.js'
import { createUser } from '../utils/userBind.js'
import { config, getRenderScaleStyle, pluginDir } from '../utils/pluginConfig.js'
import { listWavesAccounts, fetchWavesStamina, isWavesTlEnabled, getWavesEnvError } from '../utils/moduleOptional.js'
import { quoteEnabled } from '../utils/replyHelper.js'
import { registerReminderHooks, scheduleTimers, refreshUidTimers, timerStats, timerSnapshot, evaluateSnapshot } from '../utils/moduleOptional.js'
import { isModuleEnabled } from '../utils/modules.js'


import { StaminaPushService, DATA_DIR, CONFIG_FILE, DEFAULT_CRON, GAME_META, GAMES, setReg, offReg, ALL_KEY, ensureDir, loadSubs, saveSubs } from '../utils/staminaPushService.js'
export class resinReminder extends StaminaPushService {
  constructor() {
    super(); this.name='[小火花]到期提醒'; this.rule=[];
    registerReminderHooks({targets:(g,u)=>this.reminderTargets(g,u),send:i=>this.sendReminder(i),verify:i=>this.verifyReminder(i)});
    scheduleTimers();
  }
  reminderTargets(game, uid) {
    if (game !== 'gs') return []
    const u = String(uid || '')
    if (!u) return []
    const subs = loadSubs()
    const out = []
    for (const qq of Object.keys(subs.gs)) {
      const sub = subs.gs[qq]
      if (!sub?.group) continue
      if (String(sub.uid || '') !== u) continue
      out.push({ qq, group: sub.group, bot:sub.bot, user:sub.user, account:sub.account, revision:sub.revision })
    }
    for (const qq of Object.keys(subs.gs_all)) {
      const sub = subs.gs_all[qq]
      if (!sub?.group || !sub.uids?.[u]) continue
      out.push({ qq, group: sub.group, bot:sub.bot, user:sub.user, account:sub.account, revision:sub.revision })
    }
    return out
  }

  async verifyReminder({ game, uid, type }) {
    if (game !== 'gs' || !uid) return null
    // 用订阅者本人去查：凭证是按 QQ+UID 选的，复核必须走同一条鉴权路径，
    // 否则拿到的可能是别人的号（原神 widget 不带 uid、只认 stoken 属主）。
    const targets = this.reminderTargets(game, uid)
    const t = targets[0]
    if (!t) return null

    let data = null
    try {
      const fakeE = this.makeFakeE(t.qq, t.group, t)
      // forceNoteDetail：连 30 分钟视图缓存也跳过。缓存里只有质变仪的 ok/text，
      // 没有洞天宝钱的 home_coin_recovery_time —— 命中缓存就和没复核一样。
      data = await new TL().note(fakeE, 'gs', true, null, uid, { forceNoteDetail: true })
    } catch (err) {
      logger?.debug?.(`[xhh-TL][到期提醒] 复核查询失败 ${uid}: ${err?.message}`)
      data = null
    }

    if (data && typeof data === 'object') {
      const evalAll = evaluateSnapshot(game, uid, data)
      const v = evalAll?.[type]
      if (v) return { ready: v.ready, dueAt: v.dueAt, snap: evalAll.snap }
      // 这份快照里没有该类信息（比如还没获得质变仪）→ 落到下面走兜底
    }

    // 查询没拿到有效信息 → 用记录里上次查询留下的快照兜底判断。
    // 它必然滞后，但判「满没满」够用：宝钱只会往上涨，旧快照说没满就是没满。
    const fallback = this.snapshotVerdict(uid, type)
    if (fallback) {
      logger?.debug?.(
        `[xhh-TL][到期提醒] 复核没拿到新数据，用记录快照判定 ${type} uid=${uid} → ${fallback.ready ? '放行' : '继续等'}`,
      )
    }
    return fallback
  }

  snapshotVerdict(uid, type) {
    let snap = null
    try {
      snap = timerSnapshot('gs', String(uid))
    } catch (_) {
      return null
    }
    if (!snap || typeof snap !== 'object') return null

    const evalAll = evaluateSnapshot('gs', String(uid), snap)
    const v = evalAll?.[type]
    if (!v) return null
    return { ready: v.ready, dueAt: v.dueAt, snap: evalAll.snap }
  }

  async sendReminder({ uid, type, targets, item }) {
    const text =
      type === 'homeCoin'
        ? '你的洞天宝钱已经满啦，快去洞天里取一下吧~'
        : '你的参量质变仪已经可以再次使用啦，记得用掉~'
    let ok = 0
    let lastErr = null
    for (const t of targets) {
      try {
        // Bot 是宿主注入的全局量，适配器连上之前不存在 —— 给个明确的错，别抛 TypeError
        if (typeof Bot === 'undefined' || !Bot?.pickGroup) throw new Error('适配器尚未连接')
        const {group} = deliveryGroup(t.group,t.bot)
        const fakeE = this.makeFakeE(t.qq, t.group, t)
        let imgSeg = null
        try {
          imgSeg = await new TL().renderRemindCard(fakeE, {
            type,
            item,
            displayInfo: { qq: t.qq, qqname: String(t.qq) },
          })
        } catch (err) {
          logger?.error?.(`[xhh-TL][到期提醒] 出图失败 ${type}: ${err.message}`)
        }
        // 顺序：@ → 图 → 文案。文案固定放图下面（主人明确要求，别再放上面）。
        // 文案前不加换行：图片是独立块，QQ 自己就会换行，再加 \n 会多空出一行。
        const segs = [mention(t.user || t.qq)]
        if (imgSeg) segs.push('\n', imgSeg)
        segs.push(text)
        if(!taskIsCurrent())return
        if(!this.reminderTargets('gs',uid).some(live=>live.qq===t.qq&&subscriptionMatches(live,t)))continue
        await group.sendMsg(segs)
        ok++
        logger?.mark?.(`[xhh-TL][到期提醒] 已提醒 ${type} uid=${uid} → ${t.qq}@群${t.group}${imgSeg ? '' : '（无图）'}`)
      } catch (err) {
        lastErr = err
        logger?.error?.(`[xhh-TL][到期提醒] 发送失败 ${t.qq}@群${t.group}: ${err.message}`)
      }
    }
    // 一个都没发出去 → 抛给 fire() 重试（别让提醒静默消失）
    if (!ok && lastErr) throw lastErr
  }

}
