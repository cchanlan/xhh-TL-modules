/**
 * Alioth.wiki 数据层（https://alioth.wiki）
 *
 * 站点结构：Nuxt SSR，数据走 CDN JSON：
 *   索引 https://json.alioth.wiki/data/{game}/ch/{path}.json
 *   详情 https://json.alioth.wiki/data/{game}/ch/{path}/{id}.json
 *   game: gi（原神）/ hsr（星铁）；ch = 简中
 * 图片 https://img.alioth.wiki/{game}/...
 *
 * 索引统一长这样：
 *   Phases: [{ _id, Time, Ver, Name? }]  ← Time 是「2026/09/16 - 2026/10/16」或「2026/09」
 *   Index : { id: 在 Phases 里的下标 }
 *   Latest: 最新一期的完整详情（内嵌，省一次请求）
 *
 * 七个模式：
 *   gi  abyss（深境螺旋） / theater（幻想真境剧诗） / stygian（幽境危战）
 *   hsr chaos（混沌回忆） / fiction（虚构叙事） / as（末日幻影） / arbitration（异相仲裁）
 */
import fetch from 'node-fetch'
import moment from 'moment'

export const ALIOTH_DATA = 'https://json.alioth.wiki/data'
export const ALIOTH_IMG = 'https://img.alioth.wiki'

/** 模式表：key → { game, path, modeName } */
export const ALIOTH_MODES = {
  abyss: { game: 'gi', path: 'abyss', modeName: '深境螺旋' },
  theater: { game: 'gi', path: 'theater', modeName: '幻想真境剧诗' },
  stygian: { game: 'gi', path: 'stygian', modeName: '幽境危战' },
  chaos: { game: 'hsr', path: 'chaos', modeName: '混沌回忆' },
  fiction: { game: 'hsr', path: 'fiction', modeName: '虚构叙事' },
  as: { game: 'hsr', path: 'as', modeName: '末日幻影' },
  arbitration: { game: 'hsr', path: 'arbitration', modeName: '异相仲裁' },
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

async function fetchJson(url, timeout = 15000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*' },
    })
    if (!res.ok) return null
    const ct = String(res.headers.get('content-type') || '')
    // SPA fallback：不存在的资源会返回 index.html（HTTP 200）
    if (/text\/html/i.test(ct)) return null
    return await res.json()
  } catch (_) {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ---------------- 期数时间 ----------------

/**
 * Time 字段 → { begin, end, monthOnly }
 * - 「2026/09/16 - 2026/10/16」→ 精确到日
 * - 「2026/09」→ 整月（剧诗用月标期），end = 下月 1 日
 * 解析不出来时 begin/end 为 null。
 */
export function parsePhaseTime(t = '') {
  const s = String(t || '').trim()
  const parts = s.split(/\s*-\s*/).filter(Boolean)
  const one = (x) => {
    let m = String(x).match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/)
    if (m) return { d: moment(`${m[1]}-${m[2]}-${m[3]}`, 'YYYY-M-D'), monthOnly: false }
    m = String(x).match(/^(\d{4})\/(\d{1,2})$/)
    if (m) {
      const d = moment(`${m[1]}-${m[2]}-01`, 'YYYY-M-D')
      return { d, monthOnly: true }
    }
    return null
  }
  const a = one(parts[0])
  if (!a) return { begin: null, end: null, monthOnly: false, text: s }
  let end = null
  if (parts[1]) {
    const b = one(parts[1])
    if (b) end = b.d.clone()
  }
  if (!end) {
    // 整月：end = 下月 1 日
    end = a.d.clone().add(1, 'month')
  }
  return {
    begin: a.d.clone(),
    end,
    monthOnly: a.monthOnly && parts.length === 1,
    text: s,
  }
}

/**
 * 期数时间自愈
 *
 * alioth 的 stygian（幽境危战）把 id 7~10 的年份写成了 2025，实际是 2026：
 *   7  6.4  2026/03/04 - 2025/04/07   ← 结束早于开始
 *   8  6.5  2025/04/15 - 2025/05/19   ← 整条退了一年
 * 症状是期数列表里「上1期」的日期比「上10期」还晚、按月份查也会落空。
 *
 * 各模式的 id 都是时间升序（1 = 最早），所以按 id 串一遍：
 * **开始时间早于上一期的开始时间**就整条 +1 年。
 * ⚠️ 判据只能用 begin 对 begin —— 混沌回忆的期与期本来就允许重叠
 * （1009 结束 02/05，1010 从 01/22 就开始了），拿 begin 比上一期 end 会把
 * 一整串正常期数全部推后一年。数据正常时这里什么都不改。
 */
