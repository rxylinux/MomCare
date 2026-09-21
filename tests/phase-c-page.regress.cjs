// Phase C Stage 2 页面/组件级回归：真实 pages/index/index.vue + pages/tasks/index.vue +
// 三个 home 组件的 <script setup> → esbuild bundle（独立 pinia）→ 真实 mc-collab/mc-health handler。
// 覆盖：双首页分区排列顺序；视角切换权限不变性（身份不变/mood 私人隔离/代记真实操作者）；
// SharedStatusCard 接下点击与撤回确认文案；TaskListCard 勾选完成/撤销；任务页筛选/新建/脱敏；空状态文案。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-pc2p-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')

require('node:child_process').execFileSync('node', [path.join(root, 'cloud/assemble.mjs')], { stdio: 'pipe' })
const DIST = path.join(root, 'dist/cloud-functions')
const collabH = require(path.join(DIST, 'mc-collab/index.js'))
const healthH = require(path.join(DIST, 'mc-health/index.js'))

// ── 冻结源哈希 ──
const FROZEN_RELS = ['pages/index/index.vue', 'pages/tasks/index.vue', 'components/home/SharedStatusCard.vue', 'components/home/NeedComposer.vue', 'components/home/TaskListCard.vue', 'services/collabStore.js']
const frozenHashes = Object.fromEntries(FROZEN_RELS.map(rel => [rel, sha256(fs.readFileSync(path.join(root, rel)))]))
console.log('冻结源哈希（加载时快照）:')
for (const [rel, h] of Object.entries(frozenHashes)) console.log(`  ${h.slice(0, 8)}  ${rel}`)

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-pc2p', MC_MEMBER_MAMA_OPENID: 'oPC2MAMA123456', MC_MEMBER_PAPA_OPENID: 'oPC2PAPA123456' }

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
    uploadFile: async ({ cloudPath, fileContent }) => { storedFiles.set(cloudPath, Buffer.from(fileContent)); return { fileID: `cloud://e.b/${cloudPath}` } },
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
  showModal: o => { uniCalls.modals.push({ title: o && o.title, content: o && o.content, confirmText: o && o.confirmText }); o && o.success && o.success({ confirm: true }) },
  showLoading() {}, hideLoading() {},
  redirectTo() {}, navigateTo: o => uniCalls.navigations.push(o && o.url), switchTab() {}, reLaunch() {}, navigateBack() {},
  request() {}, uploadFile() {}, downloadFile: o => o.fail && o.fail({ errMsg: 'dl' }),
}

