// B3b codec：严格 UTF-8 层（设计 §2.4 两层孤立代理检测）。
// - encodeStrict：字符串 → UTF-8 字节；未配对孤立代理（U+D800–DFFF 单独出现）拒绝
//   （B3a 旧 utf8Encode 会产出 ED A0 80 类非法 UTF-8——.mcpkg 不继承该行为）
// - decodeStrict：字节 → 字符串；非法序列/超长编码/代理区编码/超 U+10FFFF 拒绝
// - assertNoLoneSurrogatesDeep：JSON 解析后的递归字符串检查（manifest 与领域记录），
//   ASCII 转义（\uD800 解析出的孤立代理）同样拒绝——检查在解析后的字符串层
export class McPkgTextError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export function hasLoneSurrogate(str) {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++ // 合法配对跳过
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true // 低代理单独出现
    }
  }
  return false
}

export function encodeStrict(str) {
  if (typeof str !== 'string') throw new McPkgTextError('invalid-type', 'encodeStrict 只接受 string')
  if (hasLoneSurrogate(str)) {
    throw new McPkgTextError('malformed-surrogate', '字符串含未配对孤立代理项——拒绝编码入包')
  }
  const out = []
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i)
    if (c < 0x80) { out.push(c); continue }
    if (c >= 0xd800 && c <= 0xdbff) {
      // 已确认配对
      const lo = str.charCodeAt(++i)
      c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00)
    }
    if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    } else if (c < 0x10000) {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    } else {
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    }
  }
  return new Uint8Array(out)
}

export function decodeStrict(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new McPkgTextError('invalid-type', 'decodeStrict 只接受 Uint8Array')
  let out = ''
  let i = 0
  const n = bytes.length
  while (i < n) {
    const b = bytes[i]
    if (b < 0x80) { out += String.fromCharCode(b); i++; continue }
    let len = 0, cp = 0
    if (b >= 0xc2 && b <= 0xdf) { len = 1; cp = b & 0x1f }
    else if (b >= 0xe0 && b <= 0xef) { len = 2; cp = b & 0x0f }
    else if (b >= 0xf0 && b <= 0xf4) { len = 3; cp = b & 0x07 }
    else {
      throw new McPkgTextError('malformed-utf8', `非法 UTF-8 起始字节 0x${b.toString(16)} @${i}`)
    }
    if (i + len > n - 1) throw new McPkgTextError('malformed-utf8', `UTF-8 序列在末尾截断 @${i}`)
    for (let k = 1; k <= len; k++) {
      const cb = bytes[i + k]
      if ((cb & 0xc0) !== 0x80) throw new McPkgTextError('malformed-utf8', `UTF-8 后续字节非法 @${i + k}`)
      cp = (cp << 6) | (cb & 0x3f)
    }
    // 超长编码 / 代理区 / 超 U+10FFFF
    if (len === 1 && cp < 0x80) throw new McPkgTextError('malformed-utf8', '超长编码')
    if (len === 2 && cp < 0x800) throw new McPkgTextError('malformed-utf8', '超长编码')
    if (len === 3 && cp < 0x10000) throw new McPkgTextError('malformed-utf8', '超长编码')
    if (cp >= 0xd800 && cp <= 0xdfff) throw new McPkgTextError('malformed-utf8', '代理区编码（如 ED A0 80）非法')
    if (cp > 0x10ffff) throw new McPkgTextError('malformed-utf8', '超 U+10FFFF')
    out += cp < 0x10000 ? String.fromCharCode(cp) : String.fromCodePoint(cp)
    i += len + 1
  }
  return out
}

// 解析后递归字符串检查：遍历对象/数组的每个 string 值
export function assertNoLoneSurrogatesDeep(value, path = '$', seen = null) {
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) {
      throw new McPkgTextError('malformed-surrogate', `${path} 含未配对孤立代理项（含 ASCII 转义来源）`)
    }
    return
  }
  if (value === null || typeof value !== 'object') return
  if (!seen) seen = new Set()
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertNoLoneSurrogatesDeep(value[i], `${path}[${i}]`, seen)
    return
  }
  for (const k of Object.keys(value)) {
    // 键也是序列化内容（canonicalJsonString 会对键做孤立代理检查——解析后检查同规则覆盖）
    if (hasLoneSurrogate(k)) {
      throw new McPkgTextError('malformed-surrogate', `${path} 的对象键含未配对孤立代理项`)
    }
    assertNoLoneSurrogatesDeep(value[k], `${path}.${k}`, seen)
  }
}
