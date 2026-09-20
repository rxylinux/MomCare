<template>
	<view class="page">
		<view class="tabs">
			<view
				v-for="tab in TABS"
				:key="tab.key"
				class="tab"
				:class="{ active: activeTab === tab.key }"
				@tap="activeTab = tab.key"
			>
				<text class="tab-text" :class="{ active: activeTab === tab.key }">{{ tab.label }}</text>
			</view>
		</view>

		<scroll-view scroll-y class="task-scroll">
			<view v-if="filteredTasks.length === 0" class="empty-state">
				<text class="empty-text">暂无相关任务</text>
			</view>

			<view v-for="t in filteredTasks" :key="t.taskId" class="task-item">
				<view class="task-item-check" :class="{ checked: t.status === 'done', disabled: t.status === 'cancelled' }" @tap="onToggleDone(t)">
					<text v-if="t.status === 'done'" class="task-item-check-mark">✓</text>
				</view>
				<view class="task-item-main">
					<text class="task-item-title" :class="{ done: t.status === 'done', cancelled: t.status === 'cancelled' }">{{ displayTitle(t) }}</text>
					<view class="task-item-meta">
						<text class="meta-text">{{ sourceLabel(t) }}</text>
						<text v-if="t.targetDate" class="meta-text">约定 {{ t.targetDate }}</text>
						<text class="meta-text">{{ assigneeLabel(t) }}</text>
						<text class="meta-text">{{ statusLabel(t) }}</text>
					</view>
					<view class="task-item-actions">
						<view v-if="canAccept(t)" class="act-btn act-primary" @tap="onAccept(t)"><text class="act-btn-text act-primary-text">接下这件事</text></view>
						<view v-if="t.status === 'pending'" class="act-btn" @tap="onStart(t)"><text class="act-btn-text">开始</text></view>
						<view v-if="t.status === 'doing'" class="act-btn" @tap="onDone(t)"><text class="act-btn-text">完成</text></view>
						<view v-if="t.status === 'done'" class="act-btn" @tap="onUndo(t)"><text class="act-btn-text">撤销完成</text></view>
						<view v-if="t.status === 'pending' || t.status === 'doing'" class="act-btn act-danger" @tap="onCancel(t)"><text class="act-btn-text act-danger-text">取消</text></view>
					</view>
				</view>
			</view>

			<view class="bottom-spacer"></view>
		</scroll-view>

		<!-- 新建自定义任务 -->
		<view class="fab" @tap="createVisible = true"><text class="fab-text">＋ 新建任务</text></view>
		<view v-if="createVisible" class="create-mask" @tap="createVisible = false">
			<view class="create-sheet" @tap.stop>
				<text class="create-title">新建任务</text>
				<input v-model="createForm.title" class="create-input" placeholder="任务标题（必填，≤100 字）" placeholder-class="create-placeholder" />
				<picker mode="date" :value="createForm.targetDate" @change="e => createForm.targetDate = (e && e.detail && e.detail.value) || ''">
					<view class="create-row"><text class="create-label">日期</text><text class="create-value">{{ createForm.targetDate || '可选' }}</text></view>
				</picker>
				<view class="create-row">
					<text class="create-label">负责人</text>
					<view class="assignee-row">
						<view v-for="opt in ASSIGNEE_OPTS" :key="opt.value" class="assignee-chip" :class="{ active: createForm.assigneeId === opt.value }" @tap="createForm.assigneeId = opt.value">
							<text class="assignee-chip-text" :class="{ active: createForm.assigneeId === opt.value }">{{ opt.label }}</text>
						</view>
					</view>
				</view>
				<view class="create-submit" :class="{ disabled: !createCanSubmit || creating }" @tap="onCreateCustom">
					<text class="create-submit-text">{{ creating ? '创建中…' : '创建任务' }}</text>
				</view>
			</view>
		</view>
	</view>
</template>

<script setup>
import { ref, computed } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { useCollabStore } from '@/services/collabStore.js'
import { getSessionState } from '@/services/sessionService.js'

// 共同任务页：筛选/接下/状态流转/新建自定义任务（全部经 collabStore → outbox → mc-collab）
const collabStore = useCollabStore()

const TABS = [
	{ key: 'all', label: '全部' },
	{ key: 'pending', label: '待办' },
	{ key: 'doing', label: '进行中' },
	{ key: 'done', label: '已完成' },
	{ key: 'cancelled', label: '已取消' }
]
const ASSIGNEE_OPTS = [
	{ value: '', label: '待分配' },
	{ value: 'mama', label: '妈妈' },
	{ value: 'papa', label: '爸爸' }
]

const activeTab = ref('all')
const createVisible = ref(false)
const creating = ref(false)
const createForm = ref({ title: '', targetDate: '', assigneeId: '' })

