# R3 交接记录（ZCode 编码与本地测试执行）

状态：**ZCode 已完成 R3 编码与本地 mock 回归（A17–A22 + 一审六项 + 二审两项 + 终审边界三项 + 冷恢复复核三项 + 部分重放两项 + await 中断窗口 R3中断 的修复与反例，共 21 场景）；未经过 Codex 审核，不称已验收。** 基线 `22be7b3`（R1/R2 候选之上继续，全部改动未提交）。R3 完成后停止，未进入 R4。R1/R2 既有门槛（真平台定时身份、数据库缺失 sortKey 排序、供应商真实外呼未验证）不变。

工作目录 `/Volumes/solid hard disk/github/rxylinux/MomCare`。全程本地 mock（真实 dist handler + mock 云/FSM/微信全局；AI 结果由真实 `ai.analyzeReport` 配 mock 提供方产出）；零外部请求、零 npm 操作、未部署、未 commit/push、未删除用户数据。原始日志 `/tmp/momcare-repair-20261001/`（本轮 `r3-run3.log`、`r3-related-*.log`）。

## 一、文件变更

- `services/mcpkgExportService.js` —— ①`REPORT_FIELDS` 纳入 `ai_result`/`ocr_result`/`vision_result`（与 mc-tools 真实写入 schema 一致，含 R2 provenance：inputDigest/baseRevision/coverage.mode）；②新增 `guardReportAiFields` 形状守卫（嵌套键白名单 + 类型 + 大小上限：text≤64KiB/8KiB、ID 列表≤20、digest 64hex、mode 枚举——未知嵌套键如未来供应商调试内部状态记 problem 降诊断包，不静默丢弃、不带病进 full）；③守卫导出供回归矩阵。
- `cloud/functions/mc-restore/index.js` —— 键级白名单同步（reports 顶层 + ai/ocr/vision 嵌套键 + coverage 嵌套键）；新增 `__validateRecordShapeForTests` 回归注入口。**恢复语义不变：隔离冻结（零写回实时集合）——AI 字段随记录字节原样冻结，不构成"完整恢复写入"验收（如实注明，见 §五）。**
- `cloud/functions/mc-tools/index.js` —— `contraction.list`/`efw.list` 改扫描游标分页（`scanFilteredList`）：按数据库实际扫描序（sortKey desc，写入已内嵌唯一 id 后缀 tie-breaker）逐页扫描后过滤；软废弃/sinceMs 下推为后置过滤；单次扫描预算 300 行用尽而页未满 → 返回可继续游标 + hasMore:true（页可空）；仅扫描自然到尾才 hasMore:false；游标未前进防御。
- `services/toolsStore.js` —— `pullContractions` 重写：遍历全部页（空页+可继续游标不误判结束）、按 recordId 去重、游标不前进/超页数受控失败、逐页前后身份校验（切换即 stale-session 中止）、**服务端视图与本地未同步 pending 合并**（终态凭据比对：一致→权威采纳+队列消费；不一致→冲突保留+打标）。终审补：history 落盘/RAM 截断改为 pending 全保留+已同步上限 100；restore 由 queue 重建缺失的未同步展示行；retry 遇 revision-conflict 给本地行打冲突标记。
- `pages/tools/contraction-timer.vue` —— 时间线行新增未同步/冲突两态标签（终审 1）：`synced===false && conflict` →"⚠️ 与其他设备的记录冲突：本机输入未同步，需处理"；`synced===false` →"待同步（本机保留，联网后自动重试；未同步到云端）"——不与已同步记录同观。
- 测试（1 新）：`tests/phase-r3.regress.cjs`（12 场景：A17–A22 6 场景 + R3 一审反例 6 场景）。

## 二、实际设计决策

