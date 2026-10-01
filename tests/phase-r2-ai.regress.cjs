// R2 回归：AI 输入快照/CAS（A11–A13）+ DeepSeek 真实解析路径完整性（A14/A15）+ 覆盖披露（A16）。
// 手法：
// - 真实 mc-tools / mc-reports handler（assemble DIST）+ mock 云（事务 __v 冲突语义）；
//   在途编辑经真实 report.upsert / report.delete 入口（不是直改内存）。
// - A14/A15 走真实生产解析路径：设 DEEPSEEK_API_KEY（合成非真实值，零真实外呼）+
//   monkey-patch node:https.request 注入响应——覆盖 callDeepSeek 的 finish_reason 契约，
//   不用 __setAiMock 替身。
// - A16 用真实 detail.vue / ai-result.vue 页面 bundle（phase-i 同方案：剥 .vue import、
//   shim onLoad/getCurrentInstance、注入 pinia）断言页面级披露文案。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-r2-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')

require('node:child_process').execFileSync('node', [path.join(root, 'cloud/assemble.mjs')], { stdio: 'pipe' })
const DIST = path.join(root, 'dist/cloud-functions')
const toolsH = require(path.join(DIST, 'mc-tools/index.js'))
const reportsH = require(path.join(DIST, 'mc-reports/index.js'))

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-r2a', MC_MEMBER_MAMA_OPENID: 'oR2AMAMA1234567', MC_MEMBER_PAPA_OPENID: 'oR2APAPA1234567' }

// ── mock 云（g-server 同款：docs + 事务 __v 冲突 + getTempFileURL/downloadFile/OCR）──
function makeMockCloud() {
  const docs = new Map()
  const state = { caller: TEST_ENV.MC_MEMBER_MAMA_OPENID, initialized: false, ocrCalls: [], downloadCalls: [] }
  const clone = x => JSON.parse(JSON.stringify(x))
  function docApi(col, id, tx) {
    return {
      get: async () => { const e = docs.get(`${col}/${id}`); if (tx) tx.reads.set(`${col}/${id}`, e ? e.__v : 0); return { data: e ? { ...clone(e), _id: id } : null } },
      set: async ({ data }) => {
        if (data && Object.prototype.hasOwnProperty.call(data, '_id')) { const err = new Error('-501007'); err.errMsg = err.message; throw err }
        if (tx) { tx.writes.set(`${col}/${id}`, clone(data)); return { _id: id } }
        const prev = docs.get(`${col}/${id}`)
        docs.set(`${col}/${id}`, { ...clone(data), __v: (prev ? prev.__v : 0) + 1 }); return { _id: id } }
      ,
      remove: async () => { if (tx) { tx.removes.add(`${col}/${id}`); return {} } docs.delete(`${col}/${id}`); return {} }
    }
  }
  const db = {
    command: { lt: v => ({ __op: 'lt', v }) },
    startTransaction: async () => {
      const tx = { reads: new Map(), writes: new Map(), removes: new Set() }
      return {
        collection: c => ({ doc: id => docApi(c, id, tx) }),
        commit: async () => {
          for (const [k, rv] of tx.reads) {
            const cur2 = docs.get(k)
            if ((cur2 ? cur2.__v : 0) !== rv) { const err = new Error('transaction conflict: ' + k); err.errCode = 'CONFLICT'; throw err }
          }
          for (const k of tx.removes) docs.delete(k)
          for (const [k, d2] of tx.writes) { const prev = docs.get(k); docs.set(k, { ...d2, __v: (prev ? prev.__v : 0) + 1 }) }
        },
        rollback: async () => { tx.writes.clear(); tx.removes.clear() },
      }
    },
    collection: c => ({
      doc: id => docApi(c, id, null),
      where: f => ({
        orderBy: (field, dir) => ({
          limit: n => ({
            get: async () => {
              let rows = [...docs.entries()].filter(([k]) => k.startsWith(c + '/')).map(([k, e]) => ({ ...clone(e), _id: k.slice(c.length + 1) }))
              for (const [k2, v] of Object.entries(f || {})) {
                if (v && typeof v === 'object' && v.__op === 'lt') rows = rows.filter(x => x[k2] !== undefined && String(x[k2]) < String(v.v))
                else rows = rows.filter(x => String(x[k2]) === String(v))
              }
              rows.sort((a, b) => (String(a[field] || '') < String(b[field] || '') ? 1 : -1))
              if (String(dir).toLowerCase() === 'asc') rows.reverse()
              return { data: rows.slice(0, n) }
            }
          })
        })
      })
    })
  }
  return {
    DYNAMIC_CURRENT_ENV: Symbol('env'), init() { state.initialized = true },
    getWXContext: () => ({ APPID: TEST_ENV.MC_APPID, OPENID: state.caller }),
    database() { if (!state.initialized) throw new Error('init first'); return db },
    getTempFileURL: async ({ fileList }) => ({ fileList: fileList.map(f => ({ fileID: f, tempFileURL: 'https://turl.example/' + encodeURIComponent(f) })) }),
    downloadFile: async ({ fileID }) => {
      state.downloadCalls.push(fileID)
      return { fileContent: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24, 7)]) } // jpeg 夹具
    },
    openapi: { ocr: { printedText: async params => { state.ocrCalls.push(params); return { errCode: 0, words_result: [{ words: '双顶径 8.4cm' }] } } } },
    __docs: docs, __state: state, __setCtx(o) { state.caller = o },
  }
}

function jpegFix() { return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24, 7)]) }

function makeStack({ vision = true } = {}) {
  const cloud = makeMockCloud()
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.MC_OCR_PROVIDER
  if (vision) delete process.env.MC_REPORT_VISION
  else process.env.MC_REPORT_VISION = '0'
  toolsH.__setCloud(cloud)
  reportsH.__setCloud(cloud)
  toolsH.__setAiMock(null)
  return { cloud, tools: toolsH, call: e => toolsH.main(e), reports: e => reportsH.main(e) }
}

