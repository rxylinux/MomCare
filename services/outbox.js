// B2a 持久 outbox：成员隔离的待同步操作队列。
// 规则（spec + B2a review 复现 2-4 修复）：
// - 发网络前落盘完整请求快照（opId/entityId/expectedRevision/payload/extra）；
//   落盘失败不发请求、不提示已保存
// - 曾发送（everSent）条目超时回 pending 后：内容/opId 不可改写、不可被合并——
//   超时可能已在云端提交；同实体新编辑追加为新条目排其后
// - 队列读取异常/JSON 损坏 ≠ 空队列：返回不可用标记，禁止一切修改与网络发送，
//   磁盘原件保留并向上报错
// - 身份确认在途（confirming）时：统一拒绝读写（与缓存同一权威条件）
// - 确认成功后移除待办；移除落盘失败保留条目（服务端幂等重放安全，重启不丢）

import { ref } from 'vue'
import { CLOUD_CONFIG } from '@/utils/cloudConfig.js'
import { getSessionState } from '@/services/sessionService.js'

// 响应式版本号：任何成功持久化的队列变更都推进，供 store/页面 computed 依赖
const outboxVersion = ref(0)

export function subscribeOutbox() {
  return outboxVersion
}

function outboxKeyForMember(memberId) {
  return `mc_outbox_${CLOUD_CONFIG.envId}_${CLOUD_CONFIG.appId}_${memberId}_b2a`
}

// 返回 { ok, entries } 或 { ok:false, reason:'read-failed'|'corrupted' }（磁盘原件保留）
function loadForMember(memberId) {
  let raw
  try {
    raw = uni.getStorageSync(outboxKeyForMember(memberId))
  } catch (e) {
    return { ok: false, reason: 'read-failed' }
  }
  if (!raw) return { ok: true, entries: [] }
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return { ok: false, reason: 'corrupted' }
    return { ok: true, entries: parsed }
  } catch (e) {
    return { ok: false, reason: 'corrupted' }
  }
}

function persistForMember(memberId, entries) {
  try {
    uni.setStorageSync(outboxKeyForMember(memberId), JSON.stringify(entries))
    outboxVersion.value += 1
    return true
  } catch (e) {
    return false
  }
}

// 权威可访问条件：已确认成员且不在确认在途窗口（与成员缓存同一条件）
function currentMemberId() {
  const s = getSessionState()
  if (s.status === 'confirmed' && s.member && !s.confirming) return s.member.memberId
  return null
}

// 入队（或合并到同实体【从未发送】的 pending 条目）。
// everSent 条目绝不合并/改写（超时可能在云端已提交，原 ID+原内容保留）。
export function enqueueOutbox({ kind, entityId, opId, expectedRevision, payload, extra, immutable }) {
  const memberId = currentMemberId()
  if (!memberId) return { ok: false, reason: 'unconfirmed' }
  const loaded = loadForMember(memberId)
  if (!loaded.ok) return { ok: false, reason: 'outbox-' + loaded.reason }
  const entries = loaded.entries
  // 不可变意图（迁移固定 opId）：既不合并进已有条目，也不被已有条目吸收
  // ——保持普通未发送草稿完整，同 opId 幂等在调用层（familyStore.submit）处理
  const mergeTarget = immutable ? undefined : entries.find(e =>
    e.entityId === entityId && e.kind === kind &&
    e.status === 'pending' && e.everSent !== true && !e.immutable)
  let entry
  if (mergeTarget) {
    mergeTarget.payload = payload
    mergeTarget.opId = opId
    mergeTarget.expectedRevision = expectedRevision
    mergeTarget.extra = extra || {}
    mergeTarget.queuedAt = Date.now()
    mergeTarget.conflict = false
    entry = mergeTarget
  } else {
    entry = {
      id: 'ob_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      kind, entityId, opId, expectedRevision, payload,
      extra: extra || {},
      immutable: Boolean(immutable),
      status: 'pending', everSent: false, conflict: false,
      attempts: 0, queuedAt: Date.now()
    }
    entries.push(entry)
  }
  if (!persistForMember(memberId, entries)) {
    return { ok: false, reason: 'persist-failed' }
  }
  return { ok: true, entry }
}

export function getOutbox() {
  const memberId = currentMemberId()
  if (!memberId) return []
  const loaded = loadForMember(memberId)
  return loaded.ok ? loaded.entries : []
}

// 读取健康检查：区分空队列与不可读队列（不可读时禁止依赖旧队列的修改/发送）
export function outboxReadable() {
  const memberId = currentMemberId()
  if (!memberId) return { ok: false, reason: 'unconfirmed' }
  return loadForMember(memberId).ok
    ? { ok: true }
    : { ok: false, reason: 'unreadable' }
}

export function findOutboxEntry(id) {
  return getOutbox().find(e => e.id === id) || null
}

function mutateEntry(id, mutator) {
  const memberId = currentMemberId()
  if (!memberId) return false
  const loaded = loadForMember(memberId)
  if (!loaded.ok) return false
  const entries = loaded.entries
  const entry = entries.find(e => e.id === id)
  if (!entry) return false
  mutator(entry)
  return persistForMember(memberId, entries)
}

export function markSent(id) {
  return mutateEntry(id, e => { e.status = 'sent'; e.everSent = true; e.sentAt = Date.now() })
}
export function markPendingAgain(id, errorMessage) {
  // 超时/失败回 pending：everSent 保持 true——后续编辑不得合并本条（云端提交状态不确定）
  return mutateEntry(id, e => {
    e.status = 'pending'
    e.everSent = true
    e.attempts += 1
    e.lastError = String(errorMessage || '').slice(0, 200)
  })
}
export function markConflict(id, currentRevision, currentRecord) {
  return mutateEntry(id, e => {
    e.status = 'pending'
    e.everSent = true
    e.conflict = true
    e.currentRevision = currentRevision
    e.currentRecord = currentRecord
    e.attempts += 1
  })
}
export function removeEntry(id) {
  const memberId = currentMemberId()
  if (!memberId) return false
  const loaded = loadForMember(memberId)
  if (!loaded.ok) return false
  return persistForMember(memberId, loaded.entries.filter(e => e.id !== id))
}

// 冲突解决：确认重提 = 最新 revision + 新 opId（全新操作，服务端幂等键已换）
export function resolveConflictResubmit(id, newOpId, latestRevision) {
  return mutateEntry(id, e => {
    e.opId = newOpId
    e.expectedRevision = latestRevision
    e.conflict = false
    e.currentRevision = undefined
    e.currentRecord = undefined
    e.status = 'pending'
    e.everSent = false
    e.attempts = 0
  })
}
export function resolveConflictDrop(id) {
  return removeEntry(id)
}
