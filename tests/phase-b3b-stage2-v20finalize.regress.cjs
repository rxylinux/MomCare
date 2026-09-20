// B3b 阶段二：V20 服务端 preparing/finalizeDeclare 切片——红先行回归 rev1
// 依据：docs/PHASE_B3B_STAGE2_CODE_REVIEW_2026-09-20.md 末节"下一实现切片边界"+D29 wire 形
// （finalizeDeclare 线上恒 blockB64=严格规范标准 base64——旧 blockBytes 字段拒）+ 协调方指派 2026-09-20：
//   ①默认 MC_RESTORE_V20_ENABLED=false：旧 restore.* 行为与 82/3 基线不变；finalizeDeclare 不可用（拒）。
//   ②测试环境显式启用（'true'）才走真 mc-restore.main 新分支：declareChunk **末片** 事务内冻结
//     preparing——planRoot/totalBlocks/totalEntries/prepCursor=0，须与**独立派生**一致（本测试自
//     wire manifest 经冻结 v20 模块 deriveV20Stream+packBlocks+buildTree 派生——不以 handler 输出为期望值）。
//   ③finalizeDeclare（D29 JSON blockB64+proof）：块文档+游标原子性；末块同事务转 indexing；
//     同字节重放零写；异字节冲突；超前块拒；畸形 base64 拒；非规范 JSON 拒——后四者均零写。
// 红清单（历史红先行——切片落地后 E1-E10 已转绿；E11=永久 legacy 旁路防门（现绿——块消费实现后仍须保持）；
// L1-①（legacy 不变）与 L1-②（默认关拒）
// 预期绿（基线钉）。不编辑既有 Stage2 套件；不声称完成/B3b 验收。
// E11 V20 批次 legacy 旁路防门（审查修订 2026-09-20——永久门，非"未实现期"临时门）：V20 批次
// finalize 末块后为 indexing——**无 blockIndex 的 legacy pageCursor 调用**读旧 manifest 可不经已验证
// V20 块消费直推 declared。门=真公共 action 调用（无 blockIndex 形）：须**明确拒**（拒因明示
// V20/legacy 旁路族——不再依赖"未实现"措辞）＋**零写**（批次 __v 不变/零 declarations/状态停留
// indexing）；带 blockIndex 的 V20 块消费新路径由 v20consume 套件（c2961827 系）覆盖；默认关 legacy
// indexing（L1-①）不动。块消费实现后本门仍须保持——legacy 旁路永久禁止。
// E10 崩溃重试（协调方指认+审查重设计 2026-09-20）：**旧 E10（chunkTotal=1）作废不计证**——其注入
// 命中 chunk0 的 needAnchor 首事务（该事务也写 mc_restore_batches）→ 末片未持久→红仅复刻 E1。本版：
// 大清单夹具（manifest >40KiB→恰 2 chunks）；chunk0（含锚定）先无注入提交；注入仅命中末片(chunk1)
// 的状态冻结事务（该事务写 batches——chunk 写事务不写）；断言崩溃窗口（**末片 chunk 已持久+状态仍
// declaring**）→同末片重试须达 preparing（现行 replayed 早退卡 declaring——红签名=declaring≠E1 的
// indexing）＋无孤儿/重复。
// **末片原子性（协调方验收澄清 2026-09-20：两设计皆受）**：①单事务原子形——注入失败回滚→**无**
// 末片 chunk 留存；②两段+安全重试形——chunk 留存。共同硬不变量：注入后状态仍 declaring＋重试须达
// preparing（根=独立派定）。修复前诊断须显示旧两事务代码"chunk 留存+仍 declaring"；未来原子实现
// "无 chunk 留存"亦合法——**不以"失败后 chunk 持久"为未来实现的强制要求**（诊断分支打印观测形）。
// 冻结源（index/v20/shared×4）加载时快照+结束复核——漂移=本轮作废；测试自哈希随报告发布。
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-b3b2-v20fin-'))
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
  fs.cpSync(path.join(root, 'cloud/shared'), path.join(dir, 'shared'), { recursive: true })
  // 审查修正 2026-09-20：同步拷贝冻结 v20.js——handler 接线本地 require('./v20') 后缺副本会
  // MODULE_NOT_FOUND（测的是夹具缺失而非生产行为）；v20.js 已列 FROZEN_RELS（拷贝即冻结快照）。
  fs.copyFileSync(path.join(root, 'cloud/functions/mc-restore/v20.js'), path.join(dir, 'v20.js'))
}

