// R1 推送入口回归（2026-10-01 修复，A01–A03 + A09/A10 + 审核第 1/2/3 条）：
// - 唯一放行路径 = 家庭成员白名单 sendNow；Type/TriggerName 伪造 timer 零授权零语义；
//   非定时来源一律白名单（伪造 timer 在读库/外呼前被拒；2026-10-01 定时热修后
//   官方 SOURCE==='wx_trigger' 定时入口已恢复——正向与伪造矩阵见 phase-timer-hotfix）；
// - 前夜精确匹配"明日有效 pending"（dateKey 下推查询）：过期 overdue 不遮蔽、
//   无明日记录安静跳过；
// - sortKey 升序游标分页遍历墓碑（>100 条同页掩埋仍可读到）；缺 sortKey 的旧记录
//   明确失败（checkup-scan-unstable），不静默漏读、不用合成游标假装兼容；
// - DB 异常如实失败（checkup-query-failed / pregnancy-read-failed），不装无产检；
// - 日期单一时钟快照（上海时区）：冻结 Date.now 验证 today/tomorrow 跨午夜一致。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-r1p-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }

// ── 云函数 DIST：函数 + shared + 转译核心（镜像 assemble 投放，与 phase-n 同手法）──
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
  MC_APPID: 'wxtestappid0001',
  MC_FAMILY_ID: 'fam-r1p',
  MC_MEMBER_MAMA_OPENID: 'oR1PMAMA1234567',
  MC_MEMBER_PAPA_OPENID: 'oR1PPAPA1234567'
}
const TPL_ID = 'TPL_R1_PUSH_TEST'

function withEnv(extra = {}) {
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  process.env.MC_PUSH_TEMPLATE_ID = TPL_ID
  for (const [k, v] of Object.entries(extra)) process.env[k] = v
}

// ── 上海日期工具（与生产同式——种子/期望不受测试机时区影响）──
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
const LMP = shDay(-33) // 孕4周+5（与 phase-n 同孕周锚）

