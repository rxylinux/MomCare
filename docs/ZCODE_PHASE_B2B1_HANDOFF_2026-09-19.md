# B2b1 实施交接：产检与待产包（冻结待独立 review）

基线：B2a `fa83f76`（已验收推送）。本轮实现 B2b1 全量范围并修复 review 全部复现（含冻结前范围复核与后续四节追加）。未提交/未推送/未部署/未购买云资源；全程隔离测试（SDK 契约模拟），零真实网络。

## 交付范围

对照 `ZCODE_PHASE_B2B1_SPEC_2026-09-19.md` 全条目与 `PHASE_B2B1_REVIEW_2026-09-19.md` 全部复现项，逐项覆盖矩阵与证据见 `PHASE_B2B1_COVERAGE_MATRIX_2026-09-19.md`。

### 服务端（mc-schedule）
- 稳定 ID 全结果分支（含 migrate-apply snapshot fallback op.id）；分页稳定唯一游标；family 隔离与存量 schema 拒绝全路径；字段严格校验（分类枚举含 going、拒绝旧 doc 键）。
- 模板初始化：确定性主键 + 事务存在即保留（并发至多一条、已删不复活、在途不覆盖用户编辑）。
- 勾选目标值语义（targetDone 布尔，非翻转；unchanged 幂等）。
- 迁移：UTC 日序真实日历；来源基线 templateDate/templateLmp 持久（初始化写入、migrate-apply 钉住存量）；预览按来源绝对计算——同一变更部分迁移后再次预览幂等，连续多次 LMP 修改正确；重放 requestHash 比较；仅 pending 自动安排移动。

### store（familyStore）
- bag/checkup 领域 refs、分页拉取、快照恢复；outbox 路由（health 不混流）；冲突 adoptCloud（先落地云端再清待办）/resubmit；各领域完整同步时间（全部页成功才推进）。
- 批量动作持久协议：一条模板/一条改期一条待办（稳定 entityId）；顶层 ok 不掩盖单项失败。
- 未变更草稿重试复用原不可变请求（同 opId，稳定序列化比较）——不产生第二条操作/伪冲突。
- 迁移批次：完整清单（实体 ID+目标+预览 revision+persistedAt）在任何网络前收集并持久化，落盘失败不发请求且内存回滚；恢复（recoverMigrationBatch）只认已持久化清单，重启后把未入队已确认项按原目标/revision 重建待办；全部既定项落定（ok/terminal/adopted）才推进基线，普通同步不得认可未确认迁移；基线从记录级 templateLmp 可信初始化，预览空（服务端确认无可迁移对象）自愈消除提示。
- persistSnapshot 返回布尔；调用方（迁移清单）以落盘结果为发网络门槛。

### 页面
- 待产包：三态数据源；数量(1-99)/位置/负责人编辑器+行内显示；新增全字段（不写死 1）；编辑捕获 revision 基线（后台刷新不抬高）；删除墓碑；失败草稿 ID 复用；空档案显式生成入口（持久协议）；bag 域同步横幅（待办重试+冲突本地 vs 云端比较+采用云端/确认重提+完整同步时间）；分类 documents/going 全链路可见；距预产期天数三态（权威 dueDate+响应式上海时钟）；冷启动/前台协调。
- 产检：三态数据源；完整编辑器（日期/时间/医院/陪同/材料/问题，HH:mm 真实显示不编造）；勾选稳定 itemId（重排不误勾）；完成/跳过；添加检查项 family 路由（稳定新 itemId）；空档案按 LMP 生成标准 14 次安排（记录级基线持久）；日期迁移横幅→预览→确认→部分失败恢复→续传→提示消除；checkup 域同步横幅；倒计时/逾期按上海日号+healthStore.today 响应式时钟（跨上海午夜自动重算）；冷启动/前台协调。
- 我的：下次产检/待产包卡 family 权威同源；删除旧 `hospital_bag_items` 读取（正式零读，旧键字节不变）；补 onShow 刷新与异步确认激活。

## review 复现修复对照

