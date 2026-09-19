<template>
	<view class="page">
		<!-- NavBar -->
		<NavBar title="文章详情" />

		<!-- Loading State -->
		<view v-if="loading" class="loading-wrap">
			<view class="skeleton-cover"></view>
			<view class="skeleton-body">
				<view class="skeleton-title"></view>
				<view class="skeleton-meta"></view>
				<view class="skeleton-text"></view>
				<view class="skeleton-text"></view>
				<view class="skeleton-text short"></view>
				<view class="skeleton-text"></view>
				<view class="skeleton-text short"></view>
			</view>
		</view>

		<!-- Error State -->
		<view v-else-if="error" class="error-state">
			<text class="error-icon">😔</text>
			<text class="error-text">文章加载失败</text>
			<text class="error-hint">{{ error }}</text>
			<view class="error-btn" @tap="goBack">
				<text class="error-btn-text">返回</text>
			</view>
		</view>

		<!-- Article Content -->
		<scroll-view v-else-if="article" scroll-y class="scroll-content">
			<!-- Cover Image -->
			<view v-if="article.cover_image" class="cover-wrap">
				<image class="cover-image" :src="article.cover_image" mode="aspectFill" />
				<view class="cover-overlay"></view>
			</view>

			<!-- Article Header -->
			<view class="article-header" :class="{ 'has-cover': article.cover_image }">
				<!-- Tags -->
				<view v-if="article.tags && article.tags.length > 0" class="tag-row">
					<view
						class="tag-chip"
						v-for="tag in article.tags"
						:key="tag"
						:class="{ 'tag-chip-doctor': tag === '医生认证', 'tag-chip-hot': tag === '热门' || tag === '必看' }"
					>
						<text class="tag-chip-text">{{ tag }}</text>
					</view>
				</view>

				<!-- Title -->
				<text class="detail-title">{{ article.title }}</text>

				<!-- Meta Row -->
				<view class="meta-row">
					<view v-if="publishDate" class="meta-badge">
						<text class="meta-badge-text">{{ publishDate }}</text>
					</view>
					<view class="meta-badge">
						<text class="meta-badge-text">👁️ {{ formatViewCount(article.view_count) }}</text>
					</view>
					<view class="meta-badge">
						<text class="meta-badge-text">⏱️ {{ article.read_time }}分钟</text>
					</view>
					<view v-if="article.target_week_start" class="meta-badge accent">
						<text class="meta-badge-text accent-text">孕{{ article.target_week_start }}-{{ article.target_week_end }}周</text>
					</view>
				</view>
			</view>

			<!-- Summary -->
			<view v-if="article.summary" class="summary-section">
				<text class="summary-text">{{ article.summary }}</text>
			</view>

			<!-- Markdown Content -->
			<view class="content-section">
				<rich-text :nodes="htmlContent" class="rich-content"></rich-text>
			</view>

			<!-- Bottom Spacer -->
			<view class="bottom-spacer"></view>
		</scroll-view>
	</view>
</template>

<script setup>
import { ref, computed } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { request } from '@/utils/api.js'
import NavBar from '@/components/NavBar.vue'

const article = ref(null)
const loading = ref(true)
const error = ref('')

// Format publish date
const publishDate = computed(() => {
	if (!article.value || !article.value.publish_time) return ''
	const d = new Date(article.value.publish_time)
	if (isNaN(d.getTime())) return ''
	return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
})

// Convert markdown to HTML
const htmlContent = computed(() => {
	if (!article.value || !article.value.content) return '<p>暂无内容</p>'
	return markdownToHtml(article.value.content)
})

