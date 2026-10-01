# 阶段 A 功能修复交接（ZCode 编码与本地测试）

状态：**F1–F3 已完成隔离夹具复现 → 生产修复 → 回归验证与文档更正；未 commit/push、未部署、未改真实 manifest/.trial-release-state、未动用户草稿（docs/recipe-draft.md）。停止，等待 Codex 审核；不自动进入阶段 B。** 基线 HEAD `5c9b648`，本阶段全部改动未提交（git diff --stat：11 文件 +538/−36）。

依据：`FUNCTIONAL_REPAIR_ZCODE_TASK.md`（Codex 设计）、`R1_R4_FUNCTIONAL_REGRESSION_REVIEW.md`（退化来源）。定时热修（4920855）未被触碰；TIMER_HOTFIX_DEPLOY_RECORD.md 未动。

## 一、修复前失败复现（冻结生产路径，隔离夹具，原始日志 /tmp/momcare-functional-repair-a/）

| ID | 命令 | 退出码 | 关键症状 | 日志 |
|---|---|---|---|---|
| F1 | `node repro-f1.cjs` | 0 | 五个旧固定键（旧格式无 scope）在场：store 无任何含 legacy 的导出成员（无入口）、会话/队列全空、云端零调用（不可续跑）、旧字节虽未动但产品无找回通路、fetal-timer 页面无旧记录横幅 | repro-f1-prefix.log |
| F2 | `node repro-f2.cjs` | 0 | (a) 胎动键 corrupt 时 `pullEfwRecords` → `recovery-blocked`（EFW 纯云端域被无关缓存异常阻断、云端明明有 1 条记录读不了）；(b) 服务端已软删（discarded）但 `deleteEfwRecord` 返回 `ok:false cloud-call-failed`——页面提示"删除失败"且本地行保留（可再次误删）；(c) 估重页 onShow 对拉取结果仅 `.catch(()=>{})` 吞掉，无失败反馈 | repro-f2-prefix.log |
| F3 | `node repro-f3.cjs` | 0 | 两页 OCR（第一页>2000 字符、第二页独有标记 M2）：M2 从未进入 AI prompt（截断丢弃），但落库 coverage `analyzed 2/total 2`、读侧 `complete:true`、详情页显示"已分析全部 2 个附件"——以"完成 OCR 的页数"冒充"实际进入模型的内容" | repro-f3-prefix.log |

## 二、最终改动（生产源码 10 文件 + 测试 2 文件）

### F1 旧计时数据安全找回（services/toolsStore.js + 两张计时页）

- **检测与入口**：store 创建时 `scanLegacyKeys()` 只读扫描五个旧固定键——`legacyPending`（存在性+条目计数，不含正文）+ `legacySummaryText`（含"无法自动证明归属/不上传/不并入当前成员"说明，读取异常如实点名）。两张计时页（fetal-timer / contraction-timer）持久横幅 +「确认归属并迁入」「导出保留」按钮 + 结果反馈行（conflict/归属不符/无法核验分类文案）。
- **显式确认（`confirmLegacyAdoption`）**：
  1. 任何处置前先 `exportLegacyRaw()` 原始字节备份（`__legacy_keep_` 键；备份失败中止迁移，旧字节保持原样）；
  2. 有服务端 sessionId/recordId 的旧记录先 `verifyLegacyCloudOwnership`（真实 `fetal.list` / `contraction.list includeDiscarded` 查归属 memberId 与存在性）——**不同所有者拒绝续跑（rejected 点名 owner）、查不到/离线不可核验保留待处理（unverifiable）、均零 mutation**；点击确认不直接赋予操作权限；
  3. 无云端 ID 的离线草稿按当前完整作用域盖章迁入；
  4. **保全**：localRef、startOpId/stopOp.opId、点击顺序、finish/stop 时间、显式 null（`cq.stopOp.notes === null`）逐字段保留；
  5. **幂等**：active 按 localRef、队列按 startOpId/stopOp.opId 去重（重复确认/冷重启/部分写失败重试不双会话不双操作）；
  6. **冲突**：目标作用域已有不同 localRef 的活跃记录 → conflicts 点名、不覆盖、旧数据保留可导出；
  7. **删除时序**：目标耐久写入并读回验证成功之前不删除任何旧键；全部成功才删（有备份在先）；部分成功只删无争议的 active 类来源键。
- **导出保留（`exportLegacyRaw`）**：不删除不迁移，逐键原始字节落 `__legacy_keep_` 备份。

### F2 按域恢复闸 + EFW 删除/刷新分离（toolsStore + ultrasound-weight.vue）

