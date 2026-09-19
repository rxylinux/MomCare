# B2b1 独立 review

基线：已验收并推送的 B2a `fa83f76`。状态：B2b1 已完成 Codex 本地独立验收。只用合成数据/本地 SDK 替身，不部署。

## 最终结论：本地验收通过

ZCode 实现业务代码与永久回归，Codex 对真实 handler、store、SFC 处理器分别复现并复验。本文记录的阻断均已关闭；原 B2b1 产检/待产包范围完成，可以按授权提交推送。此结论只覆盖本地实现与合成 SDK/身份测试，**尚未部署，未验证真实微信/CloudBase/双手机行为**。

冻结后的独立验证：

- `node tests/phase-b2b1.regress.cjs`：53/53。
- B2a 42/42、B1 42/42、A 72/72，共209项实际通过；B1保留既有10项历史编辑器SKIP，正式权威路径由新套件覆盖。A R3.5只注入新增三态依赖走历史分支，原失败/还原断言保留。
- `npm run build:h5`、`npm run build:mp-weixin` 均退出0。仍有既有 Sass API、循环分块与小程序 h2 选择器警告，留 D 发布准备处理；不以构建成功替代真机验收。
- 12组独立入口全部退出0：服务17组、store9组、待产包页5组、产检页7组（UTC/上海/洛杉矶分别运行）、三页冷启动、真实清单落盘后未全入队的崩溃恢复、批次中途切成员、未绑定变量审计。页探针连接同 bundle 的真实 store/session/adapter 与真实 handler，不以静态关键词或仅导入代替。
- `git diff HEAD --check`通过（含新增文件）；下列9个实现/测试/部署元数据文件在完整验证前后SHA256一致。ZCode交接所列8个文件（含覆盖矩阵）另行逐一匹配。

本地证据日志为 `/tmp/momcare-b2b1-final-gate-{0..7}.log`，独立探针汇总为 `/tmp/momcare-b2b1-final-gate-6.log`；源码哈希为 `/tmp/momcare-b2b1-frozen-hashes.json`。可长期复跑的仓库入口是上述4套回归，下面保留详细复现步骤用于独立复核。

本阶段已接通共享产检、检查项与状态、共同安排字段、待产包字段/分类/进度、明确模板生成、改期预览确认与恢复、冲突处理、三页领域刷新。报告附件留B2b2；历史数据来源确认留B3；共同任务留C；其他“我的”摘要与误导入口在D总体验证中逐项核对。AI继续未启用，旧数据不自动迁入。

### 冻结文件 SHA256

| 文件 | SHA256 |
| --- | --- |
| `cloud/DEPLOY.md` | `25ca0c588ecf2fd9289ebf32262b583a6f5b3a7fd3a93f094dec0392cc3ff571` |
| `cloud/collections.json` | `8671c5c0a71705bdbe6bd2189e0545713635ca70f5e8e0c2d5601f0b913e9957` |
| `cloud/functions/mc-schedule/index.js` | `4c353b04c897fb7e36654480982f4d5a42cff01e7f0034701cca7dad08cf133c` |
| `pages/profile/checkup-reminder.vue` | `4b3b6edf9227f7420e00ff00b5a91ed647b2f95c6c347197fc61714982991a72` |
| `pages/profile/hospital-bag.vue` | `da11b942b2523faa328bb21e5178231ff523b1666a7d753a37d3aff73e0e024e` |
| `pages/profile/index.vue` | `ec169d81a796dbff77337484b8a96898a8b2342593d2bc78b80cc57e2d3afff1` |
| `services/familyStore.js` | `8d78e9b61737c75c9e1ec6a505e99c97aac7e1c9b40e3996572a2c3994dabab2` |
| `tests/phase-a.regress.cjs` | `fa1bb6a73c4953d1ac4404953f7400f6742fe7ece3c682323d702a0704ae4f67` |
| `tests/phase-b2b1.regress.cjs` | `449b16067f7a43f4cc6ff3c7859cb1372da80768689d683e75d9d313d45fd2fa` |

