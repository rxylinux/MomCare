<template>
	<view class="page">
		<!-- Hero -->
		<view class="hero-gray">
			<NavBar title="隐私与数据" theme="dark" transparent :showBack="true" class="hero-navbar" />
			<view class="hero-content">
				<text class="hero-label">本机数据</text>
				<text class="hero-val">{{ totalRecords }}<text class="hero-unit">条</text></text>
				<text class="hero-sub">{{ dataModeText }}</text>
			</view>
		</view>

		<scroll-view scroll-y class="scroll-content">
			<!-- 存储说明（如实描述，不做无依据的加密承诺） -->
			<view class="privacy-banner">
				<text class="pb-icon">ℹ️</text>
				<text class="pb-text">健康记录与报告信息保存在本机存储中；登录后资料会同步到服务端。数据传输与存储依赖平台能力，本应用不承诺端到端加密，请勿在记录中保存敏感证件信息。</text>
			</view>

			<!-- 数据概览：来自真实存储计数 -->
			<view class="sec">
				<text class="sec-lbl">我的数据概览</text>
				<view class="data-list">
					<view v-for="(d, idx) in dataItems" :key="idx" class="data-item">
						<view class="di-icon" :style="{ background: d.iconBg }">
							<text class="di-icon-text">{{ d.icon }}</text>
						</view>
						<view class="di-body">
							<text class="di-title">{{ d.title }}</text>
							<text class="di-count">{{ d.count }}</text>
						</view>
					</view>
				</view>
			</view>

				<!-- 同步状态：真实结果 -->
				<view class="sec">
					<text class="sec-lbl">同步状态</text>
					<view class="action-card">
						<view class="action-row">
							<view class="action-icon" :style="{ background: '#EBF2FB' }">
								<text class="action-icon-text">☁️</text>
							</view>
							<view class="action-title">云端同步</view>
							<text class="action-tag" :style="{ color: '#757575' }">{{ syncStatusText }}</text>
						</view>
						<!-- 等待旧同步释放超时——显式重试入口（不静默放弃健康概览） -->
						<view v-if="syncStalled" class="action-row" @tap="refreshAuthoritative">
							<view class="action-icon" :style="{ background: '#FDF3E3' }">
								<text class="action-icon-text">🔄</text>
							</view>
							<view class="action-title">重试同步</view>
							<text class="action-tag" :style="{ color: '#B07818' }">上次等待超时</text>
						</view>
						<!-- 演示模式不展示正式档案的备份信息 -->
						<view class="action-row" v-if="!demoMode && backupItems.length > 0">
							<view class="action-icon" :style="{ background: '#F0ECFB' }">
								<text class="action-icon-text">📦</text>
							</view>
							<view class="action-title">本机备份</view>
							<text class="action-tag" :style="{ color: '#757575' }">{{ backupItems.length }} 份</text>
						</view>
					</view>
				</view>

			<!-- 数据管理 -->
			<view class="sec">
				<text class="sec-lbl">数据管理</text>
				<view class="action-card">
					<view v-for="(a, idx) in actionItems" :key="idx" class="action-row" @tap="handleAction(a)">
						<view class="action-icon" :style="{ background: a.iconBg }">
							<text class="action-icon-text">{{ a.icon }}</text>
						</view>
						<text class="action-title" :class="{ 'text-danger': a.danger }">{{ a.title }}</text>
						<text v-if="a.tag" class="action-tag" :style="{ color: a.tagColor }">{{ a.tag }}</text>
						<text class="action-arrow" :style="{ color: a.danger ? '#E05050' : '#C8C4BC' }">›</text>
					</view>
				</view>
				<text class="sec-note">导出/恢复将在后续版本提供；注销账号需要服务端支持，当前版本不可用。</text>
			</view>

			<!-- B3a 旧数据来源预览入口（仅已确认正式会话） -->
			<view v-if="dataSource === 'family'" class="sec">
				<text class="sec-lbl">旧数据</text>
				<view class="action-card" @tap="goSourceScan">
					<view class="action-row">
						<text class="action-label">旧数据来源预览与迁移</text>
						<text class="action-arrow">›</text>
					</view>
					<text class="action-desc">扫描本机白名单旧键（健康/报告/待产包），预览并逐条确认后迁移到当前家庭</text>
				</view>
			</view>

			<view class="bottom-spacer"></view>
		</scroll-view>

		<!-- 危险操作确认弹窗 -->
		<ConfirmModal
			v-model:visible="showDangerModal"
			:title="dangerTitle"
			:content="dangerContent"
			confirmText="确定"
			confirmType="danger"
			@confirm="doDangerAction"
		/>
	</view>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import NavBar from '@/components/NavBar.vue'
