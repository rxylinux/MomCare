<template>
	<view v-if="visible" class="edit-overlay" @tap="handleMaskTap">
		<view class="edit-sheet" @tap.stop>
			<!-- 拖拽指示条 -->
			<view class="sheet-handle"></view>
			<!-- 标题 -->
			<text class="sheet-title">{{ title }}</text>
			<text class="sheet-date">{{ dateLabel }}</text>

			<!-- 体重编辑 -->
			<view v-if="mode === 'weight'" class="form-group">
				<text class="form-label">今日体重</text>
				<view class="number-row">
					<view class="num-btn" @tap="adjust('weight', -0.1)">
						<text class="num-btn-text">－</text>
					</view>
					<input class="num-input" type="digit" v-model="formData.weight" />
					<text class="num-unit">kg</text>
					<view class="num-btn" @tap="adjust('weight', 0.1)">
						<text class="num-btn-text">＋</text>
					</view>
				</view>
			</view>

			<!-- 血压编辑 -->
			<view v-if="mode === 'bp'" class="form-group">
				<text class="form-label">血压（mmHg）</text>
				<view class="bp-row">
					<input class="bp-input" type="number" placeholder="收缩压" v-model="formData.systolic" />
					<text class="bp-sep">/</text>
					<input class="bp-input" type="number" placeholder="舒张压" v-model="formData.diastolic" />
					<text class="bp-unit">mmHg</text>
				</view>
				<text class="form-hint">正常参考：≤ 140/90 mmHg</text>
			</view>

			<!-- 心情 & 症状 -->
			<view v-if="mode === 'daily'" class="form-group">
				<text class="form-label">今日心情</text>
				<view class="mood-row">
					<view v-for="m in moods" :key="m" class="mood-btn" :class="{ 'mood-active': formData.mood === m }" @tap="formData.mood = m">
						<text class="mood-emoji">{{ m }}</text>
					</view>
				</view>
				<text class="form-label" style="margin-top: 32rpx">今日症状（可多选）</text>
				<view class="symptom-wrap">
					<view v-for="s in symptoms" :key="s" class="symptom-chip" :class="{ 'symptom-active': formData.symptoms.includes(s) }" @tap="toggleSymptom(s)">
						<text class="symptom-text">{{ s }}</text>
					</view>
				</view>
			</view>

			<!-- 胎动 -->
			<view v-if="mode === 'fetal'" class="form-group">
				<text class="form-label">今日胎动次数</text>
				<view class="number-row">
					<view class="num-btn" @tap="adjust('fetal', -1)">
						<text class="num-btn-text">－</text>
					</view>
					<input class="num-input" type="number" v-model="formData.fetal" />
					<text class="num-unit">次</text>
					<view class="num-btn" @tap="adjust('fetal', 1)">
						<text class="num-btn-text">＋</text>
					</view>
				</view>
				<text class="form-hint">12小时内少于10次请及时就医</text>
			</view>

			<!-- 备注 & 计划 -->
			<view v-if="mode === 'note'" class="form-group">
				<text class="form-label">备注</text>
				<textarea class="note-textarea" v-model="formData.note" placeholder="记录感受、提醒或想法…" :maxlength="500" />
				<text class="form-label" style="margin-top: 32rpx">今日计划</text>
				<view class="plan-list">
					<view v-for="(p, idx) in formData.plans" :key="idx" class="plan-item-edit">
						<view class="plan-check" @tap="togglePlan(idx)">
							<text v-if="p.done" class="check-mark">✓</text>
						</view>
						<text class="plan-text" :class="{ 'plan-text-done': p.done }">{{ p.text }}</text>
						<view class="plan-delete" @tap="deletePlan(idx)">
							<text class="plan-delete-icon">×</text>
						</view>
					</view>
				</view>
				<!-- 添加计划 -->
				<view class="add-plan-row" v-if="showAddPlan">
					<input class="add-plan-input" v-model="newPlanText" placeholder="输入计划内容…" :focus="true" @confirm="addPlan" @blur="cancelAddPlan" />
					<view class="add-plan-btn" @tap="addPlan">
						<text class="add-plan-btn-text">添加</text>
					</view>
				</view>
				<view v-else class="add-plan-trigger" @tap="showAddPlan = true">
					<text class="add-plan-icon">+</text>
					<text class="add-plan-text">添加计划</text>
				</view>
			</view>

			<!-- 保存按钮 -->
			<view class="save-btn" @tap="handleSave">
				<text class="save-btn-text">保存记录</text>
			</view>
		</view>
	</view>
</template>

<script setup>
import { ref, watch, computed } from 'vue'
import { calcWeekInfo } from '@/stores/health.js'

const props = defineProps({
	visible: { type: Boolean, default: false },
	mode: { type: String, default: 'weight' },
	record: { type: Object, default: () => ({}) },
	selectedDate: { type: [Date, Object], default: null },
	lmpDate: { type: Date, required: true }
})

