// B3b 阶段二：V20 消费切片审查缺口 R1/R2＋事务总操作数诊断——真 handler 红先行套件 rev1
// （独立——不触生产/既往冻结套件；现行源 index=a6fb4ee5×v20=4cb1f4d1——消费器已落地）
// 协调方指派 2026-09-20 两缺口＋一诊断：
//   R1 §6.4：blockIndex<consumedCursor 幂等**含末块**（declared 态合法重试）——现行 consumeBlockV20
//      :1186 状态门（仅 indexing）先于 :1202 重放分支 → declared 态同块重试被 invalid-state 拒。
//      R1a：declared 后重试块 0 → 须 replayed ok＋绝对零写【预期红——状态门】。
//      R1b：declared 后腐蚀存储块 proof 再重试 → 须 fail-closed 拒＋零写——**归因断言：拒因不得为
//      "仅 indexing"状态门**（重放路径亦须 verifiedBlockRead 全验——C2 语义）【预期红——同门】。
//   R2 §6.5：上传映射链用**已验证 refs 与 rmappart 指针**——现行 v20RebuildReportMapping 只走
//      rmappart 链（refs 指针全程未消费）→ 仅篡改 refs 薄指针 blockIndex 至不存在块后 uploadRecord
//      原始正文须拒＋零写【预期红——现行接受】；C+ 正控（未篡改上传 ok）证明链路本身通。
//   D1 诊断（独立于 R1/R2 验收）：事务**总文档操作数**=get+set+remove（非仅写）——48 条目块消费事务
//      实测峰值，对照协议自设 50 上限与 CloudBase 官方 100 上限；>50 只报告不判红（设计裁量归协调方），
//      >100 判红（官方硬限）。
//   D2 诊断（审查扩展 2026-09-20——跨块父声明更新形）：块 0=47 短记录+长 id core（恰 48 条目）；
//      块 1=该记录单 idfrag 领头+47 短记录（恰 48 条目）——块 1 消费须**更新块 0 已写的父声明**
//      （idRef+idfrag 跨块补全）。夹具显式断言两块恰 48 条目∧字节帽内∧摆位；仪表计块 1 消费事务
//      get+set+remove 总数——预期 ~99-100（48 对+父更新对+批次对）；≤100 官方硬门判红；仅诊断，
//      非 R1/R2 新红契约。
// 修复后同哈希须全绿（D1 的 >100 硬门含内）；源漂移轮不作冻结证据。
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-b3b2-r12-'))
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

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-b3b2r12', MC_MEMBER_MAMA_OPENID: 'oTESTMAMA123456', MC_MEMBER_PAPA_OPENID: 'oTESTPAPA456789' }

