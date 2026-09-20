<template>
	<view class="page">
		<view class="head">
			<text class="title">胎动计时</text>
			<text class="subtitle">1 小时连续监测 · 5 分钟内的连续胎动计为 1 次</text>
		</view>

		<!-- 无进行中会话：入口 -->
		<view v-if="!session" class="start-card" @tap="onStart">
			<text class="start-title">开始记录胎动</text>
			<text class="start-desc">建议每天固定时段监测 1 小时</text>
		</view>

		<!-- 进行中会话 -->
		<template v-else>
			<!-- 倒计时环（绝对时间差驱动——切后台回来即时校准） -->
			<view class="ring-wrap">
				<view class="ring" :style="ringStyle">
					<view class="ring-inner">
						<text class="ring-remaining">{{ remainingText }}</text>
						<text class="ring-label">{{ overtime ? '已超出监测时长' : '剩余时间' }}</text>
					</view>
				</view>
			</view>
			<view class="stat-row">
				<view class="stat"><text class="stat-num">{{ validCount }}</text><text class="stat-label">有效胎动</text></view>
				<view class="stat"><text class="stat-num">{{ rawCount }}</text><text class="stat-label">原始点击</text></view>
				<view class="stat"><text class="stat-num">{{ elapsedText }}</text><text class="stat-label">已监测</text></view>
			</view>

			<!-- 核心大按键 -->
			<view class="kick-btn" :class="{ disabled: paused }" @tap="onKick">
				<text class="kick-btn-text">动了一下</text>
			</view>
			<view class="undo-row" @tap="onUndo">
				<text class="undo-text">撤销上次误触</text>
			</view>

			<!-- 状态控制 -->
			<view class="ctrl-row">
				<view class="ctrl-btn" @tap="onPauseResume"><text class="ctrl-text">{{ paused ? '继续' : '暂停' }}</text></view>
				<view class="ctrl-btn primary" @tap="onFinish"><text class="ctrl-text primary">完成记录</text></view>
				<view class="ctrl-btn danger" @tap="onDiscard"><text class="ctrl-text danger">放弃会话</text></view>
			</view>
			<view v-if="paused" class="paused-tip"><text class="paused-tip-text">已暂停（计时不走、点击停用；服务端会话时长不受影响）</text></view>
		</template>

		<!-- 历史会话卡片 -->
		<view class="history-card">
			<text class="history-title">历史会话</text>
			<view v-if="fetalSessions.length === 0" class="history-empty"><text class="history-empty-text">还没有完成的监测记录</text></view>
			<view v-for="s in fetalSessions" :key="(s.sessionId || s.localRef)" class="history-row">
				<view class="history-main">
					<text class="history-line">{{ dateKeyText(s) }} · {{ s.status === 'discarded' ? '已放弃' : `有效 ${s.validCount} 次 / 原始 ${s.rawCount || (s.clicks ? s.clicks.length : 0)} 次` }}</text>
					<text v-if="s.synced === false" class="history-pending">待同步（联网后自动补传）</text>
				</view>
			</view>
		</view>
	</view>
</template>

<script setup>
import { ref, computed } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { useToolsStore, fetalElapsedMs } from '@/services/toolsStore.js'
import { getSessionState } from '@/services/sessionService.js'

// 胎动连续计时页：绝对时间差计时（切后台校准）+ 5 分钟连击去重 + 撤销误触 + 历史卡片
const toolsStore = useToolsStore()

// 展示时钟（仅驱动刷新——时长恒由 now−startTime 计算，非累加器）
const nowTick = ref(Date.now())
let ticker = null

const session = computed(() => toolsStore.currentFetalSession)
const paused = computed(() => session.value && session.value.status === 'paused')
const validCount = computed(() => (session.value ? session.value.validCount : 0))
const rawCount = computed(() => (session.value ? session.value.rawCount || (session.value.clicks ? session.value.clicks.length : 0) : 0))
const fetalSessions = computed(() => toolsStore.fetalSessions)

