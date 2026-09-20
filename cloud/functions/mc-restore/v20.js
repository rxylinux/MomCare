// V20 索引块子协议——纯函数模块（内部首实现切片）
// 依据：docs/ZCODE_PHASE_B3B_INDEX_BLOCK_PROTOCOL.md @250a238b（预编码门已放行——本切片仅内部模块，
// 新动作不经公共 action 分派；index.js 未引用本文件——既有 handler 行为零改动）。
// 覆盖：§6.1 确定性全流派生（六类条目+DOMAIN_ORDER）/canonical 碎片/§2 六态码图/§6.2 10KiB∧48 打包/
//      §6.3 Merkle（父输出索引约定+奇叶自配+零块根+规范向量锚）/§6.4-② 严格 proof 验证（侧位服务端自推导）/
//      readVerifiedBlock 已验证读助手（写期绑定+读期根锚定语义的纯函数面）。
// 不含：DB 读写、状态机事务、handler 分派（后续切片）。
'use strict'
const crypto = require('crypto')
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest()
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b }

// ── 常量（§2/§6.2/§6.3/D20/D23）──
const DOMAIN_ORDER = ['pregnancy', 'daily', 'mood', 'checkup', 'bag', 'reports']
const CODE_TABLE = ['', 'undefined', 'null', '0', 'false'] // code 1-5（§0 五值集）
const CODE_EQUAL = 0
const FRAG_MAX = 1400 // 碎片 ≤1.4KiB（§6.1）
const FRAG_TRIGGER = 1024 // 字段 canonical >1KiB 触发分片（确定性阈值）
const ENTRY_MAX = 2048, BLOCK_NET = 10 * 1024, ENTRIES_PER_BLOCK = 48
const VECTOR = { // §6.3 三叶规范向量（hex 声明字节——任意原始字节非规范块 JSON）
  blocks: [Buffer.from([0x41]), Buffer.from([0x42, 0x42]), Buffer.from([0x43, 0x43, 0x43])],
  rootHex: '91298894cd60d7dae5aca1b1b257eb2c1bdd7f8431155435c6ff086b1712a42b',
}

// ── 严格 canonical 序列化（拒绝 undefined/稀疏/孤立代理/非有限数/环；自有属性检查；键排序紧凑）──
function canonicalJsonBytes(value) {
  const out = []
  const walk = (v, seen) => {
    if (v === undefined) throw new Error('canonical: undefined 不可序列化')
    if (v === null) { out.push('null'); return }
    const t = typeof v
    if (t === 'number') {
      if (!Number.isFinite(v)) throw new Error('canonical: 非有限数')
      out.push(JSON.stringify(v)); return
    }
    if (t === 'string') {
      const stripped = v.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
      if (/[\uD800-\uDFFF]/.test(stripped)) throw new Error('canonical: 孤立代理项')
      out.push(JSON.stringify(v)); return
    }
    if (t === 'boolean') { out.push(v ? 'true' : 'false'); return }
    if (Array.isArray(v) || t === 'object') {
      if (seen.has(v)) throw new Error('canonical: 环引用')
      seen.add(v)
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) if (!Object.hasOwn(v, i)) throw new Error('canonical: 稀疏数组')
        out.push('['); v.forEach((x, i) => { if (i) out.push(','); walk(x, seen) }); out.push(']')
      } else {
        const keys = Object.keys(v).sort()
        out.push('{'); keys.forEach((k, i) => { if (i) out.push(','); walk(k, seen); out.push(':'); walk(v[k], seen) }); out.push('}')
      }
      seen.delete(v); return
    }
    throw new Error('canonical: 不可序列化类型 ' + t)
  }
  walk(value, new WeakSet())
  return Buffer.from(out.join(''), 'utf8')
}

