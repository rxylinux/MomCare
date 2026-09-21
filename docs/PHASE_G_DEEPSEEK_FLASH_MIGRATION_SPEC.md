# Phase G 切片：mc-tools 迁移 DeepSeek V4.1-Flash（规格）

状态：**已实施（本地，2026-09-21）**，未部署未提交。四项裁定齐（用户 2026-09-21）：①换模型+显式关 thinking、②max_tokens 分档 800/1600（初拟 1200 上调）、③model 标识如实化、④MC_DEEPSEEK_MODEL 白名单（非法值静默回落+warn——不挡服务，用户已裁）；部署前最小实调**已获授权执行**。本地验证：新套件 phase-g-flash-migration 5/0 + 全量 48 套 EXIT=0。

## 背景与依据

- `deepseek-chat` 官方 2026-04-24 公告、**2026-07-24 已停用**（api-docs.deepseek.com/zh-cn/updates）；现调用疑似仍被宽容路由，但无任何文档保证——mc-tools/index.js `callDeepSeek` 硬编码该模型名属现网定时炸弹。
- DeepSeek 现役模型仅两个：`deepseek-flash`（V4.1-Flash，2026-09-10 上线，原生视觉，**thinking 默认开且 effort 默认 high**）与 `deepseek-v4-pro`（无视觉，贵 ~4x）。本迁移目标 `deepseek-flash`。
- 官方思考模式指南：关闭写法 `thinking: {"type": "disabled"}`（OpenAI 兼容裸 HTTP 为请求体顶层字段，与 SDK `extra_body` 同协议）；思考模式下 `temperature` 无效（不报错）——关闭后 0.3 恢复生效；思维链经 `reasoning_content` 返回，与 `content` 同级。
- Phase G（docs/PHASE_G_REPORT_OCR_SPEC.md）的 OCR→DeepSeek 流水线代码已完备，仅部署闸门未开。本切片不动 OCR/上传通道，只动 DeepSeek 调用层。

## 设计

### 1. 模型配置：常量 + 环境变量白名单（裁定④）

```js
// ── DeepSeek V4 模型配置 ──
// MC_DEEPSEEK_MODEL 白名单：缺省 deepseek-flash；非法值回落缺省（防任意值注入请求体）
const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro']
const DEEPSEEK_MODEL_DEFAULT = 'deepseek-flash'
function deepseekModel() {
  const v = process.env.MC_DEEPSEEK_MODEL
  if (DEEPSEEK_MODELS.includes(v)) return v
  if (v !== undefined) console.warn('[mc-tools] MC_DEEPSEEK_MODEL 非白名单值，回落', DEEPSEEK_MODEL_DEFAULT, ':', String(v))
  return DEEPSEEK_MODEL_DEFAULT
}
```

- 函数级解析（非模块级常量）：测试需在运行中改 `process.env` 验证白名单与回落。
- 每次调用读 env：云函数 env 冷启动后固定，重复读无代价；非法配置时逐次 warn 有助部署排障。
- `deepseek-v4-pro` 同样支持思考/非思考双模（官方价目页"Same thinking-mode support"），白名单内两值对 `thinking:disabled` 均合法。

### 2. 请求体构造提为可测纯函数（含裁定①②）

```js
// 分场景输出上限（裁定②，档位 1600 经用户 2026-09-21 二次裁定上调）：报告解读逐项分析输出更长，800 有截断风险
const AI_MAX_TOKENS = { explainFood: 800, analyzeReport: 1600 }

// 请求体构造（纯函数）：__deepseekRequestBody 为测试注入口——零外呼锁参数回归
function deepseekRequestBody(prompt, opts) {
  const maxTokens = opts && Number.isInteger(opts.maxTokens) ? opts.maxTokens : AI_MAX_TOKENS.explainFood
  return {
    model: deepseekModel(),
    messages: [
      { role: 'system', content: safetySystemPrompt() },
      { role: 'user', content: prompt }
    ],
    thinking: { type: 'disabled' }, // V4 默认开 thinking——思考 token 挤占 max_tokens 且拉高延迟，本场景必须关
    temperature: 0.3,
    max_tokens: maxTokens
  }
}
exports.__deepseekRequestBody = deepseekRequestBody
```

`callDeepSeek` 改为 `JSON.stringify(deepseekRequestBody(prompt, opts))`，**HTTP 层零改动**（hostname / path / 20s 超时 / `choices[0].message.content` 解析链 / 错误语义 `ai-empty-response`、`ai-malformed-response`、`ai-timeout` 全保留——非思考模式正文即在 `content`，解析不需改）。

