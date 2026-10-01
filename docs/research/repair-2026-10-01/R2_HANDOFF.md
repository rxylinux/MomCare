# R2 交接记录（ZCode 编码与本地测试执行）

状态：**ZCode 已完成 R2 编码与本地 mock 回归（A11–A16 + R2 第一轮审核三项 R2R-1/2/3 + 第二轮 OCR 来源边界 R2二 的修复与反例）；未经过 Codex 审核，不称已验收。** 基线 `22be7b3`（R1 候选之上继续，全部改动未提交）。R2 完成后停止，未进入 R3/R4。R1 决策文档中的既有门槛（A03 真平台定时身份、真实数据库缺失 sortKey 排序行为）未因 R2 改变——**不称全部修复**。

工作目录 `/Volumes/solid hard disk/github/rxylinux/MomCare`。全程本地 mock：未发起任何真实云/微信/DeepSeek/AI 请求（A14/A15 的真实解析路径用合成 Key + monkey-patch `node:https.request` 注入响应，零真实外呼）、未 npm 操作、未部署、未 commit/push、未删除用户数据。原始日志在 `/tmp/momcare-repair-20261001/`（本轮 `r2-run4.log`、`r2-related-*.log`）。

## 一、文件变更

生产源码（5）：
- `cloud/functions/mc-tools/index.js` —— ①`callDeepSeek` 完整性契约（finish_reason 等，A14/A15）；②`reportInputDigest` 输入快照摘要 + `ai.analyzeReport` 保存事务 CAS（A11/A12）；③ai_result 落库新增 `inputDigest`/`baseRevision`/`coverage`（A13/A16）；④受控错误码 `ai-input-changed`/`ai-truncated`/`ai-content-filtered`。
- `services/aiReportView.js` —— 读侧新增 `ai_stale`（版本链判定，不靠 generatedAt）与 `ai_coverage`（含 mode；新结果可核对；旧结果 `unknown:true` 不称完整）；`ocr_text` 溯源门控（可证明同输入才标本次原文）+ `ocr_history`（来源未确认历史提取的独立通道，R2 二审）。
- `pages/archives/detail.vue`、`pages/archives/ai-result.vue` —— 覆盖范围披露行（按 mode 区分：页数上限/未读取附件/覆盖范围未知）+ 过期提示与重新分析入口（detail）；ai-result 另有"历史提取（来源未确认）"独立标注块（R2 二审——仅当本次无已证明提取时展示，与"报告原文提取（OCR）"标题区分）。
- `stores/report.js` —— ①`triggerAiPipeline` 识别 `ai-input-changed` 冲突码并如实提示"结果未保存，请重新分析"（失败不消耗次数）；②R2 审核补：存在性检查按模式分流——family 正式态不再被 `_findReport`（B3 隔离恒空的旧本地库）拦成"报告不存在"，镜像确证已删除才本地拦截，未命中交云端 report-not-found 权威判定（修复正式态分析/重新分析入口的既有断点）。

测试（1 新 + 1 适配）：`tests/phase-r2-ai.regress.cjs`（12 场景：A11–A16 8 场景 + R2 一审反例 3 场景 + R2 二审反例 1 场景）；`tests/phase-g-vision.regress.cjs` 按 R2 二审契约更新一处旧断言（"无 digest 就透传"→"不标本次原文、走 ocr_history"——审核裁定的契约变更，非改弱；其余断言未动）。

## 二、实际设计决策

