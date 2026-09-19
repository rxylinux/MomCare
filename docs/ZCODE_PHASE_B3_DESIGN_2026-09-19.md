# B3 设计（修订版 4）：旧数据确认、完整备份与隔离恢复

> 2026-09-20 状态：B3b 阶段一（§2–§4 的共享 codec、微信全量导出/发布与 H5 本地验包）已通过本地独立 review；§5 隔离恢复仍属阶段二，尚未编码和验收。设计与 `ZCODE_PHASE_B3B_SPEC_2026-09-19.md` 冲突时以后者为准；§6 为 B3a 已验收协议（c4e5995）原文。未部署，未读真实数据。

## 1. 平台 API 事实（官方 typings 5.2.3 源码级核对）

| API | typings 行号 | 契约 | 使用 |
|---|---|---|---|
| `FileSystemManager.unzip` | 17763–17784 | ≥2.19.2 | **不使用** |
| `FileSystemManager.writeFile` | 17814–17848 | 写沙箱文件 | 临时分段文件与 `.partial` 首写 |
| `FileSystemManager.appendFile` | **16985–17012**；基础库 ≥2.1.0（插件 ≥2.19.2） | 文件结尾追加内容 | 容器逐段流式构建（C1） |
| `FileSystemManager.readFile`（position/length） | 17401 注释 | 定位/定长读 | 分块读取/回读校验（禁止整包读） |
| `wx.chooseMessageFile` | 24390–24417 | 聊天选单文件 | 导入 `.mcpkg` |
| `wx.shareFileMessage` | 31527–31540 | 用户主动转发 | 仅 published 标志确立后可分享 |
| **`wx.getRandomValues`** | **25582–25597** | **≥2.15.0；密码学安全随机字节** | **batchId nonce 的微信端 CSPRNG**（H5 `crypto.getRandomValues`；Node 测试 `crypto.randomBytes`；任一不可用即停止） |
| KV 限制注释 | 31303/31341 | 本机 KV 约 10MB | 不存附件实体 |
| `saveImageToPhotosAlbum` | — | 仅图片 | **不用于备份** |

## 2. `.mcpkg` 二进制容器（formatVersion=1）

### 2.1 二进制布局（不变）

```
偏移 0: magic[8]="MOMCPKG\0" | 8: version[4]=uint32BE 1 | 12: reserved[4]=0
偏移 16: manifestLen[8]=uint64BE | 24: manifest（UTF-8 JSON）
之后: fileEntries 按 manifest.files 顺序（entryLen[8]+字节） | 末尾 EOF 无多余字节
```

**packageDigest 覆盖自偏移 0（magic）至 EOF 的全部字节**（分块计算），**不写回 manifest**（避免自指）。manifest **不携带** `totalSizeBytes`——它包含 manifest 自身长度，改数值可能改变 JSON 字节位数进而改变总长（定点问题）；验证器由 头 24B + manifestLen + 各 entryLen 与**实际 EOF** 独立推导总长并要求精确一致（§2.6）。

### 2.2 应用上限与载荷预算

| 限制 | 值 |
|---|---|
| MAX_PKG_BYTES / MAX_MANIFEST_BYTES / MAX_FILES / MAX_RECORDS | 64 MiB / 4 MiB / 500 / 10000 |
| MAX_ATTACHMENT_BYTES / MAX_DOMAIN_JSON_BYTES | 10 MiB / 4 MiB |
| CHUNK_BYTES（流式读写与增量 SHA-256） | 64 KiB |
| MAX_REQUEST_JSON / MAX_RESPONSE_JSON（序列化含信封；服务端对最终 event 字节与响应强制） | 64 KiB / 256 KiB |
| 分片运输 | 40 KiB 原始字节/片，base64 运送，≤128 片（4MiB≤103 片） |
| 声明索引页（§5.1 indexDeclarePage） | ≤200 条/页或处理字节 ≤32KiB，响应 ≤256KiB |
| 验证页（§5.1 commit 验证段） | ≤50 项/页 **且** 单页读取字节 ≤256KiB（两项上限同时生效） |
| VERIFY_BLOCK（附件字节复验块） | 256 KiB——restore.verify 的文件字节游标粒度（10MiB 文件=40 页，续接靠 chunkSha256 承诺） |

