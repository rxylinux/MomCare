<template>
	<view class="page">
		<!-- Hero -->
		<view class="guide-hero">
			<view class="hero-top">
				<view class="back-btn" @tap="goBack">
					<text class="back-arrow">‹</text>
				</view>
			</view>
				<text class="hero-title">{{ heroTitle }}</text>
				<text class="hero-sub">{{ heroSubtitle }}</text>
				<view class="hero-stats" v-if="guideData">
				<view class="stat-card">
					<text class="stat-val">{{ guideData.babyWeight }}</text>
					<text class="stat-lbl">宝宝体重</text>
				</view>
				<view class="stat-card">
					<text class="stat-val">{{ guideData.babyLength }}</text>
					<text class="stat-lbl">身长</text>
				</view>
				<view class="stat-card">
					<text class="stat-val">{{ guideData.fundalHeight }}</text>
					<text class="stat-lbl">宫底高度</text>
				</view>
				<view class="stat-card">
					<text class="stat-val">{{ daysLeft }}天</text>
					<text class="stat-lbl">距预产期</text>
				</view>
			</view>
		</view>

		<!-- Week selector -->
			<scroll-view class="week-strip" scroll-x :scroll-into-view="scrollTarget" scroll-with-animation>
			<view class="week-strip-inner">
				<view
					v-for="w in weekRange"
					:key="w"
					:id="'week-' + w"
					class="week-chip"
					:class="{ active: w === currentWeek }"
					@tap="selectWeek(w)"
				>
					<text class="week-chip-text">孕{{ w }}周</text>
				</view>
			</view>
		</scroll-view>

		<!-- Content -->
		<scroll-view class="content-scroll" scroll-y v-if="guideData">
			<view class="content">

				<!-- 宝宝发育 -->
				<view class="gc-card">
					<view class="gc-header">
						<text class="gc-header-icon">{{ guideData.baby.icon }}</text>
						<text class="gc-header-title">宝宝本周发育</text>
					</view>
					<view class="gc-body">
						<text class="gc-para" v-for="(p, idx) in guideData.baby.paragraphs" :key="idx">{{ p }}</text>
						<view v-if="guideData.baby.highlight" class="gc-highlight gc-highlight-rose">
							<text>{{ guideData.baby.highlight }}</text>
						</view>
					</view>
				</view>

				<!-- 妈妈变化 -->
				<view class="gc-card">
					<view class="gc-header">
						<text class="gc-header-icon">💆</text>
						<text class="gc-header-title">妈妈本周变化</text>
					</view>
					<view class="gc-body">
						<view class="gc-list">
							<view class="gc-list-item" v-for="(item, idx) in guideData.mom.items" :key="idx">
								<view class="gc-dot gc-dot-rose">
									<text class="gc-dot-text">{{ item.label }}</text>
								</view>
								<text class="gc-list-text">{{ item.text }}</text>
							</view>
						</view>
						<view v-if="guideData.mom.highlight" class="gc-highlight gc-highlight-sage">
							<text>{{ guideData.mom.highlight }}</text>
						</view>
					</view>
				</view>

				<!-- 营养重点 -->
				<view class="gc-card">
					<view class="gc-header">
						<text class="gc-header-icon">🥗</text>
						<text class="gc-header-title">本周营养重点</text>
					</view>
					<scroll-view class="food-scroll" scroll-x>
						<view class="food-scroll-inner">
							<view class="food-item" v-for="(f, idx) in guideData.foods" :key="idx">
								<text class="food-icon">{{ f.icon }}</text>
								<text class="food-name">{{ f.name }}</text>
								<text class="food-why">{{ f.why }}</text>
							</view>
						</view>
					</scroll-view>
					<view v-if="guideData.avoidFood" class="gc-body" style="padding-top: 0;">
						<view class="gc-highlight gc-highlight-amber">
							<text>{{ guideData.avoidFood }}</text>
						</view>
					</view>
				</view>

				<!-- 产检提醒 -->
				<view class="gc-card">
					<view class="gc-header">
						<text class="gc-header-icon">🏥</text>
						<text class="gc-header-title">本阶段产检</text>
					</view>
					<view class="gc-body">
						<view class="gc-list">
							<view class="gc-list-item" v-for="(item, idx) in guideData.checkup" :key="idx">
								<view :class="['gc-dot', item.warn ? 'gc-dot-amber' : 'gc-dot-sage']">
									<text class="gc-dot-text">{{ item.icon }}</text>
								</view>
								<text class="gc-list-text">{{ item.text }}</text>
							</view>
						</view>
					</view>
				</view>

				<!-- 待产准备 -->
				<view class="gc-card">
					<view class="gc-header">
						<text class="gc-header-icon">🎒</text>
						<text class="gc-header-title">现在可以开始做的事</text>
					</view>
					<view class="gc-body">
						<view class="gc-list">
							<view class="gc-list-item" v-for="(item, idx) in guideData.preparation" :key="idx">
								<view class="gc-dot gc-dot-rose">
									<text class="gc-dot-text">{{ idx + 1 }}</text>
								</view>
								<text class="gc-list-text">{{ item }}</text>
							</view>
						</view>
					</view>
				</view>

				<view style="height: 40rpx;"></view>
			</view>
		</scroll-view>

		<!-- 内容未收录（周龄在本地兜底覆盖之外 / 数据缺）——诚实空态，不拿别的周冒充 -->
		<view v-else class="content-scroll">
			<view class="content">
				<view class="gc-card">
					<view class="gc-header">
						<text class="gc-header-icon">📖</text>
						<text class="gc-header-title">本周内容暂未收录</text>
					</view>
					<view class="gc-body">
						<view class="gc-list">
							<view class="gc-list-item">
								<view class="gc-dot gc-dot-sage"><text class="gc-dot-text">→</text></view>
								<text class="gc-list-text">数据加载异常——返回重进即可恢复（内容库随包分发，正常不会到这）</text>
							</view>
						</view>
					</view>
				</view>
			</view>
		</view>
	</view>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { onLoad, onReady } from '@dcloudio/uni-app'
