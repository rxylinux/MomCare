# MomCare 云函数部署说明（B1）

状态：**代码与模板就绪，尚未部署**。真实 AppID、CloudBase 环境 ID、两位成员 OpenID 未提供——本文件描述部署步骤与自检方法，不包含也不要求任何密钥入库。部署、开通资源、控制台操作由用户在交付时执行。

## 1. 需要用户准备（非密钥配置）

| 项 | 说明 |
| --- | --- |
| 小程序 AppID | 替换 `manifest.json` 的 `touristappid`；同时作为云函数 `MC_APPID` |
| CloudBase 环境 ID | 与该 AppID 关联的微信云开发环境；填入 `utils/cloudConfig.js` 的 `envId`（环境 ID 不是密钥） |
| 两位成员 OpenID | 通过下方"自取 OpenID"流程获取，核对后配置到云函数环境变量 |

云函数环境变量（每个函数都要配，控制台 → 云函数 → 配置 → 环境变量）：

```
MC_APPID=wxoooooooooooooooooo          # 允许的小程序 AppID
MC_FAMILY_ID=fam-momcare               # 固定家庭标识（自定，仅作数据分区）
MC_MEMBER_MAMA_OPENID=oooooooooooo...  # 妈妈 OpenID
MC_MEMBER_PAPA_OPENID=oooooooooooo...  # 爸爸 OpenID
```

缺任何一项：所有业务函数返回 `not-configured`，客户端显示"尚未配置"，不会猜测或降级。

### 自取 OpenID（设置期受控通道）

部署函数后，**先只配置 `MC_APPID`**（其余三项留空）。两位成员分别在自己的手机上：

1. 打开体验版 →「我的 → 家庭共享（云）」→ 点「查看我的 OpenID」。
2. 页面调用 `mc-identity` 的 `my-openid` 动作：服务端只校验 AppID，只返回**调用者本人**的 OpenID——不返回他人身份、不返回白名单、不把完整身份写入日志。
3. 成员把屏幕上显示的 OpenID 抄送给管理员（即开发者本人），由管理员写入两个 `MC_MEMBER_*_OPENID` 环境变量并重新部署。

**不存在自动注册**：环境变量是唯一成员来源；"最先登录的两个人自动成为成员"从未实现也明确不做。

## 2. 组装与部署

```sh
node cloud/assemble.mjs        # 生成 dist/cloud-functions/<fn>/（含锁定的 wx-server-sdk 依赖声明）
```

对每个 `dist/cloud-functions/mc-*` 目录：

1. 微信开发者工具 → 云开发 → 云函数 → 新建/上传（目录内执行「上传并部署：云端安装依赖」），或 CLI `tcb fn deploy`。
2. 配置环境变量（上表四项）。
3. 集合创建：按 `cloud/collections.json` 创建 10 个集合（含 B2a 的 mc_pregnancy / mc_health_daily / mc_moods；B2b1 的 mc_checkups / mc_bag_items；B2b2 的 mc_reports）并建索引（daily/mood 需 dateKey 复合索引；mc_reports 需 familyId+sortKey 分页索引；mc_files 需 familyId+_id 清理遍历索引）。
4. 数据库安全规则：应用 `cloud/rules/database.rules.json`（`read:false, write:false`——客户端零直接读写，全部经云函数）。
5. 存储安全规则：应用 `cloud/rules/storage.rules.json`（默认全部拒绝，客户端直传保持关闭）。

## 3. 配置自检（部署后、开放给另一成员前）

依次调用（可用微信开发者工具云函数本地调试）：

