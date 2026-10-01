// 独立验证 IV-R1（2026-10-01，全新会话——不复用编码会话通过声明）：
// A01–A10 独立反例，数据与路径均为本会话自建（与 phase-r1-push/phase-r1-tools 不同形）。
// 手法：真实 mc-daily-push handler（DIST 镜像 assemble 投放）+ 真实 toolsStore/页面 bundle
// → 真实 mc-tools/mc-health handler → mock 云/存储。外部传输与存储 IO 为 mock，
// 业务逻辑（handler/store/页面消费）全部真实执行。
// 本文件为验证会话新增测试，不修改生产源码、不改任何旧测试期望。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-iv1-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')

// ══ 推送侧 DIST（镜像 assemble：函数 + shared + 转译核心）══
const DIST = path.join(temp, 'cf', 'mc-daily-push')
{
  fs.mkdirSync(path.join(DIST, 'shared'), { recursive: true })
  fs.copyFileSync(path.join(root, 'cloud/functions/mc-daily-push/index.js'), path.join(DIST, 'index.js'))
  fs.cpSync(path.join(root, 'cloud/shared'), path.join(DIST, 'shared'), { recursive: true })
  esbuild.buildSync({
    entryPoints: [path.join(root, 'utils/dailyTipCore.js')],
    bundle: true, platform: 'node', format: 'cjs',
    outfile: path.join(DIST, 'shared', 'dailyTipCore.js'), logLevel: 'silent'
  })
}
function requireHandler() {
  delete require.cache[require.resolve(path.join(DIST, 'index.js'))]
  delete require.cache[require.resolve(path.join(DIST, 'shared/dailyTipCore.js'))]
  return require(path.join(DIST, 'index.js'))
}

const TEST_ENV = {
  MC_APPID: 'wxivapp00000001',
  MC_FAMILY_ID: 'fam-iv1',
  MC_MEMBER_MAMA_OPENID: 'oIV1MAMA0000001',
  MC_MEMBER_PAPA_OPENID: 'oIV1PAPA0000001'
}
const TPL_ID = 'TPL_IV1_PUSH'
function withEnv(extra = {}) {
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  process.env.MC_PUSH_TEMPLATE_ID = TPL_ID
  for (const [k, v] of Object.entries(extra)) process.env[k] = v
}

// 上海日期工具（与生产同式，种子不受测试机时区影响）
const SH_OFFSET_MIN = 8 * 60
function shanghaiNowParts() {
  const ms = Date.now()
  const sh = new Date(ms + (SH_OFFSET_MIN + new Date(ms).getTimezoneOffset()) * 60000)
  return sh
}
const pad = n => String(n).padStart(2, '0')
function keyOfSh(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
function shDay(n) { const d = shanghaiNowParts(); return keyOfSh(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)) }
function chineseOf(k) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k); return `${m[1]}年${Number(m[2])}月${Number(m[3])}日` }
const LMP = shDay(-45)

// mock 云（真实 where/orderBy/limit + gt 游标 + 计数 + 故障注入；缺 sortKey 行按 null 排最前——
// MongoDB BSON 升序 null < string 的保守假设，与 phase-r1-push 同注明：真实平台未实测）
function makeMockCloud({ callerOpenid, callerAppid = TEST_ENV.MC_APPID, checkups = [], failCheckups = false, failPregnancy = false, lmp = LMP } = {}) {
  const sends = []
  const counters = { checkupQueries: 0, pregnancyReads: 0 }
  const clone = x => JSON.parse(JSON.stringify(x))
  const pregDoc = lmp ? { fields: { lmpDate: lmp } } : null
  const sk = r => (r.sortKey === undefined || r.sortKey === null ? null : String(r.sortKey))
  const cmpSk = (a, b) => {
    const x = sk(a); const y = sk(b)
    if (x === y) return 0
    if (x === null) return -1
    if (y === null) return 1
    return x < y ? -1 : 1
  }
  const db = {
    command: { gt: v => ({ __op: 'gt', v }) },
    collection(name) {
      if (name === 'mc_pregnancy') {
        return { doc: () => ({ get: async () => { counters.pregnancyReads++; if (failPregnancy) { const e = new Error('db down'); e.errMsg = 'connection refused'; throw e } return { data: pregDoc } } }) }
      }
      if (name === 'mc_checkups') {
        return {
          where: filters => ({
            orderBy: () => ({
              limit: n => ({
                get: async () => {
                  counters.checkupQueries++
                  if (failCheckups) { const e = new Error('db down'); e.errMsg = 'connection refused'; throw e }
                  let rows = checkups.filter(r => {
                    for (const [k, v] of Object.entries(filters)) {
                      if (v && typeof v === 'object' && v.__op === 'gt') {
                        if (r[k] === undefined || r[k] === null) return false
                        if (!(String(r[k]) > String(v.v))) return false
                      } else if (String(r[k]) !== String(v)) return false
                    }
                    return true
                  })
                  rows.sort(cmpSk)
                  return { data: clone(rows.slice(0, n)) }
                }
              })
            })
          })
        }
      }
      return { where: () => ({ orderBy: () => ({ limit: () => ({ get: async () => ({ data: [] }) }) }) }) }
    }
  }
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'dynamic-env',
    init: () => {},
    getWXContext: () => (callerOpenid ? { OPENID: callerOpenid, APPID: callerAppid } : {}),
    database: () => db,
    openapi: { subscribeMessage: { send: async msg => { sends.push(msg) } } }
  }
  return { cloud, sends, counters }
}
const pending = (dateKey, id, extra = {}) => ({
  familyId: TEST_ENV.MC_FAMILY_ID, status: 'pending', dateKey,
  sortKey: `${dateKey}:${id || Math.random().toString(36).slice(2, 8)}`,
  ...extra
})

