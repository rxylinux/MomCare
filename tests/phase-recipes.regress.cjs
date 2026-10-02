// Phase RECIPES：孕期食谱功能契约（2026-10-02 实施方案 docs/RECIPE_FEATURE_SPEC_2026-10-02.md）。
// 覆盖：①数据 schema（92 道/段计数/枚举/非奶/excluded/bento/origin）②检索纯函数（阶段定位/列表/搜索）
// ③今日三餐确定性轮换（工作日带饭池/周末现做池/频率菜永不入选/营养覆盖/确定性）④页面结构 ⑤入口注册。
// 运行：node tests/phase-recipes.regress.cjs（仅本地静态数据与纯函数，不触真实 storage/云/网络）。
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }

const DATA = JSON.parse(fs.readFileSync(path.join(root, 'static/data/pregnancy-recipes.json'), 'utf8'))
const STAGE_KEYS = ['early', 'mid1', 'mid2', 'late1', 'late2']
const MEAL_KEYS = ['breakfast', 'lunch', 'dinner', 'snack']
const NUTRIENT_KEYS = ['folate', 'iodine', 'carb', 'calcium', 'protein', 'vita', 'vitd', 'iron', 'dha', 'zinc', 'glucose']
const EXCLUDED_NAMES = ['海带黄豆排骨汤', '凉拌海带丝', '早茶拼盘（虾饺/烧卖）', '猪肝菠菜汤', '猪肝瘦肉杂粮粥', '酸菜牛肉煲', '沙茶炒猪雪花', '酸咸菜炒梅花肉', '南乳煎焗排骨']
const USER_APPROVED = ['花菜炒大虾', '甜豆炒鱿鱼虾梅花肉', '葱油鸡', '豉汁蒸排骨', '生焗梅花肉', '蒜蓉豉汁焗鲈鱼', '芥末炒芥兰', '酸咸菜炒梅花肉', '黑胡椒牛肉杏鲍菇', '焗乳鸽', '鹿茸菇炒牛肉', '生焗排骨', '花菇炒猪颈肉', '花菇炒牛肉', '芦笋炒鸡腿肉', '客家酿豆腐', '青瓜炒梅花肉', '青瓜炒牛肉', '酸菜牛肉煲', '菠萝炒鸡腿肉', '南乳煎焗排骨', '木耳炒猪板筋', '油麦菜炒牛肉', '沙茶炒猪雪花', '杂菌菇炒猪颈肉']
const RECIPE_FIELDS = ['id', 'name', 'stages', 'mealType', 'nutrients', 'summary', 'ingredients', 'steps', 'nutritionNote', 'cautions', 'bentoFriendly', 'rotation', 'origin', 'source', 'sourceUrl', 'reviewedAt', 'version']