```js
// 1) 未配置成员时应明确失败
mc-identity {}  // 期望 { ok:false, code:'not-configured' }（或先只配 MC_APPID 时：not-family-member）

// 2) 配置完成后，两位成员各自调用
mc-identity {}  // 期望 { ok:true, data:{ memberId:'mama'|'papa', displayName, familyId } }
// 第三台设备（非成员）调用 → { ok:false, code:'not-family-member' }

// 3) 共享健康数字读写 + 幂等（B2a 权威源 mc-health；旧 mc-shared-records 已无页面消费者，仅保留为契约测试对象）
mc-health { action:'daily.upsert', schemaVersion:1, dateKey:'2026-09-20', payload:{ weightKg: 58.5 }, expectedRevision: 0, operationId:'op-test-1' }
// 重复同一请求 → { ok:true, data:{ replayed:true, record:<首次结果> } }
// 同 operationId 换内容 → { ok:false, code:'operation-id-conflict' }
// 单字段提交保留其他字段；fetalCount:0 合法；null/空串=清除

// 4) 私人心情/备注：另一成员用同一 dateKey 读取 → 只会得到自己的（或 null），绝不返回对方内容
mc-health { action:'mood.get', schemaVersion:1, dateKey:'2026-09-20' }
```

## 4. 真机 smoke（用户执行）

1. 体验版（关闭调试、不开代理）打开小程序 →「我的 → 家庭共享（云）」。
2. 页面应显示已确认成员（妈妈/爸爸）；第三台非成员设备显示"仅限本家庭成员使用"。
3. 双端各写一条共享体重，另一端下拉刷新可见；并发同改一条出现"已被对方更新"提示。
4. 各写一条私人笔记，对方页面无从看到内容与错误泄露。
5. 文件区显示"上传通道未启用"（B1 默认关闭，规则验证后开放）。

## 5. SDK 版本与契约证据

锁定 `wx-server-sdk@4.0.2`（依赖 `@cloudbase/node-sdk@3.17.2`）。Codex 于 2026-09-19 从 npm 获取该发布包并在临时目录逐文件核对源码，本项目据此实现的契约：

| 契约 | 源码依据 |
| --- | --- |
| `cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, throwOnNotFound: false })`——`throwOnNotFound` 是 **init 配置级**选项（进入 database.config），不是 get() 参数 | wx-server-sdk index.js DocumentReference.get 读取 `this.database.config.throwOnNotFound` / `cloud.config.throwOnNotFound` |
| `doc(id).get()` → `{ data: object|null }`；不存在时依配置抛错或返回 `data:null` | 同上 get 包装：数组/事务单对象统一为 data；不存在且 throwOnNotFound=false → `{data:null}` |
| `doc(id).set({ data })` 的 **data 内含 `_id` 会被本地拒绝**（-501007 invalid parameters / "不能更新_id的值"） | @cloudbase/database document.js set：`data.hasOwnProperty('_id')` → INVALID_PARAM |
| `cloud.downloadFile({fileID})` → `{ fileContent: Buffer }` | index.d.ts DownloadFileResult |
| `cloud.uploadFile({cloudPath, fileContent})` → `{ fileID }` | index.d.ts UploadFileParam/Result |
| `cloud.getTempFileURL({fileList})` → `{fileList:[{fileID,tempFileURL,...}]}` | index.d.ts GetTempFileURLResult |
| `db.startTransaction()` → 事务文档 get/set + commit/rollback | index.d.ts Db.startTransaction |

升级 SDK 版本前必须重新核对以上语义；隔离测试的模拟对象实现了同一契约（含 set 拒绝 `_id`）。

## 6. 明确未完成（真实环境验证 pending）

- 未创建/购买任何云资源；以上步骤均未执行过。
- SDK 版本锁定 `4.0.2`（契约证据见第 5 节）；升级前须重新核对。
- 事务并发隔离、`doc.get()` 对不存在文档的确切错误结构、存储规则的暂存目录写法，须以真实环境行为复核（隔离测试只实现了官方文档明示的契约）。
- 客户端直传暂存目录的存储规则模板（`storage.rules.staging.example.json`）保持与默认相同的全拒绝，待控制台验证本人目录限定写法后再启用。
- 双端真机同步、临时 URL 有效期、清理暂存文件任务属 B2/B3。

