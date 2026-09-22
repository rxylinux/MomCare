// B3b 阶段一导出服务（设计 §3）：真实服务端全量分页 → 分段构建 C1–C5 → published 标志 →
// 作用域绑定的用户分享。仅微信端（活体导出）；H5 由页面层提示 unavailable-platform。
//
// 关键语义（rev5/rev6 评审）：
// - complete=所选且有权范围的来源完整性（Stage B 判定）；published=整包终检通过（C4/C5）
// - 发布前二次 pending 检查：变化 → 阻断并重建或失败保留输入（不仅改 UI）
// - published.epochAtPublish 是审计元数据：重启后 epoch 重置，不作为等值门——
//   分享时重建可信 env/app/family/member 上下文比对标志，并把每次分享绑定到【新鲜当前
//   epoch】，异步步骤后复检（迟到回调不得为错误身份标 delivered）
// - 每步分块 64KiB；.partial/未复验目标不可分享
import { familyCall, currentEpoch, getSessionState, getMemberCache, setMemberCache, pendingDrafts, getScopedCacheStatus, draftStorageStatus } from '@/services/sessionService.js'
import { getOutbox, outboxReadable } from '@/services/outbox.js'
import { CLOUD_CONFIG } from '@/utils/cloudConfig.js'
import { createHash } from '@/utils/mcpkg/sha256.js'
import { encodeStrict } from '@/utils/mcpkg/utf8.js'
import { recordHash, canonicalJsonBytes } from '@/utils/mcpkg/canonical.js'
import { LIMITS, encodeHeader, serializeManifest, validatePackage, ContainerError } from '@/utils/mcpkg/container.js'
import { wechatFsAvailable, ensureDir, removeFile, removeDir, wechatFileReader, wechatFileWriter, publishToTarget, exportPaths } from '@/utils/mcpkg/adapter-wechat.js'

const SCHEMA_VERSION = 1
const PUBLISHED_KEY = 'mcpkg-published'
const EXPORT_INTENT_KEY = 'mcpkg-export-intent'

// 导出意图：副作用（Stage A 下载）开始前持久化；成功发布后删除。
// C3（目标写入）与 C5（标志落盘）之间崩溃 → 目标孤儿+意图在盘：
// 冷启动经 recoverInterruptedExport 复验目标后补落标志（不重传不重建）；
// 无信意图的目标孤儿不自动认领。
function persistExportIntent(intent) {
  try { return setMemberCache(EXPORT_INTENT_KEY, intent) } catch (e) { return false }
}
function clearExportIntent() {
  try { setMemberCache(EXPORT_INTENT_KEY, null) } catch (e) { /* 尽力 */ }
}
function readExportIntent() {
  try { return getMemberCache(EXPORT_INTENT_KEY) || null } catch (e) { return null }
}

// 冷启动恢复：意图存在且目标文件在盘 → 整包分块复验（packageDigest 重算）→
// 与意图记录的 packageDigest 一致才补落 published 标志（epochAtPublish 用恢复时新鲜值，
// 审计语义）；不一致 → 删除孤儿目标与意图（不可信产物清理）。目标不存在 → 清理意图。
// 返回恢复的 flag 或 null。会话未确认/作用域不符 → 不动（返回 null）。
export async function recoverInterruptedExport() {
  // 发起时捕获 epoch + 完整作用域（env/app/family/member）——每个 await 后复核；
  // 切换时【零持久副作用】：不写标志（getMemberCache/setMemberCache 按当前成员命名空间——
  // 切换后落在 papa）、不清意图（papa 自己的意图不可被覆写/清除）、不动目标文件。
  // 原成员意图与目标原样保留，切回后重试可恢复。
  const epochAtRecover = currentEpoch()
  const s0 = getSessionState()
  if (!s0.member) return null
  const scopeAtStart = {
    envId: CLOUD_CONFIG.envId, appId: CLOUD_CONFIG.appId,
    familyId: s0.member.familyId, memberId: s0.member.memberId
  }
  const stillMine = () => {
    if (currentEpoch() !== epochAtRecover) return false
    const sNow = getSessionState()
    if (!sNow.member) return false
    return sNow.member.familyId === scopeAtStart.familyId && sNow.member.memberId === scopeAtStart.memberId &&
      CLOUD_CONFIG.envId === scopeAtStart.envId && CLOUD_CONFIG.appId === scopeAtStart.appId
  }
  const intent = readExportIntent()
  if (!intent || !intent.batchId) return null
  if (intent.envId !== scopeAtStart.envId || intent.appId !== scopeAtStart.appId ||
      intent.familyId !== scopeAtStart.familyId || intent.memberId !== scopeAtStart.memberId) {
    return null // 作用域不符：不认领（旧作用域数据保留）
  }
  const paths = exportPaths(intent.batchId)
  let size
  try {
    const reader = wechatFileReader(paths.target)
    size = await reader.size()
  } catch (e) {
    if (!stillMine()) return null // 切换中：零持久副作用（意图/目标原样）
    // 区分"目标确实不存在"（明确 no such file）vs 瞬时 IO 故障：
    // 不存在→清意图（无可恢复）；瞬时→意图/目标全保留（除障后重试可恢复）
    const msg = String((e && e.message) || '')
    if (/no such file|not exist/i.test(msg)) {
      clearExportIntent()
      return null
    }
    return null // 瞬时 stat 失败：不动意图/不动目标——重试可恢复
  }
  if (!stillMine()) return null // 读取期间切换：零副作用
  if (!intent.packageDigest) {
    // 元数据缺失但目标在盘：绝不删除（可能是用户唯一完好备份——数据保留铁律）。
    if (!stillMine()) return null
    clearExportIntent() // 此处无 await——但仍复核（防御式）
    return null
  }
  const { validatePackage: vp } = await import('@/utils/mcpkg/container.js')
  let v = null
  try {
    v = await vp(wechatFileReader(paths.target))
  } catch (e) {
    if (!stillMine()) return null // 切换中：零副作用
    // 结构性损坏（ContainerError 且非 fs-error——magic/版本/越界等）→ 清孤儿与意图；
    // IO 瞬时故障（adapter 以 ContainerError code='fs-error' 包装 readFile 失败）→ 全保留
    const isStructural = e && e.code && e.code !== 'fs-error' &&
      (e.constructor ? e.constructor.name === 'ContainerError' : true)
    if (isStructural) {
      await removeFile(paths.target)
      if (stillMine()) clearExportIntent()
      return null
    }
    return null // 瞬时 IO：不动目标/不动意图——重试可恢复
  }
  if (!stillMine()) return null // 复验期间切换：零副作用
  if (!v.ok || v.packageDigest !== intent.packageDigest) {
    await removeFile(paths.target) // 复验不过：孤儿不可信，清理
    if (stillMine()) clearExportIntent() // RF3：removeFile await 后复核——不清新成员意图
    return null
  }
  const flag = {
    batchId: intent.batchId, path: paths.target, packageDigest: v.packageDigest,
    envId: intent.envId, appId: intent.appId, familyId: intent.familyId, memberId: intent.memberId,
    epochAtPublish: currentEpoch(), // 恢复时刻新鲜值（审计元数据）
    publishedAt: intent.createdAt, packageKind: intent.packageKind || 'diagnostic',
    complete: Boolean(intent.complete), scopeLabel: intent.scopeLabel || 'shared-only',
    recoveredAt: Date.now()
  }
  const store = getMemberCache(PUBLISHED_KEY) || {}
  store[intent.batchId] = flag
  if (!setMemberCache(PUBLISHED_KEY, store)) return null // 落盘失败：保留意图供下次再试
  clearExportIntent()
  return flag
}

