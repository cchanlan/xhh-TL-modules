import fs from 'fs';
import fetch from 'node-fetch';
import moment from 'moment';
import md5 from 'md5';
import lodash from 'lodash';
import plugin from '../../../lib/plugins/plugin.js';
import { createUser, getAliveMysIds, hasRuntimeBinding } from '../utils/userBind.js';
import { getstoken, cookiePart, stokenToCookie, findStokenEntry } from '../utils/auth.js';
import common from '../../../lib/common/common.js';
import { config, pluginDir, pickCharacterPortrait, toDataUrl, toDataUrlTrim, getImageFormat } from '../utils/pluginConfig.js';
import { guardModule } from '../utils/modules.js';
import { getPortraitPalette } from '../utils/portraitPalette.js';
import { replyQuote, replyForward, quoteEnabled } from '../utils/replyHelper.js';
import { renderTpl } from '../utils/render.js';
import { prepareMysContext, resolveAuth } from '../utils/runtimePatch.js';
import LiteMysApi from '../utils/mysClient.js';
import { captchaTip } from '../utils/captchaTip.js';
import { getWavesStaminaList, isWavesTlEnabled, listWavesAccounts } from '../utils/moduleOptional.js';
import { recordResinTimer } from '../utils/moduleOptional.js';
import { roundCorners } from '../utils/renderImage.js';
import { solveByLocalService } from '../utils/mysVerify.js';

/** 质变仪补拉撞码后的重试梯度（毫秒），与 captchaNotice 同一套：总窗口 21 秒 */

