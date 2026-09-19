'use strict'

// 可信身份解析：只读 wx-server-sdk 的 getWXContext()。
// event 中的 openid / memberId / role / familyId 一律忽略——客户端声明不构成身份。
// 未配置、缺上下文、AppID 不符、非白名单成员均拒绝；不存在"前 N 个调用自动成为成员"。

function resolveCaller(cloud, config, event) {
  // event 只用于否定性测试所需的存在性，绝不读取其中的身份字段
  let ctx = {}
  try {
    ctx = cloud.getWXContext() || {}
  } catch (e) {
    return { ok: false, code: 'unauthenticated', message: '无法读取微信调用上下文' }
  }
  const openid = ctx.OPENID
  const appid = ctx.APPID
  if (!openid) {
    return { ok: false, code: 'unauthenticated', message: '缺少可信 OpenID' }
  }
  if (!appid) {
    return { ok: false, code: 'unauthenticated', message: '缺少可信 APPID' }
  }
  if (!config.configured) {
    return { ok: false, code: 'not-configured', message: '云函数未配置成员白名单' }
  }
  if (appid !== config.appid) {
    return { ok: false, code: 'wrong-appid', message: 'AppID 与配置不符' }
  }
  const member = config.members.find(m => m.openid === openid)
  if (!member) {
    return { ok: false, code: 'not-family-member', message: '仅限本家庭成员使用' }
  }
  return {
    ok: true,
    caller: {
      memberId: member.memberId,
      displayName: member.displayName,
      openid, // 仅供服务端日志脱敏摘要使用，不返回客户端
      appid
    }
  }
}

// 日志脱敏：只保留定位所需信息，不落私人正文/完整 OpenID
function identityLogFields(caller) {
  if (!caller) return {}
  return { member: caller.memberId, appidOk: true }
}

module.exports = { resolveCaller, identityLogFields }
