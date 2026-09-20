# Phase C Stage 2 详细规格：客户端存储、组件与双首页

**文档状态**：Codex 架构规范冻结稿  
**执行角色**：Codex 负责方案审查与测试门禁；ZCode (GLM-5.3) 负责代码编写与自动化测试  
**依据文档**：`DESIGN.md` §2/§3/§4.3/§4.4/§7、`docs/PHASE_C_DETAILED_SPECIFICATION_AND_PLAN.md`

---

## 一、模块划分与文件清单

1. **客户端服务/Store**：
   - `services/collabStore.js`：家庭协同 Pinia Store（管理 needs、tasks、视角偏好 `homeView`、离线 Outbox、动态脱敏投影及本地墓碑清理）。
2. **UI 组件**：
   - `components/home/SharedStatusCard.vue`：分享状态卡片（根据作者/对方展示不同操作，作者展示撤回/关闭，对方展示“接下这件事”/“查看任务”，空状态“今天还没有新的分享”）。
   - `components/home/NeedComposer.vue`：发起/编辑需要弹窗（200 字限制、预置短句、日期选择、明确“对方可见”提示）。
   - `components/home/TaskListCard.vue`：首页任务卡片（我负责的事/共同准备，支持直接勾选完成/撤销完成，跳转“查看全部”）。
3. **页面**：
   - `pages/index/index.vue`（改版）：
     - 顶部视角切换器（“妈妈视角” ⇄ “爸爸视角”）；
     - 妈妈视角与爸爸视角双布局按设计规范重排；
     - **铁律**：视角切换不改登录身份、不提升权限、绝不跨成员透出私人心情（`mood` 集合）、代记健康始终记录真实操作人。
   - `pages/tasks/index.vue`（新页面）：
     - 共同任务独立页面，并在 `pages.json` 中注册；
     - 状态筛选（全部/进行中/已完成/已取消）、创建自定义任务、接单与完成/撤销完成。
4. **自动化测试套件**：
   - `tests/phase-c-client.regress.cjs`：Store 级测试（初始化、视角切换、双端同步、接单流转、撤回墓碑清理、离线 Outbox、会话隔离）。
   - `tests/phase-c-page.regress.cjs`：页面级与组件级测试（双首页排列、视角切换权限不变性、接下点击、任务页面交互）。

---

## 二、`services/collabStore.js` 规范

### 1. 响应式状态与持久化
- `homeView`: `ref('mom')`
  - 持久化键：`momcare_home_view`（Storage）；
  - 默认值：若本地无存储，由 `sessionService.getSessionState().member.role` 决定（`mama` -> `'mom'`，`papa` -> `'dad'`）；
  - `switchHomeView(view)`：修改并持久化到 Storage。
- `needs`: `ref({})`（`needId` -> `viewNeed`）
- `tasks`: `ref({})`（`taskId` -> `viewTask`）
- `lastSyncAt`: `ref(null)`
- `syncing`: `ref(false)`

### 2. 核心方法
- `pullCollab()`：
  - 调用 `mc-collab: need.list` 与 `task.list`；
  - 收到 `status === 'withdrawn'` 的 need 时，强制本地 `content = null`；若本地关联任务存在，同步将其标记为 `cancelled` 且标题脱敏为“（分享已撤回）”。
- `saveNeed({ content, targetDate })`：
  - 调 `mc-collab: need.create`（支持 Outbox 离线入队）；
- `withdrawNeed(needId, expectedRevision)`：
  - 调 `mc-collab: need.withdraw`；
  - 本地立即将 `needs[needId].content = null`，状态转 `withdrawn`，关联任务转 `cancelled` 并脱敏。
- `closeNeed(needId, expectedRevision)`：
  - 调 `mc-collab: need.close`。
- `acceptTask(sourceType, sourceId)`：
  - 调 `mc-collab: task.accept`；
  - 更新本地 `tasks[taskId]`。
- `updateTaskStatus(taskId, status, expectedRevision)`：
  - 调 `mc-collab: task.updateStatus`；
  - 更新本地任务。
- `createCustomTask({ title, targetDate, assigneeId })`：
  - 调 `mc-collab: task.createCustom`。

### 3. 计算属性与投影
- `currentMemberId`：服务端解析的当前成员 ID；
- `myActiveShare`：本人发表且 `status === 'active'` 的最新短句；
- `partnerActiveShare`：对方发表且 `status === 'active'` 的最新短句；
- `dadTopTasks`：爸爸视角首屏任务（`assigneeId === 'papa' || acceptedBy === 'papa' || !assigneeId` 且状态为 `doing` 或 `pending`，优先今天到期，取前 3 项）。
- `myTasks`：与我相关的任务列表。

---

## 三、组件交互规格

