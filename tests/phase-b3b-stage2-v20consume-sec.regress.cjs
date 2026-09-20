// B3b 阶段二：V20 消费→上传链路安全门——真 handler 红先行套件 rev1（独立——不触生产/冻结套件）
// 协调方指派 2026-09-20（消费器开码前末道安全门）：
//   S0 正向：begin→declare→finalize→**V20 块消费成功**后 uploadRecord 须 ok——且 record 声明
//   **不复制完整附件映射**（薄指针链——§6.5：附件映射经已验证 rmappart/refs 指针重建）。
//   T1-T4 存储篡改（逐一）：①record 声明 id 篡改（正文原样）②revision 篡改 ③rmappart/refs 薄指针
//   blockIndex 指错块 ④索引后底层已验证块 proof 腐蚀——真实 uploadRecord 调用须**拒＋零写**、
//   不得信任被改声明/指针（§6.5：声明字段须对已验证块核对——指针→readVerifiedBlock→根折叠）。
//   **证据分级（审查澄清 2026-09-20）**：T1/T2 发送原始正文——现行 uploadRecord 的普通"请求-声明"
//   失配检查即拒，**不证明 Merkle 链接声明读**（保留为失配检查，证据有限）。**T5 强测**：篡改许可
//   正文字段 note＋**重算持久声明 hash 使其与篡改正文自洽**（普通 id/revision/hash 检查按构造全过）
//   ——信任被改声明的实现会接受；正确的 V20 已验证记录链接必须拒（声明已不匹配**冻结块**）＋零写。
//   T5 调用前自检：篡改正文过普通形状（键 ⊆ reports 白名单）∧ 篡改声明 hash=sha256(canonical(篡改
//   正文))——保证红/绿皆落 Merkle 链接读这一预期原因，非形状/hash 检查伪因。
//   **L2 legacy 正控（T5 效力证明——审查补 2026-09-20）**：同一夹具走 flag-off legacy 到 declared，
//   同样把声明 hash 篡改至 note 改写正文自洽→uploadRecord **须成功并持久**——实证普通形状/hash/id
//   /revision/冻结映射检查对自洽篡改**全盲**（静态白名单+hash 等值不证明验证器会收——须执行证明）；
//   故 T5 的拒绝只能来自 Merkle 链接读：若 V20 实现缺链接验证，T5 将复现 L2 的接受——T5 具判别力。
// 诚实框架：现行源 b441b8f4 的 V20 消费按 E11 门拒——S0 正向前置即红；T1-T4 骑同一前置，
//   **篡改检查在消费器+上传链接实现后激活**——本套件不声称篡改检测现已生效（红基线如实）。
//   L1 legacy 正控（绿）：同夹具 legacy 全程→uploadRecord ok——证明夹具与上传Record 机制今日即通
//   （S0 红可纯归因消费器缺失）。
// maxTx 计数口径=单事务写数。修复后同哈希须全绿；源漂移轮不作冻结证据。
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-b3b2-sec-'))
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')
const nonce = () => 'rst_' + crypto.randomBytes(16).toString('hex')

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }

const DIST = path.join(temp, 'cf')
{ const dir = path.join(DIST, 'mc-restore'); fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(path.join(root, 'cloud/functions/mc-restore/index.js'), path.join(dir, 'index.js'))
  fs.cpSync(path.join(root, 'cloud/shared'), path.join(dir, 'shared'), { recursive: true })
  fs.copyFileSync(path.join(root, 'cloud/functions/mc-restore/v20.js'), path.join(dir, 'v20.js')) }

const FROZEN_RELS = ['cloud/functions/mc-restore/index.js', 'cloud/functions/mc-restore/v20.js', 'cloud/shared/auth.js', 'cloud/shared/config.js', 'cloud/shared/respond.js', 'cloud/shared/constants.js']
const frozenHashes = Object.fromEntries(FROZEN_RELS.map(rel => [rel, sha256(fs.readFileSync(path.join(root, rel)))]))
console.log('冻结源哈希（加载时快照）:')
for (const [rel, h] of Object.entries(frozenHashes)) console.log(`  ${h.slice(0, 8)}  ${rel}`)

