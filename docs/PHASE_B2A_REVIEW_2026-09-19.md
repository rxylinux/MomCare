# B2a 独立 review

基线：B1 `b97b407`，开发顺序调整 `5567db2`。部署与真机验收统一延后，当前仅验收本地代码、平台契约与隔离测试。ZCode 编码，Codex 独立复现与审核。

状态：实施中，尚未冻结/通过，不能据以下局部证据宣称阶段完成。

## 当前待验收清单（优先看这里）

已局部复验：分页 205 条、outbox 原操作保留/读写失败、存量 schema、真实服务契约、会话清理、重启重放/墓碑、孕期资料基线、计划对象、发请求前 sent 状态落盘、首页返回激活/编辑冲突/断网采用云端，以及体重图表。7 个修改 SFC 的脚本未绑定引用已归零。以下仍需收敛并冻结：

1. 真实页面回归须使用同一 page bundle 的 session/config/adapter/store；只共享磁盘不会使第二个模块的 session 自动变 confirmed。可参考 `/tmp/momcare-b2a-page-path-audit.cjs`、`/tmp/momcare-b2a-pregnancy-form-audit.cjs` 和 `/tmp/momcare-b2a-trend-audit.cjs` 的有效装载方式。必须测试目标结果，不能用 typeof 或允许所有模式的断言代替。
2. 三个趋势页 session 状态要响应确认/退出，prompt/rejected 等不得走旧 store 分支；明确演示仍可用。孕期资料正式保存不先把共享内容写入旧演示 store，未确认页也不自动填历史正式数据。
3. App/首页 foreground 的身份复核、显式演示/退出边界、失败清屏与暖离线语义要一致，不能靠多个 onShow 同时启动竞争确认。新增首页孕周/倒计时不要只用无响应性的 Date.now；统一 Shanghai 日号并验证跨日。
4. 家庭页保留的上传/预览、确认与迟到回调必须保留 B1 身份/epoch 清理保护；原有效 B1 上传用例通过。旧 mc-shared-records/mc-private-notes 的业务写入按 spec 第 5 条关闭或转到新权威源，部署说明不再指导向旧集合写新记录。
5. 冲突界面显示可比较的本地修改和云端版本；退出说明本人待办仍保留并提供返回处理机会。完成 spec 范围自检。
6. 稳定后全量回归、双端构建、交接/哈希与独立复验。不提交、不部署，直到 Codex 明确验收。

## 初稿复现 1：分页丢记录

Codex 以真实 `cloud/functions/mc-health/index.js` 入口、隔离数据库和 205 条合成按日记录执行 `daily.list`（每页 20）。模拟层按已锁定 SDK 的真实查询限制执行未指定 limit 的 `.get()`，结果 **只返回 96 条、96 条唯一记录，应为 205 条**。

- 初稿 `listAllForRange` 先 `collection.get()`，注释称其为全量，再内存切页。但本机只读核对 `@cloudbase/database/dist/commonjs/query.js:63–66`，未指定 limit 时默认发送 `100`，并非全量。应直接按家庭/本人、稳定排序和范围游标做数据库查询，不把首个结果页当完整档案。
- 初稿 nextCursor 指向 `items[startIdx + limit]`（下一页第一条），下次又从该条后一条开始，导致每个分页边界漏一条。游标应与查询边界契约一致，通常使用本页最后一条的稳定排序键。
- 不接受注释“B2b 再换真分页”的延后；B2a 的完整同步时间和趋势已经依赖档案完整性。

复现脚本：本机 `/tmp/momcare-b2a-pagination-audit.cjs`，不访问云环境，退出 1。修复应增加大于 SDK 默认页长的生产入口测试，同时覆盖第二页失败和分页期间更新。

## 初稿复现 2–4：持久 outbox 边界

独立 `/tmp/momcare-b2a-outbox-audit.cjs` 每个用例重新打包真实 outbox/session/adapter/config，使用隔离 uni 存储和云身份回调，三个用例全部失败（退出 1）：

