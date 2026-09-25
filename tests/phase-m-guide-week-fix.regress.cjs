// Phase M：孕期指南页周条定位与诚实兜底修复（真机缺陷：孕5周进入标题对、
// 周条停在孕32一带且当前周高亮在屏外）。
// 根因三件套：①currentWeek 写死演示假默认 32——首次渲染瞬间周条按 32 滚动+高亮，
// 参数纠正后高亮移走但 scroll-into-view 不再可靠触发；②scroll-into-view 首渲染
// 即带值不可靠（微信端要布局完成后触发）；③本地兜底 GUIDE_DATA 仅覆盖 30-40 周，
// closest 初值取首键——30 周以前静默展示孕 30 周内容（不诚实冒充）。
// 修复：ref(0) 未就绪态+参数裁剪 1-40；scrollTarget 空→onReady/切周清空再赋值；
// 兜底覆盖外返回 null 走"暂未收录"空态。
// 测试手法：扩展 phase-i bundleComponent——页面无 defineProps，@dcloudio/uni-app
// 导入替换为生命周期捕获桩（onLoad/onReady 回调存入 __lifecycle 由测试驱动），
// pinia 预激活；页面真数据链（staticData→pregnancy-weekly-guide.json 1-40 全周）走真实实现。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-phase-m-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) {
  try { await fn(); pass(name) } catch (e) { fail(name, e) }
}
const tick = () => new Promise(r => setTimeout(r, 0))

// uni 契约 mock（goBack 点击期才用；链上模块加载防御）
global.uni = { navigateBack: () => {}, showToast: () => {}, navigateTo: () => {} }
global.getApp = () => ({ globalData: {} })

let bundleSeq = 0
function bundlePage(exportNames) {
  const vue = fs.readFileSync(path.join(root, 'pages/guide/weekly-guide.vue'), 'utf8')
  let body = vue.match(/<script setup>([\s\S]*?)<\/script>/)[1]
  body = body.replace(/^import \{ onLoad, onReady \} from ['"]@dcloudio\/uni-app['"];?$/m,
    'const onLoad = cb => { __lifecycle.onLoad = cb }\nconst onReady = cb => { __lifecycle.onReady = cb }')
  if (body.includes('@dcloudio')) throw new Error('uni-app 导入替换不完全')
  const src = "import { createPinia, setActivePinia } from 'pinia'\n"
    + 'setActivePinia(createPinia())\n'
    + 'const __lifecycle = {}\n'
    + body + '\n'
    + 'export { __lifecycle' + (exportNames.length ? ', ' + exportNames.join(', ') : '') + ' }\n'
  const outFile = path.join(temp, `weekly-guide-${++bundleSeq}.cjs`)
  esbuild.buildSync({ stdin: { contents: src, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: outFile, logLevel: 'silent' })
  delete require.cache[require.resolve(outFile)]
  return require(outFile)
}

const EXPORTS = ['currentWeek', 'scrollTarget', 'cloudData', 'guideData', 'heroTitle', 'heroSubtitle', 'selectWeek', 'loadError']
const settle = async () => { await tick(); await tick(); await tick() }

async function main() {
  await scenario('M1 参数直达+就绪后定位：week=5 → 标题孕5周、scrollTarget 首渲染为空、onReady 后=week-5、正文为第5周真内容', async () => {
    const p = bundlePage(EXPORTS)
    p.__lifecycle.onLoad({ week: '5' })
    assert.equal(p.currentWeek.value, 5)
    assert.equal(p.scrollTarget.value, '', '首渲染不抢跑定位')
    p.__lifecycle.onReady()
    await settle()
    assert.equal(p.scrollTarget.value, 'week-5', '布局完成后定位到真实孕周')
    assert.equal(p.heroTitle.value, '孕 5 周完整指南')
    await settle()
    assert.ok(p.cloudData.value, '静态数据第5周加载成功（1-40 全周覆盖）')
    assert.ok(p.guideData.value && p.guideData.value.babyWeight, '正文走第5周真内容')
    assert.ok(!p.loadError.value)
  })

  await scenario('M2 无参/垃圾参/越界：不再落到假默认 32，而是未就绪 0 + 诚实标题', async () => {
    const a = bundlePage(EXPORTS)
    a.__lifecycle.onLoad({})
    assert.equal(a.currentWeek.value, 0, '无参=未就绪')
    const b = bundlePage(EXPORTS)
    b.__lifecycle.onLoad({ week: 'abc' })
    assert.equal(b.currentWeek.value, 0, '非法参拒收')
    const c = bundlePage(EXPORTS)
    c.__lifecycle.onLoad({ week: '41' })
    assert.equal(c.currentWeek.value, 0, '越界裁剪')
    assert.equal(c.heroTitle.value, '孕期指南')
    assert.equal(c.heroSubtitle.value, '选择孕周查看对应指南', '副标题不编造孕30/32数据')
    assert.equal(c.guideData.value, null, '未就绪无兜底内容')
  })

  await scenario('M3 本地兜底诚实边界：cloudData 缺失时 29 周→null（不再孕30冒充）、30 周→命中本地', async () => {
    const p = bundlePage(EXPORTS)
    p.__lifecycle.onLoad({ week: '29' })
    await settle()
    p.cloudData.value = null // 强制走本地兜底分支
    assert.equal(p.guideData.value, null, '29 周在本地覆盖(30-40)之外→诚实空')
    p.currentWeek.value = 30
    await settle()
    p.cloudData.value = null
    assert.ok(p.guideData.value && p.guideData.value.babyWeight, '30 周命中本地兜底')
  })

  await scenario('M4 切周联动：selectWeek(7) → scrollTarget 清空再定位 week-7', async () => {
    const p = bundlePage(EXPORTS)
    p.__lifecycle.onLoad({ week: '5' })
    p.__lifecycle.onReady()
    await settle()
    p.selectWeek(7)
    assert.equal(p.currentWeek.value, 7)
    await settle()
    assert.equal(p.scrollTarget.value, 'week-7')
  })

  await scenario('M5 源码契约：假默认 32 已除、兜底冒充已除、模板守卫与空态在位', async () => {
    const src = fs.readFileSync(path.join(root, 'pages/guide/weekly-guide.vue'), 'utf8')
    assert.ok(!/ref\(32\)/.test(src), '不再写死假默认 32')
    assert.ok(!src.includes('|| GUIDE_DATA[32]'), '不再拿孕32兜底冒充')
    assert.ok(src.includes(':scroll-into-view="scrollTarget"'), '周条定位绑独立目标值')
    assert.ok(src.includes('onReady(() => locateWeek())'), '就绪后一次性定位')
    assert.ok(src.includes('v-if="guideData"'), '内容区空值守卫')
    assert.ok(src.includes('暂未收录'), '诚实空态分支')
    assert.ok(!src.includes('useHealthStore'), '死导入已清')
  })

  console.log(`\nphase-m：${passed} 通过，${failed.length} 失败`)
  if (failed.length > 0) { console.log('失败场景：', failed.join(' | ')); process.exit(1) }
}

main().catch(e => { console.error(e); process.exit(1) })
