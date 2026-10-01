# 独立验证覆盖审核（Codex，只读审核）

本记录是对新增独立测试的覆盖检查，尚未收到完整 FINAL_VERIFICATION。不是生产缺陷结论。全套旧回归重新通过仍不能替代任务书要求的独立反例；应在最终交接前补齐，业务源码继续冻结。

## 当前 R1 独立覆盖缺口

`phase-iv-r1.regress.cjs` 已验证身份隔离、在途切换、离线恢复与配额错误，但没有实际调用损坏/异构缓存隔离及最后终态写失败的生产分支。请新增独立反例：

1. 原始缓存字符串包含空白、指数/大整数或畸形 JSON，实际 restore/freeze/quarantine 后备份必须等于原始字节；备份写失败时，经页面确认/重试也不能覆写原键。形状错误、异 scope history/journal/stopOp 不能被展示或发送。
2. 云端 finish/discard/stop 已确认，仅最后 active 清除写失败，随后用全新客户端冷恢复：不得复活 ongoing，也不得丢失终态恢复凭据。胎动和宫缩都覆盖，断言实际缓存及云端操作次数。
3. 同 scope 前台恢复时，最新未保存 RAM 草稿不能被较旧磁盘 active 顶替；实际页面消费的恢复说明须区分备份成功/失败和孤儿草稿，不能只断言 console 日志。

## 当前 R2 独立覆盖缺口

`phase-iv-r2.regress.cjs` 导出了 onAiCardTap/onReanalyze，但目前 A16 只写入报告并读 computed 文案，没有调用这些操作。请实际点击初次分析和过期重分析，经过真实页面函数→网关→生产 handler，断言调用次数、刷新后的报告状态与失败提示。另补附件变化/跨模式时旧 OCR 不被当成本次原文、历史提取明确来源未确认的页面断言。

## 当前 R3 独立覆盖缺口

`phase-iv-r3.regress.cjs` 当前 A18 的无 Buffer 反例仅执行 shape guard；应补合法多字节报告在无全局 Buffer 环境走完整导出链并解码目标包。A22 的 >100 记录与本地 pending 是不同子夹具，应在同一夹具中使用 >100 条更晚云端记录和更旧 pending，拉取及冷恢复后 pending/队列仍保留且页面可消费未同步/冲突说明。还需独立构造病态 hasMore/nextCursor（缺失、重复、不前进）响应并断言无部分历史写入。

补充轮 `phase-iv-r3b.regress.cjs` 的⑥仍不能证明冲突页面：`rp.every(x=>x.ok) || rp.some(x=>!x.ok)` 对任何数组恒真；之后三层 `if (afterRetry&&recordId)` / `if(srv)` / `if(cRow&&conflict===true)` 会在没有冲突时直接跳过断言，而且 `page` 与 `store2` 来自两个独立 bundle/Pinia，后者变更不会自动刷新前者。请建立独立必执行的冲突夹具：在线 start 取得真实 recordId → 离线 stop 保持本地 pending/queue → 服务端同 ID 写不同 finished → 实际 pull → 无条件断言本地原输入、conflict:true、队列均保留 → 同一个真实页面 store（或明确落盘再页面冷恢复）消费 unfinishedList 包含冲突行。不能用条件跳过或仅模板字符串检查替代。

## 证据记录

首轮 IV-R1 的 NODE_EXIT 使用 tee 管道后的 `$?`，只证明 tee 退出码，不能倒填为 Node 真实退出码。日志中的 8/3 保留为失败事实；该轮真实 Node 退出码记录为未捕获。后续 pipefail 重跑可作为准确结果。夹具修正应解释原因并保留旧日志，不修改生产代码或已有安全测试期望。

## 当前 R4 独立覆盖缺口

R4 首轮 `tail | tee` 只保存末尾日志，该轮完整 stdout/stderr 未捕获，应如实记录。后续直接重定向的完整日志可作为重跑证据。

