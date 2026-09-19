# 阶段 A 交接：消除现有数据错误（ZCode → Codex review）

日期：2026-09-19（含第一至五批修复）。状态：**阶段 A 已通过 Codex 最终验收（本地可靠性门禁 PASSED），源码冻结为阶段 B 基线**。本文档含实现清单、验证证据与已知限制。

## 1. 实现情况

### 1.1 已实现（对照实施规划阶段 A 与研究报告 P1/P2）

| 项 | 实现 |
| --- | --- |
| P1-1 网络失败伪成功 | `utils/api.js` 重写：`uni.request` fail 一律 reject（`networkError: true`），不再返回 `200/code:0/data:{}`；删除游客对 `/api/login`、`/api/register`、`/api/user/profile` 的本地假响应拦截；游客 401 不再转伪成功 |
| P1-1 AI 空结果/失败 | `stores/report.js` `isValidAiResult` 结构校验：仅 `overall_summary` 文本、结构化 `abnormal_indicators`（对象数组且每项有 name）、或非空 `action_suggestions` 之一成立才算解读成功（与 `pages/archives/ai-result.vue` 消费字段一致）；OCR 文本单独、错误对象、畸形列表、空结果一律不 done、不扣次数；OCR 独立判断 `hasValidOcrText` |
| P1-2 演示数据隔离 | 新增 `utils/storage.js`：`MOMCARE_DATA_MODE` 模式标记 + 独立演示键；`silentLogin`（启动即注入孕16周/示例记录/假用户）删除，替换为 `initializeApp`（正式模式零注入、清除旧版遗留 guest token）与 `enterDemoMode`（登录页显式入口）；演示示例记录字段改为 `bp/fetal/note` 与统计字段一致 |
| P1-3 上传 token 键 | `pages/archives/components/UploadSheet.vue` 改用 `getToken()`（`momcare_token`），不再读错误键 `token`；演示模式上传被明确阻断（不发起请求、不假成功） |
| P1-4 云端空列表覆盖 | `syncReportsFromCloud` 重写：网络/业务/结构失败一律返回 false 且本地状态不动；成功时合并而非全量替换——云端为准更新已同步项，`_local`（本地新建）、`_pendingSync`（待同步修改）保留；旧版本无标志的本地报告在云端列表缺失时保守保留并标记 `_originUnverified` |
| P1-5 假容量/假加密/假注销 | `pages/profile/privacy.vue` 重写：数据概览来自真实存储计数；删除 128MB/AES-256/「已同步」假展示；同步状态显示真实 `lastSyncStatus`；清缓存为真实操作（清除前自动写备份，备份失败则不清除）；导出与注销如实标注"暂不可用" |
| P1-6 会话边界（阶段 A 部分） | 退出登录 `exitSession` 清 token/身份并回到正式模式，弹窗不再谎称"数据已安全保存在云端"；本地数据保留不删除；演示/正式存储互不污染；完整按成员隔离属阶段 B |
| P1-7 存储失败被吞 | 两个 store 的 `_saveStorage/_persist` 返回布尔并暴露 `lastPersistError`；`saveRecord` 返回 `{ok, persisted}`，失败时内存保留记录、页面不关闭记录弹层、toast 明示失败 |
| P2-1 日期/跨日/迁移 | `today` 改为响应式 ref + `refreshToday()`（App.vue 60s 时钟 + 回前台刷新）；`isDueDate` 改与 `dueDate` 比较；`migrateCheckupSchedulesForNewLmp` 按"模板槽位"迁移（见 1.3）；建档日程初始化只由用户显式保存动作触发 |
| P2-2 归档数组迁移 | `updateReport` 应用字段后按 `archive_status` 重新分桶，单份分类归档立即移入已归档列表 |
| P2-3 静态内容 | `stores/staticData.js` 改为构建期打包 import，删除网络请求与"404 仍 loaded=true"假成功 |
| 旧数据备份/迁移边界 | `ensureLegacyBackup`：健康与报告独立判断、独立备份；全部成功才写完成标记；读写失败不写标记下次重试；只复制不删改。旧数据打 `origin: 'legacy-unverified'` 标记，绝不自动删除 |

