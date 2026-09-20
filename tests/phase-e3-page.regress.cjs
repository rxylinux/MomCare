// Phase E3 页面级回归：真实 food-safety.vue <script setup> → toolsStore → 真实 mc-tools（__setAiMock）。
// 覆盖：页面渲染绑定、即时搜索与一键清除、分类 tab 与级别胶囊切换、详情折叠、
// 诚实空态文案（绝不假标安全）+ AI 咨询入口、AI 面板（未启用如实提示/启用带标签免责）、底部免责声明。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-e3p-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')
const tick = () => new Promise(r => setTimeout(r, 30))

require('node:child_process').execFileSync('node', [path.join(root, 'cloud/assemble.mjs')], { stdio: 'pipe' })
const DIST = path.join(root, 'dist/cloud-functions')
const toolsH = require(path.join(DIST, 'mc-tools/index.js'))

const FROZEN_RELS = ['pages/tools/food-safety.vue', 'services/toolsStore.js']
const frozenHashes = Object.fromEntries(FROZEN_RELS.map(rel => [rel, sha256(fs.readFileSync(path.join(root, rel)))]))
console.log('冻结源哈希（加载时快照）:')
for (const [rel, h] of Object.entries(frozenHashes)) console.log(`  ${h.slice(0, 8)}  ${rel}`)

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-e3p', MC_MEMBER_MAMA_OPENID: 'oE3PMAMA123456', MC_MEMBER_PAPA_OPENID: 'oE3PPAPA123456' }

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
    collection: c => ({ doc: id => docApi(c, id, null) })
  }
  return {
    DYNAMIC_CURRENT_ENV: Symbol('env'), init() { state.initialized = true },
    getWXContext: () => ({ APPID: TEST_ENV.MC_APPID, OPENID: state.caller }),
    database() { if (!state.initialized) throw new Error('init first'); return db },
    __docs: docs, __state: state, __setCtx(o) { state.caller = o },
  }
}

const storage = new Map()
const uniCalls = { toasts: [], modals: [] }
global.uni = {
  getStorageSync(k) { return storage.has(k) ? storage.get(k) : '' },
  setStorageSync(k, v) { storage.set(k, v) },
  removeStorageSync(k) { storage.delete(k) },
  getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
  showToast: v => uniCalls.toasts.push(v && v.title),
  showModal: o => { uniCalls.modals.push({ title: o && o.title, content: o && o.content }); o && o.success && o.success({ confirm: true }) },
  makePhoneCall() {}, vibrateShort() {}, showLoading() {}, hideLoading() {},
  redirectTo() {}, navigateTo() {}, switchTab() {}, reLaunch() {}, navigateBack() {},
  request() {}, uploadFile() {}, downloadFile: o => o.fail && o.fail({ errMsg: 'dl' }),
}

