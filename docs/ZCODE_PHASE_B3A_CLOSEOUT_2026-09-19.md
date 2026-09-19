# B3a 收尾清单（历史评审任务；2026-09-20 本地代码验收已通过）

以下未勾选条目保留了当时的故障审查上下文，不代表当前冻结版本仍未实现。最终判定与源码/测试哈希、独立回归记录以 [B3 review](PHASE_B3_REVIEW_2026-09-19.md) 末尾的 2026-09-20 验收记录为准；真实 CloudBase 和真机验收仍延后。

基线 e0cf22f。当前 rev4 报告“8 个探针全 PASS”不成立：Node 原退出码复核 unknown-schema 仍 exit 1；孕期/产检预览通过不代表页面能执行。未提交、不部署。本文将旧 review 中重复条目收敛，按顺序关闭；每项完成应有真实生产路径+永久测试证据，不能仅改文档。

## 1. 持久请求与现有输入

- [ ] 固定迁移 opId 与完整 kind/entity/date/expectedRevision/extra/payload 绑定；不能借用同 payload 的普通请求 ID。
- [ ] 固定迁移意图和普通未发送草稿不能互相合并覆盖；已发送意图不可改写；保留普通编辑已有行为。
- [ ] 同源原键/备份/重复确认使用相同目标身份；正文版本作为候选，不能因为 sourceKey 或正文后缀变化新建同源副本。同 ID 不同正文一次只能确认一个。重复确认已完成的同正文应对账为已迁入，不是仅靠同 targetId 让第二次变成 revision 冲突；迁移回执/稳定意图需跨后续批次保留。
- [ ] 冷启动不可读/损坏批次不得当作空并覆写；原始恢复字节保留。冷启动/丢响应/完成标记失败复用原 ID 对账，已有/较新/已删除不覆盖、不复活。所有权绑定 family/env/app/member，不只 memberId。
- [ ] 私人确认/选择在身份或来源变化时清空，confirmEntities 必须对应当前扫描规范化记录，不能接受任意伪造 fields 或未确认私人作者。

## 2. 附件真实恢复（不能只有错误提示）

- [ ] 完整有序槽位映射：同页 file_urls/localPaths 对应而非拼接；永久本机/微信有效路径；遗留云 ID/任意 HTTP 不是授权。保留原件。
- [ ] 每个 uploadId 在 prepare/直传之前持久；临时源先保存可恢复原件与 manifest，磁盘/保存失败保持可找回输入。
- [ ] 任何一页未成功注册则不创建报告；已成功项重试复用登记，不重建/不丢页。
- [ ] 每个 await 后、下一副作用前核验 epoch，切成员后业务请求必须为零，而不只是最终没建报告。
- [ ] 实际缺失原件重选入口、原件映射重新确认、持久进度与冷启动续传；manifest失败不能遗失新选择。前端真实处理器测试。

## 3. 来源/映射/可处理状态

- [ ] 已知旧 HEALTH schemaVersion=2 等明确兼容规则；999/未知版本/错根结构对原键与备份同样隔离。不能看到 records 就忽略版本。
- [ ] 备份失败阻断；原始备份不可覆盖旧副本，独立新键保存当前原始内容并验证成功。
- [ ] 孕期根 ISO 日期按上海日号映射，dueDate、nickname/babyNickname/hospital/doctor/hospitalPhone 及支持字段不漏；真实旧 userInfo.preWeight→preWeightKg、height→heightCm（参见 health.js 609-618、pregnancy-info.vue 318-325，严格数字解析）；页面实际 savePregnancy 路由可执行。
- [ ] HEALTH.checkupSchedules 真正通过 saveCheckup 迁入，status 用受支持参数；未支持 department/time_slot/notes 等明确显示保留未迁部分，不悄悄遗失。
- [ ] 数值/症状/计划/日期严格类型，不把布尔、空串、错误单位、非法日历或超长文本静默变成有效值；不支持字段留隔离并提示。
- [ ] 预览显示实际私人内容、共享报告 note 和领域中文说明；来源/进度使用“健康记录、报告、历史备份、待处理、已迁入”等可理解标签，不把存储键/英文状态/operationId 作为主要用户文案，用户能判断所确认的范围。
- [ ] 出错、源变化、备份失败、磁盘失败、冲突都有可见反馈和可达处理动作。持续存在旧未完成批次时不能让新预览/重新确认入口永久失效。
- [ ] privacy 权威统计包含实际需要的数据拉取、排除删除记录；未确认/演示不显示上一成员数据，不报假同步/假清除成功。

