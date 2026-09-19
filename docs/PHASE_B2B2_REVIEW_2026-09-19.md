# B2b2 独立 review：报告与附件

基线：B2b1 `9a473a50e5e2ab9d672d7c3da4ae05a4115c158a`。**2026-09-19 Codex 本地验收通过**，允许提交并推送 origin/main。ZCode实现，Codex独立复核；未部署、未操作真实健康数据、未调用OCR/DeepSeek，AI保持未启用。下方早期失败与整改记录为历史证据，不代表当前仍失败。

## 最终验收证据

- 永久回归：B2b2 **33**、B2b1 **53**、B2a **42**、B1 **42**、A **72**，共 **242组实际通过**。B1历史编辑器SKIP保留，不计入通过数；对应正式页面由B2a/B2b套件覆盖。
- 本阶段独立runner **58/58入口**通过，包含23项服务端、5项共享outbox、真实页面/模板/点击/草稿/恢复/身份切换等检查。并复跑B2b1的12个、B2a的18个独立入口，均成功。
- H5与微信小程序生产构建成功；git diff --check干净。既有Sass legacy API、循环chunk与h2选择器提示不阻断本次构建，继续列入D发布准备。
- 3张合成有效PNG经实际管线上传/登记/报告创建，逐附件顺序、原始字节deepEqual、大小、SHA256一致；sips真实解码再编码成功。仅为合成样本，不替代最终两台手机的原件与文件操作验收。
- 最终冻结19份非文档源码/声明/测试：初始检查、异常后的续检、结束时哈希完全一致。

完整验收日志：`/tmp/momcare-b2b2-final-gate-*.log`；原件证据`/tmp/momcare-b2b2-verified-original-{0,1,2}.png`及`/tmp/momcare-b2b2-decoded-originals/`。临时独立探针为本次补充证据，仓库永久回归可以独立运行，不依赖这些临时文件。

### 验证过程中的运行环境异常

首次B2b1进程退出-11，未完成，**不计为通过**。macOS崩溃报告显示Node v24.12.0在V8 `ClearStaleLeftTrimmedPointerVisitor` / MarkCompact GC处SIGSEGV。源码未修改，单独重跑完整53/53成功，日志`/tmp/momcare-b2b2-b2b1-recheck.log`；随后继续其他11项验收全部成功。首次失败日志保留，不以管道tail退出码掩盖异常。此为一次观察到的运行时崩溃，原因未进一步确定，不宣称业务修复消除了它。

## 接受范围与边界

报告原件上传、稳定ID与多页顺序、家庭权威数据、离线待办、冲突比较/采用云端/确认重提、编辑草稿与基线、删除及受控下载、失败恢复和会话隔离在本地合成链路通过。创建对账不偷偷编辑已有报告；变化草稿经明确动作转入既有报告编辑。未处理恢复项阻止新建批次，重选两条失败路径均保持完整报告，写盘失败保留可重试句柄。

真实CloudBase部署、索引/规则实际生效、上传开启、真机两成员联调和平台文件容量均延后；B3旧数据确认/导出/隔离恢复、C能力接入、D发布准备仍须各自验收，不能视为已完成。

### 冻结SHA256

```
5c57e97e85093879bd2ab2f86a5f1afc782c43c10fda21c3ff0fae0db4794d10  cloud/DEPLOY.md
af558b1a0565f5f80a54fca008d01831b69a799e143018881257a69d4ad7e2d0  cloud/collections.json
bfe16eaf710b1b8b46922a9880e19ab99249e434dc0e1365e0cc9bbbef891cee  cloud/functions/mc-files/index.js
5db821521886d85c82cf2b95630cfe5d692125e27d77ab6481d445fd523951d9  cloud/functions/mc-reports/index.js
47f007abd75b3c87ca3de64feb093c87c254b7285c3e8a88d01adb0538a39131  pages/archives/ai-result.vue
37161c53dbf88c2cf06aee11b1eec203de71e5471913e8885f1dc062c7b4f8db  pages/archives/batch.vue
061b1b59c2b95512c950ca41bbfd4e2f5a8211535280028e54936e475a1f94e3  pages/archives/classify.vue
96fed7d2d3332c0b7047adcb0c6d09f4a5b8fa1f8d5101f3cb8907ac1c111855  pages/archives/components/UploadSheet.vue
0a1583d60b8fdaf11cad32fba7fdcb807a3a175258058f84594bdcfb2670f0ce  pages/archives/detail.vue
34e8c46c08dd9fcb76a9009b8a66b92031010dffe37b0cb3ad4040bcafdb10e5  pages/archives/index.vue
feebc47a274f4ed84292d6c8a64d4f90580283d802a5ef77c4b17ad8b9da3c27  pages/archives/unarchived.vue
37cee1ff67f7eb5c8a480aae0cb11151fec7156e6eaa0f6db5d59af8208b22ce  pages/family/index.vue
57eda6af2d0ad4387bdf7658587cfd16aaaa8d58733a6a9953f35d984f3190ac  pages/index/index.vue
717e9a4d39918e442aa72b66cdbed062cf5629148fe7dce47af3cf8b2f92600b  services/familyStore.js
1cbd8174fa157db514a804f7fa6340073338201f3e65ea4c0e03b90643a89599  services/fileUploadService.js
a466769797a1198df71d5e30df9e92e2cef462b50552fbe8ddb6d64d6c35e1a7  services/reportFamilyStore.js
f7869d1b8c2dbf004c3b2a59c827d6b1d5d6e6c602cb741f64658202175314e3  services/sessionService.js
1fb0ca2052722d3cab9bc62f504062be4c5055a0735fc17794606947fe0990cc  tests/phase-a.regress.cjs
ad582658484ac6e4898b83d33906732a7f2058b5bf7a26008393f8489bdf75cb  tests/phase-b2b2.regress.cjs
```

## 历史整改过程（以本页最终结论为准）

## 起始代码核对与重点边界

以下是本阶段设计/复核入口，不是对尚未提交的 B2b2 实现的失败结论。

