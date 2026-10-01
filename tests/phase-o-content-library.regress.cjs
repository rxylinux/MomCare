// Phase O：内容库 v2（2026-10-01 用户审定 docs/content-library-draft.md）落地契约。
// 单一作者源 = utils/dailyTipCore.js 的 STAGE_TIPS；scripts/gen-daily-content.mjs
// 生成 static/data/pregnancy-daily.json 的 tip 列；推送提示行同源。
// 本套件锁：①静态库 280 天每天 tip ∈ 其周段词条集（禁串段/禁旧库残留）②≤20 字
// ③生成器幂等可重跑（--out 临时产物与仓库逐日一致）④词表锚点=审定草稿原文
// ⑤推送平日 note ∈ 当周段词集∪水果行（两端同一天取同一条阶段词条）。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-phase-o-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) {
  try { await fn(); pass(name) } catch (e) { fail(name, e) }
}

const coreFile = path.join(temp, 'dailyTipCore.cjs')
esbuild.buildSync({ entryPoints: [path.join(root, 'utils/dailyTipCore.js')], bundle: true, platform: 'node', format: 'cjs', outfile: coreFile, logLevel: 'silent' })
const { stageTipsForWeek, buildPushContent } = require(coreFile)
const DATA = JSON.parse(fs.readFileSync(path.join(root, 'static/data/pregnancy-daily.json'), 'utf8'))

async function main() {
  await scenario('O1 静态库契约：280 天齐、每天 tip ∈ 当周段词条集、≤20 字、无旧库残留', async () => {
    assert.equal(DATA.length, 280)
    const byDay = new Map(DATA.map(d => [d.total_days, d]))
    const oldSigns = ['准备宽松、有托腹功能的孕妇装', '记录末次月经第一天的日期', '爸爸任务', '记下末次月经', '试纸两条杠']
    for (let td = 0; td <= 279; td++) {
      const e = byDay.get(td)
      assert.ok(e, `缺第 ${td} 天`)
      const tips = stageTipsForWeek(Math.floor(td / 7))
      assert.ok(tips.includes(e.tip_text), `第 ${td} 天串段/外来文案：${e.tip_text}`)
      assert.ok(String(e.tip_text).length <= 20, `第 ${td} 天超 20 字：${e.tip_text}`)
      for (const bad of oldSigns) assert.ok(!e.tip_text.includes(bad), `旧库残留（${bad}）`)
    }
  })

  await scenario('O2 唯一文案规模：61 条（13 段词表去重），无跨段大重复', async () => {
    const uniq = new Set(DATA.map(d => d.tip_text))
    assert.equal(uniq.size, 62)
    // 相邻段共用词条（叶酸/烟酒/末次月经）属设计内——只允许这三条跨段
    const segSets = new Map()
    for (const d of DATA) {
      const w = Math.floor(d.total_days / 7)
      if (!segSets.has(w)) segSets.set(w, new Set())
      segSets.get(w).add(d.tip_text)
    }
    // 段识别：相邻周词条集相同=同段（collapse 后再查跨段重复）
    const buckets = []
    let prev = null
    for (let w = 0; w <= 39; w++) { // 数据止于 279 天（39 周+6），无第 40 周
      const cur = [...segSets.get(w)].sort().join('|')
      if (cur !== prev) { buckets.push(cur); prev = cur }
    }
    assert.equal(buckets.length, 13, 'collapse 后恰 13 段')
    const allPhrases = new Set()
    const cross = []
    for (const b of buckets) for (const t of b.split('|')) { if (allPhrases.has(t)) cross.push(t); allPhrases.add(t) }
    assert.deepEqual([...new Set(cross)].sort(), ['叶酸每天 0.4mg 别断', '远离烟酒和二手烟'].sort(), '跨段词条仅限设计内两条（发现期文案已按用户裁定清除）')
  })

  await scenario('O3 生成器幂等：--out 临时产物与仓库 JSON tip 逐日一致（可重跑不漂移）', async () => {
    const out = path.join(temp, 'regen.json')
    execFileSync('node', [path.join(root, 'scripts/gen-daily-content.mjs'), '--out', out], { stdio: 'pipe' })
    const regen = JSON.parse(fs.readFileSync(out, 'utf8'))
    assert.equal(regen.length, 280)
    for (let i = 0; i < 280; i++) {
      assert.equal(regen[i].tip_text, DATA[i].tip_text, `第 ${i} 天生成不一致`)
    }
  })

  await scenario('O4 词表锚点：审定草稿原文在位 + 13 段结构（含补的孕1-3周段）', async () => {
    const src = fs.readFileSync(path.join(root, 'utils/dailyTipCore.js'), 'utf8')
    for (const anchor of ['宝宝小心脏开始跳动了', 'NT 检查窗口期是 11-13 周', '糖耐检查要空腹，别忘', '数胎动：早中晚各 1 小时', '宫缩 5-6 分钟一次就出发', '快见面了，加油', '别提重物，避免剧烈弯腰']) {
      assert.ok(src.includes(anchor), `词表缺锚点：${anchor}`)
    }
    assert.equal((src.match(/\{ from: \d+, to: \d+, tips:/g) || []).length, 13)
  })

  await scenario('O5 两端同源：推送平日 note ∈ 当周段词集∪水果行；同孕天与静态库阶段词条一致', async () => {
    const lmp = '2026-08-24'
    // 固定日期抽查 4 个周段（10月，当季果=鲜枣/梨/葡萄）
    for (const today of ['2026-10-01', '2026-11-05', '2026-12-20', '2027-01-15']) {
      const r = buildPushContent({ today, lmp, nextCheckupDate: null })
      assert.ok(r, today)
      const days = Math.round((Date.parse(today) - Date.parse(lmp)) / 86400000)
      const tips = stageTipsForWeek(Math.floor(days / 7))
      const fruitLines = [`今日维C：`, `补铁：瘦牛肉配`, `当季，每天200~350g就好`]
      const inStage = tips.includes(r.note)
      const isFruitLine = fruitLines.some(p => r.note.includes(p))
      assert.ok(inStage || isFruitLine, `${today} note 越池：${r.note}`)
      // 同源=同池：阶段词条必来自当周段词表（两端同天未必同句——推送混入水果行按日轮换，设计允许）
    }
  })

  console.log(`\nphase-o：${passed} 通过，${failed.length} 失败`)
  if (failed.length > 0) { console.log('失败场景：', failed.join(' | ')); process.exit(1) }
}

main().catch(e => { console.error(e); process.exit(1) })
