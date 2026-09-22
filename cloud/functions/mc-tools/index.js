'use strict'

// mc-tools：Phase E1 计时工具权威服务端（胎动连续计时会话 + 临产宫缩记录）。
//
// 权威设计：docs/PHASE_E_SPECIFICATION_AND_PLAN.md §二 + ZCODE_SIX_FEATURES_FOLLOWUP_SCOPE.md §E1。
//
// 核心语义：
// - 胎动会话（mc_fetal_sessions，fst_<16hex>）：startTime 绝对时间戳（客户端提供或服务端默认）
//   ——后台/冷启动由绝对时间差校准（客户端职责）；clicks[] 保留**原始点击流水**（不删不改），
//   validCount 按 5 分钟连击去重合并重算（相邻两次点击间隔 ≤300,000ms 计同一次胎动；簇首
//   valid=true、合并续击 valid=false——严格计数=validCount、原始计数=clicks.length 双视角）；
//   undo 仅移除最后插入的点击并重算；finish 固化 endTime+validCount（可选 syncDaily 同事务
//   **累计**回写 mc_health_daily 当日 fetalCount——operationId 幂等保证重放不双计）；
//   discard 丢弃会话（不产生任何计数）。
// - 宫缩记录（mc_contraction_records，cnt_<16hex>）：durationSec=同次 endTime-startTime；
//   intervalSec=与**开始时间早于本次**的最近一条未废弃记录的 startTime 差（乱序补录按 startTime
//   定位前驱——不依赖插入顺序）；stop 仅 ongoing 可用；delete=软废弃（默认列表排除——误录不污染
//   511 分析；后续新记录的 interval 不引用已废弃记录）。未结束记录 durationSec=null。
// - 幂等/并发：mc_operations 键 memberId:operationId + **单向 SHA-256 摘要**（回执不落原始参数）；
//   重放按当前实体重新生成响应（click 重放绝不重复追加）；revision CAS（连击并发由冲突重试收敛）。
// - 安全：resolveCaller 可信身份；非家庭成员在身份层即拒；实体按 familyId 校验（跨家庭=不存在）。
// - 边界如实：无任何"正常/危险"阈值或诊断推断（511 分析属客户端展示层——服务端只供真实数据）。

const { randomBytes, createHash } = require('node:crypto')
const { loadServerConfig } = require('./shared/config')
const { resolveCaller } = require('./shared/auth')
const { ok, fail, stableRequestHash } = require('./shared/respond')
const { COLLECTIONS } = require('./shared/constants')
// E3 饮食/行为安全词条库（伴生模块——assemble 自动打包；与 static/data/food-safety.json 同源）
let FOOD_SAFETY_ENTRIES = []
try { FOOD_SAFETY_ENTRIES = require('./food-safety-data') } catch (e) { FOOD_SAFETY_ENTRIES = [] }

// E3 AI 代理网关测试注入口：__setAiMock(fn) 注入 mock 提供方；置 null 恢复真实环境判定
let aiMock = null

let cloud = null
try {
  cloud = require('wx-server-sdk')
} catch (e) {
  cloud = null
}
exports.__setCloud = function __setCloud(mockCloud) { cloud = mockCloud }
// E3 AI 代理测试注入：fn(prompt, context) → 文本；null 恢复真实 env 判定（未启用分支可测）
exports.__setAiMock = function __setAiMock(fn) { aiMock = fn === null ? null : fn }

// Phase G OCR 提取测试注入口：fn(fileID) → 文本；null 恢复真实 env 判定
let ocrMock = null
exports.__setOcrMock = function __setOcrMock(fn) { ocrMock = fn === null ? null : fn }

const FETAL = 'mc_fetal_sessions'
const CONTRA = 'mc_contraction_records'
const EFW = 'mc_efw_records'
const OPS = COLLECTIONS.operations
const HEALTH_DAILY = 'mc_health_daily'

// ── E2 Hadlock 1985 三参数估重（LOINC 11746-5）──
// log10(EFW_g)=1.326−0.00326×AC×FL+0.0107×HC+0.0438×AC+0.158×FL（单位 cm）
// 锚点：HC=32.0/AC=30.0/FL=6.5 → log10=3.37370 → 2364.29g（测试必钉）
// BPD 不参与本公式（不可替代缺失 HC——只作伴随测量存储）
const HADLOCK_FORMULA = 'hadlock_hc_ac_fl_1985_v1'
const EFW_RANGES = { hc: [10.0, 42.0], ac: [10.0, 45.0], fl: [1.0, 10.0] } // cm
const EFW_WEEK_RANGE = [12, 42]

const SESSION_STATUS = ['running', 'completed', 'discarded']
const CONTRA_STATUS = ['ongoing', 'finished', 'discarded']
const INTENSITY_LEVELS = ['mild', 'moderate', 'strong']
const MERGE_WINDOW_MS = 5 * 60 * 1000   // 连击去重窗口：相邻点击间隔 ≤5 分钟计同一次胎动
const FUTURE_SKEW_MS = 5 * 60 * 1000    // 客户端时钟前偏容忍（超出拒绝——防未来时间戳）
const TARGET_DEFAULT_MS = 60 * 60 * 1000
const TARGET_MAX_MS = 24 * 60 * 60 * 1000
const NOTES_MAX = 200
const PAGE_DEFAULT = 20
const PAGE_MAX = 100
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const ID_MAX = 128
const REPORTS = 'mc_reports'
const FILES = COLLECTIONS.files

// ── Phase G OCR 提取边界（规格 docs/PHASE_G_REPORT_OCR_SPEC.md）──
const OCR_MAX_PAGES = 3          // 单次解读最多识别附件页数（时延/配额上限）
const OCR_PAGE_TIMEOUT_MS = 15000 // 单页提取外层超时（race——防单页挂死拖垮整函数）
const OCR_TEXT_MAX = 2000        // OCR 文本字符上限（Array.from 计数；超出截断并标注）
const OCR_TRUNCATED_SUFFIX = '…（OCR 文本超长已截断）'

// ── Phase G 视觉直读边界（规格 docs/PHASE_G_VISION_DIRECT_SPEC.md）──
// 官方限制（api-docs.deepseek.com/zh-cn/guides/vision，2026-09-22 核实）：单图 base64 32MiB、
// 请求体 48MiB、格式 JPEG/PNG/GIF/WebP 按内容判定、每图计费封顶 1024 token。
// 工程上限留余量：单页 16MiB、合计 24MiB（base64 后 ≈32MB < 48MiB）。
const VISION_MAX_PAGES = 3               // 单次直读最多页数（与 OCR 页数语义一致）
const VISION_PAGE_TIMEOUT_MS = 15000     // 单页下载外层超时（race——防挂死拖垮整函数）
const VISION_IMAGE_MAX_BYTES = 16 * 1024 * 1024
const VISION_TOTAL_MAX_BYTES = 24 * 1024 * 1024
// 开关恰 '1' 启用（fail-closed：未设/其他值一律关闭，行为与旧版逐字节一致）
function visionEnabled() { return process.env.MC_REPORT_VISION === '1' }

// ── E3 AI 代理网关 ──
// 强制免责（一切 AI 生成内容必带——"AI 生成（未人工逐字审校）"+ 医疗免责）
const AI_DISCLAIMER = 'AI 生成（未人工逐字审校）· 仅供一般参考，不构成医疗诊断、处方或用药建议；如有疑问请咨询产科医生并以产检结果为准。'

// 通用安全系统提示：禁处方剂量、强调产检与医生诊断（服务端统一注入——客户端不可绕过）
function safetySystemPrompt() {
  return '你是孕期健康信息助手。回答须：①基于权威公共卫生指南的一般性信息；②绝不提供处方药剂量或个体化诊疗方案；'
    + '③明确建议遵产检与咨询产科医生；④对不确定事项如实说明证据不足，不得虚构安全性。使用简体中文，简洁分点。'
}

function buildFoodPrompt(query, stage) {
  return `${safetySystemPrompt()}\n用户提问（孕期饮食/行为安全）：${query}${stage ? `（孕期阶段：${stage}）` : ''}\n`
    + '请给出：1) 一般安全评估（安全/注意/避免/证据不足）2) 前提条件与限量 3) 主要风险 4) 何时需就医。'
}

