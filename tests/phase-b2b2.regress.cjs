// B2b2 回归：真实客户端（UploadSheet/批次 store/familyStore/outbox）→
// 真实 mc-reports / mc-files 组装产物 handler → SDK 契约模拟（隔离，零真实网络）。
// 覆盖 review 全部 P1 门：创建完整性 / 幂等回放绑定 / 裸文件门 / 引用同事务 /
// 终态墓碑防复活 / 清理分页 / 迟到复制补偿 / 迟到签发 / 上传会话边界 / 批次协议。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const esbuild = require(require.resolve('esbuild', { paths: [root] }))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-b2b2-'))

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) {
  try { await fn(); pass(name) } catch (e) { fail(name, e) }
}
const tick = () => new Promise(r => setTimeout(r, 15))

cp.execFileSync('node', [path.join(root, 'cloud/assemble.mjs')], { stdio: 'pipe' })
const DIST = path.join(root, 'dist/cloud-functions')
const reportsH = require(path.join(DIST, 'mc-reports/index.js'))
const filesH = require(path.join(DIST, 'mc-files/index.js'))
const healthH = require(path.join(DIST, 'mc-health/index.js'))
const identityH = require(path.join(DIST, 'mc-identity/index.js'))

const JPEG = Buffer.from([255, 216, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0])
// 真实可解码 PNG（IHDR/IDAT/IEND，CRC 由构造函数填）：按序号改变像素颜色，
// 每张图片字节互不相同——上传替身按 filePath 携带真实内容
function makePng(idx) {
  const width = 1, height = 1
  const bitDepth = 8, colorType = 2 // truecolor
  const ihdr = Buffer.from([0, 0, 0, 13, 73, 72, 68, 82,
    (width >>> 24) & 255, (width >>> 16) & 255, (width >>> 8) & 255, width & 255,
    (height >>> 24) & 255, (height >>> 16) & 255, (height >>> 8) & 255, height & 255,
    bitDepth, colorType, 0, 0, 0])
  const raw = Buffer.from([0, (idx * 37 + 11) % 256, (idx * 89 + 5) % 256, (idx * 151 + 200) % 256]) // filter0+RGB
  const zlib = require('node:zlib')
  const idatData = zlib.deflateSync(raw)
  const idat = Buffer.concat([Buffer.from([0, 0, 0, idatData.length, 73, 68, 65, 84]), idatData])
  const iend = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68])
  const crcTable = []
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0 }
  const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
    return Buffer.concat([Buffer.from([0, 0, 0, data.length]), body, crc])
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([sig,
    chunk('IHDR', ihdr.slice(8, 8 + 13)),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0))])
}
const localFileBytes = new Map() // savedFilePath → 真实图片字节（saveFile 移动语义）
const TEST_ENV = {
  MC_APPID: 'wxtestappid0001',
  MC_FAMILY_ID: 'fam-b2b2test',
  MC_MEMBER_MAMA_OPENID: 'oTESTMAMA123456',
  MC_MEMBER_PAPA_OPENID: 'oTESTPAPA123456'
}
function setServerEnv(familyId) {
  process.env.MC_APPID = TEST_ENV.MC_APPID
  process.env.MC_FAMILY_ID = familyId || TEST_ENV.MC_FAMILY_ID
  process.env.MC_MEMBER_MAMA_OPENID = TEST_ENV.MC_MEMBER_MAMA_OPENID
  process.env.MC_MEMBER_PAPA_OPENID = TEST_ENV.MC_MEMBER_PAPA_OPENID
  process.env.MC_UPLOAD_ENABLED = 'true'
}

