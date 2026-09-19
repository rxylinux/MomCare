<template>
	<view class="page">
		<!-- Hero -->
		<view class="hero-gray">
			<NavBar title="隐私与数据" theme="dark" transparent :showBack="true" class="hero-navbar" />
			<view class="hero-content">
				<text class="hero-label">本机数据</text>
				<text class="hero-val">{{ totalRecords }}<text class="hero-unit">条</text></text>
				<text class="hero-sub">{{ dataModeText }}</text>
			</view>
		</view>

		<scroll-view scroll-y class="scroll-content">
			<!-- 存储说明（如实描述，不做无依据的加密承诺） -->
			<view class="privacy-banner">
				<text class="pb-icon">ℹ️</text>
				<text class="pb-text">健康记录与报告信息保存在本机存储中；登录后资料会同步到服务端。数据传输与存储依赖平台能力，本应用不承诺端到端加密，请勿在记录中保存敏感证件信息。</text>
			</view>

			<!-- 数据概览：来自真实存储计数 -->
			<view class="sec">
				<text class="sec-lbl">我的数据概览</text>
				<view class="data-list">
					<view v-for="(d, idx) in dataItems" :key="idx" class="data-item">
						<view class="di-icon" :style="{ background: d.iconBg }">
							<text class="di-icon-text">{{ d.icon }}</text>
						</view>
						<view class="di-body">
							<text class="di-title">{{ d.title }}</text>
							<text class="di-count">{{ d.count }}</text>
						</view>
					</view>
				</view>
			</view>

			<!-- 同步状态：真实结果 -->
			<view class="sec">
				<text class="sec-lbl">同步状态</text>
				<view class="action-card">
					<view class="action-row">
						<view class="action-icon" :style="{ background: '#EBF2FB' }">
							<text class="action-icon-text">☁️</text>
						</view>
						<text class="action-title">云端同步</text>
						<text class="action-tag" :style="{ color: '#757575' }">{{ syncStatusText }}</text>
					</view>
					<!-- 演示模式不展示正式档案的备份信息 -->
					<view class="action-row" v-if="!demoMode && backupItems.length > 0">
						<view class="action-icon" :style="{ background: '#F0ECFB' }">
							<text class="action-icon-text">📦</text>
						</view>
						<text class="action-title">本机备份</text>
						<text class="action-tag" :style="{ color: '#757575' }">{{ backupItems.length }} 份</text>
					</view>
				</view>
			</view>

			<!-- 数据管理 -->
			<view class="sec">
				<text class="sec-lbl">数据管理</text>
				<view class="action-card">
					<view v-for="(a, idx) in actionItems" :key="idx" class="action-row" @tap="handleAction(a)">
						<view class="action-icon" :style="{ background: a.iconBg }">
							<text class="action-icon-text">{{ a.icon }}</text>
						</view>
						<text class="action-title" :class="{ 'text-danger': a.danger }">{{ a.title }}</text>
						<text v-if="a.tag" class="action-tag" :style="{ color: a.tagColor }">{{ a.tag }}</text>
						<text class="action-arrow" :style="{ color: a.danger ? '#E05050' : '#C8C4BC' }">›</text>
					</view>
				</view>
				<text class="sec-note">导出/恢复将在后续版本提供；注销账号需要服务端支持，当前版本不可用。</text>
			</view>

			<view class="bottom-spacer"></view>
		</scroll-view>

		<!-- 危险操作确认弹窗 -->
		<ConfirmModal
			v-model:visible="showDangerModal"
			:title="dangerTitle"
			:content="dangerContent"
			confirmText="确定"
			confirmType="danger"
			@confirm="doDangerAction"
		/>
	</view>
</template>

<script setup>
import { ref, computed } from 'vue'
import NavBar from '@/components/NavBar.vue'
import ConfirmModal from '@/components/common/ConfirmModal.vue'
import { useHealthStore } from '@/stores/health.js'
import { useReportStore } from '@/stores/report'
import { isRealAuthed } from '@/utils/api.js'
import { listLegacyBackups, isDemoMode } from '@/utils/storage.js'

const healthStore = useHealthStore()
const reportStore = useReportStore()

