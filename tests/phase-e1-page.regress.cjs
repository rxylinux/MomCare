// Phase E1 Step 2 页面级回归：真实 fetal-timer.vue / contraction-timer.vue 的 <script setup>
// → esbuild bundle（独立 pinia）→ toolsStore → 真实 mc-tools/mc-health handler。
// 覆盖：页面挂载与绑定、胎动按键（震动反馈/连击合并）与撤销、倒计时绝对时间校准（nowTick 驱动）、
// 暂停门、完成联动当日胎动；宫缩起止切换、持续显示、511 提示卡（正负向+免责声明原文）、
// 就医电话卡片（空号拦截+真实拨号）。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-e1p-'))

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
const healthH = require(path.join(DIST, 'mc-health/index.js'))

// ── 冻结源哈希 ──
const FROZEN_RELS = ['pages/tools/fetal-timer.vue', 'pages/tools/contraction-timer.vue', 'services/toolsStore.js']
const frozenHashes = Object.fromEntries(FROZEN_RELS.map(rel => [rel, sha256(fs.readFileSync(path.join(root, rel)))]))
console.log('冻结源哈希（加载时快照）:')
for (const [rel, h] of Object.entries(frozenHashes)) console.log(`  ${h.slice(0, 8)}  ${rel}`)

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-e1p', MC_MEMBER_MAMA_OPENID: 'oE1PMAMA123456', MC_MEMBER_PAPA_OPENID: 'oE1PPAPA123456' }

// ── Mock 云（版本 CAS 事务）──
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
const uniCalls = { toasts: [], modals: [], calls: [], vibrates: [] }
global.uni = {
  getStorageSync(k) { return storage.has(k) ? storage.get(k) : '' },
  setStorageSync(k, v) { storage.set(k, v) },
  removeStorageSync(k) { storage.delete(k) },
  getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
  showToast: v => uniCalls.toasts.push(v && v.title),
  showModal: o => { uniCalls.modals.push({ title: o && o.title, content: o && o.content, confirmText: o && o.confirmText }); o && o.success && o.success({ confirm: true }) },
  makePhoneCall: o => uniCalls.calls.push(o && o.phoneNumber),
  vibrateShort: () => uniCalls.vibrates.push(1),
  showLoading() {}, hideLoading() {},
  redirectTo() {}, navigateTo() {}, switchTab() {}, reLaunch() {}, navigateBack() {},
  request() {}, uploadFile() {}, downloadFile: o => o.fail && o.fail({ errMsg: 'dl' }),
}

