// Phase C Stage 2 家庭协同 store（Pinia）：分享需要 SharedNeeds + 共同任务 FamilyTasks。
// 读写全部经 sessionService.familyCall → mc-collab；持久 outbox 承载离线待办。
//
// 铁律（评审 §本地与失败语义）：
// - 撤回单调墓碑：withdrawNeed 本地立即抹正文（content=null）+关联任务取消脱敏——
//   之后任何路径（拉取合并/快照恢复/重放）不得恢复原文；全部分页成功才替换本地集
//   （分页不完整不据"列表缺失"推断撤回）。
// - 视角偏好 homeView 仅为渲染偏好：不改身份、不扩权限、不影响 mood 私人隔离。
// - 身份切换隔离：outbox/快照按成员命名空间（outbox.js/getMemberCache 既有机制），
//   上一身份未提交队列对新身份不可见；epoch 守卫丢弃迟到响应。
// - 离线：先落盘后发网络（outbox 语义）；失败保留原 opId 重试；不显示"已保存"。

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { familyCall, currentEpoch, getSessionState, subscribeSession, getMemberCache, setMemberCache } from '@/services/sessionService.js'
import {
  enqueueOutbox, getOutbox, markSent, markPendingAgain, markConflict,
  removeEntry, findOutboxEntry, outboxReadable, subscribeOutbox
} from '@/services/outbox.js'

const SNAPSHOT_KEY = 'collab-snapshot'
const HOME_VIEW_KEY = 'momcare_home_view'
const MASKED_TITLE = '（分享已撤回）'
const COLLAB_FN = 'mc-collab'

function newOpId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

// Asia/Shanghai 日号（与 familyStore.todayKeyOf 同公式）
function todayKeyOf(date) {
  const sh = new Date(date.getTime() + (8 * 60 + date.getTimezoneOffset()) * 60000)
  return `${sh.getFullYear()}-${String(sh.getMonth() + 1).padStart(2, '0')}-${String(sh.getDate()).padStart(2, '0')}`
}

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) === undefined ? 'undefined' : JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}'
}

