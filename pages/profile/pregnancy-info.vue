<template>
	<view class="page">
		<!-- NavBar -->
		<NavBar theme="light" title="孕期信息">
			<template #right>
				<view class="nav-save-btn" @tap="handleSave">
					<text class="nav-save-text">保存</text>
				</view>
			</template>
		</NavBar>

		<!-- Scrollable Content -->
		<scroll-view scroll-y class="scroll-content">
			<!-- Intro Text -->
			<view class="intro-section">
				<text class="intro-text">以下信息用于计算孕周和预产期，请确保准确填写。</text>
			</view>

			<!-- 基本信息 -->
			<view class="section-card">
				<view class="section-header">
					<view class="section-icon">
						<text class="section-icon-text">📋</text>
					</view>
					<text class="section-title">基本信息</text>
				</view>

				<!-- 宝妈昵称 -->
				<view class="form-field">
					<text class="field-label">宝妈昵称</text>
					<view class="field-input-wrap">
						<input
							class="field-input field-input-lg"
							v-model="form.nickname"
							placeholder="请输入您的昵称"
							placeholder-class="field-placeholder"
						/>
					</view>
				</view>

				<!-- 宝宝昵称 -->
				<view class="form-field">
					<text class="field-label">宝宝昵称</text>
					<view class="field-input-wrap">
						<input
							class="field-input field-input-lg"
							v-model="form.babyNickname"
							placeholder="请输入宝宝昵称"
							placeholder-class="field-placeholder"
						/>
					</view>
				</view>

				<!-- 末次月经第一天 -->
				<view class="form-field">
					<text class="field-label">末次月经第一天</text>
					<view class="field-input-wrap">
						<picker
							mode="date"
							:value="lmpDateStr"
							@change="onLmpDateChange"
						>
							<view class="field-input field-input-picker">
								<text class="picker-text">{{ lmpDateDisplay }}</text>
								<text class="picker-arrow">›</text>
							</view>
						</picker>
					</view>
					<text class="field-hint field-hint-warn">⚠️ 此日期直接影响孕周计算，请务必确认准确</text>
				</view>

				<!-- 预产期 -->
				<view class="form-field">
					<text class="field-label">预产期</text>
					<view class="field-input-wrap">
						<picker
							mode="date"
							:value="dueDateStr"
							@change="onDueDateChange"
						>
							<view class="field-input field-input-picker">
								<text class="picker-text">{{ dueDateDisplay }}</text>
								<text class="picker-arrow">›</text>
							</view>
						</picker>
					</view>
					<text class="field-hint">根据末次月经自动计算（可由医生修正）</text>
				</view>
			</view>

			<!-- 孕前体重 -->
			<view class="section-card">
				<view class="section-header">
					<view class="section-icon">
						<text class="section-icon-text">⚖️</text>
					</view>
					<text class="section-title">孕前体重</text>
				</view>

				<!-- 孕前体重 -->
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
					<text class="field-hint" v-if="bmiResult">
						当前BMI: {{ bmiResult.bmi }}（{{ bmiResult.label }}），建议孕期增重范围 {{ bmiResult.range }}
					</text>
				</view>

				<!-- 身高 -->
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
			</view>

			<!-- 就诊信息 -->
			<view class="section-card">
				<view class="section-header">
					<view class="section-icon">
						<text class="section-icon-text">🏥</text>
					</view>
					<text class="section-title">就诊信息</text>
				</view>

				<!-- 就诊医院 -->
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

				<!-- 主治医生 -->
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

				<!-- 产科联系电话 -->
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

			<!-- Bottom spacer for fixed bar -->
			<view class="bottom-spacer"></view>
		</scroll-view>

		<!-- Fixed Bottom Save Bar -->
		<view class="save-bar">
			<view class="save-bar-inner">
				<view class="save-btn" @tap="handleSave">
					<text class="save-btn-text">保存孕期信息</text>
				</view>
			</view>
		</view>
	</view>
</template>

