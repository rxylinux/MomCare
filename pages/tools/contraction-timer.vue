<template>
	<view class="page">
		<view class="head">
			<text class="title">宫缩计时</text>
			<text class="subtitle">记录持续时长与发作间隔 · 511 规律仅为辅助参考</text>
		</view>

		<!-- 建档医院/医生/急救电话卡片 -->
		<view class="hospital-card">
			<view class="hospital-row">
				<text class="hospital-label">建档医院</text>
				<text class="hospital-value">{{ hospitalName }}</text>
			</view>
			<view class="hospital-row">
				<text class="hospital-label">主治医生</text>
				<text class="hospital-value">{{ doctorName }}</text>
			</view>
			<view class="call-btn" :class="{ empty: !hospitalPhone }" @tap="onCall">
				<text class="call-btn-text">{{ hospitalPhone ? `拨打就医电话 ${hospitalPhone}` : '尚未填写就医电话——去完善' }}</text>
			</view>
		</view>

		<!-- 核心起止切换按键 -->
		<view class="toggle-btn" :class="{ ongoing: !!active }" @tap="onToggle">
			<text class="toggle-btn-text">{{ active ? '宫缩结束了' : '宫缩开始了' }}</text>
			<text v-if="active" class="toggle-btn-sub">已持续 {{ currentDurationText }}</text>
		</view>

		<!-- 实时统计 -->
		<view class="stat-card">
			<view class="stat-item">
				<text class="stat-num">{{ avgDurationSec === null ? '—' : avgDurationSec + 's' }}</text>
				<text class="stat-label">平均持续（近 1 小时）</text>
			</view>
			<view class="stat-item">
				<text class="stat-num">{{ avgIntervalMin === null ? '—' : avgIntervalMin + ' 分钟' }}</text>
				<text class="stat-label">平均间隔（近 1 小时）</text>
			</view>
		</view>

		<!-- 511 临产规律提示卡（辅助参考——不构成医疗诊断） -->
		<view class="p511-card" :class="{ hit: is511 }">
			<text class="p511-title">{{ is511 ? '符合 511 规律，建议联系医院或准备就医' : '当前未符合 511 规律' }}</text>
			<text class="p511-desc">511 参考：约每 5 分钟 1 次、每次持续约 1 分钟、规律持续约 1 小时</text>
			<text class="p511-disclaimer">{{ disclaimer }}</text>
		</view>

		<!-- 历史时间线 -->
		<view class="timeline-card">
			<text class="timeline-title">宫缩时间线</text>
			<view v-if="recentContractions.length === 0" class="timeline-empty"><text class="timeline-empty-text">还没有宫缩记录</text></view>
			<view v-for="r in recentContractions" :key="r.recordId || r.startTime" class="timeline-row">
				<view class="timeline-main">
					<text class="timeline-line">{{ timeText(r.startTime) }} 开始</text>
					<text class="timeline-meta">持续 {{ r.durationSec === null ? '—' : r.durationSec + 's' }} · 间隔 {{ r.intervalSec === null ? '—' : Math.round(r.intervalSec / 60) + ' 分钟' }}{{ r.intensity ? ' · ' + intensityText(r.intensity) : '' }}</text>
				</view>
				<view class="timeline-del" @tap="onDelete(r)"><text class="timeline-del-text">删除</text></view>
			</view>
		</view>
	</view>
</template>

<script setup>
import { ref, computed } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { useToolsStore } from '@/services/toolsStore.js'
import { getSessionState } from '@/services/sessionService.js'

// 宫缩计时页：起止切换 + 平均统计 + 511 辅助参考（免责声明）+ 就医电话联动
const toolsStore = useToolsStore()

const nowTick = ref(Date.now())
let ticker = null

const active = computed(() => toolsStore.activeContraction)
const hospitalName = computed(() => toolsStore.hospitalName)
const doctorName = computed(() => toolsStore.doctorName)
const hospitalPhone = computed(() => toolsStore.hospitalPhone)
const recentContractions = computed(() => toolsStore.recentContractions)
const avgDurationSec = computed(() => toolsStore.avgDurationSec)
const avgIntervalSec = computed(() => toolsStore.avgIntervalSec)
const avgIntervalMin = computed(() => (avgIntervalSec.value === null ? null : Math.round(avgIntervalSec.value / 60)))
const is511 = computed(() => toolsStore.is511Pattern)
const disclaimer = toolsStore.disclaimer