### 1.2 Codex 第一批反馈（四项 P1）修复情况

1. 模式标记写入失败：`setDataMode` 返回布尔，`enterDemoMode`/`exitSession`/`afterRealLogin` 写入后读回校验，失败中止且不部分执行；测试覆盖三条故障路径（正式数据逐字节不变）。
2. 仅有历史报告漏备份：健康/报告独立备份 + 全部成功后才写标记；测试覆盖三场景。
3. 旧格式报告被空云列表清除：保守保留并标记 `_originUnverified`。
4. 仅 OCR 文本当 AI 成功：OCR 与 AI 校验分离；五类载荷测试覆盖。

### 1.3 Codex 第二批反馈（三项 P1）修复情况

1. **演示模式清数据删正式档案**：删除逻辑移入 `stores/health.js` 的 `clearLocalData()`（模式感知；正式模式经 `createFormalBackups()` 全部备份成功才清除并全量重置内存，后续持久化不回写旧内容；报告内存经 `resetLocalState()` 重置）；privacy.vue 只调用动作；演示模式不列正式备份。
2. **保存契约未贯穿**：`saveUserProfile.ok` 同时反映资料落盘与产检迁移二次落盘；pregnancy-info / edit-profile / onboarding 保存失败不显示成功、不返回、表单保留；报告 createReport/updateReport/deleteReport/batchArchive/syncReportsFromCloud/_updateReportField 全部检查 `_persist` 并以 `persisted` 贯穿契约；classify/unarchived/detail/batch 按契约分支展示。
3. **同孕周多记录丢失**：迁移按"模板槽位"模型只重算可确认由模板生成、未完成、未手动改期的一条；同周历史/手动/自定义全部按记录身份保留；三场景测试覆盖。

### 1.4 Codex 第三批反馈（R3 + R3.5）修复情况

1. **batch.vue confirmArchive 失败分支**（R3-P1）：整体重写，两个分支统一为逐条目幂等保存——只有全部条目确认持久化才清草稿（`pendingUpload`/`batchItemUpdate`）并离开；任一失败留在页面、保留失败项与图片引用、提示可重试；已成功条目（`createdId`）重试时跳过不重复创建。测试用**从 Vue 源码提取的真实页面函数**对真实 Store + 存储失败执行三个分支（全未选失败重试、选中失败重试、部分成功重试只补失败项）。
2. **draftId 稳定重试**（R3 复验）：`createReport` 落盘失败先回滚内存记录（调用方重试不产生内存重复），并新增 `_draftId`——失败次分配的报告 ID 由页面记住（batch 的 `item.draftId`、classify 的 `lastDraftId`），恢复后以**原 ID** 重建同一记录，不生成第二个 rpt ID。测试覆盖"本地图片失败→恢复重试→恰好一份且 ID 与失败次相同"。
3. **daily-plan.vue saveRecord**（R3 查漏）：两处 toggle 改为 await + 失败回滚勾选/组状态 + 失败提示，不表现伪完成；真实页面函数测试覆盖今日与历史两处。
4. **其余保存调用点契约扫描**（R3 补充）：
   - `updateCheckupSchedule` 返回持久化结果；`toggleExamItem`/`markCheckupCompleted`/`skipCheckup`/`addCustomExamItem` 失败自动回滚（勾选、状态、新增条目）并返回 false；`checkup-reminder.vue` 四个处理器按结果展示（失败提示"已还原"，不再无条件成功）——store 回滚测试 + 真实 `handleMarkCompleted` 页面函数测试覆盖。
   - `chooseAvatar` 写盘失败回滚头像并提示失败，不再假"头像已更新"（store 测试覆盖）。
   - `LoginPopup.handleConfirm` 检查 `saveUserProfile.ok`：失败不关闭弹框、不发 `success` 事件（真实页面函数测试覆盖，含恢复后成功路径）。
   - `hospital-bag.vue` 自动保存失败：toast + 页面持续横幅（`saveFailed`）提示"上次更改未保存"，成功后自动消除。
   - `knowledge/index.vue` 文章缓存写失败不再掩盖已加载数据（独立 try/catch）；`login`/`register` 的 `momcare_user` 缓存写入加保护，存储失败不中断登录流程。
