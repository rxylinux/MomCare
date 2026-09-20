<template>
	<view class="section-card-style share-card">
		<view class="share-head">
			<text class="share-title">{{ isMine ? '我分享的状态' : '对方分享的状态' }}</text>
			<text class="share-visibility">对方可见</text>
		</view>

		<!-- 空状态：如实文案（禁止编造"她今天状态很好"） -->
		<view v-if="!share" class="share-empty">
			<text class="share-empty-text">{{ emptyText }}</text>
		</view>

		<template v-else>
			<text class="share-content">{{ share.content }}</text>
			<view class="share-meta-row">
				<text class="share-meta">{{ authorLabel }} · {{ dateLabel }}</text>
				<text v-if="share.targetDate" class="share-target">约定 {{ share.targetDate }}</text>
			</view>

			<!-- 作者操作：结束 / 撤回（二次确认） -->
			<view v-if="isMine" class="share-actions">
				<view class="share-btn" @tap="onClose"><text class="share-btn-text">结束</text></view>
				<view class="share-btn share-btn-danger" @tap="onWithdrawTap"><text class="share-btn-text share-btn-text-danger">撤回</text></view>
			</view>

			<!-- 对方操作：接下这件事（醒目）/ 已接下+查看任务 -->
			<template v-else>
				<view v-if="!linkedTask" class="accept-btn" @tap="onAccept">
					<text class="accept-btn-text">接下这件事</text>
				</view>
				<view v-else class="accepted-row">
					<text class="accepted-label">{{ acceptedLabel }}</text>
					<view class="share-btn" @tap="goTasks"><text class="share-btn-text">查看任务</text></view>
				</view>
			</template>
		</template>
	</view>
</template>

<script setup>
import { computed } from 'vue'
import { useCollabStore } from '@/services/collabStore.js'

// 视图自适应：默认按当前视角取本人（妈妈视角）/对方（爸爸视角）最新 active 分享；
// 也可经 need prop 显式指定渲染对象
const props = defineProps({
	need: { type: Object, default: null }
})

const collabStore = useCollabStore()

// 契约文案常量（DESIGN §4.3——测试断言位）
const emptyText = '今天还没有新的分享'
const WITHDRAW_CONFIRM_CONTENT = '联网同步后会从对方页面移除，已经看过或导出的内容无法收回'

const share = computed(() => {
	if (props.need) return props.need.status === 'active' ? props.need : null
	return collabStore.homeView === 'mom' ? collabStore.myActiveShare : collabStore.partnerActiveShare
})
const isMine = computed(() => Boolean(share.value && collabStore.currentMemberId && share.value.ownerId === collabStore.currentMemberId))
const linkedTask = computed(() => (share.value ? collabStore.taskForNeed(share.value.needId) : null))

const authorLabel = computed(() => (isMine.value ? '我' : (share.value && share.value.ownerId === 'mama' ? '妈妈' : '爸爸')))
const dateLabel = computed(() => {
	const ts = (share.value && (share.value.createdAt || share.value.updatedAt)) || 0
	if (!ts) return ''
	const d = new Date(ts)
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})
const acceptedLabel = computed(() => {
	const t = linkedTask.value
	if (!t) return ''
	if (t.status === 'done') return `已完成 · ${(t.completedBy === 'mama' ? '妈妈' : '爸爸')}`
	return t.status === 'cancelled' ? '已取消' : '已接下 · 进行中'
})

// 撤回：二次确认——如实告知边界（联网后从对方页面移除；已看过/导出的无法收回）
function onWithdrawTap() {
	if (!share.value) return
	uni.showModal({
		title: '撤回这条分享？',
		content: WITHDRAW_CONFIRM_CONTENT,
		confirmText: '撤回',
		cancelText: '再想想',
		success: res => {
			if (!res || !res.confirm) return
			collabStore.withdrawNeed(share.value.needId, share.value.revision).then(r => {
				if (r.ok) uni.showToast({ title: '已撤回', icon: 'none' })
				else if (r.code === 'revision-conflict') uni.showToast({ title: '已被更新，刷新后重试', icon: 'none' })
				else if (r.code !== 'outbox-persist-failed') uni.showToast({ title: '已暂存，联网后同步', icon: 'none' })
				else uni.showToast({ title: r.message || '撤回失败，请重试', icon: 'none' })
			})
		}
	})
}

