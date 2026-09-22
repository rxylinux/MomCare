'use strict'

// mc-reports：B2b2 家庭共享报告权威源（文档族 mc_reports）。
//
// 关键语义（B2b2 spec / REMAINING_PHASE_ACCEPTANCE / 设计修订 P1）：
// - 稳定报告 ID（rpt_*，客户端生成），schemaVersion/revision/deleted/familyId 全量约束
// - attachments 只能引用 mc_files 中【本家庭、已登记（registered）】的文件：
//   服务端事务内逐项校验，客户端任意 fileID/URL 一律拒绝；临时 URL 不入库
// - 引用记账与清理同事务（P1-3）：mc_files 维护事务保护的 attachedReportIds /
//   everAttached / lastDetachedAt；报告创建/编辑/删除在同一事务内增删引用集合；
//   清理认领只在同事务验证引用集合为空后转 cleaning——无事务外扫描
// - 清理终态（P1-2）：存储对象逐个检查 deleteFile 结果码删除；全部成功后写
//   status='deleted' 文件墓碑（不删记录）——同 uploadId 认领/迟到登记/重放不可复活
// - report.getReadUrls：报告未删除才允许预览（历史幂等响应不能绕过删除）
// - 幂等/冲突/分页/存量 schema 拒绝与 mc-health/mc-schedule 同一契约

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

const ARCHIVE_STATUS = ['archived', 'unarchived']
// 与前端 stores/report.js REPORT_TYPES 键一致（服务端白名单单一来源在此声明）
const REPORT_TYPES = [
  'blood_routine', 'ultrasound', 'down_screening', 'ogtt', 'urine',
  'nipt', 'obstetric', 'biochemical', 'other'
]
const NOTE_MAX = 500
const HOSPITAL_MAX = 100
const WEEK_MIN = 1
const WEEK_MAX = 45
const ATTACHMENTS_MAX = 20
const FILEID_RE = /^[A-Za-z0-9:_-]{1,128}$/
// 清理协议参数（部署期可按需调整为配置；默认值用于隔离验证）
const CLAIM_STALE_MS = 30 * 60 * 1000            // claiming 停滞视为无活跃任务
const REGISTERED_GRACE_MS = 24 * 60 * 60 * 1000  // 引用移除/登记后的清理宽限

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

function isValidCalendarDate(dk) {
  if (!DATE_RE.test(dk)) return false
  const [y, m, d] = dk.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const test = new Date(Date.UTC(y, m - 1, d))
  return test.getUTCFullYear() === y && test.getUTCMonth() === m - 1 && test.getUTCDate() === d
}

function storedSchemaUnsupported(doc) {
  return Boolean(doc) && doc.schemaVersion !== undefined &&
    doc.schemaVersion !== null && doc.schemaVersion !== SUPPORTED_SCHEMA
}
function unsupportedFail(doc) {
  return fail('unsupported-stored-schema',
    `记录由更高版本写入（schemaVersion=${String(doc.schemaVersion)}），需要升级或迁移`,
    { storedSchemaVersion: doc.schemaVersion })
}

function getFamilyDoc(db, collection, docId, familyId) {
  return getDocMaybe(db.collection(collection).doc(docId)).then(doc => {
    if (!doc) return null
    if (doc.familyId !== familyId) return null // 外家庭文档等同不存在
    return doc
  })
}

function viewReport(doc, fallbackId) {
  if (!doc) return null
  return { ...doc, id: doc._id || doc.id || fallbackId || '', deleted: Boolean(doc.deleted) }
}

// 分页（sortKey 含稳定 ID 第二键；含墓碑）
async function listPage(db, collection, filters, cursor, limit) {
  const cmd = db.command
  const where = { ...filters }
  if (cursor) where.sortKey = cmd.lt(cursor)
  const res = await db.collection(collection)
    .where(where)
    .orderBy('sortKey', 'desc')
    .limit(limit)
    .get()
  const rows = (res && res.data) || []
  const last = rows[rows.length - 1]
  const nextCursor = rows.length === limit && last ? last.sortKey : null
  return { records: rows, nextCursor }
}

