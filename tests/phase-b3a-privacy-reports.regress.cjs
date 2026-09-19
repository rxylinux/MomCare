// B3a 永久 privacy 回归：pullAll 不含报告域——计数/同步状态不得在报告域未完成权威拉取时
// 宣称全域已同步（缓存为零或报告拉取失败须如实：部分同步/报告同步异常+（本机缓存）标注）。
// 真实 privacy.vue script setup → familyStore → 真实 mc-health/mc-reports handler；
// 隔离合成数据，不触真实旧键、不部署。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-b3a-priv-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) {
  try { await fn(); pass(name) } catch (e) { fail(name, e) }
}
const tick = () => new Promise(r => setTimeout(r, 20))

cp.execFileSync('node', [path.join(root, 'cloud/assemble.mjs')], { stdio: 'pipe' })
const DIST = path.join(root, 'dist/cloud-functions')
const healthH = require(path.join(DIST, 'mc-health/index.js'))
const scheduleH = require(path.join(DIST, 'mc-schedule/index.js'))
const reportsH = require(path.join(DIST, 'mc-reports/index.js'))
const filesH = require(path.join(DIST, 'mc-files/index.js'))
const identityH = require(path.join(DIST, 'mc-identity/index.js'))

const TEST_ENV = {
  MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-b3apriv',
  MC_MEMBER_MAMA_OPENID: 'oTESTMAMA123456', MC_MEMBER_PAPA_OPENID: 'oTESTPAPA123456'
}

function makeMockCloud() {
  const docs = new Map(), storedFiles = new Map()
  const state = { caller: TEST_ENV.MC_MEMBER_MAMA_OPENID, initialized: false, calls: [] }
  const clone = x => JSON.parse(JSON.stringify(x))
  function docApi(col, id, tx) {
    return {
      get: async () => {
        const e = docs.get(`${col}/${id}`)
        if (tx) tx.reads.set(`${col}/${id}`, e ? e.__v : 0)
        return { data: e ? { ...clone(e), _id: id } : null }
      },
      set: async ({ data }) => {
        if (data && Object.prototype.hasOwnProperty.call(data, '_id')) { const err = new Error('-501007'); err.errMsg = err.message; throw err }
        if (tx) { tx.writes.set(`${col}/${id}`, clone(data)); return { _id: id } }
        const prev = docs.get(`${col}/${id}`)
        docs.set(`${col}/${id}`, { ...clone(data), __v: (prev ? prev.__v : 0) + 1 })
        return { _id: id }
      },
      remove: async () => { docs.delete(`${col}/${id}`); return {} }
    }
  }
  function runQuery(col, filters, orderByField, dir, limitN) {
    let rows = [...docs.entries()].filter(([k]) => k.startsWith(col + '/')).map(([k, e]) => ({ ...clone(e), _id: k.slice(col.length + 1) }))
    for (const [f, cond] of Object.entries(filters || {})) {
      rows = rows.filter(r => cond && cond.__op === 'lt' ? (r[f] !== undefined && String(r[f]) < String(cond.v)) : JSON.stringify(r[f]) === JSON.stringify(cond))
    }
    if (orderByField) { rows.sort((a, b) => String(b[orderByField]).localeCompare(String(a[orderByField]))); if (String(dir).toLowerCase() === 'asc') rows.reverse() }
    return rows.slice(0, limitN || 100)
  }
  function makeQuery(col, filters, orderByField, dir, limitN) {
    return { orderBy: (f, d) => makeQuery(col, filters, f, d, limitN), limit: n => makeQuery(col, filters, orderByField, dir, n), get: async () => ({ data: runQuery(col, filters, orderByField, dir, limitN) }) }
  }
  const db = {
    command: { lt: v => ({ __op: 'lt', v }) },
    startTransaction: async () => {
      const tx = { reads: new Map(), writes: new Map() }
      return { collection: c => ({ doc: id => docApi(c, id, tx) }), commit: async () => { for (const [k, d] of tx.writes) { const prev = docs.get(k); docs.set(k, { ...d, __v: (prev ? prev.__v : 0) + 1 }) } }, rollback: async () => {} }
    },
    collection: c => ({ doc: id => docApi(c, id, null), where: f => makeQuery(c, f), get: async () => ({ data: runQuery(c, {}, null, null, 100) }) })
  }
  const cloud = {
    DYNAMIC_CURRENT_ENV: Symbol('env'),
    init() { state.initialized = true },
    getWXContext() { return { APPID: TEST_ENV.MC_APPID, OPENID: state.caller } },
    database() { if (!state.initialized) throw new Error('init first'); return db },
    downloadFile: async () => { throw new Error('dl') },
    uploadFile: async ({ cloudPath }) => ({ fileID: `cloud://e.b/${cloudPath}` }),
    deleteFile: async ({ fileList }) => ({ fileList: [] }),
    getTempFileURL: async ({ fileList }) => ({ fileList }),
    __docs: docs, __stored: storedFiles, __state: state,
    __setCtx(openid) { state.caller = openid }
  }
  return cloud
}

