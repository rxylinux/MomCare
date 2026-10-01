# R1 交接记录（ZCode 编码与本地测试执行）

状态：**ZCode 已完成 R1 编码与本地 mock 回归（含第一/二/三轮审核意见与终审 R1_REVIEW_FINAL_DETAILS 两项的修复与反例）；未经过 Codex 审核，不称已验收。** 基线 `22be7b3`（trial 1.1.24），全部改动未提交。R1 完成后停止，未进入 R2–R4。

工作目录 `/Volumes/solid hard disk/github/rxylinux/MomCare`。全程本地 mock：未发起任何真实云/微信/AI/网站请求，未 npm view/install/pack，未部署，未 commit/push，未删除用户数据。原始日志在 `/tmp/momcare-repair-20261001/`。

## 一、文件变更

生产源码（4）：
- `services/toolsStore.js` —— R1 主体（见 §三/§五–七逐项）。
- `pages/tools/fetal-timer.vue`、`pages/tools/contraction-timer.vue` —— 未保存横幅（A04）+ 恢复异常持久横幅与显式确认（第二轮 6/第三轮 2）。
- `cloud/functions/mc-daily-push/index.js` —— 入口身份 fail-closed + 单一时钟快照 + eve 日期下推 + sortKey 完整性契约（第一轮已完成，第二/三轮无源码新意见）。
- `cloud/DEPLOY.md` —— 第 8 节头部补 R1 部署门槛警示（定时入口 fail-closed、8.4 第 4/5 步暂不可执行；本次由 ZCode 补记，使源码注释所指的门槛记录真实在位）。

测试（4 改 + 2 新）：
- `tests/phase-r1-tools.regress.cjs`（新，29 场景：R1 主体 25 + 终审 4）、`tests/phase-r1-push.regress.cjs`（新，10 场景）。
- `tests/phase-n-daily-push.regress.cjs`、`tests/phase-e1-client.regress.cjs` —— 按新契约适配（见 §十，非改弱）。

文档（本目录）：REPAIR_PLAN/REPAIR_DESIGN（Codex 写）、三轮审核记录、本 HANDOFF。

## 二、遗留测试进程处理（用户指令项）

上一会话后台任务 `node tests/phase-r1-tools.regress.cjs`（修复前代码）在断言全部完成并打印 `21 通过，0 失败`后被页面 onShow 的 `ensureTicker`/`setInterval` 计时器泄漏挂住不退出（PID 79628，CPU 0.68s 空转）。处理：核对日志断言已完整后 `kill` 结束该进程，未掩盖任何未完成断言。修复：R2-6 页面场景在调用 onShow 前临时替换 `global.setInterval` 为空实现并在 finally 恢复（tests/phase-r1-tools.regress.cjs R2-6/R3-1/R3-2③ 场景）；修复后该套件以 NODE_EXIT=0 自然退出（tools-run4.log）。生产页面的 ticker 生命周期（每页实例单_INTERVAL、不清理）为既有设计，本次未改、未纳入 R1 契约。当前 `ps` 无任何遗留 node 测试进程。本次所有结果均单独记录 node 退出码，不以管道 grep/tail 的 0 替代。

## 三、实际设计决策（与设计文档的偏差/细化）

