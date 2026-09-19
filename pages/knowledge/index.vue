<template>
	<view class="page">
		<!-- Search & Filter Row -->
		<view class="search-row">
			<view class="search-box-wrap">
				<text class="search-icon">🔍</text>
				<input
					class="search-box"
					type="text"
					placeholder="搜索孕期知识、症状、检查..."
					placeholder-class="search-placeholder"
					:value="searchKeyword"
					@input="onSearchInput"
					@confirm="handleSearch"
				/>
				<text v-if="searchKeyword" class="search-clear" @tap="clearSearch">✕</text>
			</view>
			<view class="filter-btn" :class="{ 'filter-btn-active': showFilterPopup }" @tap="toggleFilter">
				<text class="filter-text" :class="{ 'filter-text-active': showFilterPopup }">{{ sortLabel }} {{ showFilterPopup ? '▴' : '▾' }}</text>
			</view>
		</view>

		<!-- Filter Popup -->
		<view v-if="showFilterPopup" class="filter-popup-mask" @tap="showFilterPopup = false">
			<view class="filter-popup" @tap.stop>
				<view
					class="filter-option"
					:class="{ 'filter-option-active': sortBy === 'publish_time' }"
					@tap="applySort('publish_time')"
				>
					<text class="filter-option-text">最新发布</text>
					<text v-if="sortBy === 'publish_time'" class="filter-check">✓</text>
				</view>
				<view
					class="filter-option"
					:class="{ 'filter-option-active': sortBy === 'view_count' }"
					@tap="applySort('view_count')"
				>
					<text class="filter-option-text">最多阅读</text>
					<text v-if="sortBy === 'view_count'" class="filter-check">✓</text>
				</view>
			</view>
		</view>

		<!-- Category Tabs - Horizontal Scroll -->
		<view class="tabs-wrap">
			<scroll-view scroll-x class="tabs-scroll" :show-scrollbar="false">
				<view class="tabs">
					<view
						v-for="tab in categoryTabs"
						:key="tab.id"
						class="tab"
						:class="{ active: activeTab === tab.id }"
						@tap="switchTab(tab.id)"
					>
						<text class="tab-label" :class="{ 'tab-label-active': activeTab === tab.id }">{{ tab.name }}</text>
					</view>
				</view>
			</scroll-view>
		</view>

		<!-- Scrollable Content -->
		<scroll-view scroll-y class="scroll-content" @scrolltolower="loadMore">

			<!-- Week Recommendation Banner (only for recommended tab) -->
			<view v-if="activeTab === 'recommended' && bannerArticle" class="week-banner" @tap="readArticle(bannerArticle)">
				<view class="week-badge">
					<text class="week-icon">📅</text>
					<text class="week-text">孕{{ currentWeek }}周推荐</text>
				</view>
				<text class="banner-title">{{ bannerArticle.title }}</text>
				<text class="banner-desc">{{ bannerArticle.summary }}</text>
			</view>

			<!-- Loading Skeleton -->
			<view v-if="loading" class="article-feed">
				<view class="article-card" v-for="i in 3" :key="'sk'+i">
					<view class="article-cover">
						<view class="skeleton-cover"></view>
					</view>
					<view class="article-content">
						<view class="skeleton-title"></view>
						<view class="skeleton-text"></view>
						<view class="skeleton-text short"></view>
					</view>
				</view>
			</view>

			<!-- Article Feed -->
			<view v-else-if="feedList.length > 0" class="article-feed">
				<view
					class="article-card"
					v-for="article in feedList"
					:key="article.id"
					@tap="readArticle(article)"
				>
					<view class="article-cover">
						<image
							v-if="article.cover_image && !coverErrorMap[article.id]"
							class="cover-image"
							:src="article.cover_image"
							mode="aspectFill"
							@error="onCoverError(article)"
						/>
						<view v-else class="cover-placeholder" :class="getGradientClass(article.id)">
							<text class="cover-icon">{{ getCategoryIcon(article.category) }}</text>
						</view>
						<!-- Tags overlay -->
						<view v-if="article.tags && article.tags.length > 0" class="article-tag" :class="{ important: article.tags.includes('必读') || article.tags.includes('紧急必看') }">
							{{ article.tags[0] }}
						</view>
					</view>
					<view class="article-content">
						<view class="article-header">
							<text class="article-title">{{ article.title }}</text>
							<view v-if="article.tags && article.tags.includes('医生认证')" class="doctor-badge">
								<text class="doctor-icon">👨‍⚕️</text>
								<text class="doctor-text">医生认证</text>
							</view>
						</view>
						<text class="article-excerpt">{{ article.summary }}</text>
						<view class="article-meta">
							<view class="meta-item">
								<text class="meta-icon">👁️</text>
								<text class="meta-text">{{ formatViewCount(article.view_count) }}</text>
							</view>
							<view class="meta-item">
								<text class="meta-icon">⏱️</text>
								<text class="meta-text">{{ article.read_time }}分钟</text>
							</view>
							<view v-if="article.target_week_start" class="meta-item">
								<text class="meta-icon">📆</text>
								<text class="meta-text">孕{{ article.target_week_start }}-{{ article.target_week_end }}周</text>
							</view>
						</view>
					</view>
				</view>

				<!-- Load More Indicator -->
				<view v-if="loadingMore" class="load-more">
					<text class="load-more-text">加载中...</text>
				</view>
				<view v-else-if="!hasMore && feedList.length > 0" class="load-more">
					<text class="load-more-text no-more">— 没有更多了 —</text>
				</view>
			</view>

			<!-- Empty State -->
			<view v-else class="empty-state">
				<text class="empty-icon">📖</text>
				<text class="empty-text">暂无相关文章</text>
				<text class="empty-hint">换个分类看看吧</text>
			</view>

			<!-- Bottom Spacer for TabBar -->
			<view class="bottom-spacer"></view>
		</scroll-view>
		<CustomTabBar :active="1" />
	</view>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { navigateToPage } from '@/utils/navigation.js'
	import { request } from '@/utils/api.js' // 传输层保留（阶段 A 回归语义）；B1 起本页不再调用
