# MomCare R1–R4 独立最终验证报告（FINAL_VERIFICATION·v3）

- 执行者：**全新 ZCode 独立验证会话**（与编码会话分离；不引用编码会话通过声明，全部反例自建）。
- 日期：2026-10-01 共三轮（第一轮初验 / 第二轮按 `INDEPENDENT_REVIEW_NOTES.md` 补全 / 第三轮按 `INDEPENDENT_REVIEW_FINAL_DETAILS.md` 收尾）。工作目录 `/Volumes/solid hard disk/github/rxylinux/MomCare`，HEAD `22be7b3ce3853ea4d0f49a6393b3793143904258`（三轮全程未 commit/push）。
- 输入门槛：R4_REVIEW_DECISION 允许进入；开工时 `R4_HANDOFF` §三 **6 个冻结 SHA256 与当前文件逐个一致**（release-trial `31781aeb…`、closure `b0841b6b…`、.r4-real-table `6af1c69f…`、gen-food-safety `f100c693…`、food-safety-data `32a5d672…`、phase-r4 `4362a96c…`），R1/R2/R3 各交接冻结摘要亦一致；第三轮结束时六摘要复核仍一致（`final-digests-round3.txt`）。
- 边界遵守（三轮相同）：零外部请求（无 npm view/install/pack、无 WebSearch/WebFetch/curl/wget/浏览器、无远程 git）；零真实微信 CLI/上传/部署/触发器；零真实云数据/AI 供应商外呼（A14/A15 用合成 Key + monkey-patch `node:https`）；零用户数据删除；真实 `.trial-release-state.json`（daf434e1…）/`manifest.json`（c0027a14…）原始字节三轮全程未变；所有 release 场景在自建临时夹具（`/tmp/momcare-iv4*fix-*`），真实 CLI 路径仅存在于生产脚本常量。
- 验证会话产出（仅新增/授权修改）：**8 个独立测试文件**——第一轮 `tests/phase-iv-r1/r2/r3/r4.regress.cjs`（35 场景）、第二轮+第三轮修正 `tests/phase-iv-r1b/r2b/r3b/r4b.regress.cjs`（17→18 场景，见 §二·R3 缺口修正）；**1 处授权测试夹具修正**——`tests/phase-i-detail-upload-time.regress.cjs` 时钟固化（§四）；生产源码零改动，66 个既有测试中其余 65 个字节级不变。

---

## 一、A01–A25 独立反例矩阵（第一轮，35 场景全过）

独立套件 `tests/phase-iv-r1.regress.cjs`（11）、`phase-iv-r2.regress.cjs`（7）、`phase-iv-r3.regress.cjs`（6）、`phase-iv-r4.regress.cjs`（11），**35/35 通过**（最终运行 node 退出码均 0：`iv-r1-run3.log`、`iv-r2-run2.log`、`iv-r3-run4.log`、`iv-r4-run3.log`；过程日志保留，其中失败均为本会话测试脚本自缺，见 §六）。

