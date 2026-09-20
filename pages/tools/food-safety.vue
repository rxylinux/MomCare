<template>
	<view class="page">
		<view class="head">
			<text class="title">饮食 · 行为安全速查</text>
			<text class="subtitle">本地权威词条库离线可查 · 未收录绝不假标为安全</text>
		</view>

		<!-- 搜索框（即时搜索 + 一键清除） -->
		<view class="search-row">
			<input
				class="search-input"
				v-model="keyword"
				placeholder="搜食物或行为，如：溏心蛋、拿铁、温泉"
				placeholder-class="search-placeholder"
				confirm-type="search"
			/>
			<view v-if="keyword" class="search-clear" @tap="clearKeyword">
				<text class="search-clear-text">✕</text>
			</view>
		</view>

		<!-- 分类 tab -->
		<view class="tabs">
			<view v-for="t in CATEGORY_TABS" :key="t.key" class="tab" :class="{ active: category === t.key }" @tap="category = t.key">
				<text class="tab-text" :class="{ active: category === t.key }">{{ t.label }}</text>
			</view>
		</view>

		<!-- 级别胶囊 -->
		<scroll-view scroll-x class="pill-scroll">
			<view class="pill-row">
				<view
					v-for="p in LEVEL_PILLS"
					:key="p.key"
					class="pill"
					:class="[p.key, { active: level === p.key }]"
					@tap="level = p.key"
				>
					<text class="pill-text" :class="{ active: level === p.key }">{{ p.label }}</text>
				</view>
			</view>
		</scroll-view>

		<!-- 结果卡片流 -->
		<view v-if="results.length > 0">
			<view v-for="item in results" :key="item.id" class="card">
				<view class="card-head" @tap="toggleDetail(item.id)">
					<view class="badge" :class="item.level"><text class="badge-text">{{ levelLabel(item.level) }}</text></view>
					<text class="card-name">{{ item.name }}</text>
					<text class="card-arrow">{{ expanded[item.id] ? '收起' : '详情' }}</text>
				</view>
				<text class="card-summary">{{ item.summary }}</text>
				<view v-if="expanded[item.id]" class="card-detail">
					<view class="detail-block">
						<text class="detail-label">前提条件</text>
						<text class="detail-text">{{ item.conditions }}</text>
					</view>
					<view class="detail-block">
						<text class="detail-label">风险说明</text>
						<text class="detail-text">{{ item.risks }}</text>
					</view>
					<view class="detail-block">
						<text class="detail-label">权威来源</text>
						<text class="detail-text">{{ item.source }}（审校 {{ item.reviewedAt }} · v{{ item.version }}）</text>
					</view>
				</view>
			</view>
		</view>

		<!-- 未收录空态（诚实未知 + AI 入口） -->
		<view v-else-if="keyword !== ''" class="empty-card">
			<text class="empty-title">未收录此条目</text>
			<text class="empty-desc">资料库未查到「{{ keyword }}」——绝不假标为安全；请咨询产科医生，或向 AI 咨询（需网络与服务支持）</text>
			<view class="empty-ai-btn" @tap="onAskAi">
				<text class="empty-ai-btn-text">向 AI 咨询「{{ keyword }}」</text>
			</view>
		</view>
		<view v-else class="empty-card">
			<text class="empty-title">开始搜索</text>
			<text class="empty-desc">输入食物或行为名称，查看本地已审定的安全级别与条件</text>
		</view>

		<!-- AI 结果面板 -->
		<view v-if="aiState.visible" class="ai-card">
			<view class="ai-head">
				<text class="ai-tag">AI 生成（未人工逐字审校）</text>
				<text v-if="aiState.enabled === false" class="ai-state">服务未启用</text>
			</view>
			<text class="ai-answer">{{ aiState.text }}</text>
			<text class="ai-disclaimer">{{ AI_MEDICAL_DISCLAIMER }}</text>
		</view>

		<!-- 底部医学免责声明（固定渲染） -->
		<view class="footer-disclaimer">
			<text class="footer-text">{{ AI_MEDICAL_DISCLAIMER }}</text>
		</view>
	</view>
</template>

<script setup>
import { ref, computed, reactive } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { useToolsStore } from '@/services/toolsStore.js'

