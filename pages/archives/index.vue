<template>
  <view class="page">
    <!-- NavBar -->
    <NavBar title="产检档案" :showBack="false" />

    <!-- Loading State -->
    <view v-if="loading" class="loading-state">
      <text class="loading-text">加载中…</text>
    </view>

    <!-- Error State -->
    <view v-else-if="loadError" class="error-state">
      <text class="error-icon">⚠️</text>
      <text class="error-title">{{ loadError }}</text>
      <text class="error-hint">{{ loadErrorHint }}</text>
      <view class="error-retry" @tap="retryLoad">
        <text class="error-retry-text">重新加载</text>
      </view>
    </view>

    <!-- Empty State (no reports at all) -->
    <view v-else-if="reportStore.reports.length === 0 && reportStore.unarchivedReports.length === 0" class="empty-state">
      <text class="empty-icon">📋</text>
      <text class="empty-title">还没有产检报告</text>
      <text class="empty-hint">点击右上角 + 上传第一份报告吧</text>
    </view>
    <view v-else-if="reportStore.reports.length === 0" class="empty-state" @tap="onBannerTap">
      <text class="empty-icon">🗂</text>
      <text class="empty-title">报告待分类</text>
      <text class="empty-hint">{{ reportStore.unarchivedReports.length }} 份报告已上传，点击整理分类归档</text>
    </view>

    <!-- Has Reports -->
    <template v-else>
      <!-- Search & Filter Row -->
      <view class="search-row">
        <view class="search-box-wrap">
          <text class="search-icon">🔍</text>
          <input
            class="search-box"
            placeholder="搜索报告类型、日期…"
            placeholder-class="search-placeholder"
            :value="searchKeyword"
            @input="onSearchInput"
          />
          <text v-if="searchKeyword" class="search-clear" @tap="clearSearch">✕</text>
        </view>
        <view class="filter-btn" :class="{ 'filter-btn-active': reportStore.hasActiveFilter }" @tap="showFilterSheet = true">
          <text class="filter-text" :class="{ 'filter-text-active': reportStore.hasActiveFilter }">
            筛选 {{ reportStore.activeFilterCount > 0 ? '①'.repeat(reportStore.activeFilterCount) : '▾' }}
          </text>
        </view>
      </view>

      <!-- Horizontal Tabs -->
      <view class="tabs-wrap">
        <scroll-view scroll-x class="tabs-scroll" :show-scrollbar="false">
          <view class="tabs">
            <view
              v-for="(tab, idx) in tabDefs"
              :key="idx"
              class="tab"
              :class="{ active: reportStore.currentFilter.tab === tab.key }"
              @tap="onTabTap(tab.key)"
            >
              <text class="tab-label" :class="{ 'tab-label-active': reportStore.currentFilter.tab === tab.key }">{{ tab.name }}</text>
              <text
                v-if="reportStore.tabCounts[idx]"
                class="tab-count"
                :class="{ 'tab-count-active': reportStore.currentFilter.tab === tab.key }"
              >{{ reportStore.tabCounts[idx] }}</text>
            </view>
          </view>
        </scroll-view>
      </view>

      <!-- Scrollable List -->
      <scroll-view scroll-y class="scroll">
        <!-- Unarchived Banner -->
        <view v-if="reportStore.unarchivedReports.length > 0" class="unarchived-banner" @tap="onBannerTap">
          <view class="banner-dot"></view>
          <text class="banner-text"><text class="banner-strong">{{ reportStore.unarchivedReports.length }} 份报告</text>待分类，点击整理</text>
          <text class="banner-arrow">›</text>
        </view>

        <!-- Search No Results -->
        <view v-if="reportStore.filteredReports.length === 0 && reportStore.reports.length > 0" class="search-empty">
          <text class="search-empty-text">没有找到相关报告</text>
          <view class="search-empty-btn" @tap="clearSearch">
            <text class="search-empty-btn-text">清除搜索</text>
          </view>
        </view>

        <!-- Grouped Report Cards -->
        <template v-for="(group, gIdx) in reportStore.groupedReports" :key="gIdx">
          <view class="section-header">
            <text class="section-header-text">{{ group.month }}</text>
          </view>
          <view
            v-for="(report) in group.reports"
            :key="report._id"
            class="report-card"
            @tap="onReportTap(report)"
          >
            <view class="report-thumb">
              <image v-if="report.file_urls && report.file_urls[0]" :src="report.file_urls[0]" mode="aspectFill" class="report-thumb-img" />
              <text v-else class="report-thumb-icon">{{ getTypeInfo(report.report_type).icon }}</text>
            </view>
            <view class="report-info">
              <view class="report-top">
                <text class="type-badge" :class="getTypeInfo(report.report_type).typeClass">{{ getTypeInfo(report.report_type).label }}</text>
                <text class="report-date">{{ formatDateShort(report.report_date) }}</text>
              </view>
              <text class="report-title">{{ report.report_name || getTypeInfo(report.report_type).label }}</text>
              <view class="report-meta">
                <text v-if="report.week_of_pregnancy" class="report-meta-text">孕 {{ report.week_of_pregnancy }} 周</text>
                <text class="ai-tag" :class="report.ai_status === 'done' ? 'done' : 'pending'">
                  {{ report.ai_status === 'done' ? '✦ 已解读' : '未解读' }}
                </text>
              </view>
            </view>
          </view>
        </template>
      </scroll-view>
    </template>

    <!-- Upload Sheet -->
    <UploadSheet v-model:show="showUploadSheet" @select="onUploadSelect" />

    <!-- FAB Button -->
    <!-- family 报告域待同步/失败重试横幅 -->
    <view v-if="dataSource === 'family' && reportPendingCount > 0" class="sync-banner" style="position:static;margin-bottom:16rpx;">
      <view class="sync-banner-row">
        <text class="sync-banner-title">{{ reportPendingCount }} 份报告待同步</text>
        <view class="sync-banner-btn" @tap="retryReportSync"><text class="sync-banner-btn-text">重试同步</text></view>
      </view>
    </view>

    <!-- family 报告域冲突卡（本地 vs 云端 + 显式解决） -->
    <view v-if="dataSource === 'family' && reportConflicts.length > 0" class="sync-banner" style="position:static;">
      <view class="sync-banner-row">
        <text class="sync-banner-title">{{ reportConflicts.length }} 份报告冲突待处理</text>
      </view>
      <view v-for="ce in reportConflicts" :key="ce.id" class="conflict-card">
        <text class="conflict-title">「{{ conflictLabel(ce) }}」双方都做了修改</text>
        <view v-if="ce.currentRecord && ce.currentRecord.deleted" class="conflict-row">
          <text class="conflict-side">状态</text>
          <text class="conflict-val">云端已删除（采用云端=放弃本条编辑）</text>
        </view>
        <view v-for="d in conflictDiff(ce)" :key="d.label" class="conflict-row">
          <text class="conflict-side">{{ d.label }}</text>
          <text class="conflict-val">我的：{{ d.mine }} · 云端：{{ d.cloud }}</text>
        </view>
        <view class="conflict-actions recover-actions">
          <view class="conflict-btn conflict-btn-ghost" @tap="adoptCloudReport(ce.id)"><text class="conflict-btn-ghost-text">采用云端</text></view>
          <view class="conflict-btn conflict-btn-solid" @tap="resubmitReport(ce.id)"><text class="conflict-btn-solid-text">确认重提</text></view>
        </view>
      </view>
    </view>

    <!-- 未完成批次（持久清单跨重启）：续传/去分类 -->
    <view v-if="dataSource === 'family' && reportFamilyStore.activeBatches.length > 0" class="recover-card" style="bottom: 340rpx;">
      <view class="recover-body">
        <text class="recover-title">{{ reportFamilyStore.activeBatches.length }} 个未完成上传批次</text>
        <text class="recover-desc" v-for="b in reportFamilyStore.activeBatches" :key="b.batchId">批次 {{ b.items.length }} 张 · {{ b.status === 'ready' ? '已登记，待填写报告信息' : b.status === 'partial' ? '部分未完成' : '上传中' }}</text>
      </view>
      <view class="conflict-actions recover-actions">
        <view class="conflict-btn conflict-btn-solid" @tap="resumeBatch(reportFamilyStore.activeBatches[0].batchId)"><text class="conflict-btn-solid-text">继续处理</text></view>
      </view>
    </view>

    <!-- 清单落盘失败恢复卡（family：saveFile 已移动临时文件，句柄唯一） -->
    <view v-if="dataSource === 'family' && reportFamilyStore.lastRecovery && reportFamilyStore.recoveryIdentityMatches(reportFamilyStore.lastRecovery)" class="save-failed-banner recover-card">
      <view class="recover-body">
        <text class="recover-title">{{ reportFamilyStore.lastRecovery.items.filter(i => i.savedFilePath).length }} 张原件已保存但未开始上传</text>
        <text class="recover-desc">上次批次清单写入本机失败；可恢复上传或放弃（放弃将删除本机原件）。{{ reportFamilyStore.lastRecovery.persisted ? '恢复信息已保存，重启后仍可恢复。' : '恢复信息未能落盘，仅保存在内存中，退出应用后可能无法恢复。' }}</text>
      </view>
      <view class="conflict-actions recover-actions">
        <view class="conflict-btn conflict-btn-ghost" @tap="discardRecoveryNow"><text class="conflict-btn-ghost-text">放弃</text></view>
        <view class="conflict-btn conflict-btn-solid" @tap="recoverUploadNow"><text class="conflict-btn-solid-text">恢复上传</text></view>
      </view>
    </view>

    <view class="fab-btn" @tap="showUploadSheet = true">
      <text class="fab-icon">+</text>
    </view>

    <!-- Filter Overlay -->
    <view v-if="showFilterSheet" class="overlay" @tap="showFilterSheet = false">
      <view class="overlay-spacer"></view>
      <view class="filter-sheet" @tap.stop>
        <view class="sheet-handle"></view>
        <text class="filter-sheet-title">筛选条件</text>

        <!-- Week Range -->
        <view class="filter-section">
          <text class="filter-section-label">孕周范围</text>
          <view class="week-range-row">
            <text class="week-label">孕 {{ filterWeekMin }} 周</text>
            <view class="week-slider-wrap">
              <slider
                :min="1" :max="40" :value="filterWeekMin"
                activeColor="#E8637A" backgroundColor="#F2F0EE"
                block-size="20"
                @change="e => filterWeekMin = e.detail.value"
              />
            </view>
            <text class="week-label">孕 {{ filterWeekMax }} 周</text>
          </view>
          <view class="week-range-row">
            <text class="week-label">至</text>
            <view class="week-slider-wrap">
              <slider
                :min="1" :max="40" :value="filterWeekMax"
                activeColor="#E8637A" backgroundColor="#F2F0EE"
                block-size="20"
                @change="e => filterWeekMax = e.detail.value"
              />
            </view>
            <text class="week-label"></text>
          </view>
        </view>

        <!-- Time Range -->
        <view class="filter-section">
          <text class="filter-section-label">时间范围</text>
          <view class="time-range-options">
            <view
              v-for="opt in timeRangeOptions"
              :key="opt.value"
              class="time-opt"
              :class="{ 'time-opt-active': filterTimeRange === opt.value }"
              @tap="filterTimeRange = opt.value"
            >
              <text class="time-opt-text" :class="{ 'time-opt-text-active': filterTimeRange === opt.value }">{{ opt.label }}</text>
            </view>
          </view>
        </view>

        <!-- Filter Actions -->
        <view class="filter-actions">
          <view class="filter-reset" @tap="resetFilter">
            <text class="filter-reset-text">重置</text>
          </view>
          <view class="filter-confirm" @tap="applyFilter">
            <text class="filter-confirm-text">确定</text>
          </view>
        </view>
      </view>
    </view>
    <CustomTabBar :active="2" />
  </view>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { navigateToPage } from '@/utils/navigation.js'
