'use strict'

// mc-restore：隔离恢复协议（B3b 阶段二·权威设计 §5）。
//
// 外部 action 名：restore.begin / restore.declareChunk / ...
//
// 核心语义（P0 修正版）：
// - owner-only / 请求 ≤64KiB / 响应 ≤256KiB（每个返回统一 resGuard）
// - chunkTotal 锚定：manifest 首片入批次文档 / per-record anchor 文档
// - uploadRecordChunk：chunk 存在+内容+anchor+字节上限+chunk 写+generation 全在一个 CAS 事务
// - indexDeclarePage：小页（48）+ CAS 游标+滚动摘要+事务原子写；末页核对滚动根 vs 声明根
// - declareChunk：manifest v1 schema 严格校验（与阶段一 container.validateManifest 结构子集
//   逐项对齐：scope/scopeLabel/三态域+visibility/path/上限/附件块数/reports 双向映射/声明唯一性）
// - begin：rst_+128bit hex、existing 优先（任何承诺变化含 formatVersion→batch-conflict）、
//   slot-lock 文档 CAS——活跃计数+创建同一事务（≤2 互斥）、totals.domainCounts 校验
// - uploadRecord/finalizeRecord：canonical bytes 重算+域白名单+declaration 全等
//   + id/revision/deleted 须显式提供且与声明/首次结果精确全等（无 ??/|| 回退）+finalize 事务内复核
// - SDK：require wx-server-sdk + cloud.init（mc-health 同型）

const { createHash, randomBytes } = require('node:crypto')
const { loadServerConfig } = require('./shared/config')
const { resolveCaller } = require('./shared/auth')
const { ok, fail } = require('./shared/respond')
// V20 索引块子协议纯函数模块（派生/打包/树/证明——仅显式启用模式的 preparing/finalizeDeclare 使用）。
// 弹性加载：模块缺失（如旧部署包未含 v20.js）不破坏默认关的 legacy 行为——仅启用门连带要求模块在场。
let v20 = null
try { v20 = require('./v20') } catch (e) { v20 = null }

let cloud = null
try { cloud = require('wx-server-sdk') } catch (e) { cloud = null }
exports.__setCloud = function __setCloud(mockCloud) { cloud = mockCloud }

// V20 协议开关（D29/审查切片裁定）：仅当 MC_RESTORE_V20_ENABLED 恰为字符串 'true' 时请求 V20 模式。
// **fail-closed（协调方复核修正 2026-09-20）**：flag='true' 但 v20 模块缺失/加载失败 → dispatch 前置门
// 明确拒（internal-error）——**不得静默落回 legacy 路径**；flag 关（任何其他值）时 legacy 行为逐字节不变。
const v20FlagOn = () => process.env.MC_RESTORE_V20_ENABLED === 'true'
const v20Enabled = () => v20FlagOn() && v20 !== null

const COLLECTIONS = {
  batches: 'mc_restore_batches',
  declareChunks: 'mc_restore_declare_chunks',
  declarations: 'mc_restore_declarations',
  anchors: 'mc_restore_anchors',
  records: 'mc_restore_records',
  recordChunks: 'mc_restore_record_chunks',
  files: 'mc_restore_files',
  slotLocks: 'mc_restore_slot_locks',
  blocks: 'mc_restore_blocks',
  filesRef: 'mc_files'
}
const MAX_REQUEST_JSON = 64 * 1024
const MAX_RESPONSE_JSON = 256 * 1024
const MAX_CHUNK_B64 = 40 * 1024
const MAX_MANIFEST_CHUNKS = 128
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024 // 阶段一 LIMITS.MAX_MANIFEST_BYTES 同限（128×40KiB 运输上限 5MiB>4MiB——重组后必须显式截断）
const MAX_RECORD_CHUNKS = 103
const MAX_DOMAIN_JSON_BYTES = 4 * 1024 * 1024
const MAX_DOMAIN_BYTES_LIMIT = MAX_DOMAIN_JSON_BYTES
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024 // 与阶段一 LIMITS 一致（container.js）
const VERIFY_BLOCK = 256 * 1024 // 附件字节复验块（manifest chunkSha256 块数核对用）
const MAX_ACTIVE_BATCHES = 2
const MAX_RECORDS = 10000
const MAX_FILES = 500
const MAX_PKG_BYTES = 64 * 1024 * 1024
const KEYED_GET_BATCH = 20
const PROGRESS_PAGE_SIZE = 50   // progress/list 每页条数（§5.1 响应 ≤256KiB——resGuard 强制）
const LIST_PAGE_SIZE = 50
// ── commit/verify/abandon（§5.1 动作表 + §5.2.1 并发串行化）──
const PREFLIGHT_PAGE_SIZE = 40            // 预检每页声明数（≤50——验证页同族上限）
const PREFLIGHT_LEASE_MS = 5 * 60 * 1000  // 预检租约（默认 5 分钟无进展——过期可 CAS 接管）
const VERIFY_PAGE_ITEMS = 50              // 验证页上限①：≤50 项/页
const VERIFY_PAGE_BYTES = 256 * 1024      // 验证页上限②：单页读取字节 ≤256KiB（两项同时生效）
const ABANDON_PAGE_DOCS = 100             // 每事务 ≤100 操作（CloudBase 事务上限——含读+写）
const ABANDON_TX_GROUPS = 2               // 每次调用 ≤2 事务组（≤200 删除——设计 ≤500/调用上界内保守值）
const ABANDON_COLS = [                    // 清理集合序（§5.2.1 组1-5 + V20 块集合）
  COLLECTIONS.declareChunks, COLLECTIONS.anchors, COLLECTIONS.declarations,
  COLLECTIONS.recordChunks, COLLECTIONS.records, COLLECTIONS.files, COLLECTIONS.blocks,
]
// progress 响应字节有界（V8 idRef 协议——评审：数百 KiB 报告 id 单条即越 256KiB）：
// 字段序列化 ≤ID_INLINE_MAX 内联原值；否则短承诺 {<f>Hash,<f>Len}（全量字节经 preview 正文分片游标分页——
// preview 随 Phase 2 实现）。页累计序列化 ≤PROGRESS_PAGE_BYTES 提前收页（resGuard 256KiB 为兜底非设计边界）。
const ID_INLINE_MAX = 2 * 1024
// 批次聚合记录字节硬上限（V13 §7 计数证明基础）：合法 full 包记录正文=域数组元素，
// Σ ≤ 6 域 × 4MiB 域段上限 = 24MiB。服务端在同一 CAS 事务内递增 aggregateRecordBytes——
// 规范形状下使 chunk 文档总数可数（Σ⌈rᵢ/40KiB⌉ ≤ ⌈24MiB/40KiB⌉+10000=10,615）。
const MAX_BATCH_RECORD_BYTES = 24 * 1024 * 1024
const PROGRESS_PAGE_BYTES = 192 * 1024
// 长字段短承诺：内联（≤2KiB）或 {hash,len}——type 严格（hash=64hex 字符串、len=非负整数）
// 错误消息内嵌标识符的截断预览——合法包 id 无格式上限（可达数百 KiB），
// 消息内嵌全量会撑破响应上限并泄露内容（V8 idRef 评审发现）
function idPrev(v) {
  const s = typeof v === 'string' ? v : String(v)
  const b = Buffer.byteLength(s, 'utf8')
  return b > 48 ? JSON.stringify(s.slice(0, 24)) + '…(len=' + b + ')' : JSON.stringify(s)
}
function inlineOrShort(field, value) {
  if (typeof value !== 'string') return { [field]: value }
  const len = Buffer.byteLength(value, 'utf8')
  if (len <= ID_INLINE_MAX && JSON.stringify(value).length <= ID_INLINE_MAX) return { [field]: value }
  return { [field + 'Hash']: sha256Hex(Buffer.from(value, 'utf8')), [field + 'Len']: len }
}
const INDEX_PAGE_SIZE = 48 // 48×(1get+1set) + 1 batch get + 1 batch set = 98 ≤ 100 事务操作 // 小页——事务原子写 50 声明 + CAS 游标
const SUPPORTED_DOMAINS = ['pregnancy', 'daily', 'mood', 'checkup', 'bag', 'reports']
const HEX64 = /^[0-9a-f]{64}$/

function sha256Hex(buf) { return createHash('sha256').update(buf).digest('hex') }
function b64decode(str) { return Buffer.from(str, 'base64') }
function reqSize(event) {
  try { return Buffer.byteLength(JSON.stringify(event), 'utf8') } catch (e) { return MAX_REQUEST_JSON + 1 }
}
function resGuard(data) {
  try {
    const size = Buffer.byteLength(JSON.stringify(data), 'utf8')
    if (size > MAX_RESPONSE_JSON) return fail('response-too-large', `响应 ${size} > ${MAX_RESPONSE_JSON}`)
  } catch (e) { return fail('response-serialize-failed') }
  return data
}
// Strict canonical stringify — matches Stage1 utils/mcpkg/canonical.js exactly:
// undefined in arrays/sparse → throw; lone surrogate strings/keys → throw;
// undefined/function/symbol object values → throw; NaN/Infinity → throw
function stableStringify(value) {
  if (value === undefined) throw new Error('canonical-invalid: undefined value')
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) throw new Error('malformed-surrogate')
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical-invalid: non-finite number')
    return String(value)
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    const parts = []
    for (let i = 0; i < value.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) throw new Error('canonical-invalid: sparse array')
      if (value[i] === undefined) throw new Error('canonical-invalid: undefined in array')
      parts.push(stableStringify(value[i]))
    }
    return '[' + parts.join(',') + ']'
  }
  const keys = Object.keys(value).sort()
  const parts = []
  for (const k of keys) {
    if (hasLoneSurrogate(k)) throw new Error('malformed-surrogate key')
    if (value[k] === undefined || typeof value[k] === 'function' || typeof value[k] === 'symbol') {
      throw new Error('canonical-invalid: undefined/function/symbol value for key ' + k)
    }
    parts.push(JSON.stringify(k) + ':' + stableStringify(value[k]))
  }
  return '{' + parts.join(',') + '}'
}
function hasLoneSurrogate(str) {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < str.length ? str.charCodeAt(i + 1) : 0
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) return true
  }
  return false
}
// strict base64 validation
function isValidB64(s) {
  return typeof s === 'string' && s.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s)
}
// 严格 UTF-8 解码（与阶段一 utf8.decodeStrict 逐字节同语义：非法起始/后续字节、超长编码、
// 代理区编码、截断一律抛错——绝不静默替换 U+FFFD。Buffer#toString('utf8') 会替换，禁止用于验真路径）
function strictUtf8Decode(buf) {
  let out = ''
  let i = 0
  const n = buf.length
  while (i < n) {
    const b = buf[i]
    if (b < 0x80) { out += String.fromCharCode(b); i++; continue }
    let len = 0, cp = 0
    if (b >= 0xc2 && b <= 0xdf) { len = 1; cp = b & 0x1f }
    else if (b >= 0xe0 && b <= 0xef) { len = 2; cp = b & 0x0f }
    else if (b >= 0xf0 && b <= 0xf4) { len = 3; cp = b & 0x07 }
    else throw new Error(`malformed-utf8：非法 UTF-8 起始字节 0x${b.toString(16)} @${i}`)
    if (i + len > n - 1) throw new Error(`malformed-utf8：UTF-8 序列在末尾截断 @${i}`)
    for (let k = 1; k <= len; k++) {
      const cb = buf[i + k]
      if ((cb & 0xc0) !== 0x80) throw new Error(`malformed-utf8：UTF-8 后续字节非法 @${i + k}`)
      cp = (cp << 6) | (cb & 0x3f)
    }
    if (len === 1 && cp < 0x80) throw new Error('malformed-utf8：超长编码')
    if (len === 2 && cp < 0x800) throw new Error('malformed-utf8：超长编码')
    if (len === 3 && cp < 0x10000) throw new Error('malformed-utf8：超长编码')
    if (cp >= 0xd800 && cp <= 0xdfff) throw new Error('malformed-utf8：代理区编码非法')
    if (cp > 0x10ffff) throw new Error('malformed-utf8：超 U+10FFFF')
    out += cp < 0x10000 ? String.fromCharCode(cp) : String.fromCodePoint(cp)
    i += len + 1
  }
  return out
}

// ── 域记录形状（服务端独立重施导出端键白名单）──
// 信任模型差异：阶段一 validatePackage 只验 manifest↔字节自洽（包由可信导出器产出）；
// 恢复侧 manifest 来自客户端——自洽的伪造 manifest（伪造 hash 与声明一致）可携带任意
// 形状/身份/映射错位，故键级与身份级规则服务端重施。
//
// 【值类型兼容性裁定（2026-09-20 评审）】字段 VALUE 类型/枚举/区间/长度**不在恢复侧强制**：
// - 阶段一导出 pick() 原样保留存储值，container.validatePackage 只验规范字节/键——历史记录
//   可能 nullable 或 legacy 类型；不得因当前写 API 类型更窄而拒绝 Stage1-valid full 包。
// - 隔离区（quarantine-only，权威设计 §5）：无已协定 schema 边界的意外但 JSON 安全的值
//   原样保留——本期无 merge/部分恢复/回灌，commit 只冻结+核验隔离记录，不按写 API 做值级
//   复核；任何未来"迁移入实时集合"属独立设计+用户显式授权的 out-of-scope 事项。
// 仍严格（已协定边界）：①顶层/嵌套键白名单（导出端投影形状）②id/身份与冻结声明全等
// ③daily/mood id===dateKey（导出端恒等不变式）④正文 revision/deleted 与冻结声明全等
// ⑤reports 附件条目恰 {fileId, order} 且与冻结映射逐位全等（fileId↔originalFileId/order）
// ⑥墓碑报告零附件。
// mood/daily 正文无 ownerId——私有归属仅由 batch scope/caller 冻结，不要求（也不允许）正文携带。
const PREGNANCY_FIELDS = ['lmpDate', 'dueDate', 'nickname', 'babyNickname', 'hospital', 'doctor', 'hospitalPhone', 'preWeightKg', 'heightCm']
const DAILY_FIELDS = ['weightKg', 'systolic', 'diastolic', 'fetalCount', 'sharedNote']
const MOOD_FIELDS = ['mood', 'symptoms', 'note', 'plans']
const CHECKUP_FIELDS = ['dateKey', 'time', 'hospital', 'companion', 'materials', 'questions', 'examItems', 'status', 'templateKey', 'source']
const BAG_FIELDS = ['name', 'category', 'quantity', 'location', 'assignee', 'prepared', 'templateKey']
const REPORT_FIELDS = ['reportType', 'dateKey', 'note', 'archiveStatus']
const RECORD_TOP_ALLOWED = {
  pregnancy: ['id', 'fields', 'revision', 'deleted'],
  daily: ['id', 'dateKey', 'fields', 'revision', 'deleted'],
  mood: ['id', 'dateKey', 'fields', 'revision', 'deleted'],
  checkup: ['id', 'revision', 'deleted', ...CHECKUP_FIELDS],
  bag: ['id', 'revision', 'deleted', ...BAG_FIELDS],
  reports: ['id', 'revision', 'deleted', 'attachments', ...REPORT_FIELDS],
}
const NESTED_KEY_WHITELIST = { pregnancy: PREGNANCY_FIELDS, daily: DAILY_FIELDS, mood: MOOD_FIELDS }
// 返回 null=合格；字符串=不合格原因（调用方零写拒绝）
function validateRecordShape(domain, record, decl) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return '记录须对象'
  const allowed = RECORD_TOP_ALLOWED[domain]
  for (const k of Object.keys(record)) {
    if (!allowed.includes(k)) return `未知顶层字段 ${k}（域白名单外）`
  }
  if (typeof record.revision !== 'number' || !Number.isFinite(record.revision)) return 'revision 须有限数字'
  if (typeof record.deleted !== 'boolean') return 'deleted 须布尔'
  // 正文不可变字段与冻结声明全等（自洽伪造 hash 不豁免——正文≠声明即拒）
  // P16：Stage1 用 Number()/Boolean() 比较——恢复侧等价比较
  if (Number(record.revision) !== Number(decl.revision)) return `正文 revision ${idPrev(record.revision)} ≠ 冻结声明 ${idPrev(decl.revision)}`
  if (Boolean(record.deleted) !== Boolean(decl.deleted)) return `正文 deleted ${idPrev(record.deleted)} ≠ 冻结声明 ${idPrev(decl.deleted)}`
  // 身份：导出端全部六域恒写 id（addDomainRecords/projected.id）；daily/mood 且 id===dateKey
  if (typeof record.id !== 'string' || !record.id) return 'id 须非空字符串（导出端恒有）'
  if (record.id !== decl.id) return `正文 id ${idPrev(record.id)} ≠ 冻结声明 ${idPrev(decl.id)}`
  if (domain === 'daily' || domain === 'mood') {
    if (record.dateKey === undefined || record.dateKey === null) return 'dateKey 须存在（导出端恒等 id===dateKey）'
    if (String(record.dateKey) !== String(record.id)) return `dateKey ${idPrev(record.dateKey)} ≠ id ${idPrev(record.id)}（导出端恒等——阶段一不变式）`
  }
  if (NESTED_KEY_WHITELIST[domain]) {
    if (!record.fields || typeof record.fields !== 'object' || Array.isArray(record.fields)) return 'fields 须对象'
    // 键白名单严格；值不强制类型（历史 nullable/legacy 值原样保留——见头部裁定）
    for (const k of Object.keys(record.fields)) {
      if (!NESTED_KEY_WHITELIST[domain].includes(k)) return `fields.${k} 域白名单外`
    }
  }
  if (domain === 'reports') {
    if (!Array.isArray(record.attachments)) return 'attachments 须数组'
    if (record.deleted && record.attachments.length > 0) return '墓碑报告正文不得携带附件'
    for (let i = 0; i < record.attachments.length; i++) {
      const a = record.attachments[i]
      if (!a || typeof a !== 'object' || Array.isArray(a)) return `attachments[${i}] 须对象`
      const keys = Object.keys(a).sort().join(',')
      if (keys !== 'order' && keys !== 'fileid,order'.replace('fileid', 'fileId')) return `attachments[${i}] 键集须 {order} 或 {fileId,order}（收到 {${keys}}）`
    }
    // 正文附件与冻结 reports 映射逐位全等（阶段一 container L437 同合同：String(b.fileId)===String(m.originalFileId)
    // 恒比——双方缺席=“undefined”===“undefined” 相等过；单方缺席≠对方值→拒——不静默跳过）
    const frozen = Array.isArray(decl.frozenReportAttachments) ? decl.frozenReportAttachments : []
    if (record.attachments.length !== frozen.length) {
      return `正文附件数 ${record.attachments.length} ≠ 冻结映射 ${frozen.length}`
    }
    for (let i = 0; i < frozen.length; i++) {
      const m = frozen[i]
      const b = record.attachments[i]
      if (!m || typeof m !== 'object') return `冻结映射[${i}] 非对象`
      if (String(b.fileId) !== String(m.originalFileId)) {
        return `附件[${i}] fileId ${idPrev(b.fileId)} ≠ 冻结映射 originalFileId ${idPrev(m.originalFileId)}`
      }
      if (Number(b.order) !== Number(m.order)) return `附件[${i}] order ${b.order} ≠ 冻结映射 ${m.order}`
    }
  }
  return null
}
async function getDocMaybe(db, col, id) {
  try {
    const r = await db.collection(col).doc(id).get()
    return (r && r.data) || null
  } catch (e) {
    const msg = String((e && e.errMsg) || e)
    if (/not\s*exist|does not exist/i.test(msg)) return null
    throw e
  }
}

// Strip _id and SDK metadata from doc.get() result before set() —
// SDK contract: doc(id).set({data}) with _id → -501007 rejection
function stripDoc(doc) {
  if (!doc || typeof doc !== 'object') return {}
  const { _id, ...fields } = doc
  return fields
}


// 聚合计数器磁盘态校验（fail-closed）：begin 自此写入 aggregateRecordBytes:0——undefined 不应出现；
// 兼容旧批次：undefined 仅在 contentGeneration===0（真未上传）时合法——有数据后删除/置 null 重置计数=拒
// null 一律拒（begin 从不写 null）；有值须安全非负整数且 ≤ effectiveCap
function validateAggCounter(val, cap, path, contentGeneration) {
  if (val === null) return `${path} 为 null（begin 不写 null——磁盘态篡改）`
  if (val === undefined) {
    // 兼容旧 begin（未初始化该字段）：仅 contentGeneration===0 的真未上传批次合法
    if (Number.isSafeInteger(contentGeneration) && contentGeneration === 0) return null
    return `${path} 缺失但 contentGeneration=${contentGeneration}（已有数据——计数器被删/篡改）`
  }
  if (!Number.isSafeInteger(contentGeneration) || contentGeneration < 0) {
    return `contentGeneration 磁盘态非法（=${contentGeneration}）`
  }
  if (!Number.isSafeInteger(val) || val < 0) return `${path} 磁盘态非法（=${typeof val === 'string' ? JSON.stringify(val) : val}）`
  if (val > cap) return `${path} 超上限（=${val} > ${cap}）`
  return null // 合法
}

async function keyedGetBatch(db, col, ids) {
  const results = []
  for (let i = 0; i < ids.length; i += KEYED_GET_BATCH) {
    const batch = ids.slice(i, i + KEYED_GET_BATCH)
    const docs = await Promise.all(batch.map(id => getDocMaybe(db, col, id)))
    for (let j = 0; j < batch.length; j++) results.push({ id: batch[j], doc: docs[j] })
  }
  return results
}

