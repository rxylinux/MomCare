// B3a 永久页面级回归：真实 data-source-scan.vue / privacy.vue script setup →
// migrationStore → familyStore/outbox → 真实 mc-health/mc-schedule/mc-reports/mc-files handler。
// 每个 case 独立加载页面 bundle（全新 pinia/store/内存兜底）——互不共享模块状态。
// 覆盖 CLOSEOUT 附件管线全部场景：PNG 字节级、意图标记磁盘失败、失败/缺失页重选、
// 真冷启动续传、身份/家庭恢复隔离、错误目标拒绝、privacy 三态/同步统计/清除诚实。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-b3a-page-'))

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

// 可解码的不同 PNG（每个像素不同 → SHA 不同）
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
const PNG1 = makePng(1), PNG2 = makePng(2)
const fileBytesByPath = new Map()
const TEST_ENV = {
  MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-b3apage',
  MC_MEMBER_MAMA_OPENID: 'oTESTMAMA123456', MC_MEMBER_PAPA_OPENID: 'oTESTPAPA123456'
}

// mock cloud
function makeMockCloud() {
  const docs = new Map(), storedFiles = new Map()
  const state = { caller: TEST_ENV.MC_MEMBER_MAMA_OPENID, initialized: false, uploadPaths: [], secondFailed: false, calls: [] }
  const clone = x => JSON.parse(JSON.stringify(x))
  function docApi(col, id, tx) {
    return {
      get: async () => { const e = docs.get(`${col}/${id}`); if (tx) tx.reads.set(`${col}/${id}`, e ? e.__v : 0); return { data: e ? { ...clone(e), _id: id } : null } },
      set: async ({ data }) => {
        if (data && Object.prototype.hasOwnProperty.call(data, '_id')) { const err = new Error('-501007'); err.errMsg = err.message; throw err }
        if (tx) { tx.writes.set(`${col}/${id}`, clone(data)); return { _id: id } }
        const prev = docs.get(`${col}/${id}`); docs.set(`${col}/${id}`, { ...clone(data), __v: (prev ? prev.__v : 0) + 1 }); return { _id: id } },
      remove: async () => { docs.delete(`${col}/${id}`); return {} }
    }
  }
  function runQuery(col, filters, orderByField, dir, limitN) {
    let rows = [...docs.entries()].filter(([k]) => k.startsWith(col + '/')).map(([k, e]) => ({ ...clone(e), _id: k.slice(col.length + 1) }))
    for (const [f, cond] of Object.entries(filters || {})) rows = rows.filter(r => cond && cond.__op === 'lt' ? (r[f] !== undefined && String(r[f]) < String(cond.v)) : JSON.stringify(r[f]) === JSON.stringify(cond))
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
      return { collection: c => ({ doc: id => docApi(c, id, tx) }), commit: async () => { for (const [k, d] of tx.writes) { const p = docs.get(k); docs.set(k, { ...d, __v: (p ? p.__v : 0) + 1 }) } }, rollback: async () => {} }
    },
    collection: c => ({ doc: id => docApi(c, id, null), where: f => makeQuery(c, f), get: async () => ({ data: runQuery(c, {}, null, null, 100) }) })
  }
  return {
    DYNAMIC_CURRENT_ENV: Symbol('env'), init() { state.initialized = true },
    getWXContext: () => ({ APPID: TEST_ENV.MC_APPID, OPENID: state.caller }),
    database() { if (!state.initialized) throw new Error('init first'); return db },
    downloadFile: async ({ fileID }) => { const k = String(fileID).replace(/^cloud:\/\/[^/]+\//, ''); const b = storedFiles.get(k); if (!b) throw new Error('dl'); return { fileContent: Buffer.from(b) } },
    uploadFile: async ({ cloudPath, fileContent }) => { storedFiles.set(cloudPath, Buffer.from(fileContent)); return { fileID: `cloud://e.b/${cloudPath}` } },
    deleteFile: async ({ fileList }) => ({ fileList: fileList.map(f => ({ fileID: f, status: 0 })) }),
    getTempFileURL: async ({ fileList }) => ({ fileList: fileList.map(f => ({ fileID: f, tempFileURL: 'https://t.i/' + f })) }),
    __docs: docs, __stored: storedFiles, __state: state, __setCtx(o) { state.caller = o }
  }
}

// ── 页面 bundle：扫描页 + privacy 页 ──
function buildPageBundle(sourcePath, piniaAnchor, exportLine, outfile) {
  const body = fs.readFileSync(sourcePath, 'utf8').match(/<script setup>([\s\S]*?)<\/script>/)[1]
  let code = body
    .replace(/^import .* from ['"][^'"\n]+\.vue['"];?$/mg, '')
    .replace(/import\s*\{[^}]*onLoad[^}]*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const loads=[];const onLoad=fn=>loads.push(fn);')
    .replace(/import\s*\{[^}]*onShow[^}]*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const shows=[];const onShow=fn=>shows.push(fn);')
  code = 'import { createPinia, setActivePinia } from "pinia";\n' + code.replace(piniaAnchor, `setActivePinia(createPinia());\n${piniaAnchor}`)
  code += '\n' + exportLine
  esbuild.buildSync({ stdin: { contents: code, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile, logLevel: 'silent' })
}
const scanBundle = path.join(temp, 'page.cjs')
const privacyBundle = path.join(temp, 'privacy.cjs')
buildPageBundle(
  path.join(root, 'pages/profile/data-source-scan.vue'),
  'const migrationStore = useMigrationStore()',
  'const mounts=[];const onMounted=fn=>mounts.push(fn);const defineProps=()=>({});const emitCalls=[];const defineEmits=()=>((...a)=>{emitCalls.push(a);return true});\n' +
  'export {mounts,doScan,toggleEntity,doConfirm,doExecute,doReselect,doConfirmReselect,doCancelReselect,previewList,selections,privateConfirmed,attachmentRecovery,attachmentRecoveries,dataSource,familyStore,migrationStore};export * from "./services/sessionService.js";export * from "./services/cloudAdapter.js";export * from "./services/familyStore.js";export * from "./services/migrationStore.js";export * from "./services/outbox.js";export * from "./services/fileUploadService.js";export * from "./utils/cloudConfig.js";',
  scanBundle
)
buildPageBundle(
  path.join(root, 'pages/profile/privacy.vue'),
  'const familyStore = useFamilyStore()',
  'export {dataSource,demoMode,dataModeText,dataItems,totalRecords,syncStatusText,handleAction,familyStore};export * from "./services/sessionService.js";export * from "./services/cloudAdapter.js";export * from "./services/familyStore.js";export * from "./services/outbox.js";export * from "./utils/cloudConfig.js";',
  privacyBundle
)

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
  saveFile: o => { const p = 'store://sv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6); fileBytesByPath.set(p, fileBytesByPath.get(o.tempFilePath) || PNG1); o.success({ savedFilePath: p }) },
  removeSavedFile: o => (o.success && o.success({})),
  chooseImage: o => o.success({ tempFilePaths: ['tmp://pick-' + Date.now() + '.png'] })
}

function makeStack(member = 'mama') {
  // 每个 case 完全独立：清运行时命名空间 + 旧数据白名单键与备份键
  // （上一 case 的迁移会写 MOMCARE_BACKUP_*——不清会作为额外来源泄入下一 case 的扫描）
  for (const k of [...storage.keys()]) {
    if (k.startsWith('mc_outbox_') || k.startsWith('mc_cache_') || k.startsWith('mc_session_') ||
        k.startsWith('YUNTU_') || k.startsWith('MOMCARE_BACKUP_') || k === 'hospital_bag_items') storage.delete(k)
  }
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
    callFunction(o) { cloud.__state.calls.push({ name: o.name, action: o.data?.action, caller: cloud.__state.caller }); const h = routes[o.name]; if (!h) { o.fail({ errMsg: 'no route' }); return } Promise.resolve().then(() => h(o.data)).then(r => o.success({ result: r })).catch(e => o.fail({ errMsg: e.message })) },
    uploadFile(o) {
      cloud.__state.uploadPaths.push(o.filePath)
      fileBytesByPath.set(o.filePath, fileBytesByPath.get(o.filePath) || PNG1)
      const p = String(o.cloudPath); cloud.__stored.set(p, Buffer.from(fileBytesByPath.get(o.filePath)))
      o.success({ fileID: `cloud://e.b/${p}`, statusCode: 200 })
    }
  }
  return { cloud, wxCloud, routes, curMember }
}
function wire(client, stack) {
  client.__setCloudConfigForTests('env-b3ap', 'wxapp-b3ap')
  client.__setWxCloud(stack.wxCloud)
  global.wx = { cloud: stack.wxCloud }
  client.__resetForTests()
}
function freshScan(member = 'mama', seed) {
  const stack = makeStack(member)
  if (seed) seed() // 种子须在命名空间清理之后（否则被当作上一 case 残留清除）
  const client = loadClient(scanBundle)
  wire(client, stack)
  return { client, ...stack, fam: client.familyStore, mig: client.migrationStore }
}
function freshPrivacy(member = 'mama', mode, seed) {
  const stack = makeStack(member)
  if (seed) seed()
  if (mode) storage.set('mc_session_mode', mode) // 模块加载前设置（页面加载时读取）
  const client = loadClient(privacyBundle)
  wire(client, stack)
  return { client, ...stack, fam: client.familyStore }
}

// 种入报告数据（两张不同 PNG）
function seedTwoPageReport() {
  fileBytesByPath.set('wxfile://first', PNG1)
  fileBytesByPath.set('wxfile://second', PNG2)
  storage.set('YUNTU_REPORTS_DATA', JSON.stringify({
    reports: [{ _id: 'two_pages', report_type: 'other', report_date: '2026-05-01', file_urls: ['wxfile://first', 'wxfile://second'] }],
    unarchivedReports: []
  }))
}

async function main() {
  console.log('B3a 永久页面级回归（真实页面 handler→store→outbox→handler，逐 case 独立实例）\n')

  await scenario('页面1：两页不同 PNG 经真实页面迁移→云端附件字节逐页 deepEqual', async () => {
    const { cloud, mig, client } = freshScan('mama', seedTwoPageReport)
    await client.confirmIdentity()
    await client.doScan()
    for (const e of client.previewList.value) client.toggleEntity(e)
    await client.doConfirm()
    assert.ok(mig.batch, '批次创建')
    await client.doExecute()
    await tick(); await tick()
    const entity = mig.batch.entities[0]
    assert.equal(entity.status, 'done', `报告实体状态: ${entity.status} err: ${entity.error}`)
    const report = [...cloud.__docs.entries()].find(([k]) => k.startsWith('mc_reports/'))
    assert.ok(report, '云端报告存在')
    assert.equal(report[1].attachments.length, 2, '两页附件')
    // 逐页字节级比对：云端正式对象字节 === 本机该页原件（PNG1/PNG2 互不相同）
    for (let i = 0; i < 2; i++) {
      assert.equal(report[1].attachments[i].fileId, entity.attachments[i].fileId, `报告附件${i} 与槽位登记一致`)
      const fdoc = cloud.__docs.get('mc_files/' + report[1].attachments[i].fileId)
      assert.ok(fdoc && fdoc.storageFileKey, `附件${i} 登记记录含 storageFileKey`)
      const cloudBytes = cloud.__stored.get(fdoc.storageFileKey)
      const expected = i === 0 ? PNG1 : PNG2
      assert.ok(Buffer.isBuffer(cloudBytes), `附件${i} 云端字节存在`)
      assert.deepEqual(cloudBytes, expected, `附件${i} 云端字节=本机原件（第${i}页 PNG）`)
      assert.deepEqual(entity.attachments[i].order, i, '页序保持')
    }
    assert.notDeepEqual(PNG1, PNG2, '两页本机原件必须不同（否则字节断言无区分力）')
  })

  await scenario('页面2：mayHaveBeenSent 标记磁盘失败→必不发 saveReport（无条件），重试后仅一份', async () => {
    const { cloud, mig, client } = freshScan('mama', seedTwoPageReport)
    await client.confirmIdentity()
    await client.doScan()
    for (const e of client.previewList.value) client.toggleEntity(e)
    await client.doConfirm()
    // 精确注入：仅当批次落盘值含 "mayHaveBeenSent":true 才失败——即标记写那一次
    const realSet = global.uni.setStorageSync
    global.uni.setStorageSync = (k, v) => {
      if (String(k).endsWith('_b3-migration') && String(v).includes('"mayHaveBeenSent":true')) throw new Error('marker disk full')
      return realSet(k, v)
    }
    try {
      await client.doExecute()
    } finally { global.uni.setStorageSync = realSet }
    await tick(); await tick()
    const entity = mig.batch.entities[0]
    // 无条件断言：标记写失败 → 不发 saveReport、无云端报告、意图保留且标记回滚
    assert.equal(cloud.__state.calls.filter(c => c.name === 'mc-reports' && c.action === 'report.upsert').length, 0, '零 report.upsert 调用')
    assert.equal([...cloud.__docs.keys()].filter(k => k.startsWith('mc_reports/')).length, 0, '零云端报告')
    assert.equal(entity.status, 'failed', `实体失败: ${entity.status}`)
    assert.ok(entity.error && entity.error.includes('标记'), `错误信息指向标记写失败: ${entity.error}`)
    assert.ok(entity.reportIntent, '报告意图保留')
    assert.equal(entity.reportIntent.mayHaveBeenSent, false, '标记已回滚（未发送）')
    // 恢复写入后重试：原意图发送且只创建一份
    await client.doExecute()
    await tick(); await tick()
    assert.equal(entity.status, 'done', `重试完成: ${entity.status} ${entity.error}`)
    assert.equal([...cloud.__docs.keys()].filter(k => k.startsWith('mc_reports/')).length, 1, '重试后仅一份云端报告')
  })

  await scenario('页面3：失败页重选→确认→迁移完成（第一页已登记不重传，重选页字节=新图）', async () => {
    const { cloud, mig, client } = freshScan('mama', seedTwoPageReport)
    await client.confirmIdentity()
    await client.doScan()
    for (const e of client.previewList.value) client.toggleEntity(e)
    await client.doConfirm()
    // 第一执行：第二页上传失败
    cloud.__state.secondFailed = false
    const realUpload = global.wx.cloud.uploadFile
    global.wx.cloud.uploadFile = o => {
      const bytes = fileBytesByPath.get(o.filePath) || PNG2
      if (Buffer.isBuffer(bytes) && bytes.equals(PNG2) && !cloud.__state.secondFailed) {
        cloud.__state.secondFailed = true; o.fail({ errMsg: 'synthetic second failure' }); return
      }
      realUpload(o)
    }
    await client.doExecute()
    await tick(); await tick()
    global.wx.cloud.uploadFile = realUpload
    const entity = mig.batch.entities[0]
    assert.equal(entity.status, 'failed', '第一次执行失败')
    assert.ok(entity.attachments[0].fileId, '第一页已登记')
    assert.ok(!entity.attachments[1].fileId, '第二页未登记')
    // 重选第二页——新图 PNG3（与 PNG1/PNG2 均不同）
    const PNG3 = makePng(99)
    fileBytesByPath.set('tmp://reselect-pick.png', PNG3)
    const realChoose = global.uni.chooseImage
    global.uni.chooseImage = o => o.success({ tempFilePaths: ['tmp://reselect-pick.png'] })
    await client.doReselect(mig.batch.batchId, entity.operationId, 1)
    global.uni.chooseImage = realChoose
    assert.ok(entity.attachments[1].reselected && entity.attachments[1].needsConfirm, '已重选待确认')
    assert.ok(entity.attachments[0].fileId, '第一页不受影响')
    client.doConfirmReselect(mig.batch.batchId, entity.operationId, 1)
    assert.ok(!entity.attachments[1].needsConfirm, '已确认')
    const firstUploadCount = cloud.__state.uploadPaths.filter(p => (fileBytesByPath.get(p) || PNG1).equals(PNG1)).length
    await client.doExecute()
    await tick(); await tick()
    assert.equal(entity.status, 'done', `重选后完成: ${entity.status} ${entity.error}`)
    const totalFirst = cloud.__state.uploadPaths.filter(p => (fileBytesByPath.get(p) || PNG1).equals(PNG1)).length
    assert.equal(totalFirst, firstUploadCount, '已登记页不重传')
    // 重选页云端字节 = 新图 PNG3（非旧 PNG2）
    const report = [...cloud.__docs.entries()].find(([k]) => k.startsWith('mc_reports/'))[1]
    const fdoc = cloud.__docs.get('mc_files/' + report.attachments[1].fileId)
    assert.deepEqual(cloud.__stored.get(fdoc.storageFileKey), PNG3, '重选页云端字节=新选择原件')
  })

  await scenario('页面4：缺失页重选（missing→确认→清除缺失→迁移，字节=恢复图）', async () => {
    const PNG3 = makePng(77)
    const { cloud, mig, client } = freshScan('mama', () => {
      fileBytesByPath.set('wxfile://first', PNG1)
      fileBytesByPath.set('tmp://recover-pick.png', PNG3)
      storage.set('YUNTU_REPORTS_DATA', JSON.stringify({
        reports: [{ _id: 'missing_page', report_type: 'other', report_date: '2026-05-01', file_urls: ['wxfile://first', 'https://example.invalid/old'] }],
        unarchivedReports: []
      }))
    })
    await client.confirmIdentity()
    await client.doScan()
    for (const e of client.previewList.value) client.toggleEntity(e)
    await client.doConfirm()
    const entity = mig.batch.entities[0]
    assert.ok(entity.attachments[1].missing, '第二页标记缺失')
    const realChoose = global.uni.chooseImage
    global.uni.chooseImage = o => o.success({ tempFilePaths: ['tmp://recover-pick.png'] })
    await client.doReselect(mig.batch.batchId, entity.operationId, 1)
    global.uni.chooseImage = realChoose
    assert.ok(entity.attachments[1].needsConfirm, '缺失页重选需确认')
    client.doConfirmReselect(mig.batch.batchId, entity.operationId, 1)
    assert.ok(!entity.attachments[1].missing, '确认后清除缺失')
    await client.doExecute()
    await tick(); await tick()
    assert.equal(entity.status, 'done', `恢复后完成: ${entity.status} ${entity.error}`)
    const report = [...cloud.__docs.entries()].find(([k]) => k.startsWith('mc_reports/'))[1]
    const fdoc = cloud.__docs.get('mc_files/' + report.attachments[1].fileId)
    assert.deepEqual(cloud.__stored.get(fdoc.storageFileKey), PNG3, '恢复页云端字节=重选原件')
  })

  await scenario('页面5：恢复句柄错误目标拒绝（错误槽位/错误实体/错误批次）+ 正确目标可恢复', async () => {
    const { mig, client } = freshScan('mama', () => {
      fileBytesByPath.set('wxfile://first', PNG1)
      fileBytesByPath.set('wxfile://second', PNG2)
      storage.set('YUNTU_REPORTS_DATA', JSON.stringify({
        reports: [
          { _id: 'two_pages', report_type: 'other', report_date: '2026-05-01', file_urls: ['wxfile://first', 'wxfile://second'] },
          { _id: 'second_report', report_type: 'other', report_date: '2026-05-02', file_urls: ['wxfile://first'] }
        ],
        unarchivedReports: []
      }))
    })
    await client.confirmIdentity()
    await client.doScan()
    for (const e of client.previewList.value) client.toggleEntity(e)
    await client.doConfirm()
    const b = mig.batch
    assert.equal(b.entities.length, 2, '两个报告实体')
    const A = b.entities.find(e => e.entityKey === 'two_pages')
    const B = b.entities.find(e => e.entityKey === 'second_report')
    assert.ok(A && B, '实体定位')
    // 制造恢复句柄：清单写失败（恢复键可写→durable 记录绑定 A 实体 order 1）
    const realSet = global.uni.setStorageSync
    global.uni.setStorageSync = (k, v) => { if (String(k).endsWith('_b3-migration')) throw new Error('disk full'); return realSet(k, v) }
    await client.doReselect(b.batchId, A.operationId, 1)
    global.uni.setStorageSync = realSet
    const rec = mig.getAttachmentRecovery()
    assert.ok(rec && rec.savedFilePath && rec.persisted === true, '恢复句柄存在（durable）')
    assert.equal(rec.entityOpId, A.operationId, '绑定实体 A')
    assert.equal(rec.order, 1, '绑定 order 1')
    const snapA0 = JSON.stringify(A.attachments[0])
    const snapA1 = JSON.stringify(A.attachments[1])
    const snapB0 = JSON.stringify(B.attachments[0])
    // 错误槽位：句柄属 order 1，请求 order 0
    const wrongOrder = mig.recoverAttachment(b.batchId, A.operationId, 0)
    assert.ok(!wrongOrder.ok, `错误槽位拒绝: ${wrongOrder.code}`)
    // 错误实体：句柄属 A，请求 B
    const wrongEntity = mig.recoverAttachment(b.batchId, B.operationId, 1)
    assert.ok(!wrongEntity.ok, `错误实体拒绝: ${wrongEntity.code}`)
    // 错误批次：句柄属当前批次，请求他批次
    const wrongBatch = mig.recoverAttachment('mig_other_batch_000', A.operationId, 1)
    assert.ok(!wrongBatch.ok, `错误批次拒绝: ${wrongBatch.code}`)
    // 全部被拒——原槽位零变动
    assert.equal(JSON.stringify(A.attachments[0]), snapA0, 'A 第0页未变')
    assert.equal(JSON.stringify(A.attachments[1]), snapA1, 'A 第1页未变')
    assert.equal(JSON.stringify(B.attachments[0]), snapB0, 'B 第0页未变')
    // 正确目标可恢复（非空洞测试）
    const right = mig.recoverAttachment(b.batchId, A.operationId, 1)
    assert.ok(right.ok, `精确匹配可恢复: ${right.code} ${right.message || ''}`)
    assert.equal(A.attachments[1].newLocalPath, rec.savedFilePath, '恢复写入待确认字段')
    assert.ok(A.attachments[1].needsConfirm, '恢复后需确认映射')
  })

  await scenario('页面6：真冷启动（全新模块+重新确认身份）→磁盘恢复批次→续传完成', async () => {
    const stack = makeStack()
    seedTwoPageReport()
    const c1 = loadClient(scanBundle)
    wire(c1, stack)
    await c1.confirmIdentity()
    await c1.doScan()
    for (const e of c1.previewList.value) c1.toggleEntity(e)
    await c1.doConfirm()
    const batchId = c1.migrationStore.batch.batchId
    const opIds = c1.migrationStore.batch.entities.map(e => e.operationId)
    // 冷启动：全新模块实例（新 pinia/store）——与原实例零共享
    const c2 = loadClient(scanBundle)
    wire(c2, stack)
    assert.equal(c2 === c1, false, '全新模块实例')
    await c2.confirmIdentity() // 重新确认身份
    await tick()
    const mig2 = c2.migrationStore
    assert.ok(mig2.batch, '冷启动从磁盘恢复批次')
    assert.equal(mig2.batch.batchId, batchId, '批次 ID 一致')
    assert.deepEqual(mig2.batch.entities.map(e => e.operationId), opIds, '稳定 operationId 一致')
    assert.equal(mig2.batch.status, 'confirmed', '状态保留')
    // 续传执行到完成（真实上传+报告创建）
    await c2.doExecute()
    await tick(); await tick()
    assert.ok(mig2.batch.entities.every(e => e.status === 'done'), `冷启动续传完成: ${mig2.batch.entities.map(e => e.status).join(',')}`)
    const report = [...stack.cloud.__docs.entries()].find(([k]) => k.startsWith('mc_reports/'))
    assert.ok(report, '云端报告创建')
    assert.equal(report[1].attachments.length, 2, '两页附件齐全')
  })

  await scenario('页面7：恢复隔离非空洞——mama 有句柄→papa 严格不可见→mama 回来仍可见', async () => {
    const { cloud, mig, client, curMember } = freshScan('mama', seedTwoPageReport)
    await client.confirmIdentity()
    await client.doScan()
    for (const e of client.previewList.value) client.toggleEntity(e)
    await client.doConfirm()
    // 真实制造恢复句柄（durable，mama 作用域）
    const realSet = global.uni.setStorageSync
    global.uni.setStorageSync = (k, v) => { if (String(k).endsWith('_b3-migration')) throw new Error('disk full'); return realSet(k, v) }
    await client.doReselect(mig.batch.batchId, mig.batch.entities[0].operationId, 1)
    global.uni.setStorageSync = realSet
    const mamaRec = mig.getAttachmentRecovery()
    assert.ok(mamaRec && mamaRec.savedFilePath, 'mama 可见恢复句柄（前置非空洞）')
    assert.equal(mamaRec.memberId, 'mama', '记录属 mama')
    // 切换到 papa——严格 null
    curMember.value = 'papa'
    cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
    client.endSession()
    await client.confirmIdentity()
    await tick()
    assert.equal(mig.getAttachmentRecovery(), null, 'papa 严格不可见（null 而非宽松通过）')
    // 切回 mama——仍可见（不是被删除）
    curMember.value = 'mama'
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID)
    client.endSession()
    await client.confirmIdentity()
    await tick()
    const back = mig.getAttachmentRecovery()
    assert.ok(back && back.savedFilePath === mamaRec.savedFilePath, 'mama 回来句柄仍可见')
  })

  await scenario('页面8：家庭切换→旧家庭批次不可见不可执行', async () => {
    const { cloud, mig, routes, client } = freshScan('mama', seedTwoPageReport)
    await client.confirmIdentity()
    await client.doScan()
    for (const e of client.previewList.value) client.toggleEntity(e)
    await client.doConfirm()
    assert.ok(mig.batch, '批次创建于旧家庭')
    routes['mc-identity'] = () => ({ ok: true, data: { memberId: 'mama', familyId: 'fam-other', displayName: '妈妈' } })
    process.env.MC_FAMILY_ID = 'fam-other'
    await client.confirmIdentity()
    await tick()
    const r = await mig.executeBatch(async () => ({ ok: true }))
    assert.equal(r.ok, false, '旧家庭批次不可执行')
    assert.ok(r.code === 'family-mismatch' || r.code === 'owner-mismatch' || r.code === 'unauthenticated-session' || !mig.batch, `被拒绝: ${r.code}`)
  })

  await scenario('页面9：executor 切换+恢复元数据写失败→原成员内存兜底（完整 env/app/member/family scope）', async () => {
    const { cloud, mig, client, curMember } = freshScan('mama', () => {
      fileBytesByPath.set('tmp://pick-exec.png', PNG1)
      storage.set('YUNTU_REPORTS_DATA', JSON.stringify({
        reports: [{ _id: 'temp_one', report_type: 'other', report_date: '2026-05-01', file_urls: ['tmp://pick-exec.png'] }],
        unarchivedReports: []
      }))
    })
    await client.confirmIdentity()
    await client.doScan()
    for (const e of client.previewList.value) client.toggleEntity(e)
    await client.doConfirm()
    const realSet = global.uni.setStorageSync
    global.uni.setStorageSync = (k, v) => { if (String(k).endsWith('_b3-migration-recovery')) throw new Error('recovery disk full'); return realSet(k, v) }
    const realSave = global.uni.saveFile
    global.uni.saveFile = o => {
      fileBytesByPath.set('store://origin-mama-copy', fileBytesByPath.get(o.tempFilePath))
      Promise.resolve().then(async () => {
        curMember.value = 'papa'
        cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
        client.endSession()
        await client.confirmIdentity()
        await tick()
        o.success({ savedFilePath: 'store://origin-mama-copy' })
      })
    }
    try {
      await client.doExecute()
    } finally {
      global.uni.saveFile = realSave
      global.uni.setStorageSync = realSet
    }
    await tick(); await tick()
    const papaBusiness = cloud.__state.calls.filter(c => c.caller === TEST_ENV.MC_MEMBER_PAPA_OPENID && c.name !== 'mc-identity')
    assert.equal(papaBusiness.length, 0, '旧 continuation 不得以 papa 身份调用业务')
    curMember.value = 'mama'
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID)
    client.endSession()
    await client.confirmIdentity()
    await tick()
    const rec = mig.getAttachmentRecovery()
    assert.ok(rec, '原成员可见内存兜底恢复')
    assert.equal(rec.savedFilePath, 'store://origin-mama-copy', '指向已保存副本')
    assert.equal(rec.persisted, false, '如实标记未持久化')
    assert.equal(rec.envId, 'env-b3ap', 'env 作用域')
    assert.equal(rec.appId, 'wxapp-b3ap', 'app 作用域')
    assert.equal(rec.memberId, 'mama', '成员作用域')
    assert.equal(rec.familyId, TEST_ENV.MC_FAMILY_ID, '家庭作用域')
    assert.ok(String(rec.message).includes('重启'), '含"重启丢失"警示')
    const entity = mig.batch.entities[0]
    assert.equal(rec.entityOpId, entity.operationId, '绑定原实体')
    assert.equal(rec.batchId, mig.batch.batchId, '绑定原批次')
  })

  await scenario('页面10：reselect 双写失败→两条内存恢复各自可用（精确匹配恢复两槽位）', async () => {
    const { mig, client } = freshScan('mama', seedTwoPageReport)
    await client.confirmIdentity()
    await client.doScan()
    for (const e of client.previewList.value) client.toggleEntity(e)
    await client.doConfirm()
    const b = mig.batch, entity = b.entities[0]
    const realSet = global.uni.setStorageSync
    global.uni.setStorageSync = (k, v) => {
      if (String(k).endsWith('_b3-migration') || String(k).endsWith('_b3-migration-recovery')) throw new Error('both stores full')
      return realSet(k, v)
    }
    await client.doReselect(b.batchId, entity.operationId, 0)
    const first = mig.getAttachmentRecovery()
    assert.ok(first && first.order === 0 && first.persisted === false, '第一条内存恢复（order 0）')
    await client.doReselect(b.batchId, entity.operationId, 1)
    const second = mig.getAttachmentRecovery()
    assert.ok(second && second.order === 1 && second.persisted === false, '第二条内存恢复（order 1）')
    assert.notEqual(second.savedFilePath, first.savedFilePath, '两页各自独立副本')
    global.uni.setStorageSync = realSet
    const r0 = mig.recoverAttachment(b.batchId, entity.operationId, 0)
    assert.ok(r0.ok, `第一条恢复可用: ${r0.code} ${r0.message || ''}`)
    assert.equal(entity.attachments[0].newLocalPath, first.savedFilePath, '恢复写入待确认字段')
    assert.ok(entity.attachments[0].needsConfirm, '恢复后需确认映射')
    const r1 = mig.recoverAttachment(b.batchId, entity.operationId, 1)
    assert.ok(r1.ok, `第二条恢复可用: ${r1.code} ${r1.message || ''}`)
    assert.equal(entity.attachments[1].newLocalPath, second.savedFilePath, '第二槽位恢复副本')
  })

  await scenario('页面11：恢复键字节损坏→原字节保留不覆写，新原件走内存兜底', async () => {
    const { mig, client } = freshScan('mama', seedTwoPageReport)
    await client.confirmIdentity()
    await client.doScan()
    for (const e of client.previewList.value) client.toggleEntity(e)
    await client.doConfirm()
    const mKey = [...storage.keys()].find(k => k.endsWith('_b3-migration'))
    assert.ok(mKey, '清单键存在')
    const rKey = mKey + '-recovery'
    const canary = '{CORRUPT_PAGE_REC_CANARY'
    storage.set(rKey, canary)
    const realSet = global.uni.setStorageSync
    global.uni.setStorageSync = (k, v) => { if (String(k).endsWith('_b3-migration')) throw new Error('manifest full'); return realSet(k, v) }
    await client.doReselect(mig.batch.batchId, mig.batch.entities[0].operationId, 0)
    global.uni.setStorageSync = realSet
    assert.equal(storage.get(rKey), canary, '损坏恢复字节原样保留')
    const rec = mig.getAttachmentRecovery()
    assert.ok(rec && rec.order === 0 && rec.persisted === false, '新原件有内存兜底恢复')
  })

  await scenario('页面12：残缺恢复记录不可用作恢复源（全字段精确匹配）', async () => {
    const { mig, client } = freshScan('mama', seedTwoPageReport)
    await client.confirmIdentity()
    await client.doScan()
    for (const e of client.previewList.value) client.toggleEntity(e)
    await client.doConfirm()
    const b = mig.batch, entity = b.entities[0]
    const mKey = [...storage.keys()].find(k => k.endsWith('_b3-migration'))
    const rKey = mKey + '-recovery'
    const base = { batchId: b.batchId, savedFilePath: 'store://incomplete-page', memberId: 'mama', familyId: TEST_ENV.MC_FAMILY_ID, envId: 'env-b3ap', appId: 'wxapp-b3ap', at: Date.now() }
    storage.set(rKey, JSON.stringify([
      { ...base, order: 1 }, // 缺 entityOpId
      { ...base, order: 1, entityOpId: entity.operationId, savedFilePath: 'store://legit-page' } // 完整
    ]))
    const bad = mig.recoverAttachment(b.batchId, entity.operationId, 0)
    assert.ok(!bad.ok, '无完整匹配的槽位拒绝恢复')
    const good = mig.recoverAttachment(b.batchId, entity.operationId, 1)
    assert.ok(good.ok, `完整记录可恢复: ${good.code} ${good.message || ''}`)
    assert.equal(entity.attachments[1].newLocalPath, 'store://legit-page', '恢复源是完整匹配记录')
    // 他家庭 familyId 的记录不进入待恢复列表（作用域过滤）
    const famMismatchRec = { ...base, order: 2, entityOpId: entity.operationId, familyId: 'fam-page-other', savedFilePath: 'store://wrong-family' }
    const list = JSON.parse(storage.get(rKey)); list.push(famMismatchRec)
    storage.set(rKey, JSON.stringify(list))
    assert.ok(!mig.getAttachmentRecoveries().some(r => r.familyId === 'fam-page-other'), '他家庭记录不可见')
    // 消费语义：good 恢复成功已消费匹配条目——同目标重恢复被拒（不重复恢复）
    const again = mig.recoverAttachment(b.batchId, entity.operationId, 1)
    assert.ok(!again.ok, '已消费目标不可重复恢复')
  })

  await scenario('页面13：同槽位两次中断→恢复命中最后一次选择的原件（字节级）', async () => {
    const { mig, client } = freshScan('mama', seedTwoPageReport)
    await client.confirmIdentity()
    await client.doScan()
    for (const e of client.previewList.value) client.toggleEntity(e)
    await client.doConfirm()
    const b = mig.batch, entity = b.entities[0]
    const PNG_A = makePng(201), PNG_B = makePng(202)
    fileBytesByPath.set('tmp://slot-a.png', PNG_A)
    fileBytesByPath.set('tmp://slot-b.png', PNG_B)
    const realChoose = global.uni.chooseImage
    let pick = 0
    global.uni.chooseImage = o => o.success({ tempFilePaths: [++pick === 1 ? 'tmp://slot-a.png' : 'tmp://slot-b.png'] })
    const realSet = global.uni.setStorageSync
    global.uni.setStorageSync = (k, v) => {
      if (String(k).endsWith('_b3-migration') || String(k).endsWith('_b3-migration-recovery')) throw new Error('both stores full')
      return realSet(k, v)
    }
    await client.doReselect(b.batchId, entity.operationId, 0)
    const first = mig.getAttachmentRecovery()
    assert.ok(first && first.order === 0 && first.persisted === false, '第一次中断有内存恢复')
    await client.doReselect(b.batchId, entity.operationId, 0)
    const latest = mig.getAttachmentRecovery()
    assert.ok(latest && latest.savedFilePath !== first.savedFilePath, '第二次选择产生新副本')
    global.uni.setStorageSync = realSet
    global.uni.chooseImage = realChoose
    const r = mig.recoverAttachment(b.batchId, entity.operationId, 0)
    assert.ok(r.ok, `同槽位恢复可用: ${r.code} ${r.message || ''}`)
    assert.equal(entity.attachments[0].newLocalPath, latest.savedFilePath, '恢复到最新原件路径')
    assert.deepEqual(fileBytesByPath.get(entity.attachments[0].newLocalPath), PNG_B, '恢复字节=最后一次选择的原件')
  })

  // ── privacy.vue 真实页面路径 ──

  await scenario('页面14：privacy 三态——prompt/demo/family 与同步文案', async () => {
    // prompt：未确认身份
    {
      const { client } = freshPrivacy()
      assert.equal(client.dataSource.value, 'prompt', '未确认→prompt')
      assert.equal(client.demoMode.value, false, '非演示')
      assert.ok(client.syncStatusText.value.includes('未确认'), `prompt 同步文案: ${client.syncStatusText.value}`)
      assert.ok(client.dataSource.value !== 'family', 'prompt 不显示旧数据入口')
    }
    // demo：显式演示模式（模块加载前设置标记）
    {
      const { client } = freshPrivacy('mama', 'demo-explicit')
      assert.equal(client.dataSource.value, 'demo', '显式演示→demo')
      assert.equal(client.demoMode.value, true, '演示标记')
      assert.equal(client.syncStatusText.value, '演示模式不同步', '演示同步文案')
      assert.ok(client.dataSource.value !== 'family', 'demo 不显示旧数据入口')
    }
    // family：确认身份
    {
      const { client } = freshPrivacy()
      await client.confirmIdentity()
      await tick()
      assert.equal(client.dataSource.value, 'family', '确认→family')
      assert.equal(client.syncStatusText.value, '正常', `family 无待同步: ${client.syncStatusText.value}`)
    }
  })

  await scenario('页面15：privacy 统计真实路径——删除排除、待同步如实显示', async () => {
    const { client, routes, fam } = freshPrivacy()
    await client.confirmIdentity()
    await tick()
    await fam.pullAll()
    // 真实保存两条日记录（真实 mc-health handler）
    assert.ok((await fam.saveDaily('2026-05-01', { weightKg: 62 })).ok, '保存体重记录')
    assert.ok((await fam.saveDaily('2026-05-02', { systolic: 110, diastolic: 70 })).ok, '保存血压记录')
    // 删除第一条（真实墓碑）
    assert.ok((await fam.deleteDaily('2026-05-01')).ok, '删除体重记录')
    await fam.pullAll()
    await tick()
    assert.equal(client.totalRecords.value, 1, `删除已排除（总数=1）: ${client.totalRecords.value}`)
    const items = client.dataItems.value
    assert.equal(items.find(d => d.title === '体重记录').count, '0 条', '体重计数排除删除')
    assert.equal(items.find(d => d.title === '血压记录').count, '1 条', '血压计数保留')
    // 断网保存→outbox 待同步如实显示
    const healthRoute = routes['mc-health']
    routes['mc-health'] = () => ({ ok: false, code: 'cloud-call-failed', message: 'synthetic offline' })
    const r = await fam.saveDaily('2026-05-03', { weightKg: 63 })
    await tick()
    assert.ok(/待同步/.test(client.syncStatusText.value), `断网后显示待同步: ${client.syncStatusText.value} (save.ok=${r.ok})`)
    // 恢复网络 flush→回到正常
    routes['mc-health'] = healthRoute
    await fam.flushAll()
    await fam.pullAll()
    await tick()
    assert.equal(client.syncStatusText.value, '正常', `flush 后正常: ${client.syncStatusText.value}`)
  })

  await scenario('页面16：privacy 清除入口诚实——明确不支持且零删除', async () => {
    const cacheKey = 'mc_cache_env-b3ap_wxapp-b3ap_mama_b1_probe-key'
    const { client } = freshPrivacy('mama', null, () => {
      storage.set('YUNTU_HEALTH_DATA', JSON.stringify({ schemaVersion: 2, records: { '2026-05-01': { weight: 62 } } }))
      storage.set(cacheKey, '{"keep":true}')
    })
    await client.confirmIdentity()
    await tick()
    const before = [...storage.keys()]
    client.handleAction({ action: 'clearCache' })
    await tick()
    const clearToast = global.uni === undefined ? '' : uniCalls.toasts[uniCalls.toasts.length - 1]
    assert.ok(clearToast && clearToast.includes('暂不支持清除'), `清除 toast 如实告知未执行: ${clearToast}`)
    assert.deepEqual([...storage.keys()], before, '存储零删除（含旧键与成员缓存）')
  })

  await scenario('页面17：durable+memory 混存最新胜出（字节级）+ 消费语义 + 结构性无效保留', async () => {
    seedTwoPageReport()
    const { mig, client } = freshScan('mama', () => {
      const PNG_A = makePng(301), PNG_B = makePng(302), PNG_C = makePng(303)
      fileBytesByPath.set('tmp://mix-a.png', PNG_A)
      fileBytesByPath.set('tmp://mix-b.png', PNG_B)
      fileBytesByPath.set('tmp://mix-c.png', PNG_C)
      fileBytesByPath.set('wxfile://first', PNG_A)
      fileBytesByPath.set('wxfile://second', PNG_C)
      storage.set('YUNTU_REPORTS_DATA', JSON.stringify({
        reports: [{ _id: 'two_pages', report_type: 'other', report_date: '2026-05-01', file_urls: ['wxfile://first', 'wxfile://second'] }],
        unarchivedReports: []
      }))
    })
    await client.confirmIdentity()
    await client.doScan()
    for (const e of client.previewList.value) client.toggleEntity(e)
    await client.doConfirm()
    const b = mig.batch, entity = b.entities[0]
    const PNG_A = fileBytesByPath.get('tmp://mix-a.png')
    const PNG_B = fileBytesByPath.get('tmp://mix-b.png')
    const PNG_C = fileBytesByPath.get('tmp://mix-c.png')
    let pick = 0
    const realChoose = global.uni.chooseImage
    global.uni.chooseImage = o => o.success({ tempFilePaths: [['tmp://mix-a.png', 'tmp://mix-b.png', 'tmp://mix-c.png'][pick++]] })
    const realSet = global.uni.setStorageSync
    // ① 首次中断 slot0：仅清单写失败 → durable 恢复条目 A（旧）
    global.uni.setStorageSync = (k, v) => { if (String(k).endsWith('_b3-migration')) throw new Error('manifest full'); return realSet(k, v) }
    await client.doReselect(b.batchId, entity.operationId, 0)
    const durableA = mig.getAttachmentRecovery()
    assert.ok(durableA && durableA.persisted === true, 'durable 条目 A 存在')
    // ② 二次中断 slot0：清单+恢复键都失败 → 内存条目 B（新，同目标）
    global.uni.setStorageSync = (k, v) => {
      if (String(k).endsWith('_b3-migration') || String(k).endsWith('_b3-migration-recovery')) throw new Error('both full')
      return realSet(k, v)
    }
    await client.doReselect(b.batchId, entity.operationId, 0)
    const newest = mig.getAttachmentRecovery()
    assert.ok(newest && newest.persisted === false && newest.savedFilePath !== durableA.savedFilePath, '内存条目 B 为全局最新')
    // ③ slot1 中断：durable 条目 C（其他槽位）
    global.uni.setStorageSync = (k, v) => { if (String(k).endsWith('_b3-migration')) throw new Error('manifest full'); return realSet(k, v) }
    await client.doReselect(b.batchId, entity.operationId, 1)
    // 页面暴露全部待恢复槽位：slot0（最新=B）与 slot1（C）
    const exposed = mig.getAttachmentRecoveries()
    assert.equal(exposed.length, 2, `暴露 2 个待恢复槽位: ${exposed.length}`)
    const slot0 = exposed.find(r => r.order === 0)
    const slot1 = exposed.find(r => r.order === 1)
    assert.ok(slot0 && slot0.savedFilePath === newest.savedFilePath, 'slot0 暴露的是最新条目（B 而非 durable 旧 A）')
    assert.ok(slot1 && slot1.persisted === true, 'slot1 暴露 durable 条目')
    assert.ok(client.attachmentRecoveries.value.length === 2, '页面 computed 暴露全部槽位')
    // 恢复 slot0：必须命中最新 B（字节级），而非 durable 旧 A
    global.uni.setStorageSync = realSet
    global.uni.chooseImage = realChoose
    const r0 = mig.recoverAttachment(b.batchId, entity.operationId, 0)
    assert.ok(r0.ok, `slot0 恢复: ${r0.code} ${r0.message || ''}`)
    assert.equal(entity.attachments[0].newLocalPath, newest.savedFilePath, '恢复路径=最新条目 B')
    assert.deepEqual(fileBytesByPath.get(entity.attachments[0].newLocalPath), PNG_B, '恢复字节=最新选择 B（非 durable 旧 A）')
    // 消费语义：slot0 条目被消费；slot1 原件记录原样保留（可继续恢复）
    const after = mig.getAttachmentRecoveries()
    assert.equal(after.length, 1, `消费后仅剩 slot1: ${after.length}`)
    assert.equal(after[0].order, 1, '剩余的是 slot1')
    const r1 = mig.recoverAttachment(b.batchId, entity.operationId, 1)
    assert.ok(r1.ok, `slot1 仍可恢复: ${r1.code} ${r1.message || ''}`)
    assert.deepEqual(fileBytesByPath.get(entity.attachments[1].newLocalPath), PNG_C, 'slot1 恢复字节=C')
    assert.equal(mig.getAttachmentRecoveries().length, 0, '全部消费后无残留')
  })

  await scenario('页面18：恢复键存在可解析但结构性无效的遗留值→原值保留且新记录可追加', async () => {
    const { mig, client } = freshScan('mama', seedTwoPageReport)
    await client.confirmIdentity()
    await client.doScan()
    for (const e of client.previewList.value) client.toggleEntity(e)
    await client.doConfirm()
    const mKey = [...storage.keys()].find(k => k.endsWith('_b3-migration'))
    const rKey = mKey + '-recovery'
    // 可解析但非记录结构（旧格式/异构数据）——不得被覆写丢弃
    const legacy = { legacyShape: true, note: 'STRUCT_INVALID_KEEP' }
    storage.set(rKey, JSON.stringify(legacy))
    const realSet = global.uni.setStorageSync
    global.uni.setStorageSync = (k, v) => { if (String(k).endsWith('_b3-migration')) throw new Error('manifest full'); return realSet(k, v) }
    await client.doReselect(mig.batch.batchId, mig.batch.entities[0].operationId, 0)
    global.uni.setStorageSync = realSet
    const parsed = JSON.parse(storage.get(rKey))
    assert.ok(Array.isArray(parsed), '追加后为列表')
    assert.deepEqual(parsed[0], legacy, '结构性无效遗留值作为首元素原样保留')
    assert.ok(parsed.some(e => e && e.order === 0 && e.savedFilePath), '新恢复记录已追加')
    // 遗留值不进入可恢复列表（缺目标字段被过滤），新记录可恢复
    const exposed = mig.getAttachmentRecoveries()
    assert.equal(exposed.length, 1, '仅有效记录进入待恢复列表')
    assert.equal(exposed[0].order, 0, '有效记录可暴露')
    const r = mig.recoverAttachment(mig.batch.batchId, mig.batch.entities[0].operationId, 0)
    assert.ok(r.ok, `有效记录可恢复: ${r.code}`)
    // 消费后遗留值仍在（不被连带清除）
    const afterConsume = JSON.parse(storage.get(rKey))
    assert.deepEqual(afterConsume[0], legacy, '消费匹配条目后遗留值仍保留')
  })

  console.log(`\n结果：${passed} 通过，${failed.length} 失败`)
  if (failed.length) { console.log('失败项：\n - ' + failed.join('\n - ')); process.exit(1) }
  process.exit(0)
}

main().catch(e => { console.error('套件异常：', e); process.exit(1) })
