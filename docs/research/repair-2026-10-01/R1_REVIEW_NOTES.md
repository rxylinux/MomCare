# R1 审核记录（进行中）

以下是源码审阅发现，尚未由 ZCode 测试或修复验收。

## 首版推送改动需要补充

1. `walkPendingCheckups` 的旧记录缺 sortKey 分支仅合成 cursor，但下一次仍查询数据库 sortKey > cursor；没有 sortKey 的余下记录不能因此被完整扫描。不能把合成键描述成旧记录兼容证明。eve 可精确下推 dateKey 条件；daily 需保证实际扫描的唯一稳定序及旧记录完整性，无法保证则明确失败，不静默漏读。
2. `pendingCheckupOnDate` 在 row.dateKey > target 时提前结束，前提是实际扫描顺序与 dateKey 一致；对缺失或不一致 sortKey 不能假设。测试须包含 legacy 记录与边界上实际数据库比较语义。
3. `tomorrowKey()` 查询、`todayKey()` 构建内容及回复日期多次调用当前时钟；调用跨上海午夜时可能使用不同日历日。每次调用固定一个时间快照，整条提醒使用同一 today/tomorrow。

## 平台资料（Codex 阅读，ZCode 不应为此联网）

- [微信官方 SDK 源码](https://raw.githubusercontent.com/wechat-miniprogram/wx-server-sdk/master/index.js) 的 getWXContext（约 2871–2900 行）读取 process.env.WX_CONTEXT_KEYS 和 process.env.TCB_SOURCE；仅调用 getWXContext().SOURCE 不等于证明逐次调用来源没有环境遗留。此页面不证明当前部署 SDK 版本及具体 timer 来源值。
- [CloudBase 函数安全规则](https://docs.cloudbase.net/cloud-function/security-rules) 说明客户端 invoke:false 可拒绝非管理员客户端；规则不适用于管理 API 或定时器。可以作为日后独立 scheduler worker 的权限设计依据，但尚未读取当前环境配置，也未证明微信实际部署环境是否启用了该规则；不能将本地规则文件存在当云端权限已生效。

当前 timer fail-closed 属于临时止损，定时功能仍未闭环；部署前必须补足可信来源或隔离 worker 及真实权限验证。其他本地修复可继续审核，但不能将整个 R1 写成无条件功能验收完成。

## 首版 toolsStore 改动需要修复

4. watch 的 lastWatchedMemberId/FamilyId 初始化为 null，immediate:false。若 store 首次创建时已 confirmed mama，随后第一次版本通知就是 papa，则旧值仍为 null，分支不清 RAM。需要从创建时实际 scope 初始化或同步 immediate watch，并确保切换立刻失效；测试该首次通知情形，而不只测 mama 确认一次再切 papa。
5. `finalizeLocalContra/Fetal` 先清 active，再 persist 的多键顺序先写 active=null，后写 history/queue。离线 terminal 队列写失败时，旧磁盘 active 已被成功清掉；原 journal/stopOp 并未按注释所称“仍在盘”。宫缩 history 还不持久化，重启会彻底失去 stop。必须先确认完整 terminal 重试副本耐久成功，再清 active；失败保留内存及磁盘 active/terminal 恢复路径，不只是返回 error。注入最终 queue 写失败并冷重启验证能够继续同步同一 operationId。
6. `quarantineCorrupt` 返回失败被吞，`restoreFromCache` 只记警告；页面立即 retryPending 会把 unreadable/corrupt 当空状态覆写。隔离副本失败或读取异常时，禁止覆盖该原键及依赖它的状态，直到可读/明确恢复操作。不能用“尽力而为”代替保留用户数据。验证 corrupt+隔离写失败、getStorageSync 异常后 onShow retry，原字节不变、无上传。
7. `recordFetalClick/undo` 的异步队列在执行本地变更之前没有检查捕获 scope/session，先改旧引用再向 guard 写；所有 operation 的开始、各 await 后及后续外呼前要对同一捕获身份检查。`pullFetalSessions/pullEfwRecords` 只在全部页结束后检查，期间换身份会用旧 cursor 调用新成员：每页前后检查并停止。retryPending 不得在旧 await 返回后继续处理新成员队列。
8. `clearToolsMemory` 直接丢弃本地保存失败的内存草稿。应把未保存原 scope 数据保留到不可向新身份展示/上传的可恢复 RAM 区；重新确认原 scope 后恢复或明确提供恢复入口，不能以隐私清屏为理由静默丢输入。
9. `currentScope` 仅校验成员/家庭，没有 env/app 完整性校验；契约要求 scope 不完整不写不外呼。scope 键拼接还应避免歧义碰撞。恢复 history/queue/active 的不合法结构与异 scope 内容不能默认为空后覆盖，需一致隔离并报告。

以上需要 ZCode 实现并用本地生产 store/真实页面入口做反例；Codex 尚未执行任何测试，也不把静态检查当测试通过。