import { useHealthStore } from '@/stores/health.js'
import NavBar from '@/components/NavBar.vue'
import CustomTabBar from '@/components/CustomTabBar.vue'

const healthStore = useHealthStore()

// ── State ──
const currentWeek = computed(() => {
	const weekInfo = healthStore.todayWeekInfo
	return weekInfo ? weekInfo.week : 0
})
const searchKeyword = ref('')
const activeTab = ref('recommended')
const articleList = ref([])
const loading = ref(false)
const loadingMore = ref(false)
const hasMore = ref(false)
const pageSize = 10
let currentPage = 0
const coverErrorMap = ref({})

// Sort & Filter
const sortBy = ref('')
const showFilterPopup = ref(false)

const sortLabel = computed(() => {
	if (sortBy.value === 'view_count') return '最多阅读'
	if (sortBy.value === 'publish_time') return '最新发布'
	return '筛选'
})

// Category tabs matching database categories
const categoryTabs = ref([
	{ id: 'recommended', name: '为您推荐' },
	{ id: '孕早期必读', name: '孕早期必读' },
	{ id: '孕中期指南', name: '孕中期指南' },
	{ id: '孕晚期准备', name: '孕晚期准备' },
	{ id: '分娩与临产', name: '分娩与临产' },
	{ id: '产后与育儿', name: '产后与育儿' }
])

// Banner article: first item in the full list when on Recommended tab
const bannerArticle = computed(() => {
	if (activeTab.value !== 'recommended' || articleList.value.length === 0) return null
	return articleList.value[0]
})

// Feed list: exclude banner article to prevent duplication
const feedList = computed(() => {
	if (activeTab.value === 'recommended' && articleList.value.length > 0) {
		return articleList.value.slice(1)
	}
	return articleList.value
})

