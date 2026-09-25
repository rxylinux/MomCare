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
const { buildTodayTip, gestationalLabel } = require(coreFile)

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

  console.log(`\nphase-l：${passed} 通过，${failed.length} 失败`)
  if (failed.length > 0) { console.log('失败场景：', failed.join(' | ')); process.exit(1) }
}

main().catch(e => { console.error(e); process.exit(1) })