// ── DeepSeek V4 配置（规格 docs/PHASE_G_DEEPSEEK_FLASH_MIGRATION_SPEC.md）──
// deepseek-chat 官方 2026-07-24 已停用（现网宽容路由无保证）——显式迁 deepseek-flash。
// MC_DEEPSEEK_MODEL 白名单：缺省 deepseek-flash；非法值回落缺省+warn（不挡服务；防任意值注入请求体）
const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro']
const DEEPSEEK_MODEL_DEFAULT = 'deepseek-flash'
function deepseekModel() {
  const v = process.env.MC_DEEPSEEK_MODEL
  if (DEEPSEEK_MODELS.includes(v)) return v
  if (v !== undefined) console.warn('[mc-tools] MC_DEEPSEEK_MODEL 非白名单值，回落', DEEPSEEK_MODEL_DEFAULT, ':', String(v))
  return DEEPSEEK_MODEL_DEFAULT
}

// 分场景输出上限：报告解读逐项指标分析输出更长（800 有截断风险）
const AI_MAX_TOKENS = { explainFood: 800, analyzeReport: 1600 }

// 请求体构造（纯函数）：thinking 显式关——V4.1-Flash 默认开 thinking（effort=high），
// 思考 token 挤占 max_tokens 且拉高延迟，本场景必须关（关后 temperature 恢复生效）。
// __deepseekRequestBody 为测试注入口——零外呼锁参数回归。
// 视觉直读（规格 docs/PHASE_G_VISION_DIRECT_SPEC.md）：opts.images 非空时 user content 为
// 块数组（文字块在前、图片按页序、data URI base64——官方 vision 格式）；无 images 时形状与
// 纯文本体逐字节一致（既有锁参套件即此回归守卫）。图片只进 user 消息（官方：system/assistant 带图 400）。
function deepseekRequestBody(prompt, opts) {
  const maxTokens = opts && Number.isInteger(opts.maxTokens) && opts.maxTokens > 0 ? opts.maxTokens : AI_MAX_TOKENS.explainFood
  const images = opts && Array.isArray(opts.images) ? opts.images.filter(Boolean) : []
  const userContent = images.length > 0
    ? [{ type: 'text', text: prompt }].concat(images.map(im => ({
        type: 'image_url',
        image_url: { url: 'data:' + String(im.mime) + ';base64,' + String(im.base64) }
      })))
    : prompt
  return {
    model: deepseekModel(),
    messages: [
      { role: 'system', content: safetySystemPrompt() },
      { role: 'user', content: userContent }
    ],
    thinking: { type: 'disabled' },
    temperature: 0.3,
    max_tokens: maxTokens
  }
}
exports.__deepseekRequestBody = deepseekRequestBody

// 提供方判定：测试 mock 注入优先；其后真实环境 DEEPSEEK_API_KEY（生产路径——未配置=未启用）
function aiProvider() {
  if (aiMock) return { kind: 'mock', call: aiMock }
  const key = process.env.DEEPSEEK_API_KEY
  if (key) {
    return {
      // kind=真实模型名（透传响应 model 与落库 ai_result.model；原笼统 'deepseek'）
      kind: deepseekModel(),
      call: (prompt, context) => callDeepSeek(key, prompt, {
        maxTokens: context && context.kind === 'analyzeReport' ? AI_MAX_TOKENS.analyzeReport : AI_MAX_TOKENS.explainFood,
        images: context && context.images
      })
    }
  }
  return null
}

// DeepSeek 生产调用路径（node:https——仅在配置真实 Key 的部署环境可达；测试一律走 mock/未启用分支）
function callDeepSeek(apiKey, prompt, opts) {
  const https = require('node:https')
  const body = JSON.stringify(deepseekRequestBody(prompt, opts))
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.deepseek.com',
      path: '/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(body) },
      timeout: 20000
    }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          const text = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content
          if (typeof text !== 'string' || !text) return reject(new Error('ai-empty-response'))
          resolve(text)
        } catch (e) { reject(new Error('ai-malformed-response')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('ai-timeout')) })
    req.write(body)
    req.end()
  })
}

// ── Phase G OCR 提供方抽象（规格 docs/PHASE_G_REPORT_OCR_SPEC.md）──
// 判定顺序：测试 mock → MC_OCR_PROVIDER（wechat 云调用 / tencent API）→ null（未启用）。
// DeepSeek 与 OCR 是两个独立开关：OCR 未启用时 ai.analyzeReport 照常走元数据模式。
function ocrProvider() {
  if (ocrMock) return { kind: 'mock', extract: fileID => Promise.resolve(ocrMock(fileID)) }
  const kind = process.env.MC_OCR_PROVIDER
  if (kind === 'wechat') return { kind: 'wechat', extract: extractViaWechatOcr }
  if (kind === 'tencent') {
    const sid = process.env.MC_OCR_TENCENT_SECRET_ID
    const skey = process.env.MC_OCR_TENCENT_SECRET_KEY
    if (!sid || !skey) return null // tencent 缺密钥 → fail-closed 未启用，不静默降级 wechat
    return { kind: 'tencent', extract: fileID => extractViaTencentOcr(sid, skey, fileID) }
  }
  return null
}

// 微信云调用 OCR：附件临时 URL → openapi ocr.printedText（config.json 须声明云调用权限）
async function extractViaWechatOcr(fileID) {
  let tempUrl = ''
  try {
    const r = await cloud.getTempFileURL({ fileList: [fileID] })
    const item = r && r.fileList && r.fileList[0]
    tempUrl = (item && item.tempFileURL) || ''
  } catch (e) {
    throw new Error('ocr-url-failed')
  }
  if (!tempUrl) throw new Error('ocr-url-failed')
  let res
  try {
    res = await cloud.openapi.ocr.printedText({ img_url: tempUrl })
  } catch (e) {
    throw new Error('ocr-call-error:' + String((e && (e.errMsg || e.message)) || e).slice(0, 80))
  }
  if (!res || (typeof res.errCode === 'number' && res.errCode !== 0)) throw new Error('ocr-bad-response')
  const words = Array.isArray(res.words_result) ? res.words_result : []
  const text = words.map(w => (w && typeof w.words === 'string') ? w.words : '').filter(Boolean).join('\n')
  if (!text) throw new Error('ocr-empty-text')
  return text
}

// 腾讯云通用文字识别（GeneralBasicOCR 2018-11-19）备选：TC3-HMAC-SHA256 签名直调
async function extractViaTencentOcr(secretId, secretKey, fileID) {
  let buffer
  try {
    const dl = await cloud.downloadFile({ fileID })
    buffer = dl && dl.fileContent
  } catch (e) {
    throw new Error('ocr-download-failed')
  }
  if (!buffer || !buffer.length) throw new Error('ocr-download-failed')
  const cryptoModule = require('node:crypto')
  const https = require('node:https')
  const sha256hex = s => cryptoModule.createHash('sha256').update(s, 'utf8').digest('hex')
  const hmacBy = (key, msg) => cryptoModule.createHmac('sha256', key).update(msg, 'utf8').digest()
  const service = 'ocr'
  const host = 'ocr.tencentcloudapi.com'
  const payload = JSON.stringify({ ImageBase64: buffer.toString('base64') })
  const timestamp = Math.floor(Date.now() / 1000)
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const canonicalRequest = 'POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:' + host + '\n\ncontent-type;host\n' + sha256hex(payload)
  const stringToSign = 'TC3-HMAC-SHA256\n' + timestamp + '\n' + date + '/' + service + '/tc3_request\n' + sha256hex(canonicalRequest)
  const derivedKey = hmacBy(hmacBy(hmacBy('TC3' + secretKey, date), service), 'tc3_request')
  const signature = cryptoModule.createHmac('sha256', derivedKey).update(stringToSign, 'utf8').digest('hex')
  const authorization = 'TC3-HMAC-SHA256 Credential=' + secretId + '/' + date + '/' + service + '/tc3_request, SignedHeaders=content-type;host, Signature=' + signature
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host, path: '/', method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Host': host,
        'Authorization': authorization,
        'X-TC-Action': 'GeneralBasicOCR',
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Version': '2018-11-19',
        'X-TC-Region': 'ap-guangzhou',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: OCR_PAGE_TIMEOUT_MS
    }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          const resp = parsed && parsed.Response
          if (!resp || resp.Error) throw new Error('ocr-tencent-error:' + String((resp && resp.Error && resp.Error.Code) || 'unknown').slice(0, 60))
          const lines = Array.isArray(resp.TextDetections) ? resp.TextDetections : []
          const text = lines.map(l => (l && typeof l.DetectedText === 'string') ? l.DetectedText : '').filter(Boolean).join('\n')
          if (!text) throw new Error('ocr-empty-text')
          resolve(text)
        } catch (e) { reject(e instanceof Error ? e : new Error('ocr-malformed-response')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('ocr-page-timeout')) })
    req.write(payload)
    req.end()
  })
}

