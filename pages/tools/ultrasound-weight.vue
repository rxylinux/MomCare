<template>
	<view class="page">
		<view class="head">
			<text class="title">B 超估重</text>
			<text class="subtitle">Hadlock 1985 三参数式（HC+AC+FL）· 仅供参考</text>
		</view>

		<!-- 单位切换 -->
		<view class="unit-row">
			<view class="unit-seg" :class="{ active: form.unit === 'cm' }" @tap="setUnit('cm')">
				<text class="unit-seg-text" :class="{ active: form.unit === 'cm' }">cm</text>
			</view>
			<view class="unit-seg" :class="{ active: form.unit === 'mm' }" @tap="setUnit('mm')">
				<text class="unit-seg-text" :class="{ active: form.unit === 'mm' }">mm</text>
			</view>
		</view>

		<!-- 输入区 -->
		<view class="form-card">
			<view class="form-row">
				<text class="form-label">孕周</text>
				<input v-model="form.week" type="number" class="form-input" placeholder="12~42" placeholder-class="form-placeholder" />
			</view>
			<view class="form-row">
				<text class="form-label">头围 HC</text>
				<input v-model="form.hc" type="digit" class="form-input" :placeholder="unitPlaceholder" placeholder-class="form-placeholder" />
			</view>
			<view class="form-row">
				<text class="form-label">腹围 AC</text>
				<input v-model="form.ac" type="digit" class="form-input" :placeholder="unitPlaceholder" placeholder-class="form-placeholder" />
			</view>
			<view class="form-row">
				<text class="form-label">股骨长 FL</text>
				<input v-model="form.fl" type="digit" class="form-input" :placeholder="unitPlaceholder" placeholder-class="form-placeholder" />
			</view>
			<view class="form-row">
				<text class="form-label">双顶径 BPD（可选）</text>
				<input v-model="form.bpd" type="digit" class="form-input" :placeholder="unitPlaceholder" placeholder-class="form-placeholder" />
			</view>
			<text class="form-hint">BPD 仅随记录保存，不参与本公式计算</text>
		</view>

		<!-- 实时结果卡片 -->
		<view class="result-card" :class="{ invalid: result && result.err }">
			<template v-if="result && !result.err">
				<text class="result-grams">{{ result.efwGrams }} g</text>
				<text class="result-kg">约 {{ result.efwKg.toFixed(2) }} kg</text>
				<text class="result-range">参考区间（±10%）：{{ result.rangeGrams.low }} ~ {{ result.rangeGrams.high }} g</text>
				<text class="result-meta">{{ result.formula }} · log10={{ result.log10.toFixed(5) }}</text>
			</template>
			<text v-else-if="result && result.err" class="result-invalid">{{ result.err }}</text>
			<text v-else class="result-empty">填写 HC / AC / FL 后实时估算</text>
		</view>

		<!-- 保存 -->
		<view class="save-btn" :class="{ disabled: !canSave }" @tap="onSave">
			<text class="save-btn-text">{{ saving ? '保存中…' : '保存本次估重' }}</text>
		</view>

		<!-- 免责声明 -->
		<view class="disclaimer-card">
			<text class="disclaimer-text">{{ DISCLAIMER }}</text>
		</view>

		<!-- 历史时间线 -->
		<view class="history-card">
			<text class="history-title">估重历史</text>
			<view v-if="efwRecords.length === 0" class="history-empty"><text class="history-empty-text">还没有保存的估重记录</text></view>
			<view v-for="r in efwRecords" :key="r.recordId" class="history-row">
				<view class="history-main">
					<text class="history-line">{{ r.dateKey }} · 孕{{ r.gestationalWeek }}周 · 约 {{ r.efwGrams }} g</text>
					<text class="history-meta">HC {{ r.measurements.hcCm }} / AC {{ r.measurements.acCm }} / FL {{ r.measurements.flCm }} cm{{ r.measurements.bpdMm ? ' · BPD ' + r.measurements.bpdMm + 'mm' : '' }}</text>
				</view>
				<view class="history-del" @tap="onDelete(r)"><text class="history-del-text">删除</text></view>
			</view>
		</view>
	</view>
</template>

<script setup>
import { ref, computed, reactive } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { useToolsStore, computeHadlockEfw } from '@/services/toolsStore.js'
import { getSessionState } from '@/services/sessionService.js'

// B 超估重页：单位切换（cm⇄mm 即时重算）+ 实时结果卡（克/公斤/±10%）+ 免责声明 + 历史
const toolsStore = useToolsStore()

const DISCLAIMER = '✦ 估算结果基于统计学回归公式，受超声切面与胎儿体位影响存在 ±10%~15% 误差，仅供参考，不可替代产科超声医生的临床诊断！'

const form = reactive({ week: '', hc: '', ac: '', fl: '', bpd: '', unit: 'cm' })
const saving = ref(false)

const unitPlaceholder = computed(() => (form.unit === 'mm' ? `如 320（${form.unit}）` : `如 32.0（${form.unit}）`))

// 实时计算（本地纯函数镜像——每次输入即时重算；保存时以服务端权威计算落盘）
const result = computed(() => {
	const hc = Number(form.hc), ac = Number(form.ac), fl = Number(form.fl)
	if (form.hc === '' || form.ac === '' || form.fl === '') return null
	if (!Number.isFinite(hc) || !Number.isFinite(ac) || !Number.isFinite(fl)) return { err: '请输入有效数字' }
	return computeHadlockEfw({ hc, ac, fl, unit: form.unit })
})

const canSave = computed(() => Boolean(result.value && !result.value.err) && Number.isInteger(Number(form.week)) && Number(form.week) >= 12 && Number(form.week) <= 42)

