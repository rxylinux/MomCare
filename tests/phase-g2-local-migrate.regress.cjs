// 本地资料迁移回归（utils/localProfileMigrate + familyStore 迁入链路）。
// 真实客户端模块（familyStore/outbox/session/adapter）+ 伪造 wx.cloud 路由，
// 不访问真实云/网络。覆盖：canOffer 四条件矩阵、buildPayload 字段映射、
// declined 标记作用域、迁入成功/冲突/幂等重放路径。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-g2-migrate-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) {
  try { await fn(); pass(name) } catch (e) { fail(name, e) }
}

const bundlePath = path.join(temp, 'client-bundle.cjs')
esbuild.buildSync({
  stdin: {
    contents: `export { createPinia, setActivePinia } from 'pinia';
      export * from './services/cloudAdapter.js';
      export * from './services/sessionService.js';
      export * from './services/outbox.js';
      export * from './services/familyStore.js';
      export * from './utils/cloudConfig.js';
      export * from './utils/localProfileMigrate.js';`,
    resolveDir: root
  },
  bundle: true, platform: 'node', format: 'cjs', alias: { '@': root },
  outfile: bundlePath, logLevel: 'silent'
})
const api = require(bundlePath)

// ── uni 模拟（storage 为内存 Map；toast 记录供断言）──
const storage = new Map()
global.uni = {
  getStorageSync(k) { return storage.has(k) ? storage.get(k) : '' },
  setStorageSync(k, v) { storage.set(k, v) },
  removeStorageSync(k) { storage.delete(k) },
  getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
  showToast: () => {}, showLoading() {}, hideLoading() {},
  redirectTo() {}, navigateTo() {}, switchTab() {}, reLaunch() {}, navigateBack() {},
  request: () => {}, uploadFile: () => {}
}

const ENV = { envId: 'env-g2', appId: 'wxapp-g2', familyId: 'fam-g2' }
const LOCAL_PROFILE = {
  userInfo: {
    nickname: '  小晴 ',
    babyNickname: '小葡萄',
    hospital: '市妇保院',
    doctor: '',
    hospitalPhone: '  ',
    preWeight: '45',
    height: '158'
  },
  lmpDate: new Date(2026, 7, 15), // 2026-08-15（本地日分量）
  dueDate: new Date(2027, 4, 22) // 2027-05-22
}

function freshStack(upsertBehavior) {
  // 场景隔离：清本命名空间全部持久键（outbox/缓存/会话/迁移标记）
  for (const k of [...storage.keys()]) {
    if (k.startsWith('mc_')) storage.delete(k)
  }
  const calls = []
  let cloudRevision = 0 // 服务端当前 pregnancy revision（0 = 无档案）
  const wxCloud = {
    init() {},
    callFunction({ name, data, success, fail }) {
      Promise.resolve().then(() => {
        if (name !== 'mc-health') throw new Error('unexpected fn ' + name)
        calls.push({ action: data.action, operationId: data.operationId, expectedRevision: data.expectedRevision, payload: data.payload })
        if (data.action === 'pregnancy.get') {
          return { ok: true, data: { record: cloudRevision > 0
            ? { fields: { nickname: '云端' }, revision: cloudRevision, updatedAt: 1 } : null } }
        }
        if (data.action !== 'pregnancy.upsert') throw new Error('unexpected action ' + data.action)
        const behavior = upsertBehavior && upsertBehavior(cloudRevision, data)
        if (behavior && behavior.conflict) {
          cloudRevision = behavior.newRevision || cloudRevision
          return { ok: false, code: 'revision-conflict', currentRevision: behavior.currentRevision, currentRecord: { fields: behavior.currentFields || {}, revision: behavior.currentRevision, updatedAt: 2 } }
        }
        if (behavior && behavior.fail) throw new Error('mock network down')
        cloudRevision += 1
        return { ok: true, data: { record: { fields: { ...data.payload }, revision: cloudRevision, updatedBy: 'mama', updatedAt: Date.now() } } }
      }).then(r => success({ result: r })).catch(e => fail({ errMsg: e.message }))
    }
  }
  api.__setCloudConfigForTests(ENV.envId, ENV.appId)
  api.__setWxCloud(wxCloud)
  api.__resetForTests()
  api.setActivePinia(api.createPinia())
  api.__adoptSessionForTests({ memberId: 'mama', displayName: '妈妈', familyId: ENV.familyId })
  const fam = api.useFamilyStore()
  return { fam, calls, setCloudRevision: r => { cloudRevision = r } }
}