// ══ 工具侧基建：真实 dist handler + 真实 store/页面 bundle（独立环境号 env-iv1）══
require('node:child_process').execFileSync('node', [path.join(root, 'cloud/assemble.mjs')], { stdio: 'pipe' })
const CDIST = path.join(root, 'dist/cloud-functions')
const toolsH = require(path.join(CDIST, 'mc-tools/index.js'))
const healthH = require(path.join(CDIST, 'mc-health/index.js'))

function makeToolsMockCloud() {
  const docs = new Map()
  const state = { caller: TEST_ENV.MC_MEMBER_MAMA_OPENID, initialized: false }
  const clone = x => JSON.parse(JSON.stringify(x))
  function docApi(col, id, tx) {
    return {
      get: async () => { const e = docs.get(`${col}/${id}`); if (tx) tx.reads.set(`${col}/${id}`, e ? e.__v : 0); return { data: e ? { ...clone(e), _id: id } : null } },
      set: async ({ data }) => {
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
  showModal: o => { uniCalls.modals.push({ title: o && o.title, content: o && o.content }); o && o.success && o.success({ confirm: true }) },
  makePhoneCall() {}, vibrateShort() {},
  showLoading() {}, hideLoading() {},
  redirectTo() {}, navigateTo() {}, switchTab() {}, reLaunch() {}, navigateBack() {},
  request() {}, uploadFile() {}, downloadFile: o => o.fail && o.fail({ errMsg: 'dl' }),
}
const origSet = global.uni.setStorageSync
const origGet = global.uni.getStorageSync

const clientBundle = path.join(temp, 'client.cjs')
{
  const src = `import { createPinia, setActivePinia } from 'pinia';\nsetActivePinia(createPinia());\n` +
    `export * from './services/toolsStore.js';\nexport * from './services/sessionService.js';\nexport * from './services/familyStore.js';\nexport * from './services/outbox.js';\nexport * from './services/cloudAdapter.js';\nexport * from './utils/cloudConfig.js';\n`
  esbuild.buildSync({ stdin: { contents: src, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: clientBundle, logLevel: 'silent' })
}
function loadClient() { delete require.cache[require.resolve(clientBundle)]; return require(clientBundle) }

// 独立夹具网络：可门控在途响应（hold），记录 tools 调用
const network = { offline: false, hold: false }
const gates = []
function makeStack(member = 'mama', familyId = TEST_ENV.MC_FAMILY_ID) {
  for (const k of [...storage.keys()]) { if (k.startsWith('momcare_') || k.startsWith('mc_')) storage.delete(k) }
  network.offline = false; network.hold = false; gates.length = 0
  const cloud = makeToolsMockCloud()
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  process.env.MC_FAMILY_ID = familyId
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
        if (o.name === 'mc-tools' && network.hold) gates.push({ action: o.data && o.data.action, release: () => o.success({ result: r }) })
        else o.success({ result: r })
      }).catch(e => o.fail({ errMsg: e.message }))
    }
  }
  return { cloud, wxCloud, identity, state, familyId }
}
function wire(stack) {
  const client = loadClient()
  client.__setCloudConfigForTests('env-iv1', 'wxapp-iv1')
  client.__setWxCloud(stack.wxCloud)
  global.wx = { cloud: stack.wxCloud }
  client.__resetForTests()
  return client
}
async function confirmed(stack, member) {
  if (member) {
    stack.identity.memberId = member
    stack.identity.familyId = stack.familyId
    stack.cloud.__setCtx(member === 'mama' ? TEST_ENV.MC_MEMBER_MAMA_OPENID : TEST_ENV.MC_MEMBER_PAPA_OPENID)
  }
  const client = wire(stack)
  const r = await client.confirmIdentity()
  assert.ok(r.ok, `confirmIdentity: ${JSON.stringify(r).slice(0, 120)}`)
  return client
}
const fetalDocs = st => [...st.cloud.__docs.entries()].filter(([k]) => k.startsWith('mc_fetal_sessions/')).map(([k, v]) => ({ _id: k.split('/')[1], ...v }))
const contraDocs = st => [...st.cloud.__docs.entries()].filter(([k]) => k.startsWith('mc_contraction_records/')).map(([k, v]) => ({ _id: k.split('/')[1], ...v }))
const opDocs = st => [...st.cloud.__docs.entries()].filter(([k]) => k.startsWith('mc_operations/')).map(([k, v]) => ({ _id: k.split('/')[1], ...v }))
const toolsKeys = () => [...storage.keys()].filter(k => k.startsWith('momcare_tools_'))
const tick = () => new Promise(r => setTimeout(r, 8))
function failWritesWhen(predicate) { global.uni.setStorageSync = (k, v) => { if (predicate(k, v)) throw new Error('setStorage:fail exceed storage max size'); origSet(k, v) } }
function restoreStorageIo() { global.uni.setStorageSync = origSet; global.uni.getStorageSync = origGet }

