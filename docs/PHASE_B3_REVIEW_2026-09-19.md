# B3 方案与独立 review

基线：B2b2 `e0cf22f19ece03001d6f2446993805de27b0184e` 已本地验收并推送。B3尚未实施/验收；本轮仅合成数据，不部署，不处理真实旧数据。ZCode编码，Codex设计与review。

## 首版设计：暂不接受，先更正平台路线

`ZCODE_PHASE_B3_DESIGN_2026-09-19.md` 当前文件接口判断未经证据支撑，无法形成可移出小程序、再次选回的完整备份：

- 官方类型实际存在 `FileSystemManager.unzip`，不能写“小程序没有官方zip解压”。`chooseMessageFile`选择文件，不选择目录；把散文件沙箱目录当作可选`.mcpkg`备份包不可实现。
- `saveImageToPhotosAlbum`只能保存图片，无法带走manifest/领域记录，不能算完整备份。沙箱目录也不是用户可通过手机文件管理器直接取走的公共目录。
- 官方存在 `wx.shareFileMessage`（类型注释基础库2.16.1）；可由用户主动触发选择收件人的文件转发界面。必须保持“包已生成”和“用户完成转发”的不同状态，取消/不可用不冒充已导出到外部。
- 10MB是本机KV总量的已列注释，不能当成文件系统总量或普遍单文件上限。可自定保守的应用容量限制，但要标明是本应用限制，最终真机再验证可用空间与能力。
- `wx-server-sdk`是云函数服务端SDK，不是客户端文件API证据。

已独立取得官方发布包 `miniprogram-api-typings@5.2.3`（从registry.npmjs.org下载，未安装到项目）。证据：`/tmp/momcare-b3-api-evidence/package/types/wx/lib.wx.api.d.ts`，unzip 17763–17784；writeFile 17814–17848；chooseMessageFile 24390–24417；shareFileMessage 31527–31540；readFile注释17401，KV限制31303/31341。源码与npm对应关系见官方项目 https://github.com/wechat-miniprogram/api-typings 。文档网站本次无法打开，不能假称已读其内容。类型声明只能证明契约，不替代最后真机测试。

## Codex 确定的实现方向（请修订设计）

### 单一可搬移文件与两个真实适配器

采用一个有版本、可校验的 `.mcpkg` **二进制容器**，包含manifest、全部领域JSON及附件原始字节，导出与导入必须使用同一文件；不导出散目录，不通过相册替代备份。无需压缩已经压缩的PNG/JPEG，可使用简单有界容器：固定magic/version/manifest长度 + UTF-8 manifest + 按清单顺序的文件字节段。清单记录每个逻辑相对路径、长度、SHA256及领域/报告附件映射；长度/偏移计算使用安全整数并检查越界、重叠、重复、缺文件、尾部多余字节。若选择成熟ZIP库代替，必须说明小程序兼容与解压前/解压中总量限制，不能靠先完整解压后再验大小。

微信适配器使用实际wx FileSystemManager的读写/追加或定位读写，逐文件/分块处理；生成到USER_DATA_PATH的独立工作目录，回读校验完成后提供用户主动点击的shareFileMessage。导入由chooseMessageFile取得单个包文件路径，先校验再预览；不从聊天自动读取/发送任何真实文件。能力缺失、取消、空间不足等都有真实错误状态。新建临时路径由程序生成，包内路径仅作逻辑索引，不能直接拼接到真实写入目录。

H5提供真实Blob下载与File选择适配器，使用同一容器编解码器、同一验证规则；H5不是仅打印路径/只下载manifest的演示实现。通过H5不代表微信真机通过。不得给云函数传本机路径、浏览器Blob URL或任意远程URL让其下载。

明确应用自定上限：包字节/manifest字节/文件数/单文件字节/记录数；业务拒绝超限而非静默裁切。摘要用可在小程序运行的增量SHA256实现或锁定依赖；不把Node crypto/Buffer偷偷带入客户端，提供标准已知向量和多块边界测试。

### 迁移与导出权威范围

- 白名单旧业务键和已知备份前缀可扫描；不读token/OpenID/整库。读失败与格式错不能当空。原始字节保留，来源/共享与本人私人字段逐类明确确认；不替另一成员确认作者。
- 迁移意图绑定可信身份+原始摘要+字段选择。稳定源身份到目标ID的规则、同源原键与备份重复选择如何处理必须明确；目标初次迁入用创建基线，不自动覆盖现存/较新/已删记录。相同确认、断网/丢响应/重启复用ID和操作意图，不生成新副本。真实上传仍由已验收的受控文件协议完成。
- 导出应包含当前已实现领域：孕期资料、日健康、产检、待产包、报告、本人可选私人记录及报告原件；未来C领域需可扩展。从有服务端授权的真实列表/文件接口读取，不能仅把已有客户端局部缓存称作全部档案。
- 导出前检查待同步/冲突状态；未同步数据不包含在云端完整备份时，必须明确阻断“全部完整”的宣称，给出先处理待办的入口。全分页失败/文件缺失/读取失败不得产出complete=true。
- 清单记录实际取得的实体版本，不宣称跨集合原子快照。完成交付前重新校验身份和所读敏感记录的授权/墓碑；发现删除或版本变化则有界重试/明确不完整，不用旧幂等结果泄露已删内容。

### 隔离恢复与文件生命周期

- `mc_restore_*`是隔离域，不能被实时首页/统计读取。本轮只实现隔离恢复验证，不额外实现restore.merge（原SPEC明确是另一个操作），不做不必要的主动永久清理界面。
- 不能仅有familyId检查：混有私人记录的批次列表/详情/分页/幂等结果/校验结果还必须按可信当前member限制。记录附有visibility/owner，私人只能本人读写，不能在restore.preview把另一成员的私人原文带出。
- 新环境不接受包自带family/owner/fileID作为授权。包里有另一个人的私人标记时不得静默认领；预览明确私人作者范围，只有本人确认的输入进入本人私人隔离域。所有附件用实际字节重新受控登记。
- **恢复文件也必须受引用保护**：B2b2的mc-files清理目前只认识正式报告引用。设计必须说明恢复报告持有的引用如何事务登记/读取授权/阻止裸fileId旁路/阻止孤儿清理误删；“不影响隔离区”不是实现。可扩展独立restore引用集合及受控恢复读取路由，保留B2b2引用/删除竞态回归。
- 云函数不能自己访问客户端包文件。请明确begin/逐记录或逐附件上传/commit/preview/verify的数据输入与状态机，服务端自行校验schema、记录计数、摘要、实际文件归属与完整引用。未上传齐、失败/重放、身份切换不得标restored。批次实体分页，不把全部数据塞单个无界数据库文档。
- 格式版本只接受精确受支持版本（例如===1）；不是“存在且≤1”。路径规范化、未知schema、重复ID、关系映射、摘要、实体字节与容量在落隔离云数据前完整验证。