| ID | 生产入口 | 独立反例（自建数据/形态，与编码轮不同形） | 结果 |
|---|---|---|---|
| A01 | mc-daily-push `main`→`resolveCaller` | 客户端自报 openid/memberId/userInfo + Type/TriggerName/source/fromTrigger/role 混叠 ×（intruder/无上下文）10 组 + 有效 OpenID 错 APPID——全部拒绝，sends/pregnancyReads/checkupQueries 全 0 | ok |
| A02 | 同上 + `action!=='sendNow'` 拒 | 白名单 eve 正常；伪造 source/fromTrigger/role 不改 daily 语义（dateKey=今天）；`SENDNOW`/timer 无 sendNow → bad-action；intruder → not-family-member | ok |
| A03 | 同上（无平台凭据认证拒绝） | 合法调用后紧接 timer 形状仍拒（无跨调用授权遗留）；注入 `WX_CONTEXT_KEYS/TCB_SOURCE/WX_CONTEXT` 仍拒；DEPLOY.md 门槛在位 | ok（真平台定时身份 **unverified** §七） |
| A04 | toolsStore 逐键布尔消费 | **第 N 次写失败**（首写成功后续全败）×胎动/宫缩：local-persist-failed 绝不 offline-pending、草稿/journal/stopOp 保留、恢复同 opId 收敛不双写 | ok |
| A05 | `finalizeLocal*` + `restoreFromCache` | click+undo 离线冷恢复一次补齐；**仅 fetal_queue 键写失败**：active+journal 不清、冷重启同 opId 收敛 | ok |
| A06 | watch + 作用域键 | mama→logout→**papa 另一家庭**：不展示/零上传、legacy 五键原字节保留、mama 回归可恢复 | ok |
| A07 | captureSession/isSameSession | start 在途（门控）→ **同 bundle 内**切 papa → stale-session、内存清、papa 键零写、mama active 未污染、服务端恰 1 次 | ok |
| A08 | scope 校验 + 孤儿区 | familyId 空串 → scope-incomplete 零写零外呼；legacy 不认领；孤儿草稿 papa 不可见、mama 回接 | ok |
| A09 | `pendingCheckupOnDate` | 过期+明日并存仍发前夜；明日仅 done/属他家庭 → 安静 | ok |
| A10 | `walkPendingCheckups`+`dateSnapshot` | **252 墓碑**乱序翻页≥3 选昨日 overdue；缺 sortKey 混合 → scan-unstable；DB 异常可区分；**上海 2026-02-28 月末快照** tomorrow=03-01 | ok |
| A11 | `ai.analyzeReport` CAS | 在途真实 upsert **改附件集合** → ai-input-changed 零写入新附件保留；异常写者（不推版本/__v）摘要独立拒绝；provenance 成对落库 | ok |
| A12 | 同上 | 并发**后发先释放**：先者胜恰一次写入；在途真实 delete → not-found 墓碑保留零写入 | ok |
| A13 | ai_result + 响应 | DB/响应逐字段一致；编辑后 `ai_stale=true`（版本链）；旧结果不谎称（unknown coverage） | ok |
| A14 | `callDeepSeek`（真 https 注入） | `length` 带 id/object/usage 完整供应商形状且有正文 → ai-truncated、https 恰 1 次、零写入 | ok |
| A15 | 同上 | 自建 6 例：tool_calls/content null/choices 空数组/HTTP502/截断 JSON 流全受控失败零写入；stop 成功落库（model/coverage） | ok |
| A16 | coverage + 双真实页面 | 视觉 **7 附件 3/7**（两页面逐字）；元数据 5 附件 0/5 专项文案；旧格式"覆盖范围未知"无 x/y；过期页面可辨 | ok |
| A17 | 导出全链 | 真实产物 5 报告（vision 3/5、OCR 3/3、metadata 0/2、无 AI、旧格式）→ full + validatePackage + **自研解码器**目标包正文 deepEqual + guard 零告警 | ok |
| A18 | `guardReportAiFields`+restore 白名单 | 14 自建负例全拒；Buffer=undefined 下 guard 照常；restore 注入口 5 类未知键拒 | ok |
| A19 | problems→诊断包 | 混合合法 full；`debug_state` 金丝雀 → 诊断包、**原值不入任何导出文件字节**（审计点名违规键保留）；移除恢复 full | ok |
| A20 | `scanFilteredList` | 宫缩 **160 墓碑（扫描序在前）**+25 有效全读；efw **320 墓碑超预算**：空页+hasMore+游标，续拉 2 条全读 | ok |
| A21 | 同上 + 游标 scope | 同 startTime 6 条全读无重漏；**裸格式/跨集合/参数变化/跨家庭**四路 cursor-scope-mismatch；同 scope 续页正常 | ok |
| A22 | `pullContractions` | 105+30 全量去重；离线 pending pull 后保留；**同 ID ongoing 不顶替**、**同 ID 不同终态 → conflict 标记单行凭据在**；在途切身份中止零写新身份 | ok |
| A23 | `computeChangedFunctions` | 核心/共享/assemble→全部；可信基线+仅 food → 恰 mc-tools；未跟踪伴生 → 恰本函数；纯前端零必需 | ok |
| A24 | 名单门（dry-run） | 无基线 functions:[] 阻止；无 `--allow-incomplete`；all 放行；窄名单阻止点名；∪放行；幽灵拒绝 | ok |
| A25 | 收据时序（夹具 mock CLI） | 全成功：先落盘后提交、提交=最终态、干净、成功后零必需、triggers=unverified；部分失败（真实表目标 false+邻行 true→unknown 不中断）：确认项恰记、缺项下轮必需 | ok |

R4 边界（第一轮，均在 `phase-iv-r4`）：env 绑定（缺/空/未知/换环境不可借用；无 envId 上传前拒+零上传）；CLI 契约（空输出=unknown、退出 3+true 表=unknown、upload success+errCode=失败回滚）；上传前 pending+中断（磁盘=本次 pending 非 Old 完成态、planned/confirmed 可辨、**uploadPackageDigest 独立重算相等**）；包完整（缺整目录/源 config.json/共享模块 → blocked+零上传）；food 门（篡改保留标记/生成器语义变化 → 拒绝+回滚+零上传）；纯前端不清旧基线。

## 二、第二/三轮补充反例（按 INDEPENDENT_REVIEW_NOTES 与 FINAL_DETAILS 逐条，共 18 场景全过）

套件：`tests/phase-iv-r1b.regress.cjs`（6）、`phase-iv-r2b.regress.cjs`（3）、`phase-iv-r3b.regress.cjs`（3）、`phase-iv-r4b.regress.cjs`（5）——**17/17 通过，node 退出码均 0**（`iv-r1b-run4.log`、`iv-r2b-run2.log`、`iv-r3b-run2.log`、`iv-r4b-run1.log`；过程日志 run1/2/3 保留，失败均为测试脚本自缺见 §六）。

