# R4 交接记录（ZCode 编码与本地测试执行）——完整重写版

状态：**ZCode 已完成 R4 编码与本地 mock 回归（A23–A25 + 一审 R4R-1..8 + 二审 R4二1..5 + 三审 R4三1..4 + 终审 R4终1..3 + 阻断 R4阻1..3 + 最后确认 R4确1..2，共 24 场景）；未经过 Codex 审核，不称已验收。** 基线 `22be7b3`（R1–R3 候选之上继续，全部改动未提交）。R4 完成后停止，不自行执行独立总验证。

> 历史记录：本文件此前版本（一审/二审交接）含已弃用实现描述（`--allow-incomplete` 例外开关、"测试备份恢复真实 state"的越界做法、"上传 commit 作为云函数部署基线"）。这些均已废弃且不再代表当前行为，本轮按 Codex 三审第 5 条完整重写——上文不保留旧说法。历史日志（`/tmp/momcare-repair-20261001/` 的 r4-run1~10、r4r2-run1~15、r4r3-run1~14）仅作过程记录，**最终状态以 r4r3-run15.log 为准**。

工作目录 `/Volumes/solid hard disk/github/rxylinux/MomCare`。全程本地：**真实 `.trial-release-state.json` / `manifest.json` 从未被测试写入、移动或删除**（R4R-8：所有场景在独立临时项目夹具运行；套件启动时读取真实文件字节、结束时逐字节比对断言未变）；零真实 CLI 上传/部署/触发器操作、零外部请求、零 npm 操作、未 commit/push、未删除用户数据。

## 一、最终实现（当前行为——以此为准）

### 文件

- `scripts/release-dependency-closure.mjs`（新）—— 依赖闭包与部署基线计算，纯本地。
- `scripts/release-trial.mjs`（重写）—— 发布流程；语义见下。
- `scripts/gen-food-safety.mjs` —— 生成物内嵌 `source-sha256` 标记（一致性门输入）。
- `cloud/functions/mc-tools/food-safety-data.js` —— 再生成（带标记首版）。
- `tests/phase-r4.regress.cjs`（新，24 场景）+ `scripts/.r4-real-table.mjs`（测试辅助：本地 Node 真实 console.table formatter 供 mock 生成标准表形——零 CLI；支持 --raw 传入任意索引行）。

### 部署基线（R4R-1 + R4二3 + R4三1）

- **函数级基线 = `state.deployedDigests[fn]`（64hex）+ `state.deployedEnv`（部署目标 envId）**。两者缺一不可：摘要缺失/非 64hex → 该函数必需；**`deployedEnv` 缺失/空（legacy 收据）→ 全部摘要不构成基线（完整集合）**；**当前 envId 无法解析 → 不可借用任何确认摘要（完整集合）且真实发布在上传前拒绝**；换环境（`deployedEnv ≠ 当前 envId`）→ 同样无基线。
- **上传 commit 不是云函数部署证据**——git 基线只做源码级变更理由。
- 收据继承：新收据继承旧确认项（须 `deployedEnv` 匹配）——纯前端发布、上传失败、部分成功、unknown 均**不清旧基线**；仅本次确认成功的函数更新摘要。

### 依赖闭包（A23 + R4R-3）

与 assemble 实际组装一一对应：函数自身/伴生/config → 该函数；`cloud/shared/`、`utils/dailyTipCore.js`、**`cloud/assemble.mjs`** → 全部函数；`static/data/food-safety.json` 与 `scripts/gen-food-safety.mjs` → mc-tools。git 输出 `-z` NUL 解析（带引号/中文/空格路径安全）；**git 查询失败 fail closed**（`gitError` → 明确中止，不静默当无变更）。

### 当前侧摘要与最终集合（R4二1 + R4三3）

- 当前侧摘要未知（dist 缺该函数）→ fail closed 必需。
- **assemble 后以新组装摘要重核对**：新摘要 ≠ 确认摘要且不在 selected → 补入并披露。
- **最终集合统一前置验证（上传前）**：selected 中每函数的新摘要必须合法 64hex 且 dist 目录实际完整；selected 非空必须 envId 可解析；**trigger 状态按最终 selected 重算**（晚补 mc-daily-push 后是 `unverified` 而非 `not-applicable`）。缺产物 → `upload:blocked` 收据 + 拒绝（不靠 CLI 事后错误兜底、不记 null 摘要后 partial=false）。
- **dry-run 保守披露**：未执行 assemble 无法证明 dist 新鲜——输出明确"无法证明当前 dist 对当前源新鲜；实际发布将在 assemble 后重核对（可能补入更多必需函数）"，不宣称确定空计划。

