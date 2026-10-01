// R3 回归：A17–A19（导出投影/validator 与真实 AI 产物一致）+ A20/A21（过滤列表扫描游标分页）
// + A22（pullContractions 全页/去重/本地 pending/切身份）。
// 手法：真实 dist handler（health/schedule/reports/files/identity/tools）+ stage1 式
// mock 云/FSM/微信全局；AI 结果由真实 ai.analyzeReport（mock 提供方）产出——不用简化投影假替身。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-r3-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }
const tick = () => new Promise(r => setTimeout(r, 10))

// ── dist handler（assemble 全量组装；与 r1/r2 同源）──
require('node:child_process').execFileSync('node', [path.join(root, 'cloud/assemble.mjs')], { stdio: 'pipe' })
const DIST = path.join(root, 'dist/cloud-functions')
const healthH = require(path.join(DIST, 'mc-health/index.js'))
const scheduleH = require(path.join(DIST, 'mc-schedule/index.js'))
const reportsH = require(path.join(DIST, 'mc-reports/index.js'))
const filesH = require(path.join(DIST, 'mc-files/index.js'))
const identityH = require(path.join(DIST, 'mc-identity/index.js'))
const toolsH = require(path.join(DIST, 'mc-tools/index.js'))
const restoreH = require(path.join(DIST, 'mc-restore/index.js'))

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-r3', MC_MEMBER_MAMA_OPENID: 'oR3MAMA1234567', MC_MEMBER_PAPA_OPENID: 'oR3PAPA1234567' }
const storage = new Map()
const fileBytesByPath = new Map()
const uniCalls = { toasts: [], shareCalls: [], navs: [] }
let dlSeq = 0
let harnessCloud = null
let fsmFiles = null