exports.main = async function main(event) {
  let result
  try { result = await dispatch(event) }
  catch (e) {
    // 服务端日志留定位线索（截断 errMsg——SDK 错误串可能含文档 ID，不含私人正文）；
    // 公开响应只给不透明 code——不透出内部细节（respond.js 原则）
    console.error('[mc-restore] internal-error:', (e && (e.errMsg || e.message)) ? String(e.errMsg || e.message).slice(0, 200) : String(e).slice(0, 200))
    result = fail('internal-error', '服务内部错误（详情见云函数日志）')
  }
  return resGuard(result)
}
async function dispatch(event) {
  const config = loadServerConfig()
  const auth = resolveCaller(cloud, config, event)
  if (!auth.ok) return auth
  const caller = auth.caller
  try { cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, throwOnNotFound: false }) }
  catch (e) { return fail('cloud-init-failed') }
  const rs = reqSize(event)
  if (rs > MAX_REQUEST_JSON) return fail('request-too-large', `请求 ${rs} > ${MAX_REQUEST_JSON}`)
  // fail-closed 前置门：flag=true 而 v20 模块不可用 = 部署错误——明确拒（不静默走 legacy）
  if (v20FlagOn() && v20 === null) {
    return fail('internal-error', 'MC_RESTORE_V20_ENABLED=true 但 v20 模块不可用（fail-closed——检查部署包含 v20.js）')
  }
  const action = event.action
  const localAction = action && action.startsWith('restore.') ? action.slice(8) : action
  switch (localAction) {
    case 'begin': return await handleBegin(cloud, config, caller, event)
    case 'declareChunk': return await handleDeclareChunk(cloud, config, caller, event)
    case 'finalizeDeclare': {
      // V20 新动作仅显式启用后可用（默认关=无新公共面——L1 基线不变）
      if (!v20Enabled()) return fail('invalid-params', 'restore.finalizeDeclare 未启用（MC_RESTORE_V20_ENABLED 须恰为字符串 "true"）')
      return await handleFinalizeDeclare(cloud, config, caller, event)
    }
    case 'indexDeclarePage': return await handleIndexDeclarePage(cloud, config, caller, event)
    case 'uploadRecord': return await handleUploadRecord(cloud, config, caller, event)
    case 'uploadRecordChunk': return await handleUploadRecordChunk(cloud, config, caller, event)
    case 'finalizeRecord': return await handleFinalizeRecord(cloud, config, caller, event)
    case 'progress': return await handleProgress(cloud, config, caller, event)
    case 'list': return await handleList(cloud, config, caller, event)
    case 'commit': return await handleCommit(cloud, config, caller, event)
    case 'verify': return await handleVerify(cloud, config, caller, event)
    case 'abandon': return await handleAbandon(cloud, config, caller, event)
    default: return fail('invalid-params', `未知 action: ${action}`)
  }
}
async function getOwnedBatch(db, batchId, caller, config) {
  if (!batchId || typeof batchId !== 'string' || batchId.length > 64) return { err: fail('invalid-params', 'batchId 非法') }
  const batch = await getDocMaybe(db, COLLECTIONS.batches, batchId)
  if (!batch) return { err: fail('batch-not-found', '批次不存在') }
  if (batch.ownerMemberId !== caller.memberId) return { err: fail('not-batch-owner', '批次属于其他成员') }
  if (batch.familyId !== config.familyId) return { err: fail('family-mismatch', '批次属于其他家庭') }
  return { batch }
}

// ── manifest v1 schema 严格校验（declareChunk 服务端判定）──
// 与阶段一 container.validateManifest 的结构子集逐项对齐（不读文件字节——
// 文件字节级摘要（files[].sha256 / chunkSha256 实际字节）由后续 attach/commit 验证，
// 本阶段只核 manifest 内可判定的自洽性，不声称字节已验真）。
function assertNoLoneSurrogatesDeep(value, path, seen) {
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) throw new Error(`malformed-surrogate（${path}）`)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (!seen) seen = new Set()
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertNoLoneSurrogatesDeep(value[i], `${path}[${i}]`, seen)
    return
  }
  for (const k of Object.keys(value)) {
    if (hasLoneSurrogate(k)) throw new Error(`malformed-surrogate key（${path}.${k}）`)
    assertNoLoneSurrogatesDeep(value[k], `${path}.${k}`, seen)
  }
}

function validateManifestSchema(manifest, manifestLen, caller, config) {
  if (!manifest || typeof manifest !== 'object') return 'manifest 非对象'
  try { assertNoLoneSurrogatesDeep(manifest, '$', null) } catch (e) { return e.message }
  if (manifest.formatVersion !== 1) return `formatVersion=${manifest.formatVersion}（须精确 1）`
  if (manifest.packageKind !== 'full') return `packageKind=${manifest.packageKind}（恢复仅收 full）`
  if (manifest.complete !== true) return 'complete!=true（full 包须 complete）'
  // scope/scopeLabel：私人 scope 仅限本人；scopeLabel（如提供）须与 scope 一致
  const scope = manifest.scope
  if (!scope || typeof scope !== 'object') return 'scope 缺失'
  if (scope.includePrivateOf !== undefined && scope.includePrivateOf !== null && scope.includePrivateOf !== caller.memberId) {
    return '私人 scope 须为本人（伪造 scope 拒绝）'
  }
  if (typeof manifest.scopeLabel === 'string') {
    const expectedLabel = scope.includePrivateOf ? 'shared-plus-own-private' : 'shared-only'
    if (manifest.scopeLabel !== expectedLabel) return `scopeLabel=${manifest.scopeLabel} 与 scope 不一致（须 ${expectedLabel}）`
  }
  // pending：full 包不得有未决数组，也不得 indeterminate
  const pending = manifest.pending || {}
  if (Object.values(pending).some(v => Array.isArray(v) && v.length > 0)) return 'pending 非空（full 包不得有未决项）'
  if (pending.indeterminate === true) return 'pending.indeterminate=true（full 包不得不确定）'

  // domains：三态齐全+未知域拒绝+visibility/fileIndex 自洽
  const domains = manifest.domains || {}
  const files = manifest.files
  if (!Array.isArray(files)) return 'files 非数组'
  if (files.length > MAX_FILES) return `files ${files.length} > ${MAX_FILES}`
  for (const key of Object.keys(domains)) {
    if (!SUPPORTED_DOMAINS.includes(key)) return `未知域 ${key}`
  }
  for (const d of SUPPORTED_DOMAINS) {
    if (!domains[d]) return `受支持域 ${d} 未显式声明`
  }
  const domainFileIndexes = new Set()
  for (const [d, entry] of Object.entries(domains)) {
    if (!entry || typeof entry !== 'object') return `域 ${d} 条目非对象`
    if (entry.status === 'present') {
      if (!Number.isInteger(entry.fileIndex) || entry.fileIndex < 0 || entry.fileIndex >= files.length) return `域 ${d}.fileIndex 越界`
      const f = files[entry.fileIndex]
      if (!f || f.kind !== 'domain-json') return `域 ${d}.fileIndex 指向非 domain-json 段`
      // f.domain 是完全冗余字段：Stage1 container.js 从不读取（权威判定是 fileIndex 绑定+kind——
      // 上面两行已验）。缺席/在场/在场但不一致均属 Stage1-valid 全包（2026-09-20 审查裁定：
      // 移除信息性不一致检查——恢复侧接受范围不得窄于 Stage1 全包合同）。
      if (domainFileIndexes.has(entry.fileIndex)) return `域 ${d} 与其他域共用 fileIndex ${entry.fileIndex}`
      domainFileIndexes.add(entry.fileIndex)
      if (!Number.isInteger(entry.recordCount) || entry.recordCount < 0) return `域 ${d}.recordCount 非法`
      if (entry.pagingComplete !== true) return `域 ${d}.pagingComplete 缺失或 false`
      if (entry.visibility !== 'shared' && entry.visibility !== 'private') return `域 ${d}.visibility 非法`
      // mood⇔private 双向强制：mood 是唯一私人域（导出端 def.shared 仅 mood 为 false）
      if (d === 'mood' && entry.visibility !== 'private') return 'mood 域只能为 private 可见性（客户端标 shared 拒绝）'
      if (d !== 'mood' && entry.visibility === 'private') return `域 ${d} 无 private 可见性（仅 mood 为私人域）`
      if (entry.visibility === 'private' && !scope.includePrivateOf) return `域 ${d} visibility=private 但 scope 未含本人私人（伪造 scope）`
    } else if (entry.status === 'omitted' || entry.status === 'missing') {
      if (entry.fileIndex !== undefined) return `${entry.status} 域 ${d} 不得有 fileIndex`
      if (entry.status === 'missing' && !['read-failed', 'unsupported-schema'].includes(entry.reason)) return `missing 域 ${d} reason 非法`
    } else {
      return `域 ${d}.status 非法`
    }
  }
  // full⇒complete=true：不得有任何 missing 域（阶段一 incoherent-complete 同规则——read-failed 与完整包互斥）
  if (Object.values(domains).some(e => e && e.status === 'missing')) return 'complete=true 与 missing 域自相矛盾（full 包不得有 missing）'
  // includeShared=false：共享域（非 mood）不得 present（导出端 def.shared 全部 omitted）
  if (scope.includeShared === false) {
    for (const [d, entry] of Object.entries(domains)) {
      if (entry && entry.status === 'present' && d !== 'mood') return `includeShared=false 但共享域 ${d} present`
    }
  }

  // files：path/身份唯一/kind/长度上限/摘要形状/contentType/附件块承诺形状
  const seenPaths = new Set()
  const seenOriginalFileIds = new Set()
  let totalFilesBytes = 0
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    if (!f || typeof f !== 'object') return `files[${i}] 非对象`
    if (typeof f.path !== 'string' || !f.path || f.path.startsWith('/') || f.path.includes('..') || f.path.includes('\\')) return `files[${i}].path 非法`
    if (seenPaths.has(f.path)) return `重复 path ${f.path}`
    seenPaths.add(f.path)
    if (f.originalFileId) {
      if (seenOriginalFileIds.has(f.originalFileId)) return `重复 originalFileId ${f.originalFileId}`
      seenOriginalFileIds.add(f.originalFileId)
    }
    if (!['domain-json', 'attachment'].includes(f.kind)) return `files[${i}].kind 非法`
    const cap = f.kind === 'attachment' ? MAX_ATTACHMENT_BYTES : MAX_DOMAIN_JSON_BYTES
    if (!Number.isSafeInteger(f.length) || f.length < 0 || f.length > cap) return `files[${i}].length=${f.length} 超界（上限 ${cap}）`
    if (!HEX64.test(String(f.sha256 || ''))) return `files[${i}].sha256 非 64hex`
    if (!['application/json', 'image/png', 'image/jpeg'].includes(f.contentType)) return `files[${i}].contentType 非法`
    if (f.kind === 'attachment') {
      if (!Array.isArray(f.chunkSha256) || f.chunkSha256.length === 0) {
        if (f.length > 0) return `files[${i}] 附件缺 chunkSha256 块承诺`
      } else {
        if (f.chunkSha256.some(x => !HEX64.test(String(x || '')))) return `files[${i}].chunkSha256 项非 64hex`
        const expectBlocks = Math.max(1, Math.ceil((f.length || 0) / VERIFY_BLOCK))
        if (f.chunkSha256.length !== expectBlocks) return `files[${i}] chunkSha256 块数 ${f.chunkSha256.length} ≠ ${expectBlocks}`
      }
    }
    totalFilesBytes += Number.isSafeInteger(f.length) ? f.length : 0
  }
  const derivedTotal = 24 + manifestLen + 8 * files.length + totalFilesBytes
  if (derivedTotal > MAX_PKG_BYTES) return `推导包总长 ${derivedTotal} > 64MiB`

  // reports 映射：reportId/墓碑/重复 (reportId,order)/fileIndex→附件+referencedBy 含
  // D25-r2 终版（协调方裁定 2026-09-20）：Stage1 find-first+有效空投影——**尾随有效空映射=恒 no-op**
  // （归一后 0 附件——跳过映射内部检查；**非"其余字段被忽略"**：该条目仍经下流 reports↔records.reports
  // 交叉校验（revision/deleted 与声明不符即拒）——业务取首映射，原始字节由 manifest chunks+digest 保护）；
  // **一切非空尾随重复=拒**（全等亦拒——同 order 为 Stage1-invalid、异 order 歧义、全等接受致 refs/rmappart 不对称）；
  // 首有效空+尾非空=数据丢失形拒。首映射恒权威（indexDeclarePage reportsMapById 首目胜）。
  const reports = manifest.reports
  if (!Array.isArray(reports)) return 'reports 非数组'
  const seenReportOrder = new Set()
  const firstMappingById = new Map()
  for (const r of reports) {
    if (!r || typeof r.reportId !== 'string' || !r.reportId) return 'reports 项 reportId 缺失'
    const atts = Array.isArray(r.attachments) ? r.attachments : []
    const first = firstMappingById.get(r.reportId)
    if (first !== undefined) {
      if (atts.length === 0) continue // 尾随有效空——恒 no-op（D25-r2 终版——不参与任何下方检查）
      return `重复 reportId ${r.reportId} 且尾随非空映射（首映射权威——D25-r2）`
    }
    firstMappingById.set(r.reportId, r)
    if (r.deleted && atts.length > 0) return `已删报告 ${r.reportId} 不得携带附件映射`
    for (const a of atts) {
      const key = `${r.reportId}:${a && a.order}`
      if (seenReportOrder.has(key)) return `重复 (reportId,order) ${key}`
      seenReportOrder.add(key)
      const f = a && files[a.fileIndex]
      if (!f || f.kind !== 'attachment') return `${key} fileIndex 无效或非附件段`
      if (!Array.isArray(f.referencedBy) || !f.referencedBy.includes(r.reportId)) return `附件段 ${a.fileIndex} 缺少 referencedBy ${r.reportId}`
    }
  }

  // records 声明：形状/(domain,index) 唯一/域内 id 唯一/recordCount 闭合/omitted·missing 闭包
  const records = manifest.records || {}
  let totalRecords = 0
  for (const [domain, list] of Object.entries(records)) {
    if (!SUPPORTED_DOMAINS.includes(domain)) return `未知域 ${domain} 在 records`
    if (!Array.isArray(list)) return `records.${domain} 非数组`
    totalRecords += list.length
    const dEntry = domains[domain]
    if (dEntry && dEntry.status === 'present' && dEntry.recordCount !== list.length) {
      return `域 ${domain} recordCount ${dEntry.recordCount} != records.length ${list.length}`
    }
    if (dEntry && dEntry.status !== 'present' && list.length > 0) return `域 ${domain} 为 ${dEntry.status} 但携带 records 声明`
    const seenIds = new Set()
    for (let position = 0; position < list.length; position++) {
      const decl = list[position]
      if (!decl || !Number.isInteger(decl.index) || decl.index < 0) return `records.${domain}[${position}] 声明 index 非法`
      // 声明 index 须与数组位置 0 连续全等（阶段一 validatePackage decl[k].index===k 同规则）
      if (decl.index !== position) return `域 ${domain}[${position}] 声明 index=${decl.index} 与数组位置不符（须 0 连续）`
      // id 仅要求非空字符串（阶段一 validateManifest 同则——不设长度上限；当前写 API 各域
      // 实际 ≤64（reports 显式 / chk_/bag_ uuid 型 / dateKey / 'pregnancy'），但 legacy 不可证有界，
      // 长度仅受 manifest ≤4MiB 隐式约束——不得据当前写 API 推定历史数据而误拒备份）
      if (typeof decl.id !== 'string' || decl.id.length === 0) return `records.${domain} 声明 id 非法`
      if (seenIds.has(decl.id)) return `域 ${domain} 重复记录 ID ${idPrev(decl.id)}`
      seenIds.add(decl.id)
      // P16 修复：Stage1 validatePackage 只用 Number()/Boolean() 比较——不做类型门
      // revision：Number() 有限即可（"0"/0/[]→Number 均 finite）
      // deleted：不做类型门（Stage1 仅用 Boolean() 比较——任何 JSON 值有确定 Boolean 语义）
      const declRevNum = Number(decl.revision)
      if (!Number.isFinite(declRevNum)) return `records.${domain}[${decl.index}].revision 非法（=${typeof decl.revision === 'string' ? JSON.stringify(decl.revision) : decl.revision}）`
      if (!HEX64.test(String(decl.hash || ''))) return `records.${domain}[${decl.index}].hash 非 64hex`
    }
  }
  if (totalRecords > MAX_RECORDS) return `记录总数 ${totalRecords} > ${MAX_RECORDS}`
  // present 域须有显式 records 数组（可为空——闭包双向）
  for (const [d, entry] of Object.entries(domains)) {
    if (entry && entry.status === 'present' && !Array.isArray(records[d])) return `present 域 ${d} 缺 records 声明数组`
  }
  // records.reports 声明 ↔ reports 映射 双向存在（导出端每报告恒有映射项——冻结映射是
  // uploadRecord 正文附件核对的凭据，缺项即无法冻结）
  if (Array.isArray(records.reports)) {
    const mappingIds = new Set(reports.filter(r => r && typeof r.reportId === 'string').map(r => r.reportId))
    for (const dcl of records.reports) {
      if (dcl && !mappingIds.has(String(dcl.id))) return `reports 声明 ${idPrev(dcl.id)} 无映射条目（无法冻结附件引用）`
    }
  }

  // reports↔records.reports 交叉校验 + 映射身份一致 + referencedBy 孤儿/双向闭包
  {
    const reportsRecords = records.reports || []
    const byId = new Map(reportsRecords.map(d => [String(d.id), d]))
    for (const rd of reports) {
      const decl = byId.get(String(rd.reportId))
      if (!decl) return `reports 映射 ${idPrev(rd.reportId)} 无对应 records 声明`
      if (Boolean(rd.deleted) !== Boolean(decl.deleted)) return `reports ${idPrev(rd.reportId)} deleted 与正文声明不一致`
      if (Number(rd.revision) !== Number(decl.revision)) return `reports ${idPrev(rd.reportId)} revision 与正文声明不一致`
    }
    const reportIds = new Set(reports.map(rd => rd.reportId))
    const expectedRefs = new Map() // fileIndex → Set<reportId>
    for (const rd of reports) {
      for (const a of (Array.isArray(rd.attachments) ? rd.attachments : [])) {
        const f = files[a.fileIndex]
        if (f && f.kind === 'attachment' && String(f.originalFileId || '') !== String(a.originalFileId || '')) {
          return `reports ${rd.reportId} 附件映射 originalFileId 与 files[${a.fileIndex}] 不一致`
        }
        if (!expectedRefs.has(a.fileIndex)) expectedRefs.set(a.fileIndex, new Set())
        expectedRefs.get(a.fileIndex).add(rd.reportId)
      }
    }
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      if (!f || f.kind !== 'attachment') continue
      const refs = Array.isArray(f.referencedBy) ? f.referencedBy : []
      if (f.length > 0 && refs.length === 0) return `files[${i}] 附件段 referencedBy 为空（孤儿段）`
      const expected = expectedRefs.get(i) || new Set()
      const actual = new Set(refs)
      for (const rid of actual) {
        if (!reportIds.has(rid)) return `files[${i}].referencedBy 含不存在报告 ${idPrev(rid)}`
        if (!expected.has(rid)) return `files[${i}].referencedBy 含报告 ${idPrev(rid)} 但其映射不含此 fileIndex（多余反向引用）`
      }
      for (const rid of expected) {
        if (!actual.has(rid)) return `files[${i}] 附件段缺少 referencedBy ${idPrev(rid)}（映射引用了此段但 referencedBy 未含）`
      }
    }
  }
  return null // 通过
}

