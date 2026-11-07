/**
 * 全部深渊功能：混沌回忆、虚构叙事、末日幻影三合一渲染
 * 使用方法：发送 *全部深渊 或 深渊总览 等指令
 * 兼容：原版 miao-plugin 和 ccxhan 分支版本
 */

import moment from 'moment';
import lodash from 'lodash';

import { prepareMysContext } from '../utils/runtimePatch.js';
import { config, pluginDir } from '../utils/pluginConfig.js'
import { renderTpl } from '../utils/render.js'

// miao-plugin 模块（动态导入）
let MysApi, Player, Character, Common;
let miaoLoaded = false;

async function loadMiaoModules() {
  if (miaoLoaded) return true;
  try {
    const miaoModels = await import('../../miao-plugin/models/index.js');
    const miaoComponents = await import('../../miao-plugin/components/index.js');
    MysApi = miaoModels.MysApi;
    Player = miaoModels.Player;
    Character = miaoModels.Character;
    Common = miaoComponents.Common;
    miaoLoaded = true;
    return true;
  } catch (err) {
    console.error('[xhh-TL][allAbyss] 加载 miao-plugin 模块失败:', err);
    return false;
  }
}

/**
 * 兼容层：为原版 miao-plugin 补充星铁深渊 API
 * 原版只有 getSpiralAbyss，分支版本有 getChallengeChaos/Story/Boss
 */
function ensureChallengeMethods(mysInstance) {
  if (!mysInstance) return mysInstance;

  // 如果分支版本已有这些方法，直接返回
  if (mysInstance.getChallengeChaos && mysInstance.getChallengeStory && mysInstance.getChallengeBoss && mysInstance.getChallengePeak) {
    return mysInstance;
  }

  // 为原版 miao-plugin 添加兼容方法
  if (!mysInstance.getChallengeChaos) {
    mysInstance.getChallengeChaos = async function(type = 1) {
      return await this.getData('spiralAbyss', { schedule_type: type });
    };
  }

  if (!mysInstance.getChallengeStory) {
    mysInstance.getChallengeStory = async function(type = 1) {
      return await this.getData('challengeStory', { schedule_type: type });
    };
  }

  if (!mysInstance.getChallengeBoss) {
    mysInstance.getChallengeBoss = async function(type = 1) {
      return await this.getData('challengeBoss', { schedule_type: type });
    };
  }

  if (!mysInstance.getChallengePeak) {
    mysInstance.getChallengePeak = async function(type = 1) {
      return await this.getData('challengePeak', { schedule_type: type === 2 ? 3 : 1 });
    };
  }

  // 原版 miao-plugin 可能没有 checkCk 方法
  if (!mysInstance.checkCk) {
    mysInstance.checkCk = async function() {
      try {
        return !!(this.ck || this.ckInfo?.ck);
      } catch (_) {
        return false;
      }
    };
  }

  return mysInstance;
}

// 元素图标映射
function elemIcon(element) {
  const elemMap = {
    physical: 'elem-phy',
    fire: 'elem-fire',
    ice: 'elm-ice',
    lightning: 'elem-elec',
    wind: 'elem-wind',
    quantum: 'elem-auantum',
    imaginary: 'elem-imaginary'
  };
  return elemMap[element] ? `meta-sr/public/icons/${elemMap[element]}.webp` : '';
}