## 下一步

ZCode先提交修正设计（含具体格式、上限、接口、领域映射及永久测试矩阵），Codex确认后开始编码。可按B3a迁移、B3b完整备份/隔离恢复分批实现和review，最终共同验收B3；不降低完整恢复要求，也不提前部署。

### 页面与字段核对补充

privacy.vue当前仍用旧isRealAuthed/healthStore/reportStore展示统计和“清本机”入口；B3入口需切到可信会话与familyStore统计，非确认身份不展示上一成员数据。旧来源扫描只在用户进入来源预览后发生，不能为了显示数量在每次冷启动自动读全部旧健康/报告正文。原旧清理/确认按钮不得误称已完成新云迁移。

旧健康样例字段为records[date].weight、bp字符串、fetal、mood、note；目标daily为weightKg/systolic/diastolic/fetalCount，mood域为mood/symptoms/note/plans。旧note不能默认映射到sharedNote；孕期资料也应有明确映射。报告旧字段report_type/report_date/notes/file_urls/localPaths不等同目标schema；遗留HTTP/fileURL不是授权凭证，找不到原件如实保留待处理。未支持字段/单位/日期在预览中指出并保留原始来源，不parseFloat任意脏字符串、不把零值当缺失。实际字段转换由schema校验与合成端到端用例证明。

## 修订版设计复核与分批推进

修订版的单文件容器/微信与H5适配器/私人ACL方向接受，但B3b暂不编码，仍须更正：
- 200MB包却设计fsm.readFile完整回读，与已核实readFile单文件100M注释不一致；必须全程分块且明确峰值内存，或收紧应用上限。客户端附件20MB也与当前mc-files的MAX_BYTES=10MiB不兼容，统一受控上传限制。
- restore.uploadAttachment不要传base64Data大正文给云函数。客户端使用已验收prepareUpload→wx.cloud.uploadFile→registerStaged，然后向mc-restore传fileId/摘要/映射；服务端重新校验归属、字节与引用。
- 状态机里restoring/restored没有对应实际动作；请明确commit或verify如何完成转换，稳定operationId绑定完整内容、批次owner和租约/版本；不能只用数量代表每个预定条目都存在。
- manifest未声明报告原fileId→包内fileIndex的实际映射结构，仅有referencedBy和描述“sha256↔fileId表”，需补完整字段与顺序关系，否则不可恢复共享引用。
- unzip表格“基础库≥2.19.2”把“插件中使用”限制误作通用基线；本设计不使用该API，但平台事实须准确。

**B3a先行**：按新增 `ZCODE_PHASE_B3A_SPEC_2026-09-19.md` 细化并实施旧来源确认/迁移；B3b后续按修订设计另行review。这样不会让尚未确定的包/恢复协议阻塞独立迁移工作，也不降低B3最终完整备份验收要求。

## B3a 首轮源码 review：阻断项（尚未冻结，不接受）

1. migrationStore 的 sha256HexSync 实际为 FNV 加零，不能冒充 SHA-256。使用真实跨端 SHA-256 并用已知 UTF-8 向量核验。canonical sourceId 不应依赖主键/备份键或正文摘要；相同身份不同正文是同一目标的候选版本，只能明确选择一个。computed 不得修改原扫描实体导致反复追加后缀。
2. 当前实体缺 entityKey/dateKey，页面 daily 分支将目标 hash 当日期发送；私人字段塞在 daily.payload.private，根本没有 mood 实体，真实执行无法迁入私人域。daily 与 mood 分开确认/持久/提交，日期和孕期资料及旧 checkupSchedules 完整映射。已核对报告 blood_routine 等枚举与当前服务端一致，这不是阻断项；缺少报告类型和真实旧类型映射仍需验证。
3. operationId 仅写清单未传 familyStore；所有分支仍生成新 opId。必须有真正使用清单稳定操作 ID 的受控接口，所有域适用，并测试响应丢失/本机完成标记失败后冷启动与同源重复确认。已存在未完成批次不得被新确认覆写丢失；已完成来源重复确认应对账而不是新批次新请求。
4. scanSources 无正式身份门禁，unknown schema 总当 ok，origin demo 未识别，未补写原始备份。原始 raw 含身份值不应暴露响应式预览对象。错误字符串也不要直接反射 JSON 原内容（parse 错误可能带 token canary）。未知字段、坏日期、空串/布尔/数组 Number 转换、缺失来源类型须隔离待处理。plans 仅白名单 text/done，不能原数组透传嵌套凭据。
5. executeBatch 未核验 session/所有权/来源摘要，resume 校验页面未调用；persistBatch 的执行与结果失败被忽略；冲突计为 ok/done。执行前及每条副作用前核验绑定与源确认；失败停止并保留可恢复状态；pending/conflict 不能成功。会话变化清空页面 selections/privateConfirmed。
6. 报告只读 file_urls，丢 unarchivedReports/localPaths；只接受 store/tmp 假路径，遗漏真实微信保存路径。丢失/远程附件被从迁移槽位删掉后仍尝试保存；全空由服务端拒绝，但部分成功可能漏页。uploadId 在网络前没持久；一般上传失败被忽略继续保存；每个 await 后无 epoch 检查。必须全附件槽位保留、有真实重选原件并重新确认入口、保存受控原件/ID/manifest 后上传，全部注册成功后才提交报告。复用 B2b2 已验证协议，缺失/禁用/网络错误不能假成功。
7. privacy 当前实际缺失 isExplicitDemo/getSessionState/isExplicitLoggedOut/watch/subscribeSession/navigateToPage 绑定，setup 将 ReferenceError；编译构建并不证明实际能打开。仍读取旧 healthStore/reportStore/listLegacyBackups 统计，须改为 familyStore 及可信会话；扫描页不能只展示字段名和技术状态，私人内容和共享 note 的确认范围应可读。
8. 永久测试目前使用手写 executor，恰好绕过页面错误；成功断言只要 stats 存在或数量 <= 源数，零写入也通过。要求 actual Vue script/page handlers 加真实 store/outbox/handler，逐条断言日期、私人领域、字段、原件字节和数量，别复制生产分发器。种入真实 canary 才能测试防泄漏；真实切换身份并确认后验证隔离。两张以上有效 PNG/JPEG，不用 12 字节假 JPEG。
9. 已再次观察到 node test | tail 后 echo $?；这是 tail 的退出码，明确禁止。使用捕获 Node 原退出码的方式，输出完整总结，失败必须修复且不改弱断言。

