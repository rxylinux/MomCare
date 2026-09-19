// B3b codec：规范化 JSON 与记录哈希（设计 §2.4 唯一规则，三端/服务端同一实现）。
// - 对象键字典序；无空白；数字按 ECMAScript ToString；字符串按 JSON.stringify 语义
// - 排除非 schema 值：undefined/function/symbol/BigInt/NaN/Infinity/循环引用
// - 记录哈希 = sha256(UTF8(canonicalJson(record)))——导出与恢复侧同规则重算
import { createHash } from './sha256.js'
import { encodeStrict, hasLoneSurrogate } from './utf8.js'

export class CanonicalError extends Error {
  constructor(message) {
    super(message)
    this.code = 'canonical-invalid'
  }
}

function canonicalString(value, seen) {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'string') {
    // 序列化前拒绝孤立代理：JSON.stringify 会把它转成 ASCII \ud800 转义绕开编码层
    if (hasLoneSurrogate(value)) throw new CanonicalError('字符串含未配对孤立代理项（序列化前拒绝）')
    return JSON.stringify(value)
  }
  if (t === 'boolean') return value ? 'true' : 'false'
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new CanonicalError('数字必须是有限值（拒绝 NaN/Infinity）')
    return String(value)
  }
  if (t === 'undefined' || t === 'function' || t === 'symbol' || t === 'bigint') {
    throw new CanonicalError(`不支持的值类型：${t}`)
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new CanonicalError('循环引用')
    seen.add(value)
    // 每个索引须以 own-property 检查：稀疏数组空洞/undefined 一律拒绝（不静默转 null、
    // 不跳过——否则会产出形如 [1,,3] 的非法/失真 JSON）
    const parts = []
    for (let i = 0; i < value.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) throw new CanonicalError(`数组索引 ${i} 为稀疏空洞`)
      const v = value[i]
      if (v === undefined) throw new CanonicalError(`数组索引 ${i} 为 undefined`)
      parts.push(canonicalString(v, seen))
    }
    seen.delete(value)
    return '[' + parts.join(',') + ']'
  }
  if (t === 'object') {
    if (seen.has(value)) throw new CanonicalError('循环引用')
    seen.add(value)
    // 对象值与键逐项拒绝：undefined/function/symbol 值、含孤立代理的键——
    // 不再按 JSON.stringify 语义跳过（跳过=静默丢字段）
    const keys = Object.keys(value).sort()
    const parts = []
    for (const k of keys) {
      if (hasLoneSurrogate(k)) throw new CanonicalError('对象键含未配对孤立代理项')
      const v = value[k]
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') {
        throw new CanonicalError(`对象键 ${k} 的值为 undefined/function/symbol——拒绝`)
      }
      parts.push(JSON.stringify(k) + ':' + canonicalString(v, seen))
    }
    seen.delete(value)
    return '{' + parts.join(',') + '}'
  }
  throw new CanonicalError(`未知类型：${t}`)
}

export function canonicalJsonString(value) {
  return canonicalString(value, new Set())
}

export function canonicalJsonBytes(value) {
  return encodeStrict(canonicalJsonString(value)) // 孤立代理在编码层拒绝
}

export function recordHash(record) {
  const hash = createHash()
  hash.update(canonicalJsonBytes(record))
  return hash.digest()
}

// manifest 序列化（确定性；同 canonical 规则）与字节摘要
export function manifestBytes(manifest) {
  return canonicalJsonBytes(manifest)
}

export function bytesSha256Hex(bytes) {
  const hash = createHash()
  hash.update(bytes)
  return hash.digest()
}
