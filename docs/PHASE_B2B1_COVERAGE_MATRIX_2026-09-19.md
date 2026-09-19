# B2b1 实施覆盖矩阵

对照 `ZCODE_PHASE_B2B1_SPEC_2026-09-19.md` 全部条目与 `PHASE_B2B1_REVIEW_2026-09-19.md`（含冻结前范围复核与四节追加复现）逐项列出实现位置与验证证据。

长期回归入口：`node tests/phase-b2b1.regress.cjs`（53 组：服务 17 + store 14 + 待产包页 6 + 产检页 8 + 冷启动 2 + 显示 3 + 摘要 1 + 审计 2）。真实页面/权威 store/持久 outbox/真实组装产物 handler → SDK 契约模拟，全程隔离，零真实网络。兄弟套件保持：A 72/72（R3.5 注入 dataSource/familyStore 走 demo 分支，断言不变）、B1 42/42（MC_ALLOW_LEGACY_WRITES=true）、B2a 42/42。

## 1. 服务端契约（cloud/functions/mc-schedule）

| # | spec/review 条目 | 实现位置 | 验证（服务N组） | 状态 |
|---|---|---|---|---|
| 1.1 | 稳定实体 ID；全部结果分支返回一致 id | `transactionalUpsert`/`toggle-item`/`migrate-apply`/`initialize` 均 viewCheckup/viewBag(docId) | 服务1 | ✅ |
| 1.2 | 分页稳定唯一游标（bag `_id` 降序；checkup sortKey=dateKey:id）；含墓碑 | `bag.list`/`checkup.list` | 服务2（同 createdAt 45 条不漏） | ✅ |
| 1.3 | 模板初始化幂等：确定性主键 `*_tpl_*` + 事务存在即保留；并发每 templateKey 至多一条；已删不复活 | `initialize`×2 | 服务3（Promise.all 并发）、服务3b（在途不覆盖用户编辑） | ✅ |
| 1.4 | 勾选/迁移重放幂等 + requestHash：同 opId 异内容拒绝 | `toggle-item`/`migrate-apply` | 服务4、服务12 | ✅ |
| 1.5 | 迁移真实日历算术（UTC 日序，月末/闰年） | `migrate-preview` ord() | 服务5（01-31→02-01=1 天） | ✅ |
| 1.6 | 部分编辑保留未提交字段；status 只显式覆盖；手动改期退出迁移资格（source→manual-date） | `checkup.upsert` applyChanges | 服务6、服务11 | ✅ |
| 1.7 | family 隔离全路径（get/upsert/toggle/migrate/initialize/list） | 全 handler | 服务7、服务13 | ✅ |
| 1.8 | 字段严格校验（HH:MM、1-99 正数量、枚举含 going 拒绝 doc、重复 itemId、真实日历日期） | `sanitizeCheckup`/`sanitizeBagItem` | 服务10 | ✅ |
| 1.9 | toggle 目标值语义（targetDone 布尔非翻转；同目标 unchanged） | `toggle-item` | 服务14 | ✅ |
| 1.10 | checkup.upsert 真实创建路径无运行时错误；同周可多条 | — | 服务9 | ✅ |
| 1.11 | 存量 schema 不支持明确拒绝（get/list 均拒绝） | storedSchemaUnsupported | 服务8 | ✅ |
| 1.12 | 迁移只动 pending 自动安排（completed/skipped/manual 不动） | `migrate-preview` 过滤 | 服务15 | ✅ |
| 1.13 | **review 第16组**：模板持久可信来源基线 templateDate/templateLmp；部分迁移后再次预览幂等（不重复偏移）；连续多次 LMP 修改按来源绝对计算 | `initialize` 写入、`migrate-preview` 按 origin 绝对计算、`migrate-apply` 钉住存量基线（originLmpDate） | 服务16 | ✅ |
| 1.14 | **review 终节（服务17）**：migrate-apply 对每个目标日期复用真实日历校验（2026-02-31 写入前拒绝，与 initialize 同一 isValidCalendarDate）；非法项拒绝不落盘、同批合法项正常执行 | `migrate-apply` 逐项校验 | 服务17 | ✅ |

