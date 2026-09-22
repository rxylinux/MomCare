<template>
  <view class="page">
    <!-- NavBar -->
    <NavBar title="报告详情" theme="dark">
      <template #right>
        <view class="nav-more" @tap="showActionMenu = true">
          <text class="nav-more-icon">⋯</text>
        </view>
      </template>
    </NavBar>

    <!-- Scrollable Content -->
    <scroll-view scroll-y class="scroll">
      <!-- Loading State -->
      <view v-if="loading" class="loading-state">
        <text class="loading-text">加载中…</text>
      </view>

      <!-- Error State -->
      <view v-else-if="loadError" class="error-state">
        <text class="error-icon">⚠️</text>
        <text class="error-text">{{ loadError }}</text>
        <view class="error-retry" @tap="loadReport">
          <text class="error-retry-text">重试</text>
        </view>
      </view>

      <!-- Content -->
      <template v-else>
      <!-- Image Area -->
      <view class="detail-img-area" @tap="previewImage">
        <image
          v-if="currentImageUrl && !imgLoadError"
          :src="currentImageUrl"
          mode="aspectFit"
          class="detail-img-real"
          @error="imgLoadError = true"
        />
        <text v-if="!currentImageUrl || imgLoadError" class="detail-img-icon">{{ getTypeInfo(report.report_type).icon }}</text>
        <view v-if="currentImageUrl && !imgLoadError" class="detail-img-hint">
          <text class="detail-img-hint-text">点击查看大图</text>
        </view>
        <view v-if="report.file_urls && report.file_urls.length > 1" class="detail-img-overlay">
          <text class="detail-img-overlay-text">{{ currentImageIdx + 1 }} / {{ report.file_urls.length }} 张</text>
        </view>
      </view>

      <!-- Info Card -->
      <view class="detail-info-card">
        <!-- Edit Mode: Type Grid -->
        <view v-if="isEditing" class="edit-type-section">
          <text class="detail-field-label">报告类型</text>
          <view class="edit-type-grid">
            <view
              v-for="(t, idx) in typeOptions"
              :key="idx"
              class="edit-type-option"
              :class="{ 'edit-type-selected': editForm.report_type === t.key }"
              @tap="editForm.report_type = t.key"
            >
              <text class="edit-type-icon">{{ t.icon }}</text>
              <text class="edit-type-label" :class="{ 'edit-type-label-active': editForm.report_type === t.key }">{{ t.label }}</text>
            </view>
          </view>
        </view>
        <!-- View Mode: Type Badge -->
        <view v-else class="detail-info-header">
          <text class="type-badge" :class="getTypeInfo(report.report_type).typeClass">{{ getTypeInfo(report.report_type).label }}</text>
          <text class="detail-type-big">{{ report.report_name || getTypeInfo(report.report_type).label }}</text>
        </view>
        <view class="detail-info-grid">
          <view class="detail-field">
            <text class="detail-field-label">检查日期</text>
            <text v-if="!isEditing" class="detail-field-value">{{ formatDateDisplay(report.report_date) }}</text>
            <picker v-else mode="date" :value="editForm.report_date" @change="e => editForm.report_date = e.detail.value">
              <text class="detail-field-value editing">{{ editForm.report_date || '选择日期' }}</text>
            </picker>
          </view>
          <view class="detail-field">
            <text class="detail-field-label">当时孕周</text>
            <text v-if="!isEditing" class="detail-field-value" :class="{ 'detail-field-empty': !report.week_of_pregnancy }">
              {{ report.week_of_pregnancy ? `孕 ${report.week_of_pregnancy} 周` : '未记录' }}
            </text>
            <input v-else class="detail-edit-input" v-model="editForm.week_of_pregnancy" type="number" placeholder="孕周" />
          </view>
          <view class="detail-field">
            <text class="detail-field-label">就诊医院</text>
            <text v-if="!isEditing" class="detail-field-value" :class="{ 'detail-field-empty': !report.hospital }">
              {{ report.hospital || '未记录' }}
            </text>
            <input v-else class="detail-edit-input" v-model="editForm.hospital" placeholder="医院" />
          </view>
          <view class="detail-field">
            <text class="detail-field-label">上传时间</text>
            <text class="detail-field-value">{{ formatTimestamp(report.create_time) }}</text>
          </view>
        </view>
        <view v-if="report.notes" class="detail-notes">
          <text class="detail-field-label">备注</text>
          <text class="detail-notes-text">{{ report.notes }}</text>
        </view>
        <view v-if="isEditing" class="detail-notes">
          <text class="detail-field-label">备注</text>
          <input class="detail-edit-input" v-model="editForm.notes" placeholder="添加备注" />
        </view>

        <!-- Edit Actions -->
        <view v-if="isEditing" class="edit-actions">
          <view class="edit-cancel-btn" @tap="cancelEdit">
            <text class="edit-cancel-text">取消</text>
          </view>
          <view class="edit-save-btn" @tap="saveEdit">
            <text class="edit-save-text">保存</text>
          </view>
        </view>
      </view>

      <!-- AI Entry Card -->
      <view class="ai-entry-card" :class="aiCardClass" @tap="onAiCardTap">
        <view class="ai-entry-icon">
          <text class="ai-entry-icon-text">{{ aiCardIcon }}</text>
        </view>
        <view class="ai-entry-text">
          <text class="ai-entry-title">{{ aiCardTitle }}</text>
          <text class="ai-entry-sub">{{ aiCardSub }}</text>
        </view>
        <text class="ai-entry-arrow">›</text>
      </view>

      <!-- Action Row -->
      <view v-if="!isEditing" class="action-row">
        <view class="action-btn" @tap="onShare">
          <text class="action-btn-text">📤 分享</text>
        </view>
        <view class="action-btn" @tap="startEdit">
          <text class="action-btn-text">✏️ 编辑</text>
        </view>
        <view class="action-btn action-btn-danger" @tap="onDelete">
          <text class="action-btn-text action-btn-danger-text">🗑 删除</text>
        </view>
      </view>
      </template>
    </scroll-view>

    <!-- Action Menu Popup -->
    <view v-if="showActionMenu" class="overlay" @tap="showActionMenu = false">
      <view class="overlay-spacer"></view>
    </view>
    <view v-if="showActionMenu" class="action-menu">
      <view class="menu-item" @tap="onDownload">
        <text class="menu-item-text">下载原图</text>
      </view>
      <view class="menu-item menu-item-danger" @tap="onDelete">
        <text class="menu-item-text menu-item-danger-text">删除报告</text>
      </view>
    </view>

    <!-- Delete Confirm Modal -->
    <view v-if="showDeleteConfirm" class="modal-overlay" @tap="showDeleteConfirm = false">
      <view class="modal-content" @tap.stop>
        <text class="modal-title">确认删除</text>
        <text class="modal-text">删除后无法恢复，确认要删除这份报告吗？</text>
        <view class="modal-actions">
          <view class="modal-cancel" @tap="showDeleteConfirm = false">
            <text class="modal-cancel-text">取消</text>
          </view>
          <view class="modal-confirm modal-confirm-danger" @tap="doDelete">
            <text class="modal-confirm-text">删除</text>
          </view>
        </view>
      </view>
    </view>

    <!-- Share Poster Canvas (hidden) -->
    <canvas canvas-id="sharePoster" class="share-poster-canvas" />

    <!-- 权限引导弹窗 -->
    <ConfirmModal
      v-model:visible="showPermModal"
      title="提示"
      content="需要您授权保存图片到相册"
      confirmText="去授权"
      @confirm="() => uni.openSetting()"
    />
  </view>
