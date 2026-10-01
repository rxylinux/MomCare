# ZCode 客户端：R1 续修及测试退出审核

继续当前 MomCare 工作，Codex 仅设计/审核，没有运行测试或改业务代码。工作目录仍是 `/Volumes/solid hard disk/github/rxylinux/MomCare`，保留全部当前改动。

你的 `node tests/phase-r1-tools.regress.cjs | grep ... | tail ...` 后台测试已等待数分钟未退出。请你负责读取完整输出、检查并结束本会话遗留测试进程。静态线索：新增真实页面 onShow 用例会执行 ensureTicker/setInterval，测试未见 cleanup；即便 main 完成，Node 也可能不退出。修正确的页面生命周期/测试清理，不用强制退出掩盖未完成断言；只处理你启动的测试任务。以后完整输出写日志，并单独记录 node 退出码，管道 grep/tail 的 0 不能替代 node 的退出码。

随后必读 `docs/research/repair-2026-10-01/R1_REVIEW_ROUND3.md`，逐项用真实页面/存储/handler 本地 mock 复现并修复。重点：同成员再次 onShow 不丢未保存 RAM 更新；隔离失败不覆写 raw、宫缩异 scope history 不显示、备份与同步提示真实；云终态成功但最后 active=null 写失败的冷恢复不复活进行中记录；恢复 shape 校验不得接纳会崩溃/非法外呼的必要字段。

第三轮是源码审阅候选项，若你已修复，给对应反例证据即可；不能只回复计划或自行称验收通过。原计划/设计 A01–A10 与前两轮意见仍有效。定时器平台身份不可证明时保持拒绝并披露功能限制。

继续限制：既有本地依赖、mock 测试；禁止 npm view/install/pack、curl/wget、WebSearch/WebFetch、浏览器网络查询、远程 git、真实云/微信/AI 请求、部署、commit/push、用户数据删除。由你编码并运行全部针对性及相关旧回归，Codex 只审核。

最后写 R1_HANDOFF.md，逐项记录两/三轮意见、A01–A10、完整命令/测试进程退出码/准确计数/原始日志/源测试 SHA256/平台限制；停止等审核，暂不进入 R2–R4。
