<template>
	<view class="page">
		<!-- Status bar spacer -->
		<view :style="{ height: statusBarHeight + 'px' }"></view>

		<!-- Logo area -->
		<view class="logo-area">
			<text class="logo-emoji">🤰</text>
			<text class="logo-title">孕途伴侣</text>
			<text class="logo-sub">两个人一起照顾这段孕期</text>
		</view>

		<!-- Entries -->
		<view class="form-card">
			<view class="entry-title-wrap">
				<text class="entry-title">选择进入方式</text>
			</view>

			<!-- 家庭空间（CloudBase）：新用户直达正式云入口，无需先开演示 -->
			<view class="btn-primary" @tap="goFamily">
				<text class="btn-text">进入家庭空间（云）</text>
			</view>
			<view class="entry-hint-wrap">
				<text class="entry-hint">两人共享记录 / 本人私人笔记；首次使用可在此查看你的 OpenID 完成成员配置</text>
			</view>

			<!-- 演示模式入口：示例数据独立存储，明确标注，不进入正式档案 -->
			<view class="btn-guest" @tap="handleGuestLogin">
				<text class="btn-guest-text">🚀 演示模式 · 用示例数据体验</text>
			</view>
			<view class="entry-hint-wrap">
				<text class="entry-hint">演示数据与本机档案相互独立，可随时退出</text>
			</view>
		</view>
	</view>
</template>

<script setup>
import { ref } from 'vue'
import { useHealthStore } from '@/stores/health.js'

const statusBarHeight = ref(0)
const app = getApp()
if (app && app.globalData) {
	statusBarHeight.value = app.globalData.statusBarHeight || 0
}

// 家庭空间（CloudBase）：新装用户直达正式云身份确认入口
function goFamily() {
	uni.navigateTo({ url: '/pages/family/index' })
}

async function handleGuestLogin() {
	uni.showLoading({ title: '进入体验中...' })
	try {
		const healthStore = useHealthStore()
		// 显式进入演示模式：示例数据只写入演示存储，不影响正式档案
		const ok = healthStore.enterDemoMode()
		uni.hideLoading()
		if (!ok) {
			uni.showToast({ title: '进入演示模式失败，请重试', icon: 'none', duration: 2500 })
			return
		}
		uni.switchTab({ url: '/pages/index/index' })
	} catch (e) {
		uni.hideLoading()
		uni.showToast({ title: '进入演示模式失败，请重试', icon: 'none', duration: 2500 })
	}
}
</script>

<style scoped lang="scss">
.page {
	display: flex;
	flex-direction: column;
	height: 100vh;
	background-color: #FBF7F2;
	box-sizing: border-box;
}

.logo-area {
	display: flex;
	flex-direction: column;
	align-items: center;
	padding-top: 120rpx;
	margin-bottom: 60rpx;
}

.logo-emoji {
	font-size: 100rpx;
	margin-bottom: 16rpx;
}

.logo-title {
	font-size: 48rpx;
	font-weight: 700;
	color: #C45070;
	margin-bottom: 8rpx;
}

.logo-sub {
	font-size: 26rpx;
	color: #9C9890;
}

.form-card {
	background: #FFFFFF;
	border-radius: 32rpx;
	box-shadow: 0 4rpx 28rpx rgba(60, 30, 10, 0.07);
	margin: 0 40rpx;
	padding: 40rpx 36rpx 48rpx;
}

.entry-title-wrap {
	margin-bottom: 32rpx;
}

.entry-title {
	font-size: 30rpx;
	font-weight: 600;
	color: #1C1A17;
}

.entry-hint-wrap {
	margin-top: 14rpx;
	margin-bottom: 10rpx;
}

.entry-hint {
	font-size: 22rpx;
	color: #9C9890;
	line-height: 1.6;
}

.btn-primary {
	margin-top: 24rpx;
	height: 96rpx;
	border-radius: 48rpx;
	display: flex;
	align-items: center;
	justify-content: center;
	background: linear-gradient(135deg, #E8637A, #C45070);
	box-shadow: 0 8rpx 24rpx rgba(196, 80, 112, 0.3);
}

.btn-primary:active {
	opacity: 0.85;
	transform: scale(0.98);
	transition: all 0.15s ease;
}

.btn-text {
	font-size: 32rpx;
	font-weight: 600;
	color: #FFFFFF;
	letter-spacing: 2rpx;
}

.btn-guest {
	margin-top: 32rpx;
	height: 88rpx;
	border-radius: 44rpx;
	display: flex;
	align-items: center;
	justify-content: center;
	background: #FFF0F5;
	border: 2rpx solid #F8BBD0;
	cursor: pointer;
}

.btn-guest:active {
	opacity: 0.8;
	transform: scale(0.98);
}

.btn-guest-text {
	font-size: 28rpx;
	font-weight: 600;
	color: #C2185B;
}
</style>
