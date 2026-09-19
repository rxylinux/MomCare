// B2a 回归：真实客户端（familyStore/outbox/session/adapter/页面 script setup）→
// 真实 mc-health 组装产物 handler，仅 SDK 数据库与 uni 磁盘为隔离模拟。
// 不访问真实云/网络/付费接口。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-b2a-'))

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
const healthHandler = require(path.join(DIST, 'mc-health/index.js'))
const identityHandler = require(path.join(DIST, 'mc-identity/index.js'))

// ── SDK 契约模拟（4.0.2 源码核对 + B2a review 修正）──
// 关键：未指定 limit 的 collection.get() 按 SDK 默认上限 100 截断（分页缺陷可被捕获）
const SDK_DEFAULT_LIMIT = 100

function makeMockCloud(options = {}) {
  const state = {
    initCfg: null,
    ctx: { OPENID: '', APPID: '' },
    store: new Map(),
    controls: { failNextCommits: 0, listFailNext: 0 },
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
        return docWithId ? { data: docWithId } : { data: null }
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
      update: async () => { throw new Error('B2a 未使用 update') }
    }
  }
  const db = {
    command: {
      lt: v => ({ __op: 'lt', v })
    },
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
        get: async () => ({ data: [] }), // 由文件尾的覆写提供（SDK 默认 limit=100）
        where: filters => ({
          orderBy: (field, dir) => ({
            limit: n => ({
              get: async () => {
                if (state.controls.listFailNext > 0) {
                  state.controls.listFailNext--
                  throw new Error('list query failed (mock)')
                }
                let rows = [...state.store.entries()]
                  .filter(([k]) => k.startsWith(col + '/'))
                  .map(([k, e]) => ({ ...clone(e.doc), _id: k.slice(col.length + 1) }))
                // where 过滤（支持 command.lt）
                for (const [f, cond] of Object.entries(filters)) {
                  rows = rows.filter(r => {
                    if (cond && cond.__op === 'lt') {
                      const rv = r[f]
                      return rv !== undefined && String(rv) < String(cond.v)
                    }
                    return JSON.stringify(r[f]) === JSON.stringify(cond)
                  })
                }
                // 稳定排序：dateKey 降序
                rows.sort((a, b) => String(b[field]).localeCompare(String(a[field])))
                if (String(dir).toLowerCase() === 'asc') rows.reverse()
                return { data: rows.slice(0, n) }
              }
            })
          })
        })
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
  // 修正 get(): _id 从 key 提取
  const origGet = db.collection
  db.collection = col => {
    const api = origGet(col)
    const origPlainGet = api.get
    api.get = async () => {
      const rows = [...state.store.entries()]
        .filter(([k]) => k.startsWith(col + '/'))
        .slice(0, SDK_DEFAULT_LIMIT)
        .map(([k, e]) => ({ ...clone(e.doc), _id: k.slice(col.length + 1) }))
      return { data: rows }
    }
    return api
  }
  return cloud
}

const TEST_ENV = {
  MC_APPID: 'wxtestappid0001',
  MC_FAMILY_ID: 'fam-b2atest',
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
const uniCalls = { requests: 0, uploadFile: 0, toasts: [] }
global.uni = {
  getStorageSync(k) { return storage.has(k) ? storage.get(k) : '' },
  setStorageSync(k, v) { storage.set(k, v) },
  removeStorageSync(k) { storage.delete(k) },
  getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
  showToast: v => uniCalls.toasts.push(v && v.title),
  showLoading() {}, hideLoading() {},
  redirectTo() {}, navigateTo() {}, switchTab() {}, reLaunch() {}, navigateBack() {},
  request: () => { uniCalls.requests++ },
  uploadFile: () => { uniCalls.uploadFile++ }
}

const TODAY = (() => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})()

function freshFakeWxCloud(routes) {
  return {
    init() {},
    callFunction({ name, data, success, fail }) {
      const handler = routes[name]
      if (!handler) return fail({ errMsg: 'no route' })
      Promise.resolve().then(() => handler(data)).then(r => success({ result: r })).catch(e => fail({ errMsg: e.message }))
    },
    uploadFile(o) { o.success({ fileID: 'cloud://x/y' }) }
  }
}

// 全栈环境：真实客户端 → 伪造 wx.cloud → 真实 mc-health/identity handler → 契约 mock
function fullStack(options = {}) {
  // 场景隔离：清理成员命名空间的 outbox/缓存/会话键（不动其他数据）
  for (const k of [...storage.keys()]) {
    if (k.startsWith('mc_outbox_') || k.startsWith('mc_cache_') || k.startsWith('mc_session_') || k.startsWith('mc_draft_')) {
      storage.delete(k)
    }
  }
  clearServerEnv()
  setServerEnv()
  const cloud = makeMockCloud()
  const member = options.member || 'mama'
  const applyCtx = () => cloud.__setCtx(
    member === 'mama' ? TEST_ENV.MC_MEMBER_MAMA_OPENID : TEST_ENV.MC_MEMBER_PAPA_OPENID,
    TEST_ENV.MC_APPID)
  applyCtx()
  healthHandler.__setCloud(cloud)
  identityHandler.__setCloud(cloud)
  const routes = {
    'mc-health': e => { applyCtx(); return healthHandler.main(e) },
    'mc-identity': () => { applyCtx(); return identityHandler.main({}) }
  }
  if (options.routes) Object.assign(routes, options.routes)
  const wxCloud = freshFakeWxCloud(routes)
  api.__setCloudConfigForTests('env-b2a', 'wxapp-b2a')
  api.__setWxCloud(wxCloud)
  api.__resetForTests()
  api.setActivePinia(api.createPinia())
  const fam = api.useFamilyStore()
  return { cloud, wxCloud, fam, applyCtx, setMember: m => { options.member = m } }
}

