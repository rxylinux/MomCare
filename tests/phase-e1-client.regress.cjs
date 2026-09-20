// Phase E1 Step 2 客户端级回归：toolsStore → 真实 mc-tools/mc-health handler → mock 云。
// 覆盖：胎动全流（5 分钟去重/撤销/服务端视图采纳）、绝对时间差计时（fetalElapsedMs 纯函数+暂停冻结）、
// 断网落盘与恢复重试（finish 队列不丢、opId 稳定不双写）、宫缩起止/间隔/删除、511 正负例、
// 就医电话读取与空号拦截（不造假号码）。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-e1c-'))

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

// ── 冻结源哈希 ──
const FROZEN_RELS = ['services/toolsStore.js', 'services/sessionService.js', 'cloud/functions/mc-tools/index.js']
const frozenHashes = Object.fromEntries(FROZEN_RELS.map(rel => [rel, sha256(fs.readFileSync(path.join(root, rel)))]))
console.log('冻结源哈希（加载时快照）:')
for (const [rel, h] of Object.entries(frozenHashes)) console.log(`  ${h.slice(0, 8)}  ${rel}`)

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-e1c', MC_MEMBER_MAMA_OPENID: 'oE1CMAMA123456', MC_MEMBER_PAPA_OPENID: 'oE1CPAPA123456' }

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
  showModal: o => { uniCalls.modals.push({ title: o && o.title, content: o && o.content }); o && o.success && o.success({ confirm: true }) },
  makePhoneCall: o => uniCalls.calls.push(o && o.phoneNumber),
  vibrateShort: () => uniCalls.vibrates.push(1),
  showLoading() {}, hideLoading() {},
  redirectTo() {}, navigateTo() {}, switchTab() {}, reLaunch() {}, navigateBack() {},
  request() {}, uploadFile() {}, downloadFile: o => o.fail && o.fail({ errMsg: 'dl' }),
}

// ── 客户端 bundle（独立 pinia；逐 case 全新模块实例）──
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