1. **定时入口 fail-closed**：本机 wx-server-sdk/CloudBase SDK 源码缺席，无法证明平台为定时触发提供 per-invocation 可信身份；`getWXContext().SOURCE` 读 `process.env`（跨调用遗留风险，见第一轮审核记录中 Codex 摘录的官方源码）。生产实现：event 的 Type/TriggerName/kind 一律不构成授权，唯一放行路径 = 家庭成员白名单（resolveCaller）+ `{action:'sendNow'}`；拒绝发生在读库/外呼前（A01 断言计数 0）。**真实定时触发器在部署阶段验收前会被白名单如实拒绝——定时功能未闭环，属部署门槛（§九）。**
2. **scope 编码**（第二轮 3）：放弃 `SCOPE_PART_RE` 字符集限制（会误拒 `family_a` 等合法身份）。改为各部件 `encodeURIComponent` 后再把连接符 `_` 转义为 `%5F`——编码结果不含 `_`，按 `_` 拼接无歧义；scope 不完整仅指任一部件非非空字符串（env/app 也校验，落实第一轮 9）。
3. **终态耐久凭据**（第三轮 3）：flush 终态成功后**不再提前清 journal/stopOp**——服务端视图先把 active 落成终态标记（fetal `completed/discarded`、宫缩 `finished`），journal/stopOp 保留为幂等重放凭据；finalize 在 queue+history 耐久后才清空。最后的 active=null 清空写失败时，磁盘留"终态标记+凭据"，restore 视为残留不复活、冷重启对账收敛（R3-3 三反例）。
4. **恢复闸**（第二轮 6）：`recoveryBlocked` = 存在未确认的完整性警告（error/corrupt/corrupt-frozen/invalid-shape/scope-foreign/scope-foreign-unbacked）。闸落下时 retryPending/pullFetalSessions/pullContractions/pullEfwRecords 返回 `recovery-blocked` 零外呼；`acknowledgeRestoreWarnings()` 为显式确认（仅解除自动同步暂停，不删警告不改数据）；同键同状态的重恢复保留 ack 不反复弹闸；自动 retry 不触碰警告列表。用户显式动作（开始新记录）不被闸拦截，但冻结键（无耐久备份）仍禁覆写。
5. **备份真实性**（第三轮 2）：`quarantinePartial` 消费 `quarantineRaw` 布尔结果——备份失败以 `scope-foreign-unbacked` 警示并冻结禁覆写；页面横幅按状态区分"已隔离备份/未能备份（原数据保留未动）"；RECOVERY_BLOCKED_MESSAGE 不再无条件宣称已备份；确认按钮文案"我已知悉异常，恢复自动同步"并 toast 说明确认含义。宫缩 history 条目自本次起携带 scope（与胎动 history 同构），恢复时异作用域条目不显示。
6. **同成员 onShow 保 RAM**（第三轮 1）：restore 只在 RAM 无同作用域活跃会话时才采纳盘上 active——同 localRef 的 RAM 对象必不旧于盘上副本（所有落盘源于该 RAM 对象）；异作用域 RAM 残留（未经 watch 清理的异常路径）入孤儿区不展示给新身份。
7. **watch 语义**：保持默认 flush（'pre'）。曾评估 flush:'sync'——但 `endSession` 先 bump 后清状态，sync 会在状态未清时读到旧确认态而漏清，故不采用；RAM 清理为下一微拍，在途数据安全由 epoch（同步推进）保证，A06 测试在 endSession 后 `await tick()` 再断言。
8. **mock 排序语义**（测试基础设施，phase-r1-push）：缺失 sortKey 行按 null 排最前（MongoDB BSON 升序 null < string，TCB 文档库同源）。真实平台对缺失字段在 orderBy 中的确切行为未逐版验证——保守假设"缺字段先返回"，保证升序扫描必然遇到 legacy 行（完整性契约的保守侧）；依据与不确定性已注明在 mock 注释。

## 四、A01–A10 证据（生产入口 → 场景 → 日志）