### CLI 确认契约（R4二2 + R4三2）

依据 Codex 只读本机 CLI asar 源码证据（upload 成功输出 "upload success"；函数部署 console.table 表行含函数名 + success 列）：

- **精确目标表行**：行内含**完整函数名词元**（表格分隔符/行首尾为界——`mc-tools-extra` 不算 `mc-tools`）；**邻行不作证据**（目标 false + 邻行 true 不成功）。
- **退出码绑定**：status≠0 → unknown（进程错误 → failed）；残留 true 表行不因非零退出记 deployed。
- **业务错误**：stdout/stderr 任何 `error/errCode/fail` 字样（含无 `[error]` 标记）→ 失败——即使同时有 upload success 也不标 uploaded。
- **无目标行/空输出** → unknown（不猜成功）。
- upload：成功 = "upload success" 契约 + 退出 0 + 无业务错误字样；否则 failed/unknown。

### 名单门（A24 + R4R-2/R4二4）

- **无 `--allow-incomplete` 例外开关**（已删除，不存在于脚本）。
- 无可信基线（含 deployedEnv 缺失/envId 未知/换环境）→ 唯一放行 = `--functions all`（完整集合）；`functions:[]` 被阻止。
- 有基线时：`--functions all` 直接取完整集合（先于缩减检查）；手工名单只能扩展闭包不能缩减（缩减阻止并点名）。

### 收据时序与状态（R4R-5 + R4三4）

- **任何外部上传前**：本次计划耐久落盘（版本/目标 envId/最终 selected/新组装摘要/`upload:pending`/`partial:true`）——**上传期间进程中断时磁盘不再残留旧次"完成"收据**（R4三4 反例②：首次成功发布后再次发布在上传阶段被杀 → 磁盘是本次版本 pending 而非旧次完成态）。
- 上传返回 → `upload:uploaded/failed/unknown` 如实；部署每项确认成功 → deployed + 摘要更新 + 落盘；失败/unknown → partial + 保留旧摘要。
- **git 提交发生在最终收据落盘之后**；成功后不再改 state（工作区干净——下次 clean gate 不被自身收据阻断）。
- `triggers.status`：含 mc-daily-push → `unverified`（平台 API 不确认触发器配置）；否则 `not-applicable`。

### food 一致性门（R4R-7 + R4二5）

**受控临时目录内以当前生成器 + 当前作者源真实再生成并逐字节比对**——不信任生成物自报的 `source-sha256` 标记：生成器语义变化（HEADER/输出形状变）即使标记仍匹配源也拒绝；正文篡改但标记保留同样拒绝；生成器缺失/运行失败拒绝。提示跑 `node scripts/gen-food-safety.mjs` 后再发布。

### 其他

- 外部命令一律参数数组（`spawnSync`/`execFileSync` 数组参数——DESC 作为单一参数传递，杜绝 shell 拼接注入）。
- dry-run 零外呼：先于 git 干净检查/CLI 存在性/islogin 探测（脏工作区可本地演练）。
- 重试等待时钟可注入（`MOMCARE_RETRY_WAIT_MS`，默认 45s，测试设 1ms——保留重试次数/判定/收据语义）。

## 二、A23–A25 + 三轮审核证据

