// CloudBase 客户端配置。
// envId / appId 在交付时由用户填写（真实环境 ID 不是密钥，可入库）；
// 为空 = 未配置：所有云调用入口明确显示"尚未配置"，绝不伪造连接成功，
// 也绝不回退到旧 HTTP 后端或游客认证。

export const CLOUD_CONFIG = {
  envId: 'rxylinux-momcare-d2eoh6t493c2168',   // CloudBase 环境 ID（微信云开发控制台获取）
  appId: 'wxf3b1d079e04cb490'  // 小程序 AppID（与 manifest.json 一致；服务端另有 MC_APPID 校验）
}

export function isCloudConfigured() {
  return Boolean(CLOUD_CONFIG.envId && CLOUD_CONFIG.appId)
}

export function cloudConfigMissing() {
  const missing = []
  if (!CLOUD_CONFIG.envId) missing.push('envId')
  if (!CLOUD_CONFIG.appId) missing.push('appId')
  return missing
}

// 仅供隔离测试注入配置（生产代码不调用；交付时由用户直接填写上方常量）
export function __setCloudConfigForTests(envId, appId) {
  CLOUD_CONFIG.envId = envId
  CLOUD_CONFIG.appId = appId
}
