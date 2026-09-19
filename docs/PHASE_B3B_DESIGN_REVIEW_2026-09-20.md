# B3b 设计评审（Codex，2026-09-20）

当前结论：**阶段一已通过本地 review（2026-09-20）**；§5 隔离恢复仍待单独编码、验证和验收。下文开头的“必须修订”及在途缺陷是当时的审查记录，最终修复和冻结证据见文末。仅合成数据；部署仍留到全部本地任务完成后。

## 必须修订

1. **清单先于文件，摘要却尚未取得**。容器头后的 manifest 需要每个文件的准确长度/SHA-256、每条记录的声明，而 §2.4 直接写头+manifest 后才写文件。定义有界临时分段文件（或严格两遍读取并锁定同一字节内容）：先完整分页、下载、序列化、分块算哈希并落临时文件；构成清单；再顺序追加到 `.partial` 包，分块回读、校验整个包，最后原子或带校验的发布。磁盘满/读取变化保留输入、清理不可信临时产物，不得让 `.partial` 被分享。manifest 的 `complete` 仅表明**来源范围完整**；页面的“已生成且验证通过”状态须等最终包校验后才能显示，不要循环地要求改写清单。
2. **服务端冻结声明须与真实包清单逐项同一**。目前 manifest 只有 `recordRevisions`（没有逐记录 SHA/确定的 index/deleted 标志），但 `declareChunk` 声称从中冻结 `{domain,index,id,recordSha256}`。把每条记录的 index/id/revision/deleted/hash 写入 manifest，给 JSON 规范化与字节哈希定唯一规则；分片上传的应是此 manifest 的原始 UTF-8 字节。服务端重组后验证 `manifestDigest`、全部映射/范围/上限，派生不可变逐项声明，再允许上传；`uploadRecord` 从规范化内容重算哈希而非信任客户端传值。`packageDigest` 在未上传整个包时只是客户端本地验证的承诺，不能称服务端验过包字节。
3. **分片运输及总量边界不自洽**。`chunkBytes(UTF-8 JSON ≤60KiB)` 遇转义/非 ASCII 或 base64 会超过 §2.2 的 64KiB 请求。建议每片最多 40KiB 原始字节、base64 编码、≤128 片（4MiB 至多 103 片）；对最终序列化 event **和响应**执行字节预算校验。分片一片一文档，有序索引+单片摘要，同索引同内容幂等、换内容拒绝、乱序/缺片明确失败。不能将 4MiB manifest 或 10000 条逐项声明塞进单个数据库文档，**末片调用也不能一次写 10000 条声明**；定义可续传的有界索引/冻结分页，全部完成才从 declaring 进入 declared。
4. **大批次完成不能依赖一次无界 commit**。10000 记录/500 文件的 `restore.commit` 逐项读校验可能超单次云函数时间或响应。定义有界分页验证和持久进度、冻结上传后的不可变 `verifying` 阶段，最后原子推进 `restored`；任何一页失败仍可从稳定位置重试，绝不提前返回成功。`verify` 是只读复验（可分页），或明确作为完成状态的动作，但职责不能混淆。记录和文件在已验证后不可被更换；原件字节在 attach 时已读并验 SHA，引用与文件 registered 状态同事务。给缺项清单游标与失败码。
5. **`complete=false` 的包不能当完整恢复依据**。pending、分页失败、schema 不支持、交付前版本/墓碑变化时，不允许“完整备份”或“恢复完成”的文案。可以提供明确标注的诊断包供用户主动导出检查，服务端隔离恢复必须拒绝不完整包（或另设计有专名的部分恢复及不混淆状态；本期建议拒绝）。构建时检查 pending 两次；尚未同步的本地草稿无法被服务端全量包覆盖，页面列出具体项目并提供处理入口。
6. **清单 schema 和墓碑/附件映射**。逐域用判别结构区分 `present`（含 fileIndex、recordCount、pagingComplete）与 `missing`（原因，无有效 fileIndex）；所有当前受支持域包括真实空域都明示。报告与其它领域的墓碑保留 deleted/revision，不下载已删报告不可读原件，也不凭缺失原件声称完整。附件一段可被多个报告/页引用：`attachFile` 只传 fileIndex 和新登记的 fileId，服务端从冻结声明派生全部引用，拒绝报告/顺序与 manifest 不一致；隔离原件读取仅 owner 且校验批次、引用、registered 与当前身份。现有 mc-files `getReadUrl` 对 everAttached 拦截，mc-reports 的 cleanupOrphans 在注册文件无引用时会领为 cleaning，restore 的引用必须复用同一事务边界。
7. **批次 ID/身份绑定**。`rst_<digest16>_<createdAt>` 可能同毫秒碰撞且只绑定摘要前缀；采用密码学随机 128 位 nonce（失败即停止），在任何副作用前持久化，绑定完整 manifest/package 摘要、环境、app、当前 family/member。`begin` 同 ID 同全量内容幂等、任何内容变化拒绝；同包再次恢复生成新 nonce。包内 createdBy/familyId 仅供展示，私人来源须本人确认，不可用包字段授予权限。

现有 `services/migrationStore.js` 的 `sha256HexSync` 会一次性分配整个输入及填充缓冲区；B3b 须抽取 SHA-256 的块压缩逻辑并新增真正的增量 `update(Uint8Array)`，而不是直接复用该函数处理 64MiB 包。`utf8Encode` 对孤立代理项的字节行为也须明确为拒绝或标准替换，并用跨端相同测试向量证明。

## 已裁定选择

- U1：全部批次动作和列表仅 batch owner 可见，含纯共享包；家人可用原包开启自己批次。
- U2：attach 时由服务端读取正式文件的实际字节、校验长度/SHA-256；不能仅信登记元数据。清理竞态命中 cleaning/deleted 则拒绝并保留原件供重试。
- U3：请求 JSON ≤64KiB、响应 JSON ≤256KiB；40KiB 原始分片经 base64 运送，最终序列化字节检查，至多 128 片。
- U4：全量逐记录声明，包含稳定 index/id/revision/deleted/hash，分散存储。
- U5：有 pending 可生成显式 **不完整诊断包**，不能标完整备份且拒绝本期隔离恢复；完整包须待处理清零。
- U6：单记录从规范化字节算 SHA，整请求 ≤64KiB；超界拒绝该包/记录并如实报错。
- U7：用户原包不自动删除；沙箱临时副本可给出明确容量/清理策略，别承诺永久保存。
- U8：`verify` 只读、分页全量复验（记录与原件），成本和进度如实显示；`commit` 的最终状态必须已经满足所有声明。
- U9：持久化随机批次 nonce + 全摘要 + 当前可信作用域，失去安全随机源时停止。

