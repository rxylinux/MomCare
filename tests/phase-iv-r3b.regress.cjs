// 独立验证 IV-R3b（2026-10-01 第二轮，按 INDEPENDENT_REVIEW_NOTES R3 缺口补全）：
// 1) 无全局 Buffer 环境下**完整导出链**（真实 buildAndPublishPackage → validatePackage →
//    目标包字节解码）：合法多字节 AI 报告逐字段往返。
// 2) 同一夹具：>100 条更晚云端记录 + 更旧本地 pending —— pull 后 pending/队列保留、
//    落盘截断不失 pending，冷恢复复原，再 pull 仍不顶替；真实宫缩页面消费
//    未完成列表与 待同步/冲突 两态标签。
// 3) 病态分页响应（hasMore 无游标 / hasMore=false 带游标 / 游标不前进）→ 受控失败、
//    本地历史零部分写入。
// 生产源码只读；本文件为验证会话新增测试。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-iv3b-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }
const tick = () => new Promise(r => setTimeout(r, 10))

require('node:child_process').execFileSync('node', [path.join(root, 'cloud/assemble.mjs')], { stdio: 'pipe' })
const DIST = path.join(root, 'dist/cloud-functions')
const healthH = require(path.join(DIST, 'mc-health/index.js'))
const scheduleH = require(path.join(DIST, 'mc-schedule/index.js'))
const reportsH = require(path.join(DIST, 'mc-reports/index.js'))
const filesH = require(path.join(DIST, 'mc-files/index.js'))
const identityH = require(path.join(DIST, 'mc-identity/index.js'))
const toolsH = require(path.join(DIST, 'mc-tools/index.js'))

const TEST_ENV = { MC_APPID: 'wxivapp00000013', MC_FAMILY_ID: 'fam-iv3b', MC_MEMBER_MAMA_OPENID: 'oIV3BMAMA000001', MC_MEMBER_PAPA_OPENID: 'oIV3BPAPA000001' }
const storage = new Map()
let dlSeq = 0
let harnessCloud = null
let fsmFiles = null

function makePng(idx) {
  const zlib = require('node:zlib')
  const raw = Buffer.from([0, (idx * 17 + 9) % 256, (idx * 53 + 11) % 256, (idx * 101 + 150) % 256])
  const idat = zlib.deflateSync(raw)
  const crcTable = []
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0 }
  const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
    return Buffer.concat([Buffer.from([0, 0, 0, data.length]), body, crc])
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