// 饮食/行为安全速查页：本地字典即时检索 + 诚实空态 + AI 咨询（未启用如实提示）
const toolsStore = useToolsStore()

const AI_MEDICAL_DISCLAIMER = '本页内容仅供健康教育参考，不构成医疗诊断、处方或个体化建议；最终请以产检医生的意见为准。'
const AI_LABEL = 'AI 生成（未人工逐字审校）'

const CATEGORY_TABS = [
	{ key: 'all', label: '全部' },
	{ key: 'food', label: '食物' },
	{ key: 'behavior', label: '日常行为' }
]
const LEVEL_PILLS = [
	{ key: '', label: '全部级别' },
	{ key: 'safe', label: '安全' },
	{ key: 'caution', label: '注意' },
	{ key: 'avoid', label: '避免' },
	{ key: 'insufficient', label: '资料不足' }
]
const LEVEL_LABELS = { safe: '安全', caution: '注意', avoid: '避免', insufficient: '资料不足' }

const keyword = ref('')
const category = ref('all')
const level = ref('')
const expanded = reactive({})
const aiState = reactive({ visible: false, enabled: null, text: '' })

const results = computed(() => toolsStore.searchSafetyDictionary({ keyword: keyword.value, category: category.value, level: level.value }))

function levelLabel(lv) { return LEVEL_LABELS[lv] || lv }

function clearKeyword() {
	keyword.value = ''
	aiState.visible = false
}

function toggleDetail(id) {
	expanded[id] = !expanded[id]
}

async function onAskAi() {
	const query = keyword.value.trim()
	if (!query) return
	aiState.visible = true
	aiState.enabled = null
	aiState.text = '正在向 AI 咨询…'
	const r = await toolsStore.explainFoodWithAi({ query, stage: '孕期' })
	if (r.ok && r.data.enabled === false) {
		aiState.enabled = false
		aiState.text = r.data.message || 'AI 服务未配置或未启用，请查阅本地已审定词条或咨询医生'
	} else if (r.ok) {
		aiState.enabled = true
		aiState.text = r.data.answer
	} else {
		aiState.enabled = false
		aiState.text = r.message || 'AI 咨询失败，请稍后重试或咨询医生'
	}
}

onShow(() => {})
</script>