import ConfirmModal from '@/components/common/ConfirmModal.vue'
import { getSessionState, subscribeSession, isExplicitDemo, isExplicitLoggedOut } from '@/services/sessionService.js'
import { useFamilyStore } from '@/services/familyStore.js'
import { navigateToPage } from '@/utils/navigation.js'

const familyStore = useFamilyStore()

// B3a 三态：可信会话+familyStore 统计（不读旧 healthStore/reportStore）
const dataSource = ref(isExplicitDemo() ? 'demo' : (getSessionState().status === 'confirmed' && !isExplicitLoggedOut() ? 'family' : 'prompt'))
// 权威概览刷新：健康域（孕期/日健康/心情，pullAll）与报告域（pullReports）【都】显式拉取——
// pullAll 不含报告；只拉健康就显示"正常"会让报告计数停留在缓存/零（不诚实）。
// 身份/epoch 作用域刷新令牌：每次触发取得新令牌，旧 continuation 的完成不得改动
// 新身份的 UI 状态（错误标记/在途标记）；pullAll 因旧身份占用 busy 时【保证 eventual
// 重试】——轮询直到旧同步释放（store 的 finally 必然释放）；仅设 60s 安全阀，
// 超阀显示显式重试入口（syncStalled），不静默放弃新身份的健康概览
const refreshToken = ref(0)
const refreshingDomains = ref(false)
const reportSyncError = ref('')
const syncStalled = ref(false)          // 健康域等待旧同步释放超时——显示显式重试入口
const reportSyncedThisEpoch = ref(false) // 报告计数来源：仅本次刷新成功拉取后才算权威
const retryDelay = ms => new Promise(r => setTimeout(r, ms))
async function pullHealthWithBusyRelease(myToken) {
  for (let tries = 0; ; tries++) {
    const r = await familyStore.pullAll()
    if (!r || r.reason !== 'busy') return { r, exhausted: false }
    if (myToken !== refreshToken.value) return { r, exhausted: false }
    // 安全阀：旧同步始终未释放（极端异常）——显式可见重试，不无限等待
    if (tries >= 600) return { r, exhausted: true }
    await retryDelay(100)
  }
}
async function refreshAuthoritative() {
  if (dataSource.value !== 'family') return
  const myToken = ++refreshToken.value
  refreshingDomains.value = true
  reportSyncError.value = ''
  syncStalled.value = false
  reportSyncedThisEpoch.value = false
  try {
    // pullReports 不吞异常（分页解析失败会 reject）——allSettled 两域互不拖累
    const [healthR, reportsR] = await Promise.allSettled([pullHealthWithBusyRelease(myToken), familyStore.pullReports()])
    // 旧 continuation：令牌已被更新的身份取代——不改写新身份的任何 UI 状态
    if (myToken !== refreshToken.value) return
    if (healthR.status === 'fulfilled' && healthR.value.exhausted) {
      syncStalled.value = true // 等待旧同步释放超时——提供显式重试入口
    }
    const rpt = reportsR.status === 'fulfilled' ? reportsR.value : null
    const softCodes = ['stale-session', 'unauthenticated-session', 'busy', 'no-session']
    if (rpt && rpt.ok) {
      reportSyncedThisEpoch.value = true // 本次刷新成功——报告计数为当前权威结果
    } else if (!rpt || !softCodes.includes(rpt && rpt.code)) {
      // 报告域拉取失败必须可见——不静默当作已完成；计数保持"本机缓存"标注
      reportSyncError.value = (rpt && (rpt.message || rpt.code)) ||
        (reportsR.reason && (reportsR.reason.message || reportsR.reason)) || '报告同步失败'
    }
  } finally {
    if (myToken === refreshToken.value) refreshingDomains.value = false
  }
}
watch(subscribeSession(), () => {
  dataSource.value = isExplicitDemo() ? 'demo' : (getSessionState().status === 'confirmed' && !isExplicitLoggedOut() ? 'family' : 'prompt')
  // 页面在未确认状态打开、随后完成确认——过渡后加载权威概览（健康+报告两域）
  if (dataSource.value === 'family') {
    refreshAuthoritative()
  }
})
if (dataSource.value === 'family') {
  refreshAuthoritative()
}

function goSourceScan() {
  navigateToPage('/pages/profile/data-source-scan')
}





