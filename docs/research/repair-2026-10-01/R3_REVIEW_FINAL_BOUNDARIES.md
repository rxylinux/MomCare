# R3 冷恢复与页面边界复核

Codex 只读源码与既有反例，未执行测试。

1. **“未同步可见”断言仍不是页面证据。** R3二1 用 `contraUnsaved===true || contraStopQueue.length>=1` 作为可见证明；正常磁盘写成功时 contraUnsaved 为 false，而真实 contraction-timer 模板没有任何 pending/synced/队列/冲突行，时间线只显示时长/间隔/强度。另一个客户端终态冲突虽在 store 中保留了本地 synced=false，页面却与正常同步记录完全相同。必须增加实际页面可见的待同步/冲突说明（明确仍在本机保留，不能称已同步；若记录冲突码则说明需处理），并补真实页面消费反例，不用未渲染的 queue.length 代替可见性证据。

2. **history 的 100 条截断会丢掉 pending 展示/冷恢复。** `persistContraHistory` 无条件 `.slice(0,100)`，`finalizeLocalContra` 对 RAM 也 slice；pull 全量 server+keptPending 按 startTime 排序后，100 多个较新服务端记录可把更旧的本地终态 pending 挤出磁盘历史。restore 只分别读 history/queue，不从 queue 重建被截掉的 pending；重启后 pull 仅遍历 history 判断本地 pending，云端他方旧/冲突行又能顶替，队列中的本地输入被隐藏。A22 要求保留 pending，不能受普通已同步历史展示上限影响。保留所有未同步/冲突输入并在冷恢复由耐久来源恢复，普通已同步历史可保留既有上限。补 >100 新服务端行 + 更旧本地冲突 pending→pull→冷恢复→pull，以及 finalize 批量 pending 保留边界。

3. A17 新字节往返覆盖 vision/OCR/旧格式，但 `rpt-r3-plain` 没跑 ai.analyzeReport、期待 AI 字段不存在，并非 metadata 模式 AI 的字节证明。请补无 OCR/vision 的真实 metadata 分析并导出，断言 ai_result/provenance/coverage.mode=metadata 和 0/x 未覆盖清单实际在包正文，与真实 handler 输出一致。

等价终态提交以完整 endTime/intensity/notes 一致视为数据已收敛的方案可保留；不得把不同 payload 合并消失。完成更新 R3_HANDOFF 及日志/冻结摘要后等待审核，不进入 R4。禁止外部请求和真实发布等边界不变。