// 种子：已登记附件 f1..f5
function seedFamily(st) {
  const F = TEST_ENV.MC_FAMILY_ID
  for (const id of ['f1', 'f2', 'f3', 'f4', 'f5']) {
    st.cloud.__docs.set(`mc_files/${id}`, { familyId: F, status: 'registered', formalFileID: `cloud://env/formal/${id}`, __v: 1 })
  }
}
function mkReport(st, id, attachments, extra = {}) {
  st.cloud.__docs.set(`mc_reports/${id}`, {
    familyId: TEST_ENV.MC_FAMILY_ID, deleted: false,
    dateKey: '2026-09-12', reportType: 'ultrasound', note: '孕 32 周超声',
    attachments, revision: 1, updatedBy: 'mama', updatedAt: 1, __v: 1, ...extra
  })
}
let opSeq = 0
const nextOp = p => `${p}_${++opSeq}_${Math.random().toString(36).slice(2, 8)}`
// 真实 mc-reports 编辑/删除入口
async function editNote(st, id, note, expectedRevision) {
  return st.reports({ action: 'report.upsert', id, schemaVersion: 1, operationId: nextOp('r2e'), expectedRevision, payload: { note } })
}
async function editAttachments(st, id, attachments, expectedRevision) {
  return st.reports({ action: 'report.upsert', id, schemaVersion: 1, operationId: nextOp('r2e'), expectedRevision, payload: { attachments } })
}
async function deleteReport(st, id, expectedRevision) {
  return st.reports({ action: 'report.delete', id, schemaVersion: 1, operationId: nextOp('r2d'), expectedRevision })
}

// 门控 AI mock：在途可控释放（A11/A12/A13/A16 用；A14/A15 走真路径不经此）
function armGatedAi(st, answer = 'R2-MOCK 解读：整体与孕周相符，建议按时复诊。') {
  const gates = []
  st.tools.__setAiMock(() => new Promise(resolve => { gates.push(() => resolve(answer)) }))
  return gates
}
const tick = () => new Promise(r => setTimeout(r, 5))

// ── 真实 HTTPS 解析路径注入（A14/A15）：monkey-patch node:https.request ──
function withFakeHttps(responder) {
  const https = require('node:https')
  const original = https.request
  const state = { requested: 0, lastBody: null }
  https.request = (opts, onResponse) => {
    state.requested++
    const req = new EventEmitter()
    req.write = body => { state.lastBody = body }
    req.destroy = e => req.emit('error', e)
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter()
      res.statusCode = responder.status || 200
      onResponse(res)
      const body = typeof responder.body === 'string' ? responder.body : JSON.stringify(responder.body)
      res.emit('data', body)
      res.emit('end')
    })
    return req
  }
  return { state, restore: () => { https.request = original } }
}
const dsOk = (text, finish = 'stop') => ({ choices: [{ message: { content: text }, finish_reason: finish }] })

// ── 客户端读侧 bundle（aiReportView 单源）──
const viewFile = path.join(temp, 'aiReportView.cjs')
esbuild.buildSync({ entryPoints: [path.join(root, 'services/aiReportView.js')], bundle: true, platform: 'node', format: 'cjs', outfile: viewFile, logLevel: 'silent' })
function loadView() { delete require.cache[require.resolve(viewFile)]; return require(viewFile) }

