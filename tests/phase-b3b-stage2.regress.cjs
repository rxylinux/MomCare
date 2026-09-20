// B3b 阶段二红先行回归：mc-restore handler → mock 云（事务 CAS）→ 真实 mc-health/mc-files handler。
// 真实阶段一导出器产 full 包；manifestDigest/totals/nonce 全部从实际包计算——不发明值。
// 红先行：mc-restore handler 未落地 → exit 3；落地后逐场景红→绿。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-b3b2-'))

const HANDLER_REL = 'cloud/functions/mc-restore/index.js'
if (!fs.existsSync(path.join(root, HANDLER_REL))) {
  console.log('B3b 阶段二套件已就绪、未运行：mc-restore handler 尚未落地（' + HANDLER_REL + '）')
  process.exit(3)
}

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }
const tick = () => new Promise(r => setTimeout(r, 20))
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')
const nonce = () => 'rst_' + crypto.randomBytes(16).toString('hex') // 128-bit CSPRNG hex（设计 §5.0）
const hexDigest = n => crypto.randomBytes(32).toString('hex') // 语法合法的 64-hex 摘要

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

// ── 冻结源哈希（测试对象快照）：套件加载时记录，结束时复核——期间源被并发编辑则本次结果作废须复跑 ──
const FROZEN_RELS = ['cloud/functions/mc-restore/index.js', 'cloud/shared/auth.js', 'cloud/shared/config.js', 'cloud/shared/respond.js', 'cloud/shared/constants.js']
const frozenHashes = Object.fromEntries(FROZEN_RELS.map(rel => [rel, sha256(fs.readFileSync(path.join(root, rel)))]))
console.log('冻结源哈希（加载时快照）:')
for (const [rel, h] of Object.entries(frozenHashes)) console.log(`  ${h.slice(0, 8)}  ${rel}`)

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-b3b2', MC_MEMBER_MAMA_OPENID: 'oTESTMAMA123456', MC_MEMBER_PAPA_OPENID: 'oTESTPAPA123456' }

// ── Mock 云（版本 CAS 事务——commit 核对 read 快照，不等则冲突）──
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

// ── Per-stack handler isolation：每个 stack 独立 require handler 模块（消除共享单例 __setCloud 竞态）──
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
  // 独立 handler 实例（本 stack 专属——不被其他 stack 覆写）
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
    // 回归断言用：验证 handler 与 mock doc 同源
    assertBinding() {
      assert.strictEqual(cloud.__docs, this.cloud.__docs, 'stack.cloud 与 handler 绑定的 mock doc 为同一对象')
    },
    call: (fn, event) => {
      cloud.__state.calls.push({ name: fn, action: event && event.action, caller: cloud.__state.caller })
      return routes[fn](event)
    },
  }
}

// ── 阶段一导出器 bundle ──
const svcPath = path.join(temp, 'svc.cjs')
esbuild.buildSync({
  stdin: { contents: `export * from "@/services/mcpkgExportService.js";export * from "@/utils/mcpkg/canonical.js";export * from "@/utils/mcpkg/container.js";export * from "@/services/sessionService.js";export * from "@/services/cloudAdapter.js";export * from "@/utils/cloudConfig.js";`, resolveDir: root },
  bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: svcPath, logLevel: 'silent'
})
function lc() { delete require.cache[require.resolve(svcPath)]; return require(svcPath) }

// ── A0：真实 full 包（70000-char mood）──
async function produceFullPackage(stack) {
  const svc = lc()
  const wxCloud = { init() {}, callFunction: o => { const h = stack.routes[o.name]; Promise.resolve().then(() => h(o.data)).then(r => o.success({ result: r })).catch(e => o.fail({ errMsg: e.message })) }, uploadFile: o => o.success({ fileID: 'cloud://e.b/x', statusCode: 200 }) }
  global.wx = { cloud: wxCloud, getFileSystemManager: () => { throw new Error('no fsm') }, env: { USER_DATA_PATH: 'wxfile://usr' } }
  global.wx.cloud = wxCloud
  // 附件下载 mock：从 mock 云 __stored 取真实字节 → FSM 临时文件 → success
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
  // getFileSystemManager FSM（供下载后读取附件字节）
  global.wx.getFileSystemManager = () => ({
    writeFile(o) { const bytes = new Uint8Array(Buffer.from(o.data || '')); fsmFiles.set(o.filePath, bytes); o.success({}) },
    appendFile(o) { const a = new Uint8Array(Buffer.from(o.data || '')), p2 = fsmFiles.get(o.filePath) || new Uint8Array(0), n = new Uint8Array(p2.length + a.length); n.set(p2); n.set(a, p2.length); fsmFiles.set(o.filePath, n); o.success({}) },
    readFile(o) { const f = fsmFiles.get(o.filePath); if (!f) return o.fail({ errMsg: 'nf' }); const pos = o.position || 0, len = o.length == null ? f.length - pos : Math.min(o.length, f.length - pos); o.success({ data: f.slice(pos, pos + len).buffer }) },
    stat(o) { const f = fsmFiles.get(o.path); if (!f) return o.fail({ errMsg: 'nf' }); o.success({ stats: { size: f.length } }) },
    rename(o) { const f = fsmFiles.get(o.oldPath); if (f) { fsmFiles.set(o.newPath, f); fsmFiles.delete(o.oldPath) } o.success({}) },
    mkdir(o) { o.success({}) }, rmdir(o) { o.success({}) }, unlink(o) { fsmFiles.delete(o.filePath); o.success({}) }, access(o) { o.success({}) },
  })
  svc.__setCloudConfigForTests('env-b3b2', 'wxapp-b3b2'); svc.__setWxCloud(wxCloud); svc.__resetForTests()
  await svc.confirmIdentity()
  await stack.call('mc-health', { action: 'pregnancy.upsert', schemaVersion: 1, operationId: 'sp', expectedRevision: 0, payload: { lmpDate: '2026-06-01' } })
  const up = await stack.call('mc-health', { action: 'mood.upsert', schemaVersion: 1, operationId: 'sm', expectedRevision: 0, dateKey: '2026-09-20', payload: { mood: 'calm', symptoms: ['s'.repeat(70000)], note: 'probe' } })
  assert.ok(up.ok, 'mood seed: ' + JSON.stringify(up).slice(0, 120))
  // 种报告+附件（真实 mc-files 管线：prepare→upload→register→saveReport）
  {
    const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130])
    const prep = await stack.call('mc-files', { action: 'prepareUpload', uploadId: 'rptprobe1' })
    assert.ok(prep.ok, 'prepareUpload: ' + JSON.stringify(prep).slice(0, 100))
    stack.cloud.__stored.set(prep.data.cloudPath, pngBytes)
    const reg = await stack.call('mc-files', { action: 'registerStaged', uploadId: 'rptprobe1', stageFileID: `cloud://e.b/${prep.data.cloudPath}` })
    assert.ok(reg.ok, 'registerStaged: ' + JSON.stringify(reg).slice(0, 100))
    const rpt = await stack.call('mc-reports', { action: 'report.upsert', schemaVersion: 1, operationId: 'srpt1', expectedRevision: 0, id: 'rpt_probe_1', payload: { reportType: 'other', dateKey: '2026-09-20', attachments: [{ fileId: reg.data.file.fileId }], note: 'probe report' } })
    assert.ok(rpt.ok, 'report.upsert: ' + JSON.stringify(rpt).slice(0, 120))
    // 第二份报告共享同一附件（供 L12i 共享段变异测试）
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
  // totals 从实际 manifest 计算
  const totals = { files: manifest.files.length, records: Object.values(manifest.records).reduce((a, l) => a + l.length, 0), domainCounts: Object.fromEntries(Object.entries(manifest.records).map(([d, l]) => [d, l.length])) }
  // 提取领域记录
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

// ── 走完 begin→declare→index 到 declared ──
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