5. **模式键读取报错 fail-closed**（R3.5-P1）：`getDataMode` 区分"键缺失（新安装，合法默认 formal）"与"读取 API 报错（返回 null 表示未知）"；`healthStorageKey`/`reportsStorageKey` 在模式未知时返回 null，健康/报告 store 的读写在键为 null 时**拒绝执行**（写返回失败、读返回 null）；`clearLocalData` 与 `exitSession` 在模式未知时拒绝操作。Codex 复现路径（演示会话中仅模式键读取抛错 → saveRecord 曾把演示昵称写进正式档案）已封堵：测试验证正式档案逐字节不变、演示键不受破坏、恢复读取后正常。

### 1.5 Codex 第四批反馈（R4 计划漏项：旧缓存来源确认边界）修复情况

实施规划阶段 A 要求"旧缓存没有可信所属成员时不自动上传或归属当前登录者"。此前实现的漏洞（Codex 复现）：`_persist` 每次把 `origin` 覆写为 `formal`，`initializeApp` 对旧缓存的补写即完成"升级"，随后 `syncProfileToCloud` 在有 token 时直接把旧昵称上传。修复：

1. **origin 随状态携带**：新增 `dataOrigin` ref（'formal' | 'legacy-unverified' | 'demo'），`_persist` 写入 `dataMode==='demo' ? 'demo' : dataOrigin`；`_applyPersisted` 从持久层恢复 origin。旧缓存（无 schemaVersion）在 `initializeApp`/`afterRealLogin` 首次加载时标记 `legacy-unverified`——普通保存、重启、换 token 都不升级来源；`afterRealLogin` 同样保持未确认（登录本身不构成归属确认）。
2. **关闭迁出通路**：`syncProfileToCloud` 在 `needsLegacyConfirm` 时拒绝执行（返回 false、零请求），并设置 `lastSyncBlockReason`（可展示的原因文案）；`syncCloudData` 中资料上传因此被阻断，报告下行拉取不受影响（拉取不构成认领）。报告侧 `updateReport` 对带 `_originUnverified` 标记的旧报告在真实登录下也不推送云端，仅保存本机并说明原因。
3. **显式确认动作**：`confirmLegacyOrigin()` 将 origin 升级为 `formal` 并落盘（落盘失败回滚保持未确认）；确认后上传通路恢复。我的页面在待确认期间显示持续横幅（原因 + "是我的"确认按钮），隐私页同步状态显示"已阻止上传：旧数据来源待确认"。完整的成员命名空间与迁移 UI 仍属阶段 B。
4. 测试覆盖：旧缓存+token 初始化后 origin 保持未确认、普通保存/重启/换 token 不升级、未确认前 `syncProfileToCloud` 零请求且 `syncCloudData` 不出现资料上行、报告拉取不受阻、确认后发出 PUT 且成功、确认落盘失败回滚、旧报告编辑不推送仅本机保存（共 6 个新场景）。

### 1.6 Codex 第五批反馈（R5：两条来源判断绕过 + 合并回归）修复情况

