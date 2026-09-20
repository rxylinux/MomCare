// V20 回归：own "__proto__" 键与 D25-r2 尾随有效空 no-op（D25 独立）rev3
// 裁定溯源（协调方 2026-09-20，docs PHASE_B3B_STAGE2_CODE_REVIEW·D25-r2）：
//   ①Stage1 取**首条** report 映射+**有效附件投影**（Array.isArray?x:[]）；②**尾随有效空映射=no-op
//   ——即使携带额外未知 own "__proto__" 键**；③raw manifest 字节仍受摘要绑定（business 用首目）。
// 故 rev2 的 P1/P2"须拒 D25②"期望与真 Stage1 兼容性冲突——rev3 修订为**接受**（首目有效映射不变
// +零 refs/rmappart+raw canonical 保持 distinct——no-op 是政策选择非 canonical 坍缩）。
// S0 修订（doc=2b1605ec S0 作用域）：同序双非空重复 Stage1-invalid（duplicate-report-order）——
// V20 须拒**含字节等价**（"任意形全等去重"措辞作废）。rev2 的 S0-②"须①去重接受"随之修订。
// 全部 rev2 场景保留改写——零静默删除；SIM 旧普通 {} 机制模拟保留（no-op 政策下 distinct 保持
// 仍需机制保证——旧机制坍缩时 no-op 与假去重不可区分）。
// 执行史：rev1（未跑即废）；rev2 首跑 c4dd6824=12/2→034f6b35=11/3（D25-r2 回归抓捕+S0 政策腿）；
// rev3 按裁定修订。范围：container.validatePackage（容器层）+纯模块 deriveV20Stream/canonical——
// 不经 handler，不声称 handler 接受。
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-v20proto-'))
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
// 从包字节取 wire manifest（头 24B 定位）——JSON.parse 复现线上 own "__proto__" 键路径
function wireManifest(pkg, manifestBytes) {
  const off = pkg.indexOf(manifestBytes)
  assert.ok(off === container.HEADER_LEN, `manifest 定位 ${off} ≠ 头部 ${container.HEADER_LEN}B`)
  return JSON.parse(pkg.subarray(off, off + manifestBytes.length).toString('utf8'))
}

const RID = 'rp-proto-key'
const OID = 'pk-oid'

// 零附件形——真包可达（无 (reportId,order) 对不触 duplicate-report-order；无附件文件避孤儿拒）
function buildZeroAttPkg(mode) { // 'control' | 'presence' | 'value'
  const plain = () => ({ reportId: RID, revision: 0, deleted: false, attachments: [] })
  const wire = (protoTail) => JSON.parse('{"reportId":"' + RID + '","revision":0,"deleted":false,"attachments":[]' + protoTail + '}')
  let a, b
  if (mode === 'control') { a = plain(); b = JSON.parse(JSON.stringify(a)) }
  else if (mode === 'presence') { a = plain(); b = wire(',"__proto__":{"x":1}') }
  else if (mode === 'value') { a = wire(',"__proto__":{"v":1}'); b = wire(',"__proto__":{"v":2}') }
  else throw new Error('unknown mode ' + mode)
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
    reports: [a, b],
    pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
  }
  const manifestBytes = Buffer.from(stage1Canonical(manifest))
  return { manifest, manifestBytes, pkg: buildPkg(manifest, [seg]) }
}