const demoMode = isDemoMode()

const dataModeText = computed(() => demoMode
	? '演示模式 · 示例数据独立存放'
	: (isRealAuthed() ? '正式档案 · 已登录' : '正式档案 · 本机记录'))

const dataItems = computed(() => {
	const weightCount = Object.values(healthStore.records || {}).filter(r => r && r.weight).length
	const bpCount = Object.values(healthStore.records || {}).filter(r => r && r.bp).length
	const fetalCount = Object.values(healthStore.records || {}).filter(r => r && r.fetal).length
	const reportCount = reportStore.reports.length + reportStore.unarchivedReports.length
	return [
		{ icon: '⚖️', iconBg: '#FAEAEE', title: '体重记录', count: `${weightCount} 条` },
		{ icon: '💗', iconBg: '#EBF2FB', title: '血压记录', count: `${bpCount} 条` },
		{ icon: '👣', iconBg: '#EAF2EE', title: '胎动记录', count: `${fetalCount} 条` },
		{ icon: '📁', iconBg: '#FDF3E3', title: '产检报告', count: `${reportCount} 份` }
	]
})

const totalRecords = computed(() => {
	return Object.keys(healthStore.records || {}).length
})

const syncStatusText = computed(() => {
	if (demoMode) return '演示模式不同步'
	if (healthStore.needsLegacyConfirm) return '已阻止上传：旧数据来源待确认'
	if (!isRealAuthed()) return '未登录，仅本机'
	switch (reportStore.lastSyncStatus) {
		case 'ok': {
			const t = reportStore.lastSyncAt ? new Date(reportStore.lastSyncAt) : null
			return t ? `最近同步 ${formatTime(t)}` : '已同步'
		}
		case 'network': return '同步失败：网络不可用'
		case 'server': return '同步失败：服务不可用'
		case 'persist': return '已拉取云端，但本机缓存写入失败'
		default: return '尚未同步'
	}
})