请按实施 SPEC 完成生产路径与永久测试后再提冻结，不用以初版测试总数替代范围验收。

### 首轮独立复现（实际页面脚本，不替换 executor）

- `/tmp/momcare-b3a-page-audit.cjs`：daily/private 均失败，实际页面丢失 dateKey，服务端返回 dateKey 非法，私人内容没有落到 mood。demo 仍可生成待执行批次；backup 场景未产生原始备份。
- `/tmp/momcare-b3a-unbound-audit.cjs`：privacy 存在 9 处未绑定引用。
- 首版永久测试实际 Node exit 0、11/11；这些绿灯不能证明页面正确。
- 单个缺失报告原件被 mc-reports 的非空附件校验兜底拒绝；不能把这一场景描述为已成功上传空报告。仍需覆盖两页原件中一页失败另一页成功时是否误提交不完整报告。

### 修订中提前核对（供本轮一起处理）

- 新 SHA256 对 9 个标准/UTF-8/55、56、63、64、65 字节边界向量与 Node crypto 一致；但只在 Node TextEncoder 存在时通过。当前工程未发现客户端 TextEncoder polyfill；请使用平台无关 UTF-8 编码或明确提供兼容层，并在移除 TextEncoder 的隔离测试中验证中文、emoji、孤立代理字符，避免把 Node 全局误当微信能力。
- 旧 stores/health.js 的 lmpDate/dueDate 是 Date.toISOString()，不能直接取前 10 位当上海日号；实际保存的 2026-03-31T16:00:00Z 应映射为 2026-04-01。
- 真实旧产检 fields 参见 health.js _templateToSchedule：_id/checkup_date/week_of_pregnancy/week_label/hospital/department/time_slot/status/exam_items[{text,required,done}]/notes/remind_days_before。旧报告根为 {reports,unarchivedReports}，两组都必须读。
- sessionReady 应排除 confirming；同一 memberId 在不同 family/env/app 下也不能复用旧批次。入口确认不能使用任意调用者传入 fields 绕过扫描记录和规范化 payload，必须对应当前已审核来源与明确选择。

### 修订版新增实际页面失败（须一起关闭）

`/tmp/momcare-b3a-privacy-audit.cjs` 实际隐私页 setup：未确认和已确认身份均显示“演示”，因为 computed ref 的 demoMode 未在 JS 中取 .value；actionItems/确认文案同样受影响。clearCache 被替换成 `const result={ok:true}`，无清除/无备份却进入成功分支，toast.title 未定义。不得新造假成功。若当前新模型暂不支持安全清本机，明确禁用并告知未执行，保留待办/原件；不要删除数据以通过本轮测试。

`/tmp/momcare-b3a-page-audit.cjs conflict`：真实 bag 冲突仍将批次标成 done，页面隐藏继续处理按钮，未完成不能过关。执行前 source-changed 和 batch 落盘失败的最新修订已通过对应窄探针；不代表其他恢复路径验收。

旧 checkupSchedules 的提取当前被写进 hospital_bag_items 分支，真实存储在 HEALTH 根，仍完全漏掉；pregnancy 尚未提取。稳定 operationId 尚未接 familyStore，不能以清单里有这个字段声称已实现幂等。

### 第二轮独立探针结果（修订中快照，非冻结验收）

实际页面探针现已通过 daily、private、demo、backup 正常写入，以及 source-changed、执行前 persist-fail；SHA 摘要值正确。仍失败：

- `node /tmp/momcare-b3a-page-audit.cjs unknown-schema`：schemaVersion=999 仍 ok，knownSchema 只检查已白名单 key 名称，未检查根结构/版本。
- `... backup-fail`：补备份写失败被吞掉，真实 mc_health_daily 仍产生写入；有备份键但正文不同也不能当已备份当前源。
- `... pregnancy`：真实根 lmpDate ISO 未转换为上海日号。
- `... checkup`：真实 HEALTH.checkupSchedules 未出现在预览。
- `... paired-attachments`：两个 file_urls 与两个同页 localPaths 被拼成 4 个槽位，应该按同页对应关系优先选本机原件，并保留 2 页顺序；不能把 URL 与其本机副本当两页。
- `... conflict`：未解冲突仍 done。
- privacy mode/sync/clear 三项探针仍失败，详见上一节。

探针路径为 Codex 独立 /tmp 证据，不能通过编辑探针或只更新文档来关闭。永久测试应补生产入口等价场景。B3b 补充约束另见新增 B3B SPEC，仍待 B3a 通过后设计收尾。

### 数据完整性阻断已实际复现

- `node /tmp/momcare-b3a-page-audit.cjs partial-original`：两页有效 PNG，第二页直传失败。真实页面仍创建只含第一页的 mc_reports 记录，并把实体和批次标 done。当前附件字段/缺页提示不等于上传失败守卫；必须阻止这种“成功”。
- `... stable-op`：批次清单 operationId 未进入真实 mc_operations。
- `... ack-disk-fail`：云端成功后迁移进度写盘失败，重建整个页面模块/身份重新确认再执行，生成新操作导致假冲突，不能恢复为已完成。

这些复现使用合成原件、实际页面 executor、真实 cloud handler；不能通过换成手写 executor 或仅断言数量上限替代。

字段契约补充：mc-health 的 symptoms 是文本数组（stringList），当前将 rec.symptoms 转 String 会导致私人日记整体保存失败；应按实际旧数组白名单验证并保留。plans.done 字符串不能 Boolean('false') 默默变 true；fetal 的布尔/空串不能 Number 转成伪造有效计数。非法日期需校验真实日历而不只是正则。对应边界由永久生产入口测试覆盖。

稳定请求接入的边界：familyStore 现有 sameEntity 去重仅比较 payload，outbox.enqueue 会合并同实体从未发送的条目。迁移持久意图需明确保护：不能借用其他普通编辑的 opId/基线，不能被之后普通编辑合并替换，也不能吞掉用户原有未发送草稿。固定 opId 只有 kind/entity/date/expectedRevision/extra/payload 全部相同才能重放；同 opId 换正文拒绝。可用窄迁移入口 + immutable 意图标志，保留普通编辑已有行为；永久测试覆盖迁移与普通待办的交错。