</template>

<script setup>
import { ref, computed, getCurrentInstance, watch } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import ConfirmModal from '@/components/common/ConfirmModal.vue'
import { navigateToPage } from '@/utils/navigation.js'
import NavBar from '@/components/NavBar.vue'
import { useReportStore, REPORT_TYPES, getTypeInfo } from '@/stores/report'
import { getSessionState, isExplicitDemo, isExplicitLoggedOut, subscribeSession, currentEpoch } from '@/services/sessionService.js'
import { useFamilyStore } from '@/services/familyStore.js'
import { fetchReportReadUrls } from '@/services/fileUploadService.js'
import { legacyHttpEnabled } from '@/utils/backendGate.js'
import { useHealthStore } from '@/stores/health.js'

const reportStore = useReportStore()
const familyStore = useFamilyStore()
const isFamilyMode = () => getSessionState().status === 'confirmed' && !isExplicitDemo() && !isExplicitLoggedOut()
// family 权威报告 → 旧模板消费形状；临时 URL 按需签发（不持久化）
const famReadUrls = ref([])
// 会话失效清屏：报告正文/临时 URL/编辑态全部清除（familyStore 清数据外，
// 页面自有副本同样响应会话边界）
function clearFamilyContentView() {
  report.value = {}
  famReadUrls.value = []
  loadError.value = ''
  loading.value = false
  if (isEditing.value) isEditing.value = false
  editBaseline.value = null
}
watch(subscribeSession(), () => {
  if (!isFamilyMode()) clearFamilyContentView()
})
function famReportToLegacy(r) {
  if (!r || r.deleted) return null
  return {
    _id: r.id, report_type: r.reportType, report_date: r.dateKey,
    archive_status: r.archiveStatus, note: r.note || '', notes: r.note || '',
    file_urls: famReadUrls.value.map(u => u.tempFileURL),
    _attachmentCount: (r.attachments || []).length, _cloud: true, revision: r.revision || 0
  }
}
const healthStore = useHealthStore()
const instance = getCurrentInstance().proxy
const typeOptions = REPORT_TYPES