// ══════════ 场景 ══════════
async function main() {
  console.log('IV-R1 独立反例（A01–A10）\n')

  await scenario('A01 伪造 timer/客户端自报身份：一律拒绝且读库 0、外呼 0（自建组合集）', async () => {
    withEnv()
    // 本会话自建组合：客户端自报身份字段（openid/memberId/userInfo）+ timer 字段混叠
    const forgedEvents = [
      { Type: 'Timer', TriggerName: 'checkup-eve-reminder', openid: TEST_ENV.MC_MEMBER_MAMA_OPENID },
      { Type: 'Timer', userInfo: { openid: TEST_ENV.MC_MEMBER_MAMA_OPENID }, action: 'sendNow' },
      { TriggerName: 'daily-reminder', memberId: 'mama', kind: 'eve', action: 'sendNow' },
      { Type: 'Timer', TriggerName: 'daily-reminder', kind: 'eve' },
      { source: 'timer', fromTrigger: 'daily-reminder', action: 'sendNow', role: 'mama' }
    ]
    const callers = ['oIV1INTRUDER01', '']
    for (const caller of callers) {
      for (const ev of forgedEvents) {
        const { cloud, sends, counters } = makeMockCloud({ callerOpenid: caller })
        const fn = requireHandler(); fn.__setCloud(cloud)
        const res = await fn.main(ev)
        assert.equal(res.ok, false, `${JSON.stringify(ev)} caller=${caller || '无'} 不应放行`)
        assert.equal(sends.length, 0, '零外呼')
        assert.equal(counters.pregnancyReads, 0, '拒绝先于读 pregnancy')
        assert.equal(counters.checkupQueries, 0, '拒绝先于查 checkups')
      }
    }
    // APPID 不符（有效 OpenID + 错 AppID）→ wrong-appid，同样零读零发
    {
      const { cloud, sends, counters } = makeMockCloud({ callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID, callerAppid: 'wxOTHERAPP0001' })
      const fn = requireHandler(); fn.__setCloud(cloud)
      const res = await fn.main({ action: 'sendNow' })
      assert.equal(res.ok, false)
      assert.equal(res.code, 'wrong-appid')
      assert.equal(sends.length, 0); assert.equal(counters.pregnancyReads, 0)
    }
  })

  await scenario('A02 白名单 sendNow 正常；timer 字段不加权限不改语义；未认证拒绝', async () => {
    withEnv()
    // papa 白名单 + eve：明日有产检 → 前夜文案
    {
      const tomorrow = shDay(1)
      const { cloud, sends } = makeMockCloud({ callerOpenid: TEST_ENV.MC_MEMBER_PAPA_OPENID, checkups: [pending(tomorrow, 'iv-eve-1')] })
      const fn = requireHandler(); fn.__setCloud(cloud)
      const res = await fn.main({ action: 'sendNow', kind: 'eve' })
      assert.equal(res.ok, true, `实得 ${JSON.stringify(res).slice(0, 160)}`)
      assert.equal(sends.length, 2)
      assert.ok(sends[0].data.thing11.value.includes('明天产检'), sends[0].data.thing11.value)
      assert.equal(sends[0].data.date4.value, chineseOf(tomorrow))
      assert.equal(sends[0].page, 'pages/index/index'); assert.equal(sends[0].miniprogramState, 'trial')
    }
    // 自建伪造字段形态：source/fromTrigger/role 均不改变 daily 语义（dateKey=今天）
    {
      const { cloud, sends } = makeMockCloud({ callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID, checkups: [pending(shDay(2), 'iv-daily-1')] })
      const fn = requireHandler(); fn.__setCloud(cloud)
      const res = await fn.main({ action: 'sendNow', source: 'timer', fromTrigger: 'checkup-eve-reminder', role: 'mama' })
      assert.equal(res.ok, true)
      assert.equal(sends.length, 2)
      assert.equal(res.data.dateKey, shDay(0), '伪造字段不得改变语义：daily 的 dateKey=今天')
      assert.ok(!sends[0].data.thing11.value.includes('明天产检'), '伪造成 eve 不成立')
    }
    // timer 字段无 sendNow → bad-action（timer 不构成合法 action）
    {
      const { cloud, sends } = makeMockCloud({ callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID })
      const fn = requireHandler(); fn.__setCloud(cloud)
      assert.equal((await fn.main({ Type: 'Timer', TriggerName: 'checkup-eve-reminder', kind: 'eve' })).code, 'bad-action')
      assert.equal((await fn.main({ action: 'SENDNOW' })).code, 'bad-action')
      assert.equal(sends.length, 0)
    }
    // 未认证 sendNow → not-family-member
    {
      const { cloud, sends } = makeMockCloud({ callerOpenid: 'oIV1OUTSIDER9' })
      const fn = requireHandler(); fn.__setCloud(cloud)
      assert.equal((await fn.main({ action: 'sendNow' })).code, 'not-family-member')
      assert.equal(sends.length, 0)
    }
  })

  await scenario('A03 非定时来源一律白名单拒绝：无凭据/环境残留/成功调用之后均拒绝（wx_trigger 正向见 phase-timer-hotfix）', async () => {
    withEnv()
    // ① 合法调用成功后紧接 timer 形状 → 仍拒绝（无容器状态遗留）
    const { cloud, sends, counters } = makeMockCloud({ callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID, checkups: [pending(shDay(4), 'iv-a03')] })
    const fn = requireHandler(); fn.__setCloud(cloud)
    const okRes = await fn.main({ action: 'sendNow' })
    assert.equal(okRes.ok, true)
    assert.equal(sends.length, 2)
    const before = sends.length
    // 切换为无 SOURCE 上下文（伪造的 timer 形状——真实定时=SOURCE wx_trigger，另有专门套件）
    cloud.getWXContext = () => ({})
    const timerRes = await fn.main({ Type: 'Timer', TriggerName: 'daily-reminder' })
    assert.equal(timerRes.ok, false)
    assert.equal(timerRes.code, 'unauthenticated', '定时身份不可证明 → fail-closed 拒绝')
    assert.equal(sends.length, before, '定时形状零外呼')
    assert.equal(counters.checkupQueries, 1, '定时形状不再读库（此前合法调用恰 1 次）')
    // ② 注入上次请求遗留环境变量仍拒绝
    process.env.WX_CONTEXT_KEYS = 'OPENID,APPID'
    process.env.TCB_SOURCE = 'timer'
    process.env.WX_CONTEXT = JSON.stringify({ OPENID: TEST_ENV.MC_MEMBER_MAMA_OPENID, APPID: TEST_ENV.MC_APPID })
    try {
      const res2 = await fn.main({ Type: 'Timer', TriggerName: 'checkup-eve-reminder' })
      assert.equal(res2.ok, false)
      assert.equal(sends.length, before)
    } finally {
      delete process.env.WX_CONTEXT_KEYS; delete process.env.TCB_SOURCE; delete process.env.WX_CONTEXT
    }
    // 平台边界（如实记录，不把 mock 当平台证据）：真实定时 per-invocation 身份未验证——
    // 本地证明的仅是"无法证明来源时拒绝"。断言部署门槛文案存在于 DEPLOY.md。
    const deployDoc = fs.readFileSync(path.join(root, 'cloud/DEPLOY.md'), 'utf8')
    assert.ok(deployDoc.includes('定时') && deployDoc.includes('sendNow'), '部署门槛记录在位（DEPLOY.md）')
  })

  await scenario('A09 前夜精确匹配：昨日 overdue+明日 pending 并存仍发；明日仅墓碑/他家庭/status 非 pending 均安静跳过', async () => {
    withEnv()
    const tomorrow = shDay(1)
    {
      const { cloud, sends } = makeMockCloud({
        callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID,
        checkups: [pending(shDay(-3), 'iv-over-3d'), pending(tomorrow, 'iv-tom-1'), pending(shDay(-1), 'iv-over-1d')]
      })
      const fn = requireHandler(); fn.__setCloud(cloud)
      const res = await fn.main({ action: 'sendNow', kind: 'eve' })
      assert.equal(res.ok, true, `实得 ${JSON.stringify(res).slice(0, 160)}`)
      assert.equal(sends.length, 2)
      assert.ok(sends[0].data.thing11.value.includes('明天产检'), '前夜文案（不因 overdue 存在改变）')
      assert.equal(sends[0].data.date4.value, chineseOf(tomorrow), 'date4=产检当日')
    }
    // 自建反例组：明日只有 done 状态记录（非 pending 查询面外）→ 安静
    {
      const { cloud, sends } = makeMockCloud({ callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID, checkups: [pending(tomorrow, 'iv-done-1', { status: 'done' })] })
      const fn = requireHandler(); fn.__setCloud(cloud)
      const res = await fn.main({ action: 'sendNow', kind: 'eve' })
      assert.equal(res.data.skipped, 'no-checkup-tomorrow')
      assert.equal(sends.length, 0)
    }
    // 明日有效记录属于另一家庭 → 家庭过滤，安静
    {
      const other = pending(tomorrow, 'iv-other-fam'); other.familyId = 'fam-other-iv1'
      const { cloud, sends } = makeMockCloud({ callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID, checkups: [other] })
      const fn = requireHandler(); fn.__setCloud(cloud)
      const res = await fn.main({ action: 'sendNow', kind: 'eve' })
      assert.equal(res.data.skipped, 'no-checkup-tomorrow', '他家庭记录不参与')
      assert.equal(sends.length, 0)
    }
  })

  await scenario('A10 长墓碑前缀+乱序：daily 选最早有效 overdue；缺 sortKey 明确失败；DB 异常可区分；月末跨日快照', async () => {
    withEnv()
    // ① 自建：252 条历史墓碑（-260..-9 天乱序——跨满两整页再越一页）+ 昨日 overdue + 4 天后 pending
    {
      const rows = []
      for (let i = 260; i >= 9; i--) rows.push(pending(shDay(-i), `iv-tomb-${String(i).padStart(4, '0')}`, { deleted: true }))
      rows.push(pending(shDay(4), 'iv-future-4d'))
      rows.push(pending(shDay(-1), 'iv-over-1d'))
      for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]] }
      const { cloud, sends, counters } = makeMockCloud({ callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID, checkups: rows })
      const fn = requireHandler(); fn.__setCloud(cloud)
      const res = await fn.main({ action: 'sendNow' })
      assert.equal(res.ok, true)
      assert.equal(sends.length, 2)
      assert.ok(sends[0].data.thing11.value.includes('产检已过1天'), `最早=昨日 overdue（实得 ${sends[0].data.thing11.value}）`)
      assert.ok(counters.checkupQueries >= 3, `252 墓碑须真翻页（实得 ${counters.checkupQueries}）`)
    }
    // ② 自建缺 sortKey 反例：明日两行——第一行缺 sortKey、第二行有效 → 完整性失败仍成立
    {
      const tomorrow = shDay(1)
      const bad = pending(tomorrow, 'iv-legacy-nosk'); delete bad.sortKey
      const { cloud, sends } = makeMockCloud({ callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID, checkups: [bad, pending(tomorrow, 'iv-tom-valid')] })
      const fn = requireHandler(); fn.__setCloud(cloud)
      const res = await fn.main({ action: 'sendNow', kind: 'eve' })
      assert.equal(res.ok, false, '有效行在场不得放宽完整性')
      assert.equal(res.code, 'checkup-scan-unstable')
      assert.equal(sends.length, 0)
    }
    // ③ DB 异常码可区分（自建：eve 查询失败 vs pregnancy 失败）
    {
      const { cloud: c1, sends: s1 } = makeMockCloud({ callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID, failCheckups: true })
      const fn1 = requireHandler(); fn1.__setCloud(c1)
      assert.equal((await fn1.main({ action: 'sendNow', kind: 'eve' })).code, 'checkup-query-failed')
      assert.equal(s1.length, 0)
      const { cloud: c2, sends: s2 } = makeMockCloud({ callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID, failPregnancy: true })
      const fn2 = requireHandler(); fn2.__setCloud(c2)
      assert.equal((await fn2.main({ action: 'sendNow', kind: 'eve' })).code, 'pregnancy-read-failed')
      assert.equal(s2.length, 0)
    }
    // ④ 自建快照边界：上海 2026-02-28 23:59:59.900（非闰年月末）→ today=02-28 / tomorrow=03-01
    {
      const frozenMs = Date.parse('2026-02-28T15:59:59.900Z')
      const realNow = Date.now
      Date.now = () => frozenMs
      try {
        const rows = [pending('2026-03-01', 'iv-mar01')]
        const { cloud, sends } = makeMockCloud({ callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID, checkups: rows, lmp: '2026-02-01' })
        const fn = requireHandler(); fn.__setCloud(cloud)
        const res = await fn.main({ action: 'sendNow', kind: 'eve' })
        assert.equal(res.ok, true, `实得 ${JSON.stringify(res).slice(0, 160)}`)
        assert.equal(sends.length, 2)
        assert.equal(sends[0].data.date4.value, '2026年3月1日', '月末快照：明日=03-01（非 02-29/02-30）')
      } finally { Date.now = realNow }
    }
  })

  // ══ 工具侧（A04–A08）══
  await scenario('A04 存储配额（胎动+宫缩）：第 N 次写起失败——如实 local-persist-failed、草稿保留、恢复收敛', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    network.offline = true
    // 第 1 次写成功、之后全部失败（磁盘中途被塞满）
    let writes = 0
    failWritesWhen(() => { writes++; return writes > 1 })
    try {
      const r1 = await store.startContraction({ intensity: 'strong', notes: 'iv-quota-note' })
      assert.equal(r1.ok, false)
      assert.equal(r1.code, 'local-persist-failed', `start 实得 ${r1.code}——绝不 offline-pending`)
      assert.ok(store.activeContraction, '内存草稿保留')
      assert.equal(store.activeContraction.notes, 'iv-quota-note')
      const r2 = await store.stopContraction({ intensity: 'mild' })
      assert.equal(r2.code, 'local-persist-failed', 'stop 同样如实失败')
      assert.ok(store.activeContraction && store.activeContraction.stopOp, 'stopOp 凭据保留')
    } finally { restoreStorageIo() }
    network.offline = false
    const retried = await store.retryPending()
    assert.ok(retried.every(x => x.ok), `恢复后重试全成（实得 ${JSON.stringify(retried).slice(0, 160)}）`)
    const docs = contraDocs(stack)
    assert.equal(docs.length, 1)
    assert.equal(docs[0].status, 'finished')
    assert.equal(docs[0].intensity, 'mild', 'stop 的 intensity 以 stopOp 为准')
    assert.equal(docs[0].notes, 'iv-quota-note', 'start notes 保留')
  })

  await scenario('A04b 胎动第 N 次写失败：click 如实失败且此前的内存草稿/日志完整保留', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    network.offline = true
    let writes = 0
    failWritesWhen(() => { writes++; return writes > 1 })
    try {
      const r1 = await store.startFetalSession()
      assert.equal(r1.code, 'local-persist-failed')
      const r2 = await store.recordFetalClick()
      assert.equal(r2.code, 'local-persist-failed', `click 实得 ${r2.code}`)
      assert.equal(store.currentFetalSession.clicks.length, 1, '点击保留在内存草稿')
      assert.equal(store.currentFetalSession.journal.length, 1, 'click 日志在队')
      const r3 = await store.finishFetalSession({ syncDaily: false })
      assert.equal(r3.code, 'local-persist-failed', 'finish 不报 offline-pending（本地未落盘）')
      const finishOps = store.currentFetalSession.journal.filter(o => o.kind === 'finish')
      assert.equal(finishOps.length, 1, 'finish 日志在队可重试')
    } finally { restoreStorageIo() }
    network.offline = false
    const opIds = [store.currentFetalSession.startOpId, ...store.currentFetalSession.journal.map(o => o.opId)]
    const retried = await store.retryPending()
    assert.ok(retried.every(x => x.ok), `实得 ${JSON.stringify(retried).slice(0, 160)}`)
    const docs = fetalDocs(stack)
    assert.equal(docs.length, 1)
    assert.equal(docs[0].status, 'completed')
    assert.equal(docs[0].clicks.length, 1)
    const serverOpIds = opDocs(stack).map(d => d._id.split(':')[1])
    for (const id of opIds) assert.ok(serverOpIds.includes(id), `同一 operationId 重放：${id}`)
    assert.equal(serverOpIds.length, new Set(serverOpIds).size, 'opKey 不双写')
  })

  await scenario('A05 正常离线冷恢复（undo+click 混合）；仅 queue 写失败→active 保留、冷重启同 opId 收敛', async () => {
    // ① 正常路径：click→click→undo→finish 离线归档，冷启动恢复后重试一次补齐
    {
      const stack = makeStack()
      const client = await confirmed(stack)
      const store = client.useToolsStore()
      network.offline = true
      await store.startFetalSession()
      await store.recordFetalClick(Date.now())
      await store.recordFetalClick(Date.now() + 60)
      await store.undoFetalClick()
      assert.equal((await store.finishFetalSession({ syncDaily: true })).code, 'offline-pending', '正常离线=真暂存')
      network.offline = false
      const client2 = await confirmed(stack)
      const store2 = client2.useToolsStore()
      const rr = store2.restoreFromCache()
      assert.equal(rr.ok, true, `恢复无警告（实得 ${JSON.stringify(rr).slice(0, 120)}）`)
      assert.ok(store2.fetalFinishQueue.length >= 1, '终态队列恢复')
      const results = await store2.retryPending()
      assert.ok(results.every(x => x.ok), `实得 ${JSON.stringify(results).slice(0, 160)}`)
      const docs = fetalDocs(stack)
      assert.equal(docs.length, 1)
      assert.equal(docs[0].clicks.length, 1, 'click+click-undo=1')
      assert.equal(docs[0].status, 'completed')
    }
    // ② 仅 fetal_queue 键写失败（终态重试副本未耐久）：active+journal 不被清，冷重启同 opId 收敛
    {
      const stack = makeStack()
      const client = await confirmed(stack)
      const store = client.useToolsStore()
      network.offline = true
      await store.startFetalSession()
      await store.recordFetalClick(Date.now())
      failWritesWhen(k => k.endsWith('_fetal_queue'))
      const fin = await store.finishFetalSession({ syncDaily: true })
      restoreStorageIo()
      assert.equal(fin.code, 'local-persist-failed', `queue 未耐久不得报全成功（实得 ${fin.code}）`)
      assert.ok(store.currentFetalSession, 'active 保留（journal 恢复路径在）')
      const opIds = [store.currentFetalSession.startOpId, ...store.currentFetalSession.journal.map(o => o.opId)]
      network.offline = false
      const client2 = await confirmed(stack)
      const store2 = client2.useToolsStore()
      store2.restoreFromCache()
      const results = await store2.retryPending()
      assert.ok(results.every(x => x.ok), `实得 ${JSON.stringify(results).slice(0, 160)}`)
      const docs = fetalDocs(stack)
      assert.equal(docs.length, 1, '单会话收敛')
      const serverOpIds = opDocs(stack).map(d => d._id.split(':')[1])
      for (const id of opIds) assert.ok(serverOpIds.includes(id), `同 opId：${id}`)
      assert.equal(serverOpIds.length, new Set(serverOpIds).size, '不双写')
    }
  })

  await scenario('A06 mama→logout→papa(另一家庭)：旧数据不展示不上传；legacy 五键原字节保留', async () => {
    const stack = makeStack()
    // legacy 无作用域键：自建哨兵内容（含大整数与空白，字节级保全对象）
    const legacySentinels = {
      momcare_fetal_active_session: '{"startTime": 1790000000000,\n "clicks": [{"timestamp":1e21}]}',
      momcare_active_contraction: '{"startTime":1790000001000,"notes":"legacy-iv"}',
      momcare_fetal_sessions_history: '[{"startTime":1790000000000,"status":"completed"}]',
      momcare_fetal_finish_queue: '[]',
      momcare_contra_stop_queue: '[]'
    }
    for (const [k, v] of Object.entries(legacySentinels)) storage.set(k, v)
    // mama 离线记录（不入云）
    const mamaClient = await confirmed(stack, 'mama')
    const mamaStore = mamaClient.useToolsStore()
    network.offline = true
    await mamaStore.startContraction({ notes: 'mama-iv-note' })
    await mamaStore.stopContraction({ intensity: 'mild' })
    await mamaStore.startFetalSession()
    network.offline = false
    // logout（会话退出）
    mamaClient.__resetForTests()
    await tick()
    // papa 在另一家庭确认（同栈换家庭）
    stack.familyId = 'fam-iv1-other'
    stack.identity.familyId = stack.familyId
    stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
    process.env.MC_FAMILY_ID = stack.familyId
    const papaClient = await wire(stack) // wire 不 confirm——先直接确认
    const r = await papaClient.confirmIdentity()
    assert.ok(r.ok)
    const papaStore = papaClient.useToolsStore()
    const rr = papaStore.restoreFromCache()
    assert.equal(rr.ok, true, `papa 恢复无异常（实得 ${JSON.stringify(rr).slice(0, 120)}）`)
    assert.equal(papaStore.contractionRecords.length, 0, '不见 mama 宫缩历史')
    assert.equal(papaStore.contraStopQueue.length, 0, '不采纳 mama 队列')
    assert.equal(papaStore.currentFetalSession, null, '不见 mama 胎动会话')
    // papa 的 retry 不上传 mama 的 pending（云端零宫缩文档）
    const results = await papaStore.retryPending()
    assert.ok(results.every(x => x.ok))
    assert.equal(contraDocs(stack).length, 0, 'mama 的离线 pending 不被 papa 上传')
    assert.equal(fetalDocs(stack).length, 0, 'mama 的胎动会话不被 papa 上传')
    // legacy 五键原字节未动
    for (const [k, v] of Object.entries(legacySentinels)) {
      assert.equal(storage.get(k), v, `legacy 键字节级保留：${k}`)
    }
    // mama 回到自己的家庭：自己的 pending 仍在（可恢复重试）
    stack.familyId = TEST_ENV.MC_FAMILY_ID
    stack.identity.familyId = stack.familyId
    stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID)
    process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID
    const mamaBack = await confirmed(stack, 'mama')
    const mbStore = mamaBack.useToolsStore()
    mbStore.restoreFromCache()
    assert.ok(mbStore.contraStopQueue.length >= 1, 'mama 的 stop 队列仍在自己作用域')
    const rt = await mbStore.retryPending()
    assert.ok(rt.every(x => x.ok), `mama 回归后重试成功（实得 ${JSON.stringify(rt).slice(0, 160)}）`)
    const docs = contraDocs(stack)
    assert.equal(docs.length, 1)
    assert.equal(docs[0].notes, 'mama-iv-note')
  })

  await scenario('A07 在途切身份：门控响应释放后旧结果不写新身份页面/缓存/云端', async () => {
    const stack = makeStack()
    const mamaClient = await confirmed(stack, 'mama')
    const mamaStore = mamaClient.useToolsStore()
    // mama start 在途（响应被门控扣住）
    network.hold = true
    const startP = mamaStore.startFetalSession()
    await tick()
    assert.equal(gates.length, 1, 'start 已被门控扣住')
    network.hold = false
    // 同一客户端 bundle 内切 papa（confirmIdentity 推进 epoch/指纹——在途守卫可见）
    stack.identity.memberId = 'papa'
    stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
    const rr = await mamaClient.confirmIdentity()
    assert.ok(rr.ok, `papa 确认（实得 ${JSON.stringify(rr).slice(0, 100)}）`)
    await tick()
    // 释放 mama 的在途响应
    gates.forEach(g => g.release())
    const r = await startP
    await tick()
    assert.equal(r.ok, false)
    assert.equal(r.code, 'stale-session', `旧响应被丢弃（实得 ${r.code}）`)
    assert.equal(mamaStore.currentFetalSession, null, '切身份后内存已清（页面无 mama 会话）')
    const papaKeys = toolsKeys().filter(k => k.includes('_papa_'))
    assert.equal(papaKeys.filter(k => k.endsWith('_fetal_active')).length, 0, 'papa 磁盘无 fetal_active')
    // mama 的 active 键原样（未被旧响应污染）
    const mamaActive = toolsKeys().find(k => k.includes('_mama_') && k.endsWith('_fetal_active'))
    assert.ok(mamaActive, 'mama active 键在场')
    const savedMama = JSON.parse(storage.get(mamaActive))
    assert.equal(savedMama.sessionId ?? null, null, '响应未被采纳（无服务端 sessionId）')
    // 服务端恰好 1 条 start 文档（门控期间 handler 已按 mama 执行一次）——释放后无重放/无采纳追加写
    assert.equal(fetalDocs(stack).length, 1, `服务端仅此一次执行（实得 ${fetalDocs(stack).length}）`)
  })

  await scenario('A08 scope 不完整不写不外呼；legacy 不读不写；孤儿区不向新身份展示', async () => {
    // ① 家庭身份为空串 → scope-incomplete，零键写入、零云调用
    {
      const stack = makeStack()
      stack.identity.familyId = ''
      const client = wire(stack)
      // 直接采纳不完整身份（绕过 confirm 的服务端校验，构造 scope 缺件）
      client.__adoptSessionForTests({ memberId: 'mama', familyId: '', displayName: '妈妈' })
      const store = client.useToolsStore()
      const r = await store.startContraction({ notes: 'scope-less' })
      assert.equal(r.code, 'scope-incomplete', `实得 ${r.code}`)
      assert.equal(stack.state.toolsCalls, 0, '零云调用')
      assert.equal(toolsKeys().length, 0, '零缓存键写入')
    }
    // ② legacy 键在 restore 中不被读取认领（papa 恢复后 legacy 历史不出现）
    {
      const stack = makeStack()
      const sentinel = '[{"startTime":1790000000000,"status":"completed","validCount":3}]'
      storage.set('momcare_fetal_sessions_history', sentinel)
      const client = await confirmed(stack, 'papa')
      const store = client.useToolsStore()
      store.restoreFromCache()
      assert.equal(store.fetalSessions.length, 0, 'legacy 历史不被认领展示')
      assert.equal(storage.get('momcare_fetal_sessions_history'), sentinel, 'legacy 键原字节未动')
    }
    // ③ 未落盘草稿入孤儿区：mama 有未保存草稿时切 papa——papa 不可见；mama 回来恢复
    //    （同一客户端 bundle 内切身份——孤儿区是该 bundle 的 RAM，换 bundle 会真实丢失）
    {
      const stack = makeStack()
      const client = await confirmed(stack, 'mama')
      const store = client.useToolsStore()
      network.offline = true
      failWritesWhen(k => k.startsWith('momcare_tools_'))
      await store.startContraction({ notes: 'orphan-iv-note' })
      restoreStorageIo()
      network.offline = false
      await tick()
      // 同 bundle 切 papa：watch 清内存 → 未保存草稿入孤儿区
      stack.identity.memberId = 'papa'
      stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
      assert.ok((await client.confirmIdentity()).ok)
      await tick()
      store.restoreFromCache()
      assert.equal(store.activeContraction, null, '孤儿草稿不向 papa 展示')
      assert.equal(contraDocs(stack).length, 0, '孤儿草稿不上传')
      // mama 回来（同 bundle 切回）→ 孤儿回接
      stack.identity.memberId = 'mama'
      stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID)
      assert.ok((await client.confirmIdentity()).ok)
      await tick()
      store.restoreFromCache()
      assert.ok(store.activeContraction, '孤儿草稿回接 mama')
      assert.equal(store.activeContraction.notes, 'orphan-iv-note')
      assert.equal(store.contraUnsaved, true, '未保存状态保持')
    }
  })

  console.log(`\nphase-iv-r1：${passed} 通过，${failed.length} 失败`)
  if (failed.length > 0) { console.log('失败场景：', failed.join(' | ')); process.exit(1) }
}

main().catch(e => { console.error('套件异常:', e); process.exit(2) })
