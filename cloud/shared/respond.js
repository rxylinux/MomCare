'use strict'

// 统一响应与错误码。原则：
// - 错误可被客户端程序化处理（code），不透出内部细节/私人正文
// - 服务端日志只保留 code、成员、耗时等定位字段，不记录私人内容与完整 OpenID

function ok(data) {
  return { ok: true, code: 'ok', data }
}

function fail(code, message, extra) {
  return { ok: false, code, message: message || code, ...(extra || {}) }
}

// 请求参数稳定摘要（幂等去重用）：对业务参数做确定性序列化
function stableRequestHash(obj) {
  return JSON.stringify(obj, (k, v) => {
    if (v === undefined) return null
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v).sort().reduce((acc, key) => { acc[key] = v[key]; return acc }, {})
    }
    return v
  })
}

module.exports = { ok, fail, stableRequestHash }