const elapsedMs = computed(() => {
	void nowTick.value
	return session.value ? fetalElapsedMs(session.value, nowTick.value) : 0
})
const targetMs = computed(() => (session.value && session.value.targetDurationMs) || 3600000)
const remainingMs = computed(() => Math.max(0, targetMs.value - elapsedMs.value))
const overtime = computed(() => elapsedMs.value > targetMs.value)
const progressPct = computed(() => Math.min(100, Math.round((elapsedMs.value / targetMs.value) * 100)))
const ringStyle = computed(() => ({ background: `conic-gradient(#4a7cf7 ${progressPct.value * 3.6}deg, #edf1f8 0deg)` }))

function fmtClock(ms) {
	const s = Math.max(0, Math.floor(ms / 1000))
	const h = Math.floor(s / 3600)
	const m = Math.floor((s % 3600) / 60)
	const sec = s % 60
	const two = n => String(n).padStart(2, '0')
	return h > 0 ? `${two(h)}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`
}
const remainingText = computed(() => fmtClock(remainingMs.value))
const elapsedText = computed(() => fmtClock(elapsedMs.value))

function dateKeyText(s) {
	if (s.dateKey) return s.dateKey
	const d = new Date(s.startTime)
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function ensureTicker() {
	if (ticker) return
	ticker = setInterval(() => { nowTick.value = Date.now() }, 1000)
}

function onStart() {
	toolsStore.startFetalSession(3600000).then(r => {
		if (r.ok) uni.showToast({ title: '已开始监测', icon: 'none' })
		else if (r.code === 'offline-pending') uni.showToast({ title: '已开始（联网后同步）', icon: 'none' })
		else uni.showToast({ title: r.message || '开始失败', icon: 'none' })
	})
}

function onKick() {
	if (!session.value) return
	if (paused.value) { uni.showToast({ title: '已暂停——先继续再记录', icon: 'none' }); return }
	toolsStore.recordFetalClick().then(r => {
		if (r.ok || r.code === 'offline-pending') {
			uni.vibrateShort({ type: 'light' })
		} else {
			uni.showToast({ title: r.message || '记录失败，请重试', icon: 'none' })
		}
	})
}

function onUndo() {
	toolsStore.undoFetalClick().then(r => {
		if (r.ok || r.code === 'offline-pending') uni.showToast({ title: '已撤销上次误触', icon: 'none' })
		else if (r.code === 'nothing-to-undo') uni.showToast({ title: '没有可撤销的点击', icon: 'none' })
		else uni.showToast({ title: r.message || '撤销失败', icon: 'none' })
	})
}

function onPauseResume() {
	if (paused.value) {
		toolsStore.resumeFetalSession()
		ensureTicker()
	} else {
		toolsStore.pauseFetalSession()
	}
}

function onFinish() {
	toolsStore.finishFetalSession({ syncDaily: true }).then(r => {
		if (r.ok) uni.showToast({ title: '已完成记录（当日胎动已累计）', icon: 'none' })
		else if (r.code === 'offline-pending') uni.showToast({ title: '已暂存，联网后同步', icon: 'none' })
		else uni.showToast({ title: r.message || '完成失败', icon: 'none' })
	})
}

function onDiscard() {
	uni.showModal({
		title: '放弃本次监测？',
		content: '放弃后本次点击记录不会计入任何统计',
		confirmText: '放弃',
		cancelText: '再想想',
		success: res => {
			if (!res || !res.confirm) return
			toolsStore.discardFetalSession().then(r => {
				if (r.ok || r.code === 'offline-pending') uni.showToast({ title: '已放弃', icon: 'none' })
				else uni.showToast({ title: r.message || '操作失败', icon: 'none' })
			})
		}
	})
}

onShow(() => {
	nowTick.value = Date.now() // 切后台回来：绝对时间差即时校准
	ensureTicker()
	const s = getSessionState()
	if (s.status === 'confirmed' && s.member) {
		toolsStore.restoreFromCache()
		toolsStore.retryPending().catch(() => {})
		toolsStore.pullFetalSessions().catch(() => {})
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
.start-card {
	margin: 40rpx 32rpx;
	padding: 60rpx 32rpx;
	border-radius: 28rpx;
	background: linear-gradient(135deg, #4a7cf7, #6a5cf6);
	display: flex;
	flex-direction: column;
	align-items: center;
	box-shadow: 0 10rpx 30rpx rgba(74, 124, 247, 0.3);
}
.start-title {
	font-size: 36rpx;
	font-weight: 700;
	color: #ffffff;
}
.start-desc {
	margin-top: 12rpx;
	font-size: 24rpx;
	color: rgba(255, 255, 255, 0.85);
}
.ring-wrap {
	display: flex;
	justify-content: center;
	margin-top: 32rpx;
}
.ring {
	width: 360rpx;
	height: 360rpx;
	border-radius: 50%;
	display: flex;
	align-items: center;
	justify-content: center;
}
.ring-inner {
	width: 300rpx;
	height: 300rpx;
	border-radius: 50%;
	background: #ffffff;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
}
.ring-remaining {
	font-size: 56rpx;
	font-weight: 700;
	color: #11222e;
}
.ring-label {
	margin-top: 8rpx;
	font-size: 22rpx;
	color: #8a94a6;
}
.stat-row {
	display: flex;
	flex-direction: row;
	justify-content: space-around;
	margin: 32rpx 32rpx 0;
}
.stat {
	display: flex;
	flex-direction: column;
	align-items: center;
}
.stat-num {
	font-size: 40rpx;
	font-weight: 700;
	color: #2a3444;
}
.stat-label {
	margin-top: 6rpx;
	font-size: 22rpx;
	color: #8a94a6;
}
.kick-btn {
	margin: 40rpx 48rpx;
	height: 240rpx;
	border-radius: 50%;
	background: linear-gradient(135deg, #ff8a65, #ff6d3f);
	display: flex;
	align-items: center;
	justify-content: center;
	box-shadow: 0 12rpx 36rpx rgba(255, 109, 63, 0.4);
}
.kick-btn.disabled {
	opacity: 0.45;
}
.kick-btn-text {
	font-size: 44rpx;
	font-weight: 700;
	color: #ffffff;
}
.undo-row {
	display: flex;
	justify-content: center;
	padding: 8rpx 0 24rpx;
}
.undo-text {
	font-size: 26rpx;
	color: #4a7cf7;
}
.ctrl-row {
	display: flex;
	flex-direction: row;
	justify-content: center;
	gap: 20rpx;
	margin: 0 32rpx;
}
.ctrl-btn {
	flex: 1;
	padding: 22rpx 0;
	border-radius: 999rpx;
	background: #ffffff;
	display: flex;
	justify-content: center;
	box-shadow: 0 4rpx 16rpx rgba(17, 22, 34, 0.05);
}
.ctrl-btn.primary {
	background: #4a7cf7;
}
.ctrl-btn.danger {
	background: #fdeeee;
}
.ctrl-text {
	font-size: 26rpx;
	color: #46536a;
}
.ctrl-text.primary {
	color: #ffffff;
	font-weight: 600;
}
.ctrl-text.danger {
	color: #d9534f;
}
.paused-tip {
	margin: 20rpx 32rpx 0;
	padding: 16rpx 24rpx;
	border-radius: 16rpx;
	background: #fdf6e8;
}
.paused-tip-text {
	font-size: 22rpx;
	color: #9a7b2d;
}
.history-card {
	margin: 40rpx 32rpx 0;
	padding: 28rpx;
	border-radius: 24rpx;
	background: #ffffff;
	box-shadow: 0 4rpx 20rpx rgba(17, 22, 34, 0.06);
}
.history-title {
	font-size: 30rpx;
	font-weight: 600;
	color: #11222e;
}
.history-empty {
	padding: 32rpx 0;
	display: flex;
	justify-content: center;
}
.history-empty-text {
	font-size: 24rpx;
	color: #9aa4b5;
}
.history-row {
	padding: 20rpx 0;
	border-bottom: 1rpx solid #f0f3f8;
}
.history-main {
	display: flex;
	flex-direction: column;
}
.history-line {
	font-size: 26rpx;
	color: #2a3444;
}
.history-pending {
	margin-top: 6rpx;
	font-size: 22rpx;
	color: #d98a2b;
}
</style>
