// 独立验证 IV-R3（2026-10-01，全新会话）：A17–A22 独立反例（与 phase-r3 不同数据/形态）。
// 真实 dist handler（health/schedule/reports/files/identity/tools/restore）+ 真实导出全链
// buildAndPublishPackage → validatePackage → 从实际目标包字节解码正文逐字段 deepEqual；
// scanFilteredList 游标分页（空页/同键并列/预算）；pullContractions 全页去重/本地 pending/
// 同 ID 终态冲突/切身份中止。AI 产物由真实 ai.analyzeReport + mock 提供方产出。
// 本文件为验证会话新增测试，不改生产源码与旧测试期望。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-iv3-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }
const tick = () => new Promise(r => setTimeout(r, 10))

require('node:child_process').execFileSync('node', [path.join(root, 'cloud/assemble.mjs')], { stdio: 'pipe' })
const DIST = path.join(root, 'dist/cloud-functions')
const healthH = require(path.join(DIST, 'mc-health/index.js'))
const scheduleH = require(path.join(DIST, 'mc-schedule/index.js'))
const reportsH = require(path.join(DIST, 'mc-reports/index.js'))
const filesH = require(path.join(DIST, 'mc-files/index.js'))
const identityH = require(path.join(DIST, 'mc-identity/index.js'))
const toolsH = require(path.join(DIST, 'mc-tools/index.js'))
const restoreH = require(path.join(DIST, 'mc-restore/index.js'))

const TEST_ENV = { MC_APPID: 'wxivapp00000003', MC_FAMILY_ID: 'fam-iv3', MC_MEMBER_MAMA_OPENID: 'oIV3MAMA0000001', MC_MEMBER_PAPA_OPENID: 'oIV3PAPA0000001' }
const storage = new Map()
const uniCalls = { toasts: [], shareCalls: [], navs: [] }
let dlSeq = 0
let harnessCloud = null
let fsmFiles = null