// ── 字段校验（attachments 引用完整性在事务内另行校验）──
function sanitizeReport(input) {
  const errors = []
  const out = {}
  if (input.dateKey !== undefined) {
    if (!isValidCalendarDate(String(input.dateKey))) errors.push('dateKey 必须是有效日历日期 YYYY-MM-DD')
    else out.dateKey = String(input.dateKey)
  }
  if (input.reportType !== undefined) {
    if (!REPORT_TYPES.includes(input.reportType)) errors.push('reportType 须为合法枚举之一')
    else out.reportType = input.reportType
  }
  if (input.archiveStatus !== undefined) {
    if (!ARCHIVE_STATUS.includes(input.archiveStatus)) errors.push(`archiveStatus 须 ${ARCHIVE_STATUS.join('/')}`)
    else out.archiveStatus = input.archiveStatus
  }
  if (input.note !== undefined) {
    if (input.note === null || input.note === '') out.note = null
    else if (typeof input.note !== 'string' || input.note.length > NOTE_MAX) errors.push(`note 须 ≤${NOTE_MAX} 字`)
    else out.note = input.note
  }
  // 就诊医院（2026-09-22 补齐）：值语义与 note 一致——null/'' 归一为 null（显式清空）
  if (input.hospital !== undefined) {
    if (input.hospital === null || input.hospital === '') out.hospital = null
    else if (typeof input.hospital !== 'string' || input.hospital.length > HOSPITAL_MAX) errors.push(`hospital 须 ≤${HOSPITAL_MAX} 字`)
    else out.hospital = input.hospital
  }
  // 当时孕周（2026-09-22 补齐）：整数周；null 归一为 null；'' 拒绝（客户端须归一，不猜意图）
  if (input.weekOfPregnancy !== undefined) {
    if (input.weekOfPregnancy === null) out.weekOfPregnancy = null
    else if (typeof input.weekOfPregnancy !== 'number' || !Number.isInteger(input.weekOfPregnancy) ||
      input.weekOfPregnancy < WEEK_MIN || input.weekOfPregnancy > WEEK_MAX) {
      errors.push(`weekOfPregnancy 须 ${WEEK_MIN}-${WEEK_MAX} 的整数周或 null`)
    } else out.weekOfPregnancy = input.weekOfPregnancy
  }
  if (input.attachments !== undefined) {
    if (!Array.isArray(input.attachments)) errors.push('attachments 必须是数组')
    else if (input.attachments.length > ATTACHMENTS_MAX) errors.push(`attachments ≤${ATTACHMENTS_MAX}`)
    else {
      const items = []
      const seen = new Set()
      for (const it of input.attachments) {
        if (!it || typeof it !== 'object' || !it.fileId || !FILEID_RE.test(String(it.fileId))) {
          errors.push('attachments 每项须有合法 fileId'); break
        }
        const fid = String(it.fileId)
        if (seen.has(fid)) { errors.push(`attachments fileId 重复: ${fid}`); break }
        seen.add(fid)
        items.push({ fileId: fid })
      }
      if (!errors.length) out.attachments = items
    }
  }
  return { out, errors }
}

