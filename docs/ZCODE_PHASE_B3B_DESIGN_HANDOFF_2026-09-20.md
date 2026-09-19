# B3b 设计与实施交接 rev4

状态（2026-09-20）：B3a 已验收（c4e5995）；B3b 阶段一的 codec、微信全量导出/发布、H5 本地验包已完成本地独立 review，最终提交见 Git 历史。§5 隔离恢复仍待阶段二实施与独立验收。未部署，未读真实数据。以下 rev3/rev4 设计复审及实施记录按发生顺序保留；其中早期的“未批准编码”“暂停”和在途验证数据是历史状态，以本段及文末最终验收记录为准。

## rev3 复审六项的解决落点

| # | 复审矛盾 | 落点（主设计） |
|---|---|---|
| 1 | complete 循环要求改写清单 | §2.3：complete=**所选范围来源完整**，Stage B 清单生成时判定；整包终检由客户端持久 **published 标志**表达（§2.5 C4/C5、§3.3 状态机）；发布前二次检查变化 → **阻断并回 Stage B 重建**或失败保留输入（非仅改 UI） |
| 2 | begin 只收自报 kind 无法拒绝不完整包 | §5.0/§5.1：begin 仅不可变摘要承诺；**declare 末片重组解析后由服务端判定** packageKind/complete/pending/scope 授权（私人 scope 必须 resolveCaller 本人）——不合格 `package-rejected` 留 declaring，**不进入 indexing、不接收任何记录/附件**；客户端选包时本地早拒只是便利不替代服务端门 |
| 3 | 末片 declare 单次派生 10000 条无界 | §5.1 新增 `restore.indexDeclarePage` + `indexing` 状态：每页 ≤200 条或 ≤32KiB、游标持久、去重键分页文档（`<batchId>:decl:<seq>`）；全页后**复核摘要与总数** vs manifest 才 `declared`；index-mismatch 游标重试；分片文档保留至 restored（本期无过期/清理界面） |
| 4 | commit 首调无界+先冻结卡死补传 | §5.1 commit 两阶段：uploading 下**分页预检**（≤50 项且读 ≤256KiB/页+事务唯一条目计数）发现缺项 → 返回带游标缺项清单、**留 uploading 允许补传**；仅当可证明全齐才**原子冻结** verifying；验证页 **≤50 项且 ≤256KiB 读字节双上限**、游标持久；progress 的 10000 级清单 cursor 分页 |
| 5 | excluded-by-scope 不是读失败 | §2.3 三态域：`omitted`（未选/无权，如对方私人域）不算不完整不计 reason；missing 仅限选中且有权域失败；`scopeLabel`（仅共享/共享+本人私人）驱动预览与分享文案；full=**所选且有权范围**完整；服务端 declare 按冻结 scope 复核——自称含他人私人的 scope 被拒 |
| 6 | rename 原子性未证 | §2.5 统一发布链：临时名→目标名（rename 或复制，不假设原子）→**目标文件整包分块复验**（C4，重算 packageDigest、totalSizeBytes=实际和）→持久 published 标志（C5）；崩溃后目标存在而标志缺失 → 重启复验通过才恢复可分享；绝不只凭文件存在提供分享；packageDigest 明确覆盖头至 EOF |

另按评审测试方注记落稿：§2.4 **孤立代理项规则**（记录含未配对 U+D800–DFFF → malformed-surrogate，不进 full 包；manifest 含则导入/declare 拒绝）；§2.7 **增量 SHA 明确升级**（B3a sha256HexSync 为整输入——B3b codec 升级为 createHash/update(64KiB 固定缓冲)/digest，与整输入实现逐字节一致+三端向量）；§1 表新增 **wx.getRandomValues 证据**（typings 25582 行、≥2.15.0 密码学安全；H5/Node 对应源；不可用即停）；§5.1 verify 游标/进度字段定型（pageCursor/verifiedItems/verifiedBytes/lastFailedKey/有界 errors）；声明分片回收=保留至 restored（本期无清理）。

## 首轮七项与 U1–U9 的落点

（rev3 已落，rev4 未回退：分段构建 §2.5 / canonical 逐记录声明与服务端重算 §2.3–2.4、§5.1 / 40KiB base64 ≤128 片 §2.2 / 分页 commit+verifying §5.1 / 诊断包拒绝 §3.2、§5.1 / 判别域+墓碑+服务端派生引用 §2.3、§5.1、§5.3（cleanupOrphans 427–500 行、getReadUrl everAttached 373–387 行实际核对）/ CSPRNG nonce §5.0。U1 owner-only；U2 attach 读正式字节；U3 预算+分片；U4 全量声明分散；U5 诊断包；U6 重算 hash；U7 不删原包；U8 verify 只读分页；U9 nonce+全摘要+作用域。）

## 修订的确切章节（rev3→rev4）

§1（新增 getRandomValues 行）；§2.1（packageDigest 头至 EOF、totalSizeBytes 一致）；§2.2（声明索引页/验证页双上限行）；§2.3（omitted 三态、scope/scopeLabel、complete 语义分离）；§2.4（孤立代理项规则）；§2.5（C1–C5 发布链与崩溃恢复）；§2.7（增量 SHA 升级+随机源）；§3.2/§3.3（相对范围完整、publish-check 重建、状态机）；§5.0（begin 承诺化）；§5.1（package-rejected 门、indexDeclarePage、commit 两阶段、progress/verify 分页与字段）；§5.2（indexing 状态与失败位）；§9（随机源/发布崩溃/scope 相对完整/伪造 scope/索引分页/预检补传等行）。§6（B3a）未动。

## rev4 补充修订（评审第 7 节三项，已并入主设计）

