// Phase G 视觉直读契约回归：mc-tools ai.analyzeReport 的 MC_REPORT_VISION 图片直送 deepseek-flash
// 流水线（mock 注入，零真实外呼）。规格 docs/PHASE_G_VISION_DIRECT_SPEC.md。
// 覆盖：关闭态守卫（行为与 OCR 版一致）；无附件元数据模式；多页下载→多模态请求体→vision_result
// CAS 回写；模型不符 fail-closed；登记门（invalid-attachment）；下载失败/超大（单页与合计）；
// MIME 魔数嗅探（四格式+未支持格式拒）；视觉开启时整体绕过 printedText；页数上限；
// 请求体锁参（无图=旧形状逐字节、有图=官方 vision 块数组）；AI 失败语义不变。
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

const DIST = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-gvis-')), 'cf')
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
]
const frozenHashes = Object.fromEntries(FROZEN_RELS.map(rel => [rel, sha256(fs.readFileSync(path.join(root, rel)))]))
console.log('冻结源哈希（加载时快照）:')
for (const [rel, h] of Object.entries(frozenHashes)) console.log(`  ${h.slice(0, 8)}  ${rel}`)

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-gvis', MC_MEMBER_MAMA_OPENID: 'oGVISMAMA12345', MC_MEMBER_PAPA_OPENID: 'oGVISPAPA12345', MC_INTRUDER_OPENID: 'oGVISINTRUDER77' }

// 与服务端常量对齐（VISION_IMAGE_MAX_BYTES=16MiB / VISION_TOTAL_MAX_BYTES=24MiB）
const VISION_IMAGE_MAX_BYTES = 16 * 1024 * 1024
const VISION_TOTAL_MAX_BYTES = 24 * 1024 * 1024

// 魔数夹具（≥12 字节——嗅探下限；填充字节任意）
function jpegFix(bytes = 24) { return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(Math.max(bytes - 4, 8), 7)]) }
function pngFix() { return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8, 7)]) }
function gifFix() { return Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(8, 7)]) }
function webpFix() { return Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4, 0), Buffer.from('WEBP', 'latin1'), Buffer.alloc(8, 7)]) }

function makeMockCloud() {
  const docs = new Map()
  const state = {
    caller: TEST_ENV.MC_MEMBER_MAMA_OPENID, initialized: false,
    ocrCalls: [], downloadCalls: [],
    downloadBuffers: new Map(), downloadHandler: null,
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
    downloadFile: async ({ fileID }) => {
      state.downloadCalls.push(fileID)
      if (state.downloadHandler) return state.downloadHandler(fileID)
      const buf = state.downloadBuffers.get(fileID)
      if (!buf) throw new Error('no buffer for ' + fileID)
      return { fileContent: buf }
    },
    openapi: {
      ocr: {
        printedText: async params => { state.ocrCalls.push(params); throw new Error('printedText must not be called in vision suite') }
      }
    },
    __docs: docs, __state: state,
    __setCtx(o) { state.caller = o },
    __setDownload(fn) { state.downloadHandler = fn },
  }
}

function makeStack(member = 'mama') {
  const cloud = makeMockCloud()
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.MC_OCR_PROVIDER
  delete process.env.MC_OCR_TENCENT_SECRET_ID
  delete process.env.MC_OCR_TENCENT_SECRET_KEY
  delete process.env.MC_DEEPSEEK_MODEL
  delete process.env.MC_REPORT_VISION
  cloud.__setCtx(member === 'mama' ? TEST_ENV.MC_MEMBER_MAMA_OPENID : member === 'papa' ? TEST_ENV.MC_MEMBER_PAPA_OPENID : member)
  const tools = requireHandler()
  tools.__setCloud(cloud)
  return { cloud, tools, call: e => tools.main(e) }
}

