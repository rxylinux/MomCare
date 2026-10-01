// 定时推送热修回归（2026-10-01 晚，TIMER_HOTFIX_TASK）：
// 官方判定 getWXContext().SOURCE === 'wx_trigger'（精确相等）→ 定时分支；
// TriggerName 只选语义（daily-reminder=日常 / checkup-eve-reminder=前夜）；
// 其余一切来源（含链式逗号值、event 伪造字段、读取失败、缺失）仍白名单 sendNow。
// 覆盖：修复后正向业务（真实发送计数+内容）、畸形/未知触发器零业务、跨来源伪造
// 零授权、同一 handler 连续调用不借上次快照、手动路径保持、定时路径走同一分页管线。
// 修复前症状（wx_trigger 被拒）已在冻结 handler 上单独复现存档：
// /tmp/momcare-timer-hotfix-20261001/zcode-logs/repro-prefix-symptom.log。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-timer-hotfix-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }

// ── DIST：真实 handler（镜像 assemble 投放）──
const DIST = path.join(temp, 'cf', 'mc-daily-push')
{
  fs.mkdirSync(path.join(DIST, 'shared'), { recursive: true })
  fs.copyFileSync(path.join(root, 'cloud/functions/mc-daily-push/index.js'), path.join(DIST, 'index.js'))
  fs.cpSync(path.join(root, 'cloud/shared'), path.join(DIST, 'shared'), { recursive: true })
  esbuild.buildSync({
    entryPoints: [path.join(root, 'utils/dailyTipCore.js')],
    bundle: true, platform: 'node', format: 'cjs',
    outfile: path.join(DIST, 'shared', 'dailyTipCore.js'), logLevel: 'silent'
  })
}
function requireHandler() {
  delete require.cache[require.resolve(path.join(DIST, 'index.js'))]
  delete require.cache[require.resolve(path.join(DIST, 'shared/dailyTipCore.js'))]
  return require(path.join(DIST, 'index.js'))
}

const TEST_ENV = {
  MC_APPID: 'wxtimerhotfix0001', MC_FAMILY_ID: 'fam-timer-hf',
  MC_MEMBER_MAMA_OPENID: 'oTHFMAMA000000001', MC_MEMBER_PAPA_OPENID: 'oTHFPAPA000000001'
}
const TPL_ID = 'TPL_TIMER_HOTFIX'
function withEnv() {
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  process.env.MC_PUSH_TEMPLATE_ID = TPL_ID
}

// 上海日期工具（与生产同式）
const SH_OFFSET_MIN = 8 * 60
function shanghaiNowParts() {
  const ms = Date.now()
  const sh = new Date(ms + (SH_OFFSET_MIN + new Date(ms).getTimezoneOffset()) * 60000)
  return sh
}
const pad = n => String(n).padStart(2, '0')
function keyOfSh(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
function shDay(n) { const d = shanghaiNowParts(); return keyOfSh(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)) }
function chineseOf(k) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k); return `${m[1]}年${Number(m[2])}月${Number(m[3])}日` }
const LMP = shDay(-40)

