# ZCode 客户端：全新会话独立验证 R1–R4

用户要求 ZCode 负责编码与本地测试，Codex 只负责设计和审核。你现在是全新验证会话，生产源码只读，不直接引用编码会话的通过声明。

唯一目标工作区为 `/Volumes/solid hard disk/github/rxylinux/MomCare`。先用本地命令校验实际绝对目录、HEAD=22be7b3、R4_HANDOFF 的 6 个冻结摘要与文件一致；如目录或冻结不符立即停止并报告，不在其他同名 MomCare 路径执行。R4_REVIEW_DECISION 已允许进入本轮验证。阅读 `docs/REPAIR_DESIGN_2026-10-01.md`、各 R1–R4 REVIEW_DECISION、`docs/research/repair-2026-10-01/INDEPENDENT_VERIFICATION_TASK.md` 及最终业务源码，按任务完整执行。

先记录全部业务源码、当前测试与辅助依赖（含 scripts/.r4-real-table.mjs）的实际范围和 SHA256，以及真实 manifest.json/.trial-release-state.json 原始字节摘要。业务源码冻结，只允许新增或修改本地验证测试/记录，不得改生产代码或削弱旧测试期望。建立独立反例，实际走生产 handler/store/HTTP 响应解析/页面点击消费/导出 validator 和目标包字节/release 临时项目夹具；仅外部传输/CLI 用 mock。独立复核 A01–A25 与任务内各轮边界，特别是身份切换、冷恢复、存储第N次失败、AI CAS/截断/覆盖范围、合法 AI 导出往返及未知嵌套金丝雀、分页过滤长前缀、pending/冲突页面披露、真实 Node formatter/包完整清单/计划与确认摘要/upload 中断。

然后完整逐脚本执行当前全部 tests/*.regress.cjs，记录每个精确命令、node 退出码、pass/fail/skip 及原始日志；执行本地 assemble、build:mp-weixin、build:h5、git diff --check，lint 未配置则如实说明。已有本地依赖可用，允许本地 npm run 测试/构建脚本；禁止 npm view/install/pack、任何 WebSearch/WebFetch/curl/wget/浏览器/远程git查询、真实云健康数据/AI供应商请求、真实微信 CLI（即使连接 localhost）、真实上传部署/触发器操作、项目 commit/push、用户数据删除。所有 release 场景都在自己创建的临时项目，必须确认真实 CLI 已被替换，真实 state/manifest 绝不能备份删除再恢复来模拟。

平台未能本地证明的定时 per-invocation 身份/真实 DB legacy 排序/真实供应商和云发布明确 blocked/unverified，不把 mock 当真实平台证据。历史中断/时序失败须保留准确日志和退出码，不静默跳过；新失败停止并写出实际生产重现路径/期望/结果/影响文件，交回编码会话修复，禁止你自行修生产源码。

原始验证日志保存到新目录 `/tmp/momcare-independent-20261001/`。完成后重算业务源码及验证依赖摘要，证实业务源码和真实 state/manifest 未被测试意外改变，写 `docs/research/repair-2026-10-01/FINAL_VERIFICATION.md`，含 A01–A25 独立矩阵、完整逐脚本结果/汇总/skip/构建/静态检查、原始日志路径、冻结摘要前后对比和剩余限制。交给 Codex 最终审核，不自行宣布最终接受；完成或失败后停止等待审核。