## 2. 权威 store（services/familyStore.js）

| # | 条目 | 实现位置 | 验证（storeN组） | 状态 |
|---|---|---|---|---|
| 2.1 | checkups/bagItems 权威 refs + 分页拉取 + 快照恢复 | `pullCheckups/pullBagItems/restoreFromCache` | store1 | ✅ |
| 2.2 | 持久 outbox 路由（bag/checkup→mc-schedule；daily→mc-health 不混流） | `flushEntry` | store2 | ✅ |
| 2.3 | 冲突 adoptCloud（先落地云端再清待办）/resubmit 覆盖 bag/checkup 域 | `adoptCloud/resubmit` | store3 | ✅ |
| 2.4 | 勾选稳定 itemId + 目标布尔持久（断网重试/再次点击不翻转意图） | `toggleCheckupItem/toggleBagItem` + 服务端 targetDone | store4 | ✅ |
| 2.5 | 两端同意图勾选，冲突"确认重提"后保持勾选（不翻转） | 目标值随待办持久 | store5 | ✅ |
| 2.6 | **review 第70行**：普通 flushAll 不推进迁移基线；未确认的日期变化提示保留 | `maybeAdvanceScheduleLmp` 仅认已确认批次 | store6 | ✅ |
| 2.7 | **review 最新**：两项迁移首项成功不清批次、无 null 崩溃；完整清单（目标+预览 revision）在网络前收集并持久化；全部落定才推进 | `applyCheckupMigration`（先 persistSnapshot 完整清单再逐项） | store7 | ✅ |
| 2.8 | 迁移部分失败恢复：冲突解决后续传、预览目标不漂移、批次与未完成项保留 | 批次 settled 状态 | store8 | ✅ |
| 2.9 | 模板初始化持久协议：一条模板一条待办；断网→重启 flushAll 续传；重复点击 skipped 不重建 | `initializeBagTemplates/initializeCheckupTemplates` | store9、bag页6、产检页6 | ✅ |
| 2.10 | **review 第72行**：未变更草稿重试复用原不可变请求（同 opId/内容稳定比较），不产生第二条操作/伪冲突 | `submit` 前置 guard（stableStringify） | store10、bag页4 | ✅ |
| 2.11 | 各领域完整同步时间 lastBagSyncAt/lastCheckupSyncAt（全部页成功才推进；持久化/清屏） | pull* + snapshot/clearMemory | store1 | ✅ |
| 2.12 | 迁移基线可信来源：记录级 templateLmp 优先（服务端持久），无模板记录才 LMP 兜底；已推进不回退 | `pullCheckups` 惰性初始化 | 产检页6/7、store6 | ✅ |
| 2.13 | **review 追加**：migrate-apply 响应含稳定 record.id（fallback op.id）；store 不重拉立即更新；重放优先 currentRecord | 服务端 `viewCheckup(setData, op.id)` + flushEntry | store11 | ✅ |
| 2.14 | **review 追加**：清单落盘失败不发任何网络；内存清单回滚，恢复逻辑只认已持久化清单（persistedAt 门槛），flushAll 不得从未持久化清单发送 | `persistSnapshot` 返回布尔 + apply 回滚 + `recoverMigrationBatch` 门槛 | store12 | ✅ |
| 2.15 | **review 追加**：批次已持久化但部分项未入队→重启→flushAll 按原目标/预览 revision 恢复到持久待办（不重做预览替换目标）；已落定项不重复移动；整批完成推进基线 | `recoverMigrationBatch`（flushAll 前置） | store13 | ✅ |
| 2.16 | **review 终节（会话边界）**：批次/模板/恢复三个循环全程以发起成员 epoch 为准——首项响应挂起期间切换成员，后续项不得以新成员入队/发送；原清单留原成员命名空间，切回后续传完成；收尾推进/落盘仅限原会话 | apply/recover/initialize 循环逐项 epoch 校验 | store14 | ✅ |

## 3. 待产包页面（pages/profile/hospital-bag.vue）