// ── §2 六态码图：打包/严格读回 ──
function packCodes(codes) {
  const bytes = Buffer.alloc(Math.ceil(codes.length * 3 / 8))
  codes.forEach((c, j) => {
    if (!Number.isInteger(c) || c < 0 || c > 5) throw new Error('packCodes: 非法码 ' + c + '（6/7 保留）')
    for (let k = 0; k < 3; k++) { const p = j * 3 + k; if ((c >> k) & 1) bytes[p >> 3] |= 1 << (p & 7) }
  })
  return bytes.toString('base64')
}
function readCodes(b64, count) {
  if (typeof b64 !== 'string') throw new Error('readCodes: codes 须字符串')
  const raw = Buffer.from(b64, 'base64')
  if (raw.toString('base64') !== b64) throw new Error('readCodes: 非规范 base64（重编码不等）')
  const need = Math.ceil(count * 3 / 8)
  if (raw.length !== need) throw new Error(`readCodes: 长度 ${raw.length} ≠ ⌈3·${count}/8⌉=${need}`)
  for (let p = count * 3; p < raw.length * 8; p++) if ((raw[p >> 3] >> (p & 7)) & 1) throw new Error('readCodes: 尾部 pad 位非 0')
  const out = []
  for (let j = 0; j < count; j++) {
    let c = 0
    for (let k = 0; k < 3; k++) { const p = j * 3 + k; c |= ((raw[p >> 3] >> (p & 7)) & 1) << k }
    if (c > 5) throw new Error('readCodes: 保留码 ' + c)
    out.push(c)
  }
  return out
}
// 派生期单槽码（§0/§4：sm===sf→0；sm∈表→索引；否则 fail-stop）
function deriveCode(mOid, fOid) {
  const sm = String(mOid), sf = String(fOid)
  if (sm === sf) return CODE_EQUAL
  const idx = CODE_TABLE.indexOf(sm)
  if (idx === -1) throw new Error('deriveCode: 映射 String 超六态（fail-stop）: ' + JSON.stringify(sm))
  return idx + 1
}

// ── canonical 碎片（§6.1——载荷=canonicalJsonBytes(值) 切片，seq 连续 ≤1.4KiB）──
function fragment(value) {
  const bytes = canonicalJsonBytes(value)
  if (bytes.length <= FRAG_TRIGGER) return { inline: true, bytes }
  const parts = []
  for (let i = 0; i < bytes.length; i += FRAG_MAX) parts.push(bytes.slice(i, i + FRAG_MAX))
  return { inline: false, bytes, parts }
}

