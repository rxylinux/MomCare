// B3a 迁移 store：旧数据来源扫描 → 预览 → 确认 → 持久批次 → 逐实体执行。
//
// 协议（SPEC B3a）：
// - 白名单键只读扫描（不遍历整库/token/密钥）；读失败/JSON损坏/未知schema 显示独立错误
// - sourceId 可复现（<sourceKey>:<type>:<key>）；同源同实体去重预览；不同正文分开
// - targetId = mig_<domain>_<sha256(sourceId)[0:16]>——跨重启/丢响应/重复执行同一目标
// - operationId = b3a_<batchId>_<seq>——首次执行前随批次持久
// - 确认绑定身份+源摘要+逐条选择；内容/身份变化重新预览
// - 首次迁入基线 0；已有/较新/已删 → 明确冲突保留，不自动覆盖
// - 严格字段白名单；openid/token/AI旧配额不进 payload
// - mood/symptoms/note/plans 私人——仅当前本人确认后迁本人 mood 域
import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { getSessionState, subscribeSession, currentEpoch, getMemberCache, setMemberCache } from '@/services/sessionService.js'
import { persistLocalCopy } from '@/services/fileUploadService.js'
import { openRecoveryScope, getScopedCacheStatus } from '@/services/sessionService.js'
import { CLOUD_CONFIG } from '@/utils/cloudConfig.js'

const BATCH_KEY = 'b3-migration'
const MIG_RECOVERY_KEY = 'b3-migration-recovery'
// 内存兜底：按成员追加列表（多次中断各自保留），条目带完整 env/app/member/family scope
const migMemoryRecovery = new Map()
const WHITELIST_KEYS = ['YUNTU_HEALTH_DATA', 'YUNTU_REPORTS_DATA', 'hospital_bag_items']
const BACKUP_PREFIXES = ['MOMCARE_BACKUP_HEALTH_', 'MOMCARE_BACKUP_REPORTS_']

// 真实 SHA-256（纯 JS，小程序/H5/Node 三端一致，NIST 向量核验通过）
const SHA256_K = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
]
// 纯 JS UTF-8 编码（处理 BMP/增补面/孤立代理——微信/H5/Node 三端一致）
function utf8Encode(str) {
  const out = []
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i)
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < str.length) {
      const lo = str.charCodeAt(i + 1)
      if (lo >= 0xDC00 && lo <= 0xDFFF) {
        code = 0x10000 + ((code - 0xD800) << 10) + (lo - 0xDC00)
        i++ // 消耗代理对
      }
    }
    if (code < 0x80) out.push(code)
    else if (code < 0x800) { out.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F)) }
    else if (code < 0x10000) { out.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F)) }
    else { out.push(0xF0 | (code >> 18), 0x80 | ((code >> 12) & 0x3F), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F)) }
  }
  return new Uint8Array(out)
}

function sha256HexSync(input) {
  // 输入为 UTF-8 字节（字符串先编码）
  // 平台无关 UTF-8 编码（不依赖 TextEncoder——微信小程序无此全局）
  const bytes = typeof input === 'string' ? utf8Encode(input) : input
  const len = bytes.length
  const bitLenHi = Math.floor(len / 0x20000000)
  const bitLenLo = (len << 3) >>> 0
  const padded = new Uint8Array(((len + 8) >> 6 << 6) + 64)
  padded.set(bytes)
  padded[len] = 0x80
  const dv = new DataView(padded.buffer)
  dv.setUint32(padded.length - 8, bitLenHi)
  dv.setUint32(padded.length - 4, bitLenLo)
  let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19
  const w = new Uint32Array(64)
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = ((w[i-15]>>>7)|(w[i-15]<<25))^((w[i-15]>>>18)|(w[i-15]<<14))^(w[i-15]>>>3)
      const s1 = ((w[i-2]>>>17)|(w[i-2]<<15))^((w[i-2]>>>19)|(w[i-2]<<13))^(w[i-2]>>>10)
      w[i] = (w[i-16]+s0+w[i-7]+s1)|0
    }
    let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7
    for (let i = 0; i < 64; i++) {
      const S1 = ((e>>>6)|(e<<26))^((e>>>11)|(e<<21))^((e>>>25)|(e<<7))
      const ch = (e&f)^(~e&g)
      const t1 = (h+S1+ch+SHA256_K[i]+w[i])|0
      const S0 = ((a>>>2)|(a<<30))^((a>>>13)|(a<<19))^((a>>>22)|(a<<10))
      const maj = (a&b)^(a&c)^(b&c)
      const t2 = (S0+maj)|0
      h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0
    }
    h0=(h0+a)|0;h1=(h1+b)|0;h2=(h2+c)|0;h3=(h3+d)|0;h4=(h4+e)|0;h5=(h5+f)|0;h6=(h6+g)|0;h7=(h7+h)|0
  }
  const hex = (n) => (n>>>0).toString(16).padStart(8,'0')
  return hex(h0)+hex(h1)+hex(h2)+hex(h3)+hex(h4)+hex(h5)+hex(h6)+hex(h7)
}

function newBatchId() {
  return 'mig_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
}

function isValidCalendarDate(dk) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) return false
  const [y, m, d] = dk.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
}

function sessionReady() {
  const s = getSessionState()
  return s.status === 'confirmed' && s.member && !s.confirming
}

