// Research probes, not regression acceptance tests. No real network or user storage.
// Run from repository root: node docs/research/2026-09-19-probes.cjs
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-research-'))
const output = path.join(temporary, 'bundle.cjs')
esbuild.buildSync({
  stdin: {
    contents: `export { createPinia, setActivePinia } from 'pinia';
      export * from './stores/health.js'; export * from './stores/report.js';
      export * from './utils/api.js'; export * from './stores/staticData.js';`,
    resolveDir: root,
  },
  bundle: true, platform: 'node', format: 'cjs', alias: { '@': root },
  outfile: output, logLevel: 'silent',
})
const api = require(output)
const storage = new Map()
const notices = []
let requests = []
let responseMode = 'offline'
global.uni = {
  getStorageSync: key => storage.get(key) || '',
  setStorageSync: (key, value) => storage.set(key, value),
  removeStorageSync: key => storage.delete(key),
  showToast: value => notices.push(value.title),
  showLoading() {}, hideLoading() {},
  request(options) {
    requests.push({ url: options.url, method: options.method })
    if (responseMode === 'offline') options.fail({ errMsg: 'request:fail synthetic offline' })
    else options.success({ statusCode: 200, data: { code: 0, data: [] } })
  },
}
function evidence(name, value) { console.log(JSON.stringify({ probe: name, ...value })) }
async function main() {
  api.setActivePinia(api.createPinia())
  const health = api.useHealthStore()
  const report = api.useReportStore()
  await health.silentLogin()
  assert.equal(health.todayWeekInfo.week, 16)
  assert.equal(health.getWeightStats().latest, '55.8')
  assert.equal(health.getBpStats().count, 0)
  evidence('demo persisted with mismatched fields', {
    week: health.todayWeekInfo.week, weight: health.getWeightStats(),
    bp: health.getBpStats(), fetal: health.getFetalStats(),
  })
  requests = []
  const login = await api.request({ url: '/api/login', method: 'POST', data: { phone: '13900000000', password: 'synthetic-wrong-password' } })
  assert.equal(login.data.data.token, 'guest_mock_token')
  assert.equal(requests.length, 0)
  evidence('guest intercepts real login route', { networkRequests: requests.length, returnedToken: login.data.data.token })

  const id = await report.createReport({ report_type: 'blood_routine', report_date: '2026-09-19', file_urls: ['synthetic-local.png'] })
  api.setToken('synthetic-token-not-a-credential')
  assert.equal(await report.updateReport(id, { notes: 'synthetic offline update' }), true)
  assert.equal(await report.triggerAiPipeline(id), true)
  assert.deepEqual(report.reports[0].ai_result, {})
  assert.equal(health.aiInterpretQuota.used, 1)
  evidence('offline AI incorrectly succeeds', { status: report.reports[0].ai_status, result: report.reports[0].ai_result, usedQuota: health.aiInterpretQuota.used, notices })

  responseMode = 'emptyCloud'
  await report.syncReportsFromCloud()
  assert.equal(report.reports.length, 0)
  evidence('empty cloud replaces local report', { remaining: report.reports.length })

  const pendingId = await report.createReport({ report_type: 'other', report_date: '2026-09-19', archive_status: 'unarchived' })
  await report.updateReport(pendingId, { archive_status: 'archived' })
  assert.equal(report.unarchivedReports[0]._id, pendingId)
  assert.equal(report.reports.length, 0)
  evidence('classification updates status without moving list', { unarchivedCount: report.unarchivedReports.length, status: report.unarchivedReports[0].archive_status })

  const due = new Date(health.today)
  due.setDate(due.getDate() + 1)
  health.dueDate = due
  assert.equal(health.isDueDate(due), false)
  evidence('due-date helper compares against today', { actual: health.isDueDate(due), expected: true })

  const scheduleDate = health.checkupSchedules[0].checkup_date
  health.lmpDate = new Date(2026, 6, 1)
  await health.saveUserProfile()
  assert.equal(health.checkupSchedules[0].checkup_date, scheduleDate)
  evidence('profile edit leaves old schedule', { scheduleDate })

  const timestamp = health.today.getTime()
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(health.today.getTime(), timestamp)
  evidence('computed today has no reactive clock', { timestampUnchanged: true })

  const staticData = api.useStaticDataStore()
  uni.request = async () => ({ statusCode: 404, data: '' })
  await staticData.loadData()
  assert.equal(staticData.loaded, true)
  assert.equal(staticData.loadError, false)
  evidence('404 static data reported loaded', { loaded: staticData.loaded, loadError: staticData.loadError, records: staticData.dailyData.length })

  const persistedBefore = storage.get('YUNTU_HEALTH_DATA')
  uni.setStorageSync = () => { throw new Error('synthetic storage quota exceeded') }
  await health.saveRecord(new Date(), { note: 'synthetic unsaved note' })
  assert.equal(storage.get('YUNTU_HEALTH_DATA'), persistedBefore)
  evidence('storage failure swallowed', { saveResolved: true, persistedStateUnchanged: true })
  console.log('All 10 research scenarios reproduced. This confirms defects, not product acceptance.')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => fs.rmSync(temporary, { recursive: true, force: true }))
