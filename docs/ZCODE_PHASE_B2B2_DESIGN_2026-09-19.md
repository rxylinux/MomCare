# B2b2 设计选择与 B1 兼容影响（实施前文档）

依据 `ZCODE_PHASE_B2B2_SPEC_2026-09-19.md`、`REMAINING_PHASE_ACCEPTANCE.md`（B2b 报告段）与已验收的 B1/B2a/B2b1 协议。先定设计再实施；本文档冻结后为实施依据。

## 0. 设计修订（review P1 ×4，以此节为准覆盖下文冲突处）

1. **裸文件读取不得绕过报告删除（P1-1）**：mc-files 登记文档维护 `everAttached`（见第 3 条）。`mc-files.getReadUrl`：文件**从未附着任何报告**（B1 独立诊断文件）→ 允许，B1 场景与回归保持；**已附着过**（everAttached）→ 一律拒绝新签发（`file-attached-use-report-route`），预览必须走 `report.getReadUrls`（报告未删除 + 附件归属核验）。真实边界如实声明：已签发的临时 URL 在平台过期前无法撤销；本约束覆盖**所有新签发**。
2. **清理后不可复活（P1-2）**：清理完成**不删除 mc_files 记录**，改写终态 `status='deleted'`（文件墓碑，保留 familyId/uploaderId/uploadId 供审计与防复活）。`registerStaged` 状态机显式识别全部生命周期：首次认领（无记录=新）；已有记录 `registered`→幂等重放、`claiming`→复用认领、`cleaning`→拒绝（`file-cleaning`）、**`deleted`→拒绝（`file-deleted`，同 uploadId 不得复活，需显式换新 uploadId）**；转存后的最终登记事务内重读状态，`deleted`/`cleaning` 同样拒绝——迟到登记不能复活已清理附件。清理重入对 `deleted` 返回 `skipped-deleted`（终态幂等）。
3. **引用与清理同事务（P1-3）**：mc_files 文档维护事务保护的 `attachedReportIds:[]`（当前非删除报告的引用集合）、`everAttached:bool`、`lastDetachedAt`（引用集合清空时标记"待清理计时起点"）。报告创建/编辑/删除在同一事务内增删对应文件的引用集合（新增引用须文件 `registered`；集合实际变化才写，天然避免无谓冲突）；删除报告 = 原子墓碑 + 从全部附件引用集合移除本报告 + （集合清空时）写 lastDetachedAt。清理认领事务：读引用集合为空且宽限（lastDetachedAt/registeredAt 起）已过 → `registered→cleaning`——**不再依赖事务外扫描或"触碰 updatedAt+二次扫描"**（原设计删除）。云端 `deleteFile` 逐文件检查返回结果码（status≠0 即失败），任一失败保留 `cleaning` 与错误供重试续做；全部成功 → 终态 `deleted`。
4. **暂存不可读 ≠ 原件丢失（P1-4）**：正式批次遇 `staged-file-unreadable` **不清除本机 savedFilePath、不清除批次项与顺序**；该项标记 `staged-expired`，恢复优先级：用**保留的本机原件**重新暂存（显式重试动作：新 uploadId + 同一 savedFilePath 原字节，旧 claiming 记录留给孤儿清理）；用户显式"重选图片"才产生全新 uploadId/新原件，且不清除原恢复句柄之外的批次状态。B1 诊断页单文件流保持既有行为（其回归不变），正式报告批次走新协议。

## 0b. 服务端修订（review 服务探针，17 项）

1. **创建完整性**：report.upsert 创建（无既有文档）必须给全 dateKey + reportType + ≥1 附件；编辑保持部分字段语义。
2. **幂等回放绑定 family+kind**：mc-reports 幂等键 `${familyId}:${memberId}:${operationId}`，操作记录存 familyId/kind；replay 校验归属（操作与当前记录均须属当前家庭），杜绝旧家庭 resultSnapshot 泄露。
3. **真实 SDK deleteFile 契约**（wx-server-sdk@4.0.2 index.d.ts:218-231/index.js:625-656）：参数 `{fileList: string[]}`、结果逐对象 status/errMsg、单条失败不抛错——按真实形状调用并逐对象检查；任一失败保留 cleaning 供重试。
4. **迟到签发门（getReadUrls）**：getTempFileURL 返回后、交付前重核报告 revision/未删除、附件集合、文件 registered——变化即丢弃并 `report-changed-retry`。
5. **活跃登记租约**：registerStaged 复用 claiming 认领时事务【续租】（写 updatedAt）；转存成功后、最终登记前事务记录 formalTargetPath——迟到复制的孤儿正式对象按记录路径由清理回收（终态记录保留该字段供补偿清扫）。清理同事务校验租期，只回收停滞任务。
6. mc-files registerStaged 状态机对 cleaning/deleted 终态显式拒绝（含迟到最终登记），同 uploadId 不可复活。

