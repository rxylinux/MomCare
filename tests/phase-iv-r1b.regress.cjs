// 独立验证 IV-R1b（2026-10-01 第二轮，按 INDEPENDENT_REVIEW_NOTES R1 缺口补全）：
// 1) 原字节隔离：损坏/异构缓存的隔离副本必须**逐字节等于原始存储字符串**（空白/指数/
//    大整数在 JSON 往返中会变形——严格相等才是原字节证明）；备份写失败时页面确认/重试
//    也不能覆写原键；畸形 journal/异 scope history/缺 endTime 的 stopOp 不被展示或发送。
// 2) 云端终态已确认、仅最后 active 清空写失败 → 全新客户端冷恢复：不复活 ongoing、
//    不丢终态凭据（胎动+宫缩双路径，断言实际缓存与云端操作数）。
// 3) 同 scope 前台恢复：最新未保存 RAM 草稿不被较旧磁盘 active 顶替；真实页面横幅
//    三态（已隔离备份 / 未能备份原数据保留 / 孤儿内存恢复）逐字消费。
// 生产源码只读；本文件为验证会话新增测试。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-iv1b-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }

require('node:child_process').execFileSync('node', [path.join(root, 'cloud/assemble.mjs')], { stdio: 'pipe' })
const DIST = path.join(root, 'dist/cloud-functions')
const toolsH = require(path.join(DIST, 'mc-tools/index.js'))
const healthH = require(path.join(DIST, 'mc-health/index.js'))

const TEST_ENV = { MC_APPID: 'wxivapp00000011', MC_FAMILY_ID: 'fam-iv1b', MC_MEMBER_MAMA_OPENID: 'oIV1BMAMA000001', MC_MEMBER_PAPA_OPENID: 'oIV1BPAPA000001' }
const SCOPE = { envId: 'env-iv1b', appId: 'wxapp-iv1b', familyId: TEST_ENV.MC_FAMILY_ID, memberId: 'mama' }
const PAPA_SCOPE = { envId: 'env-iv1b', appId: 'wxapp-iv1b', familyId: TEST_ENV.MC_FAMILY_ID, memberId: 'papa' }
const enc = v => encodeURIComponent(v).replace(/_/g, '%5F')
const scopedKey = (scope, suffix) => `momcare_tools_${[scope.envId, scope.appId, scope.familyId, scope.memberId].map(enc).join('_')}_t1_${suffix}`

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
      remove: async () => { docs.delete(`${col}/${id}`); return {} }
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

