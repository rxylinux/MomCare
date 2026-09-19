// B2b2 报告批次 store：多图原件批次 + 权威报告创建（family 模式专用）。
//
// 协议（spec + 设计修订）：
// - 选图后先做本机持久副本并【完整清单落盘】（任何网络之前；落盘失败不发请求、
//   不显示"已排队"）；items 顺序即附件顺序，原件不压缩替代
// - 逐项独立推进 prepare→直传→registerStaged；成功项不重复上传；失败只重试失败项；
//   重试沿用原 uploadId/内容；staged-file-unreadable 保留本机原件（P1-4），
//   恢复=新 uploadId 重暂存同一 savedFilePath，用户显式重选才换原件
// - 全部登记后创建报告：走 familyStore outbox（稳定 reportId/operationId，
//   响应丢失幂等重放；冲突采用云端/确认重提）
// - 整批以发起成员 epoch 为准：逐项入队前核对，切换即停（批次留原成员名下）
// - 重启恢复：清单从成员缓存恢复，未完成项续传；已排队报告经 outbox 重放
import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { getSessionState, subscribeSession, currentEpoch, getMemberCache, setMemberCache, openRecoveryScope } from '@/services/sessionService.js'
import { useFamilyStore } from '@/services/familyStore.js'
import { persistLocalCopy, removeLocalCopy, uploadSingleFile, fetchUploadPolicy } from '@/services/fileUploadService.js'

const BATCHES_KEY = 'b2b2-upload-batches'

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function sessionReady() {
  const s = getSessionState()
  return s.status === 'confirmed' && s.member
}

