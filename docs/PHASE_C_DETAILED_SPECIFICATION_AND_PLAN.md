# Phase C 详细方案规格与分阶段实施计划：双首页与家庭协同

**文档状态**：Codex 架构方案冻结稿  
**执行角色**：Codex 负责方案制定、安全仲裁、代码审查、门禁把关；ZCode (GLM-5.3) 负责代码编写与自动化测试  
**依据文档**：`DESIGN.md`、`PRD.md`、`docs/PHASE_C_FAMILY_COLLAB_DESIGN_REVIEW_2026-09-20.md`、`DEVELOPMENT_PLAN_6_FEATURES.md`

---

## 一、阶段目标与范围

1. **业务目标**：
   - 妈妈视角与爸爸视角双首页：支持根据角色默认展现、自由切换首页视角，切换不改变身份、不篡改代记人（`recordedBy`）、不越权访问私人记录。
   - 分享状态与需要（Shared Needs）：妈妈（或任一成员）主动表达需要与短句，明确提示“对方可见”；支持关闭与撤回。
   - 撤回单调墓碑（Withdrawn Tombstone）：撤回后正文立即抹除，所有服务端响应及客户端缓存永久消除原文，不可逆。
   - 协同任务（Family Tasks）：
     - 来源包含：主动分享（`need`）、产检（`checkup`）、待产包（`bag`）、自定义（`custom`）。
     - **同源单任务约束**：每项来源最多一个任务，任务 ID 确定性生成：`tsk_${familyId}_${sourceType}_${sourceId}`。
     - **正文脱耦约束**：来自分享的任务不持久复制分享正文，仅在动态投影时取当前 `active` 分享生成；若分享已撤回，任务转为 `cancelled` 或无原文结束状态。
     - **产检与待产包权威源约束**：产检/待产包任务状态与 `mc_checkups` / `mc_bag_items` 保持唯一真实源，不分裂进度。
   - 离线与 Outbox：持久化本地 Outbox，网络失败安全重试，会话切换不污染。

---

## 二、架构设计与服务端数据合同

### 1. 云函数划分：新增 `mc-collab`

- 函数目录：`cloud/functions/mc-collab`（共享 `shared/auth.js`, `shared/config.js`, `shared/respond.js`, `shared/constants.js`）
- 在 `cloud/collections.json` 与 `cloud/assemble.mjs` 中注册。

### 2. 集合一：`mc_shared_needs`

- **文档 ID**：`need_<16-char-random-hex>`
- **字段规范**：
  - `_id`: 字符串
  - `familyId`: 字符串（数据分区）
  - `ownerId`: 字符串（作者 memberId，仅作者可编辑/撤回/关闭）
  - `content`: 字符串（1~200 字；**撤回后置为 null 或空，物理抹除**）
  - `targetDate`: 字符串（可选，`YYYY-MM-DD`）
  - `status`: `'active' | 'closed' | 'withdrawn'`
  - `withdrawnAt`: 毫秒时间戳或 null
  - `closedAt`: 毫秒时间戳或 null
  - `revision`: 整数（从 1 开始，乐观并发）
  - `createdAt`: 毫秒时间戳
  - `updatedAt`: 毫秒时间戳
  - `updatedBy`: 字符串
- **索引**：`{ familyId: 1, createdAt: -1 }`

### 3. 集合二：`mc_family_tasks`

- **文档 ID**：`tsk_${familyId}_${sourceType}_${sourceId}`（确定性 ID，杜绝重复创建竞态）
- **字段规范**：
  - `_id`: 字符串
  - `familyId`: 字符串
  - `sourceType`: `'need' | 'checkup' | 'bag' | 'custom'`
  - `sourceId`: 字符串
  - `title`: 字符串（自定义任务必填，<=100 字；对于 `sourceType === 'need'`，持久化字段存空或占位，显示文案按需从 active 分享动态投影；撤回后绝不输出原文字符）
  - `targetDate`: 字符串（可选，`YYYY-MM-DD`）
  - `status`: `'pending' | 'doing' | 'done' | 'cancelled'`
  - `assigneeId`: 字符串或 null（指派的负责人）
  - `acceptedBy`: 字符串或 null（主动接单成员）
  - `acceptedAt`: 毫秒时间戳或 null
  - `completedBy`: 字符串或 null
  - `completedAt`: 毫秒时间戳或 null
  - `revision`: 整数（从 1 开始）
  - `createdAt`: 毫秒时间戳
  - `updatedAt`: 毫秒时间戳
  - `updatedBy`: 字符串