`phase-iv-r4.regress.cjs` 的包完整性目前只构造整个产物目录缺失、源 config 未入包和 shared 缺失。请补：目录可摘要但缺 index.js/package.json、已 hash 的旧 dist 在 assemble 后改变且部署选择重新计算、部署 CLI 进入时实际 staged 函数字节与 plannedDigests 一致。

CLI 契约独立反例目前主要是空输出、非零退出和 false 目标+true 邻行。请补真实 Node formatter 的列重排、正确目标索引带引号/首尾空白可认、非目标含目标词元或带前后缀不可认、其他列 true 而 success=false、非表格日志 true 不可认、前置信息日志之后合法表可认。不能仅引用编码轮场景。

部分失败 A25b 调整为无旧基线只证明缺项不冒充成功，不能替代有旧确认基线时失败项旧摘要保留的独立证据。请保留当前额外路径，另构造有旧确认基线且 current dist 已变化的部分成功，断言未成功项保持旧摘要、成功项更新、下一轮缺项仍必需；实际切 env 发布不能借用旧 env 的摘要。

全部逐脚本/构建结果仍待交接，本记录不预判其通过状态。

## 全套回归已出现的失败

本轮 `phase-i-detail-upload-time` 退出 1、4 passed/1 failed；原日志 `suite-logs/phase-i-detail-upload-time.log`：实际 updatedAt 比期望晚 1ms。源码读取显示测试替身 `Date.now = () => realNow() + clockOffset` 仍随墙钟推进，却用严格相等断言编辑时刻为创建时刻+1小时。可以由 ZCode 将该测试夹具时钟固定为同一基准再显式推进 offset，保留现有业务断言，不能放宽为“差不多”或改生产代码掩盖。保留首轮失败证据，记录测试文件摘要变化，重跑该脚本和最终全套确认；一次偶然单跑通过不足以消除该不稳定因素。

## FINAL_VERIFICATION 首稿计数错误

报告的 942 通过只解析“数字 通过/passed”，漏掉 `phase-a` 的“通过 72 项”、`phase-b1` 的“通过 42 项”、`phase-b2a` 的“通过 48 项”。首轮实际自报合计应为 1104 通过、1 失败，另有 1 SKIP（须独立检查是否已计入套件 pass，而不是擅自相加）。请从各完整日志解析两种语序，逐脚本单独列 pass/fail/skip 和进程退出码再汇总。70 脚本/69 退出 0/1 退出 1 是首轮事实；不能把复跑结果回填覆盖原失败。

补充静态证据：`phase-b1` 的唯一 SKIP **输出行**控制 `familyPageHasEditing` 为 false 时的 `maybePage` noop 分支；文件有 **10 个** `await maybePage(...)` 调用（行 881/921/951/1206/1252/1343/1403/1452/1479/1516）。因此“1 SKIP”只能描述提示行，不能作为跳过场景数。42 passed 不包含这 10 个 noop；请明确记录 10 个历史编辑器场景未执行及其名称，不能声称只有一个跳过场景。无需恢复已移除功能或改旧测试，只需准确披露。

## IV-R1b run3 挂起（不能计为完成）

该轮打印 6/0 后 Node 持续存活超过 5 分钟；Codex 只读 ps/source 核对发现真实页面 onShow 启动了 ticker，而测试没有执行 onUnload 清理。为终止已挂起的测试，Codex 对专属 `node tests/phase-iv-r1b.regress.cjs` PID 44375 发送 SIGINT（未启动任何测试或修改业务/测试代码）。本轮应保留中断退出码，不能因 console 6/0 计为成功。请 ZCode 在测试夹具里捕获并执行真实 onUnload 回调释放 ticker，或可靠清理由该测试创建的句柄，再重跑得到自然退出 0；不要用强制 process.exit(0) 隐藏泄漏。其他页面补充套件同样注意生命周期清理。
