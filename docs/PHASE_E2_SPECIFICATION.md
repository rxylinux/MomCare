# Phase E2 详细规格：Hadlock 1985 B 超三参数估重计算与历史记录

**文档状态**：Codex 架构规范冻结稿  
**执行角色**：Codex 负责方案审查与测试门禁；ZCode (GLM-5.3) 负责代码编写与自动化测试  
**依据文档**：`docs/ZCODE_SIX_FEATURES_FOLLOWUP_SCOPE.md` §E2、`docs/PHASE_E_SPECIFICATION_AND_PLAN.md`

---

## 一、医学公式与算例锚点

1. **临床公式**：
   - 采用 Hadlock 1985 年三参数标准公式：
     `log10(EFW_g) = 1.326 - 0.00326 * AC_cm * FL_cm + 0.0107 * HC_cm + 0.0438 * AC_cm + 0.158 * FL_cm`
   - 公式标识：`hadlock_hc_ac_fl_1985_v1`（LOINC: `11746-5`，文献：*Am J Obstet Gynecol* 1985;151:333-337 Table II）；
   - 参数：
     - `HC`: 头围（Head Circumference），单位 `cm`（支持 `mm` 换算：`hcMm / 10`），有效范围 `[10.0, 42.0] cm`；
     - `AC`: 腹围（Abdominal Circumference），单位 `cm`（支持 `mm` 换算：`acMm / 10`），有效范围 `[10.0, 45.0] cm`；
     - `FL`: 股骨长（Femur Length），单位 `cm`（支持 `mm` 换算：`flMm / 10`），有效范围 `[1.0, 10.0] cm`；
     - **禁忌**：BPD（双顶径）不参与该公式计算，不可用 BPD 代替缺失的 HC。
2. **算例验证锚点（测试必钉）**：
   - 输入：`HC = 32.0 cm, AC = 30.0 cm, FL = 6.5 cm`
   - 计算：
     - `term1 = 1.326`
     - `term2 = -0.00326 * 30 * 6.5 = -0.6357`
     - `term3 = 0.0107 * 32.0 = 0.3424`
     - `term4 = 0.0438 * 30.0 = 1.314`
     - `term5 = 0.158 * 6.5 = 1.027`
     - `log10 = 1.326 - 0.6357 + 0.3424 + 1.314 + 1.027 = 3.37370`
     - `EFW = 10^3.37370 ≈ 2364.29 g`
     - 四舍五入整数显示：`2364 g`（约 `2.36 kg`）。

---

## 二、服务端集合与 Actions（扩充 `mc-tools`）

### 1. 集合：`mc_efw_records`
- `_id`: `efw_<16-char-hex>`
- `familyId`: 数据分区
- `memberId`: 记录成员
- `dateKey`: `YYYY-MM-DD`
- `gestationalWeek`: 整数（12~42）
- `measurements`: `{ hcCm, acCm, flCm, inputUnit: 'cm'|'mm', bpdMm: number|null }`
- `formula`: `'hadlock_hc_ac_fl_1985_v1'`
- `efwGrams`: 整数克
- `exactEfwGrams`: 浮点数（保留两位小数）
- `reportId`: 字符串或 null（关联报告）
- `notes`: 文本备注（≤200 字）
- `status`: `'active' | 'discarded'`
- `revision`, `createdAt`, `updatedAt`
- 索引：`{ familyId: 1, gestationalWeek: -1 }`

### 2. Actions
1. `efw.calculate`：纯计算（输入 HC/AC/FL 与单位，校验范围，返回精确估重、四舍五入克数与公式元数据）；
2. `efw.save`：校验并持久化到 `mc_efw_records`，支持 `operationId` 幂等；
3. `efw.delete`：软删除；
4. `efw.list`：分页列表查询，按 gestationalWeek 或 dateKey 倒序。

---

## 三、客户端 Store 与页面设计

1. **`services/toolsStore.js` 扩展**：
   - `calculateEfw({ hc, ac, fl, unit })`
   - `saveEfwRecord({ dateKey, gestationalWeek, hc, ac, fl, unit, bpd, reportId, notes })`
   - `deleteEfwRecord(recordId)`
   - `pullEfwRecords()`
   - `efwRecords`: 列表 ref
2. **页面 `pages/tools/ultrasound-weight.vue`**：
   - 单位切换开关（`cm` / `mm`）；
   - 输入框：孕周、头围 HC、腹围 AC、股骨长 FL、可选双顶径 BPD；
   - 实时计算结果大卡片：展示估算胎重（克、公斤）、参考胎重区间（±10%）；
   - 免责声明卡片：“✦ 估算结果基于统计学回归公式，受超声切面与胎儿体位影响存在 ±10%~15% 误差，仅供参考，不可替代产科超声医生的临床诊断！”；
   - 历史记录时间线与删除操作。
3. **路由配置**：
   - 在 `pages.json` 注册 `pages/tools/ultrasound-weight`。

---

## 四、测试套件要求

1. `tests/phase-e2-server.regress.cjs`：
   - 算例锚点验证（HC=32, AC=30, FL=6.5 -> 2364g 精确全等）；
   - mm 与 cm 输入等价性（320mm / 300mm / 65mm）；
   - 异常范围拦截（超大、负数、NaN、缺参数）；
   - 增删查与幂等重放；
   - 非家庭成员隔离。
2. `tests/phase-e2-client.regress.cjs`：
   - Store 纯函数与远程计算一致性；
   - 历史记录增删与响应式更新。
3. `tests/phase-e2-page.regress.cjs`：
   - 页面输入双向绑定与实时计算触发；
   - 单位切换（mm ⇄ cm）即时重算；
   - 免责声明文案完整性断言。
