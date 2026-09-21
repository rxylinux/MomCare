// B2b1 回归：真实客户端（familyStore/outbox/session/adapter/页面 script setup）→
// 真实 mc-schedule / mc-health 组装产物 handler → SDK 契约模拟（隔离，零真实网络）。
// 覆盖矩阵对应 docs/PHASE_B2B1_COVERAGE_MATRIX_2026-09-19.md：
//   服务端 16 组 / store 15 组（store11 两则）/ 待产包页 6 组 / 产检页 14 组 / 我的摘要 3 组 / 零旧键与零旧 HTTP 审计。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-b2b1-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) {
  try { await fn(); pass(name) } catch (e) { fail(name, e) }
}

// ── 组装真实云函数 ──
cp.execFileSync('node', [path.join(root, 'cloud/assemble.mjs')], { stdio: 'pipe' })
const DIST = path.join(root, 'dist/cloud-functions')
const scheduleHandler = require(path.join(DIST, 'mc-schedule/index.js'))
const healthHandler = require(path.join(DIST, 'mc-health/index.js'))
const identityHandler = require(path.join(DIST, 'mc-identity/index.js'))

// ── SDK 契约模拟（与 B2a 同型；where 链式支持 orderBy/limit/get 任意组合）──
const SDK_DEFAULT_LIMIT = 100

function makeMockCloud() {
  const state = {
    initCfg: null,
    ctx: { OPENID: '', APPID: '' },
    store: new Map(),
    controls: { failNextCommits: 0 },
    callLog: []
  }
  const key = (col, id) => `${col}/${id}`
  const clone = x => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)))
  const readDoc = (col, id) => {
    const e = state.store.get(key(col, id))
    return e ? { v: e.v, doc: clone(e.doc) } : null
  }
  function docApi(col, id, tx) {
    return {
      get: async () => {
        const entry = readDoc(col, id)
        const docWithId = entry ? { ...entry.doc, _id: id } : null
        if (tx) tx.reads.set(key(col, id), entry ? entry.v : 0)
        return { data: docWithId }
      },
      set: async ({ data }) => {
        if (data && Object.prototype.hasOwnProperty.call(data, '_id')) {
          const err = new Error('document.set:fail -501007 invalid parameters 不能更新_id的值')
          err.errMsg = err.message
          throw err
        }
        if (tx) { tx.writes.set(key(col, id), clone(data)); return { _id: id } }
        const prev = state.store.get(key(col, id))
        state.store.set(key(col, id), { v: (prev ? prev.v : 0) + 1, doc: clone(data) })
        return { _id: id }
      },
      update: async () => { throw new Error('B2b1 未使用 update') }
    }
  }
  function runQuery(col, filters, orderByField, orderByDir, limitN) {
    let rows = [...state.store.entries()]
      .filter(([k]) => k.startsWith(col + '/'))
      .map(([k, e]) => ({ ...clone(e.doc), _id: k.slice(col.length + 1) }))
    for (const [f, cond] of Object.entries(filters || {})) {
      rows = rows.filter(r => {
        if (cond && cond.__op === 'lt') {
          const rv = r[f]
          return rv !== undefined && String(rv) < String(cond.v)
        }
        return JSON.stringify(r[f]) === JSON.stringify(cond)
      })
    }
    if (orderByField) {
      rows.sort((a, b) => String(b[orderByField]).localeCompare(String(a[orderByField])))
      if (String(orderByDir).toLowerCase() === 'asc') rows.reverse()
    }
    return rows.slice(0, limitN || SDK_DEFAULT_LIMIT)
  }
  function makeQuery(col, filters, orderByField, orderByDir, limitN) {
    return {
      orderBy: (f, d) => makeQuery(col, filters, f, d, limitN),
      limit: n => makeQuery(col, filters, orderByField, orderByDir, n),
      get: async () => ({ data: runQuery(col, filters, orderByField, orderByDir, limitN) })
    }
  }
  const db = {
    command: { lt: v => ({ __op: 'lt', v }) },
    startTransaction: async () => {
      const tx = { reads: new Map(), writes: new Map(), finished: false }
      return {
        collection: col => ({ doc: id => docApi(col, id, tx) }),
        commit: async () => {
          if (tx.finished) throw new Error('tx finished')
          if (state.controls.failNextCommits > 0) {
            state.controls.failNextCommits--
            throw new Error('commit failed (mock infra)')
          }
          for (const k of tx.writes.keys()) {
            const readV = tx.reads.has(k) ? tx.reads.get(k) : 0
            const cur = state.store.get(k)
            if ((cur ? cur.v : 0) !== readV) {
              const err = new Error('transaction conflict')
              err.errMsg = 'db transaction conflict'
              throw err
            }
          }
          for (const [k, data] of tx.writes.entries()) {
            const prev = state.store.get(k)
            state.store.set(k, { v: (prev ? prev.v : 0) + 1, doc: clone(data) })
          }
          tx.finished = true
        },
        rollback: async () => { tx.finished = true }
      }
    },
    collection: col => {
      const api = {
        doc: id => docApi(col, id, null),
        where: filters => makeQuery(col, filters),
        get: async () => ({ data: runQuery(col, {}, null, null, SDK_DEFAULT_LIMIT) })
      }
      return api
    }
  }
  const cloud = {
    DYNAMIC_CURRENT_ENV: Symbol('env'),
    init(cfg) { state.initCfg = cfg },
    getWXContext() { return { ...state.ctx } },
    database() {
      if (!state.initCfg) throw new Error('init first')
      return db
    },
    __state: state,
    __setCtx(openid, appid) { state.ctx = { OPENID: openid, APPID: appid } },
    __put(col, id, doc) { const { _id, ...rest } = doc; void _id; state.store.set(`${col}/${id}`, { v: 1, doc: clone(rest) }) },
    __snapshot(col, id) { const e = state.store.get(`${col}/${id}`); return e ? clone(e.doc) : null },
    __count(col) { return [...state.store.keys()].filter(k => k.startsWith(col + '/')).length }
  }
  return cloud
}

const TEST_ENV = {
  MC_APPID: 'wxtestappid0001',
  MC_FAMILY_ID: 'fam-b2b1test',
  MC_MEMBER_MAMA_OPENID: 'oTESTMAMA123456',
  MC_MEMBER_PAPA_OPENID: 'oTESTPAPA123456'
}
function setServerEnv() { for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v }
function clearServerEnv() { for (const k of Object.keys(TEST_ENV)) delete process.env[k] }

// ── 客户端 bundle（真实模块）──
const bundlePath = path.join(temp, 'client.cjs')
esbuild.buildSync({
  stdin: {
    contents: `export { createPinia, setActivePinia } from 'pinia';
      export * from './services/cloudAdapter.js';
      export * from './services/sessionService.js';
      export * from './services/outbox.js';
      export * from './services/familyStore.js';
      export * from './utils/cloudConfig.js';
      export * from './utils/backendGate.js';
      export * from './utils/api.js';`,
    resolveDir: root
  },
  bundle: true, platform: 'node', format: 'cjs', alias: { '@': root },
  outfile: bundlePath, logLevel: 'silent'
})
const api = require(bundlePath)

const storage = new Map()
const storageReads = [] // 零旧键审计：正式路径不得读取旧 hospital_bag_items
const uniCalls = { requests: 0, uploadFile: 0, toasts: [] }
global.uni = {
  getStorageSync(k) { storageReads.push(k); return storage.has(k) ? storage.get(k) : '' },
  setStorageSync(k, v) { storage.set(k, v) },
  removeStorageSync(k) { storage.delete(k) },
  getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
  showToast: v => uniCalls.toasts.push(v && v.title),
  showLoading() {}, hideLoading() {},
  redirectTo() {}, navigateTo() {}, switchTab() {}, reLaunch() {}, navigateBack() {},
  request: () => { uniCalls.requests++ },
  uploadFile: () => { uniCalls.uploadFile++ }
}

function freshFakeWxCloud(routes, controls) {
  return {
    init() {},
    callFunction(o) {
      if (controls && controls.offline) {
        o.fail({ errMsg: 'cloud function offline (mock)' })
        return
      }
      const handler = routes[o.name]
      if (!handler) { o.fail({ errMsg: 'no route' }); return }
      // 挂起下一个 mc-schedule 响应（成员切换边界复现）：release() 才投递
      if (controls && controls.holdSchedule) {
        controls.holdSchedule = false
        Promise.resolve().then(() => handler(o.data)).then(r => {
          controls.releaseHeld = () => { o.success({ result: r }); controls.releaseHeld = null }
        }).catch(e => { o.fail({ errMsg: e.message }) })
        return
      }
      Promise.resolve().then(() => handler(o.data)).then(r => o.success({ result: r })).catch(e => o.fail({ errMsg: e.message }))
    },
    uploadFile(o) { o.success({ fileID: 'cloud://x/y' }) }
  }
}

function freshDisk() {
  for (const k of [...storage.keys()]) {
    if (k.startsWith('mc_outbox_') || k.startsWith('mc_cache_') || k.startsWith('mc_session_') || k.startsWith('mc_draft_') || k.startsWith('mc_pending_') || k === 'mc_session_mode') {
      storage.delete(k)
    }
  }
}

// 全栈环境：真实客户端 → 伪造 wx.cloud → 真实 handler → 契约 mock
function fullStack(options = {}) {
  freshDisk()
  clearServerEnv()
  setServerEnv()
  const cloud = makeMockCloud()
  const member = options.member || 'mama'
  const controls = { offline: false }
  const applyCtx = () => cloud.__setCtx(
    member === 'mama' ? TEST_ENV.MC_MEMBER_MAMA_OPENID : TEST_ENV.MC_MEMBER_PAPA_OPENID,
    TEST_ENV.MC_APPID)
  applyCtx()
  scheduleHandler.__setCloud(cloud)
  healthHandler.__setCloud(cloud)
  identityHandler.__setCloud(cloud)
  const routes = {
    'mc-schedule': e => { applyCtx(); return scheduleHandler.main(e) },
    'mc-health': e => { applyCtx(); return healthHandler.main(e) },
    'mc-identity': () => { applyCtx(); return identityHandler.main({}) }
  }
  const wxCloud = freshFakeWxCloud(routes, controls)
  api.__setCloudConfigForTests('env-b2b1', 'wxapp-b2b1')
  api.__setWxCloud(wxCloud)
  api.__resetForTests()
  api.setActivePinia(api.createPinia())
  const fam = api.useFamilyStore()
  return { cloud, wxCloud, fam, controls, routes, applyCtx, setMember: m => { options.member = m } }
}

