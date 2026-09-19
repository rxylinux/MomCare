# 阶段 B：CloudBase 实施与 Codex 独立 review

基线：`faa5d19838f8b262f9bb50f806b4a40b2b6e5cd3`，已推送 origin/main。阶段 A 本地验收通过。用户已授权阶段 review 通过后由 Codex 提交、推送；ZCode 只负责实现及交接，Codex 负责独立验收和 Git 收口。

状态：B1 R2 的本地代码范围已通过 Codex 独立 review；初稿与 R1 的不通过记录保留如下。真实小程序 AppID、关联 CloudBase 环境 ID、两个成员 OpenID 尚未提供；真实环境验收仍 pending，不能把隔离测试当成已联调。

## 实施节奏

遵循 CLOUDBASE_PLAN.md 第 4.5 节，先交付 B1 小闭环，再扩展 B2 全部业务与 B3 迁移/导出恢复。每部分独立冻结、review、提交，不把本地 mock 通过描述成真云环境验收。

- **B1**：原生云适配、云函数可信身份、一个固定家庭两成员、共享与本人私人记录最小读写、最小 revision/operationId 事务、身份隔离缓存、文件上传/登记/查看闭环及部署配置。
- **B2**：现有健康/产检/待产包/报告页面完整接入、持久 outbox、分页合并/冲突 UI、删除标记；正式路径统一 CloudBase。AI 在真实服务验证前保持未启用。
- **B3**：逐项确认旧数据迁移、私人字段默认隔离、包含附件实体的导出与隔离恢复、迁移映射与一致性验证。

## B1 交付要求

1. 读取现有 PRD / DESIGN / DEVELOPMENT_PLAN_6_FEATURES / CLOUDBASE_PLAN 与 A 交接，保留 A 正确行为。使用明确配置的 AppID/env；缺配置、H5 或云能力不可用时明确未启用，不回退旧 HTTP/游客认证，不声称已连接。
2. 服务端仅从 `wx-server-sdk.getWXContext()` 读取可信 APPID/OPENID；固定家庭与两成员来自服务端配置。拒绝伪造 event.openid/memberId/role/familyId、缺上下文、错误 AppID、第三成员；不允许首两次调用自动认领。身份查询最多返回调用者自身，不泄露白名单。
3. 结构化数据库默认禁止客户端直接读写；服务端按字段白名单校验和按成员过滤，私人内容独立存储，另一成员的列表、单条读取、冲突、错误、日志都不能包含私人正文。首页视角不是权限。不要把 A 的 tokenFingerprint 当成身份凭证。
4. 最小共享数字记录和本人私人记录的真实服务函数；服务端生成归属/操作者，固定家庭上下文，客户端任意 ID 不能跨类型/归属访问。记录 revision 与操作去重结果原子提交；同成员同 operationId 相同请求幂等、不同请求拒绝；并发提交只成功一次。使用实际 SDK 支持的事务 API，不以 mock 的自造行为替代平台能力。
5. 本地缓存按 env/AppID/member/schema 隔离；冷启动身份未确认前不加载旧私有缓存。已验证运行会话可离线暂存；明确拒绝身份立即锁定，旧会话异步响应不得写入新身份。退出与身份切换不显示旧资料，未同步草稿不静默丢失。局部接入期间，不得让旧健康/报告 store 绕过新身份边界；尚未迁移的正式入口应明确禁用，演示仍独立。
6. 文件闭环按已有方案：成员本人暂存、服务端校验实际所有权/路径/类型/大小、复制为客户端不可改写的正式副本后登记、稳定 fileID、重复确认同一记录、授权后读取。不能传任意 fileID 让云函数代下载，不能用客户端文件扩展名作为类型证据。没有可验证规则前，上传保持关闭；不得放宽为公共读写。文档中的具体路径语法/元数据能力必须核对官方 SDK 与规则。
7. 接入真实客户端适配与可到达入口，避免只有孤立服务模块/测试。缺配置页面只说明尚未配置、可使用独立演示；不要求用户输入密钥。可先做必要的小范围页面接入，不扩展多租户或大改视觉布局。
8. 提供可部署云函数依赖锁定、集合/索引、安全规则模板、非密钥配置说明、配置自检和真机 smoke 步骤。不要创建/购买云资源，不操作真实数据或旧云资源；AppID/env 缺失不妨碍完成代码和隔离测试，但真实环境验证保持 pending。