// ── 记录白名单投影（SPEC：字段严格白名单；不含 token/OpenID/会话/配额/临时 URL）──
// 各域白名单 = 源 handler view/sanitize 的真实输出字段（逐行核对 2026-09-20；
// 2026-09-22 报告域补 hospital/weekOfPregnancy，与 mc-reports sanitizeReport 对齐）：
// - pregnancy.get viewPregnancy：临床字段在 record.fields（非顶层）——P0 修复
// - checkup：dateKey/time/hospital/companion/materials/questions/examItems + status/templateKey/source
// - bag：name/category/quantity/location/assignee/prepared（非 text/done）
const DAILY_FIELDS = ['weightKg', 'systolic', 'diastolic', 'fetalCount', 'sharedNote']
const MOOD_FIELDS = ['mood', 'symptoms', 'note', 'plans']
const PREGNANCY_FIELDS = ['lmpDate', 'dueDate', 'nickname', 'babyNickname', 'hospital', 'doctor', 'hospitalPhone', 'preWeightKg', 'heightCm']
const CHECKUP_FIELDS = ['dateKey', 'time', 'hospital', 'companion', 'materials', 'questions', 'examItems', 'status', 'templateKey', 'source']
const BAG_FIELDS = ['name', 'category', 'quantity', 'location', 'assignee', 'prepared', 'templateKey']
const REPORT_FIELDS = ['reportType', 'dateKey', 'note', 'archiveStatus', 'hospital', 'weekOfPregnancy']

// 服务端文档的非临床元数据键（不进包也不算未知字段）
const META_IGNORED = ['familyId', 'sortKey', 'updatedAt', 'createdAt', 'updatedBy', 'uploaderId', 'type', 'schemaVersion', 'unsupportedSchema', 'appId', '_id', '__v', 'lastDetachedAt', 'registeredAt']

// PNG/JPEG 字节签名嗅探：返回 'image/png' | 'image/jpeg' | null（非图片=疑似错误页）
function sniffImageSignature(head) {
  if (!head || head.length < 4) return null
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png'
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  return null
}

function pick(rec, fields) {
  const out = {}
  for (const k of fields) if (rec[k] !== undefined) out[k] = rec[k]
  return out
}

// 未知有意义字段守卫：记录键不在白名单∪元数据 → 如实记 problem（→诊断包），
// 绝不静默丢弃（防止再次发生"声称完整却丢字段"）
function guardUnknownFields(rec, domain, allowKeys, idOf, problems) {
  const allowed = new Set([...allowKeys, 'id', 'revision', 'deleted'])
  for (const k of Object.keys(rec || {})) {
    if (!allowed.has(k) && !META_IGNORED.includes(k)) {
      problems.push(`unknown-field:${domain}.${k}@${idOf(rec)}`)
    }
  }
}

// unsupportedSchema fail-closed（mc-health list 对不支持版本不拒绝、视图带 true 标记——
// 导出侧不得无视：出现即该记录不可信，禁止 full）
function guardUnsupportedSchema(rec, domain, idOf, problems) {
  if (rec && rec.unsupportedSchema === true) {
    problems.push(`unsupported-schema:${domain}@${idOf(rec)}`)
  }
}

async function pagedCollect(fnName, action, requiresOpId, onRecord) {
  const records = []
  let cursor = null
  let pages = 0
  let pagingComplete = false
  try {
    do {
      const req = { action, schemaVersion: SCHEMA_VERSION, cursor, limit: 100 }
      if (requiresOpId) req.operationId = 'ro-list'
      const res = await familyCall(fnName, req)
      if (!res.ok) return { ok: false, code: res.code, message: res.message, records }
      for (const r of res.data.records || []) { onRecord(r); records.push(r) }
      cursor = res.data.nextCursor
      pages++
      if (pages > 200) return { ok: false, code: 'pagination-error', message: '分页超过 200 页', records }
    } while (cursor)
    pagingComplete = true
    return { ok: true, records, pagingComplete }
  } catch (e) {
    return { ok: false, code: 'network-error', message: e.message || String(e), records }
  }
}

// ── pending 五类显式清单（非仅计数）──
// 任一必要来源【不可判定】（队列损坏/读取异常）→ indeterminate=true：
// 不得据此生成完整包（complete 强制 false），也不静默当空清单。
export function collectPendingLists() {
  const out = { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [], indeterminate: false }
  try {
    const readable = outboxReadable()
    if (!readable.ok) {
      out.indeterminate = true // 损坏/不可读与空队列严格区分（outboxReadable 语义）
    } else {
      for (const e of getOutbox() || []) {
        if (e.conflict) out.conflicts.push(e.opId || e.id || 'unknown')
        else if (!e.sent) out.outboxPending.push(e.opId || e.id || 'unknown')
      }
    }
  } catch (err) { out.indeterminate = true }
  {
    // 草稿：pendingDrafts 对损坏/空都返回 null（null 掩蔽）——用可判定状态接口
    const ds = draftStorageStatus()
    if (ds === 'corrupt' || ds === 'error') out.indeterminate = true
    else if (ds === 'ok') {
      const draft = pendingDrafts()
      if (draft && typeof draft === 'object') {
        for (const k of Object.keys(draft)) if (k !== 'stashedAt') out.localDrafts.push(`draft:${k}`)
      }
    }
  }
  // B2b2 真实持久结构：上传批次（b2b2-upload-batches）与暂存恢复（b2b2-recovery）
  // 成员缓存键：getMemberCache 对损坏也返回 null（掩蔽）——getScopedCacheStatus 按当前
  // 成员命名空间区分 present/corrupt/error/absent/other-member（他成员键不影响本成员判定）
  const cacheKeyed = [
    { key: 'b2b2-upload-batches', collect: v => {
        // reportFamilyStore 真实持久形状：{ batches: { batchId: {...} } }（:84 setMemberCache(BATCHES_KEY, {batches})）
        const inner = v && typeof v === 'object' && v.batches && typeof v.batches === 'object' && !Array.isArray(v.batches)
          ? v.batches
          : (v && typeof v === 'object' && !Array.isArray(v) && !v.batches ? v : null)
        if (inner === null) {
          out.indeterminate = true // 形状不可识别（数组/纯数字/batches 非对象等）——不可判定
          return
        }
        // 映射键即 batchId（reportFamilyStore 批次以 batchId→entry 存于 batches 映射）——
        // 条目缺 batchId 字段时回退键名，不静默漏报；非对象条目视为形状不可判定
        for (const [mapKey, b] of Object.entries(inner)) {
          if (b === null || b === undefined) continue
          if (typeof b !== 'object') { out.indeterminate = true; continue }
          const id = typeof b.batchId === 'string' && b.batchId ? b.batchId : mapKey
          if (b.status !== 'done' && b.status !== 'cancelled' && b.status !== 'aborted') {
            out.uploadBatches.push(id)
          }
        }
      } },
    { key: 'b2b2-recovery', collect: v => { if (v && v.items && !v.cancelled) out.uploadBatches.push('b2b2-recovery') } },
    { key: 'b3-migration', collect: v => { if (v && v.batchId && v.status !== 'done') out.migrationIncomplete.push(v.batchId) } },
    { key: 'b3-migration-archive', collect: v => {
        const list = Array.isArray(v) ? v : (v ? [v] : [])
        for (const b of list) if (b && b.batchId && b.status !== 'done') out.migrationIncomplete.push(b.batchId)
      } }
  ]
  for (const ck of cacheKeyed) {
    const st = getScopedCacheStatus(ck.key)
    if (st === 'corrupt' || st === 'error') { out.indeterminate = true; continue }
    if (st === 'present') ck.collect(getMemberCache(ck.key))
  }
  return out
}