## 历史复现与修复轨迹

以下旧段落保留当时的失败事实，最终状态以上述验收结论为准。

## 首版云函数早期复现

为避免页面依赖有误的服务契约，Codex 对已经写出的真实 `mc-schedule` 入口运行 `/tmp/momcare-b2b1-server-audit.cjs`，7 项均失败（退出 1）：

1. **创建结果缺稳定 ID**：bag.upsert(id=bag-probe) 成功，但 record.id=undefined；产检同样由未含 id 的 merged 生成响应。服务端实际文档主键和客户端权威结果必须一致，创建返回值不能等下一次全量拉取才能识别。
2. **同时间待产包分页丢失**：45 条同 createdAt 合成条目，limit=20 遍历只返回 20 条。当前 bag.list 按 createdAt 单字段游标，普通 upsert 甚至未写 createdAt。采用稳定唯一键或复合唯一游标，覆盖普通、模板和墓碑。
3. **同时初始化模板重复**：Promise.all 两个 bag.initialize、同 templateKey，落了 2 条。where 查重后随机 ID 写入不具原子性；唯一约束要由确定性主键/事务等真实保障，不能只靠客户端按钮禁用。checkup.initialize 同类路径也须修复。已删模板仍保留唯一占位，不自动复活。
4. **勾选丢响应重试被误判冲突**：checkup.toggle-item 第一次 revision1 成功到2，同 operationId/原请求重放返回 revision-conflict。该分支写 operations 却从不先读幂等记录；migrate-apply 同类代码也须核对。重放不能再次翻转，也不能让已完成操作滞留为伪冲突。
5. **迁移日历错算**：oldLmpDate=2026-01-31、newLmpDate=2026-02-01，shiftDays=-2，应为1。Date.UTC 月份参数从0开始，当前直接传 YYYY-MM-DD 的月份。必须验证真实日期、月末/闰年、迁移绝对日期，不只验证非空返回。
6. **部分编辑重置完成状态**：创建 completed 产检后，只改 hospital（不传 status），结果 status=pending。未提交字段需保留，显式状态操作另外处理；手动日期修改也须可靠退出自动改期资格，而非以当前日期推断从未手动修改。
7. **按 ID 读取不校验家庭**：预置 other-family 文档后，当前家庭直接 checkup.get 返回全文。即使目前仅一个家庭，服务端也须以可信 familyId 约束每一次 get/transaction/toggle/migration；不能依赖随机 ID 不会撞上旧/隔离数据。读/列表/所有变更分支还需统一已有 schema 保护。

修复后同一探针复跑，补入长期回归；以上是实测服务行为，不依赖页面尚未完成。服务端白名单/真实日期/时间/布尔值/项目唯一 ID 也应严格校验，不以截断和 Boolean 强转伪装合法输入。初始化和日期迁移的持久 outbox/部分成功恢复仍按原 spec 完成，不能绕开已验收协议。

同一探针已扩为 11 个断言组，新增 4 组核对上述第 5–7 条的其他实际分支：未知 schema 的 get/list、外家庭 toggle/migrate 写入、非法日期/时间/重复 itemId、手动改日期后的迁移资格。首版均失败。它们是原要求的覆盖扩展，避免只修单个入口后宣布同类问题全部解决。

## 初轮修复中的模板/重放复验

探针扩为 13 组。稳定主键修复虽让并发计数为 1，但交错执行仍失败：挂起初始化 A 的空记录读取 → 初始化 B 完成 → 用户把 quantity 改为9/revision2 → 恢复 A，最终被覆盖回 quantity1/revision1。**确定性主键加普通 set 不是创建时的原子保护**；模板创建必须在事务中“存在即保留”，事务冲突可重试，不能覆盖任何已存在记录或墓碑。

日期迁移新增重放读取后，同 operationId 和实体 ID 换一个 newDateKey 仍返回成功。必须比较原请求摘要；同请求返回当前权威结果（含后来的删除/修改），不同请求返回 operation-id-conflict。不能只判断 operations 文档存在就无条件返回历史成功。

