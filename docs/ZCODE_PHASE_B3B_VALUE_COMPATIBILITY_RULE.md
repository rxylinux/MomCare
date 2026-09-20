# B3b 隔离恢复值兼容性规则（提案——待审查后作为格式合同附件；字段验证不据此再加严）

> 背景（评审指令）：把**当前写 API 的字段值域**与阶段一**真实导出器**和 **container 包验收**逐项对比；
> 隔离区不得误拒合法历史完整备份值。本文件给出对比结论、形式化兼容规则与真实导出测试证据。
> **本提案本身不改任何字段验证代码**——当前实现已按裁定无值类型强制（见 mc-restore `validateRecordShape`
> 头注），本文件是把它升格为显式格式合同并附测试证据。

## 1. 三层事实对比

### 1.1 当前写 API（mc-health / mc-schedule / mc-reports sanitizeX）

- 键白名单 + 值类型 + 区间（weightKg 25..300 等）+ 枚举（REPORT_TYPES / BAG_CATEGORIES /
  CHECKUP_STATUS / assignee / archiveStatus）+ 长度上限（note≤500、sharedNote≤200 等）+
  结构形状（plans {text,done}、examItems {itemId,text,required,done}）。
- 清除语义：嵌套 fields 清除即删键（`mergeFields` null→delete）；顶层字段清除存 null。

### 1.2 阶段一导出器（services/mcpkgExportService.js）

- **键级**：`guardUnknownFields` 只查**键**——存储记录出现白名单外键（META_IGNORED 除外）→
  `problems` → `incompleteReasons` → `complete=false` → **只产 diagnostic 包**。
  即：**合法 full 包的记录永远只含投影白名单键**。
- **值级**：`pick()` **原样保留**白名单键上的存储值——不校验类型/区间/枚举/长度/结构。
  历史版本写入的 nullable、字符串数字、已废弃枚举值、旧结构都会原样进入 full 包。
- 身份/映射：`projected.id=idOf(rec)`、revision/deleted 恒写、reports 附件映射
  `{order, originalFileId, fileIndex}` 与正文 `{fileId, order}` 由同一循环生成（逐位一致）。

### 1.3 阶段一包验收（utils/mcpkg/container.js validatePackage/validateManifest）

- 只验：规范字节（decodeStrict+canonical 重序列化逐字节全等）、manifest 结构自洽
  （三态域/scope/闭包/唯一性/index 连续）、**逐记录 hash 与声明全等**、
  **声明 index/id/revision/deleted 与正文逐项对照**（L443-456）、reports 正文↔映射逐位比对
  （L418-440，String/Number 比较）。
- **不验**：字段值类型/区间/枚举/长度/结构形状。

**结论**：三层中只有第 1 层（当前写 API）施加值域；第 2、3 层（决定"什么是合法 full 包"）
完全不施加。任何第 1 层的值域收紧都不回溯到已导出的历史包。

## 2. 兼容规则（提案——Q-A 边界）

隔离恢复（quarantine-only，不回灌实时集合）在**格式/字段值层**的接受边界与阶段一"合法 full 包"判据对齐（下表）。

**范围限定（承审查裁定 2026-09-20 收紧）**：Stage1 `validatePackage` 是结构/摘要验真器——通过是**必要条件而非充分条件**。身份/隐私/作用域/资源门（家庭归属、mood 仅 private 而 Stage1 允许 shared、本人私人 scope、写入状态与聚合计数等）是恢复侧**有意更严**的独立层，不因 Stage1-valid 而解除；本表与本文不授权弱化它们。本规则的兼容目标是**真实导出器生成的合法历史备份不被误拒**，不构成"任意合成 Stage1-valid 包可恢复"的全称主张。

| 层面 | 隔离区行为 | 依据 |
|---|---|---|
| 规范字节 | 严格（decodeStrict+canonical 逐字节） | 阶段一同规则 |
| 记录**键** | 白名单严格（未知键拒） | 导出器键级 problems→full 包永不含未知键——**白名单不可能误拒合法 full 包** |
| 身份 | id 必有且=冻结声明；daily/mood id===dateKey | 导出器恒等不变式 |
| revision/deleted | 正文与冻结声明全等 | 导出器恒写+container 逐项对照 |
| reports 映射 | 附件键集 `{order}` 或 `{fileId,order}`，与冻结映射按 `String(body.fileId)===String(mapping.originalFileId)` 及 `Number(order)` 逐位恒比，墓碑零附件 | 真实导出器写两键；container 也接受双方身份键同时缺席的合法 full 包（P10），但单方缺席/错配不能放过 |
| **字段值** | **不校验（原样保留规范字节入隔离区）** | 导出 pick 原样保留+container 不验——值域收紧不回溯历史包 |
| JSON 安全 | 值须可规范序列化（undefined/孤立代理/稀疏/非有限数拒） | canonical 唯一规则（字节层已强制） |

**Phase 2 边界（按权威设计 §5——quarantine-only）**：本期**无 merge、无部分恢复、无回灌**。
`restore.commit` 只做隔离区记录的**冻结与核验**（verify 逐项 hash/引用复验），**绝不把记录
应用到实时集合**；预览/读取如实呈现隔离区原始字节。因此本发布**不存在任何环节**对隔离区记录
按写 API 做值级复核。任何未来的"隔离区→实时集合迁移"是 **out-of-scope 的独立设计事项**，
须另行设计与用户显式授权——不属于本协议与本文件范围。

## 3. 真实导出测试证据（/tmp/mc-restore-real-export-compat.cjs）

复用阶段一冒烟夹具（真实 `mcpkgExportService` bundle + 真实 mc-health/mc-schedule/mc-reports
handler + 忠实 fsm/downloadFile mock），**直种历史存储值**（绕过当前写校验器，模拟旧版本写入）：

| 直种历史值 | 导出结果 | container 验包 | mc-restore declare | uploadRecord |
|---|---|---|---|---|
| daily `fields.weightKg=null, systolic='110'`（字符串数字） | complete=true full 包 | ok | →indexing→declared | ok（隔离区保留） |
| mood `fields.mood=7, plans=[{text:'',done:1}]`（数值/布尔ish/空文本） | 同上 | ok | 同上 | ok |
| 对照：正常值记录 | 同上 | ok | 同上 | ok |

断言链：导出 complete → 真 container `validatePackage` ok（Stage1 接受）→ manifest 规范字节喂
mc-restore 至 indexing/declared（服务端接受）→ 域段逐记录 `uploadRecord` ok 且隔离区文档保留
原始值（`systolic:'110'` 等逐字节在档）。**该链证明：真实导出器生成的合法历史 full 备份（安全包）
全程不被误拒——兼容目标即此；非"任意合成 Stage1-valid 包可恢复"的全称主张（身份/隐私/作用域/资源门照常）。**

## 4. 维护义务

- 写 API 收紧值域时**不得**据此修改本规则或隔离区验证——隔离区与实时集合在本发布无回流路径，不存在"commit 侧值级复核"环节；值级写 API 校验只存在于实时集合的常规写路径（与隔离恢复无关）。
- 新增**键**（投影白名单扩展）时：导出器 `*_FIELDS`、container 无涉、mc-restore
  `RECORD_TOP_ALLOWED/NESTED_KEY_WHITELIST` 三处同步+兼容测试补行。
- 本规则变更须过设计审查（与格式合同同流程）。