// ── 冻结源哈希（加载时快照→结束复核；漂移=本轮作废）──
const FROZEN_RELS = ['cloud/functions/mc-restore/index.js', 'cloud/functions/mc-restore/v20.js', 'cloud/shared/auth.js', 'cloud/shared/config.js', 'cloud/shared/respond.js', 'cloud/shared/constants.js']
const frozenHashes = Object.fromEntries(FROZEN_RELS.map(rel => [rel, sha256(fs.readFileSync(path.join(root, rel)))]))
console.log('冻结源哈希（加载时快照）:')
for (const [rel, h] of Object.entries(frozenHashes)) console.log(`  ${h.slice(0, 8)}  ${rel}`)

// Stage1 容器（独立 bundle）+ 冻结 v20 模块（独立派生期望值——不经 handler）
const stage1Path = path.join(temp, 'stage1.cjs')
esbuild.buildSync({ stdin: { contents: `export * from "@/utils/mcpkg/canonical.js";export * from "@/utils/mcpkg/container.js";`, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: stage1Path, logLevel: 'silent' })
const stage1 = require(stage1Path)
const v20Path = path.join(temp, 'v20.cjs')
esbuild.buildSync({ entryPoints: [path.join(root, 'cloud/functions/mc-restore/v20.js')], bundle: true, platform: 'node', format: 'cjs', outfile: v20Path, logLevel: 'silent' })
const v20 = require(v20Path)

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-b3b2v20f', MC_MEMBER_MAMA_OPENID: 'oTESTMAMA123456', MC_MEMBER_PAPA_OPENID: 'oTESTPAPA456789' }

// ── Mock 云（版本 CAS 事务——__v 供零写断言）──
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
// 定向 commit 失败注入：state.failCommitOnce={key}——commit 且其 writes 含 key 时抛冲突；
// 手动置 null 前持续命中（压过 handler 内部 CAS 重试环）。在 makeMockCloud 的 commit 内检查：
// （见上方 commit 实现首行）
const storage = new Map()
global.uni = { getStorageSync(k) { return storage.has(k) ? storage.get(k) : '' }, setStorageSync(k, v) { storage.set(k, v) }, removeStorageSync(k) { storage.delete(k) }, showToast() {}, showLoading() {}, hideLoading() {} }

function requireRestore() { delete require.cache[require.resolve(path.join(DIST, 'mc-restore/index.js'))]; return require(path.join(DIST, 'mc-restore/index.js')) }
// enableV20=false → 显式删除开关（默认关）；true → 显式 'true'（测试环境启用新协议）
function makeStack(enableV20 = false) {
  for (const k of [...storage.keys()]) if (k.startsWith('mc_') || k.startsWith('YUNTU_')) storage.delete(k)
  const cloud = makeMockCloud()
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID; process.env.MC_UPLOAD_ENABLED = 'true'
  if (enableV20) process.env.MC_RESTORE_V20_ENABLED = 'true'
  else delete process.env.MC_RESTORE_V20_ENABLED
  cloud.__state.caller = TEST_ENV.MC_MEMBER_MAMA_OPENID
  const hRestore = requireRestore()
  hRestore.__setCloud(cloud)
  return { cloud, call: (event) => hRestore.main(event), enableV20 }
}
// 全库写快照（__v 版本——零写断言）
const writeSnapshot = (stack) => new Map([...stack.cloud.__docs.entries()].map(([k, e]) => [k, e.__v]))
const assertZeroWrites = (before, stack, label) => {
  const after = writeSnapshot(stack)
  assert.strictEqual(after.size, before.size, `${label} 不得新增文档（实得新增 ${[...after.keys()].filter(k => !before.has(k)).join(',')}）`)
  for (const [k, v] of after) assert.strictEqual(v, before.get(k), `${label} 零写失败：${k} __v ${before.get(k)}→${v}`)
}

// ── 夹具：真全包 + 独立 V20 派生 ──
const DOMAIN_ORDER = ['pregnancy', 'daily', 'mood', 'checkup', 'bag', 'reports']
function buildPkg(records) { // records: [{id, revision:0, deleted:false, attachments:[]}]（零附件——无附件文件）
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
  return { pkg, manifest, manifestBytes, manifestDigest: sha256(manifestBytes), packageDigest: sha256(pkg), totals: { files: 1, records: records.length, domainCounts: { reports: records.length } } }
}
async function stage1Validate(pkg) {
  return stage1.validatePackage({ size: async () => pkg.length, readChunk: async (p, l) => new Uint8Array(pkg.subarray(p, p + l)) })
}
// 独立派生：wire manifest → v20 模块 → blocks/root/proofs（期望值——不经 handler）
function deriveIndependent(pkg, manifestBytes) {
  const off = pkg.indexOf(manifestBytes)
  assert.ok(off === 24, 'wire manifest 定位头 24B')
  const wire = JSON.parse(pkg.subarray(off, off + manifestBytes.length).toString('utf8'))
  const stream = v20.deriveV20Stream(wire)
  const blocks = v20.packBlocks(stream)
  const tree = v20.buildTree(blocks)
  return { wire, stream, blocks, totalBlocks: blocks.length, totalEntries: stream.count, planRoot: tree.root.toString('hex'), proofs: tree.proofs, leafHex: (i) => v20.leafHash(blocks.length, i, blocks[i]).toString('hex') }
}
// 走到末片 declareChunk 完成（begin+chunks——不断言状态：供各场景自行断言）
async function walkDeclared(F, stack) {
  const batchId = nonce()
  const b = await stack.call({ action: 'restore.begin', batchId, formatVersion: 1, packageDigest: F.packageDigest, manifestDigest: F.manifestDigest, claimedKind: 'full', totals: F.totals })
  assert.ok(b.ok, `begin: ${JSON.stringify(b).slice(0, 150)}`)
  const CHUNK = 40 * 1024, total = Math.ceil(F.manifestBytes.length / CHUNK)
  let last = null
  for (let i = 0; i < total; i++) {
    const raw = F.manifestBytes.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, F.manifestBytes.length))
    last = await stack.call({ action: 'restore.declareChunk', batchId, chunkIndex: i, chunkTotal: total, chunkB64: Buffer.from(raw).toString('base64'), chunkSha256: sha256(raw) })
    assert.ok(last.ok, `declareChunk ${i}/${total}: ${JSON.stringify(last).slice(0, 150)}`)
  }
  return { batchId, last }
}
const batchDoc = (stack, bid) => stack.cloud.__docs.get(`mc_restore_batches/${bid}`)
const blockDoc = (stack, bid, i) => stack.cloud.__docs.get(`mc_restore_blocks/${bid}:blk:${i}`)

