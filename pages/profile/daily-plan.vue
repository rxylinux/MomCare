<template>
	<view class="page">
		<!-- Hero 区域 -->
		<view class="hero">
			<!-- 导航栏 -->
			<NavBar title="今日计划" theme="dark" transparent class="hero-navbar"></NavBar>

			<!-- Hero 内容 -->
			<view class="hero-content">
				<text class="hero-label">今日计划</text>
				<text class="hero-date">{{ todayDateDisplay }}</text>
				<text class="hero-sub" v-if="hasPlans">{{ planCountText }}</text>
				<text class="hero-sub" v-else>暂无今日计划</text>
				<view class="countdown-pill" v-if="hasPlans">
					<text class="countdown-num">{{ completedCount }}</text>
					<text class="countdown-lbl">/{{ totalCount }} 已完成</text>
				</view>
			</view>
		</view>

		<!-- 滚动内容区 -->
		<scroll-view scroll-y class="scroll-content">
			<!-- 备注卡片 -->
			<view class="note-card" v-if="currentNote">
				<text class="note-title">📝 备注</text>
				<text class="note-text">{{ currentNote }}</text>
			</view>

			<!-- 今日计划列表 -->
			<view class="section-title" v-if="hasPlans">
				<text class="section-title-text">今日计划</text>
			</view>
			<view class="plan-list" v-if="hasPlans">
				<view
					v-for="(plan, idx) in currentPlans"
					:key="'today-' + idx"
					class="plan-item"
					:class="{ 'plan-done': plan.done }"
					@tap="toggleTodayPlan(idx)"
				>
					<view class="plan-check">
						<text v-if="plan.done" class="check-mark">✓</text>
					</view>
					<text class="plan-text" :class="{ 'plan-text-done': plan.done }">{{ plan.text }}</text>
				</view>
			</view>

			<!-- 历史计划区域 -->
			<view class="history-section" v-if="hasHistoryPlans">
				<view class="section-header">
					<text class="section-title-text">历史计划</text>
					<text class="section-subtitle">{{ historyPlanCount }}条记录</text>
				</view>

				<!-- 历史计划列表 -->
				<view class="history-list">
					<view
						v-for="(group, gIdx) in historyPlanGroups"
						:key="'group-' + gIdx"
						class="history-group"
					>
						<!-- 日期头部 -->
						<view
							class="history-header"
							:class="{ 'history-header-expanded': group.expanded }"
							@tap="toggleGroup(gIdx)"
						>
							<view class="history-header-left">
								<view class="history-dot" :class="{ 'history-dot-all-done': group.allDone }"></view>
								<view class="history-header-info">
									<text class="history-date">{{ group.dateDisplay }}</text>
									<text class="history-week">{{ group.weekDisplay }}</text>
								</view>
							</view>
							<view class="history-header-right">
								<view class="history-progress">
									<text class="history-progress-text">{{ group.completedCount }}/{{ group.totalCount }}</text>
								</view>
								<text class="history-arrow" :class="{ 'history-arrow-up': group.expanded }">›</text>
							</view>
						</view>

						<!-- 展开的计划列表 -->
						<view class="history-plans" v-if="group.expanded">
							<view
								v-for="(plan, pIdx) in group.plans"
								:key="'plan-' + gIdx + '-' + pIdx"
								class="history-plan-item"
								:class="{ 'plan-done': plan.done }"
								@tap.stop="toggleHistoryPlan(gIdx, pIdx)"
							>
								<view class="plan-check">
									<text v-if="plan.done" class="check-mark">✓</text>
								</view>
								<text class="plan-text" :class="{ 'plan-text-done': plan.done }">{{ plan.text }}</text>
							</view>
						</view>
					</view>
				</view>
			</view>

			<!-- 空状态 -->
			<view class="empty-state" v-if="!hasPlans && !hasHistoryPlans && !currentNote">
				<view class="empty-icon">📋</view>
				<text class="empty-title">暂无计划记录</text>
				<text class="empty-desc">在首页日历中选择日期，记录你的计划吧</text>
				<view class="empty-btn" @tap="goHome">
					<text class="empty-btn-text">去首页记录</text>
				</view>
			</view>

			<!-- 仅今日有备注 -->
			<view class="empty-state" v-if="!hasPlans && !hasHistoryPlans && currentNote">
				<view class="empty-icon">✅</view>
				<text class="empty-title">今日已记录备注</text>
				<text class="empty-desc">可以在首页添加计划事项</text>
			</view>

			<!-- 今日无计划但有历史 -->
			<view class="empty-state" v-if="!hasPlans && hasHistoryPlans">
				<view class="empty-icon">📝</view>
				<text class="empty-title">暂无今日计划</text>
				<text class="empty-desc">查看下方历史计划或在首页添加今日计划</text>
			</view>

			<view class="bottom-spacer"></view>
		</scroll-view>
	</view>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useHealthStore } from '@/stores/health.js'