1. **导出形状约束的位置**：类型/大小/枚举校验只在**导出侧**强制（`guardReportAiFields`）——与 mc-restore 既有裁定一致（恢复侧值类型不强制，只重施键白名单）；两侧嵌套键白名单逐字段同步（同一形状的单一事实来源为 mc-tools 写入路径，本轮以真实产物回归锁定）。
2. **"供应商秘密/调试内部状态不得导出"的实现**：未知嵌套键 → problem → 降诊断包（诊断包仍含记录字节供排查）——不是静默剔除。既有顶层未知字段保护（`guardUnknownFields`）与 restore 键白名单拒绝均未放松（A18/A19 反例锁定）。
3. **扫描预算与空页**：`LIST_SCAN_PAGE=100`、`LIST_SCAN_BUDGET=300`（≤3 次 DB get/调用——响应与耗时上界）。预算用尽 → `nextCursor=已检查的最后一行 sortKey` + `hasMore:true`，即使当前页为空；下一次调用从该游标严格 lt 续扫（无跳过：该行已检查过；无重复：唯一键+严格 lt）。扫描自然到尾（短页）才 `hasMore:false`。预算与数据尾端恰好重合时可能多一次空调用后终止——有界、如实。
4. **游标兼容与 scope**：游标格式不变（sortKey 字符串），旧客户端游标继续可用；查询恒带 familyId（+调用者白名单鉴权）——游标不可能跨家庭/跨作用域读数。
5. **pullContractions 本地 pending 合并**：`synced===false` 且 scope 匹配且 recordId 不在服务端列表的本地条目保留追加；其余以服务端视图为准（revision 权威）。排序按 startTime 降序重建。
6. **导出测试等级**：A17 用真实全链 `buildAndPublishPackage`（真实 handler 产出 AI 字段 → 完整导出 full → `validatePackage` 整包 canonical/digest 复验）+ 字段级 `guardReportAiFields` 对真实文档零告警；A18 负例矩阵走导出守卫 + restore 键白名单注入口（不经简化投影假替身）。

## 三、A17–A22 证据（生产入口 → 反例 → 日志）

| ID | 生产入口 | 反例（phase-r3，6 场景） | 结果 |
|---|---|---|---|
| A17 | 导出投影 `REPORT_FIELDS` + 全链 | 真实 handler 产 vision（3/4 覆盖+provenance）/OCR（带溯源）/元数据/无 AI/R2 前格式五类报告 → `buildAndPublishPackage` **full、complete、零 problems**；`validatePackage` 整包 canonical/digest 复验 ok、四报告全在包内；真实文档过形状守卫零告警 | ok |
| A18 | `guardReportAiFields` + restore 键白名单 | 正向 4 形状（新 vision/ocr/metadata + R2 前旧格式）全通过；负向 10 例（供应商调试嵌套键/text 超限与非串/digest 非 hex/baseRevision 负/mode 枚举外/coverage 未知键/included 非 true/pageFileIds 超限等）全拒绝；restore 注入口接受新形状、拒绝顶层与四类嵌套未知键；旧顶层未知字段保护仍拒 | ok |
| A19 | problems→诊断包路径 | 合法新旧混合（无 AI + 真实 AI + R2 前格式）导出 full；单条畸形（`debug_raw` 供应商调试字段入库）→ complete:false、packageKind:diagnostic、problems 如实含 `ai-shape:reports.ai_result`；移除畸形后同数据恢复 full。pending→诊断与在途切身份 fail-closed 由既有 b3b-stage1 C7/stale-session 场景覆盖（本轮重跑通过，未改其断言） | ok |
| A20 | `scanFilteredList`（contraction/efw） | 150 连续墓碑（扫描序在前）+30 有效宫缩：limit20 翻页全读 30 条（≥2 次调用、无重复）；efw 150 墓碑+3 有效全读 | ok |
| A21 | 同上 | 同 startTime 5 条（唯一键并列）limit2 翻页：5 条全读、Set=5 无重无漏；320 墓碑在前：首调用**空页 + hasMore:true + 可继续游标**，续拉后 5 条全读；includeDiscarded 全量路径 7 条恰读终止页 hasMore:false；游标恒前进断言 | ok |
| A22 | `toolsStore.pullContractions`（真实 store+handler） | 120 有效+30 墓碑：一次 pull 全量 120 条去重无重复；离线 start/stop 产生本地 pending → 联网 pull 后 pending 保留且服务端 5 条同在；第一页在途真实 confirmIdentity 切 papa → stale-session 中止、不再翻页、结果不写给新身份 | ok |

## 三点五、R3 第一轮审核意见（R3_REVIEW_NOTES）落实