// ── 增量 staged 打包器（§6.4 P2——协调方阻断：逐条目 fail-stop，不先全量派生/打包）──
// 维护贪心当前块+已封块累计字节：每次 append 后立即检查
// sealed+curBytes >12MiB ∨ count >98,304 ∨ 下一块将超 2,048——首个越限即停（内存/CPU 有界）。
const LOGIC_CAP = 12 * 1024 * 1024, ENTRY_COUNT_CAP = 98304, BLOCK_COUNT_CAP = 2048
function makeStagedPacker() {
  const blocks = []
  let cur = [], curBytes = 2, sealed = 0, count = 0
  const seal = () => { const b = canonicalJsonBytes(cur); blocks.push(b); sealed += b.length; cur = []; curBytes = 2 }
  return {
    push(entry, canonical) {
      // 伪造 canonical 防御（协调方阻断复核：packBlocks 兼容入口不受信——supplied canonical 可为 1B 假值
      // 而 entry 实际 12KB+，绕 BLOCK_NET 装填判定产出 >10KiB 实际块）。恒自 entry 重算并断言等价。
      const recomputed = canonicalJsonBytes(entry)
      if (!recomputed.equals(canonical)) throw new Error(`packBlocks: 伪造/漂移 canonical（供给 ${canonical.length}B ≠ 实算 ${recomputed.length}B——fail-stop）`)
      canonical = recomputed
      // 单条目硬顶（协调方纠正：仅重算不够——12KB 单条目仍会开启超限 cur 并被 finish 封出）：
      // 实算 canonical 恒 ≤ENTRY_MAX；任何路径（含 rollover 新块）单条不得超 BLOCK_NET。
      if (canonical.length > ENTRY_MAX) throw new Error(`packBlocks: 单条目实算 ${canonical.length}B > ENTRY_MAX ${ENTRY_MAX}B（须拆分——fail-stop）`)
      if (canonical.length + 2 > BLOCK_NET) throw new Error(`packBlocks: 单条目+封套 ${canonical.length + 2}B > BLOCK_NET ${BLOCK_NET}B（单块容不下——fail-stop）`)
      const add = (cur.length ? 1 : 0) + canonical.length
      if (curBytes + add > BLOCK_NET || cur.length === ENTRIES_PER_BLOCK) {
        if (cur.length) seal()
        if (blocks.length + 1 > BLOCK_COUNT_CAP) throw new Error(`packBlocks: 块 ${blocks.length + 1} > ${BLOCK_COUNT_CAP}（第 ${count + 1} 条目即停——增量 fail-stop）`)
        cur = [entry]; curBytes = 2 + canonical.length
      } else { cur.push(entry); curBytes += add }
      count++
      if (count > ENTRY_COUNT_CAP) throw new Error(`packBlocks: 条目 ${count} > ${ENTRY_COUNT_CAP}（增量 fail-stop）`)
      if (sealed + curBytes > LOGIC_CAP) throw new Error(`packBlocks: stagedBytes（实际块 canonical，含数组括号/逗号）${sealed + curBytes} > ${LOGIC_CAP}（第 ${count} 条目即停——增量 fail-stop——条目和低估）`)
    },
    finish() {
      if (cur.length) {
        // 封前终检（协调方纠正：rollover 后的超限单块须在此拒——不留"start 即超"通道）
        if (curBytes > BLOCK_NET) throw new Error(`packBlocks: 末块 ${curBytes}B > BLOCK_NET ${BLOCK_NET}B（fail-stop）`)
        seal()
      }
      if (blocks.length > BLOCK_COUNT_CAP) throw new Error(`packBlocks: 块 ${blocks.length} > ${BLOCK_COUNT_CAP}（fail-stop）`)
      if (sealed > LOGIC_CAP) throw new Error(`packBlocks: stagedBytes ${sealed} > ${LOGIC_CAP}（fail-stop）`)
      return blocks
    },
    stats: () => ({ count, sealed, current: curBytes, blocks: blocks.length }),
  }
}

