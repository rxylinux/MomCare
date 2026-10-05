// Phase E1 Step 2 计时工具 store（Pinia）：胎动连续计时 + 临产宫缩记录 + 511 辅助参考 + 就医电话联动。
// 读写经 sessionService.familyCall → mc-tools；本地持久化承载切后台/冷启动/断网不丢。
//
// 2026-10-01 R1 修复（A04–A08 + 审核第 4–9 条）：
// - 持久化真话：所有落盘消费逐键布尔结果——只有本地确实保存成功才允许 offline-pending；
//   失败保留内存草稿并暴露未保存状态（fetalUnsaved/contraUnsaved），绝不以"已暂存"遮掩。
//   多键部分成功不报全成功。
// - 终态耐久序（审核第 5 条）：finish/stop 离线归档时先把**终态重试副本（queue）落盘**，
//   耐久成功才清 active 键——queue 写失败则磁盘 active（含 journal/stopOp）原样保留，
//   冷启动重放同一 operationId 收敛；宫缩历史同样持久化（contra_history），重启不丢 stop。
// - 不可读缓存禁覆写（审核第 6 条）：corrupt/读取异常的键先做原字节隔离副本，隔离未
//   落地前冻结该键（任何 persist 拒绝覆写），隔离成功或读取恢复后才解冻——绝不用
//   "尽力而为"代替保留用户数据。
// - 作用域隔离（A06–A08）：缓存键含 env/AppID/家庭/成员，部件经无歧义编码（'_' 转义，
//   R2 审核 3：服务器身份只要求非空，不得为键拼接拒绝含 '_' 的合法身份）；会话/记录
//   创建时打 scope 标签；scope 不完整（任一部件非非空字符串）不写、不外呼；
//   恢复时按真实写入格式校验必要字段（R2 审核 5），结构不合法/异作用域内容一律
//   隔离冻结+警告，不默认为空后覆写。
// - 身份切换（A06/A07 + 审核第 4/7 条）：watch 以 store 创建时实际会话初始化基线——
//   首次通知即换人也会立即清内存；所有异步操作在开始、每个 await 后、每次外呼前对
//   同一捕获身份校验（含 recordFetalClick/undo 入队前捕获、分页拉取逐页校验、
//   retryPending 逐项校验）；同成员回前台复核不清（与 sessionService R7 同语义）。
// - RAM 孤儿草稿区（审核第 8 条）：身份切换时未落盘的活动草稿移入不可展示/不可上传的
//   恢复区，原作用域重新确认后自动恢复——不以隐私清屏为由静默丢输入（仅进程存活期
//   有效，冷启动即失，如实披露）。同 localRef 的 RAM 草稿比盘上旧 active 新（R2 审核 2）：
//   恢复时以 RAM 最新输入为准，同一 operationId 续跑。
// - 恢复异常披露（R2 审核 6）：不可读/结构不合法/异作用域键产生持久警告并冻结自动
//   同步域（retry/拉取返回 recovery-blocked），直到该键重新成功读取恢复或用户显式
//   确认继续；自动重试不得消除警告或报成功。页面据此显示持久横幅。
// - legacy 隔离（A08）：R1 前无作用域固定键保留在原地——不读取、不删除、不自动认领/上传。
//
// 核心语义（规格 PHASE_E1_STEP2_SPECIFICATION §二 + FOLLOWUP §E1）：
// - 绝对时间：经过时长恒 = now − startTime（不依赖前台 setInterval 累加）——切后台/锁屏
//   回来按真实时钟即时校准；本地"暂停"仅冻结 UI 展示与点击入口，不改服务端绝对会话。
// - 本地优先 + 操作日志：每次变更先落盘（本地立即计数/去重反馈），再按序发云端；
//   断网/失败保留日志，retryPending 严格按序重发（后 op 依赖前 op 的服务端 revision），
//   opId 稳定（服务端幂等重放不双写）；发送成功以**服务端会话视图**采纳为真源（计数/流水）。
// - 511 判定：最近 1 小时内 ≥3 次已结束宫缩 ∧ 平均间隔 ≤300s ∧ 平均持续 ≥50s ∧ 发作跨度
//   ≥50min（"约 1 小时"下限）——**仅辅助参考**（disclaimer 常量原文），不构成医疗诊断。
// - 就医电话：读 familyStore.pregnancy.fields（hospital/doctor/hospitalPhone）——缺号如实
//   提示去完善（不造假号码、不造默认值）。

import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { familyCall, getSessionState, captureSession, isSameSession, subscribeSession } from '@/services/sessionService.js'
import { CLOUD_CONFIG } from '@/utils/cloudConfig.js'
import { useFamilyStore } from '@/services/familyStore.js'
import foodSafetyJson from '@/static/data/food-safety.json'
import pregnancyRecipesJson from '@/static/data/pregnancy-recipes.json'

export const FOOD_SAFETY_ENTRIES = Array.isArray(foodSafetyJson) ? foodSafetyJson : []

// ── 孕期食谱（纯函数区：页面渲染层不藏逻辑，全部可测；数据构建期 import 全离线）──
export const RECIPE_DATA = pregnancyRecipesJson && Array.isArray(pregnancyRecipesJson.recipes)
  ? pregnancyRecipesJson
  : { version: '', nutrients: [], stages: [], recipes: [] }
export const RECIPE_NUTRIENTS = RECIPE_DATA.nutrients
export const RECIPE_STAGES = RECIPE_DATA.stages
export const RECIPE_ENTRIES = RECIPE_DATA.recipes

// 周数 → 周段（1–12/13–19/20–27/28–35/36–40；非有限数按 1 处理，越界 clamp）
export function getStageByWeek(week) {
  const w = Number.isFinite(week) ? Math.min(40, Math.max(1, Math.round(week))) : 1
  if (w <= 12) return 'early'
  if (w <= 19) return 'mid1'
  if (w <= 27) return 'mid2'
  if (w <= 35) return 'late1'
  return 'late2'
}

// 周段 → {stage, nutrients}：priority 顺序解析成完整营养素对象（页面胶囊数据源）
export function getStageFocus(stageKey) {
  const stage = RECIPE_STAGES.find(s => s.key === stageKey) || null
  if (!stage) return null
  const byKey = Object.fromEntries(RECIPE_NUTRIENTS.map(n => [n.key, n]))
  return { stage, nutrients: stage.nutrientPriority.map(k => byKey[k]).filter(Boolean) }
}

// 段内菜谱（跨段菜按 stages 数组包含；不传 = 全量）
export function listRecipes(stageKey) {
  if (!stageKey) return RECIPE_ENTRIES.slice()
  return RECIPE_ENTRIES.filter(r => Array.isArray(r.stages) && r.stages.includes(stageKey))
}

// 检索：菜名+食材名子串匹配（与 searchSafetyDictionary 同口径：本地、未命中返回空数组）
export function searchRecipes({ keyword = '', stageKey = '', nutrientKey = '', mealType = '', bentoOnly = false } = {}) {
  const kw = String(keyword || '').trim().toLowerCase()
  return RECIPE_ENTRIES.filter(r => {
    if (stageKey && !(Array.isArray(r.stages) && r.stages.includes(stageKey))) return false
    if (mealType && !(Array.isArray(r.mealType) && r.mealType.includes(mealType))) return false
    if (bentoOnly && !r.bentoFriendly) return false
    if (nutrientKey && !(Array.isArray(r.nutrients) && r.nutrients.some(n => n.key === nutrientKey))) return false
    if (!kw) return true
    const hay = [r.name, ...(r.ingredients || []).map(i => i.name)].join(' ').toLowerCase()
    return hay.includes(kw)
  })
}

// 今日三餐 v2（无状态确定性轮换 · 多道组合）：同 seed 永远同组合、次日自然换；
// 早餐 = 三角口径"主食 + 蛋白/甜汤副角"两道（早/加餐池打通，副角不挤占唯一加餐选项）；
// 午餐 = "荤主菜/主食碗 + 素菜 + 汤"三道（对齐带饭口径的一周结构：工作日各角色带饭
// 池 ≥2 道才启用、否则回退该角色全池轮换（单道会天天固定，宁轮换不僵化）；周末现做全池）；
// 晚餐 = "主菜 + 素菜 + 汤"三道现做（无带饭约束）；
// 加餐保持单道（本版口径）；午餐主菜优先命中段第一优先营养、晚餐主菜第二优先；
// 全天组合内去重（早餐两道/午餐三道/晚餐三道/加餐互不重样）；
// 频率受限菜（rotation:'excluded'——猪肝/海带/腌制高钠/早茶）永不自动入选。
// 数据 v1.2（2026-10-05 审定）：早餐缺口补菜 5 道 + 段扩容 3 道落库后，各段早餐
// 主食≥2/副角 3、午晚汤池≥2——早/午/晚组合结构全程不缺角；
// 过程与口径见 docs/RECIPE_COMBO_V2_2026-10-05.md 与 docs/RECIPE_BREAKFAST_GAP_DRAFT_2026-10-05.md。
const STAGE_SEED_OFFSET = { early: 0, mid1: 977, mid2: 2741, late1: 4409, late2: 6271 }
const DAY_OF_YEAR_CUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]
function dayOfYearOf(dateKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ''))
  if (!m) return 1
  const month = Number(m[2]); const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return 1
  return (DAY_OF_YEAR_CUM[month - 1] || 0) + day
}
function pickFromPool(pool, seed, primaryNutrient) {
  if (!pool.length) return null
  const sorted = pool.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const focusPool = primaryNutrient
    ? sorted.filter(r => Array.isArray(r.nutrients) && r.nutrients.some(n => n.key === primaryNutrient && n.weight === 'primary'))
    : []
  const use = focusPool.length ? focusPool : sorted
  return use[seed % use.length]
}
// 组合条目统一形如 { recipe, role }，页面按 role 渲染角色标签
export const DISH_ROLE_LABELS = { grain: '主食', protein: '蛋白', meat: '荤主菜', veg: '素菜', soup: '汤' }
function comboItem(recipe) {
  return recipe ? { recipe, role: recipe.dishRole || '' } : null
}
export function buildDailyMeals({ dateKey = '', week = 1, weekday = 1, shuffleOffset = 0 } = {}) {
  const stageKey = getStageByWeek(week)
  const focus = getStageFocus(stageKey)
  const weekend = weekday === 0 || weekday === 6
  const base = RECIPE_ENTRIES.filter(r => r.rotation !== 'excluded' && Array.isArray(r.stages) && r.stages.includes(stageKey))
  const seed = dayOfYearOf(dateKey) + (STAGE_SEED_OFFSET[stageKey] || 0) + shuffleOffset
  const usedIds = new Set()

  // 加餐先选：早餐副角池与之去重，避免挤占薄池段的唯一加餐选项
  const snack = pickFromPool(base.filter(r => r.mealType.includes('snack')), seed)
  if (snack) usedIds.add(snack.id)

  // 早餐三角：主食（grain）+ 副角（protein/soup，甜汤羹可作早餐饮品角），池 = 早∪加餐
  const bfPool = base.filter(r => r.mealType.includes('breakfast') || r.mealType.includes('snack'))
  const bfStaple = pickFromPool(bfPool.filter(r => r.dishRole === 'grain' && !usedIds.has(r.id)), seed + 1)
  if (bfStaple) usedIds.add(bfStaple.id)
  const bfSide = pickFromPool(bfPool.filter(r => (r.dishRole === 'protein' || r.dishRole === 'soup') && !usedIds.has(r.id)), seed + 2)
  if (bfSide) usedIds.add(bfSide.id)
  const breakfast = [bfStaple, bfSide].filter(Boolean).map(comboItem)

  // 午餐三道：主菜池 = meat∪grain（荤菜或面/饭主食碗，保证主食类午菜不退出轮换）
  const lunchBase = base.filter(r => r.mealType.includes('lunch') && !usedIds.has(r.id))
  const rolePool = (roles, bentoFirst) => {
    let pool = lunchBase.filter(r => roles.includes(r.dishRole))
    if (bentoFirst) {
      // 带饭池 ≥2 道才启用（单道会退化成天天固定；1 道时回退全池轮换，带饭口径靠页面标签如实提示）
      const bento = pool.filter(r => r.bentoFriendly)
      if (bento.length >= 2) pool = bento
    }
    return pool
  }
  const lunchMain = pickFromPool(rolePool(['meat', 'grain'], !weekend), seed + 3, focus && focus.stage.nutrientPriority[0])
  if (lunchMain) usedIds.add(lunchMain.id)
  const lunchVeg = pickFromPool(rolePool(['veg'], !weekend), seed + 4)
  if (lunchVeg) usedIds.add(lunchVeg.id)
  const lunchSoup = pickFromPool(rolePool(['soup'], !weekend), seed + 5)
  if (lunchSoup) usedIds.add(lunchSoup.id)
  const lunch = [lunchMain, lunchVeg, lunchSoup].filter(Boolean).map(comboItem)

  // 晚餐三道（下班现做，无带饭约束）：主菜优先命中段第二优先营养（P2）+ 素菜 + 汤
  const dinnerBase = base.filter(r => r.mealType.includes('dinner') && !usedIds.has(r.id))
  const dinnerMain = pickFromPool(dinnerBase.filter(r => r.dishRole === 'meat' || r.dishRole === 'grain'), seed + 6, focus && focus.stage.nutrientPriority[1])
  if (dinnerMain) usedIds.add(dinnerMain.id)
  const dinnerVeg = pickFromPool(dinnerBase.filter(r => r.dishRole === 'veg' && !usedIds.has(r.id)), seed + 7)
  if (dinnerVeg) usedIds.add(dinnerVeg.id)
  const dinnerSoup = pickFromPool(dinnerBase.filter(r => r.dishRole === 'soup' && !usedIds.has(r.id)), seed + 8)
  const dinner = [dinnerMain, dinnerVeg, dinnerSoup].filter(Boolean).map(comboItem)

  const focusTags = []
  if (focus) {
    const p1 = focus.stage.nutrientPriority[0]
    const p2 = focus.stage.nutrientPriority[1]
    if (lunch.some(it => it.recipe.nutrients.some(n => n.weight === 'primary' && n.key === p1))) focusTags.push(p1)
    if (dinner.some(it => it.recipe.nutrients.some(n => n.weight === 'primary' && n.key === p2))) focusTags.push(p2)
  }
  return {
    dateKey: String(dateKey || ''),
    stageKey,
    mode: weekend ? 'weekend' : 'weekday',
    breakfast,
    lunch,
    dinner,
    snack: snack ? [comboItem(snack)] : [],
    focusTags
  }
}

