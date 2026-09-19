# 阶段 B2a 交接（R5）：持久同步与真实健康档案页面（ZCode → Codex review）

日期：2026-09-19（R5：R4 基础上修复复现 19–23）。基线 `555e5cc`（Codex docs-only）。状态：**B2a R5 编码完成，源码冻结，等待 Codex review**。未提交/推送/部署。

## 1. R3 六项修复（全部生产路径验证）

| # | 修复 | 验证 |
| --- | --- | --- |
| 1 正式孕期保存污染旧 store | family 分支移到一切旧 store 写入之前；旧写入仅在演示/未确认分支 | R4-1：真实 handleSave 后断言旧 store 内存与 YUNTU 磁盘逐字节不变、云端已更新 |
| 2 跨日未实现 | famWeekInfo/famDaysUntilDue 依赖 `healthStore.today`（App 分钟时钟 refreshToday 驱动）+ **公历日序**（`shanghaiDayOrdinal`=Date.UTC/86400000）；lmp/due 按上海日号取序；saveDaily 传 Date 由 store 统一转换 | R4-2：绝对值 110（06-01→09-19）+ refreshToday(明天) 跨日 +1；R4-2b：月末 1/年末 1/闰日 2/平年 1；独立 midnight 探针 ✓ |
| 3 演示/退出自动复核 | `isExplicitDemo()`/`isExplicitLoggedOut()`；`foregroundRecheck()` 演示优先拒绝→资格拒绝；App.onShow/首页/趋势/家庭 onShow 演示优先短路；**enterDemoMode 调 endSession**（已确认用户切演示立即结束正式会话）；endSession 写 `logged-out` 标记 | R4-3 + 独立 mode 探针 ✓（显式退出零请求、切演示后零正式请求） |
| 4 趋势 prompt 走旧 store | 三页 stats/history/chartSource **三态分支**（family=权威源 / demo=旧 store / prompt=空态）；dataSource 订阅 sessionVersion 响应式切换 | R4-4：prompt 注入 canary 后全空（不泄露）；显式 demo canary 可见 |
| 5 旧端点未关闭 | mc-shared-records/mc-private-notes main 入口默认拒绝写操作（`legacy-endpoint-closed`）；读兼容；`MC_ALLOW_LEGACY_WRITES=true` 仅测试开关；语法错误（字符串截断）已修复，node --check 双函数通过 | R4-5：默认拒绝+读兼容+开关可开；B1 套件显式开开关 42/42 |
| 6 冲突无比较值 | conflictDiff 渲染实际字段差异（本地值 vs 云端值 + 字段中文标签）；墓碑显示"(云端已删除)"；清除显示"(已清除)"；版本号 r{expected}→r{current} | R4-6：真实冲突后断言 diff 含体重 62 vs 65、版本 1→2 |

## 2. R4 追加修复（review 中途反馈）

- **日期公历序**：R3 修正用的 YYYYMMDD 整数相减不是日历运算（06-01→09-19 得 318）。改用 `Date.UTC(y,m,d)/86400000` 日序差；独立 midnight 探针（含绝对值断言）通过。
- **旧 handler 语法**：legacy guard 插入字符串字面量内部 → `node --check` 失败。修复后双函数语法通过、assemble 通过。
- **演示优先覆盖 confirmed**：App.onShow confirmed 分支前加演示短路；`enterDemoMode` 主动 `endSession()`；mode 探针（真实 enterDemoMode + 真实 App.onShow）确认切演示后零正式请求。
- **session watch 误清数据**：同成员重确认/回前台复核不再 clearMemory（仅成员**更换**时清空+恢复快照）；page-path 探针首页激活断言恢复通过。
- **首页 onShow 同步激活**：confirmed 会话回前台立即 `dataMode='family'`（同步）+ 异步复核拉取——从家庭页确认返回首页的激活路径不再依赖异步竞态。

## 3. R5 修复（复现 19–23）

