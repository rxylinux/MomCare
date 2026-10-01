# R4 本地候选审核决定

2026-10-01：允许进入全新 ZCode 客户端会话的独立验证。R1–R4 整体最终验收仍待冻结业务代码的 A01–A25 独立反例、完整回归、assemble/小程序/H5 构建及静态检查。Codex 只读源码、测试、日志及摘要，未执行测试/业务探针、未编写业务代码。

本轮读审已覆盖：按逐函数确认摘要与部署环境计算闭包；无/旧/畸形基线保守处理；手工名单不能缩减、all 正常工作；新 assemble 后最终集合与产物完整性校验；实际 staged 部署目录与计划快照一致；真实 Node console.table 的横向边框、index/success 列定位、规范化后精确目标名、布尔 true 与进程/业务失败；CLI 无确认如实 unknown；真实 food 重新生成比对；云函数与小程序包的本次计划摘要独立于已确认部署；上传前 pending/partial 及中断恢复事实；旧确认摘要耐久合并、trigger 按最终集合重算；最终收据落盘后提交的脚本时序。所有非 dry-run 发布案例必须位于临时夹具，真实 CLI 未执行。

已读 ZCode `r4c-final.log`（24/0）、源测试反例及 5 套受影响旧回归；R4_HANDOFF 中 release-trial、closure、Node formatter 辅助、food 生成器及生成物、phase-r4 共 6 个冻结 SHA256 与当前文件逐个匹配。核对缺 auth.js/源 config.json 未入包拒绝、upload mock 实际 --project 目录摘要重算及中断保留的实际代码，不以旧的较弱场景替代证据。上述属于编码会话候选证据，独立会话须自行重建反例，不直接引用通过声明。

仍未验收的平台边界：真实定时 per-invocation 身份/触发器配置（当前定时入口拒绝，只有白名单 sendNow 可用）、真实数据库 legacy/缺排序键语义、真实供应商响应与真实云部署/上传。禁止据本地 mock 声称这些已确认。继续禁止真实发布、外部请求查询、用户数据删除、项目 commit/push；工作区变更保留待审。

独立会话按 `INDEPENDENT_VERIFICATION_TASK.md` 执行，生产源码冻结且只读；测试失败留原始证据后停止交回编码会话。全部业务源码和验证依赖（含 formatter 辅助）记录前后摘要；真实 manifest/state 原始字节保持不变。所有必要结果交 Codex 最终审核后才可给本地结论。