// mock 云：SOURCE/OPENID 每次 getWXContext 可变（可编程序列）；真实 where/orderBy/limit
// + sortKey 游标语义 + gt；缺 sortKey 行按 null 排最前（保守假设，与 r1-push 同注明）。
function makeMockCloud({ checkups = [], lmp = LMP } = {}) {
  const sends = []
  const counters = { checkupQueries: 0, pregnancyReads: 0 }
  // 每次 getWXContext() 调用弹出序列中下一个；序列空则用 last
  const ctxSeq = []
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'dynamic-env',
    init: () => {},
    getWXContext: () => {
      if (ctxSeq.length > 0) return ctxSeq.shift()
      return cloud.__lastCtx || {}
    },
    __lastCtx: {},
    __nextCtx(ctx) { cloud.__lastCtx = ctx; return cloud },
    __pushCtx(ctx) { ctxSeq.push(ctx); return cloud },
    database: () => db,
    openapi: { subscribeMessage: { send: async m => { sends.push(m) } } }
  }
  const clone = x => JSON.parse(JSON.stringify(x))
  const pregDoc = lmp ? { fields: { lmpDate: lmp } } : null
  const sk = r => (r.sortKey === undefined || r.sortKey === null ? null : String(r.sortKey))
  const cmpSk = (a, b) => {
    const x = sk(a); const y = sk(b)
    if (x === y) return 0
    if (x === null) return -1
    if (y === null) return 1
    return x < y ? -1 : 1
  }
  const db = {
    command: { gt: v => ({ __op: 'gt', v }) },
    collection(name) {
      if (name === 'mc_pregnancy') {
        return { doc: () => ({ get: async () => { counters.pregnancyReads++; return { data: pregDoc } } }) }
      }
      if (name === 'mc_checkups') {
        return {
          where: filters => ({
            orderBy: () => ({
              limit: n => ({
                get: async () => {
                  counters.checkupQueries++
                  let rows = checkups.filter(r => {
                    for (const [k, v] of Object.entries(filters)) {
                      if (v && typeof v === 'object' && v.__op === 'gt') {
                        if (r[k] === undefined || r[k] === null) return false
                        if (!(String(r[k]) > String(v.v))) return false
                      } else if (String(r[k]) !== String(v)) return false
                    }
                    return true
                  })
                  rows.sort(cmpSk)
                  return { data: clone(rows.slice(0, n)) }
                }
              })
            })
          })
        }
      }
      return { where: () => ({ orderBy: () => ({ limit: () => ({ get: async () => ({ data: [] }) }) }) }) }
    }
  }
  return { cloud, sends, counters }
}
const pending = (dateKey, id, extra = {}) => ({
  familyId: TEST_ENV.MC_FAMILY_ID, status: 'pending', dateKey,
  sortKey: `${dateKey}:${id || Math.random().toString(36).slice(2, 8)}`,
  ...extra
})
// 官方定时 payload（腾讯云 583/9708：Type/TriggerName/Time/Message）
const timerEvent = (name, extra = {}) => ({
  Type: 'Timer', TriggerName: name, Time: new Date().toISOString(), Message: '', ...extra
})