<script setup>
import { ref, computed, reactive, onMounted, nextTick } from 'vue'
import { useHealthStore } from '@/stores/health.js'
import { isRealAuthed } from '@/utils/api.js'
import NavBar from '@/components/NavBar.vue'

const healthStore = useHealthStore()

// 表单数据
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

// BMI 计算结果
const bmiResult = ref(null)

// 格式化日期显示
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

// 初始化表单数据
onMounted(() => {
	const userInfo = healthStore.userInfo
	form.nickname = userInfo.nickname || ''
	form.babyNickname = userInfo.babyNickname || ''
	form.hospital = userInfo.hospital || ''
	form.doctor = userInfo.doctor || ''
	form.hospitalPhone = userInfo.hospitalPhone || ''
	form.preWeight = userInfo.preWeight || ''
	form.height = userInfo.height || ''

	// 只在首次有体重和身高时计算BMI
	if (form.preWeight && form.height) {
		calcBMI()
	}

	// 延迟日期格式化，避免阻塞首屏
	nextTick(() => {
		const lmp = healthStore.lmpDate
		if (lmp) lmpDateStr.value = formatDate(lmp)

		const due = healthStore.dueDate
		if (due) dueDateStr.value = formatDate(due)
	})
})

function formatDate(date) {
	if (!date) return ''
	const y = date.getFullYear()
	const m = String(date.getMonth() + 1).padStart(2, '0')
	const d = String(date.getDate()).padStart(2, '0')
	return `${y}-${m}-${d}`
}

function onLmpDateChange(e) {
	lmpDateStr.value = e.detail.value
	// 自动计算预产期（末次月经 + 280天）
	const lmp = new Date(lmpDateStr.value)
	const due = new Date(lmp.getTime() + 280 * 86400000)
	dueDateStr.value = formatDate(due)
}

function onDueDateChange(e) {
	dueDateStr.value = e.detail.value
}

// 防抖定时器
let bmiCalcTimer = null

function calcBMI() {
	// 防抖：清除已有定时器
	if (bmiCalcTimer) {
		clearTimeout(bmiCalcTimer)
	}

	// 延迟 50ms 执行，避免频繁计算
	bmiCalcTimer = setTimeout(() => {
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
		if (bmi < 18.5) {
			label = '偏瘦'
			range = '12.5~18kg'
		} else if (bmi < 24) {
			label = '正常'
			range = '11.5~16kg'
		} else if (bmi < 28) {
			label = '超重'
			range = '7~11.5kg'
		} else {
			label = '肥胖'
			range = '5~9kg'
		}

		bmiResult.value = { bmi, label, range }
		bmiCalcTimer = null
	}, 50)
}