import UploadSheet from './components/UploadSheet.vue'
import NavBar from '@/components/NavBar.vue'
import CustomTabBar from '@/components/CustomTabBar.vue'
import { useReportStore, TAB_DEFS, getTypeInfo } from '@/stores/report'
import { getSessionState, subscribeSession, isExplicitDemo, isExplicitLoggedOut, settleConfirm } from '@/services/sessionService.js'
import { useFamilyStore } from '@/services/familyStore.js'
import { useReportFamilyStore } from '@/services/reportFamilyStore.js'
import { getOutbox } from '@/services/outbox.js'
import { fetchReportReadUrls } from '@/services/fileUploadService.js'
import { watch } from 'vue'

const reportStore = useReportStore()
const tabDefs = TAB_DEFS
const familyStore = useFamilyStore()
const reportFamilyStore = useReportFamilyStore()

// ── family 报告域冲突卡（与 B2a 健康域同模式：本地 vs 云端 + 采用云端/确认重提）──
const reportConflicts = computed(() => {
  // 直接筛选 familyStore.conflictEntries（响应式）——不用 require
  return familyStore.conflictEntries.filter(e => e.kind && e.kind.startsWith('report'))
})
// 报告域待同步（非冲突）数量与重试
// 报告域待同步（非冲突）：顶层静态 import getOutbox，按 kind 过滤 report 域；
// 响应式失效源沿用 store 版本（pendingCount/conflictEntries 变化即重算）
const reportPendingCount = computed(() => {
  void familyStore.pendingCount
  void familyStore.conflictEntries
  try {
    return getOutbox().filter(e =>
      (e.kind === 'report' || e.kind === 'report-delete') && !e.conflict).length
  } catch (e) { return 0 }
})
async function retryReportSync() {
  await familyStore.flushAll()
  loadData()
}
function conflictLabel(entry) {
  return entry.kind.startsWith('report') ? '报告' : '记录'
}
function conflictDiff(entry) {
  const p = entry.payload || {}
  const c = entry.currentRecord || {}
  const fields = []
  const push = (label, mine, cloud) => {
    if (mine !== undefined || cloud !== undefined) {
      fields.push({ label, mine: mine === undefined || mine === null ? '(空)' : String(mine), cloud: cloud === undefined || cloud === null ? '(空)' : String(cloud) })
    }
  }
  push('日期', p.dateKey, c.dateKey)
  push('类型', p.reportType, c.reportType)
  push('归档', p.archiveStatus, c.archiveStatus)
  push('备注', p.note, c.note)
  return fields
}
async function adoptCloudReport(entryId) {
  const ok = await familyStore.adoptCloud(entryId)
  if (!ok) uni.showToast({ title: '获取云端版本失败，待办已保留', icon: 'none', duration: 2500 })
  else uni.showToast({ title: '已采用云端版本', icon: 'none' })
  loadData()
}
async function resubmitReport(entryId) {
  const r = await familyStore.resubmit(entryId)
  if (r && r.ok) {
    uni.showToast({ title: '已重新提交', icon: 'none' })
    loadData()
  } else if (r && r.code === 'revision-conflict') {
    uni.showToast({ title: '云端又有更新，请采用云端或稍后再试', icon: 'none', duration: 2500 })
  } else {
    uni.showToast({ title: (r && r.message) || '提交失败，待办已保留', icon: 'none', duration: 2500 })
  }
}

