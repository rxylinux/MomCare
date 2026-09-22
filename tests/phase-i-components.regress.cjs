// Phase I 组件级回归：补齐 7 个零测试 .vue 组件的行为覆盖。
// 覆盖调研（2026-09-22）定案：bundlePage 剥 .vue import——组件从不随页面传递覆盖，
// 19 个零引用 .vue 中本套件吃下有逻辑的 7 个：
//   RecordEditSheet（历史 v-if 不渲染事故文件）/ DayRecordPanel / PregnancyCalendar
//   / DailyChanges / WeeklyGuideCard / DueCountdownRing / HomeHero
// 手法沿用 b2a 的 DayRecordEditSheet 先例：esbuild 打包真实 <script setup>，
// defineProps→reactive 注入 props、defineEmits→收集器；@/stores/health.js 孕周数学
// 走真实实现（周数/三档断言即是对 health.js 纯函数链的联动验证）。
// 模板交互入口（@tap=$emit）无法在本框架内行为化，用源码结构断言锁定（DP5/WC4）。
// 日期一律相对今日（跨日必挂教训）； PregnancyCalendar 月份几何用固定历史日期
// （纯 props 驱动、与真钟无关的分支）。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-phase-i-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) {
  try { await fn(); pass(name) } catch (e) { fail(name, e) }
}
const tick = () => new Promise(r => setTimeout(r, 0))

// ── uni/getApp 契约 mock（组件链 stores/health→utils/api 等加载期/点击期所需）──
const uniCalls = { toasts: [], navigations: [], switches: [] }
const storageMap = new Map()
global.uni = {
  getStorageSync: k => (storageMap.has(k) ? storageMap.get(k) : ''),
  setStorageSync: (k, v) => storageMap.set(k, v),
  removeStorageSync: k => storageMap.delete(k),
  showToast: o => uniCalls.toasts.push(o),
  navigateTo: o => uniCalls.navigations.push(o),
  redirectTo: o => uniCalls.navigations.push({ ...o, _redirect: true }),
  switchTab: o => uniCalls.switches.push(o),
  showModal: o => { if (o && o.success) o.success({ confirm: true }) }
}
global.getApp = () => ({ globalData: { statusBarHeight: 42 } })

// ── 组件 bundle：编译宏替换为注入 props / emit 收集器（零 vue 编译器依赖）──
// props 定义正则止于顶格 \n})——嵌套 default 都在行内/带缩进闭合，不会提前截断
// （b2a 教训：含嵌套 default 时非贪婪必须锚定顶格闭合）。替换后校验无残留宏。
function bundleComponent(relPath, propsLiteral, exportNames) {
  const vue = fs.readFileSync(path.join(root, relPath), 'utf8')
  let body = vue.match(/<script setup>([\s\S]*?)<\/script>/)[1]
  body = body
    .replace(/^import .* from ['"][^'"\n]+\.vue['"];?$/mg, '')
    .replace(/^import .* from ['"]@dcloudio\/uni-app['"];?$/mg, '')
    .replace(/const props = defineProps\(\{[\s\S]*?\n\}\)/, 'const props = reactive(__propsIn)')
    .replace(/const emit = defineEmits\(\[[^\]]*\]\)/, 'const emit = __emitCollector')
    .replace(/^defineEmits\(\[[^\]]*\]\)\n/m, '')
  if (/defineProps|defineEmits/.test(body)) throw new Error(`${relPath} 编译宏替换不完全`)
  const src = "import { reactive } from 'vue'\n"
    + 'const __propsIn = ' + propsLiteral + '\n'
    + 'const __emits = []\n'
    + 'const __emitCollector = (name, payload) => { __emits.push({ name, payload }) }\n'
    + body + '\n'
    + 'export { __propsIn, __emits, props as __props' + (exportNames.length ? ', ' + exportNames.join(', ') : '') + ' }\n'
  const outFile = path.join(temp, 'comp-' + path.basename(relPath, '.vue') + '.cjs')
  esbuild.buildSync({ stdin: { contents: src, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: outFile, logLevel: 'silent' })
  delete require.cache[require.resolve(outFile)]
  return require(outFile)
}

// ── 相对今日的规整日期（零时分秒，孕周数学不受时刻影响）──
const NOW = new Date()
function dayOffset(n) { const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate()); d.setDate(d.getDate() + n); return d }
const TODAY = dayOffset(0)

