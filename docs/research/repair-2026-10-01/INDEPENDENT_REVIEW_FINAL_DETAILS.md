# 独立验证补充轮最后细节（Codex 只读审核）

R1b/R2b/R4b 的补充源码与运行日志已审阅，先前对应缺口有实质证据。R3b 无 Buffer 完整导出、120 更晚云端+旧 pending 冷恢复以及病态分页亦有证据。业务源码仍冻结。以下三项必须在最终交接中落实，勿额外扩大修复范围。

1. **R3b 冲突页面反例目前可静默不执行。** `rp.every(x=>x.ok) || rp.some(x=>!x.ok)` 恒真；三层 if 在没有冲突时跳过断言；page/store2 来自不同 bundle/Pinia。新增独立必执行场景：用真实宫缩页面同一 store，在线 start 拿 recordId→离线 stop 留 pending/queue→云端同 ID 写不同 finished→真实 pull→无条件断言本地 notes/intensity/endTime 不变、conflict:true、队列保留，并断言真实 unfinishedList 包含此冲突行。必要时另走明确落盘后的页面冷恢复。任何前置失败都必须 fail，不能 if 跳过或只搜模板字符串。
2. **跳过场景应为 10 个，而非 1 个。** phase-b1 一条 SKIP 提示控制 10 个 maybePage noop 调用（881/921/951/1206/1252/1343/1403/1452/1479/1516），42 passed 不含它们。报告区分 1 条提示与 10 个未执行场景，列场景名；没有新增跳过，不需要恢复旧功能。每脚本 pass/fail/skip 汇总应采用场景数，而不是提示行数。
3. **过程退出码如实记录。** IV-R1 初轮 tee 后 `$?` 没捕获 Node 真实退出码；IV-R4 初轮仅保存 tail，完整日志缺失；IV-R1b run3 输出 6/0 但未退出，Codex 对专属 PID44375 发送 SIGINT 后退出 130。不可将这些过程计为完成通过。后续自然退出 0 的重跑是新证据，原日志保留。首轮完整回归 1104/1 的失败事实不可回填。

第二轮 v2 已再次触及命名边界：`phase-b2b1` 退出 **139**，日志停在“产检页1”之后，没有全套 footer。这不是一次完整通过。请保留 `suite-logs2/phase-b2b1.log` 和该轮退出码，记录准确 Node 路径/版本/架构并检查可取得的本机 crash 诊断（不要打印环境秘密），由 ZCode 区分运行时崩溃/测试句柄问题/业务生产路径失败，给出复现与处置证据；未找到确定原因时保留 unverified，不能用一次单跑绿称已解决。禁止为了消掉 139 跳过该套件或削弱其场景。

Codex 已只读抽取本机 crash 报告（未运行测试）：`~/Library/Logs/DiagnosticReports/node-2026-10-01-182521.ips`，时间 18:25:21 +0800，procPath `/usr/local/bin/node`，ARM-64，EXC_BAD_ACCESS/SIGSEGV，KERN_INVALID_ADDRESS at 0xe。faultingThread 0 顶部为 `v8::internal::ClearStaleLeftTrimmedPointerVisitor::VisitRootPointers`，随后 `InternalFrame::Iterate`、`Isolate::Iterate`、`Heap::IterateRoots`、`MarkCompactCollector::MarkRoots/MarkLiveObjects/CollectGarbage`。旧 `node-2026-10-01-144853.ips` 与 `node-2026-10-01-133746.ips` 顶部同函数。证据指向 V8 GC 内部崩溃，但尚不能判明根因。请使用已安装可用的本机稳定 Node 运行时（若有）或有依据的运行时处置继续验证，不安装/联网、不改全局配置，不将切换运行时的通过假装成原 runtime 已修复；明确实际路径/版本/参数与原 runtime 剩余限制。

本机依赖工具已返回可用备用 Node 路径 `/Users/daijianbo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`。Codex 仅验证文件存在，未执行该 Node。请 ZCode 检查实际版本/架构/项目兼容性，若合适可用显式绝对路径作为新的验收运行时，PATH 的调整仅限本次测试子进程（release 临时夹具内 npm/Node 子进程也要一致），不得改用户全局配置。保留原 `/usr/local/bin/node` V8 GC 崩溃为未修复限制，完成新运行时上的全套与 named b2b1/b3b-stage1 重复验证，不以单套复跑替代。

追加：v3 在备用 v24.19.0 上仍然于 b2b1 同一位置退出139（38行日志，最后产检页1），因此切换版本本身未解决此问题。请继续诊断该 Node/V8 运行模式和测试页 bundle 生命周期，允许在本次测试子进程使用有依据的 V8/JIT 参数做受控对照（例如解释执行模式用于区分优化器/GC路径），不改全局配置，不跳过场景；若采用某组参数作为本地验收环境，需要准确记录参数并让所有测试及临时发布夹具子Node一致，完成全套与命名边界重复。无参数运行仍必须列未修复限制，不能包装成默认运行时稳定。业务源码仍只读。

只改独立测试/报告。完成 R3b 修正后在最终测试版本重跑全套，使用新日志目录保留前轮，核对每脚本命令/进程退出码/pass/fail/跳过场景数，再重算生产和测试摘要（时钟测试那一项既有变更应明确记录）。业务源码与真实 state/manifest 必须不变；之前构建可引用同一业务冻结摘要，不需无故重跑。发生生产失败交回编码会话，不自行修改生产源码。完成更新 FINAL_VERIFICATION 并停止等待审核。
