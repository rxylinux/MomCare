# 阶段 B1 交接（R2 修订）：CloudBase 小闭环（ZCode → Codex review）

日期：2026-09-19（R1 未获放行后的 R2 修订版）。基线：`faa5d19`。状态：**R2 编码完成，源码冻结，等待 Codex review**。未提交、未推送、未部署、未创建云资源；真实 AppID/环境 ID/成员 OpenID 未提供，真实环境验证全部 pending。

## 1. R2 相对 R1 的修复（对照 review 全部新增项）

| 项 | 修复 |
| --- | --- |
| my-openid AppID 契约 | `loadServerConfig` 两个分支均返回 `appidIfAny`；仅配 MC_APPID（成员未配全）时也严格比对，无 MC_APPID 明确 `not-configured`，不再做形态校验放宽 |
| 集中 HTTP 门 | `utils/api.js request()` 层 fail closed：`legacyHttpEnabled()===false` 一律拒绝（`legacy-disabled`），零网络调用——覆盖 store 内部同步/分析分析与一切页面调用（含深链 knowledge/detail），不再依赖页面零散守卫 |
| 二进制上传集中门 | `report.uploadAndCreateReport` 入口同样检查 `legacyHttpEnabled()`：未开启旧 HTTP 即 fail closed 返回 null 并如实提示——补齐绕过 request() 守卫直连 workers.dev 的最后一条路径；直连真实 store 探针断言零 `uni.uploadFile` 调用（UploadSheet 页面入口亦有早退门并计入同一断言） |
| 集中旧正式存储门 | `legacyFormalStoresEnabled()===false` 时两 store 的 `_loadStorage` 对 `YUNTU_*` 返回空、`_saveStorage` 拒写并暴露隔离原因——旧无归属正式键**磁盘保留、零加载/渲染/写入**，待 B3 迁移；演示键与成员缓存不受影响 |
| 新用户入口（Item10） | 登录页重写：移除账密收集与误导注册链接；「进入家庭空间（云）」直达身份确认，演示模式并列可选 |
| 实际退出按钮 | profile `confirmLogout` 真实处理函数调用 `endSession()`：云身份立即失效、缓存关闭、本人未同步草稿保留在原成员键下 |
| 页面身份内容残留（Item6 canary） | 身份更换（mama↔papa）与明确拒绝时 `clearSensitiveMemory()` 清空输入/版本游标/操作 ID/预览/登记号；**瞬时离线确认保留未保存输入**（仅明确拒绝/切换才清） |
| 页面保存竞态（Item6 两探针） | 每个异步操作捕获发起纪元；**提交前按原成员 `mergeDraft` 预暂存**（合并语义不清其他字段）；迟到响应（stale-session/纪元变化）**零 UI/持久化变更**；业务身份拒绝（locked/白名单码）**优先于** stale 判定（拒绝是权威锁定），页面立即同步权威会话状态、清屏、给出锁定说明，不等待下一次确认 |
| 暂存结果如实上报 | `mergeDraft` 返回值被检查：暂存写盘失败时提示"本机暂存也未成功，内容仅保留在输入框"，绝不声称"已暂存/已保存本机"；输入保留 |
| 测试契约补充 | 契约 mock 的 `get` 返回文档**含 `_id`**（set 仍拒）——"展开查询结果再写入"类错误可被捕获；页面测试全部改用**真实今日日期**（TODAY），跨天仍有意义 |
| A 套件关系 | A 套件经 `__setLegacyHttpEnabledForTests(true)`/`__setLegacyFormalStoresEnabledForTests(true)` **显式开启旧路径**验证阶段 A 数据安全语义（72/72，断言未改）；两套结果分别如实标注：生产边界默认关闭由 B1 套件验证 |

## 2. 交付范围（沿用 R1，全部保留）

- **云函数**（`cloud/functions/`，组装产物加载测试）：mc-identity（whoami/受控自取 OpenID）、mc-shared-records（白名单+严格 expectedRevision+operationId 幂等+revision 冲突+事务）、mc-private-notes（成员隔离+冲突不带正文）、mc-files（三段式认领/内容哈希确定性路径转存/原子登记、`MC_UPLOAD_ENABLED` 服务端开关、prepareUpload 服务端派发本人 OpenID 路径、getReadUrl 家庭共享）。全部 `cloud.init(DYNAMIC_CURRENT_ENV, throwOnNotFound:false)`、set 数据无 `_id`、getDocMaybe 返回文档对象、窄圈 not-exist 兜底。
- **部署配套**：assemble.mjs（4.0.2 锁定+产物自检）、默认全拒绝规则模板、官方语法（`.test(resource.path)) == true`/`auth != null`）的暂存规则生成器（family 白名单防注入）、collections.json、DEPLOY.md（自取 OpenID 流程/自检/smoke/契约证据表）。
- **客户端**：cloudConfig（空配置显式未配置）、cloudAdapter（未配置优先于平台）、sessionService（纪元推进+确认在途限制+身份拒绝锁定+瞬时/可信失败区分+成员隔离缓存/草稿/待上传+mergeDraft）、backendGate 双门、家庭页完整闭环（含上传待办状态机：saveFile 持久副本、重试同一文件、显式放弃换新、落盘失败如实报错）。