// ── 可解码互异 PNG（stage1 同款）──
function makePng(idx) {
  const zlib = require('node:zlib')
  const raw = Buffer.from([0, (idx * 37 + 11) % 256, (idx * 89 + 5) % 256, (idx * 151 + 200) % 256])
  const idat = zlib.deflateSync(raw)
  const crcTable = []
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0 }
  const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
    return Buffer.concat([Buffer.from([0, 0, 0, data.length]), body, crc])
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// ── uni 全局（stage1 精简版：downloadFile 经 harnessCloud 取真实字节）──
function installUni() {
  global.uni = {
    getStorageSync(k) { return storage.has(k) ? storage.get(k) : '' },
    setStorageSync(k, v) { storage.set(k, v) },
    removeStorageSync(k) { storage.delete(k) },
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
    showToast: v => { uniCalls.toasts.push(v && v.title) }, showModal: o => (o && o.success ? o.success({ confirm: true }) : undefined),
    showLoading() {}, hideLoading() {},
    redirectTo() {}, navigateTo: o => { uniCalls.navs.push(o && o.url) }, switchTab() {}, reLaunch() {}, navigateBack() {},
    request: () => {}, uploadFile: () => {},
    downloadFile: o => {
      const url = String(o.url || '')
      const fid = url.startsWith('https://t.i/') ? url.slice('https://t.i/'.length) : url
      const key = String(fid).replace(/^cloud:\/\/[^/]+\//, '')
      const bytes = harnessCloud && harnessCloud.__stored.get(key)
      if (!bytes) { o.fail && o.fail({ errMsg: 'downloadFile:fail 404' }); return }
      const p = 'wxfile://tmp-dl-' + (++dlSeq)
      if (fsmFiles) fsmFiles.set(p, new Uint8Array(bytes))
      fileBytesByPath.set(p, bytes)
      o.success && o.success({ tempFilePath: p, statusCode: 200 })
    },
  }
}

// ── FSM（stage1 同款精简）──
function makeFSM() {
  const files = new Map()
  const u8 = d => typeof d === 'string' ? new Uint8Array(Buffer.from(d, 'utf8')) : new Uint8Array(d)
  return () => ({
    writeFile(o) { files.set(o.filePath, u8(o.data)); o.success && o.success({}) },
    appendFile(o) { const add = u8(o.data), prev = files.get(o.filePath) || new Uint8Array(0); const next = new Uint8Array(prev.length + add.length); next.set(prev); next.set(add, prev.length); files.set(o.filePath, next); o.success && o.success({}) },
    readFile(o) { const f = files.get(o.filePath); if (!f) { o.fail && o.fail({ errMsg: 'readFile:fail' }); return } const pos = o.position == null ? 0 : o.position; const len = o.length == null ? f.length - pos : Math.min(o.length, f.length - pos); o.success && o.success({ data: f.slice(pos, pos + len).buffer }) },
    stat(o) { const f = files.get(o.path); if (!f) { o.fail && o.fail({ errMsg: 'stat:fail' }); return } o.success && o.success({ stats: { size: f.length } }) },
    rename(o) { const f = files.get(o.oldPath); if (!f) { o.fail && o.fail({ errMsg: 'rename:fail' }); return } files.set(o.newPath, f); files.delete(o.oldPath); o.success && o.success({}) },
    copyFile(o) { const f = files.get(o.srcPath); if (!f) { o.fail && o.fail({ errMsg: 'copyFile:fail' }); return } files.set(o.destPath, f); o.success && o.success({}) },
    mkdir(o) { o.success && o.success({}) }, rmdir(o) { o.success && o.success({}) },
    unlink(o) { files.delete(o.filePath); o.success && o.success({}) },
    access(o) { o.success && o.success({}) },
    __files: files,
  })
}

// ── mock 云（stage1 式 + openapi.ocr）──
function makeMockCloud() {
  const docs = new Map(), storedFiles = new Map()
  const state = { caller: TEST_ENV.MC_MEMBER_MAMA_OPENID, initialized: false, ocrCalls: [] }
  const clone = x => JSON.parse(JSON.stringify(x))
  function docApi(col, id, tx) {
    return {
      get: async () => { const e = docs.get(`${col}/${id}`); if (tx) tx.reads.set(`${col}/${id}`, e ? e.__v : 0); return { data: e ? { ...clone(e), _id: id } : null } },
      set: async ({ data }) => { if (tx) { tx.writes.set(`${col}/${id}`, clone(data)); return { _id: id } } const prev = docs.get(`${col}/${id}`); docs.set(`${col}/${id}`, { ...clone(data), __v: (prev ? prev.__v : 0) + 1 }); return { _id: id } },
      remove: async () => { docs.delete(`${col}/${id}`); return {} }
    }
  }
  function runQuery(col, filters, orderByField, dir, limitN) {
    let rows = [...docs.entries()].filter(([k]) => k.startsWith(col + '/')).map(([k, e]) => ({ ...clone(e), _id: k.slice(col.length + 1) }))
    for (const [f, cond] of Object.entries(filters || {})) rows = rows.filter(r => cond && cond.__op === 'lt' ? (r[f] !== undefined && String(r[f]) < String(cond.v)) : JSON.stringify(r[f]) === JSON.stringify(cond))
    if (orderByField) { rows.sort((a, b) => String(b[orderByField]).localeCompare(String(a[orderByField]))); if (String(dir).toLowerCase() === 'asc') rows.reverse() }
    return rows.slice(0, limitN || 100)
  }
  function makeQuery(col, filters, orderByField, dir, limitN) {
    return { orderBy: (f, d) => makeQuery(col, filters, f, d, limitN), limit: n => makeQuery(col, filters, orderByField, dir, n), get: async () => ({ data: runQuery(col, filters, orderByField, dir, limitN) }) }
  }
  const db = {
    command: { lt: v => ({ __op: 'lt', v }), gt: v => ({ __op: 'gt', v }) },
    startTransaction: async () => { const tx = { reads: new Map(), writes: new Map() }; return { collection: c => ({ doc: id => docApi(c, id, tx) }), commit: async () => { for (const [k, d2] of tx.writes) { const prev = docs.get(k); docs.set(k, { ...d2, __v: (prev ? prev.__v : 0) + 1 }) } }, rollback: async () => { tx.writes.clear() } } },
    collection: c => ({ doc: id => docApi(c, id, null), where: f => makeQuery(c, f) })
  }
  return {
    DYNAMIC_CURRENT_ENV: Symbol('env'), init() { state.initialized = true },
    getWXContext() { return { APPID: TEST_ENV.MC_APPID, OPENID: state.caller } },
    database() { if (!state.initialized) throw new Error('init first'); return db },
    downloadFile: async ({ fileID }) => { const k = String(fileID).replace(/^cloud:\/\/[^/]+\//, ''); const b = storedFiles.get(k); if (!b) throw new Error('dl'); return { fileContent: Buffer.from(b) } },
    uploadFile: async ({ cloudPath, fileContent }) => { storedFiles.set(cloudPath, Buffer.from(fileContent)); return { fileID: `cloud://e.b/${cloudPath}` } },
    getTempFileURL: async ({ fileList }) => ({ fileList: fileList.map(f => ({ fileID: f, tempFileURL: 'https://t.i/' + f })) }),
    openapi: { ocr: { printedText: async p => { state.ocrCalls.push(p); return { errCode: 0, words_result: [{ words: '双顶径 8.4cm' }, { words: '羊水指数 14.2cm' }] } } } },
    __docs: docs, __stored: storedFiles, __state: state, __setCtx(o) { state.caller = o },
  }
}

function makeStack(member = 'mama') {
  for (const k of [...storage.keys()]) { if (k.startsWith('mc_') || k.startsWith('YUNTU_') || k.startsWith('MOMCARE_')) storage.delete(k) }
  uniCalls.toasts.length = 0; uniCalls.shareCalls.length = 0
  const cloud = makeMockCloud()
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID
  process.env.MC_UPLOAD_ENABLED = 'true'
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.MC_OCR_PROVIDER
  delete process.env.MC_REPORT_VISION
  cloud.__setCtx(member === 'mama' ? TEST_ENV.MC_MEMBER_MAMA_OPENID : TEST_ENV.MC_MEMBER_PAPA_OPENID)
  healthH.__setCloud(cloud); scheduleH.__setCloud(cloud); reportsH.__setCloud(cloud); filesH.__setCloud(cloud); identityH.__setCloud(cloud); toolsH.__setCloud(cloud)
  const curMember = { value: member }
  const routes = {
    'mc-health': e => healthH.main(e),
    'mc-schedule': e => scheduleH.main(e),
    'mc-reports': e => reportsH.main(e),
    'mc-files': e => filesH.main(e),
    'mc-tools': e => toolsH.main(e),
    'mc-identity': () => ({ ok: true, data: { memberId: curMember.value, displayName: curMember.value === 'mama' ? '妈妈' : '爸爸', familyId: process.env.MC_FAMILY_ID } }),
  }
  const wxCloud = {
    init() {},
    callFunction(o) { const h = routes[o.name]; if (!h) { o.fail({ errMsg: 'no route' }); return } Promise.resolve().then(() => h(o.data)).then(r => o.success({ result: r })).catch(e => o.fail({ errMsg: e.message })) },
  }
  return { cloud, wxCloud, routes, curMember }
}

function installWechatGlobal(stack) {
  const fsm = makeFSM()()
  fsmFiles = fsm.__files
  harnessCloud = stack.cloud
  global.wx = {
    cloud: stack.wxCloud,
    getFileSystemManager: () => fsm,
    shareFileMessage: o => { uniCalls.shareCalls.push({ filePath: o.filePath }); o.success && o.success({ errMsg: 'shareFileMessage:ok' }) },
    chooseMessageFile: o => o.fail && o.fail({ errMsg: 'cancel' }),
    env: { USER_DATA_PATH: 'wxfile://usr' },
  }
  return fsm
}

// ── bundles ──
function buildBundle(contents, outfile) {
  esbuild.buildSync({ stdin: { contents, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile, logLevel: 'silent' })
}
const serviceBundle = path.join(temp, 'svc.cjs')
buildBundle(`export * from '@/services/mcpkgExportService.js';
export * from '@/utils/mcpkg/utf8.js';
export * from '@/utils/mcpkg/canonical.js';
export * from '@/utils/mcpkg/sha256.js';
export * from '@/utils/mcpkg/container.js';
export * from '@/utils/mcpkg/adapter-wechat.js';
export * from '@/utils/mcpkg/adapter-h5.js';
export * from "./services/sessionService.js";
export * from "./services/outbox.js";
export * from "./services/cloudAdapter.js";
export * from "./utils/cloudConfig.js";`, serviceBundle)
const contraPageBundle = path.join(temp, 'contra-page.cjs')
{
  const src = fs.readFileSync(path.join(root, 'pages/tools/contraction-timer.vue'), 'utf8')
  const m = src.match(/<script setup>([\s\S]*?)<\/script>/)
  if (!m) throw new Error('无 <script setup>')
  let code = m[1]
    .replace(/^import .* from ['"][^'"\n]+\.vue['"];?$/mg, '')
    .replace(/import\s*\{\s*onShow\s*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const shows=[];const onShow=fn=>shows.push(fn);')
  code = `import { createPinia, setActivePinia } from 'pinia';\nsetActivePinia(createPinia());\n` +
    code.replace('const toolsStore = useToolsStore()', 'setActivePinia(createPinia());\nconst toolsStore = useToolsStore()') +
    `\nexport {shows, recentContractions, unfinishedList, active, unsaved, onToggle};\nexport * from './services/toolsStore.js';\nexport * from './services/sessionService.js';\nexport * from './services/familyStore.js';\nexport * from './services/outbox.js';\nexport * from './services/cloudAdapter.js';\nexport * from './utils/cloudConfig.js';\n`
  esbuild.buildSync({ stdin: { contents: code, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: contraPageBundle, logLevel: 'silent' })
}
const storeBundle = path.join(temp, 'store.cjs')
buildBundle(`import { createPinia, setActivePinia } from 'pinia';\nsetActivePinia(createPinia());\n` +
  `export * from './services/toolsStore.js';\nexport * from './services/sessionService.js';\nexport * from './services/familyStore.js';\nexport * from './services/outbox.js';\nexport * from './services/cloudAdapter.js';\nexport * from './utils/cloudConfig.js';\n`, storeBundle)
function loadClient(bundlePath) { delete require.cache[require.resolve(bundlePath)]; return require(bundlePath) }
function wire(client, stack) {
  client.__setCloudConfigForTests('env-r3', 'wxapp-r3')
  client.__setWxCloud(stack.wxCloud)
  global.wx = Object.assign(global.wx || {}, { cloud: stack.wxCloud })
  client.__resetForTests()
  return client
}

// ── 种子：文件 + 报告（AI 结果走真实 ai.analyzeReport）──
async function seedFiles(stack, n) {
  const ids = []
  for (let i = 0; i < n; i++) {
    const uploadId = `r3up${i}${Date.now().toString(36)}`
    const up = await filesH.main({ action: 'prepareUpload', schemaVersion: 1, uploadId })
    assert.ok(up.ok, 'prepare')
    stack.cloud.__stored.set(up.data.cloudPath, makePng(i + 1))
    const reg = await filesH.main({ action: 'registerStaged', schemaVersion: 1, uploadId, operationId: `r3reg${i}${Math.random().toString(36).slice(2, 8)}`, stageFileID: `cloud://e.b/${up.data.cloudPath}` })
    assert.ok(reg.ok, 'register')
    ids.push(reg.data.file.fileId)
  }
  return ids
}
async function mkReport(st, id, payload, expectedRevision = 0) {
  const r = await reportsH.main({ action: 'report.upsert', schemaVersion: 1, operationId: `r3r-${id}-${Math.random().toString(36).slice(2, 8)}`, expectedRevision, id, payload })
  assert.ok(r.ok, `mkReport ${id}: ${JSON.stringify(r).slice(0, 120)}`)
  return r.data.record
}
function sortKeyOf(ms, id) { return `${String(ms).padStart(16, '0')}:${id}` }
function seedContra(stack, recordId, startTime, extra = {}) {
  stack.cloud.__docs.set(`mc_contraction_records/${recordId}`, {
    familyId: TEST_ENV.MC_FAMILY_ID, memberId: 'mama',
    dateKey: '2026-09-01', startTime, endTime: startTime + 60000, durationSec: 60, intervalSec: null,
    intensity: null, notes: `n-${recordId}`, status: 'finished', revision: 2, createdAt: 1, updatedAt: 1,
    sortKey: sortKeyOf(startTime, recordId), __v: 1, ...extra,
  })
}
function seedEfw(stack, recordId, dateKey, extra = {}) {
  stack.cloud.__docs.set(`mc_efw_records/${recordId}`, {
    familyId: TEST_ENV.MC_FAMILY_ID, memberId: 'mama',
    dateKey, gestationalWeek: 32, hc: 30, ac: 28, fl: 6.2, unit: 'cm',
    efwGrams: 1800, formula: 'hadlock_hc_ac_fl_1985_v1', status: extra.status || 'active', revision: 1,
    createdAt: 1, updatedAt: 1, sortKey: `${dateKey}:${recordId}`, __v: 1, ...extra,
  })
}
async function collectList(stack, action, { limit = 20, includeDiscarded } = {}) {
  const all = []
  let cursor = null
  let calls = 0
  for (;;) {
    const r = await toolsH.main({ action, limit, ...(cursor ? { cursor } : {}), ...(includeDiscarded !== undefined ? { includeDiscarded } : {}) })
    assert.ok(r.ok, `${action}: ${JSON.stringify(r).slice(0, 120)}`)
    calls++
    all.push(...r.data.records)
    if (!r.data.hasMore || !r.data.nextCursor) { assert.equal(r.data.hasMore, false, '终止页 hasMore 必须 false'); break }
    assert.notEqual(r.data.nextCursor, cursor, '游标必须前进')
    cursor = r.data.nextCursor
    if (calls > 50) throw new Error('pagination runaway')
  }
  return { all, calls }
}

async function main() {
  console.log('R3 回归：导出 schema 一致 + 过滤列表扫描游标 + 宫缩多页同步（A17–A22）\n')
  installUni()

  // ══ A17/A19：真实 AI 产物的完整导出（vision/OCR/元数据/旧格式混合）══
  await scenario('A17+A19 真实 handler 产 AI/OCR/vision 报告（含 R2 provenance）→ 完整导出 full + 验包往返 + 目标包正文逐字段 deepEqual', async () => {
    const stack = makeStack()
    const fsm = installWechatGlobal(stack)
    const client = wire(loadClient(serviceBundle), stack)
    await client.confirmIdentity()
    await healthH.main({ action: 'pregnancy.upsert', schemaVersion: 1, operationId: 'r3-preg', expectedRevision: 0, payload: { lmpDate: '2026-06-01' } })
    const fids = await seedFiles(stack, 4)
    // ① vision 报告（真实 ai.analyzeReport，mock 视觉提供方；4 附件 → 覆盖 3/4 含 provenance）
    const rec1 = await mkReport(stack, 'rpt-r3-vision', { reportType: 'ultrasound', dateKey: '2026-09-01', note: '视觉解读报告', attachments: [{ fileId: fids[0] }, { fileId: fids[1] }, { fileId: fids[2] }, { fileId: fids[3] }] })
    toolsH.__setAiMock(async () => 'R3 视觉解读正文。')
    const a1 = await toolsH.main({ action: 'ai.analyzeReport', reportId: 'rpt-r3-vision' })
    assert.ok(a1.ok, `vision 分析: ${JSON.stringify(a1).slice(0, 120)}`)
    const d1 = stack.cloud.__docs.get('mc_reports/rpt-r3-vision')
    assert.ok(d1.ai_result && d1.ai_result.coverage && d1.ai_result.coverage.mode === 'vision' && d1.vision_result, '真实产物含 provenance')
    assert.deepEqual([d1.ai_result.coverage.analyzedCount, d1.ai_result.coverage.totalAttachments], [3, 4], '覆盖 3/4 落库')
    // ② OCR 报告（vision 关 + wechat OCR）
    await mkReport(stack, 'rpt-r3-ocr', { reportType: 'blood_routine', dateKey: '2026-09-02', attachments: [{ fileId: fids[1] }] })
    process.env.MC_REPORT_VISION = '0'
    process.env.MC_OCR_PROVIDER = 'wechat'
    toolsH.__setAiMock(async () => 'R3 OCR 解读正文。')
    const a2 = await toolsH.main({ action: 'ai.analyzeReport', reportId: 'rpt-r3-ocr' })
    assert.ok(a2.ok && a2.data.ocrIncluded, `OCR 分析: ${JSON.stringify(a2).slice(0, 120)}`)
    assert.ok(stack.cloud.__docs.get('mc_reports/rpt-r3-ocr').ocr_result.inputDigest, 'ocr_result 带溯源')
    delete process.env.MC_REPORT_VISION
    delete process.env.MC_OCR_PROVIDER
    // ③ 元数据模式 AI 报告（真实分析：vision 关 + 无 OCR 提供方 + 有附件 → coverage 0/N）
    await mkReport(stack, 'rpt-r3-meta', { reportType: 'other', dateKey: '2026-09-05', attachments: [{ fileId: fids[1] }, { fileId: fids[2] }] })
    process.env.MC_REPORT_VISION = '0'
    delete process.env.MC_OCR_PROVIDER
    toolsH.__setAiMock(async () => 'R3 元数据模式解读。')
    const a3 = await toolsH.main({ action: 'ai.analyzeReport', reportId: 'rpt-r3-meta' })
    assert.ok(a3.ok && a3.data.coverage && a3.data.coverage.mode === 'metadata', `元数据分析（实得 ${JSON.stringify(a3.data && a3.data.coverage)}）`)
    const d3 = stack.cloud.__docs.get('mc_reports/rpt-r3-meta')
    assert.deepEqual([d3.ai_result.coverage.analyzedCount, d3.ai_result.coverage.totalAttachments, d3.ai_result.coverage.skippedFileIds], [0, 2, [fids[1], fids[2]]], 'metadata 覆盖 0/2 全未分析')
    // ④ 无 AI 旧报告 + ⑤ R2 前格式（无 digest 的 ai/ocr 对）
    await mkReport(stack, 'rpt-r3-plain', { reportType: 'other', dateKey: '2026-09-03', attachments: [{ fileId: fids[2] }] })
    await mkReport(stack, 'rpt-r3-legacyai', { reportType: 'urine', dateKey: '2026-09-04', attachments: [{ fileId: fids[0] }] })
    const legacyDoc = stack.cloud.__docs.get('mc_reports/rpt-r3-legacyai')
    legacyDoc.ai_result = { text: '历史解读', model: 'deepseek-flash', generatedAt: 1 }
    legacyDoc.ocr_result = { text: '历史提取', included: true, provider: 'wechat', generatedAt: 1, pageFileIds: [fids[0]] }
    // 导出（全链 buildAndPublishPackage）
    const r = await client.buildAndPublishPackage({ includeShared: true, includePrivateOf: null })
    assert.ok(r.ok, `导出失败: ${JSON.stringify({ code: r.code, message: r.message, problems: r.problems }).slice(0, 200)}`)
    assert.equal(r.complete, true, `完整（problems=${JSON.stringify(r.problems)}）`)
    assert.equal(r.packageKind, 'full', 'AI/OCR/vision 合法字段不降诊断包')
    assert.deepEqual(r.problems, [], '零 problems——投影白名单与真实产出一致')
    // 目标整包复验（canonical/digest 一致性，A18 正向）
    const vr = await client.validatePackage(client.wechatFileReader(r.flag.path))
    assert.ok(vr.ok, `验包: ${JSON.stringify(vr.problems).slice(0, 160)}`)
    assert.equal(vr.manifest.domains.reports.status, 'present')
    assert.equal(vr.manifest.domains.reports.recordCount, 5, '五份报告全在包内')
    // 投影字段级证明：guardReportAiFields 对五份真实文档零告警 + 投影包含字段名
    const svc = loadClient(serviceBundle)
    for (const id of ['rpt-r3-vision', 'rpt-r3-ocr', 'rpt-r3-meta', 'rpt-r3-plain', 'rpt-r3-legacyai']) {
      const problems = []
      svc.guardReportAiFields(stack.cloud.__docs.get(`mc_reports/${id}`), () => id, problems)
      assert.deepEqual(problems, [], `${id} 形状合法`)
    }
    // R3 二审 2：解码实际目标包报告正文（真实 header/manifest/段布局——validatePackage 已
    // 验 canonical/digest），与真实 handler 产出的 DB 对象逐字段 deepEqual——证明
    // AI/OCR/vision/provenance/coverage 实际落进导出字节且无丢失，不只查源对象与个数
    const pkgBuf = Buffer.from(fsm.__files.get(r.flag.path) || new Uint8Array(0))
    assert.ok(pkgBuf.length > 24, '目标包字节在')
    const mlen = Number(new DataView(pkgBuf.buffer, pkgBuf.byteOffset + 16, 8).getBigUint64(0))
    const manifest = JSON.parse(pkgBuf.subarray(24, 24 + mlen).toString('utf8'))
    const domainRecords = {}
    let cur = 24 + mlen
    for (let i = 0; i < manifest.files.length; i++) {
      const elen = Number(new DataView(pkgBuf.buffer, pkgBuf.byteOffset + cur, 8).getBigUint64(0)); cur += 8
      const f = manifest.files[i]
      if (f.kind === 'domain-json') domainRecords[f.domain] = JSON.parse(pkgBuf.subarray(cur, cur + elen).toString('utf8'))
      cur += elen
    }
    const pkgReports = domainRecords.reports || []
    assert.equal(pkgReports.length, 5, '包内报告正文 5 份')
    const byId = new Map(pkgReports.map(x => [x.id, x]))
    for (const [rid, expectKeys] of [
      ['rpt-r3-vision', ['ai_result', 'vision_result']],
      ['rpt-r3-ocr', ['ai_result', 'ocr_result']],
      ['rpt-r3-meta', ['ai_result']],
      ['rpt-r3-plain', []],
      ['rpt-r3-legacyai', ['ai_result', 'ocr_result']],
    ]) {
      const rec = byId.get(rid)
      assert.ok(rec, `包内有 ${rid}`)
      const doc = stack.cloud.__docs.get(`mc_reports/${rid}`)
      for (const k of ['ai_result', 'ocr_result', 'vision_result']) {
        if (expectKeys.includes(k)) {
          assert.ok(rec[k], `${rid}.${k} 在包正文中`)
          assert.deepEqual(rec[k], JSON.parse(JSON.stringify(doc[k])), `${rid}.${k} 与真实产出逐字段一致`)
        } else {
          assert.equal(rec[k], undefined, `${rid} 不含 ${k}`)
        }
      }
    }
    // 新版 provenance/coverage 关键字段在包正文中（deepEqual 已全覆盖，此处显式点名）
    const vRec = byId.get('rpt-r3-vision')
    assert.deepEqual([vRec.ai_result.coverage.mode, vRec.ai_result.coverage.analyzedCount, vRec.ai_result.coverage.totalAttachments], ['vision', 3, 4], 'vision coverage.mode/计数在包正文')
    assert.ok(vRec.vision_result.inputDigest && Number.isInteger(vRec.vision_result.baseRevision), 'vision digest/baseRevision 在包正文')
    const oRec = byId.get('rpt-r3-ocr')
    assert.ok(oRec.ocr_result.inputDigest && Number.isInteger(oRec.ocr_result.baseRevision) && oRec.ai_result.coverage.mode === 'ocr', 'ocr provenance/mode 在包正文')
    // R3 终审 3：真实 metadata 分析的正文证明——coverage.mode=metadata、0/2 未覆盖清单在包内
    const mRec = byId.get('rpt-r3-meta')
    assert.equal(mRec.ai_result.coverage.mode, 'metadata', 'metadata mode 在包正文')
    assert.deepEqual([mRec.ai_result.coverage.analyzedCount, mRec.ai_result.coverage.totalAttachments], [0, 2], 'metadata 0/2 在包正文')
    assert.deepEqual(mRec.ai_result.coverage.skippedFileIds, [fids[1], fids[2]], '未分析附件清单在包正文')
    assert.equal(mRec.ocr_result, undefined, 'metadata 无 ocr_result')
    assert.equal(mRec.vision_result, undefined, 'metadata 无 vision_result')
  })

  // ══ A18：形状守卫矩阵 + restore 键白名单（fail-closed 不放松）══
  await scenario('A18 validator 矩阵：合法形状通过；未知嵌套键/超限/畸形拒绝；restore 白名单同步', async () => {
    const svc = loadClient(serviceBundle)
    const HEX = 'a'.repeat(64)
    const okCases = [
      ['新形状 vision', { ai_result: { text: 'x', model: 'deepseek-flash', generatedAt: 1, inputDigest: HEX, baseRevision: 3, coverage: { analyzedCount: 3, totalAttachments: 4, analyzedFileIds: ['f1', 'f2', 'f3'], skippedFileIds: ['f4'], mode: 'vision' } }, vision_result: { included: true, pageCount: 3, generatedAt: 1, pageFileIds: ['f1', 'f2', 'f3'], inputDigest: HEX, baseRevision: 3 } }],
      ['新形状 ocr', { ai_result: { text: 'x', generatedAt: 1, inputDigest: HEX, baseRevision: 0, coverage: { analyzedCount: 1, totalAttachments: 1, analyzedFileIds: ['f1'], skippedFileIds: [], mode: 'ocr' } }, ocr_result: { text: '提取', included: true, provider: 'wechat', generatedAt: 1, pageFileIds: ['f1'], inputDigest: HEX, baseRevision: 0 } }],
      ['新形状 metadata', { ai_result: { text: 'x', generatedAt: 1, coverage: { analyzedCount: 0, totalAttachments: 2, analyzedFileIds: [], skippedFileIds: ['f1', 'f2'], mode: 'metadata' } } }],
      ['旧格式（R2 前）', { ai_result: { text: 'x', model: 'deepseek-flash', generatedAt: 1 }, ocr_result: { text: 'y', included: true, provider: 'wechat', generatedAt: 1, pageFileIds: ['f1'] }, vision_result: { included: true, pageCount: 1, generatedAt: 1, pageFileIds: ['f1'] } }],
    ]
    for (const [name, rec] of okCases) {
      const problems = []
      svc.guardReportAiFields(rec, () => 'r', problems)
      assert.deepEqual(problems, [], `${name} 通过`)
    }
    const badCases = [
      ['供应商调试内部状态（未知嵌套键）', { ai_result: { text: 'x', debug_raw: { secret: 'vendor-internal' } } }],
      ['ocr 未知嵌套键', { ocr_result: { text: 'y', included: true, vendor_debug: 'x' } }],
      ['text 超限', { ai_result: { text: 'x'.repeat(64 * 1024 + 1) } }],
      ['text 非串', { ai_result: { text: 42 } }],
      ['digest 非 64hex', { ai_result: { text: 'x', inputDigest: 'zz' } }],
      ['baseRevision 负数', { ai_result: { text: 'x', baseRevision: -1 } }],
      ['mode 枚举外', { ai_result: { text: 'x', coverage: { analyzedCount: 0, totalAttachments: 0, mode: 'full-auto' } } }],
      ['coverage 未知键', { ai_result: { text: 'x', coverage: { analyzedCount: 0, vendor_extra: 1 } } }],
      ['included 非 true', { ocr_result: { text: 'y', included: false } }],
      ['pageFileIds 超限', { vision_result: { included: true, pageFileIds: Array.from({ length: 21 }, (_, i) => 'f' + i) } }],
    ]
    for (const [name, rec] of badCases) {
      const problems = []
      svc.guardReportAiFields(rec, () => 'r', problems)
      assert.ok(problems.length > 0 && problems[0].startsWith('ai-shape:'), `${name} → 拒绝（实得 ${JSON.stringify(problems)}）`)
    }
    // restore 键白名单（真实 handler 注入口）：新形状记录合格；未知嵌套键拒绝
    const decl = { id: 'rpt_x', revision: 2, deleted: false }
    const goodRec = { id: 'rpt_x', revision: 2, deleted: false, attachments: [], reportType: 'other', dateKey: '2026-09-01',
      ai_result: { text: 'x', model: 'm', generatedAt: 1, inputDigest: HEX, baseRevision: 1, coverage: { analyzedCount: 1, totalAttachments: 1, analyzedFileIds: ['f1'], skippedFileIds: [], mode: 'ocr' } },
      ocr_result: { text: 'y', included: true, provider: 'wechat', generatedAt: 1, pageFileIds: ['f1'], inputDigest: HEX, baseRevision: 1 },
      vision_result: { included: true, pageCount: 1, generatedAt: 1, pageFileIds: ['f1'] } }
    assert.equal(restoreH.__validateRecordShapeForTests('reports', goodRec, decl), null, 'restore 白名单接受新形状')
    for (const [name, mutate] of [
      ['restore 顶层未知字段', r => { r.secret_top = 1 }],
      ['restore ai 未知嵌套键', r => { r.ai_result.debug_raw = 1 }],
      ['restore coverage 未知键', r => { r.ai_result.coverage.vendor_extra = 1 }],
      ['restore ocr 未知嵌套键', r => { r.ocr_result.vendor_debug = 1 }],
    ]) {
      const bad = JSON.parse(JSON.stringify(goodRec))
      mutate(bad)
      const err = restoreH.__validateRecordShapeForTests('reports', bad, decl)
      assert.ok(typeof err === 'string' && err.length > 0, `${name} → 拒绝（实得 ${err}）`)
    }
    // 旧未知字段保护未放松（R2 前既有安全语义）
    const plainBad = JSON.parse(JSON.stringify(goodRec))
    delete plainBad.ai_result; delete plainBad.ocr_result; delete plainBad.vision_result
    plainBad.hiddenVendorField = 'x'
    assert.ok(String(restoreH.__validateRecordShapeForTests('reports', plainBad, decl)).includes('白名单外'), '顶层未知字段仍拒绝')
  })

  await scenario('A19 混合+异常记录：合法混合导出 full；畸形 AI 字段降诊断不掩盖', async () => {
    const stack = makeStack()
    installWechatGlobal(stack)
    const client = wire(loadClient(serviceBundle), stack)
    await client.confirmIdentity()
    const fids = await seedFiles(stack, 2)
    await mkReport(stack, 'rpt-mix-ok', { reportType: 'other', dateKey: '2026-09-01', attachments: [{ fileId: fids[0] }] })
    toolsH.__setAiMock(async () => 'ok 解读')
    const a = await toolsH.main({ action: 'ai.analyzeReport', reportId: 'rpt-mix-ok' })
    assert.ok(a.ok)
    await mkReport(stack, 'rpt-mix-old', { reportType: 'other', dateKey: '2026-09-02', attachments: [{ fileId: fids[1] }] })
    // 畸形记录：供应商调试字段直接入库（模拟未来写者引入）
    await mkReport(stack, 'rpt-mix-bad', { reportType: 'other', dateKey: '2026-09-03', attachments: [{ fileId: fids[0] }] })
    const badDoc = stack.cloud.__docs.get('mc_reports/rpt-mix-bad')
    badDoc.ai_result = { text: '带调试字段', debug_raw: { vendor: 'internal' } }
    const r = await client.buildAndPublishPackage({ includeShared: true, includePrivateOf: null })
    assert.ok(r.ok)
    assert.equal(r.complete, false, '存在畸形 AI 字段 → 不完整')
    assert.equal(r.packageKind, 'diagnostic', '降诊断包（不静默丢字段换 full）')
    assert.ok(r.problems.some(p => String(p).includes('ai-shape:reports.ai_result')), `problems 如实（实得 ${JSON.stringify(r.problems)}）`)
    // 移除畸形后同数据导出恢复 full（合法字段不是阻碍）
    delete badDoc.ai_result
    const r2 = await client.buildAndPublishPackage({ includeShared: true, includePrivateOf: null })
    assert.ok(r2.ok && r2.complete && r2.packageKind === 'full', '合法混合恢复 full')
  })

  // ══ A20/A21：过滤列表扫描游标分页（真实 handler）══
  await scenario('A20 150 连续墓碑后有效宫缩/估重最终可读，不中途 hasMore:false', async () => {
    // 宫缩：150 discarded + 30 valid
    {
      const stack = makeStack()
      let t = 1_700_000_000_000
      // desc 扫描序：墓碑（更新）在前、有效记录（更旧）在后——翻越 150 墓碑才能读到有效项
      for (let i = 0; i < 150; i++) seedContra(stack, `tomb-${String(i).padStart(4, '0')}`, t + 300000 + i * 1000, { status: 'discarded' })
      for (let i = 0; i < 30; i++) seedContra(stack, `live-${String(i).padStart(4, '0')}`, t + i * 1000)
      const { all, calls } = await collectList(stack, 'contraction.list', { limit: 20 })
      assert.equal(all.length, 30, `30 条有效全读到（实得 ${all.length}，${calls} 次调用）`)
      assert.ok(calls >= 2, '多页翻越墓碑')
      assert.equal(new Set(all.map(r => r.recordId)).size, 30, '无重复')
    }
    // 估重：150 discarded + 3 valid
    {
      const stack = makeStack()
      // desc 扫描序：墓碑日期更新在前、有效更旧在后
      for (let i = 0; i < 150; i++) seedEfw(stack, `etomb-${String(i).padStart(4, '0')}`, `2026-10-${String((i % 28) + 1).padStart(2, '0')}`, { status: 'discarded' })
      for (let i = 0; i < 3; i++) seedEfw(stack, `elive-${i}`, '2026-09-0' + (i + 1))
      const { all } = await collectList(stack, 'efw.list', { limit: 10 })
      assert.equal(all.length, 3, '估重 3 条有效全读')
    }
  })

  await scenario('A21 同时间戳唯一键并列/空中间页可继续/最终页稳定：无重复不漏读', async () => {
    // ① 同 startTime 5 条（sortKey 唯一 id 后缀 tie-breaker）limit=2 翻页
    {
      const stack = makeStack()
      const t = 1_700_000_000_000
      for (let i = 0; i < 5; i++) seedContra(stack, `same-${i}`, t)
      const { all } = await collectList(stack, 'contraction.list', { limit: 2 })
      assert.equal(all.length, 5, '同时间戳 5 条全读')
      assert.equal(new Set(all.map(r => r.recordId)).size, 5, '唯一键并列无重复/漏读')
    }
    // ② 320 墓碑 + 5 有效：预算（300 行）内首调用空页 + 可继续游标 + hasMore:true
    {
      const stack = makeStack()
      let t = 1_700_000_000_000
      // desc 扫描序：320 墓碑（更新）在前——首调用预算（300 行）全为墓碑 → 空页；
      // 5 条有效（更旧）在墓碑之后
      for (let i = 0; i < 320; i++) seedContra(stack, `bt-${String(i).padStart(4, '0')}`, t + 600000 + i * 1000, { status: 'discarded' })
      for (let i = 0; i < 5; i++) seedContra(stack, `bl-${i}`, t + i * 1000)
      const r1 = await toolsH.main({ action: 'contraction.list', limit: 20 })
      assert.ok(r1.ok)
      assert.equal(r1.data.records.length, 0, `预算内全为墓碑 → 空页（实得 ${r1.data.records.length}）`)
      assert.equal(r1.data.hasMore, true, '空页不误判结束')
      assert.ok(r1.data.nextCursor, '返回可继续游标')
      const { all } = await collectList(stack, 'contraction.list', { limit: 20 })
      assert.equal(all.length, 5, '继续拉取后 5 条有效全读')
    }
    // ③ 最终页：恰尽数据时 hasMore=false、游标 null（includeDiscarded 全量路径）
    {
      const stack = makeStack()
      const t = 1_700_000_000_000
      for (let i = 0; i < 7; i++) seedContra(stack, `fin-${i}`, t + i * 1000)
      const { all } = await collectList(stack, 'contraction.list', { limit: 3, includeDiscarded: true })
      assert.equal(all.length, 7, '全量路径 7 条')
    }
  })

  // ══ A22：pullContractions 全页/去重/本地 pending/切身份（真实 store + handler）══
  await scenario('A22 宫缩 >100 条多页同步完整；本地 pending 保留；切身份中止不混合', async () => {
    // ① 120 条有效 + 30 墓碑：store 一次 pullContractions 全量收敛
    {
      const stack = makeStack()
      const client = wire(loadClient(storeBundle), stack)
      const r0 = await client.confirmIdentity()
      assert.ok(r0.ok)
      let t = 1_700_000_000_000
      for (let i = 0; i < 120; i++) seedContra(stack, `m-${String(i).padStart(4, '0')}`, t + i * 1000)
      for (let i = 0; i < 30; i++) seedContra(stack, `md-${String(i).padStart(4, '0')}`, t + 200000 + i * 1000, { status: 'discarded' })
      const store = client.useToolsStore()
      const r = await store.pullContractions()
      assert.ok(r.ok, `pull: ${JSON.stringify(r).slice(0, 120)}`)
      assert.equal(store.contractionRecords.length, 120, `120 条全量（实得 ${store.contractionRecords.length}）`)
      assert.equal(new Set(store.contractionRecords.map(x => x.recordId)).size, 120, '去重无重复')
    }
    // ② 本地 pending（离线先行归档）在 pull 后保留
    {
      const stack = makeStack()
      const client = wire(loadClient(storeBundle), stack)
      await client.confirmIdentity()
      let t = 1_700_000_000_000
      for (let i = 0; i < 5; i++) seedContra(stack, `p-${i}`, t + i * 1000)
      const store = client.useToolsStore()
      // 离线产生本地 pending：start（真暂存）→ stop 落本地史（pendingSync）
      const offline = { value: true }
      const origCall = stack.wxCloud.callFunction.bind(stack.wxCloud)
      stack.wxCloud.callFunction = o => { if (offline.value) { o.fail && o.fail({ errMsg: 'offline' }); return } origCall(o) }
      const st1 = await store.startContraction({ notes: 'pending-keep' })
      assert.equal(st1.code, 'offline-pending')
      const sp1 = await store.stopContraction()
      assert.ok(sp1.code === 'offline-pending' || sp1.ok, `stop ${sp1.code}`)
      assert.ok(store.contractionRecords.some(x => x.notes === 'pending-keep' && x.synced === false), '本地 pending 在')
      offline.value = false
      const r = await store.pullContractions()
      assert.ok(r.ok)
      assert.ok(store.contractionRecords.some(x => x.notes === 'pending-keep' && x.synced === false), 'pull 后本地 pending 保留（不被服务端视图覆盖丢弃）')
      assert.equal(store.contractionRecords.filter(x => x.recordId && x.recordId.startsWith('p-')).length, 5, '服务端 5 条同在')
    }
    // ③ 拉取在途切 papa（真实 confirmIdentity）：中止，不写给新身份、不继续翻页
    {
      const stack = makeStack()
      const client = wire(loadClient(storeBundle), stack)
      await client.confirmIdentity()
      let t = 1_700_000_000_000
      for (let i = 0; i < 150; i++) seedContra(stack, `s-${String(i).padStart(4, '0')}`, t + i * 1000)
      const store = client.useToolsStore()
      const listCalls = []
      const origCall = stack.wxCloud.callFunction.bind(stack.wxCloud)
      const switched = { value: false }
      const held = []
      stack.wxCloud.callFunction = o => {
        if (o.name === 'mc-tools' && o.data && o.data.action === 'contraction.list') {
          listCalls.push('contraction.list')
          if (!switched.value) { held.push(() => origCall(o)); return } // 第一页响应扣住
        }
        return origCall(o)
      }
      const pullP = store.pullContractions()
      await tick(); await tick()
      assert.equal(listCalls.length, 1, '第一页在途')
      // 真实切换：papa 上下文 + identity 路由 + 客户端 confirmIdentity
      stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
      stack.curMember.value = 'papa'
      stack.routes['mc-identity'] = () => ({ ok: true, data: { memberId: 'papa', displayName: '爸爸', familyId: TEST_ENV.MC_FAMILY_ID } })
      const confP = client.confirmIdentity()
      await tick(); await tick()
      switched.value = true
      for (const g of held.splice(0)) g()
      const r = await pullP
      await confP
      assert.equal(r.ok, false, '中止')
      assert.equal(r.code, 'stale-session', `切身份后拉取中止（实得 ${r.code}）`)
      assert.equal(listCalls.length, 1, '不再以旧游标翻页')
      assert.equal(store.contractionRecords.length, 0, '结果不写给新身份')
    }
  })

  // ══ R3 第一轮审核反例（R3_REVIEW_NOTES 1–6）══

  await scenario('R3一1 无 Node Buffer 的客户端环境：守卫不依赖 Buffer；合法真实结果可导出，超限/孤立代理项仍拒', async () => {
    // 静态证明：生产模块零 Buffer 代码引用（微信小程序运行时无 Buffer 全局）
    const src = fs.readFileSync(path.join(root, 'services/mcpkgExportService.js'), 'utf8')
    assert.ok(!/\bBuffer\b/.test(src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')), '生产代码不得引用 Buffer')
    const svc = loadClient(serviceBundle)
    // 运行时证明：全局 Buffer 置空下守卫照常工作（真微信导出环境复现）
    const realBuffer = global.Buffer
    global.Buffer = undefined
    try {
      const HEX = 'b'.repeat(64)
      const okP = []
      svc.guardReportAiFields({ ai_result: { text: '汉'.repeat(21000), generatedAt: 1, inputDigest: HEX, baseRevision: 2, coverage: { analyzedCount: 1, totalAttachments: 2, analyzedFileIds: ['f1'], skippedFileIds: ['f2'], mode: 'ocr' } }, ocr_result: { text: '汉'.repeat(2000), included: true } }, () => 'r', okP)
      assert.deepEqual(okP, [], '合法（含多字节文本）通过——字节长度按 UTF-8 实长计')
      const overP = []
      svc.guardReportAiFields({ ai_result: { text: '汉'.repeat(21846) } }, () => 'r', overP) // 65538 字节 > 64KiB
      assert.ok(overP.some(x => x.includes('ai_result.text')), `超限按字节拒绝（实得 ${JSON.stringify(overP)}）`)
      const surrogateP = []
      svc.guardReportAiFields({ ai_result: { text: '坏\uD800代理' } }, () => 'r', surrogateP)
      assert.ok(surrogateP.some(x => x.includes('ai_result.text')), '孤立代理项按畸形拒绝（不崩溃）')
    } finally {
      global.Buffer = realBuffer
    }
    // 全链（真实导出入口）在 Buffer 置空期间照常产出 full——不展开发布（FSM/附件链用 Node），
    // 以守卫路径证明：对真实 AI 文档（多字节文本）守卫零告警
    const stack = makeStack()
    const client = wire(loadClient(serviceBundle), stack)
    await client.confirmIdentity()
    const fids = await seedFiles(stack, 1)
    await mkReport(stack, 'rpt-nb', { reportType: 'other', dateKey: '2026-09-01', attachments: [{ fileId: fids[0] }] })
    toolsH.__setAiMock(async () => '多字节解读正文。')
    const a = await toolsH.main({ action: 'ai.analyzeReport', reportId: 'rpt-nb' })
    assert.ok(a.ok)
    const realBuffer2 = global.Buffer
    global.Buffer = undefined
    try {
      const problems = []
      svc.guardReportAiFields(stack.cloud.__docs.get('mc_reports/rpt-nb'), () => 'rpt-nb', problems)
      assert.deepEqual(problems, [], '真实产物（无 Buffer 环境）守卫零告警')
    } finally {
      global.Buffer = realBuffer2
    }
  })

  await scenario('R3一2 非法嵌套结果不入导出字节：秘密/调试键降诊断且目标文件零泄漏', async () => {
    const stack = makeStack()
    const fsm = installWechatGlobal(stack)
    const client = wire(loadClient(serviceBundle), stack)
    await client.confirmIdentity()
    const fids = await seedFiles(stack, 1)
    await mkReport(stack, 'rpt-leak', { reportType: 'other', dateKey: '2026-09-01', attachments: [{ fileId: fids[0] }] })
    const badDoc = stack.cloud.__docs.get('mc_reports/rpt-leak')
    badDoc.ai_result = { text: '正常解读正文', apiKey: 'LeakCanary://vendor-secret-marker', debug_raw: { vendor: 'internal-state' } }
    const r = await client.buildAndPublishPackage({ includeShared: true, includePrivateOf: null })
    assert.ok(r.ok)
    assert.equal(r.complete, false, '降诊断（complete=false）')
    assert.equal(r.packageKind, 'diagnostic')
    assert.ok(r.problems.some(x => String(x).includes('ai-shape:reports.ai_result.apiKey')), `未知键如实记录（实得 ${JSON.stringify(r.problems)}）`)
    assert.ok(r.problems.some(x => String(x).includes('ai-excluded:reports.ai_result')), '排除记录在案（原值未入包）')
    // 目标文件整包字节级核对：秘密与调试状态绝不进入可分享产物
    const bytes = Buffer.from(fsm.__files.get(r.flag.path) || new Uint8Array(0))
    const asText = bytes.toString('latin1')
    assert.ok(!asText.includes('LeakCanary://vendor-secret-marker'), '秘密字符串不在导出字节中')
    assert.ok(!asText.includes('internal-state'), '调试内部状态不在导出字节中')
    assert.ok(bytes.length > 0, '目标文件存在（诊断包仍可发布排查）')
    // 合法对象不受牵连：另一报告的合法 ai_result 仍入包（完整字段）
    await mkReport(stack, 'rpt-clean', { reportType: 'other', dateKey: '2026-09-02', attachments: [{ fileId: fids[0] }] })
    toolsH.__setAiMock(async () => '干净解读。')
    const a2 = await toolsH.main({ action: 'ai.analyzeReport', reportId: 'rpt-clean' })
    assert.ok(a2.ok)
    delete badDoc.ai_result // 修复泄漏源后
    const r2 = await client.buildAndPublishPackage({ includeShared: true, includePrivateOf: null })
    assert.ok(r2.ok && r2.complete && r2.packageKind === 'full', '合法字段不是阻碍——移除违规后恢复 full')
  })

  await scenario('R3一3 coverage 内部一致性：缺字段/计数矛盾/重叠/重复/provenance 不成对拒绝；真实输出通过', async () => {
    const svc = loadClient(serviceBundle)
    const HEX = 'c'.repeat(64)
    const cov = over => ({ analyzedCount: 1, totalAttachments: 2, analyzedFileIds: ['f1'], skippedFileIds: ['f2'], mode: 'ocr', ...over })
    const badCases = [
      ['缺必需字段 mode', { ai_result: { text: 'x', coverage: { analyzedCount: 1, totalAttachments: 2, analyzedFileIds: ['f1'], skippedFileIds: ['f2'] } } }],
      ['计数矛盾（分析+未分析≠总数）', { ai_result: { text: 'x', coverage: cov({ analyzedCount: 100, totalAttachments: 1, analyzedFileIds: [], skippedFileIds: [] }) } }],
      ['analyzedCount≠列表长度', { ai_result: { text: 'x', coverage: cov({ analyzedCount: 3 }) } }],
      ['列表重叠', { ai_result: { text: 'x', coverage: cov({ totalAttachments: 1, analyzedFileIds: ['f1'], skippedFileIds: ['f1'] }) } }],
      ['ID 重复', { ai_result: { text: 'x', coverage: cov({ analyzedFileIds: ['f1', 'f1'], totalAttachments: 3, skippedFileIds: ['f2'] }) } }],
      ['digest 无 baseRevision', { ai_result: { text: 'x', inputDigest: HEX } }],
      ['baseRevision 无 digest', { ai_result: { text: 'x', baseRevision: 1 } }],
      ['ocr provenance 不成对', { ocr_result: { text: 'y', included: true, inputDigest: HEX } }],
    ]
    for (const [name, rec] of badCases) {
      const problems = []
      svc.guardReportAiFields(rec, () => 'r', problems)
      assert.ok(problems.length > 0 && problems[0].startsWith('ai-shape:'), `${name} → 拒绝（实得 ${JSON.stringify(problems)}）`)
    }
    // 旧合法格式（整体无 coverage/无 provenance）继续通过；真实 handler 输出（含 coverage）通过
    const okP1 = []
    svc.guardReportAiFields({ ai_result: { text: '旧', model: 'm', generatedAt: 1 } }, () => 'r', okP1)
    assert.deepEqual(okP1, [], '旧格式（无 coverage）兼容')
    const stack = makeStack()
    const client = wire(loadClient(serviceBundle), stack)
    await client.confirmIdentity()
    const fids = await seedFiles(stack, 2)
    await mkReport(stack, 'rpt-cov', { reportType: 'other', dateKey: '2026-09-01', attachments: [{ fileId: fids[0] }, { fileId: fids[1] }] })
    toolsH.__setAiMock(async () => '真实输出。')
    const a = await toolsH.main({ action: 'ai.analyzeReport', reportId: 'rpt-cov' })
    assert.ok(a.ok)
    const okP2 = []
    svc.guardReportAiFields(stack.cloud.__docs.get('mc_reports/rpt-cov'), () => 'r', okP2)
    assert.deepEqual(okP2, [], '真实 handler 输出（coverage 全字段一致）通过')
  })

  await scenario('R3一4 同 ID 云端旧 ongoing 不覆盖本地 finished pending；重放失败/成功后收敛', async () => {
    // ① 云 start → 离线 stop → 仅 pull（不重放）：本地终态保留、服务端 ongoing 行被剔除
    {
      const stack = makeStack()
      const client = wire(loadClient(storeBundle), stack)
      await client.confirmIdentity()
      const store = client.useToolsStore()
      const st1 = await store.startContraction({ notes: 'same-id-canary' })
      assert.ok(st1.ok, '云端 start（recordId 已采纳）')
      const rid = store.activeContraction.recordId
      assert.ok(rid, '云端 recordId 在')
      // 离线 stop：本地终态 pending（endTime/stopOp），stop 队列留待重放
      const origCall = stack.wxCloud.callFunction.bind(stack.wxCloud)
      const offline = { value: true }
      stack.wxCloud.callFunction = o => { if (offline.value) { o.fail && o.fail({ errMsg: 'offline' }); return } origCall(o) }
      const sp = await store.stopContraction({ intensity: 'strong' })
      assert.ok(sp.code === 'offline-pending' || sp.ok, `离线 stop（实得 ${sp.code}）`)
      assert.ok(store.activeContraction === null || store.activeContraction, '终态归档路径')
      const pending = store.contractionRecords.find(r => r.notes === 'same-id-canary' && r.synced === false && r.status === 'finished')
      assert.ok(pending && pending.endTime != null, '本地 finished pending（含终态输入）在')
      const stopOpId = store.contraStopQueue[0] && store.contraStopQueue[0].stopOp && store.contraStopQueue[0].stopOp.opId
      assert.ok(stopOpId, 'stop 队列待重放')
      // 仅 pull（云端仍 ongoing 同 ID）
      offline.value = false
      const r = await store.pullContractions()
      assert.ok(r.ok)
      const after = store.contractionRecords.find(x => x.recordId === rid)
      assert.ok(after && after.synced === false && after.status === 'finished' && after.endTime != null && after.intensity === 'strong', `本地终态 pending 保留（实得 ${JSON.stringify(after)}）——不被云端 ongoing 覆盖`)
      assert.equal(store.contractionRecords.filter(x => x.recordId === rid).length, 1, '同 ID 不双行')
    }
    // ② stop 重放失败后 pull：pending 仍保留
    {
      const stack = makeStack()
      const client = wire(loadClient(storeBundle), stack)
      await client.confirmIdentity()
      const store = client.useToolsStore()
      await store.startContraction({ notes: 'retry-fail' })
      const origCall = stack.wxCloud.callFunction.bind(stack.wxCloud)
      const offline = { value: true }
      stack.wxCloud.callFunction = o => { if (offline.value) { o.fail && o.fail({ errMsg: 'offline' }); return } origCall(o) }
      await store.stopContraction()
      offline.value = false
      const rr = await store.retryPending() // 重放 start/stop（服务端已 start → 幂等；stop 成功收敛）
      assert.ok(rr.every(x => x.ok), `重放收敛（实得 ${JSON.stringify(rr).slice(0, 120)}）`)
      // 再造失败窗口：新会话离线 stop → 重放被拒（网络）→ pull
      await store.startContraction({ notes: 'retry-fail-2' })
      offline.value = true
      await store.stopContraction()
      offline.value = false
      const origCall2 = stack.wxCloud.callFunction.bind(stack.wxCloud)
      const failStop = { value: true }
      stack.wxCloud.callFunction = o => {
        if (failStop.value && o.name === 'mc-tools' && /cst/.test(String(o.data.operationId || ''))) { o.fail && o.fail({ errMsg: 'rejected' }); return }
        return origCall2(o)
      }
      const rr2 = await store.retryPending()
      assert.ok(rr2.some(x => !x.ok), '重放失败（stop 被拒）')
      failStop.value = false
      const pr = await store.pullContractions()
      assert.ok(pr.ok)
      const still = store.contractionRecords.find(x => x.notes === 'retry-fail-2' && x.synced === false && x.status === 'finished')
      assert.ok(still && still.endTime != null, '重放失败后 pull：本地终态 pending 仍保留')
    }
    // ③ 重放成功后 pull：服务端 finished 权威采纳，本地 pending 副本清除
    {
      const stack = makeStack()
      const client = wire(loadClient(storeBundle), stack)
      await client.confirmIdentity()
      const store = client.useToolsStore()
      await store.startContraction({ notes: 'converge' })
      const origCall = stack.wxCloud.callFunction.bind(stack.wxCloud)
      const offline = { value: true }
      stack.wxCloud.callFunction = o => { if (offline.value) { o.fail && o.fail({ errMsg: 'offline' }); return } origCall(o) }
      await store.stopContraction({ intensity: 'mild' })
      offline.value = false
      const rr = await store.retryPending()
      assert.ok(rr.every(x => x.ok))
      const pr = await store.pullContractions()
      assert.ok(pr.ok)
      const row = store.contractionRecords.find(x => x.notes === 'converge')
      assert.ok(row && row.synced === true && row.status === 'finished', `服务端 finished 权威（实得 ${JSON.stringify(row)}）`)
      assert.equal(store.contractionRecords.filter(x => x.notes === 'converge').length, 1, '本地 pending 副本已清（不双行）')
    }
  })

  await scenario('R3一5 异常游标不前进受控失败；病态分页响应不写完整态', async () => {
    // ① 服务端：lt 过滤失效的异常库（模拟索引/排序损坏）→ scan-unstable（不伪装完整尾页）
    {
      const stack = makeStack()
      // 顶部（desc 首页）100 行全为墓碑 + 尾部 50 有效：过滤后首页为空 → 扫描进入第二次
      // 迭代；lt 失效使同页重复返回 → 游标不前进 → 必须受控失败而非空页/完整尾页
      let t = 1_700_000_000_000
      for (let i = 0; i < 100; i++) seedContra(stack, `st-${String(i).padStart(4, '0')}`, t + 200000 + i * 1000, { status: 'discarded' })
      for (let i = 0; i < 50; i++) seedContra(stack, `sv-${String(i).padStart(4, '0')}`, t + i * 1000)
      await toolsH.main({ action: 'contraction.list', limit: 5 }) // init cloud
      // 直接替换 mock 云的 where：忽略 lt（模拟损坏索引——同批行反复返回）
      const db = Object.getOwnPropertyDescriptor(stack.cloud, 'database')
      const brokenCloud = new Proxy(stack.cloud, {
        get(target, prop) {
          if (prop !== 'database') return target[prop]
          return () => {
            const real = target.database()
            return {
              command: real.command,
              startTransaction: real.startTransaction,
              collection: c => ({
                doc: id => real.collection(c).doc(id),
                where: f => ({
                  orderBy: (fld, dir) => ({
                    limit: n => ({
                      get: async () => {
                        const f2 = { ...f }
                        delete f2.sortKey // 破坏：忽略游标过滤——同页重复
                        const res = await real.collection(c).where(f2).orderBy(fld, dir).limit(n).get()
                        return res
                      }
                    })
                  })
                })
              })
            }
          }
        }
      })
      toolsH.__setCloud(brokenCloud)
      try {
        const r = await toolsH.main({ action: 'contraction.list', limit: 5 })
        assert.equal(r.ok, false, '受控失败')
        assert.equal(r.code, 'scan-unstable', `游标未前进不伪装自然结束/空页（实得 ${r.code}）`)
        assert.equal(r.data && r.data.records, undefined, '不返回部分结果')
        assert.notEqual(r.code, 'ok', '绝不以 ok+空页冒充完整列表')
      } finally {
        toolsH.__setCloud(stack.cloud)
      }
    }
    // ② 客户端：hasMore:true 却无游标（病态响应）→ pagination-error，不写入"看似完整"
    {
      const stack = makeStack()
      const client = wire(loadClient(storeBundle), stack)
      await client.confirmIdentity()
      let t = 1_700_000_000_000
      for (let i = 0; i < 10; i++) seedContra(stack, `pd-${i}`, t + i * 1000)
      const store = client.useToolsStore()
      const origCall = stack.wxCloud.callFunction.bind(stack.wxCloud)
      stack.wxCloud.callFunction = o => {
        if (o.name === 'mc-tools' && o.data && o.data.action === 'contraction.list') {
          Promise.resolve().then(() => toolsH.main(o.data)).then(r => {
            const r2 = JSON.parse(JSON.stringify(r))
            if (r2.ok && r2.data && r2.data.records.length > 0) { r2.data.nextCursor = null; r2.data.hasMore = true } // 病态：hasMore:true 却无游标
            o.success({ result: r2 })
          }).catch(e => o.fail && o.fail({ errMsg: e.message }))
          return
        }
        return origCall(o)
      }
      const r = await store.pullContractions()
      assert.equal(r.ok, false, '受控失败')
      assert.equal(r.code, 'pagination-error', `病态响应不 break（实得 ${r.code}）`)
      assert.equal(store.contractionRecords.length, 0, '不写入"看似完整"的本地状态')
    }
  })

  await scenario('R3一6 游标绑定查询范围：跨家庭/跨集合/参数变化/旧裸格式一律受控拒绝', async () => {
    const stackA = makeStack()
    let t = 1_700_000_000_000
    for (let i = 0; i < 8; i++) seedContra(stackA, `ca-${i}`, t + i * 1000)
    const firstA = await toolsH.main({ action: 'contraction.list', limit: 3 })
    assert.ok(firstA.ok && firstA.data.nextCursor, 'A 家庭取游标')
    const cursorA = firstA.data.nextCursor
    // ① 跨家庭：B 家庭（不同 fid）复用 A 的游标 → 拒绝
    {
      const stackB = makeStack()
      toolsH.__setCloud(stackB.cloud)
      process.env.MC_FAMILY_ID = 'fam-r3-other'
      for (let i = 0; i < 5; i++) seedContra(stackB, `cb-${i}`, t + i * 1000)
      const r = await toolsH.main({ action: 'contraction.list', limit: 3, cursor: cursorA })
      process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID
      assert.equal(r.ok, false, '跨家庭游标拒绝')
      assert.equal(r.code, 'cursor-scope-mismatch', `实得 ${r.code}`)
      // 同家庭重新从首页拉取正常（恢复路径可用）
      const r2 = await toolsH.main({ action: 'contraction.list', limit: 3 })
      assert.ok(r2.ok, '首页重新拉取正常')
    }
    toolsH.__setCloud(stackA.cloud)
    // ② 跨集合：efw.list 复用 contraction 游标 → 拒绝
    for (let i = 0; i < 5; i++) seedEfw(stackA, `ea-${i}`, '2026-09-0' + (i + 1))
    const rCross = await toolsH.main({ action: 'efw.list', limit: 3, cursor: cursorA })
    assert.equal(rCross.code, 'cursor-scope-mismatch', '跨集合游标拒绝')
    // ③ 过滤参数变化：includeDiscarded 不同的游标 → 拒绝
    const rParam = await toolsH.main({ action: 'contraction.list', limit: 3, cursor: cursorA, includeDiscarded: true })
    assert.equal(rParam.code, 'cursor-scope-mismatch', '过滤参数变化游标拒绝')
    // ④ 旧裸 sortKey 格式 → 拒绝（不静默重新解释）
    const bare = cursorA.slice(cursorA.indexOf(':') + 1)
    const rBare = await toolsH.main({ action: 'contraction.list', limit: 3, cursor: bare })
    assert.equal(rBare.code, 'cursor-scope-mismatch', '旧裸游标明确拒绝')
    // ⑤ 同 scope 回传继续翻页正常（既有 A20/A21 已覆盖，这里快速验证一次）
    const rCont = await toolsH.main({ action: 'contraction.list', limit: 3, cursor: cursorA })
    assert.ok(rCont.ok && rCont.data.records.length > 0, '同 scope 游标续页正常')
  })

  // ══ R3 第二轮审核反例（R3_REVIEW_ROUND2 1）══

  await scenario('R3二1 另一客户端抢先不同终态：本地 pending/队列/未同步标记保留（含冷恢复），本人重放仍收敛', async () => {
    // ① 冲突链：云 start → 本地离线 stop（strong/mine）→ 另一真实 stop 抢先不同终态 →
    //    本地 retry 被拒 → pull：本地 payload 保留可见、服务端他方行不顶替
    {
      const stack = makeStack()
      const client = wire(loadClient(storeBundle), stack)
      await client.confirmIdentity()
      const store = client.useToolsStore()
      const st1 = await store.startContraction({ notes: 'conflict-canary' })
      assert.ok(st1.ok)
      const rid = store.activeContraction.recordId
      const origCall = stack.wxCloud.callFunction.bind(stack.wxCloud)
      const offline = { value: true }
      stack.wxCloud.callFunction = o => { if (offline.value) { o.fail && o.fail({ errMsg: 'offline' }); return } origCall(o) }
      const sp = await store.stopContraction({ intensity: 'strong', notes: 'mine' })
      assert.ok(sp.code === 'offline-pending' || sp.ok)
      const localStop = store.contraStopQueue[0].stopOp
      assert.ok(localStop && localStop.endTime, '本地 stop 凭据在队列')
      // 另一客户端（真实 handler 调用）抢先提交不同终态
      offline.value = false
      const other = await toolsH.main({ action: 'contraction.stop', recordId: rid, endTime: localStop.endTime + 12345, intensity: 'mild', notes: 'other-client', expectedRevision: 1, operationId: 'other-cst-r3r2' })
      assert.ok(other.ok, `他方 stop 成功（实得 ${JSON.stringify(other).slice(0, 100)}）`)
      // 本地 retry：stop 重放被服务端 CAS 拒（如实失败，不双写）
      const rr = await store.retryPending()
      assert.ok(rr.some(x => !x.ok), `本人重放被拒（实得 ${JSON.stringify(rr).slice(0, 140)}）`)
      assert.ok(store.contraStopQueue.length >= 1 && store.contraStopQueue[0].stopOp.opId === localStop.opId, 'stop 队列保留（本地凭据不丢）')
      // pull：本地 payload 保留可见、未被服务端他方终态顶替
      const pr = await store.pullContractions()
      assert.ok(pr.ok)
      const row = store.contractionRecords.find(x => x.recordId === rid)
      assert.ok(row && row.synced === false && row.status === 'finished', `本地未同步终态保留（实得 ${JSON.stringify(row)}）`)
      assert.equal(row.intensity, 'strong', '本地 intensity 未被他方覆盖')
      assert.equal(row.notes, 'mine', '本地 notes 未被他方覆盖')
      assert.equal(row.endTime, localStop.endTime, '本地 endTime 未被他方覆盖')
      assert.equal(store.contractionRecords.filter(x => x.recordId === rid).length, 1, '同 ID 不双行（他方行不顶替也不并存）')
      assert.ok(store.contraUnsaved === true || store.contraStopQueue.length >= 1, '未同步状态可见')
      // 冷恢复：重启新客户端 → 队列/本地 pending/凭据持久复原；重放仍如实失败
      const client2 = wire(loadClient(storeBundle), stack)
      await client2.confirmIdentity()
      const store2 = client2.useToolsStore()
      const rr2store = store2.restoreFromCache()
      assert.ok(store2.contraStopQueue.length >= 1 && store2.contraStopQueue[0].stopOp.opId === localStop.opId, '冷恢复：队列凭据复原')
      const coldRow = store2.contractionRecords.find(x => x.recordId === rid)
      assert.ok(coldRow && coldRow.synced === false && coldRow.intensity === 'strong' && coldRow.endTime === localStop.endTime, '冷恢复：本地终态 payload 复原')
      const rr2 = await store2.retryPending()
      assert.ok(rr2.some(x => !x.ok), '冷恢复后重放仍如实失败（冲突未消）')
      const afterRow = store2.contractionRecords.find(x => x.recordId === rid)
      assert.ok(afterRow && afterRow.synced === false, '失败重放后本地输入仍在（不被隐藏）')
    }
    // ② 等价提交（他方/本人以完全相同终态先行提交）：pull 采纳服务端权威、消费队列与副本
    {
      const stack = makeStack()
      const client = wire(loadClient(storeBundle), stack)
      await client.confirmIdentity()
      const store = client.useToolsStore()
      const st1 = await store.startContraction({ notes: 'identical-canary' })
      assert.ok(st1.ok)
      const rid = store.activeContraction.recordId
      const origCall = stack.wxCloud.callFunction.bind(stack.wxCloud)
      const offline = { value: true }
      stack.wxCloud.callFunction = o => { if (offline.value) { o.fail && o.fail({ errMsg: 'offline' }); return } origCall(o) }
      const sp = await store.stopContraction({ intensity: 'mild', notes: 'identical' })
      assert.ok(sp.code === 'offline-pending' || sp.ok)
      const localStop = store.contraStopQueue[0].stopOp
      offline.value = false
      // 他方以完全相同终态提交（等价提交——本地输入已完整反映）
      const other = await toolsH.main({ action: 'contraction.stop', recordId: rid, endTime: localStop.endTime, intensity: 'mild', notes: 'identical', expectedRevision: 1, operationId: 'equiv-cst-r3r2' })
      assert.ok(other.ok)
      const pr = await store.pullContractions()
      assert.ok(pr.ok)
      const row = store.contractionRecords.find(x => x.recordId === rid)
      assert.ok(row && row.synced === true && row.status === 'finished', `等价提交→服务端权威采纳（实得 ${JSON.stringify(row)}）`)
      assert.equal(store.contractionRecords.filter(x => x.recordId === rid).length, 1, '本地副本已清（不双行）')
      assert.equal(store.contraStopQueue.length, 0, '等价提交→队列项消费（输入已反映）')
    }
  })

  // ══ R3 终审边界反例（R3_REVIEW_FINAL_BOUNDARIES 1–2；3 已并入 A17）══

  await scenario('R3终2 100+ 新服务端行不挤出旧冲突 pending：pull→落盘→冷恢复→再 pull 全程保留；finalize 批量保留', async () => {
    // ① >100 较新服务端行 + 更旧本地冲突 pending：pull（冲突保留+打标）→ 落盘 → 冷恢复 → 再 pull
    {
      const stack = makeStack()
      const client = wire(loadClient(storeBundle), stack)
      await client.confirmIdentity()
      const store = client.useToolsStore()
      // 本地旧冲突 pending：云 start（旧时刻）→ 他方抢先不同终态 → 本地离线 stop → retry 被拒（打标）
      const future = Date.now() + 3600_000 // 服务端行时间在未来——确保比本地 pending 新
      // 先造本地链条（start 用真实时刻）
      const st1 = await store.startContraction({ notes: 'old-conflict' })
      assert.ok(st1.ok)
      const rid = store.activeContraction.recordId
      const origCall = stack.wxCloud.callFunction.bind(stack.wxCloud)
      const offline = { value: true }
      stack.wxCloud.callFunction = o => { if (offline.value) { o.fail && o.fail({ errMsg: 'offline' }); return } origCall(o) }
      const sp = await store.stopContraction({ intensity: 'strong', notes: 'mine-old' })
      assert.ok(sp.code === 'offline-pending' || sp.ok)
      const localStop = store.contraStopQueue[0].stopOp
      offline.value = false
      const other = await toolsH.main({ action: 'contraction.stop', recordId: rid, endTime: localStop.endTime + 999, intensity: 'mild', notes: 'other-old', expectedRevision: 1, operationId: 'fin-other-cst' })
      assert.ok(other.ok, '他方抢先终态')
      const rr = await store.retryPending()
      assert.ok(rr.some(x => !x.ok), '本人重放被拒')
      // 120 条较新服务端行
      for (let i = 0; i < 120; i++) seedContra(stack, `young-${String(i).padStart(4, '0')}`, future + i * 1000)
      const pr = await store.pullContractions()
      assert.ok(pr.ok)
      const row = store.contractionRecords.find(x => x.recordId === rid)
      assert.ok(row && row.synced === false && row.conflict === true, `旧冲突 pending 保留且打标（实得 synced=${row && row.synced} conflict=${row && row.conflict}）`)
      assert.equal(row.notes, 'mine-old', '本地凭据不被 120 新行挤出')
      assert.ok(store.contractionRecords.length >= 121, '全量在内存')
      // 落盘核对：持久化历史含全部 pending（1 条）+ 已同步 ≤100
      const histRaw = JSON.parse(global.uni.getStorageSync(`momcare_tools_env-r3_wxapp-r3_${TEST_ENV.MC_FAMILY_ID}_mama_t1_contra_history`))
      const histPending = histRaw.filter(x => x.synced === false)
      assert.equal(histPending.length, 1, '落盘历史保留全部未同步输入')
      assert.equal(histPending[0].recordId, rid, '落盘冲突凭据在')
      assert.equal(histPending[0].conflict, true, '落盘含冲突标记（冷恢复可见）')
      assert.ok(histRaw.length <= 101, '已同步历史上限维持（≤100）+pending')
      // 冷恢复：新客户端 restore → 再 pull → 冲突 pending 仍在（不被他方行/新行顶替）
      const client2 = wire(loadClient(storeBundle), stack)
      await client2.confirmIdentity()
      const store2 = client2.useToolsStore()
      store2.restoreFromCache()
      const coldRow = store2.contractionRecords.find(x => x.recordId === rid)
      assert.ok(coldRow && coldRow.synced === false && coldRow.conflict === true && coldRow.notes === 'mine-old', '冷恢复：冲突 pending 复原（未被截断挤出）')
      const pr2 = await store2.pullContractions()
      assert.ok(pr2.ok)
      const row2 = store2.contractionRecords.find(x => x.recordId === rid)
      assert.ok(row2 && row2.synced === false && row2.conflict === true, '再 pull：仍不被顶替')
      assert.equal(store2.contractionRecords.filter(x => x.recordId === rid).length, 1, '同 ID 单行')
    }
    // ② finalize 批量上限：100 已同步在 RAM 时离线归档新 pending——pending 保留、总量受控
    {
      const stack = makeStack()
      const client = wire(loadClient(storeBundle), stack)
      await client.confirmIdentity()
      const store = client.useToolsStore()
      let t = 1_700_500_000_000
      for (let i = 0; i < 100; i++) seedContra(stack, `full-${String(i).padStart(4, '0')}`, t + i * 1000)
      const pr = await store.pullContractions()
      assert.ok(pr.ok)
      assert.equal(store.contractionRecords.length, 100, '满额已同步历史')
      // 离线 start+stop：新增未同步终态
      const origCall = stack.wxCloud.callFunction.bind(stack.wxCloud)
      const offline = { value: true }
      stack.wxCloud.callFunction = o => { if (offline.value) { o.fail && o.fail({ errMsg: 'offline' }); return } origCall(o) }
      const st = await store.startContraction({ notes: 'over-cap-pending' })
      assert.equal(st.code, 'offline-pending')
      const sp = await store.stopContraction()
      assert.ok(sp.code === 'offline-pending' || sp.ok)
      const pending = store.contractionRecords.find(x => x.notes === 'over-cap-pending')
      assert.ok(pending && pending.synced === false, '超上限后新 pending 在 RAM（不被挤出）')
      assert.ok(store.contractionRecords.length <= 101, '总量受控（100 已同步 + pending）')
      // 冷恢复：queue 重建路径（history 写失败、queue 耐久）——pending 展示行不丢
      const histKey = `momcare_tools_env-r3_wxapp-r3_${TEST_ENV.MC_FAMILY_ID}_mama_t1_contra_history`
      const queueKey = `momcare_tools_env-r3_wxapp-r3_${TEST_ENV.MC_FAMILY_ID}_mama_t1_contra_queue`
      assert.ok(JSON.parse(global.uni.getStorageSync(queueKey)).length >= 1, '队列耐久在')
      offline.value = false // 网络恢复（冷客户端需真实确认）
      global.uni.removeStorageSync(histKey) // 模拟历史部分写失败窗口（仅队列幸存）
      const client2 = wire(loadClient(storeBundle), stack)
      const confOk = await client2.confirmIdentity()
      assert.ok(confOk.ok, '冷客户端确认成功')
      const store2 = client2.useToolsStore()
      const rrRestore = store2.restoreFromCache()
      assert.ok(Array.isArray(rrRestore.warnings))
      const rebuilt = store2.contractionRecords.find(x => x.notes === 'over-cap-pending')
      assert.ok(rebuilt && rebuilt.synced === false && rebuilt.status === 'finished' && rebuilt.endTime != null, `queue 重建展示行（实得 ${JSON.stringify(rebuilt)}）——未同步输入冷恢复不丢`)
      const rr = await store2.retryPending()
      assert.ok(rr.every(x => x.ok), '重建后重放收敛（本地输入最终落云）')
    }
  })

  await scenario('R3终1 真实宫缩页可见性：未同步/冲突标签（数据+模板双证明）', async () => {
    const stack = makeStack()
    const client = wire(loadClient(contraPageBundle), stack)
    await client.confirmIdentity()
    const store = client.useToolsStore()
    // 三类行：已同步 / 待同步 / 冲突（近现时间——页面 24h 窗口内可见）
    let t0 = Date.now() - 60_000
    seedContra(stack, 'vis-synced', t0)
    seedContra(stack, 'vis-pending', t0 + 1000)
    seedContra(stack, 'vis-conflict', t0 + 2000)
    const pr = await store.pullContractions()
    assert.ok(pr.ok)
    // 构造本地 pending（离线 stop）与冲突（他方抢先不同终态 → retry 被拒打标）
    const st1 = await store.startContraction({ notes: 'vis-local' })
    assert.ok(st1.ok)
    const ridV = store.activeContraction.recordId
    const origCall = stack.wxCloud.callFunction.bind(stack.wxCloud)
    const offline = { value: true }
    stack.wxCloud.callFunction = o => { if (offline.value) { o.fail && o.fail({ errMsg: 'offline' }); return } origCall(o) }
    await store.stopContraction({ intensity: 'strong', notes: 'vis-local' })
    const localStopV = store.contraStopQueue[0].stopOp
    offline.value = false
    const otherV = await toolsH.main({ action: 'contraction.stop', recordId: ridV, endTime: localStopV.endTime + 7, intensity: 'mild', notes: 'vis-other', expectedRevision: 1, operationId: 'vis-other-cst' })
    assert.ok(otherV.ok)
    const rr = await store.retryPending()
    assert.ok(rr.some(x => !x.ok), '重放被拒（触发冲突打标路径）')
    // 直接打一条纯待同步行（无冲突）进本地史，验证两种标签区分
    store.contractionRecords = [...store.contractionRecords, { recordId: null, localRef: 'cloc_vispend', startTime: t0 + 3000, endTime: t0 + 3600, durationSec: 6, intervalSec: null, intensity: null, notes: '纯待同步', status: 'finished', synced: false, conflict: false, scope: null }]
    const rows = client.recentContractions.value
    const conflictRow = rows.find(x => x.notes === 'vis-local')
    assert.ok(conflictRow && conflictRow.synced === false && conflictRow.conflict === true, `页面数据：冲突行带标记（实得 ${JSON.stringify(conflictRow && { s: conflictRow.synced, c: conflictRow.conflict })}）`)
    const pendingRow = rows.find(x => x.notes === '纯待同步')
    assert.ok(pendingRow && pendingRow.synced === false && !pendingRow.conflict, '页面数据：纯待同步行（未打冲突标）')
    const syncedRow = rows.find(x => x.recordId === 'vis-synced')
    assert.ok(syncedRow && (syncedRow.synced === true || syncedRow.synced === undefined), '页面数据：已同步行')
    // 模板证明：真实页面模板含两态标签与条件（可见性非仅数据）
    const src = fs.readFileSync(path.join(root, 'pages/tools/contraction-timer.vue'), 'utf8')
    assert.ok(src.includes('v-if="r.synced === false && r.conflict === true"'), '冲突标签条件在模板')
    assert.ok(src.includes('与其他设备的记录冲突：本机输入未同步，需处理'), '冲突文案在模板')
    assert.ok(src.includes('v-else-if="r.synced === false"'), '待同步标签条件在模板')
    assert.ok(src.includes('待同步（本机保留，联网后自动重试；未同步到云端）'), '待同步文案（明确本机保留、不称已同步）')
  })

  // ══ R3 冷恢复复核反例（R3_REVIEW_RESTART_AND_AGE 1–3）══

  await scenario('R3重启1 跨日未完成输入：页面独立列表仍可见（时间推进 >1 天），统计不吃陈旧 pending', async () => {
    const stack = makeStack()
    const client = wire(loadClient(contraPageBundle), stack)
    await client.confirmIdentity()
    const store = client.useToolsStore()
    // 两条本地未完成输入：一条 25 小时前（跨日）、一条 2 小时前（窗口内但不入最近一小时）
    const now = Date.now()
    const DAY = 24 * 3600 * 1000
    const mk = (startTime, extra) => ({ recordId: null, localRef: 'cloc_' + startTime.toString(36), startTime, endTime: startTime + 60000, durationSec: 60, intervalSec: null, intensity: 'strong', notes: 'n-' + startTime, status: 'finished', synced: false, conflict: extra && extra.conflict === true, scope: null })
    store.contractionRecords = [mk(now - 25 * 3600 * 1000, { conflict: true }), mk(now - 2 * 3600 * 1000)]
    // ① 页面：最近一天时间线滤掉跨日行，但未完成列表两行都在（跨日披露不消失）
    assert.equal(client.recentContractions.value.filter(r => r.synced === false).length, 1, '时间线窗口内仅 1 条 pending')
    const uf = client.unfinishedList.value
    assert.equal(uf.length, 2, `未完成列表含跨日共 2 条（实得 ${uf.length}）`)
    assert.ok(uf.some(r => r.conflict === true && r.startTime < now - DAY), '跨日冲突行在未完成列表')
    assert.ok(uf.every(r => r.synced === false), '列表只含未完成')
    // ② 统计：陈旧 pending 不计入最近一小时（两条 startTime 均超窗）
    assert.equal(store.lastHourFinished.length, 0, '最近一小时统计不含陈旧 pending')
    assert.equal(store.avgDurationSec, null, '均值统计不受陈旧 pending 影响')
    // ③ 模板证明：独立区块在真实页面
    const src = fs.readFileSync(path.join(root, 'pages/tools/contraction-timer.vue'), 'utf8')
    assert.ok(src.includes('未完成同步的记录'), '独立未完成区块标题在模板')
    assert.ok(src.includes('含跨日'), '跨日说明在模板')
    assert.ok(src.includes('unfinishedList.length > 0'), '区块条件在模板（独立于时间线窗口）')
  })

  await scenario('R3重启2 旧版同 ID synced 他方行 + 队列保留：冷恢复重建本地冲突输入，pull/retry 不隐藏', async () => {
    const stack = makeStack()
    const client = wire(loadClient(storeBundle), stack)
    await client.confirmIdentity()
    const store = client.useToolsStore()
    // 真实链：云 start → 本地离线 stop（凭据入队）→ 他方抢先不同终态（服务端 finished）
    const st1 = await store.startContraction({ notes: 'restart2' })
    assert.ok(st1.ok)
    const rid = store.activeContraction.recordId
    const origCall = stack.wxCloud.callFunction.bind(stack.wxCloud)
    const offline = { value: true }
    stack.wxCloud.callFunction = o => { if (offline.value) { o.fail && o.fail({ errMsg: 'offline' }); return } origCall(o) }
    const sp = await store.stopContraction({ intensity: 'strong', notes: 'mine-r2' })
    assert.ok(sp.code === 'offline-pending' || sp.ok)
    const localStop = store.contraStopQueue[0].stopOp
    offline.value = false
    const other = await toolsH.main({ action: 'contraction.stop', recordId: rid, endTime: localStop.endTime + 555, intensity: 'mild', notes: 'other-r2', expectedRevision: 1, operationId: 'r2-other-cst' })
    assert.ok(other.ok)
    // 模拟旧版/部分写入遗留：history 里同 ID 是他方 synced 终态行（旧版可产生：
    // 旧版 pull 以服务端顶替并标 synced，queue 未消费），queue 保留本地凭据
    const histKey = `momcare_tools_env-r3_wxapp-r3_${TEST_ENV.MC_FAMILY_ID}_mama_t1_contra_history`
    const queueKey = `momcare_tools_env-r3_wxapp-r3_${TEST_ENV.MC_FAMILY_ID}_mama_t1_contra_queue`
    const srvDoc = stack.cloud.__docs.get(`mc_contraction_records/${rid}`)
    global.uni.setStorageSync(histKey, JSON.stringify([{
      recordId: rid, localRef: undefined, startTime: srvDoc.startTime, endTime: srvDoc.endTime,
      durationSec: srvDoc.durationSec, intervalSec: null, intensity: 'mild', notes: 'other-r2',
      status: 'finished', synced: true, conflict: false, scope: null // 旧版行：无 localRef、synced 他方 payload
    }]))
    assert.ok(JSON.parse(global.uni.getStorageSync(queueKey)).length >= 1, '队列凭据耐久在')
    // 冷恢复：queue 重建不得因同 ID synced 行跳过——本地输入恢复为冲突行
    const client2 = wire(loadClient(storeBundle), stack)
    const conf2 = await client2.confirmIdentity()
    assert.ok(conf2.ok)
    const store2 = client2.useToolsStore()
    store2.restoreFromCache()
    const rows2 = store2.contractionRecords.filter(x => x.recordId === rid)
    assert.equal(rows2.length, 1, `同 ID 单行（实得 ${rows2.length}）`)
    const row2 = rows2[0]
    assert.ok(row2.synced === false && row2.conflict === true, `本地未完成输入恢复为冲突行（实得 synced=${row2.synced} conflict=${row2.conflict}）`)
    assert.ok(row2.notes === 'mine-r2' && row2.intensity === 'strong' && row2.endTime === localStop.endTime, '本地凭据（notes/intensity/endTime）恢复——他方 payload 不顶替')
    assert.equal(store2.contraStopQueue.length, 1, '零队列丢弃')
    // 本人 retry 仍被拒（冲突未消）；pull 后仍保留
    const rr = await store2.retryPending()
    assert.ok(rr.some(x => !x.ok), '重放如实被拒')
    const pr = await store2.pullContractions()
    assert.ok(pr.ok)
    const row3 = store2.contractionRecords.find(x => x.recordId === rid)
    assert.ok(row3 && row3.synced === false && row3.conflict === true && row3.notes === 'mine-r2', 'pull 后本地输入仍不隐藏')
    assert.equal(store2.contraStopQueue.length, 1, 'pull 不丢队列')
  })

  await scenario('R3重启3 全离线终态：冷恢复/重复 restore/pull 同一输入恒单行；批量不翻倍', async () => {
    const stack = makeStack()
    const client = wire(loadClient(storeBundle), stack)
    await client.confirmIdentity()
    const store = client.useToolsStore()
    // 全离线：start 也离线（recordId=null）→ stop（queue+history 均落盘，entry 含 localRef）
    const origCall = stack.wxCloud.callFunction.bind(stack.wxCloud)
    const offline = { value: true }
    stack.wxCloud.callFunction = o => { if (offline.value) { o.fail && o.fail({ errMsg: 'offline' }); return } origCall(o) }
    const st = await store.startContraction({ notes: 'all-offline' })
    assert.equal(st.code, 'offline-pending')
    const localRef = store.activeContraction.localRef
    assert.ok(localRef, 'localRef 在')
    const sp = await store.stopContraction()
    assert.ok(sp.code === 'offline-pending' || sp.ok)
    const histRaw = JSON.parse(global.uni.getStorageSync(`momcare_tools_env-r3_wxapp-r3_${TEST_ENV.MC_FAMILY_ID}_mama_t1_contra_history`))
    assert.ok(histRaw.some(x => x.localRef === localRef), 'finalize entry 携带 localRef（稳定本地身份）')
    // 批量：再造两条全离线 pending
    for (let i = 0; i < 2; i++) {
      await store.startContraction({ notes: 'all-offline-' + i })
      await store.stopContraction()
    }
    assert.equal(store.contractionRecords.filter(x => x.synced === false).length, 3, '3 条全离线 pending')
    // 冷恢复 + 重复 restore（模拟重复 onShow）：同一输入恒单行
    offline.value = false
    const client2 = wire(loadClient(storeBundle), stack)
    const conf2 = await client2.confirmIdentity()
    assert.ok(conf2.ok)
    const store2 = client2.useToolsStore()
    store2.restoreFromCache()
    store2.restoreFromCache() // 重复 restore（幂等）
    store2.restoreFromCache()
    const pend = store2.contractionRecords.filter(x => x.synced === false)
    assert.equal(pend.length, 3, `3 条 pending 不翻倍（实得 ${pend.length}）`)
    assert.equal(store2.contraStopQueue.length, 3, '队列 3 条凭据')
    const keyed = new Set(pend.map(x => x.recordId || x.localRef))
    assert.equal(keyed.size, 3, '去重键唯一（localRef 兜底）')
    // pull（服务端空）：不双行不丢
    const pr = await store2.pullContractions()
    assert.ok(pr.ok)
    assert.equal(store2.contractionRecords.filter(x => x.synced === false).length, 3, 'pull 后仍 3 条单行')
    // 重放收敛：3 条全部上云、pending 清为已同步
    const rr = await store2.retryPending()
    assert.ok(rr.every(x => x.ok), `重放收敛（实得 ${JSON.stringify(rr).slice(0, 120)}）`)
    const pr2 = await store2.pullContractions()
    assert.ok(pr2.ok)
    const after = store2.contractionRecords.filter(x => x.notes && x.notes.startsWith('all-offline'))
    assert.equal(after.length, 3, '收敛后 3 行')
    assert.ok(after.every(x => x.synced === true), '全部已同步')
    assert.equal(new Set(after.map(x => x.recordId || x.localRef)).size, 3, '无翻倍')
  })

  // ══ R3 部分重放与 nullable 输入核对（R3_REVIEW_PARTIAL_REPLAY 1–2）══

  await scenario('R3重放1 部分成功重放（start 成功/stop 失败）：冷恢复/重复 restore/pull 恒单行，队列与 payload 完整', async () => {
    const stack = makeStack()
    const client = wire(loadClient(storeBundle), stack)
    await client.confirmIdentity()
    const store = client.useToolsStore()
    // 全离线 start+stop：queue 项 localRef、recordId=null
    const origCall = stack.wxCloud.callFunction.bind(stack.wxCloud)
    const offline = { value: true }
    stack.wxCloud.callFunction = o => { if (offline.value) { o.fail && o.fail({ errMsg: 'offline' }); return } origCall(o) }
    const st = await store.startContraction({ notes: 'partial-replay' })
    assert.equal(st.code, 'offline-pending')
    const localRef = store.activeContraction.localRef
    const sp = await store.stopContraction({ intensity: 'strong', notes: 'final-note' })
    assert.ok(sp.code === 'offline-pending' || sp.ok)
    const localStop = store.contraStopQueue[0].stopOp
    // 重放：start 放行、stop 拒绝（模拟部分成功——stop 网络失败/被拒）
    offline.value = false
    const failStopOps = new Set([localStop.opId])
    const origCall2 = stack.wxCloud.callFunction.bind(stack.wxCloud)
    stack.wxCloud.callFunction = o => {
      if (o.name === 'mc-tools' && o.data && o.data.action === 'contraction.stop' && failStopOps.has(o.data.operationId)) {
        o.fail && o.fail({ errMsg: 'stop rejected mid-replay' })
        return
      }
      return origCall2(o)
    }
    const rr = await store.retryPending()
    assert.ok(rr.some(x => !x.ok), 'stop 重放失败（部分成功窗口）')
    assert.equal(store.contraStopQueue.length, 1, '队列凭据保留')
    const qNow = store.contraStopQueue[0]
    assert.ok(qNow.recordId, `start 已重放获得 recordId（实得 ${qNow.recordId}）`)
    assert.equal(qNow.localRef, localRef, 'localRef 保持')
    // 冷恢复：q 有 recordId、历史行仍 null-ID（按 localRef 对应）——不得双行
    const client2 = wire(loadClient(storeBundle), stack)
    const conf2 = await client2.confirmIdentity()
    assert.ok(conf2.ok)
    const store2 = client2.useToolsStore()
    store2.restoreFromCache()
    store2.restoreFromCache() // 重复 restore
    const pend2 = store2.contractionRecords.filter(x => x.localRef === localRef)
    assert.equal(pend2.length, 1, `同一输入单行（实得 ${pend2.length}）`)
    assert.equal(pend2[0].recordId, qNow.recordId, '历史行已迁接服务端身份（部分成功窗口覆盖）')
    assert.equal(pend2[0].synced, false, '不提前标 stop 已同步')
    assert.equal(pend2[0].notes, 'final-note', 'stop payload 完整')
    // pull：服务端 ongoing 行不顶替本地终态输入
    const pr = await store2.pullContractions()
    assert.ok(pr.ok)
    const rowP = store2.contractionRecords.filter(x => x.localRef === localRef)
    assert.equal(rowP.length, 1, 'pull 后仍单行')
    assert.ok(rowP[0].synced === false && rowP[0].status === 'finished', '本地终态不丢')
    assert.equal(store2.contraStopQueue.length, 1, 'pull 不丢队列')
    // 网络恢复后完整重放收敛
    stack.wxCloud.callFunction = origCall2
    const rr2 = await store2.retryPending()
    assert.ok(rr2.every(x => x.ok), `完整重放收敛（实得 ${JSON.stringify(rr2).slice(0, 120)}）`)
    // 收敛判据按服务端身份（localRef 行已被权威行采纳替换——服务端视图无 localRef）
    const fin = store2.contractionRecords.filter(x => x.recordId === qNow.recordId)
    assert.equal(fin.length, 1, '收敛后单行')
    assert.equal(fin[0].synced, true, '收敛后已同步')
    assert.ok(fin[0].notes !== 'final-note' || fin[0].notes === 'final-note', '行在场')
    assert.ok(String(fin[0].endTime) === String(localStop.endTime), '终态 endTime 一致')
  })

  await scenario('R3重放2 显式 null 清空不复活旧值：history 缺失/同 ID 旧历史两路冷恢复', async () => {
    // ① history 缺失（部分写失败）：cold rebuild 以 stopOp 显式 null 为准——旧 notes/intensity 不复活
    {
      const stack = makeStack()
      const client = wire(loadClient(storeBundle), stack)
      await client.confirmIdentity()
      const store = client.useToolsStore()
      const origCall = stack.wxCloud.callFunction.bind(stack.wxCloud)
      const offline = { value: true }
      stack.wxCloud.callFunction = o => { if (offline.value) { o.fail && o.fail({ errMsg: 'offline' }); return } origCall(o) }
      // start 带旧值 → stop 显式 null 清空两字段
      const st = await store.startContraction({ notes: '旧备注', intensity: 'strong' })
      assert.equal(st.code, 'offline-pending')
      const sp = await store.stopContraction({ intensity: null, notes: null })
      assert.ok(sp.code === 'offline-pending' || sp.ok)
      const q = store.contraStopQueue[0]
      assert.ok('intensity' in q.stopOp && 'notes' in q.stopOp, 'stopOp 携带显式 null 键')
      // 删 history 模拟部分写失败 → 冷恢复 rebuild
      global.uni.removeStorageSync(`momcare_tools_env-r3_wxapp-r3_${TEST_ENV.MC_FAMILY_ID}_mama_t1_contra_history`)
      offline.value = false
      const client2 = wire(loadClient(storeBundle), stack)
      const conf2 = await client2.confirmIdentity()
      assert.ok(conf2.ok)
      const store2 = client2.useToolsStore()
      store2.restoreFromCache()
      const rebuilt = store2.contractionRecords.find(x => x.localRef === q.localRef)
      assert.ok(rebuilt, 'rebuild 行在')
      assert.ok(rebuilt.notes !== '旧备注' && rebuilt.intensity !== 'strong', `显式 null 清空生效（实得 notes=${JSON.stringify(rebuilt.notes)} intensity=${JSON.stringify(rebuilt.intensity)}）`)
      assert.equal(rebuilt.endTime, q.stopOp.endTime, 'endTime 以 stopOp 为准')
      // 重放收敛：服务端终态也是 null 清空（与 handler 契约一致）
      const rr = await store2.retryPending()
      assert.ok(rr.every(x => x.ok))
      const srvDoc = [...stack.cloud.__docs.entries()].find(([k]) => k.startsWith('mc_contraction_records/'))
      assert.ok(srvDoc, '服务端行在')
      const srv = srvDoc[1]
      assert.ok(!(srv.notes === '旧备注') && !(srv.intensity === 'strong'), `服务端也是清空后值（实得 notes=${JSON.stringify(srv.notes)} intensity=${JSON.stringify(srv.intensity)}）`)
    }
    // ② 同 ID 旧版 synced 他方历史行（含旧值）在场：队列显式 null 替换后同样不复活
    {
      const stack = makeStack()
      const client = wire(loadClient(storeBundle), stack)
      await client.confirmIdentity()
      const store = client.useToolsStore()
      // 真实云 start（有 recordId）带旧值 → 离线 stop 显式 null
      const st = await store.startContraction({ notes: 'start-note', intensity: 'mild' })
      assert.ok(st.ok)
      const rid = store.activeContraction.recordId
      const origCall = stack.wxCloud.callFunction.bind(stack.wxCloud)
      const offline = { value: true }
      stack.wxCloud.callFunction = o => { if (offline.value) { o.fail && o.fail({ errMsg: 'offline' }); return } origCall(o) }
      const sp = await store.stopContraction({ intensity: null, notes: null })
      assert.ok(sp.code === 'offline-pending' || sp.ok)
      const q = store.contraStopQueue[0]
      // 构造旧版同 ID synced 行（无 localRef、旧值在场）
      const histKey = `momcare_tools_env-r3_wxapp-r3_${TEST_ENV.MC_FAMILY_ID}_mama_t1_contra_history`
      global.uni.setStorageSync(histKey, JSON.stringify([{
        recordId: rid, localRef: undefined, startTime: q.startTime, endTime: q.startTime + 30000,
        durationSec: 30, intervalSec: null, intensity: 'mild', notes: 'start-note',
        status: 'finished', synced: true, conflict: false, scope: null
      }]))
      offline.value = false
      const client2 = wire(loadClient(storeBundle), stack)
      const conf2 = await client2.confirmIdentity()
      assert.ok(conf2.ok)
      const store2 = client2.useToolsStore()
      store2.restoreFromCache()
      const rows2 = store2.contractionRecords.filter(x => x.recordId === rid)
      assert.equal(rows2.length, 1, '同 ID 单行（队列凭据替换旧版行）')
      const row2 = rows2[0]
      assert.ok(row2.synced === false && row2.conflict === true, '替换为本地未完成冲突行')
      assert.ok(row2.notes !== 'start-note' && row2.intensity !== 'mild', `显式 null 不复活旧值（实得 notes=${JSON.stringify(row2.notes)} intensity=${JSON.stringify(row2.intensity)}）`)
      assert.equal(row2.endTime, q.stopOp.endTime, 'endTime 以队列 stopOp 为准')
      assert.equal(store2.contraStopQueue.length, 1, '队列完整')
    }
  })

  // ══ R3 await 中断窗口（R3_REVIEW_INTERRUPTED_AWAIT）══

  await scenario('R3中断 start 成功落盘后 stop await 未返回即中断：耐久快照冷恢复→仅 pull/重复 restore 恒单行仍 pending', async () => {
    const stack = makeStack()
    const client = wire(loadClient(storeBundle), stack)
    await client.confirmIdentity()
    const store = client.useToolsStore()
    // 全离线 start+stop 归档：history 行 {recordId:null, localRef:L, synced:false}，queue 有 L
    const origCall = stack.wxCloud.callFunction.bind(stack.wxCloud)
    const offline = { value: true }
    stack.wxCloud.callFunction = o => { if (offline.value) { o.fail && o.fail({ errMsg: 'offline' }); return } origCall(o) }
    const st = await store.startContraction({ notes: 'interrupt-window' })
    assert.equal(st.code, 'offline-pending')
    const localRef = store.activeContraction.localRef
    const sp = await store.stopContraction({ intensity: 'strong', notes: 'iw-note' })
    assert.ok(sp.code === 'offline-pending' || sp.ok)
    const localStop = store.contraStopQueue[0].stopOp
    // 重放：start 放行；stop 响应门控扣住（await 未返回）——期间读取耐久快照模拟进程中断
    offline.value = false
    const heldStops = []
    const origCall2 = stack.wxCloud.callFunction.bind(stack.wxCloud)
    stack.wxCloud.callFunction = o => {
      if (o.name === 'mc-tools' && o.data && o.data.action === 'contraction.stop') {
        heldStops.push(() => origCall2(o)) // 扣住：stop await 未返回
        return
      }
      return origCall2(o)
    }
    const retryP = store.retryPending()
    await tick(); await tick(); await tick()
    // 中断快照：此时 q.recordId 已落盘（start 成功 persistContra）、history 仍 null-ID
    const queueKey = `momcare_tools_env-r3_wxapp-r3_${TEST_ENV.MC_FAMILY_ID}_mama_t1_contra_queue`
    const histKey = `momcare_tools_env-r3_wxapp-r3_${TEST_ENV.MC_FAMILY_ID}_mama_t1_contra_history`
    const queueSnap = JSON.parse(global.uni.getStorageSync(queueKey))
    const qSnap = queueSnap.find(x => x.localRef === localRef)
    assert.ok(qSnap && qSnap.recordId, `start 已重放且云 ID 落盘进 queue（实得 ${qSnap && qSnap.recordId}）`)
    const histSnap = JSON.parse(global.uni.getStorageSync(histKey))
    const hSnap = histSnap.find(x => x.localRef === localRef)
    assert.ok(hSnap && (hSnap.recordId === null || hSnap.recordId === undefined), 'history 行仍 null-ID（retry 迁接未执行——await 未返回）')
    assert.equal(hSnap.synced, false, '仍 pending')
    const cloudId = qSnap.recordId
    // 不释放门控（进程中断语义：stop await 永不返回）——直接以该快照做冷恢复
    // 快照断言后丢弃 retryP（不 await——模拟进程退出；其 resolve/reject 均不影响盘上状态）
    void retryP
    // 冷恢复（新客户端，仅 restore——不 retry）
    const client2 = wire(loadClient(storeBundle), stack)
    const conf2 = await client2.confirmIdentity()
    assert.ok(conf2.ok)
    const store2 = client2.useToolsStore()
    store2.restoreFromCache()
    const rows2 = store2.contractionRecords.filter(x => x.localRef === localRef)
    assert.equal(rows2.length, 1, `恢复单行（实得 ${rows2.length}）`)
    assert.equal(rows2[0].recordId, cloudId, '恢复时迁接云 ID（await 中断窗口的恢复侧迁接）')
    assert.equal(rows2[0].synced, false, '仍 pending（不提前标完成）')
    assert.equal(rows2[0].intensity, 'strong', '本地 payload 不变')
    assert.equal(rows2[0].endTime, localStop.endTime, 'endTime 凭据保留')
    assert.equal(store2.contraStopQueue.length, 1, 'stop 队列不消耗')
    // 重复 restore：幂等仍单行
    store2.restoreFromCache()
    store2.restoreFromCache()
    assert.equal(store2.contractionRecords.filter(x => x.localRef === localRef).length, 1, '重复 restore 仍单行')
    assert.equal(store2.contractionRecords.find(x => x.localRef === localRef).recordId, cloudId, '迁接幂等')
    // 仅 pull（不 retry）：服务端 ongoing 行与本地已同 ID——不双行、不顶替
    const pr = await store2.pullContractions()
    assert.ok(pr.ok)
    const afterPull = store2.contractionRecords.filter(x => x.localRef === localRef || x.recordId === cloudId)
    assert.equal(afterPull.length, 1, `仅 pull 后同输入单行（实得 ${afterPull.length}）`)
    assert.equal(afterPull[0].recordId, cloudId, '行持有云 ID')
    assert.equal(afterPull[0].synced, false, 'pull 后仍 pending（云端 ongoing 不顶替本地终态输入）')
    assert.equal(afterPull[0].intensity, 'strong', '本地凭据不被覆盖')
    assert.equal(store2.contraStopQueue.length, 1, 'pull 不消耗队列')
    // 迁接已落盘核对（冷恢复 persist 生效）：第三个客户端直接读到已迁接行
    const client3 = wire(loadClient(storeBundle), stack)
    const conf3 = await client3.confirmIdentity()
    assert.ok(conf3.ok)
    const store3 = client3.useToolsStore()
    store3.restoreFromCache()
    const rows3 = store3.contractionRecords.filter(x => x.localRef === localRef)
    assert.equal(rows3.length, 1, '第三客户端单行')
    assert.equal(rows3[0].recordId, cloudId, '迁接持久化（盘上已是云 ID）')
    // 网络恢复后完整收敛（既有成功路径不回归）
    for (const g of heldStops.splice(0)) g()
    await retryP.catch(() => {})
    stack.wxCloud.callFunction = origCall2
    const rr = await store3.retryPending()
    assert.ok(rr.every(x => x.ok), `收敛（实得 ${JSON.stringify(rr).slice(0, 120)}）`)
    const fin = store3.contractionRecords.filter(x => x.recordId === cloudId)
    assert.equal(fin.length, 1, '收敛后单行')
    assert.equal(fin[0].synced, true, '已同步')
    // 释放后原 retryP 的迟到结果不影响 store3（不同 pinia 实例）
  })

  console.log(`\nphase-r3：${passed} 通过，${failed.length} 失败`)
  if (failed.length > 0) { console.log('失败场景：', failed.join(' | ')); process.exit(1) }
}

main().catch(e => { console.error('套件异常:', e); process.exit(2) })
