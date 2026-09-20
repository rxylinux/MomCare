# Phase F 专项规划：Cloudflare 历史功能全量收敛与 CloudBase 迁移

**文档状态**：Codex 架构规划冻结稿  
**执行定位**：在 Phase E（计时器、估重、速查）完成后立即执行，彻底收敛旧 Cloudflare 遗留功能，实现 100% 微信云开发原生闭环。

---

## 一、Cloudflare 原有功能资产盘点与迁移现状

| 历史功能 / 接口 | 原 Cloudflare 实现 | 当前状态 | Phase F 迁移目标与落地方案 |
|---|---|---|---|
| **1. 身份与登录**<br>`/api/login`, `/api/register` | Worker JWT 认证 | 已迁移至 B1 | 采用微信云开发可信身份（`mc-identity` / `auth.js`）。已闭环。 |
| **2. 个人孕期档案**<br>`/api/user/profile` | Worker KV/D1 存取 | 已迁移至 B2a | 采用 CloudBase `mc_pregnancy` 权威集合（单例）。已闭环。 |
| **3. 每日健康记录**<br>体重/血压/胎动/心情 | Worker 存取 | 已迁移至 B2a | 采用 `mc_health_daily`（共享）与 `mc_moods`（私人隔离）。已闭环。 |
| **4. 产检与待产包**<br>检查项、清单 | Worker 存取 | 已迁移至 B2b1 | 采用 `mc_checkups` 与 `mc_bag_items`。已闭环。 |
| **5. 报告原件与附件管理**<br>`/api/reports`, `/upload` | Worker + R2 存储 | 已迁移至 B2b2 | 采用 `mc_files`（云存储双目录）与 `mc_reports`。已闭环。 |
| **6. 报告自动 OCR 与 AI 解读**<br>`/api/analyze-report` | Worker 调用外部大模型/OCR | **尚未迁移**<br>（前端标记未启用） | **【Phase F 核心任务一】**：在 CloudBase 中构建原生报告 AI 解读流水线，抓取云存储附件图片执行 OCR 提取与 DeepSeek 指标解读。 |
| **7. 孕育知识库与文章**<br>`/api/articles` | Worker 动态拉取文章列表与详情 | **尚未迁移**<br>（前端关闭旧 HTTP 后文章空） | **【Phase F 核心任务二】**：将全套孕产、哺乳、育儿权威知识库完整打包为本地确定性静态库（及 CloudBase 同步集合），离线即开，杜绝旧接口 404。 |
| **8. 客户端残留 Cloudflare 代码**<br>`API_BASE`, `legacyHttpEnabled` | `utils/api.js` 指向 `*.workers.dev` | **待拔除** | **【Phase F 核心任务三】**：彻底拔除客户端对 `workers.dev` 的硬编码域名引用与旧请求封套，实现小程序全栈对微信云开发原生的 100% 纯净闭环。 |

---

## 二、Phase F 具体实施三大任务

### 任务一：体检报告 AI 自动识别解读流水线（CloudBase 迁移）
1. 云函数实现 `report.analyze` 动作：
   - 权限校验：验证报告属于当前家庭且 caller 为家庭成员；
   - 提取文件：根据报告中的 `attachments` 列表读取 `mc_files` 正式文件句柄；
   - OCR 文本提取：调用云端 OCR 接口（或 DeepSeek 视觉模型）提取报告原始文字；
   - 结构化指标提炼：提取检验项目名、检测值、参考范围、异常高低标识，并生成行动建议；
   - 结果落库：更新 `mc_reports` 的 `ai_result`，包含 `overall_summary`、`indicators[]`、`suggestions[]`；
   - 异常安全处理：超时、配额不足或无法识别时，诚实返回待确认状态，不扣除用户配额。
2. 前端改造：
   - `stores/report.js` 中的 `triggerAiPipeline` 移除旧 `/api/analyze-report` 的 HTTP `request` 调用，改走 `sessionService.familyCall('mc-reports', { action: 'report.analyze', ... })`；
   - `pages/archives/ai-result.vue` 接入新数据结构，展示逐项指标与医生免责声明。

### 任务二：孕育知识库（Articles）全面离线化与云原生闭环
1. 数据规范化：
   - 梳理孕早期、孕中期、孕晚期、分娩准备、产后恢复等核心分类的权威文章库；
   - 打包为本地离线静态资源 `static/data/articles.json`（与 `pregnancy-daily.json` 模式一致）；
2. 页面重构：
   - `pages/knowledge/index.vue` 与 `pages/knowledge/detail.vue` 移除对旧 `/api/articles` 的 HTTP 请求；
   - 从本地 Store（`stores/staticData.js`）直接同步读取，实现毫秒级加载、分类筛选、全文检索与收藏功能，离线断网完全可用。

### 任务三：彻底拔除旧 HTTP 依赖与安全审计
1. 废弃 `utils/api.js` 中所有对 `workers.dev` 的依赖，全面统一至 `sessionService.familyCall`；
2. 编写全量工程静态扫描与审计套件 `tests/phase-f-audit.regress.cjs`：
   - 扫描所有 Vue 与 JS 文件，断言零残留 `workers.dev` 调用；
   - 断言报告 AI 与知识库完全脱离旧接口且功能完整可用。
