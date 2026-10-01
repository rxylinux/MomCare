# R1 第二轮源码审核（待 ZCode 回归验证）

第一轮列出的推送日期快照、eve 精确日期过滤、首次 watch 基线及终态 queue 先写方向已落入源码；尚未接受整阶段。以下仍是静态源码发现，要求 ZCode 自行复现修复。

1. `retryPending` 虽捕获 sameIdentity，但活跃胎动 await 之后不检查，立即重新读取当前 activeContraction 再执行。换成员后会在旧重试流程中调用新成员宫缩；两个活跃 await 之后的 `persistFetal()/persistContra()` 也没有捕获 scope。需要每段入口/每个 await 后检查，同一旧调用立即结束，不处理新身份数据。测试：mama fetal.start 在途，切 papa 并创建其 contraction，完成旧请求，旧 retry 不得继续调用 papa contraction 或写新 scope。
2. orphan 草稿恢复只在 `!currentFetalSession/!activeContraction` 时回接。既有 active 盘上是旧版本，离线 click/stop 写失败后切走再回来时，先恢复盘上旧 active，RAM 更新便永远不回接。需要同 localRef 的原 scope RAM pending 与旧磁盘态的恢复策略，原未保存输入可见、可重试；不是只保留不可访问的数组。测试已有耐久 start→新增 click/stop 落盘失败→切成员→回原成员，最新输入/同一 operationId 恢复。
3. SCOPE_PART_RE 禁止 underscore/非 ASCII，但服务器身份契约只要求非空 ID，没有该字符限制。不能为缓存键防碰撞拒绝原本合法的 confirmed 家庭；改用无歧义编码/长度界定，与实际身份字符规则一致。验证 `family_a` 等有效身份仍能用工具，不完整 scope 才拒绝。
4. finalizeLocal* 现在返回 keys 但未调用 note*Persist，某次 final queue/history/active 失败可能不给未保存横幅，也影响 clearToolsMemory 的 orphan 判断。最终真实结果必须推进持久化状态；retry 中 finalize 失败不得被后续某个无关写成功遮蔽成全成功。
5. 恢复 history 只检查 Array，queue 只检查 scope，对 active 仅 status/scope，未验证必要字段。`journal` 不是数组、startTime/operationId 缺失的可解析缓存不得进入重试、不得外呼；异 scope history 不显示。应按真实本地/服务器来源格式做明确结构校验并保留 raw，不能为验证新增冗余不兼容字段。
6. 存储读取恢复后 cacheWritable 会隔离旧数据然后允许空 RAM 覆写、开始新记录。虽原字节有副本，但 pending 完整性仍未知；至少必须使恢复 warning 可见并冻结自动同步依赖的域，直到该键重新成功读取并完整恢复或显式隔离流程确认。不允许仅由自动 retry 把恢复警告消掉且报成功。真实页面 onShow 目前完全忽略 restore 的返回/restoreWarnings；需显示持久恢复异常，不能只 console.warn。
7. `phase-r1-push` 的 daily 150 旧记录用例会在第一条有效记录立即返回，并没有“分页越过 150 条”，其断言也无法分辨 -150 天与 -20 天的错误选取（两者均不显示产检文案）。改为能区分结果的真实乱序 future pending 案例及墓碑长前缀，并准确记录 query 次数；已有 legacy 混合正常记录失败不能只删掉正常项缩成单行获取通过。mock 对 missing sortKey 的排序应体现平台实际缺失字段语义，记录依据/不确定性。跨午夜用例让时钟在数据库 await 期间推进过午夜，验证单次调用的整条日期一致，不能只冻结为不变时刻。

请先完成当前回归证据，不用在写测试中改变上述契约。所有新增边界由 ZCode 执行，Codex 保持只写文档与源码审核。
