<template>
	<view class="page">
		<!-- Status bar spacer -->
		<view :style="{ height: statusBarHeight + 'px' }"></view>

		<!-- Header -->
		<view class="header">
			<view class="back-btn" @tap="goBack">
				<text class="back-icon">‹</text>
			</view>
			<text class="header-title">创建账号</text>
			<view class="header-spacer"></view>
		</view>

		<!-- Step indicator -->
		<view class="steps">
			<view class="step" :class="{ 'step-active': true }">
				<text class="step-num">1</text>
			</view>
			<view class="step-line"></view>
			<view class="step" :class="{ 'step-active': phoneValid && passwordValid }">
				<text class="step-num">2</text>
			</view>
		</view>

		<!-- Form -->
		<view class="form-card">
			<view class="form-field">
				<text class="field-label">手机号</text>
				<view class="field-input-wrap">
					<input
						class="field-input"
						type="number"
						v-model="phone"
						placeholder="请输入手机号"
						placeholder-class="field-placeholder"
						maxlength="11"
					/>
					<text v-if="phoneValid" class="field-check">✓</text>
				</view>
			</view>

			<view class="form-field">
				<text class="field-label">密码</text>
				<view class="field-input-wrap">
					<input
						class="field-input"
						type="text"
						v-model="password"
						placeholder="至少6位密码"
						placeholder-class="field-placeholder"
						:password="!showPassword"
					/>
					<text class="field-eye" @tap="showPassword = !showPassword">{{ showPassword ? '👁' : '👁‍🗨' }}</text>
				</view>
			</view>

			<view class="form-field">
				<text class="field-label">确认密码</text>
				<view class="field-input-wrap">
					<input
						class="field-input"
						type="text"
						v-model="confirmPassword"
						placeholder="再次输入密码"
						placeholder-class="field-placeholder"
						:password="!showPassword"
					/>
				</view>
				<text v-if="passwordMismatch" class="field-error">两次密码不一致</text>
			</view>

			<view class="form-field">
				<text class="field-label">预产期（选填）</text>
				<view class="field-input-wrap">
					<picker mode="date" :value="dueDate" @change="onDueDateChange">
						<view class="field-input field-input-picker">
							<text class="picker-text" :class="{ 'picker-placeholder': !dueDate }">{{ dueDateDisplay }}</text>
							<text class="picker-arrow">›</text>
						</view>
					</picker>
				</view>
			</view>

			<!-- Register Button -->
			<view
				class="btn-primary"
				:class="{ 'btn-disabled': !canRegister }"
				@tap="handleRegister"
			>
				<text class="btn-text">注 册</text>
			</view>

			<!-- Login link -->
			<view class="bottom-link">
				<text class="link-text">已有账号？</text>
				<text class="link-action" @tap="goLogin">去登录</text>
			</view>
		</view>
	</view>
</template>

<script setup>
import { ref, computed } from 'vue'
import { request, setToken } from '@/utils/api.js'
import { useHealthStore } from '@/stores/health.js'

const statusBarHeight = ref(0)
const app = getApp()
if (app && app.globalData) {
	statusBarHeight.value = app.globalData.statusBarHeight || 0
}

const phone = ref('')
const password = ref('')
const confirmPassword = ref('')
const dueDate = ref('')
const showPassword = ref(false)

const phoneValid = computed(() => /^1\d{10}$/.test(phone.value))
const passwordValid = computed(() => password.value.length >= 6)
const passwordMismatch = computed(() => confirmPassword.value.length > 0 && password.value !== confirmPassword.value)

const canRegister = computed(() => phoneValid.value && passwordValid.value && !passwordMismatch.value)

const dueDateDisplay = computed(() => {
	if (!dueDate.value) return '请选择预产期'
	const parts = dueDate.value.split('-')
	return `${parts[0]}年${parseInt(parts[1])}月${parseInt(parts[2])}日`
})

function onDueDateChange(e) {
	dueDate.value = e.detail.value
}

