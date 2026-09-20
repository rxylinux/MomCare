// B3b 阶段二·commit/verify/abandon 专项回归（协调方指派切片 2026-09-20）。
// 对象：cloud/functions/mc-restore/index.js 的 restore.commit / restore.verify / restore.abandon。
// 链路：真 handler → mock 云（版本 CAS 事务）→ 真实 mc-health/mc-files/mc-reports 种子 → 真实阶段一导出器产包。
//
// 【语义钉（与冻结红先行套件 H1 基准一致——不矛盾处从设计 §5.1/§5.2.1，矛盾处以冻结验收基准为准）】
// - commit 预检=稳定性证明（声明索引计数闭包+contentGeneration 世代 CAS），**不**强制全部声明已上传：
//   H1（冻结基准）在部分上传态（2/4 记录、0/1 附件）commit 一路到 restored。附件字节复验属 attachFile
//   后续切片（mc_restore_files 无写入方）——本切片验证覆盖=已落库隔离记录。
// - 「缺记录拒绝」的边界=**声明未闭环**（declaring/indexing/preparing/V20）fail-closed 拒绝提交；
//   已闭环（declared+）部分上传可冻结为 restored（隔离区定版语义）。
// - commit verifying 阶段对已落库记录做字节级复验（内联重算 canonical SHA / 分片逐 chunk 对
//   frozenChunkSha256）——腐蚀 → 持久化失败码 + 终态 verify-corruption。
// - verify 真只读：零服务端写（全部集合 __v 严格不变、文档数不变、无事务副作用）。
// - abandon：owner-only；restored 不可弃（already-restored）；abandoning→分页清理→abandoned 同事务
//   释放 slotLock（活跃槽位可复用）。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-cva-'))

const HANDLER_REL = 'cloud/functions/mc-restore/index.js'
if (!fs.existsSync(path.join(root, HANDLER_REL))) {
  console.log('套件未运行：mc-restore handler 不存在（' + HANDLER_REL + '）')
  process.exit(3)
}

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')
const nonce = () => 'rst_' + crypto.randomBytes(16).toString('hex')

const DIST = path.join(temp, 'cf')
for (const fn of ['mc-health', 'mc-schedule', 'mc-reports', 'mc-files', 'mc-identity', 'mc-restore']) {
  const dir = path.join(DIST, fn); fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(path.join(root, `cloud/functions/${fn}/index.js`), path.join(dir, 'index.js'))
  fs.cpSync(path.join(root, 'cloud/shared'), path.join(dir, 'shared'), { recursive: true })
}
const healthH = require(path.join(DIST, 'mc-health/index.js'))
const scheduleH = require(path.join(DIST, 'mc-schedule/index.js'))
const reportsH = require(path.join(DIST, 'mc-reports/index.js'))
const filesH = require(path.join(DIST, 'mc-files/index.js'))
const identityH = require(path.join(DIST, 'mc-identity/index.js'))
const restoreH = require(path.join(DIST, 'mc-restore/index.js'))

// ── 冻结源哈希（加载时快照；结束时复核——期间被并发编辑则本次结果作废须复跑）──
const FROZEN_RELS = ['cloud/functions/mc-restore/index.js', 'cloud/shared/auth.js', 'cloud/shared/config.js', 'cloud/shared/respond.js', 'cloud/shared/constants.js']
const frozenHashes = Object.fromEntries(FROZEN_RELS.map(rel => [rel, sha256(fs.readFileSync(path.join(root, rel)))]))
console.log('冻结源哈希（加载时快照）:')
for (const [rel, h] of Object.entries(frozenHashes)) console.log(`  ${h.slice(0, 8)}  ${rel}`)

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-cva', MC_MEMBER_MAMA_OPENID: 'oTESTMAMA123456', MC_MEMBER_PAPA_OPENID: 'oTESTPAPA123456' }

