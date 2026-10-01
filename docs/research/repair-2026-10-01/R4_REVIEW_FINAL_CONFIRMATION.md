# R4 进入独立验证前的最后确认

Codex 已核对 R4_HANDOFF 6 个冻结文件摘要与当前文件一致，并读取 r4b-final.log 的 22/0。源包复制清单、环境绑定、计划摘要和真实 console.table 边框路径已读审；未运行任何测试或探针。仅剩下面一处源码确认与遗漏的运行证据，完成后可交接独立验证。

1. **index 单元格仍用词元包含而非精确函数名。** `fnTokenInLine(idxVal, fn)` 会接受真实 Node formatter 的索引键 `not mc-tools` 或 `mc-tools copied`，把其他行记成所请求 mc-tools。标准 formatter 可以生成这类索引，无需伪造表格。请目标索引规范化后完整等于 fn（仅按已证实格式处理引号/空白），成功列仅接受当前 CLI 契约的布尔 `true` 字面值；未知/装饰索引不猜。用真实 formatter 生成非目标索引含目标词元的反例，再保留正常精确目标、合法前缀拒绝、列重排等正反例。必须不将 requested fn 记 deployed。

2. **补齐已修源码的运行证明，不能只用原较弱案例替代。** 当前 22 场景仍只有缺 dailyTipCore，没运行「保留核心却缺 auth.js」及「源 config.json 未入包」；上传包摘要目前无 mock 进入/中断后等于实际 trial-upload 字节的断言（只有函数计划摘要格式/键数）。补这三条真实脚本临时夹具案例：拒绝时 upload/deploy 零调用；合法完整包放行；mock upload 进入时 uploadPackageDigest 独立重算等于实际传入 --project 目录摘要，退出/中断后保留同值，不冒充 confirmed。场景计数和日志按实际记录。

由 ZCode 修这一处源码并补证据，Codex 只审核。使用已有临时夹具与 Node formatter；禁止真实发布/CLI、网络查询请求、真实 state/manifest 改写、项目 commit/push。完成准确最终交接、全部源测试及辅助依赖冻结摘要后停止等待审核。
