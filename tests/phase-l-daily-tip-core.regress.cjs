// Phase L：今日提醒三级瀑布——共用核心 utils/dailyTipCore.js + DailyChanges 接入。
// 背景（2026-09-25 主页"太泛"改造）：静态 pregnancy-daily.json 280 天仅 84 条唯一
// tip、孕周错位、与个人数据零关联。瀑布=产检（当天/≤7天倒计时/过期≤14天补提醒）
// →家庭任务→null（组件回落静态）。dailyTipCore 为单源：客户端 vite 直引、云端
// mc-daily-push 经 assemble 转译投放，故本套件锁定可移植性契约（注释剥离后
// 零 import / 零平台依赖），防将来有人塞进 uni API 把云端转译炸掉。
// 组件手法沿用 phase-i bundleComponent 先例；日期一律相对今日（跨日必挂教训）。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-phase-l-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) {
  try { await fn(); pass(name) } catch (e) { fail(name, e) }
}
const tick = () => new Promise(r => setTimeout(r, 0))

// ── uni/getApp 契约 mock（DailyChanges→stores/health→utils/api 链加载期所需）──
const storageMap = new Map()
global.uni = {
  getStorageSync: k => (storageMap.has(k) ? storageMap.get(k) : ''),
  setStorageSync: (k, v) => storageMap.set(k, v),
  removeStorageSync: k => storageMap.delete(k),
  showToast: () => {},
  navigateTo: () => {},
  redirectTo: () => {},
  switchTab: () => {},
  showModal: o => { if (o && o.success) o.success({ confirm: true }) }
}
global.getApp = () => ({ globalData: { statusBarHeight: 42 } })

// ── 纯核心 bundle（ESM→CJS，与将来 assemble 转译投放同构）──
const coreFile = path.join(temp, 'dailyTipCore.cjs')
esbuild.buildSync({ entryPoints: [path.join(root, 'utils/dailyTipCore.js')], bundle: true, platform: 'node', format: 'cjs', outfile: coreFile, logLevel: 'silent' })
const { buildTodayTip, gestationalLabel, buildHealthNudge } = require(coreFile)

// ── 组件 bundle：编译宏替换为注入 props（phase-i 先例）──
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
  const outFile = path.join(temp, 'comp-' + path.basename(relPath, '.vue') + '-' + temp.length.toString(36) + '.cjs')
  esbuild.buildSync({ stdin: { contents: src, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: outFile, logLevel: 'silent' })
  delete require.cache[require.resolve(outFile)]
  return require(outFile)
}

// ── 相对今日的规整日期 ──
const NOW = new Date()
function dayOffset(n) { const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate()); d.setDate(d.getDate() + n); return d }
const TODAY = dayOffset(0)
const pad = n => String(n).padStart(2, '0')
function keyOf(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }

// 组件测试数据：5 天云端 slide（total_days 224-228，今日=226）
function cloudSlidesFixture() {
  return [224, 225, 226, 227, 228].map(t => ({
    total_days: t,
    baby_detail: `宝宝第${t}天`, mom_detail: `妈妈第${t}天`,
    tip_text: `静态文案${t}`
  }))
}
function dcBundle(todayTipLiteral) {
  return bundleComponent('components/home/DailyChanges.vue',
    `{ weekInfo: { week: 32, day: 2, total: 226 }, selectedDate: new Date(${TODAY.getTime()}), slidesData: ${JSON.stringify(cloudSlidesFixture())}, todayTip: ${todayTipLiteral} }`,
    ['slides'])
}