| # | 修复 | 验证 |
| --- | --- | --- |
| 19 bp/fetal 漏 watch import | 两页 vue import 补 watch；三趋势页真实装载 | R5-19 三页装载不抛 ReferenceError + unbound 探针 ✓ |
| 20 冷启动有标记不复核 | `coldStartConfirm()`：持久标记触发网络 whoami（不放行缓存），与 foregroundRecheck 共享去重 Promise；App.onShow 冷启动走 coldStartConfirm；首页 unconfirmed 分支同入口（App+页面并发只发一次请求）；演示/退出仍 veto；无标记不自动确认 | R5-20 + cold-restart/cold-home 探针 ✓ |
| 21 BP 最新取旧 | famBpEntries 降序后 stats 取第一条（最新） | R5-21 断言 latest='125/85' + three-trends 探针 ✓ |
| 22 fetal 热力图 null 崩溃 | famFetalHeatmap 从权威源生成模板形状（month/firstDayOfWeek/data[]/isToday）；isToday 用与 stats 同一响应式 healthStore.today（上海时钟） | R5-22 + three-trends（TZ=UTC）✓ |
| 23 显式 0 丢失 | famFetalEntries 按 `fetalCount !== undefined` 过滤（0 保留、未记录不出现）；stats 用 `?? 0` 不吞 0 | R5-23 entries 含 count=0、stats.count=2 |
| 追加 prompt canary | bp/fetal stats 补第三态（prompt 空对象，不读旧 store） | R5 场景 prompt 态注入 canary 后断言空 + three-trends 探针 ✓ |
| 24 App 时钟本地日比较 | App 分钟时钟改比较**上海日号**（`shanghaiDayKey`，与 familyStore/首页同一语义）——UTC 设备在上海午夜正确触发 refreshToday | R5-24 从真实 App.vue 提取生产方法断言午夜前后日号变化/同日不变 + app-clock 探针（TZ=UTC）✓ |

## 4. 独立探针复验（全部通过，TZ=UTC）

| 探针 | 结果 |
| --- | --- |
| `/tmp/momcare-b2a-midnight-audit.cjs`（TZ=UTC，含绝对值） | ✓ |
| `/tmp/momcare-b2a-mode-audit.cjs`（真实 enterDemoMode + App.onShow） | ✓（3 pass） |
| `/tmp/momcare-b2a-pregnancy-isolation-audit.cjs` | ✓（3 pass） |
| `/tmp/momcare-b2a-page-path-audit.cjs`（首页 onShow/编辑基线/adopt 断网） | ✓（3 pass） |
| `/tmp/momcare-b2a-trend-audit.cjs` | ✓ |
| `/tmp/momcare-b2a-conflict-isolation-audit.cjs` | ✓ |
| `/tmp/momcare-b2a-foreground-audit.cjs` | ✓ |
| `/tmp/momcare-b2a-cold-restart-audit.cjs` | ✓ |
| `/tmp/momcare-b2a-cold-home-audit.cjs` | ✓ |
| `/tmp/momcare-b2a-unbound-audit.cjs` | ✓ |
| `/tmp/momcare-b2a-three-trends-audit.cjs`（含 prompt canary/响应式热力图日期，TZ=UTC） | ✓ |
| `/tmp/momcare-b2a-app-clock-audit.cjs`（真实 App 分钟回调，TZ=UTC） | ✓ |

## 4. 验证

| 命令 | 结果 |
| --- | --- |
| `node --check cloud/functions/mc-{shared-records,private-notes}/index.js` | 均通过 |
| `node cloud/assemble.mjs` | 退出 0 |
| `node tests/phase-b2a.regress.cjs` | **42/42**，退出 0 |
| `node tests/phase-b1.regress.cjs` | **42/42 + 精细化 SKIP**（显式开 MC_ALLOW_LEGACY_WRITES 验证历史契约），退出 0 |
| `node tests/phase-a.regress.cjs` | **72/72**，退出 0 |
| `npm run build:h5` / `build:mp-weixin` | 均退出 0 |

B2a 42 项：R4 六项 + R5 六项（+App 上海午夜时钟）（三趋势装载/冷启动协调+去重+veto/BP 最新+fetal 热力图+0 值+prompt canary）+ 此前全系列：R4-1 孕期隔离（旧 store/磁盘逐字节不变）、R4-2 午夜绝对值+跨日、R4-2b 月末/年末/闰日/平年、R4-3 演示退出资格、R4-4 趋势 canary 三态、R4-5 旧端点关闭、R4-6 冲突比较值，加上此前的全栈/分页/恢复/幂等/schema/墓碑/竞态/会话系列。