// ── §6.1 确定性全流派生（六类条目；DOMAIN_ORDER 域序——push 期增量执法）──
function deriveV20Stream(manifest) {
  const entries = []
  const packer = makeStagedPacker()
  const push = (e) => {
    const b = canonicalJsonBytes(e)
    if (b.length > ENTRY_MAX) throw new Error(`derive: 单条目 ${e.type} ${b.length}B > ${ENTRY_MAX}B（须拆分）`)
    entries.push({ entry: e, canonical: b })
    packer.push(e, b) // 增量 fail-stop（§6.4 P2——超限在此即停，不待全量）
  }
  // 组 1：record（DOMAIN_ORDER 域序，域内 index===数组位置；巨 id→idRef 短承诺+idfrag）
  for (const d of DOMAIN_ORDER) {
    const decls = (manifest.records && manifest.records[d]) || []
    decls.forEach((decl, idx) => {
      if (decl.index !== idx) throw new Error(`derive: records.${d}[${idx}].index ≠ 数组位置`)
      const idFrag = fragment(decl.id)
      const core = { type: 'record', domain: d, index: idx, revision: decl.revision, deleted: decl.deleted, hash: decl.hash }
      if (idFrag.inline) core.id = decl.id
      else core.idRef = { len: idFrag.bytes.length, sha256: sha256(idFrag.bytes).toString('hex'), frags: idFrag.parts.length } // 重建元数据
      push(core)
      if (!idFrag.inline) idFrag.parts.forEach((p, seq) => push({ type: 'idfrag', domain: d, index: idx, seq, data: p.toString('base64') }))
    })
  }
  // 组 2+3：file core（附件按 fileIndex 升序；cshafrag→orig→path 分片序紧随其后——但 core 先入流，
  //          碎片按 §6.1"紧随其 file core"排列：先 core 后 cshafrag/orig/filefrag(path)）
  const files = manifest.files || []
  files.forEach((f, fi) => {
    if (f.kind !== 'attachment') return
    const core = { type: 'file', fileIndex: fi, sha256: f.sha256, length: f.length, contentType: f.contentType, path: f.path, kind: f.kind }
    if (f.chunkSha256 !== undefined) core.chunkSha256 = f.chunkSha256 // 全字段先内联（E1 重写曾漏——数据丢失缺陷）
    if (f.originalFileId !== undefined) core.originalFileId = f.originalFileId
    const mkRef = (bytes, parts) => ({ len: bytes.length, sha256: sha256(bytes).toString('hex'), frags: parts.length })
    const sliceParts = (bytes) => { const parts = []; for (let i = 0; i < bytes.length; i += FRAG_MAX) parts.push(bytes.slice(i, i + FRAG_MAX)); return parts }
    // 碎片规则（合并两轨，单遍确定性序 csha→orig→path）：
    // ① eager：字段 canonical >1KiB（FRAG_TRIGGER）→ 碎片（原规则——core 保持小）
    // ② E1（TESTING c486ae7c）：core 仍 >2KiB（多字段各 <1KiB 合并超限）→ 强制续碎直至 ≤2KiB
    const fragOrder = ['chunkSha256', 'originalFileId', 'path']
    const fragged = {} // field → {bytes, parts}
    for (const field of fragOrder) {
      if (f[field] === undefined) continue
      const bytes = canonicalJsonBytes(f[field])
      const need = bytes.length > FRAG_TRIGGER || canonicalJsonBytes(core).length > ENTRY_MAX
      if (!need) continue
      const parts = sliceParts(bytes)
      fragged[field] = { bytes, parts }
      delete core[field]
      core[field + 'Ref'] = mkRef(bytes, parts)
    }
    push(core)
    // 碎片紧随 core（§6.1 顺序 cshafrag→orig→path——仅碎字段）
    if (fragged.chunkSha256) fragged.chunkSha256.parts.forEach((p, seq) => push({ type: 'cshafrag', fileIndex: fi, seq, data: p.toString('base64') }))
    if (fragged.originalFileId) fragged.originalFileId.parts.forEach((p, seq) => push({ type: 'filefrag', fileIndex: fi, field: 'originalFileId', seq, data: p.toString('base64') }))
    if (fragged.path) fragged.path.parts.forEach((p, seq) => push({ type: 'filefrag', fileIndex: fi, field: 'path', seq, data: p.toString('base64') }))
  })
  // 组 4：refs（按 fileIndex 升序，每文件 part 0..n，≤48 项 ∧ ≤2KiB）
  // D24-r：items={order, recIndex}——**不复制 rid**（合法 reportId 可 >2KiB——同 record idfrag 理由）。
  // recIndex=records.reports 中 **id===reportId** 的数组位置（按 id 显式匹配——Stage1 validateManifest
  // 以 reportId 配对非位置：reports 数组可与 records.reports 不同序（Stage1-valid）——不得假设相等）。
  const recIndexOf = new Map()
  ;((manifest.records && manifest.records.reports) || []).forEach((decl, di) => recIndexOf.set(decl.id, di))
  // D26（协调方真包反例裁定 2026-09-20）：Stage1 container 一致以
  // Array.isArray(x) ? x : [] 归一化 attachments（空对象/缺席/非数组均→[]——真包 ok/零 problems 复验）。
  // V20 同语义归一（拒绝会误拒 Stage1-valid 形；非数组静默变 [] 与 Stage1 完全一致——零静默畸形面）。
  const attsOf = (rd) => (Array.isArray(rd.attachments) ? rd.attachments : [])
  // D25/S0（协调方作用域修正 2026-09-20）：**先判重再收集**——refs 循环曾先收全量后判重，
  // 双非空重复（Stage1-invalid 同 order 形）会在 throw 前已把两目 attachments 各自入 byFile（非对称）。
  // 归一：单遍顺序——对每条 report 先走 D25 三轨判定（重复时取首目语义），仅首目有效映射参与收集。
  // D25-r2 终版（先判重再收集——与 rmappart 侧同语义）：尾随有效空=恒 no-op；一切非空尾随重复=拒
  const firstById = new Map()
  for (const rd of manifest.reports || []) {
    const first = firstById.get(rd.reportId)
    if (first !== undefined) {
      if (attsOf(rd).length === 0) continue // 尾随有效空——恒 no-op（D25-r2 终版）
      throw new Error('derive: reportId 重复且尾随非空（fail-stop，D25-r2 终版）: ' + JSON.stringify(rd.reportId).slice(0, 40))
    }
    firstById.set(rd.reportId, rd)
  }
  const byFile = new Map()
  for (const rd of firstById.values()) {
    const recIndex = recIndexOf.get(rd.reportId)
    if (recIndex === undefined) throw new Error(`derive: reportId 无锚定 record（records.reports 无 id 匹配——Stage1 闭包应拒）: ${JSON.stringify(rd.reportId).slice(0, 40)}`)
    for (const a of attsOf(rd)) {
      if (!byFile.has(a.fileIndex)) byFile.set(a.fileIndex, [])
      byFile.get(a.fileIndex).push({ order: a.order, recIndex })
    }
  }
  for (const fi of [...byFile.keys()].sort((a, b) => a - b)) {
    const items = byFile.get(fi)
    // 精确候选量测：每步 canonical 实测候选 part 条目（封套/part 位数增长全计入——无估算）
    let cur = [], part = 0
    for (const it of items) {
      const cand = [...cur, it]
      const candB = canonicalJsonBytes({ type: 'refs', fileIndex: fi, part, items: cand }).length
      if (cur.length && (candB > ENTRY_MAX || cand.length > ENTRIES_PER_BLOCK)) {
        push({ type: 'refs', fileIndex: fi, part: part++, items: cur })
        cur = [it]
      } else cur = cand
    }
    if (cur.length) push({ type: 'refs', fileIndex: fi, part, items: cur })
  }
  // 组 5：rmappart（recIndex 升序——**按 id 锚定的 records.reports 位置**（D24-r：Stage1 以 reportId 配对
  //        非位置——reports 可重排）；part 0..n；codes=六态码图恒在场；startSlot=累计实际前长；
  //        精确候选量测——codes base64 增长（4 字符/3 字节量子）与封套全计入）
  // 性能（协调方指认）：单遍 Map reportId→report 条目+records 序迭代 O(1) 查找——
  // 旧 find-per-record 为 O(N²)（万报告≈亿次比较）。
  // D25-r2 终版（协调方裁定 2026-09-20——handler 集成前决策）：
  // Stage1 find-first 取首报告映射，并把非数组或空尾随 attachments 投影为零。
  // **尾随有效空映射=恒 no-op**（即使携带未知 own 键如 __proto__——原始字节由 manifest chunks+digest 保护，
  // 恢复业务报告用首有效映射，**不承诺保留未知尾随字段**）。
  // **一切非空尾随重复=拒**——即使原始 canonical 全等：Stage1 拒同 order 重复；异 order 重复为歧义；
  // 接受全等非空重复会使 refs 含两 item 而 rmappart 仅一（不对称）。
  const reportById = new Map()
  for (const rd of manifest.reports || []) {
    const first = reportById.get(rd.reportId)
    if (first !== undefined) {
      if (attsOf(rd).length === 0) continue // 尾随有效空（归一后 0 附件）——跳过映射内部判定；**非"其余字段被忽略"**：
      // revision/deleted 与声明不符的拒绝门在生产 handler 的 reports↔records 交叉校验中保留（纯派生层无此门）。
      // 业务取首映射；原始字节由 chunks/digest 保护。
      throw new Error('derive: reportId 重复且尾随非空（fail-stop，D25-r2 终版——同 order 为 Stage1-invalid、异 order 为歧义、全等亦拒（refs/rmappart 不对称））: ' + JSON.stringify(rd.reportId).slice(0, 40))
    }
    reportById.set(rd.reportId, rd)
  }
  ;((manifest.records && manifest.records.reports) || []).forEach((decl, recIndex) => {
    const rd = reportById.get(decl.id)
    if (!rd) return // record 无对应 reports 映射（零附件或闭包外——不产 rmappart）
    const atts = attsOf(rd)
    if (atts.length === 0) return
    const parts = []
    let curItems = [], curCodes = [], startSlot = 0
    const flushPart = () => {
      if (!curItems.length) return
      parts.push({ items: curItems, codes: curCodes, startSlot })
      startSlot += curItems.length
      curItems = []; curCodes = []
    }
    for (let slot = 0; slot < atts.length; slot++) {
      const a = atts[slot]
      const it = { slot, order: a.order, fileIndex: a.fileIndex }
      const code = deriveCode(a.originalFileId, (files[a.fileIndex] || {}).originalFileId)
      const candItems = [...curItems, it], candCodes = [...curCodes, code]
      const candB = canonicalJsonBytes({ type: 'rmappart', recIndex, part: parts.length, startSlot, items: candItems, codes: packCodes(candCodes) }).length
      if (curItems.length && (candB > ENTRY_MAX || candItems.length > 56)) { flushPart(); curItems = [it]; curCodes = [code] }
      else { curItems = candItems; curCodes = candCodes }
    }
    flushPart()
    parts.forEach((p, pi) => push({ type: 'rmappart', recIndex, part: pi, startSlot: p.startSlot, items: p.items, codes: packCodes(p.codes) }))
  })
  const entryBytesSum = entries.reduce((a, e) => a + e.canonical.length, 0)
  // 权威逻辑量（协调方阻断修正 2026-09-20）：stagedBytes=**实际 staged 块 canonical 字节**（§6.4 P2——
  // 含每块两数组括号+条目间逗号）。打包已在 push 期增量完成（超限即时停）；finish 封末块+终检。
  const blocks = packer.finish()
  const stagedBytes = blocks.reduce((a, b) => a + b.length, 0)
  return { entries, blocks, stagedBytes, entryBytesSum, totalBlocks: blocks.length, count: entries.length }
}