| ID | 生产入口 | 反例场景（phase-r1-push/tools） | 结果 |
|---|---|---|---|
| A01 | mc-daily-push `exports.main` → `resolveCaller` | A01：intruder/无上下文 × {Type/TriggerName/混合+sendNow/kind} 共 10 组合，断言 pregnancyReads=0、checkupQueries=0、sends=0 | ok |
| A02 | 同上 + `event.action!=='sendNow'` 拒 | A02：白名单 mama sendNow 正常发 2；mama+伪造 TriggerName 仍是 sendNow 语义（不触发前夜文案）；timer 字段无 sendNow→bad-action；intruder sendNow→not-family-member | ok |
| A03 | 同上（无平台凭据一律按认证拒绝） | A03：真实定时器形状（无调用者上下文）→ `unauthenticated`、读库 0；注入遗留 `process.env.WX_CONTEXT_KEYS/TCB_SOURCE` 仍拒绝 | ok（fail-closed，部署门槛见 §九） |
| A04 | toolsStore `startFetalSession/recordFetalClick/finishFetalSession/startContraction/stopContraction` 消费 persistFetal/persistContra 布尔 | A04×2（胎动/宫缩）：quota 注入+离线全链 local-persist-failed（绝不 offline-pending）、内存草稿保留、恢复后同 opId 收敛；页面入口场景：toast 含"本地保存失败/重启会丢失"+ fetalUnsaved 横幅真值 | ok |
| A05 | finalizeLocal* 耐久序 + restoreFromCache | A05：正常离线冷启动恢复（queue/history/stop 凭据）重试一次补齐；审核5×2：仅 queue 写失败 → active+journal/stopOp 保留、冷重启同 opId 收敛不双写 | ok |
| A06 | watch + clearToolsMemory + flush 逐段身份校验 | A06+A08：logout→papa→另一家庭不展示/不上传、legacy 键字节级保留；A06+R7 同成员复核不清草稿 | ok |
| A07 | captureSession/isSameSession + 每 await 后校验 | 审核7×3（在途响应丢弃/分页逐页/队列逐项）+ R2-1（旧 retry 在途切身份立即结束，contraction.start 恰 1 次、papa fetal_active 零写入、mama 磁盘不动） | ok |
| A08 | LEGACY_KEYS 不读不写 + restore 只读作用域键 | A06+A08 场景 legacy 五键原字节断言；孤儿区 papa 不可见不上传（审核8） | ok |
| A09 | `pendingCheckupOnDate`（dateKey=明日下推） | A09：昨日 overdue+明日 pending 并存仍发前夜；仅 overdue/仅后天/空/明日全墓碑 → 安静 skipped | ok |
| A10 | `walkPendingCheckups`（sortKey 升序游标分页遍历墓碑）+ 单一时钟快照 | A10：250 同日墓碑后有效记录照发（查询≥3 次）；daily 乱序+150 墓碑前缀仍选昨日 overdue（`产检已过1天`，与 +3 天/陈旧选取可区分），checkupQueries=2；DB 异常 checkup-query-failed/pregnancy-read-failed 可区分；审核3 冻结时钟 + R2-7 await 期间跨午夜整条日期一致 | ok |

## 五、第一轮审核意见（R1_REVIEW_NOTES）落实

1. 合成游标假兼容 → 已改为完整性契约：遇缺 sortKey pending 行立即 `checkup-scan-unstable` 明确失败，绝不静默漏读（A10/审核1-2 混合正常记录反例：push-run3）。
2. `pendingCheckupOnDate` 提前终止前提 → eve 改为 dateKey 精确下推查询，不依赖排序提前终止；全页遍历该日墓碑（A09）。
3. 多次读时钟 → `dateSnapshot(Date.now())` 单一快照贯穿构建/匹配/回复（审核3 + R2-7 await 推进反例）。
4. watch 基线 null 漏清 → 创建时以实际确认会话初始化（审核4 场景：首次通知即换人立即清）。
5. 终态 queue 先写方向 → finalize 耐久序（queue→history→清 active；queue 失败保留 active+journal/stopOp，冷重启同 opId 收敛；审核5×2）。
6. 隔离失败吞返回 → freezeKey/cacheWritable 冻结 + 补试隔离；corrupt/读取异常键 retry 后原字节不变零上传（审核6+R2-6）。
7. 异步队列入口身份校验 → 入队捕获+开工校验、分页逐页、retry 逐项（审核7×3 + R2-1）。
8. clearToolsMemory 丢草稿 → RAM 孤儿区（进程存活期有效，如实披露；原作用域回接，R2-2/R3-1 同 localRef 以 RAM 最新输入为准）。
9. scope 校验/键碰撞 → env/app/家庭/成员四部件非空校验 + 无歧义编码（R2-3 反例：`a_b/c` 与 `a/b_c` 键不同、`fam_a` 合法可用、空 familyId 才拒绝）；恢复结构校验见 §七第三轮 4。

## 六、第二轮审核意见（R1_REVIEW_ROUND2）落实

