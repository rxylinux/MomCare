# R4 最后补充候选的明确阻断点（待当前冻结核对）

Codex 只读源码，未运行任何测试/业务探针。当前补充重写版有以下剩余点；最终若已自行修复，请提供反例证据。

1. **真实 console.table 的横向分隔行会截断解析。** `parseTableSuccessColumns` 在表头后用 `/[│|]/` 决定表体结束，但标准 Node console.table 表头下一行是 `├───┼───┤`，没有该字符，end 立即停在表头后，合法目标表项全部读不到。当前 mock 人工少了横向分隔行，不能证明真实契约。请由 ZCode 本地生成 `console.table({ [fn]: { success: true, filesCount: 1, packSize: 2 } })` 的标准输出供 mock 使用（只运行本地 Node formatter，不运行真实 CLI），解析器正确识别/跳过横向边框直到表底，定位真实 `(index)` 与 `success` 列，目标名只匹配 index 单元格，success 只接受布尔 true；信息/普通日志及 other-column 值不作确认。补真实 formatter 的合法 true/false、邻行、列重排、前置信息日志；无真实表头/目标名只在其他列/其他列 true 均 unknown。别继续手造省略结构的“类似表格”。

2. **包完整性仍漏了必需共享模块/配置。** 当前只看 shared 目录与 dailyTipCore.js，不核对源侧 cloud/shared 中实际打包的 auth.js/respond.js/config.js/constants.js 等文件。保留核心但缺 auth.js 仍通过合法 hash/完整性门，handler 却不能加载。请按 assemble 的真实复制清单递归验证必需 shared 文件、源侧存在的 config.json 及伴生物；dist 与 staged 都对应本次完整快照。补保留 dailyTipCore 但删 auth.js、源 config.json 缺包副本、伴生物缺失、合法完整包，所有拒绝分支 upload/deploy 为零。

3. **计划上传包摘要仍未写入。** 已有 plannedDigests/stagedDigests，只覆盖云函数；receipt 没有实际 `dist/trial-upload` 小程序包摘要，仍缺本次上传字节证明。上传包做物理排除/配置补丁后计算稳定摘要并与版本/项目目标绑定，上传前耐久记录、mock upload 进入时逐字节比对、upload 中断后保留；不能借云函数摘要代替小程序包摘要。

当前 `distFunctionDigestsSingle` 使用 `r4CreateHash()` 未传 'sha256'，Node createHash 必须传算法，任何 staged 计算都会抛错；测试正向路径应立即发现，若已自修保留完整正向证据即可。

以上细化原 final-details 的第1/2/3项，保持本次范围。由 ZCode 修源码、在独立临时夹具验证并更新最终交接/冻结摘要。Codex 只审核。禁止真实发布、网络请求/查询、真实 state/manifest 改写及项目 commit/push。