// ── begin：不可变摘要承诺（严格 batchId + existing 优先判定 + CAS 槽位互斥创建）──
// 并发互斥：同成员全部 begin 在同一 slot-lock 文档上做事务读+写（文档级写写冲突由
// 平台事务串行化）——活跃计数（以各批次实际状态修剪滞后条目）与批次创建同一事务原子完成。
async function handleBegin(cloud, config, caller, event) {
  const db = cloud.database()
  const { batchId, formatVersion, packageDigest, manifestDigest, claimedKind, totals } = event
  if (!batchId || !/^rst_[0-9a-f]{32}$/.test(batchId)) return fail('invalid-params', 'batchId 须 rst_ 前缀+32 位小写 hex（128-bit CSPRNG）')
  if (!packageDigest || !HEX64.test(packageDigest)) return fail('invalid-params', 'packageDigest 须 64 hex')
  if (!manifestDigest || !HEX64.test(manifestDigest)) return fail('invalid-params', 'manifestDigest 须 64 hex')
  if (claimedKind && claimedKind !== 'full' && claimedKind !== 'diagnostic' && claimedKind !== 'unknown') {
    return fail('invalid-params', `claimedKind=${claimedKind} 非法`)
  }
  if (totals !== undefined && totals !== null) {
    if (typeof totals !== 'object' || Array.isArray(totals)) return fail('invalid-params', 'totals 须对象')
    if (totals.records !== undefined && (!Number.isInteger(totals.records) || totals.records < 0 || totals.records > MAX_RECORDS)) {
      return fail('invalid-params', 'totals.records 非法')
    }
    if (totals.files !== undefined && (!Number.isInteger(totals.files) || totals.files < 0 || totals.files > MAX_FILES)) {
      return fail('invalid-params', 'totals.files 非法')
    }
    if (totals.domainCounts !== undefined && totals.domainCounts !== null) {
      if (typeof totals.domainCounts !== 'object' || Array.isArray(totals.domainCounts)) return fail('invalid-params', 'totals.domainCounts 须对象')
      for (const [d, c] of Object.entries(totals.domainCounts)) {
        if (!SUPPORTED_DOMAINS.includes(d)) return fail('invalid-params', `totals.domainCounts 未知域 ${d}`)
        if (!Number.isInteger(c) || c < 0 || c > MAX_RECORDS) return fail('invalid-params', `totals.domainCounts.${d} 非法`)
      }
    }
  }
  // 幂等/冲突判定先于 formatVersion：同 batchId 任何承诺变化（含 formatVersion）→ batch-conflict
  const existing = await getDocMaybe(db, COLLECTIONS.batches, batchId)
  if (existing) {
    if (existing.ownerMemberId !== caller.memberId) return fail('not-batch-owner', 'batchId 已被其他成员使用')
    const totalsEq = stableStringify(existing.beginTotals === undefined ? null : existing.beginTotals) ===
      stableStringify(totals === undefined ? null : totals)
    if (existing.formatVersion !== formatVersion || existing.packageDigest !== packageDigest ||
        existing.manifestDigest !== manifestDigest || existing.claimedKind !== (claimedKind || 'unknown') || !totalsEq) {
      return fail('batch-conflict', '同 batchId 承诺不一致（含 formatVersion）')
    }
    return ok({ batchId, status: existing.status, replayed: true })
  }
  if (formatVersion !== 1) return fail('invalid-params', `formatVersion 须精确 1（收到 ${formatVersion}）`)
  // ── CAS 槽位互斥：活跃计数+创建同一事务（slot-lock 文档串行化同成员并发 begin）──
  // 重试仅限**提交阶段的事务冲突**（写写冲突/快照失效）；get/set 阶段的 SDK 权限/参数/
  // 持久错误立即上抛——不当冲突重试（重试既无效又掩盖真实错误）。
  let lastErr = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const tx = await db.startTransaction()
    let commitPhase = false
    try {
      const slotLockId = `slotlock:${caller.memberId}`
    const lockDoc = await tx.collection(COLLECTIONS.slotLocks).doc(slotLockId).get()
    const recordedIds = Array.isArray(lockDoc.data && lockDoc.data.activeBatchIds)
      ? lockDoc.data.activeBatchIds.filter(x => typeof x === 'string') : []
    // 以批次实际状态修剪（abandon/restore 后的滞后锁条目不计入余量）
    const stillActive = []
    for (const id of recordedIds) {
      if (id === batchId) continue
      const b = await tx.collection(COLLECTIONS.batches).doc(id).get()
      const st = b.data && b.data.status
      if (st && st !== 'restored' && st !== 'abandoned') stillActive.push({ batchId: id, status: st })
    }
    if (stillActive.length >= MAX_ACTIVE_BATCHES) {
      await tx.rollback()
      return fail('too-many-active-batches', `活跃批次 ${stillActive.length} >= ${MAX_ACTIVE_BATCHES}`, { activeBatches: stillActive })
    }
    // 事务内再查同 batchId（锁串行化后的并发同 ID 复核）
    const existingInTx = await tx.collection(COLLECTIONS.batches).doc(batchId).get()
    if (existingInTx.data) {
      await tx.rollback()
      const totalsEqTx = stableStringify(existingInTx.data.beginTotals === undefined ? null : existingInTx.data.beginTotals) ===
        stableStringify(totals === undefined ? null : totals)
      if (existingInTx.data.ownerMemberId === caller.memberId && existingInTx.data.formatVersion === formatVersion &&
          existingInTx.data.packageDigest === packageDigest && existingInTx.data.manifestDigest === manifestDigest &&
          existingInTx.data.claimedKind === (claimedKind || 'unknown') && totalsEqTx) {
        return ok({ batchId, status: existingInTx.data.status, replayed: true })
      }
      return fail('batch-conflict', '并发创建了同 batchId 批次')
    }
    const now = Date.now()
    await tx.collection(COLLECTIONS.slotLocks).doc(slotLockId).set({
      data: { ownerMemberId: caller.memberId, familyId: config.familyId, activeBatchIds: [...stillActive.map(x => x.batchId), batchId], updatedAt: now }
    })
    await tx.collection(COLLECTIONS.batches).doc(batchId).set({
      data: { batchId, formatVersion: 1, ownerMemberId: caller.memberId, familyId: config.familyId, status: 'declaring',
        packageDigest, manifestDigest, claimedKind: claimedKind || 'unknown', beginTotals: totals === undefined ? null : totals,
        contentGeneration: 0, aggregateRecordBytes: 0, provenGeneration: -1, proofComplete: false, createdAt: now, updatedAt: now }
    })
    commitPhase = true
    await tx.commit()
    } catch (e) {
      await tx.rollback()
      const msg = String((e && (e.errMsg || e.message)) || e)
      // 仅提交阶段的冲突/事务类错误可重试；其余（权限/参数/持久错误）立即上抛
      if (!commitPhase || !/conflict|transaction/i.test(msg)) throw e
      lastErr = e
      continue
    }
    return ok({ batchId, status: 'declaring', replayed: false })
  }
  throw lastErr
}

// ── declareChunk：manifest 分片上传 ──
async function handleDeclareChunk(cloud, config, caller, event) {
  const db = cloud.database()
  const { batchId, chunkIndex, chunkTotal, chunkB64, chunkSha256 } = event
  const { batch, err } = await getOwnedBatch(db, batchId, caller, config)
  if (err) return err
  if (batch.status !== 'declaring') return fail('invalid-state', `declareChunk 仅 declaring（当前 ${batch.status}）`)
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) return fail('invalid-params', 'chunkIndex 非法')
  if (!Number.isInteger(chunkTotal) || chunkTotal < 1 || chunkTotal > MAX_MANIFEST_CHUNKS) return fail('invalid-params', `chunkTotal 须 1-${MAX_MANIFEST_CHUNKS}`)
  // 越界拒绝在任何写入前（含锚定）——判包失败后补发越界索引不得产生孤儿 chunk（零写）
  if (chunkIndex >= chunkTotal) return fail('invalid-params', `chunkIndex ${chunkIndex} >= chunkTotal ${chunkTotal}（越界拒绝）`)
  if (!isValidB64(chunkB64)) return fail('invalid-params', 'chunkB64 非合法 base64')
  const rawBytes = b64decode(chunkB64)
  if (rawBytes.length === 0 || rawBytes.length > MAX_CHUNK_B64) return fail('invalid-params', `chunk ${rawBytes.length} 超界`)
  if (!HEX64.test(chunkSha256 || '')) return fail('invalid-params', 'chunkSha256 须 64hex')
  if (sha256Hex(rawBytes) !== chunkSha256) return fail('chunk-conflict', 'SHA 不匹配')

  // ── V20 末片分支（审查切片裁定：末片原子提交）──
  // 启用模式下末片（chunkIndex===chunkTotal-1）不走旧两事务路径：先在事务外完成重组+验真+V20 派生
  // （prev chunks 取自已持久不可变分片+本次请求字节），后在**单一 CAS 事务**内复核状态/锚定/前序/已存
  // 并同时写末片 chunk 与 preparing 冻结承诺。提交失败→回滚→**末片与冻结均不出现**（零半写）；
  // 客户端同片重试从 declaring 正常重做。零块包（totalEntries=0）直 declared（empty-root——不经
  // preparing/finalizeDeclare）。默认关不进此分支（旧路径逐字节不变）。
  if (v20Enabled() && chunkIndex === chunkTotal - 1) {
    return await declareChunkFreezeV20(db, caller, config, batch, { batchId, chunkIndex, chunkTotal, chunkB64, chunkSha256, rawBytes })
  }

  // ── 单一 CAS 事务：状态复核 + manifestChunkTotal 锚定 + 前序存在性 + chunk 写 原子化 ──
  // （abandon 抢占后迟到调用零锚定残留零 chunk 落盘；无"锚定成功但 chunk 未写"的中间窗口）
  const chunkId = `${batchId}:${chunkIndex}`
  const tx = await db.startTransaction()
  try {
    const batchInTx = await tx.collection(COLLECTIONS.batches).doc(batchId).get()
    const curB = batchInTx.data
    if (!curB || curB.status !== 'declaring') {
      await tx.rollback()
      return fail('invalid-state', `declareChunk 仅 declaring（当前 ${curB ? curB.status : 'gone'}）`)
    }
    let needAnchor = false
    if (chunkIndex === 0) {
      if (curB.manifestChunkTotal !== undefined && curB.manifestChunkTotal !== chunkTotal) {
        await tx.rollback()
        return fail('chunk-total-mismatch', `已锚定 ${curB.manifestChunkTotal}`)
      }
      if (curB.manifestChunkTotal === undefined) needAnchor = true
    } else {
      if (curB.manifestChunkTotal !== chunkTotal) {
        await tx.rollback()
        return fail('chunk-total-mismatch', `已锚定 ${curB.manifestChunkTotal || '未设'}`)
      }
      const prevInTx = await tx.collection(COLLECTIONS.declareChunks).doc(`${batchId}:${chunkIndex - 1}`).get()
      if (!prevInTx.data) {
        await tx.rollback()
        return fail('declare-incomplete', `前序 chunk ${chunkIndex - 1} 缺失（须按序上传）`)
      }
    }
    const existingInTx = await tx.collection(COLLECTIONS.declareChunks).doc(chunkId).get()
    if (existingInTx.data) {
      await tx.rollback()
      if (existingInTx.data.chunkSha256 === chunkSha256) return ok({ chunkIndex, replayed: true })
      return fail('chunk-conflict', `chunk ${chunkIndex} 已有不同内容`)
    }
    await tx.collection(COLLECTIONS.declareChunks).doc(chunkId).set({
      data: { batchId, chunkIndex, chunkSha256, rawB64: chunkB64, byteLength: rawBytes.length }
    })
    if (needAnchor) {
      await tx.collection(COLLECTIONS.batches).doc(batchId).set({
        data: { ...stripDoc(curB), manifestChunkTotal: chunkTotal, updatedAt: Date.now() }
      })
    }
    await tx.commit()
  } catch (e) { await tx.rollback(); throw e }

  // 全齐检查（keyed get——不用 where）
  const expectedIds = Array.from({ length: chunkTotal }, (_, i) => `${batchId}:${i}`)
  const gotResults = await keyedGetBatch(db, COLLECTIONS.declareChunks, expectedIds)
  const received = gotResults.filter(r => r.doc !== null).length
  if (received < chunkTotal) return ok({ chunkIndex, received, total: chunkTotal, complete: false })

  // 重组+长度 fail-stop（阶段一 L295-301 同型：超限立即拒绝不进入解析——零推进）
  let assembled = Buffer.alloc(0)
  for (const r of gotResults) assembled = Buffer.concat([assembled, b64decode(r.doc.rawB64)])
  const vErr = validateAssembledManifest(batch, assembled, caller, config)
  if (vErr.err) return vErr.err
  const { manifest, totals, frozenDomainBytes, declaredRootSha } = vErr

  // 推进 indexing（CAS）
  const tx2 = await db.startTransaction()
  try {
    const doc = await tx2.collection(COLLECTIONS.batches).doc(batchId).get()
    const cur = doc.data
    if (!cur || cur.status !== 'declaring') { await tx2.rollback(); return ok({ complete: true, status: cur ? cur.status : 'gone' }) }
    await tx2.collection(COLLECTIONS.batches).doc(batchId).set({
      data: { ...stripDoc(cur), status: 'indexing', manifestParsed: true, totals, frozenDomainBytes, declaredRecords: totals.records, declaredFiles: totals.files,
        declaredRootSha, updatedAt: Date.now() }
    })
    await tx2.commit()
  } catch (e) { await tx2.rollback(); throw e }
  return ok({ complete: true, status: 'indexing', totals: { records: totals.records, files: totals.files } })
}

// ── 重组后 manifest 全量验真+派生字段（legacy 末片与 V20 末片共用——纯计算无事务）──
// 返回 {err: fail(...)} 或 {manifest, totals, frozenDomainBytes, declaredRootSha}
function validateAssembledManifest(batch, assembled, caller, config) {
  if (assembled.length > MAX_MANIFEST_BYTES) {
    return { err: fail('package-rejected', `manifest 长度 ${assembled.length} > 4MiB（128×40KiB 运输上限可超——重组后截断）`) }
  }
  if (sha256Hex(assembled) !== batch.manifestDigest) {
    return { err: fail('package-rejected', 'manifest 摘要不匹配') }
  }
  let manifestText
  try { manifestText = strictUtf8Decode(assembled) } catch (e) { return { err: fail('package-rejected', `manifest ${e.message}`) } }
  let manifest
  try { manifest = JSON.parse(manifestText) } catch (e) { return { err: fail('package-rejected', 'manifest JSON 解析失败') } }

  // ── manifest v1 schema 严格校验（manifestLen 参数化——不向解析对象注入字段）──
  const schemaErr = validateManifestSchema(manifest, assembled.length, caller, config)
  if (schemaErr) return { err: fail('package-rejected', `manifest schema 不合格: ${schemaErr}`) }

  // manifest 原始字节必须恰为规范重序列化字节（阶段一 manifest-not-canonical 同规则：
  // 同内容非规范编码/键序/空白/转义差异一律拒绝）
  let canonicalBytes
  try { canonicalBytes = Buffer.from(stableStringify(manifest), 'utf8') } catch (e) {
    return { err: fail('package-rejected', `manifest 规范化失败: ${e.message}`) }
  }
  if (!canonicalBytes.equals(assembled)) return { err: fail('package-rejected', 'manifest 原始字节非规范编码（键序/空白/转义非法）') }

  // 计算 totals
  const totals = { records: 0, files: 0, domains: {} }
  for (const [domain, list] of Object.entries(manifest.records || {})) {
    totals.records += (list || []).length
    totals.domains[domain] = (list || []).length
  }
  totals.files = (manifest.files || []).length // Stage1 实际：含 domain-json（非仅 attachment）

  // 冻结域字节上限（L25 修复）：Σ present 域的 domain-json file.length（合法包记录正文上界）
  let frozenDomainBytes = 0
  for (const [domain, entry] of Object.entries(manifest.domains || {})) {
    if (entry && entry.status === 'present' && Number.isInteger(entry.fileIndex)) {
      const f = (manifest.files || [])[entry.fileIndex]
      if (f && f.kind === 'domain-json' && Number.isSafeInteger(f.length) && f.length >= 0) {
        frozenDomainBytes += f.length
      }
    }
  }

  // begin 承诺核对（totals 如有须匹配——含 domainCounts 逐域对齐）
  if (batch.beginTotals && batch.beginTotals.records !== undefined && batch.beginTotals.records !== totals.records) {
    return { err: fail('package-rejected', `totals.records ${totals.records} != begin 承诺 ${batch.beginTotals.records}`) }
  }
  if (batch.beginTotals && batch.beginTotals.files !== undefined && batch.beginTotals.files !== totals.files) {
    return { err: fail('package-rejected', `totals.files ${totals.files} != begin 承诺 ${batch.beginTotals.files}`) }
  }
  if (batch.beginTotals && batch.beginTotals.domainCounts && typeof batch.beginTotals.domainCounts === 'object') {
    for (const [d, c] of Object.entries(batch.beginTotals.domainCounts)) {
      const actual = totals.domains[d] || 0
      if (actual !== c) return { err: fail('package-rejected', `totals.domainCounts.${d} ${actual} != begin 承诺 ${c}`) }
    }
  }

  // 逐声明 key 链式 SHA 根（与 indexDeclarePage 的滚动哈希同算法）
  const keys = (manifest.records ? Object.entries(manifest.records).flatMap(([d, l]) => (l || []).map(r => `${d}:${r.index}:${r.hash}`)) : [])
    .concat((manifest.files || []).map((f, fi) => f && f.kind === 'attachment' ? `file:${fi}:${f.sha256}` : null).filter(Boolean))
  let root = ''
  for (const key of keys) root = sha256Hex(Buffer.from(root + key))
  return { manifest, totals, frozenDomainBytes, declaredRootSha: root }
}

// ── V20 末片冻结（declareChunk 启用模式末片分支——审查切片裁定：末片原子提交）──
async function declareChunkFreezeV20(db, caller, config, batch, { batchId, chunkIndex, chunkTotal, chunkB64, chunkSha256, rawBytes }) {
  // 1. 事务外预验证：prev chunks 取自已持久不可变分片 + 本次请求字节 → 重组全量验真
  const prevIds = chunkIndex > 0 ? Array.from({ length: chunkIndex }, (_, i) => `${batchId}:${i}`) : []
  const gotPrev = await keyedGetBatch(db, COLLECTIONS.declareChunks, prevIds)
  if (gotPrev.some(r => r.doc === null)) return fail('declare-incomplete', '前序 chunk 缺失（须按序上传）')
  let assembled = Buffer.alloc(0)
  for (const r of gotPrev) assembled = Buffer.concat([assembled, b64decode(r.doc.rawB64)])
  assembled = Buffer.concat([assembled, rawBytes])
  const vErr = validateAssembledManifest(batch, assembled, caller, config)
  if (vErr.err) return vErr.err
  const { manifest, totals, frozenDomainBytes, declaredRootSha } = vErr

  // 2. V20 派生（纯函数模块——staged 块仅在内存派生，不持久 staged 数组）
  let stream, tree
  try {
    stream = v20.deriveV20Stream(manifest)
    tree = v20.buildTree(stream.blocks)
  } catch (e) {
    return fail('package-rejected', `V20 派生失败（fail-stop）: ${String(e && e.message).slice(0, 120)}`)
  }
  const planRoot = tree.root.toString('hex')
  const isZeroBlock = stream.count === 0

  // 3. 单一 CAS 事务：状态/锚定/前序/已存复核 + 末片 chunk 写 + preparing 冻结（原子）
  //    提交失败 → 回滚 → 末片与冻结均不出现（零半写）；同片重试从 declaring 正常重做。
  const chunkId = `${batchId}:${chunkIndex}`
  const tx = await db.startTransaction()
  try {
    const batchInTx = await tx.collection(COLLECTIONS.batches).doc(batchId).get()
    const curB = batchInTx.data
    if (!curB || curB.status !== 'declaring') {
      await tx.rollback()
      return fail('invalid-state', `declareChunk 仅 declaring（当前 ${curB ? curB.status : 'gone'}）`)
    }
    let needAnchor = false
    if (chunkIndex === 0) {
      if (curB.manifestChunkTotal !== undefined && curB.manifestChunkTotal !== chunkTotal) {
        await tx.rollback()
        return fail('chunk-total-mismatch', `已锚定 ${curB.manifestChunkTotal}`)
      }
      if (curB.manifestChunkTotal === undefined) needAnchor = true
    } else {
      if (curB.manifestChunkTotal !== chunkTotal) {
        await tx.rollback()
        return fail('chunk-total-mismatch', `已锚定 ${curB.manifestChunkTotal || '未设'}`)
      }
      const prevInTx = await tx.collection(COLLECTIONS.declareChunks).doc(`${batchId}:${chunkIndex - 1}`).get()
      if (!prevInTx.data) {
        await tx.rollback()
        return fail('declare-incomplete', `前序 chunk ${chunkIndex - 1} 缺失（须按序上传）`)
      }
    }
    const existingInTx = await tx.collection(COLLECTIONS.declareChunks).doc(chunkId).get()
    let skipChunkWrite = false
    if (existingInTx.data) {
      if (existingInTx.data.chunkSha256 !== chunkSha256) {
        await tx.rollback()
        return fail('chunk-conflict', `chunk ${chunkIndex} 已有不同内容`)
      }
      // 已存 chunk 不信 chunkSha256 字段（协调方裁定 2026-09-20——C3a/C3b）：
      // 复验存储 rawB64 解码字节（规范 base64 重编码等+与请求字节逐字节等+重算 SHA=请求 SHA）
      // 及 byteLength 字段与实际解码长一致——任一不符 → 损坏/不一致族拒（零写+不冻结）。
      const storedRaw = b64decode(existingInTx.data.rawB64)
      const storedConsistent =
        typeof existingInTx.data.rawB64 === 'string' &&
        storedRaw.toString('base64') === existingInTx.data.rawB64 &&
        storedRaw.toString('base64') === chunkB64 &&
        storedRaw.length === rawBytes.length &&
        sha256Hex(storedRaw) === chunkSha256 &&
        existingInTx.data.byteLength === storedRaw.length
      if (!storedConsistent) {
        await tx.rollback()
        return fail('chunk-conflict', `存储 chunk ${chunkIndex} 损坏/不一致（rawB64/byteLength/SHA 复验失败——零写不冻结）`)
      }
      skipChunkWrite = true // 存储字节全验通过——跳过重写，执行冻结
    }
    if (!skipChunkWrite) {
      await tx.collection(COLLECTIONS.declareChunks).doc(chunkId).set({
        data: { batchId, chunkIndex, chunkSha256, rawB64: chunkB64, byteLength: rawBytes.length }
      })
    }
    // 冻结承诺（零块包：直 declared——planRoot=empty-root，不经 preparing/finalizeDeclare）
    const freezeFields = {
      status: isZeroBlock ? 'declared' : 'preparing',
      v20: true,
      planRoot, totalBlocks: stream.totalBlocks, totalEntries: stream.count, prepCursor: 0,
      manifestParsed: true, totals, frozenDomainBytes,
      declaredRecords: totals.records, declaredFiles: totals.files, declaredRootSha,
      ...(needAnchor ? { manifestChunkTotal: chunkTotal } : {}),
      updatedAt: Date.now(),
    }
    await tx.collection(COLLECTIONS.batches).doc(batchId).set({
      data: { ...stripDoc(curB), ...freezeFields }
    })
    await tx.commit()
  } catch (e) { await tx.rollback(); throw e }
  return ok({ chunkIndex, complete: true, status: isZeroBlock ? 'declared' : 'preparing', totals: { records: totals.records, files: totals.files } })
}