function pendingNonEmpty(p) {
  return Object.values(p).some(v => Array.isArray(v) && v.length > 0)
}

// C2 有界二次全域扫描（评审 rev6：游标分页非跨集合快照——收集期间游标前方插入的
// 记录会被漏读且既有 revision 不变无法暴露）。逐选中域完整重分页，比较逐条
// ID 集合/revision/deleted/报告附件引用；任何差异 → data-changed 失败保留输入。
async function secondScanCompare(fingerprintOf) {
  const diffs = []
  // 孕期（pregnancy.get 单记录，非分页）：发布前重读并核对 revision/deleted/字段
  if (fingerprintOf.pregnancy) {
    try {
      const preg = await familyCall('mc-health', { action: 'pregnancy.get', schemaVersion: SCHEMA_VERSION, operationId: 'ro-get' })
      if (!preg.ok) diffs.push('pregnancy: 二次读取失败（' + preg.code + '）')
      else {
        const rec = preg.data && preg.data.record
        const now = rec ? {
          revision: typeof rec.revision === 'number' ? rec.revision : 0,
          deleted: Boolean(rec.deleted),
          fieldsHash: recordHash({ fields: pick(rec.fields || {}, PREGNANCY_FIELDS) })
        } : null
        const before = fingerprintOf.pregnancy.fingerprint
        if ((now === null) !== (before === null)) diffs.push('pregnancy: 存在性变化')
        else if (now && (now.revision !== before.revision || now.deleted !== before.deleted || now.fieldsHash !== before.fieldsHash)) {
          diffs.push('pregnancy: 内容/版本/删除标志变化')
        }
      }
    } catch (e) { diffs.push('pregnancy: 二次读取异常') }
  }
  for (const def of fingerprintOf.domains) {
    const r = await pagedCollect(def.fn, def.action, def.opId, () => {})
    if (!r.ok) return { ok: false, code: 'rescan-failed', message: `域 ${def.key} 二次扫描失败（${r.code}）` }
    const now = new Map()
    for (const rec of r.records) {
      const id = def.idOf(rec)
      now.set(id, {
        id,
        revision: typeof rec.revision === 'number' ? rec.revision : 0,
        deleted: Boolean(rec.deleted),
        attRefs: def.key === 'reports' ? (rec.attachments || []).map(a => a.fileId).join(',') : ''
      })
    }
    const before = def.first
    if (now.size !== before.size) {
      diffs.push(`${def.key}: 记录数 ${before.size} → ${now.size}`)
      continue
    }
    for (const [id, fpOld] of before) {
      const fpNow = now.get(id)
      if (!fpNow) { diffs.push(`${def.key}: 记录 ${id} 在二次扫描中消失`); continue }
      if (fpNow.revision !== fpOld.revision) diffs.push(`${def.key}:${id} revision ${fpOld.revision} → ${fpNow.revision}`)
      if (fpNow.deleted !== fpOld.deleted) diffs.push(`${def.key}:${id} deleted ${fpOld.deleted} → ${fpNow.deleted}`)
      if (fpNow.attRefs !== fpOld.attRefs) diffs.push(`${def.key}:${id} 附件引用变化`)
    }
    if (diffs.length >= 10) break // 有界：错误清单截断，不影响判定
  }
  if (diffs.length > 0) return { ok: false, code: 'data-changed', message: '收集期间数据发生变化（游标非快照）：' + diffs.slice(0, 10).join('；') }
  return { ok: true }
}

// ── 导出状态机 ──
// idle → collecting → manifest-built → assembling → publish-check → target-written → verified → published
//        → delivering → delivered | delivery-cancelled；任一步 failed（保留输入、清理临时产物）

function newExportId() {
  return 'exp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
}