function repairPhaseTimes(list = []) {
  const byId = list.slice().sort((a, b) => Number(a._id) - Number(b._id))
  let prevBegin = null
  for (const p of byId) {
    if (!p._begin || !p._end) continue
    let guard = 0
    while (prevBegin && p._begin.isBefore(prevBegin) && guard++ < 5) {
      p._begin.add(1, 'year')
      p._end.add(1, 'year')
    }
    if (p._end.isBefore(p._begin)) p._end.add(1, 'year')
    prevBegin = p._begin
  }
}

/**
 * 给 Phases 每项补上 begin/end（moment）与下标
 * ⚠️ alioth 的 Phases 是「新的在前」，这里统一按时间升序重排 ——
 * 期数列表要往「更早」的方向走，顺序反了会把下期当成上期显示。
 */
export function decoratePhases(phases = []) {
  const list = (Array.isArray(phases) ? phases : []).map((p) => {
    const t = parsePhaseTime(p.Time)
    return { ...p, _begin: t.begin, _end: t.end, _monthOnly: t.monthOnly, _timeText: t.text }
  })
  repairPhaseTimes(list)
  list.sort((a, b) => {
    if (!a._begin) return -1
    if (!b._begin) return 1
    return a._begin.valueOf() - b._begin.valueOf()
  })
  list.forEach((p, i) => {
    p._i = i
  })
  return list
}

/** 今天落在哪一期（多期重叠取最后一项）；没有命中则取最近已开始的一期 */
export function pickLiveIndex(list = []) {
  const now = moment()
  let active = -1
  let started = -1
  for (let i = 0; i < list.length; i++) {
    const b = list[i]._begin
    const e = list[i]._end
    if (!b || !e) continue
    if (!b.isAfter(now)) started = i
    if (!b.isAfter(now) && !e.isBefore(now)) active = i
  }
  if (active >= 0) return active
  if (started >= 0) return started
  return list.length - 1
}

/** 时间上排在基准之后最近的一期（不是下标 +1） */
export function pickNextIndex(list = [], baseIdx = 0) {
  const base = list[baseIdx]
  if (!base?._begin) return -1
  let best = -1
  let bestBegin = null
  for (let i = 0; i < list.length; i++) {
    if (i === baseIdx) continue
    const b = list[i]._begin
    if (!b || !b.isAfter(base._begin)) continue
    if (!bestBegin || b.isBefore(bestBegin)) {
      bestBegin = b
      best = i
    }
  }
  return best
}

/**
 * 按月份定位：覆盖该月天数最多的一期（并列取较晚开始的）。
 * @param {string} yyyymm 形如 '202609'
 */
export function findIndexByMonth(list = [], yyyymm = '') {
  const m = String(yyyymm || '').match(/^(\d{4})(\d{2})$/)
  if (!m) return -1
  const monthStart = moment(`${m[1]}-${m[2]}-01`, 'YYYY-M-D')
  if (!monthStart.isValid()) return -1
  const monthEnd = monthStart.clone().add(1, 'month')
  let best = -1
  let bestDays = -1
  let bestBegin = null
  for (let i = 0; i < list.length; i++) {
    const b = list[i]._begin
    const e = list[i]._end
    if (!b || !e) continue
    const s = b.isAfter(monthStart) ? b : monthStart
    const en = e.isBefore(monthEnd) ? e : monthEnd
    const days = en.diff(s, 'minutes')
    if (days <= 0) continue
    if (days > bestDays || (days === bestDays && b.isAfter(bestBegin))) {
      bestDays = days
      best = i
      bestBegin = b
    }
  }
  return best
}

// ---------------- 请求（带缓存） ----------------

const indexCache = new Map()
const INDEX_TTL = 10 * 60 * 1000
const phaseCache = new Map()
const PHASE_TTL = 30 * 60 * 1000
const MAX_PHASE_CACHE = 8

function modeOf(key) {
  const m = ALIOTH_MODES[key]
  if (!m) throw new Error(`未知的 alioth 模式：${key}`)
  return m
}

/**
 * 取索引：{ phases（已装饰）, byId, latest, hp }
 */
export async function fetchIndex(key) {
  const hit = indexCache.get(key)
  if (hit && Date.now() - hit.at < INDEX_TTL) return hit.data
  const m = modeOf(key)
  const raw = await fetchJson(`${ALIOTH_DATA}/${m.game}/ch/${m.path}.json`)
  if (!raw || !Array.isArray(raw.Phases)) throw new Error(`alioth ${m.modeName} 索引不可用`)
  const phases = decoratePhases(raw.Phases)
  const byId = new Map(phases.map((p) => [String(p._id), p]))
  const data = { phases, byId, latest: raw.Latest || null, hp: raw.HP || null, mode: m }
  indexCache.set(key, { at: Date.now(), data })
  return data
}