1. **客户端 Buffer 依赖（R3一1）**：`guardReportAiFields` 字节长度改用共享严格 UTF-8 编码层 `encodeStrict`（孤立代理项按畸形拒绝不崩溃）；生产代码零 `Buffer` 引用（测试含去注释静态断言）。反例：全局 `Buffer=undefined` 下守卫照常——合法多字节文本（'汉'×21000=63KB）通过、超限（65538 字节）与孤立代理项拒绝；真实 handler 产物守卫零告警。
2. **非法嵌套内容不入导出字节（R3一2）**：守卫返回坏字段集合，reports 投影把违规对象**整体剔出**（`delete p[f]`）并记 `ai-excluded:...（原值未入包）`——原值绝不进入导出字节/目标文件/可分享产物，诊断包只携带可审阅排除记录（不是泄漏通道）。反例：`ai_result` 携带 `apiKey`/`debug_raw` → 降诊断包 + **目标文件整包字节级断言秘密串与调试状态零出现**；移除违规后同数据恢复 full（合法字段不是阻碍）。
3. **coverage 内部一致性（R3一3）**：coverage 提供时五必需字段齐全且 cross-field 一致——`analyzedCount === analyzedFileIds.length`、`分析+未分析 === totalAttachments`、两列表不相交、ID 无重复；`inputDigest`/`baseRevision` 三处均须成对出现。旧格式（整体无 coverage/provenance）兼容。反例 8 例畸形 coverage/provenance 全拒；真实 handler 输出通过。
4. **同 ID 云端旧 ongoing 不覆盖本地 finished pending（R3一4）**：pull 合并规则改为——同 recordId 且服务端仍 ongoing（stop 未重放）→ 保留本地终态 pending（endTime/notes/intensity 凭据）并剔除服务端旧行；服务端已 finished → 服务端权威（丢弃本地副本）；纯本地项保留。开发中调试抓出合并分支漏 push 的实现 bug 并修复。反例三段：云 start→离线 stop→仅 pull（不重放）→ 本地终态保留不双行；stop 重放失败后 pull → 仍保留；重放成功后 pull → 服务端 finished 权威、副本清除。
5. **异常游标不前进受控失败（R3一5）**：`scanFilteredList` 游标未前进返回 `{error}` → handler `fail('scan-unstable', ...)`（不返回部分结果、不伪装完整尾页/空页）；客户端 `pullContractions` 对 `hasMore:true 无游标` 与 `hasMore:false 有游标` 两类病态响应均受控失败（pagination-error），不写入"看似完整"状态。反例：lt 过滤失效的损坏库（Proxy 模拟索引异常）→ scan-unstable；病态分页响应 → pagination-error 且本地零写入。
6. **游标绑定查询范围（R3一6）**：游标格式改为 `<16hex scope>:<sortKey>`，scope=SHA-256(动作|家庭|集合|includeDiscarded|sinceMs) 前 16 hex。跨家庭/跨集合（contraction↔efw）/过滤参数变化/旧裸 sortKey 格式一律 `fail('cursor-scope-mismatch', ...)`（明确提示从首页重新拉取，绝不无提示复用排序边界——familyId 防泄漏不防漏读的问题由此关闭）。**兼容策略**：旧裸游标明确拒绝（不静默重新解释）；客户端只回传服务端游标，收到 mismatch 即受控失败。反例：A 家庭游标→B 家庭/efw/参数变化/裸格式四路全拒 + 同 scope 续页正常。既有旧测试均回传服务端游标，无需改动即通过。

## 三点八、R3 第二轮审核意见（R3_REVIEW_ROUND2）落实

