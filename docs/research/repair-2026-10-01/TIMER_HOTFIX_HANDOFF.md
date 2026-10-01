# 定时推送热修交接（ZCode 编码与本地回归执行）

状态：**热修已完成本地编码、mock 回归与组装；并按 TIMER_HOTFIX_REVIEW 补齐实际上传目录（cloudfunctionRoot）的热修包（§4.1，整包摘要 5b6861eb…）；未部署、未 commit/push、未改真实 manifest/.trial-release-state、未动用户草稿。线上 1.1.25 仍为禁用版——在仅部署 mc-daily-push（§4.2）并完成触发器核查前，不得宣称线上已恢复。** 基线 HEAD `c3ca436`（体验版 1.1.25 发布提交），本热修全部改动未提交。

依据：`TIMER_HOTFIX_TASK.md`、`TIMER_INCIDENT_REVIEW.md`、`TIMER_HOTFIX_REVIEW.md`（Codex）、官方证据 `/tmp/momcare-timer-hotfix-20261001/wx-{context,triggers}.{html,txt}`（官方 getWXContext/triggers 文档，Codex 实读存档）。

## 一、修复前后

**修复前症状（冻结 handler 上复现，日志 `zcode-logs/repro-prefix-symptom.log`）**：
官方定时上下文（`getWXContext().SOURCE==='wx_trigger'`，无 OpenID）携带官方 payload（`Type:'Timer'`/`TriggerName`/`Time`，腾讯云 583/9708 契约）调用 daily-reminder 与 checkup-eve-reminder——均被拒 `unauthenticated`，零读库零发送。即 1.1.25 线上自动定时推送退化。

**修复后契约（`cloud/functions/mc-daily-push/index.js`）**：
- 入口每次调用同步读 SDK `getWXContext()`（官方注意事项：main 内读取；不缓存、不从 event/process.env 拼造；读取失败=无定时权）。
- `SOURCE` **精确等于 `'wx_trigger'`** → 定时分支（官方 triggers 文档判定原文）。不做 includes/前缀/逗号链匹配——`'wx_client,scf'`、`'wx_trigger,scf'`、`' wx_trigger'`、大小写变体等全部不算。
- 定时分支内 `TriggerName` 只选语义：`daily-reminder`=日常、`checkup-eve-reminder`=前夜；`event.kind`/`event.action` 不改变定时语义；payload 除 TriggerName 外不要求任何其他字段（勿臆造必需字段拒真定时）。非对象/缺 TriggerName/TriggerName 非串/携带 `action:'sendNow'`（矛盾输入）→ `timer-malformed-event`；未知名称（含 `daily-reminder-2` 近似前缀）→ `timer-unknown-trigger`——全部在读库与发送前拒绝。
- 非定时来源（一切其他 SOURCE/缺失/读取失败）：原 R1 契约不变——`resolveCaller` 白名单 + `{action:'sendNow'}`（可带 `kind:'eve'`）；event 的 Type/TriggerName/SOURCE/嵌 getWXContext 对象/自报身份一律零授权。
- 其余 R1 修复（单一时钟快照、明日下推查询、sortKey 完整性、配额/DB 错误语义、两人独立发送、分页修复）零回滚——定时路径与手动路径共用同一管线。

## 二、本地回归（原始日志 /tmp/momcare-timer-hotfix-20261001/zcode-logs/）

| 套件 | 退出码 | 结果 | 日志 |
|---|---|---|---|
| phase-timer-hotfix（新增，10 场景） | 0 | 10/0 | timer-hotfix-run1.log（首跑即过）+ rel-phase-timer-hotfix.log |
| phase-r1-push（措辞更正后重跑） | 0 | 10/0 | rel-phase-r1-push.log |
| phase-n-daily-push（同） | 0 | 31/0 | rel-phase-n-daily-push.log |
| phase-iv-r1（独立验证套件，同） | 0 | 11/0 | rel-phase-iv-r1.log |
| `npm run assemble:cloud` | 0 | 11 函数重组装；dist/cloud-functions/mc-daily-push 与源逐字节相同（cmp） | assemble.log |
| `git diff --check` | 0 | 干净 | git-diff-check.log |

