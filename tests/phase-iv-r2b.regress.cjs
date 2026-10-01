// 独立验证 IV-R2b（2026-10-01 第二轮，按 INDEPENDENT_REVIEW_NOTES R2 缺口补全）：
// 1) 真实页面点击链：初次分析（pending→done）与过期重分析（stale→新结果）均经
//    真实 detail.vue 页面函数 → 网关（计数）→ 生产 mc-tools/mc-reports handler；
//    断言网关调用次数、服务端写入次数/版本、刷新后的页面状态、失败提示与导航行为。
// 2) 旧 OCR 来源页面断言：附件变化/跨模式后旧 OCR 不当成本次原文（ocr_text 空），
//    历史提取以独立"来源未确认"通道展示（真实 ai-result.vue 页面 computed 消费）。
// 生产源码只读；本文件为验证会话新增测试。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-iv2b-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }
const tick = () => new Promise(r => setTimeout(r, 6))

require('node:child_process').execFileSync('node', [path.join(root, 'cloud/assemble.mjs')], { stdio: 'pipe' })
const DIST = path.join(root, 'dist/cloud-functions')
const toolsH = require(path.join(DIST, 'mc-tools/index.js'))
const reportsH = require(path.join(DIST, 'mc-reports/index.js'))

const TEST_ENV = { MC_APPID: 'wxivapp00000012', MC_FAMILY_ID: 'fam-iv2b', MC_MEMBER_MAMA_OPENID: 'oIV2BMAMA000001', MC_MEMBER_PAPA_OPENID: 'oIV2BPAPA000001' }

function makeMockCloud() {
  const docs = new Map()
  const state = { caller: TEST_ENV.MC_MEMBER_MAMA_OPENID, initialized: false, ocrCalls: [], downloadCalls: [] }
  const clone = x => JSON.parse(JSON.stringify(x))
  function docApi(col, id, tx) {
    return {
      get: async () => { const e = docs.get(`${col}/${id}`); if (tx) tx.reads.set(`${col}/${id}`, e ? e.__v : 0); return { data: e ? { ...clone(e), _id: id } : null } },
      set: async ({ data }) => {
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
    downloadFile: async ({ fileID }) => { state.downloadCalls.push(fileID); return { fileContent: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 5)]) } },
    openapi: { ocr: { printedText: async p => { state.ocrCalls.push(p); return { errCode: 0, words_result: [{ words: '宫高 33cm' }] } } } },
    __docs: docs, __state: state, __setCtx(o) { state.caller = o },
  }
}

const storage = new Map()
const uniCalls = { toasts: [], navs: [] }
global.uni = {
  getStorageSync(k) { return storage.has(k) ? storage.get(k) : '' },
  setStorageSync(k, v) { storage.set(k, v) },
  removeStorageSync(k) { storage.delete(k) },
  getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
  showToast: o => uniCalls.toasts.push(String((o && o.title) || '')), showLoading() {}, hideLoading() {}, showModal() {},
  navigateTo: o => uniCalls.navs.push(String((o && o.url) || '')), redirectTo() {}, switchTab() {}, reLaunch() {}, navigateBack() {},
  request() {}, uploadFile() {}, downloadFile: o => o.fail && o.fail({ errMsg: 'dl' }),
  vibrateShort() {},
}

// detail.vue 页面 bundle（真实点击函数：onReanalyze/onAiCardTap）
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

// ai-result.vue 页面 bundle（OCR 来源通道消费）
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
        '\nexport {report, aiCoverageNote, aiDisabled, ocrText, ocrHistory, loads};\nexport {__adoptSessionForTests, __resetForTests} from "./services/sessionService.js";',
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
// 读侧单源 bundle
const viewFile = path.join(temp, 'aiReportView.cjs')
esbuild.buildSync({ entryPoints: [path.join(root, 'services/aiReportView.js')], bundle: true, platform: 'node', format: 'cjs', outfile: viewFile, logLevel: 'silent' })
function loadView() { delete require.cache[require.resolve(viewFile)]; return require(viewFile) }

