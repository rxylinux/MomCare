'use strict'

// mc-tools：Phase E1 计时工具权威服务端（胎动连续计时会话 + 临产宫缩记录）。
//
// 权威设计：docs/PHASE_E_SPECIFICATION_AND_PLAN.md §二 + ZCODE_SIX_FEATURES_FOLLOWUP_SCOPE.md §E1。
//
// 核心语义：
// - 胎动会话（mc_fetal_sessions，fst_<16hex>）：startTime 绝对时间戳（客户端提供或服务端默认）
//   ——后台/冷启动由绝对时间差校准（客户端职责）；clicks[] 保留**原始点击流水**（不删不改），
//   validCount 按 5 分钟连击去重合并重算（相邻两次点击间隔 ≤300,000ms 计同一次胎动；簇首
//   valid=true、合并续击 valid=false——严格计数=validCount、原始计数=clicks.length 双视角）；
//   undo 仅移除最后插入的点击并重算；finish 固化 endTime+validCount（可选 syncDaily 同事务
//   **累计**回写 mc_health_daily 当日 fetalCount——operationId 幂等保证重放不双计）；
//   discard 丢弃会话（不产生任何计数）。
// - 宫缩记录（mc_contraction_records，cnt_<16hex>）：durationSec=同次 endTime-startTime；
//   intervalSec=与**开始时间早于本次**的最近一条未废弃记录的 startTime 差（乱序补录按 startTime
//   定位前驱——不依赖插入顺序）；stop 仅 ongoing 可用；delete=软废弃（默认列表排除——误录不污染
//   511 分析；后续新记录的 interval 不引用已废弃记录）。未结束记录 durationSec=null。
// - 幂等/并发：mc_operations 键 memberId:operationId + **单向 SHA-256 摘要**（回执不落原始参数）；
//   重放按当前实体重新生成响应（click 重放绝不重复追加）；revision CAS（连击并发由冲突重试收敛）。
// - 安全：resolveCaller 可信身份；非家庭成员在身份层即拒；实体按 familyId 校验（跨家庭=不存在）。
// - 边界如实：无任何"正常/危险"阈值或诊断推断（511 分析属客户端展示层——服务端只供真实数据）。

const { randomBytes, createHash } = require('node:crypto')
const { loadServerConfig } = require('./shared/config')
const { resolveCaller } = require('./shared/auth')
const { ok, fail, stableRequestHash } = require('./shared/respond')
const { COLLECTIONS } = require('./shared/constants')

let cloud = null
try {
  cloud = require('wx-server-sdk')
} catch (e) {
  cloud = null
}
exports.__setCloud = function __setCloud(mockCloud) { cloud = mockCloud }

const FETAL = 'mc_fetal_sessions'
const CONTRA = 'mc_contraction_records'
const EFW = 'mc_efw_records'
const OPS = COLLECTIONS.operations
const HEALTH_DAILY = 'mc_health_daily'

// ── E2 Hadlock 1985 三参数估重（LOINC 11746-5）──
// log10(EFW_g)=1.326−0.00326×AC×FL+0.0107×HC+0.0438×AC+0.158×FL（单位 cm）
// 锚点：HC=32.0/AC=30.0/FL=6.5 → log10=3.37370 → 2364.29g（测试必钉）
// BPD 不参与本公式（不可替代缺失 HC——只作伴随测量存储）
const HADLOCK_FORMULA = 'hadlock_hc_ac_fl_1985_v1'
const EFW_RANGES = { hc: [10.0, 42.0], ac: [10.0, 45.0], fl: [1.0, 10.0] } // cm
const EFW_WEEK_RANGE = [12, 42]

const SESSION_STATUS = ['running', 'completed', 'discarded']
const CONTRA_STATUS = ['ongoing', 'finished', 'discarded']
const INTENSITY_LEVELS = ['mild', 'moderate', 'strong']
const MERGE_WINDOW_MS = 5 * 60 * 1000   // 连击去重窗口：相邻点击间隔 ≤5 分钟计同一次胎动
const FUTURE_SKEW_MS = 5 * 60 * 1000    // 客户端时钟前偏容忍（超出拒绝——防未来时间戳）
const TARGET_DEFAULT_MS = 60 * 60 * 1000
const TARGET_MAX_MS = 24 * 60 * 60 * 1000
const NOTES_MAX = 200
const PAGE_DEFAULT = 20
const PAGE_MAX = 100
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const ID_MAX = 128

async function getDocMaybe(db, col, id) {
  try {
    const r = await db.collection(col).doc(id).get()
    return (r && r.data) || null
  } catch (e) {
    const msg = String((e && (e.errMsg || e.message)) || e)
    if (/not\s*exist|does not exist/i.test(msg)) return null
    throw e
  }
}

