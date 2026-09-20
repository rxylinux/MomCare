// Phase G 服务端契约回归：mc-tools ai.analyzeReport 的 OCR 提取流水线（mock 注入，零真实外呼）。
// 覆盖：OCR 未启用元数据模式；wechat 提供方多页提取+prompt 拼接+ocr_result CAS 回写；
// 超长截断；任一页失败整次失败（不调 AI、不写库）；附件登记门（invalid-attachment）；
// 缓存复用（不重复识别）；附件集合变化重新识别；页数上限；tencent 缺密钥 fail-closed 不降级；
// config.json 云调用权限；客户端接线契约（report.js ocr_text / ai-result 展示 / detail 入口）。
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

const DIST = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-g-')), 'cf')
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

const FROZEN_RELS = [
  'cloud/functions/mc-tools/index.js',
  'cloud/functions/mc-tools/config.json',
  'cloud/assemble.mjs',
  'stores/report.js'
]
const frozenHashes = Object.fromEntries(FROZEN_RELS.map(rel => [rel, sha256(fs.readFileSync(path.join(root, rel)))]))
console.log('冻结源哈希（加载时快照）:')
for (const [rel, h] of Object.entries(frozenHashes)) console.log(`  ${h.slice(0, 8)}  ${rel}`)

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-pg', MC_MEMBER_MAMA_OPENID: 'oPGMAMA1234567', MC_MEMBER_PAPA_OPENID: 'oPGPAPA1234567', MC_INTRUDER_OPENID: 'oPGINTRUDER777' }
const OCR_TEXT_MAX = 2000
const OCR_TRUNCATED_SUFFIX = '…（OCR 文本超长已截断）'

function makeMockCloud() {
  const docs = new Map()
  const state = {
    caller: TEST_ENV.MC_MEMBER_MAMA_OPENID, initialized: false,
    ocrHandler: null, ocrCalls: [], // openapi ocr.printedText 计数与入参
  }
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
    getTempFileURL: async ({ fileList }) => ({
      fileList: fileList.map(fileID => ({ fileID, tempFileURL: 'https://turl.example/' + encodeURIComponent(fileID) }))
    }),
    downloadFile: async () => { throw new Error('downloadFile unexpected in phase-g suite') },
    openapi: {
      ocr: {
        printedText: async params => {
          state.ocrCalls.push(params)
          if (!state.ocrHandler) throw new Error('ocr handler not configured')
          return state.ocrHandler(params)
        }
      }
    },
    __docs: docs, __state: state,
    __setCtx(o) { state.caller = o },
    __setOcr(fn) { state.ocrHandler = fn },
  }
}

function makeStack(member = 'mama') {
  const cloud = makeMockCloud()
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.MC_OCR_PROVIDER
  delete process.env.MC_OCR_TENCENT_SECRET_ID
  delete process.env.MC_OCR_TENCENT_SECRET_KEY
  cloud.__setCtx(member === 'mama' ? TEST_ENV.MC_MEMBER_MAMA_OPENID : member === 'papa' ? TEST_ENV.MC_MEMBER_PAPA_OPENID : member)
  const tools = requireHandler()
  tools.__setCloud(cloud)
  return { cloud, tools, call: e => tools.main(e) }
}

