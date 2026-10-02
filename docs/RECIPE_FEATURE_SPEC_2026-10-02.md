# 孕期食谱功能 实施方案（已实施 ✅ 2026-10-02）

> **实施结果**：全部 6 步完成——`static/data/pregnancy-recipes.json`（92 道完整含食材/步骤）、`services/toolsStore.js` 纯函数区（5 函数）、`pages/tools/recipes.vue`（阶段卡+今日三餐+营养胶囊+分组列表）、入口注册 2 处、`tests/phase-recipes.regress.cjs`（20 断言组全过）；全量回归 78 套件 exit 0；`build:mp-weixin` exit 0；数据内联验证（编译产物含 92 道内容）；纯代码 2.0MB 与实施前持平。

> 依据：[docs/recipe-draft.md](./recipe-draft.md)（2026-10-01 定稿 + 三轮校验：菜单审定 / DRIs 2023 核对 / 指南食物量校验）。
> 本文档为编码前实施方案，批准后按第八节步骤执行。
> 原则：全部离线、零云函数、复用 food-safety 架构先例、发布闭包零改动。

## 一、目标与范围

**第一版做**：
- 92 道食谱 + 11 营养素 + 5 周段的静态数据内置；
- 新工具页 `pages/tools/recipes.vue`：按孕周自动定位周段 → 营养重点胶囊 → **今日三餐卡**（无状态确定性轮换，工作日/周末池切换）→ 分组菜谱 → 卡片展开做法；
- 首页"常用工具"宫格第 5 项入口；
- 1 个数据 schema + 检索 + 三餐轮换回归测试套件。

**第一版不做**（后期可选，见 recipe-draft 第六节）：云函数伴生模块与生成器、AI 定制食谱、忌口偏好档案、与 weekly-guide/daily/词典的双向跳转、菜名同义词检索。

## 二、数据层

### 2.1 单一作者源

新增 `static/data/pregnancy-recipes.json`（构建期 import，全离线，照 food-safety.json 模式；**不做**云端生成器——词典需要双端是因云函数查词，食谱无此需求）：

```json
{
  "version": "1.0",
  "generatedFrom": "docs/recipe-draft.md (2026-10-02 定稿版)",
  "nutrients": [ {key, name, why, sources, reference, foodGuide, source, reviewedAt} × 11 ],
  "stages":    [ {key, range:[min,max], label, nutrientPriority[], stageNote} × 5 ],
  "recipes":   [ ...92 条 ]
}
```

营养素条目含 `foodGuide` 字段（食物量速查口径，页面主展示文案）；`reference` 为数值+来源（详情折叠展示）。

### 2.2 菜谱 schema

```json
{
  "id": "r-001",                    // 唯一，前缀 r-，三位递增
  "name": "彩椒炒牛肉",
  "stages": ["mid1","mid2","late1"], // 枚举：early|mid1|mid2|late1|late2，非空
  "mealType": ["lunch","dinner"],    // 枚举：breakfast|lunch|dinner|snack
  "nutrients": [ {"key":"iron","weight":"primary"}, {"key":"protein","weight":"secondary"} ],
                                     // key 必须存在于 nutrients 表；每道恰好 1 个 primary
  "summary": "牛里脊+彩椒（维C促铁吸收的教科书搭配）",
  "ingredients": [ {"name":"牛里脊","amount":"100g"} ],   // 非空
  "steps": ["...", "..."],                                 // 非空，2~6 步
  "nutritionNote": "牛肉富含血红素铁…",
  "cautions": ["牛肉务必炒至全熟…"],                         // 可空数组，不可缺字段
  "bentoFriendly": true,            // 隔夜带饭适配（bool，按"带饭口径"标注）
  "rotation": "pool",               // 'pool' 参与今日三餐轮换 | 'excluded' 频率受限不自动推荐
                                     // excluded 清单（9 道）：猪肝×2、海带×2、腌制高钠×4、早茶拼盘
  "origin": "user-approved",        // user-approved(用户25道) | curated(我方扩充)
  "source": "通行家常做法整理；营养关联依据《中国居民膳食指南》孕期分册",
  "reviewedAt": "2026-10-02", "version": "1.0"
}
```

