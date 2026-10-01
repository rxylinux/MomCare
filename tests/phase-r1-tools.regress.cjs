// R1 工具本地持久化与身份隔离回归（2026-10-01 修复，A04–A08 + 审核第 4–9 条）。
// 客户端级：真实 toolsStore/页面 script → 真实 mc-tools/mc-health handler → mock 云。
// 覆盖：
// - A04 存储配额异常 + 离线：胎动/宫缩 start/click/finish/stop 均明确 local-persist-failed
//   （绝不 offline-pending 假暂存），内存草稿保留、页面真实报错+未保存横幅，恢复后收敛；
// - A05 正常离线落盘可冷启动恢复；部分写失败不报全成功；
// - 审核5 终态耐久序：queue（终态重试副本）写失败时 active（含 journal/stopOp）不被清，
//   冷重启以同一 operationId 重放收敛、不双写；宫缩 history 持久化（重启不丢 stop）；
// - 审核4 首次版本通知即换人（store 创建于 mama 已确认、第一次 bump 就是 papa）立即清内存；
// - 审核6 corrupt/读取异常键：隔离副本未落地前冻结禁覆写，onShow retry 原字节不变、零上传；
// - 审核7 全链路身份守卫：入队 job 开工校验、分页拉取逐页校验、retryPending 逐项校验；
// - 审核8 未落盘草稿入 RAM 孤儿区：新身份不可见/不上传，原作用域重确认后恢复；
// - 审核9 scope 字符集完整性（含 '_' 拒绝）；异构/异作用域恢复内容隔离冻结不覆写；
// - A06/A08 logout/换人/换家庭不展示不上传旧成员数据；legacy 无作用域键字节级保留隔离。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-r1t-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')

require('node:child_process').execFileSync('node', [path.join(root, 'cloud/assemble.mjs')], { stdio: 'pipe' })
const DIST = path.join(root, 'dist/cloud-functions')
const toolsH = require(path.join(DIST, 'mc-tools/index.js'))
const healthH = require(path.join(DIST, 'mc-health/index.js'))

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-r1t', MC_MEMBER_MAMA_OPENID: 'oR1TMAMA123456', MC_MEMBER_PAPA_OPENID: 'oR1TPAPA123456' }

// ── Mock 云（版本 CAS 事务；与 phase-e1-client 同款）──
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
  showModal: o => { uniCalls.modals.push({ title: o && o.title, content: o && o.content }); o && o.success && o.success({ confirm: true }) },
  makePhoneCall: o => uniCalls.calls.push(o && o.phoneNumber),
  vibrateShort: () => uniCalls.vibrates.push(1),
  showLoading() {}, hideLoading() {},
  redirectTo() {}, navigateTo() {}, switchTab() {}, reLaunch() {}, navigateBack() {},
  request() {}, uploadFile() {}, downloadFile: o => o.fail && o.fail({ errMsg: 'dl' }),
}
const origSet = global.uni.setStorageSync
const origGet = global.uni.getStorageSync

// ── 客户端 bundle（逐 case 全新模块实例）──
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