// 种子：已登记附件 f1/f2（f3 供页数上限/集合变化用，f_bad 未登记，f_xfamily 跨家庭）
function seedFamily(st) {
  const F = TEST_ENV.MC_FAMILY_ID
  const mkFile = (id, fam, status, formal) => st.cloud.__docs.set(`mc_files/${id}`, { familyId: fam, status, formalFileID: formal, __v: 1 })
  mkFile('f1', F, 'registered', 'cloud://env/formal/f1')
  mkFile('f2', F, 'registered', 'cloud://env/formal/f2')
  mkFile('f3', F, 'registered', 'cloud://env/formal/f3')
  mkFile('f4', F, 'registered', 'cloud://env/formal/f4')
  mkFile('f5', F, 'registered', 'cloud://env/formal/f5')
  mkFile('f_cleaning', F, 'cleaning', 'cloud://env/formal/f_cleaning')
  mkFile('f_xfamily', 'fam-other', 'registered', 'cloud://env/formal/f_xfamily')
}
function mkReport(st, id, attachments, extra = {}) {
  st.cloud.__docs.set(`mc_reports/${id}`, {
    familyId: TEST_ENV.MC_FAMILY_ID, deleted: false,
    dateKey: '2026-09-12', reportType: 'ultrasound', note: '孕 32 周超声',
    attachments, revision: 1, updatedBy: 'mama', updatedAt: 1, __v: 1, ...extra
  })
}
// wechat 提供方 + 可控 OCR handler（按 fileID 映射页面文本；throwOn 命中即抛——模拟单页失败）
function armWechatOcr(st, pageTextByFile, throwOn = null) {
  process.env.MC_OCR_PROVIDER = 'wechat'
  st.cloud.__setOcr(({ img_url }) => {
    const fileID = decodeURIComponent(String(img_url || '').replace('https://turl.example/', ''))
    if (throwOn && fileID.endsWith(throwOn)) throw new Error('mock-ocr-down')
    const lines = pageTextByFile[fileID]
    if (!lines) throw new Error('unexpected fileID: ' + fileID)
    return { errCode: 0, words_result: lines.map(w => ({ words: w })) }
  })
}
function armAi(st, answer = 'G-MOCK 解读：整体与孕周相符，建议按时复诊。') {
  const calls = []
  st.tools.__setAiMock(async (prompt, ctx) => { calls.push({ prompt, ctx }); return answer })
  return calls
}

