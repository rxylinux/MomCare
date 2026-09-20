// B3b 阶段二：D29 wire/状态边界——真 handler 对抗回归 rev1（独立套件——不触碰冻结 e580ff3b/生产）
// 协调方指派 2026-09-20（CODING 实现服务端切片期间并行红先行）：
//   W 线对抗：①未垫充 base64（可解码但重编码不等）②旧 blockBytes 线上字段（须拒）③无效 UTF-8
//   ④JSON 对象（非数组）⑤非规范空白（合法 JSON 非 canonical）⑥坏形状 proof ⑦错位 proof（合法证明
//   绑错块）——全部拒＋零写。
//   S 状态边界：⑧零块包 declaring 单事务直 declared（emptyRoot——不经 finalize；finalize invalid-state
//   拒）⑨旗标精确字符串 'true'（'1'/'TRUE' 等恒 legacy：末片直转 indexing+finalize 拒）⑩末块转 indexing
//   后重放（同字节 ok+零写——含更早块）⑪竞争请求（同块同字节=重放零写/同块异字节=冲突/正确下一块=过）
//   ⑫finalize 块事务 commit 失败注入→零半写（无块文档/游标不进/状态不变）→重试成功。
// 可达性：F/P0 腿修复前即测（旗标 legacy 钉+夹具 Stage1 有效性）；W/S 腿修复前红在 finalize 前置
// （归因断言"不得停在未知 action 门"）——预期红清单。零块夹具若 Stage1 不收→记录为夹具限制（如实报）。
// 源漂移纪律：CODING 并行实现中——每跑记录源哈希前后值，**漂移轮不称冻结**（复跑至稳定轮）。
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-b3b2-adv-'))
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')
const nonce = () => 'rst_' + crypto.randomBytes(16).toString('hex')

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

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-b3b2adv', MC_MEMBER_MAMA_OPENID: 'oTESTMAMA123456', MC_MEMBER_PAPA_OPENID: 'oTESTPAPA456789' }

