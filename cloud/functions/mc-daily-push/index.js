'use strict'

// mc-daily-push：每日提醒推送（2026-09 方案落地；2026-10-01 R1 入口身份修复；
// 2026-10-01 晚定时热修——R1 期"定时一律禁用"的结论按官方证据纠正，见下）。
//
// 入口契约（R1 + 定时热修后，A01–A03）：
// - 手动试发 {action:'sendNow'}（可带 kind:'eve' 试前夜文案）：仅限家庭成员白名单
//   （resolveCaller 可信上下文）；kind 语义只在认证后生效。
// - **定时触发（热修恢复）**：官方判定 = 每次调用同步读取 SDK 的 getWXContext()，
//   其 SOURCE 字段**精确等于 'wx_trigger'** 才是云函数定时触发器调用（官方文档
//   triggers 页原文："可以通过 getWXContext().SOURCE === 'wx_trigger' 判断调用来源
//   是触发器"；证据存档 /tmp/momcare-timer-hotfix-20261001/ 与 TIMER_HOTFIX_TASK.md）。
//   R1 期以"SDK 内部经 process.env 实现"推断来源不可信而全部禁用——该推断过度，
//   已纠正：SOURCE 是平台对**本次调用**的来源声明，官方明确以精确相等判定定时；
//   SDK 实现细节不推翻平台 API 契约。仍然不做 includes/前缀/逗号链宽松匹配
//   （链式调用如 'wx_client,scf' 不算定时）；不缓存、不从 event/process.env 拼造
//   身份；getWXContext 读取失败/来源缺失不授予定时权。
//   可信定时来源下，event.TriggerName 只选择业务语义（不授予身份）：daily-reminder
//   =日常、checkup-eve-reminder=前夜；event.kind/action 不改变定时语义；未知名称/
//   畸形事件/矛盾 action 在读库与发送前明确拒绝。
// - 非定时来源（wx_client / wx_client,scf / wx_devtools / wx_http / wx_unknown /
//   scf / 缺失 / 读取失败）：event 是不可信业务输入，Type/TriggerName/SOURCE 等
//   字段一律不构成授权（伪造 timer 零权限），唯一放行 = 白名单 sendNow。
//
// 数据与内容：
// - 孕周/文案全部来自共用核心单源 shared/dailyTipCore（assemble 从 utils/dailyTipCore.js
//   转译投放，与客户端同一份字节）；产检查 mc_checkups pending（滤墓碑）。
// - 日期一律上海时区（A10），且**每次调用取一个时钟快照**推导 today/tomorrow——
//   构建内容、匹配明日、回复 dateKey 全部使用同一日历日，不因执行跨上海午夜漂移。
// - 前夜提醒（A09）：dateKey=明日 条件**下推到查询**，精确匹配"明天"的有效 pending
//   产检并全量遍历该页内墓碑——过期 overdue 不参与、不遮蔽明日记录；明日无有效
//   记录安静退出。
// - 产检查询（A10）：sortKey 升序稳定分页（mc-schedule 写入 sortKey=dateKey:id，
//   dateKey 恒为 10 字符 YYYY-MM-DD，故 sortKey 序==dateKey 序）。**完整性契约**：
//   扫描中遇到任何缺 sortKey 的 pending 记录即明确失败（checkup-scan-unstable）——
//   游标 sortKey>last 永远无法覆盖无 sortKey 行，绝不以合成游标假装兼容、绝不
//   静默漏读（R1 审核第 1/2 条）。
// - 数据库读取异常如实失败（pregnancy-read-failed / checkup-query-failed），
//   绝不装作"明天无产检"。
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

// ── 上海日期（A10）：全部由单一时钟快照推导，跨午夜不漂移（R1 审核第 3 条）──
const SHANGHAI_OFFSET_MIN = 8 * 60
function shanghaiParts(ms) {
  const sh = new Date(ms + (SHANGHAI_OFFSET_MIN + new Date(ms).getTimezoneOffset()) * 60000)
  const pad = n => String(n).padStart(2, '0')
  return {
    today: `${sh.getFullYear()}-${pad(sh.getMonth() + 1)}-${pad(sh.getDate())}`,
    y: sh.getFullYear(), m: sh.getMonth(), d: sh.getDate()
  }
}
// 一次调用的时间快照 → 同一提醒全程使用的 today/tomorrow
function dateSnapshot(nowMs) {
  const p = shanghaiParts(nowMs)
  const t = new Date(p.y, p.m, p.d + 1)
  const pad = n => String(n).padStart(2, '0')
  return { today: p.today, tomorrow: `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}` }
}

// 模板 571 date4 为 date 类型——微信订阅消息 date 字段用中文日期格式（YYYY年M月D日）
// 入参 dateKey='YYYY-MM-DD'（日常推送=快照 today；前夜提醒=产检当日）——按分量构造，不读时钟
function chineseDate(dateKey) {
  let d = new Date()
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateKey || ''))
  if (m) d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

