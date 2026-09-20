// V20 回归 rev8：重复空报告映射——Stage1 容器 vs V20 派生策略一致性
// 协调方指认：Stage1 validatePackage 接受同一 reportId 多条零附件映射；V20 拒绝重复 reportId。
// 红先行：证 Stage1 接受 + V20 拒——CODING 须选边（Stage1 拒或 V20 容）并一致。
// 变体：先非空映射再重复空映射。
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-v20reg8-'))
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

function buildPkg(manifest, segments) {
  const manifestBytes = Buffer.from(stage1Canonical(manifest))
  const parts = [Buffer.from(container.encodeHeader(manifestBytes.length)), manifestBytes]
  for (const seg of segments) parts.push(len8(seg.length), seg)
  return Buffer.concat(parts)
}
async function validate(pkg) {
  return container.validatePackage({ size: async () => pkg.length, readChunk: async (p, l) => new Uint8Array(pkg.subarray(p, p + l)) })
}

// 场景 G1：同一 reportId 两条零附件映射——无附件文件（协调方修正：前版含孤儿附件致 Stage1 拒非重复）
function buildDuplicateEmpty() {
  const rid = 'rp-dup-empty'
  const body = { id: rid, revision: 0, deleted: false, attachments: [] }
  const seg = Buffer.from(stage1Canonical([body]))
  const domains = {}
  for (const d of DOMAIN_ORDER) domains[d] = { status: 'omitted' }
  domains.reports = { status: 'present', recordCount: 1, pagingComplete: true, visibility: 'shared', fileIndex: 0 }
  const manifest = {
    formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: 'fam-x', packageKind: 'full', complete: true,
    scope: { includeShared: true, includePrivateOf: null }, scopeLabel: 'shared-only',
    domains,
    files: [{ path: 'records/reports.json', kind: 'domain-json', length: seg.length, sha256: sha256(seg), contentType: 'application/json', domain: 'reports' }],
    records: { reports: [{ index: 0, id: rid, revision: 0, deleted: false, hash: sha256(Buffer.from(stage1Canonical(body))) }] },
    reports: [
      { reportId: rid, revision: 0, deleted: false, attachments: [] },
      { reportId: rid, revision: 0, deleted: false, attachments: [] },
    ],
    pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
  }
  return { manifest, pkg: buildPkg(manifest, [seg]), rid }
}

// 场景 G2：先非空映射再重复空映射（同 reportId 一条有附件一条零附件）
function buildNonEmptyThenDupEmpty() {
  const rid = 'rp-dup-mixed'
  const attOid = 'g2-oid'
  const body = { id: rid, revision: 0, deleted: false, attachments: [{ fileId: attOid, order: 0 }] }
  const seg = Buffer.from(stage1Canonical([body]))
  const attBytes = Buffer.alloc(8, 0x54)
  const domains = {}
  for (const d of DOMAIN_ORDER) domains[d] = { status: 'omitted' }
  domains.reports = { status: 'present', recordCount: 1, pagingComplete: true, visibility: 'shared', fileIndex: 1 }
  const manifest = {
    formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: 'fam-x', packageKind: 'full', complete: true,
    scope: { includeShared: true, includePrivateOf: null }, scopeLabel: 'shared-only',
    domains,
    files: [
      { path: 'attachments/g2.bin', kind: 'attachment', length: attBytes.length, sha256: sha256(attBytes), contentType: 'image/png', originalFileId: attOid, chunkSha256: [sha256(attBytes)], referencedBy: [rid] },
      { path: 'records/reports.json', kind: 'domain-json', length: seg.length, sha256: sha256(seg), contentType: 'application/json', domain: 'reports' },
    ],
    records: { reports: [{ index: 0, id: rid, revision: 0, deleted: false, hash: sha256(Buffer.from(stage1Canonical(body))) }] },
    // 第一条有附件映射 + 第二条同 reportId 零附件
    reports: [
      { reportId: rid, revision: 0, deleted: false, attachments: [{ order: 0, originalFileId: attOid, fileIndex: 0 }] },
      { reportId: rid, revision: 0, deleted: false, attachments: [] },
    ],
    pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
  }
  return { manifest, pkg: buildPkg(manifest, [attBytes, seg]), rid }
}