async function main() {
  // ══════════ RecordEditSheet（首页记录弹层——历史 v-if 不渲染事故文件）══════════
  const RES_EXPORTS = ['formData', 'showAddPlan', 'newPlanText', 'title', 'dateLabel', 'adjust', 'toggleSymptom', 'togglePlan', 'deletePlan', 'addPlan', 'cancelAddPlan', 'handleMaskTap', 'handleSave']
  // props 字面量拼接进 bundle 源码——必须自包含（TODAY/dayOffset 序列化为毫秒值）
  const resBundle = (record, mode = 'weight') => bundleComponent('components/home/RecordEditSheet.vue',
    `{ visible: false, mode: '${mode}', record: ${JSON.stringify(record)}, selectedDate: new Date(${TODAY.getTime()}), lmpDate: new Date(${dayOffset(-100).getTime()}) }`,
    RES_EXPORTS)

  await scenario('RES1 装载镜像：visible→true 预填全字段+bp 拆分+plans/symptoms 深拷贝隔离', async () => {
    const rec = { weight: '62.5', bp: '118/76', mood: '😄', symptoms: ['水肿'], fetal: '12', note: '感觉不错', plans: [{ text: '散步', done: true }] }
    const s = resBundle(rec)
    s.__props.visible = true
    await tick()
    const f = s.formData.value
    assert.equal(f.weight, '62.5')
    assert.equal(f.systolic, '118'); assert.equal(f.diastolic, '76')
    assert.equal(f.mood, '😄'); assert.deepEqual(f.symptoms, ['水肿'])
    assert.equal(f.fetal, '12'); assert.equal(f.note, '感觉不错')
    assert.deepEqual(f.plans, [{ text: '散步', done: true }])
    // 深拷贝：改弹层草稿不得回写父层 record（保存失败保留输入的前提是隔离）
    f.plans[0].done = false; f.symptoms.push('头痛')
    assert.equal(rec.plans[0].done, true, 'plans 深拷贝')
    assert.deepEqual(rec.symptoms, ['水肿'], 'symptoms 拷贝')
  })

  await scenario('RES2 空记录装载：字段空串/空数组，fetal 兜底 0', async () => {
    const s = resBundle({})
    s.__props.visible = true
    await tick()
    const f = s.formData.value
    assert.equal(f.weight, ''); assert.equal(f.systolic, ''); assert.equal(f.diastolic, '')
    assert.equal(f.mood, ''); assert.deepEqual(f.symptoms, []); assert.deepEqual(f.plans, [])
    assert.equal(f.fetal, '0', 'fetal 缺省 0（区别于空串——胎动零次是有效输入）')
  })

  await scenario('RES3 adjust 步进：weight 一位小数、fetal 整数、空值按 0 起点', async () => {
    const s = resBundle({}, 'weight')
    s.__props.visible = true
    await tick()
    s.adjust('weight', 0.1)
    assert.equal(s.formData.value.weight, '0.1', '空→+0.1')
    s.formData.value.weight = '62.5'
    s.adjust('weight', -0.1)
    assert.equal(s.formData.value.weight, '62.4')
    s.adjust('fetal', 1)
    assert.equal(s.formData.value.fetal, '1', 'fetal 空→+1 整数位')
    s.formData.value.fetal = '12'
    s.adjust('fetal', -1)
    assert.equal(s.formData.value.fetal, '11')
  })

  await scenario('RES4 toggleSymptom 增删互切', async () => {
    const s = resBundle({ symptoms: ['水肿'] }, 'daily')
    s.__props.visible = true
    await tick()
    s.toggleSymptom('失眠')
    assert.deepEqual(s.formData.value.symptoms, ['水肿', '失眠'], '追加')
    s.toggleSymptom('水肿')
    assert.deepEqual(s.formData.value.symptoms, ['失眠'], '移除已有')
    s.toggleSymptom('失眠')
    assert.deepEqual(s.formData.value.symptoms, [], '可清空')
  })

  await scenario('RES5 计划编辑三角：翻转/删除/有效添加/空文本不加/取消收起', async () => {
    const s = resBundle({ plans: [{ text: '产检', done: false }, { text: '散步', done: false }] }, 'note')
    s.__props.visible = true
    await tick()
    s.togglePlan(0)
    assert.equal(s.formData.value.plans[0].done, true, '勾选翻转')
    s.deletePlan(0)
    assert.deepEqual(s.formData.value.plans.map(p => p.text), ['散步'], '删除')
    s.showAddPlan.value = true
    s.newPlanText.value = '   '
    s.addPlan()
    assert.equal(s.formData.value.plans.length, 1, '空白文本不加')
    assert.equal(s.showAddPlan.value, true, '空白文本不收起输入行')
    s.cancelAddPlan()
    assert.equal(s.showAddPlan.value, false, '空文本取消→收起')
    s.showAddPlan.value = true
    s.newPlanText.value = ' 数胎动 '
    s.addPlan()
    assert.deepEqual(s.formData.value.plans.map(p => p.text), ['散步', '数胎动'], '有效文本 trim 后入列')
    assert.equal(s.newPlanText.value, '', '输入清空')
    assert.equal(s.showAddPlan.value, false, '收起输入行')
  })

  await scenario('RES6 handleSave 五模式载荷：bp 缺值不带键、note 含 plans 引用', async () => {
    // weight
    let s = resBundle({ weight: '63.2' }, 'weight')
    s.__props.visible = true; await tick()
    s.handleSave()
    assert.deepEqual(s.__emits.map(e => e.name), ['save'])
    assert.deepEqual(s.__emits[0].payload, { weight: '63.2' })
    // bp 完整
    s = resBundle({}, 'bp'); s.__props.visible = true; await tick()
    s.formData.value.systolic = '118'; s.formData.value.diastolic = '76'
    s.handleSave()
    assert.deepEqual(s.__emits[0].payload, { bp: '118/76' }, '拼回 a/b 形状')
    // bp 只有收缩压 → 不产出半截 bp
    s = resBundle({}, 'bp'); s.__props.visible = true; await tick()
    s.formData.value.systolic = '118'
    s.handleSave()
    assert.ok(!('bp' in s.__emits[0].payload), '缺舒张压不带 bp 键')
    // daily
    s = resBundle({ mood: '🙂', symptoms: ['失眠'] }, 'daily'); s.__props.visible = true; await tick()
    s.handleSave()
    assert.deepEqual(s.__emits[0].payload, { mood: '🙂', symptoms: ['失眠'] })
    // fetal
    s = resBundle({ fetal: '15' }, 'fetal'); s.__props.visible = true; await tick()
    s.handleSave()
    assert.deepEqual(s.__emits[0].payload, { fetal: '15' })
    // note
    s = resBundle({ note: '日记', plans: [{ text: '散步', done: false }] }, 'note'); s.__props.visible = true; await tick()
    s.handleSave()
    assert.equal(s.__emits[0].payload.note, '日记')
    assert.deepEqual(s.__emits[0].payload.plans, [{ text: '散步', done: false }])
  })

  await scenario('RES7 遮罩关闭 emit + dateLabel 真实孕周拼接/空日期兜底', async () => {
    const s = resBundle({}, 'weight')
    s.__props.selectedDate = TODAY // lmp=-100d → total 100 → 14 周 2 天
    s.handleMaskTap()
    assert.deepEqual(s.__emits, [{ name: 'update:visible', payload: false }], '遮罩→update:visible false')
    assert.equal(s.dateLabel.value, `${TODAY.getFullYear()}年${TODAY.getMonth() + 1}月${TODAY.getDate()}日 · 孕 14 周 2 天`)
    s.__props.selectedDate = null
    await tick()
    assert.equal(s.dateLabel.value, '', '未选日期→空标签')
  })

  await scenario('RES8 装载时机：watch 只盯 visible——record 中途变更不重置输入，重开才重装', async () => {
    const s = resBundle({ weight: '60' }, 'weight')
    s.__props.visible = true
    await tick()
    s.formData.value.weight = '61.5' // 用户改了草稿
    s.__props.record = { weight: '99' } // 父层换了 record 但弹层保持开
    await tick()
    assert.equal(s.formData.value.weight, '61.5', '开着的弹层不被父层 record 变更冲掉')
    s.__props.visible = false; await tick()
    s.__props.visible = true; await tick()
    assert.equal(s.formData.value.weight, '99', '重开按最新 record 装载')
  })

  // ══════════ DayRecordPanel（首页当日四卡+备注——周算联动）══════════
  const DRP_EXPORTS = ['isToday', 'dateLabel', 'weekInfo', 'trimesterKey', 'trimesterName', 'weekLabel']
  const drpBundle = (lmpOff, selOff) => bundleComponent('components/home/DayRecordPanel.vue',
    `{ selectedDate: new Date(${dayOffset(selOff).getTime()}), record: {}, lmpDate: new Date(${dayOffset(lmpOff).getTime()}) }`, DRP_EXPORTS)

  await scenario('DRP1 isToday 与 dateLabel', async () => {
    let s = drpBundle(-100, 0)
    assert.equal(s.isToday.value, true, '今天')
    assert.equal(s.dateLabel.value, `${TODAY.getMonth() + 1}月${TODAY.getDate()}日`)
    s = drpBundle(-101, -1)
    assert.equal(s.isToday.value, false, '昨天')
  })

  await scenario('DRP2 weekLabel 用真实孕周数学（lmp-100d → 孕 14 周 2 天）', async () => {
    const s = drpBundle(-100, 0)
    assert.deepEqual(s.weekInfo.value, { week: 14, day: 2, total: 100 })
    assert.equal(s.weekLabel.value, '孕 14 周 2 天 · 孕中期')
  })

  await scenario('DRP3 三档分界：第 12 周早期/13 周中期/28 周晚期（getTrimester 边界联动）', async () => {
    // 周数 = (sel-lmp)/7；用 7 的倍数落在边界两侧
    assert.equal(drpBundle(-12 * 7, 0).trimesterName.value, '孕早期', '12 周→早期')
    assert.equal(drpBundle(-13 * 7, 0).trimesterName.value, '孕中期', '13 周→中期')
    assert.equal(drpBundle(-27 * 7, 0).trimesterName.value, '孕中期', '27 周→中期')
    assert.equal(drpBundle(-28 * 7, 0).trimesterName.value, '孕晚期', '28 周→晚期')
  })

  await scenario('DRP4 lmp 之前：weekInfo null→trimesterKey 兜底 early、weekLabel 空', async () => {
    const s = drpBundle(0, -1)
    assert.equal(s.weekInfo.value, null, '负孕天数→null')
    assert.equal(s.trimesterKey.value, 'early')
    assert.equal(s.weekLabel.value, '')
  })

  await scenario('DRP5 模板交互入口齐全：五张卡片 @tap 各自 emit edit（结构断言防误删）', async () => {
    const tpl = fs.readFileSync(path.join(root, 'components/home/DayRecordPanel.vue'), 'utf8')
    for (const m of ['weight', 'bp', 'daily', 'fetal']) {
      assert.ok(tpl.includes(`$emit('edit', '${m}')`), `四卡 ${m} 编辑入口`)
    }
    assert.ok(tpl.includes(`$emit('edit', 'note')`), '备注卡入口')
    assert.ok(tpl.includes('ri-empty'), '未记录占位样式类在（空态展示）')
  })

  // ══════════ PregnancyCalendar（首页日历——月份几何/网格/选择）══════════
  const PC_EXPORTS = ['allMonths', 'currentMonthIndex', 'todayMonthIndex', 'viewYear', 'viewMonth', 'canPrev', 'canNext', 'monthTitle', 'monthSubtitle', 'gridCells', 'cellClasses', 'onSelectDate', 'prevMonth', 'nextMonth', 'jumpToday']
  // 固定历史区间（今天不在内——initMonthIndex 兜 0 可稳定断言；月份几何与真钟无关）
  const PC_LMP = new Date(2025, 10, 15) // 2025-11-15
  const PC_DUE = new Date(2026, 2, 1)   // 2026-03-01
  const pcBundle = (selected) => bundleComponent('components/common/PregnancyCalendar.vue',
    `{ lmpDate: new Date(2025, 10, 15), dueDate: new Date(2026, 2, 1), hasRecord: (d) => d.getDate() === 20, selectedDate: ${selected} }`, PC_EXPORTS)

  await scenario('PC1 allMonths 跨年枚举：2025-11 → 2026-03 共 5 个月，含 12 月→1 月进位', async () => {
    const s = pcBundle('null')
    assert.deepEqual(s.allMonths.value, [{ y: 2025, m: 10 }, { y: 2025, m: 11 }, { y: 2026, m: 0 }, { y: 2026, m: 1 }, { y: 2026, m: 2 }])
    assert.equal(s.todayMonthIndex.value, -1, '今天不在区间（固定历史区间前提）')
    assert.equal(s.currentMonthIndex.value, 0, '初始化兜首月')
    assert.equal(s.viewYear.value, 2025); assert.equal(s.viewMonth.value, 10)
  })

  await scenario('PC2 月份导航边界：首月禁回退/末月禁前进/jumpToday 兜回首月', async () => {
    const s = pcBundle('null')
    assert.equal(s.canPrev.value, false, '首月 canPrev false')
    assert.equal(s.canNext.value, true)
    s.prevMonth()
    assert.equal(s.currentMonthIndex.value, 0, '首月回退无效')
    s.nextMonth(); s.nextMonth(); s.nextMonth(); s.nextMonth()
    assert.equal(s.currentMonthIndex.value, 4)
    assert.equal(s.canNext.value, false, '末月 canNext false')
    assert.equal(s.viewYear.value, 2026); assert.equal(s.viewMonth.value, 2)
    s.nextMonth()
    assert.equal(s.currentMonthIndex.value, 4, '末月前进无效')
    s.jumpToday()
    assert.equal(s.currentMonthIndex.value, 0, 'jumpToday 区间外兜首月')
  })

  await scenario('PC3 monthTitle/monthSubtitle：真实周算出月首/月末周区间', async () => {
    const s = pcBundle('null')
    assert.equal(s.monthTitle.value, '2025年11月')
    // 11-01: (1-15)=-14 <14 天孕期 → 算 null？calcWeekInfo(15 号前)=null → subtitle 空
    // 11 月 1 日早于 lmp → w1=null → ''
    assert.equal(s.monthSubtitle.value, '', '首月月首早于 LMP→空副题')
    s.nextMonth() // 2025-12：1 日=孕 16 天(2w2d)，31 日=孕 46 天(6w4d)，15 日=孕 30 天(4w2d)→early
    assert.equal(s.monthTitle.value, '2025年12月')
    assert.equal(s.monthSubtitle.value, '孕早期 · 第 2–6 周')
  })

  await scenario('PC4 gridCells 几何：前置空格=月首星期、天数、LMP 前 dn-pre、hasRecord/isSelected 标记', async () => {
    const s = pcBundle('new Date(2025, 10, 20)')
    const cells = s.gridCells.value
    const leading = new Date(2025, 10, 1).getDay() // 2025-11-01 周六=6
    assert.equal(leading, 6)
    assert.equal(cells.filter(c => c.empty).length, leading, '前置空格数=月首星期序')
    const dayCells = cells.filter(c => !c.empty)
    assert.equal(dayCells.length, 30, '11 月 30 天')
    assert.equal(dayCells[0].day, 1)
    // LMP 前一日（11-14）dn-pre；无 weekInfo
    const d14 = dayCells.find(c => c.day === 14)
    assert.equal(d14.weekInfo, null); assert.ok(d14.dnClass.includes('dn-pre'), 'LMP 前 pre 样式')
    const d20 = dayCells.find(c => c.day === 20)
    assert.equal(d20.isSelected, true, '选中标记')
    assert.equal(d20.hasRecord, true, 'hasRecord 回调生效')
    const d21 = dayCells.find(c => c.day === 21)
    assert.equal(d21.isSelected, false); assert.equal(d21.hasRecord, false)
    const d15 = dayCells.find(c => c.day === 15)
    assert.deepEqual(d15.weekInfo, { week: 0, day: 0, total: 0 }, 'LMP 当日=孕 0 周 0 天')
    assert.ok(s.cellClasses(d15).includes('dc-ed'), 'cellClasses 早孕样式')
  })

  await scenario('PC5 onSelectDate：emit 归一化日期（时分秒清零）', async () => {
    const s = pcBundle('null')
    s.onSelectDate(new Date(2025, 10, 20, 18, 45, 30))
    assert.equal(s.__emits.length, 1)
    assert.equal(s.__emits[0].name, 'selectDate')
    const d = s.__emits[0].payload
    assert.equal(d.getFullYear(), 2025); assert.equal(d.getMonth(), 10); assert.equal(d.getDate(), 20)
    assert.equal(d.getHours() + d.getMinutes() + d.getSeconds(), 0, '归一化')
  })

  // ══════════ DailyChanges（首页每日变化轮播——偏移换算）══════════
  const DC_EXPORTS = ['currentIndex', 'offset', 'isCurrentToday', 'getDateByOffset', 'formatDate', 'navLabel', 'onSwiperChange']
  const dcBundle = (weekInfo) => bundleComponent('components/home/DailyChanges.vue',
    `{ weekInfo: ${JSON.stringify(weekInfo)}, selectedDate: new Date(${TODAY.getTime()}), slidesData: [] }`, DC_EXPORTS)

  await scenario('DC1 偏移基准：默认居中 idx2=今天，左移即非当日', async () => {
    const s = dcBundle({ week: 32, day: 3, total: 226 })
    assert.equal(s.currentIndex.value, 2)
    assert.equal(s.offset.value, 0)
    assert.equal(s.isCurrentToday.value, true)
    s.currentIndex.value = 1
    assert.equal(s.offset.value, -1); assert.equal(s.isCurrentToday.value, false)
  })

  await scenario('DC2 navLabel 周数换算：total±offset 折算周天、负值回退基线', async () => {
    const s = dcBundle({ week: 32, day: 2, total: 226 })
    assert.equal(s.navLabel.value, '孕 32 周 2 天', '226=32w2d')
    s.currentIndex.value = 4 // +2 → 228
    assert.equal(s.navLabel.value, '孕 32 周 4 天')
    s.currentIndex.value = 0 // -2 → 224
    assert.equal(s.navLabel.value, '孕 32 周 0 天')
    // total=1、offset=-2 → -1 <0 → 回退 props.weekInfo 的周天
    const s2 = dcBundle({ week: 0, day: 1, total: 1 })
    s2.currentIndex.value = 0
    assert.equal(s2.navLabel.value, '孕 0 周 1 天', '负折算回退')
  })

  await scenario('DC3 navLabel 跨周边界：70-1=孕 9 周 6 天（原 formatDateLabel 死函数已删，折算唯一权威=navLabel）', async () => {
    const s = dcBundle({ week: 10, day: 0, total: 70 })
    assert.equal(s.navLabel.value, '孕 10 周 0 天', '居中')
    s.currentIndex.value = 3
    assert.equal(s.navLabel.value, '孕 10 周 1 天', '右移一天')
    s.currentIndex.value = 1
    assert.equal(s.navLabel.value, '孕 9 周 6 天', '左移一天跨周边界')
  })

  await scenario('DC4 onSwiperChange 守卫：合法索引采纳、越界/非数忽略', async () => {
    const s = dcBundle({ week: 32, day: 3, total: 226 })
    s.onSwiperChange({ detail: { current: 0 } })
    assert.equal(s.currentIndex.value, 0)
    s.onSwiperChange({ detail: { current: 9 } })
    assert.equal(s.currentIndex.value, 0, '越界忽略')
    s.onSwiperChange({ detail: { current: 'x' } })
    assert.equal(s.currentIndex.value, 0, '非数忽略')
  })

  await scenario('DC5 selectedDate 变更→currentIndex 重置回今天', async () => {
    const s = dcBundle({ week: 32, day: 3, total: 226 })
    s.currentIndex.value = 0
    s.__props.selectedDate = dayOffset(-1)
    await tick()
    assert.equal(s.currentIndex.value, 2, '外部换日→回中')
  })

  // ══════════ WeeklyGuideCard（首页孕期指南卡）══════════
  const WC_EXPORTS = ['week', 'trimester', 'trimesterName', 'guideTitle', 'guideSubtitle', 'babyTags', 'momTags', 'handleTap']
  const wcBundle = (week, days) => bundleComponent('components/home/WeeklyGuideCard.vue',
    `{ weekInfo: { week: ${week}, day: 0, total: ${week * 7} }, daysUntilDue: ${days} }`, WC_EXPORTS)

  await scenario('WC1 guideTitle：0 周→加载中、25 周→第25周孕期指南', async () => {
    assert.equal(wcBundle(0, 100).guideTitle.value, '加载中...')
    assert.equal(wcBundle(25, 98).guideTitle.value, '第25周孕期指南')
  })

  await scenario('WC2 guideSubtitle：三档名+倒计时拼接', async () => {
    assert.equal(wcBundle(25, 98).guideSubtitle.value, '孕中期 · 距预产期还有98天')
    assert.equal(wcBundle(10, 200).guideSubtitle.value, '孕早期 · 距预产期还有200天')
    assert.equal(wcBundle(35, 35).guideSubtitle.value, '孕晚期 · 距预产期还有35天')
  })

  await scenario('WC3 babyTags/momTags 阈值分档（12/13、36/37 边界）', async () => {
    assert.deepEqual(wcBundle(12, 1).babyTags.value, ['👶 胚胎成形', '💓 心脏跳动'], '12 周→首档')
    assert.deepEqual(wcBundle(13, 1).babyTags.value, ['👶 骨骼发育', '👐 开始活动'], '13 周→次档')
    assert.deepEqual(wcBundle(36, 1).babyTags.value, ['👶 皮下脂肪', '🔄 胎位固定'], '36 周→待产档前')
    assert.deepEqual(wcBundle(37, 1).babyTags.value, ['👶 发育完成', '📦 准备出生'], '37 周→末档')
    assert.deepEqual(wcBundle(37, 1).momTags.value, ['🤰 随时待产', '🏥 准备入院'])
  })

  await scenario('WC4 handleTap 周数门控跳转：有周数→带参进指南页、0 周不跳', async () => {
    uniCalls.navigations.length = 0
    wcBundle(25, 98).handleTap()
    assert.equal(uniCalls.navigations.length, 1)
    assert.ok(uniCalls.navigations[0].url.includes('/pages/guide/weekly-guide?week=25'), '带周数跳转')
    uniCalls.navigations.length = 0
    wcBundle(0, 200).handleTap()
    assert.equal(uniCalls.navigations.length, 0, '0 周（未加载）不跳')
  })

  // ══════════ DueCountdownRing（预产期倒计时环）══════════
  const DR_EXPORTS = ['dueDateText', 'progressStyle']
  const drBundle = (pct) => bundleComponent('components/common/DueCountdownRing.vue',
    `{ daysUntilDue: 100, progressPercent: ${pct}, dueDate: new Date(2026, 11, 1) }`, DR_EXPORTS)

  await scenario('DR1 dueDateText：null→未设置、Date→Y年M月D日', async () => {
    assert.equal(drBundle(50).dueDateText.value, '2026年12月1日')
    const s = bundleComponent('components/common/DueCountdownRing.vue',
      '{ daysUntilDue: 100, progressPercent: 50, dueDate: null }', DR_EXPORTS)
    assert.equal(s.dueDateText.value, '未设置')
  })

  await scenario('DR2 progressStyle 角度换算：0/50/100%→0/180/360deg', async () => {
    // ' 0deg' 带前导空格——避免 '180deg'.includes('0deg') 子串歧义
    assert.ok(drBundle(0).progressStyle.value.background.includes(' 0deg'), '0%')
    assert.ok(drBundle(50).progressStyle.value.background.includes(' 180deg'), '50%')
    assert.ok(drBundle(100).progressStyle.value.background.includes(' 360deg'), '100%')
  })

  // ══════════ HomeHero（首页头部）══════════
  const HH_EXPORTS = ['statusBarHeight', 'trimesterLabel', 'babyWeight', 'babyLength', 'goSetup']
  const hhBundle = (week, pregSet) => bundleComponent('components/home/HomeHero.vue',
    `{ greeting: '早上好', weekInfo: { week: ${week}, day: 0, total: ${week * 7} }, daysUntilDue: 100, fruitComparison: { emoji: '🫘', name: '种子' }, pregInfoSet: ${pregSet} }`, HH_EXPORTS)

  await scenario('HH1 statusBarHeight 从 getApp().globalData 装载（真机状态栏高度）', async () => {
    assert.equal(hhBundle(20, true).statusBarHeight.value, 42)
  })

  await scenario('HH2 trimesterLabel：未设孕周→空、20 周→孕中期', async () => {
    assert.equal(hhBundle(0, true).trimesterLabel.value, '')
    assert.equal(hhBundle(20, true).trimesterLabel.value, '孕中期')
  })

  await scenario('HH3 babyWeight/babyLength：未填孕期资料→--、20 周→300g/25cm、无数据周→--', async () => {
    assert.equal(hhBundle(20, false).babyWeight.value, '--', '资料未填兜底')
    const s = hhBundle(20, true)
    assert.equal(s.babyWeight.value, '300g'); assert.equal(s.babyLength.value, '25cm')
    const s3 = hhBundle(3, true)
    assert.equal(s3.babyWeight.value, '--', '第 3 周无数据兜底')
  })

  await scenario('HH4 goSetup 引导跳转走 navigateToPage（onboarding 入口）', async () => {
    const before = uniCalls.navigations.length
    hhBundle(0, false).goSetup()
    assert.equal(uniCalls.navigations.length, before + 1)
    assert.ok(uniCalls.navigations[uniCalls.navigations.length - 1].url.includes('/pages/profile/onboarding'))
  })

  console.log(`\n${passed} 通过, ${failed.length} 失败`)
  if (failed.length) { console.log('失败场景：' + failed.join(' | ')); process.exit(1) }
}

main().catch(e => { console.error(e); process.exit(1) })
