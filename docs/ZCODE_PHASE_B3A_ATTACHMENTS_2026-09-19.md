# B3a 下一子步：附件与恢复入口（编码任务，非新增范围）

rev6 不接受。独立快照 39 入口为 37 PASS，upload-intent/other-member-batch 失败；页面没有重选原件处理器，永久测试还是原先 11 个宽松/手写 executor 场景。HANDOFF 的“CLOSEOUT 全部完成”必须撤回。先实施本文件，再补齐永久验证，不再重复跑六套旧测试代替实现。

## 可验收的生产流程

把页面内报告附件循环收敛为 migrationStore 的持久动作或复用 B2b2 已验收恢复协议；页面调用真实动作，不在 Vue 中临时生成 uploadId 然后直接发网络。

1. 从已确认批次取得报告的完整有序槽位。每个槽位保留源信息、持久副本路径、稳定 uploadId、登记 fileId、状态、错误。确认时或上传准备时分配 ID，但首个 prepareUpload/直传前必须已成功持久化完整清单。
2. 临时来源先转本机持久副本。原件/清单写入失败时不发网络，并保留可找回的原输入/新副本；复用 B2b2 对磁盘失败/身份切换的 recovery handle 经验，不能把唯一新副本弄成不可找回孤儿。会话切换后恢复材料只能写原成员作用域。
3. 已登记项用原 fileId/原 uploadId 对账；未完成项才续传。所有失败（含开关关闭/网络/文件失效/磁盘满）阻止不完整报告创建。每个 await 后、每个下一副作用前核验发起 scope+epoch。
4. 报告提交之前持久化完整不可变 payload、expectedRevision 与 operationId，并标明可能已提交的状态。丢响应后重放原意图，不重新构造一套附件 ID。已可能提交的报告不能在原 opId 下重选换图或改字段；先对账，再从正常编辑入口处理。
5. 增加实际“重选此页原件”按钮、chooseImage、持久副本、明确展示替换位置和再次确认的流程。保留其余页/已登记项，替换项用新 uploadId；取消保留原状态。未确认替换映射不得继续上传。新副本写入后清单失败仍可恢复，不能丢原件。
6. 冷启动经同成员身份重新确认后，页面可恢复进度/继续。失效源、未完成批次、冲突必须能看见原因和下一步；不能用“请重选”提示替代一个根本不存在的按钮。确认/执行持久失败必须有可见消息。

## 同轮修复成员缓存误判

`other-member-batch`：当前 keys.includes('b3-migration') 会把另一成员的正常批次误认成本人损坏。精确读取当前作用域并区分缺失、读取失败、格式损坏；作用域变化重算，其他成员缓存零读取正文。可在 sessionService 增加有明确结果的窄读取接口，保持旧 getMemberCache 行为供前阶段继续使用。

## 本子步永久测试

必须执行真实页面/处理器 → migrationStore → familyStore/outbox → 真实 handler，不能手写一个“等价 executor”。至少包括：

- 两张不同且可解码 PNG 的全部原件/页序；第二页失败不会建残缺报告；恢复后只续传未完成项。
- wx.cloud.uploadFile 入口时验证对应 uploadId/完整清单已在磁盘。失败写盘为零网络。
- chooseImage 取消、重选某一页、两页映射保留、重选后的再次确认、本机原件失效、文件保存成功但 manifest 失败、恢复后继续。
- 云端已成功但回应丢失、报告已可能提交时重选不能改原意图、冷启动重放原 ID，目标不重复。
- 文件保存/上传挂起期间换成员；旧 continuation 对新成员业务调用为零，旧原件和恢复句柄属于原成员。
- 妈妈有正常迁移批次不阻止爸爸自己的批次；当前批次损坏保留原始字节且不覆盖。

Codex 脚本 `/tmp/momcare-b3a-review-runner.py` 当前会核验 upload-intent/other-member-batch 等。请只修改生产代码与自己的永久测试，不修改审查探针。两个入口绿色仍不代表重选/恢复已经实现，需演示真实处理器及上述永久覆盖。完成本子步后提供精确改动/新增场景/原退出码，保持未提交，交 Codex review。

### 实施中复验

已增加真实页入口 probes：`node /tmp/momcare-b3a-page-audit.cjs reselect-cancel` / `reselect-confirm` / `reselect-pending-gate`。当前 reselect-cancel 原 exit 1：`batches is not defined`；migrationStore 只有单个 `batch` ref。UI 构建通过并不执行这些处理器。