### R1 缺口（iv-r1b）
1. **原字节隔离**：corrupt fetal_active（空白+`1e21`+尾随垃圾）与异 scope contra_history（20 位大整数 `12345678901234567890`，JSON 往返必舍入）——隔离副本与原始字符串**严格相等**（证明备份用 raw 非重序列化）；畸形 journal（clicks:[null]）、非对象 history 条目、非数组 queue、缺 endTime stopOp → 全部不展示、零外呼（retry→recovery-blocked、toolsCalls 不增）、原键未覆写。
2. **备份写失败不覆写**：隔离副本写失败 → `corrupt-frozen`；真实 fetal-timer 横幅含"未能备份（原数据保留在原位、未被覆写）"且无"已隔离备份"宣称；`onAckRestore` 后自动同步恢复但**新会话写入仍被拒**（local-persist-failed、原字节一字未动）；存储恢复后 retry 落盘先补隔离（备份=原字节）才可写，草稿取得服务端身份并归档。
3. **终态清空写失败冷恢复（胎动+宫缩）**：在线全流程服务端确认终态后，仅最后 active=null 写失败 → 盘上留**终态标记+finish/stop 凭据**；全新客户端冷恢复：不复活 ongoing、无完整性警告、retry 零新增云端操作（opDocs 数不变、服务端版本不推进）、二次 stop 被拒（no-active-contraction）；retry 收敛后 active 合法清空（收敛≠丢凭据，凭据断言在 retry 前完成）。
4. **同 scope RAM 草稿**：离线+写失败 click 后，盘上为较旧副本；纯 store 层 restore：**RAM 引用保留**（未被盘上副本顶替）、click 与其 operationId 保留；真实页面 onShow（restore+自动重试）后 RAM 仍保留、未保存 click 收敛上云。
5. **页面三态逐字消费**（真实 fetal-timer 横幅）：已隔离备份（"异常数据已隔离备份"）/ 未能备份（"缓存数据损坏且备份失败"+"原数据保留在原位、未被覆写"）/ 孤儿内存恢复（"已从内存恢复——数据仍未保存到本地存储"，**不含任何备份宣称**、不落完整性闸）。

### R2 缺口（iv-r2b）
1. **页面点击·初次分析**：真实 detail.vue `onReanalyze`（pending 同管线）→ 网关（恰 1 次真实 `ai.analyzeReport`）→ 生产 handler 恰一次写入（revision 1→2、baseRevision=1）→ 页面刷新 done/非过期/新正文上屏 → 成功导航恰 1 次；已有新鲜结果时 `onAiCardTap` 只导航零追加分析。
2. **页面点击·过期重分析**：编辑致过期（4>1+1）→ 卡片 tap 只查看原结果；真实重分析锚定当前版本（恰一次写入 4→5、baseRevision=4）、刷新后非过期并导航；再制造过期+在途编辑 → 冲突 toast"报告在分析期间被修改"、保留上次有效结果（done+stale）、被拒正文不入库不上屏、失败不导航、服务端 revision 只含两次编辑。
3. **旧 OCR 来源页面断言**（真实 ai-result.vue）：OCR 首跑同输入 → `ocrText` 展示本次原文、无历史块；改附件+视觉重分析 → 旧 OCR 留库但 `ocrText=''`、`ocrHistory={text,unverified:true}` 独立通道；R2 前无 digest 历史对同样不标本次原文；模板断言两标题互斥、历史块仅无本次原文时渲染、来源未确认说明在位。

### R3 缺口（iv-r3b；冲突场景按 FINAL_DETAILS 第 1 条于第三轮重写为必执行）
1. **无 Buffer 完整导出链**：`global.Buffer=undefined` 下真实 `buildAndPublishPackage` 完成（full/complete/零 problems）——多字节正文（'娘胎监测解读…'×120）+多字节 note 经 validatePackage 复验与目标包解码**逐字段往返**；导出服务源码零 `Buffer` 引用静态复核。（无 Buffer 区间内测试侧不使用 Buffer——快照持原始 Uint8Array，恢复后再转。）
2. **同夹具 >100 云端+更旧 pending 全链**：同一夹具离线产生本地 pending（更旧）+ 120 条更晚云端记录 → pull：pending 终态凭据不被顶替、120 条全在、队列保留 → 落盘：**pending 全保留 + 已同步 ≤100** → 冷恢复：pending/队列凭据复原 → 再 pull：仍单行不顶替 → 真实宫缩页面：未完成列表恰 1 条纯待同步（模板含 待同步/⚠️冲突 两态文案）。
3. **病态分页零部分写**：`hasMore:true 无游标` / `hasMore:false 带游标` / `游标不前进`（150 条种子强制翻页）→ 全部 `pagination-error`、≤2 次调用不循环、**本地与盘上历史字节均零部分写入**（前后 JSON 严格相等）。
4. **冲突页面（第三轮必执行重写，替换原恒真断言+条件跳过的弱尾）**：同一真实宫缩页面 bundle 的**同一 Pinia store**——在线 start 取得服务端 recordId → 离线 stop 留 pending/队列 → 云端同 ID 写入不同终态（endTime+7777/intensity severe/notes 他方）→ 同一 store 真实 pull 后**无条件断言**：同 ID 单行、synced=false、**conflict=true**、notes/intensity/endTime 与本地完全一致、stop 队列保留；页面 `unfinishedList` 恰含该冲突行（recordId/conflict/notes 逐项断言）；随后**落盘后页面冷恢复**（全新页面实例 restore）：冲突行与队列凭据逐字段复原、新页面未完成列表再次消费该行。原弱尾（`rp.every||rp.some` 恒真、三层 if 可静默跳过、page/store2 跨 bundle）已删除。修正后套件 4/4 通过（`iv-r3b-run3.log`，node 退出码 0）；`tests/phase-iv-r3b.regress.cjs` SHA `5c9c5375…`（第二轮）→ `16afce4e…`（第三轮）。

