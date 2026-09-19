# B3 设计（修订版）：旧数据确认、完整备份与隔离恢复

> 2026-09-20 阶段状态：本文 §2–§5、§7–§9 的 B3b 细节仍是历史草案，和 [B3b 实施约束](ZCODE_PHASE_B3B_SPEC_2026-09-19.md) 冲突时以后者为准。尤其旧 200MB/20MB 上限、整包 readFile/Blob、base64 云函数附件、单次 manifest begin 和恢复状态机不得直接实施。B3b 编码前先按实施约束重写并完成设计 review。§6 对应 B3a 本地验收；真实云与真机仍未部署。

依据 `PHASE_B3_REVIEW_2026-09-19.md` Codex 确定方向全面修订。API 证据来自官方 `miniprogram-api-typings@5.2.3`（`/tmp/momcare-b3-api-evidence/package/types/wx/lib.wx.api.d.ts`）。仅合成数据；不部署；不处理真实旧数据。可按 B3a（迁移）/B3b（备份+隔离恢复）分批实施。

## 1. 平台 API 事实（官方 typings 5.2.3 源码级核对）

| API | typings 行号 | 契约 | 本设计使用 |
|---|---|---|---|
| `FileSystemManager.unzip` | 17763–17784 | 基础库 ≥2.19.2；解压 zip 到目标目录 | **不使用**（采用自有界容器，见 §2；若未来换 zip 须说明解压前/中限制） |
| `FileSystemManager.writeFile` | 17814–17848 | 写文件到沙箱路径 | `.mcpkg` 容器生成（`wx.env.USER_DATA_PATH`） |
| `FileSystemManager.readFile` | 17401 注释 | 读沙箱文件 | 导入/校验读取 |
| `wx.chooseMessageFile` | 24390–24417 | ≥2.5.0；从聊天会话选**单个文件** | 导入 `.mcpkg`（用户从聊天选择） |
| `wx.shareFileMessage` | 31527–31540 | ≥2.16.1；转发文件到聊天（用户主动选择收件人） | 导出完成后用户点击"分享备份" |
| KV 限制注释 | 31303/31341 | 本机 KV 总量限制（约 10MB） | 不用 KV 存附件实体；沙箱文件系统容量另行自定上限 |
| `saveImageToPhotosAlbum` | — | 仅图片 | **不用于备份**（不能带走 manifest/记录） |

**勘误承认**：首版设计"小程序没有官方 zip 解压"有误（unzip 存在）；"散文件沙箱目录当作可选备份包"不可实现（chooseMessageFile 只选单文件）；"saveImageToPhotosAlbum 算完整备份"有误（仅图片）。本修订全部更正。

## 2. `.mcpkg` 二进制容器格式（formatVersion=1）

单一可搬移文件；导出与导入使用同一文件；不导出散目录。

### 2.1 二进制布局

```
偏移 0:   magic[8]     = "MOMCPKG\0"（固定 8 字节）
偏移 8:   version[4]   = uint32 BE = 1（精确 ===1；其他拒绝）
偏移 12:  reserved[4]  = 0
偏移 16:  manifestLen[8]= uint64 BE（manifest JSON UTF-8 字节数）
偏移 24:  manifest     = manifestLen 字节 UTF-8 JSON
偏移 24+manifestLen: fileEntries（按 manifest.files 数组顺序逐段排列）
  每个 entry: entryLen[8] uint64 BE + entryLen 字节原始内容
末尾:     EOF（不允许尾部多余字节）
```

### 2.2 manifest.json schema（TypeScript 形状）

```typescript
interface McPkgManifest {
  formatVersion: 1                          // 精确 ===1
  createdAt: number                         // epoch ms
  createdBy: string                         // memberId（显示用；不构成授权）
  familyId: string                          // 显示用；不构成授权
  scope: { includeShared: boolean; includePrivateOf: string | null }
  domains: Record<string, { count: number; fileIndex: number }>  // fileIndex → files 数组下标
  files: Array<{
    path: string          // 逻辑相对路径（如 "records/health.json"、"files/<sha256>.png"）
    length: number        // 字节长度（安全整数，≤MAX_SINGLE_FILE）
    sha256: string        // 64 hex 小写
    contentType?: string  // "application/json" | "image/png" | "image/jpeg"
    domain?: string       // 所属领域
    referencedBy?: string[] // 报告附件 → 报告 ID 列表
  }>
  recordRevisions: Record<string, number>   // 实际取得的版本（非原子快照声明）
  pendingCount: number                      // 导出时未同步/冲突数（>0 → complete 不可为 true）
  totalSizeBytes: number                    // files 字节总和（安全整数）
  limits: { maxFiles: number; maxSingleFile: number; maxTotal: number; maxRecords: number }
  complete: boolean                         // 仅全部校验通过为 true
  incompleteReasons?: string[]              // complete=false 时非空
}
```

