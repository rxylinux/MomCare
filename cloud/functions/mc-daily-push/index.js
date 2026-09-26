'use strict'

// mc-daily-push：每日提醒推送（2026-09 方案落地）。
//
// 两个入口：
// - 定时触发（每天 08:00，triggers 见 config.json）：无人为调用者，直接执行推送；
// - 手动试发 {action:'sendNow'}：仅限家庭成员白名单（resolveCaller），验收用——
//   不用等到次日 8 点即可真机收到一条。
//
// 数据与内容：
// - 孕周/文案全部来自共用核心单源 shared/dailyTipCore（assemble 从 utils/dailyTipCore.js
//   转译投放，与客户端同一份字节）；产检查 mc_checkups 最近一条 pending（滤墓碑）。
// - 内容三规则（用户 2026-09-25 定）：结合孕周阶段变化/营养按孕周轮换/水果写当季果名。
//
// 诚实原则：
// - 43101（用户未订阅或配额用尽）如实记 skipped:'quota'，绝不重试轰炸——配额制是
//   机制常态（当天没攒配额就发不出，次日自动恢复），不是错误；
// - 一人失败不挡另一人；结果摘要只记 sent/skipped/error，不落私人内容。
//
// 部署契约见 DEPLOY.md：上传并部署 + 上传触发器 + 环境变量 MC_PUSH_TEMPLATE_ID +
// 函数超时调 20s（默认 3s 罩不住读库+两条外呼）。

const { loadServerConfig } = require('./shared/config')
const { resolveCaller } = require('./shared/auth')
const { ok, fail } = require('./shared/respond')

// 共用核心（assemble 转译投放；缺失即 fail-closed 拒绝执行，绝不静默降级）
let core = null
try { core = require('./shared/dailyTipCore') } catch (e) { core = null }

let cloud = null
try { cloud = require('wx-server-sdk') } catch (e) { cloud = null }
exports.__setCloud = function __setCloud(mockCloud) { cloud = mockCloud }
exports.__setCore = function __setCore(mockCore) { core = mockCore }

const PREGNANCY = 'mc_pregnancy'
const CHECKUPS = 'mc_checkups'

// 订阅消息字段映射——按已选公共模板 571「日程提醒」（备忘录类目，2026-09-26 添加）：
// 仅一个内容字段 thing11（备注，≤20 字）+ date4（日程时间）。
// 单内容字段取舍（buildPushContent.event）：有产检事件（当天/倒计时/过期）用主行，
// 平日用轮换提示行——保证大多数日子推送内容有变化。换模板时改这里。
const FIELD_CONTENT = process.env.MC_PUSH_FIELD_CONTENT || 'thing11'
const FIELD_DATE = process.env.MC_PUSH_FIELD_DATE || 'date4'

// 当前仅体验版策略（不发布正式版）：推送落地页以体验版打开
const MINIPROGRAM_STATE = 'trial'

function ensureCloud() {
  if (!cloud) throw new Error('wx-server-sdk 不可用')
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, throwOnNotFound: false })
}

async function getDocMaybe(db, collection, docId) {
  try {
    const res = await db.collection(collection).doc(docId).get()
    return (res && res.data) || null
  } catch (e) {
    return null
  }
}

// 最近一条 pending 产检（滤墓碑，dateKey 升序取首）——与客户端 index.vue nextCheckup
// 同口径；buildPushContent 内部决定"过期≤14天/≤7天倒计时/忽略远期"
async function earliestPendingCheckup(db, familyId) {
  try {
    const res = await db.collection(CHECKUPS)
      .where({ familyId, status: 'pending' })
      .limit(20)
      .get()
    const rows = ((res && res.data) || []).filter(r => r && !r.deleted && r.dateKey)
    rows.sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1))
    return rows[0] || null
  } catch (e) {
    return null
  }
}

function todayKey() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// 模板 571 date4 为 date 类型——微信订阅消息 date 字段用中文日期格式（YYYY年M月D日）
function chineseDate() {
  const d = new Date()
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

function buildMessageData(content) {
  const text = content.event ? content.main : content.note
  const data = {}
  data[FIELD_CONTENT] = { value: text }
  data[FIELD_DATE] = { value: chineseDate() }
  return data
}

async function sendToMember(member, templateId, content) {
  try {
    await cloud.openapi.subscribeMessage.send({
      touser: member.openid,
      templateId,
      page: 'pages/index/index',
      miniprogramState: MINIPROGRAM_STATE,
      data: buildMessageData(content)
    })
    return { member: member.memberId, sent: true }
  } catch (e) {
    const code = (e && (e.errCode !== undefined ? e.errCode : e.errcode)) || ''
    if (code === 43101) {
      // 未订阅/配额用尽：配额制常态，如实记录跳过
      return { member: member.memberId, sent: false, skipped: 'quota' }
    }
    return { member: member.memberId, sent: false, error: String(code || (e && e.errMsg) || 'send-failed') }
  }
}

exports.main = async function main(event) {
  const config = loadServerConfig()
  if (!config.configured) {
    return fail('not-configured', '云函数未配置成员白名单（MC_APPID/MC_FAMILY_ID/MC_MEMBER_*_OPENID）')
  }

  const isTimer = Boolean(event && (event.Type === 'Timer' || event.TriggerName))
  if (!isTimer) {
    // 手动入口只保留白名单试发——定时触发无调用者上下文，直接放行
    const caller = resolveCaller(cloud, config, event)
    if (!caller.ok) return fail(caller.code, caller.message)
    if (!event || event.action !== 'sendNow') {
      return fail('bad-action', '手动调用仅支持 {action:"sendNow"}')
    }
  }

  const templateId = process.env.MC_PUSH_TEMPLATE_ID
  if (!templateId) {
    return fail('push-template-missing', 'MC_PUSH_TEMPLATE_ID 未配置——控制台选定模板后配置再试')
  }
  if (!core || typeof core.buildPushContent !== 'function') {
    return fail('core-missing', 'shared/dailyTipCore 缺失——重新运行 assemble 组装并部署')
  }

  ensureCloud()
  const db = cloud.database()
  const pregnancy = await getDocMaybe(db, PREGNANCY, `${config.familyId}:pregnancy`)
  const lmp = (pregnancy && pregnancy.fields && pregnancy.fields.lmpDate) || ''
  const nextCheckup = await earliestPendingCheckup(db, config.familyId)

  const content = core.buildPushContent({
    today: todayKey(),
    lmp,
    nextCheckupDate: nextCheckup ? nextCheckup.dateKey : null
  })
  if (!content) {
    return fail('no-pregnancy-profile', '家庭档案缺末次月经（mc_pregnancy.lmpDate）——推送需要孕期资料')
  }

  const results = []
  for (const member of config.members) {
    results.push(await sendToMember(member, templateId, content))
  }

  // 日志只留定位字段：入口类型/孕周/每成员结果——不落 lmp/文案私人内容
  console.log('[mc-daily-push]', JSON.stringify({
    kind: isTimer ? 'timer' : 'sendNow',
    week: content.week,
    results: results.map(r => ({ member: r.member, sent: r.sent, skipped: r.skipped || null }))
  }))

  return ok({ results, week: content.week })
}