1. retryPending 在途身份 → 入口捕获 active/rec + 每 await 后 `sameIdentity()` 立即 return + persist 带 capturedScope 守卫。反例 R2-1（tools-run4）：mama fetal 在途切 papa 并建宫缩，旧 retry 仅 1 条 stale 结果、contraction.start 恰 1 次（papa 自己）、papa fetal_active 零写入、mama 磁盘 active 原字节。
2. 同 localRef 孤儿草稿回接 → restore 孤儿循环以 RAM 最新输入覆盖盘上旧 active（同 localRef/空位），未保存标记保持。反例 R2-2×2：click/stopOp 恢复、同 opId 收敛服务端不双写。
3. underscore 家庭误拒 → 见 §三.2。反例 R2-3。
4. finalize 未推进 note*Persist → finalizeLocal* 内部以最终 keys 结果调用 noteFetalPersist。反例 R2-4：仅 history 写失败 → fetalUnsaved 立即真、云端重放成功不遮蔽、存储恢复后真实解除。
5. 恢复结构校验不足 → 见 §七第三轮 4（第三轮加严后覆盖）。R2-5 反例：journal 非数组/缺 startTime/queue stopOp 缺 endTime → invalid-shape 冻结零外呼；异 scope fetal history 不显示。
6. 恢复警告未真实披露 → 恢复闸 + 页面持久横幅 + 显式确认（§三.4）。反例 R2-6：corrupt → onShow 零外呼零上传、retry 不消警、ack 解冻但警告保留、重恢复不重复弹闸。
7. push daily 150 用例不成立 → 重写为可区分用例（§四 A10 行）：乱序注入+150 墓碑长前缀+昨日 overdue/3 天后并存，断言 `产检已过1天`（错误选取必落提示行，可区分）+ checkupQueries=2 精确计数；legacy 用例保留正常记录混合（不删正常项缩水）；mock 缺失 sortKey 排序语义按 BSON null 最前并注明依据/不确定性（§三.8）；跨午夜用例改为 db await 期间推进时钟（孕周按入口快照 `孕1周+6`，漂移则 `孕2周+0`——可区分）。

## 七、第三轮审核意见（R1_REVIEW_ROUND3）落实

1. 同成员再次 onShow 覆盖未保存 RAM → restore 仅在 RAM 无同作用域活跃会话时采纳盘上副本（§三.6）。反例 R3-1：真实页面 onShow（fetal-timer bundle，setInterval 已在测试侧防泄漏）后 RAM 引用/未保存 click/journal opId 保留、盘上旧版本未被伪成功覆写、宫缩 stopOp 同理；恢复后同 opId 收敛。
2. 备份失败覆写/提示不真实 → quarantinePartial 消费备份布尔（失败→`scope-foreign-unbacked`+冻结）；宫缩 history 条目携带 scope 并过滤异作用域；页面按状态区分"已隔离备份/未能备份"。反例 R3-2：混合 history+备份失败 → 异成员条目不显示、ack 后新操作仍写不进（原字节一字不动）；备份成功路径隔离副本落地；页面文案 corrupt-frozen 时含"未能备份"、确认含义=仅解除自动同步暂停且不删警告。
3. 云终态成功+清空写失败冷恢复 → 凭据不提前 wipe（§三.3）。反例 R3-3×3（finish/discard/stop）：仅 active=null 清空写失败 → 盘上留终态标记+journal/stopOp 凭据、fin 如实 local-persist-failed+cloudSynced；冷重启不复活（currentFetalSession/activeContraction=null）、服务端恰 1 终态文档、opDocs 集合不变（opId 不重造）。
4. 校验覆盖实际访问字段 → validFetalJournalOp 校验 finish payload.endTime（外呼参数）与 payload 类型；validFetalClicks 拒绝 null/畸形 click（recompute 崩溃源）；sessionId/非空字符串、serverRevision/整数、pausedAt/targetDurationMs/recordId/intensity/notes/intervalSec 类型约束（畸形不进内存即不外呼）。反例 R3-4：4 类畸形（clicks:[null]、finish payload 缺 endTime、serverRevision='x'+sessionId=123、intensity 对象）全部 invalid-shape 冻结、零外呼、原字节隔离保全。正常格式未为校验新增冗余字段（宫缩 history 的 scope 为所有权标记，与胎动同构，属格式演进而非校验冗余）。

## 七点五、终审意见（R1_REVIEW_FINAL_DETAILS）落实

