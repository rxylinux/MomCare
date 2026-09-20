# Phase E3 专项功能方案规格与实施计划：饮食/行为安全速查与 AI 代理网关

**文档状态**：Codex 架构方案冻结稿  
**执行角色**：Codex 负责方案制定、医学规范审查、代码审查、门禁把关；ZCode (GLM-5.3) 负责代码编写与自动化测试  
**依据文档**：`docs/ZCODE_SIX_FEATURES_FOLLOWUP_SCOPE.md` §E3、`docs/PHASE_E_SPECIFICATION_AND_PLAN.md` §E3、用户要求 #7、#8、#9

---

## 一、Phase E3 目标与医学信息原则

1. **高频权威本地词条库（确定性离线即开）**：
   - 覆盖孕期最高频咨询的食物与日常行为（刺身生冷、熟三文鱼低汞深海鱼、咖啡因/奶茶、溏心蛋/生蛋、未杀菌乳酪、温泉桑拿、口腔局部麻醉、烫发染发、X光辐射等）；
   - 严格标注：安全级别（`safe` / `caution` / `avoid` / `insufficient`）、前置条件（如熟透温度、每日限量）、风险解释（沙门氏菌、李斯特菌、甲基汞、体温过高致畸等）；
   - 标注权威依据（中国营养学会《孕期妇女膳食指南 (2022)》、英国 NHS (2026) 指南、美国 FDA/EPA 鱼类建议等）与审校日期。
2. **零假安全铁律（诚实未知）**：
   - 检索不命中时，**严禁**默认标记为安全，必须诚实显示“未收录 / 资料库未查到”；
   - 词条有前提条件者（如“熟透才安全”），绝不能脱离条件显示为单纯安全。
3. **云端统一 AI 代理网关（安全隔离与真实状态）**：
   - 在 `cloud/functions/mc-tools` 中构建统一的 AI Gateway 接口：
     - `ai.explainFood`：针对速查词条或未收录项请求 AI 解答；
     - `ai.analyzeReport`：针对产检体检报告提供 CloudBase 原生解读网关（承接原 Cloudflare 规划，无缝对接 Phase F）；
   - 安全控制：严禁透传客户端私密心情、私密日记或无关身体数据给 AI；
   - 零幻觉状态：当环境变量未配置大模型 API Key（`DEEPSEEK_API_KEY`）时，**明确返回未启用状态**（`enabled: false`），绝不伪造虚假通过；
   - 所有 AI 生成内容强制打上“AI 生成（未人工逐字审校）”标签并附带医疗免责声明。

---

## 二、数据模型与字典规范

### 1. 结构化词条 Schema（`static/data/food-safety.json`）
```json
{
  "id": "food_salmon_cooked",
  "name": "三文鱼（熟）",
  "category": "food",
  "level": "safe",
  "synonyms": ["熟三文鱼", "大西洋鲑", "熟鱼"],
  "summary": "优质蛋白质与 DHA 重要来源，富含 Omega-3 脂肪酸，属于低汞鱼类。",
  "conditions": "必须完全煮熟至鱼肉中心不透明、易被叉子挑散（中心温度 ≥63°C）；避免生食或烟熏半生三文鱼。",
  "risks": "生食存在寄生虫与李斯特菌感染风险；过量深海大型掠食性鱼类有甲基汞超标风险。",
  "source": "中国营养学会《孕期妇女膳食指南 (2022)》/ 美国 FDA-EPA 鱼类指南",
  "sourceUrl": "https://www.fda.gov/food/consumers/advice-about-eating-fish",
  "reviewedAt": "2026-03-01",
  "version": "1.0"
}
```

### 2. 安全等级定义
- `safe`（安全推荐 / 适量摄入）：具备充分安全证据，通常推荐或日常适量可安全食用/进行；
- `caution`（注意限制 / 条件准入）：需严格满足特定条件（如每日限量、避开孕早期、遵医嘱等）；
- `avoid`（避免 / 严格禁用）：孕期存在明确致畸、流产、严重食源性感染风险；
- `insufficient`（资料不足 / 证据不确凿）：尚无充分医学证据，建议谨慎或咨询产科医生。

---

## 三、服务端接口设计（`cloud/functions/mc-tools/index.js`）

