// B3a 永久归档回归：源变化→旧批次归档→重新确认→归档可达/恢复。
// 覆盖已确认缺陷（2026-09-19 独立测试复现，Codex 探针 + 本套件）：
//  ① 归档键损坏原文被当作空覆写（/tmp/momcare-b3a-archive-corrupt-review.cjs
//     source-changed-repreview exit 1）→ 不变量：损坏原文逐字节保留 + 归档失败阻止新确认；
//  ② 历史条目上限截断静默丢弃第 21 条（/tmp/momcare-b3a-archive-cap-review.cjs
//     source-changed-repreview exit 1）→ 不变量：任何历史条目不静默丢弃；
//  ③ 归档批次只写不可达（无 UI/无导出）→ 不变量：页面可见 + 显式恢复为当前批次
//     （实体全字段保真、当前批次无损归档）+ 所有权隔离 + 恢复后仍受 source-changed 门约束；
//  ④ 页面 archivedBatches computed 无响应式依赖（getArchivedBatches 只读普通对象与
//     uni 存储）——首次求值后永不失效：挂载时求值为空→会话内归档后列表不出现；
//     恢复/切成员后列表陈旧（本套件归档3/4/5 场景）→ 不变量：归档写入/恢复/身份变化
//     后页面列表须反映当前存储（会话内可达，不依赖页面重挂载）。
//  ⑤ 同成员换家庭：旧家庭归档条目严格不可见、恢复拒绝 owner-mismatch（归档6）；
//  ⑥ 恢复写序逐点故障注入（归档写成功/活动批次写失败/回滚也失败的任意组合）+
//     冷重启：唯一持久副本不得丢失——接受重复保留，不接受丢失（归档7）；
//  ⑦ 同一挂载页面的存储支撑列表 computed 失效（真实 Vue computed 缓存语义，非每次
//     访问重跑 getter 的桩）：归档5 锚定 archivedBatches（confirmEntities 归档后同页
//     可见）；归档8 锚定 attachmentRecoveries（追加恢复记录后同页可见、消费后刷新）
//     ——并用连续访问同引用/失效后新引用断言证明缓存与失效都真实发生。
// 真实页面 handler→migrationStore→存储；隔离合成数据（hospital_bag_items），不触真实旧键。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-b3a-archive-'))

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
  MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-b3arch',
  MC_MEMBER_MAMA_OPENID: 'oTESTMAMA123456', MC_MEMBER_PAPA_OPENID: 'oTESTPAPA123456'
}

// 可解码互异 PNG（重选原件用——恢复记录携带真实副本路径）
function makePng(idx) {
  const zlib = require('node:zlib')
  const raw = Buffer.from([0, (idx * 37 + 11) % 256, (idx * 89 + 5) % 256, (idx * 151 + 200) % 256])
  const idatData = zlib.deflateSync(raw)
  const crcTable = []
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0 }
  const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
    return Buffer.concat([Buffer.from([0, 0, 0, data.length]), body, crc])
  }
  const ihdrData = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdrData), chunk('IDAT', idatData), chunk('IEND', Buffer.alloc(0))])
}
const fileBytesByPath = new Map()
function seedOnePageReport() {
  fileBytesByPath.set('wxfile://first', makePng(1))
  storage.set('YUNTU_REPORTS_DATA', JSON.stringify({
    reports: [{ _id: 'one_page', report_type: 'other', report_date: '2026-05-01', file_urls: ['wxfile://first'] }],
    unarchivedReports: []
  }))
}

