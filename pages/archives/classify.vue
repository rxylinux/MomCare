<template>
  <view class="page">
		<!-- family 批次状态与控制（失败重试/重暂存/缺图移除） -->
		<view v-if="famBatch && famBatch.status !== 'done'" class="batch-ctrl">
			<text class="batch-ctrl-title">本批 {{ famBatch.items.length }} 张：{{ famBatch.status === 'ready' ? '全部登记完成，可保存' : famBatch.status === 'partial' ? '部分未完成' : '上传中' }}</text>
			<view v-for="it in famBatch.items" :key="it.order" class="batch-ctrl-row">
				<text class="batch-ctrl-item">第 {{ it.order + 1 }} 张 · {{ it.state === 'registered' ? '已登记' : it.state === 'staged-expired' ? '暂存过期（原件已保留）' : it.state === 'persist-failed' ? '本机保存失败' : it.state === 'failed' ? (it.error || '失败') : '待完成' }}</text>
				<view v-if="it.state === 'failed' || it.state === 'pending'" class="batch-ctrl-btn" @tap="retryFailedItems"><text class="batch-ctrl-btn-t">重试</text></view>
				<view v-if="it.state === 'staged-expired'" class="batch-ctrl-btn" @tap="restageExpiredItem(it.order)"><text class="batch-ctrl-btn-t">重新暂存</text></view>
				<view v-if="it.state === 'persist-failed' || it.state === 'failed'" class="batch-ctrl-btn" @tap="replaceSlot(it.order)"><text class="batch-ctrl-btn-t">重选图片</text></view>
				<view v-if="it.state === 'persist-failed'" class="batch-ctrl-btn batch-ctrl-danger" @tap="removeFailedSlot(it.order)"><text class="batch-ctrl-btn-t">移除</text></view>
			</view>
			<view class="batch-ctrl-abandon" @tap="discardWholeBatch"><text class="batch-ctrl-abandon-t">放弃整批</text></view>
		</view>>
    <!-- NavBar -->
    <NavBar title="确认报告信息" />

    <!-- Content -->
    <scroll-view scroll-y class="scroll">
      <view class="confirm-preview">
        <!-- Preview Image -->
        <view class="confirm-preview-img" @tap="previewImage">
          <image v-if="previewUrl" :src="previewUrl" mode="aspectFit" class="preview-real-img" />
          <text v-else class="preview-icon">📊</text>
          <view v-if="previewUrl" class="preview-zoom-hint">
            <text class="preview-zoom-text">点击查看大图</text>
          </view>
        </view>

        <!-- Form -->
        <view class="confirm-form">
          <!-- Type Grid -->
          <view class="form-label">
            <text class="form-label-text">报告类型</text>
          </view>
          <view class="type-grid">
            <view
              v-for="(t, idx) in typeOptions"
              :key="idx"
              class="type-option"
              :class="{ selected: selectedType === t.key }"
              @tap="selectedType = t.key"
            >
              <text class="type-option-icon">{{ t.icon }}</text>
              <text class="type-option-label" :class="{ 'type-option-label-active': selectedType === t.key }">{{ t.label }}</text>
            </view>
          </view>

          <!-- Date -->
          <view class="form-row">
            <view class="form-label">
              <text class="form-label-text">检查日期</text>
            </view>
            <picker mode="date" :value="reportDate" :end="todayStr" @change="onDateChange">
              <view class="form-input-wrap">
                <text :class="reportDate ? 'form-input-text' : 'form-input-placeholder'">
                  {{ reportDate ? formatDateDisplay(reportDate) : '选择检查日期' }}
                </text>
              </view>
            </picker>
            <text v-if="ocrDateHint" class="form-hint">从报告自动识别，可修改</text>
          </view>

          <!-- Hospital -->
          <view class="form-row">
            <view class="form-label">
              <text class="form-label-text">就诊医院（可选）</text>
            </view>
            <input class="form-input" v-model="hospital" placeholder="输入医院名称" placeholder-class="input-placeholder" />
          </view>

          <!-- Pregnancy Week -->
          <view class="form-row">
            <view class="form-label">
              <text class="form-label-text">当时孕周（可选）</text>
            </view>
            <input class="form-input" v-model="gestationWeek" placeholder="如：12" type="number" placeholder-class="input-placeholder" />
          </view>

          <!-- Notes -->
          <view class="form-row">
            <view class="form-label">
              <text class="form-label-text">备注（可选）</text>
            </view>
            <input class="form-input" v-model="notes" placeholder="添加备注…" placeholder-class="input-placeholder" />
          </view>
        </view>
      </view>
    </scroll-view>

    <!-- Footer -->
    <view class="batch-footer">
      <view class="btn-secondary" @tap="goBack">
        <text class="btn-secondary-text">取消</text>
      </view>
      <view class="btn-primary" :class="{ 'btn-disabled': !canSave }" @tap="save">
        <text class="btn-primary-text">确认保存</text>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import NavBar from '@/components/NavBar.vue'