// ── finalizeDeclare（V20 专用——D29 wire 形 blockB64；仅显式启用后可达）──
async function handleFinalizeDeclare(cloud, config, caller, event) {
  const db = cloud.database()
  const { batchId, blockIndex, blockB64, proof } = event
  if (event.blockBytes !== undefined) return fail('invalid-params', '旧 wire 形 blockBytes 禁用——须 blockB64（D29）')
  const { batch, err } = await getOwnedBatch(db, batchId, caller, config)
  if (err) return err
  if (!batch.v20 || typeof batch.planRoot !== 'string') return fail('invalid-state', '非 V20 批次（无冻结根——finalizeDeclare 仅 V20 preparing 批次）')
  if (batch.status !== 'preparing' && batch.status !== 'indexing') {
    return fail('invalid-state', `finalizeDeclare 仅 preparing（当前 ${batch.status}）`)
  }
  if (!Number.isInteger(batch.totalBlocks) || batch.totalBlocks < 1 || batch.totalBlocks > 2048) {
    return fail('invalid-state', `批次 totalBlocks 非法（=${batch.totalBlocks}）`)
  }
  if (!Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex >= batch.totalBlocks) {
    return fail('invalid-params', `blockIndex ${blockIndex} 越界 [0,${batch.totalBlocks})`)
  }

  // ── D29 解码链：严格规范 base64 → 1..10,240B → 严格 UTF-8 → JSON 数组 → canonical 逐字节等 → 条目/单条帽 ──
  if (typeof blockB64 !== 'string' || blockB64.length === 0) return fail('invalid-params', 'blockB64 须非空字符串')
  const blockBytes = b64decode(blockB64)
  if (blockBytes.toString('base64') !== blockB64) return fail('invalid-params', 'blockB64 非规范 base64（重编码不等）')
  if (blockBytes.length < 1 || blockBytes.length > v20.BLOCK_NET) {
    return fail('invalid-params', `解码块 ${blockBytes.length}B 超界（须 1..${v20.BLOCK_NET}B——零块包不经 finalizeDeclare）`)
  }
  let entriesText
  try { entriesText = strictUtf8Decode(blockBytes) } catch (e) { return fail('invalid-params', `块严格 UTF-8 解码失败: ${e.message}`) }
  let entries
  try { entries = JSON.parse(entriesText) } catch (e) { return fail('invalid-params', '块 JSON 解析失败') }
  if (!Array.isArray(entries)) return fail('invalid-params', '块解码体须 JSON 数组（D21——对象形拒）')
  if (entries.length > v20.ENTRIES_PER_BLOCK) return fail('invalid-params', `块条目 ${entries.length} > ${v20.ENTRIES_PER_BLOCK}/块`)
  for (let i = 0; i < entries.length; i++) {
    let eB
    try { eB = v20.canonicalJsonBytes(entries[i]) } catch (e) { return fail('invalid-params', `entries[${i}] canonical 序列化失败: ${e.message}`) }
    if (eB.length > v20.ENTRY_MAX) return fail('invalid-params', `entries[${i}] canonical ${eB.length}B > ENTRY_MAX ${v20.ENTRY_MAX}B`)
  }
  let entriesCanonical
  try { entriesCanonical = v20.canonicalJsonBytes(entries) } catch (e) { return fail('invalid-params', `块 canonical 序列化失败: ${e.message}`) }
  if (!entriesCanonical.equals(blockBytes)) return fail('invalid-params', '块字节非 canonical JSON（重序列化不等——键序/空白/转义非法）')

  // ── 三分支：超前拒（零写）/ 已写重放（只读逐字节比较）/ 写路径（CAS）──
  const prepCursor = Number.isInteger(batch.prepCursor) ? batch.prepCursor : 0
  if (blockIndex > prepCursor) {
    return fail('invalid-params', `blockIndex ${blockIndex} 超前（游标 prepCursor=${prepCursor}——须按序写块）`)
  }
  const blockDocId = `${batchId}:blk:${blockIndex}`
  // 持久块完整文档验证（协调方裁定 2026-09-20：一切"已存块返 replay/推进游标"的路径必须先经
  // v20.verifiedBlockRead 对冻结根全验（_id/entries 数组/≤48/≤2KiB 条/≤10KiB 块/byteLength/entryCount/
  // sha256=重算位置绑定叶/proof 折叠=planRoot）——损坏 sha256/byteLength/proof 不得被 entries 等价遮蔽）。
  // 返回 {payloadBytes} 或 throw；调用方再作请求字节逐字节比较。
  const verifyStoredBlock = (storedDoc, batchSnap, label) => {
    return v20.verifiedBlockRead({ blockDoc: storedDoc, batch: { batchId, planRoot: batchSnap.planRoot, totalBlocks: batchSnap.totalBlocks }, blockIndex })
  }
  if (blockIndex < prepCursor) {
    // 重放（丢响应重试形）：只读——先完整文档验证（fail-closed），再请求字节逐字节比较
    const stored = await getDocMaybe(db, COLLECTIONS.blocks, blockDocId)
    if (!stored) return fail('invalid-state', `块 ${blockIndex} 游标已过但文档缺失（磁盘态异常）`)
    let storedCanonical
    try { storedCanonical = verifyStoredBlock(stored, batch, '重放') } catch (e) {
      return fail('invalid-state', `持久块 ${blockIndex} 文档验证失败（fail-closed——损坏态不得伪重放）: ${String(e && e.message).slice(0, 120)}`)
    }
    if (!storedCanonical.equals(blockBytes)) return fail('block-conflict', `块 ${blockIndex} 已有不同字节（重放须逐字节相等）`)
    return ok({ blockIndex, replayed: true })
  }

  // ── 写路径（blockIndex === prepCursor）──
  // 位置绑定叶 + 证明验证（fail→冲突族——含根不匹配）
  const leafHex = v20.leafHash(batch.totalBlocks, blockIndex, blockBytes).toString('hex')
  try {
    v20.verifyProof({ totalBlocks: batch.totalBlocks, blockIndex, blockBytes, proof, planRoot: Buffer.from(batch.planRoot, 'hex') })
  } catch (e) {
    return fail('block-conflict', `证明/根验证失败: ${String(e && e.message).slice(0, 120)}`)
  }
  // 前序块存在（顺序写不变量）
  if (blockIndex > 0) {
    const prev = await getDocMaybe(db, COLLECTIONS.blocks, `${batchId}:blk:${blockIndex - 1}`)
    if (!prev) return fail('invalid-params', `前序块 ${blockIndex - 1} 缺失（须按序写块）`)
  }
  // 本地 11KiB 完整块文档预算（协议 §6.5-bis BLOCK_DOC_MAX 本地门——度量对象=**恰为持久字段集+_id**
  // （D21 精确形状：{_id, sha256, byteLength, entryCount, entries, proof}——无 blockIndex/batchId/createdAt，
  // 协调方复核修正：块文档不存 blockIndex（在 _id 内）；无时间戳字段——度量与写入同构，无低估面）。
  const blockDocData = { sha256: leafHex, byteLength: blockBytes.length, entryCount: entries.length, entries, proof }
  let fullDocSize
  try { fullDocSize = v20.canonicalJsonBytes({ _id: blockDocId, ...blockDocData }).length } catch (e) { return fail('invalid-params', `块文档度量失败: ${e.message}`) }
  if (fullDocSize > 11 * 1024) {
    return fail('record-too-large', `块完整文档 ${fullDocSize}B > 11KiB 本地预算（BLOCK_DOC_MAX——含 _id/entries/proof/全部字段）`)
  }

  // CAS 事务：状态+游标复核 → 并发已存检查 → 块文档写 + 游标推进 + 末块同事务转 indexing
  const tx = await db.startTransaction()
  try {
    const doc = await tx.collection(COLLECTIONS.batches).doc(batchId).get()
    const cur = doc.data
    if (!cur || cur.status !== 'preparing') {
      await tx.rollback()
      return fail('invalid-state', `finalizeDeclare 仅 preparing（当前 ${cur ? cur.status : 'gone'}）`)
    }
    const curCursor = Number.isInteger(cur.prepCursor) ? cur.prepCursor : 0
    if (curCursor !== blockIndex) {
      await tx.rollback()
      // 并发 CAS 败者复检（协调方复核修正）：不直接报 cursor-stale——重读已持久块，
      // 完整文档验证（fail-closed）+同字节=并发同请求（胜者已写本块）→ 幂等 ok；异字节/损坏 → 拒。
      const winner = await getDocMaybe(db, COLLECTIONS.blocks, blockDocId)
      if (winner) {
        let winnerCanonical
        try { winnerCanonical = verifyStoredBlock(winner, cur, '败者复检') } catch (e) { winnerCanonical = null }
        if (winnerCanonical && winnerCanonical.equals(blockBytes)) return ok({ blockIndex, replayed: true })
        return fail('block-conflict', `块 ${blockIndex} 已有不同字节或文档损坏（并发写冲突/损坏态——游标 ${curCursor}）`)
      }
      return fail('cursor-stale', `游标 ${curCursor} != 请求 ${blockIndex}（并发已推进且块缺失——重读批次状态）`)
    }
    const existingInTx = await tx.collection(COLLECTIONS.blocks).doc(blockDocId).get()
    if (existingInTx.data) {
      // 游标未过而块已存在=异常半写态（原子设计下不应出现——防御）：
      // 须先经完整文档验证（协调方裁定：损坏 sha256/byteLength/proof 不得被 entries 等价遮蔽——
      // 验证失败 → fail-closed 拒零写）；全验通过+同字节 → 同事务推进游标（+末块转 indexing）；
      // 异字节 → block-conflict。
      let existingCanonical
      try { existingCanonical = verifyStoredBlock(existingInTx.data, cur, '半写态') } catch (e) {
        await tx.rollback()
        return fail('invalid-state', `持久块 ${blockIndex} 文档验证失败（fail-closed——损坏态不得修复成功）: ${String(e && e.message).slice(0, 120)}`)
      }
      if (!existingCanonical || !existingCanonical.equals(blockBytes)) {
        await tx.rollback()
        return fail('block-conflict', `块 ${blockIndex} 已有不同字节（半写态冲突）`)
      }
      const repairUpdates = { prepCursor: blockIndex + 1, updatedAt: Date.now() }
      if (blockIndex === cur.totalBlocks - 1) repairUpdates.status = 'indexing'
      await tx.collection(COLLECTIONS.batches).doc(batchId).set({
        data: { ...stripDoc(cur), ...repairUpdates }
      })
      await tx.commit()
      return ok({ blockIndex, replayed: true, repaired: true, ...(blockIndex === cur.totalBlocks - 1 ? { status: 'indexing' } : {}) })
    }
    await tx.collection(COLLECTIONS.blocks).doc(blockDocId).set({ data: blockDocData })
    const updates = { prepCursor: blockIndex + 1, updatedAt: Date.now() }
    if (blockIndex === cur.totalBlocks - 1) updates.status = 'indexing' // 末块同事务转 indexing（根封闭原子暴露）
    await tx.collection(COLLECTIONS.batches).doc(batchId).set({
      data: { ...stripDoc(cur), ...updates }
    })
    await tx.commit()
  } catch (e) { await tx.rollback(); throw e }
  return ok({ blockIndex, ...(blockIndex === batch.totalBlocks - 1 ? { status: 'indexing' } : {}) })
}

// ══ V20 块消费（§6.4 消费四款——协调方指派切片 2026-09-20）══
// ① 单块读取 + verifiedBlockRead 同径核验（消费期即检存储篡改——损坏 sha256/entries/proof 不得被
//    游标推进遮蔽）；② 单事务（写数 ≤50——按构造保证：decl+ptr 写数 ≤ 本块条目数 ≤48，idfrag 补解
//    覆写数 ≤ 本块 idfrag 条目数，合计 ≤ 条目数+1）写分层声明：record→全量声明（既有
//    `${bid}:decl:${domain}:${index}` 键空间——身份 id/hash/revision/deleted + blockIndex=core 所在块；
//    附件映射不复制——§6.5 薄指针重建口径），六类非记录（file/refs/rmappart/filefrag/cshafrag/idfrag）
//    →薄指针（`${bid}:ptr:` 键空间，恰 {_id,type,blockIndex} 三字段）+ consumedCursor←i+1；
// ③ 末块 consumedCount===totalEntries → declared（不等 fail-stop 不推进）；④ <cursor 同块纯比对
//    幂等零写（先 verifiedBlockRead 全验再报 replayed——C2 语义：不验不报）/ >cursor 拒零写。
// I9：本路径零 manifest chunk 读（声明全部自已验证块载荷派生——不重组 manifest）。
// 巨 id（idRef/idfrag）：流序 core 先于其碎片——同块碎片即时重组全长 id；跨块碎片以父声明
// idParts 累积（覆写补全），块序消费保证补全先于末块 declared。

const V20_PTR_TYPES = ['file', 'refs', 'rmappart', 'filefrag', 'cshafrag', 'idfrag']

// 薄指针定位器（§6.5——键内仅型别+定位数字，不含 id/path 等字段字节）
function v20PtrKey(batchId, e) {
  switch (e.type) {
    case 'file': return `${batchId}:ptr:file:${e.fileIndex}`
    case 'refs': return `${batchId}:ptr:refs:${e.fileIndex}:${e.part}`
    case 'rmappart': return `${batchId}:ptr:rmappart:${e.recIndex}:${e.part}`
    case 'filefrag': return `${batchId}:ptr:filefrag:${e.fileIndex}:${e.field}:${e.seq}`
    case 'cshafrag': return `${batchId}:ptr:cshafrag:${e.fileIndex}:${e.seq}`
    case 'idfrag': return `${batchId}:ptr:idfrag:${e.domain}:${e.index}:${e.seq}`
  }
  return null
}

// 已验证块读取（verifiedBlockRead 包装——doc 缺失/任一字段损坏即拒，含拒因传播）
async function v20ReadVerified(db, batchId, batch, blockIndex) {
  const stored = await getDocMaybe(db, COLLECTIONS.blocks, `${batchId}:blk:${blockIndex}`)
  if (!stored) return { err: fail('invalid-state', `块 ${blockIndex} 文档缺失（verifiedBlockRead 无法核验——不信任指针定位）`) }
  try {
    v20.verifiedBlockRead({ blockDoc: stored, batch: { batchId, planRoot: batch.planRoot, totalBlocks: batch.totalBlocks }, blockIndex })
    return { entries: stored.entries }
  } catch (e) {
    return { err: fail('invalid-state', `块 ${blockIndex} verifiedBlockRead 核验失败（sha256 位置绑定叶哈希/proof 折叠 planRoot/byteLength/entryCount 全验——存储损坏即拒）: ${String((e && e.message) || e)}`) }
  }
}

// idfrag 重组（§6.1：载荷=canonicalJsonBytes(id) 切片——重组字节须过 idRef.len/sha256 承诺）
function v20ResolveId(parts, idRef) {
  const bytes = Buffer.concat(parts.map(p => Buffer.from(String(p && p.data), 'base64')))
  if (bytes.length !== idRef.len || sha256Hex(bytes) !== idRef.sha256) {
    throw new Error(`idfrag 重组不符 idRef 承诺（len ${bytes.length}/${idRef.len}，sha ${sha256Hex(bytes).slice(0, 12)}/${String(idRef.sha256).slice(0, 12)}）`)
  }
  let id
  try { id = JSON.parse(strictUtf8Decode(bytes)) } catch (e) { throw new Error('idfrag 重组字节非严格 JSON') }
  if (typeof id !== 'string') throw new Error('idfrag 重组非字符串 id')
  return id
}

// 声明文档净形（去 SDK 元数据与 id 解析瞬态字段——覆写补全时用）
function v20DeclClean(doc) {
  const { _id, __v, idRef, idParts, ...rest } = doc || {}
  return rest
}

async function consumeBlockV20(db, batchId, batch, event) {
  const { blockIndex } = event
  if (batch.status !== 'indexing') {
    // §6.4-④ R1（协调方指派切片 2026-09-20）：declared 态同块幂等重试——blockIndex <
    // consumedCursor（含末块）允许重放。重放分支同等先 v20ReadVerified 全验（C2 语义：
    // 不验不报 replayed——存储 proof/sha256 损坏在此 fail-closed 拒，拒因=验证族非状态门），
    // 核验通过即零写返回（declared 态无新块可消费——状态/游标均不动）。
    if (batch.status !== 'declared') return fail('invalid-state', `V20 消费仅 indexing（当前 ${batch.status}）`)
    if (!Number.isInteger(batch.totalBlocks) || batch.totalBlocks < 1) return fail('invalid-state', `批次 totalBlocks 非法（=${batch.totalBlocks}）`)
    if (typeof batch.planRoot !== 'string' || !Number.isInteger(batch.totalEntries)) {
      return fail('invalid-state', 'V20 消费字段缺失（planRoot/totalEntries）')
    }
    if (!Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex >= batch.totalBlocks) {
      return fail('invalid-params', `blockIndex ${blockIndex} 越界 [0,${batch.totalBlocks})`)
    }
    const declaredCursor = Number.isInteger(batch.consumedCursor) ? batch.consumedCursor : batch.totalBlocks
    if (blockIndex >= declaredCursor) {
      return fail('invalid-params', `declared 态 blockIndex ${blockIndex} 不在已消费区间 [0,${declaredCursor})（无新块可消费——重放仅限已消费块）`)
    }
    const dvread = await v20ReadVerified(db, batchId, batch, blockIndex)
    if (dvread.err) return dvread.err
    return ok({ blockIndex, replayed: true, status: batch.status, consumedCursor: batch.consumedCursor || batch.totalBlocks })
  }
  if (!Number.isInteger(batch.totalBlocks) || batch.totalBlocks < 1) return fail('invalid-state', `批次 totalBlocks 非法（=${batch.totalBlocks}）`)
  if (typeof batch.planRoot !== 'string' || !Number.isInteger(batch.totalEntries)) {
    return fail('invalid-state', 'V20 消费字段缺失（planRoot/totalEntries）')
  }
  if (!Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex >= batch.totalBlocks) {
    return fail('invalid-params', `blockIndex ${blockIndex} 越界 [0,${batch.totalBlocks})`)
  }
  const consumedCursor = Number.isInteger(batch.consumedCursor) ? batch.consumedCursor : 0
  if (blockIndex > consumedCursor) {
    return fail('invalid-params', `blockIndex ${blockIndex} 超前（consumedCursor=${consumedCursor}——须按序消费，不得跳块）`)
  }
  // ①④：先 verifiedBlockRead 全验（重放路径同验——C2 语义：不验不报 replayed）
  const vread = await v20ReadVerified(db, batchId, batch, blockIndex)
  if (vread.err) return vread.err
  if (blockIndex < consumedCursor) {
    return ok({ blockIndex, replayed: true, status: batch.status, consumedCursor })
  }
  const entries = vread.entries

  // 本块 idfrag 分组（同块直解/跨块补解共用）
  const fragsHere = new Map()
  for (const e of entries) {
    if (e && e.type === 'idfrag') {
      const k = `${e.domain}:${e.index}`
      if (!fragsHere.has(k)) fragsHere.set(k, [])
      fragsHere.get(k).push({ seq: e.seq, data: e.data })
    }
  }

  // ② 分层声明构建
  const declWrites = new Map() // 新写：record 全量声明 / 薄指针
  const declUpdates = new Map() // 覆写：跨块 idfrag 补全先前块的父声明
  for (const e of entries) {
    if (!e || typeof e.type !== 'string') return fail('invalid-state', '块条目形状非法（缺 type）')
    if (e.type === 'record') {
      if (typeof e.domain !== 'string' || !Number.isInteger(e.index) || typeof e.hash !== 'string' || !HEX64.test(e.hash)) {
        return fail('invalid-state', 'record 条目 domain/index/hash 非法')
      }
      const declData = {
        batchId, type: 'record', domain: e.domain, index: e.index,
        revision: e.revision, deleted: e.deleted, hash: e.hash, blockIndex, indexedAt: Date.now(),
      }
      if (e.id !== undefined) {
        declData.id = e.id
      } else {
        const ref = e.idRef
        if (!ref || !Number.isInteger(ref.len) || typeof ref.sha256 !== 'string' || !Number.isInteger(ref.frags) || ref.frags < 1) {
          return fail('invalid-state', 'record 条目缺 id/idRef 承诺')
        }
        const here = (fragsHere.get(`${e.domain}:${e.index}`) || []).slice().sort((a, b) => a.seq - b.seq)
        try {
          declData.id = here.length === ref.frags ? v20ResolveId(here, ref) : undefined
        } catch (er) { return fail('invalid-state', `id 重组失败（同块 idfrag 不符 idRef）: ${er.message}`) }
        if (declData.id === undefined) { declData.idRef = ref; declData.idParts = here } // 跨块碎片未齐——父声明携 idRef+idParts 待后续块补全
      }
      declWrites.set(`${batchId}:decl:${e.domain}:${e.index}`, declData)
    } else if (V20_PTR_TYPES.includes(e.type)) {
      const key = v20PtrKey(batchId, e)
      if (!key) return fail('invalid-state', `薄指针定位失败（${e.type} 条目字段非法）`)
      declWrites.set(key, { type: e.type, blockIndex })
    } else {
      return fail('invalid-state', `未知条目类型 ${JSON.stringify(e.type)}`)
    }
  }

  // 跨块补全：本块 idfrag 的父声明在先前块已写（流序 core 先于碎片——父必在场；不在场=流序违约拒）
  for (const [k, list] of fragsHere) {
    const ci = k.indexOf(':')
    const domain = k.slice(0, ci), index = Number(k.slice(ci + 1))
    const coreHere = entries.some(en => en && en.type === 'record' && en.domain === domain && en.index === index)
    if (coreHere) continue // 同块——上方已直解/挂 idParts
    const parentId = `${batchId}:decl:${domain}:${index}`
    const parent = await getDocMaybe(db, COLLECTIONS.declarations, parentId)
    if (!parent) return fail('invalid-state', `idfrag 父声明缺失（${domain}:${index}——流序违约：碎片先于 core）`)
    if (parent.id !== undefined) continue // 已全长（重复碎片不改父——指针仍写，覆写跳过）
    const ref = parent.idRef
    if (!ref || !Number.isInteger(ref.frags)) return fail('invalid-state', `idfrag 父声明缺 idRef（${domain}:${index}）`)
    const merged = [...(Array.isArray(parent.idParts) ? parent.idParts : []), ...list]
    const seen = new Set(), dedup = []
    for (const p of merged.sort((a, b) => a.seq - b.seq)) {
      if (!seen.has(p.seq)) { seen.add(p.seq); dedup.push(p) }
    }
    if (dedup.length > ref.frags) return fail('invalid-state', `idfrag 片数 ${dedup.length} > idRef.frags ${ref.frags}（${domain}:${index}）`)
    if (dedup.length === ref.frags) {
      let fullId
      try { fullId = v20ResolveId(dedup, ref) } catch (er) { return fail('invalid-state', `id 跨块重组失败（${domain}:${index}）: ${er.message}`) }
      declUpdates.set(parentId, { ...v20DeclClean(parent), id: fullId })
    } else {
      declUpdates.set(parentId, { ...v20DeclClean(parent), idRef: ref, idParts: dedup })
    }
  }

  // ── 单 CAS 事务：批次游标核对 + 声明写 + consumedCursor/consumedCount + 末块 declared ──
  const tx = await db.startTransaction()
  try {
    const bdoc = await tx.collection(COLLECTIONS.batches).doc(batchId).get()
    const cur = bdoc.data
    if (!cur || cur.status !== 'indexing') { await tx.rollback(); return fail('invalid-state', `状态变化（${cur ? cur.status : 'gone'}）`) }
    const curCursor = Number.isInteger(cur.consumedCursor) ? cur.consumedCursor : 0
    if (curCursor !== blockIndex) {
      await tx.rollback()
      if (curCursor > blockIndex) {
        // 并发败者复检：游标已被赢家推进——重验存储块后方可报 replayed（不验不报）
        const rv = await v20ReadVerified(db, batchId, cur, blockIndex)
        if (rv.err) return rv.err
        return ok({ blockIndex, replayed: true, status: cur.status, consumedCursor: curCursor })
      }
      return fail('cursor-stale', `批次游标 ${curCursor} < 请求 ${blockIndex}（并发/乱序——须重读重试）`)
    }
    if (cur.v20 !== true) { await tx.rollback(); return fail('invalid-state', '批次 v20 标记丢失（消费仅 V20 批次）') }
    // 幂等防写：游标未进而新声明键已在场=外部写异常——拒（重放走上方游标门）
    for (const key of declWrites.keys()) {
      const ex = await tx.collection(COLLECTIONS.declarations).doc(key).get()
      if (ex.data) { await tx.rollback(); return fail('invalid-state', `声明键已在场而游标未进（${key}）`) }
    }
    for (const [key, data] of declWrites) await tx.collection(COLLECTIONS.declarations).doc(key).set({ data })
    for (const [key, data] of declUpdates) await tx.collection(COLLECTIONS.declarations).doc(key).set({ data })
    const consumedCount = (Number.isInteger(cur.consumedCount) ? cur.consumedCount : 0) + entries.length
    const updates = { consumedCursor: blockIndex + 1, consumedCount, updatedAt: Date.now() }
    if (blockIndex === cur.totalBlocks - 1) {
      // ③ 末块：计数核对 totalEntries——不等 fail-stop（不 declared 不推进）
      if (consumedCount !== cur.totalEntries) {
        await tx.rollback()
        return fail('index-mismatch', `已消费条目 ${consumedCount} ≠ totalEntries ${cur.totalEntries}（fail-stop——不得 declared）`)
      }
      updates.status = 'declared'
    }
    await tx.collection(COLLECTIONS.batches).doc(batchId).set({ data: { ...stripDoc(cur), ...updates } })
    await tx.commit()
  } catch (e) { await tx.rollback(); throw e }
  if (blockIndex === batch.totalBlocks - 1) {
    return ok({ blockIndex, status: 'declared', totalDeclarations: batch.totalEntries, complete: true })
  }
  return ok({ blockIndex, consumedCursor: blockIndex + 1, hasMore: true })
}

