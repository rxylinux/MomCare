// B2a 家庭数据权威源（Pinia store）：孕期档案 / 共享健康数字 / 私人心情备注。
// 全部读写经 sessionService.familyCall → mc-health 云函数；持久 outbox 承载离线待办。
// 冷启动未确认身份前不加载任何成员快照；快照按成员缓存（getMemberCache），
// 仅在全部分页成功后推进"完整同步时间"。

import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { familyCall, captureSession, isSameSession, getMemberCache, setMemberCache, getSessionState, subscribeSession } from '@/services/sessionService.js'
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

// 键序无关的稳定序列化（"未变更重试"比较用）
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) === undefined ? 'undefined' : JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}'
}

export const useFamilyStore = defineStore('familyData', () => {
  const pregnancy = ref(null)            // viewPregnancy 或 null
  const checkups = ref({})               // B2b1: id → viewCheckup
  const bagItems = ref({})               // B2b1: id → viewBag
  const reports = ref({})                // B2b2: id → viewReport
  const lastReportSyncAt = ref(null)     // B2b2: 报告域完整同步时间
  const daily = ref({})                  // dateKey → viewDaily（含 deleted 墓碑）
  const moods = ref({})                  // dateKey → viewMood（本人）
  const lastFullSyncAt = ref(null)
  // 各领域完整同步时间：仅在对应领域全部页拉取成功后推进（spec 5）
  const lastBagSyncAt = ref(null)
  const lastCheckupSyncAt = ref(null)
  // 当前自动产检安排所基于的 LMP（生成模板时记录；改期全部完成后推进）
  const scheduleLmpKey = ref(null)
  // 已确认迁移批次（完整清单先行持久化，网络前收集全部目标与预览时 revision）：
  // { oldLmpDateKey, newLmpDateKey, items: [{id, newDateKey, revision}], settled: {id: 'ok'|'terminal'|'adopted'} }
  // 基线只在"覆盖当前变更的已确认批次、全部预期单项落定"后推进——
  // 普通同步/未预览确认/部分挂起不得消除迁移提示（不能以"队列空"替代确认）
  const migrationBatch = ref(null)
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

  // 冷启动：身份确认后调用；恢复成员缓存快照，随后按需拉取。
  // 快照按【家庭】作用域存取（同成员可重确认进不同家庭）：
  // - persistSnapshot 只写家庭作用域键并在载荷内记录 familyId
  // - restoreFromCache 只读当前家庭的键；载荷 familyId 不匹配不采用（双检）
  // - 旧成员级键（无家庭作用域）保守保留原字节、不迁移不清除；
  //   其内容无法证明属于哪个家庭，不自动采用（云端权威拉取兜底）
  function snapshotKeyFor(familyId) {
    return `${SNAPSHOT_KEY}@fam:${familyId}`
  }
  function restoreFromCache() {
    if (!sessionReady()) return false
    const fam = getSessionState().member.familyId
    const snap = getMemberCache(snapshotKeyFor(fam))
    if (!snap) return false
    if (snap.familyId !== undefined && snap.familyId !== fam) return false
    pregnancy.value = snap.pregnancy || null
    daily.value = snap.daily || {}
    moods.value = snap.moods || {}
    checkups.value = snap.checkups || {}
    bagItems.value = snap.bagItems || {}
    reports.value = snap.reports || {}
    lastReportSyncAt.value = snap.lastReportSyncAt || null
    lastFullSyncAt.value = snap.lastFullSyncAt || null
    lastBagSyncAt.value = snap.lastBagSyncAt || null
    lastCheckupSyncAt.value = snap.lastCheckupSyncAt || null
    scheduleLmpKey.value = snap.scheduleLmpKey || null
    migrationBatch.value = snap.migrationBatch || null
    return true
  }

  // 返回是否成功落盘：清单类调用方（迁移批次）以此为发网络门槛——
  // 落盘失败不得发送（不可假设 persistSnapshot 一定成功）。
  // sessionAtWrite（R7）：真切换成员后拒写（不进新成员命名空间）；同成员回前台
  // 复核推进纪元不再误判——判定与写入之间无 await，单线程内无插入窗口
  function persistSnapshot(sessionAtWrite) {
    if (!sessionReady()) return false
    if (sessionAtWrite !== undefined && !isSameSession(sessionAtWrite)) return false
    const fam = getSessionState().member.familyId
    return setMemberCache(snapshotKeyFor(fam), {
      familyId: fam,
      pregnancy: pregnancy.value,
      daily: daily.value,
      moods: moods.value,
      checkups: checkups.value,
      bagItems: bagItems.value,
      reports: reports.value,
      lastReportSyncAt: lastReportSyncAt.value,
      lastFullSyncAt: lastFullSyncAt.value,
      lastBagSyncAt: lastBagSyncAt.value,
      lastCheckupSyncAt: lastCheckupSyncAt.value,
      scheduleLmpKey: scheduleLmpKey.value,
      migrationBatch: migrationBatch.value
    })
  }

  // 分页拉取：全部页成功才推进完整同步时间；任一页失败保留旧快照与待办
  async function pullAll() {
    if (!sessionReady() || syncing.value) return { ok: false, reason: 'busy' }
    syncing.value = true
    lastError.value = ''
    const sessionAtStart = captureSession()
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

      if (!isSameSession(sessionAtStart)) return { ok: false, reason: 'stale' }
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
      persistSnapshot(sessionAtStart)
      return { ok: true }
    } catch (e) {
      // 旧 continuation（挂起期间身份已变化）的失败不得改写新身份的
      // 同步异常标记——新身份的 UI 状态只由自己的拉取决定
      if (isSameSession(sessionAtStart)) {
        lastError.value = `同步失败：${e.message || e}`
        return { ok: false, reason: 'error', message: lastError.value }
      }
      return { ok: false, reason: 'stale', message: `同步失败：${e.message || e}` }
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
  // 孕期档案单条拉取（我的页摘要同源；全量同步仍走 pullAll）
  async function pullPregnancy() {
    if (!sessionReady()) return { ok: false }
    const res = await familyCall('mc-health', { action: 'pregnancy.get', schemaVersion: SCHEMA_VERSION, operationId: 'ro-get' })
    if (!res.ok) return res
    if (res.data && res.data.record) {
      pregnancy.value = mergeRecord(pregnancy.value, res.data.record)
      persistSnapshot()
    }
    return { ok: true }
  }

  // ── 通用提交：outbox 落盘 → 发送 → 幂等收尾 ──
  async function submit({ kind, entityId, payload, dateKey, localRecordGetter, baselineRevision, extraArgs, stableOpId }) {
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session' }
    const local = localRecordGetter ? localRecordGetter() : null
    // baselineRevision：调用方（如表单）捕获的编辑开始版本——优先于当前快照版本
    const expectedRevision = (baselineRevision !== undefined && baselineRevision !== null)
      ? baselineRevision
      : (local ? local.revision : 0)
    const extra = { dateKey: dateKey || null, ...(extraArgs || {}) }
    // 迁移固定意图（stableOpId）：不走 sameEntity 去重/不合并——
    // 完整比较 kind/entity/date/expectedRevision/extra/payload 全部相同才重放同 opId；
    // 同 opId 换正文拒绝；不借用普通编辑的 opId/基线；不吞掉普通未发送草稿
    if (stableOpId) {
      const existing = getOutbox().find(e => e.opId === stableOpId)
      if (existing) {
        const fullMatch = existing.kind === kind &&
          existing.entityId === entityId &&
          existing.expectedRevision === expectedRevision &&
          stableStringify(existing.payload) === stableStringify(payload) &&
          stableStringify(existing.extra || {}) === stableStringify(extra || {})
        if (fullMatch) {
          return flushEntry(existing.id) // 幂等重放
        }
        return { ok: false, code: 'operation-id-conflict', message: '同一迁移操作 ID 曾以不同内容提交——不可变更' }
      }
      // 没有同 opId 条目→直接入队（不检查 sameEntity——不借用/不合并普通编辑）
    } else {
      // 普通编辑：未变更重试（同实体同内容重放原请求）
      const sameEntity = getOutbox().find(e => e.entityId === entityId && !e.conflict && !e.immutable)
      if (sameEntity && stableStringify(sameEntity.payload) === stableStringify(payload)) {
        return flushEntry(sameEntity.id)
      }
    }
    const opId = stableOpId || newOpId(kind.replace(/[^a-z]/g, '').slice(0, 6))
    // outbox 只存可序列化字段（云调用参数 + 展示）；落盘失败不发请求不报成功
    const enq = enqueueOutbox({
      kind, entityId, opId, expectedRevision, payload, extra,
      immutable: Boolean(stableOpId) // 迁移固定意图不可被普通编辑合并
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
    const sessionAtStart = captureSession()
    if (!markSent(id)) {
      // 发送前无法持久化"可能已发送"（everSent=true）的不可变状态：
      // 若继续发送而后台合并该条目，未确认请求会被改写丢失——必须停止网络，
      // 保留磁盘原件，如实报告；恢复后以原 ID/内容重放
      return { ok: false, code: 'outbox-state-persist-failed', message: '待同步状态无法持久化，已停止发送（内容已保留，请重试）' }
    }
    // mc-health 与 mc-schedule 领域使用不同函数与参数映射
    const isScheduleKind = entry.kind.startsWith('bag') || entry.kind.startsWith('checkup')
    const isReportKind = entry.kind.startsWith('report')
    const fnName = isScheduleKind ? 'mc-schedule' : (isReportKind ? 'mc-reports' : 'mc-health')
    let action
    if (entry.kind === 'daily-delete') action = 'daily.delete'
    else if (entry.kind === 'bag-delete') action = 'bag.delete'
    else if (entry.kind === 'checkup-delete') action = 'checkup.delete'
    else if (entry.kind === 'checkup-item') action = 'checkup.toggle-item'
    else if (entry.kind === 'report-delete') action = 'report.delete'
    else if (entry.kind === 'bag-init') action = 'bag.initialize'
    else if (entry.kind === 'checkup-init') action = 'checkup.initialize'
    else if (entry.kind === 'checkup-migrate') action = 'checkup.migrate-apply'
    else action = `${entry.kind}.upsert`
    const callData = {
      action,
      schemaVersion: SCHEMA_VERSION,
      operationId: entry.opId,
      expectedRevision: entry.expectedRevision,
      payload: entry.payload
    }
    // 持久批量协议（spec 补充说明）：一条模板/一条改期 = 一条待办单项请求，
    // payload 即完整单项模板/由 extra 组装单项改期 op
    if (entry.kind === 'bag-init' || entry.kind === 'checkup-init') {
      callData.templates = [entry.payload]
      delete callData.payload
    } else if (entry.kind === 'checkup-migrate') {
      callData.ops = [{ id: entry.extra.id, newDateKey: entry.extra.newDateKey, expectedRevision: entry.expectedRevision }]
      // 存量记录钉基线用：请求方的当前基线 LMP（服务端仅在记录缺失基线时采用）
      if (entry.extra.originLmpDate) callData.originLmpDate = entry.extra.originLmpDate
      delete callData.payload
    }
    if (isScheduleKind || isReportKind) {
      if (entry.extra.id) callData.id = entry.extra.id
      if (entry.kind === 'checkup-item' && entry.extra.itemId) {
        callData.itemId = entry.extra.itemId
        if (entry.extra.targetDone !== undefined) callData.targetDone = entry.extra.targetDone
      }
      if (entry.extra.status) callData.status = entry.extra.status
      if (entry.extra.templateKey !== undefined) callData.templateKey = entry.extra.templateKey
      if (entry.extra.source) callData.source = entry.extra.source
    } else {
      callData.dateKey = entry.extra && entry.extra.dateKey ? entry.extra.dateKey : undefined
    }
    const res = await familyCall(fnName, callData)
    if (!isSameSession(sessionAtStart)) {
      return { ok: false, code: 'stale-session' } // 身份已切换：待办留在原成员名下（同成员复核不算，R7）
    }
    // 批量 API 的单项语义：顶层 ok 不代表单项成功（spec 补充说明）——
    // 单项失败按其真实状态落待办/冲突/终态，不以整批 ok 伪装完成
    if (res.ok && (entry.kind === 'bag-init' || entry.kind === 'checkup-init')) {
      const item = res.data.results && res.data.results[0]
      if (!item || !item.ok) {
        markPendingAgain(id, (item && item.code) || 'initialize-item-failed')
        return { ok: false, code: (item && item.code) || 'initialize-item-failed', entryId: id }
      }
      if (!removeEntry(id)) {
        // 移除落盘失败：保留条目；下次 flush 幂等重放后移除（服务端存在即保留）
      }
      return { ok: true, skipped: Boolean(item.skipped), recordId: item.id }
    }
    if (res.ok && entry.kind === 'checkup-migrate') {
      const item = res.data.results && res.data.results[0]
      if (!item) {
        markPendingAgain(id, 'migrate-no-result')
        return { ok: false, code: 'migrate-no-result', entryId: id }
      }
      if (item.ok) {
        // 重放时优先当前权威版本（含此后的删除/修改），不重新应用历史快照
        const authoritative = (item.replayed && item.currentRecord) ? item.currentRecord : item.record
        applyServerRecord(entry.kind, authoritative)
        if (!removeEntry(id)) { /* 保留待办：幂等重放后移除 */ }
        persistSnapshot(sessionAtStart)
        settleMigrationItem(entry.extra.id, 'ok')
        maybeAdvanceScheduleLmp()
        return { ok: true, replayed: Boolean(item.replayed), record: authoritative }
      }
      if (item.code === 'revision-conflict') {
        markConflict(id, item.currentRevision, item.currentRecord || null)
        return { ok: false, code: 'revision-conflict', currentRevision: item.currentRevision, entryId: id }
      }
      if (item.code === 'not-eligible' || item.code === 'not-found' || item.code === 'operation-id-conflict') {
        // 他端已改/已删/已处理：重试不可能成功——终态移除并如实上报
        if (!removeEntry(id)) { /* 保留待办 */ }
        settleMigrationItem(entry.extra.id, 'terminal')
        maybeAdvanceScheduleLmp()
        return { ok: false, code: item.code, resolved: true, entryId: id }
      }
      markPendingAgain(id, item.code || 'migrate-item-failed')
      return { ok: false, code: item.code || 'migrate-item-failed', entryId: id }
    }
    if (res.ok) {
      // 重放时附带 currentRecord（服务端当前权威文档）：以它为准落地，
      // 避免旧快照在服务端已删除/推进后复活 UI；首次成功 currentRecord 为空
      const authoritative = (res.data.replayed && res.data.currentRecord) ? res.data.currentRecord : res.data.record
      applyServerRecord(entry.kind, authoritative)
      if (!removeEntry(id)) {
        // 移除落盘失败：保留条目；下次 flush 幂等重放后移除（服务端不重复写）
      }
      persistSnapshot(sessionAtStart)
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
    } else if (kind.startsWith('checkup')) {
      if (record.id) checkups.value = { ...checkups.value, [record.id]: mergeRecord(checkups.value[record.id], record) }
    } else if (kind.startsWith('bag')) {
      if (record.id) bagItems.value = { ...bagItems.value, [record.id]: mergeRecord(bagItems.value[record.id], record) }
    } else if (kind.startsWith('report')) {
      if (record.id) reports.value = { ...reports.value, [record.id]: mergeRecord(reports.value[record.id], record) }
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
    else if (entry.kind.startsWith('bag') && entry.extra && entry.extra.id) {
      const res = await familyCall('mc-schedule', { action: 'bag.get', schemaVersion: SCHEMA_VERSION, id: entry.extra.id })
      if (res.ok && res.data.record) {
        bagItems.value = { ...bagItems.value, [entry.extra.id]: mergeRecord(bagItems.value[entry.extra.id], res.data.record) }
        applied = true
      }
    } else if (entry.kind.startsWith('checkup') && entry.extra && entry.extra.id) {
      const res = await familyCall('mc-schedule', { action: 'checkup.get', schemaVersion: SCHEMA_VERSION, id: entry.extra.id })
      if (res.ok && res.data.record) {
        checkups.value = { ...checkups.value, [entry.extra.id]: mergeRecord(checkups.value[entry.extra.id], res.data.record) }
        applied = true
      }
    } else if (entry.kind.startsWith('report') && entry.extra && entry.extra.id) {
      const res = await familyCall('mc-reports', { action: 'report.get', schemaVersion: SCHEMA_VERSION, id: entry.extra.id })
      if (res.ok && res.data.record) {
        reports.value = { ...reports.value, [entry.extra.id]: mergeRecord(reports.value[entry.extra.id], res.data.record) }
        applied = true
      }
    }

    if (!applied) {
      // 读失败（含断网）：保留待办与输入，不报成功
      return false
    }
    // 改期项冲突被显式放弃（采用云端）：批次单项落定
    if (entry.kind === 'checkup-migrate' && entry.extra && entry.extra.id) {
      settleMigrationItem(entry.extra.id, 'adopted')
      maybeAdvanceScheduleLmp()
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
      const sessionAtStart = captureSession()
      // 迁移恢复：批次已保存但部分项尚未入队（确认后/入队前退出）——
      // 按原确认目标与预览 revision 恢复到持久待办，不重做预览替换目标
      await recoverMigrationBatch()
      for (const entry of getOutbox()) {
        if (!isSameSession(sessionAtStart)) break
        // 重试 pending 与 sent（响应丢失后重启的"不确定态"，原 opId 幂等重放）；
        // conflict 条目必须由用户显式解决，不自动重试
        if ((entry.status === 'pending' || entry.status === 'sent') && !entry.conflict) {
          results.push(await flushEntry(entry.id))
        }
      }
      maybeAdvanceScheduleLmp()
      return { ok: true, results }
    } finally {
      flushRunning.value = false
    }
  }

  // ── 领域入口（页面调用；payload 只含提交字段，null/'' = 显式清除）──
  async function saveDaily(date, partial, baselineRevision, stableOpId) {
    const dateKey = typeof date === 'string' ? date : todayKeyOf(date)
    return submit({
      kind: 'daily', entityId: `daily:${dateKey}`, payload: partial,
      dateKey, localRecordGetter: () => daily.value[dateKey], baselineRevision, stableOpId
    })
  }
  async function deleteDaily(date) {
    const dateKey = typeof date === 'string' ? date : todayKeyOf(date)
    return submit({
      kind: 'daily-delete', entityId: `daily:${dateKey}`, payload: {},
      dateKey, localRecordGetter: () => daily.value[dateKey]
    })
  }
  async function savePregnancy(partial, baselineRevision, stableOpId) {
    return submit({
      kind: 'pregnancy', entityId: 'pregnancy', payload: partial,
      localRecordGetter: () => pregnancy.value,
      baselineRevision, stableOpId
    })
  }
  async function saveMood(date, partial, baselineRevision, stableOpId) {
    const dateKey = typeof date === 'string' ? date : todayKeyOf(date)
    return submit({
      kind: 'mood', entityId: `mood:${dateKey}`, payload: partial,
      dateKey, localRecordGetter: () => moods.value[dateKey], baselineRevision, stableOpId
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
    checkups.value = {}
    bagItems.value = {}
    reports.value = {}
    lastReportSyncAt.value = null
    lastFullSyncAt.value = null
    lastBagSyncAt.value = null
    lastCheckupSyncAt.value = null
    scheduleLmpKey.value = null
    migrationBatch.value = null
    lastError.value = ''
  }

  // 订阅权威会话状态：任何失效（退出 endSession / 业务身份拒绝锁定 / 确认完成
  // 更换成员或家庭）都立即清空已可渲染内容——不依赖某个页面自觉调用 clearMemory。
  // 已挂载的其他页面在下一次读取（computed 依赖 sessionVersion）时同样拿到空数据。
  const sessionVersion = subscribeSession()
  let lastWatchedMemberId = null
  let lastWatchedFamilyId = null
  watch(sessionVersion, () => {
    const s = getSessionState()
    if (s.status !== 'confirmed') {
      clearMemory()
      lastWatchedMemberId = null
      lastWatchedFamilyId = null
      return
    }
    // 【成员或家庭任一更换】时清空旧内容并恢复新作用域快照——
    // 同成员重确认进不同家庭（familyId 变化）同样不得保留旧家庭数据；
    // 同成员同家庭重确认（含回前台复核）不得清掉已拉取/已保存的数据
    const memberId = s.member ? s.member.memberId : null
    const familyId = s.member ? s.member.familyId : null
    if (lastWatchedMemberId !== null &&
        (memberId !== lastWatchedMemberId || (lastWatchedFamilyId !== null && familyId !== lastWatchedFamilyId))) {
      clearMemory()
      restoreFromCache()
    }
    lastWatchedMemberId = memberId
    lastWatchedFamilyId = familyId
  }, { immediate: false })

  // ── B2b1：待产包 ──
  async function pullBagItems() {
    if (!sessionReady()) return { ok: false }
    const sessionAtStart = captureSession()
    let cursor = null, pages = 0
    const newBag = {}
    do {
      const res = await familyCall('mc-schedule', { action: 'bag.list', schemaVersion: SCHEMA_VERSION, cursor, limit: 100 })
      if (!res.ok) return res
      for (const r of res.data.records) newBag[r.id] = r
      cursor = res.data.nextCursor
      pages++
      if (pages > 20) return { ok: false, code: 'pagination-error' }
    } while (cursor)
    if (!isSameSession(sessionAtStart)) return { ok: false, code: 'stale-session' }
    const merged = { ...bagItems.value }
    for (const [k, v] of Object.entries(newBag)) merged[k] = mergeRecord(merged[k], v)
    bagItems.value = merged
    lastBagSyncAt.value = Date.now() // 全部页成功才推进本领域完整同步时间
    persistSnapshot(sessionAtStart)
    return { ok: true }
  }
  async function saveBagItem(id, partial, baselineRevision, stableOpId) {
    return submit({ kind: 'bag', entityId: `bag:${id}`, payload: partial,
      localRecordGetter: () => bagItems.value[id], baselineRevision, extraArgs: { id }, stableOpId })
  }
  async function deleteBagItem(id, baselineRevision) {
    return submit({ kind: 'bag-delete', entityId: `bag:${id}`, payload: {},
      localRecordGetter: () => bagItems.value[id], baselineRevision, extraArgs: { id } })
  }
  async function toggleBagItem(id) {
    const local = bagItems.value[id]
    const targetPrepared = !(local && local.prepared)
    return submit({ kind: 'bag', entityId: `bag:${id}`, payload: { prepared: targetPrepared },
      localRecordGetter: () => local, extraArgs: { id } })
  }

  // ── B2b1：产检 ──
  async function pullCheckups() {
    if (!sessionReady()) return { ok: false }
    const sessionAtStart = captureSession()
    let cursor = null, pages = 0
    const newChk = {}
    do {
      const res = await familyCall('mc-schedule', { action: 'checkup.list', schemaVersion: SCHEMA_VERSION, cursor, limit: 100 })
      if (!res.ok) return res
      for (const r of res.data.records) newChk[r.id] = r
      cursor = res.data.nextCursor
      pages++
      if (pages > 20) return { ok: false, code: 'pagination-error' }
    } while (cursor)
    if (!isSameSession(sessionAtStart)) return { ok: false, code: 'stale-session' }
    const merged = { ...checkups.value }
    for (const [k, v] of Object.entries(newChk)) merged[k] = mergeRecord(merged[k], v)
    checkups.value = merged
    lastCheckupSyncAt.value = Date.now() // 全部页成功才推进本领域完整同步时间
    // 迁移基线只从可信来源初始化一次：记录级 templateLmp（服务端持久）优先，
    // 无模板记录时以当前 LMP 兜底（无可迁移对象）；已推进的基线不被拉取回退
    if (!scheduleLmpKey.value) {
      const lmp = pregnancy.value && pregnancy.value.fields && pregnancy.value.fields.lmpDate
      const tplRecords = Object.values(merged).filter(c => !c.deleted && c.source === 'template' && c.templateLmp)
      if (tplRecords.length > 0) {
        tplRecords.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        scheduleLmpKey.value = tplRecords[0].templateLmp
      } else if (lmp) {
        scheduleLmpKey.value = lmp
      }
    }
    persistSnapshot(sessionAtStart)
    return { ok: true }
  }
  async function saveCheckup(id, payload, status, baselineRevision, templateKey, source, stableOpId) {
    return submit({ kind: 'checkup', entityId: `checkup:${id}`, payload,
      localRecordGetter: () => checkups.value[id], baselineRevision,
      extraArgs: { id, ...(status !== undefined ? { status } : {}), ...(templateKey !== undefined ? { templateKey } : {}), ...(source ? { source } : {}) }, stableOpId })
  }
  async function deleteCheckup(id, baselineRevision) {
    return submit({ kind: 'checkup-delete', entityId: `checkup:${id}`, payload: {},
      localRecordGetter: () => checkups.value[id], baselineRevision, extraArgs: { id } })
  }
  async function toggleCheckupItem(checkupId, itemId) {
    const local = checkups.value[checkupId]
    const items = local && local.examItems ? local.examItems : []
    const currentItem = items.find(it => it.itemId === itemId)
    const targetDone = currentItem ? !currentItem.done : true
    return submit({ kind: 'checkup-item', entityId: `checkup-item:${checkupId}:${itemId}`,
      payload: { targetDone },
      localRecordGetter: () => local, extraArgs: { id: checkupId, itemId, targetDone } })
  }
  // baselineRevision：弹层打开时捕获的版本（确认时记录可能已被对端推进——
  // 以旧基线提交产生冲突由用户解决，绝不改落到当时顶替的其他记录）
  async function markCheckupStatus(id, status, baselineRevision) {
    return submit({ kind: 'checkup', entityId: `checkup:${id}`, payload: {},
      localRecordGetter: () => checkups.value[id], baselineRevision, extraArgs: { id, status } })
  }

  // ── B2b1：模板初始化（持久协议：一条模板一条待办，稳定 entityId 防重复入队）──
  // 已有同模板待办则重放该待办（不重复建）；云端已存在（含已删墓碑）则跳过，
  // 已删模板不因重试复活（服务端存在即保留语义）
  async function initializeBagTemplates(templates) {
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session' }
    const sessionAtStart = captureSession()
    const results = []
    for (const tpl of templates) {
      if (!isSameSession(sessionAtStart)) break // 成员切换：停止入队，留待原成员续传
      if (!tpl || !tpl.templateKey) { results.push({ templateKey: '', ok: false, code: 'invalid-template' }); continue }
      const entityId = `bag-init:${tpl.templateKey}`
      const queued = getOutbox().find(e => e.entityId === entityId)
      if (queued) {
        const r = await flushEntry(queued.id)
        results.push({ templateKey: tpl.templateKey, ok: r.ok, code: r.code, reused: true })
        continue
      }
      if (bagItems.value['bag_tpl_' + tpl.templateKey]) {
        results.push({ templateKey: tpl.templateKey, ok: true, skipped: true })
        continue
      }
      const r = await submit({
        kind: 'bag-init', entityId, baselineRevision: 0,
        payload: { templateKey: tpl.templateKey, name: tpl.name, category: tpl.category, quantity: tpl.quantity || 1 },
        extraArgs: { templateKey: tpl.templateKey }
      })
      results.push({ templateKey: tpl.templateKey, ok: r.ok, code: r.code, skipped: r.skipped })
    }
    const allDone = results.length > 0 && results.every(r => r.ok || r.skipped)
    return { ok: allDone, results }
  }

  async function initializeCheckupTemplates(templates) {
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session' }
    const sessionAtStart = captureSession()
    const lmp = pregnancy.value && pregnancy.value.fields && pregnancy.value.fields.lmpDate
    const results = []
    for (const tpl of templates) {
      if (!isSameSession(sessionAtStart)) break // 成员切换：停止入队，留待原成员续传
      if (!tpl || !tpl.templateKey || !tpl.dateKey) { results.push({ templateKey: (tpl && tpl.templateKey) || '', ok: false, code: 'invalid-template' }); continue }
      const entityId = `checkup-init:${tpl.templateKey}`
      const queued = getOutbox().find(e => e.entityId === entityId)
      if (queued) {
        const r = await flushEntry(queued.id)
        results.push({ templateKey: tpl.templateKey, ok: r.ok, code: r.code, reused: true })
        continue
      }
      if (checkups.value['chk_tpl_' + tpl.templateKey]) {
        results.push({ templateKey: tpl.templateKey, ok: true, skipped: true })
        continue
      }
      const r = await submit({
        kind: 'checkup-init', entityId, baselineRevision: 0,
        payload: {
          templateKey: tpl.templateKey, dateKey: tpl.dateKey,
          // 服务端持久来源基线：后续迁移预览按此绝对计算（修复16 的客户端侧输入）
          templateLmp: lmp || null,
          time: tpl.time || null, hospital: tpl.hospital || null,
          examItems: (tpl.examItems || []).map(it => ({
            itemId: it.itemId, text: it.text, required: Boolean(it.required), done: false
          }))
        },
        extraArgs: { templateKey: tpl.templateKey }
      })
      results.push({ templateKey: tpl.templateKey, ok: r.ok, code: r.code, skipped: r.skipped })
    }
    // 模板全部落定后记录本次自动安排所基于的 LMP（与记录级 templateLmp 一致）
    // 仅在原会话内推进并落盘（切换后不把原成员状态写进新成员命名空间）
    if (isSameSession(sessionAtStart) && lmp && results.length > 0 && results.every(r => r.ok || r.skipped) &&
        !getOutbox().some(e => e.kind === 'checkup-init')) {
      scheduleLmpKey.value = lmp
      persistSnapshot(sessionAtStart)
    }
    const allDone = results.length > 0 && results.every(r => r.ok || r.skipped)
    return { ok: allDone, results }
  }

  // ── B2b1：孕期日期迁移（预览只读；应用逐条持久待办，可部分失败恢复）──
  // LMP 变化检测：当前 pregnancy lmpDate 与上次生成/迁移完成基线不一致
  const lmpMigrationInfo = computed(() => {
    const lmp = pregnancy.value && pregnancy.value.fields && pregnancy.value.fields.lmpDate
    if (!lmp || !scheduleLmpKey.value || scheduleLmpKey.value === lmp) return null
    return { oldLmpDateKey: scheduleLmpKey.value, newLmpDateKey: lmp }
  })
  // 批次单项落定登记（ok=已迁移；terminal=不可再成功；adopted=用户显式采用云端放弃该项）
  function settleMigrationItem(id, state) {
    const b = migrationBatch.value
    if (!b || !Array.isArray(b.items) || !b.items.some(m => m.id === id)) return
    if (state !== 'ok' && state !== 'terminal' && state !== 'adopted') return
    b.settled = { ...(b.settled || {}), [id]: state }
  }
  // 只有【覆盖当前变更的已确认批次】且全部预期单项落定、无遗留改期待办时才推进基线；
  // 未预览确认/部分挂起/普通同步均不得推进（不能以"队列空"替代确认与整批完成）
  function maybeAdvanceScheduleLmp() {
    const info = lmpMigrationInfo.value
    if (!info) return
    const b = migrationBatch.value
    if (!b || b.newLmpDateKey !== info.newLmpDateKey || !Array.isArray(b.items) || b.items.length === 0) return
    if (!b.items.every(m => b.settled && b.settled[m.id])) return
    const stillQueued = getOutbox().some(e =>
      e.kind === 'checkup-migrate' && e.extra && b.items.some(m => m.id === e.extra.id))
    if (stillQueued) return
    scheduleLmpKey.value = info.newLmpDateKey
    migrationBatch.value = null
    persistSnapshot()
  }
  async function previewCheckupMigration() {
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session' }
    const info = lmpMigrationInfo.value
    if (!info) return { ok: false, code: 'no-migration-needed' }
    const res = await familyCall('mc-schedule', {
      action: 'checkup.migrate-preview', schemaVersion: SCHEMA_VERSION,
      oldLmpDate: info.oldLmpDateKey, newLmpDate: info.newLmpDateKey
    })
    if (!res.ok) return res
    // 服务端按记录级来源基线确认：本次变更没有任何可迁移对象（他端已迁移/无模板/全部完成）
    // → 当前 LMP 即事实基线，消除提示（显式预览触发的服务端确认，非普通同步认可）
    if (!res.data.toUpdate || res.data.toUpdate.length === 0) {
      scheduleLmpKey.value = info.newLmpDateKey
      migrationBatch.value = null
      persistSnapshot()
    }
    return { ok: true, shiftDays: res.data.shiftDays, toUpdate: res.data.toUpdate, info }
  }
  // 迁移批次恢复：重启后把"已确认但未入队/入队记录丢失"的未完成项按原目标与
  // 原预览 revision 重建为持久待办（同 entityId，幂等）；已落定项与在队项不动。
  // 仅靠 flush 当前 outbox 覆盖不了"清单已存、单项未入队"的窗口。
  // 门槛：只认已成功持久化的清单（persistedAt）——未落盘的内存清单不得经恢复发送
  async function recoverMigrationBatch() {
    const b = migrationBatch.value
    if (!b || !b.persistedAt || !Array.isArray(b.items) || b.items.length === 0) return
    const sessionAtStart = captureSession()
    for (const m of b.items) {
      if (!isSameSession(sessionAtStart)) break // 成员切换：停止恢复，留待原成员续传
      if (b.settled && b.settled[m.id]) continue
      const entityId = `checkup-migrate:${m.id}:${m.newDateKey}`
      if (getOutbox().some(e => e.entityId === entityId)) continue
      await submit({
        kind: 'checkup-migrate', entityId, baselineRevision: m.revision,
        payload: {},
        extraArgs: { id: m.id, newDateKey: m.newDateKey, originLmpDate: b.oldLmpDateKey }
      })
    }
  }

  // 逐条应用：先收集并持久化【完整清单】（实体 ID + 目标日期 + 预览时 revision），
  // 再发起任何网络——首项成功不得清批次（此前 null.ids 崩溃根因：清单在循环内逐项追加，
  // 第一项成功时"全部落定"成立而误推进）；中断/重启后清单与未完成项保留。
  // 冲突进冲突区由用户解决，not-eligible/not-found 终态移除并如实上报。
  async function applyCheckupMigration(items) {
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session' }
    const info = lmpMigrationInfo.value
    if (!info) return { ok: false, code: 'no-migration-needed' }
    const valid = (items || []).filter(it => it && it.id && it.newDateKey)
    if (valid.length === 0) return { ok: false, code: 'empty-migration' }
    // 会话边界：整个 apply 以发起成员的会话为准——期间切换成员（含首项响应
    // 挂起时对端确认他人）不得把后续项入队到新成员名下；清单留在原成员缓存
    const sessionAtStart = captureSession()
    // 1) 网络前：建立覆盖当前变更的完整批次清单并落盘（同变更续传沿用并合并，换变更重建）
    // 落盘失败时内存清单回滚到上次持久化状态——未持久化的清单不得被恢复逻辑发送
    const prevBatchSnapshot = migrationBatch.value ? JSON.parse(JSON.stringify(migrationBatch.value)) : null
    if (!migrationBatch.value || migrationBatch.value.newLmpDateKey !== info.newLmpDateKey) {
      migrationBatch.value = { oldLmpDateKey: info.oldLmpDateKey, newLmpDateKey: info.newLmpDateKey, items: [], settled: {} }
    }
    const batch = migrationBatch.value
    for (const it of valid) {
      if (!batch.items.some(m => m.id === it.id)) {
        batch.items.push({ id: it.id, newDateKey: it.newDateKey, revision: it.revision })
      }
    }
    // persistedAt 随清单一并落盘：恢复（recoverMigrationBatch）只认带此标记的清单
    batch.persistedAt = Date.now()
    // 清单承担"尚未入队项"的恢复保障：写入失败必须停止、不发任何迁移请求
    // （与 outbox 落盘失败不发请求同一协议；不可假设 persistSnapshot 一定成功）；
    // 会话校验防止清单被写进切换后新成员的命名空间
    if (!persistSnapshot(sessionAtStart)) {
      migrationBatch.value = prevBatchSnapshot
      return { ok: false, code: 'manifest-persist-failed', message: '本机清单写入失败，已停止发送（内容保留，请重试）' }
    }
    // 2) 逐项执行（复用/新建持久待办；单项结果只更新清单状态，不改清单范围）
    const results = []
    let staleSession = false
    for (const it of valid) {
      // 每次入队前核对会话：首项响应挂起期间成员被切换 → 立即停止，
      // 后续项不以新成员入队/发送；原清单与已入队待办留在原成员名下续传
      if (!isSameSession(sessionAtStart)) { staleSession = true; break }
      const entityId = `checkup-migrate:${it.id}:${it.newDateKey}`
      const queued = getOutbox().find(e => e.entityId === entityId)
      if (queued) {
        const r = await flushEntry(queued.id)
        if (r && r.ok) settleMigrationItem(it.id, 'ok')
        else if (r && r.resolved) settleMigrationItem(it.id, 'terminal')
        results.push({ id: it.id, ok: r.ok, code: r.code, resolved: r.resolved, record: r.record })
        continue
      }
      const r = await submit({
        kind: 'checkup-migrate', entityId, baselineRevision: it.revision,
        payload: {},
        extraArgs: { id: it.id, newDateKey: it.newDateKey, originLmpDate: info.oldLmpDateKey }
      })
      if (r.ok) settleMigrationItem(it.id, 'ok')
      else if (r.resolved) settleMigrationItem(it.id, 'terminal')
      results.push({ id: it.id, ok: r.ok, code: r.code, resolved: r.resolved, record: r.record })
    }
    if (staleSession) {
      return { ok: false, code: 'stale-session', results, message: '会话已切换，未完成项保留在原成员名下' }
    }
    maybeAdvanceScheduleLmp()
    persistSnapshot(sessionAtStart)
    const pendingLeft = getOutbox().filter(e => e.kind === 'checkup-migrate').length
    const unsettled = migrationBatch.value
      ? migrationBatch.value.items.filter(m => !(migrationBatch.value.settled || {})[m.id]).length
      : 0
    return { ok: results.length > 0 && pendingLeft === 0 && unsettled === 0 && results.every(r => r.ok || r.resolved), results, pendingLeft, unsettled }
  }

  // ── B2b2：报告 ──
  async function pullReports() {
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session', message: '身份尚未确认完成，请稍后重试' }
    const sessionAtStart = captureSession()
    let cursor = null, pages = 0
    const newRpt = {}
    do {
      const res = await familyCall('mc-reports', { action: 'report.list', schemaVersion: SCHEMA_VERSION, cursor, limit: 100 })
      if (!res.ok) return res
      for (const r of res.data.records) newRpt[r.id] = r
      cursor = res.data.nextCursor
      pages++
      if (pages > 20) return { ok: false, code: 'pagination-error' }
    } while (cursor)
    if (!isSameSession(sessionAtStart)) return { ok: false, code: 'stale-session' }
    const merged = { ...reports.value }
    for (const [k, v] of Object.entries(newRpt)) merged[k] = mergeRecord(merged[k], v)
    reports.value = merged
    lastReportSyncAt.value = Date.now() // 全部页成功才推进本领域完整同步时间
    persistSnapshot(sessionAtStart)
    return { ok: true }
  }
  async function saveReport(id, partial, baselineRevision, stableOpId) {
    return submit({ kind: 'report', entityId: `report:${id}`, payload: partial,
      localRecordGetter: () => reports.value[id], baselineRevision, extraArgs: { id }, stableOpId })
  }
  async function deleteReport(id, baselineRevision) {
    return submit({ kind: 'report-delete', entityId: `report:${id}`, payload: {},
      localRecordGetter: () => reports.value[id], baselineRevision, extraArgs: { id } })
  }

  return {
    pregnancy, daily, moods, lastFullSyncAt, syncing, lastError,
    checkups, bagItems,
    lastBagSyncAt, lastCheckupSyncAt, scheduleLmpKey, lmpMigrationInfo, migrationBatch,
    pendingCount, conflictEntries,
    restoreFromCache, pullAll, flushAll, flushEntry, adoptCloud, resubmit,
    saveDaily, deleteDaily, savePregnancy, saveMood,
    pullPregnancy,
    pullBagItems, saveBagItem, deleteBagItem, toggleBagItem,
    initializeBagTemplates,
    pullCheckups, saveCheckup, deleteCheckup, toggleCheckupItem, markCheckupStatus,
    reports, lastReportSyncAt, pullReports, saveReport, deleteReport,
    initializeCheckupTemplates, previewCheckupMigration, applyCheckupMigration, maybeAdvanceScheduleLmp, recoverMigrationBatch,
    dailyRecord, moodRecord, dailyHistoryAsc, clearMemory,
    __submit: submit,
    __applyForTests: applyServerRecord
  }
})