### 第三轮复核 / 身份切换复现

当前窄探针已通过：daily/private/demo/backup 正常分支、conflict 不误标 done、checkup 预览出现、privacy mode/sync/clear；不等于该领域全部验收。pregnancy 的真实 ISO 日号、stable-op、partial-original 仍失败。

新增 `node /tmp/momcare-b3a-page-audit.cjs upload-switch`：第一张图直传挂起期间切换到另一成员并重新确认，uploadSingleFile 返回 stale，但页面忽略后继续传第二张并以新成员身份创建旧批次报告；executeBatch 最外层 epoch 检查发生得太晚。必须在页面/服务每个 await 后与下一副作用前终止旧 continuation，不能仅在最后丢弃 UI。

### 固定 opId 接入后的交错审计

新 stableOpId 基本传递后，`stable-op` 与 `ack-disk-fail` 两个独立探针已通过。但尚未保护既有 outbox：

- `node /tmp/momcare-b3a-page-audit.cjs borrowed-op`：同实体同 payload 普通旧待办存在时，submit 仍先命中 sameEntity 并用其旧 opId 发出，迁移清单 opId 从未提交却标 done。
- `... unsent-draft`：已有同实体未发送的 USER_UNSENT_CANARY 草稿，迁移入队直接被 enqueue 合并覆盖，成功后原草稿消失。

须落实上一节固定意图完整比较与不合并规则；仅 `stableOpId || newOpId` 还不够。

### 页面全流程范围检查（不能用预览代替执行）

- 新增 `pregnancy-exec` 与 `checkup-exec` 均失败：页面 executor 只有 daily/report/bag/mood，孕期/产检实体出现在预览后仍走 unknown-domain。孕期资料还须保存真实根 dueDate、userInfo.nickname 等受支持字段，而不只 LMP；产检 status 应传 saveCheckup 的 status 参数，note 不是 mc-schedule 支持字段，未支持内容明确留原始隔离并在确认页说明。
- 页面目前没有实际 chooseImage/重选原件处理器或入口，也没有上传前持久化 uploadId 的服务动作；不能在 HANDOFF 称“重选入口/稳定附件意图已实现”。源是临时路径时需先持久副本，先保存可恢复的 manifest，文件/manifest 任一步失败保留可找回输入；可复用 B2b2 的恢复协议。
- 提交前需能看到具体私人内容与共享报告 note 的范围/实际值；现 fieldsSummary 不显示它们。confirmEntities 应根据可信扫描实体生成字段，不能信任传入任意字段对象或未确认的私人标记。
- upload-switch 已加强到断言切身份后业务调用为零：虽然“第二页失败不建不完整报告”使原先仅检查报告不存在的探针通过，仍实际发出 2 次新成员文件调用，所以尚未修复会话续体。
- 部分错误只返回 code，页面只处理 stats/stale/busy，backup/source变更/存储错误需有可见反馈和处理入口；未完成批次不能把用户锁在反复失败中。

备份保护追加：`backup-preserve` 探针失败。当前固定 `_RAW` 备份键遇到源变化就覆盖前一次原始备份；应使用不覆盖的独立标识/内容摘要键，并验证当前源的备份存在。旧备份是恢复依据，不可为了“等于当前源”破坏旧副本。

### 稳定源身份已复现重复报告

- `backup-reimport`：先从正式旧报告键迁入一条，保留程序生成的原始备份；再只从该备份预览/确认/执行，同一旧报告产生第二条 mc_reports。sourceKey 参与 targetId 是直接原因。
- `conflicting-source-choice`：同旧 reportId 的主来源和历史备份内容不同，页面可以同时勾选并确认两条；缺少同源候选版本排他选择/服务端意图校验。

上述均已有合成实际页面到 handler 证据。最新完整收尾项请以 `ZCODE_PHASE_B3A_CLOSEOUT_2026-09-19.md` 核对，减少逐次只修最近三项却遗漏原 SPEC 的情况。

### 当前集成快照（30 入口）与重放运行错误

独立 runner 在源码 hash 稳定快照下得到 26/30：backup-preserve、pregnancy-exec、backup-reimport、conflicting-source-choice 仍失败；其余 26 为各自窄场景通过，不含尚未实现的重选/永久覆盖。

额外 `lost-response` 实际复现：云端已提交但响应丢失，第二次执行同一持久待办，familyStore.submit 访问尚未声明的 expectedRevision，抛 ReferenceError，批次卡 executing。该分支还引用未定义 extra；先构造最终 expectedRevision/extra 快照，再比较完整请求。应对“已发送待办仍在”的重放单独永久覆盖（ack-disk-fail 的 outbox 已被移除，不能代替此场景）。

持久恢复读失败追加：`manifest-corrupt` 复现旧批次 JSON 损坏后冷启动，loadBatch 将不可读当不存在；再次预览确认直接覆盖损坏原字节。须区分 no-batch 与 unreadable/corrupt，保留原始恢复材料并阻止新的确认/写入覆盖；不是所有 null 都是空数据。

`family-switch` 复现：迁移确认后，同一 memberId 在新 familyId 下重新确认身份，旧批次仍执行并写入新家庭，批次自身还标着旧 familyId。固定家庭配置变更后也不能沿用旧确认；绑定检查须在加载/确认/每个执行入口都生效。

### 迁移回执不能只记 targetId（已复现假成功）

新增 changed-reimport/deleted-reimport 两项失败：首次迁入后修改旧来源正文、或在云端删除目标，再重新预览确认迁入；现 isPriorMigrationTarget 只看 targetIds 历史，把服务端真实 revision-conflict 改成 done。前者新内容根本没保存，后者当前记录仍已删。迁移回执至少绑定可信 scope、稳定源身份、规范化内容/附件摘要、原 operationId、权威结果版本/状态；仅同源同正文且当前权威记录允许对账时确认已迁入。不能吞掉新内容/墓碑/较新记录冲突。写历史失败不能“尽力”后宣称已经有可恢复回执。

补充测试运行记录：扩展到 36 入口的一次运行有 29 PASS，其中 lost-response 的失败来自与 ZCode 同时 assemble 删除共用 dist 的文件竞态，不是业务断言。单独重跑 lost-response 已 PASS；独立探针现将同一云函数源文件/共享模块复制到本次 /tmp 沙箱再 require，避免修改全局 dist，后续全部入口需重跑。其余明确失败为 pregnancy-exec（漏 preWeight/height/doctor/phone/babyNickname）、manifest-corrupt、family-switch、selection-switch、changed-reimport、deleted-reimport。