修复过程还出现 checkup.upsert 运行时 `existing is not defined`，需用真实创建路径覆盖，不能只检查语法。以上均未验收，待稳定后整体复跑。

## 服务端 → 真实 store 贯通后发现的同类遗漏

初始 13 组服务探针已通过；这只是对应断言的局部证据。`/tmp/momcare-b2b1-client-audit.cjs` 直接打包真实 familyStore/session/adapter/outbox 并连接真实 handler：bag 创建/拉取、混合 health+bag 队列路由、bag 冲突与断网采用云端均通过；**项目勾选虽云端成功，实际 store 仍 done=false**。首次 toggle 返回 record.id=''，applyServerRecord 无法定位。原第1条的 ID 修复必须覆盖 toggle、迁移和模板等全部结果生成分支，不能只修通用 upsert。

服务探针扩大到 15 组，对第4/7条补验后仍有两处遗漏：通用 bag.upsert 接受外家庭现有文档并覆盖；toggle 同 operationId 换 itemId 仍无条件返回成功。通用事务/删除/重放也必须校验家庭和请求摘要，不能仅 get、toggle 初次写、migrate 中局部加 guard。修复不能降低已有用例或跳过新分支。

## 待产包初稿页面实际处理器复现

`/tmp/momcare-b2b1-bag-page-audit.cjs` 装载真实 hospital-bag SFC（同 bundle 的 session/config/adapter/store，直接连接真实 handler），3 项失败：

- 实际新增输入绑定 newItemText/newItemCategory，但 addItem 正式分支读不存在的 newItem，点击立即 ReferenceError。
- 正式 items 映射产生 name，既有模板仍读 item.text，名称为空。
- doDelete 仍只试图从 computed 展示数组 splice，没有调用 deleteBagItem；真实 handler 未写墓碑，刷新会重新出现。旧演示逻辑不能作为正式删除实现。

`/tmp/momcare-b2b1-unbound-audit.cjs` 同时发现 saveItems 未定义（retrySave）与 newItem 未定义。补齐本轮已约定数量/位置/负责人编辑、模板入口、日期迁移与冲突/待同步界面后，再统一用实际 SFC 行为验证；这些当前仍在实施，不以构建绿色替代。

产检页亦已补实际探针 `/tmp/momcare-b2b1-checkup-page-audit.cjs`：注入已通过真实 store→handler 创建的合成产检后，nextCheckup 仍为空，实际勾选/完成按钮均未更新权威记录。当前只增加了 imports，computed 与处理器仍全部调用旧 healthStore。需检查脚本替换是否被新 import 的 familyStore 字符串提前误判“已经接入”；不允许以 imports 存在判定页面已完成。

## 冻结前范围复核：仍缺的原方案功能

待产包基础新增/展示/删除 3 组实际探针通过；产检页 3 组仍失败。当前不能据“所有页面审核通过”冻结。除修已知探针，还必须逐条完成原 B2b1 spec：

- 产检实际列表/勾选/完成/跳过/历史接正式源，并有日期、时间、医院、陪同、材料、问题编辑及稳定项目 ID；编辑打开捕获旧 revision。
- 待产包数量、位置、负责人当前仅在映射对象中存在，实际表单/显示/编辑尚无入口；新增数量仍写死1。分类定义需与服务器一致（页面 doc vs 服务 documents，going 也不能成为不可见分类）。
- 明确生成产检安排/待产包模板的实际按钮，走持久可恢复操作；当前页面没有 initialize 调用。
- 孕期日期变化后的实际改期预览/确认/部分失败继续处理，保留已完成/跳过/手动记录；当前页面/store 无 migrate 路由。
- 两页可见的待同步状态、重试、冲突比较与采用云端/确认重提；仅弹“刷新后重试”不算有解决冲突的入口。
- onShow 返回/前台刷新、每领域完整同步时间、首页/我的相关摘要同源。不得只增加 imports 或把 fields 放到对象中就算接入。

