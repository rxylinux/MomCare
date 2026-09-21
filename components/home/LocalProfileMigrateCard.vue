<template>
	<!-- 本地资料迁移引导：仅在 family 模式且满足 canOffer 四条件时渲染。
	     迁入 = 一次正常的家庭保存（savePregnancy 基线 0 首建），获得 outbox
	     幂等/离线重试/冲突协议；本机数据只读不删。 -->
	<view v-if="visible" class="migrate-card">
		<view class="migrate-title-row">
			<text class="migrate-title">检测到本机已保存孕期资料</text>
		</view>
		<text class="migrate-desc">这份资料保存时未连接家庭空间，目前只有本机能看到。迁入家庭档案后，家人在小程序上即可同步查看。</text>
		<view class="migrate-actions">
			<view class="migrate-btn-primary" @tap="doMigrate">
				<text class="migrate-btn-primary-text">{{ migrating ? '迁入中…' : '迁入家庭档案' }}</text>
			</view>
			<view class="migrate-btn-plain" @tap="doDecline">
				<text class="migrate-btn-plain-text">暂不</text>
			</view>
		</view>
	</view>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useHealthStore } from '@/stores/health.js'
import { useFamilyStore } from '@/services/familyStore.js'
import { getSessionState, subscribeSession } from '@/services/sessionService.js'
import { buildPayload, canOffer, isDeclined, markDeclined } from '@/utils/localProfileMigrate.js'

const props = defineProps({
	// 由宿主页面传入（首页 dataMode === 'family'）；演示/未确认态不渲染
	familyMode: { type: Boolean, default: false }
})

const healthStore = useHealthStore()
const familyStore = useFamilyStore()
const sessionVersion = subscribeSession()
// declined 标记写入后手动推进，让 visible 立即失效（storage 本身非响应式）
const declinedTick = ref(0)
const migrating = ref(false)

function localSnapshot() {
	return {
		userInfo: healthStore.userInfo,
		lmpDate: healthStore.lmpDate,
		dueDate: healthStore.dueDate
	}
}

const visible = computed(() => {
	if (!props.familyMode) return false
	// 订阅会话版本：身份确认/切换/退出即时生效；pregnancy/lastFullSyncAt
	// 依赖 familyStore 的响应式 ref（云端建档或拉取完成自动隐藏）
	void sessionVersion.value
	void declinedTick.value
	const s = getSessionState()
	if (!(s.status === 'confirmed' && s.member)) return false
	return canOffer({
		sessionConfirmed: true,
		pregnancy: familyStore.pregnancy,
		lastFullSyncAt: familyStore.lastFullSyncAt,
		payload: buildPayload(localSnapshot()),
		declined: isDeclined(s.member.familyId)
	})
})

async function doMigrate() {
	if (migrating.value) return
	const s = getSessionState()
	if (!(s.status === 'confirmed' && s.member)) return
	const payload = buildPayload(localSnapshot())
	if (Object.keys(payload).length === 0) return
	migrating.value = true
	try {
		// 基线 0 = 云端首建；对端已先建档时服务端返回 revision-conflict
		const result = await familyStore.savePregnancy(payload, 0)
		if (result.ok) {
			uni.showToast({ title: '已迁入家庭档案', icon: 'success', duration: 1500 })
			familyStore.pullAll().catch(() => {})
		} else if (result.code === 'revision-conflict') {
			uni.showToast({ title: '家庭档案已由对方建立，已为你刷新', icon: 'none', duration: 2500 })
			familyStore.pullAll().catch(() => {})
		} else {
			uni.showToast({ title: `迁入失败（${result.message || result.code}），可稍后重试`, icon: 'none', duration: 2500 })
		}
	} finally {
		migrating.value = false
	}
}

function doDecline() {
	const s = getSessionState()
	if (s.member) markDeclined(s.member.familyId)
	declinedTick.value += 1
	uni.showToast({ title: '已忽略；之后可在「我的-孕期资料」页找回本机内容', icon: 'none', duration: 2500 })
}
</script>

<style lang="scss" scoped>
.migrate-card {
	margin: 16rpx 24rpx 0;
	background: var(--color-primary-container, #FCE7F3);
	border: 2rpx solid rgba(194, 24, 91, 0.18);
	border-radius: 20rpx;
	padding: 20rpx 24rpx;
}

.migrate-title-row {
	display: flex;
	align-items: center;
}

.migrate-title {
	font-size: 26rpx;
	font-weight: 600;
	color: var(--color-primary, #C2185B);
}

.migrate-desc {
	display: block;
	margin-top: 8rpx;
	font-size: 24rpx;
	color: var(--color-text-secondary, #757575);
	line-height: 1.6;
}

.migrate-actions {
	display: flex;
	align-items: center;
	margin-top: 16rpx;
}

.migrate-btn-primary {
	background: var(--color-primary, #C2185B);
	border-radius: 999rpx;
	padding: 10rpx 32rpx;
}

.migrate-btn-primary-text {
	font-size: 24rpx;
	color: #FFFFFF;
	font-weight: 600;
}

.migrate-btn-plain {
	margin-left: 16rpx;
	padding: 10rpx 24rpx;
}

.migrate-btn-plain-text {
	font-size: 24rpx;
	color: var(--color-primary, #C2185B);
}
</style>
