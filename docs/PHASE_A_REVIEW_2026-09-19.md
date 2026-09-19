# 阶段 A：Codex 独立 review

状态：2026-09-19 最终 R5 交付已独立复验。本轮阶段 A 数据可靠性修复通过本地验收：72 项回归通过，H5 / mp-weixin 构建通过，26 份源码 SHA256 与交接一致，git diff --check 通过。允许以此为阶段 B 实现基线；不代表 CloudBase、两人成员权限、真机或上线验收通过。下方保留各轮历史发现，最终处置见文末。

## 本轮基线

- 项目：`/Users/daijianbo/Documents/marathon/MomCare`，在当前工作区保留已有修改。
- 启动前源码及 SHA256 清单：`/var/folders/1k/6mfcfpgd38bgh4s31fz6wsv00000gn/T/momcare-before-zcode-z5zpaur0`。该临时快照仅用于本轮比较，不承担用户数据备份。
- 独立执行 `node docs/research/2026-09-19-probes.cjs`，退出码 0；10 个历史错误场景全部复现。脚本断言的是旧缺陷，因此退出 0 不能说明产品通过。
- ZCode 交付位置约定为 `docs/ZCODE_PHASE_A_HANDOFF_2026-09-19.md`，交付时冻结源码并提供哈希。

## review 检查范围

| 场景 | 验收关注点 | 状态 |
| --- | --- | --- |
| 请求失败 | 网络失败、业务失败、异常结构均不能返回业务成功 | 已纳入独立复跑回归 |
| AI | 空结果不完成、不扣成功次数；失败后状态可解释 | 已验证模拟结果；真实服务未联调 |
| 存储失败 | Store 和页面调用链都处理失败；弹层保留输入，不提前成功/关闭 | R3/R3.5 回归通过，真机未验证 |
| 正式空档案 | 无游客认证和自动示例数据；旧缓存不删除、不自动认领 | R5 覆盖无标记旧数据、结构版本 2、确认和切换会话；服务端身份属 B |
| 报告同步 | 空云列表保留本地草稿/待同步修改；分类移动数组正确 | 隔离 Store 回归通过；CloudBase 同步属 B |
| 日期和产检 | 跨日更新、预产期比较正确；调整计划不丢已完成项及手动日期 | 已纳入独立复跑回归 |
| 页面说明 | 假同步、假容量、假注销和无依据加密承诺移除 | 已修改，未启用动作明确说明 |
| 构建和回归 | 测试验证真实生产路径；构建成功与真机验证分别报告 | 最终 R5 的 72 项回归和两端构建通过；真机未验证 |

Codex 只审查和记录发现，不修改业务实现。发现问题交回 ZCode 修复；阶段 A 未通过前不展开阶段 B 的全部业务迁移。

## 编码中初步发现（待修复后复验）

以下在 ZCode 第一轮编写中独立执行真实模块、模拟 uni 内存存储复现，不触碰真实用户数据；不是对最终交付的结论。

### P1：模式标记写入失败会把演示数据写进正式档案

在当前 `utils/storage.js` 的 `setDataMode` 吞掉写异常时，`stores/health.js` 的 `enterDemoMode` 继续执行并返回 true。模拟仅 `MOMCARE_DATA_MODE` 写入失败，其余键可写：原正式档案 nickname 为 synthetic-original，调用后正式键中的 nickname 变成幸福准妈妈，历史记录被演示当天记录替换。

要求：模式切换必须先确认成功，失败停止后续重置和写入；数据写入不能依赖一个可能写入失败的全局模式标记而无校验。覆盖进入/退出演示的故障路径，确保正式数据逐字节不变且不显示成功。

### P1：仅有历史报告时漏备份却写完成标记

在模拟存储仅存在 `YUNTU_REPORTS_DATA`、不存在 `YUNTU_HEALTH_DATA` 时，`ensureLegacyBackup()` 返回 null，没有创建任何报告备份，但写入 `LEGACY_BACKUP_MARKER` 表示无历史数据。后续调用因此跳过。

要求：健康与报告独立判断和备份，所有需要备份的内容确认写入成功后才写完成标记；备份失败可见且可重试，不冒充无需备份。

### P1：旧版本无新标志的本地报告仍会被空云列表清掉

