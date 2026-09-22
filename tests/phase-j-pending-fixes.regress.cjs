// Phase J 遗留待裁定修复回归：2026-09-23 用户授权"都修一下"批次的六项结构锁定。
// 覆盖（按修复编号）：
//   1 首页问候语接入爸妈视角（index.vue greeting 分流 collabHomeView）
//   2 记录卡未填孕期资料兜底提示（8661f09 已落地——本套件锁定防回归）
//   3 饮食速查动态胶囊/诚实空态（行为见 phase-e3-page P4；此处锁模板结构）
//   4 flushAll 聚合真实成败（行为见 phase-b2a"flushAll 聚合"；此处锁 toast 消费）
//   5 未确认身份保存孕期资料"未上云"显著提示（pregnancy-info.vue）
//   6 DailyChanges 死函数 formatDateLabel 删除（行为见 phase-i DC3；此处锁源码无残留）
// 手法：源码结构断言（phase-i-release-script 先例——文案/分支类改动无法在
// bundlePage 框架内行为化渲染分支，用结构断言锁定）+冻结哈希防并发编辑。
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }

const RELS = {
  index: 'pages/index/index.vue',
  food: 'pages/tools/food-safety.vue',
  preginfo: 'pages/profile/pregnancy-info.vue',
  dc: 'components/home/DailyChanges.vue'
}
const src = Object.fromEntries(Object.entries(RELS).map(([k, rel]) => [k, fs.readFileSync(path.join(root, rel), 'utf8')]))
const frozenHashes = Object.fromEntries(Object.entries(RELS).map(([k, rel]) => [rel, sha256(src[k])]))

async function main() {
  console.log('Phase J 遗留修复回归（问候语视角/记录卡兜底/速查空态/flushAll toast/未上云提示/死函数删除）\n')

  await scenario('J1 问候语接爸妈视角：dad 分流优先于孕妈昵称、兜底昵称保留', async () => {
    const g = src.index.match(/const greeting = computed\(\(\) => \{[\s\S]*?\n\}\)/)
    assert.ok(g, 'greeting computed 在场')
    const body = g[0]
    assert.ok(body.includes("collabHomeView.value === 'dad'"), 'dad 视角分支')
    assert.ok(body.includes('return `${hi}，爸爸`'), '爸爸视角措辞')
    const dadAt = body.indexOf("collabHomeView.value === 'dad'")
    const nickAt = body.indexOf("fields?.nickname")
    assert.ok(dadAt > -1 && nickAt > -1 && dadAt < nickAt, 'dad 分支先于昵称兜底（不被昵称覆盖）')
    assert.ok(body.includes("|| '妈妈'"), '妈妈视角昵称缺省兜底保留')
  })

  await scenario('J2 记录卡兜底：family 未填孕期资料时 openEdit 提示不静默', async () => {
    assert.ok(src.index.includes('请先填写孕期资料'), '兜底提示文案在场')
    const seg = src.index.slice(src.index.indexOf('function openEdit'))
    assert.ok(seg.slice(0, 600).includes('heroPregInfoSet.value'), '门条件消费 heroPregInfoSet')
  })

  await scenario('J3 饮食速查模板结构：三态空态文案+动态胶囊消费（行为见 e3 P4）', async () => {
    assert.ok(src.food.includes('已收录，与当前筛选不符'), '分支1：被筛掉≠未收录')
    assert.ok(src.food.includes('该筛选下暂无收录'), '分支2：筛选组合空')
    assert.ok(src.food.includes('未收录此条目'), '分支3：真未收录+AI 入口保留')
    assert.ok(src.food.includes('v-for="p in levelPills"') && !src.food.includes('v-for="p in LEVEL_PILLS"'), '胶囊消费动态 levelPills')
    assert.ok(src.food.includes('levelCounts[p.key]'), '胶囊带实际计数')
  })

  await scenario('J4 重试全部 toast 消费聚合结果：条数/失败原因如实', async () => {
    const seg = src.index.slice(src.index.indexOf('async function handleFlushAll'))
    assert.ok(seg.slice(0, 700).includes('r.sent'), '成功文案带真实条数')
    assert.ok(seg.slice(0, 700).includes('没有待同步项'), '空队列不谎报已重试')
    assert.ok(seg.slice(0, 700).includes('r.message'), '失败透传 flushAll 聚合 message')
    // store 侧聚合语义（行为验证在 b2a"flushAll 聚合"场景）：源码锁定不再恒 ok:true
    const store = fs.readFileSync(path.join(root, 'services/familyStore.js'), 'utf8')
    const fl = store.slice(store.indexOf('async function flushAll'))
    assert.ok(fl.slice(0, 1600).includes('!sessionBroken && failed === 0'), 'ok=全部真实发成')
    assert.ok(fl.slice(0, 1600).includes('项仍待同步'), '失败 message 带计数')
  })

  await scenario('J5 未确认保存提示：本地分支显著区分"未上云"（9-21 事故促成缺口闭合）', async () => {
    assert.ok(src.preginfo.includes('isExplicitDemo') && src.preginfo.includes('isExplicitLoggedOut'), '演示/登出豁免判断 import')
    assert.ok(src.preginfo.includes('localOnly'), 'localOnly 分支变量')
    assert.ok(src.preginfo.includes('已保存至本机（未上云）'), '显著"未上云"文案')
    // 云端成功文案保留（对照分支不受影响）
    assert.ok(src.preginfo.includes('保存成功（家庭共享）'), '云端成功文案保留')
  })

  await scenario('J6 DailyChanges 死函数删除：无 formatDateLabel/props.healthStore 残留', async () => {
    assert.ok(!src.dc.includes('formatDateLabel'), '死函数已删（折算唯一权威=navLabel）')
    assert.ok(!src.dc.includes('props.healthStore'), '未声明 prop 引用随函数消失')
  })

  await scenario('Z9 冻结源哈希：运行期间源未被并发编辑', async () => {
    for (const [rel, h] of Object.entries(frozenHashes)) {
      const now = sha256(fs.readFileSync(path.join(root, rel)))
      assert.equal(now, h, `${rel} 被并发编辑——结果作废须复跑`)
    }
  })

  console.log(`\n${passed} 通过, ${failed.length} 失败`)
  if (failed.length) { console.log('失败项：'); for (const f of failed) console.log(` - ${f}`); process.exit(1) }
  process.exit(0)
}

main().catch(e => { console.error('套件异常:', e); process.exit(2) })
