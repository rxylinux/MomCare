<template>
  <view class="page">
    <!-- NavBar -->
    <NavBar title="确认报告信息" />

    <!-- Batch Header -->
    <view class="batch-header">
      <view class="batch-title-row">
        <text class="batch-title">已选 {{ items.length }} 份报告</text>
        <text class="select-all-btn" @tap="selectAll">全部确认</text>
      </view>
      <text class="batch-hint">请点击选择类型进行修改，确认后入档</text>
    </view>

    <!-- List -->
    <scroll-view scroll-y class="scroll">
      <view
        v-for="(item, idx) in items"
        :key="item.id"
        class="batch-item"
        :class="{ selected: item.selected }"
        @tap="toggleSelect(idx)"
      >
        <view class="batch-thumb">
          <image v-if="item.thumbUrl" :src="item.thumbUrl" mode="aspectFill" class="batch-thumb-img" />
          <text v-else class="batch-thumb-icon">{{ getTypeInfo(item.reportType).icon }}</text>
          <view v-if="item.selected" class="batch-check">
            <text class="batch-check-icon">✓</text>
          </view>
        </view>
        <view class="batch-info">
          <view class="batch-type-row" @tap.stop="goClassify(item, idx)">
            <text class="type-badge" :class="getTypeInfo(item.reportType).typeClass">
              {{ getTypeInfo(item.reportType).label }}
            </text>
          </view>
          <view class="batch-edit-row">
            <text class="batch-date">{{ item.dateText }}</text>
            <text class="choose-type-link" @tap.stop="goClassify(item, idx)">选择类型 ›</text>
          </view>
        </view>
      </view>

      <!-- Skip Hint -->
      <view class="skip-hint">
        <text class="skip-hint-text">💡 不确定的报告可先<text class="skip-hint-strong">跳过</text>，稍后从「未归档」整理</text>
      </view>
    </scroll-view>

    <!-- Footer -->
    <view class="batch-footer">
      <view class="btn-primary btn-primary-full" :class="{ 'btn-disabled': isArchiving }" @tap="confirmArchive">
        <text class="btn-primary-text">{{ isArchiving ? '保存中…' : `确认入档（${selectedCount}/${items.length}）` }}</text>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue'
import { onLoad, onShow } from '@dcloudio/uni-app'
import { navigateToPage } from '@/utils/navigation.js'
import NavBar from '@/components/NavBar.vue'
import { useReportStore, getTypeInfo } from '@/stores/report'

const reportStore = useReportStore()

const items = ref([])
const isArchiving = ref(false) // 防止重复提交

const selectedCount = computed(() => items.value.filter(i => i.selected).length)

onLoad((options) => {
  // 清空现有数据，防止重复累积
  items.value = []

  // 从 store 读取上传数据
  const upload = reportStore.pendingUpload
  if (upload && upload.fileUrls) {
    const locals = upload.localPaths || []
    const serverItems = upload.items || []
    items.value = upload.fileUrls.map((url, idx) => ({
      id: idx,
      fileUrl: url,
      reportId: serverItems[idx] ? serverItems[idx].report_id : '',
      // 优先用本地路径预览
      thumbUrl: locals[idx] || url,
      reportType: 'other',
      dateText: formatDate(new Date()),
      weekText: '',
      selected: true,
      needsConfirm: false
    }))
  }
})

onShow(() => {
  // 检查是否有从 classify 页面返回的更新
  const update = reportStore.batchItemUpdate
  if (update && items.value[update.itemIdx]) {
    items.value[update.itemIdx].reportType = update.reportType
    items.value[update.itemIdx].dateText = update.dateText
    if (update.serverReportId) {
      items.value[update.itemIdx].reportId = update.serverReportId
    }
    // 清除更新信息
    reportStore.batchItemUpdate = null
  }
})

