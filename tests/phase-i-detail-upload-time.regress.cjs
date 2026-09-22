// 详情页"上传时间"显示断裂回归（family 模式，2026-09-22）：
// famReportToLegacy 映射副本缺 create_time → 详情页该行恒显示 "-"（与 1.1.12 孕周标签/
// 1.1.13 AI 徽标同类的映射缺字段病）。云端报告文档此前只写 updatedAt（每次事务提交刷新），
// 无创建时刻——"上传时间"若直接映射它，编辑一次就漂移一次。
// 修复契约：
//   客户端 create_time = createdAt（新记录，云端创建事务写入）?? updatedAt（存量兜底）?? undefined（'-'）
//   云端 report.save 创建分支写 createdAt；编辑只刷 updatedAt 不动 createdAt
// 本套件锚定：三态映射优先级 + 云端创建落库 + 编辑不漂移。上传时间仍不可编辑（系统时间戳）。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-uptime-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }

// ── 客户端 bundle：detail.vue 剥 .vue import、shim onLoad、注入 pinia（phase-i 同方案）──
// getCurrentInstance().proxy 在无组件实例的 bundle 环境会炸——仅分享海报 canvas 用到，shim 掉
{
  const body = fs.readFileSync(path.join(root, 'pages/archives/detail.vue'), 'utf8').match(/<script setup>([\s\S]*?)<\/script>/)[1]
  const code = body
    .replace(/^import .* from ['"][^'"\n]+\.vue['"];?$/mg, '')
    .replace(/import\s*\{\s*onLoad\s*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const loads=[];const onLoad=fn=>loads.push(fn);')
    .replace('getCurrentInstance().proxy', '({ proxy: null })')
  esbuild.buildSync({
    stdin: {
      contents: code.replace('const reportStore = useReportStore()',
        'import { createPinia, setActivePinia } from "pinia";\nsetActivePinia(createPinia());\nconst reportStore = useReportStore()') +
        '\nexport {famReportToLegacy};',
      resolveDir: root
    },
    bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: path.join(temp, 'detail-page.cjs'), logLevel: 'silent'
  })
}
function loadClient() {
  delete require.cache[require.resolve(path.join(temp, 'detail-page.cjs'))]
  return require(path.join(temp, 'detail-page.cjs'))
}

// uni 全局替身（sessionService/pinia 持久化等模块加载期即读取）
const storage = new Map()
global.uni = {
  getStorageSync(k) { return storage.has(k) ? storage.get(k) : '' },
  setStorageSync(k, v) { storage.set(k, v) },
  removeStorageSync(k) { storage.delete(k) },
  getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
  showToast() {}, showLoading() {}, hideLoading() {}, showModal() {},
  redirectTo() {}, navigateTo() {}, switchTab() {}, reLaunch() {}, navigateBack() {}
}
global.wx = { cloud: { init() {}, callFunction(o) { o.success && o.success({ result: { ok: false, code: 'cloud-call-failed' } }) } } }

// ── 云端：真实组装产物 mc-reports handler + SDK 契约模拟（事务版本/文档库）──
process.env.MC_APPID = 'wxtestappid0001'
process.env.MC_FAMILY_ID = 'fam-uptime'
process.env.MC_MEMBER_MAMA_OPENID = 'oUPTIMEMAMA12345'
process.env.MC_MEMBER_PAPA_OPENID = 'oUPTIMEPAPA12345'
cp.execFileSync('node', [path.join(root, 'cloud/assemble.mjs')], { stdio: 'pipe' })
const reportsH = require(path.join(root, 'dist/cloud-functions/mc-reports/index.js'))

function makeMockCloud() {
  const docs = new Map()
  const state = { clockOffset: 0 }
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
        docs.set(`${col}/${id}`, { ...clone(data), __v: (prev ? prev.__v : 0) + 1 }); return { _id: id }
      }
    }
  }
  const db = {
    collection: c => ({ doc: id => docApi(c, id, null) }),
    startTransaction: async () => {
      const tx = { reads: new Map(), writes: new Map() }
      return {
        collection: c => ({ doc: id => docApi(c, id, tx) }),
        commit: async () => {
          for (const [k, rv] of tx.reads) {
            const cur = docs.get(k)
            if ((cur ? cur.__v : 0) !== rv) { const err = new Error('transaction conflict: ' + k); err.errMsg = err.message; throw err }
          }
          for (const [k, d2] of tx.writes) { const prev = docs.get(k); docs.set(k, { ...d2, __v: (prev ? prev.__v : 0) + 1 }) }
        },
        rollback: async () => { tx.writes.clear() }
      }
    }
  }
  const cloud = {
    init() {},
    DYNAMIC_CURRENT_ENV: Symbol('env'),
    getWXContext() { return { APPID: process.env.MC_APPID, OPENID: process.env.MC_MEMBER_MAMA_OPENID, ENV: 'env' } },
    database: () => db
  }
  return { cloud, docs, state }
}
const famRec = extra => Object.assign({
  id: 'r1', revision: 1, deleted: false, archiveStatus: 'archived',
  reportType: 'blood_routine', dateKey: '2026-09-01', attachments: []
}, extra)