export const useReportFamilyStore = defineStore('reportFamilyData', () => {
  const familyStore = useFamilyStore()
  // batchId → { batchId, reportId, status, items:[{order, uploadId, savedFilePath,
  //   stageFileID?, fileId?, state:'pending'|'uploading'|'registered'|'failed'|'staged-expired',
  //   error? }], draft, createdAt, updatedAt }
  const batches = ref({})
  const processing = ref(false)
  const uploadPolicy = ref(null) // {clientUploadEnabled, reason}
  // 清单落盘失败后的可恢复状态：saveFile 已移动临时文件，savedFilePath 是唯一
  // 恢复句柄——按【原始成员/环境/家庭】绑定并持久化（重启后仍可恢复）；
  // 其他成员不可见/不可恢复/不可删除；恢复保留完整批次结构（槽位/顺序/失败项）
  const RECOVERY_KEY = 'b2b2-recovery'
  const lastRecovery = ref(null) // { memberId, familyId, envId, reportId, items, message, at, persisted }
  function recoveryIdentityMatches(rec) {
    const s = getSessionState()
    return Boolean(rec && s.status === 'confirmed' && s.member &&
      rec.memberId === s.member.memberId && rec.familyId === s.member.familyId)
  }
  function loadRecovery() {
    if (!sessionReady()) return
    const saved = getMemberCache(RECOVERY_KEY)
    // 已取消的恢复不复活：discard 后即使清理失败留下的持久残留不再可恢复
    if (saved && saved.items && !saved.cancelled) lastRecovery.value = saved
  }
  function persistRecovery(rec, epochAtWrite) {
    if (!rec || !sessionReady()) return false
    return setMemberCache(RECOVERY_KEY, rec, epochAtWrite)
  }
  function clearPersistedRecovery() {
    if (!sessionReady()) return
    setMemberCache(RECOVERY_KEY, null)
  }
  loadRecovery()

  const sessionVersion = subscribeSession()

  function loadPersisted() {
    if (!sessionReady()) return
    const saved = getMemberCache(BATCHES_KEY)
    if (saved && typeof saved === 'object' && saved.batches) {
      const restored = saved.batches
      for (const b of Object.values(restored)) {
        // 进程中断残留的 uploading 归一为 pending（同 uploadId 幂等续传）
        for (const item of (b.items || [])) {
          if (item.state === 'uploading') item.state = 'pending'
        }
      }
      batches.value = restored
    }
  }
  // epochAtWrite：批量推进中的落盘必须带发起会话 epoch——成员切换后返回 false
  //（绝不把原成员批次写进新成员命名空间）
  function persistBatches(epochAtWrite) {
    if (!sessionReady()) return false
    return setMemberCache(BATCHES_KEY, { batches: batches.value }, epochAtWrite)
  }
  loadPersisted()

  // 会话失效/切换：内存批次清空（持久清单留在各成员命名空间，重确认后恢复）
  let lastMember = null
  // 各成员的仅内存恢复句柄（元数据落盘失败时保留；切回原成员时恢复）
  const memoryRecoveryByMember = new Map()
  watch(sessionVersion, () => {
    const s = getSessionState()
    if (s.status !== 'confirmed') {
      // 失效/退出/切换中间态：仅内存恢复句柄先按【发起成员】留档（同进程可找回），
      // 再清可见状态；持久清单与恢复元数据留各成员命名空间
      if (lastMember && lastRecovery.value && lastRecovery.value.persisted === false) {
        memoryRecoveryByMember.set(lastMember, JSON.parse(JSON.stringify(lastRecovery.value)))
      }
      batches.value = {}
      lastRecovery.value = null
      lastMember = null
      uploadPolicy.value = null
      processing.value = false
      return
    }
    const mid = s.member ? s.member.memberId : null
    if (mid !== lastMember) {
      // 切成员：先保存当前成员的仅内存恢复句柄（元数据未落盘也不丢恢复线索），
      // 清空可见恢复态（其他成员不可见），再从【新成员】本人缓存恢复其恢复态；
      // 切回原成员时优先磁盘持久恢复，否则找回其内存句柄
      if (lastMember && lastRecovery.value && lastRecovery.value.persisted === false) {
        memoryRecoveryByMember.set(lastMember, JSON.parse(JSON.stringify(lastRecovery.value)))
      }
      batches.value = {}
      lastRecovery.value = null
      loadPersisted()
      loadRecovery()
      if (!lastRecovery.value && mid && memoryRecoveryByMember.has(mid)) {
        // 内存 map 按成员键隔离——此处直接恢复（身份匹配在可见性/操作层另行把关）
        lastRecovery.value = memoryRecoveryByMember.get(mid)
      }
    }
    lastMember = mid
  })

  const activeBatches = computed(() => Object.values(batches.value)
    .filter(b => b.status !== 'done' && b.status !== 'cancelled')) // reconciling 保持可见（待对账）
  function batch(batchId) { return batches.value[batchId] || null }

  async function refreshUploadPolicy() {
    const epochAtStart = currentEpoch()
    const res = await fetchUploadPolicy()
    // 迟到门：挂起期间切成员——不把旧会话的策略写入当前 uploadPolicy
    if (currentEpoch() !== epochAtStart) {
      return { ok: false, clientUploadEnabled: false, reason: '会话已切换', stale: true }
    }
    // 仅成功策略可缓存：临时网络失败不得永久禁用后续重试（保持 null 以便重取）
    uploadPolicy.value = res.ok ? res : null
    return res.ok ? res : { ok: false, clientUploadEnabled: false, reason: res.message || '上传策略读取失败（可重试）' }
  }

  // ── 建批：本机持久副本 + 完整清单落盘（网络前）；逐项推进 ──
  async function createBatchFromTempPaths(tempPaths) {
    // 整次用户操作以开始会话为准：policy/选图/落盘/清单任何 await 后不得重新认可当前成员
    const epochAtStart = currentEpoch()
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session' }
    // 存在未处理恢复（本人）时阻止新批次建立：两份失败清单绝不拼接为一份报告；
    // 用户先恢复或放弃当前恢复，再开始新选图
    if (lastRecovery.value && lastRecovery.value.persisted !== undefined &&
        recoveryIdentityMatches(lastRecovery.value)) {
      return { ok: false, code: 'recovery-pending', message: '有未恢复的上传原件，请先在档案页恢复或放弃后再开始新上传' }
    }
    // 操作原身份：恢复索引的归属（与开始会话一致；切换后写回此成员命名空间）
    const sInit = getSessionState()
    const originIdentity = { memberId: sInit.member && sInit.member.memberId, familyId: sInit.member && sInit.member.familyId }
    // 恢复写入作用域：发起时（已确认身份）捕获 env/AppID/member/family——
    // 迟到写入只能落这个原作用域，不接受任意成员/键
    const recoveryScope = openRecoveryScope(RECOVERY_KEY)
    if (!Array.isArray(tempPaths) || tempPaths.length === 0) return { ok: false, code: 'empty-selection' }
    if (tempPaths.length > 20) return { ok: false, code: 'too-many', message: '最多一次上传 20 张' }
    const policy = uploadPolicy.value || await refreshUploadPolicy()
    if (currentEpoch() !== epochAtStart) {
      return { ok: false, code: 'stale-session', message: '会话已切换，未建立上传批次', stale: true }
    }
    if (!policy.clientUploadEnabled) {
      return { ok: false, code: 'upload-disabled', message: policy.reason || '上传通道未启用' }
    }
    const batchId = newId('rptb')
    const reportId = newId('rpt')
    const items = []
    let persistFailures = 0
    for (let i = 0; i < tempPaths.length; i++) {
      if (currentEpoch() !== epochAtStart) {
        // 切换即停：已落盘本机副本保留在原成员路径（不清除），不写任何成员清单
        return { ok: false, code: 'stale-session', message: '会话已切换，批次未建立', stale: true }
      }
      const persisted = await persistLocalCopy(tempPaths[i])
      // 先落槽位（含失败槽），再做会话核对——切换中断时已保存原件必须出现在恢复索引
      let item
      if (persisted.ok) {
        item = { order: i, uploadId: newId('up'), savedFilePath: persisted.path, stageFileID: '', fileId: '', state: 'pending', error: '' }
      } else {
        item = { order: i, uploadId: '', savedFilePath: '', stageFileID: '', fileId: '', state: 'persist-failed', error: '本机无法持久保存该图片' }
        persistFailures++
      }
      items.push(item)
      if (currentEpoch() !== epochAtStart) {
        // 挂起期间切成员：已落盘副本保留（不清除）；把【原身份绑定的恢复索引】
        // 写回原成员命名空间（不暴露给当前成员；回原成员可恢复续传，非仅"留在磁盘"）
        const originMemberId = originIdentity.memberId
        const recoveryItems = tempPaths.map((_, j) => {
          const done = items.find(it => it.order === j)
          return done ? { ...done } : { order: j, uploadId: '', savedFilePath: '', stageFileID: '', fileId: '', state: 'persist-failed', error: '切换中断，未保存' }
        })
        const writeOk = recoveryScope
          ? recoveryScope.write({
              memberId: originMemberId, familyId: originIdentity.familyId,
              reportId, items: recoveryItems,
              message: '上传中会话切换中断，已保存原件可恢复',
              at: Date.now(), persisted: true
            })
          : false
        return {
          ok: false, code: 'stale-session', stale: true,
          message: writeOk
            ? '会话已切换；已保存原件的恢复信息已保留在原成员名下'
            : '会话已切换；恢复信息写入失败，已保存原件路径在本次返回中（keptLocalPaths），请尽快重试'
        }
      }
    }
    if (items.length === 0 || items.every(i => i.state === 'persist-failed')) {
      // 全部无法持久化：不建批次、不发网络（不显示已排队）
      return { ok: false, code: 'persist-failed', message: '本机无法持久保存所选图片，未建立上传批次', failedCount: persistFailures }
    }
    const initialStatus = persistFailures > 0 ? 'partial' : 'uploading'
    batches.value = { ...batches.value, [batchId]: {
      batchId, reportId, status: initialStatus, items, draft: null, createdAt: Date.now(), updatedAt: Date.now()
    } }
    // 完整清单落盘门槛（带发起 epoch）：失败不发任何网络；本机已保存原件是唯一
    // 恢复句柄（saveFile 已移动临时文件），必须保留、不得删除
    if (!persistBatches(epochAtStart)) {
      const { [batchId]: _drop, ...rest } = batches.value
      void _drop
      batches.value = rest
      const keptLocalPaths = items.filter(i => i.savedFilePath).map(i => i.savedFilePath)
      // 清单失败且会话已切换：不把原成员恢复态写进/展示给新成员（原件保留本机）
      if (currentEpoch() !== epochAtStart) {
        return {
          ok: false, code: 'manifest-persist-failed',
          message: '本机批次清单写入失败且会话已切换；原件已保留在本机',
          keptLocalPaths
        }
      }
      const s = getSessionState()
      // 合并既有恢复句柄：多个批次先后清单失败时，前批原件恢复线索不被覆盖
      const prevRec = lastRecovery.value && lastRecovery.value.memberId === (s.member && s.member.memberId)
        ? lastRecovery.value : null
      const mergedItems = prevRec && Array.isArray(prevRec.items)
        ? [...prevRec.items, ...items.map(it => ({ ...it, order: it.order + prevRec.items.length }))]
        : items
      const rec = {
        memberId: s.member && s.member.memberId,
        familyId: s.member && s.member.familyId,
        reportId, items, // 本批完整槽位/顺序/失败项
        message: '批次清单写入失败，原件已保留在本机',
        at: Date.now(),
        persisted: false
      }
      rec.persisted = persistRecovery(rec, epochAtStart)
      // 落盘失败也保留内存恢复句柄（persisted:false 如实标注）——原件恢复线索不因
      // 元数据写盘失败而丢失；切成员内存清空、切回原成员时若磁盘也无可恢复，
      // 如实显示"仅内存"（关进程后不可恢复）
      lastRecovery.value = rec
      // 仅内存恢复（元数据未落盘）：立即按发起成员入内存 map——不依赖切出时机
      if (!rec.persisted && rec.memberId) {
        memoryRecoveryByMember.set(rec.memberId, JSON.parse(JSON.stringify(rec)))
      }
      return {
        ok: false, code: 'manifest-persist-failed',
        message: rec.persisted
          ? '本机批次清单写入失败，已停止上传；原件与恢复信息已保存，可在档案页恢复上传'
          : '本机批次清单写入失败，已停止上传；原件已保留（恢复信息未能落盘，退出后需重新上传）',
        keptLocalPaths
      }
    }
    if (currentEpoch() !== epochAtStart) {
      return { ok: true, batchId, reportId, started: false, note: '会话已切换，批次保留在原成员名下' }
    }
    const processing_ = processBatch(batchId)
    return { ok: true, batchId, reportId, started: true, persistFailedCount: persistFailures, processing: processing_ }
  }

  // ── 逐项推进：每项入队前核对 epoch；逐项独立成功/失败 ──
  async function processBatch(batchId) {
    if (processing.value) return
    const b = batches.value[batchId]
    if (!b || b.status === 'done' || b.status === 'cancelled') return
    processing.value = true
    const epochAtStart = currentEpoch()
    try {
      for (const item of b.items) {
        if (currentEpoch() !== epochAtStart) break // 成员切换：批次留原成员，停止推进
        if (item.state === 'registered' || item.state === 'staged-expired') continue
        if (item.state === 'uploading' || item.state === 'persist-failed') continue
        item.state = 'uploading'
        item.error = ''
        const res = await uploadSingleFile({ uploadId: item.uploadId, savedFilePath: item.savedFilePath })
        if (res.locked) { item.state = 'failed'; item.error = '身份被拒绝，请重新确认后重试'; break }
        if (res.stale) { item.state = 'pending'; break } // 待办留原成员；重确认后续传
        if (res.ok) {
          item.state = 'registered'
          item.fileId = res.fileId
          item.stageFileID = ''
        } else if (res.code === 'staged-file-unreadable') {
          // P1-4：本机原件保留——staged-expired 状态，可一键重暂存（新 uploadId 同原件）
          item.state = 'staged-expired'
          item.error = '暂存已过期，本机原件已保留，可重新暂存'
        } else {
          item.state = 'failed'
          item.error = res.message || res.code || '上传失败'
        }
        b.updatedAt = Date.now()
        persistBatches(epochAtStart)
      }
      // 汇总批次状态：全部登记=ready；有失败/过期=partial
      const states = b.items.map(i => i.state)
      if (states.every(x => x === 'registered')) b.status = 'ready'
      else if (states.some(x => x === 'failed' || x === 'staged-expired' || x === 'persist-failed')) b.status = 'partial'
      else b.status = 'uploading'
      b.updatedAt = Date.now()
      persistBatches(epochAtStart)
    } finally {
      processing.value = false
    }
  }

  // 重试失败项（成功项不重复）；ready 项不动
  async function retryBatch(batchId) {
    const b = batches.value[batchId]
    if (!b) return { ok: false, code: 'no-batch' }
    for (const item of b.items) {
      if (item.state === 'failed' || item.state === 'pending') item.state = 'pending'
    }
    persistBatches()
    return processBatch(batchId)
  }

  // P1-4 恢复：暂存过期的项用【本机原件】重新暂存（新 uploadId、同 savedFilePath、同顺序）
  async function restageItem(batchId, order) {
    const b = batches.value[batchId]
    if (!b) return { ok: false, code: 'no-batch' }
    const item = b.items.find(i => i.order === order)
    if (!item || item.state !== 'staged-expired') return { ok: false, code: 'not-restorable' }
    const prev = { uploadId: item.uploadId, state: item.state, error: item.error }
    item.uploadId = newId('up') // 新实体（旧 claiming 记录留给孤儿清理）；本机原件与顺序不变
    item.stageFileID = ''
    item.state = 'pending'
    item.error = ''
    if (!persistBatches()) {
      item.uploadId = prev.uploadId
      item.state = prev.state
      item.error = prev.error
      return { ok: false, code: 'persist-failed', message: '本机状态写入失败，未重暂存，请重试' }
    }
    const processed = await processBatch(batchId)
    // processBatch 可能返回 undefined（并发/保护路径）——统一可消费结果
    if (processed && typeof processed === 'object') return processed
    const bAfter = batches.value[batchId]
    const done = bAfter && bAfter.items.every(i => i.state === 'registered')
    return { ok: Boolean(done), code: done ? undefined : 'restage-incomplete',
      message: done ? undefined : '重新暂存未完成，请重试' }
  }

  // 显式重选原件（原 spec 恢复入口）：为失败/缺失槽位选择新图片——
  // 新 uploadId、保持原 order、新副本先持久，再推进上传
  async function replaceItemSlot(batchId, order) {
    const b = batches.value[batchId]
    if (!b) return { ok: false, code: 'no-batch' }
    const item = b.items.find(i => i.order === order)
    if (!item || item.state === 'registered') return { ok: false, code: 'not-replaceable' }
    // 整次重选以开始会话为准：选图/落盘每个 await 后核对；失效不删旧副本、
    // 不写当前成员缓存；新副本元数据失败保留恢复线索
    const epochAtStart = currentEpoch()
    const recoveryScope = openRecoveryScope(RECOVERY_KEY)
    const choose = await new Promise(resolve => {
      if (typeof uni.chooseImage !== 'function') return resolve(null)
      uni.chooseImage({ count: 1, sizeType: ['original'], sourceType: ['album', 'camera'], success: r => resolve(r), fail: () => resolve(null) })
    })
    if (currentEpoch() !== epochAtStart) {
      return { ok: false, code: 'stale-session', stale: true, message: '会话已切换，重选已取消（原副本未动）' }
    }
    const tempPath = choose && choose.tempFilePaths && choose.tempFilePaths[0]
    if (!tempPath) return { ok: false, code: 'cancelled' }
    const persistedCopy = await persistLocalCopy(tempPath)
    if (currentEpoch() !== epochAtStart) {
      // 切换：批次槽位不动；新副本已落盘——恢复记录保留【原完整批次】
      // （原 batchId/reportId/全部槽位与顺序/未动项登记状态），仅目标槽位指向
      // 新原件；不删旧副本、不写当前成员缓存；恢复后仍是同一份多页报告
      if (persistedCopy.ok && recoveryScope) {
        const mergedItems = b.items.map(it => it.order === order
          ? { ...it, uploadId: newId('up'), savedFilePath: persistedCopy.path, stageFileID: '', fileId: '', state: 'pending', error: '重选中断' }
          : { ...it })
        recoveryScope.write({
          memberId: recoveryScope.scope.memberId, familyId: recoveryScope.scope.familyId,
          batchId, reportId: b.reportId,
          items: mergedItems,
          message: '重选图片时会话切换中断，原批次与新原件可恢复', at: Date.now(), persisted: true
        })
      }
      return { ok: false, code: 'stale-session', stale: true, message: persistedCopy.ok ? '会话已切换；原批次与新图片已保留在原成员恢复信息中' : '会话已切换，重选已取消' }
    }
    if (!persistedCopy.ok) return { ok: false, code: 'persist-failed', message: '本机无法持久保存新图片' }
    const prev = { uploadId: item.uploadId, savedFilePath: item.savedFilePath, state: item.state, error: item.error }
    item.uploadId = newId('up')
    item.savedFilePath = persistedCopy.path
    item.state = 'pending'
    item.error = ''
    if (!persistBatches()) {
      item.uploadId = prev.uploadId
      item.savedFilePath = prev.savedFilePath
      item.state = prev.state
      item.error = prev.error
      // 与 session-switch 相同的完整批次协议：恢复记录保留原 batchId/reportId/
      // 全部槽位与顺序/未动项登记状态，仅目标槽位指向新原件——不缩减多页报告。
      // 先尝试持久恢复（原作用域），失败保留 owner 内存句柄（persisted:false 如实标注）
      const recForRecovery = {
        memberId: recoveryScope ? recoveryScope.scope.memberId : null,
        familyId: recoveryScope ? recoveryScope.scope.familyId : null,
        batchId, reportId: b.reportId,
        items: b.items.map(it => it.order === order
          ? { ...it, uploadId: newId('up'), savedFilePath: persistedCopy.path, stageFileID: '', fileId: '', state: 'pending', error: '清单写入失败' }
          : { ...it }),
        message: '重选清单写入失败，原批次与新原件可恢复', at: Date.now(),
        persisted: false
      }
      const scopeOk = recoveryScope ? recoveryScope.write(recForRecovery) : false
      recForRecovery.persisted = scopeOk
      lastRecovery.value = recForRecovery
      if (!scopeOk && recForRecovery.memberId) {
        memoryRecoveryByMember.set(recForRecovery.memberId, JSON.parse(JSON.stringify(recForRecovery)))
      }
      return { ok: false, code: 'persist-failed', message: scopeOk
        ? '本机状态写入失败；原批次与新图片的恢复信息已保留，请重试'
        : '本机状态写入失败；新图片与恢复信息保留在内存中（关闭应用后可能丢失），请重试' }
    }
    if (prev.savedFilePath) removeLocalCopy(prev.savedFilePath) // 清单已采纳新副本，旧失败副本清理
    return processBatch(batchId)
  }

  // 用户显式放弃某项（重选）：先持久确认新状态，再清理本机副本——
  // persistBatches 失败不得执行删除（恢复句柄丢失）
  function discardItem(batchId, order) {
    const b = batches.value[batchId]
    if (!b) return { ok: false }
    const item = b.items.find(i => i.order === order)
    if (!item) return { ok: false }
    const keptPath = item.savedFilePath
    const kept = b.items.filter(i => i.order !== order)
    const prevItems = b.items
    const prevStatus = b.status
    b.items = kept
    if (kept.length === 0) b.status = 'cancelled'
    if (!persistBatches()) {
      b.items = prevItems
      b.status = prevStatus
      return { ok: false, code: 'persist-failed', message: '本机状态写入失败，未删除原件，请重试' }
    }
    if (keptPath) removeLocalCopy(keptPath)
    return { ok: true }
  }

  // 整批显式放弃（未创建报告前）：先持久确认，再清理本机副本；已登记文件留给孤儿清理回收
  function discardBatch(batchId) {
    const b = batches.value[batchId]
    if (!b) return { ok: false }
    const paths = b.items.map(i => i.savedFilePath).filter(Boolean)
    const prevStatus = b.status
    b.status = 'cancelled'
    if (!persistBatches()) {
      b.status = prevStatus
      return { ok: false, code: 'persist-failed', message: '本机状态写入失败，未删除原件，请重试' }
    }
    for (const p of paths) removeLocalCopy(p)
    return { ok: true }
  }

  // ── 报告创建：全部登记后，附件按 items.order 组装，走 outbox 稳定 operationId ──
  async function createReportFromBatch(batchId, draft) {
    const b = batches.value[batchId]
    if (!b) return { ok: false, code: 'no-batch' }
    if (b.status !== 'ready' && b.status !== 'done' && b.status !== 'reconciling') {
      const blocked = b.items.filter(i => i.state !== 'registered')
      return { ok: false, code: 'not-ready', message: `尚有 ${blocked.length} 张图片未完成（${blocked[0] && blocked[0].state === 'persist-failed' ? '本机保存失败，请移除后重试' : '未完成登记'}）` }
    }
    if (b.status === 'done') {
      // 已完成批次的再次保存由下方对账路径统一处理（含已删除引导）
    }
    if (!draft || !draft.reportType || !draft.dateKey) {
      return { ok: false, code: 'invalid-draft', message: '请选择报告类型和日期' }
    }
    const epochAtStart = currentEpoch()
    const attachments = [...b.items].sort((a, c) => a.order - c.order)
      .map(i => ({ fileId: i.fileId }))
    const payload = {
      dateKey: draft.dateKey,
      reportType: draft.reportType,
      archiveStatus: draft.archiveStatus || 'unarchived',
      note: draft.note || null,
      attachments
    }
    // 创建意图对账（create-lost）：reportId 是本批次的稳定意图 ID——云端已存在
    // 即此前的创建已确认（响应丢失经 outbox 补发确认），不是"对方冲突"：
    // 以当前版本补交本次表单值完成批次，不得以基线 0 制造冲突或再造报告
    // ── 确定协议（review 终节）：一个批次只创建一份报告；已创建的批次绝不
    // 再提交任何编辑 payload（无"当前 revision+变化字段"——基准是当前云数据
    // 时仍会覆盖他人修改）；草稿变化引导走已有报告的显式编辑（captured baseline）。
    const finishBatch = (draftUsed) => {
      // 完成状态先落盘：失败保留全部本机副本、批次退回待对账（reconciling），
      // 不返回无条件成功——重试保存将按原意图再对账
      b.status = 'done'
      b.draft = draftUsed
      if (!persistBatches(epochAtStart)) {
        b.status = 'reconciling'
        return false
      }
      for (const item of b.items) if (item.savedFilePath) removeLocalCopy(item.savedFilePath)
      familyStore.pullReports().catch(() => {})
      return true
    }
    const existing = familyStore.reports[b.reportId]
    if (existing && existing.deleted) {
      // 报告已被删除：旧批次不得声称可重建已删除报告
      b.status = 'cancelled'
      persistBatches(epochAtStart)
      return { ok: false, code: 'report-deleted', message: '该报告已被删除；如需再次归档请重新上传' }
    }
    if (existing) {
      // 已存在（创建此前已确认——含响应丢失经 outbox 补发）：仅对账确认完成。
      // 无论表单是否变化都不重发；变化保留为未提交草稿并引导显式编辑。
      const intent = b.createIntent && b.createIntentSaved ? b.createIntent : null
      const sameForm = intent
        ? (intent.reportType === payload.reportType && intent.dateKey === payload.dateKey &&
           intent.archiveStatus === payload.archiveStatus && (intent.note || null) === (payload.note || null))
        : (existing.reportType === payload.reportType && existing.dateKey === payload.dateKey)
      const persistedDone = finishBatch(draft)
      if (!persistedDone) {
        return { ok: true, replayed: true, record: existing, warning: '批次完成状态未能落盘，本机原件已保留；重试保存可完成对账' }
      }
      if (sameForm) {
        return { ok: true, replayed: true, record: existing }
      }
      return {
        ok: true, replayed: true, record: existing, draftChanged: true,
        message: '报告此前已创建；本次表单变化未提交，请在报告详情中编辑（按编辑基线处理冲突）'
      }
    }
    // 首次创建：不可变 createIntent 必须【先成功落盘】——落盘失败是阻断门：
    // 回滚本机意图状态、保留原件、不发任何请求
    if (!b.createIntentSaved) {
      b.createIntent = payload
      b.createIntentSaved = true
      if (!persistBatches(epochAtStart)) {
        b.createIntent = null
        b.createIntentSaved = false
        return { ok: false, code: 'intent-persist-failed', message: '创建意图写入本机失败，已停止发送（原件已保留），请重试' }
      }
    }
    const r = await familyStore.saveReport(b.reportId, b.createIntent, 0)
    if (currentEpoch() !== epochAtStart) return { ok: false, code: 'stale-session' }
    if (r.ok) {
      const persistedDone = finishBatch(draft)
      if (!persistedDone) {
        return { ok: true, record: r.record, warning: '创建成功但完成状态未能落盘，本机原件已保留；重试保存可完成对账' }
      }
    }
    return r
    if (r.ok) {
      b.status = 'done'
      b.draft = draft
      for (const item of b.items) removeLocalCopy(item.savedFilePath) // 登记完成，本机副本可清
      persistBatches()
      familyStore.pullReports().catch(() => {})
    }
    return r
  }

  // 恢复入口：仅原始成员可恢复；按完整 items 原槽位/顺序重建批次
  //（persist-failed 槽位保留并继续阻断"完整"），不再 saveFile
  async function recoverFromSavedPaths() {
    const rec = lastRecovery.value
    if (!rec || !Array.isArray(rec.items) || rec.items.length === 0) return { ok: false, code: 'no-recovery' }
    if (!recoveryIdentityMatches(rec)) return { ok: false, code: 'recovery-owner-mismatch', message: '恢复信息属于其他成员' }
    const epochAtStart = currentEpoch()
    // 恢复记录可能指向【原批次】（重选中断）：合并回原 batchId/reportId，
    // 保留未动项的登记状态与顺序——不产生同 reportId 的竞争批次
    const restoreBatchId = rec.batchId && batches.value[rec.batchId] ? rec.batchId : newId('rptb')
    const prevBatch = batches.value[restoreBatchId]
    const batchId = restoreBatchId
    const reportId = rec.reportId || (prevBatch && prevBatch.reportId) || newId('rpt')
    const items = rec.items.map(it => {
      const prevItem = prevBatch && prevBatch.items.find(p => p.order === it.order)
      // 未动槽位沿用原批次现状（已登记不重复上传）；失败/新副本槽位按恢复状态重建
      if (prevItem && prevItem.state === 'registered' && it.state !== 'persist-failed') {
        return { ...prevItem }
      }
      return {
        order: it.order,
        uploadId: it.state === 'persist-failed' ? '' : newId('up'),
        savedFilePath: it.savedFilePath || '',
        stageFileID: '', fileId: it.fileId || '',
        state: it.state === 'persist-failed' ? 'persist-failed' : (it.fileId ? 'registered' : 'pending'),
        error: it.error || ''
      }
    })
    batches.value = { ...batches.value, [batchId]: {
      batchId, reportId, status: 'uploading', items,
      draft: (prevBatch && prevBatch.draft) || null,
      createIntent: (prevBatch && prevBatch.createIntent) || null,
      createIntentSaved: (prevBatch && prevBatch.createIntentSaved) || false,
      createdAt: (prevBatch && prevBatch.createdAt) || Date.now(), updatedAt: Date.now()
    } }
    if (!persistBatches(epochAtStart)) {
      const { [batchId]: _drop2, ...rest2 } = batches.value
      void _drop2
      batches.value = rest2
      return { ok: false, code: 'manifest-persist-failed', message: '清单仍无法写入，原件已保留' }
    }
    lastRecovery.value = null
    clearPersistedRecovery()
    // 完成的恢复从内存 map 移除——切走再切回不复活已处理条目
    if (rec.memberId && memoryRecoveryByMember.has(rec.memberId)) {
      const mapped = memoryRecoveryByMember.get(rec.memberId)
      if (mapped && mapped.reportId === reportId) memoryRecoveryByMember.delete(rec.memberId)
    }
    if (currentEpoch() !== epochAtStart) return { ok: true, batchId, reportId, started: false }
    const processing_ = processBatch(batchId)
    return { ok: true, batchId, reportId, started: true, processing: processing_ }
  }
  // 放弃：仅原始成员；只清理本成员的可恢复原件与持久恢复态
  function discardRecovery() {
    const rec = lastRecovery.value
    if (!rec) return { ok: false }
    if (!recoveryIdentityMatches(rec)) return { ok: false, code: 'recovery-owner-mismatch' }
    // 先持久确认放弃（标记 cancelled），失败保留原件并明确可重试
    rec.cancelled = true
    if (!persistRecovery(rec)) {
      // 持久确认失败：恢复 rec.cancelled=false，保留 lastRecovery 与内存 map
      // 以及原件——唯一恢复句柄不因写盘失败丢失；返回失败供重试
      rec.cancelled = false
      return { ok: false, code: 'persist-failed', message: '放弃状态写入失败，原件与恢复信息已保留，请重试' }
    }
    for (const it of rec.items) {
      if (it.savedFilePath) removeLocalCopy(it.savedFilePath)
    }
    lastRecovery.value = null
    clearPersistedRecovery()
    // 放弃同样从内存 map 清除——切走再切回不复活已放弃条目
    if (rec.memberId && memoryRecoveryByMember.has(rec.memberId)) {
      const mapped = memoryRecoveryByMember.get(rec.memberId)
      if (mapped && mapped.reportId === rec.reportId) memoryRecoveryByMember.delete(rec.memberId)
    }
    return { ok: true }
  }

  // 编辑期草稿持久化：批次表单/已有报告编辑表单变更即落盘（成员命名空间），
  // 冷启动恢复（onLoad 已读批次 draft；已有报告编辑草稿经 editDraft 读回）
  function persistBatchDraft(batchId, draft) {
    const b = batches.value[batchId]
    if (!b || b.status === 'done' || b.status === 'cancelled') return false
    b.draft = draft
    return persistBatches()
  }
  function persistEditDraft(reportId, draft, baselineRevision) {
    if (!sessionReady()) return false
    const prev = (getMemberCache('b2b2-edit-drafts') || {})
    // 保存编辑时 baseline：恢复时不得以最新云 revision 替换用户打开时的基线
    const next = { ...prev, [reportId]: { ...draft, baselineRevision, at: Date.now() } }
    return setMemberCache('b2b2-edit-drafts', next)
  }
  function readEditDraft(reportId) {
    if (!sessionReady()) return null
    const all = getMemberCache('b2b2-edit-drafts') || {}
    return all[reportId] || null
  }
  // 成功提交后清除草稿（避免旧草稿反复覆盖新数据）
  function clearEditDraft(reportId) {
    if (!sessionReady()) return
    const prev = (getMemberCache('b2b2-edit-drafts') || {})
    if (!(reportId in prev)) return
    const next = { ...prev }
    delete next[reportId]
    setMemberCache('b2b2-edit-drafts', next)
  }

  return {
    batches, activeBatches, uploadPolicy, processing, lastRecovery,
    persistBatchDraft, persistEditDraft, readEditDraft, clearEditDraft,
    recoverFromSavedPaths, discardRecovery, recoveryIdentityMatches,
    batch, refreshUploadPolicy, loadPersisted,
    createBatchFromTempPaths, processBatch, retryBatch,
    restageItem, discardItem, discardBatch, replaceItemSlot,
    createReportFromBatch
  }
})
