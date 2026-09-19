'use strict'

// mc-identity：身份查询与设置期自取 OpenID。
// - whoami（默认）：只返回调用者自身的成员信息（成员白名单配置完成后使用），
//   不返回家庭数据、白名单或其他成员信息。
// - my-openid（设置期引导）：只要 AppID 校验通过即返回调用者【自己的】OpenID，
//   供两位成员各自查看后由管理员写入云函数环境变量——这是受控的自取通道：
//   不自动注册成员、不返回他人身份、不打印完整身份到日志。
//
// wx-server-sdk@4.0.2 契约（源码核对）：
//   cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, throwOnNotFound: false })
//   cloud.getWXContext() → { OPENID, APPID, ... }

const { loadServerConfig } = require('./shared/config')
const { resolveCaller } = require('./shared/auth')
const { ok, fail } = require('./shared/respond')

let cloud = null
try {
  cloud = require('wx-server-sdk')
} catch (e) {
  cloud = null
}

exports.__setCloud = function __setCloud(mockCloud) {
  cloud = mockCloud
}

exports.main = async function main(event) {
  if (!cloud) {
    return fail('sdk-unavailable', 'wx-server-sdk 不可用（本地运行属正常，部署环境必须存在）')
  }
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, throwOnNotFound: false })
  const action = event && event.action

  // 设置期引导：AppID 匹配即可（成员白名单可能尚未配置），只返回调用者自身 OpenID
  if (action === 'my-openid') {
    let ctx = {}
    try {
      ctx = cloud.getWXContext() || {}
    } catch (e) {
      return fail('unauthenticated', '无法读取微信调用上下文')
    }
    if (!ctx.OPENID || !ctx.APPID) {
      return fail('unauthenticated', '缺少可信 OpenID/APPID')
    }
    const config = loadServerConfig()
    // 部署契约：设置期可只配 MC_APPID（成员未配全）。只要 MC_APPID 存在，
    // my-openid 就必须严格比对，不做仅形态校验的放宽
    if (config.appidIfAny) {
      if (ctx.APPID !== config.appidIfAny) {
        return fail('wrong-appid', 'AppID 与配置不符')
      }
    } else {
      return fail('not-configured', '尚未配置 MC_APPID，无法核对调用来源')
    }
    // 只回调用者自己的 OpenID；日志不落完整身份
    return ok({ openid: ctx.OPENID, appId: ctx.APPID, hint: '将此 OpenID 交由管理员配置为成员白名单' })
  }

  const config = loadServerConfig()
  const resolved = resolveCaller(cloud, config, event)
  if (!resolved.ok) {
    return fail(resolved.code, resolved.message)
  }
  const caller = resolved.caller
  return ok({
    memberId: caller.memberId,
    displayName: caller.displayName,
    familyId: config.familyId
  })
}