- 实际组件是 `pages/archives/components/UploadSheet.vue`，旧 handleUploadResult 明确停用后立即返回；后面的压缩与旧 HTTP 上传是遗留不可达代码。正式重接应覆盖拍照/相册/取消/权限/部分失败，保留原件，不恢复旧 quality20 压缩路径或编造“自动矫正”。
- B1 `pages/family/index.vue` 已有受控 prepareUpload→直传→registerStaged→getReadUrl 与本地持久文件。抽取公共服务要保持其身份拒绝、迟到响应、落盘失败和原请求重试契约。报告批次需要完整清单/附件顺序；只保存临时路径或只逐个成功后追加清单无法恢复中断窗口。
- `mc-files` 现有 getReadUrl 只检查家庭与 registered，没有报告上下文；新报告删除后不能经裸 fileId 路由绕过墓碑。设计要明确未附着的 B1 文件预览与已附着报告的授权边界，覆盖所有实际读取入口。
- registerStaged 当前将非registered已有状态当作claiming继续。扩展deleting/deleted等生命周期后，认领重放/转存后登记/cleanup必须显式识别终态与并发保护，不能晚到登记把已删附件复活。
- 报告引用变更与文件状态/引用计数必须有共同事务保护：最后引用移除后标记待清理；新引用不能与清理并发穿透；共享文件仍有其他报告引用时保留。云 deleteFile 的逐文件结果与失败恢复也须真实处理。
- 初始B1页面在staged-file-unreadable分支清除待上传元数据。B2b2正式批次必须保留可恢复本地原件，明确重试/重选状态，不能把“暂存不可读”当成可以丢弃所有本机恢复线索。
- 沿用已验收的整批epoch约束：选图/本地副本/上传/登记/报告创建/批量归档/清理，每次await后及下一项入队前核对开始会话；在新成员下停止旧循环。

正式验收范围与必交用例见 `ZCODE_PHASE_B2B2_SPEC_2026-09-19.md`。待ZCode给出设计选择后，再按实际服务契约制作独立复现；不得以文件存在或测试名称替代真实页面到服务端链路。

## 设计首轮反馈（实施中，尚未验收）

已读 ZCODE_PHASE_B2B2_DESIGN。以下与原 SPEC 不一致，应先修订设计并落到生产链路：

1. **P1：裸文件读取绕过报告删除。** 第2节写“mc-files.getReadUrl 保持 B1 语义不变”不满足墓碑约束。必须明确从未绑定报告的独立 B1 文件可预览；一旦绑定报告，裸 fileId 不再绕过报告上下文。已有临时 URL 无法撤销的真实边界需说明，但所有新签发必须拒绝被删报告。保留 B1 有效场景，不以原测试全绿保留绕过。
2. **P1：清理后登记复活。** 第4节清理后“移除登记记录”会使同 uploadId 重放被当新登记；仅拒绝 cleaning 不够。保留不可复活终态/代次，覆盖首次认领、下载/转存后最终登记、响应丢失重放与清理竞态。
3. **P1：引用/清理状态需同事务。** 报告删除“单文档事务”加引用扫描不符合先原子墓碑与引用变更要求。建议文件记录维护受事务保护的引用集合/计数及 everAttached 标记，报告创建/编辑/删除和文件引用状态共同提交；清理只在同事务验证无引用并转 cleaning。不能靠事务外扫描、写 updatedAt、再扫描证明安全；扫描分页及二次扫描发现引用后如何恢复状态也不能遗漏。删除调用应检查每个对象的结果码，部分失败留下可重试状态。
4. **P1：暂存不可读不等于原件丢失。** 保留本机 savedFilePath 与整批顺序；优先可恢复原件的重新暂存流程，并明确 stable uploadId/stageFileID 绑定语义。确实需要重选时由用户明确操作产生新 uploadId，不能清掉原恢复句柄或静默换原件。

这是设计 review，不以尚未完成的代码判断整个 B2b2 失败。请更新设计后继续本阶段，并在回归中覆盖以上竞争与旁路。

## 服务端初始独立探针（尚在实施，非冻结结果）

`node /tmp/momcare-b2b2-server-audit.cjs` 直接运行真实 mc-reports / mc-files handler，SDK 替身保留真实事务版本冲突与默认分页边界。首轮 13 项中 5 项失败（代码仍在变动，修复后需重跑）：

- 创建未给 dateKey 仍成功并落空日期；附件空数组也能创建“完整报告”。新建必须验证完整必填条件，部分编辑仍应保留其他字段。
- 同 operationId 在配置 familyId 改变后，直接返回旧家庭 resultSnapshot，泄露旧家庭备注。幂等记录/摘要必须绑定 family 和 action/kind；replay 分支也需校验旧快照与当前记录家庭，不能仅靠正常写入分支隔离。
- report.delete 后裸 mc-files.getReadUrl 仍成功（已列入设计首轮）。
- cleanup 用 `cloud.deleteFile({fileID})` 与实际 SDK 不符。已本地核对锁定 wx-server-sdk@4.0.2：`index.d.ts:218-231` 参数 `{fileList: string[]}`，结果含每个对象的 status/errMsg；`index.js:625-656` 按 `options.fileList` 调用，逐条失败不等同整个 Promise 抛错。证据包 `/tmp/momcare-sdk-review.uQn7pX/package/`。应依真实参数/结果形状验证部分失败及重试。

探针不是永久测试替代；ZCode 需补充可独立运行的回归。清理终态用例会同时断言实际清理成功，避免“删除 API 本身失败所以未复活”的假通过。

### 增量并发探针

同一 `/tmp/momcare-b2b2-server-audit.cjs` 现覆盖17项。现已通过裸文件墓碑门、引用替换原子记账、新引用与清理事务竞争。另复现两项：

- **P1 迟到签发**：挂起 `getTempFileURL`，另一请求完成 report.delete，再放行签发；getReadUrls 仍返回 URL。至少在返回前重核当前报告 revision/非删除、附件集合及文件状态；变化则丢弃结果并要求重试。已交付 URL 的平台有效期是另一已明示限制，不能用它解释尚未返回请求继续交付已删报告原件。
- **P1 活跃登记被清理**：种入旧 claiming 记录，再发同 uploadId 的有效重试并挂起 downloadFile；同时 cleanupOrphans 把该记录变为 cleaning。登记复用分支必须在转存前事务续租/更新活跃状态，清理同事务校验有效租期；登记最终写与清理状态互斥。仅用首次 createdAt 推断“没有活跃任务”不成立。还应防处理超过租期时晚到复制留下不可追踪孤儿，保存可清理的正式对象目标或明确回收补偿。

