# B3a 实施交接（rev22）

基线 B2b2 `e0cf22f19ece03001d6f2446993805de27b0184e`。

## 本轮修复（rev22 — 清除入口如实标注；生产写入停止，冻结待独立套件）

评审 UI 真实性收尾项（仅 pages/profile/privacy.vue；tests/ 未编辑；数据零触碰）：
actionItems 的 clearCache 行原为红色破坏性样式（danger:true）且标签承诺"清除前自动备份"
——实际 handleAction 只弹"暂不支持"提示、不备份不清除。改为与导出/注销一致：
非 danger、标签"暂不可用"（灰），移除自动备份承诺；行保留可见（入口诚实），toast 不变。

验证事实（退出码，非验收主张）：privacy 探针 mode/sync/clear/deleted-count/
pending-status + confirm-after-open 全 PASS；8 套件（含 TESTING phase-b3a-archive）
exit 0；busy-stall 证据 13/13 exit 0；review-runner 80/80 exit 0（source stable）；
双端构建 exit 0。

冻结 SHA256（本轮变更文件）：
```
dfb960711f08d1baf84911c2052778428f670c6b69bfb7fc46f174851d4d6e1f  pages/profile/privacy.vue
```

**生产源码写入与构建已停止——B3a 源码冻结，等待 TESTING 任务独立套件验证。**

### rev21（busy 等待保证 eventual 重试 + 报告计数来源标注）

评审两项发现（仅生产源码 pages/profile/privacy.vue；tests/ 未编辑）：

| 项 | 缺陷 | 修复 |
|---|---|---|
| busy 截断 | 40×50ms 截断——旧 pullAll 在途超 2s 时新身份健康概览永久丢失（无重试无入口） | pullHealthWithBusyRelease：轮询直到旧同步释放（store finally 必然释放）——保证 eventual 重试；仅设 60s 安全阀（100ms×600），超阀 syncStalled=true 显示"同步等待超时——请点下方重试"+ 显式重试入口（refreshAuthoritative，令牌守卫）；等待期状态持续"同步中…"不静默放弃 |
| 计数来源 | 报告计数无标注的判定用持久化 lastReportSyncAt——新挂载拉取失败时显示陈旧计数冒充权威 | reportSyncedThisEpoch：每次刷新开始置 false，仅本次刷新的 pullReports 成功（令牌匹配）才置 true；标注只认本次刷新来源——失败保持"（本机缓存）"，成功后转权威 |

证据（/tmp/zcode-b3a-privacy-busy-stall-evidence.cjs，真实页面→store→真实 handler，13/13
PASS exit 0——供评审复核，非验收主张）：
- T1（旧健康请求延迟 3000ms > 旧 2s 截断）：等待期持续"同步中…"（T1a，0.7s 采样）；
  3s 旧请求落定后新身份完成自己的健康拉取→"正常"（T1b/T1c）；papa 名下 ≥2 次健康
  调用（busy 尝试+释放后成功，T1e）；无隐性截断放弃（T1f）；旧延迟响应跨身份真实
  到达（T1g）且零旧家庭数据（T1d）
- T2（计数来源）：成功同步后计数权威无标注（T2a）；新挂载恢复快照（持久化
  lastReportSyncAt 已恢复，T2b）但拉取失败→计数保持"（本机缓存）"标注（T2c）+
  状态"报告同步异常"（T2d）；重试成功→标注消失转权威（T2e）+"正常"（T2f）

既有验证（只读运行）：8 套件（含 TESTING 的 phase-b3a-archive）exit 0；4 个既有证据
脚本 exit 0（含 rev20 竞态脚本——新等待语义向后兼容）；review-runner 80/80 exit 0
（source stable）；双端构建 exit 0。

冻结 SHA256（本轮变更文件）：
```
2ef3c17cf35debcc5d680e864f87cd01829c1e0ebc717829e85b2503771646c1  pages/profile/privacy.vue
```

**源写入与构建已停止**，等待 TESTING 任务在稳定快照上加延迟超截断/计数来源回归后交接冻结。

### rev20（privacy 权威刷新的身份作用域竞态）

评审发现：refreshAuthoritative 单一 refreshingDomains 布尔——mama 拉取在途时切换到
papa，新触发因旧刷新占用而立即返回；旧请求落定后无人重试 papa；旧完成还可能写
reportSyncError 污染新身份 UI。

