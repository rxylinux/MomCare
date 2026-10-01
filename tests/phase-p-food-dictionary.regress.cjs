// Phase P：饮食/行为安全词典扩充契约（2026-10-01 用户审定 docs/food-dictionary-draft.md，
// 14 条 → 54 条；含 6 条民间说法澄清条目与"河豚 caution→avoid"预告升级落地）。
// 锁：①54 条结构与必填字段（id 前缀=category、level 合法、synonyms≥2、来源在位）
// ②澄清条目在位且措辞含"无据"类事实声明 ③河豚=avoid ④生成器幂等可重跑
// ⑤云端模块与 JSON 逐字段同源（与 phase-e3-server 互补：那边测匹配行为，这边测内容契约）。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) {
  try { await fn(); pass(name) } catch (e) { fail(name, e) }
}

const DATA = JSON.parse(fs.readFileSync(path.join(root, 'static/data/food-safety.json'), 'utf8'))
const byId = Object.fromEntries(DATA.map(e => [e.id, e]))

async function main() {
  await scenario('P1 结构契约：54 条、id 唯一、前缀=类别、level 合法、必填字段齐', async () => {
    assert.equal(DATA.length, 54)
    assert.equal(new Set(DATA.map(e => e.id)).size, 54, 'id 唯一')
    for (const e of DATA) {
      assert.ok(['safe', 'caution', 'avoid'].includes(e.level), `level 异常：${e.id}`)
      assert.equal(e.id.startsWith(e.category === 'food' ? 'food_' : 'behavior_'), true, `前缀与类别不符：${e.id}`)
      for (const k of ['name', 'summary', 'conditions', 'risks', 'source', 'sourceUrl', 'reviewedAt', 'version']) {
        assert.ok(String(e[k] || '').trim(), `${e.id} 缺 ${k}`)
      }
      assert.ok(Array.isArray(e.synonyms) && e.synonyms.length >= 2, `${e.id} synonyms ≥2`)
    }
    const v2 = DATA.filter(e => e.version === '2.0')
    assert.equal(v2.length, 40, '新增 40 条 v2')
    assert.ok(v2.every(e => e.reviewedAt === '2026-10-01'))
  })

  await scenario('P2 分级分布与关键定级：河豚=avoid（草稿预告升级落地）', async () => {
    assert.equal(byId.food_fugu.level, 'avoid', '河豚按预告升级为 avoid')
    assert.equal(byId.food_high_mercury_fish.level, 'avoid', '高汞鱼 avoid')
    assert.equal(byId.behavior_cat_litter.level, 'avoid', '猫砂 avoid')
    assert.equal(byId.food_animal_liver.level, 'caution', '动物肝脏=caution 限量')
  })

  await scenario('P3 澄清条目在位：螃蟹/西瓜/辣椒/酱油 safe 且声明无科学依据；黄连水 avoid', async () => {
    for (const id of ['food_crab_shrimp_cooked', 'food_watermelon', 'food_chili_cooked', 'food_soy_sauce', 'food_hawthorn_small']) {
      const e = byId[id]
      assert.equal(e.level, 'safe', `${id} 应为 safe`)
      assert.ok(['无据', '无科学依据', '没有科学依据', '缺乏', '只见于动物实验'].some(w => e.summary.includes(w)), `${id} 澄清声明在：${e.summary.slice(0, 30)}`)
    }
    assert.equal(byId.behavior_fetal_detox_folk.level, 'avoid')
    assert.ok(byId.behavior_fetal_detox_folk.summary.includes('不是医学概念'))
  })

  await scenario('P4 生成器幂等：--out 临时产物 require 后与 JSON 逐字段一致', async () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-phase-p-')), 'food-safety-data.js')
    execFileSync('node', [path.join(root, 'scripts/gen-food-safety.mjs'), '--out', out], { stdio: 'pipe' })
    const gen = require(out)
    assert.deepEqual(gen, DATA, '生成物与作者源逐字段一致')
    assert.ok(fs.readFileSync(out, 'utf8').includes('勿手改'), '生成物带勿手改声明')
  })

  await scenario('P5 云端模块同源：仓库 food-safety-data.js 与 JSON 逐字段一致（生成器已跑）', async () => {
    const cloud = require(path.join(root, 'cloud/functions/mc-tools/food-safety-data.js'))
    assert.deepEqual(cloud, DATA, '双源不漂移——不一致时重跑 scripts/gen-food-safety.mjs')
  })

  console.log(`\nphase-p：${passed} 通过，${failed.length} 失败`)
  if (failed.length > 0) { console.log('失败场景：', failed.join(' | ')); process.exit(1) }
}

main().catch(e => { console.error(e); process.exit(1) })
