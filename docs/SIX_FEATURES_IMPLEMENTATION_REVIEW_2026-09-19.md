# 六大功能当前实现核对

核对：2026-09-19，HEAD e0cf22f19ece03001d6f2446993805de27b0184e，包含当前未提交 B3a 工作区。依据实际路由、页面处理器、store、云函数核对；不是全量真机验收。当前尚未部署，OCR/DeepSeek 未启用。六项均未达到完整交付。

| 功能 | 当前状态 | 已有内容 | 缺少内容 |
| --- | --- | --- | --- |
| 饮食/行为速查与 AI | 未实现专用功能 | 通用知识文章分类、标题搜索 | 专用速查页、结构化词条/同义词/来源/未知处理、AI 解释服务与真实接入 |
| B 超估重记录与计算 | 未实现 | 首页按孕周静态查表展示参考体重 | BPD/HC/AC/FL 等测量输入、单位/公式版本、计算、估重历史记录 |
| 胎动记录与计时 | 部分实现 | 手动填次数、按日保存、统计和热力图；正式路径接 familyStore | 计时会话、原始点击事件、暂停/恢复/结束、误触撤销、后台与冷启动恢复 |
| 宫缩计时与联系信息 | 部分基础字段 | 孕期资料有医院、医生、产科电话字段 | 宫缩计时页、开始/结束、持续/间隔列表、会话恢复、计时页联系入口 |
| 家庭协同与爸爸首页 | 部分实现 | 两成员身份及共享健康、产检、待产包、报告原件的本地实现与阶段验收；待产包负责人 | 爸爸/妈妈首页视角偏好、主动分享需要、接下/完成/取消/撤回共同任务；两手机真云验证 |
| 首页入口与统一结果提示 | 部分实现 | 原有记录与工具入口、部分待同步/冲突/失败和 AI 未启用提示 | 两视角入口组织、六项工具完整导航、统一来源/未知/失败/生成性质等结果呈现 |

## 直接源码依据

- `pages.json`、`pages/` 路径：没有 `pages/tools/food-safety.vue`、`ultrasound-calc.vue`、`contraction.vue` 或 `pages/tasks/index.vue`。也未发现其他路径承载等价完整功能。
- `pages/knowledge/index.vue:271`：知识文章按标题关键词筛选；不能据此算饮食/行为速查及 AI 问答已实现。
- `components/home/HomeHero.vue:104`：BABY_DATA 是按孕周的静态体重/身长表；宝宝体重显示不是个人 B 超估重计算。`components/profile/ProfileHero.vue:34` 仍标“宝宝估重”，有混淆风险。
- `components/home/RecordEditSheet.vue:54`：胎动输入为数字框及加减；`pages/index/index.vue:327` 保存为 daily.fetalCount。`pages/profile/fetal-records.vue:108` 起生成日统计和热力图，未有计时会话模型。
- `pages/profile/pregnancy-info.vue:171` 与 `cloud/functions/mc-health/index.js:55`：产科电话已有编辑/存储字段，未找到宫缩计时及相应拨号处理器。
- `pages/index/index.vue:1` 起仍为一套 Hero/每日变化/指南/日历/记录面板；未有 homeView、主动分享卡片或共同任务流。`pages/profile/hospital-bag.vue` 的 assignee 是待产包责任人，不等于共同任务模块完成。
- `pages/archives/detail.vue:501`：onAiCardTap 提示未启用后直接 return；`pages/archives/ai-result.vue:3` 显示 AI 未启用。当前 CloudBase 云函数列表没有饮食 AI 或报告 AI 供应商调用实现。旧 report store/API 路径与配置占位不代表 DeepSeek 已接通。

## 与计划的差异及后续归属

`DEVELOPMENT_PLAN_6_FEATURES.md:33` 明确把医学计算/AI 扩展安排到后期，143 行说明 A–D 第一版后再选扩展工具；181/187 行将第5/6项纳入 B/C。因而当前 A/B 基础阶段完成，不等于原六项完成。当前 B3a 尚未通过，B3b 待实施，C/D 也未完成；此核对不自行扩围或变更实施顺序。

D 清理需保留具体问题：`pages/profile/fetal-records.vue:14` 仍有“日正常 ≥10次”及按当天次数标正常/偏少，和当前计划取消统一正常阈值的要求不一致；仅有历史记录时今天未记录还会被折成 0。首页静态参考体重须与个人测量明确区分。此处是代码/文案一致性发现，不构成医学规则审定。
