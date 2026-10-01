# R2 本地候选审核决定

2026-10-01：允许推进 R3，最终验收仍以冻结业务源码上的全新 ZCode 独立验证为准。Codex 只读源码、测试和现有日志，未运行测试或编写业务代码。

已核对：生产 AI 保存事务使用初始 revision 与输入摘要做 CAS；生产 HTTPS 解析拒绝不完整终止；结果保存/响应包含版本、摘要和附件覆盖；过期结果保留查看并有实际重新分析入口；家庭模式管线已移除旧隔离本地库必定为空导致的拦截；元数据未覆盖原因如实；当前 OCR 仅在同输入摘要证据成立时作为本次原文，来源未知历史提取独立标注且保留原记录。

R2_HANDOFF 的 7 个冻结文件摘要与当前文件逐个匹配；已读 r2-run8.log（12 通过/0 失败）和 r2r2-gvision.log（15/0），并核对新增反例经过真实 handler、页面消费与网关调用。这些是 ZCode 执行证据，不代表 Codex 独立运行通过。

调整 phase-g-vision 的旧无摘要直接透传 OCR 断言属于加强来源边界；历史内容以独立未确认通道保留，未降低未知来源保护。

R3 必须同步所有实际新增字段：ai_result 的 inputDigest/baseRevision/coverage（包括 mode）；ocr_result 和 vision_result 的 inputDigest/baseRevision。R2_HANDOFF 早期“ocr/vision 形状未变”的文字须以最终二审形状为准，不允许导出时丢字段。

仍保留 R1 的真实定时身份/数据库 legacy 排序平台门槛、供应商真实外呼未验证、全套独立回归与构建未完成的限制。禁止真实部署、外部请求、commit/push。
