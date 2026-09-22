// 家庭身份会话与成员隔离缓存（B1）。
// 规则：
// - 冷启动：身份未确认（unconfirmed）前不加载任何成员缓存（含私人内容）
// - 明确拒绝（非成员/错 AppID）→ 立即锁定（rejected），后续调用短路
// - 已验证会话内可离线暂存草稿；草稿按成员命名空间保存，退出/切换不删除、
//   也不展示给下一个身份
// - 会话纪元（epoch）：身份确认/退出/切换时递增；携带旧纪元的异步响应一律
//   丢弃，不得写入新身份的缓存
// - 同成员复核例外（R7）：纪元把"真·身份变更"与"同成员回前台自动复核"
//   混为一谈——选图返回/回前台必触发 confirmIdentity 连递纪元，在途上传/
//   拉取会被误判"会话已切换"。captureSession/isSameSession 以会话指纹
//   （familyId/memberId）区分：纪元变了但确认成员未变 → 仍视为同一会话；
//   成员变了/退出/被拒 → 维持全部拦截
// - 缓存键按 env/AppID/member/schema 隔离；缓存键不是身份验证

import { ref } from 'vue'
import { callCloudFunction, cloudRuntimeState } from '@/services/cloudAdapter.js'
import { CLOUD_CONFIG } from '@/utils/cloudConfig.js'

// 响应式会话版本：status/member/epoch/confirming 任一变化时推进，
// 供 familyStore watch 与页面 computed 订阅权威失效
const sessionVersion = ref(0)

function bumpSessionVersion() {
  sessionVersion.value += 1
}

export function subscribeSession() {
  return sessionVersion
}

const SCHEMA = 'b1'
const SESSION_KEY_PREFIX = 'mc_session'
const CACHE_PREFIX = 'mc_cache'
const DRAFT_PREFIX = 'mc_draft'

// 可信身份拒绝（锁定）与暂时性失败（不锁定）必须区分：
// - 拒绝 = 服务端明确说"你不是本家庭成员/上下文非法/未配置" → 立即锁定
// - 暂时 = 网络/函数不可用/返回异常 → 保持未确认，可重试；冷启动离线不放行缓存
const IDENTITY_REFUSAL_CODES = [
  'not-family-member', 'wrong-appid', 'unauthenticated', 'not-configured'
]
const TRANSIENT_CODES = ['cloud-call-failed', 'malformed-result', 'init-failed', 'stale-session']

function isIdentityRefusal(code) {
  return IDENTITY_REFUSAL_CODES.includes(code)
}

const state = {
  status: 'unconfirmed', // unconfirmed | confirmed | rejected | unavailable | not-configured
  member: null,          // { memberId, displayName, familyId }
  rejectCode: '',
  epoch: 0,
  confirming: false      // 身份确认在途：期间限制业务请求与成员缓存访问
}

function sessionKey() {
  return `${SESSION_KEY_PREFIX}_${CLOUD_CONFIG.envId}_${CLOUD_CONFIG.appId}`
}

function namespaced(prefix, schema, key) {
  return `${prefix}_${CLOUD_CONFIG.envId}_${CLOUD_CONFIG.appId}_${state.member ? state.member.memberId : 'anon'}_${schema}_${key}`
}

export function getSessionState() {
  return {
    status: state.status,
    member: state.member ? { ...state.member } : null,
    rejectCode: state.rejectCode,
    epoch: state.epoch,
    confirming: state.confirming,
    autoRecheckEligible: state.autoRecheckEligible
  }
}

export function currentEpoch() {
  return state.epoch
}

// ── 同成员复核语义（R7）──
// 会话指纹：确认态成员的身份摘要；未确认/退出/锁定时为 null。
// env/AppID 为构建期常量，不参与运行时变化，不入指纹。
export function sessionFingerprint() {
  return state.status === 'confirmed' && state.member
    ? `${state.member.familyId}/${state.member.memberId}`
    : null
}

