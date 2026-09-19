# MomCare - 孕途伴侣

> 一款结合 AI 大模型的孕期健康伴侣 App，为准妈妈提供智能健康追踪与产检报告解读。

> **2026-09-19 部署决定：** 本项目仅供夫妻两人使用，目标后端确定为微信云开发 CloudBase，迁移待 ZCode 实现；Codex 负责方案和代码 review。下方功能介绍不代表已全部验收，特别是云同步、OCR 和 DeepSeek 调用仍需真实联调。以 [PRD](PRD.md)、[实施规划](DEVELOPMENT_PLAN_6_FEATURES.md)和 [CloudBase 方案](docs/CLOUDBASE_PLAN.md)为当前交付依据。

---

## 🌟 为什么选择孕途伴侣？

|  |  |
| --- | --- |
| 🤰 **AI 产检报告解读** 上传产检报告图片，OCR 自动提取文字，DeepSeek 大模型智能解读，输出整体评估、逐项指标分析和行动建议。支持一键生成分享海报。 | 📊 **全生命周期健康记录** 体重追踪、血压监测、胎动计数、心情日记，配合可视化趋势图表，全方位掌握孕期健康。 |
| 📅 **智能产检管理** 产检提醒与倒计时、检查项目清单、待产包准备进度追踪，让每一次产检都有条不紊。 | 📖 **孕期知识库** 按孕周推荐知识文章，每周指南展示宝宝发育变化与妈妈身体变化，陪伴整个孕期。 |

---

## ✨ 核心功能

|  |  |  |
| --- | --- | --- |
| 🔬 **AI 报告解读** | 📈 **健康追踪** | 📅 **产检管理** |
| 拍照 / 相册上传产检报告 | 体重、血压、胎动记录 | 产检提醒与倒计时 |
| OCR 文字自动提取 | 可视化趋势图表 | 检查项目清单勾选 |
| DeepSeek 大模型智能分析 | 孕期日历 + 每日面板 | 待产包准备进度 |
| 一键生成分享海报 | 数据本地 + 云端同步 | 孕周自动计算 |
| 批量报告分类管理 | 多维度健康趋势 | 新用户引导配置 |

---

## 🏗️ 技术架构

| 层级 | 技术 | 说明 |
| --- | --- | --- |
| **前端** | UniApp + Vue 3 + Pinia | 跨平台微信小程序 / H5，Composition API |
| **服务端（目标）** | 微信云开发 CloudBase 云函数 | 两成员身份校验、业务读写和 AI 调用；无需自管服务器 |
| **数据库（目标）** | CloudBase 文档数据库 | 共同档案与共享记录；私人内容隔离 |
| **文件存储（目标）** | CloudBase 云存储 | 报告原件，受访问权限保护 |
| **AI 大模型（待联调）** | DeepSeek | 云函数调用，密钥仅存服务端；模型版本实施时确认 |
| **OCR（待确认）** | 服务商与模型实施时核实 | 旧文档提及 PaddleOCR / SiliconFlow，尚不能据此认定已接通 |

当前客户端仍有旧 Cloudflare 接口依赖；上表是已确定的目标架构，不代表云环境已创建或代码已迁移。

```
MomCare/
├── 📂 pages/                    # 页面目录
│   ├── 🏠 index/                #   首页（日历、记录、每周指南）
│   ├── 🔐 login/                #   登录页
│   ├── 📝 register/             #   注册页
│   ├── 📂 archives/             #   产检档案模块
│   │   ├── index.vue            #     档案列表
│   │   ├── detail.vue           #     报告详情（含海报生成）
│   │   ├── ai-result.vue        #     AI 解读结果
│   │   ├── classify.vue         #     报告分类
│   │   └── batch.vue            #     批量操作
│   ├── 📖 knowledge/            #   知识库
│   ├── 📘 guide/                #   每周指南
│   ├── 📆 daily/                #   每日记录
│   └── 👤 profile/              #   个人中心
│       ├── index.vue            #     主页
│       ├── onboarding.vue       #     新用户引导
│       ├── weight-records.vue   #     体重记录
│       ├── bp-records.vue       #     血压记录
│       ├── fetal-records.vue    #     胎动记录
│       ├── checkup-reminder.vue #     产检提醒
│       ├── hospital-bag.vue     #     待产包清单
│       └── ...
├── 🧩 components/               # 组件目录
│   ├── NavBar.vue               #   自定义导航栏
│   ├── common/                  #   通用组件
│   ├── home/                    #   首页组件
│   └── profile/                 #   个人中心组件
├── 📦 stores/                   # Pinia 状态管理
│   ├── health.js                #   健康数据
│   ├── report.js                #   报告数据
│   └── staticData.js            #   静态数据
├── 🎨 static/                   # 静态资源
├── 📄 manifest.json             # UniApp 应用配置
└── 📄 pages.json                # 页面路由配置
```

---

## 🚀 快速开始

### 环境要求

```
Node.js >= 18
HBuilderX (前端开发 IDE)
微信开发者工具 (可选，小程序调试)
```

### 安装与运行

```
# 克隆仓库
git clone https://github.com/your-username/MomCare.git
cd MomCare

# 安装依赖
npm install

# 使用 HBuilderX 打开项目
# 运行到微信开发者工具或浏览器
```

### 后端部署

已选择微信云开发 CloudBase，按 [部署与迁移方案](docs/CLOUDBASE_PLAN.md)执行：

1. 用户准备真实小程序 AppID、开通并关联云开发环境、添加两位体验成员。
2. ZCode 实现云函数、数据库和存储权限、客户端接入及数据迁移，完成两台手机联调。
3. DeepSeek / OCR 密钥由用户直接配置到云端环境变量或密钥管理；不写入前端、仓库或交接文档。
4. Codex review 实现与验收证据后再确认可交付。无需购买 CVM/轻量服务器；原生云调用路线不以自购 API 域名为前置条件，小程序平台手续仍需按实际账号要求完成。

旧 Cloudflare 资源如有真实数据，先备份和验证迁移；不在迁移前删除，也不将其作为自动降级写入端。

---

## 🤝 贡献指南

欢迎所有形式的贡献！

- 🐛 **问题反馈** - 提交 Issue 报告 Bug
- 💡 **功能建议** - 分享你的想法和新功能需求
- 🔧 **代码贡献** - 提交 PR 改进项目
- 📖 **文档完善** - 帮助完善文档

```
# 创建功能分支
git checkout -b feature/amazing-feature

# 提交更改
git commit -m "✨ Add amazing feature"

# 推送分支
git push origin feature/amazing-feature

# 发起 Pull Request
```

---

## 📊 发展路线

- [ ] AI 产检报告 OCR + 智能解读真实联调与验收（已有前端流程）
- [x] 健康数据追踪（体重 / 血压 / 胎动）
- [x] 产检提醒与倒计时
- [x] 孕期知识库 + 每周指南
- [x] 报告分享海报生成
- [ ] 微信云开发 CloudBase 迁移与两人共享验收（选型已确定）
- [ ] 孕期社区交流
- [ ] 数据导出与备份
- [ ] 智能饮食建议
- [ ] 多语言支持
- [ ] App 端适配

---

## 📄 许可证

本项目仅供学习交流使用。

---

## ⚠️ 免责声明

本应用提供的健康数据分析由 AI 生成，仅供参考，不构成医疗诊断建议。如有任何健康问题，请及时咨询专业产科医生。

---

__Made with ❤️ for every mom-to-be__
