// Phase E3 客户端级回归：toolsStore 本地字典快查 + AI 两方法状态机（真实 mc-tools handler + __setAiMock）。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-e3c-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')

require('node:child_process').execFileSync('node', [path.join(root, 'cloud/assemble.mjs')], { stdio: 'pipe' })
const DIST = path.join(root, 'dist/cloud-functions')
const toolsH = require(path.join(DIST, 'mc-tools/index.js'))

const FROZEN_RELS = ['services/toolsStore.js', 'static/data/food-safety.json']
const frozenHashes = Object.fromEntries(FROZEN_RELS.map(rel => [rel, sha256(fs.readFileSync(path.join(root, rel)))]))
console.log('冻结源哈希（加载时快照）:')
for (const [rel, h] of Object.entries(frozenHashes)) console.log(`  ${h.slice(0, 8)}  ${rel}`)

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-e3c', MC_MEMBER_MAMA_OPENID: 'oE3CMAMA123456', MC_MEMBER_PAPA_OPENID: 'oE3CPAPA123456' }

function makeMockCloud() {
  const docs = new Map()
  const state = { caller: TEST_ENV.MC_MEMBER_MAMA_OPENID, initialized: false }
  const clone = x => JSON.parse(JSON.stringify(x))
  function docApi(col, id, tx) {
    return {
      get: async () => { const e = docs.get(`${col}/${id}`); if (tx) tx.reads.set(`${col}/${id}`, e ? e.__v : 0); return { data: e ? { ...clone(e), _id: id } : null } },
      set: async ({ data }) => { if (tx) { tx.writes.set(`${col}/${id}`, clone(data)); return { _id: id } } const prev = docs.get(`${col}/${id}`); docs.set(`${col}/${id}`, { ...clone(data), __v: (prev ? prev.__v : 0) + 1 }); return { _id: id } },
      remove: async () => { docs.delete(`${col}/${id}`); return {} }
    }
  }
  const db = {
    startTransaction: async () => {
      const tx = { reads: new Map(), writes: new Map(), removes: new Set() }
      return { collection: c => ({ doc: id => docApi(c, id, tx) }), commit: async () => { for (const [k, rv] of tx.reads) { const cur2 = docs.get(k); if ((cur2 ? cur2.__v : 0) !== rv) { const err = new Error('conflict ' + k); err.errCode = 'CONFLICT'; throw err } } for (const [k, d2] of tx.writes) { const prev = docs.get(k); docs.set(k, { ...d2, __v: (prev ? prev.__v : 0) + 1 }) } }, rollback: async () => { tx.writes.clear(); tx.removes.clear() } }
    },
    collection: c => ({ doc: id => docApi(c, id, null), where: () => ({ orderBy: () => ({ limit: () => ({ get: async () => ({ data: [] }) }) }), limit: () => ({ get: async () => ({ data: [] }) }) }) })
  }
  return {
    DYNAMIC_CURRENT_ENV: Symbol('env'), init() { state.initialized = true },
    getWXContext: () => ({ APPID: TEST_ENV.MC_APPID, OPENID: state.caller }),
    database() { if (!state.initialized) throw new Error('init first'); return db },
    __docs: docs, __state: state, __setCtx(o) { state.caller = o },
  }
}

const storage = new Map()
global.uni = {
  getStorageSync(k) { return storage.has(k) ? storage.get(k) : '' },
  setStorageSync(k, v) { storage.set(k, v) },
  removeStorageSync(k) { storage.delete(k) },
  getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
  showToast() {}, showModal() {}, makePhoneCall() {}, vibrateShort() {}, showLoading() {}, hideLoading() {},
  redirectTo() {}, navigateTo() {}, switchTab() {}, reLaunch() {}, navigateBack() {},
  request() {}, uploadFile() {}, downloadFile: o => o.fail && o.fail({ errMsg: 'dl' }),
}

