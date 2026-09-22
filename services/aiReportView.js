// family 云端报告记录 → 旧模板 AI 消费形状（detail 卡片 + ai-result 页共用）。
// 权威数据在 mc_reports：ai_result / ocr_result / vision_result 由 mc-tools CAS 写入；
// family 模式下旧本地库被 B3 隔离（恒拒写），本映射是解读读侧的唯一来源。
// wrapper 形状与 stores/report.js triggerAiPipeline 成功路径逐字段一致（含固定提示行）——
// 直连云端读出的结果与刚解读完成的结果在页面呈现同一形状。
export const AI_SUGGESTION_LINE = '以上内容为 AI 生成的一般性说明，不构成医疗诊断；请以原始检验单与主治医生诊断为准'

export function familyAiView(rec) {
  const empty = { ai_status: 'pending', ai_result: null, ocr_text: '' }
  if (!rec || rec.deleted) return empty
  const raw = rec.ai_result
  const text = raw && typeof raw.text === 'string' ? raw.text.trim() : ''
  if (!text) return empty
  return {
    ai_status: 'done',
    ai_result: { overall_summary: raw.text, suggestions: [AI_SUGGESTION_LINE] },
    // OCR 模式记录带提取原文（展示核对块）；视觉直读无 ocr_result → 空串（块不渲染）
    ocr_text: rec.ocr_result && typeof rec.ocr_result.text === 'string' ? rec.ocr_result.text : ''
  }
}