原件专项：`multi-original` 用两张不同 SHA256 的有效 PNG，经实际迁移页→登记→报告，逐页核对正式副本字节/顺序，目前 PASS；`upload-intent` 在真实 wx.cloud.uploadFile 入口检查磁盘迁移清单，uploadId 尚未持久即发出直传，仍 FAIL。这正是冷启动重复登记/丢恢复信息的生产缺口，不能只靠最终保存 batch。

`other-member-batch` 已复现上述作用域错误：妈妈有正常待迁批次，切爸爸后显式扫描/确认自己的来源，因 keys.includes 命中妈妈的缓存，爸爸被误判损坏而无法建立自己的批次。应精确判断当前成员批次，其他成员正常缓存不构成当前损坏状态。

## rev6 独立裁定：未接受

源码 hash 稳定的 39 入口运行 37 PASS；upload-intent 与 other-member-batch 失败。重选原件/持久附件意图仍无实现，永久套件仍是 11 场景且没有真实页面 executor。HANDOFF“CLOSEOUT 全部完成”不属实。下一步实施 `ZCODE_PHASE_B3A_ATTACHMENTS_2026-09-19.md` 明确子步；其余 CLOSEOUT 继续适用，不能因窄探针绿色跳过。

### rev6 后续独立边界复核（附件子步进行中）

新增两条真实页面 → 服务 → 云 handler 入口均 exit 1，尚未修复：

- `node /tmp/momcare-b3a-page-audit.cjs historical-source-choice`：主键 ORIGINAL 与历史备份 PRIOR 同 ID，仅选 PRIOR，确认后 batch=null。不同正文候选没有 contentDigest，服务 field-mismatch 拒绝；旧“双选拒绝”绿色不能证明可正常单选。还需传明确 canonical entityKey，避免 @digest / 冒号 ID 被 split 误拆。
- `node /tmp/momcare-b3a-page-audit.cjs newer-cloud-reimport`：原待产项迁入 revision 1 后，正常编辑到 revision 2 的 NEWER_CLOUD_CANARY，再确认同旧源。云端 revision-conflict 被旧 receipt 吞掉，batch/status 都 done，error 却是 revision-conflict。应保留冲突并展示云端较新状态；旧本机摘要不是当前权威版本证明。

这两项属于既有 CLOSEOUT 范围。附件子步先完成，之后必须修复并补永久真实处理器测试，不用重复旧全套掩盖失败。

- `node /tmp/momcare-b3a-page-audit.cjs private-service-gate` exit 1：对真实 preview 的 mood 调用 confirmEntities，显式 includePrivate=false 仍生成含 PRIVATE_CANARY 的可执行批次。页面 checkbox 不是服务门禁，需服务核验当前确认与规范化实体，私人确认不得借扫描/身份变化沿用。

- privacy 页追加实际 computed 探针：`node /tmp/momcare-b3a-privacy-audit.cjs deleted-count` exit 1（已删除 daily 仍计为 1）；`pending-status` exit 1（outbox 有未发记录仍显示“正常”）。均属 CLOSEOUT 第 3 节现有要求。`pullAll` 与报告拉取范围也须核对，不能本地空缓存报云端 0 条。

### 附件补丁进行中快照（不构成冻结）

扩展 runner 48 项，本次 43 PASS / 5 FAIL，源码在测试期间变化（stable=false），不能算最终成绩。原退出码 1。最新真实 `reselect-save-switch` 已越过 undefined 错误，直接复现**妈妈新图恢复路径写入爸爸缓存**；根因是 stale 分支才 openRecoveryScope。另失败 historical-source-choice、reselect-cancel、privacy-deleted-count、privacy-pending-status。newer-cloud-reimport/private-service-gate/upload-intent/other-member-batch 本次窄场景已绿，但附件完整管线/永久真实页测试仍缺失，仍未接受。

### CLOSEOUT 作用域/损坏判定补证

- `node /tmp/momcare-b3a-page-audit.cjs family-switch-visible` exit 1：相同 memberId 重新确认至不同 familyId 后，旧家庭迁移批次仍显示在 migrationStore.batch。只在 execute 检 family 不够；load/watch/预览/恢复都应核对完整 scope。
- `node /tmp/momcare-b3a-page-audit.cjs manifest-structural` exit 1：可解析 JSON 但 entities 非数组、缺少有效协议字段的旧批次，被当作已完成正常批次覆盖。需验证完整 schema；解析成功不等于可用，保留原始字节并明确不可执行。

均属原 CLOSEOUT 第1节，不新增业务范围。runner 当前共54项。附件任务之外的剩余项仍按 CLOSEOUT（包括严格规范化、可处理状态与隐私页真实状态）逐项收尾，永久测试不允许仍停在11个宽松 executor 例子。

### 恢复信息隔离与磁盘失败（独立真实处理器补证）

- `node /tmp/momcare-b3a-page-audit.cjs recovery-other-member` exit 1：妈妈重选原件的 saveFile 回调在切爸爸后返回，故意让原 scope recovery 写盘失败；代码把原件句柄留内存，但爸爸调用 getAttachmentRecovery() 可读到妈妈句柄。读取函数不能遍历返回任意 member 的内存记录，须当前可信完整 scope 精确匹配。
- `node /tmp/momcare-b3a-page-audit.cjs reselect-manifest-disk-fail` exit 1：新副本保存成功，批次清单磁盘满；页面 toast 说“新图片已保留”，但没有任何 recovery 句柄可供恢复入口读取。新副本路径只在返回对象里，页面未持久保留，冷启动孤儿化。

这两项属于既有 ATTACHMENTS/recovery 合同；修复后需在永久实际页面测试中覆盖。后续若测试临时文件，也应先更新完整清单中的保存路径并落盘，然后才能 prepare/直传；当前页面只改局部 uploadPath 然后直接 uploadSingleFile，不满足磁盘先行门禁。

### 探针校正（同轮）

`registered-retry` 最初按上传路径名称 `first/second` 判断，页面后来生成持久副本路径后这个条件不再对应附件原始页，导致假失败。独立探针已改用两张有效 PNG 的实际字节区别第一/二页、在二进制上传入口按第二页字节仅失败一次，并按第一页字节统计上传次数。修正后的真实页面场景 exit 0：第二页重试完成，第一页只上传 1 次。撤回对这一项“当前仍失败”的判断；其他附件持久意图/恢复缺口继续独立核验。审查时以最新脚本和当前源码哈希为准。

### 新附件页执行 race（ZCode 正在修改中）