## 1. 权威模型（新集合 mc_reports + 新云函数 mc-reports）

- 文档：`{ familyId, type:'report', schemaVersion:1, revision, deleted, dateKey, reportType, archiveStatus('archived'|'unarchived'), note≤500, attachments:[{fileId, uploadId, sizeBytes, contentType}], uploaderId(首次创建者=文件上传者), updatedBy(最后操作者，可与 uploader 不同), sortKey:'<dateKey>:<id>', updatedAt }`。
- 稳定 ID：客户端生成 `rpt_<uuid>`（同 B2b1 bag/checkup 模式），同周/同日多条天然支持。
- 字段白名单与校验：dateKey 真实日历（复用 isValidCalendarDate）；reportType ∈ 现有 REPORT_TYPES 键；archiveStatus 枚举；note 长度；attachments ≤20 且每项 fileId 必须是 mc_files 中**本家庭、status=registered** 的登记记录（服务端事务内校验，客户端任意 fileID/URL 一律拒绝）；临时 URL 不入库。
- 操作内核：复用 B2b1 的 transactionalUpsert 模式（operations 幂等 + requestHash + revision 冲突 + 墓碑不复活 + family 全路径约束）。
- actions：`report.get/list（稳定游标 sortKey，含墓碑，存量 schema 拒绝）/upsert/delete/getReadUrls/cleanupOrphans`。

## 2. 读取与预览（永久引用与临时 URL 分离）

- 列表/详情只持 fileId。`report.getReadUrls {reportId}`：校验报告属当前家庭且**未删除**（删除后即时拒绝下载/分析；历史幂等响应不得绕过），逐附件核对 mc_files 登记（registered、同家庭），再 `cloud.getTempFileURL` 批量签发。返回按附件顺序，仅供当前会话预览，不持久化。
- `mc-files.getReadUrl` 按 P1-1 修订：仅"从未附着报告"的独立文件可裸预览（B1 场景）；已附着文件的预览一律走报告路由。

## 3. 上传批次协议（服务层收敛，B1 兼容）

- 新 `services/fileUploadService.js` 收敛可复用协议：`persistLocalCopy`（uni.saveFile 持久副本；失败不建立待办）、单文件管线 `prepareUpload(uploadId) → wx.cloud.uploadFile(stage) → registerStaged(uploadId)`（epoch/身份失败分级处理、staged-file-unreadable→需重选、其余可按原 uploadId 幂等重试）。
- **B1 兼容**：`pages/family/index.vue` 改为调用该服务，行为与文案不变（单文件待办、原 uploadId 重试、显式放弃）；B1 真实上传回归（42 项）必须保持全绿。服务端增量（B1 路径不会产生 cleaning/deleted 记录，回归不受影响）：mc-files `registerStaged` 状态机显式识别 `cleaning`（拒绝 file-cleaning）与终态 `deleted`（拒绝 file-deleted，防同 uploadId 复活）；`getReadUrl` 增加 everAttached 门（见 §0-1）。
- 新 `services/reportFamilyStore.js`（多图批次 + 报告权威 store）：
  - 批次清单（成员命名空间持久，setMemberCache 'b2b2-batches'）：`{ batchId, status:'uploading'|'creating'|'done'|'partial', items:[{order, uploadId, savedFilePath, stageFileID?, fileId?, error?}], reportDraft, reportId }`。**任何网络前**先收集完整清单并成功落盘（沿用 B2b1 迁移清单门槛：落盘失败不发请求、不显示"已排队"）。
  - 逐项独立推进：每图 prepare→stage→register，成功项不重复上传；失败只重试失败项；重试沿用原 uploadId/内容与顺序；stage 过期项标记需重选（显式换新 uploadId）。
  - 图片顺序 = items.order，报告 attachments 按该顺序；`sizeType:['original']`（不默认 quality 压缩替代原件；演示说明压缩差异）。
  - 全部 registered 后创建报告：走 **B2a outbox 持久协议**（familyStore 扩展 report 域：kind 'report'/'report-delete' 路由 mc-reports，稳定 operationId，响应丢失幂等重放，冲突采用云端/确认重提）。
  - 重启恢复：批次清单从成员缓存恢复，未完成项续传；报告创建以"同 entityId 同内容原样重放"（沿用 B2b1 submit 层稳定比较）。
  - 会话边界：批次循环逐项 epoch 校验（沿用 B2b1 store14 门槛），切换成员即停；批次留原成员名下。
