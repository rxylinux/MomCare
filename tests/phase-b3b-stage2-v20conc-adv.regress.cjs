// B3b 阶段二：V20 finalize 并发 CAS/损坏持久态/缺模块 fail-closed——真 handler 对抗回归 rev1
// （独立套件——不触冻结 e580ff3b/d3030f00/生产；CODING 切片已落地 e4bee9a1 后的深挖轮）
// 协调方指派 2026-09-20 三缺口：
//   C1 真并发 CAS：mock 加"事务批读保持"——A 事务在 tx 内读批次文档后挂起（快照=读时值），
//      B 完整提交（块+游标推进），再放行 A——两事务确曾读到**同一 prepCursor**。同字节：A 须真实结果
//      （不得伪成功）＋无丢块/重复块（恰一块/正确叶/游标 2）＋A 后零写；随后客户端重试 A→重放 ok 零写。
//      异字节竞争（事后竞者）：同块异字节→block-conflict＋零写。
//   C2 损坏种子块文档（entries 匹配但 sha256/byteLength/proof 损坏）×游标已过/当前：
//      须**无伪重放、无修复成功**（fail-closed 拒——损坏持久态不得被 entries 等价遮蔽）。
//   C3 损坏种子末片清单 chunk（chunkSha256 字段匹配但 rawB64 或 byteLength 谎报）→重试末片须**不冻结**。
//   M1 缺 v20 模块+flag true：分派门 fail-closed（internal-error 族+零写）——:342 钉。
// 预期红（五）：C2a/C2b/C2c（现行重放/修复分支只比 entries canonical——不校验损坏 sha256/byteLength/
// proof 字段）＋C3a（重组用请求字节——存储末片 rawB64 从不复验）＋C3b（byteLength 谎报不检）。
// 预期绿：P0×3/C1/C1b/M1。C3a 验收（审查澄清 2026-09-20）：合法修复可在 digest 验证**前**以
// chunk-conflict/invalid-state 拒不一致存储末片——拒因接受存储冲突/损坏族或重组/digest 族，但
// 拒绝＋不冻结＋零写三硬断言不变。修复后同哈希须 11/0。
// 源/测试哈希逐跑记录（CODING 并行演进——漂移轮不作冻结证据）。
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-b3b2-conc-'))
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')
const nonce = () => 'rst_' + crypto.randomBytes(16).toString('hex')

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }
const tick = () => new Promise(r => setImmediate(r))

const DIST = path.join(temp, 'cf')
{ const dir = path.join(DIST, 'mc-restore'); fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(path.join(root, 'cloud/functions/mc-restore/index.js'), path.join(dir, 'index.js'))
  fs.cpSync(path.join(root, 'cloud/shared'), path.join(dir, 'shared'), { recursive: true })
  fs.copyFileSync(path.join(root, 'cloud/functions/mc-restore/v20.js'), path.join(dir, 'v20.js')) }
// M1 用缺 v20 的隔离 DIST（不污染主 DIST）
const DIST_NOV20 = path.join(temp, 'cf-nov20')
{ const dir = path.join(DIST_NOV20, 'mc-restore'); fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(path.join(root, 'cloud/functions/mc-restore/index.js'), path.join(dir, 'index.js'))
  fs.cpSync(path.join(root, 'cloud/shared'), path.join(dir, 'shared'), { recursive: true }) }

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

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-b3b2conc', MC_MEMBER_MAMA_OPENID: 'oTESTMAMA123456', MC_MEMBER_PAPA_OPENID: 'oTESTPAPA456789' }

