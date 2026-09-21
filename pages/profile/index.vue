<template>
	<view class="page">
		<scroll-view scroll-y class="scroll-content">
			<!-- 本地数据归属待确认横幅：确认前不上传、不绑定当前账号 -->
			<view v-if="healthStore.needsLegacyConfirm" class="legacy-banner">
				<text class="legacy-banner-icon">⚠️</text>
				<view class="legacy-banner-body">
					<text class="legacy-banner-title">本机数据归属待确认</text>
					<text class="legacy-banner-desc">这些记录尚未确认属于当前登录账号（可能来自旧版本或其他账号）。确认前不会上传到云端，也不会绑定当前账号；数据已在本机保留。完整迁移确认将在后续版本提供。</text>
				</view>
				<view class="legacy-banner-btn" @tap="confirmLegacyData">
					<text class="legacy-banner-btn-text">是我的</text>
				</view>
			</view>

			<!-- Hero 区域 -->
			<ProfileHero
				:userInfo="healthStore.userInfo"
				:weekInfo="healthStore.todayWeekInfo || { week: 0, day: 0, total: 0 }"
				:daysUntilDue="healthStore.daysUntilDue"
				:totalPregDays="healthStore.totalPregDays"
				:progressPercent="healthStore.progressPercent"
				:isLoggedIn="healthStore.isLoggedIn"
				:pregInfoSet="healthStore.pregInfoSet"
			/>

			<!-- 倒计时环 -->
			<view class="section-card">
				<DueCountdownRing
					:daysUntilDue="healthStore.daysUntilDue"
					:progressPercent="healthStore.progressPercent"
					:dueDate="healthStore.dueDate"
				/>
			</view>

			<!-- 孕期信息 -->
			<ProfileSection
				title="孕期信息"
				:items="pregInfoItems"
				@itemTap="handlePregInfoTap"
			/>

			<!-- 我的记录 -->
			<ProfileSection
				title="我的记录"
				:items="recordItems"
				@itemTap="handleRecordTap"
			/>

			<!-- AI 服务 -->
			<ProfileSection
				title="AI 服务"
				:items="aiServiceItems"
				@itemTap="handleAiServiceTap"
			/>

			<!-- 待办 & 提醒 -->
			<ProfileSection
				title="待办 & 提醒"
				:items="todoItems"
				@itemTap="handleTodoTap"
			/>

			<!-- 设置 -->
			<ProfileSection
				title="设置"
				:items="settingItems"
				@itemTap="handleSettingTap"
				@toggle="handleToggle"
			/>

			<!-- #ifdef H5 -->
			<view v-if="isIOS" class="ios-homescreen-card" @tap="installToHomeScreen">
				<view class="ios-card-icon-wrap">
					<text class="ios-card-emoji">📲</text>
				</view>
				<view class="ios-card-body">
					<text class="ios-card-title">添加到桌面 (iOS)</text>
					<text class="ios-card-desc">享受免打扰的全屏 App 体验</text>
				</view>
				<text class="ios-card-arrow">›</text>
			</view>
			<!-- #endif -->

			<view class="bottom-spacer"></view>
		</scroll-view>
		<CustomTabBar :active="3" />

		<!-- 退出登录确认弹窗 -->
		<view class="logout-overlay" v-if="showLogoutModal" @tap="showLogoutModal = false">
		<view class="logout-card" @tap.stop>
			<text class="logout-modal-title">退出登录</text>
			<text class="logout-modal-desc">{{ logoutDesc }}</text>
				<view class="logout-modal-actions">
					<view class="logout-btn logout-btn-cancel" @tap="showLogoutModal = false">
						<text>取消</text>
					</view>
					<view class="logout-btn logout-btn-confirm" @tap="confirmLogout">
						<text>确定</text>
					</view>
				</view>
			</view>
		</view>
	</view>
</template>

<script setup>
import { ref, computed, reactive, watch } from 'vue'
import { useHealthStore, getTrimesterName } from '@/stores/health.js'
import { navigateToPage } from '@/utils/navigation.js'
import { removeToken } from '@/utils/api.js'
import { endSession, getSessionState, subscribeSession, isExplicitDemo, isExplicitLoggedOut } from '@/services/sessionService.js'
import { getOutbox } from '@/services/outbox.js'
import { useFamilyStore } from '@/services/familyStore.js'
import manifest from '@/manifest.json'
import ProfileHero from '@/components/profile/ProfileHero.vue'
import DueCountdownRing from '@/components/common/DueCountdownRing.vue'
import ProfileSection from '@/components/profile/ProfileSection.vue'
import CustomTabBar from '@/components/CustomTabBar.vue'

