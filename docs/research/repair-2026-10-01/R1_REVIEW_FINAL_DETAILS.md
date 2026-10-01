# R1 第三轮后剩余两项静态核对

第三轮工具 25/0、推送 10/0 原始日志已读取。以下是源码审阅发现，Codex 未运行反例。仍在原有恢复保全与提示真实性范围内，请 ZCode 复现、修正并更新交接，勿扩展业务范围。

1. `readOrFreeze` 的成功分支未携带 `st.raw`，`freezeShape` 与 `quarantinePartial` 用 `JSON.stringify(r.value)` 备份。这不等同原始存储字节，解析可能改变超出安全整数的未知内容，格式也会改变。应直接保留原始 raw 到隔离副本。分别用带空白的结构异常 JSON、混合 scope history 检查实际备份值与原值严格相等，不能仅断言备份键存在。备份失败后的禁覆写要求不变。
2. `freezeShape` 忽略 `freezeKey` 的备份结果，始终产生 `invalid-shape` 或 `scope-foreign`；两张页面把这些状态认定为“已隔离备份”。因此有效 JSON 的结构异常/异 scope active 加隔离写失败仍会宣称已备份。需要把实际结果传到 warning 和两张页面，包括该分支的原字节保留、确认后受控写入与真实页面提示反例。`orphan-draft-restored` 是 RAM 恢复，也不能归类成已做耐久隔离备份。

完成后执行本次针对性回归及受影响旧回归，记录退出码、日志和准确计数。交接后等待 Codex 审阅；timer 真实平台仍为未验证。