2. **超时后原操作丢失**：enqueue operation-a(weight=60) → markSent → markPendingAgain(timeout) → 同实体再 enqueue operation-b(weight=61)。队列中 operation-a 消失，被 pending 合并分支改写。超时可能已经在云端提交，不能把曾发送条目重新视为“从未发送”；需持久区分 everSent/uncertain，原 ID/内容保持不变，新编辑排在其后。
3. **读取失败导致待办被覆盖**：预置一条已持久待办，再让 getStorageSync 对 outbox 抛错，接着新增另一条；loadForMember 将异常转 []，enqueue 返回 ok=true 并覆盖原队列。读取异常/JSON 损坏不得等同空队列，禁止任何依赖旧队列的修改与网络发送，保留磁盘原件并显示错误。
4. **身份确认在途仍可读取和写入旧队列**：确认妈妈后启动第二次 confirmIdentity 并挂起回调，此时 getOutbox 返回妈妈待办，enqueue 仍成功。`currentMemberId()` 只看 confirmed/member，未限制 confirming；权威会话应暴露当前可访问条件，所有 outbox 操作与缓存统一拒绝确认在途的读写。随后确认爸爸时不得有跨身份副作用。

这些是生产 API 复现，不是静态推测。修复后需由真实 familyStore/页面贯通验证；不能仅在测试中不调用这些错误路径。

## 初稿复现 5：文档 schemaVersion 未落地

真实 mc-health handler + 严格模拟 SDK 独立探针 `/tmp/momcare-b2a-schema-audit.cjs` 两项失败：新建 daily 文档并无 schemaVersion；预置文档 schemaVersion=99/revision=1 后，以客户端 schemaVersion=1/expectedRevision=1 仍可成功覆盖为 revision=2。请求版本校验不等于记录版本保护；须持久版本，并在读取/写入/列表/冲突与重放返回时识别不支持的存量文档，明确升级/迁移提示，不能旧代码继续解释并写入新版本。

## 分页修复局部复验

实施中改成数据库 where + orderBy(dateKey) + limit，并以本页最后 dateKey 为游标后，Codex 重跑同一 205 条脚本，返回 **205 条、205 唯一记录**，退出 0。该局部通过不替代 outbox/schema/页面等剩余项。

## 初稿复现 6：实际客户端与实际服务端契约不通

`/tmp/momcare-b2a-full-path-audit.cjs` 打包真实 familyStore/outbox/session/adapter，并把 wx.cloud 回调直连真实 mc-health handler（只有 SDK 数据库和 uni 磁盘是隔离模拟）。两个基本动作都失败：

- `familyStore.pullAll()` 首个 pregnancy.get 返回 invalid-params，原因是服务端对只读动作也强制 expectedRevision，而客户端不提供。只读动作不应需要变更去重/版本参数；按动作分别校验。
- `familyStore.saveDaily('2026-09-19', {weightKg:60})` 返回“dateKey 非法”；submit 向 enqueue 传 extra.dateKey，但 outbox 参数解构与 entry 持久化丢掉 extra，flushEntry 构造请求没有 dateKey。

最终验收必须使用真实客户端→真实 handler 的贯通测试，不能两端分别 mock 成各自想要的契约而报告功能通过。

## 局部修复复验与 store 问题 7–8

路径纠正后（实现过程中 outbox 曾误写 `/Users/daijianbo/Documents/momCare`，已要求全部回到当前 `marathon/MomCare`），Codex 在当前仓库重跑：outbox 3 项、schema 2 项、实际客户端→实际 handler 2 项均通过。仅表示上述复现已修复；源码尚在变动，需最终冻结复跑。

独立 `/tmp/momcare-b2a-store-audit.cjs` 两项仍失败：

7. `pendingCount` 先读取为 0，再真实 enqueue 后仍为 0（应为 1）。computed 只调用同步 getStorageSync，没有响应式依赖；conflictEntries 同样不能可靠更新。需要 outbox 状态变化具有实际响应式通知，真实页面才能持续显示待同步/冲突；不是调用一次 getter 的静态测试。
8. 真实 familyStore.moods 放入合成私人 canary 后调用权威 `endSession()`，moods 和 moodRecord 仍可读取原内容。store 没有订阅权威会话失效/成员变化，不能依赖某个页面自觉 clearMemory；实际退出、业务拒绝与成员更换均须立即清理已可渲染状态，并拒绝旧回调写回。也需要验证不是只隐藏一页而其他已挂载页仍保留私人数据。

