import { defineStore } from 'pinia'
import { ref } from 'vue'
import dailyJson from '@/static/data/pregnancy-daily.json'
import weeklyJson from '@/static/data/pregnancy-weekly-guide.json'

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
	const loaded = ref(dailyData.value.length > 0 && weeklyGuideData.value.length > 0)
	const loadError = ref(!loaded.value)

	// 保留异步接口供既有调用方使用；打包数据加载是同步且确定性的
	async function loadData() {
		if (loaded.value) return true
		dailyData.value = _parseList(dailyJson)
		weeklyGuideData.value = _parseList(weeklyJson)
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

	return {
		dailyData,
		weeklyGuideData,
		loaded,
		loadError,
		loadData,
		getDailyByTotalDays,
		getDailyRange,
		getWeeklyGuide
	}
})