1. **真实无标记旧报告仍可上传**：`fetchReports`/`fetchUnarchivedReports` 在读取边界把既无 `_local` 也无 `_pendingSync` 的记录保守标记为 `_originUnverified + _local`（不依赖先发生的一次下行同步打标）；`updateReport`（已有）、`deleteReport`（本地删除路径）、`triggerAiPipeline`（新增拦截，不请求不扣次数）三个迁出入口统一拦截。成功的下行同步以服务端版本替换未确认副本并清除标记（同 ID 且本地无 `_pendingSync` 修改时服务端为准），之后编辑恢复正常云端路径。
2. **schemaVersion=2 且 origin=formal 不代表确认过归属**：新增**与令牌绑定的归属记录** `ownerTokenFingerprint`（数据内字段）——只有显式确认动作或"全新账号在当前身份下新建数据"（`afterRealLogin` 判定登录前无实质数据）才写入；`initializeApp`/普通保存/重启/登录都不写入。上传守卫条件为"来源 legacy-unverified **或**（已登录且归属指纹与当前 token 指纹失配）且有本地数据"；`syncVersion/origin` 结构字段一律不构成同意。
3. **token 读取非响应式导致守卫过期**：上传守卫（`syncProfileToCloud`、`confirmLegacyOrigin`）改为**动作时新鲜读取**（`_unclaimedDataNow()` 直接读当前 token 指纹），不依赖响应式缓存；界面横幅用 `sessionTokenFp`/`sessionAuthed` 响应式镜像，在初始化/登录/退出/云同步/确认入口刷新——换 token 后下一次同步尝试立即阻断且横幅翻转。
4. **未确认旧报告的本地编辑被服务端旧版本覆盖（R5 回归）**：未确认编辑分支现在把真实用户输入标记 `_pendingSync: true`（与信任状态独立），下行合并按既有规则保留 `_pendingSync` 本地版本——本地编辑不丢、报告仍 `_originUnverified` 不可上传，直到用户确认归属。
5. 测试新增 7 个场景：无标记旧报告读后写/删/AI 全拦截（真实旧数据形态，非手工加标）、下行同步后恢复可信、schemaVersion2+formal 无归属记录阻断、确认绑定当前 token / 换 token 重新隔离（动作时守卫 + 响应式镜像双验证）、全新账号注册流不误伤（含重启同 token）、未确认编辑跨拉取保留完整链路。

### 1.7 明确未实现（留待后续阶段）

- 阶段 B：CloudBase 云接入、真实身份/两成员/私人边界、最小同步协议（revision/operationId/冲突 UI）、导出与恢复、按成员的缓存命名空间与迁移确认对话。
- AI 解读仍指向既有 Cloudflare Worker（`API_BASE` 未变更，未新增 Cloudflare 依赖）；真实联调未做，"未启用"最终开关属阶段 B。
- 微信订阅消息、PDF、双首页、分享/任务等阶段 C 内容。
- 包体清理（logo 压缩、iOS 资源排除、真实 AppID）属阶段 D；manifest 未改动。

## 2. 修改文件

新增：`utils/storage.js`、`tests/phase-a.regress.cjs`、本文档。
修改：`utils/api.js`、`stores/health.js`、`stores/report.js`、`stores/staticData.js`、`App.vue`、`pages/login/index.vue`、`pages/register/index.vue`、`pages/index/index.vue`、`pages/profile/index.vue`、`pages/profile/edit-profile.vue`、`pages/profile/pregnancy-info.vue`、`pages/profile/privacy.vue`、`pages/profile/onboarding.vue`、`pages/profile/daily-plan.vue`、`pages/profile/checkup-reminder.vue`、`pages/profile/hospital-bag.vue`、`pages/knowledge/index.vue`、`pages/archives/components/UploadSheet.vue`、`pages/archives/classify.vue`、`pages/archives/unarchived.vue`、`pages/archives/detail.vue`、`pages/archives/batch.vue`、`components/home/RecordEditSheet.vue`、`components/common/LoginPopup.vue`。

会话开始前已有的未提交修改（PRD.md、DESIGN.md、README.md、manifest.json、package*.json、docs/CLOUDBASE_PLAN.md、DEVELOPMENT_PLAN_6_FEATURES.md、docs/research/、docs/PHASE_A_REVIEW_2026-09-19.md）全部原样保留，未提交、未推送、未部署。

## 3. 工作区状态

