<template>
	<view v-if="visible" class="edit-overlay" @tap="handleMaskTap">
		<view class="edit-sheet" @tap.stop>
			<view class="sheet-handle"></view>
			<text class="sheet-title">{{ exists ? '编辑' : '记录' }}{{ titles[mode] }}</text>

			<!-- 日期选择（≤ 今天；改日期=把这条记录挪到所选日） -->
			<view class="form-group">
				<text class="form-label">日期</text>
				<picker mode="date" :value="dateVal" :end="todayStr" @change="onDateChange">
					<view class="date-row">
						<text class="date-text">{{ dateDisplay }}</text>
						<text class="date-arrow">▾</text>
					</view>
				</picker>
				<text v-if="dateChanged" class="form-hint">保存后将移动到 {{ dateDisplay }}（原日期的这条记录会被清除）</text>
			</view>

			<!-- 体重 -->
			<view v-if="mode === 'weight'" class="form-group">
				<text class="form-label">体重（kg）</text>
				<view class="number-row">
					<view class="num-btn" @tap="adjustWeight(-0.1)"><text class="num-btn-text">－</text></view>
					<input class="num-input" type="digit" v-model="form.value" placeholder="0.0" />
					<text class="num-unit">kg</text>
					<view class="num-btn" @tap="adjustWeight(0.1)"><text class="num-btn-text">＋</text></view>
				</view>
				<text class="form-hint">合理范围 25~300 kg</text>
			</view>

			<!-- 血压 -->
			<view v-if="mode === 'bp'" class="form-group">
				<text class="form-label">血压（mmHg）</text>
				<view class="bp-row">
					<input class="bp-input" type="number" placeholder="收缩压" v-model="form.value" />
					<text class="bp-sep">/</text>
					<input class="bp-input" type="number" placeholder="舒张压" v-model="form.value2" />
				</view>
				<text class="form-hint">收缩压 60~260、舒张压 30~180；正常参考 ≤ 140/90 mmHg</text>
			</view>

			<!-- 胎动 -->
			<view v-if="mode === 'fetal'" class="form-group">
				<text class="form-label">当日胎动次数</text>
				<view class="number-row">
					<view class="num-btn" @tap="adjustFetal(-1)"><text class="num-btn-text">－</text></view>
					<input class="num-input" type="number" v-model="form.value" placeholder="0" />
					<text class="num-unit">次</text>
					<view class="num-btn" @tap="adjustFetal(1)"><text class="num-btn-text">＋</text></view>
				</view>
				<text class="form-hint">修正当日汇总次数（不影响计时历史）；12小时内少于10次请及时就医</text>
			</view>

			<!-- 删除（仅编辑已有记录） -->
			<view v-if="exists" class="remove-btn" @tap="handleRemove">
				<text class="remove-btn-text">删除这条{{ titles[mode] }}</text>
			</view>

			<view class="save-btn" @tap="handleSave">
				<text class="save-btn-text">保存</text>
			</view>
		</view>
	</view>
</template>

<script setup>
// 详情页（体重/血压/胎动记录）共享的按日编辑弹层：
// 新增（任意日期补录）/ 修改（改值）/ 挪日（改日期=新日写入+原日清除，两步由页面编排）/
// 删除（字段级清除——同日其他数据不受影响）。持久化与冲突处理全部走页面侧 saveDaily 通道。
import { ref, reactive, computed, watch } from 'vue'

const props = defineProps({
	visible: { type: Boolean, default: false },
	mode: { type: String, default: 'weight' }, // weight | bp | fetal
	dateKey: { type: String, default: '' },    // 初始日期 YYYY-MM-DD
	initial: { type: Object, default: () => ({}) }, // { value, value2 } 字符串预填
	exists: { type: Boolean, default: false }   // 编辑已有（显示删除）vs 新增补录
})
const emit = defineEmits(['update:visible', 'save', 'remove'])

const titles = { weight: '体重', bp: '血压', fetal: '胎动' }

const dateVal = ref('')
const form = reactive({ value: '', value2: '' })

const todayStr = (() => {
	const d = new Date()
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})()

const dateDisplay = computed(() => {
	if (!dateVal.value) return ''
	const [y, m, d] = dateVal.value.split('-').map(Number)
	return `${y}年${m}月${d}日`
})
const dateChanged = computed(() => Boolean(props.dateKey) && dateVal.value !== props.dateKey)

watch(() => props.visible, (val) => {
	if (val) {
		dateVal.value = props.dateKey || todayStr
		form.value = props.initial && props.initial.value != null ? String(props.initial.value) : ''
		form.value2 = props.initial && props.initial.value2 != null ? String(props.initial.value2) : ''
	}
})

function onDateChange(e) { dateVal.value = e.detail.value }
function adjustWeight(delta) {
	const v = parseFloat(form.value) || 0
	form.value = Math.max(0, v + delta).toFixed(1)
}
function adjustFetal(delta) {
	const v = parseInt(form.value, 10) || 0
	form.value = String(Math.max(0, v + delta))
}
function handleMaskTap() { emit('update:visible', false) }