| 场景组 | 覆盖 | 结果 |
|---|---|---|
| A23 闭包规则（1 场景 7 路） | dailyTipCore/food/共享/assemble/自身伴生/纯前端/未跟踪目录 -uall | ok |
| A24+R4R-2 名单门（1 场景） | 无基线 functions:[] 阻止；all 放行；无 allow-incomplete（源码断言无解析/无变量）；可信基线+必需+all（R4二4）；窄名单缩减阻止；幽灵函数 | ok |
| R4R-4 dry-run 零外呼（1） | 夹具脏区演练 + 源码顺序断言（dry-run 先于 CLI/islogin/git） | ok |
| R4R-1 基线（1 场景 3 路） | 旧收据→全部必需；partial 缺项/不一致→必需；推进 HEAD 不吞缺项 | ok |
| R4R-3 路径与 git 失败（1） | 中文/空格伴生路径；坏 commit；.git 移除 fail closed | ok |
| R4R-5+6 中途失败（1） | 退出0+[error] → partial、失败/中止项不记、upload 独立、partial 后再计划缺项仍必需 | ok |
| R4R-6 unknown（1） | 退出非0无错误标记 → 不记 deployed | ok |
| R4R-5 全部成功（1） | 最终收据先落盘后提交；提交后工作区干净；提交内容=最终态；成功后零必需 | ok |
| R4R-5 upload 后 partial 语义（1） | 源码顺序：upload 成功后、部署前 partial=true | ok |
| R4R-7 food 门（1 场景 3 路） | 陈旧拒绝；无标记拒绝；一致放行成功 | ok |
| A25 纯前端（1） | 完整基线+纯前端 → selected=[]/deployed=[] 不误报 | ok |
| R4二1 当前侧/新 assemble（1 场景 3 路） | dist 缺失 fail closed；非 64hex done；assemble 改写 dist → selected 补入+披露 | ok |
| R4二2 CLI 契约（1 场景 4 路） | 空输出0=unknown；upload 无确认=unknown；契约形状成功；errCode 无标记失败 | ok |
| R4二3 摘要合并（1 场景 4 路） | 纯前端/上传失败/部分成功不清旧基线；换环境拒绝 | ok |
| R4二5 food 真实校验（1 场景 3 路） | 生成器语义变化拒绝；正文篡改拒绝；一致放行 | ok |
| R4三1 env 绑定（1 场景 4 路） | deployedEnv 缺失→无基线；空字符串→无基线；当前 env 未知→不可借用；真实发布无 envId 上传前拒绝 + dry-run 披露 | ok |
| R4三2 精确表行（1 场景 4 路） | 目标 false+邻行 true 不成功；同名前缀不认；目标 true+退出3 unknown；业务 error+success 同在 → upload failed | ok |
| R4三3 最终前置验证（1 场景 3 路） | 晚补 mc-daily-push → trigger=unverified；assemble 缺产物 blocked 拒绝；dry-run 保守披露 | ok |
| R4三4 上传前 pending（1 场景 2 路） | mock upload 进入时 state=本次 pending/partial（版本/目标/集合已落盘）；上传阶段中断 → 磁盘保留本次 pending 不回退旧完成态 | ok |
| R4终1 真实表头定位（1 场景 5 路） | 真实 formatter 目标 false+邻行 true→不成功；前置日志+真实表→成功；普通日志→unknown；列重排→按列名确认；目标名只在其他列→unknown | ok |
| R4终2 包完整清单（1 场景 4 路） | 缺 index.js→blocked+upload 零调用；空目录→blocked；缺 shared/dailyTipCore→blocked；完整包→放行 | ok |
| R4终3/阻3 计划+上传包摘要（1 场景 2 路） | mock 进入时 plannedDigests+uploadPackageDigest 已落盘且独立于 confirmed；中断后保留待确认（planned≠confirmed 可辨别） | ok |
| R4阻2 共享/配置清单（并入 R4终2 场景） | 源 cloud/shared 每文件+config.json+伴生物核对；staged 同快照 | ok |
| R4确1 index 精确相等（1 场景 5 路） | not mc-tools(true)/'mc-tools copied'/前缀→不认；精确+true→成功；列重排→按列名 | ok |
| R4确2 遗漏证据补齐（1 场景 4 路） | 缺 auth.js→blocked+零 upload；源 config 未入包→blocked+零 upload；uploadPackageDigest 独立重算相等+中断保留 | ok |

**共 19 场景。**

### 最后阻断修复（R4_REVIEW_FINAL_BLOCKERS 1–3 + 终审 R4终1..3 落实）