// 客户端 bundle + 真实 fetal-timer 页面 bundle（含 restoreWarningText 导出）
const clientBundle = path.join(temp, 'client.cjs')
{
  const src = `import { createPinia, setActivePinia } from 'pinia';\nsetActivePinia(createPinia());\n` +
    `export * from './services/toolsStore.js';\nexport * from './services/sessionService.js';\nexport * from './services/familyStore.js';\nexport * from './services/outbox.js';\nexport * from './services/cloudAdapter.js';\nexport * from './utils/cloudConfig.js';\n`
  esbuild.buildSync({ stdin: { contents: src, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: clientBundle, logLevel: 'silent' })
}
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
    `\nexport {shows,session,unsaved,rawCount,fetalSessions,onStart,onKick,onFinish,restoreWarnings,recoveryBlocked,restoreWarningText,onAckRestore};\nexport * from './services/toolsStore.js';\nexport * from './services/sessionService.js';\nexport * from './services/familyStore.js';\nexport * from './services/outbox.js';\nexport * from './services/cloudAdapter.js';\nexport * from './utils/cloudConfig.js';\n`
  esbuild.buildSync({ stdin: { contents: code, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: fetalPageBundle, logLevel: 'silent' })
}
function loadClient(p = clientBundle) { delete require.cache[require.resolve(p)]; return require(p) }

const network = { offline: false }
function makeStack(member = 'mama') {
  for (const k of [...storage.keys()]) { if (k.startsWith('momcare_') || k.startsWith('mc_')) storage.delete(k) }
  network.offline = false
  const cloud = makeToolsMockCloud()
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID
  const identity = { memberId: member, displayName: member === 'mama' ? '妈妈' : '爸爸', familyId: TEST_ENV.MC_FAMILY_ID }
  cloud.__setCtx(member === 'mama' ? TEST_ENV.MC_MEMBER_MAMA_OPENID : TEST_ENV.MC_MEMBER_PAPA_OPENID)
  toolsH.__setCloud(cloud); healthH.__setCloud(cloud)
  const state = { toolsCalls: 0 }
  const routes = {
    'mc-tools': e => { state.toolsCalls++; return toolsH.main(e) },
    'mc-health': e => healthH.main(e),
    'mc-identity': () => ({ ok: true, data: { memberId: identity.memberId, displayName: identity.displayName, familyId: identity.familyId } })
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
  return { cloud, wxCloud, identity, state }
}
function wire(stack, bundlePath = clientBundle) {
  const client = loadClient(bundlePath)
  client.__setCloudConfigForTests(SCOPE.envId, SCOPE.appId)
  client.__setWxCloud(stack.wxCloud)
  global.wx = { cloud: stack.wxCloud }
  client.__resetForTests()
  return client
}
async function confirmed(stack, bundlePath = clientBundle, member) {
  if (member) {
    stack.identity.memberId = member
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
const tick = () => new Promise(r => setTimeout(r, 8))
function failWritesWhen(predicate) { global.uni.setStorageSync = (k, v) => { if (predicate(k, v)) throw new Error('setStorage:fail exceed storage max size'); origSet(k, v) } }
function restoreStorageIo() { global.uni.setStorageSync = origSet; global.uni.getStorageSync = origGet }
const quarantineKeys = key => [...storage.keys()].filter(k => k.startsWith(`${key}__corrupt_`))

async function main() {
  console.log('IV-R1b 独立反例（R1 审核缺口：原字节隔离/备份失败不覆写/终态写失败冷恢复/同scope RAM/页面三态）\n')

  await scenario('原字节隔离：corrupt/异 scope 的隔离副本逐字节等于原始字符串；畸形 journal/异 scope history/缺 endTime stopOp 不展示不外呼', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    // ① corrupt fetal_active：含空白+指数+尾随垃圾（JSON.parse 必败；若备份走重序列化则无从比较——此键走 raw 直存）
    const corruptRaw = ' { "startTime" : 1790000000001 , "exp" : 1e21 , "note" : "空白 与 换行\\n" } 尾随垃圾'
    storage.set(scopedKey(SCOPE, 'fetal_active'), corruptRaw)
    // ② 异 scope contra_history：合法 JSON，含 20 位大整数（JSON 往返会舍入——证明备份用 raw 而非重序列化）
    const foreignHistRaw = '[ { "recordId" : "rc-foreign-1" , "startTime" : 1790000001000 , "status" : "finished" , "synced" : true , "scope" : { "envId" : "env-iv1b" , "appId" : "wxapp-iv1b" , "familyId" : "fam-iv1b" , "memberId" : "papa" } , "big" : 12345678901234567890 } ]'
    storage.set(scopedKey(SCOPE, 'contra_history'), foreignHistRaw)
    // ③ fetal_history：数组含非对象条目 → invalid-shape（不展示）
    storage.set(scopedKey(SCOPE, 'fetal_history'), '[ {"startTime":1,"status":"completed","scope":' + JSON.stringify(SCOPE) + '}, 42 ]')
    // ④ 宫缩 queue：非数组 → invalid-shape（不进重试）
    storage.set(scopedKey(SCOPE, 'contra_queue'), '{"not":"array"}')
    // ⑤ 胎动 queue：数组含 clicks:[null] 的畸形会话（recompute 崩溃源）→ 整键冻结不重试
    storage.set(scopedKey(SCOPE, 'fetal_queue'), JSON.stringify([{ localRef: 'floc_bad', sessionId: null, startTime: 1790000002500, targetDurationMs: 3600000, status: 'running', pausedAt: null, clicks: [null], journal: [], startOpId: 'fst_bad_1', scope: SCOPE }]))
    const rr = store.restoreFromCache()
    assert.equal(rr.ok, false, '恢复闸落下')
    const statuses = rr.warnings.map(w => `${w.key}:${w.status}`).sort()
    for (const expect of ['fetal_active:corrupt', 'contra_history:scope-foreign', 'fetal_history:invalid-shape', 'contra_queue:invalid-shape', 'fetal_queue:scope-foreign']) {
      assert.ok(statuses.some(s => s === expect), `警告 ${expect}（实得 ${JSON.stringify(statuses)}）`)
    }
    assert.equal(store.fetalFinishQueue.length, 0, '畸形胎动队列不进重试')
    // 隔离副本逐字节等于原始字符串（非重序列化：空白/指数/大整数保真）
    const faKey = scopedKey(SCOPE, 'fetal_active')
    assert.equal(quarantineKeys(faKey).length, 1, 'corrupt 隔离副本恰一份')
    assert.equal(storage.get(quarantineKeys(faKey)[0]), corruptRaw, 'corrupt 备份=原始字节（空白/指数/尾随垃圾保真）')
    const chKey = scopedKey(SCOPE, 'contra_history')
    assert.equal(quarantineKeys(chKey).length, 1, '异 scope history 隔离副本恰一份')
    assert.equal(storage.get(quarantineKeys(chKey)[0]), foreignHistRaw, '异 scope 备份=原始字节（20 位大整数不经 JSON 往返舍入）')
    // 不展示：内存态全空（畸形 journal/异 scope 条目不进内存）
    assert.equal(store.currentFetalSession, null)
    assert.equal(store.contractionRecords.length, 0, '异 scope history 条目不显示')
    assert.equal(store.contraStopQueue.length, 0, '畸形 queue 不进重试')
    // 不外呼：retry 被恢复闸拦截，零云调用
    const callsBefore = stack.state.toolsCalls
    const retry = await store.retryPending()
    assert.equal(retry[0].code, 'recovery-blocked')
    assert.equal(stack.state.toolsCalls, callsBefore, '恢复闸期间零外呼')
    // 原键字节未动（未覆写）
    assert.equal(storage.get(faKey), corruptRaw, 'corrupt 原键未覆写')
    assert.equal(storage.get(chKey), foreignHistRaw, '异 scope 原键未覆写')
  })

  await scenario('备份写失败不覆写：页面确认后仍禁覆写原键；确认文案区分"未能备份"；备份恢复后先隔离再可写', async () => {
    const stack = makeStack()
    // 隔离副本写失败（只fail __corrupt_ 键）
    failWritesWhen(k => k.includes('__corrupt_'))
    const corruptRaw = ' { "startTime" : 1790000003000 , "pending" : 1e21 , "trailing" : true } 尾随垃圾'
    storage.set(scopedKey(SCOPE, 'contra_active'), corruptRaw)
    // 真实页面：恢复横幅区分"未能备份（原数据保留在原位、未被覆写）"
    const page = await confirmed(stack, fetalPageBundle)
    const store = page.useToolsStore()
    const rr = store.restoreFromCache()
    assert.equal(rr.ok, false)
    const w = rr.warnings.find(x => x.key === 'contra_active')
    assert.equal(w.status, 'corrupt-frozen', `备份失败状态（实得 ${w.status}）`)
    assert.ok(page.restoreWarningText.value.includes('未能备份'), `页面横幅区分备份失败（实得 ${page.restoreWarningText.value}）`)
    assert.ok(page.restoreWarningText.value.includes('原数据保留在原位、未被覆写'))
    assert.ok(!page.restoreWarningText.value.includes('已隔离备份'), '不得宣称已备份')
    assert.ok(page.restoreWarningText.value.includes('自动同步已暂停'))
    assert.equal(page.recoveryBlocked.value, true)
    // 页面确认：解除自动同步暂停，但原键仍禁覆写
    uniCalls.toasts.length = 0
    page.onAckRestore()
    await tick()
    assert.ok(uniCalls.toasts.some(t => String(t).includes('自动同步恢复')))
    assert.equal(page.recoveryBlocked.value, false, '确认后自动同步恢复')
    assert.ok(page.restoreWarnings.value.some(x => x.status === 'corrupt-frozen'), '警告保留（确认不删数据）')
    // 确认后仍不能覆写冻结键：新会话写入被拒（无耐久备份绝不覆盖原字节）
    const startR = await store.startContraction({ notes: 'after-ack' })
    assert.equal(startR.code, 'local-persist-failed', `确认后仍禁覆写（实得 ${startR.code}）`)
    assert.equal(storage.get(scopedKey(SCOPE, 'contra_active')), corruptRaw, '原键原始字节一字未动')
    assert.equal(store.activeContraction && store.activeContraction.notes, 'after-ack', '内存草稿保留')
    // 存储恢复后：retry 的落盘访问先补隔离（成功）才允许写入——覆写前备份在位
    restoreStorageIo()
    const retry = await store.retryPending()
    assert.ok(retry.every(x => x.ok), `草稿经补隔离后可写并上云（实得 ${JSON.stringify(retry).slice(0, 120)}）`)
    const qk = quarantineKeys(scopedKey(SCOPE, 'contra_active'))
    assert.equal(qk.length, 1, '覆写前隔离副本恰一份')
    assert.equal(storage.get(qk[0]), corruptRaw, '覆写前备份=原始字节')
    assert.ok(store.activeContraction && store.activeContraction.recordId, '确认时的内存草稿落盘并取得服务端身份')
    const sp = await store.stopContraction({ intensity: 'mild' })
    assert.ok(sp.ok, `归档成功（实得 ${JSON.stringify(sp).slice(0, 80)}）`)
    const docs = contraDocs(stack)
    assert.equal(docs.length, 1)
    assert.equal(docs[0].status, 'finished')
  })

  await scenario('终态清空写失败（胎动）：冷恢复不复活 ongoing、凭据在盘、云端操作数不变', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    // 在线全流程：start + click + finish（服务端确认终态）
    await store.startFetalSession()
    await store.recordFetalClick(Date.now())
    // 仅最后 active=null 清空写失败（终态标记+凭据已落盘）
    failWritesWhen((k, v) => k.endsWith('_fetal_active') && v === 'null')
    const fin = await store.finishFetalSession({ syncDaily: true })
    restoreStorageIo()
    assert.equal(fin.ok, false)
    assert.equal(fin.code, 'local-persist-failed')
    assert.equal(fin.cloudSynced, true, '云端已确认（如实报告部分成功）')
    const docsBefore = fetalDocs(stack)
    const opsBefore = opDocs(stack).length
    assert.equal(docsBefore.length, 1)
    assert.equal(docsBefore[0].status, 'completed', '服务端终态在')
    // 盘上 active = 终态标记 + finish 凭据（未复活源；retry 之前读取）
    const activeRaw = storage.get(scopedKey(SCOPE, 'fetal_active'))
    const activeDoc = JSON.parse(activeRaw)
    assert.equal(activeDoc.status, 'completed', '盘上终态标记（restore 不当 running）')
    assert.ok(activeDoc.journal.some(o => o.kind === 'finish'), 'finish 凭据保留在盘')
    // 全新客户端冷恢复：不复活、无新外呼、凭据不丢
    const client2 = await confirmed(stack)
    const store2 = client2.useToolsStore()
    const rr = store2.restoreFromCache()
    assert.equal(rr.ok, true, `终态残留不产生完整性警告（实得 ${JSON.stringify(rr.warnings)}）`)
    assert.equal(store2.currentFetalSession, null, '不复活为进行中')
    const credentialOnDisk = JSON.parse(storage.get(scopedKey(SCOPE, 'fetal_active')))
    assert.equal(credentialOnDisk.status, 'completed', 'retry 前盘上终态凭据仍完整可读')
    assert.ok(credentialOnDisk.journal.some(o => o.kind === 'finish'))
    const retry = await store2.retryPending()
    assert.ok(retry.every(x => x.ok))
    assert.equal(fetalDocs(stack).length, 1, '云端不双写')
    assert.equal(opDocs(stack).length, opsBefore, '冷恢复零新增云端操作（opId 不重造）')
    assert.equal(fetalDocs(stack)[0].status, 'completed')
    // retry 收敛后 active 合法清空（RAM 无活跃——写 null 是终态收敛，不是凭据丢失）
    assert.equal(storage.get(scopedKey(SCOPE, 'fetal_active')), 'null', '收敛后 active 清空')
  })

  await scenario('终态清空写失败（宫缩）：冷恢复不复活、二次 stop 被拒、云端操作数不变', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    await store.startContraction({ intensity: 'mild', notes: 'term-fail-c' })
    failWritesWhen((k, v) => k.endsWith('_contra_active') && v === 'null')
    const stop = await store.stopContraction({ intensity: 'strong' })
    restoreStorageIo()
    assert.equal(stop.ok, false)
    assert.equal(stop.code, 'local-persist-failed')
    assert.equal(stop.cloudSynced, true)
    const docsBefore = contraDocs(stack)
    const opsBefore = opDocs(stack).length
    assert.equal(docsBefore.length, 1)
    assert.equal(docsBefore[0].status, 'finished')
    assert.equal(docsBefore[0].intensity, 'strong', '服务端终态以 stopOp 为准')
    const activeRaw = storage.get(scopedKey(SCOPE, 'contra_active'))
    const activeDoc = JSON.parse(activeRaw)
    assert.equal(activeDoc.status, 'finished', '盘上终态标记')
    assert.ok(activeDoc.stopOp && activeDoc.stopOp.endTime, 'stop 凭据保留在盘')
    // 冷恢复 + 重试：不复活、无新增云端操作
    const client2 = await confirmed(stack)
    const store2 = client2.useToolsStore()
    const rr = store2.restoreFromCache()
    assert.equal(rr.ok, true)
    assert.equal(store2.activeContraction, null, '不复活 ongoing')
    const again = await store2.stopContraction({ intensity: 'mild' })
    assert.equal(again.code, 'no-active-contraction', `无活跃记录可停（实得 ${again.code}）`)
    const retry = await store2.retryPending()
    assert.ok(retry.every(x => x.ok))
    assert.equal(contraDocs(stack).length, 1, '不双写')
    assert.equal(opDocs(stack).length, opsBefore, '零新增云端操作')
    assert.equal(contraDocs(stack)[0].revision, docsBefore[0].revision, '服务端版本不再推进')
  })

  await scenario('同 scope 前台恢复：RAM 最新未保存草稿不被盘上旧 active 顶替（真实页面 onShow）', async () => {
    const stack = makeStack()
    const page = await confirmed(stack, fetalPageBundle)
    const store = page.useToolsStore()
    // 正常开表（落盘一次——盘上 active 此刻无 click）；ticker setInterval 会泄漏挂住
    // 进程（R1_HANDOFF §二 已知现象）——按 r1-tests 先例临时替换，finally 恢复
    const origInterval = global.setInterval
    global.setInterval = () => 0
    try {
    await page.onStart()
    await tick()
    assert.ok(page.session.value, '会话进行中')
    // click 时离线 + 磁盘写失败：RAM 有最新输入与待发日志，盘上是较旧副本
    network.offline = true
    failWritesWhen(k => k.startsWith('momcare_tools_'))
    await page.onKick()
    await tick()
    restoreStorageIo()
    network.offline = false
    const ramClicks = page.rawCount.value
    assert.equal(ramClicks, 1, 'RAM 有未保存点击')
    assert.equal(page.unsaved.value, true, '未保存横幅在')
    // 盘上 active 仍是旧副本（无该 click）
    const diskDoc = JSON.parse(storage.get(scopedKey(SCOPE, 'fetal_active')))
    assert.equal(diskDoc.clicks.length, 0, '盘上为较旧副本（无 click）')
    // 恢复采纳判定（纯 store 层，先于页面自动重试）：RAM 会话保留，不被盘上旧副本顶替
    const ramRef = store.currentFetalSession
    store.restoreFromCache()
    assert.equal(store.currentFetalSession, ramRef, '同 scope RAM 引用保留（未被盘上副本替换）')
    assert.equal(store.currentFetalSession.clicks.length, 1, '未保存 click 保留')
    assert.ok(store.currentFetalSession.journal.some(o => o.kind === 'click'), 'click operationId 保留（可续跑）')
    assert.equal(page.unsaved.value, true, '恢复后未保存状态保持')
    // 真实页面 onShow（restore + 自动重试）：RAM 仍不被顶替，未保存 click 收敛上云
    for (const fn of page.shows) await fn()
    await tick()
    assert.equal(store.currentFetalSession, ramRef, 'onShow 后 RAM 引用仍保留')
    const docs = fetalDocs(stack)
    assert.equal(docs.length, 1)
    assert.equal(docs[0].clicks.length, 1, '未保存 click 最终上云')
    } finally { global.setInterval = origInterval }
  })

  await scenario('页面三态（真实 fetal-timer 横幅）：已隔离备份 / 未能备份 / 孤儿内存恢复——逐字消费', async () => {
    // ① corrupt + 备份成功 → "已隔离备份"，自动同步已暂停
    {
      const stack = makeStack()
      const page = await confirmed(stack, fetalPageBundle)
      const store = page.useToolsStore()
      storage.set(scopedKey(SCOPE, 'fetal_active'), ' { "broken" : 1e21 , } 尾随')
      store.restoreFromCache()
      assert.ok(page.restoreWarningText.value.includes('缓存数据损坏'), `损坏点名（实得 ${page.restoreWarningText.value}）`)
      assert.ok(page.restoreWarningText.value.includes('异常数据已隔离备份'), '已备份态')
      assert.ok(!page.restoreWarningText.value.includes('未能备份'))
      assert.ok(page.restoreWarningText.value.includes('自动同步已暂停'))
    }
    // ② 备份失败 → "未能备份（原数据保留在原位、未被覆写）"（区别于①）
    {
      const stack = makeStack()
      failWritesWhen(k => k.includes('__corrupt_'))
      storage.set(scopedKey(SCOPE, 'fetal_active'), ' { "broken" : 2 , } trailing')
      const page = await confirmed(stack, fetalPageBundle)
      const store = page.useToolsStore()
      store.restoreFromCache()
      assert.equal(store.restoreWarnings.find(x => x.key === 'fetal_active').status, 'corrupt-frozen', '备份失败状态在位')
      assert.ok(page.restoreWarningText.value.includes('缓存数据损坏且备份失败'), '损坏+备份失败点名')
      restoreStorageIo()
      assert.ok(page.restoreWarningText.value.includes('异常数据未能备份（原数据保留在原位、未被覆写）'), '未备份态逐字')
    }
    // ③ 孤儿 RAM 恢复（页面 bundle 内全链：同 bundle 切身份→回接→横幅逐字断言）
    {
      const stack = makeStack()
      const page = await confirmed(stack, fetalPageBundle)
      const store = page.useToolsStore()
      const origInterval3 = global.setInterval
      global.setInterval = () => 0
      try {
      network.offline = true
      failWritesWhen(k => k.startsWith('momcare_tools_'))
      await page.onStart()
      await tick()
      restoreStorageIo()
      network.offline = false
      await tick()
      stack.identity.memberId = 'papa'
      stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
      assert.ok((await page.confirmIdentity()).ok)
      await tick()
      stack.identity.memberId = 'mama'
      stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID)
      assert.ok((await page.confirmIdentity()).ok)
      await tick()
      store.restoreFromCache()
      assert.ok(page.restoreWarningText.value.includes('检测到未落盘的记录草稿，已从内存恢复——数据仍未保存到本地存储'), `孤儿态逐字（实得 ${page.restoreWarningText.value}）`)
      assert.ok(!page.restoreWarningText.value.includes('备份'), '孤儿 RAM 恢复不宣称任何备份')
      assert.equal(page.recoveryBlocked.value, false, '孤儿恢复不落完整性闸')
      assert.ok(page.session.value, '草稿回到页面（可续跑）')
      } finally { global.setInterval = origInterval3 }
    }
  })

  console.log(`\nphase-iv-r1b：${passed} 通过，${failed.length} 失败`)
  if (failed.length > 0) { console.log('失败场景：', failed.join(' | ')); process.exit(1) }
}

main().catch(e => { console.error('套件异常:', e); process.exit(2) })