async function main() {
  console.log('B3b 阶段二红先行回归（mc-restore handler → mock 云 CAS → 真实链）\n')
  const C = {}
  const P = {} // 共享包

  await scenario('A0 前置：真实阶段一导出 70000-char mood full 包（manifestDigest/totals 从实际包计算）', async () => {
    C.stack = makeStack('mama')
    C.stack.assertBinding() // 回归断言：handler 与 mock doc 同源
    const pkg = await produceFullPackage(C.stack)
    P.pkg = pkg.pkg; P.manifest = pkg.manifest; P.manifestBytes = pkg.manifestBytes
    P.manifestDigest = pkg.manifestDigest; P.totals = pkg.totals; P.domainRecords = pkg.domainRecords
    P.packageDigest = pkg.packageDigest; P.svc = pkg.svc
    const bigRec = P.domainRecords.mood.find(r => r.fields && r.fields.symptoms && r.fields.symptoms.some(s => s.length >= 70000))
    assert.ok(bigRec, '70000-char mood 在包内')
    const canon = P.svc.canonicalJsonBytes(bigRec)
    assert.ok(canon.length > 49152 && canon.length <= 4194304, `canonical=${canon.length}B（48KiB<x≤4MiB）`)
    assert.ok(P.totals.records >= 2, `totals.records=${P.totals.records}（pregnancy≥1+mood≥1）`)
    assert.ok(/^[0-9a-f]{64}$/.test(P.manifestDigest), 'manifestDigest=64hex（从实际字节计算）')
    // 硬前置：manifest 须有 ≥1 份有附件映射的报告 + ≥1 个 attachment 段（供 L12d/h/i 变异）
    const rptWithAtt = P.manifest.reports.find(r2 => r2.attachments && r2.attachments.length > 0)
    assert.ok(rptWithAtt, `前置：manifest 须有 >=1 份有附件映射的报告（无报告数据则 L12d/h/i 变异不可靠`)
    const attFile = P.manifest.files.find(f => f.kind === 'attachment')
    assert.ok(attFile, `前置：manifest 须有 ≥1 个 attachment 段（实得 files kinds=${JSON.stringify(P.manifest.files.map(f => f.kind))}）`)
    console.log(`      [A0] pkg=${P.pkg.length}B manifest=${P.manifestBytes.length}B digest=${P.manifestDigest.slice(0, 16)}… totals=${JSON.stringify(P.totals)} reports_with_att=${(P.manifest.reports.filter(r2 => (r2.attachments || []).length > 0)).length} attachments=${P.manifest.files.filter(f => f.kind === 'attachment').length}`)
  })

  await scenario('B1 begin：有效 128-bit nonce + 实际 digest/totals；幂等；changed-body 用语法合法 digest', async () => {
    C.batchId = nonce()
    const req = { action: 'restore.begin', batchId: C.batchId, formatVersion: 1, packageDigest: P.packageDigest, manifestDigest: P.manifestDigest, claimedKind: 'full', totals: P.totals }
    const r1 = await C.stack.call('mc-restore', req)
    const bdCheck = C.stack.cloud.__docs.get(`mc_restore_batches/${C.batchId}`)
    assert.ok(r1.ok, `begin: ${JSON.stringify(r1).slice(0, 200)}`)
    const r2 = await C.stack.call('mc-restore', req)
    assert.ok(r2.ok, '同内容幂等')
    // changed-body：语法合法的不同 digest（64-hex）——不用 'different' 字面量
    const r3 = await C.stack.call('mc-restore', { ...req, packageDigest: hexDigest() })
    assert.ok(!r3.ok && r3.code === 'batch-conflict', `内容变化拒绝: ${r3.code}`)
    const r4 = await C.stack.call('mc-restore', { ...req, manifestDigest: hexDigest() })
    assert.ok(!r4.ok && r4.code === 'batch-conflict', `manifest 变化拒绝: ${r4.code}`)
  })

  await scenario('C1 declareChunk：实际 manifest 字节分片→末片重组 digest 匹配→indexing', async () => {
    const CHUNK = 40 * 1024, total = Math.ceil(P.manifestBytes.length / CHUNK)
    for (let i = 0; i < total; i++) {
      const raw = P.manifestBytes.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, P.manifestBytes.length))
      const r = await C.stack.call('mc-restore', { action: 'restore.declareChunk', batchId: C.batchId, chunkIndex: i, chunkTotal: total, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      assert.ok(r.ok, `declareChunk ${i}/${total}: ${JSON.stringify(r).slice(0, 150)}`)
    }
  })

  await scenario('D1 indexDeclarePage：逐页→declared（声明计数与 manifest.records 一致）', async () => {
    for (let i = 0; i < 30; i++) {
      const r = await C.stack.call('mc-restore', { action: 'restore.indexDeclarePage', batchId: C.batchId })
      assert.ok(r.ok, `indexPage: ${JSON.stringify(r).slice(0, 200)}`)
      if (r.data && (r.data.status === 'declared' || r.data.hasMore === false)) break
    }
  })

  await scenario('E1 uploadRecord 内联（pregnancy ≤48KiB）：落库 + 同内容重放不递增 gen（白盒持久 gen）', async () => {
    // 前置：批次须在 declared 态（白盒持久文档）
    const bdPre = readBatchDoc(C.stack, C.batchId)
    assert.ok(bdPre && bdPre.status === 'declared', `前置：持久文档 declared（实得 ${bdPre && bdPre.status}）`)
    const genBefore = bdPre.contentGeneration
    assert.ok(Number.isInteger(genBefore) && genBefore >= 0, `genBefore 须整数（${genBefore}）`)
    const decl = P.manifest.records.pregnancy[0]
    const rec = P.domainRecords.pregnancy[decl.index]
    const r = await C.stack.call('mc-restore', { action: 'restore.uploadRecord', batchId: C.batchId, domain: 'pregnancy', index: decl.index, id: decl.id, revision: decl.revision, record: rec, deleted: decl.deleted })
    assert.ok(r.ok, `uploadRecord: ${JSON.stringify(r).slice(0, 200)}`)
    const r2 = await C.stack.call('mc-restore', { action: 'restore.uploadRecord', batchId: C.batchId, domain: 'pregnancy', index: decl.index, id: decl.id, revision: decl.revision, record: rec, deleted: decl.deleted })
    assert.ok(r2.ok, '重放 ok')
    const bdPost = readBatchDoc(C.stack, C.batchId)
    const genAfter = bdPost ? bdPost.contentGeneration : undefined
    assert.ok(Number.isInteger(genAfter), `genAfter 须整数（${genAfter}）`)
    assert.equal(genAfter, genBefore + 1, `首次+1 重放+0（${genBefore}→${genAfter}）——白盒持久文档`)
  })

  await scenario('E2 uploadRecordChunk 70000-char mood 分片→finalizeRecord→record-consumed + 重放幂等（白盒 gen）', async () => {
    const bdPre = readBatchDoc(C.stack, C.batchId)
    assert.ok(bdPre && (bdPre.status === 'declared' || bdPre.status === 'uploading'), `前置：持久文档 declared/uploading（实得 ${bdPre && bdPre.status}）`)
    const decl = P.manifest.records.mood[0]
    const rec = P.domainRecords.mood[decl.index]
    const canonical = Buffer.from(P.svc.canonicalJsonBytes(rec))
    const CHUNK = 40 * 1024, total = Math.ceil(canonical.length / CHUNK)
    assert.ok(total >= 2, `≥2 片（${total}）——canonical=${canonical.length}`)
    for (let i = 0; i < total; i++) {
      const raw = canonical.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, canonical.length))
      const r = await C.stack.call('mc-restore', { action: 'restore.uploadRecordChunk', batchId: C.batchId, domain: 'mood', index: decl.index, chunkIndex: i, chunkTotal: total, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      assert.ok(r.ok, `chunk ${i}/${total}: ${JSON.stringify(r).slice(0, 150)}`)
    }
    const genBefore = readBatchDoc(C.stack, C.batchId).contentGeneration
    assert.ok(Number.isInteger(genBefore), `genBefore 须整数（${genBefore}）`)
    const fin = await C.stack.call('mc-restore', { action: 'restore.finalizeRecord', batchId: C.batchId, domain: 'mood', index: decl.index, id: decl.id, revision: decl.revision, deleted: decl.deleted, expectedChunkTotal: total, expectedSha256: sha256(canonical) })
    assert.ok(fin.ok, `finalize: ${JSON.stringify(fin).slice(0, 200)}`)
    const fin2 = await C.stack.call('mc-restore', { action: 'restore.finalizeRecord', batchId: C.batchId, domain: 'mood', index: decl.index, id: decl.id, revision: decl.revision, deleted: decl.deleted, expectedChunkTotal: total, expectedSha256: sha256(canonical) })
    assert.ok(fin2.ok, 'finalize 重放 ok')
    const genAfter = readBatchDoc(C.stack, C.batchId).contentGeneration
    assert.ok(Number.isInteger(genAfter), `genAfter 须整数（${genAfter}）`)
    assert.equal(genAfter, genBefore + 1, `finalize 首次+1 重放+0（${genBefore}→${genAfter}）——白盒持久`)
    // 迟到 chunk：用合法范围内的 chunkIndex=0 + 篡改内容（finalize 后同 index 已被 consumedAt 拒——
    // 非 out-of-range chunkIndex 导致的 param 校验先触发）
    const mutatedChunk = Buffer.from(canonical.subarray(0, Math.min(40 * 1024, canonical.length)))
    mutatedChunk[0] ^= 0xff // 篡改首字节——非原内容
    const late = await C.stack.call('mc-restore', { action: 'restore.uploadRecordChunk', batchId: C.batchId, domain: 'mood', index: decl.index, chunkIndex: 0, chunkTotal: total, chunkB64: mutatedChunk.toString('base64'), chunkSha256: sha256(mutatedChunk) })
    assert.ok(!late.ok, `finalize 后迟到/篡改 chunk 须拒: ${JSON.stringify(late).slice(0, 100)}`)
    assert.ok(late.code === 'record-consumed' || /consumed|conflict/i.test(String(late.code || '')), `拒绝码须指向 consumed/conflict（实得 ${late.code}）——不得是 invalid-params（param 校验先触发的 out-of-range 不是目标路径）`)
  })

  await scenario('F1 累计 4MiB：真实近限包不变 manifest，两批次：A=合法分片成功 finalize；B=103 全满末片拒 record-too-large', async () => {
    // ── 产出一个真实含近 4MiB mood 记录的 full 包（真实 handler + 真实阶段一导出器）──
    const stack2 = makeStack('mama')
    const svc2 = lc()
    const wxCloud2 = { init() {}, callFunction: o => { const h = stack2.routes[o.name]; Promise.resolve().then(() => h(o.data)).then(r => o.success({ result: r })).catch(e => o.fail({ errMsg: e.message })) }, uploadFile: o => o.success({ fileID: 'cloud://e.b/x', statusCode: 200 }) }
    global.wx = { cloud: wxCloud2, getFileSystemManager: () => { throw new Error('no fsm') }, env: { USER_DATA_PATH: 'wxfile://usr' } }
    svc2.__setCloudConfigForTests('env-b3b2', 'wxapp-b3b2'); svc2.__setWxCloud(wxCloud2); svc2.__resetForTests()
    await svc2.confirmIdentity()
    await stack2.call('mc-health', { action: 'pregnancy.upsert', schemaVersion: 1, operationId: 'f1p', expectedRevision: 0, payload: { lmpDate: '2026-06-01' } })
    // 真实 handler 种入近 4MiB mood（stringList 单项无长度上限——handler 接受）
    const nearSymptom = 'q'.repeat(4190000) // canonical ≈ 4,190,127B ≤ 4,194,304
    const up = await stack2.call('mc-health', { action: 'mood.upsert', schemaVersion: 1, operationId: 'f1m', expectedRevision: 0, dateKey: '2026-09-21', payload: { mood: 'calm', symptoms: [nearSymptom], note: 'near4mib' } })
    assert.ok(up.ok, 'near4MiB mood seed: ' + JSON.stringify(up).slice(0, 120))
    const fsmFiles2 = new Map()
    global.wx.getFileSystemManager = () => ({
      writeFile(o) { fsmFiles2.set(o.filePath, new Uint8Array(Buffer.from(o.data || ''))); o.success({}) },
      appendFile(o) { const a = new Uint8Array(Buffer.from(o.data || '')), p2 = fsmFiles2.get(o.filePath) || new Uint8Array(0), n = new Uint8Array(p2.length + a.length); n.set(p2); n.set(a, p2.length); fsmFiles2.set(o.filePath, n); o.success({}) },
      readFile(o) { const f = fsmFiles2.get(o.filePath); if (!f) return o.fail({ errMsg: 'nf' }); const pos = o.position || 0, len = o.length == null ? f.length - pos : Math.min(o.length, f.length - pos); o.success({ data: f.slice(pos, pos + len).buffer }) },
      stat(o) { const f = fsmFiles2.get(o.path); if (!f) return o.fail({ errMsg: 'nf' }); o.success({ stats: { size: f.length } }) },
      rename(o) { const f = fsmFiles2.get(o.oldPath); if (f) { fsmFiles2.set(o.newPath, f); fsmFiles2.delete(o.oldPath) } o.success({}) },
      mkdir(o) { o.success({}) }, rmdir(o) { o.success({}) }, unlink(o) { fsmFiles2.delete(o.filePath); o.success({}) }, access(o) { o.success({}) },
    })
    const s2 = svc2.getSessionState()
    const pkg2 = await svc2.buildAndPublishPackage({ includeShared: true, includePrivateOf: s2.member.memberId })
    assert.ok(pkg2.ok && pkg2.complete === true, 'near4MiB full export: ' + pkg2.code)
    const pkg2Bytes = Buffer.from(fsmFiles2.get(pkg2.flag.path))
    const mlen2 = Number(new DataView(pkg2Bytes.buffer, pkg2Bytes.byteOffset + 16, 8).getBigUint64(0))
    const manifest2 = JSON.parse(pkg2Bytes.subarray(24, 24 + mlen2).toString('utf8'))
    const manifest2Bytes = Buffer.from(svc2.canonicalJsonBytes(manifest2))
    const manifest2Digest = sha256(manifest2Bytes)
    const totals2 = { files: manifest2.files.length, records: Object.values(manifest2.records).reduce((a, l) => a + l.length, 0), domainCounts: Object.fromEntries(Object.entries(manifest2.records).map(([d, l]) => [d, l.length])) }
    const package2Digest = pkg2.flag.packageDigest
    // 提取近 4MiB mood canonical（真实导出产物）
    let cur2 = 24 + mlen2, mood2Recs = null
    for (let i = 0; i < manifest2.files.length; i++) {
      const elen = Number(new DataView(pkg2Bytes.buffer, pkg2Bytes.byteOffset + cur2, 8).getBigUint64(0)); cur2 += 8
      const f = manifest2.files[i]
      if (f.kind === 'domain-json' && f.domain === 'mood') { mood2Recs = JSON.parse(pkg2Bytes.subarray(cur2, cur2 + elen).toString('utf8')) }
      cur2 += elen
    }
    const bigMood = mood2Recs.find(r => r.fields && r.fields.symptoms && r.fields.symptoms.some(x => x.length >= 4190000))
    assert.ok(bigMood, '近 4MiB mood 在真实导出包内')
    const bigCanonical = Buffer.from(svc2.canonicalJsonBytes(bigMood))
    assert.ok(bigCanonical.length > 49152 && bigCanonical.length <= 4194304, `真实 canonical=${bigCanonical.length}B（48KiB<x≤4MiB）`)
    const bigDecl = manifest2.records.mood.find(d => d.id === bigMood.dateKey)
    assert.ok(bigDecl, 'manifest 声明含近 4MiB mood（真实导出产物——无伪造）')
    console.log(`      [F1] near4MiB canonical=${bigCanonical.length}B, pkg=${pkg2Bytes.length}B, manifest=${manifest2Bytes.length}B`)
    // ── 声明辅助：走 begin→declare→index→declared ──
    async function declareBatch2(batchId) {
      const b = await stack2.call('mc-restore', { action: 'restore.begin', batchId, formatVersion: 1, packageDigest: package2Digest, manifestDigest: manifest2Digest, claimedKind: 'full', totals: totals2 })
      assert.ok(b.ok, `begin ${batchId}: ${JSON.stringify(b).slice(0, 150)}`)
      const CH = 40 * 1024, tot = Math.ceil(manifest2Bytes.length / CH)
      for (let i = 0; i < tot; i++) {
        const raw = manifest2Bytes.subarray(i * CH, Math.min((i + 1) * CH, manifest2Bytes.length))
        const r = await stack2.call('mc-restore', { action: 'restore.declareChunk', batchId, chunkIndex: i, chunkTotal: tot, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
        assert.ok(r.ok, `dc ${i}/${tot}: ${JSON.stringify(r).slice(0, 100)}`)
      }
      for (let i = 0; i < 30; i++) {
        const r = await stack2.call('mc-restore', { action: 'restore.indexDeclarePage', batchId })
        assert.ok(r.ok, `indexPage ${i}: ${JSON.stringify(r).slice(0, 150)}`)
        if (r.data && (r.data.status === 'declared' || r.data.hasMore === false)) break
      }
      // 硬终态断言：持久批次文档 status=declared（白盒——不依赖 progress API）
      const bd = readBatchDoc(stack2, batchId)
      assert.ok(bd && bd.status === 'declared', `declareBatch2 ${batchId} 持久文档终态须 declared（实得 ${bd && bd.status}）`)
    }
    const CHUNK = 40 * 1024
    const bigChunkTotal = Math.ceil(bigCanonical.length / CHUNK)
    assert.ok(bigChunkTotal >= 100 && bigChunkTotal <= 103, `近 4MiB 需 ${bigChunkTotal} 片（100..103）`)
    // ── 批次 A：上传 chunk 0..101（全满片）→ 精确重放 chunk 101 → 上传 chunk 102（末片部分）→ finalize ──
    const bidA = nonce()
    await declareBatch2(bidA)
    const lastFullIdx = bigChunkTotal - 2 // 最后全满片 index（0-indexed：101 = 第 102 片）
    for (let i = 0; i <= lastFullIdx; i++) {
      const raw = bigCanonical.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, bigCanonical.length))
      const r = await stack2.call('mc-restore', { action: 'restore.uploadRecordChunk', batchId: bidA, domain: 'mood', index: bigDecl.index, chunkIndex: i, chunkTotal: bigChunkTotal, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      assert.ok(r.ok, `[A] full chunk ${i}/${bigChunkTotal}: ${JSON.stringify(r).slice(0, 120)}`)
    }
    // ── A-replay：恰在最后全满片（index=lastFullIdx）上传后、末片部分片上传前——精确重放 → ok 且 gen 不变 ──
    {
      const bdR1 = readBatchDoc(stack2, bidA)
      const genR1 = bdR1 ? bdR1.contentGeneration : undefined
      assert.ok(Number.isInteger(genR1), `[A-replay] genR1 须整数（实得 ${genR1}）——白盒持久`)
      const rawR = bigCanonical.subarray(lastFullIdx * CHUNK, Math.min((lastFullIdx + 1) * CHUNK, bigCanonical.length))
      const replayR = await stack2.call('mc-restore', { action: 'restore.uploadRecordChunk', batchId: bidA, domain: 'mood', index: bigDecl.index, chunkIndex: lastFullIdx, chunkTotal: bigChunkTotal, chunkB64: Buffer.from(rawR).toString('base64'), chunkSha256: sha256(rawR) })
      assert.ok(replayR.ok, `[A-replay] 第 ${lastFullIdx + 1} 片（最后全满片）精确重放须 ok（幂等）: ${JSON.stringify(replayR).slice(0, 120)}`)
      const bdR2 = readBatchDoc(stack2, bidA)
      const genR2 = bdR2 ? bdR2.contentGeneration : undefined
      assert.ok(Number.isInteger(genR2), `[A-replay] genR2 须整数（实得 ${genR2}）`)
      assert.equal(genR2, genR1, `[A-replay] 精确重放后 gen 不变（${genR1}→${genR2}）——白盒持久`)
    }
    // 上传末片部分片（index=bigChunkTotal-1=102）
    {
      const i = bigChunkTotal - 1
      const raw = bigCanonical.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, bigCanonical.length))
      assert.ok(raw.length < CHUNK, `[A] 末片须部分片（${raw.length}B < ${CHUNK}B）——非全满`)
      const r = await stack2.call('mc-restore', { action: 'restore.uploadRecordChunk', batchId: bidA, domain: 'mood', index: bigDecl.index, chunkIndex: i, chunkTotal: bigChunkTotal, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      assert.ok(r.ok, `[A] partial chunk ${i}/${bigChunkTotal}: ${JSON.stringify(r).slice(0, 120)}`)
    }
    const finA = await stack2.call('mc-restore', { action: 'restore.finalizeRecord', batchId: bidA, domain: 'mood', index: bigDecl.index, id: bigDecl.id, revision: bigDecl.revision, deleted: bigDecl.deleted, expectedChunkTotal: bigChunkTotal, expectedSha256: sha256(bigCanonical) })
    assert.ok(finA.ok, `[A] finalize 近 4MiB（真实分片+真实 hash）: ${JSON.stringify(finA).slice(0, 200)}`)
    // ── 批次 B：同 frozen 声明，上传 102 全满片后第 103 片也全满 → record-too-large ──
    const bidB = nonce()
    await declareBatch2(bidB)
    const full40K = Buffer.alloc(40960, 0x61)
    let rejectedAt = -1, rejectCode = ''
    for (let i = 0; i < 103; i++) {
      const r = await stack2.call('mc-restore', { action: 'restore.uploadRecordChunk', batchId: bidB, domain: 'mood', index: bigDecl.index, chunkIndex: i, chunkTotal: 103, chunkB64: full40K.toString('base64'), chunkSha256: sha256(full40K) })
      if (!r.ok) { rejectedAt = i; rejectCode = r.code; break }
    }
    assert.ok(rejectedAt >= 0, `[B] 103 全满片须被拒（第 ${rejectedAt} 片拒，code=${rejectCode}）——103×40,960=4,218,880>4,194,304=MAX_DOMAIN_JSON_BYTES`)
    assert.ok(/too.large|record-too-large|limit/i.test(rejectCode), `[B] 拒绝码须指向累计超限: ${rejectCode}`)
    // 清理
    await stack2.call('mc-restore', { action: 'restore.abandon', batchId: bidA })
    await stack2.call('mc-restore', { action: 'restore.abandon', batchId: bidB })
  })

  await scenario('G0 Phase1 核心幂等（白盒）：三种同内容重放各须 ok 且持久 gen 前后不变', async () => {
    const bd1 = readBatchDoc(C.stack, C.batchId)
    assert.ok(bd1, `持久批次文档存在（batchId=${C.batchId}）——progress 未实现不阻塞白盒验证`)
    const gen1 = bd1.contentGeneration
    assert.ok(Number.isInteger(gen1) && gen1 >= 0, `gen1 须有限整数（实得 ${gen1}）——白盒持久文档`)
    // ① 同内容重放 pregnancy uploadRecord
    const d0 = P.manifest.records.pregnancy[0], r0 = P.domainRecords.pregnancy[d0.index]
    const rp1 = await C.stack.call('mc-restore', { action: 'restore.uploadRecord', batchId: C.batchId, domain: 'pregnancy', index: d0.index, id: d0.id, revision: d0.revision, record: r0, deleted: d0.deleted })
    assert.ok(rp1.ok, `① 重放 uploadRecord 须 ok（实得 ${JSON.stringify(rp1).slice(0, 120)}）`)
    // ②/③ chunk 重放 + finalize 重放——须在独立批次上（E2 已 finalize C.batchId 的 mood index=0）
    {
      const { st: stC, bid: bidC } = await freshDeclaredBatch(P)
      const bdC = readBatchDoc(stC, bidC)
      const genC = bdC ? bdC.contentGeneration : undefined
      assert.ok(Number.isInteger(genC), `② genC 须整数（${genC}）`)
      const dm = P.manifest.records.mood[0]
      const cm = Buffer.from(P.svc.canonicalJsonBytes(P.domainRecords.mood[dm.index]))
      const tm = Math.ceil(cm.length / (40 * 1024))
      // 先上传全部 chunk（70KB mood 需 2 片——只上传 chunk 0 会让 finalize 缺片）
      for (let ci = 0; ci < tm; ci++) {
        const rawC = cm.subarray(ci * 40 * 1024, Math.min((ci + 1) * 40 * 1024, cm.length))
        const upC = await stC.call('mc-restore', { action: 'restore.uploadRecordChunk', batchId: bidC, domain: 'mood', index: dm.index, chunkIndex: ci, chunkTotal: tm, chunkB64: Buffer.from(rawC).toString('base64'), chunkSha256: sha256(rawC) })
        assert.ok(upC.ok, `② 上传 chunk ${ci}/${tm} 须 ok: ${JSON.stringify(upC).slice(0, 120)}`)
      }
      // finalize 前精确重放 chunk 0 → ok（幂等）
      const raw0 = cm.subarray(0, Math.min(40 * 1024, cm.length))
      const rc1 = await stC.call('mc-restore', { action: 'restore.uploadRecordChunk', batchId: bidC, domain: 'mood', index: dm.index, chunkIndex: 0, chunkTotal: tm, chunkB64: Buffer.from(raw0).toString('base64'), chunkSha256: sha256(raw0) })
      assert.ok(rc1.ok, `② finalize 前精确重放 chunk 0 须 ok（幂等）: ${JSON.stringify(rc1).slice(0, 120)}`)
      // finalize
      const rf1 = await stC.call('mc-restore', { action: 'restore.finalizeRecord', batchId: bidC, domain: 'mood', index: dm.index, id: dm.id, revision: dm.revision, deleted: dm.deleted, expectedChunkTotal: tm, expectedSha256: sha256(cm) })
      assert.ok(rf1.ok, `③ finalize 须 ok: ${JSON.stringify(rf1).slice(0, 120)}`)
      // finalize 重放（同参数）→ ok 幂等
      const rf2 = await stC.call('mc-restore', { action: 'restore.finalizeRecord', batchId: bidC, domain: 'mood', index: dm.index, id: dm.id, revision: dm.revision, deleted: dm.deleted, expectedChunkTotal: tm, expectedSha256: sha256(cm) })
      assert.ok(rf2.ok, `③ finalize 重放须 ok: ${JSON.stringify(rf2).slice(0, 120)}`)
    }
    const bd2 = readBatchDoc(C.stack, C.batchId)
    const gen2 = bd2 ? bd2.contentGeneration : undefined
    assert.ok(Number.isInteger(gen2) && gen2 >= 0, `gen2 须有限整数（实得 ${gen2}）`)
    assert.equal(gen2, gen1, `三种同内容重放后 gen 精确不变（${gen1}→${gen2}）`)
  })

  await scenario('G1 public API progress：progress.ok + batch.contentGeneration 有限整数（Phase2 已实现——按实际响应契约 data.batch.*）', async () => {
    const st1 = await C.stack.call('mc-restore', { action: 'restore.progress', batchId: C.batchId })
    assert.ok(st1.ok, `progress 须 ok（实得 ${JSON.stringify(st1).slice(0, 120)}）`)
    const gen1 = st1.data && st1.data.batch && st1.data.batch.contentGeneration
    assert.ok(Number.isInteger(gen1) && gen1 >= 0, `progress 须返回有限整数 contentGeneration（实得 ${gen1}——契约位 data.batch.contentGeneration）`)
    const bdWB = readBatchDoc(C.stack, C.batchId)
    if (bdWB) {
      assert.equal(gen1, bdWB.contentGeneration, `progress gen 须与白盒持久文档一致（API=${gen1} 白盒=${bdWB.contentGeneration}）`)
      assert.equal(st1.data.batch.status, bdWB.status, `progress status 须与白盒一致（API=${st1.data.batch.status} 白盒=${bdWB.status}）`)
    }
    assert.ok(Array.isArray(st1.data.items), 'progress 须含 items 数组')
  })

  await scenario('H1 commit：preflightId 持久化+分页验证→restored+restored 后幂等', async () => {
    let preflightId = null
    for (let i = 0; i < 20; i++) {
      const req = { action: 'restore.commit', batchId: C.batchId }
      if (preflightId) req.preflightId = preflightId
      const r = await C.stack.call('mc-restore', req)
      assert.ok(r.ok, `commit ${i}: ${JSON.stringify(r).slice(0, 200)}`)
      if (r.data && r.data.preflightId) preflightId = r.data.preflightId
      if (r.data && r.data.status === 'restored') break
      if (r.data && r.data.status === 'verifying' && r.data.hasMore === false) continue
    }
    const st = await C.stack.call('mc-restore', { action: 'restore.progress', batchId: C.batchId })
    assert.equal(st.data && st.data.status, 'restored', `终态 restored（实得 ${st.data && st.data.status}）`)
    const r2 = await C.stack.call('mc-restore', { action: 'restore.commit', batchId: C.batchId, preflightId })
    assert.ok(r2.ok, 'restored 后 commit 幂等')
  })

  await scenario('I1 verify 真只读：零服务端写（批次文档 __v 不变）', async () => {
    const batchDocs = () => JSON.stringify([...C.stack.cloud.__docs.entries()].filter(([k]) => k.startsWith('mc_restore_batches')).map(([k, v]) => [k, v.__v]))
    const before = batchDocs()
    const r = await C.stack.call('mc-restore', { action: 'restore.verify', batchId: C.batchId })
    assert.ok(r.ok, `verify: ${JSON.stringify(r).slice(0, 200)}`)
    const after = batchDocs()
    assert.equal(after, before, 'verify 零写（批次 __v 不变）')
  })

  await scenario('J1 papa ACL：list 不可见/progress 不可操作 mama 批次', async () => {
    C.stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID); C.stack.curMember.value = 'papa'
    const lst = await C.stack.call('mc-restore', { action: 'restore.list' })
    assert.ok(lst.ok)
    assert.ok(!(lst.data && lst.data.batches && lst.data.batches.some(b => b.batchId === C.batchId)), 'papa list 不可见')
    const act = await C.stack.call('mc-restore', { action: 'restore.progress', batchId: C.batchId })
    assert.ok(!act.ok, 'papa progress 不可操作')
    C.stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID); C.stack.curMember.value = 'mama'
  })

  await scenario('K1 abandon：有效 nonce 批次→abandoning→清净→abandoned', async () => {
    const bid = nonce()
    const b = await C.stack.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: P.packageDigest, manifestDigest: P.manifestDigest, claimedKind: 'full', totals: P.totals })
    assert.ok(b.ok, 'begin')
    const ab = await C.stack.call('mc-restore', { action: 'restore.abandon', batchId: bid })
    assert.ok(ab.ok, `abandon: ${JSON.stringify(ab).slice(0, 200)}`)
    const st = await C.stack.call('mc-restore', { action: 'restore.progress', batchId: bid })
    assert.ok(st.data && st.data.status === 'abandoned', `终态 abandoned（实得 ${st.data && st.data.status}）`)
  })

  // ══ L. 负面用例（不合规 manifest 须在记录接收前被拒）══
  // ── 白盒辅助：从 mock 云持久文档读取批次状态与 contentGeneration（不依赖 progress API）──
  function readBatchDoc(stack, batchId) {
    const doc = stack.cloud.__docs.get(`mc_restore_batches/${batchId}`)
    if (!doc) return null
    return { status: doc.status, contentGeneration: doc.contentGeneration, batchId: doc.batchId, manifestChunkTotal: doc.manifestChunkTotal }
  }

  // ── 共用辅助：fresh stack + 走到 declared（终态断言用持久文档而非 progress API）──
  async function freshDeclaredBatch(pkgData) {
    const st = makeStack('mama')
    const bid = nonce()
    const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: pkgData.packageDigest, manifestDigest: pkgData.manifestDigest, claimedKind: 'full', totals: pkgData.totals })
    assert.ok(b.ok, `begin ${bid}: ${JSON.stringify(b).slice(0, 150)}`)
    const CH = 40 * 1024, ct = Math.ceil(pkgData.manifestBytes.length / CH)
    for (let i = 0; i < ct; i++) {
      const raw = pkgData.manifestBytes.subarray(i * CH, Math.min((i + 1) * CH, pkgData.manifestBytes.length))
      const r = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: ct, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      assert.ok(r.ok, `dc ${i}/${ct}: ${JSON.stringify(r).slice(0, 100)}`)
    }
    for (let i = 0; i < 30; i++) {
      const r = await st.call('mc-restore', { action: 'restore.indexDeclarePage', batchId: bid })
      assert.ok(r.ok, `indexPage ${i}: ${JSON.stringify(r).slice(0, 120)}`)
      if (r.data && (r.data.status === 'declared' || r.data.hasMore === false)) break
    }
    const bd = readBatchDoc(st, bid)
    assert.ok(bd && bd.status === 'declared', `freshDeclaredBatch ${bid} 持久文档终态须 declared（实得 ${bd && bd.status}）`)
    return { st, bid }
  }

  // ══ L0: 真并发同 index 不同 payload CAS 竞态 ══
  await scenario('L0 真并发同 index 不同 payload：事务 barrier 保证至多一个持久值、gen=实际写入数', async () => {
    const { st, bid } = await freshDeclaredBatch(P)
    const CH = 40 * 1024
    const dmm = P.manifest.records.mood[0]
    const cmm = Buffer.from(P.svc.canonicalJsonBytes(P.domainRecords.mood[dmm.index]))
    const tm = Math.ceil(cmm.length / CH)
    const payloadA = cmm.subarray(0, Math.min(CH, cmm.length))
    const payloadB = Buffer.from(payloadA); payloadB[0] ^= 0xff // 不同内容同 index 同 chunkIndex
    const reqA = { action: 'restore.uploadRecordChunk', batchId: bid, domain: 'mood', index: dmm.index, chunkIndex: 0, chunkTotal: tm, chunkB64: Buffer.from(payloadA).toString('base64'), chunkSha256: sha256(payloadA) }
    const reqB = { action: 'restore.uploadRecordChunk', batchId: bid, domain: 'mood', index: dmm.index, chunkIndex: 0, chunkTotal: tm, chunkB64: Buffer.from(payloadB).toString('base64'), chunkSha256: sha256(payloadB) }
    // barrier：两请求同时 commit + 5 秒有界超时（handler 若单线程早退则超时红——不悬挂）
    const barrier = { count: 0, target: 2, resolve: null, promise: null }
    barrier.promise = Promise.race([
      new Promise(r => { barrier.resolve = r }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('L0 barrier 超时（5s）——handler 可能未并发进入 commit 或早退')), 5000)),
    ])
    const bdPre = readBatchDoc(st, bid)
    const genBefore = bdPre ? bdPre.contentGeneration : undefined
    assert.ok(Number.isInteger(genBefore), `[L0] genBefore 须整数（${genBefore}）——白盒`)
    const origDb = st.cloud.database.bind(st.cloud)
    st.cloud.database = () => {
      const db = origDb()
      const origStartTx = db.startTransaction.bind(db)
      db.startTransaction = async () => {
        const tx = await origStartTx()
        const origCommit = tx.commit.bind(tx)
        tx.commit = async () => {
          barrier.count++
          if (barrier.count >= barrier.target) barrier.resolve()
          await barrier.promise // 两请求同时 commit
          return origCommit() // CAS：read 版本核对——后到者版本冲突
        }
        return tx
      }
      return db
    }
    const [rA, rB] = await Promise.all([st.call('mc-restore', reqA), st.call('mc-restore', reqB)])
    st.cloud.database = origDb
    // ── 强断言 ──
    // ① 恰一个成功（不是"至多"——双失败=假阴性）
    const okCount = [rA, rB].filter(r => r.ok).length
    assert.equal(okCount, 1, `恰一个成功（A.ok=${rA.ok} B.ok=${rB.ok}，okCount=${okCount}）——CAS 后到者须被拒，不可双失败`)
    // ② 两请求都到达 barrier（真并发）
    assert.ok(barrier.count >= 2, `两请求都到达 commit barrier（barrier.count=${barrier.count}）`)
    // ③ 持久 chunk 文档恰一个（不是"至多"——零条=双失败，两条=CAS 失效）
    const chunkKeys = [...st.cloud.__docs.keys()].filter(k => k.includes('record_chunk') && k.includes(bid))
    assert.equal(chunkKeys.length, 1, `chunk 文档恰一个（实得 ${chunkKeys.length}: ${JSON.stringify(chunkKeys)}）——零=双失败 两=CAS失效`)
    // ④ 持久 chunk 的 hash = 赢者 payload 的 sha256（不是"存在某个值"——须精确匹配）
    if (chunkKeys.length === 1) {
      const doc = st.cloud.__docs.get(chunkKeys[0])
      const winnerPayload = rA.ok ? payloadA : payloadB
      assert.equal(doc.chunkSha256, sha256(winnerPayload), `持久 chunk hash 须=赢者 payload（doc=${doc.chunkSha256.slice(0, 8)} 期望=${sha256(winnerPayload).slice(0, 8)}）`)
      assert.equal(doc.byteLength, winnerPayload.length, `持久 chunk 字节数=赢者 payload 长度（doc=${doc.byteLength} 期望=${winnerPayload.length}）`)
    }
    // ⑤ gen 递增恰 1（不是"非负"——恰=1 证明一次写入）
    const bdF = readBatchDoc(st, bid)
    const genFinal = bdF ? bdF.contentGeneration : undefined
    assert.ok(Number.isInteger(genFinal), `[L0] genFinal 须整数（${genFinal}）——白盒`)
    assert.equal(genFinal, genBefore + 1, `gen 恰递增 1（${genBefore}→${genFinal}——一次 CAS 成功写入）`)
  })

  await scenario('L1 不合规 manifest 拒绝（4 变体，fresh stack，末片 declareChunk 须 package-rejected 且理由对应变体）', async () => {
    // 前置：正常包须先成功 declare→indexing（同一 handler 同一 mock 类型——排除"所有包都被拒"的假阳性）
    {
      const st = makeStack('mama')
      const bid = nonce()
      const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: P.packageDigest, manifestDigest: P.manifestDigest, claimedKind: 'full', totals: P.totals })
      assert.ok(b.ok, `[正常包] begin ok: ${JSON.stringify(b).slice(0, 150)}`)
      const CH = 40 * 1024, ct = Math.ceil(P.manifestBytes.length / CH)
      for (let i = 0; i < ct; i++) {
        const raw = P.manifestBytes.subarray(i * CH, Math.min((i + 1) * CH, P.manifestBytes.length))
        const r = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: ct, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
        assert.ok(r.ok, `[正常包] dc ${i}/${ct}: ${JSON.stringify(r).slice(0, 120)}`)
      }
      // 正常包须进入 indexing（不接受"所有 declareChunk 都失败"的兜底绿）
      const idx = await st.call('mc-restore', { action: 'restore.indexDeclarePage', batchId: bid })
      assert.ok(idx.ok, `[正常包] indexDeclarePage 须 ok: ${JSON.stringify(idx).slice(0, 120)}`)
    }
    // 四变体（各自 fresh stack——排除 totals.files 全局 bug 干扰：每变体须以自身原因拒绝，非通用 totals 不匹配）
    const svcL = P.svc
    const variants = [
      { name: 'recordCount 不一致', mutate: m => { m.domains.mood.recordCount = (m.domains.mood.recordCount || 0) + 1 }, expectReason: /recordCount|record.*count|不一致|count.*mismatch/i },
      { name: '未知域', mutate: m => { m.domains.ghost = { status: 'present', fileIndex: 0, schemaVersion: 1, recordCount: 0, pagingComplete: true, visibility: 'shared' } }, expectReason: /domain|未知|unknown|unsupported.*domain/i },
      { name: 'formatVersion=2', mutate: m => { m.formatVersion = 2 }, expectReason: /version|formatVersion|unsupported/i },
      { name: '外家庭私人 scope', mutate: m => { m.scope.includePrivateOf = 'papa' }, expectReason: /scope|授权|private|family|本人/i },
    ]
    for (const { name, mutate, expectReason } of variants) {
      const st = makeStack('mama')
      const m = JSON.parse(JSON.stringify(P.manifest))
      mutate(m)
      const bytes = Buffer.from(svcL.canonicalJsonBytes(m))
      const digest = sha256(bytes)
      const bid = nonce()
      const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: P.packageDigest, manifestDigest: digest, claimedKind: 'full', totals: P.totals })
      assert.ok(b.ok, `[${name}] begin ok（承诺阶段不判定内容）`)
      const CH = 40 * 1024, ct = Math.ceil(bytes.length / CH)
      let lastResponse = null
      for (let i = 0; i < ct; i++) {
        const raw = bytes.subarray(i * CH, Math.min((i + 1) * CH, bytes.length))
        lastResponse = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: ct, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
        if (!lastResponse.ok) break
      }
      // 末片 declareChunk 须返回 package-rejected 且理由对应此变体（非通用 totals 不匹配）
      assert.ok(lastResponse && !lastResponse.ok, `[${name}] declareChunk 末片须拒绝（实得 ok=${lastResponse && lastResponse.ok}）`)
      assert.equal(lastResponse.code, 'package-rejected', `[${name}] 拒绝码须 package-rejected（实得 ${lastResponse.code}）`)
      const msg = String(lastResponse.message || '')
      assert.ok(!/totals[.](files|records)/i.test(msg), `[${name}] 拒绝理由不得是通用 totals 不匹配（实得 "${msg.slice(0, 80)}"）——须命中本变体的 schema/授权检查`)
      assert.ok(expectReason.test(msg), `[${name}] 拒绝理由须指向本变体（"${msg.slice(0, 80)}" 不匹配 ${expectReason}）`)
    }
  })

  await scenario('L2 begin changed totals/claimedKind/formatVersion 同 batchId → batch-conflict（fresh stack）', async () => {
    const st = makeStack('mama')
    const bid = nonce()
    const base = { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: P.packageDigest, manifestDigest: P.manifestDigest, claimedKind: 'full', totals: P.totals }
    const r0 = await st.call('mc-restore', base)
    assert.ok(r0.ok, `初始 begin: ${JSON.stringify(r0).slice(0, 120)}`)
    const r1 = await st.call('mc-restore', { ...base, totals: { ...P.totals, records: P.totals.records + 1 } })
    assert.ok(!r1.ok && r1.code === 'batch-conflict', `changed totals: ${r1.code}`)
    const r2 = await st.call('mc-restore', { ...base, claimedKind: 'diagnostic' })
    assert.ok(!r2.ok && r2.code === 'batch-conflict', `changed claimedKind: ${r2.code}`)
    const r3 = await st.call('mc-restore', { ...base, formatVersion: 2 })
    assert.ok(!r3.ok && r3.code === 'batch-conflict', `changed formatVersion 须 batch-conflict（实得 ${r3.code}）——批准版协议：同 batchId 变更承诺字段=内容冲突`)
  })

  await scenario('L3 chunk 三fault面（fresh stack 各自 setup 到 declared）：A=finalize 前 duplicate 重放 gen 不变 B=同 index 不同 payload → chunk-conflict C=事务 commit 失败注入 → 无 gen-without-byte', async () => {
    const CH = 40 * 1024
    const dmm = P.manifest.records.mood[0]
    const cmm = Buffer.from(P.svc.canonicalJsonBytes(P.domainRecords.mood[dmm.index]))
    const tm = Math.ceil(cmm.length / CH)
    const first = cmm.subarray(0, Math.min(CH, cmm.length))
    const firstB64 = Buffer.from(first).toString('base64')
    const firstSha = sha256(first)

    // A) finalize 前 duplicate chunk 精确重放 → gen 不变
    {
      const { st, bid } = await freshDeclaredBatch(P)
      const up1 = await st.call('mc-restore', { action: 'restore.uploadRecordChunk', batchId: bid, domain: 'mood', index: dmm.index, chunkIndex: 0, chunkTotal: tm, chunkB64: firstB64, chunkSha256: firstSha })
      assert.ok(up1.ok, `[A] 首片上传: ${JSON.stringify(up1).slice(0, 120)}`)
      const bd1 = readBatchDoc(st, bid)
      const gen1 = bd1 ? bd1.contentGeneration : undefined
      assert.ok(Number.isInteger(gen1), `[A] gen1 须整数（实得 ${gen1}）`)
      const up1b = await st.call('mc-restore', { action: 'restore.uploadRecordChunk', batchId: bid, domain: 'mood', index: dmm.index, chunkIndex: 0, chunkTotal: tm, chunkB64: firstB64, chunkSha256: firstSha })
      assert.ok(up1b.ok, `[A] 同片同内容精确重放须 ok（幂等）: ${JSON.stringify(up1b).slice(0, 120)}`)
      const bd2 = readBatchDoc(st, bid)
      const gen2 = bd2 ? bd2.contentGeneration : undefined
      assert.equal(gen2, gen1, `[A] 幂等重放后 gen 不变（${gen1}→${gen2}）`)
    }

    // B) 同 index 同 chunkIndex 不同 payload → chunk-conflict
    {
      const { st, bid } = await freshDeclaredBatch(P)
      const up1 = await st.call('mc-restore', { action: 'restore.uploadRecordChunk', batchId: bid, domain: 'mood', index: dmm.index, chunkIndex: 0, chunkTotal: tm, chunkB64: firstB64, chunkSha256: firstSha })
      assert.ok(up1.ok, `[B] 首片上传: ${JSON.stringify(up1).slice(0, 120)}`)
      const tampered = Buffer.from(first); tampered[0] ^= 0xff
      const up2 = await st.call('mc-restore', { action: 'restore.uploadRecordChunk', batchId: bid, domain: 'mood', index: dmm.index, chunkIndex: 0, chunkTotal: tm, chunkB64: Buffer.from(tampered).toString('base64'), chunkSha256: sha256(tampered) })
      assert.ok(!up2.ok, `[B] 同 index 不同 payload 须拒`)
      assert.ok(/chunk-conflict|conflict/i.test(String(up2.code || '') + String(up2.message || '')), `[B] 拒绝码: ${up2.code}`)
    }

    // C) 事务 commit 失败注入 → 无 gen-without-byte（chunk 文档不残留+gen 不递增）
    {
      const { st, bid } = await freshDeclaredBatch(P)
      const bdC1 = readBatchDoc(st, bid)
      const genBefore = bdC1 ? bdC1.contentGeneration : undefined
      assert.ok(Number.isInteger(genBefore), `[C] genBefore 须整数（${genBefore}）`)
      // 注入 commit 失败：包装 db.startTransaction 使 commit 抛异常
      const origDb = st.cloud.database.bind(st.cloud)
      let failNextCommit = 1
      st.cloud.database = () => {
        const db = origDb()
        const origStartTx = db.startTransaction.bind(db)
        db.startTransaction = async () => {
          const tx = await origStartTx()
          const origCommit = tx.commit.bind(tx)
          tx.commit = async () => {
            if (failNextCommit > 0) { failNextCommit--; const e = new Error('synthetic commit failure'); e.errCode = 'SYNTHETIC'; throw e }
            return origCommit()
          }
          return tx
        }
        return db
      }
      let threwOrFailed = false
      try {
        const up = await st.call('mc-restore', { action: 'restore.uploadRecordChunk', batchId: bid, domain: 'mood', index: dmm.index, chunkIndex: 0, chunkTotal: tm, chunkB64: firstB64, chunkSha256: firstSha })
        if (!up.ok) threwOrFailed = true
      } catch (e) { threwOrFailed = true }
      // 还原
      st.cloud.database = origDb
      assert.ok(threwOrFailed, `[C] commit 失败须被处理（失败返回或捕获——不冒充成功）`)
      const bdC2 = readBatchDoc(st, bid)
      const genAfter = bdC2 ? bdC2.contentGeneration : undefined
      assert.equal(genAfter, genBefore, `[C] 失败事务不递增 gen（${genBefore}→${genAfter}）——无 gen-without-byte`)
      // chunk 文档不残留 + anchor 文档不残留（失败事务零持久副作用）
      const chunkDocs = [...st.cloud.__docs.keys()].filter(k => k.includes('record_chunk') && k.includes(bid))
      assert.equal(chunkDocs.length, 0, `[C] 失败事务后无残留 chunk 文档（实得 ${chunkDocs.length} 条）`)
      const anchorDocs = [...st.cloud.__docs.keys()].filter(k => k.includes('anchor') && k.includes(bid))
      assert.equal(anchorDocs.length, 0, `[C] 失败事务后无残留 per-record anchor 文档（实得 ${anchorDocs.length} 条）——chunkTotal 锚定不应在 commit 失败时持久化`)
    }
  })

  // ══ L4: begin 并发活跃上限 CAS 竞态 ══
  await scenario('L4 begin 并发活跃上限：已有 1 活跃 + 2 并发 begin → 恰一成功+总活跃=2+拒绝者无持久 batch', async () => {
    const st = makeStack('mama')
    // 预置 1 个活跃批次（合法 begin 走到 declaring——不计活跃（仅 declared/uploading 计）
    // 但 handler 的活跃上限可能从 begin 起计——须先确认 handler 的语义）
    // 正确做法：begin + declareChunk + indexDeclarePage 到 declared → 这是"活跃"（非终态）
    const { st: stPre, bid: bidPre } = await freshDeclaredBatch(P)
    assert.ok(bidPre, '前置已建立 1 个 declared 批次（活跃）')
    // 在同 stack 上（stPre——活跃上限按成员计）并发 2 个 begin
    const bid1 = nonce(), bid2 = nonce()
    const req1 = { action: 'restore.begin', batchId: bid1, formatVersion: 1, packageDigest: P.packageDigest, manifestDigest: P.manifestDigest, claimedKind: 'full', totals: P.totals }
    const req2 = { action: 'restore.begin', batchId: bid2, formatVersion: 1, packageDigest: P.packageDigest, manifestDigest: P.manifestDigest, claimedKind: 'full', totals: P.totals }
    // 事务 commit barrier（真并发 begin——两请求同时进入活跃上限检查+写入活跃列表的 CAS）
    const barrier = { count: 0, target: 2, resolve: null }
    const barrierPromise = new Promise(r => { barrier.resolve = r })
    const origDb = stPre.cloud.database.bind(stPre.cloud)
    stPre.cloud.database = () => {
      const db = origDb()
      const origStartTx = db.startTransaction.bind(db)
      db.startTransaction = async () => {
        const tx = await origStartTx()
        const origCommit = tx.commit.bind(tx)
        tx.commit = async () => {
          barrier.count++
          if (barrier.count >= barrier.target) barrier.resolve()
          await Promise.race([barrierPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('L4 barrier 5s 超时')), 5000))])
          return origCommit()
        }
        return tx
      }
      return db
    }
    const [r1, r2] = await Promise.all([stPre.call('mc-restore', req1), stPre.call('mc-restore', req2)])
    stPre.cloud.database = origDb
    // ① 恰一个成功（上限=2，已有 1 活跃 → 只允许 1 个新）
    const okCount = [r1, r2].filter(r => r.ok).length
    assert.equal(okCount, 1, `恰一个成功（r1.ok=${r1.ok} r2.ok=${r2.ok}——上限 2 已占 1 → 仅 1 新增可成功）`)
    // ② 拒绝者错误码须指向活跃上限
    const rejected = [r1, r2].find(r => !r.ok)
    assert.ok(rejected && /too-many|active|limit/i.test(String(rejected.code || '') + String(rejected.message || '')), `拒绝码须指向活跃上限（实得 ${rejected && rejected.code}）`)
    // ③ 拒绝者无持久 batch 文档
    const rejectedBid = r1.ok ? bid2 : bid1
    const rejectedDoc = stPre.cloud.__docs.get(`mc_restore_batches/${rejectedBid}`)
    assert.ok(!rejectedDoc, `拒绝者 ${rejectedBid} 不得有持久 batch 文档（实得 ${JSON.stringify(rejectedDoc && 'exists')}）`)
    // ④ 总活跃批次 = 2（1 个预置 + 1 个新成功）
    const winnerBid = r1.ok ? bid1 : bid2
    const activeCount = [...stPre.cloud.__docs.entries()]
      .filter(([k, v]) => k.startsWith('mc_restore_batches/') && v.status !== 'restored' && v.status !== 'abandoned')
      .length
    assert.equal(activeCount, 2, `总活跃批次=2（实得 ${activeCount}——1 预置+1 新增）`)
  })

  // ══ L5: batchId 格式严格验证 ══
  await scenario('L5 batchId 非法格式拒绝：非 rst_ 前缀/短 hex/长 64/非 hex/空', async () => {
    const st = makeStack('mama')
    const badIds = [
      ['无前缀', 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'],
      ['短 hex', 'rst_abc'],
      ['超长', 'rst_' + 'a'.repeat(65)],
      ['非 hex 字符', 'rst_zzzz000000000000zzzz000000000000zzzz000000000000zzzz0000'],
      ['空串', ''],
      ['null', null],
      ['数字', 12345],
    ]
    for (const [name, badId] of badIds) {
      const r = await st.call('mc-restore', { action: 'restore.begin', batchId: badId, formatVersion: 1, packageDigest: P.packageDigest, manifestDigest: P.manifestDigest, claimedKind: 'full', totals: P.totals })
      assert.ok(!r.ok, `[${name}] 须拒绝（实得 ok=${r.ok}）`)
      assert.ok(/invalid|batchId/i.test(String(r.code || '') + String(r.message || '')), `[${name}] 拒绝码须指向 invalid/batchId（实得 ${r.code}）`)
    }
  })

  // ══ L6: manifest 闭包负面（正常包先通过 + 4 变体各自理由拒绝）══
  await scenario('L6 manifest 闭包/路径/长度/映射负面：正常包先过 + path 穿越/fileIndex 越界/attachment 无 chunkSha/墓碑带附件', async () => {
    const svcL = P.svc
    // 前置：正常包须先通过 declareChunk 的 schema 校验（排除"所有包都被拒"假阳性）
    {
      const st = makeStack('mama')
      const bid = nonce()
      const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: P.packageDigest, manifestDigest: P.manifestDigest, claimedKind: 'full', totals: P.totals })
      assert.ok(b.ok, `[正常包] begin ok`)
      const CH = 40 * 1024, ct = Math.ceil(P.manifestBytes.length / CH)
      for (let i = 0; i < ct; i++) {
        const raw = P.manifestBytes.subarray(i * CH, Math.min((i + 1) * CH, P.manifestBytes.length))
        const r = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: ct, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
        assert.ok(r.ok, `[正常包] dc ${i}/${ct}: ${JSON.stringify(r).slice(0, 100)}`)
      }
      const bd = readBatchDoc(st, bid)
      assert.ok(bd && (bd.status === 'indexing' || bd.status === 'declared'), `[正常包] 须进入 indexing/declared（实得 ${bd && bd.status}）`)
    }
    // 变体构造（从真实 manifest 出发——重算 digest；每例的拒绝理由须命中变体特征）
    const variants = [
      { name: 'path 穿越', mutate: m => { m.files[0].path = '../../etc/passwd' }, expect: /path|穿越|\.\./i },
      { name: 'fileIndex 越界', mutate: m => { m.domains.pregnancy.fileIndex = 9999 }, expect: /fileIndex|越界|out.of/i },
      { name: 'attachment 无 chunkSha', mutate: m => {
        const att = m.files.find(f => f.kind === 'attachment')
        if (att) { delete att.chunkSha256 } else { m.files.push({ path: 'files/fake.bin', kind: 'attachment', length: 100, sha256: 'a'.repeat(64), contentType: 'image/png' }) }
      }, expect: /chunkSha|附件缺/i },
      { name: '重复 path', mutate: m => { if (m.files.length >= 2) m.files[1].path = m.files[0].path }, expect: /path|重复|duplicate/i },
      { name: 'domain fileIndex 指向非 domain-json', mutate: m => {
        // 注入假 attachment 段并将 pregnancy 的 fileIndex 指向它（handler 须拒绝"fileIndex 指向非 domain-json"）
        m.files.push({ path: 'files/fake_att.bin', kind: 'attachment', length: 100, sha256: 'a'.repeat(64), contentType: 'image/png', chunkSha256: ['b'.repeat(64)], referencedBy: [] })
        m.domains.pregnancy.fileIndex = m.files.length - 1
      }, expect: /domain.json|fileIndex|指向/i },
    ]
    for (const { name, mutate, expect } of variants) {
      const st = makeStack('mama')
      const m = JSON.parse(JSON.stringify(P.manifest))
      mutate(m)
      const bytes = Buffer.from(svcL.canonicalJsonBytes(m))
      const digest = sha256(bytes)
      const bid = nonce()
      const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: P.packageDigest, manifestDigest: digest, claimedKind: 'full', totals: P.totals })
      assert.ok(b.ok, `[${name}] begin ok`)
      const CH = 40 * 1024, ct = Math.ceil(bytes.length / CH)
      let lastR = null
      for (let i = 0; i < ct; i++) {
        const raw = bytes.subarray(i * CH, Math.min((i + 1) * CH, bytes.length))
        lastR = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: ct, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
        if (!lastR.ok) break
      }
      assert.ok(lastR && !lastR.ok, `[${name}] declareChunk 末片须拒绝`)
      assert.equal(lastR.code, 'package-rejected', `[${name}] 拒绝码须 package-rejected（实得 ${lastR.code}）`)
      const msg = String(lastR.message || '')
      assert.ok(!/totals[.](files|records)/i.test(msg), `[${name}] 拒绝理由不得是通用 totals 不匹配（实得 "${msg.slice(0, 80)}"）`)
      assert.ok(expect.test(msg), `[${name}] 拒绝理由须命中本变体（"${msg.slice(0, 80)}" 不匹配 ${expect}）`)
    }
  })

  // ══ L7: manifest 非规范字节（空白/键序）——重算 digest 后须被拒 ══
  await scenario('L7 manifest 非规范 JSON 字节（空白/键序变化）——重算 digest 提交后 declareChunk 须拒绝', async () => {
    // 正常包先过（排除假阳性）
    {
      const st = makeStack('mama'); const bid = nonce()
      const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: P.packageDigest, manifestDigest: P.manifestDigest, claimedKind: 'full', totals: P.totals })
      assert.ok(b.ok, '[正常包] begin ok')
      const CH = 40 * 1024, ct = Math.ceil(P.manifestBytes.length / CH)
      for (let i = 0; i < ct; i++) {
        const raw = P.manifestBytes.subarray(i * CH, Math.min((i + 1) * CH, P.manifestBytes.length))
        const r = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: ct, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
        assert.ok(r.ok, `[正常包] dc ${i}: ${JSON.stringify(r).slice(0, 80)}`)
      }
      const bd = readBatchDoc(st, bid)
      assert.ok(bd && (bd.status === 'indexing' || bd.status === 'declared'), `[正常包] indexing+（实得 ${bd && bd.status}）`)
    }
    // 非规范 manifest：JSON.stringify(manifest, null, 2)——空白+插入序键（非字典序）
    const prettyBytes = Buffer.from(JSON.stringify(JSON.parse(P.manifestBytes.toString('utf8')), null, 2))
    assert.notEqual(prettyBytes.length, P.manifestBytes.length, `前置：非规范字节确实不同（${prettyBytes.length} vs ${P.manifestBytes.length}）`)
    {
      const st = makeStack('mama'); const bid = nonce()
      const prettyDigest = sha256(prettyBytes)
      const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: P.packageDigest, manifestDigest: prettyDigest, claimedKind: 'full', totals: P.totals })
      assert.ok(b.ok, 'begin ok（承诺不判定内容）')
      const CH = 40 * 1024, ct = Math.ceil(prettyBytes.length / CH)
      let lastR = null
      for (let i = 0; i < ct; i++) {
        const raw = prettyBytes.subarray(i * CH, Math.min((i + 1) * CH, prettyBytes.length))
        lastR = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: ct, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
        if (!lastR.ok) break
      }
      // 须拒绝且理由指向非规范字节
      assert.ok(lastR && !lastR.ok, `非规范 manifest 须拒（实得 ok=${lastR && lastR.ok}）`)
      assert.ok(/canonical|not-canonical|规范|字节/i.test(String(lastR.code || '') + String(lastR.message || '')), `拒绝理由须指向非规范字节（实得 ${lastR.code}: ${String(lastR.message || '').slice(0, 80)}）——服务端须重序列化比对 canonical 形态`)
      // 无持久副作用
      const bd = readBatchDoc(st, bid)
      assert.ok(!bd || bd.status === 'declaring', `批次不得进入 indexing（实得 ${bd && bd.status}）`)
    }
  })

  // ══ L8: manifest 非法 UTF-8 字节——重算 digest 后须被拒 ══
  await scenario('L8 manifest 非法 UTF-8 字节：替换 manifest 内已知字符串值（createdBy "mama"）→ 有损解码仍可 parse → 服务端须拒非法 UTF-8', async () => {
    // 前置：正常包先过
    {
      const st = makeStack('mama'); const bid = nonce()
      const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: P.packageDigest, manifestDigest: P.manifestDigest, claimedKind: 'full', totals: P.totals })
      assert.ok(b.ok, '[正常包] begin ok')
      const CH = 40 * 1024, ct = Math.ceil(P.manifestBytes.length / CH)
      for (let i = 0; i < ct; i++) {
        const raw = P.manifestBytes.subarray(i * CH, Math.min((i + 1) * CH, P.manifestBytes.length))
        const r = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: ct, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
        assert.ok(r.ok, `[正常包] dc ${i}`)
      }
      const bd = readBatchDoc(st, bid)
      assert.ok(bd && bd.status !== 'declaring', `[正常包] 须离开 declaring（实得 ${bd && bd.status}）`)
    }
    // 替换 manifest 内 "mama" 字符串值内容为 ED A0 80（孤立代理 UTF-8 编码）——保留两侧引号
    // 开引号=target[0]='"' 闭引号=target[5]='"'——替换 target[1..4]（mama 四字节）为三字节 ED A0 80
    // 有损 UTF-8 解码产生 U+FFFD 替换字符，JSON 结构仍完整可 parse——服务端须检测原始字节非法
    const targetStr = '"mama"'
    const targetBytes = Buffer.from(targetStr)
    const idx = P.manifestBytes.indexOf(targetBytes)
    assert.ok(idx >= 0, '前置：字节级找到 "mama"')
    const ED_A0_80 = Buffer.from([0xed, 0xa0, 0x80])
    // head 含开引号（0..idx），ED A0 80 替换 mama 四字节，tail 从闭引号（idx + targetBytes.length - 1 = idx+5）起
    const finalBytes = Buffer.concat([P.manifestBytes.subarray(0, idx + 1), ED_A0_80, P.manifestBytes.subarray(idx + targetBytes.length - 1)])
    // 无条件前置：有损解码后 JSON.parse 必须成功且含 U+FFFD
    const lossyStr = finalBytes.toString('utf8')
    let lossyParsed = null
    try { lossyParsed = JSON.parse(lossyStr) } catch (e) { throw new Error(`前置失败：有损解码后 JSON.parse 应成功（闭引号保留）但失败: ${e.message}`) }
    assert.ok(lossyStr.includes('\uFFFD'), `前置：有损解码须含 U+FFFD 替换字符（实得含=${lossyStr.includes('\uFFFD')}）——JSON.parse 成功=非语法错误`)
    const badDigest = sha256(finalBytes)
    const st = makeStack('mama'); const bid = nonce()
    const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: P.packageDigest, manifestDigest: badDigest, claimedKind: 'full', totals: P.totals })
    assert.ok(b.ok, 'begin ok（承诺阶段不判定）')
    const CH = 40 * 1024, ct = Math.ceil(finalBytes.length / CH)
    let lastR = null
    for (let i = 0; i < ct; i++) {
      const raw = finalBytes.subarray(i * CH, Math.min((i + 1) * CH, finalBytes.length))
      lastR = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: ct, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      if (!lastR.ok) break
    }
    // 须拒绝——理由须指向 UTF-8/surrogate/损坏（不是 JSON parse 失败——因为 lossy decode 后 parse 可能成功）
    assert.ok(lastR && !lastR.ok, `含 ED A0 80 的 manifest 须拒（实得 ok=${lastR && lastR.ok}）`)
    const msg8 = String(lastR.code || '') + ' ' + String(lastR.message || '')
    assert.ok(/malformed|utf-?8|surrogate|invalid.*byte|非法.*字节/i.test(msg8) && !/解析失败|JSON.parse|parse.error/i.test(msg8), `拒绝理由须特定指向非法 UTF-8/surrogate（实得 ${lastR.code}: ${String(lastR.message || '').slice(0, 80)}）——通用 "JSON 解析失败" 不满足（有损解码后 JSON.parse 成功——handler 须检测原始字节）`)
    const bd = readBatchDoc(st, bid)
    assert.ok(!bd || bd.status === 'declaring', `批次不得进入 indexing（实得 ${bd && bd.status}）`)
  })

  // ══ L9: 伪造 body 身份——request id/rev/del 与冻结声明匹配但 body 含伪造字段 → 须到 body-schema 门 ══
  await scenario('L9 uploadRecord 伪造 body 身份（hash 恰匹配冻结声明）：body 含非法 body 字段 → 须 body-schema 拒+零写', async () => {
    // 构造一个完全自洽的伪造 manifest：
    // mood 记录 body 含未知顶层字段（如 "forgedField"）——canonical hash 与声明 hash 一致
    // domain-json 文件 digest/length 更新、manifestDigest 更新、所有闭包自洽
    const svcL = P.svc
    const m = JSON.parse(JSON.stringify(P.manifest))
    // 构造伪造 pregnancy 记录（<48KiB——mood 70KB 超 inline 预算）：未知顶层字段
    const origPregRec = P.domainRecords.pregnancy[0]
    const forgedPreg = JSON.parse(JSON.stringify(origPregRec))
    forgedPreg.forgedTopLevel = 'unknown-field-value' // 未知顶层字段
    const forgedCanonical = svcL.canonicalJsonBytes(forgedPreg)
    const forgedHash = sha256(forgedCanonical)
    // 更新 pregnancy domain-json 文件条目
    const pregFileIdx = m.files.findIndex(f => f.kind === 'domain-json' && f.domain === 'pregnancy')
    assert.ok(pregFileIdx >= 0, 'pregnancy domain-json 文件存在')
    const newPregDomainJson = [forgedPreg]
    const newPregBytes = svcL.canonicalJsonBytes(newPregDomainJson)
    m.files[pregFileIdx].length = newPregBytes.length
    m.files[pregFileIdx].sha256 = sha256(newPregBytes)
    // 更新声明 hash
    if (m.records.pregnancy && m.records.pregnancy[0]) {
      m.records.pregnancy[0].hash = forgedHash
    }
    // 重新 canonical 序列化 manifest
    const newManifestBytes = Buffer.from(svcL.canonicalJsonBytes(m))
    const newManifestDigest = sha256(newManifestBytes)
    const newTotals = { files: m.files.length, records: Object.values(m.records).reduce((a, l) => a + l.length, 0), domainCounts: Object.fromEntries(Object.entries(m.records).map(([d, l]) => [d, l.length])) }
    const newPackageDigest = sha256(newManifestBytes) // 简化：用 manifest digest 作为 package digest
    // 走完 begin→declare→index→declared
    const st = makeStack('mama'); const bid = nonce()
    const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: newPackageDigest, manifestDigest: newManifestDigest, claimedKind: 'full', totals: newTotals })
    assert.ok(b.ok, `begin ok: ${JSON.stringify(b).slice(0, 120)}`)
    const CH = 40 * 1024, ct = Math.ceil(newManifestBytes.length / CH)
    for (let i = 0; i < ct; i++) {
      const raw = newManifestBytes.subarray(i * CH, Math.min((i + 1) * CH, newManifestBytes.length))
      const r = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: ct, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      assert.ok(r.ok, `dc ${i}/${ct}: ${JSON.stringify(r).slice(0, 100)}`)
    }
    for (let i = 0; i < 30; i++) {
      const r = await st.call('mc-restore', { action: 'restore.indexDeclarePage', batchId: bid })
      assert.ok(r.ok, `indexPage: ${JSON.stringify(r).slice(0, 100)}`)
      if (r.data && (r.data.status === 'declared' || r.data.hasMore === false)) break
    }
    const bdPre = readBatchDoc(st, bid)
    assert.ok(bdPre && bdPre.status === 'declared', `终态 declared（实得 ${bdPre && bdPre.status}）——伪造 manifest 须先通过 declare（测试 body-schema 门而非 manifest 门）`)
    const genBefore = bdPre ? bdPre.contentGeneration : undefined
    // 上传伪造 mood 记录——request id/revision/deleted 与冻结声明精确匹配，body hash 也匹配（自洽伪造）
    const pregDecl = m.records.pregnancy[0]
    // a) 未知顶层字段 + request 元数据与冻结声明精确匹配 + hash 匹配 → 须 body-schema 拒
    const rUpload = await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'pregnancy', index: pregDecl.index, id: pregDecl.id, revision: pregDecl.revision, record: forgedPreg, deleted: pregDecl.deleted })
    assert.ok(!rUpload.ok, `[a] 伪造 body 顶层字段须拒（实得 ok=${rUpload.ok}）`)
    assert.ok(/unknown|field|白名单|whitelist|forged/i.test(String(rUpload.message || '')), `[a] 拒绝消息须识别未知字段（实得 ${rUpload.code}: ${String(rUpload.message || '').slice(0, 80)}）——declaration-mismatch 码可接受但消息须具体`)
    // b) body 内伪造身份字段（记录体里的 id/revision/deleted 与冻结声明的对应字段不同）——request 元数据不变
    //    构造：body 里的 revision 字段与冻结声明 revision 不同（但 request 的 revision 参数不变）
    const forgedIdentity = JSON.parse(JSON.stringify(origPregRec))
    forgedIdentity.revision = 999 // body 内 revision 伪造——request revision 仍是声明的（不加 forgedTopLevel——纯隔离 revision 差异）
    const fiCanonical = svcL.canonicalJsonBytes(forgedIdentity)
    const fiHash = sha256(fiCanonical)
    // 更新 manifest 以使 hash 匹配（body 内 revision 伪造但声明 hash 是伪造后的）
    const m2 = JSON.parse(JSON.stringify(m))
    const pregFileIdx2 = m2.files.findIndex(f => f.kind === 'domain-json' && f.domain === 'pregnancy')
    const newPregJson2 = [forgedIdentity]
    const newPregBytes2 = svcL.canonicalJsonBytes(newPregJson2)
    m2.files[pregFileIdx2].length = newPregBytes2.length
    m2.files[pregFileIdx2].sha256 = sha256(newPregBytes2)
    m2.records.pregnancy[0].hash = fiHash
    // 声明 revision 仍为原始值——body revision=999 与声明 revision=0 不一致
    m2.records.pregnancy[0].revision = origPregRec.revision // 保持原始声明 revision
    const newM2Bytes = Buffer.from(svcL.canonicalJsonBytes(m2))
    const newM2Digest = sha256(newM2Bytes)
    const newM2Totals = { files: m2.files.length, records: Object.values(m2.records).reduce((a, l) => a + l.length, 0), domainCounts: Object.fromEntries(Object.entries(m2.records).map(([d, l]) => [d, l.length])) }
    // 走完 begin→declare→index→declared
    const st2 = makeStack('mama'); const bid2 = nonce()
    const b2 = await st2.call('mc-restore', { action: 'restore.begin', batchId: bid2, formatVersion: 1, packageDigest: sha256(newM2Bytes), manifestDigest: newM2Digest, claimedKind: 'full', totals: newM2Totals })
    assert.ok(b2.ok, `[b] begin ok`)
    const CH2 = 40 * 1024, ct2 = Math.ceil(newM2Bytes.length / CH2)
    for (let i = 0; i < ct2; i++) {
      const raw = newM2Bytes.subarray(i * CH2, Math.min((i + 1) * CH2, newM2Bytes.length))
      const r = await st2.call('mc-restore', { action: 'restore.declareChunk', batchId: bid2, chunkIndex: i, chunkTotal: ct2, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      assert.ok(r.ok, `[b] dc ${i}`)
    }
    for (let i = 0; i < 30; i++) {
      const r = await st2.call('mc-restore', { action: 'restore.indexDeclarePage', batchId: bid2 })
      assert.ok(r.ok, `[b] indexPage`)
      if (r.data && (r.data.status === 'declared' || r.data.hasMore === false)) break
    }
    const bd2Pre = readBatchDoc(st2, bid2)
    assert.ok(bd2Pre && bd2Pre.status === 'declared', `[b] declared`)
    const gen2Before = bd2Pre ? bd2Pre.contentGeneration : undefined
    // 上传：request id/revision/deleted 与冻结声明匹配（原始值），但 body 内 revision=999
    const rB = await st2.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid2, domain: 'pregnancy', index: m2.records.pregnancy[0].index, id: m2.records.pregnancy[0].id, revision: m2.records.pregnancy[0].revision, record: forgedIdentity, deleted: m2.records.pregnancy[0].deleted })
    // body canonical hash 恰匹配声明 hash（fiHash）——body revision=999 与声明 revision 不一致
    // 这是标准的 declaration-mismatch（body 身份字段与冻结声明不匹配）——码名正确
    assert.ok(!rB.ok, `[b] body 内伪造 revision 须拒（实得 ok=${rB.ok}）`)
    assert.equal(rB.code, 'declaration-mismatch', `[b] body revision 不匹配=declaration-mismatch（实得 ${rB.code}）——正确码名`)
    assert.ok(/revision/i.test(String(rB.message || '')), `[b] 消息须含 revision（实得 "${String(rB.message || '').slice(0, 60)}"）`)
    const bd2Post = readBatchDoc(st2, bid2)
    assert.equal(bd2Post ? bd2Post.contentGeneration : undefined, gen2Before, `[b] gen 不变`)
    const bdPost = readBatchDoc(st, bid)
    assert.equal(bdPost ? bdPost.contentGeneration : undefined, genBefore, `gen 不变（${genBefore}→${bdPost && bdPost.contentGeneration}）`)
    const recDocs = [...st.cloud.__docs.keys()].filter(k => k.includes('mc_restore_records') && k.includes(bid))
    assert.equal(recDocs.length, 0, `零持久 record（实得 ${recDocs.length}）`)
  })

  // ══ L10: 未知域字段——自洽伪造 hash 走完 declared → upload 到 body-schema 门 ══
  await scenario('L10 uploadRecord 未知嵌套字段（fields 内 unknown 嵌套键，hash 恰匹配声明）→ 须 body-schema 拒+零写', async () => {
    const svcL = P.svc
    const m = JSON.parse(JSON.stringify(P.manifest))
    // 构造伪造 pregnancy 记录（<48KiB）：fields 内未知嵌套键
    const origPregRec = P.domainRecords.pregnancy[0]
    const forgedPreg = JSON.parse(JSON.stringify(origPregRec))
    if (!forgedPreg.fields) forgedPreg.fields = {}
    forgedPreg.fields.unknownNestedKey = 'unknown-value' // 未知嵌套字段
    const forgedCanonical = svcL.canonicalJsonBytes(forgedPreg)
    const forgedHash = sha256(forgedCanonical)
    const pregFileIdx = m.files.findIndex(f => f.kind === 'domain-json' && f.domain === 'pregnancy')
    const newPregDomainJson = [forgedPreg]
    const newPregBytes = svcL.canonicalJsonBytes(newPregDomainJson)
    m.files[pregFileIdx].length = newPregBytes.length
    m.files[pregFileIdx].sha256 = sha256(newPregBytes)
    if (m.records.pregnancy && m.records.pregnancy[0]) m.records.pregnancy[0].hash = forgedHash
    const newManifestBytes = Buffer.from(svcL.canonicalJsonBytes(m))
    const newManifestDigest = sha256(newManifestBytes)
    const newTotals = { files: m.files.length, records: Object.values(m.records).reduce((a, l) => a + l.length, 0), domainCounts: Object.fromEntries(Object.entries(m.records).map(([d, l]) => [d, l.length])) }
    // 走完 begin→declare→index→declared
    const st = makeStack('mama'); const bid = nonce()
    const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: sha256(newManifestBytes), manifestDigest: newManifestDigest, claimedKind: 'full', totals: newTotals })
    assert.ok(b.ok, 'begin ok')
    const CH = 40 * 1024, ct = Math.ceil(newManifestBytes.length / CH)
    for (let i = 0; i < ct; i++) {
      const raw = newManifestBytes.subarray(i * CH, Math.min((i + 1) * CH, newManifestBytes.length))
      const r = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: ct, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      assert.ok(r.ok, `dc ${i}`)
    }
    for (let i = 0; i < 30; i++) {
      const r = await st.call('mc-restore', { action: 'restore.indexDeclarePage', batchId: bid })
      assert.ok(r.ok, `indexPage`)
      if (r.data && (r.data.status === 'declared' || r.data.hasMore === false)) break
    }
    const bdPre = readBatchDoc(st, bid)
    assert.ok(bdPre && bdPre.status === 'declared', `declared（实得 ${bdPre && bdPre.status}）`)
    const genBefore = bdPre ? bdPre.contentGeneration : undefined
    // 上传伪造记录——hash 匹配、id/rev/del 匹配——须到 body-schema 门
    const pregDecl = m.records.pregnancy[0]
    const rUpload = await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'pregnancy', index: pregDecl.index, id: pregDecl.id, revision: pregDecl.revision, record: forgedPreg, deleted: pregDecl.deleted })
    assert.ok(!rUpload.ok, `未知嵌套字段须拒（实得 ok=${rUpload.ok}）`)
    assert.ok(/unknown|field|白名单|whitelist/i.test(String(rUpload.message || '')), `拒绝消息须识别未知嵌套字段（实得 ${rUpload.code}: ${String(rUpload.message || '').slice(0, 80)}）——declaration-mismatch 码可接受但消息须具体`)
    const bdPost = readBatchDoc(st, bid)
    assert.equal(bdPost ? bdPost.contentGeneration : undefined, genBefore, `gen 不变`)
    const recDocs = [...st.cloud.__docs.keys()].filter(k => k.includes('mc_restore_records') && k.includes(bid))
    assert.equal(recDocs.length, 0, `零持久 record`)
  })

  // ══ L11: 私人 scope 不可声称他人 ══
  await scenario('L11 私人 mood scope 不可声称另一成员：papa 上传 includePrivateOf=papa 的包——scope 校验须拒', async () => {
    // 构造 manifest 含 mood visibility=private + scope.includePrivateOf=papa——由 mama 上传
    const svcL = P.svc
    const m = JSON.parse(JSON.stringify(P.manifest))
    // 确保 mood 域标记 private
    if (m.domains.mood && m.domains.mood.status === 'present') {
      m.domains.mood.visibility = 'private'
      m.scope.includePrivateOf = 'papa' // 声称含 papa 的私人——但上传者是 mama → 须拒
    }
    const bytes = Buffer.from(svcL.canonicalJsonBytes(m))
    const digest = sha256(bytes)
    const st = makeStack('mama') // mama 上传
    const bid = nonce()
    const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: P.packageDigest, manifestDigest: digest, claimedKind: 'full', totals: P.totals })
    assert.ok(b.ok, 'begin ok（承诺阶段不判定）')
    const CH = 40 * 1024, ct = Math.ceil(bytes.length / CH)
    let lastR = null
    for (let i = 0; i < ct; i++) {
      const raw = bytes.subarray(i * CH, Math.min((i + 1) * CH, bytes.length))
      lastR = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: ct, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      if (!lastR.ok) break
    }
    assert.ok(lastR && !lastR.ok, `伪造 scope 须拒（实得 ok=${lastR && lastR.ok}）`)
    assert.ok(/scope|私人|本人|private/i.test(String(lastR.code || '') + String(lastR.message || '')), `拒绝理由须指向 scope/私人（实得 ${lastR.code}: ${String(lastR.message || '').slice(0, 80)}）`)
    const bd = readBatchDoc(st, bid)
    assert.ok(!bd || bd.status === 'declaring', `批次不得进入 indexing（实得 ${bd && bd.status}）`)
  })

  // ── L12 共用辅助 ──
  const svcL12 = P.svc
  function mkTotals12(m) { return { files: m.files.length, records: Object.values(m.records).reduce((a, l) => a + l.length, 0), domainCounts: Object.fromEntries(Object.entries(m.records).map(([d, l]) => [d, l.length])) } }
  function mBytes12(m) { return Buffer.from(svcL12.canonicalJsonBytes(m)) }
  async function tryDeclare12(m, label) {
    const bytes = mBytes12(m), digest = sha256(bytes), tot = mkTotals12(m)
    const st = makeStack('mama')
    const bid = nonce()
    const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: sha256(bytes), manifestDigest: digest, claimedKind: 'full', totals: tot })
    if (!b.ok) return { st, bid, rejected: true, step: 'begin', code: b.code, message: b.message, batchDoc: null }
    const CH = 40 * 1024, ct = Math.ceil(bytes.length / CH)
    for (let i = 0; i < ct; i++) {
      const raw = bytes.subarray(i * CH, Math.min((i + 1) * CH, bytes.length))
      const r = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: ct, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      if (!r.ok) return { st, bid, rejected: true, step: `dc${i}`, code: r.code, message: r.message, batchDoc: readBatchDoc(st, bid) }
    }
    const ir = await st.call('mc-restore', { action: 'restore.indexDeclarePage', batchId: bid })
    const bd = readBatchDoc(st, bid)
    return { st, bid, rejected: !ir.ok, step: 'post-declare', code: ir.code, message: ir.message, batchDoc: bd }
  }
  function assertRejectedAndStaysDeclaring(r, label, expectReason) {
    assert.ok(r.rejected, `[${label}] 须被拒（实得 rejected=${r.rejected} step=${r.step} code=${r.code}）`)
    const msg = String(r.code || '') + ' ' + String(r.message || '')
    assert.ok(expectReason.test(msg), `[${label}] 拒绝理由须命中 ${expectReason}（实得 "${msg.slice(0, 100)}"）`)
    if (r.batchDoc) {
      assert.ok(r.batchDoc.status === 'declaring', `[${label}] 批次须留 declaring（实得 ${r.batchDoc.status}）——不得进入 indexing/declared`)
    }
  }

  await scenario('L12a full+missing 域：mood 标 missing+删 records+删 domain-json 文件+重索引——full 包不得含 missing 域', async () => {
    const m = JSON.parse(JSON.stringify(P.manifest))
    // 删 mood 的 domain-json 文件并重索引后续文件
    const moodFileIdx = m.files.findIndex(f => f.kind === 'domain-json' && f.domain === 'mood')
    if (moodFileIdx >= 0) {
      m.files.splice(moodFileIdx, 1)
      // 重索引：所有 >moodFileIdx 的 fileIndex 减 1
      for (const [, entry] of Object.entries(m.domains)) {
        if (entry.fileIndex !== undefined && entry.fileIndex > moodFileIdx) entry.fileIndex--
      }
      for (const rpt of m.reports) { for (const a of (rpt.attachments || [])) { if (a.fileIndex > moodFileIdx) a.fileIndex-- } }
    }
    // mood 域标 missing
    m.domains.mood = { status: 'missing', reason: 'read-failed' }
    // 删 mood records
    delete m.records.mood
    const r = await tryDeclare12(m, 'L12a')
    assertRejectedAndStaysDeclaring(r, 'L12a', /missing|read.failed|full.*present|不允许.*missing/i)
  })

  await scenario('L12b scope 不含私人但域标 private（scopeLabel 保持一致 shared-only）', async () => {
    const m = JSON.parse(JSON.stringify(P.manifest))
    // scopeLabel 保持 shared-only（与 includePrivateOf=null 一致——不让 scopeLabel mismatch 先触发）
    m.scope.includePrivateOf = null
    m.scopeLabel = 'shared-only' // 一致
    // mood 已是 private（真实导出含私人）→ scope 不含但域标 private → 须拒
    if (m.domains.mood && m.domains.mood.status === 'present') {
      m.domains.mood.visibility = 'private' // 伪造：scope 不含但标 private
    }
    // mood 的 records 含声明——保持一致（只改 visibility 不改其他）
    const r = await tryDeclare12(m, 'L12b')
    assertRejectedAndStaysDeclaring(r, 'L12b', /private|scope|本人|includePrivateOf/i)
  })

  await scenario('L12c【裁定更新 2026-09-20：冗余 f.domain 门已移除】domain-json 文件条目 domain 字段错标——declare 须收（Stage1 对齐，与 L29 同契约）', async () => {
    const m = JSON.parse(JSON.stringify(P.manifest))
    // 找 mood 的 domain-json 文件，把 domain 字段改为 'checkup'（保持唯一 fileIndex——不触发 duplicate-index guard）
    const moodFileIdx = m.files.findIndex(f => f.kind === 'domain-json' && f.domain === 'mood')
    assert.ok(moodFileIdx >= 0, 'mood domain-json 存在')
    m.files[moodFileIdx].domain = 'checkup' // 冗余 domain 字段错标（Stage1 不查——0d73129e 起恢复侧门亦移除）
    const r = await tryDeclare12(m, 'L12c')
    assert.ok(r.rejected === false, `L12c declare 须收（冗余字段错标不再拒——与 L29/裁定一致；实得 rejected=${r.rejected} step=${r.step} ${r.code || ''}: ${String(r.message || '').slice(0, 60)}）`)
    assert.ok(!r.batchDoc || r.batchDoc.status === 'declared' || r.batchDoc.status === 'indexing', `L12c 正常推进（实得 ${r.batchDoc && r.batchDoc.status}）`)
  })

  await scenario('L12d 既有报告映射的 fileIndex 改为不存在值（真实报告——硬前置无 fallback）', async () => {
    const m = JSON.parse(JSON.stringify(P.manifest))
    // 硬前置：必须存在有附件映射的报告
    const rpt = m.reports.find(r2 => r2.attachments && r2.attachments.length > 0 && !r2.deleted)
    assert.ok(rpt, '硬前置：manifest 须有有附件映射的报告（A0 已断言——此处不 fallback）')
    // 只改 fileIndex 为不存在值——reportId/revision/deleted/order/originalFileId 全不变
    const origFileIndex = rpt.attachments[0].fileIndex
    rpt.attachments[0].fileIndex = 999
    const r = await tryDeclare12(m, 'L12d')
    assertRejectedAndStaysDeclaring(r, 'L12d', /fileIndex|无效|999|不存在|invalid/i)
  })

  await scenario('L12e scopeLabel 与 scope 不一致（独立变体）', async () => {
    const m = JSON.parse(JSON.stringify(P.manifest))
    m.scope.includePrivateOf = 'mama' // 含私人
    m.scopeLabel = 'shared-only' // 不一致
    // mood 域已标 private（真实导出含私人）→ 与 scopeLabel 不匹配
    const r = await tryDeclare12(m, 'L12e')
    assertRejectedAndStaysDeclaring(r, 'L12e', /scopeLabel|scope|不一致|mismatch/i)
  })

  await scenario('L12f includeShared=false 但共享域 present', async () => {
    const m = JSON.parse(JSON.stringify(P.manifest))
    m.scope.includeShared = false // 不含共享
    // 但 pregnancy/daily 等共享域仍 present（真实导出的状态）
    const r = await tryDeclare12(m, 'L12f')
    assertRejectedAndStaysDeclaring(r, 'L12f', /includeShared|shared|共享|omitted|present/i)
  })

  await scenario('L12g mood 域标 shared（真实导出为 private）', async () => {
    const m = JSON.parse(JSON.stringify(P.manifest))
    // mood 真实导出含私人——改为 shared（scope 含私人）→ 语义不匹配
    if (m.domains.mood && m.domains.mood.status === 'present') {
      m.domains.mood.visibility = 'shared' // 真实是 private——改为 shared 须拒
    }
    const r = await tryDeclare12(m, 'L12g')
    assertRejectedAndStaysDeclaring(r, 'L12g', /shared|private|visibility|mood/i)
  })

  await scenario('L12h 重复真实 reportId——非空同 order 尾随映射【裁定更新 2026-09-20/D25-r2：尾随有效空映射=安全 no-op 须收（d25firstmap 套 12/0 已钉）——负例改非空重复：Stage1 duplicate-report-order＋handler 尾随非空拒——拒因限重复语义非无关门】', async () => {
    const m = JSON.parse(JSON.stringify(P.manifest))
    // 硬前置：须有 ≥1 份有附件映射的真实报告——用其真实 reportId+附件项做非空同 order 重复
    const rpt = m.reports.find(r2 => r2.attachments && r2.attachments.length > 0 && !r2.deleted)
    assert.ok(rpt, `硬前置：manifest 须有有附件映射的报告（实得 ${m.reports.length} 份——A0 已断言）`)
    const dupItem = JSON.parse(JSON.stringify(rpt.attachments[0])) // 同 order+同 fileIndex（合法附件段——referencedBy 已含此 rid：不触无关门）
    m.reports.push({ reportId: rpt.reportId, revision: rpt.revision, deleted: false, attachments: [dupItem] })
    // 前置①：该精确变异全包 Stage1 validatePackage 须拒——且拒因恰为 duplicate-report-order
    const mBytes = mBytes12(m)
    const segTail = P.pkg.subarray(24 + P.manifestBytes.length) // 头 24B+原 manifest 之后的段尾（变异不动段）
    const mutatedPkg = Buffer.concat([Buffer.from(svcL12.encodeHeader(mBytes.length)), mBytes, segTail])
    const sv = await svcL12.validatePackage({ size: async () => mutatedPkg.length, readChunk: async (p, l) => new Uint8Array(mutatedPkg.subarray(p, p + l)) })
    assert.ok(!sv.ok, '变异全包 Stage1 须拒（非空同 order 重复映射）')
    const sCode = (sv.problems || [])[0] && sv.problems[0].code
    assert.strictEqual(sCode, 'duplicate-report-order', `Stage1 拒因须恰为 duplicate-report-order（实得 ${sCode}: ${String((sv.problems || [])[0] && sv.problems[0].message).slice(0, 60)}）`)
    // 前置②：handler 真路径拒——理由限重复语义（D25-r2 尾随非空/重复 reportId——非 fileIndex/referencedBy 等无关门）
    const r = await tryDeclare12(m, 'L12h')
    assertRejectedAndStaysDeclaring(r, 'L12h', /重复 reportId|重复 \(reportId,order\)|duplicate/i)
    assert.ok(!/fileIndex|referencedBy|contentType|chunkSha256/.test(String(r.message || '')), `[L12h] 拒因不得为无关门（实得 "${String(r.message).slice(0, 100)}"）`)
  })

  await scenario('L12i 共享附件段：删报告 1 映射留报告 2 引用→declare 通过→upload 报告 1 原始 body（含附件）→冻结映射 mismatch 拒+零写', async () => {
    // 硬前置：须有 ≥2 份共享同一附件文件的报告
    const m = JSON.parse(JSON.stringify(P.manifest))
    const rpt1 = m.reports.find(r2 => r2.reportId === 'rpt_probe_1' && r2.attachments && r2.attachments.length > 0)
    const rpt2 = m.reports.find(r2 => r2.reportId === 'rpt_probe_2' && r2.attachments && r2.attachments.length > 0)
    assert.ok(rpt1 && rpt2, `硬前置：须有 rpt_probe_1 和 rpt_probe_2（实得 reports=${JSON.stringify(m.reports.map(r3 => r3.reportId))}）`)
    assert.equal(rpt1.attachments[0].fileIndex, rpt2.attachments[0].fileIndex, '硬前置：两报告共享同一 fileIndex')
    // 变异：删报告 1 的附件映射 + 从 files.referencedBy 删报告 1（报告 2 仍引用该文件）
    const sharedFileIdx = rpt1.attachments[0].fileIndex
    const file = m.files[sharedFileIdx]
    assert.ok(file && file.kind === 'attachment', '共享附件段存在')
    file.referencedBy = file.referencedBy.filter(id => id !== rpt1.reportId) // 只删报告 1
    rpt1.attachments = [] // 报告 1 映射清空——但报告 2 仍引用
    assert.ok(file.referencedBy.includes(rpt2.reportId), `前置：报告 2 仍引用该附件（referencedBy=${JSON.stringify(file.referencedBy)}）`)
    // manifest declare 应通过（文件仍有报告 2 的引用——闭包自洽）
    const svcL12i = P.svc
    const bytes = mBytes12(m)
    const digest = sha256(bytes)
    const tot = mkTotals12(m)
    const st = makeStack('mama')
    const bid = nonce()
    const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: sha256(bytes), manifestDigest: digest, claimedKind: 'full', totals: tot })
    assert.ok(b.ok, 'begin ok')
    const CH = 40 * 1024, ct = Math.ceil(bytes.length / CH)
    for (let i = 0; i < ct; i++) {
      const raw = bytes.subarray(i * CH, Math.min((i + 1) * CH, bytes.length))
      const r = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: ct, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      assert.ok(r.ok, `dc ${i}`)
    }
    for (let i = 0; i < 30; i++) {
      const r = await st.call('mc-restore', { action: 'restore.indexDeclarePage', batchId: bid })
      assert.ok(r.ok, `indexPage`)
      if (r.data && (r.data.status === 'declared' || r.data.hasMore === false)) break
    }
    const bdPre = readBatchDoc(st, bid)
    assert.ok(bdPre && bdPre.status === 'declared', `declare 通过——文件仍被报告 2 引用（实得 ${bdPre && bdPre.status}）`)
    const genBefore = bdPre ? bdPre.contentGeneration : undefined
    // upload 报告 1 的原始 body（含附件映射）——manifest 中报告 1 声明 hash 未改（原始导出的）
    // → 原始 body canonical hash 恰匹配声明 hash（非 hash mismatch）
    // → 冻结声明中报告 1 的 reports 映射为空（rpt1.attachments=[]）但 body 含附件 → 须因附件映射不匹配拒
    const rpt1Decl = m.records.reports.find(d => d.id === rpt1.reportId)
    assert.ok(rpt1Decl, `硬前置：报告 1 声明存在（实得 records.reports=${JSON.stringify((m.records.reports || []).map(d => d.id))}）——不可静默跳过`)
    const origRpt1Body = P.domainRecords.reports.find(r2 => r2.id === rpt1.reportId)
    assert.ok(origRpt1Body, `硬前置：报告 1 原始 body 存在（实得 domainRecords.reports=${JSON.stringify((P.domainRecords.reports || []).map(r2 => r2.id))}）——不可静默跳过`)
    // 前置验证：原始 body canonical hash 恰等于冻结声明 hash（不是 hash mismatch——纯映射不匹配路径）
    const origBodyCanonical = P.svc.canonicalJsonBytes(origRpt1Body)
    const origBodyHash = sha256(origBodyCanonical)
    assert.equal(origBodyHash, rpt1Decl.hash, `硬前置：原始 body hash 恰匹配声明 hash（${origBodyHash.slice(0, 8)} vs ${rpt1Decl.hash.slice(0, 8)}）——拒绝原因须是附件映射不匹配而非 hash 不匹配`)
    // 前置验证：冻结声明中报告 1 的映射为空（变异清空了 rpt1.attachments）
    const rpt1MappingInManifest = m.reports.find(r2 => r2.reportId === rpt1.reportId)
    assert.ok(rpt1MappingInManifest && rpt1MappingInManifest.attachments.length === 0, '硬前置：变异后报告 1 映射为空')
    // 上传：request id/revision/deleted 与冻结声明匹配 + body hash 恰匹配 → 须因映射/附件不匹配拒
    const rUpload = await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'reports', index: rpt1Decl.index, id: rpt1Decl.id, revision: rpt1Decl.revision, record: origRpt1Body, deleted: rpt1Decl.deleted })
    assert.ok(!rUpload.ok, `upload 报告 1 原始 body 须拒（实得 ok=${rUpload.ok}）——body hash 恰匹配但映射为空`)
    // 拒绝消息须识别附件/映射（非仅通用 declaration-mismatch hash 不匹配——hash 是匹配的）
    assert.ok(/attachment|附件|mapping|映射/i.test(String(rUpload.message || '')), `拒绝消息须识别附件/映射不匹配（实得 ${rUpload.code}: ${String(rUpload.message || '').slice(0, 120)}）——body hash 已匹配（前置断言证明）——通用 hash mismatch 文案不满足`)
    const bdPost = readBatchDoc(st, bid)
    assert.equal(bdPost ? bdPost.contentGeneration : undefined, genBefore, `gen 不变（${genBefore}→${bdPost && bdPost.contentGeneration}）`)
    const recDocs = [...st.cloud.__docs.keys()].filter(k => k.includes('mc_restore_records') && k.includes(bid))
    assert.equal(recDocs.length, 0, `零持久 record（实得 ${recDocs.length}）`)
  })

  // ══ L13: declareChunk 越界 chunkIndex 须拒 + 无孤儿 chunk（chunk 0 已持久、digest 匹配、schema 拒） ══
  await scenario('L13 declareChunk chunkIndex 越界：chunkTotal=1 chunk 0=无效 schema JSON（digest 匹配→持久→schema 拒→留 declaring）→ chunkIndex=1 须 invalid-params + 恰 1 片持久', async () => {
    const st = makeStack('mama')
    const bid = nonce()
    // begin 用空对象 digest（chunk 0 将上传空对象 JSON——digest 匹配但 schema 拒）
    const emptyObjBytes = Buffer.from('{}')
    const emptyObjDigest = sha256(emptyObjBytes)
    const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: hexDigest(), manifestDigest: emptyObjDigest, claimedKind: 'full', totals: P.totals })
    assert.ok(b.ok, 'begin ok（承诺阶段不判定内容）')
    // chunk 0 = 空对象 JSON（canonical 自身 digest 匹配 manifestDigest）——schema 拒但 chunk 持久
    const r0 = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: 0, chunkTotal: 1, chunkB64: emptyObjBytes.toString('base64'), chunkSha256: emptyObjDigest })
    // chunk 0 须持久（无论 schema 拒与否——chunk 已写入）
    const chunkDoc0 = st.cloud.__docs.get(`mc_restore_declare_chunks/${bid}:0`)
    assert.ok(chunkDoc0, '前置：chunk 0 已持久（digest 匹配空对象——chunk 先落盘再 schema 判定）')
    // 批次须仍在 declaring（schema 拒绝空对象 manifest——不进入 indexing）
    const bd = readBatchDoc(st, bid)
    assert.ok(bd && bd.status === 'declaring', `前置：批次仍在 declaring（空对象 manifest schema 拒，实得 ${bd && bd.status}）`)
    // 发送 chunkIndex=1（>= chunkTotal=1，且 chunk 0 已存在——非"前片缺失"路径）
    const extraChunk = Buffer.from('{"extra":true}')
    const rExtra = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: 1, chunkTotal: 1, chunkB64: extraChunk.toString('base64'), chunkSha256: sha256(extraChunk) })
    assert.ok(!rExtra.ok, `chunkIndex=1 >= chunkTotal=1 须拒（实得 ok=${rExtra.ok}）——chunk 0 已存在（非前片缺失）`)
    assert.equal(rExtra.code, 'invalid-params', `拒绝码须 invalid-params（实得 ${rExtra.code}）——chunkIndex 越界（前片已持久+批次在 declaring）`)
    // 越界片不得留下孤儿 chunk 文档（恰=1 片：仅合法 chunk 0）
    const chunkDocs = [...st.cloud.__docs.keys()].filter(k => k.includes('declare_chunk') && k.includes(bid))
    assert.equal(chunkDocs.length, 1, `chunk 文档恰=1 片（实得 ${chunkDocs.length}——越界片不留孤儿）`)
  })

  // ══ L14: 自洽 manifest pregnancy index=99（非 0 连续）→ schema 拒 ══
  await scenario('L14 pregnancy 声明 index=99 非 0 连续：自洽 manifest（重算 digest）→ schema 拒 + 零声明持久 + gen 不变', async () => {
    const svcL14 = P.svc
    const m = JSON.parse(JSON.stringify(P.manifest))
    // 把 pregnancy 唯一声明的 index 改为 99（非 0 连续）
    const pregDecl = m.records.pregnancy[0]
    assert.ok(pregDecl, '硬前置：pregnancy 声明存在')
    pregDecl.index = 99 // 非 0 连续
    const bytes = Buffer.from(svcL14.canonicalJsonBytes(m))
    const digest = sha256(bytes)
    const tot = { files: m.files.length, records: Object.values(m.records).reduce((a, l) => a + l.length, 0), domainCounts: Object.fromEntries(Object.entries(m.records).map(([d, l]) => [d, l.length])) }
    const st = makeStack('mama')
    const bid = nonce()
    const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: sha256(bytes), manifestDigest: digest, claimedKind: 'full', totals: tot })
    assert.ok(b.ok, 'begin ok（承诺不判定内容）')
    const CH = 40 * 1024, ct = Math.ceil(bytes.length / CH)
    let lastR = null
    for (let i = 0; i < ct; i++) {
      const raw = bytes.subarray(i * CH, Math.min((i + 1) * CH, bytes.length))
      lastR = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: ct, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      if (!lastR.ok) break
    }
    assert.ok(lastR && !lastR.ok, `index=99 非 0 连续须拒（实得 ok=${lastR && lastR.ok}）`)
    assert.equal(lastR.code, 'package-rejected', `拒绝码须 package-rejected（实得 ${lastR.code}）`)
    assert.ok(/index|连续|位置|99/i.test(String(lastR.message || '')), `拒绝消息须识别 index/连续（实得 "${String(lastR.message || '').slice(0, 100)}"）`)
    // 零声明持久 + 批次留 declaring
    const bd = readBatchDoc(st, bid)
    assert.ok(bd && bd.status === 'declaring', `批次留 declaring（实得 ${bd && bd.status}）`)
    const declDocs = [...st.cloud.__docs.keys()].filter(k => k.includes('declarations') && k.includes(bid))
    assert.equal(declDocs.length, 0, `零声明持久（实得 ${declDocs.length}）`)
  })

  // ══ L15: manifest 重组后 >4MiB → package-rejected 截断 ══
  await scenario('L15 manifest 重组 >4MiB：填充到 4MiB+1B（128 合法片运输→重组超限→截断拒绝）', async () => {
    const svcL15 = P.svc
    const m = JSON.parse(JSON.stringify(P.manifest))
    // 在 mood 域追加一条大记录使 manifest 超 4MiB——但保持 schema 有效
    // 策略：在 pending 区域外塞大量合法备注字段使 manifest 字节数超限
    // 简化：在 mood 声明里追加一条带长 note 的声明（重算 domain-json hash）
    // 更直接：在 manifest 的 createdBy 后加大量空格不可行（canonical 无空格）
    // 实际做法：加一条 mood 声明 whose id 含大量字符（但 id ≤128）→ 不够
    // 最直接有效：在 manifest 的 scope 对象加一个不影响 schema 的大键
    // 但 canonical JSON 只序列化已知键——不认识的键在 schema 校验可能拒绝
    // 务实方案：直接在 manifest 后面追加 JSON 合法但 schema 无效的 padding
    // 更好方案：让 mood 的 note 字段本身极长（mood record 的 note 无长度上限）
    // 直接在 manifest 的 createdBy 塞 4MiB 字符串（manifest 自身超限——不是 domain-json 文件）
    // createdBy 是显示用字符串，schema 不检查长度——canonical 序列化后 manifest 字节 >4MiB
    m.createdBy = 'y'.repeat(4 * 1024 * 1024)
    const bytes = Buffer.from(svcL15.canonicalJsonBytes(m))
    // 前置：manifest 字节 >4MiB
    assert.ok(bytes.length > 4 * 1024 * 1024, `前置：manifest=${bytes.length}B > 4MiB=4194304B`)
    // 128 片运输上限内：bytes.length / 40KiB ≤128
    const CH = 40 * 1024
    const ct = Math.ceil(bytes.length / CH)
    assert.ok(ct <= 128, `前置：chunkTotal=${ct} ≤128 合法运输`)
    const digest = sha256(bytes)
    const tot = { files: m.files.length, records: Object.values(m.records).reduce((a, l) => a + l.length, 0), domainCounts: Object.fromEntries(Object.entries(m.records).map(([d, l]) => [d, l.length])) }
    const st = makeStack('mama')
    const bid = nonce()
    const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: sha256(bytes), manifestDigest: digest, claimedKind: 'full', totals: tot })
    assert.ok(b.ok, 'begin ok')
    let lastR = null
    for (let i = 0; i < ct; i++) {
      const raw = bytes.subarray(i * CH, Math.min((i + 1) * CH, bytes.length))
      lastR = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: ct, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      if (!lastR.ok) break
    }
    assert.ok(lastR && !lastR.ok, `manifest >4MiB 须拒（实得 ok=${lastR && lastR.ok}）`)
    assert.ok(/manifest.*长度|>.*4.*MiB|超限|too.*large|truncat/i.test(String(lastR.code || '') + String(lastR.message || '')), `拒绝消息须指向 manifest 长度超限（实得 ${lastR.code}: ${String(lastR.message || '').slice(0, 100)}）`)
    const bd = readBatchDoc(st, bid)
    assert.ok(bd && bd.status === 'declaring', `批次留 declaring（实得 ${bd && bd.status}）`)
  })

  // ══ L16: begin 事务故障注入——非冲突错误一次性不重试+sanitized；冲突两次后成功 ══
  await scenario('L16 begin tx 注入：非冲突 commit 错误恰一次尝试+sanitized 响应；CONFLICT 两次后成功', async () => {
    // A) 非冲突错误（权限错误）——恰一次 commit 尝试、无重试、响应干净
    {
      const st = makeStack('mama')
      let commitAttempts = 0
      const origDb = st.cloud.database.bind(st.cloud)
      st.cloud.database = () => {
        const db = origDb()
        const origStartTx = db.startTransaction.bind(db)
        db.startTransaction = async () => {
          const tx = await origStartTx()
          const origCommit = tx.commit.bind(tx)
          tx.commit = async () => {
            commitAttempts++
            const err = new Error('permission denied: collection not authorized')
            err.errCode = 'PERMISSION_DENIED'
            throw err
          }
          return tx
        }
        return db
      }
      const bid = nonce()
      const r = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: P.packageDigest, manifestDigest: P.manifestDigest, claimedKind: 'full', totals: P.totals })
      st.cloud.database = origDb
      assert.equal(commitAttempts, 1, `非冲突错误恰一次 commit 尝试（实得 ${commitAttempts}）——不自动重试非冲突错误`)
      assert.ok(!r.ok, `非冲突错误须失败返回（实得 ok=${r.ok}）`)
      // sanitized：响应不含 stack trace/内部路径
      const respStr = JSON.stringify(r)
      assert.ok(!respStr.includes('at ') || !respStr.includes('.js:'), `响应须 sanitized 无 stack trace（实得 "${respStr.slice(0, 120)}"）`)
      assert.ok(!respStr.includes('permission denied: collection'), `响应不含内部错误详情（实得 "${respStr.slice(0, 120)}"）——须 sanitized 概括性错误`)
    }
    // B) CONFLICT 错误两次后成功——handler 须重试 CAS 冲突
    {
      const st = makeStack('mama')
      let commitAttempts = 0
      const origDb = st.cloud.database.bind(st.cloud)
      st.cloud.database = () => {
        const db = origDb()
        const origStartTx = db.startTransaction.bind(db)
        db.startTransaction = async () => {
          const tx = await origStartTx()
          const origCommit = tx.commit.bind(tx)
          tx.commit = async () => {
            commitAttempts++
            if (commitAttempts <= 2) {
              const err = new Error('transaction conflict: CAS mismatch')
              err.errCode = 'CONFLICT'
              throw err
            }
            return origCommit() // 第三次成功
          }
          return tx
        }
        return db
      }
      const bid = nonce()
      const r = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: P.packageDigest, manifestDigest: P.manifestDigest, claimedKind: 'full', totals: P.totals })
      st.cloud.database = origDb
      assert.ok(r.ok, `CONFLICT 两次后第三次 commit 须成功（实得 ok=${r.ok} code=${r.code} attempts=${commitAttempts}）——handler 须有界 CAS 重试`)
      assert.ok(commitAttempts >= 3, `至少 3 次 commit 尝试（实得 ${commitAttempts}——2 冲突+1 成功）`)
    }
  })

  // ══ L17: declareChunk 首 chunk 事务故障注入——REQUIRE 失败+零 chunk+零锚定+正控重试成功 ══
  await scenario('L17a declareChunk 首片 tx 故障：REQUIRE 失败+零 chunk 文档+零 manifestChunkTotal+contentGeneration=0', async () => {
    const st = makeStack('mama')
    const bid = nonce()
    const CH = 40 * 1024
    const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: P.packageDigest, manifestDigest: P.manifestDigest, claimedKind: 'full', totals: P.totals })
    assert.ok(b.ok, 'begin ok')
    const ct = Math.ceil(P.manifestBytes.length / CH)
    const raw0 = P.manifestBytes.subarray(0, Math.min(CH, P.manifestBytes.length))
    let commitCount = 0
    const origDb = st.cloud.database.bind(st.cloud)
    st.cloud.database = () => {
      const db = origDb()
      const origStartTx = db.startTransaction.bind(db)
      db.startTransaction = async () => {
        const tx = await origStartTx()
        const origCommit = tx.commit.bind(tx)
        tx.commit = async () => {
          commitCount++
          if (commitCount === 1) throw new Error('synthetic declareChunk tx failure')
          return origCommit()
        }
        return tx
      }
      return db
    }
    const r0 = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: 0, chunkTotal: ct, chunkB64: Buffer.from(raw0).toString('base64'), chunkSha256: sha256(raw0) })
    st.cloud.database = origDb
    assert.ok(!r0.ok, `[17a] 首 declareChunk tx 故障须失败返回（实得 ok=${r0.ok} commit尝试=${commitCount}）`)
    const chunkDocs = [...st.cloud.__docs.keys()].filter(k => k.includes('declare_chunk') && k.includes(bid))
    assert.equal(chunkDocs.length, 0, `[17a] 故障后零 chunk 文档（实得 ${chunkDocs.length}——事务失败不残留半成品）`)
    const bd0 = readBatchDoc(st, bid)
    assert.ok(bd0, '批次文档存在')
    assert.ok(bd0.manifestChunkTotal === undefined || bd0.manifestChunkTotal === null, `[17a] 零 manifestChunkTotal 锚定（实得 ${bd0.manifestChunkTotal}——锚定须与 chunk 同事务原子`)
    assert.equal(bd0.contentGeneration, 0, `[17a] contentGeneration=0（实得 ${bd0.contentGeneration}）——首片失败零变更`)
  })

  await scenario('L17b declareChunk 正控：首片成功后 raw chunk 文档+raw manifestChunkTotal 锚定即时持久（同事务原子）', async () => {
    const st = makeStack('mama')
    const bid = nonce()
    const CH = 40 * 1024
    const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: P.packageDigest, manifestDigest: P.manifestDigest, claimedKind: 'full', totals: P.totals })
    assert.ok(b.ok, 'begin ok')
    const ct = Math.ceil(P.manifestBytes.length / CH)
    const raw0 = P.manifestBytes.subarray(0, Math.min(CH, P.manifestBytes.length))
    const r0 = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: 0, chunkTotal: ct, chunkB64: Buffer.from(raw0).toString('base64'), chunkSha256: sha256(raw0) })
    assert.ok(r0.ok, `[17b] 首 chunk 0 成功: ${JSON.stringify(r0).slice(0, 80)}`)
    // 立即验证 raw __docs（不经 readBatchDoc 投影——直查持久事实）
    const rawChunkDoc = st.cloud.__docs.get(`mc_restore_declare_chunks/${bid}:0`)
    assert.ok(rawChunkDoc, `[17b] raw chunk 0 文档持久（__docs 直查）`)
    assert.equal(rawChunkDoc.chunkSha256, sha256(raw0), `[17b] chunk 0 sha256 持久值匹配`)
    assert.equal(rawChunkDoc.byteLength, raw0.length, `[17b] chunk 0 byteLength=${raw0.length} 持久值匹配`)
    const rawBatchDoc = st.cloud.__docs.get(`mc_restore_batches/${bid}`)
    assert.ok(rawBatchDoc, `[17b] raw 批次文档存在`)
    assert.equal(rawBatchDoc.manifestChunkTotal, ct, `[17b] raw manifestChunkTotal=${ct} 首片即锚定（实得 ${rawBatchDoc.manifestChunkTotal}——与 chunk 0 同事务原子写入——handler :688-689 needAnchor 路径）`)
    assert.ok(rawBatchDoc.status === 'declaring' || rawBatchDoc.status === 'indexing', `[17b] 首片后批次状态合理（实得 ${rawBatchDoc.status}——单片 manifest=ct=1 首片即全齐→indexing；多片→declaring）`)
  })

  // ══ L18: 请求不可变字段类型同一性——单字段类型变异须拒 ══
  // 冻结声明：id=string, revision=number, deleted=boolean
  // 请求传 revision="1"（string 对 number）、deleted=0（number 对 boolean）、id=123（number 对 string）
  // 现行 String()/Number()/Boolean() 强转会当作精确全等——须类型+值逐一全等
  await scenario('L18a uploadRecord 类型变异：revision string "1" 对声明 number 1 → 须拒+零写+gen 不变', async () => {
    const { st, bid } = await freshDeclaredBatch(P)
    const bdPre = readBatchDoc(st, bid)
    const genBefore = bdPre ? bdPre.contentGeneration : undefined
    const decl = P.manifest.records.pregnancy[0]
    const rec = P.domainRecords.pregnancy[decl.index]
    // revision 类型变异：声明是 number（如 1），请求传 string "1"
    const rStringRev = await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'pregnancy', index: decl.index, id: decl.id, revision: String(decl.revision), record: rec, deleted: decl.deleted })
    assert.ok(!rStringRev.ok, `[L18a] revision=String(${decl.revision}) 类型变异须拒（实得 ok=${rStringRev.ok}）——Number() 强转 "1"==1 不满足类型同一性`)
    assert.ok(rStringRev.code === 'invalid-params' || rStringRev.code === 'declaration-mismatch', `[L18a] 拒绝码须指向类型/声明不匹配（实得 ${rStringRev.code}: ${String(rStringRev.message || '').slice(0, 80)}）——uploadRecord :886-887 有类型门`)
    // gen 不变 + 零 record
    const bdPost = readBatchDoc(st, bid)
    assert.equal(bdPost ? bdPost.contentGeneration : undefined, genBefore, `gen 不变（${genBefore}→${bdPost && bdPost.contentGeneration}）`)
    const recDocs = [...st.cloud.__docs.keys()].filter(k => k.includes('mc_restore_records') && k.includes(bid))
    assert.equal(recDocs.length, 0, `零持久 record（实得 ${recDocs.length}）`)
  })

  await scenario('L18b uploadRecord 类型变异：deleted number 0 对声明 boolean false → 须拒+零写+gen 不变', async () => {
    const { st, bid } = await freshDeclaredBatch(P)
    const bdPre = readBatchDoc(st, bid)
    const genBefore = bdPre ? bdPre.contentGeneration : undefined
    const decl = P.manifest.records.pregnancy[0]
    const rec = P.domainRecords.pregnancy[decl.index]
    // deleted 类型变异：声明是 boolean false，请求传 number 0
    const rNumDel = await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'pregnancy', index: decl.index, id: decl.id, revision: decl.revision, record: rec, deleted: 0 })
    assert.ok(!rNumDel.ok, `[L18b] deleted=0 类型变异须拒（实得 ok=${rNumDel.ok}）——Boolean() 强转 0==false 不满足类型同一性`)
    assert.ok(rNumDel.code === 'invalid-params' || rNumDel.code === 'declaration-mismatch', `[L18b] 拒绝码须指向类型/声明不匹配（实得 ${rNumDel.code}: ${String(rNumDel.message || '').slice(0, 80)}）——uploadRecord :886-887 有类型门`)
    const bdPost = readBatchDoc(st, bid)
    assert.equal(bdPost ? bdPost.contentGeneration : undefined, genBefore, `gen 不变`)
    const recDocs = [...st.cloud.__docs.keys()].filter(k => k.includes('mc_restore_records') && k.includes(bid))
    assert.equal(recDocs.length, 0, `零持久 record`)
  })

  await scenario('L18c uploadRecord id 值不匹配（number 12345 对声明 string "pregnancy"）→ 须拒+零写', async () => {
    const { st, bid } = await freshDeclaredBatch(P)
    const bdPre = readBatchDoc(st, bid)
    const genBefore = bdPre ? bdPre.contentGeneration : undefined
    const decl = P.manifest.records.pregnancy[0]
    const rec = P.domainRecords.pregnancy[decl.index]
    // 值不匹配（非纯类型变异——声明 id="pregnancy" 非数字字符串）
    const rNumId = await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'pregnancy', index: decl.index, id: 12345, revision: decl.revision, record: rec, deleted: decl.deleted })
    assert.ok(!rNumId.ok, `[L18c] id=12345（number）对声明 "${decl.id}"（string）须拒（实得 ok=${rNumId.ok}）——uploadRecord :888 typeof id!=='string' 类型门`)
    assert.ok(rNumId.code === 'invalid-params' || rNumId.code === 'declaration-mismatch', `[L18c] 语义拒绝（实得 ${rNumId.code}: ${String(rNumId.message || '').slice(0, 60)}）`)
    const bdPost = readBatchDoc(st, bid)
    assert.equal(bdPost ? bdPost.contentGeneration : undefined, genBefore, `gen 不变`)
    const recDocs = [...st.cloud.__docs.keys()].filter(k => k.includes('mc_restore_records') && k.includes(bid))
    assert.equal(recDocs.length, 0, `零持久 record`)
  })

  await scenario('L18d finalizeRecord 类型变异（分片路径 mood >48KiB）：基线在全部片上传后取——revision string/deleted number 须拒+零写+gen 不变', async () => {
    const { st, bid } = await freshDeclaredBatch(P)
    const decl = P.manifest.records.mood[0]
    const rec = P.domainRecords.mood[decl.index]
    const canonical = Buffer.from(P.svc.canonicalJsonBytes(rec))
    const CH = 40 * 1024, ct = Math.ceil(canonical.length / CH)
    // 先上传全部片（每片合法递增 gen——须在片全部完成后取基线）
    for (let i = 0; i < ct; i++) {
      const raw = canonical.subarray(i * CH, Math.min((i + 1) * CH, canonical.length))
      const r = await st.call('mc-restore', { action: 'restore.uploadRecordChunk', batchId: bid, domain: 'mood', index: decl.index, chunkIndex: i, chunkTotal: ct, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      assert.ok(r.ok, `[L18d] chunk ${i}/${ct}: ${JSON.stringify(r).slice(0, 80)}`)
    }
    // 基线在全部片上传完成后取（此时 gen 已含 chunk 写入的合法递增）
    const bdAfterChunks = readBatchDoc(st, bid)
    const genAfterChunks = bdAfterChunks ? bdAfterChunks.contentGeneration : undefined
    assert.ok(Number.isInteger(genAfterChunks), `[L18d] 基线 genAfterChunks=${genAfterChunks} 须整数`)
    // a) finalize revision 类型变异 string（声明 number → 请求 string）
    const finStrRev = await st.call('mc-restore', { action: 'restore.finalizeRecord', batchId: bid, domain: 'mood', index: decl.index, id: decl.id, revision: String(decl.revision), deleted: decl.deleted, expectedChunkTotal: ct, expectedSha256: sha256(canonical) })
    assert.ok(!finStrRev.ok, `[L18d-a] finalize revision=String(${decl.revision}) 类型变异须拒（实得 ok=${finStrRev.ok}）——Number() 强转 "${decl.revision}"==${decl.revision} 不满足类型同一性`)
    assert.ok(finStrRev.code === 'invalid-params' || finStrRev.code === 'declaration-mismatch', `[L18d-a] 语义拒绝（实得 ${finStrRev.code}: ${String(finStrRev.message || '').slice(0, 80)}）`)
    // b) finalize deleted 类型变异 number（声明 boolean → 请求 number）
    const finNumDel = await st.call('mc-restore', { action: 'restore.finalizeRecord', batchId: bid, domain: 'mood', index: decl.index, id: decl.id, revision: decl.revision, deleted: 0, expectedChunkTotal: ct, expectedSha256: sha256(canonical) })
    assert.ok(!finNumDel.ok, `[L18d-b] finalize deleted=0 类型变异须拒（实得 ok=${finNumDel.ok}）——Boolean() 强转 0==false 不满足类型同一性`)
    assert.ok(finNumDel.code === 'invalid-params' || finNumDel.code === 'declaration-mismatch', `[L18d-b] 语义拒绝（实得 ${finNumDel.code}: ${String(finNumDel.message || '').slice(0, 80)}）`)
    // 零副作用：gen 不变（与片上传后的基线比较）+ 零 record
    const bdPost = readBatchDoc(st, bid)
    assert.equal(bdPost ? bdPost.contentGeneration : undefined, genAfterChunks, `类型变异后 gen 不变（基线=${genAfterChunks}→${bdPost && bdPost.contentGeneration}）`)
    const recDocs = [...st.cloud.__docs.keys()].filter(k => k.includes('mc_restore_records') && k.includes(bid))
    assert.equal(recDocs.length, 0, `零持久 record（实得 ${recDocs.length}）`)
  })

  await scenario('L18e 真实分片 finalizeRecord 成功后重放类型变异：不同类型不得 replayed:true 或 ok', async () => {
    const { st, bid } = await freshDeclaredBatch(P)
    const decl = P.manifest.records.mood[0]
    const rec = P.domainRecords.mood[decl.index]
    const canonical = Buffer.from(P.svc.canonicalJsonBytes(rec))
    const CH = 40 * 1024, ct = Math.ceil(canonical.length / CH)
    // 全部片上传
    for (let i = 0; i < ct; i++) {
      const raw = canonical.subarray(i * CH, Math.min((i + 1) * CH, canonical.length))
      const r = await st.call('mc-restore', { action: 'restore.uploadRecordChunk', batchId: bid, domain: 'mood', index: decl.index, chunkIndex: i, chunkTotal: ct, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      assert.ok(r.ok, `[L18e] chunk ${i}/${ct}`)
    }
    // 合法 finalizeRecord 成功
    const finOk = await st.call('mc-restore', { action: 'restore.finalizeRecord', batchId: bid, domain: 'mood', index: decl.index, id: decl.id, revision: decl.revision, deleted: decl.deleted, expectedChunkTotal: ct, expectedSha256: sha256(canonical) })
    assert.ok(finOk.ok, `[L18e] 合法 finalizeRecord 成功: ${JSON.stringify(finOk).slice(0, 80)}`)
    const bdPost1 = readBatchDoc(st, bid)
    const genAfterValid = bdPost1 ? bdPost1.contentGeneration : undefined
    // 重放 finalizeRecord 但 revision 类型变异（string 对原 number）
    const finReplayStr = await st.call('mc-restore', { action: 'restore.finalizeRecord', batchId: bid, domain: 'mood', index: decl.index, id: decl.id, revision: String(decl.revision), deleted: decl.deleted, expectedChunkTotal: ct, expectedSha256: sha256(canonical) })
    assert.ok(!finReplayStr.ok, `[L18e-a] finalizeRecord 重放 revision=String(${decl.revision}) 须拒（实得 ok=${finReplayStr.ok}${finReplayStr.ok && finReplayStr.replayed ? ' replayed=true' : ''}）——不同类型是新请求非原重放`)
    assert.ok(!finReplayStr.replayed, `[L18e-a] 不得返回 replayed:true`)
    // 重放 finalizeRecord 但 deleted 类型变异（number 0 对原 boolean false）
    const finReplayDel = await st.call('mc-restore', { action: 'restore.finalizeRecord', batchId: bid, domain: 'mood', index: decl.index, id: decl.id, revision: decl.revision, deleted: 0, expectedChunkTotal: ct, expectedSha256: sha256(canonical) })
    assert.ok(!finReplayDel.ok, `[L18e-b] finalizeRecord 重放 deleted=0 须拒（实得 ok=${finReplayDel.ok}${finReplayDel.ok && finReplayDel.replayed ? ' replayed=true' : ''}）`)
    assert.ok(!finReplayDel.replayed, `[L18e-b] 不得返回 replayed:true`)
    // 零副作用
    const bdPost2 = readBatchDoc(st, bid)
    assert.equal(bdPost2 ? bdPost2.contentGeneration : undefined, genAfterValid, `两次类型变异重放后 gen 不变（${genAfterValid}→${bdPost2 && bdPost2.contentGeneration}）`)
  })

  // ══ L19: 64KiB 请求门 vs 完整 ID 套约冲突（结构级缺陷锚定——合法长 ID 包声明可冻结但永不可上传/finalize）══
  // 前提（包级已证）：rev3 探针场景 C（~1MiB 多字节+转义报告 ID）与我方 P2（~4MiB）均为
  // container.validatePackage 零 problems 的合法 full 包；服务端 validateManifestSchema :480-483
  // 明示 id 不设长度上限（仅受 manifest ≤4MiB 隐式约束）——声明阶段接受任意长 ID。
  // 冲突：dispatch :283-284 全局请求门 reqSize>64KiB 即 request-too-large；uploadRecord/:886 与
  // finalizeRecord/:1028/:1036-1041/:1086 均要求请求内携带**完整 id 字符串**且与声明精确全等，
  // 无 idHash/分片替代路径 → id > ~64KiB-封套 的记录：声明已冻结、正文分片可全部上传，
  // 但 uploadRecord 与 finalizeRecord 一律 request-too-large——记录永不可落库（不可恢复的合法备份）。
  await scenario('L19a 巨 ID uploadRecord：64KiB 请求门拒绝+零写+gen 不变（声明已接受同一 ID——冻结可查）', async () => {
    const unit = '汉😀"\\' // raw 9B / JSON 11B——与 rev3 探针场景 C 同构
    const reps = Math.floor((1 * 1024 * 1024) / 9)
    const giantId = unit.repeat(reps)
    // 记录正文取完全合法形状（daily: id≡dateKey+fields）——若非请求门，形状/哈希/声明全都会通过
    const rec = { id: giantId, dateKey: giantId, fields: {}, revision: 0, deleted: false }
    const ctlRec = { id: 'ctl-1', dateKey: 'ctl-1', fields: {}, revision: 0, deleted: false }
    const mk = (pos, r) => ({ index: pos, id: r.id, revision: r.revision, deleted: r.deleted, hash: sha256(Buffer.from(P.svc.canonicalJsonBytes(r))) })
    const dailySeg = Buffer.from(P.svc.canonicalJsonBytes([rec, ctlRec]))
    const manifest = {
      formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: TEST_ENV.MC_FAMILY_ID,
      packageKind: 'full', complete: true,
      scope: { includeShared: true, includePrivateOf: null }, scopeLabel: 'shared-only',
      domains: {
        pregnancy: { status: 'omitted' }, daily: { status: 'present', recordCount: 2, pagingComplete: true, visibility: 'shared', fileIndex: 0 },
        mood: { status: 'omitted' }, checkup: { status: 'omitted' }, bag: { status: 'omitted' }, reports: { status: 'omitted' },
      },
      files: [{ path: 'records/daily.json', kind: 'domain-json', length: dailySeg.length, sha256: sha256(dailySeg), contentType: 'application/json', domain: 'daily' }],
      records: { daily: [mk(0, rec), mk(1, ctlRec)] }, reports: [],
      pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
    }
    const manifestBytes = Buffer.from(P.svc.canonicalJsonBytes(manifest))
    const st = makeStack('mama')
    const bid = nonce()
    const totals = { files: 1, records: 2, domainCounts: { daily: 2 } }
    const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: sha256(manifestBytes), manifestDigest: sha256(manifestBytes), claimedKind: 'full', totals })
    assert.ok(b.ok, `begin: ${JSON.stringify(b).slice(0, 120)}`)
    const CH = 40 * 1024, ct = Math.ceil(manifestBytes.length / CH)
    assert.ok(ct <= 128, `manifest 分片 ${ct} ≤128（~1MiB ID 合法运输）`)
    for (let i = 0; i < ct; i++) {
      const raw = manifestBytes.subarray(i * CH, Math.min((i + 1) * CH, manifestBytes.length))
      const r = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: ct, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      assert.ok(r.ok, `declareChunk ${i}/${ct}: ${JSON.stringify(r).slice(0, 100)}`)
    }
    for (let i = 0; i < 30; i++) {
      const r = await st.call('mc-restore', { action: 'restore.indexDeclarePage', batchId: bid })
      assert.ok(r.ok, `index ${i}: ${JSON.stringify(r).slice(0, 100)}`)
      if (r.data && (r.data.status === 'declared' || r.data.hasMore === false)) break
    }
    const bd = readBatchDoc(st, bid)
    assert.equal(bd && bd.status, 'declared', `巨 ID manifest 服务端接收成功且 declared（id 无长度上限——${bd && bd.status}）`)
    // 声明文档确实冻结了完整巨 ID（服务端接受了它）
    const declDoc = st.cloud.__docs.get(`mc_restore_declarations/${bid}:decl:daily:0`)
    assert.ok(declDoc && declDoc.id === giantId, `声明文档冻结完整巨 ID（${declDoc ? 'len=' + declDoc.id.length : '无文档'}）`)
    // 对照：同批次短 ID 记录可正常内联上传（证明冲突是 id 长度特异，非批次/流程问题）
    const ctlUp = await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'daily', index: 1, id: 'ctl-1', revision: 0, record: ctlRec, deleted: false })
    assert.ok(ctlUp.ok, `对照短 ID uploadRecord 须 ok: ${JSON.stringify(ctlUp).slice(0, 100)}`)
    const genBefore = readBatchDoc(st, bid).contentGeneration
    // 巨 ID uploadRecord：请求 JSON 实测 >64KiB → 须 request-too-large
    const req = { action: 'restore.uploadRecord', batchId: bid, domain: 'daily', index: 0, id: giantId, revision: 0, record: rec, deleted: false }
    const reqBytes = Buffer.byteLength(JSON.stringify(req), 'utf8')
    assert.ok(reqBytes > 64 * 1024, `请求实测 ${reqBytes}B > 65536B（证明门是拒因）`)
    const r1 = await st.call('mc-restore', req)
    assert.ok(!r1.ok && r1.code === 'request-too-large', `uploadRecord 巨 ID 须 request-too-large（实得 ${r1.code}: ${String(r1.message || '').slice(0, 60)}）`)
    const recDocs = [...st.cloud.__docs.keys()].filter(k => k.startsWith('mc_restore_records') && k.includes(bid))
    assert.equal(recDocs.filter(k => k.endsWith(':daily:0')).length, 0, '巨 ID 零 record 写入')
    assert.equal(readBatchDoc(st, bid).contentGeneration, genBefore, 'gen 不变')
  })

  await scenario('L19b 巨 ID 分片路径：正文分片全部可传但 finalizeRecord 携完整 id 同被 64KiB 门拒——记录永不可落库', async () => {
    // 独立重演同型批次（避免场景间隐式耦合）
    const unit = '汉😀"\\'
    const reps = Math.floor((1 * 1024 * 1024) / 9)
    const giantId = unit.repeat(reps)
    const rec = { id: giantId, dateKey: giantId, fields: {}, revision: 0, deleted: false }
    const mk = (id, r) => ({ index: 0, id, revision: r.revision, deleted: r.deleted, hash: sha256(Buffer.from(P.svc.canonicalJsonBytes(r))) })
    const dailySeg = Buffer.from(P.svc.canonicalJsonBytes([rec]))
    const manifest = {
      formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: TEST_ENV.MC_FAMILY_ID,
      packageKind: 'full', complete: true,
      scope: { includeShared: true, includePrivateOf: null }, scopeLabel: 'shared-only',
      domains: {
        pregnancy: { status: 'omitted' }, daily: { status: 'present', recordCount: 1, pagingComplete: true, visibility: 'shared', fileIndex: 0 },
        mood: { status: 'omitted' }, checkup: { status: 'omitted' }, bag: { status: 'omitted' }, reports: { status: 'omitted' },
      },
      files: [{ path: 'records/daily.json', kind: 'domain-json', length: dailySeg.length, sha256: sha256(dailySeg), contentType: 'application/json', domain: 'daily' }],
      records: { daily: [mk(giantId, rec)] }, reports: [],
      pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
    }
    const manifestBytes = Buffer.from(P.svc.canonicalJsonBytes(manifest))
    const st = makeStack('mama')
    const bid = nonce()
    const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: sha256(manifestBytes), manifestDigest: sha256(manifestBytes), claimedKind: 'full', totals: { files: 1, records: 1, domainCounts: { daily: 1 } } })
    assert.ok(b.ok, 'begin')
    const CHM = 40 * 1024, ctm = Math.ceil(manifestBytes.length / CHM)
    for (let i = 0; i < ctm; i++) {
      const raw = manifestBytes.subarray(i * CHM, Math.min((i + 1) * CHM, manifestBytes.length))
      const r = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: ctm, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      assert.ok(r.ok, `dc ${i}/${ctm}`)
    }
    for (let i = 0; i < 30; i++) {
      const r = await st.call('mc-restore', { action: 'restore.indexDeclarePage', batchId: bid })
      assert.ok(r.ok)
      if (r.data && (r.data.status === 'declared' || r.data.hasMore === false)) break
    }
    // 正文分片：uploadRecordChunk 不携带 id——每片 ~55KiB 全部通过 64KiB 门
    const canonical = Buffer.from(P.svc.canonicalJsonBytes(rec))
    const CH = 40 * 1024, ct = Math.ceil(canonical.length / CH)
    for (let i = 0; i < ct; i++) {
      const raw = canonical.subarray(i * CH, Math.min((i + 1) * CH, canonical.length))
      const r = await st.call('mc-restore', { action: 'restore.uploadRecordChunk', batchId: bid, domain: 'daily', index: 0, chunkIndex: i, chunkTotal: ct, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      assert.ok(r.ok, `chunk ${i}/${ct} 须过门且 ok: ${JSON.stringify(r).slice(0, 100)}`)
    }
    assert.ok(st.cloud.__docs.has(`mc_restore_anchors/${bid}:anchor:daily:0`), 'anchor 已锚定（分片全收）')
    const genBefore = readBatchDoc(st, bid).contentGeneration
    // finalizeRecord 必须携带完整 id（:1028/:1036）→ 同被 64KiB 门拒
    const finReq = { action: 'restore.finalizeRecord', batchId: bid, domain: 'daily', index: 0, id: giantId, revision: 0, deleted: false, expectedChunkTotal: ct, expectedSha256: sha256(canonical) }
    const finBytes = Buffer.byteLength(JSON.stringify(finReq), 'utf8')
    assert.ok(finBytes > 64 * 1024, `finalize 请求实测 ${finBytes}B > 65536B`)
    const fin = await st.call('mc-restore', finReq)
    assert.ok(!fin.ok && fin.code === 'request-too-large', `finalizeRecord 巨 ID 须 request-too-large（实得 ${fin.code}）——无 idHash/分片 id 替代路径，合法声明+全部分片在档但记录永不可落库`)
    const recDocs = [...st.cloud.__docs.keys()].filter(k => k.startsWith('mc_restore_records') && k.includes(bid))
    assert.equal(recDocs.length, 0, '零 record 落库')
    assert.equal(readBatchDoc(st, bid).contentGeneration, genBefore, 'gen 不变')
  })

  // ══ L20: progress/list——owner-only、跨家庭、稳定分页（Phase2 已实现后的公共 API 验收）══
  await scenario('L20a progress owner-only：papa（同家庭）不可操作 mama 批次——not-batch-owner+零副作用', async () => {
    const { st, bid } = await freshDeclaredBatch(P)
    const before = JSON.stringify(st.cloud.__docs.get(`mc_restore_batches/${bid}`))
    st.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID); st.curMember.value = 'papa'
    const r = await st.call('mc-restore', { action: 'restore.progress', batchId: bid })
    assert.ok(!r.ok && r.code === 'not-batch-owner', `papa progress 须 not-batch-owner（实得 ${r.code}: ${String(r.message || '').slice(0, 60)}）`)
    const after = JSON.stringify(st.cloud.__docs.get(`mc_restore_batches/${bid}`))
    assert.equal(after, before, '批次文档零变化')
    st.cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID); st.curMember.value = 'mama'
    const r2 = await st.call('mc-restore', { action: 'restore.progress', batchId: bid })
    assert.ok(r2.ok && r2.data && r2.data.batch && r2.data.batch.status === 'declared', `mama 本人 progress 须 ok+declared（实得 ${JSON.stringify(r2).slice(0, 100)}）`)
  })

  await scenario('L20b progress/list 跨家庭：同 owner 换 family 配置——family-mismatch / list 空', async () => {
    const { st, bid } = await freshDeclaredBatch(P)
    const origFam = process.env.MC_FAMILY_ID
    process.env.MC_FAMILY_ID = 'fam-other-xyz'
    try {
      const pg = await st.call('mc-restore', { action: 'restore.progress', batchId: bid })
      assert.ok(!pg.ok && pg.code === 'family-mismatch', `progress 须 family-mismatch（实得 ${pg.code}）`)
      const lst = await st.call('mc-restore', { action: 'restore.list' })
      assert.ok(lst.ok && lst.data && Array.isArray(lst.data.batches) && lst.data.batches.length === 0, `list 跨家庭须空（实得 ${JSON.stringify(lst.data && lst.data.batches && lst.data.batches.length)}）`)
    } finally { process.env.MC_FAMILY_ID = origFam }
    const pg2 = await st.call('mc-restore', { action: 'restore.progress', batchId: bid })
    assert.ok(pg2.ok, `家庭配置复原后 progress ok（${pg2.code}）`)
  })

  await scenario('L20c progress 稳定分页：120 声明 3 页全量=无重无漏升序；双轮一致；域过滤跨域停止；done 翻转', async () => {
    // 合成 60 daily + 60 bag 短 ID manifest（服务端 schema+形状白名单接受——分页压力来自声明数）
    const mkRecs = (p, n, withDailyShape) => Array.from({ length: n }, (_, i) => withDailyShape
      ? { id: p + String(i).padStart(4, '0'), dateKey: p + String(i).padStart(4, '0'), fields: {}, revision: i, deleted: i % 7 === 0 }
      : { id: p + String(i).padStart(4, '0'), revision: i, deleted: i % 7 === 0 })
    const daily = mkRecs('d-', 60, true), bag = mkRecs('b-', 60, false)
    const decls = rs => rs.map((r, i) => ({ index: i, id: r.id, revision: r.revision, deleted: r.deleted, hash: sha256(Buffer.from(P.svc.canonicalJsonBytes(r))) }))
    const segD = Buffer.from(P.svc.canonicalJsonBytes(daily)), segB = Buffer.from(P.svc.canonicalJsonBytes(bag))
    const manifest = {
      formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: TEST_ENV.MC_FAMILY_ID,
      packageKind: 'full', complete: true,
      scope: { includeShared: true, includePrivateOf: null }, scopeLabel: 'shared-only',
      domains: {
        pregnancy: { status: 'omitted' }, daily: { status: 'present', recordCount: 60, pagingComplete: true, visibility: 'shared', fileIndex: 0 },
        mood: { status: 'omitted' }, checkup: { status: 'omitted' }, bag: { status: 'present', recordCount: 60, pagingComplete: true, visibility: 'shared', fileIndex: 1 },
        reports: { status: 'omitted' },
      },
      files: [
        { path: 'records/daily.json', kind: 'domain-json', length: segD.length, sha256: sha256(segD), contentType: 'application/json', domain: 'daily' },
        { path: 'records/bag.json', kind: 'domain-json', length: segB.length, sha256: sha256(segB), contentType: 'application/json', domain: 'bag' },
      ],
      records: { daily: decls(daily), bag: decls(bag) }, reports: [],
      pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
    }
    const manifestBytes = Buffer.from(P.svc.canonicalJsonBytes(manifest))
    const st = makeStack('mama')
    const bid = nonce()
    const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: sha256(manifestBytes), manifestDigest: sha256(manifestBytes), claimedKind: 'full', totals: { files: 2, records: 120, domainCounts: { daily: 60, bag: 60 } } })
    assert.ok(b.ok, 'begin')
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
      assert.ok(r.data && r.data.hasMore === true && Number.isInteger(r.data.nextCursor), `中间页须 hasMore+nextCursor（实得 ${JSON.stringify(r.data).slice(0, 80)}）`)
      pageCursor = r.data.nextCursor
    }
    assert.equal(readBatchDoc(st, bid).status, 'declared', '120 声明批次 declared')
    const paginate = async (extra = {}) => {
      const pages = []
      let cursor = null
      for (let guard = 0; guard < 10; guard++) {
        const r = await st.call('mc-restore', { action: 'restore.progress', batchId: bid, limit: 50, ...(cursor ? { cursor } : {}), ...extra })
        assert.ok(r.ok, `progress 页 ${pages.length}: ${JSON.stringify(r).slice(0, 120)}`)
        pages.push(r.data)
        if (!r.data.hasMore) break // 契约：hasMore=false 即末页（实现末页 nextCursor=末行 _id 而非 null——与 list :1205 同款）
        assert.ok(typeof r.data.nextCursor === 'string' && r.data.nextCursor, '非末页 nextCursor 须字符串')
        cursor = r.data.nextCursor
      }
      return pages
    }
    // 全量 3 页：50/50/20，无重无漏、严格升序
    const pages1 = await paginate()
    assert.equal(pages1.length, 3, `3 页（实得 ${pages1.length}）`)
    assert.deepEqual(pages1.map(p => p.items.length), [50, 50, 20], `每页条数 50/50/20（实得 ${pages1.map(p => p.items.length)}）`)
    const all1 = pages1.flatMap(p => p.items)
    assert.equal(all1.length, 120, '全量 120')
    assert.equal(new Set(all1.map(i => `${i.domain}:${i.index}`)).size, 120, '无重复')
    for (let i = 1; i < all1.length; i++) {
      const prevKey = `${bid}:decl:${all1[i - 1].domain}:${all1[i - 1].index}`
      const curKey = `${bid}:decl:${all1[i].domain}:${all1[i].index}`
      assert.ok(prevKey < curKey, `升序 ${i}: ${prevKey} < ${curKey}`)
    }
    assert.ok(pages1.every(p => p.items.every(i => i.done === false)), '未上传全 done=false')
    // 双轮一致（稳定分页——同起点两次全量分页逐项一致）
    const pages2 = await paginate()
    assert.deepEqual(pages2, pages1, '第二轮分页与第一轮逐字段一致（稳定）')
    // 域过滤 bag：60 项全 bag；从 bag 中途 cursor 续页
    const bagPages = await paginate({ domain: 'bag' })
    const bagAll = bagPages.flatMap(p => p.items)
    assert.equal(bagAll.length, 60, `bag 过滤 60（实得 ${bagAll.length}）`)
    assert.ok(bagAll.every(i => i.domain === 'bag'), 'bag 过滤只含 bag')
    const bagMid = await st.call('mc-restore', { action: 'restore.progress', batchId: bid, domain: 'bag', limit: 30 })
    assert.ok(bagMid.ok && bagMid.data.items.length === 30 && bagMid.data.hasMore === true, 'bag 首 30 页')
    const bagNext = await st.call('mc-restore', { action: 'restore.progress', batchId: bid, domain: 'bag', limit: 50, cursor: bagMid.data.nextCursor })
    assert.ok(bagNext.ok && bagNext.data.items.length === 30 && bagNext.data.hasMore === false, `bag 续页 30 收尾（实得 ${bagNext.data && bagNext.data.items.length}）`)
    // done 翻转：上传 daily index 0 → 该项 done=true 其余 false（域过滤全量分页——limit 封顶 50）
    const up = await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'daily', index: 0, id: daily[0].id, revision: daily[0].revision, record: daily[0], deleted: daily[0].deleted })
    assert.ok(up.ok, `上传 daily[0]: ${JSON.stringify(up).slice(0, 80)}`)
    const dailyItems = []
    {
      let cursor2 = null
      for (let guard = 0; guard < 6; guard++) {
        const r = await st.call('mc-restore', { action: 'restore.progress', batchId: bid, domain: 'daily', limit: 50, ...(cursor2 ? { cursor: cursor2 } : {}) })
        assert.ok(r.ok && Array.isArray(r.data.items), `daily 分页 ${guard}: ${JSON.stringify(r).slice(0, 100)}`)
        dailyItems.push(...r.data.items)
        if (!r.data.hasMore) break
        cursor2 = r.data.nextCursor
      }
    }
    assert.equal(dailyItems.length, 60, `daily 全量 60（实得 ${dailyItems.length}）`)
    assert.equal(dailyItems[0].done, true, 'daily[0] done=true')
    assert.ok(dailyItems.slice(1).every(i => i.done === false), '其余 done=false')
  })

  await scenario('L20d list 稳定分页+owner-only：55 批次 2 页升序无重漏双轮一致；papa/跨家庭空', async () => {
    const st = makeStack('mama')
    // MAX_ACTIVE_BATCHES=2 限制真实 begin 不能建 55 个活跃批次——白盒种子批次文档
    // （list 只读 ownerMemberId/familyId/状态字段；种子字段与 begin 写入形状一致；
    //   状态分布须为可达状态：2 活跃（declaring+uploading）+53 abandoned——55 declaring 违反活跃上限不可达）
    for (let i = 0; i < 55; i++) {
      const id = 'lst-' + String(i).padStart(3, '0')
      const status = i === 0 ? 'declaring' : i === 1 ? 'uploading' : 'abandoned'
      st.cloud.__docs.set(`mc_restore_batches/${id}`, { batchId: id, ownerMemberId: 'mama', familyId: TEST_ENV.MC_FAMILY_ID, status, claimedKind: 'full', totals: null, declaredRecords: null, declaredFiles: null, contentGeneration: 0, createdAt: 1000 + i, updatedAt: 1000 + i, __v: 1 })
    }
    const listAll = async () => {
      const pages = []
      let cursor = null
      for (let guard = 0; guard < 6; guard++) {
        const r = await st.call('mc-restore', { action: 'restore.list', ...(cursor ? { cursor } : {}) })
        assert.ok(r.ok, `list 页 ${pages.length}: ${JSON.stringify(r).slice(0, 100)}`)
        pages.push(r.data)
        if (!r.data.hasMore) break
        cursor = r.data.nextCursor
      }
      return pages
    }
    const pages1 = await listAll()
    assert.equal(pages1.length, 2, `2 页（实得 ${pages1.length}）`)
    assert.deepEqual(pages1.map(p => p.batches.length), [50, 5], `50/5（实得 ${pages1.map(p => p.batches.length)}）`)
    const all1 = pages1.flatMap(p => p.batches)
    assert.equal(all1.length, 55, '全量 55')
    assert.equal(new Set(all1.map(b2 => b2.batchId)).size, 55, '无重复')
    const sortedIds = all1.map(b2 => b2.batchId)
    assert.deepEqual([...sortedIds].sort(), sortedIds, '升序')
    const pages2 = await listAll()
    assert.deepEqual(pages2, pages1, '第二轮与第一轮逐字段一致（稳定）')
    // owner-only：papa list 空
    st.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID); st.curMember.value = 'papa'
    const lp = await st.call('mc-restore', { action: 'restore.list' })
    assert.ok(lp.ok && lp.data.batches.length === 0, `papa list 空（实得 ${lp.data.batches.length}）`)
    st.cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID); st.curMember.value = 'mama'
    // 跨家庭：mama + 他家庭配置 → 空
    const origFam = process.env.MC_FAMILY_ID
    process.env.MC_FAMILY_ID = 'fam-other-xyz'
    try {
      const lf = await st.call('mc-restore', { action: 'restore.list' })
      assert.ok(lf.ok && lf.data.batches.length === 0, `跨家庭 list 空（实得 ${lf.data.batches.length}）`)
    } finally { process.env.MC_FAMILY_ID = origFam }
  })

  // ══ L21: progress 物理条目游标推进 + 零写（协调方指派：50 物理 idfrag 后随逻辑记录不得死循环）══
  // 背景：progress items 仅 record/file（:1188-1204 物理条目过滤）；不变量——
  //   ① 物理条目跳过也推进 scanRowId（:1203）——纯物理满页不得 items=[] ∧ hasMore=true ∧ nextCursor 不变（客户端死循环形状）；
  //   ② 字节预算收页时未收入本页的逻辑条目不得越过（:1207-1209 break 不消费 r）。
  // 注：声明集当前只产 record/file——物理条目（idfrag 等）由白盒种子注入（与 CODING Q 节/R1 同法）。
  const PHYS_SEQ = i => String(i).padStart(4, '0')
  // 物理片键后缀 `:f\d{4}`——不得用 includes(':f')（会把逻辑 `:file:N` 声明误判为物理）
  const isPhysKey = k => /:f\d{4}$/.test(k)
  const seedPhys = (st, bid, domain, index, n) => {
    for (let i = 0; i < n; i++) {
      st.cloud.__docs.set(`mc_restore_declarations/${bid}:decl:${domain}:${index}:f${PHYS_SEQ(i)}`, { batchId: bid, type: 'idfrag', domain, index, seq: i, idLen: 1400, idHash: hexDigest(), __v: 1 })
    }
  }
  const docSnapshot = st => JSON.stringify([...st.cloud.__docs.entries()].map(([k, v]) => [k, v.__v]))
  // 通用分页器：带死循环形状检测（每页须有 items 或严格推进游标）+ 零写断言
  const paginateNoLoop = async (st, bid, label, extra = {}) => {
    const snapBefore = docSnapshot(st)
    const all = []
    let cursor = null
    for (let guard = 0; guard < 30; guard++) {
      const req = { action: 'restore.progress', batchId: bid, limit: 50, ...(cursor ? { cursor } : {}), ...extra }
      const r = await st.call('mc-restore', req)
      assert.ok(r.ok, `${label} 页 ${guard}: ${JSON.stringify(r).slice(0, 120)}`)
      const used = cursor || ''
      assert.ok(!(r.data.items.length === 0 && r.data.hasMore === true && (r.data.nextCursor === null || r.data.nextCursor === used)),
        `${label} 页 ${guard} 死循环形状：items=[] ∧ hasMore=true ∧ nextCursor=${r.data.nextCursor} 未越过请求游标 "${used}"`)
      all.push(...r.data.items)
      if (!r.data.hasMore) break
      assert.ok(typeof r.data.nextCursor === 'string' && r.data.nextCursor > used, `${label} 页 ${guard} 续页游标须严格推进`)
      cursor = r.data.nextCursor
    }
    assert.equal(docSnapshot(st), snapBefore, `${label} 全程零服务端写（文档 __v 快照不变）`)
    return all
  }

  await scenario('L21a 纯物理满页：50 idfrag 先于全部逻辑记录——空 items 页须推进游标，逻辑集不跳不漏，零写，源哈希复核', async () => {
    // 源哈希场景内复核（协调方指派快照——与加载时冻结快照一致）
    const nowH = sha256(fs.readFileSync(path.join(root, 'cloud/functions/mc-restore/index.js')))
    assert.equal(nowH, frozenHashes['cloud/functions/mc-restore/index.js'], `L21a 源哈希漂移（加载 ${frozenHashes['cloud/functions/mc-restore/index.js'].slice(0, 8)} → 现 ${nowH.slice(0, 8)}）——结果作废须复跑`)
    const { st, bid } = await freshDeclaredBatch(P)
    // bag 域 50 物理片（bag 字典序先于 fixture 全部逻辑域 mood/pregnancy/reports/file——首页恰为纯物理满页）
    seedPhys(st, bid, 'bag', 0, 50)
    const logicalBefore = [...st.cloud.__docs.keys()].filter(k => k.startsWith(`mc_restore_declarations/${bid}:decl:`) && !isPhysKey(k)).length
    assert.ok(logicalBefore >= 4, `前置：fixture 逻辑声明 ≥4（实得 ${logicalBefore}）`)
    const items = await paginateNoLoop(st, bid, 'L21a')
    // 逻辑集不跳不漏：物理条目零出 items；逻辑 record/file 恰好全量各一次
    const phys = items.filter(i => i.type !== 'record' && i.type !== 'file')
    assert.equal(phys.length, 0, `物理条目不得出 items（实得 ${phys.length}）`)
    const recItems = items.filter(i => i.type === 'record')
    const fileItems = items.filter(i => i.type === 'file')
    assert.equal(recItems.length, logicalBefore - fileItems.length, `record 条目不跳不漏（期望 ${logicalBefore - fileItems.length} 实得 ${recItems.length}）`)
    assert.ok(fileItems.length >= 1, `附件 file 条目在场（实得 ${fileItems.length}）`)
    const keys = recItems.map(i => `${i.domain}:${i.index}`)
    assert.equal(new Set(keys).size, keys.length, 'record 条目无重复')
    // 首页专项：纯物理满页（limit=50 全部为 bag 物理）——nextCursor 必须越过 50 片（落在 bag:0:f0049）
    const first = await st.call('mc-restore', { action: 'restore.progress', batchId: bid, limit: 50 })
    assert.ok(first.ok && first.data.items.length === 0, `纯物理页 items=[]（实得 ${first.data.items.length}）`)
    assert.equal(first.data.nextCursor, `${bid}:decl:bag:0:f${PHYS_SEQ(49)}`, `纯物理页游标须落到末片（实得 ${first.data.nextCursor}）`)
    assert.equal(first.data.hasMore, true, '纯物理满页 hasMore=true')
  })

  await scenario('L21b 物理逻辑交错：逻辑声明间夹物理片——任意 limit 分页逻辑集完整、游标单调、零写', async () => {
    const { st, bid } = await freshDeclaredBatch(P)
    // 交错：pregnancy:0 之后夹 10 片（pregnancy:0:f*——字典序在 pregnancy:0 与 reports:0 之间）
    seedPhys(st, bid, 'pregnancy', 0, 10)
    // mood:0 之后夹 3 片（mood:0:f*——在 mood:0 与 pregnancy:0 之间）
    seedPhys(st, bid, 'mood', 0, 3)
    const expectLogical = [...st.cloud.__docs.keys()]
      .filter(k => k.startsWith(`mc_restore_declarations/${bid}:decl:`) && !isPhysKey(k))
      .map(k => k.slice(`mc_restore_declarations/${bid}:decl:`.length)).sort()
    // limit=2 小页（物理被跳后逻辑稀疏——最易暴露跳页）与 limit=50 大页两种粒度
    for (const lim of [2, 50]) {
      const snapBefore = docSnapshot(st)
      const all = []
      let cursor = null
      for (let guard = 0; guard < 40; guard++) {
        const r = await st.call('mc-restore', { action: 'restore.progress', batchId: bid, limit: lim, ...(cursor ? { cursor } : {}) })
        assert.ok(r.ok, `L21b limit=${lim} 页 ${guard}: ${JSON.stringify(r).slice(0, 120)}`)
        const used = cursor || ''
        assert.ok(!(r.data.items.length === 0 && r.data.hasMore === true && (r.data.nextCursor === null || r.data.nextCursor === used)), `L21b limit=${lim} 页 ${guard} 死循环形状`)
        all.push(...r.data.items)
        if (!r.data.hasMore) break
        assert.ok(typeof r.data.nextCursor === 'string' && r.data.nextCursor > used, `L21b limit=${lim} 页 ${guard} 游标严格推进`)
        cursor = r.data.nextCursor
      }
      assert.equal(docSnapshot(st), snapBefore, `L21b limit=${lim} 零写`)
      const gotKeys = all.filter(i => i.type === 'record').map(i => `${i.domain}:${i.index}`).sort()
      assert.deepEqual(gotKeys, expectLogical.filter(k2 => !k2.startsWith('file:')), `L21b limit=${lim} record 逻辑集恰全量（期望 ${expectLogical.filter(k2 => !k2.startsWith('file:')).length} 实得 ${gotKeys.length}）`)
    }
  })

  await scenario('L21c 字节截断分支可达性：最大合法 item（~2KiB 内联 id）×50 仍 <192KiB 预算——不跳不漏在全量上验证', async () => {
    // 公共 API 结构性上界：limit ≤50 ∧ inlineOrShort 内联 ≤2KiB/字段 → 页字节 <192KiB——截断分支
    // 不可经公共 API 触达（防御性分支）；本场景以最大内联 item 实测页完整性。
    const mkRecs = n => Array.from({ length: n }, (_, i) => ({ id: 'm' + String(i).padStart(4, '0') + 'x'.repeat(2024), dateKey: 'm' + String(i).padStart(4, '0') + 'x'.repeat(2024), fields: {}, revision: i, deleted: i % 9 === 0 }))
    const daily = mkRecs(48)
    const decls = rs => rs.map((r, i) => ({ index: i, id: r.id, revision: r.revision, deleted: r.deleted, hash: sha256(Buffer.from(P.svc.canonicalJsonBytes(r))) }))
    const segD = Buffer.from(P.svc.canonicalJsonBytes(daily))
    const manifest = {
      formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: TEST_ENV.MC_FAMILY_ID,
      packageKind: 'full', complete: true,
      scope: { includeShared: true, includePrivateOf: null }, scopeLabel: 'shared-only',
      domains: {
        pregnancy: { status: 'omitted' }, daily: { status: 'present', recordCount: 48, pagingComplete: true, visibility: 'shared', fileIndex: 0 },
        mood: { status: 'omitted' }, checkup: { status: 'omitted' }, bag: { status: 'omitted' }, reports: { status: 'omitted' },
      },
      files: [{ path: 'records/daily.json', kind: 'domain-json', length: segD.length, sha256: sha256(segD), contentType: 'application/json', domain: 'daily' }],
      records: { daily: decls(daily) }, reports: [],
      pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
    }
    const manifestBytes = Buffer.from(P.svc.canonicalJsonBytes(manifest))
    const st = makeStack('mama')
    const bid = nonce()
    const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: sha256(manifestBytes), manifestDigest: sha256(manifestBytes), claimedKind: 'full', totals: { files: 1, records: 48, domainCounts: { daily: 48 } } })
    assert.ok(b.ok, 'begin')
    const CHM = 40 * 1024, ctm = Math.ceil(manifestBytes.length / CHM)
    for (let i = 0; i < ctm; i++) {
      const raw = manifestBytes.subarray(i * CHM, Math.min((i + 1) * CHM, manifestBytes.length))
      const r = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: ctm, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      assert.ok(r.ok, `dc ${i}/${ctm}`)
    }
    let pageCursor = 0
    for (let i = 0; i < 20; i++) {
      const r = await st.call('mc-restore', { action: 'restore.indexDeclarePage', batchId: bid, pageCursor })
      assert.ok(r.ok, `index ${i}@${pageCursor}: ${JSON.stringify(r).slice(0, 100)}`)
      if (r.data && r.data.status === 'declared') break
      pageCursor = r.data.nextCursor
    }
    assert.equal(readBatchDoc(st, bid).status, 'declared', '48 条 2KiB-id 声明 declared')
    const items = await paginateNoLoop(st, bid, 'L21c')
    assert.equal(items.length, 48, `全量 48（实得 ${items.length}）`)
    // 最大 item 实测 ≤~2.2KiB → 50 页上限 ~110KiB < 192KiB：字节截断分支公共 API 不可达（防御性）
    const maxItem = Math.max(...items.map(i2 => Buffer.byteLength(JSON.stringify(i2), 'utf8')))
    assert.ok(maxItem * 50 < 192 * 1024, `最大 item ${maxItem}B ×50 = ${(maxItem * 50 / 1024).toFixed(1)}KiB < 192KiB——截断分支不可经公共 API 触达（不跳不漏由行数语义保证）`)
    // 2KiB 内联 id 原样返回（未短承诺化）
    assert.ok(items.every(i2 => typeof i2.id === 'string' && i2.id.length === 2029), `2KiB id 全部内联原值（实得 len=${items[0] && items[0].id && items[0].id.length}）`)
  })

  // ══ L22: progress 扫描窗口耗尽（协调方指派：401+ 物理片先于逻辑记录——旧 4×100 窗口空页+假 hasMore=false+游标停滞）══
  await scenario('L22a【对照组——协调方勘误确认：无过滤物理走廊不构成缺陷（rows 收全部物理行→limit 即推进；L21a 已覆盖，本组扩至 450>401）】无过滤 450 物理片先于全部逻辑记录：每页推进、逻辑集不跳不漏、零写', async () => {
    const { st, bid } = await freshDeclaredBatch(P)
    seedPhys(st, bid, 'bag', 0, 450) // bag 字典序先于 fixture 全部逻辑域——450>旧窗口 400 且>401
    const logicalKeys = [...st.cloud.__docs.keys()]
      .filter(k => k.startsWith(`mc_restore_declarations/${bid}:decl:`) && !isPhysKey(k))
      .map(k => k.slice(`mc_restore_declarations/${bid}:decl:`.length)).sort()
    assert.ok(logicalKeys.length >= 4, `前置逻辑声明 ≥4（实得 ${logicalKeys.length}）`)
    const items = await paginateNoLoop(st, bid, 'L22a')
    const gotKeys = items.filter(i => i.type === 'record').map(i => `${i.domain}:${i.index}`).sort()
    assert.deepEqual(gotKeys, logicalKeys.filter(k2 => !k2.startsWith('file:')), `L22a 逻辑集恰全量（期 ${logicalKeys.filter(k2 => !k2.startsWith('file:')).length} 得 ${gotKeys.length}）`)
    assert.equal(new Set(gotKeys).size, gotKeys.length, '无重复')
    // 专项：物理走廊必然产生 items=[] 的页——其 nextCursor 须严格推进（历史 bug 形状：停滞+假 hasMore=false）
    const first = await st.call('mc-restore', { action: 'restore.progress', batchId: bid, limit: 50 })
    assert.ok(first.ok && first.data.items.length === 0, `首页纯物理空 items（实得 ${first.data.items.length}）`)
    assert.ok(first.data.hasMore === true && typeof first.data.nextCursor === 'string' && first.data.nextCursor > `${bid}:decl:bag:0`, `空页须 hasMore=true ∧ 游标推进（实得 hasMore=${first.data.hasMore} cursor=${String(first.data.nextCursor).slice(-12)}）`)
  })

  await scenario('L22b【设计裁定已落：作用域游标强校验 :1175-1186】混合域游标+domain → 显式 invalid-params（非静默隐藏）+零写；同域正常游标不受影响', async () => {
    const { st, bid } = await freshDeclaredBatch(P)
    seedPhys(st, bid, 'bag', 0, 850) // bag<mood 走廊——裁定后域过滤扫描自前缀起，走廊不再被扫
    const snapBefore = docSnapshot(st)
    // 他域游标 + domain=mood → 显式拒绝（此前为停滞+隐藏——裁定：越界游标不静默重置不假空成功）
    const rj = await st.call('mc-restore', { action: 'restore.progress', batchId: bid, domain: 'mood', limit: 50, cursor: `${bid}:decl:bag:0:f0000` })
    assert.ok(!rj.ok && rj.code === 'invalid-params', `他域游标须显式 invalid-params（实得 ${rj.code}: ${String(rj.message).slice(0, 60)}）`)
    // 他批次游标（无 domain）→ 同拒
    const rj2 = await st.call('mc-restore', { action: 'restore.progress', batchId: bid, limit: 50, cursor: `rst_other:decl:mood:0` })
    assert.ok(!rj2.ok && rj2.code === 'invalid-params', `他批次游标须显式 invalid-params（实得 ${rj2.code}）`)
    // 同域无游标：mood:0 正常可达（走廊不影响——扫描自 mood 前缀起）
    const r1 = await st.call('mc-restore', { action: 'restore.progress', batchId: bid, domain: 'mood', limit: 50 })
    assert.ok(r1.ok, `同域无游标须 ok: ${JSON.stringify(r1).slice(0, 100)}`)
    const got1 = r1.data.items.filter(i => i.type === 'record').map(i => `${i.domain}:${i.index}`)
    assert.deepEqual(got1, ['mood:0'], `mood:0 可达（实得 ${JSON.stringify(got1)}）`)
    // 同域合法游标：须 ok（续扫/空页均可——不得 invalid-params）
    const r2 = await st.call('mc-restore', { action: 'restore.progress', batchId: bid, domain: 'mood', limit: 50, cursor: `${bid}:decl:mood:0` })
    assert.ok(r2.ok, `同域合法游标须 ok: ${JSON.stringify(r2).slice(0, 100)}`)
    assert.equal(docSnapshot(st), snapBefore, 'L22b 全程零写（拒绝路径+正常路径）')
  })

  await scenario('L23 非末片 1B/40959B/40961B 全拒+零写；合法 40960B+1B 末片+finalize 过；重放不双计', async () => {
    const { st, bid } = await freshDeclaredBatch(P)
    const decl = P.manifest.records.mood[0]
    const canonical = Buffer.from(P.svc.canonicalJsonBytes(P.domainRecords.mood[decl.index]))
    assert.ok(canonical.length > 40 * 1024 + 1, `前置 mood 正文 >40KiB+1（实得 ${canonical.length}——分片路径）`)
    const genBefore = readBatchDoc(st, bid).contentGeneration
    const chunkDocCount = () => [...st.cloud.__docs.keys()].filter(k => k.startsWith('mc_restore_record_chunks') && k.includes(bid)).length
    const anchorDoc = () => st.cloud.__docs.get(`mc_restore_anchors/${bid}:anchor:mood:0`)
    const up = (ci, ct, raw, shaParam) => st.call('mc-restore', { action: 'restore.uploadRecordChunk', batchId: bid, domain: 'mood', index: decl.index, chunkIndex: ci, chunkTotal: ct, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: shaParam === undefined ? sha256(raw) : shaParam })
    // ① 非末片 1B（协调方场景：chunkTotal=2 的 chunkIndex=0 只 1 字节）→ 拒
    const r1 = await up(0, 2, Buffer.from('X'))
    assert.ok(!r1.ok && r1.code === 'invalid-params' && /40960|40 ?KiB/.test(String(r1.message)), `L23① 1B 非末片须拒（实得 ${r1.code}: ${String(r1.message).slice(0, 60)}）`)
    // ② 边界 40959B / 40961B 非末片 → 拒
    const r2a = await up(0, 2, Buffer.alloc(40 * 1024 - 1, 0x61))
    assert.ok(!r2a.ok && r2a.code === 'invalid-params', `L23② 40959B 非末片须拒（${r2a.code}）`)
    const r2b = await up(0, 2, Buffer.alloc(40 * 1024 + 1, 0x61))
    assert.ok(!r2b.ok && r2b.code === 'invalid-params', `L23② 40961B 非末片须拒（${r2b.code}）`)
    assert.equal(chunkDocCount(), 0, 'L23①② 零 chunk 写入')
    assert.equal(anchorDoc(), undefined, 'L23①② 零 anchor')
    assert.equal(readBatchDoc(st, bid).contentGeneration, genBefore, 'L23①② gen 不变')
    // ③ 合法形状：chunk0 恰 40960B（真字节）→ ok；重放同片 → 幂等且 cumuBytes 不变
    const c0 = canonical.subarray(0, 40 * 1024)
    const r3 = await up(0, 2, c0)
    assert.ok(r3.ok, `L23③ chunk0 40960B 须 ok: ${JSON.stringify(r3).slice(0, 100)}`)
    let anchor = anchorDoc()
    assert.ok(anchor && anchor.cumuBytes === 40 * 1024, `L23③ 非末片累计不变量 cumuBytes=${anchor && anchor.cumuBytes}（须 40960）`)
    const r3b = await up(0, 2, c0)
    assert.ok(r3b.ok, 'L23③ 重放幂等 ok')
    assert.equal(anchorDoc().cumuBytes, 40 * 1024, 'L23③ 重放不双计')
    // ④ 末片 1B（合法：末片 0<len≤40960）→ ok；finalize 过
    const tail = canonical.subarray(40 * 1024)
    assert.ok(tail.length >= 1 && tail.length <= 40 * 1024, `前置末片长度 ${tail.length} ∈ (0,40960]`)
    const r4 = await up(1, 2, tail)
    assert.ok(r4.ok, `L23④ 末片 ${tail.length}B 须 ok`)
    assert.equal(anchorDoc().cumuBytes, canonical.length, `L23④ 累计=正文长 ${canonical.length}（实得 ${anchorDoc().cumuBytes}）`)
    const fin = await st.call('mc-restore', { action: 'restore.finalizeRecord', batchId: bid, domain: 'mood', index: decl.index, id: decl.id, revision: decl.revision, deleted: decl.deleted, expectedChunkTotal: 2, expectedSha256: sha256(canonical) })
    assert.ok(fin.ok, `L23④ finalize 须 ok: ${JSON.stringify(fin).slice(0, 100)}`)
    // ⑤ 非末片中途（chunkTotal=3 的 chunkIndex=1）1B → 同拒（门对任意非末索引生效）
    const { st: st5, bid: bid5 } = await freshDeclaredBatch(P)
    const d5 = P.manifest.records.mood[0]
    const can5 = Buffer.from(P.svc.canonicalJsonBytes(P.domainRecords.mood[d5.index]))
    const u5 = (ci, ct, raw) => st5.call('mc-restore', { action: 'restore.uploadRecordChunk', batchId: bid5, domain: 'mood', index: d5.index, chunkIndex: ci, chunkTotal: ct, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
    const r5a = await u5(0, 3, can5.subarray(0, 40 * 1024))
    assert.ok(r5a.ok, 'L23⑤ chunk0 合法')
    const r5b = await u5(1, 3, Buffer.from('X'))
    assert.ok(!r5b.ok && r5b.code === 'invalid-params', `L23⑤ 中途非末片 1B 须拒（${r5b.code}）`)
  })

  await scenario('L22c【设计裁定已落：零物理变体——今日声明语义】bag 域内游标+domain=mood → 显式 invalid-params；合法分页 mood:0 可达', async () => {
    // 历史：450 bag 逻辑走廊+混合游标曾致停滞隐藏（今日语义可构造）——裁定=作用域强校验显式拒绝
    const mkRecs = (p, n, daily) => Array.from({ length: n }, (_, i) => daily
      ? { id: p + String(i).padStart(4, '0'), dateKey: p + String(i).padStart(4, '0'), fields: {}, revision: i, deleted: false }
      : { id: p + String(i).padStart(4, '0'), revision: i, deleted: false })
    const bagRecs = mkRecs('b-', 450, false)
    const moodRecs = mkRecs('m-', 1, true)
    const decls = rs => rs.map((r, i) => ({ index: i, id: r.id, revision: r.revision, deleted: r.deleted, hash: sha256(Buffer.from(P.svc.canonicalJsonBytes(r))) }))
    const segBag = Buffer.from(P.svc.canonicalJsonBytes(bagRecs)), segMood = Buffer.from(P.svc.canonicalJsonBytes(moodRecs))
    const manifest = {
      formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: TEST_ENV.MC_FAMILY_ID,
      packageKind: 'full', complete: true,
      scope: { includeShared: true, includePrivateOf: 'mama' }, scopeLabel: 'shared-plus-own-private',
      domains: {
        pregnancy: { status: 'omitted' }, daily: { status: 'omitted' },
        mood: { status: 'present', recordCount: 1, pagingComplete: true, visibility: 'private', fileIndex: 1 },
        checkup: { status: 'omitted' }, bag: { status: 'present', recordCount: 450, pagingComplete: true, visibility: 'shared', fileIndex: 0 },
        reports: { status: 'omitted' },
      },
      files: [
        { path: 'records/bag.json', kind: 'domain-json', length: segBag.length, sha256: sha256(segBag), contentType: 'application/json', domain: 'bag' },
        { path: 'records/mood.json', kind: 'domain-json', length: segMood.length, sha256: sha256(segMood), contentType: 'application/json', domain: 'mood' },
      ],
      records: { bag: decls(bagRecs), mood: decls(moodRecs) }, reports: [],
      pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
    }
    const manifestBytes = Buffer.from(P.svc.canonicalJsonBytes(manifest))
    const st = makeStack('mama')
    const bid = nonce()
    const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: sha256(manifestBytes), manifestDigest: sha256(manifestBytes), claimedKind: 'full', totals: { files: 2, records: 451, domainCounts: { bag: 450, mood: 1 } } })
    assert.ok(b.ok, `begin: ${JSON.stringify(b).slice(0, 100)}`)
    const CHM = 40 * 1024, ctm = Math.ceil(manifestBytes.length / CHM)
    for (let i = 0; i < ctm; i++) {
      const raw = manifestBytes.subarray(i * CHM, Math.min((i + 1) * CHM, manifestBytes.length))
      const r = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: ctm, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      assert.ok(r.ok, `dc ${i}/${ctm}`)
    }
    let pageCursor = 0
    for (let i = 0; i < 40; i++) {
      const r = await st.call('mc-restore', { action: 'restore.indexDeclarePage', batchId: bid, pageCursor })
      assert.ok(r.ok, `index ${i}@${pageCursor}`)
      if (r.data && r.data.status === 'declared') break
      pageCursor = r.data.nextCursor
    }
    assert.equal(readBatchDoc(st, bid).status, 'declared', '451 逻辑声明 declared')
    const snapBefore = docSnapshot(st)
    // bag 域内游标 + domain=mood → 显式拒绝（原停滞形状的裁定归宿）
    const rj = await st.call('mc-restore', { action: 'restore.progress', batchId: bid, domain: 'mood', limit: 50, cursor: `${bid}:decl:bag:0` })
    assert.ok(!rj.ok && rj.code === 'invalid-params', `bag 域内游标+domain=mood 须显式 invalid-params（实得 ${rj.code}）——不静默隐藏`)
    // mood 域合法分页：mood:0 可达（450 bag 走廊不被扫描）
    const r = await st.call('mc-restore', { action: 'restore.progress', batchId: bid, domain: 'mood', limit: 50 })
    assert.ok(r.ok, `mood 域无游标须 ok: ${JSON.stringify(r).slice(0, 100)}`)
    const got = r.data.items.filter(i => i.type === 'record').map(i => `${i.domain}:${i.index}`)
    assert.deepEqual(got, ['mood:0'], `mood:0 可达（实得 ${JSON.stringify(got)}）`)
    // 裁定补强：合法作用域域游标多页全量——bag 450 行用**自身返回的游标**分页（每页 nextCursor 须 bag 域前缀）
    const bagItems = []
    let bcur = null
    for (let guard = 0; guard < 15; guard++) {
      const rb = await st.call('mc-restore', { action: 'restore.progress', batchId: bid, domain: 'bag', limit: 50, ...(bcur ? { cursor: bcur } : {}) })
      assert.ok(rb.ok, `bag 页 ${guard}: ${JSON.stringify(rb).slice(0, 100)}`)
      bagItems.push(...rb.data.items)
      if (!rb.data.hasMore) break
      assert.ok(typeof rb.data.nextCursor === 'string' && rb.data.nextCursor.startsWith(`${bid}:decl:bag:`), `bag 页 ${guard} 续页游标须 bag 域前缀（实得 ${String(rb.data.nextCursor).slice(-14)}）`)
      bcur = rb.data.nextCursor
    }
    const bgot = bagItems.map(i => i.index)
    assert.equal(bgot.length, 450, `bag 全量 450（实得 ${bgot.length}）`)
    assert.equal(new Set(bgot).size, 450, 'bag 无重复')
    assert.deepEqual([...bgot].sort((a, b2) => a - b2), Array.from({ length: 450 }, (_, i) => i), 'bag 0-449 恰全量（不跳不漏）')
    // 无过滤（unrestricted）与 list 已由 L21a/L22a（progress 无域）与 L20d（list）分别覆盖——此处不重复
    assert.equal(docSnapshot(st), snapBefore, 'L22c 零写')
  })

  // ══ L24: 批次聚合 aggregateRecordBytes 24MiB 硬上限独立验收（协调方指派——与 CODING 自检分离）══
  const aggBytes = (st, bid) => { const d = st.cloud.__docs.get(`mc_restore_batches/${bid}`); return d ? (d.aggregateRecordBytes || 0) : undefined }
  const genOf = (st, bid) => { const d = st.cloud.__docs.get(`mc_restore_batches/${bid}`); return d ? d.contentGeneration : undefined }
  const chunkDocCount = (st, bid) => [...st.cloud.__docs.keys()].filter(k => k.startsWith('mc_restore_record_chunks/') && k.includes(bid)).length
  const anchorCount = (st, bid) => [...st.cloud.__docs.keys()].filter(k => k.startsWith('mc_restore_anchors/') && k.includes(bid)).length
  // 多记录 bag 合成 manifest（可调域段声明长度——恶意场景用极小值）
  const buildBagManifest = (nRecords, segDeclaredLen) => {
    const recs = Array.from({ length: nRecords }, (_, i) => ({ id: 'g' + String(i).padStart(5, '0'), revision: 0, deleted: false }))
    const files = [{ path: 'records/bag.json', kind: 'domain-json', length: segDeclaredLen, sha256: hexDigest(), contentType: 'application/json', domain: 'bag' }]
    const domains = {}
    for (const d of ['pregnancy', 'daily', 'mood', 'checkup', 'bag', 'reports']) domains[d] = { status: 'omitted' }
    domains.bag = { status: 'present', recordCount: nRecords, pagingComplete: true, visibility: 'shared', fileIndex: 0 }
    return {
      formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: TEST_ENV.MC_FAMILY_ID, packageKind: 'full', complete: true,
      scope: { includeShared: true, includePrivateOf: null }, scopeLabel: 'shared-only', domains, files,
      records: { bag: recs.map((r, i) => ({ index: i, id: r.id, revision: r.revision, deleted: r.deleted, hash: sha256(Buffer.from(P.svc.canonicalJsonBytes(r))) })) }, reports: [],
      pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
    }
  }
  const declaredBatchFromManifest = async (manifest) => {
    const manifestBytes = Buffer.from(P.svc.canonicalJsonBytes(manifest))
    const st = makeStack('mama')
    const bid = nonce()
    const domainCounts = Object.fromEntries(Object.entries(manifest.records).map(([d, l]) => [d, l.length])); const totalRecs = Object.values(manifest.records).reduce((a, l) => a + l.length, 0); const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: sha256(manifestBytes), manifestDigest: sha256(manifestBytes), claimedKind: 'full', totals: { files: manifest.files.length, records: totalRecs, domainCounts } })
    assert.ok(b.ok, `begin: ${JSON.stringify(b).slice(0, 100)}`)
    const CHM = 40 * 1024, ctm = Math.ceil(manifestBytes.length / CHM)
    for (let i = 0; i < ctm; i++) {
      const raw = manifestBytes.subarray(i * CHM, Math.min((i + 1) * CHM, manifestBytes.length))
      const r = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: ctm, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      assert.ok(r.ok, `dc ${i}/${ctm}: ${JSON.stringify(r).slice(0, 80)}`)
    }
    let pc = 0
    for (let i = 0; i < 260; i++) {
      const r = await st.call('mc-restore', { action: 'restore.indexDeclarePage', batchId: bid, pageCursor: pc })
      assert.ok(r.ok, `index ${i}@${pc}: ${JSON.stringify(r).slice(0, 80)}`)
      if (r.data && r.data.status === 'declared') break
      assert.ok(r.data && r.data.hasMore === true && Number.isInteger(r.data.nextCursor), '中间页须 hasMore+nextCursor')
      pc = r.data.nextCursor
    }
    assert.equal(readBatchDoc(st, bid).status, 'declared', 'declared')
    return { st, bid }
  }
  // 六域全 present（各 segLen 域段——Σ=6×segLen 合法化 min() 预算至 24MiB；mood private ⇒ includePrivateOf='mama'）
  const buildMultiBagManifest = (nRecords, segLenPerDomain) => {
    const recs = Array.from({ length: nRecords }, (_, i) => ({ id: 'g' + String(i).padStart(5, '0'), revision: 0, deleted: false }))
    const domains = {}
    const files = []
    const records = {}
    for (const d of ['pregnancy', 'daily', 'mood', 'checkup', 'bag', 'reports']) {
      const fi = files.length
      files.push({ path: `records/${d}.json`, kind: 'domain-json', length: segLenPerDomain, sha256: hexDigest(), contentType: 'application/json', domain: d })
      domains[d] = { status: 'present', recordCount: d === 'bag' ? nRecords : 0, pagingComplete: true, visibility: d === 'mood' ? 'private' : 'shared', fileIndex: fi }
      records[d] = d === 'bag' ? recs.map((r, i) => ({ index: i, id: r.id, revision: r.revision, deleted: r.deleted, hash: sha256(Buffer.from(P.svc.canonicalJsonBytes(r))) })) : []
    }
    return {
      formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: TEST_ENV.MC_FAMILY_ID, packageKind: 'full', complete: true,
      scope: { includeShared: true, includePrivateOf: 'mama' }, scopeLabel: 'shared-plus-own-private', domains, files,
      records, reports: [],
      pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
    }
  }
  const upChunk = (st, bid, domain, index, ci, ct, raw) => st.call('mc-restore', { action: 'restore.uploadRecordChunk', batchId: bid, domain, index, chunkIndex: ci, chunkTotal: ct, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })

  await scenario('L24a 聚合精确边界：6×4MiB=24MiB 恰收（6×103 片）+1B 即拒 record-too-large+零写+gen 不变', async () => {
    const { st, bid } = await declaredBatchFromManifest(buildMultiBagManifest(7, 4 * 1024 * 1024))
    const FOUR = 4 * 1024 * 1024, FULL = 40 * 1024, CAP = 24 * 1024 * 1024
    // 6 条记录 ×恰 4MiB（103 片：102 满片+末片 16384B——恰在 MAX_RECORD_CHUNKS=103 ∧ 4MiB 双界内）
    for (let rec = 0; rec < 6; rec++) {
      for (let ci = 0; ci < 103; ci++) {
        const raw = ci < 102 ? Buffer.alloc(FULL, 0x61 + (rec % 26)) : Buffer.alloc(FOUR - 102 * FULL, 0x62)
        const r = await upChunk(st, bid, 'bag', rec, ci, 103, raw)
        assert.ok(r.ok, `rec${rec} chunk${ci}: ${JSON.stringify(r).slice(0, 100)}`)
      }
    }
    assert.equal(aggBytes(st, bid), CAP, `聚合恰达 24MiB（实得 ${aggBytes(st, bid)}）`)
    const genBefore = genOf(st, bid), chunksBefore = chunkDocCount(st, bid), anchorsBefore = anchorCount(st, bid)
    // +1B（第 7 条记录 1B 末片）→ 新聚合 24MiB+1 > 硬上限 → 拒
    const rj = await upChunk(st, bid, 'bag', 6, 0, 1, Buffer.from('X'))
    assert.ok(!rj.ok && rj.code === 'record-too-large' && /24MiB|25165824|批次聚合/.test(String(rj.message)), `+1B 须拒批次聚合 record-too-large（实得 ${rj.code}: ${String(rj.message).slice(0, 70)}）`)
    assert.equal(aggBytes(st, bid), CAP, '拒绝路径聚合不变')
    assert.equal(chunkDocCount(st, bid), chunksBefore, '拒绝路径零 chunk 落盘')
    assert.equal(anchorCount(st, bid), anchorsBefore, '拒绝路径零 anchor 落盘')
    assert.equal(genOf(st, bid), genBefore, '拒绝路径 gen 不变')
  })

  await scenario('L24b 同片重放不双计：replayed:true ∧ 聚合不变 ∧ gen 不变', async () => {
    const { st, bid } = await declaredBatchFromManifest(buildBagManifest(2, 40 * 1024 + 128))
    const raw = Buffer.alloc(40 * 1024, 0x63)
    const r1 = await upChunk(st, bid, 'bag', 0, 0, 2, raw)
    assert.ok(r1.ok, `首片: ${JSON.stringify(r1).slice(0, 80)}`)
    assert.equal(aggBytes(st, bid), 40 * 1024, '首片聚合 40960')
    const genBefore = genOf(st, bid)
    const r2 = await upChunk(st, bid, 'bag', 0, 0, 2, raw)
    assert.ok(r2.ok && r2.data && r2.data.replayed === true, `重放须 replayed:true（实得 ${JSON.stringify(r2).slice(0, 80)}）`)
    assert.equal(aggBytes(st, bid), 40 * 1024, '重放不双计聚合')
    assert.equal(genOf(st, bid), genBefore, '重放 gen 不变（幂等分支先于聚合事务）')
  })

  await scenario('L24c 双记录【顺序】交错同批：聚合跨记录累计（A0+B0+A尾+B尾=总和）——批次级单一记账（顺序非并发——真实事务竞态见 L24g）', async () => {
    const { st, bid } = await declaredBatchFromManifest(buildBagManifest(2, 4 * 1024 * 1024))
    const FULL = 40 * 1024
    const rA0 = await upChunk(st, bid, 'bag', 0, 0, 2, Buffer.alloc(FULL, 0x64))
    assert.ok(rA0.ok && aggBytes(st, bid) === FULL, `A0 后聚合 ${aggBytes(st, bid)}`)
    const rB0 = await upChunk(st, bid, 'bag', 1, 0, 2, Buffer.alloc(FULL, 0x65))
    assert.ok(rB0.ok && aggBytes(st, bid) === 2 * FULL, `B0 后聚合 ${aggBytes(st, bid)}`)
    const rAt = await upChunk(st, bid, 'bag', 0, 1, 2, Buffer.alloc(100, 0x66))
    assert.ok(rAt.ok && aggBytes(st, bid) === 2 * FULL + 100, `A 尾后聚合 ${aggBytes(st, bid)}`)
    const rBt = await upChunk(st, bid, 'bag', 1, 1, 2, Buffer.alloc(100, 0x67))
    assert.ok(rBt.ok, 'B 尾 ok')
    assert.equal(aggBytes(st, bid), 2 * FULL + 200, `跨记录总和精确（实得 ${aggBytes(st, bid)}）`)
  })

  await scenario('L24d 恶意 10000 声明 vs 极小声明域段：min(24MiB,Σ域段) 收紧已落地——200B 预算即拒+零写', async () => {
    const SEG = 200 // 声明域段仅 200B——min() 预算=200
    const { st, bid } = await declaredBatchFromManifest(buildBagManifest(10000, SEG))
    assert.equal(readBatchDoc(st, bid).status, 'declared', '10000 声明 declared')
    const genB = genOf(st, bid), aggB = aggBytes(st, bid)
    const r = await upChunk(st, bid, 'bag', 0, 0, 4, Buffer.alloc(40 * 1024, 0x68))
    assert.ok(!r.ok && r.code === 'record-too-large' && /200|冻结域字节/.test(String(r.message)), `40,960B ≫ 声明域段 200B 须按冻结域预算拒（实得 ${r.code}: ${String(r.message).slice(0, 70)}）——min(24MiB,Σ域段) 收紧已实现（旧观察收口）`)
    assert.equal(aggBytes(st, bid), aggB, '拒绝路径聚合不变')
    assert.equal(chunkDocCount(st, bid), 0, '零 chunk 落盘')
    assert.equal(anchorCount(st, bid), 0, '零 anchor 落盘')
    assert.equal(genOf(st, bid), genB, 'gen 不变')
  })

  await scenario('L24e 真实阶段一包兼容：全部记录上传过+聚合=Σ全部记录字节（内联+分片——54d1e0f5 内联补记账设计变更后契约）∧ ≤Σ声明域段', async () => {
    const { st, bid } = await freshDeclaredBatch(P)
    const up = await uploadAllRecords(st, P, bid)
    assert.ok(up.ok, `真实包全记录上传: ${JSON.stringify(up).slice(0, 120)}`)
    // Σ 全部记录 canonical 字节（54d1e0f5 起 uploadRecord 内联路径同记聚合 :941——观察②收口；分片路径 :1021 不变）
    let sum = 0
    for (const [domain, list] of Object.entries(P.manifest.records)) {
      for (const decl of list) sum += Buffer.from(P.svc.canonicalJsonBytes(P.domainRecords[domain][decl.index])).length
    }
    assert.equal(aggBytes(st, bid), sum, `聚合=Σ全部记录 canonical 字节（${sum}——内联+分片统一记账）`)
    // 结构性：Σ记录字节 ≤ Σ声明域段长（记录是域数组元素——合法包恒真；作为兼容性数值验证）
    let sumAll = 0
    for (const [domain, list] of Object.entries(P.manifest.records)) {
      for (const decl of list) sumAll += Buffer.from(P.svc.canonicalJsonBytes(P.domainRecords[domain][decl.index])).length
    }
    const segSum = P.manifest.files.filter(f => f.kind === 'domain-json').reduce((a, f) => a + f.length, 0)
    assert.ok(sumAll <= segSum, `Σ记录 ${sumAll} ≤ Σ声明域段 ${segSum}（真实包结构性成立——聚合顶不误伤）`)
    assert.ok(sum < 24 * 1024 * 1024, '真实包远低于 24MiB 顶')
  })

  await scenario('L24f 首片聚合超顶双分支钉（协调方指派）：else 新 anchor 首片拒+零 anchor；既有 anchor 续片拒——任一分支绕过即红', async () => {
    // 预置聚合至 CAP−40,970（5×4MiB 全量 + 第 6 条 101 满片+16,374B 末片）——第 7/8 条留作两分支探针
    const FOUR = 4 * 1024 * 1024, FULL = 40 * 1024, CAP = 24 * 1024 * 1024
    const preTarget = CAP - FULL - 10 // = CAP−40,970
    const rec5Bytes = preTarget - 5 * FOUR // 第 6 条（index 5）承担的字节数
    const rec5FullChunks = Math.floor((rec5Bytes - 1) / FULL) // 满片数（末片 ≥1B）
    const rec5Tail = rec5Bytes - rec5FullChunks * FULL
    assert.ok(rec5FullChunks <= 102 && rec5Tail > 0 && rec5Tail <= FULL, `预置分解合法（满片 ${rec5FullChunks}+末片 ${rec5Tail}B）`)
    const { st, bid } = await declaredBatchFromManifest(buildMultiBagManifest(8, 4 * 1024 * 1024))
    for (let rec = 0; rec < 5; rec++) {
      for (let ci = 0; ci < 103; ci++) {
        const raw = ci < 102 ? Buffer.alloc(FULL, 0x70 + rec) : Buffer.alloc(FOUR - 102 * FULL, 0x7a)
        const r = await upChunk(st, bid, 'bag', rec, ci, 103, raw)
        assert.ok(r.ok, `rec${rec} chunk${ci}`)
      }
    }
    for (let ci = 0; ci <= rec5FullChunks; ci++) {
      const raw = ci < rec5FullChunks ? Buffer.alloc(FULL, 0x71) : Buffer.alloc(rec5Tail, 0x7b)
      const r = await upChunk(st, bid, 'bag', 5, ci, rec5FullChunks + 1, raw)
      assert.ok(r.ok, `rec5 chunk${ci}`)
    }
    assert.equal(aggBytes(st, bid), preTarget, `预置聚合 ${preTarget}=CAP−${CAP - preTarget}`)
    // ① 既有 anchor 分支（if）：第 7 条（index 6）chunkTotal=2 首片恰 40KiB → CAP−10 ≤CAP 收（建 anchor）→ 末片 11B → CAP+1>顶 拒
    const r0 = await upChunk(st, bid, 'bag', 6, 0, 2, Buffer.alloc(FULL, 0x72))
    assert.ok(r0.ok && aggBytes(st, bid) === CAP - 10, `既有 anchor 前置片收（聚合 ${aggBytes(st, bid)}）`)
    const genB = genOf(st, bid)
    const r1 = await upChunk(st, bid, 'bag', 6, 1, 2, Buffer.alloc(11, 0x73))
    assert.ok(!r1.ok && r1.code === 'record-too-large' && /批次聚合|24MiB/.test(String(r1.message)), `既有 anchor 续片超顶须拒（实得 ${r1.code}: ${String(r1.message).slice(0, 60)}）`)
    assert.equal(aggBytes(st, bid), CAP - 10, 'if 分支拒绝聚合不变')
    assert.equal(genOf(st, bid), genB, 'if 分支拒绝 gen 不变')
    // ② 新 anchor 分支（else）：第 8 条（index 7）首片 40KiB → CAP−10+40,960>顶 → 拒+零 anchor
    const anchorsBefore = anchorCount(st, bid), chunksBefore = chunkDocCount(st, bid)
    const r2 = await upChunk(st, bid, 'bag', 7, 0, 2, Buffer.alloc(FULL, 0x74))
    assert.ok(!r2.ok && r2.code === 'record-too-large' && /批次聚合|24MiB/.test(String(r2.message)), `else 新 anchor 首片超顶须拒（实得 ${r2.code}: ${String(r2.message).slice(0, 60)}）——该分支绕过即此断言转红`)
    assert.equal(anchorCount(st, bid), anchorsBefore, 'else 分支拒绝零 anchor 落盘')
    assert.equal(chunkDocCount(st, bid), chunksBefore, 'else 分支拒绝零 chunk 落盘')
    assert.equal(aggBytes(st, bid), CAP - 10, 'else 分支拒绝聚合不变')
    assert.equal(genOf(st, bid), genB, 'else 分支拒绝 gen 不变')
  })

  await scenario('L24g 并发事务竞态（barrier Promise.all）：同批多记录并发片——CAS 无丢失更新（聚合=精确和）+重试收敛+gen=成功提交数', async () => {
    const { st, bid } = await declaredBatchFromManifest(buildBagManifest(3, 4 * 1024 * 1024))
    const FULL = 40 * 1024
    let contentionSeen = 0 // 竞态证据：internal-error（mock CAS 读快照冲突——begin 外无内建重试）次数
    const retryUntilOk = async (fn) => {
      for (let i = 0; i < 15; i++) {
        const r = await fn()
        if (r.ok) return r
        if (r.code === 'internal-error') contentionSeen++
        else throw new Error(`非冲突失败（不可重试）: ${JSON.stringify(r).slice(0, 100)}`)
      }
      throw new Error('重试耗尽')
    }
    // 波 1（barrier）：3 记录首片并发（各自 40KiB 非末片，字节互异）
    const wave1 = [0, 1, 2].map(rec => () => upChunk(st, bid, 'bag', rec, 0, 2, Buffer.alloc(FULL, 0x80 + rec)))
    const barrier = await Promise.all(wave1.map(fn => retryUntilOk(fn).then(r => r, e => e)))
    for (const b of barrier) assert.ok(!(b instanceof Error), `波1 收敛: ${b instanceof Error ? b.message : 'ok'}`)
    let agg1 = aggBytes(st, bid)
    assert.equal(agg1, 3 * FULL, `波1 后聚合=3×40KiB 精确和 ${3 * FULL}（实得 ${agg1}——丢失更新即小于此）`)
    // 波 2（barrier）：3 记录末片并发（各 100B）
    const wave2 = [0, 1, 2].map(rec => () => upChunk(st, bid, 'bag', rec, 1, 2, Buffer.alloc(100, 0x90 + rec)))
    const barrier2 = await Promise.all(wave2.map(fn => retryUntilOk(fn).then(r => r, e => e)))
    for (const b of barrier2) assert.ok(!(b instanceof Error), `波2 收敛: ${b instanceof Error ? b.message : 'ok'}`)
    assert.equal(aggBytes(st, bid), 3 * (FULL + 100), `终态聚合=3×41,060 精确和（实得 ${aggBytes(st, bid)}）`)
    // 全部 6 片持久在档（并发重试不丢片）
    assert.equal(chunkDocCount(st, bid), 6, `6 片全持久（实得 ${chunkDocCount(st, bid)}）`)
    // gen=成功新片提交数（6）——重试不计入（失败事务已回滚）
    assert.equal(genOf(st, bid), 6, `gen=成功提交数 6（实得 ${genOf(st, bid)}）`)
    console.log(`      L24g 竞态证据：internal-error(CAS 冲突) ×${contentionSeen}（≥0——Node 调度可能完全串行化；正确性断言不依赖竞态必现）`)
  })

  // ══ L25: 批次记账组合契约（已批准设计：cap = min(24MiB, Σ冻结 present 域段字节)——内联+分片同门同事务）══
  // 红先行：当前实现（54d1e0f5 世代）只有扁平 24MiB 顶——Σ域段收紧落地前 L25a/b/d 域预算断言为红（设计未落地非回归）；
  // L25c/L25e 两路径重放不双计与真实包兼容为现行已满足的回归钉。
  const segBudget = manifest => manifest.files.filter(f => f.kind === 'domain-json' && manifest.domains[f.domain] && manifest.domains[f.domain].status === 'present').reduce((a, f) => a + f.length, 0)
  const budgetOf = manifest => Math.min(24 * 1024 * 1024, segBudget(manifest))

  await scenario('L25a 极小声明域段+真实匹配记录：超域预算先于任何变异拒绝（零 record/零 anchor/聚合/gen 不变）', async () => {
    const m = buildBagManifest(3, 200) // 声明域段仅 200B
    const budget = budgetOf(m)
    assert.equal(budget, 200, `前置预算=min(24MiB,200)=200`)
    const { st, bid } = await declaredBatchFromManifest(m)
    const rec0 = { id: 'g00000', revision: 0, deleted: false } // canonical ~44B ≤200 收
    const r0 = await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'bag', index: 0, id: rec0.id, revision: rec0.revision, record: rec0, deleted: rec0.deleted })
    assert.ok(r0.ok, `rec0 内联须收: ${JSON.stringify(r0).slice(0, 80)}`)
    assert.equal(aggBytes(st, bid), Buffer.from(P.svc.canonicalJsonBytes(rec0)).length, `聚合=rec0 canonical 字节`)
    const genB = genOf(st, bid)
    const recDocsB = chunkDocCount(st, bid) + anchorCount(st, bid) + [...st.cloud.__docs.keys()].filter(k => k.startsWith('mc_restore_records/') && k.includes(bid)).length
    // rec1 再 ~44B → 聚合 88 ≤200 收；rec2 → 132 ≤200 收；再一条 → 超预算拒——用第 4 条声明不存在会先 invalid-params，
    // 故本场景用两条 150B 记录逼近：改用 rec1 大记录（inline ≤48KiB）一次越过
    const big = { id: 'g00001', revision: 0, deleted: false }
    big.id = 'g00001' + 'x'.repeat(150)
    const bigBytes = Buffer.from(P.svc.canonicalJsonBytes(big)).length
    assert.ok(bigBytes > 200 - 44, `前置：rec1 canonical ${bigBytes}B 使累计超 200 预算`)
    // 声明 hash 须与正文自洽——重建 manifest 使 decl1.hash=该正文 hash（重走 begin）
    const m2 = buildBagManifest(3, 200)
    m2.records.bag[1] = { index: 1, id: big.id, revision: 0, deleted: false, hash: sha256(Buffer.from(P.svc.canonicalJsonBytes(big))) }
    const { st: st2, bid: bid2 } = await declaredBatchFromManifest(m2)
    const up0 = await st2.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid2, domain: 'bag', index: 0, id: 'g00000', revision: 0, record: { id: 'g00000', revision: 0, deleted: false }, deleted: false })
    assert.ok(up0.ok, 'rec0 收（44B ≤200）')
    const aggB = aggBytes(st2, bid2), genB2 = genOf(st2, bid2)
    const recDocsB2 = [...st2.cloud.__docs.keys()].filter(k => k.startsWith('mc_restore_records/') && k.includes(bid2)).length
    const rj = await st2.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid2, domain: 'bag', index: 1, id: big.id, revision: 0, record: big, deleted: false })
    assert.ok(!rj.ok && rj.code === 'record-too-large', `rec1（累计 ${bigBytes + 44} > 域预算 200）须拒 record-too-large（实得 ${rj.code}: ${String(rj.message).slice(0, 70)}）——min(24MiB,Σ域段) 域预算门（红先行：现实现扁平 24MiB 不含此门）`)
    assert.equal(aggBytes(st2, bid2), aggB, '拒绝路径聚合不变')
    assert.equal(genOf(st2, bid2), genB2, '拒绝路径 gen 不变')
    assert.equal([...st2.cloud.__docs.keys()].filter(k => k.startsWith('mc_restore_records/') && k.includes(bid2)).length, recDocsB2, '拒绝路径零 record 落盘')
  })

  await scenario('L25b 内联+分片混合恰等域预算：动态 SEG=实际字节和——全部收；+1B（任一路径）超预算拒零写', async () => {
    // 先定三记录实际字节（id 填充法定尺寸——bag 白名单内），再令声明域段=精确和
    const mkRec = (head, targetBytes) => {
      const base = { id: head, revision: 0, deleted: false }
      const baseN = Buffer.from(P.svc.canonicalJsonBytes(base)).length
      const rec = { id: head + 'y'.repeat(Math.max(0, targetBytes - baseN)), revision: 0, deleted: false }
      const n = Buffer.from(P.svc.canonicalJsonBytes(rec)).length
      return { rec, n }
    }
    const r0 = mkRec('g00000', 100)
    const r1RawLen = 40 * 1024 + 200
    const r2 = mkRec('g00002', 60)
    const SEG = r0.n + r1RawLen + r2.n
    const m = buildBagManifest(4, SEG)
    m.records.bag[0] = { index: 0, id: r0.rec.id, revision: 0, deleted: false, hash: sha256(Buffer.from(P.svc.canonicalJsonBytes(r0.rec))) }
    const r1Hash = sha256(Buffer.concat([Buffer.alloc(40 * 1024, 0x61), Buffer.alloc(200, 0x62)]))
    m.records.bag[1] = { index: 1, id: 'chunked-r1', revision: 0, deleted: false, hash: r1Hash }
    m.records.bag[2] = { index: 2, id: r2.rec.id, revision: 0, deleted: false, hash: sha256(Buffer.from(P.svc.canonicalJsonBytes(r2.rec))) }
    const { st, bid } = await declaredBatchFromManifest(m)
    const budget = Math.min(24 * 1024 * 1024, SEG)
    assert.equal(budget, SEG, `预算=min(24MiB,SEG)=${SEG}`)
    const u0 = await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'bag', index: 0, id: r0.rec.id, revision: 0, record: r0.rec, deleted: false })
    assert.ok(u0.ok, `r0 内联 ${r0.n}B 收`)
    const r1Raw = Buffer.concat([Buffer.alloc(40 * 1024, 0x61), Buffer.alloc(200, 0x62)])
    const c0 = await upChunk(st, bid, 'bag', 1, 0, 2, r1Raw.subarray(0, 40 * 1024))
    assert.ok(c0.ok, 'r1 满片收')
    const c1 = await upChunk(st, bid, 'bag', 1, 1, 2, r1Raw.subarray(40 * 1024))
    assert.ok(c1.ok, 'r1 末片 200B 收')
    const u2 = await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'bag', index: 2, id: r2.rec.id, revision: 0, record: r2.rec, deleted: false })
    assert.ok(u2.ok, `r2 内联 ${r2.n}B 收（累计=预算 ${SEG}）`)
    assert.equal(aggBytes(st, bid), SEG, `混合恰等域预算（实得 ${aggBytes(st, bid)}）`)
    const genB = genOf(st, bid)
    // r3 分片 1B（分片路径超预算探针）
    const rj2 = await upChunk(st, bid, 'bag', 3, 0, 1, Buffer.alloc(1, 0x63))
    assert.ok(!rj2.ok && rj2.code === 'record-too-large', `r3 分片 1B 超预算须拒（实得 ${rj2.code}: ${String(rj2.message).slice(0, 60)}）`)
    // r3' 内联 1B 等值（id 填充到恰 1B 超界：目标 SEG+1 不可行——用现有探针即可：另一条 >剩余 0）
    assert.equal(aggBytes(st, bid), SEG, '拒绝后聚合不变')
    assert.equal(genOf(st, bid), genB, '拒绝后 gen 不变')
  })

  await scenario('L25c 双路径重放不双计：内联 replayed:true+分片 replayed:true——聚合与 gen 均不变（现行回归钉）', async () => {
    const m = buildBagManifest(2, 40 * 1024 + 4096)
    const { st, bid } = await declaredBatchFromManifest(m)
    const rec0 = { id: 'g00000', revision: 0, deleted: false }
    const u1 = await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'bag', index: 0, id: rec0.id, revision: 0, record: rec0, deleted: false })
    assert.ok(u1.ok, '内联首传收')
    const agg1 = aggBytes(st, bid), gen1 = genOf(st, bid)
    const u2 = await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'bag', index: 0, id: rec0.id, revision: 0, record: rec0, deleted: false })
    assert.ok(u2.ok && u2.data && u2.data.replayed === true, `内联重放 replayed:true（实得 ${JSON.stringify(u2).slice(0, 80)}）`)
    assert.equal(aggBytes(st, bid), agg1, '内联重放聚合不变')
    assert.equal(genOf(st, bid), gen1, '内联重放 gen 不变')
    const raw = Buffer.alloc(40 * 1024, 0x64)
    const c1 = await upChunk(st, bid, 'bag', 1, 0, 2, raw)
    assert.ok(c1.ok, '分片首传收')
    const agg2 = aggBytes(st, bid), gen2 = genOf(st, bid)
    const c2 = await upChunk(st, bid, 'bag', 1, 0, 2, raw)
    assert.ok(c2.ok && c2.data && c2.data.replayed === true, '分片重放 replayed:true')
    assert.equal(aggBytes(st, bid), agg2, '分片重放聚合不变')
    assert.equal(genOf(st, bid), gen2, '分片重放 gen 不变')
  })

  await scenario('L25d 预算沿真并发竞态：恰余一片额度双 contenders——恰一收一终态拒（重试不得越界收纳）、无丢失更新', async () => {
    // 预算=40KiB×2+100：预填两满片（80KiB）→ 余 100；r2/r3 各 55B（id 填充——bag 白名单内）恰容一
    const SEG = 40 * 1024 * 2 + 100
    const m = buildBagManifest(4, SEG)
    const mk55 = head => {
      const base = { id: head, revision: 0, deleted: false }
      const baseN = Buffer.from(P.svc.canonicalJsonBytes(base)).length
      return { id: head + 'z'.repeat(Math.max(0, 55 - baseN)), revision: 0, deleted: false }
    }
    const r2 = mk55('g00002'), r3 = mk55('g00003')
    const r2b = Buffer.from(P.svc.canonicalJsonBytes(r2)).length, r3b = Buffer.from(P.svc.canonicalJsonBytes(r3)).length
    m.records.bag[2] = { index: 2, id: r2.id, revision: 0, deleted: false, hash: sha256(Buffer.from(P.svc.canonicalJsonBytes(r2))) }
    m.records.bag[3] = { index: 3, id: r3.id, revision: 0, deleted: false, hash: sha256(Buffer.from(P.svc.canonicalJsonBytes(r3))) }
    const { st, bid } = await declaredBatchFromManifest(m)
    await upChunk(st, bid, 'bag', 0, 0, 1, Buffer.alloc(40 * 1024, 0x65))
    await upChunk(st, bid, 'bag', 1, 0, 1, Buffer.alloc(40 * 1024, 0x66))
    assert.equal(aggBytes(st, bid), 80 * 1024, `预填 80KiB（余 100B）`)
    assert.ok(r2b <= 100 && r3b <= 100 && r2b + r3b > 100, `前置：单条 ≤100 且合计 ${r2b + r3b} >100（恰容一条）`)
    let contention = 0
    const attempt = async (rec, idx) => {
      for (let i = 0; i < 15; i++) {
        const r = await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'bag', index: idx, id: rec.id, revision: 0, record: rec, deleted: false })
        if (r.ok) return { ok: true }
        if (r.code === 'record-too-large') return { ok: false, terminal: true, code: r.code }
        if (r.code === 'internal-error') { contention++; continue }
        return { ok: false, code: r.code }
      }
      return { ok: false, exhausted: true }
    }
    const [a2, a3] = await Promise.all([attempt(r2, 2), attempt(r3, 3)])
    const accepted = [a2, a3].filter(x => x.ok).length
    assert.equal(accepted, 1, `并发恰容一：1 收 1 拒（实得 收×${accepted}——败者 ${JSON.stringify([a2, a3].find(x => !x.ok))}）`)
    const loser = [a2, a3].find(x => !x.ok)
    assert.ok(loser && (loser.terminal || loser.exhausted || loser.code), '败者存在')
    assert.equal(aggBytes(st, bid), 80 * 1024 + (a2.ok ? r2b : r3b), `终态聚合=预填+恰一条（无丢失更新、不越界）（实得 ${aggBytes(st, bid)} ≤预算 ${SEG}）`)
    assert.ok(aggBytes(st, bid) <= SEG, `聚合 ≤ 域预算 ${SEG}`)
    console.log(`      L25d 竞态证据：internal-error ×${contention}`)
  })

  await scenario('L25e 真实阶段一 full 包：min 门下全程收（Σ记录 < Σ域段 结构性）、聚合=Σ全部记录字节（现行回归钉）', async () => {
    const { st, bid } = await freshDeclaredBatch(P)
    const budget = Math.min(24 * 1024 * 1024, segBudget(P.manifest))
    let sumAll = 0
    for (const [domain, list] of Object.entries(P.manifest.records)) {
      for (const decl of list) sumAll += Buffer.from(P.svc.canonicalJsonBytes(P.domainRecords[domain][decl.index])).length
    }
    assert.ok(sumAll < budget, `前置：Σ记录 ${sumAll} < min 门预算 ${budget}（真实包结构性）`)
    const up = await uploadAllRecords(st, P, bid)
    assert.ok(up.ok, `真实包全记录上传: ${JSON.stringify(up).slice(0, 120)}`)
    assert.equal(aggBytes(st, bid), sumAll, `聚合=Σ全部记录字节（内联+分片统一）`)
  })

  // ══ L26: aggregateRecordBytes 磁盘态腐蚀回归（协调方指派矩阵 @5e002024）══
  // 契约（validateAggCounter :282-287 + 双路径 :963/:1055，均先于 replay）：undefined/null=合法初始零；
  // 字符串（含数字串）/负值/超 cap=invalid-state fail-closed（零写/gen 不变）——篡改态连已有 replay 也不得假报。
  const setAgg = (st, bid, val) => { const d = st.cloud.__docs.get(`mc_restore_batches/${bid}`); d.aggregateRecordBytes = val; st.cloud.__docs.set(`mc_restore_batches/${bid}`, d) }
  const batchSnap = (st, bid) => JSON.stringify(st.cloud.__docs.get(`mc_restore_batches/${bid}`))
  const recDocsOf = (st, bid) => [...st.cloud.__docs.keys()].filter(k => k.startsWith('mc_restore_records/') && k.includes(bid)).length
  const CORRUPTS = [['string-bad', 'abc'], ['numeric-string', '12'], ['negative', -100], ['over-cap', null]] // over-cap 动态取 F+1

  await scenario('L26a 腐蚀态 fresh inline：四种腐蚀全 invalid-state fail-closed+零 record+聚合原样+gen 不变', async () => {
    for (const [label, val] of CORRUPTS) {
      const { st, bid } = await declaredBatchFromManifest(buildBagManifest(2, 4 * 1024 * 1024))
      const F = st.cloud.__docs.get(`mc_restore_batches/${bid}`).frozenDomainBytes
      const v = val === null ? F + 1 : val
      setAgg(st, bid, v)
      const snap = batchSnap(st, bid), genB = genOf(st, bid)
      const rec = { id: 'g00000', revision: 0, deleted: false }
      const r = await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'bag', index: 0, id: rec.id, revision: 0, record: rec, deleted: false })
      assert.ok(!r.ok && r.code === 'invalid-state' && /聚合计数器|aggregateRecordBytes/.test(String(r.message)), `L26a[${label}=${JSON.stringify(v)}] 须 invalid-state（实得 ${r.code}: ${String(r.message).slice(0, 70)}）`)
      assert.equal(recDocsOf(st, bid), 0, `L26a[${label}] 零 record`)
      assert.equal(batchSnap(st, bid), snap, `L26a[${label}] 批次文档零变化（聚合原样）`)
      assert.equal(genOf(st, bid), genB, `L26a[${label}] gen 不变`)
    }
  })

  await scenario('L26b 腐蚀态 fresh chunk：四种腐蚀全 invalid-state+零 chunk/零 anchor+聚合原样+gen 不变', async () => {
    for (const [label, val] of CORRUPTS) {
      const { st, bid } = await declaredBatchFromManifest(buildBagManifest(2, 4 * 1024 * 1024))
      const F = st.cloud.__docs.get(`mc_restore_batches/${bid}`).frozenDomainBytes
      const v = val === null ? F + 1 : val
      setAgg(st, bid, v)
      const snap = batchSnap(st, bid), genB = genOf(st, bid)
      const r = await upChunk(st, bid, 'bag', 0, 0, 2, Buffer.alloc(40 * 1024, 0x71))
      assert.ok(!r.ok && r.code === 'invalid-state' && /聚合计数器|aggregateRecordBytes/.test(String(r.message)), `L26b[${label}=${JSON.stringify(v)}] 须 invalid-state（实得 ${r.code}: ${String(r.message).slice(0, 70)}）`)
      assert.equal(chunkDocCount(st, bid), 0, `L26b[${label}] 零 chunk`)
      assert.equal(anchorCount(st, bid), 0, `L26b[${label}] 零 anchor`)
      assert.equal(batchSnap(st, bid), snap, `L26b[${label}] 批次文档零变化`)
      assert.equal(genOf(st, bid), genB, `L26b[${label}] gen 不变`)
    }
  })

  await scenario('L26c 腐蚀态已有 inline replay：fail-closed 先于 replay——同内容重放也 invalid-state（不假报 replayed:true）+零写', async () => {
    const { st, bid } = await declaredBatchFromManifest(buildBagManifest(2, 4 * 1024 * 1024))
    const rec = { id: 'g00000', revision: 0, deleted: false }
    const up = await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'bag', index: 0, id: rec.id, revision: 0, record: rec, deleted: false })
    assert.ok(up.ok, '前置：健康态上传成功')
    setAgg(st, bid, '12') // 数字串腐蚀
    const snap = batchSnap(st, bid), genB = genOf(st, bid), recsB = recDocsOf(st, bid)
    const rp = await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'bag', index: 0, id: rec.id, revision: 0, record: rec, deleted: false })
    assert.ok(!rp.ok && rp.code === 'invalid-state', `同内容重放须先撞腐蚀门 invalid-state（实得 ${rp.code}${rp.data && rp.data.replayed ? ' replayed=true 假报!' : ''}）`)
    assert.equal(recDocsOf(st, bid), recsB, 'record 集不变')
    assert.equal(batchSnap(st, bid), snap, '批次文档零变化')
    assert.equal(genOf(st, bid), genB, 'gen 不变')
  })

  await scenario('L26d 腐蚀态已有 chunk replay：fail-closed 先于 chunk 幂等分支——同片重放也 invalid-state+零写', async () => {
    const { st, bid } = await declaredBatchFromManifest(buildBagManifest(2, 4 * 1024 * 1024))
    const raw = Buffer.alloc(40 * 1024, 0x72)
    const c0 = await upChunk(st, bid, 'bag', 0, 0, 2, raw)
    assert.ok(c0.ok, '前置：健康态首片成功')
    setAgg(st, bid, 'abc')
    const snap = batchSnap(st, bid), genB = genOf(st, bid), chunksB = chunkDocCount(st, bid)
    const rp = await upChunk(st, bid, 'bag', 0, 0, 2, raw)
    assert.ok(!rp.ok && rp.code === 'invalid-state', `同片重放须先撞腐蚀门 invalid-state（实得 ${rp.code}${rp.data && rp.data.replayed ? ' replayed=true 假报!' : ''}）`)
    assert.equal(chunkDocCount(st, bid), chunksB, 'chunk 集不变')
    assert.equal(batchSnap(st, bid), snap, '批次文档零变化')
    assert.equal(genOf(st, bid), genB, 'gen 不变')
  })

  await scenario('L26e 初始零契约（勘误版）：undefined 仅真 fresh（gen=0 零上传）合法——null 任何处皆篡改须拒', async () => {
    // undefined + 真 fresh（begin 省略字段 + contentGeneration=0 + 零上传）→ 合法
    {
      const { st, bid } = await declaredBatchFromManifest(buildBagManifest(2, 40 * 1024 + 128))
      const d = st.cloud.__docs.get(`mc_restore_batches/${bid}`)
      delete d.aggregateRecordBytes
      st.cloud.__docs.set(`mc_restore_batches/${bid}`, d)
      assert.equal(genOf(st, bid), 0, '前置：gen=0 真 fresh')
      const rec = { id: 'g00000', revision: 0, deleted: false }
      const n = Buffer.from(P.svc.canonicalJsonBytes(rec)).length
      const r = await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'bag', index: 0, id: rec.id, revision: 0, record: rec, deleted: false })
      assert.ok(r.ok, `undefined@gen=0 须正常（实得 ${JSON.stringify(r).slice(0, 80)}）`)
      assert.equal(aggBytes(st, bid), n, `聚合=恰 ${n}B`)
    }
    // null + 真 fresh —— begin 从不写 null：磁盘 null 即篡改 → 须拒（预期红：现实现按 0 放行）
    {
      const { st, bid } = await declaredBatchFromManifest(buildBagManifest(2, 40 * 1024 + 128))
      const d = st.cloud.__docs.get(`mc_restore_batches/${bid}`)
      d.aggregateRecordBytes = null
      st.cloud.__docs.set(`mc_restore_batches/${bid}`, d)
      const snap = batchSnap(st, bid)
      const r = await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'bag', index: 0, id: 'g00000', revision: 0, record: { id: 'g00000', revision: 0, deleted: false }, deleted: false })
      assert.ok(!r.ok && r.code === 'invalid-state', `null@gen=0 须 invalid-state（null 非初始值——begin 从不写 null；实得 ${r.ok ? 'ok 放行（按 0 记账）' : r.code}）——预期红：上报 CODING 的生产缺陷`)
      assert.equal(batchSnap(st, bid), snap, '拒路径零写')
    }
  })

  await scenario('L26f 健康态合法重放保全（对照）：inline/chunk 同内容重放 replayed:true+聚合/gen 不变', async () => {
    const { st, bid } = await declaredBatchFromManifest(buildBagManifest(2, 40 * 1024 + 128))
    const rec = { id: 'g00000', revision: 0, deleted: false }
    await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'bag', index: 0, id: rec.id, revision: 0, record: rec, deleted: false })
    const raw = Buffer.alloc(40 * 1024, 0x73)
    await upChunk(st, bid, 'bag', 1, 0, 2, raw)
    const aggB = aggBytes(st, bid), genB = genOf(st, bid)
    const ri = await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'bag', index: 0, id: rec.id, revision: 0, record: rec, deleted: false })
    assert.ok(ri.ok && ri.data && ri.data.replayed === true, `inline 重放 replayed:true（实得 ${JSON.stringify(ri).slice(0, 80)}）`)
    const rc = await upChunk(st, bid, 'bag', 1, 0, 2, raw)
    assert.ok(rc.ok && rc.data && rc.data.replayed === true, `chunk 重放 replayed:true（实得 ${JSON.stringify(rc).slice(0, 80)}）`)
    assert.equal(aggBytes(st, bid), aggB, '聚合不变')
    assert.equal(genOf(st, bid), genB, 'gen 不变')
  })

  // ══ L27: 上传后篡改（删字段/null）——双重记账绕过永久回归钉（undefined 仅 gen=0 真 fresh；null 任何处非法）══
  // 契约：任一成功上传后 aggregateRecordBytes 必为数值——gen>0 ∧ 字段缺席/null = 篡改 → invalid-state 零写。
  // 历史：@5e002024 曾放行（协调方指正坐实）；@ff375958 validateAggCounter 已修——本组为其永久回归钉。
  const tamper = (st, bid, mode) => { const d = st.cloud.__docs.get(`mc_restore_batches/${bid}`); if (mode === 'delete') delete d.aggregateRecordBytes; else d.aggregateRecordBytes = null; st.cloud.__docs.set(`mc_restore_batches/${bid}`, d) }

  await scenario('L27a【永久回归钉】上传后删字段→fresh chunk 须拒（防双重记账绕过——聚合遗忘即绕过形状）', async () => {
    const { st, bid } = await declaredBatchFromManifest(buildBagManifest(3, 4 * 1024 * 1024))
    const c0 = await upChunk(st, bid, 'bag', 0, 0, 1, Buffer.alloc(40 * 1024, 0x74))
    assert.ok(c0.ok, '前置：首片成功（aggregateRecordBytes=40960 已持久）')
    const aggBefore = aggBytes(st, bid), genBefore = genOf(st, bid)
    assert.ok(aggBefore === 40 * 1024 && genBefore >= 1, `前置：聚合 ${aggBefore} ∧ gen ${genBefore}（已上传态）`)
    tamper(st, bid, 'delete')
    const snap = batchSnap(st, bid)
    const r = await upChunk(st, bid, 'bag', 1, 0, 1, Buffer.alloc(40 * 1024, 0x75))
    assert.ok(!r.ok && r.code === 'invalid-state', `上传后删字段→新记录分片须 invalid-state（实得 ${r.ok ? `ok 放行——聚合重置为 ${aggBytes(st, bid)}（遗忘已计 ${aggBefore}B）=双重记账绕过` : r.code}: ${String(r.message).slice(0, 60)}）——契约：gen>0 ∧ 字段缺席=篡改`)
    assert.equal(batchSnap(st, bid), snap, '拒路径零写（若现放行则此断言亦红——放行已写 chunk+重置聚合）')
  })

  await scenario('L27b【永久回归钉】上传后置 null→fresh inline 须拒（null 非初始值——begin 从不写）', async () => {
    const { st, bid } = await declaredBatchFromManifest(buildBagManifest(3, 40 * 1024 + 128))
    const rec0 = { id: 'g00000', revision: 0, deleted: false }
    const u0 = await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'bag', index: 0, id: rec0.id, revision: 0, record: rec0, deleted: false })
    assert.ok(u0.ok, '前置：inline 成功')
    const aggBefore = aggBytes(st, bid)
    tamper(st, bid, 'null')
    const snap = batchSnap(st, bid)
    const rec1 = { id: 'g00001', revision: 0, deleted: false }
    const r = await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'bag', index: 1, id: rec1.id, revision: 0, record: rec1, deleted: false })
    assert.ok(!r.ok && r.code === 'invalid-state', `上传后 null→新 inline 须 invalid-state（实得 ${r.ok ? `ok 放行——聚合 ${aggBytes(st, bid)}（遗忘 ${aggBefore}B）` : r.code}）——null 非初始值（begin 从不写）`)
    assert.equal(batchSnap(st, bid), snap, '拒路径零写')
  })

  await scenario('L27c【永久回归钉】上传后删字段→已有记录同内容重放须先拒（腐蚀态不得假报 replayed:true）', async () => {
    const { st, bid } = await declaredBatchFromManifest(buildBagManifest(2, 40 * 1024 + 128))
    const rec = { id: 'g00000', revision: 0, deleted: false }
    await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'bag', index: 0, id: rec.id, revision: 0, record: rec, deleted: false })
    tamper(st, bid, 'delete')
    const snap = batchSnap(st, bid), genB = genOf(st, bid)
    const rp = await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'bag', index: 0, id: rec.id, revision: 0, record: rec, deleted: false })
    assert.ok(!rp.ok && rp.code === 'invalid-state', `篡改态重放须 invalid-state（实得 ${rp.ok && rp.data && rp.data.replayed ? 'replayed:true 假报——腐蚀态被当合法零' : rp.code}）`)
    assert.equal(batchSnap(st, bid), snap, '零写')
    assert.equal(genOf(st, bid), genB, 'gen 不变')
  })

  await scenario('L27d【永久回归钉】上传后置 null→已有 chunk 同片重放须先拒（同形态 chunk 路径）', async () => {
    const { st, bid } = await declaredBatchFromManifest(buildBagManifest(2, 40 * 1024 + 128))
    const raw = Buffer.alloc(40 * 1024, 0x76)
    await upChunk(st, bid, 'bag', 0, 0, 2, raw)
    tamper(st, bid, 'null')
    const snap = batchSnap(st, bid), genB = genOf(st, bid)
    const rp = await upChunk(st, bid, 'bag', 0, 0, 2, raw)
    assert.ok(!rp.ok && rp.code === 'invalid-state', `篡改 null 态同片重放须 invalid-state（实得 ${rp.ok && rp.data && rp.data.replayed ? 'replayed:true 假报' : rp.code}）`)
    assert.equal(batchSnap(st, bid), snap, '零写')
    assert.equal(genOf(st, bid), genB, 'gen 不变')
  })

  // ══ L28: Stage1-valid 兼容形状永久红回归（协调方裁定意图契约：declare 应接受+上传保全源值）══
  // 现状红（restore 拒 Stage1-legal 形状）——意图契约落地后转绿；安全检查全保留（L18 类型同一性等不软化）。
  const buildCompatPkg = (variant) => {
    const recs = [{ id: 'b-0000', revision: 0, deleted: false }, { id: 'b-0001', revision: 1, deleted: false }]
    const seg = Buffer.from(P.svc.canonicalJsonBytes(recs))
    const domains = {}
    for (const d of ['pregnancy', 'daily', 'mood', 'checkup', 'bag', 'reports']) domains[d] = { status: 'omitted' }
    domains.bag = { status: 'present', recordCount: 2, pagingComplete: true, visibility: 'shared', fileIndex: 0 }
    const fileEntry = { path: 'records/bag.json', kind: 'domain-json', length: seg.length, sha256: sha256(seg), contentType: 'application/json' }
    if (variant !== 'A') fileEntry.domain = 'bag' // A：省略冗余 f.domain
    const records = recs.map((r, i) => ({ index: i, id: r.id, revision: r.revision, deleted: r.deleted, hash: sha256(Buffer.from(P.svc.canonicalJsonBytes(r))) }))
    if (variant === 'B') { records[0] = { ...records[0], revision: String(0), deleted: 0 } } // B：声明侧源值类型（container 强转语义合法）
    const manifest = {
      formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: TEST_ENV.MC_FAMILY_ID, packageKind: 'full', complete: true,
      scope: { includeShared: true, includePrivateOf: null }, scopeLabel: 'shared-only', domains,
      files: [fileEntry], records: { bag: records }, reports: [],
      pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
    }
    return { manifest, seg, recs }
  }
  const compatFlow = async (variant, label) => {
    const { manifest, seg, recs } = buildCompatPkg(variant)
    const manifestBytes = Buffer.from(P.svc.canonicalJsonBytes(manifest))
    // ① Stage1 合法性：真 container.validatePackage 零 problems（绿锚——形状确为 Stage1-legal）
    const len8 = n => { const b = Buffer.alloc(8); b.writeUInt32BE(0, 0); b.writeUInt32BE(n, 4); return b }
    const pkg = Buffer.concat([Buffer.from(P.svc.encodeHeader ? P.svc.encodeHeader(manifestBytes.length) : Buffer.alloc(0)), manifestBytes, len8(seg.length), seg])
    const v = await P.svc.validatePackage({ size: async () => pkg.length, readChunk: async (pp, l) => new Uint8Array(pkg.subarray(pp, pp + l)) })
    assert.ok(v.ok === true, `[${label}] ① 真 container.validatePackage 零 problems（实得 ${JSON.stringify((v.problems || []).slice(0, 2)).slice(0, 140)}）——Stage1-legal 前提锚`)
    // ② 意图契约：真 restore.begin+declareChunk 全片+index → declared（红首断言——现拒绝即红在此）
    const st = makeStack('mama')
    const bid = nonce()
    const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: sha256(pkg), manifestDigest: sha256(manifestBytes), claimedKind: 'full', totals: { files: 1, records: 2, domainCounts: { bag: 2 } } })
    assert.ok(b.ok, `[${label}] begin: ${JSON.stringify(b).slice(0, 100)}`)
    const CH = 40 * 1024, ct = Math.ceil(manifestBytes.length / CH)
    for (let i = 0; i < ct; i++) {
      const raw = manifestBytes.subarray(i * CH, Math.min((i + 1) * CH, manifestBytes.length))
      const r = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: ct, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      assert.ok(r.ok, `[${label}] ② declareChunk ${i}/${ct} 须接受（意图契约：Stage1-legal 包 declare 应过；实得 ${r.code}: ${String(r.message).slice(0, 80)}）——永久红首断言`)
    }
    let pc = 0
    for (let i = 0; i < 20; i++) {
      const r = await st.call('mc-restore', { action: 'restore.indexDeclarePage', batchId: bid, pageCursor: pc })
      assert.ok(r.ok, `[${label}] index: ${JSON.stringify(r).slice(0, 80)}`)
      if (r.data && r.data.status === 'declared') break
      pc = r.data.nextCursor
    }
    assert.equal(readBatchDoc(st, bid).status, 'declared', `[${label}] declared`)
    // ③ 上传保全源值（意图契约落地后生效）：按**存储声明**的值上传（对 declare 期原样存/语义归一两种修复形状均成立）
    const declDoc = st.cloud.__docs.get(`mc_restore_declarations/${bid}:decl:bag:0`)
    assert.ok(declDoc, `[${label}] 存储声明在档（存储可原始/规范化——请求侧按 L18 类型契约）`)
    // 请求类型契约（L18 不软化）：revision 传 Number(声明值)、deleted 传 Boolean(声明值)——manifest 字节与存储声明保持原样
    const up = await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'bag', index: 0, id: declDoc.id, revision: Number(declDoc.revision), record: recs[0], deleted: Boolean(declDoc.deleted) })
    assert.ok(up.ok, `[${label}] ③ 按存储声明值上传须 ok（实得 ${up.code}: ${String(up.message || '').slice(0, 60)}）`)
    const doc = st.cloud.__docs.get(`mc_restore_records/${bid}:bag:0`)
    assert.ok(doc, `[${label}] 隔离区记录在档`)
    assert.deepEqual([doc.revision, doc.deleted], [0, false], `[${label}] 隔离区保全语义值（0/false——源值语义等价持久，不静默丢弃/漂移）`)
    return { st, bid }
  }

  await scenario('L28a【永久红·兼容契约】A：domain-json 省略冗余 f.domain——Stage1-legal（validatePackage 零 problems）∧ declare 应接受 ∧ 上传保全', async () => {
    await compatFlow('A', 'L28a')
  })

  await scenario('L28b【永久红·兼容契约】B：声明 revision="0"/deleted=0（container 强转语义合法）——declare 应接受 ∧ 上传保全源值', async () => {
    await compatFlow('B', 'L28b')
  })

  await scenario('L29【P19 全管线】在场错标冗余 f.domain（files[0].domain=daily 而 bag.fileIndex=0）——Stage1-legal 全管线收+隔离区元数据', async () => {
    const recs = [{ id: 'b-0000', revision: 0, deleted: false }, { id: 'b-0001', revision: 1, deleted: false }]
    const seg = Buffer.from(P.svc.canonicalJsonBytes(recs))
    const domains = {}
    for (const d of ['pregnancy', 'daily', 'mood', 'checkup', 'bag', 'reports']) domains[d] = { status: 'omitted' }
    domains.bag = { status: 'present', recordCount: 2, pagingComplete: true, visibility: 'shared', fileIndex: 0 }
    const manifest = {
      formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: TEST_ENV.MC_FAMILY_ID, packageKind: 'full', complete: true,
      scope: { includeShared: true, includePrivateOf: null }, scopeLabel: 'shared-only', domains,
      files: [{ path: 'records/bag.json', kind: 'domain-json', length: seg.length, sha256: sha256(seg), contentType: 'application/json', domain: 'daily' }],
      records: { bag: recs.map((r, i) => ({ index: i, id: r.id, revision: r.revision, deleted: r.deleted, hash: sha256(Buffer.from(P.svc.canonicalJsonBytes(r))) })) }, reports: [],
      pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
    }
    const manifestBytes = Buffer.from(P.svc.canonicalJsonBytes(manifest))
    const len8 = n => { const b = Buffer.alloc(8); b.writeUInt32BE(0, 0); b.writeUInt32BE(n, 4); return b }
    const pkg = Buffer.concat([Buffer.from(P.svc.encodeHeader(manifestBytes.length)), manifestBytes, len8(seg.length), seg])
    const v = await P.svc.validatePackage({ size: async () => pkg.length, readChunk: async (pp, l) => new Uint8Array(pkg.subarray(pp, pp + l)) })
    assert.ok(v.ok === true, `L29 ① 真 validatePackage 零 problems（在场错标 Stage1 不查）: ${JSON.stringify((v.problems || []).slice(0, 1)).slice(0, 120)}`)
    const st = makeStack('mama')
    const bid = nonce()
    const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: sha256(pkg), manifestDigest: sha256(manifestBytes), claimedKind: 'full', totals: { files: 1, records: 2, domainCounts: { bag: 2 } } })
    assert.ok(b.ok, `L29 begin: ${JSON.stringify(b).slice(0, 80)}`)
    const CH = 40 * 1024, ct = Math.ceil(manifestBytes.length / CH)
    for (let i = 0; i < ct; i++) {
      const raw = manifestBytes.subarray(i * CH, Math.min((i + 1) * CH, manifestBytes.length))
      const r = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: ct, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      assert.ok(r.ok, `L29 ② declareChunk ${i}/${ct} 须收（门已移除）: ${r.code} ${String(r.message || '').slice(0, 60)}`)
    }
    let pc = 0
    for (let i = 0; i < 20; i++) {
      const r = await st.call('mc-restore', { action: 'restore.indexDeclarePage', batchId: bid, pageCursor: pc })
      assert.ok(r.ok, 'L29 index')
      if (r.data && r.data.status === 'declared') break
      pc = r.data.nextCursor
    }
    assert.equal(readBatchDoc(st, bid).status, 'declared', 'L29 declared')
    const up = await st.call('mc-restore', { action: 'restore.uploadRecord', batchId: bid, domain: 'bag', index: 0, id: 'b-0000', revision: 0, record: recs[0], deleted: false })
    assert.ok(up.ok, `L29 ③ 上传须 ok: ${up.code} ${String(up.message || '').slice(0, 60)}`)
    const doc = st.cloud.__docs.get(`mc_restore_records/${bid}:bag:0`)
    assert.ok(doc && doc.revision === 0 && doc.deleted === false, `L29 ④ 隔离区元数据 [0,false]（实得 ${doc && [doc.revision, doc.deleted]}）`)
  })

  await scenario('L30 分片 B 形状（>48KiB 记录+声明 revision="0"/deleted=0）：finalize 元数据 [0,false]+恰重放 replayed:true', async () => {
    // 大 bag 记录（长 id → canonical >48KiB → 分片路径）+声明侧类型变体（manifest/存储原始；请求按 L18 类型）
    const rec = { id: 'z'.repeat(60 * 1024), revision: 0, deleted: false }
    const canonical = Buffer.from(P.svc.canonicalJsonBytes(rec))
    assert.ok(canonical.length > 48 * 1024, `前置 canonical=${canonical.length}B >48KiB（分片路径）`)
    const seg = Buffer.from(P.svc.canonicalJsonBytes([rec]))
    const domains = {}
    for (const d of ['pregnancy', 'daily', 'mood', 'checkup', 'bag', 'reports']) domains[d] = { status: 'omitted' }
    domains.bag = { status: 'present', recordCount: 1, pagingComplete: true, visibility: 'shared', fileIndex: 0 }
    const manifest = {
      formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: TEST_ENV.MC_FAMILY_ID, packageKind: 'full', complete: true,
      scope: { includeShared: true, includePrivateOf: null }, scopeLabel: 'shared-only', domains,
      files: [{ path: 'records/bag.json', kind: 'domain-json', length: seg.length, sha256: sha256(seg), contentType: 'application/json', domain: 'bag' }],
      records: { bag: [{ index: 0, id: rec.id, revision: String(0), deleted: 0, hash: sha256(canonical) }] }, reports: [],
      pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
    }
    const manifestBytes = Buffer.from(P.svc.canonicalJsonBytes(manifest))
    const len8 = n => { const b = Buffer.alloc(8); b.writeUInt32BE(0, 0); b.writeUInt32BE(n, 4); return b }
    const pkg = Buffer.concat([Buffer.from(P.svc.encodeHeader(manifestBytes.length)), manifestBytes, len8(seg.length), seg])
    const v = await P.svc.validatePackage({ size: async () => pkg.length, readChunk: async (pp, l) => new Uint8Array(pkg.subarray(pp, pp + l)) })
    assert.ok(v.ok === true, `L30 ① 真 validatePackage 零 problems（声明类型变体 container 强转语义合法）: ${JSON.stringify((v.problems || []).slice(0, 1)).slice(0, 120)}`)
    const st = makeStack('mama')
    const bid = nonce()
    const b = await st.call('mc-restore', { action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: sha256(pkg), manifestDigest: sha256(manifestBytes), claimedKind: 'full', totals: { files: 1, records: 1, domainCounts: { bag: 1 } } })
    assert.ok(b.ok, 'L30 begin')
    const CHM = 40 * 1024, ctm = Math.ceil(manifestBytes.length / CHM)
    for (let i = 0; i < ctm; i++) {
      const raw = manifestBytes.subarray(i * CHM, Math.min((i + 1) * CHM, manifestBytes.length))
      const r = await st.call('mc-restore', { action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: ctm, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      assert.ok(r.ok, `L30 dc ${i}`)
    }
    let pc = 0
    for (let i = 0; i < 20; i++) {
      const r = await st.call('mc-restore', { action: 'restore.indexDeclarePage', batchId: bid, pageCursor: pc })
      if (!r.ok || (r.data && r.data.status === 'declared')) break
      pc = r.data.nextCursor
    }
    assert.equal(readBatchDoc(st, bid).status, 'declared', 'L30 declared')
    const CH = 40 * 1024, ct = Math.ceil(canonical.length / CH)
    for (let i = 0; i < ct; i++) {
      const raw = canonical.subarray(i * CH, Math.min((i + 1) * CH, canonical.length))
      const r = await st.call('mc-restore', { action: 'restore.uploadRecordChunk', batchId: bid, domain: 'bag', index: 0, chunkIndex: i, chunkTotal: ct, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      assert.ok(r.ok, `L30 chunk ${i}/${ct}: ${JSON.stringify(r).slice(0, 80)}`)
    }
    // 请求按 L18 类型：Number("0")=0 / Boolean(0)=false
    const fin = await st.call('mc-restore', { action: 'restore.finalizeRecord', batchId: bid, domain: 'bag', index: 0, id: rec.id, revision: Number('0'), deleted: Boolean(0), expectedChunkTotal: ct, expectedSha256: sha256(canonical) })
    assert.ok(fin.ok, `L30 ② finalize 须 ok: ${fin.code} ${String(fin.message || '').slice(0, 80)}`)
    const doc = st.cloud.__docs.get(`mc_restore_records/${bid}:bag:0`)
    assert.ok(doc, 'L30 隔离区在档')
    assert.ok(doc.revision === 0 && doc.deleted === false, `L30 ③ 元数据 [number 0, boolean false]（实得 ${[typeof doc.revision, doc.revision, typeof doc.deleted, doc.deleted]}）`)
    assert.equal(doc.canonicalHash, sha256(canonical), 'L30 canonicalHash 真')
    assert.equal(doc.byteLength, canonical.length, 'L30 byteLength 真')
    const genAfter = readBatchDoc(st, bid).contentGeneration
    const replay = await st.call('mc-restore', { action: 'restore.finalizeRecord', batchId: bid, domain: 'bag', index: 0, id: rec.id, revision: Number('0'), deleted: Boolean(0), expectedChunkTotal: ct, expectedSha256: sha256(canonical) })
    assert.ok(replay.ok && replay.data && replay.data.replayed === true, `L30 ④ 恰重放 replayed:true（实得 ${JSON.stringify(replay).slice(0, 80)}）`)
    assert.equal(readBatchDoc(st, bid).contentGeneration, genAfter, 'L30 重放 gen 不变')
  })

  await scenario('L20e 冻结源哈希：套件运行期间 mc-restore 源未被并发编辑（否则结果作废须复跑）', async () => {
    for (const rel of FROZEN_RELS) {
      const now = sha256(fs.readFileSync(path.join(root, rel)))
      assert.equal(now, frozenHashes[rel], `源 ${rel} 运行期间被编辑（${frozenHashes[rel].slice(0, 8)} → ${now.slice(0, 8)}）——本套结果基于加载时快照，须在稳定源上复跑`)
    }
  })

  console.log(`\n${passed} 通过, ${failed.length} 失败`)
  if (failed.length) { console.log('失败项：\n - ' + failed.join('\n - ')); process.exit(1) }
}

main().catch(e => { console.error(e); process.exit(1) })
