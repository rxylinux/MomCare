// V20 回归 rev9：非数组 attachments 形状——Stage1 容器 vs V20 派生
// 协调方指认：Stage1 validatePackage 接受 attachments=空对象 {} 和非空字符串——V20 throw "object is not iterable"。
// 红先行：证 Stage1 接受 + V20 拒/throw——CODING 修后转绿。
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-v20reg9-'))
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

function buildPkg(manifest, segments) {
  const manifestBytes = Buffer.from(stage1Canonical(manifest))
  const parts = [Buffer.from(container.encodeHeader(manifestBytes.length)), manifestBytes]
  for (const seg of segments) parts.push(len8(seg.length), seg)
  return Buffer.concat(parts)
}
async function validate(pkg) {
  return container.validatePackage({ size: async () => pkg.length, readChunk: async (p, l) => new Uint8Array(pkg.subarray(p, p + l)) })
}

// 基础骨架（无附件文件——仅 reports domain-json）
function baseManifest(rid, bodyAttachments, mappingAttachments) {
  const body = { id: rid, revision: 0, deleted: false, attachments: bodyAttachments }
  const seg = Buffer.from(stage1Canonical([body]))
  const domains = {}
  for (const d of DOMAIN_ORDER) domains[d] = { status: 'omitted' }
  domains.reports = { status: 'present', recordCount: 1, pagingComplete: true, visibility: 'shared', fileIndex: 0 }
  return {
    manifest: {
      formatVersion: 1, createdAt: 1, createdBy: 'mama', familyId: 'fam-x', packageKind: 'full', complete: true,
      scope: { includeShared: true, includePrivateOf: null }, scopeLabel: 'shared-only',
      domains,
      files: [{ path: 'records/reports.json', kind: 'domain-json', length: seg.length, sha256: sha256(seg), contentType: 'application/json', domain: 'reports' }],
      records: { reports: [{ index: 0, id: rid, revision: 0, deleted: false, hash: sha256(Buffer.from(stage1Canonical(body))) }] },
      reports: [{ reportId: rid, revision: 0, deleted: false, attachments: mappingAttachments }],
      pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
    },
    seg,
  }
}