// 非空附件形——真包不可达（双非空同 (reportId,order) 触 Stage1 duplicate-report-order 拒）
function buildNonEmptyPkg(mode) { // 'control' | 'nested'
  const plain = () => ({ reportId: RID, revision: 0, deleted: false, attachments: [{ order: 0, originalFileId: OID, fileIndex: 0 }] })
  const wire = (nested) => JSON.parse(
    '{"reportId":"' + RID + '","revision":0,"deleted":false,"attachments":[' +
    '{"order":0,"originalFileId":"' + OID + '","fileIndex":0' + (nested ? ',"__proto__":{"n":1}' : '') + '}]}')
  let a, b
  if (mode === 'control') { a = plain(); b = JSON.parse(JSON.stringify(a)) }
  else if (mode === 'nested') { a = plain(); b = wire(true) }
  else throw new Error('unknown mode ' + mode)
  const body = { id: RID, revision: 0, deleted: false, attachments: [{ fileId: OID, order: 0 }] }
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
      { path: 'attachments/pk.bin', kind: 'attachment', length: attBytes.length, sha256: sha256(attBytes), contentType: 'image/png', originalFileId: OID, chunkSha256: [sha256(attBytes)], referencedBy: [RID] },
      { path: 'records/reports.json', kind: 'domain-json', length: seg.length, sha256: sha256(seg), contentType: 'application/json', domain: 'reports' },
    ],
    records: { reports: [{ index: 0, id: RID, revision: 0, deleted: false, hash: sha256(Buffer.from(stage1Canonical(body))) }] },
    reports: [a, b],
    pending: { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] },
  }
  const manifestBytes = Buffer.from(stage1Canonical(manifest))
  return { manifest, manifestBytes, pkg: buildPkg(manifest, [attBytes, seg]) }
}

// D25-r2 接受契约：接受+首目不变（零附件形：恰 1 record/零 refs/零 rmappart）+raw canonical 保持 distinct
function assertR2Accept(label, pkg, manifestBytes) {
  const m = wireManifest(pkg, manifestBytes)
  let threw = null, stream = null
  try { stream = v20.deriveV20Stream(m) } catch (e) { threw = e }
  assert.ok(!threw, `${label} 须接受（D25-r2 尾随有效空 no-op——含未知 own proto 键；实抛 ${threw && threw.message.slice(0, 70)}）`)
  const records = stream.entries.filter(e => e.entry.type === 'record')
  const refs = stream.entries.filter(e => e.entry.type === 'refs')
  const rmapparts = stream.entries.filter(e => e.entry.type === 'rmappart')
  assert.strictEqual(records.length, 1, `record 须恰 1（首目有效映射不变——实得 ${records.length}）`)
  assert.strictEqual(refs.length, 0, `refs 须零（实得 ${refs.length}）`)
  assert.strictEqual(rmapparts.length, 0, `rmappart 须零（实得 ${rmapparts.length}）`)
  assert.strictEqual(stream.count, 1, `流条目总数须 1（实得 ${stream.count}）`)
  const ca = v20.canonicalJsonBytes(m.reports[0]), cb = v20.canonicalJsonBytes(m.reports[1])
  assert.ok(!ca.equals(cb), `${label} raw canonical 须保持 distinct（no-op 是政策选择非 canonical 坍缩——摘要绑定的 raw 字节两形可区分）`)
  console.log(`      接受：count=1｜record=1 refs=0 rmappart=0｜raw canonical distinct（${ca.length}B vs ${cb.length}B）`)
}

