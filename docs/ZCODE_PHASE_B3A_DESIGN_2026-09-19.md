# B3a 实现选择（SPEC §"先记录简短实现选择"）

## 源身份 / 目标 ID / 稳定操作 ID 规则

**sourceId**（可复现）：`<sourceKey>:<entityType>:<entityKey>`，如 `YUNTU_HEALTH_DATA:record:2026-05-01`、`YUNTU_REPORTS_DATA:report:abc123`、`hospital_bag_items:item:0`。备份键同实体（摘要相同）→ 同 sourceId（去重后预览一次）；不同正文 → 后缀 `@<sha256前12>` 区分。

**targetId**：`mig_<domain>_<sourceIdHash>`——sourceId 的 SHA-256 前 16 hex 加前缀，确保同源同确认跨重启/丢响应/重复执行得到同一目标 ID，不产生副本。

**operationId**：`b3a_<batchId>_<seq>`——批次 ID + 实体序号，首次执行前随批次清单一起持久化；重放复用。

## 字段映射（严格白名单）

| 旧字段 | 目标域.字段 | 说明 |
|---|---|---|
| `records[date].weight` | `daily.weightKg` | 数值；零值保留（体重 0 合法于 fetal 语义外仍保留待预览标注） |
| `records[date].bp` (合法) | `daily.systolic` / `daily.diastolic` | 仅"收缩压/舒张压"双值均可解析时映射；不可猜测 |
| `records[date].fetal` | `daily.fetalCount` | 零值合法保留 |
| `records[date].mood` | `mood.mood` | 私人；仅当前本人确认作者 |
| `records[date].symptoms` | `mood.symptoms` | 私人 |
| `records[date].note` | **不映射 sharedNote** | 私人；不默认共享（预览明确区分） |
| `records[date].plans` | `mood.plans` | 私人 |
| `reports[].report_type` | `reports.reportType` | 枚举映射（未知→other） |
| `reports[].report_date` | `reports.dateKey` | 合法日历日期 |
| `reports[].notes` | `reports.note` | 共享——预览明确标注 |
| `reports[].archive_status` | `reports.archiveStatus` | archived/unarchived |
| 报告附件 | `reports.attachments` | 仅本机实体或当前受控云引用；保持页序 |
| `pregnancy` 字段 | `pregnancy.*` | 当前已支持字段白名单 |

**不迁移**：openid、ownerTokenFingerprint、token、AI 旧配额/结果——不进入预览正文、payload、日志。

## 服务接口

新 `services/migrationStore.js`（Pinia store）：
- `scanSources()` — 白名单键只读扫描 + 备份前缀枚举（只列键名筛前缀，不读其他值）
- `buildPreview()` — 逐来源分类/数量/示例标记/日期错误/缺失附件/重复冲突 + 逐条实体预览
- `confirmEntities(selections)` — 生成迁移批次（持久到 `mc_cache_<member>_b3-migration`）
- `executeBatch()` — 逐实体走 familyStore.submit（kind 已有）或新 kind `mig-report`
- `getBatch()` / `resumeBatch()` — 重启后同成员继续

## outbox 扩展（最小入口）

familyStore 增加 `saveReportWithOpId(id, payload, baseline, opId)` —— 可传稳定 operationId（内部调 `submit({kind:'report', ..., opId})`）。不另造裸通道。

## 页面

- `pages/profile/data-source-scan.vue` — 扫描+预览+逐条确认+执行+进度
- `privacy.vue` — 增加"旧数据来源预览"入口（confirmed 会话才可见）
