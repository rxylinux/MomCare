// Phase E2 客户端级回归：toolsStore EFW 方法（计算镜像/服务端一致性/记录增删/响应式）。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-e2c-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')

require('node:child_process').execFileSync('node', [path.join(root, 'cloud/assemble.mjs')], { stdio: 'pipe' })
const DIST = path.join(root, 'dist/cloud-functions')
const toolsH = require(path.join(DIST, 'mc-tools/index.js'))

const FROZEN_RELS = ['services/toolsStore.js', 'cloud/functions/mc-tools/index.js']
const frozenHashes = Object.fromEntries(FROZEN_RELS.map(rel => [rel, sha256(fs.readFileSync(path.join(root, rel)))]))
console.log('冻结源哈希（加载时快照）:')
for (const [rel, h] of Object.entries(frozenHashes)) console.log(`  ${h.slice(0, 8)}  ${rel}`)

const TEST_ENV = { MC_APPID: 'wxtestappid0001', MC_FAMILY_ID: 'fam-e2c', MC_MEMBER_MAMA_OPENID: 'oE2CMAMA123456', MC_MEMBER_PAPA_OPENID: 'oE2CPAPA123456' }

function makeMockCloud() {
  const docs = new Map()
  const state = { caller: TEST_ENV.MC_MEMBER_MAMA_OPENID, initialized: false }
  const clone = x => JSON.parse(JSON.stringify(x))
  function docApi(col, id, tx) {
    return {
      get: async () => { const e = docs.get(`${col}/${id}`); if (tx) tx.reads.set(`${col}/${id}`, e ? e.__v : 0); return { data: e ? { ...clone(e), _id: id } : null } },
      set: async ({ data }) => {
        if (data && Object.prototype.hasOwnProperty.call(data, '_id')) { const err = new Error('-501007'); err.errMsg = err.message; throw err }
        if (tx) { tx.writes.set(`${col}/${id}`, clone(data)); return { _id: id } }
        const prev = docs.get(`${col}/${id}`)
        docs.set(`${col}/${id}`, { ...clone(data), __v: (prev ? prev.__v : 0) + 1 }); return { _id: id }
      },
      remove: async () => { if (tx) { tx.removes.add(`${col}/${id}`); return {} } docs.delete(`${col}/${id}`); return {} }
    }
  }
  function runQuery(col, filters, ob, d, l) {
    let rows = [...docs.entries()].filter(([k]) => k.startsWith(col + '/')).map(([k, e]) => ({ ...clone(e), _id: k.slice(col.length + 1) }))
    for (const [k2, c2] of Object.entries(filters || {})) rows = rows.filter(x => c2 && (c2.__op === 'lt' || c2.__op === 'gt')
      ? (x[k2] !== undefined && (c2.__op === 'lt' ? String(x[k2]) < String(c2.v) : String(x[k2]) > String(c2.v)))
      : JSON.stringify(x[k2]) === JSON.stringify(c2))
    if (ob) { rows.sort((a, b) => String(b[ob]).localeCompare(String(a[ob]))); if (String(d).toLowerCase() === 'asc') rows.reverse() }
    return rows.slice(0, l || 100)
  }
  function mq(col, f, ob, d, l) { return { orderBy: (x, y) => mq(col, f, x, y, l), limit: n => mq(col, f, ob, d, n), get: async () => ({ data: runQuery(col, f, ob, d, l) }) } }
  const db = {
    command: { lt: v => ({ __op: 'lt', v }), gt: v => ({ __op: 'gt', v }) },
    startTransaction: async () => {
      const tx = { reads: new Map(), writes: new Map(), removes: new Set() }
      return {
        collection: c => ({ doc: id => docApi(c, id, tx) }),
        commit: async () => {
          for (const [k, rv] of tx.reads) {
            const cur2 = docs.get(k)
            if ((cur2 ? cur2.__v : 0) !== rv) { const err = new Error('transaction conflict: ' + k); err.errCode = 'CONFLICT'; throw err }
          }
          for (const k of tx.removes) docs.delete(k)
          for (const [k, d2] of tx.writes) { const prev = docs.get(k); docs.set(k, { ...d2, __v: (prev ? prev.__v : 0) + 1 }) }
        },
        rollback: async () => { tx.writes.clear(); tx.removes.clear() },
      }
    },
    collection: c => ({ doc: id => docApi(c, id, null), where: f => mq(c, f), get: async () => ({ data: runQuery(c, {}) }) })
  }
  return {
    DYNAMIC_CURRENT_ENV: Symbol('env'), init() { state.initialized = true },
    getWXContext: () => ({ APPID: TEST_ENV.MC_APPID, OPENID: state.caller }),
    database() { if (!state.initialized) throw new Error('init first'); return db },
    __docs: docs, __state: state, __setCtx(o) { state.caller = o },
  }
}

