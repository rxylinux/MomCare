# B2b2 实施交接：报告与附件（本地独立 review 已通过）

基线：B2b1 `9a473a50e5e2ab9d672d7c3da4ae05a4115c158a`（已验收推送）。设计选择见 `ZCODE_PHASE_B2B2_DESIGN_2026-09-19.md`，CLOSEOUT 八项全部完成（对照 `PHASE_B2B2_COVERAGE_MATRIX_2026-09-19.md`）。本地review通过，提交推送由Codex执行；未部署；隔离合成数据，零真实网络，AI 未启用。

## 交付

- **服务端**：mc-reports（稳定 ID/创建完整性/family+kind 幂等绑定/事务引用记账/墓碑/真实 SDK deleteFile 契约/清理分页+补偿/迟到签发门）+ mc-files 增量（生命周期状态机/续租/实际 fileID 持久化/补偿删除），B1 兼容保持。
- **服务层**：fileUploadService（全程 epoch 门）+ reportFamilyStore（完整清单/槽位保留/逐项推进/重启恢复/终版创建协议：意图先落盘阻断门、成功即完成、对账只确认不重发、已删不重建；恢复边界：受限作用域/身份隔离/阻止拼接/discard 持久优先/完成后不复活；策略迟到门；编辑草稿 own-note 语义+基线+提交后清除）。
- **页面**：UploadSheet（原件/操作 epoch/单次交付）；index（权威模板消费/一份多页导航/报告域冲突卡（真实顶层字段+删除状态+采用云端/确认重提）/待同步数量+重试/批次/恢复卡/仅未归档可整理入口/会话清理）；classify（前置分流/同步 hydrate+nextTick guard/draftChanged epoch 绑定 modal 确认→草稿持久转移（含创建基线 revision1）→classify p6 编辑模式/旧 URL 仅 demo）；detail（编辑与删除打开时基线/下载每次鉴权+迟到成功门/AI 非 demo 未启用优先于配额）；unarchived（无 AI 门槛/冻结意图批量/删除基线/操作后重映射/会话清屏）；batch（正式直达隔离）；ai-result（非 demo 全隔离）。
- **元数据**：collections.json（索引 name/direction+unique）、DEPLOY.md（10 集合）、uploaderId 语义。

## 验证

- `node tests/phase-b2b2.regress.cjs`：**33/33**（服务端、批次store、真实页面及审计33组；含逐附件 deepEqual/SHA256/大小/全序、恢复/草稿/下载退出边界）
- Codex review-runner：**58 入口全过、sourceFreezeStable（19 源码文件）**
- B2b1 53/53、B2a 42/42、B1 42/42、A 72/72；build:h5 / build:mp-weixin 0 错；unbound 0；`git diff --check` 干净

## SHA256

```
96fed7d2d3332c0b7047adcb0c6d09f4a5b8fa1f8d5101f3cb8907ac1c111855  pages/archives/components/UploadSheet.vue
34e8c46c08dd9fcb76a9009b8a66b92031010dffe37b0cb3ad4040bcafdb10e5  pages/archives/index.vue
061b1b59c2b95512c950ca41bbfd4e2f5a8211535280028e54936e475a1f94e3  pages/archives/classify.vue
0a1583d60b8fdaf11cad32fba7fdcb807a3a175258058f84594bdcfb2670f0ce  pages/archives/detail.vue
feebc47a274f4ed84292d6c8a64d4f90580283d802a5ef77c4b17ad8b9da3c27  pages/archives/unarchived.vue
37161c53dbf88c2cf06aee11b1eec203de71e5471913e8885f1dc062c7b4f8db  pages/archives/batch.vue
47f007abd75b3c87ca3de64feb093c87c254b7285c3e8a88d01adb0538a39131  pages/archives/ai-result.vue
57eda6af2d0ad4387bdf7658587cfd16aaaa8d58733a6a9953f35d984f3190ac  pages/index/index.vue
a466769797a1198df71d5e30df9e92e2cef462b50552fbe8ddb6d64d6c35e1a7  services/reportFamilyStore.js
f7869d1b8c2dbf004c3b2a59c827d6b1d5d6e6c602cb741f64658202175314e3  services/sessionService.js
1cbd8174fa157db514a804f7fa6340073338201f3e65ea4c0e03b90643a89599  services/fileUploadService.js
717e9a4d39918e442aa72b66cdbed062cf5629148fe7dce47af3cf8b2f92600b  services/familyStore.js
37cee1ff67f7eb5c8a480aae0cb11151fec7156e6eaa0f6db5d59af8208b22ce  pages/family/index.vue
ad582658484ac6e4898b83d33906732a7f2058b5bf7a26008393f8489bdf75cb  tests/phase-b2b2.regress.cjs
1fb0ca2052722d3cab9bc62f504062be4c5055a0735fc17794606947fe0990cc  tests/phase-a.regress.cjs
af558b1a0565f5f80a54fca008d01831b69a799e143018881257a69d4ad7e2d0  cloud/collections.json
5c57e97e85093879bd2ab2f86a5f1afc782c43c10fda21c3ff0fae0db4794d10  cloud/DEPLOY.md
5db821521886d85c82cf2b95630cfe5d692125e27d77ab6481d445fd523951d9  cloud/functions/mc-reports/index.js
bfe16eaf710b1b8b46922a9880e19ab99249e434dc0e1365e0cc9bbbef891cee  cloud/functions/mc-files/index.js
bc572cc20923d2f52f60b70e8b9f388c01cbc6590be11144a9644d5889ad462a  docs/ZCODE_PHASE_B2B2_DESIGN_2026-09-19.md
b4ee80d42a3d6a30b6f00b12c59c161f378e949cac7b2b4acf4123364353af0a  docs/PHASE_B2B2_COVERAGE_MATRIX_2026-09-19.md
```

边界：未提交/未部署/未调用真实供应商；AI 未启用；旧正式键原件留 B3；真机验收在最终部署阶段。
Codex最终验收与Node一次崩溃后53/53重跑证据见 PHASE_B2B2_REVIEW_2026-09-19.md；本地通过不代表真机或部署通过。