phase-timer-hotfix 覆盖（H1–H10）：①官方定时日常真实发送 2 条（日常文案/dateKey=今天/读库计数）；②定时的前夜发送 2 条"明天产检"+date4=明日；③前夜无明日记录安静跳过；④定时语义锁定（event.kind 双向无效，两名称各归其义）；⑤8 类畸形/未知触发器在读库/发送前拒绝（含矛盾 action、近似前缀名）；⑥14 种非 wx_trigger 来源（wx_client、wx_client,scf、wx_devtools、wx_http、wx_unknown、scf、wx_localdebug、wx_trigger2、首尾空格、大小写、wxtrigger、wx_trigger,scf、空、getWXContext 抛异常）携带完整伪造事件（event.SOURCE、event 嵌 getWXContext、自报 OPENID、action:sendNow）全部零授权零读库零发送；⑦白名单手动日常/前夜/伪造 TriggerName 不改语义/外人拒绝保持；⑧同一 handler 连续 timer→client→timer→伪造→无 SOURCE，每次即时判定不借上次快照（恰 6 条发送）；⑨定时路径 252 条历史墓碑长前缀+昨日 overdue 仍选最早有效（≥3 次翻页）；⑩定时路径 DB 异常 `checkup-query-failed`、未配置 `not-configured` 可区分。

旧测试更正（断言全部保留，只改误导性标题/注释——它们测的"非 wx_trigger 来源拒绝"在热修后仍成立）：phase-r1-push A03、phase-n 头注与 N10 注、phase-iv-r1 A03。

### 执行状态清单（TIMER_HOTFIX_REVIEW 要求；原始运行日志未内嵌退出码——原状态不可直接核对，故以同运行时权威重跑一遍，两代日志均保留）

权威重跑（运行时/退出码已写入日志首尾，可直接核对；源码与首次运行之间零改动）：

| 套件 | 精确命令 | 实际运行时 | exit | pass/fail | 重跑日志（SHA256 前 16） |
|---|---|---|---|---|---|
| phase-timer-hotfix | `node tests/phase-timer-hotfix.regress.cjs` | `/usr/local/bin/node` v24.12.0 arm64 | 0 | 10/0 | rerun-phase-timer-hotfix.log（5ac9bf120e0d…） |
| phase-r1-push | `node tests/phase-r1-push.regress.cjs` | 同上 | 0 | 10/0 | rerun-phase-r1-push.log（7a2138ba4f3d…） |
| phase-n-daily-push | `node tests/phase-n-daily-push.regress.cjs` | 同上 | 0 | 31/0 | rerun-phase-n-daily-push.log（6147fd941e56…） |
| phase-iv-r1 | `node tests/phase-iv-r1.regress.cjs` | 同上 | 0 | 11/0 | rerun-phase-iv-r1.log（84891261b43e…） |

原始运行（首次执行；日志保留，退出码当时打印在日志外未内嵌）：timer-hotfix-run1.log（1e2315279023…）、rel-phase-timer-hotfix.log（1e2315279023…，与首跑同内容）、rel-phase-r1-push.log（78a6f7627147…）、rel-phase-n-daily-push.log（da054a83b4a2…）、rel-phase-iv-r1.log（5ddf11e39997…）。全部位于 `/tmp/momcare-timer-hotfix-20261001/zcode-logs/`。

## 三、文件摘要（SHA256 前缀，HEAD c3ca436 → 热修后；完整值见 zcode-logs/{before,after}-digests.txt）

| 文件 | 前 | 后 | 性质 |
|---|---|---|---|
| cloud/functions/mc-daily-push/index.js | c80772b7262e… | e06116c330c9… | 生产修复 |
| cloud/DEPLOY.md | fd1aeb37b5e6… | dc16929d6dc0… | 门槛更正（R1 结论标注为历史+热修契约+触发器冲突警示） |
| docs/REPAIR_DESIGN_2026-10-01.md | 7138bef8876b… | b3ef21034aba… | A03 行加纠正标注（原文保留） |
| tests/phase-timer-hotfix.regress.cjs | （新增） | a00212a9f786… | 新回归 |
| tests/phase-r1-push.regress.cjs | d92a2d227e1f… | e037c126e10c… | 措辞更正 |
| tests/phase-n-daily-push.regress.cjs | ad6b129f71f0… | 726fb634e3a5… | 措辞更正 |
| tests/phase-iv-r1.regress.cjs | b4dacd1f9f89… | affbd5978846… | 措辞更正 |