// OCR 文本有界截断（Array.from 计数——代理对安全）
function boundOcrText(raw) {
  const chars = Array.from(String(raw || ''))
  if (chars.length <= OCR_TEXT_MAX) return chars.join('')
  return chars.slice(0, OCR_TEXT_MAX).join('') + OCR_TRUNCATED_SUFFIX
}

// 附件登记核对（OCR 与视觉直读共用；登记校验与 mc-reports report.getReadUrls 同规则）：
// 页数封顶截取 + 本家庭 + status=registered + formalFileID 非空；任一不符抛 invalid-attachment。
async function validateAttachmentPages(db, fid, attachments, maxPages) {
  const pageFileIds = attachments.slice(0, maxPages).map(a => a.fileId)
  const formalFileIDs = []
  for (const fileId of pageFileIds) {
    const fdoc = await getDocMaybe(db, FILES, fileId)
    if (!fdoc || fdoc.familyId !== fid || fdoc.status !== 'registered' || !fdoc.formalFileID) {
      const err = new Error('附件 ' + fileId + ' 不可用（未登记或已清理）')
      err.code = 'invalid-attachment'
      throw err
    }
    formalFileIDs.push(fdoc.formalFileID)
  }
  return { pageFileIds, formalFileIDs }
}

// 逐页 OCR。任一页失败 → 抛错（整次解读失败——多页报告缺页解读会误导，宁失败不部分成功）。
async function extractOcrForReport(db, fid, attachments, provider) {
  const { pageFileIds, formalFileIDs } = await validateAttachmentPages(db, fid, attachments, OCR_MAX_PAGES)
  const pageTexts = []
  for (let i = 0; i < formalFileIDs.length; i++) {
    let text
    try {
      text = await Promise.race([
        provider.extract(formalFileIDs[i]),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ocr-page-timeout')), OCR_PAGE_TIMEOUT_MS))
      ])
    } catch (e) {
      const err = new Error('第 ' + (i + 1) + ' 张附件识别失败：' + String((e && e.message) || e).slice(0, 80))
      err.code = 'ocr-call-failed'
      throw err
    }
    pageTexts.push(String(text))
  }
  return { text: boundOcrText(pageTexts.join('\n')), pageFileIds, pageCount: formalFileIDs.length }
}

// 缓存复用：报告已存 ocr_result 且附件集合（页序）与提供方一致时复用——不重复识别/计费
function reusableOcr(report, provider, attachments) {
  const prev = report && report.ocr_result
  if (!prev || prev.included !== true || typeof prev.text !== 'string' || !prev.text) return null
  if (prev.provider !== provider.kind) return null
  const prevIds = Array.isArray(prev.pageFileIds) ? prev.pageFileIds : []
  const curIds = attachments.slice(0, OCR_MAX_PAGES).map(a => a.fileId)
  if (prevIds.length !== curIds.length || prevIds.some((v, i) => v !== curIds[i])) return null
  return prev
}

