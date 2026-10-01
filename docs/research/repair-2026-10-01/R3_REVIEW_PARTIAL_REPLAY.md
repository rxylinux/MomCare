# R3 部分重放与 nullable 输入核对

Codex 静态审核，未运行反例。当前新增队列重建还存在两个具体输入恢复问题：

1. **start 重放已获 recordId、stop 未完成时，冷恢复仍按 ID 重建双行。** 队列 q 已有 recordId，离线历史行仍是 recordId=null/localRef=q.localRef（ID 迁接只在整个 stop 重放成功之后执行）。restore 的 idx 查找分支 `q.recordId ? r.recordId===q.recordId : r.localRef===q.localRef` 在 q 有 ID 时不再考虑 localRef，于是忽略对应 null-ID 历史行并另建一行。真实链：全离线 start+stop→重放 start 成功但 stop 失败/中断→冷恢复→重复 restore/pull，仍应单行、payload/队列完整。ID 迁接必须覆盖这部分成功窗口，且不得提前标 stop 已同步。

2. **explicit null 被当缺值复活旧字段。** restore 两个重建分支用 `so.intensity !==undefined && so.intensity !==null ? so.intensity : q.intensity`，notes 同式。真实 stop 契约允许传 null 明确清空原有值（handler 检查 undefined；finalize 也只检查 undefined）。例如 start.notes='旧备注'/intensity='strong'，离线 stop.notes=null/intensity=null；history 未落盘或被旧版 synced 行遮住，cold rebuild 却重新显示旧备注/强度。保留 undefined 与 null 的区别，补真实 start→显式 null stop→history 缺失/同 ID 旧行→cold restore/retry/pull 的输入一致性断言。

完成聚焦回归和交接后等待审核，不进入 R4。其余跨日可见性、普通重放收敛、metadata 字节验证当前已看到修复方向。禁止外部请求、真实发布、commit/push 等不变。