## 初稿复现 9：首页展示仍依赖旧数据源

`/tmp/momcare-b2a-home-audit.cjs` 打包真实首页 script setup，视觉组件与生命周期注册替身，保留实际 computed/Pinia。将页面置 family 模式、familyStore 注入当天 weightKg=60 和有效孕期档案，实际 `currentRecord={}`、旧 healthStore.pregInfoSet=false。模板仍以 healthStore.pregInfoSet 控制整块日历/记录面板/编辑弹层，正式页因而不显示新档案与记录，实际保存路由存在也不构成可用入口。

必须让展示与编辑采用同一正式权威源：孕周、倒计时、昵称、日历、当前健康/本人私人记录、默认表单值和趋势都应贯通；未建档/未确认状态有可操作入口。正式流程不得依赖旧 token、演示档案或旧 healthStore 的数据来打开表单。首页应使用页面重新可见的生命周期处理返回更新，不能仅依赖第一次 mounted。最终用真实页面脚本/组件数据绑定与来源验证，不能只断言源码出现 familyStore。

## 初稿复现 10–11：重启重放与删除保护

`/tmp/momcare-b2a-recovery-audit.cjs` 继续使用真实客户端→真实 handler，基本读写 2 项通过，新增 2 项失败：

10. 先让服务端完成 operationId=sent-crash，再在本机保留同操作 sent 条目（模拟确认响应前进程结束），恢复后 `flushAll()` 不处理 sent 项，队列永远不能完成。必须恢复“曾发送但未确认”的条目，沿用原 ID/内容查询或重放；不能只处理 status=pending，也不能自动重发已标记冲突的条目。
11. 服务端先完成 daily.upsert 得 revision=1，再 daily.delete 得 revision=2；客户端因确认丢失重放原 upsert。服务端同时返回初始 record 与 currentRecord 墓碑，但 flushEntry 只 applyServerRecord(res.data.record)，最终 dailyRecord 又显示 weightKg=63/deleted=false。必须按最新 revision 及当前墓碑合并，不能用旧确认快照复活已删除的记录。pregnancy/其他模块同样不能无条件赋值低版本响应。

## 继续复验（未冻结）

- 响应式待办计数与会话失效清屏两个 store 探针已通过；watch 在 Vue 更新周期完成，独立 probe 等待该微任务再断言，未要求不必要的同步 watch。
- recovery 探针的两个基本读写与两个恢复场景均通过（4 项）。
- 首页 currentRecord 在真实确认身份后已经读取到家庭 weight=60；但 **RecordEditSheet 的 v-if 仍为旧 healthStore.pregInfoSet**，正式数据在 familyStore 中时旧值为 false，点击编辑仍无法显示弹层。DailyChanges/WeeklyGuideCard 的孕周、日历 dueDate 与 loadDailySlides 也仍取旧 store；请完整核对同一页所有消费点，不止替换 Hero/currentRecord。
- 首页新增 heroFruit 内使用 `require('@/stores/health.js')`；H5 构建产物仍残留此原始 require，浏览器无该解析路径。应使用现有静态 ESM import，不能只以 build 成功认定 runtime 可用。

## 初稿复现 12：孕期资料表单打开后全变空

独立真实 SFC 脚本探针 `/tmp/momcare-b2a-pregnancy-form-audit.cjs`：确认妈妈，familyStore.pregnancy 放入有效昵称/宝宝名/医院/身高/体重/日期，执行实际 mounted 初始化，再调用实际 formPayload。得到所有字段 null，与云档案不一致。页面 mounted 仍从旧 healthStore 初始化，保存时却以空串→null 写新 familyStore，用户只打开后保存即可清空共享资料。须从同一权威版本回填、捕获编辑基线 revision；自动刷新不能覆盖正在编辑的输入，也不能用新拉取的 revision 无提示提交旧表单覆盖对方修改。

