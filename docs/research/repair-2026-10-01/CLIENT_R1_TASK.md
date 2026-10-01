# ZCode 客户端：接续 R1 修复与本地测试

用户明确授权你在本机 ZCode 客户端编码和测试，Codex 只负责设计与审核。现在直接执行，不只回复计划。

工作目录必须是 `/Volumes/solid hard disk/github/rxylinux/MomCare`。先确认 pwd/git status，基线 HEAD=22be7b3；若会话绑定别的目录，不改别的项目。当前有未提交的修复源码和新测试，是先前 ZCode 后台会话产生的半成品，保留继续修复，禁止回滚。后台会话已停止，不会并发编码。

必读：
- docs/REPAIR_PLAN_2026-10-01.md
- docs/REPAIR_DESIGN_2026-10-01.md 的 R1/A01–A10
- docs/research/repair-2026-10-01/R1_CODING_TASK.md
- docs/research/repair-2026-10-01/R1_REVIEW_NOTES.md（第一轮审核）
- docs/research/repair-2026-10-01/R1_REVIEW_ROUND2.md（当前阻断项，1–7 全部落实）

当前改动：mc-daily-push、toolsStore、两张 timer 页面及 phase-r1-push/tools 测试。第一轮审核已部分修复；第二轮发现旧 retry 跨身份继续处理新数据、RAM 草稿无法覆盖同 localRef 旧盘态、underscore 家庭 ID 被误拒、最终写失败标记/恢复警告未真实披露、恢复结构校验不足、推送测试证明不成立等。必须修生产路径并构造反例，不准改弱断言。timer 目前 fail-closed，属于定时功能未闭环的明确部署门槛，不能宣称真实定时提醒已修复。

原始日志 `/tmp/momcare-repair-20261001/` 可读；旧反例 `/tmp/momcare-research-probes-20261001.cjs`、`/tmp/momcare-research-tools-probe-20261001.cjs` 可读。已经跑过 push 专项 9/0，但不足以覆盖第二轮意见；tools 专项尚未验收。你负责新增、运行所有针对性反例和相关旧回归。全部测试只能本地 mock，不能发真实业务请求。

禁止 npm view/install/pack、curl/wget、WebSearch/WebFetch、浏览器网络查询、远程 git、真实云/微信/AI 外呼、部署、commit/push、用户数据删除。只使用既有依赖。普通测试构建不应触发网络；任何可能联网的脚本先审阅。官方 SDK 身份依据已经由 Codex 写入第一轮审核文档，不需联网查。

完成写 R1_HANDOFF.md：文件变更、实际决策、A01–A10 和两轮审核每项生产入口证据、准确命令/退出码/通过失败跳过数量/原始日志路径/源测试 SHA256、定时功能限制。不能写 Codex 已审核。R1 完成后停止等待审核，不自行进入 R2–R4。请在客户端简短说明当前做哪项，使用户看得到执行状态。
