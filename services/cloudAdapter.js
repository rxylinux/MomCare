// 微信云调用适配层：平台/配置检查 + wx.cloud.callFunction 封装。
// - H5 或非微信平台：明确 unavailable-platform，不发起调用
// - 配置缺失：明确 not-configured，不发起调用、不伪造成功、不回退旧后端
// - 微信小程序且已配置：初始化 wx.cloud 后走原生 callFunction
// 隔离测试通过 __setWxCloud 注入实现 wx.cloud 契约的模拟对象。

import { isCloudConfigured, cloudConfigMissing, CLOUD_CONFIG } from '@/utils/cloudConfig.js'

let wxCloud = null
let initialized = false

// #ifdef MP-WEIXIN
try {
  if (typeof wx !== 'undefined' && wx.cloud) {
    wxCloud = wx.cloud
  }
} catch (e) {
  wxCloud = null
}
// #endif

export function __setWxCloud(mockCloud) {
  wxCloud = mockCloud
  initialized = false
}

export function cloudRuntimeState() {
  if (!isCloudConfigured()) return 'not-configured'
  if (!wxCloud) return 'unavailable-platform'
  return initialized ? 'ready' : 'ready-to-init'
}

export function cloudConfigIssue() {
  const missing = cloudConfigMissing()
  return missing.length > 0 ? `缺少配置：${missing.join('、')}（见 utils/cloudConfig.js）` : ''
}

function ensureInit() {
  // 配置缺失优先于平台判断：任何平台下"未配置"都必须如实报告 not-configured
  if (!isCloudConfigured()) {
    return { ok: false, code: 'not-configured', message: `云环境尚未配置；${cloudConfigIssue()}` }
  }
  if (!wxCloud) {
    return { ok: false, code: 'unavailable-platform', message: '云能力仅在微信小程序端可用' }
  }
  if (!initialized) {
    try {
      // 官方契约：wx.cloud.init({ env })；traceUser 关闭，减少不必要上报
      wxCloud.init({ env: CLOUD_CONFIG.envId, traceUser: false })
      initialized = true
    } catch (e) {
      return { ok: false, code: 'init-failed', message: '云能力初始化失败' }
    }
  }
  return { ok: true }
}

// 调用云函数。返回云函数的 result（{ok,code,data|message}）或规范化的失败。
export async function callCloudFunction(name, data) {
  const initCheck = ensureInit()
  if (!initCheck.ok) return initCheck
  try {
    const res = await new Promise((resolve, reject) => {
      wxCloud.callFunction({
        name,
        data: data || {},
        success: resolve,
        fail: reject
      })
    })
    const result = res && res.result
    if (!result || typeof result !== 'object') {
      return { ok: false, code: 'malformed-result', message: '云函数返回结构异常' }
    }
    return result
  } catch (err) {
    return {
      ok: false,
      code: 'cloud-call-failed',
      message: '云调用失败（网络或函数不可用）',
      errMsg: String((err && (err.errMsg || err.message)) || err).slice(0, 200)
    }
  }
}