// 请求摘要（单向 SHA-256——回执不落原始参数；notes 等文本不持久进 mc_operations）
function digestOf(obj) {
  return createHash('sha256').update(stableRequestHash(obj), 'utf8').digest('hex')
}

// Asia/Shanghai 日号（与 mc-health/familyStore 同式——家庭时区口径）
function shanghaiDateKey(ms) {
  const sh = new Date(ms + (8 * 60 + new Date(ms).getTimezoneOffset()) * 60000)
  return `${sh.getFullYear()}-${String(sh.getMonth() + 1).padStart(2, '0')}-${String(sh.getDate()).padStart(2, '0')}`
}

function parseExpectedRevision(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
  return value
}

// 时间戳校验：有限整数毫秒；允许 ≤5 分钟未来偏斜（设备时钟）；不设过去下限（离线补录合法）
function parseTimestampMs(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null
  if (value > Date.now() + FUTURE_SKEW_MS) return null
  return value
}

function stripId(doc) {
  const { _id, ...rest } = doc || {}
  return rest
}

function sortKeyOf(ms, id) {
  return `${String(ms).padStart(16, '0')}:${id}`
}

// ── 胎动有效计数重算（纯函数）：按时间戳升序聚类——簇间隔 >MERGE_WINDOW_MS 开新簇；
// 簇首 valid=true（计入），合并续击 valid=false（保留流水不计次）。clicks 数组保持插入序，
// valid 标志按聚类结果回写对应项。 ──
function recomputeClicks(clicks) {
  const list = (Array.isArray(clicks) ? clicks : []).map(c => ({ timestamp: c.timestamp }))
  const order = list.map((c, i) => i).sort((a, b) => list[a].timestamp - list[b].timestamp)
  const validOf = new Array(list.length).fill(false)
  let prevIdx = -1
  for (const idx of order) {
    if (prevIdx < 0 || list[idx].timestamp - list[prevIdx].timestamp > MERGE_WINDOW_MS) {
      validOf[idx] = true // 新簇首——计一次有效胎动
    }
    prevIdx = idx
  }
  let validCount = 0
  const out = list.map((c, i) => {
    if (validOf[i]) validCount++
    return { timestamp: c.timestamp, valid: validOf[i] }
  })
  return { clicks: out, validCount }
}

function viewSession(doc) {
  if (!doc) return null
  return {
    sessionId: doc._id || doc.sessionId,
    memberId: doc.memberId,
    dateKey: doc.dateKey,
    status: doc.status,
    startTime: doc.startTime,
    endTime: doc.endTime ?? null,
    targetDurationMs: doc.targetDurationMs,
    clicks: Array.isArray(doc.clicks) ? doc.clicks : [],
    validCount: Number.isInteger(doc.validCount) ? doc.validCount : 0,
    rawCount: Array.isArray(doc.clicks) ? doc.clicks.length : 0,
    revision: doc.revision,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  }
}

function viewRecord(doc) {
  if (!doc) return null
  return {
    recordId: doc._id || doc.recordId,
    memberId: doc.memberId,
    dateKey: doc.dateKey,
    startTime: doc.startTime,
    endTime: doc.endTime ?? null,
    durationSec: doc.durationSec ?? null,
    intervalSec: doc.intervalSec ?? null,
    intensity: doc.intensity ?? null,
    notes: doc.notes ?? null,
    status: doc.status,
    revision: doc.revision,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  }
}

// ── 幂等操作守卫（事务内首查；回执=摘要+实体指针，重放按当前实体重新生成响应）──
async function opGuard(t, opKey, opDoc) {
  const prev = await getDocMaybe(t, OPS, opKey)
  if (!prev) return { ready: true }
  if (prev.requestHash !== opDoc.requestHash) {
    await t.rollback()
    return { replayed: fail('operation-id-conflict', '同一 operationId 曾以不同内容提交') }
  }
  return { replayed: 'ok', entity: prev.entity }
}

function txFailed(err) {
  return fail('transaction-failed', '事务未提交成功，可安全重试', {
    errMsg: String((err && (err.errMsg || err.message)) || err).slice(0, 200)
  })
}

// 前驱宫缩定位（intervalSec 计算凭据）：startTime 严格早于本次、未废弃的最近一条（家庭范围）。
// 事务外读取（interval=插入时快照；并发插入的极小竞态可接受——511 分析可由列表原始 startTime 重算）。
async function findPriorContraction(db, fid, startTime) {
  const res = await db.collection(CONTRA).where({ familyId: fid }).orderBy('startTime', 'desc').limit(100).get()
  const rows = (res && res.data) || []
  for (const r of rows) {
    if (r.status === 'discarded') continue
    if (r.startTime < startTime) return r
  }
  return null
}

