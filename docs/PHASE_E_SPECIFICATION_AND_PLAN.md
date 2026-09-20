# Phase E 专项功能方案规格与实施计划：计时器、估重与速查

**文档状态**：Codex 架构方案冻结稿  
**执行角色**：Codex 负责方案制定、医学规范审查、代码审查、门禁把关；ZCode (GLM-5.3) 负责代码编写与自动化测试  
**依据文档**：`docs/ZCODE_SIX_FEATURES_FOLLOWUP_SCOPE.md`、`DEVELOPMENT_PLAN_6_FEATURES.md` §6、`PRD.md` §4

---

## 一、Phase E 目标与分步实施路线

Phase E 聚焦于交付用户明确要求的四大专项功能模块，按照高内聚、低耦合原则，划分为三个实施阶段：

1. **E1 阶段：胎动记录计时与临产宫缩计时（含建档急救电话联动）**
   - **E1.1 胎动连续计时**：会话级计时（1小时有效监测、防连击防误触、可撤销误触、后台切回时长基于绝对时间戳校准、断网与会话持久化、不虚构正常）。
   - **E1.2 宫缩计时器**：单次持续时长（结束时间-开始时间）、发作间隔时长（相邻两次开始时间差）、511临产预警辅助算法提示（仅作参考提示，不做医疗诊断）。
   - **E1.3 紧急联系就医联动**：一键调出 `mc_pregnancy` 已建档的医院名称、主治医生与联系电话（`hospitalPhone`），缺号时明确提示去完善，不造假号码。
2. **E2 阶段：B 超估重计算与历史记录**
   - 严格锁定 Hadlock 1985 年基于 **HC + AC + FL** 的三参数标准公式（`hadlock_hc_ac_fl_1985_v1`，LOINC 11746-5）；
   - 单位双向换算（mm / cm）、输入合理范围与浮点精度、整数克舍入与未舍入值双存；
   - 估重历史记录、孕周关联、不代替临床超声报告免责声明。
3. **E3 阶段：饮食/行为安全速查与可选 AI 解释**
   - 本地官方高频词条库（安全/注意/慎用/禁用/资料不足、官方来源链接、审校日期、同义词检索）；
   - 未收录词条诚实显示“未收录”（绝不假标为安全）；
   - 可选 AI 解释代理接口（未配置/未部署时明确显示“AI服务未启用”，不假装已接入真实 DeepSeek）。

---

## 二、E1 阶段详细数据模型与服务端合同（`mc-tools`）

### 1. 云函数：新增 `mc-tools`
- 目录：`cloud/functions/mc-tools`
- 共享 `cloud/shared/` 工具链（`auth.js`, `respond.js`, `config.js`）；
- 在 `cloud/collections.json` 与 `cloud/assemble.mjs` 中注册。

### 2. 集合一：`mc_fetal_sessions`（胎动连续计时会话）
- **文档 ID**：`fst_<16-char-hex>`
- **字段**：
  - `_id`: 字符串
  - `familyId`: 数据分区
  - `memberId`: 记录成员（`caller.memberId`）
  - `dateKey`: `YYYY-MM-DD`（家庭时区 Asia/Shanghai）
  - `status`: `'running' | 'completed' | 'discarded'`
  - `startTime`: 毫秒时间戳（会话开始绝对时间）
  - `endTime`: 毫秒时间戳（完成/丢弃时间）
  - `targetDurationMs`: 目标时长毫秒（默认 3600000 即 1 小时）
  - `clicks`: 点击事件数组 `[{ timestamp: number, valid: boolean, note?: string }]`
  - `validCount`: 有效胎动次数（临床规则：连续多次胎动在 2~5 分钟内计为 1 次，但保留原始击发流水；提供严格模式与原始计数两种视角）
  - `revision`: 乐观锁版本号
  - `createdAt`, `updatedAt`
- **索引**：`{ familyId: 1, dateKey: -1 }`

