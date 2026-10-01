# 1.1.25 定时推送功能退化：审核纠正

2026-10-01，Codex。

用户已发布 1.1.25；当前 HEAD c3ca436。只读核对发布收据：upload=uploaded，11 个函数记录 deployed，触发器 status=unverified。此前最终审核关于未 commit/push/发布的记录是当时冻结状态，不能作为当前线上状态。

真实定时触发被无 OpenID 的白名单认证拒绝，这是线上功能故障，不是合格的修复行为。旧 FINAL_REVIEW_DECISION 中“本地候选通过”不足以体现核心功能失效，本项验收撤回，状态改为 targeted repair。R2–R4 和其他 R1 场景的历史冻结测试证据保留，不将其作为本项恢复的证据。

Codex 已通过 HTTPS 实读微信官方 Cloud.getWXContext 和定时触发器文档，确认官方契约：SOURCE 表示本次调用来源，wx_trigger 表示定时触发，SDK 上下文应在 main 内读取。之前因 SDK 内部读取 process.env 而断言平台没有可信来源，是未经充分验证的推断。没有发现客户端可控制 SDK SOURCE 的证据；不应以这个推断禁用产品功能。

采用 TIMER_HOTFIX_TASK.md：使用每次 handler 入口获取的 SDK SOURCE 精确判定真实 timer，再由允许的名称选择两种提醒；非 timer 保持白名单 sendNow，伪造 event 不获得权限。

官方文档仍列单函数单触发器，项目含两个，需要核对实际云端；当前收据明确未验证触发器。修复与组装完成后仍需重新部署云函数、确认实际调度和真实调用结果，方可认定线上恢复。用户数据、订阅配额与漏发提醒不得由测试擅自改写或补发。

官方链接与本机证据路径见 TIMER_HOTFIX_TASK.md；本轮本地编码和回归由可见 ZCode 客户端 MomCare 独立验证会话执行，Codex 只审核。