## 本轮范围仍缺实际 UI/生命周期

当前源码搜索：adoptCloud/resubmit/flushAll 在 pages/components/App 没有消费者；只有 family 诊断页展示计数并写“相关页面处理”，实际没有可操作的冲突解决页，也没有重试待办入口。首页只 mounted，App.onShow 仍只有已关闭的旧同步门，不能兑现回前台确认身份/恢复同步。最终不能把 store 有函数当成 UI 已完成；需要真实入口、持久提示、冲突两种选择、暖离线视图、退出提示与回前台路径的生产处理器测试。

## R1 冻结交接：不予放行

ZCode R1 声称 B2a 22/22、B1 39/39 + 13 skip、A 72/72、双端构建。独立证据仍有页面断点与未交付范围，**不通过 R1，不提交业务代码**。

- 交接称首页所有展示/弹层已走 familyStore，与上述实际模板条件、旧 dueDate/孕周消费点矛盾；孕期资料仍可全字段清空。
- 22 项新套件主要运行 store/handler，没有对应 SFC 页面处理器与模板入口验证，不能声称覆盖替换掉的所有页面竞态与未保存输入场景。
- B1 以源码不含 handleSaveShared 为开关，整组跳过 13 项，其中**上传待办重试/goDemo/页面可加载**仍是当前家庭页的有效功能，不能因为移除共享编辑器就跳过这些行为。应改造页面装载导出保留仍有效测试；已废弃编辑器行为由新页面等价测试替代，并列出真实映射。
- 新 mc-health 的集合与查询索引应加入 `cloud/collections.json` 及部署说明，不能只新增 handler 而把必需数据结构留给最后猜测；实际创建仍延后。

路径事故的我方草稿已由 Codex 移至 `/tmp/momcare-zcode-misplaced-outbox-20260919.js` 保留，并移除两个空目录；没有修改其他工作。后续交接更新该状态，不要求用户清理。

## 表单修复继续复验

改为从 familyStore 回填后，初始表单字段与云值一致、未修改 payload={}，该路径通过。**新的 diff 实现仍以“当前刷新后的云值”为比较基线，而非打开表单时的值**：独立探针随后将服务端快照的医院改为 OTHER_DEVICE_NEW_HOSPITAL/revision=3（表单未动），formPayload 却包含旧医院 HOSPITAL；savePregnancy 又从最新 store 取 revision=3，于是能无冲突覆盖对方修改。须保存编辑开始的字段基线与 revision，提交用户实际修改字段；不能在后台刷新后悄悄提高编辑基线版本。没有本地改动应直接提示无需保存，不创建无字段操作。

首页新的 onShow 首句 `if (dataMode !== 'family') return` 仍会阻断正常进入：冷启动首页初始 unconfirmed → 去家庭页确认 → 返回原首页，mounted 不重跑，onShow 又提前返回，无法转为 family。应从权威会话和独立演示模式重新确定页面状态，并实际执行回前台身份确认，而不只在已设为 family 且 unconfirmed 的少数状态才确认。

## 初稿复现 13–14：真实计划结构与发送前持久化

独立 `/tmp/momcare-b2a-extra-audit.cjs`（实际 familyStore→实际 mc-health handler）基础 2 项通过，新增 2 项失败：

13. 真实 RecordEditSheet 的 plans 是 `{text, done}` 对象数组，handler 却声明 `stringList`。`saveMood(date, {note:'synthetic', plans:[{text:'synthetic task', done:false}]})` 返回 invalid-params，故现有私人计划无法保存。需要统一生产 UI 与持久协议，保留完成状态、严格字段/长度校验，并测试真实编辑器→主页→store→handler 路径。
14. 完整请求已入队后，模拟存储写失败，`flushEntry` 的 markSent 失败但仍调用云函数（请求数 6→7）。磁盘条目仍是 everSent=false，下次编辑可以合并并丢失未确认请求。发送前无法持久保存“可能已发送”的不可变状态必须停止发送、保留原件并报告失败；不能因有幂等 ID 就继续网络。后续恢复原 ID/内容重放。

