// V20 独立回归 rev4：巨 id 报告 refs 超 2KiB 缺陷 + 长 path/oid 碎片元数据 + 修复后验证
// 协调方指认：巨 id 报告（~2780B）→ refs items 含 rid 全文 → 单项即超 ENTRY_MAX → derive fail
// 修复方向：refs items 不携带 rid（改为 reportIndex 定位——rid 从 record core/idRef 短承诺获取）
// 红先行：先证当前 v20 在该形状 throw，CODING 修复后转绿。
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-v20reg4-'))
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')
const KiB = 1024, MiB = 1024 * 1024

const V20_PATH = path.join(root, 'cloud/functions/mc-restore/v20.js')
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
async function buildValidate(manifest, segments) {
  const manifestBytes = Buffer.from(stage1Canonical(manifest))
  const parts = [Buffer.from(container.encodeHeader(manifestBytes.length)), manifestBytes]
  for (const seg of segments) parts.push(len8(seg.length), seg)
  const pkg = Buffer.concat(parts)
  return container.validatePackage({ size: async () => pkg.length, readChunk: async (p, l) => new Uint8Array(pkg.subarray(p, p + l)) })
}

// 构造巨 id 报告包（rid ~2780B + 1 附件——P7 形真验包）
function buildGiantRidPackage() {
  const rid = 'G'.repeat(2780) // P7 形巨 id
  const attBytes = Buffer.alloc(8, 0x51)
  const body = { id: rid, revision: 0, deleted: false, attachments: [{ fileId: 'att-oid', order: 0 }] }
  const seg = Buffer.from(stage1Canonical([body]))
  const domains = {}
  for (const d of DOMAIN_ORDER) domains[d] = { status: 'omitted' }
  domains.reports = { status: 'present', recordCount: 1, pagingComplete: true, visibility: 'shared', fileIndex: 1 }
  const manifest = {
    formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: 'fam-x', packageKind: 'full', complete: true,
    scope: { includeShared: true, includePrivateOf: null }, scopeLabel: 'shared-only',
    domains,
    files: [
      { path: 'attachments/g.bin', kind: 'attachment', length: attBytes.length, sha256: sha256(attBytes), contentType: 'image/png', originalFileId: 'att-oid', chunkSha256: [sha256(attBytes)], referencedBy: [rid] },
      { path: 'records/reports.json', kind: 'domain-json', length: seg.length, sha256: sha256(seg), contentType: 'application/json', domain: 'reports' },
    ],
    records: { reports: [{ index: 0, id: rid, revision: 0, deleted: false, hash: sha256(Buffer.from(stage1Canonical(body))) }] },
    reports: [{ reportId: rid, revision: 0, deleted: false, attachments: [{ order: 0, originalFileId: 'att-oid', fileIndex: 0 }] }],
    pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
  }
  return { manifest, segments: [attBytes, seg], rid }
}

// 构造长 path + 长 originalFileId 包
function buildLongFieldsPackage() {
  const rid = 'rp-longfields'
  const longOid = 'O'.repeat(2500) // >1KiB 触发 filefrag(originalFileId)
  const longPath = 'attachments/' + 'P'.repeat(2500) // >1KiB 触发 filefrag(path)
  const attBytes = Buffer.alloc(8, 0x52)
  const body = { id: rid, revision: 0, deleted: false, attachments: [{ fileId: longOid, order: 0 }] }
  const seg = Buffer.from(stage1Canonical([body]))
  const domains = {}
  for (const d of DOMAIN_ORDER) domains[d] = { status: 'omitted' }
  domains.reports = { status: 'present', recordCount: 1, pagingComplete: true, visibility: 'shared', fileIndex: 1 }
  const manifest = {
    formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: 'fam-x', packageKind: 'full', complete: true,
    scope: { includeShared: true, includePrivateOf: null }, scopeLabel: 'shared-only',
    domains,
    files: [
      { path: longPath, kind: 'attachment', length: attBytes.length, sha256: sha256(attBytes), contentType: 'image/png', originalFileId: longOid, chunkSha256: [sha256(attBytes)], referencedBy: [rid] },
      { path: 'records/reports.json', kind: 'domain-json', length: seg.length, sha256: sha256(seg), contentType: 'application/json', domain: 'reports' },
    ],
    records: { reports: [{ index: 0, id: rid, revision: 0, deleted: false, hash: sha256(Buffer.from(stage1Canonical(body))) }] },
    reports: [{ reportId: rid, revision: 0, deleted: false, attachments: [{ order: 0, originalFileId: longOid, fileIndex: 0 }] }],
    pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
  }
  return { manifest, segments: [attBytes, seg], rid, longOid, longPath }
}