这里列的是原方案缺项，未新增范围。服务 15 组、store 4 组、bag 基础页 3 组的局部通过不能替代整阶段验收。需要先列实施覆盖矩阵，再把每项实际入口、处理器和验证证据补齐；不提交/部署。

待产包实际页追加第4组：同一新增表单网络失败后再次点击重试，恢复网络 flushAll 后创建了2个同内容条目。原因是每次 addItem 都生成新实体 ID，而第一次失败请求已经在 outbox 中。新建草稿的稳定 ID/操作状态须保留到成功或显式放弃；“已排队”与“本机根本未保存”要区分，重试不能重新创建实体。用户明确开始另一个同名条目仍可分配新 ID。该项属于既定持久重试协议，不能靠禁用所有失败后的操作掩盖。

真实 store 探针追加第5组：两端都从未勾选状态意图勾选同一项目，对端先提交为 done=true；本端旧 revision 冲突后“确认重提”，服务器再次 toggle，实际变成 done=false。待办必须持久化用户原本要设置的目标布尔值与 itemId，服务端按目标值更新；重试/解决冲突不能把原本的“勾选”变成“取消勾选”。保留旧 revision 检测及原请求摘要。当前真实 store→handler 复现失败，不是 UI 文案问题。

## 实际产检点击与稳定身份

`/tmp/momcare-b2b1-checkup-page-audit.cjs` 扩为4组，前3组通过，第4组失败：实际模板仍 `handleToggleItem(idx)`，处理器从当前 nextCheckup 按下标取项目。捕获显示为 A 的第0行实际点击表达式后，对端把顺序 A,B 改为 B,A 并拉取，再执行原行点击，结果 B 被勾选、A 未勾选。原 spec 要求稳定 itemId；模板与处理器都需传递用户点击时的稳定项目/记录身份，不能在处理时按新数组下标重新定位。修复后独立探针应按真实新模板表达式调用，不强制旧下标签名。该项为原范围内行为缺陷，尚未验收。

## 新改期协议：普通同步误清改期提示

新写的 store 经真实探针复验，原5组通过，新增第6组失败：scheduleLmpKey=2026-01-31、当前 lmpDate=2026-02-01，未预览/未确认任何改期，普通 flushAll 就把 scheduleLmpKey 推进到02-01、消除了 lmpMigrationInfo。`maybeAdvanceScheduleLmp` 只判断当前没有 checkup-migrate 待办，不区分“未开始”与“已确认且整批全部成功”；逐条 enqueue/submit 的第一条成功也可能过早推进，后续落盘失败无队列时亦不能算完成。需持久化明确的迁移批次/完整目标清单与确认状态，在全部预期单项落定后推进；普通同步不得认可未确认的日期迁移。首拉直接以当前 LMP 初始化基线同样不能证明旧云端模板按当前 LMP 生成，多端/冷启动需来源明确的服务端或记录级基线。原范围要求的确认与部分恢复不可用“队列空”替代。

待产包草稿重试复验（实际页探针扩为5组）：稳定实体 ID 已避免云端创建2条，但同一未改变草稿离线点两次，会生成两个不同 operationId、expectedRevision0 的请求；联网 flush 后第1个成功、第2个变为伪冲突并永远留在冲突区。本次断言同时要求云端只有1条、同一未改变草稿没有遗留伪冲突，仍失败。未改变草稿应重试原持久请求（同 opId/内容），用户更改草稿后是新意图，不能静默覆盖已发送请求。新增编辑器真实字段与旧 revision 冲突测试通过，其他已有3组通过。

服务端实际探针扩为16组（前15通过，第16失败）：初始化两条模板 → 预览 LMP 06-01→06-02 → 只成功改第1条 → 同一日期变更再次预览，第1条被再次列入并再推迟1天。初始化不存 templateDate/生成基线，预览 fallback 当前 dateKey 再加 shift，导致部分恢复重复偏移。模板需持久可信的来源日期/来源 LMP 或绝对偏移，预览对同一目标必须幂等，同时支持连续多次 LMP 修改；不能只给当前页保存本地标志绕过真实服务端预览问题。