function formatTime(d) {
	return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const backupItems = ref([])

const actionItems = computed(() => [
	{ icon: '📦', iconBg: '#EBF2FB', title: '导出全部数据', tag: '暂不可用', tagColor: '#9C9890', danger: false, action: 'exportAll' },
	{ icon: '🔒', iconBg: '#FDF3E3', title: '隐私政策', danger: false, action: 'policy' },
	{
		icon: '🗑', iconBg: '#F2F0EE', danger: true, action: 'clearCache',
		title: demoMode ? '清除演示数据' : '清除本机数据',
		tag: demoMode ? '仅演示数据' : '清除前自动备份',
		tagColor: '#F0A940'
	},
	{ icon: '⚠️', iconBg: '#FDEAEA', title: '注销账号并删除数据', tag: '暂不可用', tagColor: '#9C9890', danger: false, action: 'deleteAccount' }
])

function handleAction(item) {
	if (item.action === 'policy') {
		uni.showToast({ title: '隐私政策页面开发中', icon: 'none' })
		return
	}
	if (item.action === 'exportAll' || item.action === 'deleteAccount') {
		// 如实展示未实现，不弹假成功
		uni.showToast({ title: item.action === 'exportAll' ? '导出功能暂不可用' : '注销需要服务端支持，暂不可用', icon: 'none', duration: 2500 })
		return
	}
	if (item.action === 'clearCache') {
		dangerTitle.value = demoMode ? '清除演示数据' : '清除本机数据'
		dangerContent.value = demoMode
			? '将清除本机的演示示例数据，不影响正式档案。'
			: '将清除本机的健康记录与报告数据。\n清除前会自动创建一份可恢复备份；此操作不影响云端数据。'
		dangerAction.value = item.action
		showDangerModal.value = true
	}
}

const showDangerModal = ref(false)
const dangerTitle = ref('')
const dangerContent = ref('')
const dangerAction = ref('')

function refreshBackups() {
	// 演示模式不列出正式档案的备份
	backupItems.value = demoMode ? [] : listLegacyBackups()
}

function doDangerAction() {
	if (dangerAction.value !== 'clearCache') {
		showDangerModal.value = false
		return
	}
	showDangerModal.value = false
	// 模式感知的真实清除：演示只清演示键；正式先备份、备份成功才清除并全量重置内存
	const result = healthStore.clearLocalData()
	uni.showToast({
		title: result.ok ? result.message : (result.message || '清除失败，请重试'),
		icon: 'none',
		duration: 3000
	})
	if (result.ok) refreshBackups()
}

refreshBackups()
</script>

<style scoped lang="scss">
.page {
	display: flex;
	flex-direction: column;
	height: 100vh;
	background-color: #FBF7F2;
}

.hero-gray {
	background: linear-gradient(155deg, #3A3834 0%, #6E6A64 45%, #A8A49C 100%);
	padding: 0 36rpx 36rpx;
	flex-shrink: 0;
}

.hero-content { position: relative; z-index: 1; }

.hero-label {
	display: block;
	font-size: 22rpx;
	color: rgba(255, 255, 255, 0.7);
	letter-spacing: 3rpx;
	margin-bottom: 6rpx;
}

.hero-val {
	font-size: 64rpx;
	font-weight: 700;
	color: #FFFFFF;
	line-height: 1;
}

.hero-unit {
	font-size: 32rpx;
	font-weight: 400;
	opacity: 0.8;
}

.hero-sub {
	display: block;
	font-size: 24rpx;
	color: rgba(255, 255, 255, 0.8);
	margin-top: 6rpx;
}

.scroll-content { flex: 1; }

.privacy-banner {
	margin: 24rpx 28rpx 0;
	background: #EBF2FB;
	border: 2rpx solid rgba(91, 143, 201, 0.25);
	border-radius: 32rpx;
	padding: 24rpx 28rpx;
	display: flex;
	gap: 20rpx;
	align-items: flex-start;
}

.pb-icon {
	font-size: 40rpx;
	flex-shrink: 0;
}

.pb-text {
	font-size: 24rpx;
	color: #5B8FC9;
	line-height: 1.6;
}

.sec {
	margin: 20rpx 28rpx 0;
}

.sec-lbl {
	display: block;
	font-size: 22rpx;
	font-weight: 700;
	color: #9C9890;
	text-transform: uppercase;
	letter-spacing: 3rpx;
	margin-bottom: 14rpx;
}

.sec-note {
	display: block;
	font-size: 22rpx;
	color: #9C9890;
	margin-top: 12rpx;
	line-height: 1.6;
}

.data-list {
	display: flex;
	flex-direction: column;
	gap: 16rpx;
}

.data-item {
	background: #FFFFFF;
	border-radius: 20rpx;
	box-shadow: 0 4rpx 28rpx rgba(60, 30, 10, 0.07);
	padding: 24rpx 28rpx;
	display: flex;
	align-items: center;
	gap: 20rpx;
}

.di-icon {
	width: 72rpx;
	height: 72rpx;
	border-radius: 20rpx;
	display: flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
}

.di-icon-text { font-size: 32rpx; }

.di-body { flex: 1; }

.di-title {
	display: block;
	font-size: 26rpx;
	font-weight: 600;
	color: #1C1A17;
}

.di-count {
	display: block;
	font-size: 22rpx;
	color: #9C9890;
	margin-top: 2rpx;
}

.action-card {
	background: #FFFFFF;
	border-radius: 32rpx;
	box-shadow: 0 4rpx 28rpx rgba(60, 30, 10, 0.07);
	overflow: hidden;
}

.action-row {
	display: flex;
	align-items: center;
	padding: 26rpx 28rpx;
	border-bottom: 1rpx solid #E8DDD0;
}

.action-row:last-child { border-bottom: none; }

.action-icon {
	width: 64rpx;
	height: 64rpx;
	border-radius: 18rpx;
	display: flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
	margin-right: 22rpx;
}

.action-icon-text { font-size: 30rpx; }

.action-title {
	font-size: 28rpx;
	font-weight: 500;
	color: #1C1A17;
	flex: 1;
}

.text-danger { color: #E05050; }

.action-tag {
	font-size: 22rpx;
	margin-right: 12rpx;
}

.action-arrow {
	font-size: 28rpx;
}

.bottom-spacer { height: 40rpx; }
</style>