真实 report Store 隔离复现：在 YUNTU_REPORTS_DATA 中放入旧格式本地报告（有 _id、archive_status、report_date，无新增 _local/_pendingSync），fetchReports 后为 1 条，模拟成功空云列表并 syncReportsFromCloud 后为 0 条。

要求：首次迁移须保守处理旧记录来源，不能只有新建记录才受到保护；缺失本地标志不等于确认属于已同步云端。明确缺失项策略，空列表不删除无法确认来源的旧记录。

### P1：仅 OCR 文字仍被当作 AI 解读成功并扣次数

真实 Store 隔离复现：分析接口只返回 `{ocr_text: 'synthetic OCR only, no AI analysis'}`，isValidAiResult 为 true，triggerAiPipeline 返回 true，ai_status 为 done，used 为 1。

要求：OCR 成功与 AI 解读成功分开判断；不能用 OCR 文本或任意非空对象证明 AI 解读完成。明确成功结果结构并校验可展示的解读字段；仅 OCR、只有错误对象、畸形指标列表、空解读均不能 done 或扣成功次数。

### 初步修复复验

ZCode 接收上述反馈后，Codex 再次打包当时实际 Store / storage 模块，以隔离 uni 内存存储验证：报告独立备份、旧报告遇空列表保留、OCR-only 不完成且不扣次数、模式标记写失败时正式档案逐字节不变，四个用例均符合预期。代码仍在继续修改，该结果只适用于这些用例；最终冻结版本仍需复验和检查其他调用链。

## 第二批调用链发现（待修复）

### P1：演示模式“清除本机数据”实际删除正式档案

当前 privacy.vue 的 clearLocalData 无条件使用 FORMAL_HEALTH_KEY / FORMAL_REPORTS_KEY，仅在清内存时判断 isDemoMode。独立执行从该 Vue 文件提取的原函数、注入隔离 Map：isDemoMode=true 时返回 true，正式健康和正式报告键均被删除，演示数据仍在。备份存在不代表这一跨模式删除正确。

要求：操作只能针对当前模式；演示页面不得触碰正式数据或列出正式备份。若尚未实现完整恢复与正确清理，可以把该入口标为不可用，不能为清理假按钮而新增有缺陷的真删除。正式清理后还须避免内存中的档案/身份字段再次写回旧内容。

### P1：新保存返回契约未贯穿页面与报告 Store

saveUserProfile 现返回 `{ok:false}` 而非抛出异常，pregnancy-info.vue / edit-profile.vue / onboarding 等调用处必须逐一核实；已观察到 pregnancy-info 的 handleSave 仍直接 await 后显示保存成功、延迟返回。报告 createReport、_applyLocalUpdate、syncReportsFromCloud 等也调用 _persist 而不检查其结果，可在本地写盘失败后返回 id、成功/已同步。

要求：不要仅依赖 try/catch。所有保存/删除/归档/批量操作调用方按明确的 persisted/ok 处理；失败保留输入及持久可见错误，不关闭表单、不标成功。云端操作已成功但本地缓存失败时说明真实状态；saveUserProfile 的产检迁移第二次写入结果也不能忽略。请补生产 Store + 页面调用链回归，而不只测试 _saveStorage 返回 false。

补充实测：令 uni.setStorageSync 抛出存储满错误，createReport 仍返回 `{id, synced:false, pendingSync:false, local:true}`，没有失败标志；仅在 Store 的 lastPersistError 留下错误。调用方不能据此判为已保存。

### P1：产检日期迁移丢失同孕周的第二条历史记录

真实 health Store 隔离复现：checkupSchedules 放入两条 week_of_pregnancy=17、status=completed、不同 _id/日期的历史记录，调用 migrateCheckupSchedulesForNewLmp 后只剩第一条。原因是每个模板用 existing.find 只取一条，而尾部又排除全部属于模板孕周的记录。

要求：按稳定记录身份保留所有历史及手动/自定义安排，不能用“同孕周”当作同一条记录；只更新可确认由模板生成的未完成安排。补同周多次产检、同周历史加新安排的回归，确保数量和原内容不丢失。

### 第二批复验结果

Codex 验证了第二轮 21 份交接哈希，独立运行 45 项回归（退出 0）和两端构建（均退出 0）。另用真实 Store 和从 Vue 文件提取的原处理函数进行隔离验证：演示清理不改变正式档案、同周两次已完成产检均保留、createReport 返回 persisted:false、pregnancy-info/edit-profile 原 handleSave 在存储失败后不返回且提示失败，均符合预期。此验证没有运行微信真机 UI。