const currentDurationText = computed(() => {
	void nowTick.value
	if (!active.value) return ''
	const sec = Math.max(0, Math.floor((nowTick.value - active.value.startTime) / 1000))
	return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`
})

function timeText(ms) {
	const d = new Date(ms)
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function intensityText(v) {
	return { mild: '轻度', moderate: '中度', strong: '强度' }[v] || v
}

function ensureTicker() {
	if (ticker) return
	ticker = setInterval(() => { nowTick.value = Date.now() }, 1000)
}

function onCall() {
	toolsStore.callHospital()
}

function onToggle() {
	if (active.value) {
		toolsStore.stopContraction().then(r => {
			if (r.ok) uni.showToast({ title: '已记录本次宫缩', icon: 'none' })
			else if (r.code === 'offline-pending') uni.showToast({ title: '已暂存，联网后同步', icon: 'none' })
			else uni.showToast({ title: r.message || '记录失败', icon: 'none' })
		})
	} else {
		toolsStore.startContraction().then(r => {
			if (r.ok) { uni.vibrateShort({ type: 'light' }); ensureTicker() }
			else if (r.code === 'offline-pending') { uni.showToast({ title: '已开始（联网后同步）', icon: 'none' }); ensureTicker() }
			else uni.showToast({ title: r.message || '开始失败', icon: 'none' })
		})
	}
}

function onDelete(r) {
	uni.showModal({
		title: '删除这条误录？',
		content: '删除后不再计入统计',
		confirmText: '删除',
		cancelText: '取消',
		success: res => {
			if (!res || !res.confirm) return
			toolsStore.deleteContraction(r.recordId).then(res2 => {
				if (res2.ok) uni.showToast({ title: '已删除', icon: 'none' })
				else uni.showToast({ title: res2.message || '删除失败', icon: 'none' })
			})
		}
	})
}

onShow(() => {
	nowTick.value = Date.now()
	ensureTicker()
	const s = getSessionState()
	if (s.status === 'confirmed' && s.member) {
		toolsStore.restoreFromCache()
		toolsStore.retryPending().catch(() => {})
		toolsStore.pullContractions().catch(() => {})
	}
})
</script>

<style>
.page {
	min-height: 100vh;
	background: #f5f7fb;
	padding-bottom: calc(40rpx + env(safe-area-inset-bottom));
}
.head {
	padding: 40rpx 32rpx 16rpx;
}
.title {
	font-size: 40rpx;
	font-weight: 700;
	color: #11222e;
}
.subtitle {
	display: block;
	margin-top: 8rpx;
	font-size: 24rpx;
	color: #8a94a6;
}
.hospital-card {
	margin: 24rpx 32rpx 0;
	padding: 28rpx;
	border-radius: 24rpx;
	background: #ffffff;
	box-shadow: 0 4rpx 20rpx rgba(17, 22, 34, 0.06);
}
.hospital-row {
	display: flex;
	flex-direction: row;
	justify-content: space-between;
	padding: 10rpx 0;
}
.hospital-label {
	font-size: 26rpx;
	color: #8a94a6;
}
.hospital-value {
	font-size: 26rpx;
	color: #2a3444;
}
.call-btn {
	margin-top: 16rpx;
	padding: 22rpx 0;
	border-radius: 999rpx;
	background: #e8f5ec;
	display: flex;
	justify-content: center;
}
.call-btn.empty {
	background: #f2f5fa;
}
.call-btn-text {
	font-size: 28rpx;
	color: #2f7d4e;
	font-weight: 600;
}
.call-btn.empty .call-btn-text {
	color: #8a94a6;
	font-weight: 400;
}
.toggle-btn {
	margin: 40rpx 48rpx;
	min-height: 220rpx;
	border-radius: 32rpx;
	background: linear-gradient(135deg, #4a7cf7, #6a5cf6);
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	box-shadow: 0 12rpx 36rpx rgba(74, 124, 247, 0.35);
}
.toggle-btn.ongoing {
	background: linear-gradient(135deg, #ff8a65, #ff6d3f);
	box-shadow: 0 12rpx 36rpx rgba(255, 109, 63, 0.4);
}
.toggle-btn-text {
	font-size: 44rpx;
	font-weight: 700;
	color: #ffffff;
}
.toggle-btn-sub {
	margin-top: 10rpx;
	font-size: 26rpx;
	color: rgba(255, 255, 255, 0.9);
}
.stat-card {
	margin: 0 32rpx;
	padding: 28rpx;
	border-radius: 24rpx;
	background: #ffffff;
	display: flex;
	flex-direction: row;
	box-shadow: 0 4rpx 20rpx rgba(17, 22, 34, 0.06);
}
.stat-item {
	flex: 1;
	display: flex;
	flex-direction: column;
	align-items: center;
}
.stat-num {
	font-size: 38rpx;
	font-weight: 700;
	color: #2a3444;
}
.stat-label {
	margin-top: 6rpx;
	font-size: 22rpx;
	color: #8a94a6;
}
.p511-card {
	margin: 24rpx 32rpx 0;
	padding: 28rpx;
	border-radius: 24rpx;
	background: #f7f9fc;
	border: 2rpx solid #e3e8f0;
}
.p511-card.hit {
	background: #fff7f0;
	border-color: #ffb38a;
}
.p511-title {
	font-size: 28rpx;
	font-weight: 600;
	color: #2a3444;
}
.p511-card.hit .p511-title {
	color: #d9534f;
}
.p511-desc {
	display: block;
	margin-top: 10rpx;
	font-size: 24rpx;
	color: #46536a;
}
.p511-disclaimer {
	display: block;
	margin-top: 12rpx;
	font-size: 22rpx;
	color: #8a94a6;
	line-height: 1.6;
}
.timeline-card {
	margin: 24rpx 32rpx 0;
	padding: 28rpx;
	border-radius: 24rpx;
	background: #ffffff;
	box-shadow: 0 4rpx 20rpx rgba(17, 22, 34, 0.06);
}
.timeline-title {
	font-size: 30rpx;
	font-weight: 600;
	color: #11222e;
}
.timeline-empty {
	padding: 32rpx 0;
	display: flex;
	justify-content: center;
}
.timeline-empty-text {
	font-size: 24rpx;
	color: #9aa4b5;
}
.timeline-row {
	display: flex;
	flex-direction: row;
	align-items: center;
	justify-content: space-between;
	padding: 20rpx 0;
	border-bottom: 1rpx solid #f0f3f8;
}
.timeline-main {
	display: flex;
	flex-direction: column;
}
.timeline-line {
	font-size: 26rpx;
	color: #2a3444;
}
.timeline-meta {
	margin-top: 6rpx;
	font-size: 22rpx;
	color: #8a94a6;
}
.timeline-del {
	padding: 8rpx 20rpx;
	border-radius: 12rpx;
	background: #fdeeee;
}
.timeline-del-text {
	font-size: 22rpx;
	color: #d9534f;
}
</style>