function buildMessageData(content, dateKey) {
  const text = content.event ? content.main : content.note
  const data = {}
  data[FIELD_CONTENT] = { value: text }
  data[FIELD_DATE] = { value: chineseDate(dateKey) }
  return data
}

async function sendToMember(member, templateId, content, dateKey) {
  try {
    await cloud.openapi.subscribeMessage.send({
      touser: member.openid,
      templateId,
      page: 'pages/index/index',
      miniprogramState: MINIPROGRAM_STATE,
      data: buildMessageData(content, dateKey)
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

// ── 产检查询（A09/A10，R1 审核第 1/2 条修正）──
// base 过滤可含 dateKey 精确下推（前夜用）；sortKey 升序游标分页遍历墓碑。
// 完整性契约：遇到缺 sortKey 的 pending 行立即明确失败——sortKey>cursor 无法覆盖
// 无 sortKey 行，任何"合成游标兼容"都是假话。fail = {code:'checkup-scan-unstable'}。
const CHECKUP_PAGE = 100
const CHECKUP_MAX_PAGES = 20
async function walkPendingCheckups(db, base, visit) {
  let cursor = null
  for (let pages = 0; pages < CHECKUP_MAX_PAGES; pages++) {
    const where = cursor
      ? { ...base, sortKey: db.command.gt(cursor) }
      : { ...base }
    const res = await db.collection(CHECKUPS).where(where).orderBy('sortKey', 'asc').limit(CHECKUP_PAGE).get()
    const rows = (res && res.data) || []
    for (const r of rows) {
      if (!r || typeof r.sortKey !== 'string' || !r.sortKey) {
        // 旧/异常记录缺 sortKey：无法保证稳定唯一序与完整扫描——明确失败，不静默漏读
        return { ok: false, code: 'checkup-scan-unstable', detail: { dateKey: r && r.dateKey } }
      }
      if (!r.deleted && r.dateKey && visit(r)) return { ok: true }
    }
    if (rows.length < CHECKUP_PAGE) return { ok: true }
    cursor = rows[rows.length - 1].sortKey
  }
  return { ok: false, code: 'checkup-scan-overflow' }
}

// 最早一条有效 pending（滤墓碑，dateKey 升序取首）——与客户端 index.vue nextCheckup
// 同口径；buildPushContent 内部决定"过期≤14天/≤7天倒计时/忽略远期"
async function earliestPendingCheckup(db, familyId) {
  let found = null
  const r = await walkPendingCheckups(db, { familyId, status: 'pending' }, row => { found = row; return true })
  if (!r.ok) return r
  return { ok: true, row: found }
}

// 前夜用（A09）：dateKey=明日 下推到查询——只扫描明日行（全遍历该日墓碑），
// 不依赖排序做提前终止，过期 overdue 天然不参与
async function pendingCheckupOnDate(db, familyId, dateKey) {
  let found = null
  const r = await walkPendingCheckups(db, { familyId, status: 'pending', dateKey }, row => { found = row; return true })
  if (!r.ok) return r
  return { ok: true, row: found }
}

exports.main = async function main(event) {
  const config = loadServerConfig()
  if (!config.configured) {
    return fail('not-configured', '云函数未配置成员白名单（MC_APPID/MC_FAMILY_ID/MC_MEMBER_*_OPENID）')
  }

  // 入口身份分流（A01–A03 + 2026-10-01 定时热修）：
  // 每次调用同步读取 SDK 当前上下文（官方注意事项：须在 exports.main 内读取，此时
  // 才有本次调用上下文；不缓存跨请求、不从 event/process.env 拼造）。SOURCE 为官方
  // "本次调用来源"枚举字段——**精确等于 'wx_trigger'** 才进入定时分支（官方判定）；
  // 其余一切来源（含来源缺失/读取失败/链式逗号值）都走白名单手动路径。
  let ctx = null
  try {
    ctx = cloud && typeof cloud.getWXContext === 'function' ? cloud.getWXContext() : null
  } catch (e) {
    ctx = null
  }
  const source = ctx && typeof ctx.SOURCE === 'string' ? ctx.SOURCE : ''
  const isTimerCall = source === 'wx_trigger'

  let isEve
  let kind
  if (isTimerCall) {
    // 可信定时来源（身份已由 SOURCE 证明）。TriggerName 只选择业务语义——不授予
    // 身份；官方定时 payload（腾讯云文档 583/9708）含 Type/TriggerName/Time/Message，
    // 除 TriggerName 外不要求任何其他字段（勿臆造必需字段导致真定时被拒）。
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      return fail('timer-malformed-event', '定时事件格式畸形（非对象）——本次推送中止')
    }
    if (event.action === 'sendNow') {
      // 官方定时负载不含 action——定时来源携带 action 属矛盾输入（疑似伪造残留），拒绝
      return fail('timer-malformed-event', '定时负载携带 action（矛盾输入）——本次推送中止')
    }
    const triggerName = typeof event.TriggerName === 'string' ? event.TriggerName : ''
    if (!triggerName) {
      return fail('timer-malformed-event', '定时事件缺少 TriggerName（官方 payload 必含）——本次推送中止')
    }
    if (triggerName === 'daily-reminder') {
      isEve = false
    } else if (triggerName === 'checkup-eve-reminder') {
      isEve = true
    } else {
      return fail('timer-unknown-trigger', `未配置的定时触发器名称：${triggerName}（允许 daily-reminder / checkup-eve-reminder）——本次推送中止`)
    }
    // 定时语义下 event.kind 无效（不能把日常变前夜）
    kind = isEve ? 'timer-eve' : 'timer-daily'
  } else {
    // 非定时来源：唯一放行 = 家庭成员白名单认证 + {action:'sendNow'}（A01–A03）。
    // event 的 Type/TriggerName/SOURCE/kind 均不构成授权；伪造 timer 零权限、零语义。
    const caller = resolveCaller(cloud, config, event)
    if (!caller.ok) return fail(caller.code, caller.message)
    if (!event || event.action !== 'sendNow') {
      return fail('bad-action', '手动调用仅支持 {action:"sendNow"}')
    }
    // 手动试发用 kind:'eve' 试前夜文案（TriggerName 不参与手动语义判定）
    isEve = event.kind === 'eve'
    kind = isEve ? 'sendNow-eve' : 'sendNow'
  }

  const templateId = process.env.MC_PUSH_TEMPLATE_ID
  if (!templateId) {
    return fail('push-template-missing', 'MC_PUSH_TEMPLATE_ID 未配置——控制台选定模板后配置再试')
  }
  if (!core || typeof core.buildPushContent !== 'function' || typeof core.buildEveReminder !== 'function') {
    return fail('core-missing', 'shared/dailyTipCore 缺失（或不完整）——重新运行 assemble 组装并部署')
  }

  // 单一时钟快照：本次调用全程（内容构建/明日匹配/回复日期）使用同一 today/tomorrow
  const snap = dateSnapshot(Date.now())
  const today = snap.today
  const tomorrow = snap.tomorrow

  ensureCloud()
  const db = cloud.database()

  let pregnancy
  try {
    const res = await db.collection(PREGNANCY).doc(`${config.familyId}:pregnancy`).get()
    pregnancy = (res && res.data) || null
  } catch (e) {
    // 读档异常 ≠ 无档案（A10 同则：数据库失败不装作缺数据）
    return fail('pregnancy-read-failed', '孕期档案读取失败，本次推送中止', {
      errMsg: String((e && (e.errMsg || e.message)) || e).slice(0, 200)
    })
  }
  const lmp = (pregnancy && pregnancy.fields && pregnancy.fields.lmpDate) || ''
  if (!lmp) {
    return fail('no-pregnancy-profile', '家庭档案缺末次月经（mc_pregnancy.lmpDate）——推送需要孕期资料')
  }

  let lookup
  try {
    lookup = isEve
      ? await pendingCheckupOnDate(db, config.familyId, tomorrow)
      : await earliestPendingCheckup(db, config.familyId)
  } catch (e) {
    // 数据库异常如实失败——绝不装作"明天无产检"安静跳过（A10）
    return fail('checkup-query-failed', '产检数据读取失败，本次推送中止（不装作无产检）', {
      errMsg: String((e && (e.errMsg || e.message)) || e).slice(0, 200)
    })
  }
  if (!lookup.ok) {
    return fail(lookup.code, lookup.code === 'checkup-scan-unstable'
      ? '产检记录存在缺 sortKey 的旧数据，分页遍历无法保证完整——本次推送中止（需先修复数据）'
      : '产检数据遍历超限，本次推送中止')
  }
  const nextCheckup = lookup.row

  let content, dateKey
  if (isEve) {
    content = core.buildEveReminder({
      today,
      lmp,
      nextCheckupDate: nextCheckup ? nextCheckup.dateKey : null
    })
    if (!content) {
      // 明天没有 pending 产检——前夜触发器安静退出（设计内，非错误）
      console.log('[mc-daily-push]', JSON.stringify({ kind, skipped: 'no-checkup-tomorrow' }))
      return ok({ skipped: 'no-checkup-tomorrow', results: [] })
    }
    dateKey = nextCheckup.dateKey
  } else {
    content = core.buildPushContent({
      today,
      lmp,
      nextCheckupDate: nextCheckup ? nextCheckup.dateKey : null
    })
    if (!content) {
      return fail('no-pregnancy-profile', '推送内容构建失败——孕期资料异常')
    }
    dateKey = today
  }

  const results = []
  for (const member of config.members) {
    results.push(await sendToMember(member, templateId, content, dateKey))
  }

  // 日志只留定位字段：入口类型/孕周/每成员结果——不落 lmp/文案私人内容
  console.log('[mc-daily-push]', JSON.stringify({
    kind,
    results: results.map(r => ({ member: r.member, sent: r.sent, skipped: r.skipped || null }))
  }))

  return ok({ results, dateKey })
}
