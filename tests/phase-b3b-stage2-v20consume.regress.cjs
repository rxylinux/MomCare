// B3b 阶段二：indexDeclarePage V20 块消费切片——真 handler 红先行回归 rev1（核心套件）
// 依据：docs/ZCODE_PHASE_B3B_INDEX_BLOCK_PROTOCOL.md §6.4（indexDeclarePage{blockIndex} 消费契约）
// ＋§6.5（已验证读/薄指针恰三字段）＋协调方指派 2026-09-20。当前源 b441b8f4 未实现本切片——
// 预期 V1-V7 红（现行 indexDeclarePage 对 V20 批次按 e580ff3b-E11 门拒——红在各消费断言）；
// L1 legacy 关钉预期绿。
// 契约（§6.4 消费四款）：
//   ①读单块+readVerifiedBlock 同径核验（canonical(entries)=byteLength∧重算位置绑定叶=sha256∧
//     proof 折叠=planRoot——消费期即检存储篡改）；②单事务（写数 ≤50——计数器仅计写非总 ops）写分层
//   声明——record→全量声明（既有 `${bid}:decl:${domain}:${index}` 键空间——身份字段 id/hash/
//   revision/deleted+blockIndex 指针；**附件映射不复制**——§6.5 薄指针重建口径（审查澄清 2026-09-20：
//   复制可致巨映射重复——V7 端到端钉 uploadRecord 经指针重建并核对真实映射）；
//     六类非记录（file/refs/rmappart/filefrag/cshafrag/idfrag）→薄指针（声明键空间 `${bid}:ptr:` ——
//     **恰三字段 {_id,type,blockIndex}**）＋consumedCursor←i+1；③末块 totalDeclarations===totalEntries
//   →declared（不等 fail-stop）；④<consumedCursor 同块纯比对幂等零写／> 拒零写。
//   I9：preparing 后消费路径**零 manifest chunk 读**（mock 读计数器断言 delta=0）。
//   附件可用性：消费后 record 声明 frozenReportAttachments 使真正文 uploadRecord 过逐位核对。
// 本套件诚实未覆盖（后续切片/套件）：filefrag/cshafrag/idfrag 三类指针（需长字段/巨 id 夹具）、
// §6.7 清理、上传期 readVerifiedBlock 附件身份验证路径、跨块指针 blockIndex 多值分布。
// 不编辑生产/既往冻结套件；修复后同哈希须全绿；源漂移轮不作冻结证据。
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-b3b2-cons-'))
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

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-b3b2cons', MC_MEMBER_MAMA_OPENID: 'oTESTMAMA123456', MC_MEMBER_PAPA_OPENID: 'oTESTPAPA456789' }