// R1 前旧固定键（无身份作用域）——隔离保留（A08：不自动并入任何成员），但自 F1 起
// 提供"检测存在 → 待确认入口 → 显式归属确认（有云端 ID 先验归属）/原始字节导出保留
// → 幂等迁入当前作用域"的找回通路；未确认前不展示正文、不上传、不迁移。
const LEGACY_KEYS = [
  'momcare_fetal_active_session',
  'momcare_active_contraction',
  'momcare_fetal_sessions_history',
  'momcare_fetal_finish_queue',
  'momcare_contra_stop_queue'
]
// 旧键 → 语义类别（fetal active / fetal queue / contra active / contra queue / fetal history）
const LEGACY_KEY_KIND = {
  momcare_fetal_active_session: 'fetal-active',
  momcare_fetal_sessions_history: 'fetal-history',
  momcare_fetal_finish_queue: 'fetal-queue',
  momcare_active_contraction: 'contra-active',
  momcare_contra_stop_queue: 'contra-queue'
}

const TOOLS_SCHEMA = 't1'
const FETAL_ACTIVE_SUFFIX = 'fetal_active'
const FETAL_HISTORY_SUFFIX = 'fetal_history'
const FETAL_QUEUE_SUFFIX = 'fetal_queue'
const CONTRA_ACTIVE_SUFFIX = 'contra_active'
const CONTRA_HISTORY_SUFFIX = 'contra_history'
const CONTRA_QUEUE_SUFFIX = 'contra_queue'
const TOOLS_FN = 'mc-tools'
const MERGE_WINDOW_MS = 5 * 60 * 1000   // 与服务端同则：相邻点击 ≤5 分钟计同一次胎动
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
// 511 参考阈值（规格 §二）：≥3 次 ∧ 平均间隔 ≤300s ∧ 平均持续 ≥50s ∧ 跨度 ≥50min（约 1 小时下限）
const P511_MIN_COUNT = 3
const P511_MAX_AVG_INTERVAL_SEC = 300
const P511_MIN_AVG_DURATION_SEC = 50
const P511_MIN_SPAN_MS = 50 * 60 * 1000

export const P511_DISCLAIMER = '✦ 511 规则仅作为辅助参考，不构成医疗诊断。若出现破水、剧烈出血或异常剧痛，无论是否符合规律，请立即前往医院就医！'

function newOpId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

// ── 缓存读写（可判定状态：A05 恢复/写入不伪装成功）──
function readCacheState(key) {
  let raw
  try {
    raw = uni.getStorageSync(key)
  } catch (e) {
    return { status: 'error', raw: null }
  }
  if (raw === '' || raw === null || raw === undefined) return { status: 'absent', raw: null }
  try {
    return { status: 'ok', value: JSON.parse(raw), raw }
  } catch (e) {
    return { status: 'corrupt', raw: String(raw) }
  }
}
// 原字节隔离副本（corrupt/异常键的用户数据保全）——返回是否落盘成功
function quarantineRaw(key, raw) {
  try {
    uni.setStorageSync(`${key}__corrupt_${Date.now()}`, raw)
    return true
  } catch (e) {
    return false
  }
}

// ── 作用域（A06–A08 + 审核第 9 条 + R2 审核 3）──
// 缓存身份 = 环境+应用+家庭+成员。服务器身份契约只要求非空字符串（可含 '_'/非 ASCII），
// 不得为缓存键拼接方便拒绝合法身份。无歧义编码：各部件 encodeURIComponent 后再把
// 连接符 '_' 转义为 %5F——编码结果不含 '_'，按 '_' 拼接不可能碰撞；scope 不完整
// （任一部件不是非空字符串）才拒绝：不写缓存、不发云请求。
function validScopePart(v) {
  return typeof v === 'string' && v.length > 0
}
function encodeScopePart(v) {
  return encodeURIComponent(v).replace(/_/g, '%5F')
}
function currentScope() {
  const s = getSessionState()
  if (s.status !== 'confirmed' || !s.member) return null
  const parts = {
    envId: CLOUD_CONFIG.envId,
    appId: CLOUD_CONFIG.appId,
    familyId: s.member.familyId,
    memberId: s.member.memberId
  }
  for (const v of Object.values(parts)) if (!validScopePart(v)) return null
  return { ...parts }
}
function scopeEquals(a, b) {
  return Boolean(a && b && a.envId === b.envId && a.appId === b.appId && a.familyId === b.familyId && a.memberId === b.memberId)
}
function scopedKey(scope, suffix) {
  return `momcare_tools_${['envId', 'appId', 'familyId', 'memberId'].map(p => encodeScopePart(scope[p])).join('_')}_${TOOLS_SCHEMA}_${suffix}`
}

// ── 胎动 5 分钟连击去重（服务端同则的本地镜像：即时反馈）──
// 相邻点击（按时间戳排序）间隔 ≤MERGE_WINDOW_MS 计同簇；簇首 valid=true 计次，续击留痕不计。
export function recomputeFetalClicks(clicks) {
  const list = (Array.isArray(clicks) ? clicks : []).map(c => ({ timestamp: c.timestamp }))
  const order = list.map((c, i) => i).sort((a, b) => list[a].timestamp - list[b].timestamp)
  const validOf = new Array(list.length).fill(false)
  let prevIdx = -1
  for (const idx of order) {
    if (prevIdx < 0 || list[idx].timestamp - list[prevIdx].timestamp > MERGE_WINDOW_MS) validOf[idx] = true
    prevIdx = idx
  }
  let validCount = 0
  const out = list.map((c, i) => {
    if (validOf[i]) validCount++
    return { timestamp: c.timestamp, valid: validOf[i] }
  })
  return { clicks: out, validCount }
}

// 经过时长（绝对时间差——切后台回来按真实时钟校准）
export function fetalElapsedMs(session, now = Date.now()) {
  if (!session || !session.startTime) return 0
  const base = session.pausedAt || now
  return Math.max(0, base - session.startTime)
}

// ── 恢复结构校验（R2 审核 5 + R3 审核 4）：按本地真实写入格式校验后续实际会访问的
// 必要字段（页面渲染、recompute、外呼参数）。不满足者不得进入内存/重试/外呼，
// 整键隔离冻结（保留 raw 字节）——畸形内容不能在页面或 recompute 中抛未捕获异常。
const FETAL_JOURNAL_KINDS = new Set(['click', 'undo', 'finish', 'discard'])
function validFetalJournalOp(op) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) return false
  if (typeof op.opId !== 'string' || !op.opId) return false
  if (!FETAL_JOURNAL_KINDS.has(op.kind)) return false
  if (op.payload !== undefined && op.payload !== null && (typeof op.payload !== 'object' || Array.isArray(op.payload))) return false
  if (op.kind === 'click') {
    if (!op.payload || !Number.isFinite(op.payload.timestamp)) return false
  } else if (op.kind === 'finish') {
    // finish 重放会把 payload.endTime 发往服务端——必须有限数字（R3 审核 4）
    if (!op.payload || !Number.isFinite(op.payload.endTime)) return false
  }
  return true
}
function validFetalClicks(clicks) {
  // recomputeFetalClicks/页面直接读 c.timestamp——null/畸形项会抛异常（R3 审核 4）
  return clicks.every(c => c && typeof c === 'object' && !Array.isArray(c) && Number.isFinite(c.timestamp))
}
function validFetalSessionShape(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  if (v.status !== 'running' && v.status !== 'paused') return false
  if (typeof v.localRef !== 'string' || !v.localRef) return false
  if (!Number.isFinite(v.startTime)) return false
  if (typeof v.startOpId !== 'string' || !v.startOpId) return false
  if (!Array.isArray(v.clicks) || !validFetalClicks(v.clicks)) return false
  if (!Array.isArray(v.journal) || !v.journal.every(validFetalJournalOp)) return false
  // 外呼参数（R3 审核 4）：sessionId 参与 CAS 调用、serverRevision 作 expectedRevision
  if (v.sessionId !== null && v.sessionId !== undefined && !(typeof v.sessionId === 'string' && v.sessionId)) return false
  if (v.serverRevision !== null && v.serverRevision !== undefined && !Number.isInteger(v.serverRevision)) return false
  if (v.pausedAt !== null && v.pausedAt !== undefined && !Number.isFinite(v.pausedAt)) return false
  if (v.targetDurationMs !== null && v.targetDurationMs !== undefined && !Number.isFinite(v.targetDurationMs)) return false
  return true
}
function validContraStopOp(op) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) return false
  if (typeof op.opId !== 'string' || !op.opId) return false
  if (!Number.isFinite(op.endTime)) return false
  if (op.intensity !== undefined && op.intensity !== null && typeof op.intensity !== 'string') return false
  if (op.notes !== undefined && op.notes !== null && typeof op.notes !== 'string') return false
  return true
}
function validContraRecordShape(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  if (v.status !== 'ongoing') return false
  if (typeof v.localRef !== 'string' || !v.localRef) return false
  if (!Number.isFinite(v.startTime)) return false
  if (typeof v.startOpId !== 'string' || !v.startOpId) return false
  // 外呼/采纳字段（R3 审核 4）：start/stop 载荷与服务端响应写入字段
  if (v.recordId !== null && v.recordId !== undefined && !(typeof v.recordId === 'string' && v.recordId)) return false
  if (v.intensity !== undefined && v.intensity !== null && typeof v.intensity !== 'string') return false
  if (v.notes !== undefined && v.notes !== null && typeof v.notes !== 'string') return false
  if (v.intervalSec !== undefined && v.intervalSec !== null && !Number.isFinite(v.intervalSec)) return false
  if (v.stopOp !== null && v.stopOp !== undefined && !validContraStopOp(v.stopOp)) return false
  return true
}

// ── E2 Hadlock 1985 三参数估重（纯函数——与服务端同式同系数；页面实时计算用）──
// log10(EFW_g)=1.326−0.00326×AC×FL+0.0107×HC+0.0438×AC+0.158×FL（cm）
// 输入支持 cm/mm（换算 /10 或 ×1）；范围校验同服务端（超界返回 {err}）
export const EFW_FORMULA = 'hadlock_hc_ac_fl_1985_v1'
const EFW_RANGES_CM = { hc: [10.0, 42.0], ac: [10.0, 45.0], fl: [1.0, 10.0] }
export function computeHadlockEfw({ hc, ac, fl, unit = 'cm' }) {
  if (unit !== 'cm' && unit !== 'mm') return { err: 'unit 须 cm 或 mm' }
  const factor = unit === 'mm' ? 0.1 : 1
  const cm = {}
  for (const key of ['hc', 'ac', 'fl']) {
    const v = { hc, ac, fl }[key]
    if (typeof v !== 'number' || !Number.isFinite(v)) return { err: `${key} 须有限数字` }
    const c = v * factor
    if (c <= 0) return { err: `${key} 须为正数` }
    const [lo, hi] = EFW_RANGES_CM[key]
    if (c < lo || c > hi) return { err: `${key} 超出范围 [${lo}, ${hi}]cm` }
    cm[key] = c
  }
  const log10 = 1.326 - 0.00326 * cm.ac * cm.fl + 0.0107 * cm.hc + 0.0438 * cm.ac + 0.158 * cm.fl
  const exact = Math.pow(10, log10)
  const exactEfwGrams = Math.round(exact * 100) / 100
  return {
    inputsCm: { hcCm: cm.hc, acCm: cm.ac, flCm: cm.fl },
    formula: EFW_FORMULA,
    log10: Math.round(log10 * 100000) / 100000,
    exactEfwGrams,
    efwGrams: Math.round(exact),
    efwKg: Math.round(exactEfwGrams) / 1000,
    rangeGrams: { low: Math.round(exactEfwGrams * 0.9), high: Math.round(exactEfwGrams * 1.1) }
  }
}