1. **隔离副本使用原始 raw 字节**：`readOrFreeze` 成功分支携带 `st.raw`；`freezeShape` 与 `quarantinePartial` 备份 `r.raw` 原字节（此前 `JSON.stringify(r.value)` 重序列化——空白丢失、超安全整数变形，不等同原始存储字节）。反例 终审1×2：带空白+`1e21` 的结构异常 JSON、含 `12345678901234567890` 的混合 scope history——均断言隔离副本内容与原值**严格相等**（非仅备份键存在），并附用例自检（该输入下重序列化必然变形，能抓住旧缺陷）。备份失败后的禁覆写要求不变（终审2 反例再证）。
2. **freezeShape 备份结果传到 warning + 孤儿 RAM 恢复不归为已备份**：`freezeShape` 消费 `freezeKey` 布尔结果——失败产生 `invalid-shape-unbacked`/`scope-foreign-unbacked`（入 INTEGRITY 列表落闸），不再把备份失败显示成"已隔离备份"。页面三态如实：已隔离备份 / 未能备份（原数据保留未动）/ `orphan-draft-restored` 单独表述为"已从内存恢复——数据仍未保存到本地存储"（RAM 恢复无耐久备份动作，不宣称任何备份）；同步状态随确认联动披露（未确认=已暂停，已确认=已恢复）。反例 终审2×2（store 级）：结构异常/异 scope active + 隔离写失败 → `-unbacked` 状态、原字节保留、零外呼、确认后自动同步解冻但该键写入仍受控（无耐久备份不覆写）；终审2 页面级×2：备份失败页面说"未能备份"+确认后"已恢复"如实、仅孤儿恢复时不含任何备份宣称且不落闸（未保存横幅另在）。

## 八、测试证据（命令 / node 退出码 / 计数 / 日志 / SHA256）

命令均为 `node tests/<套件>.regress.cjs`（cwd=项目根；phase-r1-* 与 e1-* 自行执行 `cloud/assemble.mjs` 组装 DIST 后加载真实 handler/页面 bundle，全部本地 mock）。**终审修复后（当前源码状态）的最终结果：**

| 套件 | node 退出码 | 通过/失败/跳过 | 原始日志 |
|---|---|---|---|
| phase-r1-tools（含终审 4 场景，共 29） | 0 | 29 / 0 / 0 | /tmp/momcare-repair-20261001/tools-final2.log |
| phase-r1-push | 0 | 10 / 0 / 0 | /tmp/momcare-repair-20261001/final2-phase-r1-push.log |
| phase-n-daily-push | 0 | 31 / 0 / 0 | /tmp/momcare-repair-20261001/final2-phase-n-daily-push.log |
| phase-e1-client / e1-page / e2-client / e2-page / e3-client / e3-page / f-audit | 0 | 7/4/3/4/5/5/5 全 0 失败 | /tmp/momcare-repair-20261001/final2-*.log |
| phase-l-daily-tip-core | 0 | 28 / 0 / 0 | /tmp/momcare-repair-20261001/final2-phase-l-daily-tip-core.log |

终审修复前的历史轮次证据（源码已演进，仅作过程记录）：tools-run4.log（25/0）、push-run3.log（10/0）、phase-n-run2.log（31/0）、e1-client-run2.log（7/0）、related-*.log、full-*.log + full-suite-summary.txt（全量 63 套串行：62 套退出码 0；phase-b2b1 一次无断言输出的中途退出，单独重跑 b2b1-rerun.log = 63/0/0 退出码 0 不可复现，留待独立验证会话复核）、tools-final.log/push-final.log（25/0、10/0 确认重跑）。

历史 SKIP：仅 phase-b1 一处既有 SKIP（套件内注明：依赖已移除的共享/私人编辑器；full-phase-b1.log:33），与本次改动无关。e1-client 的 Z9 冻结源哈希场景通过（运行期间源未被并发编辑）。当前 `ps` 无任何遗留 node 测试进程。

SHA256（shasum -a 256，2026-10-01，**终审修复后的当前状态**）：
```
124dc9a2dc469dee4c4c48adb7be407e77f0b2ea6d9892e3ef9dc810a70ac60b  services/toolsStore.js
cc1e1a5380f170b05b6513215031593dfda27b07f5b9a5a582310218c77e044f  pages/tools/fetal-timer.vue
b801a06582dc1517bfe2722a89ec3b33ecd1ae3c5f1236d17216ba53700354fe  pages/tools/contraction-timer.vue
c80772b7262e5a4267bbebf74420fca111817a8d357e4dc5770eacb096e1e897  cloud/functions/mc-daily-push/index.js
269efe58baacf006ae13a0350a02201a3cd30f58b6ff11f21295daf429754e0f  tests/phase-r1-tools.regress.cjs
d92a2d227e1f11bf7a241d213d9a324e916efc2302c0aa1b076aa032b66d104c  tests/phase-r1-push.regress.cjs
ad6b129f71f011ce12d66e3f5c1e45c4d9fe0b55cdaf3c8ac078a8069b2e867a  tests/phase-n-daily-push.regress.cjs
58a05bbca26e68014650364f6b67f5845a1b7acdf8a226f8ed051852fdd65314  tests/phase-e1-client.regress.cjs
```

