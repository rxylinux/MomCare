// 每日提醒共用核心——主页"今日提醒"与云函数 mc-daily-push 同一单源（2026-09-25 定案）。
// 三级瀑布：产检（当天/≤7 天倒计时/过期 ≤14 天补提醒）→ 家庭任务 → null（调用方回落静态内容库）。
// 可移植性契约（tests/phase-l 锁定）：零 import、零平台依赖（禁 uni./wx./process.）——
// 客户端 vite 直引；云端 assemble.mjs 用 esbuild 转译 ESM→CJS 投进 shared/，两端同一字节。
// 口径参数（倒计时窗口 7 天、过期提醒上限 14 天）只在这里改，两端同一天算出同一句；
// 过期超上限视为陈旧数据不唠叨。

const DAY_MS = 86400000

function dayOrdinal(input) {
	if (input instanceof Date) {
		return Date.UTC(input.getFullYear(), input.getMonth(), input.getDate()) / DAY_MS
	}
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(input || ''))
	if (!m) return null
	return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS
}

function clampText(value, max) {
	const s = String(value || '').trim()
	if (!s) return ''
	return s.length <= max ? s : s.slice(0, max) + '…'
}

// 孕周标签："孕X周+Y"按 lmp 折算——主页 tip 标题与将来推送文案（"孕24周+3 · 距产检3天"）
// 两端同款；lmp 在 dateKey 之前同日为 0 天，非法/早于 lmp 返回空串由调用方回落
export function gestationalLabel(lmp, dateKey) {
	const lmpOrd = dayOrdinal(lmp)
	const dOrd = dayOrdinal(dateKey)
	if (lmpOrd === null || dOrd === null) return ''
	const n = dOrd - lmpOrd
	if (n < 0) return ''
	return `孕${Math.floor(n / 7)}周+${n % 7}`
}

export function buildTodayTip({ today, checkups = [], tasks = [] } = {}) {
	const todayOrd = dayOrdinal(today)
	if (todayOrd === null) return null

	// 一级：产检（按日期升序）。最早一条若近期过期，补提醒优先于远期倒计时——
	// 错过的产检是当下可行动的事，20 天后的不是；过期超上限（陈旧）则跳过。
	const sorted = (Array.isArray(checkups) ? checkups : [])
		.map(c => ({ ord: dayOrdinal(c && c.date), title: clampText(c && c.title, 16) }))
		.filter(c => c.ord !== null)
		.sort((a, b) => a.ord - b.ord)

	const first = sorted[0]
	if (first && first.ord < todayOrd && todayOrd - first.ord <= 14) {
		return { tag: '产检', icon: '🏥', text: `产检已过${todayOrd - first.ord}天 · 记得补约或更新记录` }
	}

	const upcoming = sorted.find(c => c.ord >= todayOrd)
	if (upcoming) {
		const label = upcoming.title ? ` · ${upcoming.title}` : ''
		if (upcoming.ord === todayOrd) {
			return { tag: '产检', icon: '🏥', text: `今天产检${label}，带好证件和产检手册` }
		}
		if (upcoming.ord - todayOrd <= 7) {
			return { tag: '产检', icon: '🏥', text: `距下次产检${upcoming.ord - todayOrd}天${label}` }
		}
	}

	// 二级：家庭任务（调用方按视角排序后传入：爸爸视角先给"我负责的"）
	const task = (Array.isArray(tasks) ? tasks : []).find(t => t && String(t.title || '').trim())
	if (task) {
		return { tag: '待办', icon: '📝', text: `待办：${clampText(task.title, 24)}` }
	}

	return null
}
