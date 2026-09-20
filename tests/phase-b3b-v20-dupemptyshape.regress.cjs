// V20 回归：重复映射尾随空对象 attachments 形（真 Stage1 全包）rev1
// 协调方指认 2026-09-20（协调方独立跑 Stage1 validatePackage 得 ok=true 零 problems）：
// 单报告正文 attachments=[]；manifest.reports 同 reportId 两条——首条 attachments=[]、
// 尾条 attachments={}（空对象——非数组），revision/deleted 相同；无附件文件。
// Stage1 容器接受（{} 按 Array.isArray(x)?x:[] 语义归一为零附件——D26 同源）；
// V20 deriveV20Stream 现行拒：D25 去重环比较 raw canonical（[] vs {} 字节不等→非①全等），
// 且 ③ 分支用 rd.attachments||[] 的 {}.length===undefined 不成立 → throw D25②
// "reportId 重复且内容不同"——误拒 Stage1-valid 形（红先行）。
// CODING 修复后契约：接受——恰 1 record 条目、零 refs、零 rmappart、双跑派生稳定
// （entries/blocks/planRoot 逐字节一致）。
// 执行史：红形存在于 0b87e249（协调方独立观测拒 D25②）；本文件首跑于 c4dd6824——
// CODING 已修转绿（E1-③/E1-④ 固化绿契约）。
// 边界声明：本文件 Stage1 侧=container.validatePackage（容器校验层）+ 纯模块
// deriveV20Stream——**不涉及 handler action，不声称 handler 接受**。
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-v20dupsh-'))
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')