（终审修复前历史 SHA：toolsStore `52bb09b1…`、fetal-timer `837357b2…`、contraction-timer `86c4d4c3…`、phase-r1-tools `c3e9e8c6…`——对应 tools-run4/push-run3 时刻的状态。）

## 九、SDK 身份依据与定时功能限制（部署门槛，未验收）

- 本机 wx-server-sdk / CloudBase SDK 源码缺席（第一轮编码任务纠偏后未再联网查找）；第一轮审核记录中 Codex 摘录的微信官方 SDK 源码显示 `getWXContext` 读取 `process.env.WX_CONTEXT_KEYS`/`process.env.TCB_SOURCE`——不能证明逐次调用来源无环境遗留，且不证明当前部署版本/定时器具体来源值。据此 timer **fail-closed**：真实定时触发会被白名单认证如实拒绝（`unauthenticated`）。
- **明确限制：定时推送（9:00 日常、21:30 前夜）当前不可用；唯一可用入口是白名单成员 `sendNow` 手动试发。** 部署前必须补：可信 per-invocation 定时身份证据（或独立 scheduler worker + 平台权限规则实测），并在真实环境验收触发器配置。此门槛同时记录于 cloud/DEPLOY.md 契约与本文件；不以本地 mock 宣称平台验收。
- 其余平台相关限制：43101 配额行为、真实模板字段、真机订阅额度均未经真实外呼验证。

## 十、旧套件适配说明（非改弱）

- **phase-n**（9 场景原失败）：① mock 查询面升级为 where/orderBy/limit/get + command.gt + sortKey 排序（对齐 walkPendingCheckups 的真实调用面——旧 mock 缺 orderBy 会把一切 sendNow 误判为 checkup-query-failed）；② 种子产检行补 `sortKey`（生产 mc-schedule 写入本就携带，旧种子缺字段按新完整性契约会正确失败）；③ N10/N10b/N11/N15/N18/N19 入口由伪造 `{Type:'Timer'}` 改为白名单 `sendNow`（A01–A03 后伪造 timer 必须被拒——这是设计变更而非放松；phase-n N10 同时新增伪造 timer 拒绝断言保持警觉），**全部内容断言（字段映射/落地页/体验版态/倒计时移除/配额跳过/前夜文案/安静退出）原文未动**；④ N14 fail-closed 链改经认证 caller 触达（断言码不变）。
- **phase-e1-client**（2 处）：`momcare_fetal_active_session`/`momcare_active_contraction` 旧固定键断言改为 R1 作用域键（A06–A08 设计变更：旧键按 A08 保留隔离不再写入），断言语义（落盘内容/startTime 一致）不变。
- 未修改任何旧安全探针以掩盖失败；phase-b3* 伪造 canonical/未知字段等安全套件全量通过。

## 十一、未解决限制与诚实声明

1. 定时功能未闭环（§九）；2. RAM 孤儿区仅进程存活期有效（冷启动即失，页面/代码注释已披露）；3. 降级路径下（服务端已完成、本地归档持续写失败）RAM 终态记录短暂显示为进行中，未保存横幅在位、重试收敛（stopContraction 对该态返回 invalid-state 拒绝二次 stop）；4. flush 终态成功与 queue 切片之间存在极窄崩溃窗口（磁盘 queue 可能留下带终态状态项 → 恢复时整键隔离冻结+确认路径，无数据丢失、服务端已有数据）；5. 全量串行时 phase-b2b1 出现过一次无断言输出的中途退出，单独重跑不可复现——留待独立验证会话复核；6. mock 对缺失 sortKey 的排序语义为保守假设（§三.8），真实平台行为未实测。以上均不以测试总数替代逐项验收。Codex 未运行任何测试、未修改业务代码；本文所有执行结果由 ZCode 产生，等待审核。