## 第三批：批量页面失败分支尚未修完整

### P1：批量保存失败仍清除上传草稿并离开页面

独立执行 pages/archives/batch.vue 原 confirmArchive 函数并调用真实 report Store，uni.setStorageSync 模拟存储满：

- selected=false（全部跳过进入未归档）：仍显示“已跳过所有报告”，pendingUpload 被设为 null，navigateBack 被调用 1 次。
- selected=true（选中报告保存失败）：显示“0 份报告已入档，部分失败”，但同样清空 pendingUpload、batchItemUpdate 并 navigateBack 1 次。

原因：全未选分支完全未检查 createReport.persisted；常规分支虽然设置 hasError，尾部仍无条件清草稿和导航。

要求：只有全部需要保存的条目确认持久化后才清草稿并离开；任一条失败留在页面、保留失败项和图片引用，显示可重试状态。已成功项不要在重试时重复创建。测试必须执行这两个真实页面分支，而不只检查 Store 的 persisted 字段。

另查漏：pages/profile/daily-plan.vue 两个调用 saveRecord 的位置仍不 await、不处理失败，界面勾选后会表现为已完成；请补失败提示/保留待保存状态，并检查其余保存调用点是否仍忽略返回契约。

第三批静态调用链补充：stores/health.js 的 updateCheckupSchedule 仍忽略 _persist，四个产检动作不传递结果；pages/profile/checkup-reminder.vue 的完成/跳过/添加仍无条件成功，勾选不检查失败。chooseAvatar 同样忽略 _persist 并显示头像已更新；components/common/LoginPopup.vue 的 handleConfirm 忽略 saveUserProfile.ok 后关闭弹框并发送 success（组件当前是否可达另需核实）。这些应一起完成调用契约扫描，不能只修两个已点名页面。以上为源码直接可见问题，尚未对每条路径运行故障注入。

第三批编码中复验：新 confirmArchive 已在失败时留页，但 createdId 只记录成功项仍不足。真实 Store 的 createReport 在落盘失败前已插入内存；没有 serverReportId 的一张图片第一次落盘失败、恢复存储后再点保存，报告数从 1 变成 2（不同 rpt ID），随后页面返回。需保留失败项的已创建 ID，并以原 ID 重试持久化/更新，不能再次 create；请补“失败项原本已在 Store 内存”测试，不要只验证成功项被跳过。

### P1：模式标记读取失败时回退正式存储，演示内容污染正式档案

Codex 隔离真实 health Store 复现：先放入 synthetic-real 正式档案，正常 enterDemoMode；之后仅让 getStorageSync('MOMCARE_DATA_MODE') 抛出异常，其余读写正常。调用 saveRecord 返回 `{ok:true,persisted:true}`，正式档案 nickname 被改成“幸福准妈妈”。根因 utils/storage.js getDataMode catch 默认返回 formal，后续 healthStorageKey/reportsStorageKey 选错命名空间。

要求：模式读取出错不能猜测为正式模式并继续读写/清理；明确停止操作并向调用方报告失败。覆盖健康与报告存储、清理等消费者，正式数据逐字节不变。模式键“缺失的新安装”和“读取 API 报错”须区分。

## 阶段 A 计划漏项：旧缓存来源确认边界未实现

实施规划阶段 A 明确要求：旧缓存没有可信所属成员时，不自动上传或归属当前登录者。交接将完整迁移确认列入 B，但不能因此省略 A 的保护边界。

Codex 真实 health Store + 隔离模拟请求复现：放入没有 schemaVersion/owner 的旧健康缓存（nickname=synthetic-legacy-owner）与 synthetic-token；initializeApp 后存储 origin 变成 formal；未作任何用户确认直接 syncProfileToCloud 返回 true，请求中携带了旧 nickname。未发出真实网络请求。

要求：保留 legacy-unverified 来源直到明确确认；普通保存/重启不能升级为可信来源。确认流程完成前阻止该缓存上传或绑定当前身份，并显示待确认原因。完整成员命名空间及迁移 UI 可在 B 实现，但 A 至少须让未确认数据保持隔离、保留备份、关闭迁出通路。覆盖重启、保存、云同步与换 token，不用客户端随意字段冒充可信成员归属。

### R3/R3.5 冻结快照复验