async function main() {
  console.log('Phase G 服务端契约回归（mc-tools ai.analyzeReport OCR 流水线 → mock 云）\n')

  await scenario('G1 OCR 未启用：附件在场仍走元数据模式，不写 ocr_result', async () => {
    const st = makeStack()
    seedFamily(st)
    mkReport(st, 'rpt_g1', [{ fileId: 'f1' }])
    const aiCalls = armAi(st)
    const r = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_g1' })
    assert.ok(r.ok && r.data.enabled === true, 'AI mock 启用')
    assert.equal(r.data.ocrIncluded, false, 'ocrIncluded=false（元数据模式）')
    assert.equal(r.data.ocrText, '', 'ocrText 空串')
    assert.equal(st.cloud.__state.ocrCalls.length, 0, '零 OCR 调用')
    assert.ok(!aiCalls[0].prompt.includes('OCR 提取文本'), 'prompt 不含 OCR 段')
    const doc = st.cloud.__docs.get('mc_reports/rpt_g1')
    assert.ok(doc.ocr_result === undefined, '不写 ocr_result')
    assert.equal(doc.revision, 2, 'revision+1（仅 ai_result）')
  })

  await scenario('G2 wechat 提供方 + 无附件：元数据模式，不触发 OCR', async () => {
    const st = makeStack()
    seedFamily(st)
    mkReport(st, 'rpt_g2', [])
    const aiCalls = armAi(st)
    process.env.MC_OCR_PROVIDER = 'wechat'
    st.cloud.__setOcr(() => { throw new Error('should not be called') })
    const r = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_g2' })
    assert.ok(r.ok && r.data.enabled === true)
    assert.equal(r.data.ocrIncluded, false, '无附件 → ocrIncluded=false')
    assert.equal(st.cloud.__state.ocrCalls.length, 0, '零 OCR 调用')
    assert.ok(!aiCalls[0].prompt.includes('OCR 提取文本'))
  })

  await scenario('G3 wechat 两页提取：临时 URL→printedText×2→prompt 拼接→ocr_result CAS 回写', async () => {
    const st = makeStack()
    seedFamily(st)
    mkReport(st, 'rpt_g3', [{ fileId: 'f1' }, { fileId: 'f2' }])
    const aiCalls = armAi(st)
    armWechatOcr(st, {
      'cloud://env/formal/f1': ['双顶径 8.4cm', '股骨长 6.5cm'],
      'cloud://env/formal/f2': ['羊水指数 14.2cm', '胎盘位置：前壁']
    })
    const r = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_g3' })
    assert.ok(r.ok && r.data.enabled === true, '启用')
    assert.equal(r.data.ocrIncluded, true, 'ocrIncluded=true')
    // 页序与文本：两页拼接、页间换行
    assert.ok(r.data.ocrText.includes('双顶径 8.4cm') && r.data.ocrText.includes('羊水指数 14.2cm'), 'ocrText 含两页文本')
    assert.ok(r.data.ocrText.indexOf('双顶径') < r.data.ocrText.indexOf('羊水指数'), '页序保持')
    // openapi 入参走临时 URL
    assert.equal(st.cloud.__state.ocrCalls.length, 2, 'printedText 恰两次')
    for (const c of st.cloud.__state.ocrCalls) assert.ok(String(c.img_url).startsWith('https://turl.example/'), 'img_url 为临时 URL')
    // prompt：元数据 + OCR 文本 + 防编造指令
    const p = aiCalls[0].prompt
    assert.ok(p.includes('2026-09-12') && p.includes('ultrasound'), 'prompt 仍含元数据')
    assert.ok(p.includes('双顶径 8.4cm') && p.includes('胎盘位置：前壁'), 'prompt 含 OCR 文本')
    assert.ok(p.includes('不得编造'), 'prompt 含防编造指令')
    assert.equal(aiCalls[0].ctx.ocrIncluded, true, 'ctx 标注 ocrIncluded')
    assert.ok(!p.includes('mood') && !p.includes('privateNotes'), 'prompt 不含私人域字段')
    // ocr_result 回写（CAS 事务）+ revision
    const doc = st.cloud.__docs.get('mc_reports/rpt_g3')
    assert.equal(doc.revision, 2, 'revision+1')
    assert.ok(doc.ai_result && doc.ai_result.text.includes('G-MOCK'), 'ai_result 回写')
    assert.deepEqual(doc.ocr_result.pageFileIds, ['f1', 'f2'], 'pageFileIds 页序')
    assert.equal(doc.ocr_result.included, true)
    assert.equal(doc.ocr_result.provider, 'wechat')
    assert.ok(Number.isInteger(doc.ocr_result.generatedAt), 'generatedAt')
    assert.equal(doc.ocr_result.text, r.data.ocrText, '入库文本与回传一致')
  })

  await scenario('G4 OCR 超长截断：>2000 字符截断并标注', async () => {
    const st = makeStack()
    seedFamily(st)
    mkReport(st, 'rpt_g4', [{ fileId: 'f1' }])
    armAi(st)
    const giant = '指'.repeat(3000)
    armWechatOcr(st, { 'cloud://env/formal/f1': [giant] })
    const r = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_g4' })
    assert.ok(r.ok && r.data.ocrIncluded === true)
    assert.equal(Array.from(r.data.ocrText).length, OCR_TEXT_MAX + Array.from(OCR_TRUNCATED_SUFFIX).length, '截断后长度=上限+后缀')
    assert.ok(r.data.ocrText.endsWith(OCR_TRUNCATED_SUFFIX), '截断后缀在场')
    const doc = st.cloud.__docs.get('mc_reports/rpt_g4')
    assert.equal(doc.ocr_result.text, r.data.ocrText, '入库即截断文本')
  })

  await scenario('G5 任一页失败：整次 ocr-call-failed，不调 AI、不写库', async () => {
    const st = makeStack()
    seedFamily(st)
    mkReport(st, 'rpt_g5', [{ fileId: 'f1' }, { fileId: 'f2' }])
    const aiCalls = armAi(st)
    armWechatOcr(st, { 'cloud://env/formal/f1': ['第一页正常'] }, '/f2')
    const r = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_g5' })
    assert.ok(!r.ok && r.code === 'ocr-call-failed', `整次失败（实得 ${r.code}）`)
    assert.ok(String(r.message).includes('OCR'), '失败信息如实')
    assert.equal(aiCalls.length, 0, 'AI 未被调用（OCR 失败不产生半成品解读）')
    const doc = st.cloud.__docs.get('mc_reports/rpt_g5')
    assert.equal(doc.revision, 1, 'revision 未推进')
    assert.ok(doc.ai_result === undefined && doc.ocr_result === undefined, '零写入')
  })

  await scenario('G6 附件登记门：未登记/清理中/跨家庭 → invalid-attachment', async () => {
    const st = makeStack()
    seedFamily(st)
    mkReport(st, 'rpt_g6a', [{ fileId: 'f_ghost' }])
    mkReport(st, 'rpt_g6b', [{ fileId: 'f_cleaning' }])
    mkReport(st, 'rpt_g6c', [{ fileId: 'f_xfamily' }])
    armAi(st)
    armWechatOcr(st, {})
    const a = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_g6a' })
    assert.ok(!a.ok && a.code === 'invalid-attachment', `不存在拒（实得 ${a.code}）`)
    const b = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_g6b' })
    assert.ok(!b.ok && b.code === 'invalid-attachment', `清理中拒（实得 ${b.code}）`)
    const c = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_g6c' })
    assert.ok(!c.ok && c.code === 'invalid-attachment', `跨家庭拒（实得 ${c.code}）`)
    assert.equal(st.cloud.__state.ocrCalls.length, 0, '零 OCR 调用（门在识别前）')
  })

  await scenario('G7 缓存复用：同附件集合二次调用不重复识别', async () => {
    const st = makeStack()
    seedFamily(st)
    mkReport(st, 'rpt_g7', [{ fileId: 'f1' }, { fileId: 'f2' }])
    const aiCalls = armAi(st)
    armWechatOcr(st, {
      'cloud://env/formal/f1': ['双顶径 8.4cm'],
      'cloud://env/formal/f2': ['羊水指数 14.2cm']
    })
    const r1 = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_g7' })
    assert.ok(r1.ok && r1.data.ocrIncluded === true)
    const callsAfterFirst = st.cloud.__state.ocrCalls.length
    const genAfterFirst = st.cloud.__docs.get('mc_reports/rpt_g7').ocr_result.generatedAt
    const r2 = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_g7' })
    assert.ok(r2.ok && r2.data.ocrIncluded === true)
    assert.equal(st.cloud.__state.ocrCalls.length, callsAfterFirst, 'printedText 计数不增（复用）')
    assert.equal(aiCalls.length, 2, 'AI 每次都调（解读重新生成）')
    assert.equal(r2.data.ocrText, r1.data.ocrText, '复用文本一致')
    const doc2 = st.cloud.__docs.get('mc_reports/rpt_g7')
    assert.equal(doc2.ocr_result.generatedAt, genAfterFirst, 'generatedAt 保留首次值')
  })

  await scenario('G8 附件集合变化：缓存失效重新识别', async () => {
    const st = makeStack()
    seedFamily(st)
    mkReport(st, 'rpt_g8', [{ fileId: 'f1' }, { fileId: 'f2' }])
    const aiCalls = armAi(st)
    armWechatOcr(st, {
      'cloud://env/formal/f1': ['双顶径 8.4cm'],
      'cloud://env/formal/f2': ['羊水指数 14.2cm']
    })
    await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_g8' })
    assert.equal(st.cloud.__state.ocrCalls.length, 2)
    // 用户删除第二张附件（集合变化——同 revision 直改模拟并发外编辑）
    const doc = st.cloud.__docs.get('mc_reports/rpt_g8')
    doc.attachments = [{ fileId: 'f1' }]
    const r2 = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_g8' })
    assert.ok(r2.ok && r2.data.ocrIncluded === true)
    assert.equal(st.cloud.__state.ocrCalls.length, 3, '重新识别（仅剩 1 页）')
    assert.deepEqual(st.cloud.__docs.get('mc_reports/rpt_g8').ocr_result.pageFileIds, ['f1'], 'pageFileIds 更新')
  })

  await scenario('G9 页数上限：5 附件只识别前 3 页', async () => {
    const st = makeStack()
    seedFamily(st)
    mkReport(st, 'rpt_g9', [{ fileId: 'f1' }, { fileId: 'f2' }, { fileId: 'f3' }, { fileId: 'f4' }, { fileId: 'f5' }])
    armAi(st)
    armWechatOcr(st, {
      'cloud://env/formal/f1': ['页1'], 'cloud://env/formal/f2': ['页2'], 'cloud://env/formal/f3': ['页3'],
      'cloud://env/formal/f4': ['页4'], 'cloud://env/formal/f5': ['页5']
    })
    const r = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_g9' })
    assert.ok(r.ok && r.data.ocrIncluded === true)
    assert.equal(st.cloud.__state.ocrCalls.length, 3, '识别页数=3（上限）')
    assert.deepEqual(st.cloud.__docs.get('mc_reports/rpt_g9').ocr_result.pageFileIds, ['f1', 'f2', 'f3'], '只取前三页')
    assert.ok(r.data.ocrText.includes('页3') && !r.data.ocrText.includes('页4'), '文本只含前三页')
  })

  await scenario('G10 tencent 缺密钥：fail-closed 未启用（不降级 wechat、不走元数据伪装）', async () => {
    const st = makeStack()
    seedFamily(st)
    mkReport(st, 'rpt_g10', [{ fileId: 'f1' }])
    const aiCalls = armAi(st)
    process.env.MC_OCR_PROVIDER = 'tencent' // 未配 SECRET_ID/KEY
    st.cloud.__setOcr(() => { throw new Error('should not be called') })
    const r = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_g10' })
    assert.ok(r.ok && r.data.enabled === true, 'AI 照常（独立开关）')
    assert.equal(r.data.ocrIncluded, false, 'OCR 未启用（缺密钥不降级）')
    assert.equal(st.cloud.__state.ocrCalls.length, 0, '零 wechat 调用（无静默降级）')
    assert.ok(!aiCalls[0].prompt.includes('OCR 提取文本'), 'prompt 不含 OCR 段')
  })

  await scenario('G11 非成员鉴权：OCR 流水线同样受身份门保护', async () => {
    const st = makeStack()
    seedFamily(st)
    mkReport(st, 'rpt_g11', [{ fileId: 'f1' }])
    armAi(st)
    armWechatOcr(st, { 'cloud://env/formal/f1': ['双顶径 8.4cm'] })
    st.cloud.__setCtx(TEST_ENV.MC_INTRUDER_OPENID)
    const r = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_g11' })
    assert.ok(!r.ok && r.code === 'not-family-member', '第三身份拒')
    assert.equal(st.cloud.__state.ocrCalls.length, 0, '零 OCR 调用')
  })

  await scenario('G12 config.json 云调用权限：ocr.printedText 在场且可解析', async () => {
    const cfgPath = path.join(root, 'cloud/functions/mc-tools/config.json')
    assert.ok(fs.existsSync(cfgPath), 'config.json 存在')
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    assert.ok(cfg.permissions && Array.isArray(cfg.permissions.openapi) && cfg.permissions.openapi.includes('ocr.printedText'),
      `openapi 权限含 ocr.printedText（实得 ${JSON.stringify(cfg)}）`)
  })

  await scenario('G13 客户端接线契约：ocr_text 存服务端原文 + ai-result 展示 + detail 正式态入口', async () => {
    const reportSrc = fs.readFileSync(path.join(root, 'stores/report.js'), 'utf8')
    assert.ok(reportSrc.includes("ocr_text: typeof data.ocrText === 'string' ? data.ocrText : ''"),
      'report.js ocr_text ← data.ocrText（修复旧占位）')
    assert.ok(!reportSrc.includes('ocr_text: String(data.answer'), '旧占位（AI 回答误存 ocr_text）已移除')
    const aiResultSrc = fs.readFileSync(path.join(root, 'pages/archives/ai-result.vue'), 'utf8')
    assert.ok(aiResultSrcSrcOk(aiResultSrc), 'ai-result.vue 按 ai_status===done 展示 + OCR 原文区在场')
    const detailSrc = fs.readFileSync(path.join(root, 'pages/archives/detail.vue'), 'utf8')
    assert.ok(detailSrc.includes('triggerAiPipeline'), 'detail.vue 正式态走云端管线')
    assert.ok(!/ai-card-disabled' \/\/ 非 demo/.test(detailSrc), '正式态硬封锁类名已移除')
    function aiResultSrcSrcOk(src) {
      return src.includes("report.value.ai_status === 'done' && report.value.ai_result") &&
        src.includes('报告原文提取（OCR）') && src.includes('ocrText')
    }
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