### 3. aiProvider 改造（model 标识如实化 + 分档接线）

```js
function aiProvider() {
  if (aiMock) return { kind: 'mock', call: aiMock }
  const key = process.env.DEEPSEEK_API_KEY
  if (key) {
    return {
      kind: deepseekModel(), // 如实：'deepseek-flash' / 'deepseek-v4-pro'（原 'deepseek'）
      call: (prompt, context) => callDeepSeek(key, prompt, {
        maxTokens: context && context.kind === 'analyzeReport'
          ? AI_MAX_TOKENS.analyzeReport : AI_MAX_TOKENS.explainFood
      })
    }
  }
  return null
}
```

- `kind` 直接透传至响应 `model` 字段与落库 `ai_result.model`——已盘点：生产代码无 `kind === 'deepseek'` 分支判断；现有测试仅断言 `model === 'mock'`（phase-e3-server L181/L240），**零连带改动**。
- `context.kind` 两个调用点（`ai.explainFood` / `ai.analyzeReport`）均已传入，分档接线不新增调用方改动。
- mock 分支（`kind: 'mock'`）不变——mock 不走分档（分档在真实 provider 闭包内），属预期：真实 HTTP 路径本就零外呼不测，参数锁在纯函数层。

### 4. 不做的事（边界）

- 不引入 flash 视觉直读图片（Phase G 已裁定 OCR 两段式；OCR 质量实测差再议）。
- 不动 OCR 提供方开关、上传通道闸门、`config.json`、`assemble` 打包（无新文件/新依赖/新云调用权限）。
- 不做真实外呼测试（红线）；部署前最小实调须用户另行发话。
- 客户端零改动：本切片只动 mc-tools 云函数，无需小程序端发版。

## 测试计划（本地，零外呼）

新增独立套件 `tests/phase-g-flash-migration.regress.cjs`（不动现有绿套件）：

1. `__deepseekRequestBody` 缺省：`model === 'deepseek-flash'`、`thinking` 恰为 `{type:'disabled'}`、`temperature === 0.3`、`max_tokens === 800`、messages 双条（system=safetySystemPrompt 原文、user=prompt 原文）。
2. `opts.maxTokens` 透传：1600 生效；**非正整数**（字符串/小数/0/负数/undefined）回落 800。
3. `MC_DEEPSEEK_MODEL='deepseek-v4-pro'` → model 切换；非法值（`'deepseek-chat'`/任意串）→ 回落 `deepseek-flash`；unset → 缺省。用例后清理 env。
4. 回归：`ai.explainFood` mock 模式响应 `model === 'mock'` 不变（确认 kind 改名无泄漏）。
5. 回归：`ai.analyzeReport` mock 模式 `ai_result.model === 'mock'` 落库不变。

收口：新套件全绿 + phase-g / phase-e3-server / phase-e3-client / phase-e3-page 回归 + 全量 `test:all` EXIT=0。

## 部署清单（并入 Phase G O2，实施后执行）

1. 最小实调一发（已获用户授权）：生产 key 打 `deepseek-flash` + `thinking:disabled`，确认参数协议与可达性——把"文档读对"变"实测过了"。
2. `assemble:cloud` 重打包 + 上传 mc-tools（仅此函数）。
3. 环境变量：`DEEPSEEK_API_KEY` 照旧；`MC_DEEPSEEK_MODEL` 可不设（缺省 flash，安全）。
4. 函数超时 ≥90s 照旧（OCR 3 页最坏 45s + AI 20s + 余量）。
5. 真机验收：真实报告照片走通 上传→OCR→解读；AI 回答正常返回、失败路径如实 `ai-call-failed`。

## 风险与回滚

| 风险 | 评估 |
| --- | --- |
| thinking 参数写法未经实调 | 低：官方指南明示写法，裸 HTTP 顶层字段与 SDK extra_body 同协议；部署清单 1 可消除 |
| flash 非思考延迟/兼容异常 | 低：与旧 chat 行为对齐，20s 超时保留；异常走现有 `ai-call-failed` 如实报错 |
| 不迁移 | 持续暴露：`deepseek-chat` 随时真断，断后饮食问答+报告解读全挂 |
| 回滚 | git revert 单文件重传；成本 flash 非思考单次约 ¥0.02-0.03，可忽略 |

## 验收标准

- 本地：新套件全绿 + 上述回归套件不回归 + 全量 `test:all` EXIT=0。
- 部署后：真机 AI 问答与报告解读正常返回，`ai_result.model` 落库为 `deepseek-flash`。
