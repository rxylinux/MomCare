'use strict'

// mc-collab：Phase C 家庭协同（分享需要 SharedNeeds + 共同任务 FamilyTasks）。
//
// 权威设计：docs/PHASE_C_DETAILED_SPECIFICATION_AND_PLAN.md §二 + 设计评审
// docs/PHASE_C_FAMILY_COLLAB_DESIGN_REVIEW_2026-09-20.md（最小服务端合同）。
//
// 核心语义：
// - 身份：resolveCaller 可信解析（event 中身份字段一律忽略）；单固定家庭两成员，
//   第三身份在 resolveCaller 即拒（not-family-member）——读写入口 100% 隔离。
// - 分享（mc_shared_needs）：创建/编辑/结束/撤回仅作者（ownerId===caller.memberId）；
//   正文 1..200 字白名单；撤回=单调墓碑——同事务物理抹除 content（置 null）、置 withdrawn、
//   withdrawnAt，并联动取消派生任务；一切读投影层强制 withdrawn⇒content:null——
//   即使磁盘残留旧正文也绝不返回（投影层兜底，不容错漏）。
// - 任务（mc_family_tasks）：确定性 ID tsk_${familyId}_${sourceType}_${sourceId}——
//   同源至多一个任务（并发双端创建由确定性 ID+事务 CAS 收敛）；need 来源不持久复制
//   分享正文（title 恒 null 存储，显示文案按需从当前 need 动态投影；撤回→"（分享已撤回）"）；
//   checkup/bag 来源完成状态以 mc_checkups/mc_bag_items 为权威（task.updateStatus 同事务
//   同步权威表；task.list 投影层按权威当前态呈现，不形成两份进度）。
// - operationId 幂等：mc_operations 键 memberId:operationId；请求摘要哈希同→重放、
//   异→operation-id-conflict。**操作回执不存正文**（仅请求摘要+实体指针）——重放按
//   当前实体状态重新生成脱敏响应（撤回后的旧创建重放绝不恢复原文——评审 §2/§5）。
// - 版本：expectedRevision 乐观并发（0=创建）；时间由服务端生成；updatedBy 可信派生。

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

const NEEDS = 'mc_shared_needs'
const TASKS = 'mc_family_tasks'
const OPS = COLLECTIONS.operations
const CHECKUPS = 'mc_checkups'
const BAG_ITEMS = 'mc_bag_items'

const NEED_STATUS = ['active', 'closed', 'withdrawn']
const TASK_STATUS = ['pending', 'doing', 'done', 'cancelled']
const SOURCE_TYPES = ['need', 'checkup', 'bag', 'custom']
const ALLOWED_TRANSITIONS = {
  pending: ['doing', 'done', 'cancelled'],
  doing: ['pending', 'done', 'cancelled'],
  done: ['pending', 'doing', 'cancelled'],
  cancelled: ['pending', 'doing']
}
const CONTENT_MAX = 200   // 分享正文字数上限（码点计）
const TITLE_MAX = 100     // 自定义任务标题字数上限
const PAGE_DEFAULT = 20
const PAGE_MAX = 100
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MASKED_TITLE = '（分享已撤回）'
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

function charCount(s) { return Array.from(s).length }

// 正文校验：字符串、去空白后非空、1..200 字（码点计）
function validateContent(content) {
  if (typeof content !== 'string') return 'content 必须是文本'
  if (content.trim() === '') return 'content 不能为空白'
  const n = charCount(content)
  if (n < 1 || n > CONTENT_MAX) return `content 须 1~${CONTENT_MAX} 字（收到 ${n} 字）`
  return null
}

// targetDate：null=清除；字符串=YYYY-MM-DD（格式校验——与 mc-schedule DATE_RE 同则）
function validateTargetDate(v) {
  if (v === null) return { ok: true, value: null }
  if (typeof v !== 'string' || !DATE_RE.test(v)) return { ok: false }
  return { ok: true, value: v }
}

function parseExpectedRevision(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
  return value
}

function buildTaskId(familyId, sourceType, sourceId) {
  return `tsk_${familyId}_${sourceType}_${sourceId}`
}