// B2b2 三态数据源：family=mc-reports 权威 / demo=旧本地 / prompt=空
const dataSource = ref(isExplicitDemo() ? 'demo' : (getSessionState().status === 'confirmed' && !isExplicitLoggedOut() ? 'family' : 'prompt'))
watch(subscribeSession(), () => {
  dataSource.value = isExplicitDemo() ? 'demo' : (getSessionState().status === 'confirmed' && !isExplicitLoggedOut() ? 'family' : 'prompt')
  if (dataSource.value === 'family') {
    loadData()
  } else if (dataSource.value !== 'demo') {
    // 会话失效：映射进旧 store 的报告副本、缩略临时 URL 一并清除——
    // 不因数据源搬家丢失原有隔离保证
    famThumbUrls.value = {}
    reportStore.reports = []
    reportStore.unarchivedReports = []
    loading.value = false
  }
})

// family 权威报告 → 旧模板消费形状
function famReportToLegacy(r) {
  if (!r || r.deleted) return null
  return {
    _id: r.id,
    report_type: r.reportType,
    report_date: r.dateKey,
    archive_status: r.archiveStatus,
    note: r.note || '',
    file_urls: [], // 附件以 fileId 引用；缩略/预览临时 URL 按需签发（不持久化）
    _attachmentCount: (r.attachments || []).length,
    _cloud: true
  }
}
// family 缩略图：首批报告首附件的临时 URL（会话内使用）
const famThumbUrls = ref({})
async function loadFamilyThumbs(list) {
  for (const r of list.slice(0, 20)) {
    const first = r.attachments && r.attachments[0]
    if (!first || famThumbUrls.value[r.id]) continue
    const res = await fetchReportReadUrls(r.id)
    if (res.ok && res.urls[0]) famThumbUrls.value = { ...famThumbUrls.value, [r.id]: res.urls[0].tempFileURL }
  }
}
const famReports = computed(() => Object.values(familyStore.reports)
  .filter(r => !r.deleted && r.archiveStatus === 'archived').map(famReportToLegacy))