async function main() {
  console.log(`\nB3b V20 服务端 preparing/finalizeDeclare 切片红先行回归 rev1
（默认关 legacy 钉 + 显式启用了 preparing 冻结/finalizeDeclare 全合同——独立派定期望值）\n`)

  // ── P0 夹具与独立派定 ──
  const ONE = { recs: [{ id: 'rp-v20f-one', revision: 0, deleted: false, attachments: [] }] }
  const MULTI = { recs: Array.from({ length: 120 }, (_, i) => ({ id: 'rp-v20f-mb-' + String(i).padStart(3, '0'), revision: 0, deleted: false, attachments: [] })) }
  const BIG = { recs: Array.from({ length: 220 }, (_, i) => ({ id: 'rp-v20f-big-' + String(i).padStart(3, '0') + '-' + 'x'.repeat(20), revision: 0, deleted: false, attachments: [] })) }
  await scenario('P0-① 单块夹具：Stage1 validatePackage ok＋独立派定 totalBlocks=1/totalEntries=1/根/块字节/proof 空串', async () => {
    ONE.F = buildPkg(ONE.recs)
    const v = await stage1Validate(ONE.F.pkg)
    assert.ok(v.ok, `Stage1 须 ok（实得 ${JSON.stringify((v.problems || []).slice(0, 1)).slice(0, 120)}）`)
    ONE.D = deriveIndependent(ONE.F.pkg, ONE.F.manifestBytes)
    assert.strictEqual(ONE.D.totalBlocks, 1, '单记录零附件 → 恰 1 块')
    assert.strictEqual(ONE.D.totalEntries, 1, '恰 1 条目')
    assert.ok(/^[0-9a-f]{64}$/.test(ONE.D.planRoot), 'planRoot=64hex')
    assert.ok(ONE.D.blocks[0].length > 0 && ONE.D.blocks[0].length <= v20.BLOCK_NET, `块字节 ≤BLOCK_NET（${ONE.D.blocks[0].length}B）`)
    assert.strictEqual(ONE.D.proofs[0], '', 'T=1 单块 proof=空串（D20/D29）')
    console.log(`      块0=${ONE.D.blocks[0].length}B｜root=${ONE.D.planRoot.slice(0, 16)}…`)
  })
  await scenario('P0-② 多块夹具（120 记录）：Stage1 ok＋独立派定 totalBlocks=3/totalEntries=120＋逐块 proof/叶', async () => {
    MULTI.F = buildPkg(MULTI.recs)
    const v = await stage1Validate(MULTI.F.pkg)
    assert.ok(v.ok, `Stage1 须 ok（实得 ${JSON.stringify((v.problems || []).slice(0, 1)).slice(0, 120)}）`)
    MULTI.D = deriveIndependent(MULTI.F.pkg, MULTI.F.manifestBytes)
    assert.strictEqual(MULTI.D.totalEntries, 120, '120 条目')
    assert.ok(MULTI.D.totalBlocks >= 2, `须 ≥2 块（实得 ${MULTI.D.totalBlocks}——48 条/块上限分页）`)
    MULTI.D.blocks.forEach((b, i) => assert.ok(b.length <= v20.BLOCK_NET, `块${i} ≤BLOCK_NET`))
    console.log(`      块=${MULTI.D.totalBlocks}（${MULTI.D.blocks.map(b => b.length).join('/')}B）｜条目=${MULTI.D.totalEntries}｜root=${MULTI.D.planRoot.slice(0, 16)}…`)
  })

  await scenario('P0-③ 大清单夹具（220 记录——E10 崩溃重试用）：Stage1 ok＋manifest >40KiB→恰 2 chunks＋独立派定', async () => {
    BIG.F = buildPkg(BIG.recs)
    const v = await stage1Validate(BIG.F.pkg)
    assert.ok(v.ok, `Stage1 须 ok（实得 ${JSON.stringify((v.problems || []).slice(0, 1)).slice(0, 120)}）`)
    BIG.D = deriveIndependent(BIG.F.pkg, BIG.F.manifestBytes)
    const CHUNK = 40 * 1024, total = Math.ceil(BIG.F.manifestBytes.length / CHUNK)
    assert.ok(BIG.F.manifestBytes.length > CHUNK, `manifest 须 >40KiB（实得 ${BIG.F.manifestBytes.length}B——chunk0 锚定事务与末片冻结事务分离的前提）`)
    assert.strictEqual(total, 2, `须恰 2 chunks（实得 ${total}——chunk0/末片(chunk1) 两呼设计）`)
    console.log(`      manifest=${BIG.F.manifestBytes.length}B→${total} chunks｜块=${BIG.D.totalBlocks}｜条目=${BIG.D.totalEntries}｜root=${BIG.D.planRoot.slice(0, 16)}…`)
  })

  // ── L1 默认关（legacy 基线钉——预期绿）──
  await scenario('L1-① 默认 MC_RESTORE_V20_ENABLED 关：旧路径不变——末片 declareChunk → indexing（非 preparing）→indexDeclarePage→declared', async () => {
    const stack = makeStack(false)
    const { batchId } = await walkDeclared(ONE.F, stack)
    const bd = batchDoc(stack, batchId)
    assert.ok(bd, '批次文档在场')
    assert.strictEqual(bd.status, 'indexing', `legacy 末片须直转 indexing（实得 ${bd.status}）——开关默认关不得引入 preparing`)
    assert.ok(!('planRoot' in bd) && !('prepCursor' in bd), 'legacy 批次不得携带 V20 冻结字段')
    for (let i = 0; i < 30; i++) {
      const r = await stack.call({ action: 'restore.indexDeclarePage', batchId })
      assert.ok(r.ok, `indexDeclarePage: ${JSON.stringify(r).slice(0, 150)}`)
      if (r.data && (r.data.status === 'declared' || r.data.hasMore === false)) break
    }
    assert.strictEqual(batchDoc(stack, batchId).status, 'declared', 'legacy 全程到 declared（82/3 基线不变钉）')
  })
  await scenario('L1-② 默认关：restore.finalizeDeclare 不可用（拒——无新公共面）', async () => {
    const stack = makeStack(false)
    const { batchId } = await walkDeclared(ONE.F, stack)
    const r = await stack.call({ action: 'restore.finalizeDeclare', batchId, blockIndex: 0, blockB64: ONE.D.blocks[0].toString('base64'), proof: '' })
    assert.ok(!r.ok, `默认关 finalizeDeclare 须拒（实得 ok=${r.ok}）——新动作仅显式启用后可用`)
    console.log(`      拒：${r.code || ''} ${String(r.message || '').slice(0, 60)}`)
  })

  // ── E1 启用：末片冻结 preparing【预期红】──
  await scenario('E1 显式启用：declareChunk 末片事务内冻结 preparing——planRoot/totalBlocks/totalEntries 与独立派定全等＋prepCursor=0【红】', async () => {
    const stack = makeStack(true)
    const { batchId } = await walkDeclared(ONE.F, stack)
    const bd = batchDoc(stack, batchId)
    assert.ok(bd, '批次文档在场')
    assert.strictEqual(bd.status, 'preparing', `末片须冻结 preparing（实得 ${bd.status}）——启用后 declaring→preparing（不再直转 indexing）`)
    assert.strictEqual(bd.planRoot, ONE.D.planRoot, `planRoot 须=独立派定根（实得 ${bd.planRoot}≠${ONE.D.planRoot}）`)
    assert.strictEqual(bd.totalBlocks, ONE.D.totalBlocks, `totalBlocks 须=${ONE.D.totalBlocks}`)
    assert.strictEqual(bd.totalEntries, ONE.D.totalEntries, `totalEntries 须=${ONE.D.totalEntries}`)
    assert.strictEqual(bd.prepCursor, 0, 'prepCursor 须冻结为 0')
  })

  // ── E2 启用：单块 finalizeDeclare——块文档+游标原子＋末块同事务转 indexing【预期红】──
  await scenario('E2 单块 finalizeDeclare（D29 blockB64+proof 空串）：ok——块文档（entries/sha256=独立位置绑定叶/proof）＋同事务转 indexing＋prepCursor=1【红】', async () => {
    const stack = makeStack(true)
    const { batchId } = await walkDeclared(ONE.F, stack)
    const r = await stack.call({ action: 'restore.finalizeDeclare', batchId, blockIndex: 0, blockB64: ONE.D.blocks[0].toString('base64'), proof: ONE.D.proofs[0] })
    assert.ok(r.ok, `finalizeDeclare 须 ok（实得 ${JSON.stringify(r).slice(0, 160)}）`)
    const blk = blockDoc(stack, batchId, 0)
    assert.ok(blk, '块文档 mc_restore_blocks/<bid>:blk:0 须持久')
    assert.deepStrictEqual(blk.entries, JSON.parse(ONE.D.blocks[0].toString('utf8')), 'entries 须=块 canonical 解析形（D21 native 数组）')
    assert.strictEqual(blk.byteLength, ONE.D.blocks[0].length, 'byteLength=块字节长')
    assert.strictEqual(blk.entryCount, 1, 'entryCount=1')
    assert.strictEqual(blk.sha256, ONE.D.leafHex(0), `sha256 须=独立位置绑定叶（实得 ${blk.sha256}）`)
    assert.strictEqual(blk.proof, ONE.D.proofs[0], 'proof 持久=提交值')
    const bd = batchDoc(stack, batchId)
    assert.strictEqual(bd.status, 'indexing', `末块同事务须转 indexing（实得 ${bd.status}）`)
    assert.strictEqual(bd.prepCursor, 1, 'prepCursor=1（与块文档同事务——原子）')
  })

  // ── E3 同字节重放零写【预期红】──
  await scenario('E3 同字节重放（丢响应重试形）：ok/幂等＋零写（块文档与批次 __v 均不变）【红】', async () => {
    const stack = makeStack(true)
    const { batchId } = await walkDeclared(ONE.F, stack)
    const r1 = await stack.call({ action: 'restore.finalizeDeclare', batchId, blockIndex: 0, blockB64: ONE.D.blocks[0].toString('base64'), proof: ONE.D.proofs[0] })
    assert.ok(r1.ok, `首次 finalize 须 ok（实得 ${JSON.stringify(r1).slice(0, 120)}）`)
    const before = writeSnapshot(stack)
    const r2 = await stack.call({ action: 'restore.finalizeDeclare', batchId, blockIndex: 0, blockB64: ONE.D.blocks[0].toString('base64'), proof: ONE.D.proofs[0] })
    assert.ok(r2.ok, `同字节重放须 ok（丢响应重试不得失败——实得 ${JSON.stringify(r2).slice(0, 120)}）`)
    assertZeroWrites(before, stack, 'E3 重放')
  })

  // ── E4 异字节冲突【预期红】──
  await scenario('E4 异字节冲突：合法 canonical 但内容不同的块 → 拒（冲突族）＋零写；随后正确字节仍可过（零残留）【红】', async () => {
    const stack = makeStack(true)
    const { batchId } = await walkDeclared(ONE.F, stack)
    const entries = JSON.parse(ONE.D.blocks[0].toString('utf8'))
    entries[0].revision = 7 // 合法 canonical 形、内容不同（叶/证明必不匹配冻结根）
    const changed = Buffer.from(v20.canonicalJsonBytes(entries))
    const before = writeSnapshot(stack)
    const r = await stack.call({ action: 'restore.finalizeDeclare', batchId, blockIndex: 0, blockB64: changed.toString('base64'), proof: ONE.D.proofs[0] })
    assert.ok(!r.ok, '异字节须拒')
    assert.ok(/conflict|冲突|mismatch|不匹配|root|根|sha|叶/i.test(String(r.code || '') + String(r.message || '')), `拒因须为冲突/根不匹配族（实得 ${r.code}: ${String(r.message).slice(0, 80)}）`)
    assertZeroWrites(before, stack, 'E4 异字节')
    const rOk = await stack.call({ action: 'restore.finalizeDeclare', batchId, blockIndex: 0, blockB64: ONE.D.blocks[0].toString('base64'), proof: ONE.D.proofs[0] })
    assert.ok(rOk.ok, `拒后零残留——正确字节仍须可过（实得 ${JSON.stringify(rOk).slice(0, 120)}）`)
  })

  // ── E5 多块启用冻结【预期红】──
  await scenario('E5 多块（120 记录）启用：末片冻结 preparing——totalBlocks/totalEntries/planRoot 与独立派定全等＋prepCursor=0【红】', async () => {
    const stack = makeStack(true)
    const { batchId } = await walkDeclared(MULTI.F, stack)
    const bd = batchDoc(stack, batchId)
    assert.strictEqual(bd.status, 'preparing', `实得 ${bd.status}`)
    assert.strictEqual(bd.totalBlocks, MULTI.D.totalBlocks, `totalBlocks 须=${MULTI.D.totalBlocks}`)
    assert.strictEqual(bd.totalEntries, MULTI.D.totalEntries, `totalEntries 须=${MULTI.D.totalEntries}`)
    assert.strictEqual(bd.planRoot, MULTI.D.planRoot, 'planRoot 须=独立派定根')
    assert.strictEqual(bd.prepCursor, 0, 'prepCursor=0')
  })

  // ── E6 多块逐块 finalize：游标递增保持 preparing＋末块转 indexing＋逐块独立叶【预期红】──
  await scenario('E6 多块逐块 finalize（0→1→2）：块0/1 后保持 preparing+prepCursor 1/2＋末块同事务转 indexing+三块文档 sha256=独立叶【红】', async () => {
    const stack = makeStack(true)
    const { batchId } = await walkDeclared(MULTI.F, stack)
    for (let i = 0; i < MULTI.D.totalBlocks; i++) {
      const r = await stack.call({ action: 'restore.finalizeDeclare', batchId, blockIndex: i, blockB64: MULTI.D.blocks[i].toString('base64'), proof: MULTI.D.proofs[i] })
      assert.ok(r.ok, `finalize 块${i} 须 ok（实得 ${JSON.stringify(r).slice(0, 140)}）`)
      const blk = blockDoc(stack, batchId, i)
      assert.ok(blk, `块${i} 文档须持久`)
      assert.strictEqual(blk.sha256, MULTI.D.leafHex(i), `块${i} sha256=独立位置绑定叶`)
      assert.strictEqual(blk.proof, MULTI.D.proofs[i], `块${i} proof 持久`)
      assert.deepStrictEqual(blk.entries, JSON.parse(MULTI.D.blocks[i].toString('utf8')), `块${i} entries=canonical 解析形`)
      const bd = batchDoc(stack, batchId)
      assert.strictEqual(bd.prepCursor, i + 1, `游标=${i + 1}（与块文档原子）`)
      if (i < MULTI.D.totalBlocks - 1) assert.strictEqual(bd.status, 'preparing', `非末块须保持 preparing（块${i} 后实得 ${bd.status}）`)
      else assert.strictEqual(bd.status, 'indexing', `末块同事务须转 indexing（实得 ${bd.status}）`)
    }
  })

  // ── E7 超前块【预期红】──
  await scenario('E7 超前块：preparing/prepCursor=0 直发 blockIndex=2（跳过 0/1）→ 拒＋零写【红】', async () => {
    const stack = makeStack(true)
    const { batchId } = await walkDeclared(MULTI.F, stack)
    const before = writeSnapshot(stack)
    const r = await stack.call({ action: 'restore.finalizeDeclare', batchId, blockIndex: 2, blockB64: MULTI.D.blocks[2].toString('base64'), proof: MULTI.D.proofs[2] })
    assert.ok(!r.ok, '超前块须拒（游标外块不得先写）')
    assert.ok(!/未知 action|unknown/i.test(String(r.code || '') + String(r.message || '')), '当前拒因=未知 action 门——目标游标门未实现（红先行归因：动作存在后此腿才有效）')
    assert.ok(/cursor|游标|ahead|超前|顺序|stale/i.test(String(r.code || '') + String(r.message || '')), `拒因须为游标/顺序族（实得 ${r.code}: ${String(r.message).slice(0, 80)}）`)
    assertZeroWrites(before, stack, 'E7 超前')
  })

  // ── E8 畸形 base64【预期红】──
  await scenario('E8 畸形 base64（@@@invalid@@@ 三元组——重编码不等）：拒＋零写【红】', async () => {
    const stack = makeStack(true)
    const { batchId } = await walkDeclared(ONE.F, stack)
    const before = writeSnapshot(stack)
    const r = await stack.call({ action: 'restore.finalizeDeclare', batchId, blockIndex: 0, blockB64: '@@@invalid@@@', proof: ONE.D.proofs[0] })
    assert.ok(!r.ok, '非规范 base64 须拒（重编码全等门）')
    assert.ok(!/未知 action|unknown/i.test(String(r.code || '') + String(r.message || '')), '当前拒因=未知 action 门——目标 base64 规范门未实现（红先行归因）')
    assertZeroWrites(before, stack, 'E8 畸形 b64')
    console.log(`      拒：${r.code || ''} ${String(r.message || '').slice(0, 60)}`)
  })

  // ── E9 非规范 JSON（键序翻转——合法 JSON 非 canonical 字节）【预期红】──
  await scenario('E9 非规范 JSON：块 JSON 键序翻转（合法 JSON、canonical 重序列化不等）→ 拒＋零写【红】', async () => {
    const stack = makeStack(true)
    const { batchId } = await walkDeclared(ONE.F, stack)
    const entries = JSON.parse(ONE.D.blocks[0].toString('utf8'))
    entries[0] = Object.fromEntries(Object.keys(entries[0]).reverse().map(k => [k, entries[0][k]]))
    const ncBytes = Buffer.from(JSON.stringify(entries)) // 合法 JSON 数组、键序非规范
    assert.ok(!ncBytes.equals(ONE.D.blocks[0]), '夹具自检：非规范形须与 canonical 块字节不同')
    const before = writeSnapshot(stack)
    const r = await stack.call({ action: 'restore.finalizeDeclare', batchId, blockIndex: 0, blockB64: ncBytes.toString('base64'), proof: ONE.D.proofs[0] })
    assert.ok(!r.ok, '非 canonical JSON 须拒（canonicalJsonBytes 逐字节等门）')
    assert.ok(!/未知 action|unknown/i.test(String(r.code || '') + String(r.message || '')), '当前拒因=未知 action 门——目标 canonical 逐字节门未实现（红先行归因）')
    assertZeroWrites(before, stack, 'E9 非规范 JSON')
    console.log(`      拒：${r.code || ''} ${String(r.message || '').slice(0, 60)}`)
  })

  // ── E10 崩溃重试（审查重设计：末片冻结事务 commit 失败注入——chunk0 锚定先无注入提交）【预期红】──
  await scenario('E10 崩溃重试：末片(chunk1/2)冻结事务 commit 失败注入→chunk 留存+仍 declaring→同末片重试须达 preparing（根=独立派定）＋无孤儿/重复【红】', async () => {
    const stack = makeStack(true)
    const batchId = nonce()
    const b = await stack.call({ action: 'restore.begin', batchId, formatVersion: 1, packageDigest: BIG.F.packageDigest, manifestDigest: BIG.F.manifestDigest, claimedKind: 'full', totals: BIG.F.totals })
    assert.ok(b.ok, `begin: ${JSON.stringify(b).slice(0, 120)}`)
    const CHUNK = 40 * 1024, total = 2
    const cut = (i) => BIG.F.manifestBytes.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, BIG.F.manifestBytes.length))
    // chunk0（含 needAnchor 首事务——该事务写 batches）先无注入提交：注入必须避开锚定事务
    const r0 = await stack.call({ action: 'restore.declareChunk', batchId, chunkIndex: 0, chunkTotal: total, chunkB64: Buffer.from(cut(0)).toString('base64'), chunkSha256: sha256(cut(0)) })
    assert.ok(r0.ok, `chunk0（含锚定）须 ok（实得 ${JSON.stringify(r0).slice(0, 120)}）`)
    // 武装注入：仅命中末片状态冻结事务（写 batches 的 commit——chunk1 的 chunk 写事务不写 batches）
    stack.cloud.__state.failCommitOnce = { key: `mc_restore_batches/${batchId}` }
    let r1 = null, threw1 = null
    try { r1 = await stack.call({ action: 'restore.declareChunk', batchId, chunkIndex: 1, chunkTotal: total, chunkB64: Buffer.from(cut(1)).toString('base64'), chunkSha256: sha256(cut(1)) }) } catch (e) { threw1 = e }
    assert.ok(threw1 || !r1.ok, `注入的冻结事务失败须暴露（不得误报成功——实得 threw=${!!threw1} r1=${r1 && JSON.stringify(r1).slice(0, 100)}）`)
    // 崩溃窗口诊断（协调方裁定 2026-09-20：**两设计皆受**）——单事务原子形：失败 commit 回滚→无末片
    // chunk；两段+安全重试形：chunk 留存。共同硬不变量=状态仍 declaring；留存时内容须=所发字节。
    // 修复前诊断须显示出旧两事务代码"chunk 留存+仍 declaring"（下方打印）。
    const chunk1 = stack.cloud.__docs.get(`mc_restore_declare_chunks/${batchId}:1`)
    const mid = batchDoc(stack, batchId)
    assert.strictEqual(mid && mid.status, 'declaring', `注入后状态须仍 declaring（实得 ${mid && mid.status}——冻结未推进（两设计共同不变量））`)
    if (chunk1) {
      assert.strictEqual(chunk1.chunkSha256, sha256(cut(1)), '留存末片内容须=所发字节（两段窗口形孤儿安全）')
      console.log('      诊断：末片 chunk 已持久＋状态仍 declaring（两段窗口形——旧两事务代码观测形）')
    } else {
      console.log('      诊断：末片 chunk 未持久（单事务原子形——失败回滚）')
    }
    // 解除注入 → 客户端崩溃/丢响应后重试同末片（同字节同索引）
    stack.cloud.__state.failCommitOnce = null
    const r2 = await stack.call({ action: 'restore.declareChunk', batchId, chunkIndex: 1, chunkTotal: total, chunkB64: Buffer.from(cut(1)).toString('base64'), chunkSha256: sha256(cut(1)) })
    assert.ok(r2.ok, `同末片重试须 ok（实得 ${JSON.stringify(r2).slice(0, 140)}）`)
    console.log(`      重试响应=${JSON.stringify(r2.data || r2).slice(0, 80)}`)
    const bd = batchDoc(stack, batchId)
    assert.strictEqual(bd.status, 'preparing', `重试须达 preparing（实得 ${bd.status}——现行 replayed 早退不再触 prepare → 卡 declaring）`)
    assert.strictEqual(bd.planRoot, BIG.D.planRoot, 'planRoot=独立派定根')
    assert.strictEqual(bd.totalBlocks, BIG.D.totalBlocks, `totalBlocks=${BIG.D.totalBlocks}`)
    assert.strictEqual(bd.totalEntries, BIG.D.totalEntries, `totalEntries=${BIG.D.totalEntries}`)
    assert.strictEqual(bd.prepCursor, 0, 'prepCursor=0')
    // 无孤儿/重复状态：chunks 恰 2 份；无 blocks 文档；批次恰 1 份
    const chunkKeys = [...stack.cloud.__docs.keys()].filter(k => k.startsWith(`mc_restore_declare_chunks/${batchId}:`))
    assert.strictEqual(chunkKeys.length, 2, `chunks 文档恰 2 份（实得 ${chunkKeys.length}——不得重复）`)
    const blockKeys = [...stack.cloud.__docs.keys()].filter(k => k.startsWith(`mc_restore_blocks/${batchId}`))
    assert.strictEqual(blockKeys.length, 0, '不得有孤儿 blocks 文档（finalize 未发）')
    assert.strictEqual([...stack.cloud.__docs.keys()].filter(k => k === `mc_restore_batches/${batchId}`).length, 1, '批次文档恰 1 份')
  })

  // ── E11 V20 批次 legacy 旁路防门（永久——无 blockIndex 调用拒）──
  await scenario('E11 V20 批次（finalize 后 indexing）调 legacy indexDeclarePage（无 blockIndex）：须拒＋零写——防 legacy 旁路（块消费须经 blockIndex 新路径——v20consume 套件覆盖）', async () => {
    const stack = makeStack(true)
    const { batchId } = await walkDeclared(ONE.F, stack)
    const f0 = await stack.call({ action: 'restore.finalizeDeclare', batchId, blockIndex: 0, blockB64: ONE.D.blocks[0].toString('base64'), proof: ONE.D.proofs[0] })
    assert.ok(f0.ok, `finalize 块0 须 ok（前置——实得 ${JSON.stringify(f0).slice(0, 130)}）`)
    assert.strictEqual(batchDoc(stack, batchId).status, 'indexing', '前置：末块后 indexing')
    // 门：无 blockIndex 的 legacy 调用不得从旧 manifest 推进到 declared（永久——块消费实现后仍须拒）
    const before = writeSnapshot(stack)
    const r = await stack.call({ action: 'restore.indexDeclarePage', batchId })
    assert.ok(!r.ok, `V20 批次 legacy indexDeclarePage（无 blockIndex）须拒（实得 ok=${r.ok}——legacy 路径会绕过已验证块消费直 declared）`)
    assert.ok(/v20|块|block|legacy|旧|blockIndex|消费/i.test(String(r.code || '') + ' ' + String(r.message || '')), `拒因须明示 V20/legacy 旁路族（实得 ${r.code}: ${String(r.message).slice(0, 90)}）`)
    assertZeroWrites(before, stack, 'E11')
    assert.strictEqual(batchDoc(stack, batchId).status, 'indexing', '状态须停留 indexing（不得推进 declared）')
    const declKeys = [...stack.cloud.__docs.keys()].filter(k => k.startsWith(`mc_restore_declarations/${batchId}`))
    assert.strictEqual(declKeys.length, 0, '不得从旧 manifest 写任何声明（零写）')
  })

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
  if (failed.length) {
    console.log('失败项（红先行——预期红清单 E1-E9；L1/P0 预期绿）:\n - ' + failed.join('\n - '))
    process.exit(1)
  }
  console.log('（本回归为红先行契约固化——不构成切片完成/B3b 验收）')
}
main().catch(e => { console.error('FATAL', e); process.exit(2) })
