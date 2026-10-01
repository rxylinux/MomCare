# R3 第二轮审阅（待当前交接后核对）

Codex 只读审阅，未自行运行反例。

1. **同 ID 服务端 finished 不等于本地 stop 已重放成功。** 当前 `pullContractions` 对 sv.status==='finished' 直接丢弃 synced=false 本地终态副本。另一客户端先以不同 endTime/intensity/notes 完成同一宫缩时，服务端 finished 可以来自其他 stop operation；本地待同步 stop 队列仍有自己的 payload，随后真实 retry 会 revision-conflict/invalid-state 失败。pull 却已用另一 payload 替换本地行并标 synced=true，隐藏了仍待处理的本地输入。不要仅凭状态 finished 判定本地操作已确认；保留本地 pending/冲突输入及可见状态，直到能证明对应 op 成功或用户明确解决冲突。补真实 start→本地 offline stop→另一真实 stop 抢先提交不同终态→本地 retry 拒绝→pull 的反例，断言本地 payload/队列/未同步标记和冷恢复均保留；普通本人重放成功仍能正常收敛。原 A22 要求保留本地 pending，同 ID 冲突不例外。

2. **A17 的合法字段未落到导出字节往返断言。** 当前实际 export 确实跑了 handler 和 validatePackage，但 A17 核对仅是 manifest.recordCount=4 + 再调用 guard 检查原 DB 对象合法，无法证明 AI/OCR/vision/provenance/coverage 实际被保存在导出正文且无丢失。请由 ZCode 从目标包解析实际报告正文（使用真实 canonical/header/段校验路径），与对应真实 handler 产出逐字段 deepEqual；覆盖新 vision、OCR、metadata 和旧格式，确保新版 OCR/vision digest/baseRevision 和 coverage.mode 都在。保留既有安全测试，不用“投影源码包含字段名”当字节证明。

首轮六项其余修复方向已在源码看到；最终交接需要准确命令/日志/冻结摘要。不要进入 R4，完成后等待 Codex审核。禁止外部请求和真实发布等边界不变。