function makeMockCloud() {
  const docs = new Map(), storedFiles = new Map()
  const state = { caller: TEST_ENV.MC_MEMBER_MAMA_OPENID, initialized: false, failCommitOnce: null }
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
          if (state.failCommitOnce && tx.writes.has(state.failCommitOnce.key)) {
            const err = new Error('injected commit failure: ' + state.failCommitOnce.key); err.errCode = 'CONFLICT'; throw err
          }
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
function makeStack(flagValue) { // undefined=显式删（默认关）；'true'=启用；'1'/'TRUE'=非精确值（须恒 legacy）
  for (const k of [...storage.keys()]) if (k.startsWith('mc_') || k.startsWith('YUNTU_')) storage.delete(k)
  const cloud = makeMockCloud()
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID; process.env.MC_UPLOAD_ENABLED = 'true'
  if (flagValue === undefined) delete process.env.MC_RESTORE_V20_ENABLED
  else process.env.MC_RESTORE_V20_ENABLED = flagValue
  cloud.__state.caller = TEST_ENV.MC_MEMBER_MAMA_OPENID
  const hRestore = requireRestore()
  hRestore.__setCloud(cloud)
  return { cloud, call: (event) => hRestore.main(event), flagValue }
}
const writeSnapshot = (stack) => new Map([...stack.cloud.__docs.entries()].map(([k, e]) => [k, e.__v]))
function assertZeroWrites(before, stack, label) {
  const after = writeSnapshot(stack)
  assert.strictEqual(after.size, before.size, `${label} 不得新增文档`)
  for (const [k, v] of after) assert.strictEqual(v, before.get(k), `${label} 零写失败：${k} __v ${before.get(k)}→${v}`)
}
const notUnknownAction = (r) => !/未知 action|unknown/i.test(String(r && r.code || '') + String(r && r.message || ''))

const DOMAIN_ORDER = ['pregnancy', 'daily', 'mood', 'checkup', 'bag', 'reports']
function buildPkg(records) { // records 数组（零附件）；records=null → 零块空包（无域/无文件/无记录）
  const empty = records === null
  const body = empty ? null : records
  const seg = empty ? null : Buffer.from(stage1.canonicalJsonBytes(body))
  const domains = {}
  for (const d of DOMAIN_ORDER) domains[d] = { status: 'omitted' }
  if (!empty) domains.reports = { status: 'present', recordCount: records.length, pagingComplete: true, visibility: 'shared', fileIndex: 0 }
  const manifest = {
    formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: TEST_ENV.MC_FAMILY_ID, packageKind: 'full', complete: true,
    scope: { includeShared: true, includePrivateOf: null }, scopeLabel: 'shared-only',
    domains,
    files: empty ? [] : [{ path: 'records/reports.json', kind: 'domain-json', length: seg.length, sha256: sha256(seg), contentType: 'application/json', domain: 'reports' }],
    records: empty ? {} : { reports: records.map((r, i) => ({ index: i, id: r.id, revision: r.revision, deleted: r.deleted, hash: sha256(Buffer.from(stage1.canonicalJsonBytes(r))) })) },
    reports: empty ? [] : records.map(r => ({ reportId: r.id, revision: r.revision, deleted: r.deleted, attachments: [] })),
    pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
  }
  const manifestBytes = Buffer.from(stage1.canonicalJsonBytes(manifest))
  const len8 = n => { const b = Buffer.alloc(8); b.writeUInt32BE(0, 0); b.writeUInt32BE(n, 4); return b }
  const pkg = empty ? Buffer.concat([Buffer.from(stage1.encodeHeader(manifestBytes.length)), manifestBytes])
    : Buffer.concat([Buffer.from(stage1.encodeHeader(manifestBytes.length)), manifestBytes, len8(seg.length), seg])
  const recCount = empty ? 0 : records.length
  return { pkg, manifest, manifestBytes, manifestDigest: sha256(manifestBytes), packageDigest: sha256(pkg), totals: { files: empty ? 0 : 1, records: recCount, domainCounts: empty ? {} : { reports: recCount } } }
}
async function stage1Validate(pkg) {
  return stage1.validatePackage({ size: async () => pkg.length, readChunk: async (p, l) => new Uint8Array(pkg.subarray(p, p + l)) })
}
function deriveIndependent(pkg, manifestBytes) {
  const off = pkg.indexOf(manifestBytes)
  assert.ok(off === 24, 'wire manifest 定位头 24B')
  const wire = JSON.parse(pkg.subarray(off, off + manifestBytes.length).toString('utf8'))
  const stream = v20.deriveV20Stream(wire)
  const blocks = v20.packBlocks(stream)
  const tree = v20.buildTree(blocks)
  return { wire, blocks, totalBlocks: blocks.length, totalEntries: stream.count, planRoot: tree.root.toString('hex'), proofs: tree.proofs, leafHex: (i) => v20.leafHash(blocks.length, i, blocks[i]).toString('hex') }
}
async function walkDeclared(F, stack) { // begin+chunks（不断言状态）
  const batchId = nonce()
  const b = await stack.call({ action: 'restore.begin', batchId, formatVersion: 1, packageDigest: F.packageDigest, manifestDigest: F.manifestDigest, claimedKind: 'full', totals: F.totals })
  assert.ok(b.ok, `begin: ${JSON.stringify(b).slice(0, 150)}`)
  const CHUNK = 40 * 1024, total = Math.ceil(F.manifestBytes.length / CHUNK)
  for (let i = 0; i < total; i++) {
    const raw = F.manifestBytes.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, F.manifestBytes.length))
    const r = await stack.call({ action: 'restore.declareChunk', batchId, chunkIndex: i, chunkTotal: total, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
    assert.ok(r.ok, `declareChunk ${i}/${total}: ${JSON.stringify(r).slice(0, 150)}`)
  }
  return batchId
}
const batchDoc = (stack, bid) => stack.cloud.__docs.get(`mc_restore_batches/${bid}`)
const fin = (stack, bid, i, b64, proof, extra) => stack.call({ action: 'restore.finalizeDeclare', batchId: bid, blockIndex: i, blockB64: b64, proof, ...(extra || {}) })

async function main() {
  console.log(`\nB3b D29 wire/状态边界真 handler 对抗回归 rev1（独立套件——预期红清单 W1-W7/S1-S4+F-legacy 钉）\n`)

  // ── P0 夹具 ──
  const ONE = {}, MULTI = {}, ZERO = {}
  await scenario('P0-① 单块夹具：Stage1 ok＋独立派定（1 块/proof 空串/170B 级）＋base64 可去垫充（len%4≠0）', async () => {
    ONE.F = buildPkg([{ id: 'rp-adv-one', revision: 0, deleted: false, attachments: [] }])
    const v = await stage1Validate(ONE.F.pkg)
    assert.ok(v.ok, `Stage1 须 ok（实得 ${JSON.stringify((v.problems || []).slice(0, 1)).slice(0, 120)}）`)
    ONE.D = deriveIndependent(ONE.F.pkg, ONE.F.manifestBytes)
    assert.strictEqual(ONE.D.totalBlocks, 1)
    const b64 = ONE.D.blocks[0].toString('base64')
    assert.ok(/=$/.test(b64), `夹具自检：单块 base64 须带垫充（${b64.length}%4=${b64.length % 4}——去垫充腿可用）`)
    console.log(`      块0=${ONE.D.blocks[0].length}B｜b64len=${b64.length}（含垫充）`)
  })
  await scenario('P0-② 多块夹具（120 记录→3 块）：Stage1 ok＋独立派定（错位 proof 腿需 ≥2 块）', async () => {
    MULTI.F = buildPkg(Array.from({ length: 120 }, (_, i) => ({ id: 'rp-adv-mb-' + String(i).padStart(3, '0'), revision: 0, deleted: false, attachments: [] })))
    const v = await stage1Validate(MULTI.F.pkg)
    assert.ok(v.ok, `Stage1 须 ok（实得 ${JSON.stringify((v.problems || []).slice(0, 1)).slice(0, 120)}）`)
    MULTI.D = deriveIndependent(MULTI.F.pkg, MULTI.F.manifestBytes)
    assert.ok(MULTI.D.totalBlocks >= 2, `须 ≥2 块（实得 ${MULTI.D.totalBlocks}）`)
    console.log(`      块=${MULTI.D.totalBlocks}｜条目=${MULTI.D.totalEntries}｜root=${MULTI.D.planRoot.slice(0, 16)}…`)
  })
  await scenario('P0-③ 零块夹具（空包：无域/无文件/无记录）：Stage1 validatePackage 判定记录（拒绝=夹具限制如实报）', async () => {
    ZERO.F = buildPkg(null)
    const v = await stage1Validate(ZERO.F.pkg)
    ZERO.stage1Ok = !!v.ok
    ZERO.D = deriveIndependent(ZERO.F.pkg, ZERO.F.manifestBytes)
    assert.strictEqual(ZERO.D.totalBlocks, 0, '空包独立派定=零块')
    assert.strictEqual(ZERO.D.totalEntries, 0, '零条目')
    if (v.ok) console.log('      Stage1 接受空包（零块腿可达）')
    else console.log(`      夹具限制：Stage1 拒空包（${(v.problems || [])[0] && v.problems[0].code}: ${String((v.problems || [])[0] && v.problems[0].message).slice(0, 60)}）——S1 零块腿按此前置判定（拒绝则红归因于此并如实报）`)
    assert.ok(true, '判定记录（不在此断言接受或拒）')
  })

  // ── F 旗标边界（修复前可达——legacy 钉）──
  for (const [flagVal, tag] of [['1', "flag='1'"], ['TRUE', "flag='TRUE'"]]) {
    await scenario(`F1 ${tag} 非精确 'true' → 恒 legacy：末片直转 indexing（非 preparing）＋finalizeDeclare 拒`, async () => {
      const stack = makeStack(flagVal)
      const bid = await walkDeclared(ONE.F, stack)
      assert.strictEqual(batchDoc(stack, bid).status, 'indexing', `非精确 'true' 须走 legacy（实得 ${batchDoc(stack, bid).status}）——启用须精确字符串 'true'`)
      const r = await fin(stack, bid, 0, ONE.D.blocks[0].toString('base64'), ONE.D.proofs[0])
      assert.ok(!r.ok, 'legacy 下 finalizeDeclare 不可用')
    })
  }

  // ── W 线对抗（修复前红在 finalize 前置——归因断言）──
  await scenario('W1 未垫充 base64（可解码但重编码不等）：拒＋零写', async () => {
    const stack = makeStack('true')
    const bid = await walkDeclared(ONE.F, stack)
    const unpadded = ONE.D.blocks[0].toString('base64').replace(/=+$/, '')
    assert.ok(unpadded !== ONE.D.blocks[0].toString('base64') && Buffer.from(unpadded, 'base64').length > 0, '夹具自检：去垫充形可解码')
    const before = writeSnapshot(stack)
    const r = await fin(stack, bid, 0, unpadded, ONE.D.proofs[0])
    assert.ok(!r.ok, '非规范（未垫充）base64 须拒')
    assert.ok(notUnknownAction(r), `当前拒因=未知 action 门——目标 base64 规范门未实现（红先行归因）`)
    assertZeroWrites(before, stack, 'W1')
  })
  await scenario('W2 旧 blockBytes 线上字段（无 blockB64）：拒＋零写（D29：线上恒 blockB64）', async () => {
    const stack = makeStack('true')
    const bid = await walkDeclared(ONE.F, stack)
    const before = writeSnapshot(stack)
    const r = await stack.call({ action: 'restore.finalizeDeclare', batchId: bid, blockIndex: 0, blockBytes: ONE.D.blocks[0].toString('base64'), proof: ONE.D.proofs[0] })
    assert.ok(!r.ok, '旧 wire 字段须拒（不回落解释）')
    assert.ok(notUnknownAction(r), '红先行归因：动作存在后旧字段须 invalid-params')
    assertZeroWrites(before, stack, 'W2')
  })
  await scenario('W3 无效 UTF-8 解码体：拒＋零写（严格 UTF-8 门）', async () => {
    const stack = makeStack('true')
    const bid = await walkDeclared(ONE.F, stack)
    const bad = Buffer.from([0xff, 0xfe, 0xff])
    const before = writeSnapshot(stack)
    const r = await fin(stack, bid, 0, bad.toString('base64'), ONE.D.proofs[0])
    assert.ok(!r.ok, '无效 UTF-8 须拒')
    assert.ok(notUnknownAction(r), '红先行归因')
    assertZeroWrites(before, stack, 'W3')
  })
  await scenario('W4 解码为 JSON 对象（非数组）：拒＋零写', async () => {
    const stack = makeStack('true')
    const bid = await walkDeclared(ONE.F, stack)
    const obj = Buffer.from(v20.canonicalJsonBytes({ type: 'record', domain: 'reports', index: 0 }))
    const before = writeSnapshot(stack)
    const r = await fin(stack, bid, 0, obj.toString('base64'), ONE.D.proofs[0])
    assert.ok(!r.ok, '对象形 entries 须拒（D21 数组）')
    assert.ok(notUnknownAction(r), '红先行归因')
    assertZeroWrites(before, stack, 'W4')
  })
  await scenario('W5 非规范空白（合法 JSON 数组+空格分隔）：拒＋零写', async () => {
    const stack = makeStack('true')
    const bid = await walkDeclared(ONE.F, stack)
    const compact = JSON.stringify(JSON.parse(ONE.D.blocks[0].toString('utf8')))
    assert.strictEqual(compact, ONE.D.blocks[0].toString('utf8'), '夹具自检：紧凑往返=canonical（下方空格形为真非规范形）')
    const spaced = Buffer.from(compact.replace(/,/g, ', '))
    const before = writeSnapshot(stack)
    const r = await fin(stack, bid, 0, spaced.toString('base64'), ONE.D.proofs[0])
    assert.ok(!r.ok, '非 canonical（空白）须拒')
    assert.ok(notUnknownAction(r), '红先行归因')
    assertZeroWrites(before, stack, 'W5')
  })
  await scenario('W6 坏形状 proof（T=1 须空串——发送 4B 证明）：拒＋零写', async () => {
    const stack = makeStack('true')
    const bid = await walkDeclared(ONE.F, stack)
    const before = writeSnapshot(stack)
    const r = await fin(stack, bid, 0, ONE.D.blocks[0].toString('base64'), 'AAAA')
    assert.ok(!r.ok, 'proof 形状（长度）须拒')
    assert.ok(notUnknownAction(r), '红先行归因')
    assertZeroWrites(before, stack, 'W6')
  })
  await scenario('W7 错位 proof（块 0 字节＋块 1 合法证明——多块夹具）：拒＋零写', async () => {
    const stack = makeStack('true')
    const bid = await walkDeclared(MULTI.F, stack)
    const before = writeSnapshot(stack)
    const r = await fin(stack, bid, 0, MULTI.D.blocks[0].toString('base64'), MULTI.D.proofs[1])
    assert.ok(!r.ok, '错位证明须拒（叶折叠≠冻结根）')
    assert.ok(notUnknownAction(r), '红先行归因')
    assertZeroWrites(before, stack, 'W7')
  })

  // ── S 状态边界 ──
  await scenario('S1 零块包（若 Stage1 收）：启用末片单事务直 declared（emptyRoot——不经 finalize）＋finalizeDeclare invalid-state 拒＋零写', async () => {
    assert.ok(ZERO.stage1Ok, ZERO.stage1Ok ? '' : '夹具限制：Stage1 拒空包——零块腿不可达（如实报告；需协调方裁定空包合法性或另途构造零块包）')
    const stack = makeStack('true')
    const bid = await walkDeclared(ZERO.F, stack)
    const bd = batchDoc(stack, bid)
    assert.strictEqual(bd && bd.status, 'declared', `零块包末片须单事务直 declared（实得 ${bd && bd.status}——不经 preparing/finalize）`)
    if (bd && 'planRoot' in bd) assert.strictEqual(bd.planRoot, v20.emptyRoot().toString('hex'), 'planRoot=emptyRoot')
    const before = writeSnapshot(stack)
    const r = await fin(stack, bid, 0, Buffer.from('[]').toString('base64'), '')
    assert.ok(!r.ok, '零块包 finalizeDeclare 须拒（invalid-state——不经 finalize）')
    assert.ok(notUnknownAction(r), '红先行归因')
    assertZeroWrites(before, stack, 'S1')
  })
  await scenario('S2 竞争请求（多块 cursor=1）：同块同字节=ok 零写／同块异字节=冲突拒＋零写／正确块 1=过', async () => {
    const stack = makeStack('true')
    const bid = await walkDeclared(MULTI.F, stack)
    const r0 = await fin(stack, bid, 0, MULTI.D.blocks[0].toString('base64'), MULTI.D.proofs[0])
    assert.ok(r0.ok, `前置 块0 ok（实得 ${JSON.stringify(r0).slice(0, 120)}）`)
    // ① 同块同字节（竞争重放）
    const before1 = writeSnapshot(stack)
    const rSame = await fin(stack, bid, 0, MULTI.D.blocks[0].toString('base64'), MULTI.D.proofs[0])
    assert.ok(rSame.ok, '同块同字节（竞争/重试）须 ok')
    assertZeroWrites(before1, stack, 'S2-同块同字节')
    // ② 同块异字节（竞争冲突）
    const entries = JSON.parse(MULTI.D.blocks[0].toString('utf8')); entries[0].revision = 9
    const changed = Buffer.from(v20.canonicalJsonBytes(entries))
    const before2 = writeSnapshot(stack)
    const rDiff = await fin(stack, bid, 0, changed.toString('base64'), MULTI.D.proofs[0])
    assert.ok(!rDiff.ok, '同块异字节须冲突拒')
    assert.ok(notUnknownAction(rDiff), '红先行归因（前置已红则此腿随红）')
    assertZeroWrites(before2, stack, 'S2-同块异字节')
    // ③ 正确下一块
    const r1 = await fin(stack, bid, 1, MULTI.D.blocks[1].toString('base64'), MULTI.D.proofs[1])
    assert.ok(r1.ok, `正确块 1 须过（实得 ${JSON.stringify(r1).slice(0, 120)}）`)
    assert.strictEqual(batchDoc(stack, bid).prepCursor, 2, '游标=2')
  })
  await scenario('S3 终态重放（末块转 indexing 后）：同字节重放末块与更早块均 ok＋零写（丢响应重试不失败）', async () => {
    const stack = makeStack('true')
    const bid = await walkDeclared(MULTI.F, stack)
    for (let i = 0; i < MULTI.D.totalBlocks; i++) {
      const r = await fin(stack, bid, i, MULTI.D.blocks[i].toString('base64'), MULTI.D.proofs[i])
      assert.ok(r.ok, `前置 块${i} ok（实得 ${JSON.stringify(r).slice(0, 120)}）`)
    }
    assert.strictEqual(batchDoc(stack, bid).status, 'indexing', '前置：终态 indexing')
    const before = writeSnapshot(stack)
    const rLast = await fin(stack, bid, MULTI.D.totalBlocks - 1, MULTI.D.blocks[MULTI.D.totalBlocks - 1].toString('base64'), MULTI.D.proofs[MULTI.D.totalBlocks - 1])
    assert.ok(rLast.ok, '终态重放末块须 ok')
    const rEarly = await fin(stack, bid, 0, MULTI.D.blocks[0].toString('base64'), MULTI.D.proofs[0])
    assert.ok(rEarly.ok, '终态重放更早块须 ok（字节级幂等）')
    assertZeroWrites(before, stack, 'S3')
    assert.strictEqual(batchDoc(stack, bid).status, 'indexing', '终态不得回退/推进')
  })
  await scenario('S4 finalize 块事务 commit 失败注入：失败暴露＋零半写（无块文档/游标不进/状态不变）→重试成功', async () => {
    const stack = makeStack('true')
    const bid = await walkDeclared(MULTI.F, stack)
    const r0 = await fin(stack, bid, 0, MULTI.D.blocks[0].toString('base64'), MULTI.D.proofs[0])
    assert.ok(r0.ok, `前置 块0 ok（实得 ${JSON.stringify(r0).slice(0, 120)}）——红先行归因点`)
    const before = writeSnapshot(stack)
    stack.cloud.__state.failCommitOnce = { key: `mc_restore_blocks/${bid}:blk:1` }
    let r1 = null, threw = null
    try { r1 = await fin(stack, bid, 1, MULTI.D.blocks[1].toString('base64'), MULTI.D.proofs[1]) } catch (e) { threw = e }
    stack.cloud.__state.failCommitOnce = null
    assert.ok(threw || !r1.ok, `注入的块事务失败须暴露（实得 threw=${!!threw} r1=${r1 && JSON.stringify(r1).slice(0, 90)}）`)
    assert.ok(!stack.cloud.__docs.get(`mc_restore_blocks/${bid}:blk:1`), '零半写：块 1 文档不得存在')
    assertZeroWrites(before, stack, 'S4-注入期')
    assert.strictEqual(batchDoc(stack, bid).status, 'preparing', '状态不变（仍 preparing）')
    const r2 = await fin(stack, bid, 1, MULTI.D.blocks[1].toString('base64'), MULTI.D.proofs[1])
    assert.ok(r2.ok, `重试块 1 须成功（实得 ${JSON.stringify(r2).slice(0, 120)}）`)
    assert.ok(stack.cloud.__docs.get(`mc_restore_blocks/${bid}:blk:1`), '重试后块 1 文档在场')
    assert.strictEqual(batchDoc(stack, bid).prepCursor, 2, '游标=2')
  })

  // ── 冻结源复核（漂移=本轮不作冻结证据——须复跑）──
  console.log('\n冻结源复核:')
  let drifted = false
  for (const [rel, h] of Object.entries(frozenHashes)) {
    const now = sha256(fs.readFileSync(path.join(root, rel)))
    const same = now === h
    if (!same) drifted = true
    console.log(`  ${now.slice(0, 8)} ${same ? '==' : '≠'}  ${rel}`)
  }
  if (drifted) failed.push('源漂移：加载时≠结束时（本轮不作冻结证据——CODING 并行实现中，须复跑至稳定轮）')

  console.log(`\n${passed} 通过, ${failed.length} 失败`)
  if (failed.length) { console.log('失败项（红先行：W/S 腿修复前红在 finalize 前置/归因；F/P0 预期绿）:\n - ' + failed.join('\n - ')); process.exit(1) }
  console.log('（对抗回归——不构成切片完成/B3b 验收）')
}
main().catch(e => { console.error('FATAL', e); process.exit(2) })