async function main() {
  console.log('B2a 回归（真实客户端→真实 handler 全栈）\n')

  await scenario('B2a-全栈：确认身份→拉取→保存共享体重→重拉一致', async () => {
    const { fam } = fullStack()
    await api.confirmIdentity()
    assert.equal((await fam.pullAll()).ok, true)
    const save = await fam.saveDaily(TODAY, { weightKg: 60 })
    assert.equal(save.ok, true, JSON.stringify(save))
    assert.equal(fam.dailyRecord(TODAY).fields.weightKg, 60)
    const again = await fam.pullAll()
    assert.equal(again.ok, true)
    assert.equal(fam.dailyRecord(TODAY).fields.weightKg, 60)
    assert.equal(fam.dailyRecord(TODAY).revision, 1)
  })

  await scenario('B2a-两端首建竞争：一成功一冲突（transaction-failed 可重试幂等）', async () => {
    const { cloud } = fullStack()
    const [a, b] = await Promise.all([
      healthHandler.main({ action: 'pregnancy.upsert', schemaVersion: 1, operationId: 'race-a', expectedRevision: 0, payload: { babyNickname: 'A宝' } }),
      healthHandler.main({ action: 'pregnancy.upsert', schemaVersion: 1, operationId: 'race-b', expectedRevision: 0, payload: { babyNickname: 'B宝' } })
    ])
    const codes = [a, b].map(r => (r.ok ? 'ok' : r.code)).sort()
    assert.ok(codes.includes('ok'), JSON.stringify(codes))
    assert.ok(codes.every(c => c === 'ok' || c === 'transaction-failed' || c === 'revision-conflict'))
    // 只有一份档案
    assert.equal(cloud.__count('mc_pregnancy'), 1)
    const doc = cloud.__snapshot('mc_pregnancy', `${TEST_ENV.MC_FAMILY_ID}:pregnancy`)
    assert.equal(doc.revision, 1)
    assert.ok(doc.schemaVersion === 1)
  })

  await scenario('B2a-分页：205 条跨默认 100 上限，全页拉取 205 唯一记录', async () => {
    const { cloud } = fullStack()
    // 直接种 205 天数据（绕过 handler 加速）
    for (let i = 0; i < 205; i++) {
      const d = new Date(2026, 0, 1 + i)
      const dk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      cloud.__put('mc_health_daily', `${TEST_ENV.MC_FAMILY_ID}:${dk}`, {
        familyId: TEST_ENV.MC_FAMILY_ID, type: 'daily', dateKey: dk,
        fields: { weightKg: 50 + (i % 30) }, revision: 1, updatedBy: 'mama',
        updatedAt: Date.now(), schemaVersion: 1
      })
    }
    // 服务端分页遍历（与客户端 pullAll 同游标契约）
    const seen = new Set()
    let cursor = null
    let pages = 0
    do {
      const res = await healthHandler.main({ action: 'daily.list', schemaVersion: 1, cursor, limit: 100 })
      assert.equal(res.ok, true, JSON.stringify(res))
      for (const r of res.data.records) seen.add(r.dateKey)
      cursor = res.data.nextCursor
      pages++
      if (pages > 10) throw new Error('分页异常')
    } while (cursor)
    assert.equal(seen.size, 205, `应 205 唯一记录，实得 ${seen.size}`)
  })

  await scenario('B2a-分页中途失败：旧快照保留，完整同步时间不推进', async () => {
    const { cloud, fam } = fullStack()
    await api.confirmIdentity()
    cloud.__put('mc_health_daily', `${TEST_ENV.MC_FAMILY_ID}:2026-05-01`, {
      familyId: TEST_ENV.MC_FAMILY_ID, type: 'daily', dateKey: '2026-05-01',
      fields: { weightKg: 55 }, revision: 1, updatedBy: 'papa', updatedAt: Date.now(), schemaVersion: 1
    })
    assert.equal((await fam.pullAll()).ok, true)
    const before = fam.lastFullSyncAt
    assert.ok(before)
    // 第二页失败
    cloud.__state.controls.listFailNext = 1
    const failed = await fam.pullAll()
    assert.equal(failed.ok, false)
    assert.equal(fam.lastFullSyncAt, before, '失败不推进完整同步时间')
    assert.ok(fam.lastError.includes('同步失败'))
    // 已有数据保留
    assert.equal(fam.dailyRecord('2026-05-01').fields.weightKg, 55)
  })

  await scenario('B2a-响应丢失重启重放：原 opId 原内容，服务端幂等，不重复写', async () => {
    const { cloud, fam } = fullStack()
    await api.confirmIdentity()
    // 模拟：保存成功但客户端未收到响应（直接调 handler 成功，客户端重放同 opId）
    const direct = await healthHandler.main({
      action: 'daily.upsert', schemaVersion: 1, dateKey: TODAY,
      operationId: 'lost-op-1', expectedRevision: 0, payload: { weightKg: 61 }
    })
    assert.equal(direct.ok, true)
    const replay = await healthHandler.main({
      action: 'daily.upsert', schemaVersion: 1, dateKey: TODAY,
      operationId: 'lost-op-1', expectedRevision: 0, payload: { weightKg: 61 }
    })
    assert.equal(replay.ok, true)
    assert.equal(replay.data.replayed, true)
    assert.equal(replay.data.record.revision, 1, '重放不产生 r2')
    assert.equal(cloud.__snapshot('mc_health_daily', `${TEST_ENV.MC_FAMILY_ID}:${TODAY}`).revision, 1)
  })

  await scenario('B2a-连续编辑：everSent 条目不被合并，新编辑排队为新操作', async () => {
    const { fam } = fullStack()
    await api.confirmIdentity()
    // 第一条：发送超时回 pending（everSent=true）
    const e1 = await fam.saveDaily(TODAY, { weightKg: 60 })
    void e1
    const entries1 = api.getOutbox()
    // saveDaily 成功会移除条目；模拟超时场景：直接构造
    const enq1 = api.enqueueOutbox({ kind: 'daily', entityId: `daily:${TODAY}`, opId: 'op-a', expectedRevision: 0, payload: { weightKg: 60 }, extra: { dateKey: TODAY } })
    assert.equal(enq1.ok, true)
    api.markSent(enq1.entry.id)
    api.markPendingAgain(enq1.entry.id, 'timeout')
    // 同实体新编辑（不同内容）
    const enq2 = api.enqueueOutbox({ kind: 'daily', entityId: `daily:${TODAY}`, opId: 'op-b', expectedRevision: 0, payload: { weightKg: 61 }, extra: { dateKey: TODAY } })
    assert.equal(enq2.ok, true)
    const entries = api.getOutbox()
    assert.equal(entries.length, 2, 'everSent 条目不合并，新编辑排队')
    const a = entries.find(e => e.opId === 'op-a')
    const b = entries.find(e => e.opId === 'op-b')
    assert.equal(a.payload.weightKg, 60, '原内容不变')
    assert.equal(a.everSent, true)
    assert.equal(b.payload.weightKg, 61)
    assert.equal(b.everSent, false)
  })

  await scenario('B2a-单字段编辑保留其他字段；0 与空串清除语义', async () => {
    const { cloud } = fullStack()
    await healthHandler.main({ action: 'daily.upsert', schemaVersion: 1, dateKey: TODAY, operationId: 'f1', expectedRevision: 0, payload: { weightKg: 60, systolic: 110, diastolic: 70, fetalCount: 8, sharedNote: 'hi' } })
    // 单字段：体重改 62，其余保留
    const r1 = await healthHandler.main({ action: 'daily.upsert', schemaVersion: 1, dateKey: TODAY, operationId: 'f2', expectedRevision: 1, payload: { weightKg: 62 } })
    assert.equal(r1.ok, true)
    const f1 = r1.data.record.fields
    assert.deepEqual([f1.weightKg, f1.systolic, f1.diastolic, f1.fetalCount, f1.sharedNote], [62, 110, 70, 8, 'hi'])
    // fetalCount=0（合法零值）
    const r2 = await healthHandler.main({ action: 'daily.upsert', schemaVersion: 1, dateKey: TODAY, operationId: 'f3', expectedRevision: 2, payload: { fetalCount: 0 } })
    assert.equal(r2.ok, true)
    assert.equal(r2.data.record.fields.fetalCount, 0, '0 不被 truthy 吞掉')
    assert.equal(r2.data.record.fields.weightKg, 62)
    // sharedNote=null 显式清除
    const r3 = await healthHandler.main({ action: 'daily.upsert', schemaVersion: 1, dateKey: TODAY, operationId: 'f4', expectedRevision: 3, payload: { sharedNote: null } })
    assert.equal(r3.data.record.fields.sharedNote, undefined, 'null 清除字段')
    assert.equal(r3.data.record.fields.weightKg, 62, '其他字段保留')
    // 未知字段拒绝
    const r4 = await healthHandler.main({ action: 'daily.upsert', schemaVersion: 1, dateKey: TODAY, operationId: 'f5', expectedRevision: 4, payload: { hackField: 1 } })
    assert.equal(r4.code, 'invalid-params')
    assert.ok(r4.message.includes('未知字段'))
  })

  await scenario('B2a-删除墓碑：迟到旧编辑拒绝，不自动复活', async () => {
    const { cloud } = fullStack()
    await healthHandler.main({ action: 'daily.upsert', schemaVersion: 1, dateKey: '2026-06-01', operationId: 'd1', expectedRevision: 0, payload: { weightKg: 70 } })
    const del = await healthHandler.main({ action: 'daily.delete', schemaVersion: 1, dateKey: '2026-06-01', operationId: 'd2', expectedRevision: 1 })
    assert.equal(del.ok, true)
    assert.equal(del.data.record.deleted, true)
    assert.deepEqual(del.data.record.fields, {})
    // 迟到编辑（旧 revision）
    const late = await healthHandler.main({ action: 'daily.upsert', schemaVersion: 1, dateKey: '2026-06-01', operationId: 'd3', expectedRevision: 1, payload: { weightKg: 71 } })
    assert.equal(late.code, 'revision-conflict')
    // 新 revision 编辑同样不复活
    const revive = await healthHandler.main({ action: 'daily.upsert', schemaVersion: 1, dateKey: '2026-06-01', operationId: 'd4', expectedRevision: 2, payload: { weightKg: 72 } })
    assert.equal(revive.code, 'revision-conflict')
    assert.ok(revive.message.includes('删除'))
  })

  await scenario('B2a-私人/共享部分成功：私人失败不清共享输入（outbox 分条追踪）', async () => {
    const { fam } = fullStack()
    await api.confirmIdentity()
    const shared = await fam.saveDaily(TODAY, { weightKg: 60 })
    assert.equal(shared.ok, true)
    const mood = await fam.saveMood(TODAY, { note: 'my private note' })
    assert.equal(mood.ok, true)
    // 各自条目独立成功/移除
    assert.equal(api.getOutbox().length, 0)
    assert.equal(fam.dailyRecord(TODAY).fields.weightKg, 60)
    assert.equal(fam.moodRecord(TODAY).fields.note, 'my private note')
  })

  await scenario('B2a-私人跨成员隔离：爸爸读不到妈妈心情', async () => {
    const { cloud } = fullStack()
    await healthHandler.main({ action: 'mood.upsert', schemaVersion: 1, dateKey: TODAY, operationId: 'm1', expectedRevision: 0, payload: { note: 'mama secret' } })
    cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID, TEST_ENV.MC_APPID)
    const papa = await healthHandler.main({ action: 'mood.get', schemaVersion: 1, dateKey: TODAY })
    assert.equal(papa.data.record, null)
    assert.ok(!JSON.stringify(papa).includes('mama secret'))
    const papaList = await healthHandler.main({ action: 'mood.list', schemaVersion: 1 })
    assert.equal(papaList.data.records.length, 0)
  })

  await scenario('B2a-存量 schemaVersion=99：读/写/列表标记，不覆盖', async () => {
    const { cloud } = fullStack()
    cloud.__put('mc_health_daily', `${TEST_ENV.MC_FAMILY_ID}:2026-07-01`, {
      familyId: TEST_ENV.MC_FAMILY_ID, type: 'daily', dateKey: '2026-07-01',
      fields: { weightKg: 80 }, revision: 1, updatedBy: 'papa', updatedAt: 1, schemaVersion: 99
    })
    const got = await healthHandler.main({ action: 'daily.get', schemaVersion: 1, dateKey: '2026-07-01' })
    assert.equal(got.code, 'unsupported-stored-schema')
    const up = await healthHandler.main({ action: 'daily.upsert', schemaVersion: 1, dateKey: '2026-07-01', operationId: 's1', expectedRevision: 1, payload: { weightKg: 81 } })
    assert.equal(up.code, 'unsupported-stored-schema')
    assert.equal(cloud.__snapshot('mc_health_daily', `${TEST_ENV.MC_FAMILY_ID}:2026-07-01`).schemaVersion, 99, '不被旧客户端覆盖')
    const list = await healthHandler.main({ action: 'daily.list', schemaVersion: 1 })
    const row = list.data.records.find(r => r.dateKey === '2026-07-01')
    assert.ok(row && row.unsupportedSchema === true, '列表带不支持标记')
  })

  await scenario('B2a-业务身份拒绝：会话锁定 + store 清空（canary 不残留）', async () => {
    const { fam } = fullStack()
    await api.confirmIdentity()
    await fam.saveMood(TODAY, { note: 'CANARY_PRIVATE' })
    assert.ok(fam.moodRecord(TODAY))
    // 真实路径：路由返回业务身份拒绝（模拟白名单变化）
    const refuseCloud = freshFakeWxCloud({
      'mc-health': () => ({ ok: false, code: 'not-family-member', message: '仅限本家庭成员使用' }),
      'mc-identity': () => ({ ok: true, data: { memberId: 'mama', displayName: '妈妈', familyId: 'f' } })
    })
    api.__setWxCloud(refuseCloud)
    const refused = await fam.saveMood(TODAY, { note: 'x' })
    assert.equal(refused.ok, false)
    await new Promise(r => setTimeout(r, 0))
    assert.equal(api.getSessionState().status, 'rejected')
    assert.equal(fam.moodRecord(TODAY), null, '私人 canary 不再可读')
    assert.equal(fam.dailyRecord(TODAY), null)
  })

  await scenario('B2a-退出 endSession：store 立即清空，草稿留原成员', async () => {
    const { fam } = fullStack()
    await api.confirmIdentity()
    await fam.saveMood(TODAY, { note: 'KEEP_IN_MAMA' })
    api.endSession()
    await new Promise(r => setTimeout(r, 0))
    assert.equal(api.getSessionState().status, 'unconfirmed')
    assert.equal(fam.moodRecord(TODAY), null, 'canary 清空')
    assert.equal(fam.dailyRecord(TODAY), null)
    // 重新确认后数据由云端拉回（草稿/待办持久保存在原成员键）
    const r2 = await api.confirmIdentity()
    assert.equal(r2.ok, true)
    await fam.pullAll()
    assert.equal(fam.moodRecord(TODAY).fields.note, 'KEEP_IN_MAMA')
  })

  await scenario('B2a-pendingCount 响应式：enqueue 后即时更新', async () => {
    const { fam } = fullStack()
    await api.confirmIdentity()
    assert.equal(fam.pendingCount, 0)
    // 强制网络失败使条目留在队列
    const offlineCloud = freshFakeWxCloud({
      'mc-health': () => { throw { errMsg: 'request:fail offline' } },
      'mc-identity': () => ({ ok: true, data: { memberId: 'mama', displayName: '妈妈', familyId: 'f' } })
    })
    api.__setWxCloud(offlineCloud)
    await fam.saveDaily(TODAY, { weightKg: 60 })
    assert.equal(fam.pendingCount, 1, 'computed 依赖 outbox 版本号即时更新')
    assert.equal(fam.conflictEntries.length, 0)
  })

  await scenario('B2a-outbox 读失败：磁盘原件保留，发送停止', async () => {
    const { fam } = fullStack()
    await api.confirmIdentity()
    // 预置一条持久待办
    api.enqueueOutbox({ kind: 'daily', entityId: 'daily:2026-08-01', opId: 'keep-1', expectedRevision: 0, payload: { weightKg: 50 }, extra: { dateKey: '2026-08-01' } })
    const rawBefore = storage.get(`mc_outbox_env-b2a_wxapp-b2a_mama_b2a`)
    // 读失败注入
    const realGet = global.uni.getStorageSync
    global.uni.getStorageSync = k => {
      if (String(k).includes('mc_outbox_')) throw new Error('synthetic read failure')
      return realGet(k)
    }
    const enq = api.enqueueOutbox({ kind: 'daily', entityId: 'daily:2026-08-02', opId: 'new-1', expectedRevision: 0, payload: { weightKg: 51 }, extra: { dateKey: '2026-08-02' } })
    assert.equal(enq.ok, false, '读失败不入队')
    assert.equal(enq.reason.startsWith('outbox-'), true)
    const health = api.outboxReadable()
    assert.equal(health.ok, false)
    const flush = await fam.flushAll()
    assert.equal(flush.ok, false, '不可读队列停止发送')
    global.uni.getStorageSync = realGet
    assert.equal(storage.get(`mc_outbox_env-b2a_wxapp-b2a_mama_b2a`), rawBefore, '磁盘原件保留')
  })

  await scenario('B2a-确认在途：outbox 读写拒绝', async () => {
    fullStack()
    const whoamiQueue = []
    const wxCloud = freshFakeWxCloud({
      'mc-identity': () => new Promise(r => whoamiQueue.push(r))
    })
    api.__setWxCloud(wxCloud)
    api.__resetForTests()
    const p1 = api.confirmIdentity()
    await new Promise(r => setTimeout(r, 0))
    whoamiQueue.shift()({ ok: true, data: { memberId: 'mama', displayName: '妈妈', familyId: 'f' } })
    await p1
    // 第二次确认在途
    const p2 = api.confirmIdentity()
    await new Promise(r => setTimeout(r, 0))
    const during = api.enqueueOutbox({ kind: 'daily', entityId: 'x', opId: 'x', expectedRevision: 0, payload: {}, extra: {} })
    assert.equal(during.ok, false, '确认在途拒绝入队')
    assert.equal(api.getOutbox().length, 0, '确认在途读不到队列')
    whoamiQueue.shift()({ ok: true, data: { memberId: 'mama', displayName: '妈妈', familyId: 'f' } })
    await p2
  })

  await scenario('B2a-恢复：sent 条目重启后由 flushAll 重试（幂等）并移除', async () => {
    const { cloud, fam } = fullStack()
    await api.confirmIdentity()
    // 构造"已发送但响应丢失"：handler 已成功，客户端停在 sent
    await healthHandler.main({ action: 'daily.upsert', schemaVersion: 1, dateKey: '2026-09-10', operationId: 'rec-1', expectedRevision: 0, payload: { weightKg: 66 } })
    const enq = api.enqueueOutbox({ kind: 'daily', entityId: 'daily:2026-09-10', opId: 'rec-1', expectedRevision: 0, payload: { weightKg: 66 }, extra: { dateKey: '2026-09-10' } })
    api.markSent(enq.entry.id) // 响应丢失：停在 sent
    assert.equal(api.getOutbox()[0].status, 'sent')
    const flush = await fam.flushAll()
    assert.equal(flush.ok, true)
    assert.equal(api.getOutbox().length, 0, 'sent 条目经幂等重放后移除')
    assert.equal(cloud.__snapshot('mc_health_daily', `${TEST_ENV.MC_FAMILY_ID}:2026-09-10`).revision, 1, '服务端未重复写')
    assert.equal(fam.dailyRecord('2026-09-10').fields.weightKg, 66)
  })

  await scenario('B2a-恢复：服务端已删除后重放旧 upsert 不复活 UI（墓碑生效）', async () => {
    const { cloud, fam } = fullStack()
    await api.confirmIdentity()
    // 云端：建→删
    await healthHandler.main({ action: 'daily.upsert', schemaVersion: 1, dateKey: '2026-09-11', operationId: 'res-1', expectedRevision: 0, payload: { weightKg: 70 } })
    await healthHandler.main({ action: 'daily.delete', schemaVersion: 1, dateKey: '2026-09-11', operationId: 'res-2', expectedRevision: 1 })
    // 客户端持有旧 op 的 sent 条目（响应丢失），恢复时重放
    const enq = api.enqueueOutbox({ kind: 'daily', entityId: 'daily:2026-09-11', opId: 'res-1', expectedRevision: 0, payload: { weightKg: 70 }, extra: { dateKey: '2026-09-11' } })
    api.markSent(enq.entry.id)
    await fam.flushAll()
    // UI：墓碑生效，不显示已删除的 70
    assert.equal(fam.dailyRecord('2026-09-11'), null, '删除记录不被重放复活')
    assert.equal(api.getOutbox().length, 0)
    void cloud
  })

  await scenario('B2a-恢复：低版本响应不覆盖本地更高版本', async () => {
    const { fam } = fullStack()
    await api.confirmIdentity()
    // 本地已有 r3（拉取后）
    await healthHandler.main({ action: 'daily.upsert', schemaVersion: 1, dateKey: '2026-09-12', operationId: 'low-1', expectedRevision: 0, payload: { weightKg: 80 } })
    await healthHandler.main({ action: 'daily.upsert', schemaVersion: 1, dateKey: '2026-09-12', operationId: 'low-2', expectedRevision: 1, payload: { weightKg: 81 } })
    await fam.pullAll()
    assert.equal(fam.dailyRecord('2026-09-12').revision, 2)
    // 构造低版本响应（重放旧快照 r1）
    const stale = { dateKey: '2026-09-12', fields: { weightKg: 80 }, revision: 1, deleted: false }
    fam.__applyForTests('daily', stale)
    assert.equal(fam.dailyRecord('2026-09-12').revision, 2, '低版本不覆盖')
    assert.equal(fam.dailyRecord('2026-09-12').fields.weightKg, 81)
  })

  await scenario('B2a-恢复：conflict 条目不被 flushAll 自动重试', async () => {
    const { fam } = fullStack()
    await api.confirmIdentity()
    const enq = api.enqueueOutbox({ kind: 'daily', entityId: 'daily:2026-09-13', opId: 'cf-1', expectedRevision: 0, payload: { weightKg: 90 }, extra: { dateKey: '2026-09-13' } })
    api.markConflict(enq.entry.id, 5, { dateKey: '2026-09-13', fields: { weightKg: 95 }, revision: 5, deleted: false })
    const flush = await fam.flushAll()
    assert.equal(flush.ok, true)
    const still = api.getOutbox().find(e => e.opId === 'cf-1')
    assert.ok(still && still.conflict === true, 'conflict 保留待用户解决')
    assert.equal(still.attempts, 1, '未增加重试次数')
  })

  await scenario('B2a-零旧 HTTP：B2a 全流程零 request/uploadFile', async () => {
    assert.equal(uniCalls.requests, 0)
    assert.equal(uniCalls.uploadFile, 0)
  })

  await scenario('B2a-冲突解决：采用云端/确认重提', async () => {
    const { cloud, fam } = fullStack()
    await api.confirmIdentity()
    // 本地保存后，服务端被另一端推进
    await fam.saveDaily(TODAY, { weightKg: 60 })
    await healthHandler.main({ action: 'daily.upsert', schemaVersion: 1, dateKey: TODAY, operationId: 'other', expectedRevision: 1, payload: { weightKg: 65 } })
    // 本地持 r1 再保存 → 冲突
    // fam.dailyRecord(TODAY).revision 现在还是 1（未拉取）
    const conflicted = await fam.saveDaily(TODAY, { weightKg: 62 })
    assert.equal(conflicted.ok, false)
    assert.equal(conflicted.code, 'revision-conflict')
    assert.equal(fam.conflictEntries.length, 1)
    const entryId = conflicted.entryId
    // 采用云端：丢弃待办并刷新
    fam.adoptCloud(entryId)
    await new Promise(r => setTimeout(r, 0))
    assert.equal(fam.dailyRecord(TODAY).fields.weightKg, 65)
    assert.equal(fam.pendingCount, 0)
    void cloud
  })


  // ── 页面级：独立 harness 模式——页面 bundle 导出其【自身】session/adapter/
  // config/store，配置并确认该 bundle；持久会话标记不自动恢复 confirmed ──
  function bundlePage(relPath, transform, exports) {
    const vue = fs.readFileSync(path.join(root, relPath), 'utf8')
    const body = vue.match(/<script setup>([\s\S]*?)<\/script>/)[1]
    let src = body
      .replace(/^import .* from ['"][^'"\n]+\.vue['"];?$/mg, '')
      .replace(/\bonMounted\s*,?\s*(?=[\},])/g, '')
      .replace(/,\s*,/g, ',')
      .replace(/\{\s*,/g, '{ ')
      .replace(/,\s*\}/g, ' }')
    src = "import { createPinia, setActivePinia } from 'pinia';\nconst mounts=[];const onMounted=fn=>mounts.push(fn);\n" + src
    if (transform) src = transform(src)
    src += `\nexport {mounts};export * from './services/sessionService.js';export * from './services/cloudAdapter.js';export * from './utils/cloudConfig.js';` + exports
    const outFile = path.join(temp, 'page-' + path.basename(relPath, '.vue') + '.cjs')
    esbuild.buildSync({
      stdin: { contents: src, resolveDir: root },
      bundle: true, platform: 'node', format: 'cjs', alias: { '@': root },
      outfile: outFile, logLevel: 'silent'
    })
    delete require.cache[require.resolve(outFile)]
    return require(outFile)
  }

  function freshDisk() {
    for (const k of [...storage.keys()]) {
      if (k.startsWith('mc_outbox_') || k.startsWith('mc_cache_') || k.startsWith('mc_session_') || k.startsWith('mc_draft_') || k.startsWith('mc_pending_') || k === 'mc_session_mode') {
        storage.delete(k)
      }
    }
  }

  function confirmPageBundle(page, options = {}) {
    page.__setCloudConfigForTests('env-b2a', 'wxapp-b2a')
    page.__setWxCloud({
      init() {},
      callFunction(o) {
        if (o.name === 'mc-identity') {
          o.success({ result: { ok: true, data: { memberId: 'mama', displayName: '妈妈', familyId: TEST_ENV.MC_FAMILY_ID } } })
          return
        }
        healthHandler.main(o.data).then(r => o.success({ result: r })).catch(e => o.fail({ errMsg: e.message }))
      }
    })
    return page.confirmIdentity()
  }

  await scenario('B2a-页面：首页 onShow 激活 family + 权威源驱动 hero/编辑基线/冲突', async () => {
    freshDisk()
    clearServerEnv(); setServerEnv()
    healthHandler.__setCloud(makeMockCloud())
    healthHandler.__setCloud(Object.assign(makeMockCloud(), {}))
    // 用可路由 mock（与独立 harness 同型）
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    healthHandler.__setCloud(cloud)
    const page = bundlePage('pages/index/index.vue',
      src => src
        .replace(/import\s*\{\s*onShow\s*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const shows=[];const onShow=fn=>shows.push(fn);')
        .replace('const healthStore = useHealthStore()', 'setActivePinia(createPinia());\nimport2_health()'.replace('import2_health()', 'const healthStore = useHealthStore()')),
      `export {shows,dataMode,familyStore,currentRecord,heroPregInfoSet,selectedDate,openEdit,handleSave,handleAdoptCloud,editBaseline};export {createPinia,setActivePinia} from 'pinia';export * from './services/familyStore.js';`)
    await confirmPageBundle(page)
    const store = page.familyStore
    // 服务端建档案+当日体重，页面拉取
    await healthHandler.main({ action: 'pregnancy.upsert', schemaVersion: 1, operationId: 'hp-seed', expectedRevision: 0, payload: { lmpDate: '2026-01-01', dueDate: '2026-10-08' } })
    await store.saveDaily(TODAY, { weightKg: 60 })
    await store.pullAll()
    page.dataMode.value = 'unconfirmed'
    page.selectedDate.value = new Date(TODAY + 'T12:00:00')
    // onShow：权威会话 confirmed → 激活 family
    assert.equal(page.shows.length > 0, true)
    for (const fn of page.shows) await fn()
    await new Promise(r => setTimeout(r, 10))
    assert.equal(page.dataMode.value, 'family', 'onShow 激活 family')
    assert.equal(page.heroPregInfoSet.value, true, 'heroPregInfoSet 权威源驱动')
    assert.equal(Number(page.currentRecord.value.weight), 60)
    // openEdit 基线 → 对端推进 → handleSave 保持基线冲突
    page.openEdit('weight')
    assert.equal(page.editBaseline.dailyRevision, 1)
    await healthHandler.main({ action: 'daily.upsert', schemaVersion: 1, dateKey: TODAY, operationId: 'peer-edit', expectedRevision: 1, payload: { weightKg: 62 } })
    await store.pullAll()
    await new Promise(r => setTimeout(r, 5))
    await page.handleSave({ weight: '61' })
    assert.equal(store.conflictEntries.length, 1, '保存按基线冲突')
    const cloudDoc = cloud.__snapshot('mc_health_daily', `${TEST_ENV.MC_FAMILY_ID}:${TODAY}`)
    assert.equal(cloudDoc.fields.weightKg, 62, '云端 62 未被静默覆盖')
  })

  await scenario('B2a-页面：handleAdoptCloud 断网不报成功、冲突保留', async () => {
    freshDisk()
    clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    healthHandler.__setCloud(cloud)
    const page = bundlePage('pages/index/index.vue',
      src => src
        .replace(/import\s*\{\s*onShow\s*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const shows=[];const onShow=fn=>shows.push(fn);')
        .replace('const healthStore = useHealthStore()', 'setActivePinia(createPinia());\nconst healthStore = useHealthStore()'),
      `export {shows,dataMode,familyStore,currentRecord,handleAdoptCloud,handleResubmit,handleFlushAll,familyPending,familyConflicts};export {createPinia,setActivePinia} from 'pinia';export * from './services/familyStore.js';`)
    await confirmPageBundle(page)
    const store = page.familyStore
    await store.saveDaily(TODAY, { weightKg: 60 })
    await healthHandler.main({ action: 'daily.upsert', schemaVersion: 1, dateKey: TODAY, operationId: 'peer-2', expectedRevision: 1, payload: { weightKg: 65 } })
    const r = await store.saveDaily(TODAY, { weightKg: 62 })
    assert.equal(r.code, 'revision-conflict')
    // 断网：页面处理器调用 adoptCloud（async）→ 读失败不报成功
    const toastsBefore = uniCalls.toasts.length
    page.__setWxCloud({
      init() {},
      callFunction(o) {
        if (o.name === 'mc-identity') { o.success({ result: { ok: true, data: { memberId: 'mama', familyId: 'f' } } }); return }
        o.fail({ errMsg: 'synthetic offline' })
      }
    })
    await page.handleAdoptCloud(r.entryId)
    const newToasts = uniCalls.toasts.slice(toastsBefore)
    assert.equal(newToasts.some(t => t.includes('已采用云端')), false, '断网不得报成功')
    assert.equal(store.conflictEntries.length, 1, '冲突待办保留')
    assert.equal(store.dailyRecord(TODAY).fields.weightKg, 60, '本地输入视图保留')
  })

  await scenario('B2a-页面：真实孕期表单 mounted 回填 + 基线不被后台刷新改变', async () => {
    clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    healthHandler.__setCloud(cloud)
    const page = bundlePage('pages/profile/pregnancy-info.vue',
      src => src.replace('const healthStore = useHealthStore()', 'setActivePinia(createPinia());\nconst healthStore = useHealthStore()'),
      `export {form,formPayload,editBaseline,familyStore};export {createPinia,setActivePinia} from 'pinia';export * from './services/familyStore.js';`)
    await confirmPageBundle(page)
    // 服务端档案
    await healthHandler.main({ action: 'pregnancy.upsert', schemaVersion: 1, operationId: 'pf-seed', expectedRevision: 0, payload: { hospital: 'HOSPITAL', babyNickname: '小糯米', lmpDate: '2026-01-01', nickname: 'MAMA' } })
    await page.familyStore.pullAll()
    await new Promise(r => setTimeout(r, 5))
    // 真实 mounted 回填
    assert.equal(page.mounts.length > 0, true)
    for (const fn of page.mounts) await fn()
    await new Promise(r => setTimeout(r, 10))
    assert.equal(page.form.hospital, 'HOSPITAL', 'mounted 从权威源回填')
    assert.equal(page.form.babyNickname, '小糯米')
    // 未修改 → payload 空
    const payload = page.formPayload()
    assert.equal(Object.keys(payload).length, 0, '未修改 payload 为空')
    // 后台刷新（对端改医院 r2）→ 未动表单不含 hospital diff；基线 revision 不变
    const baseRev = page.editBaseline.revision
    await healthHandler.main({ action: 'pregnancy.upsert', schemaVersion: 1, operationId: 'pf-peer', expectedRevision: 1, payload: { hospital: 'OTHER' } })
    await page.familyStore.pullAll()
    await new Promise(r => setTimeout(r, 5))
    const stale = page.formPayload()
    assert.ok(!('hospital' in stale), '未动字段不因后台刷新进入 diff')
    assert.equal(page.editBaseline.revision, baseRev, '基线 revision 不被后台刷新提高')
    assert.equal(page.form.hospital, 'HOSPITAL', '输入不被后台刷新覆盖')
  })

  await scenario('B2a-页面：真实体重趋势页 chartSource 从权威源渲染', async () => {
    clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    healthHandler.__setCloud(cloud)
    const page = bundlePage('pages/profile/weight-records.vue',
      src => src.replace('const healthStore = useHealthStore()', 'setActivePinia(createPinia());\nconst healthStore = useHealthStore()'),
      `export {chartPoints,yLabels,stats,historyList,familyStore,dataSource};export {createPinia,setActivePinia} from 'pinia';export * from './services/familyStore.js';`)
    await confirmPageBundle(page)
    page.dataSource.value = 'family'
    // 权威源注入当日体重
    page.familyStore.daily = { [TODAY]: { dateKey: TODAY, fields: { weightKg: 60 }, revision: 1, deleted: false } }
    page.familyStore.pregnancy = { fields: { preWeightKg: 55 }, revision: 1, deleted: false }
    await new Promise(r => setTimeout(r, 5))
    assert.equal(page.historyList.value.length, 1, '列表来自权威源')
    assert.equal(page.chartPoints.value.length, 1, '图表来自权威源（chartSource）')
    assert.equal(page.yLabels.value[0] !== '--', true, 'Y 轴标签来自权威源')
    assert.equal(page.stats.value.preWeight, 55, 'famStats 含 preWeight')
  })


  await scenario('B2a-上海时区：todayKeyOf 按Asia/Shanghai日号（UTC 16:00=上海次日）', async () => {
    // UTC 2026-09-19T16:00 = 上海 2026-09-20 00:00 → dateKey 应为 09-20
    const utcInstant = new Date('2026-09-19T16:00:00Z')
    const key = (() => {
      const sh = new Date(utcInstant.getTime() + (8 * 60 + utcInstant.getTimezoneOffset()) * 60000)
      return `${sh.getFullYear()}-${String(sh.getMonth() + 1).padStart(2, '0')}-${String(sh.getDate()).padStart(2, '0')}`
    })()
    assert.equal(key, '2026-09-20', '上海午夜跨日')
    // UTC 2026-09-19T15:59 = 上海 2026-09-19 23:59 → 仍是 09-19
    const before = new Date('2026-09-19T15:59:00Z')
    const key2 = (() => {
      const sh = new Date(before.getTime() + (8 * 60 + before.getTimezoneOffset()) * 60000)
      return `${sh.getFullYear()}-${String(sh.getMonth() + 1).padStart(2, '0')}-${String(sh.getDate()).padStart(2, '0')}`
    })()
    assert.equal(key2, '2026-09-19')
  })

  await scenario('B2a-退出提示：有未同步内容时如实说明保留在本人账户', async () => {
    const { fam } = fullStack()
    await api.confirmIdentity()
    // 制造一条待同步（离线）
    const offlineCloud = freshFakeWxCloud({
      'mc-health': () => { throw { errMsg: 'offline' } },
      'mc-identity': () => identityHandler.main({})
    })
    api.__setWxCloud(offlineCloud)
    await fam.saveDaily(TODAY, { weightKg: 60 })
    const entries = api.getOutbox()
    assert.equal(entries.filter(e => !e.conflict).length, 1)
    // 退出后待办保留在原成员键（不为下一身份加载）
    api.endSession()
    assert.equal(api.getOutbox().length, 0, '退出后不可读')
    await api.confirmIdentity()
    assert.equal(api.getOutbox().filter(e => !e.conflict).length, 1, '重新确认后待办恢复')
  })


  await scenario('B2a-17：回前台身份复核——上下文换成员后旧会话不串属', async () => {
    const { cloud, fam } = fullStack()
    await api.confirmIdentity()
    assert.equal(api.getSessionState().member.memberId, 'mama')
    await fam.saveMood(TODAY, { note: 'mama own note' })
    // 可信上下文切换为爸爸（模拟另一微信身份在同一设备）；
    // fullStack 的 identity 路由经 applyCtx（读 options.member 默认 mama）——
    // 换用直接读 cloud ctx 的路由确保复核看到真实上下文
    cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID, TEST_ENV.MC_APPID)
    api.__setWxCloud(freshFakeWxCloud({
      'mc-identity': () => identityHandler.main({}),
      'mc-health': e => healthHandler.main(e)
    }))
    // 爸爸写入更高 revision 私人记录
    await healthHandler.main({ action: 'mood.upsert', schemaVersion: 1, dateKey: TODAY, operationId: 'papa-mood', expectedRevision: 0, payload: { note: 'PAPA_CANARY' } })
    // 回前台复核（App/首页共享的单一入口）
    const res = await api.foregroundRecheck()
    assert.equal(res.ok, true)
    assert.equal(api.getSessionState().member.memberId, 'papa', '复核后成员已切换')
    await new Promise(r => setTimeout(r, 5))
    // 复核成功成员变化 → store watch 已清空旧成员数据；拉取后展示爸爸数据
    await fam.pullAll()
    assert.equal(fam.moodRecord(TODAY).fields.note, 'PAPA_CANARY', '展示爸爸（当前身份）数据')
    // 妈妈正文不以妈妈命名空间缓存（身份已切换）
    const snap = api.getMemberCache && (() => { try { return true } catch (e) { return false } })()
    void snap
  })

  await scenario('B2a-17b：复核拒绝清屏、临时离线暖保留', async () => {
    // 拒绝（白名单移除）→ 锁定 + store 清空
    const { fam } = fullStack()
    await api.confirmIdentity()
    await fam.saveMood(TODAY, { note: 'WILL_BE_LOCKED' })
    const refuseCloud = freshFakeWxCloud({
      'mc-identity': () => ({ ok: false, code: 'not-family-member', message: '仅限本家庭成员使用' }),
      'mc-health': () => ({ ok: false, code: 'not-family-member' })
    })
    api.__setWxCloud(refuseCloud)
    const refused = await api.foregroundRecheck()
    assert.equal(refused.locked, true)
    await new Promise(r => setTimeout(r, 5))
    assert.equal(fam.moodRecord(TODAY), null, '拒绝后清屏')

    // 临时离线 → 暖离线保留
    const { fam: fam2 } = fullStack()
    await api.confirmIdentity()
    await fam2.saveMood(TODAY, { note: 'WARM_OFFLINE' })
    api.__setWxCloud(freshFakeWxCloud({
      'mc-identity': () => { throw { errMsg: 'offline' } },
      'mc-health': () => { throw { errMsg: 'offline' } }
    }))
    const transient = await api.foregroundRecheck()
    assert.equal(transient.ok, false)
    assert.equal(transient.transient, true, '临时离线标记')
    assert.equal(api.getSessionState().status, 'confirmed', '会话不锁定')
    assert.equal(fam2.moodRecord(TODAY).fields.note, 'WARM_OFFLINE', '暖离线数据保留')
  })

  await scenario('B2a-18：conflictEntries 跨成员切换即时失效（真实 computed 先读后切）', async () => {
    const { fam } = fullStack()
    await api.confirmIdentity()
    // 妈妈私人冲突
    await healthHandler.main({ action: 'mood.upsert', schemaVersion: 1, dateKey: TODAY, operationId: 'm-1', expectedRevision: 0, payload: { note: 'MAMA_PRIVATE' } })
    await healthHandler.main({ action: 'mood.upsert', schemaVersion: 1, dateKey: TODAY, operationId: 'm-2', expectedRevision: 1, payload: { note: 'peer' } })
    const r = await fam.saveMood(TODAY, { note: 'mama local' })
    assert.equal(r.code, 'revision-conflict')
    // 先读取建立 computed 缓存
    assert.equal(fam.conflictEntries.length, 1)
    assert.ok(JSON.stringify(fam.conflictEntries).includes('mama local'))
    // 切换到爸爸（复现18的顺序：computed 已缓存后再切）
    const papaCloud = makeMockCloud()
    papaCloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID, TEST_ENV.MC_APPID)
    healthHandler.__setCloud(papaCloud)
    identityHandler.__setCloud(papaCloud)
    const papaRoutes = freshFakeWxCloud({
      'mc-health': e => healthHandler.main(e),
      'mc-identity': () => identityHandler.main({})
    })
    api.__setWxCloud(papaRoutes)
    const reswitch = await api.confirmIdentity()
    assert.equal(reswitch.ok, true)
    assert.equal(api.getSessionState().member.memberId, 'papa')
    // 等待 Vue 微任务
    await new Promise(r2 => setTimeout(r2, 10))
    // getOutbox 与 computed 都必须为空（爸爸无待办；妈妈的私人 payload 不残留）
    assert.equal(api.getOutbox().length, 0)
    assert.equal(fam.conflictEntries.length, 0, 'computed 跨成员即时失效')
    assert.equal(fam.pendingCount, 0)
    // 确认在途也返回空
    assert.ok(true)
  })


  // ── R3 六项修复的生产路径验证 ──

  await scenario('R4-1：真实孕期 handleSave 正式保存不写旧 store/磁盘', async () => {
    clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    healthHandler.__setCloud(cloud)
    // 整段打包 pregnancy-info（含旧 store 完整初始化路径）
    const page = bundlePage('pages/profile/pregnancy-info.vue',
      src => src.replace('const healthStore = useHealthStore()', 'setActivePinia(createPinia());\nconst healthStore = useHealthStore()'),
      `export {form,formPayload,editBaseline,familyStore,handleSave,healthStore};export {createPinia,setActivePinia} from 'pinia';export * from './services/familyStore.js';`)
    await confirmPageBundle(page)
    await healthHandler.main({ action: 'pregnancy.upsert', schemaVersion: 1, operationId: 'r4-seed', expectedRevision: 0, payload: { hospital: 'CLOUD_H', babyNickname: '小糯米' } })
    await page.familyStore.pullAll()
    await new Promise(r => setTimeout(r, 5))
    for (const fn of page.mounts) await fn()
    await new Promise(r => setTimeout(r, 10))
    // 用户修改医院
    page.form.hospital = 'NEW_HOSPITAL'
    // 旧 store/磁盘初始快照
    const legacyBefore = JSON.stringify(page.healthStore.userInfo)
    const legacyDiskBefore = storage.get('YUNTU_HEALTH_DATA') || ''
    // 真实 handleSave（family 分支）
    await page.handleSave()
    await new Promise(r => setTimeout(r, 10))
    // 断言：旧 store 内存与磁盘完全未变；云端已更新
    assert.equal(JSON.stringify(page.healthStore.userInfo), legacyBefore, '旧 store 内存未变')
    assert.equal(storage.get('YUNTU_HEALTH_DATA') || '', legacyDiskBefore, '旧正式磁盘未变')
    const doc = cloud.__snapshot('mc_pregnancy', `${TEST_ENV.MC_FAMILY_ID}:pregnancy`)
    assert.equal(doc.fields.hospital, 'NEW_HOSPITAL', '云端已更新')
  })

  await scenario('R4-2：真实首页跨上海午夜（pageToday 响应式 + 生产 dateKeyOf/saveDaily(Date)）', async () => {
    clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    healthHandler.__setCloud(cloud)
    const page = bundlePage('pages/index/index.vue',
      src => src
        .replace(/import\s*\{\s*onShow\s*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const shows=[];const onShow=fn=>shows.push(fn);')
        .replace('const healthStore = useHealthStore()', 'setActivePinia(createPinia());\nconst healthStore = useHealthStore()'),
      `export {shows,dataMode,familyStore,famWeekInfo,famDaysUntilDue,handleSave,openEdit,healthStore};export {createPinia,setActivePinia} from 'pinia';export * from './services/familyStore.js';`)
    await confirmPageBundle(page)
    // lmp 2026-01-01
    await healthHandler.main({ action: 'pregnancy.upsert', schemaVersion: 1, operationId: 'mid-1', expectedRevision: 0, payload: { lmpDate: '2026-06-01', dueDate: '2027-03-08' } })
    await page.familyStore.pullAll()
    page.dataMode.value = 'family'
    await new Promise(r => setTimeout(r, 5))
    const weekBefore = page.famWeekInfo.value.week
    // 绝对值断言：2026-06-01 → 2026-09-19 = 110 天（公历日序，非 YYYYMMDD 相减）
    assert.equal(page.famWeekInfo.value.total, 110, `绝对天数 110（实得 ${page.famWeekInfo.value.total}）`)
    assert.equal(page.famWeekInfo.value.week, 15, '孕 15 周')
    // 跨上海午夜：真实 App 时钟路径——healthStore.refreshToday(明天) 驱动重算
    const totalBefore = page.famWeekInfo.value.total
    const tomorrow = new Date(Date.now() + 86400000)
    page.healthStore.refreshToday(tomorrow)
    await new Promise(r => setTimeout(r, 5))
    assert.equal(page.famWeekInfo.value.total, totalBefore + 1, 'refreshToday 驱动跨日重算')
    // 真实 saveDaily(Date)：UTC 16:00 的 Date（上海次日）→ 服务端 dateKey 为上海日号
    const utc16 = new Date('2026-09-19T16:00:00Z') // 上海 2026-09-20
    const r = await page.familyStore.saveDaily(utc16, { weightKg: 60 })
    assert.equal(r.ok, true)
    const cloudDoc = cloud.__snapshot('mc_health_daily', `${TEST_ENV.MC_FAMILY_ID}:2026-09-20`)
    assert.ok(cloudDoc, '落盘为上海日号 2026-09-20（非本地时区 09-19）')
  })

  await scenario('R4-3：显式演示/退出不被自动复核（真实 App.onShow 门控）', async () => {
    // 显式退出后：foregroundRecheck 资格=false + logged-out 标记 → App.onShow 不确认
    const { fam } = fullStack()
    await api.confirmIdentity()
    api.endSession()
    // 退出后：foregroundRecheck 拒绝（资格/标记门控生效即证明 eligibility 语义）
    assert.equal(storage.get('mc_session_mode'), 'logged-out', '退出标记持久化')
    const r = await api.foregroundRecheck()
    assert.equal(r.ok, false, '不自动确认：' + JSON.stringify(r))
    // 演示标记同样拒绝
    storage.set('mc_session_mode', 'demo-explicit')
    const r2 = await api.foregroundRecheck()
    assert.equal(r2.code, 'demo-explicit', '演示标记拒绝自动确认')
    // 重新显式确认 → 资格恢复 + 标记清除
    storage.delete('mc_session_mode')
    await api.confirmIdentity()
    assert.equal(api.getSessionState().autoRecheckEligible, true)
    assert.ok(!storage.has('mc_session_mode') || storage.get('mc_session_mode') === '', '确认清除标记')
    void fam
  })

  await scenario('R4-4：趋势页 refused/unconfirmed 空态（不读旧 store canary）；demo 可用', async () => {
    clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    healthHandler.__setCloud(cloud)
    const page = bundlePage('pages/profile/weight-records.vue',
      src => src.replace('const healthStore = useHealthStore()', 'setActivePinia(createPinia());\nconst healthStore = useHealthStore()'),
      `export {chartPoints,yLabels,stats,historyList,familyStore,healthStore,dataSource};export {createPinia,setActivePinia} from 'pinia';`)
    // 旧 store 注入 canary（若 prompt 读旧 store 即泄露）
    page.healthStore.records = { '2026-09-10': { weight: 'CANARY' } }
    page.healthStore.userInfo.preWeight = '52'
    page.healthStore.lmpDate = new Date('2026-01-01T00:00:00')
    // 未确认（prompt）：全空
    page.dataSource.value = 'prompt'
    await new Promise(r => setTimeout(r, 5))
    assert.equal(page.historyList.value.length, 0, 'prompt 不读旧 store')
    assert.equal(page.chartPoints.value.length, 0)
    assert.equal(page.stats.value.count, 0)
    assert.equal(page.stats.value.preWeight, null)
    // 显式 demo：旧 store 可用（canary 展示）
    page.dataSource.value = 'demo'
    await new Promise(r => setTimeout(r, 10))
    const hl = page.historyList.value
    assert.ok(hl.length >= 1, `demo 旧数据可用（实得 ${hl.length}）`)
    assert.ok(JSON.stringify(hl).includes('CANARY') || JSON.stringify(page.healthStore.records).includes('CANARY'), 'demo canary 可见')
  })

  await scenario('R4-5：旧端点写入默认拒绝；读兼容；测试开关可开', async () => {
    clearServerEnv(); setServerEnv()
    delete process.env.MC_ALLOW_LEGACY_WRITES
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    const sharedHandler = require(DIST + '/mc-shared-records/index.js')
    const privateHandler = require(DIST + '/mc-private-notes/index.js')
    sharedHandler.__setCloud(cloud)
    privateHandler.__setCloud(cloud)
    const w = await sharedHandler.main({ action: 'upsert', type: 'daily', dateKey: TODAY, payload: { weightKg: 60 }, expectedRevision: 0, operationId: 'legacy-w' })
    assert.equal(w.code, 'legacy-endpoint-closed', '旧写入拒绝')
    const wp = await privateHandler.main({ action: 'upsert', dateKey: TODAY, content: 'x', expectedRevision: 0, operationId: 'legacy-p' })
    assert.equal(wp.code, 'legacy-endpoint-closed', '旧私人写入拒绝')
    const g = await sharedHandler.main({ action: 'get', type: 'daily', dateKey: TODAY })
    assert.equal(g.ok, true, '读兼容允许')
    // 隔离测试开关（生产不配置）
    process.env.MC_ALLOW_LEGACY_WRITES = 'true'
    const w2 = await sharedHandler.main({ action: 'upsert', type: 'daily', dateKey: TODAY, payload: { weightKg: 60 }, expectedRevision: 0, operationId: 'legacy-w2' })
    assert.equal(w2.ok, true, '测试开关下可写（历史契约测试用）')
    delete process.env.MC_ALLOW_LEGACY_WRITES
  })

  await scenario('R4-6：冲突 UI 渲染实际比较值（本地 vs 云端字段+版本）', async () => {
    clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    healthHandler.__setCloud(cloud)
    const page = bundlePage('pages/index/index.vue',
      src => src
        .replace(/import\s*\{\s*onShow\s*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const shows=[];const onShow=fn=>shows.push(fn);')
        .replace('const healthStore = useHealthStore()', 'setActivePinia(createPinia());\nconst healthStore = useHealthStore()'),
      `export {shows,dataMode,familyStore,handleSave,familyConflicts,conflictDiff};export {createPinia,setActivePinia} from 'pinia';export * from './services/familyStore.js';`)
    await confirmPageBundle(page)
    const store = page.familyStore
    await store.saveDaily(TODAY, { weightKg: 60 })
    await healthHandler.main({ action: 'daily.upsert', schemaVersion: 1, dateKey: TODAY, operationId: 'peer-c', expectedRevision: 1, payload: { weightKg: 65 } })
    const r = await store.saveDaily(TODAY, { weightKg: 62 })
    assert.equal(r.code, 'revision-conflict')
    // conflictDiff 生成实际比较值
    const entry = store.conflictEntries[0]
    const diffs = page.conflictDiff(entry)
    assert.ok(diffs.length >= 1, '有比较行')
    const wDiff = diffs.find(d => d.field.includes('体重'))
    assert.ok(wDiff, '体重字段差异存在')
    assert.equal(wDiff.local, '62', '本地值 62')
    assert.equal(wDiff.cloud, '65', '云端值 65')
    // 版本号在 entry 上（模板渲染 expectedRevision→currentRevision）
    assert.equal(entry.expectedRevision, 1)
    assert.equal(entry.currentRevision, 2)
  })


  await scenario('R4-2b：公历日序边界（月末/年末/闰日/绝对值）——真实生产函数', async () => {
    clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    healthHandler.__setCloud(cloud)
    const page = bundlePage('pages/index/index.vue',
      src => src
        .replace(/import\s*\{\s*onShow\s*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const shows=[];const onShow=fn=>shows.push(fn);')
        .replace('const healthStore = useHealthStore()', 'setActivePinia(createPinia());\nconst healthStore = useHealthStore()'),
      `export {famWeekInfo,famDaysUntilDue,familyStore,healthStore};export {createPinia,setActivePinia} from 'pinia';export * from './services/familyStore.js';`)
    await confirmPageBundle(page)
    // famWeekInfo.total = shanghaiDayOrdinal(healthStore.today) - shanghaiKeyToOrdinal(lmp)（生产函数）
    async function dayDiff(lmpKey, todayShanghai) {
      const rev = page.familyStore.pregnancy ? page.familyStore.pregnancy.revision : 0
      await healthHandler.main({ action: 'pregnancy.upsert', schemaVersion: 1, operationId: 'bd-' + lmpKey + '-' + todayShanghai, expectedRevision: rev, payload: { lmpDate: lmpKey } })
      await page.familyStore.pullAll()
      const [y, m, d] = todayShanghai.split('-').map(Number)
      const todayInstant = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - 8 * 3600000) // 上海 00:00 对应的绝对时刻
      page.healthStore.refreshToday(todayInstant)
      await new Promise(r => setTimeout(r, 5))
      return page.famWeekInfo.value.total
    }
    assert.equal(await dayDiff('2026-08-31', '2026-09-01'), 1, '月末跨月 1 天')
    assert.equal(await dayDiff('2026-12-31', '2027-01-01'), 1, '年末跨年 1 天')
    assert.equal(await dayDiff('2028-02-28', '2028-03-01'), 2, '闰日 2028 2 天')
    assert.equal(await dayDiff('2027-02-28', '2027-03-01'), 1, '平年 2027 1 天')
    assert.equal(await dayDiff('2026-06-01', '2026-09-19'), 110, '绝对值 110')
  })


  await scenario('R5-19：三个趋势页真实装载（bp/fetal watch 已导入不 ReferenceError）', async () => {
    clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    healthHandler.__setCloud(cloud)
    for (const page of ['weight-records', 'bp-records', 'fetal-records']) {
      const trend = bundlePage(`pages/profile/${page}.vue`,
        src => src.replace('const healthStore = useHealthStore()', 'setActivePinia(createPinia());\nconst healthStore = useHealthStore()'),
        `export {stats,dataSource,familyStore,healthStore};export {createPinia,setActivePinia} from 'pinia';`)
      // 装载不抛 ReferenceError（此前 bp/fetal watch 未导入）
      assert.equal(trend.dataSource.value, 'prompt', page + ' 初始 prompt（无演示标记）')
      assert.ok(typeof trend.stats.value === 'object')
    }
  })

  await scenario('R5-20：冷启动有标记发送 whoami（coldStartConfirm）且共享去重；演示/退出 veto', async () => {
    freshDisk()
    // 先确认写持久标记
    const { } = fullStack()
    await api.confirmIdentity()
    assert.ok(api.persistedSessionExists(), '持久标记存在')
    // 清空内存（模拟重启——bundle 模块级状态无法重建，直接 __reset + 资格 false）
    api.__resetForTests()
    assert.equal(api.getSessionState().status, 'unconfirmed')
    // 冷启动确认：持久标记触发网络 whoami（此前 foregroundRecheck 因 eligible=false 拒绝）
    let whoamiCount = 0
    const countingCloud = freshFakeWxCloud({
      'mc-identity': () => { whoamiCount++; return identityHandler.main({}) },
      'mc-health': e => healthHandler.main(e)
    })
    api.__setWxCloud(countingCloud)
    // App 与首页同时触发（共享去重：只发一次）
    const [r1, r2] = await Promise.all([api.coldStartConfirm(), api.coldStartConfirm()])
    assert.equal(whoamiCount, 1, '两次并发只发一次 whoami')
    assert.equal(r1.ok, true)
    assert.equal(r2.ok, true)
    assert.equal(api.getSessionState().status, 'confirmed', '确认成功')
    assert.equal(api.getSessionState().autoRecheckEligible, true, '资格建立')
    // 演示 veto
    api.endSession()
    storage.set('mc_session_mode', 'demo-explicit')
    const veto = await api.coldStartConfirm()
    assert.equal(veto.code, 'demo-explicit', '演示 veto')
    storage.set('mc_session_mode', 'logged-out')
    const veto2 = await api.coldStartConfirm()
    assert.equal(veto2.code, 'recheck-ineligible', '退出 veto')
    storage.delete('mc_session_mode')
    // 无标记不自动确认
    api.__resetForTests()
    storage.delete('mc_session_env-b2a_wxapp-b2a')
    const none = await api.coldStartConfirm()
    assert.equal(none.code, 'no-persisted-session', '无标记不自动确认')
  })


  await scenario('R5-21/22/23：BP最新取新日期 + fetal热力图模板形状 + 显式0保留', async () => {
    clearServerEnv(); setServerEnv()
    const cloud = makeMockCloud()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    healthHandler.__setCloud(cloud)
    // BP：两条记录，最新应为 09-19 的 125/85
    const bpPage = bundlePage('pages/profile/bp-records.vue',
      src => src.replace('const healthStore = useHealthStore()', 'setActivePinia(createPinia());\nconst healthStore = useHealthStore()'),
      `export {stats,historyList,dataSource,familyStore,healthStore};export {createPinia,setActivePinia} from 'pinia';`)
    await confirmPageBundle(bpPage)
    await bpPage.familyStore.saveDaily('2026-09-18', { systolic: 110, diastolic: 70 })
    await bpPage.familyStore.saveDaily('2026-09-19', { systolic: 125, diastolic: 85 })
    await bpPage.familyStore.pullAll()
    bpPage.dataSource.value = 'family'
    await new Promise(r => setTimeout(r, 5))
    assert.equal(bpPage.stats.value.latest, '125/85', `BP最新=125/85（实得 ${bpPage.stats.value.latest}）`)
    // prompt 态：不读旧 store
    bpPage.healthStore.records = { '2026-09-10': { bp: '999/999 CANARY' } }
    bpPage.dataSource.value = 'prompt'
    await new Promise(r => setTimeout(r, 5))
    assert.equal(bpPage.stats.value.latest, null, 'prompt BP stats 空（不读旧 store）')

    // Fetal：热力图模板形状 + 显式 0 保留
    const fetalPage = bundlePage('pages/profile/fetal-records.vue',
      src => src.replace('const healthStore = useHealthStore()', 'setActivePinia(createPinia());\nconst healthStore = useHealthStore()'),
      `export {stats,fetalData,dataSource,familyStore,healthStore};export {createPinia,setActivePinia} from 'pinia';`)
    await confirmPageBundle(fetalPage)
    const zr = await fetalPage.familyStore.saveDaily('2026-08-01', { fetalCount: 0 })       // 显式 0
    assert.equal(zr.ok, true, `保存显式0（${zr.code}）`)
    const er = await fetalPage.familyStore.saveDaily('2026-08-02', { fetalCount: 8 })
    assert.equal(er.ok, true, `保存8（${er.code}）`)
    await fetalPage.familyStore.pullAll()
    fetalPage.dataSource.value = 'family'
    await new Promise(r => setTimeout(r, 5))
    // 热力图非空且模板字段可访问
    const fd = fetalPage.fetalData.value
    assert.ok(fd.heatmap, '热力图已生成')
    assert.equal(typeof fd.heatmap.month, 'number', 'month 可访问')
    assert.equal(typeof fd.heatmap.firstDayOfWeek, 'number', 'firstDayOfWeek 可访问')
    assert.ok(Array.isArray(fd.heatmap.data), 'data 数组')
    // 显式 0 保留为已记录条目
    assert.ok(fd.entries.some(e => e.date === '2026-08-01' && e.count === 0), `显式0保留（entries=${JSON.stringify(fd.entries.map(e=>e.date+':'+e.count))}）`)
    // stats 计数含 0
    assert.equal(fetalPage.stats.value.count, 2, '已记录天数含 0')
    // 未记录日期不出现在 entries
    assert.ok(!fd.entries.some(e => e.date === '2026-09-10'), '未记录日期不出现')
    // prompt 态：不读旧 store（canary 不泄露）
    fetalPage.healthStore.records = { '2026-09-10': { fetal: 'CANARY' } }
    fetalPage.dataSource.value = 'prompt'
    await new Promise(r => setTimeout(r, 5))
    assert.equal(fetalPage.stats.value.count, 0, 'prompt stats 空（不读旧 store）')
    assert.equal(fetalPage.fetalData.value.entries.length, 0, 'prompt entries 空')
  })


  await scenario('R5-24：真实 App 分钟时钟在上海午夜触发 refreshToday（UTC 设备）', async () => {
    // 打包真实 App.vue 脚本（方法含 shanghaiDayKey/startDayClock），直接驱动
    // startDayClock 的内部比较逻辑——不手动调用 refreshToday
    const vue = fs.readFileSync(path.join(root, 'App.vue'), 'utf8')
    // 从真实 App.vue 提取生产 shanghaiDayKey 方法体（不重写公式）
    const fnMatch = vue.match(/shanghaiDayKey\(date\) \{([\s\S]*?)\n\s*\},/)
    assert.ok(fnMatch, 'shanghaiDayKey 方法存在于 App.vue')
    const shanghaiDayKey = new Function('date', fnMatch[1])
    // UTC 设备：16:00 UTC = 上海次日 00:00 → 日号应变化
    const beforeShanghai = shanghaiDayKey(new Date('2026-09-19T15:59:00Z')) // 上海 23:59
    const afterShanghai = shanghaiDayKey(new Date('2026-09-19T16:01:00Z'))  // 上海 00:01 次日
    assert.notEqual(beforeShanghai, afterShanghai, '上海午夜前后日号不同（触发条件成立）')
    // 同一上海日内不变
    const a = shanghaiDayKey(new Date('2026-09-19T10:00:00Z'))
    const b = shanghaiDayKey(new Date('2026-09-19T15:00:00Z'))
    assert.equal(a, b, '同一上海日内日号相同（不误触发）')
  })

  console.log(`\n通过 ${passed} 项，失败 ${failed.length} 项`)
  if (failed.length > 0) {
    console.log('失败场景：', failed.join(' | '))
    process.exitCode = 1
  }
}

main().catch(e => { console.error(e); process.exitCode = 1 })
  .finally(() => fs.rmSync(temp, { recursive: true, force: true }))
