<template>
	<view class="page">
		<NavBar title="家庭共享（云）" />

		<scroll-view scroll-y class="scroll-content">
			<!-- 配置/平台状态 -->
			<view v-if="runtimeState === 'not-configured'" class="notice-card">
				<text class="notice-title">云环境尚未配置</text>
				<text class="notice-desc">小程序云开发环境 ID / AppID 尚未填写（utils/cloudConfig.js），并由管理员完成成员白名单配置。配置完成前本页功能不可用，不会伪造连接成功，也不会回退到旧服务。</text>
				<text class="notice-desc">如需先了解界面，可使用独立的演示模式。</text>
				<view class="notice-btn" @tap="goDemo"><text class="notice-btn-text">了解演示模式</text></view>
			</view>

			<view v-else-if="runtimeState === 'unavailable-platform'" class="notice-card">
				<text class="notice-title">当前平台不支持云调用</text>
				<text class="notice-desc">云能力仅在微信小程序端可用；当前为开发预览平台，不伪装连接。</text>
			</view>

			<template v-else>
				<!-- 身份区 -->
				<view class="section-card">
					<view v-if="session.status === 'confirmed'" class="identity-row">
						<text class="identity-badge">{{ session.member.displayName }}</text>
						<view class="identity-info">
							<text class="identity-title">已确认身份：{{ session.member.displayName }}</text>
							<text class="identity-sub">家庭成员 · 固定家庭档案</text>
						</view>
						<view class="link-btn" @tap="handleConfirm(true)"><text class="link-btn-text">刷新</text></view>
					</view>
					<view v-else-if="session.status === 'rejected'" class="identity-row">
						<text class="identity-badge locked">已锁定</text>
						<view class="identity-info">
							<text class="identity-title">无法确认家庭成员身份</text>
							<text class="identity-sub">{{ rejectText }}</text>
						</view>
					</view>
					<view v-else class="identity-row">
						<text class="identity-badge">待确认</text>
						<view class="identity-info">
							<text class="identity-title">联网确认身份后可用</text>
							<text class="identity-sub">冷启动不展示任何成员缓存，确认后加载</text>
						</view>
						<view class="notice-btn" @tap="handleConfirm(false)"><text class="notice-btn-text">确认身份</text></view>
					</view>

					<!-- 设置期：自取 OpenID（仅显示自己的） -->
					<view v-if="showOpenidSetup" class="openid-row">
						<text class="openid-text" selectable user-select>{{ myOpenid }}</text>
						<text class="openid-hint">这是你的 OpenID（只显示你自己的）。设置期把它抄送管理员配置成员白名单。</text>
					</view>
					<view v-if="runtimeReady && session.status !== 'confirmed'" class="link-btn" @tap="handleMyOpenid">
						<text class="link-btn-text">{{ myOpenid ? '刷新我的 OpenID' : '查看我的 OpenID（设置期）' }}</text>
					</view>
				</view>

				<!-- 共享数字记录 -->
				<view class="section-card" v-if="session.status === 'confirmed'">
					<text class="card-title">今日共享记录 · {{ todayKey }}</text>
					<text class="card-sub">体重、血压等数字两人共享；本页为 B1 最小接入</text>

					<view class="field-row">
						<text class="field-label">体重 (kg)</text>
						<input class="field-input" type="digit" v-model="sharedInput.weightKg" placeholder="如 58.5" placeholder-class="ph" />
					</view>
					<view class="field-row" v-if="sharedRecord">
						<text class="field-meta">当前版本 r{{ sharedRecord.revision }} · 最后由{{ sharedRecord.updatedBy === 'mama' ? '妈妈' : '爸爸' }}更新</text>
					</view>
					<text v-if="sharedMsg" class="field-msg" :class="{ 'field-msg-warn': sharedMsgWarn }">{{ sharedMsg }}</text>

					<view class="btn-row">
						<view class="secondary-btn" @tap="loadShared"><text class="secondary-btn-text">刷新</text></view>
						<view class="primary-btn" :class="{ disabled: savingShared }" @tap="handleSaveShared">
							<text class="primary-btn-text">{{ savingShared ? '保存中…' : '保存共享记录' }}</text>
						</view>
					</view>
				</view>

				<!-- 本人私人笔记 -->
				<view class="section-card" v-if="session.status === 'confirmed'">
					<text class="card-title">我的私人笔记 · 仅本人可见</text>
					<textarea class="note-textarea" v-model="privateInput" placeholder="只写给自己看的内容（另一成员任何接口都读不到）" placeholder-class="ph" :maxlength="2000" />

					<text v-if="privateMsg" class="field-msg" :class="{ 'field-msg-warn': privateMsgWarn }">{{ privateMsg }}</text>

					<view class="btn-row">
						<view class="secondary-btn" @tap="loadPrivate"><text class="secondary-btn-text">刷新</text></view>
						<view class="primary-btn" :class="{ disabled: savingPrivate }" @tap="handleSavePrivate">
							<text class="primary-btn-text">{{ savingPrivate ? '保存中…' : '保存私人笔记' }}</text>
						</view>
					</view>
				</view>

				<!-- 文件：服务端开关驱动的真实上传闭环（默认关闭，如实展示） -->
				<view class="section-card" v-if="session.status === 'confirmed'">
					<text class="card-title">报告文件</text>
					<text class="card-sub">{{ filePolicyText }}</text>

					<template v-if="uploadEnabled">
						<view v-if="uploadedImageUrl" class="uploaded-preview">
							<image :src="uploadedImageUrl" mode="aspectFit" class="uploaded-img" @tap="previewUploaded" />
							<text class="field-meta">已登记正式副本（点击预览；登记 ID：{{ registeredFileId || '—' }}）</text>
						</view>

						<!-- 待上传待办：重试继续同一文件；换新图须显式放弃本次待办 -->
						<view v-if="pendingUploadInfo" class="pending-box">
							<text class="pending-text">有待上传文件（{{ pendingUploadInfo.savedFilePath }}），重试将继续同一文件，不会重新选图。</text>
							<view class="btn-row">
								<view class="secondary-btn" @tap="discardPendingUpload">
									<text class="secondary-btn-text">放弃并重选</text>
								</view>
								<view class="primary-btn" :class="{ disabled: uploading }" @tap="handleUploadImage">
									<text class="primary-btn-text">{{ uploading ? '上传中…' : '继续上传' }}</text>
								</view>
							</view>
						</view>

						<view v-else class="btn-row">
							<view class="primary-btn" :class="{ disabled: uploading }" @tap="handleUploadImage">
								<text class="primary-btn-text">{{ uploading ? '上传中…' : '拍照/选图上传报告' }}</text>
							</view>
						</view>
						<text v-if="uploadMsg" class="field-msg" :class="{ 'field-msg-warn': uploadMsgWarn }">{{ uploadMsg }}</text>
					</template>
				</view>
			</template>

			<view class="bottom-spacer"></view>
		</scroll-view>
	</view>
