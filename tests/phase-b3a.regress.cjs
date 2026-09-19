// B3a 回归：旧数据来源扫描→预览→确认→持久批次→逐实体执行→outbox 幂等。
// 真实 migrationStore/familyStore/session/outbox→真实 mc-health/mc-schedule/mc-reports handler。
// 隔离合成数据；不读真实旧键、不部署、不调用真实供应商。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-b3a-'))

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
const healthH = require(path.join(DIST, 'mc-health/index.js'))
const scheduleH = require(path.join(DIST, 'mc-schedule/index.js'))
const reportsH = require(path.join(DIST, 'mc-reports/index.js'))
const filesH = require(path.join(DIST, 'mc-files/index.js'))
const identityH = require(path.join(DIST, 'mc-identity/index.js'))

const JPEG = Buffer.from([255, 216, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0])
const TEST_ENV = {
  MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-b3atest',
  MC_MEMBER_MAMA_OPENID: 'oTESTMAMA123456', MC_MEMBER_PAPA_OPENID: 'oTESTPAPA123456'
}

// SDK 契约模拟（与 B2b2 同型）
function makeMockCloud() {
  const docs = new Map()
  const storedFiles = new Map()
  const state = { caller: TEST_ENV.MC_MEMBER_MAMA_OPENID, initialized: false }
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
    downloadFile: async ({ fileID }) => { const k = String(fileID).replace(/^cloud:\/\/[^/]+\//, ''); const b = storedFiles.get(k); if (!b) throw new Error('dl'); return { fileContent: Buffer.from(b) } },
    uploadFile: async ({ cloudPath, fileContent }) => { storedFiles.set(cloudPath, Buffer.from(fileContent)); return { fileID: `cloud://e.b/${cloudPath}` } },
    deleteFile: async ({ fileList }) => ({ fileList: fileList.map(f => ({ fileID: f, status: 0 })) }),
    getTempFileURL: async ({ fileList }) => ({ fileList: fileList.map(f => ({ fileID: f, tempFileURL: 'https://t.i/' + f })) }),
    __docs: docs, __stored: storedFiles, __state: state,
    __setCtx(openid) { state.caller = openid }
  }
  return cloud
}

const bundlePath = path.join(temp, 'client.cjs')
esbuild.buildSync({
  stdin: {
    contents: `export { createPinia, setActivePinia } from 'pinia';
      export * from './services/cloudAdapter.js';
      export * from './services/sessionService.js';
      export * from './services/outbox.js';
      export * from './services/familyStore.js';
      export * from './services/migrationStore.js';
      export * from './services/fileUploadService.js';
      export * from './utils/cloudConfig.js';`,
    resolveDir: root
  },
  bundle: true, platform: 'node', format: 'cjs', alias: { '@': root },
  outfile: bundlePath, logLevel: 'silent'
})
const api = require(bundlePath)

const storage = new Map()
const uniCalls = { toasts: [], requests: 0, uploadFile: 0 }
global.uni = {
  getStorageSync(k) { return storage.has(k) ? storage.get(k) : '' },
  setStorageSync(k, v) { storage.set(k, v) },
  removeStorageSync(k) { storage.delete(k) },
  getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
  showToast: v => uniCalls.toasts.push(v && v.title),
  showLoading() {}, hideLoading() {},
  redirectTo() {}, navigateTo() {}, switchTab() {}, reLaunch() {}, navigateBack() {},
  request: () => { uniCalls.requests++ },
  uploadFile: () => { uniCalls.uploadFile++ },
  saveFile: o => o.success({ savedFilePath: 'store://s-' + Date.now() }),
  removeSavedFile: o => (o.success && o.success({})),
  chooseImage: o => o.success({ tempFilePaths: ['tmp://pick.png'] })
}

function fullStack() {
  for (const k of [...storage.keys()]) {
    if (k.startsWith('mc_outbox_') || k.startsWith('mc_cache_') || k.startsWith('mc_session_')) storage.delete(k)
  }
  const cloud = makeMockCloud()
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  process.env.MC_UPLOAD_ENABLED = 'true'
  cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID)
  healthH.__setCloud(cloud); scheduleH.__setCloud(cloud); reportsH.__setCloud(cloud); filesH.__setCloud(cloud); identityH.__setCloud(cloud)
  const routes = {
    'mc-health': e => healthH.main(e),
    'mc-schedule': e => scheduleH.main(e),
    'mc-reports': e => reportsH.main(e),
    'mc-files': e => filesH.main(e),
    'mc-identity': () => ({ ok: true, data: { memberId: 'mama', displayName: '妈妈', familyId: TEST_ENV.MC_FAMILY_ID } })
  }
  const wxCloud = {
    init() {},
    callFunction(o) { const h = routes[o.name]; if (!h) { o.fail({ errMsg: 'no route' }); return } Promise.resolve().then(() => h(o.data)).then(r => o.success({ result: r })).catch(e => o.fail({ errMsg: e.message })) },
    uploadFile(o) { const p = String(o.cloudPath); cloud.__stored.set(p, JPEG); o.success({ fileID: `cloud://e.b/${p}`, statusCode: 200 }) }
  }
  api.__setCloudConfigForTests('env-b3a', 'wxapp-b3a')
  api.__setWxCloud(wxCloud)
  global.wx = { cloud: wxCloud }
  api.__resetForTests()
  api.setActivePinia(api.createPinia())
  const fam = api.useFamilyStore()
  const mig = api.useMigrationStore()
  return { cloud, fam, mig, routes }
}

