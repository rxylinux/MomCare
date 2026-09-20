// Phase E2 服务端契约回归：mc-tools efw.*（Hadlock 1985 三参数估重）→ mock 云 CAS。
// 覆盖：算例锚点 2364g 精确全等；mm/cm 输入等价；范围门（逐项+边界通过）；save 幂等/校验/BPD 伴随存储；
// delete 软删除；list 倒序分页；非成员隔离+零写；跨家庭分区。
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

const DIST = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-e2s-')), 'cf')
{
  const dir = path.join(DIST, 'mc-tools'); fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(path.join(root, 'cloud/functions/mc-tools/index.js'), path.join(dir, 'index.js'))
  fs.cpSync(path.join(root, 'cloud/shared'), path.join(dir, 'shared'), { recursive: true })
}
function requireHandler() {
  delete require.cache[require.resolve(path.join(DIST, 'mc-tools/index.js'))]
  return require(path.join(DIST, 'mc-tools/index.js'))
}

// ── 冻结源哈希 ──
const FROZEN_RELS = ['cloud/functions/mc-tools/index.js', 'cloud/shared/auth.js', 'cloud/shared/config.js', 'cloud/shared/respond.js', 'cloud/shared/constants.js']
const frozenHashes = Object.fromEntries(FROZEN_RELS.map(rel => [rel, sha256(fs.readFileSync(path.join(root, rel)))]))
console.log('冻结源哈希（加载时快照）:')
for (const [rel, h] of Object.entries(frozenHashes)) console.log(`  ${h.slice(0, 8)}  ${rel}`)

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-e2s', MC_MEMBER_MAMA_OPENID: 'oE2SMAMA123456', MC_MEMBER_PAPA_OPENID: 'oE2SPAPA123456', MC_INTRUDER_OPENID: 'oE2SINTRUDER6666' }