import { useStaticDataStore } from '@/stores/staticData.js'

const staticDataStore = useStaticDataStore()

// 0 = 未就绪（参数未达/非法）。不再写死演示假默认 32——那个假默认会在首次渲染
// 瞬间把周条滚动并高亮到孕 32 周，参数纠正后高亮移走但滚动不跟随（真机已复现）。
const currentWeek = ref(0)
const cloudData = ref(null)
const loadError = ref(false)

// 周条定位目标：首渲染恒为空（不抢跑），onReady 布局完成后一次性定位到真实孕周；
// 切周时先清空再赋值，保证 scroll-into-view 属性发生真实变更（微信端才可靠触发）
const scrollTarget = ref('')
function locateWeek() {
	scrollTarget.value = ''
	nextTick(() => {
		scrollTarget.value = currentWeek.value > 0 ? `week-${currentWeek.value}` : ''
	})
}
watch(currentWeek, () => locateWeek())
onReady(() => locateWeek())

const heroTitle = computed(() => currentWeek.value > 0 ? `孕 ${currentWeek.value} 周完整指南` : '孕期指南')

// Load from page options (uni-app lifecycle)
onLoad((options) => {
	const w = parseInt(options && options.week)
	if (w >= 1 && w <= 40) {
		currentWeek.value = w
	}
	if (currentWeek.value > 0) {
		loadGuideData(currentWeek.value)
	}
})

const weekRange = computed(() => {
	// 显示完整的 1-40 周范围，让用户可以自由切换
	const range = []
	for (let i = 1; i <= 40; i++) range.push(i)
	return range
})

const daysLeft = computed(() => {
	const w = currentWeek.value
	return Math.max(0, (40 - w) * 7)
})

const heroSubtitle = computed(() => {
	const w = currentWeek.value
	if (w < 1 || !guideData.value) return '选择孕周查看对应指南'
	let month = ''
	if (w <= 12) month = '孕早期'
	else if (w <= 27) month = '孕中期'
	else month = '孕晚期'
	const data = guideData.value
	const weight = data.babyWeight || '未知'
	return `${month} · 宝宝约 ${weight} · 还有约 ${daysLeft.value} 天`
})

