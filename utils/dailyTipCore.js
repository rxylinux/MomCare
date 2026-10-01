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

// ── 内容库 v2（2026-10-01 用户审定 docs/content-library-draft.md）──
// 12 个周段 × 5 条（草稿原文照录）；孕 1~3 周为草稿未覆盖段，实施时补 4 条
// 同风格词条（可随时改）。首页静态库（pregnancy-daily.json tip 列）由
// scripts/gen-daily-content.mjs 从本表生成——单一作者源，两端不漂移。
const STAGE_TIPS = [
	{ from: 1, to: 3, tips: ['记下末次月经，孕周才准', '叶酸每天 0.4mg 别断', '远离烟酒和二手烟', '早孕试纸两条杠，恭喜'] },
	{ from: 4, to: 6, tips: ['宝宝小心脏开始跳动了', '孕吐来了就少食多餐', '叶酸每天 0.4mg 别断', '疲惫嗜睡是正常反应', '记下末次月经，孕周才准'] },
	{ from: 7, to: 10, tips: ['宝宝五官四肢成形中', '远离烟酒和二手烟', '生姜水可能缓解恶心', '换宽松衣物，乳房在胀', '恶心重时小口喝温水'] },
	{ from: 11, to: 13, tips: ['NT 检查窗口期是 11-13 周', '该建档了，证件带齐', '孕吐退潮，食欲回归', '口腔问题趁现在处理', '和亲友分享好消息吧'] },
	{ from: 14, to: 17, tips: ['舒适期来了，出门走走', '开始显怀，拍张照留念', '每天牛奶 300~500ml', '唐筛/无创的时间窗到了', '凯格尔运动可以开始'] },
	{ from: 18, to: 21, tips: ['第一次胎动像小鱼吐泡', '记下第一次胎动日期', '侧卧时枕头垫住肚子', 'DHA：每周 2~3 次深海鱼', '大排畸 B 超该预约了'] },
	{ from: 22, to: 24, tips: ['糖耐检查要空腹，别忘', '腿抽筋就睡前拉伸小腿', '甜食收一收，血糖要稳', '每周涨 0.5kg 内为宜', '胎动规律了，感受节奏'] },
	{ from: 25, to: 27, tips: ['睡不好？孕妇枕上场', '假性宫缩偶发是正常', '想好宝宝小名了吗', '待产包清单可以起草', '铁需求高峰，瘦红肉加量'] },
	{ from: 28, to: 30, tips: ['孕晚期了，产检加密', '数胎动：早中晚各 1 小时', '胎动明显减少要告诉医生', '气短就左侧卧歇歇', '开始准备哺乳用品'] },
	{ from: 31, to: 33, tips: ['假宫缩变多，学会分辨', '宝宝长肉快，蛋白跟上', '骨盆痛就换低跟鞋', '确认去医院的路线', '母乳知识提前看看'] },
	{ from: 34, to: 36, tips: ['产检改成每周一次', '多数宝宝已经头朝下', '入盆后呼吸轻松些', '证件资料集中一个包', '学一学拉玛泽呼吸'] },
	{ from: 37, to: 38, tips: ['足月了，随时可能发动', '宫缩 5-6 分钟一次就出发', '见红别慌，先观察量', '破水立刻平躺去医院', '手机充满电，随时待命'] },
	{ from: 39, to: 40, tips: ['预产期到别急，留量给 41 周', '三信号：宫缩/破水/见红', '适度散步，有助顺产', '待产包装车了吗', '快见面了，加油'] }
]

export function stageTipsForWeek(week) {
	if (week < 1) return STAGE_TIPS[0].tips
	const seg = STAGE_TIPS.find(s => week >= s.from && week <= s.to)
	return (seg || STAGE_TIPS[STAGE_TIPS.length - 1]).tips
}

// 提示行候选池 = 周段词条 + 水果组合（当季果名按月填入；补铁组合孕中期起适用）
function notePool(week, fruit) {
	const f = fruit || '当季水果'
	const pool = [...stageTipsForWeek(week)]
	pool.push(`今日维C：${f}正当时`)
	if (week >= 13) pool.push(`补铁：瘦牛肉配${f}促吸收`)
	pool.push(`${f}当季，每天200~350g就好`)
	return pool
}