function setUnit(u) {
	// 切换单位：已填数值即时换算（32cm ⇄ 320mm）——不静默丢输入
	if (form.unit === u) return
	const factor = u === 'mm' ? 10 : 0.1
	for (const key of ['hc', 'ac', 'fl', 'bpd']) {
		if (form[key] === '') continue
		const v = Number(form[key])
		if (Number.isFinite(v) && v > 0) form[key] = String(Math.round(v * factor * 100) / 100)
	}
	form.unit = u
}

async function onSave() {
	if (!canSave.value || saving.value) return
	saving.value = true
	try {
		const r = await toolsStore.saveEfwRecord({
			gestationalWeek: Number(form.week),
			hc: Number(form.hc), ac: Number(form.ac), fl: Number(form.fl), unit: form.unit,
			...(form.bpd !== '' ? { bpd: Number(form.bpd) } : {})
		})
		if (r.ok) uni.showToast({ title: r.replayed ? '已保存（幂等重放）' : '已保存', icon: 'none' })
		else uni.showToast({ title: r.message || '保存失败，请重试', icon: 'none', duration: 2500 })
	} finally {
		saving.value = false
	}
}

function onDelete(r) {
	uni.showModal({
		title: '删除这条估重记录？',
		content: '删除后不再显示于历史',
		confirmText: '删除',
		cancelText: '取消',
		success: res => {
			if (!res || !res.confirm) return
			toolsStore.deleteEfwRecord(r.recordId).then(res2 => {
				if (res2.ok) uni.showToast({ title: '已删除', icon: 'none' })
				else uni.showToast({ title: res2.message || '删除失败', icon: 'none' })
			})
		}
	})
}

const efwRecords = computed(() => toolsStore.efwRecords)

onShow(() => {
	const s = getSessionState()
	if (s.status === 'confirmed' && s.member) {
		toolsStore.pullEfwRecords().catch(() => {})
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
.unit-row {
	display: flex;
	flex-direction: row;
	margin: 24rpx 32rpx 0;
	padding: 8rpx;
	border-radius: 999rpx;
	background: #ffffff;
	box-shadow: 0 4rpx 20rpx rgba(17, 22, 34, 0.06);
}
.unit-seg {
	flex: 1;
	padding: 14rpx 0;
	border-radius: 999rpx;
	display: flex;
	justify-content: center;
}
.unit-seg.active {
	background: linear-gradient(90deg, #4a7cf7, #6a5cf7);
}
.unit-seg-text {
	font-size: 26rpx;
	color: #46536a;
}
.unit-seg-text.active {
	color: #ffffff;
	font-weight: 600;
}
.form-card {
	margin: 24rpx 32rpx 0;
	padding: 28rpx;
	border-radius: 24rpx;
	background: #ffffff;
	box-shadow: 0 4rpx 20rpx rgba(17, 22, 34, 0.06);
}
.form-row {
	display: flex;
	flex-direction: row;
	align-items: center;
	justify-content: space-between;
	padding: 14rpx 0;
}
.form-label {
	font-size: 26rpx;
	color: #46536a;
	width: 260rpx;
}
.form-input {
	flex: 1;
	padding: 16rpx 20rpx;
	border-radius: 14rpx;
	background: #f7f9fc;
	font-size: 28rpx;
	color: #2a3444;
	text-align: right;
}
.form-placeholder {
	color: #b6bfce;
}
.form-hint {
	display: block;
	margin-top: 12rpx;
	font-size: 22rpx;
	color: #8a94a6;
}
.result-card {
	margin: 24rpx 32rpx 0;
	padding: 44rpx 32rpx;
	border-radius: 24rpx;
	background: linear-gradient(135deg, #4a7cf7, #6a5cf7);
	display: flex;
	flex-direction: column;
	align-items: center;
	box-shadow: 0 10rpx 30rpx rgba(74, 124, 247, 0.3);
}
.result-card.invalid {
	background: #fdeeee;
	box-shadow: none;
}
.result-grams {
	font-size: 72rpx;
	font-weight: 700;
	color: #ffffff;
}
.result-kg {
	margin-top: 8rpx;
	font-size: 30rpx;
	color: rgba(255, 255, 255, 0.9);
}
.result-range {
	margin-top: 14rpx;
	font-size: 24rpx;
	color: rgba(255, 255, 255, 0.85);
}
.result-meta {
	margin-top: 10rpx;
	font-size: 20rpx;
	color: rgba(255, 255, 255, 0.7);
}
.result-invalid {
	font-size: 26rpx;
	color: #d9534f;
}
.result-empty {
	font-size: 26rpx;
	color: #9aa4b5;
}
.save-btn {
	margin: 24rpx 32rpx 0;
	padding: 24rpx 0;
	border-radius: 999rpx;
	background: #4a7cf7;
	display: flex;
	justify-content: center;
}
.save-btn.disabled {
	opacity: 0.45;
}
.save-btn-text {
	font-size: 28rpx;
	font-weight: 600;
	color: #ffffff;
}
.disclaimer-card {
	margin: 24rpx 32rpx 0;
	padding: 24rpx 28rpx;
	border-radius: 20rpx;
	background: #fdf6e8;
	border: 2rpx solid #f0dfb4;
}
.disclaimer-text {
	font-size: 22rpx;
	color: #9a7b2d;
	line-height: 1.7;
}
.history-card {
	margin: 24rpx 32rpx 0;
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
	display: flex;
	flex-direction: row;
	align-items: center;
	justify-content: space-between;
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
.history-meta {
	margin-top: 6rpx;
	font-size: 22rpx;
	color: #8a94a6;
}
.history-del {
	padding: 8rpx 20rpx;
	border-radius: 12rpx;
	background: #fdeeee;
}
.history-del-text {
	font-size: 22rpx;
	color: #d9534f;
}
</style>