function seedFamily(st, ids) {
  for (const id of ids) st.cloud.__docs.set(`mc_files/${id}`, { familyId: TEST_ENV.MC_FAMILY_ID, status: 'registered', formalFileID: `cloud://env/formal/${id}`, __v: 1 })
}
function mkReport(st, id, attachments, extra = {}) {
  st.cloud.__docs.set(`mc_reports/${id}`, {
    familyId: TEST_ENV.MC_FAMILY_ID, deleted: false,
    dateKey: '2026-09-18', reportType: 'ultrasound', note: 'IV2b 基线备注',
    attachments, revision: 1, updatedBy: 'mama', updatedAt: 1, __v: 1, ...extra
  })
}
let opSeq = 0
const nextOp = p => `${p}_${++opSeq}_${Math.random().toString(36).slice(2, 8)}`
async function editNote(st, id, note, expectedRevision) {
  return reportsH.main({ action: 'report.upsert', id, schemaVersion: 1, operationId: nextOp('iv2b'), expectedRevision, payload: { note } })
}
async function editAttachments(st, id, attachments, expectedRevision) {
  return reportsH.main({ action: 'report.upsert', id, schemaVersion: 1, operationId: nextOp('iv2b'), expectedRevision, payload: { attachments } })
}

// 页面驱动的网关替身：路由到真实 dist handler + 精确计数
function pageGateway(st) {
  const aiCalls = []
  const reportWrites = []
  const wxCloud = {
    init() {},
    callFunction(o) {
      const h = {
        'mc-reports': e => reportsH.main(e),
        'mc-tools': e => {
          if (e && e.action === 'ai.analyzeReport') aiCalls.push(e)
          return toolsH.main(e)
        },
        'mc-identity': () => ({ ok: true, data: { memberId: 'mama', displayName: '妈妈', familyId: TEST_ENV.MC_FAMILY_ID } }),
        'mc-health': () => Promise.resolve({ ok: false, code: 'not-configured' })
      }[o.name]
      if (!h) { o.fail && o.fail({ errMsg: 'no route: ' + o.name }); return }
      Promise.resolve().then(() => h(o.data)).then(r => {
        if (o.name === 'mc-reports' && o.data && (o.data.action === 'report.upsert' || o.data.action === 'report.save')) reportWrites.push(o.data.action)
        o.success({ result: r })
      }).catch(e => o.fail && o.fail({ errMsg: e.message }))
    }
  }
  return { wxCloud, aiCalls, reportWrites }
}