// ── mock cloud：真实 where/orderBy/limit + sortKey 游标语义 + 计数器 + 故障注入 ──
// 缺失 sortKey 行的排序语义：按 null 处理排在字符串前（MongoDB BSON 升序 null < string，
// TCB 文档型数据库同源）。真实平台对缺失字段在 orderBy 中的确切行为未逐版验证——此处
// 保守假设"缺字段先返回"，保证升序扫描必然遇到 legacy 行（完整性契约的保守侧）。
function makeMockCloud({ callerOpenid, checkups = [], failCheckups = false, failPregnancy = false, lmp = LMP, advanceClockOnGet = null } = {}) {
  const sends = []
  const counters = { checkupQueries: 0, pregnancyReads: 0 }
  const clone = x => JSON.parse(JSON.stringify(x))
  const pregDoc = lmp ? { fields: { lmpDate: lmp } } : null
  const sk = r => (r.sortKey === undefined || r.sortKey === null ? null : String(r.sortKey))
  // 行对象比较（sort 直接传行——sk 读 row.sortKey；缺失按 null 排最前）
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
        return {
          doc: id => ({
            get: async () => {
              counters.pregnancyReads++
              if (advanceClockOnGet) advanceClockOnGet()
              if (failPregnancy) { const e = new Error('mock db down'); e.errMsg = 'database connection failed'; throw e }
              return { data: pregDoc }
            }
          })
        }
      }
      if (name === 'mc_checkups') {
        return {
          where: filters => ({
            orderBy: () => ({
              limit: n => ({
                get: async () => {
                  counters.checkupQueries++
                  if (advanceClockOnGet) advanceClockOnGet()
                  if (failCheckups) { const e = new Error('mock db down'); e.errMsg = 'database connection failed'; throw e }
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
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'dynamic-env',
    init: () => {},
    getWXContext: () => (callerOpenid ? { OPENID: callerOpenid, APPID: TEST_ENV.MC_APPID } : {}),
    database: () => db,
    openapi: { subscribeMessage: { send: async msg => { sends.push(msg) } } }
  }
  return { cloud, sends, counters }
}
const pending = (dateKey, id, extra = {}) => ({
  familyId: TEST_ENV.MC_FAMILY_ID, status: 'pending', dateKey,
  sortKey: `${dateKey}:${id || Math.random().toString(36).slice(2, 8)}`,
  ...extra
})

async function main() {
  console.log('R1 推送入口回归（A01–A03 / A09 / A10 / 审核 1–3）\n')

  await scenario('A01 伪装 timer 零授权：intruder/无上下文 + Type/TriggerName/混合 → 读库 0 次、外呼 0 次', async () => {
    withEnv()
    const forgedEvents = [
      { Type: 'Timer' },
      { TriggerName: 'daily-reminder' },
      { Type: 'Timer', TriggerName: 'checkup-eve-reminder' },
      { Type: 'Timer', TriggerName: 'daily-reminder', action: 'sendNow' },
      { action: 'sendNow', kind: 'eve', Type: 'Timer' }
    ]
    for (const caller of ['oINTRUDER999999', '']) {
      for (const ev of forgedEvents) {
        const { cloud, sends, counters } = makeMockCloud({ callerOpenid: caller })
        const fn = requireHandler(); fn.__setCloud(cloud)
        const res = await fn.main(ev)
        assert.equal(res.ok, false, `${JSON.stringify(ev)} caller=${caller || 'none'} 不应放行`)
        assert.equal(sends.length, 0, '零外呼')
        assert.equal(counters.pregnancyReads, 0, '拒绝发生在读库前（pregnancy 0 次）')
        assert.equal(counters.checkupQueries, 0, '拒绝发生在读库前（checkups 0 次）')
      }
    }
  })

  await scenario('A02 白名单 sendNow 正常；伪造 timer 不增加权限/不改变语义', async () => {
    withEnv()
    // 白名单 mama 正常试发
    {
      const { cloud, sends } = makeMockCloud({ callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID, checkups: [pending(shDay(3))] })
      const fn = requireHandler(); fn.__setCloud(cloud)
      const res = await fn.main({ action: 'sendNow' })
      assert.equal(res.ok, true, `白名单 sendNow 应放行（实得 ${JSON.stringify(res).slice(0, 120)}）`)
      assert.equal(sends.length, 2)
    }
    // 白名单成员 + 伪造 TriggerName：仍只是 sendNow——不得获得前夜语义
    {
      const tomorrow = shDay(1)
      const { cloud, sends } = makeMockCloud({ callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID, checkups: [pending(tomorrow)] })
      const fn = requireHandler(); fn.__setCloud(cloud)
      const res = await fn.main({ action: 'sendNow', TriggerName: 'checkup-eve-reminder', Type: 'Timer' })
      assert.equal(res.ok, true)
      assert.equal(sends.length, 2)
      assert.ok(!sends[0].data.thing11.value.includes('明天产检'), `伪造 TriggerName 不得触发前夜文案：${sends[0].data.thing11.value}`)
    }
    // 白名单成员 + timer 字段但无 sendNow → bad-action（timer 不构成合法 action）
    {
      const { cloud, sends } = makeMockCloud({ callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID })
      const fn = requireHandler(); fn.__setCloud(cloud)
      assert.equal((await fn.main({ Type: 'Timer', TriggerName: 'daily-reminder' })).code, 'bad-action')
      assert.equal((await fn.main({ Type: 'Timer', action: 'other' })).code, 'bad-action')
      assert.equal(sends.length, 0)
    }
    // 未认证 sendNow 拒绝
    {
      const { cloud, sends } = makeMockCloud({ callerOpenid: 'oINTRUDER999999' })
      const fn = requireHandler(); fn.__setCloud(cloud)
      assert.equal((await fn.main({ action: 'sendNow' })).code, 'not-family-member')
      assert.equal(sends.length, 0)
    }
  })

  await scenario('A03 非定时来源一律白名单拒绝：无凭据/环境残留按认证拒绝（热修后 wx_trigger 定时另有专门套件）', async () => {
    withEnv()
    // 无 SOURCE/无凭据形状（热修语境：非官方 wx_trigger 来源的 timer 字段=伪造，仍一律拒绝）
    const { cloud, sends, counters } = makeMockCloud({ callerOpenid: '' })
    const fn = requireHandler(); fn.__setCloud(cloud)
    const res = await fn.main({ Type: 'Timer', TriggerName: 'daily-reminder' })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'unauthenticated', '非 wx_trigger 来源的 timer 形状=未认证拒绝')
    assert.equal(sends.length, 0)
    assert.equal(counters.pregnancyReads, 0)
    // 上次请求遗留 process.env 不得授权：注入残留环境变量仍拒绝
    process.env.WX_CONTEXT_KEYS = 'OPENID,APPID'
    process.env.TCB_SOURCE = 'timer'
    try {
      const res2 = await fn.main({ Type: 'Timer', TriggerName: 'daily-reminder' })
      assert.equal(res2.ok, false)
      assert.equal(sends.length, 0)
    } finally {
      delete process.env.WX_CONTEXT_KEYS
      delete process.env.TCB_SOURCE
    }
  })

  await scenario('A09 前夜精确匹配明日：过期 overdue 不遮蔽；无明日记录安静跳过', async () => {
    withEnv()
    const tomorrow = shDay(1)
    // 昨日 overdue + 明日 pending 并存 → 仍发前夜提醒
    {
      const { cloud, sends } = makeMockCloud({
        callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID,
        checkups: [pending(shDay(-1)), pending(tomorrow)]
      })
      const fn = requireHandler(); fn.__setCloud(cloud)
      const res = await fn.main({ action: 'sendNow', kind: 'eve' })
      assert.equal(res.ok, true, `实得 ${JSON.stringify(res).slice(0, 150)}`)
      assert.equal(sends.length, 2)
      assert.ok(sends[0].data.thing11.value.includes('明天产检'), sends[0].data.thing11.value)
      assert.equal(sends[0].data.date4.value, chineseOf(tomorrow), '日期=产检当日')
    }
    // 只有 overdue / 只有后天 → 安静跳过（不发）
    for (const rows of [[pending(shDay(-1))], [pending(shDay(2))], []]) {
      const { cloud, sends } = makeMockCloud({ callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID, checkups: rows })
      const fn = requireHandler(); fn.__setCloud(cloud)
      const res = await fn.main({ action: 'sendNow', kind: 'eve' })
      assert.equal(res.ok, true)
      assert.equal(res.data.skipped, 'no-checkup-tomorrow', `无明日有效记录应安静跳过（实得 ${JSON.stringify(res.data)}）`)
      assert.equal(sends.length, 0)
    }
    // 明日只有墓碑（deleted）→ 不算有效记录，安静跳过
    {
      const { cloud, sends } = makeMockCloud({
        callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID,
        checkups: [pending(tomorrow, 'del-1', { deleted: true })]
      })
      const fn = requireHandler(); fn.__setCloud(cloud)
      const res = await fn.main({ action: 'sendNow', kind: 'eve' })
      assert.equal(res.data.skipped, 'no-checkup-tomorrow', '墓碑不算有效 pending')
      assert.equal(sends.length, 0)
    }
  })

  await scenario('A10 分页遍历墓碑：>100 条同日墓碑后仍有明日有效记录，前夜照发', async () => {
    withEnv()
    const tomorrow = shDay(1)
    // 250 条明日墓碑 + 1 条明日有效（有效行 sortKey 排在全部墓碑之后——第 3 页才命中）
    const rows = []
    for (let i = 0; i < 250; i++) rows.push(pending(tomorrow, `tomb-${String(i).padStart(4, '0')}`, { deleted: true }))
    rows.push(pending(tomorrow, 'zzz-live-1'))
    const { cloud, sends, counters } = makeMockCloud({ callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID, checkups: rows })
    const fn = requireHandler(); fn.__setCloud(cloud)
    const res = await fn.main({ action: 'sendNow', kind: 'eve' })
    assert.equal(res.ok, true, `实得 ${JSON.stringify(res).slice(0, 150)}`)
    assert.equal(sends.length, 2)
    assert.ok(sends[0].data.thing11.value.includes('明天产检'))
    assert.ok(counters.checkupQueries >= 3, `250 墓碑须翻页（实得 ${counters.checkupQueries} 次查询）`)
  })

  await scenario('A10 daily 最早 pending（结果可区分）：乱序+150 墓碑长前缀后仍选昨日 overdue，翻页越过', async () => {
    withEnv()
    // 数据：150 条过期墓碑（-160..-11 天）+ 昨日 overdue pending + 3 天后 pending，乱序注入
    //（mock orderBy 按 sortKey 稳定排序，等价真实索引序）。
    // 最早有效 = 昨日 overdue（≤14 天 → "产检已过1天"）；错误选取 +3 天/任何远期墓碑外
    // 记录（陈旧>14 天或未到）都会回落提示行——两种结果在文案上可区分，不再同假。
    const rows = []
    for (let i = 160; i >= 11; i--) rows.push(pending(shDay(-i), `tomb-${String(i).padStart(4, '0')}`, { deleted: true }))
    rows.push(pending(shDay(3), 'future-3d'))
    rows.push(pending(shDay(-1), 'overdue-1d'))
    for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]] }
    const { cloud, sends, counters } = makeMockCloud({ callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID, checkups: rows })
    const fn = requireHandler(); fn.__setCloud(cloud)
    const res = await fn.main({ action: 'sendNow' })
    assert.equal(res.ok, true)
    assert.equal(sends.length, 2)
    assert.ok(sends[0].data.thing11.value.includes('产检已过1天'), `最早=昨日 overdue（实得 ${sends[0].data.thing11.value}）`)
    assert.equal(res.data.dateKey, shDay(0), 'daily 日期=快照 today')
    // 150 墓碑 > 单页 100：必须真翻页才到第一条有效行——准确记录查询次数
    //（page1=100 墓碑；page2=剩余 50 墓碑+昨日+3天后，命中即止 → 恰 2 次）
    assert.equal(counters.checkupQueries, 2, `分页越过墓碑前缀（实得 ${counters.checkupQueries} 次查询）`)
  })

  await scenario('审核1/2 缺 sortKey 旧记录（与正常记录混合）：明确失败不静默漏读', async () => {
    withEnv()
    // legacy 行（无 sortKey）与多条正常 pending 并存——完整性失败必须仍然成立，
    // 不得靠删掉正常记录缩成单行获取通过。mock 缺字段按 null 排最前（见 makeMockCloud
    // 注释：BSON null < string，保守侧保证扫描遇到）。
    // eve：明日行缺 sortKey + 正常行混合 → checkup-scan-unstable
    {
      const tomorrow = shDay(1)
      const bad = pending(tomorrow, 'legacy-no-sortkey')
      delete bad.sortKey
      const rows = [pending(shDay(-2), 'normal-past'), bad, pending(shDay(5), 'normal-future')]
      const { cloud, sends } = makeMockCloud({ callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID, checkups: rows })
      const fn = requireHandler(); fn.__setCloud(cloud)
      const res = await fn.main({ action: 'sendNow', kind: 'eve' })
      assert.equal(res.ok, false, '缺 sortKey 不得静默漏读（混合正常记录同样失败）')
      assert.equal(res.code, 'checkup-scan-unstable')
      assert.equal(sends.length, 0, '不稳定扫描绝不发送')
    }
    // daily：唯一 legacy 行混在多条正常 pending 中 → 扫描必达该行，明确失败
    {
      const bad = pending(shDay(-5), 'legacy-no-sortkey')
      delete bad.sortKey
      const rows = [pending(shDay(-2), 'normal-a'), bad, pending(shDay(7), 'normal-b')]
      const { cloud, sends } = makeMockCloud({ callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID, checkups: rows })
      const fn = requireHandler(); fn.__setCloud(cloud)
      const res = await fn.main({ action: 'sendNow' })
      assert.equal(res.ok, false, '缺 sortKey 不得静默漏读（也不得装作无产检安静成功）')
      assert.equal(res.code, 'checkup-scan-unstable')
      assert.equal(sends.length, 0)
    }
  })

  await scenario('A10 DB 异常可区分：checkups 读失败 / pregnancy 读失败如实报错，不装无产检', async () => {
    withEnv()
    {
      const { cloud, sends } = makeMockCloud({ callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID, failCheckups: true })
      const fn = requireHandler(); fn.__setCloud(cloud)
      const res = await fn.main({ action: 'sendNow', kind: 'eve' })
      assert.equal(res.ok, false, 'DB 失败不得装作明天无产检')
      assert.equal(res.code, 'checkup-query-failed')
      assert.equal(sends.length, 0)
    }
    {
      const { cloud, sends } = makeMockCloud({ callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID, failPregnancy: true })
      const fn = requireHandler(); fn.__setCloud(cloud)
      const res = await fn.main({ action: 'sendNow' })
      assert.equal(res.ok, false)
      assert.equal(res.code, 'pregnancy-read-failed')
      assert.equal(sends.length, 0)
    }
  })

  await scenario('审核3 单一时钟快照（上海时区）：冻结时钟跨午夜前一刻，today/tomorrow 全程同一天', async () => {
    withEnv()
    // 固定在上海 2026-09-30 23:59:59.999（跨午夜前 1ms）：today=09-30、tomorrow=10-01
    const frozenMs = Date.parse('2026-09-30T15:59:59.999Z') // UTC 即上海 09-30 23:59:59.999
    const realNow = Date.now
    Date.now = () => frozenMs
    try {
      const tomorrowKey = '2026-10-01'
      const lmpFrozen = '2026-09-01'
      const rows = [pending('2026-10-01')]
      const { cloud, sends } = makeMockCloud({ callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID, checkups: rows, lmp: lmpFrozen })
      const fn = requireHandler(); fn.__setCloud(cloud)
      const res = await fn.main({ action: 'sendNow', kind: 'eve' })
      assert.equal(res.ok, true, `实得 ${JSON.stringify(res).slice(0, 150)}`)
      assert.equal(sends.length, 2)
      assert.equal(sends[0].data.date4.value, '2026年10月1日', '明日=快照 tomorrow（10-01），不受执行时刻漂移影响')
      // daily：回复 dateKey=快照 today（09-30）
      const { cloud: c2, sends: s2 } = makeMockCloud({ callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID, checkups: rows, lmp: lmpFrozen })
      const fn2 = requireHandler(); fn2.__setCloud(c2)
      const res2 = await fn2.main({ action: 'sendNow' })
      assert.equal(res2.ok, true)
      assert.equal(res2.data.dateKey, '2026-09-30', 'daily dateKey=快照 today（上海 09-30）')
    } finally {
      Date.now = realNow
    }
  })

  await scenario('R2-7 快照抗推进：数据库 await 期间时钟跨上海午夜，单次调用整条日期仍一致', async () => {
    withEnv()
    // 起点=上海 2026-09-30 23:59:59.900；每次 db.get 推进 1.2s——读库期间跨过午夜。
    // 全程应使用入口快照：today=09-30 / tomorrow=10-01 / 孕周按 09-30 计（days=13 → 孕1周+6；
    // 若漂移用执行时刻则 days=14 → 孕2周+0——两者可区分）。
    const clock = { now: Date.parse('2026-09-30T15:59:59.900Z') }
    const realNow = Date.now
    Date.now = () => clock.now
    try {
      const advance = () => { clock.now += 1200 }
      const rows = [pending('2026-10-01')]
      const { cloud, sends, counters } = makeMockCloud({
        callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID, checkups: rows, lmp: '2026-09-17', advanceClockOnGet: advance
      })
      const fn = requireHandler(); fn.__setCloud(cloud)
      const res = await fn.main({ action: 'sendNow', kind: 'eve' })
      assert.ok(counters.checkupQueries >= 1 && counters.pregnancyReads >= 1, '确有 db await 发生')
      assert.ok(clock.now > Date.parse('2026-10-01T00:00:00+08:00'), '时钟确已跨过上海午夜')
      assert.equal(res.ok, true, `实得 ${JSON.stringify(res).slice(0, 150)}`)
      assert.equal(sends.length, 2)
      assert.equal(sends[0].data.thing11.value, '孕1周+6 · 明天产检，证件备好', `孕周按入口快照（实得 ${sends[0].data.thing11.value}）`)
      assert.equal(sends[0].data.date4.value, '2026年10月1日', '明日=快照 tomorrow（跨午夜不漂移）')
      // daily 同理：重置时钟到午夜前（第二次调用是独立入口——快照按各自入口时刻），
      // dateKey 仍是快照 today 09-30；主行孕周按快照（09-29 产检 → 已过1天，
      // 若漂移到执行时刻 10-01 则显示 孕2周+0/已过2天——可区分）
      clock.now = Date.parse('2026-09-30T15:59:59.900Z')
      const { cloud: c2, sends: s2 } = makeMockCloud({
        callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID, checkups: [pending('2026-09-29')], lmp: '2026-09-17', advanceClockOnGet: advance
      })
      const fn2 = requireHandler(); fn2.__setCloud(c2)
      const res2 = await fn2.main({ action: 'sendNow' })
      assert.equal(res2.ok, true)
      assert.equal(res2.data.dateKey, '2026-09-30', 'daily dateKey=快照 today（await 跨午夜不漂移）')
      assert.equal(s2[0].data.thing11.value, '孕1周+6 · 产检已过1天', `daily 主行孕周同快照（实得 ${s2[0].data.thing11.value}）`)
    } finally {
      Date.now = realNow
    }
  })

  console.log(`\nphase-r1-push：${passed} 通过，${failed.length} 失败`)
  if (failed.length > 0) { console.log('失败场景：', failed.join(' | ')); process.exit(1) }
}

main().catch(e => { console.error('套件异常:', e); process.exit(2) })