### 首轮修订后的增量结果（19项：17通过，2失败）

前述必填、家庭重放、裸文件门、SDK删除、迟到URL、活跃重试均已通过当前独立探针，尚非冻结结论。新增两项实测失败：

- **P1 最后引用未移除**：创建一个报告再删除，mc_files.attachedReportIds 仍含该报告，lastDetachedAt 未写。commitReportTx 的 newIds 直接读取墓碑保留的 attachments；应按“有效引用”计算（deleted 后新引用集合为空），审计保留附件不等于有效引用。重复删除不得重置无引用宽限时间。
- **P2 清理分页永久饥饿**：前1000个文件为保留墓碑，第1001个为可清理原件；cleanupOrphans 固定 limit(1000) 且无 nextCursor，永远看不到后面的对象。需稳定分页/可续游标或受控完整遍历，不能仅增加 limit。

同时源码核对：mc-files 在 cloud.uploadFile **之后**才写 formalTargetPath，清理抢先时直接返回，仍会留下未登记正式对象；cleanup 又把 cloudPath 字符串当 fileID 使用。应持久化实际正式 fileID 或可由可信环境构造的真实句柄，并完整处理复制成功但登记失败/清理已完成的补偿路径。注释“可回收”不等于存在可执行回收路径；终态直接 skipped-deleted 也不会自动补偿新复制对象。回归需要断言 SDK 模拟对象库确实不存在孤儿，而非仅检查 status 没复活。

### 公共上传服务真实会话复现

`node /tmp/momcare-b2b2-upload-session-audit.cjs`：单 bundle 真实 fileUploadService/sessionService/cloudAdapter；仅平台网络与二进制上传替身。妈妈调用 uploadSingleFile，挂起 wx.cloud.uploadFile；切到爸爸并完成真实 confirmIdentity；再返回妈妈的上传结果。实测 **以爸爸当前会话发出了 registerStaged**，且成功响应不做旧 epoch 检查。

**P1** uploadSingleFile 只在 prepared/reg 非 ok 时 classify，二进制 await 后没有门。必须所有 await 之后、下一次副作用之前核对开始 epoch，成功/失败都不越界。B1 页面与正式报告批次共用该服务，调用者事后丢弃 UI 不足以阻止错误身份请求。选择与持久文件阶段也须传递整次用户操作的开始 epoch，不能每进入一层重新认可当前成员。

### 批次 store 初始独立实测（4项均失败）

`node /tmp/momcare-b2b2-batch-audit.cjs <case>` 单 bundle 真实 reportFamilyStore/familyStore/session/config/adapter，网络路由真实服务端 handler；仅本机文件与云 SDK 为合成替身。

1. **P1 cold**：未确认时创建 store，成员缓存已有未完成清单；随后确认身份，watch 的 lastMember=null 路径不调用 loadPersisted，旧批次仍不可见。需要冷启动、退出后重确认、切成员含 confirming 中间态全部恢复本人清单并清除旧成员 uploadPolicy/processing/可见状态。
2. **P1 partial-save**：选 a/b 两图，b 持久化失败，代码跳过 b 并把 a 建为一个完整批次（order 重排），可后续形成缺页报告。完整清单必须保留原始槽位/失败状态并阻止“完整”，或整批明确失败保留已落盘原件；不能静默把多页报告裁短。
3. **P1 save-switch**：挂起 persistLocalCopy(a)，确认切爸爸后再放行，persistBatches() 未带开始 epoch，妈妈的原件路径已写入爸爸缓存，事后 epoch 检查太晚。policy await 前捕获原会话；每次保存前后校验；失效后不写新成员、不中途重认 epoch。
4. **P1 manifest-save**：所有 saveFile 成功但清单 KV 落盘失败，代码 removeLocalCopy 删除唯一已保存原件。小程序 saveFile 会移动临时文件，不能假定 tempPath 仍可重试；保留恢复句柄及原件、明确未入队、禁止网络。重试/重暂存/放弃同样必须先持久确认新状态再推进副作用，不能忽略 persistBatches(false)。

上传服务另见 `/tmp/momcare-b2b2-upload-session-audit.cjs`。报告共享 outbox 的5项链路已通过 `/tmp/momcare-b2b2-client-audit.cjs`，不代表批次或页面验收通过。

### 再次复跑（21项：19通过，2失败）

最后引用释放与清理分页已通过。仍有晚到复制孤儿、并发同 uploadId 非幂等：

- 代码虽标“②.a 复制前”，实际仍在 `cloud.uploadFile` 之后；若清理在复制期间已完成，②.a 的 cleaning/deleted 分支先返回，根本走不到②.b的补偿。需要按真实执行顺序修复，不能只改注释。
- 新增 late duplicate registration 用例：第一次上传挂起；同 uploadId 第二请求完成登记；放行第一次。第一次不能把已 registered 当异常，更不能对已被第二请求登记的相同确定路径执行补偿删除；应返回受身份/内容绑定校验的已登记结果。当前返回错误，尚未实现并发幂等。

### 上传组件实际处理器初查（页面尚在接线）

`node /tmp/momcare-b2b2-upload-page-audit.cjs <case>` 提取完整 UploadSheet script setup，真实 Pinia/services 同bundle，仅宏、组件样式和平台接口替身。三项当前失败：

- `originals`：onGallery 的 chooseImage 仍 sizeType:['compressed']（拍照入口同样），不是原件。
- `one-event`：handleUploadResult 单次完成发出两次 select，父页会收到重复导航；应只交付一次且先建立可恢复的批次状态。
- `selection-switch`：挂起妈妈的 chooseImage，切爸爸确认，再返回所选图片；旧选择开始以爸爸身份 prepareUpload。操作 epoch 需从打开相机/相册前捕获，授权、选择、持久副本、批次/导航贯穿同一次操作。

以上是已执行的真实处理器边界，不用“模板有入口/构建通过”代替；其他档案页仍在改动，完整页面验收等接线完成后进行。

### 服务端剩余两项失败（23项：21通过；补偿失败和裸预览竞态）

此前孤儿正常补偿、并发登记幂等现已通过。新增最终边界仍失败：

