# 定时推送线上故障：修复设计与 ZCode 编码任务

2026-10-01。用户确认已经发版；当前 HEAD c3ca436（体验版 1.1.25）。Codex 设计和审核，ZCode 编码和执行本地回归。不得把真实定时拒绝当作功能验收通过。

## 根因与纠正

mc-daily-push 当前只放行白名单 sendNow。平台定时调用没有用户 OpenID，因此在业务前被拒绝。之前 Codex 根据 SDK 内部读取 process.env，推断不能信任平台来源接口并要求全部拒绝，这是过度推断，造成线上功能退化。

微信官方文档明确把 getWXContext().SOURCE 描述为本次调用来源，并明确以 SOURCE === 'wx_trigger' 判断定时触发。实现应遵循平台 API 契约，在 exports.main 内每次读取，不自行缓存或从 event/process.env 拼造身份。SDK 内部使用环境变量本身不是否定该契约的证据。

官方依据（Codex 于本日通过 HTTPS 读取原网页）：
- https://developers.weixin.qq.com/miniprogram/dev/wxcloud/guide/functions/triggers.html
- https://developers.weixin.qq.com/miniprogram/dev/wxcloud/reference-sdk-api/utils/Cloud.getWXContext.html
- 微信官方 SDK https://github.com/wechat-miniprogram/wx-server-sdk （getWXContext API 与 SOURCE 字段）

本机完整网页和提取文本：/tmp/momcare-timer-hotfix-20261001/wx-{context,triggers}.{html,txt}。只读这些已提供的材料，不发业务请求、不安装或升级依赖。

## 最小修复契约

1. 进入 handler 时同步读取 SDK 当前 getWXContext()。精确 SOURCE === 'wx_trigger' 才进入定时分支，不接受 event.SOURCE/context 字段冒充，不用 includes、前缀、逗号链宽松匹配，不缓存跨请求身份。读取失败/来源缺失不授予定时权。
2. 可信定时来源之后，匹配已配置名称 daily-reminder 或 checkup-eve-reminder。名称只选择业务语义，不授予身份：前者日常、后者前夜；event.kind 不能把日常变前夜。未知名称、格式畸形、矛盾 action 等在读库/发送前明确拒绝。先核对平台真实 payload 契约，勿臆造不必要的必需字段导致真定时继续被拒绝。
3. 非定时来源继续执行 resolveCaller 白名单 + action:'sendNow'；家庭成员手动 kind:'eve' 保持有效。来源 wx_client/wx_client,scf/wx_devtools/wx_http 等携带 Type/TriggerName/SOURCE:'wx_trigger' 都不增加权限，外人零读库/发送。
4. 保留已有日期单一快照、明日产检过滤、配额处理、数据库错误语义、两人独立发送与分页修复，不回滚整个 R1。
5. 现有两个 cron 9:00/21:30 与名称必须核对。官方文档仍写单函数只支持一个触发器，而当前 config.json 含两个；本轮先修已部署入口，不擅自删改线上触发器。不以本地 config 的两条记录宣称云端两条都有效。如平台真实只保留一条，在交接中给出独立前夜函数/受支持调度的具体迁移方案及部署顺序，不带着未闭环配置宣称两类已恢复。
6. 更正函数说明、DEPLOY、R1 设计中旧的“只能禁用定时”结论；旧审核证据保留为历史，加纠正记录。不得宣称本地 mock 证明线上已恢复。

## 必须执行的本地验证

先在实际 handler 重现：SOURCE:'wx_trigger' + 两种真实 timer payload 因无 OpenID 被拒绝。保存修复前症状，再修生产代码。

至少覆盖：无 OpenID 的真实 SDK timer 日常实际发送；前夜明日有效产检实际发送；前夜无记录安静跳过；两个名称对应正确日期/文案；未知名称/畸形事件零业务；客户端与调用链伪造事件、event.SOURCE 与 event 上嵌 getWXContext 对象仍拒绝；白名单手动日常/前夜保持通过；SDK 来源异常、精确匹配；同一 handler 连续 timer→client→timer/current SOURCE 变化正确，不借用上次快照；所有已有推送分页/墓碑/错误/跨午夜边界。

已有 R1/独立测试把真 timer 拒绝当成功，必须更正对应断言，同时保留伪造 timer 拒绝断言，补正向业务执行计数及内容，不能只测 helper。运行所有直接相关推送回归、云组装与 git diff --check；冻结文件/命令/原始日志/退出码/计数/摘要。

## 交付和线上闭环

写 TIMER_HOTFIX_HANDOFF.md，说明修复前后、原始日志、文件摘要、最小部署包、需重新部署的函数及触发器核查步骤。给出不误发/不消耗配额的只读诊断方案与真实 timer 调用验证步骤；真实发送只能按用户明确同意的执行范围进行。

本任务仅允许本地编码和 mock 测试/组装。不得真实发布、commit/push、修改用户草稿、改真实 manifest/.trial-release-state、删用户数据、打印凭据/OpenID/正文或擅自补发漏掉的消息。完成停止等待 Codex 审核。Codex 准备可审核候选后与用户确认最终线上操作范围。