// ── 事务内核：报告写入 + 文件引用记账同事务提交（P1-3）──
// refDelta: [{fileId, op:'add'|'remove'}]——新增引用要求文件 registered（拒绝
// cleaning/deleted），集合实际变化才写文件文档（无谓冲突最小化）
async function commitReportTx(db, config, { collection, docId, kind, caller, operationId,
  expectedRevision, requestChanges, extraFields, applyChanges }) {
  // 幂等键绑定 family + kind：同 operationId 在家庭配置变化后不得回放旧家庭快照；
  // replay 同时校验操作归属与当前记录归属
  const opKey = `${config.familyId}:${caller.memberId}:${operationId}`
  const opDoc = {
    familyId: config.familyId, memberId: caller.memberId, operationId, kind,
    requestHash: stableRequestHash({ docId, expectedRevision, changes: requestChanges })
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
      // 归属校验：幂等记录本身绑定的家庭/kind 与当前不符 → 不是本次操作的重放
      if (prevOp.familyId !== config.familyId || prevOp.kind !== kind) {
        await t.rollback()
        return fail('operation-id-conflict', '同一 operationId 属于其他家庭或操作类型')
      }
      const current = await getDocMaybe(t.collection(collection).doc(docId))
      await t.rollback()
      if (storedSchemaUnsupported(current)) return unsupportedFail(current)
      // 当前记录若已属他家庭（家庭配置变化后被他人家庭认领）不得回放旧快照
      if (current && current.familyId !== config.familyId) {
        return fail('not-found', '记录不存在')
      }
      return ok({ replayed: true, record: prevOp.resultSnapshot, currentRecord: viewReport(current, docId) })
    }
    const existing = await getDocMaybe(t.collection(collection).doc(docId))
    if (existing && existing.familyId !== config.familyId) {
      await t.rollback()
      return fail('not-found', '记录不存在')
    }
    if (storedSchemaUnsupported(existing)) {
      await t.rollback()
      return unsupportedFail(existing)
    }
    const currentRevision = existing ? existing.revision : 0
    if (existing && existing.deleted && kind !== 'report-delete') {
      await t.rollback()
      return fail('revision-conflict', '记录已删除，编辑不能自动复活', {
        currentRevision, currentRecord: viewReport(existing)
      })
    }
    if (expectedRevision !== currentRevision) {
      await t.rollback()
      return fail('revision-conflict', '记录已被对方更新', {
        currentRevision, currentRecord: viewReport(existing)
      })
    }

    // 引用集合差量：旧附件（existing）→ 新附件（合并后 base）
    const base = existing ? { ...existing } : { ...extraFields }
    // 创建时刻：此后编辑只刷 updatedAt 不动 createdAt（详情页"上传时间"权威来源）
    if (!existing) base.createdAt = now
    const merged = applyChanges(base, existing)
    const oldIds = existing && Array.isArray(existing.attachments) ? existing.attachments.map(a => a.fileId) : []
    // 有效引用：删除后引用集合为空（审计保留的 attachments 不等于有效引用）——
    // 墓碑后 attachedReportIds 必须清空，否则清理永远 skipped-referenced
    const newIds = kind === 'report-delete'
      ? []
      : (Array.isArray(merged.attachments) ? merged.attachments.map(a => a.fileId) : [])
    const oldSet = new Set(oldIds)
    const newSet = new Set(newIds)
    const added = [...newSet].filter(id => !oldSet.has(id))
    const removed = [...oldSet].filter(id => !newSet.has(id))

    // 新增引用：事务内验证 registered（cleaning/deleted 一律拒绝）并记账
    for (const fid of added) {
      const fdoc = await getDocMaybe(t.collection(COLLECTIONS.files).doc(fid))
      if (!fdoc || fdoc.familyId !== config.familyId || fdoc.status !== 'registered') {
        await t.rollback()
        return fail('invalid-attachment', `附件 ${fid} 不存在、未完成登记或不可引用`)
      }
      const { _id: _fid, ...fileFields } = fdoc
      void _fid
      const refs = Array.isArray(fdoc.attachedReportIds) ? [...fdoc.attachedReportIds] : []
      if (!refs.includes(docId)) refs.push(docId)
      await t.collection(COLLECTIONS.files).doc(fid).set({
        data: { ...fileFields, attachedReportIds: refs, everAttached: true, lastDetachedAt: null }
      })
    }
    // 移除引用：从集合剔除本报告；集合清空时记录待清理计时起点
    for (const fid of removed) {
      const fdoc = await getDocMaybe(t.collection(COLLECTIONS.files).doc(fid))
      if (!fdoc) continue // 文件记录缺失（不应发生）——报告写入仍继续，记账以存在者为准
      const { _id: _fid2, ...fileFields2 } = fdoc
      void _fid2
      const refs = (Array.isArray(fdoc.attachedReportIds) ? fdoc.attachedReportIds : []).filter(id => id !== docId)
      await t.collection(COLLECTIONS.files).doc(fid).set({
        data: {
          ...fileFields2,
          attachedReportIds: refs,
          // 首次清空记起点；重复删除/再次移除不重置宽限计时
          lastDetachedAt: refs.length === 0 ? (fdoc.lastDetachedAt || now) : (fdoc.lastDetachedAt || null)
        }
      })
    }

    merged.revision = currentRevision + 1
    merged.updatedBy = caller.memberId
    merged.updatedAt = now
    const { _id: _f, ...setData } = merged
    void _f
    const resultSnapshot = viewReport(merged, docId)
    await t.collection(collection).doc(docId).set({ data: setData })
    await t.collection(COLLECTIONS.operations).doc(opKey).set({
      data: { ...opDoc, resultSnapshot, createdAt: now }
    })
    await t.commit()
    return ok({ replayed: false, record: resultSnapshot })
  } catch (err) {
    try { await t.rollback() } catch (e) { /* 已回滚 */ }
    return fail('transaction-failed', '事务未提交成功，可安全重试', {
      errMsg: String((err && (err.errMsg || err.message)) || err).slice(0, 200)
    })
  }
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
    return fail('unsupported-schema', `schemaVersion 必须为 ${SUPPORTED_SCHEMA}`)
  }
  const READ_ACTIONS = ['report.get', 'report.list', 'report.getReadUrls']
  let expected = null
  if (!READ_ACTIONS.includes(action)) {
    if (!event.operationId || typeof event.operationId !== 'string' || event.operationId.length > 64) {
      return fail('invalid-params', '缺少有效 operationId')
    }
    expected = parseExpectedRevision(event.expectedRevision)
    if (expected === null) {
      return fail('invalid-params', 'expectedRevision 必须是显式非负整数')
    }
  }

  // ── 读取 ──
  if (action === 'report.get') {
    if (!event.id) return fail('invalid-params', '缺少 id')
    const doc = await getFamilyDoc(db, 'mc_reports', event.id, config.familyId)
    if (!doc) return ok({ record: null })
    if (storedSchemaUnsupported(doc)) return unsupportedFail(doc)
    return ok({ record: viewReport(doc, event.id) })
  }

  if (action === 'report.list') {
    const limitRaw = Number(event.limit || PAGE_DEFAULT)
    const limit = Math.min(Math.max(Number.isInteger(limitRaw) ? limitRaw : PAGE_DEFAULT, 1), PAGE_MAX)
    const cursor = event.cursor || null
    const page = await listPage(db, 'mc_reports', { familyId: config.familyId }, cursor, limit)
    for (const r of page.records) {
      if (storedSchemaUnsupported(r)) return unsupportedFail(r)
    }
    return ok({ records: page.records.map(r => viewReport(r, r._id)), nextCursor: page.nextCursor, hasMore: Boolean(page.nextCursor) })
  }

  // 预览临时 URL：报告级鉴权（未删除）+ 附件登记核对；URL 不入库
  if (action === 'report.getReadUrls') {
    if (!event.id) return fail('invalid-params', '缺少 id')
    const doc = await getFamilyDoc(db, 'mc_reports', event.id, config.familyId)
    if (!doc || doc.deleted) return fail('report-not-found', '报告不存在或已删除')
    if (storedSchemaUnsupported(doc)) return unsupportedFail(doc)
    const attachments = Array.isArray(doc.attachments) ? doc.attachments : []
    if (attachments.length === 0) return ok({ urls: [], attachments: [] })
    const verified = []
    for (const att of attachments) {
      const fdoc = await getDocMaybe(db.collection(COLLECTIONS.files).doc(att.fileId))
      if (!fdoc || fdoc.familyId !== config.familyId || fdoc.status !== 'registered' || !fdoc.formalFileID) {
        return fail('invalid-attachment', `附件 ${att.fileId} 不可用（未登记或已清理）`)
      }
      verified.push({ att, fdoc })
    }
    const beforeRevision = doc.revision
    const beforeFileIds = verified.map(v => v.att.fileId).join(',')
    let urlResult
    try {
      urlResult = await cloud.getTempFileURL({ fileList: verified.map(v => v.fdoc.formalFileID) })
    } catch (err) {
      return fail('temp-url-failed', '获取访问地址失败')
    }
    // 返回前重核（迟到签发门）：签发期间报告被删除/推进、附件集合或文件状态
    // 变化 → 丢弃已签发结果并要求重试，不交付已删报告的原件 URL
    const after = await getFamilyDoc(db, 'mc_reports', event.id, config.familyId)
    if (!after || after.deleted || after.revision !== beforeRevision) {
      return fail('report-changed-retry', '报告已删除或已更新，请刷新后重试')
    }
    const afterIds = (Array.isArray(after.attachments) ? after.attachments : []).map(a => a.fileId).join(',')
    if (afterIds !== beforeFileIds) {
      return fail('report-changed-retry', '报告附件已变化，请刷新后重试')
    }
    for (const v of verified) {
      const fdocNow = await getDocMaybe(db.collection(COLLECTIONS.files).doc(v.att.fileId))
      if (!fdocNow || fdocNow.status !== 'registered') {
        return fail('report-changed-retry', '附件状态已变化，请刷新后重试')
      }
    }
    const list = (urlResult && urlResult.fileList) || []
    const urls = verified.map((v, i) => {
      const entry = list[i]
      if (!entry || !entry.tempFileURL) return null
      return { fileId: v.att.fileId, tempFileURL: entry.tempFileURL, contentType: v.fdoc.contentType, sizeBytes: v.fdoc.sizeBytes }
    })
    if (urls.some(u => !u)) return fail('temp-url-failed', '获取访问地址失败')
    return ok({ urls, expiresIn: '短期有效，有效期由平台决定' })
  }

  // ── 报告 upsert（创建须完整必填；部分编辑保留其他字段；引用记账同事务）──
  if (action === 'report.upsert') {
    if (!event.id || typeof event.id !== 'string' || event.id.length > 64) {
      return fail('invalid-params', '缺少稳定 id（rpt_*）')
    }
    const { out, errors } = sanitizeReport(event.payload || {})
    if (errors.length) return fail('invalid-params', errors.join('；'))
    // 创建（无既有文档）必须给全必填：日期 + 类型 + 至少一个附件；
    // 编辑（有文档）保持部分字段语义，未提交字段不重置
    const existingForCreate = await getDocMaybe(db.collection('mc_reports').doc(event.id))
    if (existingForCreate && existingForCreate.familyId !== config.familyId) {
      return fail('not-found', '记录不存在')
    }
    if (!existingForCreate) {
      if (!out.dateKey) return fail('invalid-params', '创建报告必须提供 dateKey')
      if (!out.reportType) return fail('invalid-params', '创建报告必须提供 reportType')
      if (!Array.isArray(out.attachments) || out.attachments.length === 0) {
        return fail('invalid-params', '创建报告必须至少包含一个附件')
      }
    }
    return commitReportTx(db, config, {
      collection: 'mc_reports', docId: event.id, kind: 'report',
      caller, operationId: event.operationId, expectedRevision: expected,
      requestChanges: out,
      extraFields: {
        familyId: config.familyId, type: 'report',
        dateKey: out.dateKey || '', reportType: out.reportType || 'other',
        archiveStatus: out.archiveStatus || 'unarchived', note: null,
        hospital: null, weekOfPregnancy: null,
        attachments: [], uploaderId: caller.memberId,
        schemaVersion: SUPPORTED_SCHEMA, deleted: false
      },
      applyChanges: base => {
        Object.assign(base, out)
        base.sortKey = (base.dateKey || '') + ':' + event.id
        return base
      }
    })
  }

  // ── 删除：单事务内 原子墓碑 + 引用集合移除 + 空集合记 lastDetachedAt ──
  if (action === 'report.delete') {
    if (!event.id) return fail('invalid-params', '缺少 id')
    return commitReportTx(db, config, {
      collection: 'mc_reports', docId: event.id, kind: 'report-delete',
      caller, operationId: event.operationId, expectedRevision: expected,
      requestChanges: { deleted: true },
      extraFields: { familyId: config.familyId, type: 'report', schemaVersion: SUPPORTED_SCHEMA },
      applyChanges: base => { base.deleted = true; return base }
    })
  }

  // ── 清理：显式动作（默认不配置自动云任务）；失败保留状态可重试 ──
  if (action === 'report.cleanupOrphans') {
    const now = Date.now()
    const results = []
    // 稳定分页完整遍历（_id 降序游标）：终态墓碑再多也不阻挡后面的可清理对象
    const cmd = db.command
    const rows = []
    let cursor = null
    let pages = 0
    do {
      const where = { familyId: config.familyId }
      if (cursor) where._id = cmd.lt(cursor)
      const snap = await db.collection(COLLECTIONS.files)
        .where(where).orderBy('_id', 'desc').limit(500).get()
      const pageRows = (snap && snap.data) || []
      for (const r of pageRows) rows.push(r)
      cursor = pageRows.length === 500 ? pageRows[pageRows.length - 1]._id : null
      pages++
      if (pages > 50) break // 受控上限（异常中止，如实保留剩余项）
    } while (cursor)
    for (const row of rows) {
      const fileId = row._id
      if (row.status === 'deleted') {
        // 终态幂等；但登记侧补偿失败留下的 pendingCompensation 需按真实句柄补删
        if (row.pendingCompensation && (row.formalFileID || row.stageFileID)) {
          const comp = await deleteFileObjects(cloud, db, fileId, row)
          if (comp.action === 'cleaned') {
            try {
              const t = await db.startTransaction()
              const doc = await getDocMaybe(t.collection(COLLECTIONS.files).doc(fileId))
              if (doc) {
                const { _id: _f, ...fields } = doc
                void _f
                await t.collection(COLLECTIONS.files).doc(fileId).set({
                  data: { ...fields, pendingCompensation: false }
                })
              }
              await t.commit()
            } catch (err) { /* 下次再清 */ }
            results.push({ fileId, action: 'compensated' })
          } else {
            results.push(comp)
          }
          continue
        }
        results.push({ fileId, action: 'skipped-deleted' }) // 终态幂等
        continue
      }
      if (row.status === 'cleaning') {
        // 上次清理中断：幂等续做存储删除（认领时已排除引用，新引用被拒）
        results.push(await deleteFileObjects(cloud, db, fileId, row))
        continue
      }
      if (row.status === 'claiming') {
        // 暂存任务：超过保留期且无活跃登记（状态停滞）才回收
        const staleAt = (row.updatedAt || row.createdAt || 0) + CLAIM_STALE_MS
        if (now < staleAt) { results.push({ fileId, action: 'skipped-active' }); continue }
        results.push(await cleanupStaleClaim(cloud, db, config, fileId, now))
        continue
      }
      if (row.status === 'registered') {
        // 引用判定只认事务保护的引用集合；宽限从引用移除/登记完成起算
        const refs = Array.isArray(row.attachedReportIds) ? row.attachedReportIds : []
        if (refs.length > 0) { results.push({ fileId, action: 'skipped-referenced' }); continue }
        const graceFrom = row.lastDetachedAt || row.registeredAt || row.createdAt || 0
        if (now < graceFrom + REGISTERED_GRACE_MS) {
          results.push({ fileId, action: 'skipped-within-grace' })
          continue
        }
        results.push(await claimAndClean(cloud, db, config, fileId, now))
        continue
      }
      results.push({ fileId, action: 'skipped-unknown-status' })
    }
    const cleaned = results.filter(r => r.action === 'cleaned').length
    return ok({ results, cleaned, remaining: results.length - cleaned })
  }

  return fail('invalid-action', '未知 action')
}

