'use strict'

// mc-private-notes：本人私人笔记。ownerId 一律由服务端从可信身份生成，
// 客户端传入的 ownerId/memberId 全部忽略。另一成员的读取/更新一律拒绝，
// 响应、错误与日志都不包含私人正文。
// expectedRevision 必须是显式非负整数（0=创建）：省略/非整数/负数一律拒绝。
// 同成员 + operationId 幂等；revision 冲突响应不携带正文。
//
// wx-server-sdk@4.0.2 契约（源码核对，见 cloud/DEPLOY.md）：
//   cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, throwOnNotFound: false })（配置级）
//   doc.get() → { data: object|null }；doc.set({data}) 数据含 _id 会被拒（-501007）

const { loadServerConfig } = require('./shared/config')
const { resolveCaller } = require('./shared/auth')
const { ok, fail, stableRequestHash } = require('./shared/respond')
const { COLLECTIONS, PRIVATE_NOTE_MAX_LEN } = require('./shared/constants')

let cloud = null
try {
  cloud = require('wx-server-sdk')
} catch (e) {
  cloud = null
}

exports.__setCloud = function __setCloud(mockCloud) {
  cloud = mockCloud
}

async function getDocMaybe(docRef) {
  try {
    const snap = await docRef.get()
    // 统一返回文档对象本身（snap.data），调用方直接读字段
    return snap && snap.data ? snap.data : null
  } catch (err) {
    const msg = String((err && (err.errMsg || err.message)) || err)
    if (/not\s*exist|does not exist/i.test(msg)) return null
    throw err
  }
}

function parseExpectedRevision(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return null
  }
  return value
}

function noteDocId(config, memberId, dateKey) {
  return `${config.familyId}:${memberId}:${dateKey}`
}

function publicNoteView(doc) {
  if (!doc) return null
  return {
    id: doc._id,
    dateKey: doc.dateKey,
    content: doc.content,
    revision: doc.revision,
    updatedAt: doc.updatedAt
  }
}

exports.main = async function main(event) {
  if (!cloud) return fail('sdk-unavailable', 'wx-server-sdk 不可用')
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, throwOnNotFound: false })
  const config = loadServerConfig()
  const resolved = resolveCaller(cloud, config, event)
  if (!resolved.ok) return fail(resolved.code, resolved.message)
  const caller = resolved.caller
  const action = event && event.action

  if (action === 'get') {
    const { dateKey } = event
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return fail('invalid-params', 'dateKey 非法')
    // 只读调用者本人：docId 内嵌 memberId，另一成员的日期键命中自己的文档
    const doc = await getDocMaybe(
      cloud.database().collection(COLLECTIONS.privateNotes).doc(noteDocId(config, caller.memberId, dateKey))
    )
    return ok({ note: publicNoteView(doc) })
  }

  if (action === 'upsert') {
    const { dateKey, content, expectedRevision, operationId } = event
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return fail('invalid-params', 'dateKey 非法')
    if (typeof content !== 'string' || content.length === 0) return fail('invalid-params', '内容不能为空')
    if (content.length > PRIVATE_NOTE_MAX_LEN) return fail('invalid-params', `内容超过 ${PRIVATE_NOTE_MAX_LEN} 字`)
    if (!operationId || typeof operationId !== 'string' || operationId.length > 64) {
      return fail('invalid-params', '缺少有效 operationId')
    }
    const expected = parseExpectedRevision(expectedRevision)
    if (expected === null) {
      return fail('invalid-params', 'expectedRevision 必须是显式非负整数（0=创建）')
    }

    const opKey = `${caller.memberId}:${operationId}`
    const opDoc = {
      memberId: caller.memberId,
      operationId,
      kind: 'private-note-upsert',
      requestHash: stableRequestHash({ dateKey, content, expectedRevision: expected })
    }
    const noteId = noteDocId(config, caller.memberId, dateKey)
    const now = Date.now()
    const db = cloud.database()

    const t = await db.startTransaction()
    try {
      const prevOp = await getDocMaybe(t.collection(COLLECTIONS.operations).doc(opKey))
      if (prevOp) {
        if (prevOp.requestHash !== opDoc.requestHash) {
          await t.rollback()
          return fail('operation-id-conflict', '同一 operationId 曾以不同内容提交')
        }
        await t.rollback()
        return ok({ replayed: true, note: prevOp.resultSnapshot })
      }

      const existing = await getDocMaybe(t.collection(COLLECTIONS.privateNotes).doc(noteId))
      const currentRevision = existing ? existing.revision : 0
      if (expected !== currentRevision) {
        await t.rollback()
        // 冲突响应不携带正文，只带版本
        return fail('revision-conflict', '笔记已被修改', { currentRevision })
      }

      // set 数据不得包含 _id（SDK 契约）
      const nextDoc = {
        familyId: config.familyId, // 仅作数据分区，不是授权依据
        ownerId: caller.memberId,  // 服务端生成
        dateKey,
        content,
        revision: currentRevision + 1,
        updatedBy: caller.memberId,
        updatedAt: now,
        lastOperationId: operationId
      }
      const resultSnapshot = publicNoteView({ ...nextDoc, _id: noteId })
      await t.collection(COLLECTIONS.privateNotes).doc(noteId).set({ data: nextDoc })
      await t.collection(COLLECTIONS.operations).doc(opKey).set({
        data: { ...opDoc, resultSnapshot, createdAt: now }
      })
      await t.commit()
      return ok({ replayed: false, note: resultSnapshot })
    } catch (err) {
      try { await t.rollback() } catch (rollbackErr) { /* 已回滚/未开启 */ }
      return fail('transaction-failed', '事务未提交成功，可安全重试', {
        errMsg: String((err && (err.errMsg || err.message)) || err).slice(0, 200)
      })
    }
  }

  return fail('invalid-action', '未知 action')
}
