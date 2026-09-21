// R7 回前台复核竞态回归：同成员自动复核不再误伤在途上传/拉取；真换成员全部拦截不回退。
// 复现真机 2026-09-22 两报错：
//   ① 产检档案页"同步失败，请重试/可能是数据库配额已用完"——确认在途撞拉取
//     （familyCall confirming 拒绝）+ 静态配额猜测文案；修复=settle 后拉取 + 真实原因透传
//   ② 上传"会话已切换，未建立上传批次"——选图返回必触发 App.onShow 自动复核，
//     confirmIdentity 连递纪元撞建批裸 epoch 守卫；修复=会话指纹（同成员复核不算切换）
// 真实客户端（store / archives 页 / UploadSheet script）→ 真实 mc-* 组装产物 handler
// → SDK 契约模拟（隔离，零真实网络）。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-r7-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) {
  try { await fn(); pass(name) } catch (e) { fail(name, e) }
}
const tick = () => new Promise(r => setTimeout(r, 15))

cp.execFileSync('node', [path.join(root, 'cloud/assemble.mjs')], { stdio: 'pipe' })
const DIST = path.join(root, 'dist/cloud-functions')
const reportsH = require(path.join(DIST, 'mc-reports/index.js'))
const filesH = require(path.join(DIST, 'mc-files/index.js'))
const healthH = require(path.join(DIST, 'mc-health/index.js'))
const identityH = require(path.join(DIST, 'mc-identity/index.js'))

// 真实可解码 PNG（与 b2b2 同构）：按序号改变像素——上传替身按 filePath 携带真实内容
function makePng(idx) {
  const width = 1, height = 1
  const bitDepth = 8, colorType = 2
  const ihdr = Buffer.from([0, 0, 0, 13, 73, 72, 68, 82,
    (width >>> 24) & 255, (width >>> 16) & 255, (width >>> 8) & 255, width & 255,
    (height >>> 24) & 255, (height >>> 16) & 255, (height >>> 8) & 255, height & 255,
    bitDepth, colorType, 0, 0, 0])
  const raw = Buffer.from([0, (idx * 37 + 11) % 256, (idx * 89 + 5) % 256, (idx * 151 + 200) % 256])
  const zlib = require('node:zlib')
  const idatData = zlib.deflateSync(raw)
  const idat = Buffer.concat([Buffer.from([0, 0, 0, idatData.length, 73, 68, 65, 84]), idatData])
  const iend = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68])
  const crcTable = []
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0 }
  const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
    return Buffer.concat([Buffer.from([0, 0, 0, data.length]), body, crc])
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([sig, chunk('IHDR', ihdr.slice(8, 8 + 13)), chunk('IDAT', idatData), chunk('IEND', Buffer.alloc(0))])
}
const localFileBytes = new Map()
const TEST_ENV = {
  MC_APPID: 'wxtestappid0001',
  MC_FAMILY_ID: 'fam-r7test',
  MC_MEMBER_MAMA_OPENID: 'oTESTMAMA123456',
  MC_MEMBER_PAPA_OPENID: 'oTESTPAPA123456'
}
function setServerEnv() {
  process.env.MC_APPID = TEST_ENV.MC_APPID
  process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID
  process.env.MC_MEMBER_MAMA_OPENID = TEST_ENV.MC_MEMBER_MAMA_OPENID
  process.env.MC_MEMBER_PAPA_OPENID = TEST_ENV.MC_MEMBER_PAPA_OPENID
  process.env.MC_UPLOAD_ENABLED = 'true'
}