// 停滞 claiming：事务内确认仍为 claiming（无活跃登记推进）→ 直接进入存储删除
async function cleanupStaleClaim(cloud, db, config, fileId, now) {
  const t = await db.startTransaction()
  try {
    const doc = await getDocMaybe(t.collection(COLLECTIONS.files).doc(fileId))
    if (!doc || doc.familyId !== config.familyId || doc.status !== 'claiming') {
      await t.rollback()
      return { fileId, action: 'skipped-not-claiming' }
    }
    const stillStale = now >= (doc.updatedAt || doc.createdAt || 0) + CLAIM_STALE_MS
    if (!stillStale) {
      await t.rollback()
      return { fileId, action: 'skipped-active' }
    }
    const { _id: _f, ...fields } = doc
    void _f
    await t.collection(COLLECTIONS.files).doc(fileId).set({
      data: { ...fields, status: 'cleaning', cleanupStartedAt: now }
    })
    await t.commit()
    return await deleteFileObjects(cloud, db, fileId, { ...doc, status: 'cleaning' })
  } catch (err) {
    try { await t.rollback() } catch (e) { /* */ }
    return { fileId, action: 'failed', retryable: true, errMsg: 'claim-failed' }
  }
}
// registered→cleaning 认领：同事务再核引用集合为空 + 宽限已过（P1-3 原子保护）
async function claimAndClean(cloud, db, config, fileId, now) {
  const t = await db.startTransaction()
  try {
    const doc = await getDocMaybe(t.collection(COLLECTIONS.files).doc(fileId))
    if (!doc || doc.familyId !== config.familyId || doc.status !== 'registered') {
      await t.rollback()
      return { fileId, action: 'skipped-not-registered' }
    }
    const refs = Array.isArray(doc.attachedReportIds) ? doc.attachedReportIds : []
    if (refs.length > 0) {
      await t.rollback()
      return { fileId, action: 'skipped-referenced' }
    }
    const graceFrom = doc.lastDetachedAt || doc.registeredAt || doc.createdAt || 0
    if (now < graceFrom + REGISTERED_GRACE_MS) {
      await t.rollback()
      return { fileId, action: 'skipped-within-grace' }
    }
    const { _id: _f, ...fields } = doc
    void _f
    const cleaningDoc = { ...fields, status: 'cleaning', cleanupStartedAt: now }
    await t.collection(COLLECTIONS.files).doc(fileId).set({ data: cleaningDoc })
    await t.commit()
    return await deleteFileObjects(cloud, db, fileId, cleaningDoc)
  } catch (err) {
    try { await t.rollback() } catch (e) { /* */ }
    return { fileId, action: 'failed', retryable: true, errMsg: 'claim-failed' }
  }
}