// ── Phase G 视觉直读提取（规格 docs/PHASE_G_VISION_DIRECT_SPEC.md）──
// 魔数嗅探 MIME：官方按文件实际内容判格式（不可信扩展名）；认不出返回 null——
// 由调用方如实报 vision-unsupported-format，绝不伪造 MIME（HEIC 等未支持格式走此分支）。
function sniffImageMime(buf) {
  if (!buf || buf.length < 12 || typeof buf.slice !== 'function') return null
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.slice(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}
exports.__sniffImageMime = sniffImageMime

// 视觉直读图片提取：登记核对 → 逐页下载（15s race）→ 单页/合计字节门 → MIME 门。
// 任一页失败 → 整次抛错（与 OCR 同语义：多页报告缺页解读会误导，宁失败不部分成功）。
// 错误码：invalid-attachment / vision-download-failed / vision-image-too-large / vision-unsupported-format。
async function extractVisionImages(db, fid, attachments) {
  const { pageFileIds, formalFileIDs } = await validateAttachmentPages(db, fid, attachments, VISION_MAX_PAGES)
  const images = []
  let totalBytes = 0
  for (let i = 0; i < formalFileIDs.length; i++) {
    let fileContent
    try {
      fileContent = await Promise.race([
        cloud.downloadFile({ fileID: formalFileIDs[i] }).then(r => r && r.fileContent),
        new Promise((_, rej) => setTimeout(() => rej(new Error('vision-page-timeout')), VISION_PAGE_TIMEOUT_MS))
      ])
    } catch (e) {
      const err = new Error('第 ' + (i + 1) + ' 张附件下载失败，请重试')
      err.code = 'vision-download-failed'
      throw err
    }
    if (!fileContent || !fileContent.length) {
      const err = new Error('第 ' + (i + 1) + ' 张附件下载内容为空，请重试')
      err.code = 'vision-download-failed'
      throw err
    }
    if (fileContent.length > VISION_IMAGE_MAX_BYTES) {
      const err = new Error('第 ' + (i + 1) + ' 张附件过大（单图须 ≤' + (VISION_IMAGE_MAX_BYTES / 1024 / 1024) + 'MiB），请使用较小图片')
      err.code = 'vision-image-too-large'
      throw err
    }
    totalBytes += fileContent.length
    if (totalBytes > VISION_TOTAL_MAX_BYTES) {
      const err = new Error('附件合计过大（须 ≤' + (VISION_TOTAL_MAX_BYTES / 1024 / 1024) + 'MiB），请减少页数或使用较小图片')
      err.code = 'vision-image-too-large'
      throw err
    }
    const mime = sniffImageMime(fileContent)
    if (!mime) {
      const err = new Error('第 ' + (i + 1) + ' 张附件图片格式不受支持（支持 JPEG/PNG/GIF/WebP），请重拍')
      err.code = 'vision-unsupported-format'
      throw err
    }
    images.push({ mime, base64: fileContent.toString('base64') })
  }
  return { images, pageFileIds, pageCount: images.length }
}

async function getDocMaybe(db, col, id) {
  try {
    const r = await db.collection(col).doc(id).get()
    return (r && r.data) || null
  } catch (e) {
    const msg = String((e && (e.errMsg || e.message)) || e)
    if (/not\s*exist|does not exist/i.test(msg)) return null
    throw e
  }
}

// 请求摘要（单向 SHA-256——回执不落原始参数；notes 等文本不持久进 mc_operations）
function digestOf(obj) {
  return createHash('sha256').update(stableRequestHash(obj), 'utf8').digest('hex')
}

// Asia/Shanghai 日号（与 mc-health/familyStore 同式——家庭时区口径）
function shanghaiDateKey(ms) {
  const sh = new Date(ms + (8 * 60 + new Date(ms).getTimezoneOffset()) * 60000)
  return `${sh.getFullYear()}-${String(sh.getMonth() + 1).padStart(2, '0')}-${String(sh.getDate()).padStart(2, '0')}`
}

function parseExpectedRevision(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
  return value
}

// 时间戳校验：有限整数毫秒；允许 ≤5 分钟未来偏斜（设备时钟）；不设过去下限（离线补录合法）
function parseTimestampMs(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null
  if (value > Date.now() + FUTURE_SKEW_MS) return null
  return value
}

function stripId(doc) {
  const { _id, ...rest } = doc || {}
  return rest
}

function sortKeyOf(ms, id) {
  return `${String(ms).padStart(16, '0')}:${id}`
}

// ── 胎动有效计数重算（纯函数）：按时间戳升序聚类——簇间隔 >MERGE_WINDOW_MS 开新簇；
// 簇首 valid=true（计入），合并续击 valid=false（保留流水不计次）。clicks 数组保持插入序，
// valid 标志按聚类结果回写对应项。 ──
function recomputeClicks(clicks) {
  const list = (Array.isArray(clicks) ? clicks : []).map(c => ({ timestamp: c.timestamp }))
  const order = list.map((c, i) => i).sort((a, b) => list[a].timestamp - list[b].timestamp)
  const validOf = new Array(list.length).fill(false)
  let prevIdx = -1
  for (const idx of order) {
    if (prevIdx < 0 || list[idx].timestamp - list[prevIdx].timestamp > MERGE_WINDOW_MS) {
      validOf[idx] = true // 新簇首——计一次有效胎动
    }
    prevIdx = idx
  }
  let validCount = 0
  const out = list.map((c, i) => {
    if (validOf[i]) validCount++
    return { timestamp: c.timestamp, valid: validOf[i] }
  })
  return { clicks: out, validCount }
}

function viewSession(doc) {
  if (!doc) return null
  return {
    sessionId: doc._id || doc.sessionId,
    memberId: doc.memberId,
    dateKey: doc.dateKey,
    status: doc.status,
    startTime: doc.startTime,
    endTime: doc.endTime ?? null,
    targetDurationMs: doc.targetDurationMs,
    clicks: Array.isArray(doc.clicks) ? doc.clicks : [],
    validCount: Number.isInteger(doc.validCount) ? doc.validCount : 0,
    rawCount: Array.isArray(doc.clicks) ? doc.clicks.length : 0,
    revision: doc.revision,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  }
}

function viewRecord(doc) {
  if (!doc) return null
  return {
    recordId: doc._id || doc.recordId,
    memberId: doc.memberId,
    dateKey: doc.dateKey,
    startTime: doc.startTime,
    endTime: doc.endTime ?? null,
    durationSec: doc.durationSec ?? null,
    intervalSec: doc.intervalSec ?? null,
    intensity: doc.intensity ?? null,
    notes: doc.notes ?? null,
    status: doc.status,
    revision: doc.revision,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  }
}

// ── 幂等操作守卫（事务内首查；回执=摘要+实体指针，重放按当前实体重新生成响应）──
async function opGuard(t, opKey, opDoc) {
  const prev = await getDocMaybe(t, OPS, opKey)
  if (!prev) return { ready: true }
  if (prev.requestHash !== opDoc.requestHash) {
    await t.rollback()
    return { replayed: fail('operation-id-conflict', '同一 operationId 曾以不同内容提交') }
  }
  return { replayed: 'ok', entity: prev.entity }
}

function txFailed(err) {
  return fail('transaction-failed', '事务未提交成功，可安全重试', {
    errMsg: String((err && (err.errMsg || err.message)) || err).slice(0, 200)
  })
}

// 前驱宫缩定位（intervalSec 计算凭据）：startTime 严格早于本次、未废弃的最近一条（家庭范围）。
// 事务外读取（interval=插入时快照；并发插入的极小竞态可接受——511 分析可由列表原始 startTime 重算）。
async function findPriorContraction(db, fid, startTime) {
  const res = await db.collection(CONTRA).where({ familyId: fid }).orderBy('startTime', 'desc').limit(100).get()
  const rows = (res && res.data) || []
  for (const r of rows) {
    if (r.status === 'discarded') continue
    if (r.startTime < startTime) return r
  }
  return null
}

exports.main = async function main(event) {
  if (!cloud) return fail('sdk-unavailable', 'wx-server-sdk 不可用')
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, throwOnNotFound: false })
  const config = loadServerConfig()
  const resolved = resolveCaller(cloud, config, event)
  if (!resolved.ok) return fail(resolved.code, resolved.message)
  const caller = resolved.caller
  const action = event && event.action
  const db = cloud.database()
  const fid = config.familyId
  const READ_ACTIONS = ['fetal.list', 'contraction.list', 'efw.calculate', 'efw.list', 'food.search', 'ai.explainFood', 'ai.analyzeReport']
  if (!READ_ACTIONS.includes(action)) {
    if (!event.operationId || typeof event.operationId !== 'string' || event.operationId.length > 64) {
      return fail('invalid-params', '缺少有效 operationId')
    }
  }

  // ══ 胎动会话 ══

  if (action === 'fetal.start') {
    const startTime = event.startTime === undefined || event.startTime === null ? Date.now() : parseTimestampMs(event.startTime)
    if (startTime === null) return fail('invalid-params', 'startTime 须有限整数毫秒（允许 ≤5 分钟未来偏斜）')
    let targetDurationMs = TARGET_DEFAULT_MS
    if (event.targetDurationMs !== undefined && event.targetDurationMs !== null) {
      if (!Number.isInteger(event.targetDurationMs) || event.targetDurationMs < 1 || event.targetDurationMs > TARGET_MAX_MS) {
        return fail('invalid-params', `targetDurationMs 须 1..${TARGET_MAX_MS} 毫秒`)
      }
      targetDurationMs = event.targetDurationMs
    }
    const now = Date.now()
    const sessionId = 'fst_' + randomBytes(8).toString('hex')
    const opKey = `${caller.memberId}:${event.operationId}`
    const opDoc = {
      memberId: caller.memberId, operationId: event.operationId, kind: 'tools-fetal-start',
      requestHash: digestOf({ startTime, targetDurationMs })
    }
    const t = await db.startTransaction()
    try {
      const guard = await opGuard(t, opKey, opDoc)
      if (guard.replayed === 'ok') {
        const cur = guard.entity && guard.entity.collection === FETAL ? await getDocMaybe(t, FETAL, guard.entity.docId) : null
        await t.rollback()
        return ok({ replayed: true, session: viewSession(cur) })
      }
      if (guard.replayed) return guard.replayed
      const doc = {
        familyId: fid, memberId: caller.memberId, dateKey: shanghaiDateKey(startTime),
        status: 'running', startTime, endTime: null, targetDurationMs,
        clicks: [], validCount: 0,
        revision: 1, createdAt: now, updatedAt: now,
        sortKey: sortKeyOf(startTime, sessionId)
      }
      await t.collection(FETAL).doc(sessionId).set({ data: { ...doc } })
      await t.collection(OPS).doc(opKey).set({
        data: { ...opDoc, entity: { collection: FETAL, docId: sessionId }, createdAt: now }
      })
      await t.commit()
      return ok({ session: viewSession({ ...doc, _id: sessionId }) })
    } catch (err) {
      try { await t.rollback() } catch (e) { /* 已回滚 */ }
      return txFailed(err)
    }
  }

  if (action === 'fetal.click' || action === 'fetal.undo' || action === 'fetal.finish' || action === 'fetal.discard') {
    const sessionId = event.sessionId
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > ID_MAX) return fail('invalid-params', '缺少有效 sessionId')
    const expected = parseExpectedRevision(event.expectedRevision)
    if (expected === null) return fail('invalid-params', 'expectedRevision 必须是显式非负整数')

    let requestChanges = {}
    if (action === 'fetal.click') {
      const ts = parseTimestampMs(event.timestamp)
      if (ts === null) return fail('invalid-params', 'timestamp 须有限整数毫秒（允许 ≤5 分钟未来偏斜）')
      requestChanges = { timestamp: ts }
    }
    const opKey = `${caller.memberId}:${event.operationId}`
    const opDoc = {
      memberId: caller.memberId, operationId: event.operationId, kind: `tools-${action.replace('.', '-')}`,
      requestHash: digestOf({ sessionId, expectedRevision: expected, ...(action === 'fetal.finish' ? { syncDaily: event.syncDaily === true } : {}), ...requestChanges })
    }
    const now = Date.now()
    const t = await db.startTransaction()
    try {
      const guard = await opGuard(t, opKey, opDoc)
      if (guard.replayed === 'ok') {
        const cur = guard.entity && guard.entity.collection === FETAL ? await getDocMaybe(t, FETAL, guard.entity.docId) : null
        await t.rollback()
        return ok({ replayed: true, session: viewSession(cur) })
      }
      if (guard.replayed) return guard.replayed

      const session = await getDocMaybe(t, FETAL, sessionId)
      if (!session || session.familyId !== fid) { await t.rollback(); return fail('not-found', '会话不存在') }
      if (expected !== session.revision) {
        await t.rollback()
        return fail('revision-conflict', '会话已被更新（并发点击/操作），请以当前版本重试', {
          currentRevision: session.revision, currentSession: viewSession(session)
        })
      }

      const merged = { ...stripId(session) }
      let dailySyncResult = null
      if (action === 'fetal.click') {
        if (session.status !== 'running') { await t.rollback(); return fail('invalid-state', `仅 running 会话可点击（当前 ${session.status}）`) }
        if (requestChanges.timestamp < session.startTime) {
          await t.rollback(); return fail('invalid-params', `点击时间戳早于会话开始（${requestChanges.timestamp} < ${session.startTime}）`)
        }
        merged.clicks = [...(session.clicks || []), { timestamp: requestChanges.timestamp }]
        const recomputed = recomputeClicks(merged.clicks)
        merged.clicks = recomputed.clicks
        merged.validCount = recomputed.validCount
      } else if (action === 'fetal.undo') {
        if (session.status !== 'running') { await t.rollback(); return fail('invalid-state', `仅 running 会话可撤销（当前 ${session.status}）`) }
        if (!Array.isArray(session.clicks) || session.clicks.length === 0) {
          await t.rollback(); return fail('invalid-state', '没有可撤销的点击')
        }
        merged.clicks = session.clicks.slice(0, -1) // 撤销最后插入的点击（保留其余原始流水）
        const recomputed = recomputeClicks(merged.clicks)
        merged.clicks = recomputed.clicks
        merged.validCount = recomputed.validCount
      } else if (action === 'fetal.finish') {
        if (session.status !== 'running') { await t.rollback(); return fail('invalid-state', `仅 running 会话可完成（当前 ${session.status}）`) }
        const endTime = event.endTime === undefined || event.endTime === null ? now : parseTimestampMs(event.endTime)
        if (endTime === null) return fail('invalid-params', 'endTime 须有限整数毫秒')
        if (endTime < session.startTime) { await t.rollback(); return fail('invalid-params', 'endTime 早于 startTime') }
        merged.status = 'completed'
        merged.endTime = endTime
        // 可选联动（同事务）：当日 mc_health_daily.fetalCount 累计 +validCount——
        // operationId 幂等（重放不二次回写）；日记录不存在则创建；已删除墓碑则跳过不复活
        if (event.syncDaily === true) {
          const dailyId = `${fid}:${session.dateKey}`
          const daily = await getDocMaybe(t, HEALTH_DAILY, dailyId)
          if (daily && daily.deleted) {
            dailySyncResult = 'skipped-daily-deleted'
          } else if (daily) {
            const fields = { ...(daily.fields || {}) }
            fields.fetalCount = (typeof fields.fetalCount === 'number' && Number.isFinite(fields.fetalCount) ? fields.fetalCount : 0) + merged.validCount
            await t.collection(HEALTH_DAILY).doc(dailyId).set({
              data: { ...stripId(daily), fields, revision: (daily.revision || 0) + 1, updatedBy: caller.memberId, updatedAt: now }
            })
            dailySyncResult = 'synced'
          } else {
            await t.collection(HEALTH_DAILY).doc(dailyId).set({
              data: {
                familyId: fid, type: 'daily', dateKey: session.dateKey,
                fields: { fetalCount: merged.validCount },
                schemaVersion: 1, revision: 1, updatedBy: caller.memberId, updatedAt: now
              }
            })
            dailySyncResult = 'created'
          }
        }
      } else {
        // discard
        if (session.status !== 'running') { await t.rollback(); return fail('invalid-state', `仅 running 会话可废弃（当前 ${session.status}）`) }
        merged.status = 'discarded'
        merged.endTime = now
      }
      merged.revision = session.revision + 1
      merged.updatedAt = now
      await t.collection(FETAL).doc(sessionId).set({ data: merged })
      await t.collection(OPS).doc(opKey).set({
        data: { ...opDoc, entity: { collection: FETAL, docId: sessionId }, createdAt: now }
      })
      await t.commit()
      const view = viewSession({ ...merged, _id: sessionId })
      return ok({ session: view, ...(dailySyncResult ? { dailySync: dailySyncResult } : {}) })
    } catch (err) {
      try { await t.rollback() } catch (e) { /* 已回滚 */ }
      return txFailed(err)
    }
  }

  if (action === 'fetal.list') {
    const limitRaw = Number(event.limit || PAGE_DEFAULT)
    const limit = Math.min(Math.max(Number.isInteger(limitRaw) ? limitRaw : PAGE_DEFAULT, 1), PAGE_MAX)
    const cursor = (typeof event.cursor === 'string' && event.cursor) || null
    if (event.status !== undefined && event.status !== null && !SESSION_STATUS.includes(event.status)) {
      return fail('invalid-params', `status 须 ${SESSION_STATUS.join('/')}`)
    }
    if (event.dateKey !== undefined && event.dateKey !== null && !DATE_RE.test(String(event.dateKey))) {
      return fail('invalid-params', 'dateKey 须 YYYY-MM-DD')
    }
    const cmd = db.command
    const where = { familyId: fid }
    if (event.status) where.status = event.status
    if (event.dateKey) where.dateKey = event.dateKey
    if (cursor) where.sortKey = cmd.lt(cursor)
    const res = await db.collection(FETAL).where(where).orderBy('sortKey', 'desc').limit(limit).get()
    const rows = (res && res.data) || []
    const last = rows[rows.length - 1]
    const nextCursor = rows.length === limit && last ? last.sortKey : null
    return ok({ sessions: rows.map(viewSession), nextCursor, hasMore: Boolean(nextCursor) })
  }

  // ══ 宫缩记录 ══

  if (action === 'contraction.start') {
    const startTime = event.startTime === undefined || event.startTime === null ? Date.now() : parseTimestampMs(event.startTime)
    if (startTime === null) return fail('invalid-params', 'startTime 须有限整数毫秒（允许 ≤5 分钟未来偏斜）')
    let intensity = event.intensity === undefined || event.intensity === null ? null : event.intensity
    if (intensity !== null && !INTENSITY_LEVELS.includes(intensity)) {
      return fail('invalid-params', `intensity 须 ${INTENSITY_LEVELS.join('/')} 或 null`)
    }
    let notes = event.notes === undefined || event.notes === null ? null : event.notes
    if (notes !== null && (typeof notes !== 'string' || notes.length > NOTES_MAX)) {
      return fail('invalid-params', `notes 须 ≤${NOTES_MAX} 字文本`)
    }
    const now = Date.now()
    const recordId = 'cnt_' + randomBytes(8).toString('hex')
    const opKey = `${caller.memberId}:${event.operationId}`
    const opDoc = {
      memberId: caller.memberId, operationId: event.operationId, kind: 'tools-contraction-start',
      requestHash: digestOf({ startTime, intensity: intensity ?? null, notes: notes ?? null })
    }
    // 间隔前驱：事务外读取（见 findPriorContraction 注释——插入时快照语义）
    const prior = await findPriorContraction(db, fid, startTime)
    const t = await db.startTransaction()
    try {
      const guard = await opGuard(t, opKey, opDoc)
      if (guard.replayed === 'ok') {
        const cur = guard.entity && guard.entity.collection === CONTRA ? await getDocMaybe(t, CONTRA, guard.entity.docId) : null
        await t.rollback()
        return ok({ replayed: true, record: viewRecord(cur) })
      }
      if (guard.replayed) return guard.replayed
      const intervalSec = prior ? Math.round((startTime - prior.startTime) / 1000) : null
      const doc = {
        familyId: fid, memberId: caller.memberId, dateKey: shanghaiDateKey(startTime),
        startTime, endTime: null, durationSec: null,
        intervalSec, intensity, notes,
        status: 'ongoing',
        revision: 1, createdAt: now, updatedAt: now,
        sortKey: sortKeyOf(startTime, recordId)
      }
      await t.collection(CONTRA).doc(recordId).set({ data: { ...doc } })
      await t.collection(OPS).doc(opKey).set({
        data: { ...opDoc, entity: { collection: CONTRA, docId: recordId }, createdAt: now }
      })
      await t.commit()
      return ok({ record: viewRecord({ ...doc, _id: recordId }) })
    } catch (err) {
      try { await t.rollback() } catch (e) { /* 已回滚 */ }
      return txFailed(err)
    }
  }

  if (action === 'contraction.stop' || action === 'contraction.delete') {
    const recordId = event.recordId
    if (!recordId || typeof recordId !== 'string' || recordId.length > ID_MAX) return fail('invalid-params', '缺少有效 recordId')
    const expected = parseExpectedRevision(event.expectedRevision)
    if (expected === null) return fail('invalid-params', 'expectedRevision 必须是显式非负整数')
    let requestChanges = {}
    if (action === 'contraction.stop') {
      const endTime = event.endTime === undefined || event.endTime === null ? Date.now() : parseTimestampMs(event.endTime)
      if (endTime === null) return fail('invalid-params', 'endTime 须有限整数毫秒')
      requestChanges = { endTime }
      if (event.intensity !== undefined) {
        if (event.intensity !== null && !INTENSITY_LEVELS.includes(event.intensity)) {
          return fail('invalid-params', `intensity 须 ${INTENSITY_LEVELS.join('/')} 或 null`)
        }
        requestChanges.intensity = event.intensity
      }
      if (event.notes !== undefined) {
        if (event.notes !== null && (typeof event.notes !== 'string' || event.notes.length > NOTES_MAX)) {
          return fail('invalid-params', `notes 须 ≤${NOTES_MAX} 字文本`)
        }
        requestChanges.notes = event.notes
      }
    }
    const opKey = `${caller.memberId}:${event.operationId}`
    const opDoc = {
      memberId: caller.memberId, operationId: event.operationId, kind: `tools-${action.replace('.', '-')}`,
      requestHash: digestOf({ recordId, expectedRevision: expected, ...requestChanges })
    }
    const now = Date.now()
    const t = await db.startTransaction()
    try {
      const guard = await opGuard(t, opKey, opDoc)
      if (guard.replayed === 'ok') {
        const cur = guard.entity && guard.entity.collection === CONTRA ? await getDocMaybe(t, CONTRA, guard.entity.docId) : null
        await t.rollback()
        return ok({ replayed: true, record: viewRecord(cur) })
      }
      if (guard.replayed) return guard.replayed

      const record = await getDocMaybe(t, CONTRA, recordId)
      if (!record || record.familyId !== fid) { await t.rollback(); return fail('not-found', '记录不存在') }
      if (expected !== record.revision) {
        await t.rollback()
        return fail('revision-conflict', '记录已被更新，请刷新后重试', { currentRevision: record.revision })
      }
      const merged = { ...stripId(record) }
      if (action === 'contraction.stop') {
        if (record.status !== 'ongoing') { await t.rollback(); return fail('invalid-state', `仅 ongoing 记录可结束（当前 ${record.status}）`) }
        if (requestChanges.endTime < record.startTime) {
          await t.rollback(); return fail('invalid-params', 'endTime 早于 startTime')
        }
        merged.status = 'finished'
        merged.endTime = requestChanges.endTime
        merged.durationSec = Math.round((requestChanges.endTime - record.startTime) / 1000)
        if (requestChanges.intensity !== undefined) merged.intensity = requestChanges.intensity
        if (requestChanges.notes !== undefined) merged.notes = requestChanges.notes
      } else {
        // delete：软废弃（默认列表排除；不改任何其他记录）
        if (record.status === 'discarded') { await t.rollback(); return fail('invalid-state', '记录已废弃') }
        merged.status = 'discarded'
      }
      merged.revision = record.revision + 1
      merged.updatedAt = now
      await t.collection(CONTRA).doc(recordId).set({ data: merged })
      await t.collection(OPS).doc(opKey).set({
        data: { ...opDoc, entity: { collection: CONTRA, docId: recordId }, createdAt: now }
      })
      await t.commit()
      return ok({ record: viewRecord({ ...merged, _id: recordId }) })
    } catch (err) {
      try { await t.rollback() } catch (e) { /* 已回滚 */ }
      return txFailed(err)
    }
  }

  if (action === 'contraction.list') {
    const limitRaw = Number(event.limit || PAGE_DEFAULT)
    const limit = Math.min(Math.max(Number.isInteger(limitRaw) ? limitRaw : PAGE_DEFAULT, 1), PAGE_MAX)
    const cursor = (typeof event.cursor === 'string' && event.cursor) || null
    const sinceMs = event.sinceMs === undefined || event.sinceMs === null ? null : event.sinceMs
    if (sinceMs !== null && (typeof sinceMs !== 'number' || !Number.isInteger(sinceMs) || sinceMs <= 0)) {
      return fail('invalid-params', 'sinceMs 须正整数毫秒')
    }
    const cmd = db.command
    const where = { familyId: fid }
    if (cursor) where.sortKey = cmd.lt(cursor)
    // 排除废弃：mock/真库 where 不便表达 neq+or——超取后过滤再截断（单家庭宫缩记录量级，
    // 取 limit*3 上限 300 足覆盖误录占比；511 分析亦可由 includeDiscarded 全量重算）。
    // includeDiscarded（无过滤路径）：取 limit+1 以探测 hasMore。
    const fetchLimit = event.includeDiscarded === true ? limit + 1 : Math.min(limit * 3, 300)
    const res = await db.collection(CONTRA).where(where).orderBy('sortKey', 'desc').limit(fetchLimit).get()
    let rows = (res && res.data) || []
    if (event.includeDiscarded !== true) rows = rows.filter(r => r.status !== 'discarded')
    if (sinceMs !== null) rows = rows.filter(r => r.startTime >= sinceMs)
    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    const nextCursor = rows.length > limit && last ? last.sortKey : null
    return ok({ records: page.map(viewRecord), nextCursor, hasMore: Boolean(nextCursor) })
  }