</template>

<script setup>
import { ref, computed } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import NavBar from '@/components/NavBar.vue'
import { cloudRuntimeState } from '@/services/cloudAdapter.js'
import {
	confirmIdentity, fetchMyOpenid, getSessionState, familyCall, currentEpoch,
	stashDraft, mergeDraft, pendingDrafts, clearDraftFields,
	getMemberCache, setMemberCache,
	savePendingUpload, getPendingUpload, clearPendingUpload
} from '@/services/sessionService.js'

const runtimeState = ref(cloudRuntimeState())
const runtimeReady = computed(() => runtimeState.value === 'ready' || runtimeState.value === 'ready-to-init')

const session = ref(getSessionState())
const myOpenid = ref('')
const showOpenidSetup = ref(false)

const todayKey = (() => {
	const d = new Date()
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})()

const SHARED_CACHE_KEY = `shared-daily-${todayKey}`
const PRIVATE_CACHE_KEY = `private-${todayKey}`

const sharedInput = ref({ weightKg: '' })
const sharedRecord = ref(null)
const sharedMsg = ref('')
const sharedMsgWarn = ref(false)
const savingShared = ref(false)
let sharedOpId = '' // 同一逻辑操作跨重试保持不变；成功后换新

const privateInput = ref('')
const privateMsg = ref('')
const privateMsgWarn = ref(false)
const savingPrivate = ref(false)
let privateOpId = ''
let privateExpectedRevision = null

