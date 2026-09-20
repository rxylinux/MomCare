// V20 回归：packBlocks 伪造 canonical（兼容入口不受信面）rev2
// 协调方指认 2026-09-20 + 独立审查纠正：rev1 的 C1/F4 夹具用 9000B/3000B 条目——违反协议
// ENTRY_MAX=2048B（CODING 加每条目尺寸门后"诚实须打包"基线会翻红，且 F4 无法区分
// "正确 canonical 重算"与"仅尺寸门"）。rev2 改用**逐条合法** ≤2048B 条目：
//   - C1 诚实基线：五条 canonical=2000B + 一条 1000B → 预算贪心 2 块精确 10006B/1002B
//     （10006+1+1000=11007 > 10240 → 第六条另封）。
//   - F4 伪造首条 2000B→supplied 1B：假预算 9008 ≤10240 全并一块 → seal 实际 11009B 超限
//     （仅"拒伪造"或"恒重算"可过——仅加每条目尺寸门不治病）。
// 保留拒形：F1 伪造 12027B（supplied 1B）；F2 同形+攻击者一致超限缓存（缓存路径不得
// launder 超限）；C2 honest 12027B（重算不可能 ≤10240——必拒）。
// 边界（协调方补）：B1 canonical 恰 2048B 须收；B2 恰 2049B 须拒（packBlocks 兼容入口
// 须有 ENTRY_MAX 门——deriveV20Stream 上游 push 闭包的门不覆盖此入口）。
// 契约：伪造/超限输入须 **拒** 或 **重算**——返回时每块 ≤BLOCK_NET（10240）精确上限。
// 执行史：rev1 写后未及跑（独立审查纠正先至——夹具违反 ENTRY_MAX）；rev2 首跑于 c4dd6824
// ——CODING 修复已携（拒"伪造/漂移 canonical 供给≠实算"+每条目**实算** ENTRY_MAX 门）——
// 契约面全绿（无本地红证；红证为协调方在旧源 0b87e249 的独立观测）。
// 范围：纯模块 v20.packBlocks（不经 Stage1/handler——不声称 handler 接受）。
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-v20forged-'))
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
function tryPack(stream) { try { return { blocks: v20.packBlocks(stream), threw: null } } catch (e) { return { blocks: null, threw: e } } }
function assertBlocksAtMostNet(blocks, label) {
  blocks.forEach((b, i) => assert.ok(b.length <= v20.BLOCK_NET, `${label} 块${i}=${b.length}B > BLOCK_NET=${v20.BLOCK_NET}（精确上限违规——supplied canonical 未拒/未重算）`))
}

// record 条目模板：keys 排序 deleted<domain<hash<id<index<revision<type——与模块 canonical 同形
const HASH = 'ab'.repeat(32)
const tmpl = (n) => `{"deleted":false,"domain":"reports","hash":"${HASH}","id":"${'P'.repeat(n)}","index":0,"revision":0,"type":"record"}`
const mkEntry = (n, idx = 0) => ({ type: 'record', domain: 'reports', index: idx, revision: 0, deleted: false, hash: HASH, id: 'P'.repeat(n) })
const OVERHEAD = Buffer.byteLength(tmpl(0)) // 158B（id 空串封套）
const honest = (e) => ({ entry: e, canonical: v20.canonicalJsonBytes(e) }) // 诚实 supplied=模块自算
const forged = (e) => ({ entry: e, canonical: Buffer.from('x') })          // 伪造 supplied=1B

// 六条逐条合法条目：五条 canonical=2000B（index/id 尾数互异）+ 一条 1000B
const N2K = 2000 - OVERHEAD, N1K = 1000 - OVERHEAD
const five = [0, 1, 2, 3, 4].map((i) => mkEntry(N2K, i))
const sixth = mkEntry(N1K, 5)
const honestB1 = v20.canonicalJsonBytes(five)   // 10006B（2+5×2000+4 逗号）
const honestB2 = v20.canonicalJsonBytes([sixth]) // 1002B
// 边界与拒形单条目
const e2048 = mkEntry(2048 - OVERHEAD)          // canonical 恰 2048B（ENTRY_MAX 内含边界）
const e2049 = mkEntry(2049 - OVERHEAD)          // canonical 恰 2049B（超 1B——须拒）
const bigEntry = mkEntry(12027 - OVERHEAD)      // canonical 恰 12027B（协调方原形）