- `in-flight standalone preview`：B1裸预览挂起签发 → 文件附着报告 → 报告删除 → 放行裸预览，仍交付URL。mc-files.getReadUrl 返回前也需重新检查 everAttached/status/family/formalFileID，不能仅修 report.getReadUrls。
- `failed compensation`：清理已认领并完成后晚到正式复制，补偿 deleteFile 返回逐对象失败；compensateFormalCopy 返回 false 被忽略，实际 formalFileID 未进入可重试清理记录，之后 cleanup 跳过 deleted，原件成为永久孤儿。失败补偿必须留真实句柄与可重试状态（含终态补偿队列），不能吞掉失败，只在注释里承诺可回收。

客户端4个批次基础探针与上传会话探针已重跑通过。进一步实际恢复链路仍待验证：manifest失败只把 keptLocalPaths 放返回值、页面却只toast并丢掉返回对象，用户无法重试这些 saveFile 已移动的原件；需可见可操作的恢复入口/本人隔离的暂存状态。页面接线验收时覆盖，不把“文件尚在磁盘”当“用户可恢复”。

### 页面集成的明确验收路径

当前 index.onUploadSelect 仍按 fileCount>1 导向旧 batch，且不传 batchId；classify 只从 options.batchId 读新ID，pendingUpload.fileUrls 刻意为空导致旧入口也读不到。batch 新分支又按“每图一报告”临时生成 rptId，无法兑现“一份多图报告原件顺序一致”。本阶段默认一次选图构成一份多页报告，实际导航携带持久 batchId 进入可恢复分类/预览；批量归档针对多份稳定报告ID，不能静默把一份多页报告拆开。若保留每图分别成报告的功能须用户明确选择并先持久映射，每次点击随机ID不可接受。

档案首页还需要实际模板/筛选/计数消费 family 数据；只声明 famReports 而模板仍读 reportStore 无效。页面未完成前不据此整体拒绝，但冻结验收会从真实非空页面路径核对，而非仅调用 service API。

### 首轮页面接线完成后的独立结果

- `/tmp/momcare-b2b2-unbound-audit.cjs` AST作用域检查：batch.vue 的 `upload`、`idx` 未绑定，detail.vue 的 `showEditModal` 未绑定，共4处引用；需修生产处理器，不能靠构建掩盖。
- `/tmp/momcare-b2b2-index-render-audit.cjs` 编译实际首页SFC和模板并SSR；为执行页面实际加载逻辑，仅将 onMounted 生命周期映射到 SSR onServerPrefetch；组件外壳/平台入口替身，真实 Pinia/session/familyStore。报告查询确实返回一份有效 archived 报告，页面仍渲染“还没有产检报告”。输出 `/tmp/momcare-b2b2-index-render.html`。确认新 famReports 没接实际模板，不是服务器无数据。
- UploadSheet 三个真实处理器用例（originals/one-event/selection-switch）仍全部失败。

因此首轮“所有页面已接线”尚不成立；必须完成实际显示、导航、编辑/归档、恢复链路后再冻结。

### 永久回归证据要求（当前初版不足以冻结）

当前 tests/phase-b2b2.regress.cjs 的客户端组主要直调 store，尚未执行 UploadSheet/首页/分类/详情/批量的真实页面处理器。原件固定为12字节 JPEG魔数占位，上传替身忽略 filePath 全写同一字节，无法证明多图顺序/大小/摘要/可打开；旧键末尾只是读取 before 后 void，没有种入 canary 或断言读写/原始字节未变。请按 SPEC 补齐有效合成 PNG/JPEG、多份不同内容的实际文件副本与页面链路、重启/丢响应/缺文件/失败重试、关键并发与隔离用例，并提供范围对应表。不要用测试名称或注释代替所声称的覆盖。

部署元数据仍需纳入本阶段：mc_reports 集合、familyId+sortKey 索引、mc_files 引用/终态/补偿字段与清理分页索引；只修改函数而不列新集合与索引不具备最后可部署条件。依旧只编写配置，不部署。

### 详情真实编辑与清屏复现（3项失败）

`node /tmp/momcare-b2b2-detail-page-audit.cjs <case>` 执行完整 detail.vue script setup（仅页面生命周期注册/组件实例外壳替身，真实 session/familyStore）：

- `edit-baseline`：打开 revision1 的编辑表单，模拟同步刷新至 revision2，再保存，真实请求 expectedRevision=2。这样可直接覆盖对方变化，必须捕获 startEdit 时 baseline revision/id/session，不能保存时临取最新版本。
- `logout`：加载报告后 endSession，report 仍保留正文与原件URL，未清屏。报告列表、详情、分类、批量、未归档和AI页都要响应会话状态与 epoch，不只 familyStore 清数据。
- `late-load`：loadReport 已捕获旧记录并挂起 getReadUrls，显式退出后放行；即使 familyCall 已返回 stale，loadReport 仍把旧 rec 映射回页面。所有页面 await 的成功与失败分支都必须带开始 epoch/id，失效直接返回，不映射旧 rec、不回落旧本地档案。

- `note-preserved`（同详情探针第4项）：famReportToLegacy 映射为 note，而 startEdit 读取 notes，已有备注在编辑表单中变空；即使只改日期，saveEdit 也会提交 null 抹掉备注。需统一页面字段映射，实际“打开编辑→只改日期→保存→重读”保留其他字段。

### 首页模板探针适配说明

首页接入映射后，SSR工具还需把微信原生 scroll-view/slider 等注册为原生标签，避免被普通Vue SSR当成未知组件吞掉子内容。Codex 已修正 `/tmp/momcare-b2b2-index-render-audit.cjs` 的编译适配（templateOptions.ast=undefined 使 isCustomElement 参与重新解析），未改断言/业务代码。当前实际首页非空报告渲染已通过。初始“还没有产检报告”失败有效；之后仅因原生标签适配造成的“找不到日期”不作为产品缺陷。

- 首页 `/tmp/momcare-b2b2-index-page-audit.cjs logout` 实测失败：familyStore 已清空，但新映射写入 reportStore.reports 的副本没有清除，模板退出后仍显示旧报告。新增临时URL、报告副本、筛选/草稿也必须纳入会话清理；不能把权威源搬到旧store后丢掉原有隔离保证。`navigation` 用例检查多页上传实际跳转 classify 并携带稳定 batchId。

- 首页 `/tmp/momcare-b2b2-index-render-audit.cjs unarchived` 仍失败：仅有未归档报告时，外层空态只检查 reports.length（已归档），把实际未归档数据与分类入口一起遮住。空态应考虑已归档+未归档；默认不能让用户看不到自己已上传的报告。