// 进度回调：onProgress({stage, detail})
export async function buildAndPublishPackage({ includeShared = true, includePrivateOf = null, onProgress } = {}) {
  if (!wechatFsAvailable()) return { ok: false, code: 'platform-unsupported', message: '云端导出仅在微信小程序端可用' }
  const s = getSessionState()
  if (!s.member) return { ok: false, code: 'unauthenticated-session' }
  const report = (stage, detail) => { if (onProgress) onProgress({ stage, detail }) }

  const epochAtStart = currentEpoch()
  const stale = () => currentEpoch() !== epochAtStart
  // 先按当前可信身份验证选择，再收集（rev6：非法私人范围必须报错，不静默 omitted）
  if (includePrivateOf !== null && includePrivateOf !== s.member.memberId) {
    return { ok: false, code: 'invalid-scope', message: '私人范围只能是当前本人（无可导出他人私人域）' }
  }
  if (!includeShared && includePrivateOf === null) {
    return { ok: false, code: 'invalid-scope', message: '请至少选择一个范围' }
  }
  const batchId = newExportId()
  const paths = exportPaths(batchId)
  // 副作用前持久化导出意图（C3-C5 崩溃恢复凭据）
  // 旧意图清算（评审：新导出不得静默覆盖未决的 C3-C5 崩溃意图）：
  // 同作用域旧意图 → 先尝试恢复（目标复验晋升）或清理（无目标/不可信）。
  // 旧孤儿要么已恢复为可分享标志、要么已清理——新意图（C3 前写）不悬挂
  const staleIntent = readExportIntent()
  if (staleIntent && staleIntent.batchId && staleIntent.batchId !== batchId &&
      staleIntent.envId === CLOUD_CONFIG.envId && staleIntent.appId === CLOUD_CONFIG.appId &&
      staleIntent.familyId === s.member.familyId && staleIntent.memberId === s.member.memberId) {
    await recoverInterruptedExport()
    const still = readExportIntent()
    if (still && still.batchId === staleIntent.batchId) {
      return { ok: false, code: 'stale-intent-unresolved', message: '存在未完成的上次导出中断（尝试恢复未成功）——请先在备份列表处理或稍后重试' }
    }
  }
  const intent = {
    batchId, envId: CLOUD_CONFIG.envId, appId: CLOUD_CONFIG.appId,
    familyId: s.member.familyId, memberId: s.member.memberId,
    includeShared, includePrivateOf, createdAt: Date.now()
  }
  if (!persistExportIntent(intent)) {
    return { ok: false, code: 'intent-persist-failed', message: '导出意图写入失败——不开始副作用，请重试' }
  }
  let targetWritten = false
  try {
  await ensureDir(paths.tmpDir)

  // ── Stage A 收集：真实服务端全量分页 + 附件下载到临时分段 ──
  report('collecting', '开始从服务端分页拉取')
  const pendingFirst = collectPendingLists()
  let pregnancyFingerprint = null // 孕期单记录指纹（首扫记录；C2 重读比对——须在收集前声明）
  const domains = {}
  const domainRecords = {} // domain → [投影后记录]
  const decls = {}         // domain → [{index,id,revision,deleted,hash}]
  const problems = []

  function addDomainRecords(domain, records, project, idOf, allowKeys) {
    const list = []
    const dlist = []
    records.forEach((rec, index) => {
      guardUnknownFields(rec, domain, allowKeys, idOf, problems)
      const projected = project(rec)
      projected.id = idOf(rec)
      projected.revision = typeof rec.revision === 'number' ? rec.revision : 0
      projected.deleted = Boolean(rec.deleted)
      list.push(projected)
      dlist.push({ index, id: projected.id, revision: projected.revision, deleted: projected.deleted, hash: recordHash(projected) })
    })
    domainRecords[domain] = list
    decls[domain] = dlist
  }

  // 孕期（单记录；仅共享范围被选择时收集——includeShared=false 显式 omitted，不是读取失败）
  if (!includeShared) {
    domains.pregnancy = { status: 'omitted' }
  } else try {
    const preg = await familyCall('mc-health', { action: 'pregnancy.get', schemaVersion: SCHEMA_VERSION, operationId: 'ro-get' })
    if (stale()) return { ok: false, code: 'stale-session', message: '会话已切换，导出终止（输入保留）' }
    if (preg.ok) {
      const rec = preg.data && preg.data.record
      if (rec && rec.unsupportedSchema === true) {
        // fail-closed：孕期由更高版本写入——不可信，不产 full
        domains.pregnancy = { status: 'missing', reason: 'unsupported-schema' }
        problems.push('domain:pregnancy unsupported-schema')
      } else if (rec) {
        const projected = { id: 'pregnancy', fields: pick(rec.fields || {}, PREGNANCY_FIELDS) }
        guardUnknownFields(rec.fields || {}, 'pregnancy.fields', PREGNANCY_FIELDS, () => 'pregnancy', problems)
        projected.revision = typeof rec.revision === 'number' ? rec.revision : 0
        projected.deleted = Boolean(rec.deleted)
        domainRecords.pregnancy = [projected]
        decls.pregnancy = [{ index: 0, id: 'pregnancy', revision: projected.revision, deleted: projected.deleted, hash: recordHash(projected) }]
        pregnancyFingerprint = { revision: projected.revision, deleted: projected.deleted, fieldsHash: recordHash({ fields: projected.fields }) }
        domains.pregnancy = { status: 'present', schemaVersion: SCHEMA_VERSION, recordCount: 1, pagingComplete: true, visibility: 'shared' }
      } else {
        domainRecords.pregnancy = []
        decls.pregnancy = []
        domains.pregnancy = { status: 'present', schemaVersion: SCHEMA_VERSION, recordCount: 0, pagingComplete: true, visibility: 'shared' }
      }
    } else {
      domains.pregnancy = { status: 'missing', reason: 'read-failed' }
      problems.push('domain:pregnancy read-failed')
    }
  } catch (e) {
    domains.pregnancy = { status: 'missing', reason: 'read-failed' }
    problems.push('domain:pregnancy read-failed')
  }

  const pagedDomains = [
    { key: 'daily', fn: 'mc-health', action: 'daily.list', opId: true, shared: true,
      project: r => {
        guardUnsupportedSchema(r, 'daily', () => r.dateKey, problems)
        guardUnknownFields(r.fields || {}, 'daily.fields', DAILY_FIELDS, () => r.dateKey, problems)
        const p = { dateKey: r.dateKey, fields: pick(r.fields || {}, DAILY_FIELDS) }
        return p
      },
      idOf: r => r.dateKey, allow: ['dateKey', 'fields', ...DAILY_FIELDS] },
    { key: 'checkup', fn: 'mc-schedule', action: 'checkup.list', opId: false, shared: true,
      project: r => pick(r, CHECKUP_FIELDS), idOf: r => r.id, allow: CHECKUP_FIELDS },
    { key: 'bag', fn: 'mc-schedule', action: 'bag.list', opId: false, shared: true,
      project: r => pick(r, BAG_FIELDS), idOf: r => r.id, allow: BAG_FIELDS },
    { key: 'reports', fn: 'mc-reports', action: 'report.list', opId: false, shared: true,
      project: r => { const p = pick(r, REPORT_FIELDS); p.attachments = r.deleted ? [] : (r.attachments || []).map((a, i) => ({ fileId: a.fileId, order: i })); return p },
      idOf: r => r.id, allow: [...REPORT_FIELDS, 'attachments'] }
  ]
  if (includePrivateOf === s.member.memberId) {
    pagedDomains.push({ key: 'mood', fn: 'mc-health', action: 'mood.list', opId: true, shared: false,
      project: r => {
        guardUnsupportedSchema(r, 'mood', () => r.dateKey, problems)
        guardUnknownFields(r.fields || {}, 'mood.fields', MOOD_FIELDS, () => r.dateKey, problems)
        const p = { dateKey: r.dateKey, fields: pick(r.fields || {}, MOOD_FIELDS) }
        return p
      },
      idOf: r => r.dateKey, allow: ['dateKey', 'fields', ...MOOD_FIELDS] })
  }

  const scanDefs = [] // 二次扫描指纹定义（rev6 C2）
  for (const def of pagedDomains) {
    if (!includeShared && def.shared) { domains[def.key] = { status: 'omitted' }; continue }
    report('collecting', `拉取 ${def.key}`)
    const r = await pagedCollect(def.fn, def.action, def.opId, () => {})
    if (stale()) return { ok: false, code: 'stale-session', message: '会话已切换，导出终止（输入保留）' }
    if (r.ok) {
      addDomainRecords(def.key, r.records, def.project, def.idOf, def.allow)
      domains[def.key] = { status: 'present', schemaVersion: SCHEMA_VERSION, recordCount: r.records.length, pagingComplete: r.pagingComplete, visibility: def.shared ? 'shared' : 'private' }
      const first = new Map()
      for (const rec of r.records) {
        const id = def.idOf(rec)
        first.set(id, {
          id,
          revision: typeof rec.revision === 'number' ? rec.revision : 0,
          deleted: Boolean(rec.deleted),
          attRefs: def.key === 'reports' ? (rec.attachments || []).map(a => a.fileId).join(',') : ''
        })
      }
      scanDefs.push({ key: def.key, fn: def.fn, action: def.action, opId: def.opId, idOf: def.idOf, first })
    } else {
      domains[def.key] = { status: 'missing', reason: 'read-failed' }
      problems.push(`domain:${def.key} ${r.code}`)
    }
  }
  if (!includeShared) {
    // 用户明确只选私人 → 其余共享域 omitted（不是不完整）
    for (const k of ['pregnancy', 'daily', 'checkup', 'bag', 'reports']) {
      if (!domains[k]) domains[k] = { status: 'omitted' }
    }
  }
  if (!domains.mood) domains.mood = { status: 'omitted' } // 未选择/无权私人域——omitted 不是不完整

  // 附件下载（仅未删报告；经 getReadUrls 受控路由 → wx.downloadFile）
  report('collecting', '下载报告附件')
  const files = []       // manifest.files
  const fileSources = [] // {readerPath|bytes, length}
  const fileIndexByFileId = new Map()
  const reportsDecls = []
  const reportRecords = domainRecords.reports || []
  const reportMeta = [] // (rec, decl) 对齐
  {
    let ri = 0
    for (const rec of reportRecords) {
      const decl = decls.reports[ri]
      reportMeta.push({ rec, decl })
      ri++
    }
  }
  for (const { rec } of reportMeta) {
    if (rec.deleted) continue // 墓碑报告原件不可读、不下载
    const atts = rec.attachments || []
    if (atts.length === 0) continue
    let urlsRes
    try {
      urlsRes = await familyCall('mc-reports', { action: 'report.getReadUrls', id: rec.id, schemaVersion: SCHEMA_VERSION, operationId: 'ro-get' })
    } catch (e) { urlsRes = { ok: false, code: 'network-error', message: e.message } }
    if (stale()) return { ok: false, code: 'stale-session', message: '会话已切换，导出终止（输入保留）' }
    if (!urlsRes.ok) {
      problems.push(`report:${rec.id} attachments read-failed (${urlsRes.code})`)
      continue
    }
    for (const u of urlsRes.data.urls || []) {
      if (!fileIndexByFileId.has(u.fileId)) {
        const dl = await new Promise(resolve => {
          // statusCode 必须 200：uni.downloadFile 的 success 可能携带 403/404 的
          // HTML 临时文件（CDN 错误页）——不校验状态码会把错误页当原件哈希进 full 包
          uni.downloadFile({
            url: u.tempFileURL,
            success: r => {
              if (r.statusCode !== 200) {
                resolve({ ok: false, code: 'download-http-error', message: `HTTP ${r.statusCode}（错误页不可当原件）` })
                return
              }
              if (!r.tempFilePath) {
                resolve({ ok: false, code: 'download-no-file', message: '下载未返回临时文件' })
                return
              }
              resolve({ ok: true, path: r.tempFilePath })
            },
            fail: e => resolve({ ok: false, code: 'download-failed', message: e && e.errMsg })
          })
        })
        if (stale()) return { ok: false, code: 'stale-session', message: '会话已切换，导出终止（输入保留）' }
        if (!dl.ok) { problems.push(`file:${u.fileId} ${dl.code || 'download-failed'}`); continue }
        const reader = wechatFileReader(dl.path)
        const length = await reader.size()
        // 下载完整性核对（评审阻塞）：长度 vs getReadUrls 声明 sizeBytes；MIME vs 字节签名
        const declaredSize = typeof u.sizeBytes === 'number' ? u.sizeBytes : null
        if (declaredSize !== null && length !== declaredSize) {
          problems.push(`file:${u.fileId} size-mismatch (downloaded ${length} ≠ declared ${declaredSize})`)
          continue
        }
        const headBuf = length > 0 ? await reader.readChunk(0, Math.min(16, length)) : new Uint8Array(0)
        const declaredType = u.contentType === 'image/jpeg' ? 'image/jpeg' : 'image/png'
        const sigType = sniffImageSignature(headBuf)
        if (!sigType) {
          problems.push(`file:${u.fileId} mime-mismatch (非 PNG/JPEG 字节签名——疑似错误页)`)
          continue
        }
        if (sigType !== declaredType) {
          problems.push(`file:${u.fileId} mime-mismatch (${sigType} 字节 vs 声明 ${declaredType})`)
          continue
        }
        // 分块算 sha256 + 256KiB 块承诺
        const hash = createHash()
        const chunkHashes = []
        let off = 0
        while (off < length) {
          const n = Math.min(LIMITS.VERIFY_BLOCK, length - off)
          const blockHash = createHash()
          let inner = 0
          while (inner < n) {
            const cn = Math.min(LIMITS.CHUNK_BYTES, n - inner)
            const chunk = await reader.readChunk(off + inner, cn)
            hash.update(chunk)
            blockHash.update(chunk)
            inner += cn
          }
          chunkHashes.push(blockHash.digest())
          off += n
        }
        const fi = files.length
        fileIndexByFileId.set(u.fileId, fi)
        files.push({
          path: `files/${u.fileId}.bin`, kind: 'attachment', length, sha256: hash.digest(),
          contentType: sigType,
          originalFileId: u.fileId, referencedBy: [], chunkSha256: length > 0 ? chunkHashes : []
        })
        fileSources.push({ tempPath: dl.path, length })
      }
    }
  }
  // reports 映射（顺序显式；共享段 referencedBy 汇总）
  for (const { rec } of reportMeta) {
    const attachments = []
    if (!rec.deleted) {
      for (let ai = 0; ai < (rec.attachments || []).length; ai++) {
        const a = rec.attachments[ai]
        const fi = fileIndexByFileId.get(a.fileId)
        if (fi === undefined) continue // 下载失败的附件：不纳入（problems 已记，complete 将为 false）
        attachments.push({ order: ai, originalFileId: a.fileId, fileIndex: fi })
        if (!files[fi].referencedBy.includes(rec.id)) files[fi].referencedBy.push(rec.id)
      }
    }
    reportsDecls.push({ reportId: rec.id, deleted: Boolean(rec.deleted), revision: typeof rec.revision === 'number' ? rec.revision : 0, attachments })
  }
  // 下载失败/缺件的报告不得凭缺失称完整
  for (const { rec } of reportMeta) {
    if (rec.deleted) continue
    const want = (rec.attachments || []).length
    const got = (reportsDecls.find(d => d.reportId === rec.id) || { attachments: [] }).attachments.length
    if (want !== got) problems.push(`report:${rec.id} missing-attachments (${got}/${want})`)
  }

  // 领域 JSON 文件段
  let fileCursor = files.length
  const domainFileIndex = {}
  for (const domain of Object.keys(domainRecords)) {
    const bytes = canonicalJsonBytes(domainRecords[domain])
    const fi = fileCursor++
    domainFileIndex[domain] = fi
    files.push({ path: `records/${domain}.json`, kind: 'domain-json', length: bytes.length, sha256: hashOfBytes(bytes), contentType: 'application/json', domain })
    fileSources.push({ bytes, length: bytes.length })
    const entry = domains[domain]
    if (entry && entry.status === 'present') entry.fileIndex = fi
  }
  function hashOfBytes(bytes) {
    const h = createHash(); h.update(bytes); return h.digest()
  }

  // ── Stage B 清单（complete=所选范围来源完整性，此刻判定）──
  report('manifest-built', '构成清单')
  const pendingNow = collectPendingLists()
  const anyMissing = Object.values(domains).some(e => e && e.status === 'missing')
  const allPagingComplete = Object.values(domains).every(e => !e || e.status !== 'present' || e.pagingComplete)
  const attachmentsComplete = problems.every(p => !p.includes('missing-attachments') && !p.includes('download-failed') && !p.includes('attachments read-failed'))
  const complete = !pendingNonEmpty(pendingNow) && !pendingNow.indeterminate && !anyMissing && allPagingComplete && attachmentsComplete && problems.length === 0
  const incompleteReasons = []
  if (pendingNonEmpty(pendingNow)) incompleteReasons.push('pending_operations')
  if (pendingNow.indeterminate) incompleteReasons.push('pending-sources-unreadable')
  for (const p of problems) incompleteReasons.push(p)
  const manifest = {
    formatVersion: 1,
    createdAt: Date.now(),
    createdBy: s.member.memberId,
    familyId: s.member.familyId,
    packageKind: complete ? 'full' : 'diagnostic',
    scope: { includeShared, includePrivateOf },
    scopeLabel: includePrivateOf === s.member.memberId ? 'shared-plus-own-private' : 'shared-only',
    domains,
    files,
    reports: reportsDecls,
    records: decls,
    pending: pendingNow,
    limits: {
      maxPkgBytes: LIMITS.MAX_PKG_BYTES, maxManifestBytes: LIMITS.MAX_MANIFEST_BYTES,
      maxFiles: LIMITS.MAX_FILES, maxAttachmentBytes: LIMITS.MAX_ATTACHMENT_BYTES,
      maxDomainJsonBytes: LIMITS.MAX_DOMAIN_JSON_BYTES, maxRecords: LIMITS.MAX_RECORDS
    },
    complete
  }
  if (!complete) manifest.incompleteReasons = incompleteReasons
  const manifestBytesAll = serializeManifest(manifest)
  if (manifestBytesAll.length > LIMITS.MAX_MANIFEST_BYTES) {
    await cleanupTemp(paths)
    return { ok: false, code: 'limit-exceeded', message: `manifest ${manifestBytesAll.length} > 4MiB` }
  }

  // ── Stage C 组装与发布 ──
  report('assembling', '写入 .partial（逐段分块回读校验）')
  // packageDigest 流式构建器：与写入序一致（头→manifest→逐段[8B 前缀+字节]）——
  // C3 前得到确定性整包摘要（C3 后恢复不再依赖任何存储写）
  const pkgDigestBuilder = createHash()
  const writer = wechatFileWriter(paths.partial)
  const headerBytes = encodeHeader(manifestBytesAll.length)
  await writer.writeChunk(headerBytes)
  pkgDigestBuilder.update(headerBytes)
  await writer.writeChunk(manifestBytesAll, { append: true })
  pkgDigestBuilder.update(manifestBytesAll)
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    const lenBuf = new Uint8Array(8)
    new DataView(lenBuf.buffer).setUint32(4, f.length)
    await writer.writeChunk(lenBuf, { append: true })
    pkgDigestBuilder.update(lenBuf)
    // 段内容分块写入+分块回读校验（不整段驻留；段摘要已在 Stage A 计算）
    const src = fileSources[i]
    let off = 0
    while (off < f.length) {
      const n = Math.min(LIMITS.CHUNK_BYTES, f.length - off)
      let chunk
      if (src.bytes) chunk = src.bytes.subarray(off, off + n)
      else chunk = await wechatFileReader(src.tempPath).readChunk(off, n)
      await writer.writeChunk(chunk, { append: true })
      pkgDigestBuilder.update(chunk)
      // 回读校验该块
      const at = await writer.size()
      const back = await writer.readChunk(at - n, n)
      for (let b = 0; b < n; b++) {
        if (back[b] !== chunk[b]) {
          await cleanupTemp(paths)
          return { ok: false, code: 'verify-failed', message: `files[${i}] @${off} 回读不一致——作废重建` }
        }
      }
      off += n
    }
  }
  const computedPackageDigest = pkgDigestBuilder.digest()

  // 发布前 C2 有界二次全域扫描（游标非快照的完整性门，rev6）
  report('publish-check', '二次全域扫描（游标非快照兜底）')
  // 二次扫描只针对首扫 present 的域/孕期——missing 域（已是 problems→诊断语义）不参与，
  // 否则全域读取失败时 rescan 也失败会被误判 data-changed 而无法产出诊断包
  const rescan = await secondScanCompare({
    domains: scanDefs,
    pregnancy: (includeShared && domains.pregnancy && domains.pregnancy.status === 'present') ? { fingerprint: pregnancyFingerprint } : null
  })
  if (stale()) {
    await cleanupTemp(paths)
    return { ok: false, code: 'stale-session', message: '会话已切换，导出终止（输入保留）' }
  }
  if (!rescan.ok) {
    // 数据在收集期间变化：不发布旧集合（不标 full）——失败保留输入，重试将重建
    await cleanupTemp(paths)
    return { ok: false, code: rescan.code, message: rescan.message }
  }

  // 发布前二次检查（pending/身份作用域）
  report('publish-check', '发布前二次检查')
  const pendingSecond = collectPendingLists()
  const sNow = getSessionState()
  const scopeChanged = !sNow.member || sNow.member.memberId !== s.member.memberId || sNow.member.familyId !== s.member.familyId
  if (stale() || scopeChanged) {
    await cleanupTemp(paths)
    return { ok: false, code: 'stale-session', message: '会话已切换，导出终止（输入保留）' }
  }
  if (JSON.stringify(pendingFirst) !== JSON.stringify(pendingSecond)) {
    // 构建期待办变化会使清单 pending 失真：阻断发布并如实失败（保留输入；重试将重建）
    await cleanupTemp(paths)
    return { ok: false, code: 'pending-changed', message: '构建期间待同步项发生变化——已阻断发布，请处理后重新导出' }
  }

  // C3 目标名 + C4 目标整包分块复验 + C5 published 标志
  // 碰撞守卫：目标路径已存在（确定性 batchId 碰撞/残留孤儿）→ 不得静默覆盖既有已发布包
  try {
    await wechatFileReader(paths.target).size()
    await cleanupTemp(paths)
    clearExportIntent()
    return { ok: false, code: 'target-collision', message: '目标文件名已被占用——不覆盖既有文件，请重试（新批次将使用新 ID）' }
  } catch (e) { /* 目标不存在——正常继续 */ }
  // C3 前持久完整恢复凭据（数据保留修复 + D1 契约）：packageDigest 已确定性算出
  // （与 C1 写入同序流式）；这是意图的【首次也是唯一一次】写入——此后 C3-C5 任意
  // 中断的恢复不依赖任何后续存储写。落盘失败 → 中止发布（不重命名、无目标）。
  if (!persistExportIntent({
    ...intent,
    manifestDigest: hashOfBytes(manifestBytesAll),
    packageDigest: computedPackageDigest,
    packageKind: manifest.packageKind, complete, scopeLabel: manifest.scopeLabel
  })) {
    await cleanupTemp(paths)
    return { ok: false, code: 'intent-digest-persist-failed', message: '恢复凭据写入失败——已中止发布（未创建目标文件），请清理存储后重试' }
  }
  report('target-written', '发布到目标文件')
  await publishToTarget(paths.partial, paths.target)
  targetWritten = true
  report('verified', '目标文件整包复验')
  const targetReader = wechatFileReader(paths.target)
  const verification = await validatePackage(targetReader)
  // C4→C5 之间复核作用域+epoch：旧 continuation 不得把标志写进新成员缓存
  const sPost = getSessionState()
  if (stale() || !sPost.member || sPost.member.memberId !== s.member.memberId || sPost.member.familyId !== s.member.familyId) {
    await removeFile(paths.target)
    await cleanupTemp(paths)
    return { ok: false, code: 'stale-session', message: '复验期间会话切换——已移除目标文件（输入保留）' }
  }
  if (!verification.ok || verification.manifestDigest !== hashOfBytes(manifestBytesAll)) {
    await removeFile(paths.target)
    await cleanupTemp(paths)
    return { ok: false, code: 'verify-failed', message: '目标文件复验未通过', problems: verification.problems }
  }

  const flag = {
    batchId, path: paths.target, packageDigest: verification.packageDigest,
    envId: CLOUD_CONFIG.envId, appId: CLOUD_CONFIG.appId,
    familyId: s.member.familyId, memberId: s.member.memberId,
    epochAtPublish: epochAtStart, // 审计元数据——重启后 epoch 重置，不作为等值门
    publishedAt: Date.now(), packageKind: manifest.packageKind, complete: manifest.complete,
    scopeLabel: manifest.scopeLabel
  }
  const store = getMemberCache(PUBLISHED_KEY) || {}
  store[batchId] = flag
  if (!setMemberCache(PUBLISHED_KEY, store, epochAtStart)) { // epoch 门控：切换后的写入被拒
    // 标志落盘失败：恢复凭据已在 C3 前持久（含 packageDigest）——目标保留，冷启动恢复重试落标志；
    // 不再做任何二次意图写（原补写即评审指出的未检查写，已废弃）
    await cleanupTemp(paths)
    return { ok: false, code: 'flag-persist-failed', message: 'published 标志写入失败——恢复凭据已持久，目标保留待重启自动恢复' }
  }
  clearExportIntent() // 成功发布：意图清除（后续同名孤儿不认领）
  await cleanupTemp(paths)
  report('published', complete ? '已发布（完整包）' : '已发布（诊断包——不可用于恢复）')
  return { ok: true, batchId, packageKind: manifest.packageKind, complete, flag, problems, incompleteReasons: complete ? [] : incompleteReasons }
  } catch (e) {
    // 磁盘满/IO 异常：目标未写 → 清理临时产物+清意图（无可恢复）；
    // 目标已写（C3-C5 崩溃窗口）→ 保留目标+意图（recoverInterruptedExport 冷启动续作）
    if (!targetWritten) {
      await cleanupTemp(paths)
      clearExportIntent()
    }
    return { ok: false, code: (e && e.code) === 'fs-error' ? 'storage-full' : 'export-crashed', message: (e && e.message) || String(e) }
  }
}