1. **快照 CAS（A11/A12）**：发起分析时捕获 `baseRevision`（报告 revision）+ `reportInputDigest`（SHA-256 于 dateKey/reportType/note 前 100 字/附件 fileId 列表——即真实进入 prompt 的字段）。保存事务内对 fresh 重算比对：`revision 不一致 || 摘要不一致` → rollback + `ai-input-changed`（带 currentRevision/baseRevision），零写入。revision 一并锚定的理由：非输入字段编辑（如归档状态）也推进版本，按"分析基于旧版本"如实拒绝（设计的"任何编辑即拒绝"）。反例 A11b 证明摘要独立于 revision 生效（异常写者不推进版本也拒绝）。
2. **并发（A12）**：两个并发分析读同一 base——先提交者胜（revision+1），后者事务内 revision 不匹配 → `ai-input-changed`；不互相覆盖、恰一次写入。事务提交本身还有 mock 的 `__v` 冲突语义兜底（与真实数据库乐观锁同构）。
3. **完整性契约（A14/A15，仅 DeepSeek chat/completions）**：HTTP 非 2xx → `ai-http-error:<status>`；JSON 解析失败 → `ai-malformed-response`；choices 缺失/空 content → `ai-empty-response`；`finish_reason !== 'stop'`：`length`→`ai-truncated`、`content_filter`→`ai-content-filtered`、缺失/其他→`ai-unknown-finish:<v>`。截断/过滤映射为独立受控码（调用方消息如实），其余并入 `ai-call-failed`（errMsg 带原因）。**不同供应商按各自真实完成字段设计**——本仓库现网唯一供应商是 DeepSeek（deepseek-flash/v4-pro 白名单），未对其他供应商做机械套用；接入新供应商时须按其真实终止字段另行实现（遗留说明）。
4. **provenance（A13/A16）**：`ai_result = { text, model, generatedAt, inputDigest, baseRevision, coverage }`；`coverage = { analyzedCount, totalAttachments, analyzedFileIds, skippedFileIds }`（视觉=直读页；OCR=提取文本页；元数据模式=0）。响应携带 `reportRevision`（=实际提交版本 base+1）、`baseRevision`、`inputDigest`、`coverage`。读侧 `ai_stale = rec.revision > baseRevision+1`（结果写入本身使 revision=base+1；此后任何编辑推高版本即过期）；旧结果无 `baseRevision`/`coverage` → 不判过期（无法判定不谎称）+ 覆盖 `unknown:true`。
5. **页数限额不变**：VISION/OCR 均 3 页/次（现有限值），本次只加披露不改额度；披露文案两页（详情卡片下信息行 + 结果页顶部横幅）与 `vision_result.pageCount`/`ocr_result.pageFileIds` 同源。
6. **R3 导出兼容交接**（按 R2 任务书要求声明，含 R2 审核后增补）：`ai_result` 新增 `inputDigest`（64 位 hex）、`baseRevision`（整数）、`coverage`（五字段对象：`analyzedCount`/`totalAttachments`/`analyzedFileIds`/`skippedFileIds`/`mode`，mode ∈ vision|ocr|metadata）；`ocr_result`/`vision_result` 写入时增补 `inputDigest`/`baseRevision` 溯源字段（既有字段不变）；响应新增 `baseRevision`/`inputDigest`/`coverage`。R3 报告导出白名单纳入这些字段时按此形状校验（未知字段仍拒绝的原则不放松）。

## 三、A11–A16 证据（生产入口 → 反例 → 日志）

