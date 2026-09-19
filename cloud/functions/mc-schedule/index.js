'use strict'

// mc-schedule：B2b1 权威产检与待产包数据源（一个函数两个文档族）：
//   checkups —— 家庭共享产检（稳定 ID，同周可多条）
//   bag      —— 家庭共享待产包项目（稳定 ID，同名可多条）
//
// 关键语义（B2b1 spec）：
// - 稳定实体 ID：chk_<uuid> / bag_<uuid>（非周数/名称）；模板条目带 templateKey
// - initialize：显式触发模板生成；templateKey 在家庭内唯一（重复点击/丢响应重放安全，
//   两端同时初始化每个 templateKey 至多一条）；已删模板不被重建
// - migrate-preview / migrate-apply：修改孕期日期后先预览待调整的自动安排，
//   确认后仅更新 pending 自动条目（completed/skipped/manual 不动）；
//   逐条带旧 revision，冲突不整批覆盖，部分成功可恢复
// - 墓碑/分页/幂等/schemaVersion 与 mc-health 同一契约
// - 字段白名单、枚举、空值语义显式校验

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

// ── 字段白名单 ──
const CHECKUP_STATUS = ['pending', 'completed', 'skipped']
const CHECKUP_EXAM_ITEM_MAX = 50
const CHECKUP_MATERIALS_MAX = 20
const CHECKUP_QUESTIONS_MAX = 20

const BAG_CATEGORIES = ['mom', 'baby', 'documents', 'going', 'other']

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

// 按可信 familyId 校验文档归属（修复7：跨家庭读取泄漏）
function getFamilyDoc(db, collection, docId, familyId) {
  return getDocMaybe(db.collection(collection).doc(docId)).then(doc => {
    if (!doc) return null
    if (doc.familyId !== familyId) return null // 外家庭文档等同不存在
    return doc
  })
}
// get+schema 校验一体化：不支持的存量版本返回 null + 明确失败
async function getFamilyDocChecked(db, collection, docId, familyId) {
  const doc = await getFamilyDoc(db, collection, docId, familyId)
  if (!doc) return { doc: null }
  if (storedSchemaUnsupported(doc)) return { fail: unsupportedFail(doc) }
  return { doc }
}
// 读取时检查存量 schema（不支持的版本明确拒绝，不返回正文）
function checkDocReadable(doc) {
  if (storedSchemaUnsupported(doc)) return unsupportedFail(doc)
  return null
}
// 真实日历日期校验（2026-02-31 无效）
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