;(async () => {
  const v20Hash = sha256(fs.readFileSync(V20_PATH))
  const srcHash = sha256(fs.readFileSync(path.join(root, 'cloud/functions/mc-restore/index.js')))
  console.log(`V20 巨 id refs 回归 rev4
v20.js: ${v20Hash.slice(0, 8)}｜源: ${srcHash.slice(0, 8)}
`)

  // ══ D1 巨 id 报告 refs 超 2KiB ══
  const giant = buildGiantRidPackage()
  const giantValidate = await buildValidate(giant.manifest, giant.segments)
  await scenario('D1-① 巨 id 报告包（rid 2780B+1 附件）真 validatePackage 零 problems', async () => {
    assert.ok(giantValidate.ok, JSON.stringify((giantValidate.problems || []).slice(0, 2)).slice(0, 200))
  })

  await scenario('D1-② 当前 v20.deriveV20Stream 在巨 id 报告形状的 refs 条目超 2KiB（红——记录缺陷）', async () => {
    // refs item = {order:0, rid:"GGG...(2780B)"} → canonical ≈ 2815B > 2048B → push() throw
    // 这是协调方指认的缺陷：refs items 不应携带 rid 全文
    const refsItem = { order: 0, rid: giant.rid }
    const refsEntry = { type: 'refs', fileIndex: 0, part: 0, items: [refsItem] }
    const bytes = Buffer.from(stage1Canonical(refsEntry))
    assert.ok(bytes.length > 2048, `refs 条目=${bytes.length}B >2048B——单项即超限——rid 全文拷贝是缺陷根因`)
    // 尝试 v20 derive——应在 push 时 throw
    let threw = null
    try { v20.deriveV20Stream(giantValidate.manifest) } catch (e) { threw = e }
    // 红先行：当前 throw=缺陷存在的证据；修复后（refs 不含 rid 或 reportIndex 定位）应不 throw
    if (threw) {
      console.log(`      当前缺陷确认：${threw.message.slice(0, 80)}——refs items 含 rid 全文 → 单项超 2KiB`)
      // 这是 RED——记录但不让 exit 0（缺陷待修复）
      throw new Error(`缺陷待修（红先行）：v20.deriveV20Stream 在巨 id 报告 throw "${threw.message.slice(0, 60)}"——修复方向：refs items 改为 reportIndex（不携带 rid）`)
    }
    // 若不 throw（已修复）——验证 refs 条目不含 rid 全文
    const stream = v20.deriveV20Stream(giantValidate.manifest)
    const refsEntries = stream.entries.filter(e => e.entry.type === 'refs')
    assert.ok(refsEntries.length >= 1, 'refs 条目存在')
    for (const r of refsEntries) {
      const bytes2 = Buffer.from(stage1Canonical(r.entry))
      assert.ok(bytes2.length <= 2048, `修复后 refs 条目=${bytes2.length}B ≤2048B`)
      // 检查 items 不含 rid 全文
      for (const it of r.entry.items) {
        if (it.rid) assert.ok(String(it.rid).length <= 2048, 'rid 若在则 ≤2KiB')
      }
    }
    console.log('      已修复：refs 条目 ≤2KiB 且不含巨 rid 全文')
  })

  await scenario('D1-③ 修复验证：巨 id 的 record 条目用 idRef 短承诺（idfrag 分片）', async () => {
    const stream = v20.deriveV20Stream(giantValidate.manifest)
    const recordEntry = stream.entries.find(e => e.entry.type === 'record')
    assert.ok(recordEntry, 'record 条目存在')
    assert.ok(!recordEntry.entry.id || String(recordEntry.entry.id).length <= 2048, 'record 条目 id 若有则 ≤2KiB')
    const idfrags = stream.entries.filter(e => e.entry.type === 'idfrag')
    assert.ok(idfrags.length >= 1, `idfrag 存在（${idfrags.length} 个）`)
    // idRef 短承诺
    if (recordEntry.entry.idRef) {
      assert.ok(recordEntry.entry.idRef.sha256 && /^[0-9a-f]{64}$/.test(recordEntry.entry.idRef.sha256), 'idRef.sha256=64hex')
      assert.ok(Number.isInteger(recordEntry.entry.idRef.len), 'idRef.len')
    }
  })

  // ══ D2 长 path + 长 originalFileId 碎片元数据/读重建 ══
  const longPkg = buildLongFieldsPackage()
  const longValidate = await buildValidate(longPkg.manifest, longPkg.segments)
  await scenario('D2-① 长字段包（oid 2500B + path 2512B）真 validatePackage 零 problems', async () => {
    assert.ok(longValidate.ok, JSON.stringify((longValidate.problems || []).slice(0, 2)).slice(0, 200))
  })

  await scenario('D2-② derive 产生 filefrag(originalFileId) + filefrag(path) + Ref 元数据字段精确存在', async () => {
    const stream = v20.deriveV20Stream(longValidate.manifest)
    const fileEntry = stream.entries.find(e => e.entry.type === 'file')
    assert.ok(fileEntry, 'file 条目存在')
    const fe = fileEntry.entry
    // 碎片字段——精确断言（无 OR fallback——缺失即红）
    assert.ok(fe.originalFileIdRef !== undefined, 'file core 必含 originalFileIdRef（oid >1KiB → 碎片化 → Ref 短承诺）')
    assert.ok(fe.pathRef !== undefined, 'file core 必含 pathRef（path >1KiB → 碎片化 → Ref 短承诺）')
    assert.equal(fe.originalFileId, undefined, 'oid >1KiB 不得内联（碎片为唯一副本）')
    assert.equal(fe.path, undefined, 'path >1KiB 不得内联（碎片为唯一副本）')
    const oidFrags = stream.entries.filter(e => e.entry.type === 'filefrag' && e.entry.field === 'originalFileId')
    const pathFrags = stream.entries.filter(e => e.entry.type === 'filefrag' && e.entry.field === 'path')
    assert.ok(oidFrags.length >= 1, `oid filefrag=${oidFrags.length}`)
    assert.ok(pathFrags.length >= 1, `path filefrag=${pathFrags.length}`)
    for (const [frags, label] of [[oidFrags, 'oid'], [pathFrags, 'path']]) {
      const seqs = frags.map(f => f.entry.seq).sort((a, b) => a - b)
      for (let i = 0; i < seqs.length; i++) assert.equal(seqs[i], i, `${label} seq 连续`)
    }
  })

  await scenario('D2-③ filefrag 重组=canonical 原始值字节（oid+path 双重建——精确字段 data）', async () => {
    const stream = v20.deriveV20Stream(longValidate.manifest)
    const oidCanonical = stage1Canonical(longPkg.longOid)
    const oidFrags = stream.entries.filter(e => e.entry.type === 'filefrag' && e.entry.field === 'originalFileId').sort((a, b) => a.entry.seq - b.entry.seq)
    const oidReassembled = Buffer.concat(oidFrags.map(f => Buffer.from(f.entry.data, 'base64')))
    assert.ok(oidReassembled.equals(Buffer.from(oidCanonical)), `oid 重组=${oidReassembled.length}B canonical=${oidCanonical.length}B`)
    assert.equal(oidCanonical[0], 0x22, 'oid canonical 首=引号')
    const pathCanonical = stage1Canonical(longPkg.longPath)
    const pathFrags = stream.entries.filter(e => e.entry.type === 'filefrag' && e.entry.field === 'path').sort((a, b) => a.entry.seq - b.entry.seq)
    assert.ok(pathFrags.length >= 1, 'path filefrag ≥1')
    const pathReassembled = Buffer.concat(pathFrags.map(f => Buffer.from(f.entry.data, 'base64')))
    assert.ok(pathReassembled.equals(Buffer.from(pathCanonical)), `path 重组=${pathReassembled.length}B canonical=${pathCanonical.length}B`)
    assert.equal(pathCanonical[0], 0x22, 'path canonical 首=引号')
  })

  await scenario('D2-④ originalFileIdRef/pathRef 精确值与碎片全匹配（len=canonical 长度 ∧ sha256=sha256(canonical) ∧ frags=碎片数 ∧ 缺失/腐蚀即红）', async () => {
    const stream = v20.deriveV20Stream(longValidate.manifest)
    const fileEntry = stream.entries.find(e => e.entry.type === 'file').entry
    const oidCanonical = Buffer.from(stage1Canonical(longPkg.longOid))
    const pathCanonical = Buffer.from(stage1Canonical(longPkg.longPath))
    const oidFrags = stream.entries.filter(e => e.entry.type === 'filefrag' && e.entry.field === 'originalFileId')
    const pathFrags = stream.entries.filter(e => e.entry.type === 'filefrag' && e.entry.field === 'path')
    // originalFileIdRef 精确断言（无 fallback——字段不存在/值错均红）
    assert.ok(fileEntry.originalFileIdRef, 'originalFileIdRef 必须存在')
    assert.equal(fileEntry.originalFileIdRef.len, oidCanonical.length, `originalFileIdRef.len=${fileEntry.originalFileIdRef.len} canonical=${oidCanonical.length}`)
    assert.equal(fileEntry.originalFileIdRef.sha256, sha256(oidCanonical), `originalFileIdRef.sha256=${String(fileEntry.originalFileIdRef.sha256).slice(0, 8)}…`)
    assert.equal(fileEntry.originalFileIdRef.frags, oidFrags.length, `originalFileIdRef.frags=${fileEntry.originalFileIdRef.frags} 实际=${oidFrags.length}`)
    // pathRef 精确断言
    assert.ok(fileEntry.pathRef, 'pathRef 必须存在')
    assert.equal(fileEntry.pathRef.len, pathCanonical.length, `pathRef.len=${fileEntry.pathRef.len} canonical=${pathCanonical.length}`)
    assert.equal(fileEntry.pathRef.sha256, sha256(pathCanonical), `pathRef.sha256=${String(fileEntry.pathRef.sha256).slice(0, 8)}…`)
    assert.equal(fileEntry.pathRef.frags, pathFrags.length, `pathRef.frags=${fileEntry.pathRef.frags} 实际=${pathFrags.length}`)
    // idRef（D1 巨 id）——也精确断言（此包 rid 短，不触发——但须确认无假 idRef）
    assert.equal(fileEntry.idRef, undefined, '短 id 不产 idRef')
  })

  await scenario('D2-⑤ Ref 元数据腐蚀负例：改 originalFileIdRef.sha256 → 独立核对发现不等', async () => {
    const stream = v20.deriveV20Stream(longValidate.manifest)
    const fileEntry = stream.entries.find(e => e.entry.type === 'file').entry
    const oidCanonical = Buffer.from(stage1Canonical(longPkg.longOid))
    // 腐蚀 Ref.sha256
    const corrupted = { ...fileEntry, originalFileIdRef: { ...fileEntry.originalFileIdRef, sha256: '0'.repeat(64) } }
    // 独立核对：corrupted.originalFileIdRef.sha256 ≠ sha256(oidCanonical)
    assert.notEqual(corrupted.originalFileIdRef.sha256, sha256(oidCanonical), '腐蚀 Ref 与正确 sha256 不等——验证者应拒')
    // 独立核对：碎片重组的 sha256 也不等
    const oidFrags = stream.entries.filter(e => e.entry.type === 'filefrag' && e.entry.field === 'originalFileId').sort((a, b) => a.entry.seq - b.entry.seq)
    const reassembled = Buffer.concat(oidFrags.map(f => Buffer.from(f.entry.data, 'base64')))
    assert.notEqual(sha256(reassembled), corrupted.originalFileIdRef.sha256, '碎片重组 sha256 ≠ 腐蚀 Ref——验证者应拒')
  })

  console.log(`\n${passed} 通过, ${failed.length} 失败`)
  if (failed.length) { console.log('失败项：\n - ' + failed.join('\n - ')); process.exit(1) }
})().catch(e => { console.error(e); process.exit(2) })