const createCanSubmit = computed(() => (createForm.value.title || '').trim() !== '' && Array.from(createForm.value.title || '').length <= 100)

const allTasks = computed(() => {
	const list = Object.values(collabStore.tasks)
	list.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
	return list
})
const filteredTasks = computed(() => activeTab.value === 'all' ? allTasks.value : allTasks.value.filter(t => t.status === activeTab.value))

// need 来源标题动态投影（撤回→脱敏——store 层已强制；此处兜底显示占位）
function displayTitle(t) {
	if (t.sourceType === 'need') return t.title || '（分享已撤回）'
	return t.title || ''
}
function sourceLabel(t) {
	if (t.sourceType === 'need') return '来自分享'
	if (t.sourceType === 'checkup') return '来自产检'
	if (t.sourceType === 'bag') return '来自待产包'
	return '自定义'
}
function assigneeLabel(t) {
	if (t.acceptedBy) return t.acceptedBy === 'mama' ? '妈妈接下' : '爸爸接下'
	if (t.assigneeId) return t.assigneeId === 'mama' ? '指派：妈妈' : '指派：爸爸'
	return '未分配'
}
function statusLabel(t) {
	return { pending: '待办', doing: '进行中', done: '已完成', cancelled: '已取消' }[t.status] || t.status
}

// 接下条件：未接（无 acceptedBy）且未取消/完成
function canAccept(t) {
	return !t.acceptedBy && (t.status === 'pending' || t.status === 'doing') && !(t.sourceType === 'need' && t.needStatus === 'withdrawn')
}

function busyToast(r, okTitle) {
	if (r.ok) { uni.showToast({ title: okTitle, icon: 'none' }); return }
	if (r.code === 'revision-conflict') { uni.showToast({ title: '任务已被对方更新，请刷新', icon: 'none' }); return }
	if (r.code === 'outbox-persist-failed') { uni.showToast({ title: r.message || '本机保存失败，请重试', icon: 'none' }); return }
	uni.showToast({ title: '已暂存，联网后同步', icon: 'none' })
}

async function onAccept(t) {
	busyToast(await collabStore.acceptTask(t.sourceType, t.sourceId), '已接下')
}
async function onStart(t) {
	busyToast(await collabStore.updateTaskStatus(t.taskId, 'doing', t.revision), '已开始')
}
async function onDone(t) {
	busyToast(await collabStore.updateTaskStatus(t.taskId, 'done', t.revision), '已完成')
}
async function onUndo(t) {
	busyToast(await collabStore.updateTaskStatus(t.taskId, 'doing', t.revision), '已撤销完成')
}
async function onCancel(t) {
	busyToast(await collabStore.updateTaskStatus(t.taskId, 'cancelled', t.revision), '已取消')
}
async function onToggleDone(t) {
	if (t.status === 'cancelled') return
	if (t.status === 'done') return onUndo(t)
	return onDone(t)
}

async function onCreateCustom() {
	if (!createCanSubmit.value || creating.value) return
	creating.value = true
	try {
		const r = await collabStore.createCustomTask({
			title: createForm.value.title.trim(),
			...(createForm.value.targetDate ? { targetDate: createForm.value.targetDate } : {}),
			...(createForm.value.assigneeId ? { assigneeId: createForm.value.assigneeId } : {})
		})
		if (r.ok) {
			createForm.value = { title: '', targetDate: '', assigneeId: '' }
			createVisible.value = false
			uni.showToast({ title: '已创建', icon: 'none' })
		} else if (r.code === 'outbox-persist-failed') {
			uni.showToast({ title: r.message || '本机保存失败，请重试', icon: 'none', duration: 2500 })
		} else {
			uni.showToast({ title: '已暂存，联网后同步', icon: 'none', duration: 2500 })
			createVisible.value = false
		}
	} finally {
		creating.value = false
	}
}

onShow(() => {
	const s = getSessionState()
	if (s.status === 'confirmed' && s.member) {
		collabStore.pullCollab().catch(() => {})
		collabStore.flushAll().catch(() => {})
	}
})
</script>