修复（仅生产源码 pages/profile/privacy.vue + services/familyStore.js；tests/ 未编辑）：

| 项 | 修复 |
|---|---|
| 刷新令牌 | refreshToken ref：每次触发 ++ 取新令牌；旧 continuation 完成时令牌不匹配则【不写 reportSyncError、不清在途标记】——新身份 UI 只由自己的拉取决定 |
| busy 释放重试 | 移除布尔早退门：新触发总是发起自己的完整拉取；pullAll 因旧身份占用 syncing 返回 busy 时有界重试（50ms×40，令牌被取代即停）——新确认身份必有自己的一次完整拉取 |
| store 层污染 | pullAll catch 写 lastError 前核对 epoch：旧 continuation 的失败不得改写新身份的"同步异常"标记（返回 stale 软码） |

证据（/tmp/zcode-b3a-privacy-refresh-race-evidence.cjs，真实 privacy.vue→familyStore→
真实 handler + 合成延迟云响应——切换前入队的健康/报告请求延迟 120ms 后返回失败垃圾，
12/12 PASS exit 0——供评审复核，非验收主张）：
- R1（换成员 mama fam1→papa fam2）：新身份在途"同步中"；落定后"正常"（自己的完整拉取，
  含 busy 释放后重试）；旧延迟失败响应已跨身份到达但状态零污染；零旧家庭数据
- R2（同 memberId 换 familyId mama fam1→fam2）：同上全部成立
- 两场景均验证新身份确实发出了自己的 mc-health + mc-reports 调用

既有验证（只读运行）：8 套件（含 TESTING 的 phase-b3a-archive 5/5）exit 0；
我的 3 个既有证据脚本 exit 0；review-runner 80/80 exit 0（source stable）；双端构建 exit 0。

冻结 SHA256（本轮变更文件）：
```
7fa423152a8cb574f6d96482bb78a540e9cdeed1a1d204615f9dc8f69a44f848  pages/profile/privacy.vue
350d7f0bf781227c0426ff2492f0f49201c89496392336cb33b2623672638898  services/familyStore.js
```

**源写入与构建已停止**，等待 TESTING 任务在稳定快照上加延迟云响应回归（含同成员换家庭）并复跑。

### rev19（存储支撑列表的响应式失效）

TESTING 任务 tests/phase-b3a-archive.regress.cjs 报 3 失败（场景3/4/5）：页面
archivedBatches/attachmentRecoveries computed 只读存储、无响应式依赖——同页归档后
不刷新、恢复切换后不可见、换成员仍暴露旧列表。

修复（仅生产源码 services/migrationStore.js + pages/profile/data-source-scan.vue；
tests/ 未编辑）：

| 项 | 修复 |
|---|---|
| 失效版本 | migrationStore 新增 storageListRevision ref，递增点：archiveBatch 成功、removeArchivedEntry 成功、restoreArchivedBatch 完成、recordAttachmentRecovery（durable 追加或内存兜底）、consumeRecoveryRecord、sessionVersion watch（任何会话/身份/家庭变化） |
| 响应式派生 | store 级 computed：archivedBatchesList / attachmentRecoveriesList / attachmentRecoveryLatest（依赖 revision，读取时应用当前成员+家庭过滤）；页面 computed 改指向这三个派生——不再直接调用存储读取函数 |
| 列表源过滤 | 家庭过滤在读取源（rev17 已加）+ 会话变化 bump → 换成员/家庭后列表立即按新作用域重算 |

验证事实（退出码，非验收主张）：
- TESTING 任务套件 tests/phase-b3a-archive.regress.cjs：5 场景全 PASS、exit 0（修复前 2/5）
- 我的三个证据脚本（archive-restore 20 项 / family-snapshot 12 项 / privacy-report 19 项）exit 0
- 其余 7 套件 exit 0；review-runner 80/80 exit 0（source stable）；双端构建 exit 0

冻结 SHA256（本轮变更文件）：
```
3944c3b3c46cd3cc9d60d273b71b1316b900d6bce9ca68ddc5620e4975bc9526  services/migrationStore.js
5976beb611c1abca120b7d731d56fae12395285604c85c77972e448b7cf83f7e  pages/profile/data-source-scan.vue
```