async function main() {
  console.log('IV-R2b 独立反例（R2 审核缺口：页面点击初次/过期重分析 + 旧 OCR 来源页面断言）\n')

  await scenario('页面点击·初次分析：真实 onReanalyze → 网关 → 生产 handler，恰一次调用/写入/刷新/导航', async () => {
    const st = { cloud: makeMockCloud() }
    for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
    delete process.env.DEEPSEEK_API_KEY
    delete process.env.MC_OCR_PROVIDER
    delete process.env.MC_REPORT_VISION
    toolsH.__setCloud(st.cloud); reportsH.__setCloud(st.cloud)
    toolsH.__setAiMock(null)
    seedFamily(st, ['q1'])
    mkReport(st, 'rpt_iv2b_first', [{ fileId: 'q1' }]) // 无 ai_result——pending 态
    const gw = pageGateway(st)
    uniCalls.navs.length = 0; uniCalls.toasts.length = 0
    const page = loadDetailPage()
    page.__setWxCloud(gw.wxCloud)
    page.__resetForTests()
    page.__adoptSessionForTests({ memberId: 'mama', familyId: TEST_ENV.MC_FAMILY_ID, displayName: '妈妈' })
    for (const fn of page.loads) await fn({ id: 'rpt_iv2b_first' })
    for (let i = 0; i < 8; i++) await tick()
    assert.equal(page.report.value.ai_status, 'pending', `初次为待解读（实得 ${page.report.value.ai_status}）`)
    // 真实页面函数发起初次分析（与过期重分析同一网关管线）
    st.cloudAi = toolsH
    toolsH.__setAiMock(async () => 'IV2b 初次分析解读正文。')
    await page.onReanalyze()
    for (let i = 0; i < 10; i++) await tick()
    assert.equal(gw.aiCalls.length, 1, `网关恰一次真实 ai.analyzeReport（实得 ${gw.aiCalls.length}）`)
    assert.equal(gw.aiCalls[0].reportId, 'rpt_iv2b_first')
    const doc = st.cloud.__docs.get('mc_reports/rpt_iv2b_first')
    assert.ok(doc.ai_result, '服务端写入 ai_result')
    assert.equal(doc.revision, 2, '恰一次写入（revision 1→2）')
    assert.equal(doc.ai_result.baseRevision, 1, '结果基于分析时版本')
    assert.equal(page.report.value.ai_status, 'done', '页面刷新为已解读')
    assert.equal(page.report.value.ai_stale, false, '新结果不过期')
    assert.ok(page.report.value.ai_result.overall_summary.includes('IV2b 初次'), '新正文上屏')
    assert.equal(uniCalls.navs.length, 1, '成功且不过期才导航')
    assert.ok(uniCalls.navs[0].includes('ai-result'))
    // 卡片 tap（已有新鲜结果）：只导航，不再分析
    await page.onAiCardTap()
    assert.equal(uniCalls.navs.length, 2)
    assert.equal(gw.aiCalls.length, 1, 'tap 不追加分析')
  })

  await scenario('页面点击·过期重分析：编辑致过期 → 真实重分析以当前版本为锚；在途冲突如实提示不伪装', async () => {
    const st = { cloud: makeMockCloud() }
    for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
    delete process.env.DEEPSEEK_API_KEY
    delete process.env.MC_OCR_PROVIDER
    delete process.env.MC_REPORT_VISION
    toolsH.__setCloud(st.cloud); reportsH.__setCloud(st.cloud)
    seedFamily(st, ['q1'])
    // 种子：已有结果基于 baseRevision 1，此后真实编辑两次 → revision 3（过期）
    mkReport(st, 'rpt_iv2b_stale', [{ fileId: 'q1' }], {
      revision: 3,
      ai_result: { text: 'IV2b 旧结果正文。', model: 'deepseek-flash', generatedAt: 1, baseRevision: 1, inputDigest: 'c'.repeat(64), coverage: { analyzedCount: 1, totalAttachments: 1, analyzedFileIds: ['q1'], skippedFileIds: [], mode: 'vision' } }
    })
    await editNote(st, 'rpt_iv2b_stale', 'IV2b 编辑后备注', 3) // revision 4（过期保持）
    const gw = pageGateway(st)
    uniCalls.navs.length = 0; uniCalls.toasts.length = 0
    const page = loadDetailPage()
    page.__setWxCloud(gw.wxCloud)
    page.__resetForTests()
    page.__adoptSessionForTests({ memberId: 'mama', familyId: TEST_ENV.MC_FAMILY_ID, displayName: '妈妈' })
    for (const fn of page.loads) await fn({ id: 'rpt_iv2b_stale' })
    for (let i = 0; i < 8; i++) await tick()
    assert.equal(page.report.value.ai_status, 'done')
    assert.equal(page.report.value.ai_stale, true, '过期标记（4 > 1+1）')
    // 过期结果的卡片 tap：查看原结果（导航），不分析
    await page.onAiCardTap()
    assert.equal(uniCalls.navs.length, 1)
    assert.equal(gw.aiCalls.length, 0)
    // 真实重分析：成功 → 以当前版本为锚、刷新不过期、导航新结果
    toolsH.__setAiMock(async () => 'IV2b 重分析新解读。')
    await page.onReanalyze()
    for (let i = 0; i < 10; i++) await tick()
    assert.equal(gw.aiCalls.length, 1)
    const doc = st.cloud.__docs.get('mc_reports/rpt_iv2b_stale')
    assert.equal(doc.revision, 5, '恰一次写入（4→5）')
    assert.equal(doc.ai_result.baseRevision, 4, '新结果锚定分析时版本')
    assert.equal(page.report.value.ai_stale, false)
    assert.ok(page.report.value.ai_result.overall_summary.includes('IV2b 重分析'))
    assert.equal(uniCalls.navs.length, 2, '成功后导航')
    // 再制造过期 → 在途编辑冲突：受控提示、旧结果保留、不导航、不写入
    await editNote(st, 'rpt_iv2b_stale', 'IV2b 再次编辑', 5) // revision 6 → 过期
    for (let i = 0; i < 6; i++) await tick()
    toolsH.__setAiMock(() => new Promise(resolve => {
      editNote(st, 'rpt_iv2b_stale', 'IV2b 在途编辑', 6).then(() => resolve('将被拒绝的正文'))
    }))
    uniCalls.toasts.length = 0; uniCalls.navs.length = 0
    await page.onReanalyze()
    for (let i = 0; i < 10; i++) await tick()
    assert.ok(uniCalls.toasts.some(t => t.includes('报告在分析期间被修改')), `冲突如实提示（实得 ${JSON.stringify(uniCalls.toasts)}）`)
    assert.equal(gw.aiCalls.length, 2, '网关确实被调用（第二次被 CAS 拒）')
    const doc2 = st.cloud.__docs.get('mc_reports/rpt_iv2b_stale')
    assert.equal(doc2.revision, 7, 'revision 只含两次编辑（6、7），冲突分析零写入')
    assert.ok(!doc2.ai_result.text.includes('将被拒绝'), '被拒结果未入库')
    assert.equal(page.report.value.ai_status, 'done', '保留已有结果')
    assert.ok(page.report.value.ai_result.overall_summary.includes('IV2b 重分析'), '保留的是上次有效结果')
    assert.equal(page.report.value.ai_stale, true, '如实仍过期')
    assert.equal(uniCalls.navs.length, 0, '失败不导航')
  })

  await scenario('旧 OCR 来源（真实 ai-result 页面）：跨输入残留不当本次原文；历史提取独立通道', async () => {
    // ① OCR 首跑（vision 关 + wechat OCR）：同输入 → 提取原文作为本次内容展示
    const st = { cloud: makeMockCloud() }
    for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
    delete process.env.DEEPSEEK_API_KEY
    process.env.MC_REPORT_VISION = '0' // OCR 段：显式关视觉直读
    process.env.MC_OCR_PROVIDER = 'wechat'
    toolsH.__setCloud(st.cloud); reportsH.__setCloud(st.cloud)
    seedFamily(st, ['o1', 'o2'])
    mkReport(st, 'rpt_iv2b_ocr', [{ fileId: 'o1' }])
    toolsH.__setAiMock(async () => 'IV2b OCR 首跑解读。')
    const r1 = await toolsH.main({ action: 'ai.analyzeReport', reportId: 'rpt_iv2b_ocr' })
    assert.ok(r1.ok && r1.data.ocrIncluded, `OCR 首跑（实得 ${JSON.stringify(r1).slice(0, 100)}）`)
    const doc1 = st.cloud.__docs.get('mc_reports/rpt_iv2b_ocr')
    assert.equal(doc1.ocr_result.inputDigest, doc1.ai_result.inputDigest, '首跑提取带同快照溯源')
    const view = loadView()
    // 真实 ai-result 页面：本次原文块在、历史块不在
    const page1 = loadAiResultPage()
    page1.report.value = { _id: 'rpt_iv2b_ocr', report_type: 'ultrasound', report_date: '2026-09-18', ...view.familyAiView({ ...doc1, attachments: doc1.attachments }) }
    assert.ok(String(page1.ocrText.value).includes('宫高'), `同输入 → 本次原文展示（实得 ${page1.ocrText.value}）`)
    assert.equal(page1.ocrHistory.value, null, '无历史提取块')
    // ② 改附件（真实 upsert）→ 视觉模式重分析：旧 OCR 残留在库但 digest ≠ 本次 → 不当本次原文
    delete process.env.MC_OCR_PROVIDER
    delete process.env.MC_REPORT_VISION // 视觉段：恢复默认开启
    await editAttachments(st, 'rpt_iv2b_ocr', [{ fileId: 'o2' }], doc1.revision)
    toolsH.__setAiMock(async () => 'IV2b 视觉重分析解读。')
    const r2 = await toolsH.main({ action: 'ai.analyzeReport', reportId: 'rpt_iv2b_ocr' })
    assert.ok(r2.ok && r2.data.visionIncluded, `视觉重分析（实得 ${JSON.stringify(r2).slice(0, 100)}）`)
    const doc2 = st.cloud.__docs.get('mc_reports/rpt_iv2b_ocr')
    assert.ok(doc2.ocr_result && doc2.ocr_result.text.includes('宫高'), '旧 OCR 内容仍在库（保留不清除）')
    assert.notEqual(doc2.ocr_result.inputDigest, doc2.ai_result.inputDigest, '跨输入：旧 OCR digest ≠ 本次')
    const page2 = loadAiResultPage()
    page2.report.value = { _id: 'rpt_iv2b_ocr', report_type: 'ultrasound', report_date: '2026-09-18', ...view.familyAiView({ ...doc2, attachments: doc2.attachments }) }
    assert.equal(page2.ocrText.value, '', `跨输入残留不当本次原文（实得 "${page2.ocrText.value}"）`)
    assert.ok(page2.ocrHistory.value && page2.ocrHistory.value.unverified === true, '历史提取通道在（unverified）')
    assert.ok(String(page2.ocrHistory.value.text).includes('宫高'), '历史提取内容可见（来源未确认披露）')
    // 页面模板断言：两个标题块条件互斥、历史块仅在无本次原文时渲染、来源说明在位
    const src = fs.readFileSync(path.join(root, 'pages/archives/ai-result.vue'), 'utf8')
    assert.ok(src.includes('报告原文提取（OCR）') && src.includes('历史提取（来源未确认）'), '两标题独立在场')
    assert.ok(src.includes('v-if="!ocrText && ocrHistory"'), '历史块仅当无本次原文时渲染')
    assert.ok(src.includes('未能确认属于本次解读的输入'), '来源未确认说明在位')
    // ③ R2 前历史形状（双方均无 digest）：不可证明同源 → 同样不当本次原文
    const legacyPair = { deleted: false, revision: 3, attachments: [{ fileId: 'o1' }], ai_result: { text: 'IV2b 历史结果', model: 'deepseek-flash', generatedAt: 1 }, ocr_result: { text: 'IV2b 历史提取', included: true, provider: 'wechat', generatedAt: 1, pageFileIds: ['o1'] } }
    const v3 = view.familyAiView(legacyPair)
    assert.equal(v3.ocr_text, '', '无 digest 历史对不标本次原文')
    assert.ok(v3.ocr_history && v3.ocr_history.unverified === true, '走历史通道')
    const page3 = loadAiResultPage()
    page3.report.value = { _id: 'rpt_iv2b_legacy', report_type: 'ultrasound', report_date: '2026-09-18', ...v3 }
    assert.equal(page3.ocrText.value, '')
    assert.ok(String(page3.ocrHistory.value.text).includes('IV2b 历史提取'))
  })

  console.log(`\nphase-iv-r2b：${passed} 通过，${failed.length} 失败`)
  if (failed.length > 0) { console.log('失败场景：', failed.join(' | ')); process.exit(1) }
}

main().catch(e => { console.error('套件异常:', e); process.exit(2) })
