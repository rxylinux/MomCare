// Phase C Stage 2 客户端级回归：collabStore（Pinia）→ outbox → 真实 mc-collab handler → mock 云 CAS。
// 覆盖：视角偏好初始化/持久化；分享创建与双端拉取；确定性任务接单；撤回单调墓碑（本地立即抹除+
// 快照/待办 canary 零残留）；离线 Outbox 入队与恢复 flush；会话切换隔离（上一身份队列不可见不发）。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-pc2c-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')

cp_assemble()
function cp_assemble() { require('node:child_process').execFileSync('node', [path.join(root, 'cloud/assemble.mjs')], { stdio: 'pipe' }) }
const DIST = path.join(root, 'dist/cloud-functions')
const collabH = require(path.join(DIST, 'mc-collab/index.js'))
const healthH = require(path.join(DIST, 'mc-health/index.js'))

// ── 冻结源哈希 ──
const FROZEN_RELS = ['services/collabStore.js', 'services/outbox.js', 'services/sessionService.js', 'cloud/functions/mc-collab/index.js']
const frozenHashes = Object.fromEntries(FROZEN_RELS.map(rel => [rel, sha256(fs.readFileSync(path.join(root, rel)))]))
console.log('冻结源哈希（加载时快照）:')
for (const [rel, h] of Object.entries(frozenHashes)) console.log(`  ${h.slice(0, 8)}  ${rel}`)

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-pc2c', MC_MEMBER_MAMA_OPENID: 'oPC2MAMA123456', MC_MEMBER_PAPA_OPENID: 'oPC2PAPA123456' }

// ── Mock 云（版本 CAS 事务）──
function makeMockCloud() {
  const docs = new Map(), storedFiles = new Map()
  const state = { caller: TEST_ENV.MC_MEMBER_MAMA_OPENID, initialized: false }
  const clone = x => JSON.parse(JSON.stringify(x))
  function docApi(col, id, tx) {
    return {
      get: async () => { const e = docs.get(`${col}/${id}`); if (tx) tx.reads.set(`${col}/${id}`, e ? e.__v : 0); return { data: e ? { ...clone(e), _id: id } : null } },
      set: async ({ data }) => {
        if (data && Object.prototype.hasOwnProperty.call(data, '_id')) { const err = new Error('-501007'); err.errMsg = err.message; throw err }
        if (tx) { tx.writes.set(`${col}/${id}`, clone(data)); return { _id: id } }
        const prev = docs.get(`${col}/${id}`)
        docs.set(`${col}/${id}`, { ...clone(data), __v: (prev ? prev.__v : 0) + 1 }); return { _id: id }
      },
      remove: async () => { if (tx) { tx.removes.add(`${col}/${id}`); return {} } docs.delete(`${col}/${id}`); return {} }
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
      return {
        collection: c => ({ doc: id => docApi(c, id, tx) }),
        commit: async () => {
          for (const [k, rv] of tx.reads) {
            const cur2 = docs.get(k)
            if ((cur2 ? cur2.__v : 0) !== rv) { const err = new Error('transaction conflict: ' + k); err.errCode = 'CONFLICT'; throw err }
          }
          for (const k of tx.removes) docs.delete(k)
          for (const [k, d2] of tx.writes) { const prev = docs.get(k); docs.set(k, { ...d2, __v: (prev ? prev.__v : 0) + 1 }) }
        },
        rollback: async () => { tx.writes.clear(); tx.removes.clear() },
      }
    },
    collection: c => ({ doc: id => docApi(c, id, null), where: f => mq(c, f), get: async () => ({ data: runQuery(c, {}) }) })
  }
  return {
    DYNAMIC_CURRENT_ENV: Symbol('env'), init() { state.initialized = true },
    getWXContext: () => ({ APPID: TEST_ENV.MC_APPID, OPENID: state.caller }),
    database() { if (!state.initialized) throw new Error('init first'); return db },
    __docs: docs, __state: state, __setCtx(o) { state.caller = o },
  }
}