// 时间格式化
function timeCalc(t) {
  if (!t) return '';
  const date = `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
  return `${date} ${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}

// 格子里的时间省掉年份：格宽就那么点，年份每格都一样，留着只会把标题挤没
function shortTime(t) {
  if (!t) return '';
  return `${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')} ${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}

// 处理深渊数据
function processChallengeData(res, tag, type) {
  if (!res || typeof res !== 'object') return null;

  const isStory = tag === 'story';
  const isBoss = tag === 'boss';
  const toNum = val => Number(val) || 0;

  let floors = Array.isArray(res?.all_floor_detail) ? res.all_floor_detail : [];
  logger.info(`[xhh-TL][allAbyss] ${tag} 原始楼层数据: ${floors.length} 个, 楼层: ${floors.map(f => f?.floor || f?.name || '未知').join(', ')}`);

  // 先滤掉没打的关卡（node 全空 / 快速通关的旧记录）
  if (tag === 'chaos' || tag === 'story') {
    floors = floors.filter(f => !f?.is_fast && (f?.node_1 || f?.node_2 || f?.node_3));
  } else if (tag === 'boss') {
    floors = floors.filter(f => !f?.is_fast && (f?.node_1?.avatars?.length || f?.node_2?.avatars?.length || f?.node_3?.avatars?.length));
  }

  // 只留账号打到的最高难度：接口的 all_floor_detail 按难度降序（十二层→一层、难度04→01），
  // 滤掉没打的后取首个即可。层数/难度写死在代码里迟早会过期，按接口顺序取才跟得上版本。
  floors = floors.slice(0, 1);

  if (floors.length === 0) return null;

  const normalizeNode = (node) => {
    if (!node) return null;
    const avatars = lodash.map(Array.isArray(node.avatars) ? node.avatars : [], a => {
      if (!a?.id) return a;
      const char = Character.get(a.id, true);
      if (char) {
        a.name = a.name || char.name;
        a.abbr = a.abbr || char.abbr;
      }
      return a;
    });
    return { ...node, avatars, score: node.score || 0, time: shortTime(node.challenge_time) };
  };

  let group;
  if (tag === 'story') {
    group = res?.groups?.[type - 1];
  } else if (tag === 'boss') {
    group = res?.groups?.[0];
  } else {
    group = res?.groups?.[type - 1];
  }

  return {
    group: group || {},
    battleNum: res?.battle_num,
    totalStar: toNum(res?.star_num),
    extraStar: toNum(res?.extra_star_num),
    totalScore: res?.score || 0,
    bestFloor: res?.max_floor,
    floors: lodash.map(floors, floor => {
      const node1 = normalizeNode(floor?.node_1);
      const node2 = normalizeNode(floor?.node_2);
      const node3 = normalizeNode(floor?.node_3);
      const isFast = floor?.is_fast;
      const extraStar = toNum(floor?.extra_star_num);
      const score = isStory && isFast ? 0 : toNum(node1?.score) + toNum(node2?.score) + toNum(node3?.score);
      const star = toNum(floor?.star_num);
      return {
        ...floor,
        name: floor?.name || (tag === 'chaos' ? '混沌回忆' : tag === 'story' ? '虚构叙事' : '末日幻影'),
        star: Math.max(0, star - extraStar),
        extraStar,
        score,
        roundNum: isStory && isFast ? 0 : floor?.round_num,
        isFast,
        node1,
        node2,
        node3
      };
    })
  };
}

// 处理异相仲裁数据
function processPeakData(res) {
  if (!res || typeof res !== 'object') return null;

  const record = res?.challenge_peak_records?.[0];
  if (!record?.has_challenge_record) return null;

  const recordBrief = res?.challenge_peak_best_record_brief || {};
  const bossInfo = record?.boss_info || {};
  const bossRecord = record?.boss_record || {};
  const mobInfos = record?.mob_infos || [];
  const mobRecords = record?.mob_records || [];

  const normalizeAvatars = (avatars) => {
    if (!avatars) return [];
    return lodash.map(avatars, a => {
      const char = Character.get(a.id, true);
      if (char) {
        a.name = a.name || char.name;
        a.abbr = a.abbr || char.abbr;
      }
      return a;
    });
  };

  return {
    nickname: res?.role?.nickname || '',
    // 接口给的怪物名在 name_mi18n，绝境前缀在 hard_mode_name_mi18n（形如「将杀王棋•绝境」）
    bossName: bossInfo.hard_mode_name_mi18n || bossInfo.name_mi18n || bossInfo.name || '将杀王棋',
    bossIcon: bossInfo.icon || '',
    bossStars: bossRecord?.star_num || 0,
    mobStars: recordBrief.mob_stars || 0,
    totalStars: (bossRecord?.star_num || 0) + (recordBrief.mob_stars || 0),
    bossRound: bossRecord?.round_num || 0,
    bossAvatars: normalizeAvatars(bossRecord?.avatars),
    bossBuff: pickBuff(bossRecord),
    battleNum: record?.battle_num || 0,
    group: record?.group || {},
    mobs: mobInfos.map((info, idx) => {
      const mobRecord = mobRecords[idx] || {};
      return {
        index: idx + 1,
        name: info.name || `关卡${idx + 1}`,
        monsterName: info.monster_name || '',
        icon: info.icon || info.monster_icon || '',
        round: mobRecord?.round_num || 0,
        stars: mobRecord?.star_num || 0,
        avatars: normalizeAvatars(mobRecord?.avatars)
      };
    })
  };
}

/* ============ 模块网格：把四个模式归一化成同尺寸的战绩格 ============
 * 桌面版排版是「12 栅格 + 每格 span 3」的模块网格：
 * 一行固定 4 格，格子上下左右都落在同一套网格线上。
 * 每个模式的格数补齐到 4 的倍数（不足的用 filler 信息格填），
 * 这样任何数据量下都不会出现半空的一行。
 */
const GRID_COLS = 4

// 关卡名去掉「星启模式」后缀，后缀单独做角标
function splitFloorName(raw) {
  const name = String(raw || '')
  const m = name.match(/^(.*?)(星启模式)$/)
  return m ? { name: m[1], starMode: true } : { name, starMode: false }
}

function pickBuff(node) {
  const buff = node?.buff || node?.maze_buff || (Array.isArray(node?.buff_list) ? node.buff_list[0] : null)
  if (!buff) return null
  return {
    icon: buff.icon || '',
    name: buff.name_mi18n || buff.name || '关卡效果',
    desc: buff.desc_mi18n || buff.desc || ''
  }
}

// 一个模式的战绩格：来自 floors[].node1/2/3
function tilesFromFloors(data) {
  const tiles = []
  lodash.forEach(data?.floors || [], floor => {
    const { name, starMode } = splitFloorName(floor?.name)
    const nodes = [floor?.node1, floor?.node2, floor?.node3]
    const valid = nodes.filter(n => n?.avatars?.length)
    lodash.forEach(valid, (node, idx) => {
      tiles.push({
        floorName: name,
        starMode,
        floorStar: Number(floor?.star) || 0,
        floorExtraStar: Number(floor?.extraStar) || 0,
        nodeLabel: `节点${nodes.indexOf(node) + 1}`,
        first: idx === 0,
        nodeCount: valid.length,
        round: floor?.roundNum,
        isFast: !!floor?.isFast,
        score: Number(node?.score) || 0,
        time: node?.time || '',
        avatars: node.avatars,
        buff: pickBuff(node)
      })
    })
  })
  return tiles
}

// 异相仲裁：Boss 一格 + 每个精英怪一格
function tilesFromPeak(peak) {
  if (!peak) return []
  const tiles = []
  if (peak.bossAvatars?.length) {
    tiles.push({
      floorName: peak.bossName || '将杀王棋',
      starMode: false,
      floorStar: Number(peak.bossStars) || 0,
      floorExtraStar: 0,
      nodeLabel: 'Boss',
      first: true,
      nodeCount: 1,
      round: peak.bossRound,
      score: 0,
      time: '',
      avatars: peak.bossAvatars,
      buff: null
    })
  }
  lodash.forEach(peak.mobs || [], mob => {
    if (!mob?.avatars?.length) return
    tiles.push({
      floorName: mob.name,
      starMode: false,
      floorStar: Number(mob.stars) || 0,
      floorExtraStar: 0,
      nodeLabel: `关卡${mob.index}`,
      first: true,
      nodeCount: 1,
      round: mob.round,
      score: 0,
      time: '',
      avatars: mob.avatars,
      buff: null
    })
  })
  return tiles
}

// 出场角色统计：填充格用，顺带能看出这期主力
function countAvatars(tiles, avatarData) {
  const hit = {}
  lodash.forEach(tiles, t => lodash.forEach(t.avatars || [], a => {
    if (!a?.id) return
    hit[a.id] = hit[a.id] || { id: a.id, n: 0 }
    hit[a.id].n += 1
  }))
  return lodash.orderBy(Object.values(hit), ['n'], ['desc']).slice(0, 10).map(x => {
    const av = avatarData?.[x.id]
    return { id: x.id, n: x.n, face: av?.face || '', name: av?.abbr || av?.name || '', star: av?.star || 5 }
  })
}

// 战绩清单：每场一行（关卡 / 节点 / 星数 / 分数），行数跟着场数走，能把填充格撑满
function floorSummary(sec) {
  let last = ''
  return lodash.map(sec.tiles, t => {
    const head = t.floorName !== last
    const row = {
      name: head ? t.floorName : '',
      node: t.nodeLabel,
      starMode: head && t.starMode,
      star: head ? t.floorStar : 0,
      extraStar: head ? t.floorExtraStar : 0,
      score: t.score || 0,
      time: t.time || (t.round != null ? `轮次 ${t.round}` : '')
    }
    last = t.floorName
    return row
  })
}

// 补齐到整行：不足的格子放信息卡（出场角色 / 战绩清单 / 本期节点 / 本期概况）
// 现在每个模式只渲染最高难度那一关，格子少，所以每段固定「1 张信息卡 + 3 个节点格」= 一整行
const FILLER_SEQ = {
  chaos: ['chars', 'period', 'floors'],
  boss: ['bosses', 'period', 'chars'],
  story: ['chars', 'period', 'floors'],
  peak: ['bossimg', 'period']
}
const FILLER_FALLBACK = ['chars', 'floors', 'period']

function makeFiller(kind, sec, avatarData) {
  if (kind === 'chars') {
    const chars = countAvatars(sec.tiles, avatarData)
    return chars.length ? { kind, title: '出场角色', chars } : null
  }
  if (kind === 'floors') {
    const floors = floorSummary(sec)
    return floors.length ? { kind, title: '战绩清单', floors, showScore: floors.some(f => f.score > 0) } : null
  }
  if (kind === 'bosses') {
    return sec.bosses?.length ? { kind, title: '本期节点', bosses: sec.bosses } : null
  }
  if (kind === 'bossimg') {
    return sec.bossImg ? { kind, title: '本期 Boss', img: sec.bossImg, name: sec.best, star: sec.bossStars } : null
  }
  if (kind === 'period') {
    return {
      kind,
      title: '本期概况',
      period: sec.period,
      star: sec.star,
      extraStar: sec.extraStar,
      rows: lodash.compact([
        sec.best ? { k: '最高关卡', v: sec.best } : null,
        sec.battle != null ? { k: '挑战次数', v: `${sec.battle} 次` } : null,
        sec.totalScore ? { k: '总分', v: String(sec.totalScore) } : null,
        { k: '关卡 / 场次', v: `${sec.floorCount} 关 · ${sec.tiles.length} 场` },
        ...(sec.extraRows || [])
      ])
    }
  }
  return null
}

function buildFillers(sec, need, avatarData) {
  if (need <= 0) return []
  const seq = FILLER_SEQ[sec.key] || []
  // breakRow 的模式（异相仲裁）只用指定的那几张卡，宁可留白也不塞别的
  const order = sec.breakRow ? seq : lodash.uniq([...seq, ...FILLER_FALLBACK])
  const out = []
  for (const kind of order) {
    if (out.length >= need) break
    const f = makeFiller(kind, sec, avatarData)
    if (f) out.push(f)
  }
  // 种类不够就让排版用透明占位补，别把同一张卡印两遍
  return out
}

/* 按行铺格：每行 cols 格，规则是「信息卡靠左、战绩格靠右」
 * 第一行 = 指定的信息卡 + 最高难度那一关的各节点（不满就继续补信息卡）
 * 之后   = 剩下的信息卡 + 其余关卡的节点连续排
 * 异相仲裁例外（主人指定）：第一行 = Boss 图 + Boss 战绩 + 本期概况（各占一格），
 * 精英关另起一行、平分整行宽度。
 */
const SPAN_TOTAL = 12
const SPAN_BY_COUNT = { 1: 12, 2: 6, 3: 4, 4: 3, 6: 2 }

function layoutItems(sec, cols) {
  const groups = []
  lodash.forEach(sec.tiles, t => {
    const g = groups.find(x => x.name === t.floorName)
    if (g) g.list.push(t)
    else groups.push({ name: t.floorName, list: [t] })
  })
  const unit = Math.round(SPAN_TOTAL / cols)
  const fq = [...(sec.fillers || [])]
  const items = []
  const gap = span => items.push({ gap: true, span })

  if (sec.breakRow) {
    // 第一行：Boss 图 + Boss 战绩 + 补齐的信息卡，三格各 span 4 平分整行
    const row1 = []
    if (fq.length) row1.push({ filler: fq.shift(), span: 4 })
    lodash.forEach(groups[0]?.list || [], t => row1.push({ tile: t, span: 4 }))
    while (fq.length) row1.push({ filler: fq.shift(), span: 4 })
    items.push(...row1)
    for (let k = row1.length; k < 3; k++) gap(4)
    // 其余关卡：一行一行铺，每行的格子平分整行宽度
    const rest = lodash.flatten(groups.slice(1).map(g => g.list))
    for (let i = 0; i < rest.length; i += cols) {
      const row = rest.slice(i, i + cols)
      const span = SPAN_BY_COUNT[row.length] || 4
      lodash.forEach(row, t => items.push({ tile: t, span }))
      if (!SPAN_BY_COUNT[row.length]) {
        for (let k = row.length; k < cols; k++) gap(span)
      }
    }
    return items
  }

  if (fq.length) items.push({ filler: fq.shift(), span: unit })
  lodash.forEach(groups[0]?.list || [], t => items.push({ tile: t, span: unit }))
  while (items.length % cols !== 0 && fq.length) items.push({ filler: fq.shift(), span: unit })
  while (fq.length) items.push({ filler: fq.shift(), span: unit })
  lodash.forEach(lodash.flatten(groups.slice(1).map(g => g.list)), t => items.push({ tile: t, span: unit }))
  // 信息卡种类不够时最后一行用透明占位补齐，别让整行只填一半
  while (items.length % cols !== 0) gap(unit)
  return items
}

// 每个模式要几张信息卡：第一行按「信息卡 + 首关节点」凑整，其余节点再单独凑整
function fillerNeed(sec, cols) {
  if (sec.breakRow) return (FILLER_SEQ[sec.key] || []).length
  const firstLen = sec.tiles.filter(t => t.floorName === sec.tiles[0]?.floorName).length
  const restLen = sec.tiles.length - firstLen
  const head = (cols - ((1 + firstLen) % cols)) % cols
  const tail = (cols - (restLen % cols)) % cols
  return 1 + head + tail
}

function buildSections({ chaosData, bossData, storyData, peakData, avatarData }) {
  const raw = [
    { key: 'chaos', name: '忘却之庭', sub: '混沌回忆', data: chaosData },
    { key: 'boss', name: '末日幻影', sub: '末日幻影', data: bossData },
    { key: 'story', name: '虚构叙事', sub: '虚构叙事', data: storyData },
    { key: 'peak', name: '异相仲裁', sub: '异相仲裁', data: peakData }
  ]
  const sections = []
  for (const item of raw) {
    if (!item.data) continue
    const isPeak = item.key === 'peak'
    const tiles = isPeak ? tilesFromPeak(item.data) : tilesFromFloors(item.data)
    if (!tiles.length) continue
    const group = item.data?.group || {}
    const bosses = lodash.compact([
      group.upper_boss && { label: '节点1', icon: group.upper_boss.icon },
      group.lower_boss && { label: '节点2', icon: group.lower_boss.icon },
      group.tierce_boss && { label: '节点3', icon: group.tierce_boss.icon }
    ])
    const firstFloor = tiles[0]?.floorName
    sections.push({
      key: item.key,
      name: item.name,
      sub: item.sub,
      tiles,
      hasBuff: tiles.some(t => t.buff),
      star: isPeak ? (Number(item.data.totalStars) || 0) : (Number(item.data.totalStar) || 0),
      extraStar: isPeak ? 0 : (Number(item.data.extraStar) || 0),
      best: isPeak ? (item.data.bossName || '') : (item.data.bestFloor || ''),
      battle: isPeak ? null : item.data.battleNum,
      // 总分只算最高难度那一关，把低难度的旧场次也加进来没意义
      totalScore: isPeak ? 0 : lodash.sumBy(tiles.filter(t => t.floorName === firstFloor), t => t.score || 0),
      floorCount: isPeak ? tiles.length : (item.data.floors?.length || 0),
      bosses: isPeak ? [] : bosses,
      bossImg: isPeak ? (item.data.bossIcon || '') : '',
      bossStars: isPeak ? (Number(item.data.bossStars) || 0) : 0,
      // 异相仲裁：Boss 关和精英关分行放，空位用占位格
      breakRow: isPeak,
      period: `${timeCalc(group.begin_time)} - ${timeCalc(group.end_time)}`,
      extraRows: isPeak ? lodash.compact([
        item.data.bossStars ? { k: 'Boss 星数', v: `×${item.data.bossStars}` } : null,
        item.data.mobStars ? { k: '精英星数', v: `×${item.data.mobStars}` } : null
      ]) : []
    })
  }
  // 列数固定：每段就是「1 张信息卡 + 最高关卡的那几个节点」，一行 4 格正好铺满。
  // 不跟着数据量缩列——现在每段最多 4 个战绩格，缩列只会把一段拆成两行。
  const cols = GRID_COLS
  for (const sec of sections) {
    sec.fillers = buildFillers(sec, fillerNeed(sec, cols), avatarData)
    sec.items = layoutItems(sec, cols)
  }
  return { sections, cols }
}

/**
 * 遍历四个模式里所有会出现在模板上的角色，逐个回调。
 *
 * 这是 role 数据的唯一收集入口：模板每个节点（含 node3）都会渲染角色卡，
 * 这里漏收一个，那张卡的天赋、光锥、遗器就会整片变成「暂无数据」。
 * 模板改了节点结构，这里必须跟着改。
 */
function eachAbyssAvatar({ chaosData, storyData, bossData, peakData }, fn) {
  const eachFloors = (floors) => {
    lodash.forEach(floors || [], floor => {
      lodash.forEach([floor?.node1, floor?.node2, floor?.node3], node => {
        if (node?.avatars) lodash.forEach(node.avatars, fn);
      });
    });
  };
  eachFloors(chaosData?.floors);
  eachFloors(storyData?.floors);
  eachFloors(bossData?.floors);
  lodash.forEach(peakData?.bossAvatars, fn);
  lodash.forEach(peakData?.mobs, mob => lodash.forEach(mob?.avatars, fn));
}

// 处理开拓者ID兼容
function matchTrailblazerId(playerAvatarIds, apiId) {
  let id = apiId * 1;
  let baseId = id % 2 === 0 ? id - 1 : id;
  return [baseId, baseId + 1].find(i => playerAvatarIds.includes(i + "")) || apiId;
}

// 全部深渊功能：混沌、虚构、末日、异相四合一
export async function allAbyss(e) {
    try {
      // 锅巴开关：关闭则不响应（与 gsAllAbyss/hardTeam/holdRate 一致）
      if (config().all_abyss === false) return false;

      // 加载 miao-plugin 模块
      const loaded = await loadMiaoModules();
      if (!loaded || !MysApi || !Common) {
        e.reply('已知问题，稍后重试');
        return false;
      }

      // 初始化 MysApi
      e.isSr = true;
      await prepareMysContext(e, 'sr');
      let mys = await MysApi.init(e, 'all');
      if (!mys || !await mys.checkCk()) {
        e.reply(mys ? `UID: ${mys.uid} Cookie 失效，请【#刷新ck】，仍不行则【#扫码登录】` : '请先【#扫码登录】或绑定 CK 后再使用 *全部深渊');
        return false;
      }

      // 兼容原版 miao-plugin（补充星铁深渊 API）
      mys = ensureChallengeMethods(mys);

      const uid = mys.uid;
      const type = /上期/.test(e.original_msg || e.msg || '') ? 2 : 1;
      const player = Player.create(e);

      // 从锅巴配置读取渲染模式
      const renderMode = config().all_abyss_render_mode || 'desktop';
      const isMobile = renderMode === 'mobile';
      // 获取背景图路径
      const msg = e.original_msg || e.msg || '';
      const bgImageMatch = msg.match(/背景[：:]?\s*(.+)/);
      const bgImage = bgImageMatch ? bgImageMatch[1].trim() : '';

      // 获取四个深渊模式的数据
      let chaosRes, storyRes, bossRes, peakRes;
      try {
        [chaosRes, storyRes, bossRes, peakRes] = await Promise.all([
          mys.getChallengeChaos(type),
          mys.getChallengeStory(type),
          mys.getChallengeBoss(type),
          mys.getChallengePeak(type)
        ]);
      } catch (err) {
        logger.error('[xhh-TL][allAbyss] 获取深渊数据失败:', err);
        e.reply('获取深渊数据失败，请稍后重试');
        return false;
      }

      // 处理混沌回忆数据
      const chaosData = processChallengeData(chaosRes, 'chaos', type);
      // 处理虚构叙事数据
      const storyData = processChallengeData(storyRes, 'story', type);
      // 处理末日幻影数据
      const bossData = processChallengeData(bossRes, 'boss', type);
      // 处理异相仲裁数据
      const peakData = processPeakData(peakRes);

      // 检查是否有数据
      if (!chaosData && !storyData && !bossData && !peakData) {
        e.reply(`暂未获得${type === 2 ? '上期' : '本期'}深渊挑战数据...`);
        return false;
      }

      // 收集所有角色ID
      const avatarIds = [];
      const playerAvatarIds = player.getAvatarIds();
      const addAvatarId = (a) => {
        if (!a?.id) return a;
        // 开拓者 id 跟着命途走（8001~8010），对齐账号实际拥有的那个
        if (a.id > 8000) a.id = matchTrailblazerId(playerAvatarIds, a.id);
        if (!avatarIds.includes(a.id)) avatarIds.push(a.id);
        const char = Character.get(a.id, true);
        if (char) {
          a.name = a.name || char.name;
          a.abbr = a.abbr || char.abbr;
        }
        return a;
      };
      eachAbyssAvatar({ chaosData, storyData, bossData, peakData }, addAvatarId);

      // 刷新角色天赋
      try {
        if (!mys.isSelfCookie) {
          const _mys = await MysApi.init(e, 'cookie');
          if (_mys && await _mys.checkCk()) {
            await player.refreshProfile(2, true);
          }
        } else {
          await player.refreshProfile(2, true);
        }
        await player.refreshTalent(avatarIds);
      } catch (err) {
        logger.debug('[xhh-TL][allAbyss] 刷新角色信息失败:', err.message);
      }

      const avatarData = player.getAvatarData(avatarIds);
      lodash.forEach(avatarData, (av) => {
        if (!av?.talent) return;
        av.talentCount = Object.keys(av.talent).length;
        lodash.forEach(av.talent, (t, key) => {
          const talentMaxMap = { a: 7, e: 12, q: 12, t: 12, me: 7, mt: 7, j: 12 };
          t.max = talentMaxMap[key] || 12;
        });
      });

      // 使用三合一模板渲染。缩放走「根字号 + rem」（rem: true）——
      // transform/zoom 不计入 CSS 盒尺寸，外置渲染服务按盒裁图只会截到左上角一块；
      // 模板里所有尺寸都写成 rem，倍率就是唯一的缩放开关，渲染尺寸与盒尺寸一致。
      const templateName = isMobile ? 'all-abyss-mobile' : 'all-abyss';
      const tplFile = pluginDir + `/resources/${templateName}.html`;
      // 桌面版布局：整图 = body 左右 padding + 4 个模式框各自的左右 padding +
      // 4 个战绩格的宽度和 3 条间隙。宽度只跟列数有关（数据少时列数会降），跟模式数无关。
      const TILE_WIDTH = 364;
      const TILE_GAP = 8;
      const BODY_PADDING = 24 + 24; // body 左右各 12 + 每个模式框左右各 12
      const { sections, cols: gridCols } = buildSections({ chaosData, bossData, storyData, peakData, avatarData });
      const pageWidth = Math.round(
        BODY_PADDING + gridCols * TILE_WIDTH + Math.max(0, gridCols - 1) * TILE_GAP
      );
      const renderData = {
        chaosData,
        storyData,
        bossData,
        peakData,
        sections,
        gridCols,
        gridSpan: Math.round(12 / gridCols),
        tileGap: TILE_GAP,
        pageWidth,
        avatars: avatarData,
        save_id: uid,
        uid,
        type,
        nickname: player.name || '开拓者',
        mysFailed: false,
        Array: (num) => num ? Array(num) : [],
        elemIcon,
        timeCalc
      };
      return renderTpl(e, {
        tpl: templateName,
        tplFile,
        saveId: templateName,
        data: renderData,
        baseScale: isMobile ? 2.0 : 1.2,
        rem: true,
      });
    } catch (err) {
      console.error('[xhh-TL][allAbyss] error:', err);
      e.reply('深渊查询出现错误，请稍后重试');
      return false;
    }
}
