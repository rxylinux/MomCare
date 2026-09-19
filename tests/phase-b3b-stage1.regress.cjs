// B3b 阶段一永久回归：共享 codec + 微信全量导出与发布 + H5 本地验包 + 页面接线。
// 范围（rev6 设计 §10 阶段一，Codex 已批准）：仅 §2/§3/§4——不含恢复协议 §5。
// 真实页面事件 → 共享 codec → 平台适配器（忠实 typings 文件 API 合约）→ 真实云函数 handler。
// 仅合成数据；不部署/不提交/不读真实数据；模拟通过不冒充真机。
//
// 生产模块路径（单一定位点）：
const PROD = {
  utf8: '@/utils/mcpkg/utf8.js',
  canonical: '@/utils/mcpkg/canonical.js',
  sha256: '@/utils/mcpkg/sha256.js',
  container: '@/utils/mcpkg/container.js',
  adapterWechat: '@/utils/mcpkg/adapter-wechat.js',
  adapterH5: '@/utils/mcpkg/adapter-h5.js',
  exportService: '@/services/mcpkgExportService.js',
  exportPage: 'pages/profile/data-export.vue',
  restorePage: 'pages/profile/data-restore.vue',
}
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-b3b1-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) {
  try { await fn(); pass(name) } catch (e) { fail(name, e) }
}
const tick = () => new Promise(r => setTimeout(r, 20))

// ── 可解码互异 PNG（像素级断言；可带大体积辅助块触发 64KiB 分块）──
function makePng(idx, padBytes = 0) {
  const zlib = require('node:zlib')
  const raw = Buffer.from([0, (idx * 37 + 11) % 256, (idx * 89 + 5) % 256, (idx * 151 + 200) % 256])
  const idat = zlib.deflateSync(raw)
  const crcTable = []
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0 }
  const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
    return Buffer.concat([Buffer.from([0, 0, 0, data.length]), body, crc])
  }
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])), chunk('IDAT', idat)]
  if (padBytes > 0) parts.push(chunk('taIl', Buffer.alloc(padBytes, 0x5a))) // 辅助块（合法 PNG，解码器跳过）
  parts.push(chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(parts)
}
function decodePngPixel(buf) {
  const zlib = require('node:zlib')
  let off = 8, ihdr = null, idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') ihdr = data
    if (type === 'IDAT') idat.push(data)
    off += 12 + len
    if (type === 'IEND') break
  }
  assert.ok(ihdr, 'IHDR 存在')
  const w = ihdr.readUInt32BE(0), h = ihdr.readUInt32BE(4)
  assert.equal(ihdr[8], 8, '8-bit'); assert.equal(ihdr[9], 2, 'RGB')
  const px = zlib.inflateSync(Buffer.concat(idat))
  return { w, h, pixel: [px[1], px[2], px[3]] }
}

// ── 微信 FileSystemManager 忠实 mock（typings：writeFile 17814-17848 / appendFile 16985-17012 /
//    readFile position/length / stat / rename / mkdir(dirPath) / rmdir(dirPath) / unlink）──
// 全部读取记入 readLog（≤64KiB 断言数据源）；磁盘满按写入序号注入。
function makeFSM() {
  const files = new Map()
  const readLog = [], writeLog = []
  const fault = { failWritesFrom: Infinity, counts: { write: 0 }, failStatOnce: false, failReadOnce: false }
  const u8 = d => typeof d === 'string' ? new Uint8Array(Buffer.from(d, 'utf8')) : new Uint8Array(d)
  return () => ({
    writeFile(o) {
      writeLog.push({ op: 'write', path: o.filePath, bytes: u8(o.data).length })
      if (fault.counts.write++ >= fault.failWritesFrom) { o.fail && o.fail({ errMsg: 'writeFile:fail no space' }); return }
      files.set(o.filePath, u8(o.data)); o.success && o.success({})
    },
    appendFile(o) {
      writeLog.push({ op: 'append', path: o.filePath, bytes: u8(o.data).length })
      if (fault.counts.write++ >= fault.failWritesFrom) { o.fail && o.fail({ errMsg: 'appendFile:fail no space' }); return }
      const add = u8(o.data), prev = files.get(o.filePath) || new Uint8Array(0)
      const next = new Uint8Array(prev.length + add.length)
      next.set(prev); next.set(add, prev.length)
      files.set(o.filePath, next); o.success && o.success({})
    },
    readFile(o) {
      const f = files.get(o.filePath)
      if (!f) { o.fail && o.fail({ errMsg: `readFile:fail no such file` }); return }
      if (fault.failReadOnce) { fault.failReadOnce = false; o.fail && o.fail({ errMsg: 'readFile:fail transient' }); return }
      const pos = o.position == null ? 0 : o.position
      const len = o.length == null ? f.length - pos : Math.min(o.length, f.length - pos)
      readLog.push({ path: o.filePath, position: pos, length: len })
      const sw = uniCalls.switchOnRead
      if (sw && !sw.fired && o.filePath === sw.path) {
        sw.fired = true
        Promise.resolve().then(async () => {
          try {
            await sw.switch()
          } catch (e) { /* 切换失败不影响读 */ }
        })
        setTimeout(() => o.success && o.success({ data: f.slice(pos, pos + len).buffer }), 60)
        return
      }
      o.success && o.success({ data: f.slice(pos, pos + len).buffer })
    },
    stat(o) {
      // 瞬时故障优先于存在性判定——真实 fs 在文件缺失时也可能返回瞬时 IO 错误（不可当不存在）
      if (fault.failStatOnce) { fault.failStatOnce = false; o.fail && o.fail({ errMsg: 'stat:fail transient io error' }); return }
      const f = files.get(o.path)
      if (!f) { o.fail && o.fail({ errMsg: 'stat:fail no such file' }); return }
      o.success && o.success({ stats: { size: f.length } })
    },
    rename(o) { const f = files.get(o.oldPath); if (!f) { o.fail && o.fail({ errMsg: 'rename:fail' }); return } files.set(o.newPath, f); files.delete(o.oldPath); o.success && o.success({}) },
    copyFile(o) { const f = files.get(o.srcPath); if (!f) { o.fail && o.fail({ errMsg: 'copyFile:fail' }); return } files.set(o.destPath, f); o.success && o.success({}) },
    mkdir(o) { o.success && o.success({}) },
    rmdir(o) { o.success && o.success({}) },
    unlink(o) {
      const swU = uniCalls.switchOnUnlink
      if (swU && !swU.fired) {
        swU.fired = true
        Promise.resolve().then(async () => { try { await swU.switch() } catch (e) { /* 忽略 */ } })
        setTimeout(() => { files.delete(o.filePath); o.success && o.success({}) }, 60)
        return
      }
      if (fsmFault.failUnlinkSuffix && String(o.filePath).includes(fsmFault.failUnlinkSuffix)) { o.fail && o.fail({ errMsg: 'unlink:fail simulated crash' }); return }
      files.delete(o.filePath); o.success && o.success({})
    },
    access(o) { o.success && o.success({}) },
    __files: files, __readLog: readLog, __writeLog: writeLog, __fault: fault,
  })
}

// ── 云 handler（独立副本，避免与编码方 assemble 竞态共享 dist）──
const DIST = path.join(temp, 'cloud-functions')
for (const fn of ['mc-health', 'mc-schedule', 'mc-reports', 'mc-files', 'mc-identity']) {
  const dir = path.join(DIST, fn); fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(path.join(root, 'cloud/functions', fn, 'index.js'), path.join(dir, 'index.js'))
  fs.cpSync(path.join(root, 'cloud/shared'), path.join(dir, 'shared'), { recursive: true })
}
const healthH = require(path.join(DIST, 'mc-health/index.js'))
const scheduleH = require(path.join(DIST, 'mc-schedule/index.js'))
const reportsH = require(path.join(DIST, 'mc-reports/index.js'))
const filesH = require(path.join(DIST, 'mc-files/index.js'))
const identityH = require(path.join(DIST, 'mc-identity/index.js'))

const TEST_ENV = {
  MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-b3b1',
  MC_MEMBER_MAMA_OPENID: 'oTESTMAMA123456', MC_MEMBER_PAPA_OPENID: 'oTESTPAPA123456'
}
const fileBytesByPath = new Map()
const storage = new Map()
const uniCalls = { toasts: [], shareCalls: [], shareHeld: [], holdShare: false, nextShareResult: 'success', chooseMessageFilePath: null }
let dlSeq = 0
const storageFault = { failSuffix: null, failSuffixes: null, pubWritesAllowed: null } // pubWritesAllowed=N：published 键前 N 次写放行后失败（DG 双故障窗口）
const fsmFault = { failUnlinkSuffix: null } // fsm.unlink 命中后缀时失败且不删除（模拟崩溃后清理不可达）