exports.main = async function main(event) {
  if (!cloud) return fail('sdk-unavailable', 'wx-server-sdk 不可用')
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, throwOnNotFound: false })
  const config = loadServerConfig()
  const resolved = resolveCaller(cloud, config, event)
  if (!resolved.ok) return fail(resolved.code, resolved.message)
  const caller = resolved.caller
  const action = event && event.action
  const db = cloud.database()
  const fid = config.familyId
  const READ_ACTIONS = ['fetal.list', 'contraction.list', 'efw.calculate', 'efw.list']
  if (!READ_ACTIONS.includes(action)) {
    if (!event.operationId || typeof event.operationId !== 'string' || event.operationId.length > 64) {
      return fail('invalid-params', '缺少有效 operationId')
    }
  }

  // ══ 胎动会话 ══

  if (action === 'fetal.start') {
    const startTime = event.startTime === undefined || event.startTime === null ? Date.now() : parseTimestampMs(event.startTime)
    if (startTime === null) return fail('invalid-params', 'startTime 须有限整数毫秒（允许 ≤5 分钟未来偏斜）')
    let targetDurationMs = TARGET_DEFAULT_MS
    if (event.targetDurationMs !== undefined && event.targetDurationMs !== null) {
      if (!Number.isInteger(event.targetDurationMs) || event.targetDurationMs < 1 || event.targetDurationMs > TARGET_MAX_MS) {
        return fail('invalid-params', `targetDurationMs 须 1..${TARGET_MAX_MS} 毫秒`)
      }
      targetDurationMs = event.targetDurationMs
    }
    const now = Date.now()
    const sessionId = 'fst_' + randomBytes(8).toString('hex')
    const opKey = `${caller.memberId}:${event.operationId}`
    const opDoc = {
      memberId: caller.memberId, operationId: event.operationId, kind: 'tools-fetal-start',
      requestHash: digestOf({ startTime, targetDurationMs })
    }
    const t = await db.startTransaction()
    try {
      const guard = await opGuard(t, opKey, opDoc)
      if (guard.replayed === 'ok') {
        const cur = guard.entity && guard.entity.collection === FETAL ? await getDocMaybe(t, FETAL, guard.entity.docId) : null
        await t.rollback()
        return ok({ replayed: true, session: viewSession(cur) })
      }
      if (guard.replayed) return guard.replayed
      const doc = {
        familyId: fid, memberId: caller.memberId, dateKey: shanghaiDateKey(startTime),
        status: 'running', startTime, endTime: null, targetDurationMs,
        clicks: [], validCount: 0,
        revision: 1, createdAt: now, updatedAt: now,
        sortKey: sortKeyOf(startTime, sessionId)
      }
      await t.collection(FETAL).doc(sessionId).set({ data: { ...doc } })
      await t.collection(OPS).doc(opKey).set({
        data: { ...opDoc, entity: { collection: FETAL, docId: sessionId }, createdAt: now }
      })
      await t.commit()
      return ok({ session: viewSession({ ...doc, _id: sessionId }) })
    } catch (err) {
      try { await t.rollback() } catch (e) { /* 已回滚 */ }
      return txFailed(err)
    }
  }

  if (action === 'fetal.click' || action === 'fetal.undo' || action === 'fetal.finish' || action === 'fetal.discard') {
    const sessionId = event.sessionId
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > ID_MAX) return fail('invalid-params', '缺少有效 sessionId')
    const expected = parseExpectedRevision(event.expectedRevision)
    if (expected === null) return fail('invalid-params', 'expectedRevision 必须是显式非负整数')

    let requestChanges = {}
    if (action === 'fetal.click') {
      const ts = parseTimestampMs(event.timestamp)
      if (ts === null) return fail('invalid-params', 'timestamp 须有限整数毫秒（允许 ≤5 分钟未来偏斜）')
      requestChanges = { timestamp: ts }
    }
    const opKey = `${caller.memberId}:${event.operationId}`
    const opDoc = {
      memberId: caller.memberId, operationId: event.operationId, kind: `tools-${action.replace('.', '-')}`,
      requestHash: digestOf({ sessionId, expectedRevision: expected, ...(action === 'fetal.finish' ? { syncDaily: event.syncDaily === true } : {}), ...requestChanges })
    }
    const now = Date.now()
    const t = await db.startTransaction()
    try {
      const guard = await opGuard(t, opKey, opDoc)
      if (guard.replayed === 'ok') {
        const cur = guard.entity && guard.entity.collection === FETAL ? await getDocMaybe(t, FETAL, guard.entity.docId) : null
        await t.rollback()
        return ok({ replayed: true, session: viewSession(cur) })
      }
      if (guard.replayed) return guard.replayed

      const session = await getDocMaybe(t, FETAL, sessionId)
      if (!session || session.familyId !== fid) { await t.rollback(); return fail('not-found', '会话不存在') }
      if (expected !== session.revision) {
        await t.rollback()
        return fail('revision-conflict', '会话已被更新（并发点击/操作），请以当前版本重试', {
          currentRevision: session.revision, currentSession: viewSession(session)
        })
      }

      const merged = { ...stripId(session) }
      let dailySyncResult = null
      if (action === 'fetal.click') {
        if (session.status !== 'running') { await t.rollback(); return fail('invalid-state', `仅 running 会话可点击（当前 ${session.status}）`) }
        if (requestChanges.timestamp < session.startTime) {
          await t.rollback(); return fail('invalid-params', `点击时间戳早于会话开始（${requestChanges.timestamp} < ${session.startTime}）`)
        }
        merged.clicks = [...(session.clicks || []), { timestamp: requestChanges.timestamp }]
        const recomputed = recomputeClicks(merged.clicks)
        merged.clicks = recomputed.clicks
        merged.validCount = recomputed.validCount
      } else if (action === 'fetal.undo') {
        if (session.status !== 'running') { await t.rollback(); return fail('invalid-state', `仅 running 会话可撤销（当前 ${session.status}）`) }
        if (!Array.isArray(session.clicks) || session.clicks.length === 0) {
          await t.rollback(); return fail('invalid-state', '没有可撤销的点击')
        }
        merged.clicks = session.clicks.slice(0, -1) // 撤销最后插入的点击（保留其余原始流水）
        const recomputed = recomputeClicks(merged.clicks)
        merged.clicks = recomputed.clicks
        merged.validCount = recomputed.validCount
      } else if (action === 'fetal.finish') {
        if (session.status !== 'running') { await t.rollback(); return fail('invalid-state', `仅 running 会话可完成（当前 ${session.status}）`) }
        const endTime = event.endTime === undefined || event.endTime === null ? now : parseTimestampMs(event.endTime)
        if (endTime === null) return fail('invalid-params', 'endTime 须有限整数毫秒')
        if (endTime < session.startTime) { await t.rollback(); return fail('invalid-params', 'endTime 早于 startTime') }
        merged.status = 'completed'
        merged.endTime = endTime
        // 可选联动（同事务）：当日 mc_health_daily.fetalCount 累计 +validCount——
        // operationId 幂等（重放不二次回写）；日记录不存在则创建；已删除墓碑则跳过不复活
        if (event.syncDaily === true) {
          const dailyId = `${fid}:${session.dateKey}`
          const daily = await getDocMaybe(t, HEALTH_DAILY, dailyId)
          if (daily && daily.deleted) {
            dailySyncResult = 'skipped-daily-deleted'
          } else if (daily) {
            const fields = { ...(daily.fields || {}) }
            fields.fetalCount = (typeof fields.fetalCount === 'number' && Number.isFinite(fields.fetalCount) ? fields.fetalCount : 0) + merged.validCount
            await t.collection(HEALTH_DAILY).doc(dailyId).set({
              data: { ...stripId(daily), fields, revision: (daily.revision || 0) + 1, updatedBy: caller.memberId, updatedAt: now }
            })
            dailySyncResult = 'synced'
          } else {
            await t.collection(HEALTH_DAILY).doc(dailyId).set({
              data: {
                familyId: fid, type: 'daily', dateKey: session.dateKey,
                fields: { fetalCount: merged.validCount },
                schemaVersion: 1, revision: 1, updatedBy: caller.memberId, updatedAt: now
              }
            })
            dailySyncResult = 'created'
          }
        }
      } else {
        // discard
        if (session.status !== 'running') { await t.rollback(); return fail('invalid-state', `仅 running 会话可废弃（当前 ${session.status}）`) }
        merged.status = 'discarded'
        merged.endTime = now
      }
      merged.revision = session.revision + 1
      merged.updatedAt = now
      await t.collection(FETAL).doc(sessionId).set({ data: merged })
      await t.collection(OPS).doc(opKey).set({
        data: { ...opDoc, entity: { collection: FETAL, docId: sessionId }, createdAt: now }
      })
      await t.commit()
      const view = viewSession({ ...merged, _id: sessionId })
      return ok({ session: view, ...(dailySyncResult ? { dailySync: dailySyncResult } : {}) })
    } catch (err) {
      try { await t.rollback() } catch (e) { /* 已回滚 */ }
      return txFailed(err)
    }
  }

  if (action === 'fetal.list') {
    const limitRaw = Number(event.limit || PAGE_DEFAULT)
    const limit = Math.min(Math.max(Number.isInteger(limitRaw) ? limitRaw : PAGE_DEFAULT, 1), PAGE_MAX)
    const cursor = (typeof event.cursor === 'string' && event.cursor) || null
    if (event.status !== undefined && event.status !== null && !SESSION_STATUS.includes(event.status)) {
      return fail('invalid-params', `status 须 ${SESSION_STATUS.join('/')}`)
    }
    if (event.dateKey !== undefined && event.dateKey !== null && !DATE_RE.test(String(event.dateKey))) {
      return fail('invalid-params', 'dateKey 须 YYYY-MM-DD')
    }
    const cmd = db.command
    const where = { familyId: fid }
    if (event.status) where.status = event.status
    if (event.dateKey) where.dateKey = event.dateKey
    if (cursor) where.sortKey = cmd.lt(cursor)
    const res = await db.collection(FETAL).where(where).orderBy('sortKey', 'desc').limit(limit).get()
    const rows = (res && res.data) || []
    const last = rows[rows.length - 1]
    const nextCursor = rows.length === limit && last ? last.sortKey : null
    return ok({ sessions: rows.map(viewSession), nextCursor, hasMore: Boolean(nextCursor) })
  }

  // ══ 宫缩记录 ══

  if (action === 'contraction.start') {
    const startTime = event.startTime === undefined || event.startTime === null ? Date.now() : parseTimestampMs(event.startTime)
    if (startTime === null) return fail('invalid-params', 'startTime 须有限整数毫秒（允许 ≤5 分钟未来偏斜）')
    let intensity = event.intensity === undefined || event.intensity === null ? null : event.intensity
    if (intensity !== null && !INTENSITY_LEVELS.includes(intensity)) {
      return fail('invalid-params', `intensity 须 ${INTENSITY_LEVELS.join('/')} 或 null`)
    }
    let notes = event.notes === undefined || event.notes === null ? null : event.notes
    if (notes !== null && (typeof notes !== 'string' || notes.length > NOTES_MAX)) {
      return fail('invalid-params', `notes 须 ≤${NOTES_MAX} 字文本`)
    }
    const now = Date.now()
    const recordId = 'cnt_' + randomBytes(8).toString('hex')
    const opKey = `${caller.memberId}:${event.operationId}`
    const opDoc = {
      memberId: caller.memberId, operationId: event.operationId, kind: 'tools-contraction-start',
      requestHash: digestOf({ startTime, intensity: intensity ?? null, notes: notes ?? null })
    }
    // 间隔前驱：事务外读取（见 findPriorContraction 注释——插入时快照语义）
    const prior = await findPriorContraction(db, fid, startTime)
    const t = await db.startTransaction()
    try {
      const guard = await opGuard(t, opKey, opDoc)
      if (guard.replayed === 'ok') {
        const cur = guard.entity && guard.entity.collection === CONTRA ? await getDocMaybe(t, CONTRA, guard.entity.docId) : null
        await t.rollback()
        return ok({ replayed: true, record: viewRecord(cur) })
      }
      if (guard.replayed) return guard.replayed
      const intervalSec = prior ? Math.round((startTime - prior.startTime) / 1000) : null
      const doc = {
        familyId: fid, memberId: caller.memberId, dateKey: shanghaiDateKey(startTime),
        startTime, endTime: null, durationSec: null,
        intervalSec, intensity, notes,
        status: 'ongoing',
        revision: 1, createdAt: now, updatedAt: now,
        sortKey: sortKeyOf(startTime, recordId)
      }
      await t.collection(CONTRA).doc(recordId).set({ data: { ...doc } })
      await t.collection(OPS).doc(opKey).set({
        data: { ...opDoc, entity: { collection: CONTRA, docId: recordId }, createdAt: now }
      })
      await t.commit()
      return ok({ record: viewRecord({ ...doc, _id: recordId }) })
    } catch (err) {
      try { await t.rollback() } catch (e) { /* 已回滚 */ }
      return txFailed(err)
    }
  }

  if (action === 'contraction.stop' || action === 'contraction.delete') {
    const recordId = event.recordId
    if (!recordId || typeof recordId !== 'string' || recordId.length > ID_MAX) return fail('invalid-params', '缺少有效 recordId')
    const expected = parseExpectedRevision(event.expectedRevision)
    if (expected === null) return fail('invalid-params', 'expectedRevision 必须是显式非负整数')
    let requestChanges = {}
    if (action === 'contraction.stop') {
      const endTime = event.endTime === undefined || event.endTime === null ? Date.now() : parseTimestampMs(event.endTime)
      if (endTime === null) return fail('invalid-params', 'endTime 须有限整数毫秒')
      requestChanges = { endTime }
      if (event.intensity !== undefined) {
        if (event.intensity !== null && !INTENSITY_LEVELS.includes(event.intensity)) {
          return fail('invalid-params', `intensity 须 ${INTENSITY_LEVELS.join('/')} 或 null`)
        }
        requestChanges.intensity = event.intensity
      }
      if (event.notes !== undefined) {
        if (event.notes !== null && (typeof event.notes !== 'string' || event.notes.length > NOTES_MAX)) {
          return fail('invalid-params', `notes 须 ≤${NOTES_MAX} 字文本`)
        }
        requestChanges.notes = event.notes
      }
    }
    const opKey = `${caller.memberId}:${event.operationId}`
    const opDoc = {
      memberId: caller.memberId, operationId: event.operationId, kind: `tools-${action.replace('.', '-')}`,
      requestHash: digestOf({ recordId, expectedRevision: expected, ...requestChanges })
    }
    const now = Date.now()
    const t = await db.startTransaction()
    try {
      const guard = await opGuard(t, opKey, opDoc)
      if (guard.replayed === 'ok') {
        const cur = guard.entity && guard.entity.collection === CONTRA ? await getDocMaybe(t, CONTRA, guard.entity.docId) : null
        await t.rollback()
        return ok({ replayed: true, record: viewRecord(cur) })
      }
      if (guard.replayed) return guard.replayed

      const record = await getDocMaybe(t, CONTRA, recordId)
      if (!record || record.familyId !== fid) { await t.rollback(); return fail('not-found', '记录不存在') }
      if (expected !== record.revision) {
        await t.rollback()
        return fail('revision-conflict', '记录已被更新，请刷新后重试', { currentRevision: record.revision })
      }
      const merged = { ...stripId(record) }
      if (action === 'contraction.stop') {
        if (record.status !== 'ongoing') { await t.rollback(); return fail('invalid-state', `仅 ongoing 记录可结束（当前 ${record.status}）`) }
        if (requestChanges.endTime < record.startTime) {
          await t.rollback(); return fail('invalid-params', 'endTime 早于 startTime')
        }
        merged.status = 'finished'
        merged.endTime = requestChanges.endTime
        merged.durationSec = Math.round((requestChanges.endTime - record.startTime) / 1000)
        if (requestChanges.intensity !== undefined) merged.intensity = requestChanges.intensity
        if (requestChanges.notes !== undefined) merged.notes = requestChanges.notes
      } else {
        // delete：软废弃（默认列表排除；不改任何其他记录）
        if (record.status === 'discarded') { await t.rollback(); return fail('invalid-state', '记录已废弃') }
        merged.status = 'discarded'
      }
      merged.revision = record.revision + 1
      merged.updatedAt = now
      await t.collection(CONTRA).doc(recordId).set({ data: merged })
      await t.collection(OPS).doc(opKey).set({
        data: { ...opDoc, entity: { collection: CONTRA, docId: recordId }, createdAt: now }
      })
      await t.commit()
      return ok({ record: viewRecord({ ...merged, _id: recordId }) })
    } catch (err) {
      try { await t.rollback() } catch (e) { /* 已回滚 */ }
      return txFailed(err)
    }
  }

  if (action === 'contraction.list') {
    const limitRaw = Number(event.limit || PAGE_DEFAULT)
    const limit = Math.min(Math.max(Number.isInteger(limitRaw) ? limitRaw : PAGE_DEFAULT, 1), PAGE_MAX)
    const cursor = (typeof event.cursor === 'string' && event.cursor) || null
    const sinceMs = event.sinceMs === undefined || event.sinceMs === null ? null : event.sinceMs
    if (sinceMs !== null && (typeof sinceMs !== 'number' || !Number.isInteger(sinceMs) || sinceMs <= 0)) {
      return fail('invalid-params', 'sinceMs 须正整数毫秒')
    }
    const cmd = db.command
    const where = { familyId: fid }
    if (cursor) where.sortKey = cmd.lt(cursor)
    // 排除废弃：mock/真库 where 不便表达 neq+or——超取后过滤再截断（单家庭宫缩记录量级，
    // 取 limit*3 上限 300 足覆盖误录占比；511 分析亦可由 includeDiscarded 全量重算）。
    // includeDiscarded（无过滤路径）：取 limit+1 以探测 hasMore。
    const fetchLimit = event.includeDiscarded === true ? limit + 1 : Math.min(limit * 3, 300)
    const res = await db.collection(CONTRA).where(where).orderBy('sortKey', 'desc').limit(fetchLimit).get()
    let rows = (res && res.data) || []
    if (event.includeDiscarded !== true) rows = rows.filter(r => r.status !== 'discarded')
    if (sinceMs !== null) rows = rows.filter(r => r.startTime >= sinceMs)
    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    const nextCursor = rows.length > limit && last ? last.sortKey : null
    return ok({ records: page.map(viewRecord), nextCursor, hasMore: Boolean(nextCursor) })
  }