// ── Lightweight Markdown to HTML converter ──
function markdownToHtml(md) {
	if (!md) return ''

	let html = md

	// Escape HTML entities in content (but not our generated HTML)
	html = html.replace(/&/g, '&amp;')
	html = html.replace(/</g, '&lt;')
	html = html.replace(/>/g, '&gt;')

	// ── Tables: convert to key-value card list (rich-text doesn't support <table>) ──
	html = html.replace(/^(\|.+\|)\n(\|[\s\-:|]+\|)\n((?:\|.+\|\n?)+)/gm, (match, header, sep, body) => {
		const headers = header.split('|').filter(c => c.trim())
		const rows = body.trim().split('\n').filter(r => r.trim())

		let out = ''

		// If only 2 columns (most common: key-value pairs), render as label-value rows
		if (headers.length === 2) {
			rows.forEach(row => {
				const cells = row.split('|').filter(c => c.trim())
				const label = (cells[0] || '').trim()
				const value = (cells[1] || '').trim()
				out += `<p><strong>${label}</strong>　${value}</p>`
			})
		} else {
			// Multi-column: header row bold, then each cell joined
			const headerLabels = headers.map(h => h.trim()).join('　|　')
			out += `<p><strong>${headerLabels}</strong></p>`
			rows.forEach(row => {
				const cells = row.split('|').filter(c => c.trim())
				const values = cells.map(c => c.trim()).join('　|　')
				out += `<p>${values}</p>`
			})
		}

		return out
	})

	// Headings
	html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>')
	html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>')

	// Bold
	html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')

	// Blockquotes
	html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')
	// Merge consecutive blockquotes
	html = html.replace(/<\/blockquote>\n<blockquote>/g, '\n')

	// Unordered lists
	html = html.replace(/^- (.+)$/gm, '<li>$1</li>')
	html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>')

	// Ordered lists
	html = html.replace(/^\d+\. (.+)$/gm, '<oli>$1</oli>')
	html = html.replace(/((?:<oli>.*<\/oli>\n?)+)/g, (match) => {
		return '<ol>' + match.replace(/<\/?oli>/g, (tag) => tag === '<oli>' ? '<li>' : '</li>') + '</ol>'
	})

	// Horizontal rule - use view instead of hr (not supported in mini-program)
	html = html.replace(/^---+$/gm, '<view class="hr-divider"></view>')

	// Paragraphs: wrap remaining loose lines
	html = html.replace(/\n\n+/g, '\n</p>\n<p>\n')
	// Clean up empty paragraphs around block elements
	html = html.replace(/<p>\s*<\/p>/g, '')
	html = html.replace(/<p>\s*(<h[23]|<ul|<ol|<blockquote|<view class="hr-divider")/g, '$1')
	html = html.replace(/(<\/h[23]>|<\/ul>|<\/ol>|<\/blockquote>|<\/view>)\s*<\/p>/g, '$1')

	// Wrap in root paragraph if not starting with a block element
	if (!html.startsWith('<')) {
		html = '<p>' + html
	}
	if (!html.endsWith('>')) {
		html += '</p>'
	}

	return html
}

// ── Helpers ──
function formatViewCount(count) {
	if (!count) return '0'
	if (count >= 10000) return (count / 10000).toFixed(1) + 'w'
	if (count >= 1000) return (count / 1000).toFixed(1) + 'k'
	return String(count)
}

function goBack() {
	uni.navigateBack({ delta: 1 })
}

// ── Fetch article by ID ──
// B1/R2：旧文章接口已集中停用（request 层 fail closed）；本地缓存可用则展示，
// 否则如实说明内容服务未接入，不发起旧 HTTP 请求
async function loadArticleById(options) {
	if (!options || !options.id) {
		error.value = '缺少文章ID'
		loading.value = false
		return
	}
	const cached = uni.getStorageSync('cached_articles')
	if (cached) {
		try {
			const found = JSON.parse(cached).find(a => a.id === options.id || a._id === options.id)
			if (found) {
				article.value = found
				loading.value = false
				return
			}
		} catch (e) {
			console.warn('cached_articles parse failed:', e)
		}
	}
	error.value = '内容服务尚未接入新云环境（阶段 B 配置后启用），且本机无该文章缓存'
	loading.value = false
}

onLoad(async (options) => {
	await loadArticleById(options)
})
</script>

<style scoped lang="scss">
/* Page */
.page {
	display: flex;
	flex-direction: column;
	height: 100vh;
	background-color: #FFFFFF;
	box-sizing: border-box;
}

/* ── Loading Skeleton ── */
.loading-wrap {
	flex: 1;
}