// 存储删除：真实 SDK 契约（wx-server-sdk@4.0.2 index.d.ts:218-231 / index.js:625-656）
// —— 参数 {fileList: string[]}，结果 fileList 逐对象 status/errMsg，单条失败不抛错。
// 任一对象 status≠0/缺失 → 保留 cleaning 供重试（禁止失败即完成）；
// 全部成功 → 终态 deleted（文件墓碑，不删记录，防同 uploadId 复活——P1-2）。
// formalTargetPath（mc-files 在转存后记录的目标）一并纳入删除：迟到复制留下的
// 孤儿正式对象按记录回收（终态记录保留该字段供后续补偿清扫）。
async function deleteFileObjects(cloud, db, fileId, row) {
  // 只以真实 fileID 句柄删除（stageFileID/formalFileID）；cloudPath 不是 fileID。
  // 迟到复制的孤儿由 mc-files 登记侧以实际 fileID 补偿删除（登记拒绝路径）。
  const targets = []
  if (row.stageFileID) targets.push(row.stageFileID)
  if (row.formalFileID) targets.push(row.formalFileID)
  if (targets.length > 0) {
    let res
    try {
      res = await cloud.deleteFile({ fileList: targets })
    } catch (err) {
      return { fileId, action: 'failed', retryable: true, errMsg: 'storage-delete-failed' }
    }
    const list = (res && res.fileList) || []
    for (const fileID of targets) {
      const entry = list.find(e => e.fileID === fileID)
      if (!entry || entry.status !== 0) {
        return { fileId, action: 'failed', retryable: true, errMsg: 'storage-delete-failed' }
      }
    }
  }
  // 终态墓碑：保留记录与 uploadId 供审计；registerStaged 对 deleted 显式拒绝
  try {
    const t = await db.startTransaction()
    const doc = await getDocMaybe(t.collection(COLLECTIONS.files).doc(fileId))
    if (!doc) { await t.commit(); return { fileId, action: 'cleaned' } }
    const { _id: _f, ...fields } = doc
    void _f
    // 终态保留 uploadId/stageFileID/formalTargetPath 等字段：同 uploadId 复活被拒，
    // 且迟到复制的孤儿正式对象可按记录路径补偿清扫
    await t.collection(COLLECTIONS.files).doc(fileId).set({
      data: { ...fields, status: 'deleted', cleanedAt: Date.now() }
    })
    await t.commit()
  } catch (err) {
    return { fileId, action: 'failed', retryable: true, errMsg: 'tombstone-write-failed' }
  }
  return { fileId, action: 'cleaned' }
}