| review 位置 | 复现 | 修复 | 验证组 |
|---|---|---|---|
| 第7-33行 服务端 1-15 组 | 稳定ID/分页/幂等/日历/隔离/校验 | 见服务端 | 服务1-15 |
| 第43/45行 页面初稿 | newItem 未定义、text 映射、删除墓碑、saveItems | 三态重写 | bag页1-3、产检页1-3 |
| 第60行 | 失败草稿重复建实体 | pendingDraftId 复用 | bag页4 |
| 第62行 | 确认重提翻转勾选意图 | 目标布尔随待办持久（端到端） | store4/5、服务14 |
| 第66行 | 下标勾选重排误勾 | 稳定 itemId 端到端 | 产检页2 |
| 第70/94行 | 普通同步误清迁移提示；清单逐项追加致首项成功误推进/null.ids 崩溃 | 已确认批次+完整清单网络前持久化+全部落定才推进 | store6/7/8 |
| 第72行 | 未变更草稿两条操作伪冲突 | submit 层原请求重放 | store10、bag页4 |
| 第74/84行 | 部分迁移后再预览重复偏移 | templateDate/templateLmp 来源绝对计算 | 服务16 |
| 第88行 | 16:45 显示 14:00；医院回落旧档案；bag 倒计时旧路径 | 真实 HH:mm；三态医院/倒计时 | 显示1 |
| 第92行 | 三页冷启动确认后不拉取 | watcher 激活+冷启动协调（B2a 模式） | 冷启动1/2 |
| 第96行 | 倒计时 new Date 无时钟依赖 | 上海日号+响应式时钟 | 显示2 |
| 第98行 | 清单落盘失败仍发网络；恢复门槛缺失 | persistSnapshot 布尔+回滚+persistedAt 门槛 | store12 |
| 第100行 | 迁移响应 id 空、store 滞留旧日期；重放旧快照 | viewCheckup(setData, op.id)+重放优先 currentRecord | store11 |
| 第102行 | 清单已存未入队窗口恢复 | recoverMigrationBatch 按原目标/revision | store13 |
| 第109行 | 清单写故障持续期间 flushAll 绕过门槛发送 | persistedAt 门槛+失败回滚内存清单 | store12 |
| 第111-113行 | 弹窗期间下一条顶替误跳过/误添加/父记录从当前 nextCheckup 重取 | 弹层打开捕获原 ID/revision（markCheckupStatus 支持基线）；勾选传 nextCheckup._id 按捕获记录定位 | 产检页8、产检页2 |
| 第115行 | 负时区日期按 UTC 构造取本地年月日回退一天 | 日期键日历字段直读+UTC 星期算术（两页+摘要卡） | 显示3 |
| 终节（batch-session） | 首项迁移响应挂起期间确认另一成员：首 flush 按 stale 丢弃，但 apply 循环把第 2 项以新成员入队 | apply/recover/initialize 三循环逐项 epoch 校验，切换即停在下一入队前；清单持久化带 epoch；收尾仅原会话 | store14 |
| 终节（服务17） | migrate-apply 仅格式检查即接受 2026-02-31 并落盘 | 目标日期逐项复用 isValidCalendarDate（与 initialize 一致），非法拒绝不写盘 | 服务17 |

## 验证结果（2026-09-19）

- `node tests/phase-b2b1.regress.cjs`：53/53（服务17 + store14 + 待产包页6 + 产检页8 + 冷启动2 + 显示3 + 摘要1 + 审计2）
- `node tests/phase-a.regress.cjs`：72/72（R3.5 注入 dataSource/familyStore 走 demo 分支，断言不变，属页面三态化的必要调整）
- `MC_ALLOW_LEGACY_WRITES=true node tests/phase-b1.regress.cjs`：42/42
- `node tests/phase-b2a.regress.cjs`：42/42
- `npm run build:h5` / `npm run build:mp-weixin`：0 错
- 未绑定模板引用审计（三页面）：0 真未绑定
- 审计：uni.request=0、uni.uploadFile=0；正式流程零读旧 `hospital_bag_items` 且旧键字节不变

## 完整文件 SHA256

```
4c353b04c897fb7e36654480982f4d5a42cff01e7f0034701cca7dad08cf133c  cloud/functions/mc-schedule/index.js
8d78e9b61737c75c9e1ec6a505e99c97aac7e1c9b40e3996572a2c3994dabab2  services/familyStore.js
da11b942b2523faa328bb21e5178231ff523b1666a7d753a37d3aff73e0e024e  pages/profile/hospital-bag.vue
4b3b6edf9227f7420e00ff00b5a91ed647b2f95c6c347197fc61714982991a72  pages/profile/checkup-reminder.vue
ec169d81a796dbff77337484b8a96898a8b2342593d2bc78b80cc57e2d3afff1  pages/profile/index.vue
449b16067f7a43f4cc6ff3c7859cb1372da80768689d683e75d9d313d45fd2fa  tests/phase-b2b1.regress.cjs
fa1bb6a73c4953d1ac4404953f7400f6742fe7ece3c682323d702a0704ae4f67  tests/phase-a.regress.cjs
c0bf1618903199926eb738f12d194e6ecd9c181691ce445bf73f0798505ebfab  docs/PHASE_B2B1_COVERAGE_MATRIX_2026-09-19.md
```
（交接文档不内嵌自身哈希；最终冻结核对与部署边界以 Codex 独立 review 为准。）

## 边界与后续

- 未创建云集合/索引/资源；仅全量部署元数据（mc-schedule 组装进 dist）。
- 报告附件/OCR/共同任务（B2b2/C）不在本阶段；旧 bag 原始字节保留待 B3 来源确认。
- 冻结待 Codex 独立 review；通过前不提交不部署。