| # | 条目 | 实现位置 | 验证 | 状态 |
|---|---|---|---|---|
| 3.1 | 三态数据源 + 会话切换 | dataSource + subscribeSession | bag页1-6（family） | ✅ |
| 3.2 | 新增读真实输入：名称/分类/数量(1-99)/位置/负责人（不写死1）；成功后释放草稿 ID | addItem + 数量步进/表单 | bag页1 | ✅ |
| 3.3 | 权威 name 与模板 text 同构 + meta（数量×N/位置/负责人）行内显示；going/documents 徽标可见 | items computed + badge 映射 | bag页2 | ✅ |
| 3.4 | 删除走云端墓碑（刷新不复活） | doDelete → deleteBagItem | bag页3 | ✅ |
| 3.5 | 草稿 ID 复用 + 未变更重试单条操作（离线两次→联网一条，无伪冲突） | addItem + pendingDraftId + submit guard | bag页4 | ✅ |
| 3.6 | 编辑器打开捕获 revision 基线；后台刷新不抬高提交版本；旧基线提交冲突不覆盖对端 | openEdit/saveEdit | bag页5 | ✅ |
| 3.7 | 模板生成走持久协议（断网排队→联网一键补齐；含 going/documents 分类） | generateTemplates → initializeBagTemplates | bag页6 | ✅ |
| 3.8 | 可见待同步状态：bag 域待办计数+重试；冲突卡（本地 vs 云端值 + 采用云端/确认重提）；完整同步时间 | sync-banner + bagPendingEntries/bagConflictList | bag页4/5/6 + store3 | ✅ |
| 3.9 | onShow 回前台拉取+待办重试 | `__onShow` | 构建+绑定（onShow 在 bundle 中以 shows 注入运行） | ✅ |
| 3.10 | 旧 `hospital_bag_items` 正式零读零写；演示独立键 | 键常量隔离 | 摘要1（零读断言+旧键字节不变） | ✅ |
| 3.11 | **review 追加**：距预产期天数三态（family 读权威 pregnancy.dueDate + 响应式上海时钟；不混入旧本地档案） | daysUntilDue computed | 构建+绑定（同 4.11 模式） | ✅ |
| 3.12 | **review 追加**：冷启动确认后立即拉取权威清单（不等再次进入） | 同 4b.1 | 冷启动1 | ✅ |

## 4. 产检页面（pages/profile/checkup-reminder.vue）

| # | 条目 | 实现位置 | 验证 | 状态 |
|---|---|---|---|---|
| 4.1 | 权威 nextCheckup/历史 + week_label（孕X周+Y，无 undefined） | famCheckupToLegacy + weekLabelFor | 产检页1 | ✅ |
| 4.2 | **review 第66行**：勾选按稳定 itemId（点击后列表重排不误勾他项） | 模板传 item.itemId + 处理器按 id | 产检页2 | ✅ |
| 4.3 | 完成/跳过状态操作走权威源 | handleMarkCompleted/doSkipCheckup | 产检页3 | ✅ |
| 4.4 | 完整编辑器：日期/时间/医院/陪同/材料/问题；打开捕获旧 revision；旧基线冲突不覆盖对端；正常保存全字段 | openEditor/saveEditor | 产检页4 | ✅ |
| 4.5 | 添加检查项 family 路由（稳定新 itemId + 基线） | doAddItem | 产检页5 | ✅ |
| 4.6 | 空档案显式生成标准产检安排（按 LMP 计算日期；不后台悄悄写；记录级基线持久） | generateSchedule → initializeCheckupTemplates | 产检页6 | ✅ |
| 4.7 | 日期迁移：横幅→预览→确认→部分失败恢复→续传→提示消除 | 迁移横幅/预览 sheet → store 2.7/2.8 | 产检页7 | ✅ |
| 4.8 | 可见待同步状态：checkup 域待办/冲突解决/完整同步时间 | sync-banner + chkPendingEntries/chkConflictList | 产检页4/7 | ✅ |
| 4.9 | onShow 回前台刷新；正式模式不做旧本地模板初始化（仅 demo） | `__onShow` + onMounted gating | 构建+绑定 | ✅ |
| 4.10 | **review 追加**：编辑器真实 HH:mm 显示（16:45 不显示为 14:00；未设置不编造 09:30/14:00）；infoHospital 三态（family 不回落旧本地档案） | famCheckupToLegacy 保留 time + infoDate/heroSub/infoHospital | 显示1 | ✅ |
| 4.11 | **review 追加**：倒计时/逾期按上海日号 + healthStore.today 响应式时钟（跨上海午夜自动重算，记录不变也更新） | shanghaiDayOrdinal + todayShanghaiOrd | 显示2 | ✅ |
| 4.12 | **review 追加**：冷启动/异步确认后由 session watcher 立即激活并拉取（不等再次进入）；前台 foregroundRecheck；拒绝/退出清屏 | activateFamilyDomain + watcher + `__onShow` 协调 | 冷启动2 | ✅ |
| 4.13 | **review 终节**：弹层打开捕获原记录 ID/revision——跳过/添加检查项确认时下一条顶替也不落错记录（冲突固定在原记录，由用户确认重提完成原意图） | skipTarget/addItemTarget + markCheckupStatus(baseline) | 产检页8 | ✅ |
| 4.14 | **review 终节**：勾选父记录绑定——模板传 nextCheckup._id，处理器按捕获 ID 定位权威记录（不读当前 nextCheckup） | handleToggleItem(recId, itemId) | 产检页2/8 | ✅ |
| 4.15 | **review 终节**：日期键按日历字段直读（heroDate/heroSub/infoDate/formatHistoryDate/我的摘要卡）；星期按 UTC 日历算术——负时区不回退一天 | dateKeyParts/weekdayOfDateKey + profile 卡 | 显示3（UTC/洛杉矶/上海三时区） | ✅ |

