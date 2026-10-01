# R3 部分成功的 await 中断窗口

当前部分重放修复覆盖了 stop 返回失败后 retry 分支迁接历史 ID；仍缺真实可中断窗口：

- 全离线 start+stop 已归档，history 行 `{recordId:null,localRef:L,synced:false}`，queue 有 L。
- retry 的 `flushContraPendingInner` start 成功后给 q.recordId 赋值并立刻 persistContra：磁盘 queue 已有云 ID，但 history 仍 null ID。
- stop await 尚未返回时进程退出/小程序被杀（这是“start 成功、stop 未完成”的正常中断边界），retry 的失败分支迁接尚未执行。
- 冷恢复新增 lookup 能用 localRef 找到 null-ID 历史行，但 `ex.synced===false` 直接 continue，不把 q 的云 ID 迁接到该行；下一次仅 pull 会加入同一云 ID ongoing 行并另保留 null-ID 本地 pending，再次双行。

请在 restore 的匹配 pending 分支也完成可证明 ID 迁接（仍 synced=false，不消耗 stop queue、不改变本地 payload）。补实际 start 成功、stop await 门控未返回时的耐久快照冷恢复反例，随后仅 pull 与重复 restore 始终单行；保留既有 stop 返回失败/nullable/成功收敛案例。不能只测 await 已返回失败并执行 retry 迁接之后的快照。若恢复迁接需要落盘，写失败也需保留本地输入与 truthful 未保存状态。

Codex 未运行反例或编写业务代码。完成更新交接后等待审核，不进入 R4；既有外部请求/真实发布/commit/push 禁止边界不变。