function makePng(idx) {
  const zlib = require('node:zlib')
  const raw = Buffer.from([0, (idx * 13 + 7) % 256, (idx * 71 + 3) % 256, (idx * 97 + 180) % 256])
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

function installUni() {
  global.uni = {
    getStorageSync(k) { return storage.has(k) ? storage.get(k) : '' },
    setStorageSync(k, v) { storage.set(k, v) },
    removeStorageSync(k) { storage.delete(k) },
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
    showToast: v => uniCalls.toasts.push(v && v.title), showModal: o => (o && o.success ? o.success({ confirm: true }) : undefined),
    showLoading() {}, hideLoading() {},
    redirectTo() {}, navigateTo: o => uniCalls.navs.push(o && o.url), switchTab() {}, reLaunch() {}, navigateBack() {},
    request: () => {}, uploadFile: () => {},
    downloadFile: o => {
      const url = String(o.url || '')
      const fid = url.startsWith('https://t.i/') ? url.slice('https://t.i/'.length) : url
      const key = String(fid).replace(/^cloud:\/\/[^/]+\//, '')
      const bytes = harnessCloud && harnessCloud.__stored.get(key)
      if (!bytes) { o.fail && o.fail({ errMsg: 'downloadFile:fail 404' }); return }
      const p = 'wxfile://tmp-dl-' + (++dlSeq)
      if (fsmFiles) fsmFiles.set(p, new Uint8Array(bytes))
      o.success && o.success({ tempFilePath: p, statusCode: 200 })
    },
  }
}

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
    startTransaction: async () => {
      const tx = { reads: new Map(), writes: new Map() }
      return { collection: c => ({ doc: id => docApi(c, id, tx) }), commit: async () => { for (const [k, d2] of tx.writes) { const prev = docs.get(k); docs.set(k, { ...d2, __v: (prev ? prev.__v : 0) + 1 }) } }, rollback: async () => { tx.writes.clear() } }
    },
    collection: c => ({ doc: id => docApi(c, id, null), where: f => makeQuery(c, f) })
  }
  return {
    DYNAMIC_CURRENT_ENV: Symbol('env'), init() { state.initialized = true },
    getWXContext() { return { APPID: TEST_ENV.MC_APPID, OPENID: state.caller } },
    database() { if (!state.initialized) throw new Error('init first'); return db },
    downloadFile: async ({ fileID }) => { const k = String(fileID).replace(/^cloud:\/\/[^/]+\//, ''); const b = storedFiles.get(k); if (!b) throw new Error('dl'); return { fileContent: Buffer.from(b) } },
    uploadFile: async ({ cloudPath, fileContent }) => { storedFiles.set(cloudPath, Buffer.from(fileContent)); return { fileID: `cloud://e.b/${cloudPath}` } },
    getTempFileURL: async ({ fileList }) => ({ fileList: fileList.map(f => ({ fileID: f, tempFileURL: 'https://t.i/' + f })) }),
    openapi: { ocr: { printedText: async p => { state.ocrCalls.push(p); return { errCode: 0, words_result: [{ words: '股骨长 6.1cm' }] } } } },
    __docs: docs, __stored: storedFiles, __state: state, __setCtx(o) { state.caller = o },
  }
}

const network = { hold: false }
const gates = []
function makeStack(member = 'mama') {
  for (const k of [...storage.keys()]) { if (k.startsWith('mc_') || k.startsWith('YUNTU_') || k.startsWith('MOMCARE_')) storage.delete(k) }
  uniCalls.toasts.length = 0; uniCalls.shareCalls.length = 0
  network.hold = false; gates.length = 0
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
    callFunction(o) {
      const h = routes[o.name]; if (!h) { o.fail({ errMsg: 'no route' }); return }
      Promise.resolve().then(() => h(o.data)).then(r => {
        if (o.name === 'mc-tools' && network.hold) gates.push({ action: o.data && o.data.action, release: () => o.success({ result: r }) })
        else o.success({ result: r })
      }).catch(e => o.fail({ errMsg: e.message }))
    },
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
const storeBundle = path.join(temp, 'store.cjs')
buildBundle(`import { createPinia, setActivePinia } from 'pinia';\nsetActivePinia(createPinia());\n` +
  `export * from './services/toolsStore.js';\nexport * from './services/sessionService.js';\nexport * from './services/familyStore.js';\nexport * from './services/outbox.js';\nexport * from './services/cloudAdapter.js';\nexport * from './utils/cloudConfig.js';\n`, storeBundle)
function loadClient(bundlePath) { delete require.cache[require.resolve(bundlePath)]; return require(bundlePath) }
function wire(client, stack) {
  client.__setCloudConfigForTests('env-iv3', 'wxapp-iv3')
  client.__setWxCloud(stack.wxCloud)
  global.wx = Object.assign(global.wx || {}, { cloud: stack.wxCloud })
  client.__resetForTests()
  return client
}

async function seedFiles(stack, n) {
  const ids = []
  for (let i = 0; i < n; i++) {
    const uploadId = `iv3up${i}${Date.now().toString(36)}`
    const up = await filesH.main({ action: 'prepareUpload', schemaVersion: 1, uploadId })
    assert.ok(up.ok, 'prepare')
    stack.cloud.__stored.set(up.data.cloudPath, makePng(i + 1))
    const reg = await filesH.main({ action: 'registerStaged', schemaVersion: 1, uploadId, operationId: `iv3reg${i}${Math.random().toString(36).slice(2, 8)}`, stageFileID: `cloud://e.b/${up.data.cloudPath}` })
    assert.ok(reg.ok, 'register')
    ids.push(reg.data.file.fileId)
  }
  return ids
}
async function mkReport(st, id, payload, expectedRevision = 0) {
  const r = await reportsH.main({ action: 'report.upsert', schemaVersion: 1, operationId: `iv3r-${id}-${Math.random().toString(36).slice(2, 8)}`, expectedRevision, id, payload })
  assert.ok(r.ok, `mkReport ${id}: ${JSON.stringify(r).slice(0, 120)}`)
  return r.data.record
}
const sortKeyOf = (ms, id) => `${String(ms).padStart(16, '0')}:${id}`
function seedContra(stack, recordId, startTime, extra = {}) {
  stack.cloud.__docs.set(`mc_contraction_records/${recordId}`, {
    familyId: TEST_ENV.MC_FAMILY_ID, memberId: 'mama',
    dateKey: '2026-09-10', startTime, endTime: startTime + 45000, durationSec: 45, intervalSec: null,
    intensity: null, notes: `iv3-${recordId}`, status: 'finished', revision: 2, createdAt: 1, updatedAt: 1,
    sortKey: sortKeyOf(startTime, recordId), __v: 1, ...extra,
  })
}
function seedEfw(stack, recordId, dateKey, extra = {}) {
  stack.cloud.__docs.set(`mc_efw_records/${recordId}`, {
    familyId: TEST_ENV.MC_FAMILY_ID, memberId: 'mama',
    dateKey, gestationalWeek: 31, hc: 29, ac: 27, fl: 6.0, unit: 'cm',
    efwGrams: 1750, formula: 'hadlock_hc_ac_fl_1985_v1', status: 'active', revision: 1,
    createdAt: 1, updatedAt: 1, sortKey: `${dateKey}:${recordId}`, __v: 1, ...extra,
  })
}
async function collectList(stack, action, { limit = 20, includeDiscarded } = {}) {
  const all = []
  let cursor = null
  let calls = 0
  for (;;) {
    const r = await toolsH.main({ action, limit, ...(cursor ? { cursor } : {}), ...(includeDiscarded !== undefined ? { includeDiscarded } : {}) })
    assert.ok(r.ok, `${action}: ${JSON.stringify(r).slice(0, 140)}`)
    calls++
    all.push(...r.data.records)
    if (!r.data.hasMore || !r.data.nextCursor) { assert.equal(r.data.hasMore, false, '终止页 hasMore 必须 false'); break }
    assert.notEqual(r.data.nextCursor, cursor, '游标必须前进')
    cursor = r.data.nextCursor
    if (calls > 60) throw new Error('pagination runaway')
  }
  return { all, calls }
}

// 自研解码器：从目标包字节解出各 domain 的正文记录（真实 header/manifest/段布局）
function decodePackageDomains(pkgBuf) {
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
  return { manifest, domainRecords }
}

async function main() {
  console.log('IV-R3 独立反例（A17–A22）\n')
  installUni()

  await scenario('A17 真实 handler 产物（vision 3/5、OCR 3/3、metadata 0/2、无 AI、旧格式）→ full 导出 + 验包 + 目标包正文 deepEqual', async () => {
    const stack = makeStack()
    const fsm = installWechatGlobal(stack)
    const client = wire(loadClient(serviceBundle), stack)
    await client.confirmIdentity()
    await healthH.main({ action: 'pregnancy.upsert', schemaVersion: 1, operationId: 'iv3-preg', expectedRevision: 0, payload: { lmpDate: '2026-05-20' } })
    const fids = await seedFiles(stack, 5)
    // ① vision：5 附件 → 3/5
    await mkReport(stack, 'rpt-iv3-v', { reportType: 'ultrasound', dateKey: '2026-09-08', note: 'IV3 视觉报告', attachments: fids.map(f => ({ fileId: f })) })
    toolsH.__setAiMock(async () => 'IV3 视觉解读正文。')
    const a1 = await toolsH.main({ action: 'ai.analyzeReport', reportId: 'rpt-iv3-v' })
    assert.ok(a1.ok, `vision 分析（实得 ${JSON.stringify(a1).slice(0, 120)}）`)
    // ② OCR：vision 关 + wechat OCR，3 附件 → 3/3（页数上限内全覆盖）
    await mkReport(stack, 'rpt-iv3-o', { reportType: 'blood_routine', dateKey: '2026-09-09', attachments: [fids[0], fids[1], fids[2]].map(f => ({ fileId: f })) })
    process.env.MC_REPORT_VISION = '0'
    process.env.MC_OCR_PROVIDER = 'wechat'
    toolsH.__setAiMock(async () => 'IV3 OCR 解读正文。')
    const a2 = await toolsH.main({ action: 'ai.analyzeReport', reportId: 'rpt-iv3-o' })
    assert.ok(a2.ok && a2.data.ocrIncluded && a2.data.coverage.mode === 'ocr', `OCR 分析（实得 ${JSON.stringify(a2.data && a2.data.coverage)}）`)
    // ③ metadata：vision 关 + OCR 撤 → 2 附件 0/2
    delete process.env.MC_OCR_PROVIDER
    await mkReport(stack, 'rpt-iv3-m', { reportType: 'other', dateKey: '2026-09-10', attachments: [{ fileId: fids[3] }, { fileId: fids[4] }] })
    toolsH.__setAiMock(async () => 'IV3 元数据解读。')
    const a3 = await toolsH.main({ action: 'ai.analyzeReport', reportId: 'rpt-iv3-m' })
    assert.ok(a3.ok && a3.data.coverage.mode === 'metadata' && a3.data.coverage.totalAttachments === 2)
    delete process.env.MC_REPORT_VISION
    // ④ 无 AI ⑤ R2 前旧格式
    await mkReport(stack, 'rpt-iv3-p', { reportType: 'urine', dateKey: '2026-09-11', attachments: [{ fileId: fids[4] }] })
    await mkReport(stack, 'rpt-iv3-l', { reportType: 'other', dateKey: '2026-09-12', attachments: [{ fileId: fids[0] }] })
    const legacyDoc = stack.cloud.__docs.get('mc_reports/rpt-iv3-l')
    legacyDoc.ai_result = { text: 'IV3 历史解读', model: 'deepseek-flash', generatedAt: 1 }
    legacyDoc.ocr_result = { text: 'IV3 历史提取', included: true, provider: 'wechat', generatedAt: 1, pageFileIds: [fids[0]] }
    // 导出
    const r = await client.buildAndPublishPackage({ includeShared: true, includePrivateOf: null })
    assert.ok(r.ok, `导出失败: ${JSON.stringify({ code: r.code, message: r.message, problems: r.problems }).slice(0, 200)}`)
    assert.equal(r.complete, true)
    assert.equal(r.packageKind, 'full', '合法 AI/OCR/vision 字段不降诊断')
    assert.deepEqual(r.problems, [])
    // 整包复验
    const vr = await client.validatePackage(client.wechatFileReader(r.flag.path))
    assert.ok(vr.ok, `验包: ${JSON.stringify(vr.problems).slice(0, 160)}`)
    assert.equal(vr.manifest.domains.reports.recordCount, 5)
    // guard 对五份真实文档零告警
    const svc = loadClient(serviceBundle)
    for (const id of ['rpt-iv3-v', 'rpt-iv3-o', 'rpt-iv3-m', 'rpt-iv3-p', 'rpt-iv3-l']) {
      const problems = []
      svc.guardReportAiFields(stack.cloud.__docs.get(`mc_reports/${id}`), () => id, problems)
      assert.deepEqual(problems, [], `${id} 形状合法`)
    }
    // 解码目标包正文逐字段 deepEqual
    const pkgBuf = Buffer.from(fsm.__files.get(r.flag.path) || new Uint8Array(0))
    const { domainRecords } = decodePackageDomains(pkgBuf)
    const byId = new Map((domainRecords.reports || []).map(x => [x.id, x]))
    assert.equal(byId.size, 5)
    for (const [rid, keys] of [
      ['rpt-iv3-v', ['ai_result', 'vision_result']],
      ['rpt-iv3-o', ['ai_result', 'ocr_result']],
      ['rpt-iv3-m', ['ai_result']],
      ['rpt-iv3-p', []],
      ['rpt-iv3-l', ['ai_result', 'ocr_result']],
    ]) {
      const rec = byId.get(rid)
      assert.ok(rec, `包内有 ${rid}`)
      const doc = stack.cloud.__docs.get(`mc_reports/${rid}`)
      for (const k of ['ai_result', 'ocr_result', 'vision_result']) {
        if (keys.includes(k)) assert.deepEqual(rec[k], JSON.parse(JSON.stringify(doc[k])), `${rid}.${k} 与真实产出逐字段一致`)
        else assert.equal(rec[k], undefined, `${rid} 不含 ${k}`)
      }
    }
    const vRec = byId.get('rpt-iv3-v')
    assert.deepEqual([vRec.ai_result.coverage.mode, vRec.ai_result.coverage.analyzedCount, vRec.ai_result.coverage.totalAttachments], ['vision', 3, 5])
    assert.deepEqual(vRec.ai_result.coverage.skippedFileIds, [fids[3], fids[4]], '未分析清单在包正文')
    const oRec = byId.get('rpt-iv3-o')
    assert.deepEqual([oRec.ai_result.coverage.analyzedCount, oRec.ai_result.coverage.totalAttachments], [3, 3], 'OCR 全覆盖计数在包正文')
    assert.ok(oRec.ocr_result.inputDigest && Number.isInteger(oRec.ocr_result.baseRevision), 'ocr 溯源在包正文')
    const mRec = byId.get('rpt-iv3-m')
    assert.equal(mRec.ai_result.coverage.mode, 'metadata')
    assert.equal(mRec.ocr_result, undefined, 'metadata 无 ocr_result')
  })

  await scenario('A18 自建负例矩阵：guard 拒绝未知嵌套/畸形/超限；Buffer 全局缺席照常；restore 白名单同步', async () => {
    const svc = loadClient(serviceBundle)
    const HEX = 'b'.repeat(64)
    const badCases = [
      ['ai_result.usage 供应商用量调试键', { ai_result: { text: 'x', usage: { prompt_tokens: 1 } } }],
      ['ocr_result.__raw 内部状态', { ocr_result: { text: 'y', included: true, __raw: 'zz' } }],
      ['vision_result.trace 调试轨迹', { vision_result: { included: true, trace: [1, 2] } }],
      ['text 超 64KiB（多字节）', { ai_result: { text: '汉'.repeat(Math.floor(64 * 1024 / 3) + 40) } }],
      ['digest 非 hex（zz 开头）', { ai_result: { text: 'x', inputDigest: 'zz' + 'a'.repeat(62) } }],
      ['baseRevision 浮点', { ai_result: { text: 'x', baseRevision: 1.5 } }],
      ['provenance 不成对（有 digest 无 baseRevision）', { ai_result: { text: 'x', inputDigest: HEX } }],
      ['mode 枚举外 mixed', { ai_result: { text: 'x', coverage: { analyzedCount: 0, totalAttachments: 0, analyzedFileIds: [], skippedFileIds: [], mode: 'mixed' } } }],
      ['coverage 缺必需字段', { ai_result: { text: 'x', coverage: { analyzedCount: 1, totalAttachments: 1 } } }],
      ['coverage 计数≠ID 列表长', { ai_result: { text: 'x', coverage: { analyzedCount: 2, totalAttachments: 2, analyzedFileIds: ['f1'], skippedFileIds: ['f2'], mode: 'ocr' } } }],
      ['coverage 分析/未分析重叠', { ai_result: { text: 'x', coverage: { analyzedCount: 1, totalAttachments: 1, analyzedFileIds: ['dup1'], skippedFileIds: ['dup1'], mode: 'ocr' } } }],
      ['ocr included=false', { ocr_result: { text: 'y', included: false } }],
      ['vision pageCount 负', { vision_result: { included: true, pageCount: -1 } }],
      ['pageFileIds 21 项', { vision_result: { included: true, pageFileIds: Array.from({ length: 21 }, (_, i) => 'pf' + i) } }],
    ]
    for (const [name, rec] of badCases) {
      const problems = []
      svc.guardReportAiFields(rec, () => 'r-iv3', problems)
      assert.ok(problems.length > 0 && problems[0].startsWith('ai-shape:'), `${name} → 拒绝（实得 ${JSON.stringify(problems)}）`)
    }
    // 合法多字节文本通过（'汉'×3000=9KB）
    {
      const problems = []
      svc.guardReportAiFields({ ai_result: { text: '汉'.repeat(3000), generatedAt: 1 } }, () => 'r-ok', problems)
      assert.deepEqual(problems, [])
    }
    // Buffer 全局缺席（生产微信客户端无 Node Buffer）：守卫照常判多字节超限
    {
      const realBuffer = global.Buffer
      global.Buffer = undefined
      try {
        const problems = []
        svc.guardReportAiFields({ ai_result: { text: '汉'.repeat(Math.floor(64 * 1024 / 3) + 40) } }, () => 'r-nb', problems)
        assert.ok(problems.length > 0, '无 Buffer 仍拒绝超限多字节')
        const okProblems = []
        svc.guardReportAiFields({ ai_result: { text: '汉'.repeat(100) } }, () => 'r-nb2', okProblems)
        assert.deepEqual(okProblems, [], '无 Buffer 合法多字节照常通过')
      } finally { global.Buffer = realBuffer }
    }
    // restore 键白名单（真实注入口）
    const decl = { id: 'rpt_iv3_x', revision: 2, deleted: false }
    const goodRec = { id: 'rpt_iv3_x', revision: 2, deleted: false, attachments: [], reportType: 'other', dateKey: '2026-09-01',
      ai_result: { text: 'x', model: 'm', generatedAt: 1, inputDigest: HEX, baseRevision: 1, coverage: { analyzedCount: 1, totalAttachments: 1, analyzedFileIds: ['f1'], skippedFileIds: [], mode: 'ocr' } },
      ocr_result: { text: 'y', included: true, provider: 'wechat', generatedAt: 1, pageFileIds: ['f1'], inputDigest: HEX, baseRevision: 1 },
      vision_result: { included: true, pageCount: 1, generatedAt: 1, pageFileIds: ['f1'], inputDigest: HEX, baseRevision: 1 } }
    assert.equal(restoreH.__validateRecordShapeForTests('reports', goodRec, decl), null, '接受新形状')
    for (const [name, mutate] of [
      ['顶层未知字段', r => { r.vendor_top = 1 }],
      ['ai 未知嵌套键', r => { r.ai_result.usage = 1 }],
      ['coverage 未知键', r => { r.ai_result.coverage.prompt_tokens = 1 }],
      ['ocr 未知嵌套键', r => { r.ocr_result.__raw = 1 }],
      ['vision 未知嵌套键', r => { r.vision_result.trace = 1 }],
    ]) {
      const bad = JSON.parse(JSON.stringify(goodRec))
      mutate(bad)
      const err = restoreH.__validateRecordShapeForTests('reports', bad, decl)
      assert.ok(typeof err === 'string' && err.length > 0, `${name} → 拒绝（实得 ${err}）`)
    }
  })

  await scenario('A19 合法混合导出 full；单条畸形 → 诊断包且金丝雀不入目标包字节；移除后恢复 full', async () => {
    const CANARY = 'IV3-Canary-vendor-secret-XYZ'
    // ① 合法混合（无 AI + 真实 vision + 旧格式）→ full
    const stack = makeStack()
    const fsm = installWechatGlobal(stack)
    const client = wire(loadClient(serviceBundle), stack)
    await client.confirmIdentity()
    await healthH.main({ action: 'pregnancy.upsert', schemaVersion: 1, operationId: 'iv3-preg2', expectedRevision: 0, payload: { lmpDate: '2026-05-20' } })
    const fids = await seedFiles(stack, 2)
    await mkReport(stack, 'rpt-iv3-mix1', { reportType: 'other', dateKey: '2026-09-15', attachments: [{ fileId: fids[1] }] })
    await mkReport(stack, 'rpt-iv3-mix2', { reportType: 'ultrasound', dateKey: '2026-09-16', attachments: [{ fileId: fids[0] }] })
    toolsH.__setAiMock(async () => 'IV3 混合导出视觉解读。')
    const a = await toolsH.main({ action: 'ai.analyzeReport', reportId: 'rpt-iv3-mix2' })
    assert.ok(a.ok)
    await mkReport(stack, 'rpt-iv3-mix3', { reportType: 'other', dateKey: '2026-09-17', attachments: [{ fileId: fids[1] }] })
    const legacyDoc = stack.cloud.__docs.get('mc_reports/rpt-iv3-mix3')
    legacyDoc.ai_result = { text: '旧格式', model: 'deepseek-flash', generatedAt: 1 }
    const r1 = await client.buildAndPublishPackage({ includeShared: true, includePrivateOf: null })
    assert.ok(r1.ok && r1.complete === true && r1.packageKind === 'full', `混合合法=full（实得 ${r1.packageKind}/${r1.complete}）`)
    // ② 注入畸形（供应商调试键 + 金丝雀）→ 诊断包 + 金丝雀不入目标文件字节
    const badDoc = stack.cloud.__docs.get('mc_reports/rpt-iv3-mix2')
    badDoc.ai_result = { ...badDoc.ai_result, debug_state: { apiKey: CANARY, rawResponse: 'internal' } }
    const r2 = await client.buildAndPublishPackage({ includeShared: true, includePrivateOf: null })
    assert.ok(r2.ok, `导出本身完成（诊断包）（实得 ${JSON.stringify(r2).slice(0, 120)}）`)
    assert.equal(r2.complete, false)
    assert.equal(r2.packageKind, 'diagnostic', '畸形记录降诊断包')
    assert.ok(r2.problems.some(p => String(p).includes('ai-shape:reports')), `problems 含 ai-shape（实得 ${JSON.stringify(r2.problems)}）`)
    const pkgBuf2 = Buffer.from(fsm.__files.get(r2.flag.path) || new Uint8Array(0))
    assert.ok(pkgBuf2.length > 0, '诊断包目标文件在')
    assert.ok(!pkgBuf2.includes(Buffer.from(CANARY)), '金丝雀原值不出现在目标包字节')
    // 审计记录按设计点名违规键（problems 含 ai-shape/ai-excluded 标记），但原值绝不入任何导出文件
    for (const [fp, bytes] of fsm.__files.entries()) {
      assert.ok(!Buffer.from(bytes).includes(Buffer.from(CANARY)), `金丝雀原值不入任何导出文件（${fp}）`)
    }
    assert.ok(pkgBuf2.includes(Buffer.from('ai_result.debug_state')) || r2.problems.some(p => String(p).includes('debug_state')), '审计记录点名违规键（可审阅）')
    // ③ 移除畸形 → 同数据恢复 full
    const badDoc2 = stack.cloud.__docs.get('mc_reports/rpt-iv3-mix2')
    delete badDoc2.ai_result.debug_state
    const r3 = await client.buildAndPublishPackage({ includeShared: true, includePrivateOf: null })
    assert.equal(r3.packageKind, 'full', '移除畸形恢复 full')
    assert.equal(r3.complete, true)
  })

  await scenario('A20 过滤长前缀：宫缩 160 墓碑+25 有效全读；efw 155 墓碑+2 有效全读（limit20）', async () => {
    const stack = makeStack()
    const t0 = Date.parse('2026-09-01T08:00:00+08:00')
    // 墓碑在扫描序（sortKey 降序=新→旧）**在前**：墓碑时间比有效记录更新
    const rows = []
    for (let i = 0; i < 160; i++) rows.push([`iv3ct-tomb-${i}`, t0 + 5 * 86400000 + i * 1000, { status: 'discarded' }])
    for (let i = 0; i < 25; i++) rows.push([`iv3ct-live-${String(i).padStart(2, '0')}`, t0 + i * 60000, {}])
    // 乱序注入（mock orderBy 按 sortKey 稳定排序）
    for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]] }
    for (const [id, st, extra] of rows) seedContra(stack, id, st, extra)
    const { all, calls } = await collectList(stack, 'contraction.list', { limit: 20 })
    assert.equal(all.length, 25, `有效宫缩全读（实得 ${all.length}）`)
    assert.equal(new Set(all.map(r => r.recordId)).size, 25, '无重复')
    assert.ok(calls >= 2, `真翻页（实得 ${calls} 次）`)
    // efw：320 墓碑（十月，扫描序在前）+ 2 有效（九月）——超出单次扫描预算 300，
    // 首次调用空页+可继续游标，续拉后 2 条有效全读
    for (let i = 0; i < 320; i++) seedEfw(stack, `iv3ef-tomb-${String(i).padStart(3, '0')}`, `2026-10-${String((i % 28) + 1).padStart(2, '0')}${i >= 28 ? '' : ''}`, { status: 'discarded', sortKey: `2026-10-${String((i % 28) + 1).padStart(2, '0')}:iv3ef-tomb-${String(i).padStart(3, '0')}` })
    seedEfw(stack, 'iv3ef-live-a', '2026-09-20')
    seedEfw(stack, 'iv3ef-live-b', '2026-09-21')
    const efw1 = await toolsH.main({ action: 'efw.list', limit: 20 })
    assert.ok(efw1.ok)
    assert.equal(efw1.data.records.length, 0, `预算窗全墓碑→空页（实得 ${efw1.data.records.length}）`)
    assert.equal(efw1.data.hasMore, true, '预算用尽空页仍 hasMore:true')
    assert.ok(efw1.data.nextCursor, '可继续游标')
    const { all: efwAll, calls: efwCalls } = await collectList(stack, 'efw.list', { limit: 20 })
    assert.equal(efwAll.length, 2, `efw 有效全读（实得 ${efwAll.length}）`)
    assert.deepEqual(efwAll.map(r => r.recordId).sort(), ['iv3ef-live-a', 'iv3ef-live-b'])
    assert.ok(efwCalls >= 2, `efw 续拉（实得 ${efwCalls} 次）`)
  })

  await scenario('A21 同时间戳并列/空中间页/游标 scope（家庭/集合/参数/裸格式）', async () => {
    const stack = makeStack()
    const t0 = Date.parse('2026-09-05T10:00:00+08:00')
    // ① 同 startTime 6 条（唯一键 tie-break），limit2 翻页全读无重无漏
    for (let i = 0; i < 6; i++) seedContra(stack, `iv3tie-${i}`, t0)
    const { all } = await collectList(stack, 'contraction.list', { limit: 2 })
    assert.equal(all.length, 6, '同键并列 6 条全读')
    assert.equal(new Set(all.map(r => r.recordId)).size, 6, '无重复')
    // ② 340 墓碑在前 + 3 有效：首次调用应得空页 + hasMore:true + 可继续游标
    const stack2 = makeStack()
    const t1 = Date.parse('2026-09-06T09:00:00+08:00')
    for (let i = 0; i < 340; i++) seedContra(stack2, `iv3big-tomb-${String(i).padStart(3, '0')}`, t1 + i * 1000, { status: 'discarded' })
    for (let i = 0; i < 3; i++) seedContra(stack2, `iv3big-live-${i}`, t1 - (i + 1) * 60000)
    const first = await toolsH.main({ action: 'contraction.list', limit: 20 })
    assert.ok(first.ok)
    assert.equal(first.data.records.length, 0, `首个预算窗全墓碑→空页（实得 ${first.data.records.length}）`)
    assert.equal(first.data.hasMore, true, '空页仍 hasMore:true（可继续）')
    assert.ok(first.data.nextCursor, '返回可继续游标')
    const { all: all2, calls } = await collectList(stack2, 'contraction.list', { limit: 20 })
    // 注：collectList 从首页重拉——首页空页也计入；3 条有效最终全读
    assert.equal(all2.length, 3, '续拉后 3 条全读')
    assert.ok(calls >= 2)
    // ③ 游标 scope 绑定
    const stack3 = makeStack()
    seedContra(stack3, 'iv3sc-a', t0)
    seedContra(stack3, 'iv3sc-b', t0 + 1000)
    const page1 = await toolsH.main({ action: 'contraction.list', limit: 1 })
    assert.ok(page1.ok && page1.data.nextCursor, '取得合法游标')
    const cur = page1.data.nextCursor
    assert.match(cur, /^[0-9a-f]{16}:/, '游标为 <scope>:<sortKey> 形')
    // 同 scope 续页正常
    const page2 = await toolsH.main({ action: 'contraction.list', limit: 1, cursor: cur })
    assert.ok(page2.ok, `同 scope 续页（实得 ${JSON.stringify(page2).slice(0, 100)}）`)
    // 裸旧格式游标 → 拒绝
    const bare = cur.slice(17)
    const rb = await toolsH.main({ action: 'contraction.list', limit: 1, cursor: bare })
    assert.equal(rb.ok, false); assert.equal(rb.code, 'cursor-scope-mismatch', `裸游标（实得 ${rb.code}）`)
    // 跨集合：contraction 游标用于 efw.list → 拒绝
    const rx = await toolsH.main({ action: 'efw.list', limit: 1, cursor: cur })
    assert.equal(rx.code, 'cursor-scope-mismatch', '跨集合拒绝')
    // 过滤参数变化（includeDiscarded）→ 拒绝
    const rp = await toolsH.main({ action: 'contraction.list', limit: 1, cursor: cur, includeDiscarded: true })
    assert.equal(rp.code, 'cursor-scope-mismatch', '参数变化拒绝')
    // 跨家庭：换 MC_FAMILY_ID 后用旧游标 → 拒绝
    process.env.MC_FAMILY_ID = 'fam-iv3-other'
    try {
      const rf = await toolsH.main({ action: 'contraction.list', limit: 1, cursor: cur })
      assert.equal(rf.code, 'cursor-scope-mismatch', '跨家庭拒绝')
    } finally { process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID }
  })

  await scenario('A22 pullContractions：105 有效+30 墓碑一次全量去重；本地 pending 保留；同 ID ongoing/不同终态不顶替；切身份中止', async () => {
    // ① 一次 pull 全量去重
    {
      const stack = makeStack()
      const t0 = Date.parse('2026-09-12T07:00:00+08:00')
      for (let i = 0; i < 30; i++) seedContra(stack, `iv3p-tomb-${i}`, t0 + i * 1000, { status: 'discarded' })
      for (let i = 0; i < 105; i++) seedContra(stack, `iv3p-live-${String(i).padStart(3, '0')}`, t0 + 100000 + i * 30000)
      installWechatGlobal(stack)
      const client = wire(loadClient(storeBundle), stack)
      await client.confirmIdentity()
      const store = client.useToolsStore()
      const r = await store.pullContractions()
      assert.ok(r.ok, `pull（实得 ${JSON.stringify(r).slice(0, 120)}）`)
      assert.equal(store.contractionRecords.length, 105, `全量 105（实得 ${store.contractionRecords.length}）`)
      assert.equal(new Set(store.contractionRecords.map(x => x.recordId)).size, 105, '去重')
    }
    // ② 离线 pending + 服务端行并存（pull 保留本地未同步）
    {
      const stack = makeStack()
      installWechatGlobal(stack)
      const client = wire(loadClient(storeBundle), stack)
      await client.confirmIdentity()
      const store = client.useToolsStore()
      // 云端 5 条
      const t0 = Date.parse('2026-09-13T07:00:00+08:00')
      for (let i = 0; i < 5; i++) seedContra(stack, `iv3q-srv-${i}`, t0 + i * 30000)
      // 本地离线 start+stop → pending
      const fakeOffline = { offline: false }
      const origCall = stack.wxCloud.callFunction.bind(stack.wxCloud)
      stack.wxCloud.callFunction = o => { if (fakeOffline.offline) { o.fail({ errMsg: 'offline' }); return } origCall(o) }
      fakeOffline.offline = true
      await store.startContraction({ notes: 'iv3-local-pending' })
      await store.stopContraction({ intensity: 'strong' })
      fakeOffline.offline = false
      assert.equal(store.contractionRecords.filter(x => x.synced === false).length, 1, '本地 pending 在')
      const r = await store.pullContractions()
      assert.ok(r.ok)
      const pend = store.contractionRecords.filter(x => x.synced === false)
      assert.equal(pend.length, 1, 'pull 后本地 pending 仍保留')
      assert.equal(pend[0].notes, 'iv3-local-pending')
      assert.equal(store.contractionRecords.filter(x => x.synced !== false).length, 5, '服务端 5 条同在')
      stack.wxCloud.callFunction = origCall
    }
    // ③ 同 ID：服务端 ongoing ≠ 本地 finished pending → 本地终态保留、服务端旧行剔除、单行
    {
      const stack = makeStack()
      installWechatGlobal(stack)
      const client = wire(loadClient(storeBundle), stack)
      await client.confirmIdentity()
      const store = client.useToolsStore()
      // 本地构造：云 start 已获 recordId + 离线 stop
      const fakeOffline = { offline: false }
      const origCall = stack.wxCloud.callFunction.bind(stack.wxCloud)
      stack.wxCloud.callFunction = o => { if (fakeOffline.offline) { o.fail({ errMsg: 'offline' }); return } origCall(o) }
      await store.startContraction({ notes: 'iv3-ongoing-case' })
      fakeOffline.offline = true
      await store.stopContraction({ intensity: 'mild', notes: '本地终态' })
      fakeOffline.offline = false
      const localRow = store.contractionRecords.find(x => x.synced === false)
      assert.ok(localRow && localRow.recordId, '本地行已持云 ID')
      // 服务端把该 ID 保持 ongoing（另一视图未重放 stop）——直改服务端文档形状
      const srvKey = `mc_contraction_records/${localRow.recordId}`
      const srv = stack.cloud.__docs.get(srvKey)
      stack.cloud.__docs.set(srvKey, { ...srv, status: 'ongoing', endTime: null, durationSec: null })
      const r = await store.pullContractions()
      assert.ok(r.ok)
      const rows = store.contractionRecords.filter(x => x.recordId === localRow.recordId)
      assert.equal(rows.length, 1, '同 ID 单行（不双行）')
      assert.equal(rows[0].synced, false, '本地终态保留（不被服务端 ongoing 顶替）')
      assert.equal(rows[0].notes, '本地终态')
      assert.ok(rows[0].endTime, '本地 endTime 保留')
      assert.equal(store.contraStopQueue.length, 1, 'stop 队列保留（重试凭据在）')
      stack.wxCloud.callFunction = origCall
    }
    // ④ 同 ID：服务端 finished 但终态凭据不同（他方抢先）→ 冲突标记、本地保留、队列在
    {
      const stack = makeStack()
      installWechatGlobal(stack)
      const client = wire(loadClient(storeBundle), stack)
      await client.confirmIdentity()
      const store = client.useToolsStore()
      const fakeOffline = { offline: false }
      const origCall = stack.wxCloud.callFunction.bind(stack.wxCloud)
      stack.wxCloud.callFunction = o => { if (fakeOffline.offline) { o.fail({ errMsg: 'offline' }); return } origCall(o) }
      await store.startContraction({ intensity: 'mild', notes: '本人输入' })
      fakeOffline.offline = true
      await store.stopContraction({ intensity: 'strong', notes: '本人终态' })
      fakeOffline.offline = false
      const localRow = store.contractionRecords.find(x => x.synced === false)
      assert.ok(localRow && localRow.recordId)
      // 他方抢先提交不同终态（endTime+强度不同）
      const srvKey = `mc_contraction_records/${localRow.recordId}`
      const srv = stack.cloud.__docs.get(srvKey)
      stack.cloud.__docs.set(srvKey, { ...srv, status: 'finished', endTime: srv.endTime + 12345, intensity: 'severe', notes: '他方终态', revision: 3 })
      const r = await store.pullContractions()
      assert.ok(r.ok)
      const rows = store.contractionRecords.filter(x => x.recordId === localRow.recordId)
      assert.equal(rows.length, 1, '同 ID 单行')
      assert.equal(rows[0].synced, false, '本地输入保留可见')
      assert.equal(rows[0].conflict, true, '冲突标记（页面可辨）')
      assert.equal(rows[0].intensity, 'strong', '本人终态不被他方顶替')
      assert.equal(store.contraStopQueue.length, 1, '队列凭据保留')
      stack.wxCloud.callFunction = origCall
    }
    // ⑤ 第一页在途切身份：stale-session 中止、不再翻页、不写给新身份
    {
      const stack = makeStack()
      const t0 = Date.parse('2026-09-14T06:00:00+08:00')
      for (let i = 0; i < 150; i++) seedContra(stack, `iv3s-${String(i).padStart(3, '0')}`, t0 + i * 20000)
      installWechatGlobal(stack)
      const client = wire(loadClient(storeBundle), stack)
      await client.confirmIdentity()
      const store = client.useToolsStore()
      network.hold = true
      const pullP = store.pullContractions()
      await tick()
      assert.equal(gates.length, 1, '第一页已扣住')
      network.hold = false
      // 同 bundle 切 papa
      stack.curMember.value = 'papa'
      stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
      assert.ok((await client.confirmIdentity()).ok)
      await tick()
      gates.forEach(g => g.release())
      const r = await pullP
      await tick()
      assert.equal(r.ok, false)
      assert.equal(r.code, 'stale-session', `在途切换中止（实得 ${r.code}）`)
      assert.equal(store.contractionRecords.length, 0, '不写给新身份（papa 视图零行）')
    }
  })

  console.log(`\nphase-iv-r3：${passed} 通过，${failed.length} 失败`)
  if (failed.length > 0) { console.log('失败场景：', failed.join(' | ')); process.exit(1) }
}

main().catch(e => { console.error('套件异常:', e); process.exit(2) })