// ── 页面级 harness（同 B2a 模式：装载真实 SFC script setup 及其自身依赖）──
function bundlePage(relPath, transform, exports) {
  const vue = fs.readFileSync(path.join(root, relPath), 'utf8')
  const body = vue.match(/<script setup>([\s\S]*?)<\/script>/)[1]
  let src = body
    .replace(/^import .* from ['"][^'"\n]+\.vue['"];?$/mg, '')
    .replace(/import\s*\{\s*onShow(\s+as\s+__onShow)?\s*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/,
      m => m.includes('as') ? 'const shows=[];const __onShow=fn=>shows.push(fn);' : 'const shows=[];const onShow=fn=>shows.push(fn);')
    .replace(/\bonMounted\s*,?\s*(?=[\},])/g, '')
    .replace(/,\s*,/g, ',')
    .replace(/\{\s*,/g, '{ ')
    .replace(/,\s*\}/g, ' }')
  src = "import { createPinia, setActivePinia } from 'pinia';\nconst mounts=[];const onMounted=fn=>mounts.push(fn);\n" + src
  if (transform) src = transform(src)
  const hasShows = src.includes('const shows=[]')
  src += `\nexport {mounts};${hasShows ? 'export {shows};' : ''}export * from './services/sessionService.js';export * from './services/cloudAdapter.js';export * from './services/outbox.js';export * from './services/familyStore.js';export * from './utils/cloudConfig.js';` + exports
  const outFile = path.join(temp, 'page-' + path.basename(relPath, '.vue') + '.cjs')
  esbuild.buildSync({
    stdin: { contents: src, resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', alias: { '@': root },
    outfile: outFile, logLevel: 'silent'
  })
  delete require.cache[require.resolve(outFile)]
  return require(outFile)
}

function setupPageRoutes(page, cloud, controls) {
  page.__setCloudConfigForTests('env-b2b1', 'wxapp-b2b1')
  page.__setWxCloud(freshFakeWxCloud({
    'mc-schedule': e => scheduleHandler.main(e),
    'mc-health': e => healthHandler.main(e),
    'mc-identity': () => Promise.resolve({ ok: true, data: { memberId: 'mama', displayName: '妈妈', familyId: TEST_ENV.MC_FAMILY_ID } })
  }, controls))
  void cloud
}
function confirmPageBundle(page, cloud, controls) {
  setupPageRoutes(page, cloud, controls)
  return page.confirmIdentity()
}

const withPinia = src => src.replace('const healthStore = useHealthStore()', 'setActivePinia(createPinia());\nconst healthStore = useHealthStore()')

  const tick = () => new Promise(r => setTimeout(r, 15))

async function main() {
  console.log('B2b1 回归（真实客户端→真实 mc-schedule/mc-health handler 全栈）\n')

  // ══ 服务端 16 组（handler 直连）══
  await scenario('服务1：bag/checkup 创建返回稳定 id（含 toggle/迁移结果分支）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud)
    const bag = await scheduleHandler.main({ action: 'bag.upsert', schemaVersion: 1, operationId: 's1a', expectedRevision: 0, id: 'bag-probe-1', payload: { name: '奶瓶', category: 'baby', quantity: 2 } })
    assert.equal(bag.ok, true, JSON.stringify(bag))
    assert.equal(bag.data.record.id, 'bag-probe-1')
    const chk = await scheduleHandler.main({ action: 'checkup.upsert', schemaVersion: 1, operationId: 's1b', expectedRevision: 0, id: 'chk-probe-1', payload: { dateKey: '2026-10-01' } })
    assert.equal(chk.ok, true, JSON.stringify(chk))
    assert.equal(chk.data.record.id, 'chk-probe-1')
    assert.equal(chk.data.record.sortKey, '2026-10-01:chk-probe-1')
  })

  await scenario('服务2：同 createdAt 45 条分页不丢（_id 稳定游标）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud)
    const ts = 1700000000000
    for (let i = 0; i < 45; i++) {
      cloud.__put('mc_bag_items', 'bag_p' + String(i).padStart(3, '0'), {
        familyId: TEST_ENV.MC_FAMILY_ID, type: 'bag', name: '物' + i, category: 'other',
        quantity: 1, location: null, assignee: null, prepared: false, templateKey: null,
        revision: 1, updatedBy: 'mama', updatedAt: ts, createdAt: ts, schemaVersion: 1, deleted: false
      })
    }
    const seen = new Set()
    let cursor = null
    let pages = 0
    do {
      const res = await scheduleHandler.main({ action: 'bag.list', schemaVersion: 1, cursor, limit: 20 })
      assert.equal(res.ok, true, JSON.stringify(res))
      for (const r of res.data.records) seen.add(r.id)
      cursor = res.data.nextCursor
      pages++
      if (pages > 10) throw new Error('分页异常')
    } while (cursor)
    assert.equal(seen.size, 45, `应 45 唯一记录，实得 ${seen.size}`)
  })

  await scenario('服务3：两端同时初始化同一 templateKey 至多一条（确定性主键+事务）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud)
    const tpl = [{ templateKey: 'k1', name: '身份证', category: 'documents' }, { templateKey: 'k2', name: '口罩', category: 'going' }]
    const [a, b] = await Promise.all([
      scheduleHandler.main({ action: 'bag.initialize', schemaVersion: 1, operationId: 'init-a', expectedRevision: 0, templates: tpl }),
      scheduleHandler.main({ action: 'bag.initialize', schemaVersion: 1, operationId: 'init-b', expectedRevision: 0, templates: tpl })
    ])
    assert.ok(a.ok && b.ok)
    assert.equal(cloud.__count('mc_bag_items'), 2, '两个 templateKey 各至多一条')
    assert.equal(cloud.__snapshot('mc_bag_items', 'bag_tpl_k1').name, '身份证')
    // 重复点击/丢响应重放：已删模板不复活、不重复
    const again = await scheduleHandler.main({ action: 'bag.initialize', schemaVersion: 1, operationId: 'init-a', expectedRevision: 0, templates: tpl })
    assert.ok(again.ok)
    assert.ok(again.data.results.every(r => r.skipped))
    assert.equal(cloud.__count('mc_bag_items'), 2)
  })

  await scenario('服务3b：在途初始化不覆盖后续用户编辑（存在即保留）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud)
    // 用户先把模板条目改为 quantity 9 / revision 2，再触发同 templateKey 初始化
    cloud.__put('mc_bag_items', 'bag_tpl_k1', {
      familyId: TEST_ENV.MC_FAMILY_ID, type: 'bag', name: '身份证', category: 'documents',
      quantity: 9, location: null, assignee: null, prepared: false, templateKey: 'k1',
      revision: 2, updatedBy: 'mama', updatedAt: 1, createdAt: 1, schemaVersion: 1, deleted: false
    })
    const res = await scheduleHandler.main({ action: 'bag.initialize', schemaVersion: 1, operationId: 'init-c', expectedRevision: 0, templates: [{ templateKey: 'k1', name: '身份证', category: 'documents' }] })
    assert.ok(res.ok)
    assert.ok(res.data.results[0].skipped)
    const doc = cloud.__snapshot('mc_bag_items', 'bag_tpl_k1')
    assert.equal(doc.quantity, 9)
    assert.equal(doc.revision, 2)
  })

  await scenario('服务4：toggle 重放幂等 + 同 opId 换 itemId 拒绝（requestHash）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud)
    await scheduleHandler.main({ action: 'checkup.upsert', schemaVersion: 1, operationId: 's4c', expectedRevision: 0, id: 'chk_s4', payload: { dateKey: '2026-10-01', examItems: [{ itemId: 'A', text: 'A', required: true, done: false }, { itemId: 'B', text: 'B', required: false, done: false }] } })
    const t1 = await scheduleHandler.main({ action: 'checkup.toggle-item', schemaVersion: 1, operationId: 'op-t1', expectedRevision: 1, id: 'chk_s4', itemId: 'A', targetDone: true })
    assert.ok(t1.ok && t1.data.record.examItems.find(i => i.itemId === 'A').done === true)
    const replay = await scheduleHandler.main({ action: 'checkup.toggle-item', schemaVersion: 1, operationId: 'op-t1', expectedRevision: 1, id: 'chk_s4', itemId: 'A', targetDone: true })
    assert.ok(replay.ok && replay.data.replayed)
    assert.equal(replay.data.record.examItems.find(i => i.itemId === 'A').done, true)
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_s4').revision, 2, '重放不重复翻转')
    const stolen = await scheduleHandler.main({ action: 'checkup.toggle-item', schemaVersion: 1, operationId: 'op-t1', expectedRevision: 1, id: 'chk_s4', itemId: 'B', targetDone: true })
    assert.equal(stolen.ok, false)
    assert.equal(stolen.code, 'operation-id-conflict')
  })

  await scenario('服务5：真实日历迁移（月末 01-31→02-01 偏移 1 天）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud)
    const res = await scheduleHandler.main({ action: 'checkup.migrate-preview', schemaVersion: 1, oldLmpDate: '2026-01-31', newLmpDate: '2026-02-01' })
    assert.ok(res.ok, JSON.stringify(res))
    assert.equal(res.data.shiftDays, 1, '01-31→02-01 必须 1 天而非月差')
  })

  await scenario('服务6：部分编辑不重置未提交字段（status 只显式覆盖）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud)
    await scheduleHandler.main({ action: 'checkup.upsert', schemaVersion: 1, operationId: 's6a', expectedRevision: 0, id: 'chk_s6', payload: { dateKey: '2026-10-01' }, status: 'completed' })
    const edit = await scheduleHandler.main({ action: 'checkup.upsert', schemaVersion: 1, operationId: 's6b', expectedRevision: 1, id: 'chk_s6', payload: { hospital: '市妇幼' } })
    assert.ok(edit.ok, JSON.stringify(edit))
    assert.equal(edit.data.record.status, 'completed', '未传 status 不得重置为 pending')
    assert.equal(edit.data.record.hospital, '市妇幼')
  })

  await scenario('服务7：family 隔离（外家庭 get/upsert/toggle/migrate 全拒绝）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud)
    cloud.__put('mc_checkups', 'chk_foreign', {
      familyId: 'fam-other', type: 'checkup', dateKey: '2026-10-01', sortKey: 'x',
      status: 'pending', source: 'template', revision: 1, updatedBy: 'x', updatedAt: 1, schemaVersion: 1, deleted: false
    })
    const get = await scheduleHandler.main({ action: 'checkup.get', schemaVersion: 1, id: 'chk_foreign' })
    assert.equal(get.data && get.data.record, null, '外家庭文档等同不存在')
    const up = await scheduleHandler.main({ action: 'checkup.upsert', schemaVersion: 1, operationId: 's7a', expectedRevision: 1, id: 'chk_foreign', payload: { hospital: 'X' } })
    assert.equal(up.ok, false)
    assert.equal(up.code, 'not-found')
    const mig = await scheduleHandler.main({ action: 'checkup.migrate-apply', schemaVersion: 1, operationId: 's7b', expectedRevision: 1, ops: [{ id: 'chk_foreign', newDateKey: '2026-10-02', expectedRevision: 1 }] })
    assert.ok(mig.ok) // 顶层 ok 但单项失败
    assert.equal(mig.data.results[0].ok, false)
    assert.equal(mig.data.results[0].code, 'not-found')
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_foreign').familyId, 'fam-other')
  })

  await scenario('服务8：存量 schema 不支持明确拒绝（get/list）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud)
    cloud.__put('mc_bag_items', 'bag_future', { familyId: TEST_ENV.MC_FAMILY_ID, type: 'bag', name: 'x', category: 'other', schemaVersion: 99, revision: 1 })
    const get = await scheduleHandler.main({ action: 'bag.get', schemaVersion: 1, id: 'bag_future' })
    assert.equal(get.ok, false)
    assert.equal(get.code, 'unsupported-stored-schema')
    const list = await scheduleHandler.main({ action: 'bag.list', schemaVersion: 1 })
    assert.equal(list.ok, false)
    assert.equal(list.code, 'unsupported-stored-schema')
  })

  await scenario('服务9：checkup.upsert 真实创建路径无运行时错误（同周可多条）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud)
    const a = await scheduleHandler.main({ action: 'checkup.upsert', schemaVersion: 1, operationId: 's9a', expectedRevision: 0, id: 'chk_w20a', payload: { dateKey: '2026-10-20' } })
    const b = await scheduleHandler.main({ action: 'checkup.upsert', schemaVersion: 1, operationId: 's9b', expectedRevision: 0, id: 'chk_w20b', payload: { dateKey: '2026-10-20' } })
    assert.ok(a.ok && b.ok, JSON.stringify([a, b]))
    assert.equal(cloud.__count('mc_checkups'), 2)
  })

  await scenario('服务10：字段严格校验（time/quantity/重复 itemId/分类枚举含 going）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud)
    const badTime = await scheduleHandler.main({ action: 'checkup.upsert', schemaVersion: 1, operationId: 's10a', expectedRevision: 0, id: 'chk_v1', payload: { dateKey: '2026-10-01', time: '25:99' } })
    assert.equal(badTime.ok, false)
    const badQty = await scheduleHandler.main({ action: 'bag.upsert', schemaVersion: 1, operationId: 's10b', expectedRevision: 0, id: 'bag_v1', payload: { name: 'x', category: 'other', quantity: 0 } })
    assert.equal(badQty.ok, false)
    const badCat = await scheduleHandler.main({ action: 'bag.upsert', schemaVersion: 1, operationId: 's10c', expectedRevision: 0, id: 'bag_v2', payload: { name: 'x', category: 'doc' } })
    assert.equal(badCat.ok, false, '旧 doc 键必须被拒绝')
    const dupItem = await scheduleHandler.main({ action: 'checkup.upsert', schemaVersion: 1, operationId: 's10d', expectedRevision: 0, id: 'chk_v2', payload: { dateKey: '2026-10-01', examItems: [{ itemId: 'D', text: 'a' }, { itemId: 'D', text: 'b' }] } })
    assert.equal(dupItem.ok, false)
    const going = await scheduleHandler.main({ action: 'bag.upsert', schemaVersion: 1, operationId: 's10e', expectedRevision: 0, id: 'bag_v3', payload: { name: '充电宝', category: 'going', quantity: 1 } })
    assert.equal(going.ok, true, 'going 是合法分类')
    const badDate = await scheduleHandler.main({ action: 'checkup.upsert', schemaVersion: 1, operationId: 's10f', expectedRevision: 0, id: 'chk_v3', payload: { dateKey: '2026-02-31' } })
    assert.equal(badDate.ok, false, '2026-02-31 非真实日历日期')
  })

  await scenario('服务11：手动改日期退出迁移资格（source template→manual-date）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud)
    await scheduleHandler.main({ action: 'checkup.initialize', schemaVersion: 1, operationId: 's11a', expectedRevision: 0, templates: [{ templateKey: 'w12', dateKey: '2026-06-29', templateLmp: '2026-06-01', examItems: [{ itemId: 'i1', text: 'NT', required: true }] }] })
    const edit = await scheduleHandler.main({ action: 'checkup.upsert', schemaVersion: 1, operationId: 's11b', expectedRevision: 1, id: 'chk_tpl_w12', payload: { dateKey: '2026-07-05' } })
    assert.ok(edit.ok)
    assert.equal(edit.data.record.source, 'manual-date')
    const pv = await scheduleHandler.main({ action: 'checkup.migrate-preview', schemaVersion: 1, oldLmpDate: '2026-06-01', newLmpDate: '2026-06-10' })
    assert.ok(pv.ok)
    assert.equal(pv.data.toUpdate.length, 0, '手动改期记录不迁移')
  })

  await scenario('服务12：migrate-apply 重放 requestHash（同 opId 换 newDateKey 拒绝）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud)
    await scheduleHandler.main({ action: 'checkup.initialize', schemaVersion: 1, operationId: 's12a', expectedRevision: 0, templates: [{ templateKey: 'w12', dateKey: '2026-06-29', templateLmp: '2026-06-01', examItems: [] }] })
    const first = await scheduleHandler.main({ action: 'checkup.migrate-apply', schemaVersion: 1, operationId: 'mig-1', expectedRevision: 0, ops: [{ id: 'chk_tpl_w12', newDateKey: '2026-06-30', expectedRevision: 1 }] })
    assert.ok(first.ok && first.data.results[0].ok, JSON.stringify(first))
    const replay = await scheduleHandler.main({ action: 'checkup.migrate-apply', schemaVersion: 1, operationId: 'mig-1', expectedRevision: 0, ops: [{ id: 'chk_tpl_w12', newDateKey: '2026-06-30', expectedRevision: 1 }] })
    assert.ok(replay.ok && replay.data.results[0].ok && replay.data.results[0].replayed)
    const stolen = await scheduleHandler.main({ action: 'checkup.migrate-apply', schemaVersion: 1, operationId: 'mig-1', expectedRevision: 0, ops: [{ id: 'chk_tpl_w12', newDateKey: '2026-07-01', expectedRevision: 1 }] })
    assert.equal(stolen.data.results[0].ok, false)
    assert.equal(stolen.data.results[0].code, 'operation-id-conflict')
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_tpl_w12').dateKey, '2026-06-30')
  })

  await scenario('服务13：bag.upsert 外家庭现有文档拒绝覆盖', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud)
    cloud.__put('mc_bag_items', 'bag_fx', { familyId: 'fam-other', type: 'bag', name: 'y', category: 'other', quantity: 1, revision: 3, schemaVersion: 1 })
    const res = await scheduleHandler.main({ action: 'bag.upsert', schemaVersion: 1, operationId: 's13a', expectedRevision: 3, id: 'bag_fx', payload: { name: '覆盖' } })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'not-found')
    assert.equal(cloud.__snapshot('mc_bag_items', 'bag_fx').name, 'y')
  })

  await scenario('服务14：toggle 目标值语义（已是目标值 unchanged；目标布尔不翻转）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud)
    await scheduleHandler.main({ action: 'checkup.upsert', schemaVersion: 1, operationId: 's14a', expectedRevision: 0, id: 'chk_s14', payload: { dateKey: '2026-10-01', examItems: [{ itemId: 'A', text: 'A', required: true, done: false }] } })
    const t1 = await scheduleHandler.main({ action: 'checkup.toggle-item', schemaVersion: 1, operationId: 's14b', expectedRevision: 1, id: 'chk_s14', itemId: 'A', targetDone: true })
    assert.ok(t1.ok && t1.data.record.examItems[0].done === true)
    const t2 = await scheduleHandler.main({ action: 'checkup.toggle-item', schemaVersion: 1, operationId: 's14c', expectedRevision: 2, id: 'chk_s14', itemId: 'A', targetDone: true })
    assert.ok(t2.ok && t2.data.unchanged === true, '同目标值再提交应 unchanged')
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_s14').revision, 2)
  })

  await scenario('服务15：迁移保留已完成/跳过（仅 pending 自动安排移动）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud)
    await scheduleHandler.main({ action: 'checkup.initialize', schemaVersion: 1, operationId: 's15a', expectedRevision: 0, templates: [
      { templateKey: 'w8', dateKey: '2026-06-22', templateLmp: '2026-06-01', examItems: [] },
      { templateKey: 'w12', dateKey: '2026-06-29', templateLmp: '2026-06-01', examItems: [] },
      { templateKey: 'w16', dateKey: '2026-07-06', templateLmp: '2026-06-01', examItems: [] }
    ] })
    await scheduleHandler.main({ action: 'checkup.upsert', schemaVersion: 1, operationId: 's15b', expectedRevision: 1, id: 'chk_tpl_w8', payload: {}, status: 'completed' })
    await scheduleHandler.main({ action: 'checkup.upsert', schemaVersion: 1, operationId: 's15c', expectedRevision: 1, id: 'chk_tpl_w16', payload: {}, status: 'skipped' })
    const pv = await scheduleHandler.main({ action: 'checkup.migrate-preview', schemaVersion: 1, oldLmpDate: '2026-06-01', newLmpDate: '2026-06-02' })
    assert.ok(pv.ok)
    assert.equal(pv.data.toUpdate.length, 1)
    assert.equal(pv.data.toUpdate[0].id, 'chk_tpl_w12')
  })

  await scenario('服务16：部分迁移后再次预览幂等（来源基线 templateDate/templateLmp，不重复偏移）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud)
    await scheduleHandler.main({ action: 'checkup.initialize', schemaVersion: 1, operationId: 's16a', expectedRevision: 0, templates: [
      { templateKey: 'w12', dateKey: '2026-06-29', templateLmp: '2026-06-01', examItems: [] },
      { templateKey: 'w20', dateKey: '2026-07-27', templateLmp: '2026-06-01', examItems: [] }
    ] })
    // 只迁移第 1 条（部分成功场景）
    const partial = await scheduleHandler.main({ action: 'checkup.migrate-apply', schemaVersion: 1, operationId: 's16b', expectedRevision: 0, ops: [{ id: 'chk_tpl_w12', newDateKey: '2026-06-30', expectedRevision: 1 }] })
    assert.ok(partial.data.results[0].ok)
    // 同一日期变更再次预览：第 1 条不得被再次列入（不得再推迟 1 天）
    const again = await scheduleHandler.main({ action: 'checkup.migrate-preview', schemaVersion: 1, oldLmpDate: '2026-06-01', newLmpDate: '2026-06-02' })
    assert.ok(again.ok)
    assert.equal(again.data.toUpdate.length, 1, `只应剩第 2 条，实得 ${JSON.stringify(again.data.toUpdate)}`)
    assert.equal(again.data.toUpdate[0].id, 'chk_tpl_w20')
    assert.equal(again.data.toUpdate[0].newDateKey, '2026-07-28')
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_tpl_w12').dateKey, '2026-06-30')
    // 连续第二次 LMP 修改：按来源绝对计算（06-01→06-03 = +2 天）
    const second = await scheduleHandler.main({ action: 'checkup.migrate-preview', schemaVersion: 1, oldLmpDate: '2026-06-01', newLmpDate: '2026-06-03' })
    assert.ok(second.ok)
    const w12 = second.data.toUpdate.find(r => r.id === 'chk_tpl_w12')
    assert.ok(w12, '第 1 条按新变更应重新列入')
    assert.equal(w12.newDateKey, '2026-07-01', '来源 06-29 + 2 天（不是 06-30 再 +2）')
  })

  await scenario('服务17：migrate-apply 拒绝日历不存在的目标日期（2026-02-31 不落盘）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud)
    await scheduleHandler.main({ action: 'checkup.initialize', schemaVersion: 1, operationId: 's17a', expectedRevision: 0, templates: [
      { templateKey: 'w12', dateKey: '2026-06-29', templateLmp: '2026-06-01', examItems: [] },
      { templateKey: 'w20', dateKey: '2026-07-27', templateLmp: '2026-06-01', examItems: [] }
    ] })
    // 非法目标与合法目标同批：非法项拒绝且不写盘，合法项正常执行（单项语义）
    const res = await scheduleHandler.main({ action: 'checkup.migrate-apply', schemaVersion: 1, operationId: 's17b', expectedRevision: 0, ops: [
      { id: 'chk_tpl_w12', newDateKey: '2026-02-31', expectedRevision: 1 },
      { id: 'chk_tpl_w20', newDateKey: '2026-07-28', expectedRevision: 1 }
    ] })
    assert.ok(res.ok, '顶层 ok（数组单项语义）')
    assert.equal(res.data.results[0].ok, false)
    assert.equal(res.data.results[0].code, 'invalid-params')
    assert.equal(res.data.results[1].ok, true)
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_tpl_w12').dateKey, '2026-06-29', '非法日期未写入')
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_tpl_w12').sortKey, '2026-06-29:chk_tpl_w12')
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_tpl_w20').dateKey, '2026-07-28', '合法项正常迁移')
    assert.equal(cloud.__count('mc_operations'), 1, '非法项不留操作记录')
  })

  // ══ store 8 组（真实客户端全栈）══
  await scenario('store1：bag 创建/拉取往返（权威 refs + 领域同步时间）', async () => {
    const { fam } = fullStack()
    await api.confirmIdentity()
    assert.equal(fam.lastBagSyncAt, null, '拉取前无完整同步时间')
    assert.equal((await fam.pullBagItems()).ok, true)
    assert.ok(fam.lastBagSyncAt, 'pullBagItems 成功后推进 lastBagSyncAt')
    const save = await fam.saveBagItem('bag_st1', { name: '吸奶器', category: 'mom', quantity: 1, prepared: false }, 0)
    assert.equal(save.ok, true, JSON.stringify(save))
    assert.equal(fam.bagItems['bag_st1'].name, '吸奶器')
  })

  await scenario('store2：混合队列路由（bag→mc-schedule，daily→mc-health 不混流）', async () => {
    const { fam } = fullStack()
    await api.confirmIdentity()
    await fam.pullAll()
    const a = await fam.saveDaily(new Date(), { weightKg: 61 })
    const b = await fam.saveBagItem('bag_st2', { name: '抱被', category: 'baby', quantity: 1, prepared: false }, 0)
    assert.ok(a.ok && b.ok, JSON.stringify([a, b]))
    const entries = api.getOutbox()
    assert.equal(entries.length, 0, '全部成功后队列为空')
  })

  await scenario('store3：bag 冲突→采用云端（先落地云端再清待办）', async () => {
    const { cloud, fam } = fullStack()
    await api.confirmIdentity()
    await fam.saveBagItem('bag_st3', { name: '纸尿裤', category: 'baby', quantity: 1, prepared: false }, 0)
    // 对端推进 revision
    await scheduleHandler.main({ action: 'bag.upsert', schemaVersion: 1, operationId: 'other-st3', expectedRevision: 1, id: 'bag_st3', payload: { quantity: 5, assignee: 'papa' } })
    // 本端以旧 revision 1 提交 → 冲突
    const r = await fam.saveBagItem('bag_st3', { location: '婴儿房' }, 1)
    assert.equal(r.ok, false)
    assert.equal(r.code, 'revision-conflict')
    const ce = api.getOutbox().find(e => e.conflict)
    assert.ok(ce, '冲突条目保留')
    assert.equal(await fam.adoptCloud(ce.id), true)
    assert.equal(api.getOutbox().length, 0)
    assert.equal(fam.bagItems['bag_st3'].quantity, 5, '云端版本已落地')
  })

  await scenario('store4：勾选稳定 itemId + 目标布尔（断网重试不翻转意图）', async () => {
    const { cloud, fam, controls } = fullStack()
    await api.confirmIdentity()
    await fam.saveCheckup('chk_st4', { dateKey: '2026-10-01', examItems: [{ itemId: 'A', text: 'A', required: true, done: false }] }, undefined, 0)
    controls.offline = true
    const r = await fam.toggleCheckupItem('chk_st4', 'A') // 意图：勾选
    assert.equal(r.ok, false)
    const entry = api.getOutbox()[0]
    assert.equal(entry.extra.targetDone, true, '待办持久化目标布尔')
    controls.offline = false
    const again = await fam.toggleCheckupItem('chk_st4', 'A') // 断网下再次点击（仍是"勾选"）
    assert.ok(again.ok, JSON.stringify(again))
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_st4').examItems[0].done, true)
    assert.equal(api.getOutbox().length, 0)
  })

  await scenario('store5：两端同意图勾选，冲突确认重提后仍是勾选（不翻转）', async () => {
    const { cloud, fam } = fullStack()
    await api.confirmIdentity()
    await fam.saveCheckup('chk_st5', { dateKey: '2026-10-01', examItems: [{ itemId: 'A', text: 'A', required: true, done: false }] }, undefined, 0)
    // 对端先提交勾选
    await scheduleHandler.main({ action: 'checkup.toggle-item', schemaVersion: 1, operationId: 'peer-st5', expectedRevision: 1, id: 'chk_st5', itemId: 'A', targetDone: true })
    // 本端旧 revision 勾选 → 冲突
    const r = await fam.toggleCheckupItem('chk_st5', 'A')
    assert.equal(r.code, 'revision-conflict')
    const ce = api.getOutbox().find(e => e.conflict)
    // 用户"确认重提"：以最新 revision + 原目标值 true 重提 → 服务器 unchanged，仍是勾选
    const res = await fam.resubmit(ce.id)
    assert.equal(res.ok, true, JSON.stringify(res))
    const doc = cloud.__snapshot('mc_checkups', 'chk_st5')
    assert.equal(doc.examItems[0].done, true, '重提不得把勾选变成取消勾选')
    assert.equal(api.getOutbox().length, 0)
  })

  await scenario('store6：普通 flushAll 不推进迁移基线；未确认的日期变化提示保留', async () => {
    const { fam } = fullStack()
    await api.confirmIdentity()
    await fam.savePregnancy({ lmpDate: '2026-06-01' })
    await fam.pullCheckups()
    assert.equal(fam.scheduleLmpKey, '2026-06-01')
    await fam.initializeCheckupTemplates([{ templateKey: 'w12', dateKey: '2026-06-29', examItems: [{ itemId: 'i1', text: 'NT', required: true }] }])
    await fam.savePregnancy({ lmpDate: '2026-06-02' })
    assert.ok(fam.lmpMigrationInfo, 'LMP 变化后应有迁移提示')
    await fam.flushAll() // 普通同步：不得认可未确认的日期迁移
    assert.equal(fam.scheduleLmpKey, '2026-06-01', '基线不得被普通同步推进')
    assert.ok(fam.lmpMigrationInfo, '迁移提示不得被普通同步消除')
  })

  await scenario('store7：两项迁移——首项成功不清批次、无 null 崩溃；全部落定才推进', async () => {
    const { cloud, fam } = fullStack()
    await api.confirmIdentity()
    await fam.savePregnancy({ lmpDate: '2026-06-01' })
    const init = await fam.initializeCheckupTemplates([
      { templateKey: 'w12', dateKey: '2026-06-29', examItems: [] },
      { templateKey: 'w20', dateKey: '2026-07-27', examItems: [] }
    ])
    assert.ok(init.ok, JSON.stringify(init))
    await fam.savePregnancy({ lmpDate: '2026-06-02' })
    const pv = await fam.previewCheckupMigration()
    assert.ok(pv.ok, JSON.stringify(pv))
    assert.equal(pv.toUpdate.length, 2)
    const r = await fam.applyCheckupMigration(pv.toUpdate) // 此前首项成功即清批次并抛 null.ids
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_tpl_w12').dateKey, '2026-06-30')
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_tpl_w20').dateKey, '2026-07-28')
    assert.equal(fam.scheduleLmpKey, '2026-06-02', '整批完成后才推进基线')
    assert.equal(fam.migrationBatch, null, '批次完成后清空')
    assert.equal(fam.lmpMigrationInfo, null, '提示消除')
    assert.equal(api.getOutbox().length, 0)
  })

  await scenario('store8：迁移部分失败恢复——冲突解决后续传；预览目标不漂移', async () => {
    const { cloud, fam } = fullStack()
    await api.confirmIdentity()
    await fam.savePregnancy({ lmpDate: '2026-06-01' })
    await fam.initializeCheckupTemplates([
      { templateKey: 'w12', dateKey: '2026-06-29', examItems: [] },
      { templateKey: 'w20', dateKey: '2026-07-27', examItems: [] }
    ])
    await fam.savePregnancy({ lmpDate: '2026-06-02' })
    // 先预览（锁定旧 revision），再让对端编辑 w20（revision 推进）
    const pv = await fam.previewCheckupMigration()
    assert.equal(pv.toUpdate.length, 2)
    await scheduleHandler.main({ action: 'checkup.upsert', schemaVersion: 1, operationId: 'peer-st8', expectedRevision: 1, id: 'chk_tpl_w20', payload: { hospital: '市妇幼' } })
    const r = await fam.applyCheckupMigration(pv.toUpdate)
    assert.equal(r.ok, false, '部分失败必须如实上报')
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_tpl_w12').dateKey, '2026-06-30', '首项已迁移')
    assert.equal(fam.scheduleLmpKey, '2026-06-01', '部分挂起时基线保留')
    assert.ok(fam.migrationBatch, '批次与未完成项保留')
    // 再次预览：w12 不重复偏移、w20 目标不变（07-28）
    const pv2 = await fam.previewCheckupMigration()
    assert.equal(pv2.toUpdate.length, 1)
    assert.equal(pv2.toUpdate[0].id, 'chk_tpl_w20')
    assert.equal(pv2.toUpdate[0].newDateKey, '2026-07-28', '恢复续传目标不漂移')
    // 冲突解决（确认重提，最新 revision）
    const ce = api.getOutbox().find(e => e.conflict)
    assert.ok(ce)
    const res = await fam.resubmit(ce.id)
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_tpl_w20').dateKey, '2026-07-28')
    assert.equal(fam.scheduleLmpKey, '2026-06-02', '续传完成后基线推进')
    assert.equal(fam.lmpMigrationInfo, null)
  })

  await scenario('store9：断网初始化模板→持久待办→重启 flushAll 续传（每 templateKey 一条）', async () => {
    const { cloud, fam, controls } = fullStack()
    await api.confirmIdentity()
    controls.offline = true
    const r = await fam.initializeBagTemplates([
      { templateKey: 't1', name: '身份证', category: 'documents' },
      { templateKey: 't2', name: '口罩', category: 'going' }
    ])
    assert.equal(r.ok, false, '断网必须如实失败')
    assert.equal(api.getOutbox().filter(e => e.kind === 'bag-init').length, 2, '每模板一条持久待办')
    controls.offline = false
    // 模拟重启：内存视图清空后从待办续传（outbox 为持久盘）
    fam.clearMemory()
    await fam.flushAll()
    assert.equal(cloud.__count('mc_bag_items'), 2, '续传后每 templateKey 至多一条')
    assert.equal(api.getOutbox().length, 0)
    // 重复点击：已存在 → skipped，不重建
    const again = await fam.initializeBagTemplates([{ templateKey: 't1', name: '身份证', category: 'documents' }])
    assert.ok(again.ok)
    assert.equal(cloud.__count('mc_bag_items'), 2)
  })

  await scenario('store10：未变更草稿离线两次提交 = 同一条操作原样重放（无伪冲突）', async () => {
    const { cloud, fam, controls } = fullStack()
    await api.confirmIdentity()
    controls.offline = true
    const payload = { name: '奶瓶', category: 'baby', quantity: 2, location: '床头柜', assignee: 'papa', prepared: false }
    const r1 = await fam.saveBagItem('bag_draft', payload, 0)
    assert.equal(r1.ok, false)
    const r2 = await fam.saveBagItem('bag_draft', payload, 0) // 未变更重试
    assert.equal(r2.ok, false)
    const entries = api.getOutbox().filter(e => e.entityId === 'bag:bag_draft')
    assert.equal(entries.length, 1, '不得产生第二条操作')
    const firstOpId = entries[0].opId
    controls.offline = false
    const r3 = await fam.saveBagItem('bag_draft', payload, 0) // 恢复后重试仍复用原请求
    assert.equal(r3.ok, true, JSON.stringify(r3))
    assert.equal(cloud.__count('mc_bag_items'), 1, '云端只有一条')
    assert.equal(api.getOutbox().length, 0, '无遗留伪冲突')
    assert.equal(cloud.__count('mc_operations'), 1, '同 opId 单条操作记录')
    void firstOpId
  })

  await scenario('store11：pullPregnancy 未就绪拒绝/空档案 ok/拉取合并/快照还原', async () => {
    const { fam } = fullStack()
    // 未确认会话：直接拒绝，不发起云调用
    assert.equal((await fam.pullPregnancy()).ok, false, '未确认会话不得拉取')
    await api.confirmIdentity()
    // 云端尚无档案：pregnancy.get 返回 null record → ok 且本地保持 null
    assert.equal(fam.pregnancy, null)
    const empty = await fam.pullPregnancy()
    assert.equal(empty.ok, true, JSON.stringify(empty))
    assert.equal(fam.pregnancy, null, '空档案不得注入伪造记录')
    // 对端建档后拉取：字段/revision 落地 + 快照落盘可还原
    await healthHandler.main({ action: 'pregnancy.upsert', schemaVersion: 1, operationId: 'peer-st11', expectedRevision: 0, payload: { lmpDate: '2026-01-05', hospital: '市一医院', babyNickname: '小汤圆' } })
    const r = await fam.pullPregnancy()
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(fam.pregnancy.fields.lmpDate, '2026-01-05')
    assert.equal(fam.pregnancy.fields.hospital, '市一医院')
    assert.equal(fam.pregnancy.fields.babyNickname, '小汤圆')
    assert.equal(fam.pregnancy.revision, 1)
    fam.clearMemory()
    assert.equal(fam.pregnancy, null, '清内存后为空')
    assert.equal(fam.restoreFromCache(), true)
    assert.equal(fam.pregnancy.fields.lmpDate, '2026-01-05', '快照还原孕期档案')
  })

  // ══ 待产包页 6 组（真实 SFC）══
  const bagPageExports = `export {dataSource,items,localItems,addItem,doDelete,toggleItem,generateTemplates,retrySync,openEdit,saveEdit,adoptCloudFor,resubmitFor,newItemText,newItemCategory,newItemQuantity,newItemLocation,newItemAssignee,pendingDraftId,editTargetId,editBaselineRevision,editName,editQuantity,editLocation,editAssignee,bagPendingEntries,bagConflictList,familyStore,getOutbox,badgeLabel,badgeClass,deleteTarget,itemMeta};`

  await scenario('bag页1：新增读真实输入（名称/分类/数量/位置/负责人）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    const page = bundlePage('pages/profile/hospital-bag.vue', withPinia, bagPageExports)
    await confirmPageBundle(page, cloud)
    page.newItemText.value = '婴儿监护仪'
    page.newItemCategory.value = 'going'
    page.newItemQuantity.value = 3
    page.newItemLocation.value = '玄关背包'
    page.newItemAssignee.value = 'papa'
    await page.addItem()
    await tick()
    const all = [...cloud.__state.store.keys()].filter(k => k.startsWith('mc_bag_items/'))
    assert.equal(all.length, 1)
    const created = cloud.__snapshot('mc_bag_items', all[0].slice('mc_bag_items/'.length))
    assert.equal(created.name, '婴儿监护仪')
    assert.equal(created.category, 'going')
    assert.equal(created.quantity, 3)
    assert.equal(created.location, '玄关背包')
    assert.equal(created.assignee, 'papa')
    assert.equal(page.pendingDraftId.value, '', '成功后草稿 ID 释放')
  })

  await scenario('bag页2：权威 items 展示 text/数量 meta；going 分类可见', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    const page = bundlePage('pages/profile/hospital-bag.vue', withPinia, bagPageExports)
    await confirmPageBundle(page, cloud)
    await scheduleHandler.main({ action: 'bag.upsert', schemaVersion: 1, operationId: 'bp2', expectedRevision: 0, id: 'bag_g1', payload: { name: '充电宝', category: 'going', quantity: 2, location: '背包', assignee: 'mama', prepared: true } })
    await page.familyStore.pullBagItems()
    assert.equal(page.dataSource.value, 'family')
    const it = page.items.value.find(i => i.id === 'bag_g1')
    assert.ok(it, '权威条目进入页面 computed')
    assert.equal(it.text, '充电宝', '模板消费 item.text')
    assert.equal(it.done, true)
    assert.equal(it.quantity, 2)
    // going 分类有徽标映射（不可见分类检查）
    assert.equal(page.badgeLabel('going'), '随身')
    assert.equal(page.badgeClass('documents'), 'badge-doc')
    assert.equal(page.itemMeta(it), '背包 · 妈妈准备', 'meta 显示位置/负责人')
  })

  await scenario('bag页3：删除走云端墓碑（刷新不复活）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    const page = bundlePage('pages/profile/hospital-bag.vue', withPinia, bagPageExports)
    await confirmPageBundle(page, cloud)
    await scheduleHandler.main({ action: 'bag.upsert', schemaVersion: 1, operationId: 'bp3', expectedRevision: 0, id: 'bag_del', payload: { name: '出院服', category: 'mom', quantity: 1, prepared: false } })
    await page.familyStore.pullBagItems()
    const item = page.items.value.find(i => i.id === 'bag_del')
    assert.ok(item)
    page.deleteTarget.value = item
    await page.doDelete()
    await tick()
    await page.familyStore.pullBagItems()
    assert.ok(!page.items.value.find(i => i.id === 'bag_del'), '墓碑后不再展示')
    assert.equal(cloud.__snapshot('mc_bag_items', 'bag_del').deleted, true, '服务端墓碑而非物理消失')
  })

  await scenario('bag页4：草稿 ID 复用 + 未变更重试单条操作（离线两次→联网一条）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    const controls = { offline: false }
    const page = bundlePage('pages/profile/hospital-bag.vue', withPinia, bagPageExports)
    await confirmPageBundle(page, cloud, controls)
    controls.offline = true
    page.newItemText.value = '产妇卫生巾'
    page.newItemCategory.value = 'mom'
    await page.addItem()
    await tick()
    await page.addItem() // 未变更重试
    await tick()
    const entries = page.getOutbox().filter(e => e.entityId && e.entityId.startsWith('bag:'))
    assert.equal(entries.length, 1, '同一未变更草稿只有一条操作')
    assert.equal(page.pendingDraftId.value !== '', true, '失败草稿 ID 保留')
    controls.offline = false
    await page.familyStore.flushAll()
    await tick()
    const all = [...cloud.__state.store.keys()].filter(k => k.startsWith('mc_bag_items/'))
    assert.equal(all.length, 1, '云端只有一条')
    assert.equal(page.getOutbox().length, 0, '无伪冲突遗留')
    assert.equal(cloud.__count('mc_operations'), 1, '同 opId 单条操作')
  })

  await scenario('bag页5：编辑器打开捕获 revision 基线；后台刷新不抬高提交版本', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    const page = bundlePage('pages/profile/hospital-bag.vue', withPinia, bagPageExports)
    await confirmPageBundle(page, cloud)
    await scheduleHandler.main({ action: 'bag.upsert', schemaVersion: 1, operationId: 'bp5a', expectedRevision: 0, id: 'bag_ed', payload: { name: '抱被', category: 'baby', quantity: 1, prepared: false } })
    await page.familyStore.pullBagItems()
    const item = page.items.value.find(i => i.id === 'bag_ed')
    page.openEdit(item)
    assert.equal(page.editBaselineRevision.value, 1, '打开捕获旧 revision')
    assert.equal(page.editName.value, '抱被')
    // 对端推进 revision + 本端后台拉取——表单基线不变
    await scheduleHandler.main({ action: 'bag.upsert', schemaVersion: 1, operationId: 'bp5b', expectedRevision: 1, id: 'bag_ed', payload: { quantity: 7 } })
    await page.familyStore.pullBagItems()
    assert.equal(page.editBaselineRevision.value, 1, '后台刷新不抬高提交版本')
    page.editQuantity.value = 3
    page.editLocation.value = '婴儿房'
    await page.saveEdit()
    // 基线 1 vs 服务端 2 → 冲突（不静默覆盖对方数量 7）
    const ce = page.getOutbox().find(e => e.conflict)
    assert.ok(ce, '旧基线提交必须冲突而非覆盖')
    assert.equal(cloud.__snapshot('mc_bag_items', 'bag_ed').quantity, 7)
    assert.equal(await page.familyStore.adoptCloud(ce.id), true)
    assert.equal(page.getOutbox().length, 0)
  })

  await scenario('bag页6：模板生成走持久协议（断网排队→联网一键补齐）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    const controls = { offline: false }
    const page = bundlePage('pages/profile/hospital-bag.vue', withPinia, bagPageExports)
    await confirmPageBundle(page, cloud, controls)
    controls.offline = true
    await page.generateTemplates()
    assert.ok(page.getOutbox().filter(e => e.kind === 'bag-init').length > 0, '断网时模板项进入持久待办')
    controls.offline = false
    await page.retrySync()
    const count = cloud.__count('mc_bag_items')
    assert.ok(count >= 25, `联网重试后生成完整清单（实得 ${count}）`)
    assert.equal(page.getOutbox().length, 0)
    // 断言清单含 going 分类（服务端接受）
    const keys = [...cloud.__state.store.keys()].filter(k => k.startsWith('mc_bag_items/'))
    const cats = new Set(keys.map(k => cloud.__snapshot('mc_bag_items', k.slice('mc_bag_items/'.length)).category))
    assert.ok(cats.has('going'), '标准清单含 going 分类')
    assert.ok(cats.has('documents'), '标准清单含 documents 分类')
  })

  // ══ 产检页 7 组（真实 SFC）══
  const chkPageExports = `export {dataSource,nextCheckup,completedCheckups,handleToggleItem,handleMarkCompleted,doSkipCheckup,doAddItem,openEditor,saveEditor,generateSchedule,regenerateSchedule,showRegenModal,openMigrationPreview,confirmMigration,migrationInfo,migrationPreview,famCheckupCount,chkPendingEntries,chkConflictList,retrySync,editChk,edDate,edTime,edHospital,edCompanion,edMaterials,edQuestions,weekLabelFor,familyStore,getOutbox,infoDate,infoHospital,daysUntil,isOverdue,healthStore,skipTarget,addItemTarget,heroDate,formatHistoryDate,handleSkipCheckup,handleAddItem};`

  function bundleCheckupPage(cloud, controls) {
    const page = bundlePage('pages/profile/checkup-reminder.vue', withPinia, chkPageExports)
    return { page, confirm: () => confirmPageBundle(page, cloud, controls) }
  }

  await scenario('产检页1：权威 nextCheckup + week_label（无 undefined）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    const { page, confirm } = bundleCheckupPage(cloud)
    await confirm()
    await page.familyStore.savePregnancy({ lmpDate: '2026-06-01' })
    await page.familyStore.saveCheckup('chk_p1', { dateKey: '2026-08-10', examItems: [{ itemId: 'A', text: '糖耐', required: true, done: false }] }, undefined, 0)
    await page.familyStore.pullCheckups()
    assert.equal(page.dataSource.value, 'family')
    const nc = page.nextCheckup.value
    assert.ok(nc, '权威记录驱动 nextCheckup')
    assert.equal(nc._id, 'chk_p1')
    assert.equal(nc.exam_items[0].itemId, 'A')
    assert.ok(/^孕\d+周\+\d+$/.test(nc.week_label), `week_label 形如 孕X周+Y（实得 ${nc.week_label}）`)
  })

  await scenario('产检页2：勾选按稳定 itemId（点击后列表重排不误勾他项）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    const { page, confirm } = bundleCheckupPage(cloud)
    await confirm()
    await page.familyStore.saveCheckup('chk_p2', { dateKey: '2026-08-10', examItems: [{ itemId: 'A', text: 'A', required: true, done: false }, { itemId: 'B', text: 'B', required: false, done: false }] }, undefined, 0)
    await page.familyStore.pullCheckups()
    // 捕获"点击 A"后，对端把顺序改为 B,A 并拉取，再执行原点击
    await scheduleHandler.main({ action: 'checkup.upsert', schemaVersion: 1, operationId: 'p2re', expectedRevision: 1, id: 'chk_p2', payload: { examItems: [{ itemId: 'B', text: 'B', required: false, done: false }, { itemId: 'A', text: 'A', required: true, done: false }] } })
    await page.familyStore.pullCheckups()
    await page.handleToggleItem('chk_p2', 'A', 0) // 捕获父记录 ID + 稳定 itemId；旧下标 0 现在是 B
    const doc = cloud.__snapshot('mc_checkups', 'chk_p2')
    const A = doc.examItems.find(i => i.itemId === 'A')
    const B = doc.examItems.find(i => i.itemId === 'B')
    assert.equal(A.done, true, 'A 被勾选')
    assert.equal(B.done, false, 'B 不被误勾')
  })

  await scenario('产检页3：完成/跳过状态操作走权威源', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    const { page, confirm } = bundleCheckupPage(cloud)
    await confirm()
    await page.familyStore.saveCheckup('chk_p3a', { dateKey: '2026-08-01', examItems: [] }, undefined, 0)
    await page.familyStore.saveCheckup('chk_p3b', { dateKey: '2026-08-20', examItems: [] }, undefined, 0)
    await page.familyStore.pullCheckups()
    assert.equal(page.nextCheckup.value._id, 'chk_p3a')
    await page.handleMarkCompleted()
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_p3a').status, 'completed')
    assert.equal(page.nextCheckup.value._id, 'chk_p3b', '完成后下一次顶上')
    page.handleSkipCheckup() // 打开弹层（捕获 chk_p3b）
    await page.doSkipCheckup()
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_p3b').status, 'skipped')
  })

  await scenario('产检页4：编辑器（日期/时间/医院/陪同/材料/问题）+ 基线冲突不覆盖', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    const { page, confirm } = bundleCheckupPage(cloud)
    await confirm()
    await page.familyStore.saveCheckup('chk_p4', { dateKey: '2026-08-10', examItems: [] }, undefined, 0)
    await page.familyStore.pullCheckups()
    page.openEditor()
    assert.equal(page.editChk.value.baseline, 1)
    page.edDate.value = '2026-08-12'
    page.edTime.value = '09:30'
    page.edHospital.value = '市妇幼'
    page.edCompanion.value = '孩子爸爸'
    page.edMaterials.value = '医保卡\n母子健康手册'
    page.edQuestions.value = '胎动偏少正常吗？'
    // 对端先改 → 本端旧基线提交冲突
    await scheduleHandler.main({ action: 'checkup.upsert', schemaVersion: 1, operationId: 'p4peer', expectedRevision: 1, id: 'chk_p4', payload: { hospital: '省人民' } })
    await page.saveEditor()
    const doc = cloud.__snapshot('mc_checkups', 'chk_p4')
    assert.equal(doc.hospital, '省人民', '旧基线不得覆盖对端')
    assert.equal(doc.dateKey, '2026-08-10')
    const ce = page.getOutbox().find(e => e.conflict)
    assert.ok(ce)
    assert.equal(await page.familyStore.adoptCloud(ce.id), true)
    // 无对端竞争时正常保存全字段
    page.openEditor()
    page.edDate.value = '2026-08-12'
    page.edTime.value = '09:30'
    page.edHospital.value = '市妇幼'
    page.edCompanion.value = '孩子爸爸'
    page.edMaterials.value = '医保卡\n母子健康手册'
    page.edQuestions.value = '胎动偏少正常吗？'
    await page.saveEditor()
    const doc2 = cloud.__snapshot('mc_checkups', 'chk_p4')
    assert.equal(doc2.dateKey, '2026-08-12')
    assert.equal(doc2.time, '09:30')
    assert.equal(doc2.hospital, '市妇幼')
    assert.equal(doc2.companion, '孩子爸爸')
    assert.deepEqual(doc2.materials, ['医保卡', '母子健康手册'])
    assert.deepEqual(doc2.questions, ['胎动偏少正常吗？'])
  })

  await scenario('产检页5：添加检查项 family 路由（稳定新 itemId）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    const { page, confirm } = bundleCheckupPage(cloud)
    await confirm()
    await page.familyStore.saveCheckup('chk_p5', { dateKey: '2026-08-10', examItems: [{ itemId: 'A', text: 'A', required: true, done: false }] }, undefined, 0)
    await page.familyStore.pullCheckups()
    page.handleAddItem() // 打开弹层（捕获 chk_p5）
    await page.doAddItem('骨密度检测')
    const doc = cloud.__snapshot('mc_checkups', 'chk_p5')
    assert.equal(doc.examItems.length, 2)
    const added = doc.examItems.find(i => i.text === '骨密度检测')
    assert.ok(added && added.itemId && added.itemId !== 'A', '新项目有稳定独立 itemId')
  })

  await scenario('产检页6：空档案生成标准产检安排（按 LMP 计算日期 + 记录级基线）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    const { page, confirm } = bundleCheckupPage(cloud)
    await confirm()
    await page.familyStore.savePregnancy({ lmpDate: '2026-06-01' })
    await page.familyStore.pullCheckups()
    assert.equal(page.famCheckupCount.value, 0, '空档案无隐藏写入')
    assert.equal(cloud.__count('mc_checkups'), 0)
    await page.generateSchedule()
    await page.familyStore.pullCheckups()
    assert.equal(page.famCheckupCount.value, 14, '标准 14 次安排')
    const w12 = cloud.__snapshot('mc_checkups', 'chk_tpl_std_w12')
    assert.equal(w12.dateKey, '2026-08-24', 'LMP 06-01 + 12 周（84 天）')
    assert.equal(w12.templateLmp, '2026-06-01', '记录级来源基线持久')
    assert.equal(w12.templateDate, '2026-08-24')
    assert.equal(w12.source, 'template')
  })

  await scenario('产检页7：日期迁移预览→确认（部分失败恢复→续传→提示消除）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    const { page, confirm } = bundleCheckupPage(cloud)
    await confirm()
    await page.familyStore.savePregnancy({ lmpDate: '2026-06-01' })
    await page.generateSchedule()
    await page.familyStore.pullCheckups()
    assert.equal(page.migrationInfo.value, null, '生成后基线一致，无提示')
    await page.familyStore.savePregnancy({ lmpDate: '2026-06-02' })
    assert.ok(page.migrationInfo.value, 'LMP 变化出现迁移横幅')
    // 先预览（锁定旧 revision），再对端编辑一条 → 确认后该项冲突（部分失败）
    await page.openMigrationPreview()
    assert.ok(page.migrationPreview.value && page.migrationPreview.value.toUpdate.length === 14)
    await scheduleHandler.main({ action: 'checkup.upsert', schemaVersion: 1, operationId: 'p7peer', expectedRevision: 1, id: 'chk_tpl_std_w40', payload: { hospital: '市妇幼' } })
    await page.confirmMigration()
    const moved = cloud.__snapshot('mc_checkups', 'chk_tpl_std_w8')
    assert.equal(moved.dateKey, '2026-07-28', '07-27 + 1 天')
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_tpl_std_w40').hospital, '市妇幼', '冲突项未被覆盖')
    assert.ok(page.migrationInfo.value, '部分挂起时提示保留')
    // 解决冲突（确认重提）→ 整批完成 → 提示消除
    const ce = page.getOutbox().find(e => e.conflict)
    assert.ok(ce)
    await page.familyStore.resubmit(ce.id)
    assert.equal(page.migrationInfo.value, null, '整批落定后提示消除')
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_tpl_std_w40').dateKey, '2027-03-09', '40 周 = 06-01+280 天（2027-03-08）+1')
    assert.equal(page.getOutbox().length, 0)
  })

  // ══ 会话边界复现（review 终节：批次执行中切换成员）══
  await scenario('store14：首项迁移响应挂起期间切换成员——第二项不以新成员入队，清单留原成员', async () => {
    const { cloud, fam, controls, routes, setMember } = fullStack()
    await api.confirmIdentity()
    await fam.savePregnancy({ lmpDate: '2026-06-01' })
    await fam.initializeCheckupTemplates([
      { templateKey: 'w12', dateKey: '2026-06-29', examItems: [] },
      { templateKey: 'w20', dateKey: '2026-07-27', examItems: [] }
    ])
    await fam.savePregnancy({ lmpDate: '2026-06-02' })
    const pv = await fam.previewCheckupMigration()
    assert.equal(pv.toUpdate.length, 2)
    // 挂起第一个迁移响应；apply 循环在第 1 项 familyCall 上等待
    controls.holdSchedule = true
    const applying = fam.applyCheckupMigration(pv.toUpdate)
    for (let i = 0; i < 50 && !controls.releaseHeld; i++) await tick()
    assert.ok(controls.releaseHeld, '首项响应已挂起')
    // 确认另一成员（papa）：epoch/成员切换，familyStore watcher 清内存
    routes['mc-identity'] = () => ({ ok: true, data: { memberId: 'papa', displayName: '爸爸', familyId: TEST_ENV.MC_FAMILY_ID } })
    setMember('papa')
    await api.confirmIdentity()
    await tick()
    // 释放旧响应：第 1 项按 stale-session 丢弃；循环必须在第 2 项入队前停止
    controls.releaseHeld()
    const r = await applying
    assert.equal(r.ok, false)
    assert.equal(r.code, 'stale-session', JSON.stringify(r.code))
    // 新成员（papa）名下零迁移待办、零迁移清单
    assert.equal(api.getOutbox().filter(e => e.kind === 'checkup-migrate').length, 0, '第二项不得以新成员入队')
    const papaSnap = storage.get('mc_cache_env-b2b1_wxapp-b2b1_papa_b1_b2a-snapshot')
    assert.ok(!papaSnap || !JSON.parse(papaSnap).migrationBatch, '新成员缓存无迁移清单')
    // 云端：第 1 项已在切换前由原成员提交（可移动）；第 2 项未被任何人移动
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_tpl_w12').dateKey, '2026-06-30')
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_tpl_w20').dateKey, '2026-07-27', '第 2 项未被新成员提交')
    // 原成员（mama）清单留在其命名空间：切回 mama 后可续传完成
    routes['mc-identity'] = () => ({ ok: true, data: { memberId: 'mama', displayName: '妈妈', familyId: TEST_ENV.MC_FAMILY_ID } })
    setMember('mama')
    await api.confirmIdentity()
    await tick()
    assert.ok(fam.migrationBatch && fam.migrationBatch.items.length === 2, '原成员清单保留')
    await fam.flushAll()
    await tick()
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_tpl_w20').dateKey, '2026-07-28', '原成员续传完成')
    assert.equal(fam.scheduleLmpKey, '2026-06-02')
    assert.equal(api.getOutbox().length, 0)
  })

  // ══ 追加复现组（review 冻结前复核：迁移响应/清单落盘/恢复/冷启动/显示/时钟）══
  await scenario('store11：migrate-apply 响应含稳定 id，store 立即更新（不重拉）', async () => {
    const { cloud, fam } = fullStack()
    await api.confirmIdentity()
    await fam.savePregnancy({ lmpDate: '2026-06-01' })
    await fam.initializeCheckupTemplates([{ templateKey: 'w12', dateKey: '2026-06-29', examItems: [] }])
    await fam.savePregnancy({ lmpDate: '2026-06-02' })
    const pv = await fam.previewCheckupMigration()
    const r = await fam.applyCheckupMigration(pv.toUpdate)
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.ok(r.results[0].record && r.results[0].record.id === 'chk_tpl_w12', '响应 record.id 必须可定位')
    assert.equal(fam.checkups['chk_tpl_w12'].dateKey, '2026-06-30', 'store 立即更新（不依赖重拉）')
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_tpl_w12').dateKey, '2026-06-30')
  })

  await scenario('store12：清单落盘失败——apply 不发网络，flushAll 也不得从未持久化清单恢复发送', async () => {
    const { cloud, fam } = fullStack()
    await api.confirmIdentity()
    await fam.savePregnancy({ lmpDate: '2026-06-01' })
    await fam.initializeCheckupTemplates([{ templateKey: 'w12', dateKey: '2026-06-29', examItems: [] }])
    await fam.savePregnancy({ lmpDate: '2026-06-02' })
    const pv = await fam.previewCheckupMigration()
    // 仅令 b2a-snapshot 缓存写入失败（outbox 写入仍成功）
    const realSet = global.uni.setStorageSync
    global.uni.setStorageSync = (k, v) => {
      if (String(k).includes('b2a-snapshot')) throw new Error('disk full (mock)')
      return realSet(k, v)
    }
    try {
      const r = await fam.applyCheckupMigration(pv.toUpdate)
      assert.equal(r.ok, false)
      assert.equal(r.code, 'manifest-persist-failed')
      // 内存清单回滚：恢复逻辑不得据此发送
      await fam.flushAll()
      await tick()
      assert.equal(cloud.__snapshot('mc_checkups', 'chk_tpl_w12').dateKey, '2026-06-29', '零迁移网络请求')
      assert.equal(api.getOutbox().filter(e => e.kind === 'checkup-migrate').length, 0, '无迁移待办入队')
      assert.equal(fam.migrationBatch, null, '未持久化清单不留内存')
    } finally {
      global.uni.setStorageSync = realSet
    }
    // 恢复写盘后重试成功
    const again = await fam.applyCheckupMigration(pv.toUpdate)
    assert.equal(again.ok, true, JSON.stringify(again))
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_tpl_w12').dateKey, '2026-06-30')
  })

  await scenario('store13：清单已持久化但部分项未入队→重启→flushAll 按原目标/revision 恢复', async () => {
    const { cloud, fam } = fullStack()
    await api.confirmIdentity()
    await fam.savePregnancy({ lmpDate: '2026-06-01' })
    await fam.initializeCheckupTemplates([
      { templateKey: 'w12', dateKey: '2026-06-29', examItems: [] },
      { templateKey: 'w20', dateKey: '2026-07-27', examItems: [] }
    ])
    await fam.savePregnancy({ lmpDate: '2026-06-02' })
    const pv = await fam.previewCheckupMigration()
    assert.equal(pv.toUpdate.length, 2)
    // 构造崩溃窗口：第1项已落定（对端完成），第2项已确认目标但尚未入队
    await scheduleHandler.main({ action: 'checkup.migrate-apply', schemaVersion: 1, operationId: 'peer-w12', expectedRevision: 0, ops: [{ id: 'chk_tpl_w12', newDateKey: '2026-06-30', expectedRevision: 1 }] })
    fam.migrationBatch = {
      oldLmpDateKey: '2026-06-01', newLmpDateKey: '2026-06-02',
      items: pv.toUpdate.map(m => ({ id: m.id, newDateKey: m.newDateKey, revision: m.revision })),
      settled: { 'chk_tpl_w12': 'ok' },
      persistedAt: Date.now()
    }
    await fam.pullCheckups() // 公共路径持久化快照（清单随快照落盘）
    // 重启：全新 store 实例，仅从持久盘恢复
    api.setActivePinia(api.createPinia())
    const fam2 = api.useFamilyStore()
    assert.equal(fam2.restoreFromCache(), true)
    const rb = fam2.migrationBatch
    assert.ok(rb && Array.isArray(rb.items) && rb.items.length === 2, '清单跨重启可读（含目标与 revision）')
    await fam2.flushAll()
    await tick()
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_tpl_w20').dateKey, '2026-07-28', '未入队项按原目标恢复执行')
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_tpl_w12').dateKey, '2026-06-30', '已落定项不重复移动')
    assert.equal(fam2.scheduleLmpKey, '2026-06-02', '整批完成后基线推进')
    assert.equal(api.getOutbox().length, 0)
  })

  await scenario('冷启动1：待产包页冷启动确认后拉取权威数据（不等再次进入）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    await scheduleHandler.main({ action: 'bag.upsert', schemaVersion: 1, operationId: 'cold1', expectedRevision: 0, id: 'bag_cold', payload: { name: '冷启动物品', category: 'mom', quantity: 1, prepared: false } })
    const controls = { offline: false }
    const page = bundlePage('pages/profile/hospital-bag.vue', withPinia, bagPageExports)
    setupPageRoutes(page, cloud, controls) // 只配路由，不确认（冷启动）
    storage.set('mc_session_env-b2b1_wxapp-b2b1', '1') // 持久会话标记：冷启动联网确认的前提
    assert.equal(page.dataSource.value, 'prompt', '确认前不展示正式数据')
    await page.shows[0]() // 冷启动 onShow → coldStartConfirm（去重联网确认）
    await tick()
    assert.equal(page.dataSource.value, 'family', '确认成功即激活')
    assert.ok(page.items.value.some(i => i.id === 'bag_cold'), '权威数据已拉取，无需返回再进入')
  })

  await scenario('冷启动2：产检页/我的页异步确认后由 watcher 激活拉取', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    await scheduleHandler.main({ action: 'checkup.upsert', schemaVersion: 1, operationId: 'cold2', expectedRevision: 0, id: 'chk_cold', payload: { dateKey: '2026-10-01', examItems: [] } })
    // 产检页：冷启动
    storage.set('mc_session_env-b2b1_wxapp-b2b1', '1')
    const { page } = bundleCheckupPage(cloud)
    setupPageRoutes(page, cloud) // 只配路由，不确认（冷启动）
    assert.equal(page.dataSource.value, 'prompt')
    await page.shows[0]()
    await tick()
    assert.equal(page.dataSource.value, 'family')
    assert.equal(page.famCheckupCount.value, 1, 'watcher 激活后领域数据到位')
    // 我的页：异步确认（任意入口完成）→ watcher 激活
    freshDisk(); clearServerEnv(); setServerEnv()
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    storage.set('mc_session_env-b2b1_wxapp-b2b1', '1')
    const profPage = bundlePage('pages/profile/index.vue', withPinia,
      `export {dataSource,hospitalBagSubtitle,todoItems,nextCheckupCard,familyStore};`)
    setupPageRoutes(profPage, cloud)
    assert.notEqual(profPage.dataSource.value, 'family')
    await profPage.confirmIdentity() // 任意入口异步完成确认
    await tick()
    assert.equal(profPage.dataSource.value, 'family', '确认完成即激活')
  })

  await scenario('显示1：编辑器真实 HH:mm 显示；未设置不编造 09:30/14:00；医院三态', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    const { page, confirm } = bundleCheckupPage(cloud)
    await confirm()
    await page.familyStore.saveCheckup('chk_t1', { dateKey: '2026-09-22', time: '16:45', hospital: '市妇幼', examItems: [] }, undefined, 0)
    await page.familyStore.pullCheckups()
    assert.ok(page.infoDate.value.includes('16:45'), `infoDate 显示真实时间（实得 ${page.infoDate.value}）`)
    assert.ok(!page.infoDate.value.includes('14:00') && !page.infoDate.value.includes('09:30'))
    assert.equal(page.infoHospital.value, '市妇幼')
    // 未设置时间：不编造；未设置医院：明示未设置（不回落旧本地档案）
    await page.familyStore.saveCheckup('chk_t2', { dateKey: '2026-12-01', examItems: [] }, undefined, 0)
    await page.familyStore.markCheckupStatus('chk_t1', 'completed') // 让 t2 顶上下一次
    await page.familyStore.pullCheckups()
    assert.ok(!page.infoDate.value.includes('14:00') && !page.infoDate.value.includes('09:30'), '未设置时间不编造')
    assert.equal(page.infoHospital.value, '未设置医院')
  })

  await scenario('显示2：倒计时按上海日号+响应式时钟（跨上海午夜自动更新，记录不变）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    const { page, confirm } = bundleCheckupPage(cloud)
    await confirm()
    await page.familyStore.saveCheckup('chk_t3', { dateKey: '2026-09-22', examItems: [] }, undefined, 0)
    await page.familyStore.pullCheckups()
    // 上海 2026-09-21 深夜（UTC 设备下 = UTC 09-21 15:59+）：距 09-22 应为 1
    page.healthStore.today = new Date(Date.UTC(2026, 8, 21, 15, 59, 0))
    assert.equal(page.daysUntil.value, 1, '上海日号差，非瞬时时差')
    assert.equal(page.isOverdue.value, false)
    // 推进上海午夜（UTC 16:00）→ 0；同一记录不变也随 refreshToday 更新
    page.healthStore.today = new Date(Date.UTC(2026, 8, 21, 16, 0, 0))
    assert.equal(page.daysUntil.value, 0, '跨上海午夜自动重算')
    // 再过一天 → 逾期
    page.healthStore.today = new Date(Date.UTC(2026, 8, 22, 16, 0, 0))
    assert.equal(page.isOverdue.value, true)
  })

  await scenario('产检页8：弹层/点击捕获原记录身份——下一条顶替后不误跳过/误添加/误勾', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    const { page, confirm } = bundleCheckupPage(cloud)
    await confirm()
    await page.familyStore.saveCheckup('chk_m1', { dateKey: '2026-08-01', examItems: [] }, undefined, 0)
    await page.familyStore.saveCheckup('chk_m2', { dateKey: '2026-08-20', examItems: [{ itemId: 'B1', text: 'B项', required: true, done: false }] }, undefined, 0)
    await page.familyStore.pullCheckups()
    assert.equal(page.nextCheckup.value._id, 'chk_m1')
    // 跳过弹层打开（捕获 chk_m1@rev1）→ 对端完成 m1 → 拉取后 next 顶替为 m2 → 确认旧弹窗
    page.handleSkipCheckup()
    assert.ok(page.skipTarget.value && page.skipTarget.value.id === 'chk_m1' && page.skipTarget.value.revision === 1, '打开时固定原记录与版本')
    await scheduleHandler.main({ action: 'checkup.upsert', schemaVersion: 1, operationId: 'peer-m1', expectedRevision: 1, id: 'chk_m1', payload: {}, status: 'completed' })
    await page.familyStore.pullCheckups()
    assert.equal(page.nextCheckup.value._id, 'chk_m2', '下一条顶替')
    await page.doSkipCheckup()
    await tick()
    // 旧基线(rev1) vs 服务端(rev2)：冲突固定在 chk_m1，绝不能把 m2 跳过
    const ce = page.getOutbox().find(e => e.conflict)
    assert.ok(ce && ce.entityId === 'checkup:chk_m1', `冲突固定在原记录（实得 ${ce && ce.entityId}）`)
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_m2').status, 'pending', '顶替记录不被误跳过')
    await page.familyStore.resubmit(ce.id)
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_m1').status, 'skipped', '确认重提按原意图跳过 m1')
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_m2').status, 'pending')
    // 添加检查项弹层：打开捕获 m2 → 对端编辑 m2 → 确认 → 冲突固定在 m2，不覆盖云端
    page.handleAddItem()
    assert.ok(page.addItemTarget.value && page.addItemTarget.value.id === 'chk_m2' && page.addItemTarget.value.revision === 1)
    await scheduleHandler.main({ action: 'checkup.upsert', schemaVersion: 1, operationId: 'peer-m2', expectedRevision: 1, id: 'chk_m2', payload: { hospital: '市妇幼' } })
    await page.familyStore.pullCheckups()
    await page.doAddItem('骨密度检测')
    await tick()
    const ce2 = page.getOutbox().find(e => e.conflict)
    assert.ok(ce2 && ce2.entityId === 'checkup:chk_m2', '添加冲突固定在原记录')
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_m2').examItems.length, 1, '云端未被旧基线覆盖')
    await page.familyStore.resubmit(ce2.id)
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_m2').examItems.length, 2, '确认重提后加入原记录')
    // 勾选父记录绑定：对端完成 m2 → next 为空 → 仍按捕获父记录 ID 勾选 m2 的 B1
    await scheduleHandler.main({ action: 'checkup.upsert', schemaVersion: 1, operationId: 'peer-m2c', expectedRevision: 3, id: 'chk_m2', payload: {}, status: 'completed' })
    await page.familyStore.pullCheckups()
    assert.equal(page.nextCheckup.value, null, '全部完成后无下次产检')
    await page.handleToggleItem('chk_m2', 'B1', 0)
    const m2 = cloud.__snapshot('mc_checkups', 'chk_m2')
    assert.equal(m2.examItems.find(i => i.itemId === 'B1').done, true, '按捕获父记录 ID 勾选（不依赖当前 nextCheckup）')
  })

  await scenario('产检页9：重新生成——未完成自动安排纠偏日期/重置检查项；手动改期、自建不动；缺失补建', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    const { page, confirm } = bundleCheckupPage(cloud)
    await confirm()
    await page.familyStore.savePregnancy({ lmpDate: '2026-06-01' })
    // 两条模板 + 一条自建；w8 勾掉一项并加自定义项/医院，w16 手动改期（→manual-date）
    await page.familyStore.initializeCheckupTemplates([
      { templateKey: 'std_w8', dateKey: '2026-07-27', examItems: [
        { itemId: 'w8_i0', text: '建档登记', required: true, done: false },
        { itemId: 'w8_i1', text: '血压体重', required: false, done: false }
      ] },
      { templateKey: 'std_w16', dateKey: '2026-09-21', examItems: [
        { itemId: 'w16_i0', text: '中期唐筛/无创DNA', required: true, done: false }
      ] }
    ])
    await page.familyStore.saveCheckup('chk_manual', { dateKey: '2026-08-10', examItems: [] }, undefined, 0)
    await page.familyStore.saveCheckup('chk_tpl_std_w8', {
      hospital: '红房子',
      time: '16:45',
      examItems: [
        { itemId: 'w8_i0', text: '建档登记', required: true, done: true },
        { itemId: 'w8_i1', text: '血压体重', required: false, done: false },
        { itemId: 'itm_x1', text: '骨密度', required: false, done: false }
      ]
    }, undefined, 1)
    // 对端把 w8 日期改歪（模拟旧错数据；source 仍 template，重排对象）
    cloud.__state.store.get('mc_checkups/chk_tpl_std_w8').doc.dateKey = '2026-09-15'
    await page.familyStore.saveCheckup('chk_tpl_std_w16', { dateKey: '2026-10-01' }, undefined, 1)
    await page.familyStore.pullCheckups()
    await page.regenerateSchedule()
    await tick()
    const w8 = cloud.__snapshot('mc_checkups', 'chk_tpl_std_w8')
    assert.equal(w8.dateKey, '2026-07-27', '纠回按当前 LMP 计算的标准日期')
    assert.equal(w8.hospital, '红房子', '医院等补充信息保留')
    assert.equal(w8.time, '16:45', '时间保留')
    assert.equal(w8.examItems.length, 7, '检查项重置为完整标准清单')
    assert.ok(w8.examItems.every(i => !i.done), '已勾选项清空')
    assert.ok(!w8.examItems.find(i => i.itemId === 'itm_x1'), '自定义检查项移除')
    assert.equal(w8.source, 'manual-date', '重排改期即转手动改期（退出后续日期迁移，不二次偏移）')
    const w16 = cloud.__snapshot('mc_checkups', 'chk_tpl_std_w16')
    assert.equal(w16.dateKey, '2026-10-01', '手动改期记录不动')
    assert.equal(w16.source, 'manual-date')
    assert.equal(w16.examItems.length, 1, '手动改期记录检查项不动')
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_manual').dateKey, '2026-08-10', '自建产检不动')
    const ids = [...cloud.__state.store.keys()].filter(k => k.startsWith('mc_checkups/'))
    assert.equal(ids.length, 15, `14 条标准模板 + 1 条自建（实得 ${ids.length}）`)
    assert.equal(page.getOutbox().filter(e => e.conflict).length, 0, '无冲突')
  })

  await scenario('产检页10：重新生成——对端并发推进 revision → 旧基线冲突入横幅，不覆盖云端', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    const { page, confirm } = bundleCheckupPage(cloud)
    await confirm()
    await page.familyStore.savePregnancy({ lmpDate: '2026-06-01' })
    await page.familyStore.initializeCheckupTemplates([
      { templateKey: 'std_w8', dateKey: '2026-07-27', examItems: [
        { itemId: 'w8_i0', text: '建档登记', required: true, done: false }
      ] }
    ])
    await page.familyStore.pullCheckups()
    // 对端推进 revision（本地未拉取）——重新生成以本地旧基线提交必冲突
    await scheduleHandler.main({ action: 'checkup.upsert', schemaVersion: 1, operationId: 'peer-regen', expectedRevision: 1, id: 'chk_tpl_std_w8', payload: { hospital: '对方医院' } })
    await page.regenerateSchedule()
    await tick()
    const w8 = cloud.__snapshot('mc_checkups', 'chk_tpl_std_w8')
    assert.equal(w8.hospital, '对方医院', '云端未被旧基线覆盖')
    assert.equal(w8.examItems.length, 1, '云端检查项未被重置')
    const ce = page.getOutbox().find(e => e.conflict && e.entityId === 'checkup:chk_tpl_std_w8')
    assert.ok(ce, '冲突进入冲突区（同步横幅可见）')
    assert.equal(page.chkConflictList.value.length, 1, '页面冲突卡显示 1 项')
    await page.familyStore.adoptCloud(ce.id)
    assert.equal(page.getOutbox().length, 0, '采用云端后冲突清空')
  })

  await scenario('产检页11：日期迁移完成后重新生成——不二次偏移、一致项跳过不抬高 revision', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    const { page, confirm } = bundleCheckupPage(cloud)
    await confirm()
    await page.familyStore.savePregnancy({ lmpDate: '2026-06-01' })
    await page.generateSchedule()
    await tick()
    await page.familyStore.savePregnancy({ lmpDate: '2026-06-08' })
    await page.openMigrationPreview()
    assert.ok(page.migrationPreview.value && page.migrationPreview.value.toUpdate.length > 0, '迁移预览有待调整项')
    await page.confirmMigration()
    const before = cloud.__snapshot('mc_checkups', 'chk_tpl_std_w24')
    assert.equal(before.dateKey, '2026-11-23', '迁移后日期 = 新 LMP + 24 周')
    assert.equal(page.migrationInfo.value, null, '迁移完成后基线推进、提示消除')
    await page.regenerateSchedule()
    await tick()
    const after = cloud.__snapshot('mc_checkups', 'chk_tpl_std_w24')
    assert.equal(after.dateKey, before.dateKey, '重新生成不二次偏移')
    assert.equal(after.revision, before.revision, '与标准一致的记录跳过（不空转抬高 revision）')
    assert.equal(after.source, 'template', '未改日期不转 manual-date（保留后续迁移资格）')
    assert.equal(page.getOutbox().length, 0, '无待办遗留')
  })

  await scenario('产检页12：重新生成——已完成/跳过与已删模板墓碑一律不动（不复活、不重排）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    const { page, confirm } = bundleCheckupPage(cloud)
    await confirm()
    await page.familyStore.savePregnancy({ lmpDate: '2026-06-01' })
    await page.familyStore.initializeCheckupTemplates([
      { templateKey: 'std_w8', dateKey: '2026-07-27', examItems: [
        { itemId: 'w8_i0', text: '建档登记', required: true, done: false }
      ] },
      { templateKey: 'std_w12', dateKey: '2026-08-24', examItems: [
        { itemId: 'w12_i0', text: 'NT检查', required: true, done: false }
      ] },
      { templateKey: 'std_w16', dateKey: '2026-09-21', examItems: [
        { itemId: 'w16_i0', text: '中期唐筛/无创DNA', required: true, done: false }
      ] }
    ])
    await page.familyStore.pullCheckups()
    // w8 完成（历史）、w12 跳过、w16 删除（墓碑）
    await page.familyStore.markCheckupStatus('chk_tpl_std_w8', 'completed')
    await page.familyStore.markCheckupStatus('chk_tpl_std_w12', 'skipped')
    await page.familyStore.deleteCheckup('chk_tpl_std_w16')
    await tick()
    const w8Before = cloud.__snapshot('mc_checkups', 'chk_tpl_std_w8')
    const w12Before = cloud.__snapshot('mc_checkups', 'chk_tpl_std_w12')
    await page.familyStore.pullCheckups()
    await page.regenerateSchedule()
    await tick()
    const w8 = cloud.__snapshot('mc_checkups', 'chk_tpl_std_w8')
    assert.equal(w8.status, 'completed', '已完成记录不动')
    assert.equal(w8.dateKey, w8Before.dateKey, '已完成不重排日期')
    assert.equal(w8.revision, w8Before.revision, '已完成不抬高 revision')
    assert.equal(w8.examItems.length, 1, '已完成检查项不重置')
    const w12 = cloud.__snapshot('mc_checkups', 'chk_tpl_std_w12')
    assert.equal(w12.status, 'skipped', '已跳过记录不动')
    assert.equal(w12.revision, w12Before.revision, '已跳过不抬高 revision')
    const w16 = cloud.__snapshot('mc_checkups', 'chk_tpl_std_w16')
    assert.equal(w16.deleted, true, '已删模板墓碑保持（不复活）')
    // 标准 14 周各一条文档：3 条既有（含墓碑）+ 11 条补建；w16 不重建
    const ids = [...cloud.__state.store.keys()].filter(k => k.startsWith('mc_checkups/'))
    assert.equal(ids.length, 14, `标准 14 周各一条文档（实得 ${ids.length}）`)
    assert.equal(page.getOutbox().filter(e => e.conflict).length, 0, '无冲突')
  })

  await scenario('产检页13：重新生成——日期已对仅检查项漂移：重置检查项、不转 manual-date（保留迁移资格）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    const { page, confirm } = bundleCheckupPage(cloud)
    await confirm()
    await page.familyStore.savePregnancy({ lmpDate: '2026-06-01' })
    await page.familyStore.initializeCheckupTemplates([
      { templateKey: 'std_w8', dateKey: '2026-07-27', examItems: [
        { itemId: 'w8_i0', text: '建档登记', required: true, done: false },
        { itemId: 'w8_i1', text: '血压体重', required: false, done: false }
      ] }
    ])
    await page.familyStore.pullCheckups()
    // 日期不动，仅勾掉一项 → 项漂移
    await page.familyStore.toggleCheckupItem('chk_tpl_std_w8', 'w8_i0')
    await tick()
    await page.familyStore.pullCheckups()
    await page.regenerateSchedule()
    await tick()
    const w8 = cloud.__snapshot('mc_checkups', 'chk_tpl_std_w8')
    assert.equal(w8.dateKey, '2026-07-27', '日期本就正确，保持不变')
    assert.equal(w8.examItems.length, 7, '检查项补齐/重置为标准清单')
    assert.ok(w8.examItems.every(i => !i.done), '勾选清空')
    assert.equal(w8.source, 'template', '日期未变不转 manual-date')
    // 项重置不丧失日期迁移资格：改 LMP 后预览仍包含该记录
    await page.familyStore.savePregnancy({ lmpDate: '2026-06-08' })
    await page.openMigrationPreview()
    const pv = page.migrationPreview.value
    assert.ok(pv && pv.toUpdate.some(t => t.id === 'chk_tpl_std_w8'), '项重置记录仍可参与日期迁移')
  })

  await scenario('产检页14：重新生成——未设孕期日期拒绝不改数据；断网补建入持久待办联网续传', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    const controls = { offline: false }
    const { page, confirm } = bundleCheckupPage(cloud, controls)
    await confirm()
    // 未设 LMP：拒绝并提示，不产生任何模板写入
    await page.familyStore.saveCheckup('chk_m', { dateKey: '2026-08-10', examItems: [] }, undefined, 0)
    await page.familyStore.pullCheckups()
    const toastsBefore = uniCalls.toasts.length
    await page.regenerateSchedule()
    await tick()
    assert.ok(uniCalls.toasts.slice(toastsBefore).some(t => /末次月经/.test(t)), '提示先设置末次月经日期')
    assert.equal([...cloud.__state.store.keys()].filter(k => k.startsWith('mc_checkups/chk_tpl_')).length, 0, '未设 LMP 不写模板')
    assert.equal(page.getOutbox().length, 0, '无待办遗留')
    // 设 LMP 后断网重新生成：14 条补建全部入持久待办，联网一键补齐
    await page.familyStore.savePregnancy({ lmpDate: '2026-06-01' })
    controls.offline = true
    const toastsBefore2 = uniCalls.toasts.length
    await page.regenerateSchedule()
    await tick()
    const queued = page.getOutbox().filter(e => e.kind === 'checkup-init')
    assert.equal(queued.length, 14, '断网时 14 条补建进入持久待办')
    assert.ok(uniCalls.toasts.slice(toastsBefore2).some(t => /待同步/.test(t)), '如实提示部分未完成（不误报"已是最新"）')
    controls.offline = false
    await page.retrySync()
    const ids = [...cloud.__state.store.keys()].filter(k => k.startsWith('mc_checkups/chk_tpl_'))
    assert.equal(ids.length, 14, '联网重试后补齐全部标准模板')
    assert.equal(cloud.__snapshot('mc_checkups', 'chk_tpl_std_w8').status, 'pending')
    assert.equal(page.getOutbox().length, 0, '无待办遗留')
    // retrySync 尾部有未 await 的 pullCheckups：让其在途落盘结算完再结束场景，
    // 否则写回快照会落在下一场景 freshDisk 之后（跨场景状态复活）
    await tick()
  })

  await scenario('显示3：负时区日期显示不回退一天（UTC/洛杉矶/上海三时区一致）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    const { page, confirm } = bundleCheckupPage(cloud)
    await confirm()
    await page.familyStore.saveCheckup('chk_tz', { dateKey: '2026-09-22', time: '16:45', examItems: [] }, undefined, 0)
    await page.familyStore.pullCheckups()
    const origTz = process.env.TZ
    try {
      for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Shanghai']) {
        process.env.TZ = tz
        await page.familyStore.pullCheckups() // 重新求值（computed 缓存按响应式依赖失效）
        assert.ok(page.infoDate.value.includes('9月22日'), `TZ=${tz} infoDate 不回退（实得 ${page.infoDate.value}）`)
        assert.ok(page.infoDate.value.includes('16:45'), `TZ=${tz} 真实时间`)
        assert.ok(!page.infoDate.value.includes('9月21日'), `TZ=${tz} 不显示前一天`)
        assert.equal(page.heroDate.value, '9月22日', `TZ=${tz} heroDate`)
        assert.ok(page.formatHistoryDate('2026-09-22').includes('9月22日'), `TZ=${tz} formatHistoryDate`)
      }
    } finally {
      if (origTz === undefined) delete process.env.TZ
      else process.env.TZ = origTz
    }
  })

  // ══ 我的摘要 2 组 + 审计 ══
  await scenario('摘要1：我的-下次产检/待产包卡 family 同源；正式模式零读旧 bag 键', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    // 预置旧键字节（B3 前不迁移；正式路径不得读取）
    storage.set('hospital_bag_items', JSON.stringify([{ text: '旧键残留', done: true }]))
    const page = bundlePage('pages/profile/index.vue', withPinia,
      `export {dataSource,hospitalBagSubtitle,todoItems,nextCheckupCard,familyStore};`)
    await confirmPageBundle(page, cloud)
    await scheduleHandler.main({ action: 'checkup.upsert', schemaVersion: 1, operationId: 'sm1a', expectedRevision: 0, id: 'chk_sum', payload: { dateKey: '2099-01-01', examItems: [] } })
    await scheduleHandler.main({ action: 'bag.upsert', schemaVersion: 1, operationId: 'sm1b', expectedRevision: 0, id: 'bag_s1', payload: { name: 'a', category: 'mom', quantity: 1, prepared: true } })
    await scheduleHandler.main({ action: 'bag.upsert', schemaVersion: 1, operationId: 'sm1c', expectedRevision: 0, id: 'bag_s2', payload: { name: 'b', category: 'mom', quantity: 1, prepared: false } })
    await page.familyStore.pullCheckups()
    await page.familyStore.pullBagItems()
    assert.equal(page.dataSource.value, 'family')
    assert.equal(page.hospitalBagSubtitle.value, '已完成 1 / 2 项', '待产包卡读权威统计')
    assert.ok(page.nextCheckupCard.value.subtitle.includes('1月'), `下次产检卡同源（实得 ${page.nextCheckupCard.value.subtitle}）`)
    assert.ok(page.nextCheckupCard.value.badge.endsWith('天后'))
    // 审计：整个 family 流程没有读取旧键
    const legacyReads = storageReads.filter(k => k === 'hospital_bag_items')
    assert.equal(legacyReads.length, 0, '正式路径零读 hospital_bag_items')
    assert.equal(storage.get('hospital_bag_items'), JSON.stringify([{ text: '旧键残留', done: true }]), '旧键原始字节不变')
  })

  await scenario('摘要2：我的-孕期信息四项/Hero/倒计时 family 同源（修复"永远未设置"）', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    const page = bundlePage('pages/profile/index.vue', withPinia,
      `export {dataSource,pregInfoItems,heroUserInfo,viewLmpDate,viewDueDate,viewWeekInfo,viewDaysUntilDue,viewTotalPregDays,viewProgressPercent,viewPregInfoSet,familyStore};`)
    await confirmPageBundle(page, cloud)
    // 云端权威档案（对端已保存的家庭单例）
    await healthHandler.main({ action: 'pregnancy.upsert', schemaVersion: 1, operationId: 'sm2a', expectedRevision: 0, payload: { lmpDate: '2026-01-05', dueDate: '2099-01-01', hospital: '市一医院', babyNickname: '小汤圆', nickname: '宝妈小美' } })
    await page.familyStore.pullPregnancy()
    await tick()
    assert.equal(page.dataSource.value, 'family')
    const items = page.pregInfoItems.value
    assert.equal(items[0].subtitle, '2026年1月5日', '末次月经=云端档案')
    assert.equal(items[1].subtitle, '2099年1月1日（可由医生修正）', '预产期=云端档案')
    assert.equal(items[2].subtitle, '市一医院', '就诊医院=云端档案')
    assert.equal(items[3].subtitle, '小汤圆', '宝宝昵称=云端档案')
    assert.equal(page.viewPregInfoSet.value, true)
    assert.ok(page.viewDueDate.value instanceof Date, '倒计时环 dueDate 为 Date')
    assert.ok(page.viewDaysUntilDue.value > 0, '2099 预产期倒计时为正')
    const w = page.viewWeekInfo.value
    assert.ok(w && w.total > 0, 'lmp 已过 → 孕天数为正')
    assert.equal(w.week, Math.floor(w.total / 7), '周=⌊total/7⌋')
    assert.equal(w.day, w.total % 7, '天=total mod 7')
    assert.equal(page.viewTotalPregDays.value, w.total)
    assert.equal(page.viewProgressPercent.value, Math.min(100, Math.round((w.total / 280) * 1000) / 10))
    assert.equal(page.heroUserInfo.value.nickname, '妈妈', 'Hero 昵称=当前身份显示名（非共享档案的宝妈昵称）')
    assert.notEqual(page.heroUserInfo.value.nickname, '宝妈小美')
  })

  await scenario('摘要3（回归）：未确认路径四项仍读旧 store，不读 family 源', async () => {
    freshDisk(); clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    scheduleHandler.__setCloud(cloud); healthHandler.__setCloud(cloud)
    const page = bundlePage('pages/profile/index.vue', withPinia,
      `export {dataSource,pregInfoItems,heroUserInfo,viewPregInfoSet,viewDaysUntilDue,viewWeekInfo,familyStore};`)
    await tick() // 不确认身份：dataSource 停留 prompt，family 源不激活
    assert.equal(page.dataSource.value, 'prompt')
    for (const it of page.pregInfoItems.value) {
      assert.equal(it.subtitle, '未设置', `${it.title} 未确认时显示未设置`)
    }
    assert.equal(page.viewPregInfoSet.value, false)
    assert.equal(page.viewDaysUntilDue.value, 0)
    assert.equal(page.viewWeekInfo.value, null)
    assert.equal(page.heroUserInfo.value.nickname, '', 'Hero 昵称沿用旧 store 空值（组件内兜底）')
  })

  await scenario('审计：零旧 HTTP（全部流量走云函数路由模拟）', async () => {
    assert.equal(uniCalls.requests, 0, '不得出现 uni.request')
    assert.equal(uniCalls.uploadFile, 0, '不得出现 uni.uploadFile')
  })

  console.log(`\n结果：${passed} 通过，${failed.length} 失败`)
  if (failed.length) {
    console.log('失败项：\n - ' + failed.join('\n - '))
    process.exit(1)
  }
  process.exit(0)
}

main().catch(e => { console.error('套件异常：', e); process.exit(1) })