- 分支 `main`，基线提交 `83fbbf3`，全部变更停留在工作区（`git status --short` 见附录）。
- 参考基线快照 `/var/folders/1k/6mfcfpgd38bgh4s31fz6wsv00000gn/T/momcare-before-zcode-z5zpaur0`（只读，未改动）。
- 未执行 git commit/push、未部署、未购买资源、未访问真实后端。

## 4. 实际验证命令与结果

| 命令 | 结果 |
| --- | --- |
| `node tests/phase-a.regress.cjs` | 退出 0；**72 项全部通过**（基础场景 + 第一至五批 Codex 反馈全部用例） |
| `node docs/research/2026-09-19-probes.cjs` | 退出 1；`TypeError: health.silentLogin is not a function`——探针断言的旧缺陷入口（启动自动注入演示数据）已删除。探针与研究报告未修改；其输出不是验收依据 |
| `npm run build:h5` | 退出 0，Build complete（Sass legacy API 弃用警告为既有问题） |
| `npm run build:mp-weixin` | 退出 0，Build complete（health/report 循环 chunk、h2 选择器警告为既有问题） |

回归测试 `tests/phase-a.regress.cjs`：esbuild 打包真实 store/util 源码，Node 内模拟 `uni`（内存存储；按键/前缀注入写失败、按计数"N 次后失败"、按键注入**读失败**；可切换离线/服务端响应/拒绝对照的请求），不访问网络、不触真实用户数据、不调付费接口。**页面层测试**：从 `pages/archives/batch.vue`（confirmArchive/parseDateText）、`pages/profile/daily-plan.vue`（两个 toggle）、`pages/profile/checkup-reminder.vue`（handleMarkCompleted）、`components/common/LoginPopup.vue`（handleConfirm）的源码按花括号配对提取真实处理函数，以真实 Store 依赖注入执行（含 setTimeout 即时化的延迟回调断言、navigateBack/emit 计数），验证失败分支实际行为而非仅 Store 字段。

覆盖清单：请求失败语义、游客不拦截登录、正式空档案、旧 guest token 清除、演示隔离逐字节不变、三条模式写失败中止、备份三场景、同步四场景、断网更新、归档迁移、服务端拒绝、删除失败保留、AI 五类载荷、存储失败与重试、isDueDate、跨日刷新、产检迁移三场景、静态数据、旧数据不删改、清除链路三场景、保存链路 ok:false、五条 report 写失败契约、batch 三分支真实页面函数 + draftId 稳定重试、daily-plan 两处真实页面函数、checkup 回滚 + 真实页面函数、chooseAvatar 回滚、LoginPopup 真实页面函数、模式读取报错 fail-closed 四场景、旧缓存来源确认六场景、**R5 七场景（读取边界标记与写/删/AI 拦截、下行同步恢复可信、无归属记录阻断、token 绑定确认与换号重隔离、全新账号流、未确认编辑跨拉取保留）**。

## 5. 数据/迁移变化与回退

- 新增存储键：`MOMCARE_DATA_MODE`（模式）、`MOMCARE_LEGACY_BACKUP_DONE`（备份标记）、`MOMCARE_BACKUP_HEALTH_*`/`MOMCARE_BACKUP_REPORTS_*`（可恢复备份）、`MOMCARE_DEMO_HEALTH_DATA`/`MOMCARE_DEMO_REPORTS_DATA`（演示）。
- 正式键沿用 `YUNTU_HEALTH_DATA`/`YUNTU_REPORTS_DATA`，旧数据原样读取；首次升级自动一次性备份；旧报告在云同步中云端缺失时保守保留。
- "清除本机数据"：正式模式清除前自动备份（备份失败不清除）；演示模式只清演示键；**模式未知时一律拒绝**。
- 回退方式：直接还原源码即可；备份键独立存在，正式键内容未被新代码删改。演示数据在演示键中，互不影响。

## 6. 已知限制

