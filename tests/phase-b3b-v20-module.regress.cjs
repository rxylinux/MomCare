// B3b V20 索引模块独立红先行回归（rev2——对接实际 V20 模块 API @43c49e69）
// 独立冻结向量（非 CODING 派生导入）；协调方四修正落实：
//   ① V1 补 code2（mapping 缺席 vs file 空串）
//   ② V4 改真包两次 derive+pack（非同 buffer 复算）
//   ③ V5 改验证器负例（committed root+proof 拒篡改存储块——改 codes/items/wrong index/malformed proof）
//   ④ 对接实际导出（buildTree/verifyProof/deriveV20Stream/packBlocks 等）
// Stage1-legal full packages 为夹具；Stage2 基线独立（82/3 不动）。
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-v20reg2-'))
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')
const KiB = 1024, MiB = 1024 * 1024

// ── V20 模块装载 ──
const V20_PATH = path.join(root, 'cloud/functions/mc-restore/v20.js')
if (!fs.existsSync(V20_PATH)) {
  console.log('B3b V20 索引模块回归已就绪、未运行：v20.js 尚未落地')
  process.exit(3)
}
const v20Out = path.join(temp, 'v20.cjs')
esbuild.buildSync({ entryPoints: [V20_PATH], bundle: true, platform: 'node', format: 'cjs', outfile: v20Out, logLevel: 'silent' })
const v20 = require(v20Out)