`node /tmp/momcare-b3a-page-audit.cjs temp-copy-switch` exit 1：临时原件做 saveFile 时切妈妈→爸爸，回调到来后旧页面 continuation 仍以爸爸身份发出 2 次业务调用。当前页面在 `await persistLocalCopy` 后、调用 `persistBatchNow()` 和 `uploadSingleFile()` 前没有核对发起 epoch，`persistBatchNow` 也没有发起 epoch 参数。这个真实处理器路径比“上传完成后核对”早，须立即停止下一副作用并让新副本只留原成员恢复域。不能只用页面最终没建报告作为通过依据。

正在实施的 reportIntent 也需检查持久写入返回值：`migrationStore.persistBatchNow()` 失败时不能继续 saveReport。必须在可能发送前标 mayHaveBeenSent，后续旧 opId 固定重放原始完整 payload/ordered fileIds；reselect 检查这个标志，而不能以任何附件已登记就禁止缺页重选。

`temp-copy-switch` 复测：旧 continuation 对爸爸的 2 次业务调用已被新 epoch guard 阻止。探针同一场景进一步核对新生成的持久副本 `store://temp-copied-under-mama` 是否在妈妈原 scope 清单或 recovery 中可发现；当前 exit 1，路径没有落盘，切换后副本孤儿化。源原件若由 saveFile 移动，重启后无法靠旧临时路径恢复。要求在原身份捕获受限 recovery writer，saveFile 后 stale 分支写原成员句柄并报告真实写盘结果；不能写爸爸，也不能只返回字符串。

### rev7 复核：原件切换已过，报告标记与缺页重选仍阻断

`temp-copy-switch` 在当前源码上已 exit 0：旧 continuation 对爸爸零业务请求，妈妈命名空间可发现新持久副本。这个结果仅覆盖该单一 race。

- `node /tmp/momcare-b3a-review-extra.cjs intent-marker-disk-fail` exit 1：执行开始状态与首次 reportIntent 已写盘，第三次写迁移清单（`mayHaveBeenSent=true`）模拟磁盘满。页面忽略 `persistBatchNow(execEpoch)` 的 false，仍发 `report.upsert` 并创建报告；冷启动无法准确判断可能已发送。该标记必须在调用 `saveReport` 之前确认持久；失败保持原意图并停止业务调用。
- `node /tmp/momcare-b3a-review-extra.cjs failed-page-reselect` exit 1：第一页已登记 `fileId`，第二页上传失败且报告尚未提交。`reselectAttachment` 因“任一附件有 fileId”拒绝重选，页面按钮也只对 `pending` 且非 `missing` 的槽位显示；失败页无法修复。以已持久 `reportIntent.mayHaveBeenSent` 和真实终态为冻结边界；允许尚未提交报告的失败/缺失页重选，保留第一页登记。

当前 `tests/phase-b3a.regress.cjs` 仍为 11 项、392 行，主要通过手写 executor 测 store，尚未覆盖上述真实页面分支。ZCode rev7 的 57/57 是当时已有探针范围，通过数不能替代新增两个真实路径失败，也不能视为 B3a 验收。页面 `UPLOADED order` 调试输出及每页登记后及时持久化/冷启动续传仍需核实。B3a 未接受、未提交、未部署。

同页 UI 源码复核还发现 `attClass` 被声明为 `async function`，模板 `:class="attClass(att)"` 收到 Promise，附件状态样式不会按预期同步应用；`domainLabel` 未映射 pregnancy/checkup，`fieldsSummary` 没有列出实际私人字段、报告 note 或旧孕期/产检关键字段，用户无法核实迁移范围。这些属于现有 CLOSEOUT 的可审阅预览要求，需修页面并用真实组件渲染/处理器测试验证。

本机路径不能只凭 `wxfile://` 前缀判定已持久：页面 report executor 目前仅对 `tmp://` 调 `persistLocalCopy`，其余 `wxfile://` 直接二进制上传。uni-app 官方文档明确选择图片得到的是临时路径，需主动 `saveFile` 才能跨启动访问，且 `saveFile` 会移动原临时文件；见 https://uniapp.dcloud.net.cn/api/media/file 和 https://uniapp.dcloud.net.cn/api/file/file 。旧记录是否已保存应由来源/文件 API 验证或保存新的可恢复副本，不能依据 scheme 猜测。需增加 `wxfile://` 临时来源在断电/重启后的实际页验证，防止已确认清单只留下失效原件路径。

合成验证 `node /tmp/momcare-b3a-review-extra.cjs wxfile-temp-durable` 以 `wxfile://first/second` 表示未保存的旧本机来源，在二进制上传入口要求先出现持久路径且已落盘；当前 exit 1，首张仍以原 `wxfile://first` 直接上传。此探针验证的是“前缀不是持久性证明”这一风险分支，不声称所有 `wxfile://` 路径都是临时路径；实现应按来源/文件状态区分，无法证明持久时阻断并给用户重选/恢复入口。

ZCode 对上述两个新探针的首轮修复后，`intent-marker-disk-fail`、`failed-page-reselect`、`temp-copy-switch` 当前均 exit 0；但缺失原件分支还有独立复现：`node /tmp/momcare-b3a-review-extra.cjs missing-page-reselect` exit 1。旧第二页只有不受信任的 HTTP 路径，迁移标为 `missing=true`，重选新本机副本并明确确认后，`att.missing` 仍保持 true，下一次执行继续报“附件缺失”；页面重选按钮本身还要求 `!att.missing`，真机用户无法触发。重选/取消应完整保存并恢复 missing/remoteUrl/localPath/fileId/uploadId 的前后状态；确认新原件后只解除所替换槽位的缺失，其他页保持原样。

另外两条当前 exit 1 的恢复边界：`recovery-wrong-slot` 在妈妈恢复记录明确属于第二页时，用第一页参数调用 `recoverAttachment` 仍成功，并把第二页新副本路径写到第一页；应先比对 recovery 的 batchId/entityOpId/order 与当前槽位，再允许写清单。`recovery-family-switch` 在同一 memberId 从旧 family 重新确认到新 family 后，`getAttachmentRecovery()` 仍返回旧家庭 recovery；当前缓存 key 只有 env/app/member，读取又只比 memberId，至少需要校验记录中 familyId 与当前可信身份，内存兜底也应绑定完整作用域。两项都可能让原件错配或跨家庭可见，不能凭 runner 57 项绿色接受。

