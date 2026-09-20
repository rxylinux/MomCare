// Phase E3 服务端契约回归：mc-tools food.search + ai.explainFood + ai.analyzeReport（mock 注入）。
// 覆盖：词条检索命中/同义词/条件过滤/未命中空（零假安全）；AI 未配置优雅 fallback（enabled:false 原文）；
// mock 注入返回+强制免责；超长 query 拦截；身份鉴权；报告不存在/跨家庭/软删拦截；ai_result 回写；
// 双源词条库（companion js ↔ static json）deepEqual 防漂移。
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

const DIST = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-e3s-')), 'cf')
{
  const dir = path.join(DIST, 'mc-tools'); fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(path.join(root, 'cloud/functions/mc-tools/index.js'), path.join(dir, 'index.js'))
  fs.copyFileSync(path.join(root, 'cloud/functions/mc-tools/food-safety-data.js'), path.join(dir, 'food-safety-data.js'))
  fs.cpSync(path.join(root, 'cloud/shared'), path.join(dir, 'shared'), { recursive: true })
}
function requireHandler() {
  delete require.cache[require.resolve(path.join(DIST, 'mc-tools/index.js'))]
  return require(path.join(DIST, 'mc-tools/index.js'))
}

const FROZEN_RELS = ['cloud/functions/mc-tools/index.js', 'cloud/functions/mc-tools/food-safety-data.js', 'static/data/food-safety.json']
const frozenHashes = Object.fromEntries(FROZEN_RELS.map(rel => [rel, sha256(fs.readFileSync(path.join(root, rel)))]))
console.log('冻结源哈希（加载时快照）:')
for (const [rel, h] of Object.entries(frozenHashes)) console.log(`  ${h.slice(0, 8)}  ${rel}`)

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-e3s', MC_MEMBER_MAMA_OPENID: 'oE3SMAMA123456', MC_MEMBER_PAPA_OPENID: 'oE3SPAPA123456', MC_INTRUDER_OPENID: 'oE3SINTRUDER6666' }

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
  delete process.env.DEEPSEEK_API_KEY
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