/** 取某一期详情；id 省略时取索引里 Latest 的那一期 */
export async function fetchPhase(key, id) {
  const m = modeOf(key)
  const ck = `${key}:${id}`
  const hit = phaseCache.get(ck)
  if (hit && Date.now() - hit.at < PHASE_TTL) return hit.data
  const data = await fetchJson(`${ALIOTH_DATA}/${m.game}/ch/${m.path}/${id}.json`, 25000)
  if (!data) throw new Error(`alioth ${m.modeName} 第 ${id} 期数据不可用`)
  if (phaseCache.size >= MAX_PHASE_CACHE) {
    phaseCache.delete(phaseCache.keys().next().value)
  }
  phaseCache.set(ck, { at: Date.now(), data })
  return data
}

// ---------------- 资源 / 文本 ----------------

/**
 * 怪物图标（小图）
 * - 原神：Icon 是「UI_MonsterIcon_xxx」→ /gi/MonsterIcon/xxx.png
 * - 星铁：Icon 自带子目录「mostericon/Monster_xxx.png」（站点拼写就是 mostericon）
 */
export function monsterIconUrl(game, icon) {
  if (!icon) return ''
  if (/^https?:/.test(icon)) return icon
  if (game === 'hsr') return `${ALIOTH_IMG}/sr/${icon}`
  return `${ALIOTH_IMG}/gi/MonsterIcon/${icon}.png`
}

/** 危战立绘（大图） */
export function leylineArtUrl(icon) {
  if (!icon) return ''
  if (/^https?:/.test(icon)) return icon
  return `${ALIOTH_IMG}/gi/LeyLineChallenge/${icon}.png`
}

/**
 * 原神全量怪物表（id → { Name, Icon, Color, HP }）
 * 剧诗详情只给 id→图标，没有名字，得靠这张表补。
 */
let _giMonDb = null
export async function giMonsterDb() {
  if (_giMonDb && Date.now() - _giMonDb.at < 6 * 3600 * 1000) return _giMonDb.map
  const raw = await fetchJson(`${ALIOTH_DATA}/gi/ch/monster.json`, 25000).catch(() => null)
  const map = new Map(Object.entries(raw?.Templates || {}))
  _giMonDb = { at: Date.now(), map }
  return map
}

/** 元素名 → 中文 */
export const ELEM_CN = {
  Phys: '物理',
  Fire: '火',
  Water: '水',
  Grass: '草',
  Elec: '雷',
  Wind: '风',
  Ice: '冰',
  Rock: '岩',
  Physical: '物理',
  Quantum: '量子',
  Imaginary: '虚数',
}

/** 元素名 → 主题 class（与原模板一致） */
export const ELEM_CLASS = {
  Phys: 'physical',
  Fire: 'pyro',
  Water: 'hydro',
  Grass: 'dendro',
  Elec: 'electro',
  Wind: 'anemo',
  Ice: 'cryo',
  Rock: 'geo',
  Physical: 'physical',
  Quantum: 'quantum',
  Imaginary: 'imaginary',
}

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * alioth 富文本 → HTML
 * - <color style='...'>x</color> → 高亮 span（站点用 CSS 变量，这里落成固定色）
 * - <br> / \n → <br>
 * - @120%# → 高亮数值（Guides 的 DescList 用这个标关键数值）
 * - 内嵌 <img ...> 一律丢掉（机制描述里混着图标，出图不需要）
 */
export function aliothRich(s = '') {
  let raw = String(s || '')
  if (!raw) return ''
  raw = raw.replace(/<img[^>]*>/gi, '')
  raw = raw.replace(/<color[^>]*>/gi, '<span class="ley-hl">').replace(/<\/color>/gi, '</span>')
  raw = raw.replace(/@([^@#]{1,40})#/g, '<span class="ley-hl">$1</span>')
  raw = raw.replace(/\\n/g, '\n')
  const parts = raw.split(/(<span class="ley-hl">[\s\S]*?<\/span>|<br\s*\/?>)/gi)
  return parts
    .map((seg) => {
      if (!seg) return ''
      if (/^<span class="ley-hl">/i.test(seg)) return seg
      if (/^<br/i.test(seg)) return '<br>'
      return escapeHtml(seg)
    })
    .join('')
    .replace(/\n/g, '<br>')
}

/** alioth 富文本 → 纯文本（列表/标题用） */
export function aliothText(s = '') {
  return String(s || '')
    .replace(/<img[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?color[^>]*>/gi, '')
    .replace(/@([^@#]{1,40})#/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** HP 千分位 */
export function fmtHp(hp) {
  const n = Math.round(Number(hp) || 0)
  if (!n) return '-'
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export default {
  ALIOTH_DATA,
  ALIOTH_IMG,
  ALIOTH_MODES,
  parsePhaseTime,
  decoratePhases,
  pickLiveIndex,
  pickNextIndex,
  findIndexByMonth,
  fetchIndex,
  fetchPhase,
  monsterIconUrl,
  leylineArtUrl,
  ELEM_CN,
  ELEM_CLASS,
  aliothRich,
  aliothText,
  fmtHp,
}