- **索引**：`{ familyId: 1, status: 1, targetDate: 1 }`

### 4. 服务端动作（Actions）清单

1. `need.create`:
   - 入参：`{ content, targetDate, operationId }`
   - 权限：成员认证，作者绑定 `caller.memberId`
   - 规则：正文白名单与长度（1~200 字），`operationId` 幂等
2. `need.update`:
   - 入参：`{ needId, content, targetDate, expectedRevision, operationId }`
   - 权限：仅作者（`ownerId === caller.memberId`），非作者返回 `forbidden`
   - 规则：若当前已处于 `withdrawn` 或 `closed`，拒绝变异
3. `need.withdraw`:
   - 入参：`{ needId, expectedRevision, operationId }`
   - 权限：仅作者
   - 关键操作：在单事务内将 `status` 置为 `'withdrawn'`，**清除 `content` 字段（置为空串或清除）**，设置 `withdrawnAt`。
   - 关联联动：在同事务或后续关联查询中，将该 need 派生的任务（`tsk_${familyId}_need_${needId}`）转为 `cancelled` 或标记关联分享已撤回，投影绝不包含原短句。
4. `need.close`:
   - 入参：`{ needId, expectedRevision, operationId }`
   - 权限：仅作者，关闭需要
5. `need.list`:
   - 入参：`{ cursor, limit, status }`
   - 权限：仅同家庭成员
   - 返回：投影对象数组。**注意：对 `withdrawn` 状态的项，返回对象中 content 必须为 null 或不存在，绝对不可携带旧正文**
6. `task.accept`:
   - 入参：`{ sourceType, sourceId, operationId }`
   - 权限：同家庭成员
   - 规则：
     - 若 `sourceType === 'need'`：单事务内先读取 need，必须存在且 `status === 'active'`（若已被撤回，拒绝 `need-withdrawn`）；
     - 读取或创建确定性文档 `tsk_${familyId}_${sourceType}_${sourceId}`；
     - 记录 `acceptedBy = caller.memberId`，`acceptedAt = now`，`status = 'doing'`（或 'pending' 接下）；
     - 并发或重复调用幂等返回同一任务。
7. `task.updateStatus`:
   - 入参：`{ taskId, status, expectedRevision, operationId }`
   - 状态流转：`pending` <-> `doing` <-> `done` / `cancelled`
   - 记录 `updatedBy`、`completedBy/completedAt`
   - 若来源是 `checkup` 或 `bag`，联动同步权威表 `mc_checkups` / `mc_bag_items`（或由客户端/服务端保持权威一致）
8. `task.createCustom`:
   - 入参：`{ title, targetDate, assigneeId, operationId }`
   - 生成自定义任务（`sourceType = 'custom'`）
9. `task.list`:
   - 入参：`{ cursor, limit, status, assigneeId }`
   - 权限：同家庭成员
   - 动态投影：若 `sourceType === 'need'`，服务端按需联查对应 need；若 need 不存在或已 `withdrawn`，标题一律脱敏显示为“（分享已撤回）”，不得返回原短句。

---

## 三、客户端架构与双首页交互

### 1. 视角偏好与状态

- `stores/familyStore.js` / `services/sessionService.js`:
  - 存储用户视角偏好 `homeView: 'mom' | 'dad'`（持久化在本地 storage）。
  - 首次登录若未设置，根据当前已绑定身份推荐（`mama` 默认 `mom`，`papa` 默认 `dad`）。
  - 提供 `switchHomeView('mom' | 'dad')` 方法。
  - **安全与权限铁律**：视角仅控制视图渲染组件与排序，不改变 `session.currentMember`，不改变代记录的 `recordedBy`，也不改变私人日记（`mood`）的隔离逻辑（爸爸切到妈妈视角也绝对看不到妈妈的私人心情）。

