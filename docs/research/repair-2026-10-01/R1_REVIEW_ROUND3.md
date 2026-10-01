# R1 第三轮审核候选项

状态：ZCode 第二轮实现进行中时的静态审阅发现，尚未由测试复现。请交接前核对最终源码；已自行修复的项目提供实际生产入口反例证据即可，不重复改动。Codex 没有运行以下测试，也没有修改业务代码。

1. **同成员返回页面可能覆盖未保存 RAM 输入。** `restoreFromCache()` 直接用盘上 active 替换当前 active，只有身份切换时才把未保存草稿放入 orphan。正常启动已耐久后，新增 click/stop 落盘失败，再次触发真实页面 `onShow`，盘上旧副本会覆盖最新 RAM journal/stopOp。要求 ZCode 从页面入口复现“未切成员、仅离开/返回页面”，确保同 localRef 的最新未保存输入和 operationId 保留；不能只测切 papa 再切回 mama。

2. **历史隔离备份失败不能继续覆写原字节；提示必须真实。** `quarantinePartial` 忽略 `quarantineRaw` 返回值，没有冻结失败键；历史经过过滤后，后续确认/同步持久化可能覆盖尚无耐久备份的原字节。`contra_history` 当前也没有按异 scope 条目过滤。两张页面及 RECOVERY_BLOCKED_MESSAGE 一律宣称“已隔离备份”，但 error/corrupt-frozen 情况并没有成功备份。要求本地注入隔离副本写失败、包含本成员/异成员的混合 history，执行 restore→确认→真实重试/拉取/新操作；备份失败期间原字节保留、异成员内容不显示、页面准确表达未备份/已备份/同步暂停或恢复。明确确认的含义，不能用泛泛“知道了”隐藏失败。

3. **云端终态成功、active 清空落盘失败时的冷恢复。** flush 成功会清 journal 终态项/stopOp，并持久化仍为 running/ongoing 的 active，然后 finalize 清 active。若仅最后 active=null 写失败，磁盘可能留下“云端已完成，但本地无终态凭据”的活跃记录。重启 retry 没有 finish/stop 凭据，可能把已完成记录重新显示成进行中。要求 ZCode 分别对胎动 finish/discard、宫缩 stop 注入“仅清空 active 时失败”，冷重启联网恢复，最终无虚假活跃记录、终态不双写、operationId 不重造。持久化清理须有可恢复的终态凭据或明确对账路径。

4. **恢复校验要覆盖实际随后访问的字段。** 当前胎动仅检查 clicks 是数组，`[null]` 会通过；journal finish/discard 的 payload 也未验证，serverRevision/sessionId 等随后参与外呼。要求按真实本地格式检查后续会用到的必要字段，畸形内容保留 raw、受控冻结、不进入自动重试，不能在页面或 recompute 中抛未捕获异常。构造 null click、畸形终态 journal，以及异 scope 宫缩 history 的恢复反例；不要为满足校验改变正常格式或删弱旧断言。

这些属于原有 A04–A08 的保存真实性、恢复耐久和隔离要求。原 A01–A10、前两轮意见仍然有效；定时器平台身份仍未验收。最终交接请逐项给出修复、反例命令/退出码/日志和未解决限制，不称 Codex 已通过。
