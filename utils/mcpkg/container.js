// B3b codec：.mcpkg 容器（formatVersion=1）布局、上限、§2.6 校验（设计 §2）。
// 全部读取经 reader 抽象按 64KiB 分块（writeFile/appendFile/readFile(position,length) 适配器
// 或 H5 File.slice 适配器）——禁止整包/整段读取。
// 无 totalSizeBytes 字段：验证器由 头24B+manifestLen+ΣentryLen 与实际 EOF 独立推导（自指问题，
// rev5 复审裁定删除）。packageDigest 覆盖 magic..EOF，不写回 manifest。
import { createHash } from './sha256.js'
import { decodeStrict, assertNoLoneSurrogatesDeep } from './utf8.js'
import { canonicalJsonBytes as serializeManifest } from './canonical.js'

export const MAGIC = new Uint8Array([0x4d, 0x4f, 0x4d, 0x43, 0x50, 0x4b, 0x47, 0x00]) // "MOMCPKG\0"
export const HEADER_LEN = 24
export const FORMAT_VERSION = 1

export const SUPPORTED_DOMAINS = ['pregnancy', 'daily', 'mood', 'checkup', 'bag', 'reports']

export const LIMITS = {
  MAX_PKG_BYTES: 64 * 1024 * 1024,
  MAX_MANIFEST_BYTES: 4 * 1024 * 1024,
  MAX_FILES: 500,
  MAX_ATTACHMENT_BYTES: 10 * 1024 * 1024,
  MAX_DOMAIN_JSON_BYTES: 4 * 1024 * 1024,
  MAX_RECORDS: 10000,
  CHUNK_BYTES: 64 * 1024,
  VERIFY_BLOCK: 256 * 1024, // 附件字节复验块（阶段二恢复侧使用；导出端生成 chunkSha256）
  MAX_REQUEST_JSON: 64 * 1024,
  MAX_RESPONSE_JSON: 256 * 1024
}

export class ContainerError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export function encodeHeader(manifestLen) {
  const h = new Uint8Array(HEADER_LEN)
  h.set(MAGIC, 0)
  const dv = new DataView(h.buffer)
  dv.setUint32(8, FORMAT_VERSION)
  dv.setUint32(12, 0) // reserved
  dv.setUint32(16, Math.floor(manifestLen / 0x100000000))
  dv.setUint32(20, manifestLen >>> 0)
  return h
}

export function parseHeader(headBytes) {
  if (!(headBytes instanceof Uint8Array) || headBytes.length !== HEADER_LEN) {
    throw new ContainerError('invalid-header', '头部长度非 24 字节')
  }
  for (let i = 0; i < 8; i++) {
    if (headBytes[i] !== MAGIC[i]) throw new ContainerError('bad-magic', 'magic 不符')
  }
  const dv = new DataView(headBytes.buffer, headBytes.byteOffset, 24)
  const version = dv.getUint32(8)
  if (version !== FORMAT_VERSION) throw new ContainerError('unsupported-version', `version=${version}（须精确 ===1）`)
  const reserved = dv.getUint32(12)
  if (reserved !== 0) throw new ContainerError('invalid-header', 'reserved 非 0')
  const hi = dv.getUint32(16), lo = dv.getUint32(20)
  if (hi !== 0) throw new ContainerError('invalid-header', 'manifestLen 超出安全整数')
  const manifestLen = lo
  if (!Number.isSafeInteger(manifestLen)) throw new ContainerError('invalid-header', 'manifestLen 非安全整数')
  return { manifestLen }
}

// reader 契约：{ size(): Promise<number>, readChunk(position, length): Promise<Uint8Array> }

export async function readChunked(reader, position, length, onChunk) {
  let offset = position
  const end = position + length
  while (offset < end) {
    const n = Math.min(LIMITS.CHUNK_BYTES, end - offset)
    const chunk = await reader.readChunk(offset, n)
    if (!(chunk instanceof Uint8Array) || chunk.length !== n) {
      throw new ContainerError('short-read', `读取 @${offset} 期望 ${n} 字节得到 ${chunk && chunk.length}`)
    }
    if (onChunk) onChunk(chunk)
    offset += n
  }
}