Codex 独立核对交接中 26 项 SHA256，全部匹配；独立执行 59 项回归，退出 0；H5 与 mp-weixin 构建均退出 0。测试已实际执行 batch / daily-plan / checkup-reminder / LoginPopup 的原页面处理函数与真实 Store。日志在 /tmp/momcare-codex-phase-a-r3.log、/tmp/momcare-codex-build-h5-r3.log、/tmp/momcare-codex-build-mp-r3.log。以上是本地隔离验证，不代表真机/真实云环境已验证，且不覆盖后续旧缓存隔离修改。

### R4 独立复验：两条未封闭的来源判断路径

1. **真实旧报告没有新标记，仍可上传**：健康 Store 已 needsLegacyConfirm=true，但只把一条无 _originUnverified / _local 的旧报告放进 YUNTU_REPORTS_DATA，fetchUnarchivedReports 后直接 updateReport，仍发 PUT /api/reports/legacy_report_no_flags，返回 synced:true。新增测试提前手工加了 _originUnverified:true，未覆盖实际旧数据。应在读取/迁移入口识别未确认来源，所有写、删、AI 上传入口统一拦截，不能依赖一次成功下行同步先替它打标。
2. **schemaVersion=2 且 origin=formal 不代表确认过归属**：无 owner 的该缓存（前几版 A 代码就会自动生成）initializeApp 后 needsLegacyConfirm=false，syncProfileToCloud 仍发 PUT。schemaVersion 只是结构版本，origin 是历史代码随手写入，不能作为用户已确认/可信身份依据。应为明确确认动作留下单独记录并绑定所确认身份；换 token 后必须重新隔离。没有可信成员映射前可保持上传关闭，完整身份绑定留待 B。

以上由真实 Store、隔离存储与模拟请求复现，没有访问真实后端。R4 的 schemaVersion 缺失旧健康数据上传已正确阻止，但不能因此判定所有旧缓存通路已关闭。

### R5 编码中回归：隔离中的本地编辑被下行覆盖

新合并规则改为只保留 _pendingSync 后，Codex 复现：读取无标记旧报告 → updateReport 把 notes 改为 new-local-note（因未确认，只保存本地）→ 云返回同 ID 的 older-server-note → syncReportsFromCloud 后新备注被旧云备注覆盖。原因未确认分支保存时仍沿用 false 的 _pendingSync，合并不识别这次用户修改。须为本地实际修改保留独立待处理/脏标记，确认来源与是否修改是两件事；不允许为恢复可信状态丢弃编辑。补真实读取→编辑→同 ID 云拉取的整条用例。

## 最终 R5 独立验收结果

- Codex 独立运行 `node tests/phase-a.regress.cjs`：72 项通过、0 项失败，退出 0。
- 独立运行 `npm run build:h5` 与 `npm run build:mp-weixin`：均退出 0；现有 Sass / 循环 chunk / h2 选择器警告仍存在。
- 与 ZCode 最终交接逐项核对 26 份源码 SHA256：全部一致；`git diff --check` 退出 0。
- 另以临时 esbuild bundle 执行真实 Store，并提取实际 batch 页面函数，独立于 ZCode 测试重新验证：结构版本 2 无归属档案不上传；确认后只允许当前会话，直接换 token 后动作时检查阻止上传；无标记旧报告不上传/不触发 AI；本地编辑遇同 ID 云列表不丢；模式读取异常不写入/清除正式数据；全未选批量保存失败保留草稿、恢复后复用原 ID 且只有一条记录。全部通过。
- 最终日志：`/tmp/momcare-codex-phase-a-final.log`、`/tmp/momcare-codex-build-h5-final.log`、`/tmp/momcare-codex-build-mp-final.log`。所有故障注入都使用隔离模拟存储/网络，无真实健康数据和付费接口。

**范围与后续门槛**：以上验收仅覆盖本轮阶段 A 本地数据可靠性修复。令牌指纹属于临时本地确认标记，不是身份认证、加密或两人权限边界；阶段 B 必须改用 CloudBase 服务端可信身份、成员命名空间及私人/共享权限，不能把该指纹当成安全凭证。完整旧报告迁移/逐项排除、冲突协议、附件持久化、导出恢复、真实 DeepSeek 与 CloudBase 联调、双首页和两台手机验收仍未完成。原 Cloudflare API 地址仍存在，尚未迁移，也未部署。代码由 ZCode 修改，Codex 仅独立审查、验证并维护本文档。