import NavBar from '@/components/NavBar.vue'

const healthStore = useHealthStore()

// 历史计划组的展开状态
const historyPlanGroups = ref([])

// 今日日期显示
const todayDateDisplay = computed(() => {
	const today = new Date()
	const m = today.getMonth() + 1
	const d = today.getDate()
	const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
	return `${m}月${d}日 · ${weekDays[today.getDay()]}`
})

// 获取今日记录
const currentRecord = computed(() => {
	return healthStore.getRecord(new Date())
})

// 当前计划列表
const currentPlans = computed(() => {
	const record = currentRecord.value
	return record?.plans || []
})

// 是否有计划
const hasPlans = computed(() => {
	return currentPlans.value.length > 0
})

// 计划总数
const totalCount = computed(() => {
	return currentPlans.value.length
})

// 已完成数量
const completedCount = computed(() => {
	return currentPlans.value.filter(p => p.done).length
})

// 计划数量文字
const planCountText = computed(() => {
	const total = totalCount.value
	const completed = completedCount.value
	return `${total}项计划 · 已完成${completed}项`
})

// 当前备注
const currentNote = computed(() => {
	const record = currentRecord.value
	return record?.note || ''
})

// 获取历史计划（排除今天）
const historyPlans = computed(() => {
	const records = healthStore.records || {}
	const today = new Date()
	const todayKey = healthStore.getRecordKey(today)

	const history = []

	for (const [dateKey, record] of Object.entries(records)) {
		// 跳过今天
		if (dateKey === todayKey) continue

		// 只包含有计划的记录
		if (record.plans && record.plans.length > 0) {
			const date = new Date(dateKey)
			const weekInfo = healthStore.getWeekInfo(date)

			history.push({
				dateKey,
				date,
				plans: record.plans,
				weekInfo,
				note: record.note || ''
			})
		}
	}

	// 按日期倒序排列
	return history.sort((a, b) => b.date - a.date)
})

// 是否有历史计划
const hasHistoryPlans = computed(() => {
	return historyPlans.value.length > 0
})

// 历史计划总数（记录条数）
const historyPlanCount = computed(() => {
	return historyPlans.value.length
})

// 构建历史计划组
function buildHistoryGroups() {
	const groups = historyPlans.value.map(item => {
		const totalCount = item.plans.length
		const completedCount = item.plans.filter(p => p.done).length
		const allDone = completedCount === totalCount && totalCount > 0

		// 日期显示
		const date = item.date
		const today = new Date()
		const yesterday = new Date(today)
		yesterday.setDate(yesterday.getDate() - 1)

		let dateDisplay = ''
		if (date.toDateString() === yesterday.toDateString()) {
			dateDisplay = '昨天'
		} else {
			const m = date.getMonth() + 1
			const d = date.getDate()
			const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
			dateDisplay = `${m}月${d}日 · ${weekDays[date.getDay()]}`
		}

		// 周数显示
		const weekInfo = item.weekInfo
		const weekDisplay = weekInfo ? `孕${weekInfo.week}周${weekInfo.day}天` : ''

		return {
			dateKey: item.dateKey,
			dateDisplay,
			weekDisplay,
			plans: item.plans,
			totalCount,
			completedCount,
			allDone,
			note: item.note,
			expanded: false
		}
	})

	historyPlanGroups.value = groups
}

// 切换今日计划完成状态：写盘失败回滚显示并提示，不表现伪完成
async function toggleTodayPlan(idx) {
	const plans = [...currentPlans.value]
	plans[idx].done = !plans[idx].done
	const result = await healthStore.saveRecord(new Date(), { plans })
	if (result && result.persisted) return
	plans[idx].done = !plans[idx].done
	await healthStore.saveRecord(new Date(), { plans })
	uni.showToast({ title: '本机保存失败，已还原，请重试', icon: 'none', duration: 2500 })
}