import { useReportStore, REPORT_TYPES, getTypeInfo } from '@/stores/report'
import { useHealthStore } from '@/stores/health.js'
import { getSessionState, isExplicitDemo, isExplicitLoggedOut, subscribeSession, currentEpoch } from '@/services/sessionService.js'
import { useReportFamilyStore } from '@/services/reportFamilyStore.js'
import { nextTick } from 'vue'
import { useFamilyStore as useFamilyStore2 } from '@/services/familyStore.js'
import { navigateToPage } from '@/utils/navigation.js'
import { fetchReportReadUrls } from '@/services/fileUploadService.js'

const reportStore = useReportStore()
const healthStore = useHealthStore()
const reportFamilyStore = useReportFamilyStore()
const familyStore2 = useFamilyStore2()
const isFamilyMode = () => getSessionState().status === 'confirmed' && !isExplicitDemo() && !isExplicitLoggedOut()
const familyBatchId = ref('')
const editBaseline = ref(null) // 已有报告编辑：打开时捕获基线
import { watch } from 'vue'
watch(subscribeSession(), () => {
  if (!(getSessionState().status === 'confirmed' && !isExplicitDemo() && !isExplicitLoggedOut())) {
    reportId.value = ''
    familyBatchId.value = ''
    editBaseline.value = null
    selectedType.value = ''
    reportDate.value = ''
    hospital.value = ''
    gestationWeek.value = ''
    notes.value = ''
    fileUrls.value = []
    previewUrl.value = ''
  }
})
const typeOptions = REPORT_TYPES

const selectedType = ref('')
const reportDate = ref('')
const hospital = ref('')
const gestationWeek = ref('')
const notes = ref('')
const fileUrls = ref([])
const fileType = ref('image')
const source = ref('p2')  // p2 / p3 / p6
const reportId = ref('')  // 从 P6 进入时传递
const itemIdx = ref('')  // 从 P3 批量页面进入时传递
const serverReportId = ref('')  // 服务端返回的 report_id（上传阶段获得）
const serverImageUrl = ref('')  // 服务端返回的 image_url（上传阶段获得）
const previewUrl = ref('')
const ocrDateHint = ref(false)
const lastDraftId = ref('') // 本地创建落盘失败后记住的草稿 ID，重试复用

const todayStr = computed(() => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})

const canSave = computed(() => {
  return selectedType.value && reportDate.value
})