// ── 页面 bundle ──
function scriptBodyOf(vuePath) {
  const src = fs.readFileSync(path.join(root, vuePath), 'utf8')
  const m = src.match(/<script setup>([\s\S]*?)<\/script>/)
  if (!m) throw new Error('无 <script setup>: ' + vuePath)
  return m[1]
}
function buildBundle(vuePath, anchor, exports, outfile) {
  let code = scriptBodyOf(vuePath)
    .replace(/^import .* from ['"][^'"\n]+\.vue['"];?$/mg, '')
    .replace(/import\s*\{\s*onShow\s*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const shows=[];const onShow=fn=>shows.push(fn);')
  code = 'import { createPinia, setActivePinia } from "pinia";\nsetActivePinia(createPinia());\n' + code.replace(anchor, `setActivePinia(createPinia());\n${anchor}`)
  code += '\n' + exports + '\n'
  esbuild.buildSync({ stdin: { contents: code, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile, logLevel: 'silent' })
}
const fetalBundle = path.join(temp, 'page-fetal.cjs')
const contraBundle = path.join(temp, 'page-contra.cjs')
buildBundle(
  'pages/tools/fetal-timer.vue',
  'const toolsStore = useToolsStore()',
  `export {shows,session,validCount,rawCount,nowTick,paused,fetalSessions,remainingText,elapsedText,progressPct,overtime,onStart,onKick,onUndo,onPauseResume,onFinish,onDiscard};export * from './services/toolsStore.js';export * from './services/sessionService.js';export * from './services/familyStore.js';export * from './services/outbox.js';export * from './services/cloudAdapter.js';export * from './utils/cloudConfig.js';`,
  fetalBundle
)
buildBundle(
  'pages/tools/contraction-timer.vue',
  'const toolsStore = useToolsStore()',
  `export {shows,active,nowTick,hospitalName,doctorName,hospitalPhone,recentContractions,avgDurationSec,avgIntervalSec,is511,disclaimer,currentDurationText,onCall,onToggle,onDelete};export * from './services/toolsStore.js';export * from './services/sessionService.js';export * from './services/familyStore.js';export * from './services/outbox.js';export * from './services/cloudAdapter.js';export * from './utils/cloudConfig.js';`,
  contraBundle
)
function loadClient(p) {
  delete require.cache[require.resolve(p)]
  return require(p)
}

const network = { offline: false }
function makeStack() {
  for (const k of [...storage.keys()]) {
    if (k.startsWith('momcare_') || k.startsWith('mc_')) storage.delete(k)
  }
  network.offline = false
  uniCalls.toasts.length = 0; uniCalls.modals.length = 0; uniCalls.calls.length = 0; uniCalls.vibrates.length = 0
  const cloud = makeMockCloud()
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID
  toolsH.__setCloud(cloud); healthH.__setCloud(cloud)
  const routes = {
    'mc-tools': e => toolsH.main(e),
    'mc-health': e => healthH.main(e),
    'mc-identity': () => ({ ok: true, data: { memberId: 'mama', displayName: '妈妈', familyId: TEST_ENV.MC_FAMILY_ID } })
  }
  const wxCloud = {
    init() {},
    callFunction(o) {
      if (network.offline) { o.fail({ errMsg: 'cloud.callFunction:fail offline' }); return }
      const h = routes[o.name]
      if (!h) { o.fail({ errMsg: 'no route' }); return }
      Promise.resolve().then(() => h(o.data)).then(r => o.success({ result: r })).catch(e => o.fail({ errMsg: e.message }))
    }
  }
  return { cloud, wxCloud }
}
async function confirmed(stack, bundlePath) {
  const client = loadClient(bundlePath)
  client.__setCloudConfigForTests('env-e1p', 'wxapp-e1p')
  client.__setWxCloud(stack.wxCloud)
  global.wx = { cloud: stack.wxCloud }
  client.__resetForTests()
  const r = await client.confirmIdentity()
  assert.ok(r.ok, `confirmIdentity: ${JSON.stringify(r).slice(0, 120)}`)
  return client
}

async function main() {
  console.log('Phase E1 Step 2 页面级回归（真实页面 script → toolsStore → 真实 handler）\n')

  await scenario('P1 胎动页：挂载/开始/按键震动/连击合并/撤销/倒计时校准/暂停门/完成联动', async () => {
    const stack = makeStack()
    const client = await confirmed(stack, fetalBundle)
    const page = client
    // 挂载（onShow 注册项执行——restore+retry+pull）
    assert.ok(page.shows.length > 0, 'onShow 已注册')
    for (const fn of page.shows) await fn()
    await tick()
    assert.equal(page.session.value, null, '初始无会话')
    assert.equal(page.fetalSessions.value.length, 0, '历史空态')
    // 开始
    await page.onStart()
    await tick()
    assert.ok(page.session.value && page.session.value.sessionId, '会话建立+服务端 id 采纳')
    // 按键×2（真实毫秒间隔——同窗合并 1）+ 震动反馈
    const v0 = uniCalls.vibrates.length
    await page.onKick()
    await page.onKick()
    await tick()
    assert.equal(page.validCount.value, 1, `两连击合并 1（实得 ${page.validCount.value}）`)
    assert.equal(page.rawCount.value, 2)
    assert.equal(uniCalls.vibrates.length, v0 + 2, '每次有效按键震动反馈')
    // 倒计时：绝对时间差驱动（nowTick 推进 → elapsedText 变化——切后台校准同一语义）
    const before = page.elapsedText.value
    page.nowTick.value = page.session.value.startTime + 10 * 60000
    await tick()
    const after = page.elapsedText.value
    assert.notEqual(before, after, `时钟推进显示刷新（${before}→${after}）`)
    assert.equal(page.elapsedText.value, '10:00', `10 分钟显示精确（实得 ${page.elapsedText.value}）`)
    assert.ok(page.remainingText.value === '50:00', `剩余 50 分钟（实得 ${page.remainingText.value}）`)
    assert.equal(page.progressPct.value, 17, `进度 round(10/60)=17%（实得 ${page.progressPct.value}）`)
    // 撤销（2 击撤 1 → 剩 1 有效 1 原始）
    await page.onUndo()
    await tick()
    assert.equal(page.validCount.value, 1, `撤销后 1 有效（实得 ${page.validCount.value}）`)
    assert.equal(page.rawCount.value, 1, '原始 1')
    // 暂停门：暂停后按键拒绝（零计数零震动）
    page.onPauseResume()
    assert.equal(page.paused.value, true, '已暂停')
    const v1 = uniCalls.vibrates.length
    await page.onKick()
    await tick()
    assert.equal(page.rawCount.value, 1, '暂停期点击不计数')
    assert.equal(uniCalls.vibrates.length, v1, '暂停期无震动')
    page.onPauseResume()
    assert.equal(page.paused.value, false, '继续')
    // 完成：联动当日胎动（同窗点击仍 1 簇）
    await page.onKick()
    await tick()
    assert.equal(page.rawCount.value, 2, '继续后可点击')
    await page.onFinish()
    await tick()
    assert.equal(page.session.value, null, '完成后会话清理')
    assert.equal(page.fetalSessions.value.length, 1, '历史 1 项')
    const dk = page.fetalSessions.value[0].dateKey
    const daily = stack.cloud.__docs.get(`mc_health_daily/${TEST_ENV.MC_FAMILY_ID}:${dk}`)
    assert.ok(daily && daily.fields.fetalCount === 1, `当日胎动联动 1（实得 ${JSON.stringify(daily && daily.fields)}）`)
    // 放弃（新会话）+ 二次确认
    await page.onStart(); await tick()
    uniCalls.modals.length = 0
    await page.onDiscard()
    await tick()
    assert.equal(uniCalls.modals.length, 1, '放弃二次确认')
    assert.equal(page.session.value, null, '放弃后会话清理')
    assert.equal(page.fetalSessions.value.filter(x => x.status === 'discarded').length, 1, '历史含废弃 1 项')
  })

  await scenario('P2 宫缩页：医院卡片（空号拦截/真实拨号）/起止切换/持续显示/时间线/删除', async () => {
    const stack = makeStack()
    const client = await confirmed(stack, contraBundle)
    const page = client
    for (const fn of page.shows) await fn()
    await tick()
    // 无档案：未设置 + 空号拦截
    assert.equal(page.hospitalName.value, '未设置', '无档案医院=未设置')
    assert.equal(page.doctorName.value, '未设置')
    assert.equal(page.hospitalPhone.value, '')
    page.onCall()
    assert.equal(uniCalls.calls.length, 0, '空号不拨出')
    assert.ok(uniCalls.modals.length >= 1 && String(uniCalls.modals[uniCalls.modals.length - 1].content).includes('尚未在孕期档案中填写就医电话，请先去完善'), '空号提示原文')
    // 种档案 → 页面 familyStore 拉取 → 卡片真实读取
    const seed = await healthH.main({ action: 'pregnancy.upsert', schemaVersion: 1, operationId: 'e1p-preg', expectedRevision: 0, payload: { hospital: '市妇幼保健院', doctor: '王医生', hospitalPhone: '0571-12345678' } })
    assert.ok(seed.ok, '档案种子')
    const fam = client.useFamilyStore()
    await fam.pullAll()
    assert.equal(page.hospitalName.value, '市妇幼保健院')
    assert.equal(page.doctorName.value, '王医生')
    assert.equal(page.hospitalPhone.value, '0571-12345678')
    page.onCall()
    assert.equal(uniCalls.calls[0], '0571-12345678', '拨出真实档案号码')
    // 起止切换
    assert.equal(page.active.value, null, '初始无活跃')
    const v0 = uniCalls.vibrates.length
    await page.onToggle()
    await tick()
    assert.ok(page.active.value && page.active.value.recordId, '开始→活跃+服务端 id')
    assert.equal(uniCalls.vibrates.length, v0 + 1, '开始震动反馈')
    // 持续显示（nowTick 驱动）
    page.nowTick.value = page.active.value.startTime + 95000
    await tick()
    assert.equal(page.currentDurationText.value, '1 分 35 秒', `持续显示（实得 ${page.currentDurationText.value}）`)
    await page.onToggle()
    await tick()
    assert.equal(page.active.value, null, '结束→活跃清理')
    assert.equal(page.recentContractions.value.length, 1, '时间线 1 条')
    assert.ok(Number.isInteger(page.recentContractions.value[0].durationSec), '页面起止记录时长为整数秒（真实时钟差）')
    // 服务端直种历史（真实时钟锚点）→ 拉取 → 删除交互
    const now = Date.now()
    {
      const r1 = await toolsH.main({ action: 'contraction.start', startTime: now - 10 * 60000, operationId: 'e1p-c1' })
      await toolsH.main({ action: 'contraction.stop', recordId: r1.data.record.recordId, endTime: now - 10 * 60000 + 60000, expectedRevision: 1, operationId: 'e1p-c1s' })
      const r2 = await toolsH.main({ action: 'contraction.start', startTime: now - 4 * 60000, operationId: 'e1p-c2' })
      await toolsH.main({ action: 'contraction.stop', recordId: r2.data.record.recordId, endTime: now - 4 * 60000 + 70000, expectedRevision: 1, operationId: 'e1p-c2s' })
    }
    const store = client.useToolsStore()
    await store.pullContractions()
    assert.equal(page.recentContractions.value.length, 3, `时间线 3 条（实得 ${page.recentContractions.value.length}）`)
    // 服务端种子的时长精确呈现（60s/70s）
    const durations = page.recentContractions.value.map(r => r.durationSec).sort((a, b) => a - b)
    assert.ok(durations.includes(60) && durations.includes(70), `种子时长呈现（实得 ${JSON.stringify(durations)}）`)
    const victim = page.recentContractions.value.find(r => r.recordId)
    uniCalls.modals.length = 0
    await page.onDelete(victim)
    await tick()
    assert.equal(uniCalls.modals.length, 1, '删除二次确认')
    assert.equal(page.recentContractions.value.length, 2, '删除后 2 条')
  })

  await scenario('P3 宫缩页 511 提示卡：正负向+免责声明原文', async () => {
    const stack = makeStack()
    const client = await confirmed(stack, contraBundle)
    const page = client
    const store = client.useToolsStore()
    // 负向（无记录）
    assert.equal(page.is511.value, false, '空记录不满足')
    // 正向：近 55 分钟 12 次、间隔 5min、持续 60s（真实时钟基准）
    const now = Date.now()
    const mk = (offsetMin, dur) => ({
      recordId: `cnt_p3_${offsetMin}`, status: 'finished', synced: true,
      startTime: now - offsetMin * 60000, endTime: now - offsetMin * 60000 + dur * 1000,
      durationSec: dur, intervalSec: 300
    })
    store.contractionRecords = Array.from({ length: 12 }, (_, i) => mk(55 - i * 5, 60))
    assert.equal(page.is511.value, true, `正向 511（实得 ${page.is511.value}）`)
    assert.equal(page.avgDurationSec.value, 60, '平均持续 60s')
    assert.equal(page.avgIntervalSec.value, 300, '平均间隔 300s')
    // 免责声明原文（store 常量直出——模板同源渲染）
    assert.equal(page.disclaimer, '✦ 511 规则仅作为辅助参考，不构成医疗诊断。若出现破水、剧烈出血或异常剧痛，无论是否符合规律，请立即前往医院就医！', '免责声明精确')
    // 负向：仅间隔不满足
    store.contractionRecords = Array.from({ length: 8 }, (_, i) => mk(56 - i * 8, 60))
    assert.equal(page.is511.value, false, '间隔 ~8min 不满足')
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
