// 阶段 B1 回归测试：真实生产代码 + 隔离模拟（不访问真实云资源/网络/付费接口）。
// 分层：
//   服务端：dist/cloud-functions 组装产物中的真实 handler + 按 wx-server-sdk@4.0.2
//           源码核对实现的模拟（set 拒绝 data._id / get 返回 data:doc|null /
//           downloadFile→fileContent:Buffer / 事务快照隔离 + 提交冲突）
//   客户端：esbuild 打包真实 services/utils；页面测试整段打包真实 <script setup>
//           （只替换视觉组件与生命周期注册，不复制处理函数体）
//   规则：生成器输出语义模拟（不冒充控制台验证）
//   组装：真实执行 cloud/assemble.mjs 并从产物加载
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-b1-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) {
  try { await fn(); pass(name) } catch (e) { fail(name, e) }
}

// ───────────────────────── 组装真实云函数产物 ─────────────────────────
cp.execFileSync('node', [path.join(root, 'cloud/assemble.mjs')], { stdio: 'pipe' })
const DIST = path.join(root, 'dist/cloud-functions')
// B1 服务端契约测试：旧集合业务写入已默认关闭（B2a/R3-5），显式开启测试开关
// 验证历史契约语义（生产不配置 MC_ALLOW_LEGACY_WRITES）
process.env.MC_ALLOW_LEGACY_WRITES = 'true'

const handlers = {
  identity: require(path.join(DIST, 'mc-identity/index.js')),
  shared: require(path.join(DIST, 'mc-shared-records/index.js')),
  private: require(path.join(DIST, 'mc-private-notes/index.js')),
  files: require(path.join(DIST, 'mc-files/index.js'))
}

// ───────────────────── SDK 契约模拟（4.0.2 源码核对） ─────────────────────
function makeMockCloud(options = {}) {
  const state = {
    initCfg: null,
    ctx: { OPENID: '', APPID: '' },
    store: new Map(),      // key: `${col}/${id}` → { v, doc }
    blobs: new Map(),      // fileID → Buffer
    uploads: [],           // { cloudPath, bytes }
    tempUrls: new Map(),
    controls: {
      failNextCommits: 0,          // 下一次 commit 直接失败（基础设施故障）
      failCommitAfterUpload: 0,    // uploadFile 成功后让随后 N 次 commit 失败
      filesReadDelayMs: 0          // 文件集合读取延迟（并发窗口测试）
    },
    callLog: []
  }

  function key(col, id) { return `${col}/${id}` }
  function readDoc(col, id) {
    const entry = state.store.get(key(col, id))
    return entry ? { v: entry.v, doc: clone(entry.doc) } : null
  }
  function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)) }

  function docApi(col, id, tx) {
    return {
      get: async (getOptions) => {
        // 真实契约（源码核对）：get 返回的文档包含 _id（服务端返回完整文档），
        // 而 set 拒绝 data._id——由模拟层按 key 补回 _id，使"展开查询结果再写入"
        // 这类错误可被测试捕获
        if (getOptions && getOptions.throwOnNotFound === false) {
          // 与配置级一致；接受显式传参但本项目代码不这么做
        }
        if (state.controls.filesReadDelayMs && col === 'mc_files' && !tx) {
          await new Promise(r => setTimeout(r, state.controls.filesReadDelayMs))
        }
        const entry = readDoc(col, id)
        const docWithId = entry ? { ...entry.doc, _id: id } : null
        if (tx) {
          tx.reads.set(key(col, id), entry ? entry.v : 0)
          return docWithId ? { data: docWithId } : { data: null }
        }
        return docWithId ? { data: docWithId } : { data: null }
      },
      set: async ({ data }) => {
        // 真实 SDK 契约（源码核对）：set 数据含 _id → 网络/事务前即拒绝
        if (data && Object.prototype.hasOwnProperty.call(data, '_id')) {
          const err = new Error('document.set:fail -501007 invalid parameters 不能更新_id的值')
          err.errMsg = err.message
          throw err
        }
        if (tx) {
          tx.writes.set(key(col, id), clone(data))
          return { _id: id, stats: { updated: 1 } }
        }
        const prev = state.store.get(key(col, id))
        state.store.set(key(col, id), { v: (prev ? prev.v : 0) + 1, doc: clone(data) })
        return { _id: id, stats: { updated: 1 } }
      },
      update: async () => { throw new Error('B1 未使用 update') }
    }
  }

  const db = {
    startTransaction: async () => {
      const tx = { reads: new Map(), writes: new Map(), finished: false }
      return {
        collection: col => ({ doc: id => docApi(col, id, tx) }),
        commit: async () => {
          if (tx.finished) throw new Error('transaction already finished')
          if (state.controls.failNextCommits > 0) {
            state.controls.failNextCommits--
            throw new Error('transaction commit failed (mock infra)')
          }
          // 快照隔离：任一被写文档的当前版本若高于事务首次读取版本 → 冲突
          for (const k of tx.writes.keys()) {
            const readV = tx.reads.has(k) ? tx.reads.get(k) : 0
            const cur = state.store.get(k)
            const curV = cur ? cur.v : 0
            if (curV !== readV) {
              const err = new Error('transaction conflict: document was modified')
              err.errMsg = 'db transaction conflict'
              throw err
            }
          }
          for (const [k, data] of tx.writes.entries()) {
            const prev = state.store.get(k)
            state.store.set(k, { v: (prev ? prev.v : 0) + 1, doc: clone(data) })
          }
          tx.finished = true
        },
        rollback: async () => { tx.finished = true }
      }
    },
    collection: col => ({ doc: id => docApi(col, id, null) })
  }

  const cloud = {
    DYNAMIC_CURRENT_ENV: Symbol('DYNAMIC_CURRENT_ENV'),
    init(cfg) { state.initCfg = cfg },
    getWXContext() { return { ...state.ctx } },
    database() {
      if (!state.initCfg) {
        const err = new Error('Cloud API isn\'t enabled, please call init first')
        err.errMsg = err.message
        throw err
      }
      return db
    },
    async downloadFile({ fileID }) {
      const buf = state.blobs.get(fileID)
      if (!buf) { const e = new Error('downloadFile fail'); e.errMsg = e.message; throw e }
      return { fileContent: Buffer.from(buf), statusCode: 200 }
    },
    async uploadFile({ cloudPath, fileContent }) {
      state.uploads.push({ cloudPath, bytes: fileContent.length })
      const fileID = `cloud://${options.envName || 'testenv'}.bucket/${cloudPath}`
      if (state.controls.failCommitAfterUpload > 0) {
        state.controls.failNextCommits = state.controls.failCommitAfterUpload
        state.controls.failCommitAfterUpload = 0
      }
      return { fileID, statusCode: 200 }
    },
    async getTempFileURL({ fileList }) {
      return {
        fileList: fileList.map(f => ({
          fileID: f, tempFileURL: 'https://tmp.example/' + encodeURIComponent(f), maxAge: 7200, status: 0, errMsg: 'ok'
        }))
      }
    },
    __state: state,
    __setCtx(openid, appid) { state.ctx = { OPENID: openid, APPID: appid } },
    __put(col, id, doc) { const { _id, ...rest } = doc; void _id; state.store.set(key(col, id), { v: 1, doc: clone(rest) }) },
    __snapshot(col, id) { const e = state.store.get(key(col, id)); return e ? clone(e.doc) : null }
  }
  return cloud
}

// 环境变量（服务端配置）默认虚构测试值
const TEST_ENV = {
  MC_APPID: 'wxtestappid0001',
  MC_FAMILY_ID: 'fam-b1test',
  MC_MEMBER_MAMA_OPENID: 'oTESTMAMA123456',
  MC_MEMBER_PAPA_OPENID: 'oTESTPAPA123456'
}
function setServerEnv(overrides = {}) {
  for (const [k, v] of Object.entries({ ...TEST_ENV, ...overrides })) process.env[k] = v
}
function clearServerEnv() {
  for (const k of Object.keys(TEST_ENV)) delete process.env[k]
  delete process.env.MC_UPLOAD_ENABLED
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)])
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 9)])
const NOT_IMAGE = Buffer.from('hello world this is not an image at all')

function stagePath(openid, name) {
  return `cloud://testenv.bucket/mc/${TEST_ENV.MC_FAMILY_ID}/stage/${openid}/${name}`
}