1. **R4阻1（真实 console.table 解析）**：解析器按**本地 Node 真实 formatter 输出**重写——`parseTableHeaders` 定位含 `(index)` 与 `success` 列名的表头行，记录两列位置；**横向边框行（├─┼─┤）与顶/底框跳过**（不再截断表体）；目标函数名只匹配 **(index) 列单元格**（完整词元）；success 只接受**该行 success 列**的布尔 true（列重排后按列名定位）；其他列真值/false/无表头/普通日志 → unknown；表头前信息日志不遮挡。测试辅助 `scripts/.r4-real-table.mjs` 在夹具内以本地 Node formatter 生成标准表格（不手造省略结构）。反例五路：真实表目标 false+邻行 true→不成功；前置信息日志+真实表 true→成功；普通日志含 "fn | true"→unknown；**列重排**（success 在最后）→仍按列名确认；目标名只在其他列→unknown。所有旧 mock 的成功部署输出全部改为真实 formatter 调用。
2. **R4阻2（共享/配置完整清单）**：`validateFunctionPackage` 按 assemble 真实复制清单递归核对——源 `cloud/shared/` **每个文件**（auth.js/respond.js/config.js/constants.js…）必须在包内 shared/（缺 auth.js 仍合法 hash 但 handler 无法加载——现在拒绝）；源侧 `config.json`（云调用权限）随包；伴生物齐全；dist 与 **staged（MP_DIR/cloudfunctions）同一快照**（部署目录摘要 ≠ 计划摘要 → blocked）。反例四路：缺 index.js→blocked+upload 零调用（标记文件证明）；空目录→blocked；缺 shared/dailyTipCore→blocked；合法完整包→放行成功。夹具 dist 改为真实完整包形状。
3. **R4阻3（上传包摘要独立记录）**：`receipt.uploadPackageDigest` = 实际 `dist/trial-upload` 小程序包（物理排除后）的稳定目录摘要——独立于云函数 plannedDigests（小程序包字节 ≠ 云函数产物，不能互相替代）；与版本/目标绑定，上传前耐久记录。反例：mock upload 进入时快照含 uploadPackageDigest（合法 64hex）；中断后保留待确认（upload:pending + plannedDigests + uploadPackageDigest 全在，不冒充 confirmed）。`distFunctionDigestsSingle` 的 `createHash('sha256')` 算法遗漏已自修（正向路径即刻暴露并修复——保留完整正向证据）。
4. **R4终1..3（前一轮终审）**：dry-run 输出统一为"初步估算"口径（不打印确定空计划）；CLI 表头定位（含于 R4阻1 重写）；计划摘要独立记录（含于 R4阻3）。

### 最后确认修复（R4_REVIEW_FINAL_CONFIRMATION 1–2 落实）

1. **R4确1（index 精确相等）**：解析器目标匹配从词元包含改为**规范化后完整等于 fn**——规范化仅处理真实 formatter 已证实的引号包裹（`'key'`）与首尾空白；`'not mc-tools'`、`'mc-tools copied'`、`mc-tools-extra` 等其他索引一律不认；success 只接受契约布尔 `true` 字面值（✔/yes 装饰值不再接受——不猜）。反例五路（全部用本地 Node 真实 formatter 生成）：`not mc-tools`(true) 行存在但非目标→unknown 不记 deployed；`'mc-tools copied'`(false) 引号包裹+后缀→不认；**精确目标+true→成功**；前缀拒绝保持；**列重排+精确目标→仍按列名确认**。
2. **R4确2（遗漏运行证据补齐）**：①**保留核心缺 auth.js**——mock assemble 只删 `shared/auth.js`（dailyTipCore 在）→ blocked + **upload 零调用**（mock 在 upload 时 touch 标记文件——不存在即零调用证明）+ `upload:blocked` 收据；②**源 config.json 未入包**——夹具源侧写 `cloud/functions/mc-tools/config.json` 但 dist 无副本 → blocked + upload 零调用；③**上传包摘要独立断言**——mock upload 进入时快照 state 与实际 `--project` 目录路径；测试用与生产同式的目录摘要算法**独立重算**实际 trial-upload 目录字节，断言 `uploadPackageDigest === 独立重算值`（成功收据保留同值；`upload:uploaded` 不冒充 confirmed——deployedDigests 是函数域摘要，两域分离）；④**中断后保留**——upload 挂起被杀后 `.state-at-interrupt` 与最终 state 都含同一 uploadPackageDigest、`upload:pending`、`partial:true`。