function formatDate(d) {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

// 将 dateText 格式 "YYYY/MM/DD" 转换为 ISO 格式 "YYYY-MM-DD"
function parseDateText(dateText) {
  const parts = dateText.split('/')
  if (parts.length === 3) {
    return `${parts[0]}-${parts[1]}-${parts[2]}`
  }
  // 如果解析失败，返回当天日期
  return new Date().toISOString().slice(0, 10)
}

function toggleSelect(idx) {
  items.value[idx].selected = !items.value[idx].selected
}

function selectAll() {
  // 只选中 AI 识别成功的
  items.value.forEach(item => {
    if (!item.needsConfirm) item.selected = true
  })
}

function goClassify(item, idx) {
  const params = [
    `fileUrls=${encodeURIComponent(JSON.stringify([item.fileUrl]))}`,
    `source=p3`,
    `itemIdx=${idx}`
  ]
  if (item.reportType && item.reportType !== 'other') {
    params.push(`aiType=${item.reportType}`)
  }
  navigateToPage(`/pages/archives/classify?${params.join('&')}`)
}

async function confirmArchive() {
  // 防止重复点击
  if (isArchiving.value) {
    return
  }
  isArchiving.value = true

  uni.showLoading({ title: '保存中…' })
  let savedCount = 0
  let failedCount = 0
  let hasPending = false

  try {
    for (const item of items.value) {
      // 幂等重试：上一轮已确认保存成功的条目直接跳过，不重复创建
      if (item.createdId) {
        savedCount++
        continue
      }

      const created = await reportStore.createReport({
        report_type: item.reportType || 'other',
        file_urls: [item.fileUrl],
        file_type: 'image',
        report_date: parseDateText(item.dateText),
        archive_status: item.selected ? 'archived' : 'unarchived',
        _serverReportId: item.reportId || undefined,
        _serverImageUrl: item.fileUrl || undefined,
        // 失败后重试以原 ID 重建同一记录，不产生第二个报告 ID
        _draftId: item.draftId || undefined,
      })

      // 只有确认持久化成功才计入已保存；失败项留在页面等待重试
      if (created && created.id && created.persisted !== false) {
        item.createdId = created.id
        savedCount++
        if (created.pendingSync) hasPending = true
      } else {
        // 记住失败次已分配的 ID：恢复后以原 ID 重试
        if (created && created.id) item.draftId = created.id
        failedCount++
      }
    }

    uni.hideLoading()

    if (failedCount > 0) {
      // 任一条目未确认保存：不清草稿、不离开页面，图片引用与已填信息保留
      uni.showToast({
        title: `${failedCount} 项保存失败已保留；已成功 ${savedCount} 项不会重复保存，可点击重试`,
        icon: 'none',
        duration: 3000
      })
      isArchiving.value = false
      return
    }

    // 全部条目确认保存成功后才刷新列表、清草稿并离开
    await reportStore.syncReportsFromCloud()

    const archivedCount = items.value.filter(i => i.selected).length
    if (archivedCount === 0) {
      uni.showToast({ title: '已跳过所有报告', icon: 'none' })
    } else if (hasPending) {
      uni.showToast({ title: `${archivedCount} 份已入档，信息待同步`, icon: 'none', duration: 2500 })
    } else {
      uni.showToast({ title: `${archivedCount} 份报告已入档`, icon: 'none' })
    }
    isArchiving.value = false

    reportStore.pendingUpload = null
    reportStore.batchItemUpdate = null

    setTimeout(() => {
      uni.navigateBack()
    }, 1500)
  } catch (e) {
    uni.hideLoading()
    uni.showToast({ title: e.message || '保存失败，请重试', icon: 'none' })
    isArchiving.value = false
  }
}
</script>

<style scoped lang="scss">
page {
  --rose: #E8637A;
  --rose-light: #FDEEF1;
  --rose-dark: #C0405A;
  --amber: #F0A940;
  --amber-light: #FEF4E3;
  --blue-light: #EBF3FE;
  --teal-light: #E6F7F4;
  --purple-light: #F0ECFB;
  --green-light: #EAF7EF;
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
  display: flex;
  flex-direction: column;
  height: 100vh;
  background-color: #FAF9F8;
  font-family: 'DM Sans', 'Noto Sans SC', sans-serif;
}

/* ── Batch Header ── */
.batch-header {
  padding: 28rpx 32rpx 20rpx;
  border-bottom: 1px solid #F2F0EE;
  flex-shrink: 0;
  background: white;
}

.batch-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12rpx;
}