## 新编辑器真实保存值与显示不一致

产检实际页探针第5组：编辑日期09-22、时间16:45、医院/陪同/材料/问题，真实云端保存时间与字段成功，但 `infoDate` 显示“下午14:00”。famCheckupToLegacy 丢了精确时间，只留 morning/afternoon，旧 infoDate 又硬编码09:30/14:00，可能让用户按错误时间赴约。须展示真实可选 HH:mm，未设置就不编造。新页面仍有 infoHospital 回落旧 healthStore.userInfo.hospital、bag daysUntilDue 读取旧 healthStore 的路径，应按正式/演示/未确认三态接权威数据，不能将历史内容混入正式页。产检倒计时/逾期日期仍直接 new Date 且 computed 无时钟依赖，应复用 B2a 已验收的上海日号和响应式时钟；下一次记录不变也应跨日更新。

## 三页冷启动先确认身份后不拉取

新增 `/tmp/momcare-b2b1-cold-pages-audit.cjs <页面路径>`，实际 bundle 的页面/store/session/adapter 接真实 handler，云端预置合成 bag/checkup；页面初始未确认 → 执行 onShow → 身份确认成功 → 等待 Vue watcher。待产包、产检、我的三页均失败：dataSource 变 family，但领域列表仍空，未拉取现有云端记录。当前只在 setup 的即时 if 或 onShow 当下判断 family，session watcher 只改 dataSource，错过异步确认后的拉取；我的还无 onShow 刷新。应沿用 B2a 首页/趋势页的去重身份确认与确认后刷新协调，覆盖冷启动、前台重确认、换成员、拒绝与迟到回调，不能要求用户返回再进入才显示真实数据。正式可见态须同时排除 confirming。

改期批次首修复验：普通 flush 误推进已修，第6组通过；真实 store 新第7组“两条模板确认改期”仍失败，异常 `Cannot read properties of null (reading 'ids')`。applyCheckupMigration 仍在循环内逐个填 batch.ids；第1个 submit 成功的 flushEntry 就 settle + advance 清空 batch，第2项访问 null.ids。完整 manifest 必须在任何单项网络请求前收齐并成功持久化（失败不发请求），目标/版本也要保存而不只 IDs；全部既定项完成后才能清空。不要仅移除其中一个 advance 调用而留下中断恢复丢后续项。

产检页第6组补实测跨日：TZ=UTC，预约09-22，生产响应式 healthStore.today 设上海09-21深夜，daysUntil 应为1实际仍3；推进上海午夜后未能按时钟更新。与上面的 new Date/无响应式依赖静态发现一致，应按日号而非瞬时时差计算，预约记录不变也随 App 的 refreshToday 更新。

两条改期崩溃已通过复验（store前8组通过），但清单落盘保护仍未实现：新增第9组仅令 b2a-snapshot 写入抛错（outbox 写入仍可成功），applyCheckupMigration 仍发送两次 migrate-apply 并修改了云端。persistSnapshot 吞掉 setMemberCache 的 false 返回、调用方也不检查。既然清单承担尚未入队项的恢复保障，其写入结果必须作为发网络的门槛；失败保留输入、明确返回失败且不发迁移请求。使用独立持久清单/预先原子入队亦可，但不可假设调用 persistSnapshot 就成功。需补永久存储故障回归。

改期第7组继续核对客户端权威结果（不是只看云端）：两条云端日期已成功更新，但 store 中仍显示旧日期。migrate-apply 的 snapshot 仍 `viewCheckup(setData)`，剥掉 _id 后没有 fallback op.id，返回 record.id=''，applyServerRecord 无法定位。原第1条的稳定 ID 要求仍漏了迁移分支。需补迁移响应 id/store 立即更新断言；重放响应同时含 currentRecord 时客户端必须优先采用当前版本/墓碑，不能重新应用历史 resultSnapshot。