// ── EFW 测量解析与 Hadlock 纯计算 ──
// 返回 {err} 或 {hcCm, acCm, flCm}：单位换算（mm/10）→ 有限正数 → 范围门（逐项精确拒因）
function parseEfwMeasurements(input) {
  const u = input.unit === undefined || input.unit === null ? 'cm' : input.unit
  if (u !== 'cm' && u !== 'mm') return { err: 'unit 须 cm 或 mm' }
  const factor = u === 'mm' ? 0.1 : 1
  const out = {}
  for (const key of ['hc', 'ac', 'fl']) {
    const v = input[key]
    if (typeof v !== 'number' || !Number.isFinite(v)) return { err: `${key} 须有限数字` }
    const cm = v * factor
    if (cm <= 0) return { err: `${key} 须为正数` }
    const [lo, hi] = EFW_RANGES[key]
    if (cm < lo || cm > hi) return { err: `${key}=${cm.toFixed(2)}cm 超出合理范围 [${lo}, ${hi}]cm` }
    out[`${key}Cm`] = cm
  }
  return out
}

// Hadlock 1985 三参数（纯函数——输入 cm）：返回 {log10, exactEfwGrams(两位小数), efwGrams(整数克)}
function computeHadlock(hcCm, acCm, flCm) {
  const log10 = 1.326 - 0.00326 * acCm * flCm + 0.0107 * hcCm + 0.0438 * acCm + 0.158 * flCm
  const exact = Math.pow(10, log10)
  return { log10, exactEfwGrams: Math.round(exact * 100) / 100, efwGrams: Math.round(exact) }
}

