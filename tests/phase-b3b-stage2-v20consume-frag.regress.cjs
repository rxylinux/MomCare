// B3b 阶段二：indexDeclarePage V20 块消费——长 id（idRef+idfrag）/长 path（filefrag）碎片指针
// 红先行补充套件 rev1（独立——不触生产/冻结 a51d85c8/3ed182aa）
// 协调方指派 2026-09-20：①Stage1-valid 长 record id——v20 派生 idRef 短承诺+idfrag 碎片；
//   **record 与 idfrag 跨块布置并显式断言**（本夹具：47 填充记录+长 id 记录=恰 48 条目触条目帽
//   ——块 0 恰满，idfrag×3 全落块 1——确定性跨块，非字节算术巧合）；②finalize+全块消费后
//   record 声明须**恢复精确全长 id**（idRef+idfrag 经已验证指针重建）＋uploadRecord 接受匹配正文；
//   ③≥1 Stage1-valid 长路径文件派生 filefrag——薄指针在场且 blockIndex 正确、**不复制字段字节**。
// 跨块可达性：本夹具实测可达（P0-① 显式断言 record∈块0 ∧ idfrag∈块1）——如派生分块与预期不符
//   P0 即红（不造绿）。预期红：F1/F2/F3（消费未实现——现行按 E11 门拒）；绿：P0-①+L1（legacy 关钉）。
// maxTx 计数器口径=单事务写数（仅计写）。修复后同哈希须全绿；源漂移轮不作冻结证据。
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-b3b2-frag-'))
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

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-b3b2frag', MC_MEMBER_MAMA_OPENID: 'oTESTMAMA123456', MC_MEMBER_PAPA_OPENID: 'oTESTPAPA456789' }