// 兼容打包入口（原始 entries 流）：喂入增量打包器（同 push 期执法）
function packBlocksInternal(entries) {
  const packer = makeStagedPacker()
  for (const { entry, canonical } of entries) packer.push(entry, canonical)
  return packer.finish()
}
// 兼容入口：stream 含缓存 blocks 时**不受信**（协调方阻断）——自 entries 重打包并逐块字节比对，
// forged/漂移缓存一律拒；返回重打包结果（已验证副本）。
function packBlocks(stream) {
  if (Array.isArray(stream.blocks)) {
    const rebuilt = packBlocksInternal(stream.entries)
    if (rebuilt.length !== stream.blocks.length || !rebuilt.every((b, i) => b.equals(stream.blocks[i]))) {
      throw new Error('packBlocks: 缓存 blocks 与 entries 重打包不符（拒绝 forged/漂移缓存——不受信）')
    }
    return rebuilt
  }
  return packBlocksInternal(stream.entries)
}

// ── §6.3 Merkle（父输出索引 j=父在输出层内索引；奇叶自配；T=0 空根；T=1 根=叶）──
const leafHash = (totalBlocks, i, blockBytes) => sha256(Buffer.concat([Buffer.from('mcpkg-blk:'), u32(totalBlocks), u32(i), blockBytes]))
const parentHash = (totalBlocks, L, j, l, r) => sha256(Buffer.concat([Buffer.from('mcpkg-par:'), u32(totalBlocks), u32(L), u32(j), l, r]))
const emptyRoot = () => sha256(Buffer.from('mcpkg-empty'))

