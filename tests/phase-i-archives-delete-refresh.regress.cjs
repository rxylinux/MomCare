// 归档列表"删除后退不刷新"回归（family 模式）：
// 详情页删除成功后 familyStore.reports 已打墓碑（deleted:true），但列表页渲染的是
// reportStore 里的映射副本——修复前 onShow 只认 listNeedsRefresh 标志（family 删除
// 不置位）或 store 为空，已删条目连同概览图原样挂在列表上。
// 修复：mapFamilyReports 提升到页面作用域，onShow family 模式先本地重映射（零网络、
// 不碰 loadData 冷却）。本套件锚定该行为：墓碑立即下屏/他端新增上屏/全删清空/非
// family 模式不重映射/全程零云调用；同映射副本的 ai_status（已解读徽标）与孕周映射。
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
      '\nexport {dataSource,reportStore,familyStore,shows,loadError,loadErrorHint,loading,reportFamilyStore,abandonBatch};\n' +
      'export * from "./services/sessionService.js";',
    resolveDir: root
  },
  bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: pageBundle, logLevel: 'silent'
})

// classify 页 bundle（批次放弃入口之二）：onLoad shim（b2b2 bundlePage 同方案）
const classifyBundle = path.join(temp, 'classify-page.cjs')
{
  const cbody = fs.readFileSync(path.join(root, 'pages/archives/classify.vue'), 'utf8').match(/<script setup>([\s\S]*?)<\/script>/)[1]
  const ccode = cbody
    .replace(/^import .* from ['"][^'"\n]+\.vue['"];?$/mg, '')
    .replace(/import\s*\{\s*onLoad\s*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const loads=[];const onLoad=fn=>loads.push(fn);')
  esbuild.buildSync({
    stdin: {
      contents: ccode.replace('const reportStore = useReportStore()',
        'import { createPinia, setActivePinia } from "pinia";\nsetActivePinia(createPinia());\nconst reportStore = useReportStore()') +
        '\nexport {familyBatchId,reportFamilyStore,discardWholeBatch};\nexport * from "./services/sessionService.js";',
      resolveDir: root
    },
    bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: classifyBundle, logLevel: 'silent'
  })
}
function loadClient(bundlePath) {
  delete require.cache[require.resolve(bundlePath)]
  return require(bundlePath)
}
const tick = () => new Promise(r => setTimeout(r, 20))

const storage = new Map()
const uniCalls = { toasts: [], modals: [], removedFiles: [], navigateBack: 0, modalAnswer: null }
global.uni = {
  getStorageSync(k) { return storage.has(k) ? storage.get(k) : '' },
  setStorageSync(k, v) { storage.set(k, v) },
  removeStorageSync(k) { storage.delete(k) },
  getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
  showToast: v => uniCalls.toasts.push(v && v.title),
  showLoading() {}, hideLoading() {},
  showModal: o => {
    uniCalls.modals.push({ title: o.title, confirmText: o.confirmText })
    const confirm = uniCalls.modalAnswer === null ? true : uniCalls.modalAnswer
    o.success && o.success({ confirm, cancel: !confirm })
  },
  redirectTo() {}, navigateTo() {}, switchTab() {}, reLaunch() {},
  navigateBack: () => { uniCalls.navigateBack++ },
  request: () => { throw new Error('unexpected uni.request') },
  removeSavedFile: o => { uniCalls.removedFiles.push(o && o.filePath) }
}
// 云调用按函数名路由：身份确认成功 + 报告列表空。前四场景不触发任何云调用
// （cloudCalls===0 断言不变）；放弃场景仅经确认身份 + loadData 空列表
let cloudCalls = 0
const cloudRoutes = {
  'mc-identity': { ok: true, data: { memberId: 'mama', displayName: '妈妈', familyId: 'fam-archdel' } },
  'mc-reports': { ok: true, data: { records: [], nextCursor: null } }
}
global.wx = {
  cloud: {
    init() {},
    callFunction(o) {
      cloudCalls++
      o.success && o.success({ result: cloudRoutes[o.name] || { ok: false, code: 'cloud-call-failed' } })
    }
  }
}
function resetBetweenScenarios() {
  for (const k of [...storage.keys()]) {
    if (k.startsWith('mc_cache_') || k.startsWith('mc_session')) storage.delete(k)
  }
  uniCalls.toasts.length = 0
  uniCalls.modals.length = 0
  uniCalls.removedFiles.length = 0
  uniCalls.navigateBack = 0
  uniCalls.modalAnswer = null
  cloudCalls = 0
}
const runShow = async api => { for (const fn of api.shows) await fn() }
const ids = list => list.map(r => r._id).sort()
const seedBatch = (id, paths, status) => ({
  batchId: id, reportId: 'r-' + id, status: status || 'uploading', draft: null, updatedAt: Date.now(),
  items: paths.map((p, i) => ({ order: i, uploadId: 'up-' + id + i, savedFilePath: p, stageFileID: '', fileId: '', state: i === 0 ? 'pending' : 'registered', error: '' }))
})

;(async () => {
  await scenario('family 删除墓碑：onShow 本地重映射让已删条目（含概览图）立即下屏、他端新增同步上屏', async () => {
    const api = loadClient(pageBundle)
    resetBetweenScenarios()
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
    const api = loadClient(pageBundle)
    resetBetweenScenarios()
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
    const api = loadClient(pageBundle)
    resetBetweenScenarios()
    api.dataSource.value = 'demo'
    api.reportStore.reports = [
      { _id: 'demo1', report_type: 'blood', report_date: '2026-09-01', archive_status: 'archived', file_urls: [], _local: true }
    ]
    api.reportStore.unarchivedReports = []

    await runShow(api)

    assert.deepEqual(ids(api.reportStore.reports), ['demo1'], 'demo 模式列表原样保留')
    assert.equal(cloudCalls, 0, '零云调用')
  })

  await scenario('family 列表映射 AI 解读状态与孕周：已解读报告不再显示"未解读"', async () => {
    const api = loadClient(pageBundle)
    resetBetweenScenarios()
    api.dataSource.value = 'family'
    // 权威记录：r-done 云端 ai_result.text 非空（mc-tools CAS 写入）；r-pending 无解读；
    // r-blank 空白文本；r-week 带孕周。此前映射副本不带 ai_status → 徽标恒"未解读"
    api.familyStore.reports = {
      'r-done': { id: 'r-done', revision: 2, deleted: false, archiveStatus: 'archived', reportType: 'blood', dateKey: '2026-09-01', attachments: [], ai_result: { text: '血常规各项未见明显异常。' } },
      'r-pending': { id: 'r-pending', revision: 1, deleted: false, archiveStatus: 'archived', reportType: 'urine', dateKey: '2026-09-05', attachments: [] },
      'r-blank': { id: 'r-blank', revision: 1, deleted: false, archiveStatus: 'archived', reportType: 'ctg', dateKey: '2026-09-08', attachments: [], ai_result: { text: '   ' } },
      'r-week': { id: 'r-week', revision: 1, deleted: false, archiveStatus: 'archived', reportType: 'b超', dateKey: '2026-09-10', attachments: [], weekOfPregnancy: 28 }
    }
    api.reportStore.reports = []
    api.reportStore.unarchivedReports = []

    await runShow(api)

    const byId = Object.fromEntries(api.reportStore.reports.map(r => [r._id, r]))
    assert.equal(byId['r-done'].ai_status, 'done', '云端已有解读 → 列表徽标"已解读"')
    assert.equal(byId['r-pending'].ai_status, 'pending', '无解读记录 → "未解读"')
    assert.equal(byId['r-blank'].ai_status, 'pending', '空白解读文本按未解读（familyAiView trim 语义）')
    assert.equal(byId['r-week'].week_of_pregnancy, 28, '孕周映射进列表副本（"孕 X 周"标签可显示）')
    assert.equal(cloudCalls, 0, '零云调用')
  })

  await scenario('批次放弃·档案页入口（确认）：整批 cancelled+本机原件清理+卡片消失', async () => {
    resetBetweenScenarios()
    const api = loadClient(pageBundle)
    assert.ok(await api.confirmIdentity(), '身份确认成功（persistBatches 需确认态）')
    await tick() // 会话 watch（清空+loadPersisted）先落定，再播种批次
    api.reportFamilyStore.batches = { b1: seedBatch('b1', ['store://a.png', 'store://b.png'], 'partial') }
    assert.equal(api.reportFamilyStore.activeBatches.length, 1, '前置：未完成批次卡可见')

    api.abandonBatch('b1')

    assert.equal(api.reportFamilyStore.batch('b1').status, 'cancelled', '整批置 cancelled（persist 失败会回滚，status 成立即已持久）')
    assert.equal(api.reportFamilyStore.activeBatches.length, 0, '放弃后未完成批次卡消失')
    assert.deepEqual([...uniCalls.removedFiles].sort(), ['store://a.png', 'store://b.png'], '本机原件清理')
    assert.ok(uniCalls.modals.length === 1 && uniCalls.modals[0].confirmText === '放弃', '先确认弹窗后执行')
    assert.ok(uniCalls.toasts.includes('已放弃该批次'), '成功提示')
  })

  await scenario('批次放弃·档案页入口（弹窗取消）：批次原样保留、原件不动', async () => {
    resetBetweenScenarios()
    const api = loadClient(pageBundle)
    assert.ok(await api.confirmIdentity())
    await tick()
    api.reportFamilyStore.batches = { b2: seedBatch('b2', ['store://c.png'], 'uploading') }
    uniCalls.modalAnswer = false

    api.abandonBatch('b2')

    assert.equal(api.reportFamilyStore.batch('b2').status, 'uploading', '取消弹窗不动批次')
    assert.equal(uniCalls.removedFiles.length, 0, '本机原件不动')
    assert.equal(api.reportFamilyStore.activeBatches.length, 1)
  })

  await scenario('批次放弃·分类页入口（确认）：整批 cancelled+成功后返回上一页', async () => {
    resetBetweenScenarios()
    const api = loadClient(classifyBundle)
    assert.ok(await api.confirmIdentity())
    await tick()
    api.reportFamilyStore.batches = { b3: seedBatch('b3', ['store://d.png', 'store://e.png'], 'partial') }
    api.familyBatchId.value = 'b3'

    api.discardWholeBatch()

    assert.equal(api.reportFamilyStore.batch('b3').status, 'cancelled', '分类页入口走同一 store 通道')
    assert.deepEqual([...uniCalls.removedFiles].sort(), ['store://d.png', 'store://e.png'], '本机原件清理')
    await new Promise(r => setTimeout(r, 700))
    assert.equal(uniCalls.navigateBack, 1, '放弃成功后返回上一页')
  })

  console.log(`\n${passed} passed, ${failed.length} failed`)
  process.exit(failed.length ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