// 校验口径与云函数 DAILY_FIELDS 值域一致；不合法即拒（不静默截断）
function buildPayload() {
	if (props.mode === 'weight') {
		const v = Number(form.value)
		if (!Number.isFinite(v) || v < 25 || v > 300) return { err: '体重须为 25~300 的数字' }
		return { payload: { weightKg: Math.round(v * 10) / 10 } }
	}
	if (props.mode === 'bp') {
		const s = Number(form.value), d = Number(form.value2)
		if (!Number.isInteger(s) || s < 60 || s > 260) return { err: '收缩压须为 60~260 的整数' }
		if (!Number.isInteger(d) || d < 30 || d > 180) return { err: '舒张压须为 30~180 的整数' }
		return { payload: { systolic: s, diastolic: d } }
	}
	const v = Number(form.value)
	if (!Number.isInteger(v) || v < 0 || v > 200) return { err: '胎动次数须为 0~200 的整数' }
	return { payload: { fetalCount: v } }
}

function handleSave() {
	const { err, payload } = buildPayload()
	if (err) { uni.showToast({ title: err, icon: 'none' }); return }
	if (!/^\d{4}-\d{2}-\d{2}$/.test(dateVal.value)) { uni.showToast({ title: '日期无效', icon: 'none' }); return }
	// 挪日由 originalDateKey 告知页面（新日写入+原日清除两步编排）
	emit('save', { dateKey: dateVal.value, originalDateKey: dateChanged.value ? props.dateKey : null, payload })
}

function handleRemove() {
	// 删除恒针对打开时的条目日期（用户中途改日期选择不影响删除目标）
	uni.showModal({
		title: '删除记录',
		content: `确定删除 ${props.dateKey || ''} 的${titles[props.mode]}记录吗？同一天的其他数据不受影响。`,
		confirmColor: '#D4627A',
		success: res => { if (res.confirm) emit('remove', { dateKey: props.dateKey }) }
	})
}
</script>

<style scoped lang="scss">
.edit-overlay {
	position: fixed;
	top: 0; left: 0; right: 0; bottom: 0;
	background: rgba(28, 26, 23, 0.45);
	z-index: 999;
	display: flex;
	flex-direction: column;
	justify-content: flex-end;
}
.edit-sheet {
	background: #FFFFFF;
	border-radius: 48rpx 48rpx 0 0;
	padding: 0 40rpx;
	padding-bottom: calc(72rpx + env(safe-area-inset-bottom));
	max-height: 75vh;
	overflow-y: auto;
	box-sizing: border-box;
	width: 100%;
}
.sheet-handle {
	width: 72rpx; height: 8rpx;
	background: #E4E1DC;
	border-radius: 4rpx;
	margin: 28rpx auto;
}
.sheet-title {
	display: block;
	font-size: 32rpx;
	font-weight: 600;
	color: #1C1A17;
	margin-bottom: 24rpx;
}
.form-group { margin-bottom: 32rpx; }
.form-label {
	display: block;
	font-size: 20rpx;
	font-weight: 700;
	color: #9C9890;
	text-transform: uppercase;
	letter-spacing: 3rpx;
	margin-bottom: 12rpx;
}
.form-hint {
	display: block;
	font-size: 22rpx;
	color: #9C9890;
	margin-top: 14rpx;
}
.date-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	height: 88rpx;
	background: #F2F0EE;
	border: 4rpx solid #E8DDD0;
	border-radius: 20rpx;
	padding: 0 28rpx;
	box-sizing: border-box;
}
.date-text { font-size: 30rpx; font-weight: 600; color: #1C1A17; }
.date-arrow { font-size: 26rpx; color: #9C9890; }
.number-row { display: flex; align-items: center; gap: 18rpx; }
.num-btn {
	width: 84rpx; height: 84rpx;
	border-radius: 50%;
	background: #F2F0EE;
	display: flex; align-items: center; justify-content: center;
	flex-shrink: 0;
}
.num-btn-text { font-size: 36rpx; color: #4A4844; }
.num-input {
	flex: 1;
	height: 92rpx;
	background: #F2F0EE;
	border: 4rpx solid #E8DDD0;
	border-radius: 20rpx;
	font-size: 40rpx;
	font-weight: 700;
	color: #1C1A17;
	text-align: center;
}
.num-unit { font-size: 26rpx; color: #9C9890; flex-shrink: 0; }
.bp-row { display: flex; align-items: center; gap: 14rpx; }
.bp-input {
	flex: 1;
	height: 88rpx;
	background: #F2F0EE;
	border: 4rpx solid #E8DDD0;
	border-radius: 20rpx;
	font-size: 36rpx;
	font-weight: 700;
	color: #1C1A17;
	text-align: center;
}
.bp-sep { font-size: 36rpx; font-weight: 700; color: #9C9890; }
.remove-btn {
	width: 100%;
	height: 88rpx;
	border-radius: 999rpx;
	border: 3rpx solid #E8B8C2;
	background: #FDF3F3;
	display: flex; align-items: center; justify-content: center;
	margin-top: 8rpx;
	box-sizing: border-box;
}
.remove-btn:active { background: #FAEAEE; }
.remove-btn-text { font-size: 28rpx; font-weight: 600; color: #B04560; }
.save-btn {
	width: 100%;
	height: 96rpx;
	background: linear-gradient(135deg, #D4627A, #B04560);
	border-radius: 999rpx;
	display: flex; align-items: center; justify-content: center;
	margin-top: 16rpx;
	box-shadow: 0 8rpx 32rpx rgba(212, 98, 122, 0.3);
	box-sizing: border-box;
}
.save-btn:active { opacity: 0.9; }
.save-btn-text { font-size: 30rpx; font-weight: 600; color: #FFFFFF; }
</style>