// 胎动页面真实入口（e1-page 同手法：提取 <script setup> 构建可 require bundle）
const fetalPageBundle = path.join(temp, 'page-fetal.cjs')
{
  const src = fs.readFileSync(path.join(root, 'pages/tools/fetal-timer.vue'), 'utf8')
  const m = src.match(/<script setup>([\s\S]*?)<\/script>/)
  if (!m) throw new Error('无 <script setup>')
  let code = m[1]
    .replace(/^import .* from ['"][^'"\n]+\.vue['"];?$/mg, '')
    .replace(/import\s*\{\s*onShow\s*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const shows=[];const onShow=fn=>shows.push(fn);')
  code = `import { createPinia, setActivePinia } from 'pinia';\nsetActivePinia(createPinia());\n` +
    code.replace('const toolsStore = useToolsStore()', 'setActivePinia(createPinia());\nconst toolsStore = useToolsStore()') +
    `\nexport {shows,session,unsaved,validCount,rawCount,nowTick,paused,fetalSessions,onStart,onKick,onUndo,onPauseResume,onFinish,onDiscard,restoreWarnings,recoveryBlocked,onAckRestore,restoreWarningText};\nexport * from './services/toolsStore.js';\nexport * from './services/sessionService.js';\nexport * from './services/familyStore.js';\nexport * from './services/outbox.js';\nexport * from './services/cloudAdapter.js';\nexport * from './utils/cloudConfig.js';\n`
  esbuild.buildSync({ stdin: { contents: code, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: fetalPageBundle, logLevel: 'silent' })
}

const network = { offline: false }
const gates = [] // 在途响应闸门：{release}——handler 已按旧身份执行，响应按需延迟送达
const stackRegistry = []
function makeStack(member = 'mama', familyId = TEST_ENV.MC_FAMILY_ID) {
  for (const k of [...storage.keys()]) {
    if (k.startsWith('momcare_') || k.startsWith('mc_')) storage.delete(k)
  }
  network.offline = false
  gates.length = 0
  const cloud = makeMockCloud()
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID
  const identity = { memberId: member, displayName: member === 'mama' ? '妈妈' : '爸爸', familyId }
  cloud.__setCtx(member === 'mama' ? TEST_ENV.MC_MEMBER_MAMA_OPENID : TEST_ENV.MC_MEMBER_PAPA_OPENID)
  toolsH.__setCloud(cloud); healthH.__setCloud(cloud)
  const state = { toolsCalls: 0, actions: [] }
  const routes = {
    'mc-tools': e => { state.toolsCalls++; state.actions.push(e && e.action); return toolsH.main(e) },
    'mc-health': e => healthH.main(e),
    'mc-identity': () => ({ ok: true, data: { memberId: identity.memberId, displayName: identity.displayName, familyId: identity.familyId } })
  }
  const wxCloud = {
    init() {},
    callFunction(o) {
      if (network.offline) { o.fail({ errMsg: 'cloud.callFunction:fail offline' }); return }
      const h = routes[o.name]
      if (!h) { o.fail({ errMsg: 'no route' }); return }
      Promise.resolve().then(() => h(o.data)).then(r => {
        if (o.name === 'mc-tools' && network.holdResponses) {
          gates.push({ release: () => o.success({ result: r }) })
        } else {
          o.success({ result: r })
        }
      }).catch(e => o.fail({ errMsg: e.message }))
    }
  }
  const stack = { cloud, wxCloud, identity, state }
  stackRegistry.push(stack)
  return stack
}
function wire(stack, bundlePath = clientBundle) {
  const client = (() => { delete require.cache[require.resolve(bundlePath)]; return require(bundlePath) })()
  client.__setCloudConfigForTests('env-r1t', 'wxapp-r1t')
  client.__setWxCloud(stack.wxCloud)
  global.wx = { cloud: stack.wxCloud }
  client.__resetForTests()
  return client
}
async function confirmed(stack, bundlePath = clientBundle, member) {
  if (member) {
    stack.identity.memberId = member
    stack.identity.familyId = member === 'mama' ? TEST_ENV.MC_FAMILY_ID : stack.identity.familyId
    stack.cloud.__setCtx(member === 'mama' ? TEST_ENV.MC_MEMBER_MAMA_OPENID : TEST_ENV.MC_MEMBER_PAPA_OPENID)
  }
  const client = wire(stack, bundlePath)
  const r = await client.confirmIdentity()
  assert.ok(r.ok, `confirmIdentity: ${JSON.stringify(r).slice(0, 120)}`)
  return client
}
const fetalDocs = st => [...st.cloud.__docs.entries()].filter(([k]) => k.startsWith('mc_fetal_sessions/')).map(([k, v]) => ({ _id: k.split('/')[1], ...v }))
const contraDocs = st => [...st.cloud.__docs.entries()].filter(([k]) => k.startsWith('mc_contraction_records/')).map(([k, v]) => ({ _id: k.split('/')[1], ...v }))
const opDocs = st => [...st.cloud.__docs.entries()].filter(([k]) => k.startsWith('mc_operations/')).map(([k, v]) => ({ _id: k.split('/')[1], ...v }))
const mamaKey = suffix => `momcare_tools_env-r1t_wxapp-r1t_fam-r1t_mama_t1_${suffix}`
const papaKey = suffix => `momcare_tools_env-r1t_wxapp-r1t_${TEST_ENV.MC_FAMILY_ID}_papa_t1_${suffix}`
const MAMA_SCOPE = { envId: 'env-r1t', appId: 'wxapp-r1t', familyId: TEST_ENV.MC_FAMILY_ID, memberId: 'mama' }
const PAPA_SCOPE = { envId: 'env-r1t', appId: 'wxapp-r1t', familyId: TEST_ENV.MC_FAMILY_ID, memberId: 'papa' }
const storageKeysWith = part => [...storage.keys()].filter(k => k.startsWith('momcare_tools_') && k.includes(part))
const tick = () => new Promise(r => setTimeout(r, 5))

// 存储故障注入：predicate(key, value) 为 true 则写失败
function failWritesWhen(predicate) {
  global.uni.setStorageSync = (k, v) => { if (predicate(k, v)) throw new Error('disk-full-quota'); origSet(k, v) }
}
function failReadsWhen(predicate) {
  global.uni.getStorageSync = k => { if (predicate(k)) throw new Error('storage read error'); return origGet(k) }
}
function restoreStorageIo() {
  global.uni.setStorageSync = origSet
  global.uni.getStorageSync = origGet
}

async function main() {
  console.log('R1 工具持久化/身份隔离回归（A04–A08 + 审核 4–9）\n')

  await scenario('A04 存储配额异常+离线（胎动）：start/click/finish 均如实 local-persist-failed，草稿保留，恢复后收敛', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    network.offline = true
    failWritesWhen(k => k.startsWith('momcare_tools_'))
    try {
      const r1 = await store.startFetalSession()
      assert.equal(r1.ok, false)
      assert.equal(r1.code, 'local-persist-failed', `start 不得假暂存（实得 ${r1.code}）`)
      assert.ok(store.currentFetalSession, '内存草稿保留')
      assert.equal(storageKeysWith('fetal_active').length, 0, '磁盘未写')
      const r2 = await store.recordFetalClick()
      assert.equal(r2.code, 'local-persist-failed', 'click 同样如实失败')
      assert.equal(store.currentFetalSession.clicks.length, 1, '点击保留在内存草稿')
      const r3 = await store.finishFetalSession({ syncDaily: true })
      assert.equal(r3.code, 'local-persist-failed', 'finish 不得报 offline-pending（本地未落盘）')
      assert.ok(store.currentFetalSession, '终态失败仍可恢复：活跃会话保留（journal 含 finish）')
      const finishOps = store.currentFetalSession.journal.filter(o => o.kind === 'finish')
      assert.equal(finishOps.length, 1, 'finish 日志在队，可重试')
    } finally {
      restoreStorageIo()
    }
    // 存储恢复 + 联网：journal 重放收敛（同一 opId）
    const opIds = [store.currentFetalSession.startOpId, ...store.currentFetalSession.journal.map(o => o.opId)]
    network.offline = false
    const retried = await store.retryPending()
    assert.ok(retried.every(x => x.ok), `恢复后重试全成（实得 ${JSON.stringify(retried).slice(0, 160)}）`)
    assert.equal(store.currentFetalSession, null, '重放终态后活跃清理')
    const docs = fetalDocs(stack)
    assert.equal(docs.length, 1)
    assert.equal(docs[0].status, 'completed')
    assert.equal(docs[0].clicks.length, 1)
    const serverOpIds = opDocs(stack).map(d => d._id.split(':')[1])
    for (const id of opIds) assert.ok(serverOpIds.includes(id), `同一 operationId 重放：${id}`)
    assert.equal(serverOpIds.length, new Set(serverOpIds).size, '无重复 opKey（不双写）')
  })

  await scenario('A04 存储配额异常+离线（宫缩）：start/stop 如实失败，草稿保留，恢复后收敛', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    network.offline = true
    failWritesWhen(k => k.startsWith('momcare_tools_'))
    try {
      const r1 = await store.startContraction({ notes: 'quota-canary' })
      assert.equal(r1.code, 'local-persist-failed', `start 实得 ${r1.code}`)
      assert.ok(store.activeContraction, '内存草稿保留')
      const r2 = await store.stopContraction({ intensity: 'moderate' })
      assert.equal(r2.code, 'local-persist-failed', 'stop 不得假暂存')
      assert.ok(store.activeContraction && store.activeContraction.stopOp, 'stopOp 保留可重试')
    } finally {
      restoreStorageIo()
    }
    network.offline = false
    const retried = await store.retryPending()
    assert.ok(retried.every(x => x.ok), `实得 ${JSON.stringify(retried).slice(0, 160)}`)
    const docs = contraDocs(stack)
    assert.equal(docs.length, 1)
    assert.equal(docs[0].memberId, 'mama')
    assert.equal(docs[0].notes, 'quota-canary')
    assert.equal(docs[0].status, 'finished')
    assert.equal(docs[0].intensity, 'moderate')
  })

  await scenario('真实页面入口（fetal-timer）：磁盘写失败时页面报真实错误+未保存横幅，不清草稿', async () => {
    const stack = makeStack()
    const client = await confirmed(stack, fetalPageBundle)
    const page = client
    network.offline = true
    uniCalls.toasts.length = 0
    failWritesWhen(k => k.startsWith('momcare_tools_'))
    try {
      await page.onStart()
      await tick()
      assert.equal(page.session.value && true, true, '页面仍显示进行中会话（内存草稿）')
      assert.equal(page.unsaved.value, true, '未保存横幅状态为真')
      const toast = uniCalls.toasts[uniCalls.toasts.length - 1]
      assert.ok(String(toast).includes('本地保存失败'), `页面真实报错（实得 ${toast}）`)
      assert.ok(String(toast).includes('重启会丢失'), '如实告知重启丢失')
      await page.onKick()
      await tick()
      assert.equal(page.rawCount.value, 1, '内存点击保留')
      assert.equal(page.unsaved.value, true)
    } finally {
      restoreStorageIo()
    }
  })

  await scenario('A05 正常离线+冷启动恢复：宫缩 stop 凭据持久化，重启不丢、重试一次补齐', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    network.offline = true
    const st = await store.startContraction({ notes: 'durable-stop' })
    assert.equal(st.code, 'offline-pending', '正常离线=真暂存（磁盘确实在盘）')
    const sp = await store.stopContraction({ intensity: 'mild' })
    assert.equal(sp.code, 'offline-pending')
    assert.equal(store.activeContraction, null)
    // 冷启动：网络恢复 → 新客户端实例从作用域键复原
    network.offline = false
    const client2 = await confirmed(stack)
    const store2 = client2.useToolsStore()
    const rr = store2.restoreFromCache()
    assert.equal(rr.ok, true, `恢复无警告（实得 ${JSON.stringify(rr).slice(0, 120)}）`)
    assert.equal(store2.contraStopQueue.length, 1, 'stop 队列恢复')
    assert.ok(store2.contractionRecords.length >= 1, '宫缩历史（含 stop 凭据）持久化恢复')
    const results = await store2.retryPending()
    assert.ok(results.every(x => x.ok), `实得 ${JSON.stringify(results).slice(0, 160)}`)
    const docs = contraDocs(stack)
    assert.equal(docs.length, 1)
    assert.equal(docs[0].status, 'finished')
    assert.equal(docs[0].durationSec !== null, true, 'stop 时长落库')
  })

  await scenario('审核5 终态耐久序（胎动）：queue 写失败 → active+journal 保留，冷重启同一 opId 收敛不双写', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    network.offline = true
    assert.equal((await store.startFetalSession()).code, 'offline-pending')
    await store.recordFetalClick()
    // 仅当 queue 内容非空时写失败（start/click 阶段 queue=[] 可写——精确注入终态归档失败）
    failWritesWhen((k, v) => k.endsWith('_fetal_queue') && v !== '[]')
    const fin = await store.finishFetalSession({ syncDaily: true })
    try {
      assert.equal(fin.ok, false)
      assert.equal(fin.code, 'local-persist-failed', `终态归档失败如实报（实得 ${fin.code}）`)
      // 磁盘 active 仍在（含 finish journal）——恢复路径未丢
      const rawActive = JSON.parse(origGet(mamaKey('fetal_active')))
      assert.ok(rawActive && rawActive.journal.some(o => o.kind === 'finish'), '磁盘 active 保留 finish journal')
      assert.equal(rawActive.status, 'running', '磁盘 active 未被清空')
      const opIds = [rawActive.startOpId, ...rawActive.journal.map(o => o.opId)]
      const localRef = rawActive.localRef
      // 冷重启（注入解除、网络恢复）：restore → retry 以同一 opId 重放收敛
      restoreStorageIo()
      network.offline = false
      const client2 = await confirmed(stack)
      const store2 = client2.useToolsStore()
      store2.restoreFromCache()
      assert.equal(store2.currentFetalSession.localRef, localRef, '重启恢复同一会话')
      const results = await store2.retryPending()
      assert.ok(results.every(x => x.ok), `重放收敛（实得 ${JSON.stringify(results).slice(0, 160)}）`)
      const docs = fetalDocs(stack)
      assert.equal(docs.length, 1, '服务端恰一会话（不双写）')
      assert.equal(docs[0].status, 'completed')
      const serverOpIds = opDocs(stack).map(d => d._id.split(':')[1])
      for (const id of opIds) assert.ok(serverOpIds.includes(id), `同一 operationId：${id}`)
      const daily = stack.cloud.__docs.get(`mc_health_daily/${TEST_ENV.MC_FAMILY_ID}:${docs[0].dateKey}`)
      assert.ok(daily && daily.fields.fetalCount === 1, `当日累计恰 1 次（幂等，实得 ${JSON.stringify(daily && daily.fields)}）`)
    } finally {
      restoreStorageIo()
    }
  })

  await scenario('审核5 终态耐久序（宫缩）：stop 队列写失败 → active+stopOp 保留，冷重启同一 opId 补 stop', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    network.offline = true
    assert.equal((await store.startContraction({ notes: 'contra-dur' })).code, 'offline-pending')
    failWritesWhen((k, v) => k.endsWith('_contra_queue') && v !== '[]')
    const sp = await store.stopContraction()
    try {
      assert.equal(sp.ok, false)
      assert.equal(sp.code, 'local-persist-failed', `实得 ${sp.code}`)
      const rawActive = JSON.parse(origGet(mamaKey('contra_active')))
      assert.ok(rawActive.stopOp, '磁盘 active 保留 stopOp（恢复路径未丢）')
      assert.equal(rawActive.status, 'ongoing')
      const opIds = [rawActive.startOpId, rawActive.stopOp.opId]
      restoreStorageIo()
      network.offline = false
      const client2 = await confirmed(stack)
      const store2 = client2.useToolsStore()
      store2.restoreFromCache()
      assert.ok(store2.activeContraction && store2.activeContraction.stopOp, '重启恢复未完成 stop 的记录')
      const results = await store2.retryPending()
      assert.ok(results.every(x => x.ok), `实得 ${JSON.stringify(results).slice(0, 160)}`)
      const docs = contraDocs(stack)
      assert.equal(docs.length, 1, '服务端恰一记录（不双写）')
      assert.equal(docs[0].status, 'finished')
      const serverOpIds = opDocs(stack).map(d => d._id.split(':')[1])
      for (const id of opIds) assert.ok(serverOpIds.includes(id), `同一 operationId：${id}`)
    } finally {
      restoreStorageIo()
    }
  })

  await scenario('审核4 首次版本通知即换人：store 创建于 mama 已确认，第一次 bump=papa → 立即清内存', async () => {
    const stack = makeStack()
    const client = await confirmed(stack) // mama 确认（此时 store 尚未创建）
    const store = client.useToolsStore() // 基线=创建时实际会话（mama）
    network.offline = true
    assert.equal((await store.startContraction({ notes: 'first-bump-canary' })).code, 'offline-pending')
    assert.ok(store.activeContraction)
    // 第一次版本通知就是换 papa（无任何中间 bump）
    network.offline = false
    stack.identity.memberId = 'papa'
    stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
    const r = await client.confirmIdentity()
    assert.ok(r.ok && r.member.memberId === 'papa')
    assert.equal(store.activeContraction, null, '首次通知换人立即停止旧作用域展示')
    assert.equal(store.contractionRecords.length, 0)
  })

  await scenario('审核6+R2-6 corrupt/读取异常：键冻结禁覆写、恢复闸暂停自动同步（零上传）、警告不被 retry 消除', async () => {
    // ① corrupt 原字节 + 隔离副本写失败：冻结禁覆写 + recoveryBlocked
    {
      const stack = makeStack()
      const rawBad = 'not-json{{{canary'
      origSet(mamaKey('fetal_active'), rawBad)
      // 隔离副本写失败：所有 __corrupt_ 键写入抛错
      failWritesWhen(k => k.includes('__corrupt_'))
      let client
      try {
        client = await confirmed(stack)
        const store = client.useToolsStore()
        const rr = store.restoreFromCache()
        assert.equal(rr.ok, false, '不可读缓存不得装空白成功')
        assert.ok(rr.warnings.some(w => w.key === 'fetal_active' && w.status === 'corrupt-frozen'), `实得 ${JSON.stringify(rr.warnings)}`)
        assert.equal(store.recoveryBlocked, true, '恢复闸落下：自动同步域冻结')
        // onShow 路径 retry：recovery-blocked、原字节不变、无上传、警告不消除
        const results = await store.retryPending()
        assert.ok(results.every(x => x.code === 'recovery-blocked'), `自动重试被恢复闸拦（实得 ${JSON.stringify(results).slice(0, 120)}）`)
        assert.equal(stack.state.toolsCalls, 0, '零云请求')
        assert.equal(origGet(mamaKey('fetal_active')), rawBad, '原字节一字不动（未被覆写）')
        assert.equal(store.restoreWarnings.length, 1, '自动 retry 不消警')
        assert.equal(fetalDocs(stack).length, 0, '零上传')
        // 即便开始新会话也不覆写冻结键（用户动作也受冻结约束）
        const rj = await store.startFetalSession()
        assert.equal(rj.code, 'local-persist-failed', '冻结键阻止新会话覆写')
        assert.equal(origGet(mamaKey('fetal_active')), rawBad, '原字节仍不动')
        // 显式确认继续：解冻自动同步（警告仍可见——持久披露）
        store.acknowledgeRestoreWarnings()
        assert.equal(store.recoveryBlocked, false, '显式确认解除恢复闸')
        assert.equal(store.restoreWarnings.length, 1, '警告仍持久显示（不因确认而消失）')
        assert.equal(origGet(mamaKey('fetal_active')), rawBad, '确认不解锁覆写（隔离仍未落地）')
      } finally {
        restoreStorageIo()
      }
    }
    // ② getStorageSync 抛错（error 态）：同样冻结 + 恢复闸
    {
      const stack = makeStack()
      const rawBad = 'unreadable-canary'
      origSet(mamaKey('contra_active'), rawBad)
      failReadsWhen(k => k === mamaKey('contra_active'))
      try {
        const client = await confirmed(stack)
        const store = client.useToolsStore()
        const rr = store.restoreFromCache()
        assert.ok(rr.warnings.some(w => w.key === 'contra_active' && w.status === 'error'), `实得 ${JSON.stringify(rr.warnings)}`)
        assert.equal(store.recoveryBlocked, true)
        const results = await store.retryPending()
        assert.ok(results.every(x => x.code === 'recovery-blocked'))
        assert.equal(stack.state.toolsCalls, 0, '零云请求')
        assert.equal(origGet(mamaKey('contra_active')), rawBad, '读取异常键原值不变')
        assert.equal(contraDocs(stack).length, 0, '零上传')
      } finally {
        restoreStorageIo()
      }
    }
    // ③ 隔离成功：原字节保全落副本 → 键解冻可写（新会话真暂存），但恢复闸+警告仍在直至确认
    {
      const stack = makeStack()
      origSet(mamaKey('fetal_active'), 'not-json{{{2')
      const client = await confirmed(stack) // 本次隔离可写成功
      const store = client.useToolsStore()
      const rr = store.restoreFromCache()
      assert.ok(rr.warnings.some(w => w.key === 'fetal_active' && w.status === 'corrupt'), `实得 ${JSON.stringify(rr.warnings)}`)
      assert.ok([...storage.keys()].some(k => k.startsWith(mamaKey('fetal_active') + '__corrupt_')), '隔离副本已落盘（原字节保全）')
      assert.equal(store.recoveryBlocked, true, '隔离成功≠恢复完成：pending 完整性仍未知，闸保持')
      const blocked = await store.retryPending()
      assert.ok(blocked.every(x => x.code === 'recovery-blocked'), '自动同步仍冻结')
      assert.equal(stack.state.toolsCalls, 0)
      store.acknowledgeRestoreWarnings()
      network.offline = true // 用户显式确认后允许继续记录（网络离线=真暂存）
      const rj = await store.startFetalSession()
      assert.equal(rj.code, 'offline-pending', '确认后键可写：新会话真暂存（原字节已在隔离副本）')
      network.offline = false
      assert.ok(store.restoreWarnings.length >= 1, '警告持续显示（持久披露，非一闪而过）')
    }
  })

  await scenario('审核7 在途响应守卫：start 在途换人 → 响应丢弃不采纳；排队 click 开工即校验不落地', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    network.holdResponses = true
    try {
      const startP = store.startFetalSession() // 在途（响应被闸门扣住）
      await tick()
      const clickP = store.recordFetalClick() // 排队（串行链在 start 之后）
      await tick()
      // 在途期间换 papa（handler 已按 mama 执行——响应将迟到）
      stack.identity.memberId = 'papa'
      stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
      const confP = client.confirmIdentity()
      await tick()
      for (const g of gates.splice(0)) g.release() // 释放全部迟到响应
      const startR = await startP
      const clickR = await clickP
      await confP
      assert.equal(startR.ok, false)
      assert.equal(startR.code, 'stale-session', `在途响应丢弃（实得 ${startR.code}）`)
      assert.equal(clickR.code, 'stale-session', `排队 job 开工校验拒绝（实得 ${clickR.code}）`)
      assert.ok(store.currentFetalSession === null || store.currentFetalSession.sessionId == null, '旧会话未采纳服务端 id')
      if (store.currentFetalSession) {
        assert.equal(store.currentFetalSession.clicks.length, 0, '切换后排队点击未写入旧引用')
      }
      assert.equal(storageKeysWith('papa').length, 0, 'papa 作用域零写入（无缓存污染）')
      const docs = fetalDocs(stack)
      assert.equal(docs.length, 1)
      assert.equal(docs[0].memberId, 'mama', '云端记录归属原成员（handler 按 mama 执行）')
    } finally {
      network.holdResponses = false
    }
  })

  await scenario('审核7 分页拉取逐页守卫：page2 在途换人 → 中止，不再以旧 cursor 调用新成员', async () => {
    const stack = makeStack()
    // 服务端直种 60 条已完成会话（两页）
    for (let i = 0; i < 60; i++) {
      const t = Date.now() - i * 3600000
      const r = await toolsH.main({ action: 'fetal.start', startTime: t, operationId: `seed-${i}` })
      assert.ok(r.ok)
      await toolsH.main({ action: 'fetal.finish', sessionId: r.data.session.sessionId, endTime: t + 60000, expectedRevision: 1, operationId: `seed-${i}-f` })
    }
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    network.holdResponses = true
    try {
      const pullP = store.pullFetalSessions()
      await tick(); await tick()
      assert.equal(gates.length, 1, 'page1 响应已被扣住')
      stack.identity.memberId = 'papa'
      stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
      const confP = client.confirmIdentity()
      await tick()
      const callsBefore = stack.state.toolsCalls
      for (const g of gates.splice(0)) g.release()
      const res = await pullP
      await confP
      assert.equal(res.ok, false)
      assert.equal(res.code, 'stale-session', `拉取中止（实得 ${res.code}）`)
      assert.equal(stack.state.toolsCalls, callsBefore, '切换后未再外呼（无 page3/无旧 cursor 新成员调用）')
      assert.equal(store.fetalSessions.length, 0, '结果未写回新身份内存')
    } finally {
      network.holdResponses = false
    }
  })

  await scenario('审核7 retryPending 逐项守卫：队列重试在途换人 → 停止处理，mama 磁盘队列完好', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    network.offline = true
    await store.startContraction({ notes: 'q1' })
    await store.stopContraction()
    await store.startContraction({ notes: 'q2' })
    await store.stopContraction()
    assert.equal(store.contraStopQueue.length, 2)
    const queueRawBefore = origGet(mamaKey('contra_queue'))
    network.offline = false
    network.holdResponses = true
    try {
      const retryP = store.retryPending()
      await tick(); await tick()
      stack.identity.memberId = 'papa'
      stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
      const confP = client.confirmIdentity()
      await tick()
      for (const g of gates.splice(0)) g.release()
      const results = await retryP
      await confP
      // 第一项因切换中止（stale-session），后续队列不再处理；watch 已清内存队列
      assert.ok(results.some(x => !x.ok), `旧 await 返回后不再装成功（实得 ${JSON.stringify(results).slice(0, 160)}）`)
      assert.equal(origGet(mamaKey('contra_queue')), queueRawBefore, 'mama 磁盘队列一字不动（未被 papa 消费/覆写）')
      assert.equal(storageKeysWith('papa').length, 0, 'papa 作用域零写入')
    } finally {
      network.holdResponses = false
    }
  })

  await scenario('审核8 未落盘草稿入 RAM 孤儿区：papa 不可见/不上传，mama 重确认后恢复', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    network.offline = true
    failWritesWhen(k => k.endsWith('_fetal_active'))
    try {
      const r = await store.startFetalSession()
      assert.equal(r.code, 'local-persist-failed')
      assert.ok(store.currentFetalSession, '内存草稿在')
      const localRef = store.currentFetalSession.localRef
      const clicksBefore = 0
      // 换 papa：草稿进孤儿区（不展示、不上传）
      network.offline = false
      stack.identity.memberId = 'papa'
      stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
      await client.confirmIdentity()
      assert.equal(store.currentFetalSession, null, '新身份不可见')
      assert.equal(store.orphanDraftSummary.length, 1, '孤儿区保留 1 份')
      assert.equal(store.orphanDraftSummary[0].memberId, 'mama')
      assert.equal(fetalDocs(stack).length, 0, '零上传')
      assert.equal(storageKeysWith('papa').length, 0)
      // mama 重确认 → restore 回接（保持未保存标记）
      stack.identity.memberId = 'mama'
      stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID)
      await client.confirmIdentity()
      const rr = store.restoreFromCache()
      assert.ok(store.currentFetalSession && store.currentFetalSession.localRef === localRef, '原作用域恢复同一草稿')
      assert.equal(store.orphanDraftSummary.length, 0, '孤儿区清空')
      assert.equal(store.fetalUnsaved, true, '恢复后仍标未保存（磁盘确实无此会话）')
      assert.equal(store.currentFetalSession.clicks.length, clicksBefore)
    } finally {
      restoreStorageIo()
    }
  })

  await scenario('R2-3 scope 编码：underscore 家庭 ID 合法可用、键无歧义碰撞；异构/异作用域恢复不认领', async () => {
    // ① 服务器身份契约只要求非空：familyId 含 '_' 是合法确认身份——工具照常可用
    {
      const stack = makeStack()
      const client = await confirmed(stack)
      client.__adoptSessionForTests({ memberId: 'mama', familyId: 'fam_a', displayName: '妈妈' })
      const store = client.useToolsStore()
      network.offline = true
      const r = await store.startFetalSession()
      assert.equal(r.code, 'offline-pending', `含 '_' 的合法家庭照常真暂存（实得 ${r.code}）`)
      assert.ok([...storage.keys()].some(k => k.includes('fam%5Fa') && k.endsWith('_fetal_active')), '作用域键用无歧义编码（_ → %5F）')
      assert.equal(fetalDocs(stack).length, 0)
      network.offline = false
    }
    // ② 键编码无碰撞：朴素拼接会撞的两个 scope 必须产生不同键
    {
      const stack = makeStack()
      const client = await confirmed(stack)
      client.__adoptSessionForTests({ memberId: 'c', familyId: 'a_b', displayName: 'x' })
      const s1 = client.useToolsStore()
      network.offline = true
      await s1.startFetalSession()
      const k1 = [...storage.keys()].filter(k => k.endsWith('_fetal_active')).pop()
      const c2 = wire(stack) // 全新客户端/会话
      c2.__adoptSessionForTests({ memberId: 'b_c', familyId: 'a', displayName: 'y' })
      const s2 = c2.useToolsStore()
      await s2.startContraction()
      const k2 = [...storage.keys()].filter(k => k.endsWith('_contra_active')).pop()
      assert.notEqual(k1, k2, `a_b/c 与 a/b_c 不得共享键（${k1} vs ${k2}）`)
      network.offline = false
    }
    // ③ 真正不完整的 scope（空 familyId）才拒绝：不写缓存、不外呼
    {
      const stack = makeStack()
      const client = await confirmed(stack)
      client.__adoptSessionForTests({ memberId: 'mama', familyId: '', displayName: '妈妈' })
      const store = client.useToolsStore()
      const r = await store.startFetalSession()
      assert.equal(r.ok, false)
      assert.equal(r.code, 'scope-incomplete', `实得 ${r.code}`)
      assert.equal(storageKeysWith('fetal_active').length, 0, '零缓存写入')
      assert.equal(stack.state.toolsCalls, 0, '零云请求')
    }
    // ④ queue 键内异作用域/无作用域项：不认领 + 整键隔离保全原字节 + 恢复闸（R2-6）
    {
      const stack = makeStack()
      const rawQueue = JSON.stringify([{ localRef: 'floc_x', journal: [], clicks: [], scope: null }])
      origSet(mamaKey('fetal_queue'), rawQueue)
      const client = await confirmed(stack)
      const store = client.useToolsStore()
      const rr = store.restoreFromCache()
      assert.ok(rr.warnings.some(w => w.key === 'fetal_queue' && w.status === 'scope-foreign'), `实得 ${JSON.stringify(rr.warnings)}`)
      assert.equal(store.fetalFinishQueue.length, 0, '异作用域项不认领')
      const results = await store.retryPending()
      assert.ok(results.every(x => x.code === 'recovery-blocked'), '恢复闸：不重试不外呼')
      assert.equal(stack.state.toolsCalls, 0)
      assert.ok([...storage.keys()].some(k => k.startsWith(mamaKey('fetal_queue') + '__corrupt_')), '原字节已隔离保全')
    }
    // ⑤ history 键非数组结构：警告+冻结（隔离后可覆写，原字节保全）
    {
      const stack = makeStack()
      const rawHist = JSON.stringify({ not: 'an-array' })
      origSet(mamaKey('fetal_history'), rawHist)
      const client = await confirmed(stack)
      const store = client.useToolsStore()
      const rr = store.restoreFromCache()
      assert.ok(rr.warnings.some(w => w.key === 'fetal_history' && w.status === 'invalid-shape'), `实得 ${JSON.stringify(rr.warnings)}`)
      assert.equal(store.recoveryBlocked, true)
      assert.ok([...storage.keys()].some(k => k.startsWith(mamaKey('fetal_history') + '__corrupt_')), '原字节已隔离保全')
    }
  })

  await scenario('A06+A08 logout→papa→另一家庭：不展示/不上传旧成员数据；legacy 键字节级隔离', async () => {
    const stack = makeStack()
    // legacy 无作用域键注入金丝雀（R1 前真实用户数据）
    const legacyBefore = JSON.stringify({
      'momcare_fetal_active_session': { startTime: 1, status: 'running', clicks: [{ timestamp: 1 }] },
      'momcare_active_contraction': { startTime: 2, status: 'ongoing', notes: 'legacy-canary' },
      'momcare_fetal_sessions_history': [{ status: 'completed' }],
      'momcare_fetal_finish_queue': [{ journal: ['legacy'] }],
      'momcare_contra_stop_queue': [{ stopOp: { endTime: 3 } }]
    })
    for (const [k, v] of Object.entries(JSON.parse(legacyBefore))) origSet(k, JSON.stringify(v))
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    network.offline = true
    assert.equal((await store.startContraction({ notes: 'mama-r1t' })).code, 'offline-pending')
    const mamaKeyRaw = origGet(mamaKey('contra_active'))
    assert.ok(mamaKeyRaw && JSON.parse(mamaKeyRaw).notes === 'mama-r1t', 'mama 作用域键已持久化')
    // logout → papa 另一家庭（watch 为微任务 flush——endSession 后等一拍再断言内存清理）
    network.offline = false
    client.endSession()
    await tick()
    assert.equal(store.activeContraction, null, 'logout 立即停止展示')
    stack.identity.memberId = 'papa'
    stack.identity.familyId = 'other-family'
    stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
    process.env.MC_FAMILY_ID = 'other-family'
    const client2 = wire(stack) // papa 冷启动
    const r2 = await client2.confirmIdentity()
    assert.ok(r2.ok && r2.member.familyId === 'other-family')
    const store2 = client2.useToolsStore()
    store2.restoreFromCache()
    assert.equal(store2.activeContraction, null, 'papa/另一家庭不见 mama 宫缩')
    assert.equal(store2.fetalSessions.length, 0, 'legacy history 不被认领展示')
    await store2.retryPending()
    assert.equal(contraDocs(stack).length, 0, '不上传 mama pending')
    // legacy 键字节级未动
    for (const [k, v] of Object.entries(JSON.parse(legacyBefore))) {
      assert.equal(origGet(k), JSON.stringify(v), `legacy 键 ${k} 原字节保留`)
    }
    // mama 回来（原家庭）：从自己作用域键恢复并上传归属 mama
    process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID
    stack.identity.memberId = 'mama'
    stack.identity.familyId = TEST_ENV.MC_FAMILY_ID
    stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID)
    const client3 = wire(stack)
    const r3 = await client3.confirmIdentity()
    assert.ok(r3.ok)
    const store3 = client3.useToolsStore()
    store3.restoreFromCache()
    assert.ok(store3.activeContraction && store3.activeContraction.notes === 'mama-r1t', 'mama 恢复自己的宫缩')
    const results = await store3.retryPending()
    assert.ok(results.every(x => x.ok), `实得 ${JSON.stringify(results).slice(0, 160)}`)
    const docs = contraDocs(stack)
    assert.equal(docs.length, 1)
    assert.equal(docs[0].memberId, 'mama', '云端归属 mama（非 papa）')
    assert.equal(docs[0].notes, 'mama-r1t')
  })

  await scenario('A06+R7 同成员回前台复核不丢草稿：重确认后照常、联网补传一次', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    network.offline = true
    assert.equal((await store.startContraction({ notes: 'recheck-keep' })).code, 'offline-pending')
    // 同成员复核（网络恢复）：epoch 推进但 fp 不变——不得清草稿
    network.offline = false
    const rc = await client.confirmIdentity()
    assert.ok(rc.ok && rc.member.memberId === 'mama')
    assert.ok(store.activeContraction && store.activeContraction.notes === 'recheck-keep', '同成员复核草稿保留')
    const results = await store.retryPending()
    assert.ok(results.every(x => x.ok))
    const docs = contraDocs(stack)
    assert.equal(docs.length, 1)
    assert.equal(docs[0].memberId, 'mama')
    assert.equal(docs[0].notes, 'recheck-keep')
  })

  // ══ R1 第二轮审核反例（R1_REVIEW_ROUND2 1–6）══

  await scenario('R2-1 旧 retry 在途切身份：立即结束，不调用新成员宫缩、不写新作用域', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    network.offline = true
    assert.equal((await store.startFetalSession()).code, 'offline-pending', 'mama 胎动会话耐久在盘')
    const mamaActiveRaw = origGet(mamaKey('fetal_active'))
    network.offline = false
    network.holdResponses = true
    try {
      const retryP = store.retryPending() // mama 身份的旧重试（fetal.start 在途被闸门扣住）
      await tick(); await tick()
      stack.identity.memberId = 'papa'
      stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
      const confR = await client.confirmIdentity() // mc-identity 不受闸门——确认完成、成员已换
      assert.ok(confR.ok && confR.member.memberId === 'papa')
      await tick() // watch flush 清 mama 内存
      const stP = store.startContraction({ notes: 'papa-own' }) // papa 建立自己的宫缩（在途）
      await tick()
      for (const g of gates.splice(0)) g.release() // 释放全部迟到响应
      const results = await retryP
      const stPr = await stP
      // 旧重试：只含 mama fetal 的 stale 结果，到此立即结束
      assert.equal(results.length, 1, `旧 retry 立即结束（实得 ${JSON.stringify(results).slice(0, 140)}）`)
      assert.equal(results[0].ok, false)
      assert.equal(results[0].code, 'stale-session', `在途响应丢弃（实得 ${results[0].code}）`)
      // 不处理新身份数据：contraction.start 只有 papa 自己那一次（旧 retry 不得再 flush papa 宫缩）
      const starts = stack.state.actions.filter(a => a === 'contraction.start')
      assert.equal(starts.length, 1, `旧 retry 不调用新成员宫缩（实得 ${starts.length} 次 contraction.start）`)
      assert.equal(stPr.ok, true, 'papa 自己的流程不受影响')
      // 不写新作用域：旧 retry 的 persistFetal() 不得写 papa 的 fetal_active
      assert.equal([...storage.keys()].filter(k => k.includes('papa') && k.endsWith('_fetal_active')).length, 0, '旧 retry 不写 papa fetal_active')
      assert.equal(origGet(mamaKey('fetal_active')), mamaActiveRaw, 'mama 磁盘 active 未被消费/覆写')
    } finally {
      network.holdResponses = false
    }
  })

  await scenario('R2-2 同 localRef 孤儿草稿回接（胎动）：RAM 最新输入覆盖盘上旧 active，同 opId 收敛', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    const st = await store.startFetalSession()
    assert.equal(st.ok, true, '耐久 start（盘上留下旧版本基准）')
    const localRef = store.currentFetalSession.localRef
    const startOpId = store.currentFetalSession.startOpId
    // 离线 + 配额：click 落盘失败 → RAM 比 disk 新（disk 无 click）
    network.offline = true
    failWritesWhen(k => k.startsWith('momcare_tools_'))
    const diskOld = origGet(mamaKey('fetal_active'))
    const rk = await store.recordFetalClick()
    assert.equal(rk.code, 'local-persist-failed')
    const clickOpId = store.currentFetalSession.journal[0].opId
    assert.equal(origGet(mamaKey('fetal_active')), diskOld, '盘上 active 仍是旧版本（无 click）')
    // 切 papa → 孤儿区；回 mama → 同 localRef 回接（不是永远接不上的数组）
    restoreStorageIo()
    network.offline = false
    stack.identity.memberId = 'papa'
    stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
    await client.confirmIdentity()
    assert.equal(store.currentFetalSession, null)
    assert.equal(store.orphanDraftSummary.length, 1, '孤儿区保留最新输入')
    stack.identity.memberId = 'mama'
    stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID)
    await client.confirmIdentity()
    const rr = store.restoreFromCache()
    assert.ok(store.currentFetalSession && store.currentFetalSession.localRef === localRef, '回接同一 localRef（RAM 最新输入取代盘上旧 active）')
    assert.equal(store.currentFetalSession.clicks.length, 1, `未落盘 click 可见（实得 ${store.currentFetalSession.clicks.length}）`)
    assert.equal(store.currentFetalSession.journal[0].opId, clickOpId, '同一 operationId 恢复')
    assert.equal(store.currentFetalSession.startOpId, startOpId)
    assert.equal(store.fetalUnsaved, true, '未保存标记保持')
    // 恢复后重试：同 opId 收敛（服务端恰 1 click、无双写）
    const results = await store.retryPending()
    assert.ok(results.every(x => x.ok), `实得 ${JSON.stringify(results).slice(0, 160)}`)
    const docs = fetalDocs(stack)
    assert.equal(docs.length, 1)
    assert.equal(docs[0].clicks.length, 1, 'click 以同 opId 落服务端')
    assert.ok(opDocs(stack).map(d => d._id.split(':')[1]).includes(clickOpId))
    assert.equal(store.fetalUnsaved, false, '真正落盘成功后未保存标记才解除')
  })

  await scenario('R2-2 同 localRef 孤儿草稿回接（宫缩）：未落盘 stopOp 恢复续传，同 opId 补 stop', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    const st = await store.startContraction({ notes: 'same-ref-contra' })
    assert.equal(st.ok, true)
    const localRef = store.activeContraction.localRef
    network.offline = true
    failWritesWhen(k => k.startsWith('momcare_tools_'))
    const sp = await store.stopContraction({ intensity: 'strong' })
    assert.equal(sp.code, 'local-persist-failed')
    assert.ok(store.activeContraction && store.activeContraction.stopOp, 'stopOp 仅在内存（最新输入）')
    const stopOpId = store.activeContraction.stopOp.opId
    restoreStorageIo()
    network.offline = false
    stack.identity.memberId = 'papa'
    stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
    await client.confirmIdentity()
    stack.identity.memberId = 'mama'
    stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID)
    await client.confirmIdentity()
    store.restoreFromCache()
    assert.ok(store.activeContraction && store.activeContraction.localRef === localRef, '同 localRef 回接')
    assert.equal(store.activeContraction.stopOp && store.activeContraction.stopOp.opId, stopOpId, '未落盘 stopOp 以同一凭据恢复')
    assert.equal(store.contraUnsaved, true)
    const results = await store.retryPending()
    assert.ok(results.every(x => x.ok), `实得 ${JSON.stringify(results).slice(0, 160)}`)
    const docs = contraDocs(stack)
    assert.equal(docs.length, 1)
    assert.equal(docs[0].status, 'finished')
    assert.equal(docs[0].intensity, 'strong')
    assert.ok(opDocs(stack).map(d => d._id.split(':')[1]).includes(stopOpId))
  })

  await scenario('R2-4 finalize 部分失败推进未保存状态：横幅真值；持续失败不被无关成功遮蔽', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    network.offline = true
    assert.equal((await store.startFetalSession()).code, 'offline-pending')
    await store.recordFetalClick()
    // 只让 history 写失败（queue/active 可写）——finalize 的 queue 先落、active 清、history 失败
    failWritesWhen((k, v) => k.endsWith('_fetal_history') && v !== '[]')
    const fin = await store.finishFetalSession({ syncDaily: true })
    try {
      assert.equal(fin.code, 'local-persist-failed', `实得 ${fin.code}`)
      assert.equal(store.fetalUnsaved, true, 'finalize 失败 → 未保存状态立即推进（横幅出现，非只看返回码）')
      assert.equal(store.fetalSessions.length, 1, 'RAM 归档在')
      assert.equal(store.fetalSessions[0].synced, false, '待同步标记')
      network.offline = false
      // 重试：云端重放成功，但 history 持续写失败——不得被其他键成功遮蔽成全成功
      const results = await store.retryPending()
      assert.ok(results.every(x => x.ok), `云端重放本身成功（实得 ${JSON.stringify(results).slice(0, 200)}）`)
      assert.equal(store.fetalUnsaved, true, '本地存档仍未全落盘——如实保持未保存')
    } finally {
      restoreStorageIo()
    }
    // 存储恢复后再重试：真正补齐落盘 → 状态解除
    await store.retryPending()
    assert.equal(store.fetalUnsaved, false, '落盘真正成功后解除')
    const docs = fetalDocs(stack)
    assert.equal(docs.length, 1)
    assert.equal(docs[0].status, 'completed')
  })

  await scenario('R2-5 恢复结构校验：journal/startTime/startOpId/stopOp 缺陷 → 冻结零外呼；异 scope history 不显示', async () => {
    // ① fetal active journal 非数组（可解析但结构不合法）→ 不入内存、不重试、不外呼
    {
      const stack = makeStack()
      const raw = JSON.stringify({ localRef: 'floc_bad1', startTime: 123, startOpId: 'fst_1', status: 'running', clicks: [], journal: 'nope', scope: MAMA_SCOPE })
      origSet(mamaKey('fetal_active'), raw)
      const client = await confirmed(stack)
      const store = client.useToolsStore()
      const rr = store.restoreFromCache()
      assert.ok(rr.warnings.some(w => w.key === 'fetal_active' && w.status === 'invalid-shape'), `实得 ${JSON.stringify(rr.warnings)}`)
      assert.equal(store.currentFetalSession, null, '不合法不入内存')
      const results = await store.retryPending()
      assert.ok(results.every(x => x.code === 'recovery-blocked'), '不重试')
      assert.equal(stack.state.toolsCalls, 0, '零外呼')
      assert.ok([...storage.keys()].some(k => k.startsWith(mamaKey('fetal_active') + '__corrupt_')), '原字节隔离保全')
    }
    // ② contra active 缺 startTime（可解析但缺必要字段）→ 同上
    {
      const stack = makeStack()
      const raw = JSON.stringify({ localRef: 'cloc_bad2', startOpId: 'cnt_2', status: 'ongoing', stopOp: null, scope: MAMA_SCOPE })
      origSet(mamaKey('contra_active'), raw)
      const client = await confirmed(stack)
      const store = client.useToolsStore()
      const rr = store.restoreFromCache()
      assert.ok(rr.warnings.some(w => w.key === 'contra_active' && w.status === 'invalid-shape'), `实得 ${JSON.stringify(rr.warnings)}`)
      assert.equal(store.activeContraction, null)
      await store.retryPending()
      assert.equal(stack.state.toolsCalls, 0, '零外呼')
    }
    // ③ contra queue 项 stopOp 缺 endTime（无重试凭据语义）→ 整键不认领、零外呼
    {
      const stack = makeStack()
      const raw = JSON.stringify([{ localRef: 'cloc_bad3', startTime: 1, startOpId: 'cnt_3', status: 'ongoing', stopOp: { opId: 'cst_3' }, scope: MAMA_SCOPE }])
      origSet(mamaKey('contra_queue'), raw)
      const client = await confirmed(stack)
      const store = client.useToolsStore()
      const rr = store.restoreFromCache()
      assert.ok(rr.warnings.some(w => w.key === 'contra_queue'), `实得 ${JSON.stringify(rr.warnings)}`)
      assert.equal(store.contraStopQueue.length, 0, '不合法队列不进入重试')
      await store.retryPending()
      assert.equal(stack.state.toolsCalls, 0, '零外呼')
    }
    // ④ fetal history 含异 scope 条目：本作用域可见、异 scope 不显示
    {
      const stack = makeStack()
      const raw = JSON.stringify([
        { localRef: 'h_mine', status: 'completed', startTime: 1, endTime: 2, synced: false, scope: MAMA_SCOPE },
        { localRef: 'h_foreign', status: 'completed', startTime: 3, endTime: 4, synced: false, scope: PAPA_SCOPE }
      ])
      origSet(mamaKey('fetal_history'), raw)
      const client = await confirmed(stack)
      const store = client.useToolsStore()
      const rr = store.restoreFromCache()
      assert.equal(store.fetalSessions.length, 1, `异 scope 条目不显示（实得 ${store.fetalSessions.length}）`)
      assert.equal(store.fetalSessions[0].localRef, 'h_mine')
      assert.ok(rr.warnings.some(w => w.key === 'fetal_history' && w.status === 'scope-foreign'), '原字节隔离+警告')
    }
  })

  await scenario('R2-6 真实页面（fetal-timer）onShow：恢复异常持久横幅 + 确认继续解冻自动同步', async () => {
    const stack = makeStack()
    origSet(mamaKey('fetal_active'), 'not-json{{{page')
    const client = await confirmed(stack, fetalPageBundle)
    const page = client
    // 页面 onShow 会起展示时钟 setInterval——测试环境替换为空实现防计时器泄漏挂住进程
    const origSetInterval = global.setInterval
    global.setInterval = () => 0
    try {
      for (const fn of client.shows) fn() // 页面 onShow（真实入口，不再忽略 restore 返回）
      await tick(); await tick()
      assert.equal(page.restoreWarnings.value.length, 1, '页面读得到恢复警告')
      assert.equal(page.recoveryBlocked.value, true, '恢复闸状态在页面可见（持久横幅数据源）')
      assert.ok(String(page.restoreWarningText.value).includes('已隔离备份'), `隔离成功时页面如实说已备份（实得 ${page.restoreWarningText.value}）`)
      assert.equal(stack.state.toolsCalls, 0, 'onShow 自动同步被冻结：零外呼')
      assert.equal(fetalDocs(stack).length, 0, '零上传')
      // 显式确认继续：闸解除、警告仍持久显示（再次 onShow 重新 restore 不重复弹闸）
      page.onAckRestore()
      assert.equal(page.recoveryBlocked.value, false, '确认后自动同步恢复')
      assert.equal(page.restoreWarnings.value.length, 1, '警告不因确认消失（持久披露）')
      for (const fn of client.shows) fn()
      await tick(); await tick()
      assert.equal(page.recoveryBlocked.value, false, '同键同状态重恢复保留确认（不反复弹闸）')
      assert.equal(page.restoreWarnings.value.length, 1)
    } finally {
      global.setInterval = origSetInterval
    }
  })

  // ══ R1 第三轮审核反例（R1_REVIEW_ROUND3 1–4）══

  await scenario('R3-1 同成员再次 onShow：未保存 RAM 最新输入/operationId 不被盘上旧副本覆盖', async () => {
    const stack = makeStack()
    const client = await confirmed(stack, fetalPageBundle)
    const page = client
    const store = client.useToolsStore()
    const origSetInterval = global.setInterval
    global.setInterval = () => 0
    try {
      // 胎动：耐久 start → 新增 click 落盘失败 → 同成员"离开/返回页面"（onShow，不切成员）
      assert.equal((await store.startFetalSession()).ok, true, '耐久 start（盘上留下旧版本）')
      const diskOld = origGet(mamaKey('fetal_active'))
      network.offline = true
      failWritesWhen(k => k.startsWith('momcare_tools_'))
      await page.onKick()
      await tick()
      assert.equal(page.rawCount.value, 1, '未保存 click 在 RAM')
      const ramObj = store.currentFetalSession
      const clickOpId = ramObj.journal[0].opId
      for (const fn of client.shows) fn() // 真实页面 onShow → restoreFromCache（同成员）
      await tick(); await tick()
      assert.equal(store.currentFetalSession, ramObj, 'RAM 会话引用保留（未被盘上旧副本替换）')
      assert.equal(store.currentFetalSession.clicks.length, 1, '未保存 click 仍在')
      assert.equal(store.currentFetalSession.journal[0].opId, clickOpId, '同一 operationId')
      assert.equal(store.fetalUnsaved, true)
      assert.equal(origGet(mamaKey('fetal_active')), diskOld, '盘上旧版本未被伪成功覆写')
      // 宫缩：stopOp 未落盘，同成员 onShow 后仍保留
      const rj = await store.startContraction({ notes: 'r3-1-contra' })
      assert.equal(rj.code, 'local-persist-failed')
      const sp = await store.stopContraction({ intensity: 'mild' })
      assert.equal(sp.code, 'local-persist-failed')
      const stopOpId = store.activeContraction.stopOp.opId
      const contraRam = store.activeContraction
      store.restoreFromCache()
      assert.equal(store.activeContraction, contraRam, '宫缩 RAM 引用保留')
      assert.equal(store.activeContraction.stopOp.opId, stopOpId, '未落盘 stopOp 保留')
      // 恢复后收敛：同 opId 上服务端、不双写
      restoreStorageIo()
      network.offline = false
      const results = await store.retryPending()
      assert.ok(results.every(x => x.ok), `实得 ${JSON.stringify(results).slice(0, 200)}`)
      const fd = fetalDocs(stack)
      assert.equal(fd.length, 1)
      assert.equal(fd[0].clicks.length, 1, 'click 以同 opId 落服务端')
      const cd = contraDocs(stack)
      assert.equal(cd.length, 1)
      assert.equal(cd[0].status, 'finished')
      assert.ok(opDocs(stack).map(d => d._id.split(':')[1]).includes(stopOpId))
      assert.equal(opDocs(stack).length, new Set(opDocs(stack).map(d => d._id)).size, '无重复 opKey')
    } finally {
      global.setInterval = origSetInterval
      restoreStorageIo()
    }
  })

  await scenario('R3-2 部分异 scope history：备份失败不覆写原字节（冻结）；提示如实区分已/未备份', async () => {
    // ① 宫缩 history 混合本成员/异成员条目 + 隔离备份写失败
    {
      const stack = makeStack()
      const rawHist = JSON.stringify([
        { recordId: 'cnt_mine', startTime: 1, endTime: 2, durationSec: 1, status: 'finished', synced: false, scope: MAMA_SCOPE },
        { recordId: 'cnt_foreign', startTime: 3, endTime: 4, durationSec: 1, status: 'finished', synced: false, scope: PAPA_SCOPE }
      ])
      origSet(mamaKey('contra_history'), rawHist)
      failWritesWhen(k => k.includes('__corrupt_'))
      try {
        const client = await confirmed(stack)
        const store = client.useToolsStore()
        const rr = store.restoreFromCache()
        assert.ok(rr.warnings.some(w => w.key === 'contra_history' && w.status === 'scope-foreign-unbacked'), `实得 ${JSON.stringify(rr.warnings)}`)
        assert.equal(store.contractionRecords.length, 1, '异成员条目不显示')
        assert.equal(store.contractionRecords[0].recordId, 'cnt_mine')
        assert.equal(store.recoveryBlocked, true, '未备份 → 恢复闸')
        // 确认后用户动作（新宫缩）也写不进该键——无耐久备份绝不覆写原字节
        store.acknowledgeRestoreWarnings()
        const rj = await store.startContraction()
        assert.equal(rj.code, 'local-persist-failed', '冻结键阻止覆写')
        assert.equal(origGet(mamaKey('contra_history')), rawHist, '原字节一字不动')
      } finally {
        restoreStorageIo()
      }
    }
    // ② 备份成功路径：过滤+隔离副本落地，后续可覆写（原字节已保全）
    {
      const stack = makeStack()
      const rawHist = JSON.stringify([
        { recordId: 'cnt_mine2', startTime: 1, endTime: 2, durationSec: 1, status: 'finished', synced: false, scope: MAMA_SCOPE },
        { recordId: 'cnt_foreign2', startTime: 3, endTime: 4, durationSec: 1, status: 'finished', synced: false, scope: PAPA_SCOPE }
      ])
      origSet(mamaKey('contra_history'), rawHist)
      const client = await confirmed(stack)
      const store = client.useToolsStore()
      const rr = store.restoreFromCache()
      assert.ok(rr.warnings.some(w => w.key === 'contra_history' && w.status === 'scope-foreign'), `实得 ${JSON.stringify(rr.warnings)}`)
      assert.equal(store.contractionRecords.length, 1)
      assert.ok([...storage.keys()].some(k => k.startsWith(mamaKey('contra_history') + '__corrupt_')), '隔离备份已落盘')
      assert.equal(origGet(mamaKey('contra_history')), rawHist, '恢复本身不覆写（后续持久化才以已备份数据覆写）')
    }
    // ③ 页面提示真实性：备份失败（corrupt-frozen）时页面必须说"未能备份"
    {
      const stack = makeStack()
      origSet(mamaKey('fetal_active'), 'not-json{{{r3')
      failWritesWhen(k => k.includes('__corrupt_'))
      const origSetInterval = global.setInterval
      global.setInterval = () => 0
      try {
        const client = await confirmed(stack, fetalPageBundle)
        const page = client
        for (const fn of client.shows) fn()
        await tick(); await tick()
        assert.equal(page.recoveryBlocked.value, true)
        assert.ok(String(page.restoreWarningText.value).includes('未能备份'), `备份失败如实披露（实得 ${page.restoreWarningText.value}）`)
        page.onAckRestore()
        assert.equal(page.recoveryBlocked.value, false, '确认含义=解除自动同步暂停')
        assert.equal(page.restoreWarnings.value.length, 1, '警告保留（确认不删警告）')
      } finally {
        global.setInterval = origSetInterval
        restoreStorageIo()
      }
    }
  })

  await scenario('R3-3 云端终态成功但 active 清空写失败：冷恢复不复活、终态不双写、opId 不重造', async () => {
    // ① 胎动 finish（在线）：仅 active=null 清空写失败
    {
      const stack = makeStack()
      const client = await confirmed(stack)
      const store = client.useToolsStore()
      assert.equal((await store.startFetalSession()).ok, true)
      await store.recordFetalClick()
      failWritesWhen((k, v) => k.endsWith('_fetal_active') && v === 'null')
      const fin = await store.finishFetalSession({ syncDaily: true })
      try {
        assert.equal(fin.ok, false)
        assert.equal(fin.code, 'local-persist-failed')
        assert.equal(fin.cloudSynced, true, '云端已同步如实标注')
        const rawActive = JSON.parse(origGet(mamaKey('fetal_active')))
        assert.equal(rawActive.status, 'completed', '盘上 active 带终态标记（不复活凭据）')
        assert.ok(rawActive.journal.some(o => o.kind === 'finish'), 'journal 幂等凭据保留')
        const opsBefore = opDocs(stack).map(d => d._id).sort()
        // 冷重启（注入解除）：不复活为进行中；无新 opId、不双写
        restoreStorageIo()
        const client2 = await confirmed(stack)
        const store2 = client2.useToolsStore()
        store2.restoreFromCache()
        assert.equal(store2.currentFetalSession, null, '已完成会话不被复活为进行中')
        await store2.retryPending()
        const docs = fetalDocs(stack)
        assert.equal(docs.length, 1, '不双写')
        assert.equal(docs[0].status, 'completed')
        assert.equal(docs[0].clicks.length, 1)
        assert.deepEqual(opDocs(stack).map(d => d._id).sort(), opsBefore, 'operationId 不重造')
      } finally {
        restoreStorageIo()
      }
    }
    // ② 胎动 discard（在线）：同上
    {
      const stack = makeStack()
      const client = await confirmed(stack)
      const store = client.useToolsStore()
      assert.equal((await store.startFetalSession()).ok, true)
      failWritesWhen((k, v) => k.endsWith('_fetal_active') && v === 'null')
      const dis = await store.discardFetalSession()
      try {
        assert.equal(dis.code, 'local-persist-failed')
        const rawActive = JSON.parse(origGet(mamaKey('fetal_active')))
        assert.equal(rawActive.status, 'discarded', '终态标记在盘')
        restoreStorageIo()
        const client2 = await confirmed(stack)
        const store2 = client2.useToolsStore()
        store2.restoreFromCache()
        assert.equal(store2.currentFetalSession, null, 'discard 不复活')
        await store2.retryPending()
        assert.equal(fetalDocs(stack).length, 1)
        assert.equal(fetalDocs(stack)[0].status, 'discarded')
      } finally {
        restoreStorageIo()
      }
    }
    // ③ 宫缩 stop（在线）：仅 active=null 清空写失败
    {
      const stack = makeStack()
      const client = await confirmed(stack)
      const store = client.useToolsStore()
      assert.equal((await store.startContraction({ notes: 'r3-3-stop' })).ok, true)
      failWritesWhen((k, v) => k.endsWith('_contra_active') && v === 'null')
      const sp = await store.stopContraction({ intensity: 'moderate' })
      try {
        assert.equal(sp.ok, false)
        assert.equal(sp.code, 'local-persist-failed')
        assert.equal(sp.cloudSynced, true)
        const rawActive = JSON.parse(origGet(mamaKey('contra_active')))
        assert.equal(rawActive.status, 'finished', '盘上宫缩带终态标记')
        assert.ok(rawActive.stopOp, 'stopOp 幂等凭据保留')
        const opsBefore = opDocs(stack).map(d => d._id).sort()
        restoreStorageIo()
        const client2 = await confirmed(stack)
        const store2 = client2.useToolsStore()
        store2.restoreFromCache()
        assert.equal(store2.activeContraction, null, '已完成宫缩不被复活为进行中')
        await store2.retryPending()
        const docs = contraDocs(stack)
        assert.equal(docs.length, 1, '不双写')
        assert.equal(docs[0].status, 'finished')
        assert.deepEqual(opDocs(stack).map(d => d._id).sort(), opsBefore, 'operationId 不重造')
      } finally {
        restoreStorageIo()
      }
    }
  })

  await scenario('R3-4 恢复校验覆盖实际访问字段：null click/畸形终态/外呼参数畸形 → 冻结零外呼', async () => {
    const badCases = [
      { suffix: 'fetal_active', val: { localRef: 'f1', startTime: 1, startOpId: 'fst_1', status: 'running', journal: [], clicks: [null], serverRevision: 0, scope: MAMA_SCOPE }, why: 'clicks 含 null（recompute 会崩）' },
      { suffix: 'fetal_active', val: { localRef: 'f2', startTime: 1, startOpId: 'fst_2', status: 'running', journal: [{ opId: 'o2', kind: 'finish', payload: {} }], clicks: [], serverRevision: 0, scope: MAMA_SCOPE }, why: 'finish payload 缺 endTime（外呼参数畸形）' },
      { suffix: 'fetal_active', val: { localRef: 'f3', startTime: 1, startOpId: 'fst_3', status: 'running', journal: [], clicks: [], serverRevision: 'x', sessionId: 123, scope: MAMA_SCOPE }, why: 'serverRevision/sessionId 畸形（CAS 外呼参数）' },
      { suffix: 'contra_active', val: { localRef: 'c1', startTime: 1, startOpId: 'cnt_1', status: 'ongoing', stopOp: null, intensity: { bad: 1 }, scope: MAMA_SCOPE }, why: 'intensity 非字符串（start 载荷畸形）' }
    ]
    for (const c of badCases) {
      const stack = makeStack()
      origSet(mamaKey(c.suffix), JSON.stringify(c.val))
      const client = await confirmed(stack)
      const store = client.useToolsStore()
      const rr = store.restoreFromCache()
      assert.ok(rr.warnings.some(w => w.key === c.suffix && w.status === 'invalid-shape'), `${c.why} → invalid-shape（实得 ${JSON.stringify(rr.warnings)}）`)
      assert.equal(store.currentFetalSession, null, `${c.why}：不入内存`)
      assert.equal(store.activeContraction, null, `${c.why}：宫缩不入内存`)
      const results = await store.retryPending()
      assert.ok(results.every(x => x.code === 'recovery-blocked'), `${c.why}：不重试`)
      assert.equal(stack.state.toolsCalls, 0, `${c.why}：零外呼`)
      assert.ok([...storage.keys()].some(k => k.startsWith(mamaKey(c.suffix) + '__corrupt_')), `${c.why}：原字节隔离保全`)
    }
  })

  // ══ 终审反例（R1_REVIEW_FINAL_DETAILS 1–2）══

  await scenario('终审1 隔离副本=原始 raw 字节（结构异常 JSON）：空白/超安全整数不变形', async () => {
    const stack = makeStack()
    // 带空白 + 超安全整数的可解析 JSON：history 条目非对象 → invalid-shape 整键冻结
    const rawHist = '  [\n   1e21,\n   { "x" : 1 }\n ]  '
    origSet(mamaKey('fetal_history'), rawHist)
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    const rr = store.restoreFromCache()
    assert.ok(rr.warnings.some(w => w.key === 'fetal_history' && w.status === 'invalid-shape'), `实得 ${JSON.stringify(rr.warnings)}`)
    const qkeys = [...storage.keys()].filter(k => k.startsWith(mamaKey('fetal_history') + '__corrupt_'))
    assert.equal(qkeys.length, 1, '隔离副本恰一份')
    assert.equal(storage.get(qkeys[0]), rawHist, '备份内容与原字节严格相等（非 JSON.parse/stringify 重序列化）')
    assert.notEqual(JSON.stringify(JSON.parse(rawHist)), rawHist, '用例自检：本例下重序列化必然变形（空白丢失/1e21→1e+21）')
    // active 键同理（结构异常 + 空白）
    const stack2 = makeStack()
    const rawActive = ' { "status":"running", "journal":"nope", "startTime":1 } '
    origSet(mamaKey('fetal_active'), rawActive)
    const client2 = await confirmed(stack2)
    client2.useToolsStore().restoreFromCache()
    const qkeys2 = [...storage.keys()].filter(k => k.startsWith(mamaKey('fetal_active') + '__corrupt_'))
    assert.equal(qkeys2.length, 1)
    assert.equal(storage.get(qkeys2[0]), rawActive, 'active 备份亦为原字节')
  })

  await scenario('终审1 混合 scope history 的隔离备份=原始 raw 字节（超安全整数不变形）', async () => {
    const stack = makeStack()
    const rawHist = ' [ { "recordId":"a", "startTime": 12345678901234567890, "status":"finished", "scope": ' + JSON.stringify(PAPA_SCOPE) + ' }, { "recordId":"b", "startTime": 1, "status":"finished", "scope": ' + JSON.stringify(MAMA_SCOPE) + ' } ] '
    origSet(mamaKey('contra_history'), rawHist)
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    const rr = store.restoreFromCache()
    assert.ok(rr.warnings.some(w => w.key === 'contra_history' && w.status === 'scope-foreign'), `实得 ${JSON.stringify(rr.warnings)}`)
    assert.equal(store.contractionRecords.length, 1, '异成员条目过滤显示')
    assert.equal(store.contractionRecords[0].recordId, 'b')
    const qkeys = [...storage.keys()].filter(k => k.startsWith(mamaKey('contra_history') + '__corrupt_'))
    assert.equal(qkeys.length, 1, '隔离副本恰一份')
    assert.equal(storage.get(qkeys[0]), rawHist, '备份内容与原字节严格相等（超安全整数 12345678901234567890 不变形）')
    assert.notEqual(JSON.stringify(JSON.parse(rawHist)), rawHist, '用例自检：重序列化必变形（unsafe integer 精度丢失）')
  })

  await scenario('终审2 freezeShape 备份失败如实 -unbacked：原字节保留、零外呼、确认后写入仍受控', async () => {
    // ① 结构异常（可解析）active + 隔离写失败 → invalid-shape-unbacked
    {
      const stack = makeStack()
      const rawActive = ' { "status":"running", "journal":"nope", "startTime":1 } '
      origSet(mamaKey('fetal_active'), rawActive)
      failWritesWhen(k => k.includes('__corrupt_'))
      try {
        const client = await confirmed(stack)
        const store = client.useToolsStore()
        const rr = store.restoreFromCache()
        assert.ok(rr.warnings.some(w => w.key === 'fetal_active' && w.status === 'invalid-shape-unbacked'), `实得 ${JSON.stringify(rr.warnings)}`)
        assert.equal(store.currentFetalSession, null, '不入内存')
        assert.equal(store.recoveryBlocked, true, '恢复闸')
        await store.retryPending()
        assert.equal(stack.state.toolsCalls, 0, '零外呼')
        assert.equal(origGet(mamaKey('fetal_active')), rawActive, '备份失败期间原字节保留（不覆写）')
        store.acknowledgeRestoreWarnings()
        assert.equal(store.recoveryBlocked, false, '确认=解除自动同步暂停')
        const rj = await store.startFetalSession()
        assert.equal(rj.code, 'local-persist-failed', '确认后写入仍受控：隔离未落地 → 该键仍禁覆写')
        assert.equal(origGet(mamaKey('fetal_active')), rawActive, '原字节始终未动')
      } finally {
        restoreStorageIo()
      }
    }
    // ② 异作用域 active（结构合法、scope=papa）+ 隔离写失败 → scope-foreign-unbacked
    {
      const stack = makeStack()
      const rawActive = JSON.stringify({ localRef: 'floc_pf', startTime: 1, startOpId: 'fst_pf', status: 'running', clicks: [], journal: [], scope: PAPA_SCOPE })
      origSet(mamaKey('fetal_active'), rawActive)
      failWritesWhen(k => k.includes('__corrupt_'))
      try {
        const client = await confirmed(stack)
        const store = client.useToolsStore()
        const rr = store.restoreFromCache()
        assert.ok(rr.warnings.some(w => w.key === 'fetal_active' && w.status === 'scope-foreign-unbacked'), `实得 ${JSON.stringify(rr.warnings)}`)
        assert.equal(store.currentFetalSession, null, '异作用域不认领')
        assert.equal(store.recoveryBlocked, true)
        await store.retryPending()
        assert.equal(stack.state.toolsCalls, 0, '零外呼')
        assert.equal(origGet(mamaKey('fetal_active')), rawActive, '原字节保留')
        store.acknowledgeRestoreWarnings()
        const rj = await store.startFetalSession()
        assert.equal(rj.code, 'local-persist-failed', '无耐久备份不覆写原字节')
        assert.equal(origGet(mamaKey('fetal_active')), rawActive)
      } finally {
        restoreStorageIo()
      }
    }
  })

  await scenario('终审2 页面提示三态：备份失败说未能备份；孤儿 RAM 恢复不说已备份', async () => {
    const origSetInterval = global.setInterval
    global.setInterval = () => 0
    try {
      // ① invalid-shape + 备份失败 → 页面"未能备份"，确认后同步状态如实"已恢复"
      {
        const stack = makeStack()
        origSet(mamaKey('fetal_active'), ' { "status":"running", "journal":"nope" } ')
        failWritesWhen(k => k.includes('__corrupt_'))
        try {
          const client = await confirmed(stack, fetalPageBundle)
          const page = client
          for (const fn of client.shows) fn()
          await tick(); await tick()
          assert.equal(page.recoveryBlocked.value, true)
          const txt = String(page.restoreWarningText.value)
          assert.ok(txt.includes('未能备份'), `备份失败如实（实得 ${txt}）`)
          assert.ok(txt.includes('已暂停'), `同步暂停披露（实得 ${txt}）`)
          page.onAckRestore()
          const txt2 = String(page.restoreWarningText.value)
          assert.ok(txt2.includes('未能备份'), '警告保留')
          assert.ok(txt2.includes('已恢复'), `确认后同步状态如实为已恢复（实得 ${txt2}）`)
        } finally {
          restoreStorageIo()
        }
      }
      // ② 仅孤儿 RAM 草稿恢复：不宣称任何耐久备份（内存恢复≠隔离备份）、不落闸
      {
        const stack = makeStack()
        const client = await confirmed(stack, fetalPageBundle)
        const page = client
        const store = client.useToolsStore()
        network.offline = true
        failWritesWhen(k => k.endsWith('_fetal_active'))
        try {
          const r = await store.startFetalSession()
          assert.equal(r.code, 'local-persist-failed')
          assert.ok(store.currentFetalSession, 'RAM 草稿在')
          network.offline = false
          stack.identity.memberId = 'papa'
          stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
          await client.confirmIdentity()
          stack.identity.memberId = 'mama'
          stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID)
          await client.confirmIdentity()
          for (const fn of client.shows) fn() // onShow → restoreFromCache → 孤儿回接
          await tick(); await tick()
          assert.ok(page.restoreWarnings.value.every(w => w.status === 'orphan-draft-restored'), `仅孤儿恢复警告（实得 ${JSON.stringify(page.restoreWarnings.value)}）`)
          assert.equal(page.recoveryBlocked.value, false, 'RAM 恢复不落恢复闸')
          const txt = String(page.restoreWarningText.value)
          assert.ok(txt.includes('内存恢复'), `孤儿恢复如实表述（实得 ${txt}）`)
          assert.ok(!txt.includes('已隔离备份') && !txt.includes('未能备份'), `不得宣称任何耐久备份（实得 ${txt}）`)
          assert.equal(page.unsaved.value, true, '未保存横幅另在（RAM 草稿仍未落盘）')
        } finally {
          restoreStorageIo()
        }
      }
    } finally {
      global.setInterval = origSetInterval
    }
  })

  console.log(`\nphase-r1-tools：${passed} 通过，${failed.length} 失败`)
  if (failed.length > 0) { console.log('失败场景：', failed.join(' | ')); process.exit(1) }
}

main().catch(e => { console.error('套件异常:', e); process.exit(2) })