const demoMode = computed(() => dataSource.value === 'demo')

const dataModeText = computed(() => demoMode.value
	? '演示模式 · 示例数据独立存放'
	: (dataSource.value === 'family' ? '正式档案 · 已确认身份' : dataSource.value === 'demo' ? '演示模式' : '正式档案 · 未确认'))

const dataItems = computed(() => {
	const dailyAll = Object.values(familyStore.daily || {}).filter(r => r && !r.deleted)
	const weightCount = dailyAll.filter(r => r && r.fields && r.fields.weightKg != null).length
	const bpCount = dailyAll.filter(r => r && r.fields && r.fields.systolic != null).length
	const fetalCount = dailyAll.filter(r => r && r.fields && r.fields.fetalCount != null).length
	const reportCount = Object.values(familyStore.reports || {}).filter(r => r && !r.deleted).length
	// 报告计数来源标注：仅【本次刷新】成功拉取报告域后才显示权威计数——
	// 持久化的 lastReportSyncAt（快照恢复）不代表本次挂载拉取成功，失败时保持"本机缓存"
	const reportTag = reportSyncedThisEpoch.value ? '' : '（本机缓存）'
	return [
		{ icon: '⚖️', iconBg: '#FAEAEE', title: '体重记录', count: `${weightCount} 条` },
		{ icon: '💗', iconBg: '#EBF2FB', title: '血压记录', count: `${bpCount} 条` },
		{ icon: '👣', iconBg: '#EAF2EE', title: '胎动记录', count: `${fetalCount} 条` },
		{ icon: '📁', iconBg: '#FDF3E3', title: '产检报告', count: `${reportCount} 份${reportTag}` }
	]
})

const totalRecords = computed(() => {
	return Object.values(familyStore.daily || {}).filter(r => r && !r.deleted).length
})

const syncStatusText = computed(() => {
	if (demoMode.value) return '演示模式不同步'
	if (dataSource.value === 'demo') return '演示模式，数据不出本机'
	if (dataSource.value !== 'family') return '未确认身份，仅本机'
	if (refreshingDomains.value || familyStore.syncing) return '同步中…'
	if (familyStore.lastError) return '同步异常：' + familyStore.lastError
	if (reportSyncError.value) return '报告同步异常：' + reportSyncError.value
	if (syncStalled.value) return '同步等待超时——请点下方重试'
	// "正常"须健康域与报告域【都】完成过权威拉取——只完成一半如实显示部分同步
	if (!familyStore.lastFullSyncAt && !familyStore.lastReportSyncAt) return '尚未完成同步'
	if (!familyStore.lastFullSyncAt || !familyStore.lastReportSyncAt) {
		return familyStore.lastFullSyncAt ? '部分同步：报告域未完成' : '部分同步：健康域未完成'
	}
	if (familyStore.pendingCount > 0) return familyStore.pendingCount + ' 项待同步'
	return '正常'
})

