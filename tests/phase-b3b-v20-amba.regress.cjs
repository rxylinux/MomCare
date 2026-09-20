// V20 回归 rev6：双报告 AB/BA 非同序——refs recIndex 按非位置 ID 绑定
// 协调方指派：records.reports AB 序 + manifest.reports BA 序——Stage1 validatePackage 按 reportId 匹配故合法；
// V20 refs items 含 recIndex——须解析到正确的 records.reports 位置（非 manifest.reports 数组位置）。
// 一报告 rid 够长触发 idfrag（idRef 短承诺）。
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-v20reg6-'))
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')
const KiB = 1024

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

// ── 构造 AB/BA 非同序包 ──
// records.reports = [A, B]（AB 序）
// manifest.reports = [B, A]（BA 序——Stage1 合法：validatePackage 按 reportId 配对）
// A 的 id 是巨 id（2.5KiB → idRef 短承诺+idfrag）；B 的 id 短
// 每报告 1 附件（各引用不同 fileIndex）
function buildAbBaPackage() {
  const ridA = 'A'.repeat(2500) // 巨 id → idfrag
  const ridB = 'rp-ba-b'         // 短 id
  const attBytes = crypto.randomBytes(32)

  // bodies（records.reports 序：AB）
  const bodyA = { id: ridA, revision: 0, deleted: false, attachments: [{ fileId: 'oidA', order: 0 }] }
  const bodyB = { id: ridB, revision: 0, deleted: false, attachments: [{ fileId: 'oidB', order: 0 }] }
  const seg = Buffer.from(stage1Canonical([bodyA, bodyB]))

  const domains = {}
  for (const d of DOMAIN_ORDER) domains[d] = { status: 'omitted' }
  domains.reports = { status: 'present', recordCount: 2, pagingComplete: true, visibility: 'shared', fileIndex: 2 }

  const manifest = {
    formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: 'fam-x', packageKind: 'full', complete: true,
    scope: { includeShared: true, includePrivateOf: null }, scopeLabel: 'shared-only',
    domains,
    files: [
      { path: 'attachments/attA.bin', kind: 'attachment', length: attBytes.length, sha256: sha256(attBytes), contentType: 'image/png', originalFileId: 'oidA', chunkSha256: [sha256(attBytes)], referencedBy: [ridA] },
      { path: 'attachments/attB.bin', kind: 'attachment', length: 0, sha256: sha256(Buffer.alloc(0)), contentType: 'image/png', originalFileId: 'oidB', referencedBy: [ridB] },
      { path: 'records/reports.json', kind: 'domain-json', length: seg.length, sha256: sha256(seg), contentType: 'application/json', domain: 'reports' },
    ],
    // records.reports = AB 序
    records: { reports: [
      { index: 0, id: ridA, revision: 0, deleted: false, hash: sha256(Buffer.from(stage1Canonical(bodyA))) },
      { index: 1, id: ridB, revision: 0, deleted: false, hash: sha256(Buffer.from(stage1Canonical(bodyB))) },
    ] },
    // manifest.reports = BA 序（与 records 不同序——Stage1 按 reportId 匹配合法）
    reports: [
      { reportId: ridB, revision: 0, deleted: false, attachments: [{ order: 0, originalFileId: 'oidB', fileIndex: 1 }] },
      { reportId: ridA, revision: 0, deleted: false, attachments: [{ order: 0, originalFileId: 'oidA', fileIndex: 0 }] },
    ],
    pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
  }
  const manifestBytes = Buffer.from(stage1Canonical(manifest))
  const pkg = Buffer.concat([Buffer.from(container.encodeHeader(manifestBytes.length)), manifestBytes, len8(attBytes.length), attBytes, len8(0), Buffer.alloc(0), len8(seg.length), seg])
  return { manifest, pkg, ridA, ridB, ridALen: ridA.length, ridBLen: ridB.length }
}

