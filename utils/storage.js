// 数据模式与存储键管理：正式档案与演示模式使用互不重叠的存储空间。
// 旧数据只做可恢复备份，绝不删除；归属不明的旧缓存不自动并入任何身份。

export const DATA_MODE_KEY = 'MOMCARE_DATA_MODE'
export const LEGACY_BACKUP_MARKER = 'MOMCARE_LEGACY_BACKUP_DONE'

// 正式模式沿用历史键，保证真实用户数据原地保留
export const FORMAL_HEALTH_KEY = 'YUNTU_HEALTH_DATA'
export const FORMAL_REPORTS_KEY = 'YUNTU_REPORTS_DATA'
// 演示模式独立键，避免示例数据污染正式档案
export const DEMO_HEALTH_KEY = 'MOMCARE_DEMO_HEALTH_DATA'
export const DEMO_REPORTS_KEY = 'MOMCARE_DEMO_REPORTS_DATA'

// 返回 'demo' | 'formal' | null。
// 键缺失（全新安装）合法默认为 formal；读取 API 报错返回 null 表示未知，
// 调用方不得据此选择命名空间读写，防止演示内容写进正式档案
export function getDataMode() {
  let raw
  try {
    raw = uni.getStorageSync(DATA_MODE_KEY)
  } catch (e) {
    console.error('getDataMode read failed, storage mode unknown:', e)
    return null
  }
  if (raw === 'demo') return 'demo'
  return 'formal'
}

// 返回是否写入成功：模式切换失败时调用方不得继续写入新命名空间
export function setDataMode(mode) {
  try {
    uni.setStorageSync(DATA_MODE_KEY, mode === 'demo' ? 'demo' : 'formal')
    return true
  } catch (e) {
    console.error('setDataMode failed:', e)
    return false
  }
}

export function isDemoMode() {
  return getDataMode() === 'demo'
}

// 模式未知（读取报错）时返回 null：健康/报告存储必须拒绝读写
export function healthStorageKey() {
  const mode = getDataMode()
  if (mode === 'demo') return DEMO_HEALTH_KEY
  if (mode === 'formal') return FORMAL_HEALTH_KEY
  return null
}

export function reportsStorageKey() {
  const mode = getDataMode()
  if (mode === 'demo') return DEMO_REPORTS_KEY
  if (mode === 'formal') return FORMAL_REPORTS_KEY
  return null
}

function _readMarker() {
  try {
    const raw = uni.getStorageSync(LEGACY_BACKUP_MARKER)
    const marker = raw ? JSON.parse(raw) : null
    return marker && typeof marker === 'object' ? marker : null
  } catch (e) {
    console.warn('legacy backup marker unreadable, will re-backup:', e)
    return null
  }
}

// 一次性把切换到新版本前的正式数据复制为可恢复备份。
// 健康数据与报告数据分别独立备份；只有当"所有存在的数据集"都备份成功后
// 才写入完成标记。任一读写失败都不写标记，下次启动重试。
// 不判断内容、不删除原件：是否存在演示数据留给用户确认（阶段 B 迁移）。
export function ensureLegacyBackup() {
  const mode = getDataMode()
  if (mode === null) {
    // 模式未知：拒绝执行任何涉及命名空间判断的动作
    console.error('ensureLegacyBackup: storage mode unknown, abort')
    return null
  }
  if (mode === 'demo') return null

  let healthRaw
  let reportsRaw
  try {
    healthRaw = uni.getStorageSync(FORMAL_HEALTH_KEY)
    reportsRaw = uni.getStorageSync(FORMAL_REPORTS_KEY)
  } catch (e) {
    // 无法读取原始数据时不写完成标记，下次重试
    console.error('ensureLegacyBackup: read failed, will retry:', e)
    return null
  }

  const marker = _readMarker()
  const needHealthBackup = Boolean(healthRaw) && !(marker && marker.health_backup)
  const needReportsBackup = Boolean(reportsRaw) && !(marker && marker.reports_backup)
  if (!needHealthBackup && !needReportsBackup) {
    return null
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const healthBackupKey = needHealthBackup ? `MOMCARE_BACKUP_HEALTH_${stamp}` : (marker && marker.health_backup) || ''
  const reportsBackupKey = needReportsBackup ? `MOMCARE_BACKUP_REPORTS_${stamp}` : (marker && marker.reports_backup) || ''

  try {
    if (needHealthBackup) {
      uni.setStorageSync(healthBackupKey, healthRaw)
    }
    if (needReportsBackup) {
      uni.setStorageSync(reportsBackupKey, reportsRaw)
    }
  } catch (e) {
    // 任一备份写入失败：不写完成标记，下次启动重试
    console.error('ensureLegacyBackup: write failed, will retry:', e)
    return null
  }

  try {
    uni.setStorageSync(LEGACY_BACKUP_MARKER, JSON.stringify({
      created_at: new Date().toISOString(),
      health_backup: healthBackupKey,
      reports_backup: reportsBackupKey,
      note: '升级到数据模式隔离版本前的原始数据快照，内容未删改'
    }))
  } catch (e) {
    console.error('ensureLegacyBackup: marker write failed, will retry:', e)
    return null
  }
  return healthBackupKey || reportsBackupKey || null
}

// 为“清除本机数据”创建正式数据备份；全部存在数据集备份成功才返回 ok。
// 任一写入失败返回 { ok: false }，调用方不得执行清除
export function createFormalBackups() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let healthKey = ''
  let reportsKey = ''
  try {
    const healthRaw = uni.getStorageSync(FORMAL_HEALTH_KEY)
    if (healthRaw) {
      healthKey = `MOMCARE_BACKUP_HEALTH_${stamp}`
      uni.setStorageSync(healthKey, healthRaw)
    }
    const reportsRaw = uni.getStorageSync(FORMAL_REPORTS_KEY)
    if (reportsRaw) {
      reportsKey = `MOMCARE_BACKUP_REPORTS_${stamp}`
      uni.setStorageSync(reportsKey, reportsRaw)
    }
    return { ok: true, healthKey, reportsKey }
  } catch (e) {
    console.error('createFormalBackups failed:', e)
    return { ok: false, healthKey, reportsKey }
  }
}

// 列出本机全部可恢复备份（键名），供隐私页展示
export function listLegacyBackups() {
  const backups = []
  try {
    const info = uni.getStorageInfoSync()
    for (const key of info.keys || []) {
      if (/^MOMCARE_BACKUP_HEALTH_/.test(key)) {
        backups.push({ key, type: 'health' })
      } else if (/^MOMCARE_BACKUP_REPORTS_/.test(key)) {
        backups.push({ key, type: 'reports' })
      }
    }
  } catch (e) {
    console.warn('listLegacyBackups failed:', e)
  }
  return backups
}