// 切换历史计划组展开状态
function toggleGroup(gIdx) {
	historyPlanGroups.value[gIdx].expanded = !historyPlanGroups.value[gIdx].expanded
}

// 切换历史计划完成状态：写盘失败回滚显示并提示
async function toggleHistoryPlan(gIdx, pIdx) {
	const group = historyPlanGroups.value[gIdx]
	const plans = [...group.plans]
	plans[pIdx].done = !plans[pIdx].done

	// 保存到对应的日期
	const date = new Date(group.dateKey)
	const result = await healthStore.saveRecord(date, { plans })

	if (result && result.persisted) {
		// 更新组状态
		group.plans = plans
		group.completedCount = plans.filter(p => p.done).length
		group.allDone = group.completedCount === group.totalCount
		return
	}

	// 写盘失败：还原勾选并保持组状态不变
	plans[pIdx].done = !plans[pIdx].done
	await healthStore.saveRecord(date, { plans })
	uni.showToast({ title: '本机保存失败，已还原，请重试', icon: 'none', duration: 2500 })
}

// 跳转到首页
function goHome() {
	uni.switchTab({ url: '/pages/index/index' })
}

onMounted(() => {
	console.log('[daily-plan] page onMounted')
	buildHistoryGroups()
})
</script>

<style scoped lang="scss">
page {
	--rose: #C45070;
	--rose-light: #FDEEF1;
	--rose-mid: #E07898;
	--rose-pale: #F4C0CC;
	--green: #7BA08C;
	--green-light: #EAF7EF;
	--gray-50: #FAF9F8;
	--gray-100: #F2F0EE;
	--gray-200: #E4E1DC;
	--gray-400: #9C9890;
	--gray-700: #3A3834;
	--gray-900: #1C1A17;
}

.page {
	display: flex;
	flex-direction: column;
	height: 100vh;
	background-color: #FBF7F2;
	box-sizing: border-box;
}

/* ── Hero ── */
.hero {
	flex-shrink: 0;
	background: linear-gradient(155deg, #C45070 0%, #E07898 40%, #F4C0CC 100%);
	position: relative;
	overflow: hidden;
}



.hero-content {
	padding: 16rpx 40rpx 44rpx;
}

.hero-label {
	font-size: 26rpx;
	color: rgba(255, 255, 255, 0.75);
	display: block;
	margin-bottom: 8rpx;
}

.hero-date {
	font-size: 48rpx;
	font-weight: 700;
	color: #FFFFFF;
	display: block;
	margin-bottom: 8rpx;
}

.hero-sub {
	font-size: 24rpx;
	color: rgba(255, 255, 255, 0.7);
	display: block;
	margin-bottom: 20rpx;
}

.countdown-pill {
	display: inline-flex;
	align-items: center;
	gap: 8rpx;
	background: rgba(255, 255, 255, 0.2);
	border: 2rpx solid rgba(255, 255, 255, 0.3);
	border-radius: 999rpx;
	padding: 10rpx 24rpx;
}

.countdown-num {
	font-size: 32rpx;
	font-weight: 700;
	color: #FFFFFF;
}

.countdown-lbl {
	font-size: 22rpx;
	color: rgba(255, 255, 255, 0.8);
}

/* ── Scroll Content ── */
.scroll-content {
	flex: 1;
	padding-bottom: 20rpx;
}

/* ── Section Title ── */
.section-title {
	padding: 32rpx 24rpx 16rpx;
}

.section-title-text {
	font-size: 32rpx;
	font-weight: 600;
	color: #1C1A17;
}

/* ── Note Card ── */
.note-card {
	background: #FFFFFF;
	border-radius: 32rpx;
	box-shadow: 0 4rpx 28rpx rgba(60, 30, 10, 0.07);
	margin: 24rpx 24rpx 0;
	padding: 32rpx;
}

.note-title {
	display: block;
	font-size: 26rpx;
	font-weight: 600;
	color: #1C1A17;
	margin-bottom: 16rpx;
}

.note-text {
	display: block;
	font-size: 28rpx;
	color: #4A4844;
	line-height: 1.7;
	white-space: pre-wrap;
	word-break: break-word;
}

/* ── Plan List ── */
.plan-list {
	padding: 0 24rpx 24rpx;
}

.plan-item {
	background: #FFFFFF;
	border-radius: 20rpx;
	box-shadow: 0 4rpx 28rpx rgba(60, 30, 10, 0.07);
	padding: 24rpx 26rpx;
	margin-bottom: 16rpx;
	display: flex;
	align-items: center;
	gap: 20rpx;
	transition: all 0.2s;
}

.plan-item:active {
	opacity: 0.85;
	transform: scale(0.98);
}

.plan-check {
	width: 40rpx;
	height: 40rpx;
	border-radius: 10rpx;
	border: 4rpx solid #E8DDD0;
	background: #F2F0EE;
	display: flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
	transition: all 0.2s;
}

.plan-done .plan-check {
	background: #7BA08C;
	border-color: #7BA08C;
}

.check-mark {
	font-size: 22rpx;
	color: #FFFFFF;
	font-weight: 700;
}

.plan-text {
	font-size: 28rpx;
	color: #1C1A17;
	flex: 1;
	transition: all 0.2s;
}

.plan-text-done {
	text-decoration: line-through;
	color: #9C9890;
}

/* ── History Section ── */
.history-section {
	padding: 0 24rpx 24rpx;
}

.section-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 32rpx 0 16rpx;
}