function formatTime(d) {
	return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const backupItems = ref([])

const actionItems = computed(() => [
	{ icon: '📦', iconBg: '#EBF2FB', title: '导出全部数据', tag: '暂不可用', tagColor: '#9C9890', danger: false, action: 'exportAll' },
	{ icon: '🔒', iconBg: '#FDF3E3', title: '隐私政策', danger: false, action: 'policy' },
	{
		// 清除能力未实现——如实标注"暂不可用"，不做红色可点破坏性样式、不承诺自动备份
		icon: '🗑', iconBg: '#F2F0EE', danger: false, action: 'clearCache',
		title: '清除本机数据',
		tag: '暂不可用',
		tagColor: '#9C9890'
	},
	{ icon: '⚠️', iconBg: '#FDEAEA', title: '注销账号并删除数据', tag: '暂不可用', tagColor: '#9C9890', danger: false, action: 'deleteAccount' }
])

function handleAction(item) {
	if (item.action === 'policy') {
		uni.showToast({ title: '隐私政策页面开发中', icon: 'none' })
		return
	}
	if (item.action === 'exportAll' || item.action === 'deleteAccount') {
		// 如实展示未实现，不弹假成功
		uni.showToast({ title: item.action === 'exportAll' ? '导出功能暂不可用' : '注销需要服务端支持，暂不可用', icon: 'none', duration: 2500 })
		return
	}
	if (item.action === 'clearCache') {
		// B3a：新云模型暂不支持安全清本机——明确禁用并告知未执行（不保留死代码假路径）
		uni.showToast({ title: '当前版本暂不支持清除本机数据（保留所有记录与备份）', icon: 'none', duration: 3000 })
	}
}

const showDangerModal = ref(false)
const dangerTitle = ref('')
const dangerContent = ref('')
const dangerAction = ref('')

function refreshBackups() {
	// 演示模式不列出正式档案的备份
	backupItems.value = dataSource.value === 'demo' ? [] : []
}

function doDangerAction() {
	// 清除能力未提供：任何到达此处的确认都不执行删除，如实告知——不伪造成功结果
	showDangerModal.value = false
	uni.showToast({ title: '当前版本不支持清除本机数据（未执行任何删除）', icon: 'none', duration: 3000 })
}

refreshBackups()
</script>

<style scoped lang="scss">
.page {
	display: flex;
	flex-direction: column;
	height: 100vh;
	background-color: #FBF7F2;
}

.hero-gray {
	background: linear-gradient(155deg, #3A3834 0%, #6E6A64 45%, #A8A49C 100%);
	padding: 0 36rpx 36rpx;
	flex-shrink: 0;
}

.hero-content { position: relative; z-index: 1; }

.hero-label {
	display: block;
	font-size: 22rpx;
	color: rgba(255, 255, 255, 0.7);
	letter-spacing: 3rpx;
	margin-bottom: 6rpx;
}

.hero-val {
	font-size: 64rpx;
	font-weight: 700;
	color: #FFFFFF;
	line-height: 1;
}

.hero-unit {
	font-size: 32rpx;
	font-weight: 400;
	opacity: 0.8;
}

.hero-sub {
	display: block;
	font-size: 24rpx;
	color: rgba(255, 255, 255, 0.8);
	margin-top: 6rpx;
}

.scroll-content { flex: 1; }

.privacy-banner {
	margin: 24rpx 28rpx 0;
	background: #EBF2FB;
	border: 2rpx solid rgba(91, 143, 201, 0.25);
	border-radius: 32rpx;
	padding: 24rpx 28rpx;
	display: flex;
	gap: 20rpx;
	align-items: flex-start;
}

.pb-icon {
	font-size: 40rpx;
	flex-shrink: 0;
}

.pb-text {
	font-size: 24rpx;
	color: #5B8FC9;
	line-height: 1.6;
}

.sec {
	margin: 20rpx 28rpx 0;
}

.sec-lbl {
	display: block;
	font-size: 22rpx;
	font-weight: 700;
	color: #9C9890;
	text-transform: uppercase;
	letter-spacing: 3rpx;
	margin-bottom: 14rpx;
}

.sec-note {
	display: block;
	font-size: 22rpx;
	color: #9C9890;
	margin-top: 12rpx;
	line-height: 1.6;
}

.data-list {
	display: flex;
	flex-direction: column;
	gap: 16rpx;
}

.data-item {
	background: #FFFFFF;
	border-radius: 20rpx;
	box-shadow: 0 4rpx 28rpx rgba(60, 30, 10, 0.07);
	padding: 24rpx 28rpx;
	display: flex;
	align-items: center;
	gap: 20rpx;
}

.di-icon {
	width: 72rpx;
	height: 72rpx;
	border-radius: 20rpx;
	display: flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
}

.di-icon-text { font-size: 32rpx; }

.di-body { flex: 1; }

.di-title {
	display: block;
	font-size: 26rpx;
	font-weight: 600;
	color: #1C1A17;
}

.di-count {
	display: block;
	font-size: 22rpx;
	color: #9C9890;
	margin-top: 2rpx;
}

.action-card {
	background: #FFFFFF;
	border-radius: 32rpx;
	box-shadow: 0 4rpx 28rpx rgba(60, 30, 10, 0.07);
	overflow: hidden;
}

.action-row {
	display: flex;
	align-items: center;
	padding: 26rpx 28rpx;
	border-bottom: 1rpx solid #E8DDD0;
}

.action-row:last-child { border-bottom: none; }

.action-icon {
	width: 64rpx;
	height: 64rpx;
	border-radius: 18rpx;
	display: flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
	margin-right: 22rpx;
}

.action-icon-text { font-size: 30rpx; }

.action-title {
	font-size: 28rpx;
	font-weight: 500;
	color: #1C1A17;
	flex: 1;
}

.text-danger { color: #E05050; }

.action-tag {
	font-size: 22rpx;
	margin-right: 12rpx;
}

.action-arrow {
	font-size: 28rpx;
}

.bottom-spacer { height: 40rpx; }
</style>