// 操作开始时捕获 { epoch, fp }：后续用 isSameSession 判定"仍在同一会话"
export function captureSession() {
  return { epoch: state.epoch, fp: sessionFingerprint() }
}

// 同一会话判定：epoch 未变 → 同；epoch 变了但仍是同一确认成员（同成员回前台
// 自动复核）→ 也算同。成员真切换/退出/被拒（fp 为 null 或不同）→ 异。
// 不看 confirming：确认窗口内成员尚未替换，写入仍落在当前成员命名空间，
// 且业务请求由 familyCall 的 confirming 前门拦截，此处无需重复设卡。
export function isSameSession(captured) {
  if (!captured) return false
  if (captured.epoch === state.epoch) return true
  return Boolean(captured.fp) && captured.fp === sessionFingerprint()
}

// 冷启动：只报告是否存在已持久化的"已确认"会话记录；未联网确认前不使用它加载缓存
// 显式演示模式：enterDemoMode 写入的 demo-explicit 标记（优先于一切自动复核；
// 即便此前有已确认家庭会话，切演示后 App/页面不得发送正式业务请求）
export function isExplicitDemo() {
  try {
    return uni.getStorageSync('mc_session_mode') === 'demo-explicit'
  } catch (e) {
    return false
  }
}

// 显式退出：endSession 写入的 logged-out 标记
export function isExplicitLoggedOut() {
  try {
    return uni.getStorageSync('mc_session_mode') === 'logged-out'
  } catch (e) {
    return false
  }
}

// family 正式态单一判定（2026-09-22 起从 detail.vue 本地定义提升为共享导出）：
// 已确认家庭会话且非显式演示/登出——解读读侧（detail/ai-result）与 report 店共用
export function isFamilyMode() {
  return getSessionState().status === 'confirmed' && !isExplicitDemo() && !isExplicitLoggedOut()
}

export function persistedSessionExists() {
  if (cloudRuntimeState() === 'not-configured') return false
  try {
    return Boolean(uni.getStorageSync(sessionKey()))
  } catch (e) {
    return false
  }
}

// 回前台身份复核：App 与页面 onShow 的唯一确认入口（去重、不竞争）。
// - in-flight 复用同一 Promise（多个 onShow 同时触发只发一次网络）
// - 成功后若成员变化，epoch/sessionVersion 已在 confirmIdentity 内推进，
//   familyStore watch 会清空旧成员数据并以新成员快照恢复
// - 明确拒绝 → 锁定；临时离线 → 暖离线（已确认会话保留可用性）
let foregroundRecheckPromise = null
export function foregroundRecheck() {
  // 演示优先（复验：已确认用户切演示后 App.onShow 不得发正式请求）
  if (isExplicitDemo()) {
    return Promise.resolve({ ok: false, code: 'demo-explicit', message: '演示模式：不自动复核正式身份' })
  }
  if (isExplicitLoggedOut() || !state.autoRecheckEligible) {
    return Promise.resolve({ ok: false, code: 'recheck-ineligible', message: '当前会话不自动复核身份（显式退出或未确认）' })
  }
  if (foregroundRecheckPromise) return foregroundRecheckPromise
  foregroundRecheckPromise = (async () => {
    try {
      return await confirmIdentity()
    } finally {
      foregroundRecheckPromise = null
    }
  })()
  return foregroundRecheckPromise
}

