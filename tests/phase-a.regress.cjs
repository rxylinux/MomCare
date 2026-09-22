// 阶段 A 回归测试：验证生产代码在隔离模拟存储/网络下的正确行为。
// 不访问真实网络、不读写真实用户数据、不调用付费接口。
// 运行：node tests/phase-a.regress.cjs
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-regress-'))
const output = path.join(temporary, 'bundle.cjs')
esbuild.buildSync({
  stdin: {
    contents: `export { createPinia, setActivePinia } from 'pinia';
      export * from './stores/health.js'; export * from './stores/report.js';
      export * from './stores/staticData.js';
      export * from './utils/api.js'; export * from './utils/storage.js';
      export * from './utils/backendGate.js';
      export * from './services/sessionService.js'; export * from './services/cloudAdapter.js';
      export * from './utils/cloudConfig.js';`,
    resolveDir: root,
  },
  bundle: true, platform: 'node', format: 'cjs', alias: { '@': root },
  outfile: output, logLevel: 'silent',
})
const api = require(output)

// 历史基线声明：本套件验证阶段 A 的数据安全语义（回滚/幂等/不伪成功），
// 需显式开启已被 R2 集中关闭的旧传输与旧正式存储；生产恒为关闭（见 B1 套件）。
api.__setLegacyHttpEnabledForTests(true)
api.__setLegacyFormalStoresEnabledForTests(true)

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) {
  try { await fn(); pass(name) } catch (e) { fail(name, e) }
}

// ── 隔离环境构造 ──

// ── Phase F 管线接线辅助：report.triggerAiPipeline → toolsStore → mc-tools（真 handler）──
// aiAnswer 给定=注入 mock 成功；cloudFails=true=云调用失败（断网）；缺省=未配置 Key（enabled:false）
const toolsHandler = require(path.join(root, 'dist/cloud-functions/mc-tools/index.js'))
function wireCloudBaseAi(world, { aiAnswer, cloudFails } = {}) {
  const savedWx = global.wx
  // 真 handler 的 mock 云（docs + 可信身份）——ai.analyzeReport 的报告门走真校验
  const docs = new Map()
  docs.set('mc_reports/rpt_ai_probe', { familyId: 'fam-pa', deleted: false, dateKey: '2026-09-12', reportType: 'blood_routine', note: '', attachments: [], revision: 1, updatedBy: 'mama', updatedAt: 1, __v: 1 })
  const ctx = { caller: 'oPFAMAMA', initialized: false }
  const clone = x => JSON.parse(JSON.stringify(x))
  const db = {
    startTransaction: async () => {
      const tx = { reads: new Map(), writes: new Map(), removes: new Set() }
      return {
        collection: c => ({ doc: id => ({
          get: async () => { const e = docs.get(`${c}/${id}`); tx.reads.set(`${c}/${id}`, e ? e.__v : 0); return { data: e ? { ...clone(e), _id: id } : null } },
          set: async ({ data }) => { tx.writes.set(`${c}/${id}`, clone(data)); return { _id: id } },
          remove: async () => { tx.removes.add(`${c}/${id}`); return {} }
        }) }),
        commit: async () => { for (const [k, rv] of tx.reads) { const cur = docs.get(k); if ((cur ? cur.__v : 0) !== rv) { const err = new Error('conflict ' + k); err.errCode = 'CONFLICT'; throw err } } for (const k of tx.removes) docs.delete(k); for (const [k, d2] of tx.writes) { const prev = docs.get(k); docs.set(k, { ...d2, __v: (prev ? prev.__v : 0) + 1 }) } },
        rollback: async () => { tx.writes.clear(); tx.removes.clear() }
      }
    },
    collection: c => ({ doc: id => ({ get: async () => { const e = docs.get(`${c}/${id}`); return { data: e ? { ...clone(e), _id: id } : null } } }) })
  }
  const sdkCloud = {
    DYNAMIC_CURRENT_ENV: Symbol('env'), init() { ctx.initialized = true },
    getWXContext: () => ({ APPID: 'wxtestappid0001', OPENID: ctx.caller }),
    database() { if (!ctx.initialized) throw new Error('init first'); return db }
  }
  toolsHandler.__setCloud(sdkCloud)
  process.env.MC_APPID = 'wxtestappid0001'
  process.env.MC_FAMILY_ID = 'fam-pa'
  process.env.MC_MEMBER_MAMA_OPENID = 'oPFAMAMA'
  process.env.MC_MEMBER_PAPA_OPENID = 'oPFAPAPA'
  delete process.env.DEEPSEEK_API_KEY
  // Phase G：OCR 提供方变量隔离——本套件 probe 报告无附件，但杜绝本机配置泄漏
  delete process.env.MC_OCR_PROVIDER
  delete process.env.MC_OCR_TENCENT_SECRET_ID
  delete process.env.MC_OCR_TENCENT_SECRET_KEY
  world.__aiDocs = docs // 白盒：断言 ai_result 服务端回写

  const cloud = {
    init() {},
    callFunction(o) {
      if (cloudFails) { o.fail({ errMsg: 'cloud.callFunction:fail synthetic offline' }); return }
      Promise.resolve().then(() => toolsHandler.main(o.data))
        .then(r => o.success({ result: r }))
        .catch(e => o.fail({ errMsg: e.message }))
    }
  }
  global.wx = { cloud }
  api.__setWxCloud(cloud)
  api.__setCloudConfigForTests('env-pa', 'wxapp-pa')
  if (aiAnswer !== undefined) {
    toolsHandler.__setAiMock(async () => aiAnswer)
  } else if (!cloudFails) {
    toolsHandler.__setAiMock(null)
  }
  // 已确认成员会话（家庭内真身——绕开 confirmIdentity 网络路径）
  api.__adoptSessionForTests({ memberId: 'mama', displayName: '妈妈', familyId: 'fam-pa' })
  world.__restoreWx = () => { global.wx = savedWx; toolsHandler.__setAiMock(null) }
}

function makeWorld({ requestMode = 'offline', aiPayload = null, serverList = null, failWrites = [] } = {}) {
  const storage = new Map()
  const requests = []
  const writeFailures = new Set(failWrites)
  const readFailures = new Set()
  const writeCounts = new Map()
  const failAfter = new Map() // key -> 前 N 次成功，之后失败
  const world = { storage, requests, requestMode, aiPayload, serverList, navigateBackCount: 0 }
  function isWriteFailure(key) {
    const count = (writeCounts.get(key) || 0) + 1
    writeCounts.set(key, count)
    const after = failAfter.get(key)
    if (after != null && count > after) return true
    for (const entry of writeFailures) {
      if (entry === key) return true
      if (entry.endsWith('*') && key.startsWith(entry.slice(0, -1))) return true
    }
    return false
  }
  global.uni = {
    getStorageSync(key) {
      if (readFailures.has(key)) throw new Error('synthetic read failure: ' + key)
      return storage.has(key) ? storage.get(key) : ''
    },
    setStorageSync(key, value) {
      if (isWriteFailure(key)) throw new Error('synthetic write failure: ' + key)
      storage.set(key, value)
    },
    removeStorageSync: key => storage.delete(key),
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
    showToast: v => world.toasts.push(v && v.title),
    navigateBack: () => { world.navigateBackCount++ },
    showLoading() {}, hideLoading() {},
    request(options) {
      requests.push({ url: options.url, method: options.method })
      const mode = world.requestMode
      if (mode === 'offline') {
        options.fail({ errMsg: 'request:fail synthetic offline' })
      } else if (mode === 'aiPayload') {
        options.success({ statusCode: 200, data: { code: 0, msg: 'ok', data: world.aiPayload } })
      } else if (mode === 'serverList') {
        options.success({ statusCode: 200, data: { code: 0, msg: 'ok', data: world.serverList } })
      } else if (mode === 'serverReject') {
        options.success({ statusCode: 500, data: { code: 1, msg: 'server error' } })
      } else {
        options.success({ statusCode: 200, data: { code: 0, msg: 'ok', data: {} } })
      }
    },
  }
  world.toasts = []
  api.setActivePinia(api.createPinia())
  world.health = api.useHealthStore()
  world.report = api.useReportStore()
  world.failWrites = keys => {
    writeFailures.clear()
    failAfter.clear()
    for (const k of keys) writeFailures.add(k)
  }
  world.failReads = keys => { readFailures.clear(); for (const k of keys) readFailures.add(k) }
  // 再成功写 n 次后，该键开始失败
  world.failWritesAfter = (key, n) => failAfter.set(key, (writeCounts.get(key) || 0) + n)
  return world
}

function seedFormal(w, overrides = {}) {
  const data = {
    schemaVersion: 2,
    origin: 'formal',
    lmpDate: null, dueDate: null,
    userInfo: { nickname: 'synthetic-original', avatar: '🌸', hospital: '', babyNickname: '' },
    records: { '2026-09-10': { weight: '60.0', bp: '110/70', note: 'synthetic real note' } },
    checkupSchedules: [], openid: '', aiInterpretUsage: null,
    ...overrides,
  }
  w.storage.set('YUNTU_HEALTH_DATA', JSON.stringify(data))
  return data
}

const todayKey = (() => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})()