## 4b. 三页冷启动协调（review 追加）

| # | 条目 | 实现位置 | 验证 | 状态 |
|---|---|---|---|---|
| 4b.1 | 待产包页冷启动：持久标记→coldStartConfirm 去重联网确认→激活 family→拉取权威数据 | 同 4.12 模式（pullDomain=pullBagItems） | 冷启动1 | ✅ |
| 4b.2 | 产检页冷启动同上（pullDomain=pullCheckups） | 同 4.12 | 冷启动2 | ✅ |
| 4b.3 | 我的页：补 onShow 刷新 + 异步确认 watcher 激活（此前无 onShow） | 同 4.12（pullDomain=checkup+bag） | 冷启动2 | ✅ |

## 5. 首页/我的摘要同源

| # | 条目 | 实现位置 | 验证 | 状态 |
|---|---|---|---|---|
| 5.1 | 我的-下次产检卡 family 同源（日期/倒计时徽标） | nextCheckupCard | 摘要1 | ✅ |
| 5.2 | 我的-待产包卡 family 权威统计；**删除旧 `hospital_bag_items` 读取**（正式零读；demo 读演示键）；旧键字节不变 | hospitalBagSubtitle 三态 | 摘要1 | ✅ |
| 5.3 | 首页 hero family 同源（B2a 已接），无产检/待产包展示缺口 | pages/index/index.vue（未改动） | B2a 套件复跑 42/42 | ✅ |

## 6. 隔离、回归与构建

| # | 条目 | 证据 | 状态 |
|---|---|---|---|
| 6.1 | 成员切换/身份拒绝清屏；失效 epoch 不写回 | B2a 回归 + 本套件复跑 | ✅ |
| 6.2 | 零旧 HTTP（uni.request/uploadFile=0）；正式零读旧 bag 键；旧键字节不变 | 审计组 + 摘要1 | ✅ |
| 6.3 | A 72/72、B1 42/42、B2a 42/42 保持（A R3.5 因页面三态化注入 dataSource/familyStore 走 demo 分支，断言不变） | 三套件复跑 | ✅ |
| 6.4 | 双端构建 0 错（h5/mp-weixin）+ 未绑定脚本引用审计（3 页面 0 真未绑定） | 构建 + 审计脚本 | ✅ |
| 6.5 | 完整文件 SHA256 + 独立交接文档 | ZCODE_PHASE_B2B1_HANDOFF_2026-09-19.md | ✅ |

> B2b2/C 范围（报告附件/OCR/共同任务）不在本阶段。未提交/未部署/未购买云资源。