**云端载荷预算依据（官方，2026-09 查证）**：[请求上限 EXCEED_MAX_PAYLOAD_SIZE](https://docs.cloudbase.net/error-code/EXCEED_MAX_PAYLOAD_SIZE)（云函数文本请求体 100KB）与[响应上限 EXCEED_MAX_RESPONSE_SIZE](https://docs.cloudbase.net/error-code/EXCEED_MAX_RESPONSE_SIZE)（小程序链路响应体 1MB）；另有 recipe 称 callFunction data 5MB——口径不一，**64KiB/256KiB 是本应用自定的保守限额，并非微信 API 自身的保证**。禁止单请求上传 4MiB manifest。

### 2.3 manifest v1 schema（判别结构；字段严格白名单）

```typescript
type DomainEntry =
  | { status: 'present'; fileIndex: number; schemaVersion: number
      recordCount: number; pagingComplete: boolean
      visibility: 'shared' | 'private' }        // 真实空域也 present 且 recordCount=0
  | { status: 'omitted' }                        // 用户明确未选/无权读取（如对方私人域）——不是不完整
  | { status: 'missing'; reason: 'read-failed' | 'unsupported-schema' }  // 仅选中且有权域的读取失败

interface McPkgManifest {
  formatVersion: 1
  createdAt: number
  createdBy: string                              // 仅展示；不构成授权
  familyId: string                               // 仅展示；不构成授权
  packageKind: 'full' | 'diagnostic'
  scope: { includeShared: boolean; includePrivateOf: string | null }
                                                 // 已选择且有权读取的范围；full 相对此范围
  scopeLabel: 'shared-only' | 'shared-plus-own-private'   // 预览/分享文案依据（"仅共享"/"共享+本人私人"）
  domains: Record<string, DomainEntry>           // 全部受支持域显式出现（present/omitted/missing 三态）
  files: Array<{ path; kind: 'domain-json' | 'attachment'; length; sha256
                 contentType; domain?; originalFileId?; referencedBy?: string[]
                 chunkSha256?: string[] }>   // 仅 attachment：按 VERIFY_BLOCK(256KiB) 逐块 SHA-256
                                            // 承诺（10MiB≤40 块）——恢复侧只读复验的续接凭据（§5.1 verify）
  reports: Array<{ reportId; deleted: boolean; revision: number
                   attachments: Array<{ order; originalFileId; fileIndex }> }>
                                                 // 墓碑报告 attachments=[]、原件不下载、不凭缺失称完整
  records: Record<string, Array<{ index; id; revision; deleted; hash }>>  // hash=canonical(record) SHA-256（§2.4）
  pending: { outboxPending: string[]; conflicts: string[]; localDrafts: string[]
             uploadBatches: string[]; migrationIncomplete: string[] }
  // 无 totalSizeBytes（自指冗余，§2.1 由验证器独立推导）
  limits: { /* §2.2 */ }
  complete: boolean      // = 所选且有权范围的来源完整：scope 内全部域 present+pagingComplete、
                         // pending 五类全空、无 record-changed。**在 manifest 生成时（Stage B）决定**，
                         // 与整包终检无关——终检结果由客户端持久 published 标志表达（§2.5）
  incompleteReasons?: string[]   // complete=false 时逐项（omitted 域不算 reason）
}
```

- **complete/published 分离**（rev3 复审第 1 条）：complete 是清单生成时可判定的**所选范围来源完整性**；"已生成且校验通过"对外只能用 published 状态表达。发布前二次 pending 检查若发现变化：**阻断发布并重建**（回到 Stage B 重构 manifest 与包）或如实失败保留输入——不允许只改 UI。
- **omitted ≠ missing**（rev3 复审第 5 条）：未选择/无权域标 omitted，不算不完整；选中且有权域读取失败才 missing→diagnostic。两人各自不能导出对方私人心情——`includePrivateOf` 只能是当前本人（导出时服务端授权 + 服务端 declare 复核，见 §5.1）。

### 2.4 规范化与字节哈希规则（唯一规则，三端/服务端同一实现）

- **canonicalJson(record)**：UTF-8；对象键字典序；无空白；数字按 ECMAScript ToString；字符串按 JSON.stringify 语义。`records[].hash = sha256(UTF8(canonicalJson(record)))`；manifest 自身序列化同规则。
- **孤立代理项规则（严格 UTF-8，评审裁定）**：B3a 旧 `utf8Encode` 对孤立代理会产生如 `ED A0 80` 的**非法 UTF-8**——`.mcpkg` 不得把此行为继承为格式。**两层检测**：①导出侧在序列化**前**对字符串值检测未配对孤立代理项（U+D800–DFFF 单独出现）并拒绝（`malformed-surrogate`，原输入保持可恢复——不改动用户数据，仅拒绝入包）；②导入/恢复侧在 JSON **解析后**对 manifest 与全部领域记录做**递归字符串检查**——遍历所有对象/数组的每个 string 值，未配对孤立代理一律拒绝，**ASCII 转义形式（`\uD800` 等转义序列解析出的孤立代理）同样拒绝**（即检查发生在解析后的字符串层，天然覆盖原始字节与转义两种来源）。UTF-8 编码层与字节分块层**分层测试**。
- **canonicalJson 排除非 schema 值**：`undefined`、`NaN`、`Infinity`、循环引用等不得进入序列化（导出时记录级校验拒绝），避免不同运行时序列化漂移。
- **manifestDigest** = 容器内 manifest 原始 UTF-8 字节的 SHA-256（逐字节重算）。**packageDigest** = 头至 EOF 全包分块 SHA-256——**仅客户端本地验证承诺**，服务端不见整包，不得称"服务端已验包字节"。
- 领域 JSON 内记录对象与 `records[]` 声明一一对应：解析后重算 canonical hash 必须与声明相等。

### 2.5 分段构建与发布协议

```
Stage A 收集：服务端全量分页（§3.1）→ 附件字节写临时分段文件 tmp/<batchId>/files/<fileIndex>.bin
  → 领域 JSON 序列化 tmp/<batchId>/domains/<domain>.json → 分块算 length/sha256 → 逐记录 canonical hash
  → 墓碑报告不下载原件 → 孤立代理项校验（§2.4）。
Stage B 清单：由 A 的结果构成 manifest 并按 §2.3 判定 complete（所选范围来源完整）→ canonical 序列化。
Stage C 组装与发布：
  C1 向 <batchId>.mcpkg.partial 顺序追加 头+manifest+各段（appendFile，typings 16985 行），**逐段回读校验一律按 64KiB 分块**（position/length 定位读，不做整段读取——大附件段同样分块）；
  C2 发布前【有界二次全域扫描】（游标分页非跨集合快照：收集期间游标前方插入会被漏读且
  既有 revision 不变无法暴露）——对每个选中域完整重分页，逐条比较 ID 集合/revision/
  deleted/报告附件引用；任何差异 → data-changed 失败保留输入（不发布旧集合、不标 full），
  重试将重建；随后二次检查 pending/身份/授权（有变化同样阻断或失败保留输入）；
  C3 临时名 → 目标名（rename 或复制；不假设 rename 原子性）；
  C4 对【目标文件】复验（magic..EOF **按 64KiB 分块读取**，重算 packageDigest、核对推导总长 24B+manifestLen+ΣentryLen 与实际长度精确一致——无整包/整段读取）；
  C5 持久化 published 标志（成员命名空间 durable 状态：{batchId, path, packageDigest, publishedAt}）。
崩溃恢复：目标名存在而 published 标志缺失 → 重启先对目标文件整包复验，通过则补落标志恢复可分享，
  不通过则按失败处理（清理/重建）。绝不只凭目标文件存在提供分享入口。
```

- `.partial` 与未过 C4/C5 的目标文件**不可分享**（分享入口仅由 published 标志驱动）；磁盘满/读取变化：保留输入与用户数据、清理不可信临时产物、如实失败。
- 构建进度（已下载 fileIndex/已序列化域/已写段）持久化——断点续构或明确重来。

### 2.6 容器校验清单（预览/导入前）

§2.1 结构（magic/version=1 精确等号/reserved/manifestLen 安全整数 ≤4MiB/偏移不越界/末尾无多余）；files ≤500 逐项按 kind 上限、**推导总长**（24B+manifestLen+ΣentryLen）≤64MiB 且与实际文件长度精确一致（EOF 无多余）；attachment 项的 chunkSha256 块数与 length/VERIFY_BLOCK 向上取整一致；逐文件分块 SHA256 比对；路径规范化与重复 originalFileId、重复 (reportId,order)；三态域自洽（omitted 无 fileIndex；missing 无 fileIndex；present 空域 recordCount=0；omitted 域不计入 incompleteReasons）；schemaVersion 精确匹配；`records[]` 与领域 JSON 重算 hash 逐项相等；孤立代理项拒绝；reports 映射闭合（未删报告每页有段、段必有 referencedBy、已删报告 attachments=[]）；总数 ≤10000；complete 自洽（scope 内任一域 missing 或 pending 非空而 complete=true → 拒绝）；diagnostic 包显著标注不可恢复。

### 2.7 流式 I/O、增量 SHA-256 与随机源

- 导出 appendFile 逐段+每段回读；导入 position/length 分块；禁止整包 I/O；H5 `File.slice()`。
- **增量 SHA-256（明确升级）**：B3a 的 `sha256HexSync` 是整输入函数——B3b codec 升级为固定小缓冲的块处理接口 `createHash() → update(chunk: Uint8Array) → digest()`（**update 只接收 Uint8Array**——字符串必须先经严格 UTF-8 编码层（孤立代理项在该层拒绝），编码与分块职责分层；64KiB/块，流式零整包驻留），与 B3a 整输入实现在相同输入上逐字节一致（同一算法）。跨端向量：NIST（空/单块/多块边界）+ 64KiB 边界±1 + 三端（mp/H5/Node）同结果 + 增量 vs 整输入一致性 + UTF-8 编码层/分块层各自独立向量。
- **随机源证据**：batchId nonce 用 `wx.getRandomValues`（typings 25582 行，≥2.15.0，密码学安全）；H5 `crypto.getRandomValues`；Node 测试 `crypto.randomBytes`。任一平台安全随机源不可用 → 实现停止，不降级时间戳/弱随机。

## 3. 导出协议（活体导出仅微信端，§4.2）

### 3.1 数据来源（非客户端缓存）

真实分页接口完整拉取：pregnancy.get / daily.list / checkup.list / bag.list / report.list（nextCursor 耗尽才 pagingComplete）/ mood.list（仅当 scope.includePrivateOf=当前本人——服务端二次授权，导出者无法选择对方私人域）。附件字节经 `report.getReadUrls → downloadFile`；墓碑报告不请求原件。字段严格白名单。

### 3.2 完整性、范围与诊断包

- **full 相对所选且有权范围**：scope 内全部域 present+pagingComplete、pending 五类全空、无 record-changed → complete=true；任一不满足 → 只能生成**诊断包**（packageKind='diagnostic'、complete=false、incompleteReasons 逐项、显著标注"不完整·不可用于恢复"）。服务端隔离恢复对 diagnostic/incomplete 一律拒绝（§5.1 declare 服务端判定）。
- **omitted 域**（未选/无权，如对方私人心情）不计为不完整；预览与分享文案按 scopeLabel 明示"仅共享"或"共享+本人私人"。
- 本机未发送草稿无法被服务端全量包覆盖：导出页列出具体草稿项并提供处理入口。
- **published 与交付绑定可信作用域**（rev5 阶段一复审第 1 条）：published 持久标志携带 `{envId, appId, familyId, memberId, epochAtPublish, path, packageDigest, publishedAt}`；分享入口与交付回调（success/cancel）全程核验**当前会话** env/app/family/member 与发起 epoch——成员或家庭切换后旧页面状态**不得分享**（入口失效并如实提示，不报错误性成功）。
- **分享前即时复验**：用户主动点击分享时，重新核验①当前身份作用域与标志一致；②目标文件**完整摘要**（64KiB 分块重算 packageDigest 比对标志值）——任一失败保留原输入与包文件、如实报错，不发起 shareFileMessage。迟到分享回调（挂起期间切换身份）不得为错误身份标记 delivered。
- 交付：用户主动 shareFileMessage（仅 published 标志后）/H5 无活体导出。沙箱副本不冒充用户持有；不自动删原包；临时目录容量/清理策略显式（下次构建前清 tmp），不承诺永久保存。

### 3.3 导出状态机

```
idle → collecting → manifest-built(complete 已按所选范围判定) → assembling(.partial)
     → publish-check(二次检查：变化→回 manifest-built 重建或失败保留输入)
     → target-written(C3) → verified(C4 目标文件整包复验) → published(C5 持久标志)
published → delivering → delivered | delivery-cancelled（用户取消；包仍在沙箱，如实说明）
任一步失败 → failed（保留输入、清理不可信临时产物）
```

## 4. 平台适配器

### 4.1 微信（唯一具备活体服务端身份与完整导出/恢复能力）

`services/cloudAdapter.js` 已核实：H5/非微信端明确 `unavailable-platform`；可信身份仅 `wx.cloud.callFunction`。导出按 §2.5/§3；导入 `chooseMessageFile({count:1,type:'file',extension:['mcpkg']})` → 分块读 → §2.6 校验 → 预览 → 确认恢复（§5）。`getFileSystemManager`/`shareFileMessage` 缺失如实提示。

### 4.2 H5——如实限定为本地验包/预览；活体云端导出与恢复不可用

H5 无可信服务端身份（不发明 H5 鉴权后端）。可用：`<input type="file">` + `File.slice()` 分块 + 同一 codec 本地校验（§2.6 全项，含 complete 语义与孤立代理项）与本地预览（诊断包也可本地查验——本地操作无需身份）。不可用：服务端全量导出、mc-restore 上传——页面如实 unavailable-platform。不给云函数传 Blob URL/本机路径。H5 通过≠微信真机通过。

## 5. mc-restore 云函数协议（隔离恢复；本期无 merge/无部分恢复；abandon 为用户可达的清理入口）

写 `mc_restore_*` 隔离集合；实时域不读取。现有/已删正式记录仅 preview 显示差异，不覆盖不复活。

### 5.0 批次标识与客户端意图

- **batchId = `rst_<128 位 CSPRNG hex>`**（`wx.getRandomValues`/`crypto.getRandomValues`；不可用即停止）。副作用前持久化意图：`{batchId, packageDigest, manifestDigest, claimedKind, totals, preflightId?, perStream 指针, scope:{env,app,familyId,memberId,createdAt}, opIdBase}`。
- **begin 只做不可变摘要承诺**：`restore.begin {batchId, formatVersion, packageDigest, manifestDigest, claimedKind, totals}`（≤1KiB）——校验格式/上限，创建批次（status=`declaring`，owner=memberId），同 batchId+全量内容一致幂等、任何变化 `batch-conflict`。服务端合格判定在 declare 重组解析后（§5.1 declareChunk 行）。
- 意图/epoch/续传/不删原包/新环境独立。

### 5.0a 持久包副本（阶段二前置——副作用前的本机准备）

`wx.chooseMessageFile` 返回的 `tempFiles[0].path` 是**会话级临时路径**——冷启动后可能失效。恢复流程开始前（任何 `restore.begin` 调用前）：

1. **复制到持久目录**：`tempFilePath → USER_DATA_PATH/MomCareRestore/<batchId>.mcpkg`（分块复制 ≤64KiB/块+逐块回读校验）。
2. **复验副本**：对持久副本整包分块 SHA-256 → 与选包时本地校验的 `packageDigest` **再次全等**（副本与原始选择一致）。
3. **持久意图（原子性尽力）**：写入 scoped 恢复意图 `{batchId, durablePath, packageDigest, manifestDigest, scope, createdAt}`——复制+摘要+意图三步中任一失败 → **零云写入**、清理不可信副本、保留原始临时文件、如实报错（`copy-failed` / `digest-mismatch` / `intent-persist-failed`）。
4. **冷启动/身份切换后**：意图读 durablePath → 文件在且 packageDigest 匹配 → 从意图续传；**文件缺失或摘要不符 → 停止并要求用户重新选包**（`durable-package-missing` / `durable-package-corrupt`）——**绝不宣称自动恢复**（重新选择后须是同一 packageDigest 才能续用原批次，否则新批次）。
5. 意图/epoch/作用域规则同 §5.0。

### 5.1 动作总表（一动作一请求；全部 resolveCaller；请求 ≤64KiB/响应 ≤256KiB 服务端强制）

| 动作 | 请求 | 职责 |
|---|---|---|
| `restore.begin` | `{batchId, formatVersion, packageDigest, manifestDigest, claimedKind, totals}` | §5.0 不可变摘要承诺；创建 `declaring` |
| `restore.declareChunk` | `{batchId, chunkIndex, chunkTotal≤128, chunkB64(base64(≤40KiB)), chunkSha256}` | manifest 原始字节分片；一片一文档；**首片接受时锚定 chunkTotal**（后续片 chunkTotal≠首片值 → `chunk-total-mismatch`）；同片同内容幂等/换内容 `chunk-conflict`；末片齐且按序 → 重组+摘要+解析+服务端判定（kind/complete/pending/scope 授权/§2.6）→ 合格 `indexing` / 不合格 `package-rejected`（零记录附件接收） |
| `restore.indexDeclarePage` | `{batchId, pageCursor?}` | ≤200 条/页（≤32KiB 处理，响应 ≤256KiB）；去重键分页文档；页内校验+滚动聚合（runningCount+链式摘要）；末页 O(1) 核对 vs 声明总数/根聚合 → `declared` / `index-mismatch`（游标重试） |
| `restore.uploadRecord` | `{batchId, domain, index, id, revision, record, deleted}`（整请求 ≤64KiB） | 规范字节 ≤48KiB 内联记录；服务端重算 canonical hash 与冻结声明全等（不等 `declaration-mismatch`）；白名单/schema/私人范围；同内容幂等；**单事务**写 `mc_restore_records._id=<batchId>:<domain>:<index>` + 递增 contentGeneration |
| `restore.uploadRecordChunk` | `{batchId, domain, index, chunkIndex, chunkTotal≤103, chunkB64(base64(≤40KiB——**仅末片可部分**), chunkSha256}（服务端强制累计解码字节 ≤4,194,304=MAX_DOMAIN_JSON_BYTES——103×40,960=4,218,880>4MiB，chunkTotal 上限 103 保留但累计超 4MiB → `record-too-large` 拒绝）` | 逐记录分片（规范字节 >48KiB 时走此路径）；**首片接受时锚定该记录的 chunkTotal**（后续片 chunkTotal≠首片值 → `chunk-total-mismatch`）；一片一文档 `_id=<batchId>:rec:<domain>:<index>:<chunkIndex>`；同片同内容幂等/换内容 `chunk-conflict`；仅 declared/uploading 有效；**finalize 后新 chunk → `record-consumed` 拒绝** |
| `restore.finalizeRecord` | `{batchId, domain, index, id, revision, deleted, expectedChunkTotal, expectedSha256}`（≤1KiB） | **单次非事务读重组（显式 4MiB 例外）+ CAS 落库**：一次读全部 ≤103 chunk（≤4MiB=MAX_DOMAIN_JSON_BYTES；commit/verify 仍 ≤256KiB/页）→ 重组 → 全量 SHA-256 → 与冻结声明+expectedSha256 三方全等（不等 **零写**）→ 解析 JSON → 白名单/schema/私人范围（失败 **零写**）→ **CAS 小事务**：写 `mc_restore_records` 存 `{id,revision,deleted,canonicalHash,byteLength,chunkTotal,frozenChunkSha256[≤103],consumedAt}` + 递增 contentGeneration。**chunk 文档无限期保留**（restored 批次唯一字节源——不删）。缺片 `record-chunks-incomplete`（可重传）；**finalize 后丢响应重放**：CAS 读到 consumedAt 已设 → **比对不可变请求字段**（id/revision/deleted/expectedChunkTotal/expectedSha256 与落库保存值）——全等 → 幂等返回成功（不递增 contentGeneration、不接受新 chunk）；**任一不等 → `finalize-conflict` 拒绝**（不是原请求的重放——可能有篡改）。expectedChunkTotal≠已锚定 chunkTotal → `chunk-total-mismatch` |
| `restore.attachFile` | `{batchId, fileIndex, fileId, sha256, length}` | 客户端先走 mc-files 管线传字节；服务端读正式字节验长度+SHA=声明；须 registered；引用由服务端从冻结声明派生；**单事务**：`mc_restore_files` + `mc_files.attachedReportIds` 追加 + everAttached + 递增 contentGeneration |
| `restore.commit` | `{batchId, preflightId?, pageCursor?}`（preflightId 可选——首次不传创建新预检；重试/续传时传上次响应返回的 ID；不匹配活跃 ID 且租约未过期 → `preflight-conflict`） | **单活跃预检 + CAS 滚动证明 + proofComplete + O(1) 冻结**（详见 §5.2.1）。批次文档维护 `contentGeneration` + 单活跃预检 `{preflightId, startGen, cursor, checkedCount, checkedDigest}`。响应中返回 `preflightId`（客户端持久化到意图——重启后携此 ID 从持久化游标续传）；预检租约超时（可配置，默认 5 分钟无进展）→ 新 `commit` 调用可 CAS 接管（stale lease takeover）。**零声明空包**：声明总数=0 时无首次 upload——commit 首调即从 `declared` 直接进入 `uploading`→预检（0 页）→ proofComplete=true（0=0）→ 冻结→验证（0 页）→ restored。verifying 分页验证 + 持久化游标；最后页原子推进 `restored`；restored 后幂等 |
| `restore.progress` | `{batchId, domain?, cursor?}` | 只读分页；响应含 `preflightId`（活跃时）供客户端恢复 |
| `restore.preview` | `{batchId, cursor}` | 分页隔离记录 + 差异 + readUrl；分片记录完整内容经 chunk 引用分页读取；超 256KiB 返回 `{nextChunkCursor}` 续读——不截断 |
| `restore.readUrl` | `{batchId, fileIndex}` | **签发前校验**：owner + 批次非 abandoned + 引用存在 + registered + 当前授权 → 临时 URL（**TTL 由平台决定——不可配置**，与 mc-files getReadUrl 一致：`expiresIn: '短期有效，有效期由平台决定'`）；已签发 URL 在平台 TTL 内可继续使用直至过期（无法撤销——如实边界） |
| `restore.verify` | `{batchId, pageCursor?}` | 真只读（零服务端写）；UI 进度客户端保存。游标三类：`{kind:'record'}`（内联 ≤48KiB，重算 hash，≤50 条/页）；`{kind:'record-chunk', domain, index, chunkIndex}`（逐 chunk ≤256KiB/页 比对 frozenChunkSha256——不重算全量）；`{kind:'file', fileIndex, blockIndex}`（附件 VERIFY_BLOCK 分块比对）。**verify 为真只读**——发现 chunk 损坏/缺失时**仅在响应 errors[] 中报告**，**不写批次文档不改状态**（零服务端写）。**仅 commit 的 verifying 阶段**发现 corruption → 持久化失败码 → 批次进入终态 `verify-corruption`（commit 是有状态的——它的验证页失败有持久化语义）；standalone verify 的 corruption 由客户端 UI 呈现——用户据此选择 abandon+新批次 |
| `restore.list` | `{cursor}` | owner-only 分页（含纯共享包；家人用原包开自己批次） |
| `restore.abandon` | `{batchId, pageCursor?}` | owner-only；非 restored 可弃。**先置 `abandoning`（清理中——计入活跃上限防 begin/abandon 循环产生无限文档）** → 事务组分页删除（每事务 ≤100 操作含读+写——非 100 个删除；每次调用上限 ≤500 操作为上界不保证；resumable cursor）→ 全部页+引用清净后置终态 `abandoned`（释放活跃槽位）。逐文件事务摘除 `restore:` 引用。单成员活跃+abandoning 批次 ≤2 |

### 5.2 状态机

```
(begin) declaring → (declare 末片+判定合格) indexing → (indexDeclarePage 全页+复核) declared
       → (首次 upload/attach **或** commit 开始且声明总数=0) uploading → (commit 预检 proofComplete+O(1) 冻结) verifying
       → (commit 分页验证全过) restored
终态：restored | abandoned（abandoning 全部清净后）| verify-corruption（仅 commit verifying 路径）
中间态：abandoning（清理中——计入活跃上限）
失败位（非终态，可重试）：package-rejected / declare-incomplete / chunk-conflict / chunk-total-mismatch
       / index-mismatch / declaration-mismatch / record-chunks-incomplete / file-cleaning
       / preflight-conflict / content-changed / proof-stale / record-consumed
verifying 起：内容不可变（batch-frozen）；verify 发现 corruption → verify-corruption 终态
```

### 5.2.1 并发串行化

- **chunk 锚定（per-record anchor 文档）**：manifest 分片的首片锚定写入**批次文档**（单一 manifest——可放批次文档）；**每条分片记录**的首片锚定写入独立 anchor 文档 `_id=<batchId>:anchor:<domain>:<index>`（`{chunkTotal, firstChunkSha256}` CAS）——10000 条记录不可全放一个批次文档。后续片校验 anchor 文档的 chunkTotal；不匹配 → `chunk-total-mismatch`。锚定后不可变。
- **finalize 后零变更**：consumedAt 设置后，新 chunk → `record-consumed`；重放 finalize → 幂等返回（不递增 contentGeneration）。**丢响应后重放**：客户端重发 finalizeRecord → CAS 读到 consumedAt → 返回与首次相同结果——**不需要 generation 递增**。
- **单活跃预检**：批次文档维护**一个** `{preflightId, startGen, cursor, checkedCount, checkedDigest, leaseExpiresAt}`。新 commit 无活跃预检 → 创建（preflightId=CSPRNG，响应返回给客户端）；活跃且 ID 匹配 → 从持久化游标续；活跃但 ID 不匹配且租约未过期 → `preflight-conflict`；租约已过期 → CAS 接管（stale lease takeover，新 preflightId）。逐页 CAS 写游标+计数+滚动摘要（先验 contentGeneration===startGen；不等 → 清除预检+`content-changed`）。全页完成+计数/摘要全等 → CAS 写 `proofComplete=true ∧ provenGeneration=startGen`（含零世代空包 0=0）。冻结 O(1) 核对 `status=uploading ∧ proofComplete ∧ provenGeneration===contentGeneration`。每次**新内容**写入单事务内容+contentGeneration+1；**同内容幂等重放不递增**（uploadRecord 已有记录且 hash 相同 → 返回成功不+1；uploadRecordChunk 已有 chunk 且 sha 相同 → 幂等返回不+1；attachFile 已有引用且 fileId 相同 → 幂等返回不+1）——防止丢响应重试使 proofGeneration 失效。
- **abandon 并发**：abandon 先 CAS status=abandoning（非 abandoned——清理中）→ 后续 upload/attach/commit 拒绝（`batch-abandoning`）；commit 已写 restored → abandon `already-restored`；abandon 分页删除时读到引用事务摘除。**restored 后 abandon 不可用**（chunk 永久保留）。abandoning 状态计入活跃上限——防止 begin→abandon→begin 循环无限堆积文档。
- **abandon 分页删除**：每次调用分 ≤5 个事务组（各 ≤100 操作含读+写）：组1 删 declare_chunk + **per-record anchor 文档**（`<batchId>:anchor:*`）；组2 删声明分页；组3 删 record chunk 文档；组4 删 mc_restore_records；组5 摘 mc_files 引用+删 mc_restore_files。全部服务端文档+引用清净后置终态 `abandoned` → 释放活跃槽位后**仅清理 scoped 恢复意图**（传输状态元数据——已无用）。**持久副本 `.mcpkg` 文件保留不删**：导入的聊天临时文件可能已消失，此副本可能是用户唯一可本地恢复的源——数据保留铁律；用户可从该副本开新批次重试，也可通过显式删除入口自行清理（页面如实显示本机存储占用）。resumable cursor（每组返回 nextCursor）。


### 5.3 索引/所有权/清理事实（按实际代码核对）

`mc_restore_batches._id=batchId`（status/contentGeneration/provenGeneration/preflight 记录/验证游标/错误清单有界）；`mc_restore_declare_chunks._id=<batchId>:<chunkIndex>`（manifest 分片）；**per-record 锚定文档** `_id=<batchId>:anchor:<domain>:<index>`（`{chunkTotal, firstChunkSha256}`——首片 CAS 写入，后续片校验）；声明索引分页 `_id=<batchId>:decl:<seq>`；`mc_restore_records._id=<batchId>:<domain>:<index>`（内联或 finalize 后元数据+frozenChunkSha256）；record chunk `_id=<batchId>:rec:<domain>:<index>:<chunkIndex>`；`mc_restore_files._id=<batchId>:<fileIndex>`。已核对 mc-reports cleanupOrphans（427–500 行）与 mc-files getReadUrl everAttached 门（373–387 行）；restore 引用与 report.upsert 记账同事务。包内 createdBy/familyId 仅展示；私人作者须本人确认。

## 6. 迁移协议（B3a 已验收 c4e5995——以下正文与 git HEAD 逐字一致，仅标题加注）

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

已并入 §3（所选范围完整、omitted/missing 三态、诊断包、发布前二次检查、非原子快照声明、活体导出仅微信端）。

## 8. 页面

privacy.vue 三入口（data-source-scan.vue 已验收；data-export.vue：范围选择+scopeLabel 文案+分段构建进度+publish-check/verified/published 状态+诊断包显著标注+分享按钮仅 published；data-restore.vue：选包+校验报告+预览+差异标记+索引/验证分页进度+续传入口+诊断包拒绝提示）。H5 两页如实显示活体操作不可用（本地验包/预览含诊断包可用）。旧备份数量列表保留为子区块。

## 9. 永久测试矩阵（合成数据；TESTING 任务所有）

| 组 | 覆盖 |
|---|---|
| 容器/codec | 多领域+三张互异 PNG（字节/像素/反序页序）：分段构建→发布→重载→逐文件分块 SHA256→PNG 实际解码；中文/emoji/**孤立代理项拒绝**；64KiB 块边界±1；结构越界/重叠/短读/缺段/尾部多余/路径穿越/重复路径/重复 ID/未知 schema/非法映射/自相矛盾 complete/**推导总长与实际 EOF 不一致拒绝（无 totalSizeBytes 字段）**；attachment chunkSha256 块数与长度一致；逐项超限拒绝报具体范围；records[] 与领域 JSON 重算 hash 相等 |
| 增量 SHA | NIST 向量；64KiB 边界±1；**增量(64KiB 固定缓冲) vs B3a 整输入逐字节一致**；mp/H5/Node 三端同结果 |
| 随机源 | `wx.getRandomValues` 合约（typings 25582 行证据）：正常出 nonce；随机源缺失 → 停止不降级 |
| 分段构建与发布 | 临时包崩溃/磁盘满：输入保留、临时产物清理、.partial/无标志目标文件不可分享；**目标存在而 published 标志缺失 → 重启复验后恢复或失败**；发布前二次 pending 变化 → 阻断并重建（非仅 UI）；C4 目标文件整包复验通过才 C5 |
| 分片运输 | 40KiB 原始分片 base64：63/64/65KiB 序列化边界；40KiB 边界；≤128 片；乱序/缺片/换内容/丢响应重传；响应逼近 256KiB 分页收缩 |
| 导出 | 真实 handler 全量分页→分段构建→published；**C2 二次全域扫描拦截游标前方中途插入（第一页后插入反例）→data-changed 不发布**；pending 非空→诊断包；**scope 相对完整性**：未选/无权域 omitted 不算不完整、选中域失败才 diagnostic；scopeLabel 文案；**对方私人域不可选**（服务端授权）；墓碑报告原件零下载；交付前变化→record-changed/重建 |
| 恢复协议 | begin（nonce/摘要承诺幂等/内容变化拒绝）→declareChunk（原始字节重组摘要/**服务端判定 kind/complete/pending/scope 授权**——自报 full 实为不完整被拒且零记录附件接收）→indexDeclarePage（≤200 条/页分页索引/游标持久/index-mismatch 重试/复核总数摘要）→uploadRecord（服务端重算 hash/同索引换内容拒/幂等）→attachFile（正式字节验长度+SHA/服务端派生引用/事务/cleaning 竞态拒绝保留）→commit（**预检分页发现缺项→留 uploading 可补传**/证明全齐才原子冻结 verifying/**验证页 ≤50 项且 ≤256KiB 读**/游标持久/最后页原子 restored/幂等）；progress 分页；verify **真只读**（服务端零写入、进度客户端保存）+ 文件字节游标 {fileIndex,blockIndex} 按 256KiB 块承诺续接（10MiB=40 页）+ 记录游标；indexDeclarePage 末页 O(1) 聚合核对（不全量重扫）；**abandon 分页清理+活跃批次上限≤2**；readUrl owner-only |
| 隔离与 ACL | 正式集合零变化；exists/deleted-conflict 不覆盖不复活；私人 canary 仅 owner（跨成员/家庭/环境）；批次动作与列表 owner-only；包内 createdBy 不构成授权；**伪造 scope（自称含他人私人）在 declare 被拒** |
| 引用/清理竞态 | restore: 前缀引用→skipped-referenced；cleaning 认领竞态拒绝可重试；裸 getReadUrl 拦截；一段多报告共享 |
| 适配器 | 微信忠实文件 API 合约（writeFile/appendFile/readFile(position,length)/发布复验链）；H5 slice 本地校验+预览（含诊断包）、活体操作如实 unavailable-platform |
| 客户端意图 | 副作用前持久；CSPRNG 缺失停止；失败停止发送；重启续传（含 indexing/verifying 游标）；epoch 迟到回调；同包重复恢复新 nonce 批次；同 ID 不同正文 |
| 回归 | B3a 及此前全部套件全绿；双端构建 |

## 10. 分批实施

B3a 已验收（c4e5995）。B3b 顺序：①共享 codec + 只读本地包验真 + 导出（§2/§3/§4）；②隔离恢复协议（§5）。每段独立 TESTING 真实路径测试 + Codex 源码/测试/冻结证据审查后提交。

**阶段一（codec+本地验包+导出）契约已独立定型**（不依赖 §5 恢复侧的任何未决项）：容器布局与上限（§2.1/2.2）、canonical JSON+严格 UTF-8 孤立代理拒绝+非 schema 值排除（§2.4）、增量 SHA（Uint8Array 接口+三端向量，§2.7）、manifest v1 终版 schema（无 totalSizeBytes；attachment chunkSha256 为恢复侧复验预留但由导出端生成）、分段构建 C1–C5+published 标志+崩溃恢复（§2.5）、所选范围完整/omitted/诊断包/scopeLabel（§2.3/§3.2）、导出状态机与交付边界（§3.3）、微信活体+H5 本地验包（§4）。阶段一不需 CSPRNG（nonce 属恢复侧；导出临时目录名用 `exp_<createdAt>_<seq>`）。可先行授权阶段一。

## 11. 平台边界如实声明

`.mcpkg` 生成于 USER_DATA_PATH——卸载即失；仅 shareFileMessage 成功转发后用户持有副本；分享入口仅 published 标志（绝不只凭文件存在）；`.partial` 不可分享。chooseMessageFile 仅聊天选择。H5 无可信服务端身份——活体云端导出/恢复不可用（本地验包除外），不发明 H5 鉴权。H5/模拟通过≠真机。§2.2 为应用边界非平台保证，真机另测。真实部署/账号/真实备份迁移/双手机验证统一最后。