.skeleton-cover {
	width: 100%;
	height: 400rpx;
	background: linear-gradient(90deg, #F2F0EE 25%, #E4E1DC 50%, #F2F0EE 75%);
	background-size: 200% 100%;
	animation: shimmer 1.5s infinite;
}

.skeleton-body {
	padding: 40rpx 32rpx;
}

.skeleton-title {
	width: 80%;
	height: 44rpx;
	background: linear-gradient(90deg, #F2F0EE 25%, #E4E1DC 50%, #F2F0EE 75%);
	background-size: 200% 100%;
	animation: shimmer 1.5s infinite;
	border-radius: 8rpx;
	margin-bottom: 24rpx;
}

.skeleton-meta {
	width: 50%;
	height: 28rpx;
	background: linear-gradient(90deg, #F2F0EE 25%, #E4E1DC 50%, #F2F0EE 75%);
	background-size: 200% 100%;
	animation: shimmer 1.5s infinite;
	border-radius: 8rpx;
	margin-bottom: 40rpx;
}

.skeleton-text {
	width: 100%;
	height: 28rpx;
	background: linear-gradient(90deg, #F2F0EE 25%, #E4E1DC 50%, #F2F0EE 75%);
	background-size: 200% 100%;
	animation: shimmer 1.5s infinite;
	border-radius: 8rpx;
	margin-bottom: 16rpx;
}

.skeleton-text.short {
	width: 60%;
}

@keyframes shimmer {
	0% { background-position: 200% 0; }
	100% { background-position: -200% 0; }
}

/* ── Error State ── */
.error-state {
	flex: 1;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	padding: 0 64rpx;
}

.error-icon {
	font-size: 80rpx;
	margin-bottom: 24rpx;
}

.error-text {
	font-size: 34rpx;
	color: #3A3834;
	font-weight: 500;
	margin-bottom: 12rpx;
}

.error-hint {
	font-size: 26rpx;
	color: #9C9890;
	margin-bottom: 40rpx;
}

.error-btn {
	padding: 20rpx 64rpx;
	background: #C2185B;
	border-radius: 999px;
}

.error-btn-text {
	color: #FFFFFF;
	font-size: 28rpx;
	font-weight: 500;
}

/* ── Scroll Content ── */
.scroll-content {
	flex: 1;
	padding-bottom: calc(80rpx + env(safe-area-inset-bottom));
}

/* ── Cover Image ── */
.cover-wrap {
	position: relative;
	width: 100%;
	height: 400rpx;
}

.cover-image {
	width: 100%;
	height: 100%;
}

.cover-overlay {
	position: absolute;
	bottom: 0;
	left: 0;
	right: 0;
	height: 120rpx;
	background: linear-gradient(transparent, #FFFFFF);
}

/* ── Article Header ── */
.article-header {
	padding: 40rpx 32rpx 0;
}

.article-header.has-cover {
	margin-top: -40rpx;
	position: relative;
	z-index: 1;
}

/* Tags */
.tag-row {
	display: flex;
	flex-wrap: wrap;
	gap: 12rpx;
	margin-bottom: 20rpx;
}

.tag-chip {
	padding: 6rpx 20rpx;
	border-radius: 20rpx;
	background: #F2F0EE;
}

.tag-chip-text {
	font-size: 22rpx;
	color: #6E6A64;
	font-weight: 500;
}

.tag-chip-doctor {
	background: #E8F5E9;
}

.tag-chip-doctor .tag-chip-text {
	color: #4CAF50;
}

.tag-chip-hot {
	background: #FCE7F3;
}

.tag-chip-hot .tag-chip-text {
	color: #C2185B;
}

/* Title */
.detail-title {
	display: block;
	font-size: 40rpx;
	font-weight: 700;
	color: #191C1E;
	line-height: 1.4;
	margin-bottom: 24rpx;
}

/* Meta Row */
.meta-row {
	display: flex;
	flex-wrap: wrap;
	gap: 12rpx;
	margin-bottom: 8rpx;
}

.meta-badge {
	padding: 6rpx 16rpx;
	background: #F5F5F5;
	border-radius: 16rpx;
}

.meta-badge-text {
	font-size: 22rpx;
	color: #9E9E9E;
}

.meta-badge.accent {
	background: rgba(194, 24, 91, 0.08);
}

.meta-badge-text.accent-text {
	color: #C2185B;
	font-weight: 500;
}

/* ── Summary ── */
.summary-section {
	margin: 32rpx 32rpx 0;
	padding: 24rpx;
	background: #FFF8FA;
	border-left: 6rpx solid #C2185B;
	border-radius: 0 16rpx 16rpx 0;
}

.summary-text {
	font-size: 28rpx;
	color: #616161;
	line-height: 1.7;
}

/* ── Content Section ── */
.content-section {
	padding: 32rpx;
}

/* Rich Text Styles */
.rich-content {
	font-size: 30rpx;
	color: #333333;
	line-height: 1.8;
	word-break: break-word;
}

/* Headings in rich-text */
:deep(.rich-content) h2 {
	font-size: 36rpx;
	font-weight: 700;
	color: #191C1E;
	margin: 48rpx 0 24rpx;
	padding-bottom: 16rpx;
	border-bottom: 2rpx solid #F2F0EE;
}

:deep(.rich-content) h3 {
	font-size: 32rpx;
	font-weight: 600;
	color: #333333;
	margin: 40rpx 0 20rpx;
}

:deep(.rich-content) strong {
	font-weight: 600;
	color: #191C1E;
}

:deep(.rich-content) blockquote {
	margin: 24rpx 0;
	padding: 20rpx 24rpx;
	background: #F5F5F5;
	border-left: 6rpx solid #C2185B;
	border-radius: 0 12rpx 12rpx 0;
	color: #616161;
	font-size: 28rpx;
	line-height: 1.7;
}

:deep(.rich-content) ul, :deep(.rich-content) ol {
	margin: 16rpx 0;
	padding-left: 40rpx;
}

:deep(.rich-content) li {
	margin-bottom: 8rpx;
	line-height: 1.7;
}

:deep(.rich-content) .hr-divider {
	border-top: 2rpx solid #E4E1DC;
	margin: 32rpx 0;
	height: 0;
}

:deep(.rich-content) p {
	margin: 12rpx 0;
}

/* ── Bottom Spacer ── */
.bottom-spacer {
	height: 80rpx;
}
</style>