// ── EFW 测量解析与 Hadlock 纯计算 ──
// 返回 {err} 或 {hcCm, acCm, flCm}：单位换算（mm/10）→ 有限正数 → 范围门（逐项精确拒因）
function parseEfwMeasurements(input) {
  const u = input.unit === undefined || input.unit === null ? 'cm' : input.unit
  if (u !== 'cm' && u !== 'mm') return { err: 'unit 须 cm 或 mm' }
  const factor = u === 'mm' ? 0.1 : 1
  const out = {}
  for (const key of ['hc', 'ac', 'fl']) {
    const v = input[key]
    if (typeof v !== 'number' || !Number.isFinite(v)) return { err: `${key} 须有限数字` }
    const cm = v * factor
    if (cm <= 0) return { err: `${key} 须为正数` }
    const [lo, hi] = EFW_RANGES[key]
    if (cm < lo || cm > hi) return { err: `${key}=${cm.toFixed(2)}cm 超出合理范围 [${lo}, ${hi}]cm` }
    out[`${key}Cm`] = cm
  }
  return out
}

// Hadlock 1985 三参数（纯函数——输入 cm）：返回 {log10, exactEfwGrams(两位小数), efwGrams(整数克)}
function computeHadlock(hcCm, acCm, flCm) {
  const log10 = 1.326 - 0.00326 * acCm * flCm + 0.0107 * hcCm + 0.0438 * acCm + 0.158 * flCm
  const exact = Math.pow(10, log10)
  return { log10, exactEfwGrams: Math.round(exact * 100) / 100, efwGrams: Math.round(exact) }
}