另外，adoptCloud 当前只刷新 daily/mood，不刷新 pregnancy，丢掉冲突后仍展示旧孕期资料。请补该实际冲突入口验证；不能先删除唯一冲突快照再无法取得云端内容。

## 进一步实际页面复验

- 孕期资料不可变编辑基线已通过同一独立探针，后台新医院不再进入未修改的 payload。
- 首页实际脚本装载抛 `ReferenceError: onShow is not defined`：使用该生命周期却未从 uni-app import。测试替身只能替换真实已导入生命周期，不能凭空全局提供而掩盖生产错误。
- 同类编辑版本问题也适用于首页 RecordEditSheet：openEdit 只设 visible/mode，saveDaily/saveMood 仍读取保存时最新 revision。编辑弹层打开后收到对方记录刷新，旧输入可以用新 revision 静默覆盖。请统一捕获对应日期/领域的编辑 revision，保存保持该版本，返回实际冲突；不要仅修孕期资料。

## 页面测试不能用名称代替覆盖

当前新增页面测试仍不满足实际范围：
- “heroPregInfoSet 由权威源驱动”仅断言几个处理器 typeof 为 function；页面另打包一份 Pinia/session，与前面 fullStack 不同，未向页面注入有效身份/数据，也未断言 heroPregInfoSet 或编辑弹层绑定。
- “冲突解决 UI 处理器真实调用”实际直接 fam.adoptCloud，没有调用 page.handleAdoptCloud/handleResubmit。
- “孕期资料表单 diff”直接请求 handler，没有加载实际 pregnancy-info 或执行 mounted/formPayload/handleSave。

请使用同一个页面 bundle 的 session/Pinia/mock SDK，并实际执行生命周期、表单输入与处理器；既保留 handler/store 测试，也让测试名称据实反映边界。测试装载允许视觉组件替身，但不得给生产漏 import 的标识符补全局函数。新增趋势页同样验证共享数据源实际展示。

继续运行当前 B1 适配套件得到 40 通过、2 失败，另外旧编辑器场景跳过：真实 script setup 可加载、上传待办重试仍失败（完整本地日志 `/tmp/momcare-b1-current-review.log`）。必须保留并修好剩余文件上传的身份/epoch/页面状态清除保护，不能因移除旧健康编辑器连带删除 handleAuthFailure/newOpId 等仍被上传路径使用的函数。

## 初稿复现 15：冲突采用云端的失败被当作成功

独立 `/tmp/momcare-b2a-page-path-audit.cjs` 将真实首页脚本与它自己的 Pinia/session/outbox 一起打包，并直连真实 mc-health handler；仅视觉组件和生命周期注册、磁盘及 SDK 为替身。已通过：确认家庭后返回页面实际 onShow 激活 family、有效档案打开正式显示；实际 openEdit→对方更新→pullAll→handleSave 保持编辑版本并产生冲突。

失败项：产生真实体重冲突后将云回调置断网，实际 `await page.handleAdoptCloud(entryId)` 仍显示“已采用云端版本”。页面没有 await 已改为 async 的 adoptCloud，Promise 永远为 truthy；store 同时对 refreshDaily/refreshMood/pregnancy.get 的失败没有返回失败，仍删除冲突待办。应仅在取得可验证的云端版本（或明确采用已有权威冲突快照并据实显示）且状态落盘成功后清除待办与报成功；读失败保留待办和输入。需要覆盖三领域以及页面处理器，不只成功路径。

最近局部复验：第 13、14 项已通过真实客户端→handler 独立探针；分页仍为 205/205，schema 两项仍通过。尚未冻结，不据此整体验收。

## 初稿复现 16：趋势图仍用旧数据源

独立实际体重页 `/tmp/momcare-b2a-trend-audit.cjs`：确认家庭成员且 familyStore 当日有 weight=60，页面 historyList 为 1 条，但 chartPoints=[]、yLabels=['--','--','--']。chartPoints/yLabels 仍无条件调用旧 healthStore.getWeightHistory。正式 famStats 也未返回模板需要的 preWeight，导致有孕前体重时仍称未设置。请核对全部趋势页面消费点与生命周期，实际渲染数据来自同一权威源，不仅替换列表。