function viewEfw(doc) {
  if (!doc) return null
  return {
    recordId: doc._id || doc.recordId,
    memberId: doc.memberId,
    dateKey: doc.dateKey,
    gestationalWeek: doc.gestationalWeek,
    measurements: doc.measurements || null,
    formula: doc.formula,
    efwGrams: doc.efwGrams,
    exactEfwGrams: doc.exactEfwGrams,
    reportId: doc.reportId ?? null,
    notes: doc.notes ?? null,
    status: doc.status,
    revision: doc.revision,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  }
}

// ══ E2 估重（efw.calculate / save / delete / list）══

if (action === 'efw.calculate') {
  const parsed = parseEfwMeasurements(event)
  if (parsed.err) return fail('invalid-params', `测量参数非法：${parsed.err}`)
  const { hcCm, acCm, flCm } = parsed
  const r = computeHadlock(hcCm, acCm, flCm)
  return ok({
    inputsCm: { hcCm, acCm, flCm },
    formula: HADLOCK_FORMULA,
    log10: Math.round(r.log10 * 100000) / 100000,
    exactEfwGrams: r.exactEfwGrams,
    efwGrams: r.efwGrams,
    efwKg: Math.round(r.exactEfwGrams) / 1000,
    rangeGrams: { low: Math.round(r.exactEfwGrams * 0.9), high: Math.round(r.exactEfwGrams * 1.1) } // ±10% 参考区间（展示层）
  })
}