;(async () => {
  const v20Hash = sha256(fs.readFileSync(V20_PATH))
  const srcHash = sha256(fs.readFileSync(path.join(root, 'cloud/functions/mc-restore/index.js')))
  console.log(`V20 重复空报告映射回归 rev8
v20.js: ${v20Hash.slice(0, 8)}｜源: ${srcHash.slice(0, 8)}
`)

  // ══ G1：双零附件同 reportId（无附件文件——协调方修正夹具） ══
  const g1 = buildDuplicateEmpty()
  const g1v = await validate(g1.pkg)
  await scenario('G1-① 前置：真 validatePackage 零 problems（Stage1 接受双零附件同 reportId——无孤儿附件干扰）', async () => {
    assert.ok(g1v.ok, `Stage1 须接受（实得 problems=${JSON.stringify((g1v.problems || []).slice(0, 1)).slice(0, 120)}）——无附件文件故无 referencedBy 闭包约束——重复 reportId 零附件纯重复不被 Stage1 拒`)
  })

  await scenario('G1-② V20 deriveV20Stream 对双零附件同 reportId 的行为（红先行：Stage1 接受但 V20 拒——策略不一致）', async () => {
    let threw = null
    let stream = null
    try { stream = v20.deriveV20Stream(g1.manifest) } catch (e) { threw = e }
    if (threw) {
      if (g1v.ok) {
        throw new Error(`策略不一致（红先行）：Stage1 validatePackage 接受双零附件同 reportId（无孤儿附件），但 V20 deriveV20Stream 拒 "${threw.message.slice(0, 50)}"——CODING 须选边并统一：①Stage1 拒重复 reportId 或 ②V20 容零附件重复（幂等去重）`)
      }
      // Stage1 也拒——一致
      console.log(`      V20 拒（Stage1 也拒——一致）: ${threw.message.slice(0, 60)}`)
    } else {
      if (!g1v.ok) {
        throw new Error(`策略不一致（反向）：Stage1 拒但 V20 接受——须统一`)
      }
      console.log(`      两侧均接受（V20 条目=${stream.count}）——一致`)
    }
  })

  // ══ G2：非空+重复空同 reportId ══
  const g2 = buildNonEmptyThenDupEmpty()
  const g2v = await validate(g2.pkg)
  await scenario('G2-① Stage1 validatePackage 对非空+重复空同 reportId 的行为', async () => {
    console.log(`      Stage1 validatePackage ok=${g2v.ok} problems=${g2v.ok ? 0 : (g2v.problems || []).length}`)
    if (g2v.ok) {
      console.log('      Stage1 接受——非空+零附件同 reportId 未拒')
    } else {
      console.log(`      Stage1 拒——${(g2v.problems || [])[0] && g2v.problems[0].code}`)
    }
    assert.ok(true, '记录 Stage1 行为')
  })

  await scenario('G2-② V20 deriveV20Stream 对非空+重复空同 reportId 的行为', async () => {
    let threw = null
    let stream = null
    try { stream = v20.deriveV20Stream(g2.manifest) } catch (e) { threw = e }
    if (threw) {
      console.log(`      V20 拒：${threw.message.slice(0, 60)}`)
      if (g2v.ok) {
        throw new Error(`策略不一致（红先行）：Stage1 接受非空+空同 reportId，V20 拒——须统一`)
      }
      console.log('      Stage1 也拒——一致')
    } else {
      console.log(`      V20 接受：条目=${stream.count}`)
      if (!g2v.ok) {
        throw new Error(`策略不一致（反向）：Stage1 拒但 V20 接受`)
      }
      // 验证不丢失附件映射（非空条目须保留）
      const refsEntries = stream.entries.filter(e => e.entry.type === 'refs')
      const rmapparts = stream.entries.filter(e => e.entry.type === 'rmappart')
      assert.ok(rmapparts.length >= 1, `rmappart ≥1（非空映射保留——${rmapparts.length}）`)
      console.log(`      两侧均接受+非空映射保留（refs=${refsEntries.length} rmappart=${rmapparts.length}）——一致`)
    }
  })

  console.log(`\n${passed} 通过, ${failed.length} 失败`)
  if (failed.length) { console.log('失败项：\n - ' + failed.join('\n - ')); process.exit(1) }
})().catch(e => { console.error(e); process.exit(2) })