// 冷启动确认（复现20修复）：持久会话标记存在时的首次联网确认。
// 标记只触发网络确认，不放行缓存（确认成功前 status 仍 unconfirmed，
// 成员缓存/正式数据均不可见）。与 foregroundRecheck 共享同一 in-flight
// Promise——App.onShow 与页面 onShow/mounted 同时触发只发一次请求；
// 显式演示/退出标记仍优先阻止。成功后 autoRecheckEligible 建立。
export function coldStartConfirm() {
  if (isExplicitDemo()) {
    return Promise.resolve({ ok: false, code: 'demo-explicit', message: '演示模式：不确认正式身份' })
  }
  if (isExplicitLoggedOut()) {
    return Promise.resolve({ ok: false, code: 'recheck-ineligible', message: '已显式退出，不自动确认' })
  }
  // 无持久标记且未确认：不自动确认（用户需主动进入家庭空间）
  if (!persistedSessionExists() && state.status !== 'confirmed') {
    return Promise.resolve({ ok: false, code: 'no-persisted-session', message: '无已确认会话标记，请进入家庭空间确认身份' })
  }
  if (foregroundRecheckPromise) return foregroundRecheckPromise // 与复核共享去重
  foregroundRecheckPromise = (async () => {
    try {
      return await confirmIdentity()
    } finally {
      foregroundRecheckPromise = null
    }
  })()
  return foregroundRecheckPromise
}

// 等待在途确认落定（R7）：业务操作开始前调用——把选图返回/回前台触发的
// 自动复核等完，纪元先落定再捕获，常态下根本不进复核窗口。
// 无在途确认立即返回 null（非 Promise 结果语义，仅表"无需等待"）。
export function settleConfirm() {
  return foregroundRecheckPromise || Promise.resolve(null)
}

// 联网确认身份（冷启动/手动刷新共用）。拒绝即锁定，不自动重试；
// 暂时性网络失败不锁定（保持未确认、不放行缓存）。
// 每次确认尝试都推进纪元：确认期间/结果更换身份 → 此前的在途请求全部失效。
export async function confirmIdentity() {
  const runtime = cloudRuntimeState()
  if (runtime === 'not-configured') {
    state.status = 'not-configured'
    return { ok: false, code: 'not-configured' }
  }
  if (runtime === 'unavailable-platform') {
    state.status = 'unavailable'
    return { ok: false, code: 'unavailable-platform' }
  }
  if (state.status === 'rejected') {
    return { ok: false, code: state.rejectCode || 'rejected', locked: true }
  }
  state.epoch += 1 // 使在途旧请求失效（含上一次确认的迟到响应）
  bumpSessionVersion()
  const epochAtStart = state.epoch
  state.confirming = true
  bumpSessionVersion()
  let res
  try {
    res = await callCloudFunction('mc-identity', { action: 'whoami' })
  } finally {
    state.confirming = false
    bumpSessionVersion()
  }
  if (state.epoch !== epochAtStart) {
    return { ok: false, code: 'stale-session' }
  }
  if (!res.ok) {
    if (isIdentityRefusal(res.code)) {
      state.epoch += 1 // 使确认期间发出的业务请求全部失效
      state.status = 'rejected'
      bumpSessionVersion()
      state.rejectCode = res.code
      state.member = null
      try { uni.removeStorageSync(sessionKey()) } catch (e) { /* 忽略 */ }
      return { ok: false, code: res.code, locked: true }
    }
    // 暂时性失败：不改变既有状态——已确认会话保持可离线使用，未确认保持未确认
    return { ok: false, code: res.code, transient: true }
  }
  state.epoch += 1 // 确认落地同样推进纪元：确认在途的旧成员业务请求全部失效
  state.status = 'confirmed'
  state.member = res.data
  bumpSessionVersion()
  state.rejectCode = ''
  state.autoRecheckEligible = true // 显式确认成功：建立自动复核资格
  try {
    uni.setStorageSync(sessionKey(), JSON.stringify({ ...res.data, confirmedAt: Date.now() }))
    uni.removeStorageSync('mc_session_mode') // 显式确认清除退出/演示标记
  } catch (e) {
    // 会话标记写失败不影响本次已确认状态；下次冷启动需重新联网确认
  }
  return { ok: true, member: { ...res.data } }
}

// 设置期自取 OpenID（受控通道）：返回调用者自己的 OpenID
export async function fetchMyOpenid() {
  const res = await callCloudFunction('mc-identity', { action: 'my-openid' })
  return res
}

