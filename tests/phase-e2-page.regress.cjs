// Phase E2 页面级回归：真实 ultrasound-weight.vue <script setup> → toolsStore → 真实 mc-tools。
// 覆盖：输入双向绑定+实时计算；单位切换即时重算（值换算+等价输出）；免责声明原文；保存/历史/删除交互。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-e2p-'))

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

const FROZEN_RELS = ['pages/tools/ultrasound-weight.vue', 'services/toolsStore.js']
const frozenHashes = Object.fromEntries(FROZEN_RELS.map(rel => [rel, sha256(fs.readFileSync(path.join(root, rel)))]))
console.log('冻结源哈希（加载时快照）:')
for (const [rel, h] of Object.entries(frozenHashes)) console.log(`  ${h.slice(0, 8)}  ${rel}`)

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-e2p', MC_MEMBER_MAMA_OPENID: 'oE2PMAMA123456', MC_MEMBER_PAPA_OPENID: 'oE2PPAPA123456' }

function makeMockCloud() {
  const docs = new Map()
  const state = { caller: TEST_ENV.MC_MEMBER_MAMA_OPENID, initialized: false }
  const clone = x => JSON.parse(JSON.stringify(x))
  function docApi(col, id, tx) {
    return {
      get: async () => { const e = docs.get(`${col}/${id}`); if (tx) tx.reads.set(`${col}/${id}`, e ? e.__v : 0); return { data: e ? { ...clone(e), _id: id } : null } },
      set: async ({ data }) => {
        if (data && Object.prototype.hasOwnProperty.call(data, '_id')) { const err = new Error('-501007'); err.errMsg = err.message; throw err }
        if (tx) { tx.writes.set(`${col}/${id}`, clone(data)); return { _id: id } }
        const prev = docs.get(`${col}/${id}`)
        docs.set(`${col}/${id}`, { ...clone(data), __v: (prev ? prev.__v : 0) + 1 }); return { _id: id }
      },
      remove: async () => { if (tx) { tx.removes.add(`${col}/${id}`); return {} } docs.delete(`${col}/${id}`); return {} }
    }
  }
  function runQuery(col, filters, ob, d, l) {
    let rows = [...docs.entries()].filter(([k]) => k.startsWith(col + '/')).map(([k, e]) => ({ ...clone(e), _id: k.slice(col.length + 1) }))
    for (const [k2, c2] of Object.entries(filters || {})) rows = rows.filter(x => c2 && (c2.__op === 'lt' || c2.__op === 'gt')
      ? (x[k2] !== undefined && (c2.__op === 'lt' ? String(x[k2]) < String(c2.v) : String(x[k2]) > String(c2.v)))
      : JSON.stringify(x[k2]) === JSON.stringify(c2))
    if (ob) { rows.sort((a, b) => String(b[ob]).localeCompare(String(a[ob]))); if (String(d).toLowerCase() === 'asc') rows.reverse() }
    return rows.slice(0, l || 100)
  }
  function mq(col, f, ob, d, l) { return { orderBy: (x, y) => mq(col, f, x, y, l), limit: n => mq(col, f, ob, d, n), get: async () => ({ data: runQuery(col, f, ob, d, l) }) } }
  const db = {
    command: { lt: v => ({ __op: 'lt', v }), gt: v => ({ __op: 'gt', v }) },
    startTransaction: async () => {
      const tx = { reads: new Map(), writes: new Map(), removes: new Set() }
      return {
        collection: c => ({ doc: id => docApi(c, id, tx) }),
        commit: async () => {
          for (const [k, rv] of tx.reads) {
            const cur2 = docs.get(k)
            if ((cur2 ? cur2.__v : 0) !== rv) { const err = new Error('transaction conflict: ' + k); err.errCode = 'CONFLICT'; throw err }
          }
          for (const k of tx.removes) docs.delete(k)
          for (const [k, d2] of tx.writes) { const prev = docs.get(k); docs.set(k, { ...d2, __v: (prev ? prev.__v : 0) + 1 }) }
        },
        rollback: async () => { tx.writes.clear(); tx.removes.clear() },
      }
    },
    collection: c => ({ doc: id => docApi(c, id, null), where: f => mq(c, f), get: async () => ({ data: runQuery(c, {}) }) })
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
  showModal: o => { uniCalls.modals.push({ title: o && o.title, content: o && o.content, confirmText: o && o.confirmText }); o && o.success && o.success({ confirm: true }) },
  makePhoneCall() {}, vibrateShort() {}, showLoading() {}, hideLoading() {},
  redirectTo() {}, navigateTo() {}, switchTab() {}, reLaunch() {}, navigateBack() {},
  request() {}, uploadFile() {}, downloadFile: o => o.fail && o.fail({ errMsg: 'dl' }),
}

// ── 页面 bundle ──
const pageBundle = path.join(temp, 'page-efw.cjs')
{
  const src = fs.readFileSync(path.join(root, 'pages/tools/ultrasound-weight.vue'), 'utf8')
  const body = src.match(/<script setup>([\s\S]*?)<\/script>/)[1]
  let code = body
    .replace(/^import .* from ['"][^'"\n]+\.vue['"];?$/mg, '')
    .replace(/import\s*\{\s*onShow\s*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const shows=[];const onShow=fn=>shows.push(fn);')
  code = 'import { createPinia, setActivePinia } from "pinia";\nsetActivePinia(createPinia());\n' + code.replace('const toolsStore = useToolsStore()', 'setActivePinia(createPinia());\nconst toolsStore = useToolsStore()')
  code += `\nexport {shows,form,result,canSave,saving,setUnit,onSave,onDelete,DISCLAIMER,efwRecords,unitPlaceholder};\n` +
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
  client.__setCloudConfigForTests('env-e2p', 'wxapp-e2p')
  client.__setWxCloud(stack.wxCloud)
  global.wx = { cloud: stack.wxCloud }
  client.__resetForTests()
  const r = await client.confirmIdentity()
  assert.ok(r.ok, `confirmIdentity: ${JSON.stringify(r).slice(0, 120)}`)
  return client
}
const efwDocs = st => [...st.cloud.__docs.entries()].filter(([k]) => k.startsWith('mc_efw_records/')).map(([k, v]) => ({ _id: k.split('/')[1], ...v }))

async function main() {
  console.log('Phase E2 页面级回归（ultrasound-weight 页 → toolsStore → 真实 mc-tools）\n')

  await scenario('P1 输入双向绑定+实时计算+锚点呈现+±10% 区间', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const page = client
    assert.equal(page.result.value, null, '空输入无结果')
    // 输入绑定（reactive form）→ 实时计算
    page.form.hc = '32'; page.form.ac = '30'; page.form.fl = '6.5'
    await tick()
    assert.ok(page.result.value && !page.result.value.err, `结果就绪（实得 ${JSON.stringify(page.result.value).slice(0, 120)}）`)
    assert.equal(page.result.value.efwGrams, 2364, `锚点 2364g（实得 ${page.result.value.efwGrams}）`)
    assert.equal(page.result.value.efwKg, 2.364, '公斤 2.364')
    assert.deepEqual(page.result.value.rangeGrams, { low: 2128, high: 2601 }, '±10% 参考区间')
    assert.ok(String(page.result.value.formula).includes('hadlock_hc_ac_fl_1985_v1'), '公式标识展示')
    // 非法输入呈现错误
    page.form.hc = '99'
    await tick()
    assert.ok(page.result.value.err, '超界输入显示错误')
    page.form.hc = '32'
    await tick()
    assert.ok(!page.result.value.err, '恢复有效')
  })

  await scenario('P2 单位切换即时重算：已填值 ×10 换算+输出等价；往返一致', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const page = client
    page.form.hc = '32'; page.form.ac = '30'; page.form.fl = '6.5'; page.form.bpd = '8.8'
    await tick()
    const before = page.result.value.efwGrams
    page.setUnit('mm')
    await tick()
    assert.equal(page.form.unit, 'mm', '单位切换')
    assert.equal(page.form.hc, '320', `HC 值换算 ×10（实得 ${page.form.hc}）`)
    assert.equal(page.form.ac, '300') && assert.equal(page.form.fl, '65') && assert.equal(page.form.bpd, '88')
    assert.equal(page.result.value.efwGrams, before, 'mm 等价输出（2364 不变）')
    // 往返
    page.setUnit('cm')
    await tick()
    assert.equal(page.form.hc, '32') && assert.equal(page.form.fl, '6.5')
    assert.equal(page.result.value.efwGrams, before, '往返一致')
    // BPD 占位符随单位
    assert.ok(String(page.unitPlaceholder.value).includes('mm') === (page.form.unit === 'mm'), '占位符随单位')
  })

  await scenario('P3 免责声明原文+保存/历史/删除交互', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const page = client
    assert.equal(page.DISCLAIMER, '✦ 估算结果基于统计学回归公式，受超声切面与胎儿体位影响存在 ±10%~15% 误差，仅供参考，不可替代产科超声医生的临床诊断！', '免责声明原文精确')
    // 保存门：缺孕周不可保存
    page.form.hc = '32'; page.form.ac = '30'; page.form.fl = '6.5'
    await tick()
    assert.equal(page.canSave.value, false, '缺孕周不可保存')
    page.form.week = '32'
    await tick()
    assert.equal(page.canSave.value, true, '孕周齐备可保存')
    await page.onSave()
    await tick()
    assert.equal(efwDocs(stack).length, 1, '服务端落盘 1 条')
    assert.equal(efwDocs(stack)[0].efwGrams, 2364, '服务端权威 2364')
    assert.equal(page.efwRecords.value.length, 1, '历史渲染 1 条')
    assert.equal(page.efwRecords.value[0].gestationalWeek, 32)
    // 非法孕周门
    page.form.week = '45'
    await tick()
    assert.equal(page.canSave.value, false, '孕周 45 不可保存')
    page.form.week = '32'
    // 删除（二次确认自动确认）
    uniCalls.modals.length = 0
    await page.onDelete(page.efwRecords.value[0])
    await tick()
    assert.equal(uniCalls.modals.length, 1, '删除二次确认')
    assert.equal(page.efwRecords.value.length, 0, '删除后历史空')
    assert.equal(efwDocs(stack).filter(d => d.status !== 'discarded').length, 0, '服务端软删除')
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
