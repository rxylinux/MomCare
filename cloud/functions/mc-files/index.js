'use strict'

// mc-files：报告文件生命周期（B1 最小闭环，三段式防并发重复）。
//
// 客户端直传（MC_UPLOAD_ENABLED 开关 + 安全规则部署验证后启用）：
// 仅本人暂存目录 mc/<family>/stage/<openid>/<name>——路径由服务端 prepareUpload 下发
//
// registerStaged 三段式：
//   ① 原子认领（事务）：mc_files 按 memberId:uploadId 认领——
//      已 registered → 同 stagedFileID 幂等重放 / 不同 stagedFileID 拒绝；
//      已 claiming   → 同 stagedFileID 复用认领继续 / 不同 stagedFileID 拒绝；
//      不存在        → 写入 claiming 文档。并发同 uploadId 由事务串行化。
//   ② 转存（事务外，可重试）：服务端读取暂存内容做类型/大小校验（内容为证，
//      不信扩展名），复制到【确定性正式路径】formal/<family>/<member>/<uploadId>_<sha1>。
//      路径由 uploadId + 内容哈希派生——同内容重试覆写同一路径（幂等）；
//      不同内容（同 uploadId 换文件）落到不同路径，绝不静默覆盖他人字节。
//   ③ 原子登记完成（事务）：claiming → registered。转存成功但登记失败的窗口：
//      重试从 ① 复用认领 → ② 同路径重写 → ③ 完成；最终唯一登记、唯一正式路径。
//
// getReadUrl：仅家庭成员 + 已登记文件；任意 fileID 不代为下载，未登记/越权
// 一律 file-not-found（不泄露存在性）。
//
// wx-server-sdk@4.0.2 契约（已对真实 SDK 源码逐项核对，见 cloud/DEPLOY.md）：
//   cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, throwOnNotFound: false })
//   doc.get() → { data: object|null }；doc.set({data}) 含 _id → -501007 拒绝
//   cloud.downloadFile({fileID}) → { fileContent: Buffer }
//   cloud.uploadFile({cloudPath, fileContent}) → { fileID }

const { createHash } = require('node:crypto')
const { loadServerConfig, storagePaths, clientUploadEnabled } = require('./shared/config')
const { resolveCaller } = require('./shared/auth')
const { ok, fail } = require('./shared/respond')
const { COLLECTIONS } = require('./shared/constants')

let cloud = null
try {
  cloud = require('wx-server-sdk')
} catch (e) {
  cloud = null
}

exports.__setCloud = function __setCloud(mockCloud) {
  cloud = mockCloud
}

const MAX_BYTES = 10 * 1024 * 1024 // 10MB
const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

// 图片魔数（类型证据来自内容，不来自扩展名）
function sniffImageType(buf) {
  if (!buf || buf.length < 12) return null
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  return null
}

// cloud://<env>.<bucket>/<path> → path
function cloudPathOf(fileID) {
  const m = /^cloud:\/\/[^/]+\/(.+)$/.exec(String(fileID || ''))
  return m ? m[1] : null
}

async function getDocMaybe(docRef) {
  try {
    const snap = await docRef.get()
    // 统一返回文档对象本身（snap.data），调用方直接读字段
    return snap && snap.data ? snap.data : null
  } catch (err) {
    const msg = String((err && (err.errMsg || err.message)) || err)
    if (/not\s*exist|does not exist/i.test(msg)) return null
    throw err
  }
}

function publicFileView(id, doc) {
  return {
    fileId: id, // 登记记录 ID（memberId:uploadId），getReadUrl 用它
    storageFileKey: doc.storageFileKey,
    uploaderId: doc.uploaderId,
    contentType: doc.contentType,
    sizeBytes: doc.sizeBytes,
    status: doc.status,
    createdAt: doc.createdAt,
    registeredAt: doc.registeredAt || null
  }
}

// 确定性正式路径：family/member/uploadId + 内容哈希。
// 同 uploadId 同内容 → 同路径（重试幂等）；同 uploadId 不同内容 → 不同路径（不覆盖）
function formalCloudPath(paths, uploadId, buffer) {
  const hash = createHash('sha1').update(buffer).digest('hex').slice(0, 16)
  return `${paths.formalPrefix}${uploadId}_${hash}`
}