;(async () => {
  const v20Hash = sha256(fs.readFileSync(V20_PATH))
  const srcHash = sha256(fs.readFileSync(SRC_PATH))
  console.log(`V20 own __proto__ 键 × D25-r2 尾随有效空 no-op 回归 rev3
v20.js: ${v20Hash.slice(0, 8)}｜源 index.js: ${srcHash.slice(0, 8)}（跑前冻结）
`)

  // ══ S0：非空重复边界测绘——Stage1 duplicate-report-order ══
  const s0 = buildNonEmptyPkg('control')
  const s0v = await validate(s0.pkg)
  await scenario('S0-① Stage1 拒双非空同 (reportId,order) 等价重复——duplicate-report-order（边界记录：真包不可达形）', async () => {
    assert.ok(!s0v.ok, 'Stage1 须拒双非空同序重复')
    const code = (s0v.problems || [])[0] && s0v.problems[0].code
    assert.strictEqual(code, 'duplicate-report-order', `拒因须为 duplicate-report-order（实得 ${code}）——与 proto 键无关`)
    console.log(`      Stage1 拒：${code}——${String((s0v.problems || [])[0].message).slice(0, 60)}`)
  })
  await scenario('S0-② 纯模块边界：V20 对 Stage1-拒形（同序双非空——含字节等价重复）须拒【rev3 修订：rev2"须①去重接受"按 S0 作用域裁定（doc=2b1605ec"任意形全等"作废）改为须拒——非删除】', async () => {
    const m = wireManifest(s0.pkg, s0.manifestBytes)
    let threw = null
    try { v20.deriveV20Stream(m) } catch (e) { threw = e }
    assert.ok(threw, '同序双非空重复（含字节等价）须拒——S0：V20 与 Stage1 duplicate-report-order 同族一致')
    assert.ok(/双非空|真歧义|D25/.test(threw.message), `拒因须为双非空冲突族（实得 "${threw.message.slice(0, 60)}"）`)
    console.log(`      V20 拒：${threw.message.slice(0, 90)}`)
  })

  // ══ C0 对照（真全包）：零附件字节等价重复——①全等去重接受基线 ══
  const c0 = buildZeroAttPkg('control')
  const c0v = await validate(c0.pkg)
  await scenario('C0-① Stage1 validatePackage 接受零附件字节等价重复（真全包——对照基线）', async () => {
    assert.ok(c0v.ok, `Stage1 须接受（实得 problems=${JSON.stringify((c0v.problems || []).slice(0, 1)).slice(0, 120)}）`)
  })
  await scenario('C0-② V20 ①全等去重：字节等价重复接受不拒（零附件——无 refs/rmappart）', async () => {
    const m = wireManifest(c0.pkg, c0.manifestBytes)
    assert.ok(!Object.hasOwn(m.reports[1], '__proto__'), '对照形第二映射不得有 own "__proto__" 键')
    let threw = null, stream = null
    try { stream = v20.deriveV20Stream(m) } catch (e) { threw = e }
    assert.ok(!threw, `字节等价重复须去重接受（实抛 ${threw && threw.message.slice(0, 60)}）`)
    assert.ok(stream.count >= 1, '去重接受须返回流')
    console.log(`      去重接受：条目=${stream.count}（零附件——无 refs/rmappart）`)
  })

  // ══ P1 presence 形（真全包）：B 带 own "__proto__" 键，可见字段全同 ══
  const p1 = buildZeroAttPkg('presence')
  const p1v = await validate(p1.pkg)
  await scenario('P1-① Stage1 validatePackage 接受 presence 形（真全包路径成立——own proto 键为多余键不拒）', async () => {
    assert.ok(p1v.ok, `Stage1 须接受（实得 problems=${JSON.stringify((p1v.problems || []).slice(0, 1)).slice(0, 120)}）`)
    console.log('      边界：真 Stage1 已验证全包')
  })
  await scenario('P1-② wire own "__proto__" 键存活前置（包字节含键＋JSON.parse 后 own＋原型未动＋canonical 往返等）', async () => {
    assert.ok(p1.manifestBytes.includes('"__proto__"'), '包 manifest canonical 字节须含 "__proto__" 键（raw 字节受摘要绑定）')
    const m = wireManifest(p1.pkg, p1.manifestBytes)
    const b = m.reports[1]
    assert.ok(Object.hasOwn(b, '__proto__'), 'JSON.parse 后第二映射 own "__proto__" 键须存活（CreateDataProperty）')
    assert.strictEqual(Object.getPrototypeOf(b), Object.prototype, 'own 键不得实际改动原型（JSON.parse 语义）')
    assert.ok(!Object.hasOwn(m.reports[0], '__proto__'), '第一映射无 own 键（presence 差异仅在第二条）')
    assert.ok(Buffer.from(stage1Canonical(m)).equals(p1.manifestBytes), 'wire→JSON.parse→canonical 往返字节相等')
  })
  await scenario('P1-③ V20 接受 presence 形【rev3 修订：rev2"须拒 D25②"按 D25-r2 裁定改为接受——尾随有效空 no-op 含未知 own proto 键；首目有效映射不变+零 refs/rmappart+raw canonical 保持 distinct】', async () => {
    assertR2Accept('P1 presence', p1.pkg, p1.manifestBytes)
  })

  // ══ P2 value 形（真全包）：A/B 各带 own "__proto__" 键且值不同 ══
  const p2 = buildZeroAttPkg('value')
  const p2v = await validate(p2.pkg)
  await scenario('P2-① Stage1 validatePackage 接受 value 形（真全包路径成立）', async () => {
    assert.ok(p2v.ok, `Stage1 须接受（实得 problems=${JSON.stringify((p2v.problems || []).slice(0, 1)).slice(0, 120)}）`)
  })
  await scenario('P2-② wire 双 own 键存活且值不同（{"v":1} vs {"v":2}——差异仅在 proto 键值）', async () => {
    const m = wireManifest(p2.pkg, p2.manifestBytes)
    assert.ok(Object.hasOwn(m.reports[0], '__proto__') && Object.hasOwn(m.reports[1], '__proto__'), '两条映射均须 own "__proto__" 键存活')
    assert.ok(JSON.stringify(m.reports[0].__proto__) !== JSON.stringify(m.reports[1].__proto__), 'proto 键值须不同')
    assert.strictEqual(Object.getPrototypeOf(m.reports[0]), Object.prototype)
    assert.strictEqual(Object.getPrototypeOf(m.reports[1]), Object.prototype)
  })
  await scenario('P2-③ V20 接受 value 形【rev3 修订：同 P1——尾随有效空 no-op；首目（{"v":1} 形）有效映射不变+raw canonical distinct】', async () => {
    assertR2Accept('P2 value', p2.pkg, p2.manifestBytes)
  })

  // ══ P3 nested 形：B 附件项内 own "__proto__" 键——真包不可达（S0-① duplicate-report-order）→ 纯模块边界 ══
  const p3 = buildNonEmptyPkg('nested')
  const p3v = await validate(p3.pkg)
  await scenario('P3-① Stage1 拒 nested 形于 duplicate-report-order（与 proto 键无关）——识别纯模块边界', async () => {
    assert.ok(!p3v.ok, '双非空同序重复须拒（与 S0-① 同因）')
    const code = (p3v.problems || [])[0] && p3v.problems[0].code
    assert.strictEqual(code, 'duplicate-report-order', `拒因须为 duplicate-report-order（实得 ${code}）`)
    console.log('      边界：纯模块（deriveV20Stream 纯函数——manifest wire 字节仍完整可派生）')
  })
  await scenario('P3-② wire 嵌套 own 键存活（attachments[0] 内 own "__proto__"——嵌套层保持直测）', async () => {
    const m = wireManifest(p3.pkg, p3.manifestBytes)
    const item = m.reports[1].attachments[0]
    assert.ok(Object.hasOwn(item, '__proto__'), '附件项内 own "__proto__" 键须存活')
    assert.ok(!Object.hasOwn(m.reports[1], '__proto__'), '顶层无 own 键（差异仅在嵌套层）')
    assert.strictEqual(Object.getPrototypeOf(item), Object.prototype)
  })
  await scenario('P3-③ V20 对 nested 形拒【rev3 重述：S0 双非空恒拒（含字节等价）——与 Stage1 duplicate-report-order 同族一致；拒因是双非空政策非 proto 键】', async () => {
    const m = wireManifest(p3.pkg, p3.manifestBytes)
    let threw = null
    try { v20.deriveV20Stream(m) } catch (e) { threw = e }
    assert.ok(threw, '双非空重复须拒（S0 政策——含嵌套 proto 键形）')
    assert.ok(/双非空|真歧义|D25/.test(threw.message), `拒因须为双非空冲突族（实得 "${threw.message.slice(0, 60)}"）`)
    console.log(`      V20 拒：${threw.message.slice(0, 90)}`)
  })

  // ══ PC：canonical own "__proto__" 键保持直测（协调方明示保留项）══
  await scenario('PC-① 模块 canonical 直测：序列化 own "__proto__" 键（字节含键）＋与去 proto 形不等＋distinct 保持', async () => {
    const withProto = JSON.parse('{"reportId":"' + RID + '","revision":0,"deleted":false,"attachments":[],"__proto__":{"x":1}}')
    const noProto = { reportId: RID, revision: 0, deleted: false, attachments: [] }
    const cb = v20.canonicalJsonBytes(withProto)
    assert.ok(cb.includes('"__proto__"'), 'canonical 字节须含 own "__proto__" 键（保持非丢失）')
    assert.ok(!cb.equals(v20.canonicalJsonBytes(noProto)), '带/不带 own proto 键 canonical 须不等（distinct 保持——D25-r2 no-op 政策下仍可区分）')
    const v2 = JSON.parse('{"reportId":"' + RID + '","revision":0,"deleted":false,"attachments":[],"__proto__":{"x":2}}')
    assert.ok(!cb.equals(v20.canonicalJsonBytes(v2)), 'proto 键值不同 canonical 须不等')
  })

  // ══ SIM：旧 stripUndefined（普通 {} 赋值）机制模拟——保留（rev3：no-op 政策下 distinct 保持仍需机制保证）══
  await scenario('SIM-① 旧普通 {} stripUndefined 模拟：own 键丢失＋canonical 坍缩相等（旧机制下 no-op 与假去重不可区分——机制存证）', async () => {
    const m = wireManifest(p1.pkg, p1.manifestBytes)
    const oldStrip = (v) => {
      if (v === null || typeof v !== 'object') return v
      if (Array.isArray(v)) return v.map(oldStrip)
      const o = {}
      for (const k of Object.keys(v)) if (v[k] !== undefined) o[k] = oldStrip(v[k])
      return o
    }
    const sa = oldStrip(m.reports[0]), sb = oldStrip(m.reports[1])
    assert.ok(!Object.hasOwn(sb, '__proto__'), '旧形：own "__proto__" 经普通 {} 赋值触发 setter——丢键改设原型')
    assert.ok(v20.canonicalJsonBytes(sa).equals(v20.canonicalJsonBytes(sb)), '旧形两条映射 canonical 坍缩相等——raw distinct 界面丢失（现行 Object.create(null) 保 distinct——PC-①/P1-③ 锚）')
    console.log('      旧形原型污染面：getPrototypeOf(旧副本)=被设为 proto 键值对象（污染形——非 Object.prototype）')
  })

  // ── 冻结哈希漂移门（QR19-v7 规则：漂移=无效轮——failed+++exit 1）──
  const v20Post = sha256(fs.readFileSync(V20_PATH))
  const srcPost = sha256(fs.readFileSync(SRC_PATH))
  console.log(`\n源 index.js: ${srcPost.slice(0, 8)} ${srcHash === srcPost ? '== 一致' : '≠ 漂移'}｜v20.js: ${v20Post.slice(0, 8)} ${v20Hash === v20Post ? '== 一致' : '≠ 漂移'}`)
  if (v20Hash !== v20Post || srcHash !== srcPost) failed.push('冻结源漂移：v20/index 跑前≠跑后（本轮无效）')

  console.log(`\n${passed} 通过, ${failed.length} 失败`)
  if (failed.length) { console.log('失败项：\n - ' + failed.join('\n - ')); process.exit(1) }
})().catch(e => { console.error(e); process.exit(2) })
