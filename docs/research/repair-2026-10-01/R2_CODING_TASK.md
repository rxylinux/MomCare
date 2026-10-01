# ZCode R2 编码任务（待 R1 审核后启动）

仅在收到 Codex 明确启动 R2 的指令后执行。用户授权 ZCode 编码、测试，Codex 设计与审阅。阅读总计划、设计 R2，落实 A11–A16，不能自称审核通过。

重点生产路径 `cloud/functions/mc-tools/index.js` 的 `ai.analyzeReport`、`callDeepSeek`，实际报告详情/AI 结果页面及客户端错误映射。旧反例 `/tmp/momcare-research-ai-probe-20261001.cjs` 可读，不要照抄测试替代独立反例。

现有 startTransaction 已有但 fresh 报告未与发起 AI 的快照比较。必须在事务内核对初始 revision 和输入摘要（note、dateKey、reportType、attachments 等真实 prompt 输入）；冲突返回受控失败，不写 ai_result/ocr_result/vision_result。AI 结果 provenance 在本次成功提交 revision 下保持可核对；客户端要识别以后编辑导致过期，不只靠 generatedAt。

DeepSeek 真实 https 解析路径 mock 响应的 finish_reason:length/stop/缺失/content_filter、HTTP 错误、畸形 response 均验收。不要只加强 __setAiMock helper。无完整终止不能保存新结果。保留现有安全提示，不打印 key 或真实健康资料。图像最大 3 页保持现有限额，但结果及实际页面必须披露 x/y 和未分析附件，旧结果未知覆盖不可称完整。

禁止 npm view/install/pack、curl/wget、WebSearch/WebFetch、浏览器、远程 git、真实云/微信/AI 外呼、部署、commit/push、用户数据删除。只允许本地 mock 测试与既有依赖。不修改 Codex 设计文件或旧测试断言来规避契约；新增字段需与后续导出兼容交接。

完成针对性回归，写 R2_HANDOFF.md：实际设计、变更、A11–A16 生产入口证据、命令/退出码/准确计数/日志路径/源与测试哈希、遗留门槛。结束等待审核。
