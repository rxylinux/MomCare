// B2a 家庭数据权威源（Pinia store）：孕期档案 / 共享健康数字 / 私人心情备注。
// 全部读写经 sessionService.familyCall → mc-health 云函数；持久 outbox 承载离线待办。
// 冷启动未确认身份前不加载任何成员快照；快照按成员缓存（getMemberCache），
// 仅在全部分页成功后推进"完整同步时间"。

import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { familyCall, currentEpoch, getMemberCache, setMemberCache, getSessionState, subscribeSession } from '@/services/sessionService.js'
import {
  enqueueOutbox, getOutbox, markSent, markPendingAgain, markConflict,
  removeEntry, resolveConflictResubmit, resolveConflictDrop, findOutboxEntry,
  outboxReadable, subscribeOutbox
} from '@/services/outbox.js'

const SCHEMA_VERSION = 1
const SNAPSHOT_KEY = 'b2a-snapshot'

function newOpId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

// Asia/Shanghai 日号（CLOUDBASE_PLAN 4.2.7：日期按家庭时区处理）
function todayKeyOf(date) {
  const sh = new Date(date.getTime() + (8 * 60 + date.getTimezoneOffset()) * 60000)
  const y = sh.getFullYear()
  const m = String(sh.getMonth() + 1).padStart(2, '0')
  const d = String(sh.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// 快照内存合并：按 revision，高版本胜；墓碑(deleted)以更高 revision 生效
function mergeRecord(local, incoming) {
  if (!incoming) return local
  if (!local || (incoming.revision || 0) > (local.revision || 0)) return incoming
  return local
}

export const useFamilyStore = defineStore('familyData', () => {
  const pregnancy = ref(null)            // viewPregnancy 或 null
  const daily = ref({})                  // dateKey → viewDaily（含 deleted 墓碑）
  const moods = ref({})                  // dateKey → viewMood（本人）
  const lastFullSyncAt = ref(null)
  const syncing = ref(false)
  const lastError = ref('')
  const flushRunning = ref(false)

  // 依赖响应式版本号：outbox 变化 + 【会话身份变化】都使派生视图即时失效
  // （复现18：成员切换后 getOutbox 已空但 computed 缓存仍含上一人私人 payload；
  //  确认在途/退出时也必须返回空，不泄露不可访问的队列内容）
  const outboxVersion = subscribeOutbox()
  const sessionVersionForOutbox = subscribeSession()
  const pendingCount = computed(() => {
    void outboxVersion.value
    void sessionVersionForOutbox.value
    return getOutbox().filter(e => !e.conflict).length
  })
  const conflictEntries = computed(() => {
    void outboxVersion.value
    void sessionVersionForOutbox.value
    return getOutbox().filter(e => e.conflict)
  })

  function sessionReady() {
    const s = getSessionState()
    return s.status === 'confirmed' && s.member
  }

  // 冷启动：身份确认后调用；恢复成员缓存快照，随后按需拉取
  function restoreFromCache() {
    if (!sessionReady()) return false
    const snap = getMemberCache(SNAPSHOT_KEY)
    if (!snap) return false
    pregnancy.value = snap.pregnancy || null
    daily.value = snap.daily || {}
    moods.value = snap.moods || {}
    lastFullSyncAt.value = snap.lastFullSyncAt || null
    return true
  }

  function persistSnapshot(epochAtStart) {
    if (!sessionReady()) return
    if (epochAtStart !== undefined && epochAtStart !== currentEpoch()) return
    setMemberCache(SNAPSHOT_KEY, {
      pregnancy: pregnancy.value,
      daily: daily.value,
      moods: moods.value,
      lastFullSyncAt: lastFullSyncAt.value
    }, epochAtStart)
  }

  // 分页拉取：全部页成功才推进完整同步时间；任一页失败保留旧快照与待办
  async function pullAll() {
    if (!sessionReady() || syncing.value) return { ok: false, reason: 'busy' }
    syncing.value = true
    lastError.value = ''
    const epochAtStart = currentEpoch()
    try {
      const newDaily = {}
      const newMoods = {}
      // 孕期档案
      const preg = await familyCall('mc-health', { action: 'pregnancy.get', schemaVersion: SCHEMA_VERSION, operationId: 'ro-get' })
      if (!preg.ok) throw new Error(preg.message || preg.code)
      // daily 分页
      let cursor = null
      let pages = 0
      do {
        const res = await familyCall('mc-health', { action: 'daily.list', schemaVersion: SCHEMA_VERSION, operationId: 'ro-list', cursor, limit: 100 })
        if (!res.ok) throw new Error(res.message || res.code)
        for (const rec of res.data.records) newDaily[rec.dateKey] = rec
        cursor = res.data.nextCursor
        pages++
        if (pages > 50) throw new Error('分页异常：超过 50 页')
      } while (cursor)
      // mood 分页
      cursor = null
      pages = 0
      do {
        const res = await familyCall('mc-health', { action: 'mood.list', schemaVersion: SCHEMA_VERSION, operationId: 'ro-list', cursor, limit: 100 })
        if (!res.ok) throw new Error(res.message || res.code)
        for (const rec of res.data.records) newMoods[rec.dateKey] = rec
        cursor = res.data.nextCursor
        pages++
        if (pages > 50) throw new Error('分页异常：超过 50 页')
      } while (cursor)

      if (currentEpoch() !== epochAtStart) return { ok: false, reason: 'stale' }
      // 与本地待办冲突中的实体：待办存在时不让旧拉取覆盖本地输入视图基线，
      // 直接按 revision 合并（待办 flush 时仍以服务端 revision 校验）
      const mergedDaily = { ...daily.value }
      for (const [k, v] of Object.entries(newDaily)) mergedDaily[k] = mergeRecord(mergedDaily[k], v)
      const mergedMoods = { ...moods.value }
      for (const [k, v] of Object.entries(newMoods)) mergedMoods[k] = mergeRecord(mergedMoods[k], v)
      daily.value = mergedDaily
      moods.value = mergedMoods
      pregnancy.value = preg.data.record || null
      lastFullSyncAt.value = Date.now()
      persistSnapshot(epochAtStart)
      return { ok: true }
    } catch (e) {
      lastError.value = `同步失败：${e.message || e}`
      return { ok: false, reason: 'error', message: lastError.value }
    } finally {
      syncing.value = false
    }
  }

  // 单条拉取（冲突解决后刷新本地视图）
  async function refreshDaily(dateKey) {
    if (!sessionReady()) return
    const res = await familyCall('mc-health', { action: 'daily.get', schemaVersion: SCHEMA_VERSION, operationId: 'ro-get', dateKey })
    if (res.ok && res.data.record) {
      daily.value = { ...daily.value, [dateKey]: mergeRecord(daily.value[dateKey], res.data.record) }
      persistSnapshot()
    }
  }
  async function refreshMood(dateKey) {
    if (!sessionReady()) return
    const res = await familyCall('mc-health', { action: 'mood.get', schemaVersion: SCHEMA_VERSION, operationId: 'ro-get', dateKey })
    if (res.ok && res.data.record) {
      moods.value = { ...moods.value, [dateKey]: mergeRecord(moods.value[dateKey], res.data.record) }
      persistSnapshot()
    }
  }

  // ── 通用提交：outbox 落盘 → 发送 → 幂等收尾 ──
  async function submit({ kind, entityId, payload, dateKey, localRecordGetter, baselineRevision }) {
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session' }
    const local = localRecordGetter ? localRecordGetter() : null
    // baselineRevision：调用方（如表单）捕获的编辑开始版本——优先于当前快照版本，
    // 防止后台刷新后用最新 revision 静默覆盖他人修改
    const expectedRevision = (baselineRevision !== undefined && baselineRevision !== null)
      ? baselineRevision
      : (local ? local.revision : 0)
    const opId = newOpId(kind.replace(/[^a-z]/g, '').slice(0, 6))
    // outbox 只存可序列化字段（云调用参数 + 展示）；落盘失败不发请求不报成功
    const enq = enqueueOutbox({
      kind, entityId, opId, expectedRevision, payload,
      extra: { dateKey: dateKey || null }
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
      // 发送前无法持久化"可能已发送"（everSent=true）的不可变状态：
      // 若继续发送而后台合并该条目，未确认请求会被改写丢失——必须停止网络，
      // 保留磁盘原件，如实报告；恢复后以原 ID/内容重放
      return { ok: false, code: 'outbox-state-persist-failed', message: '待同步状态无法持久化，已停止发送（内容已保留，请重试）' }
    }
    const res = await familyCall('mc-health', {
      action: entry.kind === 'daily-delete' ? 'daily.delete' : `${entry.kind}.upsert`,
      schemaVersion: SCHEMA_VERSION,
      operationId: entry.opId,
      expectedRevision: entry.expectedRevision,
      payload: entry.payload,
      dateKey: entry.extra && entry.extra.dateKey ? entry.extra.dateKey : undefined
    })
    if (currentEpoch() !== epochAtStart) {
      return { ok: false, code: 'stale-session' } // 身份已切换：待办留在原成员名下
    }
    if (res.ok) {
      // 重放时附带 currentRecord（服务端当前权威文档）：以它为准落地，
      // 避免旧快照在服务端已删除/推进后复活 UI；首次成功 currentRecord 为空
      const authoritative = (res.data.replayed && res.data.currentRecord) ? res.data.currentRecord : res.data.record
      applyServerRecord(entry.kind, authoritative)
      if (!removeEntry(id)) {
        // 移除落盘失败：保留条目；下次 flush 幂等重放后移除（服务端不重复写）
      }
      persistSnapshot(epochAtStart)
      return { ok: true, record: authoritative, replayed: res.data.replayed }
    }
    if (res.code === 'revision-conflict') {
      markConflict(id, res.currentRevision, res.currentRecord)
      return { ok: false, code: 'revision-conflict', currentRevision: res.currentRevision, currentRecord: res.currentRecord, entryId: id }
    }
    if (res.locked) {
      return { ok: false, code: res.code, locked: true } // 身份拒绝：会话已锁定，待办保留
    }
    markPendingAgain(id, res.message || res.code)
    return { ok: false, code: res.code, message: res.message, entryId: id }
  }

  // 权威结果落地：按 revision 合并——墓碑(deleted)与更高版本胜，
  // 低版本响应/重放旧快照不得覆盖本地更高版本或复活已删除记录
  function applyServerRecord(kind, record) {
    if (!record) return
    if (kind === 'pregnancy') {
      pregnancy.value = mergeRecord(pregnancy.value, record)
    } else if (kind === 'daily' || kind === 'daily-delete') {
      daily.value = { ...daily.value, [record.dateKey]: mergeRecord(daily.value[record.dateKey], record) }
    } else if (kind === 'mood') {
      moods.value = { ...moods.value, [record.dateKey]: mergeRecord(moods.value[record.dateKey], record) }
    }
  }

  // 冲突解决：采用云端（丢弃待办并刷新）/ 确认重提（最新 revision + 新 opId）
  // 冲突采用云端：必须先【成功取得并落地】可验证的云端版本，再清除待办。
  // 任一领域读失败 → 保留待办与本地输入、返回 false（页面不得报成功）。
  async function adoptCloud(entryId) {
    const entry = findOutboxEntry(entryId)
    if (!entry) return false
    const dateKey = entry.extra && entry.extra.dateKey

    const applyCloudDaily = async () => {
      const res = await familyCall('mc-health', { action: 'daily.get', schemaVersion: SCHEMA_VERSION, dateKey })
      if (!res.ok || !res.data.record) return false
      daily.value = { ...daily.value, [dateKey]: mergeRecord(daily.value[dateKey], res.data.record) }
      return true
    }
    const applyCloudMood = async () => {
      const res = await familyCall('mc-health', { action: 'mood.get', schemaVersion: SCHEMA_VERSION, dateKey })
      if (!res.ok || !res.data.record) return false
      moods.value = { ...moods.value, [dateKey]: mergeRecord(moods.value[dateKey], res.data.record) }
      return true
    }
    const applyCloudPregnancy = async () => {
      const res = await familyCall('mc-health', { action: 'pregnancy.get', schemaVersion: SCHEMA_VERSION })
      if (!res.ok || !res.data.record) return false
      pregnancy.value = mergeRecord(pregnancy.value, res.data.record)
      return true
    }

    let applied = false
    if (entry.kind === 'daily' && dateKey) applied = await applyCloudDaily()
    else if (entry.kind === 'mood' && dateKey) applied = await applyCloudMood()
    else if (entry.kind === 'pregnancy') applied = await applyCloudPregnancy()

    if (!applied) {
      // 读失败（含断网）：保留待办与输入，不报成功
      return false
    }
    persistSnapshot()
    return resolveConflictDrop(entryId)
  }
  function resubmit(entryId) {
    const entry = findOutboxEntry(entryId)
    if (!entry) return { ok: false }
    const latest = entry.currentRevision != null ? entry.currentRevision : entry.expectedRevision
    resolveConflictResubmit(entryId, newOpId('resub'), latest)
    return flushEntry(entryId)
  }

  // 冲突/失败条目的统一重发（网络恢复或手动"重试全部"）
  async function flushAll() {
    if (flushRunning.value || !sessionReady()) return { ok: false, reason: 'busy' }
    const health = outboxReadable()
    if (!health.ok) return { ok: false, reason: health.reason, message: '待同步队列不可读，已停止发送（磁盘原件保留）' }
    flushRunning.value = true
    const results = []
    try {
      const epochAtStart = currentEpoch()
      for (const entry of getOutbox()) {
        if (currentEpoch() !== epochAtStart) break
        // 重试 pending 与 sent（响应丢失后重启的"不确定态"，原 opId 幂等重放）；
        // conflict 条目必须由用户显式解决，不自动重试
        if ((entry.status === 'pending' || entry.status === 'sent') && !entry.conflict) {
          results.push(await flushEntry(entry.id))
        }
      }
      return { ok: true, results }
    } finally {
      flushRunning.value = false
    }
  }

  // ── 领域入口（页面调用；payload 只含提交字段，null/'' = 显式清除）──
  async function saveDaily(date, partial, baselineRevision) {
    const dateKey = typeof date === 'string' ? date : todayKeyOf(date)
    return submit({
      kind: 'daily', entityId: `daily:${dateKey}`, payload: partial,
      dateKey, localRecordGetter: () => daily.value[dateKey], baselineRevision
    })
  }
  async function deleteDaily(date) {
    const dateKey = typeof date === 'string' ? date : todayKeyOf(date)
    return submit({
      kind: 'daily-delete', entityId: `daily:${dateKey}`, payload: {},
      dateKey, localRecordGetter: () => daily.value[dateKey]
    })
  }
  async function savePregnancy(partial, baselineRevision) {
    return submit({
      kind: 'pregnancy', entityId: 'pregnancy', payload: partial,
      localRecordGetter: () => pregnancy.value,
      baselineRevision
    })
  }
  async function saveMood(date, partial, baselineRevision) {
    const dateKey = typeof date === 'string' ? date : todayKeyOf(date)
    return submit({
      kind: 'mood', entityId: `mood:${dateKey}`, payload: partial,
      dateKey, localRecordGetter: () => moods.value[dateKey], baselineRevision
    })
  }

  // 只读视图（页面/趋势）
  function dailyRecord(dateKey) {
    if (!sessionReady()) return null
    const r = daily.value[dateKey]
    return r && !r.deleted ? r : null
  }
  function moodRecord(dateKey) {
    if (!sessionReady()) return null
    const r = moods.value[dateKey]
    return r && !r.deleted ? r : null
  }
  function dailyHistoryAsc() {
    if (!sessionReady()) return []
    return Object.values(daily.value)
      .filter(r => !r.deleted)
      .sort((a, b) => a.dateKey.localeCompare(b.dateKey))
  }

  // 成员切换/退出：清空内存视图（待办与快照留在原成员命名空间）
  function clearMemory() {
    pregnancy.value = null
    daily.value = {}
    moods.value = {}
    lastFullSyncAt.value = null
    lastError.value = ''
  }

  // 订阅权威会话状态：任何失效（退出 endSession / 业务身份拒绝锁定 / 确认完成
  // 更换成员）都立即清空已可渲染内容——不依赖某个页面自觉调用 clearMemory。
  // 已挂载的其他页面在下一次读取（computed 依赖 sessionVersion）时同样拿到空数据。
  const sessionVersion = subscribeSession()
  let lastWatchedMemberId = null
  watch(sessionVersion, () => {
    const s = getSessionState()
    if (s.status !== 'confirmed') {
      clearMemory()
      lastWatchedMemberId = null
      return
    }
    // 仅【成员更换】时清空旧成员内容并恢复新成员快照；
    // 同成员重确认（含回前台复核）不得清掉已拉取/已保存的数据
    const memberId = s.member ? s.member.memberId : null
    if (lastWatchedMemberId !== null && memberId !== lastWatchedMemberId) {
      clearMemory()
      restoreFromCache()
    }
    lastWatchedMemberId = memberId
  }, { immediate: false })

  return {
    pregnancy, daily, moods, lastFullSyncAt, syncing, lastError,
    pendingCount, conflictEntries,
    restoreFromCache, pullAll, flushAll, flushEntry, adoptCloud, resubmit,
    saveDaily, deleteDaily, savePregnancy, saveMood,
    dailyRecord, moodRecord, dailyHistoryAsc, clearMemory,
    __submit: submit,
    __applyForTests: applyServerRecord
  }
})