## 3. 修改文件

新增：`cloud/`（8 源文件+assemble+rules×3+collections+DEPLOY）、`services/`（cloudAdapter、sessionService）、`utils/`（cloudConfig、backendGate）、`pages/family/index.vue`、`tests/phase-b1.regress.cjs`、本交接。
修改：utils/api.js、stores/health.js、stores/report.js、App.vue、pages.json、login/register/knowledge(index,detail)/profile(index,onboarding,pregnancy-info,edit-profile)/archives(batch,unarchived,detail,UploadSheet)/LoginPopup、`tests/phase-a.regress.cjs`（仅：bundle 增 backendGate 导出 + 顶部显式开启两个旧路径旗标以运行历史断言；断言本体逐字未改）。

## 4. 验证命令与结果

| 命令 | 结果 |
| --- | --- |
| `node cloud/assemble.mjs` | 退出 0（测试内真实执行，产物加载+4.0.2+cloud.init 断言） |
| `node tests/phase-b1.regress.cjs` | **52/52 通过**，退出 0 |
| `node tests/phase-a.regress.cjs` | **72/72 通过**（显式旧路径旗标下运行，生产默认关闭） |
| `npm run build:h5` / `build:mp-weixin` | 均退出 0 |

B1 套件 52 项分层：服务端契约 mock（get 含 _id/set 拒 _id/快照隔离事务/Buffer 文件/未 init 报错）×真实组装产物 handler——身份矩阵/伪造忽略/my-openid 契约（含仅配 MC_APPID）/Blocker1/幂等/事务零写入/白名单/私人边界/文件全矩阵（开关、路径、类型、大小、伪装、同 ID 异文件、并发、中断重试、getReadUrl）/规则四边界语义/组装验证；客户端——适配器双失败态/Blocker6 全部（含真实竞态）/确认在途限制/草稿分字段/待上传隔离；页面（整段真实 script setup 打包+全栈贯通）——冲突/草稿/缓存离线恢复/上传待办/redirect/goFamily/**二进制上传集中门（直连真实 store，零 uni.uploadFile）/身份切换 canary 清理/拒绝清屏/瞬时离线保留输入/私人·共享跨身份保存竞态（挂起回调+切换+释放，草稿留原成员零污染）/业务拒绝立即锁定（不借 handleConfirm）/暂存失败如实上报**；集中边界——默认双门关闭/request 零网络/**实际冷启动探针（stale token+旧 YUNTU 数据→零加载渲染、拒写、磁盘逐字节保留、零 HTTP、演示可用）**/实际退出按钮/深链知识详情/旧入口零调用。

## 5. 已知限制 / pending

1. 未创建云资源；DEPLOY 步骤未执行；直传开关默认关（规则控制台验证后才可开）。
2. 契约 mock 基于 4.0.2 源码核对；平台真实行为（事务隔离级别、错误结构、临时 URL、规则语法）待真机/控制台复核。
3. 规则语义测试为本地模拟，不冒充控制台验证。
4. B2 未动：旧 store 数据源迁移、持久 outbox、分页/冲突 UI、删除标记、AI、双首页。
5. 旧正式键隔离为**读取/写入/渲染层**隔离；B3 逐项确认迁移后才恢复。阶段 A 的旧传输/旧正式存储语义仅在历史回归套件显式开启旗标下验证。

## 6. 关键源码 SHA256