.section-subtitle {
	font-size: 24rpx;
	color: #9C9890;
}

.history-list {
	display: flex;
	flex-direction: column;
	gap: 12rpx;
}

.history-group {
	background: #FFFFFF;
	border-radius: 24rpx;
	box-shadow: 0 4rpx 28rpx rgba(60, 30, 10, 0.07);
	overflow: hidden;
}

/* ── History Header ── */
.history-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 24rpx 28rpx;
	transition: background 0.2s;
}

.history-header:active {
	background: #FAF9F8;
}

.history-header-left {
	display: flex;
	align-items: center;
	gap: 16rpx;
	flex: 1;
}

.history-dot {
	width: 12rpx;
	height: 12rpx;
	border-radius: 50%;
	background: #E8DDD0;
	flex-shrink: 0;
}

.history-dot-all-done {
	background: #7BA08C;
}

.history-header-info {
	display: flex;
	flex-direction: column;
	gap: 4rpx;
}

.history-date {
	font-size: 28rpx;
	font-weight: 600;
	color: #1C1A17;
}

.history-week {
	font-size: 24rpx;
	color: #9C9890;
}

.history-header-right {
	display: flex;
	align-items: center;
	gap: 12rpx;
}

.history-progress {
	background: #FAF9F8;
	border-radius: 20rpx;
	padding: 6rpx 16rpx;
}

.history-progress-text {
	font-size: 24rpx;
	font-weight: 600;
	color: #7BA08C;
}

.history-arrow {
	font-size: 32rpx;
	color: #C8C8C8;
	transition: transform 0.3s;
}

.history-arrow-up {
	transform: rotate(90deg);
}

/* ── History Plans (Expanded) ── */
.history-plans {
	padding: 0 28rpx 24rpx;
	background: #FAF9F8;
}

.history-plan-item {
	background: #FFFFFF;
	border-radius: 16rpx;
	padding: 20rpx 24rpx;
	margin-bottom: 12rpx;
	display: flex;
	align-items: center;
	gap: 16rpx;
	transition: all 0.2s;
}

.history-plan-item:last-child {
	margin-bottom: 0;
}

.history-plan-item:active {
	opacity: 0.85;
	transform: scale(0.98);
}

/* ── Empty State ── */
.empty-state {
	background: #FFFFFF;
	border-radius: 32rpx;
	box-shadow: 0 4rpx 28rpx rgba(60, 30, 10, 0.07);
	margin: 24rpx;
	padding: 80rpx 32rpx;
	display: flex;
	flex-direction: column;
	align-items: center;
}

.empty-icon {
	font-size: 100rpx;
	margin-bottom: 24rpx;
}

.empty-title {
	font-size: 32rpx;
	font-weight: 600;
	color: #1C1A17;
	margin-bottom: 12rpx;
}

.empty-desc {
	font-size: 26rpx;
	color: #9C9890;
	text-align: center;
	margin-bottom: 40rpx;
	line-height: 1.5;
}

.empty-btn {
	background: linear-gradient(135deg, #C45070, #E07898);
	border-radius: 48rpx;
	padding: 20rpx 64rpx;
}

.empty-btn:active {
	opacity: 0.85;
}

.empty-btn-text {
	font-size: 28rpx;
	color: #FFFFFF;
	font-weight: 600;
}

/* ── Bottom Spacer ── */
.bottom-spacer {
	height: 120rpx;
}
</style>