1. **§6 恢复**：rev3/rev4 曾把 §6 缩写并误称"原文保留"——已从 git HEAD 逐字恢复 §6 正文（持久批次 schema、sourceDigests、私人作者确认细节等全部还原），仅标题加注"与 HEAD 逐字一致"；difflib 校验正文零差异。
2. **严格 UTF-8 裁定（§2.4/§2.7）**：B3a 旧 `utf8Encode` 对孤立代理会产生非法 UTF-8（如 `ED A0 80`）——`.mcpkg` 不继承该行为：清单/记录**序列化前**检测未配对孤立代理并明确拒绝（`malformed-surrogate`，原输入保持可恢复）；导入/declare 侧对 manifest 字节同样检测；**SHA 增量接口 update 只接收 Uint8Array**（字符串先经严格 UTF-8 编码层，编码与分块分层测试）；canonicalJson 排除 undefined/NaN/Infinity/循环引用等非 schema 值。
3. **官方链接修正（§2.2）**：改为带下划线的真实可访问路径 [EXCEED_MAX_PAYLOAD_SIZE](https://docs.cloudbase.net/error-code/EXCEED_MAX_PAYLOAD_SIZE)（云函数文本请求体 100KB）与 [EXCEED_MAX_RESPONSE_SIZE](https://docs.cloudbase.net/error-code/EXCEED_MAX_RESPONSE_SIZE)（小程序链路响应体 1MB），并明示 64KiB/256KiB 为本应用自定保守限额而非微信 API 保证。

## rev4 补充核对五项的解决（rev5，已并入主设计）

| # | 复审矛盾 | 落点 |
|---|---|---|
| 1 | totalSizeBytes 自指（含 manifest 自身长度，改值变位数） | **删除该字段**（§2.1/2.3）；验证器由 头24B+manifestLen+ΣentryLen 与实际 EOF 独立推导并要求精确一致（§2.6/C4）；packageDigest 不写回 manifest |
| 2 | verify 称只读却持久化进度 | §5.1 verify **真只读零服务端写**：nextCursor/verifiedItems/verifiedBytes/errors 在**响应**返回，**UI 进度由客户端保存** |
| 3 | 10MiB 文件超 256KiB 读页 | 游标含 **fileIndex+blockIndex 字节偏移**；manifest attachment 项新增 `chunkSha256[]`（VERIFY_BLOCK=256KiB 逐块承诺，10MiB≤40 块，导出端生成）——**分块承诺续接**，不需跨请求哈希中间态；commit 验证段文件仅核元数据/引用，实际字节证明沿用 attach（同事务引用阻止清理） |
| 4 | indexDeclarePage 末页全量重扫 10000 条 | **页内校验+随页持久化滚动聚合**（runningCount+逐页摘要链式哈希，有界写）；末页 **O(1)** 核对 vs declare 解析时一次性算好的总数/根聚合 |
| 5 | 长期未完成分片无界常驻 | 新增 `restore.abandon`（owner-only、置终态 abandoned、**分页删除** ≤500 操作/调用、逐文件事务摘除 restore: 引用回归 B2b2 清理语义）+ **单成员活跃批次上限 ≤2**（begin 拒绝并列出，引导完成/放弃）；部署前容量评估（最坏 ~4MiB/批次） |

**阶段一契约定型声明**（应评审要求明确）：导出侧（共享 codec + 只读本地包验真 + 导出，§2/§3/§4）契约**已独立定型**，不依赖恢复侧任何未决项——容器布局/上限、canonical+严格 UTF-8（孤立代理拒绝、非 schema 值排除）、增量 SHA（Uint8Array 接口+三端向量）、manifest v1 终版（无 totalSizeBytes；chunkSha256 由导出端生成）、分段构建 C1–C5+published 标志+崩溃恢复、所选范围完整/omitted/诊断包/scopeLabel、导出状态机、微信活体+H5 本地验包；阶段一不需 CSPRNG（导出临时目录名 `exp_<createdAt>_<seq>`）。**可先行授权阶段一**；阶段二（§5 恢复协议）同轮亦已完整落稿待批。

## rev5 阶段一复审四项闭环（rev6，已并入主设计）

| # | 闭环 | 落点 |
|---|---|---|
| 1 | published/分享绑定可信作用域 | §3.2：published 标志携带 `{envId,appId,familyId,memberId,epochAtPublish,path,packageDigest,publishedAt}`；分享入口与回调全程核验当前会话 env/app/family/member+epoch——切换后旧页面状态不得分享；**分享前即时复验**当前作用域一致 + 目标文件完整摘要（64KiB 分块重算 packageDigest），失败保留原输入不发起分享；迟到回调不得为错误身份标 delivered |
| 2 | 严格 UTF-8 递归检查 | §2.4 两层检测：导出序列化前字符串级拒绝；**导入/恢复在 JSON 解析后对 manifest 与全部领域记录做递归字符串检查**——ASCII 转义（`\uD800` 解析出的）孤立代理同样拒绝（检查在解析后的字符串层，天然覆盖原始字节与转义两来源） |
| 3 | appendFile 行号+分块回读 | §1 表：**appendFile typings 16985–17012 行、基础库 ≥2.1.0**；§2.5 C1 逐段回读与 C4 目标复验**一律 64KiB 分块**（position/length），无整段/整包读取 |
| 4 | 阶段一范围与验收矩阵 | 见下节（本交接新增） |

## 阶段一范围与可测试验收矩阵（应评审要求明确）

**范围（仅此三项，恢复协议 §5 全部留阶段二）**：
1. 共享 codec（增量 SHA Uint8Array 接口、canonical JSON+严格 UTF-8 两层检测、UTF-8 兼容层）；
2. 微信端全量导出+发布（真实 handler 全量分页→分段构建 C1–C5→published 标志→作用域绑定的用户分享）；
3. H5 本地验包+页面入口（chooseMessageFile/File.slice 分块→§2.6 全项校验→本地预览；活体操作如实 unavailable-platform）。
**不含**：restore.begin/declare/index/upload/attach/commit/verify/abandon、诊断包恢复、nonce/CSPRNG（恢复侧）。

**验收矩阵（阶段一，合成数据，TESTING 任务可独立执行）**：

| 组 | 断言要点 |
|---|---|
| codec-增量 SHA | NIST 向量；64KiB 边界±1；增量(固定 64KiB 缓冲) vs B3a 整输入逐字节一致；mp/H5/Node 三端同结果；update 仅 Uint8Array（字符串入参拒绝） |
| codec-canonical/UTF-8 | 键字典序/无空白确定性；序列化前孤立代理拒绝（原输入可恢复）；**解析后递归字符串检查**含 `\uD800` 转义形式；undefined/NaN/Infinity/循环引用拒绝；中文/emoji 往返 |
| 容器 | 三张互异 PNG（字节/像素/反序页序）包：构建→发布→重载→逐文件分块 SHA→PNG 实际解码；结构全部拒绝项（越界/重叠/短读/缺段/尾部多余/路径穿越/重复/未知 schema/自相矛盾 complete）；**推导总长 vs EOF 不一致拒绝（无 totalSizeBytes）**；4MiB/64MiB/500/10MiB/10000 逐项超限报具体范围；records[] 与领域 JSON 重算 hash 相等；attachment chunkSha256 块数一致 |
| 导出-分段构建 | appendFile 合约（16985 行）；C1/C4 全 64KiB 分块（无整段读，注入大段验证）；.partial/无标志目标不可分享；**崩溃恢复：目标存在而标志缺失→重启复验通过才可分享**；发布前二次 pending 变化→阻断重建；磁盘满保留输入清临时产物 |
| 导出-范围完整 | scope 内域 present+pagingComplete；未选/无权域 omitted 不算不完整；选中域失败→diagnostic（不可恢复标注）；scopeLabel 文案；对方私人域不可选（服务端授权）；墓碑报告原件零下载；pending 五类显式清单 |
| 导出-交付绑定 | published 标志含 env/app/family/member/epoch；**切换成员/家庭后旧页面分享入口失效**；分享前作用域+完整摘要复验（篡改目标文件→拒绝且输入保留）；迟到回调不误标 delivered；取消如实 delivery-cancelled |
| H5 | File.slice 分块本地校验（§2.6 全项含两层 UTF-8）+本地预览（含 diagnostic 包查验）；活体导出/恢复如实 unavailable-platform；无 DOM/Blob 于微信加载路径 |
| 页面 | privacy 三入口接线；data-export 状态机（collecting→…→published→delivered）逐步可见；data-restore 仅本地验包段（恢复入口标注"下一阶段"或禁用——按实现裁定如实展示） |
| 回归 | B3a 及此前全部套件全绿；双端构建 0 错 |

（阶段二恢复协议验收矩阵已在主设计 §9，本轮不重复。）

## 阶段一实施记录（2026-09-20，已获授权编码；未提交未部署）

**生产文件（全部新建，除 pages.json/privacy.vue 为接线修改）**：
- `utils/mcpkg/sha256.js`——增量 SHA-256（update 仅 Uint8Array；NIST 向量+与 B3a 整输入逐字节一致+任意切点增量一致，冒烟前已单独验证）
- `utils/mcpkg/utf8.js`——严格 UTF-8 两层（encodeStrict 拒孤立代理；decodeStrict 拒非法序列/超长/代理区编码 ED A0 80；assertNoLoneSurrogatesDeep 解析后递归字符串检查含 \uD800 转义）
- `utils/mcpkg/canonical.js`——canonical JSON（键字典序/无空白/拒 NaN/Infinity/循环/BigInt；对象 undefined 键按 JSON.stringify 语义跳过）+ recordHash
- `utils/mcpkg/container.js`——布局/上限/§2.6 校验/validatePackage（全 64KiB 分块、推导总长 vs EOF、逐文件+逐 256KiB 块摘要、packageDigest 头至 EOF）
- `utils/mcpkg/adapter-wechat.js`——fsm 合约（writeFile/appendFile/readFile(position,length)/stat/rename 或复制；临时路径约定）
- `utils/mcpkg/adapter-h5.js`——File.slice 只读
- `services/mcpkgExportService.js`——全量分页（真实 handler）、附件经 getReadUrls→downloadFile、pending 五类显式清单、分段构建 C1–C5（逐块回读、发布前二次 pending、目标整包复验、标志落盘失败移除目标）、published 标志（epochAtPublish 审计非等值门）、sharePublishedPackage（作用域重建比对+新鲜 epoch 绑定+目标摘要分块复验+迟到回调不误标）
- `pages/profile/data-export.vue`（范围/scopeLabel/pending 清单/状态机/已发布列表/分享/删除）、`pages/profile/data-restore.vue`（chooseMessageFile/input file 本地验包+下一阶段如实声明）、privacy.vue 两入口、pages.json 注册

**冒烟证据**（/tmp/zcode-b3b-stage1-smoke.cjs，真实 handler+忠实 fsm/downloadFile/share 合约，16/16 PASS exit 0）：完整包导出（含墓碑报告 attachments 空、两张互异 PNG 字节逐页一致、chunkSha256、mood 空域 present、无 totalSizeBytes）；分享成功/篡改拒绝/换家庭拒绝；pending→诊断包+逐项清单。

**验证事实**：mp-weixin/H5 构建 exit 0；8 个既有套件（含 TESTING 的 phase-b3a-archive）只读运行 exit 0；review-runner 80/80 source stable。

## 在途源码审查修复（2026-09-20 第二轮，评审"阶段一在途源码审查"+游标复核点）

| # | 发现 | 修复 |
|---|---|---|
| 游标非快照（本轮主指令） | C2 前无数据漂移门——游标前方插入被漏读 | `secondScanCompare`：发布前对每个选中域完整重分页，逐条比较 ID/revision/deleted/报告附件引用；差异 → `data-changed` 失败保留输入。冒烟 C1/C2：150 条 daily 第一页消费后游标前方插入 → 首扫 150/二扫 151 → 拦截、无新发布标志 |
| canonical 绕过 | JSON.stringify 把孤立代理转 ASCII `\\ud800` 转义绕开编码层拒绝；数组 undefined→null 掩盖 | 字符串分支序列化前 `hasLoneSurrogate` 拒绝；数组含 undefined/稀疏空洞 → CanonicalError |
| 验包不完整 | validatePackage 未解析领域 JSON 与 records[] 逐条比对；受支持域可缺失；chunkSha256 可选 | 领域段解析（decodeStrict+递归检查）+逐条 recordHash 比对；六个受支持域必须显式三态、未知域拒绝；附件 chunkSha256 必填 |
| pending 静默 | 不可读 outbox/草稿被当空清单 | `indeterminate` 标志：任一必要来源不可读 → complete 强制 false（`pending-sources-unreadable`）+页面警示；uploadBatches 改查真实键 `b2b2-upload-batches`/`b2b2-recovery`（非终态批次/未取消恢复） |
| 作用域次序 | 非本人私人范围静默 omitted；includeShared=false 仍读孕期 | 选择先验证（invalid-scope 报错）；孕期仅在共享范围被选时收集，否则 omitted |
| share epoch 次序 | 整包读盘 await 后才读 epoch | epoch 先捕获；读盘后/发起分享前/回调内三重复核 |
| C4→C5 竞态 | 复验 await 后未复核即写标志 | 复验后复核作用域+epoch；`setMemberCache(..., epochAtStart)` epoch 门控——切换后写入被拒并移除目标 |
| 无界写入 | 4MiB manifest 一次 appendFile | `writeChunk` 内部按 ≤64KiB 拆分 fsm 调用 |
| 页面残留 | publishedList 不随成员变化刷新；pending 隐藏 uploadBatches | 订阅会话版本：变化即清列表并从新作用域重读；进度回调绑定发起 epoch；pending 显示上传批次/恢复与 indeterminate 警示 |

验证：冒烟扩至 **18/18 PASS exit 0**（新增 C1/C2 游标反例）；双端构建 exit 0；8 套件 exit 0；runner 80/80 source stable。sha256 首版 K 常量错误为过程记录（已修+复验）。

## 在途审查第三轮核对（2026-09-20）

评审七项中六项与第二轮修复重叠（快照过期）：share epoch 先捕获+复核（532-570 行）、C4→C5 复核+epoch 门控写入（480-502 行）、pending indeterminate+真实 b2b2 键（61-100 行）、invalid-scope 先验证、writeChunk ≤64KiB 拆分（adapter 73 行）、领域 records 逐条比对+chunkSha256 必填（container 298-305/125 行）、canonical 孤立代理/数组 undefined（canonical 20/36 行）——逐行核对均在当前源码。

**本轮实际修复两处**：
1. includeShared=false 时孕期曾落入 catch 被标 missing/read-failed（→错误诊断化）——改为显式 `{status:'omitted'}` 分支（不算不完整）。冒烟 O 组：仅私人范围导出 full/complete、共享五域全 omitted、omitted 不计入 incompleteReasons。
2. share 读盘循环内逐 await 复核 epoch（原为整循环后单次）；发起 shareFileMessage 前增加 scope（memberId/familyId 与标志比对）+epoch 双重复核。

冒烟扩至 **21/21 PASS exit 0**（O 组：仅私人范围 full/complete、共享五域全 omitted、omitted 不计 incompleteReasons）；双端构建 exit 0；8 套件 exit 0；runner 80/80。

## P0 投影修复（2026-09-20 第四轮）

**P0 属实**：pregnancy.get 视图的临床字段在 `record.fields`（viewPregnancy 249-260 行核对），原投影读顶层 → 全部孕期字段丢失仍声称 complete。checkup 白名单缺 time/companion/materials/questions/status/templateKey/source；bag 白名单错用 text/done（实际 name/location/assignee/prepared/templateKey）。

修复：
1. **逐 handler view/sanitize 核对后重写全部六域投影**（pregnancy 嵌套 fields；checkup 含 time/companion/materials/questions/examItems{itemId,text,required,done}/status/templateKey/source；bag 含 name/category/quantity/location/assignee/prepared/templateKey）；id/revision/deleted 统一入投影。
2. **未知有意义字段守卫**：记录键不在白名单∪非临床元数据（familyId/sortKey/时间戳/updatedBy/uploaderId/schemaVersion 等）→ `unknown-field:域.键@id` 记入 problems → complete=false（诊断包，不静默丢弃）。
3. 冒烟 R 组**全字段逐项 roundtrip 证明**：六域全字段经真实 handler 播种→导出→解析包内领域 JSON→与服务器视图逐字段比对（R2 孕期 9 字段嵌套、R3 daily 5、R4 mood 4、R5 checkup 新白名单、R6 bag 真实字段）；R7 负例：向云端文档注入未来字段 → 诊断包+unknown-field 原因（不静默丢）。
4. 页面两项复核：publishedList 会话版本清空重读（72-77 行）与 pendingItems 含 uploadBatches（97 行）——上轮已修，本轮确认在位。

验证：冒烟 **28/28 PASS exit 0**；双端构建 exit 0；8 套件 exit 0；runner 80/80 source stable。

## 快照阻塞修复（2026-09-20 第五轮，评审"当前快照阻塞"节六项）

| # | 阻塞 | 修复 |
|---|---|---|
| 1 | canonical 对象 undefined 值/稀疏数组/孤立代理键可产出貌似完整规范 JSON | 对象值与键逐项拒绝（undefined/function/symbol 值、含孤立代理键）；数组每个索引 own-property 检查（空洞/undefined 拒绝）——N1-N3 冒烟断言拒绝 |
| 2 | validatePackage 只比 hash，声明 id/revision/deleted 可被改写仍 ok | 领域正文与 records[] 逐项对照 index（=位置）/id（正文 id 或 dateKey）/revision/deleted；manifest 原始字节重算规范编码比对（manifest-not-canonical） |
| 3 | 孕期单记录不在二次扫描内 | secondScanCompare 增 pregnancy.get 重读：revision/deleted/字段指纹比对（含哨兵区分"无记录"与"未选"）；过程修出 TDZ 声明次序缺陷（指纹赋值先于 let 声明被重置） |
| 4 | 页面 indeterminate 且五类皆空时隐去警告；doExport 无 catch；完成态可覆盖新身份 | indeterminate 独立警示卡（不依赖 pendingCount）；doExport 补 catch；完成态/finally 写入前核对发起 epoch |
| 5 | getMemberCache/pendingDrafts 对损坏返回 null 掩蔽 | 成员缓存键改经 getScopedCacheStatus（corrupt/error→indeterminate；他成员键不影响本成员）；sessionService 新增 draftStorageStatus()（absent/ok/corrupt/error 可判定），草稿门改用之 |
| 6 | 同成员切家庭后旧家庭包可列出/可删 | listPublished 按当前 env/app/family/member 过滤（旧家庭标志保留原作用域，切回可见）；removePublishedRecord 作用域核验拒绝跨家庭删除 |

验证：冒烟 **34/34 PASS exit 0**（新增 N1-N7：canonical 三拒绝、孕期 rescan 中途变化拦截 data-changed、换家庭列表隐藏+删除拒绝）；双端构建 exit 0；8 套件 exit 0；runner 80/80 source stable。P0（六域投影）上轮已修，本轮保持。

## 损坏注入测试补齐（2026-09-20 第六轮，评审最新行）

代码门上一轮已在位（getScopedCacheStatus×4 成员缓存键、draftStorageStatus、outboxReadable、indeterminate→complete=false）。本轮按评审要求补**注入损坏测试**（冒烟 T 组）：outbox 键/草稿键/上传批次键/迁移批次键逐一写入不可解析字节 → collectPendingLists().indeterminate=true 且五类数组为空（不再被 null 掩蔽为空）；端到端（T1c）：损坏源导出 → 诊断包 + `pending-sources-unreadable` 明示原因，**绝不 false full**；恢复键后 indeterminate 归位（T5）。冒烟 **44/44 PASS exit 0**；双端构建 exit 0；8 套件 exit 0；runner 80/80。

## 家庭隔离 P0 复核（2026-09-20 第七轮，评审最新行）

评审所指与第五轮第 6 项修复重叠（快照过期）——当前源码确认在位：`listPublished` 按当前可信 env/app/family/member 过滤（旧家庭标志不列出）；`removePublishedRecord` 作用域核验拒绝跨家庭删除（标志与文件保留）；`sharePublishedPackage` 发起前 scope+epoch 双检（603/632 行）、回调内 epoch 复核。独立测试自第五轮起持续断言（N6 不列出/N7 拒删），本轮补 **N8：切回原家庭后旧标志保留并重新可见**（preserve-for-return 语义显式化）。冒烟 **45/45 PASS exit 0**；双端构建 exit 0；8 套件 exit 0；runner 80/80。

## 嵌套字段/不支持 schema/零文件/选包守卫（2026-09-20 第八轮）

1. **daily/mood 嵌套 fields 未知键**：投影处增加 guardUnknownFields(rec.fields, '<domain>.fields', ...)——U1 注入 futureNested → 诊断（unknown-field:daily.fields.futureNested），不静默丢。
2. **mc-health list 不拒绝高版本记录**（视图带 unsupportedSchema:true）：新增 guardUnsupportedSchema fail-closed——daily/mood 记录级 `unsupported-schema:<domain>@<id>`；孕期视图 unsupportedSchema → 域标 missing/unsupported-schema。U2 注入 schemaVersion=999 → 诊断不 full。
3. **零文件诊断包**：validatePackage 原按"manifest 后必有 8 字节首段前缀"误拒空文件区——改为零文件包要求 manifest 后恰为 EOF（trailing 拒绝），有文件时才要求首段前缀。U3 构造全域 missing 零文件诊断包 → 校验通过。
4. **data-restore 选包守卫**：canPick 改认 `document.createElement` 能力（typeof uni 在非浏览器无文件系统环境也可能为 true）；H5 分支入口双重防御，无 document 时如实显示不可用。

验证：冒烟 **48/48 PASS exit 0**（新增 U1-U3）；双端构建 exit 0；8 套件 exit 0；runner 80/80。

## 尺寸 fail-stop（2026-09-20 第九轮）

validatePackage 原在 reader.size() 后未检 64MiB 上限即进入分块读取/哈希——H5 超大文件会被整读。修复：size > MAX_PKG_BYTES 在任何 readChunk 前**立即拒绝**（limit-exceeded）。V 组断言：64MiB+1 字节 → 拒绝且 readChunk 计数 **0**（V1/V2）；恰 64MiB 通过尺寸门进入后续校验（V3）。冒烟 **51/51 PASS exit 0**；双端构建 exit 0；8 套件 exit 0；runner 80/80。

## 附件下载完整性（2026-09-20 第十轮，评审阻塞）

`uni.downloadFile` 的 success 可携带 HTTP 403/404 的 HTML 临时文件——原实现直接哈希为原件并 full 自校验通过。修复（导出侧三重门，任一失败记 problems → 诊断不 full）：
1. **statusCode === 200** 硬门（非 200 → `download-http-error`，错误页不可当原件）；
2. **长度 vs report.getReadUrls 声明 sizeBytes**（不符 → `size-mismatch`）；
3. **MIME 字节签名嗅探**（PNG `89 50 4E 47`/JPEG `FF D8 FF` 魔数 vs 声明 contentType——非图片=疑似错误页、类型不符均 → `mime-mismatch`）；files[].contentType 改记嗅探结果。

W 组 fixture：403+HTML、200+HTML（**长度对齐声明以逼出签名嗅探分支**——否则先命中 size-mismatch）、200+截半 PNG（尺寸不符）、正常下载回归 full。冒烟 **55/55 PASS exit 0**；双端构建 exit 0；8 套件 exit 0；runner 80/80。过程如实记录：严格门暴露冒烟自身 downloadFile mock 未带 statusCode（已补真实合约）。

## 测试套件修复轮（2026-09-20 第十一轮，TESTING 真实套件 40/49 → 61/63）

按评审指令以 `node tests/phase-b3b-stage1.regress.cjs` 为准（不依赖冒烟）修复 9+新增失败：

| # | 失败 | 修复 |
|---|---|---|
| B2b | 深度检查不遍历对象键 | assertNoLoneSurrogatesDeep 逐键 hasLoneSurrogate 检查（键同为序列化内容） |
| C4 | 组装磁盘满后 .partial 残留 | buildAndPublishPackage 全程 try/catch：targetWritten=false → cleanupTemp+清意图；=true → 保留意图走恢复 |
| C5a | 无 C3→C5 崩溃恢复 | **导出意图**（副作用前持久化；成功后清除；flag 落盘失败时补记 packageDigest 保留目标+意图不删除）；`recoverInterruptedExport()`：意图+目标在盘 → 整包复验 → packageDigest 与意图一致才补落标志（新鲜 epoch 审计值；不一致清孤儿）；listPublished 同步列出 recoveredPending 条目（分享前强制复验晋升，并发完成回落 durable 不误报）；无信意图孤儿不认领 |
| M3b | manifest 长度不等只跳过不报 | 长度≠规范重算 → manifest-not-canonical |
| M3c | 领域段无规范字节校验 | 逐域段 serializeManifest(list) 长度+逐字节比对（domain-segment-not-canonical） |
| Q3 | 全域失败被 rescan 误判 data-changed | 二次扫描仅对首扫 present 域/孕期执行——missing 域不参与（诊断包可发布） |
| Q5 | 非浏览器触碰 document | canPick 改 `typeof window`（零 document 访问）；pickFile 用户点击时才惰性检查 document |
| S1 | building 被陈旧导出钉死 | 会话 watch 立即复位 building；finally 无条件复位（共享 UI 态）；状态写入保持 epoch 门 |
| P6/P6b | 上传批次真实形状/形状错误 | 识别 `{batches:{…}}` 包装（reportFamilyStore:84 实际形状）；不可识别形状 → indeterminate（不静默当空） |
| M4c-g | 自洽重算缺口 | omitted/missing 域携带 records 拒绝；reports[].deleted/revision 与正文交叉；referencedBy 幽灵反向引用；pending.indeterminate↔complete、diagnostic↔complete 矛盾拒绝 |
| C10 | 墓碑正文携带原 fileId | 投影处 deleted → attachments=[] |

**Q1/Q2 未修（fixture 形状问题，如实报告）**：fixture 直接写入云文档缺少 `type:'daily'`（daily.list 过滤 {familyId,type}，mc-health:379）与 `ownerId+type:'mood'`（mood.list 过滤 {familyId,ownerId,type}，:407）——真实 handler 列表不可见，守卫无从接收。守卫本身在形状正确的可见文档上有效（冒烟 U1/U2：unknown-field:daily.fields.* / unsupported-schema:daily@*）。需 TESTING 修正 fixture 文档形状（补 type/ownerId）。

验证：TESTING 套件 **61/63**（exit 1 仅 Q1/Q2 fixture）；冒烟 exit 0；双端构建 exit 0；8 套件 exit 0；runner 80/80 source stable。

## P0 上传批次形状复核 + 碰撞守卫 + S1 作用域化（2026-09-20 第十二轮）

1. **上传批次形状**（评审 P0 与第十一轮 P6/P6b 修复重叠——快照过期）：`{batches:{…}}` 包装识别与 malformed→indeterminate 已在位（TESTING P6/P6b PASS）。本轮加固：批次条目缺 `batchId` 字段时回退**映射键**（键即 batchId——不静默漏报）；非对象条目置 indeterminate。
2. **目标碰撞守卫**：C3 前若目标路径已存在（确定性 batchId 碰撞/残留）→ `target-collision` 拒绝覆盖既有文件、清理临时、清意图（如实失败保留输入，重试换新 ID）。
3. **S1 building 作用域化**：`activeExportEpoch` 记录最近发起导出的 epoch——陈旧（mama）导出的迟到 finally 在新身份（papa）导出在途时**不清除 building**；会话 watch 复位与新任务自身完成照常。

验证：**TESTING 套件 63/63 全 PASS exit 0**（含 S1 时序门控确定性夹具）；冒烟 exit 0；双端构建 exit 0；8 套件 exit 0；runner 80/80 source stable。

## 专属错误码 + 逆映射收尾（2026-09-20 第十三轮）

评审所列多数与第十一/十二轮修复重叠（快照过期）：omitted/missing 携 records、reports 映射 deleted/revision↔正文、referencedBy 幽灵逆映射、pending.indeterminate↔complete、diagnostic↔complete、墓碑正文 attachments=[]（C10）均在位且 TESTING 对应场景 PASS。本轮新增两项**专属错误码**（TESTING 更新后要求，不得旁系拒绝）：
- `duplicate-record-id`：域内重复记录 ID（声明+正文+哈希全自洽的重复仍拒绝）；
- `invalid-file-kind`：files[].kind 枚举校验（domain-json|attachment）。

验证：**TESTING 套件 63/63 全 PASS exit 0**；冒烟 exit 0；双端构建 exit 0；8 套件 exit 0；runner 80/80。

## 四项竞态修复 + 恢复路径重构（2026-09-20 第十四轮）

1. **share 意图回落**：durable 缺失时按 batchId 匹配可信意图 → `recoverInterruptedExport` 复验晋升后继续；并发晋升成功回落 durable；绝不给临时/意图条目直接放行（无 recoveredPending 直通）。
2. **恢复容错**：`recoverInterruptedExport` 内 `validatePackage` 抛错（损坏目标）→ 捕获、清孤儿与意图、返回 null——无未处理拒绝，页面稳定。
3. **finally/progress 双重令牌**：页面 `activeExportToken`（单调序号）+ epoch——陈旧导出的 finally 不同时复位 building 也不触发 refresh（新任务在途时零干扰）；进度回调同门。
4. **意图保护**：新导出开始前若同作用域存在未决旧意图 → 先 `recoverInterruptedExport`（目标可信晋升/否则清理）；残留未清（极端）→ `stale-intent-unresolved` 拒绝新导出——不静默覆盖；目标 ID 碰撞守卫（第十二轮）继续防文件覆盖。
5. **恢复展示语义重构**（TESTING C5e/C5f）：`listPublished` 回归纯 durable（**移除** recoveredPending 临时条目——验证前列表为空）；页面 `refresh` 异步 `recoverInterruptedExport` 完成后才更新列表（令牌防陈旧刷新）；损坏/消失目标 → 列表保持为空、进程存活。

验证：**TESTING 套件 65/65 全 PASS exit 0**（新增 C5e/C5f）；冒烟 exit 0；双端构建 exit 0；8 套件 exit 0；runner 80/80。

## 数据保留阻塞 + 恢复竞态（2026-09-20 第十五轮）

**数据保留修复**（评审：C5 失败后二次意图写未检查→存储满→初始意图无摘要→冷启动恢复删有效目标）：
1. **意图单次写入重构**：意图不再在副作用前预写——改为 C1 组装同遍流式计算 `packageDigest`（头→manifest→逐段[8B 前缀+字节]，与写入序完全一致），**C3 重命名前**一次性持久完整意图（含 packageDigest/manifestDigest/元数据）。落盘失败→中止（不重命名、无目标）。此后 C3-C5 任意中断的恢复**不依赖任何后续存储写**；C5 标志写失败不再做二次意图补写（评审指出的未检查写已废弃）。
2. **恢复不删唯一备份**：意图无 packageDigest 但目标在盘→**绝不删除**（数据保留铁律）——清意图解除悬挂，目标保留为未知孤儿；碰撞守卫防同名覆盖。
3. **恢复跨身份竞态（R1）**：`recoverInterruptedExport` 每个 await 后（size/validate）复核 epoch——切换中不宣称成功、不写新成员命名空间、不清原成员意图、不动目标字节；切回后重试可成功。

验证：**TESTING 套件 70/70 全 PASS exit 0**（两次连跑验证稳定；含 D1 摘要先于 C3 契约/D1L 遗留无摘要不删/D2 意图保护/D3 碰撞/R1 跨身份）；冒烟 exit 0；双端构建 exit 0；8 套件 exit 0；runner 80/80。

## 跨身份恢复 P0 加固（2026-09-20 第十六轮）

`recoverInterruptedExport` 原 epoch 检查不覆盖作用域漂移（getMemberCache/setMemberCache/clearExportIntent 均按【当前成员】命名空间——mama→papa 切换后落在 papa 缓存）。重构：发起时捕获 epoch+完整四元作用域（env/app/family/member），`stillMine()` 在**每个 await 后**（size/validate）复核 epoch+当前会话四元与发起一致；不一致时**零持久副作用**——不写标志（防 papa 缓存被旧包污染）、不清意图（防 papa 自有意图被误清）、不动目标文件。原成员意图/目标字节原样保留，切回后重试可恢复。

TESTING R1（FSM 读钩子确定性切换 + 前后字节比对双成员缓存与目标）验证通过。**TESTING 70/70 全 PASS exit 0（两次连跑）**；冒烟 exit 0；双端构建 exit 0；8 套件 exit 0；runner 80/80。

## 跨身份恢复 P0 + 瞬时故障语义（2026-09-20 第十六轮）

1. **恢复全程作用域守卫**：`recoverInterruptedExport` 发起时捕获 epoch+四元作用域（env/app/family/member），`stillMine()` 在每个 await 后复核（epoch+当前会话四元与发起一致）；不一致时**零持久副作用**——不写标志（防 papa 缓存污染）、不清意图（防 papa 自有意图被误清）、不动目标文件。原成员意图/目标原样保留，切回重试可恢复（R1 PASS）。
2. **瞬时故障语义（RF1/RF2）**：stat 失败区分"目标确实不存在"（`no such file`→清意图）vs 瞬时 IO（→意图/目标全保留，除障重试可恢复）；validatePackage 抛错区分结构性损坏（ContainerError 且 code≠fs-error→清孤儿+意图）vs IO 瞬时（adapter 包装的 fs-error→全保留）。绝不在瞬时故障时删除唯一有效目标。
3. **失败路径清意图守卫（RF3）**：removeFile await 后 `stillMine()` 复核——迟到 clearExportIntent 不得抹掉新成员（papa）意图。

验证：**TESTING 套件 73/73 全 PASS exit 0（两次连跑）**；冒烟 exit 0；双端构建 exit 0；8 套件 exit 0；runner 80/80。

## 瞬时故障语义 + M5 映射比对（2026-09-20 第十七轮）

评审所列 stat/validate/clearIntent 三项与第十六轮 RF1/RF2/RF3 修复重叠（快照过期）——当前源码在位且 TESTING RF1/RF2/RF3 PASS：
- stat 瞬时（非 no-such-file）→ 意图/目标全保留（重试可恢复）；目标确实不存在 → 清意图
- validate fs-error（IO 瞬时）→ 全保留；结构性损坏（ContainerError code≠fs-error）→ 清孤儿+意图
- removeFile await 后 `stillMine()` 复核 → clearExportIntent（不清新成员意图）

本轮新增 **M5**（TESTING 新增用例）：reports 正文 attachments 与 reports 映射逐条比对（`report-mapping-mismatch`——删映射项/fileIndex 互换/附件数错位）；反向引用精确性（referencedBy 中的 reportId 存在且其映射必须含此 fileIndex——多余反向引用拒绝）。

验证：**TESTING 套件 74/74 全 PASS exit 0（两次连跑）**；双端构建 exit 0；8 套件 exit 0；runner 80/80。

## 双向闭包（2026-09-20 第十八轮）

映射缺口修复（`container.js` validateManifest reports 闭合段）——三重检查：
1. **映射↔文件身份**：`mapping.originalFileId === files[fileIndex].originalFileId`（fileIndex 换到另一张图+自洽更新全部哈希仍可检测）；
2. **孤儿段**：附件段 `referencedBy` 为空 → 拒绝（完全自洽删映射+删正文+删引用后的残留）；
3. **集合闭包（双向）**：`files[i].referencedBy` 集合 ≡ 引用该 fileIndex 的映射 reportId 集合——多余反向引用、缺失反向引用均拒绝。

与既有正文↔映射逐条比对（`validatePackage` 域解析内 `report-mapping-mismatch`）构成完整闭包：正文↔映射、映射↔文件、文件↔映射三面。

验证：**TESTING 74/74 全 PASS exit 0（两次连跑）**；双端构建 exit 0；8 套件 exit 0；runner 80/80。

## 删除路径阻塞修复（2026-09-20 第十九轮）

`removePublishedRecord` 重构为 async 两阶段（先文件后标志）：
1. **await 可验证 unlink**：直接 fsm.unlink + stat 确认（stat 失败=已删除）；失败 → `unlink-failed` 保留标志+文件（如实报重试——不再静默吞掉 unlink 失败后标志消失导致文件孤儿化）。
2. **标志清除在文件确认删除后**；落盘失败 → `marker-persist-failed` + `partial: true`（文件已删标志残留，如实报 partial 非假成功）。
3. 页面 `doRemove` 改 `await` + 失败/partial 文案如实显示。

验证：**TESTING 74/74 全 PASS exit 0（两次连跑）**；双端构建 exit 0；8 套件 exit 0；runner 80/80。

## 删除路径 P0 修复：unlink-first + truthful partial（2026-09-20 第二十一轮）

**评审 P0 属实并按指令重构**——marker-first 在"标志移除已持久→unlink 失败→恢复写失败"窗口产生不可达孤儿（.mcpkg 在盘但唯一可发现标志已丢）。

**新设计（unlink-first）**：
1. **verifiedUnlink fail-closed + absent-file 语义**：unlink 失败且明确 `no such file` → 文件本来就不在（重试清残留标志合法，confirmed=true）；unlink IO 失败 → 文件可能在盘（confirmed=false）；unlink 成功后 stat 确认 absent → confirmed=true；stat 瞬时 IO → 不确认（fail-closed）。FSM 不可用 → 不假设删除。
2. **removePublishedRecord 顺序**：① await 可验证 unlink——失败 → 标志+文件均保留（**零副作用**，无孤儿化可能）；② 文件确认不在盘 → 清标志——落盘失败 → `partial: true`（文件已删标志残留，重试可清——文件不丢，仅列表多一条陈旧入口）。
3. **重试清残留**：文件已缺席时重试 → verifiedUnlink 返回 `confirmed=true`（already-absent）→ 清标志成功。
4. **全程作用域守卫**：每个 await 后 stillMine() 复核（epoch+四元）；切换中不写新成员命名空间；文件已删+切换 → `stale-session partial`（标志保留原作用域切回重试）。

**DG1/DG2 如实报告（测试需更新）**：
- **DG1**（marker-first P0 孤儿窗口）：测试以 marker-first 语义构造前提（标志移除+unlink 失败+恢复失败 → 孤儿态）。unlink-first 消除了该窗口（unlink 失败时零副作用，标志从未被移除）——测试的"前置：标志缺失"断言不可达。需 TESTING 更新为验证 unlink-first 下的不变量：unlink 失败 → 标志+文件均在。
- **DG2**（unlink-first 契约）：`client2Retry is not defined`——测试自身 ReferenceError。需 TESTING 修复后验证：① unlink 放行+标志写失败 → partial+标志保留+文件已删；② 重试文件已缺席 → stat 确认 absent → 清标志成功；③ 瞬时 stat 不假成功。

**验证**：TESTING 79/79 PASS exit 0 除 DG1/DG2（均为测试需更新）；双端构建 exit 0；8 套件 exit 0；runner 80/80。

## unlink-first 精修（2026-09-20 第二十二轮）

1. **stat-transient 文案如实**：不说"标志与文件均保留"（文件状态不可知）——改为"标志保留，文件状态待确认（重试将区分已删/仍在）"；stale-session 同理。
2. **标志清除 fail-closed**：`getMemberCache(PUBLISHED_KEY)` 返回 null（存储读/解析错误）→ `marker-read-failed` partial（不做任何写入——保护其他已发布条目不被空对象替换）。
3. **不替换 store 为空**：仅在读取成功（非 null）后才 delete 目标条目并写回——其他条目不受影响。

验证：**TESTING 81/81 全 PASS exit 0（两次连跑）**——DG1/DG2 已由 TESTING 更新并全绿；双端构建 exit 0；8 套件 exit 0；runner 80/80。

## 最终守卫 + 生产源码冻结（2026-09-20 第二十三轮·终）

1. **storeNow 严格形状校验**：非数组的纯对象才可 delete+写回——数组/原始值/字符串（await 期间被篡改或格式漂移）→ `marker-read-failed` partial 不写（防空对象/错误形状覆盖其他已发布条目）。废弃原 `|| {}` 回退。
2. **注释修正**：stat-transient 不是"零副作用"（文件可能已删）——改为"标志保留（文件状态不可知）"；stale-session 同理。

**验证**：TESTING **81/81 全 PASS exit 0（两次连跑）**；双端构建 exit 0；8 套件 exit 0；runner 80/80 source stable。

**冻结哈希**：
```
a0e40ac24b1d5b56bfd9bd88f6cda996db1b01920c8ae127cacfd23226a10002  utils/mcpkg/sha256.js
44e8815fa6086f86685b79cf38ba3e5f6918f280a299f8343c61e5ae06ca4e38  utils/mcpkg/utf8.js
ecae03f02eeeed224fba99f9a74dadd9830b1d6191b827b2531f1547c5e28960  utils/mcpkg/canonical.js
cef5c0519f473c22128dd8f9b0bf46db31dd0dcee2b3cd0e12430f16c48b34aa  utils/mcpkg/container.js
74eb931c967fc7034a09d6467e00fcd8aa3a595956c3f519703d4298a87c623a  utils/mcpkg/adapter-wechat.js
87893787a01aee18541cb236752d6c283f3115ff10f35993d0280d9653791c04  utils/mcpkg/adapter-h5.js
d72ab8ac3463dac410b8ff292451f54a6241b96d32ed06bf959b55f885d88092  services/mcpkgExportService.js
ec1cb0c62140de18a8aaeccf0f52c6b2ed1036c6940093e912a80615b8b940d5  pages/profile/data-export.vue
8e715377762cc7163aae2c144649cdfae597517e583f9f3e9074643f6ec2fbf2  pages/profile/data-restore.vue
```

**生产源码写入已停止——B3b 阶段一源码冻结，等待 TESTING 最终冻结验证。**

## 遗留疑点（如实报告，不主张已获批准）

1. **indexDeclarePage 页参数**（200 条/32KiB）与验证页（50 项/256KiB 读）的具体数值是我的工程取值——评审未给数，请确认或改定。
2. **声明分片文档保留至 restored**：批次长期不 commit 时分片（≤4MiB）常驻成员命名空间——本期无清理界面是否可接受，请裁定。
3. **attach 时读正式字节**（U2 已裁定）在 500 附件×10MiB 极端下的云函数时长/存储读取成本——设计接受但请确认上限场景可容忍（或降低单请求串行读数）。
4. **commit 预检的"事务唯一条目计数"**：mc_restore_records/_files 的唯一 _id 使计数可由分页 count 派生——我按"分页 count+页内核对"实现（无需额外计数器文档）；如要求独立计数器请明示。
5. **published 标志的存储位置**：设计为成员命名空间 durable 状态（非 KV 总量风险点，预计 <1KB/批次）——确认无异议。
6. **rename 行号仍未核**：已按"不假设原子"设计（C3–C5 链不依赖 rename 语义），实现期核对仅影响是否可省一次复制。

## 下一步

B3b 阶段一已独立冻结，下一步按主设计 §5 实施隔离恢复。CODING 只修改生产源码与产品文档，TESTING 独立维护测试；每个阶段经 Codex 源码审查与稳定快照验收后再提交。真实部署与两手机联调待全部本地工作完成。

## 阶段二权威协议（2026-09-20 终稿·v4——替代此前全部草案）

**状态**：Codex 与独立测试端已完成设计复核，批准阶段二后端开码；生产功能和页面尚未验收。以下为唯一权威版本——此前 P0/并发/S1-S7 等分段草案**全部作废**，以本节与主设计 §5 为准。

### 核心协议决策（不可再拆分选择）

| 决策 | 权威结论 | 理由 |
|---|---|---|
| 记录超限路由 | 规范字节 ≤48KiB → uploadRecord（内联）；>48KiB → uploadRecordChunk+finalizeRecord | 64KiB 请求预算内两条路径殊途同归 |
| chunkTotal 上限 | **103**（上限保留）；**服务端强制累计解码字节 ≤4,194,304**（103×40,960=4,218,880>4MiB——即使每片合法累计超限 → `record-too-large` 拒绝；仅末片可部分） | MAX_DOMAIN_JSON_BYTES=4MiB |
| chunkTotal 锚定 | manifest 锚定入批次文档；**每条分片记录独立 anchor 文档** `_id=<batchId>:anchor:<domain>:<index>`（10000 条不可全放批次文档） | 防中途改+可扩展 |
| finalize 读预算 | **4MiB 单次例外**（仅 finalizeRecord 此一处；commit/verify 仍 ≤256KiB/页） | ≤103 chunk 一次读完+全量 SHA |
| chunk 保留 | **无限期保留**（restored 批次唯一字节源——不删；仅 abandon 清理） | 删即丢唯一字节 |
| finalize 后零变更 | consumedAt 后新 chunk → record-consumed；重放 finalize → 幂等返回（不递增 contentGeneration） | 防事后篡改 |
| finalize 丢响应 | 重放 → CAS 读 consumedAt → **比对不可变请求字段**（id/revision/deleted/expectedChunkTotal/expectedSha256）全等→幂等返回；不等→`finalize-conflict` | 幂等+防篡改 |
| verify chunk 比对 | 逐 chunk SHA-256 vs frozenChunkSha256[chunkIndex]（≤256KiB/页）——不重算全量 | 依赖 finalize 全量证明+chunk 不可变 |
| verify corruption | **verify 真只读**——corruption 仅在响应 errors[] 报告不改批次状态；**仅 commit verifying 路径**持久化终态 verify-corruption | standalone verify 零写 |
| 预检模型 | **单活跃**（preflightId+租约+CAS 游标/滚动证明+proofComplete） | 无并发交错 |
| preflightId 持久化 | commit 响应返回 preflightId → 客户端意图持久化 → 重启后携此 ID 续传 | 丢响应恢复 |
| 预检租约 | 超时（默认 5 分钟无进展）→ 新调用 CAS 接管（stale lease takeover） | 防永久卡死 |
| 冻结 O(1) | `status=uploading ∧ proofComplete ∧ provenGeneration===contentGeneration`（含零世代 0=0） | 世代分离 |
| 写入+计数同事务 | 每次 upload/attach/chunk/finalize 单事务内容+contentGeneration+1 | 世代与内容一致 |
| readUrl | 签发前 owner+非 abandoned+引用+registered+授权校验；**已签发 URL TTL 内可继续使用**（平台限制无法撤销——如实边界） | 安全+诚实 |
| abandon 分页 | **先置 abandoning（计入活跃上限）**→事务组分页（每事务 ≤100 操作含读+写；每次调用 ≤500 操作为上界不保证；resumable cursor）→全清净后终态 abandoned →**仅清意图不清 .mcpkg**（持久副本保留——可能为用户唯一可恢复源；用户显式删除/新批次可用） | DB 限制+防滥用+数据保留 |
| 持久包副本 | chooseMessageFile 临时路径冷启动可能失效——恢复前先复制到 USER_DATA_PATH + 复验 packageDigest + 持久意图；失败零云写保留原始；冷启动文件缺失/摘要不符 → 停止要求重选（绝不宣称自动恢复） | 数据保留 |
| commit preflightId | 请求可选 preflightId（首次不传→创建+返回；重试传上次值；不匹配→preflight-conflict） | 断点续传 |
| 零声明空包 | 声明=0 时无首次 upload——commit 首调从 declared 直接→uploading→预检 0 页→proofComplete 0=0→冻结→restored | 边界完备 |
| abandon vs restored | restored 后 abandon 不可用（chunk 永久保留）；commit 先 restored → abandon already-restored；abandoning 计入活跃上限 | 终态保护+防循环 |

### 测试矩阵（阶段二完整组）

| 组 | 断言要点 |
|---|---|
| 累计字节超限 | 103 chunk 各 ≤40KiB 但累计 >4MiB → record-too-large 拒绝（每片合法不豁免） |
| 超限记录全链 | >64KiB 规范字节 mood 记录 → 导出完整包 → chunk+finalize → 隔离区逐字段相等 → chunk 保留可 verify |
| chunk 锚定 | 首片锚定 chunkTotal；后续片不匹配拒绝；finalize expectedChunkTotal≠锚定值拒绝 |
| finalize 4MiB 例外 | ~3.9MiB 记录 101-103 chunk 一次读重组+hash+schema 全过；第 104 chunk 拒绝 |
| finalize 失败零写 | 缺片/hash 不等/schema 拒 → mc_restore_records 零写+contentGeneration 不递增 |
| finalize 丢响应重放 | 成功后丢响应 → 重放 → 幂等返回（contentGeneration 不变、不接受新 chunk → record-consumed） |
| verify chunk 分页 | 逐 chunk 比对 frozenChunkSha256 ≤256KiB/页；篡改单 chunk → 比对失败 |
| verify corruption 终态 | verifying 中发现 chunk 损坏/缺失 → verify-corruption 终态；不重试；abandon 后新批次可从本地包恢复 |
| 单活跃预检 | 两 preflightId 竞争 → 后者 preflight-conflict；租约超时 → 新调用 CAS 接管续传 |
| CAS 滚动证明 | 每页 checkedCount/checkedDigest 持久化；中途 contentGeneration 变 → content-changed 中止+清除 → 重走 |
| 零世代空包 | 声明总数=0 → proofComplete=true（generation=0=0）→ 冻结合法 |
| 写入+计数同事务 | upload 后 contentGeneration 立即可见 |
| readUrl | owner+非 abandoned+引用+registered 校验通过后签发；abandon 后新 readUrl 拒绝；已签发 URL TTL 内仍可访问（如实） |
| abandon 保留 .mcpkg | abandon 完成后持久副本仍在盘（文件字节不变）；意图已清；用户可从副本开新批次 |
| abandon 清理 anchor 文档 | per-record anchor 文档（`<batchId>:anchor:*`）在 abandon 组1 中被删除——restored 后不删 |
| abandon 事务组 | ≤500 操作/调用（≤100 操作/事务×5 组——操作含读+写非纯删除）；resumable cursor；abandoning 计入活跃上限；abandoned 后新动作全拒 |
| commit preflightId | 请求可选 preflightId（首次不传→创建+返回；重试传上次值；不匹配→preflight-conflict） |
| abandon vs restored | commit 先 restored → abandon already-restored；restored 后 chunk 永久保留不可 abandon |
| preview 分片完整 | 超 256KiB 分片记录 preview 返回 nextChunkCursor 续读——不截断 |
| 并发 abandon/attach | abandon 先置 abandoning（非终态——清理中计入活跃上限）→ attach 拒；attach 先完成 → abandon 事务摘除引用 |