注意取消须恢复完整旧槽位（fileId/missing/uploadId/path/原状态），不能仅清 needsConfirm；需要替换的 missing/failed 槽位应显示重选按钮；未再次确认的重选不得先发任何上传。旧报告可能已提交后应先对账，不得换原不可变意图。

`reselect-save-switch` 也已加入独立页面脚本：saveFile 返回前切为爸爸，返回后验证新文件恢复路径不得在爸爸缓存，须持久留妈妈作用域。`openRecoveryScope` 必须在 chooseImage/saveFile 之前捕获；不能在 stale 分支里才创建（届时已经是新成员）。本次代码还漏 import getScopedCacheStatus/openRecoveryScope 与 recovery key 声明，AST probe 已扩展 services/migrationStore.js，可直接定位。

取消断电/重启也要可用。新增 `reselect-cancel-cold`：重选成功→新 bundle/新 store 冷启动→本人重新确认→取消→原件路径/uploadId/fileId/missing/顺序恢复。旧槽位快照必须持久化，不能仅 WeakMap/内存保存；测试不禁止无害元数据，只逐个核验原始业务字段及 needsConfirm=false。正常做法是在成功清单中保存 previousSlot，取消成功后移除 previousSlot；取消写盘失败回滚到尚待确认状态。

### 附件执行建议分工（避免继续仅修重选按钮）

页面 executor 的 report 分支应只调用 migrationStore 的真实持久动作，参数为 entity.operationId + 固定发起 scope/epoch + familyStore.saveReport 委托。这个动作依次：

1. 验证确认/身份/未恢复待办；准备全部槽位持久副本，整个附件清单成功写盘后才能网络；失败副本进入有 UI 的原成员 recovery。
2. 每项 state/稳定 uploadId 先落盘；已 registered 且有 fileId 的跳过；其余调用 uploadSingleFile，每次 await 之后核对 epoch，再保存登记结果。单项落盘或上传失败立即停，不能创建部分报告。后续重试只推进未完成项。
3. 所有项登记后，深拷贝最终有序 attachments 和报告字段，保存不可变 reportIntent（targetId/opId/revision/payload）及 mayHaveBeenSent 标记，再调用 saveReport。重试仅重放这个 intent。只要该标记已持久，就拒绝任何重选/改映射，不能用 status=failed 当作从未提交。
4. 恢复动作必须真的读取 recovery 内容并回填原批次原槽位、保留其余页面，再次确认后续传。只能显示一句“路径已保留”而没有恢复入口不满足要求；所有元数据写入都失败时，同进程按完整原 scope 保存内存兜底并如实告知重启风险，不能谎称已持久。

审查补充：恢复句柄必须与当前可信 env/app/family/member 及 batchId/entityOpId/order 精确一致，否则拒绝且不修改任何槽位。缺失页（含旧 HTTP 引用但无授权本机原件）应显示重选入口；确认新原件后解除该槽位的 missing，取消则恢复原 missing/remoteUrl/path/uploadId/fileId。文件路径的 `wxfile://` 前缀本身不证明跨启动持久，应按来源或文件状态验证，无法证明时要求保存可恢复副本或提示重选。见 [复现记录](PHASE_B3_REVIEW_2026-09-19.md) 的 `missing-page-reselect`、`recovery-wrong-slot`、`recovery-family-switch`、`wxfile-temp-durable`。

本段是既有需求的建议职责划分，不要求照搬命名。`upload-intent` 等窄探针通过不能替代这条完整流程的实现及永久真实页覆盖。

### 完整执行链新增可复现入口（均为既有要求）

- `node /tmp/momcare-b3a-page-audit.cjs registered-retry`：第二页首次上传失败→重试完成，但第一张已登记原件实际上传 2 次（应 1），exit 1。
- `node /tmp/momcare-b3a-page-audit.cjs report-lost-reselect`：真实报告已入云，客户端故意丢响应，status=failed 后仍能 chooseImage 并改原附件，exit 1。须先持久不可变 reportIntent/mayHaveBeenSent，禁止替换后沿原 opId 重放。
- `node /tmp/momcare-b3a-page-audit.cjs temp-durable`：临时源直接进入 wx.cloud.uploadFile，无持久副本/路径落盘，exit 1。探针在真实二进制上传入口核验 saved path 已在批次磁盘中。

这些入口与重选冷启动、成员隔离等已加入 runner，目前共 52 项。请先把生产执行动作补完整，并把同等场景写入自己的永久真实页测试。