import { StaminaService, TRANSFORMER_RETRY_GAPS, NOTE_CAPTCHA_RC, widgetActLimit, getShowUid, getShowGame, getShowGs, getShowSr, getShowZzz, getWavesPref, GAME_ALIAS, GAME_LABEL, HIDE_GAMES, hideUidKey, getHiddenUids, setHiddenUids, getAllHiddenUids, mysSalt, mysSalt2, mysSalt3, randomString, getDeviceGuid, getDs, getDs2, getServer, fetchDeviceFp, getHeaders, callApi, getTime, redisSetEx, formatTransformer } from '../utils/staminaService.js'
export class TL extends StaminaService {
  constructor() {
    super();
    this.name='[小火花]体力小组件';
    this.priority=config().tl_priority ?? -99;
    this.rule=[
        {
          // 可选 #/*/%；关键词必须完整结束，尾部多余字不触发
          // 「四游戏体力」保留作兼容别名（历史指令，现为三游戏）
          // 鸣潮体力走 gsuid_core，别名 鸣潮/mc（不收 w，避免和 core 自己的 w体力 撞车）
          reg: '^\\s*(?:#|\\*|%)*(?:全体力|三游戏体力|四游戏体力|米游社体力|体力总览|体力|tl|(?:原神|ys)(?:体力|tl)|(?:星铁|xt|\\*)(?:体力|tl)|(?:绝区零|zzz)(?:体力|tl)|(?:鸣潮|mc)(?:体力|tl))\\s*$',
          fnc: 'note_',
        },
        {
          reg: '^\\s*#?(?:开启|打开)体力uid\\s*$',
          fnc: 'toggleUidDisplay',
        },
        {
          reg: '^\\s*#?(?:关闭|关掉)体力uid\\s*$',
          fnc: 'toggleUidDisplay',
        },
        {
          reg: '^\\s*#?(?:开启|打开|关闭|关掉)(?:原神|ys)体力\\s*$',
          fnc: 'toggleGsDisplay',
        },
        {
          reg: '^\\s*#?(?:开启|打开|关闭|关掉)(?:星铁|xt)体力\\s*$',
          fnc: 'toggleSrDisplay',
        },
        {
          reg: '^\\s*#?(?:开启|打开|关闭|关掉)(?:绝区零|zzz)体力\\s*$',
          fnc: 'toggleZzzDisplay',
        },
        {
          reg: '^\\s*#?(?:开启|打开|关闭|关掉)(?:鸣潮|mc)体力\\s*$',
          fnc: 'toggleWavesDisplay',
        },
        {
          // 单 UID 屏蔽：#关闭原神123456789 / #屏蔽星铁体力123456789 / #开启鸣潮123456789
          // 必须带 UID 才走这里，不带 UID 的「#关闭原神体力」仍是上面的整游戏开关
          reg: '^\\s*#?(?:取消屏蔽|解除屏蔽|开启|打开|恢复|显示|关闭|关掉|屏蔽|隐藏)(?:原神|ys|星铁|xt|绝区零|zzz|鸣潮|mc)(?:体力)?\\s*\\d{6,12}\\s*$',
          fnc: 'toggleUidHidden',
        },
        {
          reg: '^\\s*#?(?:体力屏蔽|屏蔽体力|屏蔽)(?:列表|清单)\\s*$',
          fnc: 'hiddenUidList',
        },
      ];
  }
  async note_(e) {
    logger.info('[xhh-TL][note_] 开始处理');
    if (!config().Tl) {
      logger.info('[xhh-TL][note_] Tl配置为false，跳过');
      return false;
    }
    logger.info('[xhh-TL][note_] Tl配置为true，继续处理');

    // 检测 @ 提及，支持查询他人体力（排除 @bot 自身）
    let targetQq = null;
    const selfId = e.self_id || (e.bot || Bot)?.uin;
    for (const msg of e.message || []) {
      if (msg.type === 'at' && String(msg.qq) !== String(selfId)) { targetQq = msg.qq; break; }
    }

    let hasAllData = false;
    const rawMsg = (e.msg || '').replace(/^(#|\\*|%)*/, '');
    const isQueryAll = ['体力', '全体力', '三游戏体力', '四游戏体力', '米游社体力', '体力总览', 'tl'].includes(rawMsg);
    logger.info(`[xhh-TL][note_] rawMsg: ${rawMsg}, isQueryAll: ${isQueryAll}`);
    const isStarRail = /星铁|xt|^\*/.test(rawMsg) || e.msg.includes('*体力') || e.msg.includes('*tl');
    const isZZZ = /绝区零|zzz/i.test(rawMsg);
    const isGenshin = /原神|ys/i.test(rawMsg);
    // 单独 #鸣潮体力：只查鸣潮，出图仍走本插件模板（经典/立绘/小组件三种样式）
    // 直接判原始消息，免受上面 rawMsg 只剥 # 的影响（*鸣潮体力 也能进来）
    const isWaves = /^\s*(?:#|\*|%)*(?:鸣潮|mc)(?:体力|tl)\s*$/i.test(e.msg || '');
    if (isWaves) {
      if (!isWavesTlEnabled()) {
        await replyQuote(e, '鸣潮体力未启用，请主人到锅巴「小火花体力小组件」里打开「启用鸣潮体力」');
        return true;
      }
      const res = await this.getWavesList(e, targetQq || e.user_id);
      if (!res.items.length) {
        await replyQuote(e, res.hiddenAll
          ? '你已屏蔽全部鸣潮 UID 的体力显示，发【#体力屏蔽列表】看看，或【#开启鸣潮<UID>】恢复'
          : res.error === '没有'
            ? '没有可用的鸣潮账号，请先发「w登录」登录鸣潮'
            : `鸣潮体力查询失败，请稍后重试`);
        return true;
      }
    }
    const getZZZData = async () => {
      const data = await this.note(e, 'zzz', isQueryAll, targetQq);
      if (
        data &&
        !['过期', '没有'].includes(data) &&
        !data.s2_bounty_commission
      ) {
        data.s2_bounty_commission = { num: 0, total: 0 };
      }
      return data;
    };

    let resultData = {};

    // 各游戏显示开关：仅影响「体力总览」，默认显示；关闭后总览不查/不显示该游戏。
    // 以被查者为准：某人关了某游戏后，无论他自己查还是别人艾特查他，都不显示其该游戏。
    // 单独 #原神体力/#星铁体力/#绝区零体力 不受此开关影响。
    const overviewQq = targetQq || e.user_id;
    const [showGs, showSr, showZzz] = isQueryAll
      ? await Promise.all([getShowGs(overviewQq), getShowSr(overviewQq), getShowZzz(overviewQq)])
      : [true, true, true];

    // 鸣潮体力：需锅巴总开关 + #开启鸣潮体力（默认关）。艾特别人查时，按「被查者自己开过就显示」，
    // 他没设置过才退回看发起人的开关（否则鸣潮默认关，艾特别人基本永远出不来）；
    // 被艾特者显式 #关闭鸣潮体力 过则一律尊重，不给别人查他的鸣潮。
    let wavesOn = false;
    if (isQueryAll && isWavesTlEnabled()) {
      const [selfPref, targetPref] = await Promise.all([
        getWavesPref(e.user_id),
        targetQq ? getWavesPref(overviewQq) : Promise.resolve(null),
      ]);
      wavesOn = targetPref === true || (targetPref !== false && selfPref === true);
    }
    // 与米游社三游戏并行取数（同一 promise 会被后续渲染复用，不会重复请求库街区）
    const wavesTask = wavesOn ? this.getWavesList(e, overviewQq) : null;


    if (isQueryAll) {
      hasAllData = true;
      logger.info('[xhh-TL][note_] 开始查询所有游戏体力');
      const [gsData, srData, zzzData, wavesRes] = await Promise.all([
        showGs ? this.note(e, 'gs', true, targetQq) : Promise.resolve('没有'),
        showSr ? this.note(e, 'sr', true, targetQq) : Promise.resolve('没有'),
        showZzz ? getZZZData() : Promise.resolve('没有'),
        wavesTask || Promise.resolve(null),
      ]);
      resultData = {};
      if (showGs) resultData.gs_data = gsData;
      if (showSr) resultData.sr_data = srData;
      if (showZzz) resultData.zzz_data = zzzData;
      if (wavesOn) resultData.ww_data = wavesRes?.items?.[0] || '没有';
      // 鸣潮取数失败时总览只会「静默少一块」，用户根本不知道为什么（实测就是撞上 core 库被锁）。
      // 环境级失败（读不到库/库正忙/接口报错）先说一句；「没登录」「全屏蔽」属正常状态不提示
      if (
        wavesOn &&
        !wavesRes?.items?.length &&
        wavesRes?.error &&
        wavesRes.error !== '没有' &&
        !wavesRes.hiddenAll
      ) {
        e.reply(`鸣潮体力这次没取到，请稍后重试`, quoteEnabled());
      }
    } else if (isWaves) {
      const res = await this.getWavesList(e, targetQq || e.user_id);
      resultData = { ww_data: res.items[0] };
    } else if (isStarRail) {
      resultData = { sr_data: await this.note(e, 'sr', false, targetQq) };
    } else if (isZZZ) {
      resultData = { zzz_data: await getZZZData() };
    } else {
      resultData = { gs_data: await this.note(e, 'gs', false, targetQq) };
    }

    // 总览时四游戏均被关闭 → 无可展示项，给出明确提示
    if (isQueryAll && !Object.keys(resultData).length) {
      e.reply('你已关闭原神/星铁/绝区零体力显示，请先开启其中之一再查询总览~', quoteEnabled());
      return true;
    }
    if (Object.values(resultData).every(v => v === '没有')) {
      if (hasAllData) {
        e.reply(await this.noAccountTip(overviewQq, '没有绑定米游社，请【#扫码登录】米游社'), quoteEnabled());
      }
      return true;
    }
    if (Object.values(resultData).every(v => v === '过期')) {
      if (hasAllData) e.reply('米游社验证已过期，请【#刷新ck】，仍不行则【#扫码登录】', quoteEnabled());
      return true;
    }

    // 查询他人时获取目标信息
    let displayQq = e.user_id;
    let displayName = e.sender.card && (e.sender.card.length < 11) ? e.sender.card : e.sender.nickname && (e.sender.nickname.length < 11) ? e.sender.nickname : e.user_id;
    if (targetQq) {
      displayQq = targetQq;
      displayName = String(targetQq);
      if (e.isGroup) {
        // 1) 优先用缓存的群成员 (同步，无API调用)
        try {
          const member = e.group?.pickMember?.(targetQq);
          if (member?.card || member?.nickname) {
            displayName = member.card || member.nickname;
          }
        } catch (_) {}
        // 2) 没拿到就走API: getGroupMemberInfo 或 sendApi(NapCat)
        if (displayName === String(targetQq)) {
          const bot = e.bot || Bot;
          try {
            let info = null;
            if (bot.getGroupMemberInfo) {
              info = await bot.getGroupMemberInfo(String(e.group_id), String(targetQq));
            } else if (bot.sendApi) {
              const res = await bot.sendApi('get_group_member_info', { group_id: String(e.group_id), user_id: String(targetQq) });
              info = res?.data || res;
            }
            if (info && (info.card || info.nickname)) {
              displayName = info.card || info.nickname;
            }
          } catch (_) {}
        }
      }
    }

    const renderData = {
      bg: Object.values(resultData).filter(Boolean).length > 1 ? 'bg' : 'bg1',
      qq: displayQq,
      qqname: displayName,
      time: `${moment().format('MM-DD HH:mm')} ${this.week[moment().day()]}`,
    };

    for (const key in resultData) {
      if (resultData[key] === '没有' || resultData[key] === '过期') {
        resultData[key] = false;
      }
    }

    const { ..._data_ } = { ...renderData, ...resultData };

    // 立绘卡 / 桌面小组件卡：四游戏均走 renderPortraitFlow（内部按样式分流）
    if (['portrait', 'widget'].includes(config().tl_card_style)) {
      const displayInfo = { qq: displayQq, qqname: displayName };
      const handled = await this.renderPortraitFlow(e, {
        isQueryAll, isStarRail, isZZZ, isGenshin, isWaves,
        showGs, showSr, showZzz, showWaves: wavesOn,
        resultData: _data_, displayInfo, targetQq,
      });
      if (handled) return true;
    }

    // 经典模板出图（多 UID / 单图）
    return this.replyClassicTl(e, {
      displayQq,
      displayName,
      renderData,
      resultData: _data_,
      isQueryAll,
      isStarRail,
      isZZZ,
      isGenshin,
      isWaves,
      showZzz,
      showWaves: wavesOn,
      targetQq,
    });
  }

  async toggleUidDisplay(e) {
    const enable = /开启|打开/.test(e.msg);
    await redis.set(`xhh:show_uid:${e.user_id}`, String(enable));
    e.reply(enable ? '已开启体力UID显示' : '已关闭体力UID显示，查询体力时将隐藏UID');
    return true;
  }

  async toggleGsDisplay(e) {
    const enable = /开启|打开/.test(e.msg);
    await redis.set(`xhh:show_gs:${e.user_id}`, String(enable));
    e.reply(enable ? '已开启原神体力显示，体力总览将包含原神' : '已关闭原神体力显示，体力总览将隐藏原神');
    return true;
  }

  async toggleSrDisplay(e) {
    const enable = /开启|打开/.test(e.msg);
    await redis.set(`xhh:show_sr:${e.user_id}`, String(enable));
    e.reply(enable ? '已开启星铁体力显示，体力总览将包含星铁' : '已关闭星铁体力显示，体力总览将隐藏星铁');
    return true;
  }

  async toggleZzzDisplay(e) {
    const enable = /开启|打开/.test(e.msg);
    await redis.set(`xhh:show_zzz:${e.user_id}`, String(enable));
    e.reply(enable ? '已开启绝区零体力显示，体力总览将包含绝区零' : '已关闭绝区零体力显示，体力总览将隐藏绝区零');
    return true;
  }

  async toggleWavesDisplay(e) {
    const enable = /开启|打开/.test(e.msg);
    await redis.set(`xhh:show_waves:${e.user_id}`, String(enable));
    if (enable && !isWavesTlEnabled()) {
      e.reply('已记录。鸣潮还没启用，请主人到锅巴打开「启用鸣潮体力」');
      return true;
    }
    e.reply(enable
      ? '已开启鸣潮体力显示，体力总览将附带鸣潮'
      : '已关闭鸣潮体力显示，体力总览将隐藏鸣潮');
    return true;
  }

  async toggleUidHidden(e) {
    const msg = (e.msg || '').trim();
    const m = /^#?(取消屏蔽|解除屏蔽|开启|打开|恢复|显示|关闭|关掉|屏蔽|隐藏)(原神|ys|星铁|xt|绝区零|zzz|鸣潮|mc)(?:体力)?\s*(\d{6,12})$/.exec(msg);
    if (!m) return false;
    const [, action, alias, uid] = m;
    const game = GAME_ALIAS[alias];
    const label = GAME_LABEL[game];
    // 「取消屏蔽/解除屏蔽」含「屏蔽」，故先判恢复词
    const unhide = /^(取消屏蔽|解除屏蔽|开启|打开|恢复|显示)$/.test(action);
    const qq = e.user_id;

    const hidden = await getHiddenUids(qq, game);
    if (unhide) {
      if (!hidden.delete(uid)) {
        e.reply(`${label} UID ${uid} 本来就没被屏蔽`, quoteEnabled());
        return true;
      }
      await setHiddenUids(qq, game, hidden);
      e.reply(`已恢复 ${label} UID ${uid} 的体力显示`, quoteEnabled());
      return true;
    }

    if (hidden.has(uid)) {
      e.reply(`${label} UID ${uid} 已在屏蔽列表里，发【#开启${label}${uid}】可恢复`, quoteEnabled());
      return true;
    }

    // 能枚举出绑定列表时校验一次，挡掉打错的 UID；枚举不到（无凭证/鸣潮没开）就不拦
    const bound = await this.listBoundUids(e, game, qq);
    if (bound.length && !bound.includes(uid)) {
      e.reply(`没在你的${label}绑定里找到 UID ${uid}\n当前绑定：${bound.join('、')}`, quoteEnabled());
      return true;
    }

    hidden.add(uid);
    await setHiddenUids(qq, game, hidden);
    const lines = [`已屏蔽 ${label} UID ${uid} 的体力显示`];
    if (bound.length) {
      const rest = bound.filter((u) => !hidden.has(u));
      lines.push(rest.length
        ? `剩余显示：${rest.join('、')}`
        : `该游戏已无可显示 UID，查${label}体力会提示已屏蔽`);
    }
    lines.push(`恢复：#开启${label}${uid}`);
    e.reply(lines.join('\n'), quoteEnabled());
    return true;
  }

  async hiddenUidList(e) {
    const all = await getAllHiddenUids(e.user_id);
    const games = Object.keys(all);
    if (!games.length) {
      e.reply('你没有屏蔽任何 UID\n屏蔽：#关闭原神123456789（该 UID 不再出现在体力卡里）', quoteEnabled());
      return true;
    }
    const lines = games.map((g) => `${GAME_LABEL[g]}：${all[g].join('、')}`);
    e.reply(
      `已屏蔽的体力 UID：\n${lines.join('\n')}\n` +
      `恢复：#开启${GAME_LABEL[games[0]]}${all[games[0]][0]}`,
      true,
    );
    return true;
  }

}
guardModule(TL, 'tl', ["note_", "toggleUidDisplay", "toggleGsDisplay", "toggleSrDisplay", "toggleZzzDisplay", "toggleWavesDisplay", "toggleUidHidden", "hiddenUidList"]);