function makeMockCloud() {
  const docs = new Map(), storedFiles = new Map()
  const state = { caller: TEST_ENV.MC_MEMBER_MAMA_OPENID, initialized: false, failCommitOnce: null, holdBatchRead: null }
  const clone = x => JSON.parse(JSON.stringify(x))
  function docApi(col, id, tx) {
    return {
      // 事务批读保持（C1 真交错）：武装后首个命中 key 的**事务内** get 挂起并捕获读时快照——
      // 测试放行时以读时值 resolve（乐观 CAS 语义：读在对方提交前发生）；非事务读不挂。
      get: async () => {
        const e = docs.get(`${col}/${id}`)
        if (tx) tx.reads.set(`${col}/${id}`, e ? e.__v : 0)
        if (tx && state.holdBatchRead && !state.holdBatchRead.engaged && state.holdBatchRead.key === `${col}/${id}`) {
          const captured = e ? { ...clone(e), _id: id } : null
          state.holdBatchRead.engaged = true
          return new Promise(res => { state.holdBatchRead.resolve = () => res({ data: captured }) })
        }
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

function requireRestore(dist) { delete require.cache[require.resolve(path.join(dist, 'mc-restore/index.js'))]; return require(path.join(dist, 'mc-restore/index.js')) }
function makeStack(flagValue = 'true', dist = DIST) {
  for (const k of [...storage.keys()]) if (k.startsWith('mc_') || k.startsWith('YUNTU_')) storage.delete(k)
  const cloud = makeMockCloud()
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID; process.env.MC_UPLOAD_ENABLED = 'true'
  if (flagValue === undefined) delete process.env.MC_RESTORE_V20_ENABLED
  else process.env.MC_RESTORE_V20_ENABLED = flagValue
  cloud.__state.caller = TEST_ENV.MC_MEMBER_MAMA_OPENID
  const hRestore = requireRestore(dist)
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
function buildPkg(records) {
  const body = records
  const seg = Buffer.from(stage1.canonicalJsonBytes(body))
  const domains = {}
  for (const d of DOMAIN_ORDER) domains[d] = { status: 'omitted' }
  domains.reports = { status: 'present', recordCount: records.length, pagingComplete: true, visibility: 'shared', fileIndex: 0 }
  const manifest = {
    formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: TEST_ENV.MC_FAMILY_ID, packageKind: 'full', complete: true,
    scope: { includeShared: true, includePrivateOf: null }, scopeLabel: 'shared-only',
    domains,
    files: [{ path: 'records/reports.json', kind: 'domain-json', length: seg.length, sha256: sha256(seg), contentType: 'application/json', domain: 'reports' }],
    records: { reports: records.map((r, i) => ({ index: i, id: r.id, revision: r.revision, deleted: r.deleted, hash: sha256(Buffer.from(stage1.canonicalJsonBytes(r))) })) },
    reports: records.map(r => ({ reportId: r.id, revision: r.revision, deleted: r.deleted, attachments: [] })),
    pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
  }
  const manifestBytes = Buffer.from(stage1.canonicalJsonBytes(manifest))
  const len8 = n => { const b = Buffer.alloc(8); b.writeUInt32BE(0, 0); b.writeUInt32BE(n, 4); return b }
  const pkg = Buffer.concat([Buffer.from(stage1.encodeHeader(manifestBytes.length)), manifestBytes, len8(seg.length), seg])
  return { pkg, manifestBytes, manifestDigest: sha256(manifestBytes), packageDigest: sha256(pkg), totals: { files: 1, records: records.length, domainCounts: { reports: records.length } } }
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
  return { blocks, totalBlocks: blocks.length, totalEntries: stream.count, planRoot: tree.root.toString('hex'), proofs: tree.proofs, leafHex: (i) => v20.leafHash(blocks.length, i, blocks[i]).toString('hex') }
}
async function walkDeclared(F, stack, upto) { // begin+chunks（upto=只发前 upto 片——默认全发）；返回 batchId
  const batchId = nonce()
  const b = await stack.call({ action: 'restore.begin', batchId, formatVersion: 1, packageDigest: F.packageDigest, manifestDigest: F.manifestDigest, claimedKind: 'full', totals: F.totals })
  assert.ok(b.ok, `begin: ${JSON.stringify(b).slice(0, 140)}`)
  const CHUNK = 40 * 1024, total = Math.ceil(F.manifestBytes.length / CHUNK)
  const limit = upto === undefined ? total : upto
  for (let i = 0; i < limit; i++) {
    const raw = F.manifestBytes.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, F.manifestBytes.length))
    const r = await stack.call({ action: 'restore.declareChunk', batchId, chunkIndex: i, chunkTotal: total, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
    assert.ok(r.ok, `declareChunk ${i}/${total}: ${JSON.stringify(r).slice(0, 140)}`)
  }
  return batchId
}
const batchDoc = (stack, bid) => stack.cloud.__docs.get(`mc_restore_batches/${bid}`)
const blockDoc = (stack, bid, i) => stack.cloud.__docs.get(`mc_restore_blocks/${bid}:blk:${i}`)
const fin = (stack, bid, i, b64, proof) => stack.call({ action: 'restore.finalizeDeclare', batchId: bid, blockIndex: i, blockB64: b64, proof })

async function main() {
  console.log(`\nB3b V20 并发 CAS/损坏持久态/缺模块 fail-closed 对抗回归 rev1（预期红五项：C2a/C2b/C2c/C3a/C3b）\n`)

  const ONE = {}, MULTI = {}, BIG = {}
  await scenario('P0-① 单块夹具钉（C2 用）', async () => {
    ONE.F = buildPkg([{ id: 'rp-conc-one', revision: 0, deleted: false, attachments: [] }])
    const v = await stage1Validate(ONE.F.pkg)
    assert.ok(v.ok, `Stage1 ok（${JSON.stringify((v.problems || []).slice(0, 1)).slice(0, 100)}）`)
    ONE.D = deriveIndependent(ONE.F)
    assert.strictEqual(ONE.D.totalBlocks, 1)
  })
  await scenario('P0-② 多块夹具钉（3 块——C1/C2 游标腿用）', async () => {
    MULTI.F = buildPkg(Array.from({ length: 120 }, (_, i) => ({ id: 'rp-conc-mb-' + String(i).padStart(3, '0'), revision: 0, deleted: false, attachments: [] })))
    const v = await stage1Validate(MULTI.F.pkg)
    assert.ok(v.ok)
    MULTI.D = deriveIndependent(MULTI.F)
    assert.ok(MULTI.D.totalBlocks >= 2, `≥2 块（实得 ${MULTI.D.totalBlocks}）`)
    console.log(`      块=${MULTI.D.totalBlocks}｜root=${MULTI.D.planRoot.slice(0, 16)}…`)
  })
  await scenario('P0-③ 大清单夹具钉（manifest >40KiB→2 chunks——C3 用）', async () => {
    BIG.F = buildPkg(Array.from({ length: 220 }, (_, i) => ({ id: 'rp-conc-big-' + String(i).padStart(3, '0') + '-' + 'x'.repeat(20), revision: 0, deleted: false, attachments: [] })))
    const v = await stage1Validate(BIG.F.pkg)
    assert.ok(v.ok)
    BIG.D = deriveIndependent(BIG.F)
    const CHUNK = 40 * 1024
    assert.strictEqual(Math.ceil(BIG.F.manifestBytes.length / CHUNK), 2, `须恰 2 chunks（${BIG.F.manifestBytes.length}B）`)
  })

  // ══ C1 真并发 CAS（同字节交错）══
  await scenario('C1 同字节真交错：A 事务批读挂起→B 提交（块1+游标2）→放行 A——A 真实结果（不伪成功）＋无丢/重块＋A 后零写；重试 A→重放 ok 零写', async () => {
    const stack = makeStack('true')
    const bid = await walkDeclared(MULTI.F, stack)
    const r0 = await fin(stack, bid, 0, MULTI.D.blocks[0].toString('base64'), MULTI.D.proofs[0])
    assert.ok(r0.ok, `前置 块0 ok（${JSON.stringify(r0).slice(0, 100)}）`)
    assert.strictEqual(batchDoc(stack, bid).prepCursor, 1, '前置游标 1')
    // 武装批读保持→A（块1 同字节）启动——其事务读到游标 1 快照后挂起
    stack.cloud.__state.holdBatchRead = { key: `mc_restore_batches/${bid}`, engaged: false }
    let rA = null, threwA = null
    const pA = (async () => { try { rA = await fin(stack, bid, 1, MULTI.D.blocks[1].toString('base64'), MULTI.D.proofs[1]) } catch (e) { threwA = e } })()
    for (let i = 0; i < 200 && !stack.cloud.__state.holdBatchRead.engaged; i++) await tick()
    assert.ok(stack.cloud.__state.holdBatchRead.engaged, 'A 事务批读须已挂起（交错前置）')
    // B 完整提交（此时 A 未提交——两事务确曾同读 prepCursor=1）
    const rB = await fin(stack, bid, 1, MULTI.D.blocks[1].toString('base64'), MULTI.D.proofs[1])
    assert.ok(rB.ok, `B 须 ok（${JSON.stringify(rB).slice(0, 100)}）`)
    const afterB = writeSnapshot(stack)
    const bdB = batchDoc(stack, bid)
    assert.strictEqual(bdB.prepCursor, 2, 'B 后游标 2')
    // 放行 A（读时快照=游标 1——乐观 CAS 语义）
    stack.cloud.__state.holdBatchRead.resolve()
    stack.cloud.__state.holdBatchRead = null
    await pA
    // A 须真实结果：要么明确失败（threwA/!ok——不得伪成功），要么 ok 且必为重放族（无第二次写）
    if (!(threwA || (rA && !rA.ok))) assert.ok(rA && rA.ok && rA.data && (rA.data.replayed === true), `A 若 ok 须为重放族（实得 ${JSON.stringify(rA && rA.data)}）`)
    console.log(`      A 结果=${threwA ? 'throw(' + String(threwA.message).slice(0, 50) + ')' : JSON.stringify(rA).slice(0, 80)}`)
    // 无丢/重块：恰一块 :blk:1、sha=正确位置绑定叶；A 后零写（B 后快照=A 后快照）
    const blk1 = blockDoc(stack, bid, 1)
    assert.ok(blk1, '块 1 文档在场')
    assert.strictEqual(blk1.sha256, MULTI.D.leafHex(1), `块 1 sha256=正确叶（实得 ${blk1.sha256}）`)
    const nBlocks = [...stack.cloud.__docs.keys()].filter(k => k.startsWith(`mc_restore_blocks/${bid}:blk:`)).length
    assert.strictEqual(nBlocks, 2, `恰 2 块文档（0/1——实得 ${nBlocks}——无重复）`)
    assertZeroWrites(afterB, stack, 'C1-A 恢复后')
    assert.strictEqual(batchDoc(stack, bid).prepCursor, 2, '游标仍 2（无双推进）')
    // 客户端重试 A（若 A 失败）→重放 ok＋零写（收敛）
    const before = writeSnapshot(stack)
    const rRetry = await fin(stack, bid, 1, MULTI.D.blocks[1].toString('base64'), MULTI.D.proofs[1])
    assert.ok(rRetry.ok, `重试须 ok（${JSON.stringify(rRetry).slice(0, 100)}）`)
    assertZeroWrites(before, stack, 'C1-重试')
  })

  await scenario('C1b 异字节竞争者（B 提交后）：同块异字节→block-conflict＋零写＋无重块', async () => {
    const stack = makeStack('true')
    const bid = await walkDeclared(MULTI.F, stack)
    await fin(stack, bid, 0, MULTI.D.blocks[0].toString('base64'), MULTI.D.proofs[0])
    await fin(stack, bid, 1, MULTI.D.blocks[1].toString('base64'), MULTI.D.proofs[1])
    const entries = JSON.parse(MULTI.D.blocks[1].toString('utf8')); entries[0].revision = 9
    const changed = Buffer.from(v20.canonicalJsonBytes(entries))
    const before = writeSnapshot(stack)
    const r = await fin(stack, bid, 1, changed.toString('base64'), MULTI.D.proofs[1])
    assert.ok(!r.ok, '异字节竞争须拒')
    assert.ok(/conflict|冲突|不同字节|根|proof|证明/i.test(String(r.code || '') + String(r.message || '')), `拒因=冲突/根族（实得 ${r.code}: ${String(r.message).slice(0, 70)}）`)
    assertZeroWrites(before, stack, 'C1b')
    assert.strictEqual(batchDoc(stack, bid).prepCursor, 2, '游标不变')
  })

  // ══ C2 损坏种子块文档（entries 匹配＋字段损坏）══
  const CORRUPT_REJECT = /corrupt|篡改|损坏|不符|mismatch|不一致|sha|叶|proof|证明|internal|invalid/i
  async function seedBlockDoc(stack, bid, i, D, corrupt) {
    const data = { sha256: D.leafHex(i), byteLength: D.blocks[i].length, entryCount: JSON.parse(D.blocks[i].toString('utf8')).length, entries: JSON.parse(D.blocks[i].toString('utf8')), proof: D.proofs[i] }
    Object.assign(data, corrupt)
    stack.cloud.__docs.set(`mc_restore_blocks/${bid}:blk:${i}`, { ...data, __v: (stack.cloud.__docs.get(`mc_restore_blocks/${bid}:blk:${i}`) || { __v: 0 }).__v + 1 })
  }
  await scenario('C2a sha256 损坏+游标已过：重放不得伪成功（fail-closed 拒——损坏字段不得被 entries 等价遮蔽）【预期红】', async () => {
    const stack = makeStack('true')
    const bid = await walkDeclared(ONE.F, stack)
    const r0 = await fin(stack, bid, 0, ONE.D.blocks[0].toString('base64'), ONE.D.proofs[0])
    assert.ok(r0.ok, `前置 块0 ok（${JSON.stringify(r0).slice(0, 100)}）`)
    // 种子损坏：sha256 全零（≠位置绑定叶），entries/其余原样；游标已过（prepCursor=1）
    const blk = stack.cloud.__docs.get(`mc_restore_blocks/${bid}:blk:0`)
    blk.sha256 = '0'.repeat(64)
    const bd = batchDoc(stack, bid)
    const before = writeSnapshot(stack)
    const r = await fin(stack, bid, 0, ONE.D.blocks[0].toString('base64'), ONE.D.proofs[0])
    assert.ok(!r.ok, `伪重放禁止：持久 sha256 已损坏（≠位置绑定叶）——重放须 fail-closed 拒（实得 ok=${r.ok} ${r.ok ? JSON.stringify(r.data).slice(0, 60) : ''}）`)
    assert.ok(CORRUPT_REJECT.test(String(r.code || '') + String(r.message || '')), `拒因=损坏/不一致族（实得 ${r.code}: ${String(r.message).slice(0, 80)}）`)
    assertZeroWrites(before, stack, 'C2a')
    assert.strictEqual(blk.sha256, '0'.repeat(64), '不得静默修复（损坏文档原样）')
  })
  await scenario('C2b proof 损坏+游标当前：写路径不得修复成功（同字节半写态分支须校验损坏字段后 fail-closed）【预期红】', async () => {
    const stack = makeStack('true')
    const bid = await walkDeclared(ONE.F, stack)
    // 种子：entries 正确＋proof 损坏（'AAAA'）＋sha256/byteLength 正确；游标当前（prepCursor=0，preparing）
    await seedBlockDoc(stack, bid, 0, ONE.D, { proof: 'AAAA' })
    const before = writeSnapshot(stack)
    const r = await fin(stack, bid, 0, ONE.D.blocks[0].toString('base64'), ONE.D.proofs[0])
    assert.ok(!r.ok, `修复成功禁止：持久块 proof 已损坏——写路径须 fail-closed 拒（实得 ${JSON.stringify(r).slice(0, 120)}）`)
    assert.ok(CORRUPT_REJECT.test(String(r.code || '') + String(r.message || '')), `拒因=损坏/不一致族（实得 ${r.code}: ${String(r.message).slice(0, 80)}）`)
    assertZeroWrites(before, stack, 'C2b')
    assert.strictEqual(batchDoc(stack, bid).prepCursor, 0, '游标不得推进')
  })
  await scenario('C2c byteLength 损坏+游标已过：重放不得伪成功（字段一致性校验缺）【预期红】', async () => {
    const stack = makeStack('true')
    const bid = await walkDeclared(ONE.F, stack)
    const r0 = await fin(stack, bid, 0, ONE.D.blocks[0].toString('base64'), ONE.D.proofs[0])
    assert.ok(r0.ok, '前置 块0 ok')
    const blk = stack.cloud.__docs.get(`mc_restore_blocks/${bid}:blk:0`)
    blk.byteLength = 99999 // 谎报（≠实际块字节）
    const before = writeSnapshot(stack)
    const r = await fin(stack, bid, 0, ONE.D.blocks[0].toString('base64'), ONE.D.proofs[0])
    assert.ok(!r.ok, `伪重放禁止：持久 byteLength 已损坏——重放须 fail-closed 拒（实得 ${JSON.stringify(r).slice(0, 100)}）`)
    assert.ok(CORRUPT_REJECT.test(String(r.code || '') + String(r.message || '')), '拒因=损坏/不一致族')
    assertZeroWrites(before, stack, 'C2c')
  })

  // ══ C3 损坏种子末片清单 chunk ══
  await scenario('C3a rawB64 篡改（chunkSha256 字段匹配）：重试末片→不冻结（存储冲突/损坏族或 digest 族拒——修复可在 digest 验证前拒）＋零写', async () => {
    const stack = makeStack('true')
    const CHUNK = 40 * 1024
    const bid = await walkDeclared(BIG.F, stack, 1) // 只发 chunk0
    const cut1 = BIG.F.manifestBytes.subarray(CHUNK)
    // 种子损坏 chunk 文档：chunkSha256 字段=真末片 sha（匹配重试请求）——rawB64=篡改字节
    const tampered = Buffer.from(cut1); tampered[0] ^= 0x01
    stack.cloud.__docs.set(`mc_restore_declare_chunks/${bid}:1`, { batchId: bid, chunkIndex: 1, chunkSha256: sha256(cut1), rawB64: tampered.toString('base64'), byteLength: tampered.length, __v: 1 })
    const before = writeSnapshot(stack)
    const r = await stack.call({ action: 'restore.declareChunk', batchId: bid, chunkIndex: 1, chunkTotal: 2, chunkB64: Buffer.from(cut1).toString('base64'), chunkSha256: sha256(cut1) })
    assert.ok(!r.ok, '篡改存储 chunk 须拒（digest 族或存储冲突/损坏族——修复可在 digest 验证前拒不一致存储末片）')
    assert.ok(/conflict|冲突|corrupt|损坏|篡改|不符|mismatch|不一致|digest|摘要|manifest|package|invalid/i.test(String(r.code || '') + String(r.message || '')), `拒因=存储冲突/损坏族或重组/digest 族（实得 ${r.code}: ${String(r.message).slice(0, 80)}）`)
    const bd = batchDoc(stack, bid)
    assert.ok(!bd || (bd.status !== 'preparing' && bd.status !== 'declared'), `不得冻结（实得 ${bd && bd.status}）`)
    assertZeroWrites(before, stack, 'C3a')
  })
  await scenario('C3b byteLength 谎报（rawB64 正确）：重试末片→须检测不一致不冻结【预期红】', async () => {
    const stack = makeStack('true')
    const CHUNK = 40 * 1024
    const bid = await walkDeclared(BIG.F, stack, 1)
    const cut1 = BIG.F.manifestBytes.subarray(CHUNK)
    // 种子：rawB64 正确＋chunkSha256 正确——byteLength 字段谎报（≠实际解码长）
    stack.cloud.__docs.set(`mc_restore_declare_chunks/${bid}:1`, { batchId: bid, chunkIndex: 1, chunkSha256: sha256(cut1), rawB64: Buffer.from(cut1).toString('base64'), byteLength: 12345, __v: 1 })
    const before = writeSnapshot(stack)
    const r = await stack.call({ action: 'restore.declareChunk', batchId: bid, chunkIndex: 1, chunkTotal: 2, chunkB64: Buffer.from(cut1).toString('base64'), chunkSha256: sha256(cut1) })
    assert.ok(!r.ok, `持久 chunk 字段不一致（byteLength 谎报）须 fail-closed 拒（实得 ${JSON.stringify(r).slice(0, 110)}）`)
    const bd = batchDoc(stack, bid)
    assert.ok(!bd || bd.status !== 'preparing', `不得冻结（实得 ${bd && bd.status}）`)
    assertZeroWrites(before, stack, 'C3b')
  })

  // ══ M1 缺 v20 模块+flag true：fail-closed ══
  await scenario('M1 缺 v20 模块＋flag=true：全分派 fail-closed（internal-error 族——不静默走 legacy）＋零写', async () => {
    const stack = makeStack('true', DIST_NOV20)
    const bid = nonce()
    const r = await stack.call({ action: 'restore.begin', batchId: bid, formatVersion: 1, packageDigest: sha256(Buffer.alloc(1)), manifestDigest: sha256(Buffer.alloc(2)), claimedKind: 'full', totals: { files: 1, records: 1, domainCounts: { reports: 1 } } })
    assert.ok(!r.ok, '模块缺失+启用旗标=部署错误——须拒')
    assert.ok(/v20|模块|module|internal/i.test(String(r.code || '') + String(r.message || '')), `拒因=v20 模块 fail-closed 族（实得 ${r.code}: ${String(r.message).slice(0, 80)}）`)
    assert.ok(!stack.cloud.__docs.get(`mc_restore_batches/${bid}`), '零写（批次不得创建）')
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
  if (failed.length) { console.log('失败项（预期红五项：C2a/C2b/C2c/C3a/C3b——损坏态 fail-closed 缺口）:\n - ' + failed.join('\n - ')); process.exit(1) }
  console.log('（对抗回归——不构成切片完成/B3b 验收）')
}
main().catch(e => { console.error('FATAL', e); process.exit(2) })
