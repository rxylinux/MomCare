// B3b 阶段二：D25 handler 首目语义真路径回归 rev1
// 协调方指派 2026-09-20（=记忆待办"G2 真 handler 测试属 post-code 门强制项"；
// docs PHASE_B3B_STAGE2_CODE_REVIEW·D25-r2/D25-h）：
//   真 Stage1 validatePackage 全包（单报告正文 1 附件 + manifest 同 reportId 双映射：
//   首目含匹配附件 + 尾随有效空）→ 真实 mc-restore handler **begin→declareChunk→indexDeclarePage**
//   → 持久声明 frozenReportAttachments 须=**首目**非空映射（首目胜——无静默丢失）
//   → 真实 uploadRecord 以真正文过冻结逐位核对（index.js :245-260）。
// 反例历史（75ecf9c9 前）：indexDeclarePage reportsMapById 曾 Map.set **尾目胜**——G2 形冻结 []
// → 真正文 uploadRecord 必败"正文附件数 1 ≠ 冻结映射 0"（原始映射静默丢失）。
// 变体（各带独立真包+独立栈+独立 batchId；前置显式：仅当该**精确全包** Stage1 validatePackage
// ok 零 problems 才跑 handler 腿）：
//   V1 尾随 attachments:[]；V2 尾随 attachments:{}（空对象——D26 归一）；V3 尾随 attachments:[]+own "__proto__" 键。
// 不修改生产/协议；**不标记 B3b 已验收**。冻结源哈希加载时快照/结束复核（期间并发编辑则本轮作废）。
// 执行史（rev1 首跑 3/9 红先行——真缺陷坐实）：三变体 Stage1 validatePackage 全 ok（container
// .validateManifest :176 仅 duplicate-report-order——无 reportId 一对一拒），但 handler
// declareChunk 末片 validateManifestSchema **index.js :482 多加"重复 reportId（映射须与
// records.reports 一对一）"**——比其自称对齐（:12/:353"与阶段一 container.validateManifest
// 结构子集逐项对齐"）的容器实现更严 → D25-r2 裁定形（Stage1 find-first 接受）在 declare 门被拒
// → 批次永不到 indexing → indexDeclarePage :872-874 首目胜冻结代码对这些形**不可达（死径）**。
// 修复方向（报 CODING——本套件红先行保持）：:482 对齐容器语义（撤一对一拒——保留 duplicate-
// report-order+referencedBy 闭包），令 find-first 重复形过 declare 到达首目胜冻结。
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-b3b2-d25fm-'))
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')
const nonce = () => 'rst_' + crypto.randomBytes(16).toString('hex') // 128-bit CSPRNG（§5.0）

const HANDLER_REL = 'cloud/functions/mc-restore/index.js'
if (!fs.existsSync(path.join(root, HANDLER_REL))) { console.log('mc-restore handler 未落地'); process.exit(3) }

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }

const DIST = path.join(temp, 'cf')
{ const dir = path.join(DIST, 'mc-restore'); fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(path.join(root, HANDLER_REL), path.join(dir, 'index.js'))
  fs.cpSync(path.join(root, 'cloud/shared'), path.join(dir, 'shared'), { recursive: true }) }

// ── 冻结源哈希（加载时快照→结束复核；漂移=本轮作废）──
const FROZEN_RELS = ['cloud/functions/mc-restore/index.js', 'cloud/functions/mc-restore/v20.js', 'cloud/shared/auth.js', 'cloud/shared/config.js', 'cloud/shared/respond.js', 'cloud/shared/constants.js']
const frozenHashes = Object.fromEntries(FROZEN_RELS.map(rel => [rel, sha256(fs.readFileSync(path.join(root, rel)))]))
console.log('冻结源哈希（加载时快照）:')
for (const [rel, h] of Object.entries(frozenHashes)) console.log(`  ${h.slice(0, 8)}  ${rel}`)

