# ZCode R1 编码任务

用户明确授权本机 ZCode 编码和测试，Codex 只做设计及审核。现在执行 R1，不只是输出建议。

工作目录 `/Volumes/solid hard disk/github/rxylinux/MomCare`；阅读 `docs/REPAIR_PLAN_2026-10-01.md`、`docs/REPAIR_DESIGN_2026-10-01.md`，落实 R1 A01–A10。暂不改 R2/R3/R4。读取实际生产源码，参考 `/tmp/momcare-research-probes-20261001.cjs` 与 `/tmp/momcare-research-tools-probe-20261001.cjs` 的旧反例。

先复现，再修改 production 与必要回归测试，运行针对性回归。特别检查所有胎动/宫缩操作、finish/stop/retry 的本地持久化错误、身份切换在途响应与真实页面错误提示，不可只修改 start 函数。现有 sessionService 的同成员复核语义要保持；新 watch 不要造成正常复核丢草稿。legacy 缓存保留隔离，不能删除或擅自迁移认领。多个 storage key 部分成功不得报告全成功，terminal 状态失败仍可恢复重试。

定时身份：查看本地 wx-server-sdk 与 CloudBase SDK 源码，记录可信 per-invocation 来源的证据；不能依据 event.Type/TriggerName 或可能残留的 process.env 授权。不允许绕过。无法证明则 fail closed 并明确记录 timer 未验收的部署门槛。允许人工白名单 sendNow。日期按上海，eve 精确匹配明日有效 pending，DB 异常别装无产检。

禁止真实云/微信/AI/网站请求、部署、commit、push、删除用户数据。模型推理是本次使用 ZCode 的授权工作；其余外部业务流量禁止。测试用本地 mock。若构建需要清理 dist，只允许生成产物范围，别关闭全局保护。不安装外部依赖。

执行纠偏：第一次会话调查中发起了 `npm view wx-server-sdk@latest`，Codex 已中断。续跑严禁 npm view/install/pack、curl、wget、浏览器、WebSearch/WebFetch、远程 git 等网络查询命令。不得再次全盘 find；在项目、已知本地缓存及应用 SDK 目录做限定读取。无本地 SDK 证据直接采用本设计允许的 fail-closed timer 方案，记录待平台验收，不再为寻找依据联网。优先完成实际修复。不要读取或打印任何 provider/token/key 原文。

完成写 `docs/research/repair-2026-10-01/R1_HANDOFF.md`，包含文件清单、实际设计、A01–A10 每项证据、命令/退出码/准确计数/日志路径、SDK 身份依据、未完成限制。给源/测试 SHA256 摘要。不要宣称 Codex 已审核。交接后停止，等待审核意见，不自行进入 R2。
