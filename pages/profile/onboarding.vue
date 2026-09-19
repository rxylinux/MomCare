<template>
	<view class="page">
		<!-- Status bar spacer -->
		<view :style="{ height: statusBarHeight + 'px' }"></view>

		<!-- Progress -->
		<view class="progress-wrap">
			<view class="progress-track">
				<view class="progress-fill" :style="{ width: progressPercent + '%' }"></view>
			</view>
			<text class="progress-label">步骤 {{ currentStep }} / 3</text>
		</view>

		<!-- Step content -->
		<scroll-view scroll-y class="step-scroll">
			<!-- Step 1: Basic Info -->
			<view v-if="currentStep === 1" class="step-content">
				<view class="step-header">
					<text class="step-emoji">🌸</text>
					<text class="step-title">基本信息</text>
					<text class="step-desc">填写您的昵称和孕期时间</text>
				</view>

				<view class="form-card">
					<view class="form-field">
						<text class="field-label">您的昵称</text>
						<view class="field-input-wrap">
							<input
								class="field-input"
								v-model="form.nickname"
								placeholder="请输入昵称"
								placeholder-class="field-placeholder"
								maxlength="20"
							/>
						</view>
					</view>

					<view class="form-field">
						<text class="field-label">宝宝昵称</text>
						<view class="field-input-wrap">
							<input
								class="field-input"
								v-model="form.babyNickname"
								placeholder="请输入宝宝昵称"
								placeholder-class="field-placeholder"
							/>
						</view>
					</view>

					<view class="form-field">
						<text class="field-label">末次月经第一天</text>
						<view class="field-input-wrap">
							<picker mode="date" :value="lmpDateStr" @change="onLmpDateChange">
								<view class="field-input field-input-picker">
									<text class="picker-text" :class="{ 'picker-placeholder': !lmpDateStr }">{{ lmpDateDisplay }}</text>
									<text class="picker-arrow">›</text>
								</view>
							</picker>
						</view>
						<text class="field-hint field-hint-warn">此日期直接影响孕周计算</text>
					</view>

					<view class="form-field">
						<text class="field-label">预产期</text>
						<view class="field-input-wrap">
							<picker mode="date" :value="dueDateStr" @change="onDueDateChange">
								<view class="field-input field-input-picker">
									<text class="picker-text" :class="{ 'picker-placeholder': !dueDateStr }">{{ dueDateDisplay }}</text>
									<text class="picker-arrow">›</text>
								</view>
							</picker>
						</view>
						<text class="field-hint">根据末次月经自动计算，可由医生修正</text>
					</view>
				</view>
			</view>

			<!-- Step 2: Weight -->
			<view v-if="currentStep === 2" class="step-content">
				<view class="step-header">
					<text class="step-emoji">⚖️</text>
					<text class="step-title">孕前体重</text>
					<text class="step-desc">用于计算孕期增重和BMI建议</text>
				</view>

				<view class="form-card">
					<view class="form-field">
						<text class="field-label">孕前体重</text>
						<view class="field-input-wrap">
							<input
								class="field-input"
								type="digit"
								v-model="form.preWeight"
								placeholder="请输入孕前体重"
								placeholder-class="field-placeholder"
								@blur="calcBMI"
							/>
							<text class="field-unit">kg</text>
						</view>
					</view>

					<view class="form-field">
						<text class="field-label">身高</text>
						<view class="field-input-wrap">
							<input
								class="field-input"
								type="digit"
								v-model="form.height"
								placeholder="请输入身高"
								placeholder-class="field-placeholder"
								@blur="calcBMI"
							/>
							<text class="field-unit">cm</text>
						</view>
					</view>

					<!-- BMI Result -->
					<view v-if="bmiResult" class="bmi-card">
						<view class="bmi-row">
							<text class="bmi-value">{{ bmiResult.bmi }}</text>
							<text class="bmi-label">{{ bmiResult.label }}</text>
						</view>
						<text class="bmi-range">建议孕期增重 {{ bmiResult.range }}</text>
					</view>
				</view>
			</view>

			<!-- Step 3: Hospital -->
			<view v-if="currentStep === 3" class="step-content">
				<view class="step-header">
					<text class="step-emoji">🏥</text>
					<text class="step-title">就诊信息</text>
					<text class="step-desc">方便产检提醒和档案管理</text>
				</view>

				<view class="form-card">
					<view class="form-field">
						<text class="field-label">就诊医院</text>
						<view class="field-input-wrap">
							<input
								class="field-input"
								v-model="form.hospital"
								placeholder="请输入就诊医院"
								placeholder-class="field-placeholder"
							/>
						</view>
					</view>

					<view class="form-field">
						<text class="field-label">主治医生</text>
						<view class="field-input-wrap">
							<input
								class="field-input"
								v-model="form.doctor"
								placeholder="选填"
								placeholder-class="field-placeholder"
							/>
						</view>
					</view>

					<view class="form-field">
						<text class="field-label">产科联系电话</text>
						<view class="field-input-wrap">
							<input
								class="field-input"
								type="tel"
								v-model="form.hospitalPhone"
								placeholder="选填"
								placeholder-class="field-placeholder"
							/>
						</view>
					</view>
				</view>
			</view>

			<view class="bottom-spacer"></view>
		</scroll-view>

		<!-- Bottom action bar -->
		<view class="action-bar">
			<view v-if="currentStep > 1" class="action-btn action-btn-prev" @tap="prevStep">
				<text class="action-btn-text">上一步</text>
			</view>
			<view class="action-btn" :class="canProceed ? 'action-btn-primary' : 'action-btn-disabled'" @tap="nextStep">
				<text class="action-btn-text">{{ currentStep === 3 ? '开始使用' : '下一步' }}</text>
			</view>
		</view>
	</view>