async function main() {
  console.log('阶段 A 回归测试（隔离模拟存储/网络）\n')

  // ── P1-1 网络/请求 ──
  await scenario('request 网络失败按失败传递，不伪造成业务成功', async () => {
    const w = makeWorld()
    await assert.rejects(() => api.request({ url: '/api/reports', method: 'GET' }),
      e => e.networkError === true)
  })

  await scenario('游客 token 不再拦截真实登录请求', async () => {
    const w = makeWorld()
    api.setToken(api.GUEST_TOKEN)
    await assert.rejects(() => api.request({ url: '/api/login', method: 'POST', skipAuthRedirect: true }))
    assert.equal(w.requests.length, 1) // 真实发起了请求，而不是本地假登录
  })

  // ── P1-2/P1-6 演示隔离与正式空档案 ──
  await scenario('正式模式初始化：不注入示例数据、不造身份、不设 token', async () => {
    const w = makeWorld()
    w.health.initializeApp()
    assert.equal(w.health.lmpDate, null)
    assert.equal(w.health.pregInfoSet, false)
    assert.equal(Object.keys(w.health.records).length, 0)
    assert.equal(w.health.checkupSchedules.length, 0)
    assert.equal(api.getToken(), '')
    assert.equal(w.storage.get('momcare_user'), undefined)
    assert.equal(w.health.isLoggedIn, false)
  })

  await scenario('旧版本遗留 guest token 在正式模式下被清除', async () => {
    const w = makeWorld()
    w.storage.set('momcare_token', 'guest_mock_token')
    w.health.initializeApp()
    assert.equal(api.getToken(), '')
  })

  await scenario('enterDemoMode：演示数据写入演示键，正式档案逐字节不变', async () => {
    const w = makeWorld()
    const formalBefore = JSON.stringify(seedFormal(w))
    assert.equal(w.health.enterDemoMode(), true)
    assert.equal(w.storage.get('YUNTU_HEALTH_DATA'), formalBefore)
    assert.equal(w.health.todayWeekInfo.week, 16)
    assert.equal(api.getToken(), api.GUEST_TOKEN)
    const demo = JSON.parse(w.storage.get('MOMCARE_DEMO_HEALTH_DATA'))
    assert.equal(demo.origin, 'demo')
    assert.equal(demo.userInfo.nickname, '幸福准妈妈')
    // 示例记录字段与统计字段一致：血压、胎动可被统计
    assert.equal(w.health.getBpStats().count, 1)
    assert.equal(w.health.getFetalStats().today, 8)
  })

  await scenario('演示模式 AI 解读被明确阻断，不发起请求、不扣次数', async () => {
    const w = makeWorld({ requestMode: 'aiPayload', aiPayload: { overall_summary: 'x' } })
    w.health.enterDemoMode()
    const created = await w.report.createReport({ report_type: 'other', report_date: todayKey })
    const ok = await w.report.triggerAiPipeline(created.id)
    assert.equal(ok, false)
    assert.equal(w.requests.length, 0)
    assert.equal(w.health.aiInterpretQuota.used, 0)
    assert.ok(w.toasts.some(t => /演示模式/.test(t)))
  })

  // ── Codex P1-1：模式标记写入失败 ──
  await scenario('模式标记写入失败时 enterDemoMode 中止，正式数据不变', async () => {
    const w = makeWorld()
    const formalBefore = JSON.stringify(seedFormal(w))
    w.failWrites(['MOMCARE_DATA_MODE'])
    assert.equal(w.health.enterDemoMode(), false)
    assert.equal(w.storage.get('YUNTU_HEALTH_DATA'), formalBefore)
    assert.equal(api.getToken(), '')
    assert.equal(w.storage.get('MOMCARE_DEMO_HEALTH_DATA'), undefined)
  })

  await scenario('模式标记写入失败时 exitSession 中止退出', async () => {
    const w = makeWorld()
    w.health.enterDemoMode()
    w.failWrites(['MOMCARE_DATA_MODE'])
    assert.equal(w.health.exitSession(), false)
    // 仍处于演示会话：状态未重置
    assert.equal(w.health.isLoggedIn, true)
    assert.equal(api.getDataMode(), 'demo')
  })

  await scenario('真实登录 afterRealLogin 在模式写入失败时中止', async () => {
    const w = makeWorld()
    w.health.enterDemoMode()
    w.failWrites(['MOMCARE_DATA_MODE'])
    assert.equal(w.health.afterRealLogin(), false)
    assert.equal(api.getDataMode(), 'demo')
    // 未把演示数据当正式档案加载
    assert.equal(w.health.userInfo.nickname, '幸福准妈妈')
  })

  // ── Codex P1-2：独立备份 ──
  await scenario('仅有历史报告时：报告被独立备份且完成标记如实记录', async () => {
    const w = makeWorld()
    const reportsRaw = JSON.stringify({ reports: [{ _id: 'legacy_r1', archive_status: 'archived' }], unarchivedReports: [] })
    w.storage.set('YUNTU_REPORTS_DATA', reportsRaw)
    api.ensureLegacyBackup()
    const marker = JSON.parse(w.storage.get('MOMCARE_LEGACY_BACKUP_DONE'))
    assert.equal(marker.health_backup, '')
    assert.ok(marker.reports_backup.startsWith('MOMCARE_BACKUP_REPORTS_'))
    assert.equal(w.storage.get(marker.reports_backup), reportsRaw)
    assert.equal(w.storage.get('YUNTU_REPORTS_DATA'), reportsRaw) // 原件不删改
  })

  await scenario('健康+报告同时存在时各自独立备份', async () => {
    const w = makeWorld()
    seedFormal(w)
    w.storage.set('YUNTU_REPORTS_DATA', JSON.stringify({ reports: [], unarchivedReports: [] }))
    api.ensureLegacyBackup()
    const marker = JSON.parse(w.storage.get('MOMCARE_LEGACY_BACKUP_DONE'))
    assert.ok(marker.health_backup.startsWith('MOMCARE_BACKUP_HEALTH_'))
    assert.ok(marker.reports_backup.startsWith('MOMCARE_BACKUP_REPORTS_'))
  })

  await scenario('备份写入失败时不写完成标记，下次可重试', async () => {
    const w = makeWorld()
    seedFormal(w)
    w.failWrites(['MOMCARE_BACKUP_*']) // 所有备份键写入失败
    api.ensureLegacyBackup()
    assert.equal(w.storage.get('MOMCARE_LEGACY_BACKUP_DONE'), undefined)
    // 恢复后再次调用完成备份并写入标记
    w.failWrites([])
    api.ensureLegacyBackup()
    const marker = JSON.parse(w.storage.get('MOMCARE_LEGACY_BACKUP_DONE'))
    assert.ok(marker.health_backup.startsWith('MOMCARE_BACKUP_HEALTH_'))
  })

  // ── P1-4/Codex P1-3：同步合并不覆盖 ──
  await scenario('网络失败时 syncReportsFromCloud 返回 false 且本地状态不动', async () => {
    const w = makeWorld({ requestMode: 'offline' })
    api.setToken('synthetic-real-token')
    seedFormal(w)
    const created = await w.report.createReport({ report_type: 'blood_routine', report_date: todayKey })
    assert.equal(await w.report.syncReportsFromCloud(), false)
    assert.equal(w.report.reports.length, 1)
    assert.equal(w.report.lastSyncStatus, 'network')
  })

  await scenario('空云列表不清除本地新建（_local）报告', async () => {
    const w = makeWorld({ requestMode: 'serverList', serverList: [] })
    api.setToken('synthetic-real-token')
    seedFormal(w)
    const created = await w.report.createReport({ report_type: 'blood_routine', report_date: todayKey })
    assert.equal(created.local, true)
    assert.equal(await w.report.syncReportsFromCloud(), true)
    assert.equal(w.report.reports.length, 1)
  })

  await scenario('空云列表不清除旧版本无标志的本地报告（Codex P1-3）', async () => {
    const w = makeWorld({ requestMode: 'serverList', serverList: [] })
    api.setToken('synthetic-real-token')
    const legacy = { reports: [{ _id: 'legacy_1', archive_status: 'archived', report_date: '2026-09-01', report_type: 'blood_routine' }], unarchivedReports: [] }
    w.storage.set('YUNTU_REPORTS_DATA', JSON.stringify(legacy))
    await w.report.fetchReports()
    assert.equal(w.report.reports.length, 1)
    assert.equal(await w.report.syncReportsFromCloud(), true)
    assert.equal(w.report.reports.length, 1)
    assert.equal(w.report.reports[0]._originUnverified, true)
    assert.equal(w.report.reports[0]._local, true)
  })

  await scenario('云端已知报告以服务端为准，待同步修改保留本地版本', async () => {
    const serverReport = { _id: 'srv_1', archive_status: 'archived', report_date: '2026-09-01', report_type: 'blood_routine', notes: 'server notes' }
    const w = makeWorld({ requestMode: 'serverList', serverList: [serverReport] })
    api.setToken('synthetic-real-token')
    seedFormal(w)
    await w.report.syncReportsFromCloud()
    assert.equal(w.report.reports.length, 1)
    // 断网修改 → 待同步
    w.requestMode = 'offline'
    const r = await w.report.updateReport('srv_1', { notes: 'local edit' })
    assert.deepEqual([r.ok, r.synced, r.pendingSync], [true, false, true])
    // 网络恢复后重拉：本地未确认修改不丢
    w.requestMode = 'serverList'
    await w.report.syncReportsFromCloud()
    assert.equal(w.report.reports[0].notes, 'local edit')
    assert.equal(w.report.reports[0]._pendingSync, true)
  })

  // ── P1-1/P2-2：写路径 ──
  await scenario('断网 updateReport：本地保留并标记待同步，不显示云端成功', async () => {
    const w = makeWorld({ requestMode: 'offline' })
    api.setToken('synthetic-real-token')
    seedFormal(w)
    const created = await w.report.createReport({ report_type: 'blood_routine', report_date: todayKey, archive_status: 'unarchived' })
    const r = await w.report.updateReport(created.id, { notes: 'offline note' })
    assert.deepEqual([r.ok, r.synced, r.pendingSync], [true, false, true])
    assert.equal(w.report.unarchivedReports[0].notes, 'offline note')
    // 重启后仍在（持久化）
    const persisted = JSON.parse(w.storage.get('YUNTU_REPORTS_DATA'))
    assert.equal(persisted.unarchivedReports[0]._pendingSync, true)
  })

  await scenario('分类归档 updateReport 正确迁移数组（P2-2）', async () => {
    const w = makeWorld({ requestMode: 'offline' })
    api.setToken('synthetic-real-token')
    seedFormal(w)
    const created = await w.report.createReport({ report_type: 'other', report_date: todayKey, archive_status: 'unarchived' })
    await w.report.updateReport(created.id, { archive_status: 'archived' })
    assert.equal(w.report.unarchivedReports.length, 0)
    assert.equal(w.report.reports.length, 1)
    assert.equal(w.report.reports[0].archive_status, 'archived')
  })

  await scenario('服务端拒绝时 updateReport 不落本地假状态', async () => {
    const serverReport = { _id: 'srv_5', archive_status: 'unarchived', report_date: todayKey, notes: '' }
    const w = makeWorld({ requestMode: 'serverList', serverList: [serverReport] })
    api.setToken('synthetic-real-token')
    seedFormal(w)
    await w.report.syncReportsFromCloud()
    w.requestMode = 'serverReject'
    const r = await w.report.updateReport('srv_5', { notes: 'should not apply' })
    assert.equal(r.ok, false)
    assert.notEqual(w.report.unarchivedReports[0].notes, 'should not apply')
  })

  await scenario('云端删除失败时本地报告保留且不显示删除成功', async () => {
    const serverReport = { _id: 'srv_2', archive_status: 'unarchived', report_date: todayKey }
    const w = makeWorld({ requestMode: 'serverList', serverList: [serverReport] })
    api.setToken('synthetic-real-token')
    seedFormal(w)
    // 先建立服务端可信来源，删除才会走云端确认路径
    await w.report.syncReportsFromCloud()
    w.requestMode = 'offline'
    const r = await w.report.deleteReport('srv_2')
    assert.equal(r.ok, false)
    assert.equal(w.report.unarchivedReports.length, 1)
  })

  // ── Codex P1-4：AI 校验 ──
  await scenario('断网 AI 解读：不成功、状态不标完成、不扣次数（Phase F 管线）', async () => {
    const w = makeWorld({ requestMode: 'offline' })
    api.setToken('synthetic-real-token')
    seedFormal(w)
    const created = await w.report.createReport({ report_type: 'blood_routine', report_date: todayKey })
    wireCloudBaseAi(w, { cloudFails: true })
    w.report.reports[0] = { ...w.report.reports[0], _id: 'rpt_ai_probe' }
    const ok = await w.report.triggerAiPipeline('rpt_ai_probe')
    assert.equal(ok, false)
    assert.notEqual(w.report.reports[0].ai_status, 'done')
    assert.equal(w.health.aiInterpretQuota.used, 0)
    assert.ok(!w.toasts.includes('解读完成'))
  })

  await scenario('AI 空结果不标记完成、不扣次数', async () => {
    const w = makeWorld({ requestMode: 'aiPayload', aiPayload: {} })
    api.setToken('synthetic-real-token')
    seedFormal(w)
    const created = await w.report.createReport({ report_type: 'blood_routine', report_date: todayKey })
    const ok = await w.report.triggerAiPipeline(created.id)
    assert.equal(ok, false)
    assert.notEqual(w.report.reports[0].ai_status, 'done')
    assert.equal(w.health.aiInterpretQuota.used, 0)
  })

  await scenario('仅 OCR 文本不构成 AI 解读成功（Codex P1-4）', async () => {
    const w = makeWorld({ requestMode: 'aiPayload', aiPayload: { ocr_text: 'synthetic OCR only, no AI analysis', image_url: 'https://x/y.png' } })
    api.setToken('synthetic-real-token')
    seedFormal(w)
    const created = await w.report.createReport({ report_type: 'blood_routine', report_date: todayKey })
    const ok = await w.report.triggerAiPipeline(created.id)
    assert.equal(ok, false)
    assert.notEqual(w.report.reports[0].ai_status, 'done')
    assert.equal(w.health.aiInterpretQuota.used, 0)
    assert.equal(api.isValidAiResult({ ocr_text: 'text only' }), false)
    assert.equal(api.hasValidOcrText({ ocr_text: 'text only' }), true)
  })

  await scenario('错误对象/畸形指标列表/空建议均不构成成功', async () => {
    assert.equal(api.isValidAiResult({ error: 'model timeout' }), false)
    assert.equal(api.isValidAiResult({ status: 'failed' }), false)
    assert.equal(api.isValidAiResult({ report_type: '解析失败', raw_text: 'xx' }), false)
    assert.equal(api.isValidAiResult({ abnormal_indicators: 'not-a-list' }), false)
    assert.equal(api.isValidAiResult({ abnormal_indicators: ['plain string'] }), false)
    assert.equal(api.isValidAiResult({ abnormal_indicators: [] , action_suggestions: [] }), false)
    assert.equal(api.isValidAiResult(null), false)
  })

  await scenario('结构有效的 AI 结果标记完成并扣一次（Phase F 管线 mock）', async () => {
    const payload = {
      overall_summary: '各项指标大体平稳',
      abnormal_indicators: [{ name: '血红蛋白', value: '105', severity: 'warning', reference_range: '115-150', explanation: '轻度偏低' }],
      action_suggestions: ['两周后复查血常规'],
      ocr_text: '血常规报告原文……',
      image_url: 'https://x/y.png',
    }
    void payload
    const w = makeWorld({ requestMode: 'aiPayload', aiPayload: payload })
    api.setToken('synthetic-real-token')
    seedFormal(w)
    const created = await w.report.createReport({ report_type: 'blood_routine', report_date: todayKey })
    wireCloudBaseAi(w, { aiAnswer: '各项指标大体平稳' })
    // 本地报告改用服务端在场的 rpt_ai_probe（analyzeReport 权威门校验家庭归属）
    w.report.reports[0] = { ...w.report.reports[0], _id: 'rpt_ai_probe' }
    const ok = await w.report.triggerAiPipeline('rpt_ai_probe')
    assert.equal(ok, true)
    // 2026-09-22 起family 模式解读完成态以云端为权威：旧本地库不再标记（B3 隔离恒拒写）
    assert.ok(w.report.reports[0].ai_status !== 'done', '旧本地库不再标记完成（云端权威）')
    const srv = w.__aiDocs.get('mc_reports/rpt_ai_probe')
    assert.ok(srv && srv.ai_result && String(srv.ai_result.text).includes('各项指标大体平稳'), '云端 ai_result 回写为完成态权威')
    assert.equal(w.health.aiInterpretQuota.used, 1)
  })

  // ── P1-7：存储失败可见 ──
  await scenario('存储写盘失败：saveRecord 返回未持久化，内存保留，持久层不变', async () => {
    const w = makeWorld()
    seedFormal(w)
    const before = w.storage.get('YUNTU_HEALTH_DATA')
    w.failWrites(['YUNTU_HEALTH_DATA'])
    const r = await w.health.saveRecord(new Date(), { note: 'synthetic unsaved note' })
    assert.equal(r.persisted, false)
    assert.equal(w.storage.get('YUNTU_HEALTH_DATA'), before)
    assert.equal(w.health.getRecord(new Date()).note, 'synthetic unsaved note') // 内存不丢
    assert.ok(w.health.lastPersistError.length > 0) // 可观测
  })

  await scenario('存储恢复后重试保存成功落盘', async () => {
    const w = makeWorld()
    seedFormal(w)
    w.failWrites(['YUNTU_HEALTH_DATA'])
    await w.health.saveRecord(new Date(), { note: 'retry note' })
    w.failWrites([])
    const r = await w.health.saveRecord(new Date(), { note: 'retry note' })
    assert.equal(r.persisted, true)
    const persisted = JSON.parse(w.storage.get('YUNTU_HEALTH_DATA'))
    assert.ok(persisted.records[todayKey])
  })

  // ── P2-1：日期与产检迁移 ──
  await scenario('isDueDate 与预产期比较（而非今天）', async () => {
    const w = makeWorld()
    seedFormal(w)
    const due = new Date(2026, 11, 1)
    w.health.dueDate = due
    assert.equal(w.health.isDueDate(new Date(2026, 11, 1)), true)
    assert.equal(w.health.isDueDate(new Date()), false)
  })

  await scenario('refreshToday 跨日刷新孕周', async () => {
    const w = makeWorld()
    seedFormal(w, { lmpDate: new Date(2026, 0, 1).toISOString() })
    w.health.loadUserProfile()
    const weekBefore = w.health.todayWeekInfo.week
    // 前进 10 天：孕周应按新日期重算
    const future = new Date(); future.setDate(future.getDate() + 10)
    w.health.refreshToday(future)
    const expected = api.calcWeekInfo(new Date(2026, 0, 1), future)
    assert.equal(w.health.todayWeekInfo.week, expected.week)
    assert.ok(w.health.todayWeekInfo.week > weekBefore)
  })

  await scenario('修改末次月经迁移未完成产检，保留完成/手动/已勾选', async () => {
    const w = makeWorld()
    seedFormal(w, { lmpDate: new Date(2026, 0, 1).toISOString() })
    w.health.loadUserProfile()
    await w.health.saveUserProfile() // 初始化标准日程
    assert.ok(w.health.checkupSchedules.length >= 10)

    const week7 = w.health.checkupSchedules.find(s => s.week_of_pregnancy === 7)
    await w.health.toggleExamItem(week7._id, 0) // 勾选一个项目
    const week12 = w.health.checkupSchedules.find(s => s.week_of_pregnancy === 12)
    await w.health.markCheckupCompleted(week12._id) // 完成一次产检
    const week17 = w.health.checkupSchedules.find(s => s.week_of_pregnancy === 17)
    week17.date_manually_set = true // 手动约定日期

    const oldWeek12Date = week12.checkup_date
    const oldWeek17Date = week17.checkup_date

    // 调整末次月经 +30 天并保存 → 触发迁移
    w.health.lmpDate = new Date(2026, 0, 31)
    await w.health.saveUserProfile()

    const after = w.health.checkupSchedules
    const newWeek7 = after.find(s => s.week_of_pregnancy === 7)
    const newWeek12 = after.find(s => s.week_of_pregnancy === 12)
    const newWeek17 = after.find(s => s.week_of_pregnancy === 17)

    assert.equal(newWeek7.checkup_date, '2026-03-14') // 未完成的按新日期重算
    assert.equal(newWeek7.exam_items[0].done, true)   // 勾选保留
    assert.equal(newWeek12.checkup_date, oldWeek12Date) // 完成历史不动
    assert.equal(newWeek12.status, 'completed')
    assert.equal(newWeek17.checkup_date, oldWeek17Date) // 手动日期不动
  })

  // ── P2-3：静态数据 ──
  await scenario('静态内容打包加载：无网络请求即 loaded 且有内容', async () => {
    const w = makeWorld({ requestMode: 'offline' })
    const staticData = api.useStaticDataStore()
    await staticData.loadData()
    assert.equal(staticData.loaded, true)
    assert.equal(staticData.loadError, false)
    assert.ok(staticData.dailyData.length > 100)
    assert.ok(staticData.weeklyGuideData.length > 30)
    assert.equal(w.requests.length, 0)
    assert.ok(staticData.getWeeklyGuide(16))
  })

  // ── 旧数据保护 ──
  await scenario('升级时不删除旧正式数据，标记为未确认来源', async () => {
    const w = makeWorld()
    const raw = JSON.stringify({ lmpDate: new Date(2026, 0, 1).toISOString(), records: { '2026-09-10': { weight: '60' } }, userInfo: { nickname: 'old user' } }) // 无 schemaVersion 的旧格式
    w.storage.set('YUNTU_HEALTH_DATA', raw)
    w.health.initializeApp()
    // 原数据仍可用（未删除、未清洗）
    assert.equal(w.health.userInfo.nickname, 'old user')
    assert.equal(w.health.getWeightStats().count, 1)
    // 已留备份
    const marker = JSON.parse(w.storage.get('MOMCARE_LEGACY_BACKUP_DONE'))
    assert.ok(marker.health_backup)
  })

  // ── 第二批（Codex review P1）：清除链路、保存链路、persist 契约、同周多记录 ──

  await scenario('演示模式清数据：只清演示键，正式数据逐字节不变（Codex P1-A）', async () => {
    const w = makeWorld()
    const formalBefore = JSON.stringify(seedFormal(w))
    w.health.enterDemoMode()
    assert.equal(w.health.clearLocalData().ok, true)
    assert.equal(w.storage.get('YUNTU_HEALTH_DATA'), formalBefore)
    assert.ok(w.storage.get('MOMCARE_BACKUP_HEALTH_') === undefined)
    assert.equal(w.storage.has('MOMCARE_DEMO_HEALTH_DATA'), false)
    // 内存已重置（演示态不再残留）
    assert.equal(w.health.lmpDate, null)
    assert.equal(Object.keys(w.health.records).length, 0)
    assert.equal(w.report.reports.length, 0)
  })

  await scenario('正式模式清数据：备份成功后清除并全量重置内存，旧内容不回写', async () => {
    const w = makeWorld()
    seedFormal(w, { lmpDate: new Date(2026, 0, 1).toISOString() })
    w.storage.set('YUNTU_REPORTS_DATA', JSON.stringify({ reports: [], unarchivedReports: [] }))
    w.health.initializeApp()
    const r = w.health.clearLocalData()
    assert.equal(r.ok, true)
    assert.equal(w.storage.has('YUNTU_HEALTH_DATA'), false)
    assert.equal(w.storage.has('YUNTU_REPORTS_DATA'), false)
    // 至少存在一份包含原始内容的备份（升级快照/清除前备份共用前缀，时间戳可能同毫秒）
    const backups = [...w.storage.keys()].filter(k => /^MOMCARE_BACKUP_HEALTH_/.test(k))
    assert.ok(backups.length >= 1)
    assert.ok(backups.some(k => String(w.storage.get(k)).includes('synthetic-original')))
    // 档案/身份字段全量重置
    assert.equal(w.health.lmpDate, null)
    assert.equal(w.health.userInfo.nickname, '')
    assert.equal(w.health.checkupSchedules.length, 0)
    // 后续任意持久化不再把旧内容写回正式键
    await w.health.saveRecord(new Date(), { note: 'after clear' })
    const persisted = JSON.parse(w.storage.get('YUNTU_HEALTH_DATA'))
    assert.equal(persisted.userInfo.nickname, '')
    assert.equal(persisted.records['2026-09-10'], undefined)
  })

  await scenario('正式模式清数据：备份写入失败则不清除', async () => {
    const w = makeWorld()
    const before = JSON.stringify(seedFormal(w))
    w.health.loadUserProfile()
    w.failWrites(['MOMCARE_BACKUP_*'])
    const r = w.health.clearLocalData()
    assert.equal(r.ok, false)
    assert.equal(w.storage.get('YUNTU_HEALTH_DATA'), before)
    assert.equal(w.health.userInfo.nickname, 'synthetic-original')
  })

  await scenario('saveUserProfile 写盘失败返回 ok:false（Codex P1-B）', async () => {
    const w = makeWorld()
    seedFormal(w)
    w.health.loadUserProfile()
    w.health.userInfo.nickname = 'new name'
    w.failWrites(['YUNTU_HEALTH_DATA'])
    const r = await w.health.saveUserProfile()
    assert.equal(r.ok, false)
    // 内存保留新值，持久层未变
    assert.equal(w.health.userInfo.nickname, 'new name')
    assert.ok(JSON.parse(w.storage.get('YUNTU_HEALTH_DATA')).userInfo.nickname !== 'new name')
  })

  await scenario('产检迁移二次写入失败时 saveUserProfile 仍如实返回 ok:false', async () => {
    const w = makeWorld()
    seedFormal(w, { lmpDate: new Date(2026, 0, 1).toISOString() })
    w.health.loadUserProfile()
    await w.health.saveUserProfile() // 初始化日程
    // 允许下一次写入（资料落盘）成功，之后的写入（迁移落盘）失败
    w.failWritesAfter('YUNTU_HEALTH_DATA', 1)
    w.health.lmpDate = new Date(2026, 0, 31)
    const r = await w.health.saveUserProfile()
    assert.equal(r.ok, false)
    assert.equal(r.schedulesMigrated, true)
    // 迁移结果已在内存（下次成功写盘会带出），持久层仍是旧日程
    assert.equal(w.health.checkupSchedules.find(s => s.week_of_pregnancy === 7).checkup_date, '2026-03-14')
  })

  await scenario('createReport 本地写盘失败返回 persisted:false 且回滚内存记录', async () => {
    const w = makeWorld()
    seedFormal(w)
    w.failWrites(['YUNTU_REPORTS_DATA'])
    const created = await w.report.createReport({ report_type: 'blood_routine', report_date: todayKey })
    assert.ok(created.id)
    assert.equal(created.persisted, false)
    assert.ok(created.message.includes('本机保存失败'))
    // 内存记录已回滚（页面草稿保留输入，重试不产生重复）、持久层没有
    assert.equal(w.report.reports.length, 0)
    assert.equal(w.storage.has('YUNTU_REPORTS_DATA'), false)
    assert.ok(w.report.lastPersistError.length > 0)
  })

  await scenario('updateReport 云端成功但本机缓存写失败：如实返回 synced/persisted', async () => {
    const serverReport = { _id: 'srv_9', archive_status: 'unarchived', report_date: todayKey, notes: 'server notes' }
    const w = makeWorld({ requestMode: 'serverList', serverList: [serverReport] })
    api.setToken('synthetic-real-token')
    seedFormal(w)
    // 先完成一次成功下行同步：服务端版本为可信来源（读取边界的未确认标记被替换）
    await w.report.syncReportsFromCloud()
    w.failWrites(['YUNTU_REPORTS_DATA'])
    const r = await w.report.updateReport('srv_9', { notes: 'cloud ok, cache fail' })
    assert.deepEqual([r.ok, r.synced, r.persisted], [true, true, false])
    assert.ok(r.message.includes('本机缓存写入失败'))
    // 内存已更新
    assert.equal(w.report.unarchivedReports[0].notes, 'cloud ok, cache fail')
  })

  await scenario('syncReportsFromCloud 云端成功但本机写失败：返回 false 且状态可见', async () => {
    const w = makeWorld({ requestMode: 'serverList', serverList: [] })
    api.setToken('synthetic-real-token')
    seedFormal(w)
    const created = await w.report.createReport({ report_type: 'blood_routine', report_date: todayKey })
    w.failWrites(['YUNTU_REPORTS_DATA'])
    assert.equal(await w.report.syncReportsFromCloud(), false)
    assert.equal(w.report.lastSyncStatus, 'persist')
    // 内存合并结果仍在（本地报告未丢）
    assert.equal(w.report.reports.length, 1)
  })

  await scenario('deleteReport 本地删除但写盘失败：返回 persisted:false', async () => {
    const w = makeWorld()
    seedFormal(w)
    const created = await w.report.createReport({ report_type: 'other', report_date: todayKey, archive_status: 'unarchived' })
    w.failWrites(['YUNTU_REPORTS_DATA'])
    const r = await w.report.deleteReport(created.id)
    assert.equal(r.ok, true)
    assert.equal(r.persisted, false)
    assert.ok(r.message.includes('本机写入失败'))
    assert.equal(w.report.unarchivedReports.length, 0) // 内存已删
  })

  await scenario('AI 解读成功但本机写盘失败：family 云端权威——无误报且仍算解读完成', async () => {
    const payload = { overall_summary: 'ok', abnormal_indicators: [], action_suggestions: [] }
    const w = makeWorld({ requestMode: 'aiPayload', aiPayload: payload })
    api.setToken('synthetic-real-token')
    seedFormal(w)
    const created = await w.report.createReport({ report_type: 'blood_routine', report_date: todayKey })
    w.failWrites(['YUNTU_REPORTS_DATA'])
    wireCloudBaseAi(w, { aiAnswer: '综合解读：整体正常，个别指标建议复诊。' })
    w.report.reports[0] = { ...w.report.reports[0], _id: 'rpt_ai_probe' }
    const ok = await w.report.triggerAiPipeline('rpt_ai_probe')
    assert.equal(ok, true)
    // 2026-09-22 误报修复回归：旧库被 B3 隔离恒拒写，family 模式不得再报"本机保存失败"
    assert.ok(!w.toasts.some(t => /本机保存失败/.test(t)), '无误报 toast')
    assert.ok(w.toasts.some(t => t === '解读完成'), '如实提示解读完成')
    assert.equal(w.health.aiInterpretQuota.used, 1)
    assert.ok(w.__aiDocs.get('mc_reports/rpt_ai_probe').ai_result, '云端权威持久化在场')
  })

  await scenario('同孕周两条历史记录迁移后全部保留（Codex P1-C）', async () => {
    const w = makeWorld()
    seedFormal(w, { lmpDate: new Date(2026, 0, 1).toISOString() })
    w.health.loadUserProfile()
    await w.health.saveUserProfile()
    // 追加同孕周(17)的第二条完成记录，_id/日期不同
    const first17 = w.health.checkupSchedules.find(s => s.week_of_pregnancy === 17)
    const dup = { ...first17, _id: 'custom_17_extra', checkup_date: '2026-04-20', status: 'completed' }
    w.health.checkupSchedules.push(dup)
    const countBefore = w.health.checkupSchedules.length
    w.health.lmpDate = new Date(2026, 0, 31)
    const r = await w.health.saveUserProfile()
    assert.equal(r.ok, true)
    const after = w.health.checkupSchedules
    assert.equal(after.length, countBefore) // 数量不丢
    const week17s = after.filter(s => s.week_of_pregnancy === 17)
    assert.equal(week17s.length, 2)
    assert.ok(week17s.some(s => s._id === 'custom_17_extra' && s.checkup_date === '2026-04-20'))
  })

  await scenario('同孕周历史+新安排：仅模板安排重算，历史保留', async () => {
    const w = makeWorld()
    seedFormal(w, { lmpDate: new Date(2026, 0, 1).toISOString() })
    w.health.loadUserProfile()
    await w.health.saveUserProfile()
    const slot = w.health.checkupSchedules.find(s => s.week_of_pregnancy === 21)
    // 同孕周追加一条完成历史（不同 _id/日期，避免与模板生成 id 撞号）；模板槽位保持 upcoming
    w.health.checkupSchedules.push({ ...slot, _id: 'local_21_2026-08-15', status: 'completed', checkup_date: '2026-08-15' })
    const countBefore = w.health.checkupSchedules.length
    w.health.lmpDate = new Date(2026, 0, 31)
    await w.health.saveUserProfile()
    const week21s = w.health.checkupSchedules.filter(s => s.week_of_pregnancy === 21)
    assert.equal(w.health.checkupSchedules.length, countBefore)
    assert.equal(week21s.length, 2)
    // completed 历史原样；upcoming 模板槽位重算到新日期（2026-01-31 + 147 天）
    const done = week21s.find(s => s.status === 'completed')
    assert.equal(done.checkup_date, '2026-08-15')
    const up = week21s.find(s => s.status === 'upcoming')
    assert.equal(up.checkup_date, '2026-06-27')
  })

  await scenario('非模板孕周的自定义安排迁移后保留', async () => {
    const w = makeWorld()
    seedFormal(w, { lmpDate: new Date(2026, 0, 1).toISOString() })
    w.health.loadUserProfile()
    await w.health.saveUserProfile()
    const countBefore = w.health.checkupSchedules.length + 1
    w.health.checkupSchedules.push({
      _id: 'custom_extra_18', checkup_date: '2026-05-20', week_of_pregnancy: 18,
      week_label: '孕18周(额外)', status: 'upcoming', exam_items: []
    })
    w.health.lmpDate = new Date(2026, 0, 31)
    await w.health.saveUserProfile()
    assert.equal(w.health.checkupSchedules.length, countBefore)
    const custom = w.health.checkupSchedules.find(s => s._id === 'custom_extra_18')
    assert.equal(custom.checkup_date, '2026-05-20') // 非模板 id：不重算
  })

  // ── 第三批（Codex review R3）：真实页面处理函数 + 存储失败 ──

  // 从 .vue 文件源码提取真实处理函数（花括号配对），以 new Function 注入依赖后执行
  function extractPageFn(relPath, fnName, deps) {
    const source = fs.readFileSync(path.join(root, relPath), 'utf8')
    const markers = [`async function ${fnName}(`, `function ${fnName}(`]
    let start = -1
    for (const marker of markers) {
      const idx = source.indexOf(marker)
      if (idx !== -1) { start = idx; break }
    }
    assert.ok(start !== -1, `${relPath} 中未找到函数 ${fnName}`)
    const braceStart = source.indexOf('{', start)
    let depth = 0
    let end = -1
    for (let i = braceStart; i < source.length; i++) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') {
        depth--
        if (depth === 0) { end = i + 1; break }
      }
    }
    assert.ok(end !== -1, `${fnName} 花括号配对失败`)
    const fnSource = source.slice(start, end)
    return new Function(...deps, `return (${fnSource});`)
  }

  // 让页面函数里的 setTimeout 立即执行；必须等整个异步链完成后再还原，
  // 否则页面尾部的延迟回调（navigateBack）会被恢复成真实定时器
  async function withImmediateTimers(fn) {
    const realSetTimeout = global.setTimeout
    global.setTimeout = cb => { cb(); return 0 }
    try {
      return await fn()
    } finally {
      global.setTimeout = realSetTimeout
    }
  }

  await scenario('R3-页面函数：batch 全未选分支存储失败不清草稿、不返回，重试不重复', async () => {
    const w = makeWorld()
    seedFormal(w)
    const parseDateText = extractPageFn('pages/archives/batch.vue', 'parseDateText', ['dateText'])()
    // B2b2 调整说明：batch.vue confirmArchive 增加 family 权威分支，新增依赖
    // isFamilyMode/reportFamilyStore/familyStore/upload；此处注入 family=false 走原 legacy
    // 分支，原断言不变。
    const confirmArchive = extractPageFn('pages/archives/batch.vue', 'confirmArchive',
      ['isArchiving', 'items', 'reportStore', 'uni', 'parseDateText', 'legacyHttpEnabled',
       'isFamilyMode', 'reportFamilyStore', 'familyStore', 'upload'])

    w.report.pendingUpload = {
      fileUrls: ['srv://img1'], localPaths: ['local1'],
      items: [{ report_id: 'srvA', image_url: 'srv://img1' }],
      fileType: 'image', fileCount: 1
    }
    const items = { value: [{
      id: 0, fileUrl: 'srv://img1', reportId: 'srvA', reportType: 'blood_routine',
      dateText: '2026/09/19', weekText: '', selected: false, needsConfirm: false
    }] }
    const isArchiving = { value: false }

    w.failWrites(['YUNTU_REPORTS_DATA'])
    const runArchive1 = confirmArchive(isArchiving, items, w.report, global.uni, parseDateText, () => false, () => false, null, null, null)
    await withImmediateTimers(() => runArchive1())
    // 失败：不清草稿、不离开页面、失败项保留
    assert.equal(w.navigateBackCount, 0)
    assert.ok(w.report.pendingUpload !== null)
    assert.equal(items.value[0].createdId, undefined)
    assert.ok(w.toasts.some(t => /保存失败/.test(t)))
    // 存储恢复后重试：成功、无重复、清草稿并返回
    w.failWrites([])
    const runArchive2 = confirmArchive(isArchiving, items, w.report, global.uni, parseDateText, () => false, () => false, null, null, null)
    await withImmediateTimers(() => runArchive2())
    assert.equal(w.navigateBackCount, 1)
    assert.equal(w.report.pendingUpload, null)
    assert.equal(w.report.unarchivedReports.length, 1)
    assert.ok(items.value[0].createdId)
  })

  await scenario('R3-页面函数：batch 选中分支存储失败留页，重试幂等不重复入档', async () => {
    const w = makeWorld()
    seedFormal(w)
    const parseDateText = extractPageFn('pages/archives/batch.vue', 'parseDateText', ['dateText'])()
    // B2b2 调整说明：batch.vue confirmArchive 增加 family 权威分支，新增依赖
    // isFamilyMode/reportFamilyStore/familyStore/upload；此处注入 family=false 走原 legacy
    // 分支，原断言不变。
    const confirmArchive = extractPageFn('pages/archives/batch.vue', 'confirmArchive',
      ['isArchiving', 'items', 'reportStore', 'uni', 'parseDateText', 'legacyHttpEnabled',
       'isFamilyMode', 'reportFamilyStore', 'familyStore', 'upload'])

    w.report.pendingUpload = {
      fileUrls: ['srv://img2'], localPaths: ['local2'],
      items: [{ report_id: 'srvB', image_url: 'srv://img2' }],
      fileType: 'image', fileCount: 1
    }
    const items = { value: [{
      id: 0, fileUrl: 'srv://img2', reportId: 'srvB', reportType: 'ultrasound',
      dateText: '2026/09/19', weekText: '', selected: true, needsConfirm: false
    }] }
    const isArchiving = { value: false }

    w.failWrites(['YUNTU_REPORTS_DATA'])
    const runArchive3 = confirmArchive(isArchiving, items, w.report, global.uni, parseDateText, () => false, () => false, null, null, null)
    await withImmediateTimers(() => runArchive3())
    assert.equal(w.navigateBackCount, 0)
    assert.ok(w.report.pendingUpload !== null)
    assert.equal(w.report.reports.length, 0)

    w.failWrites([])
    const runArchive4 = confirmArchive(isArchiving, items, w.report, global.uni, parseDateText, () => false, () => false, null, null, null)
    await withImmediateTimers(() => runArchive4())
    assert.equal(w.navigateBackCount, 1)
    assert.equal(w.report.pendingUpload, null)
    // 恰好一份，未重复创建
    assert.equal(w.report.reports.length, 1)
    assert.equal(w.report.reports[0].report_type, 'ultrasound')
  })

  await scenario('R3-页面函数：batch 部分成功后重试只补失败项，成功项不重复', async () => {
    const w = makeWorld()
    seedFormal(w)
    const parseDateText = extractPageFn('pages/archives/batch.vue', 'parseDateText', ['dateText'])()
    // B2b2 调整说明：batch.vue confirmArchive 增加 family 权威分支，新增依赖
    // isFamilyMode/reportFamilyStore/familyStore/upload；此处注入 family=false 走原 legacy
    // 分支，原断言不变。
    const confirmArchive = extractPageFn('pages/archives/batch.vue', 'confirmArchive',
      ['isArchiving', 'items', 'reportStore', 'uni', 'parseDateText', 'legacyHttpEnabled',
       'isFamilyMode', 'reportFamilyStore', 'familyStore', 'upload'])

    w.report.pendingUpload = {
      fileUrls: ['srv://a', 'srv://b'], localPaths: ['la', 'lb'],
      items: [{ report_id: 'srvA', image_url: 'srv://a' }, { report_id: 'srvB', image_url: 'srv://b' }],
      fileType: 'image', fileCount: 2
    }
    const items = { value: [
      { id: 0, fileUrl: 'srv://a', reportId: 'srvA', reportType: 'blood_routine', dateText: '2026/09/18', selected: true, needsConfirm: false },
      { id: 1, fileUrl: 'srv://b', reportId: 'srvB', reportType: 'urine', dateText: '2026/09/19', selected: true, needsConfirm: false }
    ] }
    const isArchiving = { value: false }

    // 第一项成功、第二项失败：第 1 次写允许成功，之后失败
    w.failWritesAfter('YUNTU_REPORTS_DATA', 1)
    const runArchive5 = confirmArchive(isArchiving, items, w.report, global.uni, parseDateText, () => false, () => false, null, null, null)
    await withImmediateTimers(() => runArchive5())
    assert.equal(w.navigateBackCount, 0)
    assert.ok(w.report.pendingUpload !== null)
    assert.ok(items.value[0].createdId, '第一项应已保存成功')
    assert.equal(items.value[1].createdId, undefined)

    w.failWrites([])
    const runArchive6 = confirmArchive(isArchiving, items, w.report, global.uni, parseDateText, () => false, () => false, null, null, null)
    await withImmediateTimers(() => runArchive6())
    assert.equal(w.navigateBackCount, 1)
    // 两项各一份，成功项未重复
    assert.equal(w.report.reports.length, 2)
    assert.equal(w.report.reports.filter(r => r.report_type === 'blood_routine').length, 1)
    assert.equal(w.report.reports.filter(r => r.report_type === 'urine').length, 1)
  })

  await scenario('R3-页面函数：daily-plan 今日计划存储失败回滚勾选并提示', async () => {
    const w = makeWorld()
    seedFormal(w, { records: { [todayKey]: { plans: [{ text: '散步', done: false }] } } })
    w.health.initializeApp()
    const toggleTodayPlan = extractPageFn('pages/profile/daily-plan.vue', 'toggleTodayPlan',
      ['currentPlans', 'healthStore', 'uni'])
    const currentPlans = { get value() { return (w.health.getRecord(new Date()) || {}).plans || [] } }

    w.failWrites(['YUNTU_HEALTH_DATA'])
    await toggleTodayPlan(currentPlans, w.health, global.uni)(0)
    // 勾选被还原，不表现伪完成
    assert.equal(currentPlans.value[0].done, false)
    assert.ok(w.toasts.some(t => /保存失败/.test(t)))

    // 存储恢复后重试成功
    w.failWrites([])
    await toggleTodayPlan(currentPlans, w.health, global.uni)(0)
    assert.equal(currentPlans.value[0].done, true)
    const persisted = JSON.parse(w.storage.get('YUNTU_HEALTH_DATA'))
    assert.equal(persisted.records[todayKey].plans[0].done, true)
  })

  await scenario('R3-页面函数：daily-plan 历史计划存储失败回滚且组状态不变', async () => {
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1)
    const yKey = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`
    const w = makeWorld()
    seedFormal(w, { records: { [yKey]: { plans: [{ text: '产检', done: false }] } } })
    w.health.initializeApp()
    const toggleHistoryPlan = extractPageFn('pages/profile/daily-plan.vue', 'toggleHistoryPlan',
      ['historyPlanGroups', 'healthStore', 'uni'])
    const storePlans = w.health.getRecord(yesterday).plans
    const historyPlanGroups = { value: [{
      dateKey: yKey, plans: storePlans, totalCount: 1, completedCount: 0, allDone: false, expanded: true
    }] }

    w.failWrites(['YUNTU_HEALTH_DATA'])
    await toggleHistoryPlan(historyPlanGroups, w.health, global.uni)(0, 0)
    assert.equal(storePlans[0].done, false)
    assert.equal(historyPlanGroups.value[0].completedCount, 0)
    assert.ok(w.toasts.some(t => /保存失败/.test(t)))

    w.failWrites([])
    await toggleHistoryPlan(historyPlanGroups, w.health, global.uni)(0, 0)
    assert.equal(storePlans[0].done, true)
    assert.equal(historyPlanGroups.value[0].completedCount, 1)
    const persisted = JSON.parse(w.storage.get('YUNTU_HEALTH_DATA'))
    assert.equal(persisted.records[yKey].plans[0].done, true)
  })

  // ── 第三批补充（Codex R3.5）：模式读取报错 fail-closed / 契约链 / draftId 稳定重试 ──

  await scenario('模式键读取报错：saveRecord 拒写，正式档案逐字节不变（Codex P1）', async () => {
    const w = makeWorld()
    const formalBefore = JSON.stringify(seedFormal(w))
    w.report // 初始化 report store
    w.health.enterDemoMode()
    // 演示会话中仅模式键读取抛错，其余读写正常
    w.failReads([api.DATA_MODE_KEY])
    const r = await w.health.saveRecord(new Date(), { note: 'should not leak' })
    assert.equal(r.persisted, false)
    assert.equal(w.storage.get('YUNTU_HEALTH_DATA'), formalBefore)
    // 演示键也未被破坏性改动（写入被拒绝而非换命名空间）
    assert.ok(JSON.parse(w.storage.get('MOMCARE_DEMO_HEALTH_DATA')).userInfo.nickname === '幸福准妈妈')
    // 恢复读取后一切正常
    w.failReads([])
    const ok = await w.health.saveRecord(new Date(), { note: 'demo note' })
    assert.equal(ok.persisted, true)
    assert.equal(w.storage.get('YUNTU_HEALTH_DATA'), formalBefore)
  })

  await scenario('模式键读取报错：报告写入拒绝，正式报告键不变', async () => {
    const w = makeWorld()
    seedFormal(w)
    const formalReports = JSON.stringify({ reports: [{ _id: 'keep_1', archive_status: 'archived' }], unarchivedReports: [] })
    w.storage.set('YUNTU_REPORTS_DATA', formalReports)
    w.health.enterDemoMode()
    w.failReads([api.DATA_MODE_KEY])
    const created = await w.report.createReport({ report_type: 'other', report_date: todayKey })
    assert.equal(created.persisted, false)
    assert.equal(w.report.reports.length, 0)
    assert.equal(w.storage.get('YUNTU_REPORTS_DATA'), formalReports)
  })

  await scenario('模式键读取报错：清除与退出均拒绝执行', async () => {
    const w = makeWorld()
    const formalBefore = JSON.stringify(seedFormal(w))
    w.health.enterDemoMode()
    w.failReads([api.DATA_MODE_KEY])
    const cleared = w.health.clearLocalData()
    assert.equal(cleared.ok, false)
    assert.equal(w.health.exitSession(), false)
    assert.equal(w.storage.get('YUNTU_HEALTH_DATA'), formalBefore)
    assert.ok(w.storage.has('MOMCARE_DEMO_HEALTH_DATA'))
  })

  await scenario('模式键缺失（新安装）≠ 读取报错：默认正式可正常读写', async () => {
    const w = makeWorld()
    assert.equal(api.getDataMode(), 'formal')
    seedFormal(w)
    w.health.loadUserProfile()
    const r = await w.health.saveRecord(new Date(), { note: 'fresh install ok' })
    assert.equal(r.persisted, true)
  })

  await scenario('updateCheckupSchedule 写盘失败返回 false，toggle/complete 回滚', async () => {
    const w = makeWorld()
    seedFormal(w, { lmpDate: new Date(2026, 0, 1).toISOString() })
    w.health.loadUserProfile()
    await w.health.saveUserProfile()
    const schedule = w.health.checkupSchedules[0]
    w.failWrites(['YUNTU_HEALTH_DATA'])
    assert.equal(await w.health.updateCheckupSchedule(schedule._id, { notes: 'x' }), false)
    // 勾选失败回滚
    assert.equal(await w.health.toggleExamItem(schedule._id, 0), false)
    assert.equal(w.health.checkupSchedules[0].exam_items[0].done, false)
    // 标记完成失败回滚为 upcoming
    assert.equal(await w.health.markCheckupCompleted(schedule._id), false)
    assert.equal(w.health.checkupSchedules[0].status, 'upcoming')
    // 恢复后可用
    w.failWrites([])
    assert.equal(await w.health.toggleExamItem(schedule._id, 0), true)
    assert.equal(w.health.checkupSchedules[0].exam_items[0].done, true)
  })

  await scenario('chooseAvatar 写盘失败：头像回滚且不提示成功', async () => {
    const w = makeWorld()
    seedFormal(w)
    w.health.loadUserProfile()
    global.uni.chooseImage = ({ success }) => success({ tempFilePaths: ['tmp://new-avatar.png'] })
    w.failWrites(['YUNTU_HEALTH_DATA'])
    await w.health.chooseAvatar()
    assert.equal(w.health.userInfo.avatar, '🌸') // 回滚
    assert.ok(w.toasts.some(t => /头像保存失败/.test(t)))
    assert.ok(!w.toasts.some(t => t === '头像已更新'))
    delete global.uni.chooseImage
  })

  await scenario('R3.5-页面函数：checkup-reminder 标记完成失败如实提示并还原', async () => {
    const w = makeWorld()
    seedFormal(w, { lmpDate: new Date(2026, 0, 1).toISOString() })
    w.health.loadUserProfile()
    await w.health.saveUserProfile()
    const nextCheckup = { value: w.health.checkupSchedules[0] }
    // B2b1 调整说明：页面 handleMarkCompleted 增加 family/demo/prompt 三态路由，
    // 新增 dataSource/familyStore 依赖；此处以 dataSource='demo' 走原 legacy 分支，
    // 断言不变（失败如实提示并还原、恢复后成功）。
    const handleMarkCompleted = extractPageFn('pages/profile/checkup-reminder.vue', 'handleMarkCompleted',
      ['nextCheckup', 'healthStore', 'uni', 'dataSource', 'familyStore'])
    const demoDataSource = { value: 'demo' }
    w.failWrites(['YUNTU_HEALTH_DATA'])
    await handleMarkCompleted(nextCheckup, w.health, global.uni, demoDataSource, null)()
    assert.ok(w.toasts.some(t => /保存失败/.test(t)))
    assert.ok(!w.toasts.some(t => t === '已标记完成'))
    assert.equal(w.health.checkupSchedules[0].status, 'upcoming')
    // 恢复后成功
    w.failWrites([])
    await handleMarkCompleted(nextCheckup, w.health, global.uni, demoDataSource, null)()
    assert.ok(w.toasts.some(t => t === '已标记完成'))
  })

  await scenario('R3.5-页面函数：LoginPopup 确认保存失败不关闭弹框、不发 success', async () => {
    const w = makeWorld()
    seedFormal(w)
    w.health.loadUserProfile()
    const handleConfirm = extractPageFn('components/common/LoginPopup.vue', 'handleConfirm',
      ['nickname', 'loading', 'healthStore', 'uni', 'emit'])
    const nickname = { value: '新昵称' }
    const loading = { value: false }
    const events = []
    const emit = (name, payload) => events.push({ name, payload })

    w.failWrites(['YUNTU_HEALTH_DATA'])
    await handleConfirm(nickname, loading, w.health, global.uni, emit)()
    assert.ok(events.every(e => e.name !== 'update:visible')) // 未关闭
    assert.ok(events.every(e => e.name !== 'success'))        // 未发成功事件
    assert.ok(w.toasts.some(t => /本地保存失败/.test(t)))
    assert.equal(loading.value, false)

    // 恢复后成功关闭并发事件
    w.failWrites([])
    await handleConfirm(nickname, loading, w.health, global.uni, emit)()
    assert.ok(events.some(e => e.name === 'update:visible' && e.payload === false))
    assert.ok(events.some(e => e.name === 'success'))
  })

  await scenario('R3.5-页面函数：本地图片落盘失败后恢复重试，复用原 ID 仅一份', async () => {
    const w = makeWorld()
    seedFormal(w)
    const parseDateText = extractPageFn('pages/archives/batch.vue', 'parseDateText', ['dateText'])()
    // B2b2 调整说明：batch.vue confirmArchive 增加 family 权威分支，新增依赖
    // isFamilyMode/reportFamilyStore/familyStore/upload；此处注入 family=false 走原 legacy
    // 分支，原断言不变。
    const confirmArchive = extractPageFn('pages/archives/batch.vue', 'confirmArchive',
      ['isArchiving', 'items', 'reportStore', 'uni', 'parseDateText', 'legacyHttpEnabled',
       'isFamilyMode', 'reportFamilyStore', 'familyStore', 'upload'])

    // 无 serverReportId 的本地图片
    w.report.pendingUpload = {
      fileUrls: ['local-only-1'], localPaths: ['local-only-1'],
      items: [], fileType: 'image', fileCount: 1
    }
    const items = { value: [{
      id: 0, fileUrl: 'local-only-1', reportId: '', reportType: 'other',
      dateText: '2026/09/19', weekText: '', selected: true, needsConfirm: false
    }] }
    const isArchiving = { value: false }

    w.failWrites(['YUNTU_REPORTS_DATA'])
    const run1 = confirmArchive(isArchiving, items, w.report, global.uni, parseDateText, () => false, () => false, null, null, null)
    await withImmediateTimers(() => run1())
    assert.equal(w.navigateBackCount, 0)
    assert.equal(w.report.reports.length, 0)
    assert.ok(items.value[0].draftId, '失败次已分配的 ID 应被记住')

    w.failWrites([])
    const run2 = confirmArchive(isArchiving, items, w.report, global.uni, parseDateText, () => false, () => false, null, null, null)
    await withImmediateTimers(() => run2())
    assert.equal(w.navigateBackCount, 1)
    // 恰好一份，且 ID 与失败次相同（未生成第二个 rpt ID）
    assert.equal(w.report.reports.length, 1)
    assert.equal(w.report.reports[0]._id, items.value[0].draftId)
    const persisted = JSON.parse(w.storage.get('YUNTU_REPORTS_DATA'))
    assert.equal(persisted.reports.length, 1)
  })

  // ── 第四批（Codex R4 计划漏项）：旧缓存未确认不得上传/认领 ──

  function seedLegacyCache(w, token) {
    // 无 schemaVersion/origin 的旧版本缓存
    w.storage.set('YUNTU_HEALTH_DATA', JSON.stringify({
      lmpDate: new Date(2026, 0, 1).toISOString(),
      userInfo: { nickname: 'synthetic-legacy-owner' },
      records: { '2026-09-10': { weight: '60' } },
      checkupSchedules: []
    }))
    if (token) w.storage.set('momcare_token', token)
  }

  await scenario('R4：旧缓存+token 初始化后 origin 保持 legacy-unverified', async () => {
    const w = makeWorld()
    seedLegacyCache(w, 'synthetic-token')
    w.health.initializeApp()
    assert.equal(w.health.needsLegacyConfirm, true)
    // initializeApp 的补写不升级来源
    const persisted = JSON.parse(w.storage.get('YUNTU_HEALTH_DATA'))
    assert.equal(persisted.origin, 'legacy-unverified')
    assert.equal(persisted.userInfo.nickname, 'synthetic-legacy-owner')
    // 升级备份存在
    const marker = JSON.parse(w.storage.get('MOMCARE_LEGACY_BACKUP_DONE'))
    assert.ok(marker.health_backup)
  })

  await scenario('R4：普通保存与重启不升级来源；换 token 仍待确认', async () => {
    const w = makeWorld()
    seedLegacyCache(w, 'synthetic-token')
    w.health.initializeApp()
    // 普通保存
    await w.health.saveRecord(new Date(), { note: 'local edit' })
    assert.equal(JSON.parse(w.storage.get('YUNTU_HEALTH_DATA')).origin, 'legacy-unverified')
    // 模拟重启 + 更换 token：新 store 实例读取同一存储
    const w2 = makeWorld()
    for (const [k, v] of w.storage.entries()) w2.storage.set(k, v)
    w2.storage.set('momcare_token', 'another-account-token')
    w2.health.initializeApp()
    assert.equal(w2.health.needsLegacyConfirm, true)
    assert.equal(w2.health.userInfo.nickname, 'synthetic-legacy-owner')
  })

  await scenario('R4：未确认前 syncProfileToCloud 阻断，请求不携带旧昵称', async () => {
    const w = makeWorld({ requestMode: 'serverList', serverList: [] })
    seedLegacyCache(w, 'synthetic-token')
    w.health.initializeApp()
    assert.equal(await w.health.syncProfileToCloud(), false)
    assert.equal(w.requests.length, 0) // 未发出任何上传请求
    assert.ok(w.health.lastSyncBlockReason.includes('确认'))
    // 整体云同步：资料上传仍被阻断（不出现 profile 上行请求）；报告拉取不受影响
    await w.health.syncCloudData()
    assert.ok(!w.requests.some(r => r.url.includes('/api/user/profile') && r.method === 'PUT'))
    assert.equal(await w.report.syncReportsFromCloud(), true)
  })

  await scenario('R4：显式确认后 origin 升级 formal 并恢复上传', async () => {
    const w = makeWorld({ requestMode: 'serverList', serverList: [] })
    seedLegacyCache(w, 'synthetic-token')
    w.health.initializeApp()
    const confirmed = w.health.confirmLegacyOrigin()
    assert.deepEqual([confirmed.ok, confirmed.changed], [true, true])
    assert.equal(w.health.needsLegacyConfirm, false)
    assert.equal(JSON.parse(w.storage.get('YUNTU_HEALTH_DATA')).origin, 'formal')
    // 上传通路恢复：发出 PUT 且成功
    assert.equal(await w.health.syncProfileToCloud(), true)
    assert.ok(w.requests.some(r => r.url.includes('/api/user/profile') && r.method === 'PUT'))
  })

  await scenario('R4：确认动作落盘失败回滚，保持待确认', async () => {
    const w = makeWorld()
    seedLegacyCache(w, 'synthetic-token')
    w.health.initializeApp()
    w.failWrites(['YUNTU_HEALTH_DATA'])
    const confirmed = w.health.confirmLegacyOrigin()
    assert.equal(confirmed.ok, false)
    assert.equal(w.health.needsLegacyConfirm, true)
    w.failWrites([])
    const again = w.health.confirmLegacyOrigin()
    assert.equal(again.ok, true)
  })

  await scenario('R4：来源未确认的旧报告编辑不推送云端，仅保存本机', async () => {
    const w = makeWorld({ requestMode: 'serverList', serverList: [] })
    api.setToken('synthetic-token')
    seedFormal(w)
    w.storage.set('YUNTU_REPORTS_DATA', JSON.stringify({
      reports: [],
      unarchivedReports: [{ _id: 'legacy_r9', archive_status: 'unarchived', report_date: '2026-09-01', notes: '', _originUnverified: true, _local: true }]
    }))
    await w.report.fetchUnarchivedReports()
    w.requests.length = 0
    const r = await w.report.updateReport('legacy_r9', { notes: 'edit before confirm' })
    assert.equal(r.ok, true)
    assert.equal(r.synced, false)
    assert.ok(r.message.includes('待确认'))
    // 未发出上传请求；本地已应用
    assert.equal(w.requests.length, 0)
    assert.equal(w.report.unarchivedReports[0].notes, 'edit before confirm')
    // 下行拉取不受阻断
    assert.equal(await w.report.syncReportsFromCloud(), true)
  })

  // ── 第五批（Codex R5）：读取边界标记 + 令牌绑定归属记录 ──

  await scenario('R5：真实无标记旧报告读取后标记未确认，编辑/删除/AI 全部拦截', async () => {
    // 与 Codex 复现一致：旧报告没有任何新标志，仅存在于本地缓存
    const w = makeWorld({ requestMode: 'serverList', serverList: [] })
    api.setToken('synthetic-real-token')
    seedFormal(w)
    w.storage.set('YUNTU_REPORTS_DATA', JSON.stringify({
      reports: [],
      unarchivedReports: [{ _id: 'legacy_report_no_flags', archive_status: 'unarchived', report_date: '2026-09-01', report_type: 'blood_routine', notes: '' }]
    }))
    await w.report.fetchUnarchivedReports()
    // 读取边界已保守标记
    assert.equal(w.report.unarchivedReports[0]._originUnverified, true)

    // 编辑：不发 PUT，本地保存并说明
    w.requests.length = 0
    const r = await w.report.updateReport('legacy_report_no_flags', { notes: 'edit legacy' })
    assert.equal(r.synced, false)
    assert.ok(r.message.includes('待确认'))
    assert.equal(w.requests.filter(q => q.method === 'PUT').length, 0)
    assert.equal(w.report.unarchivedReports[0].notes, 'edit legacy')

    // 删除：仅本地（无服务端 DELETE）
    w.requests.length = 0
    const del = await w.report.deleteReport('legacy_report_no_flags')
    assert.equal(del.ok, true)
    assert.equal(w.requests.length, 0)
    assert.equal(w.report.unarchivedReports.length, 0)
  })

  await scenario('R5：无标记旧报告 AI 解读被拦截，不请求不扣次数', async () => {
    const w = makeWorld({ requestMode: 'aiPayload', aiPayload: { overall_summary: 'x' } })
    api.setToken('synthetic-real-token')
    seedFormal(w)
    w.storage.set('YUNTU_REPORTS_DATA', JSON.stringify({
      reports: [{ _id: 'legacy_ai_target', archive_status: 'archived', report_date: '2026-09-01', report_type: 'blood_routine' }],
      unarchivedReports: []
    }))
    await w.report.fetchReports()
    const ok = await w.report.triggerAiPipeline('legacy_ai_target')
    assert.equal(ok, false)
    assert.equal(w.requests.length, 0)
    assert.equal(w.health.aiInterpretQuota.used, 0)
    assert.ok(w.toasts.some(t => /待确认/.test(t)))
  })

  await scenario('R5：成功下行同步后同一报告恢复可信，编辑可走云端', async () => {
    const serverReport = { _id: 'legacy_report_no_flags', archive_status: 'unarchived', report_date: '2026-09-01', report_type: 'blood_routine', notes: 'server version' }
    const w = makeWorld({ requestMode: 'serverList', serverList: [serverReport] })
    api.setToken('synthetic-real-token')
    seedFormal(w)
    w.storage.set('YUNTU_REPORTS_DATA', JSON.stringify({
      reports: [{ _id: 'legacy_report_no_flags', archive_status: 'unarchived', report_date: '2026-09-01', report_type: 'blood_routine' }],
      unarchivedReports: []
    }))
    await w.report.fetchReports()
    assert.equal(await w.report.syncReportsFromCloud(), true)
    // 服务端版本替换本地未确认副本，标记清除
    const merged = w.report.unarchivedReports.find(x => x._id === 'legacy_report_no_flags')
    assert.equal(merged._originUnverified, undefined)
    const r = await w.report.updateReport('legacy_report_no_flags', { notes: 'edit after sync' })
    assert.equal(r.synced, true)
  })

  await scenario('R5：schemaVersion2+origin formal 无归属记录仍阻断上传（Codex 绕过2）', async () => {
    // 早期 A 版代码自动生成的形态：结构版本与 origin 都"正常"，但没有归属确认
    const w = makeWorld({ requestMode: 'serverList', serverList: [] })
    w.storage.set('YUNTU_HEALTH_DATA', JSON.stringify({
      schemaVersion: 2, origin: 'formal',
      lmpDate: new Date(2026, 0, 1).toISOString(),
      userInfo: { nickname: 'earlier-a-code-user' },
      records: { '2026-09-10': { weight: '60' } }, checkupSchedules: []
    }))
    w.storage.set('momcare_token', 'synthetic-token')
    w.health.initializeApp()
    assert.equal(w.health.needsLegacyConfirm, true)
    assert.equal(await w.health.syncProfileToCloud(), false)
    assert.equal(w.requests.length, 0)
    // 归属指纹未随 initializeApp 写入（结构字段不构成同意）
    const persisted = JSON.parse(w.storage.get('YUNTU_HEALTH_DATA'))
    assert.ok(!persisted.ownerTokenFingerprint)
  })

  await scenario('R5：确认把归属绑定到当前 token，换 token 后重新隔离', async () => {
    const w = makeWorld({ requestMode: 'serverList', serverList: [] })
    w.storage.set('YUNTU_HEALTH_DATA', JSON.stringify({
      schemaVersion: 2, origin: 'formal',
      lmpDate: new Date(2026, 0, 1).toISOString(),
      userInfo: { nickname: 'confirm-owner-user' },
      records: {}, checkupSchedules: []
    }))
    w.storage.set('momcare_token', 'token-A')
    w.health.initializeApp()
    assert.equal(w.health.confirmLegacyOrigin().changed, true)
    // 归属记录与 token-A 绑定，上传恢复
    assert.equal(JSON.parse(w.storage.get('YUNTU_HEALTH_DATA')).ownerTokenFingerprint, api.tokenFingerprint('token-A'))
    assert.equal(await w.health.syncProfileToCloud(), true)
    // 换 token 登录：上传守卫动作时新鲜读取立即阻断（不依赖响应式缓存）；
    // 同步入口刷新身份镜像后，横幅状态（needsLegacyConfirm）随之翻转
    api.setToken('token-B')
    assert.equal(await w.health.syncProfileToCloud(), false)
    assert.equal(w.health.needsLegacyConfirm, true)
    assert.ok(w.health.lastSyncBlockReason.includes('确认'))
    // 重新确认后绑定 token-B
    assert.equal(w.health.confirmLegacyOrigin().changed, true)
    assert.equal(await w.health.syncProfileToCloud(), true)
  })

  await scenario('R5：全新账号注册流不被误伤（空档案+登录 → 上传可用）', async () => {
    const w = makeWorld({ requestMode: 'serverList', serverList: [] })
    api.setToken('fresh-account-token')
    // 空存储：afterRealLogin 视为全新账号，新建数据直接归属当前身份
    w.health.afterRealLogin()
    assert.equal(w.health.needsLegacyConfirm, false)
    w.health.userInfo.nickname = 'fresh user'
    w.health.lmpDate = new Date(2026, 0, 1)
    const saved = await w.health.saveUserProfile()
    assert.equal(saved.ok, true)
    assert.equal(w.health.needsLegacyConfirm, false)
    assert.equal(await w.health.syncProfileToCloud(), true)
    assert.ok(w.requests.some(q => q.url.includes('/api/user/profile') && q.method === 'PUT'))
    // 重启（同 token）：归属记录从持久层恢复，仍可上传
    const w2 = makeWorld({ requestMode: 'serverList', serverList: [] })
    for (const [k, v] of w.storage.entries()) w2.storage.set(k, v)
    w2.health.initializeApp()
    assert.equal(w2.health.needsLegacyConfirm, false)
    assert.equal(await w2.health.syncProfileToCloud(), true)
  })

  await scenario('R5：未确认旧报告的本地编辑在下行同步中保留（Codex R5 回归）', async () => {
    // 完整链路：无标记旧报告 → 读取标记 → 本地编辑（禁上传）→
    // 服务端拉回同 ID 旧版本 → 本地编辑保留，仍未确认不可上传
    const w = makeWorld({ requestMode: 'serverList', serverList: [] })
    api.setToken('synthetic-real-token')
    seedFormal(w)
    w.storage.set('YUNTU_REPORTS_DATA', JSON.stringify({
      reports: [],
      unarchivedReports: [{ _id: 'legacy_edit_chain', archive_status: 'unarchived', report_date: '2026-09-01', report_type: 'urine', notes: 'old cache note' }]
    }))
    await w.report.fetchUnarchivedReports()
    assert.equal(w.report.unarchivedReports[0]._originUnverified, true)

    // 本地编辑被拒上传，但标记为待同步的真实用户输入
    const r = await w.report.updateReport('legacy_edit_chain', { notes: 'new-local-note' })
    assert.equal(r.synced, false)
    assert.equal(r.pendingSync, true)
    assert.equal(r.ok, true)

    // 服务端拉回同一 ID 的旧版本
    w.serverList = [{ _id: 'legacy_edit_chain', archive_status: 'unarchived', report_date: '2026-09-01', report_type: 'urine', notes: 'older-server-note' }]
    assert.equal(await w.report.syncReportsFromCloud(), true)

    // 本地编辑保留，未被服务端旧版本覆盖；仍未确认、不可上传
    const merged = w.report.unarchivedReports.find(x => x._id === 'legacy_edit_chain')
    assert.equal(merged.notes, 'new-local-note')
    assert.equal(merged._pendingSync, true)
    assert.equal(merged._originUnverified, true)
    // 编辑入口依旧拦截上传
    w.requests.length = 0
    const again = await w.report.updateReport('legacy_edit_chain', { notes: 'still local' })
    assert.equal(again.synced, false)
    assert.equal(w.requests.length, 0)
    assert.equal(w.report.unarchivedReports[0].notes, 'still local')
  })

  // ── 汇总 ──
  console.log(`\n通过 ${passed} 项，失败 ${failed.length} 项`)
  if (failed.length > 0) {
    console.log('失败场景：', failed.join(' | '))
    process.exitCode = 1
  }
}

main().catch(e => { console.error(e); process.exitCode = 1 })
  .finally(() => fs.rmSync(temporary, { recursive: true, force: true }))
