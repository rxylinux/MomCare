<template>
  <view class="page">
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

const reportStore = useReportStore()
const healthStore = useHealthStore()
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

  // 从 store 读取上传数据（避免 URL 参数编码问题）
  const upload = reportStore.pendingUpload

  // 优先使用 pendingUpload，否则从 URL 参数读取
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
  } else if (options.fileUrls) {
    // 从未归档页面进入时，从 URL 参数读取 fileUrls
    try {
      fileUrls.value = JSON.parse(decodeURIComponent(options.fileUrls))
      previewUrl.value = fileUrls.value[0] || ''
      fileType.value = 'image'
    } catch (e) {
      console.error('Failed to parse fileUrls:', e)
    }
  }

  if (options.source) source.value = options.source
  if (options.reportId) reportId.value = options.reportId
  if (options.aiType) {
    selectedType.value = options.aiType
  }
  if (options.ocrDate) {
    reportDate.value = options.ocrDate
    ocrDateHint.value = true
  }
})

function previewImage() {
  if (!previewUrl.value) return
  // 收集所有可用图片 URL（本地路径优先，fallback 到云端路径）
  const upload = reportStore.pendingUpload
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

async function save() {
  if (!canSave.value) {
    uni.showToast({ title: '请选择报告类型和日期', icon: 'none' })
    return
  }

  if (reportId.value) {
    // 从 P6 进入 - 更新已有记录
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

.page,
.page *,
.page *::before,
.page *::after {
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
</style>