// 退出/切换身份：清会话标记与内存态；成员缓存数据与草稿保留在各自命名空间，
// 不删除（未同步草稿不静默丢失）、不展示给下一个身份
export function endSession() {
  state.epoch += 1
  state.autoRecheckEligible = false // 显式退出：取消自动复核资格
  try { uni.setStorageSync('mc_session_mode', 'logged-out') } catch (e) { /* 忽略 */ }
  bumpSessionVersion()
  state.status = 'unconfirmed'
  state.member = null
  state.rejectCode = ''
  try { uni.removeStorageSync(sessionKey()) } catch (e) { /* 忽略 */ }
}

// ── 成员缓存（确认后可用）──

export function getMemberCache(key) {
  if (state.status !== 'confirmed' || !state.member || state.confirming) return null
  try {
    const raw = uni.getStorageSync(namespaced(CACHE_PREFIX, SCHEMA, key))
    return raw ? JSON.parse(raw) : null
  } catch (e) {
    return null
  }
}

// 受限恢复写入作用域（B2b2 恢复边界）：仅在【发起时已确认身份】创建——捕获
// 不可变 env/AppID/member/family；迟到写入只能落这个原作用域的恢复键，
// 不接受调用方传任意成员/键，不因当前配置变化漂移；返回真实落盘结果。
export function openRecoveryScope(recoveryKey) {
  if (state.status !== 'confirmed' || !state.member || state.confirming) return null
  const scope = {
    envId: CLOUD_CONFIG.envId,
    appId: CLOUD_CONFIG.appId,
    memberId: state.member.memberId,
    familyId: state.member.familyId
  }
  const cacheKey = `${CACHE_PREFIX}_${scope.envId}_${scope.appId}_${scope.memberId}_${SCHEMA}_${recoveryKey}`
  return {
    scope,
    // 原作用域读取：追加式记录须读原成员键，不能用当前成员的 getMemberCache。
    // status: 'absent'（无键）| 'corrupt'（有键但不可解析——原字节必须保留，不覆写）
    //        | 'ok' | 'error'（底层读异常，当作不可追加）
    readStatus() {
      let raw
      try {
        raw = uni.getStorageSync(cacheKey)
      } catch (e) {
        return { status: 'error' }
      }
      if (raw === '' || raw === null || raw === undefined) return { status: 'absent' }
      try {
        return { status: 'ok', value: JSON.parse(raw) }
      } catch (e) {
        return { status: 'corrupt' }
      }
    },
    read() {
      const r = this.readStatus()
      return r.status === 'ok' ? r.value : null
    },
    write(value) {
      try {
        // 与 setMemberCache 同一存储形状（JSON 字符串）：getMemberCache 直接可读
        uni.setStorageSync(cacheKey, JSON.stringify(value))
        return true
      } catch (e) {
        return false
      }
    }
  }
}

// 精确作用域缓存读取结果（B3a）：
// 'present' = 当前成员作用域键存在且可解析
// 'corrupt' = 当前成员作用域键存在但 JSON 损坏（原字节保留）
// 'absent'  = 当前成员作用域无此键
// 'other-member' = 此键后缀仅存在于其他成员命名空间（零读正文）
// 'error'   = 底层存储读取异常（不当作 absent）
export function getScopedCacheStatus(key) {
  const scopedKey = namespaced(CACHE_PREFIX, SCHEMA, key)
  let raw
  try {
    raw = uni.getStorageSync(scopedKey)
  } catch (e) {
    return 'error'
  }
  if (raw === '' || raw === null || raw === undefined) {
    // 当前成员无此键——检查其他成员是否有（只看键名列表，不读正文）
    try {
      const info = typeof uni.getStorageInfoSync === 'function' ? uni.getStorageInfoSync() : { keys: [] }
      const suffix = '_' + SCHEMA + '_' + key
      const otherMember = (info.keys || []).some(k => k.endsWith(suffix) && k !== scopedKey)
      return otherMember ? 'other-member' : 'absent'
    } catch (e) {
      return 'error'
    }
  }
  // 键存在——尝试解析
  try {
    if (typeof raw === 'string') JSON.parse(raw)
    return 'present'
  } catch (e) {
    return 'corrupt'
  }
}