onLoad((options) => {
  // 如果用户已设置就诊医院，自动填入
  if (healthStore.userInfo.hospital) {
    hospital.value = healthStore.userInfo.hospital
  }

  // 批次 ID 只从 URL（受控导航）或新上传（source=p2）取；p6 编辑模式不回退旧 pendingUpload
  familyBatchId.value = options.batchId ||
    (options.source === 'p2' && reportStore.pendingUpload && reportStore.pendingUpload.batchId) || ''
  if (familyBatchId.value) {
    const b = reportFamilyStore.batch(familyBatchId.value)
    if (b) {
      // 冷启动预览：批次持久清单中的本机原件路径（顺序即附件顺序）
      fileUrls.value = b.items.map(i => i.savedFilePath).filter(Boolean)
      if (!previewUrl.value) previewUrl.value = fileUrls.value[0] || ''
    }
  }

  // 从 store 读取上传数据（避免 URL 参数编码问题）
  // ── family hydrate：已有报告（拉取+表单+预览+基线）/批次（草稿恢复）──
  if (getSessionState().status === 'confirmed' && !isExplicitDemo() && !isExplicitLoggedOut()) {
    if (options.reportId) reportId.value = options.reportId
    if (reportId.value) {
      // 同步 hydrate：store 已有（暖数据）立即填表单+基线；否则拉取后补
      const fill = rec => {
        if (!rec || rec.deleted) return false
        hydrating = true
        editBaseline.value = { id: rec.id, revision: rec.revision || 0 }
        selectedType.value = rec.reportType || ''
        reportDate.value = rec.dateKey || ''
        hospital.value = rec.hospital || ''
        gestationWeek.value = rec.weekOfPregnancy != null ? String(rec.weekOfPregnancy) : ''
        notes.value = rec.note || ''
        nextTick(() => { hydrating = false }) // watch flush:pre 在下一 tick——同步复位太早
        return true
      }
      const applyEditDraft = () => {
        const ed = reportFamilyStore.readEditDraft(reportId.value)
        if (ed) {
          hydrating = true
          // 字段存在性恢复：空串=用户显式清空（合法意图），不是"未设置"
          if (ed.reportType !== undefined && ed.reportType !== null) selectedType.value = ed.reportType
          if (ed.dateKey !== undefined && ed.dateKey !== null) reportDate.value = ed.dateKey
          if ('note' in ed) notes.value = ed.note === null ? '' : ed.note // null→''（旧格式兼容）；''=显式清空
          if ('hospital' in ed) hospital.value = ed.hospital === null ? '' : (ed.hospital || '')
          if ('gestationWeek' in ed) gestationWeek.value = ed.gestationWeek === null || ed.gestationWeek === undefined ? '' : String(ed.gestationWeek)
          // 草稿保存的编辑基线优先：恢复后不被最新云 revision 替换
          if (ed.baselineRevision !== undefined && ed.baselineRevision !== null) {
            editBaseline.value = { id: reportId.value, revision: ed.baselineRevision }
          }
          hydrating = false
        }
      }
      if (!fill(familyStore2.reports[reportId.value])) {
        familyStore2.pullReports().then(() => { fill(familyStore2.reports[reportId.value]); applyEditDraft() }).catch(() => {})
      } else {
        applyEditDraft()
      }
      fetchReportReadUrls(reportId.value).then(urls => {
        if (urls.ok && urls.urls[0]) {
          previewUrl.value = urls.urls[0].tempFileURL
          fileUrls.value = urls.urls.map(u => u.tempFileURL)
        }
      }).catch(() => {})
    } else if (familyBatchId.value) {
      const b = reportFamilyStore.batch(familyBatchId.value)
      if (b && b.draft) {
        selectedType.value = b.draft.reportType || ''
        reportDate.value = b.draft.dateKey || ''
        hospital.value = b.draft.hospital || ''
        gestationWeek.value = b.draft.gestationWeek != null ? String(b.draft.gestationWeek) : ''
        notes.value = b.draft.note || ''
      }
    }
  }

  // 旧 pendingUpload/fileUrls 路径仅 explicit demo；正式一律不读（旧键无归属）
  const upload = isExplicitDemo() ? reportStore.pendingUpload : null

  // 旧 pendingUpload/fileUrls 路径仅 explicit demo；正式只消费受控 reportId/batchId 链路
  if (upload?.fileUrls?.length > 0) {
    fileUrls.value = upload.fileUrls
    // 优先用本地路径预览（本地临时路径在当前设备始终可渲染）
    const locals = upload.localPaths || []

    // Get server-issued report_id for the corresponding image
    const serverItems = upload.items || []

    // 如果从批量页面进入，使用 itemIdx 获取对应索引的图片
    if (options.itemIdx !== undefined) {
      itemIdx.value = options.itemIdx
      const idx = parseInt(options.itemIdx)
      previewUrl.value = locals[idx] || fileUrls.value[idx] || ''
      serverReportId.value = serverItems[idx] ? serverItems[idx].report_id : ''
      serverImageUrl.value = serverItems[idx] ? serverItems[idx].image_url : ''
    } else {
      previewUrl.value = locals[0] || fileUrls.value[0] || ''
      serverReportId.value = serverItems[0] ? serverItems[0].report_id : ''
      serverImageUrl.value = serverItems[0] ? serverItems[0].image_url : ''
    }

    fileType.value = upload.fileType || 'image'
  } else if (isExplicitDemo() && options.fileUrls) {
    // 从未归档页面进入时，从 URL 参数读取 fileUrls（仅 explicit demo——
    // 旧 URL 无受控归属，正式只消费受控 reportId/batchId 链路）
    try {
      fileUrls.value = JSON.parse(decodeURIComponent(options.fileUrls))
      previewUrl.value = fileUrls.value[0] || ''
      fileType.value = 'image'
    } catch (e) {
      console.error('Failed to parse fileUrls:', e)
    }
  }

  if (options.source) source.value = options.source
  if (options.reportId) {
    reportId.value = options.reportId
  }
  // 旧 URL 参数携带的 aiType/ocrDate 仅 explicit demo 消费；正式不读
  if (isExplicitDemo()) {
    if (options.aiType) {
      selectedType.value = options.aiType
    }
    if (options.ocrDate) {
      reportDate.value = options.ocrDate
      ocrDateHint.value = true
    }
  }
})