### 2.3 草稿 → JSON 转换规则

- 跨段括注解析：`适用全程`→全 5 段；`适用 mid1–late1`→[mid1,mid2,late1]；`适用 mid2–late1`→[mid2,late1]；`适用 mid1–late2`→[mid1,mid2,late1,late2]；`适用 mid2–late2`→[mid2,late1,late2]；无标注→归属段单元素。
- `origin`：用户审定的 25 道标 `user-approved`，其余标 `curated`。
- **补全工作量主体**：草稿表格只有一句话做法，92 道中仅附录 2 道有完整食材/步骤。其余 90 道由我按通行家常做法补全（不虚构独门做法，与草稿"关键注意"一致），**补全后输出清单供抽审**（重点抽审 `user-approved` 的 25 道）。
- 非奶铁律：ingredients 全量校验零奶制品（牛奶/酸奶/奶酪/黄油/奶油）。

### 2.4 schema 校验规则（进测试套件，任一失败即 exit 1）

1. 顶层三段均为非空数组；nutrients 恰 11 条、stages 恰 5 条且 range 连续覆盖 1–40 周无重叠；
2. recipes 恰 92 条；id 唯一且格式合法；stages/mealType/nutrients.key 枚举合法；
3. 每道恰 1 个 primary；ingredients/steps 非空；cautions/bentoFriendly/rotation 字段存在；
4. nutrients 引用闭合（菜谱用到的 key 必须在营养素表内；stages.nutrientPriority 同理）；
5. 非奶断言：92 道的 ingredients 与 name 不含奶制品关键词；
6. 覆盖断言：每段每重点营养 ≥3 道 primary（碘/维D/锌豁免段按草稿覆盖度核对说明）；
7. rotation='excluded' 恰 9 道且与草稿清单一致；带饭十二选的 `bentoFriendly:true` 齐备。

## 三、检索与阶段定位（`services/toolsStore.js` 追加，约 60 行）

- `getStageByWeek(week)`：week→stage key（1–12/13–19/20–27/28–35/36–40，越界 clamp）；
- `getStageFocus(stageKey)`：返回该段 stage + priority 营养素对象数组（供页面胶囊）；
- `listRecipes(stageKey?)`：按段过滤（跨段按 stages 数组包含）；
- `searchRecipes(keyword, {stageKey, nutrientKey, mealType})`：菜名+食材名子串匹配（与 searchSafetyDictionary 同口径：本地、无同义词、未命中返回空数组——四态空态沿用）；
- `buildDailyMeals({dateKey, week, weekday})`：今日三餐无状态确定性轮换——`seed = dayOfYear + 周段偏移`；早餐从 breakfast∩段池、午餐从 lunch∩段∩(周末? 全池 : bentoFriendly 池)、晚餐从 dinner∩段池选；营养覆盖（午餐优先段第一优先营养、晚餐第二优先，池空回退全段池）；`rotation:'excluded'` 的 9 道全程排除；返回 `{breakfast, lunch, dinner, snack, focusTags, mode:'weekday'|'weekend'}`；同 seed 必得同组合（纯函数）。

孕周来源：`stores/health.js` 的 `todayWeekInfo`（本地权威）；未登记 LMP 时页面显示**阶段手动切换器**（不猜身份、不猜孕周，同"零假安全"口径）。

## 四、页面 `pages/tools/recipes.vue`

抄 food-safety.vue 骨架（原生导航栏 + `.head` 标题区 + 工具页视觉语言：#f5f7fb 背景/24rpx 白卡/999rpx 胶囊/底部安全区），结构：

