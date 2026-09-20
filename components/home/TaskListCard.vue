<template>
	<view class="section-card-style task-card">
		<view class="task-card-head">
			<text class="task-card-title">{{ title }}</text>
			<text v-if="tasks.length === 0" class="task-card-empty">暂无进行中的任务</text>
		</view>

		<view v-for="t in tasks" :key="t.taskId" class="task-row">
			<!-- 勾选框：done ⇄ doing/pending 直接切换（撤销完成） -->
			<view
				class="task-check"
				:class="{ checked: t.status === 'done', disabled: t.status === 'cancelled' || toggling === t.taskId }"
				@tap="onToggle(t)"
			>
				<text v-if="t.status === 'done'" class="task-check-mark">✓</text>
			</view>
			<view class="task-main">
				<text class="task-title" :class="{ done: t.status === 'done', cancelled: t.status === 'cancelled' }">
					{{ t.title || '（分享已撤回）' }}
				</text>
				<view class="task-meta-row">
					<text v-if="t.targetDate" class="task-meta">约定 {{ t.targetDate }}</text>
					<text v-if="assigneeLabel(t)" class="task-meta">{{ assigneeLabel(t) }}</text>
					<text v-if="t.status === 'cancelled'" class="task-meta task-meta-muted">已取消</text>
				</view>
			</view>
		</view>

		<view class="task-footer" @tap="goAllTasks">
			<text class="task-footer-text">查看全部任务</text>
		</view>
	</view>
</template>

<script setup>
import { ref } from 'vue'
import { useCollabStore } from '@/services/collabStore.js'

// 首页任务卡：直接勾选完成/撤销完成（经 collabStore.updateTaskStatus → outbox）
const props = defineProps({
	tasks: { type: Array, default: () => [] },
	title: { type: String, default: '共同准备' }
})

const collabStore = useCollabStore()
const toggling = ref('')

function assigneeLabel(t) {
	if (t.acceptedBy) return t.acceptedBy === 'mama' ? '妈妈接下' : '爸爸接下'
	if (t.assigneeId) return t.assigneeId === 'mama' ? '指派：妈妈' : '指派：爸爸'
	return '未分配'
}

async function onToggle(task) {
	if (!task || task.status === 'cancelled' || toggling.value === task.taskId) return
	const next = task.status === 'done' ? 'doing' : 'done' // 撤销完成 ⇄ 完成
	toggling.value = task.taskId
	try {
		const r = await collabStore.updateTaskStatus(task.taskId, next, task.revision)
		if (r.ok) {
			uni.showToast({ title: next === 'done' ? '已完成' : '已撤销完成', icon: 'none' })
		} else if (r.code === 'revision-conflict') {
			uni.showToast({ title: '任务已被对方更新，请刷新', icon: 'none' })
		} else if (r.code !== 'outbox-persist-failed') {
			uni.showToast({ title: '已暂存，联网后同步', icon: 'none' })
		} else {
			uni.showToast({ title: r.message || '操作失败，请重试', icon: 'none' })
		}
	} finally {
		toggling.value = ''
	}
}

function goAllTasks() {
	uni.navigateTo({ url: '/pages/tasks/index' })
}
</script>

<style>
.task-card {
	padding: 28rpx;
	margin: 0 24rpx 24rpx;
	border-radius: 24rpx;
	background: #ffffff;
	box-shadow: 0 4rpx 20rpx rgba(17, 22, 34, 0.06);
}
.task-card-head {
	display: flex;
	flex-direction: row;
	align-items: center;
	justify-content: space-between;
	margin-bottom: 8rpx;
}
.task-card-title {
	font-size: 30rpx;
	font-weight: 600;
	color: #11222e;
}
.task-card-empty {
	font-size: 24rpx;
	color: #9aa4b5;
}
.task-row {
	display: flex;
	flex-direction: row;
	align-items: flex-start;
	padding: 20rpx 0;
	border-bottom: 1rpx solid #f0f3f8;
}
.task-check {
	width: 44rpx;
	height: 44rpx;
	border-radius: 12rpx;
	border: 3rpx solid #c6cedd;
	margin-right: 20rpx;
	margin-top: 4rpx;
	display: flex;
	align-items: center;
	justify-content: center;
}
.task-check.checked {
	background: #4a7cf7;
	border-color: #4a7cf7;
}
.task-check.disabled {
	opacity: 0.4;
}
.task-check-mark {
	color: #ffffff;
	font-size: 26rpx;
	font-weight: 700;
}
.task-main {
	flex: 1;
	display: flex;
	flex-direction: column;
}
.task-title {
	font-size: 28rpx;
	color: #2a3444;
	line-height: 1.5;
}
.task-title.done {
	color: #9aa4b5;
	text-decoration: line-through;
}
.task-title.cancelled {
	color: #b6bfce;
}
.task-meta-row {
	display: flex;
	flex-direction: row;
	gap: 20rpx;
	margin-top: 6rpx;
}
.task-meta {
	font-size: 22rpx;
	color: #8a94a6;
}
.task-meta-muted {
	color: #b6bfce;
}
.task-footer {
	margin-top: 16rpx;
	display: flex;
	justify-content: center;
	padding: 12rpx 0;
}
.task-footer-text {
	font-size: 26rpx;
	color: #4a7cf7;
}
</style>