function buildTree(blocks) {
  const T = blocks.length
  if (T === 0) return { root: emptyRoot(), proofs: [], layerSizes: [] }
  if (T === 1) return { root: leafHash(1, 0, blocks[0]), proofs: [''], layerSizes: [1] }
  let level = blocks.map((b, i) => leafHash(T, i, b))
  const layerSizes = [T]
  const pos = blocks.map((_, i) => [i]) // 每块在各层的索引
  const sibs = blocks.map(() => []) // 每块逐层 {sibling, isLeft, isDup}
  let L = 0
  while (level.length > 1) {
    const next = []
    for (let j = 0; j < level.length; j += 2) {
      const hasRight = j + 1 < level.length
      const left = level[j], right = hasRight ? level[j + 1] : level[j] // 奇叶自配
      const parentJ = next.length // 父输出索引（0,1,2…）
      next.push(parentHash(T, L, parentJ, left, right))
      for (let i = 0; i < T; i++) {
        const p = pos[i][L]
        if (p === j || p === j + 1) {
          const isDup = p === j && !hasRight
          const sibling = p === j ? right : left
          sibs[i].push({ sibling, isLeft: p === j, isDup })
          pos[i].push(parentJ)
        }
      }
    }
    level = next; layerSizes.push(level.length); L++
  }
  const proofs = sibs.map(arr => Buffer.concat(arr.map(x => x.sibling)).toString('base64'))
  return { root: level[0], proofs, layerSizes }
}