**源写入与构建已停止**，等待 TESTING 任务在稳定快照上复跑。

### rev18（同成员换家庭的内存/快照泄漏）

评审发现：familyStore session watcher 只比较 memberId——同成员重确认进不同家庭不清内存
（daily/reports/checkups/bag 残留）；sessionService 成员缓存键无 familyId、restoreFromCache
不校验快照归属——冷重启会把旧家庭快照应用到新家庭。

修复（仅生产源码 services/familyStore.js；tests/ 未编辑）：

| 项 | 修复 |
|---|---|
| watcher 家庭比较 | 追踪 lastWatchedFamilyId：成员或家庭任一变化即 clearMemory()+restoreFromCache()；同成员同家庭重确认（回前台复核）不清——B2b1 既有语义保留 |
| 快照家庭作用域 | persistSnapshot 写 `b2a-snapshot@fam:<familyId>` 键且载荷内记 familyId；restoreFromCache 只读当前家庭键 + 载荷 familyId 双检 |
| 保守迁移 | 旧成员级键（无家庭作用域）原字节保留、不迁移不清除——其内容无法证明属于哪个家庭，不自动采用（云端权威拉取兜底）；两家庭快照各自独立成键互不覆盖 |
| 草稿 | 成员级草稿（mergeDraft/pendingDrafts）本就与家庭无关——不动，旧家庭草稿跨家庭可恢复 |

证据（/tmp/zcode-b3a-family-snapshot-evidence.cjs，真实 privacy.vue→familyStore→真实
mc-health/mc-reports/mc-files handler，12/12 PASS exit 0——供评审复核，非验收主张）：
- S1-S2 fam1：1 报告+1 日记录，两域同步"正常"，计数 1/1
- S3-S5 warm 同成员换 fam2：报告 0 份、日记录 0（零旧家庭数据）；状态为新家庭自己的同步
- S6-S7 cold 重启（fam2、离线）：restore 不带出 fam1 任何记录（fam2 自有快照可恢复）
- S8 fam1 快照字节仍在（fam2 活动不删除旧家庭快照）
- S9 fam2 快照独立成键
- S10 切回 fam1：快照可恢复（含旧报告 rep-fs-1）
- S11-S12 fam1 草稿跨家庭可恢复（成员级）

既有验证（只读运行）：7 套件全 exit 0（含 b2b1 快照跨重启/迁移清单流——persistSnapshot
新键向后兼容，其磁盘失败注入按 `includes('b2a-snapshot')` 匹配仍命中新键）；
review-runner 80/80 exit 0（source stable）；双端构建 exit 0。

冻结 SHA256（本轮变更文件）：
```
870e27d03479cdde55e9ba4b92cdfeb4216d8c3f946458a80c801faa43d70332  services/familyStore.js
```

**源写入与构建已停止**，等待 TESTING 任务冻结验证与评审复核。

### rev17（归档恢复两个阻塞项 + privacy 死代码）

评审发现两个归档恢复阻塞项 + privacy 死代码（仅生产源码；tests/ 由 TESTING 任务所有，未编辑）：

| 项 | 缺陷 | 修复 |
|---|---|---|
| 家庭过滤 | getArchivedBatches 返回成员命名空间键内全部结构有效条目——同成员换家庭后旧家庭归档元数据可见 | 过滤 entry.memberId === 当前成员 && entry.familyId === 当前家庭（与活动批次可见性同规则） |
| 无损写序 | restoreArchivedBatch 先从归档移除条目再 persistBatch——活动写失败且回滚写也失败时唯一 durable 归档副本丢失 | 重排：① 旧活动批次先 durable 归档（失败即中止）② 恢复条目先 persistBatch 为活动批次（归档副本仍在；此步失败零损失回退）③ 活动 durable 后才移除归档条目；移除失败保留重复副本（更安全、可对账，返回 duplicate:true 如实上报，页面 toast 提示副本保留） |
| privacy 死代码 | handleAction clearCache 含 unreachable `if(false)` 假路径；doDangerAction 伪造 `{ok:true}` 成功结果 | 全部移除——clearCache 保持诚实禁用提示；doDangerAction 到达此处一律如实"未执行任何删除"，不伪造成功 |