// ── Data Fetching ──
	const allArticles = ref([])

	function getDefaultSort() {
		return activeTab.value === 'recommended' ? 'view_count' : 'publish_time'
	}

	async function fetchArticles(reset = true) {
		// B1：旧文章接口停用（正式内容服务待阶段 B 接入），不发起旧 HTTP 请求
		if (reset) {
			loadError.value = '内容服务尚未接入新云环境（阶段 B 配置后启用）'
			articleList.value = []
		}
		loading.value = false
		loadingMore.value = false
		return
		/* eslint-disable no-unreachable */
		if (reset) {
			currentPage = 0
			articleList.value = []
			loading.value = true
		} else {
			loadingMore.value = true
		}

		try {
			// Load from API on first call, then use cached allArticles
			if (allArticles.value.length === 0) {
				const res = await request({
					url: '/api/articles',
					method: 'GET',
				})
				if (res.statusCode === 200 && res.data && res.data.code === 0) {
					allArticles.value = res.data.data || []
					// Cache to localStorage for detail page use（缓存写失败不掩盖已加载的数据）
					try {
						uni.setStorageSync('cached_articles', JSON.stringify(allArticles.value))
					} catch (cacheErr) {
						console.warn('cached_articles write failed:', cacheErr)
					}
				}
			}

			let filtered = [...allArticles.value]

			// Filter by category tab
			if (activeTab.value !== 'recommended') {
				filtered = filtered.filter(a => a.category === activeTab.value)
			}

			// Filter by search keyword
			if (searchKeyword.value.trim()) {
				const kw = searchKeyword.value.trim().toLowerCase()
				filtered = filtered.filter(a => (a.title || '').toLowerCase().includes(kw))
			}

			// Sort
			const sort = sortBy.value || getDefaultSort()
			if (sort === 'view_count') {
				filtered.sort((a, b) => (b.view_count || 0) - (a.view_count || 0))
			} else {
				filtered.sort((a, b) => new Date(b.publish_time || 0) - new Date(a.publish_time || 0))
			}

			// Paginate
			const start = reset ? 0 : currentPage * pageSize
			const page = filtered.slice(start, start + pageSize)
			if (reset) {
				articleList.value = page
			} else {
				articleList.value = [...articleList.value, ...page]
			}
			hasMore.value = articleList.value.length < filtered.length
		} catch (e) {
			console.error('fetchArticles error:', e)
		}

		loading.value = false
		loadingMore.value = false
	}

	function loadMore() {
		if (loadingMore.value || !hasMore.value) return
		currentPage++
		fetchArticles(false)
	}

// ── Helpers ──

function formatViewCount(count) {
	if (!count) return '0'
	if (count >= 10000) {
		return (count / 10000).toFixed(1) + 'w'
	}
	if (count >= 1000) {
		return (count / 1000).toFixed(1) + 'k'
	}
	return String(count)
}

const gradientClasses = ['gradient-1', 'gradient-2', 'gradient-3', 'gradient-4', 'gradient-5']
function getGradientClass(id) {
	if (!id) return 'gradient-1'
	const hash = id.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)
	return gradientClasses[hash % gradientClasses.length]
}

function getCategoryIcon(category) {
	const icons = {
		'孕早期必读': '🤰',
		'孕中期指南': '👶',
		'孕晚期准备': '🤱',
		'分娩与临产': '🏥',
		'产后与育儿': '🍼'
	}
	return icons[category] || '📖'
}

function onCoverError(article) {
	coverErrorMap.value[article.id] = true
}

// ── Event Handlers ──

function onSearchInput(e) {
	searchKeyword.value = e.detail.value
}

function handleSearch() {
	fetchArticles(true)
}

function toggleFilter() {
	showFilterPopup.value = !showFilterPopup.value
}

function applySort(field) {
	sortBy.value = field
	showFilterPopup.value = false
	fetchArticles(true)
}

function clearSearch() {
	searchKeyword.value = ''
	fetchArticles(true)
}

function switchTab(tabId) {
	if (activeTab.value === tabId) return
	activeTab.value = tabId
	// Reset sort to default for the new tab
	sortBy.value = ''
	fetchArticles(true)
}

function readArticle(article) {
	navigateToPage(`/pages/knowledge/detail?id=${article.id}`)
}

// ── Init ──
onMounted(() => {
	fetchArticles(true)
})
</script>

<style scoped lang="scss">
/* ── CSS Variables ── */
page {
	--rose: #E8637A;
	--rose-light: #FDEEF1;
	--rose-mid: #F5B8C4;
	--rose-dark: #C0405A;
	--gray-50: #FAF9F8;
	--gray-100: #F2F0EE;
	--gray-200: #E4E1DC;
	--gray-300: #C8C4BC;
	--gray-400: #9C9890;
	--gray-500: #6E6A64;
	--gray-700: #3A3834;
	--gray-900: #1C1A17;
}

/* Page Container */
.page {
	display: flex;
	flex-direction: column;
	height: 100vh;
	background-color: #FBF7F2;
	box-sizing: border-box;
	position: relative;
	overflow: hidden;
}

/* ── Search Row ── */
.search-row {
	background: white;
	display: flex;
	padding: 20rpx 32rpx;
	gap: 16rpx;
	flex-shrink: 0;
}

.search-box-wrap {
	flex: 1;
	height: 72rpx;
	background: #F2F0EE;
	border-radius: 999px;
	display: flex;
	align-items: center;
	padding: 0 28rpx;
	gap: 12rpx;
}

.search-icon {
	font-size: 24rpx;
	flex-shrink: 0;
}

.search-box {
	flex: 1;
	height: 72rpx;
	font-size: 26rpx;
	color: #3A3834;
	background: transparent;
}

.search-placeholder {
	color: #C8C4BC;
	font-size: 26rpx;
}