// 实际模板消费：把【当前】权威 family 数据（含恢复的成员快照）映射进 reportStore
// 派生源——模板/筛选/分组/计数全部经由 store computeds 消费 family 数据；
// 提升到页面作用域供 loadData 与 onShow 共用：详情页删除已给权威记录打墓碑，
// onShow 先本地重映射即可让已删条目（含概览图）立即下屏，不依赖网络拉取
function mapFamilyReports() {
  const mapped = Object.values(familyStore.reports)
    .filter(r => !r.deleted)
    .map(r => ({
      _id: r.id,
      report_type: r.reportType,
      report_date: r.dateKey,
      archive_status: r.archiveStatus,
      note: r.note || '',
      file_urls: famThumbUrls.value[r.id] ? [famThumbUrls.value[r.id]] : [],
      _attachmentCount: (r.attachments || []).length,
      _cloud: true
    }))
  reportStore.reports = mapped.filter(r => r.archive_status === 'archived')
  reportStore.unarchivedReports = mapped.filter(r => r.archive_status !== 'archived')
}

const showUploadSheet = ref(false)
const showFilterSheet = ref(false)
const loading = ref(true)
const searchKeyword = ref('')
const loadError = ref('')
const loadErrorHint = ref('') // 真实失败原因（R7：替代写死的"数据库配额"猜测文案）
const lastLoadTime = ref(0)
const LOAD_COOLDOWN = 2000 // 2秒冷却时间

// Filter state
const filterWeekMin = ref(1)
const filterWeekMax = ref(40)
const filterTimeRange = ref(null)