// ── 页面 bundle ──
const pageBundle = path.join(temp, 'page-food.cjs')
{
  const src = fs.readFileSync(path.join(root, 'pages/tools/food-safety.vue'), 'utf8')
  const body = src.match(/<script setup>([\s\S]*?)<\/script>/)[1]
  let code = body
    .replace(/^import .* from ['"][^'"\n]+\.vue['"];?$/mg, '')
    .replace(/import\s*\{\s*onShow\s*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const shows=[];const onShow=fn=>shows.push(fn);')
  code = 'import { createPinia, setActivePinia } from "pinia";\nsetActivePinia(createPinia());\n' + code.replace('const toolsStore = useToolsStore()', 'setActivePinia(createPinia());\nconst toolsStore = useToolsStore()')
  code += `\nexport {shows,keyword,category,level,expanded,aiState,results,clearKeyword,toggleDetail,onAskAi,levelLabel,AI_MEDICAL_DISCLAIMER,AI_LABEL,CATEGORY_TABS,LEVEL_PILLS};\n` +
    `export * from './services/toolsStore.js';\nexport * from './services/sessionService.js';\nexport * from './services/familyStore.js';\nexport * from './services/outbox.js';\nexport * from './services/cloudAdapter.js';\nexport * from './utils/cloudConfig.js';\n`
  esbuild.buildSync({ stdin: { contents: code, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: pageBundle, logLevel: 'silent' })
}
function loadClient() {
  delete require.cache[require.resolve(pageBundle)]
  return require(pageBundle)
}

function makeStack() {
  for (const k of [...storage.keys()]) {
    if (k.startsWith('momcare_') || k.startsWith('mc_')) storage.delete(k)
  }
  uniCalls.toasts.length = 0; uniCalls.modals.length = 0
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
  client.__setCloudConfigForTests('env-e3p', 'wxapp-e3p')
  client.__setWxCloud(stack.wxCloud)
  global.wx = { cloud: stack.wxCloud }
  client.__resetForTests()
  const r = await client.confirmIdentity()
  assert.ok(r.ok, `confirmIdentity: ${JSON.stringify(r).slice(0, 120)}`)
  return client
}

async function main() {
  console.log('Phase E3 页面级回归（food-safety 页 → toolsStore → 真实 mc-tools）\n')

  await scenario('P1 渲染与即时搜索：搜索响应/一键清除/分类与级别切换', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const page = client
    // 初始：空关键词全量
    assert.ok(page.results.value.length >= 13, `初始全量（实得 ${page.results.value.length}）`)
    // 即时搜索（响应式——无需等待网络）
    page.keyword.value = '溏心蛋'
    await tick()
    assert.equal(page.results.value.length, 1, '「溏心蛋」即时命中')
    assert.equal(page.results.value[0].id, 'food_raw_egg_soft')
    page.keyword.value = '拿铁'
    await tick()
    assert.equal(page.results.value.length, 1) && assert.equal(page.results.value[0].id, 'food_caffeine')
    // 一键清除 → 回全量
    page.clearKeyword()
    await tick()
    assert.equal(page.keyword.value, '', '清除')
    assert.ok(page.results.value.length >= 13, '清除后全量')
    // 分类 tab
    page.category.value = 'behavior'
    await tick()
    assert.ok(page.results.value.length >= 4 && page.results.value.every(x => x.category === 'behavior'), '行为分类')
    page.category.value = 'food'
    // 级别胶囊
    page.level.value = 'avoid'
    await tick()
    assert.ok(page.results.value.every(x => x.level === 'avoid') && page.results.value.length >= 3, '避免级别过滤')
    page.level.value = ''
    page.category.value = 'all'
    // 组合
    page.keyword.value = '蛋'; page.category.value = 'food'; page.level.value = 'avoid'
    await tick()
    assert.ok(page.results.value.length >= 1 && page.results.value.every(x => x.category === 'food' && x.level === 'avoid' && (String(x.name).includes('蛋') || (x.synonyms || []).some(s => String(s).includes('蛋')))), '关键词×分类×级别组合')
  })

  await scenario('P2 详情折叠/展开与底部免责声明', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const page = client
    const first = page.results.value[0]
    assert.equal(page.expanded[first.id], undefined, '初始折叠')
    page.toggleDetail(first.id)
    assert.equal(page.expanded[first.id], true, '展开')
    page.toggleDetail(first.id)
    assert.equal(page.expanded[first.id], false, '再点折叠')
    // 级别标签映射
    assert.equal(page.levelLabel('safe'), '安全')
    assert.equal(page.levelLabel('caution'), '注意')
    assert.equal(page.levelLabel('avoid'), '避免')
    assert.equal(page.levelLabel('insufficient'), '资料不足')
    // 底部免责声明（固定渲染常量——模板同源）
    assert.ok(String(page.AI_MEDICAL_DISCLAIMER).includes('不构成医疗诊断'), '底部免责含医疗声明')
    assert.ok(String(page.AI_MEDICAL_DISCLAIMER).includes('产检医生'), '免责以产检医生为准')
    // 级别胶囊/分类 tab 配置完备
    assert.deepEqual(page.CATEGORY_TABS.map(t => t.key), ['all', 'food', 'behavior'])
    assert.deepEqual(page.LEVEL_PILLS.map(p => p.key), ['', 'safe', 'caution', 'avoid', 'insufficient'])
  })

  await scenario('P3 诚实空态+AI 咨询入口：未启用如实提示/启用带标签免责', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const page = client
    // 未收录 → 空态 + AI 入口
    page.keyword.value = '不存在的词条QQQ'
    await tick()
    assert.equal(page.results.value.length, 0, '未收录结果空')
    assert.equal(page.aiState.visible, false, 'AI 面板初始不可见')
    // 未启用：如实提示（不假造答案）
    await page.onAskAi()
    await tick()
    assert.equal(page.aiState.visible, true, 'AI 面板可见')
    assert.equal(page.aiState.enabled, false, '未启用状态如实')
    assert.ok(String(page.aiState.text).includes('未配置'), `未启用提示（实得 ${page.aiState.text}）`)
    assert.ok(!String(page.aiState.text).includes('安全'), '未启用绝不输出安全结论')
    // 清除后空态复位
    page.clearKeyword()
    assert.equal(page.aiState.visible, false, '清除复位')
    // 启用（mock）：答案+标签免责
    page.keyword.value = '能量饮料'
    await tick()
    toolsH.__setAiMock(async () => 'MOCK：能量饮料通常含高咖啡因，建议避免。')
    await page.onAskAi()
    await tick()
    assert.equal(page.aiState.enabled, true, '启用状态')
    assert.ok(String(page.aiState.text).includes('MOCK'), '答案呈现')
    // AI 标签常量（面板醒目标签——模板同源）
    assert.equal(page.AI_LABEL, 'AI 生成（未人工逐字审校）', 'AI 标签精确')
    toolsH.__setAiMock(null)
    // 服务端失败传播（mock 抛错）
    toolsH.__setAiMock(async () => { throw new Error('boom') })
    await page.onAskAi()
    await tick()
    assert.equal(page.aiState.enabled, false, '失败态如实')
    assert.ok(!String(page.aiState.text).includes('MOCK 答'), '失败不显示答案')
    toolsH.__setAiMock(null)
  })

  await scenario('Z9 冻结源哈希：运行期间页面/store 源未被并发编辑', async () => {
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