const report = ref({})
const reportId = ref('')
const currentImageIdx = ref(0)
const showPermModal = ref(false)
const isEditing = ref(false)
const showActionMenu = ref(false)
const showDeleteConfirm = ref(false)
const editForm = ref({})
const loading = ref(true)
const loadError = ref('')
const imgLoadError = ref(false)

const currentImageUrl = computed(() => {
  const urls = report.value.file_urls
  if (urls && urls.length > 0) return urls[currentImageIdx.value]
  return ''
})

const aiStatus = computed(() => report.value.ai_status || 'pending')

const aiCardClass = computed(() => {
  // Phase G：正式态不再硬封锁——云端 mc-tools 网关负责未配置时如实降级（enabled:false）
  if ((aiStatus.value === 'pending' || aiStatus.value === 'failed') && healthStore.aiInterpretRemaining <= 0) {
    return 'ai-card-limited'
  }
  switch (aiStatus.value) {
    case 'done': return 'ai-card-done'
    case 'processing': return 'ai-card-processing'
    case 'failed': return 'ai-card-failed'
    default: return ''
  }
})

const aiCardIcon = computed(() => {
  if ((aiStatus.value === 'pending' || aiStatus.value === 'failed') && healthStore.aiInterpretRemaining <= 0) {
    return '⏰'
  }
  switch (aiStatus.value) {
    case 'done': return '✅'
    case 'processing': return '⏳'
    case 'failed': return '🔄'
    default: return '✦'
  }
})

const aiCardTitle = computed(() => {
  if ((aiStatus.value === 'pending' || aiStatus.value === 'failed') && healthStore.aiInterpretRemaining <= 0) {
    return '今日解读次数已用完'
  }
  switch (aiStatus.value) {
    case 'done': return '查看 AI 解读'
    case 'processing': return 'AI 解读中…'
    case 'failed': return '解读失败，点击重试'
    default: return '开始 AI 解读'
  }
})

const aiCardSub = computed(() => {
  const result = report.value.ai_result
  if (aiStatus.value === 'done' && result) {
    // 正式态结果为云端自由文本：不做"整体正常"式断言，恒带"以原件为准"
    if (isFamilyMode()) return '已解读 · AI 生成仅供参考，以原件与医生诊断为准'
    const abnormal = result.abnormal_indicators || []
    if (abnormal.length > 0) return `已解读 · 发现 ${abnormal.length} 项指标异常`
    return '已解读 · 整体正常'
  }
  if (aiStatus.value === 'processing') return '正在分析报告内容…'
  if (aiStatus.value === 'failed') return `点击重新触发 AI 解读 · 今日剩余 ${healthStore.aiInterpretRemaining} 次`
  if (isFamilyMode()) return '云端 AI 解读（未配置时如实提示）· 以原始检验单为准'
  return `点击开始智能解读 · 今日剩余 ${healthStore.aiInterpretRemaining} 次`
})

onLoad(async (options) => {
  if (options.id) {
    reportId.value = options.id
    // 先尝试从 store 的缓存中获取
    const cachedReport = reportStore.reports.find(r => r._id === options.id)
    if (cachedReport) {
      report.value = cachedReport
      loading.value = false
    }
    // 无论是否有缓存，都从数据库刷新最新数据
    await loadReport()
  }
})

async function loadReport() {
  loading.value = true
  loadError.value = ''
  try {
    if (isFamilyMode()) {
      // 权威源：mc-reports 拉取 + 临时预览 URL（报告未删除才允许签发）。
      // 全程 epoch 门：任一 await 后会话失效（退出/切成员/拒绝）直接返回——
      // 不映射旧记录、不回落旧本地档案、不清除加载态以外的页面内容残留
      const epochAtStart = currentEpoch()
      await familyStore.pullReports()
      if (currentEpoch() !== epochAtStart || !isFamilyMode()) {
        clearFamilyContentView()
        return
      }
      const rec = familyStore.reports[reportId.value]
      if (!rec || rec.deleted) {
        loadError.value = '报告不存在或已删除'
        loading.value = false
        return
      }
      const urls = await fetchReportReadUrls(reportId.value)
      if (currentEpoch() !== epochAtStart || !isFamilyMode()) {
        clearFamilyContentView()
        return
      }
      famReadUrls.value = urls.ok ? urls.urls : []
      report.value = famReportToLegacy(rec)
      if (!urls.ok && (rec.attachments || []).length > 0) {
        uni.showToast({ title: '预览获取失败：' + (urls.message || urls.code), icon: 'none', duration: 2500 })
      }
      loading.value = false
      return
    }
    if (legacyHttpEnabled()) {
      await reportStore.syncReportsFromCloud()
    }
    const found = reportStore.reports.find(r => r._id === reportId.value) ||
                  reportStore.unarchivedReports.find(r => r._id === reportId.value)
    if (found) {
      report.value = found
      loading.value = false
    } else {
      loadError.value = '报告不存在'
      loading.value = false
    }
  } catch (e) {
    console.error('Failed to load report:', e)
    // Fallback to local data if cloud sync fails
    const found = reportStore.reports.find(r => r._id === reportId.value) ||
                  reportStore.unarchivedReports.find(r => r._id === reportId.value)
    if (found) {
      report.value = found
      loading.value = false
    } else {
      loadError.value = '加载失败，请重试'
      loading.value = false
    }
  }
}