// 侧位自推导（服务端从 (T, i) 推导每层父索引/左右/dup——不信任客户端方向标）
function deriveSides(totalBlocks, blockIndex) {
  const sides = []
  let n = totalBlocks, x = blockIndex
  while (n > 1) {
    sides.push({ parentJ: x >> 1, left: x % 2 === 0, dup: x % 2 === 0 && n - x === 1 })
    x >>= 1; n = Math.ceil(n / 2)
  }
  return sides
}

// ── §6.4-② 严格 proof 验证（规范单串形/严格长度/侧位自推导/dup 严格等）──
function verifyProof({ totalBlocks, blockIndex, blockBytes, proof, planRoot }) {
  // 输入硬门（协调方指认：u32 强转吞非法输入——T=0 可验出伪造单叶根）：
  // totalBlocks 恒整数 [1,2048]；blockIndex 恒整数 [0,totalBlocks)。零块**仅**经 emptyRoot 状态（§6.3）——无块证明。
  if (!Number.isInteger(totalBlocks) || totalBlocks < 1 || totalBlocks > 2048) throw new Error(`verifyProof: totalBlocks 须 [1,2048] 整数（=${totalBlocks}——零块仅经 emptyRoot 状态）`)
  if (!Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex >= totalBlocks) throw new Error(`verifyProof: blockIndex 须 [0,${totalBlocks}) 整数（=${blockIndex}）`)
  if (!Buffer.isBuffer(blockBytes)) throw new Error('verifyProof: blockBytes 须 Buffer')
  if (typeof proof !== 'string') throw new Error('verifyProof: proof 须单一 base64 字符串（数组分串形禁用）')
  const raw = Buffer.from(proof, 'base64')
  if (raw.toString('base64') !== proof) throw new Error('verifyProof: 非规范 base64（重编码不等）')
  const expect = totalBlocks === 1 ? 0 : Math.ceil(Math.log2(totalBlocks)) * 32
  if (raw.length !== expect) throw new Error(`verifyProof: 长度 ${raw.length} ≠ ⌈log2(${totalBlocks})⌉×32=${expect}`)
  if (totalBlocks === 1) { if (!leafHash(1, 0, blockBytes).equals(planRoot)) throw new Error('verifyProof: T=1 叶≠根'); return true }
  let h = leafHash(totalBlocks, blockIndex, blockBytes)
  const sides = deriveSides(totalBlocks, blockIndex)
  if (sides.length * 32 !== raw.length) throw new Error('verifyProof: 侧位数与 proof 长度不符')
  sides.forEach((s, L) => {
    const sib = raw.slice(L * 32, L * 32 + 32)
    if (s.dup && !sib.equals(h)) throw new Error(`verifyProof: dup 层 sibling ≠ 当前折叠哈希（L=${L}）`)
    h = s.left ? parentHash(totalBlocks, L, s.parentJ, h, sib) : parentHash(totalBlocks, L, s.parentJ, sib, h)
  })
  if (!h.equals(planRoot)) throw new Error('verifyProof: 根折叠不匹配')
  return true
}