1. **同 ID 服务端 finished ≠ 本地 stop 已确认（R3二1）**：pull 合并规则细化——服务端 finished 且**终态凭据（endTime/intensity/notes）与本地完全一致**才判定本地输入已完整反映（本人重放或等价提交：采纳服务端权威行、消费对应队列项与本地副本）；凭据不一致（另一客户端抢先不同终态）→ 冲突：本地 pending 与 stop 队列保留（未同步标记可见）、服务端他方行不顶替不并存，直到本人重放成功或用户明确解决（本人重放将 revision-conflict 如实失败）。反例①全链：云 start → 本地离线 stop（strong/mine）→ **真实 handler 他方 stop 抢先不同终态**（mild/other-client/endTime+12345）→ 本人 retry 被服务端 CAS 拒 → pull：本地 intensity/notes/endTime 全保留、synced=false、同 ID 单行、队列凭据在 → **冷恢复**（新客户端 restore）：队列+本地终态 payload 复原、重放仍如实失败、失败后本地输入不被隐藏。反例②等价提交：他方以完全相同终态先行 → pull 采纳服务端 synced=true 单行、队列项消费。本人重放成功收敛路径由 R3一4③ 继续覆盖（13 场景全过）。遗留：冲突的"用户明确解决"入口（显式丢弃本地凭据的 UI/动作）未实现——当前冲突态保持可见+重放如实失败，属诚实限制（见 §五）。
2. **A17 合法字段落到导出字节往返断言（R3二2）**：A17 场景现从**实际发布的目标包**解码报告正文（真实 header（magic/版本/manifest 长度）→ manifest → 按 files 段布局提取 domain-json 段；canonical/digest 已由 validatePackage 整包校验），与对应真实 handler 产出的 DB 对象**逐字段 deepEqual**——覆盖新 vision（含 coverage.mode='vision'/3-4 计数/analyzedFileIds/skippedFileIds、vision_result.inputDigest/baseRevision）、OCR（ocr_result.inputDigest/baseRevision、coverage.mode='ocr'）、元数据、无 AI、R2 前旧格式四+1 类；并断言不该有的字段不在正文。不再以"投影源码含字段名/manifest 个数/源对象 guard"充当字节证明（原三层证据保留为辅助）。

## 三点九、R3 终审边界意见（R3_REVIEW_FINAL_BOUNDARIES）落实

1. **页面可见的待同步/冲突标签（R3终1）**：真实宫缩页时间线行按 `synced/conflict` 显示两态说明——冲突（他方抢先不同终态）明确"本机输入未同步，需处理"；纯待同步明确"本机保留，联网后自动重试；未同步到云端"（不称已同步）。反例（真实 contraction-timer.vue bundle + 真实 store/handler 链）：冲突行（真实他方 stop 抢先 + 本人 retry 被拒打标）在页面 `recentContractions` 数据中 `synced=false && conflict=true`；纯待同步行未打冲突标；已同步行无标签；模板源码断言两态 v-if 条件与文案在位（可见性不再以未渲染的 queue.length 代替）。
2. **pending 不受已同步历史上限影响（R3终2）**：`persistContraHistory` 与 `finalizeLocalContra` 的截断改为**未同步/冲突行全保留 + 已同步行 100 条上限**；`restoreFromCache` 由耐久 queue 重建缺失的未同步展示行（覆盖历史部分写失败窗口：queue 幸存而 history 缺）。反例①：120 条较新服务端行 + 更旧本地冲突 pending → pull（保留+打标）→ 落盘核对（持久化含全部 pending 1 条 + 已同步 ≤100）→ 冷恢复（冲突凭据复原）→ 再 pull（仍不顶替、同 ID 单行）。反例②：满 100 已同步后离线归档新 pending（RAM 保留、总量 ≤101）→ 删除 history 键模拟部分写失败 → 冷恢复由 queue 重建展示行（endTime/notes 复原）→ 重放收敛成功。
3. **A17 补真实 metadata 字节反例（R3终3）**：A17 场景新增 `rpt-r3-meta`——真实 `ai.analyzeReport`（vision 关 + 无 OCR 提供方 + 2 附件）产出 coverage `{0/2, mode:'metadata', skipped:[f2,f3]}`；导出后从目标包正文 deepEqual 断言 `coverage.mode='metadata'`、0/2 计数、未分析附件清单在包内且与真实产出一致；metadata 无 ocr_result/vision_result。包内报告数 4→5（guard 清单同步）。

## 三点九五、R3 冷恢复复核意见（R3_REVIEW_RESTART_AND_AGE）落实

