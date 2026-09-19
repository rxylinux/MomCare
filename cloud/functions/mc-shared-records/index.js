'use strict'

// mc-shared-records：家庭共享数字记录（B1 最小集：按 type+dateKey 一条/天）。
// - 归属/操作者由服务端从可信身份生成，客户端传入的 familyId/memberId 忽略
// - 字段白名单 + 数值范围校验，未知字段剔除
// - expectedRevision 必须是显式非负整数（0=创建）：省略/非整数/负数一律拒绝，
//   不允许"盲写"绕过乐观并发
// - operationId 幂等：同成员同 operationId 同内容 → 重放首次结果；
//   同 operationId 不同内容 → 拒绝；并发提交由事务保证只成功一次，
//   事务失败原样返回错误（客户端可用同一 operationId 安全重试）
//
// wx-server-sdk@4.0.2 契约（经源码核对，见 cloud/DEPLOY.md）：
//   cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, throwOnNotFound: false })
//     —— throwOnNotFound 是 init 配置级选项（源码：database.config / cloud.config）
//   doc.get() → { data: object|null }；doc.set({data}) 数据含 _id 会被拒（-501007）

const { loadServerConfig } = require('./shared/config')
const { resolveCaller } = require('./shared/auth')
const { ok, fail, stableRequestHash } = require('./shared/respond')
const {
  COLLECTIONS, SHARED_RECORD_FIELDS, SHARED_RECORD_TYPES,
  SHARED_NOTE_MAX_LEN, NUMBER_RANGES
} = require('./shared/constants')

let cloud = null
try {
  cloud = require('wx-server-sdk')
} catch (e) {
  cloud = null
}

exports.__setCloud = function __setCloud(mockCloud) {
  cloud = mockCloud
}

// 读取"可能不存在"的文档。优先使用官方 throwOnNotFound:false 契约；
// 兜底 catch 只接受明确的"记录不存在"错误，权限/超时/连接错误原样抛出，
// 绝不把任意失败当作不存在。
async function getDocMaybe(docRef) {
  try {
    const snap = await docRef.get()
    // 统一返回文档对象本身（snap.data），调用方直接读字段
    return snap && snap.data ? snap.data : null
  } catch (err) {
    // 配置级 throwOnNotFound:false 已让不存在返回 data:null；
    // 此兜底只接受明确的"记录不存在"错误，权限/超时/连接错误原样抛出
    const msg = String((err && (err.errMsg || err.message)) || err)
    if (/not\s*exist|does not exist/i.test(msg)) return null
    throw err
  }
}

// 显式 revision 校验：必须是数字类型的非负整数（拒绝 null/undefined/字符串/小数/负数）
function parseExpectedRevision(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return null
  }
  return value
}

function sanitizePayload(input) {
  const errors = []
  const payload = {}
  for (const [field, kind] of Object.entries(SHARED_RECORD_FIELDS)) {
    if (input[field] === undefined || input[field] === null || input[field] === '') continue
    const value = input[field]
    if (kind === 'number') {
      const num = Number(value)
      const range = NUMBER_RANGES[field]
      if (!Number.isFinite(num)) { errors.push(`${field} 不是有效数字`); continue }
      if (range && (num < range.min || num > range.max)) { errors.push(`${field} 超出合理范围`); continue }
      payload[field] = num
    } else if (kind === 'string') {
      if (typeof value !== 'string') { errors.push(`${field} 必须是文本`); continue }
      if (field === 'note' && value.length > SHARED_NOTE_MAX_LEN) { errors.push(`${field} 过长`); continue }
      payload[field] = value
    }
  }
  return { payload, errors }
}

function recordDocId(config, type, dateKey) {
  return `${config.familyId}:${type}:${dateKey}`
}

function publicRecordView(doc) {
  if (!doc) return null
  return {
    id: doc._id,
    type: doc.type,
    dateKey: doc.dateKey,
    payload: doc.payload,
    revision: doc.revision,
    updatedBy: doc.updatedBy,
    updatedAt: doc.updatedAt
  }
}

