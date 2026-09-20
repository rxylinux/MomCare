// Phase C Stage 1 服务端契约回归：mc-collab（分享需要 SharedNeeds + 共同任务 FamilyTasks）。
// 链路：真 handler → mock 云（版本 CAS 事务）→ 真实 mc-schedule 种权威产检/待产包。
//
// 契约依据：docs/PHASE_C_DETAILED_SPECIFICATION_AND_PLAN.md §二 + 设计评审
// docs/PHASE_C_FAMILY_COLLAB_DESIGN_REVIEW_2026-09-20.md（最小服务端合同）。
//
// 核心断言族：
// - need 撤回=单调墓碑：磁盘 content 物理置 null；全库 canary 扫描（所有集合所有文档）零泄漏；
//   旧创建/撤回重放按当前墓碑态生成脱敏响应（绝不恢复原文）。
// - task 确定性 ID tsk_<familyId>_<sourceType>_<sourceId>：同源唯一；重复/并发/丢响应重试
//   收敛同一任务；need 任务不持久复制正文（白盒 title===null）。
// - checkup/bag 权威源联动：updateStatus 同事务同步权威表；task.list 按权威当前态投影
//   （权威侧独立变更亦如实呈现——不形成两份进度）。
// - operationId：同哈希重放、异哈希 operation-id-conflict；操作回执不存正文。
// - 非成员（第三身份）读写全入口 100% 拒绝+零写；跨家庭 not-found/空列表零泄漏。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')

const HANDLER_REL = 'cloud/functions/mc-collab/index.js'
if (!fs.existsSync(path.join(root, HANDLER_REL))) {
  console.log('套件未运行：mc-collab handler 不存在（' + HANDLER_REL + '）')
  process.exit(3)
}

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')
let opSeq = 0
const mkop = p => `${p || 'op'}_${++opSeq}_${crypto.randomBytes(4).toString('hex')}`

const DIST = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-pc1-')), 'cf')
for (const fn of ['mc-health', 'mc-schedule', 'mc-reports', 'mc-files', 'mc-identity', 'mc-collab']) {
  const dir = path.join(DIST, fn); fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(path.join(root, `cloud/functions/${fn}/index.js`), path.join(dir, 'index.js'))
  fs.cpSync(path.join(root, 'cloud/shared'), path.join(dir, 'shared'), { recursive: true })
}

// ── 冻结源哈希（加载时快照；结束时复核）──
const FROZEN_RELS = ['cloud/functions/mc-collab/index.js', 'cloud/shared/auth.js', 'cloud/shared/config.js', 'cloud/shared/respond.js', 'cloud/shared/constants.js']
const frozenHashes = Object.fromEntries(FROZEN_RELS.map(rel => [rel, sha256(fs.readFileSync(path.join(root, rel)))]))
console.log('冻结源哈希（加载时快照）:')
for (const [rel, h] of Object.entries(frozenHashes)) console.log(`  ${h.slice(0, 8)}  ${rel}`)

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-csrv', MC_MEMBER_MAMA_OPENID: 'oCSMAMA123456', MC_MEMBER_PAPA_OPENID: 'oCSPAPA123456', MC_INTRUDER_OPENID: 'oINTRUDER66666' }

// ── Mock 云（版本 CAS 事务——与既有套件同型）──
function makeMockCloud() {
  const docs = new Map(), storedFiles = new Map()
  const state = { caller: TEST_ENV.MC_MEMBER_MAMA_OPENID, initialized: false, calls: [] }
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
    command: { lt: v => ({ __op: 'lt', v }), gt: v => ({ __op: 'gt', v }), inc: v => ({ __op: 'inc', v }) },
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
    __docs: docs, __stored: storedFiles, __state: state, __setCtx(o) { state.caller = o },
  }
}

function requireHandler(name) {
  delete require.cache[require.resolve(path.join(DIST, name, 'index.js'))]
  return require(path.join(DIST, name, 'index.js'))
}
function makeStack(member = 'mama') {
  const cloud = makeMockCloud()
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID; process.env.MC_UPLOAD_ENABLED = 'true'
  cloud.__setCtx(member === 'mama' ? TEST_ENV.MC_MEMBER_MAMA_OPENID : member === 'papa' ? TEST_ENV.MC_MEMBER_PAPA_OPENID : member)
  const hSchedule = requireHandler('mc-schedule')
  const hCollab = requireHandler('mc-collab')
  hSchedule.__setCloud(cloud); hCollab.__setCloud(cloud)
  const curMember = { value: member }
  const routes = {
    'mc-schedule': e => hSchedule.main(e),
    'mc-collab': e => hCollab.main(e),
  }
  return {
    cloud, routes, curMember,
    call: (fn, event) => routes[fn](event),
    as(m) {
      if (m === 'mama') { cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID); curMember.value = 'mama' }
      else if (m === 'papa') { cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID); curMember.value = 'papa' }
      else cloud.__setCtx(m)
    },
  }
}

// ── 白盒辅助 ──
const needDoc = (st, id) => st.cloud.__docs.get(`mc_shared_needs/${id}`)
const taskDocOf = (st, id) => st.cloud.__docs.get(`mc_family_tasks/${id}`)
const taskDocs = st => [...st.cloud.__docs.entries()].filter(([k]) => k.startsWith('mc_family_tasks/')).map(([k, v]) => ({ _id: k.split('/')[1], ...v }))
const needDocs = st => [...st.cloud.__docs.entries()].filter(([k]) => k.startsWith('mc_shared_needs/')).map(([k, v]) => ({ _id: k.split('/')[1], ...v }))
const docCount = st => st.cloud.__docs.size
// 全库 canary 泄漏扫描：任何集合任何文档（含 mc_operations 回执）序列化后不得含原文
function assertNoCanary(st, canary, label) {
  for (const [k, v] of st.cloud.__docs.entries()) {
    const s = JSON.stringify(v)
    assert.ok(!s.includes(canary), `${label}：文档 ${k} 泄漏原文 canary（${s.slice(0, 160)}…）`)
  }
}
async function createNeed(st, { content, targetDate, op }, member = 'mama') {
  const prev = st.curMember.value
  st.as(member)
  const r = await st.call('mc-collab', { action: 'need.create', content, ...(targetDate !== undefined ? { targetDate } : {}), operationId: op || mkop('need') })
  st.as(prev)
  return r
}

