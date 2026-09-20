# Phase E1 Step 2 详细规格：客户端 ToolsStore、计时器页面与回归测试

**文档状态**：Codex 架构规范冻结稿  
**执行角色**：Codex 负责方案审查与测试门禁；ZCode (GLM-5.3) 负责代码编写与自动化测试  
**依据文档**：`docs/PHASE_E_SPECIFICATION_AND_PLAN.md` §二、§三

---

## 一、模块清单

1. `services/toolsStore.js`：Pinia Store，管理胎动与宫缩计时器状态、本地持久化（防切后台与冷启动丢失）、511 临产规律分析、紧急医院联系信息读取与拨号。
2. `pages/tools/fetal-timer.vue`：胎动连续计时器页面（1 小时倒计时、大按键、5分钟连击去重合并、撤销误触、后台恢复、历史记录）。
3. `pages/tools/contraction-timer.vue`：临产宫缩计时器页面（建档就医电话顶部卡片、宫缩起止切换大按键、平均时长/间隔统计、511 临产提示、时间线列表）。
4. `pages.json`：注册两个新工具页面路由。
5. `tests/phase-e1-client.regress.cjs`：Store 级回归测试套件。
6. `tests/phase-e1-page.regress.cjs`：页面与交互组件回归测试套件。

---

## 二、`services/toolsStore.js` 接口与状态规范

### 1. 胎动状态机
- `currentFetalSession`: `ref(null)`（当前进行中的会话）
  - 持久化 Storage 键：`momcare_fetal_active_session`
  - 属性：`sessionId`, `startTime`, `targetDurationMs` (3600000), `clicks[]`, `validCount`, `rawCount`, `status` ('running'|'paused')
- `fetalSessions`: `ref([])`（已完成历史会话）
- **后台恢复与计时**：
  - 不依赖前台 `setInterval` 累加作为绝对时间；
  - 经过时间 = `Date.now() - session.startTime`；切后台或锁屏回来后根据真实时钟即时校准。
- **动作**：
  - `startFetalSession(targetDurationMs = 3600000)`：创建会话，落盘本地并调用云端 `fetal.start`；
  - `recordFetalClick()`：记录胎动点击，本地与云端实时追加流水，执行 5 分钟去重计算；
  - `undoFetalClick()`：撤销最后一次点击；
  - `finishFetalSession({ syncDaily = true })`：完成会话，调用 `fetal.finish`（可同事务累加到当日健康数据 `mc_health_daily.fetalCount`），清理本地活跃会话；
  - `discardFetalSession()`：放弃会话并清理本地。

### 2. 宫缩状态机
- `activeContraction`: `ref(null)`（进行中的单次宫缩）
  - 持久化 Storage 键：`momcare_active_contraction`
  - 属性：`recordId`, `startTime`, `status` ('ongoing')
- `contractionRecords`: `ref([])`（最近宫缩历史列表）
- **计算属性与 511 算法**：
  - `recentContractions`：最近 24 小时内的已结束记录（按 startTime 倒序）；
  - `avgDurationSec`：最近 1 小时内宫缩的平均持续秒数；
  - `avgIntervalSec`：最近 1 小时内宫缩的平均发作间隔秒数；
  - `is511Pattern`：布尔值。判断条件：在最近 1 小时内，至少有 3 次以上宫缩，平均发作间隔 ≤ 300 秒（5分钟），且平均持续时长 ≥ 50 秒（接近1分钟），连续发作持续约 1 小时。
  - `disclaimer`: “✦ 511 规则仅作为辅助参考，不构成医疗诊断。若出现破水、剧烈出血或异常剧痛，无论是否符合规律，请立即前往医院就医！”
- **动作**：
  - `startContraction({ intensity, notes })`：记录开始时间，调 `contraction.start`，落盘本地活跃记录；
  - `stopContraction({ intensity, notes })`：记录结束时间，调 `contraction.stop`，更新持续时长，移入历史列表；
  - `deleteContraction(recordId)`：调 `contraction.delete` 软废弃；
  - `pullContractions({ sinceMs })`：调 `contraction.list` 拉取最近记录。

### 3. 就医电话与紧急联系信息
- 从 `familyStore.pregnancy.fields` 读取：
  - `hospitalName`: `pregnancy.hospital || '未设置'`
  - `doctorName`: `pregnancy.doctor || '未设置'`
  - `hospitalPhone`: `pregnancy.hospitalPhone || ''`
- `callHospital()` 方法：
  - 若 `hospitalPhone` 存在，调用 `uni.makePhoneCall({ phoneNumber: hospitalPhone })`；
  - 若不存在，弹窗提示“尚未在孕期档案中填写就医电话，请先去完善”。

---

## 三、测试套件要求

1. `tests/phase-e1-client.regress.cjs`：
   - 测试 Store 初始化、会话落盘与恢复；
   - 测试胎动连击 5 分钟去重与撤销计算；
   - 测试宫缩持续秒数计算与间隔计算；
   - 测试 511 临产规律判定算法（正向满足 / 负向不满足条件）；
   - 测试紧急联系电话读取与空号拦截。
2. `tests/phase-e1-page.regress.cjs`：
   - 页面挂载与组件渲染；
   - 胎动点击反馈、倒计时与完成交互；
   - 宫缩按钮切换交互（开始 ⇄ 结束）；
   - 511 预警提示卡展示与免责声明文案；
   - 就医电话卡片与拨打交互。
