'use strict'

// 集合与字段白名单：结构化集合默认拒绝客户端直接读写（见 rules/database.rules.json），
// 云函数内部再按字段白名单校验、按成员过滤。

const COLLECTIONS = {
  sharedRecords: 'mc_shared_records',   // 家庭共享数字记录（体重等）
  privateNotes: 'mc_private_notes',     // 私人笔记（按 ownerId 隔离）
  operations: 'mc_operations',          // 操作去重（幂等），键：memberId:operationId
  files: 'mc_files'                     // 文件登记（暂存→正式→登记完成）
}

// 共享记录允许的业务字段（数字/字符串），其余一律剔除
const SHARED_RECORD_FIELDS = {
  weightKg: 'number',
  systolic: 'number',
  diastolic: 'number',
  fetalCount: 'number',
  note: 'string' // 共享备注（短文本，两人可见；与私人笔记分开存储）
}

const SHARED_RECORD_TYPES = ['daily'] // B1：按 type+dateKey 定位一条共享记录
const PRIVATE_NOTE_MAX_LEN = 2000
const SHARED_NOTE_MAX_LEN = 200

// 数字范围校验（异常值拒绝，不静默钳制）
const NUMBER_RANGES = {
  weightKg: { min: 25, max: 300 },
  systolic: { min: 60, max: 260 },
  diastolic: { min: 30, max: 180 },
  fetalCount: { min: 0, max: 200 }
}

module.exports = {
  COLLECTIONS,
  SHARED_RECORD_FIELDS,
  SHARED_RECORD_TYPES,
  PRIVATE_NOTE_MAX_LEN,
  SHARED_NOTE_MAX_LEN,
  NUMBER_RANGES
}