async function main() {
  console.log('Phase C Stage 1 服务端契约回归（mc-collab → mock 云 CAS → 真实 mc-schedule）\n')

  await scenario('N1 need.create 正常流：视图/白盒/操作回执不含正文', async () => {
    const st = makeStack('mama')
    const canary = '希望帮忙带饭CANARY-N1'
    const op = mkop('n1')
    const r = await st.call('mc-collab', { action: 'need.create', content: canary, targetDate: '2026-09-21', operationId: op })
    assert.ok(r.ok, `create: ${JSON.stringify(r).slice(0, 200)}`)
    const n = r.data.need
    assert.match(n.needId, /^need_[0-9a-f]{16}$/, `needId 形（实得 ${n.needId}）`)
    assert.equal(n.ownerId, 'mama', 'ownerId=服务端派生作者')
    assert.equal(n.content, canary)
    assert.equal(n.targetDate, '2026-09-21')
    assert.equal(n.status, 'active'); assert.equal(n.revision, 1)
    assert.ok(Number.isInteger(n.createdAt) && Number.isInteger(n.updatedAt))
    // 白盒：磁盘正文在（未撤回）；sortKey 唯一游标
    const doc = needDoc(st, n.needId)
    assert.ok(doc && doc.content === canary && doc.familyId === TEST_ENV.MC_FAMILY_ID && doc.status === 'active')
    assert.ok(typeof doc.sortKey === 'string' && doc.sortKey.includes(n.needId), 'sortKey 复合游标在盘')
    // 操作回执：requestHash+实体指针，绝不含正文
    const opDoc = st.cloud.__docs.get(`mc_operations/mama:${op}`)
    assert.ok(opDoc, '幂等回执落盘')
    assert.ok(!JSON.stringify(opDoc).includes(canary), '回执不含原文（评审 §5——回执只存摘要+实体指针）')
    assert.ok(opDoc.entity && opDoc.entity.collection === 'mc_shared_needs' && opDoc.entity.docId === n.needId)
  })

  await scenario('N2 need.create 校验异常：空白/超长/类型/日期/opId；200 字与代理对边界', async () => {
    const st = makeStack('mama')
    const bad = [
      ['content 空', { content: '', operationId: mkop() }],
      ['content 纯空白', { content: '   \n\t ', operationId: mkop() }],
      ['content 非字符串', { content: 123, operationId: mkop() }],
      ['content 201 字', { content: 'a'.repeat(201), operationId: mkop() }],
      ['content 201 码点（代理对）', { content: '𝐀'.repeat(201), operationId: mkop() }],
      ['targetDate 斜杠', { content: 'x', targetDate: '2026/09/21', operationId: mkop() }],
      ['targetDate 非补零', { content: 'x', targetDate: '2026-9-21', operationId: mkop() }],
      ['operationId 缺失', { content: 'x' }],
      ['operationId 65B', { content: 'x', operationId: 'o'.repeat(65) }],
    ]
    for (const [label, ev] of bad) {
      const r = await st.call('mc-collab', { action: 'need.create', ...ev })
      assert.ok(!r.ok && r.code === 'invalid-params', `${label} 须拒（实得 ${r.code}）`)
    }
    assert.equal(needDocs(st).length, 0, '全部拒绝零写')
    const ok200 = await st.call('mc-collab', { action: 'need.create', content: 'a'.repeat(200), operationId: mkop() })
    assert.ok(ok200.ok, '恰 200 字通过')
    const okEmoji = await st.call('mc-collab', { action: 'need.create', content: '𝐀'.repeat(200), operationId: mkop() })
    assert.ok(okEmoji.ok, '恰 200 码点（代理对按 1 字计）通过')
    const okNoDate = await st.call('mc-collab', { action: 'need.create', content: '无日期分享', operationId: mkop() })
    assert.ok(okNoDate.ok && okNoDate.data.need.targetDate === null, 'targetDate 缺省=null')
  })

  await scenario('N3 need.update：作者改文/清日期/版本 CAS/非作者 forbidden', async () => {
    const st = makeStack('mama')
    const cr = await createNeed(st, { content: '原文-N3', targetDate: '2026-09-21' })
    const id = cr.data.need.needId
    const up1 = await st.call('mc-collab', { action: 'need.update', needId: id, content: '改后-N3', expectedRevision: 1, operationId: mkop() })
    assert.ok(up1.ok && up1.data.need.revision === 2 && up1.data.need.content === '改后-N3', `改文: ${JSON.stringify(up1).slice(0, 150)}`)
    const up2 = await st.call('mc-collab', { action: 'need.update', needId: id, targetDate: null, expectedRevision: 2, operationId: mkop() })
    assert.ok(up2.ok && up2.data.need.targetDate === null && up2.data.need.content === '改后-N3', '清日期保留正文')
    // 非作者矩阵：update/close/withdraw
    for (const action of ['need.update', 'need.close', 'need.withdraw']) {
      const ev = { needId: id, expectedRevision: 3, operationId: mkop(), ...(action === 'need.update' ? { content: '越权改' } : {}) }
      const prev = st.curMember.value; st.as('papa')
      const r = await st.call('mc-collab', { action, ...ev })
      st.as(prev)
      assert.ok(!r.ok && r.code === 'forbidden', `papa ${action} 须 forbidden（实得 ${r.code}）`)
    }
    // 版本冲突 / 空 changeset / 未知 ID
    const stale = await st.call('mc-collab', { action: 'need.update', needId: id, content: '陈旧', expectedRevision: 1, operationId: mkop() })
    assert.ok(!stale.ok && stale.code === 'revision-conflict', `陈旧版本须拒（实得 ${stale.code}）`)
    const empty = await st.call('mc-collab', { action: 'need.update', needId: id, expectedRevision: 3, operationId: mkop() })
    assert.ok(!empty.ok && empty.code === 'invalid-params', '空变更集须拒')
    const ghost = await st.call('mc-collab', { action: 'need.update', needId: 'need_0123456789abcdef', content: 'x', expectedRevision: 1, operationId: mkop() })
    assert.ok(!ghost.ok && ghost.code === 'not-found', '未知 needId 须 not-found')
  })

  await scenario('N4 need.close：关闭后正文保留可见、编辑/再关拒绝', async () => {
    const st = makeStack('mama')
    const cr = await createNeed(st, { content: '结束后可见-N4' })
    const id = cr.data.need.needId
    const close = await st.call('mc-collab', { action: 'need.close', needId: id, expectedRevision: 1, operationId: mkop() })
    assert.ok(close.ok && close.data.need.status === 'closed' && Number.isInteger(close.data.need.closedAt), `close: ${JSON.stringify(close).slice(0, 150)}`)
    assert.equal(close.data.need.content, '结束后可见-N4', 'close 不抹正文（区别于 withdraw）')
    const upd = await st.call('mc-collab', { action: 'need.update', needId: id, content: 'x', expectedRevision: 2, operationId: mkop() })
    assert.ok(!upd.ok && upd.code === 'invalid-state', `closed 编辑须拒（实得 ${upd.code}）`)
    const close2 = await st.call('mc-collab', { action: 'need.close', needId: id, expectedRevision: 2, operationId: mkop() })
    assert.ok(!close2.ok && close2.code === 'invalid-state', '重复 close 须拒（幂等走 operationId 重放）')
    const lst = await st.call('mc-collab', { action: 'need.list', status: 'closed' })
    assert.ok(lst.ok && lst.data.needs.some(x => x.needId === id && x.content === '结束后可见-N4'), 'closed 正文列表可见')
    // closed 仍可撤回（作者隐私权——墓碑单调）
    const wd = await st.call('mc-collab', { action: 'need.withdraw', needId: id, expectedRevision: 2, operationId: mkop() })
    assert.ok(wd.ok && wd.data.need.status === 'withdrawn' && wd.data.need.content === null, 'closed→withdrawn 允许且抹正文')
  })

  await scenario('N5 need.withdraw 单调墓碑：物理抹除+全库零泄漏+重放不复活', async () => {
    const st = makeStack('mama')
    const canary = '私人短句CANARY-N5-勿泄'
    const createOp = mkop('n5c')
    const cr = await createNeed(st, { content: canary, op: createOp })
    const id = cr.data.need.needId
    const wdOp = mkop('n5w')
    const wd = await st.call('mc-collab', { action: 'need.withdraw', needId: id, expectedRevision: 1, operationId: wdOp })
    assert.ok(wd.ok, `withdraw: ${JSON.stringify(wd).slice(0, 150)}`)
    assert.equal(wd.data.need.status, 'withdrawn')
    assert.equal(wd.data.need.content, null, '响应 content=null')
    assert.ok(Number.isInteger(wd.data.need.withdrawnAt), 'withdrawnAt 落盘')
    // 白盒：磁盘正文物理抹除
    const doc = needDoc(st, id)
    assert.ok(doc.content === null, `磁盘 content 物理置 null（实得 ${JSON.stringify(doc.content)}）`)
    assert.ok(doc.ownerId === 'mama' && Number.isInteger(doc.revision), '墓碑保留 ID/版本/作者（供同步清理）')
    // 全库 canary 扫描（含 mc_operations 回执）
    assertNoCanary(st, canary, '撤回后')
    // 单调性：编辑/再撤回（新 opId）均拒
    const upd = await st.call('mc-collab', { action: 'need.update', needId: id, content: '复活尝试', expectedRevision: 2, operationId: mkop() })
    assert.ok(!upd.ok && upd.code === 'invalid-state', `墓碑编辑须拒（实得 ${upd.code}）`)
    const wd2 = await st.call('mc-collab', { action: 'need.withdraw', needId: id, expectedRevision: 2, operationId: mkop() })
    assert.ok(!wd2.ok && wd2.code === 'invalid-state', '重复 withdraw（新 opId）须拒')
    // 撤回重放（同 opId 同参）：ok + 当前墓碑视图
    const wdReplay = await st.call('mc-collab', { action: 'need.withdraw', needId: id, expectedRevision: 1, operationId: wdOp })
    assert.ok(wdReplay.ok && wdReplay.data.replayed === true && wdReplay.data.need.content === null, `撤回重放=墓碑视图（实得 ${JSON.stringify(wdReplay).slice(0, 120)}）`)
    // 旧创建重放（同 opId 同参）：replayed + 墓碑视图——绝不恢复原文（评审 §2）
    const crReplay = await st.call('mc-collab', { action: 'need.create', content: canary, operationId: createOp })
    assert.ok(crReplay.ok && crReplay.data.replayed === true && crReplay.data.need.content === null && crReplay.data.need.status === 'withdrawn',
      `旧创建重放须返回当前墓碑视图（实得 ${JSON.stringify(crReplay).slice(0, 160)}）`)
    // 同 opId 异内容（改体重放）→ 拒
    const crConflict = await st.call('mc-collab', { action: 'need.create', content: '改体内容', operationId: createOp })
    assert.ok(!crConflict.ok && crConflict.code === 'operation-id-conflict', `改体重放须拒（实得 ${crConflict.code}）`)
    assertNoCanary(st, canary, '重放后')
  })

  await scenario('N6 need.create 幂等：同参重放同 needId；异参拒绝', async () => {
    const st = makeStack('mama')
    const op = mkop('n6')
    const r1 = await st.call('mc-collab', { action: 'need.create', content: '幂等正文', targetDate: '2026-10-01', operationId: op })
    const r2 = await st.call('mc-collab', { action: 'need.create', content: '幂等正文', targetDate: '2026-10-01', operationId: op })
    assert.ok(r1.ok && r2.ok && r2.data.replayed === true, '同参重放 ok')
    assert.equal(r2.data.need.needId, r1.data.need.needId, '重放返回同一 needId')
    assert.equal(needDocs(st).length, 1, '磁盘恰一份（不重复创建）')
    const r3 = await st.call('mc-collab', { action: 'need.create', content: '幂等正文改', targetDate: '2026-10-01', operationId: op })
    assert.ok(!r3.ok && r3.code === 'operation-id-conflict', `异参同 opId 须拒（实得 ${r3.code}）`)
  })

  await scenario('N7 need.list：家庭互通投影+撤回脱敏+状态过滤+稳定分页', async () => {
    const st = makeStack('mama')
    const canary = 'CANARY-N7-撤回我'
    const ids = []
    for (let i = 0; i < 3; i++) ids.push((await createNeed(st, { content: `mama-分享-${i}` })).data.need.needId)
    for (let i = 0; i < 2; i++) ids.push((await createNeed(st, { content: `papa-分享-${i}` }, 'papa')).data.need.needId)
    const c7 = (await createNeed(st, { content: canary })).data.need.needId
    // 家庭互通：papa 视角看到 mama 的分享
    st.as('papa')
    const lst = await st.call('mc-collab', { action: 'need.list' })
    assert.ok(lst.ok && lst.data.needs.length === 6, `家庭列表 6 项（实得 ${lst.data.needs.length}）`)
    assert.ok(lst.data.needs.every(x => x.ownerId === 'mama' || x.ownerId === 'papa'), '双方分享互通可见')
    // 撤回：列表含墓碑项且 content=null；active 过滤排除
    st.as('mama')
    await st.call('mc-collab', { action: 'need.withdraw', needId: c7, expectedRevision: 1, operationId: mkop() })
    const lst2 = await st.call('mc-collab', { action: 'need.list' })
    const tomb = lst2.data.needs.find(x => x.needId === c7)
    assert.ok(tomb && tomb.status === 'withdrawn' && tomb.content === null, `墓碑项 content 严格 null（实得 ${JSON.stringify(tomb)}）`)
    const activeOnly = await st.call('mc-collab', { action: 'need.list', status: 'active' })
    assert.equal(activeOnly.data.needs.length, 5, 'active 过滤 5 项')
    assert.ok(!JSON.stringify(lst2).includes(canary), '整列表响应零 canary')
    // 分页：limit=2 → 3 页无重无漏；sortKey 全局唯一（同毫秒创建不塌序）
    const seen = []
    let cursor = null
    for (let p = 0; p < 5; p++) {
      const r = await st.call('mc-collab', { action: 'need.list', limit: 2, ...(cursor ? { cursor } : {}) })
      assert.ok(r.ok, `页 ${p}: ${JSON.stringify(r).slice(0, 120)}`)
      seen.push(...r.data.needs.map(x => x.needId))
      if (!r.data.hasMore) break
      cursor = r.data.nextCursor
    }
    assert.equal(seen.length, 6, `3 页合计 6（实得 ${seen.length}）`)
    assert.equal(new Set(seen).size, 6, '无重复')
    const allIds = new Set([...needDocs(st).map(d => d._id)])
    for (const x of seen) assert.ok(allIds.has(x), `不漏（${x}）`)
    const sortKeys = needDocs(st).map(d => d.sortKey)
    assert.equal(new Set(sortKeys).size, sortKeys.length, 'sortKey 唯一（同毫秒不塌序）')
  })

  await scenario('T1 task.accept（need）：确定性 ID+动态投影+不持久复制正文', async () => {
    const st = makeStack('mama')
    const canary = 'CANARY-T1-接下我'
    const need = (await createNeed(st, { content: canary, targetDate: '2026-09-25' })).data.need
    st.as('papa')
    const ac = await st.call('mc-collab', { action: 'task.accept', sourceType: 'need', sourceId: need.needId, operationId: mkop() })
    assert.ok(ac.ok, `accept: ${JSON.stringify(ac).slice(0, 200)}`)
    const t = ac.data.task
    assert.equal(t.taskId, `tsk_${TEST_ENV.MC_FAMILY_ID}_need_${need.needId}`, `确定性 ID 精确（实得 ${t.taskId}）`)
    assert.equal(t.sourceType, 'need'); assert.equal(t.sourceId, need.needId)
    assert.equal(t.title, canary, 'title=当前 active 分享动态投影')
    assert.equal(t.status, 'doing'); assert.equal(t.acceptedBy, 'papa')
    assert.ok(Number.isInteger(t.acceptedAt), 'acceptedAt 落盘')
    // 白盒：任务文档不持久复制正文
    const doc = taskDocOf(st, t.taskId)
    assert.ok(doc && doc.title === null, `任务 title 恒 null（实得 ${JSON.stringify(doc && doc.title)}）——不持久复制分享正文`)
    assert.equal(doc.sourceType, 'need') && assert.equal(doc.familyId, TEST_ENV.MC_FAMILY_ID)
    assert.ok(!JSON.stringify(doc).includes(canary), '任务文档零 canary')
    assert.equal(t.targetDate, '2026-09-25', 'need.targetDate 随任务带入（非正文——可复制）')
  })

  await scenario('T2 task.accept 幂等/重复/并发收敛：单源唯一任务', async () => {
    const st = makeStack('mama')
    const need = (await createNeed(st, { content: 'T2-分享' })).data.need
    const op1 = mkop('t2a')
    st.as('papa')
    const a1 = await st.call('mc-collab', { action: 'task.accept', sourceType: 'need', sourceId: need.needId, operationId: op1 })
    assert.ok(a1.ok, '首次接下')
    const a2 = await st.call('mc-collab', { action: 'task.accept', sourceType: 'need', sourceId: need.needId, operationId: op1 })
    assert.ok(a2.ok && a2.data.replayed === true && a2.data.task.taskId === a1.data.task.taskId, '同 opId 重放=同一任务')
    // 另一成员携不同 opId 再接：existed 幂等返回，不改既有承接人
    st.as('mama')
    const a3 = await st.call('mc-collab', { action: 'task.accept', sourceType: 'need', sourceId: need.needId, operationId: mkop('t2b') })
    assert.ok(a3.ok && a3.data.existed === true && a3.data.task.taskId === a1.data.task.taskId, `异 opId 重复接=同一任务（实得 ${JSON.stringify(a3).slice(0, 120)}）`)
    assert.equal(a3.data.task.acceptedBy, 'papa', '承接人不被后来者覆盖')
    assert.equal(taskDocs(st).length, 1, '磁盘恰一份任务')
    // 真并发（commit barrier）：两成员同时接同一分享——恰一任务落盘，败者重试收敛
    const need2 = (await createNeed(st, { content: 'T2-并发分享' })).data.need
    const barrier = { count: 0, target: 2, resolve: null, promise: null }
    barrier.promise = Promise.race([
      new Promise(r2 => { barrier.resolve = r2 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('T2 barrier 超时')), 5000)),
    ])
    const origDb = st.cloud.database.bind(st.cloud)
    st.cloud.database = () => {
      const dbx = origDb()
      const origStartTx = dbx.startTransaction.bind(dbx)
      dbx.startTransaction = async () => {
        const tx = await origStartTx()
        const origCommit = tx.commit.bind(tx)
        tx.commit = async () => {
          barrier.count++
          if (barrier.count >= barrier.target) barrier.resolve()
          await barrier.promise
          return origCommit()
        }
        return tx
      }
      return dbx
    }
    const evB = op => ({ action: 'task.accept', sourceType: 'need', sourceId: need2.needId, operationId: op })
    st.as('papa')
    const pA = st.call('mc-collab', evB(mkop('t2c')))
    st.as('mama')
    const pB = st.call('mc-collab', evB(mkop('t2d')))
    const [rA, rB] = await Promise.all([pA, pB])
    st.cloud.database = origDb
    assert.ok(barrier.count >= 2, `两请求都进入 commit barrier（count=${barrier.count}）`)
    const outcomes = [rA, rB]
    const succ = outcomes.filter(r => r.ok)
    const txf = outcomes.filter(r => !r.ok && r.code === 'transaction-failed')
    assert.equal(succ.length + txf.length, 2, `结局必为 成功|事务冲突（实得 ${outcomes.map(r => r.code).join(',')}）`)
    assert.equal(taskDocs(st).filter(d => d.sourceId === need2.needId).length, 1, `并发后恰一份任务（实得 ${taskDocs(st).filter(d => d.sourceId === need2.needId).length}）`)
    const winnerId = succ.length ? succ[0].data.task.taskId : null
    if (winnerId) assert.equal(winnerId, `tsk_${TEST_ENV.MC_FAMILY_ID}_need_${need2.needId}`)
    // 败者重试（任意一侧再 accept 同源）→ 收敛同一确定性任务
    st.as('papa')
    const conv = await st.call('mc-collab', { action: 'task.accept', sourceType: 'need', sourceId: need2.needId, operationId: mkop('t2e') })
    assert.ok(conv.ok && conv.data.task.taskId === `tsk_${TEST_ENV.MC_FAMILY_ID}_need_${need2.needId}`, `重试收敛确定性 ID（实得 ${JSON.stringify(conv).slice(0, 120)}）`)
    assert.equal(taskDocs(st).filter(d => d.sourceId === need2.needId).length, 1, '收敛后仍恰一份')
  })

  await scenario('T3 task.accept 前置门：撤回/关闭/未知来源/非法类型', async () => {
    const st = makeStack('mama')
    const wNeed = (await createNeed(st, { content: 'T3-将被撤回' })).data.need
    await st.call('mc-collab', { action: 'need.withdraw', needId: wNeed.needId, expectedRevision: 1, operationId: mkop() })
    const cNeed = (await createNeed(st, { content: 'T3-将被关闭' })).data.need
    await st.call('mc-collab', { action: 'need.close', needId: cNeed.needId, expectedRevision: 1, operationId: mkop() })
    st.as('papa')
    const w = await st.call('mc-collab', { action: 'task.accept', sourceType: 'need', sourceId: wNeed.needId, operationId: mkop() })
    assert.ok(!w.ok && w.code === 'need-withdrawn', `撤回分享接下须拒（实得 ${w.code}）`)
    const c = await st.call('mc-collab', { action: 'task.accept', sourceType: 'need', sourceId: cNeed.needId, operationId: mkop() })
    assert.ok(!c.ok && c.code === 'need-not-active', `关闭分享接下须拒（实得 ${c.code}）`)
    const g = await st.call('mc-collab', { action: 'task.accept', sourceType: 'need', sourceId: 'need_ffffffffffffffff', operationId: mkop() })
    assert.ok(!g.ok && g.code === 'not-found', '未知分享 not-found')
    const bad = await st.call('mc-collab', { action: 'task.accept', sourceType: 'mood', sourceId: 'x', operationId: mkop() })
    assert.ok(!bad.ok && bad.code === 'invalid-params', `非法 sourceType（实得 ${bad.code}）`)
    const cu = await st.call('mc-collab', { action: 'task.accept', sourceType: 'custom', sourceId: 'cst_0123456789abcdef', operationId: mkop() })
    assert.ok(!cu.ok && cu.code === 'source-not-found', `custom 凭空接下须拒（实得 ${cu.code}）`)
    assert.equal(taskDocs(st).length, 0, '全部拒绝零任务落盘')
  })

  await scenario('T4 need.withdraw→task 联动：同事务取消+投影脱敏+防复活', async () => {
    const st = makeStack('mama')
    const canary = 'CANARY-T4-联动撤回'
    const need = (await createNeed(st, { content: canary })).data.need
    st.as('papa')
    const ac = await st.call('mc-collab', { action: 'task.accept', sourceType: 'need', sourceId: need.needId, operationId: mkop() })
    assert.ok(ac.ok && ac.data.task.status === 'doing')
    const taskId = ac.data.task.taskId
    st.as('mama')
    const wd = await st.call('mc-collab', { action: 'need.withdraw', needId: need.needId, expectedRevision: 1, operationId: mkop() })
    assert.ok(wd.ok, `withdraw: ${JSON.stringify(wd).slice(0, 150)}`)
    assert.ok(wd.data.task && wd.data.task.taskId === taskId && wd.data.task.status === 'cancelled', '响应含联动取消的任务')
    assert.equal(wd.data.task.title, '（分享已撤回）', '联动任务标题脱敏')
    // 白盒：任务文档 cancelled；标题不存正文（本就 null）
    const tdoc = taskDocOf(st, taskId)
    assert.equal(tdoc.status, 'cancelled', '任务同事务转 cancelled')
    // task.list：masked 标题+needStatus=withdrawn；全响应零 canary
    const tl = await st.call('mc-collab', { action: 'task.list' })
    const row = tl.data.tasks.find(x => x.taskId === taskId)
    assert.ok(row && row.title === '（分享已撤回）' && row.needStatus === 'withdrawn' && row.status === 'cancelled', `列表投影脱敏（实得 ${JSON.stringify(row)}）`)
    assert.ok(!JSON.stringify(tl).includes(canary), 'task.list 零 canary')
    assertNoCanary(st, canary, '联动撤回后')
    // 防复活：cancelled 任务改非 cancelled 状态须拒（need-withdrawn——墓碑优先）
    st.as('papa')
    const rev = await st.call('mc-collab', { action: 'task.updateStatus', taskId, status: 'doing', expectedRevision: tdoc.revision, operationId: mkop() })
    assert.ok(!rev.ok && rev.code === 'need-withdrawn', `撤回任务复活须拒（实得 ${rev.code}）`)
    // 撤回无任务的分享：不产生任务残留（作者本人上下文）
    st.as('mama')
    const lone = (await createNeed(st, { content: 'T4-无任务撤回' })).data.need
    const wd2 = await st.call('mc-collab', { action: 'need.withdraw', needId: lone.needId, expectedRevision: 1, operationId: mkop() })
    assert.ok(wd2.ok && wd2.data.task === undefined, '无关联任务时不产生任务')
    assert.ok(!taskDocs(st).some(d => d.sourceId === lone.needId), '零任务残留')
  })

  await scenario('T5 task.createCustom+updateStatus：全状态流转+校验', async () => {
    const st = makeStack('mama')
    const bad1 = await st.call('mc-collab', { action: 'task.createCustom', title: '', operationId: mkop() })
    assert.ok(!bad1.ok && bad1.code === 'invalid-params', '空标题拒')
    const bad2 = await st.call('mc-collab', { action: 'task.createCustom', title: 'x'.repeat(101), operationId: mkop() })
    assert.ok(!bad2.ok && bad2.code === 'invalid-params', '101 字标题拒')
    const bad3 = await st.call('mc-collab', { action: 'task.createCustom', title: '合规', assigneeId: 'stranger', operationId: mkop() })
    assert.ok(!bad3.ok && bad3.code === 'invalid-params', '非成员 assigneeId 拒')
    const op = mkop('t5')
    const cr = await st.call('mc-collab', { action: 'task.createCustom', title: '一起去产检班', targetDate: '2026-09-30', assigneeId: 'papa', operationId: op })
    assert.ok(cr.ok, `createCustom: ${JSON.stringify(cr).slice(0, 200)}`)
    const t = cr.data.task
    assert.equal(t.status, 'pending'); assert.equal(t.title, '一起去产检班')
    assert.equal(t.assigneeId, 'papa'); assert.equal(t.sourceType, 'custom')
    assert.match(t.sourceId, /^cst_[0-9a-f]{16}$/, 'custom sourceId 服务端生成')
    assert.equal(t.taskId, `tsk_${TEST_ENV.MC_FAMILY_ID}_custom_${t.sourceId}`)
    // 重放：同 opId 同参 → 同一任务
    const cr2 = await st.call('mc-collab', { action: 'task.createCustom', title: '一起去产检班', targetDate: '2026-09-30', assigneeId: 'papa', operationId: op })
    assert.ok(cr2.ok && cr2.data.replayed === true && cr2.data.task.taskId === t.taskId, '重放=同一任务')
    // 流转：pending→doing→done→doing→cancelled（撤销完成清 completed）
    const s1 = await st.call('mc-collab', { action: 'task.updateStatus', taskId: t.taskId, status: 'doing', expectedRevision: 1, operationId: mkop() })
    assert.ok(s1.ok && s1.data.task.status === 'doing' && s1.data.task.revision === 2)
    const s2 = await st.call('mc-collab', { action: 'task.updateStatus', taskId: t.taskId, status: 'done', expectedRevision: 2, operationId: mkop() })
    assert.ok(s2.ok && s2.data.task.status === 'done' && s2.data.task.completedBy === 'mama' && Number.isInteger(s2.data.task.completedAt), '完成记录操作者与时间')
    const s3 = await st.call('mc-collab', { action: 'task.updateStatus', taskId: t.taskId, status: 'doing', expectedRevision: 3, operationId: mkop() })
    assert.ok(s3.ok && s3.data.task.status === 'doing' && s3.data.task.completedBy === null && s3.data.task.completedAt === null, '撤销完成清 completed')
    // 校验：非法状态值/非法流转/陈旧版本/未知任务
    const bv = await st.call('mc-collab', { action: 'task.updateStatus', taskId: t.taskId, status: 'paused', expectedRevision: 4, operationId: mkop() })
    assert.ok(!bv.ok && bv.code === 'invalid-params', '非法状态值拒')
    const bt = await st.call('mc-collab', { action: 'task.updateStatus', taskId: t.taskId, status: 'doing', expectedRevision: 4, operationId: mkop() })
    assert.ok(!bt.ok && bt.code === 'invalid-transition', `同态 doing→doing 须拒（实得 ${bt.code}——幂等走 operationId 重放非状态重写）`)
    const stale = await st.call('mc-collab', { action: 'task.updateStatus', taskId: t.taskId, status: 'pending', expectedRevision: 1, operationId: mkop() })
    assert.ok(!stale.ok && stale.code === 'revision-conflict', '陈旧版本拒')
    const ghost = await st.call('mc-collab', { action: 'task.updateStatus', taskId: 'tsk_x_custom_ghost', status: 'doing', expectedRevision: 1, operationId: mkop() })
    assert.ok(!ghost.ok && ghost.code === 'not-found', '未知任务 not-found')
    // cancelled 落定（rev 4→5）+ 幂等重放 + 改体重放拒 + 终态后再转须 invalid-transition
    const s4op = mkop('t5s4')
    const s4b = await st.call('mc-collab', { action: 'task.updateStatus', taskId: t.taskId, status: 'cancelled', expectedRevision: 4, operationId: s4op })
    assert.ok(s4b.ok && s4b.data.task.status === 'cancelled' && s4b.data.task.revision === 5, `cancelled 落定（实得 ${JSON.stringify(s4b).slice(0, 120)}）`)
    const s4r = await st.call('mc-collab', { action: 'task.updateStatus', taskId: t.taskId, status: 'cancelled', expectedRevision: 4, operationId: s4op })
    assert.ok(s4r.ok && s4r.data.replayed === true && s4r.data.task.status === 'cancelled', `状态更新重放幂等（实得 ${JSON.stringify(s4r).slice(0, 120)}）`)
    const s4c = await st.call('mc-collab', { action: 'task.updateStatus', taskId: t.taskId, status: 'done', expectedRevision: 4, operationId: s4op })
    assert.ok(!s4c.ok && s4c.code === 'operation-id-conflict', 'updateStatus 改体重放拒')
    const s4d = await st.call('mc-collab', { action: 'task.updateStatus', taskId: t.taskId, status: 'done', expectedRevision: 5, operationId: mkop() })
    assert.ok(!s4d.ok && s4d.code === 'invalid-transition', `cancelled→done 须拒（实得 ${s4d.code}）`)
  })

  await scenario('T6 权威联动 checkup：done 同步 mc_checkups；权威侧独立变更投影一致', async () => {
    const st = makeStack('mama')
    const chk = await st.call('mc-schedule', { action: 'checkup.upsert', schemaVersion: 1, operationId: mkop('chk'), expectedRevision: 0, id: 'chk_c1', payload: { dateKey: '2026-09-22', hospital: '市一院' } })
    assert.ok(chk.ok, `checkup 种子: ${JSON.stringify(chk).slice(0, 120)}`)
    const chkRev1 = st.cloud.__docs.get('mc_checkups/chk_c1').revision
    st.as('papa')
    const ac = await st.call('mc-collab', { action: 'task.accept', sourceType: 'checkup', sourceId: 'chk_c1', operationId: mkop() })
    assert.ok(ac.ok, `accept checkup: ${JSON.stringify(ac).slice(0, 150)}`)
    assert.equal(ac.data.task.taskId, `tsk_${TEST_ENV.MC_FAMILY_ID}_checkup_chk_c1`, '确定性 ID（checkup 来源）')
    assert.equal(ac.data.task.targetDate, '2026-09-22', '产检 dateKey 带入任务')
    const done = await st.call('mc-collab', { action: 'task.updateStatus', taskId: ac.data.task.taskId, status: 'done', expectedRevision: 1, operationId: mkop() })
    assert.ok(done.ok && done.data.task.status === 'done', '任务完成')
    const chkDoc = st.cloud.__docs.get('mc_checkups/chk_c1')
    assert.equal(chkDoc.status, 'completed', `权威表同事务同步 completed（实得 ${chkDoc.status}）`)
    assert.equal(chkDoc.revision, chkRev1 + 1, '权威表 revision 递增')
    // 撤销完成 → 权威回 pending
    const undone = await st.call('mc-collab', { action: 'task.updateStatus', taskId: ac.data.task.taskId, status: 'doing', expectedRevision: 2, operationId: mkop() })
    assert.ok(undone.ok, '撤销完成')
    assert.equal(st.cloud.__docs.get('mc_checkups/chk_c1').status, 'pending', '权威回 pending——单权威源不分裂')
    // 反向：mc-schedule 独立改权威 → task.list 投影如实（不形成第二份进度）
    const chg = await st.call('mc-schedule', { action: 'checkup.upsert', schemaVersion: 1, operationId: mkop(), expectedRevision: st.cloud.__docs.get('mc_checkups/chk_c1').revision, id: 'chk_c1', status: 'completed' })
    assert.ok(chg.ok, `权威侧直接完成: ${JSON.stringify(chg).slice(0, 120)}`)
    const tl = await st.call('mc-collab', { action: 'task.list' })
    const row = tl.data.tasks.find(x => x.taskId === ac.data.task.taskId)
    assert.ok(row && row.status === 'done', `权威侧完成后任务投影 done（实得 ${row && row.status}——存储态未改但显示以权威为准）`)
    // skipped → 投影 cancelled
    const sk = await st.call('mc-schedule', { action: 'checkup.upsert', schemaVersion: 1, operationId: mkop(), expectedRevision: st.cloud.__docs.get('mc_checkups/chk_c1').revision, id: 'chk_c1', status: 'skipped' })
    assert.ok(sk.ok, '权威侧跳过')
    const tl2 = await st.call('mc-collab', { action: 'task.list' })
    const row2 = tl2.data.tasks.find(x => x.taskId === ac.data.task.taskId)
    assert.equal(row2.status, 'cancelled', 'skipped 投影 cancelled')
    // 未完成时权威侧不动（cancelled 不碰权威）
    const before = JSON.stringify(st.cloud.__docs.get('mc_checkups/chk_c1'))
    const cx = await st.call('mc-collab', { action: 'task.updateStatus', taskId: ac.data.task.taskId, status: 'cancelled', expectedRevision: st.cloud.__docs.get(`mc_family_tasks/${ac.data.task.taskId}`).revision, operationId: mkop() })
    assert.ok(cx.ok, '任务取消')
    assert.equal(JSON.stringify(st.cloud.__docs.get('mc_checkups/chk_c1')), before, 'cancelled 不篡改权威表')
  })

  await scenario('T7 权威联动 bag：done⇄prepared 同步+反向投影', async () => {
    const st = makeStack('mama')
    const bg = await st.call('mc-schedule', { action: 'bag.upsert', schemaVersion: 1, operationId: mkop('bag'), expectedRevision: 0, id: 'bag_c1', payload: { name: '产妇卫生物品', category: 'mom', quantity: 2 } })
    assert.ok(bg.ok, `bag 种子: ${JSON.stringify(bg).slice(0, 120)}`)
    st.as('papa')
    const ac = await st.call('mc-collab', { action: 'task.accept', sourceType: 'bag', sourceId: 'bag_c1', operationId: mkop() })
    assert.ok(ac.ok && ac.data.task.taskId === `tsk_${TEST_ENV.MC_FAMILY_ID}_bag_bag_c1`, 'accept bag + 确定性 ID')
    const done = await st.call('mc-collab', { action: 'task.updateStatus', taskId: ac.data.task.taskId, status: 'done', expectedRevision: 1, operationId: mkop() })
    assert.ok(done.ok)
    assert.equal(st.cloud.__docs.get('mc_bag_items/bag_c1').prepared, true, 'done → 权威 prepared=true')
    const undone = await st.call('mc-collab', { action: 'task.updateStatus', taskId: ac.data.task.taskId, status: 'doing', expectedRevision: 2, operationId: mkop() })
    assert.ok(undone.ok)
    assert.equal(st.cloud.__docs.get('mc_bag_items/bag_c1').prepared, false, '撤销完成 → prepared=false')
    // 反向投影：mc-schedule 直接 prepared=true → task.list done
    const pv = await st.call('mc-schedule', { action: 'bag.upsert', schemaVersion: 1, operationId: mkop(), expectedRevision: st.cloud.__docs.get('mc_bag_items/bag_c1').revision, id: 'bag_c1', payload: { prepared: true } })
    assert.ok(pv.ok, `权威侧直接备好: ${JSON.stringify(pv).slice(0, 120)}`)
    const tl = await st.call('mc-collab', { action: 'task.list' })
    const row = tl.data.tasks.find(x => x.taskId === ac.data.task.taskId)
    assert.equal(row.status, 'done', '权威 prepared=true → 任务投影 done')
  })

  await scenario('T8 task.list 混合投影+过滤+分页', async () => {
    const st = makeStack('mama')
    const activeNeed = (await createNeed(st, { content: 'T8-活跃分享' })).data.need
    const wdNeed = (await createNeed(st, { content: 'T8-将撤回' })).data.need
    st.as('papa')
    await st.call('mc-collab', { action: 'task.accept', sourceType: 'need', sourceId: activeNeed.needId, operationId: mkop() })
    await st.call('mc-collab', { action: 'task.accept', sourceType: 'need', sourceId: wdNeed.needId, operationId: mkop() })
    st.as('mama')
    const custom = (await st.call('mc-collab', { action: 'task.createCustom', title: 'T8-自定义任务', assigneeId: 'papa', operationId: mkop() })).data.task
    await st.call('mc-schedule', { action: 'checkup.upsert', schemaVersion: 1, operationId: mkop(), expectedRevision: 0, id: 'chk_t8', payload: { dateKey: '2026-10-05' } })
    st.as('papa')
    const chkTask = (await st.call('mc-collab', { action: 'task.accept', sourceType: 'checkup', sourceId: 'chk_t8', operationId: mkop() })).data.task
    st.as('mama')
    await st.call('mc-collab', { action: 'need.withdraw', needId: wdNeed.needId, expectedRevision: 1, operationId: mkop() })
    // 混合投影
    const tl = await st.call('mc-collab', { action: 'task.list' })
    assert.equal(tl.data.tasks.length, 4, `4 项任务（实得 ${tl.data.tasks.length}）`)
    const byId = Object.fromEntries(tl.data.tasks.map(x => [x.taskId, x]))
    const a = byId[`tsk_${TEST_ENV.MC_FAMILY_ID}_need_${activeNeed.needId}`]
    assert.equal(a.title, 'T8-活跃分享') && assert.equal(a.needStatus, 'active')
    const w = byId[`tsk_${TEST_ENV.MC_FAMILY_ID}_need_${wdNeed.needId}`]
    assert.equal(w.title, '（分享已撤回）') && assert.equal(w.status, 'cancelled')
    assert.equal(byId[custom.taskId].title, 'T8-自定义任务')
    assert.equal(byId[chkTask.taskId].title, null, 'checkup 任务无标题（权威实体自身承载）')
    // 过滤：status=cancelled；assigneeId=papa
    const cx = await st.call('mc-collab', { action: 'task.list', status: 'cancelled' })
    assert.ok(cx.data.tasks.length >= 1 && cx.data.tasks.every(x => x.status === 'cancelled'), 'cancelled 过滤')
    const asg = await st.call('mc-collab', { action: 'task.list', assigneeId: 'papa' })
    assert.ok(asg.data.tasks.length === 1 && asg.data.tasks[0].taskId === custom.taskId, `assignee 过滤恰自定义任务（实得 ${asg.data.tasks.map(x => x.taskId)}）`)
    const badAsg = await st.call('mc-collab', { action: 'task.list', assigneeId: 'stranger' })
    assert.ok(!badAsg.ok && badAsg.code === 'invalid-params', '非成员 assignee 过滤拒')
    // 分页 limit=2 → 2 页无重无漏
    const seen = []
    let cursor = null
    for (let p = 0; p < 5; p++) {
      const r = await st.call('mc-collab', { action: 'task.list', limit: 2, ...(cursor ? { cursor } : {}) })
      seen.push(...r.data.tasks.map(x => x.taskId))
      if (!r.data.hasMore) break
      cursor = r.data.nextCursor
    }
    assert.equal(seen.length, 4) && assert.equal(new Set(seen).size, 4, '分页无重无漏')
  })

  await scenario('X1 第三身份：全部 9 action 100% 拒绝+零写', async () => {
    const st = makeStack('mama')
    const need = (await createNeed(st, { content: 'X1-分享' })).data.need
    st.as('papa')
    const task = (await st.call('mc-collab', { action: 'task.accept', sourceType: 'need', sourceId: need.needId, operationId: mkop() })).data.task
    st.as('mama')
    const before = docCount(st)
    const beforeJson = JSON.stringify([...st.cloud.__docs.entries()].map(([k, v]) => [k, v.__v]))
    st.as(TEST_ENV.MC_INTRUDER_OPENID)
    const probes = [
      ['need.create', { action: 'need.create', content: '入侵者分享', operationId: mkop() }],
      ['need.update', { action: 'need.update', needId: need.needId, content: '入侵者改', expectedRevision: 1, operationId: mkop() }],
      ['need.withdraw', { action: 'need.withdraw', needId: need.needId, expectedRevision: 1, operationId: mkop() }],
      ['need.close', { action: 'need.close', needId: need.needId, expectedRevision: 1, operationId: mkop() }],
      ['need.list', { action: 'need.list' }],
      ['task.accept', { action: 'task.accept', sourceType: 'need', sourceId: need.needId, operationId: mkop() }],
      ['task.updateStatus', { action: 'task.updateStatus', taskId: task.taskId, status: 'done', expectedRevision: 1, operationId: mkop() }],
      ['task.createCustom', { action: 'task.createCustom', title: '入侵者任务', operationId: mkop() }],
      ['task.list', { action: 'task.list' }],
    ]
    for (const [label, ev] of probes) {
      const r = await st.call('mc-collab', ev)
      assert.ok(!r.ok && r.code === 'not-family-member', `${label} 第三身份须拒（实得 ${r.code}）`)
    }
    assert.equal(docCount(st), before, '零新文档')
    assert.equal(JSON.stringify([...st.cloud.__docs.entries()].map(([k, v]) => [k, v.__v])), beforeJson, '零版本写（__v 全不变）')
  })

  await scenario('X2 跨家庭隔离：列表空/实体 not-found/数据零泄漏', async () => {
    const st = makeStack('mama')
    const canary = 'CANARY-X2-跨家庭'
    const need = (await createNeed(st, { content: canary })).data.need
    st.as('papa')
    const task = (await st.call('mc-collab', { action: 'task.accept', sourceType: 'need', sourceId: need.needId, operationId: mkop() })).data.task
    const origFam = process.env.MC_FAMILY_ID
    process.env.MC_FAMILY_ID = 'fam-other-xyz'
    try {
      const nl = await st.call('mc-collab', { action: 'need.list' })
      assert.ok(nl.ok && nl.data.needs.length === 0, '跨家庭 need.list 空')
      const tl = await st.call('mc-collab', { action: 'task.list' })
      assert.ok(tl.ok && tl.data.tasks.length === 0, '跨家庭 task.list 空')
      const upd = await st.call('mc-collab', { action: 'need.update', needId: need.needId, content: '越家庭改', expectedRevision: 1, operationId: mkop() })
      assert.ok(!upd.ok && upd.code === 'not-found', `跨家庭实体访问 not-found（实得 ${upd.code}）`)
      const wd = await st.call('mc-collab', { action: 'need.withdraw', needId: need.needId, expectedRevision: 1, operationId: mkop() })
      assert.ok(!wd.ok && wd.code === 'not-found', '跨家庭撤回 not-found')
      const ac = await st.call('mc-collab', { action: 'task.accept', sourceType: 'need', sourceId: need.needId, operationId: mkop() })
      assert.ok(!ac.ok && ac.code === 'not-found', '跨家庭接下 not-found')
      const us = await st.call('mc-collab', { action: 'task.updateStatus', taskId: task.taskId, status: 'done', expectedRevision: 1, operationId: mkop() })
      assert.ok(!us.ok && us.code === 'not-found', '跨家庭任务更新 not-found')
    } finally { process.env.MC_FAMILY_ID = origFam }
    // 家庭配置复原：数据完整
    const nl2 = await st.call('mc-collab', { action: 'need.list' })
    assert.ok(nl2.data.needs.length === 1 && nl2.data.needs[0].content === canary, '复原后数据完整')
  })

  await scenario('X3 operationId 命名空间：同 ID 异动作改体必拒', async () => {
    const st = makeStack('mama')
    const op = mkop('x3')
    const r1 = await st.call('mc-collab', { action: 'need.create', content: 'X3-第一动作', operationId: op })
    assert.ok(r1.ok, '第一动作')
    const need = r1.data.need
    const r2 = await st.call('mc-collab', { action: 'need.withdraw', needId: need.needId, expectedRevision: 1, operationId: op })
    assert.ok(!r2.ok && r2.code === 'operation-id-conflict', `同 opId 异动作（异摘要）须拒（实得 ${r2.code}）`)
    const r3 = await st.call('mc-collab', { action: 'task.accept', sourceType: 'need', sourceId: need.needId, operationId: op })
    assert.ok(!r3.ok && r3.code === 'operation-id-conflict', 'task.accept 同 opId 亦拒')
    assert.equal(need.status === undefined ? 'missing' : 'ok', 'ok')
    assert.equal(needDoc(st, need.needId).status, 'active', '拒绝路径零状态变更')
  })

  await scenario('T9 task.accept 首次接下已有未承接任务：记录真实承接人（Stage2 页面回归发现缺口）', async () => {
    const st = makeStack('mama')
    const cr = await st.call('mc-collab', { action: 'task.createCustom', title: 'T9-未指派任务', operationId: mkop('t9c') })
    assert.ok(cr.ok, 'createCustom（无 assignee）')
    const taskId = cr.data.task.taskId
    assert.equal(cr.data.task.status, 'pending')
    assert.equal(cr.data.task.acceptedBy, null)
    // papa 首次接下已有任务：acceptedBy/acceptedAt 落盘 + pending→doing + revision+1
    st.as('papa')
    const ac = await st.call('mc-collab', { action: 'task.accept', sourceType: 'custom', sourceId: cr.data.task.sourceId, operationId: mkop('t9a') })
    assert.ok(ac.ok, `首次接下: ${JSON.stringify(ac).slice(0, 150)}`)
    assert.equal(ac.data.task.taskId, taskId, '同一确定性任务')
    assert.equal(ac.data.task.acceptedBy, 'papa', '承接人=真实操作者')
    assert.ok(Number.isInteger(ac.data.task.acceptedAt), 'acceptedAt 落盘')
    assert.equal(ac.data.task.status, 'doing', 'pending→doing')
    assert.equal(ac.data.task.revision, 2, 'revision+1')
    const doc = taskDocOf(st, taskId)
    assert.equal(doc.acceptedBy, 'papa') && assert.equal(doc.status, 'doing')
    // 再接（他人/重复）：幂等返回不改既有承接人
    st.as('mama')
    const ac2 = await st.call('mc-collab', { action: 'task.accept', sourceType: 'custom', sourceId: cr.data.task.sourceId, operationId: mkop('t9b') })
    assert.ok(ac2.ok && ac2.data.existed === true && ac2.data.task.acceptedBy === 'papa', `重复接下不改承接人（实得 ${JSON.stringify(ac2.data).slice(0, 120)}）`)
    assert.equal(taskDocOf(st, taskId).revision, 2, '重复接下零版本推进')
  })

  await scenario('Z9 冻结源哈希：套件运行期间 mc-collab 源未被并发编辑', async () => {
    for (const [rel, h] of Object.entries(frozenHashes)) {
      const now = sha256(fs.readFileSync(path.join(root, rel)))
      assert.equal(now, h, `${rel} 运行期间被并发编辑（${h.slice(0, 8)}→${now.slice(0, 8)}）——结果作废须复跑`)
    }
  })

  console.log(`\n${passed} 通过, ${failed.length} 失败`)
  if (failed.length) { console.log('失败项：'); for (const f of failed) console.log(` - ${f}`); process.exit(1) }
  process.exit(0)
}

main().catch(e => { console.error('套件异常:', e); process.exit(2) })
