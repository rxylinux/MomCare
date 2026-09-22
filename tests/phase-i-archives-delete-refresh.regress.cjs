// 归档列表"删除后退不刷新"回归（family 模式）：
// 详情页删除成功后 familyStore.reports 已打墓碑（deleted:true），但列表页渲染的是
// reportStore 里的映射副本——修复前 onShow 只认 listNeedsRefresh 标志（family 删除
// 不置位）或 store 为空，已删条目连同概览图原样挂在列表上。
// 修复：mapFamilyReports 提升到页面作用域，onShow family 模式先本地重映射（零网络、
// 不碰 loadData 冷却）。本套件锚定该行为：墓碑立即下屏/他端新增上屏/全删清空/非
// family 模式不重映射/全程零云调用。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-archdel-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) {
  try { await fn(); pass(name) } catch (e) { fail(name, e) }
}

// 页面 bundle：剥 <script setup>、去 .vue 组件 import、shim onShow 收集器、
// 锚点行前注入 setActivePinia（与 phase-h 同方案；每个 require 全新模块实例）
const body = fs.readFileSync(path.join(root, 'pages/archives/index.vue'), 'utf8').match(/<script setup>([\s\S]*?)<\/script>/)[1]
const code = body
  .replace(/^import .* from ['"][^'"\n]+\.vue['"];?$/mg, '')
  .replace(/import\s*\{[^}]*onShow[^}]*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const shows=[];const onShow=fn=>shows.push(fn);')
const pageBundle = path.join(temp, 'archives-page.cjs')
esbuild.buildSync({
  stdin: {
    contents: code.replace('const reportStore = useReportStore()',
      'import { createPinia, setActivePinia } from "pinia";\nsetActivePinia(createPinia());\nconst reportStore = useReportStore()') +
      '\nexport {dataSource,reportStore,familyStore,shows,loadError,loadErrorHint,loading};',
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
  showToast() {}, showLoading() {}, hideLoading() {},
  redirectTo() {}, navigateTo() {}, switchTab() {}, reLaunch() {}, navigateBack() {},
  request: () => { throw new Error('unexpected uni.request') }
}
// 本套件所有场景都必须零网络：任何云调用一旦被触发即被计数断言抓住
let cloudCalls = 0
global.wx = {
  cloud: {
    init() {},
    callFunction() { cloudCalls++; throw new Error('unexpected cloud call') }
  }
}
const runShow = async api => { for (const fn of api.shows) await fn() }
const ids = list => list.map(r => r._id).sort()

;(async () => {
  await scenario('family 删除墓碑：onShow 本地重映射让已删条目（含概览图）立即下屏、他端新增同步上屏', async () => {
    const api = loadClient()
    cloudCalls = 0
    api.dataSource.value = 'family'
    // 权威 store：r1 已删（详情页删除打墓碑）、r2 存活、r3 未归档存活、r4 他端新增
    api.familyStore.reports = {
      r1: { id: 'r1', revision: 2, deleted: true, archiveStatus: 'archived', reportType: 'blood', dateKey: '2026-09-01', attachments: [] },
      r2: { id: 'r2', revision: 1, deleted: false, archiveStatus: 'archived', reportType: 'urine', dateKey: '2026-09-10', attachments: [{ fileId: 'f2' }] },
      r3: { id: 'r3', revision: 1, deleted: false, archiveStatus: 'unarchived', reportType: 'b超', dateKey: '2026-09-15', attachments: [] },
      r4: { id: 'r4', revision: 1, deleted: false, archiveStatus: 'archived', reportType: 'ctg', dateKey: '2026-09-20', attachments: [] }
    }
    // 列表页的旧映射副本：r1 还挂着（带概览图 URL）、r4 缺失
    api.reportStore.reports = [
      { _id: 'r1', report_type: 'blood', report_date: '2026-09-01', archive_status: 'archived', file_urls: ['https://temp.invalid/r1.png'], _cloud: true },
      { _id: 'r2', report_type: 'urine', report_date: '2026-09-10', archive_status: 'archived', file_urls: [], _cloud: true }
    ]
    api.reportStore.unarchivedReports = [
      { _id: 'r3', report_type: 'b超', report_date: '2026-09-15', archive_status: 'unarchived', file_urls: [], _cloud: true }
    ]

    await runShow(api)

    assert.deepEqual(ids(api.reportStore.reports), ['r2', 'r4'], '已归档列表=存活 r2 + 他端新增 r4；已删 r1 连同概览图下屏')
    assert.deepEqual(ids(api.reportStore.unarchivedReports), ['r3'], '未归档桶保持 r3')
    assert.ok(!api.reportStore.reports.some(r => (r.file_urls || []).includes('https://temp.invalid/r1.png')), '已删条目的概览图 URL 不得残留在列表')
    assert.equal(cloudCalls, 0, '本地重映射必须零云调用（不依赖网络/冷却）')
    assert.equal(api.loadError.value, '', 'store 非空不应进入错误态')
  })

  await scenario('family 全部墓碑：onShow 重映射后列表清空（空态仍零网络）', async () => {
    const api = loadClient()
    cloudCalls = 0
    api.dataSource.value = 'family'
    api.familyStore.reports = {
      r1: { id: 'r1', revision: 3, deleted: true, archiveStatus: 'archived', reportType: 'blood', dateKey: '2026-09-01', attachments: [] },
      r2: { id: 'r2', revision: 2, deleted: true, archiveStatus: 'unarchived', reportType: 'urine', dateKey: '2026-09-10', attachments: [] }
    }
    api.reportStore.reports = [
      { _id: 'r1', report_type: 'blood', report_date: '2026-09-01', archive_status: 'archived', file_urls: ['https://temp.invalid/r1.png'], _cloud: true }
    ]
    api.reportStore.unarchivedReports = [
      { _id: 'r2', report_type: 'urine', report_date: '2026-09-10', archive_status: 'unarchived', file_urls: [], _cloud: true }
    ]

    await runShow(api)

    assert.equal(api.reportStore.reports.length, 0, '已归档清空')
    assert.equal(api.reportStore.unarchivedReports.length, 0, '未归档清空')
    assert.equal(cloudCalls, 0, '未确认会话下空态刷新走 familyCall 短路，零云调用')
  })

  await scenario('非 family 模式：onShow 不做 family 重映射（demo 数据不被清屏）', async () => {
    const api = loadClient()
    cloudCalls = 0
    api.dataSource.value = 'demo'
    api.reportStore.reports = [
      { _id: 'demo1', report_type: 'blood', report_date: '2026-09-01', archive_status: 'archived', file_urls: [], _local: true }
    ]
    api.reportStore.unarchivedReports = []

    await runShow(api)

    assert.deepEqual(ids(api.reportStore.reports), ['demo1'], 'demo 模式列表原样保留')
    assert.equal(cloudCalls, 0, '零云调用')
  })

  console.log(`\n${passed} passed, ${failed.length} failed`)
  process.exit(failed.length ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