### 2.3 应用自定上限（非平台限制；真机部署时最终验证）

| 限制 | 值 | 说明 |
|---|---|---|
| MAX_PKG_BYTES | 200 * 1024 * 1024（200MB） | 容器总字节 |
| MAX_MANIFEST_BYTES | 4 * 1024 * 1024（4MB） | manifest JSON |
| MAX_FILES | 500 | 文件数 |
| MAX_SINGLE_FILE | 20 * 1024 * 1024（20MB） | 单文件（附件实体或领域 JSON） |
| MAX_RECORDS | 10000 | 全部领域记录总数 |

超限 → 业务拒绝（`limit-exceeded` 错误码 + 具体字段），不静默裁切。

### 2.4 容器校验（导入侧、预览前）

1. 文件头 magic + version（`version !== 1` → `unsupported-version`）
2. manifestLen 安全整数且 ≤MAX_MANIFEST_BYTES；偏移+长度不越界
3. manifest JSON 可解析；`formatVersion === 1`（精确等号）
4. files 数组长度 ≤MAX_FILES；逐项 length 安全整数 ≤MAX_SINGLE_FILE；总和 ≤MAX_PKG_BYTES
5. 文件段偏移按序计算；相邻段不重叠（按构造保证）；末尾无多余字节
6. 逐文件读取字节段 → SHA256 与 manifest 声明比对
7. 逻辑路径规范化：拒绝 `..`、绝对路径（`/`开头）、空路径、反斜杠、重复路径、重复 ID
8. 领域 JSON 各自 schema 校验（未知 schemaVersion → `unsupported-domain-schema`）
9. 报告附件映射：每个 `referencedBy` 的报告存在；每个报告的 `attachments[].fileId` 有对应 files 条目（通过 sha256 ↔ fileId 映射表）
10. 记录总数 ≤MAX_RECORDS

### 2.5 SHA256 实现

不把 Node `crypto`/`Buffer` 带入客户端。使用**纯 JS SHA-256 实现**（自写或锁定单文件无依赖库），在小程序/H5/Node 三端运行同一实现。提供标准 NIST 测试向量（空串/单块/多块边界）测试。增量接口：`createHash() → update(chunk) → digest()`，分块处理（64KB/块）避免一次性大内存。

## 3. 微信小程序适配器

### 3.1 导出

```
1. 从服务端分页拉取各领域（mc-health/mc-schedule/mc-reports report.list + getReadUrls→downloadFile 取附件字节）
2. 检查待同步/冲突（familyStore.pendingCount/conflictEntries > 0 → pendingCount 记入 manifest；
   >0 时 complete=false + 提示先处理待办）
3. 构建 manifest（files 数组含逐文件 sha256/length）
4. fsm.writeFile 逐段写入 USER_DATA_PATH/MomCareExport/<batchId>.mcpkg（头+manifest+逐文件段），
   每写入一段回读校验
5. 全部完成 → fsm.readFile 完整回读 → 逐文件 SHA256 复验
6. 生成 "package_ready" 状态 → 用户主动点击 "分享备份" → wx.shareFileMessage({filePath})
   → success: "shared" 状态；fail/cancel: "share_cancelled"（不冒充已导出到外部）
```

### 3.2 导入

```
1. wx.chooseMessageFile({count:1, type:'file', extension:['mcpkg']}) → 取单文件路径
   （用户从聊天记录选择；不从聊天自动读取任何真实文件）
2. fsm.readFile 头部（24字节）→ magic/version/manifestLen 检查
3. 分块读取 manifest + 逐文件段（fsm.readFile 支持 position/length）→ §2.4 校验
4. 校验通过 → 预览页面（各领域记录数/日期范围/附件缩略图/私人标记/冲突提示）
5. 用户确认恢复 → 逐领域/逐记录/逐附件上传到 mc-restore（§5）
```

### 3.3 能力缺失/错误状态

- `wx.getFileSystemManager` 不存在 → `platform-unsupported`（显示实际能力缺失说明）
- `wx.shareFileMessage` 不存在 → 导出完成但提示"当前微信版本不支持转发文件，备份已保存在本机沙箱（卸载后丢失）"
- 用户取消 chooseMessageFile → `cancelled`（不报错）
- 写入空间不足 → `storage-full`（提示清理）

## 4. H5 适配器（真实实现，非演示）

- **导出**：容器字节 → `new Blob([bytes])` → `URL.createObjectURL` → `<a download="backup.mcpkg">` 自动下载。同一容器编解码器（§2），同一校验规则。
- **导入**：`<input type="file" accept=".mcpkg">` → `File.arrayBuffer()` → 同一解码器+校验 → 预览 → 确认恢复。
- 不给云函数传 Blob URL 或本机路径。