**未动**：`manifest.json`（3ac5246132f3…）、`.trial-release-state.json`（ba6b45f9b5ff…，1.1.25 发布后基线）、`docs/recipe-draft.md`（用户草稿 7a7fb43b96fd…）、其余全部源码与测试。

## 四、部署准备与"仅部署 mc-daily-push"操作

### 4.1 上传目录补齐（TIMER_HOTFIX_REVIEW 指出的关键缺口，已完成）

DevTools 项目的 `cloudfunctionRoot` 是 `dist/build/mp-weixin/cloudfunctions/`（project.config.json 实测值）——**函数部署读的是这里，不是 assemble 的 `dist/cloud-functions/`**。首次交接时该目录仍是禁用版（index `c80772b7…`），直接点部署会发旧代码。现已补齐：

- 旧禁用版整包备份：`/tmp/momcare-timer-hotfix-20261001/staged-backup-mc-daily-push-prehotfix/`（逐文件摘要 `staged-old-backup-files.sha256`；其中仅 index.js 与热修版不同，config/package/shared 七件字节相同）。
- 以 assemble 热修包整体替换 `dist/build/mp-weixin/cloudfunctions/mc-daily-push/`，并逐文件字节核对（`staging-verification.txt`）：
  - `diff -r` 暂存目录 vs `dist/cloud-functions/mc-daily-push`：**逐字节一致（零输出）**；
  - 三处 index.js 同为 `e06116c330c9b5ad73136088811704750c278e9fa83a4a87c3a6cf5af05065fc`（源 / assemble / 实际上传目录）；
  - 完整单函数包稳定摘要（release 同式算法）：assemble 与实际上传目录同为 **`5b6861ebf11c8db67d57fde316d1f966cf0dad8fc1cad47c05a5348f1091f28f`**；
  - 暂存包 8 文件清单：index.js `e06116c3…`、config.json `5827cfb6…`、package.json `044969cb…`、shared/{auth `39f9c4bd…`, config `d3fd3a95…`, constants `73c662f1…`, dailyTipCore `bdadb3ef…`, respond `ff871f55…`}；
  - **其余 10 个函数**：实际上传目录 vs assemble 逐字节核对全部一致（未动）。

### 4.2 仅部署 mc-daily-push（不重发小程序、不增版本号、不跑 release:trial）

修复只涉及一个云函数——**不需要**再次上传小程序包、不需要 bump manifest 版本、不需要完整 release 流程；把重传小程序当修复步骤是错误的。

- **DevTools 操作**：打开项目 `dist/build/mp-weixin`（即当前已打开的体验版项目）→ 资源管理器 → cloudfunctions → 右键 `mc-daily-push` → **上传并部署：云端安装依赖**（`-r` 语义）。
- **等价 CLI 命令**（与 release:trial 内部同款；`--env` 为 `utils/cloudConfig.js` 的 envId，非密钥）：

      /Applications/wechatwebdevtools.app/Contents/MacOS/cli cloud functions deploy \
        --env rxylinux-momcare-d2eoh6t493c2168 \
        --names mc-daily-push \
        --project "/Volumes/solid hard disk/github/rxylinux/MomCare/dist/build/mp-weixin" -r

- 成功判据（R4 契约）：退出码 0 + console.table 中 `mc-daily-push` 行 success=true；unknown 不算成功，控制台函数状态复核为准。
- **函数部署不会自动上传/变更触发器**——触发器须按 §五 只读核查（是否/如何"上传触发器"待核查结论与用户确认）。
- 注意官方文档提示：定时触发器可能因网络重试**重复推送**（官方建议以消息 ID 去重）。当前实现无幂等去重（与 1.1.24 之前行为一致）；重试会导致同一提醒重复发送并重复消耗订阅配额。本轮按最小修复范围未实现去重，列为后续可选增强。

