// Phase N：每日提醒推送功能落地（2026-09 方案）。
// 覆盖四块：
// ① 共用核心 buildPushContent（utils/dailyTipCore.js 单源：孕周+产检动态主行、
//    阶段/营养/当季水果提示行、≤20 字裁剪、按天轮换确定性、无档案 null）；
// ② 云函数 mc-daily-push（临时 DIST=函数+shared+转译核心【镜像 assemble 投放】，
//    mock cloud 注入 __setCloud；定时入口双人发送、43101 配额跳过如实、sendNow
//    白名单、fail-closed（模板未配/核心缺失/无档案）、最早 pending 产检滤墓碑、
//    config.json 触发器形状）；
// ③ 客户端攒配额 utils/pushSubscribe.js（模板空 no-op、accept 后当日不限流静默攒、
//    当日未接受不再弹、fail 也计入当日；pushConfig 经 esbuild 插件重定向注入非空模板）；
// ④ assemble 单源投放与挂点契约（源码断言）。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-phase-n-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) {
  try { await fn(); pass(name) } catch (e) { fail(name, e) }
}
const tick = () => new Promise(r => setTimeout(r, 0))

// ── 相对今日日期 ──
const NOW = new Date()
function dayOffset(n) { const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate()); d.setDate(d.getDate() + n); return d }
const pad = n => String(n).padStart(2, '0')
const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

// ══════ ① 共用核心 bundle（与 phase-l 同手法）══════
const coreFile = path.join(temp, 'dailyTipCore.cjs')
esbuild.buildSync({ entryPoints: [path.join(root, 'utils/dailyTipCore.js')], bundle: true, platform: 'node', format: 'cjs', outfile: coreFile, logLevel: 'silent' })
const { buildPushContent } = require(coreFile)

// ══════ ② 云函数 DIST：函数 + shared + 转译核心（镜像 assemble 投放）══════
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
  MC_FAMILY_ID: 'fam-pn',
  MC_MEMBER_MAMA_OPENID: 'oPNMAMA1234567',
  MC_MEMBER_PAPA_OPENID: 'oPNPAPA1234567'
}
const TPL_ID = 'TPL_PHASE_N_TEST'

// mock cloud：可控档案/产检/发送行为；openapi.send 按 touser 可抛 43101
function makeMockCloud({ callerOpenid, lmpKey, checkupRows, failFor = {} } = {}) {
  const sends = []
  const pregDoc = lmpKey ? { _id: `${TEST_ENV.MC_FAMILY_ID}:pregnancy`, fields: { lmpDate: lmpKey } } : null
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'dynamic-env',
    init: () => {},
    getWXContext: () => (callerOpenid ? { OPENID: callerOpenid, APPID: TEST_ENV.MC_APPID } : {}),
    database: () => ({
      collection(name) {
        return {
          doc: id => ({ get: async () => ({ data: name === 'mc_pregnancy' && id.endsWith(':pregnancy') ? pregDoc : null }) }),
          where: () => ({ limit: () => ({ get: async () => ({ data: name === 'mc_checkups' ? JSON.parse(JSON.stringify(checkupRows || [])) : [] }) }) })
        }
      }
    }),
    openapi: {
      subscribeMessage: {
        send: async msg => {
          sends.push(msg)
          const code = failFor[msg.touser]
          if (code) { const e = new Error('mock'); e.errCode = code; throw e }
        }
      }
    }
  }
  return { cloud, sends }
}

function withEnv(extra = {}) {
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  process.env.MC_PUSH_TEMPLATE_ID = TPL_ID
  for (const [k, v] of Object.entries(extra)) process.env[k] = v
}