1. 待同步标记（`_pendingSync`）暂无重试引擎（阶段 B）；断网修改保留本地并如实提示，联网后手工重新保存落云。
2. 服务器明确拒绝时 `updateReport` 不落本地；冲突采用/对比 UI 属阶段 B。
3. `deleteReport` 对云端已知报告要求云端确认后移除；离线无法删除这类报告（如实提示）。
4. AI 解读未真实联调；`{report_type:'解析失败', raw_text}` 载荷按"未确认"处理；ai-result 页 raw_text 恢复逻辑仅用于展示旧数据。
5. 演示模式上传/AI 被阻断是刻意行为；演示首页仅文字标注（"演示模式 · "前缀），完整演示标识 UI 未做。
6. 静态 JSON 打包 import 与 static 目录副本并存，包体增加约 312KB 冗余；阶段 D 清理。
7. 账号切换仍共享正式键（无成员命名空间）；完整边界依赖阶段 B。
8. "云端成功+本机写失败"（`persisted:false`）数据仅存内存（createReport 场景已回滚，页面提示如实说明）；可靠暂存日志属阶段 B。
9. 真机（两台手机、体验版、Wi-Fi/移动网络）验证未做，属阶段 D；小程序端仅验证构建。
10. 页面函数测试依赖从 Vue 源码提取处理函数（花括号配对），未挂载完整组件渲染树；UI 状态类断言（弹层开闭、列表渲染）以提取函数 + Store 状态代替，完整 UI 走查留待真机。

## 7. 关键源码 SHA256（冻结快照）

```
1a7daafaeebbcd9a670c4018fc67c968a64e0d4d4c567341d3d21686166937ae  utils/api.js
12f3894eebeaf7c0b4627b77a23011a120a011e6e680216e6516978234b0ffa2  utils/storage.js
afaffb93bb0a25b9c6c8ed6f8dde636e1ee91cd23c5d36d35175b3ea14559a92  stores/health.js
567cd6ddc640b38af9ab8fbea6f687d9e05be0e6b2f212178e5223e626fa60dc  stores/report.js
50fcef0134d1c558a218e625072e2b25d81711f8f8d89e1a84db698e1d50fc90  stores/staticData.js
97b05b7c7f81ffa0058a086062135d966e2b11c7a5d9d97c6a51d3b07c9446d5  App.vue
1181dad5e10455f5c83423145524c4d2bd912424e39bd426f793fb1cfa9b9763  pages/login/index.vue
4e1e34265ebc50bf6c28793beb97073af57dc45e98a558ec9aaf6ccb24e06d9e  pages/register/index.vue
bf0d850f76b463eb2376f47d6e433ef119543a34e1613bf4bd8acc2b25762972  pages/index/index.vue
754f8b44b832b95f97610b96a94fe97de90e2c49fe28d368fff0c8ebd0354f06  pages/profile/index.vue
245c34a0b5b88bb85f090165dd522ed262472075955310266037f8dc6fa86301  pages/profile/edit-profile.vue
4cdf1ea2bfbbdc73a126c5285c756150955f7c830329e6873684a6b72892dcfd  pages/profile/pregnancy-info.vue
d90ce203f56b545969b591f892d5fa318313fb0633eb017bcd5d1b448d40ca18  pages/profile/privacy.vue
5652c8070cfacccdfe80954ba0ed264f700d588e9456fea59f8b5d3fe0291bc5  pages/profile/onboarding.vue
3d93a40afd9546a97bb541c4e7516b3512a61322cf7429593eb48786d694dba6  pages/profile/daily-plan.vue
bd0b274694a6967f1575e8d998dcbb9be8549e994bf87ba218a1b3b7a3fb9dfc  pages/profile/checkup-reminder.vue
a266203661694e9b8a81f1f97290e18d4a13519658d0f3195c416597fa2b4890  pages/profile/hospital-bag.vue
0ced3ab4603f8b114b5d23ee9421e75eff7670ea92a9a1913dc95ecfaaa1e05c  pages/knowledge/index.vue
a6896412f157501ad3a7b72d32288a13745e1f3f15cf636569fb862fa97f86d4  pages/archives/components/UploadSheet.vue
2aaafdfb6e588b36085989577a2eab055c9526b935f880de7eb4c76ac36f4868  pages/archives/classify.vue
377569cb25c8977e2a01059ec54f496ed0a26afc69873e2cc58aeb2aca93f106  pages/archives/unarchived.vue
2b0417d8f0ecb5477714a965d8c0d8a970f9ec5c5d7f67c0d4db5fa4ea798baf  pages/archives/detail.vue
48bdb2c47f45013238f979850900d07cb26c74fcc8ca286652d5af18452bab7e  pages/archives/batch.vue
b41cb4d8e0132bfdd21b96da68b0afc090fd15c39eb3ebfbfdccfc7a53027747  components/home/RecordEditSheet.vue
ea599cc4ea328896efce4ac065241d390851b1985a05334554fb8765a7603414  components/common/LoginPopup.vue
dd5625c6e156d50dd08e314be2c32c1185f68a800a1bf1a274694a7dce72adbb  tests/phase-a.regress.cjs
```