// SDK 契约模拟（与 b2b2 同构）：文档库 + 对象库 + 事务版本冲突
function makeMockCloud() {
  const docs = new Map()
  const storedFiles = new Map()
  const state = { deletionFails: 0, deletedObjects: [], clockOffset: 0, failCommitAfterUpload: 0 }
  const realNow = Date.now
  Date.now = () => realNow() + state.clockOffset
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
      remove: async () => { docs.delete(`${col}/${id}`); return { stats: { removed: 1 } } }
    }
  }
  function runQuery(col, filters, orderByField, dir, limitN) {
    let rows = [...docs.entries()].filter(([k]) => k.startsWith(col + '/'))
      .map(([k, e]) => ({ ...clone(e), _id: k.slice(col.length + 1) }))
    for (const [f, cond] of Object.entries(filters || {})) {
      rows = rows.filter(r => cond && cond.__op === 'lt'
        ? (r[f] !== undefined && String(r[f]) < String(cond.v))
        : JSON.stringify(r[f]) === JSON.stringify(cond))
    }
    if (orderByField) {
      rows.sort((a, b) => String(b[orderByField]).localeCompare(String(a[orderByField])))
      if (String(dir).toLowerCase() === 'asc') rows.reverse()
    }
    return rows.slice(0, limitN || 100)
  }
  function makeQuery(col, filters, orderByField, dir, limitN) {
    return {
      orderBy: (f, d) => makeQuery(col, filters, f, d, limitN),
      limit: n => makeQuery(col, filters, orderByField, dir, n),
      get: async () => ({ data: runQuery(col, filters, orderByField, dir, limitN) })
    }
  }
  const db = {
    command: { lt: v => ({ __op: 'lt', v }) },
    startTransaction: async () => {
      const tx = { reads: new Map(), writes: new Map() }
      return {
        collection: c => ({ doc: id => docApi(c, id, tx) }),
        commit: async () => {
          if (state.failCommitAfterUpload > 0) { state.failCommitAfterUpload--; throw new Error('commit failed (mock infra)') }
          for (const k of tx.writes.keys()) {
            const cur = docs.get(k)
            if ((cur ? cur.__v : 0) !== (tx.reads.get(k) || 0)) { const err = new Error('transaction conflict'); err.errMsg = 'db transaction conflict'; throw err }
          }
          for (const [k, d] of tx.writes) {
            const prev = docs.get(k)
            docs.set(k, { ...clone(d), __v: (prev ? prev.__v : 0) + 1 })
          }
        },
        rollback: async () => {}
      }
    },
    collection: c => ({
      doc: id => docApi(c, id, null),
      where: f => makeQuery(c, f),
      get: async () => ({ data: runQuery(c, {}, null, null, 100) })
    })
  }
  const cloud = {
    DYNAMIC_CURRENT_ENV: Symbol('env'),
    init() { state.initialized = true },
    getWXContext() { return { APPID: TEST_ENV.MC_APPID, OPENID: state.caller, ENV: 'env' } },
    database() { if (!state.initialized) throw new Error('init first'); return db },
    downloadFile: async ({ fileID }) => {
      const key = String(fileID).replace(/^cloud:\/\/[^/]+\//, '')
      const buf = storedFiles.get(key)
      if (!buf) { const err = new Error('download fail'); err.errMsg = 'downloadFile:fail'; throw err }
      return { fileContent: Buffer.from(buf) }
    },
    uploadFile: async ({ cloudPath, fileContent }) => {
      storedFiles.set(cloudPath, Buffer.from(fileContent))
      return { fileID: `cloud://env-r7.bucket/${cloudPath}` }
    },
    deleteFile: async ({ fileList }) => {
      assert.ok(Array.isArray(fileList), 'SDK deleteFile 需要 fileList')
      state.deletedObjects.push(...fileList)
      const ok = state.deletionFails <= 0
      if (ok) for (const id of fileList) storedFiles.delete(String(id).replace(/^cloud:\/\/[^/]+\//, ''))
      else state.deletionFails--
      return { fileList: fileList.map(f => ({ fileID: f, status: ok ? 0 : -1, errMsg: ok ? 'ok' : 'synthetic failure' })) }
    },
    getTempFileURL: async ({ fileList }) => ({ fileList: fileList.map(f => ({ fileID: f, tempFileURL: 'https://temp.invalid/' + f })) }),
    __state: state, __docs: docs, __stored: storedFiles,
    __setCtx(openid) { state.caller = openid }
  }
  return cloud
}

// ── 客户端 bundle：services 组 + archives 页 + UploadSheet 页 ──
const servicesBundle = path.join(temp, 'client.cjs')
esbuild.buildSync({
  stdin: {
    contents: `export { createPinia, setActivePinia } from 'pinia';
      export * from './services/cloudAdapter.js';
      export * from './services/sessionService.js';
      export * from './services/outbox.js';
      export * from './services/familyStore.js';
      export * from './services/reportFamilyStore.js';
      export * from './services/fileUploadService.js';
      export * from './utils/cloudConfig.js';`,
    resolveDir: root
  },
  bundle: true, platform: 'node', format: 'cjs', alias: { '@': root },
  outfile: servicesBundle, logLevel: 'silent'
})

// 页面 bundle：剥 <script setup>、去 .vue 组件 import、shim uni-app 生命周期与
// 组件宏；锚点行前注入 setActivePinia（每个 require 全新模块实例）
function buildPageBundle(sourcePath, anchor, shims, exportLine, outfile) {
  const body = fs.readFileSync(sourcePath, 'utf8').match(/<script setup>([\s\S]*?)<\/script>/)[1]
  let code = body
    .replace(/^import .* from ['"][^'"\n]+\.vue['"];?$/mg, '')
    .replace(/import\s*\{[^}]*onShow[^}]*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const shows=[];const onShow=fn=>shows.push(fn);')
  code = shims + 'import { createPinia, setActivePinia } from "pinia";\n' + code.replace(anchor, `setActivePinia(createPinia());\n${anchor}`)
  code += '\n' + exportLine
  esbuild.buildSync({ stdin: { contents: code, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile, logLevel: 'silent' })
}
const archivesBundle = path.join(temp, 'archives-page.cjs')
buildPageBundle(
  path.join(root, 'pages/archives/index.vue'),
  'const reportStore = useReportStore()',
  '',
  'export {loadData,retryLoad,loadError,loadErrorHint,loading,dataSource,reportStore,familyStore,shows};\n' +
  'export * from "./services/sessionService.js";export * from "./services/cloudAdapter.js";export * from "./services/familyStore.js";export * from "./services/reportFamilyStore.js";export * from "./services/outbox.js";export * from "./services/fileUploadService.js";export * from "./utils/cloudConfig.js";',
  archivesBundle
)
const uploadBundle = path.join(temp, 'upload-sheet.cjs')
buildPageBundle(
  path.join(root, 'pages/archives/components/UploadSheet.vue'),
  'const reportStore = useReportStore()',
  'const defineProps=()=>({show:false});const defineEmits=()=>((...a)=>true);\n',
  'export {onGallery,onCamera,reportFamilyStore,reportStore};\n' +
  'export * from "./services/sessionService.js";export * from "./services/reportFamilyStore.js";export * from "./services/familyStore.js";export * from "./services/cloudAdapter.js";export * from "./services/outbox.js";export * from "./utils/cloudConfig.js";',
  uploadBundle
)

// 每个 case 全新模块实例（新 pinia/store/内存兜底）——页面与 store 状态不跨 case
function loadClient(bundlePath) {
  delete require.cache[require.resolve(bundlePath)]
  return require(bundlePath)
}

const storage = new Map()
const uniCalls = { toasts: [], chooseImage: 0, saveFile: 0 }
global.uni = {
  getStorageSync(k) { return storage.has(k) ? storage.get(k) : '' },
  setStorageSync(k, v) { storage.set(k, v) },
  removeStorageSync(k) { storage.delete(k) },
  getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
  showToast: v => uniCalls.toasts.push(v && v.title),
  showLoading() {}, hideLoading() {},
  redirectTo() {}, navigateTo() {}, switchTab() {}, reLaunch() {}, navigateBack() {},
  request: () => { throw new Error('unexpected uni.request') },
  chooseImage: o => { uniCalls.chooseImage++; o.success({ tempFilePaths: ['tmp://pick-' + uniCalls.chooseImage + '.png'] }) },
  saveFile: o => {
    uniCalls.saveFile++
    const saved = 'store://saved-' + uniCalls.saveFile
    localFileBytes.set(saved, makePng(uniCalls.saveFile))
    localFileBytes.set(o.tempFilePath, localFileBytes.get(saved)) // 移动语义：临时路径同源
    o.success({ savedFilePath: saved })
  },
  removeSavedFile: o => { o.success && o.success({}) }
}

function makeHold() { let r; const h = { promise: new Promise(res => { r = res }) }; h.release = v => r(v); return h }

// fullStack(bundle, isPage)：真实 handler 路由 + 身份闸门（holdIdentity/releaseIdentity）
// + 可控成员切换（setMember：whoami 返回与 SDK 侧 openid 同步切）
function fullStack(bundle, isPage) {
  for (const k of [...storage.keys()]) {
    if (k.startsWith('mc_outbox_') || k.startsWith('mc_cache_') || k.startsWith('mc_session_') || k.startsWith('mc_draft_') || k.startsWith('mc_pending_') || k === 'mc_session_mode') storage.delete(k)
  }
  uniCalls.toasts.length = 0
  const cloud = makeMockCloud()
  setServerEnv()
  cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID)
  reportsH.__setCloud(cloud); filesH.__setCloud(cloud); healthH.__setCloud(cloud); identityH.__setCloud(cloud)
  const memberOpenid = { mama: TEST_ENV.MC_MEMBER_MAMA_OPENID, papa: TEST_ENV.MC_MEMBER_PAPA_OPENID }
  let member = 'mama'
  const identityPayload = () => ({ ok: true, data: { memberId: member, displayName: member === 'mama' ? '妈妈' : '爸爸', familyId: TEST_ENV.MC_FAMILY_ID } })
  const gate = { d: null }
  const routes = {
    'mc-reports': e => { cloud.__setCtx(memberOpenid[member]); return reportsH.main(e) },
    'mc-files': e => { cloud.__setCtx(memberOpenid[member]); return filesH.main(e) },
    'mc-health': e => { cloud.__setCtx(memberOpenid[member]); return healthH.main(e) },
    'mc-identity': () => (gate.d ? gate.d.promise : identityPayload())
  }
  global.wx = {
    cloud: {
      init() {},
      uploadFile(o) {
        const bytes = localFileBytes.get(o.filePath) || makePng(999)
        cloud.__stored.set(String(o.cloudPath), Buffer.from(bytes))
        o.success({ fileID: `cloud://env-r7.bucket/${o.cloudPath}`, statusCode: 200 })
      }
    }
  }
  bundle.__setCloudConfigForTests('env-r7', 'wxapp-r7')
  bundle.__setWxCloud({
    init() {},
    callFunction(o) {
      const h = routes[o.name]
      if (!h) { o.fail({ errMsg: 'no route' }); return }
      Promise.resolve().then(() => h(o.data)).then(r => o.success({ result: r })).catch(e => o.fail({ errMsg: e.message }))
    },
    uploadFile(o) { global.wx.cloud.uploadFile(o) }
  })
  if (isPage) {
    // 页面 bundle 已在锚点注入 setActivePinia；再取 store 实例
    return {
      cloud, routes, setMember: m => { member = m },
      page: bundle,
      fam: bundle.useFamilyStore(), rfs: bundle.useReportFamilyStore(),
      holdIdentity: () => { gate.d = makeHold() },
      releaseIdentity: () => { const d = gate.d; gate.d = null; d && d.release(identityPayload()) }
    }
  }
  bundle.__resetForTests()
  bundle.setActivePinia(bundle.createPinia())
  return {
    cloud, routes, setMember: m => { member = m }, page: bundle,
    fam: bundle.useFamilyStore(), rfs: bundle.useReportFamilyStore(),
    holdIdentity: () => { gate.d = makeHold() },
    releaseIdentity: () => { const d = gate.d; gate.d = null; d && d.release(identityPayload()) }
  }
}

async function main() {
  console.log('R7 回前台复核竞态回归（同成员复核放行 / 真切换全拦）\n')

  // ══ A 组：原语 ══
  await scenario('H1 isSameSession：epoch 未变即同会话；空快照即异；指纹=familyId/memberId', async () => {
    const { page: api } = fullStack(loadClient(servicesBundle))
    const c = api.captureSession()
    assert.equal(api.isSameSession(c), true)
    assert.equal(api.isSameSession(null), false)
    await api.confirmIdentity()
    assert.equal(api.sessionFingerprint(), `${TEST_ENV.MC_FAMILY_ID}/mama`)
  })

  await scenario('H2 同成员回前台复核推进纪元——仍算同一会话（修复核心语义）', async () => {
    const { page: api } = fullStack(loadClient(servicesBundle))
    await api.confirmIdentity()
    const c = api.captureSession()
    const rc = await api.foregroundRecheck() // 同成员复核：confirmIdentity 纪元 +2
    assert.equal(rc.ok, true)
    assert.ok(api.currentEpoch() > c.epoch, '纪元已推进')
    assert.equal(api.isSameSession(c), true, '同成员复核不算切换')
  })

  await scenario('H3 真换成员/退出/服务端拒绝 → isSameSession 一律为异', async () => {
    const s = fullStack(loadClient(servicesBundle))
    const api = s.page
    await api.confirmIdentity()
    const c = api.captureSession()
    s.setMember('papa')
    await api.confirmIdentity()
    assert.equal(api.isSameSession(c), false, '真换成员')
    const c2 = api.captureSession()
    api.endSession()
    assert.equal(api.isSameSession(c2), false, '退出')
    // 服务端拒绝：锁定后指纹为 null
    const s2 = fullStack(loadClient(servicesBundle))
    await s2.page.confirmIdentity()
    const c3 = s2.page.captureSession()
    s2.routes['mc-identity'] = () => ({ ok: false, code: 'not-family-member' })
    const r = await s2.page.confirmIdentity()
    assert.equal(r.locked, true)
    assert.equal(s2.page.isSameSession(c3), false, '服务端拒绝锁定')
  })

  await scenario('H4 settleConfirm：无在途立即返回不发网络；有在途等确认落定', async () => {
    const s = fullStack(loadClient(servicesBundle))
    const api = s.page
    let identityCalls = 0
    const orig = s.routes['mc-identity']
    s.routes['mc-identity'] = e => { identityCalls++; return orig(e) }
    const v = await api.settleConfirm()
    assert.equal(v, null)
    assert.equal(identityCalls, 0, '无在途不触发确认')
    await api.confirmIdentity()
    s.holdIdentity()
    const rc = api.foregroundRecheck() // 不 await：whoami 挂起
    let settled = false
    const sp = api.settleConfirm().then(() => { settled = true })
    await tick(); await tick()
    assert.equal(settled, false, '确认在途时 settle 等待中')
    s.releaseIdentity()
    await rc; await sp
    assert.equal(settled, true)
  })

  // ══ B 组：上传链路竞态 ══
  await scenario('H5 复现报错②：建批在途撞同成员复核——批次照常建立不再报会话已切换（含清单落盘）', async () => {
    const s = fullStack(loadClient(servicesBundle))
    const api = s.page
    await api.confirmIdentity()
    s.holdIdentity()
    const rc = api.foregroundRecheck() // 选图返回触发的 App.onShow 复核：whoami 挂起
    const res = s.rfs.createBatchFromTempPaths(['tmp://a.png'])
    await tick(); await tick()
    s.releaseIdentity() // whoami 返回同成员 mama
    const r = await res
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.started, true)
    assert.notEqual(r.code, 'stale-session')
    await r.processing
    const b = s.rfs.batch(r.batchId)
    assert.equal(b.status, 'ready')
    assert.equal(b.items[0].state, 'registered')
    // 清单照常落盘（原裸 epoch 比对在同成员复核后必拒写 → manifest-persist-failed）
    const persisted = api.getMemberCache('b2b2-upload-batches')
    assert.ok(persisted && persisted.batches && persisted.batches[r.batchId], '批次清单已写入本成员命名空间')
    await rc
  })

  await scenario('H6 页面层（UploadSheet）：相册选图返回撞同成员复核——无"会话已切换"toast、批次交付', async () => {
    const s = fullStack(loadClient(uploadBundle), true)
    await s.page.confirmIdentity()
    s.holdIdentity()
    const rc = s.page.foregroundRecheck()
    const p = s.page.onGallery() // chooseImage 即时返回 → handleUploadResult → settle 等待
    await tick(); await tick()
    s.releaseIdentity() // 同成员 mama 复核落定
    await p
    const toasts = uniCalls.toasts.filter(t => String(t).includes('会话已切换'))
    assert.deepEqual(toasts, [], '不再出现会话已切换 toast')
    const batches = s.page.reportFamilyStore.activeBatches
    assert.equal(batches.length, 1, '批次已建立')
    assert.ok(s.page.reportStore.pendingUpload && s.page.reportStore.pendingUpload.batchId, 'select 交付 pendingUpload')
    await rc
  })

  await scenario('H7 策略读取撞确认窗口：confirming 标志如实传播，settle 后重取成功（不误报通道未启用）', async () => {
    const s = fullStack(loadClient(servicesBundle))
    const api = s.page
    await api.confirmIdentity()
    s.holdIdentity()
    api.foregroundRecheck() // confirming=true 在途
    const p1 = await s.rfs.refreshUploadPolicy()
    assert.equal(p1.ok, false)
    assert.equal(p1.confirming, true, 'confirming 标志传播：' + JSON.stringify(p1))
    assert.ok(String(p1.reason).includes('确认'), '原因如实：' + p1.reason)
    s.releaseIdentity()
    await api.settleConfirm()
    const p2 = await s.rfs.refreshUploadPolicy()
    assert.equal(p2.ok, true)
    assert.equal(p2.clientUploadEnabled, true)
  })

  await scenario('H8 逐项上传中途同成员复核——条目不回 pending、批次推进到 ready', async () => {
    const s = fullStack(loadClient(servicesBundle))
    const api = s.page
    await api.confirmIdentity()
    await s.rfs.refreshUploadPolicy() // 缓存策略，隔离 policy 环节
    const origFiles = s.routes['mc-files']
    const hold = makeHold()
    s.routes['mc-files'] = async e => { await hold.promise; return origFiles(e) } // prepareUpload 挂起
    const res = s.rfs.createBatchFromTempPaths(['tmp://a.png', 'tmp://b.png'])
    await tick(); await tick()
    const rc = await api.foregroundRecheck() // 挂起期间同成员复核完成（纪元 +2）
    hold.release()
    const r = await res
    assert.equal(r.ok, true, JSON.stringify(r))
    await r.processing
    const b = s.rfs.batch(r.batchId)
    assert.equal(b.status, 'ready', '批次就绪：' + JSON.stringify(b.items.map(i => i.state)))
    assert.ok(b.items.every(i => i.state === 'registered'), '两图全部登记')
  })

  await scenario('H9 建报告途中同成员复核——报告照常创建、批次 done', async () => {
    const s = fullStack(loadClient(servicesBundle))
    const api = s.page
    await api.confirmIdentity()
    const created = await s.rfs.createBatchFromTempPaths(['tmp://a.png'])
    await created.processing
    assert.equal(s.rfs.batch(created.batchId).status, 'ready')
    const origReports = s.routes['mc-reports']
    const hold = makeHold()
    s.routes['mc-reports'] = async e => { await hold.promise; return origReports(e) }
    const pr = s.rfs.createReportFromBatch(created.batchId, { reportType: 'ultrasound', dateKey: '2026-09-22' })
    await tick(); await tick()
    const rc = await api.foregroundRecheck() // 保存挂起期间同成员复核
    hold.release()
    const r = await pr
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(s.rfs.batch(created.batchId).status, 'done')
    const rec = s.fam.reports[created.reportId]
    assert.ok(rec && !rec.deleted && rec.attachments.length === 1, '报告已创建')
  })

  await scenario('H10 真换成员（mama→papa）复核在途建批——仍拦截、批次不落新成员、恢复索引不泄漏', async () => {
    const s = fullStack(loadClient(servicesBundle))
    const api = s.page
    await api.confirmIdentity()
    s.holdIdentity()
    const rc = api.foregroundRecheck()
    const res = s.rfs.createBatchFromTempPaths(['tmp://a.png'])
    await tick(); await tick()
    s.setMember('papa')
    s.releaseIdentity() // whoami 返回 papa：真切换
    const r = await res
    assert.equal(r.ok, false)
    assert.equal(r.code, 'stale-session')
    assert.equal(s.rfs.activeBatches.length, 0, '新成员视图无批次')
    assert.equal(api.getMemberCache('b2b2-upload-batches'), null, '新成员命名空间无清单')
    assert.equal(s.rfs.lastRecovery, null, '恢复索引不泄漏给新成员')
    await rc
  })

  // ══ C 组：档案页同步误报 ══
  await scenario('H11 复现报错①：确认在途时页面拉取——settle 后正常，不再整页"同步失败"', async () => {
    const s = fullStack(loadClient(archivesBundle), true)
    await s.page.confirmIdentity()
    let listCalls = 0
    const origReports = s.routes['mc-reports']
    s.routes['mc-reports'] = e => { if (e.action === 'report.list') listCalls++; return origReports(e) }
    // 复现时序：App.onShow 自动复核在途（whoami 挂起），页面拉取启动
    s.holdIdentity()
    const rc = s.page.foregroundRecheck()
    await tick() // 让复核触发的 watch loadData 先落定，retryLoad 的冷却是确定性的
    const p = s.page.retryLoad() // 冷却重置 → loadData → family 分支 settle 等待在途确认
    await tick(); await tick()
    assert.equal(s.page.loading.value, true, '拉取在等待确认落定（未失败）')
    assert.equal(s.page.loadError.value, '', '等待期间无错误')
    s.releaseIdentity() // 同成员 mama 复核落定
    await p
    assert.equal(s.page.loading.value, false, '加载完成')
    assert.equal(s.page.loadError.value, '', '不再出现同步失败整页错误（当前：' + s.page.loadError.value + '）')
    assert.ok(listCalls >= 1, 'report.list 已发起')
    await rc
  })

  await scenario('H12 拉取真失败——错误副行显示真实原因，不再是写死的"数据库配额"猜测', async () => {
    const s = fullStack(loadClient(archivesBundle), true)
    await s.page.confirmIdentity()
    s.routes['mc-reports'] = () => ({ ok: false, code: 'cloud-call-failed', message: '模拟云端故障' })
    await s.page.retryLoad()
    assert.equal(s.page.loadError.value, '同步失败，请重试')
    assert.equal(s.page.loadErrorHint.value, '模拟云端故障', '真实原因透传')
    assert.notEqual(s.page.loadErrorHint.value, '可能是数据库配额已用完，请稍后重试', '写死的配额猜测已删除')
  })

  await scenario('H13 pullReports 未确认早退——携带 code/message 供页面显示真话', async () => {
    const s = fullStack(loadClient(servicesBundle))
    const r = await s.fam.pullReports()
    assert.equal(r.ok, false)
    assert.equal(r.code, 'unauthenticated-session')
    assert.ok(r.message, '有 message：' + r.message)
  })

  // ══ D 组：familyCall 后置守卫 ══
  await scenario('H14 familyCall：同成员复核后返回的响应被接受；真换成员仍丢弃', async () => {
    const s = fullStack(loadClient(servicesBundle))
    const api = s.page
    await api.confirmIdentity()
    const origHealth = s.routes['mc-health']
    const hold = makeHold()
    s.routes['mc-health'] = async e => { await hold.promise; return origHealth(e) }
    const pr = api.familyCall('mc-health', { action: 'pregnancy.get', schemaVersion: 1, operationId: 'ro-get' })
    await tick()
    await api.foregroundRecheck() // 挂起期间同成员复核完成
    hold.release()
    const r = await pr
    assert.equal(r.ok, true, '同成员复核后的响应仍有效：' + JSON.stringify(r))
    // 真换成员：响应丢弃
    const s2 = fullStack(loadClient(servicesBundle))
    await s2.page.confirmIdentity()
    const hold2 = makeHold()
    const origH2 = s2.routes['mc-health']
    s2.routes['mc-health'] = async e => { await hold2.promise; return origH2(e) }
    const pr2 = s2.page.familyCall('mc-health', { action: 'pregnancy.get', schemaVersion: 1, operationId: 'ro-get' })
    await tick()
    s2.setMember('papa')
    await s2.page.confirmIdentity() // 挂起期间真切换
    hold2.release()
    const r2 = await pr2
    assert.equal(r2.ok, false)
    assert.equal(r2.code, 'stale-session', '真切换响应仍丢弃')
  })

  await scenario('H15 familyCall 前门不变：确认在途仍拒 confirming；身份拒绝仍锁定', async () => {
    const s = fullStack(loadClient(servicesBundle))
    const api = s.page
    await api.confirmIdentity()
    s.holdIdentity()
    api.foregroundRecheck()
    await tick()
    const c = await api.familyCall('mc-health', { action: 'pregnancy.get', schemaVersion: 1, operationId: 'ro-get' })
    assert.equal(c.ok, false)
    assert.equal(c.code, 'confirming', '确认在途前门拒绝保留')
    s.releaseIdentity()
    await api.settleConfirm()
    const r = await api.familyCall('mc-health', { action: 'pregnancy.get', schemaVersion: 1, operationId: 'ro-get' })
    assert.equal(r.ok, true)
  })

  // ══ E 组：恢复 / 重选 ══
  await scenario('H16 恢复上传途中同成员复核——恢复不受影响（清单失败→恢复→就绪）', async () => {
    const s = fullStack(loadClient(servicesBundle))
    const api = s.page
    await api.confirmIdentity()
    // 清单落盘失败（磁盘满）→ 保留恢复索引
    const realSet = global.uni.setStorageSync
    global.uni.setStorageSync = (k, v) => { if (String(k).endsWith('_b2b2-upload-batches')) throw new Error('disk full'); return realSet(k, v) }
    let r0
    try { r0 = await s.rfs.createBatchFromTempPaths(['tmp://a.png']) } finally { global.uni.setStorageSync = realSet }
    assert.equal(r0.ok, false)
    assert.equal(r0.code, 'manifest-persist-failed')
    assert.ok(s.rfs.lastRecovery && s.rfs.lastRecovery.items.length === 1, '恢复索引在')
    // 恢复途中撞同成员复核
    s.holdIdentity()
    const rc = api.foregroundRecheck()
    const pr = s.rfs.recoverFromSavedPaths()
    await tick(); await tick()
    s.releaseIdentity()
    const r = await pr
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.started, true)
    await r.processing
    assert.equal(s.rfs.batch(r.batchId).status, 'ready')
    await rc
  })

  await scenario('H17 重选期间同成员复核——原批次+新原件照常合并（不再误报切换中断）', async () => {
    const s = fullStack(loadClient(servicesBundle))
    const api = s.page
    await api.confirmIdentity()
    await s.rfs.refreshUploadPolicy()
    const created = await s.rfs.createBatchFromTempPaths(['tmp://a.png', 'tmp://b.png'])
    await created.processing
    const b = s.rfs.batch(created.batchId)
    b.items[0].state = 'failed'
    b.status = 'partial'
    // 重选首图：chooseImage 即时返回，saveFile 挂起（复核发生在落盘期间）
    const realSave = global.uni.saveFile
    let release
    global.uni.saveFile = o => {
      global.uni.saveFile = realSave
      release = () => realSave(o)
    }
    const pending = s.rfs.replaceItemSlot(created.batchId, 0)
    await tick(); await tick()
    assert.ok(release, 'saveFile 已挂起')
    await api.foregroundRecheck() // 同成员复核
    release()
    await pending
    // replaceItemSlot 尾部 return processBatch(...)，而 processBatch 约定可返回
    // undefined——以批次最终状态判定（与 restageItem 的消费协议一致）
    const bAfter = s.rfs.batch(created.batchId)
    assert.equal(bAfter.status, 'ready', '批次完成')
    assert.ok(bAfter.items.every(i => i.state === 'registered'), '两页全登记（多页不缩页）')
  })

  await scenario('H18 真换成员重选——仍中止，原批次恢复记录保留完整两页（语义不回退）', async () => {
    const s = fullStack(loadClient(servicesBundle))
    const api = s.page
    await api.confirmIdentity()
    await s.rfs.refreshUploadPolicy()
    const created = await s.rfs.createBatchFromTempPaths(['tmp://a.png', 'tmp://b.png'])
    await created.processing
    const b = s.rfs.batch(created.batchId)
    b.items[0].state = 'failed'
    b.status = 'partial'
    const realSave = global.uni.saveFile
    let release
    global.uni.saveFile = o => {
      global.uni.saveFile = realSave
      release = () => realSave(o)
    }
    const pending = s.rfs.replaceItemSlot(created.batchId, 0)
    await tick(); await tick()
    s.setMember('papa')
    await api.confirmIdentity() // 落盘挂起期间真切换
    release()
    const r = await pending
    assert.equal(r.ok, false)
    assert.equal(r.code, 'stale-session')
    // 切回原成员：恢复记录保留原完整批次（两页）
    s.setMember('mama')
    await api.confirmIdentity()
    await tick(); await tick()
    const rec = s.rfs.lastRecovery || api.getMemberCache('b2b2-recovery')
    assert.ok(rec && rec.batchId === created.batchId, '恢复记录指向原批次')
    assert.equal(rec.items.length, 2, '两页完整保留')
  })

  console.log(`\n${passed} 通过, ${failed.length} 失败`)
  if (failed.length) { console.log('失败场景：' + failed.join(' | ')); process.exit(1) }
}

main().catch(e => { console.error(e); process.exit(1) })