// 请求摘要（幂等去重）：**单向 SHA-256 摘要**——回执绝不落原文（评审 §5：回执只存
// 请求摘要+实体指针；分享正文即使为了幂等比较也不得明文持久）。同参同摘要、异参异摘要，
// 语义与明文比较等价。
function digestOf(obj) {
  return createHash('sha256').update(stableRequestHash(obj), 'utf8').digest('hex')
}

function sortKeyOf(createdAt, id) {
  return `${String(createdAt).padStart(16, '0')}:${id}`
}

function validateOperationId(event) {
  if (!event.operationId || typeof event.operationId !== 'string' || event.operationId.length > 64) {
    return fail('invalid-params', '缺少有效 operationId')
  }
  return null
}

// ── 投影层（撤回铁律：withdrawn ⇒ content 恒 null——磁盘残留也不透出）──
function viewNeed(doc) {
  if (!doc) return null
  const withdrawn = doc.status === 'withdrawn'
  return {
    needId: doc._id || doc.needId,
    ownerId: doc.ownerId,
    content: withdrawn ? null : (doc.content ?? null),
    targetDate: doc.targetDate ?? null,
    status: doc.status,
    withdrawnAt: doc.withdrawnAt ?? null,
    closedAt: doc.closedAt ?? null,
    revision: doc.revision,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    updatedBy: doc.updatedBy
  }
}

// need 状态解析（任务投影用）：文档缺失按 withdrawn 处理（脱敏安全缺省）
function needStateForProjection(needDoc, familyId) {
  if (!needDoc || needDoc.familyId !== familyId) return { status: 'withdrawn', content: null }
  if (needDoc.status === 'withdrawn') return { status: 'withdrawn', content: null }
  return { status: needDoc.status, content: typeof needDoc.content === 'string' ? needDoc.content : null }
}

// 任务视图（动态投影——title/status 均按当前权威态生成，不读存储副本）
// need：title=当前 active/closed 分享正文；撤回/缺失→脱敏占位（绝不带原文字符）。
// checkup：status 以 mc_checkups 为权威（completed→done/skipped→cancelled/否则任务态）；
// bag：prepared→done 否则任务态；权威文档缺失/墓碑→cancelled。
// custom：存储态直出。
function taskView(doc, projections) {
  const p = projections || {}
  let title = null
  let status = doc.status
  let needStatus
  if (doc.sourceType === 'need') {
    const np = p.need || { status: 'withdrawn', content: null }
    needStatus = np.status
    title = np.status === 'withdrawn' ? MASKED_TITLE : np.content
  } else if (doc.sourceType === 'custom') {
    title = typeof doc.title === 'string' ? doc.title : null
  } else if (doc.sourceType === 'checkup') {
    title = null
    const a = p.checkup
    if (a) {
      if (a.deleted) status = 'cancelled'
      else if (a.status === 'completed') status = 'done'
      else if (a.status === 'skipped') status = 'cancelled'
      else status = doc.status === 'cancelled' ? 'cancelled' : doc.status
    }
  } else if (doc.sourceType === 'bag') {
    title = null
    const a = p.bag
    if (a) {
      if (a.deleted) status = 'cancelled'
      else status = doc.status === 'cancelled' ? 'cancelled' : (a.prepared ? 'done' : doc.status)
    }
  }
  const view = {
    taskId: doc._id || doc.taskId,
    sourceType: doc.sourceType,
    sourceId: doc.sourceId,
    title,
    targetDate: doc.targetDate ?? null,
    status,
    assigneeId: doc.assigneeId ?? null,
    acceptedBy: doc.acceptedBy ?? null,
    acceptedAt: doc.acceptedAt ?? null,
    completedBy: doc.completedBy ?? null,
    completedAt: doc.completedAt ?? null,
    revision: doc.revision,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    updatedBy: doc.updatedBy
  }
  if (doc.sourceType === 'need') view.needStatus = needStatus
  return view
}

