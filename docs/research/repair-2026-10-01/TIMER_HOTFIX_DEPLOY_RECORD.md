# 定时热修部署记录（mc-daily-push 单函数，独立于 1.1.25 发布收据）

2026-10-01 21:03（UTC+8）。执行者：ZCode（用户指令"部署"）。范围 = TIMER_HOTFIX_DECISION.md 批准的"仅重新部署 mc-daily-push"。

## 部署命令与结果

```
/Applications/wechatwebdevtools.app/Contents/MacOS/cli cloud functions deploy \
  --env rxylinux-momcare-d2eoh6t493c2168 \
  --names mc-daily-push \
  --project "/Volumes/solid hard disk/github/rxylinux/MomCare/dist/build/mp-weixin" -r
```

- **进程退出码 0**，无 `[error]`/errCode/fail 业务错误字样（R4 契约成功判据全部满足）。
- 真实 console.table 确认行：`mc-daily-push | success 'true' | filesCount 8 | packSize '16.0 KB'`——**filesCount=8 与已审核 8 文件包逐一对应**（index.js `e06116c3…`、config.json、package.json、shared/×5；整包稳定摘要 `5b6861ebf11c8db67d57fde316d1f966cf0dad8fc1cad47c05a5348f1091f28f`）。
- 部署链路日志：`exists in the cloud, will update it` → `upload cloud function mc-daily-push - preparing` → `deploy` → `✔ deploy cloudfunctions`（更新既有函数，非新建）。
- 原始日志（完整 stdout/stderr+退出码内嵌）：`/tmp/momcare-timer-hotfix-20261001/deploy-hotfix.log`。

## 部署后只读复核（cloud functions info）

- 命令：同 CLI `cloud functions info --env … --names mc-daily-push --project …`，退出码 0。
- 结果：`mc-daily-push | status 'Active' | timeout 20 | runtime 'Nodejs16.13'`——**现有运行时/超时保持**（裁定要求的环境不变项）。与 Codex 部署前快照（cloud-info-redacted.json）一致。
- 原始日志：`/tmp/momcare-timer-hotfix-20261001/deploy-postcheck-info.log`。
- 该 info 接口不返回代码版本/触发器信息（Codex 已注明）——代码证据以上方部署表（filesCount/更新路径）+ 上传包摘要为准；触发器状态仍 **unverified**。

## 未做/保持原状（按裁定范围）

- 未重新上传小程序、未增版本号、未跑 release:trial：真实 `manifest.json`（SHA `3ac52461…`）与 `.trial-release-state.json`（`ba6b45f9…`，1.1.25 收据）**部署前后逐字节未变**——本记录独立存档，不把 1.1.25 收据当本次部署证据。
- 未改环境变量/超时/触发器；未发送/补发任何消息；未动用户数据与草稿（`docs/recipe-draft.md` `7a7fb43b…` 未变）。

## 剩余待办（线上恢复确认前不宣称完成）

1. ~~触发器只读核查~~ **已完成（2026-10-01 21:2x，用户控制台目视核对）**：mc-daily-push 下 `daily-reminder`（9:00）与 `checkup-eve-reminder`（21:30）**两条触发器都在**——官方文档"单函数仅支持一条"的限制在实际环境未生效，**无需迁移**（热修版两名称都支持：H1/H2/H4 回归锁定语义）。本地 config.json 与云端一致。
2. ~~自然触发观察（9:00 日常）~~ **已确认恢复（2026-10-02 09:00，用户真机实收）**：用户报告早上 9:00 收到定时推送——内容为孕吐阶段日常提示（“孕吐来了就少食多餐”，按孕周轮换的预期文案）。`daily-reminder` 触发器 → mc-daily-push 热修代码 → 真机接收全链路验证通过。**定时日常推送恢复确认。**
3. **自然触发观察（21:30 前夜，唯一剩余项）**：产检前一天晚上 21:30 各收一条“明天产检”——届时自然验证 `checkup-eve-reminder`。在此之前前夜提醒不称已恢复（日常与前夜是两个独立触发器，日常恢复不自动证明前夜恢复）。