const healthStore = useHealthStore()
const familyStore = useFamilyStore()
const showLogoutModal = ref(false)
const logoutPendingCount = ref(0)
const logoutConflictCount = ref(0)

// B2b1 三态数据源：family=权威源 / demo=演示键 / prompt=空（摘要同源，两页一致）
const dataSource = ref(isExplicitDemo() ? 'demo' : (getSessionState().status === 'confirmed' && !isExplicitLoggedOut() ? 'family' : 'prompt'))

// 回前台/冷启动协调（沿用 B2a 首页模式）：去重身份确认；异步确认成功 → 激活并拉取
import { onShow as __onShow } from '@dcloudio/uni-app'
import { foregroundRecheck, coldStartConfirm } from '@/services/sessionService.js'

function pullDomain() {
	familyStore.pullCheckups().catch(() => {})
	familyStore.pullBagItems().catch(() => {})
}
let __activatedMember = null
function activateFamilyDomain() {
	dataSource.value = 'family'
	const s = getSessionState()
	const mid = s.member ? s.member.memberId : null
	if (__activatedMember !== mid) {
		familyStore.restoreFromCache()
		pullDomain()
		__activatedMember = mid
	}
}

watch(subscribeSession(), () => {
	if (isExplicitDemo()) {
		dataSource.value = 'demo'
		__activatedMember = null
		return
	}
	const s = getSessionState()
	if (s.status === 'confirmed' && !isExplicitLoggedOut()) {
		activateFamilyDomain()
	} else if (s.status === 'rejected' || isExplicitLoggedOut()) {
		dataSource.value = 'prompt'
		__activatedMember = null
	}
})

// setup 时已确认（热路径）：恢复成员快照并拉取
if (dataSource.value === 'family') {
	familyStore.restoreFromCache()
	pullDomain()
	__activatedMember = getSessionState().member ? getSessionState().member.memberId : null
}

__onShow(() => {
	const session = getSessionState()
	if (isExplicitDemo()) return
	if (isExplicitLoggedOut() && session.status !== 'confirmed') return
	if (session.status === 'confirmed' && !isExplicitLoggedOut()) {
		activateFamilyDomain()
		foregroundRecheck().then(res => {
			if (!res || !res.ok) return
			pullDomain()
			familyStore.flushAll().catch(() => {})
		}).catch(() => {})
	} else if (session.status === 'unconfirmed' && dataSource.value !== 'demo') {
		coldStartConfirm().then(res => {
			if (res && res.ok) activateFamilyDomain()
		}).catch(() => {})
	}
})

// 退出提示：有未同步/冲突内容时如实说明保留在本人账户（不默认丢弃、不给下一身份）
const logoutDesc = computed(() => {
  const pending = logoutPendingCount.value
  const conflicts = logoutConflictCount.value
  const lines = ['确定要退出当前账号吗？']
  if (pending > 0 || conflicts > 0) {
    lines.push(`你有 ${pending} 项待同步${conflicts > 0 ? `、${conflicts} 项冲突待处理` : ''}，将保留在你的账户下，重新确认身份后可继续处理。`)
  }
  lines.push('本机记录不会被删除；云端数据以登录后的同步为准。')
  return lines.join('\n')
})

function refreshLogoutStatus() {
  try {
    const entries = getOutbox()
    logoutPendingCount.value = entries.filter(e => !e.conflict).length
    logoutConflictCount.value = entries.filter(e => e.conflict).length
  } catch (e) {
    logoutPendingCount.value = 0
    logoutConflictCount.value = 0
  }
}

function confirmLogout() {
	// 真实退出：清除会话与身份标记（含云身份会话）；本地数据保留（删除属危险操作，见隐私页）
	const ok = healthStore.exitSession()
	if (!ok) {
		uni.showToast({ title: '退出失败：本地模式切换未生效，请重试', icon: 'none', duration: 2500 })
		return
	}
	// 云身份会话同步失效（实际退出按钮必须让新会话边界立即生效）
	endSession()
	removeToken()
	showLogoutModal.value = false
	uni.reLaunch({ url: '/pages/login/index' })
}

