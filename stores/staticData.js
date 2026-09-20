import { defineStore } from 'pinia'
import { ref } from 'vue'
import dailyJson from '@/static/data/pregnancy-daily.json'
import weeklyJson from '@/static/data/pregnancy-weekly-guide.json'
import articlesJson from '@/static/data/articles.json'

function _parseList(raw) {
  if (!Array.isArray(raw)) return []
  return raw
}

// 静态内容改为构建期打包 import：
// - 小程序不再依赖 H5 站点路径语义的网络请求
// - 不存在“请求 404 但标记已加载”的假成功；数据随包分发，加载即真实
export const useStaticDataStore = defineStore('staticData', () => {
	const dailyData = ref(_parseList(dailyJson))
	const weeklyGuideData = ref(_parseList(weeklyJson))
	// Phase F：孕育知识库文章（离线静态库——检索/排序/分页全本地，零网络）
	const articlesData = ref(_parseList(articlesJson))
	const loaded = ref(dailyData.value.length > 0 && weeklyGuideData.value.length > 0)
	const loadError = ref(!loaded.value)

	// 保留异步接口供既有调用方使用；打包数据加载是同步且确定性的
	async function loadData() {
		if (loaded.value) return true
		dailyData.value = _parseList(dailyJson)
		weeklyGuideData.value = _parseList(weeklyJson)
		articlesData.value = _parseList(articlesJson)
		loaded.value = dailyData.value.length > 0 && weeklyGuideData.value.length > 0
		loadError.value = !loaded.value
		return loaded.value
	}

	function getDailyByTotalDays(totalDays) {
		if (totalDays < 0 || totalDays > 280) return null
		return dailyData.value.find(d => d.total_days === totalDays) || null
	}

	function getDailyRange(minDay, maxDay) {
		return dailyData.value.filter(
			d => d.total_days >= minDay && d.total_days <= maxDay
		)
	}

	function getWeeklyGuide(week) {
		if (week < 1 || week > 40) return null
		return weeklyGuideData.value.find(w => w.week === week) || null
	}

	// ── Phase F 知识库检索（100% 本地——零网络零延时）──
	// getArticles({ category, keyword, sortBy, page, pageSize })：
	// - category：'recommended'/省略 = 全部；否则按分类精确过滤
	// - keyword：title/subtitle/summary/tags 大小写不敏感子串
	// - sortBy：'view_count'（阅读量降序）/ 'publish_time'（发布时间降序）；缺省保持库序
	// - page 从 0 起；返回 { items, total, hasMore }
	function getArticles({ category, keyword, sortBy, page = 0, pageSize = 10 } = {}) {
		let list = [...articlesData.value]
		if (category && category !== 'recommended') {
			list = list.filter(a => a.category === category)
		}
		const kw = String(keyword || '').trim().toLowerCase()
		if (kw) {
			list = list.filter(a => {
				if (String(a.title || '').toLowerCase().includes(kw)) return true
				if (String(a.subtitle || '').toLowerCase().includes(kw)) return true
				if (String(a.summary || '').toLowerCase().includes(kw)) return true
				return (a.tags || []).some(t => String(t).toLowerCase().includes(kw))
			})
		}
		if (sortBy === 'view_count') {
			list.sort((a, b) => (b.view_count || 0) - (a.view_count || 0))
		} else if (sortBy === 'publish_time') {
			list.sort((a, b) => new Date(b.publish_time || 0) - new Date(a.publish_time || 0))
		}
		const size = Math.max(1, Number.isInteger(pageSize) ? pageSize : 10)
		const start = Math.max(0, Number.isInteger(page) ? page : 0) * size
		const items = list.slice(start, start + size)
		return { items, total: list.length, hasMore: start + items.length < list.length }
	}

	function getArticleById(id) {
		if (!id) return null
		return articlesData.value.find(a => a.id === String(id)) || null
	}

	return {
		dailyData,
		weeklyGuideData,
		articlesData,
		loaded,
		loadError,
		loadData,
		getDailyByTotalDays,
		getDailyRange,
		getWeeklyGuide,
		getArticles,
		getArticleById
	}
})
