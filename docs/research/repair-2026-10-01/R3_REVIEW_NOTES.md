# R3 静态审阅候选（首轮交接后审核）

Codex 未运行反例，以下来自当前生产源码，仍需 ZCode 复现的源码问题。

1. **客户端 export 新增 Node Buffer 依赖。** `guardReportAiFields` 用 `Buffer.byteLength`，文件为微信客户端 ES 模块，无 Buffer 导入/可靠运行时依赖，原文件已用严格 UTF-8 的 `encodeStrict`。Node 回归的全局 Buffer 会掩盖真微信导出在 AI/OCR 文本分支报 ReferenceError。用客户端已有编码层或等价无 Node 全局实现；ZCode 在明确无全局 Buffer 的生产导出环境复现并验证合法真实结果可导出，恶意代理字符/超限仍拒绝。
2. **非法嵌套结果只记 problem 却原样放入诊断包。** `guardReportAiFields` 返回 bad，但 reports project 仍 `pick(r, REPORT_FIELDS)`；该 pick 引用完整 `ai_result` 等对象。因此未知嵌套 `apiKey`/供应商调试状态虽导致 complete=false，却仍可能被序列化、发布和分享。源码注释“不入包”与实际行为不一致。总设计要求秘密/内部状态不得导出；不允许把诊断包当秘密泄漏通道，也不能静默删合法字段换 full。发现未知/危险结果时明确阻止发布，或采用可审阅的安全诊断元数据方案且说明未包含原结果，保证异常原值不会进入导出字节/目标文件/可分享产物。请用实际 export 入口核对未知嵌套标记字符串和危险键不入产物。
3. **覆盖形状缺少内部一致性**（待最终实现核对）。当前逐字段可选仅类型检查，`{ analyzedCount:100,totalAttachments:1,analyzedFileIds:[],skippedFileIds:[] }` 等不合法新结果可通过。需区分允许缺 provenance 的旧合法格式与提供 coverage 却缺必需字段/计数矛盾/ID重复等畸形结果；新 shape 与真实 handler 输出一致，旧格式保持兼容。不能把畸形 coverage 当完整证据。ZCode 自行设计真实生产导出与 validator 反例。

继续本轮编码测试；最终交接后由 Codex核对，不在此把静态候选当已执行失败。

4. **宫缩 pull 的同 ID 本地终态 pending 被服务端旧状态覆盖。** 当前 merge 只保留 serverIds 中不存在的 local pending：一个已经云端 start 的记录在离线 stop 后，本地 finished/synced=false 带 endTime/notes、云端仍 ongoing；pull 返回该同 ID 行时排除本地 pending，采纳为 synced=true ongoing。即使 stop queue 仍在，页面和持久化历史中的 recoverable 本地终态输入会被替换，违反 A22 的 pending 保留。请补真实生产 store“先云 start→离线 stop→仅 pull（不先重放队列）”反例，以及 stop 重放失败后 pull 的反例；保留本地终态 payload 和 truthful pending 状态，不能以旧云状态覆盖。

5. **异常扫描游标不前进被伪装为自然结束。** 首轮开发中预算漏用已自行修复，当前 `scanned` 已生效；该历史候选不再要求修复。但生产在 `scanCursor === prev` 时 `ended=true`，最终返回 hasMore=false，会把库/排序完整性异常伪装成完整尾页。应受控失败而非接受部分列表。客户端对 `hasMore:true` 却无 nextCursor 等不一致响应也不应 break 并写入 apparently complete 状态；ZCode 补实际入口异常游标反例。
6. **游标仍为未绑定 scope 的裸 sortKey。** A21 任务明确不让旧 cursor 意外跨 scope：当前 contraction/efw handler 接受任意字符串 cursor，对另一家庭/域照用该排序边界，会无提示地从错误位置跳过数据（where.familyId 防泄漏但不防漏读）。说明兼容策略；推荐新 scope/域/查询参数绑定游标且旧裸游标明确拒绝/重新起始，不能无提示复用。前端现有 epoch 门仍需保留；ZCode 补真实 handler 另一 family/域/过滤参数游标重用反例。