async function main() {
	// ── R1 数据 schema 契约 ──
	await scenario('R1a 结构：92 道/11 营养素/5 周段；id 唯一且 r-001~r-092', async () => {
		assert.equal(DATA.recipes.length, 92)
		assert.equal(DATA.nutrients.length, 11)
		assert.equal(DATA.stages.length, 5)
		const ids = DATA.recipes.map(r => r.id)
		assert.equal(new Set(ids).size, 92, 'id 唯一')
		assert.ok(ids.every(id => /^r-\d{3}$/.test(id)), 'id 格式')
	})
	await scenario('R1b 主归属段计数（stages[0]=草稿分组段）：早28/中1段20/中2段20/晚1段9/晚2段15', async () => {
		const home = {}
		for (const r of DATA.recipes) home[r.stages[0]] = (home[r.stages[0]] || 0) + 1
		assert.deepEqual(home, { early: 28, mid1: 20, mid2: 20, late1: 9, late2: 15 })
	})
	await scenario('R1c 字段与枚举：必填齐、无额外字段、stages/mealType/nutrients.key/rotation/origin 合法', async () => {
		for (const r of DATA.recipes) {
			for (const k of RECIPE_FIELDS) assert.ok(k in r, `${r.id} 缺 ${k}`)
			assert.deepEqual(Object.keys(r).sort(), RECIPE_FIELDS.slice().sort(), `${r.id} 字段集精确一致`)
			assert.ok(r.stages.length >= 1 && r.stages.every(s => STAGE_KEYS.includes(s)), `${r.id} stages 枚举`)
			assert.ok(r.mealType.length >= 1 && r.mealType.every(m => MEAL_KEYS.includes(m)), `${r.id} mealType 枚举`)
			assert.ok(['pool', 'excluded'].includes(r.rotation), `${r.id} rotation 枚举`)
			assert.ok(['user-approved', 'curated'].includes(r.origin), `${r.id} origin 枚举`)
			assert.equal(typeof r.bentoFriendly, 'boolean', `${r.id} bentoFriendly 布尔`)
			const primaries = r.nutrients.filter(n => n.weight === 'primary')
			assert.equal(primaries.length, 1, `${r.id} 恰 1 个 primary`)
			assert.ok(r.nutrients.every(n => NUTRIENT_KEYS.includes(n.key)), `${r.id} nutrients.key 枚举`)
			assert.ok(r.ingredients.length >= 1, `${r.id} ingredients 非空`)
			assert.ok(r.steps.length >= 2, `${r.id} steps ≥2`)
			assert.ok(Array.isArray(r.cautions), `${r.id} cautions 数组`)
			for (const field of ['name', 'summary', 'nutritionNote', 'source', 'reviewedAt', 'version']) {
				assert.ok(String(r[field] || '').trim(), `${r.id} ${field} 非空`)
			}
		}
	})
	await scenario('R1d 周段表：range 连续覆盖 1–40 无重叠；priority 引用闭合', async () => {
		let expect = 1
		for (const s of DATA.stages) {
			assert.equal(s.range[0], expect, `${s.key} 起点`)
			expect = s.range[1] + 1
			assert.equal(s.nutrientPriority.length, 3, `${s.key} 3 个优先营养`)
			assert.ok(s.nutrientPriority.every(k => NUTRIENT_KEYS.includes(k)), `${s.key} priority 枚举`)
		}
		assert.equal(expect, 41, '覆盖到 40 周')
	})
	await scenario('R1e 非奶铁律：92 道菜名与食材零奶制品', async () => {
		const DAIRY = ['牛奶', '酸奶', '奶酪', '黄油', '奶油', '芝士', '奶片', '鲜奶']
		const violations = []
		for (const r of DATA.recipes) {
			if (DAIRY.some(k => r.name.includes(k))) violations.push(r.id + ':name')
			for (const i of r.ingredients) if (DAIRY.some(k => i.name.includes(k))) violations.push(r.id + ':' + i.name)
		}
		assert.deepEqual(violations, [], '零奶制品')
	})
	await scenario('R1f rotation=excluded 恰 9 道且与审定清单一致；bentoFriendly 恰 15 道', async () => {
		const ex = DATA.recipes.filter(r => r.rotation === 'excluded').map(r => r.name).sort()
		assert.deepEqual(ex, EXCLUDED_NAMES.slice().sort())
		assert.equal(DATA.recipes.filter(r => r.bentoFriendly).length, 15)
		// excluded 集与 bento 集不相交（频率菜不该同时标带饭推荐）
		const both = DATA.recipes.filter(r => r.rotation === 'excluded' && r.bentoFriendly)
		assert.deepEqual(both, [], 'excluded 不进带饭推荐')
	})
	await scenario('R1g origin=user-approved 恰 25 道且与用户审定菜单一致', async () => {
		const ua = DATA.recipes.filter(r => r.origin === 'user-approved').map(r => r.name).sort()
		assert.deepEqual(ua, USER_APPROVED.slice().sort())
	})

	// ── R2/R3/R4/R5/R6：纯函数（esbuild 打包 toolsStore 后 require）──
	const bundle = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'momcare-recipes-')), 'core.cjs')
	esbuild.buildSync({
		stdin: {
			contents: `export { RECIPE_ENTRIES, RECIPE_NUTRIENTS, RECIPE_STAGES, getStageByWeek, getStageFocus, listRecipes, searchRecipes, buildDailyMeals } from './services/toolsStore.js'`,
			resolveDir: root
		},
		bundle: true, platform: 'node', format: 'cjs', alias: { '@': root },
		outfile: bundle, logLevel: 'silent'
	})
	const core = require(bundle)

	await scenario('R2 getStageByWeek 边界：clamp 与分段点', async () => {
		assert.equal(core.getStageByWeek(0), 'early')
		assert.equal(core.getStageByWeek(1), 'early')
		assert.equal(core.getStageByWeek(12), 'early')
		assert.equal(core.getStageByWeek(13), 'mid1')
		assert.equal(core.getStageByWeek(19), 'mid1')
		assert.equal(core.getStageByWeek(20), 'mid2')
		assert.equal(core.getStageByWeek(27), 'mid2')
		assert.equal(core.getStageByWeek(28), 'late1')
		assert.equal(core.getStageByWeek(35), 'late1')
		assert.equal(core.getStageByWeek(36), 'late2')
		assert.equal(core.getStageByWeek(40), 'late2')
		assert.equal(core.getStageByWeek(45), 'late2', '越界 clamp 40')
		assert.equal(core.getStageByWeek(NaN), 'early', '非法数按 1')
	})
	await scenario('R3 getStageFocus：5 段均返回 stage+3 个营养素对象且顺序=priority', async () => {
		for (const s of DATA.stages) {
			const f = core.getStageFocus(s.key)
			assert.ok(f && f.stage.key === s.key)
			assert.deepEqual(f.nutrients.map(n => n.key), s.nutrientPriority)
			assert.ok(f.nutrients.every(n => n.foodGuide && n.reference), `${s.key} 胶囊条目含食物量口径与参考量`)
		}
		assert.equal(core.getStageFocus('nope'), null)
	})
	await scenario('R4 listRecipes 段计数（含跨段菜）：早30/中1段34/中2段34/晚1段32/晚2段28；不传=92', async () => {
		const expect = { early: 30, mid1: 34, mid2: 34, late1: 32, late2: 28 }
		for (const k of STAGE_KEYS) assert.equal(core.listRecipes(k).length, expect[k], k)
		assert.equal(core.listRecipes().length, 92)
	})
	await scenario('R5 searchRecipes：命中/未命中/带饭筛选/营养筛选/段筛选', async () => {
		assert.ok(core.searchRecipes({ keyword: '豆腐' }).length >= 5, '豆腐命中多道')
		assert.ok(core.searchRecipes({ keyword: '鲈鱼' }).every(r => r.name.includes('鲈鱼') || r.ingredients.some(i => i.name.includes('鲈鱼'))), '命中项含关键词')
		assert.deepEqual(core.searchRecipes({ keyword: '不存在的菜' }), [], '未命中返回空数组')
		assert.ok(core.searchRecipes({ bentoOnly: true }).every(r => r.bentoFriendly), 'bentoOnly 全部可带饭')
		assert.ok(core.searchRecipes({ nutrientKey: 'iron' }).every(r => r.nutrients.some(n => n.key === 'iron')), 'iron 筛选')
		assert.ok(core.searchRecipes({ stageKey: 'early' }).every(r => r.stages.includes('early')), '段筛选')
		// 大小写与食材命中
		assert.ok(core.searchRecipes({ keyword: '牛里脊' }).length >= 1, '按食材命中')
	})

	await scenario('R6a 确定性：同参数两次调用四餐 deepEqual；非法 dateKey 也不抛', async () => {
		const a = core.buildDailyMeals({ dateKey: '2026-10-02', week: 23, weekday: 5 })
		const b = core.buildDailyMeals({ dateKey: '2026-10-02', week: 23, weekday: 5 })
		assert.deepEqual(a, b)
		core.buildDailyMeals({ dateKey: '', week: NaN, weekday: 9 }) // 不抛即过
	})
	await scenario('R6b 段定位与 mode：week=23 → mid2；weekday 0/6=weekend', async () => {
		assert.equal(core.buildDailyMeals({ dateKey: '2026-10-02', week: 23, weekday: 5 }).stageKey, 'mid2')
		assert.equal(core.buildDailyMeals({ dateKey: '2026-10-02', week: 23, weekday: 5 }).mode, 'weekday')
		assert.equal(core.buildDailyMeals({ dateKey: '2026-10-02', week: 23, weekday: 0 }).mode, 'weekend')
		assert.equal(core.buildDailyMeals({ dateKey: '2026-10-02', week: 23, weekday: 6 }).mode, 'weekend')
	})
	await scenario('R6c 频率受限菜永不入选：5 段 × 60 天 × 工作日/周末 全枚举零出现', async () => {
		const excludedIds = new Set(DATA.recipes.filter(r => r.rotation === 'excluded').map(r => r.id))
		for (const week of [5, 15, 23, 30, 38]) {
			for (let d = 0; d < 60; d++) {
				for (const wd of [1, 6]) {
					const dateKey = `2026-${String(Math.floor(d / 28) + 1).padStart(2, '0')}-${String(d % 28 + 1).padStart(2, '0')}`
					const m = core.buildDailyMeals({ dateKey, week, weekday: wd })
					for (const slot of ['breakfast', 'lunch', 'dinner', 'snack']) {
						if (m[slot]) assert.ok(!excludedIds.has(m[slot].id), `excluded 入选 ${m[slot].id} @${dateKey}/${week}/${wd}`)
					}
				}
			}
		}
	})
	await scenario('R6d 工作日午餐走带饭友好池（early 段无带饭菜回退全池不空）', async () => {
		for (const week of [15, 23, 30, 38]) { // mid1 起
			for (let d = 1; d <= 28; d++) {
				const dateKey = `2026-10-${String(d).padStart(2, '0')}`
				const m = core.buildDailyMeals({ dateKey, week, weekday: 2 })
				assert.ok(m.lunch, `${week} 周午餐非空`)
				assert.equal(m.lunch.bentoFriendly, true, `${week} 周工作日午餐=${m.lunch.name} 应带饭友好`)
			}
		}
		const early = core.buildDailyMeals({ dateKey: '2026-10-02', week: 5, weekday: 2 })
		assert.ok(early.lunch, 'early 段回退全池午餐非空（口径如实展示）')
	})
	await scenario('R6e 周末午餐开鲜货池：mid2 段 60 个周末样本中至少出现非带饭菜', async () => {
		const seenNonBento = []
		for (let d = 1; d <= 30; d++) {
			for (const wd of [0, 6]) {
				const m = core.buildDailyMeals({ dateKey: `2026-10-${String(d).padStart(2, '0')}`, week: 23, weekday: wd })
				if (m.lunch && !m.lunch.bentoFriendly) seenNonBento.push(m.lunch.name)
			}
		}
		assert.ok(seenNonBento.length > 0, '周末午餐池确实扩大到现做菜')
	})
	await scenario('R6f 营养覆盖：mid2 午餐 primary=iron、晚餐 primary=dha（focus 池非空段全 seed 命中）', async () => {
		for (let d = 1; d <= 28; d++) {
			const m = core.buildDailyMeals({ dateKey: `2026-10-${String(d).padStart(2, '0')}`, week: 23, weekday: 3 })
			assert.equal(m.lunch.nutrients.find(n => n.weight === 'primary').key, 'iron', `day${d} 午餐主营养=iron`)
			assert.equal(m.dinner.nutrients.find(n => n.weight === 'primary').key, 'dha', `day${d} 晚餐主营养=dha`)
			assert.ok(m.focusTags.includes('iron') && m.focusTags.includes('dha'), 'focusTags 披露')
		}
	})
	await scenario('R6g 晚餐≠午餐；换一组偏移生效且不落盘语义（同参两次仍确定）', async () => {
		for (let d = 1; d <= 28; d++) {
			const m = core.buildDailyMeals({ dateKey: `2026-10-${String(d).padStart(2, '0')}`, week: 23, weekday: 4 })
			assert.notEqual(m.dinner.id, m.lunch.id, `day${d} 午晚餐不重样`)
		}
		const base = core.buildDailyMeals({ dateKey: '2026-10-02', week: 23, weekday: 4 })
		const alt = core.buildDailyMeals({ dateKey: '2026-10-02', week: 23, weekday: 4, shuffleOffset: 1 })
		const alt2 = core.buildDailyMeals({ dateKey: '2026-10-02', week: 23, weekday: 4, shuffleOffset: 1 })
		assert.deepEqual(alt, alt2, '偏移后仍确定')
		const names = s => [s.breakfast && s.breakfast.id, s.lunch && s.lunch.id, s.dinner && s.dinner.id, s.snack && s.snack.id].join(',')
		assert.notEqual(names(base), names(alt), '换一组产生不同组合')
	})

	// ── R7 页面结构断言（渲染壳关键元素在位；逻辑已全部收在可测纯函数区）──
	await scenario('R7 recipes.vue：阶段卡/今日三餐/营养胶囊/分组列表/空态/免责声明/手动切换防覆盖', async () => {
		const vue = fs.readFileSync(path.join(root, 'pages/tools/recipes.vue'), 'utf8')
		for (const frag of ['今日三餐', 'stage-switch', 'nutrient-pill', 'foodGuide', '换一组', '未收录此菜品', 'footer-disclaimer', 'setStage', 'manualStage', 'buildDailyMeals', '工作日 · 午餐带饭友好', '周末 · 现做鲜货']) {
			assert.ok(vue.includes(frag), `页面缺关键结构：${frag}`)
		}
	})
	await scenario('R8 入口注册：pages.json 路由 + 首页 TOOL_ENTRIES 第 5 项', async () => {
		const pj = JSON.parse(fs.readFileSync(path.join(root, 'pages.json'), 'utf8'))
		assert.ok(pj.pages.some(p => p.path === 'pages/tools/recipes' && p.style.navigationBarTitleText === '孕期食谱'), 'pages.json 注册')
		const idx = fs.readFileSync(path.join(root, 'pages/index/index.vue'), 'utf8')
		assert.ok(idx.includes("name: '孕期食谱'") && idx.includes('/pages/tools/recipes'), 'TOOL_ENTRIES 入口')
	})

	console.log(`\n通过 ${passed} / 失败 ${failed.length}`)
	if (failed.length) { console.log('失败项:', failed.join(' | ')); process.exit(1) }
	process.exit(0)
}

main().catch(e => { console.error('FATAL', e); process.exit(1) })
