/**
 * 小剧诗：个人通关关键关卡（第 3/6/8/10 幕 + 双圣牌）
 * 米游社 #剧诗 通关数据 + 队伍角色，样式对齐体力插件
 * 命令：#小剧诗 / #小剧诗上期 / #小剧诗@某人
 */

import moment from 'moment'
import YAML from 'yaml'
import lodash from 'lodash'
import { Character, MysApi, Player } from '../../miao-plugin/models/index.js'
import { prepareMysContext } from '../utils/runtimePatch.js'
import { config, pluginDir } from '../utils/pluginConfig.js'
import { replyProgress } from '../utils/replyHelper.js'
import { renderTpl } from '../utils/render.js'
import { faceUrl, pickGsBgImage, resolveTargetQq, resolveDisplayName } from '../utils/gsHelper.js'
import { guardModule } from '../utils/modules.js'

function intToRoman(num) {
  if (num < 1 || num > 3999) return String(num)
  const thousands = ['', 'M', 'MM', 'MMM']
  const hundreds = ['', 'C', 'CC', 'CCC', 'CD', 'D', 'DC', 'DCC', 'DCCC', 'CM']
  const tens = ['', 'X', 'XX', 'XXX', 'XL', 'L', 'LX', 'LXX', 'LXXX', 'XC']
  const ones = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX']
  return (
    thousands[Math.floor(num / 1000)] +
    hundreds[Math.floor((num % 1000) / 100)] +
    tens[Math.floor((num % 100) / 10)] +
    ones[num % 10]
  )
}

function isKeyRound(round) {
  if (!round) return false
  if (round.is_tarot) return true
  const id = Number(round.round_id)
  return [3, 6, 8, 10].includes(id)
}


function readTalent(value) {
  const raw = value && typeof value === 'object' ? (value.level ?? value.original) : value
  if (raw == null || raw === '' || raw === false) return ''
  return Number.isFinite(Number(raw)) ? Number(raw) : ''
}

function resolveAvatarCard(avatar, avatarDataMap = {}) {
  const id = String(avatar.avatar_id || avatar.id || '')
  const type = Number(avatar.avatar_type || 1)
  const own = type === 1 ? (avatarDataMap[id] || avatarDataMap[Number(id)] || {}) : {}
  // 全名优先，避免奇怪 abbr
  let name = avatar.name || own.name || own.abbr || id
  let face = own.face || own.qFace || ''
  let star = avatar.rarity || own.star || 4
  let elem = String(avatar.element || own.elem || '').toLowerCase()
  let level = avatar.level || own.level || 0
  let cons = own.cons
  if (id) {
    try {
      const char = Character.get(Number(id)) || new Character({ id: Number(id), name: avatar.name })
      if (char) {
        if (!name || name === id || /^\d+$/.test(name)) name = char.name || char.abbr || name
        else if (name === char.abbr && char.name) name = char.name
        face = face || char.face || char.qFace || ''
        star = char.star || star
        elem = char.elem || elem
      }
    } catch (_) {}
  }
  if (own.name && own.name.length >= (name?.length || 0)) name = own.name

  let weapon = null
  const ow = own.weapon || {}
  if (ow.name || ow.id || ow.img) {
    weapon = {
      name: ow.name || ow.abbr || '',
      abbr: ow.abbr || ow.name || '',
      affix: ow.affix,
      img: faceUrl(ow.img || ow.icon || ow.imgs?.icon || ''),
    }
  }

  let artis = null
  const set = own.artisSet
  if (set && (set.name || set.sName || (Array.isArray(set.names) && set.names.length) || (Array.isArray(set.imgs) && set.imgs.length))) {
    artis = {
      name: set.sName || set.name || (set.names || []).join('+') || '',
      imgs: (set.imgs || []).filter(Boolean).slice(0, 2).map(u => faceUrl(u)),
    }
  }

  const typeLabel = { 1: '', 2: '试用', 3: '助演' }[type] || ''
  return {
    id,
    name,
    face: faceUrl(face || avatar.image || ''),
    star,
    elem,
    level,
    cons: cons == null || cons === '' ? null : cons,
    type,
    typeLabel,
    detailSource: type === 1 ? (own.detailSource || 'missing') : 'report',
    weapon,
    artis,
    talent: {
      a: readTalent(own.talent?.a),
      e: readTalent(own.talent?.e),
      q: readTalent(own.talent?.q),
    },
  }
}