### 新增恢复卡需修的两处回归

`/tmp/momcare-b2b2-batch-audit.cjs` 新增：

- `recovery-switch` 失败：lastRecovery 未绑定成员/环境/家庭，也未随切换隔离；妈妈清单失败后切爸爸，爸爸可见 savedPaths 且 recoverFromSavedPaths 会以爸爸建立批次、discardRecovery 可删除妈妈唯一原件。恢复态必须按原始成员隔离，当前身份不符不可见/不可恢复/不可删除；返回原成员仍应找得到，不能简单清空句柄来“通过”隔离。
- `recovery-partial` 失败：选a/b，b本地保存失败，再让完整清单落盘失败；lastRecovery只保留成功 savedPaths，恢复时重排为一张ready报告，重新引入缺页。恢复必须保存完整批次/原槽位/失败项/顺序与成员绑定，不能仅保存成功路径数组。

页面仅内存恢复时需如实提示尚未持久保存与关闭风险，不声称重启可恢复；尽可能提供真实平台支持的可恢复元数据落盘路径。原件不可因恢复状态切换而丢失或自动归给另一成员。

## 完整页面闭环仍缺失（R2源码核对，不能仅修上述单点后再报冻结）

以下均为原 SPEC 范围，需完成真实入口和永久用例，不是新增功能：

1. **classify**：有 reportId 的旧报告分类分支仍调用旧 reportStore.updateReport；新批次预览又依赖 pendingUpload.fileUrls 非空（新协议刻意为空），从持久 batchId 冷启动无法预览原件。尚无可用的失败重试/重新暂存/缺图重选控件；需要完整批次状态、顺序预览、本人续传/重选、草稿持久保存及实际 save 路由。重新打开 ready/creating/响应丢失已提交批次不得再造报告或卡在基线0冲突。
2. **unarchived**：仅新增未被调用的 loadFamilyUnarchived；实际 onShow 仍调用旧 fetchUnarchivedReports，删除和批量归档仍走旧store。必须实际拉取/显示家庭未归档报告、按捕获revision修改分类/归档/删除；手动分类不依赖 ai_type_guess（AI未启用），批量部分成功/冲突/失败有可恢复反馈。
3. **batch**：为修复未绑定变量直接移除了 family 写入分支；当前 confirmArchive 完全回到旧 reportStore.createReport。既然本次多图默认一份报告，这页应承担已存在稳定报告的批量分类/归档，或提供同等可用入口完成原有批量管理，不能留空壳旧路径却声称接通。
4. **ai-result/detail AI卡**：只新增 isFamilyMode 函数并没有真正启用未启用态。ai-result 仍可直接路由读取旧报告并默认绿色勾；detail 家庭报告仍显示“开始AI解读/今日剩余次数”。正式态应明确“AI未启用”，不显示伪成功/健康结论；演示也需明确示例并不污染正式态。
5. **首页**：退出后的旧store副本/临时URL清理、只有未归档报告空态、暖离线时 loadError 覆盖内容却提示“显示最近数据”、已持久失败/ready批次列表及恢复入口，均需实际可用；不能只展示本次 manifest失败的内存卡片。
6. **永久测试**：新增store7仍“等价复刻”页面映射，没有执行真实页面。请让 UploadSheet→持久副本→登记→classify→列表/详情/未归档/批量的生产处理器进入永久回归，使用真正可解码的不同图片与字节摘要，补齐原spec证据。交接必须逐项列实际覆盖，未完成就继续实施，不要再以测试数量替代页面实现。

请先按这份完整清单与 SPEC 完成剩余生产路径，随后一次冻结交接；Codex会继续独立review。仍只改代码与本地配置，禁止部署/真实供应商调用/代替Codex提交。

- 批次 `/tmp/momcare-b2b2-batch-audit.cjs create-lost` 失败：真实handler已创建报告但丢响应 → 真实outbox补发得到确认并清队列 → 再点原批次保存，以新 operationId/基线0冲突，批次无法正确完成。需要持久创建意图/操作映射与确认后对账（或等价协议），不能仅依赖outbox暂时存在时去重。原batchId/reportId/顺序/草稿保留；自己的已确认报告不能被当成对方冲突。

### 恢复持久化引入的跨成员回归

`batch-audit save-switch` 已扩展检查新增 recovery 缓存（原用例仅检查批次缓存）。现又失败：saveFile 挂起时切爸爸，epoch拒绝旧批次落盘后，fallback 用 **当前** getSessionState 构造 rec，将妈妈原件写成爸爸的 b2b2-recovery。修复必须在开始时捕获原始身份，并在每个 saveFile await 后、任何主清单/恢复清单/可见状态写入前校验；旧会话失败不等于当前成员的存储失败，不能进入新成员恢复分支。不能通过只改上传主缓存来遗漏新增旁路。

### 创建对账不得自动覆盖对方修改

`batch-audit create-lost-peer` 新复现：创建丢响应→outbox确认→对方将备注改为“preserve peer edit”并同步→原批次再保存，新增“读取现有revision再补交整份旧payload”把备注覆盖成null。这与详情已修的基线问题同源，不能用当前revision强制通过来修create-lost。

创建意图应在首次请求前持久化，回放/对账只确认原创建是否已经完成；已有报告后续内容变化必须保留。需要再编辑时进入明确的已存在报告编辑流程，以原编辑基线冲突，而非批次恢复自动覆盖。原数据/草稿仍保留，不能清掉失败证据。

### 完整页面修复中的独立复核：新增分支仍被旧入口截断

真实 classify 处理器探针 `/tmp/momcare-b2b2-classify-page-audit.cjs` 三项失败：`save-route` 从未归档 source=p6 打开已有报告，save 最前面的 `if (reportId.value)` 仍执行旧 store 并提前 return，新增 family 分支永远不可达；`hydrate` 表单没有读取原报告备注/日期/分类/原件预览，编辑可能清空已有内容；`logout` 页面 id 与表单未随会话清空。正式入口需优先完整分流，冷启动按报告ID拉取并签发原件URL，捕获表单基线；修改分类不能顺手抹掉备注。批次草稿也仍仅成功后保存，没有编辑时持久保存/恢复。