// 事务 upsert 内核（与 mc-health 相同模式）
async function transactionalUpsert(db, config, { collection, docId, kind, caller, operationId,
  expectedRevision, requestChanges, extraFields, applyChanges, buildView }) {
  const opKey = `${caller.memberId}:${operationId}`
  const opDoc = {
    memberId: caller.memberId, operationId, kind,
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
      const current = await getDocMaybe(t.collection(collection).doc(docId))
      await t.rollback()
      if (storedSchemaUnsupported(current)) return unsupportedFail(current)
      return ok({ replayed: true, record: prevOp.resultSnapshot, currentRecord: buildView(current, docId) })
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
    if (existing && existing.deleted && kind !== 'checkup-delete' && kind !== 'bag-delete') {
      await t.rollback()
      return fail('revision-conflict', '记录已删除，编辑不能自动复活', {
        currentRevision, currentRecord: buildView(existing)
      })
    }
    if (expectedRevision !== currentRevision) {
      await t.rollback()
      return fail('revision-conflict', '记录已被对方更新', {
        currentRevision, currentRecord: buildView(existing)
      })
    }
    const base = existing ? { ...existing } : { ...extraFields }
    const merged = applyChanges(base, existing)
    merged.revision = currentRevision + 1
    merged.updatedBy = caller.memberId
    merged.updatedAt = now
    const { _id: _f, ...setData } = merged
    void _f
    const resultSnapshot = buildView(merged, docId)
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

function viewCheckup(doc, fallbackId) {
  if (!doc) return null
  return { ...doc, id: doc._id || doc.id || fallbackId || '', deleted: Boolean(doc.deleted) }
}
function viewBag(doc, fallbackId) {
  if (!doc) return null
  return { ...doc, id: doc._id || doc.id || fallbackId || '', deleted: Boolean(doc.deleted) }
}

// 分页（与 mc-health 相同 where+orderBy+limit 模式）
async function listPage(db, collection, filters, orderBy, cursorField, cursor, limit) {
  const cmd = db.command
  const where = { ...filters }
  if (cursor) where[cursorField] = cmd.lt(cursor)
  const res = await db.collection(collection)
    .where(where)
    .orderBy(orderBy, 'desc')
    .limit(limit)
    .get()
  const rows = (res && res.data) || []
  const last = rows[rows.length - 1]
  const nextCursor = rows.length === limit && last ? last[cursorField] : null
  return { records: rows, nextCursor }
}

// ── 校验器 ──
function sanitizeCheckup(input) {
  const errors = []
  const out = {}
  if (input.dateKey !== undefined) {
    if (!isValidCalendarDate(String(input.dateKey))) errors.push('dateKey 必须是有效日历日期 YYYY-MM-DD')
    else out.dateKey = String(input.dateKey)
  }
  if (input.time !== undefined) {
    if (input.time === null || input.time === '') out.time = null
    else {
      const tm = String(input.time)
      if (!/^\d{2}:\d{2}$/.test(tm)) errors.push('time 必须是 HH:MM')
      else {
        const [h, min] = tm.split(':').map(Number)
        if (h > 23 || min > 59) errors.push('time 值无效（0-23:0-59）')
        else out.time = tm
      }
    }
  }
  if (input.hospital !== undefined) {
    if (input.hospital === null || input.hospital === '') out.hospital = null
    else if (typeof input.hospital !== 'string' || input.hospital.length > 100) errors.push('hospital 须 ≤100 字')
    else out.hospital = input.hospital
  }
  if (input.companion !== undefined) {
    if (input.companion === null || input.companion === '') out.companion = null
    else if (typeof input.companion !== 'string' || input.companion.length > 20) errors.push('companion 须 ≤20 字')
    else out.companion = input.companion
  }
  if (input.materials !== undefined) {
    if (!Array.isArray(input.materials)) errors.push('materials 必须是数组')
    else if (input.materials.length > CHECKUP_MATERIALS_MAX) errors.push(`materials ≤${CHECKUP_MATERIALS_MAX}`)
    else if (input.materials.some(m => typeof m !== 'string' || m.length > 50)) errors.push('materials 项须 ≤50 字')
    else out.materials = input.materials
  }
  if (input.questions !== undefined) {
    if (!Array.isArray(input.questions)) errors.push('questions 必须是数组')
    else if (input.questions.length > CHECKUP_QUESTIONS_MAX) errors.push(`questions ≤${CHECKUP_QUESTIONS_MAX}`)
    else if (input.questions.some(q => typeof q !== 'string' || q.length > 200)) errors.push('questions 项须 ≤200 字')
    else out.questions = input.questions
  }
  if (input.examItems !== undefined) {
    if (!Array.isArray(input.examItems)) errors.push('examItems 必须是数组')
    else if (input.examItems.length > CHECKUP_EXAM_ITEM_MAX) errors.push(`examItems ≤${CHECKUP_EXAM_ITEM_MAX}`)
    else {
      const items = []
      const seenIds = new Set()
      for (const it of input.examItems) {
        if (!it || typeof it !== 'object' || !it.itemId || typeof it.itemId !== 'string') {
          errors.push('examItems 每项须有 itemId'); break
        }
        const iid = String(it.itemId).slice(0, 64)
        if (seenIds.has(iid)) { errors.push(`examItems itemId 重复: ${iid}`); break }
        seenIds.add(iid)
        items.push({
          itemId: iid,
          text: String(it.text || '').slice(0, 50),
          required: Boolean(it.required),
          done: Boolean(it.done)
        })
      }
      if (!errors.length) out.examItems = items
    }
  }
  return { out, errors }
}

function sanitizeBagItem(input) {
  const errors = []
  const out = {}
  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || input.name.trim() === '' || input.name.length > 50) {
      errors.push('name 须 1-50 字')
    } else out.name = input.name.trim()
  }
  if (input.category !== undefined) {
    if (!BAG_CATEGORIES.includes(input.category)) errors.push(`category 须 ${BAG_CATEGORIES.join('/')}`)
    else out.category = input.category
  }
  if (input.quantity !== undefined) {
    const q = Number(input.quantity)
    if (!Number.isInteger(q) || q < 1 || q > 99) errors.push('quantity 须 1-99 正整数')
    else out.quantity = q
  }
  if (input.location !== undefined) {
    if (input.location === null || input.location === '') out.location = null
    else if (typeof input.location !== 'string' || input.location.length > 50) errors.push('location 须 ≤50 字')
    else out.location = input.location
  }
  if (input.assignee !== undefined) {
    if (input.assignee === null || input.assignee === '') out.assignee = null
    else if (!['mama', 'papa'].includes(input.assignee)) errors.push('assignee 须 mama/papa')
    else out.assignee = input.assignee
  }
  if (input.prepared !== undefined) {
    out.prepared = Boolean(input.prepared)
  }
  return { out, errors }
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
  const READ_ACTIONS = ['checkup.get', 'checkup.list', 'bag.get', 'bag.list',
    'checkup.migrate-preview']
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

  // ── 产检 ──
  if (action === 'checkup.get') {
    if (!event.id) return fail('invalid-params', '缺少 id')
    const { doc, fail: sf } = await getFamilyDocChecked(db, 'mc_checkups', event.id, config.familyId)
    if (sf) return sf
    return ok({ record: viewCheckup(doc, event.id) })
  }

  if (action === 'checkup.list') {
    const limitRaw = Number(event.limit || PAGE_DEFAULT)
    const limit = Math.min(Math.max(Number.isInteger(limitRaw) ? limitRaw : PAGE_DEFAULT, 1), PAGE_MAX)
    const cursor = event.cursor || null
    const page = await listPage(db, 'mc_checkups',
      { familyId: config.familyId }, 'sortKey', 'sortKey', cursor, limit)
    // 存量不支持版本：列表也明确拒绝（不静默跳过）
    for (const r of page.records) {
      if (storedSchemaUnsupported(r)) return unsupportedFail(r)
    }
    return ok({ records: page.records.map(r => viewCheckup(r, r._id)), nextCursor: page.nextCursor, hasMore: Boolean(page.nextCursor) })
  }

  if (action === 'checkup.upsert') {
    if (!event.id || typeof event.id !== 'string' || event.id.length > 64) {
      return fail('invalid-params', '缺少稳定 id（chk_*）')
    }
    if (event.status !== undefined && !CHECKUP_STATUS.includes(event.status)) {
      return fail('invalid-params', `status 须 ${CHECKUP_STATUS.join('/')}`)
    }
    const { out, errors } = sanitizeCheckup(event.payload || {})
    if (errors.length) return fail('invalid-params', errors.join('；'))
    return transactionalUpsert(db, config, {
      collection: 'mc_checkups', docId: event.id, kind: 'checkup',
      caller, operationId: event.operationId, expectedRevision: expected,
      requestChanges: { ...out, ...(event.status !== undefined ? { status: event.status } : {}), templateKey: event.templateKey || null, source: event.source || 'manual' },
      extraFields: {
        familyId: config.familyId, type: 'checkup',
        dateKey: out.dateKey || '', time: null, hospital: null,
        companion: null, materials: [], questions: [], examItems: [],
        status: 'pending', templateKey: event.templateKey || null,
        source: event.source || 'manual', schemaVersion: SUPPORTED_SCHEMA
      },
      applyChanges: (base, existingDoc) => {
        const hadDateChange = out.dateKey !== undefined && existingDoc && existingDoc.dateKey !== out.dateKey
        Object.assign(base, out)
        // 修复6：status 只在显式传入（event.status !== undefined）时覆盖
        if (event.status !== undefined) base.status = event.status
        if (event.templateKey !== undefined) base.templateKey = event.templateKey || null
        if (event.source !== undefined) base.source = event.source || 'manual'
        // 手动改期退出模板迁移资格（source 'template' → 'manual-date'）
        if (hadDateChange && base.source === 'template') base.source = 'manual-date'
        base.sortKey = (base.dateKey || '') + ':' + event.id
        return base
      },
      buildView: viewCheckup
    })
  }

  if (action === 'checkup.delete') {
    if (!event.id) return fail('invalid-params', '缺少 id')
    return transactionalUpsert(db, config, {
      collection: 'mc_checkups', docId: event.id, kind: 'checkup-delete',
      caller, operationId: event.operationId, expectedRevision: expected,
      requestChanges: { deleted: true },
      extraFields: { familyId: config.familyId, type: 'checkup', schemaVersion: SUPPORTED_SCHEMA },
      applyChanges: base => { base.deleted = true; return base },
      buildView: viewCheckup
    })
  }

  // 勾选项目：按 itemId 原子更新（不带整个 examItems 数组，防止并发覆盖其他项目）
  if (action === 'checkup.toggle-item') {
    if (!event.id || !event.itemId) return fail('invalid-params', '缺少 id/itemId')
    const checkupId = event.id
    const itemId = String(event.itemId).slice(0, 64)
    const t = await db.startTransaction()
    try {
      // 幂等重放（修复4）：同 opId 先读 operations——已处理则返回首次结果
      const toggleOpKey = `${caller.memberId}:${event.operationId}`
      const toggleOp = await getDocMaybe(t.collection(COLLECTIONS.operations).doc(toggleOpKey))
      if (toggleOp) {
        const currentHash = stableRequestHash({ id: checkupId, itemId, expectedRevision: expected, targetDone: typeof event.targetDone === 'boolean' ? event.targetDone : null })
        if (toggleOp.requestHash !== currentHash) {
          await t.rollback()
          return fail('operation-id-conflict', '同一 operationId 曾以不同内容提交')
        }
        const current = await getDocMaybe(t.collection('mc_checkups').doc(checkupId))
        await t.rollback()
        return ok({ replayed: true, record: toggleOp.resultSnapshot, currentRecord: viewCheckup(current, checkupId) })
      }
      const doc = await getDocMaybe(t.collection('mc_checkups').doc(checkupId))
      if (!doc || doc.familyId !== config.familyId) { await t.rollback(); return fail('not-found', '产检不存在') }
      if (storedSchemaUnsupported(doc)) { await t.rollback(); return unsupportedFail(doc) }
      if (doc.deleted) { await t.rollback(); return fail('revision-conflict', '已删除') }
      if (expected !== doc.revision) {
        await t.rollback()
        return fail('revision-conflict', '记录已被对方更新', { currentRevision: doc.revision, currentRecord: viewCheckup(doc) })
      }
      const items = (doc.examItems || []).map(it => ({ ...it }))
      const idx = items.findIndex(it => it.itemId === itemId)
      if (idx === -1) { await t.rollback(); return fail('not-found', `项目 ${itemId} 不存在`) }
      // 目标值语义：客户端传 targetDone（要设置的目标布尔值），非翻转——
      // 解决冲突后重提不会把"勾选"变"取消"
      const targetDone = typeof event.targetDone === 'boolean' ? event.targetDone : !items[idx].done
      if (items[idx].done === targetDone) {
        await t.rollback()
        return ok({ replayed: false, record: viewCheckup(doc, checkupId), unchanged: true })
      }
      items[idx].done = targetDone
      const opKey = `${caller.memberId}:${event.operationId}`
      const { _id: _f, ...setData } = doc
      void _f
      setData.examItems = items
      setData.revision = doc.revision + 1
      setData.updatedBy = caller.memberId
      setData.updatedAt = Date.now()
      const resultSnapshot = viewCheckup(setData, checkupId)
      await t.collection('mc_checkups').doc(checkupId).set({ data: setData })
      await t.collection(COLLECTIONS.operations).doc(opKey).set({
        data: { memberId: caller.memberId, operationId: event.operationId, kind: 'checkup-item',
          requestHash: stableRequestHash({ id: checkupId, itemId, expectedRevision: expected, targetDone: typeof event.targetDone === 'boolean' ? event.targetDone : null }),
          resultSnapshot, createdAt: Date.now() }
      })
      await t.commit()
      return ok({ replayed: false, record: resultSnapshot })
    } catch (err) {
      try { await t.rollback() } catch (e) { /* */ }
      return fail('transaction-failed', '事务未提交成功，可安全重试')
    }
  }

  // 模板初始化：显式触发；templateKey 家庭内唯一（幂等）
  if (action === 'checkup.initialize') {
    const templates = Array.isArray(event.templates) ? event.templates : []
    if (templates.length === 0) return fail('invalid-params', '缺少 templates')
    if (templates.length > 20) return fail('invalid-params', 'templates ≤20')
    const results = []
    for (const tpl of templates) {
      if (!tpl.templateKey || !tpl.dateKey || !isValidCalendarDate(String(tpl.dateKey))) {
        results.push({ templateKey: tpl.templateKey || '', ok: false, code: 'invalid-params' })
        continue
      }
      // 可信来源基线（修复16）：持久 templateDate/templateLmp——
      // 预览/部分迁移后的再次预览按来源绝对计算，不随当前 dateKey 漂移
      const templateLmp = (tpl.templateLmp && isValidCalendarDate(String(tpl.templateLmp))) ? String(tpl.templateLmp) : null
      // 幂等：同 templateKey 已存在（含已删）则跳过，不重复创建
      // 确定性主键 + 事务内读-判断-写（修复：在途初始化不覆盖后续用户编辑）
      const id = 'chk_tpl_' + tpl.templateKey.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48)
      const itx = await db.startTransaction()
      try {
        const existing = await getDocMaybe(itx.collection('mc_checkups').doc(id))
        if (existing) {
          await itx.rollback()
          results.push({ templateKey: tpl.templateKey, ok: true, skipped: true, id })
          continue
        }
        const doc = {
          familyId: config.familyId, type: 'checkup', dateKey: String(tpl.dateKey),
          sortKey: String(tpl.dateKey) + ':' + id,
          templateDate: String(tpl.dateKey), templateLmp,
          time: tpl.time || null, hospital: tpl.hospital || null,
          companion: null, materials: [], questions: [],
          examItems: (tpl.examItems || []).map(it => ({
            itemId: String(it.itemId || 'itm_' + Math.random().toString(36).slice(2, 8)),
            text: String(it.text || ''), required: Boolean(it.required), done: false
          })),
          status: 'pending', templateKey: String(tpl.templateKey), source: 'template',
          revision: 1, updatedBy: caller.memberId, updatedAt: Date.now(),
          schemaVersion: SUPPORTED_SCHEMA, deleted: false
        }
        await itx.collection('mc_checkups').doc(id).set({ data: doc })
        await itx.commit()
        results.push({ templateKey: tpl.templateKey, ok: true, skipped: false, id })
      } catch (e) {
        try { await itx.rollback() } catch (e2) { /* */ }
        // 事务冲突：另一端并发初始化已创建 → 幂等跳过
        const after = await getDocMaybe(db.collection('mc_checkups').doc(id))
        if (after) {
          results.push({ templateKey: tpl.templateKey, ok: true, skipped: true, id })
        } else {
          results.push({ templateKey: tpl.templateKey, ok: false, code: 'transaction-failed' })
        }
      }
    }
    return ok({ results })
  }

  // 日期迁移预览：返回待调整的 pending 自动安排（不改数据）
  // 幂等（修复16）：每条以持久来源基线 templateDate/templateLmp 绝对计算目标日期，
  // 不随当前 dateKey 漂移——部分迁移后同一变更再次预览得到同一目标，不重复偏移
  if (action === 'checkup.migrate-preview') {
    if (!isValidCalendarDate(String(event.newLmpDate || ''))) return fail('invalid-params', 'newLmpDate 非法')
    // 公历日序（Date.UTC 月份从 0 开始：m-1）
    const ord = (dk) => { const [y, m, d] = dk.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000 }
    const oldLmp = String(event.oldLmpDate || '')
    const newLmp = String(event.newLmpDate)
    const snap = await db.collection('mc_checkups').where({
      familyId: config.familyId, type: 'checkup', source: 'template'
    }).limit(1000).get()
    const rows = (snap && snap.data) || []
    const toUpdate = []
    for (const r of rows) {
      if (r.deleted || r.status !== 'pending' || !r.dateKey) continue
    if (r.source !== 'template') continue // manual/manual-date/completed/skipped 均不迁移
      // 来源基线：优先记录级 templateDate/templateLmp；存量旧记录回退请求方基线
      const tplDate = r.templateDate || r.dateKey
      const originLmp = (r.templateLmp && isValidCalendarDate(String(r.templateLmp))) ? String(r.templateLmp) : oldLmp
      if (!isValidCalendarDate(String(tplDate)) || !isValidCalendarDate(String(originLmp))) continue
      const tplOrd = ord(tplDate)
      const oldOrd = ord(originLmp)
      if (Math.abs(tplOrd - oldOrd) > 400) continue // 模板不是从该来源 LMP 生成的
      const newOrdVal = tplOrd + (ord(newLmp) - oldOrd)
      const newDate = new Date(newOrdVal * 86400000)
      const ndk = `${newDate.getUTCFullYear()}-${String(newDate.getUTCMonth() + 1).padStart(2, '0')}-${String(newDate.getUTCDate()).padStart(2, '0')}`
      if (ndk !== r.dateKey) {
        toUpdate.push({ id: r._id, oldDateKey: r.dateKey, newDateKey: ndk, revision: r.revision, templateKey: r.templateKey })
      }
    }
    return ok({ shiftDays: ord(newLmp) - ord(oldLmp), toUpdate })
  }

  // 日期迁移执行：逐条带旧 revision；冲突/失败逐条返回，部分成功可恢复
  if (action === 'checkup.migrate-apply') {
    const ops = Array.isArray(event.ops) ? event.ops : []
    if (ops.length === 0) return fail('invalid-params', '缺少 ops')
    if (ops.length > 20) return fail('invalid-params', 'ops ≤20')
    const results = []
    for (const op of ops) {
      // 与 initialize 同一真实日历校验：2026-02-31 等格式合法但日历不存在的
      // 目标日期必须在写入前拒绝（服务17：此前仅 DATE_RE 格式检查被接受并落盘）
      if (!op.id || !op.newDateKey || !isValidCalendarDate(String(op.newDateKey))) {
        results.push({ id: op.id || '', ok: false, code: 'invalid-params' })
        continue
      }
      const t = await db.startTransaction()
      try {
        // 幂等重放 + requestHash 比较：同 opId 异内容拒绝
        const migOpKey = `${caller.memberId}:${event.operationId}:${op.id}`
        const migOp = await getDocMaybe(t.collection(COLLECTIONS.operations).doc(migOpKey))
        if (migOp) {
          await t.rollback()
          const currentHash = stableRequestHash({ id: op.id, newDateKey: op.newDateKey, expectedRevision: op.expectedRevision })
          if (migOp.requestHash !== currentHash) {
            results.push({ id: op.id, ok: false, code: 'operation-id-conflict' })
            continue
          }
          const curDoc = await getDocMaybe(db.collection('mc_checkups').doc(op.id))
          results.push({ id: op.id, ok: true, replayed: true, record: migOp.resultSnapshot, currentRecord: viewCheckup(curDoc, op.id) })
          continue
        }
        const doc = await getDocMaybe(t.collection('mc_checkups').doc(op.id))
        if (!doc || doc.deleted || doc.familyId !== config.familyId) {
          await t.rollback()
          results.push({ id: op.id, ok: false, code: 'not-found' })
          continue
        }
        if (doc.status !== 'pending' || doc.source !== 'template') {
          await t.rollback()
          results.push({ id: op.id, ok: false, code: 'not-eligible', message: '仅未完成自动安排可调整' })
          continue
        }
        if (op.expectedRevision !== doc.revision) {
          await t.rollback()
          results.push({ id: op.id, ok: false, code: 'revision-conflict', currentRevision: doc.revision })
          continue
        }
        const { _id: _f, ...setData } = doc
        void _f
        setData.dateKey = String(op.newDateKey)
        setData.sortKey = String(op.newDateKey) + ':' + op.id
        // 修复16：钉住存量记录的来源基线（本次改期前的日期/请求方 LMP），
        // 后续再次预览按来源绝对计算，不把已改过的 dateKey 当作来源
        if (!setData.templateDate) setData.templateDate = doc.dateKey
        if (!setData.templateLmp && event.originLmpDate && isValidCalendarDate(String(event.originLmpDate))) {
          setData.templateLmp = String(event.originLmpDate)
        }
        setData.revision = doc.revision + 1
        setData.updatedBy = caller.memberId
        setData.updatedAt = Date.now()
        // 修复：setData 剥离 _id 后必须带回稳定 id（fallback op.id），
        // 否则客户端 applyServerRecord 无法定位，store 滞留旧日期
        const snapshot = viewCheckup(setData, op.id)
        await t.collection('mc_checkups').doc(op.id).set({ data: setData })
        const opKey = `${caller.memberId}:${event.operationId}:${op.id}`
        await t.collection(COLLECTIONS.operations).doc(opKey).set({
          data: { memberId: caller.memberId, operationId: event.operationId + ':' + op.id,
            kind: 'checkup-migrate',
            requestHash: stableRequestHash({ id: op.id, newDateKey: op.newDateKey, expectedRevision: op.expectedRevision }),
            resultSnapshot: snapshot, createdAt: Date.now() }
        })
        await t.commit()
        results.push({ id: op.id, ok: true, record: snapshot })
      } catch (err) {
        try { await t.rollback() } catch (e) { /* */ }
        results.push({ id: op.id, ok: false, code: 'transaction-failed' })
      }
    }
    const succeeded = results.filter(r => r.ok).length
    return ok({ results, succeeded, failed: results.length - succeeded })
  }

  // ── 待产包 ──
  if (action === 'bag.get') {
    if (!event.id) return fail('invalid-params', '缺少 id')
    const { doc, fail: sf } = await getFamilyDocChecked(db, 'mc_bag_items', event.id, config.familyId)
    if (sf) return sf
    return ok({ record: viewBag(doc, event.id) })
  }

  if (action === 'bag.list') {
    const limitRaw = Number(event.limit || PAGE_DEFAULT)
    const limit = Math.min(Math.max(Number.isInteger(limitRaw) ? limitRaw : PAGE_DEFAULT, 1), PAGE_MAX)
    const cursor = event.cursor || null
    // _id 降序作为稳定唯一游标（同 createdAt 不漏行）；createdAt 仅作参考
    const cmd = db.command
    const where = { familyId: config.familyId }
    if (cursor) where._id = cmd.lt(cursor)
    const res = await db.collection('mc_bag_items')
      .where(where).orderBy('_id', 'desc').limit(limit).get()
    const rows = (res && res.data) || []
    const last = rows[rows.length - 1]
    for (const r of rows) {
      if (storedSchemaUnsupported(r)) return unsupportedFail(r)
    }
    const nextCursor = rows.length === limit && last ? last._id : null
    return ok({ records: rows.map(r => viewBag(r, r._id)), nextCursor, hasMore: Boolean(nextCursor) })
  }

  if (action === 'bag.upsert') {
    if (!event.id || typeof event.id !== 'string' || event.id.length > 64) {
      return fail('invalid-params', '缺少稳定 id（bag_*）')
    }
    const { out, errors } = sanitizeBagItem(event.payload || {})
    if (errors.length) return fail('invalid-params', errors.join('；'))
    if (Object.keys(out).length === 0) return fail('invalid-params', '没有可保存的字段')
    return transactionalUpsert(db, config, {
      collection: 'mc_bag_items', docId: event.id, kind: 'bag',
      caller, operationId: event.operationId, expectedRevision: expected,
      requestChanges: out,
      extraFields: {
        familyId: config.familyId, type: 'bag',
        name: '', category: 'other', quantity: 1, location: null,
        assignee: null, prepared: false, templateKey: null,
        schemaVersion: SUPPORTED_SCHEMA, deleted: false
      },
      applyChanges: base => {
        Object.assign(base, out)
        if (!base.createdAt) base.createdAt = Date.now()
        return base
      },
      buildView: viewBag
    })
  }

  if (action === 'bag.delete') {
    if (!event.id) return fail('invalid-params', '缺少 id')
    return transactionalUpsert(db, config, {
      collection: 'mc_bag_items', docId: event.id, kind: 'bag-delete',
      caller, operationId: event.operationId, expectedRevision: expected,
      requestChanges: { deleted: true },
      extraFields: { familyId: config.familyId, type: 'bag', schemaVersion: SUPPORTED_SCHEMA },
      applyChanges: base => { base.deleted = true; return base },
      buildView: viewBag
    })
  }

  // 待产包模板：同 checkup.initialize 模式
  if (action === 'bag.initialize') {
    const templates = Array.isArray(event.templates) ? event.templates : []
    if (templates.length === 0) return fail('invalid-params', '缺少 templates')
    if (templates.length > 100) return fail('invalid-params', 'templates ≤100')
    const results = []
    for (const tpl of templates) {
      if (!tpl.templateKey || !tpl.name || !tpl.category) {
        results.push({ templateKey: tpl.templateKey || '', ok: false, code: 'invalid-params' })
        continue
      }
      if (!BAG_CATEGORIES.includes(tpl.category)) {
        results.push({ templateKey: tpl.templateKey, ok: false, code: 'invalid-params' })
        continue
      }
      const id = 'bag_tpl_' + tpl.templateKey.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48)
      const btx = await db.startTransaction()
      try {
        const existing = await getDocMaybe(btx.collection('mc_bag_items').doc(id))
        if (existing) {
          await btx.rollback()
          results.push({ templateKey: tpl.templateKey, ok: true, skipped: true, id })
          continue
        }
        const doc = {
          familyId: config.familyId, type: 'bag',
          name: String(tpl.name).slice(0, 50), category: tpl.category,
          quantity: Number.isInteger(tpl.quantity) && tpl.quantity > 0 ? tpl.quantity : 1,
          location: null, assignee: null, prepared: false,
          templateKey: String(tpl.templateKey),
          revision: 1, updatedBy: caller.memberId, updatedAt: Date.now(),
          createdAt: Date.now(), schemaVersion: SUPPORTED_SCHEMA, deleted: false
        }
        await btx.collection('mc_bag_items').doc(id).set({ data: doc })
        await btx.commit()
        results.push({ templateKey: tpl.templateKey, ok: true, skipped: false, id })
      } catch (e) {
        try { await btx.rollback() } catch (e2) { /* */ }
        const after = await getDocMaybe(db.collection('mc_bag_items').doc(id))
        if (after) {
          results.push({ templateKey: tpl.templateKey, ok: true, skipped: true, id })
        } else {
          results.push({ templateKey: tpl.templateKey, ok: false, code: 'transaction-failed' })
        }
      }
    }
    return ok({ results })
  }

  return fail('invalid-action', '未知 action')
}