## 测试方补充（纳入修订矩阵）

三张互异 PNG 的字节、像素与反序页序；真实页面事件→共享 codec→平台适配器→真实云函数 handler；墓碑与同索引不同内容；未知 schema/重复 ID/非法映射；40KiB 分片与 64KiB/256KiB 序列化边界；manifest/包 4MiB/64MiB 界；临时包崩溃、磁盘满、分片丢响应、分页验证中断和重启；附件共享、cleaning 竞态、私人 canary 跨成员/家庭/环境；H5 仅本地选包/验包，云端导出恢复显示不可用。模拟通过不等于真机/真实部署。

文档修订通过后，先实施 codec/只读本地包验真与导出，再实施隔离恢复协议。每段由独立 TESTING ZCode 测真实路径，Codex 审源码/测试/冻结证据后才提交推送。

## 修订版 3 复审（仍暂不放行，2026-09-20）

合并设计 rev3 已解决有界暂存、逐记录哈希、40KiB 分片、owner-only 与 H5 边界的主要方向，但以下新矛盾仍会使生产路径错误：

1. §2.3/§2.5 又写 `manifest.complete=true` 需要“整包终检通过”，但 manifest 必须在终检前写入容器。应按本评审第 1 条：`complete` 表示**所选范围的来源完整**（可在 manifest 生成时决定），`published` 才表示整包终检通过。二次 pending 检查若变化，必须阻断发布并重建 manifest/包（不能只改 UI），或失败保留输入。
2. §5.0 的 `restore.begin` 只收到客户端自报 `packageKind`，没有 manifest，也没收到 `complete`；因此不能声称 begin 能拒绝自报 full、实为不完整的包。begin 仅创建不可变摘要承诺；`declare` 重组解析后由**服务端**判断 packageKind/complete/pending/所选域范围，不合格批次拒绝进入 declared，且不会接收任何记录或附件。客户端可在选择包时更早拒绝，但不替代服务端门。
3. §5.1 的末片 declare 仍试图在单次请求派生/写完最多 10000 条声明；增加 `indexDeclarePage` 一类有界、可恢复动作与 `indexing` 状态，持久游标和去重键，所有条目/附件的声明索引写齐且复核摘要与总数后才标 declared。分片保留/过期/失败恢复也要有最小协议，不允许一处单文档或一次无界写。
4. §5.1 commit 首调“核对全部已上传”仍无界，且如果错误地先推进 verifying，上传被冻结，补传无门——批次会永久卡住。用事务维护的已接收唯一条目计数+有界预检，或在 uploading 下分页发现缺项并允许补传；只在可证明全齐时原子冻结进 verifying。验证页按**条目和读取字节量**都设上限，进度分页存储，失败不能提前 restored。progress 的 10000 index 清单也需要分页。
5. `domains` 中 `missing:'excluded-by-scope'` 是用户明确不选的私人域，不是选中域读取失败。两人各自不能导出对方私人心情；需定义 full 为**已选择且有权读取的范围**完整，预览/分享文案明确“仅共享”或“共享+本人私人”。未选择域显式标 omitted/排除，不把它误判为不完整；选中域失败才 diagnostic。服务器按冻结 scope 复核，不能让上传者自称全家私人备份。
6. `rename` 可用不等于原子发布保证；若未能证实其原子性，统一采用临时名→目标名→目标文件分块复验→持久 published 标志。崩溃后若目标名已存在但标志未落盘，重启先复验再恢复可分享状态。绝不只凭目标文件存在提供分享。明确 packageDigest 覆盖头至 EOF，`totalSizeBytes` 与实际长度一致。
7. rev3 页首声称“§6 B3a 原文保留”，但与 `HEAD` 比对可见 §6.2、§6.3 已缩写并删掉持久批次 schema、字段选择摘要与具体作者确认、outbox/修订约束。B3b 不能改写已验收的 B3a 协议；恢复 `HEAD` 的 §6 正文（标题注记可更新），再核对 `git diff` 中 §6 除标题外零变动。

测试方矩阵另指出规范 JSON 的孤立代理项处理、安全随机源 API、声明分片回收、verify 的游标/进度字段尚未定。当前 B3a 的 `sha256HexSync` 是整输入函数，不是增量；必须在设计里明确升级为固定小缓冲的块处理与跨端向量。修订后先让独立测试方对照最终协议再开代码阶段。

**UTF-8 裁定**：B3a 旧 `utf8Encode` 对孤立代理会产生如 `ED A0 80` 的非法 UTF-8；`.mcpkg` 不能把此行为继承为格式。清单和记录序列化前检测孤立代理并明确拒绝（原输入保持可恢复）；SHA 增量接口只接收 `Uint8Array`，UTF-8 编码与字节分块分层测试。规范 JSON 应排除 `undefined`、NaN、Infinity、循环引用等非 schema 值，避免不同运行时序列化漂移。