ZCode 本轮生产代码变更后，`missing-page-reselect`、`recovery-wrong-slot`、`recovery-family-switch`、`wxfile-temp-durable` 四个独立单场景在当前非冻结源码上均 exit 0。下一步仍须核对既有持久 `wxfile://` 文件的合法处理、实际页面预览/恢复按钮与永久真实页面测试；不以临时探针通过数接受阶段。

作用域/目标比对必须完整，修复单一 order/family 分支后的两个独立入口仍 exit 1：`recovery-wrong-entity` 创建同批次报告 A/B，妈妈恢复句柄属于 A 的第二页；调用 B 的第二页恢复仍覆盖 B 原件，因为 `recoverAttachment` 只比 order 未比 batchId/entityOpId。`recovery-memory-family-switch` 让恢复元数据写盘失败，落到 memberId 键控内存；同 memberId 改 family 后仍可读旧家庭句柄，因为内存记录未含 familyId 且读取接受 `!mem.familyId`。恢复记录必须带不可缺失的 env/app/family/member 与 batch/entity/order，所有维度精确相等才显示/写入，旧/缺 scope 记录保守隔离。Codex 已向 ZCode 排队修复。

ZCode 追加修复后，上述 `recovery-wrong-entity`、`recovery-memory-family-switch` 及同页 `recovery-card-family-switch` 在当前源码上 exit 0。这里仍是未冻结的单场景观察；须完成真实页面永久测试与 CLOSEOUT 其余条目再统一验收。

临时原件执行路径仍有一处恢复失败分支：`node /tmp/momcare-b3a-review-extra.cjs temp-copy-switch-recovery-fail` exit 1。妈妈的 `tmp://` 原件经 `saveFile` 生成唯一持久副本，期间切爸爸；旧 continuation 正确停止业务请求，但原 scope 的 recovery 写盘也模拟失败。页面忽略 `attRecoveryScope.write()` 的 false，没把新副本放入按完整原 scope 绑定的内存兜底；回妈妈后 `getAttachmentRecovery()` 找不到路径。此时旧 tempFilePath 可能因 saveFile 移动已不可用，必须真实保留句柄并提示仅同进程可恢复。`recoverAttachment` 还用 `!== undefined` 可选式比较 batchId/entityOpId/order，允许缺字段旧记录恢复；恢复句柄必须完整匹配才可改清单。

`node /tmp/momcare-b3a-review-extra.cjs multi-recovery-disk-fail` exit 1：同批次两页分别重选，本机两张新副本都保存成功，每次清单写盘失败；第二次向单个 `b3-migration-recovery` 键写入覆盖了第一张的唯一恢复句柄。批次保持旧路径，第一张新副本无法由页面发现。恢复结构至少按完整 batch/entity/order 容纳多个待恢复句柄，写入/读取/页面展示/成功消费都不能覆盖其他槽位；内存兜底同理。此为原件保全要求，不是新增业务功能。

预览 UI 真实 script setup 补测：`ui-att-class` exit 1（`:class` 收到 `Promise('att-ok')` 而非类名）；`ui-domain-label` 当前 exit 0（孕期资料/产检安排中文标签已补）；`ui-preview-content` exit 1（私人症状标签只显示“1 项”，未展示用户要确认的实际内容；共享备注已部分显示）。`attStatus` 对已确认重选仍返回“待确认”，也应同步真实状态。上述入口已加入独立 runner；页面结构仍需人工审阅。

每页登记后的持久进度缺口有冷启动复现：`node /tmp/momcare-b3a-review-extra.cjs registered-first-cold` exit 1。第一页 `wxfile://` 原件已二进制上传并登记，第二页为已持久路径且上传失败；在执行结果落盘时模拟磁盘满，冷启动本人续传时第一页再次二进制上传（同一原件字节计数 2）。页面只在整个报告 executor 返回后保存首张 `fileId`，中间没有下一次路径持久化时便遗失登记进度。每次登记后应立即保存槽位状态；该保存失败须停止后续副作用，并提供按稳定 uploadId 向服务端对账的恢复路径，不能靠重复发送二进制掩盖。

该探针的失败注入已校正为**第二页上传失败后首次写迁移清单**，不再按第 3 次写入计数。因此合规实现若在第一页登记后立即把 fileId 落盘，该写入发生在第二页失败之前并会成功；随后结果状态写失败，冷启动仍可跳过第一页。本场景无需新增服务端查询接口即可转绿。另应覆盖“第一页登记成功但其 fileId 写盘当场失败”的停止/可恢复语义，不能假称已持久。

确认重选的磁盘失败也不能先删旧元数据：`node /tmp/momcare-b3a-review-extra.cjs confirm-reselect-disk-fail-cancel` exit 1。第二页原是缺失 HTTP 路径，重选副本成功后 `confirmReselect` 在持久写入前删除 `missing` 和 `remoteUrl`；写盘失败只恢复 `needsConfirm`，随后取消也无法恢复原缺失状态/远端引用，内存批次与磁盘不一致。确认/取消应对完整槽位做事务式内存回滚，持久成功后才公布新状态；永久测试包含失败后取消及冷启动。

### 永久页面回归初稿审查（ZCode 编写中）

`tests/phase-b3a-page.regress.cjs` 开始抽取真实页面 script setup 并接真实 handler，方向正确，但初稿断言仍无法证明声称的范围：页面1 用 `localBytes || cloudBytes` 回退后只 `assert.ok(cloudBytes)`，没有对不同 PNG 做字节等值/页序比对；页面2 在应阻止提交的标记写盘失败用例中允许实体 `done`；页面5标题含“不同实体/批次”却只试错误页序；页面6仅在同一 bundle/会话把 `mig.batch=null` 后调用 loadBatch，不是冷启动重新确认；页面7没有创建恢复记录，`!rec || ...` 可以因空值直接通过。测试可隔离每个场景的页面/store 实例或独立进程，不能让前例状态污染后例。隐私页真实处理器也尚未纳入。Codex 已将此审查反馈交给 ZCode；文件仍在修改，最终以稳定版本复核。

本轮独立 runner 已扩为 73 入口，原始退出码 1；源码前后 hash 稳定，结果 67/73。失败六项为 `temp-copy-switch-recovery-fail`、`ui-att-class`、`ui-preview-content`、`multi-recovery-disk-fail`、`registered-first-cold`、`confirm-reselect-disk-fail-cancel`。其余 67 仅代表对应窄场景通过，永久测试的上述宽松断言仍须修复。日志与 hash 见 `/tmp/momcare-b3a-review-results.json`；B3a 仍未接受。