证据（/tmp/zcode-b3a-archive-restore-evidence.cjs，真实页面→migrationStore→真实存储，
20/20 PASS、exit 0——供评审复核，非验收主张）：
- F1-F2 家庭过滤：原家庭归档可见；同成员换家庭后归档不可见
- G1-G3 边界0（旧活动归档写失败注入）：恢复在第一步中止，活动/归档零变动
- H1-H5 边界A（活动批次写失败注入）：恢复回退为 B；归档合法新增 B（评审要求 old active 先 durable）且 A 副本仍在；冷重启后活动=B、归档含 A——零丢失
- I1-I7 边界B（归档条目移除写失败注入，活动已 durable）：恢复成功且如实 duplicate:true；归档保留 A 重复副本；冷重启活动=A durable、归档含 A+B 零丢失；重复副本可再对账
- J1-J3 正常序：恢复成功、无重复、归档移除 A 保留 B

既有验证（只读运行）：source-changed-repreview、privacy 探针 6 项、confirm-after-open 全 PASS；
review-runner 80/80 exit 0（source stable）；7 套件 exit 0（页面 18/18）；双端构建 exit 0。

冻结 SHA256（本轮变更文件）：
```
1d24e46dcb717220b2263ea6e18eb10704e2eaa75591a2bc859f02f238ec126e  services/migrationStore.js
b40b21a2652126733f2c22aa7aff634525a5101814b9da6293e9ea4df4247855  pages/profile/privacy.vue
a5a0c42b42c63fa60f01ac7d3258bb9b2c1926b37865b6e70fd58afe35c9710d  pages/profile/data-source-scan.vue
```

**源写入与构建已停止**，等待 TESTING 任务冻结验证与评审复核。

### rev16（privacy 报告域如实同步）

评审发现：privacy 页 `dataItems` 统计 `familyStore.reports`，但打开/确认过渡只调
`pullAll()`（孕期/日健康/心情）——报告域需 `pullReports()`，`lastFullSyncAt`/`syncStatusText`
可在报告计数仍为缓存/零时显示"正常"。

修复（仅生产源码 pages/profile/privacy.vue；tests/ 由 TESTING 任务所有，未编辑）：

| 项 | 修复 |
|---|---|
| 报告域显式拉取 | 打开（family 态）与确认过渡统一走 refreshAuthoritative()：`Promise.allSettled([pullAll(), pullReports()])` 两域互不拖累；pullReports 不吞异常（分页解析 reject 由 allSettled 捕获） |
| "正常"门控 | 须健康域与报告域【都】完成过权威拉取（lastFullSyncAt && lastReportSyncAt）；仅一半完成如实显示"部分同步：报告域/健康域未完成"，不伪造全部完成 |
| 报告失败可见 | refreshAuthoritative 记录 reportSyncError（排除 stale/unauthenticated/busy 软码）→ 状态显示"报告同步异常：…"，绝不回落"正常" |
| 计数缓存标注 | 报告域本次会话未完成权威拉取时计数后缀"（本机缓存）"（快照或 0），完成拉取后为权威计数无标注 |
| 身份切换 | store 侧 clearMemory（退出/换成员）本就清 reports+两时间戳；页面刷新期显示"同步中…"——切换后旧成员数据不残留，新成员经【自己】的两域拉取后才恢复"正常"（报告为家庭共享域：同家庭成员可见同一份，但须是自己拉取的结果） |
| epoch 安全 | pullReports 内部 epoch 校验保留：迟到响应跨切换返回 stale-session 软码，不推进 lastReportSyncAt、不写入新成员视图 |

证据（/tmp/zcode-b3a-privacy-report-evidence.cjs，真实 privacy.vue→familyStore→真实
mc-health/mc-reports/mc-files handler，19/19 PASS——供评审复核，非验收主张）：
A1-A4 确认过渡两域显式拉取；完成后"正常"+权威计数无缓存标注
B1-B3 报告域拉取失败→"报告同步异常"可见、绝不"正常"、计数标"（本机缓存）"
C1-C2 健康完成+报告软失败→"部分同步：报告域未完成"
D1-D9 身份切换（报告域延迟 80ms 可观察）：退出即清旧视图/归零；新成员在途"同步中"+0 份；papa 自己两域拉取后"正常"+家庭共享 1 份
E1 报告响应迟到跨切换→丢弃（不伪造完成）

