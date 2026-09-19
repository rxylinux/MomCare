<template>
	<view class="page">
		<NavBar title="旧数据来源预览" theme="dark" transparent :showBack="true" />
		<scroll-view scroll-y class="scroll-content">

			<!-- 未确认/演示态 -->
			<view v-if="dataSource !== 'family'" class="notice-card">
				<text class="notice-title">需要已确认的正式身份</text>
				<text class="notice-desc">旧数据来源预览与迁移需要已确认的家庭成员身份。请先在「我的 → 家庭共享（云）」确认身份。</text>
			</view>

			<template v-else>
				<!-- 扫描入口 -->
				<view v-if="!hasScanned" class="scan-card" @tap="doScan">
					<text class="scan-icon">🔍</text>
					<view class="scan-body">
						<text class="scan-title">扫描本机旧数据</text>
						<text class="scan-desc">只读取白名单业务键（健康/报告/待产包及已有备份），不读取登录信息或其他存储内容</text>
					</view>
				</view>

				<!-- 扫描结果：逐来源 -->
				<template v-if="hasScanned">
					<text class="section-title">来源列表</text>
					<view v-for="(src, key) in migrationStore.scanResult" :key="key" class="source-card" :class="{ 'source-error': src.status !== 'ok' && src.status !== 'empty' }">
						<view class="source-header">
							<text class="source-key">{{ key }}</text>
							<text class="source-status" :class="'st-' + src.status">{{ statusLabel(src.status) }}</text>
						</view>
						<text v-if="src.error" class="source-error-text">{{ src.error }}</text>
						<text v-else-if="src.status === 'ok'" class="source-count">{{ src.entities.length }} 条可预览实体{{ src.isBackup ? '（备份）' : '' }}</text>
					</view>

					<!-- 实体预览（逐条选择） -->
					<template v-if="previewList.length > 0">
						<text class="section-title">实体预览（{{ previewList.length }} 条）——勾选要迁移的条目</text>
						<view v-for="(e, idx) in previewList" :key="e.sourceId" class="entity-card" :class="{ 'entity-selected': selections[e.sourceId] }" @tap="toggleEntity(e)">
							<view class="entity-check" :class="{ 'entity-checked': selections[e.sourceId] }">
								<text v-if="selections[e.sourceId]" class="entity-tick">✓</text>
							</view>
							<view class="entity-body">
								<view class="entity-header">
									<text class="entity-domain">{{ domainLabel(e.domain) }}</text>
									<text v-if="e.isPrivate" class="entity-private">私人</text>
									<text class="entity-key">{{ e.entityKey }}</text>
								</view>
								<text class="entity-fields">{{ fieldsSummary(e) }}</text>
								<view v-for="w in e.warnings" :key="w" class="entity-warning">
									<text class="warning-text">⚠ {{ w }}</text>
								</view>
								<text v-if="e.isPrivate" class="entity-private-hint">含私人字段（心情/症状/备注/计划）——仅本人确认后迁入本人私人域</text>
								<text v-if="e.sourceKeys && e.sourceKeys.length > 1" class="entity-sources">来源：{{ e.sourceKeys.join('、') }}</text>
							</view>
						</view>

						<!-- 私人字段确认（仅本人） -->
						<view v-if="hasPrivateSelected" class="private-confirm-card">
							<text class="private-title">私人字段确认</text>
							<text class="private-desc">您勾选的条目包含私人字段（心情/症状/备注/计划）。这些字段仅迁入您的私人域，不会共享给另一位成员。确认这些私人内容的作者是您本人？</text>
							<view class="private-actions">
								<view class="p-btn" :class="{ 'p-btn-active': privateConfirmed }" @tap="privateConfirmed = !privateConfirmed">
									<text class="p-btn-text">{{ privateConfirmed ? '✓ 已确认本人' : '确认本人作者' }}</text>
								</view>
							</view>
						</view>

						<!-- 确认并生成迁移批次 -->
						<view class="confirm-btn" :class="{ 'confirm-disabled': !canConfirm }" @tap="doConfirm">
							<text class="confirm-text">{{ selectedCount > 0 ? `确认迁移 ${selectedCount} 条` : '请先勾选条目' }}</text>
						</view>
					</template>
				</template>

				<!-- 附件恢复入口：逐槽展示全部待恢复原件 -->
				<template v-if="dataSource === 'family' && attachmentRecoveries.length > 0">
					<view class="recovery-card">
						<text class="recovery-title">{{ attachmentRecoveries.length }} 个中断原件待恢复</text>
						<view v-for="rec in attachmentRecoveries" :key="rec.batchId + '|' + rec.entityOpId + '|' + rec.order" class="rec-item">
							<text class="rec-desc">{{ rec.message }}{{ rec.persisted ? '' : '（内存中，重启后丢失）' }}</text>
							<view class="rec-btn" @tap="doRecoverRecord(rec)">
								<text class="rec-btn-t">恢复第{{ rec.order + 1 }}页</text>
							</view>
						</view>
					</view>
				</template>

				<!-- 批次执行 -->
				<template v-if="migrationStore.batch">
					<text class="section-title">迁移批次 {{ migrationStore.batch.batchId }}</text>
					<view class="batch-card">
						<text class="batch-status">状态：{{ migrationStore.batch.status }}</text>
						<view v-for="(e, i) in migrationStore.batch.entities" :key="e.operationId" class="batch-entity">
							<text class="be-domain">{{ domainLabel(e.targetDomain) }}</text>
							<text class="be-status" :class="'bes-' + e.status">{{ e.status }}</text>
							<text v-if="e.error" class="be-error">{{ e.error }}</text>
							<!-- 附件槽位列表与重选入口 -->
							<view v-for="att in (e.attachments || [])" :key="att.order" class="att-row">
								<text class="att-label">第{{ att.order + 1 }}页</text>
								<text class="att-status" :class="attClass(att)">
									{{ attStatus(att) }}
								</text>
								<view v-if="!att.fileId && !e.reportIntent?.mayHaveBeenSent && e.status !== 'done' && e.status !== 'conflict' && e.status !== 'reconciling'" class="att-btn" @tap="doReselect(migrationStore.batch.batchId, e.operationId, att.order)">
									<text class="att-btn-t">重选原件</text>
								</view>
								<view v-if="att.reselected && att.needsConfirm" class="att-btn att-btn-confirm" @tap="doConfirmReselect(migrationStore.batch.batchId, e.operationId, att.order)">
									<text class="att-btn-t">确认替换</text>
								</view>
								<view v-if="att.reselected && att.needsConfirm" class="att-btn att-btn-cancel" @tap="doCancelReselect(migrationStore.batch.batchId, e.operationId, att.order)">
									<text class="att-btn-t">取消</text>
								</view>
							</view>
						</view>
						<view v-if="migrationStore.batch.status !== 'done'" class="exec-btn" @tap="doExecute">
							<text class="exec-text">{{ migrationStore.batch.status === 'partial' ? '继续处理' : '执行迁移' }}</text>
						</view>
					</view>
				</template>

				<!-- 归档批次（源变化后不再可执行的旧批次）——用户可达可恢复，非只写 -->
				<template v-if="dataSource === 'family' && archivedBatches.length > 0">
					<text class="section-title">归档迁移批次（{{ archivedBatches.length }}）</text>
					<view v-for="ab in archivedBatches" :key="ab.batchId" class="arch-card">
						<text class="arch-line">{{ archTime(ab.confirmedAt) }} · {{ ab.entities.length }} 条 · {{ ab.status }}</text>
						<text class="arch-domains">{{ archDomains(ab) }}</text>
						<text class="arch-note">源数据已变化的旧批次。设为当前批次后仍受来源校验约束；当前批次会先无损归档。</text>
						<view class="arch-btn" @tap="doRestoreArchive(ab.batchId)">
							<text class="arch-btn-t">设为当前批次</text>
						</view>
					</view>
				</template>
			</template>

			<view class="bottom-spacer"></view>
		</scroll-view>
	</view>