// 逐段/逐块读并计算 sha256（不整段驻留）
export async function hashRange(reader, position, length) {
  const hash = createHash()
  await readChunked(reader, position, length, c => hash.update(c))
  return hash.digest()
}

// §2.6 manifest 结构校验（不读文件字节；文件字节由 validatePackage 校验）
export function validateManifest(manifest, manifestLen) {
  const problems = []
  const fail = (code, msg) => problems.push({ code, message: msg })
  if (!manifest || typeof manifest !== 'object') { fail('invalid-manifest', 'manifest 非对象'); return problems }
  // 解析后递归字符串检查（第二层孤立代理检测，含 ASCII 转义来源）
  try { assertNoLoneSurrogatesDeep(manifest) } catch (e) { fail(e.code || 'malformed-surrogate', e.message) }
  if (manifest.formatVersion !== FORMAT_VERSION) fail('unsupported-version', 'manifest.formatVersion 须精确 ===1')
  const kind = manifest.packageKind
  if (kind !== 'full' && kind !== 'diagnostic') fail('invalid-manifest', 'packageKind 须 full|diagnostic')
  const domains = manifest.domains || {}
  const files = manifest.files
  if (!Array.isArray(files)) { fail('invalid-manifest', 'files 非数组'); return problems }
  if (files.length > LIMITS.MAX_FILES) fail('limit-exceeded', `文件数 ${files.length} > ${LIMITS.MAX_FILES}`)
  const seenPaths = new Set()
  const seenOriginalFileIds = new Set()
  let totalFilesBytes = 0
  files.forEach((f, i) => {
    if (!f || typeof f !== 'object') { fail('invalid-file-entry', `files[${i}] 非对象`); return }
    if (typeof f.path !== 'string' || !f.path || f.path.startsWith('/') || f.path.includes('..') || f.path.includes('\\')) {
      fail('invalid-path', `files[${i}].path 非法：${f.path}`)
    } else if (seenPaths.has(f.path)) fail('duplicate-path', `重复路径 ${f.path}`)
    else seenPaths.add(f.path)
    if (f.originalFileId) {
      if (seenOriginalFileIds.has(f.originalFileId)) fail('duplicate-original-file-id', `重复 originalFileId ${f.originalFileId}`)
      seenOriginalFileIds.add(f.originalFileId)
    }
    if (!['domain-json', 'attachment'].includes(f.kind)) {
      fail('invalid-file-kind', `files[${i}].kind='${f.kind}' 未知（须 domain-json|attachment）`)
    }
    const cap = f.kind === 'attachment' ? LIMITS.MAX_ATTACHMENT_BYTES : LIMITS.MAX_DOMAIN_JSON_BYTES
    if (!Number.isSafeInteger(f.length) || f.length < 0 || f.length > cap) {
      fail('limit-exceeded', `files[${i}].length=${f.length} 超界（kind=${f.kind} 上限 ${cap}）`)
    }
    if (!/^[0-9a-f]{64}$/.test(String(f.sha256 || ''))) fail('invalid-hash', `files[${i}].sha256 非 64 hex 小写`)
    if (!['application/json', 'image/png', 'image/jpeg'].includes(f.contentType)) fail('invalid-content-type', `files[${i}].contentType 非法`)
    if (f.kind === 'attachment') {
      // 附件块承诺必填（阶段二恢复侧复验凭据；缺失不得 ok）
      if (!Array.isArray(f.chunkSha256) || f.chunkSha256.length === 0) {
        if (f.length > 0) fail('invalid-chunk-hashes', `files[${i}] 附件缺 chunkSha256 块承诺`)
      } else {
        const expectBlocks = Math.max(1, Math.ceil((f.length || 0) / LIMITS.VERIFY_BLOCK))
        if (f.chunkSha256.length !== expectBlocks) fail('invalid-chunk-hashes', `files[${i}] chunkSha256 块数 ${f.chunkSha256.length} ≠ ${expectBlocks}`)
      }
    }
    totalFilesBytes += Number.isSafeInteger(f.length) ? f.length : 0
  })
  // 推导总长（无 totalSizeBytes 字段——独立推导并要求与实际一致，实际值由 validatePackage 核对）
  const derivedTotal = HEADER_LEN + manifestLen + 8 * files.length + totalFilesBytes
  if (derivedTotal > LIMITS.MAX_PKG_BYTES) fail('limit-exceeded', `推导包总长 ${derivedTotal} > 64MiB`)
  // 三态域自洽 + 全部受支持域必须显式出现（未知域拒绝）
  const scope = manifest.scope || {}
  for (const d of SUPPORTED_DOMAINS) {
    if (!domains[d]) fail('missing-domain', `受支持域 ${d} 未显式声明（present/omitted/missing 三选一）`)
  }
  for (const domain of Object.keys(domains)) {
    if (!SUPPORTED_DOMAINS.includes(domain)) fail('unknown-domain', `未知域 ${domain}`)
  }
  for (const [domain, entry] of Object.entries(domains)) {
    if (!entry || typeof entry !== 'object') { fail('invalid-domain', `domains.${domain} 非对象`); continue }
    if (entry.status === 'present') {
      if (!Number.isInteger(entry.fileIndex) || entry.fileIndex < 0 || entry.fileIndex >= files.length) {
        fail('invalid-domain', `domains.${domain}.fileIndex 越界`)
      }
      if (!Number.isInteger(entry.recordCount) || entry.recordCount < 0) fail('invalid-domain', `domains.${domain}.recordCount 非法`)
      if (typeof entry.pagingComplete !== 'boolean') fail('invalid-domain', `domains.${domain}.pagingComplete 缺失`)
      if (!['shared', 'private'].includes(entry.visibility)) fail('invalid-domain', `domains.${domain}.visibility 非法`)
    } else if (entry.status === 'omitted') {
      if (entry.fileIndex !== undefined) fail('invalid-domain', `omitted 域 ${domain} 不得有 fileIndex`)
    } else if (entry.status === 'missing') {
      if (entry.fileIndex !== undefined) fail('invalid-domain', `missing 域 ${domain} 不得有 fileIndex`)
      if (!['read-failed', 'unsupported-schema'].includes(entry.reason)) fail('invalid-domain', `missing 域 ${domain} reason 非法`)
    } else {
      fail('invalid-domain', `domains.${domain}.status 非法`)
    }
  }
  // reports 映射闭合
  const reports = manifest.reports
  if (!Array.isArray(reports)) fail('invalid-manifest', 'reports 非数组')
  else {
    const seenReportOrder = new Set()
    for (const r of reports) {
      if (!r || typeof r.reportId !== 'string' || !r.reportId) { fail('invalid-report', 'reportId 缺失'); continue }
      const atts = Array.isArray(r.attachments) ? r.attachments : []
      if (r.deleted && atts.length > 0) fail('tombstone-with-attachments', `已删报告 ${r.reportId} 必须 attachments=[]`)
      atts.forEach(a => {
        const key = `${r.reportId}:${a.order}`
        if (seenReportOrder.has(key)) fail('duplicate-report-order', `重复 (reportId,order) ${key}`)
        seenReportOrder.add(key)
        const f = files[a.fileIndex]
        if (!f || f.kind !== 'attachment') fail('invalid-mapping', `${key} fileIndex 无效或非附件段`)
        else if (!Array.isArray(f.referencedBy) || !f.referencedBy.includes(r.reportId)) {
          fail('invalid-mapping', `附件段 ${a.fileIndex} 缺少 referencedBy ${r.reportId}`)
        }
      })
    }
  }
  // 逐记录声明
  const records = manifest.records || {}
  let totalRecords = 0
  for (const [domain, list] of Object.entries(records)) {
    if (!Array.isArray(list)) { fail('invalid-records', `records.${domain} 非数组`); continue }
    totalRecords += list.length
    const entry = domains[domain]
    if (entry && entry.status === 'present' && entry.recordCount !== list.length) {
      fail('invalid-records', `records.${domain} 数量 ${list.length} ≠ domains.${domain}.recordCount`)
    }
    const seenIds = new Set()
    list.forEach(decl => {
      if (!decl || !Number.isInteger(decl.index) || typeof decl.id !== 'string' || !/^[0-9a-f]{64}$/.test(String(decl.hash || ''))) {
        fail('invalid-records', `records.${domain} 声明项非法`)
        return
      }
      if (seenIds.has(decl.id)) fail('duplicate-record-id', `域 ${domain} 重复记录 ID ${decl.id}`)
      seenIds.add(decl.id)
    })
  }
  if (totalRecords > LIMITS.MAX_RECORDS) fail('limit-exceeded', `记录总数 ${totalRecords} > ${LIMITS.MAX_RECORDS}`)
  // omitted/missing 域不得携带 records 声明（自洽重算）
  for (const [domain, entry] of Object.entries(domains)) {
    if (entry && entry.status !== 'present' && Array.isArray((manifest.records || {})[domain]) && (manifest.records[domain] || []).length > 0) {
      fail('invalid-records', `域 ${domain} 为 ${entry.status} 但携带 records 声明`)
    }
  }
  // reports[].deleted/revision 与 records.reports 正文交叉校验（自洽重算）
  {
    const reportsDecls = Array.isArray(manifest.reports) ? manifest.reports : []
    const reportsRecords = ((manifest.records || {}).reports) || []
    const byId = new Map(reportsRecords.map(d => [String(d.id), d]))
    for (const rd of reportsDecls) {
      const decl = byId.get(String(rd.reportId))
      if (!decl) { fail('invalid-mapping', `reports 映射 ${rd.reportId} 无对应 records 声明`); continue }
      if (Boolean(rd.deleted) !== Boolean(decl.deleted)) fail('declaration-mismatch', `reports ${rd.reportId} deleted=${rd.deleted} 与正文 ${decl.deleted} 不一致`)
      if (Number(rd.revision) !== Number(decl.revision)) fail('declaration-mismatch', `reports ${rd.reportId} revision=${rd.revision} 与正文 ${decl.revision} 不一致`)
    }
    // 反向引用精确闭包（M5+评审）：三重检查
    // ① mapping.originalFileId === files[fileIndex].originalFileId（映射↔文件身份一致）
    // ② 附件段空 referencedBy 拒绝（孤儿段）
    // ③ 集合闭包：files[i].referencedBy 集合 ≡ 引用该 fileIndex 的映射 reportId 集合（双向）
    const reportIds = new Set(reportsDecls.map(rd => rd.reportId))
    // 正向：mapping → file 身份一致
    for (const rd of reportsDecls) {
      for (const a of (Array.isArray(rd.attachments) ? rd.attachments : [])) {
        const f = files[a.fileIndex]
        if (f && f.kind === 'attachment') {
          if (String(f.originalFileId || '') !== String(a.originalFileId || '')) {
            fail('report-mapping-mismatch', `reports ${rd.reportId} 附件 order=${a.order} originalFileId=${a.originalFileId} ≠ files[${a.fileIndex}].originalFileId=${f.originalFileId}`)
          }
        }
      }
    }
    // 附件段空引用 + 集合闭包
    const expectedRefs = new Map() // fileIndex → Set<reportId>
    for (const rd of reportsDecls) {
      for (const a of (Array.isArray(rd.attachments) ? rd.attachments : [])) {
        if (!expectedRefs.has(a.fileIndex)) expectedRefs.set(a.fileIndex, new Set())
        expectedRefs.get(a.fileIndex).add(rd.reportId)
      }
    }
    files.forEach((f, i) => {
      if (!f || f.kind !== 'attachment') return
      const refs = Array.isArray(f.referencedBy) ? f.referencedBy : []
      if (f.length > 0 && refs.length === 0) {
        fail('report-mapping-mismatch', `files[${i}] 附件段 referencedBy 为空（孤儿段——无任何映射引用）`)
        return
      }
      const expected = expectedRefs.get(i) || new Set()
      const actual = new Set(refs)
      for (const rid of actual) {
        if (!reportIds.has(rid)) { fail('invalid-mapping', `files[${i}].referencedBy 含不存在报告 ${rid}`); continue }
        if (!expected.has(rid)) fail('report-mapping-mismatch', `files[${i}].referencedBy 含报告 ${rid} 但其映射不含此 fileIndex（多余反向引用）`)
      }
      for (const rid of expected) {
        if (!actual.has(rid)) fail('report-mapping-mismatch', `files[${i}] 附件段缺少 referencedBy ${rid}（映射引用了此段但 referencedBy 未含该报告）`)
      }
    })
  }
  // pending/complete 自洽（omitted 域不计 reason）
  const pending = manifest.pending || {}
  const pendingNonEmpty = Object.values(pending).some(v => Array.isArray(v) && v.length > 0)
  const anyMissing = Object.values(domains).some(e => e && e.status === 'missing')
  const allPagingComplete = Object.values(domains).every(e => !e || e.status !== 'present' || e.pagingComplete)
  if (manifest.complete === true && (pendingNonEmpty || anyMissing || !allPagingComplete)) {
    fail('incoherent-complete', 'complete=true 与 pending/missing/分页未完成 自相矛盾')
  }
  if (manifest.complete === true && pending.indeterminate === true) {
    fail('incoherent-complete', 'complete=true 与 pending.indeterminate 自相矛盾')
  }
  if (kind === 'diagnostic' && manifest.complete === true) {
    fail('incoherent-kind', "packageKind='diagnostic' 不得 complete=true")
  }
  if (manifest.complete !== true && kind === 'full') {
    // full 包必须 complete=true（否则应为 diagnostic）
    fail('incoherent-kind', "packageKind='full' 须 complete=true")
  }
  if (manifest.complete !== true && (!Array.isArray(manifest.incompleteReasons) || manifest.incompleteReasons.length === 0)) {
    fail('incoherent-complete', 'complete=false 须有非空 incompleteReasons')
  }
  return problems
}

