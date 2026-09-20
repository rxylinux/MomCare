// V20 回归 rev5：双短字段合并超限——per-field 1024 触发阈遗漏的 file core 形状
// 协调方指认：path <1KiB + originalFileId <1KiB 各自不触发碎片化，但合并 file core >2KiB → push 拒。
// 修复方向：core 尺寸驱动的确定性拆分（先 chunkSha→再 orig→再 path 直至 core ≤2KiB——碎片字段从 core 移除改 Ref）。
// 红先行：当前 v20 @33314665 在该形状 throw → CODING 修复后转绿。
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-v20reg5-'))
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')

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

// 构造双短字段合并超限包（path 902B + oid 900B 各 <1KiB 但 core >2KiB）
function buildDualShortPackage() {
  const rid = 'rp-dual-short'
  const longPath = 'attachments/' + 'p'.repeat(890)   // 902B <1024
  const longOid = 'o'.repeat(900)                       // 900B <1024
  const attBytes = crypto.randomBytes(4 * 256 * 1024 + 100) // >4×256KiB → 5 blocks, 5 real chunk hashes
  const chunkSha256 = Array.from({ length: 5 }, (_, i) => sha256(attBytes.subarray(i * 256 * 1024, Math.min((i + 1) * 256 * 1024, attBytes.length))))
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
      { path: longPath, kind: 'attachment', length: attBytes.length, sha256: sha256(attBytes), contentType: 'image/png', originalFileId: longOid, chunkSha256, referencedBy: [rid] },
      { path: 'records/reports.json', kind: 'domain-json', length: seg.length, sha256: sha256(seg), contentType: 'application/json', domain: 'reports' },
    ],
    records: { reports: [{ index: 0, id: rid, revision: 0, deleted: false, hash: sha256(Buffer.from(stage1Canonical(body))) }] },
    reports: [{ reportId: rid, revision: 0, deleted: false, attachments: [{ order: 0, originalFileId: longOid, fileIndex: 0 }] }],
    pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
  }
  const manifestBytes = Buffer.from(stage1Canonical(manifest))
  const pkg = Buffer.concat([Buffer.from(container.encodeHeader(manifestBytes.length)), manifestBytes, len8(attBytes.length), attBytes, len8(seg.length), seg])
  return { manifest, pkg, rid, longPath, longOid }
}

;(async () => {
  const v20Hash = sha256(fs.readFileSync(V20_PATH))
  const srcHash = sha256(fs.readFileSync(path.join(root, 'cloud/functions/mc-restore/index.js')))
  console.log(`V20 双短字段合并超限回归 rev5
v20.js: ${v20Hash.slice(0, 8)}｜源: ${srcHash.slice(0, 8)}
`)

  const pkgData = buildDualShortPackage()

  // ① Stage1 合法性
  const v = await container.validatePackage({ size: async () => pkgData.pkg.length, readChunk: async (p, l) => new Uint8Array(pkgData.pkg.subarray(p, p + l)) })
  await scenario('E1-① 双短字段包（path 902B+oid 900B 各 <1KiB——core 合计 >2KiB）真 validatePackage 零 problems', async () => {
    assert.ok(v.ok, JSON.stringify((v.problems || []).slice(0, 2)).slice(0, 200))
  })

  // ② 确认 core 超限
  await scenario('E1-② file core canonical 字节 >2048B（用真 manifest file entry 独立计算）', async () => {
    const f = v.manifest.files[0]
    const core = { type: 'file', fileIndex: 0, sha256: f.sha256, length: f.length, contentType: f.contentType, path: f.path, kind: 'attachment', originalFileId: f.originalFileId, chunkSha256: f.chunkSha256 }
    const bytes = Buffer.from(stage1Canonical(core))
    console.log(`      core=${bytes.length}B path=${f.path.length}B oid=${f.originalFileId.length}B chunks=${f.chunkSha256.length}`)
    assert.ok(bytes.length > 2048, `core=${bytes.length}B >2048B`)
    assert.ok(f.path.length < 1024, `path=${f.path.length}B <1024`)
    assert.ok(f.originalFileId.length < 1024, `oid=${f.originalFileId.length}B <1024`)
  })

  // ③ 当前 v20 行为（红先行：预计 throw——per-field 阈值不触发）
  await scenario('E1-③ v20.deriveV20Stream 对该形状的行为（红先行：per-field 阈值遗漏→push 拒）', async () => {
    let threw = null
    try {
      const stream = v20.deriveV20Stream(v.manifest)
      // 若不 throw（已修复）——验证 core ≤2KiB 且碎片重建正确
      const fileEntry = stream.entries.find(e => e.entry.type === 'file')
      assert.ok(fileEntry, 'file 条目存在')
      assert.ok(fileEntry.canonical.length <= 2048, `core=${fileEntry.canonical.length}B ≤2048B（修复后）`)
      // 验证碎片重建
      const oidFrags = stream.entries.filter(e => e.entry.type === 'filefrag' && e.entry.field === 'originalFileId')
      const pathFrags = stream.entries.filter(e => e.entry.type === 'filefrag' && e.entry.field === 'path')
      const oidCanonical = stage1Canonical(pkgData.longOid)
      if (oidFrags.length > 0) {
        const reassembled = Buffer.concat(oidFrags.sort((a, b) => a.entry.seq - b.entry.seq).map(f => Buffer.from(f.entry.data, 'base64')))
        assert.ok(reassembled.equals(Buffer.from(oidCanonical)), `oid 重组=${reassembled.length}B canonical=${oidCanonical.length}B`)
      }
      const pathCanonical = stage1Canonical(pkgData.longPath)
      if (pathFrags.length > 0) {
        const reassembled = Buffer.concat(pathFrags.sort((a, b) => a.entry.seq - b.entry.seq).map(f => Buffer.from(f.entry.data, 'base64')))
        assert.ok(reassembled.equals(Buffer.from(pathCanonical)), `path 重组=${reassembled.length}B`)
      }
      console.log('      已修复：core ≤2KiB + 碎片重建全等')
    } catch (e) { threw = e }
    if (threw) {
      // 红先行——缺陷存在
      throw new Error(`缺陷待修（红先行）：v20.deriveV20Stream throw "${threw.message.slice(0, 60)}"——per-field 1024B 阈值不触发但合并 core 超 2KiB——修复方向：core 尺寸驱动确定性拆分（先 chunkSha→orig→path 直至 ≤2KiB）`)
    }
  })

  console.log(`\n${passed} 通过, ${failed.length} 失败`)
  if (failed.length) { console.log('失败项：\n - ' + failed.join('\n - ')); process.exit(1) }
})().catch(e => { console.error(e); process.exit(2) })
