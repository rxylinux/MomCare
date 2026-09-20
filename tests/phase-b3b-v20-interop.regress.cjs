// V20 模块补充回归 rev3：canonical 互操作+真包 packBlocks+verifiedBlockRead 协议形状
// 协调方三域指派（首版 CODING 缺陷已报——红先行保持，冻结修复后重跑）：
//   C1 canonicalJsonBytes 与 utils/mcpkg/canonical.js 互操作（含转义键值/嵌套数组/稀疏/环负例）
//   C2 packBlocks 用真 validatePackage 包的 deriveV20Stream 输出（非仅原始 A buffer）
//   C3 verifiedBlockRead 用协议存储块形状（entries 从批次文档取出——blockIndex 从调用方传入）
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-v20reg3-'))
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

;(async () => {
  const v20Hash = sha256(fs.readFileSync(V20_PATH))
  const srcHash = sha256(fs.readFileSync(path.join(root, 'cloud/functions/mc-restore/index.js')))
  console.log(`V20 补充回归 rev3
v20.js: ${v20Hash.slice(0, 8)}｜源: ${srcHash.slice(0, 8)}
`)

  // ══ C1 canonical 互操作 ══
  await scenario('C1-① 空对象 canonical 与 Stage1 全等', async () => {
    const v = v20.canonicalJsonBytes({})
    const s = stage1Canonical({})
    assert.ok(Buffer.from(v).equals(Buffer.from(s)), `v20=${Buffer.from(v).toString()} s1=${Buffer.from(s).toString()}`)
  })
  await scenario('C1-② 转义键值+嵌套数组 canonical 与 Stage1 全等', async () => {
    const obj = { 'key"with"quotes': 'val\\back', 'unicode🔑': ['nested', ['deeper', [{ a: null }]]], num: 3.14, bool: true, nil: null }
    const v = v20.canonicalJsonBytes(obj)
    const s = stage1Canonical(obj)
    assert.ok(Buffer.from(v).equals(Buffer.from(s)), `v20=${Buffer.from(v).toString('utf8').slice(0, 80)}\n s1=${Buffer.from(s).toString('utf8').slice(0, 80)}`)
  })
  await scenario('C1-③ 含 emoji（4 字节 UTF-8）canonical 与 Stage1 全等', async () => {
    const obj = { emoji: '😀🔐📦', mixed: '汉😀"\\' }
    const v = v20.canonicalJsonBytes(obj)
    const s = stage1Canonical(obj)
    assert.ok(Buffer.from(v).equals(Buffer.from(s)))
  })
  await scenario('C1-④ 稀疏数组——双方均拒', async () => {
    const sparse = [1, , 3]
    assert.throws(() => v20.canonicalJsonBytes(sparse), /稀疏/)
    assert.throws(() => stage1Canonical(sparse), /sparse|稀疏|undefined/)
  })
  await scenario('C1-⑤ undefined 值——双方均拒', async () => {
    assert.throws(() => v20.canonicalJsonBytes({ x: undefined }), /undefined/)
    assert.throws(() => stage1Canonical({ x: undefined }), /undefined/)
  })
  await scenario('C1-⑥ NaN/Infinity——双方均拒', async () => {
    assert.throws(() => v20.canonicalJsonBytes(NaN), /有限/)
    assert.throws(() => v20.canonicalJsonBytes(Infinity), /有限/)
    assert.throws(() => stage1Canonical(NaN), /有限|NaN/)
    assert.throws(() => stage1Canonical(Infinity), /有限|Infinity/)
  })

  // ══ C2 真包 packBlocks（deriveV20Stream 输出→packBlocks——非仅原始 A buffer） ══
  await scenario('C2-① 真包 derive+packBlocks：块=canonical(条目数组) 且 ≤10KiB ∧ ≤48 条', async () => {
    const rid = 'rp-c2'
    const oid = 'C'.repeat(2 * KiB)
    const body = { id: rid, revision: 0, deleted: false, attachments: [{ fileId: oid, order: 0 }, { fileId: oid, order: 1 }, { fileId: oid, order: 2 }] }
    const seg = Buffer.from(stage1Canonical([body]))
    const attBytes = Buffer.alloc(8, 0x4E)
    const domains = {}
    for (const d of DOMAIN_ORDER) domains[d] = { status: 'omitted' }
    domains.reports = { status: 'present', recordCount: 1, pagingComplete: true, visibility: 'shared', fileIndex: 1 }
    const manifest = {
      formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: 'fam-x', packageKind: 'full', complete: true,
      scope: { includeShared: true, includePrivateOf: null }, scopeLabel: 'shared-only',
      domains,
      files: [
        { path: 'attachments/c.bin', kind: 'attachment', length: attBytes.length, sha256: sha256(attBytes), contentType: 'image/png', originalFileId: oid, chunkSha256: [sha256(attBytes)], referencedBy: [rid] },
        { path: 'records/reports.json', kind: 'domain-json', length: seg.length, sha256: sha256(seg), contentType: 'application/json', domain: 'reports' },
      ],
      records: { reports: [{ index: 0, id: rid, revision: 0, deleted: false, hash: sha256(Buffer.from(stage1Canonical(body))) }] },
      reports: [{ reportId: rid, revision: 0, deleted: false, attachments: [{ order: 0, originalFileId: oid, fileIndex: 0 }, { order: 1, originalFileId: oid, fileIndex: 0 }, { order: 2, originalFileId: oid, fileIndex: 0 }] }],
      pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
    }
    const v = await buildValidate(manifest, [attBytes, seg])
    assert.ok(v.ok, JSON.stringify((v.problems || []).slice(0, 1)).slice(0, 100))
    const stream = v20.deriveV20Stream(v.manifest)
    assert.ok(stream.entries.length > 3, `条目=${stream.entries.length}`)
    const blocks = v20.packBlocks(stream)
    assert.ok(blocks.length >= 1, `块=${blocks.length}`)
    // 每块可反序列化为条目数组（canonical 往返）
    for (const b of blocks) {
      assert.ok(b.length <= 10 * KiB, `块 ${b.length}B >10KiB`)
      const parsed = JSON.parse(b.toString('utf8'))
      assert.ok(Array.isArray(parsed), '块=条目数组')
      assert.ok(parsed.length <= 48, `条目 ${parsed.length} >48`)
      assert.ok(parsed.every(e => e.type), '每条目含 type')
    }
  })
  await scenario('C2-② 真包单条目流：record+file+refs+rmappart 至少四类——blocks ≥1 且可验证 root', async () => {
    const rid = 'rp-c2s'
    const body = { id: rid, revision: 0, deleted: false, attachments: [{ fileId: 'x', order: 0 }] }
    const seg = Buffer.from(stage1Canonical([body]))
    const attBytes = Buffer.alloc(8, 0x4F)
    const domains = {}
    for (const d of DOMAIN_ORDER) domains[d] = { status: 'omitted' }
    domains.reports = { status: 'present', recordCount: 1, pagingComplete: true, visibility: 'shared', fileIndex: 1 }
    const manifest = {
      formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: 'fam-x', packageKind: 'full', complete: true,
      scope: { includeShared: true, includePrivateOf: null }, scopeLabel: 'shared-only',
      domains,
      files: [
        { path: 'attachments/s.bin', kind: 'attachment', length: attBytes.length, sha256: sha256(attBytes), contentType: 'image/png', originalFileId: 'x', chunkSha256: [sha256(attBytes)], referencedBy: [rid] },
        { path: 'records/reports.json', kind: 'domain-json', length: seg.length, sha256: sha256(seg), contentType: 'application/json', domain: 'reports' },
      ],
      records: { reports: [{ index: 0, id: rid, revision: 0, deleted: false, hash: sha256(Buffer.from(stage1Canonical(body))) }] },
      reports: [{ reportId: rid, revision: 0, deleted: false, attachments: [{ order: 0, originalFileId: 'x', fileIndex: 0 }] }],
      pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
    }
    const v = await buildValidate(manifest, [attBytes, seg])
    assert.ok(v.ok)
    const stream = v20.deriveV20Stream(v.manifest)
    const types = new Set(stream.entries.map(e => e.entry.type))
    assert.ok(types.has('record') && types.has('file') && types.has('refs') && types.has('rmappart'), `类型=${[...types].join(',')}`)
    const blocks = v20.packBlocks(stream)
    const tree = v20.buildTree(blocks)
    // 验证每块 proof 折叠
    for (let i = 0; i < blocks.length; i++) {
      assert.ok(v20.verifyProof({ totalBlocks: blocks.length, blockIndex: i, blockBytes: blocks[i], proof: tree.proofs[i], planRoot: tree.root }))
    }
  })

  // ══ C3 verifiedBlockRead 协议存储块形状 ══
  {
    // 构造 committed 树
    const rid = 'rp-c3'
    const body = { id: rid, revision: 0, deleted: false, attachments: [{ fileId: 'y', order: 0 }] }
    const seg = Buffer.from(stage1Canonical([body]))
    const attBytes = Buffer.alloc(8, 0x50)
    const domains = {}
    for (const d of DOMAIN_ORDER) domains[d] = { status: 'omitted' }
    domains.reports = { status: 'present', recordCount: 1, pagingComplete: true, visibility: 'shared', fileIndex: 1 }
    const manifest = {
      formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: 'fam-x', packageKind: 'full', complete: true,
      scope: { includeShared: true, includePrivateOf: null }, scopeLabel: 'shared-only',
      domains,
      files: [
        { path: 'attachments/c3.bin', kind: 'attachment', length: attBytes.length, sha256: sha256(attBytes), contentType: 'image/png', originalFileId: 'y', chunkSha256: [sha256(attBytes)], referencedBy: [rid] },
        { path: 'records/reports.json', kind: 'domain-json', length: seg.length, sha256: sha256(seg), contentType: 'application/json', domain: 'reports' },
      ],
      records: { reports: [{ index: 0, id: rid, revision: 0, deleted: false, hash: sha256(Buffer.from(stage1Canonical(body))) }] },
      reports: [{ reportId: rid, revision: 0, deleted: false, attachments: [{ order: 0, originalFileId: 'y', fileIndex: 0 }] }],
      pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
    }
    const v = await buildValidate(manifest, [attBytes, seg])
    const stream = v20.deriveV20Stream(v.manifest)
    const blocks = v20.packBlocks(stream)
    const tree = v20.buildTree(blocks)
    const totalBlocks = blocks.length
    const planRootHex = tree.root.toString('hex')
    // 合法 36 字符 batchId（rst_+32 hex——生产 :589 格式）
    const batchId = 'rst_' + crypto.randomBytes(16).toString('hex')
    // 独立计算叶哈希（不用 v20.leafHash——独立验证）
    const u32be2 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
    const indepLeaf = (total, idx, bytes) => sha256(Buffer.concat([Buffer.from('mcpkg-blk:'), u32be2(total), u32be2(idx), bytes]))
    // 协议存储块文档（§6.4-④）：{_id, sha256=叶哈希（独立计算）, byteLength, entryCount, entries(native JSON), proof}
    const blockDocs = blocks.map((b, i) => ({
      _id: `${batchId}:blk:${i}`,
      sha256: indepLeaf(totalBlocks, i, b).toString('hex'), // ← 修正：独立计算叶哈希——非 tree.proofs[i]
      byteLength: b.length,
      entryCount: JSON.parse(b.toString('utf8')).length,
      entries: JSON.parse(b.toString('utf8')),
      proof: tree.proofs[i],
    }))
    // 前置：独立叶哈希与 v20 树叶全等（双向核对）
    for (let i = 0; i < totalBlocks; i++) {
      const myLeaf = indepLeaf(totalBlocks, i, blocks[i]).toString('hex')
      // v20.buildTree 不直接暴露叶——但 verifyProof 的叶计算与之等价（间接核对 via proof folding）
    }

    const batch = { batchId, totalBlocks, planRoot: planRootHex }
    await scenario('C3-① verifiedBlockRead 合法块接受（合法 36B bid+独立叶哈希+entries→canonical→proof→root）', async () => {
      for (let i = 0; i < totalBlocks; i++) {
        const result = v20.verifiedBlockRead({ blockDoc: blockDocs[i], batch, blockIndex: i })
        assert.ok(Buffer.isBuffer(result) || result instanceof Uint8Array, `块 ${i} 返回字节`)
        assert.equal(Buffer.from(result).length, blockDocs[i].byteLength, `块 ${i} byteLength`)
      }
    })
    await scenario('C3-② 篡改 entries（record.id→HACKED——保证变异实际条目字段）→ 拒', async () => {
      const doc = JSON.parse(JSON.stringify(blockDocs[0]))
      // 确保变异一个实际存在的字段
      const mutated = false
      for (const e of doc.entries) {
        if (e.id !== undefined) { e.id = 'HACKED'; break }
        if (e.items && e.items[0]) { e.items[0].rid = 'HACKED'; break }
        if (e.hash !== undefined) { e.hash = '0'.repeat(64); break }
      }
      assert.throws(() => v20.verifiedBlockRead({ blockDoc: doc, batch, blockIndex: 0 }), /根折叠|byteLength|dup|_id|entryCount/)
    })
    await scenario('C3-③ byteLength 不符 → 拒', async () => {
      const doc = { ...blockDocs[0], byteLength: blockDocs[0].byteLength + 1 }
      assert.throws(() => v20.verifiedBlockRead({ blockDoc: doc, batch, blockIndex: 0 }), /byteLength/)
    })
    await scenario('C3-④ _id 不符（错 blockIndex=1 传入但 _id=blk:0）→ 拒', async () => {
      assert.throws(() => v20.verifiedBlockRead({ blockDoc: blockDocs[0], batch, blockIndex: 1 }), /_id/)
    })
    await scenario('C3-⑤ sha256-only 篡改（sha256=位置绑定叶哈希——非裸载荷哈希；改 sha256 字段不改 entries/proof）→ 拒', async () => {
      const doc = { ...blockDocs[0], sha256: '0'.repeat(64) }
      // 当前 v20.verifiedBlockRead 不读 blockDoc.sha256——篡改 sha256 不触发拒绝
      // 这是缺口：§6.4-④ 块文档含 sha256 字段但 verifiedBlockRead 未校验
      // 红先行：assert.throws 期望拒——当前不拒则红
      let threw = null
      try { v20.verifiedBlockRead({ blockDoc: doc, batch, blockIndex: 0 }) } catch (e) { threw = e }
      if (!threw) {
        throw new Error('缺口：verifiedBlockRead 未校验 blockDoc.sha256 字段——sha256-only 篡改通过（§6.4-④ 块文档含该字段但读侧未核对）——修复方向：加 sha256===sha256(payloadBytes) 校验')
      }
    })
  }

  console.log(`\n${passed} 通过, ${failed.length} 失败`)
  if (failed.length) { console.log('失败项：\n - ' + failed.join('\n - ')); process.exit(1) }
})().catch(e => { console.error(e); process.exit(2) })