export const useMigrationStore = defineStore('migrationData', () => {
  // 扫描结果：sourceKey → { status: 'ok'|'read-failed'|'parse-failed'|'unknown-schema',
  //   raw?, entities: Entity[], error? }
  const scanResult = ref({})
  const scanning = ref(false)
  // 确认后的持久批次
  const batch = ref(null)
  const executing = ref(false)

  const sessionVersion = subscribeSession()

  function persistBatch(epochAtWrite) {
    if (!sessionReady()) return false
    return setMemberCache(BATCH_KEY, batch.value, epochAtWrite)
  }
  const batchCorrupt = ref(false)
  const batchReadError = ref(false)
  function loadBatch() {
    if (!sessionReady()) return
    batchCorrupt.value = false
    batchReadError.value = false
    const s0 = getSessionState()
    const saved = getMemberCache(BATCH_KEY)
    if (saved && saved.batchId) {
      // 结构校验：entities 必须是数组、memberId/familyId 必须存在
      if (!Array.isArray(saved.entities) || !saved.memberId || !saved.familyId) {
        batchCorrupt.value = true // 结构损坏——不覆写，阻止新确认
        return
      }
      // 家庭切换后旧家庭批次不可见（不显示他家庭内容）
      const curFid = s0.member.familyId
      if (saved.familyId !== curFid) return
      batch.value = saved; return
    }
    const status = getScopedCacheStatus(BATCH_KEY)
    if (status === 'corrupt') batchCorrupt.value = true
    else if (status === 'error') batchReadError.value = true
  }
  // 精确读取当前成员作用域键：返回 'present' | 'absent' | 'corrupt' | 'other-member'
  function readScopedBatch(key) {
    try {
      const info = typeof uni.getStorageInfoSync === 'function' ? uni.getStorageInfoSync() : { keys: [] }
      const keys = info.keys || []
      // 构造当前成员的完整键名（与 sessionService namespaced 一致）
      const s = getSessionState()
      if (!s.member) return 'absent'
      const scopedKey = `mc_cache_${'env-b3a'}_${'wxapp-b3a'}_${s.member.memberId}_b1_${key}`
      // 注：实际 env/app 由 CLOUD_CONFIG 决定——此处通过 getMemberCache 的行为推断
      // getMemberCache 返回 null 时，检查是否有以当前成员 memberId 开头的同后缀键
      const memberPrefix = keys.find(k => k.includes(s.member.memberId) && k.endsWith('_' + key))
      if (!memberPrefix) {
        // 当前成员无此键——检查是否是其他成员的（不读正文）
        const anyMember = keys.find(k => k.endsWith('_' + key))
        return anyMember ? 'other-member' : 'absent'
      }
      // 当前成员有键——尝试读（getMemberCache 已返回 null 说明损坏）
      return 'corrupt'
    } catch (e) { return 'absent' }
  }
  loadBatch()

  let lastMember = null
  let lastFamily = null
  // 存储支撑列表（归档批次/附件恢复）的响应式失效版本：归档/恢复/恢复记录
  // 创建与消费、身份或家庭变化时递增——页面 computed 依赖它才能在存储写后刷新
  const storageListRevision = ref(0)
  watch(sessionVersion, () => {
    const s = getSessionState()
    storageListRevision.value++
    if (s.status !== 'confirmed') {
      scanResult.value = {}
      batch.value = null
      lastMember = null
      lastFamily = null
      return
    }
    const mid = s.member ? s.member.memberId : null
    const fid = s.member ? s.member.familyId : null
    // 成员或家庭任一变化：清当前可见内容（batch 的 familyId 已在 executeBatch 校验）
    if (mid !== lastMember || (lastFamily !== null && fid !== lastFamily)) {
      scanResult.value = {}
      batch.value = null
      loadBatch()
    }
    lastMember = mid
    lastFamily = fid
  })

  // ── 扫描（白名单只读）──
  async function scanSources() {
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session' }
    scanning.value = true
    scanResult.value = {}
    const result = {}
    let allKeys = []
    try {
      const info = typeof uni.getStorageInfoSync === 'function' ? uni.getStorageInfoSync() : { keys: [] }
      allKeys = info.keys || []
    } catch (e) { allKeys = [] }
    const backupKeys = allKeys.filter(k => BACKUP_PREFIXES.some(p => k.startsWith(p)))

    for (const key of WHITELIST_KEYS.concat(backupKeys)) {
      try {
        const raw = uni.getStorageSync(key)
        if (!raw) { result[key] = { status: 'empty' }; continue }
        let parsed
        try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw } catch (pe) {
          // 错误字符串不反射原始内容（可能含 token canary）
          result[key] = { status: 'parse-failed', error: 'JSON 格式损坏（内容未展示）' }
          continue
        }
        // origin/demo 标记
        const isDemo = parsed && (parsed.origin === 'demo' || parsed._demo === true)
        if (isDemo) { result[key] = { status: 'demo', error: '演示数据——不允许当真实数据自动上传' }; continue }
        // schema 识别：根结构 + schemaVersion 检查（version999 等未知版本拒绝）
        const knownKey = key.includes('HEALTH') || key.includes('REPORTS') || key === 'hospital_bag_items' || BACKUP_PREFIXES.some(p => key.startsWith(p))
        if (!knownKey) { result[key] = { status: 'unknown-schema', error: '未知格式（来源类型不可识别）' }; continue }
        // schemaVersion：旧数据无此字段或 1/2（2=旧版含标记）；>2 的新版本结构不可安全解析——拒绝
        if (parsed && parsed.schemaVersion !== undefined && parsed.schemaVersion !== null && parsed.schemaVersion > 2) {
          result[key] = { status: 'unknown-schema', error: '未知 schemaVersion=' + parsed.schemaVersion }; continue
        }
        // 根结构校验：HEALTH 须有 records 对象；REPORTS 须有数组；bag 须有数组
        if (key.includes('HEALTH') && !key.startsWith('MOMCARE_BACKUP_')) {
          if (!parsed.records || typeof parsed.records !== 'object' || Array.isArray(parsed.records)) {
            if (parsed.records !== undefined) { result[key] = { status: 'unknown-schema', error: '健康记录根结构异常（records 非对象）' }; continue }
          }
        }
        if (key.includes('REPORTS') && !key.startsWith('MOMCARE_BACKUP_')) {
          if (!Array.isArray(parsed) && !Array.isArray(parsed.reports) && parsed.reports !== undefined) {
            result[key] = { status: 'unknown-schema', error: '报告根结构异常（非数组）' }; continue
          }
        }
        // 补写原始备份：已有备份不覆盖（保留最早原始副本）；当前源与已有备份不同时
        // 以独立新键保存当前内容；任一写失败阻止迁移（不吞掉）
        if (!key.startsWith('MOMCARE_BACKUP_')) {
          const backupKey = 'MOMCARE_BACKUP_' + key.replace(/^(YUNTU_|hospital_)/, '').toUpperCase() + '_RAW'
          const curRaw = typeof raw === 'string' ? raw : JSON.stringify(raw)
          let backupOk = false
          if (storageHasKey(backupKey)) {
            try {
              const existing = uni.getStorageSync(backupKey)
              if (existing === curRaw) {
                backupOk = true // 已有备份与当前一致——有效
              } else {
                // 已有备份正文不同（更早副本）——不覆盖；独立新键保存当前
                const seqKey = backupKey + '_' + Date.now().toString(36)
                try { uni.setStorageSync(seqKey, curRaw); backupOk = true } catch (be2) { backupOk = false }
              }
            } catch (e) { backupOk = false }
          } else {
            try { uni.setStorageSync(backupKey, curRaw); backupOk = true } catch (be) { backupOk = false }
          }
          if (!backupOk) {
            result[key] = { status: 'backup-failed', error: '原始备份写入失败——为保护数据不迁移，请清理空间后重试' }
            continue
          }
        }
        const entities = extractEntities(key, parsed)
        // raw 不暴露到响应式对象——仅存摘要
        result[key] = { status: 'ok', rawDigest: sha256HexSync(typeof raw === 'string' ? raw : JSON.stringify(raw)), entities, isBackup: key.startsWith('MOMCARE_BACKUP_') }
      } catch (e) {
        result[key] = { status: 'read-failed', error: '读取失败（内容未展示）' }
      }
    }
    scanResult.value = result
    scanning.value = false
    return result
  }

  function storageHasKey(key) {
    try { return Boolean(uni.getStorageSync(key)) } catch (e) { return false }
  }

    // 从旧结构提取实体预览（严格白名单；daily/mood 分开实体）
  function extractEntities(sourceKey, parsed) {
    const entities = []
    if (sourceKey.includes('HEALTH')) {
      const records = parsed && parsed.records ? parsed.records : {}
      for (const [dateKey, rec] of Object.entries(records)) {
        if (!rec || typeof rec !== 'object') continue
        const dtOk = isValidCalendarDate(dateKey)
        // daily 实体（共享数字字段）
        const dailyFields = {}
        const warnings = []
        if (rec.weight !== undefined && rec.weight !== null) {
          const w = Number(rec.weight)
          if (Number.isFinite(w) && w >= 0) dailyFields.weightKg = w
          else warnings.push('weight 非数值')
        }
        if (rec.bp !== undefined && rec.bp !== null) {
          const bp = String(rec.bp)
          const m = bp.match(/^(\d+)\s*\/\s*(\d+)$/)
          if (m) {
            const sys = Number(m[1]), dia = Number(m[2])
            if (sys >= 60 && sys <= 260 && dia >= 30 && dia <= 260) { dailyFields.systolic = sys; dailyFields.diastolic = dia }
            else warnings.push('bp 超出合法范围')
          } else warnings.push('bp 格式不明（不可猜测转换）')
        }
        if (rec.fetal !== undefined && rec.fetal !== null) {
          // 布尔/空串不能 Number 转为伪造计数
          if (typeof rec.fetal === 'number' && Number.isFinite(rec.fetal) && rec.fetal >= 0) dailyFields.fetalCount = rec.fetal
          else if (typeof rec.fetal === 'string' && rec.fetal !== '' && Number.isFinite(Number(rec.fetal)) && Number(rec.fetal) >= 0) dailyFields.fetalCount = Number(rec.fetal)
          else warnings.push('fetal 非数值（类型：' + typeof rec.fetal + '）')
        }
        if (!dtOk) warnings.push('日期格式异常：' + dateKey)
        if (Object.keys(dailyFields).length > 0) {
          entities.push({ sourceId: `${sourceKey}:daily:${dateKey}`, domain: 'daily', entityKey: dateKey, dateKey: dtOk ? dateKey : '', fields: dailyFields, warnings, isPrivate: false })
        }
        // mood 实体（私人字段——独立实体/独立确认/独立提交）
        const privateFields = {}
        if (rec.mood) privateFields.mood = String(rec.mood)
        if (rec.symptoms !== undefined && rec.symptoms !== null) {
          if (Array.isArray(rec.symptoms)) {
            privateFields.symptoms = rec.symptoms.filter(s => typeof s === 'string' && s.length > 0 && s.length <= 100)
          }
          // 非数组 symptoms 不转 String（会导致私人日记保存失败）——跳过
        }
        if (rec.note) privateFields.note = String(rec.note) // 不映射 sharedNote
        if (Array.isArray(rec.plans)) {
          // plans 仅白名单 text/done；done 严格布尔（'false' 字符串不变 true）
          privateFields.plans = rec.plans
            .filter(p => p && typeof p === 'object' && typeof p.text === 'string' && p.text.length > 0)
            .map(p => ({ text: p.text.slice(0, 200), done: p.done === true || p.done === 1 }))
        }
        if (Object.keys(privateFields).length > 0) {
          entities.push({ sourceId: `${sourceKey}:mood:${dateKey}`, domain: 'mood', entityKey: dateKey, dateKey, fields: {}, privateFields, warnings: [], isPrivate: true })
        }
      }
      // 孕期资料映射
      // 孕期资料：旧数据可能在根级或 pregnancy/userInfo 子对象
      const rootLmp = parsed.lmpDate || parsed.dueDate
      if (parsed.pregnancy || parsed.userInfo || rootLmp) {
        const preg = parsed.pregnancy || {}
        const ui = parsed.userInfo || {}
        const pregFields = {}
        if (preg.lmpDate || ui.lmpDate || parsed.lmpDate) {
          const lmpRaw = preg.lmpDate || parsed.lmpDate || ui.lmpDate
          // Date.toISOString() 是 UTC——须转上海日号（非直接取前 10 位）
          if (isValidCalendarDate(lmpRaw)) pregFields.lmpDate = lmpRaw
          else if (typeof lmpRaw === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(lmpRaw)) {
            const d = new Date(lmpRaw)
            const sh = new Date(d.getTime() + (8 * 60 + d.getTimezoneOffset()) * 60000)
            pregFields.lmpDate = `${sh.getFullYear()}-${String(sh.getMonth() + 1).padStart(2, '0')}-${String(sh.getDate()).padStart(2, '0')}`
          }
        }
        if (ui.hospital) pregFields.hospital = String(ui.hospital).slice(0, 100)
        // mc-health 孕期字段：nickname + babyNickname 各自独立映射
        if (ui.nickname) pregFields.nickname = String(ui.nickname).slice(0, 50)
        if (ui.babyNickname) pregFields.babyNickname = String(ui.babyNickname).slice(0, 50)
        if (ui.doctor) pregFields.doctor = String(ui.doctor).slice(0, 50)
        if (ui.hospitalPhone) pregFields.hospitalPhone = String(ui.hospitalPhone).slice(0, 30)
        // preWeight → preWeightKg、height → heightCm（严格数字解析，不改布尔/空串）
        if (ui.preWeight !== undefined && ui.preWeight !== null && ui.preWeight !== '') {
          const pw = Number(ui.preWeight)
          if (Number.isFinite(pw) && pw >= 0 && pw <= 500) pregFields.preWeightKg = pw
        }
        if (ui.height !== undefined && ui.height !== null && ui.height !== '') {
          const h = Number(ui.height)
          if (Number.isFinite(h) && h >= 0 && h <= 300) pregFields.heightCm = h
        }
        if (parsed.dueDate) {
          const dd = parsed.dueDate
          if (isValidCalendarDate(dd)) pregFields.dueDate = dd
          else if (typeof dd === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(dd)) {
            const d2 = new Date(dd)
            const sh2 = new Date(d2.getTime() + (8 * 60 + d2.getTimezoneOffset()) * 60000)
            pregFields.dueDate = `${sh2.getFullYear()}-${String(sh2.getMonth() + 1).padStart(2, '0')}-${String(sh2.getDate()).padStart(2, '0')}`
          }
        }
        if (Object.keys(pregFields).length > 0) {
          entities.push({ sourceId: `${sourceKey}:pregnancy`, domain: 'pregnancy', entityKey: 'pregnancy', dateKey: '', fields: pregFields, warnings: [], isPrivate: false })
        }
      }
      // 旧产检安排（真实存储在 HEALTH 根的 checkupSchedules）
      if (parsed.checkupSchedules && Array.isArray(parsed.checkupSchedules)) {
        parsed.checkupSchedules.forEach((cs, idx) => {
          if (!cs || typeof cs !== 'object') return
          const fields = {}
          const warnings = []
          if (cs.checkup_date && isValidCalendarDate(cs.checkup_date)) fields.dateKey = cs.checkup_date
          else if (cs.checkup_date) warnings.push('产检日期异常：' + cs.checkup_date)
          if (cs.hospital) fields.hospital = String(cs.hospital).slice(0, 100)
          if (cs.status === 'completed' || cs.status === 'skipped' || cs.status === 'upcoming') {
            fields.status = cs.status === 'upcoming' ? 'pending' : cs.status
          }
          if (Array.isArray(cs.exam_items)) {
            fields.examItems = cs.exam_items
              .filter(it => it && typeof it === 'object' && it.text)
              .map((it, i) => ({ itemId: it.itemId || 'mig_i' + i, text: String(it.text).slice(0, 50), required: Boolean(it.required), done: Boolean(it.done) }))
          }
          if (cs.notes) fields.note = String(cs.notes).slice(0, 500)
          if (Object.keys(fields).length > 0) {
            entities.push({ sourceId: `${sourceKey}:checkup:${cs._id || idx}`, domain: 'checkup', entityKey: String(cs._id || idx), dateKey: fields.dateKey || '', fields, warnings, isPrivate: false })
          }
        })
      }
    } else if (sourceKey.includes('REPORTS')) {
      const reports = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.reports) ? parsed.reports : [])
      const unarchived = parsed && Array.isArray(parsed.unarchivedReports) ? parsed.unarchivedReports : []
      const allReports = [...reports, ...unarchived]
      allReports.forEach((rep, idx) => {
        if (!rep || typeof rep !== 'object') return
        const id = rep._id || rep.id || String(idx)
        const typeMap = { '血常规': 'blood_routine', 'B超': 'ultrasound', 'B 超': 'ultrasound',
          '唐氏筛查': 'down_screening', '糖耐': 'ogtt', '尿常规': 'urine',
          '无创DNA': 'nipt', '无创 DNA': 'nipt', '产科记录': 'obstetric',
          '生化全套': 'biochemical', 'bloodroutine': 'blood_routine' }
        const fields = { attachments: [] }
        const warnings = []
        if (rep.report_type) {
          fields.reportType = typeMap[rep.report_type] || (Object.values(typeMap).includes(rep.report_type) ? rep.report_type : 'other')
          if (fields.reportType === 'other' && rep.report_type !== '其他') warnings.push('未知类型：' + rep.report_type + ' → other')
        }
        if (rep.report_date) {
          if (isValidCalendarDate(rep.report_date)) fields.dateKey = rep.report_date
          else warnings.push('日期格式异常：' + rep.report_date)
        }
        if (rep.notes) fields.note = String(rep.notes) // 共享——预览明确
        fields.archiveStatus = rep.archive_status === 'unarchived' ? 'unarchived' : 'archived'
        // 附件：file_urls + localPaths 按索引配对（同页本机原件优先，不拼成双倍）
        const furls = Array.isArray(rep.file_urls) ? rep.file_urls : []
        const lpaths = Array.isArray(rep.localPaths) ? rep.localPaths : []
        const pageCount = Math.max(furls.length, lpaths.length)
        for (let pi = 0; pi < pageCount; pi++) {
          const local = lpaths[pi] ? String(lpaths[pi]) : ''
          const remote = furls[pi] ? String(furls[pi]) : ''
          const isLocal = local && (local.startsWith('store://') || local.startsWith('tmp://') || local.startsWith('wxfile://'))
          if (isLocal) {
            fields.attachments.push({ localPath: local, order: pi })
          } else if (remote && (remote.startsWith('store://') || remote.startsWith('tmp://') || remote.startsWith('wxfile://'))) {
            fields.attachments.push({ localPath: remote, order: pi })
          } else if (remote) {
            warnings.push(`附件${pi}: 非本机实体（${remote.slice(0, 30)}…）——不自动下载`)
            fields.attachments.push({ localPath: '', remoteUrl: remote, order: pi, missing: true })
          } else if (local) {
            warnings.push(`附件${pi}: 路径格式不明（${local.slice(0, 30)}）`)
            fields.attachments.push({ localPath: '', remoteUrl: '', order: pi, missing: true })
          }
        }
        entities.push({ sourceId: `${sourceKey}:report:${id}`, domain: 'report', entityKey: id, dateKey: fields.dateKey || '', fields, warnings, isPrivate: false })
      })
    } else if (sourceKey === 'hospital_bag_items') {
      const items = Array.isArray(parsed) ? parsed : []
      items.forEach((item, idx) => {
        if (!item || typeof item !== 'object') return
        const fields = {}
        const warnings = []
        if (item.text || item.name) fields.name = String(item.text || item.name).slice(0, 50)
        const catMap = { mom: 'mom', baby: 'baby', doc: 'documents', documents: 'documents', going: 'going', other: 'other' }
        if (item.category) {
          fields.category = catMap[item.category] || 'other'
          if (fields.category === 'other' && item.category !== 'other') warnings.push('未知分类：' + item.category)
        }
        if (item.quantity !== undefined && item.quantity !== null) {
          const q = Number(item.quantity)
          if (Number.isInteger(q) && q >= 1 && q <= 99) fields.quantity = q
          else warnings.push('quantity 非法（须 1-99 正整数）')
        }
        if (item.done !== undefined) fields.prepared = Boolean(item.done)
        if (fields.name) entities.push({ sourceId: `${sourceKey}:item:${idx}`, domain: 'bag', entityKey: String(idx), dateKey: '', fields, warnings, isPrivate: false })
      })
    }
    return entities
  }

    // ── 去重预览（同源同实体只一次）──
  const previewEntities = computed(() => {
    const all = []
    const seen = new Map()
    for (const [sourceKey, src] of Object.entries(scanResult.value)) {
      if (!src.entities) continue
      for (const raw of src.entities) {
        const e = { ...raw, warnings: [...raw.warnings], sourceKeys: [sourceKey] } // 不修改原对象
        const identity = `${e.domain}:${e.entityKey}`
        const contentDigest = sha256HexSync(JSON.stringify(e.fields) + (e.privateFields ? JSON.stringify(e.privateFields) : ''))
        e.contentDigest = contentDigest // 每个候选都有 digest（含不同正文候选）
        if (seen.has(identity)) {
          const prev = seen.get(identity)
          if (prev.contentDigest === contentDigest) {
            if (!prev.sourceKeys.includes(sourceKey)) prev.sourceKeys.push(sourceKey)
            continue
          }
          e.sourceId = e.sourceId + '@' + contentDigest.slice(0, 12)
          e.warnings.push('同源不同正文——需明确选取')
        } else {
          seen.set(identity, e)
        }
        all.push(e)
      }
    }
    return all
  })

    // ── 确认（生成持久批次）──
  // 旧未完成批次归档（成员作用域历史）：源变化后旧批次已不可执行
  // （executeBatch 的 source-changed 门会持续拒绝），重新确认时不得静默丢弃——
  // 归档后用户可查看并恢复（restoreArchivedBatch）；写入失败则拒绝新确认（防丢）。
  // 归档键已有不可解析字节（corrupt）或读异常时【拒绝归档】——原字节保留不覆写；
  // 可解析但非列表结构的遗留值作为首元素保留（读取侧按结构过滤）。
  // 历史条目【不设上限截断】：任何条目（含第 21 条）都不允许被静默丢弃——
  // 条目为用户操作产生、体积小；如需清理必须显式操作，不做隐式淘汰。
  const MIG_ARCHIVE_KEY = 'b3-migration-archive'
  function archiveBatch(old) {
    try {
      const status = getScopedCacheStatus(MIG_ARCHIVE_KEY)
      if (status === 'corrupt' || status === 'error') return false
      const raw = getMemberCache(MIG_ARCHIVE_KEY)
      const list = Array.isArray(raw) ? raw : (raw ? [raw] : [])
      const filtered = list.filter(b => b && b.batchId !== old.batchId)
      filtered.push(JSON.parse(JSON.stringify(old)))
      const ok = setMemberCache(MIG_ARCHIVE_KEY, filtered)
      if (ok) storageListRevision.value++
      return ok
    } catch (e) {
      return false
    }
  }

  // 归档批次列表（用户可达，非只写）：仅结构有效条目，倒序（最新在前）。
  // 家庭过滤：同成员换家庭后旧家庭归档元数据不可见（与活动批次可见性同规则）
  function getArchivedBatches() {
    const s = getSessionState()
    if (!s.member) return []
    try {
      const raw = getMemberCache(MIG_ARCHIVE_KEY)
      const list = Array.isArray(raw) ? raw : (raw ? [raw] : [])
      const valid = list.filter(b => b && typeof b === 'object' && b.batchId &&
        Array.isArray(b.entities) && b.memberId === s.member.memberId && b.familyId === s.member.familyId)
      return valid.map(b => ({
        batchId: b.batchId, status: b.status, confirmedAt: b.confirmedAt,
        memberId: b.memberId, familyId: b.familyId,
        entities: b.entities.map(e => ({ targetDomain: e.targetDomain, entityKey: e.entityKey, status: e.status }))
      })).reverse()
    } catch (e) {
      return []
    }
  }

  // 从归档移除一个条目（仅当归档可读且结构有效）；损坏原字节不动
  function removeArchivedEntry(batchId) {
    try {
      const status = getScopedCacheStatus(MIG_ARCHIVE_KEY)
      if (status === 'corrupt' || status === 'error') return false
      const raw = getMemberCache(MIG_ARCHIVE_KEY)
      const list = Array.isArray(raw) ? raw : (raw ? [raw] : [])
      const rest = list.filter(b => !(b && b.batchId === batchId && Array.isArray(b.entities)))
      const ok = setMemberCache(MIG_ARCHIVE_KEY, rest)
      if (ok) storageListRevision.value++
      return ok
    } catch (e) {
      return false
    }
  }

  // 恢复归档批次为当前批次（用户显式操作）。无损写序：
  // ① 当前活动批次先 durable 归档（失败则中止——旧活动必须先在归档里）
  // ② 恢复条目先 persistBatch 为活动批次——此时归档副本仍在（双写窗口允许重复）
  // ③ 活动批次 durable 之后才从归档移除条目；移除失败保留重复（更安全，可对账）
  // 归档原字节损坏 → 拒绝（保护内容）；恢复后仍受 source-changed/所有权门约束。
  function restoreArchivedBatch(batchId) {
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session' }
    if (batchCorrupt.value) return { ok: false, code: 'batch-corrupt', message: '存在不可读的迁移批次残留，为保护数据不允许恢复' }
    const status = getScopedCacheStatus(MIG_ARCHIVE_KEY)
    if (status === 'corrupt' || status === 'error') {
      return { ok: false, code: 'archive-corrupt', message: '归档数据损坏，为保护内容不允许恢复——请手动检查存储' }
    }
    const raw = getMemberCache(MIG_ARCHIVE_KEY)
    const list = Array.isArray(raw) ? raw : (raw ? [raw] : [])
    const idx = list.findIndex(b => b && b.batchId === batchId && Array.isArray(b.entities))
    if (idx < 0) return { ok: false, code: 'no-batch', message: '归档批次不存在或结构无效' }
    const entry = list[idx]
    const s = getSessionState()
    if (entry.memberId !== s.member.memberId || entry.familyId !== s.member.familyId) {
      return { ok: false, code: 'owner-mismatch', message: '归档批次属于其他成员或家庭' }
    }
    const prevActive = batch.value ? JSON.parse(JSON.stringify(batch.value)) : null
    // ① 当前批次（含 done 终态）先无损归档——后续任何失败都不丢它
    if (prevActive && !archiveBatch(prevActive)) {
      return { ok: false, code: 'archive-failed', message: '当前批次归档写入失败，为防丢失恢复已取消——请重试' }
    }
    // 归档列表已更新（含刚归档的当前批次）——重新读取恢复条目
    const raw2 = getMemberCache(MIG_ARCHIVE_KEY)
    const list2 = Array.isArray(raw2) ? raw2 : (raw2 ? [raw2] : [])
    const idx2 = list2.findIndex(b => b && b.batchId === batchId && Array.isArray(b.entities))
    if (idx2 < 0) {
      return { ok: false, code: 'archive-failed', message: '归档读取失败，恢复已取消——请重试' }
    }
    // ② 先持久化活动批次（归档副本仍在——此步失败零损失，活动/归档都未变动）
    const prevBatchValue = batch.value ? JSON.parse(JSON.stringify(batch.value)) : null
    batch.value = JSON.parse(JSON.stringify(list2[idx2]))
    if (!persistBatch()) {
      batch.value = prevBatchValue
      return { ok: false, code: 'persist-failed', message: '批次写回失败，恢复已回退（归档未动）——请重试' }
    }
    // ③ 活动 durable 后才移除归档条目；失败保留重复副本（可对账，不丢数据）
    const removed = removeArchivedEntry(batchId)
    storageListRevision.value++
    return { ok: true, batch: batch.value, duplicate: !removed }
  }

  async function confirmEntities(selections) {
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session' }
    // 已存在未完成批次不得被新确认覆写丢失——但源已变化时旧批次永远无法执行
    // （source-changed 门），不能永久堵死重新确认入口：先归档旧批次再允许新确认
    if (batch.value && batch.value.status !== 'done') {
      if (verifySourceDigests()) {
        return { ok: false, code: 'batch-in-progress', message: '存在未完成迁移批次，请先处理或等待完成' }
      }
      if (!archiveBatch(batch.value)) {
        return { ok: false, code: 'archive-failed', message: '旧批次归档失败（存储满或归档数据损坏），为防丢失不允许新确认——请重试或检查归档' }
      }
    }
    // 损坏的持久批次不得被覆写——要求用户先处理（显示原字节供人工恢复）
    if (batchCorrupt.value) {
      return { ok: false, code: 'batch-corrupt', message: '检测到不可读的迁移批次残留，为保护数据不允许覆写——请联系支持或手动清理存储' }
    }
    // 私人域实体必须显式确认作者（includePrivate）——服务层拒绝未确认的私人迁移
    for (const sel of selections) {
      if (sel.domain === 'mood' && !sel.includePrivate) {
        return { ok: false, code: 'private-authorship-required', message: '私人内容须本人显式确认作者后才能迁移' }
      }
    }
    // 同源不同正文（同 domain+entityKey）一次只能确认一个——互斥选择
    const seenIdentities = new Map()
    for (const sel of selections) {
      const identity = `${sel.domain}:${sel.entityKey || sel.sourceId.split(':').pop()}`
      if (seenIdentities.has(identity)) {
        return { ok: false, code: 'conflicting-selection', message: `「${identity}」存在多个正文版本，只能选择其中一个` }
      }
      seenIdentities.set(identity, true)
    }
    // confirmEntities 必须对应当前扫描规范化记录——不接受任意伪造 fields
    const validPreview = previewEntities.value
    const selMatch = validPreview.find(e => e.sourceId === selections[0].sourceId)
    for (const sel of selections) {
      const match = validPreview.find(e => e.sourceId === sel.sourceId)
      if (!match) {
        return { ok: false, code: 'invalid-selection', message: `条目 ${sel.sourceId} 不在当前扫描预览中——请重新扫描` }
      }
      // 验证 fields 来源（同一 contentDigest 或兼容）
      const selDigest = sha256HexSync(JSON.stringify(sel.fields) + (sel.privateFields ? JSON.stringify(sel.privateFields) : ''))
      if (selDigest !== match.contentDigest) {
        return { ok: false, code: 'field-mismatch', message: `条目 ${sel.sourceId} 内容与扫描预览不一致——请重新选择` }
      }
    }
    const epochAtStart = currentEpoch()
    const s = getSessionState()
    const batchId = newBatchId()
    const entities = selections.map((sel, seq) => {
      const sourceId = sel.sourceId
      // 目标 ID 用 canonical identity（domain:entityKey，不含 sourceKey 前缀/正文后缀）
      // —— 同源主键与备份中同实体→同 targetId（不产生副本）
      const canonicalIdentity = `${sel.domain}:${sel.entityKey || sel.sourceId.split(':').pop()}`
      const targetId = 'mig_' + sel.domain + '_' + sha256HexSync(canonicalIdentity).slice(0, 16)
      return {
        sourceId, targetDomain: sel.domain, targetId,
        entityKey: sel.entityKey || sel.sourceId.split(':').pop(),
        operationId: `b3a_${batchId}_${seq}`,
        payload: sel.domain === 'mood'
          ? { private: sel.privateFields || {} }
          : { ...sel.fields },
        expectedRevision: 0,
        status: 'pending',
        attachments: (sel.fields.attachments || []).map(a => ({
          localPath: a.localPath || '', remoteUrl: a.remoteUrl || '', missing: Boolean(a.missing),
          order: a.order,
          // uploadId 在确认时分配（随批次持久化）——上传前已在磁盘
          uploadId: a.localPath ? 'migup_' + sha256HexSync(sourceId + ':' + a.order).slice(0, 12) : '',
          fileId: ''
        }))
      }
    })
    const newBatch = {
      batchId,
      memberId: s.member.memberId,
      familyId: s.member.familyId,
      confirmedAt: Date.now(),
      sourceDigests: Object.fromEntries(
        Object.entries(scanResult.value)
          .filter(([, v]) => v.rawDigest)
          .map(([k, v]) => [k, v.rawDigest])
      ),
      entities,
      status: 'confirmed'
    }
    batch.value = newBatch
    if (!persistBatch(epochAtStart)) {
      batch.value = null
      return { ok: false, code: 'batch-persist-failed', message: '迁移批次写入失败，未执行任何操作，请重试' }
    }
    return { ok: true, batchId }
  }

    // ── 源摘要校验（内容变化须重新预览）──
  function verifySourceDigests() {
    if (!batch.value) return false
    for (const [key, digest] of Object.entries(batch.value.sourceDigests || {})) {
      try {
        const raw = uni.getStorageSync(key)
        if (!raw) return false
        const current = sha256HexSync(typeof raw === 'string' ? raw : JSON.stringify(raw))
        if (current !== digest) return false
      } catch (e) { return false }
    }
    return true
  }

  // ── 重启恢复 ──
  function resumeBatch() {
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session' }
    loadBatch()
    if (!batch.value) return { ok: false, code: 'no-batch' }
    // 另一成员不可执行旧成员批次
    const s = getSessionState()
    if (batch.value.memberId !== s.member.memberId) {
      return { ok: false, code: 'owner-mismatch', message: '迁移批次属于其他成员' }
    }
    if (!verifySourceDigests()) {
      return { ok: false, code: 'source-changed', message: '源数据已变化，请重新预览确认' }
    }
    return { ok: true, batch: batch.value }
  }

  // ── 执行（逐实体，outbox 幂等）──
  // executor: async (entity) => {ok, code, message}——由页面注入真实 familyStore 调用
  // 迁移回执：绑定 scope(canonical source)+contentDigest+targetId+opId（非仅 targetId）
  // 内容变化/目标被删→receipt 不匹配→真冲突，不吞掉
  const MIGRATION_RECEIPTS_KEY = 'b3-migration-receipts'
  function recordMigrationDone(entity) {
    try {
      const receipts = getMemberCache(MIGRATION_RECEIPTS_KEY) || {}
      const identity = `${entity.targetDomain}:${entity.entityKey}`
      receipts[identity] = {
        targetId: entity.targetId,
        contentDigest: sha256HexSync(JSON.stringify(entity.payload)),
        operationId: entity.operationId,
        cloudRevision: entity.cloudRevision || 1, // 云端当时版本
        at: Date.now()
      }
      setMemberCache(MIGRATION_RECEIPTS_KEY, receipts)
    } catch (e) { /* 尽力 */ }
  }
  function isPriorMigrationTarget(entity) {
    if (entity.status === 'done' || entity.status === 'done-unpersisted') return true
    try {
      const receipts = getMemberCache(MIGRATION_RECEIPTS_KEY) || {}
      const identity = `${entity.targetDomain}:${entity.entityKey}`
      const receipt = receipts[identity]
      if (!receipt) return false
      // 回执须匹配 canonical source + content digest——内容变化→不匹配→真冲突
      const curDigest = sha256HexSync(JSON.stringify(entity.payload))
      return receipt.targetId === entity.targetId && receipt.contentDigest === curDigest
    } catch (e) { return false }
  }

  async function executeBatch(executor) {
    if (!batch.value) return { ok: false, code: 'no-batch' }
    if (executing.value) return { ok: false, code: 'busy' }
    // 执行前核验：身份/所有权/源摘要
    if (!sessionReady()) return { ok: false, code: 'unauthenticated-session' }
    const s = getSessionState()
    if (batch.value.memberId !== s.member.memberId) return { ok: false, code: 'owner-mismatch', message: '批次属于其他成员' }
    if (batch.value.familyId !== s.member.familyId) return { ok: false, code: 'family-mismatch', message: '批次属于其他家庭（身份已切换）' }
    if (!verifySourceDigests()) return { ok: false, code: 'source-changed', message: '源数据已变化，请重新预览确认' }
    executing.value = true
    const epochAtStart = currentEpoch()
    try {
      batch.value.status = 'executing'
      if (!persistBatch(epochAtStart)) {
        batch.value.status = 'confirmed'
        return { ok: false, code: 'persist-failed', message: '执行状态写入失败，请重试' }
      }
      for (const entity of batch.value.entities) {
        if (currentEpoch() !== epochAtStart) {
          return { ok: false, code: 'stale-session', message: '会话已切换，批次保留可续传' }
        }
        if (entity.status === 'done') continue // 幂等：已完成跳过
        // done-unpersisted：上次云端成功但本机标记落盘失败——重试时 executor
        // 会得到 revision-conflict（expectedRevision=0 vs 已存在），须通过 outbox
        // 幂等（同 operationId 重放）或对账确认为 done，而非新 opId 假冲突
        const r = await executor(entity)
        if (currentEpoch() !== epochAtStart) {
          return { ok: false, code: 'stale-session', message: '会话已切换，批次保留可续传' }
        }
        if (r.ok) { entity.status = 'done'; recordMigrationDone(entity) }
        else if (r.code === 'revision-conflict') {
          // 对账确认 done（不误标冲突）——须同时满足：
          // ① 回执匹配（同 canonical source + contentDigest）
          // ② 云端记录未删除（r.currentRecord?.deleted ≠ true）
          // 已删除目标即使回执匹配也是真冲突（不能复活已删记录）
          const cloudDeleted = r.currentRecord && r.currentRecord.deleted
          // 云端版本已超过回执记录的版本（他端后来更新过）→ 真冲突，不回执对账
          const receipts = (() => { try { return getMemberCache(MIGRATION_RECEIPTS_KEY) || {} } catch (e) { return {} } })()
          const rcpt = receipts[`${entity.targetDomain}:${entity.entityKey}`]
          const cloudAdvanced = rcpt && r.currentRecord && r.currentRecord.revision > (rcpt.cloudRevision || 1)
          if (!cloudDeleted && !cloudAdvanced && (entity.status === 'done-unpersisted' || isPriorMigrationTarget(entity))) {
            entity.status = 'done'
            recordMigrationDone(entity)
          } else {
            entity.status = 'conflict'
          }
        }
        else if (r.code === 'replayed') entity.status = 'done'
        else entity.status = 'failed'
        entity.error = r.ok ? '' : (r.message || r.code)
        if (!persistBatch(epochAtStart)) {
          // 执行结果落盘失败：保留可恢复状态（不丢弃原始输入）
          entity.status = entity.status === 'done' ? 'done-unpersisted' : entity.status
          return { ok: false, code: 'persist-failed', message: '执行结果写入失败；已保存的进度保留在内存，请重试' }
        }
      }
      const stats = {
        done: batch.value.entities.filter(e => e.status === 'done' || e.status === 'done-unpersisted').length,
        conflict: batch.value.entities.filter(e => e.status === 'conflict').length,
        failed: batch.value.entities.filter(e => e.status === 'failed').length,
        pending: batch.value.entities.filter(e => e.status === 'pending').length
      }
      // conflict/failed/pending 均不能视为完成——只有全部 done 才 done
      batch.value.status = (stats.failed + stats.pending + stats.conflict) === 0 ? 'done' : 'partial'
      if (!persistBatch(epochAtStart)) return { ok: false, code: 'persist-failed', stats }
      return { ok: stats.failed + stats.pending === 0, stats }
    } finally {
      executing.value = false
    }
  }

    // ── 附件真实恢复管线（B3a ATTACHMENTS spec）──

  // 恢复记录按原成员作用域【追加】：同 batchId+entityOpId+order 只留最新，
  // 不同槽位各自保留——顺序多次中断后每个已保存原件都可找回（不被后写覆盖）。
  // 追加须读原作用域键（切换后 getMemberCache 读的是新成员）。
  // 已有字节不可解析（corrupt）时【不覆写】——与损坏清单同原则，原字节保留。
  function appendRecoveryRecord(scope, entry) {
    if (!scope) return false
    try {
      const st = scope.readStatus()
      if (st.status === 'corrupt' || st.status === 'error') return false
      const list = st.status === 'ok' ? (Array.isArray(st.value) ? st.value : [st.value]) : []
      const dk = e => `${e.batchId}|${e.entityOpId}|${e.order}`
      const filtered = list.filter(e => dk(e) !== dk(entry))
      filtered.push(entry)
      return scope.write(filtered)
    } catch (e) {
      return false
    }
  }

  // 记录一条附件恢复信息：先尝试原成员作用域持久追加（完整 env/app/member/family
  // scope 写进记录本身）；持久失败（磁盘满/字节损坏不可追加）→同进程内存兜底列表，
  // 如实标记 persisted:false 并附"重启丢失"警示——原件不因记录写失败而变孤儿。
  // executor 与 reselect 共用。
  function recordAttachmentRecovery(scope, entry) {
    const sc = scope ? scope.scope : null
    const full = sc ? {
      ...entry,
      envId: sc.envId, appId: sc.appId, memberId: sc.memberId, familyId: sc.familyId
    } : { ...entry }
    const durable = appendRecoveryRecord(scope, full)
    if (!durable && sc) {
      // 与持久追加同语义：同 batchId+entityOpId+order 只留最新——
      // 同槽位多次中断后恢复必须命中最后一次选择的原件
      const dk = e => `${e.batchId}|${e.entityOpId}|${e.order}`
      const list = (migMemoryRecovery.get(sc.memberId) || []).filter(e => dk(e) !== dk(full))
      list.push({
        ...full,
        message: `${full.message}（内存暂存，重启后可能丢失）`,
        persisted: false
      })
      migMemoryRecovery.set(sc.memberId, list)
    }
    storageListRevision.value++
    return durable
  }

  // 当前完整作用域（env/app/member/family 全匹配）内可用的恢复记录：
  // 持久列表 + 内存列表按追加顺序合并（内存条目在持久条目之后=更新）；
  // 缺任一 scope 字段或目标字段（batchId/entityOpId/order）的记录不可用作
  // 恢复源——不猜、不放宽。返回 { list, newest }：
  //   list   = 逐目标（batchId|entityOpId|order）去重后的待恢复槽位（每目标取最新）
  //   newest = 全局最新一条（恢复卡片默认展示）
  function recoveryRecordsInScope() {
    const s = getSessionState()
    if (!s.member) return { list: [], newest: null }
    const inScope = r => r && r.envId === CLOUD_CONFIG.envId && r.appId === CLOUD_CONFIG.appId &&
      r.memberId === s.member.memberId && r.familyId && r.familyId === s.member.familyId &&
      r.batchId !== undefined && r.entityOpId !== undefined && r.order !== undefined
    const out = []
    try {
      const persisted = getMemberCache(MIG_RECOVERY_KEY)
      // 兼容旧单对象格式与追加列表格式；追加序=时间序
      const recs = Array.isArray(persisted) ? persisted : (persisted ? [persisted] : [])
      for (const r of recs) if (inScope(r)) out.push({ ...r, persisted: true })
    } catch (e) { /* */ }
    for (const r of (migMemoryRecovery.get(s.member.memberId) || [])) {
      if (inScope(r)) out.push({ ...r, persisted: false })
    }
    if (out.length === 0) return { list: [], newest: null }
    // 逐目标取最新（合并序在后=更新：内存条目覆盖同目标持久旧条目）——
    // 恢复必须命中最后一次选择的原件，而不是最早的
    const dk = r => `${r.batchId}|${r.entityOpId}|${r.order}`
    const byTarget = new Map()
    for (const r of out) byTarget.set(dk(r), r)
    return { list: [...byTarget.values()], newest: out[out.length - 1] }
  }

  // 重选某一页原件：chooseImage → 持久副本 → 更新槽位 → 持久化清单 → 需再次确认映射
  // 取消保留原状态；新副本写入后清单失败仍可恢复（不丢原件）
  async function reselectAttachment(batchId, entityOpId, order) {
    const b = batch.value && batch.value.batchId === batchId ? batch.value : null
    if (!b) return { ok: false, code: 'no-batch' }
    const entity = b.entities.find(e => e.operationId === entityOpId)
    if (!entity) return { ok: false, code: 'no-entity' }
    const att = (entity.attachments || []).find(a => a.order === order)
    if (!att) return { ok: false, code: 'no-slot' }
    // 已可能提交（durable mayHaveBeenSent）的报告不能在原 opId 下重选换图。
    // 注意：部分附件已登记但报告尚未提交（mayHaveBeenSent=false）→ 失败/缺失槽位仍可重选，
    // 保留已登记项；仅当 reportIntent.mayHaveBeenSent 或实体终态时阻止。
    const intentSubmitted = entity.reportIntent && entity.reportIntent.mayHaveBeenSent
    const entityFinal = entity.status === 'done' || entity.status === 'done-unpersisted' ||
      entity.status === 'conflict' || entity.status === 'reconciling'
    if (intentSubmitted || entityFinal) {
      return { ok: false, code: 'entity-finalized', message: '该报告已提交或待对账——请先在报告详情编辑' }
    }
    // 目标槽位必须未登记（fileId 空）——已成功登记的页不可替换（保留原件）。
    // missing 槽位（原远程 URL/缺失）允许重选
    if (att.fileId) {
      return { ok: false, code: 'slot-registered', message: '该页原件已登记——如需更换请在报告创建后编辑' }
    }

    const epochAtStart = currentEpoch()
    // 恢复作用域在操作开始时捕获（发起成员）——切换后迟到写入只落原成员
    const recoveryScope = openRecoveryScope(MIG_RECOVERY_KEY)
    // chooseImage
    const choose = await new Promise(resolve => {
      if (typeof uni.chooseImage !== 'function') return resolve(null)
      uni.chooseImage({ count: 1, sizeType: ['original'], sourceType: ['album', 'camera'], success: r => resolve(r), fail: () => resolve(null) })
    })
    if (currentEpoch() !== epochAtStart) return { ok: false, code: 'stale-session', stale: true }
    const tempPath = choose && choose.tempFilePaths && choose.tempFilePaths[0]
    if (!tempPath) return { ok: false, code: 'cancelled' } // 取消保留原状态

    // 持久副本
    const persistedCopy = await persistLocalCopy(tempPath)
    if (currentEpoch() !== epochAtStart) {
      // 切换后：新副本已落盘但清单不能写入当前成员——经受限恢复作用域写回原成员
      const durable = persistedCopy.ok
        ? recordAttachmentRecovery(recoveryScope, {
            batchId, entityOpId, order, savedFilePath: persistedCopy.path,
            message: '重选图片时会话切换中断，新原件已保存可恢复', at: Date.now()
          })
        : false
      return { ok: false, code: 'stale-session', stale: true,
        message: !persistedCopy.ok ? '会话已切换，重选已取消'
          : durable ? '会话已切换；新图片已保存到原成员恢复信息中'
          : '会话已切换；新图片保存在内存中（关闭应用后可能丢失），请重新登录原账号查看' }
    }
    if (!persistedCopy.ok) return { ok: false, code: 'persist-failed', message: '本机无法持久保存新图片' }

    // 待确认替换：新原件放独立字段——旧 localPath/uploadId/fileId/missing/remoteUrl
    // 全部保留到确认【落盘】后才替换（durable commit 前取消可完整还原旧映射）
    att.newLocalPath = persistedCopy.path
    att.newUploadId = 'migup_' + sha256HexSync(entity.sourceId + ':re:' + order + ':' + Date.now()).slice(0, 12)
    att.reselected = true
    att.needsConfirm = true // 未确认替换映射不得继续上传

    // 持久化清单——失败回滚但保留新副本路径（写恢复记录，可恢复不遗失）
    if (!persistBatch(epochAtStart)) {
      recordAttachmentRecovery(recoveryScope, {
        batchId, entityOpId, order, savedFilePath: persistedCopy.path,
        message: '重选清单写入失败，新原件已保存可恢复', at: Date.now()
      })
      delete att.newLocalPath
      delete att.newUploadId
      delete att.reselected
      delete att.needsConfirm
      return { ok: false, code: 'manifest-persist-failed', message: '清单写入失败；新图片已保留可恢复，请重试', keptLocalPath: persistedCopy.path }
    }
    return { ok: true, order, newUploadId: att.newUploadId, needsConfirm: true }
  }

  // 确认重选映射（用户明确确认替换）：先落盘再生效——写失败保持待确认状态，
  // 旧 missing/remoteUrl 元数据原样保留（未 durable 提交不得提前清掉）
  function confirmReselect(batchId, entityOpId, order) {
    const b = batch.value && batch.value.batchId === batchId ? batch.value : null
    if (!b) return { ok: false, code: 'no-batch' }
    const entity = b.entities.find(e => e.operationId === entityOpId)
    if (!entity) return { ok: false, code: 'no-entity' }
    const att = (entity.attachments || []).find(a => a.order === order)
    if (!att || !att.reselected) return { ok: false, code: 'no-reselect' }
    const snapshot = JSON.parse(JSON.stringify(att))
    att.needsConfirm = false
    if (att.newUploadId !== undefined) att.uploadId = att.newUploadId
    if (att.newLocalPath !== undefined) att.localPath = att.newLocalPath
    delete att.newUploadId
    delete att.newLocalPath
    delete att.missing // 确认替换后不再是缺失状态
    delete att.remoteUrl // 也不再保留旧远程 URL
    if (!persistBatch()) {
      // 确认未落盘——整体回退快照：needsConfirm 保留、旧映射元数据原样
      for (const k of Object.keys(att)) delete att[k]
      Object.assign(att, snapshot)
      return { ok: false, code: 'persist-failed', message: '确认写入失败，请重试' }
    }
    return { ok: true }
  }

  // 取消重选（恢复原槽位）——重选不覆盖旧字段，取消只需移除新增的待确认字段
  function cancelReselect(batchId, entityOpId, order) {
    const b = batch.value && batch.value.batchId === batchId ? batch.value : null
    if (!b) return { ok: false, code: 'no-batch' }
    const entity = b.entities.find(e => e.operationId === entityOpId)
    if (!entity) return { ok: false, code: 'no-entity' }
    const att = (entity.attachments || []).find(a => a.order === order)
    if (!att || !att.reselected) return { ok: false, code: 'no-reselect' }
    const newPath = att.newLocalPath
    delete att.newLocalPath
    delete att.newUploadId
    delete att.reselected
    delete att.needsConfirm
    if (!persistBatch()) return { ok: false, code: 'persist-failed', message: '取消写入失败，请重试' }
    return { ok: true, keptLocalPath: newPath }
  }

  // 读取附件恢复信息（页面恢复卡片用）：当前完整作用域内最新一条
  // （持久与内存合并取末位；同毫秒多次中断按追加顺序可分辨）
  function getAttachmentRecovery() {
    return recoveryRecordsInScope().newest
  }
  // 当前作用域内【全部】待恢复槽位（逐目标最新）——页面逐槽展示恢复入口
  function getAttachmentRecoveries() {
    return recoveryRecordsInScope().list
  }
  // 存储支撑列表的响应式派生（页面 computed 用）：依赖 storageListRevision——
  // 归档/恢复/恢复记录创建消费/身份家庭变化后自动失效重算
  const archivedBatchesList = computed(() => {
    void storageListRevision.value
    return getArchivedBatches()
  })
  const attachmentRecoveriesList = computed(() => {
    void storageListRevision.value
    return recoveryRecordsInScope().list
  })
  const attachmentRecoveryLatest = computed(() => {
    void storageListRevision.value
    return recoveryRecordsInScope().newest
  })
  // 消费恢复记录：durable 恢复成功后只移除【匹配目标】的条目，
  // 其他槽位的原件记录原样保留；持久重写失败条目仍在（幂等可再恢复）
  function consumeRecoveryRecord(rec) {
    const dk = e => `${e && e.batchId}|${e && e.entityOpId}|${e && e.order}`
    const target = dk(rec)
    const s = getSessionState()
    if (s.member && migMemoryRecovery.has(s.member.memberId)) {
      const left = (migMemoryRecovery.get(s.member.memberId) || []).filter(e => dk(e) !== target)
      if (left.length) migMemoryRecovery.set(s.member.memberId, left)
      else migMemoryRecovery.delete(s.member.memberId)
    }
    const scope = openRecoveryScope(MIG_RECOVERY_KEY)
    if (!scope) return
    try {
      const st = scope.readStatus()
      if (st.status !== 'ok') return // corrupt/error：原字节保留，不动
      const list = Array.isArray(st.value) ? st.value : [st.value]
      // 仅移除与目标全字段匹配的记录元素；结构性无效的遗留元素原样保留
      const left = list.filter(e => !(e && typeof e === 'object' &&
        e.batchId === rec.batchId && e.entityOpId === rec.entityOpId && e.order === rec.order))
      scope.write(left)
    } catch (e) { /* 尽力——条目仍在可再恢复 */ }
    storageListRevision.value++
  }
  // 恢复到原批次原槽位（保留其余页面），需再次确认后续传。
  // 恢复源必须与目标 batchId+entityOpId+order【全字段精确匹配】——
  // 缺任一字段的记录不可用作恢复源（!==undefined 宽容匹配会放行残缺记录）
  function recoverAttachment(batchId, entityOpId, order) {
    const rec = recoveryRecordsInScope().list.find(r => r.batchId === batchId && r.entityOpId === entityOpId && r.order === order)
    if (!rec) return { ok: false, code: 'no-recovery', message: '没有属于该槽位的可恢复原件' }
    const b = batch.value && batch.value.batchId === batchId ? batch.value : null
    if (!b) return { ok: false, code: 'no-batch' }
    const entity = b.entities.find(e => e.operationId === entityOpId)
    if (!entity) return { ok: false, code: 'no-entity' }
    const att = (entity.attachments || []).find(a => a.order === order)
    if (!att) return { ok: false, code: 'no-slot' }
    // 已终态实体不可再改映射（同 reselect 边界）
    const entityFinal = entity.status === 'done' || entity.status === 'done-unpersisted' ||
      entity.status === 'conflict' || entity.status === 'reconciling'
    if (entityFinal) return { ok: false, code: 'entity-finalized', message: '该报告已提交或待对账——如需更换请在报告创建后编辑' }
    // 与重选同语义：恢复原件放待确认字段——确认落盘后才替换旧映射
    const snapshot = JSON.parse(JSON.stringify(att))
    att.newLocalPath = rec.savedFilePath
    att.newUploadId = 'migup_' + sha256HexSync(entityOpId + ':' + order + ':rec:' + Date.now()).slice(0, 12)
    att.reselected = true
    att.needsConfirm = true // 恢复后需再次确认映射
    if (!persistBatch()) {
      for (const k of Object.keys(att)) delete att[k]
      Object.assign(att, snapshot)
      return { ok: false, code: 'persist-failed', message: '恢复写入失败，请重试', savedFilePath: rec.savedFilePath }
    }
    // durable 恢复成功——消费匹配目标的恢复记录（其他槽位不受影响）
    consumeRecoveryRecord(rec)
    return { ok: true, needsConfirm: true }
  }

  // 页面 executor 调用：持久化当前批次；带发起 epoch——切换后拒绝（不写新成员清单）
  function persistBatchNow(epochAtWrite) {
    if (epochAtWrite !== undefined && currentEpoch() !== epochAtWrite) return false
    return persistBatch(epochAtWrite)
  }

  return {
    scanResult, scanning, batch, executing, batchCorrupt, batchReadError,
    persistBatchNow,
    getAttachmentRecovery, getAttachmentRecoveries, recoverAttachment, recordAttachmentRecovery,
    getArchivedBatches, restoreArchivedBatch,
    archivedBatchesList, attachmentRecoveriesList, attachmentRecoveryLatest,
    scanSources, previewEntities, confirmEntities,
    verifySourceDigests, resumeBatch, executeBatch,
    loadBatch,
    reselectAttachment, confirmReselect, cancelReselect
  }
})