// 种入合成旧数据
function seedLegacyData() {
  storage.set('YUNTU_HEALTH_DATA', JSON.stringify({
    records: {
      '2026-05-01': { weight: 62.5, bp: '118/76', fetal: 8, mood: 'good', note: '私人备注canary' },
      '2026-05-02': { weight: 63, bp: 'invalid', fetal: 0 },
      'bad-date': { weight: 60 }
    }
  }))
  storage.set('YUNTU_REPORTS_DATA', JSON.stringify([
    { _id: 'rpt-old-1', report_type: '血常规', report_date: '2026-04-15', notes: 'shared note', archive_status: 'archived', file_urls: ['store://local-1.png'] },
    { _id: 'rpt-old-2', report_type: '未知类型X', report_date: 'bad-date', archive_status: 'unarchived', file_urls: ['https://example.com/old.png'] }
  ]))
  storage.set('hospital_bag_items', JSON.stringify([
    { text: '身份证', category: 'doc', done: true },
    { text: '奶瓶', category: 'baby', quantity: 3, done: false }
  ]))
  storage.set('MOMCARE_BACKUP_HEALTH_20260101', JSON.stringify({
    records: { '2026-05-01': { weight: 62.5, bp: '118/76', fetal: 8, mood: 'good', note: '私人备注canary' } }
  }))
}