;(async () => {
  const v20Hash = sha256(fs.readFileSync(V20_PATH))
  const srcHash = sha256(fs.readFileSync(path.join(root, 'cloud/functions/mc-restore/index.js')))
  console.log(`V20 AB/BA 非同序回归 rev6
v20.js: ${v20Hash.slice(0, 8)}｜源: ${srcHash.slice(0, 8)}
`)

  const pkgData = buildAbBaPackage()

  // ① Stage1 合法性（validatePackage 按 reportId 匹配故 AB/BA 不同序合法）
  const v = await container.validatePackage({ size: async () => pkgData.pkg.length, readChunk: async (p, l) => new Uint8Array(pkgData.pkg.subarray(p, p + l)) })
  await scenario('F1-① AB/BA 非同序包（records AB + reports BA）真 validatePackage 零 problems', async () => {
    assert.ok(v.ok, JSON.stringify((v.problems || []).slice(0, 3)).slice(0, 300))
  })

  if (!v.ok) { console.log('包无效——后续跳过'); process.exit(1) }

  const stream = v20.deriveV20Stream(v.manifest)

  // ② record 条目按 DOMAIN_ORDER + records.reports 数组位置（非 manifest.reports 位置）
  await scenario('F1-② record 条目 index 按 records.reports 数组位置（A=index 0, B=index 1——非 manifest.reports BA 序）', async () => {
    const recordEntries = stream.entries.filter(e => e.entry.type === 'record')
    assert.equal(recordEntries.length, 2, `record 条目=${recordEntries.length}`)
    // records.reports[0] = A（巨 id）→ record index=0；records.reports[1] = B → record index=1
    const rec0 = recordEntries.find(e => e.entry.index === 0)
    const rec1 = recordEntries.find(e => e.entry.index === 1)
    assert.ok(rec0, 'index=0 存在')
    assert.ok(rec1, 'index=1 存在')
    // rec0 应是 A（巨 id → idRef 短承诺——无内联 id）
    assert.ok(rec0.entry.idRef !== undefined, 'rec0（A）应含 idRef（巨 id >1KiB）')
    assert.equal(rec0.entry.id, undefined, 'rec0（A）不得内联 id')
    assert.equal(rec0.entry.idRef.len, Buffer.from(stage1Canonical(pkgData.ridA)).length, `rec0.idRef.len=${rec0.entry.idRef.len}`)
    // rec1 应是 B（短 id → 内联）
    assert.equal(rec1.entry.id, pkgData.ridB, `rec1.id="${rec1.entry.id}" 应="${pkgData.ridB}"`)
    assert.equal(rec1.entry.idRef, undefined, 'rec1（B 短 id）不得有 idRef')
  })

  // ③ idfrag 归属 A（records.reports[0]）
  await scenario('F1-③ idfrag 分片归属 A（domain=reports index=0——records.reports 位置非 manifest.reports 位置）', async () => {
    const idfrags = stream.entries.filter(e => e.entry.type === 'idfrag')
    assert.ok(idfrags.length >= 1, `idfrag=${idfrags.length}`)
    for (const f of idfrags) {
      assert.equal(f.entry.domain, 'reports', `idfrag domain=${f.entry.domain}`)
      assert.equal(f.entry.index, 0, `idfrag index=${f.entry.index}（A 在 records.reports[0]）`)
    }
    // idfrag 重组 = A 的 canonical id 字节
    const idCanonical = stage1Canonical(pkgData.ridA)
    const sorted = idfrags.sort((a, b) => a.entry.seq - b.entry.seq)
    const reassembled = Buffer.concat(sorted.map(f => Buffer.from(f.entry.data, 'base64')))
    assert.ok(reassembled.equals(Buffer.from(idCanonical)), `重组=${reassembled.length}B canonical=${idCanonical.length}B`)
  })

  // ④ refs items recIndex 按 reportId→records.reports 位置解析（非 manifest.reports 数组位置）
  await scenario('F1-④ refs items recIndex 按 id 绑定（A→0 B→1——非 manifest.reports BA 序位置 B→0 A→1）', async () => {
    const refsEntries = stream.entries.filter(e => e.entry.type === 'refs')
    assert.ok(refsEntries.length >= 2, `refs 条目=${refsEntries.length}（≥2——两个附件各至少 1 part）`)
    // 每个 refs part 的 items 含 recIndex
    const allItems = refsEntries.flatMap(r => r.entry.items)
    assert.ok(allItems.length >= 2, `总 refs items=${allItems.length}`)
    // A 的附件（fileIndex=0）的 refs item 应含 recIndex=0（A 是 records.reports[0]）
    const file0Refs = refsEntries.filter(r => r.entry.fileIndex === 0).flatMap(r => r.entry.items)
    const file1Refs = refsEntries.filter(r => r.entry.fileIndex === 1).flatMap(r => r.entry.items)
    assert.ok(file0Refs.length >= 1, `file0 refs items=${file0Refs.length}`)
    assert.ok(file1Refs.length >= 1, `file1 refs items=${file1Refs.length}`)
    // 验证 recIndex 正确绑定
    for (const it of file0Refs) {
      assert.equal(it.recIndex, 0, `file0（A 附件）recIndex=${it.recIndex} 应=0（A=records.reports[0]）——非 manifest.reports[1]`)
    }
    for (const it of file1Refs) {
      assert.equal(it.recIndex, 1, `file1（B 附件）recIndex=${it.recIndex} 应=1（B=records.reports[1]）——非 manifest.reports[0]`)
    }
  })

  // ⑤ rmappart reportIndex 也按 records.reports 位置（非 manifest.reports 位置）
  await scenario('F1-⑤ rmappart recIndex 精确按 records.reports 位置（A→0 B→1）+ 升序输出 + 每报告的 fileIndex 附件一致', async () => {
    const rmapparts = stream.entries.filter(e => e.entry.type === 'rmappart')
    assert.ok(rmapparts.length >= 2, `rmappart=${rmapparts.length}`)
    // v20 按 recIndex 升序输出——第一个 recIndex=0（A），第二个 recIndex=1（B）
    const byRec = {}
    for (const rm of rmapparts) {
      const ri = rm.entry.recIndex
      assert.ok(ri === 0 || ri === 1, `recIndex=${ri} 须 0 或 1`)
      if (!byRec[ri]) byRec[ri] = []
      byRec[ri].push(rm)
    }
    // A（recIndex=0）的 rmappart items 含 fileIndex=0（A 的附件）
    assert.ok(byRec[0] && byRec[0].length >= 1, 'A（recIndex=0）至少 1 part')
    for (const rm of byRec[0]) {
      assert.equal(rm.entry.recIndex, 0, `A 的 rmappart recIndex 须精确=0（实得 ${rm.entry.recIndex}）`)
      for (const it of rm.entry.items) {
        assert.equal(it.fileIndex, 0, `A 的 rmappart items fileIndex=${it.fileIndex} 须=0（A 附件在 fileIndex 0）`)
      }
    }
    // B（recIndex=1）的 rmappart items 含 fileIndex=1（B 的附件）
    assert.ok(byRec[1] && byRec[1].length >= 1, 'B（recIndex=1）至少 1 part')
    for (const rm of byRec[1]) {
      assert.equal(rm.entry.recIndex, 1, `B 的 rmappart recIndex 须精确=1（实得 ${rm.entry.recIndex}）`)
      for (const it of rm.entry.items) {
        assert.equal(it.fileIndex, 1, `B 的 rmappart items fileIndex=${it.fileIndex} 须=1（B 附件在 fileIndex 1）`)
      }
    }
    // 输出序：recIndex 升序（A 先 B 后）
    const seq = rmapparts.map(rm => rm.entry.recIndex)
    const sorted = [...seq].sort((a, b) => a - b)
    assert.deepEqual(seq, sorted, `rmappart 输出按 recIndex 升序（实得 [${seq.join(',')}]）`)
  })

  console.log(`\n${passed} 通过, ${failed.length} 失败`)
  if (failed.length) { console.log('失败项：\n - ' + failed.join('\n - ')); process.exit(1) }
})().catch(e => { console.error(e); process.exit(2) })
