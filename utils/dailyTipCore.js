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

// ══ 每日推送内容（mc-daily-push 消费；主页内容库二期同源演进）══
// 内容三规则（2026-09-25 用户定）：①结合孕周阶段变化（按周段分池）
// ②营养主题按孕周轮换（早期叶酸→中期钙/铁/DHA→晚期铁钙控糖）
// ③涉水果必写当季具体果名（按月份，禁泛泛"补维生素"；适量 200~350g 不催多吃）。
// note 按天轮换（todayOrd 取模），同周不同日不重句；词条为 v1 起草稿，待用户审后扩库。
// 订阅消息 thing 字段 ≤20 字——main/note 一律裁到 20。

const SEASONAL_FRUIT = {
	1: ['橙子', '柚子'], 2: ['猕猴桃', '橙子'], 3: ['草莓', '菠萝'],
	4: ['芒果', '菠萝'], 5: ['樱桃', '枇杷'], 6: ['荔枝', '樱桃'],
	7: ['桃子', '西瓜'], 8: ['西瓜', '葡萄'], 9: ['鲜枣', '梨', '葡萄'],
	10: ['梨', '柿子', '石榴'], 11: ['苹果', '冬枣'], 12: ['橙子', '甘蔗']
}

function monthOf(input) {
	if (input instanceof Date) return input.getMonth() + 1
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(input || ''))
	return m ? Number(m[2]) : null
}

function notePool(week, fruit) {
	const f = fruit || '当季水果'
	if (week < 13) {
		return ['宝宝器官形成期，叶酸别停', '孕吐期少食多餐，清淡为主', `今日维C：${f}正当时`]
	}
	if (week < 28) {
		return ['补钙：每天300~500ml牛奶', `补铁：瘦牛肉配${f}促吸收`, 'DHA：每周吃2~3次深海鱼', '胎动明显了，静心感受一下']
	}
	return ['数胎动：早中晚各数1小时', '铁钙继续，甜食要节制', `${f}当季，每天200~350g就好`, '证件和待产包备好了吗']
}

export function buildPushContent(input) {
	const todayOrd = dayOrdinal(input && input.today)
	const lmpOrd = dayOrdinal(input && input.lmp)
	if (todayOrd === null || lmpOrd === null || todayOrd < lmpOrd) return null
	const days = todayOrd - lmpOrd
	const week = Math.floor(days / 7)
	const label = `孕${week}周+${days % 7}`

	// 主行：孕周 + 产检动态（与 buildTodayTip 同口径：过期 ≤14 天提醒补约，
	// 未来 7 天内倒计时；取调用方传入的最近一条 pending 产检）
	let main = label
	let event = null
	const cuOrd = dayOrdinal(input.nextCheckupDate)
	if (cuOrd !== null) {
		if (cuOrd === todayOrd) { main = `${label} · 今天产检`; event = 'today' }
		else if (cuOrd > todayOrd && cuOrd - todayOrd <= 7) { main = `${label} · 距产检${cuOrd - todayOrd}天`; event = 'countdown' }
		else if (cuOrd < todayOrd && todayOrd - cuOrd <= 14) { main = `${label} · 产检已过${todayOrd - cuOrd}天`; event = 'overdue' }
	}

	// 提示行：阶段池按天轮换；当季果名按月份取、按孕天数轮换挑一枚
	const month = monthOf(input.today)
	const fruits = (month && SEASONAL_FRUIT[month]) || []
	const fruit = fruits.length ? fruits[days % fruits.length] : ''
	const pool = notePool(week, fruit)
	const note = pool[((todayOrd % pool.length) + pool.length) % pool.length]

	// event：当天/倒计时/过期三态或 null——单内容字段模板（如 571 日程提醒）
	// 据此取舍：有事件用主行，平时用提示行
	return { main: clampText(main, 20), note: clampText(note, 20), event, week, days, month }
}