- **按域闸**：`fetalRecoveryBlocked`（fetal_active/history/queue 三键）与 `contraRecoveryBlocked`（contra 三键）分离；`recoveryBlocked` = 两者之或（既有引用兼容）。`pullFetalSessions`/`pullContractions` 各查各域；**`pullEfwRecords` 移除恢复闸**（EFW 纯云端域）；`retryPending` 按域放行——被阻断域返回 `{code:'recovery-blocked', domain:'fetal'|'contraction'}`（code 字符串保持旧值不破坏旧断言），允许域照常执行且会话守卫与保序不变。
- **删除/刷新分离（`deleteEfwRecord`）**：云端删除成功即 `{ok:true, deleted:true, refresh:{ok,code,message}}`——立即移除本地行（防同键再次误删），刷新失败如实带回 refresh 字段不回滚删除事实；删除本身失败 `{ok:false, deleted:false}`；await 中切身份：删除事实保留、旧响应不动新身份视图（sessionAtStart 守卫）。
- **估重页**：`efwLoadError` 可见失败状态 +「重试」按钮（`onRetryPull`→真实 `pullEfwRecords`）；`onDelete` 三态反馈——删除成功（toast"已删除"）、删除成功+刷新失败（toast"已删除（列表刷新失败，可点重试）"+错误状态行）、删除失败（如实错误）；onShow 消费拉取结果不再吞掉。

### F3 OCR 截断的真实覆盖披露（mc-tools + aiReportView + 两归档页 + 导出/恢复白名单）

- **服务端（mc-tools）**：新 `ocrModelCoverage(pageTexts, pageFileIds)`——拼接超 `OCR_TEXT_MAX`(2000) 时只有"全文完整进入截断文本"的页计入 `modelPageFileIds`（部分进入或未进入→skipped），返回 `truncated` 标志；`extractOcrForReport` 返回该集合；coverage 的 `analyzedFileIds` 改用**内容级集合**（截断波及页计入 skipped），ocr 模式截断时持久化 `coverage.ocrTruncated:true`；`ocr_result` 持久化 `truncated` 布尔。**缓存复用**按持久化文本的截断后缀证据处理（`ocrTruncatedEvidence`）——有证据时逐页覆盖不可考，analyzed 保守计 0、全部页计 skipped。
- **读侧（aiReportView）**：`ai_coverage` 新增 `ocrTruncated`（coverage.ocrTruncated **或** ocr_result.text 的截断后缀——旧无新字段结果按已知证据处理，不推断"完整内容"）；有截断证据时 `complete` 强制 false。
- **两归档页（detail + ai-result）**：`aiCoverageNote` 在 `cov.ocrTruncated` 时优先输出截断披露（区分 analyzed==total 与 x/y 两种形态），**绝不显示"已分析全部附件"**；视觉/不截断 OCR/metadata/旧格式文案不变。
- **导出/恢复白名单同步**：`mcpkgExportService` 的 `AI_COVERAGE_KEYS` +`ocrTruncated`、`OCR_RESULT_KEYS` +`truncated`；守卫加布尔类型检查 + `ocrTruncated:true 仅限 ocr 模式`一致性；`mc-restore` 嵌套键白名单同步两键。新字段**不降诊断包**（真实导出 full、`validatePackage` 通过、包正文字节含两新字段）。

## 三、新增回归（tests/phase-fr-a.regress.cjs，14 场景，分组计数）

| 组 | 场景 | 结果 |
|---|---|---|
| F1×7 | 检测与入口（横幅计数/不自动归属说明/正文不外露/未确认零上传/旧字节不动/两页入口）；确认迁入（localRef/opId/点击顺序/finish·stop 时间/显式 null 保全+scope 盖章+备份后清键+页面可见+联网收敛）；幂等（重复确认/冷重启重注入→不双操作）；云端归属验证（不同所有者拒绝零 mutation/本人可迁入续跑/离线不可核验保留）；目标写失败（旧字节不删/恢复后同 opId 收敛不双写）；新旧 active 冲突（不覆盖+点名+保全可导出）；导出保留（不删不迁+原始字节备份+读取异常提示） | 7/0 |
| F2×3 | 按域闸（胎动 corrupt+宫缩正常：EFW 云读不受阻/宫缩域可恢复/胎动域 blocked+domain 如实；反向亦证）；删除/刷新分离（删除成功+刷新失败→ok+deleted+refresh 如实+本地行移除不可再误删+页面 toast 分离反馈；删除失败如实+行保留）；页面消费（失败状态可见+重试真实调用+恢复清状态+删除在途切身份删除事实保留） | 3/0 |
| F3×4 | 截断披露（prompt 含截断前标记不含第二页独有标记/coverage 只计全文进入页+ocrTruncated/ocr_result.truncated/读侧 complete=false/两页面不称"全部"且披露截断）；对照（不截断 OCR"已分析全部"/视觉/metadata 既有文案不变/旧无新字段结果 suffix 证据仍防"全部"）；缓存复用按证据（analyzed 保守 0+全 skipped）；导出/恢复白名单（新字段入真实包字节 full 不降诊断+validatePackage+restore 接受新形状拒未知嵌套键+守卫拒非布尔/跨模式） | 4/0 |