## 5. 当前工作区变更（git status 实际 20 项）

修改（15）：App.vue、cloud/DEPLOY.md、cloud/collections.json、cloud/functions/mc-shared-records/index.js、cloud/functions/mc-private-notes/index.js、pages/family/index.vue、pages/index/index.vue、pages/profile/{bp-records,fetal-records,index,pregnancy-info,weight-records}.vue、services/sessionService.js、stores/health.js、tests/phase-b1.regress.cjs
新增（5）：cloud/functions/mc-health/、services/familyStore.js、services/outbox.js、tests/phase-b2a.regress.cjs、本交接
（utils/api.js、utils/backendGate.js、stores/report.js 等已在 B1 提交 `b97b407` 中，本轮未改）

## 6. SHA256（19 项，对应本轮实际修改/新增的源码与测试）

```
bd3b535a85502d04dea5b4c0a76000a5c9c8669a04ad0dbaeb1be55c63b612cd  cloud/functions/mc-health/index.js
6fd7ccf75292d9ebb43a7b2e943a3ad79b2d98712bd9021fa3e24b49d03d86e6  cloud/functions/mc-shared-records/index.js
4a5989b183f562c902dca81fcc417add2ddb3e5830668d18746050036d9e5ccf  cloud/functions/mc-private-notes/index.js
663883a18c73fab95ca2e57604882a033854c83398f979eb5dce01287d606ad9  services/outbox.js
de5dd80b9c2db95f76fed7abd3e984503f42e122ae8231f02a5dd9689313844d  services/familyStore.js
ec022c9590a6e0e01d97947ff0bae1a0a6deb160369dd86b7c33ff48129ce36c  services/sessionService.js
7e50c95a00add8b29b02de88865bc960b8b4c87620d14fd7c594b804c243ab28  stores/health.js
1572f43b05b275debd467f99230654f2c53cd8aeb13a6780c7e7c7e34b91fcdc  pages/index/index.vue
dd53fef19071bc7b914978fbb42725f22ad81dda02f09604a28b3d092a98a8be  pages/family/index.vue
15c832061e4fc2c21431bdbdaaac53329c14d39341c8bab688a958e7bb25d7e1  pages/profile/pregnancy-info.vue
a8bf4312e7a998e3ee31dc79938e61dc6db0149c45292e17425e6d0082a69dd9  pages/profile/weight-records.vue
ee6774f0cbd39feb2c884b4b441e9336c84c9ccce45f482affda87d0d4a45290  pages/profile/bp-records.vue
57745e8b80bf1efbcbd2a139b35113e01d8445bb0fbb18c7fbb2144d56b0c36f  pages/profile/fetal-records.vue
41297be118f9b69d15d8eee522b1da3d8b2fdf30067cde2ab7efef55155fe9ee  pages/profile/index.vue
08b4591731abcfa7c6c806f17e1f005dd43abd0cf83085f3b69872f134f80d67  App.vue
d8c00a6a2a87a024d13d85dd05511106e381eb1cf0b84ca7af1f3abc69ede91a  cloud/collections.json
e10d3e5cb05a1821c9aad19d709e42c459208b982f4e590b4f32d93ffd73b975  cloud/DEPLOY.md
52692cb8b9739719025500d4c3bbe74f4940505e652826e913452c9f1ead0d49  tests/phase-b2a.regress.cjs
f7ec62a68e225a43d938a20b34c9f209d0c3f32cbde2a0155241847ec48aeb34  tests/phase-b1.regress.cjs
```

## 7. 已知限制

1. 未部署；真实 SDK 行为/索引/规则待最终阶段（DELIVERY_STATUS 清单）。
2. B2b/C/B3 未开始。
3. 旧端点（mc-shared-records/mc-private-notes）保留为契约测试对象：默认拒绝写入，B1 套件以显式测试开关验证历史语义；B3 迁移时统一处置。

—— B2a R5 冻结，等待 Codex review。不开始 B2b；不提交/推送/部署。