function selectWeek(w) {
	currentWeek.value = w
}

function goBack() {
	uni.navigateBack()
}

// ── 数据加载 ──
async function loadGuideData(week) {
		if (week < 1 || week > 40) return
		loadError.value = false
		if (!staticDataStore.loaded) await staticDataStore.loadData()
		cloudData.value = staticDataStore.getWeeklyGuide(week)
		if (!cloudData.value) loadError.value = true
	}

// 监听 currentWeek 变化时重新加载数据
watch(currentWeek, (newWeek) => {
	loadGuideData(newWeek)
})

// 将数据库记录映射为页面格式
function cloudToPageData(record) {
	if (!record) return null
	return {
		babyWeight: record.baby_weight,
		babyLength: record.baby_length,
		fundalHeight: record.fundal_height,
		baby: record.baby,
		mom: record.mom,
		foods: record.foods,
		avoidFood: record.avoid_food,
		checkup: record.checkup,
		preparation: record.preparation
	}
}

// ── Guide data for each week ──
// 本地兜底数据已删（2026-10-01 #3 清理）：打包静态库 pregnancy-weekly-guide.json
// 随包分发恒在，GUIDE_DATA 永不可达且为 JSON 的手工旧副本（漂移隐患）。
// 数据缺失时 guideData=null → 模板"暂未收录"诚实空态。

const guideData = computed(() => {
	if (cloudData.value) {
		const pageData = cloudToPageData(cloudData.value)
		if (pageData) return pageData
	}
	// 静态库随包恒在，此处仅防御数据链异常——诚实空态，不再有本地副本冒充
	return null
})

</script>

<style scoped lang="scss">
$cream: #FBF7F2;
$cream2: #F5EFE6;
$cream3: #EDE3D6;
$rose: #D4627A;
$rose-lt: #FAEAEE;
$rose-dk: #B04560;
$sage: #7BA08C;
$sage-lt: #EAF2EE;
$amber: #C98A3A;
$amber-lt: #FDF3E3;
$lavender: #9B7EC8;
$lav-lt: #F2EDFB;
$gray400: #9C9890;
$gray600: #4A4844;
$gray900: #1C1A17;
$border: #E8DDD0;

.page {
	min-height: 100vh;
	background: $cream;
	display: flex;
	flex-direction: column;
}