// ── 页面/组件 bundle 构建（b2a/b3a-page 同型）──
function scriptBodyOf(vuePath) {
  const src = fs.readFileSync(path.join(root, vuePath), 'utf8')
  const m = src.match(/<script setup>([\s\S]*?)<\/script>/)
  if (!m) throw new Error('无 <script setup>: ' + vuePath)
  return m[1]
}
function buildBundle(vuePath, { anchor, exports, extraPrepend = '' }, outfile) {
  let code = scriptBodyOf(vuePath)
    .replace(/^import .* from ['"][^'"\n]+\.vue['"];?$/mg, '')
    .replace(/import\s*\{\s*onShow\s*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const shows=[];const onShow=fn=>shows.push(fn);')
    .replace(/import\s*\{[^}]*onShow[^}]*\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, 'const shows=[];const onShow=fn=>shows.push(fn);')
  code = code.replace(/import\s*\{([^}]*)\}\s*from\s*['"]vue['"];?/, (all, names) => {
    const kept = names.split(',').map(s => s.trim()).filter(n => n && n !== 'onMounted' && n !== 'onLoad')
    return kept.length ? `import { ${kept.join(', ')} } from 'vue'` : ''
  })
  const prepend = `import { createPinia, setActivePinia } from 'pinia';\n` +
    `const mounts=[];const onMounted=fn=>mounts.push(fn);\n` +
    `const definePropsStub={need:null,tasks:[],title:'',visible:false};\n` +
    `const propsRef={value:definePropsStub};\n` +
    `const defineProps=()=>definePropsStub;\n` +
    `const emitCalls=[];const defineEmits=()=>((...a)=>{emitCalls.push(a);return true});\n` +
    extraPrepend
  let final = prepend + code
  if (anchor) {
    final = final.replace(anchor, `setActivePinia(createPinia());\n${anchor}`)
  } else {
    final = final.replace(/^/, 'setActivePinia(createPinia());\n')
  }
  final += '\n' + exports + '\n'
  esbuild.buildSync({ stdin: { contents: final, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile, logLevel: 'silent' })
}

const bundles = {}
function buildAll() {
  // 首页
  buildBundle('pages/index/index.vue', {
    anchor: 'const healthStore = useHealthStore()',
    exports: `export {shows,mounts,dataMode,homeSections,onSwitchView,collabStore,familyStore,nextCheckup,dadTopTasks,tasksForPrepCard,bagSummary,composerVisible,currentRecord,openEdit,handleSave,selectedDate,editBaseline,editVisible,heroPregInfoSet};\nexport * from './services/sessionService.js';export * from './services/cloudAdapter.js';export * from './services/familyStore.js';export * from './services/collabStore.js';export * from './services/outbox.js';export * from './utils/cloudConfig.js';`
  }, path.join(temp, 'page-index.cjs'))
  // 任务页
  buildBundle('pages/tasks/index.vue', {
    anchor: 'const collabStore = useCollabStore()',
    exports: `export {shows,activeTab,filteredTasks,allTasks,createForm,createCanSubmit,createVisible,displayTitle,onAccept,onToggleDone,onCreateCustom,onCancel,canAccept,statusLabel};\nexport * from './services/sessionService.js';export * from './services/cloudAdapter.js';export * from './services/collabStore.js';export * from './services/outbox.js';export * from './utils/cloudConfig.js';`
  }, path.join(temp, 'page-tasks.cjs'))
  // 三组件
  buildBundle('components/home/SharedStatusCard.vue', {
    anchor: 'const collabStore = useCollabStore()',
    exports: `export {share,isMine,linkedTask,acceptedLabel,emptyText,WITHDRAW_CONFIRM_CONTENT,onWithdrawTap,onClose,onAccept,goTasks};\nexport * from './services/collabStore.js';export * from './services/sessionService.js';export * from './services/cloudAdapter.js';export * from './services/outbox.js';export * from './utils/cloudConfig.js';`
  }, path.join(temp, 'comp-share.cjs'))
  buildBundle('components/home/TaskListCard.vue', {
    anchor: 'const collabStore = useCollabStore()',
    exports: `export {onToggle,assigneeLabel,goAllTasks};\nexport * from './services/collabStore.js';export * from './services/sessionService.js';export * from './services/cloudAdapter.js';export * from './services/outbox.js';export * from './utils/cloudConfig.js';`
  }, path.join(temp, 'comp-taskcard.cjs'))
  buildBundle('components/home/NeedComposer.vue', {
    anchor: 'const collabStore = useCollabStore()',
    exports: `export {QUICK_PHRASES,content,targetDate,contentLength,canSubmit,useQuick,onSubmit,emitCalls};\nexport * from './services/collabStore.js';export * from './services/sessionService.js';export * from './services/cloudAdapter.js';export * from './services/outbox.js';export * from './utils/cloudConfig.js';`
  }, path.join(temp, 'comp-composer.cjs'))
  bundles.index = path.join(temp, 'page-index.cjs')
  bundles.tasks = path.join(temp, 'page-tasks.cjs')
  bundles.share = path.join(temp, 'comp-share.cjs')
  bundles.taskcard = path.join(temp, 'comp-taskcard.cjs')
  bundles.composer = path.join(temp, 'comp-composer.cjs')
}

function loadClient(bundlePath) {
  delete require.cache[require.resolve(bundlePath)]
  return require(bundlePath)
}

const network = { offline: false }
function makeStack(member = 'mama') {
  for (const k of [...storage.keys()]) {
    if (k.startsWith('mc_outbox_') || k.startsWith('mc_cache_') || k.startsWith('mc_session_') || k === 'momcare_home_view') storage.delete(k)
  }
  network.offline = false
  uniCalls.toasts.length = 0; uniCalls.modals.length = 0; uniCalls.navigations.length = 0
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
  return { cloud, routes, curMember, wxCloud, as(m) { curMember.value = m; cloud.__setCtx(m === 'mama' ? TEST_ENV.MC_MEMBER_MAMA_OPENID : TEST_ENV.MC_MEMBER_PAPA_OPENID) } }
}
function wire(stack, bundlePath) {
  const client = loadClient(bundlePath)
  client.__setCloudConfigForTests('env-pc2p', 'wxapp-pc2p')
  client.__setWxCloud(stack.wxCloud)
  global.wx = { cloud: stack.wxCloud }
  client.__resetForTests()
  return client
}
async function confirmed(stack, bundlePath, member) {
  stack.as(member)
  const client = wire(stack, bundlePath)
  const r = await client.confirmIdentity()
  assert.ok(r.ok, `confirmIdentity(${member}): ${JSON.stringify(r).slice(0, 120)}`)
  return client
}

async function main() {
  console.log('Phase C Stage 2 页面/组件级回归（真实页面/组件 script → store → 真实 handler）\n')
  buildAll()

  await scenario('P1 双首页排列+视角切换持久化+身份不变', async () => {
    const stack = makeStack('mama')
    const client = await confirmed(stack, bundles.index, 'mama')
    const page = client
    page.dataMode.value = 'family'
    const store = client.useCollabStore()
    store.initHomeView()
    assert.deepEqual(page.homeSections.value, ['dayRecord', 'share', 'checkup', 'tasks', 'knowledge', 'calendar'], `妈妈视角分区序（实得 ${JSON.stringify(page.homeSections.value)}）`)
    page.onSwitchView('dad')
    assert.deepEqual(page.homeSections.value, ['share', 'myTasks', 'checkup', 'tasks', 'knowledge'], `爸爸视角分区序（实得 ${JSON.stringify(page.homeSections.value)}）`)
    assert.equal(storage.get('momcare_home_view'), 'dad', '视角持久化')
    // 权限不变性：切换不改身份
    assert.equal(client.getSessionState().member.memberId, 'mama', 'session.member 仍 mama')
    assert.equal(store.currentMemberId, 'mama', 'store currentMemberId 仍 mama')
    page.onSwitchView('mom')
    assert.deepEqual(page.homeSections.value, ['dayRecord', 'share', 'checkup', 'tasks', 'knowledge', 'calendar'], '切回妈妈视角')
    assert.equal(client.getSessionState().member.memberId, 'mama', '身份恒不变')
    // 非 family 模式：无分区（demo/unconfirmed 不出双首页）
    page.dataMode.value = 'demo'
    assert.deepEqual(page.homeSections.value, [], 'demo 模式无分区')
    page.dataMode.value = 'family'
  })

  await scenario('P2 权限不变性铁律：爸爸切妈妈视角不见 mood 私人数据+代记真实操作者', async () => {
    const stack = makeStack('mama')
    // mama 服务端种私人 mood（canary）+共享 daily
    stack.as('mama')
    const moodCanary = 'P2-私人心情CANARY-仅本人'
    const m1 = await healthH.main({ action: 'mood.upsert', schemaVersion: 1, operationId: 'p2m', dateKey: '2026-09-20', expectedRevision: 0, payload: { mood: 'calm', note: moodCanary } })
    assert.ok(m1.ok, 'mama mood 种子')
    // papa 会话打开首页
    const client = await confirmed(stack, bundles.index, 'papa')
    const page = client
    page.dataMode.value = 'family'
    const store = client.useCollabStore()
    store.initHomeView()
    const fam = page.familyStore
    await fam.pullAll()
    await store.pullCollab()
    // papa 视角下 mood 隔离
    assert.equal(Object.keys(fam.moods || {}).length, 0, 'papa 拉取后 moods 空（服务端隔离）')
    // 切到妈妈视角：仍不可见
    page.onSwitchView('mom')
    assert.deepEqual(page.homeSections.value, ['dayRecord', 'share', 'checkup', 'tasks', 'knowledge', 'calendar'], 'papa 也可用妈妈视角布局')
    assert.equal(Object.keys(fam.moods || {}).length, 0, '切视角后 moods 仍空——视角≠身份')
    assert.equal(client.getSessionState().member.memberId, 'papa', '身份仍 papa')
    // 代记：papa 在妈妈视角记录体重 → updatedBy=papa（真实操作者）
    page.selectedDate.value = new Date('2026-09-20T12:00:00')
    page.openEdit('weight')
    await page.handleSave({ weight: '61.5' })
    const dailyDoc = stack.cloud.__docs.get(`mc_health_daily/${TEST_ENV.MC_FAMILY_ID}:2026-09-20`)
    assert.ok(dailyDoc && dailyDoc.fields.weightKg === 61.5, '代记落库')
    assert.equal(dailyDoc.updatedBy, 'papa', `代记真实操作者=papa（实得 ${dailyDoc.updatedBy}）`)
    // mood canary 不出现在 papa 侧任何存储
    for (const [k, v] of storage.entries()) {
      const s = String(typeof v === 'string' ? v : JSON.stringify(v))
      assert.ok(!s.includes(moodCanary), `storage ${k} 泄漏 mama 私人 mood canary`)
    }
  })

  await scenario('P2b 未填孕期资料点记录卡：兜底提示且不弹层；建档后恢复可编辑', async () => {
    const stack = makeStack('mama')
    const client = await confirmed(stack, bundles.index, 'mama')
    const page = client
    page.dataMode.value = 'family'
    // 前置：全新环境 pregnancy 空（family 卡片区可见但弹层组件不渲染）
    assert.equal(page.heroPregInfoSet.value, false, '前置：未填孕期资料')
    uniCalls.toasts.length = 0
    page.openEdit('weight')
    assert.equal(page.editVisible.value, false, '未建档不打开弹层')
    assert.equal(uniCalls.toasts.length, 1, `恰好一条兜底提示（实得 ${JSON.stringify(uniCalls.toasts)}）`)
    assert.ok(String(uniCalls.toasts[0]).includes('孕期资料'), '提示引导填写孕期资料')
    // 建档（服务端 pregnancy.upsert）+ 拉取 → 恢复正常编辑路径
    stack.as('mama')
    const pr = await healthH.main({ action: 'pregnancy.upsert', schemaVersion: 1, operationId: 'p2b-preg', expectedRevision: 0, payload: { lmpDate: '2026-01-01', dueDate: '2026-10-08' } })
    assert.ok(pr.ok, '建档种子')
    await page.familyStore.pullAll()
    assert.equal(page.heroPregInfoSet.value, true, '建档后 heroPregInfoSet')
    uniCalls.toasts.length = 0
    page.openEdit('weight')
    assert.equal(page.editVisible.value, true, '建档后可打开弹层')
    assert.equal(uniCalls.toasts.length, 0, '建档后不再兜底提示')
  })

  await scenario('P3 SharedStatusCard：空态文案/接下点击/已接下标签/撤回确认文案', async () => {
    // 空状态（家庭无分享）
    {
      const stack = makeStack('papa')
      const client = await confirmed(stack, bundles.share, 'papa')
      const store = client.useCollabStore()
      store.initHomeView()
      await store.pullCollab()
      const comp = client
      assert.equal(comp.share.value, null, '无分享时 share=null')
      assert.equal(comp.emptyText, '今天还没有新的分享', '空态文案精确')
    }
    // mama 分享 → papa 接下 → 完成
    {
      const stack = makeStack('mama')
      stack.as('mama')
      const cr = await collabH.main({ action: 'need.create', content: 'P3-想一起准备产检', targetDate: '2026-10-06', operationId: 'p3n' })
      assert.ok(cr.ok, 'mama 分享种子')
      const needId = cr.data.need.needId
      const client = await confirmed(stack, bundles.share, 'papa')
      const store = client.useCollabStore()
      store.initHomeView() // papa→dad
      await store.pullCollab()
      const comp = client
      assert.equal(comp.share.value && comp.share.value.content, 'P3-想一起准备产检', '对方分享呈现')
      assert.equal(comp.isMine.value, false, '对方视角')
      assert.equal(comp.linkedTask.value, null, '未接下——展示"接下这件事"大按钮')
      // 接下点击（真实 accept——组件内 fire-and-forget，tick 后断言）
      await comp.onAccept()
      await new Promise(r => setTimeout(r, 30))
      const taskId = `tsk_${TEST_ENV.MC_FAMILY_ID}_need_${needId}`
      assert.ok(comp.linkedTask.value && comp.linkedTask.value.taskId === taskId, '接下后任务在场')
      assert.equal(comp.linkedTask.value.status, 'doing', '任务 doing')
      assert.equal(comp.acceptedLabel.value, '已接下 · 进行中', '已接下标签')
      // 完成 → 标签切换
      await store.updateTaskStatus(taskId, 'done', 1)
      assert.equal(comp.acceptedLabel.value, '已完成 · 爸爸', `完成标签（实得 ${comp.acceptedLabel.value}）`)
      // 查看任务跳转
      comp.goTasks()
      assert.ok(uniCalls.navigations.includes('/pages/tasks/index'), `查看任务跳转（实得 ${JSON.stringify(uniCalls.navigations)}）`)
      // 撤回（作者视角——切 mama 新组件实例）
      const clientM = await confirmed(stack, bundles.share, 'mama')
      const storeM = clientM.useCollabStore()
      storeM.initHomeView()
      await storeM.pullCollab()
      const compM = clientM
      assert.equal(compM.isMine.value, true, '作者视角')
      uniCalls.modals.length = 0
      await compM.onWithdrawTap()
      assert.equal(uniCalls.modals.length, 1, '撤回弹二次确认')
      assert.equal(uniCalls.modals[0].content, '联网同步后会从对方页面移除，已经看过或导出的内容无法收回', '撤回确认文案精确（DESIGN §4.3）')
      assert.equal(uniCalls.modals[0].confirmText, '撤回')
      await new Promise(r => setTimeout(r, 20))
      assert.equal(stack.cloud.__docs.get(`mc_shared_needs/${needId}`).content, null, '确认后服务端抹除')
      // 撤回后作者空态回归
      assert.equal(compM.share.value, null, '撤回后我方 active 分享清空')
      assert.equal(compM.emptyText, '今天还没有新的分享')
    }
  })

  await scenario('P4 TaskListCard：勾选完成/撤销完成+查看全部跳转', async () => {
    const stack = makeStack('papa')
    const client = await confirmed(stack, bundles.taskcard, 'papa')
    const store = client.useCollabStore()
    const comp = client
    // 造任务：自定义 + need
    const cr = await collabH.main({ action: 'task.createCustom', title: 'P4-准备待产包清单', assigneeId: 'papa', operationId: 'p4t' })
    assert.ok(cr.ok, '自定义任务种子')
    const taskId = cr.data.task.taskId
    await store.pullCollab()
    const task = store.tasks[taskId]
    assert.ok(task, '任务拉取在场')
    assert.equal(comp.assigneeLabel(task), '指派：爸爸', '负责人标签')
    // 勾选完成
    await comp.onToggle(task)
    assert.equal(store.tasks[taskId].status, 'done', '勾选→完成')
    assert.equal(stack.cloud.__docs.get(`mc_family_tasks/${taskId}`).status, 'done', '服务端一致')
    assert.ok(uniCalls.toasts.includes('已完成'), '完成提示')
    // 撤销完成
    await comp.onToggle(store.tasks[taskId])
    assert.equal(store.tasks[taskId].status, 'doing', '再勾选→撤销完成（doing）')
    assert.ok(uniCalls.toasts.includes('已撤销完成'), '撤销提示')
    // 查看全部
    comp.goAllTasks()
    assert.ok(uniCalls.navigations.includes('/pages/tasks/index'), '查看全部跳转 /pages/tasks/index')
    // cancelled 任务不可勾选（防御）——以当前 revision 取消
    await store.updateTaskStatus(taskId, 'cancelled', store.tasks[taskId].revision)
    const cancelledTask = store.tasks[taskId]
    await comp.onToggle(cancelledTask)
    assert.equal(store.tasks[taskId].status, 'cancelled', '取消态勾选无效')
  })

  await scenario('P5 任务页：筛选/接下/状态流转/新建/撤回脱敏', async () => {
    const stack = makeStack('mama')
    // 种数据：mama 分享（一条将被撤回）+ 自定义任务
    const n1 = await collabH.main({ action: 'need.create', content: 'P5-分享将被撤回', operationId: 'p5n1' })
    const n2 = await collabH.main({ action: 'need.create', content: 'P5-保持活跃', operationId: 'p5n2' })
    const c1 = await collabH.main({ action: 'task.createCustom', title: 'P5-自定义任务', operationId: 'p5c1' })
    assert.ok(n1.ok && n2.ok && c1.ok, '种子')
    stack.as('papa')
    const ac = await collabH.main({ action: 'task.accept', sourceType: 'need', sourceId: n1.data.need.needId, operationId: 'p5a1' })
    assert.ok(ac.ok, 'papa 接下 n1')
    const client = await confirmed(stack, bundles.tasks, 'papa')
    const page = client
    const store = client.useCollabStore()
    await store.pullCollab()
    // 筛选（n2 未接下前无任务——任务=接下的 n1 + 自定义，共 2）
    assert.equal(page.allTasks.value.length, 2, `全部 2（实得 ${page.allTasks.value.length}）`)
    page.activeTab.value = 'doing'
    assert.equal(page.filteredTasks.value.length, 1, '进行中=接下的 n1 任务')
    page.activeTab.value = 'pending'
    assert.equal(page.filteredTasks.value.length, 1, '待办=自定义')
    page.activeTab.value = 'done'
    assert.equal(page.filteredTasks.value.length, 0, '已完成空')
    // need 任务标题=动态投影
    const n1Task = page.allTasks.value.find(t => t.sourceId === n1.data.need.needId)
    assert.equal(n1Task.title, 'P5-分享将被撤回', 'need 任务标题=分享正文投影')
    // 撤回 → 脱敏+cancelled
    stack.as('mama')
    const wd = await collabH.main({ action: 'need.withdraw', needId: n1.data.need.needId, expectedRevision: 1, operationId: 'p5w1' })
    assert.ok(wd.ok, 'mama 撤回')
    stack.as('papa')
    await store.pullCollab()
    const n1TaskAfter = store.tasks[n1Task.taskId]
    assert.equal(page.displayTitle(n1TaskAfter), '（分享已撤回）', `撤回后任务页脱敏（实得 ${page.displayTitle(n1TaskAfter)}）`)
    assert.equal(n1TaskAfter.status, 'cancelled', '撤回联动 cancelled')
    page.activeTab.value = 'cancelled'
    assert.equal(page.filteredTasks.value.length, 1, '已取消筛选含撤回任务')
    // 新建自定义任务（页面处理器）
    page.createForm.value = { title: 'P5-页面新建', targetDate: '2026-10-09', assigneeId: 'mama' }
    await page.onCreateCustom()
    const created = Object.values(store.tasks).find(t => t.title === 'P5-页面新建')
    assert.ok(created && created.assigneeId === 'mama', '页面新建落库+指派 mama')
    assert.equal(page.createForm.value.title, '', '创建后表单清空')
    // 接下（页面处理器）：未接的自定义任务可接
    const customRow = Object.values(store.tasks).find(t => t.title === 'P5-页面新建')
    assert.ok(customRow, '页面新建任务在场')
    assert.equal(page.canAccept(customRow), true, '未接任务可接')
    await page.onAccept(customRow)
    assert.equal(store.tasks[customRow.taskId].acceptedBy, 'papa', '页面接下成功')
    // n2 经 store 接下 → 页面勾选完成
    const n2TaskId = `tsk_${TEST_ENV.MC_FAMILY_ID}_need_${n2.data.need.needId}`
    await store.acceptTask('need', n2.data.need.needId)
    assert.equal(store.tasks[n2TaskId].acceptedBy, 'papa', 'store 接下成功')
    await page.onToggleDone(store.tasks[n2TaskId])
    assert.equal(store.tasks[n2TaskId].status, 'done', '页面勾选完成')
  })

  await scenario('P6 NeedComposer：快捷短句/字数边界/提交/离线暂存提示', async () => {
    const stack = makeStack('mama')
    const client = await confirmed(stack, bundles.composer, 'mama')
    const comp = client
    assert.deepEqual(comp.QUICK_PHRASES, ['想休息一下', '希望帮忙带饭', '想一起准备产检'], '预置快捷短句')
    assert.equal(comp.canSubmit.value, false, '空内容不可提交')
    comp.useQuick('希望帮忙带饭')
    assert.equal(comp.content.value, '希望帮忙带饭')
    assert.equal(comp.contentLength.value, 6)
    assert.equal(comp.canSubmit.value, true, '快捷短句可提交')
    // 200/201 边界（码点）
    comp.content.value = 'a'.repeat(200)
    assert.equal(comp.contentLength.value, 200)
    assert.equal(comp.canSubmit.value, true, '恰 200 可提交')
    comp.content.value = 'a'.repeat(201)
    assert.equal(comp.contentLength.value, 201)
    assert.equal(comp.canSubmit.value, false, '201 不可提交')
    // 提交（在线）→ 服务端落库 + saved 事件
    comp.content.value = 'P6-在线分享'
    uniCalls.toasts.length = 0
    comp.emitCalls.length = 0
    await comp.onSubmit()
    const needDocs = [...stack.cloud.__docs.keys()].filter(k => k.startsWith('mc_shared_needs/'))
    assert.equal(needDocs.length, 1, '服务端落库')
    assert.equal(stack.cloud.__docs.get(needDocs[0]).content, 'P6-在线分享')
    assert.ok(uniCalls.toasts.some(t => String(t).includes('已分享')), `成功提示（实得 ${JSON.stringify(uniCalls.toasts)}）`)
    assert.ok(comp.emitCalls.some(a => a[0] === 'saved'), 'saved 事件发出')
    assert.equal(comp.content.value, '', '提交后清空')
    // 离线：入队 + "已暂存"提示（不显示已保存）
    network.offline = true
    uniCalls.toasts.length = 0
    comp.content.value = 'P6-离线分享'
    await comp.onSubmit()
    assert.ok(uniCalls.toasts.includes('已暂存，联网后同步'), `离线提示如实（实得 ${JSON.stringify(uniCalls.toasts)}）`)
    assert.ok(!uniCalls.toasts.some(t => String(t).includes('已保存')), '离线绝不显示"已保存"')
    const entries = client.getOutbox()
    assert.equal(entries.length, 1, '离线入队')
    network.offline = false
  })

  await scenario('Z9 冻结源哈希：运行期间页面/组件源未被并发编辑', async () => {
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