export const useToolsStore = defineStore('tools', () => {
  const familyStore = useFamilyStore()

  const currentFetalSession = ref(null)   // 活跃胎动会话（本地持久化；断网不丢）
  const fetalSessions = ref([])           // 历史会话（完成/废弃——含 pendingSync 标记）
  const activeContraction = ref(null)     // 进行中单次宫缩
  const contractionRecords = ref([])      // 最近宫缩历史（服务端视图 + 本地先行归档）
  // 断网终态队列：本地先行归档后，携日志的会话/记录副本留队重试——服务端补齐后拉取刷新
  const fetalFinishQueue = ref([])
  const contraStopQueue = ref([])
  // R1 未保存/恢复警告状态（A04/A05——页面据此显示真实状态，不以成功遮掩）
  const fetalPersistFailed = ref(false)
  const contraPersistFailed = ref(false)
  const restoreWarnings = ref([])

  // 冻结键（审核第 6 条）：corrupt/读取异常/结构不合法/异作用域内容的键——原字节隔离
  // 副本落地之前禁止覆写；解冻条件 = 隔离成功（或读取恢复后隔离成功）。
  const frozenCacheKeys = new Map() // key → { raw, quarantined }
  function freezeKey(key, raw) {
    const quarantined = raw === null || raw === undefined ? false : quarantineRaw(key, raw)
    frozenCacheKeys.set(key, { raw: raw === null || raw === undefined ? null : String(raw), quarantined })
    return quarantined
  }
  function cacheWritable(key) {
    const f = frozenCacheKeys.get(key)
    if (!f) return true
    if (f.quarantined) return true
    // 补试隔离：底层读取恢复为可读时再次保全原字节；成功才允许覆写
    const st = readCacheState(key)
    if (st.status === 'ok' || st.status === 'corrupt') {
      const raw = st.status === 'corrupt' ? st.raw : String(st.raw)
      if (quarantineRaw(key, raw)) {
        f.quarantined = true
        return true
      }
    }
    return false
  }
  function guardedWrite(key, value) {
    if (!cacheWritable(key)) return false
    try {
      uni.setStorageSync(key, JSON.stringify(value))
      return true
    } catch (e) {
      return false
    }
  }

  function sessionReady() {
    const s = getSessionState()
    return s.status === 'confirmed' && s.member
  }

  // ── 粒度持久化（A04：逐键消费布尔结果；终态耐久序见 finalize*——审核第 5 条）──
  function fetalQueueContent(scope) {
    return fetalFinishQueue.value.filter(x => x && x.scope && scopeEquals(x.scope, scope))
  }
  function contraQueueContent(scope) {
    return contraStopQueue.value.filter(x => x && x.scope && scopeEquals(x.scope, scope))
  }
  function persistFetalQueue(scope) { return guardedWrite(scopedKey(scope, FETAL_QUEUE_SUFFIX), fetalQueueContent(scope)) }
  function persistFetalHistory(scope) { return guardedWrite(scopedKey(scope, FETAL_HISTORY_SUFFIX), fetalSessions.value.slice(0, 50)) }
  function persistFetalActive(scope) {
    const cur = currentFetalSession.value
    if (cur && cur.scope && !scopeEquals(cur.scope, scope)) return false
    return guardedWrite(scopedKey(scope, FETAL_ACTIVE_SUFFIX), cur)
  }
  function persistFetal(scopeGuard) {
    const scope = currentScope()
    if (!scope) return { ok: false, incompleteScope: true, keys: {} }
    if (scopeGuard && !scopeEquals(scope, scopeGuard)) return { ok: false, scopeMismatch: true, keys: {} }
    const keys = {
      active: persistFetalActive(scope),
      history: persistFetalHistory(scope),
      queue: persistFetalQueue(scope)
    }
    return { ok: keys.active && keys.history && keys.queue, keys }
  }
  function persistContraActive(scope) {
    const cur = activeContraction.value
    if (cur && cur.scope && !scopeEquals(cur.scope, scope)) return false
    return guardedWrite(scopedKey(scope, CONTRA_ACTIVE_SUFFIX), cur)
  }
  function persistContraQueue(scope) { return guardedWrite(scopedKey(scope, CONTRA_QUEUE_SUFFIX), contraQueueContent(scope)) }
  // R3 终审 2：本地未同步/冲突终态是耐久输入——落盘全保留，不受已同步历史展示上限影响；
  // 普通已同步行保持 100 条上限
  function contraHistoryForPersist() {
    const pending = contractionRecords.value.filter(r => r && r.status === 'finished' && r.synced === false)
    const rest = contractionRecords.value.filter(r => !(r && r.status === 'finished' && r.synced === false)).slice(0, 100)
    return [...pending, ...rest]
  }
  function persistContraHistory(scope) { return guardedWrite(scopedKey(scope, CONTRA_HISTORY_SUFFIX), contraHistoryForPersist()) }
  function persistContra(scopeGuard) {
    const scope = currentScope()
    if (!scope) return { ok: false, incompleteScope: true, keys: {} }
    if (scopeGuard && !scopeEquals(scope, scopeGuard)) return { ok: false, scopeMismatch: true, keys: {} }
    const keys = {
      active: persistContraActive(scope),
      history: persistContraHistory(scope),
      queue: persistContraQueue(scope)
    }
    return { ok: keys.active && keys.history && keys.queue, keys }
  }
  function noteFetalPersist(p) { fetalPersistFailed.value = !p.ok; return p }
  function noteContraPersist(p) { contraPersistFailed.value = !p.ok; return p }

  // 队列凭据 → 展示行（R3 重放窗口核对 2）：nullable 语义与 handler/finalize 同契约——
  // stopOp 字段 undefined=未提供（回退 record 值）；显式 null=清空（不复活旧值）。
  function contraRowFromQueue(q, so, conflict) {
    const pickInput = (stopVal, recordVal) => stopVal !== undefined ? stopVal : (recordVal ?? null)
    return {
      recordId: q.recordId ?? null, localRef: q.localRef, startTime: q.startTime,
      endTime: so.endTime ?? null,
      durationSec: so.endTime != null ? Math.round((so.endTime - q.startTime) / 1000) : null,
      intervalSec: q.intervalSec ?? null,
      intensity: pickInput(so.intensity, q.intensity),
      notes: pickInput(so.notes, q.notes),
      status: 'finished', synced: false, conflict: conflict === true, scope: q.scope
    }
  }

  // 冷启动/切换恢复：只读当前成员作用域键（legacy 无作用域键一律不读——A08）。
  // 结构校验（R2 审核 5）：active/queue 按真实写入格式验必要字段（journal 数组、
  // startTime/startOpId/localRef、宫缩 stopOp 凭据），不合法整键隔离冻结——不得进入
  // 内存/重试/外呼；history 异作用域条目不显示（原字节先隔离保全再允许覆写）。
  // corrupt 原字节隔离失败 → 冻结禁覆写（审核第 6 条）；error（读取异常）同样冻结。
  // 警告带 ack 标记（R2 审核 6）：同键同状态的重恢复保留已确认状态，不反复弹闸。
  function restoreFromCache() {
    const scope = currentScope()
    if (!scope) return { ok: false, code: 'unauthenticated-session', warnings: [] }
    const prevAck = new Set(restoreWarnings.value.filter(w => w.ack).map(w => `${w.key}:${w.status}`))
    restoreWarnings.value = []
    const warn = (key, status, extra) => { restoreWarnings.value.push({ key, status, ack: prevAck.has(`${key}:${status}`), ...(extra || {}) }) }
    // 读取并按需冻结；ok 分支携带原始字节 raw（终审 1：隔离备份必须用原 raw——
    // JSON.stringify(解析值) 不等同原字节：空白会丢、超安全整数会变，不能当备份）。
    const readOrFreeze = suffix => {
      const key = scopedKey(scope, suffix)
      const st = readCacheState(key)
      if (st.status === 'absent') return { status: 'absent' }
      if (st.status === 'error') {
        freezeKey(key, null)
        warn(suffix, 'error')
        return { status: 'error' }
      }
      if (st.status === 'corrupt') {
        const quarantined = freezeKey(key, st.raw)
        warn(suffix, quarantined ? 'corrupt' : 'corrupt-frozen')
        return { status: 'corrupt' }
      }
      return { status: 'ok', value: st.value, key, raw: st.raw }
    }
    // 结构异常/异作用域整键冻结：备份原始 raw 字节；备份结果传到 warning（终审 2：
    // 失败 → `<status>-unbacked` 且键冻结禁覆写——页面据此如实说"未能备份"，
    // 绝不把备份失败显示成已备份）。
    const freezeShape = (r, suffix, status) => {
      if (!r.key) { warn(suffix, status); return }
      const backed = freezeKey(r.key, r.raw)
      warn(suffix, backed ? status : `${status}-unbacked`)
    }
    // 原字节隔离（display 域部分异作用域：过滤展示、原始字节备份后允许后续覆写）。
    // 备份失败必须冻结禁覆写（R3 审核 2 + 终审 1/2）——绝不在没有耐久备份时覆盖原字节，
    // 备份内容为原始 raw（非重序列化）。
    const quarantinePartial = (r, suffix) => {
      if (!r.key) { warn(suffix, 'scope-foreign'); return }
      if (r.raw && quarantineRaw(r.key, r.raw)) { warn(suffix, 'scope-foreign'); return }
      freezeKey(r.key, r.raw)
      warn(suffix, 'scope-foreign-unbacked')
    }

    // 胎动 active：必要字段 + running/paused + 作用域一致
    const f = readOrFreeze(FETAL_ACTIVE_SUFFIX)
    if (f.status === 'ok') {
      const v = f.value
      if (v === null || v === undefined) {
        // 显式清空（finalize 写入的 null）——合法空态
      } else if (validFetalSessionShape(v)) {
        if (v.scope && scopeEquals(v.scope, scope)) {
          const cur = currentFetalSession.value
          if (cur && cur.scope && !scopeEquals(cur.scope, scope)) {
            // 上一作用域残留（未经 watch 清理的异常路径）：入孤儿区，不展示给新身份
            stashOrphanDraft('fetal', cur)
            currentFetalSession.value = null
          }
          // R3 审核 1：同作用域 RAM 活跃会话是最新输入（盘只可能更旧——所有落盘都源于
          // 该 RAM 对象），不被盘上旧副本覆盖；未保存 click/stop 输入与 operationId 保留。
          if (!currentFetalSession.value) currentFetalSession.value = v
        } else freezeShape(f, FETAL_ACTIVE_SUFFIX, 'scope-foreign')
      } else if (v && typeof v === 'object' && (v.status === 'completed' || v.status === 'discarded')) {
        // 终态残留（R3 审核 3：服务端已确认、清空写失败的盘上凭据）：不复活为进行中，
        // 不入内存（历史键/服务端才是归宿），可安全覆写
      } else {
        freezeShape(f, FETAL_ACTIVE_SUFFIX, 'invalid-shape')
      }
    }
    // 胎动 history：数组且条目为对象；异作用域条目不显示（保全原字节后过滤）
    const h = readOrFreeze(FETAL_HISTORY_SUFFIX)
    if (h.status === 'ok') {
      if (Array.isArray(h.value) && h.value.every(x => x && typeof x === 'object')) {
        const foreign = h.value.filter(x => x.scope && !scopeEquals(x.scope, scope))
        if (foreign.length > 0) quarantinePartial(h, FETAL_HISTORY_SUFFIX)
        fetalSessions.value = h.value.filter(x => !x.scope || scopeEquals(x.scope, scope))
      } else {
        freezeShape(h, FETAL_HISTORY_SUFFIX, 'invalid-shape')
      }
    }
    // 胎动 queue：数组且每项结构合法+作用域一致；任一异常整键冻结不覆写、不重试
    const fq = readOrFreeze(FETAL_QUEUE_SUFFIX)
    if (fq.status === 'ok') {
      if (Array.isArray(fq.value) && fq.value.every(x => validFetalSessionShape(x) && x.scope && scopeEquals(x.scope, scope))) {
        fetalFinishQueue.value = fq.value
      } else {
        freezeShape(fq, FETAL_QUEUE_SUFFIX, Array.isArray(fq.value) ? 'scope-foreign' : 'invalid-shape')
      }
    }
    // 宫缩 active：必要字段 + ongoing + 作用域一致
    const c = readOrFreeze(CONTRA_ACTIVE_SUFFIX)
    if (c.status === 'ok') {
      const v = c.value
      if (v === null || v === undefined) {
        // 合法空态
      } else if (validContraRecordShape(v)) {
        if (v.scope && scopeEquals(v.scope, scope)) {
          const cur = activeContraction.value
          if (cur && cur.scope && !scopeEquals(cur.scope, scope)) {
            stashOrphanDraft('contra', cur)
            activeContraction.value = null
          }
          // R3 审核 1：同作用域 RAM 记录是最新输入（未落盘 stopOp 保留），不被盘上旧副本覆盖
          if (!activeContraction.value) activeContraction.value = v
        } else freezeShape(c, CONTRA_ACTIVE_SUFFIX, 'scope-foreign')
      } else if (v && typeof v === 'object' && v.status === 'finished') {
        // 终态残留（R3 审核 3）：不复活为进行中，可安全覆写
      } else {
        freezeShape(c, CONTRA_ACTIVE_SUFFIX, 'invalid-shape')
      }
    }
    // 宫缩 history：数组且条目为对象；异作用域条目不显示（R3 审核 2——本地归档条目
    // 自 R3 起携带 scope；服务端视图条目无 scope 字段照常显示）
    const ch = readOrFreeze(CONTRA_HISTORY_SUFFIX)
    if (ch.status === 'ok') {
      if (Array.isArray(ch.value) && ch.value.every(x => x && typeof x === 'object')) {
        const foreign = ch.value.filter(x => x.scope && !scopeEquals(x.scope, scope))
        if (foreign.length > 0) quarantinePartial(ch, CONTRA_HISTORY_SUFFIX)
        contractionRecords.value = ch.value.filter(x => !x.scope || scopeEquals(x.scope, scope))
      } else {
        freezeShape(ch, CONTRA_HISTORY_SUFFIX, 'invalid-shape')
      }
    }
    // 宫缩 queue：每项结构合法 + stopOp 凭据在 + 作用域一致（无凭据项无重试语义=不合法）
    const cq = readOrFreeze(CONTRA_QUEUE_SUFFIX)
    if (cq.status === 'ok') {
      if (Array.isArray(cq.value) && cq.value.every(x => validContraRecordShape(x) && validContraStopOp(x.stopOp) && x.scope && scopeEquals(x.scope, scope))) {
        contraStopQueue.value = cq.value
      } else {
        freezeShape(cq, CONTRA_QUEUE_SUFFIX, Array.isArray(cq.value) ? 'scope-foreign' : 'invalid-shape')
      }
    }

    // R3 终审 2 + 重启 2/3：队列是未完成输入的耐久来源——
    // - history 缺该输入（截断/部分写失败）→ 重建展示行；
    // - history 有同 ID 行但已是 synced=true 的他方终态（旧版/部分写入遗留）→ 队列仍是
    //   未完成本地输入，不能当作已确认：以队列凭据替换为本地冲突行（他方 payload 不顶替）；
    // - history 行 synced=false（本人 pending 在场）→ 已有披露，不重复重建（防双行）。
    // 去重键 = recordId 优先、localRef 兜底；旧版历史行缺 localRef 时按 recordId 可证明
    // 对应迁接（无 recordId 且无 localRef 的旧行不参与归并——不随意合并不同记录）。
    {
      const rows = contractionRecords.value.slice()
      for (const q of contraStopQueue.value) {
        if (!q || !q.scope || !scopeEquals(q.scope, scope)) continue
        const key = q.recordId || q.localRef
        if (!key) continue
        // lookup 同时匹配两键：部分成功窗口（q 已有 recordId、历史行仍 null-ID 按 localRef
        // 对应）与全离线（q 无 ID 仅 localRef）都不双行（R3 重放窗口核对 1）
        const idx = rows.findIndex(r => r && (
          (q.recordId && r.recordId === q.recordId) ||
          (q.localRef && r.localRef && r.localRef === q.localRef) ||
          (!q.recordId && !q.localRef && false)))
        if (idx >= 0) {
          const ex = rows[idx]
          if (ex.synced === false) {
            // await 中断窗口（R3 中断核对）：start 重放成功已把 q.recordId 落盘、stop await
            // 未返回即中断——retry 迁接未执行，history 行仍 null-ID。恢复时在此完成可证明
            // ID 迁接（localRef 对应 + q 持有云 ID）：仍 synced=false、不消耗 stop 队列、
            // 不改本地 payload；迁接需落盘（写失败保留本地输入与 truthful 未保存状态）。
            if (q.recordId && (ex.recordId === null || ex.recordId === undefined)) {
              ex.recordId = q.recordId
              noteContraPersist(persistContra(scope))
            }
            continue // 本人未同步披露在场——不重复重建（防双行）
          }
          // 同 ID 已同步他方终态：队列凭据才是本地未完成输入——替换为本地冲突行。
          // nullable 语义（R3 重放窗口核对 2）：stopOp 显式 null=清空该字段（与
          // handler/finalize 同契约——只把 undefined 当缺值回退 record 值）
          const so = q.stopOp || {}
          rows[idx] = contraRowFromQueue(q, so, true)
          continue
        }
        const so = q.stopOp || {}
        rows.push(contraRowFromQueue(q, so, q.conflict === true))
      }
      contractionRecords.value = rows
    }

    // RAM 孤儿草稿回接（审核第 8 条 + R2 审核 2）：空位直补；同 localRef 时 RAM 孤儿是
    // 落盘失败前的最新输入（其后的磁盘写入均被 scope 隔离阻止），以最新草稿覆盖盘上
    // 旧 active——未保存输入可见、同一 operationId 可续跑，不是只留在不可访问的数组。
    for (let i = orphanDrafts.value.length - 1; i >= 0; i--) {
      const d = orphanDrafts.value[i]
      if (!scopeEquals(d.scope, scope)) continue
      if (d.kind === 'fetal') {
        const cur = currentFetalSession.value
        if (!cur || cur.localRef === d.data.localRef) {
          currentFetalSession.value = d.data
          fetalPersistFailed.value = true
        } else continue
      } else if (d.kind === 'contra') {
        const cur = activeContraction.value
        if (!cur || cur.localRef === d.data.localRef) {
          activeContraction.value = d.data
          contraPersistFailed.value = true
        } else continue
      } else continue
      orphanDrafts.value.splice(i, 1)
      warn(d.kind === 'fetal' ? FETAL_ACTIVE_SUFFIX : CONTRA_ACTIVE_SUFFIX, 'orphan-draft-restored')
    }

    if (restoreWarnings.value.length > 0) {
      console.warn('[toolsStore] 恢复警告（不可读/异构/异作用域缓存已隔离，未覆写）:', JSON.stringify(restoreWarnings.value))
    }
    return { ok: restoreWarnings.value.every(w => !INTEGRITY_WARNING_STATUSES.includes(w.status)), warnings: restoreWarnings.value.slice() }
  }

  // ── 恢复异常闸（R2 审核 6 + R3 审核 2 + 终审 2）──
  // 不可读/结构不合法/异作用域警告未确认期间：自动同步域（重试/拉取）冻结，返回
  // recovery-blocked；直到该键重新成功读取完整恢复（下次 restore 无警告）或用户显式
  // 确认继续。自动 retry 不触碰警告列表——不可能自行"消掉警告并报成功"。
  // -unbacked 后缀 = 原字节尚无耐久备份（隔离副本写失败）——提示必须如实区分；
  // orphan-draft-restored 是 RAM 恢复（无耐久备份动作），不参与本闸。
  const INTEGRITY_WARNING_STATUSES = ['error', 'corrupt', 'corrupt-frozen', 'invalid-shape', 'invalid-shape-unbacked', 'scope-foreign', 'scope-foreign-unbacked']
  const RECOVERY_BLOCKED_MESSAGE = '本地记录缓存存在无法读取或校验异常的数据，自动同步已暂停——请在工具页查看恢复提示并确认后继续。'
  // F2（2026-10-01 功能修复）：恢复闸按数据域约束——胎动键异常只阻断胎动域、宫缩键异常
  // 只阻断宫缩域；EFW 历史为纯云端域，不依赖任何计时缓存完整性（一个域异常不阻止无关域恢复）。
  const FETAL_DOMAIN_SUFFIXES = [FETAL_ACTIVE_SUFFIX, FETAL_HISTORY_SUFFIX, FETAL_QUEUE_SUFFIX]
  const CONTRA_DOMAIN_SUFFIXES = [CONTRA_ACTIVE_SUFFIX, CONTRA_HISTORY_SUFFIX, CONTRA_QUEUE_SUFFIX]
  const domainIntegrityBlocked = suffixes => restoreWarnings.value.some(w => suffixes.includes(w.key) && INTEGRITY_WARNING_STATUSES.includes(w.status) && !w.ack)
  const fetalRecoveryBlocked = computed(() => domainIntegrityBlocked(FETAL_DOMAIN_SUFFIXES))
  const contraRecoveryBlocked = computed(() => domainIntegrityBlocked(CONTRA_DOMAIN_SUFFIXES))
  const recoveryBlocked = computed(() => fetalRecoveryBlocked.value || contraRecoveryBlocked.value)
  function acknowledgeRestoreWarnings() {
    for (const w of restoreWarnings.value) w.ack = true
  }

  // ── F1：旧版无作用域计时数据的安全找回（2026-10-01 功能修复）──
  // 状态只含"存在性与计数"，不含正文（页面在确认前不展示旧记录内容，不上传，不自动归属）。
  const legacyPending = ref(null)
  function scanLegacyKeys() {
    const keys = []
    const counts = { 'fetal-active': 0, 'fetal-history': 0, 'fetal-queue': 0, 'contra-active': 0, 'contra-queue': 0 }
    const readErrors = []
    for (const key of LEGACY_KEYS) {
      let st
      try {
        const raw = uni.getStorageSync(key)
        if (raw === '' || raw === null || raw === undefined) continue
        st = { key, kind: LEGACY_KEY_KIND[key], status: 'present', bytes: String(raw).length }
      } catch (e) {
        readErrors.push(key)
        continue
      }
      keys.push(st)
    }
    // 计数需解析内容（仅统计条目数，不外露正文）
    const parseQuiet = key => {
      try { const raw = uni.getStorageSync(key); if (!raw) return null; return { value: JSON.parse(raw), raw } } catch (e) { return null }
    }
    const parsed = {}
    for (const k of keys) {
      const p = parseQuiet(k.key)
      parsed[k.key] = p
      if (k.kind === 'fetal-history' || k.kind === 'fetal-queue' || k.kind === 'contra-queue') {
        counts[k.kind] = p && Array.isArray(p.value) ? p.value.length : (p ? 1 : 0)
      } else if (k.status === 'present') {
        counts[k.kind] = p ? 1 : (readErrors.push(k.key), 0)
        if (!p) { k.status = 'unparseable'; readErrors.push(k.key) }
      }
    }
    const total = keys.length
    legacyPending.value = { keys, counts, readErrors, total, parsedRef: parsed }
    return legacyPending.value
  }
  const legacySummaryText = computed(() => {
    const p = legacyPending.value
    if (!p || p.total === 0) return ''
    const parts = []
    if (p.counts['fetal-active'] > 0) parts.push(`胎动进行中 ${p.counts['fetal-active']}`)
    if (p.counts['fetal-queue'] > 0) parts.push(`胎动待完成 ${p.counts['fetal-queue']}`)
    if (p.counts['fetal-history'] > 0) parts.push(`胎动历史 ${p.counts['fetal-history']}`)
    if (p.counts['contra-active'] > 0) parts.push(`宫缩进行中 ${p.counts['contra-active']}`)
    if (p.counts['contra-queue'] > 0) parts.push(`宫缩待同步 ${p.counts['contra-queue']}`)
    const errNote = p.readErrors.length > 0 ? `；${p.readErrors.length} 项读取异常（无法自动处理，可导出保留）` : ''
    return `检测到旧版本计时记录：${parts.join('、')}${errNote}。旧记录无身份信息、无法自动证明归属——未确认前不展示、不上传、不并入当前成员。`
  })
  // 原始字节导出/保留通路：逐键写 `__legacy_keep_` 副本（不做任何删除/改写）
  function exportLegacyRaw() {
    const exported = []
    const failed = []
    const ts = Date.now()
    for (const key of LEGACY_KEYS) {
      let raw
      try { raw = uni.getStorageSync(key) } catch (e) { failed.push(key); continue }
      if (raw === '' || raw === null || raw === undefined) continue
      try { uni.setStorageSync(`${key}__legacy_keep_${ts}`, raw); exported.push(key) } catch (e) { failed.push(key) }
    }
    return { ok: failed.length === 0, exported, failed }
  }
  // 云端归属验证：有服务端 ID 的旧记录，续跑前查真实云端记录的归属（memberId）与状态——
  // 点击确认不直接赋予操作权限；查不到/查询失败 → 保留待处理，不发 mutation。
  async function verifyLegacyCloudOwnership(scope, fetalWithId, contraWithId) {
    const verdict = { fetalOwnerOk: new Set(), contraOwnerOk: new Set(), rejected: [], unverifiable: [] }
    if (fetalWithId.length > 0) {
      let res
      try { res = await familyCall(TOOLS_FN, { action: 'fetal.list', limit: 100 }) } catch (e) { res = { ok: false, code: 'cloud-call-failed' } }
      if (!res.ok) {
        for (const f of fetalWithId) verdict.unverifiable.push({ kind: 'fetal', localRef: f.localRef, sessionId: f.sessionId, reason: res.code })
      } else {
        const byId = new Map((res.data.sessions || []).map(x => [x.sessionId, x]))
        for (const f of fetalWithId) {
          const doc = byId.get(f.sessionId)
          if (!doc) verdict.unverifiable.push({ kind: 'fetal', localRef: f.localRef, sessionId: f.sessionId, reason: 'not-found' })
          else if (doc.memberId !== scope.memberId) verdict.rejected.push({ kind: 'fetal', localRef: f.localRef, sessionId: f.sessionId, owner: doc.memberId })
          else verdict.fetalOwnerOk.add(f.localRef)
        }
      }
    }
    if (contraWithId.length > 0) {
      let res
      try { res = await familyCall(TOOLS_FN, { action: 'contraction.list', limit: 100, includeDiscarded: true }) } catch (e) { res = { ok: false, code: 'cloud-call-failed' } }
      if (!res.ok) {
        for (const c of contraWithId) verdict.unverifiable.push({ kind: 'contra', localRef: c.localRef, recordId: c.recordId, reason: res.code })
      } else {
        const byId = new Map((res.data.records || []).map(x => [x.recordId, x]))
        for (const c of contraWithId) {
          const doc = byId.get(c.recordId)
          if (!doc) verdict.unverifiable.push({ kind: 'contra', localRef: c.localRef, recordId: c.recordId, reason: 'not-found' })
          else if (doc.memberId !== scope.memberId) verdict.rejected.push({ kind: 'contra', localRef: c.localRef, recordId: c.recordId, owner: doc.memberId })
          else verdict.contraOwnerOk.add(c.localRef)
        }
      }
    }
    return verdict
  }
  // 显式归属确认 + 幂等迁移。返回 {ok, adopted, conflicts, rejected, unverifiable, readFailures}。
  // 迁移保全 localRef/操作 ID/点击顺序/finish·stop 时间与显式 null；目标耐久写入并读回验证
  // 成功前不删除/清空/覆写任何旧键字节（删除前必有 __legacy_keep_ 原始字节备份）。
  async function confirmLegacyAdoption() {
    const scope = currentScope()
    if (!scope) return { ok: false, code: 'scope-incomplete', message: '身份作用域不完整，无法迁入' }
    if (recoveryBlocked.value) return { ok: false, code: 'recovery-blocked', message: RECOVERY_BLOCKED_MESSAGE }
    const scan = scanLegacyKeys()
    if (scan.total === 0) return { ok: true, adopted: 0, conflicts: [], rejected: [], unverifiable: [] }
    const parsed = scan.parsedRef
    // ① 原始字节备份（任何处置之前；失败则中止迁移，旧字节保持原样）
    const backup = exportLegacyRaw()
    if (!backup.ok) {
      return { ok: false, code: 'legacy-backup-failed', message: '旧记录原始字节备份失败——为避免数据丢失，本次不迁移（旧数据保持原样，可重试）', detail: backup.failed }
    }
    // ② 分类解析（unparseable/corrupt 的键保留原样，不迁移不删除）
    const fetalActive = (parsed['momcare_fetal_active_session'] && parsed['momcare_fetal_active_session'].value && !Array.isArray(parsed['momcare_fetal_active_session'].value)) ? parsed['momcare_fetal_active_session'].value : null
    const fetalQueueArr = Array.isArray(parsed['momcare_fetal_finish_queue'] && parsed['momcare_fetal_finish_queue'].value) ? parsed['momcare_fetal_finish_queue'].value.filter(x => x && typeof x === 'object') : []
    const contraActive = (parsed['momcare_active_contraction'] && parsed['momcare_active_contraction'].value && !Array.isArray(parsed['momcare_active_contraction'].value)) ? parsed['momcare_active_contraction'].value : null
    const contraQueueArr = Array.isArray(parsed['momcare_contra_stop_queue'] && parsed['momcare_contra_stop_queue'].value) ? parsed['momcare_contra_stop_queue'].value.filter(x => x && typeof x === 'object') : []
    const fetalHistory = Array.isArray(parsed['momcare_fetal_sessions_history'] && parsed['momcare_fetal_sessions_history'].value) ? parsed['momcare_fetal_sessions_history'].value : []
    // ③ 云端归属验证（有服务端 ID 的记录）
    const fetalAll = [fetalActive, ...fetalQueueArr].filter(Boolean)
    const contraAll = [contraActive, ...contraQueueArr].filter(Boolean)
    const fetalWithId = fetalAll.filter(x => typeof x.sessionId === 'string' && x.sessionId)
    const contraWithId = contraAll.filter(x => typeof x.recordId === 'string' && x.recordId)
    const verdict = await verifyLegacyCloudOwnership(scope, fetalWithId, contraWithId)
    const rejected = verdict.rejected
    const unverifiable = verdict.unverifiable
    const fetalOk = rec => !(rec && typeof rec.sessionId === 'string' && rec.sessionId) || verdict.fetalOwnerOk.has(rec.localRef)
    const contraOk = rec => !(rec && typeof rec.recordId === 'string' && rec.recordId) || verdict.contraOwnerOk.has(rec.localRef)
    const takeFetal = fetalActive && fetalOk(fetalActive) ? fetalActive : null
    const takeContra = contraActive && contraOk(contraActive) ? contraActive : null
    const fetalQueueTake = fetalQueueArr.filter(x => fetalOk(x))
    const contraQueueTake = contraQueueArr.filter(x => contraOk(x))
    // ④ 新旧冲突检查：目标作用域已有不同 localRef 的活跃会话/记录 → 不覆盖，保留旧数据待用户处理
    const conflicts = []
    if (takeFetal && currentFetalSession.value && currentFetalSession.value.localRef !== takeFetal.localRef) {
      conflicts.push({ kind: 'fetal-active', legacyLocalRef: takeFetal.localRef, currentLocalRef: currentFetalSession.value.localRef })
    }
    if (takeContra && activeContraction.value && activeContraction.value.localRef !== takeContra.localRef) {
      conflicts.push({ kind: 'contra-active', legacyLocalRef: takeContra.localRef, currentLocalRef: activeContraction.value.localRef })
    }
    // ⑤ 幂等迁移（作用域盖章；去重键 startOpId / stopOp.opId / localRef；显式 null 原样保留）
    const stampScope = x => ({ ...x, scope })
    let adopted = 0
    if (conflicts.length === 0) {
      if (takeFetal && !currentFetalSession.value) {
        const t = stampScope(takeFetal)
        if (validFetalSessionShape(t)) { currentFetalSession.value = t; adopted++ }
        else unverifiable.push({ kind: 'fetal', localRef: takeFetal.localRef, reason: 'invalid-shape' })
      } else if (takeFetal && currentFetalSession.value && currentFetalSession.value.localRef === takeFetal.localRef) {
        adopted++ // 幂等：已迁入过
      }
      if (takeContra && !activeContraction.value) {
        const t = stampScope(takeContra)
        if (validContraRecordShape(t)) { activeContraction.value = t; adopted++ }
        else unverifiable.push({ kind: 'contra', localRef: takeContra.localRef, reason: 'invalid-shape' })
      } else if (takeContra && activeContraction.value && activeContraction.value.localRef === takeContra.localRef) {
        adopted++
      }
      for (const q of fetalQueueTake) {
        if (fetalFinishQueue.value.some(x => x && x.startOpId === q.startOpId)) continue // 幂等
        fetalFinishQueue.value = [...fetalFinishQueue.value, stampScope(q)]
        adopted++
      }
      for (const q of contraQueueTake) {
        const stopId = q.stopOp && q.stopOp.opId
        if (contraStopQueue.value.some(x => x && ((stopId && x.stopOp && x.stopOp.opId === stopId) || x.startOpId === q.startOpId))) continue
        contraStopQueue.value = [...contraStopQueue.value, stampScope(q)]
        adopted++
      }
      // 旧胎动历史并入当前历史头部（不覆盖；同 startTime+localRef 幂等跳过）
      for (const h of fetalHistory) {
        if (!h || typeof h !== 'object') continue
        if (fetalSessions.value.some(x => x && x.localRef && x.localRef === h.localRef)) continue
        fetalSessions.value = [...fetalSessions.value, h]
      }
    }
    // ⑥ 落盘 + 读回验证（任一失败 → 不删除旧键，返回部分成功事实，重试幂等）
    const pF = persistFetal(scope)
    const pC = persistContra(scope)
    const readBack = suffix => {
      try { const raw = uni.getStorageSync(scopedKey(scope, suffix)); return raw } catch (e) { return null }
    }
    const verifyOk = (() => {
      if (takeFetal && currentFetalSession.value && currentFetalSession.value.localRef === takeFetal.localRef) {
        const rb = readBack(FETAL_ACTIVE_SUFFIX)
        if (!rb) return false
      }
      if (takeContra && activeContraction.value && activeContraction.value.localRef === takeContra.localRef) {
        const rb = readBack(CONTRA_ACTIVE_SUFFIX)
        if (!rb) return false
      }
      return true
    })()
    let durable = pF.ok && pC.ok && verifyOk
    // ⑦ 全部迁移项耐久成功 → 删除旧键（备份已在手）；否则旧键全部保留
    const removedKeys = []
    if (durable && conflicts.length === 0 && rejected.length === 0 && unverifiable.length === 0) {
      for (const key of LEGACY_KEYS) {
        try {
          const raw = uni.getStorageSync(key)
          if (raw === '' || raw === null || raw === undefined) continue
          uni.removeStorageSync(key)
          removedKeys.push(key)
        } catch (e) { /* 删除失败：键保留，幂等重试会再见 */ }
      }
    } else if (durable && (rejected.length > 0 || unverifiable.length > 0 || conflicts.length > 0)) {
      // 部分迁入成功：仅删除"已被完整迁入且无争议"的来源键——保守起见：active 键仅当无冲突且其目标在盘；
      // 队列键仅当全部条目均已迁入（或按条目保留无法表达）——为最小安全面，这里只删 active 类
      if (takeFetal && !conflicts.some(c => c.kind === 'fetal-active') && readBack(FETAL_ACTIVE_SUFFIX)) {
        try { uni.removeStorageSync('momcare_fetal_active_session'); removedKeys.push('momcare_fetal_active_session') } catch (e) { }
      }
      if (takeContra && !conflicts.some(c => c.kind === 'contra-active') && readBack(CONTRA_ACTIVE_SUFFIX)) {
        try { uni.removeStorageSync('momcare_active_contraction'); removedKeys.push('momcare_active_contraction') } catch (e) { }
      }
    }
    scanLegacyKeys()
    return { ok: true, adopted, conflicts, rejected, unverifiable, removedKeys, backupKeys: backup.exported, fetalPersist: pF.ok, contraPersist: pC.ok }
  }

  // ── RAM 孤儿草稿区（审核第 8 条）──
  // 身份切换/退出时未落盘的活动草稿暂存于此：不向新身份展示、不上传云端；
  // 原作用域重新确认后由 restoreFromCache 回接。仅进程存活期有效（冷启动即失）。
  // 响应式容器：orphanDraftSummary 依赖其变化（非响应式数组会让 computed 永不失效）。
  const orphanDrafts = ref([])
  function stashOrphanDraft(kind, data) {
    if (!data || !data.scope || !data.localRef) return
    if (orphanDrafts.value.some(d => d.kind === kind && d.data.localRef === data.localRef)) return
    orphanDrafts.value.push({ kind, scope: data.scope, data })
  }
  const orphanDraftSummary = computed(() => orphanDrafts.value.map(d => ({ kind: d.kind, familyId: d.scope.familyId, memberId: d.scope.memberId })))

  // ── 身份切换（A06/A07 + 审核第 4 条）──
  // watch 基线从 store 创建时的实际会话初始化：首次通知即换人（store 创建于 mama
  // 已确认、第一次版本通知就是 papa）同样立即清内存。同成员同家庭重确认（回前台
  // 自动复核，R7 语义）不清——草稿/计时器保留。只清内存引用；各作用域磁盘键不删除
  //（各自成员回来自动恢复）；未落盘草稿先进孤儿区（不静默丢输入）。
  function clearToolsMemory() {
    if (currentFetalSession.value && fetalPersistFailed.value) stashOrphanDraft('fetal', currentFetalSession.value)
    if (activeContraction.value && contraPersistFailed.value) stashOrphanDraft('contra', activeContraction.value)
    currentFetalSession.value = null
    fetalSessions.value = []
    activeContraction.value = null
    contractionRecords.value = []
    fetalFinishQueue.value = []
    contraStopQueue.value = []
    fetalPersistFailed.value = false
    contraPersistFailed.value = false
    restoreWarnings.value = []
  }
  // F1：store 创建时扫描旧键存在性（只读；不解析正文入内存——正文仅在显式确认流程中取用）
  scanLegacyKeys()

  const sessionVersionForTools = subscribeSession()
  let lastWatchedMemberId = null
  let lastWatchedFamilyId = null
  {
    // 初始化基线 = 创建时实际确认成员（而非 null——防首次通知换人漏清，审核第 4 条）
    const s0 = getSessionState()
    if (s0.status === 'confirmed' && s0.member) {
      lastWatchedMemberId = s0.member.memberId
      lastWatchedFamilyId = s0.member.familyId
    }
  }
  watch(sessionVersionForTools, () => {
    const s = getSessionState()
    if (s.status !== 'confirmed' || !s.member) {
      clearToolsMemory()
      lastWatchedMemberId = null
      lastWatchedFamilyId = null
      return
    }
    const memberId = s.member.memberId
    const familyId = s.member.familyId
    if (lastWatchedMemberId !== null && (memberId !== lastWatchedMemberId || (lastWatchedFamilyId !== null && familyId !== lastWatchedFamilyId))) {
      clearToolsMemory()
    }
    lastWatchedMemberId = memberId
    lastWatchedFamilyId = familyId
  }, { immediate: false })

  // ══ 胎动状态机 ══

  async function startFetalSession(targetDurationMs = 3600000) {
    if (currentFetalSession.value) return { ok: false, code: 'session-exists' }
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session' }
    const scope = currentScope()
    if (!scope) return { ok: false, code: 'scope-incomplete', message: '身份作用域不完整（环境/应用/家庭/成员），不写缓存、不联网' }
    const session = {
      localRef: 'floc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      sessionId: null,            // 服务端 fst_ id（start 发送成功后采纳）
      startTime: Date.now(),
      targetDurationMs,
      status: 'running',
      pausedAt: null,
      clicks: [], validCount: 0, rawCount: 0,
      serverRevision: 0,          // 服务端已知 revision（start 成功后 =1）
      startOpId: newOpId('fst'),
      scope,                      // R1：创建时打作用域标签（env/AppID/家庭/成员）
      journal: []                 // 待发操作日志（click/undo/finish/discard——严格保序）
    }
    currentFetalSession.value = session
    const p = noteFetalPersist(persistFetal(session.scope))
    if (!p.ok) {
      // 本地未落盘——不得走 offline-pending（A04）；会话保留在内存（草稿不丢，重启会丢须告知）
      return {
        ok: false, code: 'local-persist-failed', persist: p.keys,
        message: '本地保存失败：本次监测暂存于内存，重启会丢失。请清理存储空间后重试。'
      }
    }
    return flushFetalPending(session)
  }

  function applyFetalView(session, view) {
    if (!view) return
    if (view.sessionId) session.sessionId = view.sessionId
    if (view.dateKey) session.dateKey = view.dateKey
    if (Number.isInteger(view.revision)) session.serverRevision = view.revision
    if (Array.isArray(view.clicks)) session.clicks = view.clicks
    if (Number.isInteger(view.validCount)) session.validCount = view.validCount
    if (Number.isInteger(view.rawCount)) session.rawCount = view.rawCount
    if (view.status) session.status = view.status === 'paused' ? 'running' : view.status
    if (view.endTime !== undefined) session.endTime = view.endTime
  }

  function localFetalRecalc(session) {
    const r = recomputeFetalClicks(session.clicks)
    session.clicks = r.clicks
    session.validCount = r.validCount
    session.rawCount = r.clicks.length
  }

  // 本地即时生效 + 日志入队 + 尝试发送（断网时仅本地与日志）——整体入串行链（防本地/采纳竞态）。
  // 入队时捕获会话身份；job 开工先对同一捕获身份+会话归属校验，切换后不改旧引用（审核第 7 条）。
  function recordFetalClick(now = Date.now()) {
    const session = currentFetalSession.value
    if (!session || session.status !== 'running') return Promise.resolve({ ok: false, code: 'no-active-session' })
    const captured = captureSession()
    return enqueueFetalJob(async () => {
      if (!isSameSession(captured) || currentFetalSession.value !== session || !scopeEquals(currentScope(), session.scope)) {
        return { ok: false, code: 'stale-session', message: '会话已切换，本次点击已取消（未记录）' }
      }
      session.clicks = [...session.clicks, { timestamp: now, valid: false }]
      localFetalRecalc(session)
      session.journal.push({ opId: newOpId('fck'), kind: 'click', payload: { timestamp: now } })
      const p = noteFetalPersist(persistFetal(session.scope))
      const r = await flushFetalPendingInner(session)
      if (!p.ok) {
        return {
          ok: false, code: 'local-persist-failed', persist: p.keys, ...(r.ok ? { cloudSynced: true } : {}),
          message: '点击已记录，但本地缓存保存失败（重启可能丢失此前记录）。请清理存储空间。'
        }
      }
      return r
    })
  }

  function undoFetalClick() {
    const session = currentFetalSession.value
    if (!session || session.status !== 'running') return Promise.resolve({ ok: false, code: 'no-active-session' })
    if (session.clicks.length === 0) return Promise.resolve({ ok: false, code: 'nothing-to-undo' })
    const captured = captureSession()
    return enqueueFetalJob(async () => {
      if (!isSameSession(captured) || currentFetalSession.value !== session || !scopeEquals(currentScope(), session.scope)) {
        return { ok: false, code: 'stale-session', message: '会话已切换，撤销已取消' }
      }
      session.clicks = session.clicks.slice(0, -1)
      localFetalRecalc(session)
      session.journal.push({ opId: newOpId('fun'), kind: 'undo', payload: {} })
      const p = noteFetalPersist(persistFetal(session.scope))
      const r = await flushFetalPendingInner(session)
      if (!p.ok) {
        return {
          ok: false, code: 'local-persist-failed', persist: p.keys, ...(r.ok ? { cloudSynced: true } : {}),
          message: '已撤销，但本地缓存保存失败（重启可能丢失此前记录）。请清理存储空间。'
        }
      }
      return r
    })
  }

  async function finishFetalSession({ syncDaily = true } = {}) {
    const session = currentFetalSession.value
    if (!session) return { ok: false, code: 'no-active-session' }
    if (session.status === 'completed' || session.status === 'discarded') return { ok: false, code: 'invalid-state' }
    if (!scopeEquals(currentScope(), session.scope)) {
      return { ok: false, code: 'scope-mismatch', message: '记录不属于当前成员，已停止操作' }
    }
    const endTime = Date.now()
    session.journal.push({ opId: newOpId('ffn'), kind: 'finish', payload: { endTime, syncDaily } })
    const p0 = noteFetalPersist(persistFetal(session.scope))
    const r = await flushFetalPending(session)
    // await 返回后再验一次：切换即挂起归档（内存+磁盘 journal 保留，原作用域恢复重试）
    if (!scopeEquals(currentScope(), session.scope)) {
      return { ok: false, code: 'scope-mismatch', message: '会话已切换，本地归档已挂起' }
    }
    if (r.ok) {
      const pf = finalizeLocalFetal(session, 'completed', endTime, true)
      if (p0.ok && pf.ok) return { ok: true }
      // 云端已同步但本地存档未全部落盘——如实报告部分成功（A05）
      return {
        ok: false, code: 'local-persist-failed', cloudSynced: true, persist: { ...p0.keys, ...pf.keys },
        message: '已完成并同步到云端，但本地记录保存未全部成功——请勿清理应用数据。'
      }
    }
    if (r.code === 'offline-pending') {
      // 断网：本地先行归档（pendingSync）+携日志副本入终态队列（重试时服务端补齐）。
      // offline-pending 语义保证此前落盘已确认成功；finalize 内部先耐久 queue 再清 active，
      // 归档写入失败仍如实报告且保留恢复路径（审核第 5 条）。
      fetalFinishQueue.value = [...fetalFinishQueue.value, session]
      const pf = finalizeLocalFetal(session, 'completed', endTime, false)
      if (pf.ok) return r
      return {
        ok: false, code: 'local-persist-failed', cause: 'offline', persist: pf.keys,
        message: '已离线记录，但本地存档保存未全部成功——请勿清理应用数据，联网后自动重试。'
      }
    }
    return r
  }

  async function discardFetalSession() {
    const session = currentFetalSession.value
    if (!session) return { ok: false, code: 'no-active-session' }
    if (!scopeEquals(currentScope(), session.scope)) {
      return { ok: false, code: 'scope-mismatch', message: '记录不属于当前成员，已停止操作' }
    }
    session.journal.push({ opId: newOpId('fds'), kind: 'discard', payload: {} })
    const p0 = noteFetalPersist(persistFetal(session.scope))
    const r = await flushFetalPending(session)
    if (!scopeEquals(currentScope(), session.scope)) {
      return { ok: false, code: 'scope-mismatch', message: '会话已切换，本地归档已挂起' }
    }
    if (r.ok) {
      const pf = finalizeLocalFetal(session, 'discarded', Date.now(), true)
      if (p0.ok && pf.ok) return { ok: true }
      return {
        ok: false, code: 'local-persist-failed', cloudSynced: true, persist: { ...p0.keys, ...pf.keys },
        message: '已放弃并同步到云端，但本地记录保存未全部成功——请勿清理应用数据。'
      }
    }
    if (r.code === 'offline-pending') {
      fetalFinishQueue.value = [...fetalFinishQueue.value, session]
      const pf = finalizeLocalFetal(session, 'discarded', Date.now(), false)
      if (pf.ok) return r
      return {
        ok: false, code: 'local-persist-failed', cause: 'offline', persist: pf.keys,
        message: '已离线记录，但本地存档保存未全部成功——请勿清理应用数据，联网后自动重试。'
      }
    }
    return r
  }

  // 终态本地归档（审核第 5 条耐久序 + R3 审核 3）：
  // - 离线路径（journal 未重放/stopOp 在）：queue（终态重试副本）先耐久，成功才清
  //   active——queue 写失败时磁盘 active（含 journal/stopOp）原样保留，冷启动重放收敛。
  // - 服务端已确认路径（status 已被服务端视图置为终态）：flush 已把"终态标记+journal
  //   凭据"落盘；queue+history 耐久后才清 journal 并清空 active。若最后的清空写失败，
  //   磁盘留下的是终态标记（restore 不复活为进行中）+ 幂等重放凭据，冷恢复对账收敛。
  // 最终真实结果推进未保存状态（R2 审核 4）：任一键失败立即置 fetalPersistFailed。
  function finalizeLocalFetal(session, status, endTime, synced) {
    const entry = {
      ...session,
      status, endTime, synced,
      validCount: session.validCount,
      rawCount: session.clicks.length
    }
    fetalSessions.value = [entry, ...fetalSessions.value].slice(0, 50)
    const keys = {}
    keys.queue = persistFetalQueue(session.scope)
    keys.history = persistFetalHistory(session.scope)
    const serverConfirmed = session.status === 'completed' || session.status === 'discarded'
    if (serverConfirmed) {
      if (keys.queue && keys.history) {
        session.journal = []
        currentFetalSession.value = null
        keys.active = persistFetalActive(session.scope)
      } else {
        keys.active = false
      }
    } else if (keys.queue) {
      currentFetalSession.value = null
      keys.active = persistFetalActive(session.scope)
    } else {
      // queue 未耐久：绝不清 active（内存与磁盘都保留 journal 恢复路径）
      keys.active = false
    }
    const p = { ok: keys.queue && keys.history && keys.active, keys }
    noteFetalPersist(p)
    return p
  }

  // 暂停/继续：仅本地展示层（冻结倒计时显示与点击入口）；服务端绝对会话不受影响
  function pauseFetalSession() {
    const session = currentFetalSession.value
    if (!session || session.status !== 'running') return false
    if (!scopeEquals(currentScope(), session.scope)) return false
    session.status = 'paused'
    session.pausedAt = Date.now()
    noteFetalPersist(persistFetal(session.scope))
    return true
  }
  function resumeFetalSession() {
    const session = currentFetalSession.value
    if (!session || session.status !== 'paused') return false
    if (!scopeEquals(currentScope(), session.scope)) return false
    session.status = 'running'
    session.pausedAt = null
    noteFetalPersist(persistFetal(session.scope))
    return true
  }

  // 严格保序发送：start（若未采纳 sessionId）→ journal 逐条（后 op 依赖前 op 服务端 revision）
  // 返回 {ok:true} 或 {ok:false, code:'offline-pending'|服务端错误码}；终态 op 成功附 terminal 标记
  // 并发互斥：页面按键常为 fire-and-forget——本地变更+发送整体链式排队（后发者看到的
  // 本地态必为前发者本地应用+服务端采纳后的值；杜绝并发 CAS 自冲突与本地/采纳竞态）
  let fetalFlushChain = Promise.resolve()
  function enqueueFetalJob(job) {
    const run = fetalFlushChain.then(job)
    fetalFlushChain = run.catch(() => {})
    return run
  }
  function flushFetalPending(session) {
    return enqueueFetalJob(() => flushFetalPendingInner(session))
  }
  // offline-pending 的前提是本地确实在盘（A04）：最近一次落盘失败时如实降级为
  // local-persist-failed——内存草稿保留、可恢复重试，绝不报"已暂存"。
  function offlineOrPersistFetal(mappedCode) {
    if (mappedCode === 'offline-pending' && fetalPersistFailed.value) return 'local-persist-failed'
    return mappedCode
  }
  async function flushFetalPendingInner(session) {
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session' }
    // 重试前置条件（A06–A08）：记录所属 scope 与当前会话一致——不一致不外呼、不写缓存
    if (!session.scope) return { ok: false, code: 'scope-missing', message: '记录缺少身份作用域，已隔离待人工处理' }
    if (!scopeEquals(currentScope(), session.scope)) return { ok: false, code: 'scope-mismatch', message: '记录不属于当前成员，已停止同步' }
    const sessionAtStart = captureSession()
    const sameIdentity = () => isSameSession(sessionAtStart) && scopeEquals(currentScope(), session.scope)
    if (!session.sessionId) {
      if (!sameIdentity()) return { ok: false, code: 'stale-session', message: '会话已切换，操作已取消' }
      let r
      try {
        r = await familyCall(TOOLS_FN, {
          action: 'fetal.start', startTime: session.startTime,
          targetDurationMs: session.targetDurationMs, operationId: session.startOpId
        })
      } catch (e) {
        r = { ok: false, code: 'cloud-call-failed' }
      }
      if (!r.ok) return { ok: false, code: offlineOrPersistFetal(mapOffline(r.code)), message: r.message }
      // 在途期间身份已变（A07）：响应不采纳、不落盘（防写新身份缓存/页面）
      if (!sameIdentity()) return { ok: false, code: 'stale-session', message: '会话已切换，响应已丢弃' }
      applyFetalView(session, r.data && r.data.session)
      noteFetalPersist(persistFetal(session.scope))
    }
    while (session.journal.length > 0) {
      const op = session.journal[0]
      // CAS：expectedRevision = 服务端当前版本（start 成功后=1；每次成功后随响应推进）
      const expected = session.serverRevision
      let call
      if (op.kind === 'click') {
        call = { action: 'fetal.click', sessionId: session.sessionId, timestamp: op.payload.timestamp, expectedRevision: expected, operationId: op.opId }
      } else if (op.kind === 'undo') {
        call = { action: 'fetal.undo', sessionId: session.sessionId, expectedRevision: expected, operationId: op.opId }
      } else if (op.kind === 'finish') {
        call = { action: 'fetal.finish', sessionId: session.sessionId, endTime: op.payload.endTime, syncDaily: op.payload.syncDaily === true, expectedRevision: expected, operationId: op.opId }
      } else {
        call = { action: 'fetal.discard', sessionId: session.sessionId, expectedRevision: expected, operationId: op.opId }
      }
      // 每次外呼前对同一捕获身份校验（审核第 7 条）
      if (!sameIdentity()) return { ok: false, code: 'stale-session', message: '会话已切换，操作已取消' }
      let r
      try {
        r = await familyCall(TOOLS_FN, call)
      } catch (e) {
        r = { ok: false, code: 'cloud-call-failed' }
      }
      if (!r.ok) return { ok: false, code: offlineOrPersistFetal(mapOffline(r.code)), message: r.message }
      if (!sameIdentity()) return { ok: false, code: 'stale-session', message: '会话已切换，响应已丢弃' }
      applyFetalView(session, r.data && r.data.session)
      if (op.kind === 'finish' || op.kind === 'discard') {
        // 终态 op：finalize 由调用方处理（本地历史/清理）。journal 保留在盘上（R3 审核 3：
        // 服务端视图已把 status 落成 completed/discarded——这是"不复活"标记；journal 是
        // 幂等重放凭据，清空必须等 finalize 耐久完成，绝不在此提前 wipe）。
        noteFetalPersist(persistFetal(session.scope))
        return { ok: true, terminal: { kind: op.kind, endTime: op.payload ? op.payload.endTime : null } }
      }
      session.journal = session.journal.slice(1)
      noteFetalPersist(persistFetal(session.scope))
    }
    return { ok: true }
  }

  function mapOffline(code) {
    // 暂时性失败（网络/云端不可达）→ 语义化 offline-pending（日志保留，可重试）
    if (code === 'cloud-call-failed' || code === 'malformed-result' || code === 'init-failed' || code === 'confirming') return 'offline-pending'
    return code
  }

  async function pullFetalSessions() {
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session' }
    if (fetalRecoveryBlocked.value) return { ok: false, code: 'recovery-blocked', domain: 'fetal', message: RECOVERY_BLOCKED_MESSAGE }
    const sessionAtStart = captureSession()
    const scope = currentScope()
    const sameIdentity = () => isSameSession(sessionAtStart) && scopeEquals(currentScope(), scope)
    const list = []
    let cursor = null
    let pages = 0
    do {
      // 逐页外呼前后都校验（审核第 7 条）：换身份即停，不以旧 cursor 调用新成员
      if (!sameIdentity()) return { ok: false, code: 'stale-session', message: '会话已切换，拉取中止' }
      const res = await familyCall(TOOLS_FN, { action: 'fetal.list', cursor, limit: 50 })
      if (!res.ok) return { ok: false, code: res.code, message: res.message }
      if (!sameIdentity()) return { ok: false, code: 'stale-session', message: '会话已切换，拉取中止' }
      list.push(...(res.data.sessions || []))
      cursor = res.data.nextCursor
      pages++
      if (pages > 20) return { ok: false, code: 'pagination-error' }
    } while (cursor)
    // 服务端历史视图（活跃本地会话仍在进行——不并入历史）
    fetalSessions.value = list.map(s => ({ ...s, synced: true }))
    noteFetalPersist(persistFetal(scope))
    return { ok: true }
  }

  // ══ 宫缩状态机 ══

  async function startContraction({ intensity = null, notes = null } = {}) {
    if (activeContraction.value) return { ok: false, code: 'contraction-ongoing' }
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session' }
    const scope = currentScope()
    if (!scope) return { ok: false, code: 'scope-incomplete', message: '身份作用域不完整（环境/应用/家庭/成员），不写缓存、不联网' }
    const record = {
      localRef: 'cloc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      recordId: null,
      startTime: Date.now(),
      status: 'ongoing',
      intensity, notes,
      startOpId: newOpId('cnt'),
      scope,                     // R1：创建时打作用域标签
      stopOp: null // {opId, endTime, intensity, notes}——stop 日志（断网保留）
    }
    activeContraction.value = record
    const p = noteContraPersist(persistContra(record.scope))
    if (!p.ok) {
      return {
        ok: false, code: 'local-persist-failed', persist: p.keys,
        message: '本地保存失败：本次宫缩暂存于内存，重启会丢失。请清理存储空间后重试。'
      }
    }
    return flushContraPending(record)
  }

  async function stopContraction({ intensity, notes } = {}) {
    const record = activeContraction.value
    if (!record) return { ok: false, code: 'no-active-contraction' }
    if (record.status === 'finished') {
      // R3 审核 3 降级路径：服务端已完成、本地归档写入失败仍在重试——不得再发新 stopOp
      return { ok: false, code: 'invalid-state', message: '本次宫缩已记录并同步云端，本地存档正在重试保存' }
    }
    if (!scopeEquals(currentScope(), record.scope)) {
      return { ok: false, code: 'scope-mismatch', message: '记录不属于当前成员，已停止操作' }
    }
    const endTime = Date.now()
    record.stopOp = {
      opId: newOpId('cst'), endTime,
      ...(intensity !== undefined ? { intensity } : {}),
      ...(notes !== undefined ? { notes } : {})
    }
    const stopInfo = record.stopOp // flush 成功会清 stopOp——先捕最终态凭据
    const p0 = noteContraPersist(persistContra(record.scope))
    const r = await flushContraPending(record)
    // await 返回后再验一次：切换即挂起归档
    if (!scopeEquals(currentScope(), record.scope)) {
      return { ok: false, code: 'scope-mismatch', message: '会话已切换，本地归档已挂起' }
    }
    if (r.ok) {
      const pf = finalizeLocalContra(record, stopInfo, true)
      if (p0.ok && pf.ok) return { ok: true }
      return {
        ok: false, code: 'local-persist-failed', cloudSynced: true, persist: { ...p0.keys, ...pf.keys },
        message: '已记录并同步到云端，但本地记录保存未全部成功——请勿清理应用数据。'
      }
    }
    if (r.code === 'offline-pending') {
      // 断网：本地先行入史（pendingSync）+携 stopOp 副本入队重试（服务端补齐后拉取刷新）。
      // finalize 先耐久 queue 再清 active；写失败保留恢复路径（审核第 5 条）。
      contraStopQueue.value = [...contraStopQueue.value, record]
      const pf = finalizeLocalContra(record, stopInfo, false)
      if (pf.ok) return r
      return {
        ok: false, code: 'local-persist-failed', cause: 'offline', persist: pf.keys,
        message: '已离线记录，但本地存档保存未全部成功——请勿清理应用数据，联网后自动重试。'
      }
    }
    return r
  }

  // 终态本地归档（审核第 5 条耐久序 + R3 审核 3）：
  // - 离线路径（stopOp 未重放）：queue（含 stopOp 凭据的副本）先耐久，成功才清 active。
  // - 服务端已确认路径（status 已被服务端视图置为 finished）：flush 已把"终态标记+
  //   stopOp 凭据"落盘；queue+history 耐久后才清 stopOp 并清空 active——最后的清空写
  //   失败时磁盘留终态标记（restore 不复活）+ 幂等凭据，冷恢复对账收敛。
  // 条目携带 scope（R3 审核 2：宫缩 history 异作用域条目恢复时不显示）。
  // 最终真实结果推进未保存状态（R2 审核 4，与 finalizeLocalFetal 同则）。
  function finalizeLocalContra(record, stopInfo, synced) {
    const entry = {
      recordId: record.recordId, localRef: record.localRef, startTime: record.startTime, endTime: stopInfo ? stopInfo.endTime : null,
      durationSec: stopInfo ? Math.round((stopInfo.endTime - record.startTime) / 1000) : null,
      intervalSec: record.intervalSec ?? null,
      intensity: stopInfo && stopInfo.intensity !== undefined ? stopInfo.intensity : record.intensity,
      notes: stopInfo && stopInfo.notes !== undefined ? stopInfo.notes : record.notes,
      status: 'finished', synced,
      scope: record.scope
    }
    // R3 终审 2：RAM 同则——未同步/冲突输入不因批量上限被挤出（新 entry 本身 synced=false 或已同步）
    const priorPending = contractionRecords.value.filter(r => r && r.status === 'finished' && r.synced === false)
    const priorRest = contractionRecords.value.filter(r => !(r && r.status === 'finished' && r.synced === false)).slice(0, entry.synced === false ? 100 : 99)
    contractionRecords.value = [entry, ...priorPending, ...priorRest]
    const keys = {}
    keys.queue = persistContraQueue(record.scope)
    keys.history = persistContraHistory(record.scope)
    const serverConfirmed = record.status === 'finished'
    if (serverConfirmed) {
      // 在线路径：record 不在队列中，清 stopOp 不影响任何凭据副本
      if (keys.queue && keys.history) {
        record.stopOp = null
        activeContraction.value = null
        keys.active = persistContraActive(record.scope)
      } else {
        keys.active = false
      }
    } else if (keys.queue) {
      activeContraction.value = null
      keys.active = persistContraActive(record.scope)
    } else {
      // queue 未耐久：绝不清 active（内存与磁盘都保留 stopOp 恢复路径）
      keys.active = false
    }
    const p = { ok: keys.queue && keys.history && keys.active, keys }
    noteContraPersist(p)
    return p
  }

  // 并发互斥（与 fetal 同理——起止并发/重试并发不自冲突）
  let contraFlushChain = Promise.resolve()
  function flushContraPending(record) {
    const run = contraFlushChain.then(() => flushContraPendingInner(record))
    contraFlushChain = run.catch(() => {})
    return run
  }
  function offlineOrPersistContra(mappedCode) {
    if (mappedCode === 'offline-pending' && contraPersistFailed.value) return 'local-persist-failed'
    return mappedCode
  }
  async function flushContraPendingInner(record) {
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session' }
    // 重试前置条件（A06–A08）：记录所属 scope 与当前会话一致
    if (!record.scope) return { ok: false, code: 'scope-missing', message: '记录缺少身份作用域，已隔离待人工处理' }
    if (!scopeEquals(currentScope(), record.scope)) return { ok: false, code: 'scope-mismatch', message: '记录不属于当前成员，已停止同步' }
    const sessionAtStart = captureSession()
    const sameIdentity = () => isSameSession(sessionAtStart) && scopeEquals(currentScope(), record.scope)
    if (!record.recordId) {
      if (!sameIdentity()) return { ok: false, code: 'stale-session', message: '会话已切换，操作已取消' }
      let r
      try {
        r = await familyCall(TOOLS_FN, {
          action: 'contraction.start', startTime: record.startTime,
          ...(record.intensity ? { intensity: record.intensity } : {}),
          ...(record.notes ? { notes: record.notes } : {}),
          operationId: record.startOpId
        })
      } catch (e) {
        r = { ok: false, code: 'cloud-call-failed' }
      }
      if (!r.ok) return { ok: false, code: offlineOrPersistContra(mapOffline(r.code)), message: r.message }
      if (!sameIdentity()) return { ok: false, code: 'stale-session', message: '会话已切换，响应已丢弃' }
      record.recordId = r.data.record.recordId
      record.intervalSec = r.data.record.intervalSec
      noteContraPersist(persistContra(record.scope))
    }
    if (record.stopOp) {
      const op = record.stopOp
      if (!sameIdentity()) return { ok: false, code: 'stale-session', message: '会话已切换，操作已取消' }
      let r
      try {
        r = await familyCall(TOOLS_FN, {
          action: 'contraction.stop', recordId: record.recordId, endTime: op.endTime,
          ...(op.intensity !== undefined ? { intensity: op.intensity } : {}),
          ...(op.notes !== undefined ? { notes: op.notes } : {}),
          expectedRevision: 1, operationId: op.opId
        })
      } catch (e) {
        r = { ok: false, code: 'cloud-call-failed' }
      }
      if (!r.ok) return { ok: false, code: offlineOrPersistContra(mapOffline(r.code)), message: r.message }
      if (!sameIdentity()) return { ok: false, code: 'stale-session', message: '会话已切换，响应已丢弃' }
      // R3 审核 3：服务端终态标记落盘（restore 不复活为进行中）；stopOp 保留为幂等
      // 重放凭据——清空必须等 finalize 耐久完成，绝不在此提前 wipe。
      const srv = r.data && r.data.record
      record.status = (srv && srv.status) || 'finished'
      noteContraPersist(persistContra(record.scope))
      return { ok: true, stopped: true }
    }
    return { ok: true }
  }

  async function deleteContraction(recordId) {
    if (!recordId) return { ok: false, code: 'invalid-params' }
    // expectedRevision 取本地已知的服务端版本（start=1、stop 后=2）
    const rec = contractionRecords.value.find(r => r && r.recordId === recordId)
    const expected = rec && Number.isInteger(rec.revision) ? rec.revision : 1
    let r
    try {
      r = await familyCall(TOOLS_FN, { action: 'contraction.delete', recordId, expectedRevision: expected, operationId: newOpId('cdl') })
    } catch (e) {
      r = { ok: false, code: 'cloud-call-failed' }
    }
    if (!r.ok) return { ok: false, code: mapOffline(r.code), message: r.message }
    return pullContractions()
  }

  async function pullContractions({ sinceMs } = {}) {
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session' }
    if (contraRecoveryBlocked.value) return { ok: false, code: 'recovery-blocked', domain: 'contraction', message: RECOVERY_BLOCKED_MESSAGE }
    const sessionAtStart = captureSession()
    const scope = currentScope()
    const sameScope = () => isSameSession(sessionAtStart) && scopeEquals(currentScope(), scope)
    // R3 A22：遍历全部页（服务端扫描预算可能返回空页+可继续游标——不误判结束），
    // 按 recordId 去重；游标不前进/页数超限受控失败（无静默无限循环）；
    // 逐页外呼前后校验身份——切换即中止，不以旧 cursor 调用新成员。
    const serverRecords = []
    const seen = new Set()
    let cursor = null
    let pages = 0
    for (;;) {
      if (!sameScope()) return { ok: false, code: 'stale-session', message: '会话已切换，拉取中止' }
      const res = await familyCall(TOOLS_FN, { action: 'contraction.list', limit: 100, cursor, ...(sinceMs ? { sinceMs } : {}) })
      if (!res.ok) return { ok: false, code: res.code, message: res.message }
      if (!sameScope()) return { ok: false, code: 'stale-session', message: '会话已切换，拉取中止' }
      for (const r of (res.data && res.data.records) || []) {
        const key = (r && r.recordId) || `local:${r && r.startTime}`
        if (!seen.has(key)) { seen.add(key); serverRecords.push(r) }
      }
      const next = (res.data && res.data.nextCursor) || null
      const more = res.data ? res.data.hasMore === true : false
      // R3 一审 5：服务端响应不一致（hasMore 与游标脱钩）→ 受控失败，绝不 break 后写入
      // "看似完整"的本地状态（部分列表冒充全量）
      if (more && !next) return { ok: false, code: 'pagination-error', message: '服务端响应不一致（hasMore 无游标）——已中止，未写入本页结果' }
      if (!more && next) return { ok: false, code: 'pagination-error', message: '服务端响应不一致（hasMore=false 但返回游标）——已中止' }
      pages++
      if (pages > 60) return { ok: false, code: 'pagination-error', message: '宫缩记录拉取超页数上限' }
      if (!more) break
      if (next === cursor) return { ok: false, code: 'pagination-error', message: '游标未前进' }
      cursor = next
    }
    // 服务端视图采纳为真源 + 保留本地未同步 pending（离线先行归档不丢，A22）。
    // R3 一审 4 + 二审 1：同 recordId 冲突判定——
    // - 服务端仍 ongoing（stop 未重放）→ 保留本地终态 pending，剔除服务端旧行；
    // - 服务端 finished 且终态凭据（endTime/intensity/notes）与本地完全一致 → 本地输入
    //   已完整反映（本人重放或等价提交）：采纳服务端权威行，消费对应队列项与本地副本；
    // - 服务端 finished 但凭据不一致（另一客户端抢先提交不同终态）→ 冲突：不凭状态
    //   判定本地 op 已确认——本地 pending 与 stop 队列保留（未同步可见），服务端行不顶替，
    //   直到本人重放成功或用户明确解决（重放将 revision-conflict 如实失败）。
    // 纯本地项（recordId 空）原样保留。
    const serverList = serverRecords.map(x => ({ ...x, synced: true }))
    const serverById = new Map(serverList.map(r => [r.recordId, r]))
    const keptPending = []
    const settledQueueDrop = [] // 凭据一致：本地输入已反映——待消费的队列项 recordId
    for (const lp of contractionRecords.value) {
      if (!(lp && lp.scope && scopeEquals(lp.scope, scope) && lp.status === 'finished' && lp.synced === false)) continue
      const sv = lp.recordId ? serverById.get(lp.recordId) : null
      if (!sv) { keptPending.push(lp); continue }
      if (sv.status !== 'finished') { serverById.delete(lp.recordId); keptPending.push(lp); continue }
      const norm = v => (v === undefined || v === null ? null : v)
      const sameTerminal = sv.endTime === lp.endTime && norm(sv.intensity) === norm(lp.intensity) && norm(sv.notes) === norm(lp.notes)
      if (sameTerminal) { settledQueueDrop.push(lp.recordId); continue } // 采纳服务端行，丢弃本地副本
      serverById.delete(lp.recordId) // 冲突：另一终态已抢先——本地输入保留可见
      keptPending.push(lp.conflict === true ? lp : { ...lp, conflict: true }) // R3 终审 1：页面可见冲突标记
    }
    if (settledQueueDrop.length > 0) {
      contraStopQueue.value = contraStopQueue.value.filter(q => !(q && settledQueueDrop.includes(q.recordId)))
    }
    contractionRecords.value = [...serverById.values(), ...keptPending].sort((a, b) => (b.startTime || 0) - (a.startTime || 0))
    noteContraPersist(persistContra(scope))
    return { ok: true }
  }

  // 统一重试入口（页面 onShow / 用户手动）：活跃日志 + 断网终态队列（成功后拉取刷新历史）。
  // 全程逐段校验捕获身份（R2 审核 1）：active/队列引用全部在入口捕获（await 之前），
  // 每个 await 返回后立即校验——旧重试调用到此立即结束，绝不重新读取并处理新身份的
  // 任何数据（活跃记录/队列/持久化）；persist 带 capturedScope 守卫，不写新作用域。
  // 恢复闸（R2 审核 6）：存在未确认的完整性警告时不做任何自动同步。
  async function retryPending() {
    // F2：按域放行——被阻断域如实返回 recovery-blocked（附 domain），允许的域独立继续；
    // code 字符串保持既有 'recovery-blocked'（旧断言不破坏）。
    const fetalBlocked = fetalRecoveryBlocked.value
    const contraBlocked = contraRecoveryBlocked.value
    const results = []
    if (fetalBlocked) results.push({ ok: false, code: 'recovery-blocked', domain: 'fetal', message: RECOVERY_BLOCKED_MESSAGE })
    if (contraBlocked) results.push({ ok: false, code: 'recovery-blocked', domain: 'contraction', message: RECOVERY_BLOCKED_MESSAGE })
    if (fetalBlocked && contraBlocked) return results
    const captured = captureSession()
    const capturedScope = currentScope()
    const sameIdentity = () => isSameSession(captured) && scopeEquals(currentScope(), capturedScope)
    const active = fetalBlocked ? null : currentFetalSession.value
    const rec = contraBlocked ? null : activeContraction.value
    if (active) {
      const r = await flushFetalPending(active)
      if (!sameIdentity()) { results.push(r); return results }
      results.push(r)
      // 终态重放成功（此前 finalize 未完成的恢复路径）：补齐本地归档
      if (r.ok && r.terminal && currentFetalSession.value === active && scopeEquals(currentScope(), active.scope)) {
        finalizeLocalFetal(active, r.terminal.kind === 'finish' ? 'completed' : 'discarded', r.terminal.endTime || Date.now(), true)
      }
    }
    if (!sameIdentity()) return results
    if (rec) {
      const stopInfo = rec.stopOp ? { ...rec.stopOp } : null
      const r = await flushContraPending(rec)
      if (!sameIdentity()) { results.push(r); return results }
      results.push(r)
      if (r.ok && r.stopped && activeContraction.value === rec && scopeEquals(currentScope(), rec.scope)) {
        finalizeLocalContra(rec, stopInfo, true)
      }
    }
    if (!sameIdentity()) return results
    // 刷新队列落盘状态（offline-pending 语义前提：队列确实在盘）；被阻断域跳过其全部段落
    if (!fetalBlocked) noteFetalPersist(persistFetal(capturedScope))
    // 断网终态队列：finish/discard 携日志重放（opId 稳定——服务端幂等不双写）。
    // flush 内部以"记录 scope == 当前会话"为前置——异成员队列项如实 scope-mismatch 停止。
    while (!fetalBlocked && fetalFinishQueue.value.length > 0) {
      if (!sameIdentity()) return results
      const queued = fetalFinishQueue.value[0]
      const r = await flushFetalPending(queued)
      results.push(r)
      if (!sameIdentity()) return results
      if (!r.ok) return results // 保序停止
      fetalFinishQueue.value = fetalFinishQueue.value.slice(1)
      noteFetalPersist(persistFetal(queued.scope))
      await pullFetalSessions().catch(() => {})
      if (!sameIdentity()) return results
    }
    if (!sameIdentity()) return results
    if (!contraBlocked) noteContraPersist(persistContra(capturedScope))
    while (!contraBlocked && contraStopQueue.value.length > 0) {
      if (!sameIdentity()) return results
      const queued = contraStopQueue.value[0]
      const r = await flushContraPending(queued)
      results.push(r)
      if (!sameIdentity()) return results
      if (!r.ok) {
        // R3 重放窗口（部分成功）：start 重放已获 recordId 而 stop 失败/中断——按 localRef
        // 把离线历史行（recordId=null）迁接为该服务端身份（不标 synced：stop 仍未完成）
        if (queued.localRef && queued.recordId) {
          const lr = contractionRecords.value.find(x => x && x.localRef === queued.localRef && (x.recordId === null || x.recordId === undefined))
          if (lr) {
            lr.recordId = queued.recordId
            noteContraPersist(persistContra(queued.scope)) // 迁接落盘（冷恢复读到服务端身份）
          }
        }
        // R3 终审 1：CAS 冲突（他方抢先终态）给本地未同步行打冲突标记——页面如实可见
        if (r.code === 'revision-conflict') {
          const row = contractionRecords.value.find(x => x && x.recordId === queued.recordId && x.synced === false && x.conflict !== true)
          if (row) {
            row.conflict = true
            noteContraPersist(persistContra(queued.scope))
          }
        }
        return results
      }
      contraStopQueue.value = contraStopQueue.value.slice(1)
      // R3 重启 3：离线 start 的队列项重放后获得 recordId——把离线时创建的本地历史行
      //（recordId=null、按 localRef 对应）迁接为该服务端身份并标已同步（同一输入单行收敛）
      if (queued.localRef) {
        const localRow = contractionRecords.value.find(x => x && x.localRef === queued.localRef && (x.recordId === null || x.recordId === undefined))
        if (localRow) {
          localRow.recordId = queued.recordId ?? localRow.recordId
          localRow.synced = true
          localRow.conflict = false
        }
      }
      noteContraPersist(persistContra(queued.scope))
      await pullContractions().catch(() => {})
      if (!sameIdentity()) return results
    }
    return results
  }

  // ══ 511 辅助参考（纯展示层计算——不构成医疗诊断）══
  const recentContractions = computed(() => {
    const cutoff = Date.now() - DAY_MS
    return contractionRecords.value
      .filter(r => r && r.status === 'finished' && r.startTime >= cutoff)
      .sort((a, b) => b.startTime - a.startTime)
  })
  const lastHourFinished = computed(() => {
    const cutoff = Date.now() - HOUR_MS
    return contractionRecords.value
      .filter(r => r && r.status === 'finished' && r.startTime >= cutoff)
      .sort((a, b) => a.startTime - b.startTime)
  })
  // R3 重启 1：未完成输入独立列表——不受最近一天展示窗限制（跨日待同步/冲突仍可见）；
  // 511 统计仍只看最近一小时（陈旧 pending 不计入统计）
  const unfinishedContractions = computed(() => {
    return contractionRecords.value
      .filter(r => r && r.status === 'finished' && r.synced === false)
      .sort((a, b) => (b.startTime || 0) - (a.startTime || 0))
  })
  const avgDurationSec = computed(() => {
    const list = lastHourFinished.value
    if (list.length === 0) return null
    const total = list.reduce((acc, r) => acc + (Number.isFinite(r.durationSec) ? r.durationSec : 0), 0)
    return Math.round(total / list.length)
  })
  const avgIntervalSec = computed(() => {
    const list = lastHourFinished.value
    if (list.length < 2) return null
    let total = 0
    for (let i = 1; i < list.length; i++) total += list[i].startTime - list[i - 1].startTime
    return Math.round(total / (list.length - 1) / 1000)
  })
  const is511Pattern = computed(() => {
    const list = lastHourFinished.value
    if (list.length < P511_MIN_COUNT) return false
    const avgI = avgIntervalSec.value
    const avgD = avgDurationSec.value
    if (avgI === null || avgD === null) return false
    if (avgI > P511_MAX_AVG_INTERVAL_SEC) return false
    if (avgD < P511_MIN_AVG_DURATION_SEC) return false
    const spanMs = list[list.length - 1].startTime - list[0].startTime
    if (spanMs < P511_MIN_SPAN_MS) return false
    return true
  })
  const disclaimer = P511_DISCLAIMER

  // 未保存状态（A04——页面真实披露，不以成功遮掩）
  const fetalUnsaved = computed(() => fetalPersistFailed.value)
  const contraUnsaved = computed(() => contraPersistFailed.value)

  // ══ 就医电话联动（孕期档案权威读取——缺号如实提示，不造假号码）══
  const hospitalName = computed(() => (familyStore.pregnancy && familyStore.pregnancy.fields && familyStore.pregnancy.fields.hospital) || '未设置')
  const doctorName = computed(() => (familyStore.pregnancy && familyStore.pregnancy.fields && familyStore.pregnancy.fields.doctor) || '未设置')
  const hospitalPhone = computed(() => (familyStore.pregnancy && familyStore.pregnancy.fields && familyStore.pregnancy.fields.hospitalPhone) || '')

  function callHospital() {
    const phone = hospitalPhone.value
    if (!phone) {
      uni.showModal({
        title: '尚未填写就医电话',
        content: '尚未在孕期档案中填写就医电话，请先去完善',
        showCancel: false,
        confirmText: '知道了'
      })
      return false
    }
    uni.makePhoneCall({ phoneNumber: phone })
    return true
  }

  // ══ E2 B 超三参数估重（Hadlock 1985——计算纯本地镜像+保存服务端权威）══
  const efwRecords = ref([]) // 历史估重记录（服务端视图，倒序）

  async function calculateEfw({ hc, ac, fl, unit = 'cm' }) {
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session' }
    let r
    try {
      r = await familyCall(TOOLS_FN, { action: 'efw.calculate', hc, ac, fl, unit })
    } catch (e) {
      r = { ok: false, code: 'cloud-call-failed' }
    }
    if (!r.ok) return { ok: false, code: r.code, message: r.message }
    return { ok: true, data: r.data }
  }

  async function saveEfwRecord({ dateKey, gestationalWeek, hc, ac, fl, unit = 'cm', bpd, reportId, notes }) {
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session' }
    let r
    try {
      r = await familyCall(TOOLS_FN, {
        action: 'efw.save', gestationalWeek, hc, ac, fl, unit,
        ...(bpd !== undefined && bpd !== null ? { bpd } : {}),
        ...(dateKey ? { dateKey } : {}),
        ...(reportId ? { reportId } : {}),
        ...(notes ? { notes } : {}),
        operationId: newOpId('efw')
      })
    } catch (e) {
      r = { ok: false, code: 'cloud-call-failed' }
    }
    if (!r.ok) return { ok: false, code: r.code, message: r.message }
    efwRecords.value = [r.data.record, ...efwRecords.value.filter(x => x.recordId !== r.data.record.recordId)]
    return { ok: true, record: r.data.record, replayed: Boolean(r.data.replayed) }
  }

  async function deleteEfwRecord(recordId) {
    if (!recordId) return { ok: false, code: 'invalid-params' }
    const rec = efwRecords.value.find(x => x && x.recordId === recordId)
    const expected = rec && Number.isInteger(rec.revision) ? rec.revision : 1
    const sessionAtStart = captureSession()
    let r
    try {
      r = await familyCall(TOOLS_FN, { action: 'efw.delete', recordId, expectedRevision: expected, operationId: newOpId('efwd') })
    } catch (e) {
      r = { ok: false, code: 'cloud-call-failed' }
    }
    // F2：删除事实与刷新结果分离反馈——云端删除成功就是成功，随后刷新失败不得误报"删除失败"。
    if (!r.ok) return { ok: false, code: r.code, message: r.message, deleted: false }
    // 立即移除已确认删除的本地行（防同键再次误删/旧活行残留）；会话已切换则不动新身份视图
    if (isSameSession(sessionAtStart)) {
      efwRecords.value = efwRecords.value.filter(x => !(x && x.recordId === recordId))
    }
    // 刷新独立进行：失败如实带回 refresh 字段（页面据此提示"已删除（列表刷新失败）"）
    const refresh = await pullEfwRecords()
    return {
      ok: true, deleted: true,
      refresh: { ok: refresh.ok === true, code: refresh.ok === true ? null : (refresh.code || 'refresh-failed'), message: refresh.ok === true ? null : (refresh.message || null) }
    }
  }

  async function pullEfwRecords() {
    // F2：EFW 历史为纯云端域——不设计时缓存恢复闸（胎动/宫缩缓存异常不阻断估重读取）。
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session' }
    const sessionAtStart = captureSession()
    const list = []
    let cursor = null
    let pages = 0
    do {
      // 逐页外呼前后都校验（审核第 7 条）：换身份即停
      if (!isSameSession(sessionAtStart)) return { ok: false, code: 'stale-session', message: '会话已切换，拉取中止' }
      const res = await familyCall(TOOLS_FN, { action: 'efw.list', cursor, limit: 50 })
      if (!res.ok) return { ok: false, code: res.code, message: res.message }
      if (!isSameSession(sessionAtStart)) return { ok: false, code: 'stale-session', message: '会话已切换，拉取中止' }
      list.push(...(res.data.records || []))
      cursor = res.data.nextCursor
      pages++
      if (pages > 20) return { ok: false, code: 'pagination-error' }
    } while (cursor)
    efwRecords.value = list
    return { ok: true }
  }

  // ══ E3 饮食/行为安全速查（本地字典同步快查——离线即开）+ AI 代理 ══
  // 本地检索：name/synonyms 子串匹配（大小写不敏感）+ category/level 过滤；
  // 未命中返回 []——绝不默认标安全（零假安全铁律）
  function searchSafetyDictionary({ keyword = '', category = 'all', level = '' } = {}) {
    const kw = String(keyword || '').trim().toLowerCase()
    return FOOD_SAFETY_ENTRIES.filter(e => {
      if (category && category !== 'all' && e.category !== category) return false
      if (level && e.level !== level) return false
      if (!kw) return true
      if (String(e.name).toLowerCase().includes(kw)) return true
      return (e.synonyms || []).some(s => String(s).toLowerCase().includes(kw))
    })
  }

  async function explainFoodWithAi({ query, stage } = {}) {
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session' }
    let r
    try {
      r = await familyCall(TOOLS_FN, { action: 'ai.explainFood', query, ...(stage ? { stage } : {}) })
    } catch (e) {
      r = { ok: false, code: 'cloud-call-failed' }
    }
    if (!r.ok) return { ok: false, code: r.code, message: r.message }
    return { ok: true, data: r.data }
  }

  async function analyzeReportWithAi({ reportId } = {}) {
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session' }
    if (!reportId) return { ok: false, code: 'invalid-params' }
    let r
    try {
      r = await familyCall(TOOLS_FN, { action: 'ai.analyzeReport', reportId })
    } catch (e) {
      r = { ok: false, code: 'cloud-call-failed' }
    }
    if (!r.ok) return { ok: false, code: r.code, message: r.message }
    return { ok: true, data: r.data }
  }

  return {
    currentFetalSession, fetalSessions, activeContraction, contractionRecords,
    fetalFinishQueue, contraStopQueue,
    fetalUnsaved, contraUnsaved, restoreWarnings, recoveryBlocked, fetalRecoveryBlocked, contraRecoveryBlocked, acknowledgeRestoreWarnings, orphanDraftSummary,
    legacyPending, legacySummaryText, confirmLegacyAdoption, exportLegacyRaw,
    recentContractions, unfinishedContractions, lastHourFinished, avgDurationSec, avgIntervalSec, is511Pattern, disclaimer,
    hospitalName, doctorName, hospitalPhone,
    efwRecords,
    startFetalSession, recordFetalClick, undoFetalClick, finishFetalSession, discardFetalSession,
    pauseFetalSession, resumeFetalSession, retryPending, restoreFromCache,
    pullFetalSessions, startContraction, stopContraction, deleteContraction, pullContractions,
    calculateEfw, saveEfwRecord, deleteEfwRecord, pullEfwRecords,
    searchSafetyDictionary, explainFoodWithAi, analyzeReportWithAi,
    callHospital
  }
})
