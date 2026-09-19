'use strict'

// mc-health：B2a 权威健康数据源（一个函数三个文档族，统一身份/事务/幂等内核）：
//   pregnancy —— 家庭孕期档案单例（<family>:pregnancy），原子首建不重复
//   daily     —— 共享健康数字（<family>:<dateKey>），字段级更新、0 值合法、
//                null/空串=显式清除、deleted 墓碑阻止迟到编辑复活
//   mood      —— 私人心情/症状/备注/计划（<family>:<member>:<dateKey>），仅本人读写
//
// 关键语义（B2a spec）：
// - schemaVersion 仅支持 1；不支持的版本明确拒绝（unsupported-schema）
// - 更新时先展开已存文档再应用白名单变更：服务端未识别的历史字段原样保留
// - expectedRevision 必须是显式非负整数（0=创建）；operationId 幂等：
//   同内容重放（附 currentDoc 供客户端按 revision 合并，墓碑不被旧重放覆盖）、
//   异内容拒绝
// - 单字段提交保留其他字段：payload 只含提交字段；hasOwnProperty 区分
//   "未提交"与"显式清除(null/空串)"；fetalCount=0 合法；未知字段拒绝不清洗
// - 列表稳定排序（_id 含日期，字典序降序）+ 游标分页，墓碑随列表返回
// - 时间由服务端生成；updatedBy 由可信身份派生
//
// wx-server-sdk@4.0.2 契约（源码核对）：cloud.init(DYNAMIC_CURRENT_ENV,
// throwOnNotFound:false)；doc.get()→{data:doc|null}（get 返回含 _id）；
// doc.set({data}) 数据含 _id 会被 -501007 拒绝。

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

exports.__setCloud = function __setCloud(mockCloud) {
  cloud = mockCloud
}

const SUPPORTED_SCHEMA = 1
const PAGE_DEFAULT = 20
const PAGE_MAX = 100
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const DAILY_FIELDS = {
  weightKg: 'number',   // 25..300
  systolic: 'number',   // 60..260
  diastolic: 'number',  // 30..180
  fetalCount: 'number', // 0..200（0 合法）
  sharedNote: 'string'  // 共享短备注 ≤200 字（两人可见；私人内容分集存储）
}
const PREGNANCY_FIELDS = {
  lmpDate: 'date', dueDate: 'date',
  nickname: 'string', babyNickname: 'string', hospital: 'string',
  doctor: 'string', hospitalPhone: 'string',
  preWeightKg: 'number', heightCm: 'number'
}
const MOOD_FIELDS = {
  mood: 'string',         // 心情（仅本人）
  symptoms: 'stringList', // 症状标签（仅本人）
  note: 'string',         // 日常备注 ≤2000 字（仅本人）
  plans: 'planList'       // 今日计划（仅本人）：{text: string, done: boolean}[]
}
const RANGES = {
  weightKg: [25, 300], systolic: [60, 260], diastolic: [30, 180],
  fetalCount: [0, 200], preWeightKg: [25, 300], heightCm: [100, 250]
}

async function getDocMaybe(docRef) {
  try {
    const snap = await docRef.get()
    return snap && snap.data ? snap.data : null
  } catch (err) {
    const msg = String((err && (err.errMsg || err.message)) || err)
    if (/not\s*exist|does not exist/i.test(msg)) return null
    throw err
  }
}

function parseExpectedRevision(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
  return value
}