async function cleanupTemp(paths) {
  await removeFile(paths.partial)
  await removeDir(paths.tmpDir)
}

// 按当前可信 env/app/family/member 过滤（成员缓存键不含 family——同成员切家庭后
// 旧家庭标志保留在存储中但不展示/不可删；切回原家庭可见）
export function listPublished() {
  const s = getSessionState()
  if (!s.member) return []
  const store = getMemberCache(PUBLISHED_KEY) || {}
  return Object.values(store)
    .filter(f => f && f.envId === CLOUD_CONFIG.envId && f.appId === CLOUD_CONFIG.appId &&
      f.familyId === s.member.familyId && f.memberId === s.member.memberId)
    .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
}

// ── 分享（rev6 绑定语义）──
// ① 重建可信上下文：当前 env/app/family/member 与标志比对（epochAtPublish 仅审计，
//    重启后 epoch 重置不作等值门）② 目标文件完整摘要 64KiB 分块复验
// ③ 绑定【新鲜当前 epoch】④ 异步回调后复检 epoch——迟到回调不得为错误身份标 delivered
export async function sharePublishedPackage(batchId) {
  if (typeof wx === 'undefined' || !wx.shareFileMessage) {
    return { ok: false, code: 'platform-unsupported', message: '当前微信版本不支持转发文件；包仅在本机沙箱（卸载后丢失）' }
  }
  // epoch 先捕获（rev6：读盘期间切换身份不得以新会话分享旧标志）
  const epochAtShare = currentEpoch()
  const stillFresh = () => currentEpoch() === epochAtShare
  const s = getSessionState()
  if (!s.member) return { ok: false, code: 'unauthenticated-session' }
  const store = getMemberCache(PUBLISHED_KEY) || {}
  let flag = store[batchId]
  // durable 缺失 → 回落可信意图（batchId 匹配的中断导出）：先复验晋升，绝不给临时条目直接放行
  let fromIntent = false
  if (!flag) {
    const intentNow = readExportIntent()
    if (!intentNow || intentNow.batchId !== batchId ||
        intentNow.envId !== CLOUD_CONFIG.envId || intentNow.appId !== CLOUD_CONFIG.appId ||
        intentNow.familyId !== s.member.familyId || intentNow.memberId !== s.member.memberId) {
      return { ok: false, code: 'no-published', message: '没有已发布的包' }
    }
    fromIntent = true
  } else if (flag.recoveredPending) {
    fromIntent = true
  }
  // ① 作用域比对（epochAtPublish 不比对——审计元数据，重启后重置）
  if (flag.envId !== CLOUD_CONFIG.envId || flag.appId !== CLOUD_CONFIG.appId ||
      flag.familyId !== s.member.familyId || flag.memberId !== s.member.memberId) {
    return { ok: false, code: 'scope-mismatch', message: '当前身份与包发布作用域不符——不可分享' }
  }
  // 中断条目（durable 缺失或 recoveredPending）：整包复验通过后晋升 durable 标志；
  // 并发恢复已完成的竞争下回落 durable——不得误报 no-published/recover-failed
  if (fromIntent) {
    const promoted = await recoverInterruptedExport()
    if (!promoted || promoted.batchId !== batchId) {
      const storeNow = getMemberCache(PUBLISHED_KEY) || {}
      const durable = storeNow[batchId]
      if (!durable) {
        return { ok: false, code: 'recover-failed', message: '中断包复验未通过——已清理不可信产物' }
      }
      flag = durable // 并发晋升成功——用 durable 标志继续
    }
  }
  // ② 目标文件完整摘要分块复验
  let digest
  try {
    const reader = wechatFileReader(flag.path)
    const size = await reader.size()
    if (!stillFresh()) return { ok: false, code: 'stale-session', message: '读盘期间会话切换——取消分享' }
    const hash = createHash()
    let off = 0
    while (off < size) {
      const n = Math.min(LIMITS.CHUNK_BYTES, size - off)
      hash.update(await reader.readChunk(off, n))
      if (!stillFresh()) return { ok: false, code: 'stale-session', message: '读盘期间会话切换——取消分享' } // 每个 await 后复核
      off += n
    }
    digest = hash.digest()
  } catch (e) {
    return { ok: false, code: 'verify-failed', message: '目标文件读取失败——不分享：' + (e.message || e) }
  }
  if (!stillFresh()) return { ok: false, code: 'stale-session', message: '读盘期间会话切换——取消分享' }
  if (digest !== flag.packageDigest) {
    return { ok: false, code: 'digest-mismatch', message: '目标文件摘要与发布标志不符——不分享（原文件保留）' }
  }
  // ③ 发起分享前最后一次 scope+epoch 复核（每个异步边界之后）
  if (!stillFresh()) return { ok: false, code: 'stale-session', message: '会话已切换——取消分享' }
  {
    const sNow = getSessionState()
    if (!sNow.member || sNow.member.memberId !== flag.memberId || sNow.member.familyId !== flag.familyId) {
      return { ok: false, code: 'scope-mismatch', message: '当前身份与包发布作用域不符——取消分享' }
    }
  }
  return await new Promise(resolve => {
    wx.shareFileMessage({
      filePath: flag.path,
      success: () => {
        if (!stillFresh()) {
          // ④ 迟到回调：不为（可能已切换的）错误身份标 delivered——如实返回未确认
          resolve({ ok: false, code: 'stale-session', message: '分享操作期间会话切换——交付状态未确认' })
          return
        }
        const st = getMemberCache(PUBLISHED_KEY) || {}
        if (st[batchId]) {
          st[batchId].deliveredAt = Date.now()
          setMemberCache(PUBLISHED_KEY, st)
        }
        resolve({ ok: true, delivered: true })
      },
      fail: e => {
        const msg = (e && e.errMsg) || ''
        const cancelled = /cancel/i.test(msg)
        resolve({ ok: false, code: cancelled ? 'delivery-cancelled' : 'delivery-failed', message: cancelled ? '已取消分享（包仍在手机本机沙箱）' : msg })
      }
    })
  })
}

