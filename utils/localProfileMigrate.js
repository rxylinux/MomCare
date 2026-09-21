// 本地资料迁移（未确认身份时期保存在本机的孕期资料 → 家庭云端档案）。
//
// 背景：身份未确认时孕期资料页走 healthStore 本地分支（只存本机 storage），
// 确认身份后所有家庭视图改读云端——本地那份从界面上"消失"。本模块提供
// 检测与映射，把本机资料经正常保存链路（familyStore.savePregnancy，基线 0
// 首建）迁入云端；本机数据只读不删。
//
// canOffer 四条件（全部满足才引导）：
//   1. 会话已确认（family 模式；演示/退出态由调用方排除）
//   2. 云端无孕期档案（familyStore.pregnancy 为 null）
//   3. 本会话完成过全量拉取（lastFullSyncAt 非空——冷启动快照恢复后
//      pregnancy 为 null 不代表云端为空；已知的边界：快照里残留的旧
//      lastFullSyncAt 会让卡片在 pullAll 往返期间短暂可见，若期间对端
//      已建档，迁入提交会收到 revision-conflict 由既有冲突流程兜底）
//   4. 用户未点过"暂不"（本家庭作用域 declined 标记）
//
// 字段映射规则与 pregnancy-info.vue 的 formPayload 一致：字符串 trim、
// 空值不提交（云端首建语义下"没填"≠"显式清空"）、Date → YYYY-MM-DD。

import { CLOUD_CONFIG } from '@/utils/cloudConfig.js'

const DECLINED_PREFIX = 'mc_profile_migrate_declined'

// 作用域与 B1 缓存键同形：env/AppID/family 三重隔离（同成员重确认进
// 不同家庭不串标记；换环境不误吞）
export function declinedKey(familyId) {
	return `${DECLINED_PREFIX}_${CLOUD_CONFIG.envId}_${CLOUD_CONFIG.appId}_${familyId}`
}

export function isDeclined(familyId) {
	try {
		return Boolean(uni.getStorageSync(declinedKey(familyId)))
	} catch (e) {
		return false
	}
}

export function markDeclined(familyId) {
	try {
		uni.setStorageSync(declinedKey(familyId), JSON.stringify({ declinedAt: Date.now() }))
		return true
	} catch (e) {
		return false
	}
}

// Date → YYYY-MM-DD（取本地日分量，与 pregnancy-info.vue formatDate 同语义）
function toDateKey(d) {
	if (!d || typeof d !== 'object' || typeof d.getTime !== 'function') return null
	if (Number.isNaN(d.getTime())) return null
	const y = d.getFullYear()
	const m = String(d.getMonth() + 1).padStart(2, '0')
	const day = String(d.getDate()).padStart(2, '0')
	return `${y}-${m}-${day}`
}

// 本地快照 { userInfo, lmpDate, dueDate } → pregnancy.fields 局部载荷
export function buildPayload(localProfile) {
	const ui = (localProfile && localProfile.userInfo) || {}
	const p = {}
	const str = (key, v) => {
		const t = typeof v === 'string' ? v.trim() : ''
		if (t !== '') p[key] = t
	}
	str('nickname', ui.nickname)
	str('babyNickname', ui.babyNickname)
	str('hospital', ui.hospital)
	str('doctor', ui.doctor)
	str('hospitalPhone', ui.hospitalPhone)
	// Number('') === 0：空串/缺省必须先排除，非法数字（NaN）同样不提交
	if (ui.preWeight !== '' && ui.preWeight != null) {
		const w = Number(ui.preWeight)
		if (Number.isFinite(w)) p.preWeightKg = w
	}
	if (ui.height !== '' && ui.height != null) {
		const h = Number(ui.height)
		if (Number.isFinite(h)) p.heightCm = h
	}
	const lmp = toDateKey(localProfile && localProfile.lmpDate)
	if (lmp) p.lmpDate = lmp
	const due = toDateKey(localProfile && localProfile.dueDate)
	if (due) p.dueDate = due
	return p
}

export function hasLocalContent(payload) {
	return Object.keys(payload || {}).length > 0
}

// 纯判定（declined 由调用方读好传入，便于单测）：四条件见文件头注释
export function canOffer({ sessionConfirmed, pregnancy, lastFullSyncAt, payload, declined }) {
	if (!sessionConfirmed) return false
	if (pregnancy) return false
	if (!lastFullSyncAt) return false
	if (declined) return false
	return hasLocalContent(payload)
}