</template>

<script setup>
import { ref, computed } from 'vue'
import NavBar from '@/components/NavBar.vue'
import { getSessionState, subscribeSession, isExplicitDemo, isExplicitLoggedOut } from '@/services/sessionService.js'
import { useMigrationStore } from '@/services/migrationStore.js'
import { useFamilyStore } from '@/services/familyStore.js'
import { persistLocalCopy, uploadSingleFile } from '@/services/fileUploadService.js'

const migrationStore = useMigrationStore()
const familyStore = useFamilyStore()

const dataSource = ref(isExplicitDemo() ? 'demo' : (getSessionState().status === 'confirmed' && !isExplicitLoggedOut() ? 'family' : 'prompt'))
import { watch } from 'vue'
watch(subscribeSession(), () => {
  dataSource.value = isExplicitDemo() ? 'demo' : (getSessionState().status === 'confirmed' && !isExplicitLoggedOut() ? 'family' : 'prompt')
  // 身份变化清空选择与私人确认（不保留上一身份的确认状态）
  selections.value = {}
  privateConfirmed.value = false
})

const hasScanned = computed(() => Object.keys(migrationStore.scanResult).length > 0)
const previewList = computed(() => migrationStore.previewEntities)
const selections = ref({})
const privateConfirmed = ref(false)
const selectedCount = computed(() => Object.values(selections.value).filter(Boolean).length)
const hasPrivateSelected = computed(() => previewList.value.some(e => selections.value[e.sourceId] && e.isPrivate))
const canConfirm = computed(() => selectedCount.value > 0 && (!hasPrivateSelected.value || privateConfirmed.value))

