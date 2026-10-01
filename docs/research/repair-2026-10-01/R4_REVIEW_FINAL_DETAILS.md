# R4 第三轮候选补充细节（待冻结交接核对）

Codex 只读源码，未运行测试或发布。当前第三轮改动中，原审核两项还需具体落实；如最终交接已修，提交对应反例即可。

1. `cliDeployVerdict` 当前取第一个包含函数词元的行，并把任意管道分隔 `true/✔/yes` 当 success，仍没有按 console.table 的 success 列解析。目标行 success=false、其他列 true，或普通非表格日志“mc-tools | true |”都可能被当确认；目标函数此前的信息日志还可能挡住后面的合法表项。请识别真实表头/字段位置，精确目标索引+success 列，只接受该列布尔 true；其他列真值、无表头、非表格输出保持 unknown。补正反例：实际 `(index)/success/filesCount/packSize` 表头 + 目标 false但其他列真；普通包含目标名的日志；前置信息日志后合法目标表项；正常 true表项；目标邻行/前缀/非零退出反例仍保留。仅用自造简单“fn|true”行不构成真实 CLI 契约证明。

2. 最终产物验证目前仅要求目录摘要是 64hex，空目录或缺 index.js 的目录同样能产生合法摘要，因此仍可上传并在 mock 确认后记录空产物摘要、partial=false。按实际 assemble 输出核对每个最终函数的必须入口文件/清单（至少 index.js、有效 package.json 和实际使用的 shared 模块/伴生物），再允许任何 upload；仅目录存在/可 hash 不算完整。补 mock assemble 保留目录但删除 index.js、空目录、缺必需 shared，以及合法完整包放行，并断言拒绝分支 upload/deploy 调用为零。对 staged cloudfunctions 实际部署目录也应核对同一快照，不将旧目录/不同字节当本轮摘要。

3. 上传前虽已 writeReceipt，但 receipt 仍只有既往确认的 deployedDigests，没有本次 postAssembleDigests/实际上传小程序包摘要。中断留下版本/selected 却缺少“本次拟发什么字节”的证明，尚未满足总设计和第三轮第4项的计划产物摘要要求。请将最终验证后的本轮计划摘要独立于已确认部署摘要耐久记录，实际 stage 与计划绑定，mock upload 进入时核对本次摘要与期望字节相等；中断后保留待确认摘要，不能将其塞进 confirmed deployedDigests 冒充成功。

第三轮 dry-run 已追加“未 assemble、可能补入”的提示，但前面仍无条件打印“本次将部署：（无——部署基线确认全部一致且无源码变更）”。请把整个 dry-run 输出统一为未确认的初步估算，列出可能必需的保守全集或明确拒绝确定计划，不同时打印确定空计划和后面的未知提示。正向本地发布在真实新鲜组装验证后才可确认纯前端零云部署。

这是对 R4_REVIEW_ROUND3 第2/3/4项的细化，保持原范围；所有验证由 ZCode 在独立临时夹具运行，Codex 只审核。禁止真实发布、外部请求、真实 state/manifest 改写及项目 commit/push。