## 最小 review 证据

- 运行真实 handler/adapter/store/page 生产代码，分别模拟妈妈、爸爸、第三成员、缺身份、错误 AppID；不能只测试复制出的权限判断。
- 参数伪造、私人跨成员读取/更新/导出冲突泄露拒绝；缺配置和 H5 明确失败，零旧 Cloudflare 正式调用。
- 同 operationId 并发相同提交、异内容复用、revision 冲突与事务失败回滚；测试桩与 SDK 返回结构逐项对照。
- 冷启动离线不显示私有缓存、当前会话离线草稿可恢复、退出/切换时延迟旧请求不污染新缓存。
- 文件跨成员/任意 fileID/路径越界/非图片拒绝，转存与登记中断后重复确认不重复，不生成假成功。
- A 的历史脚本保持原有意义；若 B 改变旧接口，保留 A 基线测试证据并提供新生产路径回归，不能删除失败用例冒充兼容。最终 H5 与 mp-weixin 构建、源码哈希与未验证清单。

## 官方核对记录

2026-09-19 查阅：

- [微信小程序原生云函数调用](https://docs.cloudbase.net/recipes/add-cloud-function-wechat-miniprogram)：wx.cloud.init/callFunction 与 wx-server-sdk 的可信上下文；区分原生小程序路线和 Web 自定义登录。
- [数据库安全规则](https://cloud.tencent.com/document/product/876/41802)：客户端规则不替代云函数内部授权，集合规则可设 read/write=false。
- [云存储安全规则](https://intl.cloud.tencent.com/zh/document/product/1266/71670)：控制台与服务端具备文件读写能力，客户端规则必须单独配置；不得把默认权限当成私有存储。
- [事务操作](https://docs.cloudbase.net/database/transaction)：服务端事务；示例涉及 node-sdk，实现时须再核对所选 wx-server-sdk 的实际签名、返回和不存在文档行为。
- [安全规则语言](https://docs.cloudbase.net/rule/learn-rules)：云存储有 auth.openid、resource.openid 和不含桶名/前导斜线的 resource.path；支持正则匹配，但 test 结果必须显式 `== true`，JSON 中需双重转义。可据此生成两成员各自暂存目录限定规则；默认仍全拒绝，实际控制台验证后才启用上传开关。不能将永久硬编码关闭、空白规则模板算作文件闭环已实现。

文档示例只是接口参考。身份策略、日志脱敏、数据完整性及本项目更严格的隐私约束以 PRD 和本交接为准，不照搬示例中的全量 event/context 日志。

### SDK 源码核对

Codex 独立从 npm 获取 `wx-server-sdk@4.0.2` 发布包，仅在临时目录阅读源码（未修改项目依赖）。该版依赖 `@cloudbase/node-sdk@3.17.2`。其 `document.get` 包装将普通查询数组/事务单对象统一为 `data: object`；不存在记录默认抛错，显式 `throwOnNotFound:false` 才返回 `data:null`。`runTransaction` 包装继续调用底层事务。`downloadFile` 返回 `fileContent:Buffer`，不是客户端 tempFilePath。实现与测试必须按最终实际锁定的版本核对这些语义；不得以 catch-all 将权限、超时、连接错误当成记录不存在。

## 初稿 review：阻断项（待修复复验）

Codex 在临时 Node VM 加载真实云函数入口，注入隔离数据库/文件 API（不访问真实数据）复现：

1. **版本检查可绕过**：`mc-shared-records` 先以 `expectedRevision:0` 保存 `weightKg:60`，再省略 expectedRevision 保存 61，第二次返回成功、revision=2。私人笔记同样使用可空检查。应强制非负整数版本；创建为 0，缺失/null/类型强转不能绕过冲突保护。
2. **文件登记非原子**：`Promise.all` 两次相同 `registerStaged`（同成员、uploadId、stageFileID），观察到两次 uploadFile、两个不同 fileId/formalFileID，二者均返回成功，最后 set 覆盖登记。须绑定上传操作、稳定正式路径、可恢复中断；同时覆盖同 uploadId 不同文件并发和转存成功/登记失败后的重试。
3. **SDK 与部署契约未闭合**：初稿所有云函数均未调用 cloud.init；组装脚本锁定 2.6.3，未提交该版本的实际契约证据。Codex 在临时目录安装真实 4.0.2（ignore-scripts），未发云请求；直接 cloud.database() 确认报 `Cloud API isn't enabled, please call init first`，init 后正常构建数据库对象。须对最终锁定版本初始化并测试真实组装产物，不以宽松 mock 绕过 SDK 要求。
4. **set 的 data 带 _id 导致真实 SDK 拒绝所有业务写入**：真实 4.0.2 在本地执行 `doc('dummy').set({data:{_id:'dummy',value:1}})`，网络请求前即报 `document.set:fail -501007 invalid parameters. 不能更新_id的值`。初稿共享/私人/文件 set 均携带该字段；需要分开存储 payload 与响应 view，并让测试桩执行同样约束。修复后复测共享通过，但文件最终登记的 `completed = {...doc,...}` 又把 get 返回的 _id 带入 set；仍 transaction-failed。本机隔离复现脚本 `/tmp/momcare-b1-audit.cjs` 可重跑（当前配置皆虚构测试值，无真实 API 调用）。
5. **修复中的快照/文档混用**：getDocMaybe 返回 `{data:doc}`，调用方却访问 `.requestHash/.revision/.stageFileID`。Codex 独立临时审计脚本（实际 handler + 拒绝 data._id 的模拟数据库 + 乐观事务冲突）确认：共享相同请求重放错误返回 operation-id-conflict；文件首次确认与重试错误返回 operation-id-conflict；并发两个请求无一成功。应统一返回 doc 或统一读取 snap.data，再覆盖真实 SDK 形状。
6. **身份会话与草稿边界未成立**：Codex 以 esbuild 打包真实 sessionService/cloudAdapter/config，注入隔离 uni 存储和 wx.cloud 回调，复现以下四项：
   - confirmIdentity 为妈妈后发起延迟私人读取，再 confirmIdentity 为爸爸；epoch 仍为 0，妈妈的迟到响应返回 ok=true。确认开始/结果更换身份必须使旧请求失效，不能只依赖显式 endSession。
   - familyCall 收到明确 not-family-member 后，状态仍 confirmed，可继续读取缓存。业务函数的身份拒绝同样必须锁定并使旧请求失效。
   - 已确认会话的身份刷新遇到临时离线，就被永久置 rejected；不符合已验证运行会话可离线暂存的要求。需区分可信身份拒绝与暂时网络不可用，同时冷启动离线仍不放行缓存。
   - endSession 后 pendingDrafts('mama') 仍返回私人草稿正文；stashDraft/pendingDrafts/clearDraft 均任意接受 memberId。生产草稿 API 必须验证当前已确认成员并按会话隔离，不能仅依靠调用者自觉。
   - **补充复验仍失败**：首次确认妈妈 → 启动第二次 confirmIdentity 但暂缓返回 → 此时状态仍 confirmed/mama，可发起 familyCall → 第二次确认返回爸爸 → 再返回业务请求；该请求与爸爸共享同一 epoch=2，仍返回 ok=true。确认进行中必须限制业务请求/缓存访问，或在确认完成时再次使旧成员请求失效；短暂网络失败恢复原已验证会话须单独处理。
   - **页面复验仍泄漏旧身份内容**：实际页面 privateInput 置 `MAMA_PRIVATE_CANARY`，随后 handleConfirm 的真实云回调返回爸爸，私人 get 返回 `PAPA_NOTE`；执行完成后页面 session.memberId=papa，但 privateInput 仍是妈妈的 canary（loadPrivate 只在输入为空时回填）。必须在身份更换/明确拒绝/退出时清理组件敏感内存，并让页面及时响应业务身份拒绝，不仅隔离服务缓存。未同步草稿先按原身份保存，不能保存到新身份。
   - **R2 页面修复后的迟到写入仍串身份（独立实测）**：真实 handleConfirm 确认妈妈 → privateInput 填 canary → handleSavePrivate 挂起 → handleConfirm 确认爸爸并清空视图 → 释放妈妈的保存响应。familyCall 正确返回 stale-session，但页面失败分支仍用闭包 content 执行 stashDraft，最终爸爸命名空间保存了妈妈 canary。所有异步处理器必须捕获操作开始的会话纪元，并在任何后续 UI/缓存/草稿写入前拒绝旧纪元；stale-session/身份拒绝不是可向当前身份保存草稿的网络失败。待保存输入宜在发请求前按原身份持久化，不能仅在迟到失败时补存。
   - handleConfirm 对所有 `!res.ok` 都 clearSensitiveMemory，会在已验证会话的临时离线刷新时清空未持久化输入；临时失败应保留原会话与输入，明确拒绝/退出/成员变化才执行敏感内存清理（原身份草稿仍需先保全）。
   - **R2 补充实测：业务拒绝仍不清屏**：handleSavePrivate 收到 not-family-member 后，服务状态 rejected，但页面 session.status 仍 confirmed，privateInput 仍显示 `PRIVATE_CANARY`。测试必须从普通业务接口触发拒绝，不能只测 handleConfirm 失败。需要让页面观察权威会话状态并立即锁定/清敏感视图；“由确认流程清理”不足，因为这里没有再次确认。
   - **R2 补充实测：预暂存落盘失败仍提示成功**：mergeDraft 返回 false 被保存处理器忽略；隔离存储抛 quota，同时云调用失败时，页面显示“内容已暂存到本机”，而 pendingDrafts()=null。必须检查预暂存返回值，失败时保留输入、明确未保存，不进入会丢失草稿的假成功路径。

客户端后续复验必须包含真实页面加载旧 health/report store 的路径。不能为了保持 A 套件全绿而让旧 store 在未确认身份时加载或显示旧资料；A 历史语义与 B 正式入口覆盖须分别诚实报告。

当前实际入口仍需覆盖：App.onLaunch → healthStore.initializeApp → 正式 _loadStorage；profile 模块加载即 loadCheckupSchedules；report.fetchReports/fetchUnarchivedReports 直接加载旧正式键。仅禁用旧 HTTP 不阻止这些数据展示/写入。profile.confirmLogout 也尚未调用新会话 endSession，必须验证实际退出按钮后云身份失效、旧页面内存清除，同时保留本人未同步草稿。

**R2 实施中独立冷启动实测**：esbuild 打包真实 Pinia health/report/session，在隔离 uni 存储预置正式 YUNTU 键中的虚构 canary；调用 initializeApp + fetchReports，观察 session=unconfirmed，但 nickname=`OLD_PRIVATE_PERSON`、reports=`OLD_PRIVATE_REPORT` 已进入可渲染 store。旧正式本机数据不能被解释为“不是 HTTP，所以继续放行”；这些键无成员归属，B1 必须保留磁盘原件但隔离读取/写入/展示，直到 B3 明确归属迁移。独立演示键正常使用，新的已验证成员缓存另行使用。

旧 HTTP 也不能只逐页禁用：初稿 pages/knowledge/detail.vue 的 request 仍可达，store 内部还有直接同步/上传调用。建议在旧传输入口统一 fail closed 并给出明确停用错误，再按页面优化提示；不要依赖空列表让深链“暂时点不到”。历史 A 传输测试据实标注旧基线，不为保留旧路径而放松新边界。

**集中拦截的补充实测**：R2 的 request() 已关闭，但 reportStore.uploadAndCreateReport 内部直接调用 uni.uploadFile。以真实 store + 隔离 uni 注入执行该导出动作，仍记录一次 workers.dev/api/reports/upload 尝试（未发真实网络）。即使当前页面未使用此导出，仍不能宣称 store 上传被统一停用；该二进制上传通道也需同一个生产关闭门，并补直接 store 动作的零调用断言。

7. **家庭页草稿/冲突处理**：Codex 从真实 Vue script setup 提取处理函数并 esbuild 打包，只替换生命周期/视觉组件，注入隔离存储与云回调；实测版本冲突报 `Cannot read properties of undefined (reading 'currentRevision')`，共享保存成功后原有私人草稿查询返回 null。
   - fail 返回顶层 currentRevision/currentRecord，handleSaveShared 却访问 `res.data.currentRevision`，真实 revision-conflict 将触发 TypeError。
   - 共享保存成功执行整份 clearDraft，而该草稿同时含 privateNote；保存一条体重不能删除仍未同步的私人笔记。私人保存成功也需要只清自己的对应草稿，避免旧草稿之后覆盖新内容。
   - 冲突后 loadShared 会直接改 sharedInput，和“你的输入已保留”提示不符；应分离云端版本与用户输入，给出明确解决路径。
   - loadSharedFromCache 是固定 false 的空实现，页面没有使用成员缓存；不能把服务层缓存函数存在算作真实页面离线恢复已接入。
   - goDemo 对非 tab 的 login 页面执行 switchTab，不是可用的演示入口。使用现有可达演示选择流程，并验证真实页面跳转。

8. **存储规则生成器未按已核对语法实现**：generate-staging-rules.mjs 注释写正则 test，却实际输出 `resource.path =~ "..."` 和 `nil`。上列官方语言来源给的是正则字面量 `.test(resource.path) == true`、`auth != null`，不含这两个替代写法。应按官方支持语法生成，校验/转义 family 参数，测试两成员各自目录、互写拒绝、正式目录拒绝、匿名拒绝；本地语法/边界测试仍不能冒充真实控制台验证。

9. **上传重试重新选图却复用旧 uploadId**：handleUploadImage 每次先 chooseImage，而 lastUploadId 只在成功后清空。若第一次图片 A 已登记但响应丢失，第二次用户选择图片 B，会覆盖相同暂存路径并用 A 的 uploadId 确认；服务端幂等返回 A，却显示 B 的上传“登记完成”。重试必须继续同一待办文件，选择新图须显式新操作，不可换内容复用 ID。待上传状态需绑定当前成员并持久保存 uploadId/staged ID/本地持久文件（CLOUDBASE_PLAN 4.1）；不能只保存临时选图路径或组件内存变量。缓存落盘失败不得显示已暂存。

10. **新用户到达云入口仍依赖进入演示**：当前首页无旧 token 会 redirect 登录页；登录页只有已停用的账号登录/注册和演示按钮，没有家庭空间入口，而云入口仅挂在 profile。须提供新装可直接到达 CloudBase 身份确认的真实路径（例如登录页“进入家庭空间”与独立演示选择）；不能要求用户先开演示来使用正式云数据。移除这条入口上无作用的手机号/密码收集与“稍后启用账号注册”误导。

## 测试契约补充

初版 B1 套件 docApi.get 返回 entry.doc，而 set 保存的 data 故意不含 _id；这样 get 也永远不含 _id，无法覆盖已复现的“展开查询结果再次写入”错误。真实 SDK 的 get 返回文档包含 _id，应由模拟层补回，且 set 仍拒绝 data._id。Codex 独立临时审计已采用此形状。

页面按当天日期取数，测试不得永久硬编码 2026-09-19 作为预置数据键；应固定测试时钟或使用页面实际日期，确保跨天后回归仍有意义。

## R1 交接 review 结论

ZCode 提交了首份 B1 冻结交接，报告 B1 37/37、A 72/72、双端构建通过。**Codex 不予放行 R1**：这些测试不覆盖上面新增复现的页面身份内容残留、实际退出按钮、新用户入口、旧正式缓存与遗留 HTTP 的集中隔离。服务端独立审计的共享/私人/文件五组场景已通过，只能说明这部分局部修复有效，不能据此认定“全部 blocker 修复”。待 ZCode 补充修复与真实路径测试后重新冻结，未提交/推送 B1。

上述问题已通过 ZCode 当前 MomCare 任务送达。初稿不是冻结交付；后续以修复后的实际代码与测试复验。

## R2 最终独立验收（2026-09-19）

**结论：接受 B1 本地代码与部署模板范围，可按用户既有授权提交并推送；不代表已部署或双手机可用。** 业务代码由 ZCode 编写，Codex 完成独立复现、退回修复、代码核对和最终复验。上列 1–10 项在本地验收范围内已关闭；平台行为仍须下一节的真实环境 gate 确认。

| Codex 独立执行 | 结果与边界 |
| --- | --- |
| `node tests/phase-b1.regress.cjs` | 52/52，退出 0；真实组装 handler、服务、store 和页面处理器，隔离模拟网络/存储 |
| `node tests/phase-a.regress.cjs` | 72/72，退出 0；显式开启测试专用旧传输/存储开关的历史兼容模式，不等于当前生产入口 |
| 独立 `/tmp/momcare-b1-audit.cjs` | 5 组通过：可信身份、版本/幂等、私人隔离、文件登记/读取、并发稳定正式路径；严格 `_id` 与事务形状 |
| 独立 `/tmp/momcare-b1-final-client-review.cjs` | 6 项通过：切换清屏、迟到私人保存不串身份、普通业务拒绝锁定、落盘失败如实提示、暖会话离线保留输入、冷启动拒读缓存 |
| 单独打包真实 report store 的上传探针 | `uploadAndCreateReport` 在生产默认配置下 `uni.uploadFile` 调用数为 0；未发真实网络 |
| `npm run build:h5` / `npm run build:mp-weixin` | 两者均退出 0；保留既有 Sass legacy、health/report 循环 chunk、小程序 h2 选择器警告 |
| R2 交接 SHA256 | 39 个文件逐一核对，全部匹配 |
| `git diff --check` | 通过 |
| 本地构建产物浏览器检查 | 新装入口可直接进入家庭页；空配置明确不可用；可返回并进入标注“演示模式”的示例首页 |

独立临时探针是本次审计证据，未纳入产品运行路径；仓库内可持续重跑的是 B1/A 回归套件。测试中的身份、体重、笔记与图片均为合成数据。没有调用真实 CloudBase、旧 Cloudflare、OCR 或 DeepSeek，也没有读取或上传真实产检资料。

旧正式 YUNTU 键保留磁盘原件但禁止旧 store 读取/写入/展示，待 B3 确认归属后迁移；这意味着本阶段不能把旧业务页称为已经完成云迁移。生产旧 HTTP 及二进制上传入口关闭，演示模式独立。文件上传默认关闭，需要下述真实规则验证后启用。

## 下一阶段入口：最小真实环境 gate

先提供小程序 AppID 和关联的 CloudBase 环境 ID（无需密码、AppSecret、API Key）。按 `cloud/DEPLOY.md` 部署配置，客户端同时填写 `utils/cloudConfig.js` 两项及 manifest 的 AppID。新装用户从欢迎页“进入家庭空间（云）”直达；已在演示界面的用户也可从“我的 → 家庭共享（云）”进入。

1. 先仅配服务端 `MC_APPID`，两位成员分别通过“查看我的 OpenID”获取本人身份；管理员在云函数配置中写入固定家庭与两个成员白名单，不将真实 OpenID 写进仓库。
2. 两位成员各自完成可信身份确认；非成员拒绝。验证共享记录双向读取、同版本并发冲突、operationId 重试、私人笔记跨成员不可读；页面刷新使用实际提供的刷新操作。
3. 存储默认全拒绝。使用 `cloud/rules/generate-staging-rules.mjs` 的命令行参数生成本人暂存目录规则，先通过控制台语法校验并验证本人可写、互写拒绝、正式目录拒绝、匿名拒绝。验证完成后才将云函数 `MC_UPLOAD_ENABLED` 设为 `true`；实际检查图片登记、同文件重试、授权临时 URL 与跨成员越界拒绝。
4. 验证真实平台的 SDK 错误结构、事务冲突与失败回滚，再确认双手机离线/恢复/退出行为。若有差异，由 ZCode 修复、Codex 复验后单独提交。

上述 gate 尚未执行。通过后才扩展 B2 完整业务、outbox/冲突处理与 B3 迁移/导出恢复；DeepSeek/OCR 保持未启用。本次验收不包含孕期知识、医学内容或提醒建议的专业准确性审核。