## 五、触发器配置冲突：线上核查与迁移方案（不擅改云端——本轮零云端操作）

**冲突**：官方 triggers 文档写明 config.json 的 `triggers` 数组"目前仅支持一个触发器"；本地 config.json 有两条（`daily-reminder` `0 0 9 * * * *`、`checkup-eve-reminder` `0 30 21 * * * *`）。1.1.25 发布收据 `triggers.status='unverified'`——云端实际存在哪条/几条**未知**，不以本地两条记录宣称云端两条有效。

**核查步骤（只读，不消耗配额不发送）**：
1. 微信开发者工具 → 云开发 → 云函数 → `mc-daily-push` → 触发器 Tab：记录实际存在的名称与 cron（截图/抄录入档）。
2. 对照三种可能：仅 daily-reminder（9:00）/ 仅 checkup-eve-reminder（21:30）/ 两条都在（若平台接受了历史"上传触发器"操作）。
3. 函数日志（云开发 → 日志，按函数过滤）看近期 9:00/21:30 是否有调用记录——冷数据可判实际生效情况。

**迁移方案（按核查结果选一，均需用户确认后执行）**：
- **A. 云端已有两条**：无需迁移——热修版两名称都支持；核查后按 §六 验收即可。
- **B. 仅一条（官方单触发器限制生效）——备选设计：拆分双函数（官方支持形状；未实施，待核查结论与用户确认）**：
  新增 `cloud/functions/mc-daily-push-eve/`（同一入口逻辑，触发器名固定 `checkup-eve-reminder`，cron `0 30 21 * * * *`），`mc-daily-push` 仅保留 `daily-reminder` 9:00。切换顺序须**避免同一前夜调度在旧/新两处同时活跃**：①先部署新 eve 函数（尚无触发器，不产生调度）→ ②核查并移除/停用旧函数上的前夜触发器 → ③为新函数上传触发器并核对唯一 → ④观察 2 个完整触发周期。对切换期间提醒的多发/漏发**不做任何"最多一次"之类的保证**（无依据）——窗口内行为以实际调度为准，是否接受该窗口由用户决定。回滚：删 eve 函数与其触发器。

Codex 文档审核补注：已移除前稿重复的旧迁移段落和无效的“9 点 cron 可于 21:30 执行”举例。若改为四个时点触发再由业务跳过多余时点，需要另行实现与验收，本热修没有采用。

## 六、验收（不误发/不消耗配额的只读诊断 + 真实 timer 验证）

1. **只读·伪造面回归（云端测试，零发送）**：云开发 → mc-daily-push → 云端测试，入参 `{"Type":"Timer","TriggerName":"daily-reminder"}`（控制台直调 SOURCE 为空/非 wx_trigger）→ 预期 `unauthenticated`——证明白名单分支未松。
2. **只读·日志核对**：部署后等自然触发窗口（9:00/21:30），日志应出现 `kind":"timer-daily"`/`"timer-eve"` 与逐成员 results；被拒场景应为明确受控码而非 unauthenticated。
3. **真实发送验收（需用户同意；消耗订阅配额）**：真机两台各点一次首页问候卡攒配额 → 次日 9:00 各收一条日常；产检日前一晚 21:30 各收一条"明天产检"。或经用户同意临时把触发器 cron 改至数分钟后观察（属云端操作，须用户确认）。
4. 43101 `skipped:"quota"` 语义与既有 DEPLOY 8.4/8.5 判读一致。

## 七、边界遵守

本轮仅本地编码/mock 回归/组装/文档。零真实发布、零 commit/push、零真实 manifest/.trial-release-state 修改（摘要见 §三"未动"）、零用户数据/草稿改动、零凭据打印（测试 OpenID 均为合成值）、零补发消息。未以本地 mock 宣称线上已恢复。

—— ZCode 已完成，停止，等待 Codex 审核。