function previewImage() {
  const urls = report.value.file_urls
  if (!urls || urls.length === 0) return
  uni.previewImage({
    current: urls[currentImageIdx.value],
    urls: urls
  })
}

function formatDateDisplay(dateStr) {
  if (!dateStr) return '-'
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

function formatTimestamp(ts) {
  if (!ts) return '-'
  const d = new Date(ts)
  if (isNaN(d.getTime())) return '-'
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// 编辑基线：打开时捕获记录 ID/revision/会话 epoch——保存时后台刷新不得抬高提交版本
const editBaseline = ref(null) // { id, revision, epoch }
function startEdit() {
  if (isFamilyMode()) {
    const rec = familyStore.reports[reportId.value]
    editBaseline.value = rec ? { id: rec.id, revision: rec.revision || 0, epoch: currentEpoch() } : null
  } else {
    editBaseline.value = null
  }
  isEditing.value = true
  editForm.value = {
    report_type: report.value.report_type,
    report_name: report.value.report_name,
    report_date: report.value.report_date,
    week_of_pregnancy: report.value.week_of_pregnancy || '',
    hospital: report.value.hospital || '',
    notes: report.value.notes || ''
  }
}

function cancelEdit() {
  isEditing.value = false
  editForm.value = {}
}

async function saveEdit() {
  const typeInfo = getTypeInfo(editForm.value.report_type)
  uni.showLoading({ title: '保存中…' })
  try {
    if (isFamilyMode()) {
      // 打开编辑时捕获的基线（id/revision/epoch）：保存不以刷新后的最新版本静默覆盖
      const bl = editBaseline.value
      if (!bl || bl.id !== reportId.value) {
        uni.showToast({ title: '编辑会话已失效，请重新编辑', icon: 'none', duration: 2500 })
        isEditing.value = false
        return
      }
      if (currentEpoch() !== bl.epoch) {
        uni.showToast({ title: '会话已切换，编辑已取消', icon: 'none', duration: 2500 })
        isEditing.value = false
        return
      }
      const rec = familyStore.reports[reportId.value]
      if (!rec || rec.deleted) {
        uni.showToast({ title: '报告已删除或已更新，请返回刷新', icon: 'none', duration: 2500 })
        return
      }
      // note 值语义：表单由记录初始化（未改=原值重提，不抹除）；空串=显式清空
      const r = await familyStore.saveReport(reportId.value, {
        reportType: editForm.value.report_type || undefined,
        dateKey: editForm.value.report_date || undefined,
        note: editForm.value.notes === '' ? null : (editForm.value.notes || undefined)
      }, bl.revision)
      if (currentEpoch() !== bl.epoch) {
        isEditing.value = false
        return
      }
      if (r.ok) {
        uni.showToast({ title: '已保存（共享）', icon: 'none' })
        isEditing.value = false
        editBaseline.value = null
        await loadReport()
      } else if (r.code === 'revision-conflict') {
        uni.showToast({ title: '对方已修改，请在档案页处理', icon: 'none', duration: 2500 })
          setTimeout(() => navigateToPage('/pages/archives/index'), 1200)
        await familyStore.pullReports()
      } else {
        uni.showToast({ title: r.message || '保存失败，请重试', icon: 'none', duration: 2500 })
      }
      return
    }
    const result = await reportStore.updateReport(reportId.value, {
      report_type: editForm.value.report_type,
      report_name: typeInfo.label,
      report_date: editForm.value.report_date,
      week_of_pregnancy: editForm.value.week_of_pregnancy ? Number(editForm.value.week_of_pregnancy) : null,
      hospital: editForm.value.hospital,
      notes: editForm.value.notes
    })
    uni.hideLoading()
    if (!result || !result.ok) {
      // 失败保留编辑表单内容，用户可重试
      uni.showToast({ title: (result && result.message) || '保存失败，请重试', icon: 'none', duration: 2500 })
      return
    }
    if (result.persisted === false) {
      // 云端/本地已更新但本机缓存写失败：如实说明，保留编辑态
      uni.showToast({ title: result.message || '云端已保存，但本机缓存写入失败', icon: 'none', duration: 3000 })
      return
    }
    await loadReport()
    isEditing.value = false
    uni.showToast({ title: result.pendingSync ? '已保存到本机，联网后同步' : '已保存', icon: 'none', duration: 2000 })
  } catch (e) {
    uni.hideLoading()
    uni.showToast({ title: e.message || '保存失败，请重试', icon: 'none' })
  }
}

async function onAiCardTap() {
  // Phase G：正式态接入云端网关（triggerAiPipeline → mc-tools）；
  // 未配置 Key/OCR 时云端返回 enabled:false 并如实提示，不伪造、不假死。
  if (aiStatus.value === 'done') {
    navigateToPage(`/pages/archives/ai-result?id=${reportId.value}`)
    return
  }
  if (isFamilyMode()) {
    if (!healthStore.canUseAiInterpret()) {
      uni.showToast({ title: '今日 50 次 AI 解读已用完，明天再来吧', icon: 'none', duration: 3000 })
      return
    }
    uni.showLoading({ title: '开始解读…' })
    await reportStore.triggerAiPipeline(reportId.value)
    await loadReport()
    uni.hideLoading()
    if (report.value.ai_status === 'done') {
      navigateToPage(`/pages/archives/ai-result?id=${reportId.value}`)
    }
    return
  }
  // 演示模式：无真实 AI 后端，明确不可用（不发起请求、不扣次数）
  uni.showToast({ title: '演示模式暂不支持 AI 解读', icon: 'none', duration: 2500 })
}

function onShare() {
  generateAndSavePoster()
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  let line = ''
  let currentY = y
  for (let i = 0; i < text.length; i++) {
    const testLine = line + text[i]
    const metrics = ctx.measureText(testLine)
    if (metrics.width > maxWidth && line !== '') {
      ctx.fillText(line, x, currentY)
      line = text[i]
      currentY += lineHeight
    } else {
      line = testLine
    }
  }
  if (line) {
    ctx.fillText(line, x, currentY)
    currentY += lineHeight
  }
  return currentY
}

function drawRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}

async function generateAndSavePoster() {
  uni.showLoading({ title: '正在生成海报...' })

  const ctx = uni.createCanvasContext('sharePoster', instance)
  const W = 375
  const H = 600

  // 1. Background gradient
  const bgGrad = ctx.createLinearGradient(0, 0, W, H)
  bgGrad.addColorStop(0, '#FFF5F6')
  bgGrad.addColorStop(1, '#FFE8EC')
  ctx.fillStyle = bgGrad
  ctx.fillRect(0, 0, W, H)

  // 2. Top accent bar
  const topGrad = ctx.createLinearGradient(0, 0, W, 0)
  topGrad.addColorStop(0, '#E8637A')
  topGrad.addColorStop(1, '#F0927A')
  ctx.fillStyle = topGrad
  ctx.fillRect(0, 0, W, 6)

  // 3. Brand text
  ctx.fillStyle = '#E8637A'
  ctx.font = 'bold 18px sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('《孕途伴侣》AI 智能解读', W / 2, 42)

  ctx.fillStyle = '#C0405A'
  ctx.font = '11px sans-serif'
  ctx.fillText('AI 护航 · 安心孕育', W / 2, 62)

  // 4. Report info card
  ctx.fillStyle = '#FFFFFF'
  drawRoundRect(ctx, 16, 80, W - 32, 60, 12)
  ctx.fill()

  ctx.textAlign = 'left'
  ctx.fillStyle = '#6E6A64'
  ctx.font = '12px sans-serif'

  const typeLabel = getTypeInfo(report.value.report_type)?.label || '报告'
  const dateStr = formatDateDisplay(report.value.report_date)
  const weekStr = report.value.week_of_pregnancy ? `孕 ${report.value.week_of_pregnancy} 周` : ''

  ctx.fillText(`报告类型：${typeLabel}`, 32, 104)
  ctx.fillText(`检查日期：${dateStr}`, 32, 126)

  if (weekStr) {
    ctx.fillText(`孕周：${weekStr}`, 210, 104)
  }

  // 5. AI core conclusion section
  ctx.fillStyle = '#1C1A17'
  ctx.font = 'bold 14px sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText('AI 核心结论', 24, 170)

  // Accent underline
  ctx.fillStyle = '#E8637A'
  ctx.fillRect(24, 176, 40, 3)

  const aiResult = report.value.ai_result || {}
  const summary = aiResult.overall_summary || '暂无解读结果'

  ctx.fillStyle = '#3A3834'
  ctx.font = '13px sans-serif'
  const summaryBottom = wrapText(ctx, summary, 24, 198, W - 48, 22)

  // 6. Indicator highlights
  const abnormalIndicators = aiResult.abnormal_indicators || []
  if (abnormalIndicators.length > 0) {
    let y = summaryBottom + 16
    ctx.fillStyle = '#1C1A17'
    ctx.font = 'bold 14px sans-serif'
    ctx.fillText('指标摘要', 24, y)
    ctx.fillStyle = '#E8637A'
    ctx.fillRect(24, y + 6, 40, 3)
    y += 24

    ctx.font = '12px sans-serif'
    abnormalIndicators.slice(0, 4).forEach((ind) => {
      if (y > H - 80) return
      const color = ind.severity === 'danger' ? '#E8637A' : ind.severity === 'warning' ? '#F0A940' : '#5BBF7C'
      ctx.fillStyle = color
      ctx.fillText('●', 24, y)
      ctx.fillStyle = '#3A3834'
      ctx.fillText(`${ind.name}: ${ind.value}`, 38, y)
      y += 20
    })
  }

  // 7. Bottom brand area
  ctx.fillStyle = '#E8637A'
  ctx.font = '12px sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('AI 护航，安心孕育每一天', W / 2, H - 36)

  ctx.fillStyle = '#C8C4BC'
  ctx.font = '10px sans-serif'
  ctx.fillText('以上解读由 AI 生成，仅供参考', W / 2, H - 18)

  // 8. Draw & export
  ctx.draw(false, () => {
    setTimeout(() => {
      uni.canvasToTempFilePath({
        canvasId: 'sharePoster',
        success: (res) => {
          uni.hideLoading()
          // #ifdef H5
          uni.previewImage({
            urls: [res.tempFilePath],
            current: res.tempFilePath
          })
          // #endif
          // #ifndef H5
          uni.saveImageToPhotosAlbum({
            filePath: res.tempFilePath,
            success: () => {
              uni.showToast({ title: '已保存到相册', icon: 'success' })
            },
            fail: (err) => {
              const msg = (err.errMsg || '').toLowerCase()
              if (msg.includes('deny') || msg.includes('auth')) {
                showPermModal.value = true
              } else {
                uni.showToast({ title: '保存失败', icon: 'none' })
              }
            }
          })
          // #endif
        },
        fail: () => {
          uni.hideLoading()
          uni.showToast({ title: '生成海报失败', icon: 'none' })
        }
      }, instance)
    }, 300)
  })
}

async function onDownload() {
  showActionMenu.value = false
  if (isFamilyMode()) {
    // 每次下载重新鉴权：报告未删除才允许签发；不使用旧缓存 URL
    const res = await fetchReportReadUrls(reportId.value)
    if (!res.ok) {
      uni.showToast({ title: res.message || '报告已删除或不可下载', icon: 'none', duration: 2500 })
      return
    }
    const url = res.urls && res.urls[0] && res.urls[0].tempFileURL
    if (!url) {
      uni.showToast({ title: '暂无可下载原件', icon: 'none' })
      return
    }
    const epochAtDownload = currentEpoch()
    uni.downloadFile({
      url,
      success: (r) => {
        // 迟到成功门：下载期间会话失效（退出/切成员）→ 不保存私人原件到相册
        if (currentEpoch() !== epochAtDownload || !isFamilyMode()) return
        uni.saveImageToPhotosAlbum({
          filePath: r.tempFilePath,
          success: () => uni.showToast({ title: '已保存到相册', icon: 'none' }),
          fail: () => uni.showToast({ title: '保存失败', icon: 'none' })
        })
      },
      fail: () => uni.showToast({ title: '下载失败', icon: 'none' })
    })
    return
  }
  if (currentImageUrl.value) {
    uni.downloadFile({
      url: currentImageUrl.value,
      success: (res) => {
        uni.saveImageToPhotosAlbum({
          filePath: res.tempFilePath,
          success: () => uni.showToast({ title: '已保存到相册', icon: 'none' }),
          fail: () => uni.showToast({ title: '保存失败', icon: 'none' })
        })
      }
    })
  }
}

// 删除基线：确认框打开时捕获显示中的 revision（其后对方推进 → 如实冲突）
const deleteBaseline = ref(null)
function onDelete() {
  showActionMenu.value = false
  const rec = familyStore.reports[reportId.value]
  deleteBaseline.value = rec ? { id: rec.id, revision: rec.revision || 0 } : null
  showDeleteConfirm.value = true
}

async function doDelete() {
  showDeleteConfirm.value = false
  if (isFamilyMode()) {
    uni.showLoading({ title: '删除中…' })
    const rec = familyStore.reports[reportId.value]
    const bl = deleteBaseline.value
    const r = await familyStore.deleteReport(reportId.value,
      (bl && bl.id === reportId.value) ? bl.revision : (rec ? rec.revision : undefined))
    uni.hideLoading()
    if (r.ok) {
      uni.showToast({ title: '已删除', icon: 'none' })
      setTimeout(() => uni.navigateBack(), 1000)
    } else if (r.code === 'revision-conflict') {
      uni.showToast({ title: '对方已修改，请刷新后重试', icon: 'none', duration: 2500 })
      await familyStore.pullReports()
    } else {
      uni.showToast({ title: r.message || '删除失败，请重试', icon: 'none', duration: 2500 })
    }
    deleteBaseline.value = null
    return
  }
  uni.showLoading({ title: '删除中…' })
  try {
    const result = await reportStore.deleteReport(reportId.value)
    uni.hideLoading()
    if (result && result.ok && result.persisted !== false) {
      uni.showToast({ title: '已删除', icon: 'none' })
      setTimeout(() => uni.navigateBack(), 1000)
    } else {
      // 云端未确认删除或本机写入失败：不显示删除成功
      uni.showToast({ title: (result && result.message) || '删除失败，请重试', icon: 'none', duration: 2500 })
    }
  } catch (e) {
    uni.hideLoading()
    uni.showToast({ title: e.message || '删除失败，请重试', icon: 'none' })
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
  --radius-pill: 999px;
  --shadow: 0 2px 16px rgba(0, 0, 0, 0.07);
}

.page {
  display: flex; flex-direction: column; height: 100vh;
  background-color: #FAF9F8;
  font-family: 'DM Sans', 'Noto Sans SC', sans-serif;
}

.nav-more {
  width: 68rpx; height: 68rpx;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.nav-more-icon { font-size: 32rpx; color: white; }

.scroll { flex: 1; }

/* ── Loading & Error States ── */
.loading-state {
  flex: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  padding: 0 80rpx;
}
.loading-text { font-size: 28rpx; color: #9C9890; }

.error-state {
  flex: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  padding: 0 80rpx;
}
.error-icon { font-size: 80rpx; margin-bottom: 24rpx; }
.error-text { font-size: 28rpx; color: #9C9890; margin-bottom: 32rpx; text-align: center; }
.error-retry {
  padding: 16rpx 48rpx; background: #E8637A;
  border-radius: 999px;
}
.error-retry-text { font-size: 28rpx; font-weight: 600; color: white; }

/* ── Detail Image Area ── */
.detail-img-area {
  background: linear-gradient(145deg, #F2F0EE 0%, #E4E1DC 100%);
  height: 480rpx;
  display: flex; align-items: center; justify-content: center;
  position: relative; flex-shrink: 0;
}
.detail-img-real { width: 100%; height: 480rpx; }
.detail-img-icon { font-size: 144rpx; opacity: 0.6; }
.detail-img-hint {
  position: absolute; bottom: 20rpx; right: 20rpx;
  background: rgba(0, 0, 0, 0.5); border-radius: 999px; padding: 6rpx 20rpx;
}
.detail-img-hint-text { font-size: 22rpx; color: white; }
.detail-img-overlay {
  position: absolute; bottom: 24rpx; left: 24rpx;
  background: rgba(232, 99, 122, 0.85); border-radius: 999px; padding: 8rpx 20rpx;
}
.detail-img-overlay-text { font-size: 22rpx; color: white; }

/* ── Info Card ── */
.detail-info-card {
  margin: 28rpx 32rpx; background: white;
  border-radius: 32rpx; padding: 32rpx;
  box-shadow: 0 4rpx 32rpx rgba(0, 0, 0, 0.07);
}
.detail-info-header {
  display: flex; align-items: center; gap: 16rpx;
  margin-bottom: 28rpx; padding-bottom: 24rpx;
  border-bottom: 1px solid #F2F0EE;
}
.type-badge { font-size: 26rpx; font-weight: 600; padding: 6rpx 20rpx; border-radius: 999px; }
.type-blood { background: #FDEEF1; color: #C0405A; }
.type-ultrasound { background: #EBF3FE; color: #2A6FCC; }
.type-urine { background: #E6F7F4; color: #1A7A68; }
.type-screen { background: #F0ECFB; color: #5A40A8; }
.type-sugar { background: #FEF4E3; color: #8C5A10; }
.type-other { background: #F2F0EE; color: #6E6A64; }

.detail-type-big { font-size: 32rpx; font-weight: 600; color: #1C1A17; }
.detail-info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24rpx; }
.detail-field { min-width: 0; overflow: hidden; }
.detail-field picker { display: block; }
.detail-field-label { font-size: 22rpx; color: #9C9890; margin-bottom: 6rpx; display: block; }
.detail-field-value { font-size: 28rpx; font-weight: 500; color: #3A3834; }
.detail-field-empty { font-size: 26rpx; color: #BDBDBD; font-weight: 400; }
.editing { color: #E8637A; }
.detail-edit-input {
  font-size: 28rpx; color: #3A3834;
  border-bottom: 1px solid #E4E1DC; padding: 4rpx 0;
}
.detail-notes { margin-top: 24rpx; }
.detail-notes-text { font-size: 26rpx; color: #6E6A64; margin-top: 8rpx; display: block; line-height: 1.5; }
.edit-actions { display: flex; gap: 20rpx; margin-top: 32rpx; }
.edit-cancel-btn {
  flex: 1; height: 72rpx; background: #F2F0EE;
  border-radius: 999px; display: flex; align-items: center; justify-content: center;
}
.edit-cancel-text { font-size: 26rpx; font-weight: 500; color: #6E6A64; }
.edit-save-btn {
  flex: 2; height: 72rpx; background: #E8637A;
  border-radius: 999px; display: flex; align-items: center; justify-content: center;
}
.edit-save-text { font-size: 26rpx; font-weight: 600; color: white; }

/* ── Edit Type Grid ── */
.edit-type-section {
  margin-bottom: 24rpx;
  padding-bottom: 24rpx;
  border-bottom: 1px solid #F2F0EE;
}
.edit-type-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16rpx;
  margin-top: 16rpx;
}
.edit-type-option {
  padding: 16rpx 12rpx;
  border-radius: 20rpx;
  background: #F2F0EE;
  border: 4rpx solid transparent;
  text-align: center;
}
.edit-type-selected {
  border-color: #E8637A;
  background: #FDEEF1;
}
.edit-type-icon {
  font-size: 32rpx;
  display: block;
  margin-bottom: 4rpx;
}
.edit-type-label {
  font-size: 22rpx;
  font-weight: 500;
  color: #6E6A64;
  display: block;
}
.edit-type-label-active { color: #C0405A; }

/* ── AI Entry Card ── */
.ai-entry-card {
  margin: 0 32rpx 28rpx;
  background: linear-gradient(135deg, #E8637A 0%, #E8527A 100%);
  border-radius: 32rpx; padding: 32rpx;
  display: flex; align-items: center; gap: 28rpx;
  box-shadow: 0 8rpx 40rpx rgba(232, 99, 122, 0.3);
}
.ai-card-done { background: linear-gradient(135deg, #5BBF7C 0%, #4AAF6C 100%); }
.ai-card-failed { background: linear-gradient(135deg, #F0A940 0%, #E09830 100%); }
.ai-card-processing { opacity: 0.8; }
.ai-card-limited { background: linear-gradient(135deg, #9C9890 0%, #6E6A64 100%); box-shadow: 0 8rpx 40rpx rgba(110, 106, 100, 0.22); }
.ai-entry-icon {
  width: 88rpx; height: 88rpx;
  background: rgba(255, 255, 255, 0.2); border-radius: 24rpx;
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.ai-entry-icon-text { font-size: 44rpx; color: white; }
.ai-entry-text { flex: 1; }
.ai-entry-title { font-size: 30rpx; font-weight: 600; color: white; margin-bottom: 4rpx; display: block; }
.ai-entry-sub { font-size: 24rpx; color: rgba(255, 255, 255, 0.7); }
.ai-entry-arrow { font-size: 32rpx; color: rgba(255, 255, 255, 0.8); flex-shrink: 0; }

/* ── Action Row ── */
.action-row { display: flex; gap: 16rpx; padding: 0 32rpx 40rpx; }
.action-btn {
  flex: 1; height: 80rpx; background: white;
  border: 2rpx solid #E4E1DC; border-radius: 999px;
  display: flex; align-items: center; justify-content: center;
}
.action-btn-text { font-size: 26rpx; font-weight: 500; color: #6E6A64; }
.action-btn-danger { border-color: #F2F0EE; }
.action-btn-danger-text { color: #E8637A; }

/* ── Action Menu ── */
.overlay {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0, 0, 0, 0.35); z-index: 1000;
}
.overlay-spacer { flex: 1; }
.action-menu {
  position: fixed; bottom: 0; left: 0; right: 0;
  background: white; border-radius: 32rpx 32rpx 0 0;
  padding: 40rpx 32rpx; z-index: 1001;
  padding-bottom: calc(40rpx + env(safe-area-inset-bottom));
}
.menu-item {
  padding: 24rpx 0; border-bottom: 1px solid #F2F0EE;
}
.menu-item-text { font-size: 28rpx; color: #3A3834; }
.menu-item-danger-text { color: #E8637A; }

/* ── Delete Confirm Modal ── */
.modal-overlay {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0, 0, 0, 0.4); z-index: 2000;
  display: flex; align-items: center; justify-content: center;
}
.modal-content {
  width: 600rpx; background: white; border-radius: 32rpx; padding: 48rpx 40rpx;
}
.modal-title { font-size: 32rpx; font-weight: 600; color: #1C1A17; margin-bottom: 16rpx; display: block; }
.modal-text { font-size: 28rpx; color: #6E6A64; line-height: 1.6; margin-bottom: 40rpx; display: block; }
.modal-actions { display: flex; gap: 20rpx; }
.modal-cancel {
  flex: 1; height: 80rpx; background: #F2F0EE;
  border-radius: 999px; display: flex; align-items: center; justify-content: center;
}
.modal-cancel-text { font-size: 28rpx; font-weight: 500; color: #6E6A64; }
.modal-confirm {
  flex: 1; height: 80rpx; border-radius: 999px;
  display: flex; align-items: center; justify-content: center;
}
.modal-confirm-danger { background: #E8637A; }
.modal-confirm-text { font-size: 28rpx; font-weight: 600; color: white; }

/* ── Share Poster Canvas ── */
.share-poster-canvas {
  width: 375px;
  height: 600px;
  position: fixed;
  left: -9999px;
}

.ai-card-disabled { opacity: 0.75; }
</style>