function previewImage() {
  if (!previewUrl.value) return
  // 收集所有可用图片 URL（本地路径优先，fallback 到云端路径）
  const upload = isExplicitDemo() ? reportStore.pendingUpload : null
  const locals = (upload && upload.localPaths) || []
  // 优先使用本地路径，否则使用云端路径
  const urls = locals.length > 0 ? locals : fileUrls.value
  if (urls.length === 0) return
  uni.previewImage({
    current: previewUrl.value,
    urls: urls
  })
}

function onDateChange(e) {
  reportDate.value = e.detail.value
}

function formatDateDisplay(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr
  return `${d.getFullYear()} / ${String(d.getMonth() + 1).padStart(2, '0')} / ${String(d.getDate()).padStart(2, '0')}`
}

function goBack() {
  uni.navigateBack()
}

// ── 编辑期草稿持久化：表单字段变更即落盘（批次→batch.draft；已有报告→成员编辑草稿），
// 未点击保存的输入不丢失；onLoad 已恢复批次草稿/编辑草稿 ──
let draftPersistTimer = null
// family 云端值归一：hospital ''→null（显式清空）；week ''/非整数→null（type=number 输入以字符串持有）
function famHospitalOut() { return hospital.value === '' ? null : hospital.value }
function famWeekOut() {
  if (gestationWeek.value === '' || gestationWeek.value == null) return null
  const n = Number(gestationWeek.value)
  return Number.isInteger(n) ? n : null
}
function persistDraftNow() {
  if (!(getSessionState().status === 'confirmed' && !isExplicitDemo() && !isExplicitLoggedOut())) return
  // note 保留原始字符串（含空串=用户显式清空）；不以 || null 把 '' 抹成 null
  const draft = { reportType: selectedType.value, dateKey: reportDate.value, note: notes.value, hospital: hospital.value, gestationWeek: gestationWeek.value }
  if (familyBatchId.value) {
    reportFamilyStore.persistBatchDraft(familyBatchId.value, { ...draft, archiveStatus: 'archived' })
  } else if (reportId.value) {
    // 自动保存的草稿必须携带编辑基线（打开时捕获的 revision）——
    // 恢复时不被最新云 revision 替换、不因自动保存而丢失基线
    const bl = editBaseline.value
    reportFamilyStore.persistEditDraft(reportId.value, draft, bl && bl.id === reportId.value ? bl.revision : undefined)
  }
}
let hydrating = false // 程序化 hydrate 期间不触发自动草稿保存
watch([selectedType, reportDate, notes, hospital, gestationWeek], () => {
  if (hydrating) return
  if (draftPersistTimer) clearTimeout(draftPersistTimer)
  draftPersistTimer = setTimeout(persistDraftNow, 30)
})

// ── 批次控制：失败重试 / 暂存过期重暂（本机原件）/ 缺图移除（显式）──
async function retryFailedItems() {
  if (!familyBatchId.value) return
  const r = await reportFamilyStore.retryBatch(familyBatchId.value)
  void r
  uni.showToast({ title: '已重试未完成项', icon: 'none' })
}
async function restageExpiredItem(order) {
  if (!familyBatchId.value) return
  const r = await reportFamilyStore.restageItem(familyBatchId.value, order)
  if (!r.ok) uni.showToast({ title: r.message || '无法重暂存', icon: 'none', duration: 2500 })
  else uni.showToast({ title: '已用本机原件重新暂存', icon: 'none' })
}
async function replaceSlot(order) {
  if (!familyBatchId.value) return
  const r = await reportFamilyStore.replaceItemSlot(familyBatchId.value, order)
  if (r && r.ok === false && r.code && r.code !== 'cancelled') {
    uni.showToast({ title: r.message || '重选失败', icon: 'none', duration: 2500 })
  }
}
function removeFailedSlot(order) {
  if (!familyBatchId.value) return
  const r = reportFamilyStore.discardItem(familyBatchId.value, order)
  if (!r.ok) uni.showToast({ title: r.message || '移除失败', icon: 'none', duration: 2500 })
}

// 整批放弃（未创建报告）：与档案页批次卡同一入口。确认后先持久确认再清本机
// 原件（discardBatch），已上传到云端的文件留给孤儿清理自动回收；成功后返回
function discardWholeBatch() {
  if (!familyBatchId.value) return
  uni.showModal({
    title: '放弃该上传批次？',
    content: '本机保存的原件将删除；已上传到云端的部分由系统自动回收，不会生成报告。',
    confirmText: '放弃',
    confirmColor: '#C0405A',
    success: (m) => {
      if (!m.confirm) return
      const r = reportFamilyStore.discardBatch(familyBatchId.value)
      if (r.ok) {
        uni.showToast({ title: '已放弃该批次', icon: 'none' })
        setTimeout(() => uni.navigateBack(), 600)
      } else {
        uni.showToast({ title: r.message || '本机状态写入失败，未删除原件，请重试', icon: 'none', duration: 2500 })
      }
    }
  })
}
const famBatch = computed(() => familyBatchId.value ? reportFamilyStore.batch(familyBatchId.value) : null)

