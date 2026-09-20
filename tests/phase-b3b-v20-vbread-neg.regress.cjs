// V20 回归：verifiedBlockRead 负形四门（D21 对象形＋读侧硬限独立执法）rev1
// 协调方指认 2026-09-20（旧源红证——协调方独立构造）：自洽单块计划（T=1）blockDoc.entries 为
// **对象**（单条 record 形）、entryCount=1、byteLength 精确、sha256=位置绑定叶、proof=''（T=1 合法
// 空证明）、planRoot=该叶——旧 V20 `Array.isArray(entries) && …` 条件使对象形跳过 entryCount 检查，
// 其余全自洽 → **接受并返回对象 canonical 字节**（违 D21 native entries 数组）。
// 契约四门（协调方）：读路径须独立执法（不依赖写路径已检）——
//   R1 entries 非数组（对象形——D21）拒；R2 >48 条/块 拒；R3 单条 canonical >2048B 拒；R4 块 canonical >10240B 拒。
// 设计约束（协调方明示）：**不得以无效证明为唯一拒因**——全部夹具 proof/root 自洽且 P0 以
// verifyProof 独立验证每件证明合法（拒因只能来自形状门）。
// 对照：C1 单条小数组收；C2 5×2000B（块 10006 ≤10240、每条 ≤2048、5 ≤48）收——边界贴邻接受侧。
// 执行史：红形为协调方在旧源独立观测；本文件首跑时 CODING 修复或已先携（034f6b35 :418 起四门在）——
// 若绿即修复钉；红则如实报告。修复后同测试哈希重跑须绿。
// 范围：纯模块 verifiedBlockRead——不经 Stage1/handler，不声称 handler 接受。
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-v20vbrn-'))
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')

const V20_PATH = path.join(root, 'cloud/functions/mc-restore/v20.js')
const SRC_PATH = path.join(root, 'cloud/functions/mc-restore/index.js')
if (!fs.existsSync(V20_PATH)) { console.log('V20 未落地'); process.exit(3) }
const v20Out = path.join(temp, 'v20.cjs')
esbuild.buildSync({ entryPoints: [V20_PATH], bundle: true, platform: 'node', format: 'cjs', outfile: v20Out, logLevel: 'silent' })
const v20 = require(v20Out)

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }

// record 条目模板（同 forgedcanonical 套——OVERHEAD=158B：keys 排序 deleted<domain<hash<id<index<revision<type）
const HASH = 'ab'.repeat(32)
const tmpl = (n) => `{"deleted":false,"domain":"reports","hash":"${HASH}","id":"${'P'.repeat(n)}","index":0,"revision":0,"type":"record"}`
const mkEntry = (n, idx = 0) => ({ type: 'record', domain: 'reports', index: idx, revision: 0, deleted: false, hash: HASH, id: 'P'.repeat(n) })
const OVERHEAD = Buffer.byteLength(tmpl(0))

const BID = 'rst_' + 'a1b2c3d4'.repeat(4) // 合法 36B（rst_+32hex）

// 自洽单块（T=1）文档构造：byteLength/sha256(位置绑定叶)/proof=''/planRoot 全自洽
function mkDoc(entries, entryCountOverride) {
  const payloadBytes = v20.canonicalJsonBytes(entries)
  const leaf = v20.leafHash(1, 0, payloadBytes)
  const entryCount = entryCountOverride !== undefined ? entryCountOverride : (Array.isArray(entries) ? entries.length : 1)
  return {
    blockDoc: { _id: `${BID}:blk:0`, entries, byteLength: payloadBytes.length, entryCount, sha256: leaf.toString('hex'), proof: '' },
    batch: { batchId: BID, totalBlocks: 1, planRoot: leaf.toString('hex') },
    payloadBytes,
  }
}
function mustReject(label, doc) {
  let threw = null
  try { v20.verifiedBlockRead({ blockDoc: doc.blockDoc, batch: doc.batch, blockIndex: 0 }) } catch (e) { threw = e }
  assert.ok(threw, `${label} 须拒（proof/root 自洽——拒因须为形状门非证明）`)
  console.log(`      拒：${threw.message.slice(0, 90)}`)
}

// 夹具：R1 对象形（协调方原形——单条 record 对象非数组）；R2 49×168B（块 8282 ≤10240——仅条数越界）；
// R3 单条 2049B（块 2051 ≤10240——仅单条越界）；R4 6×2000B（块 12007 >10240——仅块越界；每条 ≤2048、6 ≤48）；
// C2 5×2000B（块 10006 ≤10240——贴邻接受侧）；C1 单条 258B。
const r1Obj = mkEntry(100)
const r2 = mkDoc(Array.from({ length: 49 }, (_, i) => mkEntry(10, i % 10)))
const r3 = mkDoc([mkEntry(2049 - OVERHEAD)])
const r4 = mkDoc(Array.from({ length: 6 }, (_, i) => mkEntry(2000 - OVERHEAD, i)))
const c2 = mkDoc(Array.from({ length: 5 }, (_, i) => mkEntry(2000 - OVERHEAD, i)))
const c1 = mkDoc([mkEntry(100)])
const r1 = mkDoc(r1Obj, 1) // 对象形 entryCount=1（协调方原形——自洽语义）