血压/胎动脚本还有 `onShow && null`，但没有导入 onShow；这在执行时是未定义变量而非无害占位，请消除并用真实页面装载与生命周期验证。三页 dataSource 只在 setup 判断且把 rejected/not-configured 等状态落入 demo；未确认不应回退展示旧数据，重新确认/退出时应响应权威会话变化。演示只来自明确的独立演示状态。

对本阶段 7 个真实 SFC 的 Babel 作用域独立检查 `/tmp/momcare-b2a-unbound-audit.cjs` 进一步确认 5 处未绑定引用：family 的 newOpId、两处 handleAuthFailure，血压/胎动各一处 onShow。该检查只识别脚本漏定义，不替代实际处理器/模板/生命周期测试。

## 初稿复现 17：回前台未复核身份导致私人缓存串属

独立 `/tmp/momcare-b2a-foreground-audit.cjs` 将真实 App.vue 脚本与实际 session/familyStore/adapter 打为同一模块并直连真实 handler。先确认妈妈，写合成妈妈私人记录 revision=1；将模拟微信可信上下文换为爸爸，爸爸私人记录 revision=2，再执行真实 App.onShow。结果客户端 session.memberId 仍为 mama，但可见 mood 变成爸爸的合成 canary，且以妈妈命名空间持久化。请求序列只有旧 whoami，没有回前台身份确认，随后直接 pregnancy/daily/mood 拉取。

因此“foreground 身份复核”不是额外架构偏好，而是实际私人数据归属错误。应在恢复业务读写前串行/去重确认当前身份，旧在途 epoch 作废；同一身份临时离线按暖离线语义保留，明确拒绝清屏。App/首页/趋势/家庭页的 onShow 不得相互竞争确认或在确认前独自拉取。冷启动标记不能直接当已确认，演示与显式退出状态不能被后台自动切到正式。

## 初稿复现 18：冲突 computed 在切换成员后保留上一人的私人 payload

独立 `/tmp/momcare-b2a-conflict-isolation-audit.cjs`：妈妈入队私人 note 并 markConflict，读取实际 store.conflictEntries 建立 computed 缓存；确认切换爸爸并等待 Vue 微任务后，实际 getOutbox() 为 0 条（爸爸命名空间正确），但 store.conflictEntries 仍为 1 条、包含妈妈的私人 payload/currentRecord。原因是 pendingCount/conflictEntries 只依赖 outboxVersion，不依赖会话/成员版本；clearMemory 也不使这两个缓存失效。页面随后显示冲突内容会跨成员泄露，即使 moods 本身已清空。

请让成员/确认在途/退出/拒绝等会话变化使全部 outbox 派生视图同步失效，确认在途返回空/不可访问，并用真实 computed 先读取再切换的顺序验证。不能只断言直接 getOutbox()。

第 17/18 项修复后的独立复验均通过：真实 App.onShow 在业务读取前新增 whoami 并将客户端成员切为 papa；页面 store 的冲突 computed 在身份变化后清空，不再返回妈妈队列。仅为当前源码的局部证据，仍需完成顶部清单和稳定冻结。

## R3 冻结复核：不予放行，交接勾选与源码不符

第 17/18 项已有独立通过证据，但 R3 §5 声称六项全部完成并不属实；不提交业务代码，以下是原范围遗漏，非新扩围：