// 可验证 unlink（fail-closed + absent-file 语义）：
// 返回 { confirmed: boolean, reason?: string }
//   confirmed=true → 文件确认不在盘（本次删除成功 或 本来就不存在——重试清理合法）
//   confirmed=false → 文件可能在盘（IO 失败/不可判定——保留标志重试）
async function verifiedUnlink(path) {
  const manager = typeof wx !== 'undefined' && wx.getFileSystemManager ? wx.getFileSystemManager() : null
  if (!manager || typeof manager.unlink !== 'function') {
    return { confirmed: false, reason: 'fsm-unavailable' } // fail-closed：无 FSM 不假设删除
  }
  // ① unlink
  let unlinkErr = null
  try {
    await new Promise((resolve, reject) => {
      manager.unlink({ filePath: path, success: resolve, fail: e => reject(new Error((e && e.errMsg) || 'unlink failed')) })
    })
  } catch (e) {
    unlinkErr = e
  }
  // unlink 失败且明确 "no such file" → 文件本来就不在——重试清标志合法
  if (unlinkErr && /no such file|not exist/i.test(String(unlinkErr.message || ''))) {
    return { confirmed: true, reason: 'already-absent' }
  }
  if (unlinkErr) {
    return { confirmed: false, reason: 'unlink-io-failed' } // IO/权限——文件可能在盘
  }
  // ② unlink 回调成功 → stat 确认
  try {
    await new Promise((resolve, reject) => {
      manager.stat({ path, success: resolve, fail: e => reject(new Error((e && e.errMsg) || 'stat failed')) })
    })
    return { confirmed: false, reason: 'still-exists' } // stat 成功——文件仍在（unlink 静默失败）
  } catch (e) {
    const msg = String((e && e.message) || '')
    if (/no such file|not exist/i.test(msg)) {
      return { confirmed: true } // stat 明确不存在——确认删除
    }
    return { confirmed: false, reason: 'stat-transient' } // stat 瞬时——不能确认（fail-closed）
  }
}