### 1. `components/home/SharedStatusCard.vue`
- Props: 无（直接从 `collabStore` 读响应式数据，或接收 need 对象）；
- 文案规则：
  - 本人发表：标题显示“我分享的状态”，提供“结束”与“撤回”操作按钮；
  - 对方发表：标题显示“对方分享的状态”，展示短句内容；
    - 若关联任务未接下：展示显眼的“接下这件事”大按钮（高亮）；
    - 若已接下：展示“已接下（进行中/已完成）”状态及“查看任务”按钮；
  - 空状态：文案严格显示“今天还没有新的分享”（禁止文案造假，不编造“她今天状态很好”）；
  - 撤回确认交互：点击撤回弹出确认框，提示文案：“联网同步后会从对方页面移除，已经看过或导出的内容无法收回”。

### 2. `components/home/NeedComposer.vue`
- Props: `visible: Boolean`，事件 `@update:visible`，`@saved`；
- 预置快捷短句按钮：“想休息一下”、“希望帮忙带饭”、“想一起准备产检”；
- 文本域：限 1~200 字，显示实时字数；
- 约定日期：可选日期选择器；
- 醒目提示：“对方可见”；
- 提交按钮：“分享给对方”，提交中防重复点击。

### 3. `components/home/TaskListCard.vue`
- Props: `tasks: Array`, `title: String`（妈妈视角显示“共同准备”，爸爸视角显示“我负责的事”）；
- 列表项：勾选框（点击直接触发 `updateTaskStatus` 切换完成/撤销完成）、任务标题、到期日期、负责人标签；
- 底部链接：“查看全部任务” -> `uni.navigateTo({ url: '/pages/tasks/index' })`。

---

## 四、双首页与页面规格（`pages/index/index.vue`）

1. **顶部视角切换**：
   - 顶部显示视角指示器（例如：“妈妈视角 | 爸爸视角” Segment / Toggle）；
   - 点击切换视角，调用 `collabStore.switchHomeView`。
2. **妈妈视角内容排列**：
   - 1: 孕周、倒计时、宝宝昵称 (`HomeHero`)
   - 2: 今天的记录：体重 / 血压 / 胎动 / 状态 (`DayRecordPanel`)
   - 3: 今天希望你帮什么 / 我分享的状态 (`SharedStatusCard` + 唤起 `NeedComposer`)
   - 4: 下一次产检：想问医生的事
   - 5: 共同准备：任务与待产包 (`TaskListCard`)
   - 6: 每日变化与本周指南 (`DailyChanges`, `WeeklyGuideCard`)
3. **爸爸视角内容排列**：
   - 1: 共同孕周、倒计时、同步状态 (`HomeHero`)
   - 2: 对方主动分享的状态与需要 (`SharedStatusCard`，突出“接下这件事”)
   - 3: 我负责的事 (`TaskListCard`，优先今天到期的前 3 项)
   - 4: 下一次产检：陪同、材料与行程
   - 5: 共同准备：待产包与未分配事项
   - 6: 本周陪伴指南与常用工具
4. **权限不变性铁律**：
   - 无论切到哪个视角，`session.member` 始终不变；
   - 爸爸切到妈妈视角，依然绝对看不到妈妈的私人日记（`mood` 集合），只能看到共享数字与自己的日记；
   - 代记健康数字时（`RecordEditSheet`），保存人始终为真实登录成员（`recordedBy = 'papa'`）。

---

## 五、共同任务独立页（`pages/tasks/index.vue`）

1. 在 `pages.json` 中注册该页面路由：`pages/tasks/index`。
2. 顶部 Tab：全部、待办（`pending`）、进行中（`doing`）、已完成（`done`）。
3. 列表展示每项任务，支持接下、修改状态、取消。
4. 顶部/悬浮按钮：“新建任务”，可输入自定义标题、日期、指派人。
5. 若任务来自分享，标题动态展示分享正文；若分享已撤回，显示“（分享已撤回）”。

---

## 六、测试套件要求

1. **`tests/phase-c-client.regress.cjs`**：
   - 覆盖 Store 初始化、默认视角判断、切换持久化；
   - 覆盖分享创建、双端拉取、接单生成确定性任务；
   - 覆盖撤回单调墓碑在客户端的响应：本地正文立即抹除为 null，任务脱敏；
   - 覆盖离线 Outbox 入队与网络恢复后的 flush；
   - 覆盖会话切换隔离：切换身份清空上一人未提交队列，不泄漏私人数据。
2. **`tests/phase-c-page.regress.cjs`**：
   - 真实 Vue 页面环境渲染断言；
   - 验证妈妈视角与爸爸视角卡片排列顺序；
   - 验证爸爸切到妈妈视角时私人数据严格不可见、代记人依然为爸爸；
   - 验证接下操作、任务勾选完成操作；
   - 验证空数据状态文案正确。