<style>
.page {
	min-height: 100vh;
	background: #f5f7fb;
	padding-bottom: 200rpx;
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
.search-row {
	display: flex;
	flex-direction: row;
	align-items: center;
	margin: 24rpx 32rpx 0;
	padding: 0 24rpx;
	border-radius: 999rpx;
	background: #ffffff;
	box-shadow: 0 4rpx 20rpx rgba(17, 22, 34, 0.06);
}
.search-input {
	flex: 1;
	height: 88rpx;
	font-size: 28rpx;
	color: #2a3444;
}
.search-placeholder {
	color: #b6bfce;
}
.search-clear {
	width: 56rpx;
	height: 56rpx;
	border-radius: 50%;
	background: #eef1f6;
	display: flex;
	align-items: center;
	justify-content: center;
}
.search-clear-text {
	font-size: 26rpx;
	color: #8a94a6;
}
.tabs {
	display: flex;
	flex-direction: row;
	margin: 24rpx 32rpx 0;
	padding: 8rpx;
	border-radius: 999rpx;
	background: #ffffff;
	box-shadow: 0 4rpx 20rpx rgba(17, 22, 34, 0.06);
}
.tab {
	flex: 1;
	padding: 14rpx 0;
	border-radius: 999rpx;
	display: flex;
	justify-content: center;
}
.tab.active {
	background: linear-gradient(90deg, #4a7cf7, #6a5cf7);
}
.tab-text {
	font-size: 26rpx;
	color: #46536a;
}
.tab-text.active {
	color: #ffffff;
	font-weight: 600;
}
.pill-scroll {
	margin-top: 20rpx;
	white-space: nowrap;
}
.pill-row {
	display: flex;
	flex-direction: row;
	gap: 16rpx;
	padding: 0 32rpx;
}
.pill {
	padding: 10rpx 28rpx;
	border-radius: 999rpx;
	background: #ffffff;
	border: 2rpx solid #e3e8f0;
}
.pill.safe { border-color: #bfe3c8; }
.pill.caution { border-color: #f0dcae; }
.pill.avoid { border-color: #efc5c2; }
.pill.insufficient { border-color: #cfd8e8; }
.pill.active { background: #eef3fe; border-color: #4a7cf7; }
.pill-text {
	font-size: 24rpx;
	color: #46536a;
}
.pill-text.active {
	color: #4a7cf7;
	font-weight: 600;
}
.card {
	margin: 24rpx 32rpx 0;
	padding: 28rpx;
	border-radius: 24rpx;
	background: #ffffff;
	box-shadow: 0 4rpx 20rpx rgba(17, 22, 34, 0.06);
}
.card-head {
	display: flex;
	flex-direction: row;
	align-items: center;
	gap: 16rpx;
}
.badge {
	padding: 6rpx 20rpx;
	border-radius: 999rpx;
}
.badge.safe { background: #e5f4e9; }
.badge.caution { background: #fdf3dd; }
.badge.avoid { background: #fde9e7; }
.badge.insufficient { background: #eaeef6; }
.badge.safe .badge-text { color: #2f7d4e; }
.badge.caution .badge-text { color: #9a7b2d; }
.badge.avoid .badge-text { color: #c0453f; }
.badge.insufficient .badge-text { color: #5b6a86; }
.badge-text {
	font-size: 22rpx;
	font-weight: 600;
}
.card-name {
	flex: 1;
	font-size: 30rpx;
	font-weight: 600;
	color: #11222e;
}
.card-arrow {
	font-size: 22rpx;
	color: #4a7cf7;
}
.card-summary {
	display: block;
	margin-top: 14rpx;
	font-size: 26rpx;
	color: #2a3444;
	line-height: 1.6;
}
.card-detail {
	margin-top: 18rpx;
	padding-top: 18rpx;
	border-top: 1rpx solid #f0f3f8;
}
.detail-block {
	margin-bottom: 16rpx;
	display: flex;
	flex-direction: column;
}
.detail-label {
	font-size: 22rpx;
	color: #8a94a6;
	margin-bottom: 6rpx;
}
.detail-text {
	font-size: 24rpx;
	color: #46536a;
	line-height: 1.6;
}
.empty-card {
	margin: 40rpx 32rpx 0;
	padding: 48rpx 32rpx;
	border-radius: 24rpx;
	background: #ffffff;
	border: 2rpx dashed #d4dcec;
	display: flex;
	flex-direction: column;
	align-items: center;
}
.empty-title {
	font-size: 30rpx;
	font-weight: 600;
	color: #2a3444;
}
.empty-desc {
	margin-top: 12rpx;
	font-size: 24rpx;
	color: #8a94a6;
	text-align: center;
	line-height: 1.6;
}
.empty-ai-btn {
	margin-top: 28rpx;
	padding: 20rpx 40rpx;
	border-radius: 999rpx;
	background: linear-gradient(90deg, #4a7cf7, #6a5cf7);
	box-shadow: 0 8rpx 24rpx rgba(74, 124, 247, 0.3);
}
.empty-ai-btn-text {
	font-size: 26rpx;
	font-weight: 600;
	color: #ffffff;
}
.ai-card {
	margin: 24rpx 32rpx 0;
	padding: 28rpx;
	border-radius: 24rpx;
	background: #f3f0ff;
	border: 2rpx solid #d9d0f5;
}
.ai-head {
	display: flex;
	flex-direction: row;
	align-items: center;
	justify-content: space-between;
}
.ai-tag {
	font-size: 22rpx;
	font-weight: 600;
	color: #6a5cf6;
}
.ai-state {
	font-size: 22rpx;
	color: #9aa4b5;
}
.ai-answer {
	display: block;
	margin-top: 14rpx;
	font-size: 26rpx;
	color: #2a3444;
	line-height: 1.7;
}
.ai-disclaimer {
	display: block;
	margin-top: 14rpx;
	font-size: 22rpx;
	color: #8a94a6;
	line-height: 1.6;
}
.footer-disclaimer {
	position: fixed;
	left: 0;
	right: 0;
	bottom: 0;
	padding: 20rpx 32rpx calc(20rpx + env(safe-area-inset-bottom));
	background: rgba(255, 255, 255, 0.96);
	border-top: 1rpx solid #eef1f6;
}
.footer-text {
	font-size: 22rpx;
	color: #8a94a6;
	line-height: 1.6;
}
</style>