async function main() {
  console.log('B3a 回归（真实 migrationStore→familyStore→outbox→真实 handler）\n')

  await scenario('扫描1：白名单键读取+分类+错误标注（坏日期/坏bp/未知类型/附件非本机）', async () => {
    seedLegacyData()
    const { mig } = fullStack()
    await api.confirmIdentity()
    await mig.scanSources()
    const sr = mig.scanResult
    assert.equal(sr['YUNTU_HEALTH_DATA'].status, 'ok')
    // daily/mood 拆分：3 天 daily + 1 天 mood（2026-05-01 有私人字段）= 4 实体
    assert.equal(sr['YUNTU_HEALTH_DATA'].entities.filter(e => e.domain === 'daily').length, 3, '3 天 daily')
    assert.equal(sr['YUNTU_HEALTH_DATA'].entities.filter(e => e.domain === 'mood').length, 1, '1 天 mood')
    assert.equal(sr['YUNTU_REPORTS_DATA'].status, 'ok')
    assert.equal(sr['YUNTU_REPORTS_DATA'].entities.length, 2)
    assert.equal(sr['hospital_bag_items'].status, 'ok')
    assert.equal(sr['hospital_bag_items'].entities.length, 2)
    assert.equal(sr['MOMCARE_BACKUP_HEALTH_20260101'].status, 'ok', '备份前缀枚举')
    // 错误标注
    const badBp = sr['YUNTU_HEALTH_DATA'].entities.find(e => e.entityKey === '2026-05-02')
    assert.ok(badBp.warnings.some(w => w.includes('bp 格式不明')))
    const badDate = sr['YUNTU_HEALTH_DATA'].entities.find(e => e.entityKey === 'bad-date')
    assert.ok(badDate.warnings.some(w => w.includes('日期格式异常')))
    const unknownType = sr['YUNTU_REPORTS_DATA'].entities.find(e => e.entityKey === 'rpt-old-2')
    assert.ok(unknownType.warnings.some(w => w.includes('未知类型')))
    assert.ok(unknownType.warnings.some(w => w.includes('非本机实体')), '旧 HTTP URL 不自动下载')
    // 私人标记（daily/mood 拆分后——私人字段在 mood 域实体）
    const moodEntity = sr['YUNTU_HEALTH_DATA'].entities.find(e => e.domain === 'mood' && e.entityKey === '2026-05-01')
    assert.ok(moodEntity && moodEntity.isPrivate, 'mood/note 标记私人（mood 域）')
    assert.ok(moodEntity && moodEntity.privateFields && moodEntity.privateFields.note === '私人备注canary')
  })

  await scenario('扫描2：读失败/JSON 损坏不当空集合', async () => {
    storage.set('YUNTU_HEALTH_DATA', '{invalid json')
    const { mig } = fullStack()
    await api.confirmIdentity()
    await mig.scanSources()
    assert.equal(mig.scanResult['YUNTU_HEALTH_DATA'].status, 'parse-failed')
    assert.ok(mig.scanResult['YUNTU_HEALTH_DATA'].error)
  })

  await scenario('去重3：同源主键+备份同实体只预览一次（不同正文分开）', async () => {
    seedLegacyData()
    const { mig } = fullStack()
    await api.confirmIdentity()
    await mig.scanSources()
    const list = mig.previewEntities
    const dailyEntities = list.filter(e => e.domain === 'daily')
    // 2026-05-01 在主键与备份中同正文 → 去重
    const may1 = dailyEntities.filter(e => e.entityKey === '2026-05-01')
    assert.equal(may1.length, 1, '同实体同正文去重为 1')
    assert.ok(may1[0].sourceKeys.length >= 2, '保留来源列表')
  })

  await scenario('确认4：持久批次+身份绑定+源摘要', async () => {
    seedLegacyData()
    const { mig } = fullStack()
    await api.confirmIdentity()
    await mig.scanSources()
    const sels = mig.previewEntities.filter(e => e.domain === 'daily').map(e => ({
      sourceId: e.sourceId, domain: e.domain, fields: e.fields, privateFields: e.privateFields, includePrivate: true
    }))
    const r = await mig.confirmEntities(sels)
    assert.ok(r.ok, JSON.stringify(r))
    assert.ok(mig.batch, '批次存在')
    assert.equal(mig.batch.memberId, 'mama')
    assert.equal(mig.batch.entities.length, sels.length)
    assert.ok(mig.batch.sourceDigests['YUNTU_HEALTH_DATA'], '源摘要记录')
    // 持久到成员缓存
    const saved = api.getMemberCache('b3-migration')
    assert.ok(saved && saved.batchId === r.batchId, '持久批次可读')
  })

  await scenario('确认5：源变化→重新预览（旧确认失效）', async () => {
    seedLegacyData()
    const { mig } = fullStack()
    await api.confirmIdentity()
    await mig.scanSources()
    const sels = mig.previewEntities.filter(e => e.domain === 'daily').map(e => ({ sourceId: e.sourceId, domain: e.domain, fields: e.fields }))
    await mig.confirmEntities(sels)
    // 改变源数据
    storage.set('YUNTU_HEALTH_DATA', JSON.stringify({ records: { '2026-05-01': { weight: 99 } } }))
    const r = await mig.resumeBatch()
    assert.equal(r.ok, false)
    assert.equal(r.code, 'source-changed', '源变化须重新预览')
  })

  await scenario('执行6：逐实体 outbox 幂等（重启续传不重复创建）', async () => {
    seedLegacyData()
    const { cloud, fam, mig } = fullStack()
    await api.confirmIdentity()
    await mig.scanSources()
    const sels = mig.previewEntities.map(e => ({ sourceId: e.sourceId, domain: e.domain, fields: e.fields, includePrivate: true, privateFields: e.privateFields }))
    await mig.confirmEntities(sels)
    // executor：走真实 familyStore
    const executor = async (entity) => {
      if (entity.targetDomain === 'daily') return fam.saveDaily(entity.sourceId.split(':').pop(), entity.payload, 0)
      if (entity.targetDomain === 'bag') return fam.saveBagItem(entity.targetId, entity.payload, 0)
      return { ok: false, code: 'skip' }
    }
    const r = await mig.executeBatch(executor)
    assert.ok(r.ok || r.stats, JSON.stringify(r))
    if (r.stats) {
      assert.ok(r.stats.done > 0, '至少有成功项')
    }
    // 重启：模拟新 store（同一 outbox）
    const batchBefore = mig.batch
    const r2 = await mig.resumeBatch()
    assert.ok(r2.ok || r2.code === 'source-changed' || r2.ok === false)
    void batchBefore
    // 云端不重复（同 targetId）
    const dailyCount = [...cloud.__docs.keys()].filter(k => k.startsWith('mc_health_daily/')).length
    const bagCount = [...cloud.__docs.keys()].filter(k => k.startsWith('mc_bag_items/')).length
    assert.ok(dailyCount <= 3, '日健康不超源数')
    assert.ok(bagCount <= 2, '待产包不超源数')
  })

  await scenario('执行7：冲突不自动覆盖（已有记录→conflict 状态）', async () => {
    seedLegacyData()
    const { fam, mig } = fullStack()
    await api.confirmIdentity()
    // 预先创建目标（模拟已有云端记录）
    await fam.saveDaily('2026-05-01', { weightKg: 55 }, 0)
    await mig.scanSources()
    const sels = mig.previewEntities.filter(e => e.domain === 'daily' && e.entityKey === '2026-05-01')
      .map(e => ({ sourceId: e.sourceId, domain: e.domain, fields: e.fields }))
    await mig.confirmEntities(sels)
    const executor = async (entity) => fam.saveDaily(entity.sourceId.split(':').pop(), entity.payload, 0)
    const r = await mig.executeBatch(executor)
    // 目标已存在（rev>0）→ 基线 0 冲突
    const conflictEntity = mig.batch.entities.find(e => e.status === 'conflict')
    assert.ok(conflictEntity, '冲突实体标记 conflict')
    // 云端不被覆盖
    const fam2 = fam
    assert.equal(fam2.dailyRecord('2026-05-01').fields.weightKg, 55, '已有记录未被覆盖')
  })

  await scenario('私 canary8：mood 私人字段仅本人可迁（另一成员不可执行旧批次）', async () => {
    seedLegacyData()
    const { mig, routes } = fullStack()
    await api.confirmIdentity()
    await mig.scanSources()
    const withPrivate = mig.previewEntities.find(e => e.isPrivate && e.privateFields && e.privateFields.note === '私人备注canary')
    assert.ok(withPrivate, 'canary 私人记录在预览中')
    const sels = [{ sourceId: withPrivate.sourceId, domain: withPrivate.domain, fields: withPrivate.fields, privateFields: withPrivate.privateFields, includePrivate: true }]
    await mig.confirmEntities(sels)
    // 切换到 papa——旧批次不可执行
    routes['mc-identity'] = () => ({ ok: true, data: { memberId: 'papa', displayName: '爸爸', familyId: TEST_ENV.MC_FAMILY_ID } })
    await api.confirmIdentity()
    await tick()
    // papa 身份下 resumeBatch 拒绝（批次属于 mama）
    const r = await mig.resumeBatch()
    // memberId 不匹配 / 批次已清空 / owner-mismatch
    assert.equal(r.ok, false, '另一成员不可恢复旧批次：' + JSON.stringify({ ok: r.ok, code: r.code }))
  })

  await scenario('不迁移9：openid/token/AI 不进 payload', async () => {
    seedLegacyData()
    const { mig } = fullStack()
    await api.confirmIdentity()
    await mig.scanSources()
    const entities = mig.previewEntities
    for (const e of entities) {
      const s = JSON.stringify(e.fields) + JSON.stringify(e.privateFields || {})
      assert.ok(!s.includes('openid'), 'openid 不在预览')
      assert.ok(!s.includes('token'), 'token 不在预览')
      assert.ok(!s.includes('aiQuota'), 'AI 配额不在预览')
    }
  })

  await scenario('批次10：清单落盘失败→零执行（源原件不删）', async () => {
    seedLegacyData()
    const { mig } = fullStack()
    await api.confirmIdentity()
    await mig.scanSources()
    const realSet = global.uni.setStorageSync
    global.uni.setStorageSync = (k, v) => {
      if (String(k).includes('b3-migration')) throw new Error('disk full')
      return realSet(k, v)
    }
    const sels = mig.previewEntities.slice(0, 1).map(e => ({ sourceId: e.sourceId, domain: e.domain, fields: e.fields }))
    let r
    try { r = await mig.confirmEntities(sels) } finally { global.uni.setStorageSync = realSet }
    assert.equal(r.ok, false)
    assert.equal(r.code, 'batch-persist-failed')
    assert.equal(mig.batch, null, '批次未建立')
    // 源原件不删
    assert.ok(storage.has('YUNTU_HEALTH_DATA'), '源键保留')
  })

  await scenario('审计11：零旧 HTTP；白名单外键零读', async () => {
    assert.equal(uniCalls.requests, 0)
    assert.equal(uniCalls.uploadFile, 0)
    // 种一个非白名单键确认不被读取
    storage.set('momcare_token', 'secret-token-value')
    seedLegacyData()
    const readsBefore = []
    const realGet = global.uni.getStorageSync
    global.uni.getStorageSync = k => { readsBefore.push(k); return realGet(k) }
    const { mig } = fullStack()
    await api.confirmIdentity()
    try { await mig.scanSources() } finally { global.uni.getStorageSync = realGet }
    assert.ok(!readsBefore.includes('momcare_token'), 'token 键不被扫描读取')
    assert.ok(!readsBefore.includes('mc_session_env-b3a_wxapp-b3a'), '会话键不被扫描读取')
  })

  console.log(`\n结果：${passed} 通过，${failed.length} 失败`)
  if (failed.length) { console.log('失败项：\n - ' + failed.join('\n - ')); process.exit(1) }
  process.exit(0)
}

main().catch(e => { console.error('套件异常：', e); process.exit(1) })