1. **跨日未完成输入从页面消失（R3重启1）**：新增 `unfinishedContractions` 独立列表（全部 `synced=false` 行，不受最近一天展示窗限制）；真实宫缩页新增"未完成同步的记录（N 条）"独立区块（含跨日说明与逐行两态标签——冲突/待同步）。511 统计仍只看最近一小时（`lastHourFinished` 不变——陈旧 pending 不入统计）。反例：25 小时前冲突行 + 2 小时前待同步行——时间线窗口内仅 1 条、未完成列表 2 条全在（跨日披露不消失）、`lastHourFinished=0`/均值 null（统计不受污染）；模板源码断言独立区块与条件在位。
2. **队列重建被同 ID synced 他方行跳过（R3重启2）**：重建逻辑改为三分支——history 缺该输入→重建；**同 ID 行 synced=true（旧版/部分写入遗留的他方终态）→ 以队列凭据替换为本地冲突行（`synced=false, conflict=true`，他方 payload 不顶替）**；本人 synced=false 行在场→不重复（防双行）。去重键 recordId 优先 localRef 兜底；无两键的旧行不参与归并。反例：真实 start→离线 stop→他方抢先不同终态→手工构造旧版形状 history（同 ID synced 他方行、无 localRef）+queue 保留→冷恢复：同 ID 单行恢复为本地冲突行（notes/intensity/endTime 全本地）、零队列丢弃；retry 被拒后 pull 仍不隐藏。
3. **全离线终态双行（R3重启3）**：两处修复——①`finalizeLocalContra` entry 补 `localRef`（稳定本地身份：持久化/恢复/合并一致使用）；②**重放链接**：离线 start 的队列项重放获得 recordId 后，按 localRef 把离线时创建的本地历史行（recordId=null）迁接为该服务端身份并标 synced（开发中调试抓出缺失链接导致的收敛后双行——6≠3，修复后单行收敛）。反例：3 条全离线 start+stop→冷恢复→**重复 restore ×3**（幂等）→3 条 pending 不翻倍、去重键唯一→pull 后仍单行→重放收敛后恰 3 行全 synced、无翻倍、队列清空。

## 三点九八、R3 部分重放与 nullable 输入核对（R3_REVIEW_PARTIAL_REPLAY）落实

1. **start 重放已获 recordId、stop 未完成的双行（R3重放1）**：两处修复——①retryPending 的 stop 失败分支增加**部分成功窗口迁接**：按 localRef 把离线历史行（recordId=null）迁接为重放获得的服务端身份并**落盘**（不标 synced——stop 仍未完成；开发中调试抓出迁接未持久化导致冷恢复仍读到 null-ID，已修复）；②restore 重建的 lookup 改为 **recordId 或 localRef 双键任一匹配**（不再因 q 有 ID 就忽略 localRef 对应的 null-ID 历史行）。反例全链：全离线 start+stop（strong/final-note）→ 重放 start 成功、stop 注定失败 → 冷恢复+重复 restore → 同一输入**单行**、历史行已迁接服务端身份、synced=false（不提前标完成）、stop payload 完整、队列保留 → pull 后仍单行本地终态 → 网络恢复完整重放收敛（单行 synced=true、endTime 一致；收敛判据按服务端身份——localRef 行被权威行采纳，服务端视图无 localRef 属正常）。
2. **显式 null 被当缺值复活旧字段（R3重放2）**：重建行统一走 `contraRowFromQueue(q, so, conflict)` 助手——`pickInput(stopVal, recordVal)`：**stopOp 字段 undefined=未提供（回退 record 值）；显式 null=清空（不复活旧值）**，与 handler/finalize 的 stop 契约一致（两者均只检查 undefined）。反例两路：①start 带旧值（旧备注/strong）→ 离线 stop 显式 null 清空两字段 → 删 history 模拟部分写失败 → 冷恢复 rebuild：notes/intensity 不为旧值、endTime 以 stopOp 为准 → 重放收敛后服务端行同样为清空值（服务端契约一致）；②真实云 start（有 recordId）带旧值 → 离线 stop 显式 null → 构造旧版同 ID synced 历史行（含旧值）→ 冷恢复：队列凭据替换为本地冲突行（单行、synced=false、conflict=true）、旧值不复活、endTime 以队列 stopOp 为准、队列完整。

## 三点九九、R3 await 中断窗口（R3_REVIEW_INTERRUPTED_AWAIT）落实