async function save() {
  if (!canSave.value) {
    uni.showToast({ title: '请选择报告类型和日期', icon: 'none' })
    return
  }

  if (isFamilyMode()) {
    // family 权威链路优先完整分流（批次创建/已存在报告编辑），旧 store 分支不可达
    uni.showLoading({ title: '保存中…' })
    try {
      if (familyBatchId.value) {
        const b = reportFamilyStore.batch(familyBatchId.value)
        if (b) {
          b.draft = { reportType: selectedType.value, dateKey: reportDate.value, note: notes.value || null, hospital: hospital.value, gestationWeek: gestationWeek.value, archiveStatus: 'archived' }
        }
        const r = await reportFamilyStore.createReportFromBatch(familyBatchId.value, {
          reportType: selectedType.value, dateKey: reportDate.value, note: notes.value || null, archiveStatus: 'archived',
          hospital: famHospitalOut(), weekOfPregnancy: famWeekOut()
        })
        uni.hideLoading()
        if (r.draftChanged) {
          // 草稿相对创建意图已变化且未提交：不得提示"已入档"或自动返回——
          // 未提交草稿已持久（batch.draft）；toast 概要 + modal 实际动作（去编辑）
          uni.showToast({ title: '本次修改未提交，草稿已保存', icon: 'none', duration: 2000 })
          // epoch/modal 绑定：旧会话的确认不把草稿写入新成员
          const modalEpoch = currentEpoch()
          const bNow = reportFamilyStore.batch(familyBatchId.value)
          const targetId = bNow && bNow.reportId ? bNow.reportId : ''
          // 基线：创建意图时版本（新建为 revision1），不取对方后来 revision
          const createBaseline = bNow && bNow.createIntent ? 1 : (r.record && r.record.revision)
          uni.showModal({
            title: '报告已存在',
            content: (r.message || '本次修改未提交，草稿已保存。') + '是否打开该报告进行编辑？',
            confirmText: '去编辑',
            cancelText: '留在本页',
            success: m => {
              if (currentEpoch() !== modalEpoch) return // 迟到确认不写新成员
              if (m.confirm && targetId) {
                // 先持久转移草稿（含基线），确认成功后打开 classify 编辑模式
                const ok = reportFamilyStore.persistEditDraft(targetId, {
                  reportType: selectedType.value,
                  dateKey: reportDate.value,
                  note: notes.value,
                  hospital: hospital.value,
                  gestationWeek: gestationWeek.value
                }, createBaseline)
                if (ok) {
                  navigateToPage('/pages/archives/classify?source=p6&reportId=' + encodeURIComponent(targetId))
                } else {
                  uni.showToast({ title: '草稿转移失败，请重试', icon: 'none', duration: 2500 })
                }
              }
              // 取消：草稿保留在 batch.draft，下次可再次进入
            }
          })
          return
        }
        if (r.ok && r.warning) {
          uni.showToast({ title: r.warning, icon: 'none', duration: 3000 })
          return // 完成状态未落盘：留在页面，可重试保存完成对账
        }
        if (r.ok) {
          reportStore.pendingUpload = null
          uni.showToast({ title: '1 份报告已入档（共享）', icon: 'none' })
          setTimeout(() => { uni.navigateBack() }, 1500)
        } else if (r.code === 'not-ready') {
          uni.showToast({ title: r.message || '尚有图片未完成登记，请稍后重试', icon: 'none', duration: 2500 })
        } else if (r.code === 'revision-conflict') {
          uni.showToast({ title: '对方已修改，请在档案页处理', icon: 'none', duration: 2500 })
                  setTimeout(() => navigateToPage('/pages/archives/index'), 1200)
        } else {
          uni.showToast({ title: r.message || '保存失败，请重试', icon: 'none', duration: 2500 })
        }
        return
      }
      if (reportId.value) {
        // 已有报告编辑（p6）：优先 onLoad hydrate 捕获的基线；冷启动未及 hydrate
        // 时现拉现取（记录不存在才拒绝）
        let rec = familyStore2.reports[reportId.value]
        if (!rec) {
          await familyStore2.pullReports()
          rec = familyStore2.reports[reportId.value]
        }
        const bl = (editBaseline.value && editBaseline.value.id === reportId.value)
          ? editBaseline.value
          : (rec && !rec.deleted ? { id: rec.id, revision: rec.revision || 0 } : null)
        if (!rec || rec.deleted || !bl) {
          uni.showToast({ title: '报告已删除或已更新，请返回刷新', icon: 'none', duration: 2500 })
          return
        }
        const r = await familyStore2.saveReport(reportId.value, {
          reportType: selectedType.value || undefined,
          dateKey: reportDate.value || undefined,
          hospital: famHospitalOut(),
          weekOfPregnancy: famWeekOut(),
          note: notes.value === '' ? null : (notes.value || undefined),
          archiveStatus: 'archived'
        }, bl.revision)
        uni.hideLoading()
        if (r.ok) {
          if (draftPersistTimer) { clearTimeout(draftPersistTimer); draftPersistTimer = null } // 取消待执行 autosave
          reportFamilyStore.clearEditDraft(reportId.value) // 已提交：旧草稿不再覆盖新数据
          uni.showToast({ title: '已保存（共享）', icon: 'none' })
          setTimeout(() => { uni.navigateBack() }, 1200)
        } else if (r.code === 'revision-conflict') {
          uni.showToast({ title: '对方已修改，请在档案页处理', icon: 'none', duration: 2500 })
                  setTimeout(() => navigateToPage('/pages/archives/index'), 1200)
          await familyStore2.pullReports()
        } else {
          uni.showToast({ title: r.message || '保存失败，请重试', icon: 'none', duration: 2500 })
        }
        return
      }
    } catch (e) {
      uni.hideLoading()
      uni.showToast({ title: (e && e.message) || '保存失败，请重试', icon: 'none', duration: 2500 })
      return
    }
  }

  if (reportId.value) {
    // 从 P6 进入 - 更新已有记录（演示/旧路径）
    uni.showLoading({ title: '保存中…' })
    try {
      const result = await reportStore.updateReport(reportId.value, {
        report_type: selectedType.value,
        report_date: reportDate.value,
        week_of_pregnancy: gestationWeek.value ? Number(gestationWeek.value) : null,
        hospital: hospital.value,
        notes: notes.value,
        archive_status: 'archived'
      })
      uni.hideLoading()
      if (!result || !result.ok) {
        uni.showToast({ title: (result && result.message) || '保存失败，请重试', icon: 'none', duration: 2500 })
        return
      }
      if (result.persisted === false) {
        // 本机写盘失败：不显示归档成功，留在页面让用户重试
        uni.showToast({ title: result.message || '本机保存失败，请重试', icon: 'none', duration: 2500 })
        return
      }
      uni.showToast({ title: result.pendingSync ? '已归档到本机，联网后同步' : '报告已归档', icon: 'none' })
      setTimeout(() => uni.navigateBack(), 1500)
    } catch (e) {
      uni.hideLoading()
      uni.showToast({ title: e.message || '保存失败，请重试', icon: 'none' })
    }
    return
  }

  // 新建报告
  const typeInfo = getTypeInfo(selectedType.value)

  // P3 批量流程：不创建数据库记录，只更新状态供 batch 页面统一归档
  if (source.value === 'p3' && itemIdx.value !== '') {
    const d = new Date(reportDate.value)
    const dateStr = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
    reportStore.batchItemUpdate = {
      itemIdx: parseInt(itemIdx.value),
      reportType: selectedType.value,
      dateText: dateStr,
      serverReportId: serverReportId.value || '',
      serverImageUrl: serverImageUrl.value || '',
    }
    uni.showToast({ title: '报告已保存', icon: 'none' })
    uni.navigateBack()
    return
  }

  // 其他流程：立即创建本地记录（服务端记录已在上传阶段创建）
  uni.showLoading({ title: '保存中…' })
  try {
    if (isFamilyMode() && reportId.value && !familyBatchId.value) {
      // 已有报告的分类编辑：权威部分更新（只改提交字段；打开时基线）
      const bl = editBaseline.value
      const rec = bl && bl.id === reportId.value ? familyStore2.reports[reportId.value] : null
      if (!rec || rec.deleted) {
        uni.hideLoading()
        uni.showToast({ title: '报告已删除或已更新，请返回刷新', icon: 'none', duration: 2500 })
        return
      }
      const r = await familyStore2.saveReport(reportId.value, {
        reportType: selectedType.value || undefined,
        dateKey: reportDate.value || undefined,
        hospital: famHospitalOut(),
        weekOfPregnancy: famWeekOut(),
        note: notes.value === '' ? null : (notes.value || undefined)
      }, bl.revision)
      uni.hideLoading()
      if (r.ok) {
        uni.showToast({ title: '已保存（共享）', icon: 'none' })
        setTimeout(() => { uni.navigateBack() }, 1200)
      } else if (r.code === 'revision-conflict') {
        uni.showToast({ title: '对方已修改，请在档案页处理', icon: 'none', duration: 2500 })
                  setTimeout(() => navigateToPage('/pages/archives/index'), 1200)
        await familyStore2.pullReports()
      } else {
        uni.showToast({ title: r.message || '保存失败，请重试', icon: 'none', duration: 2500 })
      }
      return
    }
    if (isFamilyMode() && familyBatchId.value) {
      // 权威链路：批次全部登记后创建报告（稳定 reportId/operationId，outbox 持久）
      const r = await reportFamilyStore.createReportFromBatch(familyBatchId.value, {
        reportType: selectedType.value,
        dateKey: reportDate.value,
        note: notes.value || null,
        hospital: hospital.value,
        weekOfPregnancy: famWeekOut(),
        archiveStatus: 'archived'
      })
      uni.hideLoading()
      if (r.ok) {
        reportStore.pendingUpload = null
        uni.showToast({ title: '1 份报告已入档（共享）', icon: 'none' })
        setTimeout(() => { uni.navigateBack() }, 1500)
      } else if (r.code === 'not-ready') {
        uni.showToast({ title: r.message || '尚有图片未完成登记，请稍后重试', icon: 'none', duration: 2500 })
      } else if (r.code === 'revision-conflict') {
        uni.showToast({ title: '对方已修改，请在档案页处理', icon: 'none', duration: 2500 })
                  setTimeout(() => navigateToPage('/pages/archives/index'), 1200)
      } else {
        uni.showToast({ title: r.message || '保存失败，请重试', icon: 'none', duration: 2500 })
      }
      return
    }
    const created = await reportStore.createReport({
      report_type: selectedType.value,
      report_name: typeInfo.label,
      file_urls: fileUrls.value,
      file_type: fileType.value,
      report_date: reportDate.value,
      week_of_pregnancy: gestationWeek.value ? Number(gestationWeek.value) : null,
      hospital: hospital.value,
      notes: notes.value,
      archive_status: 'archived',
      _serverReportId: serverReportId.value || undefined,
      _serverImageUrl: serverImageUrl.value || undefined,
      // 失败后重试以原 ID 重建同一记录
      _draftId: lastDraftId.value || undefined,
    })
    uni.hideLoading()
    if (created && created.id && created.persisted === false) {
      // 记录未落盘：记住分配的 ID、不清理 pendingUpload、不返回，如实提示
      lastDraftId.value = created.id
      uni.showToast({ title: created.message || '本机保存失败，请重试', icon: 'none', duration: 2500 })
      return
    }
    if (created && created.id) {
      // 非批量流程，清理 pendingUpload
      reportStore.pendingUpload = null
      lastDraftId.value = ''

      uni.showToast({ title: created.pendingSync ? '图片已上传，信息待同步' : '1 份报告已入档', icon: 'none' })
      setTimeout(() => {
        uni.navigateBack()
      }, 1500)
    } else {
      uni.showToast({ title: '保存失败，请重试', icon: 'none' })
    }
  } catch (e) {
    uni.hideLoading()
    uni.showToast({ title: e.message || '保存失败，请重试', icon: 'none' })
  }
}
</script>