### 2. 双首页结构与组件（`pages/index/index.vue`）

1. **顶部视角切换栏**：
   - 清晰展示当前“妈妈视角”或“爸爸视角”，带切换按钮与轻量切换动画。
2. **妈妈视角排列**：
   - 孕周倒计时大卡片（`HomeHero`）
   - 今日健康记录（`DayRecordPanel`）
   - “今天希望你帮什么” / “我分享的状态”（`SharedStatusCard` + `NeedComposer`）
   - 下次产检（想问医生的事）
   - 共同准备（任务与待产包）
   - 本周知识与常用工具
3. **爸爸视角排列**：
   - 共同孕周与同步状态（`HomeHero` 紧凑模式，留出首屏）
   - “对方主动分享的状态与需要”（`SharedStatusCard`，突出“接下这件事”按钮）
   - “我负责的事”（`TaskListCard`，优先展示今天到期的前三项）
   - 下次产检（陪同、材料与行程）
   - 共同准备（待产包与任务）
   - 本周陪伴知识与常用工具

### 3. 组件规范

1. `components/home/SharedStatusCard.vue`:
   - 显示作者、日期、共享短句、关联任务状态（接下/进行中/已完成）。
   - 本人分享显示“我分享的状态”，提供“撤回”和“结束”按钮；
   - 对方分享显示“对方分享的状态”，提供“接下这件事”按钮（接下后变为“查看任务”）。
   - 空状态：“今天还没有新的分享”（禁止文案造假）。
   - 撤回交互：弹窗二次确认并提示“联网同步后会从对方页面移除，已经看过或导出的内容无法收回”。
2. `components/home/NeedComposer.vue`:
   - 短句输入框（限 200 字，提供快捷预置词条：“想休息一下”、“希望帮忙带饭”、“想一起准备产检”等）；
   - 可选约定日期选择器；
   - 明确提示“对方可见”；
   - 提交按钮“分享给对方”。
3. `components/home/TaskListCard.vue`:
   - 展示任务列表（标题、到期日期、负责人、完成勾选）；
   - 支持直接勾选完成/撤销完成；
   - 底部“查看全部任务”链接跳转到 `pages/tasks/index.vue`。

---

## 四、实施阶段与委派细分

### Stage 1：服务端协议与单测（ZCode 实施）
1. 创建 `cloud/functions/mc-collab/index.js` 及符号链接 `cloud/functions/mc-collab/shared`。
2. 更新 `cloud/collections.json` 补充 `mc_shared_needs` 和 `mc_family_tasks`。
3. 更新 `cloud/assemble.mjs` 纳入 `mc-collab`。
4. 编写全面的服务端契约回归套件 `tests/phase-c-server.regress.cjs`：
   - 覆盖 need 的创建、编辑、撤回（正文彻底抹除）、关闭与列表投影；
   - 覆盖 task 的确定性 ID、单源唯一性、接单事务幂等、同 operationId 重放、异 hash 拒绝；
   - 覆盖 need 撤回与 task 关联状态联动（正文绝不泄漏）；
   - 覆盖非家庭成员严格拦截。
5. **门禁**：所有用例 100% 通过后提交 Codex review。

### Stage 2：客户端存储、UI 组件与双首页（ZCode 实施）
1. 在 `services/` 下实现 `collabStore.js` / 扩展 `familyStore.js`，包含 outbox 离线排队与墓碑清理。
2. 实现 `components/home/SharedStatusCard.vue`、`components/home/NeedComposer.vue`、`components/home/TaskListCard.vue`。
3. 实现 `pages/tasks/index.vue`（共同任务列表页）。
4. 改造 `pages/index/index.vue` 支持妈妈/爸爸双首页布局与自由切换视角。
5. 编写客户端与页面级测试套件 `tests/phase-c-client.regress.cjs` 与 `tests/phase-c-page.regress.cjs`。
6. **门禁**：所有历史用例与新用例 100% 通过后提交 Codex review。