// uni.downloadFile：真实 API 顺序——临时文件【先】存在（且 FSM 可见），成功回调【后】触发
let harnessCloud = null, fsmFiles = null
function installUni() {
  global.uni = {
    getStorageSync(k) { return storage.has(k) ? storage.get(k) : '' },
    setStorageSync(k, v) {
      const k2 = String(k)
      if (k2.endsWith('mcpkg-export-intent')) {
        let hasDigest = false
        try { hasDigest = Boolean(JSON.parse(v).packageDigest) } catch (e) { /* 记录原始 */ }
        const targetExists = fsmFiles ? [...fsmFiles.keys()].some(fp => /\.mcpkg$/.test(fp)) : false
        storageLog.push({ key: k2, hasDigest, targetExists })
      }
      const hit = (storageFault.failSuffix && k2.endsWith(storageFault.failSuffix)) || (storageFault.failSuffixes && storageFault.failSuffixes.some(x => k2.endsWith(x)))
      if (hit) throw new Error('simulated crash: durable write failed')
      if (storageFault.pubWritesAllowed !== null && k2.endsWith('_b1_mcpkg-published')) {
        if (storageFault.pubWritesAllowed <= 0) throw new Error('simulated crash: durable write failed')
        storageFault.pubWritesAllowed--
      }
      storage.set(k, v)
    },
    removeStorageSync(k) { storage.delete(k) },
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
    showToast: v => uniCalls.toasts.push(v && v.title),
    showModal: o => (o && o.success ? o.success({ confirm: true }) : undefined), // 用户确认删除（自动点确认）
    showLoading() {}, hideLoading() {},
    redirectTo() {}, navigateTo() {}, switchTab() {}, reLaunch() {}, navigateBack() {},
    request: () => {}, uploadFile: () => {},
    saveFile: o => o.success && o.success({ savedFilePath: o.tempFilePath }),
    removeSavedFile: o => (o.success && o.success({})),
    chooseImage: o => o.success({ tempFilePaths: ['tmp://pick.png'] }),
    downloadFile: o => {
      const url = String(o.url || '')
      const fid = url.startsWith('https://t.i/') ? url.slice('https://t.i/'.length) : url
      const key = String(fid).replace(/^cloud:\/\/[^/]+\//, '')
      const bytes = harnessCloud && harnessCloud.__stored.get(key)
      if (!bytes) { o.fail && o.fail({ errMsg: 'downloadFile:fail 404' }); return }
      const p = 'wxfile://tmp-dl-' + (++dlSeq)
      const mode = uniCalls.downloadMode || 'ok'
      const HTML = Buffer.from('<html><head><title>404 Not Found</title></head><body>Error page</body></html>')
      let out = Buffer.from(bytes), code = 200
      if (mode === '404' || mode === '403') { out = HTML; code = Number(mode) }
      else if (mode === 'html200') { out = HTML }
      else if (mode === 'short200') { out = Buffer.from(bytes).subarray(0, Math.max(0, bytes.length - 100)) }
      if (fsmFiles) fsmFiles.set(p, new Uint8Array(out)) // FSM 可见：真实微信下载文件可被 readFile
      fileBytesByPath.set(p, out)
      o.success && o.success({ tempFilePath: p, statusCode: code }) // 成功回调——statusCode/内容由模式决定
    },
  }
}

function makeMockCloud() {
  const docs = new Map(), storedFiles = new Map()
  const state = { caller: TEST_ENV.MC_MEMBER_MAMA_OPENID, initialized: false, calls: [] }
  const clone = x => JSON.parse(JSON.stringify(x))
  function docApi(col, id, tx) {
    return {
      get: async () => { const e = docs.get(`${col}/${id}`); if (tx) tx.reads.set(`${col}/${id}`, e ? e.__v : 0); return { data: e ? { ...clone(e), _id: id } : null } },
      set: async ({ data }) => { if (data && Object.prototype.hasOwnProperty.call(data, '_id')) { const err = new Error('-501007'); err.errMsg = err.message; throw err } if (tx) { tx.writes.set(`${col}/${id}`, clone(data)); return { _id: id } } const prev = docs.get(`${col}/${id}`); docs.set(`${col}/${id}`, { ...clone(data), __v: (prev ? prev.__v : 0) + 1 }); return { _id: id } },
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
    startTransaction: async () => { const tx = { reads: new Map(), writes: new Map() }; return { collection: c => ({ doc: id => docApi(c, id, tx) }), commit: async () => { for (const [k, d] of tx.writes) { const prev = docs.get(k); docs.set(k, { ...d, __v: (prev ? prev.__v : 0) + 1 }) } }, rollback: async () => {} } },
    collection: c => ({ doc: id => docApi(c, id, null), where: f => makeQuery(c, f), get: async () => ({ data: runQuery(c, {}, null, null, 100) }) })
  }
  const cloud = {
    DYNAMIC_CURRENT_ENV: Symbol('env'), init() { state.initialized = true },
    getWXContext() { return { APPID: TEST_ENV.MC_APPID, OPENID: state.caller } },
    database() { if (!state.initialized) throw new Error('init first'); return db },
    downloadFile: async ({ fileID }) => { const k = String(fileID).replace(/^cloud:\/\/[^/]+\//, ''); const b = storedFiles.get(k); if (!b) throw new Error('dl'); return { fileContent: Buffer.from(b) } },
    uploadFile: async ({ cloudPath, fileContent }) => { storedFiles.set(cloudPath, Buffer.from(fileContent)); return { fileID: `cloud://e.b/${cloudPath}` } },
    deleteFile: async ({ fileList }) => ({ fileList: fileList.map(f => ({ fileID: f, status: 0 })) }),
    getTempFileURL: async ({ fileList }) => ({ fileList: fileList.map(f => ({ fileID: f, tempFileURL: 'https://t.i/' + f })) }),
    __docs: docs, __stored: storedFiles, __state: state, __setCtx(o) { state.caller = o }
  }
  return cloud
}

function makeStack(member = 'mama', opts = {}) {
  if (opts.clear !== false) {
    for (const k of [...storage.keys()]) {
      if (k.startsWith('mc_') || k.startsWith('YUNTU_') || k.startsWith('MOMCARE_')) storage.delete(k)
    }
  }
  uniCalls.toasts.length = 0; uniCalls.shareCalls.length = 0; uniCalls.shareHeld.length = 0; uniCalls.switchOnRead = null; uniCalls.switchOnUnlink = null; uniCalls.downloadMode = 'ok'
  storageLog.length = 0
  uniCalls.holdShare = false; uniCalls.nextShareResult = 'success'; uniCalls.chooseMessageFilePath = null
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
    'mc-identity': () => ({ ok: true, data: { memberId: curMember.value, displayName: curMember.value === 'mama' ? '妈妈' : '爸爸', familyId: process.env.MC_FAMILY_ID } })
  }
  const wxCloud = {
    init() {},
    callFunction(o) { cloud.__state.calls.push({ name: o.name, action: o.data?.action, caller: cloud.__state.caller }); const h = routes[o.name]; if (!h) { o.fail({ errMsg: 'no route' }); return } Promise.resolve().then(() => h(o.data)).then(r => o.success({ result: r })).catch(e => o.fail({ errMsg: e.message })) },
    uploadFile(o) { cloud.__stored.set(String(o.cloudPath), Buffer.from(fileBytesByPath.get(o.filePath) || makePng(1))); o.success({ fileID: `cloud://e.b/${o.cloudPath}`, statusCode: 200 }) },
  }
  return { cloud, wxCloud, routes, curMember }
}

// 微信全局（忠实合约）
function installWechatGlobal(stack) {
  const fsm = makeFSM()()
  fsmFiles = fsm.__files
  harnessCloud = stack.cloud
  const shareFileMessage = o => {
    uniCalls.shareCalls.push({ filePath: o.filePath })
    if (uniCalls.holdShare) { uniCalls.shareHeld.push(o); return }
    if (uniCalls.nextShareResult === 'fail') { o.fail && o.fail({ errMsg: 'shareFileMessage:fail cancel' }); return }
    o.success && o.success({ errMsg: 'shareFileMessage:ok' })
  }
  const chooseMessageFile = o => {
    const p = uniCalls.chooseMessageFilePath
    if (!p) { o.fail && o.fail({ errMsg: 'chooseMessageFile:fail cancel' }); return }
    o.success && o.success({ tempFiles: [{ path: p, name: 'backup.mcpkg', size: 0 }] })
  }
  global.wx = { cloud: stack.wxCloud, getFileSystemManager: () => fsm, shareFileMessage, chooseMessageFile, env: { USER_DATA_PATH: 'wxfile://usr' } }
  return fsm
}

// ── bundles ──
function buildBundle(contents, outfile) {
  esbuild.buildSync({ stdin: { contents, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile, logLevel: 'silent' })
}
const serviceBundle = path.join(temp, 'svc.cjs')
buildBundle(`export * from ${JSON.stringify(PROD.exportService)};
export * from ${JSON.stringify(PROD.utf8)};
export * from ${JSON.stringify(PROD.canonical)};
export * from ${JSON.stringify(PROD.sha256)};
export * from ${JSON.stringify(PROD.container)};
export * from ${JSON.stringify(PROD.adapterWechat)};
export * from ${JSON.stringify(PROD.adapterH5)};
export * from "./services/sessionService.js";
export * from "./services/outbox.js";
export * from "./services/cloudAdapter.js";
export * from "./utils/cloudConfig.js";`, serviceBundle)
const codecBundle = path.join(temp, 'codec.cjs')
buildBundle(`export * from ${JSON.stringify(PROD.utf8)};
export * from ${JSON.stringify(PROD.canonical)};
export * from ${JSON.stringify(PROD.sha256)};
export * from ${JSON.stringify(PROD.container)};`, codecBundle)

function buildPageBundle(relPath, piniaAnchor, exportLine, outfile) {
  const body = fs.readFileSync(path.join(root, relPath), 'utf8').match(/<script setup>([\s\S]*?)<\/script>/)[1]
  let code = body
    .replace(/^import .* from ['"][^'"\n]+\.vue['"];?$/mg, '')
    .replace(/import\s*\{[^}]*onLoad[^}]*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const loads=[];const onLoad=fn=>loads.push(fn);')
    .replace(/import\s*\{[^}]*onShow[^}]*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const shows=[];const onShow=fn=>shows.push(fn);')
  code = 'import { createPinia, setActivePinia } from "pinia";\n' + code.replace(piniaAnchor, `setActivePinia(createPinia());\n${piniaAnchor}`)
  code += '\n' + exportLine
  esbuild.buildSync({ stdin: { contents: code, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile, logLevel: 'silent' })
}
const exportPageBundle = path.join(temp, 'export-page.cjs')
buildPageBundle(PROD.exportPage, 'const dataSource = ref(getSessionState().status',
  'export {doExport,doShare,refresh,doRemove,scopeLabel,pendingItems,stateText,building,publishedList,includeShared,includePrivate,dataSource,togglePrivate};export * from "./services/sessionService.js";export * from "./services/mcpkgExportService.js";export * from "./services/outbox.js";export * from "./utils/cloudConfig.js";export * from "./services/cloudAdapter.js";',
  exportPageBundle)
const restorePageBundle = path.join(temp, 'restore-page.cjs')
buildPageBundle(PROD.restorePage, 'const isWechat = computed(',
  'export {isWechat,canPick,result,picking,pickFile,kindText};export * from "./services/sessionService.js";export * from "./utils/mcpkg/container.js";export * from "./utils/cloudConfig.js";export * from "./services/cloudAdapter.js";',
  restorePageBundle)

function loadClient(bundlePath) { delete require.cache[require.resolve(bundlePath)]; return require(bundlePath) }

function wire(client, stack) {
  client.__setCloudConfigForTests('env-b3b1', 'wxapp-b3b1')
  client.__setWxCloud(stack.wxCloud)
  global.wx = Object.assign(global.wx || {}, { cloud: stack.wxCloud })
  client.__resetForTests()
}

// ── 种子：多域 + 三张互异 PNG + 一张 >64KiB PNG（分块）+ 墓碑 + 共享段 + 反序页序 + 多页 daily ──
const PNG_A = makePng(1), PNG_B = makePng(2), PNG_C = makePng(3), PNG_BIG = makePng(4, 200 * 1024)
async function seedFamilyData(stack) {
  const { cloud } = stack
  await healthH.main({ action: 'pregnancy.upsert', schemaVersion: 1, operationId: 'seed-preg-1', expectedRevision: 0, payload: { lmpDate: '2026-06-01', dueDate: '2027-03-08', nickname: '测试妈妈' } })
  const days = [['01', 31], ['02', 28], ['03', 31], ['04', 30]]
  let seq = 0
  for (const [month, n] of days) for (let d = 1; d <= n; d++) {
    seq++
    const r = await healthH.main({ action: 'daily.upsert', schemaVersion: 1, operationId: `seed-daily-${seq}`, expectedRevision: 0, dateKey: `2026-${month}-${String(d).padStart(2, '0')}`, payload: { weightKg: 60 + (seq % 5) } })
    if (!r.ok) throw new Error('seed daily: ' + JSON.stringify(r))
  }
  const bagup = await scheduleH.main({ action: 'bag.upsert', schemaVersion: 1, operationId: 'seed-bag-1', expectedRevision: 0, id: 'bag_seed_1', payload: { name: '婴儿抱被', location: '客厅柜第一层', assignee: 'papa', prepared: true } })
  if (!bagup.ok) throw new Error('seed bag: ' + JSON.stringify(bagup))
  const chk = await scheduleH.main({ action: 'checkup.upsert', schemaVersion: 1, operationId: 'seed-chk-1', expectedRevision: 0, id: 'chk_seed_1', status: 'pending', payload: { dateKey: '2026-05-10', time: '09:30', hospital: '市一医院', companion: '老公', materials: ['产检档案', '医保卡'], questions: ['糖筛前需要空腹吗'] } })
  if (!chk.ok) throw new Error('seed checkup: ' + JSON.stringify(chk))
  const fileIds = []
  for (const [i, png] of [PNG_A, PNG_B, PNG_C, PNG_BIG].entries()) {
    const uploadId = `seedup${i}${Date.now().toString(36)}`
    const up = await filesH.main({ action: 'prepareUpload', schemaVersion: 1, uploadId })
    if (!up.ok) throw new Error('prepare: ' + JSON.stringify(up))
    cloud.__stored.set(up.data.cloudPath, Buffer.from(png))
    const reg = await filesH.main({ action: 'registerStaged', schemaVersion: 1, uploadId, operationId: `seedreg${i}${Date.now().toString(36)}`, stageFileID: `cloud://e.b/${up.data.cloudPath}` })
    if (!reg.ok) throw new Error('register: ' + JSON.stringify(reg))
    fileIds.push(reg.data.file.fileId)
  }
  const r1 = await reportsH.main({ action: 'report.upsert', schemaVersion: 1, operationId: 'seed-rpt-1', expectedRevision: 0, id: 'rpt-three-pages', payload: { reportType: 'other', dateKey: '2026-05-01', attachments: [{ fileId: fileIds[2] }, { fileId: fileIds[0] }, { fileId: fileIds[1] }], note: '三页反序' } })
  if (!r1.ok) throw new Error('rpt1: ' + JSON.stringify(r1))
  const r2 = await reportsH.main({ action: 'report.upsert', schemaVersion: 1, operationId: 'seed-rpt-2', expectedRevision: 0, id: 'rpt-shared', payload: { reportType: 'other', dateKey: '2026-05-02', attachments: [{ fileId: fileIds[1] }], note: '共享段' } })
  if (!r2.ok) throw new Error('rpt2: ' + JSON.stringify(r2))
  const r4 = await reportsH.main({ action: 'report.upsert', schemaVersion: 1, operationId: 'seed-rpt-4', expectedRevision: 0, id: 'rpt-big', payload: { reportType: 'other', dateKey: '2026-05-04', attachments: [{ fileId: fileIds[3] }], note: '大附件分块' } })
  if (!r4.ok) throw new Error('rpt4: ' + JSON.stringify(r4))
  const r3 = await reportsH.main({ action: 'report.upsert', schemaVersion: 1, operationId: 'seed-rpt-3', expectedRevision: 0, id: 'rpt-tomb', payload: { reportType: 'other', dateKey: '2026-05-03', attachments: [{ fileId: fileIds[0] }], note: '将删除' } })
  if (r3.ok) {
    const del = await reportsH.main({ action: 'report.delete', schemaVersion: 1, operationId: 'seed-rpt-3-del', expectedRevision: r3.data.record.revision, id: 'rpt-tomb' })
    if (!del.ok) throw new Error('tomb: ' + JSON.stringify(del))
  }
  return { fileIds }
}

function memberCacheKeyPattern(suffix) {
  return [...storage.keys()].find(k => k.endsWith(suffix))
}

const storageLog = [] // 意图键写入记录：{ hasDigest, targetExists }
const unhandledSeen = []
process.on('unhandledRejection', e => { unhandledSeen.push(e) })

async function main() {
  console.log('B3b 阶段一回归（codec+微信导出发布+H5 本地验包+页面接线）\n')
  installUni()
  const codec = loadClient(codecBundle)

  // ══ A. 增量 SHA-256 ══
  await scenario('A1 NIST 向量（空/abc/56 字节跨块/千字节）', async () => {
    const vectors = [['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
      ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
      ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
      ['a'.repeat(1000), '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3']]
    for (const [input, expect] of vectors) {
      const bytes = new Uint8Array(Buffer.from(input, 'utf8'))
      const h = codec.createHash()
      for (let i = 0; i < bytes.length; i += 65536) h.update(bytes.subarray(i, i + 65536))
      assert.equal(h.digest(), expect, `NIST len=${input.length}`)
    }
  })
  await scenario('A2 64KiB 边界±1 增量切分==整输入', async () => {
    const buf = new Uint8Array(65536 * 2 + 7)
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 31 + 7) % 256
    const whole = codec.createHash(); whole.update(buf); const w = whole.digest()
    for (const split of [65535, 65536, 65537, 131072, 1, buf.length - 1]) {
      const h = codec.createHash(); h.update(buf.subarray(0, split)); h.update(buf.subarray(split))
      assert.equal(h.digest(), w, `split@${split}`)
    }
  })
  await scenario('A3 update 仅收 Uint8Array（string 入参类型层拒绝）', async () => {
    let rejected = false
    try { codec.createHash().update('abc') } catch (e) { rejected = true }
    assert.ok(rejected, 'string 入参必须抛错')
  })
  await scenario('A4 纯 JS 增量实现与 Node crypto 参照逐字节一致（含中文/emoji/70KB）', async () => {
    for (const s of ['', 'x', '中文🌍测试', 'a'.repeat(70000)]) {
      const b = Buffer.from(s, 'utf8')
      const h = codec.createHash()
      for (let i = 0; i < b.length; i += 65536) h.update(new Uint8Array(b.subarray(i, i + 65536)))
      assert.equal(h.digest(), crypto.createHash('sha256').update(b).digest('hex'), `len=${s.length}`)
    }
  })

  // ══ B. canonical JSON + 严格 UTF-8（两层）══
  await scenario('B1 canonicalJsonString 确定性（键字典序/无空白/ECMAScript ToString/JSON.stringify 字符串语义）', async () => {
    const c = codec.canonicalJsonString
    assert.equal(c({ b: 1, a: 2 }), '{"a":2,"b":1}', '键字典序')
    assert.equal(c({ x: 0.1, y: 1e21, z: -0 }), '{"x":0.1,"y":1e+21,"z":0}', '数字格式')
    assert.equal(c({ s: 'a"b\\c\nd' }), JSON.stringify({ s: 'a"b\\c\nd' }), '字符串语义')
    assert.equal(c({ n: { d: 1, c: 2 }, m: [3, { z: 1, y: 2 }] }), '{"m":[3,{"y":2,"z":1}],"n":{"c":2,"d":1}}', '嵌套递归')
  })
  await scenario('B2 canonicalJson 严格拒绝 schema 外值：对象/数组/嵌套 undefined、数组空洞、NaN/Infinity、循环引用（rev6：undefined 属 schema 外，写出前拒绝——不得 skip/null）', async () => {
    const c = codec.canonicalJsonString
    const rejects = v => { try { c(v); return false } catch (e) { return e.code === 'canonical-invalid' } }
    const holey = [1]; holey[3] = 2 // 索引 1/2 为空洞（hole 即 undefined）
    for (const [n, v] of [
      ['对象 undefined', { a: undefined }],
      ['数组 undefined', [undefined]],
      ['数组空洞', holey],
      ['嵌套对象 undefined', { x: { y: undefined } }],
      ['嵌套数组 undefined', { x: [1, undefined] }],
      ['NaN', { a: NaN }],
      ['Infinity', { a: Infinity }],
    ]) {
      assert.ok(rejects(v), `${n} 必须抛 canonical-invalid（skip/null 语义即缺陷——设计 §2.4 canonicalJson 排除非 schema 值）`)
    }
    const cyc = { a: 1 }; cyc.self = cyc
    assert.ok(rejects(cyc), '循环引用抛 canonical-invalid')
  })
  await scenario('B2b 孤立代理嵌套键/值：序列化前拒绝（值递归已知；键同为序列化内容必须覆盖）', async () => {
    const deep = codec.assertNoLoneSurrogatesDeep
    for (const v of [{ a: { b: ['\uD800'] } }, { a: [{ c: 'x\ud83d' }] }, { a: { b: { c: '\uDC00' } } }]) {
      let err = null
      try { deep(v) } catch (e) { err = e }
      assert.ok(err && err.code === 'malformed-surrogate', '嵌套值中的孤立代理必须拒绝')
    }
    for (const v of [{ '\uD800': 1 }, { a: { '\udc00x': 'ok' } }, { arr: [{ '\ud83d': 2 }] }]) {
      let err = null
      try { deep(v) } catch (e) { err = e }
      assert.ok(err, '孤立代理【键】必须拒绝（对象键也是序列化内容——utils/mcpkg/utf8.js assertNoLoneSurrogatesDeep 只遍历值不遍历键）')
    }
    // 端到端反证：canonicalJsonBytes 产出经 JSON.parse 还原后，深检必须抛（值与键两路）
    for (const v of [{ a: '\uD800' }, { '\uD800': 1 }]) {
      let bytes = null
      try { bytes = codec.canonicalJsonBytes(v) } catch (e) { continue } // 抛错即达标
      let err = null
      try { deep(JSON.parse(Buffer.from(bytes).toString('utf8'))) } catch (e) { err = e }
      assert.ok(err, '序列化字节解析还原后孤立代理（键或值）必须被深检捕获——否则该代理经转义文本静默入包')
    }
  })
  await scenario('B3 encodeStrict 拒绝孤立代理：抛 McPkgTextError code=malformed-surrogate（非任意异常），输入不变', async () => {
    const cases = ['\uD800', '\uDC00', '好\uD800', '\uD800好', 'a\uD800', '\uD83D\uDE00\uDC00', 'x\ud83d', 'x\udc00y']
    for (const s of cases) {
      const before = String(s)
      let err = null
      try { codec.encodeStrict(s) } catch (e) { err = e }
      assert.ok(err, `必须抛错（码元 ${Array.from(s, ch => ch.charCodeAt(0).toString(16)).join(',')}）`)
      assert.equal(err.code, 'malformed-surrogate', `错误码必须是 malformed-surrogate，实得 ${err.code}`)
      assert.equal(s, before, '原输入不被改动')
    }
  })
  await scenario('B4 encodeStrict 直返 Uint8Array：合法对/中文字节精确', async () => {
    const r1 = codec.encodeStrict('\uD83D\uDE00')
    assert.ok(r1 instanceof Uint8Array, '直返 Uint8Array（非 {bytes} 包装）')
    assert.deepEqual(Buffer.from(r1).toString('hex'), 'f09f9880', 'U+1F600 → F0 9F 98 80')
    assert.deepEqual(Buffer.from(codec.encodeStrict('中文')).toString('hex'), 'e4b8ade69687', 'CJK')
  })
  await scenario('B5 解析后递归检查 assertNoLoneSurrogatesDeep：JSON 转义 \\ud800（字节合法）同样拒绝', async () => {
    const parsed = JSON.parse('{"note":"\\ud800","n":1}')
    assert.equal(parsed.note.charCodeAt(0), 0xD800, '前置：解析产物含孤立代理')
    let err = null
    try { codec.assertNoLoneSurrogatesDeep(parsed) } catch (e) { err = e }
    assert.ok(err, '必须抛错')
    assert.equal(err.code, 'malformed-surrogate', `错误码 ${err.code}`)
    let ok2 = true
    try { codec.assertNoLoneSurrogatesDeep(JSON.parse('{"ok":"中文🌍","arr":["x",2]}')) } catch (e) { ok2 = false }
    assert.ok(ok2, '干净对象（含数组/中文）通过')
  })
  await scenario('B6 decodeStrict 拒绝非法字节（code=malformed-utf8：ED A0 80/C0 80/截断/孤立续字节）', async () => {
    for (const hex of ['eda080', 'c080', 'e4b8', 'f09f98', '80']) {
      let err = null
      try { codec.decodeStrict(new Uint8Array(Buffer.from(hex, 'hex'))) } catch (e) { err = e }
      assert.ok(err, `${hex} 必须抛错`)
      assert.equal(err.code, 'malformed-utf8', `${hex} 错误码 ${err.code}`)
    }
  })

  // ══ C. 导出全链（真实 handler→FSM→发布）══
  const C = {}
  async function freshExport(member = 'mama', seed = true) {
    const stack = makeStack(member)
    const fsm = installWechatGlobal(stack)
    const client = loadClient(serviceBundle)
    wire(client, stack)
    const seeded = seed ? await seedFamilyData(stack) : null
    return { stack, fsm, client, seeded }
  }
  await scenario('C1 全链 happy path：多域分页+附件真字节+发布+目标复验+清单深度断言', async () => {
    const { stack, fsm, client, seeded } = await freshExport()
    await client.confirmIdentity()
    const downloadsBefore = dlSeq
    const r = await client.buildAndPublishPackage({ includeShared: true, includePrivateOf: null })
    assert.ok(r.ok, `发布成功: ${JSON.stringify({ code: r.code, message: r.message, problems: r.problems })}`)
    assert.equal(r.complete, true, `complete=true（所选范围来源完整）——problems=${JSON.stringify(r.problems)}`)
    assert.equal(r.packageKind, 'full', 'packageKind=full')
    // published 标志（作用域+审计 epoch）
    const flag = r.flag
    assert.ok(flag.packageDigest && flag.path.endsWith('.mcpkg'), '标志含 packageDigest/path')
    assert.equal(flag.memberId, 'mama'); assert.equal(flag.familyId, TEST_ENV.MC_FAMILY_ID)
    assert.ok(Number.isInteger(flag.epochAtPublish), 'epochAtPublish 审计元数据')
    // 目标文件整包复验（真实 FSM 分块读）
    const vr = await client.validatePackage(client.wechatFileReader(flag.path))
    assert.ok(vr.ok, `目标复验: ${JSON.stringify(vr.problems)}`)
    assert.equal(vr.derivedTotal, vr.actualSize, '推导总长==实际 EOF（无 totalSizeBytes 自指）')
    const m = vr.manifest
    assert.equal(m.domains.daily.status, 'present'); assert.equal(m.domains.daily.recordCount, 120, 'daily 120 条（真实多页）')
    assert.ok(m.domains.daily.pagingComplete, '分页完成')
    assert.equal(m.domains.pregnancy.recordCount, 1)
    assert.equal(m.domains.mood.status, 'omitted', '未选私人域=omitted（不算不完整）')
    assert.ok(!JSON.stringify(m).includes('incompleteReasons'), '完整包无 incompleteReasons')
    // 反序页序：rpt-three-pages 三页 originalFileId 顺序 [2,0,1]
    const r3m = m.reports.find(x => x.reportId === 'rpt-three-pages')
    assert.deepEqual(r3m.attachments.map(a => a.originalFileId), [seeded.fileIds[2], seeded.fileIds[0], seeded.fileIds[1]], '页序与声明一致（不按 sha/文件名排序）')
    // 共享段：fileIds[1] 被 rpt-three-pages 与 rpt-shared 共同引用
    const sharedFile = m.files.find(f => f.originalFileId === seeded.fileIds[1])
    assert.ok(sharedFile && sharedFile.referencedBy.includes('rpt-three-pages') && sharedFile.referencedBy.includes('rpt-shared'), '共享段双引用')
    // 墓碑：deleted 且零原件下载
    const tomb = m.reports.find(x => x.reportId === 'rpt-tomb')
    assert.ok(tomb && tomb.deleted === true, `墓碑保留 deleted——实际 reports 映射: ${JSON.stringify(m.reports.map(x => ({ id: x.reportId, deleted: x.deleted, att: x.attachments.length })))}`)
    assert.deepEqual(tomb.attachments, [], '墓碑附件映射为空')
    assert.equal(dlSeq - downloadsBefore, 4, `恰 4 次附件下载（三 PNG+大图；墓碑零下载）: ${dlSeq - downloadsBefore}`)
    // 大附件分块承诺
    const bigFile = m.files.find(f => f.originalFileId === seeded.fileIds[3])
    assert.ok(bigFile && bigFile.length === PNG_BIG.length, `大附件长度 ${bigFile && bigFile.length}`)
    assert.equal(bigFile.chunkSha256.length, Math.ceil(PNG_BIG.length / (256 * 1024)), 'chunkSha256 块数=ceil(len/256KiB)')
    // 三张互异 PNG 从目标文件按偏移读出并像素级解码比对
    const reader = client.wechatFileReader(flag.path)
    const head = await reader.readChunk(0, 24)
    const hv = new DataView(head.buffer, head.byteOffset, 24)
    assert.equal(hv.getUint32(16), 0, 'manifestLen 高 32 位为 0（安全整数）')
    const manifestLen = hv.getUint32(20)
    let cursor = 24 + manifestLen
    const wantPixels = { [seeded.fileIds[0]]: decodePngPixel(PNG_A).pixel, [seeded.fileIds[1]]: decodePngPixel(PNG_B).pixel, [seeded.fileIds[2]]: decodePngPixel(PNG_C).pixel }
    let decodedCount = 0
    for (let i = 0; i < m.files.length; i++) {
      const lp = await reader.readChunk(cursor, 8)
      const lv = new DataView(lp.buffer, lp.byteOffset, 8)
      assert.equal(lv.getUint32(0), 0, 'entryLen 高 32 位为 0')
      const entryLen = lv.getUint32(4)
      cursor += 8
      const f = m.files[i]
      if (f.kind === 'attachment' && wantPixels[f.originalFileId]) {
        const bytes = await reader.readChunk(cursor, entryLen)
        const px = decodePngPixel(Buffer.from(bytes))
        assert.deepEqual(px.pixel, wantPixels[f.originalFileId], `附件 ${f.originalFileId} 像素级=原图`)
        decodedCount++
      }
      cursor += entryLen
    }
    assert.equal(decodedCount, 3, '三张互异 PNG 全部解码比对')
    assert.equal(cursor, vr.actualSize, '段偏移遍历终点==EOF')
  })
  await scenario('C2 分块 I/O 契约：全部 readFile ≤64KiB（含 >64KiB 附件与 C4 复验），且实际出现 64KiB 整块', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    const fsm = { __readLog: global.wx.getFileSystemManager().__readLog }
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok, `发布成功: ${r.code}`)
    const reads = global.wx.getFileSystemManager().__readLog
    assert.ok(reads.length > 0, '读取日志非空')
    const over = reads.filter(x => x.length > 65536)
    assert.equal(over.length, 0, `存在超 64KiB 单次读: ${JSON.stringify(over.slice(0, 3))}`)
    assert.ok(reads.some(x => x.length === 65536), '大附件触发 64KiB 整块分块读')
    void fsm
  })
  await scenario('C3a 发布前二次检查：pending 清单变化 → 阻断发布（pending-changed）+ 清理临时', async () => {
    const { stack, client } = await freshExport()
    await client.confirmIdentity()
    let injected = false
    const r = await client.buildAndPublishPackage({ onProgress: p => {
      if (p.stage === 'manifest-built' && !injected) {
        injected = true
        storage.set('mc_cache_env-b3b1_wxapp-b3b1_mama_b1_b3-migration', JSON.stringify({ batchId: 'bogus-mig', status: 'confirmed' }))
      }
    } })
    assert.ok(!r.ok, '必须被阻断')
    assert.equal(r.code, 'pending-changed', `阻断码 ${r.code}`)
    const leftovers = [...global.wx.getFileSystemManager().__files.keys()].filter(p => p.includes('.partial') || p.includes('/tmp/'))
    assert.equal(leftovers.length, 0, `临时产物清理: ${JSON.stringify(leftovers)}`)
    void stack
  })
  await scenario('C3b 发布前插入"已消费游标之前"的新记录 → 不得以旧快照宣称完整（确定性：在 C2 二次扫描路由内 await 持久化）', async () => {
    const { stack, client } = await freshExport()
    await client.confirmIdentity()
    // 确定性注入：publish-check 阶段武装；二次扫描发出的首个 daily.list 在响应前 await 完成插入
    let armed = false, inserted = false
    const realHealth = stack.routes['mc-health']
    stack.routes['mc-health'] = async e => {
      if (armed && !inserted && e.action === 'daily.list') {
        inserted = true
        const ins = await healthH.main({ action: 'daily.upsert', schemaVersion: 1, operationId: 'insert-ahead', expectedRevision: 0, dateKey: '2026-06-30', payload: { weightKg: 99 } })
        if (!ins.ok) throw new Error('insert-ahead failed: ' + JSON.stringify(ins))
      }
      return realHealth(e)
    }
    const r = await client.buildAndPublishPackage({ onProgress: p => { if (p.stage === 'publish-check') armed = true } })
    console.log(`      [C3b 实际行为] ok=${r.ok} complete=${r.complete} kind=${r.packageKind} code=${r.code || '-'} problems=${JSON.stringify(r.problems || []).slice(0, 200)}`)
    const staleComplete = r.ok && r.complete === true
    assert.ok(!staleComplete, `构建期间源新增记录不得仍宣称完整包（ok=${r.ok} complete=${r.complete} code=${r.code}）——设计 §2.5 C2/§3.2 要求阻断重建或降级诊断（services/mcpkgExportService.js 发布前二次检查段落）`)
  })
  await scenario('C4 磁盘满（组装中）→ 如实失败、输入保留、临时产物清理', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    const fault = global.wx.getFileSystemManager().__fault
    let failed = false
    const baseWrites = fault.counts.write
    let r
    try {
      r = await client.buildAndPublishPackage({ onProgress: p => { if (p.stage === 'assembling' && !failed) { failed = true; fault.failWritesFrom = baseWrites + 3 } } })
    } catch (e) {
      r = { ok: false, code: 'thrown:' + (e.code || e.message) }
    }
    assert.ok(!r.ok, `必须失败: ${JSON.stringify({ code: r.code })}`)
    const leftovers = [...global.wx.getFileSystemManager().__files.keys()].filter(p => p.includes('.partial') || p.includes('/tmp/'))
    assert.equal(leftovers.length, 0, `磁盘满后临时产物须清理: ${JSON.stringify(leftovers)}（services/mcpkgExportService.js Stage C 无 try/catch——cleanupTemp 不达）`)
  })
  await scenario('C5a C3 后/C5 前真崩溃：目标孤儿在盘+标志未写+清理不可达 → 冷启动复验续作；无信意图孤儿不自动认领（设计 §2.5）', async () => {
    // ── 夹具：标志 durable 写抛错（C5 前死亡）+ 目标 unlink 同败（清理不可达）──
    const { stack, client } = await freshExport()
    await client.confirmIdentity()
    storageFault.failSuffix = '_b1_mcpkg-published'
    fsmFault.failUnlinkSuffix = '.mcpkg'
    let r
    try { r = await client.buildAndPublishPackage({}) } catch (e) { r = { ok: false, code: 'crashed:' + (e.code || e.message) } }
    storageFault.failSuffix = null; fsmFault.failUnlinkSuffix = null
    assert.ok(!r.ok, `前置：C5 前中断（实得 ${r.code}）`)
    const fsmNow = global.wx.getFileSystemManager()
    const targetPath = [...fsmNow.__files.keys()].find(p2 => /\.mcpkg$/.test(p2))
    assert.ok(targetPath, '前置：C3/C4 后目标文件在盘（孤儿）')
    const pubKey = [...storage.keys()].find(k => k.endsWith('mcpkg-published'))
    assert.ok(!pubKey || !Object.keys(JSON.parse(storage.get(pubKey) || '{}')).length, '前置：published 标志未落')
    const orphanBytes = new Uint8Array(fsmNow.__files.get(targetPath))
    // ── 冷启动：重建 JS 会话（同存储+同 FSM 文件）→ 复验续作 ──
    const stack2 = makeStack('mama', { clear: false })
    installWechatGlobal(stack2)
    global.wx.getFileSystemManager().__files.set(targetPath, orphanBytes)
    const client2 = loadClient(serviceBundle)
    wire(client2, stack2)
    await client2.confirmIdentity()
    // 确定性恢复：单次 await 公开恢复 API（listPublished 内为 void 异步发射——多次触发存在并发覆写竞态，见报告）
    let rec = null, recErr = null
    try { rec = await client2.recoverInterruptedExport() } catch (e) { recErr = e }
    assert.ok(rec && rec.batchId && rec.packageDigest, `recoverInterruptedExport 应补落标志恢复（实得 ${recErr ? '抛错:' + (recErr.code || recErr.message) : JSON.stringify(rec)}）——services/mcpkgExportService.js`)
    const listed = client2.listPublished()
    assert.ok(listed.length >= 1, `恢复后列表可见（list=${listed.length}）`)
    if (listed.length >= 1) {
      const share = await client2.sharePublishedPackage(listed[0].batchId)
      assert.ok(share.ok, `恢复后可分享: ${share.code}`)
    }
    // ── 对照：无信意图的孤儿目标不得被自动认领 ──
    const stack3 = makeStack('mama', { clear: true }) // 全新存储——无标志、无意图，仅文件在盘
    installWechatGlobal(stack3)
    global.wx.getFileSystemManager().__files.set('wxfile://usr/MomCareExport/orphan.mcpkg', orphanBytes)
    const client3 = loadClient(serviceBundle)
    wire(client3, stack3)
    await client3.confirmIdentity()
    assert.equal(client3.listPublished().length, 0, '无信意图的孤儿文件不得被自动认领为已发布')
    const s3 = await client3.sharePublishedPackage('exp_orphan')
    assert.ok(!s3.ok && s3.code === 'no-published', `孤儿 batchId 分享拒绝: ${s3.code}`)
    // ── 意图在而目标包损坏：恢复不得未处理拒绝（进程存活），孤儿按不可信清理 ──
    const stack4 = makeStack('mama', { clear: false })
    installWechatGlobal(stack4)
    const badBytes = new Uint8Array(orphanBytes); badBytes[badBytes.length - 1] ^= 0xff
    global.wx.getFileSystemManager().__files.set(targetPath, badBytes) // 同路径放入被篡改的目标
    const client4 = loadClient(serviceBundle)
    wire(client4, stack4)
    await client4.confirmIdentity()
    let rec4 = 'unset', recErr4 = null
    try { rec4 = await client4.recoverInterruptedExport() } catch (e) { recErr4 = e }
    assert.ok(!recErr4, `目标损坏时恢复不得抛未处理异常（实得 ${(recErr4 && (recErr4.code || recErr4.message)) || '无'}）——恢复内 validatePackage 未守卫则任何 ContainerError 击穿进程`)
    assert.ok(rec4 === null || rec4 === undefined, `损坏目标不可认领（实得 ${JSON.stringify(rec4 && rec4.batchId)}）`)
    client4.listPublished() // void 挂接路径同样触发——此处不应产生未处理拒绝（后续场景存活即为证）
    await tick(); await tick()
    void stack
  })
  await scenario('C5e E2E 崩溃恢复：冷启动打开导出页（不直调恢复）→验证前无 published 临时条目→最终已验证列表→页面分享成功', async () => {
    // 崩溃夹具（同 C5a）：C5 标志写失败+清理 unlink 失败 → 目标孤儿+意图存续
    const { client } = await freshExport()
    await client.confirmIdentity()
    storageFault.failSuffix = '_b1_mcpkg-published'
    fsmFault.failUnlinkSuffix = '.mcpkg'
    let r
    try { r = await client.buildAndPublishPackage({}) } catch (e) { r = { ok: false, code: 'crashed' } }
    storageFault.failSuffix = null; fsmFault.failUnlinkSuffix = null
    assert.ok(!r.ok, `前置：C5 前中断（${r.code}）`)
    const fsm0 = global.wx.getFileSystemManager()
    const targetPath = [...fsm0.__files.keys()].find(p2 => /\.mcpkg$/.test(p2))
    assert.ok(targetPath, '前置：目标在盘')
    const bytes = new Uint8Array(fsm0.__files.get(targetPath))
    const intentKey = [...storage.keys()].find(k => k.endsWith('mcpkg-export-intent'))
    assert.ok(intentKey, '前置：导出意图存续')
    // 冷启动 + 打开真实导出页（refresh→listPublished→void 恢复——不直调 API）
    const stack2 = makeStack('mama', { clear: false })
    installWechatGlobal(stack2)
    global.wx.getFileSystemManager().__files.set(targetPath, bytes)
    const page = loadClient(exportPageBundle)
    wire(page, stack2)
    await page.confirmIdentity()
    // 验证前：不得出现标记为 published 的临时条目（恢复是异步的——首采样应为空）
    const first = page.publishedList.value
    assert.ok(!first.some(f => f.batchId && /pending|provisional|recover/i.test(JSON.stringify(f))), `验证前不得有临时 published 条目（首采样=${JSON.stringify(first.map(f => ({ id: f.batchId, pending: f.recoveredPending })))}）`)
    // 最终：已验证条目出现（含 packageDigest）
    let entry = null
    for (let i = 0; i < 120 && !entry; i++) {
      entry = page.publishedList.value.find(f => f.packageDigest)
      if (!entry) await tick()
    }
    assert.ok(entry, `恢复完成后应出现已验证条目（120×20ms 后 list=${page.publishedList.value.length}）`)
    // 页面分享路径成功
    const shareCalls0 = uniCalls.shareCalls.length
    await page.doShare(entry.batchId)
    for (let i = 0; i < 50 && uniCalls.shareCalls.length === shareCalls0; i++) await tick()
    assert.ok(uniCalls.shareCalls.length > shareCalls0, '页面分享已发起 shareFileMessage')
    const pubKey = [...storage.keys()].find(k => k.endsWith('mcpkg-published'))
    const st = JSON.parse(storage.get(pubKey) || '{}')
    assert.ok(st[entry.batchId] && st[entry.batchId].deliveredAt, `页面分享须交付并记录 deliveredAt（store=${JSON.stringify(Object.keys(st))}）——recoveredPending 条目若不在 PUBLISHED_KEY 或 share 查不到则 no-published（review 指出点）`)
  })
  await scenario('C5f 页面路径：目标损坏/消失 → 无未处理拒绝、列表保持为空、进程存活', async () => {
    for (const variant of ['corrupt', 'gone']) {
      const { client } = await freshExport()
      await client.confirmIdentity()
      storageFault.failSuffix = '_b1_mcpkg-published'
      fsmFault.failUnlinkSuffix = '.mcpkg'
      let r
      try { r = await client.buildAndPublishPackage({}) } catch (e) { r = { ok: false } }
      storageFault.failSuffix = null; fsmFault.failUnlinkSuffix = null
      assert.ok(!r.ok, '前置：C5 前中断')
      const fsm0 = global.wx.getFileSystemManager()
      const targetPath = [...fsm0.__files.keys()].find(p2 => /\.mcpkg$/.test(p2))
      assert.ok(targetPath, '前置：目标在盘')
      let bytes = new Uint8Array(fsm0.__files.get(targetPath))
      if (variant === 'corrupt') bytes[bytes.length - 1] ^= 0xff
      const before = unhandledSeen.length
      const stack2 = makeStack('mama', { clear: false })
      installWechatGlobal(stack2)
      if (variant === 'corrupt') global.wx.getFileSystemManager().__files.set(targetPath, bytes)
      // variant 'gone'：不放目标——模拟崩溃后目标消失
      const page = loadClient(exportPageBundle)
      wire(page, stack2)
      await page.confirmIdentity()
      for (let i = 0; i < 60; i++) { page.refresh?.(); await tick() } // 反复触发 void 恢复路径
      await tick(); await tick()
      assert.equal(unhandledSeen.length, before, `[${variant}] 页面刷新触发的恢复不得产生未处理拒绝（新增 ${unhandledSeen.length - before} 个）`)
      assert.equal(page.publishedList.value.filter(f => f.packageDigest).length, 0, `[${variant}] 损坏/消失目标不得成为已验证条目`)
    }
  })

  await scenario('D1 初始意图写须含预期摘要（早于 C3）；C5 标志+后续意图写双失败 → 冷启动保留目标并恢复', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    let armed = false
    const r0 = await client.buildAndPublishPackage({ onProgress: p => {
      if (p.stage === 'verified' && !armed) {
        armed = true
        storageFault.failSuffixes = ['_b1_mcpkg-published', '_b1_mcpkg-export-intent']
        fsmFault.failUnlinkSuffix = '.mcpkg'
      }
    } })
    storageFault.failSuffixes = null; fsmFault.failUnlinkSuffix = null
    assert.ok(!r0.ok, `前置：发布中断（${r0.code}）`)
    // ① 契约（修正版）：首次【作用域】意图在副作用前持久（无摘要是正确的——收集前无法知道）；
    //    随后须有第二次【摘要富集】意图写：含 packageDigest 且仍早于 C3 目标写出
    const intentWrites = storageLog.filter(e => e.key.endsWith('mama_b1_mcpkg-export-intent'))
    assert.ok(intentWrites.length >= 1, '前置：捕获到意图写入')
    const first = intentWrites[0]
    assert.ok(!first.targetExists, '首次作用域意图须在副作用（含 C3）前持久')
    const enriched = intentWrites.slice(1).find(e => e.hasDigest && !e.targetExists)
    assert.ok(enriched, `须存在初始意图【之后】、C3 之前的摘要富集写（含 packageDigest 且 targetExists=false）——实得写入序列 ${JSON.stringify(intentWrites.map(e => ({ hasDigest: e.hasDigest, targetExists: e.targetExists })))}（services/mcpkgExportService.js 意图持久化时序）`)
    const fsm0 = global.wx.getFileSystemManager()
    const targetPath = [...fsm0.__files.keys()].find(p2 => /\.mcpkg$/.test(p2))
    assert.ok(targetPath, '前置：C3/C4 已验目标在盘')
    const goodBytes = new Uint8Array(fsm0.__files.get(targetPath))
    // ② 冷启动：目标字节保留 + 恢复成功（不依赖第二次意图写）
    const stack2 = makeStack('mama', { clear: false })
    installWechatGlobal(stack2)
    global.wx.getFileSystemManager().__files.set(targetPath, goodBytes)
    const client2 = loadClient(serviceBundle)
    wire(client2, stack2)
    await client2.confirmIdentity()
    let rec = null, recErr = null
    try { rec = await client2.recoverInterruptedExport() } catch (e) { recErr = e }
    const after = global.wx.getFileSystemManager().__files.get(targetPath)
    assert.ok(after && Buffer.from(after).equals(Buffer.from(goodBytes)), `恢复不得删除 C4 已验证的唯一目标（实得 ${after ? '字节已变' : '文件被删'}）`)
    assert.ok(!recErr, `不得抛未处理异常（${recErr && (recErr.code || recErr.message)}）`)
    const listed = client2.listPublished().filter(f => f.packageDigest)
    assert.ok(listed.length >= 1 && (!rec || rec.batchId), `冷启动应恢复（list=${listed.length}；rec=${JSON.stringify(rec && rec.batchId)}）——初始摘要已在盘，无需第二次意图写`)
  })
  await scenario('D1L 遗留/损坏无摘要意图（手工剥离摘要）：恢复不得删除唯一有效目标，自验可恢复', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    storageFault.failSuffix = '_b1_mcpkg-published'
    fsmFault.failUnlinkSuffix = '.mcpkg'
    const r0 = await client.buildAndPublishPackage({})
    storageFault.failSuffix = null; fsmFault.failUnlinkSuffix = null
    assert.ok(!r0.ok, '前置：C5 前中断')
    const fsm0 = global.wx.getFileSystemManager()
    const targetPath = [...fsm0.__files.keys()].find(p2 => /\.mcpkg$/.test(p2))
    assert.ok(targetPath, '前置：目标在盘')
    const goodBytes = new Uint8Array(fsm0.__files.get(targetPath))
    // 构造遗留/损坏意图：剥离摘要（旧版本或部分损坏形态）
    const iKey = [...storage.keys()].find(k => k.endsWith('mama_b1_mcpkg-export-intent'))
    const intent = JSON.parse(storage.get(iKey))
    delete intent.packageDigest
    storage.set(iKey, JSON.stringify(intent))
    const stack2 = makeStack('mama', { clear: false })
    installWechatGlobal(stack2)
    global.wx.getFileSystemManager().__files.set(targetPath, goodBytes)
    const client2 = loadClient(serviceBundle)
    wire(client2, stack2)
    await client2.confirmIdentity()
    let recL = null, recErr = null
    try { recL = await client2.recoverInterruptedExport() } catch (e) { recErr = e }
    const after = global.wx.getFileSystemManager().__files.get(targetPath)
    assert.ok(after && Buffer.from(after).equals(Buffer.from(goodBytes)), `无摘要意图时恢复不得删除 C4 已验目标（实得 ${after ? '字节已变' : '文件被删'}）——孤儿保留`)
    assert.ok(!recErr, `不得抛未处理异常（${recErr && (recErr.code || recErr.message)}）`)
    // 无既有可信摘要 → 不得自动认领为已发布（自验只证结构有效，无根摘要绑定即无信任根）
    const claimedL = client2.listPublished().filter(f => f.packageDigest && f.path === targetPath)
    assert.ok(claimedL.length === 0 && !(recL && recL.batchId), `遗留无摘要意图不得被自动认领为已发布（实得 claimed=${claimedL.length} rec=${JSON.stringify(recL && recL.batchId)}）——恢复认领须以既有持久摘要为信任根，而非事后自验（services/mcpkgExportService.js recoverInterruptedExport）`)
  })
  await scenario('D2 存在可恢复中断时开始新导出：不得覆写早期可恢复意图/目标', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    storageFault.failSuffix = '_b1_mcpkg-published'
    fsmFault.failUnlinkSuffix = '.mcpkg'
    const r0 = await client.buildAndPublishPackage({})
    storageFault.failSuffix = null; fsmFault.failUnlinkSuffix = null
    assert.ok(!r0.ok, '前置：C5 前中断（可恢复意图+已验目标在盘）')
    const fsm0 = global.wx.getFileSystemManager()
    const earlyPath = [...fsm0.__files.keys()].find(p2 => /\.mcpkg$/.test(p2))
    const earlyBytes = new Uint8Array(fsm0.__files.get(earlyPath))
    const earlyIntent = JSON.parse(storage.get([...storage.keys()].find(k => k.endsWith('mcpkg-export-intent'))))
    // 开始另一个导出（无故障）
    const stack2 = makeStack('mama', { clear: false })
    installWechatGlobal(stack2)
    global.wx.getFileSystemManager().__files.set(earlyPath, earlyBytes)
    const client2 = loadClient(serviceBundle)
    wire(client2, stack2)
    await client2.confirmIdentity()
    const r2 = await client2.buildAndPublishPackage({})
    // ① 早期目标字节保留
    const earlyAfter = global.wx.getFileSystemManager().__files.get(earlyPath)
    assert.ok(earlyAfter && Buffer.from(earlyAfter).equals(Buffer.from(earlyBytes)), `早期可恢复目标不得被新导出覆写/删除`)
    // ② 早期批次最终可达（新导出先完成恢复，或意图保留可随后恢复）——不接受静默丢失
    const store2 = JSON.parse(storage.get([...storage.keys()].find(k => k.endsWith('mcpkg-published'))) || '{}')
    const earlyOk = Object.values(store2).some(f => f.path === earlyPath && f.packageDigest)
    const intentNow = JSON.parse(storage.get([...storage.keys()].find(k => k.endsWith('mcpkg-export-intent'))) || 'null')
    const intentPreserved = intentNow && intentNow.batchId === earlyIntent.batchId
    assert.ok(earlyOk || intentPreserved || (r2.ok === false), `早期可恢复批次不得静默丢失（新导出 ok=${r2.ok}；早期已发布=${earlyOk}；意图保留=${intentPreserved}）`)
  })
  await scenario('D3 两次导出同冻结时钟/随机（batchId 确定性碰撞）：不得覆写既有目标或 published 标志', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    // 两次导出都在冻结时钟/随机下进行——newExportId() 必然生成相同 batchId（无碰撞守卫时的确定性碰撞）
    const realNow = Date.now.bind(Date), realRand = Math.random.bind(Math)
    Date.now = () => 1789840000000
    Math.random = () => 0.42
    let r1, r2
    try {
      r1 = await client.buildAndPublishPackage({})
      r2 = await client.buildAndPublishPackage({})
    } finally { Date.now = realNow; Math.random = realRand }
    assert.ok(r1.ok, `前置：第一包发布（${r1.code}）`)
    const fsm0 = global.wx.getFileSystemManager()
    const bytes1 = new Uint8Array(fsm0.__files.get(r1.flag.path))
    const digest1 = r1.flag.packageDigest
    const storeAll = () => JSON.parse(storage.get([...storage.keys()].find(k => k.endsWith('mcpkg-published'))) || '{}')
    if (r2 && !r2.ok) {
      // 诚实拒绝路径：第二包被拒（如检测到同 ID 目标/标志已存在）——第一包必须原样
      assert.ok(storeAll()[r1.batchId] && storeAll()[r1.batchId].packageDigest === digest1, `拒绝路径：第一包标志原样（code=${r2.code}）`)
      const bA = fsm0.__files.get(r1.flag.path)
      assert.ok(bA && Buffer.from(bA).equals(Buffer.from(bytes1)), '拒绝路径：第一包目标字节原样')
      return
    }
    if (r2 && r2.ok && r2.batchId !== r1.batchId) {
      // 碰撞守卫已实现：新导出换新 ID 且两者共存——可接受
      assert.ok(storeAll()[r1.batchId] && storeAll()[r1.batchId].packageDigest === digest1, '守卫路径：第一包标志原样')
      return
    }
    // 无守卫：batchId 必须确实相等（证明碰撞真实发生——此前"只冻第二次"的夹具从未碰撞）
    assert.ok(r2 && r2.batchId === r1.batchId, `冻结同钟同随机下两次导出应同 ID（实得 ${r1.batchId} vs ${r2 && r2.batchId}；r2.ok=${r2 && r2.ok}）`)
    const store = JSON.parse(storage.get([...storage.keys()].find(k => k.endsWith('mcpkg-published'))) || '{}')
    const entry = store[r1.batchId] || Object.values(store).find(f => f.path === r1.flag.path)
    assert.ok(entry, '标志条目存在')
    assert.equal(entry.packageDigest, digest1, `同 ID 二次导出不得覆写既有标志摘要（实得 ${entry.packageDigest} ≠ ${digest1}）`)
    const bytesAfter = fsm0.__files.get(r1.flag.path)
    assert.ok(bytesAfter && Buffer.from(bytesAfter).equals(Buffer.from(bytes1)), '同 ID 二次导出不得覆写既有目标文件字节')
  })

  await scenario('R1 恢复跨身份：目标读取期间切 papa → 不得写 papa 命名空间/覆写 papa 意图；mama 意图目标保留无成功；切回重试成功', async () => {
    // 崩溃夹具（mama）：标志写失败+清理失败 → 意图+已验目标在盘
    const { client } = await freshExport()
    await client.confirmIdentity()
    storageFault.failSuffix = '_b1_mcpkg-published'
    fsmFault.failUnlinkSuffix = '.mcpkg'
    const r0 = await client.buildAndPublishPackage({})
    storageFault.failSuffix = null; fsmFault.failUnlinkSuffix = null
    assert.ok(!r0.ok, '前置：C5 前中断')
    const fsm0 = global.wx.getFileSystemManager()
    const targetPath = [...fsm0.__files.keys()].find(p2 => /\.mcpkg$/.test(p2))
    assert.ok(targetPath, '前置：目标在盘')
    const targetBytes = new Uint8Array(fsm0.__files.get(targetPath))
    const mamaIntentKey = [...storage.keys()].find(k => k.endsWith('mama_b1_mcpkg-export-intent'))
    const mamaIntentRaw = storage.get(mamaIntentKey)
    const mamaBatchId = JSON.parse(mamaIntentRaw).batchId
    // 冷启动（同存储+同 FSM）
    const stack2 = makeStack('mama', { clear: false })
    installWechatGlobal(stack2)
    global.wx.getFileSystemManager().__files.set(targetPath, targetBytes)
    const client2 = loadClient(serviceBundle)
    wire(client2, stack2)
    await client2.confirmIdentity()
    // papa 既有意图（切换前种入 papa 命名空间——不得被恢复的迟到写覆写/清除）
    const papaIntentKey = mamaIntentKey.replace('mama_b1_', 'papa_b1_')
    const papaIntentRaw = JSON.stringify({ batchId: 'papa_own_intent', envId: 'env-b3b1', appId: 'wxapp-b3b1', familyId: TEST_ENV.MC_FAMILY_ID, memberId: 'papa', createdAt: 1789840000000 })
    storage.set(papaIntentKey, papaIntentRaw)
    // 恢复期间（目标 readChunk 首读）确定性切 papa——复用分享切换同款 FSM 钩子
    uniCalls.switchOnRead = {
      path: targetPath, fired: false,
      switch: async () => {
        stack2.curMember.value = 'papa'
        stack2.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
        await client2.endSession()
        await client2.confirmIdentity()
      },
    }
    let rec = 'unset', recErr = null
    try { rec = await client2.recoverInterruptedExport() } catch (e) { recErr = e }
    uniCalls.switchOnRead = null
    await tick(); await tick()
    // ① 无成功（不得为错误身份宣称恢复成功/返回标志）
    assert.ok(recErr || rec === null || rec === undefined || !rec.batchId, `切换期间恢复不得成功返回（实得 ${recErr ? '抛错:' + (recErr.code || recErr.message) : JSON.stringify(rec && rec.batchId)}）`)
    // ② papa 命名空间不得出现 mama 的标志
    const papaPubKey = [...storage.keys()].find(k => k.endsWith('papa_b1_mcpkg-published'))
    const papaStore = papaPubKey ? JSON.parse(storage.get(papaPubKey) || '{}') : {}
    assert.ok(!papaStore[mamaBatchId] && !Object.values(papaStore).some(f => f && f.path === targetPath), `mama 标志不得写入 papa 命名空间（papa store=${JSON.stringify(Object.keys(papaStore))}）——恢复 await 后无 epoch/成员复核、迟到写落在当前(papa)成员缓存（services/mcpkgExportService.js recoverInterruptedExport）`)
    // ③ papa 既有意图原样
    assert.equal(storage.get(papaIntentKey), papaIntentRaw, 'papa 既有意图不得被恢复的迟到 clearExportIntent/写覆写')
    // ④ mama 意图与目标字节保留
    assert.equal(storage.get(mamaIntentKey), mamaIntentRaw, 'mama 意图保留（可重试恢复）')
    const tAfter = global.wx.getFileSystemManager().__files.get(targetPath)
    assert.ok(tAfter && Buffer.from(tAfter).equals(Buffer.from(targetBytes)), 'mama 目标字节保留')
    // ⑤ 切回 mama 重试恢复 → 成功
    stack2.curMember.value = 'mama'
    stack2.cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID)
    await client2.endSession()
    await client2.confirmIdentity()
    let rec2 = null, recErr2 = null
    try { rec2 = await client2.recoverInterruptedExport() } catch (e) { recErr2 = e }
    assert.ok(!recErr2 && rec2 && rec2.batchId === mamaBatchId && rec2.packageDigest, `切回 mama 重试恢复应成功（实得 ${recErr2 ? '抛错:' + (recErr2.code || recErr2.message) : JSON.stringify(rec2 && { id: rec2.batchId, digest: !!rec2.packageDigest })}）`)
    const listed = client2.listPublished().filter(f => f.batchId === mamaBatchId)
    assert.ok(listed.length >= 1, '恢复后列表可见')
  })

  async function rfFixture() {
    const { client } = await freshExport()
    await client.confirmIdentity()
    storageFault.failSuffix = '_b1_mcpkg-published'
    fsmFault.failUnlinkSuffix = '.mcpkg'
    const r0 = await client.buildAndPublishPackage({})
    storageFault.failSuffix = null; fsmFault.failUnlinkSuffix = null
    assert.ok(!r0.ok, '前置：C5 前中断（意图含摘要+已验目标在盘）')
    const fsm0 = global.wx.getFileSystemManager()
    const targetPath = [...fsm0.__files.keys()].find(p2 => /\.mcpkg$/.test(p2))
    assert.ok(targetPath, '前置：目标在盘')
    const bytes = new Uint8Array(fsm0.__files.get(targetPath))
    const iKey = [...storage.keys()].find(k => k.endsWith('mama_b1_mcpkg-export-intent'))
    const iRaw = storage.get(iKey)
    const stack2 = makeStack('mama', { clear: false })
    installWechatGlobal(stack2)
    global.wx.getFileSystemManager().__files.set(targetPath, bytes)
    const client2 = loadClient(serviceBundle)
    wire(client2, stack2)
    await client2.confirmIdentity()
    return { client2, stack2, targetPath, bytes, iKey, iRaw }
  }
  await scenario('RF1 单次 stat 瞬时失败：不得清意图/删目标；除障重试恢复成功', async () => {
    const f = await rfFixture()
    global.wx.getFileSystemManager().__fault.failStatOnce = true
    let recErr = null
    try { await f.client2.recoverInterruptedExport() } catch (e) { recErr = e }
    assert.equal(storage.get(f.iKey), f.iRaw, `stat 瞬时失败不得清除持久意图（实得 ${storage.get(f.iKey) ? '已变' : '被清'}）——adapter stat→fs-error、恢复 catch 即 clearExportIntent（services/mcpkgExportService.js）`)
    const t = global.wx.getFileSystemManager().__files.get(f.targetPath)
    assert.ok(t && Buffer.from(t).equals(Buffer.from(f.bytes)), '目标字节保留')
    assert.ok(!recErr || recErr.code === 'fs-error', `不得未处理异常外溢（${recErr && recErr.code}）`)
    const rec2 = await f.client2.recoverInterruptedExport()
    assert.ok(rec2 && rec2.batchId && rec2.packageDigest, `除障后重试恢复成功（实得 ${JSON.stringify(rec2 && rec2.batchId)}）`)
  })
  await scenario('RF2 单次 readChunk 瞬时失败（validatePackage 抛 fs-error）：不得删目标/清意图；除障重试成功', async () => {
    const f = await rfFixture()
    global.wx.getFileSystemManager().__fault.failReadOnce = true
    let recErr = null
    try { await f.client2.recoverInterruptedExport() } catch (e) { recErr = e }
    const t = global.wx.getFileSystemManager().__files.get(f.targetPath)
    assert.ok(t && Buffer.from(t).equals(Buffer.from(f.bytes)), `readChunk 瞬时失败不得删除唯一有效目标（实得 ${t ? '字节已变' : '文件被删'}）——validatePackage fs-error 抛出→恢复 catch 即 removeFile（services/mcpkgExportService.js）`)
    assert.equal(storage.get(f.iKey), f.iRaw, '意图保留（可重试）')
    assert.ok(!recErr || recErr.code === 'fs-error', `不得未处理异常外溢（${recErr && recErr.code}）`)
    const rec2 = await f.client2.recoverInterruptedExport()
    assert.ok(rec2 && rec2.batchId && rec2.packageDigest, `除障后重试恢复成功（实得 ${JSON.stringify(rec2 && rec2.batchId)}）`)
  })
  await scenario('RF3 失败路径 removeFile 异步期间切身份：后续 clearExportIntent 不得抹掉新成员意图', async () => {
    const f = await rfFixture()
    // papa 预种自有意图（不得被迟到的 clear 抹掉）
    const papaKey = f.iKey.replace('mama_b1_', 'papa_b1_')
    const papaRaw = JSON.stringify({ batchId: 'papa_own_rf3', envId: 'env-b3b1', appId: 'wxapp-b3b1', familyId: TEST_ENV.MC_FAMILY_ID, memberId: 'papa', createdAt: 1789840000000 })
    storage.set(papaKey, papaRaw)
    global.wx.getFileSystemManager().__fault.failReadOnce = true // 触发失败路径（removeFile+clearExportIntent）
    uniCalls.switchOnUnlink = {
      fired: false,
      switch: async () => {
        f.stack2.curMember.value = 'papa'
        f.stack2.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
        await f.client2.endSession()
        await f.client2.confirmIdentity()
      },
    }
    let recErr = null
    try { await f.client2.recoverInterruptedExport() } catch (e) { recErr = e }
    uniCalls.switchOnUnlink = null
    await tick(); await tick()
    assert.equal(storage.get(papaKey), papaRaw, `失败路径的迟到 clearExportIntent 不得抹掉新成员（papa）意图（实得 ${storage.get(papaKey) ? '已变' : '被清'}）——removeFile await 后无成员/epoch 复核即清当前命名空间（services/mcpkgExportService.js）`)
    assert.ok(!recErr || recErr.code === 'fs-error', `不得未处理异常外溢（${recErr && recErr.code}）`)
  })

  await scenario('C5b 冷启动同身份：分享绑定新鲜 epoch 并成功 delivered', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok)
    const pkgBytesB = new Uint8Array(global.wx.getFileSystemManager().__files.get(r.flag.path))
    const stack2 = makeStack('mama', { clear: false })
    installWechatGlobal(stack2)
    global.wx.getFileSystemManager().__files.set(r.flag.path, pkgBytesB) // 沙箱持久语义
    const client2 = loadClient(serviceBundle)
    wire(client2, stack2)
    await client2.confirmIdentity()
    const share = await client2.sharePublishedPackage(r.batchId)
    assert.ok(share.ok && share.delivered, `冷启动分享: ${share.code} ${share.message || ''}`)
    const key = [...storage.keys()].find(k => k.endsWith('mcpkg-published'))
    const st = JSON.parse(storage.get(key))
    assert.ok(st[r.batchId].deliveredAt, 'deliveredAt 已记录')
  })
  await scenario('C5c 换成员/换家庭：旧标志不可分享（scope-mismatch）', async () => {
    const { stack, client } = await freshExport()
    await client.confirmIdentity()
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok)
    // 换成员
    stack.curMember.value = 'papa'
    stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
    await client.confirmIdentity()
    let s = await client.sharePublishedPackage(r.batchId)
    assert.ok(!s.ok && (s.code === 'scope-mismatch' || s.code === 'no-published'), `换成员拒绝（另一成员命名空间本就不可见）: ${s.code}`)
    // 换家庭（同成员）
    process.env.MC_FAMILY_ID = 'fam-other'
    stack.curMember.value = 'mama'
    stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID)
    await client.endSession()
    await client.confirmIdentity()
    s = await client.sharePublishedPackage(r.batchId)
    assert.ok(!s.ok && s.code === 'scope-mismatch', `换家庭拒绝: ${s.code}`)
    process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID
  })
  await scenario('C5d 迟到分享回调跨身份：不得为错误身份标 delivered', async () => {
    const { stack, client } = await freshExport()
    await client.confirmIdentity()
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok)
    uniCalls.holdShare = true
    const p = client.sharePublishedPackage(r.batchId)
    await tick()
    assert.equal(uniCalls.shareHeld.length, 1, '分享请求已发出（挂起）')
    stack.curMember.value = 'papa'
    stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
    await client.confirmIdentity()
    uniCalls.holdShare = false
    uniCalls.shareHeld[0].success({ errMsg: 'shareFileMessage:ok' })
    const res = await p
    assert.ok(!res.ok && res.code === 'stale-session', `迟到回调不得 delivered: ${JSON.stringify(res)}`)
    const key = [...storage.keys()].find(k => k.endsWith('mcpkg-published'))
    const st = JSON.parse(storage.get(key))
    assert.ok(!st[r.batchId].deliveredAt, 'deliveredAt 未被误写')
  })
  await scenario('C6 分享前全包摘要复验：目标被篡改 → 拒绝分享且文件保留', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok)
    const f = global.wx.getFileSystemManager().__files.get(r.flag.path)
    f[f.length - 1] ^= 0xff // 篡改末字节
    const s = await client.sharePublishedPackage(r.batchId)
    assert.ok(!s.ok && s.code === 'digest-mismatch', `篡改拒绝: ${s.code}`)
    assert.equal(uniCalls.shareCalls.length, 0, '未发起 shareFileMessage')
    assert.ok(global.wx.getFileSystemManager().__files.has(r.flag.path), '原文件保留（不因拒绝删除）')
  })
  await scenario('C7 诊断包：pending 非空 → packageKind=diagnostic+incompleteReasons，可发布可分享但文案如实', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    storage.set('mc_cache_env-b3b1_wxapp-b3b1_mama_b1_b3-migration', JSON.stringify({ batchId: 'mig-open', status: 'partial' }))
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok, `诊断包仍可构建发布: ${r.code}`)
    assert.equal(r.complete, false, 'complete=false')
    assert.equal(r.packageKind, 'diagnostic')
    assert.ok(r.flag.complete === false && r.flag.packageKind === 'diagnostic', '标志如实携带诊断语义')
    const s = await client.sharePublishedPackage(r.batchId)
    assert.ok(s.ok || s.code, '分享路径行为明确')
    // mood omitted 不计入 incompleteReasons（未选≠不完整）
    const vr = await client.validatePackage(client.wechatFileReader(r.flag.path))
    const reasons = JSON.stringify(vr.manifest.incompleteReasons || [])
    assert.ok(!reasons.includes('mood'), 'omitted 域不算 reason')
    assert.ok(reasons.includes('pending_operations') || reasons.includes('migrationIncomplete') || reasons.length > 0, 'reasons 非空')
  })
  await scenario('C8 .partial/未发布目标不可分享：无标志即 no-published', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    const s = await client.sharePublishedPackage('exp_nonexistent')
    assert.ok(!s.ok && s.code === 'no-published', `无标志拒绝: ${s.code}`)
  })

  // ── 域 JSON 提取（从已发布包分块读出指定 domain 的记录数组）──
  async function readDomainRecords(client, flagPath, domain) {
    const reader = client.wechatFileReader(flagPath)
    const head = await reader.readChunk(0, 24)
    const hv = new DataView(head.buffer, head.byteOffset, 24)
    const manifestLen = hv.getUint32(20)
    let mBytes = []
    for (let off = 0; off < manifestLen; off += 65536) {
      const n = Math.min(65536, manifestLen - off)
      mBytes.push(Buffer.from(await reader.readChunk(24 + off, n)))
    }
    const manifest = JSON.parse(Buffer.concat(mBytes).toString('utf8'))
    let cursor = 24 + manifestLen
    for (let i = 0; i < manifest.files.length; i++) {
      const lp = await reader.readChunk(cursor, 8)
      const entryLen = new DataView(lp.buffer, lp.byteOffset, 8).getUint32(4)
      cursor += 8
      const f = manifest.files[i]
      if (f.kind === 'domain-json' && f.domain === domain) {
        let parts = []
        for (let off = 0; off < entryLen; off += 65536) {
          const n = Math.min(65536, entryLen - off)
          parts.push(Buffer.from(await reader.readChunk(cursor + off, n)))
        }
        return JSON.parse(Buffer.concat(parts).toString('utf8'))
      }
      cursor += entryLen
    }
    throw new Error('domain ' + domain + ' 未找到于包内')
  }

  await scenario('P1 孕期字段保真：records/pregnancy.json 与 handler pregnancy.get 逐字段相等（lmpDate/dueDate/nickname）', async () => {
    const { stack, client } = await freshExport()
    await client.confirmIdentity()
    const hv = await healthH.main({ action: 'pregnancy.get', schemaVersion: 1, operationId: 'ro-get' })
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok, `发布: ${r.code}`)
    const recs = await readDomainRecords(client, r.flag.path, 'pregnancy')
    assert.equal(recs.length, 1, '孕期单记录')
    const cloud = hv.data.record || {}
    for (const k of ['lmpDate', 'dueDate', 'nickname']) {
      assert.deepEqual(recs[0][k], cloud[k], `pregnancy.${k}：包=${JSON.stringify(recs[0][k])} 云=${JSON.stringify(cloud[k])}`)
    }
    void stack
  })
  await scenario('P2 产检字段保真：records/checkup.json 与 handler checkup.list 逐字段相等（time/companion/materials/questions）', async () => {
    const { stack, client } = await freshExport()
    await client.confirmIdentity()
    const lst = await scheduleH.main({ action: 'checkup.list', schemaVersion: 1 })
    const cloudRec = (lst.data.records || []).find(x => x.id === 'chk_seed_1')
    assert.ok(cloudRec, '前置：云端存在 chk_seed_1')
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok, `发布: ${r.code}`)
    const recs = await readDomainRecords(client, r.flag.path, 'checkup')
    const pkgRec = recs.find(x => x.id === 'chk_seed_1')
    assert.ok(pkgRec, '包内存在 chk_seed_1')
    for (const k of ['time', 'companion', 'materials', 'questions']) {
      assert.deepEqual(pkgRec[k], cloudRec[k], `checkup.${k}：包=${JSON.stringify(pkgRec[k])} 云=${JSON.stringify(cloudRec[k])}——服务 CHECKUP_FIELDS 白名单静默丢弃（services/mcpkgExportService.js CHECKUP_FIELDS）`)
    }
    void stack
  })
  await scenario('P3 待产包字段保真：records/bag.json 与 handler bag.list 逐字段相等（name/location/assignee/prepared）', async () => {
    const { stack, client } = await freshExport()
    await client.confirmIdentity()
    const lst = await scheduleH.main({ action: 'bag.list', schemaVersion: 1 })
    const cloudRec = (lst.data.records || []).find(x => x.id === 'bag_seed_1')
    assert.ok(cloudRec, '前置：云端存在 bag_seed_1')
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok, `发布: ${r.code}`)
    const recs = await readDomainRecords(client, r.flag.path, 'bag')
    const pkgRec = recs.find(x => x.id === 'bag_seed_1')
    assert.ok(pkgRec, '包内存在 bag_seed_1')
    for (const k of ['name', 'location', 'assignee', 'prepared']) {
      assert.deepEqual(pkgRec[k], cloudRec[k], `bag.${k}：包=${JSON.stringify(pkgRec[k])} 云=${JSON.stringify(cloudRec[k])}——服务 BAG_FIELDS 白名单（text/category/quantity/done）与 handler 实际字段（name/location/assignee/prepared）错位（services/mcpkgExportService.js BAG_FIELDS）`)
    }
    void stack
  })
  await scenario('P4 损坏 outbox 读取不得产出 full 包（须失败或降级诊断）', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    storage.set('mc_outbox_env-b3b1_wxapp-b3b1_mama_b2a', '{CORRUPT_OUTBOX')
    const r = await client.buildAndPublishPackage({})
    const fullPkg = r.ok && r.complete === true && r.packageKind === 'full'
    assert.ok(!fullPkg, `outbox 不可读时不得宣称完整备份（ok=${r.ok} complete=${r.complete} kind=${r.packageKind}）——collectPendingLists 吞掉读取异常按空处理（services/mcpkgExportService.js collectPendingLists）`)
  })
  await scenario('P5 分享预检哈希期间切成员：绝不调用 shareFileMessage', async () => {
    const { stack, client } = await freshExport()
    await client.confirmIdentity()
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok)
    uniCalls.switchOnRead = {
      path: r.flag.path, fired: false,
      switch: async () => {
        stack.curMember.value = 'papa'
        stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
        await client.endSession()
        await client.confirmIdentity()
      },
    }
    const res = await client.sharePublishedPackage(r.batchId)
    uniCalls.switchOnRead = null
    assert.equal(uniCalls.shareCalls.length, 0, '预检期间身份变化绝不发起 shareFileMessage')
    assert.ok(!res.ok, `分享必须被拒: ${JSON.stringify(res)}`)
  })

  // ── 容器变异工具：解码→变异→重编码（构造攻击包）──
  function parsePkg(bytes) {
    const b = Buffer.from(bytes)
    const manifestLen = Number(new DataView(b.buffer, b.byteOffset + 16, 8).getBigUint64(0))
    const manifest = JSON.parse(b.subarray(24, 24 + manifestLen).toString('utf8'))
    let cursor = 24 + manifestLen
    const segments = []
    for (let i = 0; i < manifest.files.length; i++) {
      const entryLen = Number(new DataView(b.buffer, b.byteOffset + cursor, 8).getBigUint64(0))
      cursor += 8
      segments.push(b.subarray(cursor, cursor + entryLen))
      cursor += entryLen
    }
    if (cursor !== b.length) throw new Error('源包 EOF 不一致@parse')
    return { manifest, segments }
  }
  function buildPkg(manifestBytes, segments) {
    const parts = []
    const head = Buffer.alloc(24)
    head.write('MOMCPKG\0', 0, 'ascii')
    head.writeUInt32BE(1, 8)
    head.writeUInt32BE(0, 12)
    new DataView(head.buffer).setBigUint64(16, BigInt(manifestBytes.length))
    parts.push(head, Buffer.from(manifestBytes))
    for (const seg of segments) {
      const lp = Buffer.alloc(8)
      new DataView(lp.buffer).setBigUint64(0, BigInt(seg.length))
      parts.push(lp, Buffer.from(seg))
    }
    return Buffer.concat(parts)
  }
  function putPkgToFsm(bytes) {
    const fsmNow = global.wx.getFileSystemManager()
    const p = 'wxfile://usr/MomCareExport/mutant.mcpkg'
    fsmNow.__files.set(p, new Uint8Array(bytes))
    return p
  }

  await scenario('M1 孕期在首次 get 与发布之间变化 → 陈旧 full 必须被阻断（确定性：二次扫描 pregnancy.get 响应前 await 修改）', async () => {
    const { stack, client } = await freshExport()
    await client.confirmIdentity()
    let armed = false, mutated = false
    const realHealth = stack.routes['mc-health']
    let callCount = 0
    stack.routes['mc-health'] = async e => {
      if (e.action === 'pregnancy.get') callCount++
      if (armed && !mutated && e.action === 'pregnancy.get') {
        mutated = true
        const up = await healthH.main({ action: 'pregnancy.upsert', schemaVersion: 1, operationId: 'preg-change', payload: { nickname: '变更后昵称' } })
        if (!up.ok) throw new Error('preg mutate failed: ' + JSON.stringify(up))
      }
      return realHealth(e)
    }
    const r = await client.buildAndPublishPackage({ onProgress: p => { if (p.stage === 'publish-check') armed = true } })
    const staleFull = r.ok && r.complete === true && r.packageKind === 'full'
    assert.ok(!staleFull, `孕期收集后变化不得仍以旧快照出 full（ok=${r.ok} complete=${r.complete} kind=${r.packageKind} code=${r.code}；pregnancy.get 调用数=${callCount}）——services/mcpkgExportService.js secondScanCompare 是否覆盖 pregnancy 单例域`)
  })
  await scenario('M2 不可读 pending 源（上传批次/迁移批次/本机草稿）→ full 必须降级诊断或失败', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    storage.set('mc_cache_env-b3b1_wxapp-b3b1_mama_b1_b2b2-upload-batches', '{CORRUPT_BATCHES')
    storage.set('mc_cache_env-b3b1_wxapp-b3b1_mama_b1_b3-migration', '{CORRUPT_MIG')
    storage.set('mc_draft_env-b3b1_wxapp-b3b1_mama_b1', '{CORRUPT_DRAFT')
    const r = await client.buildAndPublishPackage({})
    const fullPkg = r.ok && r.complete === true && r.packageKind === 'full'
    assert.ok(!fullPkg, `三处 pending 源不可读时不得宣称完整备份（ok=${r.ok} complete=${r.complete} kind=${r.packageKind}）——pendingDrafts 吞错返回 null（services/sessionService.js pendingDrafts）与 collectPendingLists 各源 catch 语义（services/mcpkgExportService.js）`)
  })
  await scenario('M3a 篡改 manifest 声明（deleted/revision/id）而 hash 不动 → 校验器必须拒绝', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok)
    const bytes = Buffer.from(global.wx.getFileSystemManager().__files.get(r.flag.path))
    for (const mutate of [
      m => { m.records.daily[0].deleted = true },
      m => { m.records.daily[0].revision = (m.records.daily[0].revision || 0) + 1 },
      m => { m.records.daily[0].id = 'forged-id' },
    ]) {
      const { manifest, segments } = parsePkg(bytes)
      mutate(manifest)
      const crafted = buildPkg(Buffer.from(codec.canonicalJsonBytes(manifest)), segments)
      const vr = await client.validatePackage(client.wechatFileReader(putPkgToFsm(crafted)))
      assert.ok(!vr.ok, `声明篡改必须拒绝（problems=${JSON.stringify(vr.problems.slice(0, 3))}）——utils/mcpkg/container.js records 比对"hash 相等即一致"，未直接比对声明 id/revision/deleted 与领域记录字段`)
    }
  })
  await scenario('M3b 非规范 manifest 原始 JSON（键序/空白）即使文件哈希全符 → 校验器拒绝（manifest-not-canonical）', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok)
    const bytes = Buffer.from(global.wx.getFileSystemManager().__files.get(r.flag.path))
    const { manifest, segments } = parsePkg(bytes)
    const nonCanonical = Buffer.from(JSON.stringify(manifest, null, 2)) // 空白+插入序键
    assert.notEqual(nonCanonical.length, Buffer.from(codec.canonicalJsonBytes(manifest)).length, '前置：非规范字节确实不同')
    const crafted = buildPkg(nonCanonical, segments)
    const vr = await client.validatePackage(client.wechatFileReader(putPkgToFsm(crafted)))
    assert.ok(!vr.ok, `非规范 manifest 字节必须拒绝（problems=${JSON.stringify(vr.problems.slice(0, 3))}）`)
    assert.ok(vr.problems.some(x => x.code === 'manifest-not-canonical'), '拒绝码=manifest-not-canonical——utils/mcpkg/container.js:245-250 守卫反了：canonOk=false（长度不一致=非规范）时不 push 问题、静默放行')
  })
  await scenario('M3c 非规范领域 JSON 段（哈希已匹配）→ 校验器必须拒绝（canonical 唯一规则覆盖段字节）', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok)
    const bytes = Buffer.from(global.wx.getFileSystemManager().__files.get(r.flag.path))
    const { manifest, segments } = parsePkg(bytes)
    // 把第一个 domain-json 段 pretty 化，并同步 files[].sha256/length（哈希匹配的自洽攻击包）
    const fi = manifest.files.findIndex(f => f.kind === 'domain-json')
    assert.ok(fi >= 0, '存在领域段')
    const parsedSeg = JSON.parse(segments[fi].toString('utf8'))
    const pretty = Buffer.from(JSON.stringify(parsedSeg, null, 2))
    const segs2 = segments.slice(); segs2[fi] = pretty
    manifest.files[fi].length = pretty.length
    manifest.files[fi].sha256 = codec.sha256Hex ? codec.sha256Hex(new Uint8Array(pretty)) : codec.bytesSha256Hex(new Uint8Array(pretty))
    const crafted = buildPkg(Buffer.from(codec.canonicalJsonBytes(manifest)), segs2)
    const vr = await client.validatePackage(client.wechatFileReader(putPkgToFsm(crafted)))
    assert.ok(!vr.ok, `非规范领域段字节（哈希匹配）必须拒绝（problems=${JSON.stringify(vr.problems.slice(0, 3))}）——utils/mcpkg/container.js 仅对 manifest 做规范字节校验，领域段缺失同等校验`)
  })

  await scenario('C9 同成员换家庭后：listPublished/页面列表隐藏旧家庭标志；removePublishedRecord 拒绝不删；切回恢复可分享', async () => {
    const { stack, client } = await freshExport()
    await client.confirmIdentity()
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok, `前置发布成功: ${r.code} ${r.message || ''}`)
    const flagKey = [...storage.keys()].find(k => k.endsWith('mcpkg-published'))
    const flagStoreBefore = JSON.parse(storage.get(flagKey))
    const pkgBytesC9 = new Uint8Array(global.wx.getFileSystemManager().__files.get(r.flag.path))
    // 同成员换家庭（成员缓存键不变——标志物理上仍在同一键下）
    process.env.MC_FAMILY_ID = 'fam-other'
    stack.routes['mc-identity'] = () => ({ ok: true, data: { memberId: 'mama', familyId: 'fam-other', displayName: '妈妈' } })
    await client.endSession()
    await client.confirmIdentity()
    // ① 服务层：旧家庭标志必须隐藏
    const listed = client.listPublished()
    assert.ok(!listed.some(f => f.batchId === r.batchId), `换家庭后 listPublished 必须隐藏旧家庭标志（实得 ${JSON.stringify(listed.map(f => ({ id: f.batchId, fam: f.familyId })))}）——getMemberCache 键不含 familyId（services/mcpkgExportService.js listPublished）`)
    // ② 页面层：publishedList 同样隐藏
    const pageStack = makeStack('mama', { clear: false })
    process.env.MC_FAMILY_ID = 'fam-other' // makeStack 会重置 env——页面会话必须仍在换入家庭
    installWechatGlobal(pageStack)
    global.wx.getFileSystemManager().__files.set(r.flag.path, pkgBytesC9)
    const page = loadClient(exportPageBundle)
    wire(page, pageStack)
    await page.confirmIdentity()
    assert.ok(!page.publishedList.value.some(f => f.batchId === r.batchId), `页面 publishedList 必须隐藏旧家庭标志（实得 ${page.publishedList.value.length} 条）`)
    // ③ 删除：必须拒绝且不动标志与文件
    const del = await page.removePublishedRecord(r.batchId)
    assert.ok(!del.ok, `换家庭后 removePublishedRecord 必须拒绝（实得 ${JSON.stringify(del)}）`)
    const flagStoreAfter = JSON.parse(storage.get(flagKey))
    assert.ok(flagStoreAfter[r.batchId], '标志未被删除（保留原作用域）')
    assert.deepEqual(JSON.parse(storage.get(flagKey)), flagStoreBefore, '标志存储整体未变')
    assert.ok(global.wx.getFileSystemManager().__files.has(r.flag.path), '包文件未被删除')
    // ④ 切回原家庭——恢复可见可分享
    process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID
    stack.routes['mc-identity'] = () => ({ ok: true, data: { memberId: 'mama', familyId: TEST_ENV.MC_FAMILY_ID, displayName: '妈妈' } })
    await client.endSession()
    await client.confirmIdentity()
    assert.ok(client.listPublished().some(f => f.batchId === r.batchId), '切回原家庭标志恢复可见')
    const share = await client.sharePublishedPackage(r.batchId)
    assert.ok(share.ok && share.delivered, `切回后分享恢复: ${share.code} ${share.message || ''}`)
  })

  await scenario('Q1 daily.fields 未知嵌套键（schema 演进数据）不得静默产出 full', async () => {
    const { stack, client } = await freshExport()
    await client.confirmIdentity()
    stack.cloud.__docs.set(`mc_health_daily/${TEST_ENV.MC_FAMILY_ID}:2026-07-01`, {
      familyId: TEST_ENV.MC_FAMILY_ID, type: 'daily', dateKey: '2026-07-01', fields: { weightKg: 61, futureFlag: 'x' },
      revision: 1, deleted: false, schemaVersion: 1,
    })
    // 前置：真实 list 必须返回种子文档（否则测试空洞）
    const seeded1 = await healthH.main({ action: 'daily.list', schemaVersion: 1 })
    assert.ok((seeded1.data.records || []).some(x => x.dateKey === '2026-07-01'), '前置：daily.list 返回种子文档（type: daily）')
    const r = await client.buildAndPublishPackage({})
    const fullPkg = r.ok && r.complete === true && r.packageKind === 'full'
    assert.ok(!fullPkg, `fields 含未知嵌套键（futureFlag）不得静默丢弃后仍宣称完整（ok=${r.ok} complete=${r.complete} problems=${JSON.stringify(r.problems)}）——guardUnknownFields 只查记录顶层键不查 fields 嵌套键（services/mcpkgExportService.js:46-53）`)
  })
  await scenario('Q2 daily/mood 存储侧 unsupported schemaVersion（999）记录不得产出 full', async () => {
    const { stack, client } = await freshExport()
    await client.confirmIdentity()
    const s0 = client.getSessionState()
    stack.cloud.__docs.set(`mc_health_daily/${TEST_ENV.MC_FAMILY_ID}:2026-07-02`, {
      familyId: TEST_ENV.MC_FAMILY_ID, type: 'daily', dateKey: '2026-07-02', fields: { weightKg: 62 },
      revision: 1, deleted: false, schemaVersion: 999,
    })
    stack.cloud.__docs.set(`mc_moods/${TEST_ENV.MC_FAMILY_ID}:2026-07-03`, {
      familyId: TEST_ENV.MC_FAMILY_ID, type: 'mood', ownerId: 'mama', dateKey: '2026-07-03', fields: { mood: 'ok' },
      revision: 1, deleted: false, schemaVersion: 999,
    })
    // 前置：真实 list 必须返回两份种子文档
    const seededD = await healthH.main({ action: 'daily.list', schemaVersion: 1 })
    assert.ok((seededD.data.records || []).some(x => x.dateKey === '2026-07-02'), '前置：daily.list 返回 999 种子（type: daily）')
    const seededM = await healthH.main({ action: 'mood.list', schemaVersion: 1 })
    assert.ok((seededM.data.records || []).some(x => x.dateKey === '2026-07-03'), `前置：mood.list 返回 999 种子（ownerId+type: mood；实得 ${JSON.stringify((seededM.data.records || []).map(r => r.dateKey).slice(0, 5))}）`)
    const r = await client.buildAndPublishPackage({ includePrivateOf: s0.member.memberId })
    const fullPkg = r.ok && r.complete === true && r.packageKind === 'full'
    assert.ok(!fullPkg, `存储侧 schemaVersion=999 记录不得被当作可完整导出内容（ok=${r.ok} complete=${r.complete} kind=${r.packageKind} problems=${JSON.stringify(r.problems).slice(0, 200)}）`)
  })
  await scenario('Q3 全部选中域读取失败 → 有效零段诊断包（可校验、如实 missing）', async () => {
    const { stack, client } = await freshExport()
    await client.confirmIdentity()
    for (const name of ['mc-health', 'mc-schedule', 'mc-reports']) {
      stack.routes[name] = () => ({ ok: false, code: 'synthetic-down', message: 'synthetic outage' })
    }
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok, `全域失败仍应产出诊断包（实得 ${r.code}: ${r.message || ''}）`)
    assert.equal(r.complete, false, 'complete=false')
    assert.equal(r.packageKind, 'diagnostic', 'packageKind=diagnostic')
    const vr = await client.validatePackage(client.wechatFileReader(r.flag.path))
    assert.ok(vr.ok, `零段诊断包必须通过校验: ${JSON.stringify(vr.problems.slice(0, 3))}`)
    const doms = vr.manifest.domains
    for (const d of ['pregnancy', 'daily', 'checkup', 'bag', 'reports']) {
      assert.equal(doms[d] && doms[d].status, 'missing', `域 ${d} 须如实 missing（实得 ${doms[d] && doms[d].status}）`)
    }
  })
  await scenario('Q4 校验器仅接受精确 EOF：尾部多 1 字节/截断 1 字节均拒绝', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok)
    const bytes = Buffer.from(global.wx.getFileSystemManager().__files.get(r.flag.path))
    const withTail = Buffer.concat([bytes, Buffer.from([0x00])])
    let vr = await client.validatePackage(client.wechatFileReader(putPkgToFsm(withTail)))
    assert.ok(!vr.ok, `尾部多余字节必须拒绝: ${JSON.stringify(vr.problems.slice(0, 2))}`)
    const truncated = bytes.subarray(0, bytes.length - 1)
    let vr2
    try { vr2 = await client.validatePackage(client.wechatFileReader(putPkgToFsm(truncated))) } catch (e) { vr2 = { ok: false, problems: [{ code: e.code, message: e.message }] } }
    assert.ok(!vr2.ok, `截断 1 字节必须拒绝: ${JSON.stringify((vr2.problems || []).slice(0, 2))}`)
  })
  await scenario('Q5 非浏览器环境无 wx 文件系统：页面如实 unsupported 且零 document 访问', async () => {
    const stack = makeStack('mama')
    installWechatGlobal(stack)
    const page = loadClient(restorePageBundle)
    wire(page, stack)
    await page.confirmIdentity()
    const docHits = []
    global.document = { createElement() { docHits.push('createElement'); throw new Error('document 在非浏览器环境被触碰') } }
    const savedWx = global.wx
    delete global.wx
    try {
      await page.pickFile()
    } catch (e) { /* 页面未捕获的异常也记录——断言只认 docHits 与文案 */ }
    global.wx = savedWx
    delete global.document
    assert.equal(docHits.length, 0, '非浏览器无 wx 环境不得触碰 document（本地 H5 picker 不可用须如实提示，而非落入 DOM 分支）')
    assert.ok(uniCalls.toasts.some(t => /不支持|不可用|无法/.test(String(t))), `须有诚实能力提示: ${JSON.stringify(uniCalls.toasts.slice(-3))}`)
  })

  await scenario('Q6 reader.size > 64MiB：在任何 readChunk 之前立即拒绝（有效小 manifest+巨型尾部陷阱，零次读）', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok)
    // 真实有效包字节作为前缀（若校验器开读，会得到完全合法的头部/manifest/段——只靠尾部撑大）
    const real = Buffer.from(global.wx.getFileSystemManager().__files.get(r.flag.path))
    const oversized = client.LIMITS.MAX_PKG_BYTES + 1
    let reads = 0
    const trap = {
      async size() { return oversized },
      async readChunk(pos, len) {
        reads++
        const n = Math.min(len, real.length - pos)
        return n <= 0 ? new Uint8Array(len) : new Uint8Array(Buffer.concat([real.subarray(pos, pos + n), Buffer.alloc(Math.max(0, len - n))]))
      },
    }
    let err = null, vr = null
    try { vr = await client.validatePackage(trap) } catch (e) { err = e }
    const limitError = (err && (err.code === 'limit-exceeded' || /64MiB|MAX_PKG/.test(String(err.message)))) ||
      (vr && !vr.ok && (vr.problems || []).some(x => x.code === 'limit-exceeded'))
    assert.ok(limitError, `必须给出 limit 错误（throw=${err && err.code} problems=${JSON.stringify(vr && vr.problems || []).slice(0, 120)}）——utils/mcpkg/container.js validatePackage 在 size()>MAX_PKG_BYTES 时缺读前立即拒绝门（现唯一 64MiB 检查是条目推导总长 :135，读取已发生）`)
    assert.equal(reads, 0, `超限包必须零次 readChunk（实得 ${reads} 次）——有效前缀+巨型尾部不得诱导读取`)
  })

  await scenario('Q7 下载成功回调但 statusCode 404/403 或 200+HTML：垃圾字节不得进入 full 包、无效图片签名不得被接受为原件', async () => {
    for (const mode of ['404', '403', 'html200']) {
      const { client } = await freshExport()
      await client.confirmIdentity()
      uniCalls.downloadMode = mode
      const r = await client.buildAndPublishPackage({})
      uniCalls.downloadMode = 'ok'
      const fullPkg = r.ok && r.complete === true && r.packageKind === 'full'
      assert.ok(!fullPkg, `[${mode}] HTTP 错误页/HTML 字节不得被当作附件原件打包进 full（ok=${r.ok} complete=${r.complete} problems=${JSON.stringify(r.problems)}）——导出侧 uni.downloadFile 忽略 statusCode 且无图片签名校验（services/mcpkgExportService.js 附件下载段）`)
      if (r.ok && r.complete === false) {
        // 即便以诊断包发布：垃圾附件必须伴随显式 problems（而非静默纳入）
        assert.ok((r.problems || []).length > 0 || (r.incompleteReasons || []).length > 0, `[${mode}] 诊断包必须显式记录附件问题`)
      }
    }
  })
  await scenario('Q8 200 但字节数短于 getReadUrls 受控 sizeBytes：截断下载不得产出 full', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    uniCalls.downloadMode = 'short200'
    const r = await client.buildAndPublishPackage({})
    uniCalls.downloadMode = 'ok'
    const fullPkg = r.ok && r.complete === true && r.packageKind === 'full'
    assert.ok(!fullPkg, `截断字节（比受控 sizeBytes 少 100 字节）不得进入 full 包（ok=${r.ok} complete=${r.complete} problems=${JSON.stringify(r.problems)}）——getReadUrls 已返回 sizeBytes，导出侧未比对实际字节数（services/mcpkgExportService.js 附件下载段）`)
  })

  await scenario('P6 b2b2 上传批次真实形状（{batches:{…}} 包装）含活跃批次：必须列入 pending 且导出降级诊断', async () => {
    const key = 'mc_cache_env-b3b1_wxapp-b3b1_mama_b1_b2b2-upload-batches'
    for (const status of ['uploading', 'partial', 'reconciling']) {
      const { client } = await freshExport()
      await client.confirmIdentity()
      // reportFamilyStore 真实持久形状（:84 setMemberCache(BATCHES_KEY, { batches: …})）
      storage.set(key, JSON.stringify({ batches: { upl_seed: { batchId: 'upl_seed', status } } }))
      const pend = client.collectPendingLists()
      assert.ok(pend.uploadBatches.includes('upl_seed'), `[${status}] 真实包装形状下的活跃批次必须列入 uploadBatches（实得 ${JSON.stringify(pend.uploadBatches)}）——collectPendingLists 对 {batches:{…}} 仍按扁平映射 Object.values 枚举（services/mcpkgExportService.js b2b2-upload-batches collect）`)
      const r = await client.buildAndPublishPackage({})
      const fullPkg = r.ok && r.complete === true && r.packageKind === 'full'
      assert.ok(!fullPkg, `[${status}] 活跃上传批次存在时不得产出 full（ok=${r.ok} complete=${r.complete}）`)
    }
  })
  await scenario('P6b 键存在但形状错误（可解析非预期结构）→ 必须置 indeterminate 且不出 full', async () => {
    const key = 'mc_cache_env-b3b1_wxapp-b3b1_mama_b1_b2b2-upload-batches'
    for (const [name, raw] of [['数组', '[1,2]'], ['batches 非对象', '{"batches":"not-an-object"}'], ['纯数字', '123']]) {
      const { client } = await freshExport()
      await client.confirmIdentity()
      storage.set(key, raw)
      const pend = client.collectPendingLists()
      assert.equal(pend.indeterminate, true, `[${name}] 形状错误必须 indeterminate=true（实得 ${JSON.stringify(pend)}）——getScopedCacheStatus 仅区分可解析与否，collect 对非预期结构静默当空`)
      const r = await client.buildAndPublishPackage({})
      const fullPkg = r.ok && r.complete === true && r.packageKind === 'full'
      assert.ok(!fullPkg, `[${name}] indeterminate 不得产出 full（ok=${r.ok} complete=${r.complete}）`)
    }
  })

  // ── M4：自洽变异包（重算 canonical 字节与哈希后仍须被拒）──
  async function craftAndValidate(client, baseBytes, mutate, opts = {}) {
    // 前置①：基包本身校验通过
    const baseVr = await client.validatePackage(client.wechatFileReader(putPkgToFsm(baseBytes)))
    assert.ok(baseVr.ok, `前置：基包校验通过（problems=${JSON.stringify(baseVr.problems.slice(0, 2))}）`)
    const { manifest, segments } = parsePkg(baseBytes)
    // 前置②：空变异重建（同一 crafting 管线）仍通过——证明后续拒绝来自变异而非管线噪声
    const identity = buildPkg(Buffer.from(codec.canonicalJsonBytes(manifest)), segments)
    const idVr = await client.validatePackage(client.wechatFileReader(putPkgToFsm(identity)))
    assert.ok(idVr.ok, `前置：空变异重建通过（problems=${JSON.stringify(idVr.problems.slice(0, 2))}）——crafting 管线自身不得引入噪声`)
    let segs = segments
    if (opts.mutateSegments) segs = opts.mutateSegments(manifest, segments.map(x => Buffer.from(x)))
    mutate(manifest)
    const crafted = buildPkg(Buffer.from(codec.canonicalJsonBytes(manifest)), segs)
    const vr = await client.validatePackage(client.wechatFileReader(putPkgToFsm(crafted)))
    console.log(`      [M4 诊断] problems 码=[${vr.problems.map(x => x.code).join(',')}]`)
    return vr
  }
  await scenario('M4a 同域重复记录 ID（正文+段哈希+声明全自洽，唯一异常=重复 ID）必须以专属码拒绝', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok)
    const bytes = Buffer.from(global.wx.getFileSystemManager().__files.get(r.flag.path))
    const vr = await craftAndValidate(client, bytes, () => {}, {
      mutateSegments: (m, segs) => {
        const fi = m.files.findIndex(f => f.kind === 'domain-json' && f.domain === 'daily')
        const body = JSON.parse(segs[fi].toString('utf8'))
        body[1].dateKey = body[0].dateKey // 正文重复 ID
        const newSeg = Buffer.from(codec.canonicalJsonBytes(body))
        m.files[fi].length = newSeg.length
        m.files[fi].sha256 = codec.sha256Hex(new Uint8Array(newSeg))
        m.records.daily[1].id = m.records.daily[0].id
        m.records.daily[1].hash = codec.recordHash(body[1])
        segs[fi] = newSeg
        return segs
      },
    })
    assert.ok(!vr.ok, `自洽重复 ID 必须拒绝（problems=${JSON.stringify(vr.problems.slice(0, 2))}）——重复 ID 是唯一异常：段哈希/长度/声明 hash/正文全部一致`)
    assert.ok(vr.problems.some(x => /duplicate/i.test(x.code) && /id/i.test(x.code)), `须有重复 ID 专属错误码（实得 [${vr.problems.map(x => x.code).join(',')}])——utils/mcpkg/container.js 无 duplicate-record-id 校验`)
  })
  await scenario('M4b 未知 file kind（改 domain-json 段避免 invalid-mapping 误伤）必须以 kind 专属码拒绝', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok)
    const bytes = Buffer.from(global.wx.getFileSystemManager().__files.get(r.flag.path))
    const vr = await craftAndValidate(client, bytes, m => { m.files.find(f => f.kind === 'domain-json').kind = 'mystery-kind' })
    assert.ok(!vr.ok, `未知 kind 必须拒绝（problems=${JSON.stringify(vr.problems.slice(0, 2))}）——container.js:116 仅按 kind 三元取上限，无 kind 枚举校验`)
    assert.ok(vr.problems.some(x => /kind/i.test(x.code)), `须有 kind 专属错误码（实得 [${vr.problems.map(x => x.code).join(',')}])——不得仅靠 invalid-mapping/invalid-domain 旁系原因拒绝`)
  })
  await scenario('M4c omitted 域携带 records 声明（自洽重算）必须拒绝', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok)
    const bytes = Buffer.from(global.wx.getFileSystemManager().__files.get(r.flag.path))
    const vr = await craftAndValidate(client, bytes, m => { m.records.mood = [{ index: 0, id: 'ghost', revision: 0, deleted: false, hash: m.records.daily[0].hash }] })
    assert.ok(!vr.ok && vr.problems.some(x => x.code === 'invalid-records'), `omitted 域携带 records 须以 invalid-records 拒绝（实得 [${vr.problems.map(x => x.code).join(',')}])`)
  })
  await scenario('M4d reports 映射 deleted/revision 与正文不一致（自洽重算）必须拒绝', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok)
    const bytes = Buffer.from(global.wx.getFileSystemManager().__files.get(r.flag.path))
    for (const [name, mut] of [
      ['deleted 翻真', m => { const e = m.reports.find(x => x.reportId === 'rpt-shared'); e.deleted = true; e.attachments = [] }],
      ['revision+1', m => { const e = m.reports.find(x => x.reportId === 'rpt-shared'); e.revision = (e.revision || 0) + 1 }],
    ]) {
      const vr = await craftAndValidate(client, bytes, mut)
      assert.ok(!vr.ok && vr.problems.some(x => /declaration-mismatch|report/.test(x.code)), `[${name}] reports 映射与正文不一致须以声明比对拒绝（实得 [${vr.problems.map(x => x.code).join(',')}])`)
    }
  })
  await scenario('M4e 附件幽灵反向引用（referencedBy 含不存在报告，自洽重算）必须拒绝', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok)
    const bytes = Buffer.from(global.wx.getFileSystemManager().__files.get(r.flag.path))
    const vr = await craftAndValidate(client, bytes, m => { m.files.find(f => f.kind === 'attachment').referencedBy.push('rpt-ghost') })
    assert.ok(!vr.ok && vr.problems.some(x => x.code === 'invalid-mapping'), `幽灵反向引用须以映射校验拒绝（实得 [${vr.problems.map(x => x.code).join(',')}])`)
  })
  await scenario('M4f pending.indeterminate=true 而 complete=true/full（自洽重算）必须拒绝', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok)
    const bytes = Buffer.from(global.wx.getFileSystemManager().__files.get(r.flag.path))
    const vr = await craftAndValidate(client, bytes, m => { m.pending.indeterminate = true })
    assert.ok(!vr.ok && vr.problems.some(x => x.code === 'incoherent-complete'), `indeterminate 而 complete 须以 incoherent-complete 拒绝（实得 [${vr.problems.map(x => x.code).join(',')}])`)
  })
  await scenario('M4g diagnostic 而 complete=true（自洽重算）必须拒绝', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok)
    const bytes = Buffer.from(global.wx.getFileSystemManager().__files.get(r.flag.path))
    const vr = await craftAndValidate(client, bytes, m => { m.packageKind = 'diagnostic' })
    assert.ok(!vr.ok && vr.problems.some(x => x.code === 'incoherent-kind'), `diagnostic+complete 须以 incoherent-kind 拒绝（实得 [${vr.problems.map(x => x.code).join(',')}])`)
  })
  await scenario('C10 真实管线墓碑：reports 领域 JSON 正文 attachments 为空且零原件下载（不止映射为空）', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    const dlBefore = dlSeq
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok)
    assert.equal(dlSeq - dlBefore, 4, '仅 4 个真实附件被下载（墓碑附件零下载）')
    const recs = await readDomainRecords(client, r.flag.path, 'reports')
    const tomb = recs.find(x => x.id === 'rpt-tomb')
    assert.ok(tomb, '领域正文含墓碑记录')
    assert.equal(tomb.deleted, true, '正文 deleted=true')
    assert.deepEqual(tomb.attachments, [], '领域正文墓碑 attachments 必须为空（不得携带原 fileId）')
  })

  await scenario('M5 报告附件映射 vs 领域正文比对（仅改 manifest 重规范化，字节/哈希/声明全有效）：删映射项/fileIndex 互换/多余 referencedBy 均须以映射专属码拒绝', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok)
    const bytes = Buffer.from(global.wx.getFileSystemManager().__files.get(r.flag.path))
    const cases = [
      ['删映射项（正文仍含）', m => {
        const e = m.reports.find(x => x.reportId === 'rpt-three-pages' && x.attachments.length >= 2)
        const removed = e.attachments.shift()
        const f = m.files[removed.fileIndex]
        f.referencedBy = f.referencedBy.filter(id => id !== 'rpt-three-pages')
        if (!f.referencedBy.length) { /* 空 referencedBy：如校验器要求附件必被引用会另触发——同属映射面 */ }
      }],
      ['同报告 order0↔order2 fileIndex 互换（referencedBy 不变）', m => {
        const e = m.reports.find(x => x.reportId === 'rpt-three-pages' && x.attachments.length >= 3)
        const a = e.attachments[0], c = e.attachments[2]
        const t = a.fileIndex; a.fileIndex = c.fileIndex; c.fileIndex = t
        // originalFileId 同步换（保持映射内部一致——正文与映射的错位是唯一异常）
        const ta = a.originalFileId; a.originalFileId = c.originalFileId; c.originalFileId = ta
      }],
      ['既有报告多余 referencedBy（无映射项）', m => {
        const e = m.reports.find(x => x.reportId === 'rpt-three-pages' && x.attachments.length >= 2)
        const f = m.files[e.attachments[0].fileIndex]
        if (!f.referencedBy.includes('rpt-shared')) f.referencedBy.push('rpt-shared') // rpt-shared 存在但其映射不含此 fileIndex
      }],
    ]
    for (const [name, mut] of cases) {
      const vr = await craftAndValidate(client, bytes, mut)
      assert.ok(!vr.ok, `[${name}] 映射与正文不一致必须拒绝（实得 problems=${JSON.stringify(vr.problems.map(x => x.code))}——正文 attachments 与 reports 映射无比对（utils/mcpkg/container.js），阶段二将凭映射恢复缺失/错误图片`)
      assert.ok(vr.problems.some(x => /mapping|report/i.test(x.code)), `[${name}] 须映射专属错误码（实得 [${vr.problems.map(x => x.code).join(',')}])`)
    }
  })

  await scenario('DF1 删除时 unlink 失败：标志与文件都必须保留可访问、无成功提示（兼容异步修复 API：断言终态不变量）', async () => {
    // 服务路径
    const { stack, client } = await freshExport()
    await client.confirmIdentity()
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok)
    const bytes1 = new Uint8Array(global.wx.getFileSystemManager().__files.get(r.flag.path))
    fsmFault.failUnlinkSuffix = '.mcpkg'
    const rr = await client.removePublishedRecord(r.batchId)
    for (let i = 0; i < 30; i++) await tick() // 兼容异步 unlink 的修复实现——等待终态
    fsmFault.failUnlinkSuffix = null
    const fAfter = global.wx.getFileSystemManager().__files.get(r.flag.path)
    assert.ok(fAfter && Buffer.from(fAfter).equals(Buffer.from(bytes1)), `文件删除失败时目标字节必须保留（实得 ${fAfter ? '字节已变' : '文件消失'}）`)
    const store = JSON.parse(storage.get([...storage.keys()].find(k => k.endsWith('mcpkg-published'))) || '{}')
    assert.ok(store[r.batchId], `删除失败时标志必须保留（如实——实得 store keys=${JSON.stringify(Object.keys(store))}）——removePublishedRecord 在异步 unlink 前即返回 ok 且吞掉失败（services/mcpkgExportService.js）`)
    assert.ok(rr.ok !== true || store[r.batchId], `不得在文件未删时宣称删除成功（rr.ok=${rr.ok}）`)
    // 页面路径（用户确认入口）——包字节搬运进新 FSM（沙箱持久语义）
    const bytesForPage = new Uint8Array(global.wx.getFileSystemManager().__files.get(r.flag.path))
    const stack2 = makeStack('mama', { clear: false })
    installWechatGlobal(stack2)
    global.wx.getFileSystemManager().__files.set(r.flag.path, bytesForPage)
    assert.ok(global.wx.getFileSystemManager().__files.get(r.flag.path), '前置：包字节已搬运至页面会话 FSM（避免夹具性缺失）')
    const page = loadClient(exportPageBundle)
    wire(page, stack2)
    await page.confirmIdentity()
    uniCalls.toasts.length = 0
    fsmFault.failUnlinkSuffix = '.mcpkg'
    await page.doRemove(r.batchId)
    for (let i = 0; i < 30; i++) await tick()
    fsmFault.failUnlinkSuffix = null
    assert.ok(!uniCalls.toasts.some(t => /已删除|删除成功/.test(String(t))), `unlink 失败不得显示成功 toast（实得 ${JSON.stringify(uniCalls.toasts.slice(-3))}）`)
    assert.ok(global.wx.getFileSystemManager().__files.get(r.flag.path), '页面路径：文件仍可访问')
    const store2 = JSON.parse(storage.get([...storage.keys()].find(k => k.endsWith('mcpkg-published'))) || '{}')
    assert.ok(store2[r.batchId], '页面路径：标志保留')
    void stack
  })
  await scenario('DF2 标志键持久写失败：无成功、标志保留可发现、marker-persist-failed/partial 如实；除障重试清除陈旧标志完成删除', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok)
    const path = r.flag.path
    storageFault.failSuffix = '_b1_mcpkg-published' // 标志存储写失败；unlink 放行（unlink-first 或 marker-first 均可——不要求跨 fs/存储原子性）
    const rr = await client.removePublishedRecord(r.batchId)
    for (let i = 0; i < 30; i++) await tick()
    storageFault.failSuffix = null
    // ① 无成功：标志未持久移除不得宣称全部删除完成
    assert.ok(rr.ok === false, `不得宣称删除成功（rr=${JSON.stringify(rr && { ok: rr.ok, code: rr.code })}）`)
    // ② 如实部分态：marker-persist-failed 或显式 partial
    assert.ok(/marker-persist-failed/.test(String(rr.code || '')) || rr.partial === true, `须以 marker-persist-failed/partial 如实报告（code=${rr.code} partial=${rr.partial}）`)
    // ③ 标志保留可发现（陈旧入口不静默消失）
    const store = JSON.parse(storage.get([...storage.keys()].find(k => k.endsWith('mcpkg-published'))) || '{}')
    assert.ok(store[r.batchId], `标志保留（可发现可重试；实得 keys=${JSON.stringify(Object.keys(store))}）`)
    // ④ 除障重试：清除陈旧标志并完成删除（终态收敛——文件按实际顺序被清理）
    const rr2 = await client.removePublishedRecord(r.batchId)
    for (let i = 0; i < 30; i++) await tick()
    const store2 = JSON.parse(storage.get([...storage.keys()].find(k => k.endsWith('mcpkg-published'))) || '{}')
    assert.ok(rr2.ok === true, `重试应完成清理（rr2=${JSON.stringify(rr2 && { ok: rr2.ok, code: rr2.code })}）`)
    assert.ok(!store2[r.batchId], `陈旧标志已清除（实得 keys=${JSON.stringify(Object.keys(store2))}）`)
    assert.ok(!global.wx.getFileSystemManager().__files.get(path), '文件已清理')
  })

  await scenario('DF3 unlink 后 stat 瞬时失败：不得宣称已删；标志恢复、如实 partial/unconfirmed', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok)
    global.wx.getFileSystemManager().__fault.failStatOnce = true // verifiedUnlink 的确认 stat 一次性失败
    const rr = await client.removePublishedRecord(r.batchId)
    for (let i = 0; i < 30; i++) await tick()
    assert.ok(rr.ok === false, `stat 瞬时不得宣称删除成功（rr=${JSON.stringify({ ok: rr.ok, code: rr.code })}）——verifiedUnlink 须区分瞬时 fs-error 与明确不存在（services/mcpkgExportService.js）`)
    const store = JSON.parse(storage.get([...storage.keys()].find(k => k.endsWith('mcpkg-published'))) || '{}')
    assert.ok(store[r.batchId], '未确认删除时标志须恢复保留（用户可见入口不丢）')
    assert.ok(/unconfirm|partial|transient|unlink/i.test(String(rr.code || '')), `如实报告未确认态（code=${rr.code}）`)
  })
  await scenario('DF3b wx/FSM 不可用：从未 unlink 不得返回已删/掉标志（fail-closed）', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok)
    const savedWx = global.wx
    delete global.wx
    let rr
    try { rr = await client.removePublishedRecord(r.batchId) } finally { global.wx = savedWx }
    for (let i = 0; i < 20; i++) await tick()
    assert.ok(rr.ok === false, `FSM 不可用从未删除不得宣称成功（rr=${JSON.stringify({ ok: rr.ok, code: rr.code })}）——verifiedUnlink 须 fail-closed（services/mcpkgExportService.js）`)
    const store = JSON.parse(storage.get([...storage.keys()].find(k => k.endsWith('mcpkg-published'))) || '{}')
    assert.ok(store[r.batchId], '标志恢复保留（文件仍在沙箱——列表入口不丢）')
    assert.ok(global.wx.getFileSystemManager().__files.get(r.flag.path), '文件实际仍在（从未 unlink）')
  })
  await scenario('DF4 unlink await 期间切 papa：mama store 不得写进 papa 键、papa 数据不被清、终态如实（精确字节核对）', async () => {
    const { stack, client } = await freshExport()
    await client.confirmIdentity()
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok)
    const mamaKey = [...storage.keys()].find(k => k.endsWith('mama_b1_mcpkg-published'))
    const papaKey = mamaKey.replace('mama_b1_', 'papa_b1_')
    const papaRaw = JSON.stringify({ papa_own: { batchId: 'papa_own', path: 'wxfile://usr/x.mcpkg', packageDigest: 'd', envId: 'env-b3b1', appId: 'wxapp-b1', familyId: TEST_ENV.MC_FAMILY_ID, memberId: 'papa', publishedAt: 1 } })
    storage.set(papaKey, papaRaw) // papa 既有已发布数据——精确字节基线
    uniCalls.switchOnUnlink = {
      fired: false,
      switch: async () => {
        stack.curMember.value = 'papa'
        stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
        await client.endSession()
        await client.confirmIdentity()
      },
    }
    const rr = await client.removePublishedRecord(r.batchId)
    uniCalls.switchOnUnlink = null
    for (let i = 0; i < 30; i++) await tick()
    // ① papa 命名空间精确字节不变（mama store 不得写入 papa 键；papa 数据不得被清/改）
    assert.equal(storage.get(papaKey), papaRaw, `papa PUBLISHED_KEY 必须逐字节原样（实得 ${JSON.stringify(storage.get(papaKey) || null).slice(0, 120)}）——切换后的 setMemberCache 落在新成员命名空间（services/mcpkgExportService.js removePublishedRecord 作用域守卫）`)
    const mamaStore = JSON.parse(storage.get(mamaKey) || '{}')
    const fileGone = !global.wx.getFileSystemManager().__files.get(r.flag.path)
    if (rr.ok === true) {
      // 宣称完整成功：必须文件确已删除且 mama 标志确已移除（诚实完整态）
      assert.ok(fileGone, 'ok=true 须文件确已删除')
      assert.ok(!mamaStore[r.batchId], 'ok=true 须 mama 标志已移除（切换前持久完成）')
    } else {
      // partial/失败：如实且 mama 侧不丢可见入口（标志在或部分态有说明）
      assert.ok(/stale|partial/i.test(String(rr.code || '')), `切换期间删除须如实 partial（code=${rr.code}）`)
    }
    assert.ok(!storage.has(mamaKey.replace('mama_b1_mcpkg-published', 'papa_b1_mcpkg-published') + '_mirror'), '无镜像键（占位不变式）')
  })

  await scenario('DG1 marker-first P0 孤儿窗口：标志移除写成功→unlink 失败→恢复写失败→重启后字节在而标志缺=不可达孤儿（含标志写后崩溃同终态）', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok)
    const bytes1 = new Uint8Array(global.wx.getFileSystemManager().__files.get(r.flag.path))
    // 双故障窗口：published 键第 1 次写（移除）放行、第 2 次写（恢复）失败；unlink 失败
    storageFault.pubWritesAllowed = 1
    fsmFault.failUnlinkSuffix = '.mcpkg'
    const rr = await client.removePublishedRecord(r.batchId)
    for (let i = 0; i < 30; i++) await tick()
    storageFault.pubWritesAllowed = null; fsmFault.failUnlinkSuffix = null
    assert.ok(rr.ok === false, `前置：删除失败如实（rr=${JSON.stringify(rr && { ok: rr.ok, code: rr.code })}）`)
    // 重启（同存储+同 FSM 字节）：不变量析取——绝不不可达孤儿
    const stack2 = makeStack('mama', { clear: false })
    installWechatGlobal(stack2)
    global.wx.getFileSystemManager().__files.set(r.flag.path, bytes1)
    const client2 = loadClient(serviceBundle)
    wire(client2, stack2)
    await client2.confirmIdentity()
    const fileThere = global.wx.getFileSystemManager().__files.get(r.flag.path)
    if (fileThere) {
      // 路径A：文件在 → 标志必须可发现（列表可见或恢复机制认领），且除障重试可用并收敛
      let adopted = null
      try { adopted = await client2.recoverInterruptedExport() } catch (e) { adopted = null }
      const discoverable = client2.listPublished().some(f => f.path === r.flag.path) || (adopted && adopted.path === r.flag.path)
      assert.ok(discoverable, `文件仍在时必须可发现/可认领（listPublished 无此路径且 recoverInterruptedExport 未认领）——删除中断孤儿不可达（services/mcpkgExportService.js removePublishedRecord——修复方向：删除意图持久化或孤儿重扫）`)
      const rr2 = await client2.removePublishedRecord(r.batchId)
      for (let i = 0; i < 30; i++) await tick()
      const st2 = JSON.parse(storage.get([...storage.keys()].find(k => k.endsWith('mcpkg-published'))) || '{}')
      assert.ok(rr2.ok === true && !st2[r.batchId] && !global.wx.getFileSystemManager().__files.get(r.flag.path), `路径A：除障重试须收敛（rr2=${JSON.stringify(rr2 && { ok: rr2.ok, code: rr2.code })}；标志=${Boolean(st2[r.batchId])}；文件=${Boolean(global.wx.getFileSystemManager().__files.get(r.flag.path))}）`)
    } else {
      // 路径B：文件已删 → 残留标志可被清除（重试收敛）
      const rr2 = await client2.removePublishedRecord(r.batchId)
      for (let i = 0; i < 30; i++) await tick()
      const st2 = JSON.parse(storage.get([...storage.keys()].find(k => k.endsWith('mcpkg-published'))) || '{}')
      assert.ok(rr2.ok === true && !st2[r.batchId], `路径B：残留标志须可清除（rr2=${JSON.stringify(rr2 && { ok: rr2.ok, code: rr2.code })}；标志=${Boolean(st2[r.batchId])}）`)
    }
  })
  await scenario('DG2 修订 unlink-first 契约：先删文件+标志写失败=partial 原标志保留；重试文件已缺席经 stat 确认清除标志；瞬时 stat/FSM 缺席不假成功', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok)
    const path = r.flag.path
    // ① unlink 放行（先删文件）；标志写失败
    storageFault.failSuffix = '_b1_mcpkg-published'
    const rr = await client.removePublishedRecord(r.batchId)
    for (let i = 0; i < 30; i++) await tick()
    storageFault.failSuffix = null
    assert.ok(rr.ok === false, `① 标志写失败不得成功（rr.code=${rr.code}）`)
    assert.ok(/marker-persist-failed/.test(String(rr.code || '')) || rr.partial === true, `① 如实 partial（code=${rr.code} partial=${rr.partial}）`)
    const store1 = JSON.parse(storage.get([...storage.keys()].find(k => k.endsWith('mcpkg-published'))) || '{}')
    assert.ok(store1[r.batchId], '① 原标志保留（可发现可重试）')
    assert.ok(!global.wx.getFileSystemManager().__files.get(path), '① 文件已删（unlink-first）')
    // ② 重试（故障已除）：文件已缺席——须经 stat"no such file"确认后清除标志成功
    const rr2 = await client.removePublishedRecord(r.batchId)
    assert.ok(rr2.ok === true, `② 文件已缺席重试须确认删除并清标志（实得 ${JSON.stringify(rr2)}）——verifiedUnlink 对已缺席文件不可因 unlink 失败而永久 unlink-failed（services/mcpkgExportService.js）`)
    const store2 = JSON.parse(storage.get([...storage.keys()].find(k => k.endsWith('mcpkg-published'))) || '{}')
    assert.ok(!store2[r.batchId], '② 陈旧标志已清除')
    // ③ 瞬时 stat：重试不得假成功（独立子夹具：标志在+文件已缺席）
    {
      const f3 = await freshExport()
      await f3.client.confirmIdentity()
      const r3 = await f3.client.buildAndPublishPackage({})
      assert.ok(r3.ok)
      global.wx.getFileSystemManager().__files.delete(r3.flag.path) // 文件已缺席（如先前 unlink 已成功而标志写失败后经其他途径恢复）
      global.wx.getFileSystemManager().__fault.failStatOnce = true
      const rr3 = await f3.client.removePublishedRecord(r3.batchId)
      for (let i = 0; i < 20; i++) await tick()
      assert.ok(rr3.ok === false, `③ 瞬时 stat 不得假成功（rr3=${JSON.stringify(rr3 && { ok: rr3.ok, code: rr3.code })}）`)
      const st3 = JSON.parse(storage.get([...storage.keys()].find(k => k.endsWith('mcpkg-published'))) || '{}')
      assert.ok(st3[r3.batchId] || rr3.code !== 'ok', '③ 未确认时标志可发现（保留或如实部分态）')
      // 干净重试：stat no such file → 确认 → 清标志成功
      const rr3b = await f3.client.removePublishedRecord(r3.batchId)
      for (let i = 0; i < 20; i++) await tick()
      const st3b = JSON.parse(storage.get([...storage.keys()].find(k => k.endsWith('mcpkg-published'))) || '{}')
      assert.ok(rr3b.ok === true && !st3b[r3.batchId], `③b 干净重试须确认缺席并清标志（rr3b=${JSON.stringify(rr3b && { ok: rr3b.ok, code: rr3b.code })}；标志=${Boolean(st3b[r3.batchId])}）`)
    }
    // ④ FSM 缺席：fail-closed 不假成功；恢复后重试成功
    {
      const f4 = await freshExport()
      await f4.client.confirmIdentity()
      const r4 = await f4.client.buildAndPublishPackage({})
      assert.ok(r4.ok)
      global.wx.getFileSystemManager().__files.delete(r4.flag.path)
      const savedWx = global.wx
      delete global.wx
      let rr4
      try { rr4 = await f4.client.removePublishedRecord(r4.batchId) } finally { global.wx = savedWx }
      for (let i = 0; i < 20; i++) await tick()
      assert.ok(rr4.ok === false, `④ FSM 不可用不得假成功（rr4=${JSON.stringify(rr4 && { ok: rr4.ok, code: rr4.code })}）`)
      const rr4b = await f4.client.removePublishedRecord(r4.batchId)
      for (let i = 0; i < 20; i++) await tick()
      const st4 = JSON.parse(storage.get([...storage.keys()].find(k => k.endsWith('mcpkg-published'))) || '{}')
      assert.ok(rr4b.ok === true && !st4[r4.batchId], `④b 恢复后重试清标志成功（rr4b=${JSON.stringify(rr4b && { ok: rr4b.ok })}；标志=${Boolean(st4[r4.batchId])}）`)
    }
  })

  await scenario('DG5 unlink 确认后 published 存储读取损坏（无效 JSON/数组形状）：marker-read-failed partial、原始字节不覆写、第二条目不抹、无成功', async () => {
    for (const variant of ['corrupt-json', 'array-shape']) {
      const { stack, client } = await freshExport()
      await client.confirmIdentity()
      const r = await client.buildAndPublishPackage({})
      assert.ok(r.ok)
      const path = r.flag.path
      const pubKey = [...storage.keys()].find(k => k.endsWith('mcpkg-published'))
      // 同命名空间预种第二标志（真实形状）
      const store = JSON.parse(storage.get(pubKey))
      store['exp_second_entry'] = { batchId: 'exp_second_entry', path: 'wxfile://usr/MomCareExport/second.mcpkg', packageDigest: 'd2', envId: 'env-b3b1', appId: 'wxapp-b3b1', familyId: TEST_ENV.MC_FAMILY_ID, memberId: 'mama', publishedAt: 2 }
      storage.set(pubKey, JSON.stringify(store))
      // 在 awaited unlink 回调边界注入读取损坏
      const bad = variant === 'corrupt-json' ? '{CORRUPT_PUBLISHED' : '[1,2,3]'
      uniCalls.switchOnUnlink = {
        fired: false,
        switch: async () => { storage.set(pubKey, bad) }, // unlink 在途时存储被腐蚀（无身份切换）
      }
      const rr = await client.removePublishedRecord(r.batchId)
      uniCalls.switchOnUnlink = null
      for (let i = 0; i < 30; i++) await tick()
      assert.ok(rr.ok === false, `[${variant}] 存储不可读不得成功（rr=${JSON.stringify(rr && { ok: rr.ok, code: rr.code })}）`)
      assert.ok(/marker-read-failed|corrupt|read-failed/i.test(String(rr.code || '')) || rr.partial === true, `[${variant}] 须 marker-read-failed/partial 如实（code=${rr.code} partial=${rr.partial}）——数组形状同样不可当空处理（静默 no-published=假阴性）`)
      assert.equal(storage.get(pubKey), bad, `[${variant}] 原始腐蚀字节必须逐字节保留（不得覆写为 {} 或修复版——否则第二标志被抹、不可恢复）`)
      assert.ok(!global.wx.getFileSystemManager().__files.get(path), `[${variant}] unlink 确认删除的事实保持（文件确已删除）`)
      void stack
    }
  })

  // ══ D. H5 ══
  await scenario('D1 H5 File.slice 本地验包：与微信同一包字节同摘要（manifestDigest/packageDigest 相等）', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok)
    const bytes = Buffer.from(global.wx.getFileSystemManager().__files.get(r.flag.path))
    const wxVr = await client.validatePackage(client.wechatFileReader(r.flag.path))
    const fileObj = new File([bytes], 'backup.mcpkg', { type: 'application/octet-stream' })
    const h5Vr = await client.validatePackage(client.h5FileReader(fileObj))
    assert.ok(h5Vr.ok, `H5 校验通过: ${JSON.stringify(h5Vr.problems)}`)
    assert.equal(h5Vr.manifestDigest, wxVr.manifestDigest, '两适配器 manifestDigest 一致')
    assert.equal(h5Vr.packageDigest, wxVr.packageDigest, '两适配器 packageDigest 一一致')
  })
  await scenario('D2 H5 路径两层 UTF-8：含 ED A0 80 字节的包拒绝（ContainerError malformed-utf8）', async () => {
    const { client } = await freshExport()
    await client.confirmIdentity()
    const r = await client.buildAndPublishPackage({})
    assert.ok(r.ok)
    const bytes = Buffer.from(global.wx.getFileSystemManager().__files.get(r.flag.path))
    // 篡改 manifest 区域末尾一个字节为 ED（构造非法起始序列——validatePackage 的 decodeStrict 应拒）
    bytes[24] = 0xed; bytes[25] = 0xa0; bytes[26] = 0x80
    let err = null
    try { await client.validatePackage(client.h5FileReader(new File([bytes], 'x.mcpkg'))) } catch (e) { err = e }
    assert.ok(err, '必须抛错')
    assert.ok(err.code === 'malformed-utf8' || /malformed|utf/i.test(err.message), `错误指向 UTF-8: ${err.code} ${err.message}`)
  })
  await scenario('D3 无微信能力（H5 环境）：导出服务如实 platform-unsupported，零云调用', async () => {
    const { stack, client } = await freshExport()
    await client.confirmIdentity()
    const callsBefore = stack.cloud.__state.calls.length
    const savedWx = global.wx
    delete global.wx
    const r = await client.buildAndPublishPackage({})
    global.wx = savedWx
    assert.ok(!r.ok && r.code === 'platform-unsupported', `H5 导出如实不可用: ${r.code}（文案: ${r.message}）`)
    assert.equal(stack.cloud.__state.calls.length - callsBefore, 0, '零云调用')
  })
  await scenario('D4 平台隔离：微信导出链源码零 DOM/Blob 引用（加载期不触碰）', async () => {
    const src = fs.readFileSync(path.join(root, 'utils/mcpkg/adapter-wechat.js'), 'utf8') + fs.readFileSync(path.join(root, 'services/mcpkgExportService.js'), 'utf8')
    assert.ok(!/\bBlob\b|\bdocument\b|\bwindow\b/.test(src), '微信适配器/导出服务不含 DOM/Blob 引用')
  })

  // ══ E. 页面接线 ══
  await scenario('S1 导出中切身份：新身份可立即开始导出；陈旧导出不得钉死 building、不得污染新身份状态', async () => {
    const stack = makeStack('mama')
    installWechatGlobal(stack)
    const page = loadClient(exportPageBundle)
    wire(page, stack)
    await seedFamilyData(stack)
    await page.confirmIdentity()
    // mama 的首次导出变慢（每次云调用延迟 60ms），papa 不延迟
    let slowFor = TEST_ENV.MC_MEMBER_MAMA_OPENID
    for (const name of Object.keys(stack.routes)) {
      const real = stack.routes[name]
      stack.routes[name] = async e => {
        if (stack.cloud.__state.caller === slowFor) await new Promise(rs => setTimeout(rs, 60))
        return real(e)
      }
    }
    // 门控：mama 首个云调用与 papa 第二次导出的云调用分别可扣/放——时序完全确定
    let mamaGate = { resolve: null, promise: null }
    mamaGate.promise = new Promise(r => { mamaGate.resolve = r })
    let papa2Gate = { resolve: null, promise: null }
    papa2Gate.promise = new Promise(r => { papa2Gate.resolve = r })
    let mamaHeld = false, papa2Held = false
    const withFailsafe = (gate, tag) => Promise.race([gate.promise, new Promise(r => setTimeout(r, 8000, tag))])
    for (const name of ['mc-health', 'mc-schedule', 'mc-reports', 'mc-files']) {
      const real = stack.routes[name]
      stack.routes[name] = async e => {
        const caller = stack.cloud.__state.caller
        if (caller === TEST_ENV.MC_MEMBER_MAMA_OPENID && !mamaHeld) { mamaHeld = true; await withFailsafe(mamaGate, 'mama') }
        else if (caller === TEST_ENV.MC_MEMBER_PAPA_OPENID && papa2Held) await withFailsafe(papa2Gate, 'papa2')
        return real(e)
      }
    }
    const staleExport = page.doExport()
    for (let i = 0; i < 100 && (!page.building.value || !mamaHeld); i++) await tick()
    assert.ok(page.building.value && mamaHeld, '前置：mama 导出在途且首个云调用被扣（building=true）')
    // 切换 papa
    stack.curMember.value = 'papa'
    stack.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
    await page.endSession()
    await page.confirmIdentity()
    await page.doExport() // papa 第一次导出（不受门控）
    for (let i = 0; i < 200 && !/已发布|失败/.test(page.stateText.value); i++) await tick()
    assert.ok(/已发布/.test(page.stateText.value), `新身份 papa 须能立即开始并完成自己的导出（实得 "${page.stateText.value}"）——页面 building 被陈旧导出钉死则拒绝新导出（pages/profile/data-export.vue doExport 的 building 早退门）`)
    const papaDone = page.stateText.value
    // papa 第二次导出：扣住其云调用使其在途（building=true）
    papa2Held = true
    const papa2 = page.doExport()
    for (let i = 0; i < 100 && !page.building.value; i++) await tick()
    assert.ok(page.building.value, '前置：papa 第二次导出在途（building=true）')
    // 此时放行 mama 的陈旧导出——其 finally 若无身份/epoch 绑定将把 building 清成 false
    mamaGate.resolve()
    await staleExport
    for (let i = 0; i < 30; i++) await tick()
    assert.equal(page.building.value, true, '陈旧（mama）导出的迟到 finally 不得清除新身份（papa）在途导出的 building——building 须绑定发起作用域')
    papa2Gate.resolve()
    await papa2
    for (let i = 0; i < 50 && page.building.value; i++) await tick()
    assert.equal(page.building.value, false, 'papa 自身导出完成后 building 复位')
    assert.ok(/已发布/.test(page.stateText.value), `陈旧导出的迟到落定不得污染新身份状态（papa 完成后="${papaDone}"，最终="${page.stateText.value}"）`)
  })

  await scenario('E1 data-export 页真实 handler：完整包发布→状态文案/publishedList→分享 delivered', async () => {
    const stack = makeStack('mama')
    installWechatGlobal(stack)
    const page = loadClient(exportPageBundle)
    wire(page, stack)
    await seedFamilyData(stack)
    await page.confirmIdentity()
    await page.doExport()
    await tick(); await tick()
    assert.ok(page.stateText.value.includes('已发布'), `状态: ${page.stateText.value}`)
    assert.ok(page.stateText.value.includes('完整包'), `完整包文案: ${page.stateText.value}`)
    assert.equal(page.publishedList.value.length, 1, 'publishedList 1 条')
    const batchId = page.publishedList.value[0].batchId
    await page.doShare(batchId)
    await tick()
    assert.ok(uniCalls.shareCalls.length >= 1, '分享请求已发起（用户动作路径）')
    const key = [...storage.keys()].find(k => k.endsWith('mcpkg-published'))
    assert.ok(JSON.parse(storage.get(key))[batchId].deliveredAt, '页路径 deliveredAt')
  })
  await scenario('E2 data-export 页诊断包文案如实（不完整·不可用于恢复）', async () => {
    const stack = makeStack('mama')
    installWechatGlobal(stack)
    const page = loadClient(exportPageBundle)
    wire(page, stack)
    await seedFamilyData(stack)
    await page.confirmIdentity()
    storage.set('mc_cache_env-b3b1_wxapp-b3b1_mama_b1_b3-migration', JSON.stringify({ batchId: 'mig-open2', status: 'confirmed' }))
    await page.doExport()
    await tick(); await tick()
    assert.ok(page.stateText.value.includes('诊断包'), `诊断包文案: ${page.stateText.value}`)
    assert.ok(page.stateText.value.includes('不可用于恢复'), '显著标注不可恢复')
  })
  await scenario('E3 data-export 页 H5（无微信能力）：如实失败并提示微信端', async () => {
    const stack = makeStack('mama')
    installWechatGlobal(stack)
    const page = loadClient(exportPageBundle)
    wire(page, stack)
    await seedFamilyData(stack)
    await page.confirmIdentity()
    const savedWx = global.wx
    delete global.wx
    try { await page.doExport() } finally { global.wx = savedWx }
    await tick()
    assert.ok(page.stateText.value.includes('platform-unsupported'), `H5 状态: ${page.stateText.value}`)
    assert.ok(uniCalls.toasts.some(t => String(t).includes('微信小程序端')), `提示含微信端说明: ${JSON.stringify(uniCalls.toasts.slice(-2))}`)
  })
  await scenario('F1 data-restore 页（微信）：chooseMessageFile 选已发布包 → 校验通过+完整包文案', async () => {
    const svcStack = makeStack('mama')
    installWechatGlobal(svcStack)
    const svc = loadClient(serviceBundle)
    wire(svc, svcStack)
    await seedFamilyData(svcStack)
    await svc.confirmIdentity()
    const r = await svc.buildAndPublishPackage({})
    assert.ok(r.ok)
    const pkgBytes = new Uint8Array(svcStack && global.wx.getFileSystemManager().__files.get(r.flag.path))
    const stack = makeStack('mama')
    installWechatGlobal(stack)
    global.wx.getFileSystemManager().__files.set(r.flag.path, pkgBytes) // 用户"从聊天选到"同一文件
    const page = loadClient(restorePageBundle)
    wire(page, stack)
    await page.confirmIdentity()
    uniCalls.chooseMessageFilePath = r.flag.path
    await page.pickFile()
    for (let i = 0; i < 40 && !page.result.value; i++) await tick()
    assert.ok(page.result.value, '校验结果已出')
    assert.ok(page.result.value.ok, `包校验通过: ${JSON.stringify((page.result.value.problems || []).slice(0, 3))}`)
    assert.equal(page.kindText.value, '完整包', `文案: ${page.kindText.value}`)
  })
  await scenario('F2 data-restore 页：损坏包 → 校验未通过如实呈现', async () => {
    const svcStack = makeStack('mama')
    installWechatGlobal(svcStack)
    const svc = loadClient(serviceBundle)
    wire(svc, svcStack)
    await seedFamilyData(svcStack)
    await svc.confirmIdentity()
    const r = await svc.buildAndPublishPackage({})
    assert.ok(r.ok)
    const pkgBytes = new Uint8Array(global.wx.getFileSystemManager().__files.get(r.flag.path))
    pkgBytes[pkgBytes.length - 1] ^= 0xff
    const stack = makeStack('mama')
    installWechatGlobal(stack)
    global.wx.getFileSystemManager().__files.set(r.flag.path, pkgBytes)
    const page = loadClient(restorePageBundle)
    wire(page, stack)
    await page.confirmIdentity()
    uniCalls.chooseMessageFilePath = r.flag.path
    await page.pickFile()
    for (let i = 0; i < 40 && !page.result.value; i++) await tick()
    assert.ok(page.result.value && page.result.value.ok === false, '损坏包校验不通过')
    assert.ok(uniCalls.toasts.some(t => String(t).includes('校验')), '用户可见校验反馈')
  })
  await scenario('G privacy 三入口接线（导出/本地验包导航存在）', async () => {
    const src = fs.readFileSync(path.join(root, 'pages/profile/privacy.vue'), 'utf8')
    assert.ok(src.includes('/pages/profile/data-export'), '导出入口')
    assert.ok(src.includes('/pages/profile/data-restore'), '本地验包入口')
  })

  console.log(`\n${passed} 通过, ${failed.length} 失败`)
  if (failed.length) { console.log('失败项：\n - ' + failed.join('\n - ')); process.exit(1) }
}

const watchdog = setTimeout(() => { console.error('WATCHDOG: 套件挂起未终态（存在未决 await 且无定时器推进）——判定为假绿风险，exit 2'); process.exit(2) }, 300000)
watchdog.unref?.()
main().then(() => clearTimeout(watchdog)).catch(e => { clearTimeout(watchdog); console.error(e); process.exit(1) })