const storage = new Map()
const uniCalls = { toasts: [], modals: [], navigations: [] }
global.uni = {
  getStorageSync(k) { return storage.has(k) ? storage.get(k) : '' },
  setStorageSync(k, v) { storage.set(k, v) },
  removeStorageSync(k) { storage.delete(k) },
  getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
  showToast: v => uniCalls.toasts.push(v && v.title),
  showModal: o => { uniCalls.modals.push({ title: o && o.title, content: o && o.content }); o && o.success && o.success({ confirm: true }) },
  showLoading() {}, hideLoading() {},
  redirectTo() {}, navigateTo: o => uniCalls.navigations.push(o && o.url), switchTab() {}, reLaunch() {}, navigateBack() {},
  request() {}, uploadFile() {}, downloadFile: o => o.fail && o.fail({ errMsg: 'dl' }),
}

// ── 客户端 bundle（独立 pinia；逐 case 全新模块实例）──
const clientBundle = path.join(temp, 'client.cjs')
{
  const src = `import { createPinia, setActivePinia } from 'pinia';\nsetActivePinia(createPinia());\n` +
    `export * from './services/collabStore.js';\nexport * from './services/sessionService.js';\nexport * from './services/outbox.js';\nexport * from './services/cloudAdapter.js';\nexport * from './utils/cloudConfig.js';\n`
  esbuild.buildSync({ stdin: { contents: src, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: clientBundle, logLevel: 'silent' })
}
function loadClient() {
  delete require.cache[require.resolve(clientBundle)]
  return require(clientBundle)
}

const network = { offline: false }
function makeStack(member = 'mama') {
  for (const k of [...storage.keys()]) {
    if (k.startsWith('mc_outbox_') || k.startsWith('mc_cache_') || k.startsWith('mc_session_') || k === 'momcare_home_view') storage.delete(k)
  }
  network.offline = false
  const cloud = makeMockCloud()
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID
  cloud.__setCtx(member === 'mama' ? TEST_ENV.MC_MEMBER_MAMA_OPENID : TEST_ENV.MC_MEMBER_PAPA_OPENID)
  collabH.__setCloud(cloud); healthH.__setCloud(cloud)
  const curMember = { value: member }
  const routes = {
    'mc-collab': e => collabH.main(e),
    'mc-health': e => healthH.main(e),
    'mc-identity': () => ({ ok: true, data: { memberId: curMember.value, displayName: curMember.value === 'mama' ? '妈妈' : '爸爸', familyId: TEST_ENV.MC_FAMILY_ID } })
  }
  const wxCloud = {
    init() {},
    callFunction(o) {
      if (network.offline) { o.fail({ errMsg: 'cloud.callFunction:fail offline' }); return }
      const h = routes[o.name]
      if (!h) { o.fail({ errMsg: 'no route' }); return }
      Promise.resolve().then(() => h(o.data)).then(r => o.success({ result: r })).catch(e => o.fail({ errMsg: e.message }))
    }
  }
  return {
    cloud, routes, curMember, wxCloud,
    as(m) { curMember.value = m; cloud.__setCtx(m === 'mama' ? TEST_ENV.MC_MEMBER_MAMA_OPENID : TEST_ENV.MC_MEMBER_PAPA_OPENID) },
  }
}
function wire(stack) {
  const client = loadClient()
  client.__setCloudConfigForTests('env-pc2c', 'wxapp-pc2c')
  client.__setWxCloud(stack.wxCloud)
  global.wx = { cloud: stack.wxCloud }
  client.__resetForTests()
  return client
}
// 全 storage canary 扫描（快照/待办/会话——任何持久键不得含已撤回原文）
function assertNoCanaryInStorage(canary, label) {
  for (const [k, v] of storage.entries()) {
    const s = String(typeof v === 'string' ? v : JSON.stringify(v))
    assert.ok(!s.includes(canary), `${label}：storage 键 ${k} 泄漏原文 canary（${s.slice(0, 140)}…）`)
  }
}

async function main() {
  console.log('Phase C Stage 2 客户端级回归（collabStore → outbox → 真实 mc-collab）\n')

  await scenario('S1 视角偏好：默认按身份/持久化恢复/切换落盘', async () => {
    const stack = makeStack('mama')
    const client = wire(stack)
    await client.confirmIdentity()
    const store = client.useCollabStore()
    assert.equal(store.initHomeView(), 'mom', 'mama 默认 mom')
    assert.equal(store.switchHomeView('dad'), true, '切换成功')
    assert.equal(storage.get('momcare_home_view'), 'dad', '持久化到 momcare_home_view')
    assert.equal(store.homeView, 'dad')
    assert.equal(store.switchHomeView('bogus'), false, '非法视角拒绝')
    assert.equal(store.homeView, 'dad', '非法切换不改变')
    // papa 默认 dad；显式存储优先于身份默认
    {
      const stack2 = makeStack('papa')
      const client2 = wire(stack2)
      await client2.confirmIdentity()
      const store2 = client2.useCollabStore()
      assert.equal(store2.initHomeView(), 'dad', 'papa 默认 dad')
      storage.set('momcare_home_view', 'mom')
      assert.equal(store2.initHomeView(), 'mom', '已存储偏好优先（papa 保留 mom 偏好）')
    }
  })

  await scenario('S2 分享创建+双端拉取+计算属性+确定性任务接单', async () => {
    const stack = makeStack('mama')
    const client = wire(stack)
    await client.confirmIdentity()
    const store = client.useCollabStore()
    const canary = 'S2-希望帮忙带饭'
    const r = await store.saveNeed({ content: canary, targetDate: '2026-09-28' })
    assert.ok(r.ok, `saveNeed: ${JSON.stringify(r).slice(0, 150)}`)
    const needId = r.view.needId
    assert.ok(store.needs[needId] && store.needs[needId].content === canary, '本地视图落地')
    assert.equal(store.myActiveShare && store.myActiveShare.needId, needId, 'myActiveShare=本人最新 active')
    // 服务端直查（白盒）
    const doc = stack.cloud.__docs.get(`mc_shared_needs/${needId}`)
    assert.ok(doc && doc.content === canary && doc.ownerId === 'mama')
    // 双端：papa 拉取看到对方分享；接下→确定性任务
    const clientP = wire(stack) // 同 mock 云新客户端（隔离 pinia）
    stack.as('papa')
    await clientP.confirmIdentity()
    const storeP = clientP.useCollabStore()
    assert.ok((await storeP.pullCollab()).ok, 'papa 拉取')
    assert.equal(storeP.partnerActiveShare && storeP.partnerActiveShare.content, canary, 'partnerActiveShare=对方最新')
    assert.ok(!storeP.myActiveShare, 'papa 无本人分享')
    const ac = await storeP.acceptTask('need', needId)
    assert.ok(ac.ok, `acceptTask: ${JSON.stringify(ac).slice(0, 150)}`)
    const taskId = `tsk_${TEST_ENV.MC_FAMILY_ID}_need_${needId}`
    assert.equal(ac.view.taskId, taskId, '确定性任务 ID 精确')
    assert.ok(storeP.tasks[taskId] && storeP.tasks[taskId].acceptedBy === 'papa', '本地任务落地')
    assert.equal(storeP.taskForNeed(needId).taskId, taskId, 'taskForNeed 定位')
    // mama 侧拉取后看到任务（动态投影标题=当前分享正文）
    stack.as('mama')
    assert.ok((await store.pullCollab()).ok)
    assert.equal(store.tasks[taskId].title, canary, 'need 任务标题=动态投影正文')
    assert.ok(store.dadTopTasks.some(t => t.taskId === taskId), 'dadTopTasks 含未分配/爸爸相关任务')
    // 状态流转
    const up = await storeP.updateTaskStatus(taskId, 'done', 1)
    assert.ok(up.ok && storeP.tasks[taskId].status === 'done', '完成流转')
    assert.equal(stack.cloud.__docs.get(`mc_family_tasks/${taskId}`).status, 'done', '服务端一致')
  })

  await scenario('S3 撤回单调墓碑：本地立即抹除+全 storage canary 零残留+对端拉取不复活', async () => {
    const stack = makeStack('mama')
    const client = wire(stack)
    await client.confirmIdentity()
    const store = client.useCollabStore()
    const canary = 'S3-私人短句勿泄CANARY'
    const r = await store.saveNeed({ content: canary })
    const needId = r.view.needId
    stack.as('papa')
    const clientP = wire(stack)
    await clientP.confirmIdentity()
    const storeP = clientP.useCollabStore()
    await storeP.acceptTask('need', needId)
    const taskId = `tsk_${TEST_ENV.MC_FAMILY_ID}_need_${needId}`
    assert.ok(storeP.tasks[taskId], '前置：任务在场')
    // mama 撤回（在线）
    stack.as('mama')
    const wd = await store.withdrawNeed(needId, 1)
    assert.ok(wd.ok, `withdrawNeed: ${JSON.stringify(wd).slice(0, 150)}`)
    assert.equal(store.needs[needId].content, null, '本地立即抹除')
    assert.equal(store.needs[needId].status, 'withdrawn')
    assert.equal(stack.cloud.__docs.get(`mc_shared_needs/${needId}`).content, null, '服务端物理抹除')
    assert.equal(stack.cloud.__docs.get(`mc_family_tasks/${taskId}`).status, 'cancelled', '服务端任务联动取消')
    assert.equal(store.tasks[taskId].title, '（分享已撤回）', '本地任务脱敏')
    assertNoCanaryInStorage(canary, 'mama 撤回后')
    // papa 再拉取：不复活（need content null；任务脱敏 cancelled）
    stack.as('papa')
    assert.ok((await storeP.pullCollab()).ok)
    assert.equal(storeP.needs[needId].content, null, '对端拉取后 content null')
    assert.equal(storeP.needs[needId].status, 'withdrawn')
    assert.equal(storeP.tasks[taskId].status, 'cancelled', '对端任务 cancelled')
    assert.equal(storeP.tasks[taskId].title, '（分享已撤回）', '对端任务脱敏')
    assert.ok(!storeP.partnerActiveShare, '对方 active 分享清空')
    assertNoCanaryInStorage(canary, 'papa 重拉后')
    // 快照恢复也不复活（papa 冷启动：restoreFromCache）
    {
      const clientP2 = wire(stack)
      await clientP2.confirmIdentity()
      const storeP2 = clientP2.useCollabStore()
      assert.ok(storeP2.restoreFromCache(), '快照恢复')
      assert.equal(storeP2.needs[needId] && storeP2.needs[needId].content, null, '快照墓碑不复活')
      assert.equal(storeP2.tasks[taskId].title, '（分享已撤回）', '快照任务脱敏')
      assertNoCanaryInStorage(canary, 'papa 快照恢复后')
    }
  })

  await scenario('S4 离线 Outbox：入队保留原文 opId+恢复 flush 落库+幂等重试', async () => {
    const stack = makeStack('mama')
    const client = wire(stack)
    await client.confirmIdentity()
    const store = client.useCollabStore()
    network.offline = true
    const canary = 'S4-离线分享'
    const r = await store.saveNeed({ content: canary })
    assert.ok(!r.ok, '离线保存不报成功')
    const entries = client.getOutbox()
    assert.equal(entries.length, 1, '入队恰一条')
    assert.equal(entries[0].kind, 'collab-need-create')
    assert.ok(entries[0].opId, '稳定 opId 落盘')
    assert.ok(String(entries[0].payload.content).includes(canary), '待办保留完整内容（本人队列——重发凭据）')
    // 恢复网络 flush：落库 + 队列清空
    network.offline = false
    const results = await store.flushAll()
    assert.equal(results.length, 1)
    assert.equal(results.filter(x => x.ok).length, 1, `flush 成功（实得 ${JSON.stringify(results).slice(0, 120)}）`)
    assert.equal(client.getOutbox().length, 0, '队列清空')
    const needIds = [...stack.cloud.__docs.keys()].filter(k => k.startsWith('mc_shared_needs/'))
    assert.equal(needIds.length, 1, '服务端恰一条')
    assert.equal(stack.cloud.__docs.get(needIds[0]).content, canary)
    // 离线接单 → flush → 确定性任务
    network.offline = true
    const needId = needIds[0].split('/')[1]
    const ac = await store.acceptTask('need', needId)
    assert.ok(!ac.ok && client.getOutbox().length === 1, '离线接单入队')
    const opIdBefore = client.getOutbox()[0].opId
    network.offline = false
    const r2 = await store.flushAll()
    assert.equal(r2.filter(x => x.ok).length, 1, 'flush 接单成功')
    assert.equal(stack.cloud.__docs.get(`mc_family_tasks/tsk_${TEST_ENV.MC_FAMILY_ID}_need_${needId}`).acceptedBy, 'mama', '确定性任务落库')
    // 未变更重试：同源再 accept（在线）→ 幂等同任务不新建
    const ac2 = await store.acceptTask('need', needId)
    assert.ok(ac2.ok && ac2.view.taskId === `tsk_${TEST_ENV.MC_FAMILY_ID}_need_${needId}`, '幂等返回同一任务')
    assert.equal([...stack.cloud.__docs.keys()].filter(k => k.startsWith('mc_family_tasks/')).length, 1, '磁盘仍恰一份任务')
  })

  await scenario('S5 会话切换隔离：上一身份队列不可见不被新身份发送+数据不泄漏', async () => {
    const stack = makeStack('mama')
    const client = wire(stack)
    await client.confirmIdentity()
    const store = client.useCollabStore()
    // mama 离线留下待办 + 私人 mood（服务端）作 canary
    network.offline = true
    const r = await store.saveNeed({ content: 'S5-mama-离线分享' })
    assert.ok(!r.ok && client.getOutbox().length === 1, 'mama 离线待办在场')
    const mamaEntryCount = client.getOutbox().length
    network.offline = false // 恢复网络（papa 在线确认+验证其 flush 不发送 mama 待办）
    // 切换到 papa（新会话——同一 bundle 的 sessionService 状态切换）
    stack.as('papa')
    client.__resetForTests()
    await client.confirmIdentity()
    assert.equal(client.getSessionState().member.memberId, 'papa', 'papa 会话确认')
    assert.equal(client.getOutbox().length, 0, 'papa 队列空——mama 待办不可见（成员命名空间）')
    assert.equal([...storage.keys()].filter(k => k.startsWith('mc_outbox_') && k.includes('_papa_')).length, 0, 'papa 名下无队列键')
    // papa flush 不发送 mama 的待办（网络已恢复——空队列零发送）
    await store.flushAll()
    assert.equal([...stack.cloud.__docs.keys()].filter(k => k.startsWith('mc_shared_needs/')).length, 0, 'mama 离线分享未被 papa 发送')
    // 切回 mama：待办仍在（原 opId）→ flush 落库
    stack.as('mama')
    client.__resetForTests()
    await client.confirmIdentity()
    const mamaEntries = client.getOutbox()
    assert.equal(mamaEntries.length, mamaEntryCount, '切回 mama 待办保留')
    const r3 = await store.flushAll()
    assert.equal(r3.filter(x => x.ok).length, 1, 'mama 自己 flush 成功')
    assert.equal([...stack.cloud.__docs.keys()].filter(k => k.startsWith('mc_shared_needs/')).length, 1, '落库恰一条')
  })

  await scenario('S6 拉取分页闭合+自定义任务+closeNeed', async () => {
    const stack = makeStack('mama')
    const client = wire(stack)
    await client.confirmIdentity()
    const store = client.useCollabStore()
    // 直连 handler 种 102 条（>1 页——pullCollab limit 100 分页闭合）
    for (let i = 0; i < 102; i++) {
      const r = await collabH.main({ action: 'need.create', content: `S6-批量-${i}`, operationId: `seed-${i}` })
      assert.ok(r.ok, `seed ${i}`)
    }
    assert.ok((await store.pullCollab()).ok, '拉取')
    assert.equal(Object.keys(store.needs).length, 102, '102 条全量（分页闭合不漏）')
    // 自定义任务
    const cr = await store.createCustomTask({ title: 'S6-自定义任务', targetDate: '2026-10-02', assigneeId: 'papa' })
    assert.ok(cr.ok && cr.view.sourceType === 'custom', `createCustomTask: ${JSON.stringify(cr).slice(0, 150)}`)
    assert.ok(store.tasks[cr.view.taskId] && store.tasks[cr.view.taskId].assigneeId === 'papa')
    assert.ok(store.myTasks.length === 0 || store.myTasks.every(t => t.assigneeId !== 'papa'), 'myTasks 只含本人相关（mama 视角）')
    // closeNeed：正文保留
    const cn = await store.saveNeed({ content: 'S6-将被结束' })
    const cl = await store.closeNeed(cn.view.needId, 1)
    assert.ok(cl.ok, 'closeNeed')
    assert.equal(store.needs[cn.view.needId].status, 'closed', '本地 closed')
    assert.equal(store.needs[cn.view.needId].content, 'S6-将被结束', 'close 不抹正文（对照 withdraw）')
  })

  await scenario('Z9 冻结源哈希：运行期间源未被并发编辑', async () => {
    for (const [rel, h] of Object.entries(frozenHashes)) {
      const now = sha256(fs.readFileSync(path.join(root, rel)))
      assert.equal(now, h, `${rel} 被并发编辑——结果作废须复跑`)
    }
  })

  console.log(`\n${passed} 通过, ${failed.length} 失败`)
  if (failed.length) { console.log('失败项：'); for (const f of failed) console.log(` - ${f}`); process.exit(1) }
  process.exit(0)
}

main().catch(e => { console.error('套件异常:', e); process.exit(2) })