const timeRangeOptions = [
  { label: '近 1 个月', value: '1m' },
  { label: '近 3 个月', value: '3m' },
  { label: '近 6 个月', value: '6m' },
  { label: '全部', value: null }
]

let searchTimer = null

onMounted(async () => {
  await loadData()
})

onShow(async () => {
  // family 模式：权威 store 可能已被他处更新（如详情页删除打墓碑）——
  // 先本地重映射让列表立即正确，再走既有刷新判定（不动"避免频繁查询"门槛）
  if (dataSource.value === 'family') {
    mapFamilyReports()
  }

  // 检查是否需要刷新（AI 解读后会设置标志）
  if (reportStore.listNeedsRefresh) {
    reportStore.listNeedsRefresh = false
    await loadData()
    return
  }

  // 只在数据为空时重新加载，避免频繁查询
  if (reportStore.reports.length === 0 && reportStore.unarchivedReports.length === 0) {
    await loadData()
  }
})

async function loadData() {
  // 防止频繁查询
  const now = Date.now()
  if (now - lastLoadTime.value < LOAD_COOLDOWN) {
    console.log('Load cooldown active, skipping')
    return
  }
  lastLoadTime.value = now

  if (dataSource.value === 'family') {
    loading.value = true
    loadError.value = ''
    loadErrorHint.value = ''
    // 冷启动/回前台确认在途时不发拉取（R7）：等确认落定再拉，消除
    // "身份确认进行中"被误报成"同步失败"整页错误
    await settleConfirm()
    mapFamilyReports()
    const res = await familyStore.pullReports()
    if (res.ok) {
      mapFamilyReports()
      await loadFamilyThumbs(Object.values(familyStore.reports).filter(r => !r.deleted))
      mapFamilyReports() // 缩略 URL 就绪后刷新一次
    } else if (reportStore.reports.length === 0 && reportStore.unarchivedReports.length === 0) {
      loadError.value = '同步失败，请重试' // 仅无任何可显示内容时提示错误；暖数据不被错误提示遮蔽
      loadErrorHint.value = res.message || res.code || '网络异常或云端暂时不可用，请稍后重试' // 真实原因，不做配额猜测
    }
    loading.value = false
    return
  }
  if (dataSource.value === 'prompt') {
    loading.value = false
    return
  }
  loading.value = true
  loadError.value = ''
  loadErrorHint.value = ''
  try {
    await Promise.all([
      reportStore.fetchReports(),
      reportStore.fetchUnarchivedReports()
    ])
    loading.value = false
  } catch (e) {
    console.error('loadData error:', e)
    // 如果有缓存数据，不显示错误，让用户看到缓存的内容
    if (reportStore.reports.length > 0 || reportStore.unarchivedReports.length > 0) {
      // 有缓存数据，不设置错误状态
      console.log('Using cached data due to fetch error')
    } else {
      // 没有缓存数据，显示错误
      loadError.value = '云端服务暂时不可用，请稍后重试'
      loadErrorHint.value = (e && (e.errMsg || e.message)) || '网络异常或云端暂时不可用'
    }
    loading.value = false
  }
}

function retryLoad() {
  // 重置冷却时间并重新加载（返回 promise 供测试/调用方等待完成）
  lastLoadTime.value = 0
  return loadData()
}

function onTabTap(key) {
  reportStore.setFilter({ tab: key })
}

function onSearchInput(e) {
  const val = e.detail.value
  searchKeyword.value = val
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    reportStore.setFilter({ keyword: val })
  }, 300)
}

function clearSearch() {
  searchKeyword.value = ''
  reportStore.setFilter({ keyword: '' })
}