迁移清单还需核对“批次已保存但部分项尚未入队时应用退出”的恢复：恢复后不仅能读出 items，要能把未完成且未入队项按原目标/版本恢复到持久待办（或提供明确恢复入口）。仅 flush 当前 outbox 无法处理这一窗口；不可通过重做预览悄悄替换原已确认目标和 revision。

已把上述中断窗口做成实际复现 `/tmp/momcare-b2b1-manifest-restart-audit.cjs`：真实 apply 两条改期，在第1项首次网络发送处截取真实磁盘快照（完整 manifest + 第1项 sent）；以全新 bundle/Pinia/session 重启并恢复快照，执行真实 flushAll。第1项恢复成功，第2项仍停留旧日期（失败退出1）。需要从已确认 manifest 恢复尚未入队项，不能只测试“所有项均已离线入队后的重启”。

最新首层修复：store前9组一度通过，真实 manifest 中断恢复也通过。沿实际“失败后点重试”继续第9组，仍失败：同一次清单写入故障持续期间，apply 现在正确停止，但留下内存 migrationBatch；随后 flushAll→recoverMigrationBatch 不重新确保清单已持久化，绕过门槛发送两次改期。第9组已增加失败后 flushAll，要求持续故障时全部发送为0；恢复路径也必须保证完整清单先成功落盘。

## 确认弹窗期间下一条产检切换导致误跳过

实际产检页第7组失败：下一条是 A → 打开“跳过”确认框 → 对端把 A 标记完成，拉取后 nextCheckup 变 B → 确认原弹窗，B 被跳过。handleSkipCheckup 只打开弹窗，doSkipCheckup 重新读取当前 nextCheckup，没有捕获原实体 ID/revision。与原 spec 稳定身份/编辑基线要求相同，应在打开弹窗时固定 A 与版本，提交后发生版本冲突也不能改成 B。检查同类添加检查项弹窗与勾选绑定的记录身份，不能只保证 itemId 稳定、父记录仍从当前 nextCheckup 重新取。待产包删除已经捕获 target，可参照。

日期显示补验：同一实际页探针在 `TZ=America/Los_Angeles` 运行，dateKey=2026-09-22、time=16:45，infoDate 显示“2026年9月21日（周一）16:45”。倒计时已用上海日号，但 heroDate/heroSub/infoDate/formatHistoryDate 与我的摘要仍将 YYYY-MM-DD 按 UTC 构造后取设备本地年月日，负时区回退一天。日期键应按日历字段直接格式化，星期以对应 UTC 日历算术求得；正式日期文字与已修正的上海倒计时必须一致。新增断言已并入产检页第5组，需以 UTC、Asia/Shanghai 和负时区复跑日期显示。

## 批量循环跨成员继续提交

`/tmp/momcare-b2b1-batch-session-audit.cjs` 实际 store→真实 handler：妈妈确认两项改期 → 第1项服务端成功但响应挂起 → 切换并确认爸爸 → 释放旧响应。第1个 flushEntry 正确返回 stale-session，但 applyCheckupMigration 循环继续，把第2项以爸爸身份发送并改写云端，实测失败1!==0。循环需要捕获开始时 epoch/成员，在每个 await 后与下一次 enqueue/submit 前停止；未完成批次保留原成员名下，不把旧意图放到新成员队列。新增 recoverMigrationBatch 和两个 initialize* 循环同类边界一并核对。现有单请求 epoch 防迟到写回不能替代批量循环的会话绑定，属原 spec 第6条/会话隔离验证。

最终批量入口日期校验复核：服务端第17组，initialize 已拒绝2026-02-31；migrate-apply 仅做 YYYY-MM-DD 正则，仍成功写入不存在的2月31日。应复用 isValidCalendarDate 对每个 newDateKey 校验，非法单项不得改原记录。该项为原服务字段/真实日期验证的遗漏，独立脚本已补入，不扩大业务范围。