**声明**：H5 通过不代表微信真机通过；两者必须分别验证。

## 5. mc-restore 云函数（状态机）

### 5.1 数据输入协议（云函数不访问客户端包文件）

```
restore.begin     {batchId, manifestDigest, fileCount, recordCount, totalSizeBytes}
  → 创建 mc_restore_batches（status:"uploading"）；校验限制

restore.uploadRecord {batchId, domain, index, total, record, recordSha256}
  → 逐条记录上传；服务端校验 schema/count/sha256；写入 mc_restore_records

restore.uploadAttachment {batchId, fileIndex, total, fileName, contentType, sizeBytes, sha256, base64Data}
  → 逐附件上传；服务端校验 SHA256；经 mc-files registerStaged 受控登记

restore.commit    {batchId}
  → 校验全部文件/记录已上传齐（计数+摘要）；status:"validated"

restore.preview   {batchId}
  → 按 domain 分页列出隔离区记录/冲突；私人记录按当前 member 过滤

restore.verify    {batchId}
  → 逐文件 SHA256 复验 + 逐记录字段比对 + 附件映射完整性

restore.list      {} → 当前用户批次（按 trusted member 过滤私人）
restore.cleanup   {batchId} → 清理隔离区
```

### 5.2 身份/隔离/引用保护

- 每个操作 `resolveCaller` 确认身份+familyId（复用 B2a/B2b1 协议）。
- **不实现 restore.merge**（SPEC 明确为另一个操作，本轮只做隔离恢复验证）。
- `mc_restore_batches` / `mc_restore_records` 按当前 member 限制：
  - 共享记录：家庭成员可读隔离区
  - **私人记录**：`visibility: 'private'` + `owner: memberId` — 仅本人可在 preview/list/verify 中读到；另一成员请求 → 该记录不可见（非仅 familyId 检查）
- **恢复文件引用保护**：附件经 `mc-files.registerStaged` 重新登记后获得新 fileId——在 `mc_files.attachedReportIds` 中加入 `restore:<batchId>:<recordId>` 格式的引用标识；B2b2 清理（cleanupOrphans）以 `attachedReportIds.length > 0` 判定引用——恢复引用计入集合，**不被孤儿清理误删**。隔离读取走 `restore.preview`/`restore.verify`（校验 restore: 前缀引用），裸 `mc-files.getReadUrl` 被 B2b2 everAttached 门拦截。
- 批次/记录分页；不把全部数据塞单个无界文档。

### 5.3 上传状态机

```
uploading → validated (commit 全齐) → restoring → restored
              ↓ (校验失败)              ↓ (执行失败)
           validation_failed         restore_failed（可重试续传）
```

- 未上传齐/失败/重放/身份切换不得标 `restored`。
- 已上传记录/附件用稳定 ID 幂等重放（`uploadRecord` 携带 index+sha256；重复上传同 index 同 sha → 幂等确认）。
- 批次状态持久在 `mc_restore_batches.status`。

## 6. 迁移协议（B3a）

### 6.1 源扫描

白名单键只读：`YUNTU_HEALTH_DATA`、`YUNTU_REPORTS_DATA`、`hospital_bag_items`、`MOMCARE_BACKUP_HEALTH_*`/`MOMCARE_BACKUP_REPORTS_*` 前缀。不读 token/OpenID/session/整库。读取异常或格式错显示失败（`source-read-failed`），不当空集合。

### 6.2 预览与确认

- 逐类列出：来源键、记录数、日期范围、共享字段/私人字段拆分（moods/symptoms 私人）、缺失附件、日期/类型错误、示例/演示标记。
- **私人作者确认**：只能确认当前本人；不提供代另一成员确认接口（服务端 `resolveCaller.memberId` 匹配）。
- 同源原键与备份重复选择：同实体摘要相同时视为同源（去重后预览）；不同摘要 → 分开列出供选择。

### 6.3 迁移批次（持久，成员命名空间）

```
{ batchId, confirmedAt, memberId, familyId,
  sourceDigests: { <sourceKey>: <sha256-of-raw-bytes> },
  entities: [{ sourceKey, sourceId, targetDomain, targetId, opId, sourceRevision, status }],
  status: "confirmed"|"executing"|"done"|"partial"|"failed" }
```

- 确认绑定：身份 + 原始字节摘要 + 字段选择 → 内容变化/身份变化 → 重新预览（旧摘要不作完成）。
- **清单落盘失败 → 停止执行**（源原件不删）。
- 稳定源→目标映射：同源同确认（含断网/丢响应/重启）复用 targetId + opId（B2a outbox 幂等）；不生成新副本。
- 目标初次迁入用创建基线（revision 0）；**不自动覆盖**较新/已删/现存记录（服务端 revision 检测 → `migration-conflict`）。
- 附件上传走已验收受控文件协议（`fileUploadService.uploadSingleFile`）。