async function main() {
  console.log('Phase E3 服务端契约回归（mc-tools food.search / ai.* → mock 云）\n')

  await scenario('D0 双源词条库一致：companion js ↔ static json 逐字段 deepEqual', async () => {
    const companion = require(path.join(DIST, 'mc-tools/food-safety-data.js'))
    const staticJson = JSON.parse(fs.readFileSync(path.join(root, 'static/data/food-safety.json'), 'utf8'))
    assert.deepEqual(companion, staticJson, '双源词条库漂移——须同步 static/data/food-safety.json 与 food-safety-data.js')
    assert.ok(companion.length >= 13, `高频词条 ≥13（实得 ${companion.length}）`)
    // 必收词条（任务清单）逐项在场
    const names = companion.map(e => e.name + '|' + e.synonyms.join('|')).join('\n')
    for (const must of ['三文鱼', '刺身', '溏心蛋', '全熟蛋', '咖啡', '巴氏', '乳酪', '金枪鱼', '温泉', '烫发', '麻醉', 'X 光', '乘机']) {
      assert.ok(names.includes(must) || companion.some(e => String(e.name).includes(must)), `必收词条「${must}」在场`)
    }
    // 严格字段齐备
    for (const e of companion) {
      for (const k of ['id', 'name', 'category', 'level', 'synonyms', 'summary', 'conditions', 'risks', 'source', 'sourceUrl', 'reviewedAt', 'version']) {
        assert.ok(e[k] !== undefined, `${e.id} 缺字段 ${k}`)
      }
    }
  })

  await scenario('F1 food.search：命中/同义词/条件过滤/未命中空', async () => {
    const st = makeStack('mama')
    // 关键词命中 name 与 synonyms
    const r1 = await st.call({ action: 'food.search', keyword: '刺身' })
    assert.ok(r1.ok && r1.data.items.length === 1 && r1.data.items[0].id === 'food_sashimi_raw_fish', `刺身命中（实得 ${JSON.stringify(r1.data.items.map(x => x.id))}）`)
    const r2 = await st.call({ action: 'food.search', keyword: '溏心蛋' })
    assert.ok(r2.data.items.length === 1 && r2.data.items[0].id === 'food_raw_egg_soft', '同义词「溏心蛋」→ 生鸡蛋条目')
    const r3 = await st.call({ action: 'food.search', keyword: '拿铁' })
    assert.ok(r3.data.items.length === 1 && r3.data.items[0].id === 'food_caffeine', '同义词「拿铁」→ 咖啡条目')
    // 未命中：空数组——绝不假造
    const r4 = await st.call({ action: 'food.search', keyword: '河豚毒素不存在词条XYZ' })
    assert.ok(r4.ok && r4.data.items.length === 0 && r4.data.total === 0, `未命中空（实得 ${JSON.stringify(r4.data)}）`)
    // 条件过滤：category × level 组合
    const beh = await st.call({ action: 'food.search', category: 'behavior' })
    assert.ok(beh.data.items.length >= 4 && beh.data.items.every(x => x.category === 'behavior'), '行为类过滤')
    const avoidFood = await st.call({ action: 'food.search', category: 'food', level: 'avoid' })
    assert.ok(avoidFood.data.items.every(x => x.level === 'avoid' && x.category === 'food') && avoidFood.data.items.length >= 3, `食物×避免过滤（实得 ${avoidFood.data.items.map(x => x.name)}）`)
    const kwAndCat = await st.call({ action: 'food.search', keyword: '蛋', category: 'food' })
    assert.ok(kwAndCat.data.items.length >= 2 && kwAndCat.data.items.every(x => x.category === 'food'), '关键词+分类组合')
    // limit 截断与 total 真值
    const limited = await st.call({ action: 'food.search', limit: 3 })
    assert.ok(limited.data.items.length === 3 && limited.data.total >= 13, `limit 截断+total（实得 ${limited.data.items.length}/${limited.data.total}）`)
    // 校验异常
    for (const [label, ev] of [['非法 category', { category: 'drug' }], ['非法 level', { level: 'super' }], ['超长 keyword', { keyword: 'x'.repeat(65) }]]) {
      const r = await st.call({ action: 'food.search', ...ev })
      assert.ok(!r.ok && r.code === 'invalid-params', `${label} 拒（实得 ${r.code}）`)
    }
    assert.equal(docCount(st), 0, '检索零写')
  })

  await scenario('F2 ai.explainFood：未启用 fallback 原文/mock 注入+免责/超长拦截/鉴权', async () => {
    const st = makeStack('mama')
    // 未配置 Key：enabled:false + 规格原文消息
    const off = await st.call({ action: 'ai.explainFood', query: '孕早期能喝咖啡吗' })
    assert.ok(off.ok && off.data.enabled === false, '未启用分支')
    assert.equal(off.data.message, 'AI 服务未配置或未启用，请查阅本地已审定词条或咨询医生', '未启用消息原文（规格 §三.2）')
    assert.equal(off.data.answer, undefined, '未启用不生成答案')
    // mock 注入：结构化结果+强制免责
    const prompts = []
    st.tools.__setAiMock(async (prompt, ctx) => {
      prompts.push({ prompt, ctx })
      return `MOCK 答：${ctx.query} 一般可适量…`
    })
    const on = await st.call({ action: 'ai.explainFood', query: '孕早期能喝咖啡吗', stage: '孕8周' })
    assert.ok(on.ok && on.data.enabled === true, 'mock 启用')
    assert.ok(String(on.data.answer).includes('MOCK 答'), '答案返回')
    assert.equal(on.data.model, 'mock')
    assert.ok(on.data.disclaimer.includes('AI 生成（未人工逐字审校）'), '免责含未审校标签')
    assert.ok(on.data.disclaimer.includes('不构成医疗诊断'), '免责含医疗声明')
    assert.equal(prompts.length, 1, '单次调用')
    assert.ok(prompts[0].prompt.includes('绝不提供处方药剂量'), '安全系统提示注入（禁剂量）')
    assert.ok(prompts[0].prompt.includes('咖啡'), '用户 query 入 prompt')
    // 置空恢复未启用
    st.tools.__setAiMock(null)
    const off2 = await st.call({ action: 'ai.explainFood', query: '咖啡' })
    assert.ok(off2.ok && off2.data.enabled === false, '置 null 恢复未启用分支')
    // query 校验
    for (const [label, q] of [['空串', ''], ['空白', '   '], ['超长 51 字', 'x'.repeat(51)], ['非字符串', 123]]) {
      const r = await st.call({ action: 'ai.explainFood', query: q })
      assert.ok(!r.ok && r.code === 'invalid-params', `${label} 拒（实得 ${r.code}）`)
    }
    const r50 = await st.call({ action: 'ai.explainFood', query: 'x'.repeat(50) })
    assert.ok(r50.ok && r50.data.enabled === false, '恰 50 字过长度门（未启用分支返回）')
    // AI 调用失败
    st.tools.__setAiMock(async () => { throw new Error('boom') })
    const err = await st.call({ action: 'ai.explainFood', query: '咖啡' })
    assert.ok(!err.ok && err.code === 'ai-call-failed', `调用失败如实（实得 ${err.code}）`)
    st.tools.__setAiMock(null)
    // 身份鉴权：非成员
    st.as(TEST_ENV.MC_INTRUDER_OPENID)
    const intr = await st.call({ action: 'ai.explainFood', query: '咖啡' })
    assert.ok(!intr.ok && intr.code === 'not-family-member', `第三身份拒（实得 ${intr.code}）`)
    st.as('mama')
  })

  await scenario('F3 ai.analyzeReport：报告门（不存在/跨家庭/软删）+未启用+mock 回写', async () => {
    const st = makeStack('mama')
    // 不存在
    const ghost = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_not_exist' })
    assert.ok(!ghost.ok && ghost.code === 'report-not-found', `不存在拒（实得 ${ghost.code}）`)
    // 种报告（本家庭活跃/跨家庭/软删三份）
    const mkReport = (id, fam, deleted) => st.cloud.__docs.set(`mc_reports/${id}`, { familyId: fam, deleted: Boolean(deleted), dateKey: '2026-09-10', reportType: 'ultrasound', note: '孕 30 周超声', attachments: [{ fileId: 'f1' }, { fileId: 'f2' }], revision: 1, updatedBy: 'mama', updatedAt: 1, __v: 1 })
    mkReport('rpt_ok', TEST_ENV.MC_FAMILY_ID, false)
    mkReport('rpt_other', 'fam-other', false)
    mkReport('rpt_del', TEST_ENV.MC_FAMILY_ID, true)
    // 跨家庭/软删
    const other = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_other' })
    assert.ok(!other.ok && other.code === 'report-not-found', `跨家庭拒（实得 ${other.code}）`)
    const del = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_del' })
    assert.ok(!del.ok && del.code === 'report-not-found', `软删拒（实得 ${del.code}）`)
    // 未启用 fallback 原文
    const off = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_ok' })
    assert.ok(off.ok && off.data.enabled === false, '未启用分支')
    assert.equal(off.data.message, '报告自动 OCR / DeepSeek 解读服务未配置；请以原始检验单与主治医生诊断为准', '未启用消息原文（规格 §三.3）')
    // mock：回写 ai_result + 免责 + 安全边界（prompt 仅元数据）
    const calls = []
    st.tools.__setAiMock(async (prompt, ctx) => {
      calls.push({ prompt, ctx })
      return 'MOCK 解读：指标总体正常，建议复诊。'
    })
    const on = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_ok' })
    assert.ok(on.ok && on.data.enabled === true, 'mock 启用')
    assert.ok(on.data.answer.includes('MOCK 解读'))
    assert.ok(on.data.disclaimer.includes('AI 生成（未人工逐字审校）'), '强制免责')
    const doc = st.cloud.__docs.get('mc_reports/rpt_ok')
    assert.ok(doc.ai_result && doc.ai_result.text.includes('MOCK 解读') && doc.ai_result.model === 'mock' && Number.isInteger(doc.ai_result.generatedAt), `ai_result 回写（实得 ${JSON.stringify(doc.ai_result)}）`)
    assert.equal(doc.revision, 2, '报告 revision+1')
    // prompt 安全边界：只含元数据（日期/类型/附件数/截断备注），无文件字节/无私人数据字段
    assert.ok(calls[0].prompt.includes('2026-09-10') && calls[0].prompt.includes('ultrasound') && calls[0].prompt.includes('2'), 'prompt 含报告元数据')
    assert.ok(!calls[0].prompt.includes('mood') && !calls[0].prompt.includes('privateNotes'), 'prompt 不含私人域字段')
    assert.equal(calls[0].ctx.attachments, 2, 'ctx 附件计数')
    // 非成员鉴权
    st.tools.__setAiMock(null)
    st.as(TEST_ENV.MC_INTRUDER_OPENID)
    const intr = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_ok' })
    assert.ok(!intr.ok && intr.code === 'not-family-member', '第三身份拒')
    // 参数校验
    st.as('mama')
    const bad = await st.call({ action: 'ai.analyzeReport' })
    assert.ok(!bad.ok && bad.code === 'invalid-params', '缺 reportId 拒')
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
