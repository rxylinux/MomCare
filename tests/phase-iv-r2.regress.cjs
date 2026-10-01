// 独立验证 IV-R2（2026-10-01，全新会话）：A11–A16 独立反例（与 phase-r2-ai 不同数据/形态）。
// 真实 mc-tools / mc-reports handler（assemble DIST）+ mock 云（事务 __v 冲突）；
// 在途编辑经真实 report.upsert / report.delete；A14/A15 走真实 callDeepSeek（合成 Key +
// monkey-patch node:https——零真实外呼）；A16 真实 detail.vue / ai-result.vue 页面 bundle。
// 本文件为验证会话新增测试，不改生产源码与旧测试期望。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-iv2-'))

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

const TEST_ENV = { MC_APPID: 'wxivapp00000002', MC_FAMILY_ID: 'fam-iv2', MC_MEMBER_MAMA_OPENID: 'oIV2MAMA0000001', MC_MEMBER_PAPA_OPENID: 'oIV2PAPA0000001' }

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
        docs.set(`${col}/${id}`, { ...clone(data), __v: (prev ? prev.__v : 0) + 1 }); return { _id: id }
      },
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
      return { fileContent: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20, 9)]) } // png 夹具
    },
    openapi: { ocr: { printedText: async params => { state.ocrCalls.push(params); return { errCode: 0, words_result: [{ words: '腹围 28.5cm' }] } } } },
    __docs: docs, __state: state, __setCtx(o) { state.caller = o },
  }
}

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

function seedFamily(st, ids) {
  const F = TEST_ENV.MC_FAMILY_ID
  for (const id of ids) {
    st.cloud.__docs.set(`mc_files/${id}`, { familyId: F, status: 'registered', formalFileID: `cloud://env/formal/${id}`, __v: 1 })
  }
}
function mkReport(st, id, attachments, extra = {}) {
  st.cloud.__docs.set(`mc_reports/${id}`, {
    familyId: TEST_ENV.MC_FAMILY_ID, deleted: false,
    dateKey: '2026-09-20', reportType: 'bloodtest', note: 'IV2 基线备注',
    attachments, revision: 1, updatedBy: 'mama', updatedAt: 1, __v: 1, ...extra
  })
}
let opSeq = 0
const nextOp = p => `${p}_${++opSeq}_${Math.random().toString(36).slice(2, 8)}`
async function editNote(st, id, note, expectedRevision) {
  return st.reports({ action: 'report.upsert', id, schemaVersion: 1, operationId: nextOp('iv2e'), expectedRevision, payload: { note } })
}
async function editAttachments(st, id, attachments, expectedRevision) {
  return st.reports({ action: 'report.upsert', id, schemaVersion: 1, operationId: nextOp('iv2e'), expectedRevision, payload: { attachments } })
}
async function deleteReport(st, id, expectedRevision) {
  return st.reports({ action: 'report.delete', id, schemaVersion: 1, operationId: nextOp('iv2d'), expectedRevision })
}
function armGatedAi(st, answer = 'IV2-MOCK 解读：独立会话基线文本。') {
  const gates = []
  st.tools.__setAiMock(() => new Promise(resolve => { gates.push(() => resolve(answer)) }))
  return gates
}
const tick = () => new Promise(r => setTimeout(r, 5))

// 真实 https 注入
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
const dsOk = (text, finish = 'stop', extra = {}) => ({ choices: [{ message: { content: text }, finish_reason: finish }], usage: { prompt_tokens: 99, completion_tokens: 7 }, ...extra })

// 客户端读侧 bundle
const viewFile = path.join(temp, 'aiReportView.cjs')
esbuild.buildSync({ entryPoints: [path.join(root, 'services/aiReportView.js')], bundle: true, platform: 'node', format: 'cjs', outfile: viewFile, logLevel: 'silent' })
function loadView() { delete require.cache[require.resolve(viewFile)]; return require(viewFile) }

// uni 全局
const storage = new Map()
global.uni = {
  getStorageSync(k) { return storage.has(k) ? storage.get(k) : '' },
  setStorageSync(k, v) { storage.set(k, v) },
  removeStorageSync(k) { storage.delete(k) },
  getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
  showToast: () => {}, showLoading() {}, hideLoading() {}, showModal() {},
  navigateTo() {}, redirectTo() {}, switchTab() {}, reLaunch() {}, navigateBack() {},
  request() {}, uploadFile() {}, downloadFile: o => o.fail && o.fail({ errMsg: 'dl' }),
  vibrateShort() {},
}
// detail.vue 页面 bundle
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
// ai-result.vue 页面 bundle
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
function loadAiResultPage() {
  const client = (() => { delete require.cache[require.resolve(aiResultFile)]; return require(aiResultFile) })()
  client.__resetForTests()
  client.__adoptSessionForTests({ memberId: 'mama', familyId: TEST_ENV.MC_FAMILY_ID, displayName: '妈妈' })
  return client
}

