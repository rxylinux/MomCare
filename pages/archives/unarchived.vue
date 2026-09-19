<template>
  <view class="page">
    <!-- NavBar -->
    <NavBar title="未归档报告">
      <template #right>
        <text
          class="nav-action-text"
          :class="{ 'nav-action-disabled': !allRecognized }"
          @tap="onArchiveAll"
        >全部归档</text>
      </template>
    </NavBar>

    <!-- Empty State -->
    <view v-if="reportStore.unarchivedReports.length === 0 && !loading" class="empty-state">
      <text class="empty-icon">🎉</text>
      <text class="empty-title">所有报告已归档</text>
    </view>

    <template v-else>
      <!-- Instruction Text -->
      <view class="instruction">
        <text class="instruction-text">以下报告尚未完成分类，点击「分类」为每份报告选择正确类型后即可入档。</text>
      </view>

      <!-- Unarchived List -->
      <scroll-view scroll-y class="scroll">
        <view
          v-for="(item) in reportStore.unarchivedReports"
          :key="item._id"
          class="unarchived-item"
          @tap="onItemTap(item)"
        >
          <view class="unarchived-thumb">
            <image v-if="item.file_urls && item.file_urls[0] && !thumbErrors.get(item._id)" :src="item.file_urls[0]" mode="aspectFill" class="unarchived-thumb-img" @error="thumbErrors.set(item._id, true)" />
            <text v-if="!item.file_urls || !item.file_urls[0] || thumbErrors.get(item._id)" class="unarchived-thumb-icon">{{ getTypeInfo(item.ai_type_guess || 'other').icon }}</text>
          </view>
          <view class="unarchived-info">
            <text class="unarchived-name">{{ item.report_name || '未命名报告' }}</text>
            <text class="unarchived-date">{{ formatUploadTime(item.create_time) }} · {{ getStatusText(item) }}</text>
          </view>
          <view class="unarchived-actions">
            <view class="classify-btn" @tap.stop="onClassifyTap(item)">
              <text class="classify-btn-text">{{ item.ai_type_guess ? '确认' : '分类' }}</text>
            </view>
            <view class="delete-btn" @tap.stop="onDeleteItem(item._id)">
              <text class="delete-btn-text">删除</text>
            </view>
          </view>
        </view>
      </scroll-view>
    </template>

    <!-- 批量归档确认弹窗 -->
    <view class="logout-overlay" v-if="showBatchConfirm" @tap="showBatchConfirm = false">
      <view class="logout-card" @tap.stop>
        <text class="logout-modal-title">确认批量归档</text>
        <text class="logout-modal-desc">将归档 {{ reportStore.unarchivedReports.length }} 份已识别报告，确认继续？</text>
        <view class="logout-modal-actions">
          <view class="logout-btn logout-btn-cancel" @tap="showBatchConfirm = false">
            <text>取消</text>
          </view>
          <view class="logout-btn logout-btn-confirm" @tap="doBatchArchive">
            <text>确认归档</text>
          </view>
        </view>
      </view>
    </view>

    <!-- 删除确认弹窗 -->
    <view class="logout-overlay" v-if="showDeleteConfirm" @tap="showDeleteConfirm = false">
      <view class="logout-card" @tap.stop>
        <text class="logout-modal-title">确认删除</text>
        <text class="logout-modal-desc">删除后无法恢复，确认要删除这份报告吗？</text>
        <view class="logout-modal-actions">
          <view class="logout-btn logout-btn-cancel" @tap="showDeleteConfirm = false">
            <text>取消</text>
          </view>
          <view class="logout-btn logout-btn-confirm" @tap="doDelete">
            <text>删除</text>
          </view>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { navigateToPage } from '@/utils/navigation.js'
import NavBar from '@/components/NavBar.vue'
import { useReportStore, getTypeInfo } from '@/stores/report'
import { getSessionState, isExplicitDemo, isExplicitLoggedOut, subscribeSession, currentEpoch } from '@/services/sessionService.js'
import { useFamilyStore } from '@/services/familyStore.js'
import { legacyHttpEnabled } from '@/utils/backendGate.js'