function makeMockCloud() {
  const docs = new Map(), storedFiles = new Map()
  const state = { caller: TEST_ENV.MC_MEMBER_MAMA_OPENID, initialized: false, failCommitOnce: null, reads: {}, maxTxOps: 0 }
  const clone = x => JSON.parse(JSON.stringify(x))
  function docApi(col, id, tx) {
    return {
      get: async () => {
        state.reads[col] = (state.reads[col] || 0) + 1 // I9 读计数（tx/非 tx 全计）
        const e = docs.get(`${col}/${id}`)
        if (tx) tx.reads.set(`${col}/${id}`, e ? e.__v : 0)
        return { data: e ? { ...clone(e), _id: id } : null }
      },
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
          if (state.failCommitOnce && tx.writes.has(state.failCommitOnce.key)) {
            const err = new Error('injected commit failure: ' + state.failCommitOnce.key); err.errCode = 'CONFLICT'; throw err
          }
          for (const [k, rv] of tx.reads) { const cur2 = docs.get(k); if ((cur2 ? cur2.__v : 0) !== rv) { const err = new Error('transaction conflict: ' + k); err.errCode = 'CONFLICT'; throw err } }
          for (const k of tx.removes) docs.delete(k)
          for (const [k, d2] of tx.writes) { const prev = docs.get(k); docs.set(k, { ...d2, __v: (prev ? prev.__v : 0) + 1 }) }
          if (tx.writes.size > state.maxTxOps) state.maxTxOps = tx.writes.size // 单事务写数跟踪（仅计写——非总 ops/读）
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
function makeStack(flagValue = 'true') { // flagValue='off' 显式关（勿传 undefined——默认参数会落 'true'）
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
const RID = 'rp-cons-att', OID = 'cons-oid'
const FIRST_ATTS = [{ order: 0, originalFileId: OID, fileIndex: 0 }]

function baseManifest(domains, files, records, reports) {
  return {
    formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: TEST_ENV.MC_FAMILY_ID, packageKind: 'full', complete: true,
    scope: { includeShared: true, includePrivateOf: null }, scopeLabel: 'shared-only', domains, files, records, reports,
    pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
  }
}
function buildAttPkg() { // 1 报告+1 附件 → 条目 [record,file,refs,rmappart] 单块
  const body = { id: RID, revision: 0, deleted: false, attachments: [{ fileId: OID, order: 0 }] }
  const seg = Buffer.from(stage1.canonicalJsonBytes([body]))
  const attBytes = Buffer.alloc(8, 0x43)
  const domains = {}
  for (const d of DOMAIN_ORDER) domains[d] = { status: 'omitted' }
  domains.reports = { status: 'present', recordCount: 1, pagingComplete: true, visibility: 'shared', fileIndex: 1 }
  const manifest = baseManifest(domains,
    [
      { path: 'attachments/cons.bin', kind: 'attachment', length: attBytes.length, sha256: sha256(attBytes), contentType: 'image/png', originalFileId: OID, chunkSha256: [sha256(attBytes)], referencedBy: [RID] },
      { path: 'records/reports.json', kind: 'domain-json', length: seg.length, sha256: sha256(seg), contentType: 'application/json', domain: 'reports' },
    ],
    { reports: [{ index: 0, id: RID, revision: 0, deleted: false, hash: sha256(Buffer.from(stage1.canonicalJsonBytes(body))) }] },
    [{ reportId: RID, revision: 0, deleted: false, attachments: FIRST_ATTS.map(a => ({ ...a })) }])
  const manifestBytes = Buffer.from(stage1.canonicalJsonBytes(manifest))
  const len8 = n => { const b = Buffer.alloc(8); b.writeUInt32BE(0, 0); b.writeUInt32BE(n, 4); return b }
  const pkg = Buffer.concat([Buffer.from(stage1.encodeHeader(manifestBytes.length)), manifestBytes, len8(attBytes.length), attBytes, len8(seg.length), seg])
  return { pkg, manifestBytes, body, manifestDigest: sha256(manifestBytes), packageDigest: sha256(pkg), totals: { files: 2, records: 1, domainCounts: { reports: 1 } } }
}
function buildMultiPkg() { // 120 零附件记录 → 3 块×40 record
  const recs = Array.from({ length: 120 }, (_, i) => ({ id: 'rp-cons-mb-' + String(i).padStart(3, '0'), revision: 0, deleted: false, attachments: [] }))
  const seg = Buffer.from(stage1.canonicalJsonBytes(recs))
  const domains = {}
  for (const d of DOMAIN_ORDER) domains[d] = { status: 'omitted' }
  domains.reports = { status: 'present', recordCount: 120, pagingComplete: true, visibility: 'shared', fileIndex: 0 }
  const manifest = baseManifest(domains,
    [{ path: 'records/reports.json', kind: 'domain-json', length: seg.length, sha256: sha256(seg), contentType: 'application/json', domain: 'reports' }],
    { reports: recs.map((r, i) => ({ index: i, id: r.id, revision: r.revision, deleted: r.deleted, hash: sha256(Buffer.from(stage1.canonicalJsonBytes(r))) })) },
    recs.map(r => ({ reportId: r.id, revision: r.revision, deleted: r.deleted, attachments: [] })))
  const manifestBytes = Buffer.from(stage1.canonicalJsonBytes(manifest))
  const len8 = n => { const b = Buffer.alloc(8); b.writeUInt32BE(0, 0); b.writeUInt32BE(n, 4); return b }
  const pkg = Buffer.concat([Buffer.from(stage1.encodeHeader(manifestBytes.length)), manifestBytes, len8(seg.length), seg])
  return { pkg, manifestBytes, manifestDigest: sha256(manifestBytes), packageDigest: sha256(pkg), totals: { files: 1, records: 120, domainCounts: { reports: 120 } } }
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
  const byType = {}
  stream.entries.forEach(e => { byType[e.entry.type] = (byType[e.entry.type] || 0) + 1 })
  return { stream, blocks, byType, totalBlocks: blocks.length, totalEntries: stream.count, planRoot: tree.root.toString('hex'), proofs: tree.proofs }
}
// 启用态走到 indexing：begin→chunks（末片冻结 preparing）→finalize 全块→indexing
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
  const bd = stack.cloud.__docs.get(`mc_restore_batches/${batchId}`)
  assert.strictEqual(bd.status, 'preparing', `前置 preparing（实得 ${bd.status}）`)
  for (let i = 0; i < D.totalBlocks; i++) {
    const r = await stack.call({ action: 'restore.finalizeDeclare', batchId, blockIndex: i, blockB64: D.blocks[i].toString('base64'), proof: D.proofs[i] })
    assert.ok(r.ok, `finalize 块${i}: ${JSON.stringify(r).slice(0, 140)}`)
  }
  assert.strictEqual(stack.cloud.__docs.get(`mc_restore_batches/${batchId}`).status, 'indexing', '前置 indexing')
  return batchId
}
// legacy 关走到 indexing（末片 legacy 直转）
async function walkLegacyToIndexing(F, stack) {
  const batchId = nonce()
  const b = await stack.call({ action: 'restore.begin', batchId, formatVersion: 1, packageDigest: F.packageDigest, manifestDigest: F.manifestDigest, claimedKind: 'full', totals: F.totals })
  assert.ok(b.ok, `begin: ${JSON.stringify(b).slice(0, 140)}`)
  const CHUNK = 40 * 1024, total = Math.ceil(F.manifestBytes.length / CHUNK)
  for (let i = 0; i < total; i++) {
    const raw = F.manifestBytes.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, F.manifestBytes.length))
    const r = await stack.call({ action: 'restore.declareChunk', batchId, chunkIndex: i, chunkTotal: total, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
    assert.ok(r.ok, `declareChunk ${i}`)
  }
  assert.strictEqual(stack.cloud.__docs.get(`mc_restore_batches/${batchId}`).status, 'indexing', 'legacy 末片直转 indexing')
  return batchId
}
const batchDoc = (stack, bid) => stack.cloud.__docs.get(`mc_restore_batches/${bid}`)
const declDoc = (stack, bid, dom, idx) => stack.cloud.__docs.get(`mc_restore_declarations/${bid}:decl:${dom}:${idx}`)
const ptrDocs = (stack, bid) => [...stack.cloud.__docs.keys()].filter(k => k.startsWith(`mc_restore_declarations/${bid}:ptr:`)).map(k => ({ key: k, doc: stack.cloud.__docs.get(k) }))
const idxPage = (stack, bid, i) => stack.call({ action: 'restore.indexDeclarePage', batchId: bid, ...(i === undefined ? {} : { blockIndex: i }) })

async function main() {
  console.log(`\nB3b indexDeclarePage V20 块消费切片红先行回归 rev1（预期红：V1-V7；绿：P0×2+L1）\n`)

  const ATT = {}, MULTI = {}
  await scenario('P0-① 单块带附件夹具：Stage1 ok＋独立派定条目型计数 [record,file,refs,rmappart]×1 单块', async () => {
    ATT.F = buildAttPkg()
    const v = await stage1Validate(ATT.F.pkg)
    assert.ok(v.ok, `Stage1 ok（${JSON.stringify((v.problems || []).slice(0, 1)).slice(0, 100)}）`)
    ATT.D = deriveIndependent(ATT.F)
    assert.strictEqual(ATT.D.totalBlocks, 1, `单块（实得 ${ATT.D.totalBlocks}）`)
    assert.strictEqual(ATT.D.byType.record, 1, 'record×1')
    assert.strictEqual(ATT.D.byType.file, 1, 'file×1')
    assert.strictEqual(ATT.D.byType.refs, 1, 'refs×1')
    assert.strictEqual(ATT.D.byType.rmappart, 1, 'rmappart×1')
    assert.strictEqual(ATT.D.totalEntries, 4, 'totalEntries=4')
    console.log(`      块0=${ATT.D.blocks[0].length}B｜root=${ATT.D.planRoot.slice(0, 16)}…`)
  })
  await scenario('P0-② 多块夹具（120 记录→3 块×40）：Stage1 ok＋独立派定', async () => {
    MULTI.F = buildMultiPkg()
    const v = await stage1Validate(MULTI.F.pkg)
    assert.ok(v.ok)
    MULTI.D = deriveIndependent(MULTI.F)
    assert.strictEqual(MULTI.D.totalBlocks, 3, `3 块（实得 ${MULTI.D.totalBlocks}）`)
    assert.strictEqual(MULTI.D.totalEntries, 120)
    assert.strictEqual(MULTI.D.byType.record, 120)
  })

  await scenario('L1 legacy 关钉：indexDeclarePage（无 blockIndex 旧签名）走旧 manifest 分页→declared（基线不变）', async () => {
    const stack = makeStack('off')
    const bid = await walkLegacyToIndexing(ATT.F, stack)
    for (let i = 0; i < 30; i++) {
      const r = await idxPage(stack, bid)
      assert.ok(r.ok, `legacy indexPage: ${JSON.stringify(r).slice(0, 140)}`)
      if (r.data && (r.data.status === 'declared' || r.data.hasMore === false)) break
    }
    assert.strictEqual(batchDoc(stack, bid).status, 'declared', 'legacy 全程 declared')
  })

  // ══ V1 单块消费全契约【预期红】══
  await scenario('V1 启用态消费块0（单块带附件）：ok＋record 全量声明（身份 id/hash/revision/deleted+blockIndex——附件映射不复制，V7 端到端钉）＋恰 3 薄指针（file/refs/rmappart——恰三字段 {_id,type,blockIndex}）＋consumedCursor=1＋末块置 declared＋声明总数=totalEntries=4＋单事务写数 ≤50', async () => {
    const stack = makeStack('true')
    const bid = await walkToIndexing(ATT.F, ATT.D, stack)
    const r = await idxPage(stack, bid, 0)
    assert.ok(r.ok, `indexDeclarePage{blockIndex:0} 须 ok（实得 ${JSON.stringify(r).slice(0, 140)}）`)
    const bd = batchDoc(stack, bid)
    assert.strictEqual(bd.consumedCursor, 1, `consumedCursor=1（实得 ${bd.consumedCursor}）`)
    assert.strictEqual(bd.status, 'declared', `末块消费后 declared（实得 ${bd.status}）`)
    // record 全量声明（既有键空间+blockIndex 指针+冻结附件）
    const decl = declDoc(stack, bid, 'reports', 0)
    assert.ok(decl, 'record 全量声明 ${bid}:decl:reports:0 须在场')
    assert.strictEqual(decl.id, RID); assert.strictEqual(decl.revision, 0); assert.strictEqual(decl.deleted, false)
    assert.ok(/^[0-9a-f]{64}$/.test(String(decl.hash)), 'hash 64hex')
    assert.strictEqual(decl.blockIndex, 0, 'blockIndex 指针=0')
    // 审查澄清：不复制附件映射（§6.5 薄指针——V7 钉 uploadRecord 经指针重建并核对真实映射）
    // 恰 3 薄指针（file/refs/rmappart）——恰三字段
    const ptrs = ptrDocs(stack, bid)
    assert.strictEqual(ptrs.length, 3, `恰 3 薄指针（实得 ${ptrs.length}）`)
    const types = ptrs.map(p => p.doc.type).sort()
    assert.deepStrictEqual(types, ['file', 'refs', 'rmappart'], `指针类型（实得 ${JSON.stringify(types)}）`)
    for (const p of ptrs) {
      const keys = Object.keys(p.doc).filter(k => k !== '__v').sort()
      assert.deepStrictEqual(keys, ['blockIndex', 'type'], `薄指针恰三字段 {_id,type,blockIndex}（实得 ${p.key} 字段 ${JSON.stringify(keys)}）`)
      assert.strictEqual(p.doc.blockIndex, 0, '指针 blockIndex=0')
    }
    // 声明总数=totalEntries（1 record decl + 3 ptr）
    const allDecl = [...stack.cloud.__docs.keys()].filter(k => k.startsWith(`mc_restore_declarations/${bid}`)).length
    assert.strictEqual(allDecl, ATT.D.totalEntries, `声明总数=${ATT.D.totalEntries}（实得 ${allDecl}）`)
    assert.ok(stack.cloud.__state.maxTxOps <= 50, `单事务写数 ≤50（仅计写——实得峰值 ${stack.cloud.__state.maxTxOps}）`)
    console.log(`      消费 ok：decl+ptr=${allDecl}｜maxTxOps=${stack.cloud.__state.maxTxOps}`)
  })

  await scenario('V2 I9 零清单读：preparing 后消费全程 mc_restore_declare_chunks 读计数 delta=0【预期红】', async () => {
    const stack = makeStack('true')
    const bid = await walkToIndexing(ATT.F, ATT.D, stack)
    const before = stack.cloud.__state.reads['mc_restore_declare_chunks'] || 0
    const r = await idxPage(stack, bid, 0)
    assert.ok(r.ok, `消费须 ok（实得 ${JSON.stringify(r).slice(0, 120)}）`)
    const delta = (stack.cloud.__state.reads['mc_restore_declare_chunks'] || 0) - before
    assert.strictEqual(delta, 0, `消费路径零 manifest chunk 读（I9——实得 delta=${delta}）`)
  })

  await scenario('V3 多块游标推进：块0→consumedCursor=1 仍 indexing／块1→2 仍 indexing／块2（末）→declared＋120 record 声明＋consumedCursor=3【预期红】', async () => {
    const stack = makeStack('true')
    const bid = await walkToIndexing(MULTI.F, MULTI.D, stack)
    const r0 = await idxPage(stack, bid, 0)
    assert.ok(r0.ok, `块0 消费 ok（实得 ${JSON.stringify(r0).slice(0, 120)}）`)
    assert.strictEqual(batchDoc(stack, bid).consumedCursor, 1, 'cursor=1')
    assert.strictEqual(batchDoc(stack, bid).status, 'indexing', '非末块不得 declared')
    const r1 = await idxPage(stack, bid, 1)
    assert.ok(r1.ok, '块1 消费 ok')
    assert.strictEqual(batchDoc(stack, bid).consumedCursor, 2, 'cursor=2')
    assert.strictEqual(batchDoc(stack, bid).status, 'indexing', '非末块不得 declared')
    const r2 = await idxPage(stack, bid, 2)
    assert.ok(r2.ok, '块2（末）消费 ok')
    const bd = batchDoc(stack, bid)
    assert.strictEqual(bd.consumedCursor, 3, 'cursor=3')
    assert.strictEqual(bd.status, 'declared', '末块后 declared（totalDeclarations===totalEntries=120 核对后）')
    const decls = [...stack.cloud.__docs.keys()].filter(k => k.startsWith(`mc_restore_declarations/${bid}:decl:`)).length
    assert.strictEqual(decls, 120, `120 record 声明（实得 ${decls}）`)
    assert.ok(stack.cloud.__state.maxTxOps <= 50, `每消费事务写数 ≤50（仅计写——实得 ${stack.cloud.__state.maxTxOps}）`)
  })

  await scenario('V4 同块重放幂等：consumedCursor=1 后重发 blockIndex=0→ok（重放族）＋零写＋状态/游标不动【预期红】', async () => {
    const stack = makeStack('true')
    const bid = await walkToIndexing(MULTI.F, MULTI.D, stack)
    const r0 = await idxPage(stack, bid, 0)
    assert.ok(r0.ok, `前置 块0 ok（实得 ${JSON.stringify(r0).slice(0, 120)}）`)
    const before = writeSnapshot(stack)
    const r = await idxPage(stack, bid, 0)
    assert.ok(r.ok, `重放须 ok（实得 ${JSON.stringify(r).slice(0, 120)}）`)
    assertZeroWrites(before, stack, 'V4 重放')
    assert.strictEqual(batchDoc(stack, bid).consumedCursor, 1, '游标不动')
    assert.strictEqual(batchDoc(stack, bid).status, 'indexing', '状态不动')
  })

  await scenario('V5 超前块拒：consumedCursor=0 直发 blockIndex=1→拒＋零写＋游标不动【预期红】', async () => {
    const stack = makeStack('true')
    const bid = await walkToIndexing(MULTI.F, MULTI.D, stack)
    const before = writeSnapshot(stack)
    const r = await idxPage(stack, bid, 1)
    assert.ok(!r.ok, '超前块须拒')
    assert.ok(!/未实现|块消费|not.*implement/i.test(String(r.code || '') + String(r.message || '')), '当前拒因=未实现门——目标游标语义未实现（红先行归因：消费实现后此腿才有效）')
    assert.ok(/cursor|游标|ahead|超前|顺序|stale|invalid/i.test(String(r.code || '') + String(r.message || '')), `拒因=游标/顺序族（实得 ${r.code}: ${String(r.message).slice(0, 80)}）`)
    assertZeroWrites(before, stack, 'V5')
    const bd = batchDoc(stack, bid)
    assert.strictEqual(bd.consumedCursor === undefined ? 0 : bd.consumedCursor, 0, '游标不动（0）')
  })

  // ══ V6 存储损坏拒（三变体——拒且游标不进零写）【预期红】══
  for (const [field, mutate] of [
    ['sha256', (blk) => { blk.sha256 = '0'.repeat(64) }],
    ['entries', (blk) => { blk.entries[0].revision = 9 }],
    ['proof', (blk) => { blk.proof = 'AAAA' }],
  ]) {
    await scenario(`V6-${field} 损坏：finalize 后篡改存储块 ${field}→消费拒（readVerifiedBlock 同径检出）＋consumedCursor 不进＋零写【预期红】`, async () => {
      const stack = makeStack('true')
      const bid = await walkToIndexing(ATT.F, ATT.D, stack)
      const blk = stack.cloud.__docs.get(`mc_restore_blocks/${bid}:blk:0`)
      assert.ok(blk, '块文档在场（前置）')
      mutate(blk)
      const before = writeSnapshot(stack)
      const r = await idxPage(stack, bid, 0)
      assert.ok(!r.ok, `损坏 ${field} 须拒（实得 ${JSON.stringify(r).slice(0, 120)}）`)
      assert.ok(!/未实现|块消费|not.*implement/i.test(String(r.code || '') + String(r.message || '')), '当前拒因=未实现门——目标 readVerifiedBlock 同径核验未实现（红先行归因）')
      assert.ok(/sha|叶|proof|证明|根|byteLength|entryCount|不符|mismatch|corrupt|篡改|invalid/i.test(String(r.code || '') + String(r.message || '')), `拒因=核验族（实得 ${r.code}: ${String(r.message).slice(0, 80)}）`)
      assertZeroWrites(before, stack, `V6-${field}`)
      const bd = batchDoc(stack, bid)
      assert.strictEqual(bd.consumedCursor === undefined ? 0 : bd.consumedCursor, 0, '游标不进（0）')
      assert.notStrictEqual(bd.status, 'declared', '不得置 declared')
    })
  }

  // ══ V7 附件可用性：消费→declared 后真正文 uploadRecord 过冻结逐位核对【预期红】══
  await scenario('V7 消费后附件可用：declared 后 uploadRecord 真正文（1 附件）ok——经薄指针重建并核对真实附件映射＋记录持久附件原样【预期红】', async () => {
    const stack = makeStack('true')
    const bid = await walkToIndexing(ATT.F, ATT.D, stack)
    const r = await idxPage(stack, bid, 0)
    assert.ok(r.ok, `消费须 ok（实得 ${JSON.stringify(r).slice(0, 120)}）`)
    assert.strictEqual(batchDoc(stack, bid).status, 'declared', '前置 declared')
    const u = await stack.call({ action: 'restore.uploadRecord', batchId: bid, domain: 'reports', index: 0, id: RID, revision: 0, deleted: false, record: ATT.F.body })
    assert.ok(u.ok, `uploadRecord 须 ok（消费产出的 frozenReportAttachments 与正文逐位核对过）（实得 ${JSON.stringify(u).slice(0, 140)}）`)
    const rec = stack.cloud.__docs.get(`mc_restore_records/${bid}:reports:0`)
    assert.ok(rec, '记录持久')
    assert.deepStrictEqual(rec.record.attachments, ATT.F.body.attachments, '持久附件=正文原样')
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
  if (failed.length) { console.log('失败项（预期红 V1-V7：indexDeclarePage V20 块消费未实现——现行按 E11 门拒）:\n - ' + failed.join('\n - ')); process.exit(1) }
  console.log('（红先行契约固化——不构成切片完成/B3b 验收）')
}
main().catch(e => { console.error('FATAL', e); process.exit(2) })