function viewEfw(doc) {
  if (!doc) return null
  return {
    recordId: doc._id || doc.recordId,
    memberId: doc.memberId,
    dateKey: doc.dateKey,
    gestationalWeek: doc.gestationalWeek,
    measurements: doc.measurements || null,
    formula: doc.formula,
    efwGrams: doc.efwGrams,
    exactEfwGrams: doc.exactEfwGrams,
    reportId: doc.reportId ?? null,
    notes: doc.notes ?? null,
    status: doc.status,
    revision: doc.revision,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  }
}

// ══ E2 估重（efw.calculate / save / delete / list）══

if (action === 'efw.calculate') {
  const parsed = parseEfwMeasurements(event)
  if (parsed.err) return fail('invalid-params', `测量参数非法：${parsed.err}`)
  const { hcCm, acCm, flCm } = parsed
  const r = computeHadlock(hcCm, acCm, flCm)
  return ok({
    inputsCm: { hcCm, acCm, flCm },
    formula: HADLOCK_FORMULA,
    log10: Math.round(r.log10 * 100000) / 100000,
    exactEfwGrams: r.exactEfwGrams,
    efwGrams: r.efwGrams,
    efwKg: Math.round(r.exactEfwGrams) / 1000,
    rangeGrams: { low: Math.round(r.exactEfwGrams * 0.9), high: Math.round(r.exactEfwGrams * 1.1) } // ±10% 参考区间（展示层）
  })
}