const stage1Path = path.join(temp, 'stage1.cjs')
esbuild.buildSync({ stdin: { contents: `export * from "@/utils/mcpkg/canonical.js";export * from "@/utils/mcpkg/container.js";`, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: stage1Path, logLevel: 'silent' })
const stage1 = require(stage1Path)
const v20Out = path.join(temp, 'v20.cjs')
esbuild.buildSync({ entryPoints: [path.join(root, 'cloud/functions/mc-restore/v20.js')], bundle: true, platform: 'node', format: 'cjs', outfile: v20Out, logLevel: 'silent' })
const v20 = require(v20Out)

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-b3b2sec', MC_MEMBER_MAMA_OPENID: 'oTESTMAMA123456', MC_MEMBER_PAPA_OPENID: 'oTESTPAPA456789' }

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
function makeStack(flagValue = 'true') {
  for (const k of [...storage.keys()]) if (k.startsWith('mc_') || k.startsWith('YUNTU_')) storage.delete(k)
  const cloud = makeMockCloud()
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID; process.env.MC_UPLOAD_ENABLED = 'true'
  if (flagValue === 'off') delete process.env.MC_RESTORE_V20_ENABLED
  else process.env.MC_RESTORE_V20_ENABLED = flagValue
  cloud.__state.caller = TEST_ENV.MC_MEMBER_MAMA_OPENID
  const hRestore = requireRestore()
  hRestore.__setCloud(cloud)
  return { cloud, call: (event) => hRestore.main(event) }
}
const writeSnapshot = (stack) => new Map([...stack.cloud.__docs.entries()].map(([k, e]) => [k, e.__v]))
function assertZeroWrites(before, stack, label) {
  const after = writeSnapshot(stack)
  assert.strictEqual(after.size, before.size, `${label} 不得新增文档`)
  for (const [k, v] of after) assert.strictEqual(v, before.get(k), `${label} 零写失败：${k} __v ${before.get(k)}→${v}`)
}

const DOMAIN_ORDER = ['pregnancy', 'daily', 'mood', 'checkup', 'bag', 'reports']
const RID = 'rp-sec-att', OID = 'sec-oid'
const FIRST_ATTS = [{ order: 0, originalFileId: OID, fileIndex: 0 }]
function buildSecPkg() { // 单报告+单附件 → [record,file,refs,rmappart] 单块
  // 正文原生带长 note（白名单许可字段）：T5/L2 的 note 改写为**改短**——自洽篡改后正文 ≤ 原文，
  // 聚合字节门（frozenDomainBytes=原 seg 长）按构造可过——普通检查全盲前提成立（审查效力检查）
  const body = { id: RID, revision: 0, deleted: false, note: 'x'.repeat(60), attachments: [{ fileId: OID, order: 0 }] }
  const seg = Buffer.from(stage1.canonicalJsonBytes([body]))
  const attBytes = Buffer.alloc(8, 0x53)
  const domains = {}
  for (const d of DOMAIN_ORDER) domains[d] = { status: 'omitted' }
  domains.reports = { status: 'present', recordCount: 1, pagingComplete: true, visibility: 'shared', fileIndex: 1 }
  const manifest = {
    formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: TEST_ENV.MC_FAMILY_ID, packageKind: 'full', complete: true,
    scope: { includeShared: true, includePrivateOf: null }, scopeLabel: 'shared-only', domains,
    files: [
      { path: 'attachments/sec.bin', kind: 'attachment', length: attBytes.length, sha256: sha256(attBytes), contentType: 'image/png', originalFileId: OID, chunkSha256: [sha256(attBytes)], referencedBy: [RID] },
      { path: 'records/reports.json', kind: 'domain-json', length: seg.length, sha256: sha256(seg), contentType: 'application/json', domain: 'reports' },
    ],
    records: { reports: [{ index: 0, id: RID, revision: 0, deleted: false, hash: sha256(Buffer.from(stage1.canonicalJsonBytes(body))) }] },
    reports: [{ reportId: RID, revision: 0, deleted: false, attachments: FIRST_ATTS.map(a => ({ ...a })) }],
    pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
  }
  const manifestBytes = Buffer.from(stage1.canonicalJsonBytes(manifest))
  const len8 = n => { const b = Buffer.alloc(8); b.writeUInt32BE(0, 0); b.writeUInt32BE(n, 4); return b }
  const pkg = Buffer.concat([Buffer.from(stage1.encodeHeader(manifestBytes.length)), manifestBytes, len8(attBytes.length), attBytes, len8(seg.length), seg])
  return { pkg, manifestBytes, body, manifestDigest: sha256(manifestBytes), packageDigest: sha256(pkg), totals: { files: 2, records: 1, domainCounts: { reports: 1 } } }
}
async function stage1Validate(pkg) {
  return stage1.validatePackage({ size: async () => pkg.length, readChunk: async (p, l) => new Uint8Array(pkg.subarray(p, p + l)) })
}
function deriveIndependent(F) {
  const off = F.pkg.indexOf(F.manifestBytes)
  const wire = JSON.parse(F.pkg.subarray(off, off + F.manifestBytes.length).toString('utf8'))
  const stream = v20.deriveV20Stream(wire)
  const blocks = v20.packBlocks(stream)
  const tree = v20.buildTree(blocks)
  return { blocks, totalBlocks: blocks.length, totalEntries: stream.count, planRoot: tree.root.toString('hex'), proofs: tree.proofs }
}
async function walkToIndexing(F, D, stack) {
  const batchId = nonce()
  const b = await stack.call({ action: 'restore.begin', batchId, formatVersion: 1, packageDigest: F.packageDigest, manifestDigest: F.manifestDigest, claimedKind: 'full', totals: F.totals })
  assert.ok(b.ok, `begin: ${JSON.stringify(b).slice(0, 140)}`)
  const CHUNK = 40 * 1024, total = Math.ceil(F.manifestBytes.length / CHUNK)
  for (let i = 0; i < total; i++) {
    const raw = F.manifestBytes.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, F.manifestBytes.length))
    const r = await stack.call({ action: 'restore.declareChunk', batchId, chunkIndex: i, chunkTotal: total, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
    assert.ok(r.ok, `declareChunk ${i}: ${JSON.stringify(r).slice(0, 140)}`)
  }
  assert.strictEqual(stack.cloud.__docs.get(`mc_restore_batches/${batchId}`).status, 'preparing', '前置 preparing')
  for (let i = 0; i < D.totalBlocks; i++) {
    const r = await stack.call({ action: 'restore.finalizeDeclare', batchId, blockIndex: i, blockB64: D.blocks[i].toString('base64'), proof: D.proofs[i] })
    assert.ok(r.ok, `finalize 块${i}: ${JSON.stringify(r).slice(0, 140)}`)
  }
  assert.strictEqual(stack.cloud.__docs.get(`mc_restore_batches/${batchId}`).status, 'indexing', '前置 indexing')
  return batchId
}
async function main() {
  console.log(`\nB3b V20 消费→上传链路安全门（诚实框架：S0/T1-T4 骑正向前置红——篡改腿随消费实现激活）rev1\n`)

  const FX = {}
  await scenario('P0-① 单报告单附件夹具钉：Stage1 ok＋独立派定 [record,file,refs,rmappart]×1 单块', async () => {
    FX.F = buildSecPkg()
    const v = await stage1Validate(FX.F.pkg)
    assert.ok(v.ok, `Stage1 ok（${JSON.stringify((v.problems || []).slice(0, 1)).slice(0, 100)}）`)
    FX.D = deriveIndependent(FX.F)
    assert.strictEqual(FX.D.totalBlocks, 1)
    assert.strictEqual(FX.D.totalEntries, 4)
    console.log(`      块0=${FX.D.blocks[0].length}B｜root=${FX.D.planRoot.slice(0, 16)}…`)
  })

  await scenario('L1 legacy 正控：同夹具 legacy 全程 declared→uploadRecord ok（夹具与上传机制今日即通——S0 红可纯归因消费器缺失）', async () => {
    const stack = makeStack('off')
    const bid = nonce()
    const F = FX.F
    const b = await stack.call({ action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: F.packageDigest, manifestDigest: F.manifestDigest, claimedKind: 'full', totals: F.totals })
    assert.ok(b.ok, 'begin')
    const CHUNK = 40 * 1024, total = Math.ceil(F.manifestBytes.length / CHUNK)
    for (let i = 0; i < total; i++) {
      const raw = F.manifestBytes.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, F.manifestBytes.length))
      const r = await stack.call({ action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: total, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      assert.ok(r.ok, `chunk ${i}: ${JSON.stringify(r).slice(0, 110)}`)
    }
    for (let i = 0; i < 30; i++) {
      const r = await stack.call({ action: 'restore.indexDeclarePage', batchId: bid })
      assert.ok(r.ok, `legacy indexPage: ${JSON.stringify(r).slice(0, 110)}`)
      if (r.data && (r.data.status === 'declared' || r.data.hasMore === false)) break
    }
    assert.strictEqual(stack.cloud.__docs.get(`mc_restore_batches/${bid}`).status, 'declared', 'legacy declared')
    const u = await stack.call({ action: 'restore.uploadRecord', batchId: bid, domain: 'reports', index: 0, id: RID, revision: 0, deleted: false, record: FX.F.body })
    assert.ok(u.ok, `legacy uploadRecord 须 ok（正控——实得 ${JSON.stringify(u).slice(0, 120)}）`)
  })

  // ══ L2 legacy 正控：T5 效力证明（普通检查对自洽篡改全盲——现行源即绿）══
  await scenario('L2 legacy 正控（T5 效力证明）：legacy declared 后同样篡改声明 hash 至 note 改写正文自洽→uploadRecord **须成功并持久**——普通检查全盲，T5 拒绝只能来自 Merkle 链接读', async () => {
    const stack = makeStack('off')
    const bid = nonce()
    const F = FX.F
    const b = await stack.call({ action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: F.packageDigest, manifestDigest: F.manifestDigest, claimedKind: 'full', totals: F.totals })
    assert.ok(b.ok, 'begin')
    const CHUNK = 40 * 1024, total = Math.ceil(F.manifestBytes.length / CHUNK)
    for (let i = 0; i < total; i++) {
      const raw = F.manifestBytes.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, F.manifestBytes.length))
      const r = await stack.call({ action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: total, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      assert.ok(r.ok, `chunk ${i}: ${JSON.stringify(r).slice(0, 110)}`)
    }
    for (let i = 0; i < 30; i++) {
      const r = await stack.call({ action: 'restore.indexDeclarePage', batchId: bid })
      assert.ok(r.ok, `legacy indexPage: ${JSON.stringify(r).slice(0, 110)}`)
      if (r.data && (r.data.status === 'declared' || r.data.hasMore === false)) break
    }
    assert.strictEqual(stack.cloud.__docs.get(`mc_restore_batches/${bid}`).status, 'declared', 'legacy declared')
    // 与 T5 同构篡改：许可字段 note＋声明 hash 重算自洽
    const alteredBody = { ...F.body, note: 'tampered-note' }
    const decl = stack.cloud.__docs.get(`mc_restore_declarations/${bid}:decl:reports:0`)
    assert.ok(decl, 'legacy 声明在场（含 frozenReportAttachments——legacy 复制语义）')
    decl.hash = sha256(Buffer.from(stage1.canonicalJsonBytes(alteredBody)))
    const u = await stack.call({ action: 'restore.uploadRecord', batchId: bid, domain: 'reports', index: 0, id: RID, revision: 0, deleted: false, record: alteredBody })
    assert.ok(u.ok, `legacy 自洽篡改须被**接受**（效力证明——普通形状/hash/id/revision/冻结映射检查全盲；实得 ${JSON.stringify(u).slice(0, 140)}）`)
    const rec = stack.cloud.__docs.get(`mc_restore_records/${bid}:reports:0`)
    assert.ok(rec, '记录持久')
    assert.strictEqual(rec.record.note, 'tampered-note', '篡改正文被持久——T5 若缺 Merkle 链接将复现此接受（判别力实证）')
  })

  // ══ S0 正向：消费成功→uploadRecord ok 且不复制映射【预期红——现行 E11 门拒消费】══
  await scenario('S0 正向：begin→declare→finalize→**V20 消费成功**→declared→uploadRecord ok——且 record 声明**不复制完整附件映射**（薄指针链：rmappart/refs 指针在场）【红：消费未实现】', async () => {
    const stack = makeStack('true')
    const bid = await walkToIndexing(FX.F, FX.D, stack)
    for (let i = 0; i < FX.D.totalBlocks; i++) {
      const r = await stack.call({ action: 'restore.indexDeclarePage', batchId: bid, blockIndex: i })
      assert.ok(r.ok, `消费块${i} 须 ok（实得 ${JSON.stringify(r).slice(0, 130)}）`)
    }
    assert.strictEqual(stack.cloud.__docs.get(`mc_restore_batches/${bid}`).status, 'declared', '前置 declared')
    const decl = stack.cloud.__docs.get(`mc_restore_declarations/${bid}:decl:reports:0`)
    assert.ok(decl, 'record 声明在场')
    assert.ok(!Array.isArray(decl.frozenReportAttachments), `record 声明不得复制完整附件映射（薄指针链——实得 frozenReportAttachments=${JSON.stringify(decl.frozenReportAttachments)}）`)
    const ptrs = [...stack.cloud.__docs.keys()].filter(k => k.startsWith(`mc_restore_declarations/${bid}:ptr:`)).map(k => stack.cloud.__docs.get(k))
    assert.ok(ptrs.some(p => p.type === 'rmappart') && ptrs.some(p => p.type === 'refs'), 'rmappart/refs 薄指针在场（附件映射重建链）')
    const u = await stack.call({ action: 'restore.uploadRecord', batchId: bid, domain: 'reports', index: 0, id: RID, revision: 0, deleted: false, record: FX.F.body })
    assert.ok(u.ok, `uploadRecord 须 ok（经薄指针重建并核对真实附件映射）（实得 ${JSON.stringify(u).slice(0, 140)}）`)
    const rec = stack.cloud.__docs.get(`mc_restore_records/${bid}:reports:0`)
    assert.ok(rec && rec.record.attachments.length === 1, '记录持久（附件原样）')
  })

  // ══ T1-T4 存储篡改（逐一——激活于消费实现后；本基线骑正向前置红）══
  const TAMPER_REJECT = /mismatch|不符|declaration|声明|verify|验证|块|block|叶|sha|proof|证明|根|corrupt|篡改|invalid|conflict/i
  async function tamperLeg(name, tamper) {
    const stack = makeStack('true')
    const bid = await walkToIndexing(FX.F, FX.D, stack)
    for (let i = 0; i < FX.D.totalBlocks; i++) {
      const r = await stack.call({ action: 'restore.indexDeclarePage', batchId: bid, blockIndex: i })
      assert.ok(r.ok, `消费块${i} 须 ok（正向前置——篡改检查随消费实现激活；实得 ${JSON.stringify(r).slice(0, 110)}）`)
    }
    assert.strictEqual(stack.cloud.__docs.get(`mc_restore_batches/${bid}`).status, 'declared', '前置 declared')
    tamper(stack, bid)
    const before = writeSnapshot(stack)
    const u = await stack.call({ action: 'restore.uploadRecord', batchId: bid, domain: 'reports', index: 0, id: RID, revision: 0, deleted: false, record: FX.F.body })
    assert.ok(!u.ok, `篡改后 uploadRecord 须拒（不得信任被改声明/指针——正文为原始真值）（实得 ${JSON.stringify(u).slice(0, 130)}）`)
    assert.ok(TAMPER_REJECT.test(String(u.code || '') + String(u.message || '')), `拒因=声明/验证/块族（实得 ${u.code}: ${String(u.message).slice(0, 80)}）`)
    assertZeroWrites(before, stack, name)
    assert.ok(!stack.cloud.__docs.get(`mc_restore_records/${bid}:reports:0`), '零写：记录不得持久')
  }
  await scenario('T1 声明 id 篡改（正文原样）：uploadRecord 拒＋零写（证据有限——普通请求-声明失配即拒；Merkle 链接读证据见 T5）【红：骑正向前置】', async () => {
    await tamperLeg('T1', (stack, bid) => { stack.cloud.__docs.get(`mc_restore_declarations/${bid}:decl:reports:0`).id = RID + '-tampered' })
  })
  await scenario('T2 声明 revision 篡改（正文原样）：uploadRecord 拒＋零写（证据有限——同 T1；Merkle 链接读证据见 T5）【红：骑正向前置】', async () => {
    await tamperLeg('T2', (stack, bid) => { stack.cloud.__docs.get(`mc_restore_declarations/${bid}:decl:reports:0`).revision = 9 })
  })
  await scenario('T3 rmappart 薄指针 blockIndex 指错块（0→5）：uploadRecord 拒＋零写——指针→readVerifiedBlock 须检错块/缺失【红：骑正向前置】', async () => {
    await tamperLeg('T3', (stack, bid) => {
      const key = [...stack.cloud.__docs.keys()].find(k => k.startsWith(`mc_restore_declarations/${bid}:ptr:`) && stack.cloud.__docs.get(k).type === 'rmappart')
      assert.ok(key, '前置：rmappart 指针在场')
      stack.cloud.__docs.get(key).blockIndex = 5
    })
  })
  await scenario('T4 索引后底层块 proof 腐蚀：uploadRecord 拒＋零写——验证读折叠 proof 至 planRoot 须检出【红：骑正向前置】', async () => {
    await tamperLeg('T4', (stack, bid) => { stack.cloud.__docs.get(`mc_restore_blocks/${bid}:blk:0`).proof = 'AAAA' })
  })

  // ══ T5 强测：自洽篡改声明（普通检查全过——唯一拒绝路径=Merkle 链接读）【红：骑正向前置】══
  await scenario('T5 自洽篡改：正文改许可字段 note＋声明 hash 重算至与篡改正文自洽（普通 id/revision/hash 检查按构造全过）→uploadRecord 必须因**不匹配冻结块**拒＋零写【红：骑正向前置】', async () => {
    const stack = makeStack('true')
    const bid = await walkToIndexing(FX.F, FX.D, stack)
    for (let i = 0; i < FX.D.totalBlocks; i++) {
      const r = await stack.call({ action: 'restore.indexDeclarePage', batchId: bid, blockIndex: i })
      assert.ok(r.ok, `消费块${i} 须 ok（正向前置——T5 随消费实现激活；实得 ${JSON.stringify(r).slice(0, 110)}）`)
    }
    assert.strictEqual(stack.cloud.__docs.get(`mc_restore_batches/${bid}`).status, 'declared', '前置 declared')
    // 篡改正文：许可字段 note（REPORT_FIELDS 白名单内）——id/revision 原样
    const alteredBody = { ...FX.F.body, note: 'tampered-note' }
    const allowedTop = ['id', 'revision', 'deleted', 'attachments', 'reportType', 'dateKey', 'note', 'archiveStatus']
    for (const k of Object.keys(alteredBody)) assert.ok(allowedTop.includes(k), `T5 前置自检：篡改正文键 ⊆ reports 白名单（${k}）`)
    assert.strictEqual(alteredBody.id, RID, 'T5 前置：id 原样')
    assert.strictEqual(alteredBody.revision, 0, 'T5 前置：revision 原样')
    // 篡改声明：hash 重算至与篡改正文自洽（普通 hash 检查将过）
    const decl = stack.cloud.__docs.get(`mc_restore_declarations/${bid}:decl:reports:0`)
    assert.ok(decl, '前置声明在场')
    decl.hash = sha256(Buffer.from(stage1.canonicalJsonBytes(alteredBody)))
    assert.strictEqual(decl.hash, sha256(Buffer.from(stage1.canonicalJsonBytes(alteredBody))), 'T5 前置自检：篡改声明 hash=sha256(canonical(篡改正文))——普通检查按构造全过')
    const before = writeSnapshot(stack)
    const u = await stack.call({ action: 'restore.uploadRecord', batchId: bid, domain: 'reports', index: 0, id: RID, revision: 0, deleted: false, record: alteredBody })
    assert.ok(!u.ok, `自洽篡改后 uploadRecord 须拒——唯一拒绝路径=声明不匹配**冻结块**（Merkle 链接读）；信任被改声明将接受（实得 ${JSON.stringify(u).slice(0, 130)}）`)
    assert.ok(/块|block|verify|验证|根|Merkle|sha|叶|proof|不符|mismatch|declaration|声明/i.test(String(u.code || '') + String(u.message || '')), `拒因=Merkle 链接/验证族（实得 ${u.code}: ${String(u.message).slice(0, 80)}）`)
    assertZeroWrites(before, stack, 'T5')
    assert.ok(!stack.cloud.__docs.get(`mc_restore_records/${bid}:reports:0`), '零写：记录不得持久')
  })

  // ── 冻结源复核（漂移=本轮不作冻结证据）──
  console.log('\n冻结源复核:')
  let drifted = false
  for (const [rel, h] of Object.entries(frozenHashes)) {
    const now = sha256(fs.readFileSync(path.join(root, rel)))
    const same = now === h
    if (!same) drifted = true
    console.log(`  ${now.slice(0, 8)} ${same ? '==' : '≠'}  ${rel}`)
  }
  if (drifted) failed.push('源漂移：加载时≠结束时（本轮不作冻结证据——须复跑）')

  console.log(`\n${passed} 通过, ${failed.length} 失败`)
  if (failed.length) { console.log('失败项（预期红 S0+T1-T5：V20 消费未实现（E11 门）——全落正向前置"消费须 ok"；T1/T2=失配检查（证据有限）、T3/T4/T5=链接安全门，随消费器+上传链接实现激活——本基线不声称篡改检测已生效）:\n - ' + failed.join('\n - ')); process.exit(1) }
  console.log('（红先行契约固化——不构成切片完成/B3b 验收）')
}
main().catch(e => { console.error('FATAL', e); process.exit(2) })
