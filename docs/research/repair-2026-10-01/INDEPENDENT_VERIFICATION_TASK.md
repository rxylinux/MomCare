# ZCode 独立验证任务（仅完成全部编码审核后启动）

你是全新验证会话，用户要求 ZCode 编码与测试、Codex 审核。不要信任编码会话的通过声明。阅读总设计及最终源码，自行建立反例，验证 A01–A25。可以新增/修改验证测试及记录，禁止修改生产源码；失败写清重现路径后停止，交由编码会话修复。不得修改既有安全测试的预期来掩盖回归。

只用本地依赖和 mock；禁止任何外部业务请求或查询（npm view/install/pack、curl/wget、WebSearch/WebFetch、浏览器、远程 git）、微信 CLI 真实上传/部署、git commit/push、用户数据删除。释放/清理仅限自己生成的临时文件及构建产物。

1. 记录生产与测试实际变更范围，SHA256 清单，当前 HEAD 及 git status；所有证据必须对应同一冻结业务代码。
2. 案例 A01–A25 必须实际经过生产 handler/store/HTTP 解析/页面消费/导出 validator/发布 mock。模型替身只替代外部传输，不替代要验证的业务逻辑。稳定身份、切换中途、冷重启、存储第 N 次写失败、墓碑长前缀、同键时间戳及供应商截断是必测边界。
3. 逐项写原始日志与结果。不能验证的平台 timer 语义记录 blocked/unverified，不将 mock 当真平台证据。包括拒绝分支 DB、上传和消息发送为零的断言。
4. 执行全部 tests/*.regress.cjs（逐脚本退出码与通过/失败/跳过数量，不能只汇总 console 的通过字样）。若其中 fail，不再宣称全套通过。
5. assemble、build:mp-weixin、build:h5；只能本地构建，不运行 release:trial 的真实发布。执行 git diff --check；项目未配置 lint 则注明未配置。
6. 完成后再次记录 SHA256，确认业务源码未被测试意外改写。写 `FINAL_VERIFICATION.md`，含 A01–A25 矩阵、原始日志路径、准确命令/退出码/计数/skip/构建情况、完整快照摘要和剩余限制。交给 Codex 源码审核，不自行宣称最终接受。

## 编码轮已发现边界（仍须独立复核，不能仅引用旧绿日志）

- R1：保存失败后的最新 RAM 草稿不被同 scope onShow 的旧磁盘 active 顶替；quarantine/freeze 真正保留原始字节，备份失败不得覆写；结束线上已确认但最后 active 清除写失败后的冷启动不得复活 ongoing；历史/队列异 scope 或畸形項 fail closed；页面区分已备份/未备份/孤儿 RAM 恢复。
- R2：从真实详情页面调用初次分析/过期重新分析，应到真实网关、正确刷新与失败提示；CAS 冲突与真实 HTTPS 完成字段矩阵；跨模式/附件变化 OCR 残留不得标本次原文；没有摘要的历史提取须标来源未确认；metadata 的 0/x 原因不是页数上限。
- R3：无 Node 全局 Buffer 环境下合法多字节报告导出；未知 AI 嵌套字段金丝雀不入任何目标包字节；合法 vision/OCR/metadata/旧字段从实际包正文逐字段往返；超过扫描预算的连续过滤前缀（空页+可前进游标）；游标跨家庭/域/参数/旧格式受控失败、病态 hasMore/nextCursor 无部分写入；同 ID 云端 ongoing/另一客户端不同 finished 不顶替本地 pending；>100 较新服务端记录不得把更旧 pending 截掉，冷恢复继续显示并保留队列；真实页面有可消费的未同步/冲突说明，不能把 store.queue 存在当“用户可见”。
- R4：dry-run 不能触发 DevTools CLI 即使调用地址为本机；依赖闭包从可追溯基线算，缺基线或 functions:[] 不漏部署；partial receipt 对具体成功函数与小程序上传独立记录，不把未执行/失败/未知项标成功。额外独立反例：当前 dist 缺失、旧 dist 与新 assemble 字节不同、非法确认摘要；有确认基线时 functions=all 仍可选全量；CLI 退出 0 但空输出或业务错误必须保持 unknown/failed，正常成功须有本地 CLI 契约证据；纯前端、上传失败、逐函数部分成功不得清掉以前的确认摘要，换 envId 不得借用旧环境证明；只改 food 生成器语义、正确 source 标记但生成正文被篡改，都不得把旧/伪生成物当新鲜。

所有 release 脚本情景必须复制到独立临时项目夹具，再将外部 CLI、上传、部署、提交行为替换为本地 mock；禁止对真实工作区运行发布流程。开始与结束核对真实 manifest.json 和 .trial-release-state.json 原始字节摘要，任何变化即失败，保留证据，不自行用 git checkout 覆写现场。仅测试作者创建的临时夹具可清理。

R4 三轮及补充细节也须独立复核：完整摘要但无 deployedEnv 绑定、当前目标未知；CLI 目标 success=false 但邻行/其他列 true、同名前缀、非表格日志、信息日志前置后合法表行、非零退出残留 true、stdout 业务错误；assemble 后新增函数及 trigger/env 校验、目录可 hash 但无 index.js/package.json/必需 shared、部署 stage 与计划摘要一致；dry-run 未证明产物新鲜时保守披露；upload mock 进入时本次 pending/partial 计划及当前函数/小程序包摘要已耐久存在，upload 中断不能留下旧次完成收据，待确认摘要不得冒充已确认部署。补生产反例，不复用编码会话通过声明。

旧批量回归曾出现 `phase-b3b-stage1` 退出 139 且日志空（随后单跑 82/0），`phase-i-detail-upload-time` 1ms 时序失败（随后单跑 5/0），R1 `phase-b2b1` 也曾中断。必须在本次冻结业务代码上完整逐脚本验证；如再发生，保留准确退出码和原始日志，不把中断计为完成或静默 SKIP，不自行改生产源码修掉失败。