未归档新代码仍有 `loadError` 未绑定（AST复现），allRecognized/onArchiveAll 仍要求 ai_type_guess，因此正式手动分类后无法进入批量归档；新增 pullReports 后未重映射可见列表、未加会话清理与 await epoch/目标保护。删除基线需在打开确认时捕获；批量在打开确认时快照 id/revision，不能每项发送时取最新版本且跨成员继续。

AI页新增 banner 后仍无 v-else 隔开结果区，onLoad仍读旧reportStore，conclusionIcon空结果仍返回绿色勾，底部仍“以上解读由AI生成”。正式态（包括未登录/锁定）应根本不读取旧档案、不呈现结果和伪成功；示例仅在明确demo可见并随身份状态清理。

这些是实际路径失败，不是需要添加更多关键词。请以原SPEC完整页面流程验收后再冻结；永久用例必须命中上述真正入口，避免手动填入store后仅测试新增不可达分支。

未归档上述缺口已由 `/tmp/momcare-b2b2-unarchived-page-audit.cjs` 实际页面探针独立复现：manual-bulk（人工分类报告进不了确认）、delete-baseline（确认框打开后同步revision2，删除请求用了2而非1）、delete-visible（云端成功删除后列表仍显示）、logout（退出后旧报告仍可见），四项均失败。SDK替身同步更新删除状态与list结果，页面真实store/action未替换。

AI实际模板探针 `/tmp/momcare-b2b2-ai-render-audit.cjs [unconfirmed]` 已编译原SFC模板、通过SSR生命周期执行onLoad，并将旧reportStore种入私人canary；confirmed与unconfirmed两种正式态都渲染旧canary（FAIL）。测试只适配uni外壳/生命周期，未替换业务分支；要求结果区从模板隔离、非demo不读旧store，并检查不显示绿色勾/AI已生成文案。

本轮页面修齐还需同时处理三项原spec要求：
- classify 正式态表单仍让用户填写 hospital/gestationWeek，但提交白名单只包含日期/类型/备注，这些输入被悄悄丢弃。明确支持并持久化，或正式态移除未支持字段，不能显示可保存却丢数据。批次控制闭合标签目前多一个 `>`。
- “缺图移除”不等于原spec的显式重新选择原件：失败/缺失文件应能选择替换同一槽位，新uploadId、原顺序与新副本先持久；若允许移除需明确本次报告页数减少。重复retry永远找不到已丢失文件不是恢复入口。
- save-switch 当前新增早退避免跨成员缓存，但保存成功的唯一原件路径没有可恢复清单，回原成员也找不到。应在开始建立原身份绑定的本地意图/恢复索引，或等价可恢复方案；迟到路径不暴露新成员，重回原成员可续传，不能仅将文件留在磁盘无句柄即称保留可恢复。

首页恢复卡实际模板又发现模型迁移遗漏：lastRecovery已从savedPaths改为items，模板仍读取 `lastRecovery.savedPaths.length`。新增 `node /tmp/momcare-b2b2-index-render-audit.cjs recovery`，真实SSR直接抛 Cannot read properties of undefined (reading 'length')；清单失败后整页不可渲染。修成真实items结构，并在 persisted=false 时显式提示恢复信息仅内存/关闭后可能无法恢复，不能仍统一声称已安全保存。

`batch-audit save-switch-recover` 已实测失败，切回妈妈后 batches/lastRecovery 均找不到 `/saved/a`。现有 save-switch 只证明不泄露新成员，不能单独证明恢复合格。

新增未归档 `bulk-baseline` 复现仍失败：onArchiveAll打开确认框→列表同步映射为revision2→doBatchArchive，请求expectedRevision=2。代码注释声称“打开确认时快照”，实际快照仍在doBatchArchive发送时才生成；需onArchiveAll冻结整个id/revision列表并绑定epoch，确认只执行该意图。前述manual-bulk/delete-baseline/delete-visible/logout四项现已独立通过。

## 当前集中复验快照与创建协议修正

36个独立入口：32通过、4失败，16份非文档源码测试期间稳定。失败是 save-switch-recover、index-recovery-render、unarchived bulk-baseline、ai-render unconfirmed。AI仅confirmed隔离仍不够，非demo都应关闭。结果位于 `/tmp/momcare-b2b2-reviewed-*.log`，不是整阶段验收通过。

创建协议本轮修复又有3项真实store/handler失败（`batch-audit`）：
- `create-ok`：首次正常创建成功直接return，批次仍ready，没有完成对账/清理，首页永远显示未完成。
- `intent-disk-fail`：创建意图落盘失败仍发出report.upsert并创建成功。persistBatches返回值必须是阻断门；失败回滚本机意图状态、保留原件，不发请求。
- `create-lost-edited`：首次备注original note，响应丢失→outbox确认→对方备注preserve peer edit→本机只改分类再保存。代码用最新revision和旧非空备注补交，仍覆盖对方备注。上一用例peer仅测空备注，现在非空备注证明相同缺陷未解决。

**本阶段确定的方案**：一个上传批次只负责创建一份报告。首次发送前持久化不可变createIntent，创建成功或已有创建对账成功后将批次完成（完成落盘失败需如实待对账，不能丢原件）；响应丢失按原意图补发/确认。已创建的批次不得再提交任何编辑payload，检测到草稿变化时明确引导打开已有报告编辑，保留未提交草稿；编辑使用详情/分类独立表单的captured baseline。删除后的旧批次不得声称可重建已删除报告。不要继续尝试“当前revision+只提交变化字段”：比较的基准是当前云数据时，仍会覆盖他人修改。永久页面2测试中“重开批次改类型即revision2”的期待应移到明确已有报告编辑流程，不能拿不安全的旧测试预期要求恢复链路偷偷改报告。

### 新恢复实现的必要边界（当前实施复核）

