// B3b codec：增量 SHA-256（mp/H5/Node 三端同一纯 JS 实现）。
// 算法与 B3a migrationStore 的整输入 sha256HexSync 同源（NIST 向量核验过的算法），
// 升级为固定小缓冲块处理接口：createHash() → update(Uint8Array) → digest()。
// update 只接收 Uint8Array——字符串必须先经严格 UTF-8 编码层（./utf8.js），
// 编码与分块职责分层（设计 §2.7）。包上限 64MiB，总长度用安全整数计数。
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]

function rotr(x, n) { return (x >>> n) | (x << (32 - n)) }

export function createHash() {
  const h = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const buf = new Uint8Array(64)
  const w = new Int32Array(64)
  let bufLen = 0
  let totalLen = 0
  let done = false

  function processBlock(block, offset) {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4
      w[i] = (block[j] << 24) | (block[j + 1] << 16) | (block[j + 2] << 8) | block[j + 3]
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7]
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) | 0
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0
  }

  return {
    update(chunk) {
      if (done) throw new Error('sha256: digest 之后不可再 update')
      if (!(chunk instanceof Uint8Array)) {
        throw new Error('sha256 update 只接收 Uint8Array——字符串须先经严格 UTF-8 编码层')
      }
      totalLen += chunk.length
      let offset = 0
      if (bufLen > 0) {
        const need = 64 - bufLen
        const take = Math.min(need, chunk.length)
        buf.set(chunk.subarray(0, take), bufLen)
        bufLen += take
        offset = take
        if (bufLen === 64) { processBlock(buf, 0); bufLen = 0 }
      }
      while (offset + 64 <= chunk.length) {
        processBlock(chunk, offset)
        offset += 64
      }
      if (offset < chunk.length) {
        buf.set(chunk.subarray(offset), 0)
        bufLen = chunk.length - offset
      }
      return this
    },
    digest() {
      if (done) throw new Error('sha256: digest 只能调用一次')
      done = true
      const bitLenHi = Math.floor(totalLen / 0x20000000)
      const bitLenLo = (totalLen << 3) >>> 0
      const padLen = bufLen < 56 ? 56 - bufLen : 120 - bufLen
      const tail = new Uint8Array(padLen + 8)
      tail[0] = 0x80
      const bitView = new DataView(tail.buffer)
      bitView.setUint32(tail.length - 8, bitLenHi)
      bitView.setUint32(tail.length - 4, bitLenLo)
      // 复用 update 的缓冲逻辑处理 padding
      const full = new Uint8Array(bufLen + tail.length)
      full.set(buf.subarray(0, bufLen), 0)
      full.set(tail, bufLen)
      let off = 0
      while (off + 64 <= full.length) { processBlock(full, off); off += 64 }
      let hex = ''
      for (let i = 0; i < 8; i++) hex += (h[i] >>> 0).toString(16).padStart(8, '0')
      return hex
    }
  }
}

export function sha256Hex(bytes) {
  const hash = createHash()
  hash.update(bytes)
  return hash.digest()
}