// 显式确认旧数据归属本人：确认后才恢复云上传通路
function confirmLegacyData() {
	const result = healthStore.confirmLegacyOrigin()
	uni.showToast({
		title: result.ok
			? (result.changed ? '已确认，恢复同步' : '无需确认')
			: (result.message || '确认未保存成功，请重试'),
		icon: 'none',
		duration: 2500
	})
}

// #ifdef H5
const isIOS = ref(/iPhone|iPad|iPod/i.test(navigator.userAgent))

function installToHomeScreen() {
	window.location.href = '/static/momcare.mobileconfig'
}
// #endif

// 孕期信息
const pregInfoItems = computed(() => {
	const lmp = healthStore.lmpDate
	const due = healthStore.dueDate
	const lmpText = lmp ? `${lmp.getFullYear()}年${lmp.getMonth() + 1}月${lmp.getDate()}日` : '未设置'
	const dueText = due ? `${due.getFullYear()}年${due.getMonth() + 1}月${due.getDate()}日（可由医生修正）` : '未设置'
	return [
		{
			icon: '📅',
			iconBg: '#FAEAEE',
			title: '末次月经',
			subtitle: lmpText,
			action: 'editLmp'
		},
		{
			icon: '🎀',
			iconBg: '#FDF3E3',
			title: '预产期',
			subtitle: dueText,
			action: 'editDue'
		},
		{
			icon: '🏥',
			iconBg: '#DDD0F5',
			title: '就诊医院',
			subtitle: healthStore.userInfo.hospital || '未设置',
			action: 'editHospital'
		},
		{
			icon: '👶',
			iconBg: '#EAF7EF',
			title: '宝宝昵称',
			subtitle: healthStore.userInfo.babyNickname || '未设置',
			action: 'editNickname'
		}
	]
})

// 我的记录
const recordItems = computed(() => {
	const ws = healthStore.getWeightStats()
	const bs = healthStore.getBpStats()
	const fs = healthStore.getFetalStats()

	const weightSubtitle = ws.count > 0
		? `最新 ${ws.latest}kg · 孕期增重 ${ws.gain || '--'}kg`
		: '暂无记录'
	const weightBadge = ws.count > 0 ? `${ws.count}条` : ''

	const bpSubtitle = bs.count > 0
		? `最新 ${bs.latest} · 血压${bs.status}`
		: '暂无记录'
	const bpBadge = bs.count > 0 ? `${bs.count}条` : ''

	const fetalSubtitle = fs.count > 0
		? `今日 ${fs.today}次 · 昨日 ${fs.yesterday}次`
		: '暂无记录'
	const fetalBadge = fs.count > 0 ? `${fs.count}条` : ''

	return [
	{
		icon: '⚖️',
		iconBg: '#FAEAEE',
		title: '体重记录',
		subtitle: weightSubtitle,
		badge: weightBadge,
		action: 'weightRecords'
	},
	{
		icon: '💗',
		iconBg: '#EBF2FB',
		title: '血压记录',
		subtitle: bpSubtitle,
		badge: bpBadge,
		action: 'bpRecords'
	},
	{
		icon: '👣',
		iconBg: '#EAF2EE',
		title: '胎动记录',
		subtitle: fetalSubtitle,
		badge: fetalBadge,
		action: 'fetalRecords'
	},
	{
		icon: '📁',
		iconBg: '#FDF3E3',
		title: '产检档案',
		subtitle: '暂无报告',
		action: 'archives'
	}
]
})

	const aiServiceItems = [
		{
			icon: '✦',
			iconBg: '#FAEAEE',
			title: 'AI 解读',
			subtitle: '前往档案解读检查报告',
			action: 'aiInterpret'
		}
	]

// 待产包进度（三态同源：family 权威统计 / demo 演示键 / prompt 空文案。
// 旧 hospital_bag_items 无可信归属，B2b1 起正式零读——不在此处恢复读取）
const hospitalBagSubtitle = computed(() => {
	if (dataSource.value === 'family') {
		const items = Object.values(familyStore.bagItems).filter(i => !i.deleted)
		if (items.length === 0) return '点击查看待产包清单'
		const done = items.filter(i => i.prepared).length
		return `已完成 ${done} / ${items.length} 项`
	}
	if (dataSource.value === 'demo') {
		try {
			const saved = uni.getStorageSync('MOMCARE_DEMO_BAG_ITEMS')
			if (saved) {
				const items = JSON.parse(saved)
				const done = items.filter(i => i.done).length
				return `已完成 ${done} / ${items.length} 项`
			}
		} catch (e) { /* */ }
	}
	return '点击查看待产包清单'
})