function onClose() {
	if (!share.value) return
	collabStore.closeNeed(share.value.needId, share.value.revision).then(r => {
		if (r.ok) uni.showToast({ title: '已结束', icon: 'none' })
		else if (r.code !== 'outbox-persist-failed') uni.showToast({ title: '已暂存，联网后同步', icon: 'none' })
		else uni.showToast({ title: r.message || '操作失败，请重试', icon: 'none' })
	})
}

function onAccept() {
	if (!share.value) return
	collabStore.acceptTask('need', share.value.needId).then(r => {
		if (r.ok) uni.showToast({ title: '已接下', icon: 'none' })
		else if (r.code === 'need-withdrawn') uni.showToast({ title: '对方已撤回这条分享', icon: 'none' })
		else if (r.code !== 'outbox-persist-failed') uni.showToast({ title: '已暂存，联网后同步', icon: 'none' })
		else uni.showToast({ title: r.message || '接单失败，请重试', icon: 'none' })
	})
}

function goTasks() {
	uni.navigateTo({ url: '/pages/tasks/index' })
}
</script>

<style>
.share-card {
	padding: 28rpx;
	margin: 0 24rpx 24rpx;
	border-radius: 24rpx;
	background: #ffffff;
	box-shadow: 0 4rpx 20rpx rgba(17, 22, 34, 0.06);
}
.share-head {
	display: flex;
	flex-direction: row;
	align-items: center;
	justify-content: space-between;
	margin-bottom: 16rpx;
}
.share-title {
	font-size: 30rpx;
	font-weight: 600;
	color: #11222e;
}
.share-visibility {
	font-size: 22rpx;
	color: #8a94a6;
}
.share-empty {
	padding: 32rpx 0;
	display: flex;
	justify-content: center;
}
.share-empty-text {
	font-size: 26rpx;
	color: #9aa4b5;
}
.share-content {
	font-size: 30rpx;
	color: #2a3444;
	line-height: 1.6;
}
.share-meta-row {
	display: flex;
	flex-direction: row;
	justify-content: space-between;
	align-items: center;
	margin-top: 12rpx;
}
.share-meta {
	font-size: 22rpx;
	color: #8a94a6;
}
.share-target {
	font-size: 22rpx;
	color: #4a7cf7;
}
.share-actions {
	display: flex;
	flex-direction: row;
	justify-content: flex-end;
	gap: 16rpx;
	margin-top: 20rpx;
}
.share-btn {
	padding: 12rpx 32rpx;
	border-radius: 999rpx;
	background: #f2f5fa;
}
.share-btn-text {
	font-size: 26rpx;
	color: #46536a;
}
.share-btn-danger {
	background: #fdeeee;
}
.share-btn-text-danger {
	color: #d9534f;
}
.accept-btn {
	margin-top: 24rpx;
	height: 92rpx;
	border-radius: 999rpx;
	background: linear-gradient(90deg, #4a7cf7, #6a5cf6);
	display: flex;
	align-items: center;
	justify-content: center;
	box-shadow: 0 8rpx 24rpx rgba(74, 124, 247, 0.35);
}
.accept-btn-text {
	font-size: 30rpx;
	font-weight: 600;
	color: #ffffff;
}
.accepted-row {
	display: flex;
	flex-direction: row;
	align-items: center;
	justify-content: space-between;
	margin-top: 20rpx;
}
.accepted-label {
	font-size: 26rpx;
	color: #2a3444;
}
</style>
