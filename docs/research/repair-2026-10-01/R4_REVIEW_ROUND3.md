# R4 第三轮静态审核候选（待本轮冻结后核对）

Codex 只读源码，未运行业务/测试探针。当前二轮重写候选还需核对以下生产路径；若最终交接已修则提供反例证据即可。

1. **环境缺少绑定仍被当成可信基线。** closure 的 envMismatch 只在 scopeEnv、stateEnv 两者非空且不同才成立；state 有完整摘要但没有 deployedEnv 时仍使用旧摘要。main 继承却要求 deployedEnv===envId，两处语义不一致。没有可验证部署环境的 legacy/畸形收据必须视为无基线，当前 envId 缺失也不得借用任何确认摘要。补「完整合法摘要但 deployedEnv 缺失/空值」和「当前 envId 无法解析」；真实发布必须在上传前拒绝未知目标，dry-run 明确 fail closed。

2. **CLI 确认能串邻行/同名前缀，且忽略非零退出。** cliDeployConfirmed 把包含 fn 的行及其上下邻行一起匹配 true，会把目标 success:false、旁边其他函数 success:true 误记成功；includes(fn) 也会将 mc-tools-extra 认成 mc-tools。部署 loop 的 verdict=ok 完全不检查 r.status，非零退出但残留 true 表行仍 deployed。需精确指定函数的表项和 success 列确认，其他行不作证据；非零退出/进程错误和业务 error 保持失败或未知。补真实 console.table 形态：目标 false+邻行 true、同名前缀 true、目标 true 但退出3/进程错误、stdout 中业务 error/errCode、目标 true 且退出0 正常确认。上传同时含 upload success 和 stdout 业务错误也不得 uploaded。

3. **新组装摘要缺失和 lateRequired 未完成最终前置验证。** 当前只将 lateRequired 加到 receipt.selected，没有在任何上传前核实所有最终 selected 的新鲜摘要合法且实际目录完整；初始 selected=[] 可跳过 envId 检查，补入后不再检查。triggers 也仍按初始 selected 生成，后补 mc-daily-push 后错误显示 not-applicable。必须对最终集合、新摘要/必要目录、env、trigger 状态统一核对再上传；缺产物不能靠 CLI 事后错误兜底或记 null 摘要后 partial=false。dry-run 仍用旧 dist 宣称无需云部署，但又知道 assemble 会重算；无法证明新鲜时需保守列出全部可能必需/明确阻止，不能给确定的空计划。补初始无源差异/旧dist匹配但新assemble变化、assemble缺目标产物、晚补定时函数、当前env缺失、dry-run未知新鲜度等真实脚本mock。

4. **计划/待确认状态没有在外部上传前落盘。** 新 receipt 只存在内存，首次 writeReceipt 在 upload 返回后；上传期间进程中断时磁盘仍是旧次成功收据，无法反映本次上传可能已发生。总设计明确“发布前记录计划与文件摘要”。最终集合与产物通过校验后、任何 upload 前耐久记录本次版本/目标/selected/当前产物摘要、upload:pending、partial:true；上传返回及每项部署确认再更新。模拟 upload mock 检查进入时 state 已为本次 pending，模拟 upload 阶段中断/超时，保留不确定事实，不将其当旧次完成或 confirmed。

5. **交接文档仍把已弃用/违反边界的旧实现写为当前行为。** R4_HANDOFF 前半部仍推荐 --allow-incomplete，称测试备份恢复真实 state、云部署基线是上传 commit、当前 8 场景；后半部才追加纠正，容易误读。请围绕最终实现完整重写主交接（只保留最终范围/生产证据/当前日志及摘要/平台限制），旧错误日志放清晰标注的历史记录，不把旧不安全行为当用法；发布文档同步最终 env/确认基线、dry-run 保守性、pending/partial 与 trigger 验收门槛。

所有反例保留真实业务判断，只替换外部 CLI、上传、部署、提交及等待时钟，在独立临时项目夹具完成。禁止真实发布、真实 state/manifest 改写、网络查询和项目 commit/push。完成交接后停止等待审核。