既有验证（只读运行）：privacy 探针 mode/sync/clear/deleted-count/pending-status +
confirm-after-open 全 PASS；review-runner 80/80 exit 0（source stable）；7 套件 exit 0
（页面 18/18）；build:mp-weixin / build:h5 exit 0。

冻结 SHA256（本轮变更文件）：
```
015cb9de4964471293ad0338f45fc0ee1f4b05519c54797f5358a3f80cfbb362  pages/profile/privacy.vue
```

**源写入与构建已停止**，等待 TESTING 任务冻结验证与评审复核。

### rev15（归档完整性与用户可达）

协调边界：本 rev 起 ZCode 只改生产源码与产品文档；tests/ 由独立 TESTING 任务所有，
本轮未编辑 tests/（套件为只读运行）。

评审四项生产阻塞的处理：

| 项 | 缺陷 | 修复 |
|---|---|---|
| 归档损坏字节 | 归档键已有不可解析字节时 getMemberCache 返回 null 被当空列表覆写 | archiveBatch/restoreArchivedBatch 先 getScopedCacheStatus：corrupt/error 一律拒绝（原字节保留不覆写）；可解析但非列表结构的遗留值作首元素保留，读取侧按结构过滤 |
| 第 21 条静默丢弃 | `while>20 shift()` 静默淘汰历史条目 | 移除上限截断——任何归档条目不允许被静默丢弃；条目由用户操作产生、体积小；如需清理必须显式操作 |
| 归档只写不可达 | 归档后用户无法查看/恢复旧批次 | getArchivedBatches（结构有效条目、倒序、含实体域摘要）+ restoreArchivedBatch（显式恢复：当前批次先无损归档→恢复条目移出归档成为活动批次；任一步写失败整体回退；所有权/家庭校验；归档损坏拒绝）+ 扫描页"归档迁移批次"列表与"设为当前批次"入口（含如实说明：恢复后仍受来源校验约束） |
| 多槽位独立可操作 / 同槽最新命中·durable 后消费 | — | rev14 已落地（getAttachmentRecoveries 逐槽暴露+逐槽按钮；逐目标取最新精确匹配；consumeRecoveryRecord 仅 durable 成功后消费），本轮复核未改动 |

验证（只读运行，不作为验收主张，由测试任务独立复现）：
- review-runner 80/80 exit 0（source stable True）；source-changed-repreview PASS
- 7 套件 exit 0（页面 18/18）；build:mp-weixin / build:h5 exit 0

冻结 SHA256（本轮变更文件）：
```
7e0925f5234c4fad88d8ddb42ebb436f78ed9baf4f7071b46486c21925652333  services/migrationStore.js
063120653bc287af6d10323bbef3103c077a30cfafbc03b096cae22bab64dbf6  pages/profile/data-source-scan.vue
```

**源写入与构建已停止**（本行之后无代码/构建产物变更），等待 TESTING 任务冻结验证。

### rev14（恢复记录最新命中/逐槽暴露/消费语义）

评审指令：durable+memory 混存时 `.find` 命中最早条目；页面只暴露单条恢复入口；
恢复后记录不消费；结构性无效遗留值须保留。

| 项 | 缺陷 | 修复 |
|---|---|---|
| 最新命中 | 持久列表 + 内存列表合并后按序 `.find`——同目标 durable 旧条目排在内存新条目前，恢复成旧图 | recoveryRecordsInScope 改返回 {list,newest}：逐目标（batchId\|entityOpId\|order）取最新（合并序内存在后=更新）；recoverAttachment 用 list 精确匹配——durable+memory 混存必命中最后一次选择（字节级验证） |
| 逐槽暴露 | 页面恢复卡片只显示最新一条——其他中断原件无入口 | 新增 getAttachmentRecoveries()（逐目标最新列表）；页面卡片改为逐槽列表，每槽独立"恢复第N页"按钮（doRecoverRecord），保留 attachmentRecovery 单条导出兼容 |
| 消费语义 | 恢复成功后记录残留——重复恢复/误恢复旧条目 | consumeRecoveryRecord：durable 恢复成功后仅移除【匹配目标】条目（内存+持久）；持久重写失败条目仍在（幂等可再恢复）；corrupt/error 原字节不动；其他槽位与其他元素不受影响 |
| 结构性无效保留 | 恢复键存在可解析但非记录结构的遗留值时被列表覆写 | 追加时遗留值作为首元素原样保留（inScope 过滤不进恢复列表）；消费匹配条目后遗留值仍保留（页面18 验证） |