if (action === 'efw.save') {
  const gestationalWeek = event.gestationalWeek
  if (!Number.isInteger(gestationalWeek) || gestationalWeek < EFW_WEEK_RANGE[0] || gestationalWeek > EFW_WEEK_RANGE[1]) {
    return fail('invalid-params', `gestationalWeek 须 ${EFW_WEEK_RANGE[0]}~${EFW_WEEK_RANGE[1]} 整数`)
  }
  const parsed = parseEfwMeasurements(event)
  if (parsed.err) return fail('invalid-params', `测量参数非法：${parsed.err}`)
  const { hcCm, acCm, flCm } = parsed
  const unit = event.unit === undefined || event.unit === null ? 'cm' : event.unit
  // BPD：伴随测量存储（mm）——不参与本公式（禁忌：不可替代缺失 HC）
  let bpdMm = null
  if (event.bpd !== undefined && event.bpd !== null) {
    if (typeof event.bpd !== 'number' || !Number.isFinite(event.bpd) || event.bpd <= 0) {
      return fail('invalid-params', 'bpd 须有限正数（或省略）')
    }
    bpdMm = unit === 'mm' ? event.bpd : event.bpd * 10
  }
  let dateKey = event.dateKey
  if (dateKey === undefined || dateKey === null) dateKey = shanghaiDateKey(Date.now())
  if (!DATE_RE.test(String(dateKey))) return fail('invalid-params', 'dateKey 须 YYYY-MM-DD')
  let notes = event.notes === undefined || event.notes === null ? null : event.notes
  if (notes !== null && (typeof notes !== 'string' || notes.length > NOTES_MAX)) {
    return fail('invalid-params', `notes 须 ≤${NOTES_MAX} 字文本`)
  }
  let reportId = event.reportId === undefined || event.reportId === null ? null : event.reportId
  if (reportId !== null && (typeof reportId !== 'string' || reportId.length > ID_MAX)) {
    return fail('invalid-params', 'reportId 须字符串')
  }
  // 服务端权威计算（不信任客户端 EFW——save 恒以服务端公式结果落盘）
  const calc = computeHadlock(hcCm, acCm, flCm)
  const now = Date.now()
  const recordId = 'efw_' + randomBytes(8).toString('hex')
  const opKey = `${caller.memberId}:${event.operationId}`
  const opDoc = {
    memberId: caller.memberId, operationId: event.operationId, kind: 'tools-efw-save',
    requestHash: digestOf({ gestationalWeek, hcCm, acCm, flCm, unit, bpdMm, dateKey, reportId: reportId ?? null, notes: notes ?? null })
  }
  const t = await db.startTransaction()
  try {
    const guard = await opGuard(t, opKey, opDoc)
    if (guard.replayed === 'ok') {
      const cur = guard.entity && guard.entity.collection === EFW ? await getDocMaybe(t, EFW, guard.entity.docId) : null
      await t.rollback()
      return ok({ replayed: true, record: viewEfw(cur) })
    }
    if (guard.replayed) return guard.replayed
    const doc = {
      familyId: fid, memberId: caller.memberId, dateKey,
      gestationalWeek,
      measurements: { hcCm, acCm, flCm, inputUnit: unit, bpdMm },
      formula: HADLOCK_FORMULA,
      efwGrams: calc.efwGrams, exactEfwGrams: calc.exactEfwGrams,
      reportId, notes,
      status: 'active',
      revision: 1, createdAt: now, updatedAt: now,
      sortKey: `${dateKey}:${recordId}`
    }
    await t.collection(EFW).doc(recordId).set({ data: { ...doc } })
    await t.collection(OPS).doc(opKey).set({
      data: { ...opDoc, entity: { collection: EFW, docId: recordId }, createdAt: now }
    })
    await t.commit()
    return ok({ record: viewEfw({ ...doc, _id: recordId }) })
  } catch (err) {
    try { await t.rollback() } catch (e) { /* 已回滚 */ }
    return txFailed(err)
  }
}

if (action === 'efw.delete') {
  const recordId = event.recordId
  if (!recordId || typeof recordId !== 'string' || recordId.length > ID_MAX) return fail('invalid-params', '缺少有效 recordId')
  const expected = parseExpectedRevision(event.expectedRevision)
  if (expected === null) return fail('invalid-params', 'expectedRevision 必须是显式非负整数')
  const opKey = `${caller.memberId}:${event.operationId}`
  const opDoc = {
    memberId: caller.memberId, operationId: event.operationId, kind: 'tools-efw-delete',
    requestHash: digestOf({ recordId, expectedRevision: expected })
  }
  const now = Date.now()
  const t = await db.startTransaction()
  try {
    const guard = await opGuard(t, opKey, opDoc)
    if (guard.replayed === 'ok') {
      const cur = guard.entity && guard.entity.collection === EFW ? await getDocMaybe(t, EFW, guard.entity.docId) : null
      await t.rollback()
      return ok({ replayed: true, record: viewEfw(cur) })
    }
    if (guard.replayed) return guard.replayed
    const record = await getDocMaybe(t, EFW, recordId)
    if (!record || record.familyId !== fid) { await t.rollback(); return fail('not-found', '记录不存在') }
    if (expected !== record.revision) {
      await t.rollback()
      return fail('revision-conflict', '记录已被更新，请刷新后重试', { currentRevision: record.revision })
    }
    if (record.status === 'discarded') { await t.rollback(); return fail('invalid-state', '记录已删除') }
    const merged = { ...stripId(record), status: 'discarded', revision: record.revision + 1, updatedAt: now }
    await t.collection(EFW).doc(recordId).set({ data: merged })
    await t.collection(OPS).doc(opKey).set({
      data: { ...opDoc, entity: { collection: EFW, docId: recordId }, createdAt: now }
    })
    await t.commit()
    return ok({ record: viewEfw({ ...merged, _id: recordId }) })
  } catch (err) {
    try { await t.rollback() } catch (e) { /* 已回滚 */ }
    return txFailed(err)
  }
}

