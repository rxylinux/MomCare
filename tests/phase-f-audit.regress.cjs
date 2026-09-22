// Phase F 安全审计回归：Cloudflare 历史功能全量收敛与 CloudBase 迁移验收。
// Audit 1 全项目静态扫描零 workers.dev；Audit 2 知识库 Store 契约；Audit 3 知识库页面脱网渲染；
// Audit 4 报告 AI 原生网关联动（经 toolsStore→mc-tools，零 HTTP）；Audit 5 冻结源哈希。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-pf-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')
const tick = () => new Promise(r => setTimeout(r, 30))

require('node:child_process').execFileSync('node', [path.join(root, 'cloud/assemble.mjs')], { stdio: 'pipe' })
const DIST = path.join(root, 'dist/cloud-functions')
const toolsH = require(path.join(DIST, 'mc-tools/index.js'))

const FROZEN_RELS = ['stores/report.js', 'stores/staticData.js', 'static/data/articles.json', 'utils/api.js', 'pages/knowledge/index.vue', 'pages/knowledge/detail.vue', 'pages/archives/components/UploadSheet.vue']
const frozenHashes = Object.fromEntries(FROZEN_RELS.map(rel => [rel, sha256(fs.readFileSync(path.join(root, rel)))]))
console.log('冻结源哈希（加载时快照）:')
for (const [rel, h] of Object.entries(frozenHashes)) console.log(`  ${h.slice(0, 8)}  ${rel}`)

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-pf', MC_MEMBER_MAMA_OPENID: 'oPFMAMA123456', MC_MEMBER_PAPA_OPENID: 'oPFPAPA123456' }

function makeMockCloud() {
  const docs = new Map()
  const state = { caller: TEST_ENV.MC_MEMBER_MAMA_OPENID, initialized: false }
  const clone = x => JSON.parse(JSON.stringify(x))
  function docApi(col, id, tx) {
    return {
      get: async () => { const e = docs.get(`${col}/${id}`); if (tx) tx.reads.set(`${col}/${id}`, e ? e.__v : 0); return { data: e ? { ...clone(e), _id: id } : null } },
      set: async ({ data }) => { if (tx) { tx.writes.set(`${col}/${id}`, clone(data)); return { _id: id } } const prev = docs.get(`${col}/${id}`); docs.set(`${col}/${id}`, { ...clone(data), __v: (prev ? prev.__v : 0) + 1 }); return { _id: id } },
      remove: async () => { docs.delete(`${col}/${id}`); return {} }
    }
  }
  const db = {
    startTransaction: async () => {
      const tx = { reads: new Map(), writes: new Map(), removes: new Set() }
      return { collection: c => ({ doc: id => docApi(c, id, tx) }), commit: async () => { for (const [k, rv] of tx.reads) { const cur2 = docs.get(k); if ((cur2 ? cur2.__v : 0) !== rv) { const err = new Error('conflict ' + k); err.errCode = 'CONFLICT'; throw err } } for (const [k, d2] of tx.writes) { const prev = docs.get(k); docs.set(k, { ...d2, __v: (prev ? prev.__v : 0) + 1 }) } }, rollback: async () => { tx.writes.clear(); tx.removes.clear() } }
    },
    collection: c => ({ doc: id => docApi(c, id, null) })
  }
  return {
    DYNAMIC_CURRENT_ENV: Symbol('env'), init() { state.initialized = true },
    getWXContext: () => ({ APPID: TEST_ENV.MC_APPID, OPENID: state.caller }),
    database() { if (!state.initialized) throw new Error('init first'); return db },
    __docs: docs, __state: state, __setCtx(o) { state.caller = o },
  }
}

// 联网计数 mock：任何 uni.request / uni.uploadFile 都记数（脱网断言凭据）
const storage = new Map()
const uniCalls = { requests: [], uploads: [], toasts: [], modals: [] }
global.uni = {
  getStorageSync(k) { return storage.has(k) ? storage.get(k) : '' },
  setStorageSync(k, v) { storage.set(k, v) },
  removeStorageSync(k) { storage.delete(k) },
  getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
  showToast: v => uniCalls.toasts.push(v && v.title),
  showModal: o => { uniCalls.modals.push({ title: o && o.title, content: o && o.content }); o && o.success && o.success({ confirm: true }) },
  request: o => { uniCalls.requests.push(String(o && o.url)); o && o.fail && o.fail({ errMsg: 'request:fail offline-audit' }) },
  uploadFile: o => { uniCalls.uploads.push(String(o && o.url)); o && o.fail && o.fail({ errMsg: 'uploadFile:fail' }) },
  makePhoneCall() {}, vibrateShort() {}, showLoading() {}, hideLoading() {},
  redirectTo() {}, navigateTo() {}, switchTab() {}, reLaunch() {}, navigateBack() {},
  downloadFile: o => o.fail && o.fail({ errMsg: 'dl' }), compressImage: o => o.success && o.success({ tempFilePath: o.src }),
}

