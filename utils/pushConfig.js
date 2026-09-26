// 订阅消息模板配置——2026-09-26 已选定公共模板 571「日程提醒」（备忘录类目，
// 场景说明：孕期提醒）。字段：thing11=备注（唯一内容字段 ≤20 字）+ date4=日程时间。
// 换模板时：改下方 ID + mc-daily-push/index.js 顶部 FIELD_* 常量 + 云函数环境变量
// MC_PUSH_TEMPLATE_ID 三处同步。空串 = 订阅功能整体停用（点按挂点静默 no-op）。
export const PUSH_TEMPLATE_ID = 'PYHbV5824UtdmEG8dynlAOqYFb3HWrqEQyEnV-a8Qx0'