// ── Mock 云（版本 CAS 事务）──
function makeMockCloud() {
  const docs = new Map()
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

function makeStack(member = 'mama') {
  const cloud = makeMockCloud()
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID
  cloud.__setCtx(member === 'mama' ? TEST_ENV.MC_MEMBER_MAMA_OPENID : member === 'papa' ? TEST_ENV.MC_MEMBER_PAPA_OPENID : member)
  const tools = requireHandler()
  tools.__setCloud(cloud)
  return {
    cloud, tools,
    call: e => tools.main(e),
    as(m) { cloud.__setCtx(m === 'mama' ? TEST_ENV.MC_MEMBER_MAMA_OPENID : m === 'papa' ? TEST_ENV.MC_MEMBER_PAPA_OPENID : m) },
  }
}

const docCount = st => st.cloud.__docs.size
const versionSnapshot = st => JSON.stringify([...st.cloud.__docs.entries()].map(([k, v]) => [k, v.__v]).sort())
const efwDocs = st => [...st.cloud.__docs.entries()].filter(([k]) => k.startsWith('mc_efw_records/')).map(([k, v]) => ({ _id: k.split('/')[1], ...v }))

async function main() {
  console.log('Phase E2 服务端契约回归（mc-tools efw.* → mock 云 CAS）\n')

  await scenario('F1 算例锚点：HC=32/AC=30/FL=6.5 → log10=3.37370 → 2364.29g → 2364g', async () => {
    const st = makeStack('mama')
    const r = await st.call({ action: 'efw.calculate', hc: 32.0, ac: 30.0, fl: 6.5, unit: 'cm' })
    assert.ok(r.ok, `calculate: ${JSON.stringify(r).slice(0, 200)}`)
    const d = r.data
    assert.equal(d.log10, 3.3737, `log10=3.37370（实得 ${d.log10}）`)
    assert.equal(d.exactEfwGrams, 2364.29, `精确值 2364.29g（实得 ${d.exactEfwGrams}）`)
    assert.equal(d.efwGrams, 2364, `整数克 2364g（实得 ${d.efwGrams}）`)
    assert.equal(d.efwKg, 2.364, `公斤 2.364（实得 ${d.efwKg}）`)
    assert.equal(d.formula, 'hadlock_hc_ac_fl_1985_v1', '公式标识')
    assert.deepEqual(d.inputsCm, { hcCm: 32, acCm: 30, flCm: 6.5 }, 'cm 输入直通')
    assert.equal(d.rangeGrams.low, 2128, `±10% 下界 2128（实得 ${d.rangeGrams.low}）`)
    assert.equal(d.rangeGrams.high, 2601, `±10% 上界 2601（实得 ${d.rangeGrams.high}）`)
    // 纯计算零写
    assert.equal(docCount(st), 0, 'calculate 零落盘')
  })

  await scenario('F2 mm/cm 输入等价性：320/300/65mm 与 32/30/6.5cm 输出全等', async () => {
    const st = makeStack('mama')
    const rCm = await st.call({ action: 'efw.calculate', hc: 32.0, ac: 30.0, fl: 6.5, unit: 'cm' })
    const rMm = await st.call({ action: 'efw.calculate', hc: 320, ac: 300, fl: 65, unit: 'mm' })
    assert.ok(rCm.ok && rMm.ok)
    assert.deepEqual(rMm.data, rCm.data, `mm 等价输出（实得 ${JSON.stringify(rMm.data)}）`)
    assert.deepEqual(rMm.data.inputsCm, { hcCm: 32, acCm: 30, flCm: 6.5 }, 'mm 换算 cm 后存储')
  })

  await scenario('F3 范围门：逐项超界/负数/NaN/缺参/非法单位拒绝；边界值通过', async () => {
    const st = makeStack('mama')
    const bad = [
      ['HC 42.1 超上界', { hc: 42.1, ac: 30, fl: 6.5 }],
      ['HC 9.9 低于下界', { hc: 9.9, ac: 30, fl: 6.5 }],
      ['AC 45.1 超上界', { hc: 32, ac: 45.1, fl: 6.5 }],
      ['AC 9.9 低于下界', { hc: 32, ac: 9.9, fl: 6.5 }],
      ['FL 10.1 超上界', { hc: 32, ac: 30, fl: 10.1 }],
      ['FL 0.9 低于下界', { hc: 32, ac: 30, fl: 0.9 }],
      ['负数', { hc: -32, ac: 30, fl: 6.5 }],
      ['NaN（字符串）', { hc: 'abc', ac: 30, fl: 6.5 }],
      ['缺 FL', { hc: 32, ac: 30 }],
      ['非法单位', { hc: 320, ac: 300, fl: 65, unit: 'inch' }],
    ]
    for (const [label, ev] of bad) {
      const r = await st.call({ action: 'efw.calculate', ...ev })
      assert.ok(!r.ok && r.code === 'invalid-params', `${label} 须拒（实得 ${r.code}: ${String(r.message).slice(0, 60)}）`)
    }
    // 边界值恰通过（10.0/42.0、10.0/45.0、1.0/10.0）
    for (const ev of [
      { hc: 10.0, ac: 10.0, fl: 1.0 },
      { hc: 42.0, ac: 45.0, fl: 10.0 },
    ]) {
      const r = await st.call({ action: 'efw.calculate', ...ev, unit: 'cm' })
      assert.ok(r.ok, `边界 ${JSON.stringify(ev)} 通过（实得 ${r.code}）`)
    }
    assert.equal(docCount(st), 0, '全部拒绝零写')
  })

  await scenario('F4 efw.save：权威计算落盘/BPD 伴随存储/幂等/校验', async () => {
    const st = makeStack('mama')
    const op = mkop('e2save')
    const r = await st.call({ action: 'efw.save', gestationalWeek: 32, hc: 320, ac: 300, fl: 65, unit: 'mm', bpd: 88, dateKey: '2026-09-18', notes: '孕 32 周常规超声', operationId: op })
    assert.ok(r.ok, `save: ${JSON.stringify(r).slice(0, 200)}`)
    const rec = r.data.record
    assert.match(rec.recordId, /^efw_[0-9a-f]{16}$/, 'recordId 形')
    assert.equal(rec.gestationalWeek, 32)
    assert.deepEqual(rec.measurements, { hcCm: 32, acCm: 30, flCm: 6.5, inputUnit: 'mm', bpdMm: 88 }, 'cm 换算+BPD 伴随存储（mm）')
    assert.equal(rec.efwGrams, 2364, '服务端权威计算 2364g')
    assert.equal(rec.exactEfwGrams, 2364.29)
    assert.equal(rec.formula, 'hadlock_hc_ac_fl_1985_v1')
    assert.equal(rec.status, 'active') && assert.equal(rec.revision, 1)
    assert.equal(rec.dateKey, '2026-09-18')
    // BPD 不影响公式（无 BPD 同参数计算相同）
    const r2 = await st.call({ action: 'efw.calculate', hc: 320, ac: 300, fl: 65, unit: 'mm' })
    assert.equal(r2.data.efwGrams, rec.efwGrams, 'BPD 不参与公式')
    // cm 单位 BPD → mm 存储
    const rBpd = await st.call({ action: 'efw.save', gestationalWeek: 33, hc: 32.5, ac: 30.5, fl: 6.6, unit: 'cm', bpd: 8.8, operationId: mkop() })
    assert.ok(rBpd.ok && rBpd.data.record.measurements.bpdMm === 88, `cm BPD → mm 存储（实得 ${rBpd.data.record.measurements.bpdMm}）`)
    // 幂等：同参重放同记录；异参同 opId 拒
    const replay = await st.call({ action: 'efw.save', gestationalWeek: 32, hc: 320, ac: 300, fl: 65, unit: 'mm', bpd: 88, dateKey: '2026-09-18', notes: '孕 32 周常规超声', operationId: op })
    assert.ok(replay.ok && replay.data.replayed === true && replay.data.record.recordId === rec.recordId, '同参重放同记录')
    assert.equal(efwDocs(st).length, 2, '磁盘恰两份（重放不重复）')
    const conflict = await st.call({ action: 'efw.save', gestationalWeek: 32, hc: 330, ac: 300, fl: 65, unit: 'mm', operationId: op })
    assert.ok(!conflict.ok && conflict.code === 'operation-id-conflict', `异参同 opId 拒（实得 ${conflict.code}）`)
    // 校验：孕周/notes/日期
    for (const [label, ev] of [
      ['孕周 11', { gestationalWeek: 11 }],
      ['孕周 43', { gestationalWeek: 43 }],
      ['孕周非整', { gestationalWeek: 32.5 }],
      ['notes 超长', { gestationalWeek: 32, notes: 'x'.repeat(201) }],
      ['dateKey 非法', { gestationalWeek: 32, dateKey: '2026/09/18' }],
      ['bpd 负数', { gestationalWeek: 32, bpd: -1 }],
    ]) {
      const r3 = await st.call({ action: 'efw.save', hc: 32, ac: 30, fl: 6.5, operationId: mkop(), ...ev })
      assert.ok(!r3.ok && r3.code === 'invalid-params', `${label} 拒（实得 ${r3.code}）`)
    }
  })

  await scenario('F5 efw.delete + list：软删除/排除与包含/倒序/分页', async () => {
    const st = makeStack('mama')
    const ids = []
    for (const [i, week] of [30, 31, 32, 33].entries()) {
      const r = await st.call({ action: 'efw.save', gestationalWeek: week, hc: 32, ac: 30, fl: 6.5, dateKey: `2026-09-1${5 + i}`, operationId: mkop() })
      assert.ok(r.ok)
      ids.push(r.data.record.recordId)
    }
    // 倒序（dateKey desc——09-18 最前）
    const lst = await st.call({ action: 'efw.list' })
    assert.equal(lst.data.records.length, 4)
    const keys = lst.data.records.map(r2 => r2.dateKey)
    assert.deepEqual(keys, [...keys].sort().reverse(), 'dateKey 倒序')
    assert.equal(lst.data.records[0].gestationalWeek, 33, '最新日期=孕33 周')
    // 分页
    const seen = []
    let cursor = null
    for (let p = 0; p < 5; p++) {
      const r2 = await st.call({ action: 'efw.list', limit: 3, ...(cursor ? { cursor } : {}) })
      seen.push(...r2.data.records.map(x => x.recordId))
      if (!r2.data.hasMore) break
      cursor = r2.data.nextCursor
    }
    assert.equal(seen.length, 4) && assert.equal(new Set(seen).size, 4, '分页无重无漏')
    // 软删除
    const del = await st.call({ action: 'efw.delete', recordId: ids[0], expectedRevision: 1, operationId: mkop() })
    assert.ok(del.ok && del.data.record.status === 'discarded', '软删除')
    const lst2 = await st.call({ action: 'efw.list' })
    assert.equal(lst2.data.records.length, 3, '默认排除已删')
    const lstAll = await st.call({ action: 'efw.list', includeDiscarded: true })
    assert.equal(lstAll.data.records.length, 4, 'includeDiscarded 全量')
    // 重复删除/陈旧版本
    const delAgain = await st.call({ action: 'efw.delete', recordId: ids[0], expectedRevision: 2, operationId: mkop() })
    assert.ok(!delAgain.ok && delAgain.code === 'invalid-state', `重复删除拒（实得 ${delAgain.code}）`)
    const stale = await st.call({ action: 'efw.delete', recordId: ids[1], expectedRevision: 0, operationId: mkop() })
    assert.ok(!stale.ok && stale.code === 'revision-conflict', '陈旧版本拒')
    // 删除重放
    const delOp = mkop()
    await st.call({ action: 'efw.delete', recordId: ids[1], expectedRevision: 1, operationId: delOp })
    const delReplay = await st.call({ action: 'efw.delete', recordId: ids[1], expectedRevision: 1, operationId: delOp })
    assert.ok(delReplay.ok && delReplay.data.replayed === true, '删除重放幂等')
    assert.equal(efwDocs(st).filter(d => d.status !== 'discarded').length, 2, '磁盘 2 活跃')
  })

  await scenario('X1 非成员：efw 全 action 拒绝+零写', async () => {
    const st = makeStack('mama')
    const seed = await st.call({ action: 'efw.save', gestationalWeek: 32, hc: 32, ac: 30, fl: 6.5, operationId: mkop() })
    assert.ok(seed.ok)
    const before = docCount(st)
    const beforeV = versionSnapshot(st)
    st.as(TEST_ENV.MC_INTRUDER_OPENID)
    const probes = [
      ['efw.calculate', { action: 'efw.calculate', hc: 32, ac: 30, fl: 6.5 }],
      ['efw.save', { action: 'efw.save', gestationalWeek: 32, hc: 32, ac: 30, fl: 6.5, operationId: mkop() }],
      ['efw.delete', { action: 'efw.delete', recordId: seed.data.record.recordId, expectedRevision: 1, operationId: mkop() }],
      ['efw.list', { action: 'efw.list' }],
    ]
    for (const [label, ev] of probes) {
      const r = await st.call(ev)
      assert.ok(!r.ok && r.code === 'not-family-member', `${label} 第三身份须拒（实得 ${r.code}）`)
    }
    assert.equal(docCount(st), before, '零新文档')
    assert.equal(versionSnapshot(st), beforeV, '零版本写')
  })

  await scenario('X2 跨家庭分区：列表空/实体 not-found/数据零泄漏', async () => {
    const st = makeStack('mama')
    const seed = await st.call({ action: 'efw.save', gestationalWeek: 32, hc: 32, ac: 30, fl: 6.5, operationId: mkop() })
    assert.ok(seed.ok)
    const origFam = process.env.MC_FAMILY_ID
    process.env.MC_FAMILY_ID = 'fam-other-xyz'
    try {
      const lst = await st.call({ action: 'efw.list' })
      assert.ok(lst.ok && lst.data.records.length === 0, '跨家庭 list 空')
      const del = await st.call({ action: 'efw.delete', recordId: seed.data.record.recordId, expectedRevision: 1, operationId: mkop() })
      assert.ok(!del.ok && del.code === 'not-found', '跨家庭删除 not-found')
      // 另家庭保存自成分区（互不可见）
      const other = await st.call({ action: 'efw.save', gestationalWeek: 20, hc: 20, ac: 20, fl: 4, operationId: mkop() })
      assert.ok(other.ok, '另家庭分区保存成功')
      const lst2 = await st.call({ action: 'efw.list' })
      assert.equal(lst2.data.records.length, 1, '另家庭只见自己的记录')
    } finally { process.env.MC_FAMILY_ID = origFam }
    const lst3 = await st.call({ action: 'efw.list' })
    assert.equal(lst3.data.records.length, 1, '复原后原家庭数据完整（只见自己分区）')
  })

  await scenario('Z9 冻结源哈希：套件运行期间 mc-tools 源未被并发编辑', async () => {
    for (const [rel, h] of Object.entries(frozenHashes)) {
      const now = sha256(fs.readFileSync(path.join(root, rel)))
      assert.equal(now, h, `${rel} 运行期间被并发编辑——结果作废须复跑`)
    }
  })

  console.log(`\n${passed} 通过, ${failed.length} 失败`)
  if (failed.length) { console.log('失败项：'); for (const f of failed) console.log(` - ${f}`); process.exit(1) }
  process.exit(0)
}

main().catch(e => { console.error('套件异常:', e); process.exit(2) })