const storage = new Map()
const uniCalls = { toasts: [], modals: [] }
global.uni = {
  getStorageSync(k) { return storage.has(k) ? storage.get(k) : '' },
  setStorageSync(k, v) { storage.set(k, v) },
  removeStorageSync(k) { storage.delete(k) },
  getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
  showToast: v => uniCalls.toasts.push(v && v.title),
  showModal: o => { uniCalls.modals.push({ title: o && o.title, content: o && o.content }); o && o.success && o.success({ confirm: true }) },
  makePhoneCall() {}, vibrateShort() {}, showLoading() {}, hideLoading() {},
  redirectTo() {}, navigateTo() {}, switchTab() {}, reLaunch() {}, navigateBack() {},
  request() {}, uploadFile() {}, downloadFile: o => o.fail && o.fail({ errMsg: 'dl' }),
}

const clientBundle = path.join(temp, 'client.cjs')
{
  const src = `import { createPinia, setActivePinia } from 'pinia';\nsetActivePinia(createPinia());\n` +
    `export * from './services/toolsStore.js';\nexport * from './services/sessionService.js';\nexport * from './services/familyStore.js';\nexport * from './services/outbox.js';\nexport * from './services/cloudAdapter.js';\nexport * from './utils/cloudConfig.js';\n`
  esbuild.buildSync({ stdin: { contents: src, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: clientBundle, logLevel: 'silent' })
}
function loadClient() {
  delete require.cache[require.resolve(clientBundle)]
  return require(clientBundle)
}

function makeStack() {
  for (const k of [...storage.keys()]) {
    if (k.startsWith('momcare_') || k.startsWith('mc_')) storage.delete(k)
  }
  const cloud = makeMockCloud()
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v
  process.env.MC_FAMILY_ID = TEST_ENV.MC_FAMILY_ID
  toolsH.__setCloud(cloud)
  const wxCloud = {
    init() {},
    callFunction(o) {
      const h = o.name === 'mc-tools' ? toolsH.main : () => ({ ok: true, data: { memberId: 'mama', familyId: TEST_ENV.MC_FAMILY_ID } })
      Promise.resolve().then(() => h(o.data)).then(r => o.success({ result: r })).catch(e => o.fail({ errMsg: e.message }))
    }
  }
  return { cloud, wxCloud }
}
async function confirmed(stack) {
  const client = loadClient()
  client.__setCloudConfigForTests('env-e2c', 'wxapp-e2c')
  client.__setWxCloud(stack.wxCloud)
  global.wx = { cloud: stack.wxCloud }
  client.__resetForTests()
  const r = await client.confirmIdentity()
  assert.ok(r.ok, `confirmIdentity: ${JSON.stringify(r).slice(0, 120)}`)
  return client
}

const efwDocs = st => [...st.cloud.__docs.entries()].filter(([k]) => k.startsWith('mc_efw_records/')).map(([k, v]) => ({ _id: k.split('/')[1], ...v }))

async function main() {
  console.log('Phase E2 客户端级回归（toolsStore EFW → 真实 mc-tools）\n')

  await scenario('S1 纯函数镜像 vs 服务端一致性（锚点+多样本+mm 等价）', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    const samples = [
      { hc: 32.0, ac: 30.0, fl: 6.5, unit: 'cm' },
      { hc: 320, ac: 300, fl: 65, unit: 'mm' },
      { hc: 30.5, ac: 28.2, fl: 6.0, unit: 'cm' },
      { hc: 35.1, ac: 33.4, fl: 7.2, unit: 'cm' },
      { hc: 280, ac: 260, fl: 52, unit: 'mm' },
      { hc: 42.0, ac: 45.0, fl: 10.0, unit: 'cm' },
    ]
    for (const s of samples) {
      const local = client.computeHadlockEfw(s)
      assert.ok(!local.err, `本地计算 ${JSON.stringify(s)}: ${local.err}`)
      const remote = await store.calculateEfw(s)
      assert.ok(remote.ok, `服务端计算: ${JSON.stringify(remote).slice(0, 120)}`)
      assert.equal(local.efwGrams, remote.data.efwGrams, `整数克一致（${s.hc}/${s.ac}/${s.fl}${s.unit}）`)
      assert.equal(local.exactEfwGrams, remote.data.exactEfwGrams, '精确克一致')
      assert.equal(local.log10, remote.data.log10, 'log10 一致')
      assert.equal(local.formula, remote.data.formula, '公式标识一致')
    }
    // 锚点钉
    const anchor = client.computeHadlockEfw({ hc: 32.0, ac: 30.0, fl: 6.5 })
    assert.equal(anchor.efwGrams, 2364) && assert.equal(anchor.exactEfwGrams, 2364.29) && assert.equal(anchor.log10, 3.3737)
    assert.equal(anchor.efwKg, 2.364)
    assert.deepEqual(anchor.rangeGrams, { low: 2128, high: 2601 }, '±10% 区间')
    // 范围/非法输入本地镜像
    assert.ok(client.computeHadlockEfw({ hc: 42.1, ac: 30, fl: 6.5 }).err, '超界 err')
    assert.ok(client.computeHadlockEfw({ hc: 'x', ac: 30, fl: 6.5 }).err, '非数字 err')
    assert.ok(client.computeHadlockEfw({ hc: 32, ac: 30, fl: 6.5, unit: 'inch' }).err, '非法单位 err')
  })

  await scenario('S2 记录管理：save/pull/delete 响应式更新+服务端一致', async () => {
    const stack = makeStack()
    const client = await confirmed(stack)
    const store = client.useToolsStore()
    assert.equal(store.efwRecords.length, 0, '初始空')
    const r1 = await store.saveEfwRecord({ gestationalWeek: 32, hc: 320, ac: 300, fl: 65, unit: 'mm', bpd: 88, dateKey: '2026-09-18' })
    assert.ok(r1.ok, `save: ${JSON.stringify(r1).slice(0, 150)}`)
    assert.equal(store.efwRecords.length, 1, '响应式 +1')
    assert.equal(store.efwRecords[0].efwGrams, 2364, '记录含服务端权威值')
    assert.equal(store.efwRecords[0].measurements.bpdMm, 88, 'BPD 伴随')
    const r2 = await store.saveEfwRecord({ gestationalWeek: 33, hc: 33, ac: 31, fl: 6.7, unit: 'cm', dateKey: '2026-09-20' })
    assert.ok(r2.ok)
    assert.equal(store.efwRecords.length, 2, '第二条置顶（本地插入序）')
    // 新客户端拉取（服务端倒序）
    {
      const client2 = await confirmed(stack)
      const store2 = client2.useToolsStore()
      const pull = await store2.pullEfwRecords()
      assert.ok(pull.ok)
      assert.equal(store2.efwRecords.length, 2, '拉取 2 条')
      assert.equal(store2.efwRecords[0].dateKey, '2026-09-20', 'dateKey 倒序')
      assert.ok(store2.efwRecords.every(x => x.status === 'active'))
    }
    // 删除
    const del = await store.deleteEfwRecord(store.efwRecords[0].recordId)
    assert.ok(del.ok, `delete: ${JSON.stringify(del).slice(0, 150)}`)
    assert.equal(store.efwRecords.length, 1, '删除后 1 条')
    assert.equal(efwDocs(stack).filter(d => d.status !== 'discarded').length, 1, '服务端软删除')
    // 非法参数
    const badSave = await store.saveEfwRecord({ gestationalWeek: 11, hc: 32, ac: 30, fl: 6.5 })
    assert.ok(!badSave.ok && badSave.code === 'invalid-params', `孕周校验（实得 ${badSave.code}）`)
    const badCalc = await store.calculateEfw({ hc: 50, ac: 30, fl: 6.5 })
    assert.ok(!badCalc.ok && badCalc.code === 'invalid-params', '服务端范围拒传播')
  })

  await scenario('Z9 冻结源哈希：运行期间源未被并发编辑', async () => {
    for (const [rel, h] of Object.entries(frozenHashes)) {
      const now = sha256(fs.readFileSync(path.join(root, rel)))
      assert.equal(now, h, `${rel} 被并发编辑——结果作废须复跑`)
    }
  })

  console.log(`\n${passed} 通过, ${failed.length} 失败`)
  if (failed.length) { console.log('失败项：'); for (const f of failed) console.log(` - ${f}`); process.exit(1) }
  process.exit(0)
}

main().catch(e => { console.error('套件异常:', e); process.exit(2) })