// 批量动态投影（task.list）：页内按来源分桶 keyed 读，避免 N+1 全表读
async function projectTaskRows(db, config, rows) {
  const needIds = [], checkupIds = [], bagIds = []
  for (const r of rows) {
    if (r.sourceType === 'need') needIds.push(r.sourceId)
    else if (r.sourceType === 'checkup') checkupIds.push(r.sourceId)
    else if (r.sourceType === 'bag') bagIds.push(r.sourceId)
  }
  const readBatch = async (col, ids) => {
    const map = new Map()
    for (let i = 0; i < ids.length; i += 20) {
      const part = ids.slice(i, i + 20)
      const docs = await Promise.all(part.map(id => getDocMaybe(db, col, id)))
      part.forEach((id, j) => map.set(id, docs[j]))
    }
    return map
  }
  const [needMap, checkupMap, bagMap] = await Promise.all([
    needIds.length ? readBatch(NEEDS, needIds) : Promise.resolve(new Map()),
    checkupIds.length ? readBatch(CHECKUPS, checkupIds) : Promise.resolve(new Map()),
    bagIds.length ? readBatch(BAG_ITEMS, bagIds) : Promise.resolve(new Map())
  ])
  return rows.map(r => {
    const p = {}
    if (r.sourceType === 'need') p.need = needStateForProjection(needMap.get(r.sourceId), config.familyId)
    else if (r.sourceType === 'checkup') p.checkup = checkupMap.get(r.sourceId)
    else if (r.sourceType === 'bag') p.bag = bagMap.get(r.sourceId)
    return taskView(r, p)
  })
}

// ── 幂等操作守卫（事务内首查）──
// 返回 {replayed: fail|ok} 或 {ready}。操作回执只存请求摘要+实体指针——不存正文；
// 重放按当前实体状态重新生成响应（撤回后旧创建重放→墓碑视图）。
async function opGuard(t, opKey, opDoc) {
  const prev = await getDocMaybe(t, OPS, opKey)
  if (!prev) return { ready: true }
  if (prev.requestHash !== opDoc.requestHash) {
    await t.rollback()
    return { replayed: fail('operation-id-conflict', '同一 operationId 曾以不同内容提交') }
  }
  return { replayed: 'ok', entity: prev.entity }
}

