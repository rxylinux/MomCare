// Phase G flash 迁移回归：DeepSeek 请求体参数锁 + MC_DEEPSEEK_MODEL 白名单 + kind 如实化 mock 回归。
// 规格 docs/PHASE_G_DEEPSEEK_FLASH_MIGRATION_SPEC.md——零真实外呼：
// 参数回归全部锁在 __deepseekRequestBody 纯函数层；AI 动作走 mock 注入。
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

const DIST = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-gfm-')), 'cf')
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

// 冻结源哈希（加载时快照 + 结尾复检——测试跑的就是当前工作区源码）
const FROZEN_RELS = ['cloud/functions/mc-tools/index.js']
const frozenHashes = Object.fromEntries(FROZEN_RELS.map(rel => [rel, sha256(fs.readFileSync(path.join(root, rel)))]))
console.log('冻结源哈希（加载时快照）:')
for (const [rel, h] of Object.entries(frozenHashes)) console.log(`  ${h.slice(0, 8)}  ${rel}`)

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-gfm', MC_MEMBER_MAMA_OPENID: 'oGFMMAMA1234567', MC_MEMBER_PAPA_OPENID: 'oGFMPAPA1234567' }

// 内存 mock 云（db/事务语义与 phase-g-server 同款，供 ai.analyzeReport 全链路）
function makeMockCloud() {
  const docs = new Map()
  const state = { caller: TEST_ENV.MC_MEMBER_MAMA_OPENID, initialized: false }
  const clone = x => JSON.parse(JSON.stringify(x))
  function docApi(col, id, tx) {
    return {
      get: async () => { const e = docs.get(`${col}/${id}`); if (tx) tx.reads.set(`${col}/${id}`, e ? e.__v : 0); return { data: e ? { ...clone(e), _id: id } : null } },
      set: async ({ data }) => {
        if (tx) { tx.writes.set(`${col}/${id}`, clone(data)); return { _id: id } }
        const prev = docs.get(`${col}/${id}`)
        docs.set(`${col}/${id}`, { ...clone(data), __v: (prev ? prev.__v : 0) + 1 }); return { _id: id }
      },
      remove: async () => { if (tx) { tx.removes.add(`${col}/${id}`); return {} } docs.delete(`${col}/${id}`); return {} }
    }
  }
  const db = {
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
    collection: c => ({ doc: id => docApi(c, id, null) })
  }
  return {
    DYNAMIC_CURRENT_ENV: Symbol('env'), init() { state.initialized = true },
    getWXContext: () => ({ APPID: TEST_ENV.MC_APPID, OPENID: state.caller }),
    database() { if (!state.initialized) throw new Error('init first'); return db },
    __docs: docs, __state: state,
  }
}

function makeStack() {
  const cloud = makeMockCloud()
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.MC_OCR_PROVIDER
  delete process.env.MC_DEEPSEEK_MODEL
  const tools = requireHandler()
  tools.__setCloud(cloud)
  return { cloud, tools, call: e => tools.main(e) }
}

const PROMPT_SAMPLE = '用户提问（孕期饮食/行为安全）：三文鱼（孕期阶段：孕中期）'

