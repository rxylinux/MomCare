# Phase F 专项功能方案规格与实施计划：Cloudflare 历史功能全量收敛与 CloudBase 迁移

**文档状态**：Codex 架构方案冻结稿  
**执行角色**：Codex 负责方案制定、医学规范审查、代码审查、门禁把关；ZCode (GLM-5.3) 负责代码编写与自动化测试  
**依据文档**：`docs/PHASE_F_CLOUDFLARE_MIGRATION_SPEC.md`、用户指示 #8、#9

---

## 一、Phase F 核心目标与实施路径

彻底收敛原 Cloudflare Worker（`workers.dev`）历史遗留资产，将体检报告 AI 解读与孕育知识库全量迁移至微信云开发原生与本地离线静态库，实现小程序全栈对微信云开发原生的 100% 纯净闭环：

1. **任务一：体检报告 AI 自动识别解读流水线（CloudBase 原生闭环）**：
   - 彻底废除客户端 `stores/report.js` 中对旧 Cloudflare HTTP `/api/analyze-report` 的依赖；
   - 全面转接云原生统一网关 `mc-tools` 的 `ai.analyzeReport` 动作（在 Phase E3 已就绪）；
   - 客户端建立统一状态机：未配置 Key 时优雅返回“未配置，请遵医嘱”提示；配置或 Mock 注入时回写 `mc_reports.ai_result` 并渲染结构化指标与医生免责声明；
   - 杜绝一切未授权网络外发。
2. **任务二：孕育知识库（Articles）全面离线化与秒开检索**：
   - 构建高质量本地权威文章库 `static/data/articles.json`（涵盖孕早期、孕中期、孕晚期、分娩临产、产后育儿 18 篇全流程文章）；
   - 在 `stores/staticData.js` 中扩充 `articlesData` 索引、分类筛选、关键词检索、排序与按 ID 查询；
   - `pages/knowledge/index.vue` 与 `pages/knowledge/detail.vue` 拔除旧 HTTP 接口请求，直连 `staticDataStore`，实现 100% 离线可用与零延时渲染，彻底根治旧接口 404 导致知识库空白的缺陷。
3. **任务三：彻底拔除旧 Cloudflare HTTP 代码与全量安全静态审计**：
   - 清理 `utils/api.js` 中对 `workers.dev` 的硬编码域名引用，将 `API_BASE` 置空；
   - 编写全量工程静态审计回归套件 `tests/phase-f-audit.regress.cjs`，静态扫描所有源文件，断言零残留 `workers.dev`。

---

## 二、数据模型与字典规范

### 1. 文章库数据结构（`static/data/articles.json`）
```json
{
  "id": "art_early_01",
  "title": "怀孕初期的身体变化与早孕反应应对指南",
  "subtitle": "科学缓解孕吐、乳房胀痛与嗜睡疲倦",
  "summary": "全面解析孕早期激素变化带来的常见身体反应，提供少食多餐等实用缓解建议。",
  "category": "孕早期必读",
  "tags": ["必看", "早孕反应", "孕早期"],
  "cover_icon": "🌱",
  "cover_image": "",
  "read_time": 4,
  "view_count": 12800,
  "publish_time": "2026-03-01T08:00:00.000Z",
  "target_week_start": 4,
  "target_week_end": 12,
  "content": "..."
}
```

### 2. 报告 AI 流水线状态机（`stores/report.js`）
- `triggerAiPipeline(reportId)`:
  - 演示模式：提示“演示模式暂不支持 AI 解读”，返回 `false`；
  - 正式模式：调用 `toolsStore.analyzeReportWithAi({ reportId })`（经 `sessionService.familyCall('mc-tools', { action: 'ai.analyzeReport', reportId })`）；
  - `data.enabled === false`：不报错，弹出提示“报告自动 OCR / DeepSeek 解读服务未配置；请以原始检验单与主治医生诊断为准”；
  - `data.enabled === true`：解析结果，更新 `report.ai_result`，标记 `ai_status: 'done'`, `ocr_status: 'done'`，触发视图刷新。

---

## 三、门禁要求与测试套件（`tests/phase-f-audit.regress.cjs`）

1. **Audit 1: 全局静态扫描**：
   - 正则扫描 `pages/`, `components/`, `services/`, `stores/`, `utils/`, `cloud/` 下所有源文件，断言 `workers.dev` 出现次数为 0。
2. **Audit 2: 知识库本地 Store 契约**：
   - 验证 `staticDataStore` 成功载入全部 18 篇静态文章；
   - 验证分类筛选（孕早期必读、孕中期指南等）、关键词搜索、阅读量/发布时间排序与分页；
   - 验证根据 ID 获取文章详情。
3. **Audit 3: 知识库页面脱离网络验证**：
   - 模拟调用 `pages/knowledge/index.vue` 的 `fetchArticles` 与 `pages/knowledge/detail.vue` 的 `loadArticleById`；
   - 断言 `uni.request` 调用次数严格为 0；
   - 验证文章列表与详情成功渲染。
4. **Audit 4: 报告 AI 原生网关联动验证**：
   - 验证 `reportStore.triggerAiPipeline` 走 `mc-tools` 的 `ai.analyzeReport`；
   - 验证未配置 Key 时的安全提示分支；
   - 验证 Mock 成功时的 `ai_result` 回写与状态更新。
5. **门禁铁律**：`phase-f-audit` 100% 通过且已有 24 套回归套件保持 100% 绿灯。