### R4 缺口（iv-r4b）
1. **包完整性补充**：目录可 hash 但**缺 index.js**（补占位文件保持可摘要）/**缺 package.json** → blocked+点名+upload 零调用（标记文件）+`upload:blocked` 收据。
2. **已 hash 旧 dist 在 assemble 后改变**：基线=旧 dist 摘要、计划期 selected=[]；mock assemble 改写 mc-tools 字节 → **重核对补入**（selected=[mc-tools]、披露在场）、成功项入账**新**摘要、未部署项保留旧摘要。
3. **staged 字节=plannedDigests**：夹具内独立实现（与生产同式目录摘要）在部署 CLI 进入时核对 `MP_DIR/cloudfunctions/<fn>` 与 state.plannedDigests —— 恰对 selected 内函数各一条 `ok`。
4. **真实 formatter 边界**（本地 Node console.table，`--raw` 行集）：**列重排**（success 列最后）按列名确认成功；目标索引**带首尾空白**（formatter 引号包裹）规范化后精确相等可认；`not-mc-tools`/`mc-tools-copied`/`xmc-toolsy` 三类词元包含/前后缀**均不可认**；**其他列 true 而 success=false** 不认；**非表格日志含目标名+true** 不可认（unknown）；**前置信息日志后合法真实表**可认。
5. **有旧确认基线的部分成功与换 env**：基线=旧摘要 + 源码变更 + mock assemble 全量改写 dist；mc-schedule 部署 `[error]` 失败 → 前 3 项确认入账**当前**摘要、mc-schedule/mc-tools **保留旧摘要**；提交后闭包：缺项/不一致项（schedule+tools）仍必需；**实际切 env**（cloudConfig 改 envId-B）→ `envMismatch`、旧 env 摘要不可借用、无 `--functions all` 的发布被完整集合门阻止（exit 1）。

## 三、完整逐脚本回归

### 第一轮（70 脚本：66 既有 + 4 个 iv）——事实记录（含失败，不覆盖）

- **69 个退出码 0；1 个退出码 1**：`tests/phase-i-detail-upload-time.regress.cjs`（4 passed/1 failed，断言"updatedAt 前进到编辑时刻"差 1ms：期望 …574 实得 …575）。原始日志 `suite-logs/phase-i-detail-upload-time.log` 保留未动；单独复跑 ×5（`rerun-i-detail-upload-time-1..5.log`）全过——定性为**测试夹具时钟随墙钟推进**的时序脆弱性（非生产缺陷；详见 §四授权修正）。
- **计数勘误（v2 修正）**：v1 报告误合计 942 通过——解析只匹配"N 通过/passed"语序，漏掉 `phase-a`（"通过 72 项"）、`phase-b1`（"通过 42 项"）、`phase-b2a`（"通过 48 项"）。从各完整日志按两种语序逐脚本复核（`first-round-recount.tsv`）：**首轮实际自报合计 1104 通过 / 1 失败**（1104=942+72+42+48），70 脚本/69 退出 0/1 退出 1 不变。
- **SKIP**：全套唯一 SKIP 行在 `phase-b1`（套件源码内说明性 console 行——"依赖已移除的共享/私人编辑器"，对应场景经 `maybePage` 不注册不计数）：**未计入其 42 通过**，非独立计数场景。无其他 skip。
- 历史疑难套件复核：`phase-b2b1` 63/0、`phase-b3b-stage1` 82/0（首轮均在冻结源码上通过）。
- 逐脚本命令/退出码：`suite-summary.tsv` + `suite-logs/`（70 份完整日志）；控制台 `sweep-console.log`；脚本 `run-all-tests.sh`。

### 第二轮最终全套（74 脚本：66 既有[含 1 个授权夹具修正] + 8 个 iv 套件）

- **73 个退出码 0；1 个退出码 139**：`tests/phase-b2b1.regress.cjs` 于第 36 个场景通过后进程中断（日志截断、无任何 FAIL 行——与 R1_HANDOFF §十一.5/R3_HANDOFF §四 记录的"环境级段错误/串行中断"同类，非断言失败）。原始日志与退出码保留（`suite-logs2/phase-b2b1.log`）；单独复跑 ×3（`rerun2-b2b1-1..3.log`）**全部 63/0、退出码 0**。
- 套内自报合计（b2b1 因中断无汇总行不计入）：**1059 通过 / 0 失败**；计入 b2b1 单独复跑 63 项为 **1122 通过 / 0 失败**；SKIP 提示仍仅 phase-b1 一行（对应 10 个未执行场景，计数勘误见下）。
- `phase-i-detail-upload-time`（时钟修正后）套内 5/0 退出码 0——一次通过不再依赖运气；另有套外 ×8 稳定性复跑（`clockfix-i-detail-upload-time-1..8.log`）全 5/0。
- 逐脚本命令/退出码/计数：`suite-summary-v2.tsv` + `final-round-per-script.tsv` + `suite-logs2/`（74 份完整日志）；控制台 `sweep2-console.log`；脚本 `run-all-tests-v2.sh`。
- **跳过场景计数勘误（v3 修正，按 FINAL_DETAILS 第 2 条）**：`phase-b1` 的 1 条 SKIP **提示行**控制 **10 个 `maybePage` 未执行场景**（源码行 881/921/951/1206/1252/1343/1403/1452/1479/1516；42 通过不含它们；此前各轮报告"1 个 SKIP"按提示行计，应为 **10 个跳过场景**）。场景名清单见 `phase-b1-skipped-scenarios.txt`（B1-页面 ×3 + R2-页面 ×7，全部因依赖已移除的共享/私人编辑器——既有状态，无新增跳过）。第二轮 b3b-stage1 等其余套件跳过场景数均为 0。

### 第三轮最终全套（备用运行时 v24.19.0，74 脚本，日志 suite-logs3/ 与 suite-logs4/）

- 运行时与处置详见 §九-b。**v3 全套**：73 个退出码 0，`phase-b2b1` 再度退出码 **139**（崩溃点与第二轮相同——第 36 个场景"产检页1"通过后、执行"产检页2"期间；18:38:59 新 crash 报告与该次套内崩溃 mtime 精确对应，procPath 为**备用**二进制——证明切换运行时未消除该崩溃）；套内自报 1060/0（b2b1 无汇总行未计）。
- **v4 全套（最终验收运行时上的完整全套）**：**74/74 全部退出码 0**，含 b2b1 自然完成（63/0 带 footer）；自报合计 **1123 通过 / 0 失败 / 10 个跳过场景**（phase-b1 ×10）。
- 具名重复（备用运行时）：`phase-b2b1` 单独 ×9（含 v3 崩溃后追加 ×6）全部 63/0 退出码 0；`phase-b3b-stage1` 单独 ×3 全部 82/0 退出码 0（`named-repeat-alt/`）。
- 逐脚本命令/进程退出码/pass/fail/**跳过场景数**：`final-round4-per-script.tsv`（74 行）+ `suite-summary-v4.tsv` + `suite-logs4/`（74 份）；v3 对照 `final-round3-per-script.tsv` + `suite-logs3/`；控制台 `sweep3/sweep4-console.log`；脚本 `run-all-tests-v3/v4.sh`。

## 四、授权修正：`phase-i-detail-upload-time` 夹具时钟固化

- **授权依据**：INDEPENDENT_REVIEW_NOTES（用户指令允许且要求）："固定真实基准并显式推进 offset，保留原业务严格断言，不放宽预期，不改生产代码"。
- **修正内容**：`makeMockCloud` 原以 `Date.now = () => realNow() + clockOffset` 跟随墙钟——创建与编辑两次调用间事件循环走 1ms 即令 `updatedAt === created.updatedAt + offset` 的严格断言假失败（首轮 …574 vs …575 实证）。改为模块加载捕获 `REAL_NOW`、每个 mock 冻结单一基准 `frozenBase`、只经 `clockOffset` 显式推进；**全部业务断言原样保留（仍严格相等，含 `createdAt===updatedAt`、`|createdAt-t0|<100`、`updatedAt=created+3600000`）**；生产代码零改动。
- **SHA256 变化**：`tests/phase-i-detail-upload-time.regress.cjs` `cb91d78a7bd07855…` → `d1d54e32ed7a1e3d…`（修正后）。首轮失败证据（`suite-logs/phase-i-detail-upload-time.log`）与复跑日志均保留，未以复跑覆盖原失败。
- **稳定性**：修正后单独运行 ×8 + 最终全套 ×1，全部 5/0 退出码 0。

## 五、构建与静态检查

| 命令 | 退出码 | 说明 |
|---|---|---|
| `node cloud/assemble.mjs` | 0 | 11 函数组装（第一轮 `build-assemble.log`） |
| `npm run build:mp-weixin` | 0 | `DONE Build complete`（`build-mp-weixin.log`；sass legacy 弃用告警/循环 chunk 提示为既有现象） |
| `npm run build:h5` | 0 | `DONE Build complete`（`build-h5.log`） |
| `git diff --check` | 0 | 第一轮与第二轮均退出 0（`static-checks.log`、`git-diff-check-round2.txt`） |
| lint | — | **未配置**：package.json 无 lint script、仓库无 eslint/prettier/stylelint 配置——如实注明，不捏造 lint 通过 |

第二轮未重跑构建：业务源码摘要两轮间逐字节不变（见 §六冻结对比），第一轮构建证据继续有效（按审核指示不无故重跑）。未执行 `npm run release:trial`（真实发布——边界禁止）。

## 六、冻结前后摘要对比（生产源码未被任何测试改写）

- **业务源码（17 个生产文件 + assemble.mjs + gen-daily-content.mjs）**：基线→第一轮终→第二轮终→第三轮终，SHA256 **逐一相同**（含 R4 六冻结文件；`final-digests.txt`、`final-digests-round2.txt`、`final-digests-round3.txt`）。
- **既有测试 66 个**：65 个字节级不变；唯一变化为 §四授权的 `phase-i-detail-upload-time`（`cb91d78a…`→`d1d54e32…`）。未削弱任何旧测试期望、未改任何安全探针。
- **验证会话测试文件三轮内变更记录**：`phase-iv-r3b.regress.cjs` 第二轮 `5c9c5375…`→第三轮 `16afce4e…`（按 FINAL_DETAILS 第 1 条必执行重写冲突场景，去恒真/条件跳过）；其余 7 个 iv 套件自定稿后未变（摘要见 `final-digests-round3.txt`）。
- **真实 `manifest.json`**（c0027a14…）/ **`.trial-release-state.json`**（daf434e1…）：两轮前后原始字节**完全一致**（iv-r4/iv-r4b 套件首尾断言 + 进程外 shasum 复核）。
- **HEAD 仍为 22be7b3，零 commit/push**。验证会话新增文件：8 个 iv 套件 + 本报告；新增日志均在 `/tmp/momcare-independent-20261001/`（第二轮新文件不覆盖首轮）。

## 七、证据记录勘误（按两轮审核指正汇总）

1. **iv-r1-run1 的 `NODE_EXIT=0` 无效**：该轮用 `node … | tee log; echo $?`——`$?` 是 tee 的退出码。套件自报 8/3（3 失败按套件逻辑 `process.exit(1)`，node 真实退出码**未直接捕获**，几乎必然为 1 但记录为未捕获）；`iv-r1-run2.log` 起改用 pipefail/直接重定向，退出码准确（run2=1、run3=0）。8/3 失败事实保留（均为测试脚本自缺，见 §八）。
2. **iv-r4-run1 只存末尾**：该轮 `tail | tee` 仅保存末尾 60 行，完整 stdout/stderr 未捕获——如实记录；`iv-r4-run2.log` 起为完整重定向。
3. **v1 计数 942 误报**：见 §三勘误（实际 1104/1）。
4. **iv-r1b-run3 输出 6/0 但进程未自然退出**：页面 ticker `setInterval` 挂住事件循环（R1_HANDOFF §二已知现象），Codex 对该进程（PID 44375）发送 SIGINT 后以退出码 130 结束——**该轮不计为完成通过**；`iv-r1b-run3.log` 原样保留。有效证据为其后按 r1-tests 先例 stub `global.setInterval` 的 `iv-r1b-run4.log`（自然退出码 0，6/0）。

## 八、两轮独立测试脚本自缺修正（非生产问题，全部留痕）

第一轮（过程日志 iv-*-run1/2/3）：墓碑计数笔误；新 bundle 切身份致 epoch 不共享（改同 bundle confirmIdentity）；哨兵键时序；ai-result 页导出不存在变量；报告缺附件被拒；墓碑误用 `deleted:true`（生产过滤 `status:'discarded'`）及扫描序方向反置；金丝雀断言过严（审计按设计点名键名，禁的是原值）；R4 夹具未建基线/标记文件弄脏工作区/unknown 与 failed 路径预期混淆/纯前端误传 all。

第二轮（过程日志 iv-r1b-run1..3、iv-r2b-run1、iv-r3b-run1）：history 形状载体与生产状态标签不符（queue 数组失败按生产标 scope-foreign）；有效 JSON 误当 corrupt；终态后 retry 合法清空却在末尾断言旧凭据（移到 retry 前）；在线点击 journal 已被正常消费（改离线保留）；页面 onShow 自动重试先于断言（先纯 store 层断言再 onShow）；`restoreStorageIo` 时序错放；`Buffer.from` 误入无 Buffer 区间（改持 Uint8Array）；pending 行无 conflict 键（finalize 落盘形状，断言非 true 即可）；"游标不前进"用例需 >100 条才翻页；OCR 段未显式关 vision；页面 ticker `setInterval` 泄漏挂住进程（退出码 130，按 r1-tests 先例 stub `global.setInterval`，修复后退出码 0）。

以上修正均只改独立测试自身；生产源码零改动。

## 九、运行时核查与 b2b1 崩溃处置（第三轮，按 FINAL_DETAILS 第 3/4 条）

**本机 Node 运行时（实际路径/版本/架构）**：
- 原运行时：`/usr/local/bin/node`，**v24.12.0**，darwin/arm64。
- 备用运行时：`/Users/daijianbo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`，**v24.19.0**，darwin/arm64（同 major 更新 patch；可执行、可加载本项目依赖——esbuild 原生二进制为独立子进程、vite/sass 纯 JS，`phase-m` 兼容探针 5/0 退出码 0，`alt-compat-phase-m.log`）。
- PATH 调整**仅限本验证的测试子进程树**（v3/v4 全套与具名重复脚本内 `export PATH=<备用bin>:$PATH`；release 临时夹具内的子 Node（`node .mock-steps.mjs` 等）经继承的 PATH 同样落在备用运行时）；未改任何全局配置、未安装/联网。

**b2b1 崩溃取证与分类**：
- Codex 提供的三份既有 crash 报告（13:37:46 / 14:48:53 / 18:25:21）存在性已核实，且 18:25:21 报告中直接验证到顶部帧 `v8::internal::ClearStaleLeftTrimmedPointerVisitor::VisitRootPointers` → `MarkCompactCollector::MarkRoots/MarkLiveObjects`（V8 GC 内部，未打印任何环境秘密；procPath 按Codex 抽取为 `/usr/local/bin/node`）。
- **崩溃与轮次的精确对应（mtime 证据）**：第二轮全套（原运行时）`suite-logs2/phase-b2b1.log` mtime **18:25:21** = 报告 `node-2026-10-01-182521.ips`；第三轮 v3 全套（**备用**运行时）`suite-logs3/phase-b2b1.log` mtime **18:38:58** = 新报告 `node-2026-10-01-183859.ips`（EXC_BAD_ACCESS/SIGSEGV，同一 V8 GC 栈，captureTime 18:38:58.7525）。
- **崩溃点两次相同**：均在第 36 个场景"产检页1：权威 nextCheckup + week_label"打印 ok 之后、执行"产检页2：勾选按稳定 itemId"期间（该场景每次经 esbuild 重建页面 bundle——高分配 churn 属测试基建负载）。日志截断、**零 FAIL 行**、零生产路径错误。
- **分类**：**运行时崩溃**（V8 GC 内部 SIGSEGV），不是测试句柄泄漏类可定位异常、更不是业务生产路径失败（崩溃发生在场景断言之前的 V8 内部；两轮崩溃前 36 个场景全部 ok）。触发条件为全套串行上下文（四轮全套：v1 过 / v2 崩 / v3 崩 / v4 过——间歇性、同一点）；单独运行 12/12 全过（原运行时 ×3、备用 ×9）。
- **处置与验证**：切换到备用 v24.19.0 **未能消除**套内崩溃（v3 即崩溃）——不冒充已修复；最终以备用运行时完成 **v4 全套 74/74 退出码 0**（b2b1 自然完成 63/0）+ 具名重复（b2b1 ×9、b3b-stage1 ×3 全过）作为最终全套证据。
- **结论**：根因未判明（unverified）。原运行时 v24.12.0 的 V8 GC 崩溃**保留为未修复限制**；备用 v24.19.0 存在同类套内崩溃事实（v3），其 v4 全绿不构成对该运行时免疫性的证明。未跳过该套件、未削弱其任何场景。

## 十、剩余限制与 blocked/unverified（不把 mock 当平台证据）

1. **真平台定时 per-invocation 身份**：本地仅证明"无法证明来源时 fail-closed 拒绝"；真实定时触发仍被白名单拒绝——部署门槛未解除（R1_HANDOFF §九、cloud/DEPLOY.md）。**unverified**。
2. **真实数据库排序/缺 sortKey 语义**：mock 按"BSON null 最前"保守假设，未实测。**unverified**。
3. **真实供应商行为**：A14/A15 为契约本地实现+注入验证；真实截断率/错误码变体未外呼。**unverified**。
4. **真实 CLI 输出契约**：判定基于 Codex 只读本机 CLI asar 的静态证据；CLI 版本更新可能改变输出格式——unknown 不猜成功，部署后须控制台复核（formatter 边界反例用本地 Node 真实 formatter 生成，非真 CLI 输出）。**unverified**。
5. **触发器配置/云函数部署/上传**：零真实操作；`triggers.status='unverified'` 待部署阶段人工核对。**blocked（部署阶段）**。
6. **恢复语义**：mc-restore 为隔离冻结，不构成"完整恢复写入"验收（R3 裁定沿用）。
7. **宫缩同 ID 终态冲突的显式用户解决入口**未实现（冲突可见+重放如实失败的诚实限制沿用）。
8. **`phase-b2b1` V8 GC 崩溃（根因 unverified，未修复）**：原运行时 v24.12.0 与备用 v24.19.0 均在全套串行上下文间歇性崩溃于同一场景点（退出码 139，崩溃帧 `ClearStaleLeftTrimmedPointerVisitor`/MarkCompact；详见 §九取证与分类）。分类为运行时崩溃、非业务生产路径失败；两轮 139 事实与全部日志保留，未跳过未削弱；备用运行时的 v4 全绿不构成免疫证明。
9. RAM 孤儿草稿区仅进程存活期有效（既有披露）；`LIST_SCAN_PAGE=100` 假设单次 get 上限 ≥100（部署前按真实平台核对）。

## 十一、日志与证据索引（/tmp/momcare-independent-20261001/）

- 基线/冻结：`baseline-digests.txt`、`final-digests.txt`（第一轮）、`final-digests-round2.txt`（含 R4 六摘要复核、测试 SHA 变化）。
- 第一轮独立套件：`iv-r1-run3.log`/`iv-r2-run2.log`/`iv-r3-run4.log`/`iv-r4-run3.log`（终版）+ 各 run1/2 过程日志。
- 第二轮补充套件：`iv-r1b-run4.log`/`iv-r2b-run2.log`/`iv-r3b-run2.log`/`iv-r4b-run1.log`（终版）+ run1..3 过程日志。
- 时钟修正：`clockfix-i-detail-upload-time-1..8.log`。
- 第一轮全套：`suite-summary.tsv`、`suite-logs/`（70 份）、`sweep-console.log`、`run-all-tests.sh`、`rerun-i-detail-upload-time-1..5.log`。
- 首轮计数复核：`first-round-recount.tsv`。
- 第二轮全套：`suite-summary-v2.tsv`、`final-round-per-script.tsv`、`suite-logs2/`（74 份）、`sweep2-console.log`、`run-all-tests-v2.sh`、`rerun2-b2b1-1..3.log`。
- 构建/静态：`build-assemble.log`、`build-mp-weixin.log`、`build-h5.log`、`static-checks.log`、`git-diff-check-round2.txt`。
- 第三轮（FINAL_DETAILS）：`alt-compat-phase-m.log`（备用运行时兼容探针）；`named-repeat-alt/`（b2b1 ×9、b3b-stage1 ×3）；`suite-logs3/`+`suite-summary-v3.tsv`+`final-round3-per-script.tsv`+`sweep3-console.log`+`run-all-tests-v3.sh`（备用运行时全套，b2b1 139）；`suite-logs4/`+`suite-summary-v4.tsv`+`final-round4-per-script.tsv`+`sweep4-console.log`+`run-all-tests-v4.sh`（**最终全套 74/74 退出码 0**）；`phase-b1-skipped-scenarios.txt`（10 个跳过场景名）；`final-digests-round3.txt`；crash 报告对应关系：`suite-logs2/phase-b2b1.log`(mtime 18:25:21)↔`node-2026-10-01-182521.ips`、`suite-logs3/phase-b2b1.log`(18:38:58)↔`node-2026-10-01-183859.ips`。

## 十二、结论与移交

在冻结业务代码（HEAD 22be7b3，六文件冻结摘要三轮一致）上：
- A01–A25 及各轮边界独立自建反例**第一轮 35/35 + 第二/三轮 18/18 全部通过**（含两轮审核指出的全部覆盖缺口：原字节隔离、备份失败不覆写、终态写失败冷恢复、同 scope RAM、页面三态消费、页面点击初次/过期重分析、旧 OCR 来源、无 Buffer 完整导出、同夹具 >100 云端+旧 pending 冷恢复与页面、病态分页零部分写、**必执行的同页面 store 冲突消费+冷恢复**、包完整清单补充、staged=planned 字节、真实 formatter 六类边界、旧基线部分成功与换 env）。
- 完整回归（事实链如实分层）：第一轮 70 脚本 **1104 通过/1 失败**（失败为夹具时钟时序脆弱性，经授权修正，原证据保留）；第二轮 74 脚本套内 1059/0 + b2b1 套内 139 中断（单独复跑 3/3 过）；第三轮 v3（备用运行时）b2b1 再次 139 于同一点（切换运行时未消除）；**最终 v4 全套（备用运行时 v24.19.0）74/74 退出码 0，1123 通过/0 失败/10 个跳过场景**（phase-b1 既有 10 个 maybePage 未执行场景，非新增）。
- 构建 assemble/mp-weixin/h5 全部成功（业务源码三轮未变，构建证据持续有效）；`git diff --check` 干净；lint 未配置如实注明。
- 业务源码、既有测试（除授权修正 `phase-i-detail-upload-time` 一处并记录 SHA 前后值）、真实 state/manifest 三轮前后字节一致；零 commit/push、零外部请求、零真实 CLI/发布、零安装。
- 遗留限制见 §十：真平台定时身份/真实 DB 排序/真实供应商/真实 CLI 契约/触发器与部署均 unverified/blocked；**原运行时与备用运行时的 b2b1 套内 V8 GC 崩溃根因均未判明（未修复，不冒充已解决）**。

本报告不构成最终接受。全部证据（含三轮完整日志与运行时取证）交 **Codex 最终审核**后，方可给出本地结论。