async function main() {
  console.log('Phase G flash 迁移回归（DeepSeek 请求体参数锁 → 零外呼）\n')
  const tools0 = requireHandler()
  delete process.env.MC_DEEPSEEK_MODEL

  await scenario('FM1 缺省请求体：flash + thinking 显式关 + 采样参数 + 双消息结构', async () => {
    const body = tools0.__deepseekRequestBody(PROMPT_SAMPLE)
    assert.equal(body.model, 'deepseek-flash', '缺省模型 deepseek-flash')
    assert.deepEqual(body.thinking, { type: 'disabled' }, 'thinking 恰为 {type:"disabled"}——V4 默认开必须显式关')
    assert.equal(body.temperature, 0.3, 'temperature 0.3（关思考后恢复生效）')
    assert.equal(body.max_tokens, 800, 'explainFood 档缺省 800')
    assert.ok(Array.isArray(body.messages) && body.messages.length === 2, '双消息')
    assert.equal(body.messages[0].role, 'system')
    assert.ok(body.messages[0].content.startsWith('你是孕期健康信息助手'), 'system=safetySystemPrompt 原文')
    assert.equal(body.messages[1].role, 'user')
    assert.equal(body.messages[1].content, PROMPT_SAMPLE, 'user=prompt 原文（不加工）')
    assert.ok(!('model' in body && body.model === 'deepseek-chat'), '旧停用模型名绝不再出现')
  })

  await scenario('FM2 max_tokens 分档：1600 透传；非整数一律回落 800', async () => {
    assert.equal(tools0.__deepseekRequestBody('p', { maxTokens: 1600 }).max_tokens, 1600, 'analyzeReport 档 1600')
    assert.equal(tools0.__deepseekRequestBody('p', {}).max_tokens, 800, '空 opts 回落 800')
    assert.equal(tools0.__deepseekRequestBody('p').max_tokens, 800, '无 opts 回落 800')
    assert.equal(tools0.__deepseekRequestBody('p', { maxTokens: '1600' }).max_tokens, 800, '字符串拒（Number.isInteger=false）')
    assert.equal(tools0.__deepseekRequestBody('p', { maxTokens: 12.5 }).max_tokens, 800, '小数拒')
    assert.equal(tools0.__deepseekRequestBody('p', { maxTokens: 0 }).max_tokens, 800, '0/负数拒（非正整数语义同拒）')
    assert.equal(tools0.__deepseekRequestBody('p', { maxTokens: -5 }).max_tokens, 800, '负数拒')
  })

  await scenario('FM3 MC_DEEPSEEK_MODEL 白名单：合法切换 / 非法回落 / unset 缺省', async () => {
    try {
      process.env.MC_DEEPSEEK_MODEL = 'deepseek-v4-pro'
      assert.equal(tools0.__deepseekRequestBody('p').model, 'deepseek-v4-pro', '白名单值切换生效')
      process.env.MC_DEEPSEEK_MODEL = 'deepseek-chat'
      assert.equal(tools0.__deepseekRequestBody('p').model, 'deepseek-flash', '已停用旧名非白名单 → 回落缺省（warn 不挡服务）')
      process.env.MC_DEEPSEEK_MODEL = ''
      assert.equal(tools0.__deepseekRequestBody('p').model, 'deepseek-flash', '空串回落缺省')
      delete process.env.MC_DEEPSEEK_MODEL
      assert.equal(tools0.__deepseekRequestBody('p').model, 'deepseek-flash', 'unset 缺省')
    } finally {
      delete process.env.MC_DEEPSEEK_MODEL
    }
  })

  await scenario('FM4 ai.explainFood mock 模式：响应 model 如实 "mock"（kind 改名无泄漏）', async () => {
    const st = makeStack()
    st.tools.__setAiMock(async () => 'FM-MOCK：一般安全，注意彻底煮熟。')
    const r = await st.call({ action: 'ai.explainFood', query: '三文鱼', stage: '孕中期' })
    assert.ok(r.ok && r.data.enabled === true, 'mock 启用')
    assert.equal(r.data.model, 'mock', 'mock 模式 model="mock" 不变')
    st.tools.__setAiMock(null)
  })

  await scenario('FM5 ai.analyzeReport mock 模式：ai_result.model 落库 "mock"（全链路含 CAS 回写）', async () => {
    const st = makeStack()
    st.cloud.__docs.set('mc_reports/rpt_fm5', {
      familyId: TEST_ENV.MC_FAMILY_ID, deleted: false,
      dateKey: '2026-09-12', reportType: 'ultrasound', note: '孕 32 周超声',
      attachments: [], revision: 1, updatedBy: 'mama', updatedAt: 1, __v: 1
    })
    st.tools.__setAiMock(async () => 'FM-MOCK 解读：整体与孕周相符。')
    const r = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_fm5' })
    assert.ok(r.ok && r.data.enabled === true, 'mock 启用')
    assert.equal(r.data.model, 'mock', '响应 model="mock"')
    assert.equal(r.data.ocrIncluded, false, '无附件元数据模式（不涉 OCR）')
    const doc = st.cloud.__docs.get('mc_reports/rpt_fm5')
    assert.ok(doc.ai_result && doc.ai_result.model === 'mock' && doc.ai_result.text.includes('FM-MOCK'), 'ai_result.model 落库 mock')
    assert.equal(doc.revision, 2, 'revision+1')
    st.tools.__setAiMock(null)
  })

  // 运行内护栏：套件跑的确实是加载时快照的同一份源码（防"测的是旧码"假绿）
  for (const [rel, h] of Object.entries(frozenHashes)) {
    const cur = sha256(fs.readFileSync(path.join(root, rel)))
    if (cur !== h) { fail(`冻结哈希漂移 ${rel}`, new Error(`加载 ${h.slice(0, 8)} ≠ 结尾 ${cur.slice(0, 8)}`)) }
  }

  console.log(`\n结果: ${passed} 通过, ${failed.length} 失败`)
  if (failed.length) process.exit(1)
}

main().catch(e => { console.error('套件异常:', e); process.exit(2) })
