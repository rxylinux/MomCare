// family 云端报告记录 → 旧模板 AI 消费形状（detail 卡片 + ai-result 页共用）。
// 权威数据在 mc_reports：ai_result / ocr_result / vision_result 由 mc-tools CAS 写入；
// family 模式下旧本地库被 B3 隔离（恒拒写），本映射是解读读侧的唯一来源。
// wrapper 形状与 stores/report.js triggerAiPipeline 成功路径逐字段一致（含固定提示行）——
// 直连云端读出的结果与刚解读完成的结果在页面呈现同一形状。
//
// R2（2026-10-01）新增读侧字段：
// - ai_stale：过期判定按版本链而非 generatedAt——结果基于 baseRevision，其写入本身
//   使 revision=baseRevision+1；此后任何编辑都使 revision 更高 → 过期（基于旧输入，
//   建议重新分析）。旧结果无 baseRevision（历史版本）无法判定 → false 但覆盖未知。
// - ai_coverage：分析覆盖范围（含 mode：vision/ocr/metadata——页面按形态如实表述
//   未覆盖原因）。新结果携带服务端 coverage；旧结果无覆盖证据 → unknown:true——
//   页面不得把未知覆盖显示为完整分析。
// - ocr_text 溯源门控（R2 审核 2）：仅当 ocr_result 与 ai_result 属同一输入快照
//   （inputDigest 一致）才作为当前结果的"原文提取"展示；改附件后跨输入残留的旧
//   OCR 不当成本次内容。旧格式对（双方均无 digest）按同事务写入的历史行为展示。
export const AI_SUGGESTION_LINE = '以上内容为 AI 生成的一般性说明，不构成医疗诊断；请以原始检验单与主治医生诊断为准'

// F3：OCR 截断后缀——与 cloud/functions/mc-tools 的 OCR_TRUNCATED_SUFFIX 同串
// （云函数与客户端无共享模块通道，两侧常量需人工同步；语义变更须两侧同改）。
const OCR_TRUNCATED_SUFFIX = '…（OCR 文本超长已截断）'

export function familyAiView(rec) {
  const empty = { ai_status: 'pending', ai_result: null, ocr_text: '' }
  if (!rec || rec.deleted) return empty
  const raw = rec.ai_result
  const text = raw && typeof raw.text === 'string' ? raw.text.trim() : ''
  if (!text) return empty
  const base = Number.isInteger(raw && raw.baseRevision) ? raw.baseRevision : null
  const rev = Number.isInteger(rec && rec.revision) ? rec.revision : null
  const ai_stale = base !== null && rev !== null ? rev > base + 1 : false
  let ai_coverage
  // F3：OCR 截断证据——coverage.ocrTruncated（新结果）或 ocr_result.text 的截断后缀（旧结果按已知证据）。
  // 有截断证据时不得声称完整覆盖（complete 强制 false），页面据此披露"仅截断前内容已分析"。
  const ocr = rec.ocr_result
  const ocrTruncatedEvidence = Boolean(ocr && typeof ocr.text === 'string' && ocr.text.endsWith(OCR_TRUNCATED_SUFFIX))
  if (raw && raw.coverage && Number.isInteger(raw.coverage.totalAttachments)) {
    const analyzed = Number.isInteger(raw.coverage.analyzedCount) ? raw.coverage.analyzedCount : 0
    const ocrTruncated = raw.coverage.ocrTruncated === true || (raw.coverage.mode === 'ocr' && ocrTruncatedEvidence)
    ai_coverage = { analyzed, total: raw.coverage.totalAttachments, complete: analyzed >= raw.coverage.totalAttachments && !ocrTruncated, unknown: false, mode: raw.coverage.mode || null, ocrTruncated }
  } else {
    const fallbackTotal = Array.isArray(rec.attachments) ? rec.attachments.length : null
    ai_coverage = { analyzed: null, total: fallbackTotal, complete: false, unknown: true, mode: null, ocrTruncated: ocrTruncatedEvidence }
  }
  // 提取内容溯源（R2 审核 2 + 二审）：可证明同输入（双方 inputDigest 一致）才作为本次
  // "原文提取"展示。无 digest 的历史对不可证明同源——R2 前生产在 vision/metadata 成功时
  // 保留更旧 OCR（同事务重写不发生），"双方无摘要=同来源"不成立；未知来源不得标为本次
  // 原文，改走独立"历史提取（来源未确认）"通道（保留历史字段，不清除绕过）。
  // （F3：ocr 已在上方 coverage 段声明——此处沿用同一绑定）
  const ocrProven = Boolean(ocr && typeof ocr.text === 'string' && raw.inputDigest !== undefined && ocr.inputDigest === raw.inputDigest)
  const ocrHistory = !ocrProven && ocr && typeof ocr.text === 'string' && ocr.text.trim() !== ''
    ? { text: ocr.text, unverified: true }
    : null
  return {
    ai_status: 'done',
    ai_result: { overall_summary: raw.text, suggestions: [AI_SUGGESTION_LINE] },
    // OCR 模式记录带提取原文（展示核对块）；视觉直读无 ocr_result → 空串（块不渲染）；
    // 跨输入残留与来源未确认的历史提取 → 空串（不属于本次结果，历史内容走 ocr_history）
    ocr_text: ocrProven ? ocr.text : '',
    ocr_history: ocrHistory,
    ai_stale,
    ai_coverage
  }
}