const uploadEnabled = ref(false)
const uploading = ref(false)
const uploadMsg = ref('')
const uploadMsgWarn = ref(false)
const uploadedImageUrl = ref('')
const registeredFileId = ref('')
let lastUploadId = ''

const filePolicyText = ref('')

const rejectText = computed(() => {
	if (session.value.rejectCode === 'not-family-member') return '仅限本家庭成员使用（白名单未包含此微信）'
	if (session.value.rejectCode === 'wrong-appid') return 'AppID 与服务端配置不符'
	if (session.value.rejectCode === 'not-configured') return '服务端成员白名单尚未配置'
	return '身份确认失败'
})

function newOpId(prefix) {
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

// 业务调用的授权失败处理（权威状态来自 sessionService，页面只观察与执行）：
// - 'stale-session'/纪元变化 → 返回 'stale'：零变更（当前 UI 属于更新的有效成员）
// - 明确身份拒绝（not-family-member 等 / locked 标记）→ 立即锁定页面：
//   同步会话状态、清理敏感内存、给出锁定说明，不等待下一次确认
function handleAuthFailure(res, epochAtStart) {
	// 身份拒绝优先：拒绝响应是权威锁定（familyCall 锁定时会推进纪元），
	// 不属于"更新有效成员的迟到回调"，必须立即同步并清屏
	const refusal = res.locked || ['not-family-member', 'wrong-appid', 'unauthenticated', 'not-configured'].includes(res.code)
	if (refusal) {
		session.value = getSessionState()
		clearSensitiveMemory()
		lastConfirmedMemberId = null
		sharedMsg.value = '身份被服务端拒绝，会话已锁定；请重新确认身份或联系管理员'
		sharedMsgWarn.value = true
		privateMsg.value = ''
		uploadMsg.value = ''
		return 'locked'
	}
	if (res.code === 'stale-session' || (epochAtStart !== undefined && currentEpoch() !== epochAtStart)) {
		return 'stale'
	}
	return null
}

// 上一个已确认成员：身份更换（含明确拒绝）必须清理组件内敏感内容——
// 输入框/版本游标/操作 ID/预览与登记号都属于前身份的会话内存。
// 草稿与待上传持久化在各自成员命名空间，不受清理影响（保留在原身份下）。
let lastConfirmedMemberId = null

function clearSensitiveMemory() {
	privateInput.value = ''
	sharedInput.value = { weightKg: '' }
	sharedRecord.value = null
	privateExpectedRevision = null
	sharedOpId = ''
	privateOpId = ''
	uploadedImageUrl.value = ''
	registeredFileId.value = ''
	sharedMsg.value = ''
	privateMsg.value = ''
	uploadMsg.value = ''
	sharedMsgWarn.value = false
	privateMsgWarn.value = false
	uploadMsgWarn.value = false
	pendingUploadInfo.value = null
}

async function handleConfirm(manual) {
	const prevMember = lastConfirmedMemberId
	const res = await confirmIdentity()
	session.value = getSessionState()
	if (!res.ok) {
		// 暂时性网络失败：保持现状（未保存输入不丢、不清屏），可重试
		if (res.transient) {
			if (manual) uni.showToast({ title: '网络不可用，请稍后重试（输入已保留）', icon: 'none', duration: 2500 })
			return
		}
		// 明确拒绝/锁定：清理敏感内存（含上一身份残留输入）
		clearSensitiveMemory()
		lastConfirmedMemberId = null
		if (manual) uni.showToast({ title: rejectText.value, icon: 'none', duration: 2500 })
		return
	}
	// 身份更换（mama↔papa）：先清前身份内容再加载新身份数据
	if (prevMember && prevMember !== res.member.memberId) {
		clearSensitiveMemory()
	}
	lastConfirmedMemberId = res.member.memberId
	await Promise.all([loadShared(), loadPrivate(), loadUploadPolicy()])
	refreshPendingUpload()
	// 确认后检查本人离线草稿（会话服务按当前确认成员隔离，未确认时为 null）
	const draft = pendingDrafts()
	if (draft) {
		if (draft.weightKg !== undefined && draft.weightKg !== '') {
			sharedInput.value.weightKg = draft.weightKg
		}
		if (draft.privateNote !== undefined && draft.privateNote !== '') {
			privateInput.value = draft.privateNote
		}
		sharedMsg.value = '检测到本机暂存的未同步草稿，已恢复到输入框；保存成功后对应部分才会清除'
		sharedMsgWarn.value = false
	}
	if (manual) uni.showToast({ title: `已确认：${res.member.displayName}`, icon: 'none' })
}

async function handleMyOpenid() {
	const res = await fetchMyOpenid()
	if (res.ok) {
		myOpenid.value = res.data.openid
		showOpenidSetup.value = true
	} else {
		uni.showToast({ title: res.message || '获取失败', icon: 'none', duration: 2500 })
	}
}

// 读取共享记录：成员缓存先行（离线可恢复），云端成功后更新缓存。
// keepInput=true 时（冲突后刷新）只更新服务端版本展示，不覆盖用户输入。
// 身份更换时 handleConfirm 已先清空输入，此处回填的必然是新成员数据。
async function loadShared(keepInput = false) {
	if (session.value.status !== 'confirmed') return
	const cached = getMemberCache(SHARED_CACHE_KEY)
	if (cached && cached.record) {
		sharedRecord.value = cached.record
		if (!keepInput && (sharedInput.value.weightKg === '' || sharedInput.value.weightKg == null)) {
			sharedInput.value.weightKg = cached.record.payload.weightKg != null ? String(cached.record.payload.weightKg) : ''
		}
	}
	const epoch = currentEpoch()
	const res = await familyCall('mc-shared-records', { action: 'get', type: 'daily', dateKey: todayKey })
	if (!res.ok) {
		const outcome = handleAuthFailure(res, epoch)
		if (outcome) return // stale 零变更 / locked 已清屏
		if (!cached) {
			sharedMsg.value = `读取失败：${res.message || res.code}（如有本机缓存将优先展示）`
			sharedMsgWarn.value = true
		}
		return
	}
	setMemberCache(SHARED_CACHE_KEY, { record: res.data.record }, epoch)
	sharedRecord.value = res.data.record
	if (!keepInput && (sharedInput.value.weightKg === '' || sharedInput.value.weightKg == null)) {
		sharedInput.value.weightKg = res.data.record && res.data.record.payload.weightKg != null
			? String(res.data.record.payload.weightKg)
			: ''
	}
	sharedMsg.value = ''
}

async function handleSaveShared() {
	if (savingShared.value) return
	const weight = Number(sharedInput.value.weightKg)
	if (!Number.isFinite(weight) || weight <= 0) {
		sharedMsg.value = '请输入有效体重'
		sharedMsgWarn.value = true
		return
	}
	savingShared.value = true
	if (!sharedOpId) sharedOpId = newOpId('shr')
	const expected = sharedRecord.value ? sharedRecord.value.revision : 0
	// 竞态防护：捕获发起纪元；提交前先把内容预暂存到【原成员】名下——
	// 即使确认期间身份切换，草稿也不会落到新身份
	const epochAtStart = currentEpoch()
	const stashedOk = mergeDraft({ weightKg: sharedInput.value.weightKg })
	const res = await familyCall('mc-shared-records', {
		action: 'upsert',
		type: 'daily',
		dateKey: todayKey,
		payload: { weightKg: weight },
		expectedRevision: expected,
		operationId: sharedOpId
	})
	savingShared.value = false
	// 迟到响应（零变更）或业务身份拒绝（立即锁定清屏）
	const authOutcome = handleAuthFailure(res, epochAtStart)
	if (authOutcome === 'stale' || authOutcome === 'locked') return
	if (res.ok) {
		sharedRecord.value = res.data.record
		setMemberCache(SHARED_CACHE_KEY, { record: res.data.record })
		sharedOpId = '' // 成功后下一逻辑操作用新 ID
		sharedMsg.value = res.data.replayed ? '已保存（重复提交幂等重放）' : '已保存并共享'
		sharedMsgWarn.value = false
		// 只清草稿中的共享部分；未同步的私人笔记保留
		clearDraftFields('weightKg')
		return
	}
	if (res.code === 'revision-conflict') {
		// fail 载荷在顶层；只刷新服务端版本展示，用户输入原样保留。
		// 先刷新（会清常规消息）、后写冲突提示，保证提示可见
		await loadShared(true)
		sharedMsg.value = `已被对方更新（当前 r${res.currentRevision}），“刷新”查看最新值后再保存；你的输入未丢失`
		sharedMsgWarn.value = true
		return
	}
	// 网络类失败：按实际暂存结果如实报告
	sharedMsg.value = stashedOk
		? `保存失败（${res.message || res.code}）；输入已暂存到本机，恢复网络后重试`
		: `保存失败（${res.message || res.code}）；本机暂存也未成功，内容仅保留在输入框，请释放空间后重试`
	sharedMsgWarn.value = true
}

// 读取私人笔记：成员缓存先行，云端成功后更新缓存
async function loadPrivate(keepInput = false) {
	if (session.value.status !== 'confirmed') return
	const cached = getMemberCache(PRIVATE_CACHE_KEY)
	if (cached && cached.note) {
		privateExpectedRevision = cached.note.revision
		if (!keepInput && privateInput.value === '') {
			privateInput.value = cached.note.content
		}
	}
	const epoch = currentEpoch()
	const res = await familyCall('mc-private-notes', { action: 'get', dateKey: todayKey })
	if (!res.ok) {
		const outcome = handleAuthFailure(res, epoch)
		if (outcome) return
		if (!cached) {
			privateMsg.value = `读取失败：${res.message || res.code}`
			privateMsgWarn.value = true
		}
		return
	}
	setMemberCache(PRIVATE_CACHE_KEY, { note: res.data.note }, epoch)
	if (res.data.note) {
		privateExpectedRevision = res.data.note.revision
		if (!keepInput && privateInput.value === '') {
			privateInput.value = res.data.note.content
		}
	} else {
		privateExpectedRevision = 0
	}
	privateMsg.value = ''
}

async function handleSavePrivate() {
	if (savingPrivate.value) return
	const content = String(privateInput.value || '').trim()
	if (!content) {
		privateMsg.value = '内容不能为空'
		privateMsgWarn.value = true
		return
	}
	savingPrivate.value = true
	if (!privateOpId) privateOpId = newOpId('prv')
	// 竞态防护：捕获发起纪元；提交前按原成员预暂存私人内容
	const epochAtStart = currentEpoch()
	const stashedOk = mergeDraft({ privateNote: content })
	const res = await familyCall('mc-private-notes', {
		action: 'upsert',
		dateKey: todayKey,
		content,
		expectedRevision: privateExpectedRevision,
		operationId: privateOpId
	})
	savingPrivate.value = false
	// 迟到响应（零变更）或业务身份拒绝（立即锁定清屏）
	const authOutcome = handleAuthFailure(res, epochAtStart)
	if (authOutcome === 'stale' || authOutcome === 'locked') return
	if (res.ok) {
		privateExpectedRevision = res.data.note.revision
		setMemberCache(PRIVATE_CACHE_KEY, { note: res.data.note })
		privateOpId = ''
		privateMsg.value = '已保存（仅本人可见）'
		privateMsgWarn.value = false
		// 只清草稿中的私人部分；未同步的共享输入保留
		clearDraftFields('privateNote')
		return
	}
	if (res.code === 'revision-conflict') {
		privateMsg.value = '笔记已被修改（可能你在其他设备更新过），“刷新”查看最新内容；你的输入未丢失'
		privateMsgWarn.value = true
		return
	}
	// 网络类失败：按【实际暂存结果】如实报告——mergeDraft 失败时不得声称"已暂存"
	privateMsg.value = stashedOk
		? `保存失败（${res.message || res.code}）；内容已暂存到本机，恢复网络后重试`
		: `保存失败（${res.message || res.code}）；本机暂存也未成功，内容仅保留在输入框，请释放空间后重试`
	privateMsgWarn.value = true
}

// 文件闭环：策略（服务端开关）→ 选图 → prepareUpload（服务端下发本人暂存路径）
// → wx.cloud.uploadFile 直传暂存 → registerStaged（服务端校验/转存/登记）→ 授权读取
async function loadUploadPolicy() {
	const res = await familyCall('mc-files', { action: 'uploadPolicy' })
	if (!res.ok) {
		if (handleAuthFailure(res)) return
		filePolicyText.value = `上传策略读取失败：${res.message || res.code}`
		return
	}
	uploadEnabled.value = Boolean(res.data.clientUploadEnabled)
	filePolicyText.value = uploadEnabled.value
		? '上传已启用：图片将先存入你的个人暂存目录，服务端校验后登记为正式副本（两人共享查看）'
		: (res.data.reason || '上传通道未启用')
}

// 待上传状态：uploadId + 持久化本地文件路径（uni.saveFile 副本，非临时路径）。
// 绑定当前确认成员持久保存（sessionService），重试继续同一文件；
// 换新图必须显式"放弃并重选"（新 uploadId），不得换内容复用旧 ID。
const pendingUploadInfo = ref(null)

function refreshPendingUpload() {
	pendingUploadInfo.value = getPendingUpload()
}

// 将临时选图复制为持久文件（CLOUDBASE_PLAN 4.1：待上传附件须持久保存）
function persistFile(filePath) {
	return new Promise(resolve => {
		// #ifdef MP-WEIXIN
		uni.saveFile({
			tempFilePath: filePath,
			success: r => resolve({ ok: true, path: r.savedFilePath }),
			fail: () => resolve({ ok: false })
		})
		// #endif
		/* #ifndef MP-WEIXIN */
		resolve({ ok: false, unsupported: true })
		/* #endif */
	})
}

async function handleUploadImage() {
	if (uploading.value) return
	const pending = getPendingUpload()
	if (pending) {
		// 重试：继续同一待办文件（不重新选图，不改 uploadId）
		uploadMsg.value = '继续上传待办文件…'
		uploadMsgWarn.value = false
		await performUpload(pending)
		return
	}
	try {
		const choose = await new Promise((resolve, reject) => {
			uni.chooseImage({
				count: 1,
				sizeType: ['compressed'],
				success: resolve,
				fail: reject
			})
		})
		const tempPath = choose.tempFilePaths && choose.tempFilePaths[0]
		if (!tempPath) return

		const persisted = await persistFile(tempPath)
		if (!persisted.ok) {
			// 持久化失败不得显示"已暂存"，也不建立待办
			uploadMsg.value = '本机无法持久保存该图片（未建立待上传），请重试'
			uploadMsgWarn.value = true
			return
		}

		const uploadId = newOpId('up')
		const savedOk = savePendingUpload({ uploadId, savedFilePath: persisted.path, stageFileID: '' })
		if (!savedOk) {
			uploadMsg.value = '待上传状态保存失败（未暂存），请重试'
			uploadMsgWarn.value = true
			return
		}
		refreshPendingUpload()
		uploadMsg.value = '已建立待上传（本机持久副本），开始上传…'
		uploadMsgWarn.value = false
		await performUpload(getPendingUpload())
	} catch (e) {
		if (e && e.errMsg && e.errMsg.includes('cancel')) return
		uploadMsg.value = `选择图片失败：${(e && (e.errMsg || e.message)) || '未知错误'}`
		uploadMsgWarn.value = true
	}
}

async function performUpload(pending) {
	uploading.value = true
	const epochAtStart = currentEpoch()
	try {
		const prepared = await familyCall('mc-files', { action: 'prepareUpload', uploadId: pending.uploadId })
		const preparedOutcome = handleAuthFailure(prepared, epochAtStart)
		if (preparedOutcome) {
			uploading.value = false
			return // stale：待办保留原成员；locked：页面已清屏
		}
		if (!prepared.ok) {
			uploadMsg.value = `无法获取上传路径：${prepared.message || prepared.code}（待上传已保留，可重试）`
			uploadMsgWarn.value = true
			return
		}

		// #ifdef MP-WEIXIN
		const uploaded = await new Promise((resolve, reject) => {
			wx.cloud.uploadFile({
				cloudPath: prepared.data.cloudPath,
				filePath: pending.savedFilePath,
				success: resolve,
				fail: reject
			})
		})
		// #endif
		/* #ifndef MP-WEIXIN */
		uploadMsg.value = '上传仅在微信小程序端可用（待上传已保留）'
		uploadMsgWarn.value = true
		return
		/* #endif */

		const reg = await familyCall('mc-files', {
			action: 'registerStaged',
			stageFileID: uploaded.fileID,
			uploadId: pending.uploadId
		})
		const regOutcome = handleAuthFailure(reg, epochAtStart)
		if (regOutcome) {
			uploading.value = false
			return
		}
		if (!reg.ok) {
			if (reg.code === 'staged-file-unreadable') {
				// 暂存已过期：待办作废，需要重新选图（新 uploadId）
				clearPendingUpload()
				refreshPendingUpload()
				uploadMsg.value = '暂存文件已过期，请重新选择图片上传'
				uploadMsgWarn.value = true
				return
			}
			uploadMsg.value = `登记失败：${reg.message || reg.code}（待上传已保留，可直接重试同一文件）`
			uploadMsgWarn.value = true
			return
		}
		registeredFileId.value = reg.data.file.fileId
		clearPendingUpload()
		refreshPendingUpload()
		uploadMsg.value = reg.data.replayed ? '登记完成（重复确认幂等，结果为同一文件）' : '登记完成'
		uploadMsgWarn.value = false
		await previewRegistered()
	} catch (e) {
		uploadMsg.value = `上传失败：${(e && (e.errMsg || e.message)) || '未知错误'}（待上传已保留，可重试同一文件）`
		uploadMsgWarn.value = true
	} finally {
		uploading.value = false
	}
}

// 显式放弃当前待上传（之后可选新图 = 新 uploadId 新操作）
function discardPendingUpload() {
	const pending = getPendingUpload()
	if (!pending) return
	clearPendingUpload()
	// 尽力清理持久副本文件
	try {
		// #ifdef MP-WEIXIN
		uni.removeSavedFile({ filePath: pending.savedFilePath })
		// #endif
	} catch (e) { /* 忽略 */ }
	refreshPendingUpload()
	uploadMsg.value = '已放弃待上传；重新选择图片将作为新上传'
	uploadMsgWarn.value = false
}

async function previewRegistered() {
	if (!registeredFileId.value) return
	const res = await familyCall('mc-files', { action: 'getReadUrl', fileId: registeredFileId.value })
	if (res.ok) {
		uploadedImageUrl.value = res.data.tempFileURL
	} else {
		uploadMsg.value = `读取预览失败：${res.message || res.code}`
		uploadMsgWarn.value = true
	}
}

function previewUploaded() {
	if (uploadedImageUrl.value) {
		uni.previewImage({ urls: [uploadedImageUrl.value] })
	}
}

function goDemo() {
	// login 不是 tab 页：用 redirectTo 进入现有演示选择流程
	uni.redirectTo({ url: '/pages/login/index' })
}

onShow(() => {
	runtimeState.value = cloudRuntimeState()
	session.value = getSessionState()
	// 已确认过的会话：回到页面时自动重新确认（回前台重新校验身份）
	if (runtimeReady.value && session.value.status === 'unconfirmed') {
		handleConfirm(false)
	}
})
</script>

<style scoped lang="scss">
.page {
	display: flex;
	flex-direction: column;
	height: 100vh;
	background-color: #FBF7F2;
}

.scroll-content { flex: 1; }

.notice-card {
	margin: 24rpx;
	background: #FFFFFF;
	border-radius: 24rpx;
	padding: 32rpx;
	box-shadow: 0 4rpx 28rpx rgba(60, 30, 10, 0.07);
}

.notice-title {
	display: block;
	font-size: 30rpx;
	font-weight: 600;
	color: #1C1A17;
	margin-bottom: 12rpx;
}

.notice-desc {
	display: block;
	font-size: 24rpx;
	color: #757575;
	line-height: 1.7;
	margin-bottom: 8rpx;
}

.notice-btn {
	display: inline-flex;
	margin-top: 16rpx;
	background: #FDEEF1;
	border: 2rpx solid #F8BBD0;
	border-radius: 999rpx;
	padding: 14rpx 32rpx;
}

.notice-btn-text {
	font-size: 24rpx;
	color: #C2185B;
	font-weight: 600;
}

.section-card {
	margin: 20rpx 24rpx 0;
	background: #FFFFFF;
	border-radius: 24rpx;
	padding: 28rpx;
	box-shadow: 0 4rpx 28rpx rgba(60, 30, 10, 0.07);
}

.card-title {
	display: block;
	font-size: 28rpx;
	font-weight: 600;
	color: #1C1A17;
	margin-bottom: 6rpx;
}

.card-sub {
	display: block;
	font-size: 22rpx;
	color: #9C9890;
	margin-bottom: 20rpx;
}

.identity-row {
	display: flex;
	align-items: center;
	gap: 20rpx;
}

.identity-badge {
	flex-shrink: 0;
	background: #EAF7EF;
	color: #2E7D32;
	border-radius: 12rpx;
	padding: 10rpx 18rpx;
	font-size: 24rpx;
	font-weight: 600;
}

.identity-badge.locked {
	background: #FDEAEA;
	color: #C62828;
}

.identity-info { flex: 1; }

.identity-title {
	display: block;
	font-size: 26rpx;
	font-weight: 600;
	color: #1C1A17;
}

.identity-sub {
	display: block;
	font-size: 22rpx;
	color: #9C9890;
	margin-top: 4rpx;
	line-height: 1.5;
}

.openid-row {
	margin-top: 20rpx;
	background: #FAF9F8;
	border-radius: 16rpx;
	padding: 20rpx;
}

.openid-text {
	display: block;
	font-size: 24rpx;
	color: #1C1A17;
	word-break: break-all;
	user-select: text;
}

.openid-hint {
	display: block;
	font-size: 20rpx;
	color: #9C9890;
	margin-top: 8rpx;
	line-height: 1.6;
}

.link-btn { padding: 12rpx; }

.link-btn-text {
	font-size: 24rpx;
	color: #C2185B;
	font-weight: 600;
}

.field-row {
	display: flex;
	align-items: center;
	gap: 20rpx;
	margin-bottom: 16rpx;
}

.field-label {
	flex-shrink: 0;
	font-size: 26rpx;
	color: #4A4844;
	width: 140rpx;
}

.field-input {
	flex: 1;
	height: 80rpx;
	background: #F5F2EF;
	border-radius: 16rpx;
	padding: 0 24rpx;
	font-size: 28rpx;
	color: #1C1A17;
}

.ph { color: #C8C2BC; }

.field-meta {
	font-size: 22rpx;
	color: #9C9890;
}

.field-msg {
	display: block;
	font-size: 22rpx;
	color: #2E7D32;
	margin: 8rpx 0 12rpx;
	line-height: 1.6;
}

.field-msg-warn { color: #B07818; }

.note-textarea {
	width: 100%;
	min-height: 160rpx;
	background: #F5F2EF;
	border-radius: 16rpx;
	padding: 20rpx;
	font-size: 26rpx;
	color: #1C1A17;
	box-sizing: border-box;
	margin-bottom: 8rpx;
}

.uploaded-preview {
	margin-top: 16rpx;
}

.uploaded-img {
	width: 100%;
	height: 320rpx;
	border-radius: 16rpx;
	background: #F5F2EF;
}

.pending-box {
	margin-top: 16rpx;
	background: #FEF4E3;
	border: 2rpx solid rgba(240, 169, 64, 0.4);
	border-radius: 16rpx;
	padding: 20rpx;
}

.pending-text {
	display: block;
	font-size: 22rpx;
	color: #B07818;
	line-height: 1.6;
	margin-bottom: 8rpx;
	word-break: break-all;
}

.btn-row {
	display: flex;
	gap: 20rpx;
	margin-top: 16rpx;
}

.secondary-btn {
	flex: 1;
	height: 80rpx;
	border-radius: 999rpx;
	background: #F2F0EE;
	display: flex;
	align-items: center;
	justify-content: center;
}

.secondary-btn-text {
	font-size: 26rpx;
	color: #6E6A64;
	font-weight: 500;
}

.primary-btn {
	flex: 2;
	height: 80rpx;
	border-radius: 999rpx;
	background: linear-gradient(135deg, #E8637A, #C2185B);
	display: flex;
	align-items: center;
	justify-content: center;
}

.primary-btn.disabled { opacity: 0.5; }

.primary-btn-text {
	font-size: 26rpx;
	color: #FFFFFF;
	font-weight: 600;
}

.bottom-spacer { height: 60rpx; }
</style>