| ID | 生产入口 | 反例（phase-r2-ai，8 场景） | 结果 |
|---|---|---|---|
| A11 | `ai.analyzeReport` → 事务 CAS（`reportInputDigest`/`baseRevision`） | A11：门控 AI 在途经**真实 report.upsert** 改 note → `ai-input-changed`、ai_result/ocr_result/vision_result 零写入、revision 保持编辑版 2、编辑内容保留；A11b：直改 note 不推版本（异常写者）→ 摘要独立拒绝 | ok |
| A12 | 同上（revision 锚定 + 删除分支） | A12①在途改附件集合（真实 upsert）→ 拒绝且新附件保留；②在途**真实 report.delete** → `report-not-found`、墓碑保留零写入；③并发两分析 → 先者成功、后者 `ai-input-changed`、恰一次写入 revision+1 | ok |
| A13 | ai_result 落库 + 响应 | A13：未变更输入成功——DB `baseRevision=1`/`revision=2`/`coverage` 与响应逐字段 deepEqual、inputDigest 64 hex；`familyAiView` 新鲜 `ai_stale=false` → 真实编辑后 `=true`；旧结果（无新字段）不谎称过期、覆盖 unknown；store 冲突分支源码断言 | ok |
| A14 | `callDeepSeek`（真实 node:https 路径，monkey-patch 注入） | A14：`finish_reason:'length'` **即使有正文** → `ai-truncated`、DB 零写入、revision 不动、`https.request` 恰被调用 1 次 | ok |
| A15 | 同上 | A15 矩阵 7 例：`stop` 正常成功并写入；finish 缺失→`ai-unknown-finish`；`content_filter`→`ai-content-filtered`；畸形 JSON；HTTP 500 供应商错误；空 content；choices 缺失——后六者全部受控失败零写入 | ok |
| A16 | coverage 落库 + `familyAiView` + 两真实页面 bundle | A16：视觉 5 附件 → coverage `{3/5, skipped:[f4,f5]}`、`vision_result.pageCount=3`、**真实 detail.vue 页** `aiCoverageNote='已分析 3/5 个附件（2 个未分析——单次页数上限）'`、**真实 ai-result.vue 页**同文案且可展示；A16b：OCR 5 附件同样 3/5（printedText 恰 3 次）；旧结果（R2 前格式）两页均显示"覆盖范围未知——不保证覆盖全部附件"且不披露 x/y 计数；过期结果（revision 7 > base 2+1）两页 `ai_stale=true` | ok |

页面级反例用 phase-i 同方案 bundle（剥 .vue import、shim onLoad/getCurrentInstance、注入 pinia），sessionService 直连 `__adoptSessionForTests` 确认态。

## 三点五、R2 第一轮审核意见（R2_REVIEW_NOTES）落实

1. **过期结果有可用重新分析入口（R2R-1）**：详情页 stale 提示区新增"重新分析"按钮（`onReanalyze`）——走与 pending 相同的网关管线（triggerAiPipeline→mc-tools）；卡片 tap 仍导航查看原解读（保留原结果）。修复配套既有断点：`triggerAiPipeline` 在 family 正式态被 `_findReport`（B3 隔离恒空的旧本地库）拦成"报告不存在"——现按模式分流（family=云端权威镜像；镜像确证已删除才本地拦截，未命中不猜、交云端 report-not-found 判定；legacy 行为不变，含 `_originUnverified` 闸）。反例（页面级：真实 detail.vue bundle + wxCloud 路由到真实 dist handler）：过期态 tap 卡片 → 仅导航、零网关调用；点重新分析 → 网关恰一次真实 `ai.analyzeReport`、服务端恰一次写入（baseRevision=当前版）、刷新后不再过期并导航新结果；在途再编辑冲突 → toast"报告在分析期间被修改…"、保留旧结果（仍 done+stale）、被拒结果未入库未上屏、失败不导航。
2. **跨模式/改附件的提取残留边界（R2R-2）**：`ocr_result`/`vision_result` 写入时增补 `inputDigest`/`baseRevision` 溯源；读侧 `familyAiView` 的 `ocr_text` 门控——仅当提取结果与 ai_result 属同一输入快照（digest 一致）才作为本次"原文提取"展示；旧格式对（双方均无 digest，R2 前同事务写入）保持历史展示行为。服务端保留历史提取数据不删（明确关联原输入而非销毁）。反例（真实 handler 模式切换链）：OCR 首跑同输入展示提取原文 → 真实 upsert 改附件 → 视觉模式重分析 → 旧 OCR 原样保留在库但读侧 `ocr_text=''`（不当成本次内容）、vision_result 带本次快照；再改附件 → 元数据模式 → 残留同样不展示；旧格式对仍展示。
3. **元数据模式未覆盖原因如实（R2R-3）**：`coverage.mode` 标注本次分析形态；两页文案按 mode 区分——`metadata` →"本次仅分析报告元数据：未读取任何附件（共 N 个）"（不再误标"页数上限"）；`vision`/`ocr` 未覆盖 → 页数上限文案（A16 的 3/5 断言不变）；`unknown`（旧结果）→ 不猜原因的"覆盖范围未知"。反例：5 附件 + vision 关 + OCR 未配置 → coverage `{0/5, mode:'metadata', 全部 skipped}`，真实详情页与结果页文案逐字断言。