<style>
.page {
	display: flex;
	flex-direction: column;
	height: 100vh;
	background: #f5f7fb;
}
.tabs {
	display: flex;
	flex-direction: row;
	background: #ffffff;
	padding: 12rpx 16rpx;
	gap: 8rpx;
}
.tab {
	flex: 1;
	padding: 14rpx 0;
	border-radius: 12rpx;
	display: flex;
	justify-content: center;
}
.tab.active {
	background: #eef3fe;
}
.tab-text {
	font-size: 26rpx;
	color: #46536a;
}
.tab-text.active {
	color: #4a7cf7;
	font-weight: 600;
}
.task-scroll {
	flex: 1;
	padding: 24rpx;
	box-sizing: border-box;
}
.empty-state {
	padding: 80rpx 0;
	display: flex;
	justify-content: center;
}
.empty-text {
	font-size: 26rpx;
	color: #9aa4b5;
}
.task-item {
	display: flex;
	flex-direction: row;
	align-items: flex-start;
	background: #ffffff;
	border-radius: 20rpx;
	padding: 24rpx;
	margin-bottom: 20rpx;
	box-shadow: 0 4rpx 16rpx rgba(17, 22, 34, 0.05);
}
.task-item-check {
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
.task-item-check.checked {
	background: #4a7cf7;
	border-color: #4a7cf7;
}
.task-item-check.disabled {
	opacity: 0.4;
}
.task-item-check-mark {
	color: #ffffff;
	font-size: 26rpx;
	font-weight: 700;
}
.task-item-main {
	flex: 1;
	display: flex;
	flex-direction: column;
}
.task-item-title {
	font-size: 28rpx;
	color: #2a3444;
	line-height: 1.5;
}
.task-item-title.done {
	color: #9aa4b5;
	text-decoration: line-through;
}
.task-item-title.cancelled {
	color: #b6bfce;
}
.task-item-meta {
	display: flex;
	flex-direction: row;
	flex-wrap: wrap;
	gap: 16rpx;
	margin-top: 8rpx;
}
.meta-text {
	font-size: 22rpx;
	color: #8a94a6;
}
.task-item-actions {
	display: flex;
	flex-direction: row;
	flex-wrap: wrap;
	gap: 16rpx;
	margin-top: 16rpx;
}
.act-btn {
	padding: 10rpx 28rpx;
	border-radius: 999rpx;
	background: #f2f5fa;
}
.act-btn-text {
	font-size: 24rpx;
	color: #46536a;
}
.act-primary {
	background: #4a7cf7;
}
.act-primary-text {
	color: #ffffff;
	font-weight: 600;
}
.act-danger {
	background: #fdeeee;
}
.act-danger-text {
	color: #d9534f;
}
.bottom-spacer {
	height: 140rpx;
}
.fab {
	position: fixed;
	right: 32rpx;
	bottom: calc(48rpx + env(safe-area-inset-bottom));
	padding: 20rpx 36rpx;
	border-radius: 999rpx;
	background: linear-gradient(90deg, #4a7cf7, #6a5cf6);
	box-shadow: 0 8rpx 24rpx rgba(74, 124, 247, 0.35);
}
.fab-text {
	font-size: 28rpx;
	font-weight: 600;
	color: #ffffff;
}
.create-mask {
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
.create-sheet {
	width: 100%;
	background: #ffffff;
	border-radius: 32rpx 32rpx 0 0;
	padding: 36rpx 32rpx calc(36rpx + env(safe-area-inset-bottom));
	display: flex;
	flex-direction: column;
}
.create-title {
	font-size: 34rpx;
	font-weight: 600;
	color: #11222e;
	margin-bottom: 24rpx;
}
.create-input {
	width: 100%;
	padding: 20rpx;
	box-sizing: border-box;
	border-radius: 16rpx;
	background: #f7f9fc;
	font-size: 28rpx;
	color: #2a3444;
}
.create-placeholder {
	color: #b6bfce;
}
.create-row {
	margin-top: 20rpx;
	display: flex;
	flex-direction: row;
	align-items: center;
	justify-content: space-between;
	padding: 20rpx;
	border-radius: 16rpx;
	background: #f7f9fc;
}
.create-label {
	font-size: 26rpx;
	color: #46536a;
}
.create-value {
	font-size: 26rpx;
	color: #2a3444;
}
.assignee-row {
	display: flex;
	flex-direction: row;
	gap: 12rpx;
}
.assignee-chip {
	padding: 8rpx 24rpx;
	border-radius: 999rpx;
	background: #ffffff;
	border: 2rpx solid #e3e8f0;
}
.assignee-chip.active {
	background: #eef3fe;
	border-color: #4a7cf7;
}
.assignee-chip-text {
	font-size: 24rpx;
	color: #46536a;
}
.assignee-chip-text.active {
	color: #4a7cf7;
}
.create-submit {
	margin-top: 28rpx;
	height: 92rpx;
	border-radius: 999rpx;
	background: linear-gradient(90deg, #4a7cf7, #6a5cf6);
	display: flex;
	align-items: center;
	justify-content: center;
}
.create-submit.disabled {
	opacity: 0.45;
}
.create-submit-text {
	font-size: 30rpx;
	font-weight: 600;
	color: #ffffff;
}
</style>