1. **阶段卡**：当前周段 + `孕X周+Y`（有 LMP 时）+ 阶段说明 + 手动切换器（无 LMP 或用户主动切换）；
2. **今日三餐卡**（阶段卡下方）：早/午/晚(+加餐)四行菜名+分组标签，底部"今日主打：铁 · DHA"+ 工作日/周末模式标签；"换一组"按钮仅内存偏移；
3. **营养重点胶囊**（3 个，按 priority）：点开弹层——食物量口径主展示（`foodGuide`），数值+来源折叠；
4. **tab**：本阶段 / 全部 / 搜索；本阶段视图按 primary 营养 × priority 顺序分组（"补铁 8 道"组头）；带饭筛选胶囊（bentoFriendly）；
5. **食谱卡**：菜名 + 餐型 + 营养标签胶囊 → 点击展开 ingredients/steps/nutritionNote/cautions（cautions 高亮）；
5. **四态空态**（诚实口径）：初始态/搜索未命中（"未收录，可换关键词"）/筛选无结果/阶段无菜（理论不发生，防御态）；
6. **底部固定医学免责声明**（文案沿用 food-safety 位置与风格）。

不做：收藏、今日推荐、外部跳转（均为后期项）。

## 五、入口注册（2 行改动）

- `pages.json`：tools 页段落 +1 行（`pages/tools/recipes`，`navigationBarTitleText: "孕期食谱"`）；
- `pages/index/index.vue`：`TOOL_ENTRIES` 数组 +1 项（name/icon/url）。

## 六、测试与验收

### 6.1 新增测试套件 `tests/phase-recipes.regress.cjs`

（命名避开已占用的 phase-r1~r4 修复套件）内容：§2.4 全部 schema 断言 + 检索函数（getStageByWeek 边界 0/1/12/13/20/28/36/40、跨段菜过滤、搜索命中/未命中、非奶断言）+ **三餐轮换断言**（同 seed 同组合的确定性、跨 seed 变化、工作日午餐池不含鱼虾而周末含、rotation excluded 9 道永不出现、营养覆盖命中段优先级）。仅 require 生成物与 toolsStore 纯函数，用临时 fixture，不触真实 storage/云。

### 6.2 验收标准（用户可检验）

1. 首页宫格出现"孕期食谱"，点击进入；
2. 未登记 LMP → 阶段手动切换；已登记 → 自动定位孕周与周段、胶囊正确；
3. 切段/搜索/分组/展开/免责声明全部可用；92 道可数；
4. `node tests/phase-recipes.regress.cjs` exit 0；全量现有回归（74 套件）不回归；
5. `npm run build:mp-weixin` 通过，主包体积增量 <300KB 且未超微信 2MB 限制（实施前先测当前主包余量，不足则评估图片/数据压缩）。

## 七、发布影响

- **零云函数改动、零发布闭包改动**：`release-dependency-closure.mjs` 只映射 food-safety，本数据纯客户端，不触发 mc-tools 重部署；
- 随下一次 trial 版本发布（release-trial 流程无需变更，manifest 版本号照常递增）；
- 不涉及任何用户数据、storage key、云集合变更。

## 八、实施步骤与文件清单

| 步骤 | 内容 | 产物 |
|---|---|---|
| 1 | 92 道 JSON 转换与补全（含 90 道食材/步骤补写，含 bentoFriendly/rotation 标注） | `static/data/pregnancy-recipes.json` + 补全清单（供抽审） |
| 2 | toolsStore 追加 4 个纯函数 | `services/toolsStore.js` |
| 3 | 新页面 | `pages/tools/recipes.vue` |
| 4 | 入口注册 2 行 | `pages.json`、`pages/index/index.vue` |
| 5 | 测试套件 + 全量回归 + 构建验证 | `tests/phase-recipes.regress.cjs` |
| 6 | 文档收尾（draft 标记已实施、DELIVERY_STATUS 登记） | docs 更新 |

预估：数据补全是主体（90 道完整化），代码侧约 4 文件、400 行内（含三餐轮换）。

## 九、风险与待确认

1. **主包体积**：92 道完整 JSON 估 250~350KB，实施前先测当前主包余量；
2. **90 道补全内容**：按通行家常做法补写，无法逐道送审——按"补全清单+重点抽审 user-approved 25 道"控制，接受度由你定；
3. 菜谱页与词典的跳转本期不做，cautions 中的"见饮食安全词典"为纯文字提示（无链接）；
4. 如你要求 92 道全部逐道送审，步骤 1 拆两批交付（先 user-approved 25 道，再 curated 67 道）。