### 3. 集合二：`mc_contraction_records`（宫缩记录）
- **文档 ID**：`cnt_<16-char-hex>`
- **字段**：
  - `_id`: 字符串
  - `familyId`: 数据分区
  - `memberId`: 操作成员
  - `dateKey`: `YYYY-MM-DD`
  - `startTime`: 毫秒时间戳（宫缩开始）
  - `endTime`: 毫秒时间戳（宫缩结束，未结束则为 null）
  - `durationSec`: 持续秒数（`endTime - startTime` / 1000，未结束为 null）
  - `intervalSec`: 与上一次宫缩的间隔秒数（本次 `startTime` - 上一次 `startTime`）
  - `intensity`: 强度级别 `'mild' | 'moderate' | 'strong' | null`
  - `notes`: 文本备注（≤200 字）
  - `status`: `'ongoing' | 'finished' | 'discarded'`
  - `revision`: 整数
  - `createdAt`, `updatedAt`
- **索引**：`{ familyId: 1, startTime: -1 }`

### 4. 服务端动作清单（Actions）
1. `fetal.start`：创建新胎动会话，记录 `startTime`，状态 `running`；
2. `fetal.click`：在进行中的会话中追加点击事件，记录精确时间戳，动态重算 `validCount`，增加版本号；
3. `fetal.undo`：撤销上一次误触点击，重算计数；
4. `fetal.finish`：结束会话，固化 `endTime`、`validCount`，状态转为 `completed`；若勾选同步，可同事务/联动回写 `mc_health_daily` 的当日 `fetalCount`；
5. `fetal.discard`：废弃当前会话；
6. `fetal.list`：分页查询历史会话；
7. `contraction.start`：记录单次宫缩开始，自动计算与上一条最近记录的 `intervalSec`；
8. `contraction.stop`：记录单次宫缩结束，计算 `durationSec`，状态转 `finished`；
9. `contraction.delete`：删除单条误录记录；
10. `contraction.list`：按时间倒序拉取最近 24 小时或分页的宫缩记录（供计算 511 规律分析）。

---

## 三、E1 客户端页面与交互设计

1. **胎动计时器页（`pages/tools/fetal-timer.vue`）**：
   - 居中倒计时环（1 小时倒计时），显示已耗时与剩余时间；
   - 核心大按钮：“动了一下”（点击触发轻微振动反馈，计数 +1）；
   - 误触撤销：“撤销上次误触”；
   - 状态控制：“暂停 / 继续”、“完成记录”、“重新开始”；
   - 历史卡片：今日已测会话、历史列表；
   - 切后台保护：采用本地 `Date.now()` 与 `startTime` 差值计算，切后台回来后自动校准经过时间，不丢时间不漏计。
2. **宫缩计时器页（`pages/tools/contraction-timer.vue`）**：
   - 顶部急救卡片：展示“建档医院”、“主治医生”与显眼的“拨打就医电话”按钮（直接读取 `pregnancy.hospitalPhone`，点击 `uni.makePhoneCall`）；
   - 核心交互大按钮：“宫缩开始了” ⇄ “宫缩结束了”大按钮；
   - 实时统计卡片：平均持续时长（秒）、平均发作间隔（分钟）；
   - 临产 511 辅助分析提示卡：当满足“每 5 分钟 1 次、持续至少 1 分钟、规律超过 1 小时”时，高亮展示“符合 511 规律，建议联系医院或准备就医”，并附带医学免责声明；
   - 记录时间线：清晰展示最近每一阵宫缩的开始时间、持续秒数、间隔分钟。
3. **路由与入口**：
   - 在 `pages.json` 中注册 `pages/tools/fetal-timer` 与 `pages/tools/contraction-timer`；
   - 首页常用工具区与 profile 全部工具区接入这两个页面的直接导航入口。

---

## 四、E1 实施分步与验收门禁

- **Step 1（服务端协议与契约测试）**：
  - 创建 `cloud/functions/mc-tools/index.js`；
  - 更新 `cloud/collections.json` 与 `cloud/assemble.mjs`；
  - 编写 `tests/phase-e1-server.regress.cjs`，覆盖胎动点击、连击去重逻辑、撤销、结束、宫缩起止时间差、跨午夜与权限隔离。
- **Step 2（客户端 Store、页面与交互测试）**：
  - 创建 `services/toolsStore.js`；
  - 创建 `pages/tools/fetal-timer.vue` 与 `pages/tools/contraction-timer.vue`；
  - 注册 `pages.json` 并在首页/工具栏增加入口；
  - 编写 `tests/phase-e1-client.regress.cjs` 与 `tests/phase-e1-page.regress.cjs`。
- **门禁要求**：所有新增用例 100% 通过且历史全套回归绿灯，才可提请 Codex Review。