function buildBundle(vuePath, anchor, exports, outfile) {
  const src = fs.readFileSync(path.join(root, vuePath), 'utf8')
  const body = src.match(/<script setup>([\s\S]*?)<\/script>/)[1]
  let code = body
    .replace(/^import .* from ['"][^'"\n]+\.vue['"];?$/mg, '')
    .replace(/import\s*\{\s*onLoad\s*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const loads=[];const onLoad=fn=>loads.push(fn);')
    .replace(/import\s*\{\s*onShow\s*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const shows=[];const onShow=fn=>shows.push(fn);')
  code = 'import { createPinia, setActivePinia } from "pinia";\nsetActivePinia(createPinia());\n' + code.replace(anchor, `setActivePinia(createPinia());\n${anchor}`)
  code += '\n' + exports + '\n'
  esbuild.buildSync({ stdin: { contents: code, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile, logLevel: 'silent' })
}
function loadClient(p) {
  delete require.cache[require.resolve(p)]
  return require(p)
}

function makeStack() {
  for (const k of [...storage.keys()]) {
    if (k.startsWith('momcare_') || k.startsWith('mc_') || k.startsWith('YUNTU_')) storage.delete(k)
  }
  uniCalls.requests.length = 0; uniCalls.uploads.length = 0; uniCalls.toasts.length = 0
  const cloud = makeMockCloud()
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID
  delete process.env.DEEPSEEK_API_KEY
  // 视觉直读 2026-09-22 起默认开启（恰 '0' 关闭）——F 审计联动走元数据路径须显式关闭
  process.env.MC_REPORT_VISION = '0'
  toolsH.__setCloud(cloud)
  const wxCloud = {
    init() {},
    callFunction(o) {
      const h = o.name === 'mc-tools' ? toolsH.main : () => ({ ok: true, data: { memberId: 'mama', familyId: TEST_ENV.MC_FAMILY_ID } })
      Promise.resolve().then(() => h(o.data)).then(r => o.success({ result: r })).catch(e => o.fail({ errMsg: e.message }))
    }
  }
  return { cloud, wxCloud }
}
async function confirmed(stack, bundlePath) {
  const client = loadClient(bundlePath)
  client.__setCloudConfigForTests('env-pf', 'wxapp-pf')
  client.__setWxCloud(stack.wxCloud)
  global.wx = { cloud: stack.wxCloud }
  client.__resetForTests()
  const r = await client.confirmIdentity()
  assert.ok(r.ok, `confirmIdentity: ${JSON.stringify(r).slice(0, 120)}`)
  return client
}

async function main() {
  console.log('Phase F 安全审计回归（Cloudflare 收敛 + CloudBase 迁移验收）\n')

  await scenario('Audit 1 全项目静态扫描：pages/components/services/stores/utils/cloud 零 workers.dev', async () => {
    const dirs = ['pages', 'components', 'services', 'stores', 'utils', 'cloud']
    const offenders = []
    for (const dir of dirs) {
      const dirPath = path.join(root, dir)
      const walk = d => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name)
          if (e.isDirectory()) { if (e.name === 'node_modules') continue; walk(p); continue }
          if (!/\.(js|vue|json|mjs)$/.test(e.name)) continue
          const content = fs.readFileSync(p, 'utf8')
          if (content.includes('workers.dev')) offenders.push(path.relative(root, p))
        }
      }
      walk(dirPath)
    }
    assert.deepEqual(offenders, [], `workers.dev 残留（实得 ${JSON.stringify(offenders)}）`)
    // API_BASE 已置空
    const api = fs.readFileSync(path.join(root, 'utils/api.js'), 'utf8')
    assert.ok(/export const API_BASE = ''/.test(api), "API_BASE 恰为空串")
    assert.ok(!api.includes('workers.dev'), 'utils/api.js 零域名')
    // UploadSheet 不再 import API_BASE
    const sheet = fs.readFileSync(path.join(root, 'pages/archives/components/UploadSheet.vue'), 'utf8')
    assert.ok(!sheet.includes('API_BASE'), 'UploadSheet 不再引用 API_BASE')
  })

  await scenario('Audit 2 知识库 Store 契约：18 篇载入/分类/检索/排序/分页/详情', async () => {
    const stack = makeStack()
    const bundle = path.join(temp, 'store.cjs')
    esbuild.buildSync({
      stdin: { contents: `import { createPinia, setActivePinia } from 'pinia';\nsetActivePinia(createPinia());\nexport * from './stores/staticData.js';\n`, resolveDir: root },
      bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: bundle, logLevel: 'silent'
    })
    const client = loadClient(bundle)
    const store = client.useStaticDataStore()
    assert.ok(await store.loadData(), 'loadData ok')
    // 18 篇齐载 + 严格字段
    assert.equal(store.articlesData.length, 18, `18 篇（实得 ${store.articlesData.length}）`)
    const need = ['id', 'title', 'subtitle', 'summary', 'category', 'tags', 'cover_icon', 'cover_image', 'read_time', 'view_count', 'publish_time', 'target_week_start', 'target_week_end', 'content']
    for (const a of store.articlesData) for (const k of need) assert.ok(a[k] !== undefined, `${a.id} 缺 ${k}`)
    // 五大分类齐备
    const cats = new Set(store.articlesData.map(a => a.category))
    for (const c of ['孕早期必读', '孕中期指南', '孕晚期准备', '分娩与临产', '产后与育儿']) assert.ok(cats.has(c), `分类「${c}」在场`)
    // recommended = 全部
    const rec = store.getArticles({ category: 'recommended', pageSize: 100 })
    assert.equal(rec.total, 18, 'recommended 全量')
    // 分类过滤
    const early = store.getArticles({ category: '孕早期必读', pageSize: 100 })
    assert.equal(early.total, store.articlesData.filter(a => a.category === '孕早期必读').length)
    assert.ok(early.items.every(a => a.category === '孕早期必读'))
    // 关键词（title/tags 命中；大小写不敏感）
    const kw1 = store.getArticles({ keyword: '无痛分娩', pageSize: 100 })
    assert.ok(kw1.total >= 1 && kw1.items.some(a => a.title.includes('镇痛') || (a.tags || []).includes('无痛分娩')), '关键词「无痛分娩」命中')
    const kw2 = store.getArticles({ keyword: 'nt', pageSize: 100 })
    assert.ok(kw2.total >= 1 && kw2.items.some(a => a.id === 'art_early_04'), '关键词「nt」大小写不敏感命中 NT 文')
    assert.equal(store.getArticles({ keyword: '绝不存在的关键词QQQ' }).total, 0, '未命中空')
    // 排序：view_count 降序 / publish_time 降序
    const byViews = store.getArticles({ sortBy: 'view_count', pageSize: 100 }).items
    for (let i = 1; i < byViews.length; i++) assert.ok(byViews[i - 1].view_count >= byViews[i].view_count, '阅读量降序')
    const byPub = store.getArticles({ sortBy: 'publish_time', pageSize: 100 }).items
    for (let i = 1; i < byPub.length; i++) assert.ok(new Date(byPub[i - 1].publish_time) >= new Date(byPub[i].publish_time), '发布时间降序')
    // 分页：pageSize 5 → 4 页，无重无漏
    const seen = []
    let page = 0
    for (;;) {
      const r = store.getArticles({ page, pageSize: 5 })
      seen.push(...r.items.map(x => x.id))
      if (!r.hasMore) break
      page++
      assert.ok(page < 10, '分页保护')
    }
    assert.equal(seen.length, 18) && assert.equal(new Set(seen).size, 18, '分页无重无漏')
    // 详情查询
    const one = store.getArticleById('art_early_01')
    assert.ok(one && one.title.includes('怀孕初期') && one.content.includes('##'), '按 ID 详情')
    assert.equal(store.getArticleById('nope'), null, '未知 ID null')
  })

  await scenario('Audit 3 知识库页面脱网渲染：fetchArticles/loadArticleById 零 HTTP 且成功', async () => {
    const stack = makeStack()
    // 列表页 bundle
    const listBundle = path.join(temp, 'page-kn-list.cjs')
    buildBundle('pages/knowledge/index.vue',
      'const healthStore = useHealthStore()',
      `export {fetchArticles,loadMore,articleList,hasMore,loading,loadingMore,activeTab,searchKeyword,sortBy,switchTab,applySort,clearSearch,handleSearch,categoryTabs};export * from './stores/staticData.js';export * from './services/sessionService.js';export * from './services/cloudAdapter.js';export * from './utils/cloudConfig.js';`,
      listBundle)
    const listPage = await confirmed(stack, listBundle)
    uniCalls.requests.length = 0; uniCalls.uploads.length = 0
    await listPage.fetchArticles(true)
    await tick()
    assert.ok(listPage.articleList.value.length > 0, `列表渲染（实得 ${listPage.articleList.value.length}）`)
    assert.equal(listPage.loading.value, false)
    assert.equal(listPage.hasMore.value, true, '18 篇 pageSize10 → hasMore')
    // 搜索/切分类（仍零网络）
    listPage.searchKeyword.value = '无痛分娩'
    await listPage.fetchArticles(true)
    await tick()
    assert.ok(listPage.articleList.value.length >= 1, '搜索过滤生效')
    listPage.searchKeyword.value = ''
    listPage.switchTab('孕早期必读')
    await listPage.fetchArticles(true)
    await tick()
    assert.ok(listPage.articleList.value.every(a => a.category === '孕早期必读'), '分类 tab 生效')
    // loadMore 分页（切回全量页——分类页仅 3 篇不足一页）
    listPage.switchTab('recommended')
    await listPage.fetchArticles(true)
    await tick()
    const before = listPage.articleList.value.length
    listPage.loadMore()
    await tick()
    assert.ok(listPage.articleList.value.length > before, `加载更多（${before}→${listPage.articleList.value.length}）`)

    // 分类页已验证（早于切换）：孕早期过滤
    assert.equal(uniCalls.requests.length, 0, `列表页 uni.request 恰 0 次（实得 ${uniCalls.requests.length}）`)
    assert.equal(uniCalls.uploads.length, 0, '零 uploadFile')

    // 详情页 bundle
    const detailBundle = path.join(temp, 'page-kn-detail.cjs')
    buildBundle('pages/knowledge/detail.vue',
      'const staticDataStore = useStaticDataStore()',
      `export {loads,article,loading,error,loadArticleById,publishDate,htmlContent};export * from './stores/staticData.js';export * from './services/sessionService.js';export * from './services/cloudAdapter.js';export * from './utils/cloudConfig.js';`,
      detailBundle)
    const detailPage = await confirmed(stack, detailBundle)
    await detailPage.loadArticleById({ id: 'art_mid_02' })
    await tick()
    assert.ok(detailPage.article.value && detailPage.article.value.title.includes('大排畸'), '详情渲染')
    assert.equal(detailPage.loading.value, false)
    assert.equal(detailPage.error.value, '', '无错误')
    assert.ok(String(detailPage.htmlContent.value).includes('<h2>'), 'Markdown 转换渲染')
    assert.ok(detailPage.publishDate.value.length > 0, '发布日期')
    // 未知 ID 诚实错误
    await detailPage.loadArticleById({ id: 'ghost' })
    assert.ok(String(detailPage.error.value).includes('不存在'), '未知 ID 如实错误')
    assert.equal(uniCalls.requests.length, 0, `详情页 uni.request 恰 0 次（实得 ${uniCalls.requests.length}）`)
  })

  await scenario('Audit 4 报告 AI 原生网关联动：triggerAiPipeline→toolsStore→mc-tools 零 HTTP', async () => {
    const stack = makeStack()
    // report store bundle（含 toolsStore/familyStore 全链）
    const bundle = path.join(temp, 'report.cjs')
    esbuild.buildSync({
      stdin: { contents: `import { createPinia, setActivePinia } from 'pinia';\nsetActivePinia(createPinia());\nexport * from './stores/report.js';\nexport * from './stores/health.js';\nexport * from './services/toolsStore.js';\nexport * from './services/sessionService.js';\nexport * from './services/familyStore.js';\nexport * from './services/outbox.js';\nexport * from './services/cloudAdapter.js';\nexport * from './utils/cloudConfig.js';\nexport * from './utils/backendGate.js';\n`,
        resolveDir: root },
      bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: bundle, logLevel: 'silent'
    })
    const client = await confirmed(stack, bundle)
    const reportStore = client.useReportStore()
    // 种一份本家庭报告（服务端 mc_reports 权威 + 本地缓存态）
    stack.cloud.__docs.set('mc_reports/rpt_f1', {
      familyId: TEST_ENV.MC_FAMILY_ID, deleted: false, dateKey: '2026-09-12',
      reportType: 'ultrasound', note: '', attachments: [{ fileId: 'f1' }], revision: 1, updatedBy: 'mama', updatedAt: 1, __v: 1
    })
    // 本地态注入走 store 真实形状：MOMCARE_DATA_MODE=formal → YUNTU_REPORTS_DATA（正式键），
    // 经 backendGate 测试注入口显式开 legacyFormalStores（生产恒 false——仅历史回归语义复用）
    storage.set('MOMCARE_DATA_MODE', 'formal')
    assert.equal(typeof client.__setLegacyFormalStoresEnabledForTests, 'function', 'backendGate 测试注入口须在 bundle 导出')
    client.__setLegacyFormalStoresEnabledForTests(true)
    const reportsKey = 'YUNTU_REPORTS_DATA'
    storage.set(reportsKey, JSON.stringify({
      reports: [{ _id: 'rpt_f1', report_type: 'ultrasound', report_date: '2026-09-12', archive_status: 'archived', file_urls: [], ai_status: 'pending', ocr_status: 'pending', _pendingSync: true }],
      unarchivedReports: []
    }))
    await reportStore.fetchReports()
    const localFound = reportStore.reports.find(r => r._id === 'rpt_f1')
    assert.ok(localFound, '本地报告载入（_findReport 可见）')
    uniCalls.requests.length = 0; uniCalls.uploads.length = 0; uniCalls.toasts.length = 0

    // (a) 未配置 Key：优雅提示分支（无 HTTP、无异常、toast 规格原文）
    const rOff = await reportStore.triggerAiPipeline('rpt_f1')
    await tick()
    assert.equal(typeof rOff, 'boolean', '返回布尔（不抛错）')
    assert.equal(uniCalls.requests.length, 0, '未配置分支零 uni.request')
    assert.equal(uniCalls.uploads.length, 0, '零 uploadFile')
    const offToast = uniCalls.toasts.find(t => String(t).includes('报告自动 OCR / DeepSeek 解读服务未配置'))
    assert.ok(offToast, `未配置提示原文（实得 ${JSON.stringify(uniCalls.toasts)}）`)

    // (b) mock 成功：ai_result 回写 + ai_status/ocr_status done
    toolsH.__setAiMock(async () => 'MOCK 解读：胎儿生长指标总体正常，建议按时复诊。')
    uniCalls.toasts.length = 0
    const rOn = await reportStore.triggerAiPipeline('rpt_f1')
    await tick()
    assert.equal(uniCalls.requests.length, 0, 'mock 分支零 uni.request')
    assert.equal(uniCalls.uploads.length, 0, 'mock 分支零 uploadFile')
    assert.ok(uniCalls.toasts.some(t => String(t).includes('解读完成')) || rOn === true, `成功提示/真值（实得 ${rOn}，${JSON.stringify(uniCalls.toasts)}）`)
    if (rOn === true) {
      const local = (JSON.parse(storage.get(reportsKey) || '{}').reports || []).find(r => r._id === 'rpt_f1')
      if (local) {
        assert.equal(local.ai_status, 'done', 'ai_status=done')
        assert.equal(local.ocr_status, 'done', 'ocr_status=done')
        assert.ok(local.ai_result && String(local.ai_result.overall_summary || '').includes('MOCK'), `ai_result 回写（实得 ${JSON.stringify(local.ai_result).slice(0, 120)}）`)
      }
    }
    // 服务端权威：ai_result 已落 mc_reports
    const serverDoc = stack.cloud.__docs.get('mc_reports/rpt_f1')
    assert.ok(serverDoc.ai_result && String(serverDoc.ai_result.text).includes('MOCK 解读'), '服务端 mc_reports.ai_result 已回写（E3 网关职责）')
    toolsH.__setAiMock(null)

    // (c) 报告不存在：云端 not-found 如实失败（零 HTTP）
    uniCalls.toasts.length = 0
    const rGhost = await reportStore.triggerAiPipeline('rpt_ghost')
    assert.equal(rGhost, false, '不存在报告返回 false')
    assert.equal(uniCalls.requests.length, 0, '全程 uni.request 恒 0')

    // (d) 演示模式：明确不支持
    storage.set('momcare_token', 'guest_mock_token')
    const rGuest = await reportStore.triggerAiPipeline('rpt_f1')
    assert.equal(rGuest, false, '演示模式返回 false')
    assert.ok(uniCalls.toasts.some(t => String(t).includes('演示模式暂不支持 AI 解读')), '演示模式提示')
    storage.delete('momcare_token')
  })

  await scenario('Audit 5 冻结源哈希：运行期间迁移文件未被并发编辑', async () => {
    for (const [rel, h] of Object.entries(frozenHashes)) {
      const now = sha256(fs.readFileSync(path.join(root, rel)))
      assert.equal(now, h, `${rel} 被并发编辑——结果作废须复跑`)
    }
  })

  console.log(`\n${passed} 通过, ${failed.length} 失败`)
  if (failed.length) { console.log('失败项：'); for (const f of failed) console.log(` - ${f}`); process.exit(1) }
  process.exit(0)
}

main().catch(e => { console.error('套件异常:', e); process.exit(2) })