.search-clear {
	font-size: 24rpx;
	color: #9C9890;
	padding: 8rpx;
}

/* ── Filter Button ── */
.filter-btn {
	height: 72rpx;
	padding: 0 24rpx;
	background: #F2F0EE;
	border-radius: 999px;
	display: flex;
	align-items: center;
	justify-content: center;
	transition: background 0.2s ease;
}

.filter-btn-active {
	background: #FCE7F3;
}

.filter-text {
	font-size: 24rpx;
	font-weight: 500;
	color: #6E6A64;
}

.filter-text-active {
	color: #C2185B;
}

/* ── Filter Popup ── */
.filter-popup-mask {
	position: fixed;
	top: 0;
	left: 0;
	right: 0;
	bottom: 0;
	z-index: 100;
	background: rgba(0, 0, 0, 0.2);
}

.filter-popup {
	position: absolute;
	top: 160rpx;
	right: 32rpx;
	background: #FFFFFF;
	border-radius: 24rpx;
	box-shadow: 0 8rpx 32rpx rgba(0, 0, 0, 0.12);
	overflow: hidden;
	min-width: 260rpx;
	animation: fadeIn 0.15s ease;
}

@keyframes fadeIn {
	from { opacity: 0; transform: translateY(-16rpx); }
	to { opacity: 1; transform: translateY(0); }
}

.filter-option {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 28rpx 32rpx;
	transition: background 0.15s ease;
}

.filter-option:active {
	background: #F2F0EE;
}

.filter-option-active {
	background: #FFF5F8;
}

.filter-option-text {
	font-size: 28rpx;
	color: #3A3834;
	font-weight: 500;
}

.filter-option-active .filter-option-text {
	color: #C2185B;
}

.filter-check {
	font-size: 28rpx;
	color: #C2185B;
	font-weight: 600;
}

/* ── Tabs ── */
.tabs-wrap {
	background: white;
	border-bottom: 1px solid #F2F0EE;
	flex-shrink: 0;
}

.tabs-scroll {
	white-space: nowrap;
}

.tabs {
	display: inline-flex;
	padding: 0 32rpx;
}

.tab {
	display: inline-flex;
	align-items: center;
	padding: 20rpx 28rpx;
	gap: 10rpx;
	border-bottom: 4rpx solid transparent;
	transition: border-color 0.2s ease;
}

.tab.active {
	border-bottom-color: #C2185B;
}

.tab-label {
	font-size: 26rpx;
	font-weight: 500;
	color: #9C9890;
	white-space: nowrap;
	transition: color 0.2s ease;
}

.tab-label-active {
	color: #C2185B;
	font-weight: 600;
}

/* Scrollable Content Area */
.scroll-content {
	flex: 1;
	height: 0;
	padding: 24rpx;
	box-sizing: border-box;
	background-color: #FBF7F2;
}

