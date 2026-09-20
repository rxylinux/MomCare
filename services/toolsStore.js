// Phase E1 Step 2 计时工具 store（Pinia）：胎动连续计时 + 临产宫缩记录 + 511 辅助参考 + 就医电话联动。
// 读写经 sessionService.familyCall → mc-tools；本地持久化（momcare_fetal_active_session /
// momcare_active_contraction）承载切后台/冷启动/断网不丢。
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
import { ref, computed } from 'vue'
import { familyCall, currentEpoch, getSessionState } from '@/services/sessionService.js'
import { useFamilyStore } from '@/services/familyStore.js'
import foodSafetyJson from '@/static/data/food-safety.json'

export const FOOD_SAFETY_ENTRIES = Array.isArray(foodSafetyJson) ? foodSafetyJson : []

const FETAL_KEY = 'momcare_fetal_active_session'
const CONTRA_KEY = 'momcare_active_contraction'
const FETAL_HISTORY_KEY = 'momcare_fetal_sessions_history'
const FETAL_FINISH_QUEUE_KEY = 'momcare_fetal_finish_queue'   // 断网终态（finish/discard）重试队列
const CONTRA_STOP_QUEUE_KEY = 'momcare_contra_stop_queue'     // 断网 stop 重试队列
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

function readJson(key) {
  try {
    const raw = uni.getStorageSync(key)
    return raw ? JSON.parse(raw) : null
  } catch (e) {
    return null
  }
}
function writeJson(key, value) {
  try {
    uni.setStorageSync(key, JSON.stringify(value))
    return true
  } catch (e) {
    return false
  }
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
  const contractionRecords = ref([])      // 最近宫缩历史（服务端视图）
  // 断网终态队列：本地先行归档后，携日志的会话/记录副本留队重试——服务端补齐后拉取刷新
  const fetalFinishQueue = ref([])
  const contraStopQueue = ref([])

  function sessionReady() {
    const s = getSessionState()
    return s.status === 'confirmed' && s.member
  }

  function persistFetal() {
    writeJson(FETAL_KEY, currentFetalSession.value)
    writeJson(FETAL_HISTORY_KEY, fetalSessions.value.slice(0, 50))
    writeJson(FETAL_FINISH_QUEUE_KEY, fetalFinishQueue.value)
  }
  function persistContra() {
    writeJson(CONTRA_KEY, activeContraction.value)
    writeJson(CONTRA_STOP_QUEUE_KEY, contraStopQueue.value)
  }

  // 冷启动/切换恢复：本地持久态优先（活跃会话不因断网丢失；终态队列续重试）
  function restoreFromCache() {
    const s = readJson(FETAL_KEY)
    if (s && (s.status === 'running' || s.status === 'paused')) currentFetalSession.value = s
    const h = readJson(FETAL_HISTORY_KEY)
    if (Array.isArray(h)) fetalSessions.value = h
    const fq = readJson(FETAL_FINISH_QUEUE_KEY)
    if (Array.isArray(fq)) fetalFinishQueue.value = fq
    const c = readJson(CONTRA_KEY)
    if (c && c.status === 'ongoing') activeContraction.value = c
    const cq = readJson(CONTRA_STOP_QUEUE_KEY)
    if (Array.isArray(cq)) contraStopQueue.value = cq
  }

  // ══ 胎动状态机 ══

  async function startFetalSession(targetDurationMs = 3600000) {
    if (currentFetalSession.value) return { ok: false, code: 'session-exists' }
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
      journal: []                 // 待发操作日志（click/undo/finish/discard——严格保序）
    }
    currentFetalSession.value = session
    persistFetal()
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

  // 本地即时生效 + 日志入队 + 尝试发送（断网时仅本地与日志）——整体入串行链（防本地/采纳竞态）
  function recordFetalClick(now = Date.now()) {
    const session = currentFetalSession.value
    if (!session || session.status !== 'running') return Promise.resolve({ ok: false, code: 'no-active-session' })
    return enqueueFetalJob(async () => {
      session.clicks = [...session.clicks, { timestamp: now, valid: false }]
      localFetalRecalc(session)
      session.journal.push({ opId: newOpId('fck'), kind: 'click', payload: { timestamp: now } })
      persistFetal()
      return flushFetalPendingInner(session)
    })
  }

  function undoFetalClick() {
    const session = currentFetalSession.value
    if (!session || session.status !== 'running') return Promise.resolve({ ok: false, code: 'no-active-session' })
    if (session.clicks.length === 0) return Promise.resolve({ ok: false, code: 'nothing-to-undo' })
    return enqueueFetalJob(async () => {
      session.clicks = session.clicks.slice(0, -1)
      localFetalRecalc(session)
      session.journal.push({ opId: newOpId('fun'), kind: 'undo', payload: {} })
      persistFetal()
      return flushFetalPendingInner(session)
    })
  }

  async function finishFetalSession({ syncDaily = true } = {}) {
    const session = currentFetalSession.value
    if (!session) return { ok: false, code: 'no-active-session' }
    if (session.status === 'completed' || session.status === 'discarded') return { ok: false, code: 'invalid-state' }
    const endTime = Date.now()
    session.journal.push({ opId: newOpId('ffn'), kind: 'finish', payload: { endTime, syncDaily } })
    persistFetal()
    const r = await flushFetalPending(session)
    if (r.ok) {
      finalizeLocalFetal(session, 'completed', endTime, true)
    } else if (r.code === 'offline-pending') {
      // 断网：本地先行归档（pendingSync）+携日志副本入终态队列（重试时服务端补齐）
      fetalFinishQueue.value = [...fetalFinishQueue.value, session]
      finalizeLocalFetal(session, 'completed', endTime, false)
    }
    return r
  }

  async function discardFetalSession() {
    const session = currentFetalSession.value
    if (!session) return { ok: false, code: 'no-active-session' }
    session.journal.push({ opId: newOpId('fds'), kind: 'discard', payload: {} })
    persistFetal()
    const r = await flushFetalPending(session)
    if (r.ok) {
      finalizeLocalFetal(session, 'discarded', Date.now(), true)
    } else if (r.code === 'offline-pending') {
      fetalFinishQueue.value = [...fetalFinishQueue.value, session]
      finalizeLocalFetal(session, 'discarded', Date.now(), false)
    }
    return r
  }

  function finalizeLocalFetal(session, status, endTime, synced) {
    const entry = {
      ...session,
      status, endTime, synced,
      validCount: session.validCount,
      rawCount: session.clicks.length
    }
    fetalSessions.value = [entry, ...fetalSessions.value].slice(0, 50)
    currentFetalSession.value = null
    persistFetal()
  }

  // 暂停/继续：仅本地展示层（冻结倒计时显示与点击入口）；服务端绝对会话不受影响
  function pauseFetalSession() {
    const session = currentFetalSession.value
    if (!session || session.status !== 'running') return false
    session.status = 'paused'
    session.pausedAt = Date.now()
    persistFetal()
    return true
  }
  function resumeFetalSession() {
    const session = currentFetalSession.value
    if (!session || session.status !== 'paused') return false
    session.status = 'running'
    session.pausedAt = null
    persistFetal()
    return true
  }

  // 严格保序发送：start（若未采纳 sessionId）→ journal 逐条（后 op 依赖前 op 服务端 revision）
  // 返回 {ok:true} 或 {ok:false, code:'offline-pending'|服务端错误码}
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
  async function flushFetalPendingInner(session) {
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session' }
    if (!session.sessionId) {
      let r
      try {
        r = await familyCall(TOOLS_FN, {
          action: 'fetal.start', startTime: session.startTime,
          targetDurationMs: session.targetDurationMs, operationId: session.startOpId
        })
      } catch (e) {
        r = { ok: false, code: 'cloud-call-failed' }
      }
      if (!r.ok) return { ok: false, code: mapOffline(r.code), message: r.message }
      applyFetalView(session, r.data && r.data.session)
      persistFetal()
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
      let r
      try {
        r = await familyCall(TOOLS_FN, call)
      } catch (e) {
        r = { ok: false, code: 'cloud-call-failed' }
      }
      if (!r.ok) return { ok: false, code: mapOffline(r.code), message: r.message }
      applyFetalView(session, r.data && r.data.session)
      if (op.kind === 'finish' || op.kind === 'discard') {
        // 终态 op：finalize 已由调用方处理（本地历史/清理）
        session.journal = []
        persistFetal()
        return { ok: true }
      }
      session.journal = session.journal.slice(1)
      persistFetal()
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
    const list = []
    let cursor = null
    let pages = 0
    do {
      const res = await familyCall(TOOLS_FN, { action: 'fetal.list', cursor, limit: 50 })
      if (!res.ok) return { ok: false, code: res.code, message: res.message }
      list.push(...(res.data.sessions || []))
      cursor = res.data.nextCursor
      pages++
      if (pages > 20) return { ok: false, code: 'pagination-error' }
    } while (cursor)
    // 服务端历史视图（活跃本地会话仍在进行——不并入历史）
    fetalSessions.value = list.map(s => ({ ...s, synced: true }))
    writeJson(FETAL_HISTORY_KEY, fetalSessions.value.slice(0, 50))
    return { ok: true }
  }

  // ══ 宫缩状态机 ══

  async function startContraction({ intensity = null, notes = null } = {}) {
    if (activeContraction.value) return { ok: false, code: 'contraction-ongoing' }
    const record = {
      localRef: 'cloc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      recordId: null,
      startTime: Date.now(),
      status: 'ongoing',
      intensity, notes,
      startOpId: newOpId('cnt'),
      stopOp: null // {opId, endTime, intensity, notes}——stop 日志（断网保留）
    }
    activeContraction.value = record
    persistContra()
    return flushContraPending(record)
  }

  async function stopContraction({ intensity, notes } = {}) {
    const record = activeContraction.value
    if (!record) return { ok: false, code: 'no-active-contraction' }
    const endTime = Date.now()
    record.stopOp = {
      opId: newOpId('cst'), endTime,
      ...(intensity !== undefined ? { intensity } : {}),
      ...(notes !== undefined ? { notes } : {})
    }
    const stopInfo = record.stopOp // flush 成功会清 stopOp——先捕最终态凭据
    persistContra()
    const r = await flushContraPending(record)
    if (r.ok) {
      finalizeLocalContra(record, stopInfo, true)
    } else if (r.code === 'offline-pending') {
      // 断网：本地先行入史（pendingSync）+携 stopOp 副本入队重试（服务端补齐后拉取刷新）
      contraStopQueue.value = [...contraStopQueue.value, record]
      finalizeLocalContra(record, stopInfo, false)
    }
    return r
  }

  function finalizeLocalContra(record, stopInfo, synced) {
    const entry = {
      recordId: record.recordId, startTime: record.startTime, endTime: stopInfo ? stopInfo.endTime : null,
      durationSec: stopInfo ? Math.round((stopInfo.endTime - record.startTime) / 1000) : null,
      intervalSec: record.intervalSec ?? null,
      intensity: stopInfo && stopInfo.intensity !== undefined ? stopInfo.intensity : record.intensity,
      notes: stopInfo && stopInfo.notes !== undefined ? stopInfo.notes : record.notes,
      status: 'finished', synced
    }
    contractionRecords.value = [entry, ...contractionRecords.value].slice(0, 100)
    activeContraction.value = null
    persistContra()
  }

  // 并发互斥（与 fetal 同理——起止并发/重试并发不自冲突）
  let contraFlushChain = Promise.resolve()
  function flushContraPending(record) {
    const run = contraFlushChain.then(() => flushContraPendingInner(record))
    contraFlushChain = run.catch(() => {})
    return run
  }
  async function flushContraPendingInner(record) {
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session' }
    if (!record.recordId) {
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
      if (!r.ok) return { ok: false, code: mapOffline(r.code), message: r.message }
      record.recordId = r.data.record.recordId
      record.intervalSec = r.data.record.intervalSec
      persistContra()
    }
    if (record.stopOp) {
      const op = record.stopOp
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
      if (!r.ok) return { ok: false, code: mapOffline(r.code), message: r.message }
      record.stopOp = null
      persistContra()
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
    const res = await familyCall(TOOLS_FN, { action: 'contraction.list', limit: 100, ...(sinceMs ? { sinceMs } : {}) })
    if (!res.ok) return { ok: false, code: res.code, message: res.message }
    contractionRecords.value = (res.data.records || []).map(x => ({ ...x, synced: true }))
    return { ok: true }
  }

  // 统一重试入口（页面 onShow / 用户手动）：活跃日志 + 断网终态队列（成功后拉取刷新历史）
  async function retryPending() {
    const results = []
    if (currentFetalSession.value) results.push(await flushFetalPending(currentFetalSession.value))
    if (activeContraction.value) results.push(await flushContraPending(activeContraction.value))
    // 断网终态队列：finish/discard 携日志重放（opId 稳定——服务端幂等不双写）
    while (fetalFinishQueue.value.length > 0) {
      const queued = fetalFinishQueue.value[0]
      const r = await flushFetalPending(queued)
      results.push(r)
      if (!r.ok) break // 保序停止
      fetalFinishQueue.value = fetalFinishQueue.value.slice(1)
      persistFetal()
      await pullFetalSessions().catch(() => {})
    }
    while (contraStopQueue.value.length > 0) {
      const queued = contraStopQueue.value[0]
      const r = await flushContraPending(queued)
      results.push(r)
      if (!r.ok) break
      contraStopQueue.value = contraStopQueue.value.slice(1)
      persistContra()
      await pullContractions().catch(() => {})
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
    let r
    try {
      r = await familyCall(TOOLS_FN, { action: 'efw.delete', recordId, expectedRevision: expected, operationId: newOpId('efwd') })
    } catch (e) {
      r = { ok: false, code: 'cloud-call-failed' }
    }
    if (!r.ok) return { ok: false, code: r.code, message: r.message }
    return pullEfwRecords()
  }

  async function pullEfwRecords() {
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session' }
    const list = []
    let cursor = null
    let pages = 0
    do {
      const res = await familyCall(TOOLS_FN, { action: 'efw.list', cursor, limit: 50 })
      if (!res.ok) return { ok: false, code: res.code, message: res.message }
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
    recentContractions, avgDurationSec, avgIntervalSec, is511Pattern, disclaimer,
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