```
d3fd3a95a373c52cbfbe59260a7438f01eb629e825102532114a4e300179f7e9  cloud/shared/config.js
39f9c4bd7d7c645d375a6fa12851d66e405e52db213d9c54e96972335872dbc2  cloud/shared/auth.js
73c662f1b086a0cbbdd276437276622aa03c709bd2a3723d8e2184fd5fd8b7b3  cloud/shared/constants.js
ff871f55cc686ae99c6b2db504c3d3feb037804cbadb3c5f379bc63ecda4aad7  cloud/shared/respond.js
78bc9779adc719c00f79c35055142c3db6d90cbc4a0b9401f1fb7ee51c389c80  cloud/functions/mc-identity/index.js
956f1ba8492d10e8a5cf21f5301d55e749ecec186584712595d0b1e201c6bcb1  cloud/functions/mc-shared-records/index.js
29d57611206fe6dd6a7733ccf24e24eff7fbbbf4bd0d308422e354a774b23f2c  cloud/functions/mc-private-notes/index.js
6a4724b704fb8226eaf4192fff4997d8dd9f27a1442cd25e1bb27afbe3ea86f6  cloud/functions/mc-files/index.js
9fbca4f2bce7f4676bf2451980543dcfa7ee550c9186e217341dd24d4e75a519  cloud/assemble.mjs
2723eb87f02d294bc7458379205e3ad8f21abf3893f335a4591cff4e4b42a576  cloud/rules/database.rules.json
2723eb87f02d294bc7458379205e3ad8f21abf3893f335a4591cff4e4b42a576  cloud/rules/storage.rules.json
b65e5cd1b0f5a435b858526610819e71d720c8fe75c59bf56381ecdf8011ce9f  cloud/rules/generate-staging-rules.mjs
2d8f443305207322a670dbe2c374d5e26ca4bcb8a8893a8b6bacd69382fdb2a4  cloud/collections.json
1f7e5ed0c2573a265cc4639405ec063d1f9290b0aa46b992a573b134ce0545a2  cloud/DEPLOY.md
676f43956f0aff88461ce50a0cb4f9064bc4c36dab1cd30f155c8bb468c1e585  utils/cloudConfig.js
edbecae46fbfce7fefed8360e7bf30c1fad316c7008735b4b7b7cd155a53af7c  utils/backendGate.js
8cdaea85f8108234d743dfc076afc3a5d411d283769a37db718c69d1377ee941  utils/api.js
bfb5db9371a68f2def1627dfd3da6173380ad3a006eef05829662200cfc1fdd3  services/cloudAdapter.js
19b8d5c31d86f8a0b5d8124665b8c67d8eb4f06425fe28c6c36ca99f73a0c771  services/sessionService.js
d0549d49451f3e06e1f9406463e6c215016a46e91f8ceb62f28dcd5fc01a8757  pages/family/index.vue
d7652d873bd228505ee69f5fa28f65080c69ad54b76dd86ff1b4084d83377075  pages.json
927d20cca95f79e55b9ef82fcd8cb43505547c000676ee42fab9d7fd584c8a5a  pages/login/index.vue
84db4d3313c64d091a681949266baf2a1fa4ebcb9d86ce127e1dc08fe2623c8d  pages/register/index.vue
bf42aa0fa22bfc04d5939b7d8617d1c52969b16c043be52c78d57911f1ea1cb1  pages/knowledge/index.vue
478c82a053ce97f2650966a2381cd4425a1e7d2c5a51458268d6cc1831d5f517  pages/knowledge/detail.vue
7759d39cdc04d71345315f237b58da7d4fc0a12c757289715bf2fa01fee9d0cc  pages/profile/index.vue
2cbd2ec15b59aec261fa6c89b20018a3cbbab6257d0c3ec57b200685ed0546bc  pages/profile/onboarding.vue
ea7ad707fd10fae22fb3f6bfe115e9bbb9250b122e5f422f29e41cfec10e32fe  pages/archives/batch.vue
947dd5129c7ad941bbf3ab774790ac0319a132b6a73109f9b20b4bbe81079e8a  pages/archives/unarchived.vue
2843958d8bb8dacda5ac197dd44978144977485c11795e62ef09222911dd0f98  pages/archives/detail.vue
622e0c60e4b868b839c23ba1af989a2d5960db41ac6765de05bba30d3203ea95  pages/archives/components/UploadSheet.vue
b2e18b6652ecaf37b7f41cc0a437959ab1845c665b64ce7bba36da58473ffec0  components/common/LoginPopup.vue
fc0ed5747947cb5b173a172993a602353368cbc5cadfef96b4e1ed7c9afcd9ce  pages/profile/pregnancy-info.vue
6af9930c847debbb3521d085f1d3fee110878c4a970b2540ebdbd120f24d2d55  pages/profile/edit-profile.vue
a7adf97414ba5943767af07cc881c8a0388920c33d11a77ad748abc6b60064b9  App.vue
35e1c5761e37fd2e0b0fd44288878afb81f2f2462443125fa855dfba96a944a2  stores/health.js
75cc071e0b1db91e897ebc83d92eae6c3046e12fce15f0aa094dabef2b42180a  stores/report.js
beecb31b6967d0f812183bbd93e4653cc1e959b1de53514938d50a3e452735b3  tests/phase-b1.regress.cjs
2c330ceac7275ca788297a6d072cbecf5c69850cab5503deaa303d984f6378f7  tests/phase-a.regress.cjs
```

—— B1（R2 修订）交付冻结，等待 Codex review。不开始 B2；提交/推送由 Codex 通过后经用户授权执行。