// Stage1 canonical/container（独立于 V20 模块——不 import v20.canonicalJsonBytes）
const mk = (rel, out) => esbuild.buildSync({ stdin: { contents: fs.readFileSync(path.join(root, rel), 'utf8').replace(/'\.\//g, "'@/utils/mcpkg/"), resolveDir: root, loader: 'js' }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: path.join(temp, out), logLevel: 'silent' })
mk('utils/mcpkg/canonical.js', 'canon.cjs')
mk('utils/mcpkg/container.js', 'container.cjs')
const { canonicalJsonBytes } = require(path.join(temp, 'canon.cjs'))
const container = require(path.join(temp, 'container.cjs'))
const len8 = n => { const b = Buffer.alloc(8); b.writeUInt32BE(0, 0); b.writeUInt32BE(n, 4); return b }
const u32be = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
const sha = sha256

// ── 独立向量（node:crypto 独立算——不用 v20 内部函数） ──
const leaf = (total, idx, bytes) => sha(Buffer.concat([Buffer.from('mcpkg-blk:'), u32be(total), u32be(idx), bytes]))
const parent = (total, L, j, lHex, rHex) => sha(Buffer.concat([Buffer.from('mcpkg-par:'), u32be(total), u32be(L), u32be(j), Buffer.from(lHex, 'hex'), Buffer.from(rHex, 'hex')]))
const V0_LEAF0 = leaf(3, 0, Buffer.from('A'))
const V0_LEAF1 = leaf(3, 1, Buffer.from('BB'))
const V0_LEAF2 = leaf(3, 2, Buffer.from('CCC'))
const V0_P0 = parent(3, 0, 0, V0_LEAF0, V0_LEAF1)
const V0_P1 = parent(3, 0, 1, V0_LEAF2, V0_LEAF2)
const V0_ROOT = parent(3, 1, 0, V0_P0, V0_P1)
function indepPackCodes(codes) { const b = Buffer.alloc(Math.ceil(codes.length * 3 / 8), 0); codes.forEach((c, j) => { for (let k = 0; k < 3; k++) if ((c >> k) & 1) { const p = j * 3 + k; b[p >> 3] |= 1 << (p & 7) } }); return b }

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }

const DOMAIN_ORDER = ['pregnancy', 'daily', 'mood', 'checkup', 'bag', 'reports']
async function buildValidate(manifest, segments) {
  const manifestBytes = Buffer.from(canonicalJsonBytes(manifest))
  const parts = [Buffer.from(container.encodeHeader(manifestBytes.length)), manifestBytes]
  for (const seg of segments) parts.push(len8(seg.length), seg)
  const pkg = Buffer.concat(parts)
  return container.validatePackage({ size: async () => pkg.length, readChunk: async (p, l) => new Uint8Array(pkg.subarray(p, p + l)) })
}

;(async () => {
  const srcHash = sha256(fs.readFileSync(path.join(root, 'cloud/functions/mc-restore/index.js')))
  const v20Hash = sha256(fs.readFileSync(V20_PATH))
  console.log(`B3b V20 索引模块独立回归（rev2）
源: ${srcHash.slice(0, 8)}（生产不变）｜v20.js: ${v20Hash.slice(0, 8)}
`)

  // ══ V0 三叶 root/proof 向量 ══
  await scenario('V0-① 独立计算的三叶七哈希与提案 §6.3 向量全等', async () => {
    assert.equal(V0_LEAF0, '0c701231f815045650cfd37823eda09d55a840ce796fd97d4747f1d891bfeca7')
    assert.equal(V0_LEAF1, '35158d772a7c6d6f67790dbc6a83dd143c21ca48eee1cfa94fbceb6b06ea86df')
    assert.equal(V0_LEAF2, '0d4de85a897681cc2332efa85851f23c71c514dd4dad1747de34e10a483348f0')
    assert.equal(V0_P0, 'c0ac3028748d6321db59600b71c47a6d55a4c73669eae2c330d95abb727e380b')
    assert.equal(V0_P1, 'a9d43a77a75b63df7c6649bed1c7497a8fce7d6c907a2b64e123dde3e74771fc')
    assert.equal(V0_ROOT, '91298894cd60d7dae5aca1b1b257eb2c1bdd7f8431155435c6ff086b1712a42b')
  })
  await scenario('V0-② v20.buildTree 三叶 root 复现独立值', async () => {
    const t = v20.buildTree([Buffer.from('A'), Buffer.from('BB'), Buffer.from('CCC')])
    assert.equal(t.root.toString('hex'), V0_ROOT)
  })
  await scenario('V0-③ v20.verifyProof 三叶每块折叠回 root', async () => {
    const blocks = [Buffer.from('A'), Buffer.from('BB'), Buffer.from('CCC')]
    const t = v20.buildTree(blocks)
    for (let i = 0; i < 3; i++) {
      assert.ok(v20.verifyProof({ totalBlocks: 3, blockIndex: i, blockBytes: blocks[i], proof: t.proofs[i], planRoot: t.root }))
    }
  })
  await scenario('V0-④ 左子索引约定（j=左子输入索引）产出 ≠ 正确 p1——D19 锚', async () => {
    const wrong = parent(3, 0, 2, V0_LEAF2, V0_LEAF2)
    assert.notEqual(wrong, V0_P1)
  })

  // ══ V1 六态码图（含 code2 补案） ══
  await scenario('V1-① §2 算例锚 [0,2,0,5]→[0x10,0x0A]→"EAo="（独立计算）', async () => {
    const bytes = indepPackCodes([0, 2, 0, 5])
    assert.deepEqual([...bytes], [0x10, 0x0A])
    assert.equal(bytes.toString('base64'), 'EAo=')
  })
  await scenario('V1-② v20.packCodes 与独立计算全等', async () => {
    const v20b64 = v20.packCodes([0, 2, 0, 5])
    assert.equal(v20b64, 'EAo=')
  })
  await scenario('V1-③ v20.readCodes 严格读回（长度/pad/保留码）', async () => {
    const codes = v20.readCodes('EAo=', 4)
    assert.deepEqual(codes, [0, 2, 0, 5])
    assert.throws(() => v20.readCodes(Buffer.alloc(3).toString('base64'), 4), /长度/)
    // 保留码：packCodes 在打包时拒（by design）——readCodes 读侧用手工构造字节
    const reserved = indepPackCodes([6, 0, 0, 0])
    assert.throws(() => v20.readCodes(reserved.toString('base64'), 4), /保留码/)
  })
  await scenario('V1-④ 六态含 code2（mapping 缺席 vs file 空串）+missing/null/array', async () => {
    assert.equal(v20.deriveCode(undefined, ''), 2, 'm=缺席 f=空串 → code2')
    assert.equal(v20.deriveCode(undefined, undefined), 0, 'm=缺席 f=缺席 → code0 等价')
    assert.equal(v20.deriveCode('', undefined), 1, "m=空串 f=缺席 → code1")
    assert.equal(v20.deriveCode(null, undefined), 3, 'm=null → code3')
    assert.equal(v20.deriveCode(0, undefined), 4, 'm=0 → code4')
    assert.equal(v20.deriveCode(false, undefined), 5, 'm=false → code5')
    assert.equal(v20.deriveCode([], undefined), 1, 'm=[] → S=""≠"undefined" → code1')
  })

  // ══ V2 长非字符串 canonical 碎片重组 ══
  await scenario('V2-① v20.fragment 字符串 >1KiB → canonical 切片含引号', async () => {
    const oid = 'x'.repeat(3 * KiB)
    const canonical = canonicalJsonBytes(oid)
    const frag = v20.fragment(oid)
    assert.ok(!frag.inline, '应触发碎片')
    const reassembled = Buffer.concat(frag.parts)
    assert.ok(reassembled.equals(canonical), `重组=${reassembled.length}B canonical=${canonical.length}B`)
    assert.equal(canonical[0], 0x22, '首=引号')
  })
  await scenario('V2-② v20.fragment 数组 → canonical 切片含方括号', async () => {
    const arr = Array.from({ length: 40 }, () => 'e'.repeat(100))
    const canonical = canonicalJsonBytes(arr)
    const frag = v20.fragment(arr)
    const reassembled = Buffer.concat(frag.parts)
    assert.ok(reassembled.equals(canonical))
    assert.equal(canonical[0], 0x5B, '首=[')
  })
  await scenario('V2-③ v20.fragment 对象 → canonical 切片含花括号', async () => {
    const obj = {}
    for (let i = 0; i < 30; i++) obj['k' + i] = 'o'.repeat(100)
    const canonical = canonicalJsonBytes(obj)
    const frag = v20.fragment(obj)
    const reassembled = Buffer.concat(frag.parts)
    assert.ok(reassembled.equals(canonical))
    assert.equal(canonical[0], 0x7B, '首={')
  })

  // ══ V3 近 4MiB 真包 → >1000 碎片 + seq 四位数 + 分页 ══
  await scenario('V3-① 近 4MiB 真包：validatePackage 零 problems + derive >1000 filefrag + seq 四位 + packBlocks ≤10KiB/≤48', async () => {
    const oidStr = 'F'.repeat(1800 * KiB)
    const rid = 'rp-v3'
    const body = { id: rid, revision: 0, deleted: false, attachments: [{ fileId: oidStr, order: 0 }] }
    const seg = Buffer.from(canonicalJsonBytes([body]))
    const attBytes = Buffer.alloc(16, 0x4C)
    const domains = {}
    for (const d of DOMAIN_ORDER) domains[d] = { status: 'omitted' }
    domains.reports = { status: 'present', recordCount: 1, pagingComplete: true, visibility: 'shared', fileIndex: 1 }
    const manifest = {
      formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: 'fam-x', packageKind: 'full', complete: true,
      scope: { includeShared: true, includePrivateOf: null }, scopeLabel: 'shared-only',
      domains,
      files: [
        { path: 'attachments/big.bin', kind: 'attachment', length: attBytes.length, sha256: sha256(attBytes), contentType: 'image/png', originalFileId: oidStr, chunkSha256: [sha256(attBytes)], referencedBy: [rid] },
        { path: 'records/reports.json', kind: 'domain-json', length: seg.length, sha256: sha256(seg), contentType: 'application/json', domain: 'reports' },
      ],
      records: { reports: [{ index: 0, id: rid, revision: 0, deleted: false, hash: sha256(Buffer.from(canonicalJsonBytes(body))) }] },
      reports: [{ reportId: rid, revision: 0, deleted: false, attachments: [{ order: 0, originalFileId: oidStr, fileIndex: 0 }] }],
      pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
    }
    const v = await buildValidate(manifest, [attBytes, seg])
    assert.ok(v.ok, `validatePackage: ${JSON.stringify((v.problems || []).slice(0, 1)).slice(0, 100)}`)
    const stream = v20.deriveV20Stream(v.manifest)
    const fragEntries = stream.entries.filter(e => e.entry.type === 'filefrag')
    assert.ok(fragEntries.length > 1000, `碎片=${fragEntries.length}`)
    const maxSeq = Math.max(...fragEntries.map(e => e.entry.seq))
    assert.ok(String(maxSeq).length >= 4, `maxSeq=${maxSeq}`)
    const blocks = v20.packBlocks(stream)
    assert.ok(blocks.length > 3, `blocks=${blocks.length}`)
    assert.ok(blocks.every(b => b.length <= 10 * KiB), `maxBlock=${Math.max(...blocks.map(b => b.length))}`)
  })

  // ══ V4 确定性：真包两次 derive+pack+root 全等（修正版） ══
  await scenario('V4-① 真包两次 deriveV20Stream+packBlocks+buildTree root 全等（确定性——修正版非同 buffer 复算）', async () => {
    const rid = 'rp-v4-det'
    const oid = 'D'.repeat(2 * KiB)
    const body = { id: rid, revision: 0, deleted: false, attachments: [{ fileId: oid, order: 0 }, { fileId: oid, order: 1 }] }
    const seg = Buffer.from(canonicalJsonBytes([body]))
    const attBytes = Buffer.alloc(8, 0x4D)
    const domains = {}
    for (const d of DOMAIN_ORDER) domains[d] = { status: 'omitted' }
    domains.reports = { status: 'present', recordCount: 1, pagingComplete: true, visibility: 'shared', fileIndex: 1 }
    const manifest = {
      formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: 'fam-x', packageKind: 'full', complete: true,
      scope: { includeShared: true, includePrivateOf: null }, scopeLabel: 'shared-only',
      domains,
      files: [
        { path: 'attachments/d.bin', kind: 'attachment', length: attBytes.length, sha256: sha256(attBytes), contentType: 'image/png', originalFileId: oid, chunkSha256: [sha256(attBytes)], referencedBy: [rid] },
        { path: 'records/reports.json', kind: 'domain-json', length: seg.length, sha256: sha256(seg), contentType: 'application/json', domain: 'reports' },
      ],
      records: { reports: [{ index: 0, id: rid, revision: 0, deleted: false, hash: sha256(Buffer.from(canonicalJsonBytes(body))) }] },
      reports: [{ reportId: rid, revision: 0, deleted: false, attachments: [{ order: 0, originalFileId: oid, fileIndex: 0 }, { order: 1, originalFileId: oid, fileIndex: 0 }] }],
      pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
    }
    const v = await buildValidate(manifest, [attBytes, seg])
    assert.ok(v.ok)
    const s1 = v20.deriveV20Stream(v.manifest)
    const b1 = v20.packBlocks(s1)
    const t1 = v20.buildTree(b1)
    const s2 = v20.deriveV20Stream(v.manifest)
    const b2 = v20.packBlocks(s2)
    const t2 = v20.buildTree(b2)
    assert.equal(s1.entries.length, s2.entries.length, `条目数 ${s1.entries.length} vs ${s2.entries.length}`)
    for (let i = 0; i < s1.entries.length; i++) {
      assert.ok(s1.entries[i].canonical.equals(s2.entries[i].canonical), `条目 ${i} canonical 不等`)
    }
    assert.equal(b1.length, b2.length)
    for (let i = 0; i < b1.length; i++) assert.ok(b1[i].equals(b2[i]), `块 ${i} 不等`)
    assert.ok(t1.root.equals(t2.root), `root 不等`)
  })

  // ══ V5 验证器负例：committed root+proof 拒篡改存储块 ══
  {
    const blocks = [
      Buffer.from(canonicalJsonBytes([{ type: 'record', domain: 'reports', index: 0, id: 'rp-v5', revision: 0, deleted: false, hash: '0'.repeat(64) }])),
      Buffer.from(canonicalJsonBytes([{ type: 'rmappart', reportIndex: 0, part: 0, startSlot: 0, items: [{ slot: 0, order: 0, fileIndex: 0 }], codes: v20.packCodes([0]) }])),
      Buffer.from(canonicalJsonBytes([{ type: 'refs', fileIndex: 0, part: 0, items: [{ order: 0, recIndex: 0 }] }])),
    ]
    const tree = v20.buildTree(blocks)
    const root = tree.root
    const proofs = tree.proofs

    await scenario('V5-① committed root+proof 接受合法块', async () => {
      for (let i = 0; i < 3; i++) assert.ok(v20.verifyProof({ totalBlocks: 3, blockIndex: i, blockBytes: blocks[i], proof: proofs[i], planRoot: root }))
    })
    await scenario('V5-② 篡改 codes（block1 rmappart codes 翻转）→ committed proof 拒', async () => {
      const tamperedBlock1 = Buffer.from(canonicalJsonBytes([{ type: 'rmappart', reportIndex: 0, part: 0, startSlot: 0, items: [{ slot: 0, order: 0, fileIndex: 0 }], codes: v20.packCodes([1]) }]))
      assert.throws(() => v20.verifyProof({ totalBlocks: 3, blockIndex: 1, blockBytes: tamperedBlock1, proof: proofs[1], planRoot: root }), /根折叠不匹配/)
    })
    await scenario('V5-③ 篡改 refs items 实际字段（recIndex→999）→ committed proof 拒', async () => {
      // 当前 refs 形状 items={order, recIndex}——变异实际存在的 recIndex 值
      const tamperedBlock2 = Buffer.from(canonicalJsonBytes([{ type: 'refs', fileIndex: 0, part: 0, items: [{ order: 0, recIndex: 999 }] }]))
      assert.throws(() => v20.verifyProof({ totalBlocks: 3, blockIndex: 2, blockBytes: tamperedBlock2, proof: proofs[2], planRoot: root }), /dup 层|根折叠不匹配/)
    })
    await scenario('V5-③b 篡改 rmappart items 实际字段（order→999）→ committed proof 拒', async () => {
      const tamperedBlock1b = Buffer.from(canonicalJsonBytes([{ type: 'rmappart', reportIndex: 0, part: 0, startSlot: 0, items: [{ slot: 0, order: 999, fileIndex: 0 }], codes: v20.packCodes([0]) }]))
      assert.throws(() => v20.verifyProof({ totalBlocks: 3, blockIndex: 1, blockBytes: tamperedBlock1b, proof: proofs[1], planRoot: root }), /根折叠不匹配/)
    })
    await scenario('V5-④ wrong index（block0 内容用 index1 提交）→ committed proof 拒', async () => {
      assert.throws(() => v20.verifyProof({ totalBlocks: 3, blockIndex: 1, blockBytes: blocks[0], proof: proofs[1], planRoot: root }), /根折叠不匹配/)
    })
    await scenario('V5-⑤ malformed proof（截断/非规范 base64/数组分串）→ 拒', async () => {
      assert.throws(() => v20.verifyProof({ totalBlocks: 3, blockIndex: 0, blockBytes: blocks[0], proof: proofs[0].slice(0, -4), planRoot: root }), /长度/)
      assert.throws(() => v20.verifyProof({ totalBlocks: 3, blockIndex: 0, blockBytes: blocks[0], proof: '!!', planRoot: root }), /base64|长度/)
      assert.throws(() => v20.verifyProof({ totalBlocks: 3, blockIndex: 0, blockBytes: blocks[0], proof: ['a', 'b'], planRoot: root }), /单一 base64/)
    })
    await scenario('V5-⑥ 零块 root=SHA256("mcpkg-empty")（独立验证）', async () => {
      const t = v20.buildTree([])
      assert.equal(t.root.toString('hex'), sha(Buffer.from('mcpkg-empty')))
    })
    await scenario('V5-⑦ invalid totalBlocks（0 / 2049 超 / 1.5 分数）→ 拒', async () => {
      // totalBlocks=0（空树应走 buildTree([]) 不走 verifyProof——传 0 须拒）
      assert.throws(() => v20.verifyProof({ totalBlocks: 0, blockIndex: 0, blockBytes: blocks[0], proof: proofs[0], planRoot: root }), /.*/, 'totalBlocks=0 须拒')
      // totalBlocks=2049（超 2048 硬上限——须拒或按实现拒路径折叠不匹配）
      assert.throws(() => v20.verifyProof({ totalBlocks: 2049, blockIndex: 0, blockBytes: blocks[0], proof: proofs[0], planRoot: root }), /.*/, 'totalBlocks=2049 须拒')
      // totalBlocks=1.5（分数——须拒）
      assert.throws(() => v20.verifyProof({ totalBlocks: 1.5, blockIndex: 0, blockBytes: blocks[0], proof: proofs[0], planRoot: root }), /.*/, 'totalBlocks=1.5 须拒')
    })
    await scenario('V5-⑧ invalid blockIndex（负 / 分数 / ≥totalBlocks）→ 拒', async () => {
      assert.throws(() => v20.verifyProof({ totalBlocks: 3, blockIndex: -1, blockBytes: blocks[0], proof: proofs[0], planRoot: root }), /.*/, 'blockIndex=-1 须拒')
      assert.throws(() => v20.verifyProof({ totalBlocks: 3, blockIndex: 1.5, blockBytes: blocks[0], proof: proofs[0], planRoot: root }), /.*/, 'blockIndex=1.5 须拒')
      assert.throws(() => v20.verifyProof({ totalBlocks: 3, blockIndex: 3, blockBytes: blocks[0], proof: proofs[0], planRoot: root }), /.*/, 'blockIndex=3 ≥ totalBlocks 须拒')
    })
  }

  // ══ V6 selfCheckVector ══
  await scenario('V6-① v20.selfCheckVector()（含 JSON 引号重释负例）', async () => {
    assert.ok(v20.selfCheckVector())
  })

  console.log(`\n${passed} 通过, ${failed.length} 失败`)
  if (failed.length) { console.log('失败项：\n - ' + failed.join('\n - ')); process.exit(1) }
})().catch(e => { console.error(e); process.exit(2) })