// Stage1 容器/canonical（独立 bundle——与 handler 同源实现）
const svcPath = path.join(temp, 'stage1.cjs')
esbuild.buildSync({ stdin: { contents: `export * from "@/utils/mcpkg/canonical.js";export * from "@/utils/mcpkg/container.js";`, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: svcPath, logLevel: 'silent' })
const stage1 = require(svcPath)

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-b3b2d25', MC_MEMBER_MAMA_OPENID: 'oTESTMAMA123456', MC_MEMBER_PAPA_OPENID: 'oTESTPAPA456789' }

// ── Mock 云（版本 CAS 事务——与 Stage2 套件同构）──
function makeMockCloud() {
  const docs = new Map(), storedFiles = new Map()
  const state = { caller: TEST_ENV.MC_MEMBER_MAMA_OPENID, initialized: false }
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
  function runQuery(col, filters) {
    let rows = [...docs.entries()].filter(([k]) => k.startsWith(col + '/')).map(([k, e]) => ({ ...clone(e), _id: k.slice(col.length + 1) }))
    for (const [k2, c2] of Object.entries(filters || {})) rows = rows.filter(x => JSON.stringify(x[k2]) === JSON.stringify(c2))
    return rows.slice(0, 100)
  }
  function mq(col, f) { return { orderBy: () => mq(col, f), limit: () => mq(col, f), get: async () => ({ data: runQuery(col, f) }) } }
  const db = {
    command: { lt: v => ({ __op: 'lt', v }), gt: v => ({ __op: 'gt', v }), inc: v => ({ __op: 'inc', v }) },
    startTransaction: async () => {
      const tx = { reads: new Map(), writes: new Map(), removes: new Set() }
      return {
        collection: c => ({ doc: id => docApi(c, id, tx) }),
        commit: async () => {
          for (const [k, rv] of tx.reads) { const cur2 = docs.get(k); if ((cur2 ? cur2.__v : 0) !== rv) { const err = new Error('transaction conflict: ' + k); err.errCode = 'CONFLICT'; throw err } }
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
    __docs: docs, __stored: storedFiles, __state: state,
  }
}
const storage = new Map()
global.uni = { getStorageSync(k) { return storage.has(k) ? storage.get(k) : '' }, setStorageSync(k, v) { storage.set(k, v) }, removeStorageSync(k) { storage.delete(k) }, showToast() {}, showLoading() {}, hideLoading() {} }

function requireRestore() { delete require.cache[require.resolve(path.join(DIST, 'mc-restore/index.js'))]; return require(path.join(DIST, 'mc-restore/index.js')) }
function makeStack() {
  for (const k of [...storage.keys()]) if (k.startsWith('mc_') || k.startsWith('YUNTU_')) storage.delete(k)
  const cloud = makeMockCloud()
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID; process.env.MC_UPLOAD_ENABLED = 'true'
  cloud.__state.caller = TEST_ENV.MC_MEMBER_MAMA_OPENID
  const hRestore = requireRestore()
  hRestore.__setCloud(cloud)
  return { cloud, call: (event) => hRestore.main(event) }
}

// ── D25 夹具：真全包（单报告 1 附件+同 reportId 双映射：首目非空+尾随有效空）──
const RID = 'rp-d25-first'
const OID = 'd25-oid'
const DOMAIN_ORDER = ['pregnancy', 'daily', 'mood', 'checkup', 'bag', 'reports']
const FIRST_ATTS = [{ order: 0, originalFileId: OID, fileIndex: 0 }] // 首目非空映射（冻结期望值）

function buildD25Pkg(variant) { // 'v1-array' | 'v2-object' | 'v3-proto'
  const body = { id: RID, revision: 0, deleted: false, attachments: [{ fileId: OID, order: 0 }] }
  const seg = Buffer.from(stage1.canonicalJsonBytes([body]))
  const attBytes = Buffer.alloc(8, 0x44)
  let trailing
  if (variant === 'v1-array') trailing = { reportId: RID, revision: 0, deleted: false, attachments: [] }
  else if (variant === 'v2-object') trailing = { reportId: RID, revision: 0, deleted: false, attachments: {} }
  else if (variant === 'v3-proto') trailing = JSON.parse('{"reportId":"' + RID + '","revision":0,"deleted":false,"attachments":[],"__proto__":{"x":1}}')
  else throw new Error('unknown variant ' + variant)
  const domains = {}
  for (const d of DOMAIN_ORDER) domains[d] = { status: 'omitted' }
  domains.reports = { status: 'present', recordCount: 1, pagingComplete: true, visibility: 'shared', fileIndex: 1 }
  const manifest = {
    formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: TEST_ENV.MC_FAMILY_ID, packageKind: 'full', complete: true,
    scope: { includeShared: true, includePrivateOf: null }, scopeLabel: 'shared-only',
    domains,
    files: [
      { path: 'attachments/d25.bin', kind: 'attachment', length: attBytes.length, sha256: sha256(attBytes), contentType: 'image/png', originalFileId: OID, chunkSha256: [sha256(attBytes)], referencedBy: [RID] },
      { path: 'records/reports.json', kind: 'domain-json', length: seg.length, sha256: sha256(seg), contentType: 'application/json', domain: 'reports' },
    ],
    records: { reports: [{ index: 0, id: RID, revision: 0, deleted: false, hash: sha256(Buffer.from(stage1.canonicalJsonBytes(body))) }] },
    reports: [
      { reportId: RID, revision: 0, deleted: false, attachments: FIRST_ATTS.map(a => ({ ...a })) }, // 首目：含匹配附件
      trailing, // 尾随：有效空（[]/{}/[]+own proto 键——按变体）
    ],
    pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
  }
  const manifestBytes = Buffer.from(stage1.canonicalJsonBytes(manifest))
  const len8 = n => { const b = Buffer.alloc(8); b.writeUInt32BE(0, 0); b.writeUInt32BE(n, 4); return b }
  const parts = [Buffer.from(stage1.encodeHeader(manifestBytes.length)), manifestBytes, len8(attBytes.length), attBytes, len8(seg.length), seg]
  const pkg = Buffer.concat(parts)
  const totals = { files: manifest.files.length, records: 1, domainCounts: { reports: 1 } }
  return { pkg, manifest, manifestBytes, manifestDigest: sha256(manifestBytes), packageDigest: sha256(pkg), totals, body }
}
async function stage1Validate(pkg) {
  return stage1.validatePackage({ size: async () => pkg.length, readChunk: async (p, l) => new Uint8Array(pkg.subarray(p, p + l)) })
}

async function main() {
  console.log(`\nB3b D25 handler 首目语义真路径回归 rev1（begin→declareChunk→indexDeclarePage→uploadRecord）\n`)

  for (const [variant, label] of [['v1-array', 'V1 尾随 []'], ['v2-object', 'V2 尾随 {}（空对象）'], ['v3-proto', 'V3 尾随 []+own __proto__ 键']]) {
    const F = buildD25Pkg(variant)
    const S = {}

    await scenario(`[${label}] ① 前置：该精确全包 Stage1 validatePackage ok 零 problems（显式前置——拒则后续 handler 腿不可跑）`, async () => {
      const v = await stage1Validate(F.pkg)
      assert.ok(v.ok, `Stage1 须接受（实得 problems=${JSON.stringify((v.problems || []).slice(0, 1)).slice(0, 140)}）——首非空+尾随有效空同 reportId 为 Stage1-valid（find-first）`)
      // 尾随形核验（防夹具走样）
      const t = F.manifest.reports[1]
      if (variant === 'v2-object') assert.ok(!Array.isArray(t.attachments) && Object.keys(t.attachments).length === 0, '尾随须非数组空对象')
      if (variant === 'v3-proto') assert.ok(Object.hasOwn(t, '__proto__'), '尾随须 own __proto__ 键存活（canonical 序列化进包）')
      assert.ok(F.manifestBytes.includes('"__proto__"') === (variant === 'v3-proto'), '包字节 proto 键在场性须与变体一致')
    })

    await scenario(`[${label}] ② 真路径 walk：begin→declareChunk(40KiB 规范分片)→indexDeclarePage→declared`, async () => {
      S.stack = makeStack()
      S.batchId = nonce()
      const b = await S.stack.call({ action: 'restore.begin', batchId: S.batchId, formatVersion: 1, packageDigest: F.packageDigest, manifestDigest: F.manifestDigest, claimedKind: 'full', totals: F.totals })
      assert.ok(b.ok, `begin: ${JSON.stringify(b).slice(0, 160)}`)
      const CHUNK = 40 * 1024, total = Math.ceil(F.manifestBytes.length / CHUNK)
      for (let i = 0; i < total; i++) {
        const raw = F.manifestBytes.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, F.manifestBytes.length))
        const r = await S.stack.call({ action: 'restore.declareChunk', batchId: S.batchId, chunkIndex: i, chunkTotal: total, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
        assert.ok(r.ok, `declareChunk ${i}/${total}: ${JSON.stringify(r).slice(0, 160)}`)
      }
      let declared = false
      for (let i = 0; i < 30; i++) {
        const r = await S.stack.call({ action: 'restore.indexDeclarePage', batchId: S.batchId })
        assert.ok(r.ok, `indexDeclarePage: ${JSON.stringify(r).slice(0, 200)}`)
        if (r.data && (r.data.status === 'declared' || r.data.hasMore === false)) { declared = r.data.status === 'declared' || declared; break }
      }
      assert.ok(declared, '须到 declared')
      const batch = S.stack.cloud.__docs.get(`mc_restore_batches/${S.batchId}`)
      assert.strictEqual(batch.status, 'declared', `批次终态（实得 ${batch.status}）`)
    })

    await scenario(`[${label}] ③ 持久声明 frozenReportAttachments=首目非空映射（首目胜——无静默丢失；旧尾目胜形此处为 []）`, async () => {
      const decl = S.stack.cloud.__docs.get(`mc_restore_declarations/${S.batchId}:decl:reports:0`)
      assert.ok(decl, 'reports:0 声明文档须在场')
      const frozen = decl.frozenReportAttachments
      assert.ok(Array.isArray(frozen), `frozenReportAttachments 须数组（实得 ${typeof frozen}）`)
      assert.strictEqual(frozen.length, 1, `首目非空映射须冻结 1 项（实得 ${frozen.length}——0 即尾目胜静默丢失）`)
      assert.deepStrictEqual(frozen, FIRST_ATTS, `冻结项须=首目精确内容 ${JSON.stringify(FIRST_ATTS)}（实得 ${JSON.stringify(frozen)}）`)
      console.log(`      frozen=${JSON.stringify(frozen)}`)
    })

    await scenario(`[${label}] ④ 真上传路径：uploadRecord 真正文（1 附件）过冻结逐位核对——ok 且记录持久`, async () => {
      const r = await S.stack.call({ action: 'restore.uploadRecord', batchId: S.batchId, domain: 'reports', index: 0, id: RID, revision: 0, deleted: false, record: F.body })
      assert.ok(r.ok, `uploadRecord 须 ok（真正文=首目映射的附件集——冻结逐位核对须过；旧尾目胜形必败"正文附件数 1 ≠ 冻结映射 0"）（实得 ${JSON.stringify(r).slice(0, 160)}）`)
      const rec = S.stack.cloud.__docs.get(`mc_restore_records/${S.batchId}:reports:0`)
      assert.ok(rec, '记录文档须持久')
      assert.deepStrictEqual(rec.record.attachments, F.body.attachments, '持久记录附件须=正文原样（无丢失）')
      console.log(`      记录持久 attachments=${JSON.stringify(rec.record.attachments)}`)
    })
  }

  // ── 冻结源复核（漂移=本轮作废）──
  console.log('\n冻结源复核:')
  let drifted = false
  for (const [rel, h] of Object.entries(frozenHashes)) {
    const now = sha256(fs.readFileSync(path.join(root, rel)))
    const same = now === h
    if (!same) drifted = true
    console.log(`  ${now.slice(0, 8)} ${same ? '==' : '≠'}  ${rel}`)
  }
  if (drifted) failed.push('冻结源漂移：加载时≠结束时（本轮作废——须复跑）')

  console.log(`\n${passed} 通过, ${failed.length} 失败`)
  if (failed.length) { console.log('失败项：\n - ' + failed.join('\n - ')); process.exit(1) }
  console.log('（本回归不构成 B3b 验收——Phase2 端点 commit/verify/abandon 未实现，Stage2 主套件 82/3 维持）')
}
main().catch(e => { console.error('FATAL', e); process.exit(2) })