exports.main = async function main(event) {
  if (!cloud) return fail('sdk-unavailable', 'wx-server-sdk 不可用')
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, throwOnNotFound: false })
  const config = loadServerConfig()
  const resolved = resolveCaller(cloud, config, event)
  if (!resolved.ok) return fail(resolved.code, resolved.message)
  const caller = resolved.caller
  const action = event && event.action
  const paths = storagePaths(config, caller.openid)
  const db = cloud.database()

  if (action === 'registerStaged') {
    const { stageFileID, uploadId } = event
    if (!stageFileID || typeof stageFileID !== 'string') return fail('invalid-params', '缺少 stageFileID')
    if (!uploadId || typeof uploadId !== 'string' || !UPLOAD_ID_RE.test(uploadId)) {
      return fail('invalid-params', 'uploadId 必须是 1-64 位字母/数字/下划线/连字符')
    }

    // 路径归属预检（事务内还会以认领记录二次绑定）
    const path = cloudPathOf(stageFileID)
    if (!path || !path.startsWith(paths.stagePrefix) || path.includes('..')) {
      return fail('forbidden-path', '文件不在调用者暂存目录内')
    }

    const regId = `${caller.memberId}:${uploadId}`
    const now = Date.now()

    // ── ① 原子认领 ──
    let claim
    const claimTx = await db.startTransaction()
    try {
      const existing = await getDocMaybe(claimTx.collection(COLLECTIONS.files).doc(regId))
      if (existing) {
        if (existing.stageFileID !== stageFileID) {
          await claimTx.rollback()
          return fail('operation-id-conflict', '同一 uploadId 已绑定不同暂存文件')
        }
        if (existing.status === 'registered') {
          await claimTx.rollback()
          return ok({ replayed: true, file: publicFileView(regId, existing) })
        }
        claim = existing // claiming：复用认领，继续转存/登记
        await claimTx.rollback()
      } else {
        // set 数据不含 _id（SDK 契约：doc(id) 携带主键）
        const doc = {
          familyId: config.familyId,
          uploaderId: caller.memberId,
          stageFileID,
          status: 'claiming',
          createdAt: now
        }
        await claimTx.collection(COLLECTIONS.files).doc(regId).set({ data: doc })
        await claimTx.commit()
        claim = { ...doc, stageFileID }
      }
    } catch (err) {
      try { await claimTx.rollback() } catch (rollbackErr) { /* 已回滚 */ }
      return fail('transaction-failed', '认领未完成（可能并发同 uploadId），可用同一 uploadId 重试', {
        errMsg: String((err && (err.errMsg || err.message)) || err).slice(0, 200)
      })
    }

    // ── ② 转存到确定性正式路径（可安全重试，同内容覆写同一路径） ──
    let buffer
    try {
      const dl = await cloud.downloadFile({ fileID: claim.stageFileID })
      buffer = dl && dl.fileContent
    } catch (err) {
      return fail('staged-file-unreadable', '暂存文件不可读（可能已过期），请重新上传并更换 uploadId')
    }
    if (!buffer || !buffer.length) return fail('invalid-params', '暂存文件为空')
    if (buffer.length > MAX_BYTES) return fail('file-too-large', `超过 ${MAX_BYTES} 字节`)
    const contentType = sniffImageType(buffer)
    if (!contentType) return fail('unsupported-type', '仅支持 JPEG/PNG 图片（以文件内容判定）')

    const formalPath = formalCloudPath(paths, uploadId, buffer)
    let formalFileID
    try {
      const up = await cloud.uploadFile({ cloudPath: formalPath, fileContent: buffer })
      formalFileID = up && up.fileID
    } catch (err) {
      return fail('formal-copy-failed', '正式副本写入失败，请用同一 uploadId 重试')
    }
    if (!formalFileID) return fail('formal-copy-failed', '正式副本写入失败，请用同一 uploadId 重试')

    // ── ③ 原子登记完成 ──
    const regTx = await db.startTransaction()
    try {
      const doc = await getDocMaybe(regTx.collection(COLLECTIONS.files).doc(regId))
      if (!doc) {
        await regTx.rollback()
        return fail('claim-missing', '认领记录缺失，请更换 uploadId 重新上传')
      }
      if (doc.stageFileID !== claim.stageFileID) {
        await regTx.rollback()
        return fail('operation-id-conflict', '同一 uploadId 已绑定不同暂存文件')
      }
      if (doc.status === 'registered') {
        await regTx.rollback()
        return ok({ replayed: true, file: publicFileView(regId, doc) })
      }
      // set 数据不得包含 _id：get 取回的文档自带 _id，直接展开会混入，
      // 真实 SDK 在网络请求前即以 -501007 拒绝（源码核对）——显式剔除
      const { _id: _fetchedId, ...claimFields } = doc
      void _fetchedId
      const completed = {
        ...claimFields,
        storageFileKey: formalPath, // 稳定正式路径（唯一副本位置）
        formalFileID,
        contentType,
        sizeBytes: buffer.length,
        status: 'registered',
        registeredAt: Date.now()
      }
      await regTx.collection(COLLECTIONS.files).doc(regId).set({ data: completed })
      await regTx.commit()
      return ok({ replayed: false, file: publicFileView(regId, completed) })
    } catch (err) {
      try { await regTx.rollback() } catch (rollbackErr) { /* 已回滚 */ }
      // 转存已成功（同路径幂等），登记失败可用同一 uploadId 重试完成
      return fail('transaction-failed', '登记未完成（正式副本已就位），可用同一 uploadId 重试', {
        errMsg: String((err && (err.errMsg || err.message)) || err).slice(0, 200)
      })
    }
  }

  if (action === 'getReadUrl') {
    const { fileId } = event
    if (!fileId || typeof fileId !== 'string') return fail('invalid-params', '缺少 fileId')
    const doc = await getDocMaybe(db.collection(COLLECTIONS.files).doc(fileId))
    if (!doc || doc.status !== 'registered' || doc.familyId !== config.familyId || !doc.formalFileID) {
      return fail('file-not-found', '文件不存在或未完成登记')
    }
    // 家庭共享报告：两成员均可读（PRD：报告两人共享）
    let urlResult
    try {
      urlResult = await cloud.getTempFileURL({ fileList: [doc.formalFileID] })
    } catch (err) {
      return fail('temp-url-failed', '获取访问地址失败')
    }
    const entry = urlResult && urlResult.fileList && urlResult.fileList[0]
    if (!entry || !entry.tempFileURL) return fail('temp-url-failed', '获取访问地址失败')
    return ok({
      fileId,
      tempFileURL: entry.tempFileURL,
      contentType: doc.contentType,
      expiresIn: '短期有效，有效期由平台决定'
    })
  }

  if (action === 'uploadPolicy') {
    // 客户端上传策略：开关默认关闭；只有管理员部署并验证暂存目录安全规则后
    // 置 MC_UPLOAD_ENABLED 才开放。关闭时如实返回关闭状态与原因。
    const enabled = clientUploadEnabled()
    return ok({
      clientUploadEnabled: enabled,
      reason: enabled
        ? '本人暂存目录直传已开放（安全规则已部署）'
        : '上传通道未启用：需部署暂存目录安全规则并在云函数配置 MC_UPLOAD_ENABLED'
    })
  }

  if (action === 'prepareUpload') {
    // 上传路径由服务端按调用者 OpenID 派生并下发，客户端不能自选路径；
    // 开关关闭时明确拒绝（不返回路径）
    if (!clientUploadEnabled()) {
      return fail('upload-disabled', '上传通道未启用（服务端开关 MC_UPLOAD_ENABLED）')
    }
    const { uploadId } = event
    if (!uploadId || typeof uploadId !== 'string' || !UPLOAD_ID_RE.test(uploadId)) {
      return fail('invalid-params', 'uploadId 必须是 1-64 位字母/数字/下划线/连字符')
    }
    return ok({
      cloudPath: `${paths.stagePrefix}${uploadId}`,
      uploadId
    })
  }

  return fail('invalid-action', '未知 action')
}