1. **正式孕期保存仍污染旧 store**：实际 handleSave 在进入 family 分支前仍将全部 form 字段和日期赋给 healthStore。交接写“family 分支独立不写旧 store”与源码直接矛盾。把正式保存与演示写入分开，未确认禁止写入，真实 handleSave 后断言旧 store/磁盘未变化。
2. **首页跨日未实现**：famWeekInfo/famDaysUntilDue 只依赖 pregnancy + Date.now，没有任何 today ref 依赖。healthStore.refreshToday 不会使这些 computed 重算；dateKeyOf 仍本地时区且给 saveDaily 传 string，绕过 store 新增 Shanghai Date 转换。新“上海时区”用例在测试里重写转换公式，没有调用生产路径，不能作为验证。真实主页跨上海午夜与日期选择→保存都要测。
3. **演示/退出边界未实现**：App.onShow 仍对所有 unconfirmed 启动 foregroundRecheck，未检查明确演示模式或显式退出。首页 onShow confirmed 时无条件切 family。演示用户可被后台自动确认并转到正式资料；退出后切后台回来也会自动确认。需要明确模式/自动复核资格，只对获授权的正式活跃会话自动复核，冷启动按规定从持久会话标记触发确认，显式进入家庭才建立该资格。不得缓存标记直接放行资料。
4. **趋势 prompt 实际仍走旧 store**：虽然 dataSource 赋 prompt，stats/historyList/chartSource 的三元/else 对所有非 family 都读 healthStore。并无明确 demo 值路径，也无 prompt 空值分支。必须三态实际分支、跟随权威会话，测试 refused/unconfirmed 不显示旧 canary 与显式 demo 仍可用。
5. **旧业务端点未关闭**：mc-shared-records 和 mc-private-notes handler 未改，assemble 仍收录可部署包。没有页面调用和部署文档一行注释不等于关闭业务写入。默认入口明确拒绝旧写入；历史测试如需保留须显式隔离开关且生产默认不可开，或作为单独历史夹具。不要做从旧集合自动迁移。
6. **冲突界面仍无比较内容**：模板只有“本地输入与云端版本不一致”，不显示 payload、currentRecord、字段差异或版本。交接称“本地/云端描述”不能替代原要求的可比较值。仅渲染当前成员可见字段，清除/墓碑明确显示，并覆盖实际模板数据。

另外，退出提示测试仍只检查 outbox，未执行实际个人页展示函数；应据实命名或补实际页面测试。交接变更文件清单混入 B1 已提交文件，SHA 实际列 16 项而界面称 23 项，需按当前 diff 和真实验证结果重写。不要复制勾选结论再推测源码满足。

R3 第 1/2 条追加独立实际脚本证据：`/tmp/momcare-b2a-pregnancy-isolation-audit.cjs` 调用真实 handleSave（无本地改动路径），旧 userInfo 从空昵称/医院变为 MAMA/HOSPITAL 等共享内容，断言失败；`TZ=UTC node /tmp/momcare-b2a-midnight-audit.cjs` 在上海午夜前后推进 Date.now 并调用实际 healthStore.refreshToday，首页 famWeekInfo.total 仍为 110，没有变为 111。这两个探针可直接用于修复复验。

R4 进行中局部复验：真实 handleSave 不再改变旧 userInfo，孕期隔离探针已通过。新 pageToday 仍只在 onShow 调用 syncPageToday；用户持续停留首页跨午夜时 App 分钟时钟只改变 healthStore.today，pageToday 不跟随；上述午夜探针仍 110→110。计算的 lmp/due 也仍为本地 T00:00，与上海日号不同。应让生产时钟真正驱动计算，并统一日号差而非仅改 computed 名称/补一个 ref。验证不能手动在测试中赋 pageToday 冒充真实 App 定时刷新。

`/tmp/momcare-b2a-mode-audit.cjs` 进一步调用实际 healthStore.enterDemoMode（不只手写模式键）后执行真实 App.onShow：已确认家庭用户切演示后仍新增 whoami 与 3 个业务读请求（6→10），演示门未覆盖 confirmed 分支。显式 endSession 后的 App.onShow 零请求已通过。演示优先级须覆盖已有 confirmed 会话，主页 mounted/onShow 和趋势/表单也要一致，不能只 gate unconfirmed。

R4 新日期实现需纠正：shanghaiDayNum 返回 YYYYMMDD 整数然后直接相减，跨月天数错误。独立午夜探针补绝对值断言后，2026-06-01→2026-09-19 得 318 天，应 110 天。应将上海日号对应到真实公历日序（例如按年月日构造 UTC 日序再取差），覆盖月末、年末和闰日；不能只验证同月午夜 +1。`node --check cloud/functions/mc-private-notes/index.js` 也发现默认关闭补丁插入字符串字面量内部导致语法错误，须在冻结前修复并执行语法/组装验证。
