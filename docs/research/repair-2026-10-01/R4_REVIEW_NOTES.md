# R4 首轮静态审核候选（完成交接后核对）

Codex 只读源码，未执行 release 或 mock 测试。以下当前源码问题需 ZCode 通过真实脚本入口的本地 mock 复现；若本轮已自行改掉，以最终交接为准。

1. **上次小程序上传 commit 不能当云函数已部署基线。** helper 仅要求 state.commit 存在，不检查历史 functions/deployed/partial 或部署源码摘要。旧 `functions:[]` 的上传收据、旧窄名单或 partial 都会被认成全部云函数基线。新脚本又在部署前把 receipt.commit 改成当前 HEAD；后续函数部署部分失败时，下次 helper 从这个已推进 HEAD 比 diff，没变源码就返回 required=[]，遗漏上次未部署项。按每个函数已确认的可追溯源码/组装摘要维护基线（未确认函数继续必需部署），或缺/旧/不完整基线强制完整集合/明确阻止。不能仅凭合法 SHA 当部署证据。补历史 commit+functions:[]/窄名单、当前 partial 后不改源码再次计划的真实入口反例。

2. **未授权的 `--allow-incomplete` 绕过 A24。** 设计明文要求无可信基线时完整集合或阻止不完整发布；新开关允许无基线空函数名单继续真实上传并最终 partial=false，破坏该硬门槛。去掉这条绕过路径，不把“用户承认风险”当本次授权或安全依据；此任务没有要求增加例外开关。

3. **闭包仍有遗漏与失败吞没。** helper 未把 `cloud/assemble.mjs` 变化映射到全部实际组装函数（例如 wx-server-sdk 版本/共享转译/打包方法变更）；开发过程中未跟踪目录折叠问题已通过 -uall 自行修正，保留该反例；非 ASCII/空格路径带 git 引号也不会匹配；`git diff` 失败被当空字符串而 baselineMissing=false 返回无变更。使用可靠文件/快照闭包或安全参数数组的机器可解析 git 输出（NUL、完整 untracked 等），查询失败 fail closed。补仅 assemble、全新未跟踪函数、带引号/中文伴生路径、git diff/status 查询异常的入口反例，保证必需集合不静默缩空。

4. **已自行修复的 --functions all 分支须保留回归。** 当前可信基线分支已改 allFns（不再要求修复此历史缺陷），核对并保留可信基线+必需函数+all 的真实 dry-run 反例与窄名单不缩减。无手工名单时可自动选闭包；明确窄名单可补全或受控拒绝。

5. **收据先记不 partial，且成功后留下脏 state。** upload 成功/部署未开始时 receipt.partial=false、deployed=[] 已落盘并 git commit；函数部署完成后 writeReceipt 又改已提交 STATE_FILE，脚本返回完成但工作区有未提交 state，下一次发布的 clean gate 直接阻止。中断窗口与未执行项应保持 pending/partial，不能先称完整；提交时序应覆盖最终准确收据（部分失败也留可恢复事实，不把云端未确认项标成功）。补 upload 后/首个部署后中断、全部成功后 git status、部分失败后的下一次计划；确认收据与提交记录一致，小程序 upload 与函数 deployed 分开。

6. **函数部署只看退出码 0，不是确认成功。** `spawnSync(...,{stdio:'inherit'})` 后 done=r.status===0；DevTools CLI 已知存在业务错误却退出 0 的行为（原 upload 分支专门检查 [error]）。部署若出现错误输出/未确认输出同样不应标 deployed。捕获并转发输出，明确成功/失败/未知语义；可从本机 CLI 源码核对其确认契约，禁止真实调用。补 status=0 + 明确 [error]/业务错误，以及可识别正常成功的 mock；受控失败/unknown 不更新 deployed。

7. **food 作者源选择部署不等于产物已更新。** helper 注释说不依赖人跑生成器，但 release 只 assemble，不执行/核对 gen-food-safety；只改 static/data/food-safety.json 而伴生 food-safety-data.js 未更新时，即使选择 mc-tools，部署仍打包旧词典。确保真实组装输入匹配作者源/生成器契约（可以如实拒绝陈旧生成物，或在受控构建产物内生成，不能悄悄改 tracked 输入后沿用旧测试/基线）；补该源变更而生成物仍旧的 mock，不能只断言 required 包含 mc-tools。

完成当前首轮后由 Codex核对并交回续修；不要执行真实 CLI/发布/网络请求、commit/push、改真实 manifest/state。所有测试只能 mock 外部过程并在自建临时夹具里写产物。

8. **测试直接移走真实 .trial-release-state.json，违反本轮不修改真实状态边界。** 当前 phase-r4 的无基线场景对 root 真项目 `fs.rmSync(statePath)`，随后 finally writeFile 恢复。即使最终字节恢复也不是“未修改”，中断会遗留缺状态。该场景必须移到自己的临时项目副本，真实脚本路径/根目录只指向夹具；真实 manifest/state 不得被写/移走。干净/缺基线/旧基线案例均可以在最小副本运行。独立全套回归不能重复触碰真状态；补前后真实文件摘要与真实路径写入/删除零调用证明。