**start 成功落盘 q.recordId 后、stop await 未返回即中断的恢复迁接（R3中断）**：restore 重建的匹配 pending 分支（`ex.synced===false`）不再直接 continue——若 q 持有云 ID 而历史行仍 null-ID（localRef 对应），在此完成可证明 ID 迁接并**落盘**（`noteContraPersist(persistContra)`——写失败保留本地输入与 truthful 未保存状态）；迁接后仍 `synced=false`、不消耗 stop 队列、不改本地 payload。这覆盖 retry 失败分支迁接未执行的正常中断边界（进程退出/小程序被杀——stop await 永不返回）。反例（真实 stop await 门控未返回快照）：全离线 start+stop 归档 → 重放 start 放行、**stop 响应门控扣住**（await 挂起）→ 此刻断言耐久快照：queue 已落盘云 ID、history 仍 null-ID/synced=false（证明 retry 迁接确未执行）→ 以该快照冷恢复（不 retry）：**单行**、恢复侧迁接云 ID、仍 pending、payload/endTime 完整、队列不消耗 → 重复 restore ×2 幂等单行 → **仅 pull**：同输入单行持有云 ID、云端 ongoing 行不顶替、不双行、队列保留 → 第三客户端直接读到已迁接行（迁接持久化证明）→ 释放门控后完整重放收敛（单行 synced=true，成功路径不回归）。既有 stop 返回失败迁接（R3重放1）、nullable（R3重放2）、成功收敛案例全部保留通过。

## 四、测试证据（命令 / node 退出码 / 计数 / 日志 / SHA256）

命令 `node tests/<套件>.regress.cjs`（cwd=项目根；phase-r3 自行执行 assemble 加载真实 dist handler）。

| 套件 | node 退出码 | 通过/失败 | 原始日志 |
|---|---|---|---|
| phase-r3（本轮新增，含 R3 六轮审核反例共 21 场景） | 0 | 21 / 0 | /tmp/momcare-repair-20261001/r3-run23.log |
| 受影响旧回归 17 套（全部退出码 0）：e1-server 11/0、e1-client 7/0、e2-server 8/0、e2-client 3/0、e3-server 5/0、e3-client 5/0、r1-tools 29/0、r2-ai 12/0、b3b-stage1 82/0、b3b-stage2 85/0、b3b-stage2-cva 11/0、b3b-v20-interop 13/0、b3b-v20-forgedcanonical 8/0、b3b-v20-giantid 8/0、f-audit 5/0、g-server 14/0、g-vision 15/0、d-release-prep 13/0 | 0 | 全 0 失败 | r3-related-*.log |

无新增 SKIP；未修改任何旧安全探针断言。await 中断轮后重跑受影响旧回归 7 套全部退出码 0（r1-tools 29/0、e1-client 7/0、e1-server 11/0、e2-client 3/0、e3-client 5/0、r2-ai 12/0、f-audit 5/0——日志 r3ia-related-*.log）。部分重放轮见 r3pr-related-*.log；冷恢复复核见 r3rs-related-*.log；终审轮见 r3f-related-*.log；一审 19 套见 r3r-related-*.log（r1-tools 29/0、e1-client 7/0、e1-server 11/0、e2-client 3/0、e3-client 5/0、r2-ai 12/0、f-audit 5/0——日志 r3pr-related-*.log）。冷恢复复核 8 套见 r3rs-related-*.log；终审轮见 r3f-related-*.log；一审 19 套见 r3r-related-*.log（r1-tools 29/0、e1-client 7/0、e1-server 11/0、e2-client 3/0、e3-client 5/0、r2-ai 12/0、f-audit 5/0、i-detail-upload-time 5/0——日志 r3rs-related-*.log）。终审轮 8 套见 r3f-related-*.log；一审 19 套见 r3r-related-*.log（r1-tools 29/0、e1-client 7/0、e1-server 11/0、e2-client 3/0、e3-client 5/0、r2-ai 12/0、f-audit 5/0、i-detail-upload-time 5/0——日志 r3f-related-*.log）。开发中间态日志 r3-run1~13.log、r3-related-*.log、r3r-related-*.log、r3r2-related-*.log 保留为过程记录；最终状态以 r3-run8.log + r3r2 相关重跑为准。二审后重跑受影响旧回归：r1-tools 29/0、e1-client 7/0、e1-server 11/0、e2-client 3/0、e3-client 5/0、r2-ai 12/0、f-audit 5/0、g-server 14/0（退出码均 0）。批跑中 b3b-stage1 一次以退出码 139 崩溃（日志空——环境级段错误，非断言失败）且 i-detail-upload-time 一次 1ms 时序抖动（updatedAt 断言期望 1790840933339 实得 ...340）；两套单独重跑分别为 82/0、5/0（退出码 0）——与 R1 期 b2b1 串行异常同类，最终独立验证会话须在冻结源码上复核。一审后 19 套证据见 r3r-related-*.log。注：R3一2 的泄漏金丝雀串最初触发 d-release-prep 全仓密钥扫描（如实拦截），已改用不匹配扫描模式的标记串（`LeakCanary://vendor-secret-marker`），扫描器本身未动。

