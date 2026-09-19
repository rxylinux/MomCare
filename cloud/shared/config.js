'use strict'

// 云函数环境配置（仅非密钥项，全部来自环境变量 / 云函数配置，不进代码库）：
//   MC_APPID                允许的小程序 AppID（getWXContext().APPID 必须等于它）
//   MC_FAMILY_ID            固定家庭标识（仅作数据上下文，不是访问凭证）
//   MC_MEMBER_MAMA_OPENID   妈妈的 OpenID
//   MC_MEMBER_PAPA_OPENID   爸爸的 OpenID
// 任何一项缺失 → 明确 not-configured，所有业务函数拒绝执行，不猜测、不降级。

const REQUIRED_KEYS = ['MC_APPID', 'MC_FAMILY_ID', 'MC_MEMBER_MAMA_OPENID', 'MC_MEMBER_PAPA_OPENID']

function readEnv() {
  // wx-server-sdk 云函数运行时有 process.env（含控制台配置的环境变量）
  const env = (typeof process !== 'undefined' && process.env) || {}
  return env
}

function loadServerConfig(env = readEnv()) {
  const missing = REQUIRED_KEYS.filter(k => !env[k])
  if (missing.length > 0) {
    // configured=false 表示"业务白名单未配齐"；但 MC_APPID 单独存在时
    // 仍必须用于 my-openid 的 AppID 比对（部署契约：先只配 MC_APPID）
    return { configured: false, missing, appidIfAny: env.MC_APPID || '' }
  }
  const members = [
    { memberId: 'mama', openid: env.MC_MEMBER_MAMA_OPENID, displayName: '妈妈' },
    { memberId: 'papa', openid: env.MC_MEMBER_PAPA_OPENID, displayName: '爸爸' }
  ]
  if (members[0].openid === members[1].openid) {
    return { configured: false, missing: ['MC_MEMBER_*_OPENID 重复'] }
  }
  return {
    configured: true,
    missing: [],
    appid: env.MC_APPID,
    appidIfAny: env.MC_APPID,
    familyId: env.MC_FAMILY_ID,
    members
  }
}

// 派生路径约定（云存储）：
// - 暂存目录按调用者 OpenID 隔离（mc/<family>/stage/<openid>/），
//   这样云存储安全规则可用 auth.openid 与 resource.path 把写入者绑定到本人目录
// - 正式目录仅服务端读写（mc/<family>/formal/），客户端规则全拒绝
function storagePaths(config, openid) {
  const family = config.familyId
  return {
    stagePrefix: `mc/${family}/stage/${openid}/`,
    formalPrefix: `mc/${family}/formal/`
  }
}

// 客户端直传开关（服务端环境变量，默认关闭；仅当管理员部署并验证过
// 暂存目录安全规则后才可置 true/'true'）
function clientUploadEnabled(env = readEnv()) {
  const raw = env.MC_UPLOAD_ENABLED
  return raw === true || raw === 'true' || raw === '1'
}

module.exports = { loadServerConfig, storagePaths, clientUploadEnabled, REQUIRED_KEYS }