;(async () => {
  await scenario('映射·存量记录（仅 updatedAt）：create_time 取 updatedAt，详情页不再恒 "-"', async () => {
    const { famReportToLegacy } = loadClient()
    const out = famReportToLegacy(famRec({ updatedAt: 1758518400000 }))
    assert.equal(out.create_time, 1758518400000, '存量兜底：无 createdAt 时 create_time=updatedAt')
  })

  await scenario('映射·新记录（createdAt+updatedAt）：create_time 取 createdAt，编辑刷新不漂移', async () => {
    const { famReportToLegacy } = loadClient()
    const out = famReportToLegacy(famRec({ createdAt: 1758518400000, updatedAt: 1758604800000 }))
    assert.equal(out.create_time, 1758518400000, 'createdAt 权威：updatedAt 更晚也不抢')
  })

  await scenario('映射·两字段皆缺：create_time 保持 undefined（不伪造值，页面 "-" 兜底）', async () => {
    const { famReportToLegacy } = loadClient()
    const out = famReportToLegacy(famRec({}))
    assert.equal('create_time' in out && out.create_time !== undefined, false, '缺时间字段不得伪造')
    assert.equal(out.report_date, '2026-09-01', '既有字段映射不受影响')
  })

  await scenario('云端·report.upsert 创建：文档落库带 createdAt（此后上传时间有了权威来源）', async () => {
    const { cloud, docs } = makeMockCloud()
    reportsH.__setCloud(cloud)
    docs.set('mc_files/f1', { familyId: 'fam-uptime', status: 'registered', attachedReportIds: [], __v: 0 })
    const t0 = Date.now()
    const res = await reportsH.main({
      action: 'report.upsert', schemaVersion: 1, id: 'rpt_up1', operationId: 'op-up1', expectedRevision: 0,
      payload: { dateKey: '2026-09-01', reportType: 'blood_routine', archiveStatus: 'archived', attachments: [{ fileId: 'f1' }] }
    })
    assert.ok(res.ok, '创建成功: ' + JSON.stringify(res))
    const doc = docs.get('mc_reports/rpt_up1')
    assert.ok(doc, '报告文档已落库')
    assert.ok(Number.isFinite(doc.createdAt), 'createdAt 为有限时间戳')
    assert.equal(doc.createdAt, doc.updatedAt, '创建事务同一 now：createdAt===updatedAt')
    assert.ok(Math.abs(doc.createdAt - t0) < 100, 'createdAt≈创建调用时刻（同事务时钟）')
  })

  await scenario('云端·编辑（revision+1）：createdAt 不变、updatedAt 前进（上传时间不随编辑漂移）', async () => {
    const { cloud, docs, state } = makeMockCloud()
    reportsH.__setCloud(cloud)
    docs.set('mc_files/f1', { familyId: 'fam-uptime', status: 'registered', attachedReportIds: [], __v: 0 })
    await reportsH.main({
      action: 'report.upsert', schemaVersion: 1, id: 'rpt_up2', operationId: 'op-up2-a', expectedRevision: 0,
      payload: { dateKey: '2026-09-01', reportType: 'blood_routine', archiveStatus: 'archived', attachments: [{ fileId: 'f1' }] }
    })
    const created = docs.get('mc_reports/rpt_up2')
    assert.ok(Number.isFinite(created.createdAt), '前置：创建即写入 createdAt（否则下面恒等断言对 undefined 恒真）')
    state.clockOffset = 60 * 60 * 1000 // 一小时后编辑
    const res = await reportsH.main({
      action: 'report.upsert', schemaVersion: 1, id: 'rpt_up2', operationId: 'op-up2-b', expectedRevision: 1,
      payload: { hospital: '市一医院' }
    })
    assert.ok(res.ok, '编辑成功: ' + JSON.stringify(res))
    const edited = docs.get('mc_reports/rpt_up2')
    assert.equal(edited.createdAt, created.createdAt, '编辑不动 createdAt')
    assert.equal(edited.updatedAt, created.updatedAt + 60 * 60 * 1000, 'updatedAt 前进到编辑时刻')
    assert.equal(edited.hospital, '市一医院', '编辑字段正常生效')
    assert.equal(edited.revision, 2, 'revision 递增')
  })

  console.log(`\n${passed} passed, ${failed.length} failed`)
  process.exit(failed.length ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