const network = { offline: false }
function makeStack(member = 'mama') {
  for (const k of [...storage.keys()]) {
    if (k.startsWith('momcare_') || k.startsWith('mc_')) storage.delete(k)
  }
  network.offline = false
  const cloud = makeMockCloud()
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID
  cloud.__setCtx(member === 'mama' ? TEST_ENV.MC_MEMBER_MAMA_OPENID : TEST_ENV.MC_MEMBER_PAPA_OPENID)
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
function wire(stack) {
  const client = loadClient()
  client.__setCloudConfigForTests('env-e1c', 'wxapp-e1c')
  client.__setWxCloud(stack.wxCloud)
  global.wx = { cloud: stack.wxCloud }
  client.__resetForTests()
  return client
}
async function confirmed(stack) {
  const client = wire(stack)
  const r = await client.confirmIdentity()
  assert.ok(r.ok, `confirmIdentity: ${JSON.stringify(r).slice(0, 120)}`)
  return client
}

const fetalDocs = st => [...st.cloud.__docs.entries()].filter(([k]) => k.startsWith('mc_fetal_sessions/')).map(([k, v]) => ({ _id: k.split('/')[1], ...v }))
const contraDocs = st => [...st.cloud.__docs.entries()].filter(([k]) => k.startsWith('mc_contraction_records/')).map(([k, v]) => ({ _id: k.split('/')[1], ...v }))

async function main() {
  console.log('Phase E1 Step 2 客户端级回归（toolsStore → 真实 mc-tools/mc-health）\n')

  await scenario('S1 胎动全流：去重/撤销/服务端视图采纳/绝对时间差（伪时钟）', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    // 伪时钟（落后真实 2h——服务端未来偏斜门兼容）；绝对时间差语义直接可测
    const realNow = Date.now
    let fake = realNow() - 2 * 3600000
    Date.now = () => fake
    try {
      const r = await store.startFetalSession()
      assert.ok(r.ok, `start: ${JSON.stringify(r).slice(0, 150)}`)
      const s = store.currentFetalSession
      assert.ok(s.sessionId && /^fst_/.test(s.sessionId), '服务端 sessionId 已采纳')
      assert.equal(fetalDocs(stack).length, 1, '服务端会话在盘')
      assert.ok(JSON.parse(storage.get('momcare_fetal_active_session')).startTime === s.startTime, '本地活跃会话落盘')
      // 三连击（1 分钟内）→ 1 簇
      fake += 60000; await store.recordFetalClick()
      fake += 60000; await store.recordFetalClick()
      fake += 60000; await store.recordFetalClick()
      assert.equal(s.validCount, 1, `三连击 1 次（实得 ${s.validCount}）`)
      assert.equal(s.rawCount, 3, '原始流水 3')
      // 新簇（+7min）
      fake += 7 * 60000; await store.recordFetalClick()
      assert.equal(s.validCount, 2, '新簇计 2')
      // 服务端视图一致（采纳为真源）
      const serverDoc = fetalDocs(stack)[0]
      assert.equal(serverDoc.validCount, 2); assert.equal(serverDoc.clicks.length, 4)
      // 撤销 → 回 1 簇（第 4 击移除后 [60,120,180] 仍 1 簇）
      await store.undoFetalClick()
      assert.equal(s.validCount, 1); assert.equal(s.rawCount, 3)
      assert.equal(fetalDocs(stack)[0].clicks.length, 3, '服务端同步撤销')
      // 空撤销拒绝（独立会话验证——不消耗主流程点击）
      {
        const r0 = await store.startFetalSession()
        assert.ok(!r0.ok && r0.code === 'session-exists', '已有会话时不可重复开始')
        const u0 = await store.undoFetalClick; void u0
      }
      // 完成：syncDaily → 当日 fetalCount=1
      fake += 5 * 60000
      const fin = await store.finishFetalSession({ syncDaily: true })
      assert.ok(fin.ok, `finish: ${JSON.stringify(fin).slice(0, 150)}`)
      assert.equal(store.currentFetalSession, null, '活跃清理')
      assert.equal(store.fetalSessions.length, 1, '历史 1 项')
      assert.equal(store.fetalSessions[0].status, 'completed')
      const daily = stack.cloud.__docs.get(`mc_health_daily/${TEST_ENV.MC_FAMILY_ID}:${s.dateKey}`)
      assert.ok(daily && daily.fields.fetalCount === 1, `当日胎动累计 1（实得 ${JSON.stringify(daily && daily.fields)}）`)
      // 空撤销拒绝（终态后无会话）
      const u5 = await store.undoFetalClick()
      assert.ok(!u5.ok && u5.code === 'no-active-session', `终态后撤销拒（实得 ${u5.code}）`)
      // 重放 finish（retryPending 幂等——队列已空）
      await store.retryPending()
      assert.equal(stack.cloud.__docs.get(`mc_health_daily/${TEST_ENV.MC_FAMILY_ID}:${s.dateKey}`).fields.fetalCount, 1, '重试不双计')
    } finally {
      Date.now = realNow
    }
  })

  await scenario('S2 绝对时间差与暂停冻结（纯函数）+ 连击边界', async () => {
    const { fetalElapsedMs, recomputeFetalClicks } = loadClient()
    const T = 1000000
    assert.equal(fetalElapsedMs({ startTime: T }, T + 37 * 60000), 37 * 60000, '经过=now−startTime（切后台校准语义）')
    assert.equal(fetalElapsedMs({ startTime: T, pausedAt: T + 5 * 60000 }, T + 60 * 60000), 5 * 60000, '暂停冻结在 pausedAt')
    assert.equal(fetalElapsedMs(null, T), 0, '无会话 0')
    const r1 = recomputeFetalClicks([{ timestamp: T }, { timestamp: T + 300000 }])
    assert.equal(r1.validCount, 1, '边界：恰 300,000ms 合并')
    const r2 = recomputeFetalClicks([{ timestamp: T }, { timestamp: T + 300001 }])
    assert.equal(r2.validCount, 2, '边界：300,001ms 新簇')
    assert.deepEqual(r2.clicks.map(c => c.valid), [true, true])
  })

  await scenario('S3 断网落盘与恢复重试：finish 队列不丢+opId 稳定不双写', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    network.offline = true
    const r1 = await store.startFetalSession()
    assert.ok(!r1.ok && r1.code === 'offline-pending', `断网开始不报成功（实得 ${r1.code}）`)
    await store.recordFetalClick()
    await new Promise(res => setTimeout(res, 5))
    await store.recordFetalClick()
    await new Promise(res => setTimeout(res, 5))
    await store.recordFetalClick()
    assert.equal(store.currentFetalSession.validCount, 1, '断网本地计数照常（毫秒级连击合并为 1 簇）')
    assert.equal(store.currentFetalSession.rawCount, 3, '原始流水 3')
    const fin = await store.finishFetalSession({ syncDaily: true })
    assert.ok(!fin.ok && fin.code === 'offline-pending', '断网完成入队')
    assert.equal(store.currentFetalSession, null, '本地活跃清理')
    assert.equal(store.fetalSessions.length, 1, '历史先行归档 1 项')
    assert.equal(store.fetalSessions[0].synced, false, 'pendingSync 标记')
    assert.equal(store.fetalFinishQueue.length, 1, '终态队列在（携日志副本）')
    // 冷启动恢复：先恢复网络（确认身份需在线），新客户端实例从 storage 复原队列
    network.offline = false
    const client2 = await confirmed(stack)
    const store2 = client2.useToolsStore()
    store2.restoreFromCache()
    assert.equal(store2.fetalFinishQueue.length, 1, '冷启动队列恢复')
    // 重试 → 服务端补齐（start+3 clicks+finish 保序）
    const results = await store2.retryPending()
    assert.ok(results.every(x => x.ok), `重试全成（实得 ${JSON.stringify(results).slice(0, 150)}）`)
    assert.equal(store2.fetalFinishQueue.length, 0, '队列清空')
    const serverSessions = fetalDocs(stack)
    assert.equal(serverSessions.length, 1, '服务端恰一会话')
    assert.equal(serverSessions[0].status, 'completed', '服务端终态补齐')
    assert.equal(serverSessions[0].clicks.length, 3, '点击流水补齐')
    assert.equal(serverSessions[0].validCount, 1, '3 连击（毫秒间隔）=1 簇')
    const daily = stack.cloud.__docs.get(`mc_health_daily/${TEST_ENV.MC_FAMILY_ID}:${serverSessions[0].dateKey}`)
    assert.ok(daily && daily.fields.fetalCount === 1, `当日累计 1（实得 ${JSON.stringify(daily && daily.fields)}）`)
    // 幂等：再重试（队列已空）+ 拉取刷新
    await store2.retryPending()
    assert.equal(fetalDocs(stack)[0].clicks.length, 3, '重试不双写')
    const pull = await store2.pullFetalSessions()
    assert.ok(pull.ok)
    assert.equal(store2.fetalSessions.length, 1, '拉取后历史 1 项')
    assert.equal(store2.fetalSessions[0].status, 'completed')
  })

  await scenario('S4 宫缩：起止/持续/间隔/删除/活跃落盘', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    const realNow = Date.now
    let fake = realNow() - 2 * 3600000
    Date.now = () => fake
    try {
      const st1 = await store.startContraction({ intensity: 'moderate', notes: '第一次' })
      assert.ok(st1.ok, `start: ${JSON.stringify(st1).slice(0, 150)}`)
      assert.ok(store.activeContraction.recordId && /^cnt_/.test(store.activeContraction.recordId), '服务端 recordId 采纳')
      assert.ok(JSON.parse(storage.get('momcare_active_contraction')).startTime === store.activeContraction.startTime, '活跃宫缩落盘')
      fake += 90000
      const sp1 = await store.stopContraction()
      assert.ok(sp1.ok, `stop: ${JSON.stringify(sp1).slice(0, 150)}`)
      assert.equal(store.activeContraction, null, '活跃清理')
      assert.equal(store.contractionRecords.length, 1)
      assert.equal(store.contractionRecords[0].durationSec, 90, '持续 90s')
      // 第二次（首次开始后 +90s+5min=+6.5min）→ 起点间间隔 390s（start-to-start 语义）
      fake += 5 * 60000
      await store.startContraction()
      fake += 60000
      await store.stopContraction()
      assert.equal(store.contractionRecords.filter(r => r.status === 'finished').length, 2)
      const sp2 = await store.pullContractions()
      assert.ok(sp2.ok, '拉取')
      const server = contraDocs(stack)
      assert.equal(server.length, 2)
      const second = server.sort((a, b) => a.startTime - b.startTime)[1]
      assert.equal(second.intervalSec, 390, `间隔=起点差 390s（实得 ${second.intervalSec}）`)
      // 删除误录 → 拉取后排除
      const del = await store.deleteContraction(store.contractionRecords[0].recordId)
      assert.ok(del.ok, `delete: ${JSON.stringify(del).slice(0, 150)}`)
      const after = contraDocs(stack).filter(d => d.status !== 'discarded')
      assert.equal(after.length, 1, '软废弃后 1 条')
    } finally {
      Date.now = realNow
    }
  })

  await scenario('S5 511 判定：正向满足+四类负向+免责声明原文', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    // 直接注入最近 1 小时已结束记录（真实时钟基准——computed 用 Date.now()）
    const now = Date.now()
    const mk = (startOffsetMin, durationSec) => ({
      recordId: `cnt_synth_${startOffsetMin}_${durationSec}`, status: 'finished', synced: true,
      startTime: now - startOffsetMin * 60000, endTime: now - startOffsetMin * 60000 + durationSec * 1000,
      durationSec, intervalSec: 300
    })
    // 正向：12 次覆盖近 55 分钟、间隔 5min、持续 60s
    const good = []
    for (let i = 0; i < 12; i++) good.push(mk(55 - i * 5, 60))
    store.contractionRecords = good
    assert.equal(store.is511Pattern, true, `正向 511（实得 ${store.is511Pattern}）`)
    assert.equal(store.avgDurationSec, 60)
    assert.equal(store.avgIntervalSec, 300)
    assert.equal(store.disclaimer, '✦ 511 规则仅作为辅助参考，不构成医疗诊断。若出现破水、剧烈出血或异常剧痛，无论是否符合规律，请立即前往医院就医！', '免责声明原文精确')
    // 负向①：次数不足（2 次）
    store.contractionRecords = [mk(55, 60), mk(50, 60)]
    assert.equal(store.is511Pattern, false, '负向：次数 <3')
    // 负向②：间隔过长（400s>300）
    store.contractionRecords = [mk(55, 60), mk(48, 60), mk(41, 60), mk(34, 60), mk(27, 60), mk(20, 60), mk(13, 60), mk(6, 60)]
    assert.equal(store.is511Pattern, false, '负向：平均间隔 ~420s')
    // 负向③：持续过短（30s<50）
    store.contractionRecords = good.map(r => ({ ...r, durationSec: 30 }))
    assert.equal(store.is511Pattern, false, '负向：平均持续 30s')
    // 负向④：跨度不足（30 分钟窗口）
    store.contractionRecords = [mk(30, 60), mk(24, 60), mk(18, 60), mk(12, 60), mk(6, 60), mk(1, 60)]
    assert.equal(store.is511Pattern, false, '负向：跨度 ~29min<50min')
    // recentContractions：24h 窗口过滤
    store.contractionRecords = [mk(1, 60), { ...mk(1, 60), startTime: now - 25 * 3600000 }]
    assert.equal(store.recentContractions.length, 1, '24h 窗口过滤')
  })

  await scenario('S6 就医电话：档案权威读取+空号拦截（不造假号码）', async () => {
    // 无档案：未设置/空号拦截
    {
      const stack = makeStack()
      const client = await confirmed(stack)
      const store = client.useToolsStore()
      const fam = client.useFamilyStore()
      await fam.pullAll()
      assert.equal(store.hospitalName, '未设置', '无档案医院=未设置（不造默认值）')
      assert.equal(store.doctorName, '未设置')
      assert.equal(store.hospitalPhone, '', '空号')
      uniCalls.modals.length = 0; uniCalls.calls.length = 0
      const called = store.callHospital()
      assert.equal(called, false, '空号返回 false')
      assert.equal(uniCalls.calls.length, 0, '绝不拨出')
      assert.ok(uniCalls.modals.length === 1 && String(uniCalls.modals[0].content).includes('尚未在孕期档案中填写就医电话，请先去完善'),
        `空号提示原文（实得 ${JSON.stringify(uniCalls.modals)}）`)
    }
    // 有档案：真实读取+拨号
    {
      const stack = makeStack()
      const client = await confirmed(stack)
      const seed = await healthH.main({ action: 'pregnancy.upsert', schemaVersion: 1, operationId: 'e1c-preg', expectedRevision: 0, payload: { hospital: '市妇幼保健院', doctor: '王医生', hospitalPhone: '0571-87654321' } })
      assert.ok(seed.ok, '档案种子')
      const store = client.useToolsStore()
      const fam = client.useFamilyStore()
      await fam.pullAll()
      assert.equal(store.hospitalName, '市妇幼保健院')
      assert.equal(store.doctorName, '王医生')
      assert.equal(store.hospitalPhone, '0571-87654321')
      uniCalls.calls.length = 0
      const called = store.callHospital()
      assert.equal(called, true)
      assert.equal(uniCalls.calls[0], '0571-87654321', '拨出档案真实号码')
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