async function main() {
  console.log('本地资料迁移回归（localProfileMigrate + familyStore 迁入链路）\n')

  await scenario('buildPayload：trim、空值不提交、字符串数字转换、Date→YYYY-MM-DD', () => {
    const p = api.buildPayload(LOCAL_PROFILE)
    assert.deepEqual(p, {
      nickname: '小晴',
      babyNickname: '小葡萄',
      hospital: '市妇保院',
      preWeightKg: 45,
      heightCm: 158,
      lmpDate: '2026-08-15',
      dueDate: '2027-05-22'
    })
    assert.equal(p.doctor, undefined, '空串 doctor 不提交')
    assert.equal(p.hospitalPhone, undefined, '纯空白 hospitalPhone 不提交')
  })

  await scenario('buildPayload：NaN 数字、无效日期、空对象输入不产出字段', () => {
    const p = api.buildPayload({
      userInfo: { preWeight: 'abc', height: '', nickname: '' },
      lmpDate: null,
      dueDate: new Date('not-a-date')
    })
    assert.deepEqual(p, {}, '全部无效输入 → 空载荷')
    assert.equal(api.hasLocalContent(p), false)
  })

  await scenario('canOffer：四条件矩阵', () => {
    const payload = { lmpDate: '2026-08-15' }
    const base = { sessionConfirmed: true, pregnancy: null, lastFullSyncAt: 123, payload, declined: false }
    assert.equal(api.canOffer(base), true, '全满足 → 引导')
    assert.equal(api.canOffer({ ...base, sessionConfirmed: false }), false, '未确认不引导')
    assert.equal(api.canOffer({ ...base, pregnancy: { revision: 1 } }), false, '云端已有档案不引导')
    assert.equal(api.canOffer({ ...base, lastFullSyncAt: null }), false, '本会话未完成全量拉取不引导')
    assert.equal(api.canOffer({ ...base, declined: true }), false, '已拒绝不引导')
    assert.equal(api.canOffer({ ...base, payload: {} }), false, '本机无可迁移内容不引导')
    assert.equal(api.canOffer({ ...base, payload: null }), false, 'null 载荷不引导')
  })

  await scenario('declined 标记：写入/读取/家庭作用域隔离', () => {
    freshStack()
    assert.equal(api.isDeclined(ENV.familyId), false, '初始未拒绝')
    assert.equal(api.markDeclined(ENV.familyId), true)
    assert.equal(api.isDeclined(ENV.familyId), true)
    assert.equal(api.isDeclined('fam-other'), false, '不同家庭不串标记')
    const key = api.declinedKey(ENV.familyId)
    assert.ok(key.startsWith('mc_profile_migrate_declined_'), '键前缀')
    assert.ok(key.includes(ENV.envId) && key.includes(ENV.appId) && key.endsWith(ENV.familyId), '键含 env/app/family 三重作用域')
  })

  await scenario('迁入成功：基线 0 首建 → 云端 revision 1 → canOffer 失效', async () => {
    const { fam, calls } = freshStack()
    const payload = api.buildPayload(LOCAL_PROFILE)
    const result = await fam.savePregnancy(payload, 0)
    assert.equal(result.ok, true, '保存成功')
    assert.equal(fam.pregnancy && fam.pregnancy.revision, 1, '权威记录落地 revision 1')
    assert.equal(fam.pregnancy.fields.hospital, '市妇保院', '字段随迁')
    assert.equal(calls.length, 1, '仅一次网络调用')
    assert.equal(calls[0].action, 'pregnancy.upsert')
    assert.equal(calls[0].expectedRevision, 0, '基线 0 首建')
    // 迁入成功后：pregnancy 非空 → canOffer 不再成立（卡片自动消失）
    assert.equal(api.canOffer({
      sessionConfirmed: true, pregnancy: fam.pregnancy, lastFullSyncAt: Date.now(),
      payload, declined: false
    }), false)
  })

  await scenario('迁入冲突：对端已先建档 → revision-conflict，待办进冲突区', async () => {
    const { fam } = freshStack((cloudRev) => cloudRev === 0 ? { conflict: true, currentRevision: 1, currentFields: { nickname: '对方已建' } } : null)
    const payload = api.buildPayload(LOCAL_PROFILE)
    const result = await fam.savePregnancy(payload, 0)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'revision-conflict')
    assert.equal(result.currentRevision, 1)
    assert.equal(fam.conflictEntries.length, 1, '冲突条目入待办冲突区，交由用户解决')
  })

  await scenario('迁入幂等：网络失败留待办，同内容重提交原 opId 重放', async () => {
    let down = true
    const { fam, calls } = freshStack(() => down ? { fail: true } : null)
    const payload = api.buildPayload(LOCAL_PROFILE)
    const r1 = await fam.savePregnancy(payload, 0)
    assert.equal(r1.ok, false, '断网首提失败')
    down = false
    const r2 = await fam.savePregnancy(payload, 0) // 未变更重试：复用原待办原 opId
    assert.equal(r2.ok, true, '重放成功')
    assert.equal(calls.length, 2, '两次网络调用')
    assert.equal(calls[0].operationId, calls[1].operationId, '幂等：同一 operationId 重放')
    assert.equal(fam.pregnancy && fam.pregnancy.revision, 1, '重放后落地')
  })

  console.log(`\n结果：${passed} 通过，${failed.length} 失败`)
  if (failed.length) { console.log('失败项：' + failed.join(' | ')); process.exit(1) }
}

main().catch(e => { console.error(e); process.exit(1) })