async function main() {
  console.log('定时推送热修回归（官方 SOURCE=wx_trigger 判定 + TriggerName 语义白名单 + 全来源伪造拒绝）\n')
  withEnv()

  await scenario('H1 正向·官方定时日常（无 OpenID）：真实发送 2 条、日常文案、dateKey=今天', async () => {
    const { cloud, sends, counters } = makeMockCloud({ checkups: [pending(shDay(3), 'hf-d1')] })
    cloud.__nextCtx({ SOURCE: 'wx_trigger' }) // 官方定时上下文：无 OPENID/APPID
    const fn = requireHandler(); fn.__setCloud(cloud)
    const res = await fn.main(timerEvent('daily-reminder'))
    assert.equal(res.ok, true, `实得 ${JSON.stringify(res).slice(0, 160)}`)
    assert.equal(sends.length, 2, '两位成员各一条')
    assert.ok(!sends[0].data.thing11.value.includes('明天产检'), `日常文案（实得 ${sends[0].data.thing11.value}）`)
    assert.equal(res.data.dateKey, shDay(0), 'daily dateKey=快照 today')
    assert.ok(counters.pregnancyReads >= 1 && counters.checkupQueries >= 1, '真实读库发生（业务已执行）')
  })

  await scenario('H2 正向·官方定时的前夜（明日有效产检）：发送 2 条"明天产检"、date4=明日', async () => {
    const tomorrow = shDay(1)
    const { cloud, sends } = makeMockCloud({ checkups: [pending(shDay(-2), 'hf-over'), pending(tomorrow, 'hf-tom')] })
    cloud.__nextCtx({ SOURCE: 'wx_trigger' })
    const fn = requireHandler(); fn.__setCloud(cloud)
    const res = await fn.main(timerEvent('checkup-eve-reminder'))
    assert.equal(res.ok, true, `实得 ${JSON.stringify(res).slice(0, 160)}`)
    assert.equal(sends.length, 2)
    assert.ok(sends[0].data.thing11.value.includes('明天产检'), sends[0].data.thing11.value)
    assert.equal(sends[0].data.date4.value, chineseOf(tomorrow), 'date4=产检当日（明日）')
  })

  await scenario('H3 正向·前夜无明日记录：安静跳过（skipped）、零发送', async () => {
    const { cloud, sends } = makeMockCloud({ checkups: [pending(shDay(-1), 'hf-only-over'), pending(shDay(2), 'hf-dayafter')] })
    cloud.__nextCtx({ SOURCE: 'wx_trigger' })
    const fn = requireHandler(); fn.__setCloud(cloud)
    const res = await fn.main(timerEvent('checkup-eve-reminder'))
    assert.equal(res.ok, true)
    assert.equal(res.data.skipped, 'no-checkup-tomorrow')
    assert.equal(sends.length, 0)
  })

  await scenario('H4 定时语义锁定：event.kind 不能把定时日常变前夜；两名称各归其义', async () => {
    const tomorrow = shDay(1)
    // daily-reminder + kind:'eve' → 仍是日常
    {
      const { cloud, sends } = makeMockCloud({ checkups: [pending(tomorrow, 'hf-lock1')] })
      cloud.__nextCtx({ SOURCE: 'wx_trigger' })
      const fn = requireHandler(); fn.__setCloud(cloud)
      const res = await fn.main(timerEvent('daily-reminder', { kind: 'eve' }))
      assert.equal(res.ok, true)
      assert.equal(res.data.dateKey, shDay(0), 'kind 不改定时语义：仍日常')
      assert.ok(!sends[0].data.thing11.value.includes('明天产检'))
    }
    // checkup-eve-reminder + kind:'daily' → 仍是前夜
    {
      const { cloud, sends } = makeMockCloud({ checkups: [pending(tomorrow, 'hf-lock2')] })
      cloud.__nextCtx({ SOURCE: 'wx_trigger' })
      const fn = requireHandler(); fn.__setCloud(cloud)
      const res = await fn.main(timerEvent('checkup-eve-reminder', { kind: 'daily' }))
      assert.equal(res.ok, true)
      assert.ok(sends[0].data.thing11.value.includes('明天产检'), 'kind 不改定时语义：仍前夜')
    }
  })

  await scenario('H5 定时畸形/未知触发器：非对象/缺 TriggerName/矛盾 action/未知名称——读库与发送前拒绝', async () => {
    const cases = [
      ['null 事件', null, 'timer-malformed-event'],
      ['数组事件', [{ TriggerName: 'daily-reminder' }], 'timer-malformed-event'],
      ['字符串事件', 'daily-reminder', 'timer-malformed-event'],
      ['缺 TriggerName', { Type: 'Timer', Time: new Date().toISOString() }, 'timer-malformed-event'],
      ['TriggerName 非串', { Type: 'Timer', TriggerName: 42 }, 'timer-malformed-event'],
      ['矛盾 action', timerEvent('daily-reminder', { action: 'sendNow' }), 'timer-malformed-event'],
      ['未知名称', timerEvent('evil-trigger'), 'timer-unknown-trigger'],
      ['未知名称（近似前缀）', timerEvent('daily-reminder-2'), 'timer-unknown-trigger'],
    ]
    for (const [name, ev, expectCode] of cases) {
      const { cloud, sends, counters } = makeMockCloud({ checkups: [pending(shDay(1), 'hf-mal')] })
      cloud.__nextCtx({ SOURCE: 'wx_trigger' })
      const fn = requireHandler(); fn.__setCloud(cloud)
      const res = await fn.main(ev)
      assert.equal(res.ok, false, `${name} 应拒绝`)
      assert.equal(res.code, expectCode, `${name}：受控码（实得 ${res.code}）`)
      assert.equal(sends.length, 0, `${name}：零发送`)
      assert.equal(counters.pregnancyReads, 0, `${name}：拒绝先于读 pregnancy`)
      assert.equal(counters.checkupQueries, 0, `${name}：拒绝先于查 checkups`)
    }
  })

  await scenario('H6 跨来源伪造：非 wx_trigger 来源携带完整 timer 字段/event.SOURCE/event 嵌 getWXContext——零授权零业务', async () => {
    const forgedSources = ['wx_client', 'wx_client,scf', 'wx_devtools', 'wx_http', 'wx_unknown', 'scf', 'wx_localdebug', 'wx_trigger2', ' wx_trigger', 'wx_trigger ', 'wxtrigger', 'WX_TRIGGER', 'wx_trigger,scf', '']
    const forgedEvent = {
      ...timerEvent('daily-reminder'),
      SOURCE: 'wx_trigger',                    // event 上的 SOURCE 伪造
      Type: 'Timer', TriggerName: 'daily-reminder',
      getWXContext: () => ({ SOURCE: 'wx_trigger' }), // event 嵌 SDK 对象冒充
      context: { SOURCE: 'wx_trigger' },
      OPENID: TEST_ENV.MC_MEMBER_MAMA_OPENID,   // 客户端自报身份
      userInfo: { openid: TEST_ENV.MC_MEMBER_MAMA_OPENID },
      action: 'sendNow'
    }
    for (const src of forgedSources) {
      const { cloud, sends, counters } = makeMockCloud({ checkups: [pending(shDay(1), 'hf-forge')] })
      // 来源字段给伪造值；无成员 OpenID（伪造身份只能走 event 字段——必须无效）
      cloud.__nextCtx(src === '' ? {} : { SOURCE: src })
      const fn = requireHandler(); fn.__setCloud(cloud)
      const res = await fn.main(forgedEvent)
      assert.equal(res.ok, false, `SOURCE='${src}' 不得放行`)
      assert.equal(sends.length, 0, `SOURCE='${src}' 零发送`)
      assert.equal(counters.pregnancyReads, 0, `SOURCE='${src}' 零读库`)
    }
    // getWXContext 抛异常 → 同样无定时权（走白名单→无 OpenID 拒绝）
    {
      const { cloud, sends } = makeMockCloud({ checkups: [pending(shDay(1), 'hf-throw')] })
      const fn = requireHandler(); fn.__setCloud(cloud)
      cloud.getWXContext = () => { throw new Error('ctx unavailable') }
      const res = await fn.main(timerEvent('daily-reminder'))
      assert.equal(res.ok, false, '读取失败不授予定时权')
      assert.equal(res.code, 'unauthenticated')
      assert.equal(sends.length, 0)
    }
  })

  await scenario('H7 白名单手动路径保持：sendNow 日常/前夜照常（认证后才放行）', async () => {
    const tomorrow = shDay(1)
    // 日常
    {
      const { cloud, sends } = makeMockCloud({ checkups: [pending(shDay(5), 'hf-man1')] })
      cloud.__nextCtx({ SOURCE: 'wx_client', OPENID: TEST_ENV.MC_MEMBER_MAMA_OPENID, APPID: TEST_ENV.MC_APPID })
      const fn = requireHandler(); fn.__setCloud(cloud)
      const res = await fn.main({ action: 'sendNow' })
      assert.equal(res.ok, true, `手动日常（实得 ${JSON.stringify(res).slice(0, 120)}）`)
      assert.equal(sends.length, 2)
      assert.equal(res.data.dateKey, shDay(0))
    }
    // 前夜（kind:'eve'）
    {
      const { cloud, sends } = makeMockCloud({ checkups: [pending(tomorrow, 'hf-man2')] })
      cloud.__nextCtx({ SOURCE: 'wx_client', OPENID: TEST_ENV.MC_MEMBER_PAPA_OPENID, APPID: TEST_ENV.MC_APPID })
      const fn = requireHandler(); fn.__setCloud(cloud)
      const res = await fn.main({ action: 'sendNow', kind: 'eve' })
      assert.equal(res.ok, true)
      assert.equal(sends.length, 2)
      assert.ok(sends[0].data.thing11.value.includes('明天产检'))
    }
    // 手动路径 TriggerName 仍不参与语义（伪造不变前夜）——R1 契约保持
    {
      const { cloud, sends } = makeMockCloud({ checkups: [pending(tomorrow, 'hf-man3')] })
      cloud.__nextCtx({ SOURCE: 'wx_client', OPENID: TEST_ENV.MC_MEMBER_MAMA_OPENID, APPID: TEST_ENV.MC_APPID })
      const fn = requireHandler(); fn.__setCloud(cloud)
      const res = await fn.main({ action: 'sendNow', TriggerName: 'checkup-eve-reminder', Type: 'Timer' })
      assert.equal(res.ok, true)
      assert.ok(!sends[0].data.thing11.value.includes('明天产检'), '手动路径 TriggerName 不改语义')
    }
    // 未认证 sendNow 仍拒
    {
      const { cloud, sends } = makeMockCloud()
      cloud.__nextCtx({ SOURCE: 'wx_client', OPENID: 'oTHFOUTSIDER0001', APPID: TEST_ENV.MC_APPID })
      const fn = requireHandler(); fn.__setCloud(cloud)
      assert.equal((await fn.main({ action: 'sendNow' })).code, 'not-family-member')
      assert.equal(sends.length, 0)
    }
  })

  await scenario('H8 同一 handler 连续调用 timer→client→timer→伪造：SOURCE 每次即时判定，不借上次快照', async () => {
    const tomorrow = shDay(1)
    const { cloud, sends } = makeMockCloud({ checkups: [pending(tomorrow, 'hf-seq')] })
    const fn = requireHandler(); fn.__setCloud(cloud)
    // ① timer daily
    cloud.__nextCtx({ SOURCE: 'wx_trigger' })
    const r1 = await fn.main(timerEvent('daily-reminder'))
    assert.equal(r1.ok, true)
    assert.equal(r1.data.dateKey, shDay(0), '① timer=日常')
    // ② client 手动前夜（SOURCE 变化即时生效）
    cloud.__nextCtx({ SOURCE: 'wx_client', OPENID: TEST_ENV.MC_MEMBER_MAMA_OPENID, APPID: TEST_ENV.MC_APPID })
    const r2 = await fn.main({ action: 'sendNow', kind: 'eve' })
    assert.equal(r2.ok, true)
    // ③ timer eve（再回定时——不残留 ② 的客户端身份）
    cloud.__nextCtx({ SOURCE: 'wx_trigger' })
    const r3 = await fn.main(timerEvent('checkup-eve-reminder'))
    assert.equal(r3.ok, true)
    // ④ 伪造 wx_client,scf + timer 字段 → 拒
    cloud.__nextCtx({ SOURCE: 'wx_client,scf' })
    const r4 = await fn.main(timerEvent('daily-reminder'))
    assert.equal(r4.ok, false)
    assert.equal(sends.length, 6, `①②③ 各 2 条，④ 零发送（实得 ${sends.length}）`)
    // ⑤ 无 SOURCE（缺失）→ 拒
    cloud.__nextCtx({})
    const r5 = await fn.main(timerEvent('daily-reminder'))
    assert.equal(r5.ok, false)
    assert.equal(sends.length, 6)
  })

  await scenario('H9 定时路径走同一分页管线：252 条历史墓碑长前缀 + 昨日 overdue——定时的日常仍选最早有效', async () => {
    const rows = []
    for (let i = 260; i >= 9; i--) rows.push(pending(shDay(-i), `hf-tomb-${String(i).padStart(4, '0')}`, { deleted: true }))
    rows.push(pending(shDay(4), 'hf-future'))
    rows.push(pending(shDay(-1), 'hf-over-1d'))
    for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]] }
    const { cloud, sends, counters } = makeMockCloud({ checkups: rows })
    cloud.__nextCtx({ SOURCE: 'wx_trigger' })
    const fn = requireHandler(); fn.__setCloud(cloud)
    const res = await fn.main(timerEvent('daily-reminder'))
    assert.equal(res.ok, true)
    assert.equal(sends.length, 2)
    assert.ok(sends[0].data.thing11.value.includes('产检已过1天'), `最早=昨日 overdue（实得 ${sends[0].data.thing11.value}）`)
    assert.ok(counters.checkupQueries >= 3, `定时路径真翻页（实得 ${counters.checkupQueries}）`)
  })

  await scenario('H10 定时路径 DB 异常/未配置语义保持：checkup-query-failed / not-configured 可区分', async () => {
    // DB 异常：checkups 查询抛错（经 mock where.get 抛出）
    {
      const { cloud, sends } = makeMockCloud()
      const origGet = cloud.database().collection('mc_checkups').where({}).orderBy().limit
      void origGet
      const db = cloud.database()
      db.collection = name => {
        if (name === 'mc_pregnancy') return { doc: () => ({ get: async () => ({ data: { fields: { lmpDate: LMP } } }) }) }
        if (name === 'mc_checkups') return { where: () => ({ orderBy: () => ({ limit: () => ({ get: async () => { const e = new Error('db down'); e.errMsg = 'connection refused'; throw e } }) }) }) }
        return { where: () => ({ orderBy: () => ({ limit: () => ({ get: async () => ({ data: [] }) }) }) }) }
      }
      cloud.__nextCtx({ SOURCE: 'wx_trigger' })
      const fn = requireHandler(); fn.__setCloud(cloud)
      const res = await fn.main(timerEvent('checkup-eve-reminder'))
      assert.equal(res.ok, false, 'DB 失败不得装作明天无产检')
      assert.equal(res.code, 'checkup-query-failed')
      assert.equal(sends.length, 0)
    }
    // 定时来源不绕过白名单配置检查（未配置 → not-configured）
    {
      const { cloud } = makeMockCloud()
      delete process.env.MC_APPID
      try {
        cloud.__nextCtx({ SOURCE: 'wx_trigger' })
        const fn = requireHandler(); fn.__setCloud(cloud)
        const res = await fn.main(timerEvent('daily-reminder'))
        assert.equal(res.ok, false)
        assert.equal(res.code, 'not-configured', '定时来源也要有业务配置')
      } finally { withEnv() }
    }
  })

  console.log(`\nphase-timer-hotfix：${passed} 通过，${failed.length} 失败`)
  if (failed.length > 0) { console.log('失败场景：', failed.join(' | ')); process.exit(1) }
}

main().catch(e => { console.error('套件异常:', e); process.exit(2) })