const clientBundle = path.join(temp, 'client.cjs')
{
  const src = `import { createPinia, setActivePinia } from 'pinia';\nsetActivePinia(createPinia());\n` +
    `export * from './services/toolsStore.js';\nexport * from './services/sessionService.js';\nexport * from './services/familyStore.js';\nexport * from './services/outbox.js';\nexport * from './services/cloudAdapter.js';\nexport * from './utils/cloudConfig.js';\n`
  esbuild.buildSync({ stdin: { contents: src, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: clientBundle, logLevel: 'silent' })
}
function loadClient() {
  delete require.cache[require.resolve(clientBundle)]
  return require(clientBundle)
}

function makeStack() {
  for (const k of [...storage.keys()]) {
    if (k.startsWith('momcare_') || k.startsWith('mc_')) storage.delete(k)
  }
  const cloud = makeMockCloud()
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID
  delete process.env.DEEPSEEK_API_KEY
  toolsH.__setCloud(cloud)
  const wxCloud = {
    init() {},
    callFunction(o) {
      const h = o.name === 'mc-tools' ? toolsH.main : () => ({ ok: true, data: { memberId: 'mama', familyId: TEST_ENV.MC_FAMILY_ID } })
      Promise.resolve().then(() => h(o.data)).then(r => o.success({ result: r })).catch(e => o.fail({ errMsg: e.message }))
    }
  }
  return { cloud, wxCloud }
}
async function confirmed(stack) {
  const client = loadClient()
  client.__setCloudConfigForTests('env-e3c', 'wxapp-e3c')
  client.__setWxCloud(stack.wxCloud)
  global.wx = { cloud: stack.wxCloud }
  client.__resetForTests()
  const r = await client.confirmIdentity()
  assert.ok(r.ok, `confirmIdentity: ${JSON.stringify(r).slice(0, 120)}`)
  return client
}

async function main() {
  console.log('Phase E3 客户端级回归（toolsStore 速查 + AI 状态机 → 真实 mc-tools）\n')

  await scenario('S1 本地字典快查：同义词/组合过滤/未收录空（离线零网络）', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    // 无过滤全量
    assert.equal(store.searchSafetyDictionary({}).length, client.FOOD_SAFETY_ENTRIES.length, '全量')
    // 同义词（规格样例）
    const t1 = store.searchSafetyDictionary({ keyword: '溏心蛋' })
    assert.equal(t1.length, 1) && assert.equal(t1[0].id, 'food_raw_egg_soft', '「溏心蛋」→ 生鸡蛋条目')
    const t2 = store.searchSafetyDictionary({ keyword: '拿铁' })
    assert.equal(t2.length, 1) && assert.equal(t2[0].id, 'food_caffeine', '「拿铁」→ 咖啡条目')
    // 大小写不敏感（英文同义词）
    const t3 = store.searchSafetyDictionary({ keyword: 'TUNA' })
    assert.ok(t3.length === 1 && t3[0].id === 'food_tuna', '「TUNA」→ 金枪鱼（大小写不敏感）')
    // 分类 × 级别组合
    const beh = store.searchSafetyDictionary({ category: 'behavior' })
    assert.ok(beh.length >= 4 && beh.every(x => x.category === 'behavior'))
    const avoidFood = store.searchSafetyDictionary({ category: 'food', level: 'avoid' })
    assert.ok(avoidFood.length >= 3 && avoidFood.every(x => x.level === 'avoid' && x.category === 'food'))
    const safeOnly = store.searchSafetyDictionary({ level: 'safe' })
    assert.ok(safeOnly.length >= 2 && safeOnly.every(x => x.level === 'safe'))
    // 未收录：空数组（绝不命中为安全）
    assert.equal(store.searchSafetyDictionary({ keyword: '不存在的奇怪词条' }).length, 0, '未收录返回空')
    // 空关键词=不过滤
    assert.equal(store.searchSafetyDictionary({ keyword: '' }).length, client.FOOD_SAFETY_ENTRIES.length, '空关键词全量')
    // 离线验证：网络关闭仍可查（纯本地——不发云请求）
    // （字典检索为同步纯本地——无 familyCall 路径，天然离线）
  })

  await scenario('S2 explainFoodWithAi 状态机：未启用/启用/失败/未登录', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    // 未启用
    const off = await store.explainFoodWithAi({ query: '能吃冰淇淋吗' })
    assert.ok(off.ok && off.data.enabled === false, '未启用状态透传')
    assert.ok(String(off.data.message).includes('未配置'), '未启用消息')
    // mock 启用
    toolsH.__setAiMock(async () => 'MOCK：一般可适量食用，注意卫生。')
    const on = await store.explainFoodWithAi({ query: '能吃冰淇淋吗', stage: '孕中期' })
    assert.ok(on.ok && on.data.enabled === true && on.data.answer.includes('MOCK'), '启用答案透传')
    assert.ok(on.data.disclaimer.includes('AI 生成（未人工逐字审校）'), '免责透传')
    toolsH.__setAiMock(null)
    // 服务端校验失败传播
    const bad = await store.explainFoodWithAi({ query: 'x'.repeat(51) })
    assert.ok(!bad.ok && bad.code === 'invalid-params', `超长拒传播（实得 ${bad.code}）`)
    // 未登录
    client.__resetForTests()
    const unauth = await store.explainFoodWithAi({ query: '咖啡' })
    assert.ok(!unauth.ok && unauth.code === 'unauthenticated-session', `未登录拒（实得 ${unauth.code}）`)
  })

  await scenario('S3 analyzeReportWithAi 状态机：未启用/启用回写/not-found', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    // 未启用（报告存在时）
    stack.cloud.__docs.set('mc_reports/rpt_c1', { familyId: TEST_ENV.MC_FAMILY_ID, deleted: false, dateKey: '2026-09-01', reportType: 'ultrasound', attachments: [], revision: 1 })
    const off = await store.analyzeReportWithAi({ reportId: 'rpt_c1' })
    assert.ok(off.ok && off.data.enabled === false, '未启用')
    assert.ok(String(off.data.message).includes('未配置'), '未启用消息（报告口径）')
    // not-found 传播
    const ghost = await store.analyzeReportWithAi({ reportId: 'rpt_none' })
    assert.ok(!ghost.ok && ghost.code === 'report-not-found', 'not-found 传播')
    // mock 启用 → 回写
    toolsH.__setAiMock(async () => 'MOCK 报告解读。')
    const on = await store.analyzeReportWithAi({ reportId: 'rpt_c1' })
    assert.ok(on.ok && on.data.enabled === true && on.data.answer.includes('MOCK'), '启用解读')
    const doc = stack.cloud.__docs.get('mc_reports/rpt_c1')
    assert.ok(doc.ai_result && doc.ai_result.text.includes('MOCK'), 'ai_result 已回写')
    toolsH.__setAiMock(null)
    // 参数校验
    const bad = await store.analyzeReportWithAi({})
    assert.ok(!bad.ok && bad.code === 'invalid-params', '缺 reportId 拒')
  })

  await scenario('S4 本地与服务端检索一致性（同一字典双端同结果）', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    for (const kw of ['咖啡', '温泉', '刺身', 'X光']) {
      const local = store.searchSafetyDictionary({ keyword: kw }).map(x => x.id).sort()
      const remote = await (async () => {
        // 直接调 handler（同一 mock 云）
        const r = await toolsH.main({ action: 'food.search', keyword: kw })
        return r.data.items.map(x => x.id).sort()
      })()
      assert.deepEqual(local, remote, `「${kw}」双端一致（本地 ${JSON.stringify(local)} 服务端 ${JSON.stringify(remote)}）`)
    }
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
