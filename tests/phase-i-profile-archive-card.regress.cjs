// "我的"页产检档案卡副标题回归：
// 修复前 profile recordItems 里产检档案卡 subtitle 写死 '暂无报告'（badge 字段都没有）——
// 报告存在时卡片谎报空，与点进档案列表（reportStore 真实数据）矛盾。
// 修复：三态同源接数——family=familyStore.reports 权威计数（滤墓碑，分桶口径同列表
// mapFamilyReports：archiveStatus==='archived' 归档 / 其余待分类）；demo=reportStore
// 本地两桶；prompt 恒零。subtitle 共 N 份（有待分类时附注），badge N份，零报告保持
// '暂无报告'。本套件锚定：计数正确性/墓碑不计/墓碑即时响应/分模式取数/零云调用。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-profarc-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) {
  try { await fn(); pass(name) } catch (e) { fail(name, e) }
}

// 页面 bundle：剥 <script setup>、去 .vue 组件 import、shim onShow 收集器、
// 首个 store 实例化前注入 setActivePinia（每个 require 全新模块实例=全新 Pinia）
const body = fs.readFileSync(path.join(root, 'pages/profile/index.vue'), 'utf8').match(/<script setup>([\s\S]*?)<\/script>/)[1]
const code = body
  .replace(/^import .* from ['"][^'"\n]+\.vue['"];?$/mg, '')
  .replace(/import\s*\{[^}]*onShow[^}]*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const shows=[];const __onShow=fn=>shows.push(fn);')
const pageBundle = path.join(temp, 'profile-page.cjs')
esbuild.buildSync({
  stdin: {
    contents: code.replace('const healthStore = useHealthStore()',
      'import { createPinia, setActivePinia } from "pinia";\nsetActivePinia(createPinia());\nconst healthStore = useHealthStore()') +
      '\nexport {dataSource,isFamily,recordItems,familyStore,reportStore,shows};',
    resolveDir: root
  },
  bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: pageBundle, logLevel: 'silent'
})
function loadClient() {
  delete require.cache[require.resolve(pageBundle)]
  return require(pageBundle)
}

const storage = new Map()
global.uni = {
  getStorageSync(k) { return storage.has(k) ? storage.get(k) : '' },
  setStorageSync(k, v) { storage.set(k, v) },
  removeStorageSync(k) { storage.delete(k) },
  getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
  showToast() {}, showLoading() {}, hideLoading() {}, showModal() {},
  redirectTo() {}, navigateTo() {}, switchTab() {}, reLaunch() {}, navigateBack() {},
  request: () => { throw new Error('unexpected uni.request') },
  removeSavedFile() {}
}
let cloudCalls = 0
global.wx = {
  cloud: {
    init() {},
    callFunction(o) {
      cloudCalls++
      o.success && o.success({ result: { ok: false, code: 'cloud-call-failed' } })
    }
  }
}

const archiveCard = api => api.recordItems.value.find(i => i.action === 'archives')
const seed = (id, extra) => Object.assign({ id, revision: 1, deleted: false, archiveStatus: 'archived', reportType: 'blood', dateKey: '2026-09-10', attachments: [] }, extra)

;(async () => {
  await scenario('family 权威计数：存活计入、墓碑不计、待分类附注+badge（四卡结构完整）', async () => {
    const api = loadClient()
    api.dataSource.value = 'family'
    api.familyStore.reports = {
      r1: seed('r1'),
      r2: seed('r2', { archiveStatus: 'unarchived' }),
      r3: seed('r3', { deleted: true }) // 详情页删除打的墓碑
    }
    const card = archiveCard(api)
    assert.equal(api.recordItems.value.length, 4, '我的记录仍四卡')
    assert.equal(card.title, '产检档案')
    assert.equal(card.subtitle, '共 2 份 · 待分类 1 份', '墓碑不计入；待分类单独附注')
    assert.equal(card.badge, '2份', 'badge 补齐（与三卡同格式）')
    assert.equal(cloudCalls, 0, '纯本地重算零云调用')
  })

  await scenario('family 全部已归档：无待分类字样', async () => {
    const api = loadClient()
    api.dataSource.value = 'family'
    api.familyStore.reports = { r1: seed('r1'), r2: seed('r2', { dateKey: '2026-09-20' }) }
    const card = archiveCard(api)
    assert.equal(card.subtitle, '共 2 份')
    assert.equal(card.badge, '2份')
  })

  await scenario('family 墓碑即时响应：详情页删除后卡片计数立即下降（不依赖重新拉取）', async () => {
    const api = loadClient()
    api.dataSource.value = 'family'
    api.familyStore.reports = { r1: seed('r1'), r2: seed('r2') }
    assert.equal(archiveCard(api).subtitle, '共 2 份', '前置：两份')
    api.familyStore.reports = { r1: seed('r1'), r2: seed('r2', { deleted: true }) } // 详情页 deleteReport 打墓碑（整对象替换）
    const card = archiveCard(api)
    assert.equal(card.subtitle, '共 1 份', 'computed 随权威 store 响应式刷新')
    assert.equal(card.badge, '1份')
  })

  await scenario('family 空报告/全墓碑：保持"暂无报告"、badge 空', async () => {
    const api = loadClient()
    api.dataSource.value = 'family'
    api.familyStore.reports = { r1: seed('r1', { deleted: true }) }
    const card = archiveCard(api)
    assert.equal(card.subtitle, '暂无报告')
    assert.equal(card.badge, '')
  })

  await scenario('demo 本地两桶计数：reportStore 已归档+待分类分别计入', async () => {
    const api = loadClient()
    api.dataSource.value = 'demo'
    api.reportStore.reports = [
      { _id: 'd1', report_type: 'blood', report_date: '2026-09-01', archive_status: 'archived', file_urls: [], _local: true }
    ]
    api.reportStore.unarchivedReports = [
      { _id: 'd2', report_type: 'urine', report_date: '2026-09-05', archive_status: 'unarchived', file_urls: [], _local: true }
    ]
    const card = archiveCard(api)
    assert.equal(card.subtitle, '共 2 份 · 待分类 1 份', 'demo 走 reportStore 两桶合计')
    assert.equal(card.badge, '2份')
  })

  await scenario('prompt 未确认身份：零报告显示"暂无报告"', async () => {
    const api = loadClient() // 空 storage → dataSource 初始即 prompt
    const card = archiveCard(api)
    assert.equal(card.subtitle, '暂无报告')
    assert.equal(card.badge, '')
    assert.equal(cloudCalls, 0, '全程零云调用')
  })

  console.log(`\n${passed} passed, ${failed.length} failed`)
  process.exit(failed.length ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
