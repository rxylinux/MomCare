// B2b2 文件上传服务层：收敛 B1 受控暂存→直传→登记协议，供诊断页与报告批次共用。
//
// 语义与 B1 pages/family/index.vue 原实现一致（B1 回归不变）：
// - prepareUpload(uploadId) 服务端下发暂存路径（开关关闭明确失败）
// - wx.cloud.uploadFile 直传【本人暂存目录】
// - registerStaged(uploadId, stageFileID) 三段式登记（幂等重放/同 uploadId 拒换文件/
//   cleaning/deleted 终态拒绝/事务续租/正式目标记录）
// - staged-file-unreadable：暂存过期——本机原件【保留】（P1-4），
//   由调用方决定重暂存（新 uploadId 同原件）或用户显式重选
// - 身份失败分类：locked（服务端拒绝，调用方清屏）/ stale（成员切换，待办留原成员）
//   / network 等（可按原 uploadId 重试）；同成员回前台复核（R7）不算切换
import { familyCall, captureSession, isSameSession } from '@/services/sessionService.js'

export const AUTH_REFUSAL_CODES = ['not-family-member', 'wrong-appid', 'unauthenticated', 'not-configured']

// 结构化结果：
//   {ok:true, replayed, fileId}
//   {ok:false, code, message, locked?, stale?, discardLocal?}
//   discardLocal=true 仅在"登记已由其他 uploadId 完成/认领绑定冲突"等本机副本
//   无恢复意义的场景；staged-file-unreadable 不置 discard（原件保留可重暂存）。
export function classifyCallFailure(res, sessionAtStart, stage) {
  if (res.locked || AUTH_REFUSAL_CODES.includes(res.code)) {
    return { ok: false, stage, code: res.code, message: res.message || '身份被服务端拒绝', locked: true }
  }
  if (res.code === 'stale-session' || (sessionAtStart !== undefined && !isSameSession(sessionAtStart))) {
    return { ok: false, stage, code: 'stale-session', message: '会话已切换', stale: true }
  }
  return { ok: false, stage, code: res.code || 'network-error', message: res.message || '网络不可用' }
}

// 能力探测代替条件编译注释：mp-weixin 有全局 wx.cloud / uni.saveFile；
// H5/其余平台如实返回不支持（不假成功），node 测试以 global.wx 模拟 MP 契约
function wxCloudUploadAvailable() {
  return typeof wx !== 'undefined' && wx && wx.cloud && typeof wx.cloud.uploadFile === 'function'
}

// 临时选图 → 本机持久副本（失败不建立待上传，不显示已暂存）
export function persistLocalCopy(filePath) {
  return new Promise(resolve => {
    if (typeof uni.saveFile !== 'function') {
      resolve({ ok: false, unsupported: true })
      return
    }
    uni.saveFile({
      tempFilePath: filePath,
      success: r => resolve({ ok: true, path: r.savedFilePath }),
      fail: () => resolve({ ok: false })
    })
  })
}

export function removeLocalCopy(filePath) {
  try {
    if (typeof uni.removeSavedFile === 'function') uni.removeSavedFile({ filePath })
  } catch (e) { /* 尽力清理 */ }
}

// 读取上传开关策略（关闭时浏览说明、可退出，不假成功）
export async function fetchUploadPolicy() {
  const res = await familyCall('mc-files', { action: 'uploadPolicy' })
  if (!res.ok) return { ok: false, code: res.code, message: res.message || '上传策略读取失败' }
  return { ok: true, clientUploadEnabled: Boolean(res.data.clientUploadEnabled), reason: res.data.reason || '' }
}

// 单文件受控管线：prepare → 直传 → register。
// 输入 { uploadId, savedFilePath }；全程以发起会话为准（同成员复核 R7 不算切换）。
export async function uploadSingleFile({ uploadId, savedFilePath }) {
  if (!uploadId || !savedFilePath) return { ok: false, code: 'invalid-params', message: '缺少 uploadId 或本机文件' }
  const sessionAtStart = captureSession()

  const prepared = await familyCall('mc-files', { action: 'prepareUpload', uploadId })
  if (!isSameSession(sessionAtStart)) return { ok: false, stage: 'prepare', code: 'stale-session', message: '会话已切换', stale: true }
  if (!prepared.ok) return classifyCallFailure(prepared, sessionAtStart, 'prepare')

  if (!wxCloudUploadAvailable()) {
    return { ok: false, code: 'unsupported-platform', message: '上传仅在微信小程序端可用' }
  }
  let uploaded
  try {
    uploaded = await new Promise((resolve, reject) => {
      wx.cloud.uploadFile({
        cloudPath: prepared.data.cloudPath,
        filePath: savedFilePath,
        success: resolve,
        fail: reject
      })
    })
  } catch (e) {
    return { ok: false, stage: 'stage', code: 'stage-upload-failed', message: (e && (e.errMsg || e.message)) || '暂存上传失败' }
  }
  // 二进制直传 await 之后、下一次副作用（registerStaged）之前必须核对开始
  // 会话：挂起期间真切成员，绝不以新成员身份发出登记请求（调用方事后丢弃 UI 不够）；
  // 同成员回前台复核（R7）不在此列
  if (!isSameSession(sessionAtStart)) {
    return { ok: false, stage: 'stage', code: 'stale-session', message: '会话已切换（未发送登记请求）', stale: true }
  }

  const reg = await familyCall('mc-files', {
    action: 'registerStaged',
    stageFileID: uploaded.fileID,
    uploadId
  })
  // 成功响应同样核对：不把旧会话结果当作当前会话的成功
  if (!isSameSession(sessionAtStart)) {
    return { ok: false, stage: 'register', code: 'stale-session', message: '会话已切换', stale: true }
  }
  if (!reg.ok) {
    if (reg.code === 'staged-file-unreadable') {
      // 暂存过期：本机原件保留（P1-4）——可新 uploadId 重暂存或用户显式重选
      return { ok: false, stage: 'register', code: 'staged-file-unreadable', message: '暂存文件已过期，本机原件已保留' }
    }
    return classifyCallFailure(reg, sessionAtStart, 'register')
  }
  return { ok: true, replayed: Boolean(reg.data.replayed), fileId: reg.data.file.fileId, file: reg.data.file }
}

// 报告附件预览：mc-reports 报告路由（校验报告未删除；临时 URL 不持久化）
export async function fetchReportReadUrls(reportId) {
  const res = await familyCall('mc-reports', { action: 'report.getReadUrls', schemaVersion: 1, id: reportId })
  if (!res.ok) return { ok: false, code: res.code, message: res.message || '获取预览失败' }
  return { ok: true, urls: res.data.urls || [] }
}