async function doScan() {
  await migrationStore.scanSources()
}
function toggleEntity(e) {
  selections.value = { ...selections.value, [e.sourceId]: !selections.value[e.sourceId] }
}
function statusLabel(s) {
  return { ok: '可预览', empty: '无数据', 'read-failed': '读取失败', 'parse-failed': '格式损坏', 'unknown-schema': '未知格式' }[s] || s
}
function domainLabel(d) {
  return { daily: '日健康', report: '报告', bag: '待产包', mood: '私人心情/备注', pregnancy: '孕期资料', checkup: '产检安排' }[d] || d
}
function fieldsSummary(e) {
  const parts = []
  if (e.fields.weightKg !== undefined) parts.push(`体重 ${e.fields.weightKg}kg`)
  if (e.fields.systolic) parts.push(`血压 ${e.fields.systolic}/${e.fields.diastolic}`)
  if (e.fields.fetalCount !== undefined) parts.push(`胎动 ${e.fields.fetalCount}`)
  if (e.fields.reportType) parts.push(`类型 ${e.fields.reportType}`)
  if (e.fields.dateKey) parts.push(`日期 ${e.fields.dateKey}`)
  if (e.fields.name) parts.push(e.fields.name)
  if (e.fields.hospital) parts.push(`医院 ${e.fields.hospital}`)
  if (e.fields.lmpDate) parts.push(`末次月经 ${e.fields.lmpDate}`)
  if (e.fields.nickname) parts.push(`昵称 ${e.fields.nickname}`)
  if (e.fields.examItems && e.fields.examItems.length) parts.push(`${e.fields.examItems.length} 个检查项`)
  if (e.fields.note) parts.push(`备注（共享）${String(e.fields.note).slice(0, 20)}`)
  if (e.fields.attachments && e.fields.attachments.length) parts.push(`${e.fields.attachments.length} 附件`)
  // 私人内容可见（用户能判断所确认的范围）——显示实际内容而非仅计数
  if (e.privateFields) {
    if (e.privateFields.mood) parts.push(`心情 ${e.privateFields.mood}`)
    if (e.privateFields.note) parts.push(`私人备注 ${String(e.privateFields.note).slice(0, 20)}`)
    if (e.privateFields.symptoms && e.privateFields.symptoms.length) parts.push(`症状 ${e.privateFields.symptoms.map(s => String(s).slice(0, 20)).join('、')}`)
    if (e.privateFields.plans && e.privateFields.plans.length) parts.push(`计划 ${e.privateFields.plans.map(s => String(s).slice(0, 20)).join('、')}`)
  }
  return parts.join(' · ') || '（无字段）'
}

