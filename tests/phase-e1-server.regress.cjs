// Phase E1 Step 1 服务端契约回归：mc-tools（胎动会话+宫缩记录）→ mock 云 CAS 事务 → 真实 mc-health 种日记录。
// 覆盖：胎动连击去重（≤5 分钟合并/边界 300000 与 300001）、误触撤销（插入序移除+重算）、
// 完成/废弃状态流转与可选 mc_health_daily.fetalCount 同事务累计联动（重放不双计/删除墓碑跳过）、
// 宫缩持续秒数与间隔秒数（含乱序补录前驱定位）、软废弃排除、operationId 幂等/异摘要拒绝、
// 非成员全入口零写、跨家庭隔离。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')

const HANDLER_REL = 'cloud/functions/mc-tools/index.js'
if (!fs.existsSync(path.join(root, HANDLER_REL))) {
  console.log('套件未运行：mc-tools handler 不存在（' + HANDLER_REL + '）')
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

const DIST = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-e1-')), 'cf')
for (const fn of ['mc-health', 'mc-tools']) {
  const dir = path.join(DIST, fn); fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(path.join(root, `cloud/functions/${fn}/index.js`), path.join(dir, 'index.js'))
  fs.cpSync(path.join(root, 'cloud/shared'), path.join(dir, 'shared'), { recursive: true })
}
const healthH = require(path.join(DIST, 'mc-health/index.js'))
const toolsH = require(path.join(DIST, 'mc-tools/index.js'))

// ── 冻结源哈希 ──
const FROZEN_RELS = ['cloud/functions/mc-tools/index.js', 'cloud/shared/auth.js', 'cloud/shared/config.js', 'cloud/shared/respond.js', 'cloud/shared/constants.js']
const frozenHashes = Object.fromEntries(FROZEN_RELS.map(rel => [rel, sha256(fs.readFileSync(path.join(root, rel)))]))
console.log('冻结源哈希（加载时快照）:')
for (const [rel, h] of Object.entries(frozenHashes)) console.log(`  ${h.slice(0, 8)}  ${rel}`)

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-e1', MC_MEMBER_MAMA_OPENID: 'oE1MAMA123456', MC_MEMBER_PAPA_OPENID: 'oE1PAPA123456', MC_INTRUDER_OPENID: 'oE1INTRUDER6666' }

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

function requireHandler(name) {
  delete require.cache[require.resolve(path.join(DIST, name, 'index.js'))]
  return require(path.join(DIST, name, 'index.js'))
}

function makeStack(member = 'mama') {
  const cloud = makeMockCloud()
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID
  cloud.__setCtx(member === 'mama' ? TEST_ENV.MC_MEMBER_MAMA_OPENID : member === 'papa' ? TEST_ENV.MC_MEMBER_PAPA_OPENID : member)
  // 每 stack 独立 handler 实例（同场景内嵌套 stack 互不抢绑 __setCloud——与 b3b 套件同款）
  const health = requireHandler('mc-health')
  const tools = requireHandler('mc-tools')
  health.__setCloud(cloud); tools.__setCloud(cloud)
  return {
    cloud,
    call: (fn, event) => fn === 'mc-health' ? health.main(event) : tools.main(event),
    as(m) { cloud.__setCtx(m === 'mama' ? TEST_ENV.MC_MEMBER_MAMA_OPENID : m === 'papa' ? TEST_ENV.MC_MEMBER_PAPA_OPENID : m) },
  }
}

// ── 白盒辅助 ──
const docCount = st => st.cloud.__docs.size
const versionSnapshot = st => JSON.stringify([...st.cloud.__docs.entries()].map(([k, v]) => [k, v.__v]).sort())
const fetalDoc = (st, id) => st.cloud.__docs.get(`mc_fetal_sessions/${id}`)
const contraDoc = (st, id) => st.cloud.__docs.get(`mc_contraction_records/${id}`)
const fetalDocs = st => [...st.cloud.__docs.entries()].filter(([k]) => k.startsWith('mc_fetal_sessions/')).map(([k, v]) => ({ _id: k.split('/')[1], ...v }))
const contraDocs = st => [...st.cloud.__docs.entries()].filter(([k]) => k.startsWith('mc_contraction_records/')).map(([k, v]) => ({ _id: k.split('/')[1], ...v }))

// 固定时基：2026-09-20 10:00 上海（=02:00 UTC）——均取过去时间（服务端未来偏斜门 ≤5min）；
// 跨午夜用 2026-09-19 01:00 上海（=18日 17:00 UTC）→ dateKey 2026-09-19
const T0 = Date.UTC(2026, 8, 20, 2, 0, 0)
const T_CROSS = Date.UTC(2026, 8, 18, 17, 0, 0) // 上海 2026-09-19 01:00（过去）
const S = 1000, M = 60 * S

async function click(st, sessionId, ts, rev, op) {
  return st.call('mc-tools', { action: 'fetal.click', sessionId, timestamp: ts, expectedRevision: rev, operationId: op || mkop('clk') })
}

async function main() {
  console.log('Phase E1 Step 1 服务端契约回归（mc-tools → mock 云 CAS → 真实 mc-health 日记录联动）\n')

  await scenario('F1 fetal.start：默认值/上海日号/幂等/校验异常', async () => {
    const st = makeStack('mama')
    const op = mkop('f1')
    const r = await st.call('mc-tools', { action: 'fetal.start', startTime: T0, operationId: op })
    assert.ok(r.ok, `start: ${JSON.stringify(r).slice(0, 200)}`)
    const s = r.data.session
    assert.match(s.sessionId, /^fst_[0-9a-f]{16}$/, `sessionId 形（实得 ${s.sessionId}）`)
    assert.equal(s.memberId, 'mama')
    assert.equal(s.dateKey, '2026-09-20', '上海日号（10:00 上海=09-20）')
    assert.equal(s.status, 'running')
    assert.equal(s.startTime, T0)
    assert.equal(s.targetDurationMs, 3600000, '默认目标时长 1 小时')
    assert.deepEqual(s.clicks, [])
    assert.equal(s.validCount, 0) && assert.equal(s.rawCount, 0)
    assert.equal(s.revision, 1)
    // 白盒 sortKey + 文档在盘
    const doc = fetalDoc(st, s.sessionId)
    assert.ok(doc && doc.sortKey && doc.sortKey.includes(s.sessionId))
    // 幂等：同参重放同会话；异参同 opId 拒
    const r2 = await st.call('mc-tools', { action: 'fetal.start', startTime: T0, operationId: op })
    assert.ok(r2.ok && r2.data.replayed === true && r2.data.session.sessionId === s.sessionId, '同参重放=同一会话')
    assert.equal(fetalDocs(st).length, 1, '磁盘恰一份')
    const r3 = await st.call('mc-tools', { action: 'fetal.start', startTime: T0 + M, operationId: op })
    assert.ok(!r3.ok && r3.code === 'operation-id-conflict', `异参同 opId 拒（实得 ${r3.code}）`)
    // 默认 startTime（服务端当前时间）
    const r4 = await st.call('mc-tools', { action: 'fetal.start', operationId: mkop() })
    assert.ok(r4.ok && Number.isInteger(r4.data.session.startTime) && Math.abs(r4.data.session.startTime - Date.now()) < 60000, '缺省 startTime=服务端当前')
    // 校验异常
    const bad = [
      ['targetDurationMs 0', { targetDurationMs: 0 }],
      ['targetDurationMs 非整', { targetDurationMs: 1.5 }],
      ['targetDurationMs 超 24h', { targetDurationMs: 24 * 3600000 + 1 }],
      ['startTime 未来 +6min', { startTime: Date.now() + 6 * M }],
      ['startTime 字符串', { startTime: '123' }],
    ]
    for (const [label, extra] of bad) {
      const r = await st.call('mc-tools', { action: 'fetal.start', startTime: T0, operationId: mkop(), ...extra })
      assert.ok(!r.ok && r.code === 'invalid-params', `${label} 须拒（实得 ${r.code}）`)
    }
    assert.equal(fetalDocs(st).length, 2, '拒绝零写（恰默认+固定两份）')
    // 跨上海午夜：18日 17:00 UTC（上海 19日 01:00）归属 09-19
    const rx = await st.call('mc-tools', { action: 'fetal.start', startTime: T_CROSS, operationId: mkop() })
    assert.ok(rx.ok && rx.data.session.dateKey === '2026-09-19', `跨午夜日号（实得 ${rx.data.session.dateKey}）`)
  })

  await scenario('F2 fetal.click 连击去重：5 分钟窗口合并/边界/原始流水保留/重放不重复追加', async () => {
    const st = makeStack('mama')
    const start = await st.call('mc-tools', { action: 'fetal.start', startTime: T0, operationId: mkop() })
    const sid = start.data.session.sessionId
    // 点击序列（偏移秒）：60/120/180（第一簇）、600/660（第二簇）
    const offsets = [60, 120, 180, 600, 660]
    let rev = 1
    for (const off of offsets) {
      const r = await click(st, sid, T0 + off * S, rev)
      assert.ok(r.ok, `click +${off}s: ${JSON.stringify(r).slice(0, 120)}`)
      rev++
    }
    const s = fetalDoc(st, sid)
    assert.equal(s.clicks.length, 5, '原始流水全保留')
    assert.deepEqual(s.clicks.map(c => c.valid), [true, false, false, true, false], `簇标志（实得 ${JSON.stringify(s.clicks.map(c => c.valid))}）`)
    assert.equal(s.validCount, 2, `有效计数=2 簇（实得 ${s.validCount}）`)
    assert.equal(s.revision, 6, '版本 5 次点击 +1×5')
    // 边界：恰 300,000ms 合并；300,001 新簇
    {
      const st2 = makeStack('mama')
      const s2 = (await st2.call('mc-tools', { action: 'fetal.start', startTime: T0, operationId: mkop() })).data.session
      await click(st2, s2.sessionId, T0, 1)
      await click(st2, s2.sessionId, T0 + 300000, 2)
      assert.equal(fetalDoc(st2, s2.sessionId).validCount, 1, '间隔恰 300,000ms 合并（≤窗口）')
      await click(st2, s2.sessionId, T0 + 300000 + 300001, 3)
      assert.equal(fetalDoc(st2, s2.sessionId).validCount, 2, '间隔 300,001ms 新簇（>窗口）')
    }
    // 点击早于会话开始 → 拒
    const early = await click(st, sid, T0 - S, 6)
    assert.ok(!early.ok && early.code === 'invalid-params', `早于 startTime 拒（实得 ${early.code}）`)
    // 陈旧版本 → revision-conflict
    const stale = await click(st, sid, T0 + 700 * S, 3)
    assert.ok(!stale.ok && stale.code === 'revision-conflict' && stale.currentRevision === 6, `陈旧版本拒+当前版本（实得 ${stale.code}/${stale.currentRevision}）`)
    // 重放（丢响应重试）：同 opId 同参 → 不重复追加，返回当前视图
    const replayOp = mkop('replay')
    const before = fetalDoc(st, sid).clicks.length
    const c1 = await click(st, sid, T0 + 1000 * S, 6, replayOp) // 距 660s 间隔 340s>300s——新簇
    assert.ok(c1.ok && c1.data.session.validCount === 3, `新簇点击（实得 ${c1.data.session.validCount}）`)
    const more = await click(st, sid, T0 + 1001 * S, 7) // 同簇续击
    assert.ok(more.ok && more.data.session.validCount === 3)
    const rp = await click(st, sid, T0 + 1000 * S, 6, replayOp)
    assert.ok(rp.ok && rp.data.replayed === true, '重放 ok')
    assert.equal(fetalDoc(st, sid).clicks.length, before + 2, `重放不重复追加（实得 ${fetalDoc(st, sid).clicks.length}）`)
    // 改体重放：同 opId 异 timestamp → 拒
    const rpBad = await click(st, sid, T0 + 800 * S, 6, replayOp)
    assert.ok(!rpBad.ok && rpBad.code === 'operation-id-conflict', '改体重放拒')
  })

  await scenario('F3 fetal.undo：撤销最后插入+重算（含乱序补录形）', async () => {
    const st = makeStack('mama')
    const sid = (await st.call('mc-tools', { action: 'fetal.start', startTime: T0, operationId: mkop() })).data.session.sessionId
    await click(st, sid, T0, 1)
    await click(st, sid, T0 + 60 * S, 2)
    assert.equal(fetalDoc(st, sid).validCount, 1, '同簇 1 次')
    const u1 = await st.call('mc-tools', { action: 'fetal.undo', sessionId: sid, expectedRevision: 3, operationId: mkop() })
    assert.ok(u1.ok && u1.data.session.clicks.length === 1 && u1.data.session.validCount === 1, '撤销后单点击仍 1 簇')
    const u2 = await st.call('mc-tools', { action: 'fetal.undo', sessionId: sid, expectedRevision: 4, operationId: mkop() })
    assert.ok(u2.ok && u2.data.session.clicks.length === 0 && u2.data.session.validCount === 0, '撤销至空')
    const u3 = await st.call('mc-tools', { action: 'fetal.undo', sessionId: sid, expectedRevision: 5, operationId: mkop() })
    assert.ok(!u3.ok && u3.code === 'invalid-state', `空会话撤销拒（实得 ${u3.code}）`)
    // 乱序补录：先插 +600s（簇 A），再补 +60s（排序在前成新簇首）——undo 移除最后“插入”的 +60s
    {
      const st2 = makeStack('mama')
      const s2 = (await st2.call('mc-tools', { action: 'fetal.start', startTime: T0, operationId: mkop() })).data.session
      await click(st2, s2.sessionId, T0 + 600 * S, 1)
      await click(st2, s2.sessionId, T0 + 60 * S, 2)
      const d = fetalDoc(st2, s2.sessionId)
      assert.equal(d.validCount, 2, '乱序两簇（540s 间隔）')
      assert.equal(d.clicks.length, 2)
      const undo = await st2.call('mc-tools', { action: 'fetal.undo', sessionId: s2.sessionId, expectedRevision: 3, operationId: mkop() })
      assert.ok(undo.ok, '撤销')
      const d2 = fetalDoc(st2, s2.sessionId)
      assert.equal(d2.clicks.length, 1, '撤销后单点击')
      assert.equal(d2.clicks[0].timestamp, T0 + 600 * S, '移除的是最后插入项（+60s）——非排序首项')
      assert.equal(d2.validCount, 1, '重算后 1 簇')
    }
  })

  await scenario('F4 fetal.finish/discard：状态流转+可选 mc_health_daily.fetalCount 同事务累计', async () => {
    // (a) 完成联动：日记录不存在 → created，fetalCount=会话 validCount
    const st = makeStack('mama')
    const sid = (await st.call('mc-tools', { action: 'fetal.start', startTime: T0, operationId: mkop() })).data.session.sessionId
    await click(st, sid, T0, 1)
    await click(st, sid, T0 + 60 * S, 2)
    await click(st, sid, T0 + 600 * S, 3)
    const finOp = mkop('fin')
    const fin = await st.call('mc-tools', { action: 'fetal.finish', sessionId: sid, endTime: T0 + 30 * M, expectedRevision: 4, syncDaily: true, operationId: finOp })
    assert.ok(fin.ok, `finish: ${JSON.stringify(fin).slice(0, 150)}`)
    assert.equal(fin.data.session.status, 'completed')
    assert.equal(fin.data.session.endTime, T0 + 30 * M)
    assert.equal(fin.data.session.validCount, 2, '计数固化')
    assert.equal(fin.data.dailySync, 'created', '联动=新建日记录')
    const daily = st.cloud.__docs.get(`mc_health_daily/${TEST_ENV.MC_FAMILY_ID}:2026-09-20`)
    assert.ok(daily && daily.fields.fetalCount === 2 && daily.revision === 1 && daily.updatedBy === 'mama', `日记录 fetalCount=2（实得 ${JSON.stringify(daily && daily.fields)}）`)
    // 重放：不双计
    const finReplay = await st.call('mc-tools', { action: 'fetal.finish', sessionId: sid, endTime: T0 + 30 * M, expectedRevision: 4, syncDaily: true, operationId: finOp })
    assert.ok(finReplay.ok && finReplay.data.replayed === true, 'finish 重放 ok')
    assert.equal(st.cloud.__docs.get(`mc_health_daily/${TEST_ENV.MC_FAMILY_ID}:2026-09-20`).fields.fetalCount, 2, '重放不双计')
    // 终态后：click/finish/discard 均拒
    const cAfter = await click(st, sid, T0 + 31 * M, 5)
    assert.ok(!cAfter.ok && cAfter.code === 'invalid-state', `完成后点击拒（实得 ${cAfter.code}）`)
    const finAgain = await st.call('mc-tools', { action: 'fetal.finish', sessionId: sid, expectedRevision: 5, operationId: mkop() })
    assert.ok(!finAgain.ok && finAgain.code === 'invalid-state', '重复完成拒')
    // (b) 第二会话同日联动：累计 2+1=3
    const sid2 = (await st.call('mc-tools', { action: 'fetal.start', startTime: T0 + 40 * M, operationId: mkop() })).data.session.sessionId
    await click(st, sid2, T0 + 41 * M, 1)
    const fin2 = await st.call('mc-tools', { action: 'fetal.finish', sessionId: sid2, endTime: T0 + 60 * M, expectedRevision: 2, syncDaily: true, operationId: mkop() })
    assert.ok(fin2.ok && fin2.data.dailySync === 'synced')
    assert.equal(st.cloud.__docs.get(`mc_health_daily/${TEST_ENV.MC_FAMILY_ID}:2026-09-20`).fields.fetalCount, 3, '同日累计 2+1=3')
    // (c) 已有非零 fetalCount 的日记录：mc-health 种 3 → 会话 2 → 5
    const st3 = makeStack('mama')
    const seed = await st3.call('mc-health', { action: 'daily.upsert', schemaVersion: 1, operationId: mkop('seed'), dateKey: '2026-09-20', expectedRevision: 0, payload: { fetalCount: 3, weightKg: 60 } })
    assert.ok(seed.ok, 'mc-health 日记录种子')
    const sid3 = (await st3.call('mc-tools', { action: 'fetal.start', startTime: T0, operationId: mkop() })).data.session.sessionId
    await click(st3, sid3, T0, 1)
    await click(st3, sid3, T0 + 600 * S, 2)
    const fin3 = await st3.call('mc-tools', { action: 'fetal.finish', sessionId: sid3, endTime: T0 + M, expectedRevision: 3, syncDaily: true, operationId: mkop() })
    assert.ok(fin3.ok && fin3.data.dailySync === 'synced')
    const d3 = st3.cloud.__docs.get(`mc_health_daily/${TEST_ENV.MC_FAMILY_ID}:2026-09-20`)
    assert.equal(d3.fields.fetalCount, 5, `已有 3+会话 2=5（实得 ${d3.fields.fetalCount}）`)
    assert.equal(d3.fields.weightKg, 60, '其他日记录字段保全')
    assert.equal(d3.revision, 2, '日记录 revision+1')
    // (d) 已删除日记录（墓碑）：跳过不复活
    const st4 = makeStack('mama')
    await st4.call('mc-health', { action: 'daily.upsert', schemaVersion: 1, operationId: mkop('seed4'), dateKey: '2026-09-20', expectedRevision: 0, payload: { fetalCount: 1 } })
    await st4.call('mc-health', { action: 'daily.delete', schemaVersion: 1, operationId: mkop('del4'), dateKey: '2026-09-20', expectedRevision: 1 })
    const sid4 = (await st4.call('mc-tools', { action: 'fetal.start', startTime: T0, operationId: mkop() })).data.session.sessionId
    await click(st4, sid4, T0, 1)
    const fin4 = await st4.call('mc-tools', { action: 'fetal.finish', sessionId: sid4, endTime: T0 + M, expectedRevision: 2, syncDaily: true, operationId: mkop() })
    assert.ok(fin4.ok && fin4.data.dailySync === 'skipped-daily-deleted', `墓碑跳过（实得 ${fin4.data.dailySync}）`)
    const d4 = st4.cloud.__docs.get(`mc_health_daily/${TEST_ENV.MC_FAMILY_ID}:2026-09-20`)
    assert.ok(d4.deleted === true && d4.fields.fetalCount === undefined, '墓碑不被复活不清写')
    // (e) discard：running→discarded；终态门
    const sid5 = (await st4.call('mc-tools', { action: 'fetal.start', startTime: T0, operationId: mkop() })).data.session.sessionId
    await click(st4, sid5, T0, 1)
    const disc = await st4.call('mc-tools', { action: 'fetal.discard', sessionId: sid5, expectedRevision: 2, operationId: mkop() })
    assert.ok(disc.ok && disc.data.session.status === 'discarded' && Number.isInteger(disc.data.session.endTime), '废弃')
    const finDisc = await st4.call('mc-tools', { action: 'fetal.finish', sessionId: sid5, expectedRevision: 3, operationId: mkop() })
    assert.ok(!finDisc.ok && finDisc.code === 'invalid-state', '废弃后完成拒')
    // 废弃会话不联动日记录
    assert.ok(!st4.cloud.__docs.get(`mc_health_daily/${TEST_ENV.MC_FAMILY_ID}:2026-09-20`) || st4.cloud.__docs.get(`mc_health_daily/${TEST_ENV.MC_FAMILY_ID}:2026-09-20`).deleted, '废弃路径零日记录写')
    // endTime 早于 startTime 拒
    const sid6 = (await st4.call('mc-tools', { action: 'fetal.start', startTime: T0, operationId: mkop() })).data.session.sessionId
    const badEnd = await st4.call('mc-tools', { action: 'fetal.finish', sessionId: sid6, endTime: T0 - S, expectedRevision: 1, operationId: mkop() })
    assert.ok(!badEnd.ok && badEnd.code === 'invalid-params', 'endTime 早于 startTime 拒')
  })

  await scenario('F5 fetal.list：倒序/状态过滤/日号过滤/稳定分页', async () => {
    const st = makeStack('mama')
    const ids = []
    for (const off of [0, 10 * M, 20 * M]) {
      const r = await st.call('mc-tools', { action: 'fetal.start', startTime: T0 + off, operationId: mkop() })
      ids.push(r.data.session.sessionId)
    }
    // 跨午夜会话（上海 2026-09-19 01:00——时序最早）
    const cross = (await st.call('mc-tools', { action: 'fetal.start', startTime: T_CROSS, operationId: mkop() })).data.session
    // 完成一个供状态过滤
    await click(st, ids[0], T0, 1)
    await st.call('mc-tools', { action: 'fetal.finish', sessionId: ids[0], endTime: T0 + M, expectedRevision: 2, operationId: mkop() })
    const all = await st.call('mc-tools', { action: 'fetal.list' })
    assert.equal(all.data.sessions.length, 4, '全部 4 会话')
    const times = all.data.sessions.map(s => s.startTime)
    assert.deepEqual(times, [...times].sort((a, b) => b - a), 'startTime 降序')
    assert.equal(all.data.sessions[0].sessionId, ids[2], '最新（T0+20min）在前')
    assert.equal(all.data.sessions[3].sessionId, cross.sessionId, '跨午夜最早在后')
    const completed = await st.call('mc-tools', { action: 'fetal.list', status: 'completed' })
    assert.equal(completed.data.sessions.length, 1, 'completed 过滤恰 1')
    assert.equal(completed.data.sessions[0].sessionId, ids[0])
    const byDate = await st.call('mc-tools', { action: 'fetal.list', dateKey: '2026-09-19' })
    assert.equal(byDate.data.sessions.length, 1, '日号过滤恰 1')
    assert.equal(byDate.data.sessions[0].sessionId, cross.sessionId)
    assert.equal(byDate.data.sessions[0].dateKey, '2026-09-19')
    const badStatus = await st.call('mc-tools', { action: 'fetal.list', status: 'paused' })
    assert.ok(!badStatus.ok && badStatus.code === 'invalid-params', '非法状态过滤拒')
    // 分页 limit=2 → 2 页无重无漏
    const seen = []
    let cursor = null
    for (let p = 0; p < 5; p++) {
      const r = await st.call('mc-tools', { action: 'fetal.list', limit: 2, ...(cursor ? { cursor } : {}) })
      seen.push(...r.data.sessions.map(s => s.sessionId))
      if (!r.data.hasMore) break
      cursor = r.data.nextCursor
    }
    assert.equal(seen.length, 4, `分页合计 4（实得 ${seen.length}）`)
    assert.equal(new Set(seen).size, 4, '无重无漏')
  })

  await scenario('C1 contraction.start：间隔计算（含乱序补录前驱定位）/软废弃不作前驱/校验', async () => {
    const st = makeStack('mama')
    const t1 = T0
    const t2 = T0 + 5 * M
    const t3 = T0 + 12 * M
    const r1 = await st.call('mc-tools', { action: 'contraction.start', startTime: t1, operationId: mkop() })
    assert.ok(r1.ok, `start1: ${JSON.stringify(r1).slice(0, 150)}`)
    assert.equal(r1.data.record.status, 'ongoing')
    assert.equal(r1.data.record.intervalSec, null, '首条无间隔')
    assert.equal(r1.data.record.durationSec, null, '未结束不计时长')
    assert.equal(r1.data.record.dateKey, '2026-09-20')
    const r2 = await st.call('mc-tools', { action: 'contraction.start', startTime: t2, operationId: mkop() })
    assert.equal(r2.data.record.intervalSec, 300, `间隔=300s（实得 ${r2.data.record.intervalSec}）`)
    // 乱序补录：t2.5=t1+8min 插入——前驱=startTime 最近更早者 t2（非最近插入者）→ 180s；
    // t2 的存量间隔不变（插入时快照）
    const r25 = await st.call('mc-tools', { action: 'contraction.start', startTime: T0 + 8 * M, operationId: mkop() })
    assert.equal(r25.data.record.intervalSec, 180, `乱序补录前驱按 startTime 最近更早者（实得 ${r25.data.record.intervalSec}）`)
    assert.equal(contraDocs(st).find(d => d.startTime === t2).intervalSec, 300, '既有记录间隔快照不变')
    // 废弃 t2 后：新记录前驱=t2.5（未废弃的最近更早者）
    await st.call('mc-tools', { action: 'contraction.delete', recordId: r2.data.record.recordId, expectedRevision: 1, operationId: mkop() })
    const r3 = await st.call('mc-tools', { action: 'contraction.start', startTime: t3, operationId: mkop() })
    assert.equal(r3.data.record.intervalSec, 240, `废弃记录不作前驱（12-8=4min=240s，实得 ${r3.data.record.intervalSec}）`)
    // 校验：intensity 枚举/notes 长度/未来时间戳
    const bi = await st.call('mc-tools', { action: 'contraction.start', startTime: t1, intensity: 'severe', operationId: mkop() })
    assert.ok(!bi.ok && bi.code === 'invalid-params', '非法强度拒')
    const bn = await st.call('mc-tools', { action: 'contraction.start', startTime: t1, notes: 'x'.repeat(201), operationId: mkop() })
    assert.ok(!bn.ok && bn.code === 'invalid-params', '超长备注拒')
    const bf = await st.call('mc-tools', { action: 'contraction.start', startTime: Date.now() + 6 * M, operationId: mkop() })
    assert.ok(!bf.ok && bf.code === 'invalid-params', '未来时间戳拒')
    // 合法 intensity/notes + 幂等
    const opOk = mkop()
    const ri = await st.call('mc-tools', { action: 'contraction.start', startTime: t1, intensity: 'moderate', notes: '轻度可忍', operationId: opOk })
    assert.ok(ri.ok && ri.data.record.intensity === 'moderate' && ri.data.record.notes === '轻度可忍')
    const riReplay = await st.call('mc-tools', { action: 'contraction.start', startTime: t1, intensity: 'moderate', notes: '轻度可忍', operationId: opOk })
    assert.ok(riReplay.ok && riReplay.data.replayed === true && riReplay.data.record.recordId === ri.data.record.recordId, '同参重放同一记录')
    const riBad = await st.call('mc-tools', { action: 'contraction.start', startTime: t1, intensity: 'strong', operationId: opOk })
    assert.ok(!riBad.ok && riBad.code === 'operation-id-conflict', '改体重放拒')
  })

  await scenario('C2 contraction.stop：持续秒数（含舍入）/状态门/重放', async () => {
    const st = makeStack('mama')
    const rec = (await st.call('mc-tools', { action: 'contraction.start', startTime: T0, operationId: mkop() })).data.record
    // 90,500ms → round=91s
    const stopOp = mkop()
    const sp = await st.call('mc-tools', { action: 'contraction.stop', recordId: rec.recordId, endTime: T0 + 90500, expectedRevision: 1, operationId: stopOp })
    assert.ok(sp.ok, `stop: ${JSON.stringify(sp).slice(0, 150)}`)
    assert.equal(sp.data.record.status, 'finished')
    assert.equal(sp.data.record.durationSec, 91, `持续=round(90.5s)=91（实得 ${sp.data.record.durationSec}）`)
    assert.equal(sp.data.record.endTime, T0 + 90500)
    // 重放
    const spReplay = await st.call('mc-tools', { action: 'contraction.stop', recordId: rec.recordId, endTime: T0 + 90500, expectedRevision: 1, operationId: stopOp })
    assert.ok(spReplay.ok && spReplay.data.replayed === true && spReplay.data.record.durationSec === 91, 'stop 重放幂等')
    // 终态门：再停/负时长
    const spAgain = await st.call('mc-tools', { action: 'contraction.stop', recordId: rec.recordId, endTime: T0 + 120000, expectedRevision: 2, operationId: mkop() })
    assert.ok(!spAgain.ok && spAgain.code === 'invalid-state', `已完成再停拒（实得 ${spAgain.code}）`)
    const rec2 = (await st.call('mc-tools', { action: 'contraction.start', startTime: T0 + 10 * M, operationId: mkop() })).data.record
    const negEnd = await st.call('mc-tools', { action: 'contraction.stop', recordId: rec2.recordId, endTime: T0, expectedRevision: 1, operationId: mkop() })
    assert.ok(!negEnd.ok && negEnd.code === 'invalid-params', 'endTime 早于 startTime 拒')
    // stop 顺带 intensity/notes 更新
    const sp2 = await st.call('mc-tools', { action: 'contraction.stop', recordId: rec2.recordId, endTime: T0 + 10 * M + 60000, expectedRevision: 1, intensity: 'strong', notes: '加强', operationId: mkop() })
    assert.ok(sp2.ok && sp2.data.record.intensity === 'strong' && sp2.data.record.notes === '加强' && sp2.data.record.durationSec === 60)
    // 陈旧版本
    const rec3 = (await st.call('mc-tools', { action: 'contraction.start', startTime: T0 + 20 * M, operationId: mkop() })).data.record
    await st.call('mc-tools', { action: 'contraction.stop', recordId: rec3.recordId, endTime: T0 + 20 * M + 30000, expectedRevision: 1, operationId: mkop() })
    const stale = await st.call('mc-tools', { action: 'contraction.stop', recordId: rec3.recordId, endTime: T0 + 20 * M + 40000, expectedRevision: 1, operationId: mkop() })
    assert.ok(!stale.ok && stale.code === 'revision-conflict', '陈旧版本拒')
  })

  await scenario('C3/C4 contraction.delete+list：软废弃排除/包含开关/倒序/sinceMs 窗口/分页', async () => {
    const st = makeStack('mama')
    const ids = []
    for (const off of [0, 5 * M, 11 * M, 17 * M]) {
      const r = await st.call('mc-tools', { action: 'contraction.start', startTime: T0 + off, operationId: mkop() })
      ids.push({ id: r.data.record.recordId, start: T0 + off })
    }
    // 结束前两条（供状态混杂）
    await st.call('mc-tools', { action: 'contraction.stop', recordId: ids[0].id, endTime: T0 + 60000, expectedRevision: 1, operationId: mkop() })
    await st.call('mc-tools', { action: 'contraction.stop', recordId: ids[1].id, endTime: T0 + 5 * M + 45000, expectedRevision: 1, operationId: mkop() })
    // 废弃第三条
    const del = await st.call('mc-tools', { action: 'contraction.delete', recordId: ids[2].id, expectedRevision: 1, operationId: mkop() })
    assert.ok(del.ok && del.data.record.status === 'discarded', '软废弃')
    const delAgain = await st.call('mc-tools', { action: 'contraction.delete', recordId: ids[2].id, expectedRevision: 2, operationId: mkop() })
    assert.ok(!delAgain.ok && delAgain.code === 'invalid-state', '重复废弃拒')
    // 默认列表排除废弃；includeDiscarded 包含
    const lst = await st.call('mc-tools', { action: 'contraction.list' })
    assert.equal(lst.data.records.length, 3, `默认排除废弃（实得 ${lst.data.records.length}）`)
    assert.ok(!lst.data.records.some(r => r.recordId === ids[2].id))
    const lstAll = await st.call('mc-tools', { action: 'contraction.list', includeDiscarded: true })
    assert.equal(lstAll.data.records.length, 4, 'includeDiscarded 全量 4')
    // 倒序（startTime 降序）
    const starts = lst.data.records.map(r => r.startTime)
    assert.deepEqual(starts, [...starts].sort((a, b) => b - a), 'startTime 降序')
    // sinceMs 窗口
    const since = await st.call('mc-tools', { action: 'contraction.list', sinceMs: T0 + 10 * M })
    assert.ok(since.data.records.every(r => r.startTime >= T0 + 10 * M), 'sinceMs 窗口过滤')
    assert.equal(since.data.records.length, 1, `窗口内 1 条（实得 ${since.data.records.length}）`)
    const badSince = await st.call('mc-tools', { action: 'contraction.list', sinceMs: -1 })
    assert.ok(!badSince.ok && badSince.code === 'invalid-params', '非法 sinceMs 拒')
    // 分页（含废弃混杂下不重不漏——includeDiscarded 全量 4、limit 2 两页）
    const seen = []
    let cursor = null
    for (let p = 0; p < 5; p++) {
      const r = await st.call('mc-tools', { action: 'contraction.list', limit: 2, includeDiscarded: true, ...(cursor ? { cursor } : {}) })
      seen.push(...r.data.records.map(x => x.recordId))
      if (!r.data.hasMore) break
      cursor = r.data.nextCursor
    }
    assert.equal(seen.length, 4) && assert.equal(new Set(seen).size, 4, '分页无重无漏')
  })

  await scenario('X1 非成员：全部 10 action 100% 拒绝+零写', async () => {
    const st = makeStack('mama')
    const seed = (await st.call('mc-tools', { action: 'fetal.start', startTime: T0, operationId: mkop() })).data.session
    await click(st, seed.sessionId, T0, 1)
    const crec = (await st.call('mc-tools', { action: 'contraction.start', startTime: T0, operationId: mkop() })).data.record
    const before = docCount(st)
    const beforeV = versionSnapshot(st)
    st.as(TEST_ENV.MC_INTRUDER_OPENID)
    const probes = [
      ['fetal.start', { action: 'fetal.start', startTime: T0, operationId: mkop() }],
      ['fetal.click', { action: 'fetal.click', sessionId: seed.sessionId, timestamp: T0 + S, expectedRevision: 2, operationId: mkop() }],
      ['fetal.undo', { action: 'fetal.undo', sessionId: seed.sessionId, expectedRevision: 2, operationId: mkop() }],
      ['fetal.finish', { action: 'fetal.finish', sessionId: seed.sessionId, expectedRevision: 2, operationId: mkop() }],
      ['fetal.discard', { action: 'fetal.discard', sessionId: seed.sessionId, expectedRevision: 2, operationId: mkop() }],
      ['fetal.list', { action: 'fetal.list' }],
      ['contraction.start', { action: 'contraction.start', startTime: T0 + S, operationId: mkop() }],
      ['contraction.stop', { action: 'contraction.stop', recordId: crec.recordId, endTime: T0 + S, expectedRevision: 1, operationId: mkop() }],
      ['contraction.delete', { action: 'contraction.delete', recordId: crec.recordId, expectedRevision: 1, operationId: mkop() }],
      ['contraction.list', { action: 'contraction.list' }],
    ]
    for (const [label, ev] of probes) {
      const r = await st.call('mc-tools', ev)
      assert.ok(!r.ok && r.code === 'not-family-member', `${label} 第三身份须拒（实得 ${r.code}）`)
    }
    assert.equal(docCount(st), before, '零新文档')
    assert.equal(versionSnapshot(st), beforeV, '零版本写（__v 全不变）')
  })

  await scenario('X2 跨家庭隔离：列表空/实体 not-found/数据零泄漏', async () => {
    const st = makeStack('mama')
    const seed = (await st.call('mc-tools', { action: 'fetal.start', startTime: T0, operationId: mkop() })).data.session
    const crec = (await st.call('mc-tools', { action: 'contraction.start', startTime: T0, operationId: mkop() })).data.record
    const origFam = process.env.MC_FAMILY_ID
    process.env.MC_FAMILY_ID = 'fam-other-xyz'
    try {
      const fl = await st.call('mc-tools', { action: 'fetal.list' })
      assert.ok(fl.ok && fl.data.sessions.length === 0, '跨家庭 fetal.list 空')
      const cl = await st.call('mc-tools', { action: 'contraction.list' })
      assert.ok(cl.ok && cl.data.records.length === 0, '跨家庭 contraction.list 空')
      const click = await st.call('mc-tools', { action: 'fetal.click', sessionId: seed.sessionId, timestamp: T0 + S, expectedRevision: 1, operationId: mkop() })
      assert.ok(!click.ok && click.code === 'not-found', `跨家庭点击 not-found（实得 ${click.code}）`)
      const stop = await st.call('mc-tools', { action: 'contraction.stop', recordId: crec.recordId, endTime: T0 + S, expectedRevision: 1, operationId: mkop() })
      assert.ok(!stop.ok && stop.code === 'not-found', '跨家庭结束 not-found')
      const del = await st.call('mc-tools', { action: 'contraction.delete', recordId: crec.recordId, expectedRevision: 1, operationId: mkop() })
      assert.ok(!del.ok && del.code === 'not-found', '跨家庭废弃 not-found')
    } finally { process.env.MC_FAMILY_ID = origFam }
    const fl2 = await st.call('mc-tools', { action: 'fetal.list' })
    assert.equal(fl2.data.sessions.length, 1, '复原后数据完整')
    assert.equal(fetalDoc(st, seed.sessionId).clicks.length, 0, '拒绝路径零写')
  })

  await scenario('Z9 冻结源哈希：套件运行期间 mc-tools 源未被并发编辑', async () => {
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