;(async () => {
  const v20Hash = sha256(fs.readFileSync(V20_PATH))
  const srcHash = sha256(fs.readFileSync(SRC_PATH))
  console.log(`V20 packBlocks 伪造 canonical 回归 rev2
v20.js: ${v20Hash.slice(0, 8)}｜源 index.js: ${srcHash.slice(0, 8)}（跑前冻结——红先行轮）
`)

  await scenario('P0-① 尺寸前置：五条恰 2000B（互异）+一条恰 1000B；2048/2049/12027B 各恰（模板串=模块 canonical）', async () => {
    five.forEach((e, i) => assert.strictEqual(v20.canonicalJsonBytes(e).length, 2000, `five[${i}] canonical 须恰 2000B`))
    for (let i = 1; i < five.length; i++) assert.ok(!v20.canonicalJsonBytes(five[i]).equals(v20.canonicalJsonBytes(five[i - 1])), '五条须互异（id/index 尾数）')
    assert.strictEqual(v20.canonicalJsonBytes(sixth).length, 1000)
    for (const [e, len] of [[e2048, 2048], [e2049, 2049], [bigEntry, 12027]]) {
      const b = v20.canonicalJsonBytes(e)
      assert.strictEqual(b.length, len, `canonical 须恰 ${len}B（实得 ${b.length}）`)
      assert.ok(b.equals(Buffer.from(tmpl(len - OVERHEAD))), '模块 canonical 须与模板串字节相等（构造有效性）')
    }
    assert.strictEqual(honestB1.length, 10006, '诚实块0须恰 10006B')
    assert.strictEqual(honestB2.length, 1002, '诚实块1须恰 1002B')
    console.log(`      BLOCK_NET=${v20.BLOCK_NET}｜ENTRY_MAX=${v20.ENTRY_MAX}｜5×2000+1000｜2048/2049/12027 边界就绪`)
  })

  // ══ C1 对照（逐条合法）：诚实六条目——2 块精确 10006/1002，全 ≤10240，不拒 ══
  await scenario('C1-① honest 5×2000B+1000B：2 块精确分区 10006B/1002B（预算 10006+1+1000>10240→第六条另封），不拒', async () => {
    const r = tryPack({ entries: [...five, sixth].map(honest) })
    assert.ok(!r.threw, `逐条合法（≤2048B）诚实输入须正常打包（实抛 ${r.threw && r.threw.message.slice(0, 60)}）——修复不得过度拒`)
    assert.strictEqual(r.blocks.length, 2, `须 2 块（实得 ${r.blocks.length}：${r.blocks.map(b => b.length).join('/')}）`)
    assertBlocksAtMostNet(r.blocks, 'C1')
    assert.ok(r.blocks[0].equals(honestB1) && r.blocks[1].equals(honestB2), '块字节须为诚实 canonical 分区（[five]＋[sixth]）')
    console.log(`      块=${r.blocks.map(b => b.length).join('/')}B`)
  })

  // ══ B1/B2 边界：ENTRY_MAX=2048 恰含/恰超 ══
  await scenario('B1-① canonical 恰 2048B：须收（单块 2050B ≤10240）', async () => {
    const r = tryPack({ entries: [honest(e2048)] })
    assert.ok(!r.threw, `2048B 恰在 ENTRY_MAX 内含边界——须收（实抛 ${r.threw && r.threw.message.slice(0, 60)}）`)
    assert.strictEqual(r.blocks.length, 1)
    assert.strictEqual(r.blocks[0].length, 2050, `单块须 2050B（实得 ${r.blocks[0].length}）`)
    assertBlocksAtMostNet(r.blocks, 'B1')
  })
  await scenario('B2-① canonical 恰 2049B：须拒（超 ENTRY_MAX=2048——packBlocks 兼容入口须有每条目尺寸门）', async () => {
    const r = tryPack({ entries: [honest(e2049)] })
    assert.ok(r.threw, `2049B 超 ENTRY_MAX 1B——须拒（实得返回块 ${r.blocks && r.blocks.map(b => b.length).join('/')}B）`)
    console.log(`      拒：${r.threw.message.slice(0, 80)}`)
  })

  // ══ F1 协调方原形：单条目实际 12027B，supplied canonical=1B，无缓存 ══
  await scenario('F1-① 伪造 canonical（实际 12027B/supplied 1B）：须拒或重算——返回则每块 ≤10240', async () => {
    const r = tryPack({ entries: [forged(bigEntry)] })
    if (!r.threw) {
      assert.ok(r.blocks.length >= 1, '返回须非空块组')
      assertBlocksAtMostNet(r.blocks, 'F1')
      console.log(`      重算分支：块=${r.blocks.map(b => b.length).join('/')}B`)
    } else console.log(`      拒（契约有效）：${r.threw.message.slice(0, 80)}`)
  })

  // ══ F2 缓存路径：伪造 canonical + 攻击者一致超限缓存（rebuilt=缓存=超限 → equals 通过形）══
  await scenario('F2-① 伪造 canonical+一致超限缓存块 [canonical([big])]：同契约——缓存路径不得 launder 超限', async () => {
    const cached = [v20.canonicalJsonBytes([bigEntry])] // 攻击者以诚实重算字节作缓存（12029B 超限）
    const r = tryPack({ entries: [forged(bigEntry)], blocks: cached })
    if (!r.threw) assertBlocksAtMostNet(r.blocks, 'F2')
    else console.log(`      拒（契约有效）：${r.threw.message.slice(0, 80)}`)
  })

  // ══ F4 最利判别形（逐条合法）：伪造首条 2000B→1B + 诚实其余——假预算全并一块 11009B ══
  await scenario('F4-① 伪造首条 2000B（supplied 1B）+honest 其余五条：拒或诚实 2 块分区 10006/1002——仅尺寸门不治病', async () => {
    const entries = [forged(five[0]), ...five.slice(1).map(honest), honest(sixth)]
    const r = tryPack({ entries })
    if (!r.threw) {
      assertBlocksAtMostNet(r.blocks, 'F4')
      assert.strictEqual(r.blocks.length, 2, `重算分支须诚实分区 2 块（实得 ${r.blocks.length}：${r.blocks.map(b => b.length).join('/')}）`)
      assert.ok(r.blocks[0].equals(honestB1), '块0须=canonical([five]) 精确字节')
      assert.ok(r.blocks[1].equals(honestB2), '块1须=canonical([sixth]) 精确字节')
      console.log(`      重算分支：块=${r.blocks.map(b => b.length).join('/')}B`)
    } else console.log(`      拒（契约有效）：${r.threw.message.slice(0, 80)}`)
  })

  // ══ C2 相邻同灶：honest 超限单条目（12027B 无伪造）——重算不可能 ≤10240 → 必拒 ══
  await scenario('C2-① honest 12027B 单条目（无伪造）：必拒（>ENTRY_MAX 2048——任何 ≤10240 分区不可能）', async () => {
    const r = tryPack({ entries: [honest(bigEntry)] })
    assert.ok(r.threw, `honest 12027B 条目超 ENTRY_MAX——须拒（实得返回块 ${r.blocks && r.blocks.map(b => b.length).join('/')}B）`)
    console.log(`      拒：${r.threw.message.slice(0, 80)}`)
  })

  // ── 冻结哈希漂移门（QR19-v7 规则：漂移=无效轮——failed+++exit 1）──
  const v20Post = sha256(fs.readFileSync(V20_PATH))
  const srcPost = sha256(fs.readFileSync(SRC_PATH))
  console.log(`\n源 index.js: ${srcPost.slice(0, 8)} ${srcHash === srcPost ? '== 一致' : '≠ 漂移'}｜v20.js: ${v20Post.slice(0, 8)} ${v20Hash === v20Post ? '== 一致' : '≠ 漂移'}`)
  if (v20Hash !== v20Post || srcHash !== srcPost) failed.push('冻结源漂移：v20/index 跑前≠跑后（本轮无效）')

  console.log(`\n${passed} 通过, ${failed.length} 失败`)
  if (failed.length) { console.log('失败项：\n - ' + failed.join('\n - ')); process.exit(1) }
})().catch(e => { console.error(e); process.exit(2) })