if (action === 'efw.save') {
  const gestationalWeek = event.gestationalWeek
  if (!Number.isInteger(gestationalWeek) || gestationalWeek < EFW_WEEK_RANGE[0] || gestationalWeek > EFW_WEEK_RANGE[1]) {
    return fail('invalid-params', `gestationalWeek 须 ${EFW_WEEK_RANGE[0]}~${EFW_WEEK_RANGE[1]} 整数`)
  }
  const parsed = parseEfwMeasurements(event)
  if (parsed.err) return fail('invalid-params', `测量参数非法：${parsed.err}`)
  const { hcCm, acCm, flCm } = parsed
  const unit = event.unit === undefined || event.unit === null ? 'cm' : event.unit
  // BPD：伴随测量存储（mm）——不参与本公式（禁忌：不可替代缺失 HC）
  let bpdMm = null
  if (event.bpd !== undefined && event.bpd !== null) {
    if (typeof event.bpd !== 'number' || !Number.isFinite(event.bpd) || event.bpd <= 0) {
      return fail('invalid-params', 'bpd 须有限正数（或省略）')
    }
    bpdMm = unit === 'mm' ? event.bpd : event.bpd * 10
  }
  let dateKey = event.dateKey
  if (dateKey === undefined || dateKey === null) dateKey = shanghaiDateKey(Date.now())
  if (!DATE_RE.test(String(dateKey))) return fail('invalid-params', 'dateKey 须 YYYY-MM-DD')
  let notes = event.notes === undefined || event.notes === null ? null : event.notes
  if (notes !== null && (typeof notes !== 'string' || notes.length > NOTES_MAX)) {
    return fail('invalid-params', `notes 须 ≤${NOTES_MAX} 字文本`)
  }
  let reportId = event.reportId === undefined || event.reportId === null ? null : event.reportId
  if (reportId !== null && (typeof reportId !== 'string' || reportId.length > ID_MAX)) {
    return fail('invalid-params', 'reportId 须字符串')
  }
  // 服务端权威计算（不信任客户端 EFW——save 恒以服务端公式结果落盘）
  const calc = computeHadlock(hcCm, acCm, flCm)
  const now = Date.now()
  const recordId = 'efw_' + randomBytes(8).toString('hex')
  const opKey = `${caller.memberId}:${event.operationId}`
  const opDoc = {
    memberId: caller.memberId, operationId: event.operationId, kind: 'tools-efw-save',
    requestHash: digestOf({ gestationalWeek, hcCm, acCm, flCm, unit, bpdMm, dateKey, reportId: reportId ?? null, notes: notes ?? null })
  }
  const t = await db.startTransaction()
  try {
    const guard = await opGuard(t, opKey, opDoc)
    if (guard.replayed === 'ok') {
      const cur = guard.entity && guard.entity.collection === EFW ? await getDocMaybe(t, EFW, guard.entity.docId) : null
      await t.rollback()
      return ok({ replayed: true, record: viewEfw(cur) })
    }
    if (guard.replayed) return guard.replayed
    const doc = {
      familyId: fid, memberId: caller.memberId, dateKey,
      gestationalWeek,
      measurements: { hcCm, acCm, flCm, inputUnit: unit, bpdMm },
      formula: HADLOCK_FORMULA,
      efwGrams: calc.efwGrams, exactEfwGrams: calc.exactEfwGrams,
      reportId, notes,
      status: 'active',
      revision: 1, createdAt: now, updatedAt: now,
      sortKey: `${dateKey}:${recordId}`
    }
    await t.collection(EFW).doc(recordId).set({ data: { ...doc } })
    await t.collection(OPS).doc(opKey).set({
      data: { ...opDoc, entity: { collection: EFW, docId: recordId }, createdAt: now }
    })
    await t.commit()
    return ok({ record: viewEfw({ ...doc, _id: recordId }) })
  } catch (err) {
    try { await t.rollback() } catch (e) { /* 已回滚 */ }
    return txFailed(err)
  }
}

