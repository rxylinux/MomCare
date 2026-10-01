# R4 第二轮静态审核候选（待当前交接后核对）

Codex 只读源码，未运行测试或 release。当前重写版仍需核对：

1. **旧 dist/缺 dist 不能证明当前部署计划完整。** computeChangedFunctions 用工作区现有 dist 的摘要，cur 缺失但 done 存在时不加入 required，done 也只要求任意非空字符串；main 在新 assemble 之后只记录 postAssembleDigests，未重新核对 required/selected。无 git 源差异但 dist 缺失/陈旧，或本轮组装/依赖运行时造成新字节与确认摘要不同，均可能 selected=[] 后上传成功并 partial=false。现有可构建文件不等于当前源对应的新鲜产物。明确未知当前侧摘要 fail closed；用当前源快照或新组装摘要决定最终集合并在任何上传/部署前重新核对，dry-run 如不能证明新鲜就保守完整/明确拒绝。确认摘要需合法 64hex。补 dist 缺失/旧 dist→新 assemble 字节变化、invalid done 摘要的真实脚本 mock。

2. **退出 0+空输出仍被标成功；其他业务错误输出也可能漏判。** 当前 `if(r.status===0&&!hasErr) confirmedDep=true` 没要求任何成功确认，所以 empty stdout/stderr 仍 deployed；unknown 分支只在非0又无error发生，与注释“无可识别输出 unknown”不符。stdout 的 `error/errCode`（无 [error]）也未被检测。核对本机 CLI 源码的可识别成功/失败契约（禁止实际调用），明确正常成功确认才能记 deployed，未确认输出 unknown。补空输出0、业务错误0、正常确认三路实际脚本 mock。小程序 upload 的正常确认也应按已有契约如实判定，勿把未知输出改写成 uploaded。

3. **既有逐函数确认摘要被覆盖丢失且未绑定环境。** 新 receipt.deployedDigests={}，writeReceipt 整体覆盖 state.deployedDigests；纯前端 selected=[] 或上传失败都清掉旧基线，增量部署只保留本次成功项，无法维持“每个函数已确认”的耐久基线。保留过去已确认项，仅对应函数的新成功更新；partial 未执行/失败项维持其旧摘要并继续判需要部署。收据/确认摘要还必须绑定实际部署 envId（必要的 app/项目目标也明确）：换 utils/cloudConfig.js 的 envId 后旧目标的摘要不能证明新目标已部署，需新作用域完整集合/阻止。补纯前端保留、部分成功合并、上传失败不破坏旧基线、换目标环境拒绝旧基线。

4. **all 分支被第二次重写重新破坏。** 当前 confirmedDigests 存在时仍 missing=required.filter(!FUNCTIONS.includes)，FUNCTIONS_ALL 后 FUNCTIONS=[]，die 在 selected=allFns 之前。首轮修复必须保留。最终若已自行修好交接反例即可。

5. **food 标记只证明作者源 digest，不证明生成器/内容匹配。** 改 gen-food-safety.mjs 语义而 JSON 源不动、未重新生成时，旧生成物 source-sha256 仍匹配，gate 放行并部署旧语义。生成器版本/实际预期生成内容也需核对（不能只信自报源摘要）；补仅生成器语义变化未更新生成物，以及当前marker但实际数据不一致的本地夹具。可如实拒绝陈旧生成物，合法完整生成物须通过，不改真实发布状态。

当前仍在开发，以上以最后冻结交接核对为准；第8真实状态测试隔离要求仍必须落实。完成后更新 R4_HANDOFF 并停止等待审核，不执行真实 CLI/发布/网络请求或项目 commit/push。

## 本机 CLI 源码只读证据（未运行 CLI）

Codex 读取 `/Applications/wechatwebdevtools.app/Contents/Resources/app.asar.unpacked/js/common/cli/index.js`：上传分支在 `await p.upload(r)` 返回后调用 `t.succeed("upload success")`；`t.functionsDeploy` 遍历返回的各函数结果，`error` 存在时该函数表项 `success:false` 并输出错误，否则表项 `success:true`、`filesCount`、`packSize`，最后 `console.table(p)`。spinner 的部署标题本身不证明指定函数成功。请基于该真实输出契约建立成功/失败/未知识别及 mock 原始输出，核对指定函数那一行，不能只匹配自造的 `deploy ok` 字符串。不能证明的 CLI 格式保持 unknown，不猜成功。

测试夹具可以替换重试等待时钟，避免每个 mock 失败重复真实等待 45 秒；保留真实重试次数、判定、状态写入与上传部署调用断言，不替代业务决策。测试源码搜索必须针对实际参数/分支，而非误把说明注释中的旧开关名称当作开关仍存在。