- 上传开关关闭（MC_UPLOAD_ENABLED 未开）：浏览与说明可用、可退出，不假成功（沿用 B1 uploadPolicy/prepareUpload 语义）。

## 4. 删除与清理边界（按 P1-2/P1-3 修订）

- 删除 = 单事务内：报告墓碑（revision 推进，旧写入不可复活）+ 从全部附件文件的 `attachedReportIds` 移除本报告 + 引用集合清空时写 `lastDetachedAt`。attachments 留档供审计但 deleted 后不计有效引用；其他仍引用同文件的报告不受影响（可读、集合保护）。
- `cleanupOrphans`（显式动作，默认不配自动云任务）：
  1. 候选：`claiming` 超过保留期且无活跃登记（updatedAt 停滞）的暂存任务；`registered` 且 `attachedReportIds` 为空、宽限（`lastDetachedAt`/`registeredAt` 起）已过的文件。**引用判定只读事务保护的引用集合，不做事务外扫描**。
  2. 事务认领 `registered→cleaning`（同事务再核引用集合为空）；`cleaning` 中断记录幂等续做；`deleted` 终态返回 skipped-deleted。
  3. 存储删除：逐对象检查 `deleteFile` 返回结果码，任一失败保留 cleaning 与错误供重试（禁止"失败即完成"）；全部成功 → 终态 `deleted`（文件墓碑，防同 uploadId 复活）。
  4. 并发保护：新引用创建与清理认领在**同一批 mc_files 文档**上事务互斥——清理认领后文件非 registered，新引用被拒；引用先提交则集合非空，清理认领事务读到后跳过（skipped-referenced）。活跃任务（claiming 新鲜）不清理。
- 本阶段只用隔离合成 SDK 数据验证；不动真实云文件。

## 5. 会话、演示与 AI 边界

- 三态数据源（family/demo/prompt）覆盖 archives 全入口（index/UploadSheet/unarchived/classify/batch/detail/ai-result）：family=mc-reports 权威；demo=现有本地演示流（旧键原字节不动）；prompt=空态+去确认。未确认/锁定/退出/切成员清屏，回前台/冷启动确认后由 session watcher 激活拉取（沿用 B2b1 三页模式）。
- 旧正式报告键 `YUNTU_REPORTS_DATA` 本阶段零读零写（保留 B3 来源确认）；演示键独立。**零旧 HTTP**：family 路径不触碰 `request()`/`API_BASE` 旧链路。
- AI 保持明确未启用：无供应商调用、无模拟成功；ai-result 页与详情 AI 入口如实展示未启用；无 OCR/模型证据不出现"分析完成/全部正常"。

## 6. 测试计划（tests/phase-b2b2.regress.cjs，全隔离）

- 服务组（含四个 P1 门）：字段/引用校验（未登记、外家庭、cleaning/deleted 文件拒绝新引用）、family 隔离、报告墓碑不复活、稳定分页（同日多条）、getReadUrls 删除即拒、**裸 getReadUrl：未附着可预览/已附着拒绝（everAttached 门）**、清理（引用集合保护/活跃任务不清理/宽限期/逐对象删除失败可重试/**清理后终态 deleted：同 uploadId 认领、迟到登记、响应丢失重放均不可复活**）、**引用增删与清理认领同事务并发**、**staged-file-unreadable 后本机原件保留并可重新暂存**。
- store/批次组：多图原件顺序与大小一致、部分失败只重试失败项、登记/创建响应丢失重放不重复、重启恢复、批次清单落盘失败不发网络、会话边界（挂起响应切成员）、上传开关关闭如实失败。
- 页面组：真实 UploadSheet 处理器→批次→classify/batch 创建→列表/详情（缩略/预览临时 URL）、编辑基线冲突、批量归档部分成功、删除后详情/预览拒绝、演示隔离、零旧 HTTP、旧键字节不变。
- 全量门：B2b2 + B2b1(53) + B2a(42) + B1(42) + A(72) 复跑、双端构建、未绑定引用审计、SHA256 冻结交接。