function makeMockCloud() {
  const docs = new Map(), storedFiles = new Map()
  const state = { caller: TEST_ENV.MC_MEMBER_MAMA_OPENID, initialized: false, maxTxOps: 0, maxTxTotalOps: 0, lastTxOps: null }
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
          // 诊断仪表：单事务总文档操作数=get+set+remove（非仅写）
          const total = tx.reads.size + tx.writes.size + tx.removes.size
          state.lastTxOps = { gets: tx.reads.size, sets: tx.writes.size, removes: tx.removes.size, total }
          if (tx.writes.size > state.maxTxOps) state.maxTxOps = tx.writes.size
          if (total > state.maxTxTotalOps) state.maxTxTotalOps = total
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
const RID = 'rp-r12-att', OID = 'r12-oid'
function buildPkg(records, att) { // records: [{id,...}]；att={oid,bytes} 则首记录带附件+附件文件
  const body0 = records[0]
  const seg = Buffer.from(stage1.canonicalJsonBytes(records))
  const domains = {}
  for (const d of DOMAIN_ORDER) domains[d] = { status: 'omitted' }
  domains.reports = { status: 'present', recordCount: records.length, pagingComplete: true, visibility: 'shared', fileIndex: att ? 1 : 0 }
  const files = []
  if (att) files.push({ path: 'attachments/r12.bin', kind: 'attachment', length: att.bytes.length, sha256: sha256(att.bytes), contentType: 'image/png', originalFileId: att.oid, chunkSha256: [sha256(att.bytes)], referencedBy: [RID] })
  files.push({ path: 'records/reports.json', kind: 'domain-json', length: seg.length, sha256: sha256(seg), contentType: 'application/json', domain: 'reports' })
  const manifest = {
    formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: TEST_ENV.MC_FAMILY_ID, packageKind: 'full', complete: true,
    scope: { includeShared: true, includePrivateOf: null }, scopeLabel: 'shared-only', domains, files,
    records: { reports: records.map((r, i) => ({ index: i, id: r.id, revision: r.revision, deleted: r.deleted, hash: sha256(Buffer.from(stage1.canonicalJsonBytes(r))) })) },
    reports: records.map((r, i) => (att && i === 0)
      ? { reportId: r.id, revision: 0, deleted: false, attachments: [{ order: 0, originalFileId: att.oid, fileIndex: 0 }] }
      : { reportId: r.id, revision: 0, deleted: false, attachments: [] }),
    pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
  }
  const manifestBytes = Buffer.from(stage1.canonicalJsonBytes(manifest))
  const len8 = n => { const b = Buffer.alloc(8); b.writeUInt32BE(0, 0); b.writeUInt32BE(n, 4); return b }
  const parts = [Buffer.from(stage1.encodeHeader(manifestBytes.length)), manifestBytes]
  if (att) parts.push(len8(att.bytes.length), att.bytes)
  parts.push(len8(seg.length), seg)
  return { pkg: Buffer.concat(parts), manifestBytes, body0: records[0], manifestDigest: sha256(manifestBytes), packageDigest: sha256(Buffer.concat(parts)), totals: { files: files.length, records: records.length, domainCounts: { reports: records.length } } }
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
  return { stream, blocks, totalBlocks: blocks.length, totalEntries: stream.count, planRoot: tree.root.toString('hex'), proofs: tree.proofs }
}
// 启用态全程到 declared
async function walkToDeclared(F, D, stack) {
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
  for (let i = 0; i < D.totalBlocks; i++) {
    const r = await stack.call({ action: 'restore.indexDeclarePage', batchId, blockIndex: i })
    assert.ok(r.ok, `消费块${i}: ${JSON.stringify(r).slice(0, 140)}`)
  }
  assert.strictEqual(stack.cloud.__docs.get(`mc_restore_batches/${batchId}`).status, 'declared', '前置 declared')
  return batchId
}
const idxPage = (stack, bid, i) => stack.call({ action: 'restore.indexDeclarePage', batchId: bid, blockIndex: i })

async function main() {
  console.log(`\nB3b V20 消费缺口 R1（declared 态幂等重试）+R2（refs 指针链接）+事务总操作数诊断 rev1\n`)

  const ATT = {}, F48 = {}
  await scenario('P0-① 单块带附件夹具钉：[record,file,refs,rmappart]×1 单块（R1/R2 用）', async () => {
    ATT.F = buildPkg([{ id: RID, revision: 0, deleted: false, note: 'x'.repeat(60), attachments: [{ fileId: OID, order: 0 }] }], { oid: OID, bytes: Buffer.alloc(8, 0x52) })
    const v = await stage1Validate(ATT.F.pkg)
    assert.ok(v.ok, `Stage1 ok（${JSON.stringify((v.problems || []).slice(0, 1)).slice(0, 100)}）`)
    ATT.D = deriveIndependent(ATT.F)
    assert.strictEqual(ATT.D.totalBlocks, 1)
    assert.strictEqual(ATT.D.totalEntries, 4)
    console.log(`      块0=${ATT.D.blocks[0].length}B｜root=${ATT.D.planRoot.slice(0, 16)}…`)
  })
  await scenario('P0-② 48 条目块夹具钉：恰 48 record 条目单块（D1 诊断用）', async () => {
    F48.F = buildPkg(Array.from({ length: 48 }, (_, i) => ({ id: 'rp-r12-f' + String(i).padStart(2, '0'), revision: 0, deleted: false, attachments: [] })))
    const v = await stage1Validate(F48.F.pkg)
    assert.ok(v.ok, 'Stage1 ok')
    F48.D = deriveIndependent(F48.F)
    assert.strictEqual(F48.D.totalBlocks, 1, `单块（实得 ${F48.D.totalBlocks}）`)
    assert.strictEqual(JSON.parse(F48.D.blocks[0].toString('utf8')).length, 48, '块内恰 48 条目（条目帽）')
    assert.strictEqual(F48.D.totalEntries, 48)
  })

  await scenario('C+ 正控：declared 后 uploadRecord 未篡改原始正文 ok＋记录持久（R2 对照——链路本身通）', async () => {
    const stack = makeStack('true')
    const bid = await walkToDeclared(ATT.F, ATT.D, stack)
    const u = await stack.call({ action: 'restore.uploadRecord', batchId: bid, domain: 'reports', index: 0, id: RID, revision: 0, deleted: false, record: ATT.F.body0 })
    assert.ok(u.ok, `正控 uploadRecord 须 ok（实得 ${JSON.stringify(u).slice(0, 140)}）`)
    assert.ok(stack.cloud.__docs.get(`mc_restore_records/${bid}:reports:0`), '记录持久')
  })

  // ══ R1a：declared 态同块幂等重试【预期红——状态门先于重放分支】══
  await scenario('R1a §6.4 含末块幂等：declared 后重试 indexDeclarePage{blockIndex:0}→须 replayed ok＋绝对零写【红：现行"仅 indexing"状态门拒】', async () => {
    const stack = makeStack('true')
    const bid = await walkToDeclared(ATT.F, ATT.D, stack)
    const before = writeSnapshot(stack)
    const r = await idxPage(stack, bid, 0)
    assert.ok(r.ok, `declared 态同块重试须 ok（§6.4：blockIndex<consumedCursor 幂等**含末块**）（实得 ${JSON.stringify(r).slice(0, 130)}）`)
    assert.ok(r.data && r.data.replayed === true, `须为重放族（实得 ${JSON.stringify(r && r.data)}）`)
    assertZeroWrites(before, stack, 'R1a 重试')
    assert.strictEqual(stack.cloud.__docs.get(`mc_restore_batches/${bid}`).status, 'declared', '状态不动')
  })

  // ══ R1b：declared 态腐蚀 proof 后重试——fail-closed 拒＋零写（归因：非状态门）【预期红】══
  await scenario('R1b declared 态腐蚀存储块 proof 再重试→须 fail-closed 拒＋零写——重放路径同验 verifiedBlockRead（归因断言：拒因≠"仅 indexing"状态门）【红】', async () => {
    const stack = makeStack('true')
    const bid = await walkToDeclared(ATT.F, ATT.D, stack)
    const blk = stack.cloud.__docs.get(`mc_restore_blocks/${bid}:blk:0`)
    assert.ok(blk, '块文档在场')
    blk.proof = 'AAAA' // 腐蚀证明
    const before = writeSnapshot(stack)
    const r = await idxPage(stack, bid, 0)
    assert.ok(!r.ok, '腐蚀 proof 的重试须拒（重放不验即报 replayed=C2 语义违反）')
    assert.ok(!/仅 indexing|invalid-state.*indexing/i.test(String(r.message || '')), `拒因不得为状态门（实得 ${r.code}: ${String(r.message).slice(0, 90)}）——须为验证族拒`)
    assert.ok(/proof|证明|根|sha|叶|verify|验证|不符|mismatch/i.test(String(r.code || '') + String(r.message || '')), `拒因=验证族（实得 ${r.code}: ${String(r.message).slice(0, 90)}）`)
    assertZeroWrites(before, stack, 'R1b')
  })

  // ══ R2：refs 薄指针链接【预期红——现行 rebuild 只走 rmappart】══
  await scenario('R2 §6.5 refs 指针链接：仅篡改 refs 薄指针 blockIndex 至不存在块（5）→uploadRecord 原始正文须拒＋零写＋零持久【红：现行 v20RebuildReportMapping 不消费 refs——接受】', async () => {
    const stack = makeStack('true')
    const bid = await walkToDeclared(ATT.F, ATT.D, stack)
    const key = [...stack.cloud.__docs.keys()].find(k => k.startsWith(`mc_restore_declarations/${bid}:ptr:`) && stack.cloud.__docs.get(k).type === 'refs')
    assert.ok(key, '前置：refs 薄指针在场')
    stack.cloud.__docs.get(key).blockIndex = 5 // 仅篡改 refs 指针——rmappart/file/块全不动
    const before = writeSnapshot(stack)
    const u = await stack.call({ action: 'restore.uploadRecord', batchId: bid, domain: 'reports', index: 0, id: RID, revision: 0, deleted: false, record: ATT.F.body0 })
    assert.ok(!u.ok, `refs 指针被篡改后 uploadRecord 须拒（§6.5：上传映射链用已验证 refs 与 rmappart 指针——refs 须参与链接）（实得 ${JSON.stringify(u).slice(0, 130)}）`)
    assert.ok(/refs|指针|block|块|verify|验证|不符|mismatch|invalid/i.test(String(u.code || '') + String(u.message || '')), `拒因=指针/验证族（实得 ${u.code}: ${String(u.message).slice(0, 80)}）`)
    assertZeroWrites(before, stack, 'R2')
    assert.ok(!stack.cloud.__docs.get(`mc_restore_records/${bid}:reports:0`), '零写：记录不得持久')
  })

  // ══ D1 诊断：48 条目块消费事务总文档操作数（get+set+remove）【独立——非 R1/R2 验收】══
  await scenario('D1 诊断：48 条目块消费事务总操作数实测（get+set+remove）——≤100 官方硬门判红；>50 协议自设只报告（设计裁量）', async () => {
    const stack = makeStack('true')
    const bid = await walkToDeclared(F48.F, F48.D, stack) // 末块消费事务已发生
    const peak = stack.cloud.__state.maxTxTotalOps
    const last = stack.cloud.__state.lastTxOps
    assert.ok(peak > 0, '仪表须观测到事务')
    console.log(`      观测：单事务峰值总操作数=${peak}（协议自设 50／CloudBase 官方 100）｜最大写数=${stack.cloud.__state.maxTxOps}｜末事务构成=${JSON.stringify(last)}`)
    if (peak > 50) console.log(`      报告（不判红——设计裁量归协调方）：48 条目块消费事务总操作数 ${peak} > 协议自设 50 上限——自设口径或须按"总操作"重述/上调（官方 100 内）`)
    assert.ok(peak <= 100, `CloudBase 官方 100 操作硬限（实测 ${peak}）——超限即红`)
  })

  // ══ P0-③ D2 夹具：块0=47短+长id core 恰48；块1=idfrag领头+47短 恰48（显式摆位断言）══
  const X48 = {}
  await scenario('P0-③ 跨块父更新夹具钉：块0=47短+长id core（idRef.frags=1）恰48∧块1=单idfrag领头+47短恰48∧两块 ≤BLOCK_NET——摆位显式断言', async () => {
    const LONG2 = 'D'.repeat(1200) // canonical 1202B → 单 idfrag
    const recs = []
    for (let i = 0; i < 47; i++) recs.push({ id: 'rp-d2-' + String(i).padStart(2, '0'), revision: 0, deleted: false, attachments: [] })
    recs.push({ id: LONG2, revision: 0, deleted: false, attachments: [] })            // index 47——长 id core
    for (let i = 0; i < 47; i++) recs.push({ id: 'rp-d2-' + String(48 + i).padStart(2, '0'), revision: 0, deleted: false, attachments: [] }) // 48..94
    X48.F = buildPkg(recs)
    const v = await stage1Validate(X48.F.pkg)
    assert.ok(v.ok, `Stage1 ok（${JSON.stringify((v.problems || []).slice(0, 1)).slice(0, 100)}）`)
    X48.D = deriveIndependent(X48.F)
    assert.strictEqual(X48.D.totalBlocks, 2, `恰 2 块（实得 ${X48.D.totalBlocks}）`)
    assert.strictEqual(X48.D.totalEntries, 96, '95 record+1 idfrag=96 条目')
    const counts = X48.D.blocks.map(b => JSON.parse(b.toString('utf8')).length)
    assert.deepStrictEqual(counts, [48, 48], `两块各恰 48 条目（实得 ${JSON.stringify(counts)}）`)
    X48.D.blocks.forEach((b, i) => assert.ok(b.length <= v20.BLOCK_NET, `块${i}=${b.length}B ≤BLOCK_NET ${v20.BLOCK_NET}`))
    // 摆位：entry47=长 id core（idRef 单 frag）∈块0；entry48=idfrag∈块1 领头
    const e47 = X48.D.stream.entries[47].entry, e48 = X48.D.stream.entries[48].entry
    assert.strictEqual(e47.type, 'record') 
    assert.ok(e47.idRef && e47.id === undefined && e47.idRef.frags === 1, 'core=idRef 单 frag（无全文 id）')
    assert.strictEqual(e48.type, 'idfrag', 'entry48=idfrag（紧随其 core）')
    const blockIdxOf = new Array(96); { let e = 0; for (let b = 0; b < 2; b++) for (let j = 0; j < counts[b]; j++) blockIdxOf[e++] = b }
    assert.strictEqual(blockIdxOf[47], 0, '长 id core ∈块0（第 48 条——条目帽）')
    assert.strictEqual(blockIdxOf[48], 1, 'idfrag ∈块1（领头——跨块摆位成立）')
    console.log(`      块=${X48.D.blocks.map(b => b.length + 'B').join('｜')}｜摆位 core∈0/idfrag∈1 ✓｜root=${X48.D.planRoot.slice(0, 16)}…`)
  })

  // ══ D2 诊断：块 1 消费事务（含跨块父声明更新）总操作数【仅诊断——≤100 官方硬门】══
  await scenario('D2 诊断：块 1 消费（idfrag 领头——须更新块 0 父声明）事务总操作数实测——预期 ~99-100；≤100 官方硬门判红；>50 协议自设只报告', async () => {
    assert.ok(X48.D, 'P0-③ 前置')
    const stack = makeStack('true')
    // 手动走到 indexing（不经 walkToDeclared——需逐块消费以隔离块 1 事务）
    const bid = nonce()
    const F = X48.F, D = X48.D
    const b = await stack.call({ action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: F.packageDigest, manifestDigest: F.manifestDigest, claimedKind: 'full', totals: F.totals })
    assert.ok(b.ok, 'begin')
    const CHUNK = 40 * 1024, total = Math.ceil(F.manifestBytes.length / CHUNK)
    for (let i = 0; i < total; i++) {
      const raw = F.manifestBytes.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, F.manifestBytes.length))
      const r = await stack.call({ action: 'restore.declareChunk', batchId: bid, chunkIndex: i, chunkTotal: total, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
      assert.ok(r.ok, `chunk ${i}`)
    }
    for (let i = 0; i < D.totalBlocks; i++) {
      const r = await stack.call({ action: 'restore.finalizeDeclare', batchId: bid, blockIndex: i, blockB64: D.blocks[i].toString('base64'), proof: D.proofs[i] })
      assert.ok(r.ok, `finalize 块${i}`)
    }
    assert.strictEqual(stack.cloud.__docs.get(`mc_restore_batches/${bid}`).status, 'indexing', 'indexing')
    const r0 = await idxPage(stack, bid, 0)
    assert.ok(r0.ok, `消费块0（实得 ${JSON.stringify(r0).slice(0, 110)}）`)
    const afterB0 = stack.cloud.__state.lastTxOps
    const r1 = await idxPage(stack, bid, 1)
    assert.ok(r1.ok, `消费块1（实得 ${JSON.stringify(r1).slice(0, 110)}）`)
    const blk1Tx = stack.cloud.__state.lastTxOps
    assert.strictEqual(stack.cloud.__docs.get(`mc_restore_batches/${bid}`).status, 'declared', '块1 后 declared')
    console.log(`      观测：块0 消费事务=${JSON.stringify(afterB0)}｜块1 消费事务（含跨块父声明更新）=${JSON.stringify(blk1Tx)}（总 ${blk1Tx.total}）`)
    if (blk1Tx.total > 50) console.log(`      报告（不判红）：块1 总操作 ${blk1Tx.total} > 协议自设 50（总操作口径须重述/上调——设计裁量）`)
    assert.ok(blk1Tx.total <= 100, `CloudBase 官方 100 操作硬限（块1 消费实测总 ${blk1Tx.total}）——超限即红`)
    console.log(`      官方余量=${100 - blk1Tx.total} 操作`)
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
  if (failed.length) { console.log('失败项（预期红 R1a/R1b/R2——declared 态幂等缺口+refs 指针链接缺口）:\n - ' + failed.join('\n - ')); process.exit(1) }
  console.log('（红先行契约固化——不构成切片完成/B3b 验收）')
}
main().catch(e => { console.error('FATAL', e); process.exit(2) })