SHA256（shasum -a 256，2026-10-01，**R3 await 中断窗口修复后的当前状态**）：
```
2a3f37b9355c142bc7593c69658e17216b3d7f7fe9992965689da6820bc28218  cloud/functions/mc-tools/index.js
053072f98f14ee9c0c9a9b3881236b3661bcf45e018704ccaa8d44c7dc3a05af  cloud/functions/mc-restore/index.js
f3be4e4b34e1386a570885b852b44c6f9f0d3121f2be7cb488710cd7d920ba96  services/mcpkgExportService.js
c7bca51006909d738a62181881a290ad81169cc8a643c521b00cdb84342d8a2b  services/toolsStore.js
71628942bd6facc0dd189e293de4647c0fed3942c3ea5053c688a1892567c1bf  pages/tools/contraction-timer.vue
93898395ecd4755cf78a156cb00a5598347479f3c47364ec2a1a2174d248136b  tests/phase-r3.regress.cjs
```

（历史 SHA 演进：首轮→一审→二审→终审→冷恢复复核→部分重放见前注；本轮（await 中断窗口）仅变更 toolsStore 与测试。）

（历史 SHA 演进：首轮→一审→二审→终审→冷恢复复核见前注；本轮（部分重放核对）仅变更 toolsStore 与测试，contraction-timer 与冷恢复轮一致，mc-tools/mc-restore/mcpkgExportService 与二审起一致。）

（历史 SHA 演进：首轮→一审→二审→终审见前注；本轮（冷恢复复核）变更 toolsStore/contraction-timer/测试三件，mc-tools/mc-restore/mcpkgExportService 与二审起一致。）

（历史 SHA：首轮见前注；一审后 toolsStore `9faf8195…`；二审后 toolsStore `0b6d11d9…`、测试 `fee4cb4f…`（r3-run8 时刻）；终审变更 toolsStore/contraction-timer/测试三件，mc-tools/mc-restore/mcpkgExportService 与二审一致。）

（历史 SHA：首轮 mc-tools `228537ef…`、mcpkgExportService `781a781c…`、toolsStore `d2bfe9b1…`、测试 `d1f802ef…`（r3-run3 时刻）；一审后 toolsStore `9faf8195…`、测试 `db1d8947…`（r3-run7 时刻）；二审仅 toolsStore 与测试变更。）

（R3 首轮交接时历史 SHA：mc-tools `228537ef…`、mc-restore `053072f9…`（本轮未变）、mcpkgExportService `781a781c…`、toolsStore `d2bfe9b1…`、测试 `d1f802ef…`——对应 r3-run3.log 时刻状态。）

## 五、遗留门槛与诚实声明

1. **恢复不是完整恢复写入**：mc-restore 语义为隔离冻结（commit 只冻结+核验隔离记录，零写回实时集合）——新 AI 字段随记录字节原样保存，但"迁移入实时集合/合并恢复"仍属 out-of-scope 独立设计。不得暗示完整恢复已完成。
2. **mock 数据库语义**：扫描分页的排序/lt 过滤基于 mock（localeCompare 字符串序）；真实数据库 orderBy 对字符串 sortKey 的排序与 limit 行为未实测（同 R1 门槛）。`LIST_SCAN_PAGE=100` 假设单次 get 上限 ≥100（CloudBase 常规上限内）——部署前按真实平台核对。
3. 真实外呼/真机/部署相关门槛沿用 R1/R2（定时身份、供应商行为、订阅额度）。
4. 导出大小上界：AI/OCR 文本上限（64KiB/8KiB）为防御性边界（现网产出量级远低于此）；超限即降诊断包不截断——不丢字段也不带病。
5. A19 的在途身份切换导出中止沿用既有实现与既有 stage1 用例（未新增动态切换反例——导出侧切换语义本轮未改动）。
6. 宫缩同 ID 终态冲突的"用户明确解决"入口（显式丢弃/采纳本地凭据的动作与 UI）未实现——当前冲突态保持本地输入可见 + 本人重放如实失败（revision-conflict），解决路径属后续独立设计。

Codex 未运行任何测试、未修改业务代码；本文所有执行结果由 ZCode 产生，等待审核。