</template>

<script setup>
import { ref, computed, reactive } from 'vue'
import { useHealthStore } from '@/stores/health.js'
import { legacyHttpEnabled } from '@/utils/backendGate.js'

const healthStore = useHealthStore()

const statusBarHeight = ref(0)
const app = getApp()
if (app && app.globalData) {
	statusBarHeight.value = app.globalData.statusBarHeight || 0
}

const currentStep = ref(1)
const form = reactive({
	nickname: '',
	babyNickname: '',
	preWeight: '',
	height: '',
	hospital: '',
	doctor: '',
	hospitalPhone: ''
})

const lmpDateStr = ref('')
const dueDateStr = ref('')
const bmiResult = ref(null)

const progressPercent = computed(() => (currentStep.value / 3) * 100)

const lmpDateDisplay = computed(() => {
	if (!lmpDateStr.value) return '请选择日期'
	const parts = lmpDateStr.value.split('-')
	return `${parts[0]}年${parseInt(parts[1])}月${parseInt(parts[2])}日`
})

const dueDateDisplay = computed(() => {
	if (!dueDateStr.value) return '请选择日期'
	const parts = dueDateStr.value.split('-')
	return `${parts[0]}年${parseInt(parts[1])}月${parseInt(parts[2])}日`
})

const canProceed = computed(() => {
	if (currentStep.value === 1) {
		return lmpDateStr.value !== ''
	}
	return true
})

function onLmpDateChange(e) {
	lmpDateStr.value = e.detail.value
	const lmp = new Date(lmpDateStr.value)
	const due = new Date(lmp.getTime() + 280 * 86400000)
	const y = due.getFullYear()
	const m = String(due.getMonth() + 1).padStart(2, '0')
	const d = String(due.getDate()).padStart(2, '0')
	dueDateStr.value = `${y}-${m}-${d}`
}

function onDueDateChange(e) {
	dueDateStr.value = e.detail.value
}

function calcBMI() {
	const w = parseFloat(form.preWeight)
	const h = parseFloat(form.height)
	if (!w || !h || h <= 0) {
		bmiResult.value = null
		return
	}
	const heightM = h / 100
	const bmi = (w / (heightM * heightM)).toFixed(1)

	let label = ''
	let range = ''
	if (bmi < 18.5) { label = '偏瘦'; range = '12.5~18kg' }
	else if (bmi < 24) { label = '正常'; range = '11.5~16kg' }
	else if (bmi < 28) { label = '超重'; range = '7~11.5kg' }
	else { label = '肥胖'; range = '5~9kg' }

	bmiResult.value = { bmi, label, range }
}

function prevStep() {
	if (currentStep.value > 1) currentStep.value--
}