function stripId(doc) {
  const { _id, ...rest } = doc || {}
  return rest
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
  const READ_ACTIONS = ['need.list', 'task.list']
  if (!READ_ACTIONS.includes(action)) {
    const opErr = validateOperationId(event)
    if (opErr) return opErr
  }

  // ══ 分享需要（SharedNeeds）══

  if (action === 'need.create') {
    const contentErr = validateContent(event.content)
    if (contentErr) return fail('invalid-params', contentErr)
    const tdCheck = validateTargetDate(event.targetDate === undefined ? null : event.targetDate)
    if (!tdCheck.ok) return fail('invalid-params', 'targetDate 须 YYYY-MM-DD 或 null')
    const targetDate = tdCheck.value
    const now = Date.now()
    const needId = 'need_' + randomBytes(8).toString('hex')
    const opKey = `${caller.memberId}:${event.operationId}`
    const opDoc = {
      memberId: caller.memberId, operationId: event.operationId, kind: 'collab-need-create',
      requestHash: digestOf({ content: event.content, targetDate })
    }
    const t = await db.startTransaction()
    try {
      const guard = await opGuard(t, opKey, opDoc)
      if (guard.replayed === 'ok') {
        const cur = guard.entity && guard.entity.collection === NEEDS
          ? await getDocMaybe(t, NEEDS, guard.entity.docId) : null
        await t.rollback()
        return ok({ replayed: true, need: viewNeed(cur) })
      }
      if (guard.replayed) return guard.replayed
      const needDoc = {
        familyId: fid, ownerId: caller.memberId, content: event.content, targetDate,
        status: 'active', withdrawnAt: null, closedAt: null,
        revision: 1, createdAt: now, updatedAt: now, updatedBy: caller.memberId,
        sortKey: sortKeyOf(now, needId)
      }
      await t.collection(NEEDS).doc(needId).set({ data: { ...needDoc } })
      await t.collection(OPS).doc(opKey).set({
        data: { ...opDoc, entity: { collection: NEEDS, docId: needId }, createdAt: now }
      })
      await t.commit()
      return ok({ need: viewNeed({ ...needDoc, _id: needId }) })
    } catch (err) {
      try { await t.rollback() } catch (e) { /* 已回滚 */ }
      return fail('transaction-failed', '事务未提交成功，可安全重试', {
        errMsg: String((err && (err.errMsg || err.message)) || err).slice(0, 200)
      })
    }
  }

  if (action === 'need.update' || action === 'need.withdraw' || action === 'need.close') {
    const needId = event.needId
    if (!needId || typeof needId !== 'string' || needId.length > ID_MAX) {
      return fail('invalid-params', '缺少有效 needId')
    }
    const expected = parseExpectedRevision(event.expectedRevision)
    if (expected === null) return fail('invalid-params', 'expectedRevision 必须是显式非负整数')

    let requestChanges = null
    if (action === 'need.update') {
      const changes = {}
      if (event.content !== undefined) {
        const contentErr = validateContent(event.content)
        if (contentErr) return fail('invalid-params', contentErr)
        changes.content = event.content
      }
      if (event.targetDate !== undefined) {
        const tdCheck = validateTargetDate(event.targetDate)
        if (!tdCheck.ok) return fail('invalid-params', 'targetDate 须 YYYY-MM-DD 或 null')
        changes.targetDate = tdCheck.value
      }
      if (Object.keys(changes).length === 0) return fail('invalid-params', '没有可修改的字段')
      requestChanges = changes
    }

    const opKey = `${caller.memberId}:${event.operationId}`
    const opDoc = {
      memberId: caller.memberId, operationId: event.operationId, kind: `collab-${action.replace('.', '-')}`,
      requestHash: digestOf({ needId, expectedRevision: expected, ...(requestChanges || {}) })
    }
    const now = Date.now()
    const taskIdForNeed = buildTaskId(fid, 'need', needId)
    const t = await db.startTransaction()
    try {
      const guard = await opGuard(t, opKey, opDoc)
      if (guard.replayed === 'ok') {
        const cur = guard.entity && guard.entity.collection === NEEDS
          ? await getDocMaybe(t, NEEDS, guard.entity.docId) : null
        await t.rollback()
        return ok({ replayed: true, need: viewNeed(cur) })
      }
      if (guard.replayed) return guard.replayed

      const need = await getDocMaybe(t, NEEDS, needId)
      if (!need || need.familyId !== fid) { await t.rollback(); return fail('not-found', '分享不存在') }
      if (need.ownerId !== caller.memberId) { await t.rollback(); return fail('forbidden', '仅作者可操作该分享') }
      if (expected !== need.revision) {
        await t.rollback()
        return fail('revision-conflict', '分享已被更新，请刷新后重试', {
          currentRevision: need.revision, currentNeed: viewNeed(need)
        })
      }

      const merged = { ...stripId(need) }
      let taskCancelled = null
      if (action === 'need.update') {
        // 未结束/未撤回才可编辑（withdrawn/closed 均拒——墓碑不可复活）
        if (need.status !== 'active') { await t.rollback(); return fail('invalid-state', `仅 active 分享可编辑（当前 ${need.status}）`) }
        Object.assign(merged, requestChanges)
      } else if (action === 'need.close') {
        if (need.status !== 'active') { await t.rollback(); return fail('invalid-state', `仅 active 分享可关闭（当前 ${need.status}）`) }
        merged.status = 'closed'
        merged.closedAt = now
      } else {
        // withdraw：active/closed 均可撤（作者隐私权）；单调墓碑——同事务物理抹除正文
        if (need.status === 'withdrawn') { await t.rollback(); return fail('invalid-state', '分享已撤回（墓碑单调——不可重复操作）') }
        merged.status = 'withdrawn'
        merged.content = null // 物理抹除——服务端任何后续读不再持有原文
        merged.withdrawnAt = now
        // 联动：派生任务转 cancelled（同事务——标题本就不持久复制，投影层天然脱敏）
        const task = await getDocMaybe(t, TASKS, taskIdForNeed)
        if (task && task.familyId === fid && task.status !== 'cancelled') {
          const cancelledTask = {
            ...stripId(task),
            status: 'cancelled',
            title: task.sourceType === 'need' ? null : task.title, // need 任务标题恒不存正文（防御清空）
            completedBy: task.completedBy ?? null,
            completedAt: task.completedAt ?? null,
            revision: task.revision + 1, updatedAt: now, updatedBy: caller.memberId
          }
          await t.collection(TASKS).doc(taskIdForNeed).set({ data: cancelledTask })
          taskCancelled = { ...cancelledTask, _id: taskIdForNeed }
        }
      }
      merged.revision = need.revision + 1
      merged.updatedBy = caller.memberId
      merged.updatedAt = now
      await t.collection(NEEDS).doc(needId).set({ data: merged })
      await t.collection(OPS).doc(opKey).set({
        data: { ...opDoc, entity: { collection: NEEDS, docId: needId }, createdAt: now }
      })
      await t.commit()
      const needView = viewNeed({ ...merged, _id: needId })
      return ok({ need: needView, ...(taskCancelled ? { task: taskView(taskCancelled, { need: { status: 'withdrawn', content: null } }) } : {}) })
    } catch (err) {
      try { await t.rollback() } catch (e) { /* 已回滚 */ }
      return fail('transaction-failed', '事务未提交成功，可安全重试', {
        errMsg: String((err && (err.errMsg || err.message)) || err).slice(0, 200)
      })
    }
  }

  if (action === 'need.list') {
    const limitRaw = Number(event.limit || PAGE_DEFAULT)
    const limit = Math.min(Math.max(Number.isInteger(limitRaw) ? limitRaw : PAGE_DEFAULT, 1), PAGE_MAX)
    const cursor = (typeof event.cursor === 'string' && event.cursor) || null
    if (event.status !== undefined && event.status !== null && !NEED_STATUS.includes(event.status)) {
      return fail('invalid-params', `status 须 ${NEED_STATUS.join('/')}`)
    }
    const cmd = db.command
    const where = { familyId: fid }
    if (event.status) where.status = event.status
    if (cursor) where.sortKey = cmd.lt(cursor)
    const res = await db.collection(NEEDS).where(where).orderBy('sortKey', 'desc').limit(limit).get()
    const rows = (res && res.data) || []
    // 投影层兜底：撤回项 content 恒 null（磁盘残留旧正文也不透出）
    const needs = rows.map(viewNeed)
    const last = rows[rows.length - 1]
    const nextCursor = rows.length === limit && last ? last.sortKey : null
    return ok({ needs, nextCursor, hasMore: Boolean(nextCursor) })
  }

  // ══ 共同任务（FamilyTasks）══

  if (action === 'task.accept') {
    const { sourceType, sourceId } = event
    if (!SOURCE_TYPES.includes(sourceType)) return fail('invalid-params', `sourceType 须 ${SOURCE_TYPES.join('/')}`)
    if (!sourceId || typeof sourceId !== 'string' || sourceId.length > ID_MAX) {
      return fail('invalid-params', '缺少有效 sourceId')
    }
    const opKey = `${caller.memberId}:${event.operationId}`
    const opDoc = {
      memberId: caller.memberId, operationId: event.operationId, kind: 'collab-task-accept',
      requestHash: digestOf({ sourceType, sourceId })
    }
    const taskId = buildTaskId(fid, sourceType, sourceId)
    const now = Date.now()
    const t = await db.startTransaction()
    try {
      const guard = await opGuard(t, opKey, opDoc)
      if (guard.replayed === 'ok') {
        const cur = guard.entity && guard.entity.collection === TASKS
          ? await getDocMaybe(t, TASKS, guard.entity.docId) : null
        await t.rollback()
        if (!cur) return ok({ replayed: true, task: null })
        const projections = cur.sourceType === 'need'
          ? { need: needStateForProjection(await getDocMaybe(db, NEEDS, cur.sourceId), fid) } : {}
        return ok({ replayed: true, task: taskView(cur, projections) })
      }
      if (guard.replayed) return guard.replayed

      // 来源校验（单事务内——与任务读/创建原子）
      let needProjection = null
      let sourceTargetDate = null
      if (sourceType === 'need') {
        const need = await getDocMaybe(t, NEEDS, sourceId)
        if (!need || need.familyId !== fid) { await t.rollback(); return fail('not-found', '分享不存在') }
        if (need.status === 'withdrawn') { await t.rollback(); return fail('need-withdrawn', '分享已撤回——不能接下（原文已抹除）') }
        if (need.status !== 'active') { await t.rollback(); return fail('need-not-active', `分享当前 ${need.status}——仅 active 可接下`) }
        needProjection = needStateForProjection(need, fid)
        sourceTargetDate = need.targetDate ?? null
      } else if (sourceType === 'checkup' || sourceType === 'bag') {
        const col = sourceType === 'checkup' ? CHECKUPS : BAG_ITEMS
        const src = await getDocMaybe(t, col, sourceId)
        if (!src || src.familyId !== fid) { await t.rollback(); return fail('source-not-found', `来源 ${sourceType} 不存在`) }
        sourceTargetDate = sourceType === 'checkup' ? (src.dateKey ?? null) : null
      }
      // custom 来源无独立权威实体：任务只能来自 task.createCustom（不得凭空接下——下方 existing 门）

      const existing = await getDocMaybe(t, TASKS, taskId)
      if (existing) {
        if (existing.familyId !== fid) { await t.rollback(); return fail('not-found', '任务不存在') }
        // 确定性 ID + 已在场 → 幂等返回同一任务（不重复创建、不改既有承接人）
        await t.rollback()
        const projections = existing.sourceType === 'need'
          ? { need: needProjection || needStateForProjection(await getDocMaybe(db, NEEDS, existing.sourceId), fid) } : {}
        return ok({ task: taskView(existing, projections), existed: true })
      }
      if (sourceType === 'custom') {
        await t.rollback()
        return fail('source-not-found', '自定义任务不存在（须经 task.createCustom 创建）')
      }

      const taskDoc = {
        familyId: fid, sourceType, sourceId,
        title: null, // need/checkup/bag 均不持久标题；custom 经 createCustom 持有
        targetDate: sourceTargetDate,
        status: 'doing',
        assigneeId: null,
        acceptedBy: caller.memberId, acceptedAt: now,
        completedBy: null, completedAt: null,
        revision: 1, createdAt: now, updatedAt: now, updatedBy: caller.memberId,
        sortKey: sortKeyOf(now, taskId)
      }
      await t.collection(TASKS).doc(taskId).set({ data: { ...taskDoc } })
      await t.collection(OPS).doc(opKey).set({
        data: { ...opDoc, entity: { collection: TASKS, docId: taskId }, createdAt: now }
      })
      await t.commit()
      return ok({ task: taskView({ ...taskDoc, _id: taskId }, needProjection ? { need: needProjection } : {}) })
    } catch (err) {
      try { await t.rollback() } catch (e) { /* 已回滚 */ }
      return fail('transaction-failed', '事务未提交成功，可安全重试', {
        errMsg: String((err && (err.errMsg || err.message)) || err).slice(0, 200)
      })
    }
  }

  if (action === 'task.updateStatus') {
    const taskId = event.taskId
    if (!taskId || typeof taskId !== 'string' || taskId.length > ID_MAX) return fail('invalid-params', '缺少有效 taskId')
    const newStatus = event.status
    if (!TASK_STATUS.includes(newStatus)) return fail('invalid-params', `status 须 ${TASK_STATUS.join('/')}`)
    const expected = parseExpectedRevision(event.expectedRevision)
    if (expected === null) return fail('invalid-params', 'expectedRevision 必须是显式非负整数')
    const opKey = `${caller.memberId}:${event.operationId}`
    const opDoc = {
      memberId: caller.memberId, operationId: event.operationId, kind: 'collab-task-update-status',
      requestHash: digestOf({ taskId, status: newStatus, expectedRevision: expected })
    }
    const now = Date.now()
    const t = await db.startTransaction()
    try {
      const guard = await opGuard(t, opKey, opDoc)
      if (guard.replayed === 'ok') {
        const cur = guard.entity && guard.entity.collection === TASKS
          ? await getDocMaybe(t, TASKS, guard.entity.docId) : null
        await t.rollback()
        if (!cur) return ok({ replayed: true, task: null })
        return ok({ replayed: true, task: (await projectTaskRows(db, config, [cur]))[0] })
      }
      if (guard.replayed) return guard.replayed

      const task = await getDocMaybe(t, TASKS, taskId)
      if (!task || task.familyId !== fid) { await t.rollback(); return fail('not-found', '任务不存在') }
      if (expected !== task.revision) {
        await t.rollback()
        return fail('revision-conflict', '任务已被更新，请刷新后重试', {
          currentRevision: task.revision
        })
      }
      if (!ALLOWED_TRANSITIONS[task.status] || !ALLOWED_TRANSITIONS[task.status].includes(newStatus)) {
        await t.rollback()
        return fail('invalid-transition', `不允许 ${task.status} → ${newStatus}`)
      }

      // need 来源防复活：分享已撤回 → 除 cancelled 外一律拒（墓碑优先——旧版本不得写回）
      let needProjection = null
      if (task.sourceType === 'need') {
        const need = await getDocMaybe(t, NEEDS, task.sourceId)
        needProjection = needStateForProjection(need, fid)
        if (needProjection.status === 'withdrawn' && newStatus !== 'cancelled') {
          await t.rollback()
          return fail('need-withdrawn', '分享已撤回——任务只能保持 cancelled（原文已抹除）')
        }
      }

      // 权威源联动（同事务）：checkup/bag 完成状态唯一真源在 mc_checkups/mc_bag_items
      if (task.sourceType === 'checkup') {
        const src = await getDocMaybe(t, CHECKUPS, task.sourceId)
        if (src && src.familyId === fid && !src.deleted) {
          const next = { ...stripId(src) }
          let changed = false
          if (newStatus === 'done' && src.status !== 'completed') { next.status = 'completed'; changed = true }
          else if ((newStatus === 'pending' || newStatus === 'doing') && src.status === 'completed') { next.status = 'pending'; changed = true }
          if (changed) {
            next.revision = (src.revision || 0) + 1
            next.updatedBy = caller.memberId
            next.updatedAt = now
            await t.collection(CHECKUPS).doc(task.sourceId).set({ data: next })
          }
        }
      } else if (task.sourceType === 'bag') {
        const src = await getDocMaybe(t, BAG_ITEMS, task.sourceId)
        if (src && src.familyId === fid && !src.deleted) {
          const wantPrepared = newStatus === 'done'
          if (Boolean(src.prepared) !== wantPrepared) {
            const next = { ...stripId(src) }
            next.prepared = wantPrepared
            next.revision = (src.revision || 0) + 1
            next.updatedBy = caller.memberId
            next.updatedAt = now
            await t.collection(BAG_ITEMS).doc(task.sourceId).set({ data: next })
          }
        }
      }

      const merged = { ...stripId(task) }
      merged.status = newStatus
      merged.completedBy = newStatus === 'done' ? caller.memberId : null
      merged.completedAt = newStatus === 'done' ? now : null
      merged.revision = task.revision + 1
      merged.updatedBy = caller.memberId
      merged.updatedAt = now
      await t.collection(TASKS).doc(taskId).set({ data: merged })
      await t.collection(OPS).doc(opKey).set({
        data: { ...opDoc, entity: { collection: TASKS, docId: taskId }, createdAt: now }
      })
      await t.commit()
      return ok({ task: taskView({ ...merged, _id: taskId }, needProjection ? { need: needProjection } : {}) })
    } catch (err) {
      try { await t.rollback() } catch (e) { /* 已回滚 */ }
      return fail('transaction-failed', '事务未提交成功，可安全重试', {
        errMsg: String((err && (err.errMsg || err.message)) || err).slice(0, 200)
      })
    }
  }

  if (action === 'task.createCustom') {
    const title = event.title
    if (typeof title !== 'string' || title.trim() === '') return fail('invalid-params', 'title 必须是非空文本')
    const titleLen = charCount(title)
    if (titleLen > TITLE_MAX) return fail('invalid-params', `title 须 ≤${TITLE_MAX} 字（收到 ${titleLen} 字）`)
    const tdCheck = validateTargetDate(event.targetDate === undefined ? null : event.targetDate)
    if (!tdCheck.ok) return fail('invalid-params', 'targetDate 须 YYYY-MM-DD 或 null')
    const targetDate = tdCheck.value
    const assigneeId = event.assigneeId === undefined || event.assigneeId === null ? null : event.assigneeId
    if (assigneeId !== null && !config.members.some(m => m.memberId === assigneeId)) {
      return fail('invalid-params', 'assigneeId 须为本家庭成员或 null')
    }
    const now = Date.now()
    const sourceId = 'cst_' + randomBytes(8).toString('hex')
    const taskId = buildTaskId(fid, 'custom', sourceId)
    const opKey = `${caller.memberId}:${event.operationId}`
    const opDoc = {
      memberId: caller.memberId, operationId: event.operationId, kind: 'collab-task-create-custom',
      requestHash: digestOf({ title, targetDate: targetDate ?? null, assigneeId: assigneeId ?? null })
    }
    const t = await db.startTransaction()
    try {
      const guard = await opGuard(t, opKey, opDoc)
      if (guard.replayed === 'ok') {
        const cur = guard.entity && guard.entity.collection === TASKS
          ? await getDocMaybe(t, TASKS, guard.entity.docId) : null
        await t.rollback()
        return ok({ replayed: true, task: cur ? taskView(cur) : null })
      }
      if (guard.replayed) return guard.replayed
      const taskDoc = {
        familyId: fid, sourceType: 'custom', sourceId,
        title, targetDate,
        status: 'pending',
        assigneeId,
        acceptedBy: null, acceptedAt: null,
        completedBy: null, completedAt: null,
        revision: 1, createdAt: now, updatedAt: now, updatedBy: caller.memberId,
        sortKey: sortKeyOf(now, taskId)
      }
      await t.collection(TASKS).doc(taskId).set({ data: { ...taskDoc } })
      await t.collection(OPS).doc(opKey).set({
        data: { ...opDoc, entity: { collection: TASKS, docId: taskId }, createdAt: now }
      })
      await t.commit()
      return ok({ task: taskView({ ...taskDoc, _id: taskId }) })
    } catch (err) {
      try { await t.rollback() } catch (e) { /* 已回滚 */ }
      return fail('transaction-failed', '事务未提交成功，可安全重试', {
        errMsg: String((err && (err.errMsg || err.message)) || err).slice(0, 200)
      })
    }
  }

  if (action === 'task.list') {
    const limitRaw = Number(event.limit || PAGE_DEFAULT)
    const limit = Math.min(Math.max(Number.isInteger(limitRaw) ? limitRaw : PAGE_DEFAULT, 1), PAGE_MAX)
    const cursor = (typeof event.cursor === 'string' && event.cursor) || null
    if (event.status !== undefined && event.status !== null && !TASK_STATUS.includes(event.status)) {
      return fail('invalid-params', `status 须 ${TASK_STATUS.join('/')}`)
    }
    if (event.assigneeId !== undefined && event.assigneeId !== null && !config.members.some(m => m.memberId === event.assigneeId)) {
      return fail('invalid-params', 'assigneeId 须为本家庭成员或 null')
    }
    const cmd = db.command
    const where = { familyId: fid }
    if (event.status) where.status = event.status
    if (event.assigneeId) where.assigneeId = event.assigneeId
    if (cursor) where.sortKey = cmd.lt(cursor)
    const res = await db.collection(TASKS).where(where).orderBy('sortKey', 'desc').limit(limit).get()
    const rows = (res && res.data) || []
    const tasks = await projectTaskRows(db, config, rows)
    const last = rows[rows.length - 1]
    const nextCursor = rows.length === limit && last ? last.sortKey : null
    return ok({ tasks, nextCursor, hasMore: Boolean(nextCursor) })
  }

  return fail('invalid-action', `未知 action: ${String(action)}`)
}