// ── indexDeclarePage：小页 + CAS 游标 + 滚动摘要 + 声明根核对 ──
async function handleIndexDeclarePage(cloud, config, caller, event) {
  const db = cloud.database()
  const { batchId, pageCursor } = event
  const { batch, err } = await getOwnedBatch(db, batchId, caller, config)
  if (err) return err
  // V20 协议模式分派（§6.4 消费切片 + 永久 legacy 旁路禁门）：V20 批次（v20 标记）禁走旧
  // manifest 分页索引——旧路径读旧 manifest 可绕过已冻结块根直推 declared（legacy 旁路永久禁止）。
  // 带 blockIndex → 已验证块消费（verifiedBlockRead 同径核验+分层声明+consumedCursor）；
  // 无 blockIndex → 明确拒零写（e580ff3b-E11 永久门——非"未实现期"临时门）。
  if (batch.v20 === true) {
    if (event.blockIndex === undefined) {
      return fail('invalid-params', 'V20 批次禁走 legacy indexDeclarePage 旧路径（无 blockIndex——块消费须按 blockIndex 已验证新路径，旧 manifest 索引旁路永久禁止）')
    }
    if (v20 === null) return fail('internal-error', 'v20 模块不可用（V20 批次块消费 fail-closed——检查部署包含 v20.js）')
    return consumeBlockV20(db, batchId, batch, event)
  }
  if (batch.status !== 'indexing') return fail('invalid-state', `indexDeclarePage 仅 indexing（当前 ${batch.status}）`)

  // keyed get manifest chunks
  const chunkTotal = batch.manifestChunkTotal
  if (!chunkTotal) return fail('invalid-state', 'manifestChunkTotal 未锚定')
  const ids = Array.from({ length: chunkTotal }, (_, i) => `${batchId}:${i}`)
  const gotResults = await keyedGetBatch(db, COLLECTIONS.declareChunks, ids)
  if (gotResults.some(r => r.doc === null)) return fail('declare-incomplete', 'manifest chunks 不全')
  let assembled = Buffer.alloc(0)
  for (const r of gotResults) assembled = Buffer.concat([assembled, b64decode(r.doc.rawB64)])
  // 防御一致限（declare 已验 ≤4MiB 且 chunk 不可变——此处防存储层异常，非信任路径）
  if (assembled.length > MAX_MANIFEST_BYTES) return fail('internal-error', `manifest 重组长度 ${assembled.length} > 4MiB`)
  let manifest
  try { manifest = JSON.parse(strictUtf8Decode(assembled)) } catch (e) { return fail('internal-error', 'manifest 重组解析失败') }

  // 派生声明（每次从 manifest 派生——但只取当前页 ≤50 条——读预算有界）
  const allKeys = [] // 稳定排序的声明键列表
  for (const [domain, list] of Object.entries(manifest.records || {})) {
    for (const decl of (list || [])) allKeys.push({ type: 'record', domain, ...decl })
  }
  for (let fi = 0; fi < (manifest.files || []).length; fi++) {
    const f = manifest.files[fi]
    if (f && f.kind === 'attachment') allKeys.push({ type: 'file', fileIndex: fi, sha256: f.sha256, length: f.length, contentType: f.contentType, originalFileId: f.originalFileId })
  }
  // reports 声明的冻结附件映射（uploadRecord/finalizeRecord 正文附件逐位核对凭据——
  // schema 已保证每条 records.reports 声明有映射项）
  // D25 首目语义（协调方 handler 集成警告 2026-09-20）：Map.set 每次覆盖=**尾目胜**——
  // G2 形（首非空+尾随空同 reportId，Stage1-valid）会冻结空附件、丢原始映射。
  // Stage1 find-first 与纯 V20（D25 三轨）均取**首目**——handler 对齐：仅当键不存在时 set。
  const reportsMapById = new Map()
  for (const rd of (manifest.reports || [])) {
    if (rd && typeof rd.reportId === 'string' && !reportsMapById.has(rd.reportId)) reportsMapById.set(rd.reportId, rd)
  }

  const start = Number(pageCursor) || 0
  if (start < 0 || start > allKeys.length) return fail('invalid-params', `pageCursor ${start} 超出`)
  const page = allKeys.slice(start, Math.min(start + INDEX_PAGE_SIZE, allKeys.length))
  const hasMore = start + INDEX_PAGE_SIZE < allKeys.length
  const nextCursor = start + page.length
  const pageSha = sha256Hex(Buffer.from(stableStringify(page.map(d =>
    d.type === 'record' ? `${d.domain}:${d.index}:${d.hash}` : `file:${d.fileIndex}:${d.sha256}`))))

  // ── CAS 事务：声明写 + 游标 + 计数 + 滚动摘要 原子化 ──
  const tx = await db.startTransaction()
  try {
    const doc = await tx.collection(COLLECTIONS.batches).doc(batchId).get()
    const cur = doc.data
    if (!cur || cur.status !== 'indexing') { await tx.rollback(); return ok({ status: cur ? cur.status : 'gone' }) }
    const curCursor = cur.indexCursor || 0
    if (curCursor !== start) { await tx.rollback(); return fail('cursor-stale', `批次游标 ${curCursor} != 请求 ${start}`) }
    // 事务内写声明（幂等：先 get 再 set——事务保证原子）
    for (const decl of page) {
      const declId = decl.type === 'record' ? `${batchId}:decl:${decl.domain}:${decl.index}` : `${batchId}:decl:file:${decl.fileIndex}`
      const existing = await tx.collection(COLLECTIONS.declarations).doc(declId).get()
      if (!existing.data) {
        const { batchId: _b, indexedAt: _t, ...cleanDecl } = decl
        let frozenReportAttachments
        if (decl.type === 'record' && decl.domain === 'reports') {
          const mapping = reportsMapById.get(String(decl.id))
          frozenReportAttachments = mapping && Array.isArray(mapping.attachments) ? mapping.attachments : []
        }
        await tx.collection(COLLECTIONS.declarations).doc(declId).set({
          data: { batchId, ...cleanDecl, ...(frozenReportAttachments ? { frozenReportAttachments } : {}), indexedAt: Date.now() }
        })
      }
    }
    const newCount = (cur.indexedCount || 0) + page.length
    // 逐 key 链式 SHA（与 declaredRootSha 同算法——不是按页摘要）
    let newRolling = cur.indexRollingSha || ''
    for (const d of page) {
      const key = d.type === 'record' ? `${d.domain}:${d.index}:${d.hash}` : `file:${d.fileIndex}:${d.sha256}`
      newRolling = sha256Hex(Buffer.from(newRolling + key))
    }
    const updates = { indexCursor: nextCursor, indexedCount: newCount, indexRollingSha: newRolling, updatedAt: Date.now() }
    if (!hasMore) {
      // 末页：核对计数 + 滚动根 vs 声明根（不从计数单方面 declared）
      if (newCount !== allKeys.length) { await tx.rollback(); return fail('index-mismatch', `已索引 ${newCount} != 声明总数 ${allKeys.length}`) }
      if (newRolling !== batch.declaredRootSha) {
        await tx.rollback()
        return fail('index-mismatch', `滚动根 ${newRolling.slice(0,12)}... != 声明根 ${batch.declaredRootSha ? batch.declaredRootSha.slice(0,12) : '?'}...`)
      }
      updates.status = 'declared'
    }
    await tx.collection(COLLECTIONS.batches).doc(batchId).set({ data: { ...stripDoc(cur), ...updates } })
    await tx.commit()
  } catch (e) { await tx.rollback(); throw e }
  if (hasMore) return ok({ nextCursor, hasMore: true, indexedThisPage: page.length })
  return ok({ status: 'declared', totalDeclarations: allKeys.length, complete: true })
}

// ══ V20 uploadRecord Merkle 链接读（§6.5——协调方指派切片 2026-09-20）══
// 声明身份/hash 须与**冻结块**内 record 条目全等（块经 verifiedBlockRead 验至 planRoot）。
// 自洽篡改（正文+声明 hash 同改）对普通请求-声明检查全盲（L2 效力证明）——唯一检出路径=与
// 冻结块比对（T5）；指针错块（T3）/底层块 proof 腐蚀（T4）在已验证读中折叠检出。
// reports 附件映射不复制（薄指针口径）：经 rmappart/refs/file 薄指针 → verifiedBlockRead →
// 条目定位重建真实映射（codes 六态码图 + items 逐槽；code0→file 条目 originalFileId）。

// file 条目 originalFileId 解析（内联或 originalFileIdRef→filefrag 指针链重建；双缺席=undefined 恒比语义）
async function v20ResolveFileOid(db, batchId, batch, fileIndex) {
  const ptr = await getDocMaybe(db, COLLECTIONS.declarations, `${batchId}:ptr:file:${fileIndex}`)
  if (!ptr || ptr.type !== 'file' || !Number.isInteger(ptr.blockIndex)) {
    return { err: fail('invalid-state', `file 薄指针缺失/非法（fileIndex ${fileIndex}——附件映射重建链断）`) }
  }
  const rread = await v20ReadVerified(db, batchId, batch, ptr.blockIndex)
  if (rread.err) return rread
  const ent = rread.entries.find(e => e && e.type === 'file' && e.fileIndex === fileIndex)
  if (!ent) return { err: fail('invalid-state', `块 ${ptr.blockIndex} 内无 file ${fileIndex} 条目（指针→条目不符）`) }
  if (ent.originalFileId !== undefined) return { oid: ent.originalFileId }
  const ref = ent.originalFileIdRef
  if (ref === undefined) return { oid: undefined } // 文件无 oid 字段——映射侧同缺席时 String 恒比 'undefined'==='undefined'
  if (!ref || !Number.isInteger(ref.len) || typeof ref.sha256 !== 'string' || !Number.isInteger(ref.frags)) {
    return { err: fail('invalid-state', `file ${fileIndex} 条目 originalFileIdRef 承诺非法`) }
  }
  const parts = []
  for (let seq = 0; seq < ref.frags; seq++) {
    const fp = await getDocMaybe(db, COLLECTIONS.declarations, `${batchId}:ptr:filefrag:${fileIndex}:originalFileId:${seq}`)
    if (!fp || fp.type !== 'filefrag' || !Number.isInteger(fp.blockIndex)) {
      return { err: fail('invalid-state', `filefrag 薄指针缺失（fileIndex ${fileIndex} originalFileId seq ${seq}）`) }
    }
    const bread = await v20ReadVerified(db, batchId, batch, fp.blockIndex)
    if (bread.err) return bread
    const fe = bread.entries.find(e => e && e.type === 'filefrag' && e.fileIndex === fileIndex && e.field === 'originalFileId' && e.seq === seq)
    if (!fe) return { err: fail('invalid-state', `块 ${fp.blockIndex} 内无 filefrag ${fileIndex}:originalFileId:${seq} 条目（指针→条目不符）`) }
    parts.push(fe.data)
  }
  const bytes = Buffer.concat(parts.map(p => Buffer.from(String(p), 'base64')))
  if (bytes.length !== ref.len || sha256Hex(bytes) !== ref.sha256) {
    return { err: fail('invalid-state', `filefrag 重组不符 originalFileIdRef 承诺（fileIndex ${fileIndex}）`) }
  }
  let oid
  try { oid = JSON.parse(strictUtf8Decode(bytes)) } catch (e) { return { err: fail('invalid-state', 'filefrag 重组字节非严格 JSON') } }
  return { oid }
}

// refs 反向链接消费（§6.5 R2——协调方指派切片 2026-09-20）：rmappart 所引每 fileIndex 须有
// refs 薄指针 part 链（0..n）——每 part 指针→v20ReadVerified（验至 planRoot）→已验证载荷内
// 定位 (fileIndex,part) 条目→items 累积。指针缺席/形状非法/所指块验证失败（含指错块——文档
// 缺失或根折叠不符）/指针→条目不符 → fail-closed（uploadRecord 拒写零持久）。
// memo=同调用内 per-fileIndex 去重（读预算线性于 distinct fileIndex）。
async function v20RefsItemsVerified(db, batchId, batch, fileIndex, memo) {
  if (memo.has(fileIndex)) return { items: memo.get(fileIndex) }
  const items = []
  let part = 0
  for (;;) {
    if (part > 65535) return { err: fail('invalid-state', `refs part 无终止（fileIndex ${fileIndex}——指针链异常）`) }
    const ptr = await getDocMaybe(db, COLLECTIONS.declarations, `${batchId}:ptr:refs:${fileIndex}:${part}`)
    if (!ptr) break // 该文件 refs part 序列终止
    if (ptr.type !== 'refs' || !Number.isInteger(ptr.blockIndex)) {
      return { err: fail('invalid-state', `refs 薄指针形状非法（fileIndex ${fileIndex}:${part}——反向链接断）`) }
    }
    const rread = await v20ReadVerified(db, batchId, batch, ptr.blockIndex)
    if (rread.err) {
      return { err: fail(rread.err.code, `refs 薄指针（fileIndex ${fileIndex}:${part}→块 ${ptr.blockIndex}）验证失败: ${String(rread.err.message).slice(0, 110)}`) }
    }
    const ent = rread.entries.find(e => e && e.type === 'refs' && e.fileIndex === fileIndex && e.part === part)
    if (!ent) return { err: fail('invalid-state', `块 ${ptr.blockIndex} 内无 refs ${fileIndex}:${part} 条目（指针→条目不符——反向链接断）`) }
    if (!Array.isArray(ent.items)) return { err: fail('invalid-state', `refs ${fileIndex}:${part} 条目 items 非法`) }
    items.push(...ent.items)
    part++
  }
  if (part === 0) return { err: fail('invalid-state', `refs 薄指针缺失（fileIndex ${fileIndex}——rmappart 所引文件必有 refs 反向链接（§6.5））`) }
  memo.set(fileIndex, items)
  return { items }
}

// reports 记录附件映射重建：rmappart 薄指针逐 part → 已验证块条目 → codes+items 逐槽解码
//（每槽并经 refs 薄指针反向链接核验——§6.5 上传映射链须同时过已验证 rmappart 与 refs 指针）
async function v20RebuildReportMapping(db, batchId, batch, recIndex) {
  const mapping = []
  let part = 0, expectedSlot = 0
  const refsMemo = new Map() // refs 反向链接 per-fileIndex 去重（同调用 distinct 读）
  for (;;) {
    if (part > 65535) return { err: fail('invalid-state', 'rmappart part 无终止（指针链异常）') }
    const ptr = await getDocMaybe(db, COLLECTIONS.declarations, `${batchId}:ptr:rmappart:${recIndex}:${part}`)
    if (!ptr) break // 该记录映射 part 序列终止（零附件记录首探即缺——空映射）
    if (ptr.type !== 'rmappart' || !Number.isInteger(ptr.blockIndex)) {
      return { err: fail('invalid-state', `rmappart 薄指针形状非法（${recIndex}:${part}）`) }
    }
    const rread = await v20ReadVerified(db, batchId, batch, ptr.blockIndex)
    if (rread.err) return rread
    const ent = rread.entries.find(e => e && e.type === 'rmappart' && e.recIndex === recIndex && e.part === part)
    if (!ent) return { err: fail('invalid-state', `块 ${ptr.blockIndex} 内无 rmappart ${recIndex}:${part} 条目（指针→条目不符）`) }
    if (!Array.isArray(ent.items) || typeof ent.codes !== 'string' || Number(ent.startSlot) !== expectedSlot) {
      return { err: fail('invalid-state', `rmappart ${recIndex}:${part} 条目 items/codes/startSlot 形状非法`) }
    }
    let codes
    try { codes = v20.readCodes(ent.codes, ent.items.length) } catch (e) {
      return { err: fail('invalid-state', `rmappart ${recIndex}:${part} codes 读回失败: ${e.message}`) }
    }
    for (let j = 0; j < ent.items.length; j++) {
      const it = ent.items[j]
      if (!it || Number(it.slot) !== expectedSlot || !Number.isInteger(it.fileIndex)) {
        return { err: fail('invalid-state', `rmappart ${recIndex}:${part} slot ${expectedSlot} 不连续/非法`) }
      }
      // R2 §6.5：refs 薄指针反向链接——本槽 (fileIndex,order) 须在已验证 refs items 内
      //（{order,recIndex} 逐槽对应：指针缺席/指错块/块验证失败/条目缺失/反向不含本槽均拒）。
      const refs = await v20RefsItemsVerified(db, batchId, batch, it.fileIndex, refsMemo)
      if (refs.err) return refs
      if (!refs.items.some(x => x && Number(x.recIndex) === Number(recIndex) && Number(x.order) === Number(it.order))) {
        return { err: fail('invalid-state', `refs 反向链接不含本槽（fileIndex ${it.fileIndex} order ${it.order} recIndex ${recIndex}——rmappart↔refs 不对应）`) }
      }
      const code = codes[j]
      let oid
      if (code === 0) {
        // 码 0：String(映射 oid)===String(file oid)——真值在 file 条目（内联或 filefrag 链）
        const f = await v20ResolveFileOid(db, batchId, batch, it.fileIndex)
        if (f.err) return f
        oid = f.oid
      } else if (code >= 1 && code <= 5) {
        // 码 1-5：映射 oid 为六态表值（派生期 deriveCode 的逆——String 恒比语义）
        oid = v20.CODE_TABLE[code - 1]
      } else {
        return { err: fail('invalid-state', `rmappart ${recIndex}:${part} 保留码 ${code}`) }
      }
      mapping.push({ order: Number(it.order), originalFileId: oid })
      expectedSlot++
    }
    part++
  }
  return { mapping }
}