/** Accept both legacy avatars and current list/base responses. */
function normalizeCharacterResponse(response) {
  if (!response || (response.retcode != null && Number(response.retcode) !== 0)) return []
  const data = response.data && !response.avatars && !response.list ? response.data : response
  const list = Array.isArray(data.avatars) ? data.avatars : Array.isArray(data.list) ? data.list : []
  return list.filter(entry => entry && typeof entry === 'object').map(entry => ({ ...entry, ...(entry.base || {}) })).filter(entry => entry.id || entry.avatar_id)
}

function mergeCharacterData(map, entries, freshEquipment = false) {
  for (const entry of entries) {
    const id = String(entry.id || entry.avatar_id)
    const old = map[id] || {}
    const next = { ...old, name: entry.name || old.name, level: entry.level ?? old.level,
      star: entry.rarity || entry.star || old.star,
      elem: String(entry.element || old.elem || '').toLowerCase(),
      cons: entry.actived_constellation_num ?? entry.cons ?? old.cons }
    if (entry.weapon?.id || entry.weapon?.name) {
      const weapon = entry.weapon
      next.weapon = { ...weapon, star: weapon.rarity ?? weapon.star,
        affix: weapon.affix_level ?? weapon.affix,
        img: weapon.icon || weapon.img || (weapon.id === old.weapon?.id ? old.weapon.img : '') }
    }
    if (Array.isArray(entry.relics) && entry.relics.length) {
      const sets = new Map()
      for (const relic of entry.relics) {
        const name = relic.set?.name || relic.set_name || ''
        if (!name) continue
        const set = sets.get(name) || { name, count: 0, img: relic.icon || relic.img || '' }
        set.count++; sets.set(name, set)
      }
      const selected = [...sets.values()].sort((a, b) => b.count - a.count).slice(0, 2)
      if (selected.length) next.artisSet = { names: selected.map(s => s.name), name: selected.map(s => s.name + '×' + s.count).join(' + '), imgs: selected.map(s => s.img).filter(Boolean) }
    }
    if (entry.talent) next.talent = entry.talent
    next.detailSource = freshEquipment && (entry.weapon?.id || entry.weapon?.name || entry.relics?.length) ? 'fresh' : (old.detailSource || 'missing')
    map[id] = next
  }
}

/**
 * 从米游社 detail 抽出关键关卡
 */
function buildKeyStages(lvs, avatarDataMap) {
  const rounds = lvs?.detail?.rounds_data || []
  const stages = []

  for (const round of rounds) {
    if (!isKeyRound(round)) continue

    const isTarot = !!round.is_tarot
    const roundId = Number(round.round_id)
    const tarotNo = Number(round.tarot_serial_no || 0)
    const title = isTarot
      ? `圣牌挑战 ${intToRoman(tarotNo || 1)}`
      : `第 ${roundId} 幕`
    // 不再显示「幕 3 / 圣牌 I」等角标，只保留完整标题
    const tag = ''
    const showTag = false

    const avatars = (round.avatars || []).map(a => resolveAvatarCard(a, avatarDataMap))
    const enemies = (round.enemies || []).map(en => ({
      name: en.name || en.Name || '未知',
      level: en.level || en.Level || '',
      icon: en.icon || en.Icon || '',
    }))

    let finishTime = ''
    if (round.finish_time) {
      finishTime = moment(new Date(Number(round.finish_time) * 1000)).format('MM-DD HH:mm')
    }

    stages.push({
      key: isTarot ? `tarot-${tarotNo || stages.length}` : `r-${roundId}`,
      title,
      tag,
      showTag,
      kind: isTarot ? 'tarot' : 'room',
      is_get_medal: !!round.is_get_medal,
      finish_time: finishTime,
      avatars,
      enemies,
      enemyNames: enemies.map(x => x.name).join(' / '),
    })
  }

  // 稳定排序：幕 3/6/8/10 再圣牌
  const roomOrder = { 3: 1, 6: 2, 8: 3, 10: 4 }
  stages.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'room' ? -1 : 1
    if (a.kind === 'room') {
      const ra = Number(a.key.replace('r-', ''))
      const rb = Number(b.key.replace('r-', ''))
      return (roomOrder[ra] || 99) - (roomOrder[rb] || 99)
    }
    return a.key.localeCompare(b.key)
  })

  return stages
}