function makeMockCloud() {
  const docs = new Map(), storedFiles = new Map()
  const state = { caller: TEST_ENV.MC_MEMBER_MAMA_OPENID, initialized: false, calls: [] }
  const clone = x => JSON.parse(JSON.stringify(x))
  function docApi(col, id) {
    return {
      get: async () => { const e = docs.get(`${col}/${id}`); return { data: e ? { ...clone(e), _id: id } : null } },
      set: async ({ data }) => { const prev = docs.get(`${col}/${id}`); docs.set(`${col}/${id}`, { ...clone(data), __v: (prev ? prev.__v : 0) + 1 }); return { _id: id } },
      remove: async () => { docs.delete(`${col}/${id}`); return {} }
    }
  }
  function runQuery(col, filters) {
    let rows = [...docs.entries()].filter(([k]) => k.startsWith(col + '/')).map(([k, e]) => ({ ...clone(e), _id: k.slice(col.length + 1) }))
    for (const [f, cond] of Object.entries(filters || {})) rows = rows.filter(r => JSON.stringify(r[f]) === JSON.stringify(cond))
    return rows
  }
  const db = {
    command: { lt: v => ({ __op: 'lt', v }) },
    startTransaction: async () => ({ collection: () => ({ doc: () => ({ get: async () => ({ data: null }), set: async () => ({}) }) }), commit: async () => {}, rollback: async () => {} }),
    collection: c => ({ doc: id => docApi(c, id), where: f => ({ get: async () => ({ data: runQuery(c, f) }) }), get: async () => ({ data: runQuery(c, {}) }) })
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

// 真实页面 script setup（data-source-scan.vue）→ CJS bundle；
// 导出归档入口 doRestoreArchive/archivedBatches 与确认/执行 handler。
function buildPageBundle(outfile) {
  const body = fs.readFileSync(path.join(root, 'pages/profile/data-source-scan.vue'), 'utf8').match(/<script setup>([\s\S]*?)<\/script>/)[1]
  let code = body
    .replace(/^import .* from ['"][^'"\n]+\.vue['"];?$/mg, '')
    .replace(/import\s*\{[^}]*onLoad[^}]*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const loads=[];const onLoad=fn=>loads.push(fn);')
    .replace(/import\s*\{[^}]*onShow[^}]*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const shows=[];const onShow=fn=>shows.push(fn);')
  code = 'import { createPinia, setActivePinia } from "pinia";\n' + code.replace('const migrationStore = useMigrationStore()', 'setActivePinia(createPinia());\nconst migrationStore = useMigrationStore()')
  code += '\nexport {doScan,toggleEntity,doConfirm,doExecute,doRestoreArchive,doReselect,archivedBatches,attachmentRecoveries,previewList,selections,dataSource,migrationStore};export * from "./services/sessionService.js";export * from "./services/cloudAdapter.js";export * from "./services/familyStore.js";export * from "./services/migrationStore.js";export * from "./services/outbox.js";export * from "./services/fileUploadService.js";export * from "./utils/cloudConfig.js"'
  esbuild.buildSync({ stdin: { contents: code, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile, logLevel: 'silent' })
}
const scanBundle = path.join(temp, 'page.cjs')
buildPageBundle(scanBundle)

// 每个 case 全新模块实例（新 pinia/store/内存兜底）——页面与 store 状态不跨 case
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
  saveFile: o => { const p = 'store://sv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6); fileBytesByPath.set(p, fileBytesByPath.get(o.tempFilePath) || makePng(9)); o.success && o.success({ savedFilePath: p }) },
  removeSavedFile: o => (o.success && o.success({})),
  chooseImage: o => o.success({ tempFilePaths: ['tmp://pick.png'] })
}

function makeStack(member = 'mama', opts = {}) {
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
  const wxCloud = {
    init() {},
    callFunction(o) { cloud.__state.calls.push({ name: o.name, caller: cloud.__state.caller }); const h = routes[o.name]; if (!h) { o.fail({ errMsg: 'no route' }); return } Promise.resolve().then(() => h(o.data)).then(r => o.success({ result: r })).catch(e => o.fail({ errMsg: e.message })) },
    uploadFile(o) { o.success({ fileID: 'cloud://e.b/' + o.cloudPath, statusCode: 200 }) }
  }
  return { cloud, wxCloud, routes, curMember }
}
function wire(client, stack) {
  client.__setCloudConfigForTests('env-b3arch', 'wxapp-b3arch')
  client.__setWxCloud(stack.wxCloud)
  global.wx = { cloud: stack.wxCloud }
  client.__resetForTests()
}
function freshScan(member = 'mama', seed) {
  const stack = makeStack(member)
  if (seed) seed() // 种子须在命名空间清理之后
  const client = loadClient(scanBundle)
  wire(client, stack)
  return { client, ...stack, mig: client.migrationStore }
}

const ORIGINAL_BAG = JSON.stringify([{ text: 'Original', category: 'baby', quantity: 1, done: false }])
const CHANGED_BAG = JSON.stringify([{ text: 'Changed', category: 'baby', quantity: 9, done: false }])

// 冷重启：不清理存储，仅全新模块实例 + 重新确认身份（loadBatch 由会话 watch 触发）
function coldRestart(member = 'mama') {
  const stack = makeStack(member, { clear: false })
  const client = loadClient(scanBundle)
  wire(client, stack)
  return { client, ...stack, mig: client.migrationStore }
}

// 按写入次序故障注入：plan = { archive: n, batch: n } —— 第 n 次写归档键/批次键时抛错。
// 返回恢复函数。archive 键后缀判定在前（批次键不含 -archive 后缀，互不歧义）。
function injectWriteFaults(plan) {
  const real = global.uni.setStorageSync
  const counts = { archive: 0, batch: 0 }
  global.uni.setStorageSync = (k, v) => {
    const s = String(k)
    const cls = s.endsWith('_b3-migration-archive') ? 'archive' : (s.endsWith('_b3-migration') ? 'batch' : null)
    if (cls && plan[cls] !== undefined) {
      counts[cls]++
      if (counts[cls] === plan[cls]) throw new Error('synthetic write fail ' + cls + '#' + plan[cls])
    }
    return real(k, v)
  }
  return () => { global.uni.setStorageSync = real }
}

// 冷重启后的持久事实：活动批次键 batchId + 归档列表 batchId 集合
function durableStateAfterRestart() {
  const reloaded = coldRestart('mama')
  return reloaded.client.confirmIdentity().then(() => {
    reloaded.client.migrationStore.loadBatch()
    const batchKey = [...storage.keys()].find(k => k.endsWith('_b3-migration'))
    const archiveKey = [...storage.keys()].find(k => k.endsWith('_b3-migration-archive'))
    const active = batchKey ? JSON.parse(storage.get(batchKey)) : null
    const archive = archiveKey ? JSON.parse(storage.get(archiveKey)) : []
    return { reloaded, active, archive }
  })
}

// 完整走到"源变化后旧批次已归档、新批次为当前"：
// 返回 { mig, client, cloud, B1, B2, snapshot, archiveKey }
async function confirmedThenChangedThenReconfirmed() {
  const ctx = freshScan('mama', () => storage.set('hospital_bag_items', ORIGINAL_BAG))
  const { mig, client } = ctx
  await client.confirmIdentity()
  await client.doScan()
  for (const e of client.previewList.value) client.toggleEntity(e)
  await client.doConfirm()
  const B1 = mig.batch.batchId
  const snapshot = JSON.parse(JSON.stringify(mig.batch))
  // 源变化 → 重新扫描确认（旧批次归档、新批次成为当前）
  storage.set('hospital_bag_items', CHANGED_BAG)
  await client.doScan()
  for (const e of client.previewList.value) client.toggleEntity(e)
  uniCalls.toasts.length = 0
  await client.doConfirm()
  return { ...ctx, mig, client, B1, B2: mig.batch.batchId, snapshot,
    archiveKey: [...storage.keys()].find(k => k.endsWith('_b3-migration-archive')) }
}

async function main() {
  console.log('B3a 永久归档回归（真实页面 handler→migrationStore→存储，逐 case 独立实例）\n')

  await scenario('归档1：源变化重新确认→旧批次归档+20条预置历史+旧批次全部保留（第21条不静默丢弃）', async () => {
    const ctx = freshScan('mama', () => storage.set('hospital_bag_items', ORIGINAL_BAG))
    const { mig, client, cloud } = ctx
    await client.confirmIdentity()
    await client.doScan()
    for (const e of client.previewList.value) client.toggleEntity(e)
    await client.doConfirm()
    const B1 = mig.batch.batchId
    // 预置 20 条历史（第 21 条=本次归档的旧批次，不得静默丢弃任何一条）
    const archiveKey = [...storage.keys()].find(k => k.endsWith('_b3-migration')) + '-archive'
    const hist = Array.from({ length: 20 }, (_, i) => ({ batchId: 'HIST_' + i, entities: [{ operationId: 'OP_' + i }], status: 'partial' }))
    storage.set(archiveKey, JSON.stringify(hist))
    storage.set('hospital_bag_items', CHANGED_BAG)
    await client.doScan()
    for (const e of client.previewList.value) client.toggleEntity(e)
    uniCalls.toasts.length = 0
    await client.doConfirm()
    assert.ok(uniCalls.toasts.some(t => String(t).includes('已确认')), `重新确认成功: ${JSON.stringify(uniCalls.toasts)}`)
    const raw = storage.get(archiveKey)
    const after = JSON.parse(raw)
    assert.equal(after.length, 21, `归档共 21 条（20 历史+旧批次）: ${after.length}`)
    for (const h of hist) assert.ok(after.some(b => b.batchId === h.batchId), `历史 ${h.batchId} 未被静默丢弃`)
    assert.ok(after.some(b => b.batchId === B1), '旧活跃批次已归档')
    assert.notEqual(mig.batch.batchId, B1, '新批次成为当前')
    assert.equal(mig.batch.entities[0].payload.name, 'Changed', '新批次内容=变化后源')
    // 页面可达：结构有效归档条目出现在页面列表（HIST 无 memberId 属结构无效，仅原样保留）
    const ui = client.archivedBatches.value
    assert.ok(ui.some(b => b.batchId === B1), `页面归档列表含旧批次: ${JSON.stringify(ui.map(b => b.batchId))}`)
    assert.ok(!ui.some(b => String(b.batchId).startsWith('HIST_')), '结构无效历史不出现在页面列表（原字节保留≠UI 混入）')
    assert.ok(![...cloud.__docs.keys()].some(k => k.startsWith('mc_bag_items/')), '未执行任何云端突变')
  })

  await scenario('归档2：归档键损坏→原文逐字节保留+归档失败阻止新确认+当前批次不变', async () => {
    const ctx = freshScan('mama', () => storage.set('hospital_bag_items', ORIGINAL_BAG))
    const { mig, client, cloud } = ctx
    await client.confirmIdentity()
    await client.doScan()
    for (const e of client.previewList.value) client.toggleEntity(e)
    await client.doConfirm()
    const B1 = mig.batch.batchId
    const batchKey = [...storage.keys()].find(k => k.endsWith('_b3-migration'))
    const archiveKey = batchKey + '-archive'
    const canary = '{ARCHIVE_CANARY'
    storage.set(archiveKey, canary)
    storage.set('hospital_bag_items', CHANGED_BAG)
    await client.doScan()
    for (const e of client.previewList.value) client.toggleEntity(e)
    uniCalls.toasts.length = 0
    await client.doConfirm()
    assert.ok(!uniCalls.toasts.some(t => String(t).includes('已确认')), `新确认必须被拒绝: ${JSON.stringify(uniCalls.toasts)}`)
    assert.ok(uniCalls.toasts.some(t => String(t).includes('归档')), `用户可见归档失败原因: ${JSON.stringify(uniCalls.toasts)}`)
    assert.equal(storage.get(archiveKey), canary, '损坏归档原文逐字节保留（不当作空覆写）')
    assert.equal(mig.batch.batchId, B1, '归档失败阻止切换新批次——当前批次不变')
    assert.equal(JSON.parse(storage.get(batchKey)).batchId, B1, '持久批次键未被新确认覆写')
    assert.ok(![...cloud.__docs.keys()].some(k => k.startsWith('mc_bag_items/')), '未执行任何云端突变')
  })

  await scenario('归档3：归档批次页面可达+显式恢复（实体保真、当前批次无损归档）+恢复后仍受 source-changed 门', async () => {
    const { mig, client, cloud, B1, B2, snapshot } = await confirmedThenChangedThenReconfirmed()
    const archiveKey = [...storage.keys()].find(k => k.endsWith('_b3-migration-archive'))
    assert.ok(client.archivedBatches.value.some(b => b.batchId === B1), '源变化后旧批次在页面归档列表可达')
    const archived = JSON.parse(storage.get(archiveKey))
    assert.ok(archived.some(b => b.batchId === B1), '归档存储含旧批次')
    // 显式恢复旧批次为当前
    uniCalls.toasts.length = 0
    client.doRestoreArchive(B1)
    assert.ok(uniCalls.toasts.some(t => String(t).includes('已设为当前批次')), `恢复成功提示: ${JSON.stringify(uniCalls.toasts)}`)
    assert.equal(mig.batch.batchId, B1, '恢复后旧批次成为当前批次')
    assert.deepEqual(mig.batch.entities, snapshot.entities, '恢复后实体全字段保真（operationId/targetId/payload/status/attachments）')
    assert.equal(mig.batch.status, snapshot.status, '恢复后批次状态保真')
    const afterRestore = JSON.parse(storage.get(archiveKey))
    assert.ok(!afterRestore.some(b => b.batchId === B1), '恢复条目已从归档移除')
    assert.ok(afterRestore.some(b => b.batchId === B2), '当前批次（B2）被无损归档而非静默丢弃')
    assert.ok(client.archivedBatches.value.some(b => b.batchId === B2), '页面归档列表可见 B2')
    // 恢复的旧批次（正文=Original）在源已变化（Changed）时仍受 source-changed 门约束
    uniCalls.toasts.length = 0
    await client.doExecute()
    await tick()
    assert.ok(uniCalls.toasts.some(t => String(t).includes('源数据已变化')), `执行被 source-changed 门拒绝: ${JSON.stringify(uniCalls.toasts)}`)
    assert.ok(![...cloud.__docs.keys()].some(k => k.startsWith('mc_bag_items/')), 'source-changed 门下零云端突变')
    assert.equal(mig.batch.batchId, B1, '被拒后批次保留（不丢弃恢复材料）')
    assert.equal(mig.batch.entities[0].status, 'pending', '实体状态未被误改')
  })

  await scenario('归档4：归档所有权隔离——papa 不可见不可恢复，mama 回来仍可达', async () => {
    const { mig, client, cloud, curMember, B1 } = await confirmedThenChangedThenReconfirmed()
    assert.ok(client.archivedBatches.value.some(b => b.batchId === B1), '前置：mama 可见归档')
    const mamaArchiveRaw = storage.get([...storage.keys()].find(k => k.endsWith('_b3-migration-archive')))
    // 切换到 papa
    curMember.value = 'papa'
    cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
    client.endSession()
    await client.confirmIdentity()
    await tick()
    assert.equal(client.archivedBatches.value.length, 0, 'papa 严格看不到 mama 的归档批次')
    const r = mig.restoreArchivedBatch(B1)
    assert.ok(!r.ok, `papa 恢复 mama 归档被拒绝: ${JSON.stringify(r)}`)
    assert.ok(!r.ok && r.batch === undefined, '拒绝结果不携带批次内容')
    // 切回 mama——归档仍在（未被 papa 操作破坏）
    curMember.value = 'mama'
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID)
    client.endSession()
    await client.confirmIdentity()
    await tick()
    assert.ok(client.archivedBatches.value.some(b => b.batchId === B1), 'mama 回来归档仍可达')
    assert.equal(storage.get([...storage.keys()].find(k => k.endsWith('_b3-migration-archive'))), mamaArchiveRaw, '归档原字节未被跨成员操作改写')
  })

  await scenario('归档5：真实挂载时序——首渲染求值为空后，会话内归档须立即可见', async () => {
    const ctx = freshScan('mama', () => storage.set('hospital_bag_items', ORIGINAL_BAG))
    const { mig, client } = ctx
    await client.confirmIdentity()
    await client.doScan()
    // 挂载即渲染：模板在归档存在前先求值 archivedBatches（真实 v-if 时序）
    assert.equal(client.archivedBatches.value.length, 0, '前置：挂载时归档为空')
    for (const e of client.previewList.value) client.toggleEntity(e)
    await client.doConfirm()
    const B1 = mig.batch.batchId
    storage.set('hospital_bag_items', CHANGED_BAG)
    await client.doScan()
    for (const e of client.previewList.value) client.toggleEntity(e)
    await client.doConfirm()
    // 归档已写盘（存储为权威事实）——页面列表必须【会话内】反映，否则用户须离开页面才能看到
    const archiveKey = [...storage.keys()].find(k => k.endsWith('_b3-migration-archive'))
    assert.ok(JSON.parse(storage.get(archiveKey)).some(b => b.batchId === B1), '前置：归档已持久化')
    assert.ok(client.archivedBatches.value.some(b => b.batchId === B1), '归档后页面列表会话内立即可见（不依赖重挂载）')
  })

  await scenario('归档6：同成员换家庭——旧家庭归档严格不可见不可恢复，回原家庭仍可达', async () => {
    const { mig, client, routes, B1 } = await confirmedThenChangedThenReconfirmed()
    assert.ok(client.archivedBatches.value.some(b => b.batchId === B1), '前置：原家庭内归档可见')
    // 同 memberId（mama）但 familyId 变化
    routes['mc-identity'] = () => ({ ok: true, data: { memberId: 'mama', familyId: 'fam-other', displayName: '妈妈' } })
    process.env.MC_FAMILY_ID = 'fam-other'
    client.endSession()
    await client.confirmIdentity()
    await tick()
    assert.equal(client.archivedBatches.value.length, 0, '同成员换家庭后旧家庭归档条目严格不可见')
    const r = mig.restoreArchivedBatch(B1)
    assert.ok(!r.ok, '跨家庭恢复被拒绝')
    assert.equal(r.code, 'owner-mismatch', `拒绝码=owner-mismatch: ${r.code}`)
    // 回原家庭——归档仍可达（未被跨家庭操作破坏）
    routes['mc-identity'] = () => ({ ok: true, data: { memberId: 'mama', familyId: TEST_ENV.MC_FAMILY_ID, displayName: '妈妈' } })
    process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID
    client.endSession()
    await client.confirmIdentity()
    await tick()
    assert.ok(client.archivedBatches.value.some(b => b.batchId === B1), '回原家庭归档仍可达')
  })

  await scenario('归档7：恢复写序逐点故障注入+冷重启——任何单点/组合写失败都不得丢失唯一持久副本', async () => {
    // 恢复写序（当前实现）：①归档当前批次(archive#1) → ②持久活动批次(batch#1) → ③移除归档条目(archive#2)。
    // 不变量（与实现顺序无关）：故障后冷重启，恢复目标 B1 与原当前批次 B2 都必须仍在持久存储
    // （活动键或归档任一）——接受保留重复副本，不接受丢失。
    const plans = [
      { plan: { archive: 1 }, expectOk: false, expectCode: 'archive-failed', note: '①当前批次归档写失败' },
      { plan: { batch: 1 }, expectOk: false, expectCode: 'persist-failed', note: '②活动批次写失败（归档未动）' },
      { plan: { archive: 2 }, expectOk: true, expectDuplicate: true, note: '③归档条目移除失败→保留重复副本' },
      { plan: { batch: 1, archive: 2 }, expectOk: false, expectCode: 'persist-failed', note: '②活动批次写失败+后续任何归档写（含回滚）也失败' }
    ]
    for (const { plan, expectOk, expectCode, expectDuplicate, note } of plans) {
      const { mig, client, B1, B2 } = await confirmedThenChangedThenReconfirmed()
      const restore = injectWriteFaults(plan)
      const r = mig.restoreArchivedBatch(B1)
      restore()
      assert.equal(r.ok, expectOk, `${note}: r.ok=${r.ok} code=${r.code}`)
      if (expectCode) assert.equal(r.code, expectCode, `${note}: code=${r.code}`)
      if (expectDuplicate) assert.equal(r.duplicate, true, `${note}: 如实标记重复副本`)
      // 冷重启（全新模块+重新确认）后核验持久事实
      const { active, archive } = await durableStateAfterRestart()
      const archIds = archive.map(b => b && b.batchId)
      const durableIds = new Set(archIds.concat(active ? [active.batchId] : []))
      assert.ok(durableIds.has(B1), `${note}: 冷重启后恢复目标 ${B1} 仍在持久存储（活动=${active && active.batchId}, 归档=${JSON.stringify(archIds)}）`)
      assert.ok(durableIds.has(B2), `${note}: 冷重启后原当前批次 ${B2} 仍在持久存储`)
      const b1Anywhere = archive.find(b => b && b.batchId === B1) || (active && active.batchId === B1 ? active : null)
      assert.ok(b1Anywhere && Array.isArray(b1Anywhere.entities) && b1Anywhere.entities.length > 0, `${note}: B1 实体内容随副本保留（非空壳）`)
    }
  })

  await scenario('归档8：同挂载页面 attachmentRecoveries 失效——追加恢复记录后同页可见、消费后刷新（真实 computed 缓存语义）', async () => {
    const { mig, client } = freshScan('mama', seedOnePageReport)
    await client.confirmIdentity()
    await client.doScan()
    for (const e of client.previewList.value) client.toggleEntity(e)
    await client.doConfirm()
    const b = mig.batch, entity = b.entities[0]
    // 真实 Vue computed 缓存语义：无失效时连续两次访问返回同一引用——证明本套件
    // 跑的是真实 computed 缓存，不是每次访问重跑 getter 的桩（那种桩会让失效测试空洞）
    const a1 = client.attachmentRecoveries.value
    assert.strictEqual(a1, client.attachmentRecoveries.value, 'computed 缓存生效：无失效时同引用（非每访问重跑）')
    assert.equal(a1.length, 0, '前置：挂载时无恢复记录')
    assert.strictEqual(client.archivedBatches.value, client.archivedBatches.value, 'archivedBatches 同样缓存生效')
    // 真实追加路径：重选→清单写失败→durable 恢复记录（存储写触发响应式失效信号）
    const realChoose = global.uni.chooseImage
    fileBytesByPath.set('tmp://pick-r8.png', makePng(88))
    global.uni.chooseImage = o => o.success({ tempFilePaths: ['tmp://pick-r8.png'] })
    const realSet = global.uni.setStorageSync
    global.uni.setStorageSync = (k, v) => { if (String(k).endsWith('_b3-migration')) throw new Error('manifest full'); return realSet(k, v) }
    await client.doReselect(b.batchId, entity.operationId, 0)
    global.uni.setStorageSync = realSet
    global.uni.chooseImage = realChoose
    // 同一挂载页面（未重挂载/未换模块实例）：追加的恢复记录必须立即可见且为新引用（失效后重算）
    const after = client.attachmentRecoveries.value
    assert.notStrictEqual(after, a1, '失效发生：追加后为新引用（computed 真的重算）')
    assert.equal(after.length, 1, `同页立即可见追加的恢复记录: ${after.length}`)
    assert.equal(after[0].order, 0, '记录属于 slot0')
    assert.equal(after[0].persisted, true, 'durable 记录')
    assert.ok(after[0].savedFilePath && String(after[0].savedFilePath).startsWith('store://'), '携带持久副本路径')
    // 恢复（消费）后：同页刷新为空（新引用）——不依赖离开页面
    const r = mig.recoverAttachment(b.batchId, entity.operationId, 0)
    assert.ok(r.ok, `恢复成功: ${r.code} ${r.message || ''}`)
    const consumed = client.attachmentRecoveries.value
    assert.notStrictEqual(consumed, after, '消费后失效重算（新引用）')
    assert.equal(consumed.length, 0, `消费后同页刷新为空: ${consumed.length}`)
    assert.equal(entity.attachments[0].newLocalPath, after[0].savedFilePath, '恢复命中追加记录的副本路径')
  })

  console.log(`\n${passed} 通过, ${failed.length} 失败`)
  if (failed.length) { console.log('失败项：\n - ' + failed.join('\n - ')); process.exit(1) }
}

main().catch(e => { console.error(e); process.exit(1) })