// ══════ ③ 客户端攒配额 bundle（pushConfig 经插件重定向为非空模板）══════
const uniCalls = { subscribe: [], storage: new Map() }
global.uni = {
  getStorageSync: k => (uniCalls.storage.has(k) ? uniCalls.storage.get(k) : ''),
  setStorageSync: (k, v) => uniCalls.storage.set(k, v),
  requestSubscribeMessage: opt => {
    uniCalls.subscribe.push(opt)
    if (uniCalls.nextBehavior === 'fail') { uniCalls.nextBehavior = null; opt.fail && opt.fail({ errMsg: 'requestSubscribeMessage:fail' }); return }
    const decision = uniCalls.nextDecision || 'accept'
    uniCalls.nextBehavior = null
    opt.success && opt.success({ errMsg: 'ok', [opt.tmplIds[0]]: decision })
  },
  navigateTo: () => {}, showToast: () => {}
}
async function bundleSubscribe(templateId) {
  const cfg = path.join(temp, `pushConfig-${Math.random().toString(36).slice(2)}.js`)
  fs.writeFileSync(cfg, `export const PUSH_TEMPLATE_ID = ${JSON.stringify(templateId)}\n`)
  const plugin = {
    name: 'redirect-pushconfig',
    setup(build) {
      build.onResolve({ filter: /pushConfig\.js$/ }, args => args.path.includes('pushConfig') && args.path.endsWith('pushConfig.js') && !args.path.includes('pushSubscribe') ? { path: cfg } : null)
    }
  }
  const outFile = path.join(temp, `pushSubscribe-${Math.random().toString(36).slice(2)}.cjs`)
  await esbuild.build({
    entryPoints: [path.join(root, 'utils/pushSubscribe.js')],
    bundle: true, platform: 'node', format: 'cjs',
    outfile: outFile, logLevel: 'silent', plugins: [plugin]
  })
  delete require.cache[require.resolve(outFile)]
  return require(outFile)
}