// 种子：已登记附件 f1..f5（默认 JPEG 内容），f_cleaning 清理中，f_xfamily 跨家庭
function seedVision(st) {
  const F = TEST_ENV.MC_FAMILY_ID
  const mkFile = (id, fam, status, formal) => st.cloud.__docs.set(`mc_files/${id}`, { familyId: fam, status, formalFileID: formal, __v: 1 })
  for (let i = 1; i <= 5; i++) {
    const id = 'f' + i
    mkFile(id, F, 'registered', 'cloud://env/formal/' + id)
    st.cloud.__state.downloadBuffers.set('cloud://env/formal/' + id, jpegFix())
  }
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
function armAi(st, answer = 'V-MOCK 解读：整体与孕周相符，建议按时复诊。') {
  const calls = []
  st.tools.__setAiMock(async (prompt, ctx) => { calls.push({ prompt, ctx }); return answer })
  return calls
}

async function main() {
  console.log('Phase G 视觉直读契约回归（mc-tools ai.analyzeReport MC_REPORT_VISION → mock 云）\n')

  await scenario('V1 关闭态守卫：未设 MC_REPORT_VISION + wechat OCR 武装 → OCR 路径照旧、零下载', async () => {
    const st = makeStack()
    seedVision(st)
    mkReport(st, 'rpt_v1', [{ fileId: 'f1' }])
    const aiCalls = armAi(st)
    process.env.MC_OCR_PROVIDER = 'wechat'
    // __setOcrMock 是 provider 层注入口（fn(fileID) → 文本），非 printedText 响应对象
    st.tools.__setOcrMock(() => '双顶径 8.4cm')
    const r = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_v1' })
    assert.ok(r.ok && r.data.enabled === true, '走 OCR 成功路径')
    assert.equal(r.data.ocrIncluded, true, 'ocrIncluded=true（OCR 版行为）')
    assert.ok(aiCalls[0].prompt.includes('双顶径 8.4cm'), 'prompt 含 OCR 文本')
    assert.equal(st.cloud.__state.downloadCalls.length, 0, '零下载（视觉未启用）')
    assert.equal(r.data.visionIncluded, false, 'visionIncluded=false')
  })

  await scenario('V2 视觉开+无附件：元数据模式，零下载、零 OCR、无图片指令', async () => {
    const st = makeStack()
    seedVision(st)
    mkReport(st, 'rpt_v2', [])
    const aiCalls = armAi(st)
    process.env.MC_REPORT_VISION = '1'
    const r = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_v2' })
    assert.ok(r.ok && r.data.enabled === true)
    assert.equal(r.data.ocrIncluded, false, 'ocrIncluded=false')
    assert.equal(r.data.visionIncluded, false, 'visionIncluded=false（无附件→元数据）')
    assert.equal(st.cloud.__state.downloadCalls.length, 0, '零下载')
    assert.equal(st.cloud.__state.ocrCalls.length, 0, '零 OCR')
    assert.ok(!aiCalls[0].prompt.includes('报告图片前'), 'prompt 无图片指令')
    assert.ok(aiCalls[0].ctx.images === undefined, 'ctx 无 images')
    assert.ok(st.cloud.__docs.get('mc_reports/rpt_v2').vision_result === undefined, '不写 vision_result')
  })

  await scenario('V3 视觉开+2 附件全登记：下载×2→多模态 ctx→vision_result 回写、ocr_result 不写', async () => {
    const st = makeStack()
    seedVision(st)
    mkReport(st, 'rpt_v3', [{ fileId: 'f1' }, { fileId: 'f2' }])
    const aiCalls = armAi(st)
    process.env.MC_REPORT_VISION = '1'
    const r = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_v3' })
    assert.ok(r.ok && r.data.enabled === true, '成功')
    assert.deepEqual(st.cloud.__state.downloadCalls, ['cloud://env/formal/f1', 'cloud://env/formal/f2'], '按页序下载 formal 句柄')
    assert.equal(r.data.visionIncluded, true, 'visionIncluded=true')
    assert.equal(r.data.ocrIncluded, false, 'ocrIncluded=false（整体跳过 OCR）')
    assert.equal(r.data.ocrText, '', 'ocrText 空串')
    // ctx.images：mime+base64 与夹具一致
    assert.equal(aiCalls[0].ctx.images.length, 2, 'AI 收到 2 图')
    assert.equal(aiCalls[0].ctx.images[0].mime, 'image/jpeg', 'JPEG 嗅探')
    assert.equal(aiCalls[0].ctx.images[0].base64, jpegFix().toString('base64'), 'base64 为原图字节')
    // prompt：元数据 + 图片指令；不含 OCR 段与私人域
    const p = aiCalls[0].prompt
    assert.ok(p.includes('2026-09-12') && p.includes('ultrasound'), 'prompt 含元数据')
    assert.ok(p.includes('报告图片前 2 张'), 'prompt 含图片页数指令')
    assert.ok(p.includes('不得编造'), '防编造指令在场')
    assert.ok(!p.includes('OCR 提取文本'), '不含 OCR 段')
    // 落库：ai_result + vision_result；ocr_result 不写；revision+1
    const doc = st.cloud.__docs.get('mc_reports/rpt_v3')
    assert.equal(doc.revision, 2, 'revision+1')
    assert.ok(doc.ai_result && doc.ai_result.text.includes('V-MOCK'), 'ai_result 回写')
    assert.ok(doc.ocr_result === undefined, '不写 ocr_result（视觉与 OCR 互斥）')
    assert.equal(doc.vision_result.included, true, 'vision_result.included')
    assert.equal(doc.vision_result.pageCount, 2, 'pageCount=2')
    assert.deepEqual(doc.vision_result.pageFileIds, ['f1', 'f2'], 'pageFileIds 页序')
    assert.ok(Number.isInteger(doc.vision_result.generatedAt), 'generatedAt')
  })

  await scenario('V4 模型门：视觉开+MC_DEEPSEEK_MODEL=deepseek-v4-pro → vision-config-error（fail-closed）', async () => {
    const st = makeStack()
    seedVision(st)
    mkReport(st, 'rpt_v4', [{ fileId: 'f1' }])
    const aiCalls = armAi(st)
    process.env.MC_REPORT_VISION = '1'
    try {
      process.env.MC_DEEPSEEK_MODEL = 'deepseek-v4-pro'
      const r = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_v4' })
      assert.ok(!r.ok && r.code === 'vision-config-error', `实得 ${r.code}`)
      assert.ok(String(r.message).includes('deepseek-flash'), '提示指向 flash')
    } finally { delete process.env.MC_DEEPSEEK_MODEL }
    assert.equal(st.cloud.__state.downloadCalls.length, 0, '零下载')
    assert.equal(aiCalls.length, 0, 'AI 零调用')
  })

  await scenario('V5 登记门：不存在/清理中/跨家庭 → invalid-attachment（与 OCR 同规则）', async () => {
    const st = makeStack()
    seedVision(st)
    mkReport(st, 'rpt_v5a', [{ fileId: 'f_ghost' }])
    mkReport(st, 'rpt_v5b', [{ fileId: 'f_cleaning' }])
    mkReport(st, 'rpt_v5c', [{ fileId: 'f_xfamily' }])
    armAi(st)
    process.env.MC_REPORT_VISION = '1'
    const a = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_v5a' })
    assert.ok(!a.ok && a.code === 'invalid-attachment', `不存在拒（实得 ${a.code}）`)
    const b = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_v5b' })
    assert.ok(!b.ok && b.code === 'invalid-attachment', `清理中拒（实得 ${b.code}）`)
    const c = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_v5c' })
    assert.ok(!c.ok && c.code === 'invalid-attachment', `跨家庭拒（实得 ${c.code}）`)
    assert.equal(st.cloud.__state.downloadCalls.length, 0, '零下载（门在下载前）')
  })

  await scenario('V6 下载失败：抛错 → vision-download-failed，不调 AI、不写库', async () => {
    const st = makeStack()
    seedVision(st)
    mkReport(st, 'rpt_v6', [{ fileId: 'f1' }])
    const aiCalls = armAi(st)
    process.env.MC_REPORT_VISION = '1'
    st.cloud.__setDownload(() => { throw new Error('storage down') })
    const r = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_v6' })
    assert.ok(!r.ok && r.code === 'vision-download-failed', `实得 ${r.code}`)
    assert.ok(String(r.message).includes('第 1 张'), '注明第几张')
    assert.equal(aiCalls.length, 0, 'AI 零调用')
    const doc = st.cloud.__docs.get('mc_reports/rpt_v6')
    assert.equal(doc.revision, 1, 'revision 未推进')
    assert.ok(doc.ai_result === undefined && doc.vision_result === undefined, '零写入')
  })

  await scenario('V7 超大图片：单页超 16MiB / 合计超 24MiB → vision-image-too-large', async () => {
    const st = makeStack()
    seedVision(st)
    mkReport(st, 'rpt_v7a', [{ fileId: 'f1' }])
    mkReport(st, 'rpt_v7b', [{ fileId: 'f1' }, { fileId: 'f2' }])
    armAi(st)
    process.env.MC_REPORT_VISION = '1'
    st.cloud.__state.downloadBuffers.set('cloud://env/formal/f1', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(VISION_IMAGE_MAX_BYTES + 1, 7)]))
    const a = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_v7a' })
    assert.ok(!a.ok && a.code === 'vision-image-too-large', `单页超限（实得 ${a.code}）`)
    assert.ok(String(a.message).includes('第 1 张'), '单页错误注明第几张')
    // 合计：两页各 13MiB（均未超单页 16MiB，合计 26MiB > 24MiB——第二页触发）
    const mid = Buffer.alloc(Math.floor(VISION_TOTAL_MAX_BYTES / 2) + 1024 * 1024, 7)
    const midJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), mid])
    st.cloud.__state.downloadBuffers.set('cloud://env/formal/f1', midJpeg)
    st.cloud.__state.downloadBuffers.set('cloud://env/formal/f2', midJpeg)
    const b = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_v7b' })
    assert.ok(!b.ok && b.code === 'vision-image-too-large', `合计超限（实得 ${b.code}）`)
    assert.ok(String(b.message).includes('合计'), '合计错误如实标注')
    const doc = st.cloud.__docs.get('mc_reports/rpt_v7b')
    assert.equal(doc.revision, 1, '零写入')
  })

  await scenario('V8 MIME 嗅探：四格式魔数→正确 data URI 前缀；未支持格式→vision-unsupported-format', async () => {
    const tools0 = requireHandler()
    assert.equal(tools0.__sniffImageMime(jpegFix()), 'image/jpeg', 'JPEG 魔数')
    assert.equal(tools0.__sniffImageMime(pngFix()), 'image/png', 'PNG 魔数')
    assert.equal(tools0.__sniffImageMime(gifFix()), 'image/gif', 'GIF 魔数')
    assert.equal(tools0.__sniffImageMime(webpFix()), 'image/webp', 'WebP 魔数')
    assert.equal(tools0.__sniffImageMime(Buffer.alloc(32, 9)), null, '乱字节→null（不伪造）')
    assert.equal(tools0.__sniffImageMime(Buffer.alloc(8, 9)), null, '短于下限→null')
    assert.equal(tools0.__sniffImageMime(null), null, '空入参→null')
    // 全链路：HEIC 样（乱字节 12+）→ 如实拒
    const st = makeStack()
    seedVision(st)
    mkReport(st, 'rpt_v8', [{ fileId: 'f1' }])
    armAi(st)
    process.env.MC_REPORT_VISION = '1'
    st.cloud.__state.downloadBuffers.set('cloud://env/formal/f1', Buffer.alloc(64, 9))
    const r = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_v8' })
    assert.ok(!r.ok && r.code === 'vision-unsupported-format', `实得 ${r.code}`)
    assert.ok(String(r.message).includes('JPEG/PNG/GIF/WebP'), '提示支持格式')
  })

  await scenario('V9 视觉开启整体绕过 OCR：wechat 提供方也在场 → printedText 零调用', async () => {
    const st = makeStack()
    seedVision(st)
    mkReport(st, 'rpt_v9', [{ fileId: 'f1' }])
    armAi(st)
    process.env.MC_REPORT_VISION = '1'
    process.env.MC_OCR_PROVIDER = 'wechat' // mock printedText 一被调即抛（makeMockCloud 内建）
    const r = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_v9' })
    assert.ok(r.ok && r.data.visionIncluded === true, '走视觉成功')
    assert.equal(st.cloud.__state.ocrCalls.length, 0, 'printedText 零调用')
    assert.ok(st.cloud.__docs.get('mc_reports/rpt_v9').ocr_result === undefined, '不写 ocr_result')
  })

  await scenario('V10 页数上限：5 附件只直送前 3 页', async () => {
    const st = makeStack()
    seedVision(st)
    mkReport(st, 'rpt_v10', [{ fileId: 'f1' }, { fileId: 'f2' }, { fileId: 'f3' }, { fileId: 'f4' }, { fileId: 'f5' }])
    const aiCalls = armAi(st)
    process.env.MC_REPORT_VISION = '1'
    const r = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_v10' })
    assert.ok(r.ok && r.data.visionIncluded === true)
    assert.equal(st.cloud.__state.downloadCalls.length, 3, '恰下载 3 页')
    assert.equal(aiCalls[0].ctx.images.length, 3, '恰送 3 图')
    assert.deepEqual(st.cloud.__docs.get('mc_reports/rpt_v10').vision_result.pageFileIds, ['f1', 'f2', 'f3'], '只取前三页')
    assert.ok(aiCalls[0].prompt.includes('报告图片前 3 张'), '指令页数=3（附件总数 5）')
  })

  await scenario('V11 请求体锁参：无图=旧形状逐字节；有图=官方块数组（text 前、data URI、思考关）', async () => {
    const tools0 = requireHandler()
    delete process.env.MC_DEEPSEEK_MODEL
    const SYS = '你是孕期健康信息助手。回答须：①基于权威公共卫生指南的一般性信息；②绝不提供处方药剂量或个体化诊疗方案；③明确建议遵产检与咨询产科医生；④对不确定事项如实说明证据不足，不得虚构安全性。使用简体中文，简洁分点。'
    // 无 images：与纯文本体逐字节一致（回归守卫——多模态改造不得改变旧形状）
    assert.deepEqual(tools0.__deepseekRequestBody('PROMPT_X'), {
      model: 'deepseek-flash',
      messages: [
        { role: 'system', content: SYS },
        { role: 'user', content: 'PROMPT_X' }
      ],
      thinking: { type: 'disabled' },
      temperature: 0.3,
      max_tokens: 800
    }, '无图形状=旧形状')
    // 有 images：content 为块数组（文字块在前、图片按页序、data URI 前缀）
    const b1 = jpegFix().toString('base64')
    const b2 = pngFix().toString('base64')
    const body = tools0.__deepseekRequestBody('PROMPT_X', {
      maxTokens: 1600,
      images: [{ mime: 'image/jpeg', base64: b1 }, { mime: 'image/png', base64: b2 }]
    })
    assert.equal(body.model, 'deepseek-flash', '模型不变')
    assert.deepEqual(body.thinking, { type: 'disabled' }, 'thinking 仍显式关')
    assert.equal(body.temperature, 0.3, 'temperature 不变')
    assert.equal(body.max_tokens, 1600, 'max_tokens 透传')
    const uc = body.messages[1].content
    assert.ok(Array.isArray(uc), 'user content 为块数组')
    assert.equal(uc.length, 3, 'text + 2 图')
    assert.deepEqual(uc[0], { type: 'text', text: 'PROMPT_X' }, '文字块在前')
    assert.deepEqual(uc[1], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b1 } }, '图1 data URI（JPEG）')
    assert.deepEqual(uc[2], { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b2 } }, '图2 data URI（PNG）')
    assert.equal(typeof body.messages[0].content, 'string', 'system 仍纯文本（官方：非 user 带图 400）')
  })

  await scenario('V12 AI 失败语义不变：mock 抛错 → ai-call-failed，零写库', async () => {
    const st = makeStack()
    seedVision(st)
    mkReport(st, 'rpt_v12', [{ fileId: 'f1' }])
    st.tools.__setAiMock(async () => { throw new Error('ai-empty-response') })
    process.env.MC_REPORT_VISION = '1'
    const r = await st.call({ action: 'ai.analyzeReport', reportId: 'rpt_v12' })
    assert.ok(!r.ok && r.code === 'ai-call-failed', `实得 ${r.code}`)
    assert.ok(String(r.message).includes('AI 服务调用失败'), '文案与 OCR 版一致')
    assert.equal(st.cloud.__state.downloadCalls.length, 1, '下载已发生（AI 前置）')
    const doc = st.cloud.__docs.get('mc_reports/rpt_v12')
    assert.equal(doc.revision, 1, '零写库')
    assert.ok(doc.ai_result === undefined && doc.vision_result === undefined)
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
