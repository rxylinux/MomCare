// 每日推送攒配额：uni.requestSubscribeMessage 每授权一次只能收一条推送，且
// 必须由用户点按手势触发（本工具只允许在 tap 回调里调用——挂点：首页问候卡、
// RecordEditSheet 保存）。
//
// 体验设计：
// - 首次弹窗勾"总是保持以上选择，不再询问"后，后续每次调用完全静默、各攒 1 条
//   配额（双挂点高频点按，日常使用即持续攒）；
// - 防打扰：当日已弹过且未获授权 → 当天不再弹（storage 记日期）；一旦
//   accepted，不再受当日限流（静默攒配额无感知）；
// - 模板未配置（pushConfig 空串）整体 no-op——控制台选好模板前不干扰用户。
// 失败/拒绝一律静默返回（{ok:false,...}），绝不弹 toast 打断主流程。

import { PUSH_TEMPLATE_ID } from './pushConfig.js'

const STATE_KEY = 'push.sub.state'

function loadState() {
	try {
		const raw = uni.getStorageSync(STATE_KEY)
		return raw && typeof raw === 'object' ? raw : {}
	} catch (e) {
		return {}
	}
}

function saveState(state) {
	try {
		uni.setStorageSync(STATE_KEY, state)
	} catch (e) {
		// storage 不可用不影响主流程——最坏情况是多弹一次授权窗
	}
}

function todayKey() {
	const d = new Date()
	return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

export function requestPushSubscribe() {
	if (!PUSH_TEMPLATE_ID) {
		return Promise.resolve({ ok: false, code: 'template-unset' })
	}
	if (typeof uni === 'undefined' || typeof uni.requestSubscribeMessage !== 'function') {
		// 平台无此 API（如 H5）——静默 no-op，绝不打断宿主点按流程
		return Promise.resolve({ ok: false, code: 'unsupported-api' })
	}
	const today = todayKey()
	const state = loadState()
	if (state.promptDate === today && !state.accepted) {
		return Promise.resolve({ ok: false, code: 'nagged-today' })
	}
	return new Promise(resolve => {
		uni.requestSubscribeMessage({
			tmplIds: [PUSH_TEMPLATE_ID],
			success: res => {
				const decision = (res && res[PUSH_TEMPLATE_ID]) || ''
				const accepted = decision === 'accept'
				saveState({
					promptDate: today,
					accepted: accepted || Boolean(state.accepted)
				})
				resolve({ ok: accepted, decision })
			},
			fail: () => {
				// 弹窗失败也计入当日已尝试，避免反复打扰
				saveState({ ...state, promptDate: today })
				resolve({ ok: false, code: 'request-failed' })
			}
		})
	})
}