const V20_PATH = path.join(root, 'cloud/functions/mc-restore/v20.js')
const SRC_PATH = path.join(root, 'cloud/functions/mc-restore/index.js')
if (!fs.existsSync(V20_PATH)) { console.log('V20 未落地'); process.exit(3) }
const v20Out = path.join(temp, 'v20.cjs')
esbuild.buildSync({ entryPoints: [V20_PATH], bundle: true, platform: 'node', format: 'cjs', outfile: v20Out, logLevel: 'silent' })
const v20 = require(v20Out)
const mk = (rel, out) => esbuild.buildSync({ stdin: { contents: fs.readFileSync(path.join(root, rel), 'utf8').replace(/'\.\//g, "'@/utils/mcpkg/"), resolveDir: root, loader: 'js' }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: path.join(temp, out), logLevel: 'silent' })
mk('utils/mcpkg/canonical.js', 'canon.cjs')
mk('utils/mcpkg/container.js', 'container.cjs')
const { canonicalJsonBytes: stage1Canonical } = require(path.join(temp, 'canon.cjs'))
const container = require(path.join(temp, 'container.cjs'))
const len8 = n => { const b = Buffer.alloc(8); b.writeUInt32BE(0, 0); b.writeUInt32BE(n, 4); return b }
const DOMAIN_ORDER = ['pregnancy', 'daily', 'mood', 'checkup', 'bag', 'reports']

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }

function buildPkg(manifest, segments) {
  const manifestBytes = Buffer.from(stage1Canonical(manifest))
  const parts = [Buffer.from(container.encodeHeader(manifestBytes.length)), manifestBytes]
  for (const seg of segments) parts.push(len8(seg.length), seg)
  return Buffer.concat(parts)
}
async function validate(pkg) {
  return container.validatePackage({ size: async () => pkg.length, readChunk: async (p, l) => new Uint8Array(pkg.subarray(p, p + l)) })
}
function wireManifest(pkg, manifestBytes) {
  const off = pkg.indexOf(manifestBytes)
  assert.ok(off === container.HEADER_LEN, `manifest 定位 ${off} ≠ 头部 ${container.HEADER_LEN}B`)
  return JSON.parse(pkg.subarray(off, off + manifestBytes.length).toString('utf8'))
}

const RID = 'rp-dup-emptyobj'

// 夹具：单报告正文 attachments=[]；reports 同 reportId 两条——首 [] 尾 {}；无附件文件
function buildDupShape() {
  const body = { id: RID, revision: 0, deleted: false, attachments: [] }
  const seg = Buffer.from(stage1Canonical([body]))
  const domains = {}
  for (const d of DOMAIN_ORDER) domains[d] = { status: 'omitted' }
  domains.reports = { status: 'present', recordCount: 1, pagingComplete: true, visibility: 'shared', fileIndex: 0 }
  const manifest = {
    formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: 'fam-x', packageKind: 'full', complete: true,
    scope: { includeShared: true, includePrivateOf: null }, scopeLabel: 'shared-only',
    domains,
    files: [{ path: 'records/reports.json', kind: 'domain-json', length: seg.length, sha256: sha256(seg), contentType: 'application/json', domain: 'reports' }],
    records: { reports: [{ index: 0, id: RID, revision: 0, deleted: false, hash: sha256(Buffer.from(stage1Canonical(body))) }] },
    reports: [
      { reportId: RID, revision: 0, deleted: false, attachments: [] },
      { reportId: RID, revision: 0, deleted: false, attachments: {} },
    ],
    pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
  }
  const manifestBytes = Buffer.from(stage1Canonical(manifest))
  return { manifest, manifestBytes, pkg: buildPkg(manifest, [seg]) }
}

;(async () => {
  const v20Hash = sha256(fs.readFileSync(V20_PATH))
  const srcHash = sha256(fs.readFileSync(SRC_PATH))
  console.log(`V20 重复映射尾随空对象 attachments 回归（真 Stage1 全包）rev1
v20.js: ${v20Hash.slice(0, 8)}｜源 index.js: ${srcHash.slice(0, 8)}（跑前冻结——红先行轮）
`)

  const f = buildDupShape()
  const v = await validate(f.pkg)

  await scenario('E1-① Stage1 validatePackage 接受（真全包前置——协调方独立复验 ok=true 零 problems）', async () => {
    assert.ok(v.ok, `Stage1 须接受零 problems（实得 ${JSON.stringify((v.problems || []).slice(0, 1)).slice(0, 120)}）——{} attachments 按 D26 语义归一零附件；零附件无 (reportId,order) 对不触 duplicate-report-order`)
    console.log('      边界：container.validatePackage（容器校验层）——非 handler')
  })

  await scenario('E1-② wire 形状前置：同 reportId 两条，首 attachments=[]（数组零长），尾 attachments={}（非数组空对象），revision/deleted 相同', async () => {
    const m = wireManifest(f.pkg, f.manifestBytes)
    assert.strictEqual(m.reports.length, 2, '须两条映射')
    assert.strictEqual(m.reports[0].reportId, m.reports[1].reportId, '同 reportId')
    const a0 = m.reports[0].attachments, a1 = m.reports[1].attachments
    assert.ok(Array.isArray(a0) && a0.length === 0, '首条 attachments 须 [] 数组零长')
    assert.ok(!Array.isArray(a1) && a1 !== null && typeof a1 === 'object' && Object.keys(a1).length === 0, '尾条 attachments 须 {} 非数组空对象')
    assert.strictEqual(m.reports[0].revision, m.reports[1].revision, 'revision 相同')
    assert.strictEqual(m.reports[0].deleted, m.reports[1].deleted, 'deleted 相同')
  })

  await scenario('E1-③ V20 须接受（原红形：0b87e249 拒 D25② raw canonical [] vs {} 不等——c4dd6824 修复转绿）——恰 1 record/零 refs/零 rmappart', async () => {
    const m = wireManifest(f.pkg, f.manifestBytes)
    let threw = null, stream = null
    try { stream = v20.deriveV20Stream(m) } catch (e) { threw = e }
    assert.ok(!threw, `Stage1-valid 形须接受（实抛 ${threw && threw.message.slice(0, 80)}）——D25 去重环须按 D26 归一语义比较（{} 与 [] 同为零附件→①全等去重）或 ③ 尾随空 no-op`)
    const records = stream.entries.filter(e => e.entry.type === 'record')
    const refs = stream.entries.filter(e => e.entry.type === 'refs')
    const rmapparts = stream.entries.filter(e => e.entry.type === 'rmappart')
    assert.strictEqual(records.length, 1, `record 条目须恰 1（实得 ${records.length}）`)
    assert.strictEqual(refs.length, 0, `refs 须零（实得 ${refs.length}）`)
    assert.strictEqual(rmapparts.length, 0, `rmappart 须零（实得 ${rmapparts.length}）`)
    assert.strictEqual(stream.count, 1, `流条目总数须 1（实得 ${stream.count}）`)
    console.log(`      接受：count=${stream.count}｜record=${records.length} refs=${refs.length} rmappart=${rmapparts.length}`)
  })

  await scenario('E1-④ 派生稳定哈希：双跑 entries/blocks/planRoot 逐字节一致（确定性锚）', async () => {
    const m1 = wireManifest(f.pkg, f.manifestBytes)
    const m2 = wireManifest(f.pkg, f.manifestBytes)
    const s1 = v20.deriveV20Stream(m1)
    const s2 = v20.deriveV20Stream(m2)
    assert.strictEqual(s1.entries.length, s2.entries.length, '双跑条目数一致')
    s1.entries.forEach((e, i) => assert.ok(e.canonical.equals(s2.entries[i].canonical), `条目${i} canonical 逐字节一致`))
    assert.strictEqual(s1.blocks.length, s2.blocks.length)
    s1.blocks.forEach((b, i) => assert.ok(b.equals(s2.blocks[i]), `块${i} 逐字节一致`))
    const root1 = v20.buildTree(s1.blocks).root.toString('hex')
    const root2 = v20.buildTree(s2.blocks).root.toString('hex')
    assert.strictEqual(root1, root2, 'planRoot 双跑一致')
    console.log(`      planRoot=${root1.slice(0, 16)}…｜blocks=${s1.blocks.length}（${s1.blocks.map(b => b.length).join('/')}B）`)
  })

  // ── 冻结哈希漂移门（QR19-v7 规则：漂移=无效轮——failed+++exit 1）──
  const v20Post = sha256(fs.readFileSync(V20_PATH))
  const srcPost = sha256(fs.readFileSync(SRC_PATH))
  console.log(`\n源 index.js: ${srcPost.slice(0, 8)} ${srcHash === srcPost ? '== 一致' : '≠ 漂移'}｜v20.js: ${v20Post.slice(0, 8)} ${v20Hash === v20Post ? '== 一致' : '≠ 漂移'}`)
  if (v20Hash !== v20Post || srcHash !== srcPost) failed.push('冻结源漂移：v20/index 跑前≠跑后（本轮无效）')

  console.log(`\n${passed} 通过, ${failed.length} 失败`)
  if (failed.length) { console.log('失败项：\n - ' + failed.join('\n - ')); process.exit(1) }
})().catch(e => { console.error(e); process.exit(2) })