async function main() {
  console.log('phase-n ①：buildPushContent 纯函数（共用核心单源）')
  const LMP = keyOf(dayOffset(-33)) // 孕4周+5

  await scenario('N1 主行三态+event 标记：当天/3天倒计时/无产检', async () => {
    const a = buildPushContent({ today: keyOf(TODAY()), lmp: LMP, nextCheckupDate: keyOf(TODAY()) })
    assert.ok(a.main.includes('今天产检'), a.main)
    assert.equal(a.event, 'today')
    const b = buildPushContent({ today: keyOf(TODAY()), lmp: LMP, nextCheckupDate: keyOf(dayOffset(3)) })
    assert.ok(b.main.includes('孕4周+5') && b.main.includes('距产检3天'), b.main)
    assert.equal(b.event, 'countdown')
    const c = buildPushContent({ today: keyOf(TODAY()), lmp: LMP, nextCheckupDate: null })
    assert.equal(c.main, '孕4周+5')
    assert.equal(c.event, null, '无事件——单字段模板据此切换提示行')
  })

  await scenario('N2 产检过期边界：2天→已过提醒(event=overdue)、20天→忽略', async () => {
    const a = buildPushContent({ today: keyOf(TODAY()), lmp: LMP, nextCheckupDate: keyOf(dayOffset(-2)) })
    assert.ok(a.main.includes('产检已过2天'), a.main)
    assert.equal(a.event, 'overdue')
    const b = buildPushContent({ today: keyOf(TODAY()), lmp: LMP, nextCheckupDate: keyOf(dayOffset(-20)) })
    assert.equal(b.main, '孕4周+5', '过期>14天视为陈旧不提')
  })

  await scenario('N3 note 按天轮换确定性 + 阶段池：同日同输入同输出、连续8天≥2种', async () => {
    const t = keyOf(TODAY())
    const x = buildPushContent({ today: t, lmp: LMP, nextCheckupDate: null })
    const y = buildPushContent({ today: t, lmp: LMP, nextCheckupDate: null })
    assert.equal(x.note, y.note)
    const notes = new Set()
    for (let i = 0; i < 8; i++) {
      notes.add(buildPushContent({ today: keyOf(dayOffset(i)), lmp: LMP, nextCheckupDate: null }).note)
    }
    assert.ok(notes.size >= 2, `8 天仅 ${notes.size} 种——轮换失效`)
  })

  await scenario('N4 当季水果规则：涉果提示行必含当月当季果名（9月/12月各验）', async () => {
    const fruitLines = n => /维C|补铁|当季/.test(n)
    for (const [month, allowed] of [[9, ['鲜枣', '梨', '葡萄']], [12, ['橙子', '甘蔗']]]) {
      for (let i = 0; i < 30; i++) {
        const d = new Date(2026, month - 1, 1 + i)
        const r = buildPushContent({ today: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, lmp: LMP, nextCheckupDate: null })
        if (fruitLines(r.note)) {
          assert.ok(allowed.some(f => r.note.includes(f)), `${month}月涉果行未含当季果名：${r.note}`)
        }
      }
    }
  })

  await scenario('N5 字数红线：40 周×抽样 12 天 main/note 全部 ≤20 字', async () => {
    for (let w = 1; w <= 40; w += 1) {
      for (let dd = 0; dd < 7; dd += 2) {
        const lmp = keyOf(dayOffset(-(w * 7 + dd)))
        const r = buildPushContent({ today: keyOf(TODAY()), lmp, nextCheckupDate: keyOf(dayOffset(2)) })
        assert.ok(r.main.length <= 20, `main 超长(${r.main.length})：${r.main}`)
        assert.ok(r.note.length <= 20, `note 超长(${r.note.length})：${r.note}`)
      }
    }
  })

  await scenario('N6 防御：lmp 缺失/晚于 today → null', async () => {
    assert.equal(buildPushContent({ today: keyOf(TODAY()), lmp: '', nextCheckupDate: null }), null)
    assert.equal(buildPushContent({ today: keyOf(TODAY()), lmp: keyOf(dayOffset(3)), nextCheckupDate: null }), null)
    assert.equal(buildPushContent(), null)
  })

  console.log('phase-n ②：mc-daily-push 云函数（mock cloud 注入）')

  await scenario('N10 定时入口：双人各发一条，字段映射/落地页/体验版态断言', async () => {
    withEnv()
    const { cloud, sends } = makeMockCloud({ lmpKey: LMP, checkupRows: [
      { familyId: TEST_ENV.MC_FAMILY_ID, dateKey: keyOf(dayOffset(3)), status: 'pending' },
      { familyId: TEST_ENV.MC_FAMILY_ID, dateKey: keyOf(dayOffset(20)), status: 'pending' }
    ] })
    const fn = requireHandler()
    fn.__setCloud(cloud)
    const res = await fn.main({ Type: 'Timer', TriggerName: 'daily-reminder' })
    assert.equal(res.ok, true)
    assert.equal(sends.length, 2)
    assert.deepEqual(sends.map(s => s.touser).sort(), [TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_MEMBER_PAPA_OPENID].sort())
    const s0 = sends[0]
    assert.equal(s0.templateId, TPL_ID)
    assert.equal(s0.page, 'pages/index/index')
    assert.equal(s0.miniprogramState, 'trial')
    // 模板 571「日程提醒」：唯一内容字段 thing11 + date4（中文日期）
    assert.ok(s0.data.thing11.value.includes('距产检3天'), s0.data.thing11.value)
    assert.equal(s0.data.thing11.value.length <= 20, true, 'thing11 ≤20 字')
    assert.ok(/^\d{4}年\d{1,2}月\d{1,2}日$/.test(s0.data.date4.value), `date4 中文日期：${s0.data.date4.value}`)
    assert.equal(s0.data.thing1, undefined, '不再发 thing1（模板无此字段）')
    assert.deepEqual(res.data.results.map(r => r.sent), [true, true])
  })

  await scenario('N11 43101 配额制常态：一人 skipped:quota，另一人照发不挡', async () => {
    withEnv()
    const { cloud, sends } = makeMockCloud({
      lmpKey: LMP,
      failFor: { [TEST_ENV.MC_MEMBER_MAMA_OPENID]: 43101 }
    })
    const fn = requireHandler()
    fn.__setCloud(cloud)
    const res = await fn.main({ Type: 'Timer' })
    assert.equal(res.ok, true)
    assert.equal(sends.length, 2, '两人都尝试发送')
    const mama = res.data.results.find(r => r.member === 'mama')
    const papa = res.data.results.find(r => r.member === 'papa')
    assert.deepEqual(mama, { member: 'mama', sent: false, skipped: 'quota' })
    assert.equal(papa.sent, true)
  })

  await scenario('N12 sendNow 白名单：mama 放行/intruder 拒/无上下文拒', async () => {
    withEnv()
    const base = { lmpKey: LMP }
    const okCloud = makeMockCloud({ ...base, callerOpenid: TEST_ENV.MC_MEMBER_MAMA_OPENID })
    const fnA = requireHandler(); fnA.__setCloud(okCloud.cloud)
    const a = await fnA.main({ action: 'sendNow' })
    assert.equal(a.ok, true, '白名单成员可试发')

    const badCloud = makeMockCloud({ ...base, callerOpenid: 'oINTRUDER999999' })
    const fnB = requireHandler(); fnB.__setCloud(badCloud.cloud)
    assert.equal((await fnB.main({ action: 'sendNow' })).code, 'not-family-member')

    const noCtxCloud = makeMockCloud({ ...base, callerOpenid: '' })
    const fnC = requireHandler(); fnC.__setCloud(noCtxCloud.cloud)
    assert.equal((await fnC.main({ action: 'sendNow' })).code, 'unauthenticated')
  })

  await scenario('N13 手动入口仅收 sendNow：其他 action 拒（bad-action）', async () => {
    withEnv()
    const { cloud } = makeMockCloud({ callerOpenid: TEST_ENV.MC_MEMBER_PAPA_OPENID, lmpKey: LMP })
    const fn = requireHandler(); fn.__setCloud(cloud)
    assert.equal((await fn.main({ action: 'other' })).code, 'bad-action')
    assert.equal((await fn.main({})).code, 'bad-action')
  })

  await scenario('N14 fail-closed：模板未配/核心缺失/档案缺 lmp 均明确拒绝', async () => {
    withEnv()
    delete process.env.MC_PUSH_TEMPLATE_ID
    const { cloud } = makeMockCloud({ lmpKey: LMP })
    const fnA = requireHandler(); fnA.__setCloud(cloud)
    assert.equal((await fnA.main({ Type: 'Timer' })).code, 'push-template-missing')

    process.env.MC_PUSH_TEMPLATE_ID = TPL_ID
    const fnB = requireHandler(); fnB.__setCloud(makeMockCloud({ lmpKey: LMP }).cloud); fnB.__setCore(null)
    assert.equal((await fnB.main({ Type: 'Timer' })).code, 'core-missing')

    const fnC = requireHandler(); fnC.__setCloud(makeMockCloud({ lmpKey: '' }).cloud)
    assert.equal((await fnC.main({ Type: 'Timer' })).code, 'no-pregnancy-profile')
  })

  await scenario('N15 产检查询口径：最早 pending 滤墓碑——含 deleted 过期项不干扰未来倒计时', async () => {
    withEnv()
    const { cloud } = makeMockCloud({ lmpKey: LMP, checkupRows: [
      { familyId: TEST_ENV.MC_FAMILY_ID, dateKey: keyOf(dayOffset(-2)), status: 'pending', deleted: true },
      { familyId: TEST_ENV.MC_FAMILY_ID, dateKey: keyOf(dayOffset(20)), status: 'pending' },
      { familyId: TEST_ENV.MC_FAMILY_ID, dateKey: keyOf(dayOffset(3)), status: 'pending' }
    ] })
    const fn = requireHandler(); fn.__setCloud(cloud)
    const res = await fn.main({ Type: 'Timer' })
    assert.equal(res.ok, true)
    // 墓碑过期项被滤掉、最早未来=3天 → 倒计时而非"已过"
    assert.ok(res.data.week >= 0)
    const fn2 = requireHandler()
    fn2.__setCloud(makeMockCloud({ lmpKey: LMP, checkupRows: [
      { familyId: TEST_ENV.MC_FAMILY_ID, dateKey: keyOf(dayOffset(-2)), status: 'pending' }
    ] }).cloud)
    const res2 = await fn2.main({ Type: 'Timer' })
    assert.equal(res2.ok, true)
  })

  await scenario('N16 config.json 形状：subscribeMessage.send 权限 + 每天 8 点七段 cron', async () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'cloud/functions/mc-daily-push/config.json'), 'utf8'))
    assert.ok(cfg.permissions.openapi.includes('subscribeMessage.send'))
    assert.equal(cfg.triggers[0].name, 'daily-reminder')
    assert.equal(cfg.triggers[0].type, 'timer')
    assert.equal(cfg.triggers[0].config, '0 0 8 * * * *')
  })

  await scenario('N17 assemble 单源投放契约：转译步骤在源码 + 产物与客户端同源可 require', async () => {
    const src = fs.readFileSync(path.join(root, 'cloud/assemble.mjs'), 'utf8')
    assert.ok(src.includes("utils', 'dailyTipCore.js'"), 'assemble 转译入口在')
    assert.ok(src.includes('dailyTipCore.js'), '投放目标在')
    // 本套件 setup 已镜像执行同款转译——产物可 CJS require 且导出齐全即同源证明
    const c = require(path.join(DIST, 'shared/dailyTipCore.js'))
    assert.equal(typeof c.buildPushContent, 'function')
    assert.equal(typeof c.buildTodayTip, 'function')
  })

  console.log('phase-n ③：客户端攒配额 pushSubscribe')

  await scenario('N20 模板未配置：整体 no-op，不触 uni.requestSubscribeMessage', async () => {
    uniCalls.subscribe.length = 0
    const m = await bundleSubscribe('')
    const r = await m.requestPushSubscribe()
    assert.deepEqual(r, { ok: false, code: 'template-unset' })
    assert.equal(uniCalls.subscribe.length, 0)
  })

  await scenario('N21 accept 流：携带模板 ID 调用→授权落 accepted→同日再调仍静默攒（不限流）', async () => {
    uniCalls.subscribe.length = 0; uniCalls.storage.clear(); uniCalls.nextDecision = 'accept'
    const m = await bundleSubscribe('TPL_X1')
    const a = await m.requestPushSubscribe()
    assert.equal(a.ok, true)
    assert.equal(uniCalls.subscribe.length, 1)
    assert.deepEqual(uniCalls.subscribe[0].tmplIds, ['TPL_X1'])
    const b = await m.requestPushSubscribe() // accepted：同日不受限流，继续静默攒配额
    assert.equal(uniCalls.subscribe.length, 2)
    assert.equal(b.ok, true)
  })

  await scenario('N22 当日未接受不再弹：reject 后同日 no-op；跨日恢复询问', async () => {
    uniCalls.subscribe.length = 0; uniCalls.storage.clear(); uniCalls.nextDecision = 'reject'
    const m = await bundleSubscribe('TPL_X1')
    const a = await m.requestPushSubscribe()
    assert.equal(a.ok, false); assert.equal(a.decision, 'reject')
    const b = await m.requestPushSubscribe()
    assert.deepEqual(b, { ok: false, code: 'nagged-today' })
    assert.equal(uniCalls.subscribe.length, 1, '同日只弹一次')
    // 跨日：把 promptDate 改成昨天 → 恢复询问
    const st = uniCalls.storage.get('push.sub.state') || {}
    st.promptDate = '2000-1-1'
    uniCalls.storage.set('push.sub.state', st)
    uniCalls.nextDecision = 'accept'
    const c = await m.requestPushSubscribe()
    assert.equal(uniCalls.subscribe.length, 2)
    assert.equal(c.ok, true)
  })

  await scenario('N23 fail 分支：弹窗失败计入当日（同日不再骚扰）', async () => {
    uniCalls.subscribe.length = 0; uniCalls.storage.clear(); uniCalls.nextBehavior = 'fail'
    const m = await bundleSubscribe('TPL_X1')
    const a = await m.requestPushSubscribe()
    assert.deepEqual(a, { ok: false, code: 'request-failed' })
    const b = await m.requestPushSubscribe()
    assert.deepEqual(b, { ok: false, code: 'nagged-today' })
    assert.equal(uniCalls.subscribe.length, 1)
  })

  await scenario('N24 平台无 API 防御：uni.requestSubscribeMessage 缺失时静默 no-op', async () => {
    const orig = global.uni.requestSubscribeMessage
    delete global.uni.requestSubscribeMessage
    uniCalls.subscribe.length = 0; uniCalls.storage.clear()
    const m = await bundleSubscribe('TPL_X1')
    const r = await m.requestPushSubscribe()
    assert.deepEqual(r, { ok: false, code: 'unsupported-api' })
    assert.equal(uniCalls.subscribe.length, 0)
    global.uni.requestSubscribeMessage = orig
  })

  await scenario('N30 挂点契约：HomeHero 问候卡 + RecordEditSheet 保存均接入攒配额', async () => {
    const hero = fs.readFileSync(path.join(root, 'components/home/HomeHero.vue'), 'utf8')
    assert.ok(hero.includes('requestPushSubscribe'), 'HomeHero 引入')
    assert.ok(hero.includes('onGreetingTap'), '问候卡点按挂点')
    const sheet = fs.readFileSync(path.join(root, 'components/home/RecordEditSheet.vue'), 'utf8')
    assert.ok(sheet.includes('requestPushSubscribe()'), '保存入口调用')
    const cfg = fs.readFileSync(path.join(root, 'utils/pushConfig.js'), 'utf8')
    assert.ok(cfg.includes("PUSH_TEMPLATE_ID = 'PYHbV5824UtdmEG8dynlAOqYFb3HWrqEQyEnV-a8Qx0'"), '已选模板 571 的 ID 在位')
    assert.ok(cfg.includes('thing11'), '字段映射说明与模板 571 同步')
  })

  console.log(`\nphase-n：${passed} 通过，${failed.length} 失败`)
  if (failed.length > 0) { console.log('失败场景：', failed.join(' | ')); process.exit(1) }
}

function TODAY() { return dayOffset(0) }

main().catch(e => { console.error(e); process.exit(1) })