async function nextStep() {
	if (!canProceed.value) return

	if (currentStep.value < 3) {
		currentStep.value++
		return
	}

	// Final step: save all data
	healthStore.userInfo.nickname = form.nickname.trim() || healthStore.userInfo.nickname
	healthStore.userInfo.babyNickname = form.babyNickname.trim()
	healthStore.userInfo.preWeight = form.preWeight
	healthStore.userInfo.height = form.height
	healthStore.userInfo.hospital = form.hospital.trim()
	healthStore.userInfo.doctor = form.doctor.trim()
	healthStore.userInfo.hospitalPhone = form.hospitalPhone.trim()

	if (lmpDateStr.value) {
		const parts = lmpDateStr.value.split('-')
		healthStore.lmpDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]))
	}
	if (dueDateStr.value) {
		const parts = dueDateStr.value.split('-')
		healthStore.dueDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]))
	}

	uni.showLoading({ title: '保存中...' })
	try {
		const saveResult = await healthStore.saveUserProfile()
		if (!saveResult || !saveResult.ok) {
			// 本机持久化失败：停留在建档页，已填内容保留
			uni.hideLoading()
			uni.showToast({ title: '本地保存失败，内容已保留，请重试', icon: 'none', duration: 2500 })
			return
		}
		await healthStore.initCheckupSchedules()
		uni.hideLoading()
		// B1：旧云同步停用；档案仅存本机（新共享数据源在家庭共享页）
		if (legacyHttpEnabled() && isRealAuthed()) {
			const cloudOk = await healthStore.syncProfileToCloud()
			if (!cloudOk) {
				uni.showToast({ title: '已保存到本机，云端同步失败，可稍后重试', icon: 'none', duration: 2500 })
			}
		}
		uni.reLaunch({ url: '/pages/index/index' })
	} catch (e) {
		uni.hideLoading()
		uni.showToast({ title: '保存失败，请重试', icon: 'none' })
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

/* ── Progress ── */
.progress-wrap {
	padding: 0 48rpx 32rpx;
}

.progress-track {
	height: 6rpx;
	background: #EBE7E2;
	border-radius: 3rpx;
	overflow: hidden;
}

.progress-fill {
	height: 100%;
	background: linear-gradient(90deg, #E8637A, #C45070);
	border-radius: 3rpx;
	transition: width 0.3s ease;
}

.progress-label {
	display: block;
	font-size: 22rpx;
	color: #9B9590;
	margin-top: 12rpx;
	text-align: center;
}

/* ── Step Content ── */
.step-scroll {
	flex: 1;
}

.step-content {
	padding: 0 32rpx;
}

.step-header {
	display: flex;
	flex-direction: column;
	align-items: center;
	padding: 16rpx 0 40rpx;
}

.step-emoji {
	font-size: 80rpx;
	margin-bottom: 16rpx;
}

.step-title {
	font-size: 40rpx;
	font-weight: 700;
	color: #1C1A17;
	margin-bottom: 8rpx;
}

.step-desc {
	font-size: 26rpx;
	color: #9B9590;
}

/* ── Form Card ── */
.form-card {
	background: #FFFFFF;
	border-radius: 32rpx;
	box-shadow: 0 4rpx 28rpx rgba(60, 30, 10, 0.07);
	padding: 8rpx 32rpx 32rpx;
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

.field-unit {
	position: absolute;
	right: 28rpx;
	font-size: 26rpx;
	color: #9B9590;
	font-weight: 500;
}

.field-placeholder {
	color: #C8C2BC;
	font-size: 28rpx;
}

.field-hint {
	display: block;
	font-size: 22rpx;
	color: #B5AFA9;
	margin-top: 10rpx;
	line-height: 1.5;
}

.field-hint-warn {
	color: #E8976A;
}

/* ── BMI Card ── */
.bmi-card {
	margin-top: 16rpx;
	background: linear-gradient(135deg, #EAF7EF, #D4EDDC);
	border-radius: 20rpx;
	padding: 24rpx 28rpx;
}

.bmi-row {
	display: flex;
	align-items: baseline;
	gap: 12rpx;
	margin-bottom: 6rpx;
}

.bmi-value {
	font-size: 40rpx;
	font-weight: 700;
	color: #3A7D50;
}

.bmi-label {
	font-size: 26rpx;
	font-weight: 600;
	color: #5A9E6F;
}

.bmi-range {
	font-size: 24rpx;
	color: #6B9E78;
}

/* ── Bottom Spacer ── */
.bottom-spacer {
	height: 200rpx;
}

/* ── Action Bar ── */
.action-bar {
	display: flex;
	gap: 20rpx;
	padding: 20rpx 32rpx;
	padding-bottom: calc(20rpx + env(safe-area-inset-bottom));
	background: #FFFFFF;
	box-shadow: 0 -4rpx 24rpx rgba(60, 30, 10, 0.06);
}

.action-btn {
	flex: 1;
	height: 96rpx;
	border-radius: 48rpx;
	display: flex;
	align-items: center;
	justify-content: center;
}

.action-btn-primary {
	background: linear-gradient(135deg, #E8637A, #C45070);
	box-shadow: 0 8rpx 24rpx rgba(196, 80, 112, 0.3);
}

.action-btn-primary:active {
	opacity: 0.85;
	transform: scale(0.98);
	transition: all 0.15s ease;
}

.action-btn-disabled {
	background: #E8E4E0;
}

.action-btn-prev {
	background: #F5F2EF;
}

.action-btn-prev:active {
	opacity: 0.85;
}

.action-btn-text {
	font-size: 32rpx;
	font-weight: 600;
	color: #FFFFFF;
	letter-spacing: 2rpx;
}

.action-btn-prev .action-btn-text {
	color: #6E6A64;
}

.action-btn-disabled .action-btn-text {
	color: #B5AFA9;
}
</style>