永久测试：页面17（durable A→内存 B 同槽混存：暴露/恢复/字节命中最新 B、slot1 保留、消费后仅剩未恢复槽位、全消费后零残留）；页面18（结构性无效遗留值首元素保留+有效记录可恢复+消费后遗留值仍在）；页面12 适配消费语义（已消费目标不可重复恢复、他家庭记录不可见）。套件 16→**18 例**。

### rev13（页面测试重写 + 三个生产行为缺陷）

### 一、永久页面测试按评审意见重写（tests/phase-b3a-page.regress.cjs，16 例）

评审指出的 5 项测试缺陷全部修复，并实现逐 case 隔离与 privacy 真实路径：

| 项 | 原缺陷 | 重写后 |
|---|---|---|
| 页面1 | localBytes 回退 cloudBytes（空洞断言）、无逐页字节比对 | 逐页 `cloud.__stored[storageFileKey]` deepEqual 本机 PNG1/PNG2（互异校验），报告附件 fileId 与槽位登记一一对应 |
| 页面2 | 标记磁盘失败条件断言（可能空洞通过） | 精确注入（批次落盘值含 `"mayHaveBeenSent":true` 才失败）→ 无条件断言：零 report.upsert、零云端报告、实体 failed、意图保留且标记回滚 false；恢复后重试→done 且仅一份 |
| 页面5 | 标题称实体/批次但只测错误 order | 三维错误目标（错误槽位/错误实体/错误批次）全部拒绝 + 槽位零变动快照 + 正确目标可恢复（非空洞正控） |
| 页面6 | 同 bundle 内 `mig.batch=null` 冒充冷启动 | 真冷启动：全新模块实例（delete require.cache + re-require，全新 pinia/store）→ 重新确认身份 → 磁盘恢复批次（batchId/operationId 一致）→ 续传执行到 done |
| 页面7 | 未制造恢复记录、`!rec \|\| papa` 宽松通过 | 先真实制造 durable 恢复句柄（mama 可见前置断言）→ 切 papa 后【严格 null】→ 切回 mama 仍可见 |
| 隔离 | 全套件共享一个 bundle/pinia/store/内存兜底 | 每个 case `loadClient()` 全新模块实例；makeStack 清运行时键+旧数据白名单键+备份键（上一 case 的 MOMCARE_BACKUP_* 会泄入下一 case 扫描——实测抓出） |
| privacy | 无 privacy 真实路径 | 新增页面14-16：三态（prompt/demo/family）与同步文案；真实 handler 保存/删除→统计排除墓碑、断网→待同步如实、flush→正常；清除入口诚实（明确不支持+零删除） |

### 二、评审探针暴露的三个生产行为修复

| 探针 | 缺陷 | 修复 |
|---|---|---|
| register-persist-stop | 首页 fileId 登记后进度写失败，executor `continue` 继续上传下一页——磁盘状态与云端副作用脱节 | 进度写失败【立即 return】终止实体（progress-persist-failed）；重试不重复上传已登记页 |
| privacy-confirm-after-open | privacy 页在未确认状态打开、随后确认——过渡后不加载权威概览；未完成同步也显示"正常" | session watch 过渡到 family 时触发 pullAll；syncStatusText 增加 syncing/lastError/未完成同步（lastFullSyncAt）门——"正常"仅在完成过权威拉取且无待办时显示 |
| source-changed-repreview | 源变化后旧未完成批次永久堵死重新确认（closeout 遗留项） | confirmEntities：源摘要不匹配时旧批次先【归档】到成员作用域历史键（b3-migration-archive，上限 20，防丢不静默丢弃），归档失败拒绝新确认；源未变仍阻断 |

## 验证（Node 原退出码，无管道尾替代）

- Codex review-runner: **80/80**、source stable True、exit 0
- B3a store 11/11、B3a page **18/18**、B2b2 33/33、B2b1 53/53、B2a 42/42、B1 42/42、A 72/72 — 全部 exit 0
- build:h5 / build:mp-weixin 均 exit 0、0 错误；unbound 0
- 如实记录：rev12 记录的 b2b1 一次性 V8 SIGSEGV 本轮未复现

## SHA256