主设计 §2.2 的官方文档路径须修正为真实可访问的 [请求上限](https://docs.cloudbase.net/error-code/EXCEED_MAX_PAYLOAD_SIZE)和[响应上限](https://docs.cloudbase.net/error-code/EXCEED_MAX_RESPONSE_SIZE)；现写成 `EXCEEDMAX...` 会造成审查者无法核对。它们分别列出云函数文本请求体 100KB、小程序链路响应体 1MB；64KiB/256KiB 是本应用的保守限额，并非微信 API 自身的保证。

## 修订版 4 补充核对

- 已确认 §6 B3a 正文与 `HEAD` 逐字相同；严格 UTF-8、真实官方链接、selected-scope completeness、发布标志、indexing 状态已落稿。
- **导出尚需明确**：`manifest.totalSizeBytes` 包含 manifest 自身长度；更改数值可能改变 JSON 字节位数，从而改变总长度。可以删去这个冗余字段，让验证器由头、段长和实际 EOF 独立计算；若保留，Stage B 要用有界迭代求稳定总长，超出安全整数/循环不收敛则失败。最终 packageDigest 不写回 manifest，避免自指。
- **导出身份门**：`published` 标志与待分享沙箱路径需绑定当前 env/app/family/member 与完整包摘要；切成员、同成员切家庭或重新确认之后，旧页面回调与旧标志不可驱动新身份下的分享按钮。用户主动分享前再次核 epoch/作用域并复验目标文件摘要；标志仅表明曾验证，不代表文件后来未被覆盖。
- 严格 UTF-8 校验还要扫描 **JSON 解析后的字符串**：JSON 文本可用 ASCII `\ud800` 逃逸一个孤立代理而原始字节仍是合法 UTF-8；仅验证原始字节的 UTF-8 合法性不够。manifest、每条记录及服务端声明解析后都须拒绝该值。
- **恢复尚需明确**：rev4 `restore.verify` 称只读，却写“游标与进度字段持久化于批次文档”；只读复验应返回下一游标和计数，由客户端保存 UI 进度，或将其另命名为会写审计进度的动作，不能同时声称零副作用。对 10MiB 附件且每请求 ≤256KiB 读取预算，游标须包含 `fileIndex` 与文件**字节偏移**，连续哈希状态或已验分块承诺须可安全续接；仅按“50 项一页”无法复验一个 10MiB 文件。commit 若只用文件元数据，应明确沿用 attach 时的实际字节证明并靠事务引用阻止清理。
- `indexDeclarePage` 的最终“重算全部已索引声明摘要”不能又在末页一次读取 10000 条；页内校验并持久聚合承诺、最终 O(1) 核对计数/摘要，或把最终核对本身分页。长期未完成的声明分片占空间，至少给出用户可达的批次取消与按 owner 清理范围；既然本期不做永久清理界面，可先限定单成员活跃批次数并如实留待部署前容量评估，不能无限常驻且页面无出口。

## 修订版 5 阶段一复审

rev5 已移除自指总长，区分 complete 与 published，定义 256KiB 附件块摘要、只读 verify、分页索引聚合及 owner 可取消批次；独立测试方认为阶段一契约可测。阶段一准入仍需以下四项写入主设计，然后只批准共享 codec、微信活体全量导出与发布、H5 本地验包及页面入口；隔离恢复另行评审。

1. published 持久标志和页面分享回调绑定可信 env/app/family/member 与身份 epoch。用户主动分享时重新核对当前作用域并分块复验目标文件完整摘要；同成员切换家庭或新成员登录后，旧页面状态、旧回调、旧标志均不得授权分享。失败保留原输入、清理失信产物。
2. 严格 UTF-8 拒绝应覆盖 JSON 解析后的字符串，包括 ASCII 文本中的 `\\ud800` 等转义孤立代理；manifest、领域记录及服务端声明同一规则。仅按原始字节判 UTF-8 合法不足够。
3. 给 `FileSystemManager.appendFile` 官方 typings 行号；C1 每段回读和 C4 目标文件复验都按 ≤64KiB 分块，不得一次读取 10MiB 段。
4. 交接文档明确阶段一范围与测试矩阵：三张互异 PNG 实际解码与反序页序、真实分页 handler 到分享按钮、记录/墓碑与诊断标注、边界/磁盘满/崩溃恢复、身份切换、`File.slice()` H5 只读验包及双端构建。测试须覆盖真实页面路径，mock 的文件 API 按官方契约构造；模拟通过不代替真机/部署验证。

rev6 落稿复核：上述四项已写入主设计及交接。**实现注意**：`services/sessionService.js` 的 epoch 是进程内会话计数，冷启动重新从零递增；published 标志的 `epochAtPublish` 是历史审计值，不能要求冷启动后与当前 epoch 数值相等，否则已发布包永久失去分享入口。重启恢复须先以当前可信 env/app/family/member 重建页面会话、复验目标包，然后把本次分享操作绑定**新会话 epoch**，每个异步边界重新检查它。冷启动同身份可恢复分享，切身份或切家庭仍必须拒绝旧回调。

**实现期复核点**：CloudBase 现有 `daily.list`、`checkup.list`、`report.list`、`bag.list` 的游标分页只保证单次按字段排序的页面，跨集合没有快照事务；收集期间若新增一条排序位置已经越过游标的记录，只重读既有记录的 revision 无法发现。发布前 C2 必须以有界二次全域扫描比较逐条 ID、revision、deleted 与附件引用（或有等效的可信范围版本承诺），发现新增/删除/变化则重建或失败并留原输入。为测试构造“第一页后插入游标前方记录”的反例，不得标 full 后发布旧集合。

## 阶段一在途源码审查（未冻结，不代表最终验收）

- `utils/mcpkg/sha256.js` 首版空字节摘要实际为 `c3b657e20f72f25a3b0acca57901729427fbceb3dde9079ac298ed0ed8b852ad`，标准 SHA-256 空输入应为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。用 Node crypto 对照 `createHash().digest()` 可复现，编码方须修正后做多长度/任意切块回归。
- `utils/mcpkg/canonical.js` 首版 `JSON.stringify(value)` 后才严格编码，会把孤立代理转成 ASCII `\\ud800`，绕开编码前拒绝；键与嵌套值应先递归检查。数组的 `undefined` 目前变成 `null`，而合同要求拒绝；稀疏数组也不能生成无效 JSON。

  独立 Node/esbuild 探针在后续在途版本仍复现：`canonicalJsonBytes({note:'\\uD800'})` **ACCEPT** 为 `{"note":"\\ud800"}`；`canonicalJsonBytes([undefined])` **ACCEPT** 为 `[null]`；稀疏一项数组 **ACCEPT** 为 `[]`。拒绝发生在任何写包前，不能靠导入侧验包兜底。
- `utils/mcpkg/container.js` 首版 `validatePackage` 只按段计算 SHA，尚未解析每个 `domain-json` 并按 manifest `records[]` 逐条比对 hash/index/id/revision/deleted；`validateManifest` 允许缺失受支持域和可选 `chunkSha256`，而设计要求完整显式域与附件块承诺。最终验包不能把这些情况报 `ok:true`。本节基于编码过程快照，待完成后重核，不直接改生产源码。

增量 SHA 在编码进行中已被更新；再次独立对照 Node crypto，0/1/55/56/63/64/65 字节当前均一致。首版失败仅作为已捕获和修复的过程记录；最终仍须测长输入及任意分块组合，不以这次小范围通过代替验收。

- `services/mcpkgExportService.js` 在途版本的 `collectPendingLists` 对不可读 outbox/草稿/缓存捕获异常后当作空清单；现有 `outboxReadable()` 明确将损坏/不可读与空队列区分。任何必要来源不可判定时须阻断 full 或标 diagnostic，不能静默产生完整包。上传批次应核查 `b2b2-upload-batches`、`b2b2-recovery` 等真实键，不能假定只在 outbox。
- `includeShared=false` 时孕期仍先读并置 present，后面的 `if (!domains[k])` 不会覆盖；非本人 `includePrivateOf` 不报错而将 mood omitted，但 manifest 自报非法私人范围。按当前可信身份先验证选择，再按选择收集和生成清单。
- `sharePublishedPackage` 首次核作用域后 await 整包读取，**却在 await 结束后才读取 currentEpoch**；身份在读盘期间切换则可能以新会话分享旧标志。须在第一次作用域检查前捕获当前 epoch，读盘每一异步边界/发起分享前均复核同一 scope+epoch。发布侧 C4/C5 之间也要逐步复核并 `setMemberCache(..., epochAtStart)`，防止旧导出将标志写进新成员缓存。
- `utils/mcpkg/adapter-wechat.js` 的 `publishToTarget` 和导出服务的首写/manifest 追加必须接受真实 64KiB 写入预算；尤其一次 `appendFile(manifestBytesAll)` 可达 4MiB。段回读及目标复验不能只限制读取，写入和校验都需有界。
- `pages/profile/data-export.vue` 在途版本的 `publishedList` 是普通 ref，仅在初次载入/导出/分享后刷新；会话成员变化时 watch 只改变 `dataSource` 的字符串，confirmed→confirmed 不触发列表刷新，旧成员的备份元数据在新成员页仍可见。订阅会话版本立即清空旧列表并从新 scope 重新读取，页面进度回调也绑定发起 epoch；pending 清单应显示 uploadBatches，不能隐藏一类待处理项。
- `removePublishedRecord` 当前先删除持久标志再尽力异步删除文件，随后页面显示“已删除”；删除失败会留下无法从列表找回的沙箱包。应把作用域核验、文件删除结果与标志变更的次序和失败恢复设计清楚；不能把原件丢失或未删除状态报成成功。
- **真实字段丢失**：`pregnancy.get` 返回 `{fields:{lmpDate,dueDate,...},revision,...}`，导出服务却从记录**顶层** pick `PREGNANCY_FIELDS`，非空孕期资料会被写成只有 revision/deleted 的空正文。`checkup` 的源字段 `time/companion/materials/questions`，`bag` 的 `name/location/assignee/prepared`，也被当前投影白名单漏掉（误写 `text/done`）；这些缺失没有进入 `incompleteReasons`，会产出虚假的 full。必须按实际 handler 视图逐域投影、保留 id/revision/deleted 和每个有意义字段，种子回读逐字段断言；字段无法保全就诊断/拒绝，不能静默丢。
- 验包结构也要证实 manifest 与领域 JSON 使用同一规范字节（非规范顺序、重复 JSON 键/歧义编码拒绝）；不能仅 `JSON.parse` 后对其中一部分字段做检查，便把整个文件判为可用于恢复的完整包。
- 当前 `listPublished` 只读已完成标志，未实现“C3 目标文件已存在而 C5 标志未落盘”时的重启发现/整包复验/补标志，用户会失去刚生成的包。需在 C3 前持久化成员/家庭作用域的待发布意图（含路径和清单摘要），冷启动确认身份后据此复验目标并续落标志；失败如实保留原输入。导出 Stage A 的下载临时路径也不等于已持久暂存，重启续构若未实现应明确从头重来而非宣称可断点续构。
- 磁盘满/读盘失败等抛错大多未在 `buildAndPublishPackage` 的顶层捕获，`data-export.vue` 的 `doExport` 只有 `finally` 没有 `catch`；用户可能只见状态停在“组装中”，留下 `.partial` 且没有可重试失败说明。给收集、组装、发布、标志持久化各步统一失败出口和精确阶段错误，清理仅本批次临时产物，保留输入。

独立测试草案的 B2 一度把 `undefined` 改为 JSON.stringify 的“对象跳过/数组 null”语义，这与已批准的 §2.4 “非 schema 值排除，导出时记录级校验拒绝”相反，会掩盖字段丢失。测试应明确拒绝对象与数组中的 undefined 和数组空洞；不能为了适配在途源码而改弱验收规则。冷启动用例的测试夹具应保留同一成员持久 storage/FSM 文件而重建进程状态；若 `makeStack()` 同时清空 storage/文件，失败原因就不是产品冷启动。

### 当前快照补充阻断项（仍未冻结）

- `canonical.js` 的对象路径仍过滤 `undefined/function/symbol`，稀疏数组的 `Array.map` 跳过空洞，键本身未经孤立代理检查；三个入口都能被序列化为貌似完整的规范 JSON。对象值和键应逐项拒绝，数组每个索引须以 own-property 检查，测试保留这些拒绝断言。
- `container.js` 的 `validatePackage` 目前按 `recordHash` 对照 `records[].hash`，没有逐项对照声明的 `index/id/revision/deleted` 与领域正文，也未复算原始 manifest/领域 JSON 是否恰为规范字节。可构造“SHA 与正文一致但 manifest 的 ID/修订/删除标志被改写”的包，不能报 `ok:true`。对来源正文不含 id 的孕期记录需先固定 `pregnancy` 特例的映射规则；对其它域按实际投影 id/dateKey 映射。
- `secondScanCompare` 覆盖分页域，但孕期 `pregnancy.get` 是首扫后到发布前的单记录；在此期间变化也要重新读取并核对 revision/deleted/字段或等价版本承诺。若把 `pregnancy.fields` 一并投影，此处还须确保不把旧值发布为 full。
- `data-export.vue` 目前待处理卡片只在 `pendingCount > 0` 显示，但 `collectPendingLists().indeterminate === true` 且五类数组均空时 `pendingCount===0`；页面隐去“来源不可读”警告。`doExport` 的异步抛错仍没有 catch，旧导出完成后的 `r.ok` 状态写入也应核对发起 epoch，不能覆盖新身份页面状态。
- `getMemberCache()` 和 `pendingDrafts()` 在 `sessionService.js` 均捕获存储读取/JSON 解析错误并返回 `null`；所以 `collectPendingLists()` 对这两者外层 `try/catch` 实际抓不到损坏或不可读，上传批次/迁移/本机草稿可能消失并宣称 full。成员缓存已有 `getScopedCacheStatus(key)` 能区分 `corrupt/error` 与 absent/other-member，当前成员的待处理键应使用该状态门；草稿需有对应的只读可判定状态接口。不能让下一成员的键名影响本成员完整性判定。
- `listPublished()` 当前直接列出 `getMemberCache('mcpkg-published')` 的所有标志；该成员缓存命名空间只含 env/app/member，不含 family。**同一成员切家庭**后，页面订阅虽清空 `publishedList`，随后 `refresh()` 又把旧家庭的包元数据列回；`removePublishedRecord()` 也未核 family 就删标志并启动删文件。列表、删除、分享及其迟到回调都要逐项按当前可信 env/app/family/member 过滤/核验；旧家庭记录保留在其原作用域供切回后的恢复，当前家庭不可展示或删它。
- 后续白名单补丁给 `pregnancy.fields` 做了嵌套未知字段检查，但 `daily.fields` / `mood.fields` 仍只在顶层允许一个 `fields` 键，再以 `pick()` 静默抛弃未列出的嵌套键；若将来 handler 新增有意义字段，会再次生成虚假的 full。对所有有 `fields` 的域沿用嵌套 guard，并用真实 handler 元字段构造正向 full 与新增未知字段的诊断反例。
- `mc-health` 的 `daily.list` / `mood.list` 返回 `viewDaily` / `viewMood`，其中 `unsupportedSchema` 可以为 true（列表没有像 `mc-schedule` 与 `mc-reports` 那样拒绝旧/新未知存量版本）；导出服务却把它列为忽略元字段并仍投影、标 present。二次扫描也只按 revision/deleted/附件比较。见到该标志或非受支持的存储 schemaVersion 时，选中域必须 missing/diagnostic 或直接失败，不能生成 full。用合成新版本存量记录验证这一门。
- `container.js` 在读清单后用 `manifestEnd + 8 > size` 判短读，等于无条件要求至少一个文件段；如果所选域全都 read-failed，而其余域 omitted，合法的零段诊断包（只含 manifest）会被误判坏包，无法给用户导出故障清单。由 manifest `files.length` 决定是否应有下一个 8 字节段头，并验证零段时 EOF 精确落在 manifestEnd。测试全部所选域不可读取时的诊断包路径。
- `data-restore.vue` 的 `canPick` 用 `typeof uni !== 'undefined'` 判断 H5 文件输入，任何具有 uni 但缺少微信文件系统的非浏览器端也会展示选包按钮，`pickFile` 随后调用未定义的 `document.createElement`。以真实 `document`/File API 可用性判 H5，微信分支独立；能力缺失显示不可用文案而非抛错。
- `validatePackage(reader)` 只在读 `size()` 后检查小于 24 字节，没有在读 manifest/整包摘要前拒绝 **实际文件大小 >64MiB**；即使清单内推导总长报超界，尾部追加巨量字节仍会走 `readChunked(reader,0,size)` 全量哈希，H5 用户选巨型文件将长时间读盘。入口立刻按实际 size 限额 fail-stop，测试附加字节导致 64MiB+1 时应在一次 size 读取后拒绝（不读正文）。
- 附件从 `report.getReadUrls` 到 `uni.downloadFile` 的适配只要走 success 回调就当已下载，**未检查 `statusCode===200`**，也未核下载字节长度等于受控路由返回的 `sizeBytes`。临时 URL 过期/HTTP 404 可使错误页内容被哈希、装包、通过本包自校验并称 full。下载响应非成功状态、缺 `tempFilePath`、长度不符应归入附件失败诊断或阻断，不得把下载所得任意字节自动当云原件；独立用 403/404 成功回调与错误大小构造反例。附件 MIME/魔数边界按现有受控内容类型约束核验。
- 导出页 `doExport` 的 `finally` 为防旧 continuation 污染，只在 epoch 相同时重置 `building=false`；会话切换 watcher 却没有重置 `building`。在导出中换成员/家庭后，新身份页面会一直显示“导出中”并禁止再导出。会话切换立即撤销旧操作的页面所有权，复位按钮和状态；旧 finally 不能覆盖随后启动的新导出，最好用每次操作的本地 token 与 epoch 双门。测试中途切换后新身份可发起新导出。
- 崩溃恢复的测试须精准落在 C3 目标写出、C5 published 标志落盘**之前**，保留那时的持久待发布意图并模拟进程重启；“成功发布并清理意图后，测试手工删除已经成功的标志”并不等价于崩溃态，可能错误地要求系统在用户任意删标志后扫描所有沙箱文件。测试方应在 C3/C5 写序断点注入（如持久标志写入失败并使目标/意图保留）并冷启动重放；同时证明没有可信意图的孤儿文件不会自动被认领或分享。
- 当前 `newExportId()` 为 `Date.now()` 加 `Math.random().toString(36).slice(2,8)`，主设计阶段一用 `exp_<createdAt>_<seq>`，但任何生成法都须保证 **既有 published 目标/标志绝不因 batchId 碰撞被重命名或覆写**。C3 前检查目标、待发布意图和已发布标志的冲突并拒绝或重取唯一 ID；已发布文件不允许被新的批次覆盖。可注入固定时钟/随机数与已存在目标，验证原包与标志保持逐字节不变。
- `collectPendingLists()` 对 `b2b2-upload-batches` 直接 `Object.values(v)`，而真实的 `reportFamilyStore.persistBatches()` 写的是 `{batches:{[batchId]: batch}}`。当前代码只看见一个无 `batchId` 的包裹对象，**所有未完成报告上传批次都会被漏计、误生成 full**。应检查包装结构并枚举 `v.batches`，对 present 但形状无效的 JSON 标 `indeterminate`；用真实 `reportFamilyStore` 持久清单（含 `partial/uploading/reconciling`）做独立测试。对 `b3-migration` 等其它键的 present 但无效形状也要保守处理，不能把可解析 JSON 误当有效空值。
- 验包结构仍未闭合：`validateManifest` 没有拒绝同一域重复 `records[].id`、未知 `files[].kind`、`records` 对 omitted/missing 域的不当条目，且 `manifest.reports` 的 deleted/revision/附件声明没有与 `records.reports` 及正文逐项双向核对；`pending.indeterminate=true` 且清单数组空时仍可造 `complete=true`/`packageKind=full` 通过，`complete=true` 与 diagnostic 也未禁止。所有状态/映射都是恢复侧会用的承诺，不能仅验证段 SHA。用有效包分别篡改清单、重算规范字节后构造反例（重复 ID、墓碑附件或删除标志不一致、幽灵附件引用、来源不可判定却标 full）；服务端 declare 也须同一门。
- 导出服务 `reportRecords` 的投影无条件把源 `attachments` 复制进领域 JSON，即便 `rec.deleted`；后续只把 `manifest.reports[].attachments` 置空。`report.delete` 的事务只将 `deleted=true`，历史 `attachments` 仍留在服务端文档，因此当前墓碑包正文可能暴露已删除原件 fileId，与“墓碑报告原件不可读/不下载，附件映射空”不一致。墓碑正文也应清空附件列表，再对正文及清单进行对称校验。测试用已带原件后删除的真实报告，断言领域 JSON 与 manifest 报告映射均为空且无下载。

### 恢复实现的并发复核（尚未冻结）

- 当前新加的 `listPublished()` 只是从持久意图**同步拼出**一个 `recoveredPending` 条目；`sharePublishedPackage()` 首先在 `mcpkg-published` 存储中取标志，找不到立刻返回 `no-published`，后面的 `flag.recoveredPending` 晋升分支永不可达。不能把未经整包复验的意图条目直接展示为“已发布／完整包”或允许删除；选择可等待的异步恢复刷新路径，完成 C4 复验并持久标志之后才列为 published。实际 C5a 测试应连贯验证冷启动、列表、分享。
- `recoverInterruptedExport()` 对 `validatePackage()` 的抛错（例如文件在 `stat` 后消失、文件截断、IO 异常）没有捕获；从页面或分享触发恢复时必须把错误转为可见失败，并保留原始输入与可信意图供安全重试，避免无人接收的 Promise 拒绝击穿程序。`listPublished()` 不能 `void recoverInterruptedExport()` 且无 catch。
- 导出页虽然在身份切换时置 `building=false`，旧导出的 `finally` 仍无条件复位 `building` 并调用 `refresh()`；若新身份的导出已开始，旧 finally 会解除新任务的互斥门。用操作 token 和 epoch 绑定进度、结果、finally；测试先切身份启动第二份，再让第一份迟到完成，确认第二份继续被守护。
- 单值 `mcpkg-export-intent` 在新导出开始、任何副作用之前就被覆盖。若上一批位于 C3→C5 的可恢复窗口，新批的意图会抹掉其恢复凭据；加上 `Date.now()+Math.random()` 的批次 ID 未经目标文件／标志冲突检查，固定时钟随机数可覆盖已发布包。新建批次前先完成或明确保留旧意图，选出未占用且在当前持久作用域唯一的 ID，C3 不得重命名到已有目标。用冷启动并发、固定 ID 和文件逐字节对照验证。
- 测试 Q1/Q2 目前直接注入的 `mc_health_daily` 缺少 `type:'daily'`，`mc_moods` 缺少 `type:'mood'` 与 `ownerId`；真实 `mc-health` 列表分别按这些字段过滤，故夹具记录不可见，测试会把没有命中生产守卫误判为回归。测试侧需修种子，并在导出前断言 handler 的 `daily.list`／`mood.list` 确实返回这些文档，才判断导出完整性。
- C5 标志写失败分支才尝试把 `packageDigest` 补写到早先的单值意图，却不检查这次补写是否成功；若存储正持续写失败，重启后 `recoverInterruptedExport()` 发现意图缺摘要便**删除已复验的目标文件**，同时 UI 曾称“重启后将自动恢复”。在 C3 发布目标**之前**，先从已完成的 `.partial` 分块计算并持久化预期包摘要、清单摘要、完整性和作用域，确认意图 durable 后才允许 C3；目标发布后不依赖第二次可失败写入作为唯一恢复凭据。注入“初次意图写成功，C5 标志与事后意图更新均写失败”并冷启动，要求唯一目标文件保留且能经过可信摘要复验恢复；持续失败时仅诚实报告不可恢复，绝不能删除用户的有效副本。
- `recoverInterruptedExport()` 在首次读取身份后有多次异步 `stat/readChunk/validatePackage`，落标志时却使用**当时当前成员**的 `getMemberCache/setMemberCache`，清意图也按当前成员命名空间写。若验包期间从妈妈切爸爸，旧家庭的意图可被写入爸爸缓存、爸爸在途意图可被清除（且旧意图未正确恢复）。捕获发起 epoch 与可信作用域，每次 await 后复核，尤其落标志、清意图/目标之前；切换后只取消本次恢复，保留原作用域的可恢复材料。用 FSM 读钩子在复验期间切成员并逐字节比较双方持久缓存与旧目标文件。
- 恢复中的 `stat`/`readChunk` 错误不等于目标已永久消失：当前 `stat` catch 清意图、`validatePackage` catch 删目标并清意图，把临时 I/O 异常当成“损坏已证实”会丢失唯一恢复凭据/副本。只在能证明包字节与持久摘要不符或结构非法时才考虑按明确策略隔离不可信产物；`fs-error`、短时不可读或中途消失应保留意图及尚在盘的包，向用户报告可重试错误。任何 `await removeFile` 之后再次核对发起 epoch，避免迟到 `clearExportIntent` 清除后来成员的新意图。
- 当前 `validateManifest` 只检查 `reports[].deleted/revision` 与 `records.reports` 一致，附件映射仅验证 `files[fileIndex].referencedBy.includes(reportId)`；没有把每份 `records/reports.json` 正文的 `attachments[{fileId,order}]` 与 `manifest.reports[].attachments[{originalFileId,order,fileIndex}]` **逐项双向比对**。一个完整、规范、SHA 全匹配的包只需在清单删掉某个报告的附件映射（或把 `fileIndex` 指向另一份图片，并配套 `referencedBy`），正文仍有原 fileId，验包即可误判 full，阶段二会漏恢复或错挂原件。反向 `referencedBy` 也只检查报告是否存在而非该附件是否实际被其映射。独立测试从已发布有效包仅改 manifest 映射并重算规范字节，分别覆盖漏附件、调换两张图片、额外既有报告反向引用，要求专属 mapping 错误；校验器与恢复服务端 declare 共用同一闭合规则。
- 用户点击“删除本机备份包”时，`removePublishedRecord()` 同步先删持久发布标志，再调用**吞掉 unlink 错误**的 `removeFile()` 且不等待，立即返回 `{ok:true}`；如果沙箱文件删除失败，页面已经不显示该包却提示“已删除”，唯一可见备份入口丢失，医学资料文件仍留在手机上。应提供可判定的文件删除结果与状态：删除失败时保留标志和文件供重试，删除成功后才移除标志；若标志落盘失败，如实标记部分完成并提供恢复/清理入口，不能声称全部删除。用 `unlink` 失败和持久标志写失败分别验证不会产生“已删除”假成功，页面按钮等待异步结果。
- 新补的 `verifiedUnlink()` 对**任意 stat 失败**都返回“已删除”，包括暂时读取失败；在缺少 wx/FSM 时它把未实际 unlink 的路径也视为已删。必须区分确证的不存在与不可判定读盘错误，能力缺失直接拒绝。`removePublishedRecord()` 首次检查身份后 `await verifiedUnlink()`，却未在其后复核 epoch/作用域，随后 `setMemberCache(PUBLISHED_KEY, store)` 会把发起成员的旧 store 写进**切换后的成员**命名空间。删除文件后若身份变化，不能写新成员标志；保留发起作用域恢复/清理凭据并如实报告部分完成。用 FSM unlink/read 的确定性身份切换与短时 stat 故障测试，不仅验证单成员正常路径。
- **删除顺序的 P0 反例（阶段一仍未冻结）**：后续版本为迎合测试 DF2 改成先持久移除 `mcpkg-published` 标志、再 `await verifiedUnlink()`，失败时仅“尽力”恢复标志。如果 unlink 失败同时恢复标志的存储写也失败，文件确实留在沙箱而唯一可见入口消失；即使存储正常，标志移除成功至 unlink 开始之前崩溃也会留下同样孤儿。`79/79` 只覆盖单故障，不证明该路径安全。优先采用文件先删、确认后清标志：标志清除失败应如实返回 `partial`、保留可见入口；再次点击时先确认文件明确不存在，然后清理陈旧标志。若坚持标志先行，必须先有持久删除意图和冷启动恢复，并用双故障及崩溃窗口证明无孤儿。两种存储接口之间不要求无法实现的原子性，但不能丢失可发现性或报虚假成功。

## 阶段一最终验收（2026-09-20）

编码方采用先确认文件删除、后清发布标志的顺序；文件已明确不存在时重试可清除陈旧标志。文件读盘状态不确定、FSM 不可用、存储损坏或会话切换时均保留可发现凭据并如实返回失败或部分完成。测试方先复现标志先行的双故障孤儿，再以 DG1/DG2/DG5 及 DF1–DF4 覆盖冷启动、重试、瞬时 I/O、异常存储形状和跨成员切换；Codex 核对生产路径与测试前置条件后接受该修复。早期关于 SHA、清单闭合、报告附件映射、恢复意图、分页漂移及页面身份残留的在途发现也已由专项回归锚定。

独立冻结在生产源码不再改动的快照上执行：十套 `tests/phase*.regress.cjs` 全部 exit 0，合计 **368/368**（B3b 阶段一 82/82）；原样 review-runner **80/80** 且 source stable；`build:h5` 与 `build:mp-weixin` 均 exit 0；`git diff --check` 无输出。13 个生产/测试变更文件的前后 SHA-256 完全一致，清单在 `/tmp/zcode-b3a-test-logs/freeze2-{files,before,after}.txt`，原始日志为同目录 `freeze2-*.log`。这些是本地合成数据和构建证据，**不代表云端部署、微信真机、OCR/DeepSeek 或隔离恢复已经验收**。

## 阶段二隔离恢复开码前的接口闭环

- `restore.uploadRecord` 的整个请求被限定在 64KiB，但已验收的完整包只约束单个 `domain-json` 文件 ≤4MiB，没有逐记录 64KiB 上限。现有健康服务的 `stringList` 限数量却未限单项字节，历史或现有合法记录可生成“完整包”，却无法通过这个恢复动作。恢复侧须定义有界的逐记录分片上传、服务端重组并从实际规范字节重算预声明摘要，或在不丢失原始包的前提下明确兼容的完整性/可恢复性协议；不能上传一部分后才让用户发现“完整包不可恢复”。独立测试构造一条规范字节超过 64KiB、但域段与包均在既有上限内的真实可导出记录，验证预览、上传、重试、最终隔离复验。
- `indexDeclarePage` 的滚动聚合与 `commit` 的页游标都要用事务/版本门串行化：同页并发重放只能推进一次，迟到页面不能覆盖较新游标；上传完成计数相等不足以在并发上传与冻结竞态中证明全齐。冻结事务同时核对当前状态、声明集合承诺、每个已上传键的不可变内容及计数，`verifying` 后写入动作必须在同一事务条件下拒绝。测试故意让两次末页索引、附件登记及 commit 预检交错，不得跳页、误入 `restored` 或卡在不可补传状态。
- `restore.attachFile` 须确认正式文件的上传成员、family、`registered` 状态及实际字节与冻结声明一致；引用增加和清理认领在同一事务序列化，拒绝 `cleaning/deleted`。`restore.abandon` 从 `verifying` 中途与 `attachFile/commit` 并发时也须按状态/owner 门有界摘除引用，失败可续办，不能孤立正式附件或在已恢复批次撤销引用。`preview/readUrl/verify` 的 owner 门必须走真实函数入口，不能只测辅助函数。
- 首份分片草案的 `finalizeRecord` 在一次请求重组最多 100×40KiB 记录并写一个完整数据库文档，未证明单文档容量与 256KiB 单页读取预算兼容；“最后冻结事务逐键检查全部已上传键”又把 10000 条记录和 500 个文件放回单次无界事务。分片完成须保留持久、可续的字节承诺及有界验证路径，超单文档记录不能假定可直接写入；预检逐页建立版本化聚合证明，任何新增/替换上传都使旧证明失效，最后事务只核当前 generation、证明、计数和状态。并发末页与迟到请求须有不变量测试，再批准阶段二编码。
- 第二份草案改用“记录元数据引用 chunk”，却在 finalize 成功后分页删除被引用的 chunk，导致隔离记录只剩指针、正文永久丢失；preview/verify 不能用“截断”掩盖唯一内容缺失。chunk 必须保留为 owner-only 的不可变恢复正文，或先有另一份有界、持久且经过摘要证明的完整正文再删除旧 chunk。`proofGeneration` 也不能每预检一页递增后仅凭最终值相等冻结：版本值不证明每一声明键被检查。将仅由上传变化递增的 `contentGeneration` 与预检游标/逐页聚合证明分离，最后一页确认完整覆盖才持久 `provenGeneration`；冻结事务只在 `provenGeneration===contentGeneration` 且证明完整时推进。并发预检、上传交错、丢响应后的重放都须有可判定终态。
- **设计裁定（待写回主协议并经独立测试复核）**：允许 `finalizeRecord` 在事务外一次有界读取/重组最多 4MiB、最多 100 片的**不可变**记录，重算整条规范字节 SHA 并解析/校验，再以小事务只写元数据、冻结有序片引用与逐片摘要；该动作明示为 256KiB commit/verify 页预算的例外，并以极值压力测试检验，不把 4MiB 正文塞进一个数据库文档或事务。恢复完成后保留 chunk 作为唯一字节源；只读 verify 按 `{domain,index,chunkIndex}` 分页逐片复验冻结的片摘要，完整记录摘要由 finalize 时的整条哈希证明，不能声称每一页都重算整条。预检每批次最多一个活跃 `preflightId`，以启动时 `contentGeneration`、事务 CAS 游标和逐页覆盖摘要续传；所有声明键实际覆盖才置 `proofComplete` 与 `provenGeneration`。最后事务同时检查 status、`proofComplete` 与版本相等；空数据批次允许 generation=0。记录/附件实体及唯一计数必须同事务写入，避免计数虚高后过早冻结。上述条款仍须核对 SDK/本地极值和真实入口失败路径，不能凭设计文字视为验收。
- 平台约束复核：CloudBase 当前[事务文档](https://docs.cloudbase.net/database/transaction)明示服务端单事务最多 **100 个操作、30 秒**，仅支持针对单文档的操作；因此 100 片全部读取加记录落库、或 10000 条声明逐键核对，都不能放入一次事务。CloudBase [FAQ 的 16MB 单文档上限](https://docs.cloudbase.net/lowcode/faq)不等于适合把 4MiB 临床记录整条写入单文档；本方案选择分片持久化和小元数据文档。具体 SDK 版本与真云行为仍留最终部署验收。
- 独立测试端用合成症状 `symptoms:['x'.repeat(70000)]` 经真实 `mc-health` handler 接受，再由阶段一真实导出链产出 `ok=true/complete=true/packageKind=full`；单条规范记录 **70,127B**，原 `uploadRecord` 请求序列化 **70,259B**，超过应用设定的 65,536B 上限，域 JSON 70,129B、整包 73,055B 都在既有界内。探针在 `/tmp/zcode-b3a-test-scratch/probe-bignrecord.cjs`，使用无尺寸门的本地 `callFunction` mock，证明当前**本地合同不闭合**，不代替真实 CloudBase 链路测试。较小的 60,127B 记录只超过新设计的 48KiB 快路径门、尚未超过 64KiB 整请求界，不能混作后者证据。

### 阶段二设计定稿复核

前述分片草案和“最多 100 片”裁定已由主设计 §5、交接文档的权威协议替代：4MiB / 40KiB 向上取整为 **103 片**，允许最后一片不足 40KiB，同时服务端强制累计原始字节不超过 4,194,304。`finalizeRecord` 在事务外读整条并校验，事务只写记录元数据和冻结逐片摘要；被引用的片保留为隔离正文。`commit` 分页建立带 `contentGeneration` 的完整覆盖证明，再用小事务冻结；只读 `verify` 仅返回差错，由有状态的 `commit` 验证段持久化批次失败。每条记录的分片锚点独立成文档，`abandoning` 清净所有服务端文档（含锚点）和文件引用后才释放活跃批次名额。

微信选取的聊天文件是临时路径；任何恢复副作用前要将包复制到本机持久目录，复验摘要并保存成员作用域意图。失败时不得发起云写入。冷启动副本缺失或损坏时停止并要求重新选择相同摘要的包。放弃云端批次仅清传输意图，**保留可能是唯一可恢复来源的本机 `.mcpkg` 副本**。零声明完整包允许从 `declared` 经 `commit` 进入 `uploading`；预检 ID 随请求/响应和持久意图续传，迟到请求不能覆盖新游标。CloudBase 事务最多 100 次操作的预算同时计入读和写；每次清理调用的 500 次是上界，并不保证清理 500 个文档。

独立测试端对设计终稿复核后未发现剩余 P0 矛盾；Codex 同意**后端开码**。这只是阶段二开码协议门，不是功能验收。编码方仅实现生产路径，独立测试方先提供真实 handler 的红先行场景；后端与页面分段审查，通过后才分别提交。真实 CloudBase 行为、微信真机、两成员演练和部署仍按交付状态文档留到全部本地任务完成。