const emit = defineEmits(['update:visible', 'save'])

const moods = ['😄', '🙂', '😐', '😔', '😭']
const symptoms = ['腰背酸痛', '水肿', '气短', '失眠', '孕吐', '腿抽筋', '头痛', '胃部不适', '无不适']

const formData = ref({
	weight: '',
	systolic: '',
	diastolic: '',
	mood: '',
	symptoms: [],
	fetal: '',
	note: '',
	plans: []
})

const showAddPlan = ref(false)
const newPlanText = ref('')

const titles = {
	weight: '记录体重',
	bp: '记录血压',
	daily: '心情 & 症状',
	fetal: '记录胎动',
	note: '备注 & 计划'
}

const title = computed(() => titles[props.mode] || '')

const dateLabel = computed(() => {
	if (!props.selectedDate) return ''
	const d = props.selectedDate
	const m = d.getMonth() + 1
	const day = d.getDate()
	const wi = calcWeekInfo(props.lmpDate, d)
	let label = `${d.getFullYear()}年${m}月${day}日`
	if (wi) label += ` · 孕 ${wi.week} 周 ${wi.day} 天`
	return label
})

watch(() => props.visible, (val) => {
	if (val && props.record) {
		const r = props.record
		formData.value = {
			weight: r.weight || '',
			systolic: (r.bp || '').split('/')[0] || '',
			diastolic: (r.bp || '').split('/')[1] || '',
			mood: r.mood || '',
			symptoms: r.symptoms ? [...r.symptoms] : [],
			fetal: r.fetal || '0',
			note: r.note || '',
			plans: r.plans && r.plans.length ? r.plans.map(p => ({ ...p })) : []
		}
		showAddPlan.value = false
		newPlanText.value = ''
	}
})

function adjust(field, delta) {
	const val = parseFloat(formData.value[field]) || 0
	formData.value[field] = (val + delta).toFixed(field === 'weight' ? 1 : 0)
}

function toggleSymptom(s) {
	const idx = formData.value.symptoms.indexOf(s)
	if (idx >= 0) {
		formData.value.symptoms.splice(idx, 1)
	} else {
		formData.value.symptoms.push(s)
	}
}

function togglePlan(idx) {
	formData.value.plans[idx].done = !formData.value.plans[idx].done
}

function deletePlan(idx) {
	formData.value.plans.splice(idx, 1)
}

function addPlan() {
	const text = newPlanText.value.trim()
	if (text) {
		formData.value.plans.push({ text, done: false })
		newPlanText.value = ''
		showAddPlan.value = false
	}
}

function cancelAddPlan() {
	if (!newPlanText.value.trim()) {
		showAddPlan.value = false
	}
}

function handleMaskTap() {
	emit('update:visible', false)
}

function handleSave() {
	const result = {}
	switch (props.mode) {
		case 'weight':
			result.weight = formData.value.weight
			break
		case 'bp':
			if (formData.value.systolic && formData.value.diastolic) {
				result.bp = `${formData.value.systolic}/${formData.value.diastolic}`
			}
			break
		case 'daily':
			result.mood = formData.value.mood
			result.symptoms = formData.value.symptoms
			break
		case 'fetal':
			result.fetal = formData.value.fetal
			break
		case 'note':
			result.note = formData.value.note
			result.plans = formData.value.plans
			break
	}
	// 只上报保存内容；是否关闭弹层由父页面根据持久化结果决定（失败保留输入）
	emit('save', result)
}
</script>

<style scoped lang="scss">
.edit-overlay {
	position: fixed;
	top: 0;
	left: 0;
	right: 0;
	bottom: 0;
	background: rgba(28, 26, 23, 0.45);
	z-index: 999;
	display: flex;
	flex-direction: column;
	justify-content: flex-end;
}

.edit-sheet {
	background: #FFFFFF;
	border-radius: 48rpx 48rpx 0 0;
	padding: 0 40rpx 72rpx;
	max-height: 75vh;
	overflow-y: auto;
	box-sizing: border-box;
	width: 100%;
}

.sheet-handle {
	width: 72rpx;
	height: 8rpx;
	background: #E4E1DC;
	border-radius: 4rpx;
	margin: 28rpx auto;
}

.sheet-title {
	display: block;
	font-size: 32rpx;
	font-weight: 600;
	color: #1C1A17;
	margin-bottom: 4rpx;
}

.sheet-date {
	display: block;
	font-size: 22rpx;
	color: #9C9890;
	margin-bottom: 32rpx;
}

.form-group {
	margin-bottom: 32rpx;
}

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

.number-row {
	display: flex;
	align-items: center;
	gap: 18rpx;
}

.num-btn {
	width: 84rpx;
	height: 84rpx;
	border-radius: 50%;
	background: #F2F0EE;
	display: flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
}

.num-btn-text {
	font-size: 36rpx;
	color: #4A4844;
}

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

