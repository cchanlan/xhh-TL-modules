/**
 * 原神「深渊系」功能（全部深渊 / 深渊配队 / 危战配队 / 角色持有率）的共享辅助函数。
 * 这些函数原先在各 app 里逐字重复，抽到这里统一维护。
 */

import path from 'path'
import { Character, MysApi, Player } from '../../miao-plugin/models/index.js'
import { prepareMysContext } from './runtimePatch.js'
import { toFileUrl, pickRoleCombatBgImage, pluginDir } from './pluginConfig.js'

// miao 的立绘资源目录：从插件目录往上推（<云崽根>/plugins/miao-plugin/resources），
// 不用 process.cwd() —— 那个跟着启动目录走，脱机测试或从别的目录起进程时会指错。
const miaoRes = path.join(pluginDir, '..', 'miao-plugin', 'resources')

/** 解析被 @ 的 QQ（排除 bot 自身） */
export function resolveTargetQq(e) {
  const selfId = String(e.self_id || e.bot?.uin || (typeof Bot !== 'undefined' ? Bot.uin : '') || '')
  if (e?.at && String(e.at) !== selfId) return String(e.at)
  for (const msg of e?.message || []) {
    if (msg?.type === 'at' && String(msg.qq) !== selfId) return String(msg.qq)
  }
  return ''
}

/** 取群昵称 / 名片 */
export async function resolveDisplayName(e, qq) {
  const id = String(qq || '')
  if (!id) return ''
  let name = ''
  try {
    if (e.isGroup || e.group) {
      const member = e.group?.pickMember?.(id) || e.group?.pickMember?.(Number(id))
      if (member?.card || member?.nickname) name = member.card || member.nickname
      if (!name) {
        const bot = e.bot || (typeof Bot !== 'undefined' ? Bot : null)
        let info = null
        if (bot?.getGroupMemberInfo) {
          info = await bot.getGroupMemberInfo(String(e.group_id), id)
        } else if (bot?.sendApi) {
          const res = await bot.sendApi('get_group_member_info', {
            group_id: String(e.group_id),
            user_id: id,
          })
          info = res?.data || res
        }
        if (info?.card || info?.nickname) name = info.card || info.nickname
      }
    }
  } catch (_) {}
  if (!name) {
    const s = e.sender || {}
    if (String(e.user_id) === id) {
      name = (s.card && String(s.card).length < 20 ? s.card : '') || s.nickname || id
    } else {
      name = id
    }
  }
  return String(name)
}

/** 把 miao-plugin 相对路径的头像转成可渲染的 file URL */
export function faceUrl(face) {
  if (!face) return ''
  if (/^https?:\/\//i.test(face) || face.startsWith('file://') || face.startsWith('base64://')) return face
  const rel = String(face).replace(/^[/\\]+/, '')
  return toFileUrl(path.join(miaoRes, rel))
}

/**
 * 挑一张原神背景图：从 role_combat_bg_folder 随机抽，用 gs 角色名过滤子目录。
 * @param {string} logTag 日志标记
 */
export function pickGsBgImage(logTag = 'xhh-TL') {
  const gsNames = new Set()
  try {
    Character.forEach((char) => {
      if (char?.game === 'gs' && char.name) gsNames.add(char.name)
      return true
    }, 'release', 'gs')
  } catch (_) {}
  return pickRoleCombatBgImage({
    logTag,
    filterDir: gsNames.size ? (name) => gsNames.has(name) : null,
  })
}

/**
 * 取本人角色面板数据（需绑定 CK）。无 CK 或失败时返回空。
 * @param {object} e 事件
 * @param {object} [opts]
 * @param {boolean} [opts.talent] 是否一并刷新天赋（配队按练度排序时需要）
 * @param {string} [opts.logTag] 日志标记
 * @returns {Promise<{ hasCk: boolean, avatarData: Record<string, object> }>}
 *   avatarData 为 { 角色id: 面板对象 } 映射
 */
export async function loadAvatarData(e, { talent = false, logTag = 'xhh-TL' } = {}) {
  const avatarData = {}
  let hasCk = false
  try {
    await prepareMysContext(e, 'gs')
    const mys = await MysApi.init(e, 'cookie')
    if (mys && (await mys.checkCk())) {
      hasCk = true
      const player = Player.create(e)
      try {
        await player.refresh(talent ? { detail: 1, talent: 1 } : { detail: 1 })
      } catch (_) {
        if (talent) { try { await player.refreshTalent() } catch (_) {} }
      }
      const raw = player.getAvatarData() || {}
      if (Array.isArray(raw)) {
        for (const a of raw) if (a?.id) avatarData[String(a.id)] = a
      } else {
        for (const [k, v] of Object.entries(raw)) avatarData[String(k)] = v
      }
    }
  } catch (err) {
    logger.debug(`[${logTag}] 角色数据获取跳过:`, err?.message)
  }
  return { hasCk, avatarData }
}