const reportStore = useReportStore()
const loadError = ref('')
const familyStore = useFamilyStore()
const isFamilyMode = () => getSessionState().status === 'confirmed' && !isExplicitDemo() && !isExplicitLoggedOut()
const famUnarchived = () => Object.values(familyStore.reports)
  .filter(r => !r.deleted && r.archiveStatus === 'unarchived')
  .sort((a, b) => (b.dateKey || '').localeCompare(a.dateKey || ''))
  .map(r => ({ _id: r.id, report_type: r.reportType, report_date: r.dateKey, archive_status: r.archiveStatus, note: r.note || '', file_urls: [], _attachmentCount: (r.attachments || []).length, _cloud: true }))
async function loadFamilyUnarchived() {
  await familyStore.pullReports()
  return famUnarchived()
}
const loading = ref(true)
const showBatchConfirm = ref(false)
const showDeleteConfirm = ref(false)
const deleteTargetId = ref('')
const thumbErrors = ref(new Map())

const allRecognized = computed(() => {
  // family：手动分类即有效（AI 未启用，不以 ai_type_guess 设门槛）
  if (isFamilyMode()) return reportStore.unarchivedReports.length > 0
  return reportStore.unarchivedReports.length > 0 &&
    reportStore.unarchivedReports.every(r => r.ai_type_guess)
})

// family 可见列表重映射（拉取/操作/会话恢复后统一调用）
function remapFamilyUnarchived() {
  reportStore.unarchivedReports = Object.values(familyStore.reports)
    .filter(r => !r.deleted && r.archiveStatus === 'unarchived')
    .sort((a, b) => (b.dateKey || '').localeCompare(a.dateKey || ''))
    .map(r => ({ _id: r.id, report_type: r.reportType, report_date: r.dateKey, archive_status: r.archiveStatus, note: r.note || '', file_urls: [], _cloud: true, revision: r.revision || 0 }))
}
// 会话失效清屏（含确认弹层）
watch(subscribeSession(), () => {
  if (!isFamilyMode()) {
    reportStore.unarchivedReports = []
    loadError.value = ''
    loading.value = false
    showDeleteConfirm.value = false
    showBatchConfirm.value = false
  }
})

onShow(async () => {
  loading.value = true
  // B2b2 family：权威未归档报告实际拉取并进入模板派生源
  if (isFamilyMode()) {
    const res = await familyStore.pullReports()
    if (!res.ok && Object.keys(familyStore.reports).length === 0) {
      loadError.value = '同步失败，请下拉重试'
    }
    remapFamilyUnarchived()
    loading.value = false
    return
  }
  if (legacyHttpEnabled()) {
    try {
      await reportStore.syncReportsFromCloud()
    } catch (e) {
      console.error('Failed to sync reports from cloud:', e)
      await reportStore.fetchUnarchivedReports()
    }
  } else {
    await reportStore.fetchUnarchivedReports()
  }
  loading.value = false

  // 全部处理完自动返回
  if (reportStore.unarchivedReports.length === 0 && !loading.value) {
    setTimeout(() => {
      uni.navigateBack()
    }, 1500)
  }
})

function formatUploadTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ''
  return `上传于 ${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

function getStatusText(item) {
  if (item.ai_type_guess) {
    const info = getTypeInfo(item.ai_type_guess)
    return `已识别为${info.label}`
  }
  return '未识别类型'
}

function onItemTap(item) {
  onClassifyTap(item)
}

function onClassifyTap(item) {
  const params = [
    `reportId=${item._id}`,
    `source=p6`
  ]
  if (item.ai_type_guess) {
    params.push(`aiType=${item.ai_type_guess}`)
  }
  if (item.file_urls) {
    params.push(`fileUrls=${encodeURIComponent(JSON.stringify(item.file_urls))}`)
  }
  navigateToPage(`/pages/archives/classify?${params.join('&')}`)
}

// 批量归档意图：打开确认时冻结 {id, revision} 列表并绑定会话——
// 其后列表同步/对方推进不改意图；确认只执行该冻结意图（冲突如实）
const batchArchiveIntent = ref(null) // { epoch, items: [{id, revision}] }
function onArchiveAll() {
  if (!allRecognized.value) {
    const unrecognized = reportStore.unarchivedReports.filter(r => !r.ai_type_guess).length
    uni.showToast({ title: `有 ${unrecognized} 份报告尚未分类，请先处理`, icon: 'none' })
    return
  }
  batchArchiveIntent.value = {
    epoch: currentEpoch(),
    items: reportStore.unarchivedReports.map(r => ({ id: r._id, revision: r.revision || 0 }))
  }
  showBatchConfirm.value = true
}

async function doBatchArchive() {
  showBatchConfirm.value = false
  const ids = reportStore.unarchivedReports.map(r => r._id)
  if (isFamilyMode()) {
    // 打开确认时快照 {id, revision}；逐项按快照基线归档（其后同步不抬高基线）；
    // 部分成功/冲突/失败分开反馈；跨成员切换即停
    // 只执行确认打开时冻结的意图（快照 + epoch）；意图缺失/会话变化则重新确认
    const intent = batchArchiveIntent.value
    if (!intent || currentEpoch() !== intent.epoch) {
      uni.hideLoading()
      uni.showToast({ title: '列表已更新，请重新确认归档', icon: 'none', duration: 2500 })
      return
    }
    const epochAtStart = intent.epoch
    const snapshot = intent.items
    uni.showLoading({ title: '归档中…' })
    let okCount = 0
    const conflicts = []
    const failures = []
    for (const snap of snapshot) {
      if (currentEpoch() !== epochAtStart) break
      const rec = familyStore.reports[snap.id]
      if (!rec || rec.deleted) { failures.push(snap.id); continue }
      const r = await familyStore.saveReport(snap.id, { archiveStatus: 'archived' }, snap.revision)
      if (r.ok) okCount++
      else if (r.code === 'revision-conflict') conflicts.push(snap.id)
      else failures.push(snap.id)
    }
    uni.hideLoading()
    batchArchiveIntent.value = null
    if (currentEpoch() !== epochAtStart) return
    await familyStore.pullReports()
    remapFamilyUnarchived()
    const parts = []
    if (okCount) parts.push(`${okCount} 份已归档`)
    if (conflicts.length) parts.push(`${conflicts.length} 份对方已修改`)
    if (failures.length) parts.push(`${failures.length} 份失败可重试`)
    uni.showToast({ title: parts.join('，') || '没有可归档的报告', icon: 'none', duration: 3000 })
    return
  }
  uni.showLoading({ title: '归档中…' })
  try {
    const result = await reportStore.batchArchive(ids)
    await reportStore.syncReportsFromCloud()
    uni.hideLoading()
    if (result && result.failed && result.failed.length > 0) {
      uni.showToast({ title: `部分归档失败：${result.failed.length} 份，请重试`, icon: 'none', duration: 2500 })
      return
    }
    uni.showToast({ title: result && result.pending ? '全部归档成功，部分待同步' : '全部归档成功', icon: 'none' })
    setTimeout(() => uni.navigateBack(), 1500)
  } catch (e) {
    uni.hideLoading()
    uni.showToast({ title: e.message || '归档失败，请重试', icon: 'none' })
  }
}

// 删除基线：确认框打开时捕获显示中的 revision（其后对方推进 → 如实冲突）
const deleteTarget = ref(null) // { id, revision }
function onDeleteItem(id) {
  deleteTargetId.value = id
  const rec = familyStore.reports[id]
  deleteTarget.value = { id, revision: rec ? (rec.revision || 0) : 0 }
  showDeleteConfirm.value = true
}

async function doDelete() {
  showDeleteConfirm.value = false
  if (isFamilyMode()) {
    const bl = deleteTarget.value
    const rec = familyStore.reports[deleteTargetId.value]
    if (!rec || rec.deleted) {
      uni.showToast({ title: '报告已删除或已更新', icon: 'none', duration: 2500 })
      remapFamilyUnarchived()
      return
    }
    const r = await familyStore.deleteReport(deleteTargetId.value, bl ? bl.revision : (rec.revision || 0))
    if (r.ok) uni.showToast({ title: '已删除', icon: 'none' })
    else if (r.code === 'revision-conflict') uni.showToast({ title: '对方已修改，请刷新后重试', icon: 'none', duration: 2500 })
    else uni.showToast({ title: r.message || '删除失败，请重试', icon: 'none', duration: 2500 })
    // 操作后重拉并重映射（删除立即从可见列表消失）
    await familyStore.pullReports()
    remapFamilyUnarchived()
    return
  }
  uni.showLoading({ title: '删除中…' })
  try {
    const result = await reportStore.deleteReport(deleteTargetId.value)
    if (result && result.ok && result.persisted !== false) {
      await reportStore.syncReportsFromCloud()
      uni.hideLoading()
      uni.showToast({ title: '已删除', icon: 'none' })
    } else {
      uni.hideLoading()
      // 云端未确认删除或本机写入失败：本地保留/如实提示，不显示删除成功
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

/* ── Empty State ── */
.empty-state {
  flex: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: center;
}
.empty-icon { font-size: 80rpx; margin-bottom: 20rpx; }
.empty-title { font-size: 32rpx; font-weight: 600; color: #3A3834; }

/* ── Nav Action Text ── */
.nav-action-text { font-size: 26rpx; font-weight: 600; color: #E8637A; flex-shrink: 0; }
.nav-action-disabled { color: #C8C4BC; }

/* ── Instruction ── */
.instruction { padding: 24rpx 32rpx 0; }
.instruction-text { font-size: 26rpx; color: #9C9890; line-height: 1.6; }

/* ── Scroll ── */
.scroll { flex: 1; padding: 24rpx 0; }

/* ── Unarchived Item ── */
.unarchived-item {
  margin: 0 32rpx 20rpx; background: white;
  border-radius: 32rpx; padding: 28rpx;
  display: flex; gap: 24rpx; align-items: center;
  box-shadow: 0 4rpx 32rpx rgba(0, 0, 0, 0.07);
}
.unarchived-thumb {
  width: 112rpx; height: 112rpx; background: #F2F0EE;
  border-radius: 20rpx; display: flex; align-items: center;
  justify-content: center; flex-shrink: 0; overflow: hidden;
}
.unarchived-thumb-img { width: 100%; height: 100%; }
.unarchived-thumb-icon { font-size: 48rpx; }
.unarchived-info { flex: 1; }
.unarchived-name { font-size: 28rpx; font-weight: 500; color: #1C1A17; margin-bottom: 6rpx; display: block; }
.unarchived-date { font-size: 24rpx; color: #9C9890; display: block; }

/* ── Actions ── */
.unarchived-actions {
  display: flex; flex-direction: column; gap: 12rpx; flex-shrink: 0;
}
.classify-btn {
  background: #FDEEF1;
  border-radius: 999px; padding: 10rpx 24rpx;
}
.classify-btn-text { font-size: 24rpx; font-weight: 600; color: #E8637A; white-space: nowrap; }
.delete-btn {
  background: #FAF9F8;
  border-radius: 999px; padding: 10rpx 24rpx;
}
.delete-btn-text { font-size: 24rpx; font-weight: 500; color: #C0405A; white-space: nowrap; }

/* ── 确认弹窗风格 (参考退出登录) ── */
.logout-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.logout-card {
  width: 80%;
  background: #FFFFFF;
  border-radius: 48rpx;
  padding: 48rpx 40rpx 36rpx;
  box-shadow: 0 16rpx 64rpx rgba(0, 0, 0, 0.15);
}

.logout-modal-title {
  display: block;
  text-align: center;
  font-size: 36rpx;
  font-weight: 700;
  color: #333333;
}

.logout-modal-desc {
  display: block;
  text-align: center;
  font-size: 28rpx;
  color: #666666;
  line-height: 1.7;
  margin-top: 20rpx;
  white-space: pre-line;
}

.logout-modal-actions {
  display: flex;
  gap: 24rpx;
  margin-top: 40rpx;
}

.logout-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 88rpx;
  border-radius: 88rpx;
  font-size: 30rpx;
  font-weight: 600;
}

.logout-btn-cancel {
  background: #F5F5F5;
  color: #333333;
}

.logout-btn-confirm {
  background: #E8637A;
  color: #FFFFFF;
}
</style>