// ── uni 全局替身（页面 bundle 模块加载期即读取）──
const storage = new Map()
const uniCalls = { toasts: [], navs: [] }
global.uni = {
  getStorageSync(k) { return storage.has(k) ? storage.get(k) : '' },
  setStorageSync(k, v) { storage.set(k, v) },
  removeStorageSync(k) { storage.delete(k) },
  getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
  showToast: o => { uniCalls.toasts.push(String((o && o.title) || '')) }, showLoading() {}, hideLoading() {}, showModal() {},
  navigateTo: o => { uniCalls.navs.push(String((o && o.url) || '')) }, redirectTo() {}, switchTab() {}, reLaunch() {}, navigateBack() {},
  request() {}, uploadFile() {}, downloadFile: o => o.fail && o.fail({ errMsg: 'dl' }),
  vibrateShort() {},
}
// ── 页面 bundle：detail.vue（phase-i 同方案）──
const detailFile = path.join(temp, 'detail-page.cjs')
{
  const body = fs.readFileSync(path.join(root, 'pages/archives/detail.vue'), 'utf8').match(/<script setup>([\s\S]*?)<\/script>/)[1]
  const code = body
    .replace(/^import .* from ['"][^'"\n]+\.vue['"];?$/mg, '')
    .replace(/import\s*\{\s*onLoad\s*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const loads=[];const onLoad=fn=>loads.push(fn);')
    .replace('getCurrentInstance().proxy', '({ proxy: null })')
  esbuild.buildSync({
    stdin: {
      contents: code.replace('const reportStore = useReportStore()',
        'import { createPinia, setActivePinia } from "pinia";\nsetActivePinia(createPinia());\nconst reportStore = useReportStore()') +
        '\nexport {famReportToLegacy, report, aiStatus, aiCoverageNote, onAiCardTap, onReanalyze, loads};\nexport {__setWxCloud} from "./services/cloudAdapter.js";\nexport {__adoptSessionForTests, __resetForTests} from "./services/sessionService.js";',
      resolveDir: root
    },
    bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: detailFile, logLevel: 'silent'
  })
}
function loadDetailPage() { delete require.cache[require.resolve(detailFile)]; return require(detailFile) }
// ── 页面 bundle：ai-result.vue ──
const aiResultFile = path.join(temp, 'ai-result-page.cjs')
{
  const body = fs.readFileSync(path.join(root, 'pages/archives/ai-result.vue'), 'utf8').match(/<script setup>([\s\S]*?)<\/script>/)[1]
  const code = body
    .replace(/^import .* from ['"][^'"\n]+\.vue['"];?$/mg, '')
    .replace(/import\s*\{\s*onLoad\s*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const loads=[];const onLoad=fn=>loads.push(fn);')
  esbuild.buildSync({
    stdin: {
      contents: code.replace('const reportStore = useReportStore()',
        'import { createPinia, setActivePinia } from "pinia";\nsetActivePinia(createPinia());\nconst reportStore = useReportStore()') +
        '\nexport {report, aiCoverageNote, aiDisabled, ocrText, ocrHistory};\nexport {__adoptSessionForTests, __resetForTests} from "./services/sessionService.js";',
      resolveDir: root
    },
    bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: aiResultFile, logLevel: 'silent'
  })
}
function loadAiResultPage() { delete require.cache[require.resolve(aiResultFile)]; return require(aiResultFile) }
function loadAiResultPageReady() {
  const client = loadAiResultPage()
  client.__resetForTests()
  client.__adoptSessionForTests({ memberId: 'mama', familyId: TEST_ENV.MC_FAMILY_ID, displayName: '妈妈' })
  return client
}

async function main() {
  console.log('R2 回归：AI 输入快照/CAS + 真实解析路径完整性 + 覆盖披露（A11–A16）\n')

  await scenario('A11 分析在途编辑 note（真实 report.upsert）：旧结果不落库、受控 ai-input-changed', async () => {
    const st = makeStack()
    seedFamily(st)
    mkReport(st, 'rpt_a11', [{ fileId: 'f1' }])
    const gates = armGatedAi(st)
    const pending = st.call({ action: 'ai.analyzeReport', reportId: 'rpt_a11' })
    await tick()
    const edit = await editNote(st, 'rpt_a11', '孕 32 周超声（已补备注）', 1)
    assert.ok(edit.ok && edit.data.record.revision === 2, `真实入口编辑成功（实得 ${JSON.stringify(edit).slice(0, 100)}）`)
    gates[0]()
    const r = await pending
    assert.equal(r.ok, false, '旧输入结果不得成功')
    assert.equal(r.code, 'ai-input-changed', `受控冲突码（实得 ${r.code}）`)
    assert.equal(r.currentRevision, 2, '冲突详情带当前版本')
    const doc = st.cloud.__docs.get('mc_reports/rpt_a11')
    assert.ok(doc.ai_result === undefined && doc.ocr_result === undefined && doc.vision_result === undefined, '零 AI/OCR/视觉写入')
    assert.equal(doc.revision, 2, 'revision 保持编辑后的版本（分析未推进）')
    assert.equal(doc.note, '孕 32 周超声（已补备注）', '编辑内容保留')
  })

  await scenario('A11b 输入摘要独立于 revision：note 变化但版本未动（异常写者）→ 仍拒绝', async () => {
    const st = makeStack()
    seedFamily(st)
    mkReport(st, 'rpt_a11b', [])
    const gates = armGatedAi(st)
    const pending = st.call({ action: 'ai.analyzeReport', reportId: 'rpt_a11b' })
    await tick()
    // 模拟不推进 revision 的异常写入者：直改 note、版本保持 1
    const raw = st.cloud.__docs.get('mc_reports/rpt_a11b')
    st.cloud.__docs.set('mc_reports/rpt_a11b', { ...raw, note: '异常写者改了备注' })
    gates[0]()
    const r = await pending
    assert.equal(r.ok, false)
    assert.equal(r.code, 'ai-input-changed', `按输入摘要拒绝（实得 ${r.code}）`)
    assert.ok(st.cloud.__docs.get('mc_reports/rpt_a11b').ai_result === undefined, '零写入')
  })

  await scenario('A12 分析在途改附件/删除：均不覆盖较新状态', async () => {
    // ① 附件变化（真实 upsert）
    {
      const st = makeStack()
      seedFamily(st)
      mkReport(st, 'rpt_a12a', [{ fileId: 'f1' }])
      const gates = armGatedAi(st)
      const pending = st.call({ action: 'ai.analyzeReport', reportId: 'rpt_a12a' })
      await tick()
      const edit = await editAttachments(st, 'rpt_a12a', [{ fileId: 'f1' }, { fileId: 'f2' }, { fileId: 'f3' }], 1)
      assert.ok(edit.ok && edit.data.record.revision === 2)
      gates[0]()
      const r = await pending
      assert.equal(r.ok, false)
      assert.equal(r.code, 'ai-input-changed', `附件变化拒绝（实得 ${r.code}）`)
      const doc = st.cloud.__docs.get('mc_reports/rpt_a12a')
      assert.ok(doc.ai_result === undefined, '零写入')
      assert.equal(doc.attachments.length, 3, '新附件集合保留')
    }
    // ② 删除（真实 report.delete）
    {
      const st = makeStack()
      seedFamily(st)
      mkReport(st, 'rpt_a12b', [{ fileId: 'f1' }])
      const gates = armGatedAi(st)
      const pending = st.call({ action: 'ai.analyzeReport', reportId: 'rpt_a12b' })
      await tick()
      const del = await deleteReport(st, 'rpt_a12b', 1)
      assert.ok(del.ok, `真实删除成功（实得 ${JSON.stringify(del).slice(0, 80)}）`)
      gates[0]()
      const r = await pending
      assert.equal(r.ok, false)
      assert.equal(r.code, 'report-not-found', `删除后拒绝（实得 ${r.code}）`)
      const doc = st.cloud.__docs.get('mc_reports/rpt_a12b')
      assert.equal(doc.deleted, true, '墓碑保留')
      assert.ok(doc.ai_result === undefined, '零写入')
    }
    // ③ 并发两分析：先提交者胜，后者受控冲突——不互相覆盖
    {
      const st = makeStack()
      seedFamily(st)
      mkReport(st, 'rpt_a12c', [])
      const gates = armGatedAi(st)
      const first = st.call({ action: 'ai.analyzeReport', reportId: 'rpt_a12c' })
      const second = st.call({ action: 'ai.analyzeReport', reportId: 'rpt_a12c' })
      await tick(); await tick()
      assert.equal(gates.length, 2, '两个分析都在途（各自闸门）')
      gates[0]()
      const r1 = await first
      await tick()
      gates[1]()
      const r2 = await second
      assert.equal(r1.ok, true, '先提交者成功')
      assert.equal(r2.ok, false, '后者不得覆盖')
      assert.equal(r2.code, 'ai-input-changed', `并发冲突受控（实得 ${r2.code}）`)
      const doc = st.cloud.__docs.get('mc_reports/rpt_a12c')
      assert.equal(doc.revision, 2, '恰一次写入（revision+1）')
      assert.ok(doc.ai_result && doc.ai_result.text.includes('R2-MOCK'), '结果=先提交者')
    }
  })

  await scenario('A13 未变更输入正常成功：DB/响应 revision 与 provenance 一致；客户端正确显示新鲜/过期', async () => {
    const st = makeStack()
    seedFamily(st)
    mkReport(st, 'rpt_a13', [{ fileId: 'f1' }])
    st.tools.__setAiMock(async () => 'R2-A13 解读：指标正常。')
    const r = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_a13' })
    assert.equal(r.ok, true)
    const doc = st.cloud.__docs.get('mc_reports/rpt_a13')
    assert.equal(doc.revision, 2, 'revision=base+1')
    assert.equal(doc.ai_result.baseRevision, 1, '落库 baseRevision=分析时版本')
    assert.equal(r.data.reportRevision, 2, '响应 revision=实际提交版本')
    assert.equal(r.data.baseRevision, 1)
    assert.deepEqual(r.data.coverage, doc.ai_result.coverage, '响应 coverage 与数据库一致')
    assert.deepEqual(doc.ai_result.coverage, { analyzedCount: 1, totalAttachments: 1, analyzedFileIds: ['f1'], skippedFileIds: [], mode: 'vision' }, 'coverage provenance 完整（含 mode）')
    assert.equal(typeof doc.ai_result.inputDigest, 'string', '输入摘要落库')
    assert.equal(doc.ai_result.inputDigest.length, 64, 'SHA-256 十六进制')
    // 客户端读侧：新鲜 → 编辑后过期（版本链，不靠 generatedAt）
    const view = loadView()
    const fresh = view.familyAiView({ ...doc, attachments: [{ fileId: 'f1' }] })
    assert.equal(fresh.ai_status, 'done')
    assert.equal(fresh.ai_stale, false, '新鲜不标过期')
    assert.equal(fresh.ai_coverage.complete, true, '覆盖完整')
    const edit = await editNote(st, 'rpt_a13', '编辑后的备注', 2)
    assert.ok(edit.ok)
    const doc2 = st.cloud.__docs.get('mc_reports/rpt_a13')
    const staleView = view.familyAiView({ ...doc2, attachments: [{ fileId: 'f1' }] })
    assert.equal(staleView.ai_stale, true, '编辑后正确显示过期（基于旧版本）')
    // 旧结果（无 baseRevision/coverage）：不称过期也不称覆盖完整
    const legacy = view.familyAiView({ deleted: false, revision: 9, attachments: [{ fileId: 'f1' }, { fileId: 'f2' }], ai_result: { text: '旧结果', model: 'deepseek-flash', generatedAt: 1 } })
    assert.equal(legacy.ai_stale, false, '旧结果无法判定——不谎称过期')
    assert.equal(legacy.ai_coverage.unknown, true, '旧结果覆盖未知')
    assert.equal(legacy.ai_coverage.complete, false, '未知覆盖不得称完整')
    // store 冲突分支接线（源码断言——真实提示路径）
    const storeSrc = fs.readFileSync(path.join(root, 'stores/report.js'), 'utf8')
    assert.ok(storeSrc.includes("res.code === 'ai-input-changed'"), 'triggerAiPipeline 识别冲突码')
    assert.ok(storeSrc.includes('报告在分析期间被修改，本次结果未保存，请重新分析'), '冲突提示文案在位')
  })

  await scenario('A14 真实生产解析路径 finish_reason:length 即使有正文也失败，DB 写入 0', async () => {
    const st = makeStack({ vision: false })
    seedFamily(st)
    mkReport(st, 'rpt_a14', [])
    process.env.DEEPSEEK_API_KEY = 'synthetic-not-a-real-key' // 走真实 callDeepSeek（https 注入，零真实外呼）
    const fake = withFakeHttps({ body: dsOk('被截断的正文内容——不应被采纳', 'length') })
    try {
      const r = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_a14' })
      assert.equal(fake.state.requested, 1, '真实 https 路径被调用')
      assert.equal(r.ok, false, '截断不得成功')
      assert.equal(r.code, 'ai-truncated', `受控截断码（实得 ${r.code}）`)
      assert.ok(String(r.errMsg || '').includes('ai-truncated'), 'errMsg 带原因')
      const doc = st.cloud.__docs.get('mc_reports/rpt_a14')
      assert.ok(doc.ai_result === undefined && doc.ocr_result === undefined && doc.vision_result === undefined, 'DB 分析写入 0')
      assert.equal(doc.revision, 1, 'revision 不动')
    } finally {
      fake.restore()
      delete process.env.DEEPSEEK_API_KEY
    }
  })

  await scenario('A15 真实解析路径矩阵：stop 正常；缺失/畸形/过滤/HTTP 错误/空 content 不冒充成功', async () => {
    const cases = [
      { name: 'stop 正常成功', body: dsOk('完整解读正文——正常终止。'), expectOk: true },
      { name: 'finish_reason 缺失', body: { choices: [{ message: { content: 'x' } }] }, expectCode: 'ai-call-failed', errMatch: 'ai-unknown-finish' },
      { name: 'content_filter', body: dsOk('x', 'content_filter'), expectCode: 'ai-content-filtered' },
      { name: '畸形 JSON', body: 'not-json{{{', expectCode: 'ai-call-failed', errMatch: 'ai-malformed-response' },
      { name: 'HTTP 500 供应商错误', status: 500, body: { error: { message: 'server overloaded' } }, expectCode: 'ai-call-failed', errMatch: 'ai-http-error:500' },
      { name: '空 content', body: { choices: [{ message: { content: '' }, finish_reason: 'stop' }] }, expectCode: 'ai-call-failed', errMatch: 'ai-empty-response' },
      { name: 'choices 缺失', body: { object: 'chat.completion' }, expectCode: 'ai-call-failed', errMatch: 'ai-empty-response' },
    ]
    for (let ci = 0; ci < cases.length; ci++) {
      const c = cases[ci]
      const rid = `rpt_a15_${ci}`
      const st = makeStack({ vision: false })
      seedFamily(st)
      mkReport(st, rid, [])
      process.env.DEEPSEEK_API_KEY = 'synthetic-not-a-real-key'
      const fake = withFakeHttps({ status: c.status, body: c.body })
      try {
        const r = await st.call({ action: 'ai.analyzeReport', reportId: rid })
        assert.equal(fake.state.requested, 1, `${c.name}：真实路径被调用`)
        if (c.expectOk) {
          assert.equal(r.ok, true, `${c.name} 应成功`)
          const doc = st.cloud.__docs.get(`mc_reports/${rid}`)
          assert.ok(doc.ai_result && doc.ai_result.text.includes('完整解读正文'), `${c.name}：正常写入`)
          assert.equal(doc.ai_result.coverage.totalAttachments, 0, `${c.name}：无附件覆盖完整`)
        } else {
          assert.equal(r.ok, false, `${c.name} 不得冒充成功`)
          assert.equal(r.code, c.expectCode, `${c.name}：受控码（实得 ${r.code}）`)
          if (c.errMatch) assert.ok(String(r.errMsg || '').includes(c.errMatch), `${c.name}：errMsg 含 ${c.errMatch}（实得 ${r.errMsg}）`)
          const doc = st.cloud.__docs.get(`mc_reports/${rid}`)
          assert.ok(doc.ai_result === undefined, `${c.name}：零写入`)
          assert.equal(doc.revision, 1, `${c.name}：revision 不动`)
        }
      } finally {
        fake.restore()
        delete process.env.DEEPSEEK_API_KEY
      }
    }
  })

  await scenario('A16 视觉直读 5 附件：coverage 3/5 落库+响应，页面披露 x/y 与未分析', async () => {
    const st = makeStack({ vision: true })
    seedFamily(st)
    mkReport(st, 'rpt_a16', [{ fileId: 'f1' }, { fileId: 'f2' }, { fileId: 'f3' }, { fileId: 'f4' }, { fileId: 'f5' }])
    st.tools.__setAiMock(async () => 'R2-A16 视觉解读：所见指标正常。')
    const r = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_a16' })
    assert.equal(r.ok, true)
    assert.equal(r.data.visionIncluded, true, '视觉模式')
    const doc = st.cloud.__docs.get('mc_reports/rpt_a16')
    assert.deepEqual(doc.ai_result.coverage, { analyzedCount: 3, totalAttachments: 5, analyzedFileIds: ['f1', 'f2', 'f3'], skippedFileIds: ['f4', 'f5'], mode: 'vision' }, '覆盖 provenance 落库（3/5 + 未分析清单 + mode）')
    assert.equal(doc.vision_result.pageCount, 3, 'vision_result 页数')
    // 客户端读侧：不称完整
    const view = loadView()
    const v = view.familyAiView({ ...doc, attachments: [{ fileId: 'f1' }, { fileId: 'f2' }, { fileId: 'f3' }, { fileId: 'f4' }, { fileId: 'f5' }] })
    assert.deepEqual(v.ai_coverage, { analyzed: 3, total: 5, complete: false, unknown: false, mode: 'vision', ocrTruncated: false }, '读侧覆盖形状（含 mode；F3 新增 ocrTruncated 字段——视觉/非截断恒 false）')
    // 真实详情页：披露文案
    const page = loadDetailPage()
    page.report.value = page.famReportToLegacy({ id: 'rpt_a16', ...doc })
    assert.equal(page.aiCoverageNote.value, '已分析 3/5 个附件（2 个未分析——单次页数上限）', `详情页披露（实得 ${page.aiCoverageNote.value}）`)
    assert.equal(page.report.value.ai_stale, false)
    // 真实 ai-result 页：同样披露
    const aiPage = loadAiResultPageReady()
    aiPage.report.value = { _id: 'rpt_a16', report_type: 'ultrasound', report_date: '2026-09-12', ...view.familyAiView({ ...doc, attachments: doc.attachments }) }
    assert.equal(aiPage.aiCoverageNote.value, '已分析 3/5 个附件（2 个未分析——单次页数上限）', `结果页披露（实得 ${aiPage.aiCoverageNote.value}）`)
    assert.equal(aiPage.aiDisabled.value, false, '有真实结果可展示')
  })

  await scenario('A16b OCR 模式 5 附件：coverage 同样 3/5；旧结果页面显示覆盖未知', async () => {
    // OCR 路径（vision 关、wechat OCR）
    {
      const st = makeStack({ vision: false })
      seedFamily(st)
      mkReport(st, 'rpt_a16b', [{ fileId: 'f1' }, { fileId: 'f2' }, { fileId: 'f3' }, { fileId: 'f4' }, { fileId: 'f5' }])
      process.env.MC_OCR_PROVIDER = 'wechat'
      st.tools.__setAiMock(async () => 'R2-A16b OCR 解读。')
      const r = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_a16b' })
      assert.equal(r.ok, true)
      const doc = st.cloud.__docs.get('mc_reports/rpt_a16b')
      assert.equal(doc.ai_result.coverage.analyzedCount, 3, 'OCR 页数上限 3')
      assert.equal(doc.ai_result.coverage.totalAttachments, 5)
      assert.deepEqual(doc.ai_result.coverage.skippedFileIds, ['f4', 'f5'])
      assert.equal(st.cloud.__state.ocrCalls.length, 3, 'printedText 恰 3 次')
    }
    // 旧结果（无 coverage）：真实详情页显示"覆盖范围未知"——不称完整
    {
      const st = makeStack()
      seedFamily(st)
      mkReport(st, 'rpt_a16old', [{ fileId: 'f1' }, { fileId: 'f2' }], {
        revision: 5,
        ai_result: { text: '历史版本结果正文', model: 'deepseek-flash', generatedAt: 1 } // R2 前格式：无 baseRevision/coverage
      })
      const doc = st.cloud.__docs.get('mc_reports/rpt_a16old')
      const page = loadDetailPage()
      page.report.value = page.famReportToLegacy({ id: 'rpt_a16old', ...doc })
      assert.equal(page.aiStatus.value, 'done')
      assert.ok(String(page.aiCoverageNote.value).includes('覆盖范围未知'), `旧结果页面披露未知（实得 ${page.aiCoverageNote.value}）`)
      assert.ok(!/已分析 \d+\//.test(String(page.aiCoverageNote.value)), `未知覆盖不披露 x/y 计数（实得 ${page.aiCoverageNote.value}）`)
      const aiPage = loadAiResultPageReady()
      const view = loadView()
      aiPage.report.value = { _id: 'x', report_type: 'ultrasound', ...view.familyAiView({ ...doc, attachments: doc.attachments }) }
      assert.ok(String(aiPage.aiCoverageNote.value).includes('覆盖范围未知'), '结果页同样披露未知')
    }
    // 过期展示（真实详情页 + ai-result 页）
    {
      const st = makeStack()
      seedFamily(st)
      mkReport(st, 'rpt_a16stale', [{ fileId: 'f1' }], {
        revision: 7,
        ai_result: { text: '将过期的结果', model: 'deepseek-flash', generatedAt: 1, baseRevision: 2, coverage: { analyzedCount: 1, totalAttachments: 1, analyzedFileIds: ['f1'], skippedFileIds: [] } }
      })
      const doc = st.cloud.__docs.get('mc_reports/rpt_a16stale')
      const page = loadDetailPage()
      page.report.value = page.famReportToLegacy({ id: 'rpt_a16stale', ...doc })
      assert.equal(page.report.value.ai_stale, true, '详情页过期标记（7 > 2+1）')
      const aiPage = loadAiResultPageReady()
      const view = loadView()
      aiPage.report.value = { _id: 'x', report_type: 'ultrasound', ...view.familyAiView({ ...doc, attachments: doc.attachments }) }
      assert.equal(aiPage.report.value.ai_stale, true, '结果页过期标记')
    }
  })

  // ══ R2 第一轮审核反例（R2_REVIEW_NOTES 1–3）══

  await scenario('R2R-1 过期结果可用重新分析入口：卡片 tap 只导航、按钮真调网关、冲突不伪装新完成', async () => {
    const st = makeStack()
    seedFamily(st)
    // 种子：已过期结果（revision 6，结果基于 baseRevision 2、覆盖完整）
    mkReport(st, 'rpt_r2r1', [{ fileId: 'f1' }], {
      revision: 6,
      ai_result: { text: '旧版解读：整体正常。', model: 'deepseek-flash', generatedAt: 1, baseRevision: 2, inputDigest: 'a'.repeat(64), coverage: { analyzedCount: 1, totalAttachments: 1, analyzedFileIds: ['f1'], skippedFileIds: [], mode: 'vision' } }
    })
    // 网关路由：真实 mc-reports/mc-tools handler + 计数；mc-health 容错失败（配额同步吞错）
    const aiCalls = []
    const wxCloudStub = {
      init() {},
      callFunction(o) {
        const h = {
          'mc-reports': e => reportsH.main(e),
          'mc-tools': e => { if (e && e.action === 'ai.analyzeReport') aiCalls.push(e); return toolsH.main(e) },
          'mc-identity': () => ({ ok: true, data: { memberId: 'mama', displayName: '妈妈', familyId: TEST_ENV.MC_FAMILY_ID } }),
          'mc-health': () => Promise.resolve({ ok: false, code: 'not-configured' })
        }[o.name]
        if (!h) { o.fail && o.fail({ errMsg: 'no route: ' + o.name }); return }
        Promise.resolve().then(() => h(o.data)).then(r => o.success({ result: r })).catch(e => o.fail && o.fail({ errMsg: e.message }))
      }
    }
    uniCalls.navs.length = 0
    uniCalls.toasts.length = 0
    const client = loadDetailPage()
    client.__setWxCloud(wxCloudStub)
    client.__resetForTests()
    client.__adoptSessionForTests({ memberId: 'mama', familyId: TEST_ENV.MC_FAMILY_ID, displayName: '妈妈' })
    for (const fn of client.loads) await fn({ id: 'rpt_r2r1' })
    for (let i = 0; i < 8; i++) await tick()
    assert.equal(client.report.value.ai_status, 'done', '加载到已解读报告')
    assert.equal(client.report.value.ai_stale, true, '过期标记（6 > 2+1）')
    // ① 卡片 tap：只导航查看原结果，不触发分析
    await client.onAiCardTap()
    assert.equal(uniCalls.navs.length, 1, 'tap=查看原解读（导航）')
    assert.ok(uniCalls.navs[0].includes('ai-result'), `导航到结果页（实得 ${uniCalls.navs[0]}）`)
    assert.equal(aiCalls.length, 0, 'tap 不发起分析')
    // ② 重新分析按钮：真调网关成功 → 刷新不再过期 + 导航新结果
    st.tools.__setAiMock(async () => 'R2R-1 重新分析的新解读。')
    await client.onReanalyze()
    for (let i = 0; i < 8; i++) await tick()
    assert.equal(aiCalls.length, 1, '网关恰被调用一次（真实 ai.analyzeReport）')
    assert.equal(aiCalls[0].reportId, 'rpt_r2r1')
    assert.equal(client.report.value.ai_stale, false, '刷新后不再过期')
    assert.ok(client.report.value.ai_result.overall_summary.includes('R2R-1'), '新结果正文在位')
    assert.equal(uniCalls.navs.length, 2, '成功且不再过期才导航到新结果')
    const doc = st.cloud.__docs.get('mc_reports/rpt_r2r1')
    assert.equal(doc.revision, 7, '服务端恰一次写入')
    assert.equal(doc.ai_result.baseRevision, 6, '新结果基于当前版本')
    // ③ 冲突：分析在途再编辑 → 受控失败，不伪装新完成
    await editNote(st, 'rpt_r2r1', '又一次编辑', 7)
    st.tools.__setAiMock(() => new Promise(resolve => {
      // 在途编辑（真实入口）→ 旧结果必被 CAS 拒绝
      editNote(st, 'rpt_r2r1', '在途编辑', 8).then(() => resolve('将被拒绝的结果'))
    }))
    uniCalls.toasts.length = 0
    uniCalls.navs.length = 0
    await client.onReanalyze()
    for (let i = 0; i < 8; i++) await tick()
    assert.ok(uniCalls.toasts.some(t => t.includes('报告在分析期间被修改')), `冲突如实提示（实得 ${JSON.stringify(uniCalls.toasts)}）`)
    assert.equal(client.report.value.ai_status, 'done', '保留已有有效结果（不伪装新完成）')
    assert.equal(client.report.value.ai_stale, true, '仍过期（基于旧版本）')
    assert.ok(!client.report.value.ai_result.overall_summary.includes('将被拒绝'), '被拒结果未入库/未上屏')
    assert.equal(uniCalls.navs.length, 0, '失败不导航')
  })

  await scenario('R2R-2 模式切换+改附件：旧 OCR/vision 残留不被当成本次"原文提取"', async () => {
    const view = loadView()
    // ① OCR 模式首跑：同输入展示提取原文
    const st = makeStack({ vision: false })
    seedFamily(st)
    mkReport(st, 'rpt_r2r2', [{ fileId: 'f1' }, { fileId: 'f2' }, { fileId: 'f3' }])
    process.env.MC_OCR_PROVIDER = 'wechat'
    st.tools.__setAiMock(async () => '第一次（OCR 模式）解读。')
    const r1 = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_r2r2' })
    assert.equal(r1.ok, true)
    const doc1 = st.cloud.__docs.get('mc_reports/rpt_r2r2')
    assert.ok(doc1.ocr_result && doc1.ocr_result.text.includes('双顶径'), 'OCR 提取在库')
    assert.equal(doc1.ocr_result.inputDigest, doc1.ai_result.inputDigest, '提取结果带输入快照溯源')
    const v1 = view.familyAiView({ ...doc1, attachments: doc1.attachments })
    assert.ok(v1.ocr_text.includes('双顶径'), '同输入 → 提取原文作为本次内容展示')
    // ② 改附件（真实 upsert +f4）→ 视觉模式重分析：旧 OCR 保留在库但不属于本次
    await editAttachments(st, 'rpt_r2r2', [{ fileId: 'f1' }, { fileId: 'f2' }, { fileId: 'f3' }, { fileId: 'f4' }], doc1.revision)
    delete process.env.MC_REPORT_VISION
    st.tools.__setAiMock(async () => '第二次（视觉模式）解读。')
    const r2 = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_r2r2' })
    assert.equal(r2.ok, true)
    const doc2 = st.cloud.__docs.get('mc_reports/rpt_r2r2')
    assert.notEqual(doc2.ai_result.inputDigest, doc1.ocr_result.inputDigest, '新结果输入快照已变')
    assert.ok(doc2.ocr_result && doc2.ocr_result.text.includes('双顶径'), '历史 OCR 原样保留（不删用户数据）')
    assert.ok(doc2.vision_result && doc2.vision_result.inputDigest === doc2.ai_result.inputDigest, 'vision_result 带本次快照')
    const v2 = view.familyAiView({ ...doc2, attachments: doc2.attachments })
    assert.equal(v2.ocr_text, '', '跨输入残留的旧 OCR 不当成本次"原文提取"')
    assert.equal(v2.ai_coverage.mode, 'vision', '读侧 mode=vision')
    assert.equal(v2.ai_coverage.analyzed, 3, '视觉 3/4')
    // ③ 再改附件 → 元数据模式（无 OCR 提供方）：残留同样不展示
    await editAttachments(st, 'rpt_r2r2', [{ fileId: 'f1' }, { fileId: 'f2' }, { fileId: 'f3' }, { fileId: 'f4' }, { fileId: 'f5' }], doc2.revision)
    process.env.MC_REPORT_VISION = '0'
    delete process.env.MC_OCR_PROVIDER
    st.tools.__setAiMock(async () => '第三次（元数据模式）解读。')
    const r3 = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_r2r2' })
    assert.equal(r3.ok, true)
    const doc3 = st.cloud.__docs.get('mc_reports/rpt_r2r2')
    assert.equal(doc3.ai_result.coverage.mode, 'metadata', '元数据模式标注')
    const v3 = view.familyAiView({ ...doc3, attachments: doc3.attachments })
    assert.equal(v3.ocr_text, '', '旧 OCR/视觉残留不随元数据结果展示')
    assert.equal(v3.ai_coverage.mode, 'metadata')
    // ④ 旧格式对（双方无 digest）：同源不可证明（R2 前 vision/metadata 成功保留更旧 OCR）
    const legacy = view.familyAiView({ deleted: false, revision: 3, attachments: [{ fileId: 'f1' }], ai_result: { text: '旧结果', model: 'x', generatedAt: 1 }, ocr_result: { text: '旧提取原文', included: true } })
    assert.equal(legacy.ocr_text, '', '无 digest 不得标为本次原文（同源不可证明）')
    assert.deepEqual(legacy.ocr_history, { text: '旧提取原文', unverified: true }, '历史提取走独立未确认通道（不清除历史字段）')
  })

  await scenario('R2R-3 元数据模式未覆盖原因如实：未读取附件（非页数上限）', async () => {
    const st = makeStack({ vision: false }) // vision 关 + 无 OCR 提供方 → 元数据模式
    seedFamily(st)
    mkReport(st, 'rpt_r2r3', [{ fileId: 'f1' }, { fileId: 'f2' }, { fileId: 'f3' }, { fileId: 'f4' }, { fileId: 'f5' }])
    st.tools.__setAiMock(async () => '元数据模式解读。')
    const r = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_r2r3' })
    assert.equal(r.ok, true)
    const doc = st.cloud.__docs.get('mc_reports/rpt_r2r3')
    assert.deepEqual(doc.ai_result.coverage, { analyzedCount: 0, totalAttachments: 5, analyzedFileIds: [], skippedFileIds: ['f1', 'f2', 'f3', 'f4', 'f5'], mode: 'metadata' }, '元数据覆盖 provenance')
    // 真实详情页 + 结果页：未覆盖原因=未读取附件，不猜成页数上限
    const page = loadDetailPage()
    page.report.value = page.famReportToLegacy({ id: 'rpt_r2r3', ...doc })
    assert.equal(page.aiCoverageNote.value, '本次仅分析报告元数据：未读取任何附件（共 5 个）', `详情页如实（实得 ${page.aiCoverageNote.value}）`)
    const aiPage = loadAiResultPageReady()
    const view = loadView()
    aiPage.report.value = { _id: 'rpt_r2r3', report_type: 'ultrasound', ...view.familyAiView({ ...doc, attachments: doc.attachments }) }
    assert.equal(aiPage.aiCoverageNote.value, '本次仅分析报告元数据：未读取任何附件（共 5 个）', `结果页如实（实得 ${aiPage.aiCoverageNote.value}）`)
  })

  // ══ R2 第二轮审核反例（R2_REVIEW_ROUND2：历史无 digest 的 OCR 来源边界）══

  await scenario('R2二 历史无 digest：AI 较新/OCR 较旧且附件已变——不标本次原文，独立历史提取', async () => {
    const view = loadView()
    // 历史形状（R2 前生产写法可产生：先 OCR 于旧附件 → 改附件 → vision/metadata 成功
    // 保留旧 OCR 且重写 ai_result——双方均无 digest，OCR 更旧）：
    const legacyRec = {
      deleted: false,
      revision: 5,
      attachments: [{ fileId: 'f4' }, { fileId: 'f5' }],            // 已变化（OCR 时是 f1..f3）
      ai_result: { text: '较新的解读（vision 时代）', model: 'deepseek-flash', generatedAt: 900 },  // 无 digest
      ocr_result: { text: '旧附件的 OCR 提取：双顶径 8.4cm', included: true, provider: 'wechat', generatedAt: 100, pageFileIds: ['f1', 'f2', 'f3'] }  // 更旧、无 digest
    }
    const v = view.familyAiView(legacyRec)
    assert.equal(v.ai_status, 'done')
    assert.equal(v.ocr_text, '', '未知来源 OCR 不标为本次"原文提取"')
    assert.deepEqual(v.ocr_history, { text: '旧附件的 OCR 提取：双顶径 8.4cm', unverified: true }, '历史提取保留并独立标注未确认')
    // 真实 ai-result 页面消费者：本次原文块不渲染、历史块数据在且带未确认标记
    const aiPage = loadAiResultPageReady()
    aiPage.report.value = { _id: 'rpt_hist', report_type: 'ultrasound', report_date: '2026-09-12', ...v }
    assert.equal(aiPage.ocrText.value, '', '页面本次原文提取为空（块不渲染）')
    assert.ok(aiPage.ocrHistory.value && aiPage.ocrHistory.value.unverified === true, '页面历史提取数据在（独立块渲染源）')
    assert.ok(String(aiPage.ocrHistory.value.text).includes('旧附件的 OCR'), '历史内容可核对')
    // 页面模板消费证据（真实源码）：独立标题 + 仅当本次无已证明提取时展示
    const src = fs.readFileSync(path.join(root, 'pages/archives/ai-result.vue'), 'utf8')
    assert.ok(src.includes('历史提取（来源未确认）'), '独立标题在位（与"报告原文提取（OCR）"区分）')
    assert.ok(src.includes('v-if="!ocrText && ocrHistory"'), '历史块仅在本此无已证明提取时展示')
    assert.ok(src.includes('未能确认属于本次解读的输入'), '来源未确认如实说明')
    // 已证明路径不受影响（回归）：同 digest 仍展示为本次原文
    const provenRec = {
      deleted: false, revision: 2, attachments: [{ fileId: 'f1' }],
      ai_result: { text: '本次解读', model: 'deepseek-flash', generatedAt: 9, inputDigest: 'd1', baseRevision: 1, coverage: { analyzedCount: 1, totalAttachments: 1, analyzedFileIds: ['f1'], skippedFileIds: [], mode: 'ocr' } },
      ocr_result: { text: '本次输入的提取', included: true, inputDigest: 'd1', baseRevision: 1 }
    }
    const pv = view.familyAiView(provenRec)
    assert.equal(pv.ocr_text, '本次输入的提取', 'digest 一致仍为本次原文')
    assert.equal(pv.ocr_history, null, '无历史通道数据')
  })

  console.log(`\nphase-r2-ai：${passed} 通过，${failed.length} 失败`)
  if (failed.length > 0) { console.log('失败场景：', failed.join(' | ')); process.exit(1) }
}

main().catch(e => { console.error('套件异常:', e); process.exit(2) })
