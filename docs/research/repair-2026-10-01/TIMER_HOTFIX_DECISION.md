# 定时热修审核结论与线上操作范围

2026-10-01，Codex。基线 HEAD c3ca436 / 已上线体验版 1.1.25。

**结论：单云函数热修复候选通过源码、回归日志和实际上传包审核；尚未部署，线上恢复尚未确认。**

微信官方文档明确以 handler 内每次读取的 getWXContext().SOURCE === 'wx_trigger' 识别定时调用。本次恢复这一入口；daily-reminder 与 checkup-eve-reminder 分别选择日常与前夜，非定时调用仍执行家庭成员白名单 sendNow。伪造 event 不获得授权。之前把 SDK 环境变量实现当作否定官方平台来源接口的理由，导致全部定时禁用，是审核判断错误，已纠正。

## 验证证据

ZCode 在可见客户端执行，Codex 读取源码/原始日志并独立重算计数和摘要，未执行测试或编写业务代码。

- 实际 handler 修复前两类 SDK timer 都为 unauthenticated，零读库/发送；修复后真实 timer 日常/前夜进入业务发送，无明日产检跳过，伪造与连续调用边界通过。
- 四套冻结回归：phase-timer-hotfix 10/0、phase-r1-push 10/0、phase-n-daily-push 31/0、phase-iv-r1 11/0；合计 62 通过、0 失败，各退出 0。逐条 ok 数与最终计数吻合，旧断言保留。运行时 /usr/local/bin/node v24.12.0 arm64。
- assemble 与 git diff --check 记录退出 0。实际 DevTools cloudfunctionRoot 下曾残留禁用版，现已补齐完整 8 文件热修包。
- 源/assemble/实际上传目录 index SHA256 一致：e06116c330c9b5ad73136088811704750c278e9fa83a4a87c3a6cf5af05065fc。
- assemble 与实际上传包摘要一致：5b6861ebf11c8db67d57fde316d1f966cf0dad8fc1cad47c05a5348f1091f28f。其余 10 个函数逐文件相同，摘要与 1.1.25 已部署收据相同。真实 manifest/state 未变。
- Codex 只读云函数元数据查询 exit=0、无业务错误，返回 Active / timeout 20 / Nodejs16.13。此接口仅返回上述字段，没有触发器/代码版本信息，不能证明热修已部署或两条调度已生效。

原始日志与审核证据：/tmp/momcare-timer-hotfix-20261001/zcode-logs/rerun-*.log、CODEX_AUDIT_EVIDENCE.json、cloud-info-redacted.json。逐文件完整摘要与具体操作见 TIMER_HOTFIX_HANDOFF.md。Codex 对交接仅清理了重复旧迁移段落并补齐实际项目绝对路径，未改代码或测试。

## 待确认的线上执行范围

只重新部署 mc-daily-push，使用已审核实际上传包；保留现有环境变量、运行时、20 秒超时和触发器；不重新上传小程序、不增加版本号、不运行整套 release:trial、不 commit/push、不补发消息、不主动调用发送接口、不擅自改用户数据。

部署须满足真实 CLI exit=0 + 精确函数表行 success=true，并只读核对云端状态/源码或版本证据；单独保存热修部署记录与摘要，不把旧 1.1.25 发布收据当本次部署证据。保持真实 manifest 和发布 state 原状，避免制造未发生的小程序发布记录。

随后核对现有两类触发器和对应调用日志。官方文档列单函数一个触发器，而本地配置两条，真实云端仍未核实；若缺失一类，报告事实并落实受支持的调度方案，不能宣称两类已恢复。拆双函数属于备选，尚未实施，不与本次单函数部署混为一谈。

线上操作范围确认前不执行部署；自然触发日志及实际结果确认前，不宣称线上功能完成恢复。