export const useCollabStore = defineStore('collab', () => {
  const homeView = ref('mom')            // 'mom' | 'dad'——仅渲染偏好（权限不变性铁律）
  const needs = ref({})                  // needId → viewNeed（withdrawn 项 content 恒 null）
  const tasks = ref({})                  // taskId → viewTask（need 来源标题动态投影）
  const lastSyncAt = ref(null)
  const syncing = ref(false)

  const outboxVersion = subscribeOutbox()
  const sessionVersion = subscribeSession()
  const pendingCount = computed(() => {
    void outboxVersion.value
    void sessionVersion.value
    return getOutbox().filter(e => !e.conflict && String(e.kind || '').startsWith('collab')).length
  })

  function sessionReady() {
    const s = getSessionState()
    return s.status === 'confirmed' && s.member
  }

  const currentMemberId = computed(() => {
    const s = getSessionState()
    return (s.status === 'confirmed' && s.member) ? s.member.memberId : null
  })

  // ── 视角偏好：持久化 Storage；默认按本人已绑定身份（mama→mom / papa→dad）──
  function initHomeView() {
    let saved = ''
    try { saved = uni.getStorageSync(HOME_VIEW_KEY) } catch (e) { /* 读取失败按默认 */ }
    if (saved === 'mom' || saved === 'dad') {
      homeView.value = saved
      return homeView.value
    }
    const s = getSessionState()
    const mid = s.member && s.member.memberId
    homeView.value = mid === 'papa' ? 'dad' : 'mom'
    return homeView.value
  }

  function switchHomeView(view) {
    if (view !== 'mom' && view !== 'dad') return false
    homeView.value = view
    try {
      uni.setStorageSync(HOME_VIEW_KEY, view)
      return true
    } catch (e) {
      return false // 持久化失败：本会话内仍生效，如实返回
    }
  }

  // ── 快照（成员命名空间缓存；家庭作用域键——与 familyStore 同款双检）──
  function snapshotKeyFor(familyId) {
    return `${SNAPSHOT_KEY}@fam:${familyId}`
  }
  function restoreFromCache() {
    if (!sessionReady()) return false
    const fam = getSessionState().member.familyId
    const snap = getMemberCache(snapshotKeyFor(fam))
    if (!snap) return false
    if (snap.familyId !== undefined && snap.familyId !== fam) return false
    const enforced = enforceTombstones(snap.needs || {}, snap.tasks || {})
    needs.value = enforced.needs
    tasks.value = enforced.tasks
    lastSyncAt.value = snap.lastSyncAt || null
    return true
  }
  function persistSnapshot(epochAtStart) {
    if (!sessionReady()) return false
    if (epochAtStart !== undefined && epochAtStart !== currentEpoch()) return false
    const fam = getSessionState().member.familyId
    return setMemberCache(snapshotKeyFor(fam), {
      familyId: fam,
      needs: needs.value,
      tasks: tasks.value,
      lastSyncAt: lastSyncAt.value
    }, epochAtStart)
  }

  // 撤回铁律投影：任何进入本地状态的 need 集合先过墓碑强制（withdrawn ⇒ content=null），
  // 关联 need 任务标题一律脱敏——磁盘快照/拉取数据/服务端响应统一走此门
  function enforceTombstones(needMap, taskMap) {
    const needsOut = {}
    for (const [id, n] of Object.entries(needMap || {})) {
      needsOut[id] = (n && n.status === 'withdrawn') ? { ...n, content: null } : n
    }
    const tasksOut = {}
    for (const [id, t] of Object.entries(taskMap || {})) {
      if (t && t.sourceType === 'need') {
        const n = needsOut[t.sourceId]
        const withdrawn = !n || n.status === 'withdrawn'
        if (withdrawn) {
          // 服务端撤回同事务取消派生任务——本地投影一致强制 cancelled+脱敏
          tasksOut[id] = { ...t, status: 'cancelled', title: MASKED_TITLE, needStatus: 'withdrawn' }
          continue
        }
        tasksOut[id] = { ...t, needStatus: n.status }
        continue
      }
      tasksOut[id] = t
    }
    return { needs: needsOut, tasks: tasksOut }
  }

  // 确定性任务 ID（与服务端同式：tsk_<familyId>_<sourceType>_<sourceId>）
  function taskIdOf(sourceType, sourceId) {
    const fam = sessionReady() ? getSessionState().member.familyId : ''
    return `tsk_${fam}_${sourceType}_${sourceId}`
  }
  function taskForNeed(needId) {
    return tasks.value[taskIdOf('need', needId)] || null
  }

  // ── 拉取：两域全部分页成功才整体替换（任一页失败保留旧集与待办）──
  async function pullCollab() {
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session' }
    if (syncing.value) return { ok: false, code: 'busy' }
    syncing.value = true
    const epochAtStart = currentEpoch()
    try {
      const newNeeds = {}
      let cursor = null
      let pages = 0
      do {
        const res = await familyCall(COLLAB_FN, { action: 'need.list', cursor, limit: 100 })
        if (!res.ok) throw new Error(res.message || res.code)
        for (const n of (res.data.needs || [])) newNeeds[n.needId] = n
        cursor = res.data.nextCursor
        pages++
        if (pages > 50) throw new Error('分页异常：超过 50 页')
      } while (cursor)
      const newTasks = {}
      cursor = null
      pages = 0
      do {
        const res = await familyCall(COLLAB_FN, { action: 'task.list', cursor, limit: 100 })
        if (!res.ok) throw new Error(res.message || res.code)
        for (const t of (res.data.tasks || [])) newTasks[t.taskId] = t
        cursor = res.data.nextCursor
        pages++
        if (pages > 50) throw new Error('分页异常：超过 50 页')
      } while (cursor)
      if (currentEpoch() !== epochAtStart) return { ok: false, code: 'stale-session' }
      const enforced = enforceTombstones(newNeeds, newTasks)
      needs.value = enforced.needs
      tasks.value = enforced.tasks
      lastSyncAt.value = Date.now()
      persistSnapshot(epochAtStart)
      return { ok: true }
    } catch (e) {
      return { ok: false, code: 'sync-failed', message: `同步失败：${e.message || e}` }
    } finally {
      syncing.value = false
    }
  }

  // ── 服务端视图落地（含重放：mc-collab 响应即当前权威态）──
  function applyServerNeed(view) {
    if (!view || !view.needId) return
    const cur = needs.value[view.needId]
    if (cur && (cur.revision || 0) > (view.revision || 0)) return // 旧响应不回退本地更高版本
    const enforced = enforceTombstones({ ...needs.value, [view.needId]: view }, tasks.value)
    needs.value = enforced.needs
    tasks.value = enforced.tasks
    persistSnapshot()
  }
  function applyServerTask(view) {
    if (!view || !view.taskId) return
    const cur = tasks.value[view.taskId]
    if (cur && (cur.revision || 0) > (view.revision || 0)) return
    const enforced = enforceTombstones(needs.value, { ...tasks.value, [view.taskId]: view })
    needs.value = enforced.needs
    tasks.value = enforced.tasks
    persistSnapshot()
  }

  // ── 提交内核（outbox：先落盘后发网络）──
  async function submit({ kind, entityId, payload, extra, expectedRevision }) {
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session' }
    // 未变更重试：同实体同内容待办直接重发（幂等）
    const same = getOutbox().find(e => e.entityId === entityId && e.kind === kind && !e.conflict &&
      stableStringify(e.payload) === stableStringify(payload))
    if (same) return flushEntry(same.id)
    const opId = newOpId(kind.replace(/[^a-z]/g, '').slice(0, 10))
    const enq = enqueueOutbox({
      kind, entityId, opId,
      expectedRevision: expectedRevision === undefined ? 0 : expectedRevision,
      payload, extra: extra || {}
    })
    if (!enq.ok) {
      return { ok: false, code: 'outbox-persist-failed', message: '本机待同步队列写入失败，内容未保存，请释放空间后重试' }
    }
    return flushEntry(enq.entry.id)
  }

  async function flushEntry(id) {
    const health = outboxReadable()
    if (!health.ok) return { ok: false, code: 'outbox-unreadable', message: '待同步队列不可读，已停止发送（磁盘原件保留）' }
    const entry = findOutboxEntry(id)
    if (!entry) return { ok: false, code: 'entry-gone' }
    const epochAtStart = currentEpoch()
    if (!markSent(id)) {
      return { ok: false, code: 'outbox-state-persist-failed', message: '待同步状态无法持久化，已停止发送（内容已保留，请重试）' }
    }
    const p = entry.payload || {}
    const x = entry.extra || {}
    let callData = { operationId: entry.opId }
    if (entry.kind === 'collab-need-create') {
      callData.action = 'need.create'
      callData.content = p.content
      if (p.targetDate !== undefined && p.targetDate !== null) callData.targetDate = p.targetDate
    } else if (entry.kind === 'collab-need-update') {
      callData.action = 'need.update'
      callData.needId = entry.entityId
      callData.expectedRevision = entry.expectedRevision
      if (p.content !== undefined) callData.content = p.content
      if (p.targetDate !== undefined) callData.targetDate = p.targetDate
    } else if (entry.kind === 'collab-need-withdraw') {
      callData.action = 'need.withdraw'
      callData.needId = entry.entityId
      callData.expectedRevision = entry.expectedRevision
    } else if (entry.kind === 'collab-need-close') {
      callData.action = 'need.close'
      callData.needId = entry.entityId
      callData.expectedRevision = entry.expectedRevision
    } else if (entry.kind === 'collab-task-accept') {
      callData.action = 'task.accept'
      callData.sourceType = p.sourceType
      callData.sourceId = p.sourceId
    } else if (entry.kind === 'collab-task-status') {
      callData.action = 'task.updateStatus'
      callData.taskId = entry.entityId
      callData.status = p.status
      callData.expectedRevision = entry.expectedRevision
    } else if (entry.kind === 'collab-task-custom') {
      callData.action = 'task.createCustom'
      callData.title = p.title
      if (p.targetDate !== undefined && p.targetDate !== null) callData.targetDate = p.targetDate
      if (p.assigneeId !== undefined && p.assigneeId !== null) callData.assigneeId = p.assigneeId
    } else {
      return { ok: false, code: 'unknown-collab-kind' }
    }
    void x
    const res = await familyCall(COLLAB_FN, callData)
    if (currentEpoch() !== epochAtStart) {
      return { ok: false, code: 'stale-session' } // 身份已切换：待办留在原成员名下
    }
    if (res.ok) {
      if (res.data && res.data.need) applyServerNeed(res.data.need)
      if (res.data && res.data.task) applyServerTask(res.data.task)
      if (!removeEntry(id)) { /* 移除落盘失败：保留条目，下次幂等重放后移除 */ }
      return { ok: true, replayed: Boolean(res.data && res.data.replayed), view: (res.data && (res.data.need || res.data.task)) || null }
    }
    if (res.code === 'revision-conflict') {
      markConflict(id, res.currentRevision, null)
      return { ok: false, code: 'revision-conflict', currentRevision: res.currentRevision, entryId: id }
    }
    if (res.locked) {
      return { ok: false, code: res.code, locked: true } // 身份拒绝：会话已锁定，待办保留
    }
    markPendingAgain(id, res.message || res.code)
    return { ok: false, code: res.code, message: res.message, entryId: id }
  }

  async function flushAll() {
    const results = []
    for (const e of getOutbox()) {
      if (!String(e.kind || '').startsWith('collab')) continue
      if (e.conflict) continue
      results.push(await flushEntry(e.id))
    }
    return results
  }

  // ── 业务方法 ──
  async function saveNeed({ content, targetDate }) {
    const r = await submit({
      kind: 'collab-need-create',
      entityId: 'need-create-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6), // 每次创建独立实体——不合并
      payload: { content, ...(targetDate ? { targetDate } : {}) }
    })
    return r
  }

  // 撤回：本地立即墓碑（正文抹除+任务联动）——隐私优先；网络/落盘失败不回滚本地抹除
  async function withdrawNeed(needId, expectedRevision) {
    const local = needs.value[needId]
    const rev = expectedRevision !== undefined ? expectedRevision : (local ? local.revision : 0)
    // 本地立即抹除（即使后续网络失败——撤回意图不可逆）
    const enforced = enforceTombstones(
      { ...needs.value, [needId]: { ...(local || { needId }), status: 'withdrawn', content: null, revision: rev + 1 } },
      tasks.value
    )
    needs.value = enforced.needs
    tasks.value = enforced.tasks
    const r = await submit({
      kind: 'collab-need-withdraw',
      entityId: needId,
      expectedRevision: rev,
      payload: {}
    })
    persistSnapshot()
    return r
  }

  async function closeNeed(needId, expectedRevision) {
    const local = needs.value[needId]
    const rev = expectedRevision !== undefined ? expectedRevision : (local ? local.revision : 0)
    return submit({
      kind: 'collab-need-close',
      entityId: needId,
      expectedRevision: rev,
      payload: {}
    })
  }

  async function acceptTask(sourceType, sourceId) {
    return submit({
      kind: 'collab-task-accept',
      entityId: taskIdOf(sourceType, sourceId), // 确定性任务 ID=实体键（同源去重）
      payload: { sourceType, sourceId }
    })
  }

  async function updateTaskStatus(taskId, status, expectedRevision) {
    const local = tasks.value[taskId]
    const rev = expectedRevision !== undefined ? expectedRevision : (local ? local.revision : 0)
    return submit({
      kind: 'collab-task-status',
      entityId: taskId,
      expectedRevision: rev,
      payload: { status }
    })
  }

  async function createCustomTask({ title, targetDate, assigneeId }) {
    return submit({
      kind: 'collab-task-custom',
      entityId: 'task-custom-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      payload: { title, ...(targetDate ? { targetDate } : {}), ...(assigneeId ? { assigneeId } : {}) }
    })
  }

  // ── 计算属性 ──
  function latestActiveOf(ownerFilter) {
    const list = Object.values(needs.value).filter(n => n && n.status === 'active' && ownerFilter(n))
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    return list[0] || null
  }
  const myActiveShare = computed(() => {
    void sessionVersion.value
    const me = currentMemberId.value
    return me ? latestActiveOf(n => n.ownerId === me) : null
  })
  const partnerActiveShare = computed(() => {
    void sessionVersion.value
    const me = currentMemberId.value
    return me ? latestActiveOf(n => n.ownerId !== me) : null
  })
  const activeNeedsList = computed(() => {
    const list = Object.values(needs.value).filter(n => n && n.status === 'active')
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    return list
  })
  // 爸爸视角首屏：负责/未分配的进行中任务，今天到期优先，前 3 项
  const dadTopTasks = computed(() => {
    void sessionVersion.value
    const today = todayKeyOf(new Date())
    const list = Object.values(tasks.value).filter(t => t && (t.status === 'pending' || t.status === 'doing') &&
      (t.assigneeId === 'papa' || t.acceptedBy === 'papa' || !t.assigneeId))
    list.sort((a, b) => {
      const ka = a.targetDate === today ? 0 : (a.targetDate ? 1 : 2)
      const kb = b.targetDate === today ? 0 : (b.targetDate ? 1 : 2)
      if (ka !== kb) return ka - kb
      if (a.targetDate && b.targetDate && a.targetDate !== b.targetDate) return a.targetDate < b.targetDate ? -1 : 1
      return (b.createdAt || 0) - (a.createdAt || 0)
    })
    return list.slice(0, 3)
  })
  const myTasks = computed(() => {
    void sessionVersion.value
    const me = currentMemberId.value
    if (!me) return []
    const list = Object.values(tasks.value).filter(t => t && (t.assigneeId === me || t.acceptedBy === me))
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    return list
  })

  return {
    homeView, needs, tasks, lastSyncAt, syncing, pendingCount,
    currentMemberId, myActiveShare, partnerActiveShare, activeNeedsList, dadTopTasks, myTasks,
    initHomeView, switchHomeView, restoreFromCache, persistSnapshot, pullCollab,
    saveNeed, withdrawNeed, closeNeed, acceptTask, updateTaskStatus, createCustomTask,
    flushAll, flushEntry, taskIdOf, taskForNeed
  }
})