## 8. 最终验收结论（2026-09-19，Codex）

Codex 独立验收通过：72 项回归（退出 0）、双端构建（退出 0）、26 项 SHA256 逐项一致、`git diff --check` 退出 0，并以隔离 bundle 提取真实页面函数做了独立对抗复现（无归属档案不上传、换 token 动作时阻断、无标记旧报告不上传/不触发 AI、本地编辑跨同 ID 云拉取不丢、模式读取异常不污染正式数据、批量失败留页且重试复用原 ID）。详见 review 文档"最终 R5 独立验收结果"，日志：`/tmp/momcare-codex-phase-a-final.log` 等。

**范围与后续门槛（review 文档原文要点）**：本验收仅覆盖阶段 A 本地数据可靠性修复。`ownerTokenFingerprint` 令牌指纹是**临时本地确认标记，不是身份认证、加密或两人权限边界**——阶段 B 必须改用 CloudBase 服务端可信身份、成员命名空间及私人/共享权限，不得把该指纹当作安全凭证。未完成项：完整旧报告迁移/逐项排除、冲突协议、附件持久化、导出恢复、真实 DeepSeek 与 CloudBase 联调、双首页、两台手机验收；原 Cloudflare API 地址仍在、未迁移、未部署。

**基线冻结声明**：第 7 节 26 项哈希对应的源码即阶段 B 基线，在阶段 B 指令下达前不再做任何代码修改、不提交、不推送、不部署。

## 附录：交付时 `git status --short`

```
 M App.vue
 M DESIGN.md
 M PRD.md
 M README.md
 M components/common/LoginPopup.vue
 M components/home/RecordEditSheet.vue
 M manifest.json
 M package-lock.json
 M package.json
 M pages/archives/batch.vue
 M pages/archives/classify.vue
 M pages/archives/components/UploadSheet.vue
 M pages/archives/detail.vue
 M pages/archives/unarchived.vue
 M pages/index/index.vue
 M pages/login/index.vue
 M pages/profile/checkup-reminder.vue
 M pages/profile/daily-plan.vue
 M pages/profile/edit-profile.vue
 M pages/profile/hospital-bag.vue
 M pages/profile/index.vue
 M pages/knowledge/index.vue
 M pages/profile/onboarding.vue
 M pages/profile/pregnancy-info.vue
 M pages/profile/privacy.vue
 M pages/register/index.vue
 M stores/health.js
 M stores/report.js
 M stores/staticData.js
 M utils/api.js
?? DEVELOPMENT_PLAN_6_FEATURES.md
?? docs/CLOUDBASE_PLAN.md
?? docs/PHASE_A_REVIEW_2026-09-19.md
?? docs/research/
?? docs/ZCODE_PHASE_A_HANDOFF_2026-09-19.md
?? tests/
?? utils/storage.js
```

—— 阶段 A 通过 Codex 最终验收，冻结为阶段 B 基线。等待阶段 B 指令。