if (action === 'efw.delete') {
  const recordId = event.recordId
  if (!recordId || typeof recordId !== 'string' || recordId.length > ID_MAX) return fail('invalid-params', '缺少有效 recordId')
  const expected = parseExpectedRevision(event.expectedRevision)
  if (expected === null) return fail('invalid-params', 'expectedRevision 必须是显式非负整数')
  const opKey = `${caller.memberId}:${event.operationId}`
  const opDoc = {
    memberId: caller.memberId, operationId: event.operationId, kind: 'tools-efw-delete',
    requestHash: digestOf({ recordId, expectedRevision: expected })
  }
  const now = Date.now()
  const t = await db.startTransaction()
  try {
    const guard = await opGuard(t, opKey, opDoc)
    if (guard.replayed === 'ok') {
      const cur = guard.entity && guard.entity.collection === EFW ? await getDocMaybe(t, EFW, guard.entity.docId) : null
      await t.rollback()
      return ok({ replayed: true, record: viewEfw(cur) })
    }
    if (guard.replayed) return guard.replayed
    const record = await getDocMaybe(t, EFW, recordId)
    if (!record || record.familyId !== fid) { await t.rollback(); return fail('not-found', '记录不存在') }
    if (expected !== record.revision) {
      await t.rollback()
      return fail('revision-conflict', '记录已被更新，请刷新后重试', { currentRevision: record.revision })
    }
    if (record.status === 'discarded') { await t.rollback(); return fail('invalid-state', '记录已删除') }
    const merged = { ...stripId(record), status: 'discarded', revision: record.revision + 1, updatedAt: now }
    await t.collection(EFW).doc(recordId).set({ data: merged })
    await t.collection(OPS).doc(opKey).set({
      data: { ...opDoc, entity: { collection: EFW, docId: recordId }, createdAt: now }
    })
    await t.commit()
    return ok({ record: viewEfw({ ...merged, _id: recordId }) })
  } catch (err) {
    try { await t.rollback() } catch (e) { /* 已回滚 */ }
    return txFailed(err)
  }
}

if (action === 'efw.list') {
  const limitRaw = Number(event.limit || PAGE_DEFAULT)
  const limit = Math.min(Math.max(Number.isInteger(limitRaw) ? limitRaw : PAGE_DEFAULT, 1), PAGE_MAX)
  const cursor = (typeof event.cursor === 'string' && event.cursor) || null
  const cmd = db.command
  const where = { familyId: fid }
  if (cursor) where.sortKey = cmd.lt(cursor)
  // 软废弃默认排除（超取+过滤+截断——与 contraction.list 同款策略）
  const fetchLimit = event.includeDiscarded === true ? limit + 1 : Math.min(limit * 3, 300)
  const res = await db.collection(EFW).where(where).orderBy('sortKey', 'desc').limit(fetchLimit).get()
  let rows = (res && res.data) || []
  if (event.includeDiscarded !== true) rows = rows.filter(r => r.status !== 'discarded')
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  const nextCursor = rows.length > limit && last ? last.sortKey : null
  return ok({ records: page.map(viewEfw), nextCursor, hasMore: Boolean(nextCursor) })
}

  return fail('invalid-action', `未知 action: ${String(action)}`)
}