export function buildPushContent(input) {
	const todayOrd = dayOrdinal(input && input.today)
	const lmpOrd = dayOrdinal(input && input.lmp)
	if (todayOrd === null || lmpOrd === null || todayOrd < lmpOrd) return null
	const days = todayOrd - lmpOrd
	const week = Math.floor(days / 7)
	const label = `孕${week}周+${days % 7}`

	// 主行：孕周 + 产检动态。产检相关只保留"当天"与"过期≤14天补提醒"两态——
	// 2~7 天倒计时已按用户 2026-10-01 裁定移除（前夜 21:30 触发器已覆盖提前提醒，
	// 每天报倒计时只会挤掉提示行）；未到/远期一律回落普通日（显示提示行）。
	// 注意：首页瀑布 buildTodayTip 仍保留 7 天倒计时（用户裁定两端口径不同）。
	let main = label
	let event = null
	const cuOrd = dayOrdinal(input.nextCheckupDate)
	if (cuOrd !== null) {
		if (cuOrd === todayOrd) { main = `${label} · 今天产检`; event = 'today' }
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

// 产检前夜提醒（mc-daily-push 21:30 触发器消费）：最近一条 pending 产检恰为
// "明天"时返回提醒内容，其余情况一律 null（前夜触发器安静退出，不 nightly 骚扰）。
// 日期字段建议填产检当日（调用方取 nextCheckupDate）。
export function buildEveReminder(input) {
	const todayOrd = dayOrdinal(input && input.today)
	const lmpOrd = dayOrdinal(input && input.lmp)
	const cuOrd = dayOrdinal(input && input.nextCheckupDate)
	if (todayOrd === null || lmpOrd === null || cuOrd === null) return null
	if (cuOrd !== todayOrd + 1) return null
	const days = todayOrd - lmpOrd
	if (days < 0) return null
	const label = `孕${Math.floor(days / 7)}周+${days % 7}`
	// event:'eve' 与 buildPushContent 同构——发送侧"有事件用主行"的取舍直接命中
	return { main: clampText(`${label} · 明天产检，证件备好`, 20), event: 'eve' }
}

// ══ 第三级：健康温和提示（仅主页瀑布消费；刻意不进 9 点推送——锁屏场景只有══
// ══ 焦虑无行动语境，且"监督感"会伤订阅授权信任，2026-09-30 与用户对齐）══
// 口径（用户 2026-09-30 拍板）：
// - 血压偏高 = 收缩压 ≥140 或舒张压 ≥90（医学常见分界）；只看最近 3 天内的
//   最新一次测量（更早的过期不提）；最近 3 次测量全部偏高 → 升级为"连续偏高，
//   产检时告诉医生"（优先于单次）。
// - 体重 = 孕中晚期（≥13 周）适用：最新体重（2 天内）与 6~8 天前基线之差
//   >0.5kg 触发；孕早期不提（周增参考线不适用）。
// - 防唠叨：同类提示 3 天内只出现一次（lastShown 由调用方持久化）。
// 边界（设计红线）：不诊断、不说"危险"、只引导复测与产检沟通。
export function buildHealthNudge({ records, today, week, lastShown } = {}) {
	const todayOrd = dayOrdinal(today)
	if (todayOrd === null) return null
	const shownRecently = type => {
		const o = dayOrdinal(lastShown && lastShown[type])
		return o !== null && todayOrd - o < 3
	}
	const list = (Array.isArray(records) ? records : [])
		.map(r => ({ ord: dayOrdinal(r && r.date), s: r && r.systolic, d: r && r.diastolic, w: r && r.weightKg }))
		.filter(r => r.ord !== null)
		.sort((a, b) => a.ord - b.ord)

	// 血压：优先级 连续偏高 > 单次偏高
	if (!shownRecently('bp')) {
		const bpList = list.filter(r => r.s != null && r.d != null)
		const latest = bpList[bpList.length - 1]
		const isHigh = r => Number(r.s) >= 140 || Number(r.d) >= 90
		if (latest && todayOrd - latest.ord <= 3) {
			const recent3 = bpList.slice(-3)
			if (recent3.length === 3 && recent3.every(isHigh)) {
				return { type: 'bp', tag: '健康', icon: '❤️', text: '血压连续偏高，产检时记得告诉医生' }
			}
			if (isHigh(latest)) {
				return { type: 'bp', tag: '健康', icon: '❤️', text: '血压偏高，晚上再量一次看看' }
			}
		}
	}

	// 体重：孕中晚期，最新 vs 6~8 天前基线
	if (week >= 13 && !shownRecently('weight')) {
		const withW = list.filter(r => r.w != null)
		const last = withW[withW.length - 1]
		if (last && todayOrd - last.ord <= 2) {
			const base = [...withW].reverse().find(r => last.ord - r.ord >= 6 && last.ord - r.ord <= 8)
			if (base) {
				const gain = Number(last.w) - Number(base.w)
				if (gain > 0.5) {
					return { type: 'weight', tag: '健康', icon: '⚖️', text: `这周体重涨了${gain.toFixed(1)}kg，甜食先收一收` }
				}
			}
		}
	}

	return null
}