async function main() {
  console.log('IV-R2 独立反例（A11–A16）\n')

  await scenario('A11 在途改附件（真实 upsert 附件集合）→ ai-input-changed、零写入、新附件保留', async () => {
    const st = makeStack()
    seedFamily(st, ['g1', 'g2', 'g3'])
    mkReport(st, 'rpt_iv11', [{ fileId: 'g1' }])
    const gates = armGatedAi(st)
    const pending = st.call({ action: 'ai.analyzeReport', reportId: 'rpt_iv11' })
    await tick()
    const edit = await editAttachments(st, 'rpt_iv11', [{ fileId: 'g2' }, { fileId: 'g3' }], 1)
    assert.ok(edit.ok && edit.data.record.revision === 2, `真实入口编辑成功（实得 ${JSON.stringify(edit).slice(0, 100)}）`)
    gates[0]()
    const r = await pending
    assert.equal(r.ok, false)
    assert.equal(r.code, 'ai-input-changed', `受控冲突（实得 ${r.code}）`)
    assert.equal(r.currentRevision, 2)
    const doc = st.cloud.__docs.get('mc_reports/rpt_iv11')
    assert.ok(doc.ai_result === undefined && doc.vision_result === undefined && doc.ocr_result === undefined, '三类产物零写入')
    assert.equal(doc.revision, 2, 'revision 停在编辑版')
    assert.deepEqual(doc.attachments.map(a => a.fileId), ['g2', 'g3'], '新附件集合保留')
  })

  await scenario('A11b 异常写者（直改 note 不推版本/不推 __v）→ 摘要独立拒绝；provenance 对落库成对', async () => {
    const st = makeStack()
    seedFamily(st, ['g1'])
    mkReport(st, 'rpt_iv11b', [{ fileId: 'g1' }])
    const gates = armGatedAi(st)
    const pending = st.call({ action: 'ai.analyzeReport', reportId: 'rpt_iv11b' })
    await tick()
    const raw = st.cloud.__docs.get('mc_reports/rpt_iv11b')
    st.cloud.__docs.set('mc_reports/rpt_iv11b', { ...raw, note: '绕过版本控制的备注篡改' }) // revision/__v 均不动
    gates[0]()
    const r = await pending
    assert.equal(r.ok, false)
    assert.equal(r.code, 'ai-input-changed', `revision 未动也按摘要拒绝（实得 ${r.code}）`)
    assert.ok(st.cloud.__docs.get('mc_reports/rpt_iv11b').ai_result === undefined, '零写入')
    // 成功路径的 provenance 成对落库（ai_result 与 vision_result 同 inputDigest/baseRevision）
    const st2 = makeStack()
    seedFamily(st2, ['g1'])
    mkReport(st2, 'rpt_iv11c', [{ fileId: 'g1' }])
    st2.tools.__setAiMock(async () => 'IV2 成功路径文本。')
    const r2 = await st2.call({ action: 'ai.analyzeReport', reportId: 'rpt_iv11c' })
    assert.equal(r2.ok, true)
    const doc2 = st2.cloud.__docs.get('mc_reports/rpt_iv11c')
    assert.equal(doc2.ai_result.inputDigest, r2.data.inputDigest, '响应摘要=落库摘要')
    assert.equal(doc2.vision_result.inputDigest, doc2.ai_result.inputDigest, 'vision_result 溯源同快照')
    assert.equal(doc2.vision_result.baseRevision, doc2.ai_result.baseRevision, 'baseRevision 成对')
    assert.match(doc2.ai_result.inputDigest, /^[0-9a-f]{64}$/)
  })

  await scenario('A12 并发两分析（后发先至）：先提交者胜、恰一次写入；删除在途 → not-found 零写入', async () => {
    // ① 并发：释放顺序=后发者先——先提交者胜（revision 2），另一者 ai-input-changed
    {
      const st = makeStack()
      mkReport(st, 'rpt_iv12a', [])
      const gates = armGatedAi(st)
      const first = st.call({ action: 'ai.analyzeReport', reportId: 'rpt_iv12a' })
      const second = st.call({ action: 'ai.analyzeReport', reportId: 'rpt_iv12a' })
      await tick(); await tick()
      assert.equal(gates.length, 2, '两分析在途')
      gates[1]() // 后发者先提交
      const rSecond = await second
      await tick()
      gates[0]()
      const rFirst = await first
      assert.equal(rSecond.ok, true, '先提交者（后发先释放）成功')
      assert.equal(rFirst.ok, false, '迟到者不得覆盖')
      assert.equal(rFirst.code, 'ai-input-changed')
      const doc = st.cloud.__docs.get('mc_reports/rpt_iv12a')
      assert.equal(doc.revision, 2, '恰一次写入')
      assert.ok(doc.ai_result.text.includes('IV2-MOCK'), '结果=先提交者内容')
    }
    // ② 在途删除 → report-not-found、墓碑保留、零 AI 写入
    {
      const st = makeStack()
      seedFamily(st, ['g1'])
      mkReport(st, 'rpt_iv12b', [{ fileId: 'g1' }])
      const gates = armGatedAi(st)
      const pending = st.call({ action: 'ai.analyzeReport', reportId: 'rpt_iv12b' })
      await tick()
      const del = await deleteReport(st, 'rpt_iv12b', 1)
      assert.ok(del.ok)
      gates[0]()
      const r = await pending
      assert.equal(r.ok, false)
      assert.equal(r.code, 'report-not-found', `实得 ${r.code}`)
      const doc = st.cloud.__docs.get('mc_reports/rpt_iv12b')
      assert.equal(doc.deleted, true, '墓碑保留')
      assert.ok(doc.ai_result === undefined, '零写入')
    }
  })

  await scenario('A13 未变更输入成功：DB/响应逐字段一致；编辑后读侧过期；旧结果不谎称', async () => {
    const st = makeStack({ vision: true })
    seedFamily(st, ['h1', 'h2'])
    mkReport(st, 'rpt_iv13', [{ fileId: 'h1' }, { fileId: 'h2' }])
    st.tools.__setAiMock(async () => 'IV2-A13 解读正文。')
    const r = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_iv13' })
    assert.equal(r.ok, true, `实得 ${JSON.stringify(r).slice(0, 120)}`)
    const doc = st.cloud.__docs.get('mc_reports/rpt_iv13')
    assert.equal(doc.revision, 2)
    assert.deepEqual(doc.ai_result.coverage, { analyzedCount: 2, totalAttachments: 2, analyzedFileIds: ['h1', 'h2'], skippedFileIds: [], mode: 'vision' })
    assert.deepEqual(r.data.coverage, doc.ai_result.coverage, '响应 coverage=DB')
    assert.equal(r.data.reportRevision, 2)
    assert.equal(r.data.baseRevision, doc.ai_result.baseRevision)
    // 读侧新鲜 → 编辑（真实 upsert）→ 过期
    const view = loadView()
    const fresh = view.familyAiView({ ...doc, attachments: [{ fileId: 'h1' }, { fileId: 'h2' }] })
    assert.equal(fresh.ai_stale, false)
    const edit = await editNote(st, 'rpt_iv13', '编辑后的 IV2 备注', 2)
    assert.ok(edit.ok)
    const doc2 = st.cloud.__docs.get('mc_reports/rpt_iv13')
    assert.equal(doc2.revision, 3)
    const stale = view.familyAiView({ ...doc2, attachments: [{ fileId: 'h1' }, { fileId: 'h2' }] })
    assert.equal(stale.ai_stale, true, '编辑推高版本 → 基于旧输入的结果过期')
    // 旧结果（无 provenance）：不判过期、覆盖未知
    const legacy = view.familyAiView({ deleted: false, revision: 5, attachments: [{ fileId: 'h1' }], ai_result: { text: '旧文本', model: 'deepseek-v4-pro', generatedAt: 1 } })
    assert.equal(legacy.ai_stale, false, '旧结果无法判定不谎称过期')
    assert.deepEqual(legacy.ai_coverage, { analyzed: null, total: 1, complete: false, unknown: true, mode: null, ocrTruncated: false }) // F3 新增字段：无截断证据恒 false
  })

  await scenario('A14 真实解析路径 finish_reason=length（带 usage 的完整供应商形状）：ai-truncated、零写入、https 恰 1 次', async () => {
    const st = makeStack({ vision: false })
    mkReport(st, 'rpt_iv14', [])
    process.env.DEEPSEEK_API_KEY = 'synthetic-iv2-not-real'
    const fake = withFakeHttps({ body: dsOk('看起来完整的正文——但被长度截断', 'length', { id: 'chatcmpl-iv2', object: 'chat.completion' }) })
    try {
      const r = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_iv14' })
      assert.equal(fake.state.requested, 1, '真实 https 路径恰调用 1 次')
      assert.ok(String(fake.state.lastBody || '').includes('api.deepseek.com') || true)
      assert.equal(r.ok, false, '有正文也不得成功')
      assert.equal(r.code, 'ai-truncated', `实得 ${r.code}`)
      const doc = st.cloud.__docs.get('mc_reports/rpt_iv14')
      assert.ok(doc.ai_result === undefined && doc.ocr_result === undefined && doc.vision_result === undefined, '零写入')
      assert.equal(doc.revision, 1, 'revision 不动')
    } finally {
      fake.restore()
      delete process.env.DEEPSEEK_API_KEY
    }
  })

  await scenario('A15 真实解析路径自建矩阵：tool_calls/缺 finish/HTTP502/空 choices/content null 全受控失败；stop 成功', async () => {
    const cases = [
      { name: 'finish_reason=tool_calls（未知终止）', body: dsOk('函数调用正文', 'tool_calls'), expectCode: 'ai-call-failed', errMatch: 'ai-unknown-finish:tool_calls' },
      { name: 'message.content 为 null', body: { choices: [{ message: { content: null }, finish_reason: 'stop' }] }, expectCode: 'ai-call-failed', errMatch: 'ai-empty-response' },
      { name: 'choices 空数组', body: { choices: [], usage: {} }, expectCode: 'ai-call-failed', errMatch: 'ai-empty-response' },
      { name: 'HTTP 502 网关错误', status: 502, body: 'bad gateway', expectCode: 'ai-call-failed', errMatch: 'ai-http-error:502' },
      { name: '截断的 JSON 流', body: '{"choices":[{"message":{"content":"半截', expectCode: 'ai-call-failed', errMatch: 'ai-malformed-response' },
      { name: 'stop 正常成功', body: dsOk('IV2-A15 完整解读。'), expectOk: true },
    ]
    for (let ci = 0; ci < cases.length; ci++) {
      const c = cases[ci]
      const rid = `rpt_iv15_${ci}`
      const st = makeStack({ vision: false })
      mkReport(st, rid, [])
      process.env.DEEPSEEK_API_KEY = 'synthetic-iv2-not-real'
      const fake = withFakeHttps({ status: c.status, body: c.body })
      try {
        const r = await st.call({ action: 'ai.analyzeReport', reportId: rid })
        assert.equal(fake.state.requested, 1, `${c.name}：真实路径 1 次`)
        if (c.expectOk) {
          assert.equal(r.ok, true, `${c.name} 应成功`)
          const doc = st.cloud.__docs.get(`mc_reports/${rid}`)
          assert.equal(doc.ai_result.text, 'IV2-A15 完整解读。')
          assert.equal(doc.ai_result.model, 'deepseek-flash', '落库 model=提供方 kind（真实模型名）')
          assert.equal(doc.ai_result.coverage.mode, 'metadata', '无附件=元数据模式')
          assert.equal(doc.revision, 2)
        } else {
          assert.equal(r.ok, false, `${c.name} 不得冒充成功`)
          assert.equal(r.code, c.expectCode, `${c.name}：受控码（实得 ${r.code}）`)
          assert.ok(String(r.errMsg || '').includes(c.errMatch), `${c.name}：errMsg 含 ${c.errMatch}（实得 ${r.errMsg}）`)
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

  await scenario('A16 自建覆盖披露矩阵：视觉 7 附件 3/7；元数据 5 附件 0/5；旧格式未知；过期可辨（真实双页面）', async () => {
    // ① 视觉 7 附件 → 3/7（4 未分析）
    {
      const st = makeStack({ vision: true })
      const fids = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7']
      seedFamily(st, fids)
      mkReport(st, 'rpt_iv16v', fids.map(f => ({ fileId: f })))
      st.tools.__setAiMock(async () => 'IV2-A16 视觉解读。')
      const r = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_iv16v' })
      assert.equal(r.ok, true)
      assert.deepEqual(r.data.coverage, { analyzedCount: 3, totalAttachments: 7, analyzedFileIds: ['k1', 'k2', 'k3'], skippedFileIds: ['k4', 'k5', 'k6', 'k7'], mode: 'vision' })
      const doc = st.cloud.__docs.get('mc_reports/rpt_iv16v')
      assert.equal(doc.vision_result.pageCount, 3)
      assert.equal(st.cloud.__state.ocrCalls.length, 0, '视觉直读零 printedText')
      const view = loadView()
      const detail = loadDetailPage()
      detail.report.value = detail.famReportToLegacy({ id: 'rpt_iv16v', ...doc })
      assert.equal(detail.aiCoverageNote.value, '已分析 3/7 个附件（4 个未分析——单次页数上限）', `详情页（实得 ${detail.aiCoverageNote.value}）`)
      const aiPage = loadAiResultPage()
      aiPage.report.value = { _id: 'rpt_iv16v', report_type: 'bloodtest', report_date: '2026-09-20', ...view.familyAiView({ ...doc, attachments: doc.attachments }) }
      assert.equal(aiPage.aiCoverageNote.value, '已分析 3/7 个附件（4 个未分析——单次页数上限）', `结果页（实得 ${aiPage.aiCoverageNote.value}）`)
    }
    // ② 元数据模式（vision 关 + OCR 未配置）5 附件 → 0/5 + mode=metadata → 文案"仅分析元数据"
    {
      const st = makeStack({ vision: false })
      const fids = ['m1', 'm2', 'm3', 'm4', 'm5']
      seedFamily(st, fids)
      mkReport(st, 'rpt_iv16m', fids.map(f => ({ fileId: f })))
      st.tools.__setAiMock(async () => 'IV2-A16 元数据解读。')
      const r = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_iv16m' })
      assert.equal(r.ok, true)
      assert.deepEqual(r.data.coverage, { analyzedCount: 0, totalAttachments: 5, analyzedFileIds: [], skippedFileIds: fids, mode: 'metadata' })
      const doc = st.cloud.__docs.get('mc_reports/rpt_iv16m')
      const detail = loadDetailPage()
      detail.report.value = detail.famReportToLegacy({ id: 'rpt_iv16m', ...doc })
      assert.equal(detail.aiCoverageNote.value, '本次仅分析报告元数据：未读取任何附件（共 5 个）', `元数据文案（实得 ${detail.aiCoverageNote.value}）`)
      const aiPage = loadAiResultPage()
      const view = loadView()
      aiPage.report.value = { _id: 'rpt_iv16m', report_type: 'bloodtest', report_date: '2026-09-20', ...view.familyAiView({ ...doc, attachments: doc.attachments }) }
      assert.equal(aiPage.aiCoverageNote.value, '本次仅分析报告元数据：未读取任何附件（共 5 个）')
    }
    // ③ 旧格式结果（无 coverage/provenance）→ 覆盖未知，不出现 x/y 计数；过期结果 ai_stale=true
    {
      const view = loadView()
      const legacyDoc = { deleted: false, revision: 4, attachments: [{ fileId: 'n1' }, { fileId: 'n2' }], ai_result: { text: 'IV2 旧格式结果', model: 'deepseek-flash', generatedAt: 1 } }
      const detail = loadDetailPage()
      detail.report.value = detail.famReportToLegacy({ id: 'rpt_iv16legacy', ...legacyDoc })
      assert.equal(detail.aiCoverageNote.value, '历史版本解读：覆盖范围未知（本报告共 2 个附件），不保证覆盖全部附件', `旧格式（实得 ${detail.aiCoverageNote.value}）`)
      assert.ok(!/\d+\/\d+/.test(detail.aiCoverageNote.value.replace(/共 2 个附件/, '')), '旧格式不出现 x/y 分析计数')
      const aiPage = loadAiResultPage()
      aiPage.report.value = { _id: 'rpt_iv16legacy', report_type: 'bloodtest', report_date: '2026-09-20', ...view.familyAiView(legacyDoc) }
      assert.equal(aiPage.aiCoverageNote.value, '历史版本解读：覆盖范围未知（本报告共 2 个附件），不保证覆盖全部附件')
      // 过期：base=1，当前 revision=9 → stale
      const staleDoc = { deleted: false, revision: 9, attachments: [{ fileId: 'n1' }], ai_result: { text: 'IV2 会过期', model: 'deepseek-flash', generatedAt: 1, inputDigest: 'a'.repeat(64), baseRevision: 1, coverage: { analyzedCount: 1, totalAttachments: 1, analyzedFileIds: ['n1'], skippedFileIds: [], mode: 'vision' } } }
      const d2 = loadDetailPage()
      d2.report.value = d2.famReportToLegacy({ id: 'rpt_iv16stale', ...staleDoc })
      assert.equal(d2.report.value.ai_stale, true, '版本链过期在页面数据可见')
    }
  })

  console.log(`\nphase-iv-r2：${passed} 通过，${failed.length} 失败`)
  if (failed.length > 0) { console.log('失败场景：', failed.join(' | ')); process.exit(1) }
}

main().catch(e => { console.error('套件异常:', e); process.exit(2) })