/* Week Recommendation Banner */
.week-banner {
	background: linear-gradient(135deg, #FCE7F3 0%, #F8BBD0 100%);
	border-radius: 32rpx;
	padding: 32rpx;
	margin-bottom: 32rpx;
}

.week-badge {
	display: flex;
	align-items: center;
	gap: 8rpx;
	background-color: rgba(194, 24, 91, 0.15);
	padding: 8rpx 16rpx;
	border-radius: 20rpx;
	width: fit-content;
	margin-bottom: 16rpx;
}

.week-icon {
	font-size: 24rpx;
}

.week-text {
	font-size: 24rpx;
	color: #C2185B;
	font-weight: 500;
}

.banner-title {
	display: block;
	font-size: 36rpx;
	font-weight: 600;
	color: #191C1E;
	margin-bottom: 12rpx;
}

.banner-desc {
	display: block;
	font-size: 26rpx;
	color: #616161;
	line-height: 1.5;
	overflow: hidden;
	text-overflow: ellipsis;
	display: -webkit-box;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
}

/* Article Feed */
.article-feed {
	display: flex;
	flex-direction: column;
	gap: 24rpx;
	margin-bottom: 32rpx;
}

.article-card {
	background-color: #FFFFFF;
	border-radius: 32rpx;
	overflow: hidden;
	box-shadow: 0 2rpx 16rpx rgba(0, 0, 0, 0.06);
	transition: transform 0.15s ease;
}

.article-card:active {
	transform: scale(0.985);
}

.article-cover {
	position: relative;
	width: 100%;
	height: 320rpx;
}

.cover-image {
	width: 100%;
	height: 100%;
}

.cover-placeholder {
	width: 100%;
	height: 100%;
	display: flex;
	align-items: center;
	justify-content: center;
}

.gradient-1 {
	background: linear-gradient(135deg, #E3F2FD 0%, #BBDEFB 100%);
}

.gradient-2 {
	background: linear-gradient(135deg, #F3E5F5 0%, #E1BEE7 100%);
}

.gradient-3 {
	background: linear-gradient(135deg, #FFF3E0 0%, #FFE0B2 100%);
}

.gradient-4 {
	background: linear-gradient(135deg, #E8F5E9 0%, #C8E6C9 100%);
}

.gradient-5 {
	background: linear-gradient(135deg, #FCE4EC 0%, #F8BBD0 100%);
}

.cover-icon {
	font-size: 80rpx;
}

.article-tag {
	position: absolute;
	top: 24rpx;
	left: 24rpx;
	background-color: #C2185B;
	color: #FFFFFF;
	font-size: 24rpx;
	font-weight: 500;
	padding: 8rpx 20rpx;
	border-radius: 20rpx;
}

.article-tag.important {
	background-color: #FFA726;
}

/* Article Content */
.article-content {
	padding: 32rpx;
}

.article-header {
	display: flex;
	justify-content: space-between;
	align-items: flex-start;
	margin-bottom: 16rpx;
}

.article-title {
	flex: 1;
	font-size: 32rpx;
	font-weight: 500;
	color: #191C1E;
	line-height: 1.4;
	margin-right: 16rpx;
	display: -webkit-box;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
	overflow: hidden;
}

.doctor-badge {
	display: flex;
	align-items: center;
	gap: 6rpx;
	background-color: #E8F5E9;
	padding: 8rpx 16rpx;
	border-radius: 20rpx;
	flex-shrink: 0;
}

.doctor-icon {
	font-size: 24rpx;
}

.doctor-text {
	font-size: 22rpx;
	color: #4CAF50;
	font-weight: 500;
}

.article-excerpt {
	display: block;
	font-size: 26rpx;
	color: #757575;
	line-height: 1.6;
	margin-bottom: 20rpx;
	overflow: hidden;
	text-overflow: ellipsis;
	display: -webkit-box;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
}

.article-meta {
	display: flex;
	align-items: center;
	gap: 24rpx;
}

.meta-item {
	display: flex;
	align-items: center;
	gap: 6rpx;
}

.meta-icon {
	font-size: 24rpx;
}

.meta-text {
	font-size: 24rpx;
	color: #9E9E9E;
}

/* ── Loading Skeleton ── */
.skeleton-cover {
	width: 100%;
	height: 320rpx;
	background: linear-gradient(90deg, #F2F0EE 25%, #E4E1DC 50%, #F2F0EE 75%);
	background-size: 200% 100%;
	animation: shimmer 1.5s infinite;
	border-radius: 32rpx 32rpx 0 0;
}

.skeleton-title {
	width: 80%;
	height: 32rpx;
	background: linear-gradient(90deg, #F2F0EE 25%, #E4E1DC 50%, #F2F0EE 75%);
	background-size: 200% 100%;
	animation: shimmer 1.5s infinite;
	border-radius: 8rpx;
	margin-bottom: 16rpx;
}

.skeleton-text {
	width: 100%;
	height: 26rpx;
	background: linear-gradient(90deg, #F2F0EE 25%, #E4E1DC 50%, #F2F0EE 75%);
	background-size: 200% 100%;
	animation: shimmer 1.5s infinite;
	border-radius: 8rpx;
	margin-bottom: 12rpx;
}

.skeleton-text.short {
	width: 60%;
}

@keyframes shimmer {
	0% { background-position: 200% 0; }
	100% { background-position: -200% 0; }
}

/* ── Empty State ── */
.empty-state {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	padding: 120rpx 32rpx;
}

.empty-icon {
	font-size: 80rpx;
	margin-bottom: 24rpx;
}

.empty-text {
	font-size: 32rpx;
	color: #6E6A64;
	font-weight: 500;
	margin-bottom: 12rpx;
}

.empty-hint {
	font-size: 26rpx;
	color: #9C9890;
}

/* ── Load More ── */
.load-more {
	display: flex;
	justify-content: center;
	padding: 32rpx 0;
}

.load-more-text {
	font-size: 26rpx;
	color: #C2185B;
	font-weight: 500;
}

.load-more-text.no-more {
	color: #C8C4BC;
	font-weight: 400;
}

/* Bottom Spacer */
.bottom-spacer {
	height: calc(120rpx + env(safe-area-inset-bottom));
}
</style>