// 下次产检卡（三态同源：family 取权威最早 pending；demo 旧 store）
// 日期键按日历字段直读（负时区不回退一天）；天数按上海日号差（与产检页一致），
// 依赖 healthStore.today 响应式时钟——跨上海午夜自动更新
function __shDayOrd(date) {
	const sh = new Date(date.getTime() + (8 * 60 + date.getTimezoneOffset()) * 60000)
	return Date.UTC(sh.getFullYear(), sh.getMonth(), sh.getDate()) / 86400000
}
function __keyOrd(key) {
	const [y, m, d] = String(key).split('-').map(Number)
	return Date.UTC(y, m - 1, d) / 86400000
}
function checkupCardInfo(dateStr) {
	const [y, m, day] = String(dateStr).split('-').map(Number)
	void y
	void healthStore.today // 响应式依赖生产时钟
	const days = __keyOrd(dateStr) - __shDayOrd(healthStore.today)
	if (days > 0) {
		return { subtitle: `${m}月${day}日 · 还有 ${days} 天`, badge: days + '天后', badgeStyle: 'amber' }
	}
	if (days === 0) {
		return { subtitle: `${m}月${day}日 · 就是今天`, badge: '今天', badgeStyle: 'rose' }
	}
	return { subtitle: `${m}月${day}日 · 已过期`, badge: '已过期', badgeStyle: 'gray' }
}
const nextCheckupCard = computed(() => {
	let dateStr = null
	if (dataSource.value === 'family') {
		const next = Object.values(familyStore.checkups)
			.filter(c => !c.deleted && c.status === 'pending')
			.sort((a, b) => (a.dateKey || '').localeCompare(b.dateKey || ''))[0]
		dateStr = next ? next.dateKey : null
	} else if (dataSource.value === 'demo') {
		const next = healthStore.nextCheckup
		dateStr = next ? next.checkup_date : null
	}
	if (!dateStr) return { subtitle: '暂无产检安排', badge: '', badgeStyle: '' }
	return checkupCardInfo(dateStr)
})

// 待办 & 提醒
const todoItems = computed(() => {
	const checkupCard = nextCheckupCard.value

	// 今日计划：只显示真实记录里的计划，没有则显示空状态，不编造内容
	const todayPlans = healthStore.getRecord(new Date())?.plans || []
	const dailyPlanSubtitle = todayPlans.length > 0
		? `今日 ${todayPlans.filter(p => p.done).length} / ${todayPlans.length} 项完成`
		: '今天还没有计划'

	return [
		{
			icon: '🗓',
			iconBg: '#FAEAEE',
			title: '下次产检',
			subtitle: checkupCard.subtitle,
			badge: checkupCard.badge,
			badgeStyle: checkupCard.badgeStyle,
			action: 'nextCheckup'
		},
		{
			icon: '🎒',
			iconBg: '#EEE8FA',
			title: '待产包清单',
			subtitle: hospitalBagSubtitle,
			action: 'hospitalBag'
		},
		{
			icon: '📋',
			iconBg: '#EAF7EF',
			title: '今日计划',
			subtitle: dailyPlanSubtitle,
			action: 'dailyPlan'
		}
	]
})

// 设置（含开关状态）
	const settingItems = reactive([
			{
				icon: '👨‍👩‍👧',
				iconBg: '#FDEEF1',
				title: '家庭共享（云）',
				subtitle: '两人共享记录 / 本人私人笔记（阶段 B 新入口）',
				action: 'family'
			},
			// 每日推送提醒、产检提醒、胎动记录提醒、隐私与数据 — 暂时隐藏，功能开发中
			{
				icon: 'ℹ️',
				iconBg: '#F2F0EE',
				title: '关于孕途伴侣',
				subtitle: `版本 v${manifest.versionName}`,
				action: 'about'
			},
			{
				icon: '🚪',
				iconBg: '#F2F0EE',
				title: '退出登录',
				subtitle: '',
				action: 'logout'
			}
		])

function handlePregInfoTap(item) {
	navigateToPage('/pages/profile/pregnancy-info')
}