// 整包校验：头 → manifest（分块读+严格解码+解析+递归字符串检查）→ 结构校验 →
// 逐文件段分块 SHA256 比对（含 chunkSha256 块级）→ 推导总长与实际 EOF 一致 → packageDigest
export async function validatePackage(reader) {
  const size = await reader.size()
  if (size < HEADER_LEN) throw new ContainerError('invalid-header', `文件过小 ${size}`)
  // 尺寸 fail-stop：超上限立即拒绝，不进入任何分块读取/哈希（H5 大文件不整读）
  if (size > LIMITS.MAX_PKG_BYTES) {
    throw new ContainerError('limit-exceeded', `包总长 ${size} > ${LIMITS.MAX_PKG_BYTES}（64MiB）——拒绝且不读取任何分块`)
  }
  const head = await reader.readChunk(0, HEADER_LEN)
  const { manifestLen } = parseHeader(head)
  if (manifestLen > LIMITS.MAX_MANIFEST_BYTES) throw new ContainerError('limit-exceeded', `manifestLen ${manifestLen} > 4MiB`)
  const manifestEnd = HEADER_LEN + manifestLen
  if (manifestEnd > size) throw new ContainerError('invalid-header', 'manifest 越界（短读）')
  // manifest 原始字节分块读取 + 摘要
  const manifestHash = createHash()
  const manifestChunks = []
  await readChunked(reader, HEADER_LEN, manifestLen, c => { manifestHash.update(c); manifestChunks.push(c) })
  const manifestDigest = manifestHash.digest()
  const manifestBytesAll = new Uint8Array(manifestLen)
  let off = 0
  for (const c of manifestChunks) { manifestBytesAll.set(c, off); off += c.length }
  let manifest
  try {
    manifest = JSON.parse(decodeStrict(manifestBytesAll))
  } catch (e) {
    throw new ContainerError(e.code || 'invalid-manifest', `manifest 解析失败：${e.message}`)
  }
  const filesArr = Array.isArray(manifest.files) ? manifest.files : []
  if (filesArr.length === 0 && manifestEnd !== size) {
    throw new ContainerError('trailing-bytes', `零文件包 manifest 后有多余字节（${size - manifestEnd}）`)
  }
  if (filesArr.length > 0 && manifestEnd + 8 > size) {
    throw new ContainerError('invalid-header', 'manifest 越界（首段长度前缀短读）')
  }
  const problems = validateManifest(manifest, manifestLen)
  // manifest 原始字节必须恰为规范字节（防"同内容非规范编码"包）：重算比对
  {
    let recomputed = null
    try { recomputed = serializeManifest(manifest) } catch (e) { problems.push({ code: 'manifest-not-canonical', message: 'manifest 规范化失败：' + e.message }) }
    if (recomputed) {
      // 长度不等即非规范（重算长度≠原始长度——原实现此处只跳过比对不报）
      if (recomputed.length !== manifestLen) {
        problems.push({ code: 'manifest-not-canonical', message: `manifest 长度 ${manifestLen} ≠ 规范重算 ${recomputed.length}（键序/空白非法）` })
      } else {
        for (let i = 0; i < manifestLen; i++) {
          if (recomputed[i] !== manifestBytesAll[i]) { problems.push({ code: 'manifest-not-canonical', message: `manifest 字节 @${i} 非规范编码` }); break }
        }
      }
    }
  }
  // 逐文件段：偏移按序计算；分块 SHA256；推导总长
  const files = Array.isArray(manifest.files) ? manifest.files : []
  let cursor = manifestEnd
  const fileResults = []
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    const lenPrefix = await reader.readChunk(cursor, 8)
    const dv = new DataView(lenPrefix.buffer, lenPrefix.byteOffset, 8)
    const hi = dv.getUint32(0), lo = dv.getUint32(4)
    if (hi !== 0) { problems.push({ code: 'invalid-entry-len', message: `files[${i}] entryLen 超安全整数` }); break }
    const entryLen = lo
    if (entryLen !== f.length) problems.push({ code: 'length-mismatch', message: `files[${i}] entryLen ${entryLen} ≠ 声明 ${f.length}` })
    cursor += 8
    const segStart = cursor
    cursor += entryLen
    if (cursor > size) { problems.push({ code: 'out-of-bounds', message: `files[${i}] 段越界` }); break }
    const actual = await hashRange(reader, segStart, entryLen)
    if (actual !== f.sha256) problems.push({ code: 'hash-mismatch', message: `files[${i}] SHA256 不符（${actual} ≠ ${f.sha256}）` })
    if (f.kind === 'attachment' && Array.isArray(f.chunkSha256)) {
      for (let b = 0; b * LIMITS.VERIFY_BLOCK < entryLen; b++) {
        const bStart = segStart + b * LIMITS.VERIFY_BLOCK
        const bLen = Math.min(LIMITS.VERIFY_BLOCK, entryLen - b * LIMITS.VERIFY_BLOCK)
        const bh = await hashRange(reader, bStart, bLen)
        if (bh !== f.chunkSha256[b]) problems.push({ code: 'chunk-hash-mismatch', message: `files[${i}] 块 ${b} 摘要不符` })
      }
    }
    fileResults.push({ index: i, sha256: actual, declaredSha256: f.sha256, segStart })
  }
  if (cursor !== size) problems.push({ code: 'trailing-bytes', message: `推导终点 ${cursor} ≠ 实际 EOF ${size}` })
  // 领域 JSON 解析 + records[] 逐条比对（id/revision/deleted 投影在记录内，hash 相等即一致）
  const { recordHash } = await import('./canonical.js')
  for (const [domain, entry] of Object.entries(manifest.domains || {})) {
    if (!entry || entry.status !== 'present') continue
    const fi = entry.fileIndex
    const f = files[fi]
    if (!f || f.kind !== 'domain-json') { problems.push({ code: 'invalid-domain', message: `域 ${domain} fileIndex 非领域 JSON 段` }); continue }
    const seg = fileResults[fi]
    if (!seg) continue
    const bytes = new Uint8Array(f.length)
    let bo = 0
    await readChunked(reader, seg.segStart, f.length, c => { bytes.set(c, bo); bo += c.length })
    let list
    try {
      list = JSON.parse(decodeStrict(bytes))
      assertNoLoneSurrogatesDeep(list)
    } catch (e) {
      problems.push({ code: e.code || 'domain-json-invalid', message: `域 ${domain} JSON 解析失败：${e.message}` })
      continue
    }
    // 领域段字节必须恰为规范编码（canonical 唯一规则覆盖段字节——哈希匹配不豁免）
    let segRecomputed = null
    try { segRecomputed = serializeManifest(list) } catch (e) {
      problems.push({ code: 'domain-segment-not-canonical', message: `域 ${domain} 规范化失败：${e.message}` })
    }
    if (segRecomputed && (segRecomputed.length !== f.length)) {
      problems.push({ code: 'domain-segment-not-canonical', message: `域 ${domain} 段长度 ${f.length} ≠ 规范重算 ${segRecomputed.length}` })
    } else if (segRecomputed) {
      for (let bi = 0; bi < f.length; bi++) {
        if (segRecomputed[bi] !== bytes[bi]) { problems.push({ code: 'domain-segment-not-canonical', message: `域 ${domain} 段字节 @${bi} 非规范编码` }); break }
      }
    }
    const decl = (manifest.records || {})[domain]
    if (!Array.isArray(list) || !Array.isArray(decl)) {
      problems.push({ code: 'domain-json-invalid', message: `域 ${domain} 领域 JSON 须为记录数组且与 records[] 对齐` })
      continue
    }
    if (list.length !== decl.length) {
      problems.push({ code: 'records-mismatch', message: `域 ${domain} 记录数 ${list.length} ≠ 声明 ${decl.length}` })
      continue
    }
    for (let k = 0; k < list.length; k++) {
      let h
      try { h = recordHash(list[k]) } catch (e) { problems.push({ code: 'records-mismatch', message: `域 ${domain}[${k}] 规范化失败：${e.message}` }); break }
      if (h !== decl[k].hash) {
        problems.push({ code: 'records-mismatch', message: `域 ${domain}[${k}] hash ${h} ≠ 声明 ${decl[k].hash}` })
        break
      }
      // M5：reports 正文 attachments 与 reports 映射逐条比对（删映射项/fileIndex 互换/多余 referencedBy 均为映射↔正文错位）
      if (domain === 'reports' && Array.isArray(manifest.reports)) {
        const body = list[k]
        const mapping = manifest.reports.find(rd => rd.reportId === body.id)
        if (!mapping) {
          problems.push({ code: 'report-mapping-mismatch', message: `reports 正文 ${body.id} 无映射条目` })
          break
        }
        const bodyAtts = Array.isArray(body.attachments) ? body.attachments : []
        const mapAtts = Array.isArray(mapping.attachments) ? mapping.attachments : []
        if (bodyAtts.length !== mapAtts.length) {
          problems.push({ code: 'report-mapping-mismatch', message: `reports ${body.id} 正文附件数 ${bodyAtts.length} ≠ 映射 ${mapAtts.length}` })
          break
        }
        for (let ai = 0; ai < mapAtts.length; ai++) {
          const bAtt = bodyAtts[ai]
          const mAtt = mapAtts[ai]
          if (String(bAtt.fileId) !== String(mAtt.originalFileId) || Number(bAtt.order) !== Number(mAtt.order)) {
            problems.push({ code: 'report-mapping-mismatch', message: `reports ${body.id} 附件[${ai}] 正文(fileId=${bAtt.fileId},order=${bAtt.order}) ≠ 映射(originalFileId=${mAtt.originalFileId},order=${mAtt.order})` })
            break
          }
        }
        if (problems.some(p2 => p2.code === 'report-mapping-mismatch')) break
      }
      // 声明的 index/id/revision/deleted 与领域正文逐项对照（防"SHA 与正文一致但声明被改写"）
      const d = decl[k]
      if (!Number.isInteger(d.index) || d.index !== k) {
        problems.push({ code: 'declaration-mismatch', message: `域 ${domain}[${k}] 声明 index=${d.index} 与位置不符` })
        break
      }
      const bodyId = list[k] && (list[k].id !== undefined ? list[k].id : list[k].dateKey)
      if (String(bodyId) !== String(d.id)) {
        problems.push({ code: 'declaration-mismatch', message: `域 ${domain}[${k}] 正文 id=${bodyId} ≠ 声明 ${d.id}` })
        break
      }
      if (Number(list[k] && list[k].revision) !== Number(d.revision)) {
        problems.push({ code: 'declaration-mismatch', message: `域 ${domain}[${k}] revision ${list[k] && list[k].revision} ≠ 声明 ${d.revision}` })
        break
      }
      if (Boolean(list[k] && list[k].deleted) !== Boolean(d.deleted)) {
        problems.push({ code: 'declaration-mismatch', message: `域 ${domain}[${k}] deleted ${list[k] && list[k].deleted} ≠ 声明 ${d.deleted}` })
        break
      }
    }
  }
  // packageDigest（头至 EOF 分块）
  const pkgHash = createHash()
  await readChunked(reader, 0, size, c => pkgHash.update(c))
  return {
    ok: problems.length === 0,
    problems,
    manifest,
    manifestDigest,
    packageDigest: pkgHash.digest(),
    derivedTotal: cursor,
    actualSize: size
  }
}

export { serializeManifest }