async function doConfirm() {
  if (!canConfirm.value) return
  const sels = previewList.value
    .filter(e => selections.value[e.sourceId])
    .map(e => ({
      sourceId: e.sourceId, domain: e.domain, entityKey: e.entityKey,
      fields: e.fields, privateFields: e.privateFields,
      includePrivate: privateConfirmed.value
    }))
  const r = await migrationStore.confirmEntities(sels)
  if (r.ok) {
    uni.showToast({ title: `已确认 ${sels.length} 条，批次已持久`, icon: 'none' })
    selections.value = {}
    privateConfirmed.value = false
  } else {
    uni.showToast({ title: r.message || '确认失败', icon: 'none', duration: 2500 })
  }
}

function attClass(att) {
  if (att.fileId) return 'att-ok'
  if (att.missing) return 'att-missing'
  if (att.reselected) return 'att-reselect'
  return ''
}
function attStatus(att) {
  if (att.reselected) return att.needsConfirm ? '已重选(待确认)' : '已重选(已确认)'
  if (att.fileId) return '已登记'
  if (att.missing) return '缺失'
  if (att.localPath) return '待上传'
  return '无原件'
}
const attachmentRecovery = computed(() => {
  // 响应式派生：依赖 store 的 storageListRevision（恢复记录创建/消费/身份变化失效重算）
  return migrationStore.attachmentRecoveryLatest
})
// 全部待恢复槽位（逐目标最新）——逐槽展示，不因只显示一条而让其他原件找不到入口
const attachmentRecoveries = computed(() => {
  return migrationStore.attachmentRecoveriesList
})
function doRecoverRecord(rec) {
  if (!rec || rec.batchId === undefined || rec.entityOpId === undefined || rec.order === undefined) return
  const r = migrationStore.recoverAttachment(rec.batchId, rec.entityOpId, rec.order)
  if (r.ok) uni.showToast({ title: '已恢复到原槽位，请确认映射', icon: 'none' })
  else uni.showToast({ title: r.message || '恢复失败', icon: 'none', duration: 2500 })
}
async function doReselect(batchId, entityOpId, order) {
  const r = await migrationStore.reselectAttachment(batchId, entityOpId, order)
  if (r.ok) {
    uni.showToast({ title: '已选择新原件，请确认替换', icon: 'none' })
  } else if (r.code === 'cancelled') {
    // 用户取消——保留原状态，不报错
  } else if (r.code === 'entity-finalized') {
    uni.showToast({ title: r.message, icon: 'none', duration: 3000 })
  } else if (r.code === 'persist-failed' || r.code === 'manifest-persist-failed') {
    uni.showToast({ title: r.message || '写入失败，新图片已保留', icon: 'none', duration: 3000 })
  } else if (r.code !== 'stale-session') {
    uni.showToast({ title: r.message || r.code || '重选失败', icon: 'none', duration: 2500 })
  }
}
function doConfirmReselect(batchId, entityOpId, order) {
  const r = migrationStore.confirmReselect(batchId, entityOpId, order)
  if (r.ok) uni.showToast({ title: '已确认替换', icon: 'none' })
  else uni.showToast({ title: r.message || '确认失败', icon: 'none', duration: 2500 })
}
function doCancelReselect(batchId, entityOpId, order) {
  const r = migrationStore.cancelReselect(batchId, entityOpId, order)
  if (r.ok) uni.showToast({ title: '已取消重选', icon: 'none' })
  else uni.showToast({ title: r.message || '取消失败', icon: 'none', duration: 2500 })
}