;(async () => {
  const v20Hash = sha256(fs.readFileSync(V20_PATH))
  const srcHash = sha256(fs.readFileSync(SRC_PATH))
  console.log(`V20 verifiedBlockRead 负形四门回归 rev1
v20.js: ${v20Hash.slice(0, 8)}｜源 index.js: ${srcHash.slice(0, 8)}（跑前冻结）
`)

  await scenario("P0-① 夹具自洽前置：尺寸精确＋每件空证明独立 verifyProof 合法（拒因不得归 proof）", async () => {
    const sizes = [[c1, OVERHEAD + 100 + 2], [c2, 10006], [r1, null], [r2, 2 + 49 * (OVERHEAD + 10) + 48], [r3, 2051], [r4, 12007]]
    for (const [d, expect] of sizes) {
      if (expect !== null) assert.strictEqual(d.payloadBytes.length, expect, `块 canonical 须恰 ${expect}B（实得 ${d.payloadBytes.length}）`)
      assert.ok(v20.verifyProof({ totalBlocks: 1, blockIndex: 0, blockBytes: d.payloadBytes, proof: d.blockDoc.proof, planRoot: Buffer.from(d.batch.planRoot, 'hex') }) === true, '证明须独立合法（空证明折叠叶=根）')
      assert.strictEqual(d.blockDoc.byteLength, d.payloadBytes.length, 'byteLength 自洽')
      assert.strictEqual(v20.leafHash(1, 0, d.payloadBytes).toString('hex'), d.blockDoc.sha256, 'sha256=位置绑定叶自洽')
    }
    assert.ok(!Array.isArray(r1.blockDoc.entries) && typeof r1.blockDoc.entries === 'object', 'R1 entries 须对象形（非数组）')
    assert.strictEqual(r1.blockDoc.entryCount, 1, 'R1 entryCount=1（协调方原形）')
    assert.ok(v20.canonicalJsonBytes(r1Obj).equals(Buffer.from(tmpl(100))), 'R1 对象=模板 record 条目字节')
    console.log(`      C1=${OVERHEAD + 100 + 2}B（OVERHEAD=${OVERHEAD}）｜C2=10006B｜R1=对象${r1.payloadBytes.length}B｜R2=${2 + 49 * (OVERHEAD + 10) + 48}B(49 条)｜R3=2051B(单条 2049)｜R4=12007B(6×2000)——全件证明独立合法`)
  })

  await scenario('C1-① 对照接受：单条小数组条目——返回字节=canonical(entries) 精确', async () => {
    const out = v20.verifiedBlockRead({ blockDoc: c1.blockDoc, batch: c1.batch, blockIndex: 0 })
    assert.ok(out.equals(c1.payloadBytes), '返回字节须逐字节=canonical(entries)')
  })

  await scenario('C2-① 对照接受（边界贴邻）：5×2000B——块 10006 ≤10240 ∧ 每条 ≤2048 ∧ 5 ≤48', async () => {
    const out = v20.verifiedBlockRead({ blockDoc: c2.blockDoc, batch: c2.batch, blockIndex: 0 })
    assert.ok(out.equals(c2.payloadBytes))
    console.log(`      接受：块=${out.length}B（≤${v20.BLOCK_NET}）`)
  })

  await scenario('R1-① 对象形 entries（协调方原形：自洽叶/空证明/根——entryCount=1）：须拒（D21 native 数组）', async () => {
    mustReject('R1 对象形', r1)
  })
  await scenario('R2-① 49 条 >48/块（块 8233 ≤10240——仅条数越界）：须拒', async () => {
    mustReject('R2 超条数', r2)
  })
  await scenario('R3-① 单条 canonical 2049B >2048（块 2051 ≤10240——仅单条越界）：须拒', async () => {
    mustReject('R3 单条超限', r3)
  })
  await scenario('R4-① 块 canonical 12007B >10240（每条 ≤2048 ∧ 6 ≤48——仅块越界）：须拒', async () => {
    mustReject('R4 块超限', r4)
  })

  // ── 冻结哈希漂移门（QR19-v7 规则：漂移=无效轮——failed+++exit 1）──
  const v20Post = sha256(fs.readFileSync(V20_PATH))
  const srcPost = sha256(fs.readFileSync(SRC_PATH))
  console.log(`\n源 index.js: ${srcPost.slice(0, 8)} ${srcHash === srcPost ? '== 一致' : '≠ 漂移'}｜v20.js: ${v20Post.slice(0, 8)} ${v20Hash === v20Post ? '== 一致' : '≠ 漂移'}`)
  if (v20Hash !== v20Post || srcHash !== srcPost) failed.push('冻结源漂移：v20/index 跑前≠跑后（本轮无效）')

  console.log(`\n${passed} 通过, ${failed.length} 失败`)
  if (failed.length) { console.log('失败项：\n - ' + failed.join('\n - ')); process.exit(1) }
})().catch(e => { console.error(e); process.exit(2) })