// 字段级校验：未提交 / 显式清除(null、空串，stringList 空数组=清除) / 值（0 合法）
// 清除以 null 写入 changes（合法值域保证不会与真实 null 业务值混淆）
function sanitizeChanges(payload, whitelist) {
  const errors = []
  const changes = {}
  if (!payload || typeof payload !== 'object') return { changes, errors: ['payload 必须是对象'] }
  for (const [field, kind] of Object.entries(whitelist)) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) continue
    const value = payload[field]
    const isExplicitClear = value === null || value === '' ||
      (kind === 'stringList' && Array.isArray(value) && value.length === 0)
    if (isExplicitClear) { changes[field] = null; continue }
    if (kind === 'number') {
      const num = Number(value)
      if (!Number.isFinite(num)) { errors.push(`${field} 不是有效数字`); continue }
      const range = RANGES[field]
      if (range && (num < range[0] || num > range[1])) { errors.push(`${field} 超出合理范围`); continue }
      changes[field] = num
    } else if (kind === 'string') {
      if (typeof value !== 'string') { errors.push(`${field} 必须是文本`); continue }
      if (field === 'sharedNote' && value.length > 200) { errors.push('sharedNote 过长'); continue }
      if (value.length > 2000) { errors.push(`${field} 过长`); continue }
      changes[field] = value
    } else if (kind === 'stringList') {
      if (!Array.isArray(value) || value.some(x => typeof x !== 'string')) {
        errors.push(`${field} 必须是文本数组`); continue
      }
      changes[field] = value.slice(0, 50)
    } else if (kind === 'planList') {
      // 真实 RecordEditSheet 计划结构：{text, done}；严格校验后规范化存储
      if (!Array.isArray(value)) { errors.push(`${field} 必须是计划数组`); continue }
      const plans = []
      let planErr = null
      for (const item of value.slice(0, 50)) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) { planErr = `${field} 项必须是 {text, done}`; break }
        if (typeof item.text !== 'string' || item.text.trim() === '' || item.text.length > 200) { planErr = `${field}.text 必须是非空文本（≤200 字）`; break }
        if (typeof item.done !== 'boolean') { planErr = `${field}.done 必须是布尔` ; break }
        plans.push({ text: item.text, done: item.done })
      }
      if (planErr) { errors.push(planErr); continue }
      changes[field] = plans
    } else if (kind === 'date') {
      if (!DATE_RE.test(String(value))) { errors.push(`${field} 必须是 YYYY-MM-DD`); continue }
      changes[field] = String(value)
    }
  }
  const known = new Set(Object.keys(whitelist))
  const unknown = Object.keys(payload).filter(k => !known.has(k))
  if (unknown.length > 0) errors.push(`未知字段：${unknown.join('、')}`)
  return { changes, errors }
}

// fields 子对象合并：保留未提交子字段，null=清除该子字段
function mergeFields(existingFields, fieldChanges) {
  const merged = { ...(existingFields || {}) }
  for (const [k, v] of Object.entries(fieldChanges)) {
    if (v === null) delete merged[k]
    else merged[k] = v
  }
  return merged
}

function hashable(changes) {
  // null 已是可 JSON 序列化的清除标记
  return changes
}