// 删除已发布包（unlink-first + truthful partial + 全程作用域守卫）：
// 设计（评审 P0 修复——marker-first 会在 unlink 失败+标志恢复失败时孤儿化 .mcpkg）：
// ① await 可验证 unlink（fail-closed；文件已不在盘=confirmed——重试清残留标志合法）
// ② 文件确认不在盘后 → 清标志；标志落盘失败 → partial（文件已删标志残留——重试可清）
// ③ 每个 await 后复核 epoch+四元作用域——切换后不写新成员命名空间
// ④ unlink 失败 → 标志+文件均保留（零副作用）
export async function removePublishedRecord(batchId) {
  const epochAtRemove = currentEpoch()
  const s0 = getSessionState()
  if (!s0.member) return { ok: false, code: 'unauthenticated-session' }
  const scope = { envId: CLOUD_CONFIG.envId, appId: CLOUD_CONFIG.appId, familyId: s0.member.familyId, memberId: s0.member.memberId }
  const stillMine = () => {
    if (currentEpoch() !== epochAtRemove) return false
    const sNow = getSessionState()
    if (!sNow.member) return false
    return sNow.member.familyId === scope.familyId && sNow.member.memberId === scope.memberId &&
      CLOUD_CONFIG.envId === scope.envId && CLOUD_CONFIG.appId === scope.appId
  }
  const store = getMemberCache(PUBLISHED_KEY) || {}
  const flag = store[batchId]
  if (!flag) return { ok: false, code: 'no-published' }
  if (flag.envId !== scope.envId || flag.appId !== scope.appId ||
      flag.familyId !== scope.familyId || flag.memberId !== scope.memberId) {
    return { ok: false, code: 'scope-mismatch', message: '该包属于其他家庭/成员——不可在此删除' }
  }
  // ① unlink-first：await 可验证 unlink（失败 → 标志+文件均保留，零副作用）
  const result = await verifiedUnlink(flag.path)
  if (!stillMine()) {
    // unlink await 期间切身份：不写新成员命名空间。
    // 文件确认已删→如实报 partial（标志保留原作用域——切回重试可清）；
    // 文件未确认→标志保留原样（文件状态不可知）
    if (result.confirmed) {
      return { ok: false, code: 'stale-session', partial: true, message: '备份文件已删除但会话已切换——标志保留在原身份下，请切回后重试清除' }
    }
    return { ok: false, code: 'stale-session', message: '删除期间会话切换——标志保留，文件状态待确认，请切回后重试' }
  }
  if (!result.confirmed) {
    // unlink 失败/不可确认 → 标志保留（文件状态不可知——stat-transient 时文件可能已删）
    if (result.reason === 'stat-transient') {
      return { ok: false, code: 'unlink-unconfirmed', message: '删除已发出但无法确认完成——标志保留，文件状态待确认（重试将区分已删/仍在），请稍后重试' }
    }
    return { ok: false, code: 'unlink-failed', message: '备份文件删除失败——标志保留，文件可能仍在手机本机沙箱，请重试' }
  }
  // ② 文件确认不在盘（本次删除成功或本来就不在——重试清残留标志合法）→ 清标志
  // fail-closed：getMemberCache 返回 null 可能是存储读/解析错误——不得当空对象
  // 替换整个 store（会抹掉其他已发布条目）
  const storeNow = getMemberCache(PUBLISHED_KEY)
  if (storeNow === null || storeNow === undefined) {
    return { ok: false, code: 'marker-read-failed', partial: true, message: '文件已删除但标志存储读取失败——不做任何写入（保护其他条目），请重试' }
  }
  // 严格校验：非数组的纯对象才可安全 delete——数组/原始值/字符串（存储在 await 期间
  // 被篡改或格式漂移）一律 fail-closed 不写，防止空对象/错误形状覆盖其他已发布条目
  if (typeof storeNow !== 'object' || storeNow === null || Array.isArray(storeNow)) {
    return { ok: false, code: 'marker-read-failed', partial: true, message: '文件已删除但标志存储形状异常（非预期对象）——不做任何写入（保护其他条目），请重试' }
  }
  const safeStore = storeNow
  delete safeStore[batchId]
  if (!setMemberCache(PUBLISHED_KEY, safeStore)) {
    // truthful partial：文件已删但标志清除失败——标志残留可重试清理（文件不丢）
    return { ok: false, code: 'marker-persist-failed', partial: true, message: '文件已删除但标志清除失败——列表中可能仍显示，重试删除可清除' }
  }
  return { ok: true }
}

export { ContainerError }