## 三点八、R2 第二轮审核意见（R2_REVIEW_ROUND2）落实

**历史无 digest 的 OCR 来源边界（R2二）**：审核确认 R2 前生产在 vision/metadata 成功时保留更旧 OCR 且重写 ai_result——"双方无 digest = 同事务同来源"推断不成立（一审 §三点五.2 中该表述作废）。修复：`familyAiView.ocr_text` 仅在**可证明同输入**（双方 inputDigest 一致）时展示为本次"原文提取"；无 digest 的历史对一律不标本次原文，历史字段保留（不清除绕过）并经新增 `ocr_history = { text, unverified: true }` 独立通道披露；ai-result 页新增"历史提取（来源未确认）"独立标注块（标题与"报告原文提取（OCR）"区分、仅当本次无已证明提取时展示、说明"未能确认属于本次解读的输入（附件可能已变化）"）。反例（R2二）：按 R2 前生产可产生的历史形状构造（AI 较新无 digest/OCR 较旧无 digest/附件已变）——读侧 `ocr_text=''`、`ocr_history` 保留内容且 unverified；真实 ai-result 页面 bundle 断言本次原文块数据为空、历史块数据在；页面源码断言独立标题/条件渲染/来源说明在位；已证明路径（digest 一致）回归不受影响。detail.vue 不渲染 OCR 提取（无需改动）。phase-g-vision 一处旧断言按新契约更新（原断言即审核指出的无效边界）。

## 四、测试证据（命令 / node 退出码 / 计数 / 日志 / SHA256）

命令 `node tests/<套件>.regress.cjs`（cwd=项目根；phase-r2-ai 自行执行 `cloud/assemble.mjs` 组装 DIST 后加载真实 mc-tools/mc-reports handler 与真实页面 bundle，全部本地 mock）。

| 套件 | node 退出码 | 通过/失败 | 原始日志 |
|---|---|---|---|
| phase-r2-ai（本轮新增，含 R2 两轮审核反例共 12 场景） | 0 | 12 / 0 | /tmp/momcare-repair-20261001/r2-run8.log |
| phase-g-server（冻结源哈希机制为运行期并发编辑检查——本轮源演进后整套重跑） | 0 | 14 / 0 | r2-related-phase-g-server.log |
| phase-g-vision | 0 | 15 / 0 | r2-related-phase-g-vision.log |
| phase-g2-local-migrate | 0 | 7 / 0 | r2-related-phase-g2-local-migrate.log |
| phase-i-detail-upload-time（detail.vue bundle） | 0 | 5 / 0 | r2-related-phase-i-detail-upload-time.log |
| phase-i-components | 0 | 33 / 0 | r2-related-phase-i-components.log |
| phase-e3-server / e3-client / e3-page | 0 | 5 / 5 / 5 全 0 失败 | r2-related-*.log |
| phase-f-audit | 0 | 5 / 0 | r2-related-phase-f-audit.log |
| phase-b2b2 / phase-b1（archives 页引用回归） | 0 | 35 / 42 全 0 失败 | r2-related-*.log |
| phase-r1-tools / phase-r1-push（R1 候选复核） | 0 | 29 / 10 全 0 失败 | r2-related-*.log |
| phase-h-recheck-race | 0 | 18 / 0 | r2-related-phase-h-recheck-race.log |