- 新增公开 `setMemberCacheFor(memberId,key,value)` 可在未确认身份下任意写成员缓存，且写时重新取env/AppID。不要为恢复扩展成任意身份写接口。改成**发起时已确认身份创建的受限恢复写入能力**：捕获不可变原env/AppID/member/family与恢复专用键，不接受调用方传任意成员/key；迟到只可写这个原作用域，返回真实落盘结果。恢复写失败不能硬编码persisted=true；尽力保留原身份内存句柄并如实报告。
- `replaceItemSlot` 新增chooseImage/saveFile两次await后都未校验开始epoch。独立 `batch-audit replace-switch` 失败：妈妈开始重选，切爸爸再返回，删除妈妈原来的唯一副本，但妈妈清单仍指向已删除路径。重选需沿用完整操作epoch/恢复能力，失效不得删除旧副本或写当前成员缓存；新副本元数据失败不能删除唯一新原件而不给恢复线索。
- `finishBatch` 当前即使persistBatches=false也循环删除所有本机副本；违背刚确定的“完成状态先落盘、失败保留副本”。写失败回滚/保持待对账状态并保留路径，不返回无条件成功。页面须消费warning/draftChanged等结果，不能把“变更未提交、请去详情编辑”统一变成“已入档”后自动返回；未提交草稿需真实可找回/可进入显式编辑。

`batch-audit finish-disk-fail` 已独立验证最后一项：仅当批次写入status=done时模拟磁盘失败，云端创建已成功，但本机原件仍被删除（FAIL）。本轮runner现41入口。要求数据持久门和页面反馈都修正，不以云端已有记录掩盖本机完成/草稿未保存。

最终收尾一并修正文案与元数据：UploadSheet仍写“自动矫正图片”但没有实现；cloud/collections.json新索引使用field/order、旧索引使用name/direction，应统一既有声明格式并注明unique；DEPLOY.md仍写9集合而本阶段新增mc_reports后为10；mc_reports.uploaderId应说明报告创建者（不必等于每个附件上传者）。这些只修改本地声明/文档，仍不执行部署。

重选恢复需沿用原完整批次，而不是建一份只含新图片的同reportId报告：当前replaceItemSlot恢复记录只放`items:[{order,...新副本}]`，recoverFromSavedPaths又直接按它建批，会把多页报告缩成一页。新增 `batch-audit replace-save-recover`（两页原批次，重选第一页在saveFile期间切身份，切回恢复，断言完整两页和新原件）现先失败于恢复记录不可读取。源码核对openRecoveryScope.write保存对象而getMemberCache JSON.parse要求字符串，需统一。修复读取后也必须保留原batchId、完整槽位、顺序、未改附件登记状态与替换意图，不能让原批次与新单页批次相互竞争同reportId。runner现42入口。

原件字节独立证据：`/tmp/momcare-b2b2-original-bytes-audit.cjs` 在真实上传/登记/报告链路上逐附件验证全部3项顺序、原始字节deepEqual、大小、SHA256一致，已通过；输出 `/tmp/momcare-b2b2-verified-original-{0,1,2}.png`，系统sips分别解码为有效1×1 PNG。此为合成文件验证，不代表真机图片/平台验收；永久回归还应保留同等逐项断言。

恢复读取序列化修正后，replace-save-recover进一步实测失败为 `1 !== 2`，确认重选恢复确实缩短多页报告；finish-disk-fail已扩展“磁盘恢复后重试完成对账”，现通过。

旧深链隔离仍需实修：`/tmp/momcare-b2b2-batch-page-audit.cjs` 实际onLoad在已确认正式身份、pendingUpload残留旧fileUrls但无新batchId时，仍渲染旧原件canary（1项，FAIL）。batch正式态应有batchId则去新分类，无则去真实未归档入口或显示明确状态，只有explicit demo走旧流程；classify的pendingUpload/fileUrls旧路径同样须明确demo门。不能只在注释里写“旧路径仅演示”。

详情AI卡也需把非demo未启用判断放在旧配额/状态判断之前；当前配额归零时会先返回“今日解读次数已用完”，仍误导正式用户。收尾时一并清理，不恢复AI供应商调用。

最新集中复验43入口42通过，仅旧batch深链失败，18份非文档文件稳定。但classify之前要求的两项页面代码仍未落地（只有service函数）：新实际页面用例 `classify-page-audit draft-persist` 失败（编辑未点击保存的草稿没有落盘）；`draft-changed-feedback` 失败（service明确草稿未提交，页面却提示“已入档”并自动返回）。请完成真实watch/onLoad恢复和warning/draftChanged分支，以及真实可取回的既有报告编辑草稿入口。不要用service存在或先前未执行的patch当作页面完成。runner已加入这两项，现45入口；其他已通过项无需重做。

分类草稿接线中又出现同类不可达分支：`if(reportId) {hydrate} else if(batchId) {...} else if(reportId) {readEditDraft}`，最后分支永远不会执行。实际 `classify-page-audit edit-draft-restore` 已复现本地草稿LOCAL UNSENT被云端原备注替代，FAIL；runner现46入口。恢复须融入真实报告加载分支，null/空备注也按字段存在性恢复，程序化hydrate不得先覆盖持久草稿。既有报告草稿应保存编辑时baseline，恢复时不能以最新云revision替换；成功提交后清除/标记已提交草稿，避免旧草稿反复覆盖新数据。批次draftChanged还需实际可进入相应报告编辑并找回那份未提交草稿，不能只有“请去详情”的toast但草稿藏在不显示的done批次里。

## 最终真实入口复核的剩余业务缺口（原SPEC范围）

1. 仅未归档时，首页显示“报告待分类”但该empty-state没有点击入口；真正@tap=onBannerTap的banner仍在has-archived分支内。需要把整理入口放在两种状态都可点的位置，不能只出现文字让SSR非空用例通过。
2. 报告冲突toast让用户去“同步横幅”处理，但报告各页没有冲突面板或明确跳转。唯一通用首页面板把report当“健康记录”，且只读currentRecord.fields，报告顶层note/dateKey等一律显示“未设置”。需要报告可到达的待同步/重试/冲突比较/采用云端/确认重提入口，比较真实报告字段。可以复用现有首页同步面板并正确按kind格式化、报告页提供明确入口，不必新增另一套协议；不能在错误的“云端未设置”比较下让用户确认覆盖。
3. `detail-page-audit delete-baseline` 实测expectedRevision=2而非确认框打开时1；unarchived已修，同等修detail的id/revision/epoch捕获与退出清确认框。
4. `detail-page-audit download-deleted` 实测下载1次：报告当前授权端点拒绝deleted，但onDownload从未重新调用授权而直接用旧缓存URL下载。原SPEC要求新下载操作重新鉴权与墓碑校验，须先报告路由取URL，再按发起epoch执行下载/相册保存回调。已下载离线文件不能撤回的边界仍如实保留。