## 7. mc-restore 部署（B3b 阶段二——尚未实施部署）

### 云函数

`cloud/functions/mc-restore/`——与现有函数同模式（`require('wx-server-sdk')` + `shared/` 符号链接）。环境变量与其他函数完全相同（`MC_APPID` / `MC_FAMILY_ID` / `MC_MEMBER_MAMA_OPENID` / `MC_MEMBER_PAPA_OPENID`）。

`cloud/assemble.mjs` 已包含 mc-restore 的打包（shared 符号链接 → 实际文件复制到 `dist/cloud-functions/mc-restore/shared/`）。

### 数据库集合（9 个——见 `cloud/collections.json`）

| 集合 | 用途 |
| --- | --- |
| `mc_restore_batches` | 批次主文档（状态机/contentGeneration/provenGeneration/preflight） |
| `mc_restore_declare_chunks` | manifest 原始字节分片 |
| `mc_restore_declarations` | 声明索引（逐记录/逐附件） |
| `mc_restore_anchors` | per-record chunkTotal 锚定+cumuBytes |
| `mc_restore_records` | 隔离区记录（内联或元数据+chunk 引用） |
| `mc_restore_record_chunks` | 分片记录原始字节（restored 后无限期保留） |
| `mc_restore_files` | 隔离区附件引用（指向 mc_files 正式登记） |
| `mc_restore_slot_locks` | begin 并发互斥槽位锁（计数+创建同一事务；滞后条目按批次实际状态修剪） |
| `mc_restore_blocks` | V20 索引块文档（finalizeDeclare 逐块持久——Merkle 叶载荷 entries+位置绑定叶 sha256+proof；`MC_RESTORE_V20_ENABLED` 启用模式专用，默认关不产生文档） |

### 安全规则

- **全部 9 个 `mc_restore_*` 集合（含 `mc_restore_blocks`）**：客户端直接读写**全拒绝**（与 `mc_shared_records` 等现有结构化集合同模式）——只能通过 `mc-restore` 云函数（服务端 `resolveCaller` + owner 校验）。
- `mc_files` 既有规则不变——restore 的 `restore:<batchId>:<fileIndex>` 引用追加走服务端事务。

### 索引

部署时在控制台按 `cloud/collections.json` 中各集合的 `indexes` 字段创建。关键索引：

- `mc_restore_batches`: `{ownerMemberId, familyId, status}` — 批次按所有者/状态检索（活跃上限互斥已由 `mc_restore_slot_locks` 槽位锁事务承担——非 begin 查询路径；此索引供运维/后续 list 类检索）
- `mc_restore_record_chunks`: `{batchId, domain, recordIndex, chunkIndex}` — finalize keyed get
- `mc_restore_declarations`: `{batchId, _id}` — 全量分页遍历
- `mc_restore_blocks`: 无二级索引——块文档按协议 D21 精确形状不存 batchId/blockIndex 字段（仅在 _id 键 `<batchId>:blk:<i>` 内），访问/清理走 _id 前缀键控

### 部署顺序

1. 创建 9 个集合（控制台或 CLI——含 `mc_restore_blocks`；V20 默认关亦建议先建好，避免启用时缺集合）
2. 部署 `mc-restore` 云函数（与其他函数相同的环境变量）
3. 创建索引
4. 客户端测试（仅合成数据）

**当前状态：Phase 1 核心动作已实现但未部署。Phase 2 目前仅 progress/list 有本地入口；attachFile/preview/readUrl/commit/verify/abandon 尚无公共 action 实现。V20 的 `declaring→preparing→finalizeDeclare→indexing` 有界服务端路径已实现，默认关闭；`indexDeclarePage` 的 V20 块消费、客户端续作与真实云端验证仍待完成。阶段二整体未验收，也未提交或部署。**