// ───────────────────────── 服务端场景 ─────────────────────────
async function serverMain() {
  clearServerEnv()
  const cloud = makeMockCloud()
  handlers.identity.__setCloud(cloud)
  handlers.shared.__setCloud(cloud)
  handlers.private.__setCloud(cloud)
  handlers.files.__setCloud(cloud)

  await scenario('B1-身份：妈妈/爸爸 whoami 只返回自身', async () => {
    setServerEnv()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    const mama = await handlers.identity.main({})
    assert.deepEqual([mama.ok, mama.data.memberId, mama.data.familyId], [true, 'mama', TEST_ENV.MC_FAMILY_ID])
    cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID, TEST_ENV.MC_APPID)
    const papa = await handlers.identity.main({})
    assert.equal(papa.data.memberId, 'papa')
    // 不泄露白名单/其他成员
    assert.ok(!JSON.stringify(mama).includes(TEST_ENV.MC_MEMBER_PAPA_OPENID))
  })

  await scenario('B1-身份：第三成员/缺上下文/错 AppID/未配置 拒绝；伪造 event 身份被忽略', async () => {
    cloud.__setCtx('oSTRANGER000001', TEST_ENV.MC_APPID)
    assert.equal((await handlers.identity.main({})).code, 'not-family-member')
    cloud.__setCtx('', TEST_ENV.MC_APPID)
    assert.equal((await handlers.identity.main({})).code, 'unauthenticated')
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, 'wxWRONGAPPID0002')
    assert.equal((await handlers.identity.main({})).code, 'wrong-appid')
    clearServerEnv()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    assert.equal((await handlers.identity.main({})).code, 'not-configured')
    // 伪造：真实上下文是妈妈，event 声称爸爸 → 仍是妈妈
    setServerEnv()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    const forged = await handlers.identity.main({ openid: TEST_ENV.MC_MEMBER_PAPA_OPENID, memberId: 'papa', role: 'papa', familyId: 'other' })
    assert.equal(forged.data.memberId, 'mama')
  })

  await scenario('B1-身份：设置期 my-openid 只返回调用者自身', async () => {
    setServerEnv()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    const res = await handlers.identity.main({ action: 'my-openid' })
    assert.equal(res.data.openid, TEST_ENV.MC_MEMBER_MAMA_OPENID)
    assert.ok(!JSON.stringify(res).includes(TEST_ENV.MC_MEMBER_PAPA_OPENID))
    cloud.__setCtx('oSTRANGER000001', TEST_ENV.MC_APPID)
    const stranger = await handlers.identity.main({ action: 'my-openid' })
    assert.equal(stranger.data.openid, 'oSTRANGER000001') // 自己的 openid 自己可见
    cloud.__setCtx('oSTRANGER000001', 'wxWRONGAPPID0002')
    assert.equal((await handlers.identity.main({ action: 'my-openid' })).code, 'wrong-appid')
  })


  await scenario('R2-my-openid 契约：仅配 MC_APPID 时也严格比对 AppID', async () => {
    // 成员未配全（部署第一阶段），但 MC_APPID 已配置 → 必须比对
    setServerEnv({ MC_MEMBER_MAMA_OPENID: '', MC_MEMBER_PAPA_OPENID: '' })
    cloud.__setCtx('oANYUSER000001', TEST_ENV.MC_APPID)
    const okRes = await handlers.identity.main({ action: 'my-openid' })
    assert.equal(okRes.ok, true)
    assert.equal(okRes.data.openid, 'oANYUSER000001')
    cloud.__setCtx('oANYUSER000001', 'wxWRONGAPPID0002')
    assert.equal((await handlers.identity.main({ action: 'my-openid' })).code, 'wrong-appid')
    // 连 MC_APPID 都没配 → 明确 not-configured，不做形态校究放宽
    const savedAppid = process.env.MC_APPID
    delete process.env.MC_APPID
    cloud.__setCtx('oANYUSER000001', 'wx0000000000000000')
    assert.equal((await handlers.identity.main({ action: 'my-openid' })).code, 'not-configured')
    process.env.MC_APPID = savedAppid
    setServerEnv()
  })

  const todayKey = '2026-09-19'
  await scenario('B1-共享：创建 r0→r1；get 返回负载数据', async () => {
    setServerEnv()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    const res = await handlers.shared.main({
      action: 'upsert', type: 'daily', dateKey: todayKey,
      payload: { weightKg: 60 }, expectedRevision: 0, operationId: 'op-create'
    })
    assert.equal(res.ok, true)
    assert.equal(res.data.record.revision, 1)
    assert.equal(res.data.record.updatedBy, 'mama')
    const got = await handlers.shared.main({ action: 'get', type: 'daily', dateKey: todayKey })
    assert.equal(got.data.record.payload.weightKg, 60)
  })

  await scenario('B1-Blocker1 回归：expectedRevision 省略/null/字符串/负数/小数一律拒绝', async () => {
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    for (const bad of [undefined, null, '1', -1, 1.5]) {
      const res = await handlers.shared.main({
        action: 'upsert', type: 'daily', dateKey: todayKey,
        payload: { weightKg: 61 }, expectedRevision: bad, operationId: 'op-bad-' + String(bad)
      })
      assert.equal(res.code, 'invalid-params', `expectedRevision=${bad} 应被拒绝`)
    }
    // 私人笔记同样强制
    const res2 = await handlers.private.main({
      action: 'upsert', dateKey: todayKey, content: 'x', expectedRevision: undefined, operationId: 'pn-bad'
    })
    assert.equal(res2.code, 'invalid-params')
    assert.equal(handlers.private.main.name, 'main')
  })

  await scenario('B1-共享：revision 冲突返回顶层 currentRevision，不覆盖', async () => {
    cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID, TEST_ENV.MC_APPID)
    const res = await handlers.shared.main({
      action: 'upsert', type: 'daily', dateKey: todayKey,
      payload: { weightKg: 62 }, expectedRevision: 0, operationId: 'op-conflict'
    })
    assert.equal(res.code, 'revision-conflict')
    assert.equal(res.currentRevision, 1) // fail 载荷在顶层（页面按此读取）
    assert.equal(res.data, undefined)
    const after = await handlers.shared.main({ action: 'get', type: 'daily', dateKey: todayKey })
    assert.equal(after.data.record.payload.weightKg, 60) // 未被覆盖
  })

  await scenario('B1-共享：同 operationId 同内容幂等重放，异内容拒绝', async () => {
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    const again = await handlers.shared.main({
      action: 'upsert', type: 'daily', dateKey: todayKey,
      payload: { weightKg: 60 }, expectedRevision: 0, operationId: 'op-create'
    })
    assert.equal(again.data.replayed, true)
    assert.equal(again.data.record.revision, 1) // 重放首次结果，不产生 r2
    const diff = await handlers.shared.main({
      action: 'upsert', type: 'daily', dateKey: todayKey,
      payload: { weightKg: 99 }, expectedRevision: 0, operationId: 'op-create'
    })
    assert.equal(diff.code, 'operation-id-conflict')
  })

  await scenario('B1-共享：字段白名单与数值范围', async () => {
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    const dirty = await handlers.shared.main({
      action: 'upsert', type: 'daily', dateKey: '2026-09-20',
      payload: { weightKg: 61.5, ownerId: 'papa', familyId: 'hack', evil: '<script>' },
      expectedRevision: 0, operationId: 'op-whitelist'
    })
    assert.equal(dirty.ok, true)
    assert.deepEqual(Object.keys(dirty.data.record.payload), ['weightKg'])
    const range = await handlers.shared.main({
      action: 'upsert', type: 'daily', dateKey: '2026-09-21',
      payload: { weightKg: 9999 }, expectedRevision: 0, operationId: 'op-range'
    })
    assert.equal(range.code, 'invalid-params')
  })

  await scenario('B1-共享：事务失败零写入，同 operationId 重试成功', async () => {
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    cloud.__state.controls.failNextCommits = 1
    const failed = await handlers.shared.main({
      action: 'upsert', type: 'daily', dateKey: '2026-09-22',
      payload: { weightKg: 58 }, expectedRevision: 0, operationId: 'op-retry'
    })
    assert.equal(failed.code, 'transaction-failed')
    // 零写入：记录与操作表都没有
    assert.equal(cloud.__snapshot('mc_shared_records', `${TEST_ENV.MC_FAMILY_ID}:daily:2026-09-22`), null)
    assert.equal(cloud.__snapshot('mc_operations', `mama:op-retry`), null)
    const retried = await handlers.shared.main({
      action: 'upsert', type: 'daily', dateKey: '2026-09-22',
      payload: { weightKg: 58 }, expectedRevision: 0, operationId: 'op-retry'
    })
    assert.equal(retried.ok, true)
  })

  await scenario('B1-私人：跨成员读写隔离，冲突不泄露正文', async () => {
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    const saved = await handlers.private.main({
      action: 'upsert', dateKey: todayKey, content: 'mama only secret',
      expectedRevision: 0, operationId: 'pn-1'
    })
    assert.equal(saved.ok, true)
    // 妈妈读取本人
    const own = await handlers.private.main({ action: 'get', dateKey: todayKey })
    assert.equal(own.data.note.content, 'mama only secret')
    // 爸爸同日期读取：命中自己的文档（不存在）→ null，绝不返回妈妈正文
    cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID, TEST_ENV.MC_APPID)
    const papaGet = await handlers.private.main({ action: 'get', dateKey: todayKey })
    assert.equal(papaGet.data.note, null)
    assert.ok(!JSON.stringify(papaGet).includes('mama only secret'))
    // 爸爸写同日期 → 写入自己的文档，不覆盖妈妈
    const papaSave = await handlers.private.main({
      action: 'upsert', dateKey: todayKey, content: 'papa own note',
      expectedRevision: 0, operationId: 'pn-papa'
    })
    assert.equal(papaSave.ok, true)
    const mamaAfter = await (cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID), handlers.private.main({ action: 'get', dateKey: todayKey }))
    assert.equal(mamaAfter.data.note.content, 'mama only secret')
    // 冲突响应不带正文
    const conflict = await handlers.private.main({
      action: 'upsert', dateKey: todayKey, content: 'mama new',
      expectedRevision: 0, operationId: 'pn-conflict'
    })
    assert.equal(conflict.code, 'revision-conflict')
    assert.ok(!JSON.stringify(conflict).includes('mama only secret'))
  })

  await scenario('B1-文件：上传开关默认关闭，prepareUpload 拒绝且不返回路径', async () => {
    setServerEnv()
    delete process.env.MC_UPLOAD_ENABLED
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    const policy = await handlers.files.main({ action: 'uploadPolicy' })
    assert.equal(policy.data.clientUploadEnabled, false)
    const prepared = await handlers.files.main({ action: 'prepareUpload', uploadId: 'up1' })
    assert.equal(prepared.code, 'upload-disabled')
    assert.equal(prepared.data, undefined)
  })

  await scenario('B1-文件：开关开启后 prepareUpload 下发本人 OpenID 暂存路径', async () => {
    process.env.MC_UPLOAD_ENABLED = 'true'
    const prepared = await handlers.files.main({ action: 'prepareUpload', uploadId: 'up1' })
    assert.equal(prepared.ok, true)
    assert.equal(prepared.data.cloudPath, `mc/${TEST_ENV.MC_FAMILY_ID}/stage/${TEST_ENV.MC_MEMBER_MAMA_OPENID}/up1`)
    delete process.env.MC_UPLOAD_ENABLED
  })

  await scenario('B1-文件：登记全链路 + 幂等重放同一 storageFileKey（Item4 _id 回归在真实形状下通过）', async () => {
    process.env.MC_UPLOAD_ENABLED = 'true'
    const stageID = stagePath(TEST_ENV.MC_MEMBER_MAMA_OPENID, 'up2')
    cloud.__state.blobs.set(stageID, JPEG)
    const reg = await handlers.files.main({ action: 'registerStaged', stageFileID: stageID, uploadId: 'up2' })
    assert.equal(reg.ok, true, JSON.stringify(reg))
    assert.equal(reg.data.file.status, 'registered')
    assert.ok(reg.data.file.storageFileKey.startsWith(`mc/${TEST_ENV.MC_FAMILY_ID}/formal/up2_`))
    // 重试同 uploadId 同 stagedFileID → 幂等重放，同一正式路径，不新增上传
    const uploadsBefore = cloud.__state.uploads.length
    const again = await handlers.files.main({ action: 'registerStaged', stageFileID: stageID, uploadId: 'up2' })
    assert.equal(again.data.replayed, true)
    assert.equal(again.data.file.storageFileKey, reg.data.file.storageFileKey)
    assert.equal(cloud.__state.uploads.length, uploadsBefore)
    delete process.env.MC_UPLOAD_ENABLED
  })

  await scenario('B1-文件：他人暂存路径/路径穿越/非图片/超大 拒绝', async () => {
    process.env.MC_UPLOAD_ENABLED = 'true'
    const wrongOwner = stagePath(TEST_ENV.MC_MEMBER_PAPA_OPENID, 'x1')
    const r1 = await handlers.files.main({ action: 'registerStaged', stageFileID: wrongOwner, uploadId: 'u-x1' })
    assert.equal(r1.code, 'forbidden-path')
    const traversal = `cloud://testenv.bucket/mc/${TEST_ENV.MC_FAMILY_ID}/stage/${TEST_ENV.MC_MEMBER_MAMA_OPENID}/../formal/evil`
    const r2 = await handlers.files.main({ action: 'registerStaged', stageFileID: traversal, uploadId: 'u-x2' })
    assert.equal(r2.code, 'forbidden-path')
    const notImg = stagePath(TEST_ENV.MC_MEMBER_MAMA_OPENID, 'x3')
    cloud.__state.blobs.set(notImg, NOT_IMAGE)
    const r3 = await handlers.files.main({ action: 'registerStaged', stageFileID: notImg, uploadId: 'u-x3' })
    assert.equal(r3.code, 'unsupported-type')
    const big = stagePath(TEST_ENV.MC_MEMBER_MAMA_OPENID, 'x4')
    cloud.__state.blobs.set(big, Buffer.concat([JPEG, Buffer.alloc(11 * 1024 * 1024)]))
    const r4 = await handlers.files.main({ action: 'registerStaged', stageFileID: big, uploadId: 'u-x4' })
    assert.equal(r4.code, 'file-too-large')
    // 扩展名伪装：PNG 内容配 .jpg 命名 → 以内容判定为 png（可登记但类型是 png）
    const fake = stagePath(TEST_ENV.MC_MEMBER_MAMA_OPENID, 'fake.jpg')
    cloud.__state.blobs.set(fake, PNG)
    const r5 = await handlers.files.main({ action: 'registerStaged', stageFileID: fake, uploadId: 'u-x5' })
    assert.equal(r5.data.file.contentType, 'image/png')
    delete process.env.MC_UPLOAD_ENABLED
  })

  await scenario('B1-文件：同 uploadId 不同暂存文件拒绝（并发换内容）', async () => {
    process.env.MC_UPLOAD_ENABLED = 'true'
    const a = stagePath(TEST_ENV.MC_MEMBER_MAMA_OPENID, 'same-a')
    const b = stagePath(TEST_ENV.MC_MEMBER_MAMA_OPENID, 'same-b')
    cloud.__state.blobs.set(a, JPEG)
    cloud.__state.blobs.set(b, Buffer.concat([JPEG, Buffer.from('x')]))
    await handlers.files.main({ action: 'registerStaged', stageFileID: a, uploadId: 'u-same' })
    const clash = await handlers.files.main({ action: 'registerStaged', stageFileID: b, uploadId: 'u-same' })
    assert.equal(clash.code, 'operation-id-conflict')
    delete process.env.MC_UPLOAD_ENABLED
  })

  await scenario('B1-文件：并发同 uploadId（快照隔离）→ 一成功一可重试，最终唯一登记/唯一路径', async () => {
    process.env.MC_UPLOAD_ENABLED = 'true'
    const stageID = stagePath(TEST_ENV.MC_MEMBER_MAMA_OPENID, 'conc1')
    cloud.__state.blobs.set(stageID, JPEG)
    cloud.__state.controls.filesReadDelayMs = 15 // 打开并发读窗口
    const [r1, r2] = await Promise.all([
      handlers.files.main({ action: 'registerStaged', stageFileID: stageID, uploadId: 'u-conc' }),
      handlers.files.main({ action: 'registerStaged', stageFileID: stageID, uploadId: 'u-conc' })
    ])
    cloud.__state.controls.filesReadDelayMs = 0
    const codes = [r1, r2].map(r => r.ok ? 'ok' : r.code).sort()
    assert.ok(codes.includes('ok'), '至少一个成功：' + JSON.stringify(codes))
    assert.ok(codes.every(c => c === 'ok' || c === 'transaction-failed'), '失败方为事务冲突可重试：' + JSON.stringify(codes))
    // 失败方重试 → 幂等重放
    const retryOf = r => r.ok ? r : handlers.files.main({ action: 'registerStaged', stageFileID: stageID, uploadId: 'u-conc' })
    const settled = await retryOf(r1.ok ? r2 : r1)
    assert.equal(settled.data.replayed, true)
    // 唯一登记记录、唯一正式路径（同内容哈希同路径）
    assert.ok(cloud.__snapshot('mc_files', 'mama:u-conc'))
    const formalPaths = new Set(cloud.__state.uploads.map(u => u.cloudPath).filter(p => p.includes('u-conc')))
    assert.equal(formalPaths.size, 1, '同一正式路径：' + [...formalPaths].join(','))
    delete process.env.MC_UPLOAD_ENABLED
  })

  await scenario('B1-文件：转存成功登记失败 → 同 uploadId 重试完成，路径不变', async () => {
    process.env.MC_UPLOAD_ENABLED = 'true'
    const stageID = stagePath(TEST_ENV.MC_MEMBER_MAMA_OPENID, 'regfail')
    cloud.__state.blobs.set(stageID, JPEG)
    cloud.__state.controls.failCommitAfterUpload = 1 // 上传成功后第一次 commit（登记事务）失败
    const failed = await handlers.files.main({ action: 'registerStaged', stageFileID: stageID, uploadId: 'u-regfail' })
    assert.equal(failed.code, 'transaction-failed')
    assert.ok(failed.message.includes('同一 uploadId 重试'))
    // 认领仍是 claiming；重试完成登记，正式路径与首次尝试一致
    const retried = await handlers.files.main({ action: 'registerStaged', stageFileID: stageID, uploadId: 'u-regfail' })
    assert.equal(retried.ok, true)
    const formal = new Set(cloud.__state.uploads.map(u => u.cloudPath).filter(p => p.includes('u-regfail')))
    assert.equal(formal.size, 1)
    delete process.env.MC_UPLOAD_ENABLED
  })

  await scenario('B1-文件：getReadUrl 家庭成员可读已登记文件；任意/未登记 fileId 拒绝', async () => {
    process.env.MC_UPLOAD_ENABLED = 'true'
    const stageID = stagePath(TEST_ENV.MC_MEMBER_MAMA_OPENID, 'read1')
    cloud.__state.blobs.set(stageID, JPEG)
    const reg = await handlers.files.main({ action: 'registerStaged', stageFileID: stageID, uploadId: 'u-read1' })
    const fileId = reg.data.file.fileId
    // 爸爸（家庭成员）可读（报告两人共享）
    cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID, TEST_ENV.MC_APPID)
    const url = await handlers.files.main({ action: 'getReadUrl', fileId })
    assert.equal(url.ok, true)
    assert.ok(url.data.tempFileURL.startsWith('https://'))
    // 任意/未登记 ID
    const ghost = await handlers.files.main({ action: 'getReadUrl', fileId: 'mama:nonexistent' })
    assert.equal(ghost.code, 'file-not-found')
    const garbage = await handlers.files.main({ action: 'getReadUrl', fileId: '../etc/passwd' })
    assert.equal(garbage.code, 'file-not-found')
    delete process.env.MC_UPLOAD_ENABLED
  })

  await scenario('B1-SDK 契约：未 init 时 database() 报错（真实行为），业务函数已先 init', async () => {
    const fresh = makeMockCloud()
    assert.throws(() => fresh.database(), /init first/)
    handlers.identity.__setCloud(fresh)
    setServerEnv()
    fresh.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    const res = await handlers.identity.main({})
    assert.equal(res.ok, true)
    assert.ok(fresh.__state.initCfg && fresh.__state.initCfg.throwOnNotFound === false)
    assert.equal(typeof fresh.__state.initCfg.env, 'symbol') // DYNAMIC_CURRENT_ENV
  })

  await scenario('B1-组装：产物可加载、依赖锁定 4.0.2、包含 cloud.init', async () => {
    for (const fn of ['mc-identity', 'mc-shared-records', 'mc-private-notes', 'mc-files']) {
      const pkg = JSON.parse(fs.readFileSync(path.join(DIST, fn, 'package.json'), 'utf8'))
      assert.equal(pkg.dependencies['wx-server-sdk'], '4.0.2', fn)
      const src = fs.readFileSync(path.join(DIST, fn, 'index.js'), 'utf8')
      assert.ok(src.includes('cloud.init'), fn + ' 缺少 cloud.init')
      assert.ok(fs.existsSync(path.join(DIST, fn, 'shared/config.js')), fn + ' 缺 shared')
    }
  })

  await scenario('B1-规则生成器：官方语法 + 四边界语义（模拟评估，非控制台验证）', async () => {
    const out = cp.execFileSync('node', [path.join(root, 'cloud/rules/generate-staging-rules.mjs'),
      '--family', 'fam-b1test', '--openid-mama', 'oTESTMAMA123456', '--openid-papa', 'oTESTPAPA123456'],
      { stdio: ['pipe', 'pipe', 'pipe'] }).toString()
    const rule = JSON.parse(out)
    assert.equal(rule.read, false)
    const w = rule.write
    assert.ok(w.includes('auth != null'))
    assert.ok(w.includes('.test(resource.path)) == true'))
    assert.ok(!w.includes('=~') && !w.includes('nil'))
    // 语义模拟：从生成串提取 (openid, regex) 子句
    const clauses = [...w.matchAll(/auth\.openid == "([^"]+)" && \(\(?\/(.+?)\/\.test\(resource\.path\)\)? == true\)/g)]
    assert.equal(clauses.length, 2, '两个成员子句：' + w)
    function evaluate(authOpenid, resourcePath) {
      if (authOpenid == null) return false
      return clauses.some(([, oid, pattern]) => {
        if (oid !== authOpenid) return false
        return new RegExp(pattern).test(resourcePath)
      })
    }
    assert.equal(evaluate('oTESTMAMA123456', `mc/fam-b1test/stage/oTESTMAMA123456/a.jpg`), true, '本人目录可写')
    assert.equal(evaluate('oTESTMAMA123456', `mc/fam-b1test/stage/oTESTPAPA123456/a.jpg`), false, '互写拒绝')
    assert.equal(evaluate('oTESTMAMA123456', `mc/fam-b1test/formal/up1_abc`), false, '正式目录拒绝')
    assert.equal(evaluate(null, `mc/fam-b1test/stage/oTESTMAMA123456/a.jpg`), false, '匿名拒绝')
    // family 参数校验（防注入进正则）
    const bad = cp.spawnSync('node', [path.join(root, 'cloud/rules/generate-staging-rules.mjs'),
      '--family', 'fam/x{2}', '--openid-mama', 'oTESTMAMA123456', '--openid-papa', 'oTESTPAPA123456'], { encoding: 'utf8' })
    assert.notEqual(bad.status, 0, '异常 family 应拒绝生成')
  })
}