function handleRecordTap(item) {
	const routes = {
		weightRecords: '/pages/profile/weight-records',
		bpRecords: '/pages/profile/bp-records',
		fetalRecords: '/pages/profile/fetal-records',
		archives: '/pages/archives/index'
	}
	if (item.action === 'archives') {
		uni.switchTab({ url: routes.archives })
	} else if (routes[item.action]) {
		navigateToPage(routes[item.action])
	}
}

function handleAiServiceTap(item) {
	if (item.action === 'aiInterpret') {
		uni.switchTab({ url: '/pages/archives/index' })
	}
}

function handleTodoTap(item) {
	const routes = {
		nextCheckup: '/pages/profile/checkup-reminder',
		hospitalBag: '/pages/profile/hospital-bag',
		dailyPlan: '/pages/profile/daily-plan'
	}
	if (routes[item.action]) {
		navigateToPage(routes[item.action])
	}
}

function handleSettingTap(item) {
	if (item.action === 'logout') {
		refreshLogoutStatus()
		showLogoutModal.value = true
		return
	}

	const routes = {
		privacy: '/pages/profile/privacy',
		family: '/pages/family/index',
		about: '/pages/profile/about'
	}
	if (routes[item.action]) {
		navigateToPage(routes[item.action])
	}
}

function handleToggle(idx) {
	settingItems[idx].toggle = !settingItems[idx].toggle
}

// 加载产检日程（仅展示；建档/保存孕期资料时才生成，不在浏览时自动填充）
healthStore.loadCheckupSchedules()
</script>

<style scoped lang="scss">
.page {
	display: flex;
	flex-direction: column;
	height: 100vh;
	background-color: #FBF7F2;
	box-sizing: border-box;
}

.scroll-content {
	flex: 1;
	padding-bottom: 20rpx;
}

.section-card {
	background: #FFFFFF;
	border-radius: 32rpx;
	box-shadow: 0 4rpx 28rpx rgba(60, 30, 10, 0.07);
	overflow: hidden;
	margin: 20rpx 24rpx 0;
}

.bottom-spacer {
	height: calc(120rpx + env(safe-area-inset-bottom));
}

/* 旧数据来源待确认横幅 */
.legacy-banner {
	display: flex;
	align-items: flex-start;
	gap: 16rpx;
	margin: 20rpx 24rpx 0;
	padding: 24rpx;
	background: #FEF4E3;
	border: 2rpx solid rgba(240, 169, 64, 0.4);
	border-radius: 24rpx;
}

.legacy-banner-icon {
	font-size: 32rpx;
	flex-shrink: 0;
	line-height: 1.4;
}

.legacy-banner-body {
	flex: 1;
}

.legacy-banner-title {
	display: block;
	font-size: 26rpx;
	font-weight: 600;
	color: #8A5A10;
	margin-bottom: 6rpx;
}

.legacy-banner-desc {
	display: block;
	font-size: 22rpx;
	color: #B07818;
	line-height: 1.6;
}

.legacy-banner-btn {
	flex-shrink: 0;
	background: #F0A940;
	border-radius: 999rpx;
	padding: 12rpx 26rpx;
	margin-left: 8rpx;
}

.legacy-banner-btn-text {
	font-size: 24rpx;
	font-weight: 600;
	color: #FFFFFF;
}

.ios-homescreen-card {
	display: flex;
	align-items: center;
	margin: 20rpx 24rpx 0;
	padding: 28rpx 28rpx;
	background: linear-gradient(135deg, #FFF5F6 0%, #FFF0F3 100%);
	border: 2rpx solid rgba(232, 99, 122, 0.15);
	border-radius: 32rpx;
	box-shadow: 0 4rpx 28rpx rgba(60, 30, 10, 0.07);
}

.ios-card-icon-wrap {
	flex-shrink: 0;
	width: 80rpx;
	height: 80rpx;
	border-radius: 20rpx;
	background: rgba(232, 99, 122, 0.1);
	display: flex;
	align-items: center;
	justify-content: center;
	margin-right: 24rpx;
}

.ios-card-emoji {
	font-size: 40rpx;
}

.ios-card-body {
	flex: 1;
	display: flex;
	flex-direction: column;
}

.ios-card-title {
	font-size: 30rpx;
	font-weight: 600;
	color: #333;
}

.ios-card-desc {
	font-size: 24rpx;
	color: #999;
	margin-top: 6rpx;
}

.ios-card-arrow {
	flex-shrink: 0;
	font-size: 36rpx;
	color: #CCC;
	margin-left: 16rpx;
}

/* 退出登录弹窗 */
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