/* Hero */
.guide-hero {
	background: linear-gradient(140deg, #8A5A6A 0%, #C07080 40%, #E0A0B0 100%);
	padding: 0 40rpx 50rpx;
	flex-shrink: 0;
	position: relative;
	overflow: hidden;
}

.hero-top {
	display: flex;
	align-items: center;
	margin-bottom: 20rpx;
}

.back-btn {
	width: 64rpx;
	height: 64rpx;
	border-radius: 50%;
	background: rgba(255, 255, 255, 0.2);
	display: flex;
	align-items: center;
	justify-content: center;
}

.back-arrow {
	font-size: 36rpx;
	color: white;
	line-height: 1;
}

.hero-title {
	font-size: 48rpx;
	font-weight: 700;
	color: white;
	display: block;
	margin-bottom: 8rpx;
}

.hero-sub {
	font-size: 26rpx;
	color: rgba(255, 255, 255, 0.8);
	line-height: 1.6;
	display: block;
}

.hero-stats {
	display: flex;
	gap: 16rpx;
	margin-top: 24rpx;
}

.stat-card {
	background: rgba(255, 255, 255, 0.2);
	border-radius: 20rpx;
	padding: 16rpx 20rpx;
	flex: 1;
	text-align: center;
}

.stat-val {
	font-size: 32rpx;
	font-weight: 700;
	color: white;
	display: block;
}

.stat-lbl {
	font-size: 18rpx;
	color: rgba(255, 255, 255, 0.75);
	display: block;
	margin-top: 4rpx;
}

/* Week strip */
.week-strip {
	background: white;
	border-bottom: 2rpx solid $border;
	flex-shrink: 0;
	white-space: nowrap;
}

.week-strip-inner {
	display: flex;
	padding: 20rpx 28rpx;
	gap: 16rpx;
}

.week-chip {
	padding: 12rpx 28rpx;
	border-radius: 999rpx;
	background: $cream2;
	display: inline-flex;
	align-items: center;
	flex-shrink: 0;
}

.week-chip.active {
	background: $rose;
}

.week-chip-text {
	font-size: 24rpx;
	font-weight: 500;
	color: $gray600;
}

.week-chip.active .week-chip-text {
	color: white;
}

/* Content scroll */
.content-scroll {
	flex: 1;
	height: 0;
}

.content {
	padding: 24rpx 28rpx;
	display: flex;
	flex-direction: column;
	gap: 24rpx;
}

/* Guide cards */
.gc-card {
	background: white;
	border-radius: 32rpx;
	box-shadow: 0 4rpx 28rpx rgba(60, 30, 10, 0.07);
	overflow: hidden;
}

.gc-header {
	display: flex;
	align-items: center;
	gap: 16rpx;
	padding: 28rpx 32rpx;
	border-bottom: 2rpx solid $cream2;
}

.gc-header-icon {
	font-size: 40rpx;
}

.gc-header-title {
	font-size: 30rpx;
	font-weight: 600;
	color: $gray900;
}

.gc-body {
	padding: 28rpx 32rpx;
}

.gc-para {
	font-size: 26rpx;
	color: $gray600;
	line-height: 1.8;
	display: block;
	margin-bottom: 16rpx;
}

.gc-para:last-child {
	margin-bottom: 0;
}

.gc-highlight {
	border-radius: 20rpx;
	padding: 20rpx 28rpx;
	margin-top: 20rpx;
	font-size: 24rpx;
	line-height: 1.7;
	border-left: 6rpx solid;
}

.gc-highlight-rose {
	background: $rose-lt;
	border-left-color: $rose;
	color: $rose-dk;
}

.gc-highlight-sage {
	background: $sage-lt;
	border-left-color: $sage;
	color: #2D5A48;
}

.gc-highlight-amber {
	background: $amber-lt;
	border-left-color: $amber;
	color: #7A4A10;
}

/* List items */
.gc-list {
	display: flex;
	flex-direction: column;
	gap: 16rpx;
}

.gc-list-item {
	display: flex;
	align-items: flex-start;
	gap: 16rpx;
}

.gc-dot {
	width: 40rpx;
	height: 40rpx;
	border-radius: 50%;
	display: flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
	margin-top: 4rpx;
}

.gc-dot-text {
	font-size: 20rpx;
	font-weight: 700;
}

.gc-dot-rose {
	background: $rose-lt;
	color: $rose;
}

.gc-dot-sage {
	background: $sage-lt;
	color: $sage;
}

.gc-dot-amber {
	background: $amber-lt;
	color: $amber;
}

.gc-list-text {
	font-size: 26rpx;
	color: $gray600;
	line-height: 1.6;
}

/* Food scroll */
.food-scroll {
	white-space: nowrap;
}

.food-scroll-inner {
	display: flex;
	gap: 20rpx;
	padding: 28rpx 32rpx;
}

.food-item {
	flex-shrink: 0;
	background: $cream;
	border-radius: 20rpx;
	padding: 20rpx 24rpx;
	border: 2rpx solid $border;
	text-align: center;
	width: 240rpx;
	/* 重置外层 nowrap，允许内部文字换行 */
	white-space: normal;
}

.food-icon {
	font-size: 48rpx;
	display: block;
	margin-bottom: 8rpx;
}

.food-name {
	font-size: 24rpx;
	font-weight: 500;
	color: $gray900;
	display: block;
}

.food-why {
	font-size: 20rpx;
	color: $gray400;
	display: block;
	margin-top: 4rpx;
	line-height: 1.4;
	/* 强制换行 */
	white-space: normal;
	word-wrap: break-word;
	word-break: break-word;
	/* 多行省略 */
	display: -webkit-box;
	-webkit-box-orient: vertical;
	-webkit-line-clamp: 2;
	overflow: hidden;
	text-overflow: ellipsis;
}
</style>