// 事务 upsert 内核。applyChanges(existingDoc) → 完整新文档（调用方做字段级合并，
// 必须保留 existingDoc 中未识别的历史字段）；requestChanges 仅用于幂等哈希。
async function transactionalUpsert(db, { collection, docId, kind, caller, operationId,
  expectedRevision, requestChanges, extraFields, applyChanges, buildView }) {
  const opKey = `${caller.memberId}:${operationId}`
  const opDoc = {
    memberId: caller.memberId,
    operationId,
    kind,
    requestHash: stableRequestHash({ docId, expectedRevision, changes: hashable(requestChanges) })
  }
  const now = Date.now()
  const t = await db.startTransaction()
  try {
    const prevOp = await getDocMaybe(t.collection(COLLECTIONS.operations).doc(opKey))
    if (prevOp) {
      if (prevOp.requestHash !== opDoc.requestHash) {
        await t.rollback()
        return fail('operation-id-conflict', '同一 operationId 曾以不同内容提交')
      }
      const current = await getDocMaybe(t.collection(collection).doc(docId))
      await t.rollback()
      // 重放目标文档若为不支持的存量版本：不返回旧正文快照给客户端合并
      if (storedSchemaUnsupported(current)) return unsupportedFail(current)
      // 重放不重新写正文：返回首次快照 + 当前文档，客户端按 revision 合并
      return ok({ replayed: true, record: prevOp.resultSnapshot, currentRecord: buildView(current) })
    }

    const existing = await getDocMaybe(t.collection(collection).doc(docId))
    if (storedSchemaUnsupported(existing)) {
      await t.rollback()
      return unsupportedFail(existing)
    }
    const currentRevision = existing ? existing.revision : 0
    if (expectedRevision !== currentRevision) {
      await t.rollback()
      const reason = existing && existing.deleted ? '记录已删除，编辑不能自动复活' : '记录已被对方更新'
      return fail('revision-conflict', reason, {
        currentRevision,
        currentRecord: buildView(existing)
      })
    }
    // 墓碑存在时 existing.deleted=true：与删除冲突走同一 revision 拒绝（删除不自动复活）
    if (existing && existing.deleted && kind !== 'daily-delete') {
      await t.rollback()
      return fail('revision-conflict', '记录已删除，编辑不能自动复活', {
        currentRevision,
        currentRecord: buildView(existing)
      })
    }

    const base = existing ? { ...existing } : { ...extraFields }
    let merged = applyChanges(base, existing)
    merged.revision = currentRevision + 1
    merged.updatedBy = caller.memberId
    merged.updatedAt = now

    const { _id: _fetchedId, ...setData } = merged
    void _fetchedId
    const resultSnapshot = buildView(merged)
    await t.collection(collection).doc(docId).set({ data: setData })
    await t.collection(COLLECTIONS.operations).doc(opKey).set({
      data: { ...opDoc, resultSnapshot, createdAt: now }
    })
    await t.commit()
    return ok({ replayed: false, record: resultSnapshot })
  } catch (err) {
    try { await t.rollback() } catch (rollbackErr) { /* 已回滚 */ }
    return fail('transaction-failed', '事务未提交成功，可安全重试', {
      errMsg: String((err && (err.errMsg || err.message)) || err).slice(0, 200)
    })
  }
}

// ── 视图（不含私人正文之外的东西；daily/mood 正文在 fields 内）──
// 存量文档版本检查：已写入且不等于支持版本的文档，旧代码不得继续解释并写入
function storedSchemaUnsupported(doc) {
  return Boolean(doc) && doc.schemaVersion !== undefined &&
    doc.schemaVersion !== null && doc.schemaVersion !== SUPPORTED_SCHEMA
}
function unsupportedFail(doc) {
  return fail('unsupported-stored-schema',
    `记录由更高版本写入（schemaVersion=${String(doc.schemaVersion)}，本服务支持 ${SUPPORTED_SCHEMA}），` +
    '需要升级客户端或迁移后才能读写', { storedSchemaVersion: doc.schemaVersion })
}

function viewDaily(doc) {
  if (!doc) return null
  return {
    id: doc.dateKey, dateKey: doc.dateKey,
    fields: doc.fields || {},
    revision: doc.revision, updatedBy: doc.updatedBy, updatedAt: doc.updatedAt,
    deleted: Boolean(doc.deleted),
    schemaVersion: doc.schemaVersion === undefined ? null : doc.schemaVersion,
    unsupportedSchema: storedSchemaUnsupported(doc)
  }
}
function viewPregnancy(doc) {
  if (!doc) return null
  return {
    id: 'pregnancy',
    fields: doc.fields || {},
    revision: doc.revision, updatedBy: doc.updatedBy, updatedAt: doc.updatedAt,
    deleted: Boolean(doc.deleted),
    schemaVersion: doc.schemaVersion === undefined ? null : doc.schemaVersion,
    unsupportedSchema: storedSchemaUnsupported(doc)
  }
}
function viewMood(doc) {
  if (!doc) return null
  return {
    id: doc.dateKey, dateKey: doc.dateKey,
    fields: doc.fields || {},
    revision: doc.revision, updatedAt: doc.updatedAt,
    deleted: Boolean(doc.deleted),
    schemaVersion: doc.schemaVersion === undefined ? null : doc.schemaVersion,
    unsupportedSchema: storedSchemaUnsupported(doc)
  }
}