if (action === 'efw.list') {
  const limitRaw = Number(event.limit || PAGE_DEFAULT)
  const limit = Math.min(Math.max(Number.isInteger(limitRaw) ? limitRaw : PAGE_DEFAULT, 1), PAGE_MAX)
  const cursor = (typeof event.cursor === 'string' && event.cursor) || null
  const cmd = db.command
  const where = { familyId: fid }
  if (cursor) where.sortKey = cmd.lt(cursor)
  // 软废弃默认排除（超取+过滤+截断——与 contraction.list 同款策略）
  const fetchLimit = event.includeDiscarded === true ? limit + 1 : Math.min(limit * 3, 300)
  const res = await db.collection(EFW).where(where).orderBy('sortKey', 'desc').limit(fetchLimit).get()
  let rows = (res && res.data) || []
  if (event.includeDiscarded !== true) rows = rows.filter(r => r.status !== 'discarded')
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  const nextCursor = rows.length > limit && last ? last.sortKey : null
  return ok({ records: page.map(viewEfw), nextCursor, hasMore: Boolean(nextCursor) })
}

  // ══ E3 饮食/行为安全速查 + AI 代理网关 ══

  if (action === 'food.search') {
    const SAFETY_LEVELS = ['safe', 'caution', 'avoid', 'insufficient']
    const keyword = event.keyword === undefined || event.keyword === null ? '' : String(event.keyword)
    if (keyword.length > 64) return fail('invalid-params', 'keyword 须 ≤64 字')
    if (event.category !== undefined && event.category !== null && event.category !== 'all' && !['food', 'behavior'].includes(event.category)) {
      return fail('invalid-params', 'category 须 food|behavior|all')
    }
    if (event.level !== undefined && event.level !== null && !SAFETY_LEVELS.includes(event.level)) {
      return fail('invalid-params', `level 须 ${SAFETY_LEVELS.join('/')}`)
    }
    const limitRaw = Number(event.limit || 20)
    const limit = Math.min(Math.max(Number.isInteger(limitRaw) ? limitRaw : 20, 1), 100)
    const kw = keyword.trim().toLowerCase()
    const matched = FOOD_SAFETY_ENTRIES.filter(e => {
      if (event.category && event.category !== 'all' && e.category !== event.category) return false
      if (event.level && e.level !== event.level) return false
      if (!kw) return true
      if (String(e.name).toLowerCase().includes(kw)) return true
      return (e.synonyms || []).some(s => String(s).toLowerCase().includes(kw))
    })
    // 未命中即 items:[]——绝不假造、绝不默认标安全（零假安全铁律）
    return ok({ items: matched.slice(0, limit), total: matched.length })
  }

  if (action === 'ai.explainFood') {
    const query = event.query
    if (typeof query !== 'string' || query.trim() === '') return fail('invalid-params', 'query 须非空字符串')
    const qLen = Array.from(query).length
    if (qLen < 1 || qLen > 50) return fail('invalid-params', `query 须 1~50 字（实得 ${qLen} 字）`)
    const stage = event.stage === undefined || event.stage === null ? '' : String(event.stage)
    if (stage.length > 20) return fail('invalid-params', 'stage 须 ≤20 字')
    const provider = aiProvider()
    if (!provider) {
      // 零幻觉状态：未配置即如实未启用（规格原文）
      return ok({ enabled: false, message: 'AI 服务未配置或未启用，请查阅本地已审定词条或咨询医生' })
    }
    const prompt = buildFoodPrompt(query, stage)
    let answer
    try {
      answer = await provider.call(prompt, { kind: 'explainFood', query, stage })
    } catch (e) {
      return fail('ai-call-failed', 'AI 服务调用失败，请稍后重试或咨询医生', { errMsg: String((e && e.message) || e).slice(0, 120) })
    }
    return ok({ enabled: true, answer: String(answer), disclaimer: AI_DISCLAIMER, model: provider.kind })
  }

  if (action === 'ai.analyzeReport') {
    const reportId = event.reportId
    if (!reportId || typeof reportId !== 'string' || reportId.length > ID_MAX) return fail('invalid-params', '缺少有效 reportId')
    // 报告须存在+本家庭+未软删（不存在/跨家庭/已删统一 not-found——不泄露存在性）
    const report = await getDocMaybe(db, REPORTS, reportId)
    if (!report || report.familyId !== fid || report.deleted === true) {
      return fail('report-not-found', '报告不存在或已删除')
    }
    const provider = aiProvider()
    if (!provider) {
      return ok({ enabled: false, message: '报告自动 OCR / DeepSeek 解读服务未配置；请以原始检验单与主治医生诊断为准' })
    }
    // Phase G 视觉直读阶段（规格 docs/PHASE_G_VISION_DIRECT_SPEC.md）：MC_REPORT_VISION 恰 '1'
    // 且有附件 → 整体绕过 OCR（零 printedText 调用），图片直送 deepseek-flash。
    // flash 是白名单内唯一原生视觉模型——模型不符 fail-closed 明确拒绝，不静默降级 OCR/元数据。
    const attachments = Array.isArray(report.attachments) ? report.attachments : []
    const useVision = attachments.length > 0 && visionEnabled()
    if (useVision && deepseekModel() !== 'deepseek-flash') {
      return fail('vision-config-error', '视觉直读需 deepseek-flash 模型（当前 MC_DEEPSEEK_MODEL 非 flash），请修正配置或取消 MC_REPORT_VISION')
    }
    let visionImages = null
    let visionPageFileIds = []
    let visionPageCount = 0
    if (useVision) {
      try {
        const v = await extractVisionImages(db, fid, attachments)
        visionImages = v.images
        visionPageFileIds = v.pageFileIds
        visionPageCount = v.pageCount
      } catch (e) {
        if (e && e.code === 'invalid-attachment') return fail('invalid-attachment', e.message)
        if (e && (e.code === 'vision-download-failed' || e.code === 'vision-image-too-large' || e.code === 'vision-unsupported-format')) {
          return fail(e.code, e.message)
        }
        return fail('vision-download-failed', '图片提取失败，请重试或以原始检验单为准', { errMsg: String((e && e.message) || e).slice(0, 120) })
      }
    }
    // Phase G OCR 阶段（独立开关）：视觉直读启用时整体跳过；附件存在且 OCR 提供方配置时提取文本，否则元数据模式
    const ocrOp = !useVision && attachments.length > 0 ? ocrProvider() : null
    let ocrIncluded = false
    let ocrText = ''
    let ocrPageFileIds = []
    let ocrProviderKind = ''
    let ocrGeneratedAt = 0
    if (ocrOp) {
      const cached = reusableOcr(report, ocrOp, attachments)
      if (cached) {
        ocrIncluded = true
        ocrText = cached.text
        ocrPageFileIds = Array.isArray(cached.pageFileIds) ? cached.pageFileIds : []
        ocrProviderKind = cached.provider
        ocrGeneratedAt = cached.generatedAt || 0
      } else {
        let extracted
        try {
          extracted = await extractOcrForReport(db, fid, attachments, ocrOp)
        } catch (e) {
          if (e && e.code === 'invalid-attachment') return fail('invalid-attachment', e.message)
          return fail('ocr-call-failed', 'OCR 识别失败，请重试或以原始检验单为准', { errMsg: String((e && e.message) || e).slice(0, 120) })
        }
        ocrIncluded = true
        ocrText = extracted.text
        ocrPageFileIds = extracted.pageFileIds
        ocrProviderKind = ocrOp.kind
      }
    }
    // 安全边界：仅送报告公开元数据 + 本报告附件自身 OCR 文本——严禁透传私人心情/日记/无关身体数据
    const atts = attachments.length
    const promptParts = [
      '你是产科超声/检验报告解读助手。请基于以下报告信息给出一般性说明与就诊建议，',
      '不得给出具体用药剂量，不得替代医生诊断。',
      `报告日期：${report.dateKey || '未知'}；类型：${report.reportType || '未知'}；附件数：${atts}；`,
      `备注：${typeof report.note === 'string' && report.note ? report.note.slice(0, 100) : '无'}`
    ]
    if (ocrIncluded) {
      promptParts.push(
        '\n报告图像 OCR 提取文本（识别可能有误差）：',
        ocrText,
        '\n请优先依据 OCR 文本逐项分析实际出现的指标与参考值；OCR 文本中未出现的指标不得编造。'
      )
    }
    if (visionImages) {
      // 视觉直读：指令随图下发（图片作为 image_url 块附在同一条 user 消息）
      promptParts.push(
        `\n本次请求附报告图片前 ${visionPageCount} 张（可能与报告附件总数不一致——页数封顶）。`,
        '\n请优先依据图片中实际出现的指标与参考值逐项分析；图片中未出现的指标不得编造。'
      )
    }
    const prompt = promptParts.join('')
    let answer
    try {
      answer = await provider.call(prompt, {
        kind: 'analyzeReport', reportId, dateKey: report.dateKey, reportType: report.reportType, attachments: atts, ocrIncluded,
        ...(visionImages ? { images: visionImages } : {})
      })
    } catch (e) {
      return fail('ai-call-failed', 'AI 服务调用失败，请稍后重试或以原始检验单为准', { errMsg: String((e && e.message) || e).slice(0, 120) })
    }
    const text = String(answer)
    // 回写 mc_reports.ai_result（事务 CAS——revision 推进，迟到旧写冲突拒）
    const now = Date.now()
    const t = await db.startTransaction()
    try {
      const fresh = await getDocMaybe(t, REPORTS, reportId)
      if (!fresh || fresh.familyId !== fid || fresh.deleted === true) { await t.rollback(); return fail('report-not-found', '报告不存在或已删除') }
      const merged = { ...stripId(fresh) }
      merged.ai_result = { text, model: provider.kind, generatedAt: now }
      if (ocrIncluded) {
        // ocr_result 仅在实际提取（或复用）时写入；元数据模式不动旧值
        merged.ocr_result = { text: ocrText, included: true, provider: ocrProviderKind, generatedAt: ocrGeneratedAt || now, pageFileIds: ocrPageFileIds }
      }
      if (visionImages) {
        // vision_result 仅在视觉直读时写入（与 ocr_result 互斥——视觉模式整体跳过 OCR）
        merged.vision_result = { included: true, pageCount: visionPageCount, generatedAt: now, pageFileIds: visionPageFileIds }
      }
      merged.revision = (fresh.revision || 0) + 1
      merged.updatedAt = now
      merged.updatedBy = caller.memberId
      await t.collection(REPORTS).doc(reportId).set({ data: merged })
      await t.commit()
    } catch (err) {
      try { await t.rollback() } catch (e) { /* 已回滚 */ }
      return txFailed(err)
    }
    return ok({ enabled: true, answer: text, disclaimer: AI_DISCLAIMER, model: provider.kind, ocrIncluded, ocrText: ocrIncluded ? ocrText : '', visionIncluded: Boolean(visionImages), reportRevision: (report.revision || 0) + 1 })
  }

  return fail('invalid-action', `未知 action: ${String(action)}`)
}