async function main() {
  console.log('phase-l：dailyTipCore 纯函数（共用核心）')
  await scenario('L1 当天产检：含标题/无标题两形态，tag=产检', async () => {
    const a = buildTodayTip({ today: TODAY, checkups: [{ date: keyOf(TODAY), title: '孕26周+2' }], tasks: [] })
    assert.equal(a.tag, '产检'); assert.equal(a.icon, '🏥')
    assert.equal(a.text, '今天产检 · 孕26周+2，带好证件和产检手册')
    const b = buildTodayTip({ today: keyOf(TODAY), checkups: [{ date: keyOf(TODAY) }], tasks: [] })
    assert.equal(b.text, '今天产检，带好证件和产检手册', '无标题不拼空 label')
  })

  await scenario('L2 倒计时：1/3/7 天含边界出、8 天窗口外不出', async () => {
    const d3 = buildTodayTip({ today: TODAY, checkups: [{ date: keyOf(dayOffset(3)), title: '糖筛' }], tasks: [] })
    assert.equal(d3.text, '距下次产检3天 · 糖筛')
    assert.ok(buildTodayTip({ today: TODAY, checkups: [{ date: keyOf(dayOffset(1)) }], tasks: [] }).text.includes('1天'))
    assert.ok(buildTodayTip({ today: TODAY, checkups: [{ date: keyOf(dayOffset(7)) }], tasks: [] }), '7 天含')
    assert.equal(buildTodayTip({ today: TODAY, checkups: [{ date: keyOf(dayOffset(8)) }], tasks: [] }), null, '8 天外')
  })

  await scenario('L3 过期补提醒：3 天出、14 天含边界出、15 天跳过（陈旧不唠叨）', async () => {
    const a = buildTodayTip({ today: TODAY, checkups: [{ date: keyOf(dayOffset(-3)) }], tasks: [] })
    assert.equal(a.text, '产检已过3天 · 记得补约或更新记录')
    assert.ok(buildTodayTip({ today: TODAY, checkups: [{ date: keyOf(dayOffset(-14)) }], tasks: [] }), '14 天含')
    const b = buildTodayTip({ today: TODAY, checkups: [{ date: keyOf(dayOffset(-15)) }], tasks: [{ title: '买待产包' }] })
    assert.equal(b.tag, '待办', '15 天过期跳过→任务兜底')
  })

  await scenario('L4 混合①：过期5天+未来20天 → 过期优先（可行动性压过远期倒计时）', async () => {
    const a = buildTodayTip({ today: TODAY, checkups: [{ date: keyOf(dayOffset(-5)) }, { date: keyOf(dayOffset(20)) }], tasks: [] })
    assert.ok(a.text.startsWith('产检已过5天'))
  })

  await scenario('L5 混合②：过期30天（陈旧跳过）+未来3天 → 倒计时', async () => {
    const a = buildTodayTip({ today: TODAY, checkups: [{ date: keyOf(dayOffset(-30)) }, { date: keyOf(dayOffset(3)) }], tasks: [] })
    assert.ok(a.text.startsWith('距下次产检3天'))
  })

  await scenario('L6 任务兜底：待办前缀+空标题跳选取下一个+24 字截断', async () => {
    const a = buildTodayTip({ today: TODAY, checkups: [], tasks: [{ title: '  ' }, { title: '陪她做糖筛' }] })
    assert.equal(a.tag, '待办'); assert.equal(a.text, '待办：陪她做糖筛')
    const long = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十'
    const b = buildTodayTip({ today: TODAY, checkups: [], tasks: [{ title: long }] })
    assert.equal(b.text, `待办：${long.slice(0, 24)}…`)
    assert.ok(b.text.length <= 28, '截断后总长受控')
  })

  await scenario('L7 空与非法输入：全空 null；非法 date 项被滤；today 非法 null', async () => {
    assert.equal(buildTodayTip({ today: TODAY }), null)
    assert.equal(buildTodayTip({ today: TODAY, checkups: [{ date: '不是日期' }, { date: keyOf(dayOffset(0)) }], tasks: [] }).text.includes('今天产检'), true, '坏项过滤后仍命中')
    assert.equal(buildTodayTip({ today: 'garbage', checkups: [{ date: keyOf(TODAY) }], tasks: [] }), null)
    assert.equal(buildTodayTip(), null, '无参防御')
  })

  await scenario('L8 today 双形态等价：Date 与 YYYY-MM-DD 同输出', async () => {
    const a = buildTodayTip({ today: TODAY, checkups: [{ date: keyOf(dayOffset(3)), title: 'NT' }], tasks: [] })
    const b = buildTodayTip({ today: keyOf(TODAY), checkups: [{ date: keyOf(dayOffset(3)), title: 'NT' }], tasks: [] })
    assert.deepEqual(a, b)
  })

  await scenario('L9 产检标题 16 字截断', async () => {
    const t = '一二三四五六七八九十一二三四五六七八九十'
    const a = buildTodayTip({ today: TODAY, checkups: [{ date: keyOf(dayOffset(2)), title: t }], tasks: [] })
    assert.ok(a.text.includes(t.slice(0, 16) + '…'), `实际：${a.text}`)
  })

  await scenario('L10 可移植性契约：注释剥离后零 import/require/平台依赖（云端转译前提）', async () => {
    const src = fs.readFileSync(path.join(root, 'utils/dailyTipCore.js'), 'utf8')
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    assert.ok(!/^\s*import\s/m.test(code), '不得有 import')
    assert.ok(!code.includes('require('), '不得有 require')
    for (const bad of ['uni.', 'wx.', 'process.', 'getApp', 'window.', 'document.']) {
      assert.ok(!code.includes(bad), `不得出现 ${bad}`)
    }
  })

  await scenario('L10b gestationalLabel：同日=孕0周+0、13天=孕1周+6、14天=孕2周+0 跨周边界', async () => {
    const lmp = keyOf(dayOffset(-100))
    assert.equal(gestationalLabel(lmp, keyOf(dayOffset(-100))), '孕0周+0')
    assert.equal(gestationalLabel(lmp, keyOf(dayOffset(-87))), '孕1周+6', '13 天')
    assert.equal(gestationalLabel(lmp, keyOf(dayOffset(-86))), '孕2周+0', '14 天整周界')
    assert.equal(gestationalLabel(lmp, keyOf(TODAY)), '孕14周+2', '100 天折算')
  })

  await scenario('L10c gestationalLabel 防御：早于 lmp 空/非法输入空/Date 与字符串等价', async () => {
    const lmp = keyOf(dayOffset(-100))
    assert.equal(gestationalLabel(lmp, keyOf(dayOffset(-101))), '', 'dateKey 早于 lmp')
    assert.equal(gestationalLabel('bad', keyOf(TODAY)), '', '非法 lmp')
    assert.equal(gestationalLabel(lmp, ''), '', '空 dateKey')
    assert.equal(gestationalLabel(lmp, keyOf(TODAY)), gestationalLabel(dayOffset(-100), TODAY), '双形态等价')
  })

  console.log('phase-l：DailyChanges 组件接入')
  await scenario('L11 todayTip 覆盖只作用今天屏：slides[2] 换文案带 tipTag，[1]/[3] 保持静态', async () => {
    const s = dcBundle(`{ tag: '产检', icon: '🏥', text: '距下次产检3天 · 糖筛' }`)
    const mid = s.slides.value[2]
    assert.equal(mid.tip.text, '距下次产检3天 · 糖筛')
    assert.equal(mid.tip.icon, '🏥')
    assert.equal(mid.tipTag, '产检')
    assert.equal(mid.baby.text, '宝宝第226天', '宝宝/妈妈栏不受影响')
    assert.equal(s.slides.value[1].tip.text, '静态文案225', '昨天屏静态')
    assert.equal(s.slides.value[3].tip.text, '静态文案227', '明天屏静态')
    assert.equal(s.slides.value[1].tipTag, undefined)
  })

  await scenario('L12 不传 todayTip：行为与旧版一致（静态 tip、无 tipTag）', async () => {
    const s = dcBundle('null')
    assert.equal(s.slides.value[2].tip.text, '静态文案226')
    assert.equal(s.slides.value[2].tipTag, undefined)
  })

  await scenario('L13 todayTip 无 text 不覆盖（防御：半成品数据回落静态）', async () => {
    const s = dcBundle(`{ tag: '产检', icon: '🏥' }`)
    assert.equal(s.slides.value[2].tip.text, '静态文案226')
    assert.equal(s.slides.value[2].tipTag, undefined)
  })

  await scenario('L14 静态降级分支同样过瀑布：slidesData 空 + todayTip 覆盖今天屏', async () => {
    const s = bundleComponent('components/home/DailyChanges.vue',
      `{ weekInfo: { week: 32, day: 2, total: 226 }, selectedDate: new Date(${TODAY.getTime()}), slidesData: [], todayTip: { tag: '待办', icon: '📝', text: '待办：陪她散步' } }`,
      ['slides'])
    assert.equal(s.slides.value[2].tip.text, '待办：陪她散步')
    assert.equal(s.slides.value[2].tipTag, '待办')
    assert.notEqual(s.slides.value[0].tip.text, '待办：陪她散步', '非今天屏不被覆盖')
  })

  await scenario('L15 index.vue 源码接线断言：两处 DailyChanges 均传 todayTip + 引入共用核心', async () => {
    const src = fs.readFileSync(path.join(root, 'pages/index/index.vue'), 'utf8')
    assert.ok(src.includes("from '@/utils/dailyTipCore.js'"), '引入共用核心')
    assert.equal((src.match(/:todayTip="todayTip"/g) || []).length, 2, 'family 与 demo 两处挂载')
    assert.ok(src.includes("MASKED_TASK_TITLE"), '撤回占位任务过滤在壳层')
    assert.ok(src.includes('gestationalLabel('), '孕周标签走共用核心')
    assert.ok(!src.includes('function checkupWeekLabel'), '折算不再内联页面（可测性规矩）')
  })

  await scenario('L16 DailyChanges 模板结构断言：来源标签渲染块锁定（模板层改动，phase-i 惯例）', async () => {
    const src = fs.readFileSync(path.join(root, 'components/home/DailyChanges.vue'), 'utf8')
    assert.ok(src.includes('v-if="slide.tipTag"'), 'tipTag 条件渲染在')
    assert.ok(src.includes('class="tip-tag"'), '标签样式类在')
    assert.ok(src.includes('.tip-tag-text'), '标签文字样式在')
  })

  console.log('phase-l：第三级健康温和提示（buildHealthNudge）')
  const rec = (dayAgo, o) => ({ date: keyOf(dayOffset(dayAgo)), ...o })
  await scenario('L17 血压单次偏高：今天 145/85 → 提示复测；正常/无记录不出', async () => {
    const a = buildHealthNudge({ today: TODAY, week: 20, records: [rec(-1, { systolic: 118, diastolic: 76 }), rec(0, { systolic: 145, diastolic: 85 })] })
    assert.equal(a.type, 'bp'); assert.ok(a.text.includes('再量一次'), a.text); assert.equal(a.tag, '健康')
    assert.equal(buildHealthNudge({ today: TODAY, week: 20, records: [rec(0, { systolic: 120, diastolic: 80 })] }), null, '正常不出')
    assert.equal(buildHealthNudge({ today: TODAY, week: 20, records: [] }), null, '无记录不出')
  })

  await scenario('L18 血压连续偏高优先：最近3次全高→产检沟通文案压过单次', async () => {
    const a = buildHealthNudge({ today: TODAY, week: 20, records: [
      rec(-2, { systolic: 142, diastolic: 88 }), rec(-1, { systolic: 150, diastolic: 92 }), rec(0, { systolic: 145, diastolic: 95 })
    ] })
    assert.ok(a.text.includes('连续偏高') && a.text.includes('医生'), a.text)
    // 3 次中夹一次正常 → 不算连续，走单次
    const b = buildHealthNudge({ today: TODAY, week: 20, records: [
      rec(-2, { systolic: 142, diastolic: 88 }), rec(-1, { systolic: 120, diastolic: 78 }), rec(0, { systolic: 145, diastolic: 95 })
    ] })
    assert.ok(b.text.includes('再量一次'), b.text)
  })

  await scenario('L19 血压时效：最新偏高在 4 天前 → 不提（过期不唠叨）', async () => {
    assert.equal(buildHealthNudge({ today: TODAY, week: 20, records: [rec(-4, { systolic: 150, diastolic: 95 })] }), null)
  })

  await scenario('L20 频控 3 天：昨日已提同类→静默；3 天前已提→恢复', async () => {
    const hi = [rec(0, { systolic: 150, diastolic: 95 })]
    assert.equal(buildHealthNudge({ today: TODAY, week: 20, records: hi, lastShown: { bp: keyOf(dayOffset(-1)) } }), null, '昨日已提')
    const ok2 = buildHealthNudge({ today: TODAY, week: 20, records: hi, lastShown: { bp: keyOf(dayOffset(-3)) } })
    assert.equal(ok2.type, 'bp', '3 天前已提→可再提')
  })

  await scenario('L21 体重周增：week20 涨0.9→提示含数值；涨0.3→不出；基线缺失→不出', async () => {
    const over = buildHealthNudge({ today: TODAY, week: 20, records: [rec(-7, { weightKg: 61.5 }), rec(0, { weightKg: 62.4 })] })
    assert.equal(over.type, 'weight'); assert.ok(over.text.includes('0.9'), over.text)
    assert.equal(buildHealthNudge({ today: TODAY, week: 20, records: [rec(-7, { weightKg: 62.1 }), rec(0, { weightKg: 62.4 })] }), null, '涨0.3不出')
    assert.equal(buildHealthNudge({ today: TODAY, week: 20, records: [rec(0, { weightKg: 62.4 })] }), null, '无基线不出')
  })

  await scenario('L22 体重孕早期不提：week10 涨1kg 也静默（参考线不适用）', async () => {
    assert.equal(buildHealthNudge({ today: TODAY, week: 10, records: [rec(-7, { weightKg: 60 }), rec(0, { weightKg: 61.2 })] }), null)
  })

  await scenario('L23 三级内优先级：血压偏高与体重超线同hit → 血压赢', async () => {
    const a = buildHealthNudge({ today: TODAY, week: 20, records: [
      rec(-7, { weightKg: 61.5 }), rec(0, { weightKg: 62.4, systolic: 150, diastolic: 95 })
    ] })
    assert.equal(a.type, 'bp')
  })

  await scenario('L24 index.vue 第三级接线：family 分支任务后接健康提示+storage 幂等持久化；demo 不参与', async () => {
    const src = fs.readFileSync(path.join(root, 'pages/index/index.vue'), 'utf8')
    assert.ok(src.includes('buildHealthNudge'), '引入共用核心')
    assert.ok(src.includes('HEALTH_NUDGE_KEY'), '频控持久化键')
    assert.ok(src.includes('collectFamilyHealthRecords'), 'family 记录归一')
    const start = src.indexOf('const todayTip')
    assert.ok(start >= 0, 'todayTip 计算块存在')
    const seg = src.slice(start, start + 4000)
    const iFam = seg.indexOf("dataMode.value === 'family'")
    const iNudge = seg.indexOf('buildHealthNudge')
    const iDemo = seg.indexOf("dataMode.value === 'demo'")
    assert.ok(iFam > -1 && iNudge > iFam && iNudge < iDemo, '健康提示位于 family 分支内、demo 分支前（三级瀑布位）')
  })

  console.log('phase-l：死代码清除与占位（2026-10-01 项2）')
  await scenario('L25 死代码清除契约：三块本地兜底与死导入不复存在（注释除外）', async () => {
    const src = fs.readFileSync(path.join(root, 'components/home/DailyChanges.vue'), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    for (const bad of ['MOCK_DATA', 'WEEKLY_CHANGES', 'FALLBACK', 'getSlideForDay', 'calcWeekInfo', 'getTrimesterName']) {
      assert.ok(!code.includes(bad), `死代码残留：${bad}`)
    }
    assert.ok(code.includes('PLACEHOLDER'), '诚实占位在位')
  })

  await scenario('L26 占位行为：slidesData 空→五屏占位；dayTotal<0 屏占位；瀑布覆盖不受影响', async () => {
    const s0 = bundleComponent('components/home/DailyChanges.vue',
      `{ weekInfo: { week: 1, day: 0, total: 7 }, selectedDate: new Date(${TODAY.getTime()}), slidesData: [], todayTip: null }`,
      ['slides'])
    assert.equal(s0.slides.value[2].tip.text, '当日内容待更新', '数据缺位→诚实占位')
    assert.equal(s0.slides.value[0].baby.text, '当日数据待更新', '孕0天前（total-2=5<7 周界内）逐屏取值正常')
    const s1 = bundleComponent('components/home/DailyChanges.vue',
      `{ weekInfo: { week: 0, day: 1, total: 1 }, selectedDate: new Date(${TODAY.getTime()}), slidesData: [{ total_days: 1, baby_detail: '宝宝D1', mom_detail: '妈妈D1', tip_text: '提示D1' }], todayTip: { tag: '待办', icon: '📝', text: '待办：散步' } }`,
      ['slides'])
    assert.equal(s1.slides.value[2].tip.text, '待办：散步', '今天屏瀑布覆盖仍生效')
    assert.equal(s1.slides.value[2].baby.text, '宝宝D1', '有数据屏不受占位影响')
    assert.equal(s1.slides.value[0].baby.text, '当日数据待更新', 'dayTotal=-1（孕前）→占位（原 MOCK_DATA 路径）')
  })

  console.log(`\nphase-l：${passed} 通过，${failed.length} 失败`)
  if (failed.length > 0) { console.log('失败场景：', failed.join(' | ')); process.exit(1) }
}

main().catch(e => { console.error(e); process.exit(1) })