// 数据库侧游标分页（B2a review 修复）：
// - 绝不用未指定 limit 的 collection.get()——SDK 默认 limit=100，首页≠全量
// - where 按家庭/本人过滤；dateKey（家庭内唯一、字典序即时间序）稳定降序；
//   游标 = 本页最后一条的 dateKey，下一页 where dateKey < cursor——
//   与排序边界一致，不漏行不重行
// - 返回行数 < limit 即最后一页
async function listPage(db, collection, filters, cursor, limit) {
  const cmd = db.command
  const where = { ...filters }
  if (cursor) where.dateKey = cmd.lt(cursor)
  const res = await db.collection(collection)
    .where(where)
    .orderBy('dateKey', 'desc')
    .limit(limit)
    .get()
  const rows = (res && res.data) || []
  const last = rows[rows.length - 1]
  const nextCursor = rows.length === limit && last ? last.dateKey : null
  return { records: rows, nextCursor }
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

  if (event.schemaVersion !== SUPPORTED_SCHEMA) {
    return fail('unsupported-schema', `schemaVersion 必须为 ${SUPPORTED_SCHEMA}（收到 ${String(event.schemaVersion)}）`)
  }
  const READ_ACTIONS = ['pregnancy.get', 'daily.get', 'daily.list', 'mood.get', 'mood.list']
  let expected = null
  if (!READ_ACTIONS.includes(action)) {
    // 只读动作不携带变更语义：不要求 operationId/expectedRevision；
    // 变更动作必须显式提供（幂等去重 + 乐观版本）
    if (!event.operationId || typeof event.operationId !== 'string' || event.operationId.length > 64) {
      return fail('invalid-params', '缺少有效 operationId')
    }
    expected = parseExpectedRevision(event.expectedRevision)
    if (expected === null) {
      return fail('invalid-params', 'expectedRevision 必须是显式非负整数（0=创建）')
    }
  }
  const dateKeyOk = DATE_RE.test(String(event.dateKey || ''))

  // ── 孕期档案（家庭单例；两成员首建竞争：事务串行化，一方成功一方冲突/重试）──
  if (action === 'pregnancy.get') {
    const doc = await getDocMaybe(db.collection('mc_pregnancy').doc(`${config.familyId}:pregnancy`))
    if (storedSchemaUnsupported(doc)) return unsupportedFail(doc)
    return ok({ record: viewPregnancy(doc) })
  }
  if (action === 'pregnancy.upsert') {
    const { changes, errors } = sanitizeChanges(event.payload || {}, PREGNANCY_FIELDS)
    if (errors.length > 0) return fail('invalid-params', errors.join('；'))
    if (Object.keys(changes).length === 0) return fail('invalid-params', '没有可保存的字段')
    return transactionalUpsert(db, {
      collection: 'mc_pregnancy', docId: `${config.familyId}:pregnancy`, kind: 'pregnancy-upsert',
      caller, operationId: event.operationId, expectedRevision: expected, requestChanges: changes,
      extraFields: { familyId: config.familyId, type: 'pregnancy', fields: {}, schemaVersion: SUPPORTED_SCHEMA },
      applyChanges: base => { base.fields = mergeFields(base.fields, changes); return base },
      buildView: viewPregnancy
    })
  }

  // ── 共享健康数字 ──
  if (action === 'daily.get') {
    if (!dateKeyOk) return fail('invalid-params', 'dateKey 非法')
    const doc = await getDocMaybe(db.collection('mc_health_daily').doc(`${config.familyId}:${event.dateKey}`))
    if (storedSchemaUnsupported(doc)) return unsupportedFail(doc)
    return ok({ record: viewDaily(doc) })
  }
  if (action === 'daily.upsert') {
    if (!dateKeyOk) return fail('invalid-params', 'dateKey 非法')
    const { changes, errors } = sanitizeChanges(event.payload || {}, DAILY_FIELDS)
    if (errors.length > 0) return fail('invalid-params', errors.join('；'))
    if (Object.keys(changes).length === 0) return fail('invalid-params', '没有可保存的字段')
    return transactionalUpsert(db, {
      collection: 'mc_health_daily', docId: `${config.familyId}:${event.dateKey}`, kind: 'daily-upsert',
      caller, operationId: event.operationId, expectedRevision: expected, requestChanges: changes,
      extraFields: { familyId: config.familyId, type: 'daily', dateKey: event.dateKey, fields: {}, schemaVersion: SUPPORTED_SCHEMA },
      applyChanges: base => { base.fields = mergeFields(base.fields, changes); return base },
      buildView: viewDaily
    })
  }
  if (action === 'daily.delete') {
    if (!dateKeyOk) return fail('invalid-params', 'dateKey 非法')
    // 删除 = 墓碑：清空正文、保留 revision 链；迟到旧编辑按 revision+deleted 拒绝
    return transactionalUpsert(db, {
      collection: 'mc_health_daily', docId: `${config.familyId}:${event.dateKey}`, kind: 'daily-delete',
      caller, operationId: event.operationId, expectedRevision: expected, requestChanges: { deleted: true },
      extraFields: { familyId: config.familyId, type: 'daily', dateKey: event.dateKey, fields: {}, schemaVersion: SUPPORTED_SCHEMA },
      applyChanges: base => {
        base.fields = {}
        base.deleted = true
        return base
      },
      buildView: viewDaily
    })
  }
  if (action === 'daily.list') {
    const limitRaw = Number(event.limit || PAGE_DEFAULT)
    const limit = Math.min(Math.max(Number.isInteger(limitRaw) ? limitRaw : PAGE_DEFAULT, 1), PAGE_MAX)
    const cursor = (typeof event.cursor === 'string' && event.cursor) || null
    const page = await listPage(db, 'mc_health_daily', { familyId: config.familyId, type: 'daily' }, cursor, limit)
    return ok({ records: page.records.map(viewDaily), nextCursor: page.nextCursor, hasMore: Boolean(page.nextCursor) })
  }

  // ── 私人心情/症状/备注/计划 ──
  if (action === 'mood.get') {
    if (!dateKeyOk) return fail('invalid-params', 'dateKey 非法')
    const doc = await getDocMaybe(db.collection('mc_moods').doc(`${config.familyId}:${caller.memberId}:${event.dateKey}`))
    if (storedSchemaUnsupported(doc)) return unsupportedFail(doc)
    return ok({ record: viewMood(doc) })
  }
  if (action === 'mood.upsert') {
    if (!dateKeyOk) return fail('invalid-params', 'dateKey 非法')
    const { changes, errors } = sanitizeChanges(event.payload || {}, MOOD_FIELDS)
    if (errors.length > 0) return fail('invalid-params', errors.join('；'))
    if (Object.keys(changes).length === 0) return fail('invalid-params', '没有可保存的字段')
    return transactionalUpsert(db, {
      collection: 'mc_moods', docId: `${config.familyId}:${caller.memberId}:${event.dateKey}`, kind: 'mood-upsert',
      caller, operationId: event.operationId, expectedRevision: expected, requestChanges: changes,
      extraFields: { familyId: config.familyId, ownerId: caller.memberId, type: 'mood', dateKey: event.dateKey, fields: {}, schemaVersion: SUPPORTED_SCHEMA },
      applyChanges: base => { base.fields = mergeFields(base.fields, changes); return base },
      buildView: viewMood
    })
  }
  if (action === 'mood.list') {
    const limitRaw = Number(event.limit || PAGE_DEFAULT)
    const limit = Math.min(Math.max(Number.isInteger(limitRaw) ? limitRaw : PAGE_DEFAULT, 1), PAGE_MAX)
    const cursor = (typeof event.cursor === 'string' && event.cursor) || null
    const page = await listPage(db, 'mc_moods', { familyId: config.familyId, ownerId: caller.memberId, type: 'mood' }, cursor, limit)
    return ok({ records: page.records.map(viewMood), nextCursor: page.nextCursor, hasMore: Boolean(page.nextCursor) })
  }

  return fail('invalid-action', '未知 action')
}