### 1. `food.search`（可选云端同步检索 / 词条查询）
- **入参**：`{ keyword?: string, category?: 'food'|'behavior'|'all', level?: string, limit?: number }`
- **出参**：`{ ok: true, data: { items: [...], total: number } }`

### 2. `ai.explainFood`（AI 饮食行为问答网关）
- **入参**：`{ query: string, stage?: string }`
- **校验门**：
  - `query` 必须为有效非空字符串，长度 1 ~ 50 字；
  - 必须为已确认家庭成员（`resolveCaller` 鉴权）；
- **执行逻辑**：
  - 读取服务端环境变量 `process.env.DEEPSEEK_API_KEY`；
  - 若未配置或置空：返回 `{ ok: true, data: { enabled: false, message: 'AI 服务未配置或未启用，请查阅本地已审定词条或咨询医生' } }`；
  - 若配置或处于测试 Mock 环境：组织安全 Prompt（禁止提供处方用药剂量，强调产检与医生诊断），调用大模型，返回结构化摘要与明确免责声明。

### 3. `ai.analyzeReport`（报告自动解读 AI 网关）
- **入参**：`{ reportId: string }`
- **校验门**：
  - caller 必须为 `mc_reports` 中该报告所属家庭成员；
  - 报告必须存在且未被软删除（`deleted !== true`）；
- **执行逻辑**：
  - 若未配置 `DEEPSEEK_API_KEY` 或 OCR 服务：返回 `{ ok: true, data: { enabled: false, message: '报告自动 OCR / DeepSeek 解读服务未配置；请以原始检验单与主治医生诊断为准' } }`；
  - 若配置或测试 Mock 环境：提取报告关联的正式文件附件，执行指标抽取与分析，回写 `mc_reports.ai_result`，返回解读指标与行动建议。

---

## 四、客户端架构设计

1. **静态字典数据**：`static/data/food-safety.json`，离线打包，首屏毫秒级响应。
2. **Store 逻辑（`services/toolsStore.js`）**：
   - `searchSafetyDictionary(keyword, category, level)`：多字段同义词拼音与文字模糊检索；
   - `explainFoodWithAi(query, stage)`：调用 `mc-tools` 的 `ai.explainFood`；
   - `analyzeReportWithAi(reportId)`：调用 `mc-tools` 的 `ai.analyzeReport`。
3. **页面实现（`pages/tools/food-safety.vue`）**：
   - 顶部搜索框：支持快速输入与一键清空；
   - 过滤标签栏：分类（全部/食物/日常行为）+ 安全等级胶囊（全部/安全/注意/避免/资料不足）；
   - 卡片流：按状态色系渲染徽章、摘要、前提条件、风险解释与权威来源；
   - 未收录空态：诚实提示“知识库暂未收录”，并提供“向 AI 咨询（需网络与服务支持）”按钮；
   - 底部免责声明：明确不作医疗处方或个体化诊断依据。
4. **入口配置**：在 `pages.json` 中注册 `pages/tools/food-safety`，并在首页和个人页添加导航入口。

---

## 五、测试验收矩阵与门禁要求

1. **服务端回归测试（`tests/phase-e3-server.regress.cjs`）**：
   - `food.search` 检索命中与条件过滤；
   - `ai.explainFood`：未配置 Key 时的优雅 fallback、超长 query 拦截、身份鉴权与跨家庭拦截；
   - `ai.analyzeReport`：报告不存在拦截、跨家庭拦截、软删除拦截、未配置 Key 时的优雅 fallback；
2. **客户端回归测试（`tests/phase-e3-client.regress.cjs`）**：
   - 本地字典同义词匹配（如输入“溏心蛋”匹配到“生鸡蛋”；输入“拿铁”匹配到“咖啡”）；
   - 未收录词条检索返回空（绝不命中为安全）；
   - 分类与安全级别组合过滤；
   - AI 接口调用状态机与错误处理。
3. **页面回归测试（`tests/phase-e3-page.regress.cjs`）**：
   - 页面渲染、搜索响应、标签切换；
   - 详情卡片折叠/展开与免责声明文本核验；
   - 未收录时 AI 咨询入口与提示。
4. **门禁铁律**：所有新增用例与历史全量用例 100% 绿灯方可 commit。