exports.main = async function main(event) {
  if (!cloud) return fail('sdk-unavailable', 'wx-server-sdk 不可用（本地运行属正常，部署环境必须存在）')
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, throwOnNotFound: false })
  const config = loadServerConfig()
  const resolved = resolveCaller(cloud, config, event)
  if (!resolved.ok) return fail(resolved.code, resolved.message)
  const caller = resolved.caller
  const action = event && event.action

  if (action === 'get') {
    const { type = 'daily', dateKey } = event
    if (!SHARED_RECORD_TYPES.includes(type)) return fail('invalid-params', '未知记录类型')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return fail('invalid-params', 'dateKey 非法')
    const doc = await getDocMaybe(
      cloud.database().collection(COLLECTIONS.sharedRecords).doc(recordDocId(config, type, dateKey))
    )
    return ok({ record: publicRecordView(doc) })
  }

  if (action === 'upsert') {
    const { type = 'daily', dateKey, payload = {}, expectedRevision, operationId } = event
    if (!SHARED_RECORD_TYPES.includes(type)) return fail('invalid-params', '未知记录类型')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return fail('invalid-params', 'dateKey 非法')
    if (!operationId || typeof operationId !== 'string' || operationId.length > 64) {
      return fail('invalid-params', '缺少有效 operationId')
    }
    const expected = parseExpectedRevision(expectedRevision)
    if (expected === null) {
      return fail('invalid-params', 'expectedRevision 必须是显式非负整数（0=创建）')
    }
    const { payload: clean, errors } = sanitizePayload(payload)
    if (errors.length > 0) return fail('invalid-params', errors.join('；'))
    if (Object.keys(clean).length === 0) return fail('invalid-params', '没有可保存的字段')

    const opKey = `${caller.memberId}:${operationId}`
    const opDoc = {
      memberId: caller.memberId,
      operationId,
      kind: 'shared-record-upsert',
      requestHash: stableRequestHash({ type, dateKey, payload: clean, expectedRevision: expected })
    }
    const recordId = recordDocId(config, type, dateKey)
    const now = Date.now()
    const db = cloud.database()

    const t = await db.startTransaction()
    try {
      // 1) 幂等：同 opKey 已处理 → 原样重放首次结果（相同请求），不同请求拒绝
      const prevOp = await getDocMaybe(t.collection(COLLECTIONS.operations).doc(opKey))
      if (prevOp) {
        if (prevOp.requestHash !== opDoc.requestHash) {
          await t.rollback()
          return fail('operation-id-conflict', '同一 operationId 曾以不同内容提交')
        }
        await t.rollback() // 只读重放，无需提交
        return ok({ replayed: true, record: prevOp.resultSnapshot })
      }

      // 2) revision 乐观检查 + 写入，均在同一事务内
      const existing = await getDocMaybe(t.collection(COLLECTIONS.sharedRecords).doc(recordId))
      const currentRevision = existing ? existing.revision : 0
      if (expected !== currentRevision) {
        await t.rollback()
        return fail('revision-conflict', '记录已被对方更新', {
          currentRevision,
          currentRecord: publicRecordView(existing)
        })
      }

      const nextPayload = existing ? { ...existing.payload, ...clean } : { ...clean }
      // set 数据不得包含 _id（SDK 契约：doc(id) 已携带主键）
      const nextDoc = {
        familyId: config.familyId,
        type,
        dateKey,
        payload: nextPayload,
        revision: currentRevision + 1,
        updatedBy: caller.memberId,
        updatedAt: now,
        lastOperationId: operationId
      }
      const resultSnapshot = publicRecordView({ ...nextDoc, _id: recordId })

      await t.collection(COLLECTIONS.sharedRecords).doc(recordId).set({ data: nextDoc })
      await t.collection(COLLECTIONS.operations).doc(opKey).set({
        data: { ...opDoc, resultSnapshot, createdAt: now }
      })
      await t.commit()
      return ok({ replayed: false, record: resultSnapshot })
    } catch (err) {
      try { await t.rollback() } catch (rollbackErr) { /* 已回滚/未开启 */ }
      // 事务失败原样上报（含并发冲突），不伪成功；客户端以同一 operationId 重试是安全的
      return fail('transaction-failed', '事务未提交成功，可安全重试', {
        errMsg: String((err && (err.errMsg || err.message)) || err).slice(0, 200)
      })
    }
  }

  return fail('invalid-action', '未知 action')
}