// ── 归档批次（源变化后归档的旧批次）：展示与显式恢复入口 ──
// 响应式派生：依赖 store 的 storageListRevision（归档/恢复/身份家庭变化失效重算）
const archivedBatches = computed(() => migrationStore.archivedBatchesList)
function archTime(ts) {
  if (!ts) return '未知时间'
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function archDomains(ab) {
  const counts = {}
  for (const e of ab.entities) counts[e.targetDomain] = (counts[e.targetDomain] || 0) + 1
  return Object.entries(counts).map(([d, n]) => `${domainLabel(d)}×${n}`).join('、') || '（无实体）'
}
function doRestoreArchive(batchId) {
  const r = migrationStore.restoreArchivedBatch(batchId)
  if (r.ok) {
    uni.showToast({ title: r.duplicate ? '已设为当前批次（归档仍保留一份副本）' : '已设为当前批次', icon: 'none', duration: r.duplicate ? 3000 : 1500 })
  } else {
    uni.showToast({ title: r.message || '恢复失败', icon: 'none', duration: 2500 })
  }
}

async function doExecute() {
  // 真实 executor：按领域走 familyStore outbox（稳定 operationId）
  const { currentEpoch: epochNow, openRecoveryScope: openScope } = await import('@/services/sessionService.js')
  const executor = async (entity) => {
    const execEpoch = epochNow()
    // batchId 与恢复作用域一样在操作开始时捕获——切换后 store 会清空
    // 当前批次，迟到 continuation 不得因此丢失恢复记录的批次绑定
    const batchIdAtStart = migrationStore.batch ? migrationStore.batch.batchId : ''
    // 附件恢复作用域在操作开始时捕获（发起成员）——切换后迟到写入只落原成员
    const attRecoveryScope = openScope('b3-migration-recovery')
    if (entity.targetDomain === 'pregnancy') {
      // 孕期资料：保存真实支持字段（lmpDate/dueDate/hospital/babyNickname/nickname）
      const { useFamilyStore: _uf } = await import('@/services/familyStore.js')
      void _uf
      return familyStore.savePregnancy(entity.payload, entity.expectedRevision, entity.operationId)
    } else if (entity.targetDomain === 'checkup') {
      // 产检：status 走 saveCheckup 的 status 参数；note 不是 mc-schedule 支持字段（隔离）
      const { status, note, ...rest } = entity.payload
      void note // 未支持内容留原始隔离（确认页已说明）
      return familyStore.saveCheckup(entity.targetId, rest, status || 'pending', entity.expectedRevision, undefined, 'template', entity.operationId)
    } else if (entity.targetDomain === 'daily') {
      return familyStore.saveDaily(entity.entityKey, entity.payload, entity.expectedRevision, entity.operationId)
    } else if (entity.targetDomain === 'report') {
      // 附件先经受控文件协议上传
      const attachments = []
      let attFailed = false
      let attFailMsg = ''
      // 未确认的重选替换不得继续上传（阻止整个报告提交）
      const unconfirmed = (entity.attachments || []).filter(a => a.reselected && a.needsConfirm)
      if (unconfirmed.length > 0) {
        return { ok: false, code: 'reselect-unconfirmed', message: '有重选的原件待确认替换——请先确认或取消' }
      }
      for (const att of (entity.attachments || [])) {
        if (!att.localPath || att.missing) {
          attFailed = true
          attFailMsg = `附件${att.order}缺失或不可读——报告不完整，不上传`
          continue
        }
        // 已登记项用原 fileId 对账——不重复上传
        if (att.fileId) {
          attachments.push({ fileId: att.fileId })
          continue
        }
        // uploadId 已在确认时分配并持久化（批次清单中）——不再生成新 ID
        let uploadPath = att.localPath
        // tmp:// 会话级 AND wxfile:// 微信运行时临时路径都需转 uni.saveFile 持久副本。
        // wxfile:// 前缀不保证路径持久——只有经 persistLocalCopy 保存的 store:// 路径
        // 才在清单中可恢复。转换后回写槽位并先持久化清单——磁盘可见才发网络。
        // await 后立即核对发起 epoch（saveFile 挂起期间切换，旧 continuation 不得
        // 以新成员身份调用 persistBatchNow/uploadSingleFile/saveReport）
        if (uploadPath.startsWith('tmp://') || uploadPath.startsWith('wxfile://')) {
          const dc = await persistLocalCopy(uploadPath)
          if (epochNow() !== execEpoch) {
            // 切换后：新副本已落盘——写原成员作用域恢复记录（持久失败→内存兜底）
            if (dc.ok) {
              migrationStore.recordAttachmentRecovery(attRecoveryScope, {
                batchId: batchIdAtStart,
                entityOpId: entity.operationId, order: att.order,
                savedFilePath: dc.path,
                message: '副本持久化期间会话切换，新原件已保存可恢复', at: Date.now()
              })
            }
            return { ok: false, code: 'stale-session', message: '会话已切换，上传已终止' }
          }
          if (!dc.ok) {
            attFailed = true
            attFailMsg = `附件${att.order}无法持久保存新副本`
            continue
          }
          att.localPath = dc.path
          uploadPath = dc.path
          if (!migrationStore.persistBatchNow(execEpoch)) {
            // 清单写不进：已保存副本不可遗失——写恢复记录（原成员作用域）供找回
            migrationStore.recordAttachmentRecovery(attRecoveryScope, {
              batchId: batchIdAtStart,
              entityOpId: entity.operationId, order: att.order,
              savedFilePath: dc.path,
              message: '持久路径写入清单失败，新原件已保存可恢复', at: Date.now()
            })
            attFailed = true
            attFailMsg = `附件${att.order}持久路径写入清单失败`
            continue
          }
        }
        const up = await uploadSingleFile({ uploadId: att.uploadId, savedFilePath: uploadPath })
        // 每个 await 后终止旧 continuation（切换后不以新成员身份继续）
        if (epochNow() !== execEpoch) return { ok: false, code: 'stale-session', message: '会话已切换，上传已终止' }
        if (up.ok) {
          att.fileId = up.fileId
          attachments.push({ fileId: up.fileId })
          // 登记结果立即持久化（下一页上传前）——中途崩溃/写失败后
          // 冷重启不重复二进制上传已登记页（fileId 即对账凭据）。
          // 写失败必须【立即停止】：进度未落盘时继续上传下一页会让
          // 磁盘状态与云端副作用脱节（重试无法对账）
          if (!migrationStore.persistBatchNow(execEpoch)) {
            return { ok: false, code: 'progress-persist-failed', message: `附件${att.order}登记结果写入失败——已停止，重试不会重复上传已登记页` }
          }
        } else {
          attFailed = true
          attFailMsg = `附件${att.order}上传失败（${up.code}）——报告不完整，不上传`
        }
      }
      // 部分附件失败 → 阻止不完整报告创建（不伪造成功）
      if (attFailed || attachments.length !== (entity.attachments || []).length) {
        return { ok: false, code: 'attachment-incomplete', message: attFailMsg || '附件不完整——报告不上传' }
      }
      if (epochNow() !== execEpoch) return { ok: false, code: 'stale-session', message: '会话已切换，上传已终止' }
      // 不可变报告意图：首次提交前持久化快照——可能已提交后重放原意图，不改字段/换图。
      // 持久化失败不发 saveReport（无 durable mayHaveBeenSent 标记时不知道是否已提交）
      if (!entity.reportIntent) {
        entity.reportIntent = {
          payload: JSON.parse(JSON.stringify(entity.payload)),
          attachments: JSON.parse(JSON.stringify(attachments)),
          expectedRevision: entity.expectedRevision,
          operationId: entity.operationId,
          mayHaveBeenSent: false
        }
        if (!migrationStore.persistBatchNow(execEpoch)) {
          delete entity.reportIntent
          return { ok: false, code: 'intent-persist-failed', message: '报告意图写入失败，未发送，请重试' }
        }
      }
      // 标记可能已提交（durable）——标记落盘失败则不发 saveReport：
      // 丢失响应后无法区分"已提交"与"未提交"，无 durable 标记时重试可能导致重复提交
      if (!entity.reportIntent.mayHaveBeenSent) {
        entity.reportIntent.mayHaveBeenSent = true
        if (!migrationStore.persistBatchNow(execEpoch)) {
          entity.reportIntent.mayHaveBeenSent = false // 回滚标记（尚未发送）
          return { ok: false, code: 'intent-marker-persist-failed', message: '发送标记写入失败，报告未发送——请重试' }
        }
      }
      const payload = { ...entity.reportIntent.payload, attachments: entity.reportIntent.attachments }
      delete payload.private
      return familyStore.saveReport(entity.targetId, payload, entity.reportIntent.expectedRevision, entity.reportIntent.operationId)
    } else if (entity.targetDomain === 'bag') {
      return familyStore.saveBagItem(entity.targetId, entity.payload, entity.expectedRevision, entity.operationId)
    } else if (entity.targetDomain === 'mood') {
      // 私人域——仅本人（服务端 ACL）
      const privateData = entity.payload.private || {}
      const dateKey = entity.entityKey || entity.sourceId.split(':').pop()
      return familyStore.saveMood(entity.entityKey, {
        mood: privateData.mood, symptoms: privateData.symptoms, note: privateData.note, plans: privateData.plans
      }, entity.expectedRevision, entity.operationId)
    }
    return { ok: false, code: 'unknown-domain' }
  }
  const r = await migrationStore.executeBatch(executor)
  if (r.stats) {
    uni.showToast({ title: `完成 ${r.stats.done}，冲突 ${r.stats.conflict}，失败 ${r.stats.failed}`, icon: 'none', duration: 3000 })
  } else if (r.code === 'stale-session') {
    uni.showToast({ title: r.message || '会话已切换，批次保留可续传', icon: 'none', duration: 2500 })
  } else if (r.code === 'source-changed') {
    uni.showToast({ title: r.message || '源数据已变化，请重新预览确认', icon: 'none', duration: 3000 })
  } else if (r.code === 'persist-failed') {
    uni.showToast({ title: r.message || '本机写入失败，进度已保留可重试', icon: 'none', duration: 3000 })
  } else if (r.code === 'backup-failed') {
    uni.showToast({ title: r.message || '备份写入失败，请清理空间后重试', icon: 'none', duration: 3000 })
  } else if (r.code === 'busy') {
    // already executing
  } else if (r.code && r.message) {
    uni.showToast({ title: r.message, icon: 'none', duration: 3000 })
  }
}
</script>

<style scoped lang="scss">
.page { display: flex; flex-direction: column; height: 100vh; background: #FBF7F2; }
.scroll-content { flex: 1; }
.notice-card { margin: 24rpx; padding: 32rpx; background: #FFF; border-radius: 24rpx; }
.notice-title { font-size: 28rpx; font-weight: 600; color: #1C1A17; display: block; margin-bottom: 8rpx; }
.notice-desc { font-size: 24rpx; color: #757575; line-height: 1.6; }
.scan-card { margin: 24rpx; padding: 32rpx; background: #FFF; border-radius: 24rpx; display: flex; align-items: center; gap: 20rpx; }
.scan-icon { font-size: 48rpx; }
.scan-body { flex: 1; }
.scan-title { font-size: 28rpx; font-weight: 600; color: #1C1A17; display: block; }
.scan-desc { font-size: 22rpx; color: #9C9890; margin-top: 4rpx; display: block; line-height: 1.5; }
.section-title { display: block; padding: 20rpx 28rpx 12rpx; font-size: 26rpx; font-weight: 600; color: #1C1A17; }
.source-card { margin: 0 28rpx 12rpx; padding: 20rpx; background: #FFF; border-radius: 16rpx; }
.source-error { border: 2rpx solid #E8637A; }
.source-header { display: flex; justify-content: space-between; align-items: center; }
.source-key { font-size: 24rpx; font-weight: 500; color: #4A4844; word-break: break-all; }
.source-status { font-size: 20rpx; padding: 4rpx 12rpx; border-radius: 8rpx; }
.st-ok { background: #EAF7EF; color: #3A8C5A; }
.st-empty { background: #F2F0EE; color: #9C9890; }
.st-read-failed, .st-parse-failed, .st-unknown-schema { background: #FDEEF1; color: #C0405A; }
.source-error-text { font-size: 22rpx; color: #C0405A; margin-top: 8rpx; display: block; }
.source-count { font-size: 22rpx; color: #6E6A64; margin-top: 8rpx; display: block; }
.entity-card { margin: 0 28rpx 12rpx; padding: 20rpx; background: #FFF; border-radius: 16rpx; display: flex; gap: 16rpx; border: 2rpx solid transparent; }
.entity-selected { border-color: #C98A3A; background: #FFFBF5; }
.entity-check { width: 40rpx; height: 40rpx; border-radius: 10rpx; border: 3rpx solid #E4E1DC; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
.entity-checked { background: #C98A3A; border-color: #C98A3A; }
.entity-tick { font-size: 22rpx; color: #FFF; font-weight: 700; }
.entity-body { flex: 1; min-width: 0; }
.entity-header { display: flex; align-items: center; gap: 12rpx; margin-bottom: 6rpx; flex-wrap: wrap; }
.entity-domain { font-size: 22rpx; font-weight: 600; color: #C98A3A; }
.entity-private { font-size: 20rpx; background: #FDEEF1; color: #C0405A; padding: 2rpx 10rpx; border-radius: 8rpx; }
.entity-key { font-size: 22rpx; color: #9C9890; }
.entity-fields { font-size: 22rpx; color: #4A4844; line-height: 1.5; display: block; }
.entity-warning { margin-top: 4rpx; }
.warning-text { font-size: 20rpx; color: #C0405A; }
.entity-private-hint { font-size: 20rpx; color: #B07818; margin-top: 6rpx; display: block; }
.entity-sources { font-size: 20rpx; color: #9C9890; margin-top: 4rpx; display: block; }
.private-confirm-card { margin: 20rpx 28rpx; padding: 24rpx; background: #FEF4E3; border-radius: 16rpx; }
.private-title { font-size: 26rpx; font-weight: 600; color: #B07818; display: block; margin-bottom: 8rpx; }
.private-desc { font-size: 22rpx; color: #8C5A10; line-height: 1.6; display: block; }
.private-actions { margin-top: 16rpx; }
.p-btn { display: inline-flex; padding: 12rpx 28rpx; background: #FFF; border-radius: 999rpx; border: 2rpx solid #F0A940; }
.p-btn-active { background: #F0A940; }
.p-btn-text { font-size: 24rpx; color: #B07818; font-weight: 600; }
.confirm-btn { margin: 24rpx 28rpx; padding: 24rpx; background: linear-gradient(135deg, #C98A3A, #F0C878); border-radius: 20rpx; text-align: center; }
.confirm-disabled { opacity: 0.5; }
.confirm-text { font-size: 28rpx; font-weight: 600; color: #FFF; }
.batch-card { margin: 0 28rpx 20rpx; padding: 20rpx; background: #FFF; border-radius: 16rpx; }
.recovery-card { margin: 20rpx 28rpx; padding: 24rpx; background: #F3F8F5; border-radius: 16rpx; }
.recovery-title { font-size: 26rpx; font-weight: 600; color: #3A8C5A; display: block; margin-bottom: 12rpx; }
.rec-item { display: flex; align-items: center; gap: 16rpx; padding: 8rpx 0; }
.rec-desc { flex: 1; font-size: 22rpx; color: #4A4844; line-height: 1.5; }
.rec-btn { padding: 10rpx 24rpx; background: #FFF; border-radius: 999rpx; border: 2rpx solid #3A8C5A; flex-shrink: 0; }
.rec-btn-t { font-size: 22rpx; color: #3A8C5A; font-weight: 600; }
.arch-card { margin: 0 28rpx 12rpx; padding: 20rpx; background: #FFF; border-radius: 16rpx; border: 2rpx dashed #D8D4CC; }
.arch-line { font-size: 24rpx; color: #4A4844; font-weight: 500; display: block; }
.arch-domains { font-size: 22rpx; color: #6E6A64; margin-top: 4rpx; display: block; }
.arch-note { font-size: 20rpx; color: #9C9890; margin-top: 6rpx; display: block; line-height: 1.5; }
.arch-btn { margin-top: 12rpx; padding: 12rpx 28rpx; background: #FFF; border-radius: 999rpx; border: 2rpx solid #8C8478; display: inline-flex; }
.arch-btn-t { font-size: 22rpx; color: #6E6A64; font-weight: 600; }
.batch-status { font-size: 24rpx; font-weight: 600; color: #4A4844; display: block; margin-bottom: 12rpx; }
.batch-entity { display: flex; align-items: center; gap: 12rpx; padding: 8rpx 0; flex-wrap: wrap; }
.be-domain { font-size: 22rpx; color: #6E6A64; }
.be-status { font-size: 20rpx; padding: 2rpx 10rpx; border-radius: 8rpx; }
.bes-done { background: #EAF7EF; color: #3A8C5A; }
.bes-pending { background: #F2F0EE; color: #9C9890; }
.bes-conflict { background: #FEF4E3; color: #B07818; }
.bes-failed { background: #FDEEF1; color: #C0405A; }
.be-error { font-size: 20rpx; color: #C0405A; flex-basis: 100%; }
.exec-btn { margin-top: 16rpx; padding: 20rpx; background: #C98A3A; border-radius: 16rpx; text-align: center; }
.exec-text { font-size: 26rpx; font-weight: 600; color: #FFF; }
.bottom-spacer { height: 60rpx; }
</style>