## 7. 导出范围与完整性

### 7.1 当前已实现领域

| 领域 | 云函数 | 说明 |
|---|---|---|
| 孕期资料 | mc-health pregnancy.get | 共享 |
| 日健康 | mc-health daily.list | 共享 |
| 产检 | mc-schedule checkup.list | 共享 |
| 待产包 | mc-schedule bag.list | 共享 |
| 报告 | mc-reports report.list + getReadUrls → downloadFile | 共享 + 附件实体 |
| 私人心情 | mc-health mood.list | 仅当前本人（服务端二次授权） |

未来 C 领域可扩展（domains 字典结构）。

### 7.2 从服务端读取（非客户端缓存）

导出经真实分页列表接口逐页拉取（与 familyStore.pullReports 等同路径），**不只打包已有客户端局部缓存**。附件字节经 `report.getReadUrls` → `downloadFile` 获取。

### 7.3 完整性条件

- 导出前检查 `familyStore.pendingCount > 0 || conflictEntries.length > 0` → `pendingCount` 记入 manifest → `complete: false` + `incompleteReasons: ["pending_operations"]` + 提供先处理待办入口。
- 全分页失败/文件缺失/读取失败 → `complete: false`，对应 `incompleteReasons` 条目。
- 清单记录实际取得的各实体 `recordRevisions`——不宣称跨集合原子快照。
- 交付前重新校验身份；发现删除/版本变化 → 有界重试或明确不完整（`record-changed`），不用旧幂等结果泄露已删内容。

## 8. 页面

`pages/profile/privacy.vue` 扩展三入口：
- **来源预览/迁移** → `pages/profile/data-source-scan.vue`
- **完整导出** → `pages/profile/data-export.vue`（范围选择+估算+进度+完整性报告+分享按钮）
- **隔离恢复** → `pages/profile/data-restore.vue`（选包+校验结果+预览+隔离恢复+逐项校验报告）

现有旧备份数量列表保留为子区块（不误导为新流程）。

## 9. 永久测试矩阵（tests/phase-b3.regress.cjs）

| 组 | 覆盖 |
|---|---|
| 容器格式 | 有效多附件包生成→重载→逐文件 SHA256→PNG 解码；magic/version/manifestLen 越界/重叠/缺文件/尾部多余/路径穿越/重复路径/重复 ID/未知 schema/超限 |
| SHA256 | NIST 向量（空/单块/多块边界）；分块增量 vs 一次性一致性 |
| 导出 | 从真实服务端分页拉取→容器生成→逐文件回读校验→complete 判定；pendingCount>0 → complete=false+incompleteReasons |
| 导入 | chooseMessageFile mock（单文件路径）→分块读取→校验→预览→逐记录/附件上传→commit→verify |
| H5 适配器 | Blob 生成→arrayBuffer 读回→同一解码器校验（与微信适配器同一测试向量） |
| 迁移 | 合成旧数据预览→确认→中断→重启续传→重复执行不重复→源变化重新确认→迁移冲突不覆盖 |
| 隔离恢复 | mc_restore 状态机（begin→upload→commit→preview→verify）；未上传齐不标 restored；身份切换拒绝 |
| 私人 ACL | 导出只含本人 moods；恢复 preview 另一成员不可见私人记录；包含他人私人标记→不静默认领 |
| 引用保护 | 恢复附件在 mc_files.attachedReportIds 含 restore: 前缀→cleanupOrphans 不误删；裸 getReadUrl 被 everAttached 门拦截 |
| canary | 合成 moods 含 canary→导出包仅本人 canary→恢复仅入本人隔离区 |
| 会话边界 | 全操作 epoch 绑定；迟到回调拒绝 |
| 回归 | B1/B2a/B2b1/B2b2 全套件保持全绿 |

## 10. 分批实施

- **B3a**：旧数据来源扫描+预览+确认+迁移（§6、§8 来源预览页）
- **B3b**：.mcpkg 容器+导出+导入+隔离恢复（§2–§5、§7–§9）

两批分别实施/review/冻结；共同验收 B3。

## 11. 平台边界如实声明

- `.mcpkg` 生成到 `USER_DATA_PATH`——卸载后清除；导出完成后必须经 `shareFileMessage` 转发到聊天才算用户持有副本。取消/失败不冒充已导出。
- `chooseMessageFile` 只能从聊天记录选择——恢复操作说明中告知用户先在聊天中找到备份文件。
- H5 通过不代表微信真机通过。
- 本设计自定容量限制（§2.3）为应用限制，非平台限制；真机部署时最终验证。
- 真实旧数据迁移/真机文件交互/真实备份恢复留最终部署阶段。