## 三、测试证据

命令 `node tests/phase-r4.regress.cjs`（cwd=项目根；独立临时夹具驱动真实脚本/闭包模块代码——mock 仅替换 CLI 路径常量与 test/assemble/build 三个本地命令 + 重试等待时钟）。

| 套件 | node 退出码 | 通过/失败 | 原始日志 |
|---|---|---|---|
| phase-r4（本轮新增，24 场景） | 0 | 24 / 0 | /tmp/momcare-repair-20261001/r4c-run2.log |
| 受影响旧回归（退出码均 0）：i-release-script 10/0（RL1–RL10）、d-release-prep 13/0、r1-tools 29/0、r2-ai 12/0、r3 21/0 | 0 | 全 0 失败 | r4c-rel-*.log |

真实 `.trial-release-state.json`（1.1.24/a0a9fdb 原文）与 `manifest.json` 字节未变（套件首尾断言 + 交接时复核）。无真实上传：mock CLI 是夹具内 shell 脚本，真实 CLI 路径仅存在于生产脚本常量，测试从未触及。

SHA256（shasum -a 256，2026-10-01，**R4 最后确认修复后的当前状态（独立验证冻结基线）**）：
```
31781aebac1ca0a8530fdc3959c4da81fc0edcd8e3195c2a56799d08929dc454  scripts/release-trial.mjs
b0841b6bea2c25315d1c40a92a088d50da1f8fb051774a765f15aec13989a334  scripts/release-dependency-closure.mjs
6af1c69fb9b322e64644f24a3a29a0ca1776af0ac876c30018fe3df56a8f1a97  scripts/.r4-real-table.mjs
f100c693e94e21ab81521b4d43a0de5bd5b288b569f00fdc20ee6c0e4c064924  scripts/gen-food-safety.mjs
32a5d67234bfcffa6da24756941b4b8d4aacdc7bb943d8879aff068a378d624c  cloud/functions/mc-tools/food-safety-data.js
4362a96c1ea161972395959c277d28dbad4ed0244a1e35d3561bfa144b38ec79  tests/phase-r4.regress.cjs
```

（历史 SHA 演进——一审 feeb…；二审 b4c9…；三审 e487…；阻断轮 a951/3ed3/312c…（r4b-run6）；本轮（最后确认）变更 release-trial/.r4-real-table.mjs/phase-r4 三件；closure/gen-food-safety/food-safety-data 自二审起未变。）

（历史 SHA 演进——一审 feeb/b4c9…；二审 b4c9/3bf2/cc41…（r4r2-run15）；三审 e487/b084/60c9…（r4r3-run15）；本轮（最后阻断）重写 release-trial/测试 + 新增 .r4-real-table.mjs；closure 自三审起未变。）

（历史 SHA 演进——一审后 `feeb69b2…/74c3b0c6…/da8dfcd4…`（r4-run10）；二审后 `b4c99f3c…/3bf2c5df…/cc41b55c…`（r4r2-run15）；本轮重写 release-trial/closure/测试三件，gen-food-safety 与生成物自二审起未变。）

## 四、平台待验证门槛（部署阶段，未验收）

1. **触发器**：收据 `triggers.status='unverified'`——部署 mc-daily-push 后控制台人工核对 `daily-reminder`（`0 0 9 * * * *`）与 `checkup-eve-reminder`（`0 30 21 * * * *`）。
2. **定时身份（R1 门槛沿用）**：定时推送入口 fail-closed——部署前须补平台可信身份证据（R1_HANDOFF §九）。
3. **CLI 确认契约的证据边界**：成功/失败/unknown 判定基于 Codex 只读本机 CLI 源码的静态证据（upload success 字样/console.table 表行）；真实 CLI 版本更新可能改变输出格式——unknown 语义保证不猜成功，但部署后仍需控制台/真机复核（触发器与函数状态）。
4. 部署建议：`--functions all` 全集 → 逐函数核对收据 deployed+摘要 → 控制台核对触发器 → 真机 sendNow 验收。

Codex 未运行任何测试、未修改业务代码；本文所有执行结果由 ZCode 产生，等待审核。