async function v20UploadLinkage(db, batchId, batch, domain, index, decl) {
  if (!Number.isInteger(decl.blockIndex)) {
    return { err: fail('invalid-state', 'V20 声明缺 blockIndex（Merkle 链接读无法定位冻结块）') }
  }
  const coreRead = await v20ReadVerified(db, batchId, batch, decl.blockIndex)
  if (coreRead.err) return coreRead
  const frozen = coreRead.entries.find(e => e && e.type === 'record' && e.domain === domain && e.index === index)
  if (!frozen) return { err: fail('invalid-state', `冻结块 ${decl.blockIndex} 内无 ${domain}:${index} record 条目（声明不匹配冻结块）`) }
  if (String(frozen.hash) !== String(decl.hash)) {
    return { err: fail('declaration-mismatch', '声明 hash 不匹配冻结块条目（Merkle 链接读——正文/声明自洽篡改对普通检查全盲，此处对冻结根 planRoot 检出）') }
  }
  if (Number(frozen.revision) !== Number(decl.revision) || Boolean(frozen.deleted) !== Boolean(decl.deleted)) {
    return { err: fail('declaration-mismatch', '声明 revision/deleted 不匹配冻结块条目（Merkle 链接读）') }
  }
  if (frozen.id !== undefined) {
    if (String(frozen.id) !== String(decl.id)) {
      return { err: fail('declaration-mismatch', '声明 id 不匹配冻结块条目（Merkle 链接读）') }
    }
  } else {
    // 巨 id（idRef）：重组承诺核对——canonical(声明 id) 字节须过 idRef.len/sha256
    const ref = frozen.idRef
    const idBytes = v20.canonicalJsonBytes(decl.id)
    if (!ref || !Number.isInteger(ref.len) || idBytes.length !== ref.len || sha256Hex(idBytes) !== ref.sha256) {
      return { err: fail('declaration-mismatch', '声明 id 不匹配冻结块 idRef 承诺（Merkle 链接读）') }
    }
  }
  let mapping = []
  if (domain === 'reports') {
    const rebuilt = await v20RebuildReportMapping(db, batchId, batch, index)
    if (rebuilt.err) return rebuilt
    mapping = rebuilt.mapping
  }
  return { mapping }
}

// ── uploadRecord：内联记录（≤48KiB）──
async function handleUploadRecord(cloud, config, caller, event) {
  const db = cloud.database()
  const { batchId, domain, index, record, id, revision, deleted } = event
  const { batch, err } = await getOwnedBatch(db, batchId, caller, config)
  if (err) return err
  if (batch.status !== 'declared' && batch.status !== 'uploading') return fail('invalid-state', `uploadRecord 仅 declared/uploading（当前 ${batch.status}）`)
  if (!SUPPORTED_DOMAINS.includes(domain)) return fail('invalid-params', `未知域 ${domain}`)

  const declId = `${batchId}:decl:${domain}:${index}`
  let decl = await getDocMaybe(db, COLLECTIONS.declarations, declId)
  if (!decl) return fail('invalid-params', `无声明 ${domain}:${index}`)

  const stableStr = stableStringify(record)
  const recordBytes = Buffer.from(stableStr, 'utf8')
  if (recordBytes.length > 48 * 1024) return fail('record-too-large', `内联 ${recordBytes.length} > 48KiB`)
  const canonicalHash = sha256Hex(recordBytes)
  if (canonicalHash !== decl.hash) return fail('declaration-mismatch', 'canonical hash 不匹配')

  // 不可变请求字段须显式提供且**类型+值**逐一全等（string/number/boolean——类型变异是新请求而非重放）
  if (id === undefined || revision === undefined || deleted === undefined) {
    return fail('invalid-params', 'id/revision/deleted 须显式提供')
  }
  if (typeof id !== 'string' || typeof revision !== 'number' || !Number.isFinite(revision) || typeof deleted !== 'boolean') {
    return fail('invalid-params', 'id/revision/deleted 类型非法（须 string/number/boolean）')
  }
  if (id !== decl.id) return fail('declaration-mismatch', `id ${idPrev(id)} != 声明 ${idPrev(decl.id)}`)
  // P16：Stage1 Number()/Boolean() 等价比较
  if (Number(revision) !== Number(decl.revision)) return fail('declaration-mismatch', `revision ${idPrev(revision)} != 声明 ${idPrev(decl.revision)}`)
  if (Boolean(deleted) !== Boolean(decl.deleted)) return fail('declaration-mismatch', `deleted ${idPrev(deleted)} != 声明 ${idPrev(decl.deleted)}`)

  // ── V20 Merkle 链接读（§6.5 切片）：声明须与冻结块全等 + 附件映射经薄指针重建 ──
  // 普通检查（hash/id/revision/deleted vs 声明）对"正文+声明同改"的自洽篡改全盲——
  // 唯一检出路径=与冻结块（verifiedBlockRead 验至 planRoot）比对；reports 映射不复制，
  // 经 rmappart/refs/file 薄指针重建真实映射逐位核对。legacy 批次零变化（L1/L2 基线）。
  if (batch.v20 === true) {
    if (v20 === null) return fail('internal-error', 'v20 模块不可用（V20 批次链接读 fail-closed——检查部署包含 v20.js）')
    const link = await v20UploadLinkage(db, batchId, batch, domain, index, decl)
    if (link.err) return link.err
    decl = { ...decl, frozenReportAttachments: link.mapping }
  }

  // 域白名单记录形状（服务端重施导出端投影规则——零写）
  const shapeErr1 = validateRecordShape(domain, record, decl)
  if (shapeErr1) return fail('declaration-mismatch', `域 ${domain} 记录形状不合格：${shapeErr1}（零写）`)

  const recordId = `${batchId}:${domain}:${index}`
  // 单事务：批次状态+fail-closed 冻结域字节（先于 replay 短路）→ 检查已存在 → 聚合 → 写记录
  const tx = await db.startTransaction()
  try {
    const batchDoc = await tx.collection(COLLECTIONS.batches).doc(batchId).get()
    const cur = batchDoc.data
    if (!cur || (cur.status !== 'uploading' && cur.status !== 'declared')) { await tx.rollback(); return fail('invalid-state', `状态变化（${cur ? cur.status : 'gone'}）`) }
    // fail-closed（先于 replay——legacy/异常批次不可假报 replayed:true）
    if (!Number.isSafeInteger(cur.frozenDomainBytes) || cur.frozenDomainBytes < 0) {
      await tx.rollback()
      return fail('invalid-state', `批次缺合法 frozenDomainBytes（=${cur.frozenDomainBytes}）——须重新 declare 后再上传`)
    }
    const effectiveCapInline = Math.min(MAX_BATCH_RECORD_BYTES, cur.frozenDomainBytes)
    // 聚合计数器磁盘态 fail-closed（先于 replay——篡改/串接/超上限不可假报 replayed:true）
    const aggErrInline = validateAggCounter(cur.aggregateRecordBytes, effectiveCapInline, 'aggregateRecordBytes', cur.contentGeneration)
    if (aggErrInline) {
      await tx.rollback()
      return fail('invalid-state', `批次聚合计数器非法：${aggErrInline}——须重新 declare`)
    }
    const existingDoc = await tx.collection(COLLECTIONS.records).doc(recordId).get()
    const existing = existingDoc.data
    if (existing) {
      await tx.rollback()
      if (existing.canonicalHash === canonicalHash) return ok({ domain, index, replayed: true })
      return fail('declaration-mismatch', '已有不同内容')
    }
    const newAggInline = (cur.aggregateRecordBytes ?? 0) + recordBytes.length
    if (newAggInline > effectiveCapInline) {
      await tx.rollback()
      return fail('record-too-large', `批次聚合记录字节 ${newAggInline} > ${effectiveCapInline}（冻结域字节上限）`)
    }
    const updates = { contentGeneration: (cur.contentGeneration || 0) + 1, aggregateRecordBytes: newAggInline, updatedAt: Date.now() }
    if (cur.status === 'declared') updates.status = 'uploading'
    await tx.collection(COLLECTIONS.batches).doc(batchId).set({ data: { ...stripDoc(cur), ...updates } })
    await tx.collection(COLLECTIONS.records).doc(recordId).set({
      data: { batchId, domain, index, recordId: decl.id, revision: Number(decl.revision), deleted: Boolean(decl.deleted),
        canonicalHash, byteLength: recordBytes.length, record, isChunked: false, uploadedAt: Date.now() }
    })
    await tx.commit()
  } catch (e) { await tx.rollback(); throw e }
  return ok({ domain, index })
}

// ── uploadRecordChunk：分片记录上传（全在一个 CAS 事务）──
async function handleUploadRecordChunk(cloud, config, caller, event) {
  const db = cloud.database()
  const { batchId, domain, index, chunkIndex, chunkTotal, chunkB64, chunkSha256 } = event
  const { batch, err } = await getOwnedBatch(db, batchId, caller, config)
  if (err) return err
  // V20 fail-closed（§6.4 消费切片）：V20 批次的分片上传旧路径未实现 V20 链接核验
  // （Merkle 链接读+薄指针映射重建）——明确拒零写，不得静默降级接受。
  if (batch.v20 === true) return fail('invalid-state', 'V20 批次禁走分片上传旧路径（fail-closed——V20 记录上传须内联 uploadRecord 经 Merkle 链接核验）')
  if (batch.status !== 'declared' && batch.status !== 'uploading') return fail('invalid-state', `uploadRecordChunk 仅 declared/uploading（当前 ${batch.status}）`)
  if (!SUPPORTED_DOMAINS.includes(domain)) return fail('invalid-params', `未知域 ${domain}`)
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) return fail('invalid-params', 'chunkIndex 非法')
  if (!Number.isInteger(chunkTotal) || chunkTotal < 1 || chunkTotal > MAX_RECORD_CHUNKS) return fail('invalid-params', `chunkTotal 须 1-${MAX_RECORD_CHUNKS}`)
  if (chunkIndex >= chunkTotal) return fail('invalid-params', `chunkIndex ${chunkIndex} >= chunkTotal ${chunkTotal}`)
  if (!isValidB64(chunkB64)) return fail('invalid-params', 'chunkB64 非合法 base64')
  const rawBytes = b64decode(chunkB64)
  if (rawBytes.length === 0 || rawBytes.length > MAX_CHUNK_B64) return fail('invalid-params', `chunk ${rawBytes.length} 超界`)
  // 规范传输形状（v13——任何写入前强制）：非末片恰 40KiB 原始字节、末片 0<len≤40KiB。
  // 字节聚合不界文档数（1 字节片洪泛可达 103 万 docs）——规范形状使每记录 chunk 数=⌈字节/40KiB⌉（可数）。
  // 阶段一导出器兼容：客户端对记录 canonical 字节按此形状重切（运输形状≠记录字节）。
  if (chunkIndex < chunkTotal - 1 && rawBytes.length !== MAX_CHUNK_B64) {
    return fail('invalid-params', `非末片须恰 ${MAX_CHUNK_B64}B（收到 ${rawBytes.length}——规范传输形状）`)
  }
  if (!HEX64.test(chunkSha256 || '')) return fail('invalid-params', 'chunkSha256 须 64hex')
  if (sha256Hex(rawBytes) !== chunkSha256) return fail('chunk-conflict', 'SHA 不匹配')

  // 声明校验（域白名单+声明存在）
  const declId = `${batchId}:decl:${domain}:${index}`
  const decl = await getDocMaybe(db, COLLECTIONS.declarations, declId)
  if (!decl) return fail('invalid-params', `无声明 ${domain}:${index}`)

  // 前序 chunk 存在（非首片时须按序）
  if (chunkIndex > 0) {
    const prevId = `${batchId}:rec:${domain}:${index}:${chunkIndex - 1}`
    const prev = await getDocMaybe(db, COLLECTIONS.recordChunks, prevId)
    if (!prev) return fail('record-chunks-incomplete', `前序 chunk ${chunkIndex - 1} 缺失（须按序上传）`)
  }

  const recordId = `${batchId}:${domain}:${index}`
  const anchorId = `${batchId}:anchor:${domain}:${index}`
  const chunkDocId = `${batchId}:rec:${domain}:${index}:${chunkIndex}`

  // ── 单一 CAS 事务：chunk 存在+内容+anchor+字节上限+chunk 写+状态推+generation ──
  let newCumu // 事务外声明——事务内赋值，事务外使用
  const tx = await db.startTransaction()
  try {
    // 1. 批次状态（事务内重读——防冻结/abandon 竞态）
    const batchDoc = await tx.collection(COLLECTIONS.batches).doc(batchId).get()
    const cur = batchDoc.data
    if (!cur || (cur.status !== 'uploading' && cur.status !== 'declared')) {
      await tx.rollback(); return fail('invalid-state', `状态变化（${cur ? cur.status : 'gone'}）`)
    }
    // 2. finalize 后拒新 chunk（事务内检查 consumedAt）
    const existingRecordDoc = await tx.collection(COLLECTIONS.records).doc(recordId).get()
    if (existingRecordDoc.data && existingRecordDoc.data.consumedAt) {
      await tx.rollback(); return fail('record-consumed', '该记录已 finalize')
    }
    // 4. 批次聚合硬上限（两分支统一，先于任何事务 set——首片/续片同门）：
    //    Σ记录字节 ≤ min(24MiB, frozenDomainBytes)（冻结域字节更精确且 ≤24MiB 平坦上界）
    //    fail-closed：legacy/异常批次缺 frozenDomainBytes 或非安全非负整数 → 拒绝上传（不静默用弱 24MiB）
    if (!Number.isSafeInteger(cur.frozenDomainBytes) || cur.frozenDomainBytes < 0) {
      await tx.rollback()
      return fail('invalid-state', `批次缺合法 frozenDomainBytes（=${cur.frozenDomainBytes}）——须重新 declare 后再上传`)
    }
    const effectiveCap = Math.min(MAX_BATCH_RECORD_BYTES, cur.frozenDomainBytes)
    // 聚合计数器磁盘态 fail-closed（先于 chunk replay）
    const aggErrChunk = validateAggCounter(cur.aggregateRecordBytes, effectiveCap, 'aggregateRecordBytes', cur.contentGeneration)
    if (aggErrChunk) {
      await tx.rollback()
      return fail('invalid-state', `批次聚合计数器非法：${aggErrChunk}——须重新 declare`)
    }
    // chunk 幂等（事务内——同内容重放返回不递增；须先过 fail-closed 门）
    const existingChunkDoc = await tx.collection(COLLECTIONS.recordChunks).doc(chunkDocId).get()
    if (existingChunkDoc.data) {
      await tx.rollback()
      if (existingChunkDoc.data.chunkSha256 === chunkSha256) return ok({ chunkIndex, replayed: true })
      return fail('chunk-conflict', `chunk ${chunkIndex} 已有不同内容`)
    }
    const newAgg = (cur.aggregateRecordBytes ?? 0) + rawBytes.length
    if (newAgg > effectiveCap) {
      await tx.rollback()
      return fail('record-too-large', `批次聚合记录字节 ${newAgg} > ${effectiveCap}（冻结域字节上限）`)
    }
    // anchor 锚定+校验+累计字节持久递增（事务内——每次新 chunk 更新 cumuBytes）
    const anchorDoc = await tx.collection(COLLECTIONS.anchors).doc(anchorId).get()
    if (anchorDoc.data) {
      if (anchorDoc.data.chunkTotal !== chunkTotal) { await tx.rollback(); return fail('chunk-total-mismatch', `锚定 ${anchorDoc.data.chunkTotal}`) }
      newCumu = (anchorDoc.data.cumuBytes || 0) + rawBytes.length
      // 规范形状累计不变量（CAS 事务内）：非末片后 cumuBytes 恒等于 (chunkIndex+1)×40KiB——确定性核对（防乱序/重复计数漂移）
      if (chunkIndex < chunkTotal - 1 && newCumu !== (chunkIndex + 1) * MAX_CHUNK_B64) {
        await tx.rollback(); return fail('invalid-params', `非末片累计 ${newCumu} ≠ ${(chunkIndex + 1) * MAX_CHUNK_B64}（规范形状破坏）`)
      }
      if (newCumu > MAX_DOMAIN_BYTES_LIMIT) { await tx.rollback(); return fail('record-too-large', `累计 ${newCumu} > ${MAX_DOMAIN_BYTES_LIMIT}`) }
      // 持久更新累计字节（同一事务——重放已在上面的 chunk 幂等分支返回，不会双加）
      await tx.collection(COLLECTIONS.anchors).doc(anchorId).set({
        data: { ...stripDoc(anchorDoc.data), cumuBytes: newCumu, updatedAt: Date.now() }
      })
    } else {
      if (chunkIndex !== 0) { await tx.rollback(); return fail('record-chunks-incomplete', '首片未上传（无 anchor）') }
      newCumu = rawBytes.length
      if (newCumu > MAX_DOMAIN_BYTES_LIMIT) { await tx.rollback(); return fail('record-too-large', `累计 ${newCumu} > ${MAX_DOMAIN_BYTES_LIMIT}`) }
      await tx.collection(COLLECTIONS.anchors).doc(anchorId).set({
        data: { batchId, domain, recordIndex: index, chunkTotal, firstChunkSha256: chunkSha256, cumuBytes: newCumu, createdAt: Date.now() }
      })
    }
    // 5. 写 chunk + 推状态 + 递增 generation（同一事务）
    const updates = { contentGeneration: (cur.contentGeneration || 0) + 1, aggregateRecordBytes: newAgg, updatedAt: Date.now() }
    if (cur.status === 'declared') updates.status = 'uploading'
    await tx.collection(COLLECTIONS.batches).doc(batchId).set({ data: { ...stripDoc(cur), ...updates } })
    await tx.collection(COLLECTIONS.recordChunks).doc(chunkDocId).set({
      data: { batchId, domain, recordIndex: index, chunkIndex, chunkSha256, rawB64: chunkB64, byteLength: rawBytes.length }
    })
    await tx.commit()
  } catch (e) { await tx.rollback(); throw e }
  return ok({ chunkIndex, cumulative: newCumu })
}