// ───────────────────────── 客户端场景 ─────────────────────────
async function clientMain() {
  const bundle = path.join(temp, 'client.cjs')
  esbuild.buildSync({
    stdin: {
      contents: `export { createPinia, setActivePinia } from 'pinia';
        export * from './services/cloudAdapter.js';
        export * from './services/sessionService.js';
        export * from './utils/cloudConfig.js';
        export * from './utils/backendGate.js';
        export * from './utils/api.js';
        export * from './stores/health.js';
        export * from './stores/report.js';`,
      resolveDir: root
    },
    bundle: true, platform: 'node', format: 'cjs', alias: { '@': root },
    outfile: bundle, logLevel: 'silent'
  })
  const api = require(bundle)
  const storage = new Map()
  // 页面按真实时钟取当天日期：测试预置数据必须使用同一 TODAY，跨天仍有意义
  const TODAY = (() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })()
  const uniCalls = { toasts: [], redirectTo: 0, switchTab: 0, navigateTo: 0, reLaunch: 0, chooseImage: 0, saveFile: 0, requests: 0, uploadFile: 0 }
  global.uni = {
    getStorageSync: k => (storage.has(k) ? storage.get(k) : ''),
    setStorageSync(k, v) { storage.set(k, v) },
    removeStorageSync: k => storage.delete(k),
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
    showToast: v => uniCalls.toasts.push(v && v.title),
    redirectTo: () => { uniCalls.redirectTo++ },
    switchTab: () => { uniCalls.switchTab++ },
    navigateTo: () => { uniCalls.navigateTo++ },
    reLaunch: () => { uniCalls.reLaunch++ },
    showLoading() {}, hideLoading() {},
    chooseImage: o => { uniCalls.chooseImage++; o.success({ tempFilePaths: ['tmp://pick-' + uniCalls.chooseImage + '.jpg'] }) },
    saveFile: o => { uniCalls.saveFile++; o.success({ savedFilePath: 'store://saved-' + uniCalls.saveFile }) },
    removeSavedFile: () => {},
    previewImage: () => {},
    request: () => { uniCalls.requests++ }, // 旧后端调用计数（应恒为 0）
    uploadFile: () => { uniCalls.uploadFile++ }, // 旧二进制上传计数（应恒为 0）
  }

  function freshFakeWxCloud(routes = {}) {
    const calls = { init: [], functions: [] }
    const wxCloud = {
      init(cfg) { calls.init.push(cfg) },
      callFunction({ name, data, success, fail }) {
        calls.functions.push({ name, data })
        const handler = routes[name]
        if (!handler) return fail({ errMsg: 'no route' })
        Promise.resolve().then(() => handler(data)).then(r => success({ result: r })).catch(e => fail({ errMsg: e.message }))
      },
      uploadFile({ cloudPath, filePath, success }) {
        success({ fileID: `cloud://testenv.bucket/${cloudPath}`, statusCode: 200 })
      },
      __calls: calls
    }
    return wxCloud
  }

  await scenario('B1-适配器：未配置/H5 明确失败，零云调用', async () => {
    api.__setCloudConfigForTests('', '')
    api.__resetForTests()
    const state = api.cloudRuntimeState()
    assert.equal(state, 'not-configured')
    const res = await api.callCloudFunction('mc-identity', {})
    assert.equal(res.code, 'not-configured')
    // 未注入 wx.cloud（模拟 H5）+ 配置齐全 → unavailable-platform
    api.__setCloudConfigForTests('env-t', 'wxapp-t')
    api.__setWxCloud(null)
    const res2 = await api.callCloudFunction('mc-identity', {})
    assert.equal(res2.code, 'unavailable-platform')
  })

  await scenario('B1-会话 Blocker6a：确认切换身份后，旧成员迟到业务响应被丢弃', async () => {
    api.__setCloudConfigForTests('env-t', 'wxapp-t')
    const whoamiQueue = []
    const bizQueue = []
    const wxCloud = freshFakeWxCloud({
      'mc-identity': () => new Promise(r => whoamiQueue.push(r)),
      'mc-private-notes': () => new Promise(r => bizQueue.push(r))
    })
    const nextWhoami = v => whoamiQueue.shift()(v)
    const nextBiz = v => bizQueue.shift()(v)
    const tick = () => new Promise(r => setTimeout(r, 0))
    api.__setWxCloud(wxCloud)
    api.__resetForTests()
    // 第一次确认：妈妈（完成，纪元落地）
    const p1 = api.confirmIdentity()
    await tick()
    nextWhoami({ ok: true, data: { memberId: 'mama', displayName: '妈妈', familyId: 'f' } })
    assert.equal((await p1).ok, true)
    assert.equal(api.getSessionState().member.memberId, 'mama')
    // 妈妈的业务请求先发出并挂起（尚未返回）
    const biz = api.familyCall('mc-private-notes', { action: 'get', dateKey: '2026-09-19' })
    await tick()
    // 第二次确认切换为爸爸并完成
    const p2 = api.confirmIdentity()
    await tick()
    nextWhoami({ ok: true, data: { memberId: 'papa', displayName: '爸爸', familyId: 'f' } })
    await p2
    assert.equal(api.getSessionState().member.memberId, 'papa')
    // 妈妈的业务响应此时才返回 → 必须被丢弃
    nextBiz({ ok: true, data: { note: { content: 'mama private' } } })
    const bizRes = await biz
    assert.equal(bizRes.ok, false)
    assert.equal(bizRes.code, 'stale-session', '妈妈的迟到响应不再生效')
  })

  await scenario('B1-会话 Blocker6b：业务函数身份拒绝 → 立即锁定', async () => {
    api.__resetForTests()
    const wxCloud = freshFakeWxCloud({
      'mc-identity': () => ({ ok: true, data: { memberId: 'mama', displayName: '妈妈', familyId: 'f' } }),
      'mc-private-notes': () => ({ ok: false, code: 'not-family-member', message: '仅限本家庭成员使用' })
    })
    api.__setWxCloud(wxCloud)
    const confirmed = await api.confirmIdentity()
    assert.equal(confirmed.ok, true)
    const res = await api.familyCall('mc-private-notes', { action: 'get', dateKey: '2026-09-19' })
    assert.equal(res.code, 'not-family-member')
    assert.equal(res.locked, true)
    // 锁定后：业务调用与缓存访问全部关闭
    const after = await api.familyCall('mc-private-notes', { action: 'get', dateKey: '2026-09-19' })
    assert.equal(after.code, 'unauthenticated-session')
    assert.equal(api.getMemberCache('any'), null)
  })

  await scenario('B1-会话 Blocker6c：已确认会话遇暂时离线不锁定；冷启动离线不放行缓存', async () => {
    api.__resetForTests()
    let offline = false
    const wxCloud = freshFakeWxCloud({
      'mc-identity': () => offline
        ? { ok: false, code: 'cloud-call-failed', message: '云调用失败' }
        : { ok: true, data: { memberId: 'mama', displayName: '妈妈', familyId: 'f' } }
    })
    api.__setWxCloud(wxCloud)
    assert.equal((await api.confirmIdentity()).ok, true)
    api.setMemberCache('k', { a: 1 })
    offline = true
    const refresh = await api.confirmIdentity()
    assert.equal(refresh.ok, false)
    assert.equal(refresh.transient, true, '暂时性失败标记')
    assert.equal(api.getSessionState().status, 'confirmed', '会话未被锁定')
    assert.deepEqual(api.getMemberCache('k'), { a: 1 }, '已验证会话可离线使用缓存')
    // 冷启动（重置后）离线：保持未确认，缓存不放行
    api.__resetForTests()
    const cold = await api.confirmIdentity()
    assert.equal(cold.transient, true)
    assert.equal(api.getSessionState().status, 'unconfirmed')
    assert.equal(api.getMemberCache('k'), null)
  })

  await scenario('B1-会话 Blocker6d：草稿按当前确认成员隔离，未确认/换身份不可读写他人草稿', async () => {
    api.__resetForTests()
    // 未确认：草稿 API 拒绝
    assert.equal(api.stashDraft({ x: 1 }), false)
    assert.equal(api.pendingDrafts(), null)
    let member = 'mama'
    const wxCloud = freshFakeWxCloud({
      'mc-identity': () => ({ ok: true, data: { memberId: member, displayName: member, familyId: 'f' } })
    })
    api.__setWxCloud(wxCloud)
    await api.confirmIdentity()
    assert.equal(api.stashDraft({ privateNote: 'mama draft' }), true)
    // 退出后：当前无确认成员 → 读不到
    api.endSession()
    assert.equal(api.pendingDrafts(), null)
    // 爸爸确认：读不到妈妈的草稿
    member = 'papa'
    await api.confirmIdentity()
    assert.equal(api.pendingDrafts(), null)
    // 妈妈重新确认：草稿恢复（未静默丢失）
    member = 'mama'
    await api.confirmIdentity()
    assert.equal(api.pendingDrafts().privateNote, 'mama draft')
  })

  await scenario('B1-会话：确认在途时业务请求与缓存访问被限制', async () => {
    api.__resetForTests()
    const whoamiQueue = []
    const wxCloud = freshFakeWxCloud({ 'mc-identity': () => new Promise(r => whoamiQueue.push(r)) })
    const nextWhoami = v => whoamiQueue.shift()(v)
    const tick = () => new Promise(r => setTimeout(r, 0))
    api.__setWxCloud(wxCloud)
    // 先确认妈妈并写缓存
    const p1 = api.confirmIdentity()
    await tick()
    nextWhoami({ ok: true, data: { memberId: 'mama', displayName: '妈妈', familyId: 'f' } })
    await p1
    api.setMemberCache('k', { v: 1 })
    // 第二次确认在途
    const p2 = api.confirmIdentity()
    await tick() // 确认请求已到达在途状态（confirming=true）
    const during = await api.familyCall('mc-private-notes', {})
    assert.equal(during.code, 'confirming', '确认在途时业务请求被限制')
    assert.equal(api.getMemberCache('k'), null, '确认在途时缓存不放行')
    nextWhoami({ ok: true, data: { memberId: 'mama', displayName: '妈妈', familyId: 'f' } })
    await p2
    assert.deepEqual(api.getMemberCache('k'), { v: 1 }, '确认完成后恢复')
  })

  await scenario('B1-草稿分字段清除：共享保存不清私人部分', async () => {
    api.__resetForTests()
    const wxCloud = freshFakeWxCloud({ 'mc-identity': () => ({ ok: true, data: { memberId: 'mama', displayName: '妈妈', familyId: 'f' } }) })
    api.__setWxCloud(wxCloud)
    await api.confirmIdentity()
    api.stashDraft({ weightKg: '61', privateNote: 'keep me' })
    api.clearDraftFields('weightKg')
    const d = api.pendingDrafts()
    assert.equal(d.weightKg, undefined)
    assert.equal(d.privateNote, 'keep me')
    api.clearDraftFields('privateNote')
    assert.equal(api.pendingDrafts(), null, '全部清空后草稿键删除')
  })

  await scenario('B1-待上传状态：成员绑定持久化与隔离', async () => {
    api.__resetForTests()
    assert.equal(api.savePendingUpload({ uploadId: 'u1' }), false, '未确认拒绝')
    let member = 'mama'
    const wxCloud = freshFakeWxCloud({ 'mc-identity': () => ({ ok: true, data: { memberId: member, displayName: member, familyId: 'f' } }) })
    api.__setWxCloud(wxCloud)
    await api.confirmIdentity()
    assert.equal(api.savePendingUpload({ uploadId: 'u1', savedFilePath: 'store://saved-1' }), true)
    member = 'papa'
    await api.confirmIdentity()
    assert.equal(api.getPendingUpload(), null, '爸爸读不到妈妈待上传')
    member = 'mama'
    await api.confirmIdentity()
    assert.equal(api.getPendingUpload().uploadId, 'u1', '重新确认后待上传恢复')
    api.clearPendingUpload()
    assert.equal(api.getPendingUpload(), null)
  })

  // ── 边界5收敛精细化门控 ──
  // 只跳过依赖已移除编辑器（handleSaveShared/handleSavePrivate/sharedInput/privateInput）
  // 的场景；上传待办/goDemo/页面加载等仍是家庭页有效功能，改造导出后继续运行。
  const familyVue = fs.readFileSync(path.join(root, 'pages/family/index.vue'), 'utf8')
  const familyPageHasEditing = familyVue.includes('handleSaveShared')
  if (!familyPageHasEditing) {
    console.log('SKIP  仅跳过依赖已移除共享/私人编辑器的场景；上传待办/goDemo/页面加载等仍有效测试保留运行（等价编辑器行为由 B2a 套件权威源路径覆盖）')
  }
  const maybePage = familyPageHasEditing ? (name, fn) => scenario(name, fn) : (name, fn) => { void name; void fn }

  // ── 页面：整段打包真实 <script setup>（只替换视觉/生命周期，不复制函数体）──
  function buildFamilyPage() {
    const vue = fs.readFileSync(path.join(root, 'pages/family/index.vue'), 'utf8')
    const start = vue.indexOf('<script setup>') + '<script setup>'.length
    const end = vue.indexOf('</script>')
    let code = vue.slice(start, end)
    // 替换视觉组件与生命周期注册（保持业务逻辑原样）
    code = code.replace(/import NavBar from '@\/components\/NavBar.vue'/, 'const NavBar = null; // 测试替换：视觉组件')
    code = code.replace(/import \{ onShow \} from '@dcloudio\/uni-app'/, 'const onShow = () => {}; // 测试替换：生命周期注册')
    // 模拟 MP-WEIXIN 构建：剔除 H5 专属 fallback 块
    code = code.replace(/\/\* #ifndef MP-WEIXIN \*\/[\s\S]*?\/\* #endif \*\//g, '')
    // 暴露页面处理器与状态；钩子从真实模块导入（与页面同一实例）
    const exportBlock = familyVue.includes('handleSaveShared')
      ? `export {
  handleConfirm, handleSaveShared, loadShared, handleSavePrivate, handleUploadImage,
  discardPendingUpload, refreshPendingUpload, goDemo,
  session, sharedInput, sharedRecord, sharedMsg, sharedMsgWarn,
  privateInput, privateMsg, uploadEnabled, uploadMsg, uploadMsgWarn, pendingUploadInfo, registeredFileId, filePolicyText,
  stashDraft, mergeDraft, pendingDrafts, clearDraftFields,
  __setCloudConfigForTests as __cfg, __setWxCloud as __wx, __resetForTests as __reset
}`
      : `export {
  handleConfirm, handleUploadImage, discardPendingUpload, refreshPendingUpload, goDemo,
  session, uploadEnabled, uploadMsg, uploadMsgWarn, pendingUploadInfo, registeredFileId, filePolicyText,
  __setCloudConfigForTests as __cfg, __setWxCloud as __wx, __resetForTests as __reset
}`
    code = `import { __setCloudConfigForTests } from '@/utils/cloudConfig.js'
import { __setWxCloud } from '@/services/cloudAdapter.js'
import { __resetForTests } from '@/services/sessionService.js'
` + code + '\n' + exportBlock
    const outFile = path.join(temp, 'family-page.cjs')
    esbuild.buildSync({
      stdin: { contents: code, resolveDir: path.join(root, 'pages/family'), loader: 'js' },
      bundle: true, platform: 'node', format: 'cjs', alias: { '@': root },
      outfile: outFile, logLevel: 'silent'
    })
    // 页面 bundle 引用真实 services；为路由到真实云函数，重置注入
    delete require.cache[require.resolve(outFile)]
    return require(outFile)
  }

  await scenario('B1-页面：真实 script setup 打包可加载（收敛后仍存在的处理器）', async () => {
    const page = buildFamilyPage()
    // 收敛后仍有效的核心功能：身份确认、上传闭环、导航
    assert.equal(typeof page.handleConfirm, 'function')
    assert.equal(typeof page.handleUploadImage, 'function')
    assert.equal(typeof page.discardPendingUpload, 'function')
    assert.equal(typeof page.goDemo, 'function')
    // 已移除的编辑器不再导出（收敛验证）
    assert.equal(page.handleSaveShared, undefined)
    assert.equal(page.handleSavePrivate, undefined)
  })

  await maybePage('B1-页面：冲突路径读取顶层 currentRevision 不再 TypeError，输入保留（Item7）', async () => {
    api.__resetForTests()
    // 全栈：页面 → 适配器 → 伪造 wx.cloud → 真实 mc-* handler → 契约 mock
    const cloud = makeMockCloud()
    setServerEnv()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    handlers.identity.__setCloud(cloud)
    handlers.shared.__setCloud(cloud)
    handlers.private.__setCloud(cloud)
    handlers.files.__setCloud(cloud)
    // 预置服务端记录 r1（模拟"对方已更新"）
    await handlers.shared.main({ action: 'upsert', type: 'daily', dateKey: TODAY, payload: { weightKg: 60 }, expectedRevision: 0, operationId: 'seed' })
    cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID, TEST_ENV.MC_APPID)

    const wxCloud = freshFakeWxCloud({
      'mc-identity': () => handlers.identity.main({}),
      'mc-shared-records': e => handlers.shared.main(e),
      'mc-private-notes': e => handlers.private.main(e),
      'mc-files': e => handlers.files.main(e)
    })
    const page = buildFamilyPage()
    page.__cfg('env-t', 'wxapp-t')
    page.__wx(wxCloud)
    page.__reset()
    await page.handleConfirm(false)
    assert.equal(page.session.value.status, 'confirmed')
    assert.equal(page.sharedRecord.value.revision, 1)
    // 服务端被妈妈推进到 r2（模拟另一端更新）
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    await handlers.shared.main({ action: 'upsert', type: 'daily', dateKey: TODAY, payload: { weightKg: 61 }, expectedRevision: 1, operationId: 'bump' })
    cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID, TEST_ENV.MC_APPID)
    // 页面持 r1 保存 → 冲突：不抛 TypeError，输入保留，提示含 r2
    page.sharedInput.value.weightKg = '62'
    await page.handleSaveShared()
    assert.ok(!page.sharedMsg.value.includes('undefined'), '消息无 undefined（原 TypeError 复现点）')
    assert.ok(page.sharedMsg.value.includes('r2'), '提示当前版本 r2')
    assert.equal(page.sharedInput.value.weightKg, '62', '用户输入保留')
    assert.equal(page.sharedRecord.value.revision, 2, '服务端版本展示已刷新')
  })

  await maybePage('B1-页面：共享保存成功只清共享草稿字段（Item7）', async () => {
    api.__resetForTests()
    const cloud = makeMockCloud()
    setServerEnv()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID, TEST_ENV.MC_APPID)
    handlers.identity.__setCloud(cloud)
    handlers.shared.__setCloud(cloud)
    handlers.private.__setCloud(cloud)
    handlers.files.__setCloud(cloud)
    const wxCloud = freshFakeWxCloud({
      'mc-identity': () => handlers.identity.main({}),
      'mc-shared-records': e => handlers.shared.main(e),
      'mc-private-notes': e => handlers.private.main(e),
      'mc-files': e => handlers.files.main(e)
    })
    const page = buildFamilyPage()
    page.__cfg('env-t', 'wxapp-t')
    page.__wx(wxCloud)
    page.__reset()
    await page.handleConfirm(false)
    // 造一份含两部分的草稿（模拟此前共享失败暂存过）
    page.stashDraft({ weightKg: '63', privateNote: 'still pending note' })
    page.sharedInput.value.weightKg = '63'
    await page.handleSaveShared()
    assert.ok(page.sharedMsg.value.includes('已保存'))
    const d = page.pendingDrafts()
    assert.equal(d.weightKg, undefined, '共享字段已清')
    assert.equal(d.privateNote, 'still pending note', '私人草稿保留')
  })

  await maybePage('B1-页面：成员缓存先行离线恢复 + 云端刷新（Item7）', async () => {
    api.__resetForTests()
    const cloud = makeMockCloud()
    setServerEnv()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID, TEST_ENV.MC_APPID)
    handlers.identity.__setCloud(cloud)
    handlers.shared.__setCloud(cloud)
    handlers.private.__setCloud(cloud)
    handlers.files.__setCloud(cloud)
    let offline = false
    const wxCloud = {
      init() {},
      callFunction({ name, data, success, fail }) {
        if (offline) return fail({ errMsg: 'request:fail offline' })
        const route = { 'mc-identity': handlers.identity, 'mc-shared-records': handlers.shared, 'mc-private-notes': handlers.private, 'mc-files': handlers.files }
        Promise.resolve().then(() => route[name].main(data)).then(r => success({ result: r })).catch(e => fail({ errMsg: e.message }))
      },
      uploadFile(o) { o.success({ fileID: 'cloud://x/y' }) }
    }
    const page = buildFamilyPage()
    page.__cfg('env-t', 'wxapp-t')
    page.__wx(wxCloud)
    page.__reset()
    // 第一次在线：拉取并写缓存
    await handlers.shared.main({ action: 'upsert', type: 'daily', dateKey: TODAY, payload: { weightKg: 64 }, expectedRevision: 0, operationId: 'seed2' })
    await page.handleConfirm(false)
    assert.equal(page.sharedRecord.value.revision, 1)
    // 离线重新确认（暂时失败）→ 缓存仍然先行恢复展示
    offline = true
    const page2 = buildFamilyPage()
    page2.__cfg('env-t', 'wxapp-t')
    page2.__wx(wxCloud)
    page2.__reset()
    await page2.handleConfirm(false)
    assert.equal(page2.session.value.status, 'unconfirmed', '冷启动离线保持未确认')
    // 已验证会话的离线恢复：重置回 confirmed 场景模拟运行中会话
    offline = false
    const page3 = buildFamilyPage()
    page3.__cfg('env-t', 'wxapp-t')
    page3.__wx(wxCloud)
    page3.__reset()
    await page3.handleConfirm(false)
    offline = true
    await page3.loadShared()
    assert.equal(page3.sharedRecord.value.revision, 1, '运行中会话离线仍展示缓存')
  })

  await scenario('B1-页面：上传待办重试同一文件、新图显式新操作（Item9）', async () => {
    api.__resetForTests()
    const cloud = makeMockCloud()
    setServerEnv()
    process.env.MC_UPLOAD_ENABLED = 'true'
    cloud.__setCtx(TEST_ENV.MC_MEMBER_PAPA_OPENID, TEST_ENV.MC_APPID)
    handlers.identity.__setCloud(cloud)
    handlers.shared.__setCloud(cloud)
    handlers.private.__setCloud(cloud)
    handlers.files.__setCloud(cloud)
    const wxCloud = freshFakeWxCloud({
      'mc-identity': () => handlers.identity.main({}),
      'mc-shared-records': e => handlers.shared.main(e),
      'mc-private-notes': e => handlers.private.main(e),
      'mc-files': e => handlers.files.main(e)
    })
    wxCloud.uploadFile = ({ cloudPath, success }) => {
      // 真实内容入 blobs 供 registerStaged 下载校验
      cloud.__state.blobs.set(`cloud://testenv.bucket/${cloudPath}`, JPEG)
      success({ fileID: `cloud://testenv.bucket/${cloudPath}`, statusCode: 200 })
    }
    global.wx = { cloud: wxCloud } // 页面直传走全局 wx.cloud（MP 契约）
    const page = buildFamilyPage()
    page.__cfg('env-t', 'wxapp-t')
    page.__wx(wxCloud)
    page.__reset()
    await page.handleConfirm(false)
    assert.equal(page.uploadEnabled.value, true, '服务端开关开启')
    const chooseBefore = uniCalls.chooseImage
    const saveBefore = uniCalls.saveFile
    // 第一次上传：登记事务失败（模拟转存成功登记失败）
    cloud.__state.controls.failCommitAfterUpload = 1
    await page.handleUploadImage()
    assert.equal(page.pendingUploadInfo.value && page.pendingUploadInfo.value.uploadId.length > 0, true, '待上传保留')
    assert.equal(uniCalls.chooseImage, chooseBefore + 1)
    assert.equal(uniCalls.saveFile, saveBefore + 1, '选图已持久化')
    // 重试：不重新选图，同一 uploadId、同一持久文件
    const pendingId = page.pendingUploadInfo.value.uploadId
    await page.handleUploadImage()
    assert.equal(uniCalls.chooseImage, chooseBefore + 1, '重试不重新选图')
    assert.equal(page.registeredFileId.value, `papa:${pendingId}`)
    assert.equal(page.pendingUploadInfo.value, null, '成功后待办清除')
    const reg = cloud.__snapshot('mc_files', `papa:${pendingId}`)
    assert.equal(reg.status, 'registered')
    // 放弃流程：显式丢弃后重新选图 → 新 uploadId
    await page.handleUploadImage() // 新一轮（成功，建立又完成）
    const firstId = page.registeredFileId.value
    // 建立新待办再丢弃
    cloud.__state.controls.failCommitAfterUpload = 1
    await page.handleUploadImage()
    const pending2 = page.pendingUploadInfo.value.uploadId
    page.discardPendingUpload()
    assert.equal(page.pendingUploadInfo.value, null)
    await page.handleUploadImage() // 重新选图（新 uploadId）
    assert.equal(uniCalls.chooseImage, chooseBefore + 4, '丢弃后重新选图')
    assert.notEqual(page.registeredFileId.value, firstId)
    assert.notEqual(page.registeredFileId.value, `papa:${pending2}`)
    delete process.env.MC_UPLOAD_ENABLED
  })

  await scenario('B1-页面：goDemo 使用 redirectTo（非 switchTab）', async () => {
    const page = buildFamilyPage()
    const beforeR = uniCalls.redirectTo
    const beforeS = uniCalls.switchTab
    page.goDemo()
    assert.equal(uniCalls.redirectTo, beforeR + 1)
    assert.equal(uniCalls.switchTab, beforeS)
  })

  // ── 旧 Cloudflare 正式入口零调用（真实页面处理函数）──
  function extractFn(relPath, fnName, deps) {
    const source = fs.readFileSync(path.join(root, relPath), 'utf8')
    const markers = [`async function ${fnName}(`, `function ${fnName}(`]
    let start = -1
    for (const marker of markers) {
      const idx = source.indexOf(marker)
      if (idx !== -1) { start = idx; break }
    }
    assert.ok(start !== -1, `${relPath} 未找到 ${fnName}`)
    const braceStart = source.indexOf('{', start)
    let depth = 0, end = -1
    for (let i = braceStart; i < source.length; i++) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
    }
    return new Function(...deps, `return (${source.slice(start, end)});`)
  }

  await scenario('B1-旧入口零调用：login/knowledge/UploadSheet/detail AI 处理函数零网络请求', async () => {
    // login 页已重写（R2）：无旧登录处理函数；入口跳转由 R2 场景覆盖
    // knowledge fetchArticles（需 refs）
    const fetchArticles = extractFn('pages/knowledge/index.vue', 'fetchArticles', ['loadError', 'articleList', 'loading', 'loadingMore', 'activeTab'])
    await fetchArticles({ value: '' }, { value: [] }, { value: false }, { value: false }, { value: 'recommended' })(true)
    // UploadSheet handleUploadResult（真实 token 也停用）
    const handleUploadResult = extractFn('pages/archives/components/UploadSheet.vue', 'handleUploadResult',
      ['reportStore', 'uni', 'isGuestMode', 'API_BASE', 'getToken', 'request'])
    const storeStub = { pendingUpload: null }
    global.__legacy_token = ''
    const uploadRes = await handleUploadResult(storeStub, global.uni, () => false, 'https://legacy', () => 'a-real-token', () => {})()
    assert.equal(uploadRes, undefined)
    // detail onAiCardTap
    const onAi = extractFn('pages/archives/detail.vue', 'onAiCardTap', ['aiStatus', 'reportId', 'healthStore', 'reportStore', 'uni'])
    await onAi({ value: 'pending' }, { value: 'r1' }, { canUseAiInterpret: () => true }, {}, global.uni)()
    assert.equal(uniCalls.requests, 0, '零旧 Cloudflare 调用')
    assert.equal(uniCalls.uploadFile, 0, '零旧二进制上传')
    assert.ok(uniCalls.toasts.some(t => /未接入|未启用|已停用/.test(t)))
  })

  await scenario('B1-门：legacyHttpEnabled 恒为 false（运行时入口全部短路）', async () => {
    assert.equal(api.legacyHttpEnabled(), false)
    assert.equal(api.FORMAL_BACKEND, 'cloudbase')
  })

  // ───────── R2：集中边界 / 实际路径 / 页面身份内容清理 / 新用户入口 ─────────

  await scenario('R2-集中门：report.uploadAndCreateReport 二进制上传同样被拦截（直连 store 探针）', async () => {
    api.setActivePinia(api.createPinia())
    storage.clear()
    // 生产默认：未开启旧 HTTP 门；真实 token + 完整参数（历史上最易触发 workers.dev 直连的形态）
    api.setToken('stale-real-token')
    const report = api.useReportStore()
    const res = await report.uploadAndCreateReport({
      report_type: 'blood_routine',
      report_date: '2026-09-19',
      localPaths: ['tmp://report.jpg'],
      file_urls: ['tmp://report.jpg']
    })
    assert.equal(res, null, '旧上传入口 fail closed 返回失败')
    assert.equal(uniCalls.uploadFile, 0, '零 uni.uploadFile 调用')
    assert.equal(uniCalls.requests, 0)
    assert.ok(uniCalls.toasts.some(t => /已停用/.test(t)), '如实提示停用而非伪成功')
  })

  await scenario('R2-门：legacyFormalStoresEnabled 默认 false（旧正式键隔离）', async () => {
    assert.equal(api.legacyFormalStoresEnabled(), false)
    assert.ok(api.formalStoresQuarantineMessage().includes('隔离'))
  })

  await scenario('R2-集中 HTTP 门：request 一律拒绝且零网络调用', async () => {
    await assert.rejects(
      () => api.request({ url: '/api/login', method: 'POST', data: {} }),
      e => e.legacyDisabled === true && e.code === 'legacy-disabled'
    )
    assert.equal(uniCalls.requests, 0)
  })

  await scenario('R2-实际冷启动探针：旧正式键隔离，磁盘保留、零加载渲染、拒绝写入', async () => {
    // Codex 复现形态：无归属的旧 YUNTU 正式数据 + 遗留真实 token
    api.setActivePinia(api.createPinia())
    storage.clear()
    storage.set('momcare_token', 'stale-legacy-token')
    storage.set('YUNTU_HEALTH_DATA', JSON.stringify({
      schemaVersion: 2, origin: 'formal',
      lmpDate: new Date(2026, 0, 1).toISOString(),
      userInfo: { nickname: 'OLDPRIVATEPERSON' },
      records: { '2026-09-10': { weight: '60' } },
      checkupSchedules: [{ _id: 'local_7_x', status: 'upcoming' }]
    }))
    storage.set('YUNTU_REPORTS_DATA', JSON.stringify({
      reports: [{ _id: 'OLDPRIVATEREPORT', archive_status: 'archived', report_date: '2026-09-01', report_type: 'blood_routine' }],
      unarchivedReports: []
    }))
    const healthRawBefore = storage.get('YUNTU_HEALTH_DATA')
    const reportsRawBefore = storage.get('YUNTU_REPORTS_DATA')

    const health = api.useHealthStore()
    const report = api.useReportStore()
    // 实际 App 初始化路径：App.onLaunch → initializeApp
    health.initializeApp()
    // 首页/档案/我的 实际加载路径
    await health.loadUserProfile()
    await health.loadRecords()
    await health.loadCheckupSchedules()
    await report.fetchReports()
    await report.fetchUnarchivedReports()

    // 无旧身份内容被加载/渲染
    assert.equal(health.userInfo.nickname, '', '旧昵称不得显示')
    assert.equal(health.lmpDate, null)
    assert.equal(Object.keys(health.records).length, 0)
    assert.equal(health.checkupSchedules.length, 0)
    assert.equal(report.reports.length, 0, '旧报告不得显示')
    assert.equal(report.unarchivedReports.length, 0)

    // 拒绝写入旧正式键（如实暴露隔离原因）
    const saved = await health.saveRecord(new Date(), { note: 'x' })
    assert.equal(saved.persisted, false)
    assert.ok(health.lastPersistError.includes('隔离'))

    // 磁盘数据逐字节保留（待 B3 迁移），且零旧 HTTP（含 stale token 路径）
    assert.equal(storage.get('YUNTU_HEALTH_DATA'), healthRawBefore)
    assert.equal(storage.get('YUNTU_REPORTS_DATA'), reportsRawBefore)
    health.syncCloudData().catch(() => {})
    await new Promise(r => setTimeout(r, 0))
    assert.equal(uniCalls.requests, 0)

    // 演示键不受隔离影响：演示模式完整可用
    assert.equal(health.enterDemoMode(), true)
    assert.equal(health.userInfo.nickname, '幸福准妈妈')
    const demoSave = await health.saveRecord(new Date(), { note: 'demo ok' })
    assert.equal(demoSave.persisted, true)
    assert.equal(JSON.parse(storage.get('YUNTU_HEALTH_DATA')).userInfo.nickname, 'OLDPRIVATEPERSON', '正式键仍原样')
    api.__resetForTests()
  })

  await maybePage('R2-页面：身份切换清理敏感输入（Codex canary 复现）', async () => {
    api.__setCloudConfigForTests('env-t', 'wxapp-t')
    const cloud = makeMockCloud()
    setServerEnv()
    let currentMember = 'mama'
    const ctxOpenid = () => currentMember === 'mama' ? TEST_ENV.MC_MEMBER_MAMA_OPENID : TEST_ENV.MC_MEMBER_PAPA_OPENID
    handlers.identity.__setCloud(cloud)
    handlers.shared.__setCloud(cloud)
    handlers.private.__setCloud(cloud)
    handlers.files.__setCloud(cloud)
    const applyCtx = () => cloud.__setCtx(ctxOpenid(), TEST_ENV.MC_APPID)
    applyCtx()
    // 预置：妈妈与爸爸各有今日私人笔记
    await handlers.private.main({ action: 'upsert', dateKey: TODAY, content: 'MAMA_NOTE', expectedRevision: 0, operationId: 'seed-mama' })
    currentMember = 'papa'
    applyCtx()
    await handlers.private.main({ action: 'upsert', dateKey: TODAY, content: 'PAPA_NOTE', expectedRevision: 0, operationId: 'seed-papa' })

    const wxCloud = freshFakeWxCloud({
      'mc-identity': () => { applyCtx(); return handlers.identity.main({}) },
      'mc-shared-records': e => { applyCtx(); return handlers.shared.main(e) },
      'mc-private-notes': e => { applyCtx(); return handlers.private.main(e) },
      'mc-files': e => { applyCtx(); return handlers.files.main(e) }
    })
    api.__setWxCloud(wxCloud)
    const page = buildFamilyPage()
    page.__cfg('env-t', 'wxapp-t')
    page.__wx(wxCloud)
    page.__reset()
    currentMember = 'mama'
    applyCtx()
    await page.handleConfirm(false)
    assert.equal(page.session.value.member.memberId, 'mama')
    // 用户输入妈妈的私人内容（未保存）
    page.privateInput.value = 'MAMA_PRIVATE_CANARY'
    // 重新确认返回爸爸
    currentMember = 'papa'
    applyCtx()
    await page.handleConfirm(false)
    assert.equal(page.session.value.member.memberId, 'papa')
    // 敏感输入被清理并回填爸爸的数据；妈妈的 canary 不可见
    assert.equal(page.privateInput.value, 'PAPA_NOTE')
    assert.ok(!page.privateInput.value.includes('CANARY'))
    assert.ok(!JSON.stringify(page.sharedMsg.value).includes('CANARY'))
  })

  await maybePage('R2-页面：明确拒绝时清理敏感输入', async () => {
    api.__setCloudConfigForTests('env-t', 'wxapp-t')
    let rejectNext = false
    const wxCloud = freshFakeWxCloud({
      'mc-identity': () => rejectNext
        ? { ok: false, code: 'not-family-member', message: '仅限本家庭成员使用' }
        : { ok: true, data: { memberId: 'mama', displayName: '妈妈', familyId: 'f' } }
    })
    api.__setWxCloud(wxCloud)
    const page = buildFamilyPage()
    page.__cfg('env-t', 'wxapp-t')
    page.__wx(wxCloud)
    page.__reset()
    await page.handleConfirm(false)
    page.privateInput.value = 'SHOULD_BE_CLEARED'
    page.sharedInput.value = { weightKg: '70' }
    rejectNext = true
    await page.handleConfirm(false)
    assert.equal(page.session.value.status, 'rejected')
    assert.equal(page.privateInput.value, '', '拒绝后敏感输入清空')
    assert.equal(page.sharedInput.value.weightKg, '')
  })

  await scenario('R2-实际退出按钮：confirmLogout 真实处理函数使云身份失效', async () => {
    api.__setCloudConfigForTests('env-t', 'wxapp-t')
    const wxCloud = freshFakeWxCloud({
      'mc-identity': () => ({ ok: true, data: { memberId: 'mama', displayName: '妈妈', familyId: 'f' } })
    })
    api.__setWxCloud(wxCloud)
    api.__resetForTests()
    await api.confirmIdentity()
    assert.equal(api.getSessionState().member.memberId, 'mama')
    // 妈妈的草稿（保留在原成员命名空间）
    api.stashDraft({ privateNote: 'mama draft kept' })

    // 提取真实 confirmLogout（profile 页 script setup）
    const confirmLogout = extractFn('pages/profile/index.vue', 'confirmLogout',
      ['healthStore', 'removeToken', 'endSession', 'uni', 'showLogoutModal'])
    let removedToken = false
    let ended = false
    const reLaunchBefore = uniCalls.reLaunch
    await confirmLogout(
      { exitSession: () => true },
      () => { removedToken = true },
      () => { ended = true; api.endSession() },
      global.uni,
      { value: true }
    )()
    assert.ok(removedToken, 'token 已清除')
    assert.ok(ended, 'endSession 已调用')
    assert.equal(uniCalls.reLaunch, reLaunchBefore + 1, '已 reLaunch 到登录页')
    // 云身份失效：会话未确认、缓存关闭；草稿保留在原成员键下（未删除）
    assert.equal(api.getSessionState().status, 'unconfirmed')
    assert.equal(api.getSessionState().member, null)
    assert.equal(api.getMemberCache('any'), null)
    // 恢复妈妈身份后草稿仍在
    await api.confirmIdentity()
    assert.equal(api.pendingDrafts().privateNote, 'mama draft kept')
  })

  await scenario('R2-深链知识详情：缓存可用则展示，否则如实未接入，零旧 HTTP', async () => {
    const loadArticleById = extractFn('pages/knowledge/detail.vue', 'loadArticleById',
      ['error', 'loading', 'article', 'uni'])
    const errRef = { value: '' }
    const loadingRef = { value: true }
    const articleRef = { value: null }
    // 无缓存：如实提示，不发请求
    await loadArticleById(errRef, loadingRef, articleRef, global.uni)({ id: 'a1' })
    assert.ok(errRef.value.includes('尚未接入'))
    assert.equal(loadingRef.value, false)
    assert.equal(uniCalls.requests, 0)
    // 有缓存：展示缓存文章
    storage.set('cached_articles', JSON.stringify([{ id: 'a2', title: '缓存文章' }]))
    await loadArticleById(errRef, loadingRef, articleRef, global.uni)({ id: 'a2' })
    assert.equal(articleRef.value.title, '缓存文章')
    assert.equal(uniCalls.requests, 0)
    storage.delete('cached_articles')
  })

  await maybePage('R2-页面竞态：私人保存跨身份切换，草稿留在原成员、零 UI 污染（Item6 复现）', async () => {
    api.__setCloudConfigForTests('env-t', 'wxapp-t')
    const cloud = makeMockCloud()
    setServerEnv()
    handlers.identity.__setCloud(cloud)
    handlers.shared.__setCloud(cloud)
    handlers.private.__setCloud(cloud)
    handlers.files.__setCloud(cloud)
    let currentMember = 'mama'
    const applyCtx = () => cloud.__setCtx(
      currentMember === 'mama' ? TEST_ENV.MC_MEMBER_MAMA_OPENID : TEST_ENV.MC_MEMBER_PAPA_OPENID,
      TEST_ENV.MC_APPID)
    applyCtx()
    // 私人保存的云回调可挂起（复现"保存进行中切换身份"）
    const pendingPrivateSaves = []
    const wxCloud = freshFakeWxCloud({
      'mc-identity': () => { applyCtx(); return handlers.identity.main({}) },
      'mc-shared-records': e => { applyCtx(); return handlers.shared.main(e) },
      // 仅挂起 upsert（被测竞态）；get 走真实 handler 立即返回，避免确认流程死锁
      'mc-private-notes': e => e.action === 'upsert'
        ? new Promise(r => pendingPrivateSaves.push({ e, r }))
        : (applyCtx(), handlers.private.main(e)),
      'mc-files': e => { applyCtx(); return handlers.files.main(e) }
    })
    api.__setWxCloud(wxCloud)
    const page = buildFamilyPage()
    page.__cfg('env-t', 'wxapp-t')
    page.__wx(wxCloud)
    page.__reset()
    await page.handleConfirm(false)
    assert.equal(page.session.value.member.memberId, 'mama')

    // 妈妈发起私人保存（含 canary），回调暂缓
    page.privateInput.value = 'MAMA_SAVE_CANARY'
    const savePromise = page.handleSavePrivate()
    await new Promise(r => setTimeout(r, 0))
    assert.equal(pendingPrivateSaves.length, 1, '保存请求已挂起')

    // 确认切换为爸爸并完成
    currentMember = 'papa'
    applyCtx()
    await page.handleConfirm(false)
    assert.equal(page.session.value.member.memberId, 'papa')
    // 爸爸名下此刻【没有】任何草稿（预暂存发生在切换前的妈妈会话）
    assert.equal(page.pendingDrafts(), null, '切换后、迟到响应前：新身份无草稿')

    // 释放妈妈的保存回调 → familyCall 返回 stale-session → 页面零副作用
    pendingPrivateSaves[0].r({ ok: true, data: { note: { content: 'MAMA_SAVE_CANARY', revision: 1 } } })
    await savePromise
    // 草稿在妈妈名下（预暂存于发起时），爸爸读不到
    assert.equal(page.pendingDrafts(), null, '爸爸会话读不到草稿')
    assert.equal(page.privateInput.value, 'PAPA_NOTE', '爸爸输入框回填爸爸数据而非 canary')
    // 重新确认妈妈 → 草稿恢复为 canary
    currentMember = 'mama'
    applyCtx()
    await page.handleConfirm(false)
    const draft = page.pendingDrafts()
    assert.equal(draft && draft.privateNote, 'MAMA_SAVE_CANARY', '妈妈的草稿保留在原成员名下')
  })

  await maybePage('R2-页面竞态：共享保存跨身份切换同样零污染', async () => {
    api.__setCloudConfigForTests('env-t', 'wxapp-t')
    const cloud = makeMockCloud()
    setServerEnv()
    handlers.identity.__setCloud(cloud)
    handlers.shared.__setCloud(cloud)
    handlers.private.__setCloud(cloud)
    handlers.files.__setCloud(cloud)
    let currentMember = 'mama'
    const applyCtx = () => cloud.__setCtx(
      currentMember === 'mama' ? TEST_ENV.MC_MEMBER_MAMA_OPENID : TEST_ENV.MC_MEMBER_PAPA_OPENID,
      TEST_ENV.MC_APPID)
    applyCtx()
    const pendingSharedSaves = []
    const wxCloud = freshFakeWxCloud({
      'mc-identity': () => { applyCtx(); return handlers.identity.main({}) },
      // 仅挂起 upsert；get 走真实 handler 立即返回
      'mc-shared-records': e => e.action === 'upsert'
        ? new Promise(r => pendingSharedSaves.push({ e, r }))
        : (applyCtx(), handlers.shared.main(e)),
      'mc-private-notes': e => { applyCtx(); return handlers.private.main(e) },
      'mc-files': e => { applyCtx(); return handlers.files.main(e) }
    })
    api.__setWxCloud(wxCloud)
    const page = buildFamilyPage()
    page.__cfg('env-t', 'wxapp-t')
    page.__wx(wxCloud)
    page.__reset()
    await page.handleConfirm(false)
    page.sharedInput.value.weightKg = '66.6'
    const savePromise = page.handleSaveShared()
    await new Promise(r => setTimeout(r, 0))
    currentMember = 'papa'
    applyCtx()
    await page.handleConfirm(false)
    assert.equal(pendingSharedSaves.length, 1)
    pendingSharedSaves[0].r({ ok: true, data: { record: { revision: 1, payload: { weightKg: 66.6 } } } })
    await savePromise
    // 爸爸会话：无共享草稿、无成功提示污染
    assert.equal(page.pendingDrafts(), null)
    assert.equal(page.sharedMsg.value, '', '迟到成功不产生提示')
    assert.equal(page.sharedRecord.value, null, '迟到成功不写共享展示')
    // 妈妈名下草稿保留 weightKg
    currentMember = 'mama'
    applyCtx()
    await page.handleConfirm(false)
    assert.equal(page.pendingDrafts().weightKg, '66.6')
  })

  await maybePage('R2-页面：瞬时离线确认保留未保存输入', async () => {
    storage.clear() // 场景隔离：清除前序场景遗留的草稿/缓存键
    api.__setCloudConfigForTests('env-t', 'wxapp-t')
    let offline = false
    const wxCloud = freshFakeWxCloud({
      'mc-identity': () => offline
        ? (() => { throw { errMsg: 'request:fail offline' } })()
        : { ok: true, data: { memberId: 'mama', displayName: '妈妈', familyId: 'f' } }
    })
    api.__setWxCloud(wxCloud)
    const page = buildFamilyPage()
    page.__cfg('env-t', 'wxapp-t')
    page.__wx(wxCloud)
    page.__reset()
    await page.handleConfirm(false)
    page.privateInput.value = 'UNSAVED_KEEP_ME'
    page.sharedInput.value = { weightKg: '77.7' }
    offline = true
    await page.handleConfirm(true) // 手动刷新遇离线
    assert.equal(page.privateInput.value, 'UNSAVED_KEEP_ME', '瞬时失败不清输入')
    assert.equal(page.sharedInput.value.weightKg, '77.7')
    // 恢复在线：重新确认成功，输入仍在
    offline = false
    await page.handleConfirm(false)
    assert.equal(page.privateInput.value, 'UNSAVED_KEEP_ME')
  })

  await maybePage('R2-页面：业务身份拒绝立即锁定清屏（不依赖下一次确认）', async () => {
    api.__setCloudConfigForTests('env-t', 'wxapp-t')
    const cloud = makeMockCloud()
    setServerEnv()
    handlers.identity.__setCloud(cloud)
    handlers.shared.__setCloud(cloud)
    handlers.private.__setCloud(cloud)
    handlers.files.__setCloud(cloud)
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID, TEST_ENV.MC_APPID)
    // 私人 upsert 直接返回业务身份拒绝（真实服务形状；get 正常，确保确认先成功）
    const wxCloud = freshFakeWxCloud({
      'mc-identity': () => handlers.identity.main({}),
      'mc-shared-records': e => handlers.shared.main(e),
      'mc-private-notes': e => e.action === 'upsert'
        ? { ok: false, code: 'not-family-member', message: '仅限本家庭成员使用' }
        : handlers.private.main(e),
      'mc-files': e => handlers.files.main(e)
    })
    api.__setWxCloud(wxCloud)
    const page = buildFamilyPage()
    page.__cfg('env-t', 'wxapp-t')
    page.__wx(wxCloud)
    page.__reset()
    await page.handleConfirm(false)
    assert.equal(page.session.value.status, 'confirmed')
    page.privateInput.value = 'PRIVATECANARY'
    // 直接调用真实保存处理函数：服务拒绝 → 页面立即锁定并清屏
    await page.handleSavePrivate()
    assert.equal(page.session.value.status, 'rejected', '页面同步权威会话状态')
    assert.equal(page.privateInput.value, '', 'canary 立即清除')
    assert.ok(page.sharedMsg.value.includes('已锁定'), '给出锁定说明')
    // 锁定后成员无关读取也不放行（会话服务已锁定）
    const after = await page.handleSavePrivate()
    void after
    assert.equal(page.privateInput.value, '')
  })

  await maybePage('R2-页面：暂存失败如实上报，不声称已保存本机（Item6 探针2）', async () => {
    api.__setCloudConfigForTests('env-t', 'wxapp-t')
    storage.clear()
    // 让草稿键写入失败（真实存储配额/不可写形状），云调用同时离线失败
    const realSet = global.uni.setStorageSync
    global.uni.setStorageSync = (k, v) => {
      if (String(k).includes('mc_draft_')) throw new Error('synthetic quota exceeded')
      return realSet(k, v)
    }
    const wxCloud = freshFakeWxCloud({
      'mc-identity': () => ({ ok: true, data: { memberId: 'mama', displayName: '妈妈', familyId: 'f' } }),
      'mc-private-notes': () => { throw { errMsg: 'request:fail offline' } },
      'mc-shared-records': () => { throw { errMsg: 'request:fail offline' } },
      'mc-files': () => { throw { errMsg: 'request:fail offline' } }
    })
    api.__setWxCloud(wxCloud)
    const page = buildFamilyPage()
    page.__cfg('env-t', 'wxapp-t')
    page.__wx(wxCloud)
    page.__reset()
    await page.handleConfirm(false)
    page.privateInput.value = 'PRECIOUS_INPUT'
    await page.handleSavePrivate()
    global.uni.setStorageSync = realSet
    // 如实报告：不得出现"已暂存/已保存本机"；输入保留
    assert.ok(!page.privateMsg.value.includes('已暂存'), '不得声称已暂存：' + page.privateMsg.value)
    assert.ok(page.privateMsg.value.includes('暂存也未成功'), '如实说明暂存失败')
    assert.equal(page.pendingDrafts(), null, '无草稿被写入')
    assert.equal(page.privateInput.value, 'PRECIOUS_INPUT', '输入保留')
  })

  await scenario('R2-登录页新入口：直达家庭空间（navigateTo），演示入口保留', async () => {
    const goFamily = extractFn('pages/login/index.vue', 'goFamily', ['uni'])
    const before = uniCalls.navigateTo
    goFamily(global.uni)()
    assert.equal(uniCalls.navigateTo, before + 1)
    // 演示入口仍是真实处理函数且不影响正式数据（Phase A 场景已覆盖 enterDemoMode 语义）
  })
}

// ───────────────────────── 汇总 ─────────────────────────
async function main() {
  console.log('阶段 B1 回归测试（隔离模拟：契约 mock / 全栈页面 / 组装产物）\n')
  await serverMain()
  await clientMain()
  console.log(`\n通过 ${passed} 项，失败 ${failed.length} 项`)
  if (failed.length > 0) {
    console.log('失败场景：', failed.join(' | '))
    process.exitCode = 1
  }
}

main().catch(e => { console.error(e); process.exitCode = 1 })
  .finally(() => fs.rmSync(temp, { recursive: true, force: true }))
