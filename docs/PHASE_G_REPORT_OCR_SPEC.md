# Phase G：报告 OCR 提取与 AI 解读升级（规格）

状态：ZCode 实现（2026-09-21 启动）。用户已裁定：OCR 提供方默认微信云调用 OCR、腾讯云 OCR 作为同抽象层备选；O1（本地开发）与 O2（部署联调）一起赶。

## 背景与现状

- `mc-tools` 的 `ai.analyzeReport`（当前实现）仅向 DeepSeek 送**报告元数据**（日期/类型/备注前 100 字/附件数），不含报告图像内容；README 宣传的"OCR 自动提取文字"在 CloudBase 版从未实现。
- 报告图片上传通道（B1 三段式：`fileUploadService.js` 客户端 + `mc-files` 服务端）代码已完备，仅被两道配置闸门关闭（暂存目录存储规则未部署 + `MC_UPLOAD_ENABLED` 未设）。
- `mc_reports.attachments` 为 `[{ fileId }]` 数组，引用 `mc_files` 中**本家庭、status=registered** 的文件（`formalFileID` 为云存储正式句柄）；`mc-reports` 的 `report.getReadUrls` 已确立"附件登记核对 + 临时 URL"的服务端校验模式。

## 目标

1. `ai.analyzeReport` 升级为完整流水线：附件图片 → OCR 文字提取 → 元数据 + OCR 文本 → DeepSeek 解读。
2. OCR 提供方做成环境变量可切换的抽象层（`mock` 注入 / `wechat` 云调用 / `tencent` API），默认微信云调用 OCR，无需额外账号密钥。
3. OCR 提取文本持久化到报告文档并回传客户端展示（用户可核对识别质量，符合"可验证、不伪造"原则）。

## 非目标

- 不改变上传通道开关（O2 部署期由管理员开启，规则不变）。
- 不做独立的"仅 OCR"动作、不做 OCR 结果编辑（MVP）。
- 不引入视觉大模型（用户已裁定 DeepSeek 文本模型 + OCR 两段式）。

## 服务端设计（mc-tools）

### OCR 提供方抽象（fail-closed）

```
ocrProvider():
  1. 测试 mock 注入（__setOcrMock）优先
  2. MC_OCR_PROVIDER === 'wechat'    → 云调用 OCR（openapi ocr.printedText）
  3. MC_OCR_PROVIDER === 'tencent' 且 MC_OCR_TENCENT_SECRET_ID/KEY 均在 → 腾讯云 GeneralBasicOCR
  4. 其余（未配置 / tencent 缺密钥）→ null = OCR 未启用
```

- 未启用时 `ai.analyzeReport` **照常运行**（元数据模式，现行为），响应多带 `ocrIncluded:false`——DeepSeek 与 OCR 是独立开关，互不连带拒绝。
- `MC_OCR_PROVIDER=tencent` 但密钥缺失 → OCR 整体未启用（不静默降级 wechat）。

### 微信云调用 OCR 路径

1. 附件登记核对（与 `report.getReadUrls` 同规则）：`mc_files` 文档存在、同家庭、`status==='registered'`、`formalFileID` 非空；任一不符 → `invalid-attachment`。
2. `cloud.getTempFileURL({ fileList })` 取临时 URL。
3. `cloud.openapi.ocr.printedText({ img_url })` 提取，`words_result[].words` 拼接。
4. 函数目录新增 `config.json` 声明云调用权限 `ocr.printedText`（`cloud/assemble.mjs` 同步打包）。

### 腾讯云 OCR 备选路径

`cloud.downloadFile({ fileID })` 取 Buffer → Base64 → TC3-HMAC-SHA256 签名请求 `ocr.tencentcloudapi.com` `GeneralBasicOCR`（`2018-11-19`）→ `TextDetections[].DetectedText` 拼接。HTTPS 超时 15 秒。

### 流水线边界（全部常量固化）

| 项 | 值 | 理由 |
| --- | --- | --- |
| OCR 页数上限 | 3 张/次 | 控制时延与云调用配额 |
| 单页超时 | 15 秒（race） | 防单页挂死拖垮整函数 |
| OCR 文本上限 | 2000 字符（Array.from 计数） | prompt 有界；超出截断并标注 |
| 复用缓存 | 报告已有 `ocr_result` 且 `pageFileIds` 与当前附件集合一致且 provider 同类 | 不重复计费/识别 |
| 失败语义 | 任一页提取失败 → 整次 `ai.analyzeReport` 失败（`ocr-call-failed`） | 多页报告缺页解读会误导，宁失败不部分成功 |

### `ai.analyzeReport` 升级（单一客户端动作不变）