/**
 * 与 #幻想角色（role_combat.js）同一套：config.role_combat_bg_folder
 * 只取原神角色子文件夹里的图片；过滤后为空则回退扫全部子目录
 * Windows 下自动处理盘符路径与 file:/// URL
 */
function getVal(obj, pathStr) {
  return pathStr.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

export class miniRoleCombat extends plugin {
  constructor() {
    super({
      name: '[小火花]小剧诗',
      dsc: '幻想真境剧诗关键关卡通关速览',
      event: 'message',
      priority: -9998,
      rule: [
        {
          // #小剧诗 / 小幻想 / #小剧诗上期 / #上期小幻想；尾部多余字不触发
          reg: '^\\s*#?(?:上期)?小(?:剧诗|幻想)(?:上期)?\\s*$',
          fnc: 'mini',
        },
      ],
    })
  }

  async mini(e) {
    if (config().role_combat === false) return false

    const rawMsg = e.original_msg || e.msg || ''
    const isCurrent = !(/上期/.test(rawMsg))
    const periodText = isCurrent ? '本期' : '上期'

    const targetQq = resolveTargetQq(e)
    if (targetQq) e.at = targetQq

    await replyProgress(e, `正在获取${periodText}小剧诗关键关卡…`)

    await prepareMysContext(e, 'gs')
    const mys = await MysApi.init(e, 'cookie')
    if (!mys || !await mys.checkCk()) {
      return e.reply(
        mys
          ? `UID: ${mys.uid} Cookie 失效，请【#刷新ck】，仍不行则【#扫码登录】`
          : `请先【#扫码登录】后再使用 #小剧诗`,
      )
    }

    const uid = mys.uid
    const player = Player.create(e)

    let lvs
    try {
      const resRole = await mys.getRoleCombat(true)
      lvs = getVal(resRole, isCurrent ? 'data.0' : 'data.1')
      if (!lvs || !lvs.has_detail_data) {
        return e.reply(`暂未获得${periodText}幻想真境剧诗挑战数据…`)
      }
    } catch (err) {
      logger.error('[xhh][miniRoleCombat] 拉取剧诗失败:', err)
      return e.reply('幻想真境剧诗战报获取失败，请稍后重试')
    }

    // 关键关卡用到的自有角色 id
    const needIds = []
    for (const round of lvs?.detail?.rounds_data || []) {
      if (!isKeyRound(round)) continue
      for (const a of round.avatars || []) {
        if (Number(a.avatar_type) === 1 && a.avatar_id) {
          needIds.push(String(a.avatar_id))
        }
      }
    }
    const uniqIds = lodash.uniq(needIds)

    const avatarDataMap = {}
    try {
      const cached = player.getAvatarData(uniqIds) || {}
      for (const [key, value] of Object.entries(cached)) {
        if (value?.id) avatarDataMap[String(value.id || key)] = { ...value, detailSource: 'cached' }
      }
    } catch (err) {
      logger.debug('[xhh][miniRoleCombat] 读取角色缓存失败:', err?.message)
    }
    let detailUnavailable = false
    let freshEquipment = false
    try {
      const response = await mys.getCharacter()
      const entries = normalizeCharacterResponse(response)
      if (!entries.length) {
        detailUnavailable = true
        logger.debug('[xhh][miniRoleCombat] 角色资料不可用，保留战报与缓存:', Number(response?.retcode || e._retcode || 0))
      } else {
        freshEquipment = entries.some(a => a.weapon?.id || a.weapon?.name || a.relics?.length)
        mergeCharacterData(avatarDataMap, entries, freshEquipment)
        if (!freshEquipment && uniqIds.length && typeof mys.getCharacterDetail === 'function') {
          const detail = normalizeCharacterResponse(await mys.getCharacterDetail(uniqIds))
          freshEquipment = detail.some(a => a.weapon?.id || a.weapon?.name || a.relics?.length)
          mergeCharacterData(avatarDataMap, detail, freshEquipment)
        }
        detailUnavailable = !freshEquipment
        // Talent refresh is independent of the full-list API; cached gear is never overwritten by an empty list.
        if (freshEquipment && typeof player.refreshTalent === 'function') {
          try {
            await player.refreshTalent(uniqIds)
            const current = player.getAvatarData(uniqIds) || {}
            for (const value of Object.values(current)) {
              if (value?.id && avatarDataMap[String(value.id)]) avatarDataMap[String(value.id)].talent = value.talent
            }
          } catch (err) { logger.debug('[xhh][miniRoleCombat] 天赋刷新跳过:', err?.message) }
        }
      }
    } catch (err) {
      detailUnavailable = true
      logger.debug('[xhh][miniRoleCombat] 资料刷新失败，保留战报与缓存:', err?.message)
    }

    const stages = buildKeyStages(lvs, avatarDataMap)
    if (!stages.length) {
      return e.reply(
        `${periodText}还没通关关键关卡（第 3/6/8/10 幕或圣牌）`,
      )
    }

    const stat = lvs.stat || {}
    const month = lvs.schedule?.start_date_time?.month
      || lvs.schedule?.month
      || moment().month() + 1
    const difficultyMap = { 1: '简单', 2: '普通', 3: '困难', 4: '卓越', 5: '月谕' }
    const difficulty = difficultyMap[stat.difficulty_id] || '未知'
    const totalTime = lvs.detail?.fight_statisic?.total_use_time ?? stat.total_use_time ?? '-'

    const bgImage = pickGsBgImage('xhh-TL/miniRoleCombat')
    const qq = targetQq || e.user_id || e.sender?.user_id || ''
    const qqname = await resolveDisplayName(e, qq)

    const cfg = config()
    const themeRaw = String(cfg.role_combat_theme || cfg.gs_all_abyss_theme || 'light').toLowerCase()
    const theme = themeRaw === 'dark' ? 'dark' : 'light'
    const tplFile = pluginDir + '/resources/role_combat/mini_role_combat.html'
    const renderData = {
      theme,
      stages,
      detailUnavailable,
      stageCount: stages.length,
      periodText,
      month,
      difficulty,
      totalTime,
      coin: stat.coin_num ?? '-',
      medal: (stat.get_medal_round_list || []).filter(x => x === 1).length,
      medalTotal: (stat.get_medal_round_list || []).length || '-',
      uid,
      qq,
      qqname,
      bgImage,
      generatedAt: moment().format('MM-DD HH:mm'),
    }

    return renderTpl(e, {
      tpl: 'mini_role_combat',
      tplFile,
      data: renderData,
      baseScale: 1.8,
      rem: true,
    })
  }
}

// 关掉 role_combat 后 #小剧诗 / #小幻想 不再响应。
// 同一开关的另一半（#幻想角色）在 role_combat.js 里守卫
guardModule(miniRoleCombat, 'role_combat', ['mini'])