function formatDateShort(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${m}/${day}`
}

function onBannerTap() {
  navigateToPage('/pages/archives/unarchived')
}

function onReportTap(report) {
  navigateToPage(`/pages/archives/detail?id=${report._id}`)
}

function resumeBatch(batchId) {
  const b = reportFamilyStore.batch(batchId)
  if (!b) return
  if (b.status === 'uploading' || b.status === 'partial') {
    reportFamilyStore.retryBatch(batchId).catch(() => {})
    uni.showToast({ title: '已重试未完成项', icon: 'none' })
  }
  navigateToPage('/pages/archives/classify?source=p2&batchId=' + encodeURIComponent(batchId))
}

async function recoverUploadNow() {
  const r = await reportFamilyStore.recoverFromSavedPaths()
  if (r.ok && r.batchId) {
    uni.showToast({ title: '已恢复上传批次', icon: 'none' })
    if (r.processing) r.processing.catch(() => {})
    navigateToPage('/pages/archives/classify?source=p2&batchId=' + encodeURIComponent(r.batchId))
  } else {
    uni.showToast({ title: r.message || '恢复失败，原件已保留', icon: 'none', duration: 2500 })
  }
}
function discardRecoveryNow() {
  reportFamilyStore.discardRecovery()
  uni.showToast({ title: '已放弃并清理本机原件', icon: 'none' })
}

function onUploadSelect(result) {
  if (dataSource.value === 'family' && result.batchId) {
    // B2b2：一次选图构成一份多页报告；导航携带持久批次 ID 进入可恢复分类
    navigateToPage('/pages/archives/classify?source=p2&batchId=' + encodeURIComponent(result.batchId))
    return
  }
  if (result.fileCount === 1) {
    navigateToPage('/pages/archives/classify?source=p2')
  } else {
    navigateToPage('/pages/archives/batch?source=p2')
  }
}

function applyFilter() {
  const wr = (filterWeekMin.value > 1 || filterWeekMax.value < 40)
    ? { min: filterWeekMin.value, max: filterWeekMax.value }
    : null
  reportStore.setFilter({
    weekRange: wr,
    timeRange: filterTimeRange.value
  })
  showFilterSheet.value = false
}

function resetFilter() {
  filterWeekMin.value = 1
  filterWeekMax.value = 40
  filterTimeRange.value = null
  reportStore.resetFilter()
  showFilterSheet.value = false
}
</script>

<style scoped lang="scss">
/* ── CSS Variables from Prototype ── */
page {
  --rose: #E8637A;
  --rose-light: #FDEEF1;
  --rose-mid: #F5B8C4;
  --rose-dark: #C0405A;
  --teal-light: #E6F7F4;
  --amber: #F0A940;
  --amber-light: #FEF4E3;
  --purple-light: #F0ECFB;
  --blue-light: #EBF3FE;
  --green-light: #EAF7EF;
  --green: #5BBF7C;
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
  --shadow-lg: 0 8px 32px rgba(0, 0, 0, 0.10);
}

.page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background-color: #FAF9F8;
  font-family: 'DM Sans', 'Noto Sans SC', sans-serif;
  box-sizing: border-box;
}

/* ── Loading State ── */
.loading-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0 80rpx;
}

.loading-text {
  font-size: 28rpx;
  color: #9C9890;
}

/* ── Error State ── */
.error-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0 80rpx;
}

.error-icon {
  font-size: 80rpx;
  margin-bottom: 24rpx;
}

.error-title {
  font-size: 32rpx;
  font-weight: 600;
  color: #3A3834;
  margin-bottom: 12rpx;
}

.error-hint {
  font-size: 26rpx;
  color: #9C9890;
  margin-bottom: 32rpx;
  text-align: center;
}

.error-retry {
  padding: 16rpx 48rpx;
  background: #E8637A;
  border-radius: 999px;
}

.error-retry-text {
  font-size: 28rpx;
  font-weight: 600;
  color: white;
}

/* ── Empty State ── */
.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0 80rpx;
}

.empty-icon {
  font-size: 120rpx;
  margin-bottom: 32rpx;
  opacity: 0.5;
}

.empty-title {
  font-size: 32rpx;
  font-weight: 600;
  color: #3A3834;
  margin-bottom: 12rpx;
}

.empty-hint {
  font-size: 26rpx;
  color: #9C9890;
}

/* ── Nav Action Button ── */
.nav-action {
  width: 68rpx;
  height: 68rpx;
  border-radius: 50%;
  background: #E8637A;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  box-shadow: 0 4rpx 16rpx rgba(232, 99, 122, 0.35);
}

.nav-action-icon {
  font-size: 40rpx;
  font-weight: 300;
  color: white;
  line-height: 1;
}

/* ── Search Row ── */
.search-row {
  background: white;
  display: flex;
  padding: 20rpx 32rpx;
  gap: 16rpx;
  flex-shrink: 0;
}

.search-box-wrap {
  flex: 1;
  height: 72rpx;
  background: #F2F0EE;
  border-radius: 999px;
  display: flex;
  align-items: center;
  padding: 0 28rpx;
  gap: 12rpx;
}

.search-icon {
  font-size: 24rpx;
  flex-shrink: 0;
}

.search-box {
  flex: 1;
  height: 72rpx;
  font-size: 26rpx;
  color: #3A3834;
  background: transparent;
}

.search-placeholder {
  color: #C8C4BC;
  font-size: 26rpx;
}

.search-clear {
  font-size: 24rpx;
  color: #9C9890;
  padding: 8rpx;
}

.filter-btn {
  height: 72rpx;
  padding: 0 24rpx;
  background: #F2F0EE;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.filter-btn-active {
  background: #FDEEF1;
}

.filter-text {
  font-size: 24rpx;
  font-weight: 500;
  color: #6E6A64;
}

.filter-text-active {
  color: #E8637A;
}

/* ── Tabs ── */
.tabs-wrap {
  background: white;
  border-bottom: 1px solid #F2F0EE;
  flex-shrink: 0;
}

.tabs-scroll {
  white-space: nowrap;
}

.tabs {
  display: inline-flex;
  padding: 0 32rpx;
}

.tab {
  display: inline-flex;
  align-items: center;
  padding: 20rpx 28rpx;
  gap: 10rpx;
  border-bottom: 4rpx solid transparent;
}

.tab.active {
  border-bottom-color: #E8637A;
}

.tab-label {
  font-size: 26rpx;
  font-weight: 500;
  color: #9C9890;
  white-space: nowrap;
}

.tab-label-active {
  color: #E8637A;
}

.tab-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 36rpx;
  height: 36rpx;
  font-size: 20rpx;
  font-weight: 600;
  background: #FDEEF1;
  color: #C0405A;
  padding: 0 10rpx;
  border-radius: 999px;
  line-height: 1;
  /* 确保不同长度数字都有合适的宽度 */
  box-sizing: border-box;
}

.tab-count-active {
  background: #E8637A;
  color: white;
}

/* ── Scroll ── */
.scroll {
  flex: 1;
  padding-bottom: calc(220rpx + env(safe-area-inset-bottom));
}

/* ── Search Empty ── */
.search-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 120rpx 0;
}

.search-empty-text {
  font-size: 28rpx;
  color: #9C9890;
  margin-bottom: 24rpx;
}

.search-empty-btn {
  padding: 12rpx 32rpx;
  background: #F2F0EE;
  border-radius: 999px;
}

.search-empty-btn-text {
  font-size: 26rpx;
  color: #6E6A64;
}

/* ── Unarchived Banner ── */
.unarchived-banner {
  margin: 24rpx 32rpx 0;
  background: #FEF4E3;
  border: 1px solid #F5D38A;
  border-radius: 20rpx;
  padding: 20rpx 28rpx;
  display: flex;
  align-items: center;
  gap: 20rpx;
}

.banner-dot {
  width: 16rpx;
  height: 16rpx;
  border-radius: 50%;
  background: #F0A940;
  flex-shrink: 0;
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.banner-text {
  flex: 1;
  font-size: 26rpx;
  color: #8C6A1A;
}

.banner-strong {
  font-weight: 600;
}

.banner-arrow {
  font-size: 24rpx;
  color: #A07820;
}

/* ── Section Header ── */
.section-header {
  padding: 32rpx 32rpx 12rpx;
}

.section-header-text {
  font-size: 22rpx;
  font-weight: 600;
  color: #9C9890;
  letter-spacing: 0.06em;
}

/* ── Report Card ── */
.report-card {
  margin: 0 32rpx 20rpx;
  background: white;
  border-radius: 32rpx;
  padding: 28rpx;
  display: flex;
  gap: 24rpx;
  box-shadow: 0 4rpx 32rpx rgba(0, 0, 0, 0.07);
}

.report-thumb {
  width: 112rpx;
  height: 112rpx;
  border-radius: 20rpx;
  flex-shrink: 0;
  background: #F2F0EE;
  display: flex;
  align-items: center;
  justify-content: center;
}

.report-thumb-icon {
  font-size: 44rpx;
}

.report-thumb-img {
  width: 100%;
  height: 100%;
  border-radius: 20rpx;
}

.report-info {
  flex: 1;
  min-width: 0;
}

.report-top {
  display: flex;
  align-items: center;
  gap: 12rpx;
  margin-bottom: 6rpx;
}

.type-badge {
  font-size: 22rpx;
  font-weight: 600;
  padding: 4rpx 14rpx;
  border-radius: 999px;
}

.report-date {
  font-size: 24rpx;
  color: #9C9890;
  margin-left: auto;
  flex-shrink: 0;
}

.report-title {
  font-size: 28rpx;
  font-weight: 500;
  color: #1C1A17;
  margin-bottom: 8rpx;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.report-meta {
  display: flex;
  align-items: center;
  gap: 16rpx;
}

.report-meta-text {
  font-size: 24rpx;
  color: #9C9890;
}

.ai-tag {
  font-size: 22rpx;
  font-weight: 500;
  padding: 4rpx 14rpx;
  border-radius: 999px;
}

.ai-tag.done {
  background: #EAF7EF;
  color: #2D8A50;
}

.ai-tag.pending {
  background: #F2F0EE;
  color: #9C9890;
}

/* ── Type Badge Colors ── */
.type-blood { background: #FDEEF1; color: #C0405A; }
.type-ultrasound { background: #EBF3FE; color: #2A6FCC; }
.type-urine { background: #E6F7F4; color: #1A7A68; }
.type-screen { background: #F0ECFB; color: #5A40A8; }
.type-sugar { background: #FEF4E3; color: #8C5A10; }
.type-other { background: #F2F0EE; color: #6E6A64; }

/* ── Filter Overlay ── */
.overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  flex-direction: column;
  z-index: 1000;
}

.overlay-spacer {
  flex: 1;
}

.filter-sheet {
  background: white;
  border-radius: 56rpx 56rpx 0 0;
  padding: 40rpx 40rpx 64rpx;
}

.sheet-handle {
  width: 72rpx;
  height: 8rpx;
  background: #E4E1DC;
  border-radius: 4rpx;
  margin: 0 auto 40rpx;
}

.filter-sheet-title {
  font-size: 32rpx;
  font-weight: 600;
  color: #1C1A17;
  margin-bottom: 32rpx;
  display: block;
}

.filter-section {
  margin-bottom: 32rpx;
}

.filter-section-label {
  font-size: 24rpx;
  font-weight: 600;
  color: #9C9890;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 16rpx;
  display: block;
}

.week-range-row {
  display: flex;
  align-items: center;
  gap: 16rpx;
}

.week-label {
  font-size: 24rpx;
  color: #6E6A64;
  width: 100rpx;
  flex-shrink: 0;
}

.week-slider-wrap {
  flex: 1;
}

.time-range-options {
  display: flex;
  gap: 16rpx;
  flex-wrap: wrap;
}

.time-opt {
  padding: 14rpx 28rpx;
  background: #F2F0EE;
  border-radius: 999px;
}

.time-opt-active {
  background: #FDEEF1;
}

.time-opt-text {
  font-size: 24rpx;
  font-weight: 500;
  color: #6E6A64;
}

.time-opt-text-active {
  color: #E8637A;
}

.filter-actions {
  display: flex;
  gap: 20rpx;
  margin-top: 24rpx;
}

.filter-reset {
  flex: 1;
  height: 80rpx;
  background: #F2F0EE;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.filter-reset-text {
  font-size: 28rpx;
  font-weight: 500;
  color: #6E6A64;
}

.filter-confirm {
  flex: 2;
  height: 80rpx;
  background: #E8637A;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.filter-confirm-text {
  font-size: 28rpx;
  font-weight: 600;
  color: white;
}

.recover-card { margin: 0 28rpx 20rpx; padding: 24rpx; background: #FEF4E3; border: 2rpx solid rgba(240,169,64,0.4); border-radius: 20rpx; position: fixed; left: 0; right: 0; bottom: 200rpx; z-index: 90; }
.recover-body { margin-bottom: 16rpx; }
.recover-title { font-size: 26rpx; font-weight: 600; color: #B07818; display: block; }
.recover-desc { font-size: 22rpx; color: #B07818; opacity: 0.85; margin-top: 6rpx; display: block; line-height: 1.5; }
.recover-actions { margin-top: 0; }
.conflict-actions { display: flex; gap: 16rpx; }
.conflict-btn { flex: 1; height: 64rpx; border-radius: 32rpx; display: flex; align-items: center; justify-content: center; }
.conflict-btn-ghost { background: #F2F0EE; }
.conflict-btn-solid { background: #C98A3A; }
.conflict-btn-ghost-text { font-size: 24rpx; font-weight: 600; color: #6E6A64; }
.conflict-btn-solid-text { font-size: 24rpx; font-weight: 600; color: #FFFFFF; }

.sync-banner { margin: 0 28rpx 20rpx; padding: 20rpx 24rpx; background: #FEF4E3; border: 2rpx solid rgba(240,169,64,0.4); border-radius: 20rpx; }
.sync-banner-row { display: flex; align-items: center; justify-content: space-between; }
.sync-banner-title { font-size: 26rpx; font-weight: 600; color: #B07818; }
.conflict-card { margin-top: 16rpx; padding: 20rpx; background: #FFFFFF; border: 2rpx solid rgba(240,169,64,0.5); border-radius: 16rpx; }
.conflict-title { font-size: 24rpx; font-weight: 600; color: #8C5A10; display: block; margin-bottom: 12rpx; }
.conflict-row { display: flex; gap: 12rpx; margin-bottom: 8rpx; align-items: flex-start; }
.conflict-side { font-size: 22rpx; color: #9C9890; flex-shrink: 0; width: 80rpx; }
.conflict-val { font-size: 22rpx; color: #4A4844; line-height: 1.5; flex: 1; }
.conflict-actions { display: flex; gap: 16rpx; margin-top: 12rpx; }

/* ── FAB Button ── */
.fab-btn {
  position: fixed;
  right: 32rpx;
  bottom: calc(180rpx + env(safe-area-inset-bottom));
  width: 88rpx;
  height: 88rpx;
  border-radius: 50%;
  background: #E8637A;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 8rpx 32rpx rgba(232, 99, 122, 0.4);
  z-index: 100;
}

.fab-icon {
  font-size: 48rpx;
  font-weight: 300;
  color: white;
  line-height: 1;
  transform: translateY(-2rpx);
}
</style>