同一附件保存路径的“会话未切换、清单持续写盘失败”也会孤儿化：`node /tmp/momcare-b3a-review-extra.cjs temp-manifest-disk-fail` exit 1。临时原件已被 `saveFile` 移到本机持久副本，`persistBatchNow` 失败后页面停止网络，随后结果清单写盘也失败；妈妈批次仍只有旧 `tmp://` 路径，`getAttachmentRecovery()` 为空。应在第一次清单失败时就保存原 scope 的 recovery，磁盘不可写则留可见的内存句柄并明确重启风险，不等第二次写盘碰运气。此项已纳入 runner，当前共 74 入口。

上述六项及 `temp-manifest-disk-fail` 在 ZCode 最新非冻结实现上单独复测已转绿，但追加式 recovery 仍有两个数据保全边界，runner 扩至 76：

- `multi-recovery-memory-fail` exit 1：两张新原件各自持久保存，清单和恢复元数据写盘都失败；内存兜底仍按 memberId 存单对象，第二页覆盖第一页，调用第一页恢复失败。内存应按完整 scope+batch/entity/order 容纳多条，并逐项选择/消费。
- `recovery-corrupt-preserve` exit 1：原 recovery 键含损坏 JSON 原始字节，新原件保存后 `openRecoveryScope.read()` 捕获解析异常返回 null，追加逻辑把它当空列表并覆盖原损坏字节。必须区分不存在与不可读；原字节保留，新原件进独立受限恢复或内存兜底，页面如实提示。不能以写新记录销毁旧恢复材料。

### rev12 追加验收边界（仍未接受）

ZCode 对多页内存兜底和损坏 JSON 保留已作修改；其本轮 76 项探针曾全部通过。Codex 增加一个不同于「两页各恢复一次」的字节级场景：`node /tmp/momcare-b3a-same-slot-audit.cjs same-slot-latest`。当清单与恢复元数据均无法写盘，同一 batch/entity/order 连续重选两张不同原件，页面显示最后一张，但旧 `recoverAttachment()` 从内存列表 `.find()` 取第一张，独立探针 exit 1。ZCode 已进一步按目标去重，单场景转绿；需要冻结后复核所有入口，并让真实页面列出每一待恢复槽位，恢复成功仅消费命中项。

隐私页另有真实初始化缺口：`node /tmp/momcare-b3a-privacy-transition-audit.cjs confirm-after-open` exit 1。页面以未确认身份挂载后，用户在同页完成正式确认，watch 只更新 `dataSource`，`familyStore.pullAll()` 只在初次 setup 且已确认时调用，因此没有任何云端概览请求，却可能显示 0 条和「正常」。`pullAll()` 也不包含报告/产检/待产包。需真实页面 handler 回归及状态文案修正：未取全量时不能宣称完整同步，切换后按新 epoch 刷新所需领域或明确仅展示本机缓存。当前 reviewer runner 扩到 78 项，最终结果以源码及测试稳定后的原退出码为准。

每页登记成功后写进度失败不能继续下一页：`node /tmp/momcare-b3a-register-stop-audit.cjs register-persist-stop` exit 1。第一页经受控协议登记，第一次持久化 `fileId` 时模拟磁盘满；第二页是已持久的 `store://` 原件。页面 executor 在失败分支设 `attFailed` 后 `continue`，结果第二页仍发送二进制并登记，云端产生第二次副作用而本机批次没有可靠进度。期望首次登记进度无法持久时立即停止后续发送，保留原件与稳定上传意图并给出真实待恢复状态。已加入 reviewer runner，现共 79 项；ZCode 修复后需复跑冻结哈希。

现有 CLOSEOUT 第 56 行的「来源变化后仍可达」还未落地：`node /tmp/momcare-b3a-source-repreview-audit.cjs source-changed-repreview` exit 1。已确认一条待产包迁移后本机旧源改变，执行正确停止，但再扫描并确认新内容被 `batch-in-progress` 永久阻挡。必须先在原 env/app/family/member 作用域持久归档旧批次及附件/恢复信息、核验成功，再允许重建确认；归档失败保留旧批次，已可能发送的旧意图先对账。否则「不覆盖旧批次」会变成用户无恢复操作的死锁。现 reviewer runner 共 80 项，仍未冻结验收。

## 2026-09-20 B3a 本地代码验收

**结论：B3a 在冻结源码下通过本地代码 review。** 之前各轮 FAIL 记录保留作为故障历史，不再代表当前版本。测试 ZCode 只维护永久回归，编码 ZCode 只改生产代码；Codex 独立核对真实页面处理器、存储写序、作用域和原始退出码。尚未部署 CloudBase，未接触真实旧数据，未做微信真机或两台手机验收。

- 归档损坏原文不覆写、第 21 条历史不静默丢弃、归档列表同页可见、跨成员/同成员跨家庭隔离、恢复写入逐点故障注入及冷启动保全：`tests/phase-b3a-archive.regress.cjs` 8/8 exit 0。
- 隐私页健康/报告双域拉取与失败状态、旧身份在途响应、同成员换家庭、旧健康调用占用超过 2.1 秒、新挂载旧报告时间戳下的缓存计数：`tests/phase-b3a-privacy-reports.regress.cjs` 7/7 exit 0。附件逐页真处理器与恢复：`tests/phase-b3a-page.regress.cjs` 18/18 exit 0。
- A 72/72、B1 42/42、B2a 42/42、B2b1 53/53、B2b2 33/33、B3a store 11/11，九套永久回归合计 286/286，各命令原退出码均为 0。原样 `python3 /tmp/momcare-b3a-review-runner.py` 80/80，`source stable True`；H5 与 mp-weixin 构建 exit 0，`git diff --check` exit 0。
- `/tmp/zcode-b3a-test-logs/frozen-before-hashes.txt` 与 `frozen-after-hashes.txt` 逐字节相同；Codex 再次读取工作区的 12 个生产/测试文件 SHA256 与冻结表完全一致。冻结运行日志为 `/tmp/zcode-b3a-test-logs/frozen-*.log`，独立 runner JSON 为 `/tmp/momcare-b3a-review-results.json`。

平台边界：以上使用合成数据与本地 CloudBase handler 模拟，不证明真实云安全规则、微信文件 API、真机容量或真实旧数据迁移。隐私页 60 秒极端等待安全阀已有显式重试入口，但该 60 秒分支未作永久用例；单条兼容恢复 getter 由同一响应式版本驱动，页面实际使用的逐槽列表已回归。两项不影响上述 B3a 本地范围结论，部署前仍须按 `DELIVERY_STATUS.md` 验证真实环境。
