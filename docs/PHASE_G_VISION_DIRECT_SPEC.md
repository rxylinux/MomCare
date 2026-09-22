# Phase G 切片：报告解读视觉直读（deepseek-flash 多模态）

状态：ZCode 实现（2026-09-22）。触发 PHASE_G_DEEPSEEK_FLASH_MIGRATION_SPEC.md:83 预留的再议条款——「不引入 flash 视觉直读图片（Phase G 已裁定 OCR 两段式；OCR 质量实测差再议）」。

## 背景

- 2026-09-22 真机实录 OCR 两连败：①`ocr.printedText: fail not enough market quota (L0017)`——微信服务市场 OCR 配额未订购（修复后）；②配额修复后 `ocr-empty-text`——接口成功但零识别结果（手机原图直传，printedText 对大图/密排小字报告不稳）。
- DeepSeek 现役 `deepseek-flash`（V4.1-Flash）原生视觉；官方文档（api-docs.deepseek.com/zh-cn/guides/vision，2026-09-22 经用户授权抓取核实）：
  - 请求格式：`messages[].content` 块数组，图片 `{"type":"image_url","image_url":{"url":"data:<mime>;base64,..."}}`；图片仅可出现在 user 消息（system/assistant 带图 400）；
  - 仅 `deepseek-flash` 支持视觉（`deepseek-v4-pro` 无视觉）；
  - 限制：JPEG/PNG/GIF/WebP 按文件实际内容判定；单图（base64/URL）32 MiB、请求体 48 MiB、单边最长 8192px、单请求 ≤600 图；
  - 计费：每图封顶 1024 token（>544px 图缩至 ~1300×1300 等效计费），与文本一并计——成本可忽略。

## 设计

### 开关（fail-closed，独立于 OCR/DeepSeek 两开关）

`MC_REPORT_VISION` 恰 `'1'` 启用；未设/其他值=关闭（行为与 OCR 版逐字节一致——既有 51 套回归为守卫）。开启且报告有附件 → **整体绕过 OCR 阶段**（零 printedText 调用、不查 OCR 缓存）；关闭或无附件 → 现行 OCR/元数据流程原样。

### 服务端流水线（全部在 mc-tools/index.js）

1. 模型门：`deepseekModel() !== 'deepseek-flash'` → `vision-config-error` 明确拒绝（不静默降级）。
2. 附件登记核对：与 OCR 共用 `validateAttachmentPages`（自 `extractOcrForReport` 提取的共享 helper；同规则：页数封顶 3 + 本家庭 + status=registered + formalFileID 非空）→ 不符 `invalid-attachment`。
3. 逐页 `cloud.downloadFile`（15s race）→ 单页 >16MiB 或合计 >24MiB → `vision-image-too-large`（官方 32MiB/48MiB 留余量）。
4. `sniffImageMime` 魔数嗅探（JPEG/PNG/GIF/WebP；按内容判不靠扩展名；认不出 → `vision-unsupported-format`，不伪造 MIME——HEIC 走此分支）。
5. `deepseekRequestBody(prompt, { maxTokens:1600, images })`：user content 变块数组（文字块在前、图片按页序 data URI）；**无 images 时形状与纯文本体逐字节一致**（多模态改造不改变旧形状）。`thinking:{type:'disabled'}`/`temperature:0.3` 不变（官方未述视觉与 thinking 冲突——部署冒烟验证）。
6. prompt 指令：「本次请求附报告图片前 N 张…请优先依据图片中实际出现的指标与参考值逐项分析；图片中未出现的指标不得编造」；元数据行与安全边界（只送本报告自身附件）不变。
7. 持久化：`ai_result` 照旧；不写 `ocr_result`（与视觉互斥），写 `vision_result = { included:true, pageCount, generatedAt, pageFileIds }`。
8. 响应：新增 `visionIncluded`（boolean）；`ocrIncluded:false, ocrText:''`（客户端零改动——OCR 块 v-if 自然不渲染）。

### 错误码表

| code | message 摘要 |
| --- | --- |
| vision-config-error | 视觉直读需 deepseek-flash 模型（当前 MC_DEEPSEEK_MODEL 非 flash）… |
| invalid-attachment | 附件 X 不可用（未登记或已清理）（与 OCR 同） |
| vision-download-failed | 第 X 张附件下载失败/内容为空，请重试 |
| vision-image-too-large | 第 X 张附件过大 / 合计过大（须 ≤16MiB / ≤24MiB） |
| vision-unsupported-format | 第 X 张图片格式不受支持（支持 JPEG/PNG/GIF/WebP），请重拍 |
| ai-call-failed | 文案与 OCR 版一致 |

## 测试（tests/phase-g-vision.regress.cjs，test:all 自动发现）

V1 关闭态守卫（OCR 照旧+零下载）；V2 无附件元数据模式；V3 两页全链路（下载页序/ctx.images/vision_result 回写/ocr_result 不写）；V4 模型门 fail-closed；V5 登记门三例；V6 下载失败零写库；V7 单页/合计超限；V8 魔数嗅探（四格式+乱字节拒+全链路）；V9 视觉开时 printedText 零调用；V10 页数上限前 3；V11 请求体锁参（无图=旧形状 deepEqual、有图=官方块数组）；V12 AI 失败语义不变；Z9 冻结源哈希。

既有套件（phase-g-server 14/0、flash-migration 5/0、全量 51 套）一行不改全绿——关闭态行为不变的验收。

## O2 部署清单（管理员）

1. 发布：`npm run release:trial -- --desc "报告解读切换DeepSeek视觉直读" --functions mc-tools`（内含 test:all 门禁）。
2. mc-tools 环境变量加 `MC_REPORT_VISION=1`（`MC_OCR_PROVIDER=wechat` 可保留作回滚通道）；确认函数超时 ≥90s。
3. 真机对同一份报告重试 AI 解读；失败按错误码表对号取 mc-tools 日志。
4. 回滚：删除 `MC_REPORT_VISION` 即回 OCR/元数据模式，无需回滚代码。

## 风险与后续

- thinking×视觉组合官方未述——冒烟如 4xx 按报错微调（保持 disabled 首选）。
- HEIC 高频踩中的话，后续切片加客户端转码（当前如实报错）。
- 隐私：视觉模式=图片本体直接送 DeepSeek（非仅 OCR 文字）——上线指南措辞已按模式分列；正式发布前评估《用户隐私保护指引》。