function installUni() {
  global.uni = {
    getStorageSync(k) { return storage.has(k) ? storage.get(k) : '' },
    setStorageSync(k, v) { storage.set(k, v) },
    removeStorageSync(k) { storage.delete(k) },
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
    showToast: () => {}, showModal: o => (o && o.success ? o.success({ confirm: true }) : undefined),
    showLoading() {}, hideLoading() {},
    redirectTo() {}, navigateTo: () => {}, switchTab() {}, reLaunch() {}, navigateBack() {},
    request: () => {}, uploadFile: () => {},
    downloadFile: o => {
      const url = String(o.url || '')
      const fid = url.startsWith('https://t.i/') ? url.slice('https://t.i/'.length) : url
      const key = String(fid).replace(/^cloud:\/\/[^/]+\//, '')
      const bytes = harnessCloud && harnessCloud.__stored.get(key)
      if (!bytes) { o.fail && o.fail({ errMsg: 'downloadFile:fail 404' }); return }
      const p = 'wxfile://tmp-dl-' + (++dlSeq)
      if (fsmFiles) fsmFiles.set(p, new Uint8Array(bytes))
      o.success && o.success({ tempFilePath: p, statusCode: 200 })
    },
  }
}

function makeFSM() {
  const files = new Map()
  const u8 = d => typeof d === 'string' ? new Uint8Array(Buffer.from(d, 'utf8')) : new Uint8Array(d)
  return () => ({
    writeFile(o) { files.set(o.filePath, u8(o.data)); o.success && o.success({}) },
    appendFile(o) { const add = u8(o.data), prev = files.get(o.filePath) || new Uint8Array(0); const next = new Uint8Array(prev.length + add.length); next.set(prev); next.set(add, prev.length); files.set(o.filePath, next); o.success && o.success({}) },
    readFile(o) { const f = files.get(o.filePath); if (!f) { o.fail && o.fail({ errMsg: 'readFile:fail' }); return } const pos = o.position == null ? 0 : o.position; const len = o.length == null ? f.length - pos : Math.min(o.length, f.length - pos); o.success && o.success({ data: f.slice(pos, pos + len).buffer }) },
    stat(o) { const f = files.get(o.path); if (!f) { o.fail && o.fail({ errMsg: 'stat:fail' }); return } o.success && o.success({ stats: { size: f.length } }) },
    rename(o) { const f = files.get(o.oldPath); if (!f) { o.fail && o.fail({ errMsg: 'rename:fail' }); return } files.set(o.newPath, f); files.delete(o.oldPath); o.success && o.success({}) },
    copyFile(o) { const f = files.get(o.srcPath); if (!f) { o.fail && o.fail({ errMsg: 'copyFile:fail' }); return } files.set(o.destPath, f); o.success && o.success({}) },
    mkdir(o) { o.success && o.success({}) }, rmdir(o) { o.success && o.success({}) },
    unlink(o) { files.delete(o.filePath); o.success && o.success({}) },
    access(o) { o.success && o.success({}) },
    __files: files,
  })
}

function makeMockCloud() {
  const docs = new Map(), storedFiles = new Map()
  const state = { caller: TEST_ENV.MC_MEMBER_MAMA_OPENID, initialized: false, ocrCalls: [] }
  const clone = x => JSON.parse(JSON.stringify(x))
  function docApi(col, id, tx) {
    return {
      get: async () => { const e = docs.get(`${col}/${id}`); if (tx) tx.reads.set(`${col}/${id}`, e ? e.__v : 0); return { data: e ? { ...clone(e), _id: id } : null } },
      set: async ({ data }) => { if (tx) { tx.writes.set(`${col}/${id}`, clone(data)); return { _id: id } } const prev = docs.get(`${col}/${id}`); docs.set(`${col}/${id}`, { ...clone(data), __v: (prev ? prev.__v : 0) + 1 }); return { _id: id } },
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
    command: { lt: v => ({ __op: 'lt', v }), gt: v => ({ __op: 'gt', v }) },
    startTransaction: async () => {
      const tx = { reads: new Map(), writes: new Map() }
      return { collection: c => ({ doc: id => docApi(c, id, tx) }), commit: async () => { for (const [k, d2] of tx.writes) { const prev = docs.get(k); docs.set(k, { ...d2, __v: (prev ? prev.__v : 0) + 1 }) } }, rollback: async () => { tx.writes.clear() } }
    },
    collection: c => ({ doc: id => docApi(c, id, null), where: f => makeQuery(c, f) })
  }
  return {
    DYNAMIC_CURRENT_ENV: Symbol('env'), init() { state.initialized = true },
    getWXContext() { return { APPID: TEST_ENV.MC_APPID, OPENID: state.caller } },
    database() { if (!state.initialized) throw new Error('init first'); return db },
    downloadFile: async ({ fileID }) => { const k = String(fileID).replace(/^cloud:\/\/[^/]+\//, ''); const b = storedFiles.get(k); if (!b) throw new Error('dl'); return { fileContent: Buffer.from(b) } },
    uploadFile: async ({ cloudPath, fileContent }) => { storedFiles.set(cloudPath, Buffer.from(fileContent)); return { fileID: `cloud://e.b/${cloudPath}` } },
    getTempFileURL: async ({ fileList }) => ({ fileList: fileList.map(f => ({ fileID: f, tempFileURL: 'https://t.i/' + f })) }),
    openapi: { ocr: { printedText: async p => { state.ocrCalls.push(p); return { errCode: 0, words_result: [{ words: '肱骨长 5.9cm' }] } } } },
    __docs: docs, __stored: storedFiles, __state: state, __setCtx(o) { state.caller = o },
  }
}

function makeStack(member = 'mama') {
  for (const k of [...storage.keys()]) { if (k.startsWith('mc_') || k.startsWith('YUNTU_') || k.startsWith('MOMCARE_')) storage.delete(k) }
  const cloud = makeMockCloud()
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID
  process.env.MC_UPLOAD_ENABLED = 'true'
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.MC_OCR_PROVIDER
  delete process.env.MC_REPORT_VISION
  cloud.__setCtx(member === 'mama' ? TEST_ENV.MC_MEMBER_MAMA_OPENID : TEST_ENV.MC_MEMBER_PAPA_OPENID)
  healthH.__setCloud(cloud); scheduleH.__setCloud(cloud); reportsH.__setCloud(cloud); filesH.__setCloud(cloud); identityH.__setCloud(cloud); toolsH.__setCloud(cloud)
  const curMember = { value: member }
  const routes = {
    'mc-health': e => healthH.main(e),
    'mc-schedule': e => scheduleH.main(e),
    'mc-reports': e => reportsH.main(e),
    'mc-files': e => filesH.main(e),
    'mc-tools': e => toolsH.main(e),
    'mc-identity': () => ({ ok: true, data: { memberId: curMember.value, displayName: curMember.value === 'mama' ? '妈妈' : '爸爸', familyId: process.env.MC_FAMILY_ID } }),
  }
  const wxCloud = {
    init() {},
    callFunction(o) { const h = routes[o.name]; if (!h) { o.fail({ errMsg: 'no route' }); return } Promise.resolve().then(() => h(o.data)).then(r => o.success({ result: r })).catch(e => o.fail({ errMsg: e.message })) },
  }
  return { cloud, wxCloud, routes, curMember }
}

function installWechatGlobal(stack) {
  const fsm = makeFSM()()
  fsmFiles = fsm.__files
  harnessCloud = stack.cloud
  global.wx = {
    cloud: stack.wxCloud,
    getFileSystemManager: () => fsm,
    shareFileMessage: o => { o.success && o.success({ errMsg: 'shareFileMessage:ok' }) },
    chooseMessageFile: o => o.fail && o.fail({ errMsg: 'cancel' }),
    env: { USER_DATA_PATH: 'wxfile://usr' },
  }
  return fsm
}

function buildBundle(contents, outfile) {
  esbuild.buildSync({ stdin: { contents, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile, logLevel: 'silent' })
}
const serviceBundle = path.join(temp, 'svc.cjs')
buildBundle(`export * from '@/services/mcpkgExportService.js';
export * from '@/utils/mcpkg/utf8.js';
export * from '@/utils/mcpkg/canonical.js';
export * from '@/utils/mcpkg/sha256.js';
export * from '@/utils/mcpkg/container.js';
export * from '@/utils/mcpkg/adapter-wechat.js';
export * from '@/utils/mcpkg/adapter-h5.js';
export * from "./services/sessionService.js";
export * from "./services/outbox.js";
export * from "./services/cloudAdapter.js";
export * from "./utils/cloudConfig.js";`, serviceBundle)
const storeBundle = path.join(temp, 'store.cjs')
buildBundle(`import { createPinia, setActivePinia } from 'pinia';\nsetActivePinia(createPinia());\n` +
  `export * from './services/toolsStore.js';\nexport * from './services/sessionService.js';\nexport * from './services/familyStore.js';\nexport * from './services/outbox.js';\nexport * from './services/cloudAdapter.js';\nexport * from './utils/cloudConfig.js';\n`, storeBundle)
// 真实宫缩页面 bundle（未完成列表/两态标签消费）
const contraPageBundle = path.join(temp, 'contra-page.cjs')
{
  const src = fs.readFileSync(path.join(root, 'pages/tools/contraction-timer.vue'), 'utf8')
  const m = src.match(/<script setup>([\s\S]*?)<\/script>/)
  let code = m[1]
    .replace(/^import .* from ['"][^'"\n]+\.vue['"];?$/mg, '')
    .replace(/import\s*\{\s*onShow\s*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const shows=[];const onShow=fn=>shows.push(fn);')
  code = `import { createPinia, setActivePinia } from 'pinia';\nsetActivePinia(createPinia());\n` +
    code.replace('const toolsStore = useToolsStore()', 'setActivePinia(createPinia());\nconst toolsStore = useToolsStore()') +
    `\nexport {shows, recentContractions, unfinishedList, active, unsaved, onToggle};\nexport * from './services/toolsStore.js';\nexport * from './services/sessionService.js';\nexport * from './services/familyStore.js';\nexport * from './services/outbox.js';\nexport * from './services/cloudAdapter.js';\nexport * from './utils/cloudConfig.js';\n`
  esbuild.buildSync({ stdin: { contents: code, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: contraPageBundle, logLevel: 'silent' })
}
function loadClient(bundlePath) { delete require.cache[require.resolve(bundlePath)]; return require(bundlePath) }
function wire(client, stack) {
  client.__setCloudConfigForTests('env-iv3b', 'wxapp-iv3b')
  client.__setWxCloud(stack.wxCloud)
  global.wx = Object.assign(global.wx || {}, { cloud: stack.wxCloud })
  client.__resetForTests()
  return client
}

async function seedFiles(stack, n) {
  const ids = []
  for (let i = 0; i < n; i++) {
    const uploadId = `iv3bup${i}${Date.now().toString(36)}`
    const up = await filesH.main({ action: 'prepareUpload', schemaVersion: 1, uploadId })
    assert.ok(up.ok, 'prepare')
    stack.cloud.__stored.set(up.data.cloudPath, makePng(i + 1))
    const reg = await filesH.main({ action: 'registerStaged', schemaVersion: 1, uploadId, operationId: `iv3breg${i}${Math.random().toString(36).slice(2, 8)}`, stageFileID: `cloud://e.b/${up.data.cloudPath}` })
    assert.ok(reg.ok, 'register')
    ids.push(reg.data.file.fileId)
  }
  return ids
}
async function mkReport(st, id, payload, expectedRevision = 0) {
  const r = await reportsH.main({ action: 'report.upsert', schemaVersion: 1, operationId: `iv3br-${id}-${Math.random().toString(36).slice(2, 8)}`, expectedRevision, id, payload })
  assert.ok(r.ok, `mkReport ${id}: ${JSON.stringify(r).slice(0, 120)}`)
  return r.data.record
}
const sortKeyOf = (ms, id) => `${String(ms).padStart(16, '0')}:${id}`
function seedContra(stack, recordId, startTime, extra = {}) {
  stack.cloud.__docs.set(`mc_contraction_records/${recordId}`, {
    familyId: TEST_ENV.MC_FAMILY_ID, memberId: 'mama',
    dateKey: '2026-09-16', startTime, endTime: startTime + 40000, durationSec: 40, intervalSec: null,
    intensity: null, notes: `iv3b-${recordId}`, status: 'finished', revision: 2, createdAt: 1, updatedAt: 1,
    sortKey: sortKeyOf(startTime, recordId), __v: 1, ...extra,
  })
}
function decodePackageDomains(pkgBuf) {
  assert.ok(pkgBuf.length > 24, '目标包字节在')
  const mlen = Number(new DataView(pkgBuf.buffer, pkgBuf.byteOffset + 16, 8).getBigUint64(0))
  const manifest = JSON.parse(pkgBuf.subarray(24, 24 + mlen).toString('utf8'))
  const domainRecords = {}
  let cur = 24 + mlen
  for (let i = 0; i < manifest.files.length; i++) {
    const elen = Number(new DataView(pkgBuf.buffer, pkgBuf.byteOffset + cur, 8).getBigUint64(0)); cur += 8
    const f = manifest.files[i]
    if (f.kind === 'domain-json') domainRecords[f.domain] = JSON.parse(pkgBuf.subarray(cur, cur + elen).toString('utf8'))
    cur += elen
  }
  return { manifest, domainRecords }
}

async function main() {
  console.log('IV-R3b 独立反例（R3 审核缺口：无 Buffer 完整导出链 / 同夹具>100 云端+旧 pending / 病态分页不部分写）\n')
  installUni()

  await scenario('无 Buffer 全链导出：真实 buildAndPublishPackage 在 global.Buffer=undefined 下完成，多字节报告逐字段往返', async () => {
    const stack = makeStack()
    const fsm = installWechatGlobal(stack)
    const client = wire(loadClient(serviceBundle), stack)
    await client.confirmIdentity()
    await healthH.main({ action: 'pregnancy.upsert', schemaVersion: 1, operationId: 'iv3b-preg', expectedRevision: 0, payload: { lmpDate: '2026-05-11' } })
    const fids = await seedFiles(stack, 2)
    // 真实 handler 产出多字节正文（视觉模式，mock 提供方返回多字节）
    const multibyteAnswer = '娘胎监测解读：双顶径与孕周相符。'.repeat(120) // ~3.3KB 多字节
    await mkReport(stack, 'rpt-iv3b-mb', { reportType: 'ultrasound', dateKey: '2026-09-21', note: '多字节备注：肱骨、羊水', attachments: [{ fileId: fids[0] }, { fileId: fids[1] }] })
    toolsH.__setAiMock(async () => multibyteAnswer)
    const a = await toolsH.main({ action: 'ai.analyzeReport', reportId: 'rpt-iv3b-mb' })
    assert.ok(a.ok && a.data.visionIncluded, `多字节分析（实得 ${JSON.stringify(a).slice(0, 100)}）`)
    // 生产源码无 Buffer 引用（静态断言——与既有 r3 一审同口径复核）
    const svcSrc = fs.readFileSync(path.join(root, 'services/mcpkgExportService.js'), 'utf8')
      .replace(/\/\/[^\n]*/g, '')
    assert.ok(!/\bBuffer\b/.test(svcSrc), '导出服务零 Buffer 引用')
    // 无 Buffer 环境：完整导出全链（导出服务/容器/utf8/sha256 均真实执行）
    const realBuffer = global.Buffer
    global.Buffer = undefined
    let r, fsmRaw
    try {
      r = await client.buildAndPublishPackage({ includeShared: true, includePrivateOf: null })
      assert.ok(r.ok, `无 Buffer 导出成功（实得 ${JSON.stringify({ code: r.code, message: r.message }).slice(0, 120)}）`)
      assert.equal(r.complete, true)
      assert.equal(r.packageKind, 'full')
      assert.deepEqual(r.problems, [])
      fsmRaw = fsm.__files.get(r.flag.path) || new Uint8Array(0) // 无 Buffer 区间只持原始 Uint8Array
    } finally {
      global.Buffer = realBuffer
    }
    const fsmBytes = Buffer.from(fsmRaw) // 恢复 Buffer 后测试侧再转
    assert.ok(fsmBytes.length > 24, '目标包字节在')
    // 复验 + 解码 deepEqual（测试侧已恢复 Buffer）
    const vr = await client.validatePackage(client.wechatFileReader(r.flag.path))
    assert.ok(vr.ok, `验包（实得 ${JSON.stringify(vr.problems).slice(0, 160)}）`)
    const { domainRecords } = decodePackageDomains(fsmBytes)
    const rec = (domainRecords.reports || []).find(x => x.id === 'rpt-iv3b-mb')
    assert.ok(rec, '包内有该报告')
    const doc = stack.cloud.__docs.get('mc_reports/rpt-iv3b-mb')
    assert.equal(rec.ai_result.text, multibyteAnswer, '多字节正文逐字节往返')
    assert.equal(rec.note, '多字节备注：肱骨、羊水', '多字节 note 往返')
    assert.deepEqual(rec.ai_result.coverage, JSON.parse(JSON.stringify(doc.ai_result.coverage)), 'coverage 往返')
    assert.equal(rec.vision_result.inputDigest, doc.vision_result.inputDigest, 'provenance digest 往返')
  })

  await scenario('同夹具：120 条更晚云端记录 + 更旧本地 pending——pull/落盘/冷恢复/再 pull/页面全链', async () => {
    const stack = makeStack()
    installWechatGlobal(stack)
    const client = wire(loadClient(storeBundle), stack)
    await client.confirmIdentity()
    const store = client.useToolsStore()
    // 本地更旧 pending：离线 start+stop（25 小时前时间戳由 Date.now 实际驱动——离线归档即成 pending）
    const fakeOffline = { offline: false }
    const origCall = stack.wxCloud.callFunction.bind(stack.wxCloud)
    stack.wxCloud.callFunction = o => { if (fakeOffline.offline) { o.fail({ errMsg: 'offline' }); return } origCall(o) }
    fakeOffline.offline = true
    await store.startContraction({ notes: 'iv3b-old-pending' })
    await store.stopContraction({ intensity: 'strong', notes: 'iv3b-old-terminal' })
    fakeOffline.offline = false
    const localRow = store.contractionRecords.find(x => x.synced === false)
    assert.ok(localRow && localRow.localRef, '本地 pending 在（更旧输入）')
    // 云端 120 条更晚记录（startTime 全部大于本地行）
    const tLate = Date.now() + 200000
    for (let i = 0; i < 120; i++) seedContra(stack, `iv3blate-${String(i).padStart(3, '0')}`, tLate + i * 25000)
    // ① pull：全量 120 + 本地 pending 保留
    const p1 = await store.pullContractions()
    assert.ok(p1.ok, `pull（实得 ${JSON.stringify(p1).slice(0, 100)}）`)
    assert.equal(store.contractionRecords.filter(x => x.synced === false).length, 1, 'pending 保留')
    const pend1 = store.contractionRecords.find(x => x.synced === false)
    assert.equal(pend1.notes, 'iv3b-old-terminal', '本地终态凭据不被较晚云端行顶替')
    assert.equal(store.contractionRecords.filter(x => x.synced !== false).length, 120, '云端 120 条全在')
    assert.equal(store.contraStopQueue.length, 1, 'stop 队列保留')
    // ② 落盘截断不失 pending：已同步 ≤100 + pending 全保留
    const histKey = [...storage.keys()].find(k => k.includes('_mama_') && k.endsWith('_contra_history'))
    const histDisk = JSON.parse(storage.get(histKey))
    const diskPend = histDisk.filter(x => x.synced === false)
    const diskSynced = histDisk.filter(x => !(x.synced === false))
    assert.equal(diskPend.length, 1, '盘上 pending 全保留（不受上限影响）')
    assert.ok(diskSynced.length <= 100, `已同步 ≤100（实得 ${diskSynced.length}）`)
    // ③ 冷恢复（全新客户端）：队列+pending 凭据复原
    const client2 = wire(loadClient(storeBundle), stack)
    await client2.confirmIdentity()
    const store2 = client2.useToolsStore()
    const rr = store2.restoreFromCache()
    assert.equal(rr.ok, true, `冷恢复无警告（实得 ${JSON.stringify(rr.warnings)}）`)
    const pend2 = store2.contractionRecords.find(x => x.synced === false)
    assert.ok(pend2, '冷恢复 pending 展示行在')
    assert.equal(pend2.notes, 'iv3b-old-terminal', '凭据复原')
    assert.equal(pend2.intensity, 'strong')
    assert.equal(store2.contraStopQueue.length, 1, '队列复原（重试凭据在）')
    // ④ 再 pull：仍不顶替、不双行
    const p2 = await store2.pullContractions()
    assert.ok(p2.ok)
    const rows = store2.contractionRecords.filter(x => x.localRef === pend2.localRef || x.notes === 'iv3b-old-terminal')
    assert.equal(rows.filter(x => x.synced === false).length, 1, '同输入单行 pending')
    assert.equal(store2.contractionRecords.filter(x => x.synced !== false).length, 120, '云端视图照常')
    // ⑤ 真实宫缩页面消费：未完成列表 + 待同步标签（冲突标签另证）
    const page = wire(loadClient(contraPageBundle), stack)
    await page.confirmIdentity()
    const pageStore = page.useToolsStore()
    pageStore.restoreFromCache()
    const uf = page.unfinishedList.value
    assert.equal(uf.length, 1, `页面未完成列表恰 1 条（实得 ${uf.length}）`)
    assert.notEqual(uf[0].conflict, true, `纯待同步（未打冲突标；实得 conflict=${uf[0].conflict}）`)
    const src = fs.readFileSync(path.join(root, 'pages/tools/contraction-timer.vue'), 'utf8')
    assert.ok(src.includes('未完成同步的记录'), '独立未完成区块在模板')
    assert.ok(src.includes('待同步（本机保留，联网后自动重试；未同步到云端）'), '待同步标签文案在模板')
    assert.ok(src.includes('⚠️ 与其他设备的记录冲突：本机输入未同步，需处理'), '冲突标签文案在模板')
    stack.wxCloud.callFunction = origCall
  })

  await scenario('病态分页响应：hasMore 无游标 / hasMore=false 带游标 / 游标不前进 → 受控失败零部分写入', async () => {
    for (const [name, mutate, seedMany] of [
      ['hasMore:true 无 nextCursor', r => { r.data.hasMore = true; r.data.nextCursor = null }, false],
      ['hasMore:false 带游标', r => { r.data.hasMore = false; r.data.nextCursor = '0123456789abcdef:fake-cursor' }, false],
      ['游标不前进（回传同值）', (r, prevCursor) => { if (prevCursor) { r.data.hasMore = true; r.data.nextCursor = prevCursor } }, true],
    ]) {
      const stack = makeStack()
      installWechatGlobal(stack)
      seedContra(stack, 'iv3bpath-a', Date.parse('2026-09-17T08:00:00+08:00'))
      seedContra(stack, 'iv3bpath-b', Date.parse('2026-09-17T09:00:00+08:00'))
      if (seedMany) for (let i = 0; i < 150; i++) seedContra(stack, `iv3bpath-m-${String(i).padStart(3, '0')}`, Date.parse('2026-09-17T10:00:00+08:00') + i * 15000)
      const client = wire(loadClient(storeBundle), stack)
      await client.confirmIdentity()
      const store = client.useToolsStore()
      // 预置本地已同步历史（断言不被部分写入破坏）
      store.contractionRecords = [{ recordId: 'preexist-1', localRef: 'cpre1', startTime: 1, endTime: 2, durationSec: 1, status: 'finished', synced: true }]
      const before = JSON.stringify(store.contractionRecords)
      const histKey = [...storage.keys()].find(k => k.includes('_mama_') && k.endsWith('_contra_history'))
      const histBefore = histKey ? storage.get(histKey) : null
      // 包装网关：对 contraction.list 注入病态响应
      const origCall = stack.wxCloud.callFunction.bind(stack.wxCloud)
      let lastCursor = null
      let listCalls = 0
      stack.wxCloud.callFunction = o => {
        origCall({
          ...o,
          data: o.data,
          success: res => {
            if (o.name === 'mc-tools' && o.data && o.data.action === 'contraction.list') {
              listCalls++
              mutate(res.result, lastCursor)
              if (res.result.data && res.result.data.nextCursor) lastCursor = res.result.data.nextCursor
            }
            o.success(res)
          },
          fail: o.fail,
        })
      }
      const r = await store.pullContractions()
      assert.equal(r.ok, false, `${name} → 受控失败`)
      assert.equal(r.code, 'pagination-error', `${name}：受控码（实得 ${r.code}）`)
      assert.ok(listCalls <= 2, `${name}：不无限循环（实得 ${listCalls} 次调用）`)
      assert.equal(JSON.stringify(store.contractionRecords), before, `${name}：本地历史零部分写入`)
      const histAfter = histKey ? storage.get(histKey) : null
      assert.equal(histAfter, histBefore, `${name}：盘上历史零部分写入`)
      stack.wxCloud.callFunction = origCall
    }
  })

  await scenario('冲突页面（必执行）：同页面 store 在线 start→离线 stop→云端他方终态→pull 后本地输入不变/conflict/队列在/页面未完成列表含冲突行+冷恢复', async () => {
    const stack = makeStack()
    installWechatGlobal(stack)
    // 真实宫缩页面 bundle + 其同一 Pinia store（页面消费与业务操作同源）
    const page = wire(loadClient(contraPageBundle), stack)
    await page.confirmIdentity()
    const pageStore = page.useToolsStore()
    // ① 在线 start：取得服务端身份
    const fakeOffline = { offline: false }
    const origCall = stack.wxCloud.callFunction.bind(stack.wxCloud)
    stack.wxCloud.callFunction = o => { if (fakeOffline.offline) { o.fail({ errMsg: 'offline' }); return } origCall(o) }
    const startR = await pageStore.startContraction({ intensity: 'mild', notes: '本人输入-iv3b2' })
    assert.ok(startR.ok, `在线 start（实得 ${JSON.stringify(startR).slice(0, 80)}）`)
    const rid = pageStore.activeContraction.recordId
    assert.ok(rid, '已取得服务端 recordId')
    const localStart = pageStore.activeContraction.startTime
    // ② 离线 stop：本地 pending + stop 队列
    fakeOffline.offline = true
    const stopR = await pageStore.stopContraction({ intensity: 'strong', notes: '本人终态-iv3b2' })
    fakeOffline.offline = false
    assert.equal(stopR.code, 'offline-pending', `离线 stop=真暂存（实得 ${stopR.code}）`)
    const localRow = pageStore.contractionRecords.find(x => x.synced === false)
    assert.ok(localRow, '本地 pending 行在')
    const localEndTime = localRow.endTime
    assert.ok(Number.isFinite(localEndTime), '本地 endTime 凭据在')
    assert.equal(pageStore.contraStopQueue.length, 1, 'stop 队列保留')
    // ③ 云端同 ID 写入不同终态（他方抢先：endTime/intensity/notes 均不同）
    const srvKey = `mc_contraction_records/${rid}`
    const srv = stack.cloud.__docs.get(srvKey)
    assert.ok(srv, '服务端行在')
    stack.cloud.__docs.set(srvKey, { ...srv, status: 'finished', endTime: localEndTime + 7777, durationSec: Math.round((localEndTime + 7777 - localStart) / 1000), intensity: 'severe', notes: '他方终态-iv3b2', revision: (srv.revision || 2) + 3 })
    // ④ 同一页面 store 真实 pull：无条件断言本地输入不被顶替 + 冲突标记 + 队列保留
    const p = await pageStore.pullContractions()
    assert.ok(p.ok, `pull（实得 ${JSON.stringify(p).slice(0, 80)}）`)
    const rows = pageStore.contractionRecords.filter(x => x.recordId === rid)
    assert.equal(rows.length, 1, '同 ID 单行（不双行）')
    const cRow = rows[0]
    assert.equal(cRow.synced, false, '本地输入保留可见（不被他方行顶替）')
    assert.equal(cRow.conflict, true, 'conflict=true')
    assert.equal(cRow.notes, '本人终态-iv3b2', '本地 notes 不变')
    assert.equal(cRow.intensity, 'strong', '本地 intensity 不变')
    assert.equal(cRow.endTime, localEndTime, '本地 endTime 不变')
    assert.equal(pageStore.contraStopQueue.length, 1, 'pull 后 stop 队列仍保留（凭据在）')
    // ⑤ 同一页面消费：未完成列表包含此冲突行（同一 store，非跨 bundle）
    const uf = page.unfinishedList.value
    assert.equal(uf.length, 1, `未完成列表恰 1 条（实得 ${uf.length}）`)
    assert.equal(uf[0].recordId, rid, '冲突行即该行')
    assert.equal(uf[0].conflict, true, '页面列表内 conflict=true')
    assert.equal(uf[0].notes, '本人终态-iv3b2', '页面行内容=本地凭据')
    // ⑥ 落盘后页面冷恢复（全新页面实例 restore）：冲突行与队列凭据复原、页面再次可消费
    const page2 = wire(loadClient(contraPageBundle), stack)
    await page2.confirmIdentity()
    const store2 = page2.useToolsStore()
    const rr = store2.restoreFromCache()
    assert.equal(rr.ok, true, `冷恢复无新警告（实得 ${JSON.stringify(rr.warnings)}）`)
    const c2 = store2.contractionRecords.find(x => x.recordId === rid)
    assert.ok(c2, '冷恢复冲突行在')
    assert.equal(c2.synced, false)
    assert.equal(c2.conflict, true, '冷恢复保持冲突标记')
    assert.equal(c2.notes, '本人终态-iv3b2', '冷恢复本地凭据不变')
    assert.equal(c2.intensity, 'strong')
    assert.equal(c2.endTime, localEndTime)
    assert.equal(store2.contraStopQueue.length, 1, '冷恢复队列凭据在')
    const uf2 = page2.unfinishedList.value
    assert.equal(uf2.length, 1, '冷恢复后页面未完成列表仍含该行')
    assert.equal(uf2[0].recordId, rid)
    assert.equal(uf2[0].conflict, true)
    stack.wxCloud.callFunction = origCall
  })

  console.log(`\nphase-iv-r3b：${passed} 通过，${failed.length} 失败`)
  if (failed.length > 0) { console.log('失败场景：', failed.join(' | ')); process.exit(1) }
}

main().catch(e => { console.error('套件异常:', e); process.exit(2) })