runner现48入口；新增两项失败均为真实detail处理器。请集中完成这些既有入口，不把服务端鉴权通过当作客户端已正确调用。

上传开关暂时查询失败也需可重试：`batch-audit policy-retry`，首次策略请求断网→恢复网络→用户重新上传，仍失败且不再查询。当前把网络错误缓存为clientUploadEnabled=false并永久复用，真实档案页面没有refreshUploadPolicy入口。失败策略不当作已确认关闭缓存，后续明确重试应重新查询；迟到策略响应也绑定发起epoch。runner现49入口。

上一集中快照49/49已通过，但不代表本节未覆盖的源码缺口已解决。既有edit-draft-restore进一步按先前要求核验空备注与保存基线：两项仍失败（空串未恢复、恢复后保存expectedRevision采用最新revision2而非草稿baseline1）。这并非新增要求，上一条已明确。新detail download-switch则在授权后下载挂起→退出→回调，仍保存相册1次，缺少下载成功回调之前的epoch门。runner现50入口。

剩余收尾必须包括：仅未归档可点入口、报告实际同步冲突比较/处理入口、草稿baseline/空字段/提交清理及可到达的草稿编辑动作、下载各回调epoch；随后将修复变成长久可运行的测试与准确覆盖矩阵。不要再只完成某个探针的第一条断言就声称整段要求完成。

恢复信息也写不下时仍需保留本成员内存句柄（前文已有要求和对应UI）：当前manifest失败分支只在rec.persisted为true时才设置lastRecovery，两个KV键均失败时没有内存恢复入口。新增 `batch-audit recovery-memory` 已复现FAIL；已有恢复卡persisted=false测试使用注入数据，不能代替真实创建失败路径。保留受原身份约束的内存恢复信息、如实提示关闭风险，存储恢复后可恢复上传；其他成员仍不可見。runner现51入口。

同一路径 `batch-audit recovery-two` 也失败：主批次清单写失败、恢复键可写，依次选择a和b，单例lastRecovery被b覆盖，a的恢复句柄消失。无需扩展新功能：可在存在未处理恢复项时阻止新选图/建批（在移动原件前明确提示先处理），或持久保留多份恢复记录。无论选择哪种，不得覆盖任何尚未处理的唯一恢复句柄。runner现52入口。

仅未归档入口现有完整渲染/点击证据：`/tmp/momcare-b2b2-unarchived-entry-audit.cjs` 编译实际首页SFC，用Vue自定义宿主执行真实onMounted与模板，遍历实际渲染事件并点击整理入口，当前FAIL（没有任何可点整理入口）；不是仅检查文案。runner现53入口。

recovery-memory同时验证同进程内切爸爸不可见、切回妈妈仍能找回内存句柄，再恢复存储后续传；“关闭应用不能保证恢复”的真实限制不等于同进程切换时可以清掉唯一恢复句柄。仍为原身份隔离/保留恢复信息要求，无新增功能。

真实重暂存按钮还存在返回协议断裂：`classify-page-audit restage-feedback` 调用实际 restageExpiredItem → restageItem → processBatch，后者正常结束返回 undefined，页面读取 r.ok 抛异常。需统一重试/重暂存操作结果并按真实最终状态反馈，避免失败仍提示成功；现runner54入口。请与本轮既有恢复入口集中收尾，永久页面测试覆盖真实按钮。

本轮修复复核：recovery-two目前通过“原件路径还在”断言，但实现把两个不同reportId的items拼成一份新报告，破坏一批一报告语义，不能接受。按既定最小方案：存在未处理恢复项时，在saveFile前拒绝建立新批次，明确先恢复/放弃；不要拼接不同批次。recovery-memory内存map在成功恢复/放弃后也需清除，避免切回又复活过期句柄。草稿read现在可恢复baseline，但persistDraftNow仍未传baselineRevision，30ms自动保存后又擦掉；edit-draft-restore已补充等待去抖写盘断言，不得只测预先手工填入baseline的恢复瞬间。

既有报告冲突显示缺口已有实际页面处理器证据：`node /tmp/momcare-b2b2-conflict-page-audit.cjs` 运行完整home script setup中的真实conflictDiff/conflictLabel，report currentRecord.note与dateKey有值却显示未设置，FAIL。runner现55入口；其余report冲突动作通过实际共享outbox链路已验证，页面需正确显示并可到达。

草稿空字段需按实际序列化复验：persistDraftNow把空备注写成null，applyEditDraft却排除null；所以重开后仍出现服务器旧备注。edit-draft-restore的清空样例改用实际写盘形态note:null（仍同一明确清空要求）已失败。恢复应以own property判断，null/空串都恢复为表单空值，不能只支持手工注入空串。

新增档案冲突卡请直接从已有响应式familyStore.conflictEntries筛选报告，不要在Vue浏览器代码中require别名路径再catch返回空数组（构建后未转换的require会令卡片永久空白）。原首页通用冲突面板也仍包含report，所以该处的顶层字段比较同样要修正或明确排除转到正确报告入口；只新增另一个面板不能留下可错误确认覆盖的旧入口。

当前新增draftChanged modal只跳转详情，并未把done批次的草稿送入任何已有报告编辑表单，仍不满足原要求。增强draft-changed-feedback实际点击modal确认后核对成员编辑草稿/目标ID：需显式进入编辑并找回note/type/date与原创建版本基线（创建成功revision1；之后对方rev2不能被静默采用，或先有真实比较确认）。仅“去详情”的链接仍会丢掉用户这次改动。hydrate标记设true再立即false对默认异步Vue watch无效，需跨nextTick或同步watch的实际抑制；成功保存需取消尚未触发的autosave，避免刚清理又写回。

本轮CLOSEOUT大部分已落地，但新增两处真实失败（非新增功能）：index pending-count把已排除冲突的总pendingCount再减报告冲突，导致1待同步+1冲突=0；discard持久失败却清掉lastRecovery与RAM唯一句柄，永久store13c错误地期待这一丢失行为。独立两用例均FAIL，runner现57入口。具体最小修正及正确永久期待见CLOSEOUT最新复核。

重选恢复另一个已要求的真实分支尚漏修：切身份分支保留完整批次，但persistBatches失败分支仍只写新图片单槽位。replace-manifest-recover实际2页恢复为1页，FAIL；runner现58入口。见CLOSEOUT第三项，复用已明确的完整批次恢复设计。