命令 `node tests/phase-fr-a.regress.cjs`，**退出码 0，14/0**（`fr-a-run6.log` 最终版；调试过程 run1–run5 保留，失败均为测试脚本自缺——Pinia 解包/夹具串味/路由缺域——逐条修正见 git 历史思路，非生产问题）。

## 四、受影响旧回归重跑（命令 `node tests/<套件>.regress.cjs`，日志 /tmp/momcare-functional-repair-a/rel-*.log）

| 套件 | exit | pass/fail | 备注 |
|---|---|---|---|
| phase-r1-tools | 0 | 29/0 | |
| phase-r2-ai | 0 | 12/0 | 首跑 1 失败：A16 断言读侧 `ai_coverage` 精确形状——F3 新增 `ocrTruncated` 字段属设计内形状演进，**更新断言加入新字段**（`ocrTruncated:false` 视觉恒假；非削弱——原 analyzed/total/complete/unknown/mode 断言全保留）。run2 12/0 |
| phase-r3 | 0 | 21/0 | 导出投影含新字段不破坏既有往返 |
| phase-r4 | 0 | 24/0 | |
| phase-iv-r1 / r1b | 0 | 11+6 / 0 | F1 入口不影响 A01–A08 边界 |
| phase-iv-r3 / r3b | 0 | 6+4 / 0 | 导出守卫新增检查不破坏 A17–A22 |
| phase-iv-r4 / r4b | 0 | 11+5 / 0 | |
| phase-g-vision | 0 | 15/0 | |
| phase-i-components | 0 | 33/0 | |
| phase-b3b-stage1 | 0 | 82/0 | |
| phase-e1-client/server | 0 | 7+11 / 0 | |
| phase-f-audit | 0 | 5/0 | |
| phase-timer-hotfix | 0 | 10/0 | **定时热修零回退** |

其他：`npm run assemble:cloud` 退出 0（11 函数重组装）；`git diff --check` 退出 0；**lint：项目无 lint script（package.json 确认）——如实注明未执行**。

## 五、文件摘要（SHA256 前 12，after-digests.txt 为完整值）

```
563a128f0c61  cloud/functions/mc-tools/index.js        （F3 服务端）
f4b0c605c02c  cloud/functions/mc-restore/index.js      （F3 白名单）
2df3f1c50328  services/toolsStore.js                   （F1 全部 + F2 按域闸/删除分离）
b0640aba0a04  services/aiReportView.js                 （F3 读侧）
8283d91b2705  services/mcpkgExportService.js           （F3 导出白名单+守卫）
46cd5ba7e893  pages/tools/fetal-timer.vue              （F1 横幅）
0b81b46963a7  pages/tools/contraction-timer.vue        （F1 横幅）
4205ae6da111  pages/tools/ultrasound-weight.vue        （F2 失败状态+分离反馈）
ff7b2a18aff5  pages/archives/detail.vue                （F3 截断披露）
0f886d0fbc97  pages/archives/ai-result.vue             （F3 截断披露）
33caaf31ead3  tests/phase-fr-a.regress.cjs             （新增）
26e17c35ec0b  tests/phase-r2-ai.regress.cjs            （A16 形状断言更新）
```

**未动**：真实 `manifest.json`（3ac52461…）、`.trial-release-state.json`（ba6b45f9…）、`docs/recipe-draft.md`（用户草稿）、定时热修全部文件（mc-daily-push/index.js 保持 e06116c3…）、TIMER_HOTFIX_DEPLOY_RECORD.md。

## 六、权限边界遵守

仅本地编码/mock 回归/组装/文档。零真实上传/部署/触发器变更；零 commit/push；零真实 manifest/state 改动；零用户数据/草稿改动；零外部请求/下载（现有依赖足够）；零秘钥/OpenID 打印（测试 OpenID/APPID 均为合成值）；零消息发送。定时热修零回退（phase-timer-hotfix 10/0）。

## 七、未验证运行时边界（如实注明）

1. F1 旧格式夹具按 pre-R1 写入格式构造（无 scope 字段的 session/record 形状）——真实用户旧缓存的具体字段差异未经线上数据验证（任务禁用真实用户缓存做夹具）。
2. F2/F3 全部 mock 云/OCR——真实 TCB 数据库排序、真实 OCR 文本分布、真实多页截断行为未外呼验证。
3. F3 截断计数基于 `Array.from` 字符计数与 `\n` 拼接分隔符——与生产 `boundOcrText` 同式；真实 OCR 引擎输出行结束符差异未验证。
4. F1 云端归属验证用 `fetal.list`/`contraction.list includeDiscarded` 全量扫描——真实数据量超过单页 limit 时（>100 条）验证可能漏后页记录（保守侧：漏验→unverifiable→保留待处理，不会误放行）。
5. 定时热修的线上状态、触发器核查、自然触发观察——见 TIMER_HOTFIX_DEPLOY_RECORD.md 待办，与本阶段无关。

—— ZCode 阶段 A 完成，停止，等待 Codex 审核。