async function handleRegister() {
	if (!canRegister.value) return

	uni.showLoading({ title: '注册中...' })
	try {
		const res = await request({
			url: '/api/register',
			method: 'POST',
			data: {
				phone: phone.value,
				password: password.value,
				expected_due_date: dueDate.value || undefined,
			},
			skipAuthRedirect: true,
		})

		uni.hideLoading()

		if (res.data && res.data.code === 0 && res.data.data && res.data.data.token) {
			const { token, user } = res.data.data
			setToken(token)
			try {
				uni.setStorageSync('momcare_user', JSON.stringify(user))
			} catch (cacheErr) {
				console.warn('momcare_user cache write failed:', cacheErr)
			}

			const healthStore = useHealthStore()
			if (!healthStore.afterRealLogin()) {
				uni.showToast({ title: '进入正式模式失败，请重试', icon: 'none', duration: 2500 })
				return
			}
			await healthStore.syncCloudData()

			uni.showToast({ title: '注册成功', icon: 'success' })
			setTimeout(() => {
				if (healthStore.dueDate || healthStore.lmpDate) {
					uni.switchTab({ url: '/pages/index/index' })
				} else {
					uni.redirectTo({ url: '/pages/profile/onboarding' })
				}
			}, 800)
		} else {
			uni.showToast({ title: (res.data && res.data.msg) || '注册失败', icon: 'none' })
		}
	} catch (e) {
		uni.hideLoading()
		const offline = e && e.networkError
		uni.showToast({ title: offline ? '网络不可用，请检查网络后重试' : '注册失败，请重试', icon: 'none', duration: 2500 })
	}
}

function goBack() {
	uni.navigateBack({ delta: 1 })
}

function goLogin() {
	uni.navigateBack({ delta: 1 })
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

.header {
	display: flex;
	align-items: center;
	padding: 16rpx 32rpx;
	gap: 20rpx;
}

.back-btn {
	width: 68rpx;
	height: 68rpx;
	border-radius: 50%;
	background: #F2F0EE;
	display: flex;
	align-items: center;
	justify-content: center;
}

.back-icon {
	font-size: 32rpx;
	color: #3A3834;
	line-height: 1;
	transform: translateY(-1rpx);
}

.header-title {
	flex: 1;
	font-size: 34rpx;
	font-weight: 600;
	color: #1C1A17;
}

.header-spacer {
	width: 68rpx;
}

/* Steps */
.steps {
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 32rpx 0 48rpx;
	gap: 0;
}

.step {
	width: 48rpx;
	height: 48rpx;
	border-radius: 50%;
	background: #E4E1DC;
	display: flex;
	align-items: center;
	justify-content: center;
	transition: background 0.2s;
}

.step-active {
	background: #C45070;
}

.step-num {
	font-size: 24rpx;
	font-weight: 600;
	color: #FFFFFF;
}

.step-line {
	width: 80rpx;
	height: 4rpx;
	background: #E4E1DC;
}

.step-active + .step-line,
.step-line + .step-active {
	background: #C45070;
}

/* Form */
.form-card {
	background: #FFFFFF;
	border-radius: 32rpx;
	box-shadow: 0 4rpx 28rpx rgba(60, 30, 10, 0.07);
	margin: 0 40rpx;
	padding: 8rpx 36rpx 48rpx;
}

.form-field {
	padding: 20rpx 0;
}

.field-label {
	display: block;
	font-size: 22rpx;
	font-weight: 500;
	color: #9B9590;
	letter-spacing: 2rpx;
	margin-bottom: 12rpx;
}

.field-input-wrap {
	position: relative;
	display: flex;
	align-items: center;
}

.field-input {
	flex: 1;
	height: 88rpx;
	background: #F5F2EF;
	border-radius: 20rpx;
	padding: 0 28rpx;
	font-size: 28rpx;
	color: #1C1A17;
	border: 2rpx solid transparent;
	box-sizing: border-box;
}

.field-input-picker {
	display: flex;
	align-items: center;
	justify-content: space-between;
}

.picker-text {
	font-size: 28rpx;
	color: #1C1A17;
}

.picker-placeholder {
	color: #C8C2BC;
}

.picker-arrow {
	font-size: 32rpx;
	color: #C8C2BC;
	font-weight: 300;
}

.field-placeholder {
	color: #C8C2BC;
	font-size: 28rpx;
}

.field-check {
	position: absolute;
	right: 28rpx;
	font-size: 28rpx;
	color: #4CAF82;
	font-weight: 700;
}

.field-eye {
	position: absolute;
	right: 28rpx;
	font-size: 28rpx;
	padding: 8rpx;
}

.field-error {
	display: block;
	font-size: 22rpx;
	color: #E8637A;
	margin-top: 8rpx;
}

.btn-primary {
	margin-top: 32rpx;
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

.btn-disabled {
	background: #E8E4E0;
	box-shadow: none;
}

.btn-text {
	font-size: 32rpx;
	font-weight: 600;
	color: #FFFFFF;
	letter-spacing: 4rpx;
}

.btn-disabled .btn-text {
	color: #B5AFA9;
}

.bottom-link {
	display: flex;
	justify-content: center;
	align-items: center;
	margin-top: 36rpx;
	gap: 8rpx;
}

.link-text {
	font-size: 26rpx;
	color: #9C9890;
}

.link-action {
	font-size: 26rpx;
	color: #C45070;
	font-weight: 600;
}
</style>