export function setMemberCache(key, value, epochAtWrite) {
  if (state.status !== 'confirmed' || !state.member || state.confirming) return false
  if (epochAtWrite !== undefined && epochAtWrite !== state.epoch) return false
  try {
    uni.setStorageSync(namespaced(CACHE_PREFIX, SCHEMA, key), JSON.stringify(value))
    return true
  } catch (e) {
    return false
  }
}

// ── 离线草稿（按当前已确认成员命名空间；退出不清除）──
// 生产 API 不接受任意 memberId：只能为"当前已确认身份"暂存/读取/清除，
// 未确认身份一律拒绝——不依赖调用者自觉维持边界。

function draftKeyForMember(memberId) {
  return `${DRAFT_PREFIX}_${CLOUD_CONFIG.envId}_${CLOUD_CONFIG.appId}_${memberId}_${SCHEMA}`
}

// 合并式暂存：只更新本次提交的字段，保留草稿中其他未同步字段
// （如共享保存不应清掉草稿里尚未同步的私人笔记，反之亦然）
export function mergeDraft(partial) {
  if (state.status !== 'confirmed' || !state.member) return false
  const key = draftKeyForMember(state.member.memberId)
  try {
    const raw = uni.getStorageSync(key)
    const existing = raw ? JSON.parse(raw) : {}
    const merged = { ...existing, ...partial, stashedAt: Date.now() }
    // 去掉空串字段，避免空值覆盖既有草稿内容
    for (const k of Object.keys(merged)) {
      if (merged[k] === '' || merged[k] === undefined) delete merged[k]
    }
    if (Object.keys(merged).filter(k => k !== 'stashedAt').length === 0) return true
    uni.setStorageSync(key, JSON.stringify(merged))
    return true
  } catch (e) {
    return false
  }
}

export function stashDraft(draft) {
  if (state.status !== 'confirmed' || !state.member) return false
  try {
    uni.setStorageSync(draftKeyForMember(state.member.memberId), JSON.stringify({ ...draft, stashedAt: Date.now() }))
    return true
  } catch (e) {
    return false
  }
}

// 草稿存储只读可判定状态（B3b 完整性门用）：区分 absent/ok/corrupt/error——
// pendingDrafts 对损坏与空都返回 null，无法作为完整性依据
export function draftStorageStatus() {
  if (state.status !== 'confirmed' || !state.member) return 'unconfirmed'
  try {
    const raw = uni.getStorageSync(draftKeyForMember(state.member.memberId))
    if (raw === '' || raw === null || raw === undefined) return 'absent'
    try {
      JSON.parse(raw)
      return 'ok'
    } catch (e) {
      return 'corrupt'
    }
  } catch (e) {
    return 'error'
  }
}

export function pendingDrafts() {
  if (state.status !== 'confirmed' || !state.member) return null
  try {
    const raw = uni.getStorageSync(draftKeyForMember(state.member.memberId))
    return raw ? JSON.parse(raw) : null
  } catch (e) {
    return null
  }
}

export function clearDraft() {
  if (state.status !== 'confirmed' || !state.member) return false
  try {
    uni.removeStorageSync(draftKeyForMember(state.member.memberId))
    return true
  } catch (e) {
    return false
  }
}