async function handleSave() {
	// 备份旧值用于回滚
	const oldUserInfo = { ...healthStore.userInfo }
	const oldLmpDate = healthStore.lmpDate
	const oldDueDate = healthStore.dueDate

	// 更新 store 数据
	healthStore.userInfo.nickname = form.nickname
	healthStore.userInfo.babyNickname = form.babyNickname
	healthStore.userInfo.hospital = form.hospital
	healthStore.userInfo.doctor = form.doctor
	healthStore.userInfo.hospitalPhone = form.hospitalPhone
	healthStore.userInfo.preWeight = form.preWeight
	healthStore.userInfo.height = form.height

	// 更新日期
	if (lmpDateStr.value) {
		const parts = lmpDateStr.value.split('-')
		healthStore.lmpDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]))
	}
	if (dueDateStr.value) {
		const parts = dueDateStr.value.split('-')
		healthStore.dueDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]))
	}

	// 显示加载状态
	uni.showLoading({ title: '保存中...' })

	try {
		const saveResult = await healthStore.saveUserProfile()

		// 本机持久化（含产检迁移的二次写入）失败：不显示成功、不返回，表单内容保留
		if (!saveResult || !saveResult.ok) {
			uni.hideLoading()
			uni.showToast({ title: '本地保存失败，内容已保留，请重试', icon: 'none', duration: 2500 })
			return
		}

		// 已登录用户同步到云端（演示模式为纯本地保存）
		if (isRealAuthed()) {
			const cloudOk = await healthStore.syncProfileToCloud()
			if (!cloudOk) {
				// 回滚本地修改
				Object.assign(healthStore.userInfo, oldUserInfo)
				healthStore.lmpDate = oldLmpDate
				healthStore.dueDate = oldDueDate
				const rollback = await healthStore.saveUserProfile()
				uni.hideLoading()
				if (!rollback.ok) {
					uni.showToast({ title: '云端同步失败，且本地回滚未完成，请重新保存', icon: 'none', duration: 3000 })
					return
				}
				uni.showToast({ title: '同步云端失败，请重试', icon: 'error', duration: 2000 })
				return
			}
		}

		uni.hideLoading()

		uni.showToast({
			title: '保存成功',
			icon: 'success',
			duration: 1500
		})

		// 保存成功后返回
		setTimeout(() => {
			uni.navigateBack()
		}, 1500)
	} catch (e) {
		uni.hideLoading()
		uni.showToast({
			title: '保存失败',
			icon: 'error',
			duration: 2000
		})
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

.scroll-content {
	flex: 1;
	padding-bottom: 20rpx;
}

/* NavBar right save button */
.nav-save-btn {
	padding: 8rpx 24rpx;
	display: flex;
	align-items: center;
	justify-content: center;
}

.nav-save-text {
	font-size: 30rpx;
	color: #E8637A;
	font-weight: 600;
}

/* Intro section */
.intro-section {
	padding: 28rpx 32rpx 8rpx;
}

.intro-text {
	font-size: 26rpx;
	color: #9B9590;
	line-height: 1.6;
}

/* Section Card */
.section-card {
	background: #FFFFFF;
	border-radius: 32rpx;
	box-shadow: 0 4rpx 28rpx rgba(60, 30, 10, 0.07);
	overflow: hidden;
	margin: 20rpx 24rpx 0;
	padding: 0 32rpx 32rpx;
}

.section-header {
	display: flex;
	align-items: center;
	gap: 16rpx;
	padding: 32rpx 0 16rpx;
	border-bottom: 1px solid #F5F2EF;
	margin-bottom: 8rpx;
}

.section-icon {
	width: 52rpx;
	height: 52rpx;
	border-radius: 16rpx;
	background: #FAF0EE;
	display: flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
}

.section-icon-text {
	font-size: 28rpx;
}

.section-title {
	font-size: 32rpx;
	font-weight: 600;
	color: #1C1A17;
}

/* Form Field */
.form-field {
	padding: 20rpx 0;
}

.field-label {
	display: block;
	font-size: 22rpx;
	font-weight: 500;
	color: #9B9590;
	text-transform: uppercase;
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
	transition: all 0.2s ease;
	box-sizing: border-box;
}

.field-input-lg {
	font-size: 34rpx;
	font-weight: 500;
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

/* Bottom Spacer */
.bottom-spacer {
	height: 180rpx;
}

/* Fixed Bottom Save Bar */
.save-bar {
	position: fixed;
	left: 0;
	right: 0;
	bottom: 0;
	background: #FFFFFF;
	padding: 20rpx 32rpx;
	padding-bottom: calc(20rpx + env(safe-area-inset-bottom));
	box-shadow: 0 -4rpx 24rpx rgba(60, 30, 10, 0.06);
	z-index: 100;
}

.save-bar-inner {
	display: flex;
	align-items: center;
	justify-content: center;
}

.save-btn {
	width: 100%;
	height: 96rpx;
	border-radius: 48rpx;
	display: flex;
	align-items: center;
	justify-content: center;
	background: linear-gradient(135deg, #7FB88F, #5A9E6F);
	box-shadow: 0 8rpx 24rpx rgba(90, 158, 111, 0.3);
}

.save-btn:active {
	opacity: 0.85;
	transform: scale(0.98);
	transition: all 0.15s ease;
}

.save-btn-text {
	font-size: 32rpx;
	font-weight: 600;
	color: #FFFFFF;
	letter-spacing: 2rpx;
}
</style>