.batch-title { font-size: 32rpx; font-weight: 600; color: #1C1A17; }
.select-all-btn { font-size: 26rpx; font-weight: 500; color: #E8637A; }
.batch-hint { font-size: 24rpx; color: #9C9890; }

/* ── Scroll ── */
.scroll { flex: 1; padding: 24rpx 0; }

/* ── Batch Item ── */
.batch-item {
  margin: 0 32rpx 20rpx;
  background: white;
  border-radius: 32rpx;
  padding: 24rpx;
  display: flex;
  gap: 24rpx;
  align-items: center;
  box-shadow: 0 4rpx 32rpx rgba(0, 0, 0, 0.07);
  border: 4rpx solid transparent;
}

.batch-item.selected { border-color: #E8637A; background: #FFFBFC; }
.batch-item-warning { border-color: #F0A940; background: #FFFDF7; }

.batch-thumb {
  width: 120rpx; height: 120rpx;
  border-radius: 20rpx; background: #F2F0EE;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; position: relative; overflow: hidden;
}

.batch-thumb-warning { background: #FEF4E3; }
.batch-thumb-icon { font-size: 52rpx; }
.batch-thumb-img { width: 100%; height: 100%; }

.batch-check {
  position: absolute; top: 8rpx; right: 8rpx;
  width: 36rpx; height: 36rpx; border-radius: 50%;
  background: #E8637A; border: 4rpx solid white;
  display: flex; align-items: center; justify-content: center;
}

.batch-check-icon { font-size: 20rpx; color: white; }
.batch-info { flex: 1; }

.batch-type-row { display: flex; align-items: center; gap: 16rpx; margin-bottom: 8rpx; }

.type-badge { font-size: 22rpx; font-weight: 600; padding: 4rpx 14rpx; border-radius: 999px; }

.ai-badge {
  font-size: 20rpx; font-weight: 600;
  background: #FDEEF1; color: #C0405A;
  padding: 2rpx 12rpx; border-radius: 999px;
}

.ai-badge-warning { background: #FEF4E3; color: #8C5A10; }

.batch-edit-row { display: flex; align-items: center; gap: 12rpx; }
.batch-date { font-size: 24rpx; color: #9C9890; }
.batch-date-warning { font-size: 24rpx; color: #9C9890; }
.choose-type-link { font-size: 24rpx; color: #E8637A; font-weight: 500; }

/* ── Type Badge Colors ── */
.type-blood { background: #FDEEF1; color: #C0405A; }
.type-ultrasound { background: #EBF3FE; color: #2A6FCC; }
.type-urine { background: #E6F7F4; color: #1A7A68; }
.type-screen { background: #F0ECFB; color: #5A40A8; }
.type-sugar { background: #FEF4E3; color: #8C5A10; }
.type-other { background: #F2F0EE; color: #6E6A64; }

/* ── Skip Hint ── */
.skip-hint { margin: 8rpx 32rpx 16rpx; padding: 20rpx 28rpx; background: #F2F0EE; border-radius: 20rpx; }
.skip-hint-text { font-size: 24rpx; color: #9C9890; line-height: 1.6; }
.skip-hint-strong { font-weight: 600; color: #6E6A64; }

/* ── Footer ── */
.batch-footer {
  padding: 28rpx 32rpx; background: white;
  border-top: 1px solid #F2F0EE;
  display: flex; gap: 20rpx; flex-shrink: 0;
  padding-bottom: calc(28rpx + env(safe-area-inset-bottom));
}

.btn-secondary {
  flex: 1; height: 88rpx; background: #F2F0EE;
  border-radius: 999px; display: flex; align-items: center; justify-content: center;
}
.btn-secondary-text { font-size: 28rpx; font-weight: 500; color: #6E6A64; }

.btn-primary {
  flex: 2; height: 88rpx; background: #E8637A;
  border-radius: 999px; display: flex; align-items: center; justify-content: center;
  box-shadow: 0 4rpx 24rpx rgba(232, 99, 122, 0.3);
}

.btn-primary-full { flex: 1; }
.btn-primary-text { font-size: 28rpx; font-weight: 600; color: white; }

.btn-disabled {
  opacity: 0.5;
  pointer-events: none;
}
</style>