.num-unit {
	font-size: 26rpx;
	color: #9C9890;
	flex-shrink: 0;
}

.bp-row {
	display: flex;
	align-items: center;
	gap: 14rpx;
}

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

.bp-sep {
	font-size: 36rpx;
	font-weight: 700;
	color: #9C9890;
}

.bp-unit {
	font-size: 22rpx;
	color: #9C9890;
}

.mood-row {
	display: flex;
	gap: 14rpx;
}

.mood-btn {
	flex: 1;
	height: 88rpx;
	border-radius: 20rpx;
	border: 4rpx solid #E8DDD0;
	background: #F2F0EE;
	display: flex;
	align-items: center;
	justify-content: center;
	box-sizing: border-box;
}

.mood-active {
	border-color: #D4627A;
	background: #FAEAEE;
}

.mood-emoji {
	font-size: 40rpx;
}

.symptom-wrap {
	display: flex;
	flex-wrap: wrap;
	gap: 12rpx;
}

.symptom-chip {
	padding: 10rpx 20rpx;
	border-radius: 999rpx;
	border: 3rpx solid #E8DDD0;
	background: #F2F0EE;
}

.symptom-active {
	background: #FAEAEE;
	border-color: #E8A0B0;
}

.symptom-active .symptom-text {
	color: #B04560;
}

.symptom-text {
	font-size: 22rpx;
	color: #4A4844;
}

.note-textarea {
	width: 100%;
	min-height: 152rpx;
	background: #F2F0EE;
	border: 4rpx solid #E8DDD0;
	border-radius: 20rpx;
	padding: 22rpx;
	font-size: 26rpx;
	color: #1C1A17;
	line-height: 1.7;
	box-sizing: border-box;
}

.plan-list {
	display: flex;
	flex-direction: column;
	gap: 14rpx;
	margin-bottom: 16rpx;
}

.plan-item-edit {
	display: flex;
	align-items: center;
	gap: 18rpx;
	background: #F2F0EE;
	border-radius: 16rpx;
	padding: 14rpx 18rpx;
}

.plan-item {
	display: flex;
	align-items: center;
	gap: 18rpx;
}

.plan-check {
	width: 38rpx;
	height: 38rpx;
	border-radius: 10rpx;
	border: 4rpx solid #E8DDD0;
	background: #F2F0EE;
	display: flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
}

.plan-done .plan-check {
	background: #D4627A;
	border-color: #D4627A;
}

.check-mark {
	font-size: 22rpx;
	color: #FFFFFF;
}

.plan-text {
	font-size: 26rpx;
	color: #4A4844;
}

.plan-text-done {
	text-decoration: line-through;
	color: #9C9890;
}

.plan-delete {
	width: 36rpx;
	height: 36rpx;
	border-radius: 50%;
	background: #E8DDD0;
	display: flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
	margin-left: auto;
}

.plan-delete:active {
	background: #D4627A;
}

.plan-delete:active .plan-delete-icon {
	color: #FFFFFF;
}

.plan-delete-icon {
	font-size: 28rpx;
	color: #9C9890;
	line-height: 1;
	font-weight: 300;
}

.add-plan-row {
	display: flex;
	align-items: center;
	gap: 12rpx;
	margin-top: 12rpx;
}

.add-plan-input {
	flex: 1;
	height: 72rpx;
	background: #F2F0EE;
	border: 3rpx solid #E8DDD0;
	border-radius: 16rpx;
	padding: 0 20rpx;
	font-size: 26rpx;
	color: #1C1A17;
	box-sizing: border-box;
}

.add-plan-btn {
	height: 72rpx;
	padding: 0 28rpx;
	background: #D4627A;
	border-radius: 16rpx;
	display: flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
}

.add-plan-btn:active {
	opacity: 0.8;
}

.add-plan-btn-text {
	font-size: 24rpx;
	font-weight: 600;
	color: #FFFFFF;
}

.add-plan-trigger {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 10rpx;
	height: 72rpx;
	background: #F2F0EE;
	border: 3rpx dashed #E8DDD0;
	border-radius: 16rpx;
	margin-top: 12rpx;
	box-sizing: border-box;
}

.add-plan-trigger:active {
	background: #E8DDD0;
}

.add-plan-icon {
	font-size: 32rpx;
	color: #D4627A;
	font-weight: 300;
	line-height: 1;
}

.add-plan-text {
	font-size: 24rpx;
	color: #D4627A;
	font-weight: 600;
}

.save-btn {
	width: 100%;
	height: 96rpx;
	background: linear-gradient(135deg, #D4627A, #B04560);
	border-radius: 999rpx;
	display: flex;
	align-items: center;
	justify-content: center;
	margin-top: 16rpx;
	box-shadow: 0 8rpx 32rpx rgba(212, 98, 122, 0.3);
	box-sizing: border-box;
}

.save-btn-text {
	font-size: 30rpx;
	font-weight: 600;
	color: #FFFFFF;
}
</style>