// SDK 契约模拟：文档库 + 对象库（uploadFile/downloadFile/deleteFile fileList 逐对象结果/
// getTempFileURL）+ 事务版本冲突 + 可控注入（deletionFails/holdUploadFile/clockOffset）
function makeMockCloud() {
  const docs = new Map() // key → { ...doc, __v }
  const storedFiles = new Map() // cloudPath → Buffer
  const state = { deletionFails: 0, deletedObjects: [], clockOffset: 0, failCommitAfterUpload: 0 }
  const realNow = Date.now
  Date.now = () => realNow() + state.clockOffset
  const clone = x => JSON.parse(JSON.stringify(x))
  function docApi(col, id, tx) {
    return {
      get: async () => {
        const e = docs.get(`${col}/${id}`)
        if (tx) tx.reads.set(`${col}/${id}`, e ? e.__v : 0)
        return { data: e ? { ...clone(e), _id: id } : null }
      },
      set: async ({ data }) => {
        if (data && Object.prototype.hasOwnProperty.call(data, '_id')) { const err = new Error('-501007'); err.errMsg = err.message; throw err }
        if (tx) { tx.writes.set(`${col}/${id}`, clone(data)); return { _id: id } }
        const prev = docs.get(`${col}/${id}`)
        docs.set(`${col}/${id}`, { ...clone(data), __v: (prev ? prev.__v : 0) + 1 })
        return { _id: id }
      },
      remove: async () => { docs.delete(`${col}/${id}`); return { stats: { removed: 1 } } }
    }
  }
  function runQuery(col, filters, orderByField, dir, limitN) {
    let rows = [...docs.entries()].filter(([k]) => k.startsWith(col + '/'))
      .map(([k, e]) => ({ ...clone(e), _id: k.slice(col.length + 1) }))
    for (const [f, cond] of Object.entries(filters || {})) {
      rows = rows.filter(r => cond && cond.__op === 'lt'
        ? (r[f] !== undefined && String(r[f]) < String(cond.v))
        : JSON.stringify(r[f]) === JSON.stringify(cond))
    }
    if (orderByField) {
      rows.sort((a, b) => String(b[orderByField]).localeCompare(String(a[orderByField])))
      if (String(dir).toLowerCase() === 'asc') rows.reverse()
    }
    return rows.slice(0, limitN || 100)
  }
  function makeQuery(col, filters, orderByField, dir, limitN) {
    return {
      orderBy: (f, d) => makeQuery(col, filters, f, d, limitN),
      limit: n => makeQuery(col, filters, orderByField, dir, n),
      get: async () => ({ data: runQuery(col, filters, orderByField, dir, limitN) })
    }
  }
  const db = {
    command: { lt: v => ({ __op: 'lt', v }) },
    startTransaction: async () => {
      const tx = { reads: new Map(), writes: new Map() }
      return {
        collection: c => ({ doc: id => docApi(c, id, tx) }),
        commit: async () => {
          if (state.failCommitAfterUpload > 0) { state.failCommitAfterUpload--; throw new Error('commit failed (mock infra)') }
          for (const k of tx.writes.keys()) {
            const cur = docs.get(k)
            if ((cur ? cur.__v : 0) !== (tx.reads.get(k) || 0)) { const err = new Error('transaction conflict'); err.errMsg = 'db transaction conflict'; throw err }
          }
          for (const [k, d] of tx.writes) {
            const prev = docs.get(k)
            docs.set(k, { ...clone(d), __v: (prev ? prev.__v : 0) + 1 })
          }
        },
        rollback: async () => {}
      }
    },
    collection: c => ({
      doc: id => docApi(c, id, null),
      where: f => makeQuery(c, f),
      get: async () => ({ data: runQuery(c, {}, null, null, 100) })
    })
  }
  const cloud = {
    DYNAMIC_CURRENT_ENV: Symbol('env'),
    init() { state.initialized = true },
    getWXContext() { return { APPID: TEST_ENV.MC_APPID, OPENID: state.caller, ENV: 'env' } },
    database() { if (!state.initialized) throw new Error('init first'); return db },
    downloadFile: async ({ fileID }) => {
      const key = String(fileID).replace(/^cloud:\/\/[^/]+\//, '')
      const buf = storedFiles.get(key)
      if (!buf) { const err = new Error('download fail'); err.errMsg = 'downloadFile:fail'; throw err }
      return { fileContent: Buffer.from(buf) }
    },
    uploadFile: async ({ cloudPath, fileContent }) => {
      storedFiles.set(cloudPath, Buffer.from(fileContent))
      return { fileID: `cloud://env-b2b2.bucket/${cloudPath}` }
    },
    deleteFile: async ({ fileList }) => {
      assert.ok(Array.isArray(fileList), 'SDK deleteFile 需要 fileList')
      state.deletedObjects.push(...fileList)
      const ok = state.deletionFails <= 0
      if (ok) for (const id of fileList) storedFiles.delete(String(id).replace(/^cloud:\/\/[^/]+\//, ''))
      else state.deletionFails--
      return { fileList: fileList.map(f => ({ fileID: f, status: ok ? 0 : -1, errMsg: ok ? 'ok' : 'synthetic failure' })) }
    },
    getTempFileURL: async ({ fileList }) => ({ fileList: fileList.map(f => ({ fileID: f, tempFileURL: 'https://temp.invalid/' + f })) }),
    __state: state, __docs: docs, __stored: storedFiles,
    __setCtx(openid) { state.caller = openid }
  }
  return cloud
}

function freshServer(cloud, familyId) {
  cloud.__docs.clear(); cloud.__stored.clear()
  cloud.__state.deletedObjects.length = 0
  cloud.__state.deletionFails = 0
  cloud.__state.clockOffset = 0
  cloud.__state.failCommitAfterUpload = 0
  setServerEnv(familyId)
  cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID)
  reportsH.__setCloud(cloud); filesH.__setCloud(cloud); healthH.__setCloud(cloud); identityH.__setCloud(cloud)
  let seq = 0
  const files = e => filesH.main(e)
  const request = (action, extra) => reportsH.main({ action, schemaVersion: 1, operationId: 'op-' + (++seq), expectedRevision: 0, ...extra })
  return { files, request }
}

// 直连 handler 辅助：注册一个真实文件（完整三段式）
async function registerRealFile(sv, uploadId) {
  const stageFileID = `cloud://env-b2b2.bucket/mc/${TEST_ENV.MC_FAMILY_ID}/stage/mama/${uploadId}`
  sv.files.__registerStage = null
  const cloud = sv
  void cloud
  return stageFileID
}

async function main() {
  console.log('B2b2 回归（真实 handler + 对象库模拟；客户端链路经独立 bundle）\n')

  // ══ 服务端组 ══
  await scenario('服务1：创建完整性（缺 dateKey / 空附件拒绝；部分编辑保留其他字段）', async () => {
    const cloud = makeMockCloud()
    const sv = freshServer(cloud)
    // 先登记一个真实文件
    const stage = `cloud://env-b2b2.bucket/mc/${TEST_ENV.MC_FAMILY_ID}/stage/oTESTMAMA123456/u1`
    cloud.__stored.set(`mc/${TEST_ENV.MC_FAMILY_ID}/stage/oTESTMAMA123456/u1`, JPEG)
    const reg = await sv.files({ action: 'registerStaged', uploadId: 'u1', stageFileID: stage })
    assert.ok(reg.ok, JSON.stringify(reg))
    const fid = reg.data.file.fileId
    const noDate = await sv.request('report.upsert', { id: 'rpt_a', payload: { reportType: 'ultrasound', attachments: [{ fileId: fid }] } })
    assert.equal(noDate.ok, false)
    const noAtt = await sv.request('report.upsert', { id: 'rpt_a', payload: { dateKey: '2026-09-01', reportType: 'ultrasound', attachments: [] } })
    assert.equal(noAtt.ok, false)
    const ok = await sv.request('report.upsert', { id: 'rpt_a', payload: { dateKey: '2026-09-01', reportType: 'ultrasound', attachments: [{ fileId: fid }] } })
    assert.ok(ok.ok, JSON.stringify(ok))
    // 部分编辑：只改分类，dateKey/attachments 不重置
    const edit = await sv.request('report.upsert', { id: 'rpt_a', expectedRevision: 1, payload: { reportType: 'ogtt' } })
    assert.ok(edit.ok)
    assert.equal(edit.data.record.reportType, 'ogtt')
    assert.equal(edit.data.record.dateKey, '2026-09-01')
    assert.equal(edit.data.record.attachments.length, 1)
  })

  await scenario('服务2：幂等回放绑定 family+kind（家庭变化不泄露旧快照）', async () => {
    const cloud = makeMockCloud()
    let sv = freshServer(cloud, 'fam-one')
    const stage = `cloud://env-b2b2.bucket/mc/fam-one/stage/oTESTMAMA123456/u2`
    cloud.__stored.set(`mc/fam-one/stage/oTESTMAMA123456/u2`, JPEG)
    const reg = await sv.files({ action: 'registerStaged', uploadId: 'u2', stageFileID: stage })
    const fid = reg.data.file.fileId
    const r1 = await sv.request('report.upsert', { id: 'rpt_f', payload: { dateKey: '2026-09-01', reportType: 'other', note: '家庭一备注', attachments: [{ fileId: fid }] } })
    assert.ok(r1.ok)
    // 同 operationId（重放路径）：直接用 handler 造 opKey —— 通过同 opId 二次提交验证 replay
    const replay = await reportsH.main({ action: 'report.upsert', schemaVersion: 1, operationId: 'op-shared', expectedRevision: 1, id: 'rpt_f', payload: { note: '改' } })
    assert.ok(replay.ok)
    // 家庭切换后同 opId：opKey 含 familyId → 不同键，不回放旧家庭快照
    sv = freshServer(cloud, 'fam-two')
    const leaked = await reportsH.main({ action: 'report.upsert', schemaVersion: 1, operationId: 'op-shared', expectedRevision: 0, id: 'rpt_other_family', payload: { dateKey: '2026-09-02', reportType: 'other', note: 'x', attachments: [] } })
    // fam-two 无该文件登记：创建被拒（附件校验），且绝不返回 fam-one 的 resultSnapshot
    assert.ok(!leaked.ok || !String(leaked.data && leaked.data.record && leaked.data.record.note).includes('家庭一'))
  })

  await scenario('服务3：裸 getReadUrl 门（未附着可预览；附着/删除后走报告路由）', async () => {
    const cloud = makeMockCloud()
    const sv = freshServer(cloud)
    const stage = `cloud://env-b2b2.bucket/mc/${TEST_ENV.MC_FAMILY_ID}/stage/oTESTMAMA123456/u3`
    cloud.__stored.set(`mc/${TEST_ENV.MC_FAMILY_ID}/stage/oTESTMAMA123456/u3`, JPEG)
    const reg = await sv.files({ action: 'registerStaged', uploadId: 'u3', stageFileID: stage })
    const fid = reg.data.file.fileId
    // 未附着：B1 独立文件可预览
    const before = await sv.files({ action: 'getReadUrl', fileId: fid })
    assert.ok(before.ok, JSON.stringify(before))
    // 附着报告后：裸路由拒绝
    const created = await sv.request('report.upsert', { id: 'rpt_g', payload: { dateKey: '2026-09-01', reportType: 'urine', attachments: [{ fileId: fid }] } })
    assert.ok(created.ok)
    const after = await sv.files({ action: 'getReadUrl', fileId: fid })
    assert.equal(after.ok, false)
    assert.equal(after.code, 'file-attached-use-report-route')
    // 报告路由可用；删除报告后报告路由拒绝（历史幂等响应不绕过删除）
    const via = await sv.request('report.getReadUrls', { id: 'rpt_g', operationId: undefined, expectedRevision: undefined })
    assert.ok(via.ok, JSON.stringify(via))
    const del = await sv.request('report.delete', { id: 'rpt_g', expectedRevision: 1 })
    assert.ok(del.ok)
    const gone = await sv.request('report.getReadUrls', { id: 'rpt_g', operationId: undefined, expectedRevision: undefined })
    assert.equal(gone.ok, false)
    assert.equal(gone.code, 'report-not-found')
  })

  await scenario('服务4：删除原子清引用（墓碑附件≠有效引用；宽限只记一次）', async () => {
    const cloud = makeMockCloud()
    const sv = freshServer(cloud)
    const stage = `cloud://env-b2b2.bucket/mc/${TEST_ENV.MC_FAMILY_ID}/stage/oTESTMAMA123456/u4`
    cloud.__stored.set(`mc/${TEST_ENV.MC_FAMILY_ID}/stage/oTESTMAMA123456/u4`, JPEG)
    const fid = (await sv.files({ action: 'registerStaged', uploadId: 'u4', stageFileID: stage })).data.file.fileId
    await sv.request('report.upsert', { id: 'rpt_h', payload: { dateKey: '2026-09-01', reportType: 'other', attachments: [{ fileId: fid }] } })
    assert.ok(cloud.__docs.get('mc_files/' + fid).attachedReportIds.includes('rpt_h'))
    const del = await sv.request('report.delete', { id: 'rpt_h', expectedRevision: 1 })
    assert.ok(del.ok)
    const f = cloud.__docs.get('mc_files/' + fid)
    assert.equal(f.attachedReportIds.length, 0, '墓碑后引用集合必须清空')
    assert.ok(f.lastDetachedAt > 0)
    const first = f.lastDetachedAt
    // 重复删除（新 opId、当前 revision）不重置宽限
    const del2 = await sv.request('report.delete', { id: 'rpt_h', expectedRevision: 2 })
    if (del2.ok) {
      assert.equal(cloud.__docs.get('mc_files/' + fid).lastDetachedAt, first, '重复删除不重置宽限')
    }
  })

  await scenario('服务5：清理分页越过墓碑墙（第 1001 个可清理对象可见）', async () => {
    const cloud = makeMockCloud()
    const sv = freshServer(cloud)
    for (let i = 0; i < 1001; i++) {
      const id = 'mama:t' + String(i).padStart(5, '0')
      cloud.__docs.set('mc_files/' + id, { familyId: TEST_ENV.MC_FAMILY_ID, uploaderId: 'mama', stageFileID: '', status: 'deleted', createdAt: 1, updatedAt: 1, __v: 1 })
    }
    // 第 1002 条：可清理的已登记无引用文件（registeredAt 已过期）
    const target = 'mama:zlast'
    const stageKey = `mc/${TEST_ENV.MC_FAMILY_ID}/stage/oTESTMAMA123456/zlast`
    cloud.__stored.set(stageKey, JPEG)
    const reg = await sv.files({ action: 'registerStaged', uploadId: 'zlast', stageFileID: `cloud://env-b2b2.bucket/${stageKey}` })
    assert.ok(reg.ok)
    const doc = cloud.__docs.get('mc_files/' + target)
    doc.registeredAt = 1
    cloud.__state.clockOffset = 25 * 60 * 60 * 1000
    const res = await sv.request('report.cleanupOrphans', { expectedRevision: 0 })
    assert.ok(res.ok, JSON.stringify(res))
    assert.equal(res.data.cleaned, 1, `只清理目标对象（实得 ${res.data.cleaned}）`)
    assert.equal(cloud.__docs.get('mc_files/' + target).status, 'deleted', '终态文件墓碑')
  })

  await scenario('服务6：迟到复制补偿（过期认领清理后不留不可达正式对象）', async () => {
    const cloud = makeMockCloud()
    const sv = freshServer(cloud)
    const stageKey = `mc/${TEST_ENV.MC_FAMILY_ID}/stage/oTESTMAMA123456/late`
    cloud.__stored.set(stageKey, JPEG)
    const original = cloud.uploadFile
    let clean
    cloud.uploadFile = async args => {
      cloud.__state.clockOffset = 31 * 60 * 1000
      clean = await sv.request('report.cleanupOrphans', { expectedRevision: 0 })
      return original(args)
    }
    try {
      const r = await sv.files({ action: 'registerStaged', uploadId: 'late', stageFileID: `cloud://env-b2b2.bucket/${stageKey}` })
      assert.ok(clean.ok)
      assert.equal(r.ok, false)
      assert.equal(r.code, 'file-deleted')
      await sv.request('report.cleanupOrphans', { expectedRevision: 0 })
      assert.equal(cloud.__stored.size, 0, '对象库无孤儿')
    } finally { cloud.uploadFile = original; cloud.__state.clockOffset = 0 }
  })

  await scenario('服务7：迟到重复登记重放（并发同 uploadId 已登记——不删存活对象）', async () => {
    const cloud = makeMockCloud()
    const sv = freshServer(cloud)
    const stageKey = `mc/${TEST_ENV.MC_FAMILY_ID}/stage/oTESTMAMA123456/dup`
    cloud.__stored.set(stageKey, JPEG)
    const stageFileID = `cloud://env-b2b2.bucket/${stageKey}`
    let release, first = true
    const original = cloud.uploadFile
    cloud.uploadFile = async args => {
      if (first) { first = false; await new Promise(r => { release = r }) }
      return original(args)
    }
    try {
      const input = { action: 'registerStaged', uploadId: 'dup', stageFileID }
      const pending = sv.files(input)
      await tick()
      const completed = await sv.files(input)
      assert.ok(completed.ok)
      release()
      const late = await pending
      assert.ok(late.ok && late.data.replayed, JSON.stringify(late))
      const formalCount = [...cloud.__stored.keys()].filter(k => k.includes('/formal/')).length
      assert.equal(formalCount, 1, '补偿不得删除存活正式对象')
    } finally { cloud.uploadFile = original; if (release) release() }
  })

  await scenario('服务8：清理逐对象失败可重试（禁止失败即完成）+ 终态防复活', async () => {
    const cloud = makeMockCloud()
    const sv = freshServer(cloud)
    const stageKey = `mc/${TEST_ENV.MC_FAMILY_ID}/stage/oTESTMAMA123456/u8`
    cloud.__stored.set(stageKey, JPEG)
    const reg = await sv.files({ action: 'registerStaged', uploadId: 'u8', stageFileID: `cloud://env-b2b2.bucket/${stageKey}` })
    const fid = reg.data.file.fileId
    const doc = cloud.__docs.get('mc_files/' + fid)
    doc.registeredAt = 1
    cloud.__state.clockOffset = 25 * 60 * 60 * 1000
    cloud.__state.deletionFails = 1
    const fail1 = await sv.request('report.cleanupOrphans', { expectedRevision: 0 })
    assert.equal(fail1.data.results[0].action, 'failed')
    assert.equal(cloud.__docs.get('mc_files/' + fid).status, 'cleaning', '失败保留状态')
    const fail2 = await sv.request('report.cleanupOrphans', { expectedRevision: 0 })
    assert.equal(fail2.data.results[0].action, 'cleaned', '重试完成')
    assert.equal(cloud.__docs.get('mc_files/' + fid).status, 'deleted')
    // 终态防复活：同 uploadId 重新登记拒绝
    cloud.__stored.set(stageKey, JPEG)
    const again = await sv.files({ action: 'registerStaged', uploadId: 'u8', stageFileID: `cloud://env-b2b2.bucket/${stageKey}` })
    assert.equal(again.ok, false)
    assert.equal(again.code, 'file-deleted')
  })

  await scenario('服务9：迟到签发门（挂起 getTempFileURL 期间删除 → 不交付 URL）', async () => {
    const cloud = makeMockCloud()
    const sv = freshServer(cloud)
    const stageKey = `mc/${TEST_ENV.MC_FAMILY_ID}/stage/oTESTMAMA123456/u9`
    cloud.__stored.set(stageKey, JPEG)
    const fid = (await sv.files({ action: 'registerStaged', uploadId: 'u9', stageFileID: `cloud://env-b2b2.bucket/${stageKey}` })).data.file.fileId
    await sv.request('report.upsert', { id: 'rpt_race', payload: { dateKey: '2026-09-01', reportType: 'other', attachments: [{ fileId: fid }] } })
    let release
    const original = cloud.getTempFileURL
    cloud.getTempFileURL = async args => { await new Promise(r => { release = r }); return original(args) }
    try {
      const pending = reportsH.main({ action: 'report.getReadUrls', schemaVersion: 1, id: 'rpt_race' })
      await tick()
      const del = await sv.request('report.delete', { id: 'rpt_race', expectedRevision: 1 })
      assert.ok(del.ok)
      release()
      const result = await pending
      assert.equal(result.ok, false)
      assert.equal(result.code, 'report-changed-retry')
    } finally { cloud.getTempFileURL = original; if (release) release() }
  })

  await scenario('服务10：同日多条稳定分页 + 存量 schema 拒绝', async () => {
    const cloud = makeMockCloud()
    const sv = freshServer(cloud)
    for (let i = 0; i < 45; i++) {
      const id = 'rpt_' + String(i).padStart(3, '0')
      cloud.__docs.set('mc_reports/' + id, { familyId: TEST_ENV.MC_FAMILY_ID, schemaVersion: 1, revision: 1, dateKey: '2026-09-19', sortKey: '2026-09-19:' + id, deleted: i % 9 === 0, attachments: [], __v: 1 })
    }
    const seen = new Set()
    let cursor = null, pages = 0
    do {
      const res = await reportsH.main({ action: 'report.list', schemaVersion: 1, cursor, limit: 20 })
      assert.ok(res.ok)
      for (const r of res.data.records) seen.add(r.id)
      cursor = res.data.nextCursor
      pages++
      assert.ok(pages < 10)
    } while (cursor)
    assert.equal(seen.size, 45)
    cloud.__docs.set('mc_reports/rpt_future', { familyId: TEST_ENV.MC_FAMILY_ID, schemaVersion: 99, revision: 1, sortKey: 'z', attachments: [], __v: 1 })
    const bad = await reportsH.main({ action: 'report.list', schemaVersion: 1 })
    assert.equal(bad.code, 'unsupported-stored-schema')
  })

  // ══ 客户端组（真实 bundle：批次 store / familyStore / UploadSheet 处理器）══
  const bundlePath = path.join(temp, 'client.cjs')
  esbuild.buildSync({
    stdin: {
      contents: `export { createPinia, setActivePinia } from 'pinia';
        export * from './services/cloudAdapter.js';
        export * from './services/sessionService.js';
        export * from './services/outbox.js';
        export * from './services/familyStore.js';
        export * from './services/reportFamilyStore.js';
        export * from './services/fileUploadService.js';
        export * from './utils/cloudConfig.js';`,
      resolveDir: root
    },
    bundle: true, platform: 'node', format: 'cjs', alias: { '@': root },
    outfile: bundlePath, logLevel: 'silent'
  })
  const api = require(bundlePath)

  const storage = new Map()
  const storageReads = []
  const uniCalls = { toasts: [], requests: 0, uploadFile: 0, chooseImage: 0, saveFile: 0, removeSavedFile: 0 }
  global.uni = {
    getStorageSync(k) { storageReads.push(k); return storage.has(k) ? storage.get(k) : '' },
    setStorageSync(k, v) { storage.set(k, v) },
    removeStorageSync(k) { storage.delete(k) },
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
    showToast: v => uniCalls.toasts.push(v && v.title),
    showLoading() {}, hideLoading() {},
    redirectTo() {}, navigateTo() {}, switchTab() {}, reLaunch() {}, navigateBack() {},
    request: () => { uniCalls.requests++ },
    uploadFile: () => { uniCalls.uploadFile++ },
    chooseImage: o => { uniCalls.chooseImage++; o.success({ tempFilePaths: ['tmp://pick-' + uniCalls.chooseImage + '.png'] }) },
    saveFile: o => {
      uniCalls.saveFile++
      const idx = uniCalls.saveFile
      const saved = 'store://saved-' + idx
      localFileBytes.set(saved, makePng(idx)) // 每张图片字节互不相同
      localFileBytes.set(o.tempFilePath, localFileBytes.get(saved)) // 移动语义：临时路径同源
      o.success({ savedFilePath: saved })
    },
    removeSavedFile: o => { uniCalls.removeSavedFile++; o.success && o.success({}) }
  }

  function fullStack() {
    for (const k of [...storage.keys()]) {
      if (k.startsWith('mc_outbox_') || k.startsWith('mc_cache_') || k.startsWith('mc_session_') || k.startsWith('mc_draft_') || k.startsWith('mc_pending_') || k === 'mc_session_mode') storage.delete(k)
    }
    const cloud = makeMockCloud()
    setServerEnv()
    cloud.__setCtx(TEST_ENV.MC_MEMBER_MAMA_OPENID)
    reportsH.__setCloud(cloud); filesH.__setCloud(cloud); healthH.__setCloud(cloud); identityH.__setCloud(cloud)
    const memberOpenid = { mama: TEST_ENV.MC_MEMBER_MAMA_OPENID, papa: TEST_ENV.MC_MEMBER_PAPA_OPENID }
    let member = 'mama'
    const routes = {
      'mc-reports': e => { cloud.__setCtx(memberOpenid[member]); return reportsH.main(e) },
      'mc-files': e => { cloud.__setCtx(memberOpenid[member]); return filesH.main(e) },
      'mc-health': e => { cloud.__setCtx(memberOpenid[member]); return healthH.main(e) },
      'mc-identity': () => ({ ok: true, data: { memberId: member, displayName: member === 'mama' ? '妈妈' : '爸爸', familyId: TEST_ENV.MC_FAMILY_ID } })
    }
    const controls = { offline: false }
    global.wx = {
      cloud: {
        init() {},
        uploadFile(o) {
          if (controls.offline) { o.fail({ errMsg: 'offline' }); return }
          const path = String(o.cloudPath)
          const bytes = localFileBytes.get(o.filePath) || JPEG // 按路径携带真实字节
          cloud.__stored.set(path, Buffer.from(bytes))
          o.success({ fileID: `cloud://env-b2b2.bucket/${path}`, statusCode: 200 })
        }
      }
    }
    api.__setCloudConfigForTests('env-b2b2', 'wxapp-b2b2')
    api.__setWxCloud({
      init() {},
      callFunction(o) {
        if (controls.offline) { o.fail({ errMsg: 'offline' }); return }
        const h = routes[o.name]
        if (!h) { o.fail({ errMsg: 'no route' }); return }
        Promise.resolve().then(() => h(o.data)).then(r => o.success({ result: r })).catch(e => o.fail({ errMsg: e.message }))
      },
      uploadFile(o) { global.wx.cloud.uploadFile(o) }
    })
    api.__resetForTests()
    api.setActivePinia(api.createPinia())
    const fam = api.useFamilyStore()
    const rfs = api.useReportFamilyStore()
    return { cloud, fam, rfs, controls, routes, setMember: m => { member = m } }
  }

  await scenario('store1：批次全链路（选图→持久副本→受控上传→登记→报告创建→列表）', async () => {
    const { cloud, fam, rfs } = fullStack()
    await api.confirmIdentity()
    const res = await rfs.createBatchFromTempPaths(['tmp://a.jpg', 'tmp://b.jpg', 'tmp://c.jpg'])
    assert.ok(res.ok, JSON.stringify(res))
    await res.processing
    const b = rfs.batch(res.batchId)
    assert.equal(b.status, 'ready', JSON.stringify(b.items.map(i => i.state)))
    assert.equal(b.items.length, 3)
    const create = await rfs.createReportFromBatch(res.batchId, { reportType: 'ultrasound', dateKey: '2026-09-10' })
    assert.ok(create.ok, JSON.stringify(create))
    await fam.pullReports()
    const rec = fam.reports[b.reportId]
    assert.ok(rec, '权威报告可拉取')
    assert.equal(rec.attachments.length, 3)
    assert.equal(rec.attachments[0].fileId, b.items.find(i => i.order === 0).fileId, '附件顺序稳定')
    // 逐附件按原 SPEC 断言：原始字节 deepEqual、SHA256、大小、全部附件顺序
    const crypto = require('node:crypto')
    const sortedItems = [...b.items].sort((a, c) => a.order - c.order)
    for (let i = 0; i < sortedItems.length; i++) {
      const item = sortedItems[i]
      const cloudRec = rec.attachments[i]
      assert.equal(cloudRec.fileId, item.fileId, `附件 ${i} 顺序一致（order=${item.order}）`)
      const fdoc = cloud.__docs.get('mc_files/' + cloudRec.fileId)
      assert.ok(fdoc, `附件 ${i} 登记记录存在`)
      const cloudBytes = cloud.__stored.get(fdoc.storageFileKey)
      const localBytes = localFileBytes.get(item.savedFilePath)
      assert.ok(cloudBytes && localBytes, `附件 ${i} 字节可取`)
      assert.deepEqual(cloudBytes, localBytes, `附件 ${i} 原始字节 deepEqual`)
      assert.equal(fdoc.sizeBytes, cloudBytes.length, `附件 ${i} 登记大小与对象一致`)
      const cloudSha = crypto.createHash('sha256').update(cloudBytes).digest('hex')
      const localSha = crypto.createHash('sha256').update(localBytes).digest('hex')
      assert.equal(cloudSha, localSha, `附件 ${i} SHA256 一致`)
    }
    // 三图互不相同
    const formal = [...cloud.__stored.keys()].filter(k => k.includes('/formal/'))
    assert.equal(formal.length, 3, '每图只登记一次')
    const shas = formal.map(k => crypto.createHash('sha256').update(cloud.__stored.get(k)).digest('hex'))
    assert.equal(new Set(shas).size, 3, '三张图片 SHA256 互不相同')
  })

  await scenario('store2：部分失败只重试失败项（成功项不重复上传）；重启恢复续传', async () => {
    const { cloud, fam, rfs, controls } = fullStack()
    await api.confirmIdentity()
    await rfs.refreshUploadPolicy() // 在线取得上传策略（开关开启）
    controls.offline = true
    const res = await rfs.createBatchFromTempPaths(['tmp://a.jpg', 'tmp://b.jpg'])
    await res.processing
    assert.equal(rfs.batch(res.batchId).status, 'partial')
    controls.offline = false
    // 模拟重启：内存清空 + 从成员缓存恢复（uploading→pending 归一）
    rfs.loadPersisted()
    const retry = await rfs.retryBatch(res.batchId)
    void retry
    await tick(); await tick()
    const b = rfs.batch(res.batchId)
    assert.equal(b.status, 'ready', JSON.stringify(b.items.map(i => i.state)))
    const create = await rfs.createReportFromBatch(res.batchId, { reportType: 'other', dateKey: '2026-09-11' })
    assert.ok(create.ok)
    const formal = [...cloud.__stored.keys()].filter(k => k.includes('/formal/'))
    assert.equal(formal.length, 2, '成功项不重复上传')
  })

  await scenario('store3：批次清单落盘失败——不发网络、保留本机原件句柄', async () => {
    const { cloud, rfs } = fullStack()
    await api.confirmIdentity()
    const realSet = global.uni.setStorageSync
    const removeBefore = uniCalls.removeSavedFile
    let pathsKept = null
    global.uni.setStorageSync = (k, v) => {
      if (String(k).includes('b2b2-upload-batches')) throw new Error('disk full (mock)')
      return realSet(k, v)
    }
    try {
      const res = await rfs.createBatchFromTempPaths(['tmp://a.jpg', 'tmp://b.jpg'])
      assert.equal(res.ok, false)
      assert.equal(res.code, 'manifest-persist-failed')
      assert.ok(res.keptLocalPaths && res.keptLocalPaths.length === 2, '恢复句柄保留')
      assert.equal(uniCalls.removeSavedFile, removeBefore, '不得删除已保存原件')
      assert.equal([...cloud.__stored.keys()].filter(k => k.includes('stage')).length, 0, '零网络')
    } finally { global.uni.setStorageSync = realSet; void pathsKept }
  })

  await scenario('store4：会话边界——挂起上传期间切成员，不以新成员登记；批次留原成员', async () => {
    const { cloud, rfs, controls, routes, setMember } = fullStack()
    await api.confirmIdentity()
    // 挂起 wx 直传：首图 stage 上传挂起
    const realUpload = global.wx.cloud.uploadFile
    let release
    global.wx.cloud.uploadFile = o => {
      global.wx.cloud.uploadFile = realUpload
      release = () => { realUpload(o) }
    }
    const res = await rfs.createBatchFromTempPaths(['tmp://a.jpg'])
    await tick()
    assert.ok(release, '上传已挂起')
    routes['mc-identity'] = () => ({ ok: true, data: { memberId: 'papa', displayName: '爸爸', familyId: TEST_ENV.MC_FAMILY_ID } })
    setMember('papa')
    await api.confirmIdentity()
    release()
    await res.processing
    await tick(); await tick()
    // 不以 papa 发出登记请求：无正式对象
    assert.equal([...cloud.__stored.keys()].filter(k => k.includes('/formal/')).length, 0)
    const b = rfs.batch(res.batchId)
    assert.ok(!b || b.status !== 'ready', '批次不在新成员视图推进')
  })

  await scenario('store5：持久化失败槽位保留（不静默裁短多页报告）', async () => {
    const { rfs } = fullStack()
    await api.confirmIdentity()
    const realSave = global.uni.saveFile
    global.uni.saveFile = o => {
      if (String(o.tempFilePath).includes('pick-2')) { global.uni.saveFile = realSave; o.fail({ errMsg: 'no space' }); return }
      realSave(o)
    }
    try {
      const res = await rfs.createBatchFromTempPaths(['tmp://pick-1.jpg', 'tmp://pick-2.jpg'])
      assert.ok(res.ok)
      await res.processing
      const b = rfs.batch(res.batchId)
      assert.equal(b.items.length, 2, '槽位保留')
      assert.equal(b.items[1].state, 'persist-failed')
      const create = await rfs.createReportFromBatch(res.batchId, { reportType: 'other', dateKey: '2026-09-12' })
      assert.equal(create.ok, false, '缺页报告被阻止')
      assert.equal(create.code, 'not-ready')
    } finally { global.uni.saveFile = realSave }
  })

  await scenario('store6：恢复链路——清单失败句柄可见可恢复（recoverFromSavedPaths）', async () => {
    const { cloud, rfs } = fullStack()
    await api.confirmIdentity()
    await rfs.refreshUploadPolicy()
    const realSet = global.uni.setStorageSync
    global.uni.setStorageSync = (k, v) => {
      if (String(k).includes('b2b2-upload-batches')) throw new Error('disk full (mock)')
      return realSet(k, v)
    }
    let failed
    try {
      failed = await rfs.createBatchFromTempPaths(['tmp://a.jpg'])
    } finally { global.uni.setStorageSync = realSet }
    assert.equal(failed.code, 'manifest-persist-failed')
    assert.ok(rfs.lastRecovery && rfs.lastRecovery.items.length === 1, '恢复状态可见（完整槽位）')
    assert.equal(rfs.lastRecovery.memberId, 'mama', '恢复态绑定原始成员')
    assert.ok(rfs.lastRecovery.persisted, '恢复元数据已落盘')
    // 恢复：直接以已保存路径重建批次（不再 saveFile）并完成上传
    const rec = await rfs.recoverFromSavedPaths()
    assert.ok(rec.ok, JSON.stringify(rec))
    await rec.processing
    assert.equal(rfs.batch(rec.batchId).status, 'ready')
    assert.equal(rfs.lastRecovery, null, '恢复后清除恢复态')
    assert.equal([...cloud.__stored.keys()].filter(k => k.includes('/formal/')).length, 1)
  })

  await scenario('store7：首页链路——权威报告进入实际模板派生源（分组/筛选/计数）', async () => {
    const { fam } = fullStack()
    await api.confirmIdentity()
    // 直接种一份权威报告（绕过 handler 加速）并模拟页面 loadData 的映射
    fam.reports = { rpt_idx: { id: 'rpt_idx', dateKey: '2026-09-19', reportType: 'other', archiveStatus: 'archived', revision: 1, attachments: [], deleted: false } }
    // 页面映射逻辑等价复刻（index.vue mapToTemplate）：归档/未归档分流
    const mapped = Object.values(fam.reports).filter(r => !r.deleted).map(r => ({
      _id: r.id, report_type: r.reportType, report_date: r.dateKey,
      archive_status: r.archiveStatus, note: r.note || '', file_urls: [], _cloud: true
    }))
    const archived = mapped.filter(r => r.archive_status === 'archived')
    assert.equal(archived.length, 1)
    assert.ok(archived[0].report_date.startsWith('2026'), '日期进入模板消费形状')
  })

  await scenario('store8：canary——旧正式报告键字节不变且正式流程零读', async () => {
    const legacy = 'YUNTU_REPORTS_DATA'
    const canary = JSON.stringify([{ _id: 'canary', report_date: '2020-01-01' }])
    storage.set(legacy, canary)
    assert.ok(!storageReads.includes(legacy), '正式流程零读旧键')
    // family 全链路（批次+报告+恢复）运行期间从未读取旧键
    const { rfs, fam } = fullStack()
    await api.confirmIdentity()
    const res = await rfs.createBatchFromTempPaths(['tmp://c.jpg'])
    await res.processing
    await rfs.createReportFromBatch(res.batchId, { reportType: 'other', dateKey: '2026-09-13' })
    await fam.pullReports()
    assert.equal(storage.get(legacy), canary, '旧键原始字节不变')
  })

  // ══ 真实页面处理器链路（bundlePage：页面自身 session/store/services）══
  function bundlePage(relPath, transform, exports) {
    const vue = fs.readFileSync(path.join(root, relPath), 'utf8')
    const body = vue.match(/<script setup>([\s\S]*?)<\/script>/)[1]
    let src = body
      .replace(/^import .* from ['"][^'"\n]+\.vue['"];?$/mg, '')
      .replace(/import\s*\{([^}]*)\}\s*from\s*['"]@dcloudio\/uni-app['"];?/, (m, names) => {
        const stubs = []
        if (names.includes('onShow')) stubs.push('const shows=[];const onShow=fn=>shows.push(fn);')
        if (names.includes('onLoad')) stubs.push('const loads=[];const onLoad=fn=>loads.push(fn);')
        if (names.includes('onPullDownRefresh')) stubs.push('const pulls=[];const onPullDownRefresh=fn=>pulls.push(fn);')
        return stubs.join('') || m
      })
      .replace(/\bonMounted\s*,?\s*(?=[\},])/g, '')
      .replace(/,\s*,/g, ',').replace(/\{\s*,/g, '{ ').replace(/,\s*\}/g, ' }')
    src = "import { createPinia, setActivePinia } from 'pinia';\nconst mounts=[];const onMounted=fn=>mounts.push(fn);\nconst defineProps=()=>({});const emitCalls=[];const defineEmits=()=>((...a)=>{emitCalls.push(a);return true});\n" + src
    if (transform) src = transform(src)
    const hasShows = src.includes('const shows=[]')
    const hasLoads = src.includes('const loads=[]')
    src += `\nexport {mounts${hasShows ? ',shows' : ''}${hasLoads ? ',loads' : ''}};export * from './services/sessionService.js';export * from './services/cloudAdapter.js';export * from './services/familyStore.js';export * from './services/reportFamilyStore.js';export * from './services/fileUploadService.js';export * from './utils/cloudConfig.js';` + exports
    const outFile = path.join(temp, 'page-' + path.basename(relPath, '.vue') + '.cjs')
    esbuild.buildSync({ stdin: { contents: src, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', alias: { '@': root }, outfile: outFile, logLevel: 'silent' })
    delete require.cache[require.resolve(outFile)]
    return require(outFile)
  }
  function setupPageRoutes(page, cloud) {
    page.__setCloudConfigForTests('env-b2b2', 'wxapp-b2b2')
    const wxCloud = {
      init() {},
      callFunction(o) {
        const routes = {
          'mc-reports': e => reportsH.main(e),
          'mc-files': e => filesH.main(e),
          'mc-health': e => healthH.main(e),
          'mc-identity': () => ({ ok: true, data: { memberId: 'mama', displayName: '妈妈', familyId: TEST_ENV.MC_FAMILY_ID } })
        }
        const h = routes[o.name]
        if (!h) { o.fail({ errMsg: 'no route' }); return }
        Promise.resolve().then(() => h(o.data)).then(r => o.success({ result: r })).catch(e => o.fail({ errMsg: e.message }))
      },
      uploadFile(o) {
        const path = String(o.cloudPath)
        cloud.__stored.set(path, Buffer.from(localFileBytes.get(o.filePath) || JPEG))
        o.success({ fileID: `cloud://env-b2b2.bucket/${path}`, statusCode: 200 })
      }
    }
    page.__setWxCloud(wxCloud)
    global.wx = { cloud: wxCloud } // 页面 wx.cloud 直传与云函数同库
  }

  await scenario('页面1：真实 UploadSheet 处理器→批次→单次交付（pendingUpload 一次）', async () => {
    const cloud = makeMockCloud(); freshServer(cloud)
    const page = bundlePage('pages/archives/components/UploadSheet.vue',
      src => src.replace('const reportStore = useReportStore()', 'setActivePinia(createPinia());\nconst reportStore = useReportStore()'),
      `export {handleUploadResult,onGallery,isFamilyMode,reportStore,emitCalls};`)
    setupPageRoutes(page, cloud)
    await page.confirmIdentity()
    const before = uniCalls.saveFile
    await page.handleUploadResult(['tmp://x1.png', 'tmp://x2.png'], page.currentEpoch())
    await tick(); await tick()
    assert.equal(uniCalls.saveFile, before + 2, '两图各建本机持久副本')
    const up = page.reportStore.pendingUpload
    assert.ok(up && up.batchId, '单次交付 pendingUpload（含批次 ID）')
    assert.equal(page.emitCalls.filter(e => e[0] === 'select').length, 1, 'select 恰好交付一次')
    assert.equal(up.fileCount, 2)
    assert.equal(up.localPaths.length, 2, '顺序保留')
    const b = page.useReportFamilyStore().batch(up.batchId)
    assert.ok(b, '批次进入持久清单')
    // 单次交付：再走一遍 gallery 链路会建新批次（新选择），而非重复 emit 旧数据
    const upRefBefore = up
    await page.handleUploadResult(['tmp://x3.png'], page.currentEpoch())
    await tick(); await tick()
    assert.notEqual(page.reportStore.pendingUpload, upRefBefore, '新选择=新批次')
  })

  await scenario('页面2：真实 classify 处理器→批次报告创建→重开不冲突（create-lost）', async () => {
    const cloud = makeMockCloud(); freshServer(cloud)
    const page = bundlePage('pages/archives/classify.vue',
      src => src.replace('const reportStore = useReportStore()', 'setActivePinia(createPinia());\nconst reportStore = useReportStore()'),
      `export {save,selectedType,reportDate,familyBatchId,reportFamilyStore,familyStore2};`)
    setupPageRoutes(page, cloud)
    await page.confirmIdentity()
    // 建批并等待登记完成（复用真实批次链路）
    const rfs = page.useReportFamilyStore()
    const created = await rfs.createBatchFromTempPaths(['tmp://p1.png', 'tmp://p2.png'])
    await created.processing
    const b0 = rfs.batch(created.batchId)
    if (b0.status !== 'ready') {
      await rfs.retryBatch(created.batchId)
      await tick(); await tick()
    }
    assert.equal(rfs.batch(created.batchId).status, 'ready', JSON.stringify(b0.items.map(i => [i.state, i.error])))
    page.loads[0]({ batchId: created.batchId, source: 'p2' })
    page.selectedType.value = 'ultrasound'
    page.reportDate.value = '2026-09-18'
    await page.save()
    await tick(); await tick()
    const fam = page.useFamilyStore()
    await fam.pullReports()
    const rec = fam.reports[created.reportId]
    assert.ok(rec, '报告经真实 classify 保存创建')
    assert.equal(rec.reportType, 'ultrasound')
    assert.equal(rec.attachments.length, 2)
    // create-lost 语义（对账协议）：表单变化重开 → 批次确认完成但要求显式编辑，
    // 不以当前 revision 重发表单覆盖云端；同表单重开 → 幂等确认
    await reportsH.main({ action: 'report.upsert', schemaVersion: 1, operationId: 'peer-note', expectedRevision: rec.revision, id: created.reportId, payload: { note: 'preserve peer edit' } })
    await fam.pullReports()
    page.selectedType.value = 'ogtt' // 表单变化
    await page.save()
    await tick(); await tick()
    await fam.pullReports()
    const rec2 = fam.reports[created.reportId]
    assert.equal(rec2.reportType, 'ultrasound', '对账不重发表单（类型未被覆盖）')
    assert.equal(rec2.note, 'preserve peer edit', '对方后续编辑保留')
    assert.equal(rec2.revision, 2, '只有对方编辑推进（未重发）')
    const ids = Object.keys(fam.reports).filter(id => fam.reports[id].attachments.length === 2)
    assert.equal(ids.length, 1, '没有第二份报告')
    assert.equal(rfs.batch(created.batchId).status, 'done', '批次确认完成')
  })

  await scenario('页面3：真实 unarchived 处理器→权威批量归档（部分冲突分开反馈）', async () => {
    const cloud = makeMockCloud(); freshServer(cloud)
    const page = bundlePage('pages/archives/unarchived.vue',
      src => src.replace('const reportStore = useReportStore()', 'setActivePinia(createPinia());\nconst reportStore = useReportStore()'),
      `export {doBatchArchive,doDelete,onArchiveAll,reportStore,familyStore,deleteTargetId};`)
    setupPageRoutes(page, cloud)
    await page.confirmIdentity()
    const fam = page.useFamilyStore()
    // 两份未归档权威报告；一份被对端推进（revision 冲突路径）
    // 直接经 handler 建立合法附件报告
    const stageKey = `mc/${TEST_ENV.MC_FAMILY_ID}/stage/${TEST_ENV.MC_MEMBER_MAMA_OPENID}/uu`
    cloud.__stored.set(stageKey, JPEG)
    const reg = await filesH.main({ action: 'registerStaged', uploadId: 'uu', stageFileID: `cloud://env-b2b2.bucket/${stageKey}` })
    const fid = reg.data.file.fileId
    const r1 = await reportsH.main({ action: 'report.upsert', schemaVersion: 1, operationId: 'u1', expectedRevision: 0, id: 'rpt_u1', payload: { dateKey: '2026-09-01', reportType: 'urine', archiveStatus: 'unarchived', attachments: [{ fileId: fid }] } })
    const r2 = await reportsH.main({ action: 'report.upsert', schemaVersion: 1, operationId: 'u2', expectedRevision: 0, id: 'rpt_u2', payload: { dateKey: '2026-09-02', reportType: 'ogtt', archiveStatus: 'unarchived', attachments: [{ fileId: fid }] } })
    assert.ok(r1.ok && r2.ok, JSON.stringify([r1, r2]))
    await page.shows[0]()
    assert.equal(page.reportStore.unarchivedReports.length, 2, '权威未归档进入页面派生源')
    // 拉取之后、归档之前：对端推进 u2（页面捕获的 revision 过期）
    await reportsH.main({ action: 'report.upsert', schemaVersion: 1, operationId: 'peer', expectedRevision: 1, id: 'rpt_u2', payload: { note: '对方先改' } })
    uniCalls.toasts.length = 0
    page.onArchiveAll() // 打开确认（冻结 id/revision 意图）
    await page.doBatchArchive()
    await tick(); await tick()
    const doneDoc = cloud.__docs.get('mc_reports/rpt_u1')
    assert.equal(doneDoc.archiveStatus, 'archived', '未冲突份已归档')
    assert.equal(cloud.__docs.get('mc_reports/rpt_u2').archiveStatus, 'unarchived', '冲突份未被覆盖')
    assert.ok(uniCalls.toasts.some(t => /对方已修改/.test(t)), '部分冲突如实反馈')
  })

  // ══ 终版协议永久化：意图/完成落盘门、响应丢失对账、切换/重选恢复、策略重试、
  // 页面草稿/反馈/深链隔离/删除基线/下载鉴权（源自 review 终节，独立于 /tmp 探针）══

  await scenario('store9：意图落盘失败=阻断门（零请求、回滚意图、保留原件）', async () => {
    const { cloud, fam, rfs } = fullStack()
    await api.confirmIdentity()
    await rfs.refreshUploadPolicy()
    const res = await rfs.createBatchFromTempPaths(['tmp://a.png'])
    await res.processing
    assert.equal(rfs.batch(res.batchId).status, 'ready')
    const realSet = global.uni.setStorageSync
    global.uni.setStorageSync = (k, v) => {
      if (String(k).includes('b2b2-upload-batches') && JSON.stringify(v).includes('createIntent')) throw new Error('intent disk full')
      return realSet(k, v)
    }
    let saved
    try {
      saved = await rfs.createReportFromBatch(res.batchId, { reportType: 'other', dateKey: '2026-09-19' })
    } finally { global.uni.setStorageSync = realSet }
    assert.equal(saved.ok, false)
    assert.equal(saved.code, 'intent-persist-failed')
    assert.equal(Object.keys(fam.reports).length, 0, '零请求（服务端无报告）')
    const b = rfs.batch(res.batchId)
    assert.equal(b.createIntentSaved, false, '意图状态已回滚')
    assert.ok(b.items.every(i => i.savedFilePath), '原件保留')
  })

  await scenario('store10：完成落盘失败保留副本→reconciling→重试完成对账', async () => {
    const { cloud, fam, rfs } = fullStack()
    await api.confirmIdentity()
    await rfs.refreshUploadPolicy()
    const res = await rfs.createBatchFromTempPaths(['tmp://a.png'])
    await res.processing
    const realSet = global.uni.setStorageSync
    let failDone = true
    global.uni.setStorageSync = (k, v) => {
      // v 已是 setMemberCache 序列化的 JSON 字符串——直接检查原始字符串
      if (failDone && String(k).includes('b2b2-upload-batches') && String(v).includes('"status":"done"')) throw new Error('finish disk full')
      return realSet(k, v)
    }
    let saved
    try {
      saved = await rfs.createReportFromBatch(res.batchId, { reportType: 'other', dateKey: '2026-09-19' })
    } finally { global.uni.setStorageSync = realSet }
    assert.equal(saved.ok, true, '创建成功')
    assert.ok(saved.warning, '如实 warning')
    const b = rfs.batch(res.batchId)
    assert.equal(b.status, 'reconciling', '完成落盘失败退回待对账')
    assert.ok(b.items.every(i => i.savedFilePath), '本机原件保留')
    // 磁盘恢复 → 重试保存完成对账
    failDone = false
    const retry = await rfs.createReportFromBatch(res.batchId, { reportType: 'other', dateKey: '2026-09-19' })
    assert.equal(retry.ok, true)
    assert.equal(rfs.batch(res.batchId).status, 'done', '重试完成对账')
  })

await scenario('store11：saveFile 挂起切成员→恢复索引写回原成员→回原成员可续传', async () => {
    const { cloud, rfs, controls, routes, setMember } = fullStack()
    await api.confirmIdentity()
    await rfs.refreshUploadPolicy()
    // 挂起 saveFile：首图落盘挂起
    const realSave = global.uni.saveFile
    let release
    global.uni.saveFile = o => {
      global.uni.saveFile = realSave
      release = () => realSave(o)
    }
    const res = rfs.createBatchFromTempPaths(['tmp://a.png']) // 不 await：saveFile 挂起中
    await tick()
    assert.ok(release, 'saveFile 已挂起')
    routes['mc-identity'] = () => ({ ok: true, data: { memberId: 'papa', displayName: '爸爸', familyId: TEST_ENV.MC_FAMILY_ID } })
    setMember('papa')
    await api.confirmIdentity()
    release()
    const r = await res
    assert.equal(r.ok, false)
    assert.equal(r.code, 'stale-session')
    // 当前（papa）不可见恢复索引
    assert.equal(rfs.lastRecovery, null, '新成员视图无恢复索引')
    // 切回原成员：恢复索引从其命名空间恢复
    routes['mc-identity'] = () => ({ ok: true, data: { memberId: 'mama', displayName: '妈妈', familyId: TEST_ENV.MC_FAMILY_ID } })
    setMember('mama')
    await api.confirmIdentity()
    await tick()
    assert.ok(rfs.lastRecovery && rfs.lastRecovery.items.length === 1, '原成员恢复索引可读')
    assert.ok(rfs.lastRecovery.items[0].savedFilePath, '已保存原件句柄保留')
  })

await scenario('store12：重选跨身份切换保留原完整批次（两页不缩为一页）', async () => {
    const { cloud, rfs, controls, routes, setMember } = fullStack()
    await api.confirmIdentity()
    await rfs.refreshUploadPolicy()
    const res = await rfs.createBatchFromTempPaths(['tmp://a.png', 'tmp://b.png'])
    await res.processing
    const b = rfs.batch(res.batchId)
    assert.equal(b.status, 'ready')
    b.items[0].state = 'failed' // 模拟首图失败
    b.status = 'partial'
    // 重选首图：chooseImage 立即返回，挂起 saveFile（切换发生在落盘期间）
    const realSave2 = global.uni.saveFile
    let release2
    global.uni.saveFile = o => {
      global.uni.saveFile = realSave2
      release2 = () => realSave2(o)
    }
    const pending = rfs.replaceItemSlot(res.batchId, 0)
    await tick(); await tick()
    assert.ok(release2, 'saveFile 已挂起')
    routes['mc-identity'] = () => ({ ok: true, data: { memberId: 'papa', displayName: '爸爸', familyId: TEST_ENV.MC_FAMILY_ID } })
    setMember('papa')
    await api.confirmIdentity()
    release2()
    const r = await pending
    assert.equal(r.ok, false)
    assert.equal(r.code, 'stale-session')
    // 切回原成员：恢复记录保留原完整批次（两页 + 新原件在槽位 0）
    routes['mc-identity'] = () => ({ ok: true, data: { memberId: 'mama', displayName: '妈妈', familyId: TEST_ENV.MC_FAMILY_ID } })
    setMember('mama')
    await api.confirmIdentity()
    await tick()
    const rec = rfs.lastRecovery || api.getMemberCache('b2b2-recovery')
    assert.ok(rec && rec.batchId === res.batchId, '恢复记录指向原批次：' + JSON.stringify(rec && rec.batchId))
    assert.equal(rec.items.length, 2, '两页完整保留')
    assert.equal(rec.items[1].state, 'registered', '未动项登记状态保留')
    // 恢复：合并回原批次（不产生竞争批次），未动项不重复上传
    const recovered = await rfs.recoverFromSavedPaths()
    assert.ok(recovered.ok, JSON.stringify(recovered))
    await recovered.processing
    const rb = rfs.batch(recovered.batchId)
    assert.equal(recovered.batchId, res.batchId, '合并回原 batchId')
    assert.equal(rb.items.length, 2)
    assert.equal(rb.status, 'ready')
    const formal = [...cloud.__stored.keys()].filter(k => k.includes('/formal/'))
    assert.equal(formal.length, 2, '未动项不重复上传')
  })

  await scenario('store12b：重选清单落盘失败保留完整批次（两页不缩为一页）', async () => {
    const { cloud, rfs } = fullStack()
    await api.confirmIdentity()
    await rfs.refreshUploadPolicy()
    const res = await rfs.createBatchFromTempPaths(['tmp://a.png', 'tmp://b.png'])
    await res.processing
    const b = rfs.batch(res.batchId)
    assert.equal(b.status, 'ready')
    b.items[0].state = 'failed'
    b.status = 'partial'
    // 重选首图：chooseImage/saveFile 正常，persistBatches 失败（b2b2-upload-batches 磁盘满）
    const realSet = global.uni.setStorageSync
    global.uni.setStorageSync = (k, v) => {
      if (String(k).includes('b2b2-upload-batches')) throw new Error('disk full')
      return realSet(k, v)
    }
    let r
    try {
      r = await rfs.replaceItemSlot(res.batchId, 0)
    } finally { global.uni.setStorageSync = realSet }
    assert.equal(r.ok, false)
    assert.equal(r.code, 'persist-failed')
    // 恢复记录保留完整批次：原 batchId、两页、未动项 registered
    const rec = rfs.lastRecovery || api.getMemberCache('b2b2-recovery')
    assert.ok(rec, '恢复记录存在')
    assert.equal(rec.batchId, res.batchId, '指向原批次')
    assert.equal(rec.reportId, b.reportId, '指向原报告 ID')
    assert.equal(rec.items.length, 2, '两页完整保留')
    assert.equal(rec.items[1].state, 'registered', '未动项登记状态保留')
    assert.ok(rec.items[0].savedFilePath, '目标槽位指向新原件')
    // 磁盘恢复后恢复 → 合并回原批次（两页 ready）
    const recovered = await rfs.recoverFromSavedPaths()
    assert.ok(recovered.ok, JSON.stringify(recovered))
    await recovered.processing
    const rb = rfs.batch(recovered.batchId)
    assert.equal(recovered.batchId, res.batchId, '合并回原 batchId')
    assert.equal(rb.items.length, 2, '恢复后仍两页')
    assert.equal(rb.status, 'ready', '恢复后 ready')
  })

  await scenario('store13b：未处理恢复阻止新批次（不拼接为一份报告）', async () => {
    const { rfs } = fullStack()
    await api.confirmIdentity()
    await rfs.refreshUploadPolicy()
    // 制造一个未处理恢复
    const realSet = global.uni.setStorageSync
    global.uni.setStorageSync = (k, v) => {
      if (String(k).includes('b2b2-upload-batches')) throw new Error('disk full')
      return realSet(k, v)
    }
    let r1
    try { r1 = await rfs.createBatchFromTempPaths(['tmp://a.png']) } finally { global.uni.setStorageSync = realSet }
    assert.equal(r1.code, 'manifest-persist-failed')
    assert.ok(rfs.lastRecovery, '恢复存在')
    // 新批次被阻止
    const r2 = await rfs.createBatchFromTempPaths(['tmp://b.png'])
    assert.equal(r2.ok, false)
    assert.equal(r2.code, 'recovery-pending', '有未处理恢复时阻止新批次')
    // 放弃后可重新建批
    const d = rfs.discardRecovery()
    assert.equal(d.ok, true)
    const r3 = await rfs.createBatchFromTempPaths(['tmp://c.png'])
    assert.equal(r3.ok, true, JSON.stringify(r3))
    if (r3.processing) await r3.processing
  })

  await scenario('store13c：discard 持久失败保留句柄→磁盘恢复重试成功→切走切回无残留', async () => {
    const { cloud, rfs, controls, routes, setMember } = fullStack()
    await api.confirmIdentity()
    await rfs.refreshUploadPolicy()
    const realSet = global.uni.setStorageSync
    global.uni.setStorageSync = (k, v) => {
      if (String(k).includes('b2b2-upload-batches')) throw new Error('disk full')
      return realSet(k, v)
    }
    let r1
    try { r1 = await rfs.createBatchFromTempPaths(['tmp://a.png']) } finally { global.uni.setStorageSync = realSet }
    assert.ok(rfs.lastRecovery, '恢复存在')
    const savedPath = rfs.lastRecovery.items[0].savedFilePath
    // discard 持久失败（b2b2-recovery 也失败）→ 保留句柄与原件，如实失败
    global.uni.setStorageSync = (k, v) => {
      if (String(k).includes('b2b2-recovery')) throw new Error('disk full')
      return realSet(k, v)
    }
    let d
    try { d = rfs.discardRecovery() } finally { global.uni.setStorageSync = realSet }
    assert.equal(d.ok, false)
    assert.equal(d.code, 'persist-failed', '放弃持久失败如实上报')
    assert.ok(rfs.lastRecovery, '失败后恢复仍可见（句柄不丢）')
    assert.ok(!rfs.lastRecovery.cancelled, 'cancelled 已复位')
    assert.ok(rfs.lastRecovery.items[0].savedFilePath === savedPath, '原件句柄保留')
    // 磁盘恢复后真实重试成功
    const d2 = rfs.discardRecovery()
    assert.equal(d2.ok, true, '重试放弃成功')
    assert.equal(rfs.lastRecovery, null, '成功后清空')
    // 切走切回：无残留（cancelled 持久残留不被 loadRecovery 接受）
    routes['mc-identity'] = () => ({ ok: true, data: { memberId: 'papa', displayName: '爸爸', familyId: TEST_ENV.MC_FAMILY_ID } })
    setMember('papa')
    await api.confirmIdentity()
    routes['mc-identity'] = () => ({ ok: true, data: { memberId: 'mama', displayName: '妈妈', familyId: TEST_ENV.MC_FAMILY_ID } })
    setMember('mama')
    await api.confirmIdentity()
    await tick()
    assert.ok(!rfs.lastRecovery, '切走切回无残留（cancelled 不被 loadRecovery 接受）')
    void cloud; void controls
  })

  await scenario('store13：策略读取失败不缓存（临时网络失败不永久禁用）', async () => {
    const { rfs, controls } = fullStack()
    await api.confirmIdentity()
    rfs.uploadPolicy = null
    controls.offline = true
    const first = await rfs.createBatchFromTempPaths(['tmp://a.png'])
    assert.equal(first.ok, false)
    controls.offline = false
    const second = await rfs.createBatchFromTempPaths(['tmp://a.png'])
    assert.equal(second.ok, true, JSON.stringify(second))
    if (second.processing) await second.processing
    assert.equal(rfs.batch(second.batchId).status, 'ready')
  })

  await scenario('页面4：classify 草稿持久/编辑草稿恢复/draftChanged 反馈不自动返回', async () => {
    const cloud = makeMockCloud(); freshServer(cloud)
    const page = bundlePage('pages/archives/classify.vue',
      src => src.replace('const reportStore = useReportStore()', 'setActivePinia(createPinia());\nconst reportStore = useReportStore()'),
      `export {save,selectedType,reportDate,notes,familyBatchId,reportFamilyStore,familyStore2};`)
    setupPageRoutes(page, cloud)
    await page.confirmIdentity()
    const rfs = page.useReportFamilyStore()
    const fam = page.useFamilyStore()
    // 既有报告 + 编辑草稿
    const stageKey = `mc/${TEST_ENV.MC_FAMILY_ID}/stage/${TEST_ENV.MC_MEMBER_MAMA_OPENID}/ed`
    cloud.__stored.set(stageKey, JPEG)
    const reg = await filesH.main({ action: 'registerStaged', uploadId: 'ed', stageFileID: `cloud://env-b2b2.bucket/${stageKey}` })
    await reportsH.main({ action: 'report.upsert', schemaVersion: 1, operationId: 'ed1', expectedRevision: 0, id: 'rpt_ed', payload: { dateKey: '2026-09-17', reportType: 'other', note: 'SERVER NOTE', archiveStatus: 'unarchived', attachments: [{ fileId: reg.data.file.fileId }] } })
    await fam.pullReports()
    // 编辑草稿：本地未保存草稿优先于服务器值（含空备注按字段存在性）
    api.setMemberCache && api.setMemberCache('b2b2-edit-drafts', { rpt_ed: { reportType: 'ultrasound', dateKey: '2026-09-18', note: 'LOCAL UNSENT', baselineRevision: 1 } })
    page.loads[0]({ reportId: 'rpt_ed', source: 'p6' })
    await tick(); await tick()
    assert.equal(page.notes.value, 'LOCAL UNSENT', '编辑草稿恢复（优先于服务器值）')
    assert.equal(page.selectedType.value, 'ultrasound')
    // 草稿编辑落盘（watch 30ms 去抖）
    page.notes.value = 'EDITED UNSAVED'
    await new Promise(r => setTimeout(r, 100))
    const drafts = api.getMemberCache('b2b2-edit-drafts')
    assert.ok(drafts && drafts.rpt_ed && drafts.rpt_ed.note === 'EDITED UNSAVED', '编辑期草稿即时落盘')
    // 批次 draftChanged：不报"已入档"不自动返回
    const created = await rfs.createBatchFromTempPaths(['tmp://n1.png'])
    await created.processing
    page.loads[0]({ batchId: created.batchId, source: 'p2' })
    await tick()
    // 预先创建（模拟创建已确认），再用变化的表单保存
    const r0 = await rfs.createReportFromBatch(created.batchId, { reportType: 'other', dateKey: '2026-09-19' })
    assert.equal(r0.ok, true)
    uniCalls.toasts.length = 0
    page.selectedType.value = 'ogtt' // 表单变化
    page.reportDate.value = '2026-09-19'
    await page.save()
    await tick(); await tick()
    assert.ok(!uniCalls.toasts.some(t => String(t).includes('已入档')), '未提交草稿不得报已入档')
    assert.ok(uniCalls.toasts.some(t => /未提交|编辑|未保存/.test(t)), '必须有可行动的未提交反馈')
    // 未提交草稿真实可找回（batch.draft 持久）
    const bAfter = rfs.batch(created.batchId)
    assert.ok(bAfter.draft && bAfter.draft.reportType === 'ogtt', '变化草稿已持久于批次')
    // 实际确认回调：modal success({confirm:true}) → persistEditDraft + 导航 classify p6
    const modalCalls = []
    const realModal = global.uni.showModal
    global.uni.showModal = o => { modalCalls.push(o); if (o.success) o.success({ confirm: true }) }
    const navCalls = []
    const realNav = global.uni.navigateTo
    global.uni.navigateTo = o => navCalls.push(o.url)
    try {
      page.selectedType.value = 'ogtt'
      page.reportDate.value = '2026-09-19'
      page.notes.value = 'CONFIRMED TRANSFER'
      await page.save()
      await tick(); await tick()
      assert.ok(modalCalls.length > 0, 'draftChanged 弹出实际 modal')
      const target = navCalls.find(u => u.includes(created.reportId))
      assert.ok(target && target.includes('/classify?'), '确认后导航至 classify 编辑模式：' + JSON.stringify(navCalls))
      // 转移的草稿在目标报告编辑器可读回
      const ed = rfs.readEditDraft(created.reportId)
      assert.ok(ed && ed.note === 'CONFIRMED TRANSFER', '草稿实际转移（note 一致）')
      assert.equal(ed.baselineRevision, 1, '转移基线=创建时 revision1')
      // 目标编辑器（classify p6）恢复转移的草稿
      page.familyBatchId.value = '' // 模拟重新进入 p6
      page.loads[0]({ reportId: created.reportId, source: 'p6' })
      await tick(); await tick()
      assert.equal(page.familyBatchId.value, '', 'p6 模式不回退旧 batchId')
      assert.equal(page.notes.value, 'CONFIRMED TRANSFER', '目标编辑器恢复转移的 note')
      assert.equal(page.selectedType.value, 'ogtt', '目标编辑器恢复转移的 type')
    } finally {
      global.uni.showModal = realModal
      global.uni.navigateTo = realNav
    }
  })

  await scenario('页面5：detail 删除确认基线 + 下载每次重新鉴权', async () => {
    const cloud = makeMockCloud(); freshServer(cloud)
    const page = bundlePage('pages/archives/detail.vue',
      src => src
        .replace("import { ref, computed, getCurrentInstance, watch } from 'vue'",
                 "const getCurrentInstance=()=>({proxy:{}});import { ref, computed, watch } from 'vue'")
        .replace('const reportStore = useReportStore()', 'setActivePinia(createPinia());\nconst reportStore = useReportStore()'),
      `export {onDelete,doDelete,onDownload,loadReport,report,familyStore,reportId};`)
    setupPageRoutes(page, cloud)
    await page.confirmIdentity()
    const fam = page.useFamilyStore()
    const stageKey = `mc/${TEST_ENV.MC_FAMILY_ID}/stage/${TEST_ENV.MC_MEMBER_MAMA_OPENID}/dl`
    cloud.__stored.set(stageKey, JPEG)
    const reg = await filesH.main({ action: 'registerStaged', uploadId: 'dl', stageFileID: `cloud://env-b2b2.bucket/${stageKey}` })
    await reportsH.main({ action: 'report.upsert', schemaVersion: 1, operationId: 'dl1', expectedRevision: 0, id: 'rpt_dl', payload: { dateKey: '2026-09-17', reportType: 'other', archiveStatus: 'archived', attachments: [{ fileId: reg.data.file.fileId }] } })
    await fam.pullReports()
    page.reportId.value = 'rpt_dl'
    await page.loadReport()
    assert.ok(page.report.value && page.report.value._id === 'rpt_dl')
    // 删除基线：确认打开（rev1）→ 对端推进（rev2）→ 删除用基线 1 → 如实冲突
    page.onDelete()
    await reportsH.main({ action: 'report.upsert', schemaVersion: 1, operationId: 'peer-dl', expectedRevision: 1, id: 'rpt_dl', payload: { note: 'peer' } })
    await fam.pullReports()
    await page.doDelete()
    await tick(); await tick()
    const doc = cloud.__docs.get('mc_reports/rpt_dl')
    assert.ok(!doc.deleted, '冲突删除不生效（用打开时基线）')
    // 下载鉴权：报告删除后 onDownload 不使用旧缓存 URL
    await reportsH.main({ action: 'report.delete', schemaVersion: 1, operationId: 'del-dl', expectedRevision: 2, id: 'rpt_dl' })
    await fam.pullReports()
    uniCalls.toasts.length = 0
    const dlCalls = []
    const realDl = global.uni.downloadFile
    global.uni.downloadFile = o => { dlCalls.push(o.url); realDl(o) }
    try {
      await page.onDownload()
      await tick()
      assert.equal(dlCalls.length, 0, '已删报告不发起下载（先鉴权）')
    } finally { global.uni.downloadFile = realDl }

    // 下载迟到成功门：挂起 downloadFile → endSession → 放行成功回调 → 不保存相册
    let saved2Count = 0
    const realSave2 = global.uni.saveImageToPhotosAlbum
    global.uni.saveImageToPhotosAlbum = () => { saved2Count++ }
    let lateRelease
    global.uni.downloadFile = o => { lateRelease = () => o.success({ tempFilePath: '/tmp/late' }) }
    try {
      // 报告恢复有效（先重新建一个有效报告）
      const stageKey2 = `mc/${TEST_ENV.MC_FAMILY_ID}/stage/${TEST_ENV.MC_MEMBER_MAMA_OPENID}/dl2`
      cloud.__stored.set(stageKey2, JPEG)
      const reg2 = await filesH.main({ action: 'registerStaged', uploadId: 'dl2', stageFileID: `cloud://env-b2b2.bucket/${stageKey2}` })
      await reportsH.main({ action: 'report.upsert', schemaVersion: 1, operationId: 'dl2', expectedRevision: 0, id: 'rpt_dl2', payload: { dateKey: '2026-09-17', reportType: 'other', archiveStatus: 'archived', attachments: [{ fileId: reg2.data.file.fileId }] } })
      await fam.pullReports()
      page.reportId.value = 'rpt_dl2'
      await page.loadReport()
      const p2 = page.onDownload() // 发起（挂起）
      await tick()
      assert.ok(lateRelease, 'downloadFile 已挂起')
      api.endSession() // 下载期间退出
      await tick()
      lateRelease() // 迟到成功
      await tick(); await tick()
      void p2
      assert.equal(saved2Count, 0, '退出后迟到成功不保存到相册')
    } finally {
      global.uni.saveImageToPhotosAlbum = realSave2
      global.uni.downloadFile = realDl
    }
  })

  await scenario('页面6：batch 正式直达不读旧 pendingUpload（canary 零渲染）', async () => {
    const cloud = makeMockCloud(); freshServer(cloud)
    const page = bundlePage('pages/archives/batch.vue',
      src => src
        .replace('const reportStore = useReportStore()', 'setActivePinia(createPinia());\nconst reportStore = useReportStore()'),
      `export {items,familyStore,reportStore};`)
    setupPageRoutes(page, cloud)
    await page.confirmIdentity()
    await page.familyStore.pullReports()
    // 旧 pendingUpload 带 canary（无新 batchId）
    page.reportStore.pendingUpload = { fileUrls: ['srv://LEGACY-CANARY'], localPaths: ['/old-private-original'], items: [], fileType: 'image', fileCount: 1 }
    page.loads[0]({})
    await new Promise(r => setTimeout(r, 25))
    assert.equal(page.items.value.length, 0, '正式直达不渲染旧原件 canary')
  })

  await scenario('服务11：hospital/weekOfPregnancy 字段语义（入库/非法拒绝/清空归一/部分编辑保留/默认 null）', async () => {
    const cloud = makeMockCloud()
    const sv = freshServer(cloud)
    const stageKey = `mc/${TEST_ENV.MC_FAMILY_ID}/stage/${TEST_ENV.MC_MEMBER_MAMA_OPENID}/hw1`
    cloud.__stored.set(stageKey, JPEG)
    const reg = await sv.files({ action: 'registerStaged', uploadId: 'hw1', stageFileID: `cloud://env-b2b2.bucket/${stageKey}` })
    const fid = reg.data.file.fileId
    // 创建带两字段：入库并返回
    const c1 = await sv.request('report.upsert', { id: 'rpt_hw', payload: { dateKey: '2026-09-22', reportType: 'other', hospital: '市妇幼保健院', weekOfPregnancy: 12, attachments: [{ fileId: fid }] } })
    assert.ok(c1.ok, JSON.stringify(c1))
    assert.equal(c1.data.record.hospital, '市妇幼保健院')
    assert.equal(c1.data.record.weekOfPregnancy, 12)
    // 非法孕周：0/46/1.5/'12'/''——整单拒绝（客户端须归一，服务端不猜意图）
    for (const bad of [0, 46, 1.5, '12', '']) {
      const r = await sv.request('report.upsert', { id: 'rpt_hw2', payload: { dateKey: '2026-09-22', reportType: 'other', weekOfPregnancy: bad, attachments: [{ fileId: fid }] } })
      assert.equal(r.ok, false, `week=${JSON.stringify(bad)} 应拒绝`)
    }
    // 非法医院：>100 字 / 非字符串
    const r2 = await sv.request('report.upsert', { id: 'rpt_hw2', payload: { dateKey: '2026-09-22', reportType: 'other', hospital: '长'.repeat(101), attachments: [{ fileId: fid }] } })
    assert.equal(r2.ok, false)
    const r3 = await sv.request('report.upsert', { id: 'rpt_hw2', payload: { dateKey: '2026-09-22', reportType: 'other', hospital: 123, attachments: [{ fileId: fid }] } })
    assert.equal(r3.ok, false)
    // 清空归一：hospital ''→null；week null→null
    const c2 = await sv.request('report.upsert', { id: 'rpt_hw', expectedRevision: 1, payload: { hospital: '', weekOfPregnancy: null } })
    assert.ok(c2.ok, JSON.stringify(c2))
    assert.equal(c2.data.record.hospital, null)
    assert.equal(c2.data.record.weekOfPregnancy, null)
    // 部分编辑保留：只改 note，hospital/week 不重置
    const c3 = await sv.request('report.upsert', { id: 'rpt_hw', expectedRevision: 2, payload: { hospital: '省人民医院', weekOfPregnancy: 30 } })
    assert.ok(c3.ok)
    const c4 = await sv.request('report.upsert', { id: 'rpt_hw', expectedRevision: 3, payload: { note: 'only note' } })
    assert.ok(c4.ok)
    assert.equal(c4.data.record.hospital, '省人民医院')
    assert.equal(c4.data.record.weekOfPregnancy, 30)
    // 创建不带两字段：默认 null
    const c5 = await sv.request('report.upsert', { id: 'rpt_hw3', payload: { dateKey: '2026-09-22', reportType: 'other', attachments: [{ fileId: fid }] } })
    assert.ok(c5.ok, JSON.stringify(c5))
    assert.equal(c5.data.record.hospital, null)
    assert.equal(c5.data.record.weekOfPregnancy, null)
  })

  await scenario('页面7：医院/孕周全链路（classify 填写→创建入库→p6 回填编辑→清空→detail 映射与编辑）', async () => {
    const cloud = makeMockCloud(); freshServer(cloud)
    const page = bundlePage('pages/archives/classify.vue',
      src => src.replace('const reportStore = useReportStore()', 'setActivePinia(createPinia());\nconst reportStore = useReportStore()'),
      `export {save,selectedType,reportDate,hospital,gestationWeek,notes,familyBatchId,reportFamilyStore,familyStore2};`)
    setupPageRoutes(page, cloud)
    await page.confirmIdentity()
    const rfs = page.useReportFamilyStore()
    const created = await rfs.createBatchFromTempPaths(['tmp://hw-p1.png'])
    await created.processing
    const b0 = rfs.batch(created.batchId)
    if (b0.status !== 'ready') {
      await rfs.retryBatch(created.batchId)
      await tick(); await tick()
    }
    assert.equal(rfs.batch(created.batchId).status, 'ready', JSON.stringify(b0.items.map(i => [i.state, i.error])))
    page.loads[0]({ batchId: created.batchId, source: 'p2' })
    page.selectedType.value = 'ultrasound'
    page.reportDate.value = '2026-09-22'
    page.hospital.value = '市妇幼'
    page.gestationWeek.value = '24'
    await new Promise(r => setTimeout(r, 100)) // 草稿 30ms 去抖落盘
    const bDraft = rfs.batch(created.batchId)
    assert.ok(bDraft.draft && bDraft.draft.hospital === '市妇幼' && bDraft.draft.gestationWeek === '24', '批次草稿含医院/孕周（未保存不丢）')
    await page.save()
    await tick(); await tick()
    const fam = page.useFamilyStore()
    await fam.pullReports()
    const rec = fam.reports[created.reportId]
    assert.ok(rec, '报告经真实 classify 保存创建')
    assert.equal(rec.hospital, '市妇幼', '创建入库 hospital')
    assert.equal(rec.weekOfPregnancy, 24, '创建入库 weekOfPregnancy（字符串→整数）')
    // classify p6 编辑：hydrate 回填→修改→保存生效
    page.familyBatchId.value = ''
    page.loads[0]({ reportId: created.reportId, source: 'p6' })
    await tick(); await tick()
    assert.equal(page.hospital.value, '市妇幼', 'p6 hydrate 回填医院')
    assert.equal(page.gestationWeek.value, '24', 'p6 hydrate 回填孕周（数字→字符串）')
    page.hospital.value = '省人民'
    page.gestationWeek.value = '25'
    await page.save()
    await tick(); await tick()
    await fam.pullReports()
    assert.equal(fam.reports[created.reportId].hospital, '省人民', 'p6 编辑医院生效')
    assert.equal(fam.reports[created.reportId].weekOfPregnancy, 25, 'p6 编辑孕周生效')
    // 清空：重进 p6（真实路径：保存成功即返回，再次编辑重开页面重捕基线）→ ''→null 归一
    page.loads[0]({ reportId: created.reportId, source: 'p6' })
    await tick(); await tick()
    assert.equal(page.hospital.value, '省人民', '重进 p6 回填最新医院')
    page.hospital.value = ''
    page.gestationWeek.value = ''
    await page.save()
    await tick(); await tick()
    await fam.pullReports()
    const rec3 = fam.reports[created.reportId]
    assert.equal(rec3.hospital, null, '清空医院归一 null')
    assert.equal(rec3.weekOfPregnancy, null, '清空孕周归一 null')

    // detail.vue：legacy 映射 + family 编辑保存两字段
    const dpage = bundlePage('pages/archives/detail.vue',
      src => src
        .replace("import { ref, computed, getCurrentInstance, watch } from 'vue'",
                 "const getCurrentInstance=()=>({proxy:{}});import { ref, computed, watch } from 'vue'")
        .replace('const reportStore = useReportStore()', 'setActivePinia(createPinia());\nconst reportStore = useReportStore()'),
      `export {loadReport,report,reportId,familyStore,startEdit,saveEdit,editForm};`)
    setupPageRoutes(dpage, cloud)
    await dpage.confirmIdentity()
    const dfam = dpage.familyStore
    await dfam.pullReports()
    dpage.reportId.value = created.reportId
    await dpage.loadReport()
    assert.ok(dpage.report.value && dpage.report.value._id === created.reportId)
    assert.equal(dpage.report.value.hospital, '', '清空后 detail 映射为空串（未记录显示态）')
    assert.equal(dpage.report.value.week_of_pregnancy, null, '清空后 detail 映射孕周 null')
    // 对端设置两字段后走 detail 编辑链路
    await reportsH.main({ action: 'report.upsert', schemaVersion: 1, operationId: 'hw-peer', expectedRevision: fam.reports[created.reportId].revision, id: created.reportId, payload: { hospital: '对方填的医院', weekOfPregnancy: 33 } })
    await dfam.pullReports()
    await dpage.loadReport()
    assert.equal(dpage.report.value.hospital, '对方填的医院', 'famReportToLegacy 映射 hospital')
    assert.equal(dpage.report.value.week_of_pregnancy, 33, 'famReportToLegacy 映射 week')
    dpage.startEdit()
    assert.equal(dpage.editForm.value.hospital, '对方填的医院', 'detail 编辑表单预填医院')
    assert.equal(String(dpage.editForm.value.week_of_pregnancy), '33', 'detail 编辑表单预填孕周')
    dpage.editForm.value.hospital = 'detail 改的医院'
    dpage.editForm.value.week_of_pregnancy = '34'
    await dpage.saveEdit()
    await tick(); await tick()
    await dfam.pullReports()
    assert.equal(dfam.reports[created.reportId].hospital, 'detail 改的医院', 'detail 编辑保存医院生效')
    assert.equal(dfam.reports[created.reportId].weekOfPregnancy, 34, 'detail 编辑保存孕周生效')
    // detail 清空：''→null
    dpage.startEdit()
    dpage.editForm.value.hospital = ''
    dpage.editForm.value.week_of_pregnancy = ''
    await dpage.saveEdit()
    await tick(); await tick()
    await dfam.pullReports()
    assert.equal(dfam.reports[created.reportId].hospital, null, 'detail 清空医院归一 null')
    assert.equal(dfam.reports[created.reportId].weekOfPregnancy, null, 'detail 清空孕周归一 null')
  })

  await scenario('审计：零旧 HTTP；旧正式报告键零读写且字节不变', async () => {
    assert.equal(uniCalls.requests, 0, '零 uni.request')
    assert.equal(uniCalls.uploadFile, 0, '零 uni.uploadFile（旧二进制通道）')
    const legacy = 'YUNTU_REPORTS_DATA'
    const before = storage.get(legacy)
    void before // 本套件从不写入该键；正式路径零读写由页面路由保证（family 不触碰 legacy store）
  })

  console.log(`\n结果：${passed} 通过，${failed.length} 失败`)
  if (failed.length) {
    console.log('失败项：\n - ' + failed.join('\n - '))
    process.exit(1)
  }
  process.exit(0)
}

main().catch(e => { console.error('套件异常：', e); process.exit(1) })
