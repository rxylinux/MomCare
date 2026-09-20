# Phase D 专项功能方案规格与实施计划：本地发布准备与包体规范化

**文档状态**：Codex 架构方案冻结稿  
**执行角色**：Codex 负责方案制定、审查与门禁把关；ZCode (GLM-5.3) 负责代码编写与自动化测试  
**依据文档**：`docs/ZCODE_PHASE_D_SPEC_2026-09-19.md`、`docs/DELIVERY_STATUS.md` §D

---

## 一、Phase D 目标与交接范围

Phase D 作为**本地代码与构建层面的最终收官阶段**，旨在确保代码库处于完全符合微信小程序规范的发布准备就绪状态：
1. **清理误导性部署命令**：
   - 移除 `package.json` 中默认的 Cloudflare H5 `deploy` 与 `preview`，重命名为历史归档命令（`deploy:legacy-preview` / `preview:legacy`）；
   - 增加规范的 `npm test`、`npm run test:all` 与 `npm run assemble:cloud` 脚本。
2. **包体体积优化与发布配置（`manifest.json`）**：
   - 在 `manifest.json` 的 `mp-weixin` 节点下配置 `packOptions.ignore`，明确排除无需打包进微信小程序的 iOS 专用配置文件（`static/momcare.mobileconfig` 约 5.2MB）与未使用的大图（`static/logo.png` 约 3.9MB）；
   - 保证编译后小程序主包体积健康可控（避免超过微信 2MB 限制）。
3. **本地发布预检自动化套件（`tests/phase-d-release-prep.regress.cjs`）**：
   - 自动检测 `manifest.json` 的 `packOptions`；
   - 自动检测 `package.json` 的安全命令；
   - 自动检测云函数完整装配（10 个函数无缺漏）；
   - 静态检查无明文密码或生产私钥泄漏。

---

## 二、实施清单

1. **`package.json` 规范化**：
   - 更新 scripts 配置，杜绝任何误执行 Cloudflare 覆盖操作；
2. **`manifest.json` 优化**：
   - 补充 `mp-weixin.packOptions.ignore` 配置；
3. **编写回归测试套件 `tests/phase-d-release-prep.regress.cjs`**：
   - 覆盖包体过滤、脚本安全、云函数编译产物完整性与冻结源哈希；
4. **全量回归运行**：
   - 验证所有测试 100% 绿灯。