function buildPrivacyBundle(outfile) {
  const body = fs.readFileSync(path.join(root, 'pages/profile/privacy.vue'), 'utf8').match(/<script setup>([\s\S]*?)<\/script>/)[1]
  let code = body
    .replace(/^import .* from ['"][^'"\n]+\.vue['"];?$/mg, '')
    .replace(/import\s*\{[^}]*onLoad[^}]*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const loads=[];const onLoad=fn=>loads.push(fn);')
    .replace(/import\s*\{[^}]*onShow[^}]*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const shows=[];const onShow=fn=>shows.push(fn);')
  code = 'import { createPinia, setActivePinia } from "pinia";\n' + code.replace('const familyStore = useFamilyStore()', 'setActivePinia(createPinia());\nconst familyStore = useFamilyStore()')
  code += '\nexport {dataSource,demoMode,dataModeText,dataItems,totalRecords,syncStatusText,handleAction,familyStore};export * from "./services/sessionService.js";export * from "./services/cloudAdapter.js";export * from "./services/familyStore.js";export * from "./services/outbox.js";export * from "./services/fileUploadService.js";export * from "./utils/cloudConfig.js"'
  esbuild.buildSync({ stdin: { contents: code, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile, logLevel: 'silent' })
}
const privacyBundle = path.join(temp, 'privacy.cjs')
buildPrivacyBundle(privacyBundle)

function loadClient(bundlePath) {
  delete require.cache[require.resolve(bundlePath)]
  return require(bundlePath)
}

const storage = new Map()
const uniCalls = { toasts: [] }
global.uni = {
  getStorageSync(k) { return storage.has(k) ? storage.get(k) : '' },
  setStorageSync(k, v) { storage.set(k, v) },
  removeStorageSync(k) { storage.delete(k) },
  getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
  showToast: v => uniCalls.toasts.push(v && v.title),
  showLoading() {}, hideLoading() {},
  redirectTo() {}, navigateTo() {}, switchTab() {}, reLaunch() {}, navigateBack() {},
  request: () => {}, uploadFile: () => {},
  saveFile: o => o.success && o.success({ savedFilePath: o.tempFilePath }),
  removeSavedFile: o => (o.success && o.success({})),
  chooseImage: o => o.success({ tempFilePaths: ['tmp://pick.png'] })
}

function freshPrivacy(member = 'mama', seed, routeOverrides, opts = {}) {
  if (opts.clear !== false) {
    for (const k of [...storage.keys()]) {
      if (k.startsWith('mc_outbox_') || k.startsWith('mc_cache_') || k.startsWith('mc_session_') ||
          k.startsWith('YUNTU_') || k.startsWith('MOMCARE_BACKUP_') || k === 'hospital_bag_items') storage.delete(k)
    }
  }
  uniCalls.toasts.length = 0
  const cloud = makeMockCloud()
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID
  process.env.MC_UPLOAD_ENABLED = 'true'
  cloud.__setCtx(member === 'mama' ? TEST_ENV.MC_MEMBER_MAMA_OPENID : TEST_ENV.MC_MEMBER_PAPA_OPENID)
  healthH.__setCloud(cloud); scheduleH.__setCloud(cloud); reportsH.__setCloud(cloud); filesH.__setCloud(cloud); identityH.__setCloud(cloud)
  const curMember = { value: member }
  const routes = {
    'mc-health': e => healthH.main(e),
    'mc-schedule': e => scheduleH.main(e),
    'mc-reports': e => reportsH.main(e),
    'mc-files': e => filesH.main(e),
    'mc-identity': () => ({ ok: true, data: { memberId: curMember.value, displayName: curMember.value === 'mama' ? '妈妈' : '爸爸', familyId: TEST_ENV.MC_FAMILY_ID } })
  }
  if (routeOverrides) for (const [k, v] of Object.entries(routeOverrides)) routes[k] = v
  const wxCloud = {
    init() {},
    callFunction(o) { cloud.__state.calls.push({ name: o.name, caller: cloud.__state.caller }); const h = routes[o.name]; if (!h) { o.fail({ errMsg: 'no route' }); return } Promise.resolve().then(() => h(o.data)).then(r => o.success({ result: r })).catch(e => o.fail({ errMsg: e.message })) },
    uploadFile(o) { o.success({ fileID: 'cloud://e.b/' + o.cloudPath, statusCode: 200 }) }
  }
  if (seed) seed(cloud)
  const client = loadClient(privacyBundle)
  client.__setCloudConfigForTests('env-b3apriv', 'wxapp-b3apriv')
  client.__setWxCloud(wxCloud)
  global.wx = { cloud: wxCloud }
  client.__resetForTests()
  return { client, cloud, routes, curMember, fam: client.familyStore }
}

// 等待页面 refreshAuthoritative 落定：syncing 清零且状态文案进入终态
async function waitRefreshSettled(client, fam) {
  for (let i = 0; i < 150; i++) {
    await tick()
    const txt = client.syncStatusText.value
    if (!fam.syncing && /正常|异常|部分|待同步|尚未/.test(txt)) return txt
  }
  return client.syncStatusText.value
}

async function main() {
  console.log('B3a 永久 privacy 回归（pullAll 不含报告域——计数/同步状态诚实性）\n')

  await scenario('privacy1：健康域成功+报告域拉取失败（ok:false）→不宣称正常，报告计数如实标注本机缓存', async () => {
    const { client, fam } = freshPrivacy('mama', null, {
      'mc-reports': () => ({ ok: false, code: 'synthetic-reports-down', message: '报告服务不可用' })
    })
    await client.confirmIdentity()
    const txt = await waitRefreshSettled(client, fam)
    assert.ok(fam.lastFullSyncAt, '健康域权威拉取完成（pullAll 成功）')
    assert.ok(!fam.lastReportSyncAt, '报告域未完成权威拉取（pullAll 本就不含报告）')
    assert.ok(txt.startsWith('报告同步异常'), `状态如实显示报告域异常: "${txt}"`)
    assert.notEqual(txt, '正常', '不得宣称全域正常')
    const items = client.dataItems.value
    const rpt = items.find(d => d.title === '产检报告')
    assert.equal(rpt.count, '0 份（本机缓存）', `报告计数带本机缓存标注: "${rpt.count}"`)
  })

  await scenario('privacy2：健康域成功+报告域 handler 异常（reject）→不宣称正常（异常路径同样可见）', async () => {
    const { client, fam } = freshPrivacy('mama', null, {
      'mc-reports': () => { throw new Error('synthetic crash') }
    })
    await client.confirmIdentity()
    const txt = await waitRefreshSettled(client, fam)
    assert.ok(fam.lastFullSyncAt, '健康域权威拉取完成')
    assert.ok(!fam.lastReportSyncAt, '报告域未完成')
    assert.ok(txt.startsWith('报告同步异常'), `reject 路径同样如实: "${txt}"`)
    assert.ok(client.dataItems.value.find(d => d.title === '产检报告').count.endsWith('（本机缓存）'), '报告计数如实标注')
  })

  await scenario('privacy3：对照——两域都完成权威拉取→正常，报告计数无缓存标注', async () => {
    const { client, fam } = freshPrivacy('mama')
    await client.confirmIdentity()
    const txt = await waitRefreshSettled(client, fam)
    assert.ok(fam.lastFullSyncAt, '健康域完成')
    assert.ok(fam.lastReportSyncAt, '报告域完成（页面显式补拉）')
    assert.equal(txt, '正常', `两域完成后正常: "${txt}"`)
    assert.equal(client.dataItems.value.find(d => d.title === '产检报告').count, '0 份', '零报告是权威零，非缓存零——无标注')
  })

  await scenario('privacy4：刷新竞态——mama 在途请求延迟失败跨身份到达→零污染，papa 必有自己完整拉取', async () => {
    const { client, cloud, routes, curMember, fam } = freshPrivacy('mama')
    // mama 的健康/报告请求延迟 120ms 返回失败垃圾；切换后（caller=papa）走真实 handler 快速成功
    const realHealth = routes['mc-health'], realReports = routes['mc-reports']
    let staleDelivered = 0
    const delayedFail = h => e => {
      if (cloud.__state.caller === TEST_ENV.MC_MEMBER_MAMA_OPENID) {
        return new Promise((_, rej) => setTimeout(() => { staleDelivered++; rej(new Error('stale garbage')) }, 120))
      }
      return h(e)
    }
    routes['mc-health'] = delayedFail(realHealth)
    routes['mc-reports'] = delayedFail(realReports)
    await client.confirmIdentity() // mama 刷新开始（watch 异步 flush 后派发）
    // 等 mama 的两域请求确实派发（以云调用记录为证），再在 120ms 延迟窗口内切换
    let mamaDispatched = 0
    for (let i = 0; i < 30 && mamaDispatched === 0; i++) {
      await tick()
      mamaDispatched = cloud.__state.calls.filter(c => c.caller === TEST_ENV.MC_MEMBER_MAMA_OPENID).length
    }
    assert.ok(mamaDispatched > 0, '前置：mama 刷新请求已派发（在途）')
    // 立即切换 papa——旧 continuation 的迟到失败不得污染新身份 UI
    curMember.value = 'papa'
    cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
    client.endSession()
    await client.confirmIdentity()
    let txt = ''
    const seen = []
    for (let i = 0; i < 200; i++) {
      await tick()
      txt = client.syncStatusText.value
      seen.push(txt)
      if (!fam.syncing && txt === '正常') break
    }
    assert.ok(staleDelivered >= 1, `旧身份延迟失败确已到达（非跳过）: ${staleDelivered}`)
    assert.equal(txt, '正常', `papa 最终正常（自己的完整拉取+busy 重试）: "${txt}"`)
    assert.equal(fam.lastError, '', '旧身份失败垃圾未写入新身份 lastError')
    assert.ok(fam.lastFullSyncAt && fam.lastReportSyncAt, '新身份两域权威拉取都完成')
    // 全程采样：旧完成在【任何时刻】都不得把新身份的文案写成异常（非仅终态干净）
    assert.ok(!seen.some(t => String(t).includes('异常')), `全程无旧身份失败污染样本: ${JSON.stringify([...new Set(seen)])}`)
    assert.equal(client.dataItems.value.find(d => d.title === '产检报告').count, '0 份', '新身份报告计数为权威零（无缓存标注）')
  })

  await scenario('privacy5：刷新竞态（同成员换家庭）——旧请求在途+新家庭确认→自己拉取两域，旧完成不写新错误', async () => {
    const { client, cloud, routes, fam } = freshPrivacy('mama')
    // 判别用"派发波次"而非 caller（同 memberId 换家庭前后 openid 不变）：
    // 切换前派发的请求延迟 120ms 失败；切换后走真实 handler
    const realHealth = routes['mc-health'], realReports = routes['mc-reports']
    let oldWave = true, staleDelivered = 0
    const delayedFail = h => e => oldWave
      ? new Promise((_, rej) => setTimeout(() => { staleDelivered++; rej(new Error('stale garbage')) }, 120))
      : h(e)
    routes['mc-health'] = delayedFail(realHealth)
    routes['mc-reports'] = delayedFail(realReports)
    await client.confirmIdentity()
    let dispatched = 0
    for (let i = 0; i < 30 && dispatched === 0; i++) {
      await tick()
      dispatched = cloud.__state.calls.length
    }
    assert.ok(dispatched > 0, '前置：旧家庭刷新请求已派发（在途）')
    // 同 memberId 换 familyId——立即切换（120ms 延迟窗口内）
    oldWave = false
    routes['mc-identity'] = () => ({ ok: true, data: { memberId: 'mama', familyId: 'fam-other', displayName: '妈妈' } })
    process.env.MC_FAMILY_ID = 'fam-other'
    client.endSession()
    await client.confirmIdentity()
    let txt = ''
    const seen = []
    for (let i = 0; i < 200; i++) {
      await tick()
      txt = client.syncStatusText.value
      seen.push(txt)
      if (!fam.syncing && txt === '正常') break
    }
    assert.ok(staleDelivered >= 1, `旧家庭延迟失败确已到达（非跳过）: ${staleDelivered}`)
    assert.equal(txt, '正常', `新家庭身份最终正常（自己的两域拉取+busy 重试）: "${txt}"`)
    assert.equal(fam.lastError, '', '旧家庭失败垃圾未写入新身份 lastError')
    assert.ok(fam.lastFullSyncAt && fam.lastReportSyncAt, '新家庭身份两域权威拉取都完成')
    assert.ok(!seen.some(t => String(t).includes('异常')), `全程无旧完成污染样本: ${JSON.stringify([...new Set(seen)])}`)
  })

  await scenario('privacy6：长占用竞态——mama 健康 pullAll busy 超 2.1s（越过旧 40×50ms 预算）→papa 仍最终拉到两域，旧完成零污染', async () => {
    const { client, cloud, routes, curMember, fam } = freshPrivacy('mama')
    const realHealth = routes['mc-health'], realReports = routes['mc-reports']
    let staleDelivered = 0
    // mama 的请求挂起 2300ms 后失败（> 旧的 40×50ms=2s busy 重试预算）——切换后 caller=papa 走真实 handler
    const longHold = h => e => {
      if (cloud.__state.caller === TEST_ENV.MC_MEMBER_MAMA_OPENID) {
        return new Promise((_, rej) => setTimeout(() => { staleDelivered++; rej(new Error('stale garbage 2300ms')) }, 2300))
      }
      return h(e)
    }
    routes['mc-health'] = longHold(realHealth)
    routes['mc-reports'] = longHold(realReports)
    await client.confirmIdentity()
    let dispatched = 0
    for (let i = 0; i < 30 && dispatched === 0; i++) {
      await tick()
      dispatched = cloud.__state.calls.length
    }
    assert.ok(dispatched > 0, '前置：mama 请求已派发（在途）')
    curMember.value = 'papa'
    cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
    client.endSession()
    await client.confirmIdentity()
    // 旧身份占住 syncing 约 2.3s——新身份不得因此放弃：安全阀轮询直至释放后完成自己的两域拉取
    let txt = ''
    const seen = []
    for (let i = 0; i < 400; i++) {
      await tick()
      txt = client.syncStatusText.value
      seen.push(txt)
      if (!fam.syncing && txt === '正常') break
    }
    assert.ok(staleDelivered >= 1, `旧身份延迟失败（2300ms）确已跨身份到达: ${staleDelivered}`)
    assert.equal(txt, '正常', `busy>2.1s 后 papa 仍最终完成两域（不被旧预算放弃）: "${txt}"`)
    assert.ok(fam.lastFullSyncAt && fam.lastReportSyncAt, 'papa 自己的两域权威拉取都完成')
    assert.equal(fam.lastError, '', '旧完成未写新身份 lastError')
    assert.ok(!seen.some(t => String(t).includes('异常')), `全程零污染样本: ${JSON.stringify([...new Set(seen)])}`)
    assert.equal(client.dataItems.value.find(d => d.title === '产检报告').count, '0 份', '新身份报告计数为权威零（无缓存标注）')
  })

  await scenario('privacy7：持久化旧 lastReportSyncAt+缓存计数——本次挂载报告拉取失败仍须标注（本机缓存）', async () => {
    // 会话1：云端种 1 份真实报告→两域拉取成功→快照持久化 reports 计数与 lastReportSyncAt
    const { client, cloud, routes, curMember, fam } = freshPrivacy('mama', cl => {
      cl.__docs.set('mc_reports/rpt-seed-1', {
        familyId: TEST_ENV.MC_FAMILY_ID, report_type: '血常规', report_date: '2026-04-15',
        attachments: [], deleted: false, revision: 1, sortKey: '2026-04-15|rpt-seed-1', updatedAt: Date.now()
      })
    })
    await client.confirmIdentity()
    for (let i = 0; i < 150; i++) {
      await tick()
      if (fam.lastFullSyncAt && fam.lastReportSyncAt && !fam.syncing) break
    }
    assert.ok(fam.lastFullSyncAt && fam.lastReportSyncAt, '会话1 两域完成（前置）')
    assert.equal(client.dataItems.value.find(d => d.title === '产检报告').count, '1 份', `权威计数无标注（前置）: "${client.dataItems.value.find(x => x.title === '产检报告').count}"`)
    // 直接换成员重确认（不经 endSession——那会把 watcher 的 lastWatchedMemberId
    // 重置为 null 而跳过恢复）：watcher 成员变化→clearMemory+restoreFromCache，
    // 持久化快照（旧 lastReportSyncAt+缓存计数）重新进入内存（真实在应用路径）
    curMember.value = 'papa'
    cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
    await client.confirmIdentity()
    await tick()
    routes['mc-reports'] = () => ({ ok: false, code: 'synthetic-down', message: '报告服务不可用' })
    curMember.value = 'mama'
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID)
    await client.confirmIdentity()
    await tick()
    assert.ok(fam.lastReportSyncAt, '前置：旧 lastReportSyncAt 已从持久化快照恢复（陷阱存在）')
    assert.equal(Object.values(fam.reports || {}).filter(r => r && !r.deleted).length, 1, '前置：缓存计数 1 份已恢复')
    // 本次刷新报告域失败——旧持久化时间戳不得解除缓存标注
    let txt = ''
    for (let i = 0; i < 150; i++) {
      await tick()
      txt = client.syncStatusText.value
      if (!fam.syncing && txt.startsWith('报告同步异常')) break
    }
    assert.ok(txt.startsWith('报告同步异常'), `挂载后拉取失败如实可见: "${txt}"`)
    assert.ok(fam.lastReportSyncAt, '旧时间戳仍在（证明标注不是靠清掉它实现的）')
    const rpt = client.dataItems.value.find(d => d.title === '产检报告')
    assert.ok(rpt.count.startsWith('1 份'), `缓存计数仍在（1 份）: "${rpt.count}"`)
    assert.equal(rpt.count, '1 份（本机缓存）', `旧时间戳+本次失败→计数必须标注本机缓存: "${rpt.count}"`)
  })

  console.log(`\n${passed} 通过, ${failed.length} 失败`)
  if (failed.length) { console.log('失败项：\n - ' + failed.join('\n - ')); process.exit(1) }
}

main().catch(e => { console.error(e); process.exit(1) })