```
b8d91b9ec8d752e12790ff518268528c99779dcb6f9f913c843b85728607d949  services/migrationStore.js
0fb7be22150b5918b888326f0fbbb39aae2738c4d14fc782fee732d185aba489  services/sessionService.js
00867b632c68e6ce72b92277a8d31f020791af834b2606dc391c9c320ae411c8  services/familyStore.js
82cd21759eea69474885a9545d94abdd367f493fc8308fce6886e8fa7c2a4baf  services/outbox.js
1cbd8174fa157db514a804f7fa6340073338201f3e65ea4c0e03b90643a89599  services/fileUploadService.js
74647cbd825db6e166efc79fffcf31ea8ec4045b87c23399739ad9ec16b69902  pages/profile/data-source-scan.vue
a30ce958110280d2f3e329f28a120971920e638e291430af83a2b5ad969f26f9  pages/profile/privacy.vue
37791677d213e27da2c1460f50497eb0f4369e96d0d2e900c79caa6ede3bf2b7  tests/phase-b3a.regress.cjs
3a1e2e68805e3731de881fba991be76f085abd6f366c4b9fecfff9d9d5541692  tests/phase-b3a-page.regress.cjs
```

未提交、未部署。待 Codex 冻结验收。

---

## 历史修复记录

### rev12（恢复兜底完整作用域 + 残缺记录拒绝）

review 扩到 77 例后新增 4 例（multi-recovery-memory-fail / recovery-corrupt-preserve / same-slot-latest + temp-copy-switch-recovery-fail 强化）：

| 探针 | 缺陷 | 修复 |
|---|---|---|
| multi-recovery-memory-fail | 清单+恢复键双写失败时内存兜底是单条覆盖——第二次中断覆盖第一次，第一页原件成孤儿 | 内存兜底改【按成员追加列表】，同 batchId+entityOpId+order 留最新、不同槽位各自保留；两条内存恢复经精确匹配都可用 |
| recovery-corrupt-preserve | 恢复键已有不可解析字节时追加会覆写原字节 | sessionService scope 新增 readStatus()：'absent'/'corrupt'/'ok'/'error' 四态；corrupt/error 不追加（原字节保留，与损坏清单同原则）→ 新原件走内存兜底 |
| temp-copy-switch-recovery-fail | executor 持久副本成功+恢复元数据写失败+切换 → 无兜底、原件孤儿；且恢复记录缺 env/app 作用域 | recordAttachmentRecovery：origin 作用域持久追加（带完整 env/app/member/family）→ 失败内存兜底（同完整作用域 + persisted:false + "重启丢失"警示文案）；executor 的 batchId 在操作开始时捕获（切换后 store 清批次，迟到 continuation 不得丢失批次绑定） |
| same-slot-latest | 同槽位两次中断（不同原件）→ 精确匹配命中旧记录，恢复成第一次选的图 | 内存兜底与持久追加同语义：同槽位只留最新——恢复必命中最后一次选择（字节级校验） |

配套严格化（用户/评审指令）：
- `recoverAttachment` 不再用 `!== undefined` 宽容匹配——恢复源必须与目标 batchId+entityOpId+order **全字段精确相等**；残缺记录（缺任一目标字段或作用域字段）在 `recoveryRecordsInScope` 过滤阶段即不可见，不猜、不放宽
- `recoverAttachment` 与重选同语义：恢复原件写入待确认字段（newLocalPath/newUploadId + needsConfirm），确认落盘后才替换旧映射；终态实体拒绝（同 reselect 边界）

## 永久页面测试（tests/phase-b3a-page.regress.cjs 13 例）

新增 9–13 覆盖两条真实数据丢失路径与严格化：
- 页面9：executor 切换+恢复元数据写失败→原成员内存兜底（env/app/member/family 全作用域 + persisted:false + 警示 + 批次/实体绑定 + papa 零业务调用）
- 页面10：reselect 双写失败→两槽位内存恢复各自可用（精确匹配恢复两槽）
- 页面11：恢复键字节损坏→原字节保留不覆写，新原件内存兜底
- 页面12：残缺记录（缺 entityOpId / 他家庭 familyId）不可用作恢复源；完整匹配记录可恢复
- 页面13：同槽位两次中断→恢复命中最后一次选择原件（PNG 字节级）

未提交、未部署。待 Codex 冻结验收。
