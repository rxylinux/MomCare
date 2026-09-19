# B2b2 覆盖矩阵（最终，对应 CLOSEOUT 八项）

对照 `ZCODE_PHASE_B2B2_SPEC_2026-09-19.md`、`PHASE_B2B2_REVIEW_2026-09-19.md` 全部终节与 `ZCODE_PHASE_B2B2_CLOSEOUT_2026-09-19.md`。

## 验证命令与结果（最终源码）

| 入口 | 命令 | 结果 |
|---|---|---|
| 永久回归 | `node tests/phase-b2b2.regress.cjs` | 33/33 |
| Codex review-runner | `python3 /tmp/momcare-b2b2-review-runner.py` | 58/58 入口，sourceFreezeStable（19 源码文件） |
| 兄弟回归 | `node tests/phase-b2b1.regress.cjs` 等 4 套 | 53/42/42/72 全过 |
| 构建 | `npm run build:h5` / `npm run build:mp-weixin` | 0 错 |
| 引用 | `/tmp/momcare-b2b2-unbound-audit.cjs` | 0 未绑定 |
| git | `git diff --check` | 干净 |

## CLOSEOUT 逐项对照

| # | 条目 | 实现 | 验证 |
|---|---|---|---|
| 1 | draftChanged 确认实际转移草稿进编辑 | modal 确认回调：epoch 绑定 + persistEditDraft（含创建基线 revision1）→ navigate classify p6 编辑模式；取消保留草稿 | classify-page draft-changed-feedback |
| 2 | 草稿生命周期（hydrating 有效抑制；提交取消待执行 autosave；真实编辑即时保存保持） | fill/applyEditDraft `nextTick(() => hydrating=false)`；保存成功先 clearTimeout 再 clearEditDraft；watch 保持 | draft-persist / edit-draft-restore |
| 3 | 报告同步入口 | index 冲突卡用 `familyStore.conflictEntries` 直接响应式筛选（无 require）；待同步数量+重试横幅；classify/detail 冲突 toast 1.2s 后 navigateToPage('/pages/archives/index')；冲突卡显示删除状态+采用云端/确认重提 | index render / conflict-page |
| 4 | 策略迟到门 | refreshUploadPolicy 入口捕获 epoch，await 后核对——切换不写当前 uploadPolicy | policy-retry + 代码 |
| 5 | 旧 URL 正式隔离 | classify pendingUpload/fileUrls 消费仅 `isExplicitDemo()`；正式只走 reportId/batchId 受控链路 | batch deep-link / unbound |
| 6 | 恢复完成 | 未处理恢复阻止新批次（recovery-pending）；discardRecovery 先 persistRecovery 标记 cancelled，失败保留原件可重试，成功再删副本+清 RAM map | recovery-two / recovery-memory / recovery-switch |
| 7 | 永久证据 | store1 逐附件 deepEqual/SHA256/大小/全序断言（真实可解码 PNG 按路径携带）；32 场景含页面/草稿/恢复/下载退出边界 | tests/phase-b2b2.regress.cjs |
| 8 | 最终文档 | 本矩阵 + HANDOFF 重写（无过时宣称） | — |

## 原始 SPEC 逐项覆盖

### 服务端（mc-reports / mc-files）
稳定 ID 全分支 / family+kind 幂等绑定 / 事务引用记账 / 墓碑防复活 / 真实 SDK deleteFile 契约 / 清理分页+补偿 / getReadUrls 迟到门 / 裸 getReadUrl everAttached 门 / 创建完整性 / 部署元数据（10 集合+索引）→ **server-audit 23 组 PASS**

### 上传服务与批次 store
单文件管线 epoch 门 / 完整清单网络前落盘 / 槽位保留 / 逐项推进 / 重启恢复 / **终版创建协议**（意图阻断门/成功即完成/对账只确认/已删不重建） / 恢复边界（受限作用域/身份隔离/阻止拼接/完成后不复活/discard 持久优先）/ 策略迟到门 / 重选完整批次保留 / 编辑草稿 own-note 语义+基线 → **batch-audit 15 组 PASS**

### 页面（真实处理器/模板）
UploadSheet（原件/操作 epoch/单次交付）/ index（模板消费+一份多页导航+冲突卡+待同步+批次/恢复卡+仅未归档可整理+会话清理）/ classify（前置分流/同步 hydrate+guard/draftChanged epoch 绑定 modal+草稿转移/旧 URL demo 门）/ detail（编辑/删除打开时基线/下载每次鉴权+迟到门/AI 未启用优先）/ unarchived（无 AI 门槛/冻结意图/删除基线/重映射/会话清屏）/ batch（正式直达隔离）/ ai-result（非 demo 全隔离）→ **页面探针 22 组 PASS**
