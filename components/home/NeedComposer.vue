<template>
	<view v-if="visible" class="composer-mask" @tap="onMaskTap">
		<view class="composer" @tap.stop>
			<text class="composer-title">分享我的需要</text>
			<text class="composer-hint">对方可见</text>

			<!-- 快捷短句 -->
			<view class="quick-row">
				<view v-for="q in QUICK_PHRASES" :key="q" class="quick-chip" @tap="useQuick(q)">
					<text class="quick-chip-text">{{ q }}</text>
				</view>
			</view>

			<!-- 正文（1~200 字 + 实时字数） -->
			<textarea
				class="composer-input"
				v-model="content"
				:maxlength="200"
				placeholder="想对对方说…"
				placeholder-class="composer-placeholder"
			/>
			<text class="composer-counter" :class="{ over: contentLength > 200 }">{{ contentLength }}/200</text>

			<!-- 可选约定日期 -->
			<picker mode="date" :value="targetDate" @change="onDateChange">
				<view class="date-row">
					<text class="date-label">约定日期</text>
					<text class="date-value" :class="{ placeholder: !targetDate }">{{ targetDate || '可选（不填则不限）' }}</text>
				</view>
			</picker>
			<view v-if="targetDate" class="date-clear" @tap="targetDate = ''">
				<text class="date-clear-text">清除日期</text>
			</view>

			<view class="composer-submit" :class="{ disabled: !canSubmit || submitting }" @tap="onSubmit">
				<text class="composer-submit-text">{{ submitting ? '分享中…' : '分享给对方' }}</text>
			</view>
		</view>
	</view>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useCollabStore } from '@/services/collabStore.js'

// 发起分享弹层：快捷短句/200 字限制/可选约定日期/明确"对方可见"
const props = defineProps({
	visible: { type: Boolean, default: false }
})
const emit = defineEmits(['update:visible', 'saved'])

const QUICK_PHRASES = ['想休息一下', '希望帮忙带饭', '想一起准备产检']

const collabStore = useCollabStore()
const content = ref('')
const targetDate = ref('')
const submitting = ref(false)

const contentLength = computed(() => Array.from(content.value || '').length)
const canSubmit = computed(() => content.value.trim() !== '' && contentLength.value >= 1 && contentLength.value <= 200)

function useQuick(q) {
	content.value = q
}

function onDateChange(e) {
	targetDate.value = (e && e.detail && e.detail.value) || ''
}

function onMaskTap() {
	// 蒙层关闭不丢输入：仅经取消路径（保持草稿在内存——下次打开仍在）
	emit('update:visible', false)
}

async function onSubmit() {
	if (!canSubmit.value || submitting.value) return
	submitting.value = true
	try {
		const r = await collabStore.saveNeed({
			content: content.value,
			...(targetDate.value ? { targetDate: targetDate.value } : {})
		})
		if (r.ok) {
			content.value = ''
			targetDate.value = ''
			emit('saved')
			emit('update:visible', false)
			uni.showToast({ title: r.replayed ? '已分享（幂等重放）' : '已分享', icon: 'none' })
		} else if (r.code === 'outbox-persist-failed') {
			uni.showToast({ title: r.message || '本机保存失败，请重试', icon: 'none', duration: 2500 })
		} else {
			// 网络失败：已入离线待办——如实提示"已暂存"，不显示"已保存"
			uni.showToast({ title: '已暂存，联网后同步', icon: 'none', duration: 2500 })
			emit('update:visible', false)
		}
	} finally {
		submitting.value = false
	}
}
</script>

<style>
.composer-mask {
	position: fixed;
	left: 0;
	top: 0;
	right: 0;
	bottom: 0;
	background: rgba(12, 18, 28, 0.5);
	display: flex;
	align-items: flex-end;
	z-index: 999;
}
.composer {
	width: 100%;
	background: #ffffff;
	border-radius: 32rpx 32rpx 0 0;
	padding: 36rpx 32rpx calc(36rpx + env(safe-area-inset-bottom));
	display: flex;
	flex-direction: column;
}
.composer-title {
	font-size: 34rpx;
	font-weight: 600;
	color: #11222e;
}
.composer-hint {
	margin-top: 8rpx;
	font-size: 24rpx;
	color: #d9534f;
}
.quick-row {
	display: flex;
	flex-direction: row;
	flex-wrap: wrap;
	gap: 16rpx;
	margin-top: 24rpx;
}
.quick-chip {
	padding: 12rpx 28rpx;
	border-radius: 999rpx;
	background: #f2f5fa;
}
.quick-chip-text {
	font-size: 26rpx;
	color: #46536a;
}
.composer-input {
	margin-top: 24rpx;
	width: 100%;
	min-height: 160rpx;
	padding: 20rpx;
	box-sizing: border-box;
	border-radius: 16rpx;
	background: #f7f9fc;
	font-size: 28rpx;
	color: #2a3444;
}
.composer-placeholder {
	color: #b6bfce;
}
.composer-counter {
	align-self: flex-end;
	margin-top: 8rpx;
	font-size: 22rpx;
	color: #8a94a6;
}
.composer-counter.over {
	color: #d9534f;
}
.date-row {
	margin-top: 20rpx;
	display: flex;
	flex-direction: row;
	align-items: center;
	justify-content: space-between;
	padding: 20rpx;
	border-radius: 16rpx;
	background: #f7f9fc;
}
.date-label {
	font-size: 26rpx;
	color: #46536a;
}
.date-value {
	font-size: 26rpx;
	color: #2a3444;
}
.date-value.placeholder {
	color: #b6bfce;
}
.date-clear {
	margin-top: 8rpx;
	align-self: flex-end;
}
.date-clear-text {
	font-size: 22rpx;
	color: #8a94a6;
}
.composer-submit {
	margin-top: 28rpx;
	height: 92rpx;
	border-radius: 999rpx;
	background: linear-gradient(90deg, #4a7cf7, #6a5cf6);
	display: flex;
	align-items: center;
	justify-content: center;
}
.composer-submit.disabled {
	opacity: 0.45;
}
.composer-submit-text {
	font-size: 30rpx;
	font-weight: 600;
	color: #ffffff;
}
</style>
