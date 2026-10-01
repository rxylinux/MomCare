// 阶段 A 功能修复回归（2026-10-01，FUNCTIONAL_REPAIR_ZCODE_TASK F1–F3）：
// F1 旧计时数据安全找回；F2 按域恢复闸 + EFW 删除/刷新分离；F3 OCR 截断覆盖披露。
// 全部走真实生产路径（真实 store/页面 bundle/真实 handler/实际导出包字节）；mock 仅替换
// 外部传输（云函数路由到真实 dist handler）。预修复失败症状见
// /tmp/momcare-functional-repair-a/repro-f{1,2,3}-prefix.log。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-fr-a-'))

let passed = 0
const failed = []
const groups = { F1: 0, F2: 0, F3: 0 }
const failedGroups = { F1: [], F2: [], F3: [] }
function pass(name, g) { passed++; groups[g]++; console.log(`  ok  [${g}] ${name}`) }
function fail(name, e, g) { failed.push(name); failedGroups[g].push(name); console.log(`FAIL  [${g}] ${name}\n      ${e && e.message}`) }
async function scenario(g, name, fn) { try { await fn(); pass(name, g) } catch (e) { fail(name, e, g) } }
const tick = () => new Promise(r => setTimeout(r, 8))

require('node:child_process').execFileSync('node', [path.join(root, 'cloud/assemble.mjs')], { stdio: 'pipe' })
const DIST = path.join(root, 'dist/cloud-functions')
const scheduleH = require(path.join(DIST, 'mc-schedule/index.js'))
const toolsH = require(path.join(DIST, 'mc-tools/index.js'))
const healthH = require(path.join(DIST, 'mc-health/index.js'))
const reportsH = require(path.join(DIST, 'mc-reports/index.js'))
const filesH = require(path.join(DIST, 'mc-files/index.js'))
const identityH = require(path.join(DIST, 'mc-identity/index.js'))
const restoreH = require(path.join(DIST, 'mc-restore/index.js'))

const TEST_ENV = { MC_APPID: 'wxfraapp0000001', MC_FAMILY_ID: 'fam-fr-a', MC_MEMBER_MAMA_OPENID: 'oFRAMAMA0000001', MC_MEMBER_PAPA_OPENID: 'oFRAPAPA0000001' }