// ── finalizeRecord：单次读重组 + CAS 落库（事务内检查已存在）──
async function handleFinalizeRecord(cloud, config, caller, event) {
  const db = cloud.database()
  const { batchId, domain, index, id, revision, deleted, expectedChunkTotal, expectedSha256 } = event
  const { batch, err } = await getOwnedBatch(db, batchId, caller, config)
  if (err) return err
  // V20 fail-closed（§6.4 消费切片）：V20 批次的分片终结旧路径未实现 V20 链接核验——明确拒零写。
  if (batch.v20 === true) return fail('invalid-state', 'V20 批次禁走分片终结旧路径（fail-closed——V20 记录上传须内联 uploadRecord 经 Merkle 链接核验）')
  if (batch.status !== 'uploading' && batch.status !== 'declared') return fail('invalid-state', `finalizeRecord 仅 uploading（当前 ${batch.status}）`)
  if (!SUPPORTED_DOMAINS.includes(domain)) return fail('invalid-params', `未知域 ${domain}`)
  if (!HEX64.test(expectedSha256 || '')) return fail('invalid-params', 'expectedSha256 须 64hex')
  if (!Number.isInteger(expectedChunkTotal) || expectedChunkTotal < 1 || expectedChunkTotal > MAX_RECORD_CHUNKS) return fail('invalid-params', 'expectedChunkTotal 非法')
  // 全部不可变字段须显式提供且**类型+值**逐一全等（string/number/boolean——类型变异是新请求而非重放）
  if (id === undefined || revision === undefined || deleted === undefined) {
    return fail('invalid-params', 'id/revision/deleted 须显式提供')
  }
  if (typeof id !== 'string' || typeof revision !== 'number' || !Number.isFinite(revision) || typeof deleted !== 'boolean') {
    return fail('invalid-params', 'id/revision/deleted 类型非法（须 string/number/boolean）')
  }

  const recordId = `${batchId}:${domain}:${index}`
  const anchorId = `${batchId}:anchor:${domain}:${index}`

  // 事务外快速检查（重放短路——减少不必要的事务）
  const existingQuick = await getDocMaybe(db, COLLECTIONS.records, recordId)
  if (existingQuick && existingQuick.consumedAt) {
    // 重放：比对全部不可变请求字段（须全部显式提供且精确全等）
    if (existingQuick.canonicalHash === expectedSha256 && existingQuick.chunkTotal === expectedChunkTotal &&
        existingQuick.recordId === id &&
        existingQuick.revision === revision &&
        existingQuick.deleted === deleted) {
      return ok({ domain, index, replayed: true })
    }
    return fail('finalize-conflict', '已有不同 finalize 结果（非原请求重放）')
  }

  // anchor 校验
  const anchor = await getDocMaybe(db, COLLECTIONS.anchors, anchorId)
  if (!anchor) return fail('record-chunks-incomplete', '无 anchor')
  if (anchor.chunkTotal !== expectedChunkTotal) return fail('chunk-total-mismatch', `锚定 ${anchor.chunkTotal} != expected ${expectedChunkTotal}`)

  // keyed get 全部 chunk（4MiB 显式例外）
  const chunkIds = Array.from({ length: expectedChunkTotal }, (_, i) => `${batchId}:rec:${domain}:${index}:${i}`)
  const gotResults = await keyedGetBatch(db, COLLECTIONS.recordChunks, chunkIds)
  if (gotResults.some(r => r.doc === null)) {
    const missing = gotResults.filter(r => r.doc === null).length
    return fail('record-chunks-incomplete', `缺 ${missing}/${expectedChunkTotal} 片`)
  }
  let assembled = Buffer.alloc(0)
  const frozenChunkSha256 = []
  for (const r of gotResults) {
    const chunkBytes = b64decode(r.doc.rawB64)
    frozenChunkSha256.push(sha256Hex(chunkBytes)) // per-chunk actual SHA（从原始字节重算——不信存储字段）
    assembled = Buffer.concat([assembled, chunkBytes])
  }
  if (assembled.length > MAX_DOMAIN_JSON_BYTES) return fail('record-too-large', `累计 ${assembled.length} > ${MAX_DOMAIN_JSON_BYTES}`)

  const canonicalHash = sha256Hex(assembled)
  const declId = `${batchId}:decl:${domain}:${index}`
  const decl = await getDocMaybe(db, COLLECTIONS.declarations, declId)
  if (!decl) return fail('invalid-params', `无声明 ${domain}:${index}`)
  // 三方全等 + 不可变请求字段与声明精确全等（无回退）
  if (decl.hash !== canonicalHash || expectedSha256 !== canonicalHash) return fail('declaration-mismatch', 'canonical hash 三方不一致（零写）')
  if (id !== decl.id) return fail('declaration-mismatch', `id ${idPrev(id)} != 声明 ${idPrev(decl.id)}`)
  // P16：Stage1 Number()/Boolean() 等价比较
  if (Number(revision) !== Number(decl.revision)) return fail('declaration-mismatch', `revision ${idPrev(revision)} != 声明 ${idPrev(decl.revision)}`)
  if (Boolean(deleted) !== Boolean(decl.deleted)) return fail('declaration-mismatch', `deleted ${idPrev(deleted)} != 声明 ${idPrev(decl.deleted)}`)

  // 解析 JSON（零写——严格解码，非法 UTF-8 拒绝不替换）
  let record
  try { record = JSON.parse(strictUtf8Decode(assembled)) } catch (e) { return fail('declaration-mismatch', 'JSON 解析失败（零写）') }
  // 重序列化字节全等（严格 canonical——lone surrogate/sparse/undefined 拒绝）
  let reserialized
  try { reserialized = stableStringify(record) } catch (e) { return fail('declaration-mismatch', `重序列化失败: ${e.message}（零写）`) }
  if (!Buffer.from(reserialized, 'utf8').equals(assembled)) return fail('declaration-mismatch', '重序列化字节不等（零写）')

  // 域白名单记录形状（服务端重施导出端投影规则——零写；替代旧"仅顶层对象"检查）
  const shapeErr2 = validateRecordShape(domain, record, decl)
  if (shapeErr2) return fail('declaration-mismatch', `域 ${domain} 记录形状不合格：${shapeErr2}（零写）`)

  // ── CAS 小事务：事务内检查已存在 → 写元数据 + 递增 ──
  const tx = await db.startTransaction()
  try {
    // 事务内再查一次已存在（防并发 finalize 双写）——比对全部不可变字段
    const existingDoc = await tx.collection(COLLECTIONS.records).doc(recordId).get()
    if (existingDoc.data && existingDoc.data.consumedAt) {
      await tx.rollback()
      if (existingDoc.data.canonicalHash === canonicalHash && existingDoc.data.chunkTotal === expectedChunkTotal &&
          existingDoc.data.recordId === id &&
          existingDoc.data.revision === revision &&
          existingDoc.data.deleted === deleted) {
        return ok({ domain, index, replayed: true })
      }
      return fail('finalize-conflict', '并发 finalize 已有不同结果')
    }
    const batchDoc = await tx.collection(COLLECTIONS.batches).doc(batchId).get()
    const cur = batchDoc.data
    if (!cur || (cur.status !== 'uploading' && cur.status !== 'declared')) { await tx.rollback(); return fail('invalid-state', `状态变化`) }
    // P16：chunk 路径元数据与内联路径（uploadRecord）同样归一——声明可携带 Stage1 保留形状
    // （如 revision:"0" 字符串/deleted:0 数值），存储恒 Number()/Boolean()；重放判等
    // （existing.revision === revision，请求经类型门恒 number/boolean）依赖此归一成立。
    await tx.collection(COLLECTIONS.records).doc(recordId).set({
      data: { batchId, domain, index, recordId: decl.id, revision: Number(decl.revision), deleted: Boolean(decl.deleted),
        canonicalHash, byteLength: assembled.length, chunkTotal: expectedChunkTotal, frozenChunkSha256,
        isChunked: true, chunkIdPrefix: `${batchId}:rec:${domain}:${index}`,
        consumedAt: Date.now(), finalizedAt: Date.now() }
    })
    await tx.collection(COLLECTIONS.batches).doc(batchId).set({
      data: { ...stripDoc(cur), contentGeneration: (cur.contentGeneration || 0) + 1, updatedAt: Date.now() }
    })
    await tx.commit()
  } catch (e) { await tx.rollback(); throw e }
  return ok({ domain, index, byteLength: assembled.length, chunkTotal: expectedChunkTotal })
}

// ── progress：只读分页（零服务端写；响应含活跃 preflightId 供客户端恢复——commit 未实现期无此字段）──
// 批次摘要（有限整数）+ 逐声明分页 items（done=记录/附件已落库），游标=已见最后声明 _id（稳定升序）。
async function handleProgress(cloud, config, caller, event) {
  const db = cloud.database()
  const { batchId, domain, cursor } = event
  const { batch, err } = await getOwnedBatch(db, batchId, caller, config)
  if (err) return err
  const limit = Math.min(Math.max(Number.isInteger(event.limit) ? event.limit : PROGRESS_PAGE_SIZE, 1), PROGRESS_PAGE_SIZE)
  if (domain !== undefined && domain !== null && !SUPPORTED_DOMAINS.includes(domain)) return fail('invalid-params', `未知域 ${domain}`)
  if (cursor !== undefined && cursor !== null && typeof cursor !== 'string') return fail('invalid-params', 'cursor 须字符串')

  // 稳定升序分页：_id > cursor（域过滤：声明 _id 域字典序连续——越界即停，无全量扫描）
  const prefix = domain ? `${batchId}:decl:${domain}:` : null
  // 作用域游标强校验（设计裁定 2026-09-20——取代归一化）：
  // - domain 给定：cursor 必须以 `<batchId>:decl:<domain>:` 精确前缀开头（本批次本域声明键）——
  //   他域/他批次/越界游标一律 invalid-params（不静默重置分页、不假空成功）
  // - domain 省略：cursor 必须以 `<batchId>:decl:` 开头（本批次声明键）
  // 同域正常游标行为不变（gt 起始续扫）。
  const batchKeyPrefix = `${batchId}:`
  if (cursor !== undefined && cursor !== null && typeof cursor === 'string' && cursor.length > 0) {
    const required = prefix || batchKeyPrefix
    if (!cursor.startsWith(required)) {
      return fail('invalid-params', `cursor 不属于${prefix ? `域 ${domain}` : '本批次'}声明键空间（须以 ${required}… 开头）`)
    }
  }
  let startAfter = cursor || (prefix ? prefix : '')
  const rows = []
  let exhausted = false
  for (let round = 0; round < 4 && rows.length < limit; round++) {
    const where = { batchId }
    if (startAfter) where._id = db.command.gt(startAfter)
    const snap = await db.collection(COLLECTIONS.declarations).where(where).orderBy('_id', 'asc').limit(100).get()
    const page = (snap && snap.data) || []
    if (!page.length) { exhausted = true; break }
    for (const row of page) {
      if (prefix) {
        if (!row._id.startsWith(prefix)) {
          // 声明 _id 域字典序连续——升序扫描越过错误前缀外的首个更大键即该域尽
          if (row._id > prefix) { exhausted = true; break }
          continue
        }
      }
      rows.push(row)
      if (rows.length >= limit) break
    }
    if (exhausted || rows.length >= limit) break
    startAfter = page[page.length - 1]._id
    if (page.length < 100) { exhausted = true; break }
  }
  // done 判定（键控批量读——记录/附件已落库即 done；分片未 finalize 不算）
  const recordIds = [], fileIds = []
  for (const r of rows) {
    if (r.type === 'record') recordIds.push(`${batchId}:${r.domain}:${r.index}`)
    else if (r.type === 'file') fileIds.push(`${batchId}:${r.fileIndex}`)
  }
  const recordDocs = await keyedGetBatch(db, COLLECTIONS.records, recordIds)
  const fileDocs = await keyedGetBatch(db, COLLECTIONS.files, fileIds)
  const doneRecords = new Set(recordDocs.filter(x => x.doc !== null).map(x => x.id))
  const doneFiles = new Set(fileDocs.filter(x => x.doc !== null).map(x => x.id))
  // 逻辑条目过滤：仅 record/file 产 items——索引块未来的物理条目（refs/idfrag/filefrag/ridfrag/cshafrag/*-core 碎片族）
  // 不作为附件或记录展示（V8 §1 逻辑/物理分层；当前声明集只有 record/file——防御性过滤先落）
  const items = []
  let pageBytes = 0
  let truncatedByBytes = false
  // 游标推进不变量：物理条目跳过也推进扫描位置（纯物理页不得停在原游标——否则客户端死循环）；
  // 字节截断时，未收入本页的逻辑条目不得越过（下一页从它开始——不跳不漏）。
  let scanRowId = null
  for (const r of rows) {
    let item
    if (r.type === 'record') {
      item = { type: 'record', domain: r.domain, index: r.index, ...inlineOrShort('id', r.id), revision: r.revision, deleted: r.deleted, done: doneRecords.has(`${batchId}:${r.domain}:${r.index}`) }
    } else if (r.type === 'file') {
      item = { type: 'file', fileIndex: r.fileIndex, sha256: r.sha256, length: r.length, contentType: r.contentType, ...inlineOrShort('originalFileId', r.originalFileId), done: doneFiles.has(`${batchId}:${r.fileIndex}`) }
    } else {
      scanRowId = r._id // 物理碎片/引用视图条目——不展示但游标越过
      continue
    }
    const sz = Buffer.byteLength(JSON.stringify(item), 'utf8')
    if (items.length && pageBytes + sz > PROGRESS_PAGE_BYTES) { // 字节预算收页（至少保留 1 条；r 未消费——不推进）
      truncatedByBytes = true
      break
    }
    items.push(item)
    pageBytes += sz
    scanRowId = r._id
    if (pageBytes > PROGRESS_PAGE_BYTES) { truncatedByBytes = true; break } // 单条即超预算——已收编、推进
  }
  const hasMore = truncatedByBytes || (!exhausted && rows.length === limit)
  return ok({
    // 顶层 status（H1/K1 契约位）：批次当前状态——与 batch.status 同源（加性字段，不改动既有键）
    status: batch.status,
    batch: {
      batchId, status: batch.status, contentGeneration: batch.contentGeneration || 0,
      claimedKind: batch.claimedKind, totals: batch.totals || null,
      declaredRecords: batch.declaredRecords !== undefined ? batch.declaredRecords : null,
      declaredFiles: batch.declaredFiles !== undefined ? batch.declaredFiles : null,
      manifestChunkTotal: batch.manifestChunkTotal !== undefined ? batch.manifestChunkTotal : null,
      indexedCount: batch.indexedCount !== undefined ? batch.indexedCount : null,
      indexCursor: batch.indexCursor !== undefined ? batch.indexCursor : null,
    },
    ...(batch.preflight && batch.preflight.preflightId ? { preflightId: batch.preflight.preflightId } : {}),
    items, nextCursor: scanRowId || (cursor || null), hasMore,
  })
}

// ── list：owner-only 分页（跨家庭隔离；含纯共享包——家人用原包开自己批次）──
async function handleList(cloud, config, caller, event) {
  const db = cloud.database()
  const { cursor } = event
  if (cursor !== undefined && cursor !== null && typeof cursor !== 'string') return fail('invalid-params', 'cursor 须字符串')
  const where = { ownerMemberId: caller.memberId, familyId: config.familyId }
  if (cursor) where._id = db.command.gt(cursor)
  const snap = await db.collection(COLLECTIONS.batches).where(where).orderBy('_id', 'asc').limit(LIST_PAGE_SIZE).get()
  const rows = (snap && snap.data) || []
  const batches = rows.map(b => ({
    batchId: b.batchId, status: b.status, claimedKind: b.claimedKind,
    createdAt: b.createdAt, updatedAt: b.updatedAt,
    totals: b.totals || null,
    declaredRecords: b.declaredRecords !== undefined ? b.declaredRecords : null,
    declaredFiles: b.declaredFiles !== undefined ? b.declaredFiles : null,
    contentGeneration: b.contentGeneration || 0,
  }))
  return ok({ batches, nextCursor: rows.length ? rows[rows.length - 1]._id : null, hasMore: rows.length === LIST_PAGE_SIZE })
}

// ══ commit / verify / abandon（§5.1 动作表 + §5.2.1 并发串行化）══
//
// commit 语义（本切片——与冻结红先行套件 H1 验收基准一致）：
// - 预检=**稳定性证明**：单活跃预检 {preflightId, startGen, cursor, checkedCount, checkedDigest,
//   leaseExpiresAt} 持久于批次文档；逐页 CAS 走查 mc_restore_declarations（_id 升序——V20 薄指针
//   无 batchId 字段天然排除），链式摘要+计数闭包（checkedCount === indexedCount——零声明空包 0=0）
//   + 每页 contentGeneration===startGen 复核（upload/attach 族任何新写必 +1——世代漂移=预检期间
//   内容变化 → 清除预检 + content-changed）。ID 不匹配且租约未过期 → preflight-conflict；租约过期
//   → CAS 接管（新 preflightId）。
// - 冻结 O(1)：闭包达成同事务写 proofComplete=true ∧ provenGeneration=startGen ∧ status=verifying
//   （declared 起步的批次在预检创建时先翻 uploading——§5.2 零声明空包同款推进）。
// - verifying 分页验证 mc_restore_records **全部已落库记录**：内联重算 canonical SHA vs 落库
//   canonicalHash；分片逐 chunk 解码重算 SHA vs finalize 冻结 frozenChunkSha256（不重组全量——
//   §5.1 verify 游标粒度）；≤50 项/页 ∧ ≤256KiB 读取/页（两项同时生效——服务端持久游标 vf 续传）。
//   腐蚀 → 持久化失败码 + 终态 verify-corruption（commit 有状态语义）；全部验毕同事务原子 restored。
// - 【验证覆盖面如实声明】附件文件字节复验属 attachFile 后续切片（mc_restore_files 当前无写入方）；
//   本切片 commit/verify 覆盖=已落库隔离记录。声明未闭环（declaring/indexing/preparing）与 V20
//   批次 fail-closed 拒绝提交（V20 状态机集成属后续切片——不静默走 legacy 语义）。
// - restored 终态幂等：同 batchId 恒 ok {status:'restored'}（不依赖 preflightId——终态不可回退）。

function declChainKey(row) {
  if (row.type === 'record') return `${row.domain}:${row.index}:${row.hash}`
  if (row.type === 'file') return `file:${row.fileIndex}:${row.sha256}`
  return null // 未知声明类型（legacy 索引只写 record/file——防御性 fail-closed 由调用方处理）
}

// ── 单记录复验核心（commit verifying 与 standalone verify 共用——纯只读零写）──
// 返回 {ok:true, bytes, stopCi}（stopCi!=null=页字节预算截断——须以该 chunkIndex 续）
//    或 {ok:false, code, detail}（腐蚀/元数据非法）。
async function verifyRecordDoc(db, doc, startCi, budgetLeft) {
  if (!doc || typeof doc !== 'object') return { ok: false, code: 'record-doc-invalid', detail: '记录文档缺失/非法' }
  if (doc.isChunked === true) {
    const chunkTotal = doc.chunkTotal
    if (!Number.isInteger(chunkTotal) || chunkTotal < 1 || chunkTotal > MAX_RECORD_CHUNKS) {
      return { ok: false, code: 'record-meta-invalid', detail: `chunkTotal 非法（=${chunkTotal}）` }
    }
    const frozen = doc.frozenChunkSha256
    if (!Array.isArray(frozen) || frozen.length !== chunkTotal) {
      return { ok: false, code: 'record-meta-invalid', detail: `frozenChunkSha256 长度 ${Array.isArray(frozen) ? frozen.length : '非数组'} ≠ chunkTotal ${chunkTotal}` }
    }
    if (typeof doc.chunkIdPrefix !== 'string' || !doc.chunkIdPrefix) {
      return { ok: false, code: 'record-meta-invalid', detail: 'chunkIdPrefix 缺失' }
    }
    let bytes = 0
    for (let ci = startCi; ci < chunkTotal; ci++) {
      const chunkDoc = await getDocMaybe(db, COLLECTIONS.recordChunks, `${doc.chunkIdPrefix}:${ci}`)
      if (!chunkDoc) return { ok: false, code: 'chunk-missing', detail: `chunk ${ci}/${chunkTotal} 缺失` }
      if (typeof chunkDoc.rawB64 !== 'string' || chunkDoc.rawB64.length === 0) {
        return { ok: false, code: 'chunk-doc-invalid', detail: `chunk ${ci} rawB64 缺失/非法` }
      }
      const raw = b64decode(chunkDoc.rawB64)
      if (sha256Hex(raw) !== String(frozen[ci])) {
        return { ok: false, code: 'chunk-hash-mismatch', detail: `chunk ${ci} 实际字节 SHA ≠ finalize 冻结承诺` }
      }
      bytes += raw.length
      if (bytes > budgetLeft && ci < chunkTotal - 1) return { ok: true, bytes, stopCi: ci + 1 } // 页预算截断——续传点
    }
    return { ok: true, bytes, stopCi: null }
  }
  // 内联记录：重算 canonical SHA vs 落库 canonicalHash（canonical 字节在 upload 时已与冻结声明
  // 三方核对——声明不可变（declared 后无索引写路径），此处只需对落库字节做完整性复验）
  let recordBytes
  try { recordBytes = Buffer.from(stableStringify(doc.record), 'utf8') } catch (e) {
    return { ok: false, code: 'record-serialize-failed', detail: `canonical 重序列化失败: ${String(e && e.message).slice(0, 80)}` }
  }
  if (sha256Hex(recordBytes) !== String(doc.canonicalHash || '')) {
    return { ok: false, code: 'hash-mismatch', detail: '重算 canonical SHA ≠ 落库 canonicalHash（存储腐蚀）' }
  }
  return { ok: true, bytes: recordBytes.length, stopCi: null }
}