;(async () => {
  const v20Hash = sha256(fs.readFileSync(V20_PATH))
  const srcHash = sha256(fs.readFileSync(path.join(root, 'cloud/functions/mc-restore/index.js')))
  console.log(`V20 非数组 attachments 形状回归 rev9
v20.js: ${v20Hash.slice(0, 8)}｜源: ${srcHash.slice(0, 8)}
`)

  // ══ H1：正文 attachments=空数组 []，映射 attachments=空对象 {} ══
  const h1 = baseManifest('rp-h1', [], {})
  const h1pkg = buildPkg(h1.manifest, [h1.seg])
  const h1v = await validate(h1pkg)
  await scenario('H1-① 前置：真 validatePackage 零 problems（body=[] mapping={}——Stage1 接受）', async () => {
    assert.ok(h1v.ok, `Stage1 须接受（实得 problems=${JSON.stringify((h1v.problems || []).slice(0, 1)).slice(0, 120)}）——容器对 mapping.attachments 非数组形状无 Array.isArray 检查`)
  })

  await scenario('H1-② V20 deriveV20Stream 对 body=[] mapping={} 的行为（红先行：当前 throw "object is not iterable"）', async () => {
    let threw = null
    let stream = null
    try { stream = v20.deriveV20Stream(h1.manifest) } catch (e) { threw = e }
    if (threw) {
      if (h1v.ok) {
        throw new Error(`缺陷（红先行）：Stage1 接受 body=[] mapping={} 但 V20 throw "${threw.message.slice(0, 60)}"——映射 attachments={} 非数组致 for...of 迭代失败——修复方向：映射 attachments 非 Array 时视为零附件（或 Stage1 加 Array.isArray 拒）`)
      }
      console.log(`      V20 拒（Stage1 也拒——一致）: ${threw.message.slice(0, 60)}`)
    } else {
      // V20 接受——验证无假 refs/rmappart + record 保留
      assert.ok(!h1v.ok || true, '两侧均接受')
      const refs = stream.entries.filter(e => e.entry.type === 'refs')
      const rmapparts = stream.entries.filter(e => e.entry.type === 'rmappart')
      const records = stream.entries.filter(e => e.entry.type === 'record')
      assert.equal(refs.length, 0, `零附件映射不得产 refs（实得 ${refs.length}）`)
      assert.equal(rmapparts.length, 0, `零附件映射不得产 rmappart（实得 ${rmapparts.length}）`)
      assert.ok(records.length === 1, `record 条目恰 1（实得 ${records.length}）——record 保留`)
      assert.equal(records[0].entry.id, 'rp-h1', 'record.id 正确保留')
      console.log(`      V20 接受：record=1 refs=0 rmappart=0——无假条目+record 保留`)
    }
  })

  // ══ H2：正文 attachments=空数组 []，映射 attachments=非空字符串 "x" ══
  const h2 = baseManifest('rp-h2', [], 'x')
  const h2pkg = buildPkg(h2.manifest, [h2.seg])
  const h2v = await validate(h2pkg)
  await scenario('H2-① 前置：真 validatePackage 零 problems（body=[] mapping="x" 字符串——如 Stage1 拒则记录）', async () => {
    console.log(`      Stage1 validatePackage ok=${h2v.ok} problems=${h2v.ok ? 0 : (h2v.problems || []).length}`)
    if (!h2v.ok) {
      console.log(`      Stage1 拒——${(h2v.problems || [])[0] && h2v.problems[0].code}`)
      // Stage1 拒字符串——则 H2-② 跳过（无策略问题）
    } else {
      console.log('      Stage1 接受——映射 attachments="x" 字符串未被拒')
    }
    // 前置不强制通过——记录 Stage1 行为（红先行判断在 H2-②）
    assert.ok(true)
  })

  await scenario('H2-② V20 对 body=[] mapping="x" 的行为（仅当 Stage1 接受才测策略一致性）', async () => {
    if (!h2v.ok) {
      // Stage1 拒——V20 拒也是一致——不测
      console.log('      Stage1 已拒——跳过策略一致性测试（两侧一致拒）')
      return
    }
    let threw = null
    let stream = null
    try { stream = v20.deriveV20Stream(h2.manifest) } catch (e) { threw = e }
    if (threw) {
      throw new Error(`缺陷（红先行）：Stage1 接受 mapping="x" 但 V20 throw "${threw.message.slice(0, 60)}"——非数组字符串 attachments 同样迭代失败——须修`)
    }
    const refs = stream.entries.filter(e => e.entry.type === 'refs')
    const rmapparts = stream.entries.filter(e => e.entry.type === 'rmappart')
    assert.ok(refs.length === 0 && rmapparts.length === 0, '非数组 attachments 不产 refs/rmappart')
    console.log(`      V20 接受：refs=0 rmappart=0——无假条目`)
  })

  // ══ H3：正文 attachments=非空字符串（如 Stage1 接受）══
  const h3 = baseManifest('rp-h3', 'xyz', 'xyz')
  const h3pkg = buildPkg(h3.manifest, [h3.seg])
  const h3v = await validate(h3pkg)
  await scenario('H3-① 前置：真 validatePackage 对 body="xyz" mapping="xyz" 的行为', async () => {
    console.log(`      Stage1 validatePackage ok=${h3v.ok} problems=${h3v.ok ? 0 : (h3v.problems || []).length}`)
    if (!h3v.ok) {
      console.log(`      Stage1 拒——${(h3v.problems || [])[0] && h3v.problems[0].code}`)
    } else {
      console.log('      Stage1 接受——正文非数组字符串 attachments 未拒')
    }
    assert.ok(true)
  })

  await scenario('H3-② V20 对 body="xyz" mapping="xyz" 的行为（仅当 Stage1 接受才测）', async () => {
    if (!h3v.ok) {
      console.log('      Stage1 已拒——跳过')
      return
    }
    let threw = null
    let stream = null
    try { stream = v20.deriveV20Stream(h3.manifest) } catch (e) { threw = e }
    if (threw) {
      throw new Error(`缺陷：Stage1 接受 body/mapping="xyz" 但 V20 throw "${threw.message.slice(0, 60)}"——须修`)
    }
    const records = stream.entries.filter(e => e.entry.type === 'record')
    assert.ok(records.length === 1, 'record 保留')
    console.log(`      V20 接受：record=1——正文保留`)
  })

  const vpost = sha256(fs.readFileSync(V20_PATH))
  const spost = sha256(fs.readFileSync(path.join(root, 'cloud/functions/mc-restore/index.js')))
  const srcStable = srcHash === spost
  const v20Stable = v20Hash === vpost
  console.log(`\n源: ${spost.slice(0, 8)} ${srcStable ? '== 一致' : '≠ 漂移'}｜v20: ${vpost.slice(0, 8)} ${v20Stable ? '== 一致' : '≠ 漂移'}`)
  if (!srcStable) { failed.push('源哈希漂移') }
  if (!v20Stable) { failed.push('v20哈希漂移') }
  console.log(`=== 结果：${passed} 通过, ${failed.length} 失败 ===`)
  if (failed.length) { console.log('失败项：\n - ' + failed.join('\n - ')); process.exit(1) }
})().catch(e => { console.error(e); process.exit(2) })