// ── readVerifiedBlock 语义的纯函数面（§6.5：canonical entries→byteLength→叶→proof 折叠=planRoot）──
// 协议块文档无 blockIndex 字段（在 _id 内）——blockIndex 由受信调用方传入并校验 _id 一致。
function verifiedBlockRead({ blockDoc, batch, blockIndex }) {
  const expectId = `${batch.batchId}:blk:${blockIndex}`
  if (blockDoc._id !== expectId) throw new Error(`verifiedBlockRead: _id 不符（${blockDoc._id} ≠ ${expectId}）`)
  // D21 读侧形状（协调方阻断：对象形 entries 曾被自洽 leaf/proof 接受）：entries 恒数组——非数组即拒。
  if (!Array.isArray(blockDoc.entries)) throw new Error('verifiedBlockRead: entries 须数组（D21——对象形拒）')
  // 读侧块硬限（协调方阻断：读路径须独立执法——不依赖写路径已检）：≤48 条/块 ∧ 每条 canonical ≤2KiB ∧ 块 canonical ≤10KiB。
  if (blockDoc.entries.length > ENTRIES_PER_BLOCK) throw new Error(`verifiedBlockRead: 条目数 ${blockDoc.entries.length} > ${ENTRIES_PER_BLOCK}/块`)
  for (let i = 0; i < blockDoc.entries.length; i++) {
    const eB = canonicalJsonBytes(blockDoc.entries[i])
    if (eB.length > ENTRY_MAX) throw new Error(`verifiedBlockRead: entries[${i}] canonical ${eB.length}B > ENTRY_MAX ${ENTRY_MAX}B`)
  }
  const payloadBytes = canonicalJsonBytes(blockDoc.entries)
  if (payloadBytes.length > BLOCK_NET) throw new Error(`verifiedBlockRead: 块 canonical ${payloadBytes.length}B > BLOCK_NET ${BLOCK_NET}B`)
  if (payloadBytes.length !== blockDoc.byteLength) throw new Error('verifiedBlockRead: byteLength 不符')
  if (blockDoc.entries.length !== blockDoc.entryCount) throw new Error('verifiedBlockRead: entryCount 不符')
  if (typeof blockDoc.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(blockDoc.sha256)) throw new Error('verifiedBlockRead: sha256 字段缺失/非法（§6.4-④ 恒在场——64hex）')
  // 协议 §6.4-④/§6.5-bis（协调方紧急修正）：sha256 字段=**位置绑定 Merkle 叶哈希**
  // leafHash(totalBlocks, blockIndex, canonicalJsonBytes(entries))——非 sha256(payloadBytes) 裸哈希
  const recomputedLeaf = leafHash(batch.totalBlocks, blockIndex, payloadBytes)
  if (recomputedLeaf.toString('hex') !== blockDoc.sha256) throw new Error('verifiedBlockRead: sha256 字段≠重算位置绑定叶哈希（C3-⑤ sha256-only 篡改拒）')
  verifyProof({ totalBlocks: batch.totalBlocks, blockIndex, blockBytes: payloadBytes, proof: blockDoc.proof, planRoot: Buffer.from(batch.planRoot, 'hex') })
  return payloadBytes
}

// ── §6.3 规范向量自检（hex 声明字节——JSON 重释形必须不等）──
function selfCheckVector() {
  const t = buildTree(VECTOR.blocks)
  const rootHex = t.root.toString('hex')
  if (rootHex !== VECTOR.rootHex) throw new Error('向量自检失败: ' + rootHex)
  VECTOR.blocks.forEach((b, i) => verifyProof({ totalBlocks: 3, blockIndex: i, blockBytes: b, proof: t.proofs[i], planRoot: t.root }))
  // 负例：JSON 引号重释形必须红
  const mis = Buffer.from('"A"', 'utf8')
  try { verifyProof({ totalBlocks: 3, blockIndex: 0, blockBytes: mis, proof: t.proofs[0], planRoot: t.root }); throw new Error('向量自检: 重释形未被拒') } catch (e) { if (/未被拒/.test(e.message)) throw e }
  return true
}

module.exports = {
  DOMAIN_ORDER, CODE_TABLE, FRAG_MAX, ENTRY_MAX, BLOCK_NET, ENTRIES_PER_BLOCK, VECTOR,
  canonicalJsonBytes, packCodes, readCodes, deriveCode, fragment,
  deriveV20Stream, packBlocks, leafHash, parentHash, emptyRoot, buildTree, deriveSides,
  verifyProof, verifiedBlockRead, selfCheckVector,
}