// ── restore.commit ──
async function handleCommit(cloud, config, caller, event) {
  const db = cloud.database()
  const { batchId, preflightId, pageCursor } = event
  const { batch, err } = await getOwnedBatch(db, batchId, caller, config)
  if (err) return err
  if (pageCursor !== undefined && pageCursor !== null && (typeof pageCursor !== 'string' || pageCursor.length > 128)) {
    return fail('invalid-params', 'pageCursor 须 ≤128B 字符串')
  }
  if (preflightId !== undefined && preflightId !== null && (typeof preflightId !== 'string' || preflightId.length > 64)) {
    return fail('invalid-params', 'preflightId 须 ≤64B 字符串')
  }
  // 终态与不可提交状态
  if (batch.status === 'restored') return ok({ status: 'restored', restored: true, replayed: true })
  if (batch.status === 'verify-corruption') return fail('invalid-state', '批次已 verify-corruption（终态——须 abandon 后重开批次）')
  if (batch.status === 'abandoned' || batch.status === 'abandoning') {
    return fail('invalid-state', `${batch.status === 'abandoned' ? '已 abandoned' : 'abandoning 清理中'}——不可 commit`)
  }
  // V20 批次：commit 状态机集成属后续切片——fail-closed 明确拒（不静默走 legacy 语义）
  if (batch.v20 === true) return fail('invalid-state', 'V20 批次 commit 未支持（后续切片——本切片 fail-closed）')
  if (batch.status !== 'declared' && batch.status !== 'uploading' && batch.status !== 'verifying') {
    return fail('invalid-state', `commit 仅 declared/uploading/verifying（当前 ${batch.status}——声明索引未闭环，记录缺位不可提交）`)
  }

  // ── 阶段一：预检（declared/uploading）──
  if (batch.status === 'declared' || batch.status === 'uploading') {
    const now = Date.now()
    const pf = (batch.preflight && typeof batch.preflight === 'object' && typeof batch.preflight.preflightId === 'string') ? batch.preflight : null
    const leaseValid = !!(pf && Number.isFinite(pf.leaseExpiresAt) && pf.leaseExpiresAt > now)
    let mode // 'create' | 'resume'
    if (!pf) {
      if (preflightId !== undefined && preflightId !== null) return fail('preflight-conflict', '批次无活跃预检（首次 commit 不得携 preflightId）')
      mode = 'create'
    } else if (preflightId === pf.preflightId) {
      mode = 'resume'
    } else if (leaseValid) {
      return fail('preflight-conflict', `活跃预检 ${pf.preflightId.slice(0, 8)}… 不匹配且租约未过期（携上次响应的 preflightId 或待租约超时接管）`)
    } else {
      mode = 'create' // stale lease takeover（新 preflightId）
    }
    // 游标核对：请求 pageCursor（如提供）须与持久游标一致（首页=空串）
    const effectiveCursor = mode === 'resume' && typeof pf.cursor === 'string' ? pf.cursor : ''
    if (pageCursor !== undefined && pageCursor !== null && pageCursor !== effectiveCursor) {
      return fail('cursor-stale', `pageCursor ${idPrev(pageCursor)} ≠ 持久游标 ${idPrev(effectiveCursor)}（从上次响应游标续传）`)
    }
    const effectiveCount = mode === 'resume' && Number.isSafeInteger(pf.checkedCount) ? pf.checkedCount : 0
    const effectiveDigest = mode === 'resume' && typeof pf.checkedDigest === 'string' ? pf.checkedDigest : ''

    // 页数据（事务外派生——事务内仅 CAS 复核与批次写）
    const where = { batchId }
    if (effectiveCursor) where._id = db.command.gt(effectiveCursor)
    const snap = await db.collection(COLLECTIONS.declarations).where(where).orderBy('_id', 'asc').limit(PREFLIGHT_PAGE_SIZE + 1).get()
    const rows = (snap && snap.data) || []
    const hasMore = rows.length > PREFLIGHT_PAGE_SIZE
    const page = hasMore ? rows.slice(0, PREFLIGHT_PAGE_SIZE) : rows
    let newDigest = effectiveDigest
    for (const row of page) {
      const key = declChainKey(row)
      if (key === null) return fail('internal-error', `声明类型异常（${JSON.stringify(row.type)}——legacy 索引只写 record/file）`)
      newDigest = sha256Hex(Buffer.from(newDigest + key))
    }
    const newCount = effectiveCount + page.length
    const nextCursor = page.length ? String(page[page.length - 1]._id) : effectiveCursor

    // CAS 事务：状态/预检身份/世代复核 + 游标+计数+摘要+租约持久（或终态冻结）
    const tx = await db.startTransaction()
    let terminal = false
    let preflightState = null
    let declaredTotal = null
    try {
      const doc = await tx.collection(COLLECTIONS.batches).doc(batchId).get()
      const cur = doc.data
      if (!cur) { await tx.rollback(); return fail('batch-not-found', '批次不存在') }
      if (cur.status === 'verifying' || cur.status === 'restored') {
        // 并发已推进入验证/终态——零重复预检写；本调用以状态回应（客户端重试经状态门进入验证页）
        await tx.rollback()
        if (cur.status === 'restored') return ok({ status: 'restored', restored: true, replayed: true })
        return ok({ preflightId: preflightId || null, status: 'verifying', hasMore: true })
      }
      if (cur.status !== 'declared' && cur.status !== 'uploading') {
        await tx.rollback(); return fail('invalid-state', `状态变化（${cur.status}）`)
      }
      if (!Number.isSafeInteger(cur.indexedCount) || cur.indexedCount < 0) {
        await tx.rollback(); return fail('invalid-state', `批次 indexedCount 非法（=${cur.indexedCount}）——计数闭包无凭据`)
      }
      const curPf = (cur.preflight && typeof cur.preflight === 'object' && typeof cur.preflight.preflightId === 'string') ? cur.preflight : null
      if (mode === 'resume') {
        if (!curPf || curPf.preflightId !== pf.preflightId) { await tx.rollback(); return fail('preflight-conflict', '预检已被并发替换/接管') }
        if (curPf.cursor !== effectiveCursor) { await tx.rollback(); return fail('cursor-stale', `持久游标已被并发推进（${idPrev(curPf.cursor)}）`) }
        if (cur.contentGeneration !== curPf.startGen) {
          // 预检期间内容变化：清除预检（§5.2.1——世代漂移即证伪）+ content-changed
          const { preflight: _drop, ...rest } = stripDoc(cur)
          await tx.collection(COLLECTIONS.batches).doc(batchId).set({ data: { ...rest, updatedAt: Date.now() } })
          await tx.commit()
          return fail('content-changed', `预检期间内容变化（contentGeneration ${curPf.startGen}→${cur.contentGeneration}）——预检已清除，重新 commit 开始新预检`)
        }
      } else {
        const curLeaseValid = !!(curPf && Number.isFinite(curPf.leaseExpiresAt) && curPf.leaseExpiresAt > Date.now())
        if (curPf && curLeaseValid) { await tx.rollback(); return fail('preflight-conflict', '并发创建了活跃预检') }
      }
      const startGen = mode === 'resume' ? curPf.startGen : cur.contentGeneration
      preflightState = { preflightId: mode === 'resume' ? pf.preflightId : 'pf_' + randomBytes(16).toString('hex'),
        startGen, cursor: nextCursor, checkedCount: newCount, checkedDigest: newDigest, leaseExpiresAt: Date.now() + PREFLIGHT_LEASE_MS }
      declaredTotal = cur.indexedCount
      const updates = { preflight: preflightState, updatedAt: Date.now() }
      if (cur.status === 'declared') updates.status = 'uploading' // 零上传/零声明批次由 commit 起步推进（§5.2）
      if (!hasMore) {
        // 末页：计数闭包（0=0 含零声明空包）——不等即 index-mismatch（零写不冻结）
        if (newCount !== cur.indexedCount) {
          await tx.rollback()
          return fail('index-mismatch', `预检计数 ${newCount} ≠ 声明总数 ${cur.indexedCount}（fail-stop——不冻结）`)
        }
        terminal = true
        updates.status = 'verifying'
        updates.proofComplete = true
        updates.provenGeneration = startGen
        updates.vf = { after: '', rid: null, ci: 0 } // 验证游标复位
      }
      await tx.collection(COLLECTIONS.batches).doc(batchId).set({ data: { ...stripDoc(cur), ...updates } })
      await tx.commit()
    } catch (e) { await tx.rollback(); throw e }
    if (terminal) return await commitVerifyPhase(db, batchId, preflightState.preflightId) // 同调用级联进入验证（空包/单页批次一调到底）
    return ok({ preflightId: preflightState.preflightId, status: 'uploading', phase: 'preflight',
      checkedCount: newCount, declaredTotal,
      hasMore: true, nextCursor })
  }

  // ── 阶段二：验证（verifying——或上方级联进入）──
  return await commitVerifyPhase(db, batchId, (batch.preflight && typeof batch.preflight.preflightId === 'string') ? batch.preflight.preflightId : null)
}

// ── commit 验证阶段：分页复验 mc_restore_records（服务端持久游标 vf）──
async function commitVerifyPhase(db, batchId, preflightId) {
  const batch = await getDocMaybe(db, COLLECTIONS.batches, batchId)
  if (!batch) return fail('batch-not-found', '批次不存在')
  const vf = (batch.vf && typeof batch.vf === 'object') ? batch.vf : { after: '', rid: null, ci: 0 }
  let after = typeof vf.after === 'string' ? vf.after : ''
  const resumeRid = typeof vf.rid === 'string' ? vf.rid : null
  const resumeCi = Number.isSafeInteger(vf.ci) ? vf.ci : 0
  const where = { batchId }
  if (after) where._id = db.command.gt(after)
  const snap = await db.collection(COLLECTIONS.records).where(where).orderBy('_id', 'asc').limit(VERIFY_PAGE_ITEMS).get()
  const rows = (snap && snap.data) || []
  let bytes = 0
  let processed = 0
  let lastAfter = after
  let stopRid = null, stopCi = 0
  let corruption = null
  for (const row of rows) {
    const startCi = (resumeRid && row._id === resumeRid) ? resumeCi : 0
    // 页预算门（内联预估——分片由 verifyRecordDoc 内部逐 chunk 截断；首页首条恒处理=进展保证）
    if (processed > 0 && row.isChunked !== true && bytes + (Number.isSafeInteger(row.byteLength) ? row.byteLength : 0) > VERIFY_PAGE_BYTES) {
      stopRid = row._id; stopCi = 0 // 延后整条到下页（内联记录）
      break
    }
    const v = await verifyRecordDoc(db, row, startCi, VERIFY_PAGE_BYTES - bytes)
    processed++
    if (!v.ok) { corruption = v; break }
    bytes += v.bytes
    if (v.stopCi !== null && v.stopCi !== undefined) { stopRid = row._id; stopCi = v.stopCi; break }
    lastAfter = String(row._id)
  }
  if (corruption) {
    // 终态化：verify-corruption（持久化失败码——commit 有状态语义，§5.1）
    const detail = `${corruption.code}: ${corruption.detail}`
    const tx = await db.startTransaction()
    try {
      const doc = await tx.collection(COLLECTIONS.batches).doc(batchId).get()
      const cur = doc.data
      if (!cur) { await tx.rollback(); return fail('batch-not-found', '批次不存在') }
      if (cur.status === 'restored') { await tx.rollback(); return ok({ preflightId, status: 'restored', restored: true, replayed: true }) }
      if (cur.status !== 'verifying') { await tx.rollback(); return fail('invalid-state', `状态变化（${cur.status}）`) }
      await tx.collection(COLLECTIONS.batches).doc(batchId).set({
        data: { ...stripDoc(cur), status: 'verify-corruption', verifyFailure: { code: corruption.code, detail: String(detail).slice(0, 200), at: Date.now() }, updatedAt: Date.now() }
      })
      await tx.commit()
    } catch (e) { await tx.rollback(); throw e }
    return fail('verify-corruption', detail)
  }
  if (stopRid !== null) {
    const tx = await db.startTransaction()
    try {
      const doc = await tx.collection(COLLECTIONS.batches).doc(batchId).get()
      const cur = doc.data
      if (!cur || cur.status !== 'verifying') { await tx.rollback(); return fail('invalid-state', `状态变化（${cur ? cur.status : 'gone'}）`) }
      await tx.collection(COLLECTIONS.batches).doc(batchId).set({
        data: { ...stripDoc(cur), vf: { after: lastAfter, rid: stopRid, ci: stopCi }, updatedAt: Date.now() }
      })
      await tx.commit()
    } catch (e) { await tx.rollback(); throw e }
    return ok({ preflightId, status: 'verifying', hasMore: true, nextCursor: lastAfter })
  }
  if (rows.length === VERIFY_PAGE_ITEMS) {
    // 页满（预算未截断）——保守续页（下页查询从 lastAfter 起；恰末页时下页零行即 restored）
    const tx = await db.startTransaction()
    try {
      const doc = await tx.collection(COLLECTIONS.batches).doc(batchId).get()
      const cur = doc.data
      if (!cur || cur.status !== 'verifying') { await tx.rollback(); return fail('invalid-state', `状态变化（${cur ? cur.status : 'gone'}）`) }
      await tx.collection(COLLECTIONS.batches).doc(batchId).set({
        data: { ...stripDoc(cur), vf: { after: lastAfter, rid: null, ci: 0 }, updatedAt: Date.now() }
      })
      await tx.commit()
    } catch (e) { await tx.rollback(); throw e }
    return ok({ preflightId, status: 'verifying', hasMore: true, nextCursor: lastAfter })
  }
  // 全部验毕 → 原子终态 restored
  const tx = await db.startTransaction()
  try {
    const doc = await tx.collection(COLLECTIONS.batches).doc(batchId).get()
    const cur = doc.data
    if (!cur) { await tx.rollback(); return fail('batch-not-found', '批次不存在') }
    if (cur.status === 'restored') { await tx.rollback(); return ok({ preflightId, status: 'restored', restored: true, replayed: true }) }
    if (cur.status !== 'verifying') { await tx.rollback(); return fail('invalid-state', `状态变化（${cur.status}）`) }
    if (cur.proofComplete !== true || cur.provenGeneration !== cur.contentGeneration) {
      await tx.rollback(); return fail('invalid-state', '冻结证明失效（proofComplete/provenGeneration 与世代不符）')
    }
    await tx.collection(COLLECTIONS.batches).doc(batchId).set({
      data: { ...stripDoc(cur), status: 'restored', restoredAt: Date.now(), updatedAt: Date.now() }
    })
    await tx.commit()
  } catch (e) { await tx.rollback(); throw e }
  return ok({ preflightId, status: 'restored', restored: true })
}

// ── restore.verify：真只读复验（零服务端写——批次文档 __v 严格不变；无任何 set/事务）──
// 游标（§5.1 三类之子集）：{kind:'record', after} | {kind:'record-chunk', domain, index, chunkIndex, after}。
// 腐蚀仅在响应 errors[] 报告（持久化语义专属 commit verifying——standalone 由客户端 UI 呈现）。
async function handleVerify(cloud, config, caller, event) {
  const db = cloud.database()
  const { batchId, pageCursor } = event
  const { batch, err } = await getOwnedBatch(db, batchId, caller, config)
  if (err) return err
  let after = '', rid = null, ci = 0
  if (pageCursor !== undefined && pageCursor !== null) {
    if (typeof pageCursor !== 'object' || Array.isArray(pageCursor)) return fail('invalid-params', 'pageCursor 须游标对象')
    if (pageCursor.kind === 'record') {
      if (pageCursor.after !== undefined && pageCursor.after !== null && typeof pageCursor.after !== 'string') return fail('invalid-params', 'record 游标 after 须字符串')
      after = typeof pageCursor.after === 'string' ? pageCursor.after : ''
    } else if (pageCursor.kind === 'record-chunk') {
      if (!SUPPORTED_DOMAINS.includes(pageCursor.domain) || !Number.isInteger(pageCursor.index) || !Number.isInteger(pageCursor.chunkIndex) || pageCursor.chunkIndex < 0) {
        return fail('invalid-params', 'record-chunk 游标字段非法')
      }
      rid = `${batchId}:${pageCursor.domain}:${pageCursor.index}`
      ci = pageCursor.chunkIndex
      after = typeof pageCursor.after === 'string' ? pageCursor.after : ''
      if (after && after >= rid) return fail('invalid-params', 'record-chunk 游标 after 须先于所指记录')
    } else {
      return fail('invalid-params', `pageCursor.kind 非法（${idPrev(pageCursor.kind)}——须 record|record-chunk）`)
    }
  }
  const where = { batchId }
  if (after) where._id = db.command.gt(after)
  const snap = await db.collection(COLLECTIONS.records).where(where).orderBy('_id', 'asc').limit(VERIFY_PAGE_ITEMS).get()
  const rows = (snap && snap.data) || []
  const errors = []
  let bytes = 0, checked = 0
  let nextCursor = null, hasMore = false
  for (const row of rows) {
    const startCi = (rid && row._id === rid) ? ci : 0
    if (checked > 0 && row.isChunked !== true && bytes + (Number.isSafeInteger(row.byteLength) ? row.byteLength : 0) > VERIFY_PAGE_BYTES) {
      nextCursor = { kind: 'record', after }; hasMore = true; break // 内联记录延后到下页
    }
    const v = await verifyRecordDoc(db, row, startCi, VERIFY_PAGE_BYTES - bytes)
    checked++
    if (!v.ok) errors.push({ record: String(row._id), domain: row.domain, index: row.index, error: v.code })
    else bytes += v.bytes
    if (v.stopCi !== null && v.stopCi !== undefined) {
      nextCursor = { kind: 'record-chunk', domain: row.domain, index: row.index, chunkIndex: v.stopCi, after }; hasMore = true; break
    }
    after = String(row._id)
  }
  if (!hasMore && rows.length === VERIFY_PAGE_ITEMS) { hasMore = true; nextCursor = { kind: 'record', after } }
  return ok({ status: batch.status, checked, errors, ...(nextCursor ? { nextCursor } : {}), hasMore })
}

// ── restore.abandon：owner-only 弃批（非 restored 可弃；abandoning 计入活跃上限）──
// CAS 置 abandoning → 分页清理（键空间前缀游标——V20 薄指针/块文档无 batchId 字段也可定位）→
// 全部清净后同事务置终态 abandoned + 释放 slotLock（activeBatchIds 摘除本批次）。
// mc_files 引用摘除：attachFile 未实现（mc_restore_files/mc_files 无恢复侧写入方）——无引用可摘，
// 属后续切片接线点（如实声明，不虚占事务组）。
async function handleAbandon(cloud, config, caller, event) {
  const db = cloud.database()
  const { batchId } = event
  const { batch, err } = await getOwnedBatch(db, batchId, caller, config)
  if (err) return err
  if (batch.status === 'restored') return fail('already-restored', 'restored 批次不可 abandon（隔离记录/chunk 永久保留）')
  if (batch.status === 'abandoned') return ok({ status: 'abandoned', replayed: true })
  if (batch.status !== 'abandoning') {
    const tx = await db.startTransaction()
    try {
      const doc = await tx.collection(COLLECTIONS.batches).doc(batchId).get()
      const cur = doc.data
      if (!cur) { await tx.rollback(); return fail('batch-not-found', '批次不存在') }
      if (cur.status === 'restored') { await tx.rollback(); return fail('already-restored', 'restored 批次不可 abandon') }
      if (cur.status === 'abandoned') { await tx.rollback(); return ok({ status: 'abandoned', replayed: true }) }
      await tx.collection(COLLECTIONS.batches).doc(batchId).set({
        data: { ...stripDoc(cur), status: 'abandoning', abandon: null, updatedAt: Date.now() }
      })
      await tx.commit()
    } catch (e) { await tx.rollback(); throw e }
  }
  // 分页清理（resumable：批次文档 abandon={col, after}——崩溃/中断续清）
  const fresh = await getDocMaybe(db, COLLECTIONS.batches, batchId)
  if (!fresh) return fail('batch-not-found', '批次不存在')
  const cursor = (fresh.abandon && typeof fresh.abandon === 'object') ? fresh.abandon : null
  let colIdx = cursor && ABANDON_COLS.includes(cursor.col) ? ABANDON_COLS.indexOf(cursor.col) : 0
  let after = cursor && typeof cursor.after === 'string' ? cursor.after : ''
  const prefix = `${batchId}:`
  const hi = `${batchId}:\uffff` // 本批次键空间上界（_id 升序越界即该集合清净）
  let deleted = 0
  while (colIdx < ABANDON_COLS.length) {
    const col = ABANDON_COLS[colIdx]
    const where = {}
    if (after) where._id = db.command.gt(after)
    const snap = await db.collection(col).where(where).orderBy('_id', 'asc').limit(ABANDON_PAGE_DOCS).get()
    const rows = (snap && snap.data) || []
    if (!rows.length || String(rows[0]._id) > hi) { colIdx++; after = ''; continue } // 该集合无本批次残留
    const mine = rows.filter(r => String(r._id).startsWith(prefix))
    if (mine.length) {
      const tx = await db.startTransaction()
      try {
        // 事务内复核批次仍 abandoning（并发终态化→中止清理——零误删）
        const bdoc = await tx.collection(COLLECTIONS.batches).doc(batchId).get()
        const cur = bdoc.data
        if (!cur || cur.status !== 'abandoning') { await tx.rollback(); return fail('invalid-state', `批次状态变化（${cur ? cur.status : 'gone'}）——清理中止`) }
        for (const r of mine) await tx.collection(col).doc(String(r._id)).remove()
        await tx.collection(COLLECTIONS.batches).doc(batchId).set({
          data: { ...stripDoc(cur), abandon: { col, after: String(rows[rows.length - 1]._id) }, updatedAt: Date.now() }
        })
        await tx.commit()
      } catch (e) { await tx.rollback(); throw e }
      deleted += mine.length
      if (deleted >= ABANDON_PAGE_DOCS * ABANDON_TX_GROUPS) {
        return ok({ status: 'abandoning', hasMore: true, nextCursor: String(rows[rows.length - 1]._id), collection: col, deleted })
      }
    }
    after = String(rows[rows.length - 1]._id) // 本页无本批次文档——内存推进（崩溃重扫无害）
  }
  // 全部集合清净 → 同事务终态 abandoned + 释放 slotLock
  const tx = await db.startTransaction()
  try {
    const bdoc = await tx.collection(COLLECTIONS.batches).doc(batchId).get()
    const cur = bdoc.data
    if (!cur) { await tx.rollback(); return fail('batch-not-found', '批次不存在') }
    if (cur.status === 'abandoned') { await tx.rollback(); return ok({ status: 'abandoned', replayed: true }) }
    if (cur.status !== 'abandoning') { await tx.rollback(); return fail('invalid-state', `批次状态变化（${cur.status}）`) }
    const slotLockId = `slotlock:${cur.ownerMemberId}`
    const lockDoc = await tx.collection(COLLECTIONS.slotLocks).doc(slotLockId).get()
    if (lockDoc.data) {
      const ids = Array.isArray(lockDoc.data.activeBatchIds)
        ? lockDoc.data.activeBatchIds.filter(x => typeof x === 'string' && x !== batchId) : []
      await tx.collection(COLLECTIONS.slotLocks).doc(slotLockId).set({
        data: { ...stripDoc(lockDoc.data), activeBatchIds: ids, updatedAt: Date.now() }
      })
    }
    await tx.collection(COLLECTIONS.batches).doc(batchId).set({
      data: { ...stripDoc(cur), status: 'abandoned', abandon: null, abandonedAt: Date.now(), updatedAt: Date.now() }
    })
    await tx.commit()
  } catch (e) { await tx.rollback(); throw e }
  return ok({ status: 'abandoned', abandoned: true })
}