function makeMockCloud() {
  const docs = new Map(), storedFiles = new Map()
  const state = { caller: TEST_ENV.MC_MEMBER_MAMA_OPENID, initialized: false, reads: {}, maxTxOps: 0 }
  const clone = x => JSON.parse(JSON.stringify(x))
  function docApi(col, id, tx) {
    return {
      get: async () => {
        state.reads[col] = (state.reads[col] || 0) + 1
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
          for (const [k, rv] of tx.reads) { const cur2 = docs.get(k); if ((cur2 ? cur2.__v : 0) !== rv) { const err = new Error('transaction conflict: ' + k); err.errCode = 'CONFLICT'; throw err } }
          for (const k of tx.removes) docs.delete(k)
          for (const [k, d2] of tx.writes) { const prev = docs.get(k); docs.set(k, { ...d2, __v: (prev ? prev.__v : 0) + 1 }) }
          if (tx.writes.size > state.maxTxOps) state.maxTxOps = tx.writes.size // 单事务写数（仅计写）
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

// ── 夹具：47 填充记录 + 长 id 记录（index 47）+ 附件报告（index 48，引用长路径文件）──
const DOMAIN_ORDER = ['pregnancy', 'daily', 'mood', 'checkup', 'bag', 'reports']
const LONG_ID = 'L'.repeat(3000)                       // canonical 3002B → idfrag×3（1400/1400/202）
const ATT_RID = 'rp-frag-att', ATT_OID = 'frag-oid'
const LONG_PATH = 'attachments/' + 'p'.repeat(1500) + '.bin' // canonical 1517B → filefrag(path)×2（1400/117）
function buildFragPkg() {
  const recs = []
  for (let i = 0; i < 47; i++) recs.push({ id: 'rp-frag-f' + String(i).padStart(3, '0'), revision: 0, deleted: false, attachments: [] })
  recs.push({ id: LONG_ID, revision: 0, deleted: false, attachments: [] })            // index 47——idRef+idfrag
  recs.push({ id: ATT_RID, revision: 0, deleted: false, attachments: [{ fileId: ATT_OID, order: 0 }] }) // index 48
  const seg = Buffer.from(stage1.canonicalJsonBytes(recs))
  const attBytes = Buffer.alloc(8, 0x46)
  const domains = {}
  for (const d of DOMAIN_ORDER) domains[d] = { status: 'omitted' }
  domains.reports = { status: 'present', recordCount: recs.length, pagingComplete: true, visibility: 'shared', fileIndex: 1 }
  const manifest = {
    formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: TEST_ENV.MC_FAMILY_ID, packageKind: 'full', complete: true,
    scope: { includeShared: true, includePrivateOf: null }, scopeLabel: 'shared-only', domains,
    files: [
      { path: LONG_PATH, kind: 'attachment', length: attBytes.length, sha256: sha256(attBytes), contentType: 'image/png', originalFileId: ATT_OID, chunkSha256: [sha256(attBytes)], referencedBy: [ATT_RID] },
      { path: 'records/reports.json', kind: 'domain-json', length: seg.length, sha256: sha256(seg), contentType: 'application/json', domain: 'reports' },
    ],
    records: { reports: recs.map((r, i) => ({ index: i, id: r.id, revision: r.revision, deleted: r.deleted, hash: sha256(Buffer.from(stage1.canonicalJsonBytes(r))) })) },
    reports: recs.map((r, i) => i === 48
      ? { reportId: r.id, revision: 0, deleted: false, attachments: [{ order: 0, originalFileId: ATT_OID, fileIndex: 0 }] }
      : { reportId: r.id, revision: 0, deleted: false, attachments: [] }),
    pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
  }
  const manifestBytes = Buffer.from(stage1.canonicalJsonBytes(manifest))
  const len8 = n => { const b = Buffer.alloc(8); b.writeUInt32BE(0, 0); b.writeUInt32BE(n, 4); return b }
  const pkg = Buffer.concat([Buffer.from(stage1.encodeHeader(manifestBytes.length)), manifestBytes, len8(attBytes.length), attBytes, len8(seg.length), seg])
  return { pkg, manifestBytes, body49: recs, manifestDigest: sha256(manifestBytes), packageDigest: sha256(pkg), totals: { files: 2, records: 49, domainCounts: { reports: 49 } } }
}
async function stage1Validate(pkg) {
  return stage1.validatePackage({ size: async () => pkg.length, readChunk: async (p, l) => new Uint8Array(pkg.subarray(p, p + l)) })
}
// 独立派定 + 显式跨块映射（流序逐块耗尽 entryCount）
function deriveIndependent(F) {
  const off = F.pkg.indexOf(F.manifestBytes)
  const wire = JSON.parse(F.pkg.subarray(off, off + F.manifestBytes.length).toString('utf8'))
  const stream = v20.deriveV20Stream(wire)
  const blocks = v20.packBlocks(stream)
  const tree = v20.buildTree(blocks)
  const counts = blocks.map(b => JSON.parse(b.toString('utf8')).length)
  const blockIdxOf = new Array(stream.entries.length)
  let e = 0
  for (let b = 0; b < blocks.length; b++) for (let j = 0; j < counts[b]; j++) blockIdxOf[e++] = b
  return { stream, blocks, counts, blockIdxOf, totalBlocks: blocks.length, totalEntries: stream.count, planRoot: tree.root.toString('hex'), proofs: tree.proofs }
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
const batchDoc = (stack, bid) => stack.cloud.__docs.get(`mc_restore_batches/${bid}`)
const ptrDocs = (stack, bid) => [...stack.cloud.__docs.keys()].filter(k => k.startsWith(`mc_restore_declarations/${bid}:ptr:`)).map(k => ({ key: k, doc: stack.cloud.__docs.get(k) }))

async function main() {
  console.log(`\nB3b V20 消费碎片指针补充套件（长 id idfrag/长 path filefrag——跨块显式）rev1（预期红 F1-F3；绿 P0+L1）\n`)

  const FX = {}
  await scenario('P0-① 碎片夹具：Stage1 ok＋独立派定显式跨块——长 id 记录 core∈块0 ∧ idfrag×3∈块1（48 条目帽钉死）＋长 path 文件 pathRef+filefrag×2＋条目型计数', async () => {
    FX.F = buildFragPkg()
    const v = await stage1Validate(FX.F.pkg)
    assert.ok(v.ok, `Stage1 须 ok（长 id/长 path 均 Stage1-valid——实得 ${JSON.stringify((v.problems || []).slice(0, 1)).slice(0, 120)}）`)
    FX.D = deriveIndependent(FX.F)
    // 条目型计数：record×49 + idfrag×3 + file×1 + filefrag×2 + refs×1 + rmappart×1 = 57
    const byType = {}
    FX.D.stream.entries.forEach(e => { byType[e.entry.type] = (byType[e.entry.type] || 0) + 1 })
    assert.deepStrictEqual(byType, { record: 49, idfrag: 3, file: 1, filefrag: 2, refs: 1, rmappart: 1 }, `条目型计数（实得 ${JSON.stringify(byType)}）`)
    assert.strictEqual(FX.D.totalEntries, 57)
    // 长记录条目：index 47——core 含 idRef（无全文 id）
    const longRecEntry = FX.D.stream.entries[47].entry
    assert.strictEqual(longRecEntry.type, 'record')
    assert.ok(longRecEntry.idRef && longRecEntry.id === undefined, 'core 须 idRef 短承诺（不含全文 id）')
    assert.strictEqual(longRecEntry.idRef.len, LONG_ID.length + 2, `idRef.len=canonical id 字节（${LONG_ID.length + 2}）`)
    assert.strictEqual(longRecEntry.idRef.frags, 3, 'idfrag×3')
    // 显式跨块：core∈块0 ∧ idfrag×3∈块1
    const coreBlock = FX.D.blockIdxOf[47]
    const idfragBlocks = [48, 49, 50].map(i => FX.D.blockIdxOf[i])
    assert.strictEqual(coreBlock, 0, `长 id 记录 core 须在块 0（实得 块${coreBlock}——47 填充+core=恰 48 条目帽）`)
    idfragBlocks.forEach((b, j) => assert.strictEqual(b, 1, `idfrag[${j}] 须在块 1（实得 块${b}——跨块布置成立）`))
    assert.ok(idfragBlocks[0] !== coreBlock, 'record 与 idfrag 跨块（显式）')
    // 长路径文件：file core 含 pathRef（无 path 全文）+ filefrag×2
    const fileEntry = FX.D.stream.entries.find(e => e.entry.type === 'file').entry
    assert.ok(fileEntry.pathRef && fileEntry.path === undefined, 'file core 须 pathRef 短承诺')
    assert.strictEqual(fileEntry.pathRef.frags, 2, 'filefrag(path)×2')
    const filefragIdx = FX.D.stream.entries.map((e, i) => e.entry.type === 'filefrag' ? i : -1).filter(i => i >= 0)
    assert.strictEqual(filefragIdx.length, 2)
    console.log(`      块=${FX.D.totalBlocks}（${FX.D.counts.join('+')} 条）｜totalEntries=57｜record core∈块0 ∧ idfrag×3∈块1 ✓｜filefrag×2∈块${FX.D.blockIdxOf[filefragIdx[0]]}｜root=${FX.D.planRoot.slice(0, 16)}…`)
  })

  await scenario('L1 legacy 关钉：同夹具 legacy 路径全程 declared（夹具对 legacy 亦合法——防 V20 专用夹具幻觉）', async () => {
    const stack = makeStack('off')
    const bid = nonce()
    const F = FX.F, D = FX.D
    const b = await stack.call({ action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: F.packageDigest, manifestDigest: F.manifestDigest, claimedKind: 'full', totals: F.totals })
    assert.ok(b.ok, 'begin')
    const CHUNK = 40 * 1024, total = Math.ceil(F.manifestBytes.length / CHUNK)
    for (let i = 0; i < total; i++) {
      const raw = F.manifestBytes.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, F.manifestBytes.length))
      const r = await stack.call({ action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: total, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      assert.ok(r.ok, `chunk ${i}: ${JSON.stringify(r).slice(0, 120)}`)
    }
    assert.strictEqual(batchDoc(stack, bid).status, 'indexing', 'legacy 末片直转')
    let pageCursor
    for (let i = 0; i < 30; i++) {
      const r = await stack.call({ action: 'restore.indexDeclarePage', batchId: bid, ...(pageCursor === undefined ? {} : { pageCursor }) })
      assert.ok(r.ok, `legacy indexPage: ${JSON.stringify(r).slice(0, 120)}`)
      if (r.data && (r.data.status === 'declared' || r.data.hasMore === false)) break
      pageCursor = r.data && r.data.nextCursor // 夹具 50 键>页 48——须线程化游标（真实客户端形）
    }
    assert.strictEqual(batchDoc(stack, bid).status, 'declared', 'legacy 全程 declared')
    const longDecl = stack.cloud.__docs.get(`mc_restore_declarations/${bid}:decl:reports:47`)
    assert.strictEqual(longDecl && longDecl.id, LONG_ID, 'legacy 路径长 id 声明亦持全文（对照基准）')
  })

  // ══ F1 消费后全长 id 恢复【预期红】══
  await scenario('F1 全块消费（块0+块1）→declared：长 id 记录声明恢复**精确全长 id**（idRef+idfrag 经已验证指针重建）＋身份字段＋blockIndex=core 块0＋声明总数=57', async () => {
    const stack = makeStack('true')
    const bid = await walkToIndexing(FX.F, FX.D, stack)
    for (let i = 0; i < FX.D.totalBlocks; i++) {
      const r = await stack.call({ action: 'restore.indexDeclarePage', batchId: bid, blockIndex: i })
      assert.ok(r.ok, `消费块${i} 须 ok（实得 ${JSON.stringify(r).slice(0, 130)}）`)
    }
    const bd = batchDoc(stack, bid)
    assert.strictEqual(bd.status, 'declared', '全块消费后 declared')
    assert.strictEqual(bd.consumedCursor, FX.D.totalBlocks, `consumedCursor=${FX.D.totalBlocks}`)
    const decl = stack.cloud.__docs.get(`mc_restore_declarations/${bid}:decl:reports:47`)
    assert.ok(decl, '长 id 记录声明在场')
    assert.strictEqual(decl.id, LONG_ID, `声明须恢复**精确全长 id**（3000 字符逐字节——实得 len=${decl.id && decl.id.length}）`)
    assert.strictEqual(decl.revision, 0); assert.strictEqual(decl.deleted, false)
    assert.ok(/^[0-9a-f]{64}$/.test(String(decl.hash)), 'hash 64hex')
    assert.strictEqual(decl.blockIndex, 0, 'blockIndex=core 所在块 0')
    const allDecl = [...stack.cloud.__docs.keys()].filter(k => k.startsWith(`mc_restore_declarations/${bid}`)).length
    assert.strictEqual(allDecl, 57, `声明总数=totalEntries 57（实得 ${allDecl}）`)
  })

  // ══ F2 碎片薄指针【预期红】══
  await scenario('F2 碎片薄指针：idfrag×3+filefrag×2 指针在场、blockIndex=1（实际所在块）、恰三字段——不复制 id/path 字段字节（指针序列化 <200B）', async () => {
    const stack = makeStack('true')
    const bid = await walkToIndexing(FX.F, FX.D, stack)
    for (let i = 0; i < FX.D.totalBlocks; i++) {
      const r = await stack.call({ action: 'restore.indexDeclarePage', batchId: bid, blockIndex: i })
      assert.ok(r.ok, `消费块${i}（实得 ${JSON.stringify(r).slice(0, 110)}）`)
    }
    const ptrs = ptrDocs(stack, bid)
    const byType = {}
    ptrs.forEach(p => { byType[p.doc.type] = (byType[p.doc.type] || 0) + 1 })
    assert.strictEqual(byType.idfrag, 3, `idfrag 指针×3（实得 ${JSON.stringify(byType)}）`)
    assert.strictEqual(byType.filefrag, 2, 'filefrag 指针×2')
    assert.strictEqual(byType.file, 1, 'file 指针×1')
    assert.strictEqual(byType.refs, 1, 'refs 指针×1')
    assert.strictEqual(byType.rmappart, 1, 'rmappart 指针×1')
    for (const p of ptrs) {
      const keys = Object.keys(p.doc).filter(k => k !== '__v').sort()
      assert.deepStrictEqual(keys, ['blockIndex', 'type'], `薄指针恰三字段（实得 ${p.key}: ${JSON.stringify(keys)}）`)
      assert.strictEqual(p.doc.blockIndex, 1, `指针 blockIndex=实际所在块 1（实得 ${p.doc.blockIndex}）`)
      const docBytes = JSON.stringify({ _id: p.key.slice(p.key.indexOf(':ptr:')), ...p.doc })
      assert.ok(docBytes.length < 200, `指针不复制字段字节（序列化 <200B——实得 ${docBytes.length}B）`)
      assert.ok(!docBytes.includes('LLLL') && !docBytes.includes('pppp'), '指针不含 id/path 字段字节片段')
    }
  })

  // ══ F3 uploadRecord 全长 id 匹配【预期红】══
  await scenario('F3 消费后 uploadRecord 匹配正文（全长 id 零附件）ok＋持久记录 id=全长', async () => {
    const stack = makeStack('true')
    const bid = await walkToIndexing(FX.F, FX.D, stack)
    for (let i = 0; i < FX.D.totalBlocks; i++) {
      const r = await stack.call({ action: 'restore.indexDeclarePage', batchId: bid, blockIndex: i })
      assert.ok(r.ok, `消费块${i}（实得 ${JSON.stringify(r).slice(0, 110)}）`)
    }
    assert.strictEqual(batchDoc(stack, bid).status, 'declared', '前置 declared')
    const body = FX.F.body49[47]
    const u = await stack.call({ action: 'restore.uploadRecord', batchId: bid, domain: 'reports', index: 47, id: LONG_ID, revision: 0, deleted: false, record: body })
    assert.ok(u.ok, `uploadRecord 全长 id 匹配正文须 ok（实得 ${JSON.stringify(u).slice(0, 140)}）`)
    const rec = stack.cloud.__docs.get(`mc_restore_records/${bid}:reports:47`)
    assert.ok(rec, '记录持久')
    assert.strictEqual(rec.record.id, LONG_ID, '持久记录 id=全长')
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
  if (failed.length) { console.log('失败项（预期红 F1-F3：消费未实现——现行按 E11 门拒）:\n - ' + failed.join('\n - ')); process.exit(1) }
  console.log('（红先行契约固化——不构成切片完成/B3b 验收）')
}
main().catch(e => { console.error('FATAL', e); process.exit(2) })
