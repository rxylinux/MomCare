# R3 未完成输入的冷恢复和跨日可见性

Codex 静态审阅，未自行执行反例。当前最终边界实现已保留所有 pending 到磁盘，但两处生产路径仍会隐藏未完成输入：

1. **跨日 pending 从真实页面消失。** `recentContractions` 仍无条件过滤 `startTime >= Date.now()-DAY_MS`；新增待同步/冲突标签仅渲染这个列表。待同步或 conflict 输入超过一天后，即使 queue 和 history 都耐久，页面不再显示它，也没有独立的全部未完成输入提示。不能让未完成同步/冲突的披露随普通“最近一天”窗口消失。保持普通时间线/511 统计的时间窗，但通过独立 pending 列表或明确全部未完成输入入口/横幅保留跨日可见性。补真实页面消费者时间推进 >DAY_MS 后的 pending/conflict 案例；统计不把陈旧 pending 当最近一小时。

2. **队列重建按同 ID 存在跳过了权威本地输入。** restore 的新重建逻辑建立 history 里 recordId/localRef 的 seen，`seen.has(key)` 就跳过 q；旧版客户端/部分写入可留下同 ID 的 synced=true 云端他方终态 history 与未重放本地 stop 队列。冷恢复时该 q 仍待同步，却不覆盖/独立呈现 history 中的他方 payload，后续 pull 只遍历 history 的 synced=false 项，因此本地输入继续被隐藏。耐久 stop 队列是未完成输入来源，不能仅凭同 ID 行存在当作确认；核对对应 payload/未完成状态并重建本地 pending/冲突。补真实 start/offline stop/另一 stop 终态→模拟旧历史同 ID synced 他方行但 queue 保留→冷恢复→pull/retry，断言本地 notes/intensity/endTime 与待同步披露恢复、零队列丢弃；不是只测 history=[] 重建。

这些仍属于 A22 与原有页面同步进度要求。完成更新交接与聚焦回归后停止等待审核，不进入 R4；禁止外部请求、真实发布、commit/push 等不变。

3. **全离线终态重建产生双行。** `finalizeLocalContra` 创建历史 entry 时未保存 record.localRef；全离线 start→stop 后 recordId=null。冷恢复 seen 从 history 的 recordId/localRef 取键（这行两者皆无），队列 q 则有 localRef，于是同一个输入再次生成一行，原行也保留。需要稳定本地身份，finalize/持久化/恢复/合并一致使用 localRef（历史缺 localRef 时须按可证明对应关系迁接而不随意归并不同记录）。补全离线 start+stop→冷恢复→重复 onShow/restore→pull 的实际 store 反例，断言同一输入始终单行，queue 凭据不丢；批量全离线 pending 同样不翻倍。