<style scoped lang="scss">
page {
  --rose: #E8637A;
  --rose-light: #FDEEF1;
  --rose-dark: #C0405A;
  --gray-50: #FAF9F8;
  --gray-100: #F2F0EE;
  --gray-200: #E4E1DC;
  --gray-300: #C8C4BC;
  --gray-400: #9C9890;
  --gray-500: #6E6A64;
  --gray-700: #3A3834;
  --gray-900: #1C1A17;
  --radius: 16px;
  --radius-sm: 10px;
  --shadow: 0 2px 16px rgba(0, 0, 0, 0.07);
}

.page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background-color: #FAF9F8;
  font-family: 'DM Sans', 'Noto Sans SC', sans-serif;
  overflow-x: hidden;
}

.page {
  box-sizing: border-box;
}

/* WXSS 不支持 * 通配选择器（上传编译报错），改用标签选择器组等价覆盖 */
.page view,
.page text,
.page image,
.page input,
.page textarea,
.page button,
.page label,
.page form,
.page scroll-view,
.page swiper,
.page swiper-item,
.page picker,
.page canvas,
.page progress,
.page navigator {
  box-sizing: border-box;
}

/* ── Scroll ── */
.scroll { flex: 1; }

/* ── Confirm Preview Card ── */
.confirm-preview {
  margin: 32rpx;
  background: white;
  border-radius: 32rpx;
  overflow: hidden;
  box-shadow: 0 4rpx 32rpx rgba(0, 0, 0, 0.07);
}