// 分字段清除草稿：保存共享体重只清 weightKg，保留尚未同步的私人笔记（反之亦然）；
// 全部字段清空后删除草稿键，避免旧草稿之后覆盖新内容
export function clearDraftFields(...fields) {
  if (state.status !== 'confirmed' || !state.member) return false
  const key = draftKeyForMember(state.member.memberId)
  try {
    const raw = uni.getStorageSync(key)
    if (!raw) return true
    const draft = JSON.parse(raw)
    for (const f of fields) delete draft[f]
    delete draft.stashedAt
    const rest = Object.keys(draft).filter(k => draft[k] !== undefined && draft[k] !== '')
    if (rest.length === 0) {
      uni.removeStorageSync(key)
    } else {
      uni.setStorageSync(key, JSON.stringify(draft))
    }
    return true
  } catch (e) {
    return false
  }
}

// ── 待上传文件状态（按当前确认成员持久化；CLOUDBASE_PLAN 4.1）──
// 重试必须继续同一待办文件；换新图是显式新操作（先丢弃待办）。
// 保存失败必须如实返回 false，页面不得显示"已暂存"。

function pendingUploadKeyForMember(memberId) {
  return `mc_pending_upload_${CLOUD_CONFIG.envId}_${CLOUD_CONFIG.appId}_${memberId}_${SCHEMA}`
}

export function savePendingUpload(pending) {
  if (state.status !== 'confirmed' || !state.member) return false
  try {
    uni.setStorageSync(pendingUploadKeyForMember(state.member.memberId), JSON.stringify({ ...pending, savedAt: Date.now() }))
    return true
  } catch (e) {
    return false
  }
}

export function getPendingUpload() {
  if (state.status !== 'confirmed' || !state.member) return null
  try {
    const raw = uni.getStorageSync(pendingUploadKeyForMember(state.member.memberId))
    return raw ? JSON.parse(raw) : null
  } catch (e) {
    return null
  }
}

export function clearPendingUpload() {
  if (state.status !== 'confirmed' || !state.member) return false
  try {
    uni.removeStorageSync(pendingUploadKeyForMember(state.member.memberId))
    return true
  } catch (e) {
    return false
  }
}

// ── 云函数调用包装：纪元守卫 + 业务身份拒绝即锁定 ──

export async function familyCall(name, data) {
  if (state.confirming) {
    // 确认在途：旧成员身份的业务请求不得跨越身份变更窗口
    return { ok: false, code: 'confirming', message: '身份确认进行中，请稍候' }
  }
  if (state.status !== 'confirmed' || !state.member) {
    return { ok: false, code: 'unauthenticated-session', message: '身份未确认' }
  }
  const epochAtStart = state.epoch
  const sessionAtStart = { epoch: epochAtStart, fp: sessionFingerprint() }
  const res = await callCloudFunction(name, data)
  // 纪元推进即丢弃过于粗暴：同成员回前台复核（R7）期间返回的响应对当前
  // 成员仍然有效，丢弃会造成"会话已切换"误报；真换成员/退出/被拒
  // （指纹为 null 或不同）仍维持丢弃
  if (!isSameSession(sessionAtStart)) {
    return { ok: false, code: 'stale-session', message: '会话已切换，响应已丢弃' }
  }
  // 业务函数返回可信身份拒绝（伪造/第三成员/白名单变化）→ 立即锁定会话
  if (!res.ok && isIdentityRefusal(res.code)) {
    state.epoch += 1
    state.status = 'rejected'
    state.rejectCode = res.code
    state.member = null
    bumpSessionVersion()
    try { uni.removeStorageSync(sessionKey()) } catch (e) { /* 忽略 */ }
    return { ok: false, code: res.code, locked: true, message: '身份被服务端拒绝，会话已锁定' }
  }
  return res
}

// 测试辅助：直接注入已确认状态（不经网络）
export function __adoptSessionForTests(member) {
  state.status = 'confirmed'
  state.member = member
  state.rejectCode = ''
  state.epoch += 1
}

export function __resetForTests() {
  state.status = 'unconfirmed'
  state.member = null
  state.rejectCode = ''
  state.epoch = 0
  state.confirming = false
}
