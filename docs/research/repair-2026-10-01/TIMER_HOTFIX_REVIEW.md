# 热修审核：入口可用，部署目录必须补齐

Codex 已阅读生产 diff、热修场景断言及四份完整回归日志。入口修复方向认可：SDK SOURCE 精确 wx_trigger、名称选择业务、客户端仍白名单；新增 10/0、既有三套 10/0+31/0+11/0，保留既有断言。

但当前可部署目录有明确错误，尚不能交用户执行部署：

1. `dist/build/mp-weixin/project.config.json` 的 cloudfunctionRoot 是 `cloudfunctions/`。实际开发者工具项目会上传 `dist/build/mp-weixin/cloudfunctions/mc-daily-push/`，不是 assemble 的 `dist/cloud-functions/`。
2. Codex 只读核对：源和 assemble 的 index SHA256 都为 e06116c330c9b5ad73136088811704750c278e9fa83a4a87c3a6cf5af05065fc；实际项目 cloudfunctionRoot 下仍是 c80772b7262e5a4267bbebf74420fca111817a8d357e4dc5770eacb096e1e897，即线上禁用版！直接在当前开发者工具点击部署仍会部署旧代码。

请 ZCode 将完整 mc-daily-push 包安全放入实际已打开开发者工具项目 cloudfunctionRoot 对应目录；冻结并逐文件核对源/assemble/实际上传目录的 index、package、config、所有 shared/伴生字节。不改其他 10 个函数、真实 manifest/state 或用户草稿。留下确切路径和完整包摘要。

更正交接：
- 热修不需要重发小程序、增加版本号或运行完整 release:trial。准备“仅部署 mc-daily-push”具体 DevTools 操作及等价 CLI 命令（路径正确、环境由现有配置核对；不打印密钥），不能把再次上传小程序作为首选修复步骤。
- 单触发器冲突仍需只读核查。删掉方案 C 中仅 9:00 cron 却能运行 21:30 的无效举例。拆双函数只是云端只有一个调度时的备选设计，切换必须避免同一前夜调度同时活跃；不得声称“最多多发一次”，没有此保证。没有执行迁移则清楚标为待实施。
- 既有四份原始日志记录缺少进程退出码：补一个可核对的执行状态清单，包含精确命令、实际运行时、exit/pass/fail、日志与源码摘要；若原执行状态不可恢复，由你重跑所需四套并把退出码写入清单，Codex 不执行测试。

本轮完成只更新组装暂存及文档证据，源 handler 无须为这些部署问题改动。仍不真实部署、commit/push、修改真实 manifest/state 或发送消息。完成写清交接并停止。