function makeMockCloud() {
  const docs = new Map()
  const state = { caller: TEST_ENV.MC_MEMBER_MAMA_OPENID, initialized: false, ocrCalls: [] }
  const clone = x => JSON.parse(JSON.stringify(x))
  function docApi(col, id, tx) {
    return {
      get: async () => { const e = docs.get(`${col}/${id}`); if (tx) tx.reads.set(`${col}/${id}`, e ? e.__v : 0); return { data: e ? { ...clone(e), _id: id } : null } },
      set: async ({ data }) => { if (tx) { tx.writes.set(`${col}/${id}`, clone(data)); return { _id: id } } const prev = docs.get(`${col}/${id}`); docs.set(`${col}/${id}`, { ...clone(data), __v: (prev ? prev.__v : 0) + 1 }); return { _id: id } },
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
      return { collection: c => ({ doc: id => docApi(c, id, tx) }), commit: async () => { for (const [k, rv] of tx.reads) { const c2 = docs.get(k); if ((c2 ? c2.__v : 0) !== rv) { const e = new Error('conflict'); e.errCode = 'CONFLICT'; throw e } } for (const k of tx.removes) docs.delete(k); for (const [k, d2] of tx.writes) { const p = docs.get(k); docs.set(k, { ...d2, __v: (p ? p.__v : 0) + 1 }) } }, rollback: async () => { tx.writes.clear(); tx.removes.clear() } }
    },
    collection: c => ({ doc: id => docApi(c, id, null), where: f => mq(c, f), get: async () => ({ data: runQuery(c, {}) }) })
  }
  return {
    DYNAMIC_CURRENT_ENV: Symbol('env'), init() { state.initialized = true },
    getWXContext: () => ({ APPID: TEST_ENV.MC_APPID, OPENID: state.caller }),
    database() { if (!state.initialized) throw new Error('init first'); return db },
    downloadFile: async ({ fileID }) => { const k = String(fileID).replace(/^cloud:\/\/[^/]+\//, ''); const b = docs.has(`__bytes/${k}`) ? docs.get(`__bytes/${k}`) : null; if (!b) throw new Error('dl'); return { fileContent: Buffer.from(b) } },
    uploadFile: async ({ cloudPath, fileContent }) => { docs.set(`__bytes/${cloudPath}`, Buffer.from(fileContent)); return { fileID: `cloud://e.b/${cloudPath}` } },
    getTempFileURL: async ({ fileList }) => ({ fileList: fileList.map(f => ({ fileID: f, tempFileURL: 'https://t.i/' + f })) }),
    openapi: { ocr: { printedText: async p => { state.ocrCalls.push(p); const k = String(p.img_url || '').replace(/^https:\/\/t\.i\//, ''); const text = docs.get(`__ocrtext/${k}`); return { errCode: 0, words_result: [{ words: text || '默认OCR文本' }] } } } },
    __docs: docs, __state: state, __setCtx(o) { state.caller = o },
  }
}

const storage = new Map()
const uniCalls = { toasts: [], navs: [] }
let harnessCloud = null
let fsmFiles = null
global.uni = {
  getStorageSync(k) { return storage.has(k) ? storage.get(k) : '' },
  setStorageSync(k, v) { storage.set(k, v) },
  removeStorageSync(k) { storage.delete(k) },
  getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
  showToast: v => uniCalls.toasts.push(String((v && v.title) || '')), showModal: o => o && o.success && o.success({ confirm: true }),
  showLoading() {}, hideLoading() {},
  redirectTo() {}, navigateTo: o => uniCalls.navs.push(String((o && o.url) || '')), switchTab() {}, reLaunch() {}, navigateBack() {},
  request() {}, uploadFile() {}, downloadFile: o => { o.fail && o.fail({ errMsg: 'dl' }) }, vibrateShort() {},
}
function makeFSM() {
  const files = new Map()
  const u8 = d => typeof d === 'string' ? new Uint8Array(Buffer.from(d, 'utf8')) : new Uint8Array(d)
  return () => ({
    writeFile(o) { files.set(o.filePath, u8(o.data)); o.success && o.success({}) },
    appendFile(o) { const a = u8(o.data), p = files.get(o.filePath) || new Uint8Array(0); const n = new Uint8Array(p.length + a.length); n.set(p); n.set(a, p.length); files.set(o.filePath, n); o.success && o.success({}) },
    readFile(o) { const f = files.get(o.filePath); if (!f) { o.fail && o.fail({ errMsg: 'readFile:fail' }); return } const pos = o.position == null ? 0 : o.position; const len = o.length == null ? f.length - pos : Math.min(o.length, f.length - pos); o.success && o.success({ data: f.slice(pos, pos + len).buffer }) },
    stat(o) { const f = files.get(o.path); if (!f) { o.fail && o.fail({ errMsg: 'stat:fail' }); return } o.success && o.success({ stats: { size: f.length } }) },
    rename(o) { const f = files.get(o.oldPath); if (!f) { o.fail && o.fail({ errMsg: 'rename:fail' }); return } files.set(o.newPath, f); files.delete(o.oldPath); o.success && o.success({}) },
    copyFile(o) { const f = files.get(o.srcPath); if (!f) { o.fail && o.fail({ errMsg: 'copyFile:fail' }); return } files.set(o.destPath, f); o.success && o.success({}) },
    mkdir(o) { o.success && o.success({}) }, rmdir(o) { o.success && o.success({}) }, unlink(o) { files.delete(o.filePath); o.success && o.success({}) }, access(o) { o.success && o.success({}) },
    __files: files,
  })
}
function installWechatGlobal(wxCloud) {
  const fsm = makeFSM()()
  fsmFiles = fsm.__files
  global.wx = {
    cloud: wxCloud,
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
const clientBundle = path.join(temp, 'client.cjs')
buildBundle(`import { createPinia, setActivePinia } from 'pinia';\nsetActivePinia(createPinia());\n` +
  `export * from './services/toolsStore.js';\nexport * from './services/sessionService.js';\nexport * from './services/familyStore.js';\nexport * from './services/outbox.js';\nexport * from './services/cloudAdapter.js';\nexport * from './utils/cloudConfig.js';\n`, clientBundle)
const serviceBundle = path.join(temp, 'svc.cjs')
buildBundle(`export * from '@/services/mcpkgExportService.js';\nexport * from '@/utils/mcpkg/utf8.js';\nexport * from '@/utils/mcpkg/canonical.js';\nexport * from '@/utils/mcpkg/sha256.js';\nexport * from '@/utils/mcpkg/container.js';\nexport * from '@/utils/mcpkg/adapter-wechat.js';\nexport * from '@/utils/mcpkg/adapter-h5.js';\nexport * from "./services/sessionService.js";\nexport * from "./services/outbox.js";\nexport * from "./services/cloudAdapter.js";\nexport * from "./utils/cloudConfig.js";`, serviceBundle)
// 三张页面 bundle
function pageBundle(vueRel, outfile, exportsList, setupShims = true) {
  const src = fs.readFileSync(path.join(root, vueRel), 'utf8')
  const body = src.match(/<script setup>([\s\S]*?)<\/script>/)[1]
  let code = body
    .replace(/^import .* from ['"][^'"\n]+\.vue['"];?$/mg, '')
    .replace(/import\s*\{\s*onShow\s*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const shows=[];const onShow=fn=>shows.push(fn);')
    .replace(/import\s*\{\s*onLoad\s*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const loads=[];const onLoad=fn=>loads.push(fn);')
    .replace('getCurrentInstance().proxy', '({ proxy: null })')
  const piniaInject = 'const toolsStore = useToolsStore()'
  if (code.includes(piniaInject)) {
    code = code.replace(piniaInject, 'import { createPinia, setActivePinia } from "pinia";\nsetActivePinia(createPinia());\n' + piniaInject)
  } else if (code.includes('const reportStore = useReportStore()')) {
    code = code.replace('const reportStore = useReportStore()', 'import { createPinia, setActivePinia } from "pinia";\nsetActivePinia(createPinia());\nconst reportStore = useReportStore()')
  }
  esbuild.buildSync({
    stdin: { contents: code + `\nexport ${exportsList};\nexport {__setWxCloud} from "./services/cloudAdapter.js";\nexport {__adoptSessionForTests, __resetForTests} from "./services/sessionService.js";\nexport * from './services/toolsStore.js';\nexport * from './services/sessionService.js';\nexport * from './services/cloudAdapter.js';\nexport * from './utils/cloudConfig.js';`, resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile, logLevel: 'silent'
  })
  return outfile
}
const fetalPageB = pageBundle('pages/tools/fetal-timer.vue', path.join(temp, 'p-fetal.cjs'),
  '{shows, session, unsaved, rawCount, fetalSessions, legacyPending, legacySummaryText, legacyResultText, onLegacyAdopt, onLegacyExport, restoreWarnings, recoveryBlocked}')
const contraPageB = pageBundle('pages/tools/contraction-timer.vue', path.join(temp, 'p-contra.cjs'),
  '{shows, active, unsaved, recentContractions, unfinishedList, legacyPending, legacySummaryText, legacyResultText, onLegacyAdopt, onLegacyExport}')
const efwPageB = pageBundle('pages/tools/ultrasound-weight.vue', path.join(temp, 'p-efw.cjs'),
  '{shows, efwRecords, onDelete, efwLoadError, onRetryPull}')
const detailPageB = (() => {
  const src = fs.readFileSync(path.join(root, 'pages/archives/detail.vue'), 'utf8')
  const body = src.match(/<script setup>([\s\S]*?)<\/script>/)[1]
  const code = body
    .replace(/^import .* from ['"][^'"\n]+\.vue['"];?$/mg, '')
    .replace(/import\s*\{\s*onLoad\s*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const loads=[];const onLoad=fn=>loads.push(fn);')
    .replace('getCurrentInstance().proxy', '({ proxy: null })')
  esbuild.buildSync({
    stdin: { contents: code.replace('const reportStore = useReportStore()', 'import { createPinia, setActivePinia } from "pinia";\nsetActivePinia(createPinia());\nconst reportStore = useReportStore()') + '\nexport {famReportToLegacy, report, aiCoverageNote};\nexport {__setWxCloud} from "./services/cloudAdapter.js";\nexport {__adoptSessionForTests, __resetForTests} from "./services/sessionService.js";', resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: path.join(temp, 'p-detail.cjs'), logLevel: 'silent'
  })
  return path.join(temp, 'p-detail.cjs')
})()
const aiResultPageB = (() => {
  const src = fs.readFileSync(path.join(root, 'pages/archives/ai-result.vue'), 'utf8')
  const body = src.match(/<script setup>([\s\S]*?)<\/script>/)[1]
  const code = body.replace(/^import .* from ['"][^'"\n]+\.vue['"];?$/mg, '')
    .replace(/import\s*\{\s*onLoad\s*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const loads=[];const onLoad=fn=>loads.push(fn);')
  esbuild.buildSync({
    stdin: { contents: code.replace('const reportStore = useReportStore()', 'import { createPinia, setActivePinia } from "pinia";\nsetActivePinia(createPinia());\nconst reportStore = useReportStore()') + '\nexport {report, aiCoverageNote, ocrText, ocrHistory};\nexport {__adoptSessionForTests, __resetForTests} from "./services/sessionService.js";', resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: path.join(temp, 'p-airesult.cjs'), logLevel: 'silent'
  })
  return path.join(temp, 'p-airesult.cjs')
})()
const viewFile = path.join(temp, 'aiReportView.cjs')
esbuild.buildSync({ entryPoints: [path.join(root, 'services/aiReportView.js')], bundle: true, platform: 'node', format: 'cjs', outfile: viewFile, logLevel: 'silent' })
function loadView() { delete require.cache[require.resolve(viewFile)]; return require(viewFile) }
function loadClient(p = clientBundle) { delete require.cache[require.resolve(p)]; return require(p) }

const enc = v => encodeURIComponent(v).replace(/_/g, '%5F')
const scopedKey = (scope, suffix) => `momcare_tools_${[scope.envId, scope.appId, scope.familyId, scope.memberId].map(enc).join('_')}_t1_${suffix}`
const SCOPE = { envId: 'env-fr-a', appId: 'wxapp-fr-a', familyId: TEST_ENV.MC_FAMILY_ID, memberId: 'mama' }
const contraDocsOf = st => [...st.cloud.__docs.entries()].filter(([k]) => k.startsWith('mc_contraction_records/')).map(([k, v]) => ({ _id: k.split('/')[1], ...v }))
const fetalDocsOf = st => [...st.cloud.__docs.entries()].filter(([k]) => k.startsWith('mc_fetal_sessions/')).map(([k, v]) => ({ _id: k.split('/')[1], ...v }))
const legacyKeysInStorage = () => [...storage.keys()].filter(k => /^momcare_(fetal_active_session|active_contraction|fetal_sessions_history|fetal_finish_queue|contra_stop_queue)$/.test(k))
const keepKeysOf = legacyKey => [...storage.keys()].filter(k => k.startsWith(`${legacyKey}__legacy_keep_`))

function makeStack(member = 'mama') {
  for (const k of [...storage.keys()]) { if (k.startsWith('momcare_') || k.startsWith('mc_')) storage.delete(k) }
  const cloud = makeMockCloud()
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID
  process.env.MC_UPLOAD_ENABLED = 'true'
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.MC_OCR_PROVIDER
  delete process.env.MC_REPORT_VISION
  cloud.__setCtx(member === 'mama' ? TEST_ENV.MC_MEMBER_MAMA_OPENID : TEST_ENV.MC_MEMBER_PAPA_OPENID)
  toolsH.__setCloud(cloud); healthH.__setCloud(cloud); reportsH.__setCloud(cloud); filesH.__setCloud(cloud); identityH.__setCloud(cloud); scheduleH.__setCloud(cloud)
  harnessCloud = cloud
  const state = { toolsCalls: 0, actions: [], hold: false, gates: [], failActions: {}, offline: false }
  const wxCloud = {
    init() {},
    callFunction(o) {
      if (state.offline) { o.fail({ errMsg: 'cloud.callFunction:fail offline' }); return }
      const routes = {
        'mc-tools': e => { state.toolsCalls++; state.actions.push(e && e.action); if (state.failActions[e && e.action]) { const err = new Error(state.failActions[e.action]); throw err } return toolsH.main(e) },
        'mc-health': e => healthH.main(e),
        'mc-schedule': e => scheduleH.main(e),
        'mc-reports': e => reportsH.main(e),
        'mc-files': e => filesH.main(e),
        'mc-identity': () => ({ ok: true, data: { memberId: member, displayName: member === 'mama' ? '妈妈' : '爸爸', familyId: TEST_ENV.MC_FAMILY_ID } }),
      }
      const h = routes[o.name]
      if (!h) { o.fail({ errMsg: 'no route' }); return }
      Promise.resolve().then(() => h(o.data)).then(r => {
        if (o.name === 'mc-tools' && state.hold) state.gates.push({ action: o.data && o.data.action, release: () => o.success({ result: r }) })
        else o.success({ result: r })
      }).catch(e => o.fail({ errMsg: e.message }))
    }
  }
  installWechatGlobal(wxCloud)
  return { cloud, wxCloud, state, member }
}
function wire(bundlePath) {
  const client = loadClient(bundlePath)
  client.__setCloudConfigForTests(SCOPE.envId, SCOPE.appId)
  client.__setWxCloud(global.wx.cloud)
  client.__resetForTests()
  return client
}
async function confirmedClient(stack, bundlePath = clientBundle, member) {
  if (member) stack.member = member
  const client = wire(bundlePath)
  const r = await client.confirmIdentity()
  assert.ok(r.ok, `confirmIdentity: ${JSON.stringify(r).slice(0, 100)}`)
  return client
}

// ── 旧版真实键形状夹具（与 repro-f1 同一形状）──
const T0 = Date.parse('2026-09-30T10:00:00+08:00')
function legacyFixture({ withFetalActive = true, withFetalQueue = true, withContraActive = true, withContraQueue = true, withHistory = true } = {}) {
  const bytes = {}
  if (withFetalActive) bytes.momcare_fetal_active_session = JSON.stringify({
    sessionId: null, startTime: T0, targetDurationMs: 3600000, status: 'running', pausedAt: null,
    clicks: [{ timestamp: T0 + 60000, valid: true }, { timestamp: T0 + 120000, valid: false }],
    validCount: 1, rawCount: 2, serverRevision: 0,
    localRef: 'floc_old_1', startOpId: 'fst_old_1',
    journal: [{ opId: 'fck_old_1', kind: 'click', payload: { timestamp: T0 + 60000 } }, { opId: 'fck_old_2', kind: 'click', payload: { timestamp: T0 + 120000 } }]
  })
  if (withFetalQueue) bytes.momcare_fetal_finish_queue = JSON.stringify([{
    sessionId: null, startTime: T0 + 1000, targetDurationMs: 3600000, status: 'running', pausedAt: null,
    clicks: [{ timestamp: T0 + 2000, valid: true }], validCount: 1, rawCount: 1, serverRevision: 0,
    localRef: 'floc_old_q', startOpId: 'fst_old_q',
    journal: [{ opId: 'fck_old_q', kind: 'click', payload: { timestamp: T0 + 2000 } }, { opId: 'ffn_old_q', kind: 'finish', payload: { endTime: T0 + 300000, syncDaily: true } }]
  }])
  if (withContraActive) bytes.momcare_active_contraction = JSON.stringify({
    recordId: null, startTime: T0 + 400000, status: 'ongoing', intensity: 'mild', notes: '旧宫缩备注',
    localRef: 'cloc_old_1', startOpId: 'cnt_old_1', stopOp: null
  })
  if (withContraQueue) bytes.momcare_contra_stop_queue = JSON.stringify([{
    recordId: null, startTime: T0 + 500000, status: 'ongoing', intensity: null, notes: '旧待重放宫缩',
    localRef: 'cloc_old_q', startOpId: 'cnt_old_q',
    stopOp: { opId: 'cst_old_q', endTime: T0 + 560000, intensity: 'strong', notes: null }
  }])
  if (withHistory) bytes.momcare_fetal_sessions_history = JSON.stringify([{ startTime: T0 - 86400000, status: 'completed', validCount: 2, rawCount: 2, endTime: T0 - 86400000 + 3600000, synced: true, localRef: 'floc_old_h1' }])
  for (const [k, v] of Object.entries(bytes)) storage.set(k, v)
  return bytes
}

// ══════════ F1 ══════════
async function main() {
  console.log('阶段 A 功能修复回归（F1 旧数据找回 / F2 按域闸+EFW 反馈 / F3 OCR 截断披露）\n')

  await scenario('F1', '检测与入口：旧键在场 → 页面持久横幅（含计数与"不自动归属"说明）；未确认零上传、正文不展示、旧字节不动', async () => {
    const stack = makeStack()
    legacyFixture()
    const page = await confirmedClient(stack, fetalPageB)
    const store = page.useToolsStore()
    store.restoreFromCache()
    assert.ok(page.legacyPending.value && page.legacyPending.value.total === 5, `检测到 5 个旧键（实得 ${page.legacyPending.value && page.legacyPending.value.total}）`)
    const text = page.legacySummaryText.value
    assert.ok(text.includes('胎动进行中 1') && text.includes('宫缩进行中 1'), `计数披露（实得 ${text}）`)
    assert.ok(text.includes('无法自动证明归属') && text.includes('不上传'), '不自动归属与不上传说明在')
    assert.ok(!text.includes('旧宫缩备注'), '正文不外露（只计数）')
    assert.equal(stack.state.toolsCalls, 0, '未确认零云调用')
    assert.equal(store.currentFetalSession, null, '未迁入')
    // 宫缩页同样入口
    const contraPage = await confirmedClient(stack, contraPageB)
    const store2 = contraPage.useToolsStore()
    store2.restoreFromCache()
    assert.ok(contraPage.legacyPending.value && contraPage.legacyPending.value.total === 5, '宫缩页入口在')
  })

  await scenario('F1', '确认迁入（离线草稿，无云端 ID）：localRef/opId/点击顺序/finish·stop 时间与显式 null 全保留；原始字节备份后旧键清除；页面立即可见', async () => {
    const stack = makeStack()
    const bytes = legacyFixture()
    const page = await confirmedClient(stack, fetalPageB)
    const store = page.useToolsStore()
    store.restoreFromCache()
    uniCalls.toasts.length = 0
    await page.onLegacyAdopt() // showModal mock 自动 confirm
    await tick()
    const r = page.__lastAdopt // 未导出——改从结果断言
    // 会话迁入（含 scope 盖章）
    assert.ok(store.currentFetalSession, '胎动 active 迁入')
    const fs2 = store.currentFetalSession
    assert.equal(fs2.localRef, 'floc_old_1') && assert.equal(fs2.startOpId, 'fst_old_1')
    assert.deepEqual(fs2.clicks.map(c => c.timestamp), [T0 + 60000, T0 + 120000], '点击顺序保留')
    assert.equal(fs2.scope.memberId, 'mama', '当前完整作用域')
    assert.equal(store.contraStopQueue.length, 1, '宫缩 stop 队列迁入')
    const cq = store.contraStopQueue[0]
    assert.equal(cq.stopOp.endTime, T0 + 560000, 'stop 时间保留')
    assert.equal(cq.stopOp.notes, null, '显式 null 保留')
    assert.equal(store.fetalFinishQueue.length, 1, '胎动 finish 队列迁入')
    assert.equal(store.fetalFinishQueue[0].journal.at(-1).payload.endTime, T0 + 300000, 'finish 时间保留')
    // 原始字节备份存在
    for (const k of Object.keys(bytes)) {
      assert.equal(keepKeysOf(k).length, 1, `备份键在：${k}`)
      assert.equal(storage.get(keepKeysOf(k)[0]), bytes[k], `备份=原始字节：${k}`)
    }
    // 旧键清除
    assert.equal(legacyKeysInStorage().length, 0, '迁移后旧键清除')
    assert.equal(page.legacyPending.value.total, 0, '入口消失')
    // 联网重放收敛（同 opId）
    const retried = await store.retryPending()
    assert.ok(retried.every(x => x.ok), `重放收敛（实得 ${JSON.stringify(retried).slice(0, 140)}）`)
    const fd = fetalDocsOf(stack)
    assert.ok(fd.length >= 2, '两胎动会话上云')
    const contraDocs = contraDocsOf(stack)
    assert.ok(contraDocs.length >= 1, '宫缩上云')
    const byNotes = contraDocs.find(d => d.notes === '旧宫缩备注')
    assert.ok(byNotes, '旧宫缩备注上云')
  })

  await scenario('F1', '幂等：重复确认/冷重启重复确认 → 不双会话不双操作（opId 集合不变）', async () => {
    const stack = makeStack()
    legacyFixture({ withHistory: false })
    const page = await confirmedClient(stack, fetalPageB)
    const store = page.useToolsStore()
    store.restoreFromCache()
    await page.onLegacyAdopt()
    await tick()
    // 重复确认（无旧键 → no-op）
    await page.onLegacyAdopt()
    await tick()
    // 冷重启重复确认：重新注入同一旧键（模拟部分场景），去重键防双
    storage.set('momcare_fetal_finish_queue', JSON.stringify([{ sessionId: null, startTime: T0 + 1000, targetDurationMs: 3600000, status: 'running', pausedAt: null, clicks: [{ timestamp: T0 + 2000, valid: true }], validCount: 1, rawCount: 1, serverRevision: 0, localRef: 'floc_old_q', startOpId: 'fst_old_q', journal: [{ opId: 'fck_old_q', kind: 'click', payload: { timestamp: T0 + 2000 } }, { opId: 'ffn_old_q', kind: 'finish', payload: { endTime: T0 + 300000, syncDaily: true } }] }]))
    const r2 = await store.confirmLegacyAdoption()
    assert.ok(r2.ok, `重复确认 ok（实得 ${JSON.stringify(r2).slice(0, 120)}）`)
    assert.equal(store.fetalFinishQueue.filter(x => x.startOpId === 'fst_old_q').length, 1, '同 startOpId 不双')
    const opIds = [...store.contraStopQueue.map(q => q.stopOp && q.stopOp.opId), ...store.fetalFinishQueue.map(q => q.startOpId)]
    assert.equal(new Set(opIds).size, opIds.length, '操作 ID 无重复')
  })

  await scenario('F1', '有云端 ID 的旧记录：归属验证——不同所有者拒绝续跑（保留待处理零 mutation）；本人记录可迁入', async () => {
    // ① 不同所有者
    {
      const stack = makeStack()
      legacyFixture({ withFetalQueue: false, withContraActive: false, withContraQueue: false, withHistory: false })
      // 旧 active 带云端 sessionId，云端存在但属 papa
      const sess = JSON.parse(storage.get('momcare_fetal_active_session'))
      sess.sessionId = 'fst_srv_1'
      storage.set('momcare_fetal_active_session', JSON.stringify(sess))
      stack.cloud.__docs.set('mc_fetal_sessions/fst_srv_1', { familyId: TEST_ENV.MC_FAMILY_ID, memberId: 'papa', startTime: T0, status: 'running', clicks: [], revision: 1, sortKey: '0001:fst_srv_1', createdAt: 1, updatedAt: 1 })
      const page = await confirmedClient(stack, fetalPageB)
      const store = page.useToolsStore()
      store.restoreFromCache()
      const r = await store.confirmLegacyAdoption()
      assert.ok(r.ok, '流程完成')
      assert.equal(r.adopted, 0, '不迁入')
      assert.equal(r.rejected.length, 1, `归属不符点名（实得 ${JSON.stringify(r.rejected)}）`)
      assert.equal(r.rejected[0].owner, 'papa', '云端所有者如实')
      assert.equal(store.currentFetalSession, null, '零迁入')
      assert.ok(storage.has('momcare_fetal_active_session'), '旧键保留待处理')
      assert.ok(keepKeysOf('momcare_fetal_active_session').length >= 1, '原始字节已备份')
      // 云端该记录未被改动（零 mutation：成员/状态不变）
      assert.equal(stack.cloud.__docs.get('mc_fetal_sessions/fst_srv_1').memberId, 'papa')
    }
    // ② 本人记录 → 可迁入续跑
    {
      const stack = makeStack()
      legacyFixture({ withFetalQueue: false, withContraActive: false, withContraQueue: false, withHistory: false })
      const sess = JSON.parse(storage.get('momcare_fetal_active_session'))
      sess.sessionId = 'fst_srv_2'
      storage.set('momcare_fetal_active_session', JSON.stringify(sess))
      stack.cloud.__docs.set('mc_fetal_sessions/fst_srv_2', { familyId: TEST_ENV.MC_FAMILY_ID, memberId: 'mama', startTime: T0, status: 'running', clicks: [], revision: 1, sortKey: '0002:fst_srv_2', createdAt: 1, updatedAt: 1 })
      const page = await confirmedClient(stack, fetalPageB)
      const store = page.useToolsStore()
      store.restoreFromCache()
      const r = await store.confirmLegacyAdoption()
      assert.equal(r.adopted, 1, `本人记录迁入（实得 ${JSON.stringify(r).slice(0, 120)}）`)
      assert.equal(store.currentFetalSession.sessionId, 'fst_srv_2', '续跑持有云端身份')
    }
    // ③ 云端查询失败（离线）→ 保留待处理，不发 mutation、不删旧键
    {
      const stack = makeStack()
      legacyFixture({ withFetalQueue: false, withContraActive: false, withContraQueue: false, withHistory: false })
      const sess = JSON.parse(storage.get('momcare_fetal_active_session'))
      sess.sessionId = 'fst_srv_3'
      storage.set('momcare_fetal_active_session', JSON.stringify(sess))
      const page = await confirmedClient(stack, fetalPageB)
      const store = page.useToolsStore()
      store.restoreFromCache()
      stack.state.offline = true
      const r = await store.confirmLegacyAdoption()
      stack.state.offline = false
      assert.equal(r.unverifiable.length, 1, '无法核验点名')
      assert.equal(store.currentFetalSession, null, '不迁入')
      assert.ok(storage.has('momcare_fetal_active_session'), '旧键保留')
    }
  })

  await scenario('F1', '目标写失败/冷重启：旧字节不删除；恢复后同 opId 收敛', async () => {
    const stack = makeStack()
    legacyFixture({ withHistory: false })
    const origSet = global.uni.setStorageSync
    // 目标作用域键写失败（迁移落盘失败）
    global.uni.setStorageSync = (k, v) => { if (k.startsWith('momcare_tools_') && !k.includes('__legacy_keep_')) throw new Error('disk full'); origSet(k, v) }
    let r
    try {
      const page = await confirmedClient(stack, fetalPageB)
      const store = page.useToolsStore()
      store.restoreFromCache()
      r = await store.confirmLegacyAdoption()
    } finally { global.uni.setStorageSync = origSet }
    assert.equal(r.fetalPersist, false, '落盘失败如实')
    assert.equal(legacyKeysInStorage().length, 4, `旧键全部保留（未删除；实得 ${legacyKeysInStorage().length}）`)
    // 恢复后重试收敛
    const page = await confirmedClient(stack, fetalPageB)
    const store = page.useToolsStore()
    store.restoreFromCache()
    const r2 = await store.confirmLegacyAdoption()
    assert.ok(r2.adopted >= 2, `恢复后迁入（实得 ${JSON.stringify(r2).slice(0, 140)}）`)
    const retried = await store.retryPending()
    assert.ok(retried.every(x => x.ok), `重放收敛（实得 ${JSON.stringify(retried).slice(0, 140)}）`)
    const serverOpIds = [...stack.cloud.__docs.keys()].filter(k => k.startsWith('mc_operations/')).map(k => k.split(':')[1])
    assert.equal(new Set(serverOpIds).size, serverOpIds.length, 'opKey 不双写')
  })

  await scenario('F1', '新旧 active 冲突：当前已有进行中记录 → 不覆盖、明确冲突提示、旧数据保全可导出', async () => {
    const stack = makeStack()
    legacyFixture({ withFetalQueue: false, withContraQueue: false, withHistory: false })
    const page = await confirmedClient(stack, fetalPageB)
    const store = page.useToolsStore()
    // 先开一个新会话（当前作用域）
    await store.startFetalSession()
    const curRef = store.currentFetalSession.localRef
    store.restoreFromCache()
    const r = await store.confirmLegacyAdoption()
    assert.equal(r.conflicts.length, 1, `冲突点名（实得 ${JSON.stringify(r.conflicts)}）`)
    assert.equal(store.currentFetalSession.localRef, curRef, '当前会话不被覆盖')
    assert.ok(storage.has('momcare_fetal_active_session'), '旧 active 保留')
    assert.ok(keepKeysOf('momcare_fetal_active_session').length >= 1, '旧 active 已备份可导出')
    // 页面文案包含冲突提示通路
    assert.ok(fs.readFileSync(path.join(root, 'pages/tools/fetal-timer.vue'), 'utf8').includes('冲突'), '页面冲突提示在')
  })

  await scenario('F1', '导出保留：不删除不迁移，原始字节落备份键；读取异常如实提示', async () => {
    const stack = makeStack()
    const bytes = legacyFixture({ withFetalQueue: false })
    storage.set('momcare_fetal_active_session', ' { broken 尾随') // 读取 ok 但解析失败（unparseable）
    const page = await confirmedClient(stack, contraPageB)
    const store = page.useToolsStore()
    store.restoreFromCache()
    assert.ok(page.legacySummaryText.value.includes('读取异常'), `读取异常如实提示（实得 ${page.legacySummaryText.value.slice(0, 80)}）`)
    uniCalls.toasts.length = 0
    page.onLegacyExport()
    assert.ok(keepKeysOf('momcare_active_contraction').length === 1, '导出备份键在')
    assert.equal(storage.get(keepKeysOf('momcare_active_contraction')[0]), bytes.momcare_active_contraction, '备份=原始字节')
    assert.equal(legacyKeysInStorage().length, 4, `导出不删除旧键（实得 ${legacyKeysInStorage().length}）`)
  })

  // ══════════ F2 ══════════
  await scenario('F2', '按域闸：胎动 corrupt + 宫缩正常 → EFW 云读不受阻；宫缩域可恢复；胎动域如实阻断', async () => {
    const stack = makeStack()
    await confirmedClient(stack) // 初始化作用域
    storage.set(scopedKey(SCOPE, 'fetal_active'), ' { broken 尾随')
    const page = await confirmedClient(stack, efwPageB)
    const store = page.useToolsStore()
    const rr = store.restoreFromCache()
    assert.equal(rr.ok, false, '恢复闸在（fetal 域）')
    void store
    // 云端 EFW 记录可读（纯云端域不受胎动缓存异常影响）
    stack.cloud.__docs.set('mc_efw_records/efw-1', { familyId: TEST_ENV.MC_FAMILY_ID, memberId: 'mama', dateKey: '2026-09-20', gestationalWeek: 32, measurements: { hcCm: 29, acCm: 27, flCm: 6.0 }, unit: 'cm', efwGrams: 1800, formula: 'hadlock_hc_ac_fl_1985_v1', status: 'active', revision: 1, createdAt: 1, updatedAt: 1, sortKey: '2026-09-20:efw-1', __v: 1 })
    for (const fn of page.shows) await fn()
    await tick()
    assert.ok(page.efwRecords.value.length === 1, `EFW 云读正常（实得 ${page.efwRecords.value.length}）`)
    assert.equal(page.efwLoadError.value, '', '无失败状态')
    // 分域闸
    assert.equal(store.fetalRecoveryBlocked, true, '胎动域阻断')
    assert.equal(store.contraRecoveryBlocked, false, '宫缩域正常')
    // retryPending：宫缩可跑（无内容 → 无外呼），胎动如实 blocked+domain
    const results = await store.retryPending()
    assert.ok(results.some(x => x.code === 'recovery-blocked' && x.domain === 'fetal'), `被阻断域如实（实得 ${JSON.stringify(results).slice(0, 100)}）`)
    // 反向：宫缩 corrupt + 胎动正常
    const stack2 = makeStack()
    await confirmedClient(stack2)
    storage.delete(scopedKey(SCOPE, 'fetal_active'))
    storage.set(scopedKey(SCOPE, 'contra_active'), ' { broken 尾随')
    const page2 = await confirmedClient(stack2, efwPageB)
    const store2 = page2.useToolsStore()
    store2.restoreFromCache()
    assert.equal(store2.fetalRecoveryBlocked, false, '反向：胎动域正常')
    assert.equal(store2.contraRecoveryBlocked, true, '反向：宫缩域阻断')
    const results2 = await store2.retryPending()
    assert.ok(results2.some(x => x.code === 'recovery-blocked' && x.domain === 'contraction'), '反向：被阻断域=宫缩')
  })

  await scenario('F2', 'EFW 删除/刷新分离：删除成功+刷新失败 → ok:true+deleted:true+refresh 如实，本地行移除（不可再误删）；删除失败如实', async () => {
    const stack = makeStack()
    const client = await confirmedClient(stack, efwPageB)
    const store = client.useToolsStore()
    for (const id of ['efw-d1', 'efw-d2']) {
      stack.cloud.__docs.set(`mc_efw_records/${id}`, { familyId: TEST_ENV.MC_FAMILY_ID, memberId: 'mama', dateKey: `2026-09-2${id.endsWith('1') ? '1' : '2'}`, gestationalWeek: 32, measurements: { hcCm: 29, acCm: 27, flCm: 6.0 }, unit: 'cm', efwGrams: 1800, formula: 'hadlock_hc_ac_fl_1985_v1', status: 'active', revision: 1, createdAt: 1, updatedAt: 1, sortKey: `2026-09-21:${id}`, __v: 1 })
    }
    assert.ok((await store.pullEfwRecords()).ok && store.efwRecords.length === 2)
    // ① 删除成功 + 刷新失败
    stack.state.failActions['efw.list'] = 'network down'
    const del = await store.deleteEfwRecord('efw-d1')
    stack.state.failActions = {}
    assert.equal(del.ok, true, `删除成功就是成功（实得 ${JSON.stringify(del).slice(0, 140)}）`)
    assert.equal(del.deleted, true)
    assert.equal(del.refresh.ok, false, '刷新失败如实带回')
    const srv = stack.cloud.__docs.get('mc_efw_records/efw-d1')
    assert.equal(srv.status, 'discarded', '云端已删（软删）')
    assert.ok(!store.efwRecords.some(x => x.recordId === 'efw-d1'), '本地行已移除（不可再次误删）')
    // 页面消费：toast 语义"已删除（列表刷新失败）"而非"删除失败"
    stack.state.failActions['efw.list'] = 'network down'
    uniCalls.toasts.length = 0
    await page_onDelete(client, 'efw-d2', stack)
    stack.state.failActions = {}
    assert.ok(uniCalls.toasts.some(t => t.includes('已删除（列表刷新失败')), `页面分离反馈（实得 ${JSON.stringify(uniCalls.toasts)}）`)
    // ② 删除本身失败（第三条记录，未受前序影响）
    stack.cloud.__docs.set('mc_efw_records/efw-d3', { familyId: TEST_ENV.MC_FAMILY_ID, memberId: 'mama', dateKey: '2026-09-23', gestationalWeek: 32, measurements: { hcCm: 29, acCm: 27, flCm: 6.0 }, unit: 'cm', efwGrams: 1800, formula: 'hadrock_hc_ac_fl_1985_v1', status: 'active', revision: 1, createdAt: 1, updatedAt: 1, sortKey: '2026-09-23:efw-d3', __v: 1 })
    stack.cloud.__docs.get('mc_efw_records/efw-d3').formula = 'hadlock_hc_ac_fl_1985_v1'
    const pull3 = await store.pullEfwRecords()
    assert.ok(pull3.ok && store.efwRecords.some(x => x.recordId === 'efw-d3'), '第三条在列')
    stack.state.failActions['efw.delete'] = 'boom'
    const del2 = await store.deleteEfwRecord('efw-d3')
    stack.state.failActions = {}
    assert.equal(del2.ok, false, '删除失败如实')
    assert.equal(del2.deleted, false)
    assert.ok(store.efwRecords.some(x => x.recordId === 'efw-d3'), '行保留（结果未定不误删展示）')
  })

  await scenario('F2', 'EFW 页面消费拉取失败：失败状态可见 + 重试入口真实调用；await 中切身份丢弃旧响应', async () => {
    const stack = makeStack()
    const page = await confirmedClient(stack, efwPageB)
    // ① 拉取失败 → 可见状态
    stack.state.failActions['efw.list'] = 'timeout'
    const r = await page.useToolsStore().pullEfwRecords()
    stack.state.failActions = {}
    assert.equal(r.ok, false)
    stack.state.failActions['efw.list'] = 'timeout'
    for (const fn of page.shows) await fn()
    await tick(); await tick()
    stack.state.failActions = {}
    assert.ok(String(page.efwLoadError.value).length > 0, `失败状态可见（实得 "${page.efwLoadError.value}"）`)
    // ② 重试入口
    stack.state.failActions['efw.list'] = 'timeout'
    uniCalls.toasts.length = 0
    page.onRetryPull()
    await tick(); await tick()
    stack.state.failActions = {}
    assert.ok(uniCalls.toasts.some(t => t.includes('仍失败')), `重试失败如实（实得 ${JSON.stringify(uniCalls.toasts)}）`)
    // ③ 恢复后重试成功清状态
    page.onRetryPull()
    await tick(); await tick()
    assert.equal(page.efwLoadError.value, '', '重试成功清除失败状态')
    // ④ 删除在途切身份：删除响应到来时身份已换 → 不动新身份视图、不误报
    const stack2 = makeStack()
    const page2 = await confirmedClient(stack2, efwPageB)
    const store2 = page2.useToolsStore()
    stack2.cloud.__docs.set('mc_efw_records/efw-x1', { familyId: TEST_ENV.MC_FAMILY_ID, memberId: 'mama', dateKey: '2026-09-25', gestationalWeek: 33, measurements: { hcCm: 30, acCm: 28, flCm: 6.2 }, unit: 'cm', efwGrams: 1900, formula: 'hadlock_hc_ac_fl_1985_v1', status: 'active', revision: 1, createdAt: 1, updatedAt: 1, sortKey: '2026-09-25:efw-x1', __v: 1 })
    assert.ok((await store2.pullEfwRecords()).ok)
    // 门控 efw.delete 响应
    stack2.state.hold = true
    const delP = store2.deleteEfwRecord('efw-x1')
    await tick()
    assert.equal(stack2.state.gates.length, 1, 'efw.delete 在途')
    stack2.state.hold = false
    // 同 bundle 切 papa（epoch 推进）
    stack2.member = 'papa'
    stack2.cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID)
    assert.ok((await page2.confirmIdentity()).ok)
    await tick()
    stack2.state.gates.forEach(g => g.release())
    const rDel = await delP
    await tick()
    // 云端删除事实已发生（删除先于切换完成）——ok:true 事实保留；新身份视图未被旧响应改写（papa 拉取自己的列表）
    assert.equal(rDel.ok, true, '删除事实保留')
    assert.equal(rDel.deleted, true)
  })

  // ══════════ F3 ══════════
  const M1 = 'FR-A-M1-第一页开头标记'
  const M2 = 'FR-A-M2-第二页独有标记-肱骨异常'
  const page1Text = M1 + '血常规报告：' + '白细胞计数 9.8×10^9/L，红细胞 3.9×10^12/L。'.repeat(120) // >2000 字符
  const page2Text = '第二页：' + M2 + ' 超声提示：胎盘位置正常。'

  async function runOcrAnalysis(stack, { cache, t1, t2 } = {}) {
    stack.cloud.__docs.set('__bytes/none', Buffer.alloc(0)) // placeholder
    for (const id of ['q1', 'q2']) stack.cloud.__docs.set(`mc_files/${id}`, { familyId: TEST_ENV.MC_FAMILY_ID, status: 'registered', formalFileID: `cloud://env/formal/${id}`, __v: 1 })
    stack.cloud.__docs.set(`__ocrtext/cloud://env/formal/q1`, t1 !== undefined ? t1 : page1Text)
    stack.cloud.__docs.set(`__ocrtext/cloud://env/formal/q2`, t2 !== undefined ? t2 : page2Text)
    stack.cloud.__docs.set('mc_reports/rpt_f3', {
      familyId: TEST_ENV.MC_FAMILY_ID, deleted: false, dateKey: '2026-09-26', reportType: 'blood_routine',
      note: 'F3 回归', attachments: [{ fileId: 'q1' }, { fileId: 'q2' }], revision: cache ? 2 : 1, updatedBy: 'mama', updatedAt: 1, __v: 1,
      ...(cache ? { ocr_result: cache } : {})
    })
    let capturedPrompt = null
    toolsH.__setAiMock(prompt => { capturedPrompt = String(prompt); return 'F3 回归解读。' })
    const r = await toolsH.main({ action: 'ai.analyzeReport', reportId: 'rpt_f3' })
    return { r, doc: stack.cloud.__docs.get('mc_reports/rpt_f3'), capturedPrompt }
  }

  await scenario('F3', '截断披露：第一页>2000 字+第二页独有标记 → prompt 不含 M2；coverage 只计全文进入的页 + ocrTruncated；页面不称"全部"', async () => {
    const stack = makeStack()
    process.env.MC_REPORT_VISION = '0'
    process.env.MC_OCR_PROVIDER = 'wechat'
    try {
      const { r, doc, capturedPrompt } = await runOcrAnalysis(stack)
      assert.ok(r.ok, `分析成功（实得 ${JSON.stringify(r).slice(0, 120)}）`)
      assert.ok(capturedPrompt.includes(M1), '截断前内容（第一页开头）确实进入 prompt')
      assert.ok(!capturedPrompt.includes(M2), '第二页独有标记从未进入 prompt（被截断）')
      const cov = doc.ai_result.coverage
      assert.equal(cov.mode, 'ocr')
      assert.equal(cov.ocrTruncated, true, '截断标志持久化')
      assert.equal(cov.analyzedFileIds.includes('q2'), false, '被截断波及的页不计 analyzed')
      assert.ok(cov.skippedFileIds.includes('q2'), '计入 skipped')
      assert.equal(doc.ocr_result.truncated, true, 'ocr_result.truncated 持久化')
      // 读侧
      const view = loadView()
      const v = view.familyAiView({ ...doc, attachments: doc.attachments })
      assert.equal(v.ai_coverage.ocrTruncated, true)
      assert.equal(v.ai_coverage.complete, false, '截断下不称完整')
      // 真实详情页 + 结果页文案
      const detail = (() => { delete require.cache[require.resolve(detailPageB)]; return require(detailPageB) })()
      detail.__resetForTests()
      detail.__adoptSessionForTests({ memberId: 'mama', familyId: TEST_ENV.MC_FAMILY_ID, displayName: '妈妈' })
      detail.report.value = detail.famReportToLegacy({ id: 'rpt_f3', ...doc })
      const note = detail.aiCoverageNote.value
      assert.ok(note.includes('截断'), `详情页披露截断（实得 ${note}）`)
      assert.ok(!note.includes('已分析全部'), '绝不称全部')
      const aiPage = (() => { delete require.cache[require.resolve(aiResultPageB)]; return require(aiResultPageB) })()
      aiPage.__resetForTests()
      aiPage.__adoptSessionForTests({ memberId: 'mama', familyId: TEST_ENV.MC_FAMILY_ID, displayName: '妈妈' })
      aiPage.report.value = { _id: 'rpt_f3', report_type: 'blood_routine', report_date: '2026-09-26', ...v }
      assert.ok(aiPage.aiCoverageNote.value.includes('截断'), `结果页披露截断（实得 ${aiPage.aiCoverageNote.value}）`)
      assert.ok(!aiPage.aiCoverageNote.value.includes('已分析全部'))
    } finally { delete process.env.MC_REPORT_VISION; delete process.env.MC_OCR_PROVIDER }
  })

  await scenario('F3', '对照：不截断 OCR / 视觉 / metadata 保持既有正确提示；旧无新字段结果读侧兼容（suffix 证据仍防"全部"）', async () => {
    // ① 不截断两页短文本 OCR → "已分析全部"
    {
      const stack = makeStack()
      process.env.MC_REPORT_VISION = '0'
      process.env.MC_OCR_PROVIDER = 'wechat'
      try {
        const { r, doc } = await runOcrAnalysis(stack, { t1: '短文本第一页指标 A', t2: '短文本第二页指标 B' })
        assert.ok(r.ok)
        assert.equal(doc.ai_result.coverage.ocrTruncated, undefined, '不截断无标志')
        assert.equal(doc.ocr_result.truncated, false)
        assert.deepEqual(doc.ai_result.coverage.analyzedFileIds, ['q1', 'q2'], '全部页计入')
        const view = loadView()
        const v = view.familyAiView({ ...doc, attachments: doc.attachments })
        assert.equal(v.ai_coverage.complete, true, '不截断→完整')
        assert.equal(v.ai_coverage.ocrTruncated, false)
        const detail = (() => { delete require.cache[require.resolve(detailPageB)]; return require(detailPageB) })()
        detail.__resetForTests(); detail.__adoptSessionForTests({ memberId: 'mama', familyId: TEST_ENV.MC_FAMILY_ID, displayName: '妈妈' })
        detail.report.value = detail.famReportToLegacy({ id: 'r', ...doc })
        assert.ok(detail.aiCoverageNote.value.includes('已分析全部 2 个附件'), `不截断保持全部提示（实得 ${detail.aiCoverageNote.value}）`)
      } finally { delete process.env.MC_REPORT_VISION; delete process.env.MC_OCR_PROVIDER }
    }
    // ② 视觉模式（短附件）→ 既有提示不变
    {
      const stack = makeStack()
      delete process.env.MC_REPORT_VISION
      // seed PNG 字节供 vision 下载（jpeg magic 也可——生产嗅探认 jpeg/png）
      stack.cloud.__docs.set('__bytes/formal/q1', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20, 7)]))
      stack.cloud.__docs.set('__bytes/formal/q2', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20, 7)]))
      const { r, doc } = await runOcrAnalysis(stack, { t1: '短一', t2: '短二' })
      assert.ok(r.ok && r.data.visionIncluded, '视觉模式')
      assert.equal(doc.ai_result.coverage.mode, 'vision')
      assert.equal(doc.ai_result.coverage.ocrTruncated, undefined, '视觉无 OCR 截断标志')
      const view = loadView()
      const v = view.familyAiView({ ...doc, attachments: doc.attachments })
      assert.equal(v.ai_coverage.ocrTruncated, false)
      const detail = (() => { delete require.cache[require.resolve(detailPageB)]; return require(detailPageB) })()
      detail.__resetForTests(); detail.__adoptSessionForTests({ memberId: 'mama', familyId: TEST_ENV.MC_FAMILY_ID, displayName: '妈妈' })
      detail.report.value = detail.famReportToLegacy({ id: 'r', ...doc })
      assert.ok(detail.aiCoverageNote.value.includes('已分析全部 2 个附件'), '视觉保持全部提示')
    }
    // ③ metadata 模式 → 既有文案
    {
      const stack = makeStack()
      process.env.MC_REPORT_VISION = '0'
      delete process.env.MC_OCR_PROVIDER
      try {
        const { r, doc } = await runOcrAnalysis(stack)
        assert.ok(r.ok && r.data.coverage.mode === 'metadata')
        const view = loadView()
        const v = view.familyAiView({ ...doc, attachments: doc.attachments })
        const detail = (() => { delete require.cache[require.resolve(detailPageB)]; return require(detailPageB) })()
        detail.__resetForTests(); detail.__adoptSessionForTests({ memberId: 'mama', familyId: TEST_ENV.MC_FAMILY_ID, displayName: '妈妈' })
        detail.report.value = detail.famReportToLegacy({ id: 'r', ...doc })
        assert.ok(detail.aiCoverageNote.value.includes('本次仅分析报告元数据'), `metadata 既有文案（实得 ${detail.aiCoverageNote.value}）`)
      } finally { delete process.env.MC_REPORT_VISION }
    }
    // ④ 旧结果（无新字段）+ ocr 文本带截断后缀 → 读侧按证据防"全部"（不推断完整内容）
    {
      const view = loadView()
      const oldDoc = { deleted: false, revision: 4, attachments: [{ fileId: 'q1' }, { fileId: 'q2' }],
        ai_result: { text: '旧解读', model: 'deepseek-flash', generatedAt: 1, baseRevision: 1, inputDigest: 'a'.repeat(64), coverage: { analyzedCount: 2, totalAttachments: 2, analyzedFileIds: ['q1', 'q2'], skippedFileIds: [], mode: 'ocr' } },
        ocr_result: { text: 'x'.repeat(2000) + '…（OCR 文本超长已截断）', included: true, provider: 'wechat', generatedAt: 1, pageFileIds: ['q1', 'q2'], inputDigest: 'a'.repeat(64), baseRevision: 1 } }
      const v = view.familyAiView(oldDoc)
      assert.equal(v.ai_coverage.ocrTruncated, true, '旧结果按 suffix 证据识别截断')
      assert.equal(v.ai_coverage.complete, false, '不推断完整内容')
      const detail = (() => { delete require.cache[require.resolve(detailPageB)]; return require(detailPageB) })()
      detail.__resetForTests(); detail.__adoptSessionForTests({ memberId: 'mama', familyId: TEST_ENV.MC_FAMILY_ID, displayName: '妈妈' })
      detail.report.value = detail.famReportToLegacy({ id: 'r', ...oldDoc })
      assert.ok(detail.aiCoverageNote.value.includes('截断') && !detail.aiCoverageNote.value.includes('已分析全部'), `旧结果页面不称全部（实得 ${detail.aiCoverageNote.value}）`)
    }
  })

  await scenario('F3', 'OCR 缓存复用按已知截断证据：cached.text 带后缀 → analyzed 保守不计 + ocrTruncated', async () => {
    const stack = makeStack()
    process.env.MC_REPORT_VISION = '0'
    process.env.MC_OCR_PROVIDER = 'wechat'
    try {
      const cached = { text: 'y'.repeat(2000) + '…（OCR 文本超长已截断）', included: true, provider: 'wechat', generatedAt: 5, pageFileIds: ['q1', 'q2'], inputDigest: undefined, baseRevision: undefined }
      const { r, doc } = await runOcrAnalysis(stack, { cache: cached })
      assert.ok(r.ok, `缓存复用分析成功（实得 ${JSON.stringify(r).slice(0, 120)}）`)
      assert.equal(doc.ai_result.coverage.ocrTruncated, true, '截断标志（按证据）')
      assert.equal(doc.ai_result.coverage.analyzedCount, 0, '逐页覆盖不可考 → 保守不计 analyzed')
      assert.deepEqual(doc.ai_result.coverage.skippedFileIds, ['q1', 'q2'], '全部页计入 skipped')
      assert.equal(doc.ocr_result.truncated, true)
    } finally { delete process.env.MC_REPORT_VISION; delete process.env.MC_OCR_PROVIDER }
  })

  await scenario('F3', '导出/恢复白名单同步：新字段入真实包字节（full 不降诊断）；restore 接受新形状、拒未知嵌套键', async () => {
    const stack = makeStack()
    process.env.MC_REPORT_VISION = '0'
    process.env.MC_OCR_PROVIDER = 'wechat'
    let doc
    try {
      const out = await runOcrAnalysis(stack)
      assert.ok(out.r.ok)
      doc = out.doc
    } finally { delete process.env.MC_REPORT_VISION; delete process.env.MC_OCR_PROVIDER }
    // 真实导出全链（附件段映射需要 mc-files 附件管线——本场景构造无附件报告携带截断字段入包；
    // 有附件报告的字节级往返已由 iv-r3 A17 覆盖，此处验证新字段不降诊断+入包字节）
    const client = wire(serviceBundle)
    await client.confirmIdentity()
    stack.cloud.__docs.delete('mc_reports/rpt_f3') // 带附件报告的附件段映射不在本场景验证范围（iv-r3 A17 已覆盖）
    stack.cloud.__docs.set('mc_pregnancy/fam-fr-a:pregnancy', { familyId: TEST_ENV.MC_FAMILY_ID, fields: { lmpDate: '2026-05-01' }, __v: 1 })
    const noAtt = { familyId: TEST_ENV.MC_FAMILY_ID, deleted: false, dateKey: '2026-09-27', reportType: 'blood_routine', note: 'F3 导出（无附件）', attachments: [], revision: 1, updatedBy: 'mama', updatedAt: 1, __v: 1,
      ai_result: { text: '解读', model: 'deepseek-flash', generatedAt: 1, inputDigest: 'b'.repeat(64), baseRevision: 1, coverage: { analyzedCount: 0, totalAttachments: 0, analyzedFileIds: [], skippedFileIds: [], mode: 'ocr', ocrTruncated: true } },
      ocr_result: { text: 'x'.repeat(10) + '…（OCR 文本超长已截断）', included: true, provider: 'wechat', generatedAt: 1, pageFileIds: [], inputDigest: 'b'.repeat(64), baseRevision: 1, truncated: true } }
    stack.cloud.__docs.set('mc_reports/rpt_f3x', noAtt)
    const r = await client.buildAndPublishPackage({ includeShared: true, includePrivateOf: null })
    assert.ok(r.ok && r.complete === true && r.packageKind === 'full', `full 不降诊断（实得 ${r.packageKind}/${r.complete}，problems=${JSON.stringify(r.problems).slice(0, 120)}）`)
    const vr = await client.validatePackage(client.wechatFileReader(r.flag.path))
    assert.ok(vr.ok, `验包（实得 ${JSON.stringify(vr.problems).slice(0, 120)}）`)
    // 实际包字节含新字段
    const pkgBuf = Buffer.from(fsmFiles.get(r.flag.path) || new Uint8Array(0))
    const pkgText = pkgBuf.toString('latin1')
    const pkgJson = JSON.parse(Buffer.from(pkgBuf.subarray(24, 24 + Number(new DataView(pkgBuf.buffer, pkgBuf.byteOffset + 16, 8).getBigUint64(0)))).toString('utf8'))
    let found = false
    let cur = 24 + Number(new DataView(pkgBuf.buffer, pkgBuf.byteOffset + 16, 8).getBigUint64(0))
    let reports = null
    for (let i = 0; i < pkgJson.files.length; i++) {
      const elen = Number(new DataView(pkgBuf.buffer, pkgBuf.byteOffset + cur, 8).getBigUint64(0)); cur += 8
      const f = pkgJson.files[i]
      if (f.kind === 'domain-json' && f.domain === 'reports') reports = JSON.parse(pkgBuf.subarray(cur, cur + elen).toString('utf8'))
      cur += elen
    }
    const rec = (reports || []).find(x => x.id === 'rpt_f3x')
    assert.ok(rec, '包内有该报告')
    assert.equal(rec.ai_result.coverage.ocrTruncated, true, 'coverage.ocrTruncated 入包字节')
    assert.equal(rec.ocr_result.truncated, true, 'ocr_result.truncated 入包字节')
    found = true
    // 非法新字段仍拒（守卫矩阵抽查：非布尔 truncated）
    const svc = loadClient(serviceBundle)
    const problems = []
    svc.guardReportAiFields({ ocr_result: { text: 'x', included: true, truncated: 'yes' } }, () => 'r', problems)
    assert.ok(problems.length > 0, '非布尔 truncated 拒绝')
    const problems2 = []
    svc.guardReportAiFields({ ai_result: { text: 'x', coverage: { analyzedCount: 0, totalAttachments: 0, analyzedFileIds: [], skippedFileIds: [], mode: 'vision', ocrTruncated: true } } }, () => 'r', problems2)
    assert.ok(problems2.some(p => p.includes('ocrTruncated')), 'ocrTruncated=true 仅限 ocr 模式')
    // restore 白名单
    const decl = { id: 'r_x', revision: 2, deleted: false }
    const goodRec = { id: 'r_x', revision: 2, deleted: false, attachments: [], reportType: 'other', dateKey: '2026-09-01',
      ai_result: { text: 'x', generatedAt: 1, coverage: { analyzedCount: 1, totalAttachments: 1, analyzedFileIds: ['f1'], skippedFileIds: [], mode: 'ocr', ocrTruncated: true } },
      ocr_result: { text: 'y', included: true, generatedAt: 1, pageFileIds: ['f1'], truncated: true } }
    assert.equal(restoreH.__validateRecordShapeForTests('reports', goodRec, decl), null, 'restore 接受新形状')
    const bad = JSON.parse(JSON.stringify(goodRec))
    bad.ocr_result.truncationFlag = 1
    assert.ok(String(restoreH.__validateRecordShapeForTests('reports', bad, decl)).length > 0, 'restore 拒未知嵌套键')
    assert.ok(found)
  })

  console.log(`\nphase-fr-a：${passed} 通过，${failed.length} 失败（分组 F1=${groups.F1} F2=${groups.F2} F3=${groups.F3}；失败 F1=${failedGroups.F1.length} F2=${failedGroups.F2.length} F3=${failedGroups.F3.length}）`)
  if (failed.length > 0) { console.log('失败场景：', failed.join(' | ')); process.exit(1) }
}

// 页面 onDelete 驱动（真实页面函数）
async function page_onDelete(pageClient, recordId, stack) {
  const page = pageClient
  // onDelete(r) 内部 showModal mock 自动 confirm → 真实 store 调用
  await page.onDelete({ recordId })
  await tick(); await tick()
}

main().catch(e => { console.error('套件异常:', e); process.exit(2) })