.confirm-preview-img {
  width: 100%;
  height: 360rpx;
  background: linear-gradient(145deg, #F2F0EE 0%, #E4E1DC 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}

.preview-real-img {
  width: 100%;
  height: 360rpx;
}

.preview-zoom-hint {
  position: absolute;
  bottom: 20rpx;
  right: 20rpx;
  background: rgba(0, 0, 0, 0.5);
  border-radius: 999px;
  padding: 6rpx 20rpx;
}

.preview-zoom-text {
  font-size: 22rpx;
  color: white;
}

.preview-icon {
  font-size: 112rpx;
  opacity: 0.6;
}

.confirm-form { padding: 32rpx; overflow: hidden; }

/* ── Form ── */
.form-label { margin-bottom: 16rpx; }

.form-label-text {
  font-size: 24rpx;
  font-weight: 600;
  color: #9C9890;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

/* ── Type Grid ── */
.type-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16rpx;
  margin-bottom: 32rpx;
}

.type-option {
  padding: 20rpx 12rpx;
  border-radius: 20rpx;
  background: #F2F0EE;
  border: 4rpx solid transparent;
  text-align: center;
}

.type-option.selected {
  border-color: #E8637A;
  background: #FDEEF1;
}

.type-option-icon {
  font-size: 36rpx;
  display: block;
  margin-bottom: 6rpx;
}

.type-option-label {
  font-size: 22rpx;
  font-weight: 500;
  color: #6E6A64;
  display: block;
}

.type-option-label-active { color: #C0405A; }

/* ── Form Row ── */
.form-row { margin-bottom: 28rpx; }

.form-input {
  width: 100%;
  height: 80rpx;
  background: #F2F0EE;
  border: none;
  border-radius: 20rpx;
  padding: 0 24rpx;
  font-size: 28rpx;
  color: #3A3834;
  box-sizing: border-box;
}

.form-input-wrap {
  width: 100%;
  height: 80rpx;
  background: #F2F0EE;
  border-radius: 20rpx;
  padding: 0 24rpx;
  display: flex;
  align-items: center;
  box-sizing: border-box;
  overflow: hidden;
}

.form-row picker {
  display: block;
  width: 100%;
}

.form-input-text {
  font-size: 28rpx;
  color: #3A3834;
}

.form-input-placeholder {
  font-size: 28rpx;
  color: #C8C4BC;
}

.input-placeholder {
  color: #C8C4BC;
  font-size: 28rpx;
}

.form-hint {
  font-size: 22rpx;
  color: #C8C4BC;
  margin-top: 10rpx;
  display: block;
}

/* ── Footer ── */
.batch-footer {
  padding: 28rpx 32rpx;
  background: white;
  border-top: 1px solid #F2F0EE;
  display: flex;
  gap: 20rpx;
  flex-shrink: 0;
  padding-bottom: calc(28rpx + env(safe-area-inset-bottom));
}

.btn-secondary {
  flex: 1;
  height: 88rpx;
  background: #F2F0EE;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.btn-secondary-text {
  font-size: 28rpx;
  font-weight: 500;
  color: #6E6A64;
}

.btn-primary {
  flex: 2;
  height: 88rpx;
  background: #E8637A;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4rpx 24rpx rgba(232, 99, 122, 0.3);
}

.btn-disabled {
  opacity: 0.5;
}

.btn-primary-text {
  font-size: 28rpx;
  font-weight: 600;
  color: white;
}

.batch-ctrl { margin: 20rpx 28rpx; padding: 20rpx 24rpx; background: #FEF7EA; border: 2rpx solid rgba(240,169,64,.35); border-radius: 18rpx; }
.batch-ctrl-title { font-size: 24rpx; font-weight: 600; color: #B07818; display: block; margin-bottom: 12rpx; }
.batch-ctrl-row { display: flex; align-items: center; justify-content: space-between; padding: 8rpx 0; }
.batch-ctrl-item { font-size: 22rpx; color: #6E6A64; flex: 1; }
.batch-ctrl-btn { background: #C98A3A; border-radius: 999rpx; padding: 6rpx 20rpx; margin-left: 12rpx; }
.batch-ctrl-danger { background: #C0405A; }
.batch-ctrl-abandon { margin-top: 14rpx; border: 1rpx solid rgba(192, 64, 90, 0.45); border-radius: 999rpx; padding: 10rpx 0; text-align: center; }
.batch-ctrl-abandon-t { font-size: 22rpx; color: #C0405A; }
.batch-ctrl-btn-t { font-size: 20rpx; color: #fff; }
</style>