## 4. 永久验证与冻结

当前 11 项永久测试仍用手写 executor 且含宽松成功条件，不能作为完整交付。由 ZCode 增补真实 privacy/扫描页处理器 → store → outbox → cloud handlers 的强断言：所有支持域、至少两张有效 PNG、丢页/重选/重启、磁盘失败、来源/身份变化、旧token/private canary、已删除、普通草稿交错、重复来源/正文选择。

Codex 独立脚本：
- /tmp/momcare-b3a-page-audit.cjs（每个 case 单独执行并检查原退出码）
- /tmp/momcare-b3a-privacy-audit.cjs mode/sync/clear
- /tmp/momcare-b3a-unbound-audit.cjs
- /tmp/momcare-b3a-sha-audit.cjs

已知 page case：daily/private/demo/backup/backup-fail/backup-preserve/unknown-schema/source-changed/persist-fail/conflict/pregnancy/checkup/pregnancy-exec/checkup-exec/symptoms/paired-attachments/missing-report/partial-original/upload-switch/stable-op/ack-disk-fail/borrowed-op/unsent-draft/backup-reimport/conflicting-source-choice/lost-response/manifest-corrupt/family-switch/selection-switch/changed-reimport/deleted-reimport/multi-original/upload-intent/other-member-batch。窄 case 通过不等于其他需求可以省略；例如 upload-switch 已加强为切成员后零业务调用。

先修生产路径及对应窄测试，全部完成再一次性跑 B3a + 受影响既有阶段回归/双端构建。Node 输出重定向到文件后捕获原退出码，不能用管道尾命令 exit 0 替代。冻结列全部源码/永久测试 hash，Codex 复核后才能提交推送。B3b/C/D 仍在后续，不提前部署。

可运行 `python3 /tmp/momcare-b3a-review-runner.py` 汇总全部当前独立入口（保存 Node 原退出码和前后源码 hash）；runner 绿色仍需完成上述未覆盖页面/原件恢复范围及永久测试。

实现核对提醒：页面 doConfirm 必须传明确 entityKey 或由服务根据匹配 preview 取 domain/entityKey，不能用 sourceId.split(':').pop() 推断（不同正文有 @digest 后缀，旧 ID 也可能含冒号）。每个候选都要有 contentDigest，包含不同正文候选；单独选择历史版本应可确认，不能以 field-mismatch 偶然让“双选拒绝”测试绿色。私人实体作者确认在 service 中也需生效。

最后几处具体源码定位：familyStore.submit 的 stableOpId 重放分支在 const expectedRevision 声明之前读取它，并引用未定义 extra，均与 esbuild/dynamic import 无关；先构造完整请求快照。migrationStore.executeBatch 在 stats.conflict>0 时返回 ok 仍为 true，且把 done-unpersisted 的 revision-conflict 直接当 done 缺少服务端对账依据，应依赖同请求幂等/当前权威记录，不能吞冲突。

回执实现禁止只记 targetIds：changed-reimport/deleted-reimport 已证明它会吞掉真实冲突、把未迁入的新内容或已删目标标 done。用 scope+canonical source+内容/附件摘要+原 opId+权威版本绑定回执，并核验当前记录/墓碑；失败必须保留冲突。

损坏检测必须精确针对当前 env/app/family/member 的批次：不要 `getStorageInfoSync().keys.some(k => k.includes('b3-migration'))`，否则另一成员有正常批次也会让当前成员“损坏”，切身份后的 batchCorrupt 也需按当前作用域重算/清空。无法读取存储或枚举失败不能当不存在。现 receipts 的正文摘要方向正确，但仍须核对当前权威记录 deleted/revision，并处理回执写盘失败；不能只用本机 done-unpersisted 直接吞 conflict。

源变化后的可达恢复方案：提供“保留旧批次并重新预览”，先将原批次/附件/恢复信息按原 scope 写入独立历史键并核验落盘，再切当前批次；写盘失败保持原态。已可能发送的意图先对账，不能用新 opId 绕过。新确认仍用 canonical target，已有或较新目标走冲突；不删除旧原件。也可采用等价的持久历史批次模型，核心是不能 source-changed 永久卡住、也不能简单 batch=null 丢恢复信息。