- prompt 升级：有 OCR 文本时指令为"基于以下 OCR 提取文本（可能有识别误差）逐项分析指标与参考值，不得编造文本中未出现的指标"，并附截断后的 OCR 文本。
- 安全边界不变：仅送报告公开元数据 + 该报告自身附件的 OCR 文本；严禁透传心情/日记/无关身体数据。
- CAS 事务（现模式）：`merged.ai_result`（现有）+ `merged.ocr_result = { text, included:true, provider, generatedAt, pageFileIds }`（仅 OCR 实际执行时写入）。
- 响应新增：`ocrIncluded`（boolean）、`ocrText`（string，未含时为 `''`）。
- 零幻觉：无 OCR（无附件或未配置）与有 OCR 的响应都如实标注，不伪造"已读图"。

### 环境变量（新增）

| 变量 | 作用 | 缺省 |
| --- | --- | --- |
| `MC_OCR_PROVIDER` | `wechat` / `tencent` | 未设 = OCR 未启用 |
| `MC_OCR_TENCENT_SECRET_ID` / `MC_OCR_TENCENT_SECRET_KEY` | tencent 路径必需 | — |

`DEEPSEEK_API_KEY` 仍为 DeepSeek 开关（独立于 OCR）。

## 客户端设计（最小改动）

1. `stores/report.js` `triggerAiPipeline`：`ocr_text` 改存服务端返回的 `data.ocrText`（修复现占位逻辑把 AI 回答误存为 ocr_text 的问题）。
2. `pages/archives/ai-result.vue`：新增"报告原文提取（OCR）"展示区（有文本才渲染），供核对识别质量；带"识别可能有误，以原件为准"提示。
3. 饮食 AI 咨询（`ai.explainFood`）不涉及附件，不改。

## 测试计划（本地，全部 mock，零真实外呼）

新增 `tests/phase-g-server.regress.cjs`（沿用 phase-e3-server 的 mock 云基建，扩展 `getTempFileURL`/`downloadFile`/`openapi.ocr.printedText` mock）：

1. OCR 未启用（无 MC_OCR_PROVIDER）+ 有附件 → 元数据模式成功，`ocrIncluded:false`，不写 `ocr_result`。
2. wechat 提供方 + 无附件 → 元数据模式，不触发 OCR。
3. wechat 提供方 + 2 附件 → 临时 URL → printedText 两页 → prompt 含 OCR 文本（断言 DeepSeek mock 收到的 prompt）→ `ocr_result` CAS 写入、`ocrIncluded:true`、`ocrText` 回传。
4. OCR 文本超 2000 字符 → 截断 + 截断标注。
5. 任一页 OCR 失败 → 整次 `ocr-call-failed`，不写库、不消耗语义（客户端恢复状态）。
6. 附件登记不符（未 registered/跨家庭/不存在）→ `invalid-attachment`。
7. 缓存复用：同附件集合二次调用不再请求 printedText（计数器断言），prompt 仍含文本。
8. 附件集合变化（增删页）→ 不复用，重新 OCR。
9. `MC_OCR_PROVIDER=tencent` 缺密钥 → OCR 未启用（元数据模式，非降级）。
10. revision 冲突路径（事务 CAS 败者）→ 现有行为不回归。
11. `assemble:cloud` 产物含 `mc-tools/config.json`。

客户端小修（ocr_text 存储）随既有 phase-e3-client 套件补 1 例。

## O2 部署清单（管理员操作，随本规格交付）

1. 开上传通道：部署暂存目录存储规则 + `mc-files` 设 `MC_UPLOAD_ENABLED=1`（指南可选项 A 原文）。
2. `mc-tools` 环境变量：`DEEPSEEK_API_KEY` + `MC_OCR_PROVIDER=wechat`（tencent 备选时改配三变量）。
3. `mc-tools` 超时 ≥ 90 秒（OCR 3 页最坏 45s + DeepSeek 20s + 余量；以控制台支持上限为准）。
4. 云调用权限：确认部署后控制台函数配置可见 `ocr.printedText` 权限（config.json 随包上传）。
5. 隐私指引补充：报告图片将经微信 OCR 服务（腾讯体系）提取文字并送 DeepSeek（中国境内服务）处理——如实申明。
6. 真机验收：真实报告照片走通 上传→OCR→解读 全链路（成功/模糊照片失败/无网络失败三态）。

## 验收标准

- 本地：新套件全绿 + 既有 phase-e3-server/client/page 套件不回归 + `assemble:cloud`/`build:mp-weixin` 产物核验通过。
- 联调（部署后）：真实图片 OCR 成功出文本、解读引用了实际指标、失败路径如实报错不伪造。