无新增 SKIP。开发过程中间态日志（r2-run1~7.log、r2-related-*.log、r2r-related-*.log、r2r2-related-*.log）保留为过程记录；最终状态以 r2-run8.log + r2r3-related-*.log 为准。R2 二审后重跑的受影响旧回归（全部退出码 0）：g-server 14/0、g-vision 15/0（含新契约断言，r2r2-gvision.log）、f-audit 5/0、i-detail-upload-time 5/0、i-profile-archive-card 6/0、i-archives-delete-refresh 7/0、b2b2 35/0、b1 42/0、e3-server 5/0、r1-tools 29/0、r1-push 10/0（日志 r2r3-related-*.log）。R2 审核轮后重跑的受影响旧回归（全部退出码 0）：g-server 14/0、g-vision 15/0、f-audit 5/0、i-detail-upload-time 5/0、i-profile-archive-card 6/0、i-archives-delete-refresh 7/0、b2b2 35/0、b1 42/0、e3-server/client 5/0、r1-tools 29/0、r1-push 10/0（日志 r2r-related-*.log / r2r2-related-*.log）。

SHA256（shasum -a 256，2026-10-01，**R2 二审修复后的当前状态**）：
```
3611ef929b2f3d5b8ef63560ab5f42a23dfd5437c7310a5b7415ecc671427126  cloud/functions/mc-tools/index.js
66cb4fa2e62d39342fb71d5103550edc14465c9da4a55d28478dbaeb28b60efd  services/aiReportView.js
13e9de4792e1ec077b793e9af6e0e07db03e14717a2b3d9c4f0c7284aadd9b3b  pages/archives/detail.vue
64f18fc7bdd4b831aca01e812b22b57924b74aeabd48765bae5c4465b7e6e82f  pages/archives/ai-result.vue
cba90bfe847d2fda45bbb4baec86536fd1bf6c2c3e37dabd79e87253c804c35a  stores/report.js
7fba7d528978998a84945334d473305ae98034312d4231ba158a81a2241cfd77  tests/phase-r2-ai.regress.cjs
ba773a5b8c9de579a1b6eab9626ad33b4ecffa844e06e415759afb7d25c14cb6  tests/phase-g-vision.regress.cjs
```

（历史 SHA：一审后 mc-tools `3611ef92…`、aiReportView `1202cb3b…`、detail `13e9de47…`、ai-result `0658ee84…`、report.js `cba90bfe…`、r2 测试 `d32c363d…`——对应 r2-run7.log 时刻状态；首轮见下注。）

（R2 首轮交接时历史 SHA：mc-tools `e7e65061…`、aiReportView `e4007737…`、detail `841a9c22…`、ai-result `e0eaaa7d…`、report.js `28747b4d…`、测试 `e00dc4e1…`——对应 r2-run4.log 时刻状态。）

## 五、遗留门槛与诚实声明

1. **真实供应商行为未外呼验证**：A14/A15 的 finish_reason/HTTP 错误矩阵是对 DeepSeek API 文档契约的本地实现与 mock 验证；真实截断率、真实错误码细节（如 429/503 变体）未经真实外呼（边界禁止）。Key 原文未打印、未落日志。
2. **多供应商**：仅 DeepSeek 已实现完整性检查；接入其他供应商（不同终止字段语义）需按各自真实字段另行实现，不得机械套用 `finish_reason==='stop'`。
3. R1 既有门槛沿用（详见 R1_REVIEW_DECISION.md / R1_HANDOFF §九）：真平台定时身份未验证（定时推送仍被白名单拒绝，仅 sendNow 可用）；真实数据库对缺失 sortKey 的 orderBy 行为未验证；phase-b2b1 串行偶发中断待最终独立验证会话在冻结源码上复核。
4. 旧结果（R2 前格式）无法判定过期与覆盖——页面如实显示"未知"，不做追溯重构（属数据治理范围，另立方案）。
5. ai-input-changed 后客户端不自动重发分析（用户手动重新分析）——避免自动循环消耗配额；此为设计取舍，已在提示中说明。

Codex 未运行任何测试、未修改业务代码；本文所有执行结果由 ZCode 产生，等待审核。