// ── Mock 云（版本 CAS 事务——commit 核对 read 快照，不等则冲突；与主套件同型）──
function makeMockCloud() {
  const docs = new Map(), storedFiles = new Map()
  const state = { caller: TEST_ENV.MC_MEMBER_MAMA_OPENID, initialized: false, calls: [] }
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
  function runQuery(col, filters, ob, d, l) {
    let rows = [...docs.entries()].filter(([k]) => k.startsWith(col + '/')).map(([k, e]) => ({ ...clone(e), _id: k.slice(col.length + 1) }))
    for (const [k2, c2] of Object.entries(filters || {})) rows = rows.filter(x => c2 && (c2.__op === 'lt' || c2.__op === 'gt')
      ? (x[k2] !== undefined && (c2.__op === 'lt' ? String(x[k2]) < String(c2.v) : String(x[k2]) > String(c2.v)))
      : JSON.stringify(x[k2]) === JSON.stringify(c2))
    if (ob) { rows.sort((a, b) => String(b[ob]).localeCompare(String(a[ob]))); if (String(d).toLowerCase() === 'asc') rows.reverse() }
    return rows.slice(0, l || 100)
  }
  function mq(col, f, ob, d, l) { return { orderBy: (x, y) => mq(col, f, x, y, l), limit: n => mq(col, f, ob, d, n), get: async () => ({ data: runQuery(col, f, ob, d, l) }) } }
  const db = {
    command: { lt: v => ({ __op: 'lt', v }), gt: v => ({ __op: 'gt', v }), inc: v => ({ __op: 'inc', v }) },
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
    collection: c => ({ doc: id => docApi(c, id, null), where: f => mq(c, f), get: async () => ({ data: runQuery(c, {}) }) })
  }
  return {
    DYNAMIC_CURRENT_ENV: Symbol('env'), init() { state.initialized = true },
    getWXContext: () => ({ APPID: TEST_ENV.MC_APPID, OPENID: state.caller }),
    database() { if (!state.initialized) throw new Error('init first'); return db },
    downloadFile: async ({ fileID }) => { const k = String(fileID).replace(/^cloud:\/\/[^/]+\//, ''); const b = storedFiles.get(k); if (!b) throw new Error('dl'); return { fileContent: Buffer.from(b) } },
    uploadFile: async ({ cloudPath, fileContent }) => { storedFiles.set(cloudPath, Buffer.from(fileContent)); return { fileID: `cloud://e.b/${cloudPath}` } },
    deleteFile: async ({ fileList }) => ({ fileList: [] }),
    getTempFileURL: async ({ fileList }) => ({ fileList: fileList.map(f => ({ fileID: f, tempFileURL: 'https://t.i/' + f })) }),
    __docs: docs, __stored: storedFiles, __state: state, __setCtx(o) { state.caller = o },
  }
}

const storage = new Map()
global.uni = {
  getStorageSync(k) { return storage.has(k) ? storage.get(k) : '' }, setStorageSync(k, v) { storage.set(k, v) },
  removeStorageSync(k) { storage.delete(k) }, getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
  showToast() {}, showLoading() {}, hideLoading() {}, redirectTo() {}, navigateTo() {}, switchTab() {}, reLaunch() {}, navigateBack() {},
  request() {}, uploadFile() {}, downloadFile: o => o.fail && o.fail({ errMsg: 'dl' }),
  saveFile: o => o.success && o.success({}), removeSavedFile: o => o.success && o.success({}),
  chooseImage: o => o.success({ tempFilePaths: ['tmp://x'] }), showModal: o => o.success && o.success({ confirm: true }),
}

function requireHandler(name) {
  delete require.cache[require.resolve(path.join(DIST, name, 'index.js'))]
  return require(path.join(DIST, name, 'index.js'))
}
function makeStack(member = 'mama') {
  for (const k of [...storage.keys()]) if (k.startsWith('mc_') || k.startsWith('YUNTU_')) storage.delete(k)
  const cloud = makeMockCloud()
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID; process.env.MC_UPLOAD_ENABLED = 'true'
  cloud.__setCtx(member === 'mama' ? TEST_ENV.MC_MEMBER_MAMA_OPENID : TEST_ENV.MC_MEMBER_PAPA_OPENID)
  const hHealth = requireHandler('mc-health')
  const hSchedule = requireHandler('mc-schedule')
  const hReports = requireHandler('mc-reports')
  const hFiles = requireHandler('mc-files')
  const hIdentity = requireHandler('mc-identity')
  const hRestore = requireHandler('mc-restore')
  for (const h of [hHealth, hSchedule, hReports, hFiles, hIdentity, hRestore]) h.__setCloud(cloud)
  const curMember = { value: member }
  const routes = {
    'mc-health': e => hHealth.main(e), 'mc-schedule': e => hSchedule.main(e), 'mc-reports': e => hReports.main(e),
    'mc-files': e => hFiles.main(e), 'mc-restore': e => hRestore.main(e),
    'mc-identity': () => ({ ok: true, data: { memberId: curMember.value, familyId: TEST_ENV.MC_FAMILY_ID, displayName: 'M' } })
  }
  return {
    cloud, routes, curMember,
    call: (fn, event) => {
      cloud.__state.calls.push({ name: fn, action: event && event.action, caller: cloud.__state.caller })
      return routes[fn](event)
    },
  }
}

// ── 阶段一导出器 bundle（与主套件同型）──
const svcPath = path.join(temp, 'svc.cjs')
esbuild.buildSync({
  stdin: { contents: `export * from "@/services/mcpkgExportService.js";export * from "@/utils/mcpkg/canonical.js";export * from "@/utils/mcpkg/container.js";export * from "@/services/sessionService.js";export * from "@/services/cloudAdapter.js";export * from "@/utils/cloudConfig.js";`, resolveDir: root },
  bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: svcPath, logLevel: 'silent'
})
function lc() { delete require.cache[require.resolve(svcPath)]; return require(svcPath) }

// ── 真实 full 包（pregnancy 1 + 70000-char mood 1 分片 + reports 2 + 共享附件 1）──
async function produceFullPackage(stack) {
  const svc = lc()
  const wxCloud = { init() {}, callFunction: o => { const h = stack.routes[o.name]; Promise.resolve().then(() => h(o.data)).then(r => o.success({ result: r })).catch(e => o.fail({ errMsg: e.message })) }, uploadFile: o => o.success({ fileID: 'cloud://e.b/x', statusCode: 200 }) }
  global.wx = { cloud: wxCloud, getFileSystemManager: () => { throw new Error('no fsm') }, env: { USER_DATA_PATH: 'wxfile://usr' } }
  global.wx.cloud = wxCloud
  const fsmFiles = new Map()
  let dlSeq = 0
  global.uni.downloadFile = o => {
    const url = String(o.url || '')
    const fid = url.startsWith('https://t.i/') ? url.slice('https://t.i/'.length) : url
    const key = String(fid).replace(/^cloud:\/\/[^/]+\//, '')
    const bytes = stack.cloud.__stored.get(key)
    if (!bytes) { o.fail && o.fail({ errMsg: 'downloadFile:fail 404' }); return }
    const tmpPath = 'wxfile://tmp-dl-' + (++dlSeq)
    fsmFiles.set(tmpPath, new Uint8Array(bytes))
    o.success && o.success({ tempFilePath: tmpPath, statusCode: 200 })
  }
  global.wx.getFileSystemManager = () => ({
    writeFile(o) { const bytes = new Uint8Array(Buffer.from(o.data || '')); fsmFiles.set(o.filePath, bytes); o.success({}) },
    appendFile(o) { const a = new Uint8Array(Buffer.from(o.data || '')), p2 = fsmFiles.get(o.filePath) || new Uint8Array(0), n = new Uint8Array(p2.length + a.length); n.set(p2); n.set(a, p2.length); fsmFiles.set(o.filePath, n); o.success({}) },
    readFile(o) { const f = fsmFiles.get(o.filePath); if (!f) return o.fail({ errMsg: 'nf' }); const pos = o.position || 0, len = o.length == null ? f.length - pos : Math.min(o.length, f.length - pos); o.success({ data: f.slice(pos, pos + len).buffer }) },
    stat(o) { const f = fsmFiles.get(o.path); if (!f) return o.fail({ errMsg: 'nf' }); o.success({ stats: { size: f.length } }) },
    rename(o) { const f = fsmFiles.get(o.oldPath); if (f) { fsmFiles.set(o.newPath, f); fsmFiles.delete(o.oldPath) } o.success({}) },
    mkdir(o) { o.success({}) }, rmdir(o) { o.success({}) }, unlink(o) { fsmFiles.delete(o.filePath); o.success({}) }, access(o) { o.success({}) },
  })
  svc.__setCloudConfigForTests('env-cva', 'wxapp-cva'); svc.__setWxCloud(wxCloud); svc.__resetForTests()
  await svc.confirmIdentity()
  await stack.call('mc-health', { action: 'pregnancy.upsert', schemaVersion: 1, operationId: 'sp', expectedRevision: 0, payload: { lmpDate: '2026-06-01' } })
  const up = await stack.call('mc-health', { action: 'mood.upsert', schemaVersion: 1, operationId: 'sm', expectedRevision: 0, dateKey: '2026-09-20', payload: { mood: 'calm', symptoms: ['s'.repeat(70000)], note: 'probe' } })
  assert.ok(up.ok, 'mood seed: ' + JSON.stringify(up).slice(0, 120))
  {
    const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130])
    const prep = await stack.call('mc-files', { action: 'prepareUpload', uploadId: 'rptprobe1' })
    assert.ok(prep.ok, 'prepareUpload: ' + JSON.stringify(prep).slice(0, 100))
    stack.cloud.__stored.set(prep.data.cloudPath, pngBytes)
    const reg = await stack.call('mc-files', { action: 'registerStaged', uploadId: 'rptprobe1', stageFileID: `cloud://e.b/${prep.data.cloudPath}` })
    assert.ok(reg.ok, 'registerStaged: ' + JSON.stringify(reg).slice(0, 100))
    const rpt = await stack.call('mc-reports', { action: 'report.upsert', schemaVersion: 1, operationId: 'srpt1', expectedRevision: 0, id: 'rpt_probe_1', payload: { reportType: 'other', dateKey: '2026-09-20', attachments: [{ fileId: reg.data.file.fileId }], note: 'probe report' } })
    assert.ok(rpt.ok, 'report.upsert: ' + JSON.stringify(rpt).slice(0, 120))
    const rpt2 = await stack.call('mc-reports', { action: 'report.upsert', schemaVersion: 1, operationId: 'srpt2', expectedRevision: 0, id: 'rpt_probe_2', payload: { reportType: 'other', dateKey: '2026-09-20', attachments: [{ fileId: reg.data.file.fileId }], note: 'shared att report' } })
    assert.ok(rpt2.ok, 'report.upsert 2: ' + JSON.stringify(rpt2).slice(0, 120))
  }
  const s0 = svc.getSessionState()
  const r = await svc.buildAndPublishPackage({ includeShared: true, includePrivateOf: s0.member.memberId })
  assert.ok(r.ok, 'export: ' + r.code)
  assert.equal(r.complete, true)
  const pkg = Buffer.from(fsmFiles.get(r.flag.path))
  const mlen = Number(new DataView(pkg.buffer, pkg.byteOffset + 16, 8).getBigUint64(0))
  const manifest = JSON.parse(pkg.subarray(24, 24 + mlen).toString('utf8'))
  const manifestBytes = Buffer.from(svc.canonicalJsonBytes(manifest))
  const totals = { files: manifest.files.length, records: Object.values(manifest.records).reduce((a, l) => a + l.length, 0), domainCounts: Object.fromEntries(Object.entries(manifest.records).map(([d, l]) => [d, l.length])) }
  const domainRecords = {}
  let cur = 24 + mlen
  for (let i = 0; i < manifest.files.length; i++) {
    const elen = Number(new DataView(pkg.buffer, pkg.byteOffset + cur, 8).getBigUint64(0)); cur += 8
    const f = manifest.files[i]
    if (f.kind === 'domain-json') domainRecords[f.domain] = JSON.parse(pkg.subarray(cur, cur + elen).toString('utf8'))
    cur += elen
  }
  return { pkg, manifest, manifestBytes, manifestDigest: sha256(manifestBytes), totals, domainRecords, packageDigest: r.flag.packageDigest, svc }
}

// ── 走 begin→declareChunk→indexDeclarePage 到 declared ──
async function declareBatch(stack, P, batchId) {
  const b = await stack.call('mc-restore', { action: 'restore.begin', batchId, formatVersion: 1, packageDigest: P.packageDigest, manifestDigest: P.manifestDigest, claimedKind: 'full', totals: P.totals })
  if (!b.ok) return b
  const CHUNK = 40 * 1024, total = Math.ceil(P.manifestBytes.length / CHUNK)
  for (let i = 0; i < total; i++) {
    const raw = P.manifestBytes.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, P.manifestBytes.length))
    const r = await stack.call('mc-restore', { action: 'restore.declareChunk', batchId, chunkIndex: i, chunkTotal: total, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
    if (!r.ok) return { step: 'declareChunk', ...r }
  }
  for (let i = 0; i < 30; i++) {
    const r = await stack.call('mc-restore', { action: 'restore.indexDeclarePage', batchId })
    if (!r.ok) return { step: 'indexDeclarePage', ...r }
    if (r.data && (r.data.status === 'declared' || r.data.hasMore === false)) break
  }
  return { ok: true }
}

async function uploadAllRecords(stack, P, batchId) {
  for (const [domain, list] of Object.entries(P.manifest.records)) {
    for (const decl of list) {
      const rec = P.domainRecords[domain][decl.index]
      const canonical = Buffer.from(P.svc.canonicalJsonBytes(rec))
      if (canonical.length <= 48 * 1024) {
        const r = await stack.call('mc-restore', { action: 'restore.uploadRecord', batchId, domain, index: decl.index, id: decl.id, revision: decl.revision, record: rec, deleted: decl.deleted })
        if (!r.ok) return { step: 'uploadRecord', domain, index: decl.index, ...r }
      } else {
        const CHUNK = 40 * 1024, total = Math.ceil(canonical.length / CHUNK)
        for (let i = 0; i < total; i++) {
          const raw = canonical.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, canonical.length))
          const r = await stack.call('mc-restore', { action: 'restore.uploadRecordChunk', batchId, domain, index: decl.index, chunkIndex: i, chunkTotal: total, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
          if (!r.ok) return { step: 'chunk', domain, index: decl.index, ci: i, ...r }
        }
        const r = await stack.call('mc-restore', { action: 'restore.finalizeRecord', batchId, domain, index: decl.index, id: decl.id, revision: decl.revision, deleted: decl.deleted, expectedChunkTotal: total, expectedSha256: sha256(canonical) })
        if (!r.ok) return { step: 'finalize', domain, index: decl.index, ...r }
      }
    }
  }
  return { ok: true }
}

// ── 白盒辅助 ──
function readBatchDoc(stack, batchId) {
  const doc = stack.cloud.__docs.get(`mc_restore_batches/${batchId}`)
  if (!doc) return null
  return doc
}
// 全集合快照（__v 严格性——verify 零写的强断言凭据）
function snapshotAllDocs(stack) {
  return JSON.stringify([...stack.cloud.__docs.entries()].map(([k, v]) => [k, v.__v, JSON.stringify(v)]).sort((a, b) => (a[0] < b[0] ? -1 : 1)))
}
// 批次键空间残留计数（abandon 清净断言——跨全部恢复侧集合）
function batchResidueCount(stack, batchId) {
  let n = 0
  for (const k of stack.cloud.__docs.keys()) if (k.split('/')[1] && k.split('/')[1].startsWith(batchId + ':')) n++
  return n
}
// commit 驱动到终态（携 preflightId 续传；每调用断言 ok）
async function commitToEnd(stack, batchId, { maxCalls = 20 } = {}) {
  let preflightId = null
  for (let i = 0; i < maxCalls; i++) {
    const req = { action: 'restore.commit', batchId }
    if (preflightId) req.preflightId = preflightId
    const r = await stack.call('mc-restore', req)
    assert.ok(r.ok, `commit[${i}] 须 ok: ${JSON.stringify(r).slice(0, 200)}`)
    if (r.data && r.data.preflightId) preflightId = r.data.preflightId
    if (r.data && r.data.status === 'restored') return { r, preflightId }
  }
  throw new Error(`commit 未达 restored（${maxCalls} 次调用后 status=${(readBatchDoc(stack, batchId) || {}).status}）`)
}

async function main() {
  console.log('B3b 阶段二 commit/verify/abandon 专项回归\n')
  const C = {}
  const P = {}

  await scenario('A0 前置：真实阶段一导出 full 包（4 记录含 70000-char 分片 mood + 2 报告 + 共享附件）', async () => {
    C.stack = makeStack('mama')
    const pkg = await produceFullPackage(C.stack)
    P.pkg = pkg.pkg; P.manifest = pkg.manifest; P.manifestBytes = pkg.manifestBytes
    P.manifestDigest = pkg.manifestDigest; P.totals = pkg.totals; P.domainRecords = pkg.domainRecords
    P.packageDigest = pkg.packageDigest; P.svc = pkg.svc
    const recs = Object.fromEntries(Object.entries(P.manifest.records).map(([d, l]) => [d, l.length]))
    assert.equal(recs.pregnancy, 1, 'pregnancy 1')
    assert.equal(recs.mood, 1, 'mood 1（>48KiB 分片路径）')
    assert.equal(recs.reports, 2, 'reports 2')
    assert.ok(P.manifest.files.some(f => f.kind === 'attachment'), '含附件段')
    console.log(`      [A0] manifest=${P.manifestBytes.length}B records=${JSON.stringify(recs)}`)
  })

  await scenario('CV1 commit 全量上传：一调到底 restored + 冻结证明落盘 + restored 终态幂等', async () => {
    const st = makeStack('mama')
    const bid = nonce()
    const d = await declareBatch(st, P, bid)
    assert.ok(d.ok, `declare: ${JSON.stringify(d).slice(0, 150)}`)
    const up = await uploadAllRecords(st, P, bid)
    assert.ok(up.ok, `uploadAll: ${JSON.stringify(up).slice(0, 150)}`)
    const genBefore = readBatchDoc(st, bid).contentGeneration
    const { r, preflightId } = await commitToEnd(st, bid, { maxCalls: 5 })
    assert.equal(r.data.status, 'restored', `终态 restored（实得 ${r.data.status}）`)
    assert.ok(typeof preflightId === 'string' && /^pf_[0-9a-f]{32}$/.test(preflightId), `preflightId CSPRNG 形（实得 ${preflightId}）`)
    // 白盒冻结证明：proofComplete ∧ provenGeneration===contentGeneration ∧ restoredAt
    const bd = readBatchDoc(st, bid)
    assert.equal(bd.status, 'restored', '持久文档 restored')
    assert.equal(bd.proofComplete, true, 'proofComplete=true')
    assert.equal(bd.provenGeneration, bd.contentGeneration, `provenGeneration===contentGeneration（${bd.provenGeneration}===${bd.contentGeneration}）`)
    assert.ok(Number.isInteger(bd.restoredAt), 'restoredAt 落盘')
    assert.equal(bd.contentGeneration, genBefore, `commit 零内容写（gen 不变 ${genBefore}→${bd.contentGeneration}）`)
    // restored 终态幂等：同 preflightId / 异 preflightId / 无 preflightId 均 ok
    const r2 = await st.call('mc-restore', { action: 'restore.commit', batchId: bid, preflightId })
    assert.ok(r2.ok && r2.data.status === 'restored' && r2.data.replayed === true, `同 preflightId 幂等: ${JSON.stringify(r2).slice(0, 120)}`)
    const r3 = await st.call('mc-restore', { action: 'restore.commit', batchId: bid, preflightId: 'pf_' + '0'.repeat(32) })
    assert.ok(r3.ok && r3.data.status === 'restored', `restored 后异 preflightId 仍幂等（终态不依赖预检身份）: ${JSON.stringify(r3).slice(0, 120)}`)
    const r4 = await st.call('mc-restore', { action: 'restore.commit', batchId: bid })
    assert.ok(r4.ok && r4.data.status === 'restored', 'restored 后无 preflightId 幂等')
    C.stackCV1 = st; C.bidCV1 = bid // CV6 复用（健康 restored 批）
  })

  await scenario('CV2 commit 缺记录拒绝（声明未闭环 fail-closed）+ 已闭环零/部分上传冻结语义钉', async () => {
    // (a) declaring 态（manifest 尚未重组判包——记录连声明都未闭环）→ 拒
    {
      const st = makeStack('mama')
      const bid = nonce()
      const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: P.packageDigest, manifestDigest: P.manifestDigest, claimedKind: 'full', totals: P.totals })
      assert.ok(b.ok, 'begin')
      const r = await st.call('mc-restore', { action: 'restore.commit', batchId: bid })
      assert.ok(!r.ok && r.code === 'invalid-state', `declaring 态 commit 须拒（实得 ${r.code}: ${String(r.message).slice(0, 80)}）`)
    }
    // (b) indexing 态（分页索引未走完）→ 拒
    {
      const st = makeStack('mama')
      const bid = nonce()
      const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: P.packageDigest, manifestDigest: P.manifestDigest, claimedKind: 'full', totals: P.totals })
      assert.ok(b.ok, 'begin')
      const CHUNK = 40 * 1024, ct = Math.ceil(P.manifestBytes.length / CHUNK)
      for (let i = 0; i < ct; i++) {
        const raw = P.manifestBytes.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, P.manifestBytes.length))
        const r = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: ct, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
        assert.ok(r.ok, `dc ${i}`)
      }
      // 不调 indexDeclarePage——批次停在 indexing
      const bd = readBatchDoc(st, bid)
      assert.equal(bd.status, 'indexing', `前置：indexing（实得 ${bd.status}）`)
      const r = await st.call('mc-restore', { action: 'restore.commit', batchId: bid })
      assert.ok(!r.ok && r.code === 'invalid-state', `indexing 态 commit 须拒（实得 ${r.code}）`)
    }
    // (c) 已闭环零上传（declared）→ commit 冻结为 restored（0 记录验证页即尽——§5.2 零声明同款级联）
    {
      const st = makeStack('mama')
      const bid = nonce()
      const d = await declareBatch(st, P, bid)
      assert.ok(d.ok, 'declare')
      const { r } = await commitToEnd(st, bid, { maxCalls: 5 })
      assert.equal(r.data.status, 'restored', `declared 零上传 commit → restored（实得 ${r.data.status}）`)
      const bd = readBatchDoc(st, bid)
      assert.equal(bd.status, 'restored', '持久 restored')
    }
    // (d) 已闭环部分上传（仅 pregnancy——H1 基准语义钉：隔离区定版已上传内容）→ restored
    {
      const st = makeStack('mama')
      const bid = nonce()
      const d = await declareBatch(st, P, bid)
      assert.ok(d.ok, 'declare')
      const decl = P.manifest.records.pregnancy[0]
      const rec = P.domainRecords.pregnancy[decl.index]
      const up = await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'pregnancy', index: decl.index, id: decl.id, revision: decl.revision, record: rec, deleted: decl.deleted })
      assert.ok(up.ok, `部分上传 pregnancy: ${JSON.stringify(up).slice(0, 120)}`)
      const { r } = await commitToEnd(st, bid, { maxCalls: 5 })
      assert.equal(r.data.status, 'restored', `部分上传 commit → restored（隔离区定版——H1 基准）`)
    }
  })

  await scenario('CV3 preflightId 校验：首调携 ID 拒 / 活跃异 ID 拒 / 未携 ID 拒（活跃租约内）', async () => {
    // 用 120 声明合成批（>PREFLIGHT_PAGE_SIZE=40——多页预检保活跃窗口）
    const { st, bid } = await freshSyntheticDeclaredBatch(P, 60, 60)
    // 首调携 preflightId → 拒（无活跃预检）
    {
      const r = await st.call('mc-restore', { action: 'restore.commit', batchId: bid, preflightId: 'pf_' + '1'.repeat(32) })
      assert.ok(!r.ok && r.code === 'preflight-conflict', `首调携 ID 须拒（实得 ${r.code}）`)
    }
    const r1 = await st.call('mc-restore', { action: 'restore.commit', batchId: bid })
    assert.ok(r1.ok && r1.data.preflightId && r1.data.hasMore === true, `预检页 1: ${JSON.stringify(r1).slice(0, 150)}`)
    const pfId = r1.data.preflightId
    // 活跃租约内：异 ID → preflight-conflict；未携 ID → preflight-conflict
    {
      const r = await st.call('mc-restore', { action: 'restore.commit', batchId: bid, preflightId: 'pf_' + '2'.repeat(32) })
      assert.ok(!r.ok && r.code === 'preflight-conflict', `活跃异 ID 须拒（实得 ${r.code}）`)
    }
    {
      const r = await st.call('mc-restore', { action: 'restore.commit', batchId: bid })
      assert.ok(!r.ok && r.code === 'preflight-conflict', `活跃未携 ID 须拒（实得 ${r.code}）`)
    }
    // 预检期未过——同 ID 续传不受影响（对照）
    const r2 = await st.call('mc-restore', { action: 'restore.commit', batchId: bid, preflightId: pfId })
    assert.ok(r2.ok, `同 ID 续传 ok（对照）: ${JSON.stringify(r2).slice(0, 120)}`)
  })

  await scenario('CV4 分页验证推进：120 声明 3 页预检（40/页）+ pageCursor 错配拒 + content-changed 清预检 + 重开收敛 restored', async () => {
    const { st, bid } = await freshSyntheticDeclaredBatch(P, 60, 60)
    // 页 1：hasMore + 持久游标/计数白盒
    const r1 = await st.call('mc-restore', { action: 'restore.commit', batchId: bid })
    assert.ok(r1.ok, `页 1: ${JSON.stringify(r1).slice(0, 150)}`)
    assert.equal(r1.data.phase, 'preflight', `phase=preflight（实得 ${r1.data.phase}）`)
    assert.equal(r1.data.checkedCount, 40, `页 1 计数 40（实得 ${r1.data.checkedCount}）`)
    assert.equal(r1.data.declaredTotal, 120, `声明总数 120（实得 ${r1.data.declaredTotal}）`)
    const bd1 = readBatchDoc(st, bid)
    // _id 升序=码元序（与 progress L20c 同序）：bag:0,bag:1,bag:10..19,bag:2,bag:20..29,… 第 40 条恰 bag:44
    assert.ok(bd1.preflight && typeof bd1.preflight.cursor === 'string' && bd1.preflight.cursor === `${bid}:decl:bag:44`, `持久游标=第 40 条声明 _id（实得 ${bd1.preflight && bd1.preflight.cursor}——码元升序第 40=bag:44）`)
    assert.equal(bd1.preflight.checkedCount, 40, '白盒 checkedCount=40')
    assert.equal(bd1.status, 'uploading', 'declared 起步由 commit 翻 uploading')
    const pfId = r1.data.preflightId
    // pageCursor 错配 → cursor-stale（正确持久游标 = bd1.preflight.cursor）
    {
      const r = await st.call('mc-restore', { action: 'restore.commit', batchId: bid, preflightId: pfId, pageCursor: `${bid}:decl:zzz:9` })
      assert.ok(!r.ok && r.code === 'cursor-stale', `pageCursor 错配须拒（实得 ${r.code}）`)
    }
    // 页 2 前插入内容写（上传 daily d-0000——gen+1）→ 下一页 content-changed + 预检清除
    {
      // d-0000 声明形（mkRecs i=0：revision 0、deleted 0%7===0=true——与 freshSyntheticDeclaredBatch 同源）
      const dailyRec = { id: 'd-0000', dateKey: 'd-0000', fields: {}, revision: 0, deleted: true }
      const up = await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'daily', index: 0, id: dailyRec.id, revision: dailyRec.revision, record: dailyRec, deleted: dailyRec.deleted })
      assert.ok(up.ok, `预检期上传（gen 漂移源）: ${JSON.stringify(up).slice(0, 120)}`)
      const r = await st.call('mc-restore', { action: 'restore.commit', batchId: bid, preflightId: pfId })
      assert.ok(!r.ok && r.code === 'content-changed', `内容变化须拒（实得 ${r.code}: ${String(r.message).slice(0, 100)}）`)
      const bd = readBatchDoc(st, bid)
      assert.ok(!bd.preflight, `预检已清除（白盒 preflight 字段缺席——实得 ${JSON.stringify(bd.preflight)}）`)
      assert.equal(bd.status, 'uploading', '批次仍在 uploading（可重开预检）')
    }
    // 重开（无 ID）→ 新 preflightId → 3 页走完 → 验证 1 条已上传记录 → restored
    const { r, preflightId } = await commitToEnd(st, bid, { maxCalls: 10 })
    assert.equal(r.data.status, 'restored', `重开收敛 restored（实得 ${r.data.status}）`)
    assert.ok(preflightId !== pfId, `新预检 ID（${pfId.slice(0, 8)}… → ${preflightId.slice(0, 8)}…）`)
    const bd = readBatchDoc(st, bid)
    assert.equal(bd.proofComplete, true, '重开后 proofComplete=true')
    assert.equal(bd.provenGeneration, bd.contentGeneration, '重开后 proven===gen')
  })

  await scenario('CV5 commit verifying 腐蚀：内联记录篡改/分片 chunk 篡改 → verify-corruption 终态（持久化失败码）', async () => {
    // (a) 内联记录内容篡改（重算 canonical SHA ≠ 落库 canonicalHash）
    {
      const st = makeStack('mama')
      const bid = nonce()
      const d = await declareBatch(st, P, bid)
      assert.ok(d.ok, 'declare')
      const up = await uploadAllRecords(st, P, bid)
      assert.ok(up.ok, 'uploadAll')
      const key = `mc_restore_records/${bid}:pregnancy:0`
      const doc = st.cloud.__docs.get(key)
      assert.ok(doc && doc.record, '白盒定位内联记录文档')
      doc.record.fields = { ...(doc.record.fields || {}), lmpDate: '1999-01-01' } // 篡改正文（不动 canonicalHash）
      let sawVerifyCorruption = null
      let preflightId = null
      for (let i = 0; i < 10; i++) {
        const req = { action: 'restore.commit', batchId: bid }
        if (preflightId) req.preflightId = preflightId
        const r = await st.call('mc-restore', req)
        if (!r.ok) { sawVerifyCorruption = r; break }
        if (r.data && r.data.preflightId) preflightId = r.data.preflightId
        if (r.data && r.data.status === 'restored') break
      }
      assert.ok(sawVerifyCorruption && sawVerifyCorruption.code === 'verify-corruption', `内联篡改须 verify-corruption（实得 ${sawVerifyCorruption && sawVerifyCorruption.code}）`)
      const bd = readBatchDoc(st, bid)
      assert.equal(bd.status, 'verify-corruption', `持久终态 verify-corruption（实得 ${bd.status}）`)
      assert.ok(bd.verifyFailure && typeof bd.verifyFailure.code === 'string' && Number.isInteger(bd.verifyFailure.at), `持久化失败码落盘（实得 ${JSON.stringify(bd.verifyFailure)}）`)
      assert.match(String(sawVerifyCorruption.message), /hash/i, `拒因指向 hash（实得 ${sawVerifyCorruption.message}）`)
      // 终态后 commit → invalid-state（不可重试推进）
      const r2 = await st.call('mc-restore', { action: 'restore.commit', batchId: bid, preflightId })
      assert.ok(!r2.ok && r2.code === 'invalid-state', `verify-corruption 后 commit 须拒（实得 ${r2.code}）`)
    }
    // (b) 分片 chunk 字节篡改（实际字节 SHA ≠ finalize 冻结 frozenChunkSha256）
    {
      const st = makeStack('mama')
      const bid = nonce()
      const d = await declareBatch(st, P, bid)
      assert.ok(d.ok, 'declare')
      const up = await uploadAllRecords(st, P, bid)
      assert.ok(up.ok, 'uploadAll')
      const recDoc = st.cloud.__docs.get(`mc_restore_records/${bid}:mood:0`)
      assert.ok(recDoc && recDoc.isChunked === true && recDoc.chunkTotal >= 2, '白盒定位分片记录（≥2 片）')
      const chunkDoc = st.cloud.__docs.get(`mc_restore_record_chunks/${recDoc.chunkIdPrefix}:0`)
      assert.ok(chunkDoc, '白盒定位 chunk 0 文档')
      const raw = Buffer.from(chunkDoc.rawB64, 'base64')
      raw[0] ^= 0xff // 篡改首字节——实际字节 SHA 漂移
      chunkDoc.rawB64 = raw.toString('base64')
      let sawVerifyCorruption = null
      let preflightId = null
      for (let i = 0; i < 10; i++) {
        const req = { action: 'restore.commit', batchId: bid }
        if (preflightId) req.preflightId = preflightId
        const r = await st.call('mc-restore', req)
        if (!r.ok) { sawVerifyCorruption = r; break }
        if (r.data && r.data.preflightId) preflightId = r.data.preflightId
        if (r.data && r.data.status === 'restored') break
      }
      assert.ok(sawVerifyCorruption && sawVerifyCorruption.code === 'verify-corruption', `chunk 篡改须 verify-corruption（实得 ${sawVerifyCorruption && sawVerifyCorruption.code}）`)
      assert.match(String(sawVerifyCorruption.message), /chunk/i, `拒因指向 chunk（实得 ${sawVerifyCorruption.message}）`)
      assert.equal(readBatchDoc(st, bid).status, 'verify-corruption', '持久终态')
    }
    // (c) chunk 文档整删（缺失）→ verify-corruption（chunk-missing）
    {
      const st = makeStack('mama')
      const bid = nonce()
      const d = await declareBatch(st, P, bid)
      assert.ok(d.ok, 'declare')
      const up = await uploadAllRecords(st, P, bid)
      assert.ok(up.ok, 'uploadAll')
      const recDoc = st.cloud.__docs.get(`mc_restore_records/${bid}:mood:0`)
      st.cloud.__docs.delete(`mc_restore_record_chunks/${recDoc.chunkIdPrefix}:1`)
      let sawVerifyCorruption = null
      let preflightId = null
      for (let i = 0; i < 10; i++) {
        const req = { action: 'restore.commit', batchId: bid }
        if (preflightId) req.preflightId = preflightId
        const r = await st.call('mc-restore', req)
        if (!r.ok) { sawVerifyCorruption = r; break }
        if (r.data && r.data.preflightId) preflightId = r.data.preflightId
        if (r.data && r.data.status === 'restored') break
      }
      assert.ok(sawVerifyCorruption && sawVerifyCorruption.code === 'verify-corruption', `chunk 缺失须 verify-corruption（实得 ${sawVerifyCorruption && sawVerifyCorruption.code}）`)
      assert.match(String(sawVerifyCorruption.message), /缺失|missing/, `拒因指向缺失（实得 ${sawVerifyCorruption.message}）`)
    }
  })

  await scenario('CV6 verify 真只读（健康 restored 批）：零服务端写（全集合 __v+文档数+内容严格不变）+ 复验真实记录', async () => {
    const st = C.stackCV1, bid = C.bidCV1
    assert.ok(st && bid, 'CV1 前置可用')
    const before = snapshotAllDocs(st)
    const r = await st.call('mc-restore', { action: 'restore.verify', batchId: bid })
    assert.ok(r.ok, `verify: ${JSON.stringify(r).slice(0, 200)}`)
    assert.equal(r.data.status, 'restored', `响应含批次状态（实得 ${r.data.status}）`)
    assert.equal(r.data.checked, 4, `复验 4 条记录（实得 ${r.data.checked}）`)
    assert.deepEqual(r.data.errors, [], `零错误（实得 ${JSON.stringify(r.data.errors)}）`)
    assert.equal(r.data.hasMore, false, '单页即尽（4 ≤50 项 ∧ 字节 ≤256KiB）')
    const after = snapshotAllDocs(st)
    assert.equal(after, before, 'verify 零写：全部集合文档 __v/内容/数量严格不变')
    // 非 owner → not-batch-owner（papa）
    st.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID); st.curMember.value = 'papa'
    const r2 = await st.call('mc-restore', { action: 'restore.verify', batchId: bid })
    assert.ok(!r2.ok && r2.code === 'not-batch-owner', `papa verify 须拒（实得 ${r2.code}）`)
    st.cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID); st.curMember.value = 'mama'
    // 非法游标 → invalid-params（零写）
    const before2 = snapshotAllDocs(st)
    const r3 = await st.call('mc-restore', { action: 'restore.verify', batchId: bid, pageCursor: { kind: 'bogus' } })
    assert.ok(!r3.ok && r3.code === 'invalid-params', `非法游标须拒（实得 ${r3.code}）`)
    assert.equal(snapshotAllDocs(st), before2, '非法游标拒绝亦零写')
  })

  await scenario('CV7 verify 腐蚀报告：errors[] 呈现 + 状态不变 + 仍零写（对照 commit 的持久化语义）', async () => {
    const st = makeStack('mama')
    const bid = nonce()
    const d = await declareBatch(st, P, bid)
    assert.ok(d.ok, 'declare')
    const up = await uploadAllRecords(st, P, bid)
    assert.ok(up.ok, 'uploadAll')
    const { r } = await commitToEnd(st, bid, { maxCalls: 5 })
    assert.equal(r.data.status, 'restored', '前置 restored')
    // 篡改内联记录 + 删一片 chunk——verify 须在 errors[] 报告且不改批次状态
    const key = `mc_restore_records/${bid}:pregnancy:0`
    st.cloud.__docs.get(key).record.fields = { ...(st.cloud.__docs.get(key).record.fields || {}), lmpDate: '1999-01-01' }
    const recDoc = st.cloud.__docs.get(`mc_restore_records/${bid}:mood:0`)
    st.cloud.__docs.delete(`mc_restore_record_chunks/${recDoc.chunkIdPrefix}:1`)
    const before = snapshotAllDocs(st)
    const v = await st.call('mc-restore', { action: 'restore.verify', batchId: bid })
    assert.ok(v.ok, `verify 本身 ok（报告非失败）: ${JSON.stringify(v).slice(0, 150)}`)
    assert.ok(Array.isArray(v.data.errors) && v.data.errors.length === 2, `两条腐蚀报告（实得 ${JSON.stringify(v.data.errors)}）`)
    const codes = v.data.errors.map(e => e.error).sort()
    assert.deepEqual(codes, ['chunk-missing', 'hash-mismatch'], `错误码集合（实得 ${JSON.stringify(codes)}）`)
    assert.equal(v.data.status, 'restored', `状态不变（实得 ${v.data.status}——standalone 零持久化语义）`)
    assert.equal(snapshotAllDocs(st), before, '腐蚀报告路径仍零写')
  })

  await scenario('CV8 abandon：owner-only + already-restored + begin-only 批一调清净 + slotLock 白盒释放', async () => {
    // (a) 非 owner → not-batch-owner
    {
      const st = makeStack('mama')
      const bid = nonce()
      const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: P.packageDigest, manifestDigest: P.manifestDigest, claimedKind: 'full', totals: P.totals })
      assert.ok(b.ok, 'begin')
      st.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID); st.curMember.value = 'papa'
      const r = await st.call('mc-restore', { action: 'restore.abandon', batchId: bid })
      assert.ok(!r.ok && r.code === 'not-batch-owner', `papa abandon 须拒（实得 ${r.code}）`)
      st.cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID); st.curMember.value = 'mama'
    }
    // (b) restored 批 → already-restored（chunk/隔离记录永久保留）
    {
      const st = makeStack('mama')
      const bid = nonce()
      const d = await declareBatch(st, P, bid)
      assert.ok(d.ok, 'declare')
      const { r } = await commitToEnd(st, bid, { maxCalls: 5 })
      assert.equal(r.data.status, 'restored', '前置 restored')
      const ab = await st.call('mc-restore', { action: 'restore.abandon', batchId: bid })
      assert.ok(!ab.ok && ab.code === 'already-restored', `restored abandon 须拒（实得 ${ab.code}）`)
    }
    // (c) begin-only 批：一调 abandoning→清净→abandoned + slotLock 摘除
    {
      const st = makeStack('mama')
      const bid = nonce()
      const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: P.packageDigest, manifestDigest: P.manifestDigest, claimedKind: 'full', totals: P.totals })
      assert.ok(b.ok, 'begin')
      const lockBefore = st.cloud.__docs.get(`mc_restore_slot_locks/slotlock:mama`)
      assert.ok(lockBefore && lockBefore.activeBatchIds.includes(bid), '前置：slotLock 含本批次')
      const ab = await st.call('mc-restore', { action: 'restore.abandon', batchId: bid })
      assert.ok(ab.ok && ab.data.status === 'abandoned', `一调 abandoned（实得 ${JSON.stringify(ab).slice(0, 150)}）`)
      const bd = readBatchDoc(st, bid)
      assert.equal(bd.status, 'abandoned', '持久终态 abandoned')
      assert.ok(Number.isInteger(bd.abandonedAt), 'abandonedAt 落盘')
      const lockAfter = st.cloud.__docs.get(`mc_restore_slot_locks/slotlock:mama`)
      assert.ok(lockAfter && !lockAfter.activeBatchIds.includes(bid), `slotLock 已摘除本批次（实得 ${JSON.stringify(lockAfter && lockAfter.activeBatchIds)}）`)
      // 幂等重放
      const ab2 = await st.call('mc-restore', { action: 'restore.abandon', batchId: bid })
      assert.ok(ab2.ok && ab2.data.status === 'abandoned' && ab2.data.replayed === true, `abandoned 幂等（实得 ${JSON.stringify(ab2).slice(0, 120)}）`)
    }
  })

  await scenario('CV9 abandon 全内容批：分页清净（7 集合零残留）+ 幂等 + 槽位释放后 begin 可复用', async () => {
    const st = makeStack('mama')
    // 活跃槽位压力：2 活跃（上限）→ 第 3 begin 拒
    const bid1 = nonce(), bid2 = nonce()
    for (const bid of [bid1, bid2]) {
      const d = await declareBatch(st, P, bid)
      assert.ok(d.ok, `declare ${bid.slice(0, 12)}…`)
    }
    const up1 = await uploadAllRecords(st, P, bid1)
    assert.ok(up1.ok, 'uploadAll bid1（含 manifest chunks/声明/anchors/records/chunks 全谱残留）')
    {
      const bid3 = nonce()
      const r = await st.call('mc-restore', { action: 'restore.begin', batchId: bid3, formatVersion: 1, packageDigest: P.packageDigest, manifestDigest: P.manifestDigest, claimedKind: 'full', totals: P.totals })
      assert.ok(!r.ok && r.code === 'too-many-active-batches', `2 活跃上限拒（实得 ${r.code}）`)
    }
    // abandon bid1（循环 hasMore——全谱清理）
    let guard = 0, last = null
    for (;;) {
      const r = await st.call('mc-restore', { action: 'restore.abandon', batchId: bid1 })
      assert.ok(r.ok, `abandon 页 ${guard}: ${JSON.stringify(r).slice(0, 150)}`)
      last = r
      if (r.data.status === 'abandoned') break
      guard++
      assert.ok(guard < 20, 'abandon 收敛保护')
    }
    assert.equal(last.data.status, 'abandoned', '终态 abandoned')
    assert.equal(batchResidueCount(st, bid1), 0, `bid1 键空间零残留（实得 ${batchResidueCount(st, bid1)}——7 集合全谱）`)
    const bd = readBatchDoc(st, bid1)
    assert.equal(bd.status, 'abandoned', '批次文档终态（本身保留——状态权威）')
    assert.ok(!st.cloud.__docs.get(`mc_restore_slot_locks/slotlock:mama`).activeBatchIds.includes(bid1), 'slotLock 已释放 bid1')
    // 幂等
    const ab2 = await st.call('mc-restore', { action: 'restore.abandon', batchId: bid1 })
    assert.ok(ab2.ok && ab2.data.replayed === true, `abandoned 幂等重放（实得 ${JSON.stringify(ab2).slice(0, 120)}）`)
    // 槽位复用：释放后新 begin ok
    {
      const bid4 = nonce()
      const r = await st.call('mc-restore', { action: 'restore.begin', batchId: bid4, formatVersion: 1, packageDigest: P.packageDigest, manifestDigest: P.manifestDigest, claimedKind: 'full', totals: P.totals })
      assert.ok(r.ok, `释放后 begin 复用槽位（实得 ${JSON.stringify(r).slice(0, 120)}）`)
      const lock = st.cloud.__docs.get(`mc_restore_slot_locks/slotlock:mama`)
      assert.ok(lock.activeBatchIds.includes(bid4) && lock.activeBatchIds.includes(bid2) && !lock.activeBatchIds.includes(bid1), `slotLock 恰 {bid2,bid4}（实得 ${JSON.stringify(lock.activeBatchIds.map(x => x.slice(0, 10) + '…'))}）`)
    }
  })

  // ── 合成多声明批（120 条：daily N + bag M——服务端 schema/形状接受，分页压力来自声明数）──
  async function freshSyntheticDeclaredBatch(pkg, nDaily, nBag) {
    const mkRecs = (p, n, withDailyShape) => Array.from({ length: n }, (_, i) => withDailyShape
      ? { id: p + String(i).padStart(4, '0'), dateKey: p + String(i).padStart(4, '0'), fields: {}, revision: i, deleted: i % 7 === 0 }
      : { id: p + String(i).padStart(4, '0'), revision: i, deleted: i % 7 === 0 })
    const daily = mkRecs('d-', nDaily, true), bag = mkRecs('b-', nBag, false)
    const decls = rs => rs.map((r, i) => ({ index: i, id: r.id, revision: r.revision, deleted: r.deleted, hash: sha256(Buffer.from(pkg.svc.canonicalJsonBytes(r))) }))
    const segD = Buffer.from(pkg.svc.canonicalJsonBytes(daily)), segB = Buffer.from(pkg.svc.canonicalJsonBytes(bag))
    const manifest = {
      formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: TEST_ENV.MC_FAMILY_ID,
      packageKind: 'full', complete: true,
      scope: { includeShared: true, includePrivateOf: null }, scopeLabel: 'shared-only',
      domains: {
        pregnancy: { status: 'omitted' }, daily: { status: 'present', recordCount: nDaily, pagingComplete: true, visibility: 'shared', fileIndex: 0 },
        mood: { status: 'omitted' }, checkup: { status: 'omitted' }, bag: { status: 'present', recordCount: nBag, pagingComplete: true, visibility: 'shared', fileIndex: 1 },
        reports: { status: 'omitted' },
      },
      files: [
        { path: 'records/daily.json', kind: 'domain-json', length: segD.length, sha256: sha256(segD), contentType: 'application/json', domain: 'daily' },
        { path: 'records/bag.json', kind: 'domain-json', length: segB.length, sha256: sha256(segB), contentType: 'application/json', domain: 'bag' },
      ],
      records: { daily: decls(daily), bag: decls(bag) }, reports: [],
      pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
    }
    const manifestBytes = Buffer.from(pkg.svc.canonicalJsonBytes(manifest))
    const st = makeStack('mama')
    const bid = nonce()
    const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: sha256(manifestBytes), manifestDigest: sha256(manifestBytes), claimedKind: 'full', totals: { files: 2, records: nDaily + nBag, domainCounts: { daily: nDaily, bag: nBag } } })
    assert.ok(b.ok, `begin: ${JSON.stringify(b).slice(0, 120)}`)
    const CHM = 40 * 1024, ctm = Math.ceil(manifestBytes.length / CHM)
    for (let i = 0; i < ctm; i++) {
      const raw = manifestBytes.subarray(i * CHM, Math.min((i + 1) * CHM, manifestBytes.length))
      const r = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: ctm, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      assert.ok(r.ok, `dc ${i}/${ctm}`)
    }
    let pageCursor = 0
    for (let i = 0; i < 40; i++) {
      const r = await st.call('mc-restore', { action: 'restore.indexDeclarePage', batchId: bid, pageCursor })
      assert.ok(r.ok, `index ${i}@${pageCursor}: ${JSON.stringify(r).slice(0, 100)}`)
      if (r.data && r.data.status === 'declared') break
      pageCursor = r.data.nextCursor
    }
    assert.equal(readBatchDoc(st, bid).status, 'declared', `${nDaily + nBag} 声明合成批 declared`)
    return { st, bid }
  }

  // ── 冻结源哈希复核（与主套件同款护栏）──
  await scenario('Z9 冻结源哈希：套件运行期间 mc-restore 源未被并发编辑（否则结果作废须复跑）', async () => {
    for (const [rel, h] of Object.entries(frozenHashes)) {
      const now = sha256(fs.readFileSync(path.join(root, rel)))
      assert.equal(now, h, `${rel} 运行期间被并发编辑（${h.slice(0, 8)}→${now.slice(0, 8)}）——结果作废须复跑`)
    }
  })

  console.log(`\n${passed} 通过, ${failed.length} 失败`)
  if (failed.length) { console.log('失败项：'); for (const f2 of failed) console.log(` - ${f2}`); process.exit(1) }
  process.exit(0)
}

main().catch(e => { console.error('套件异常:', e); process.exit(2) })
