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

				<!-- B2a：正式数据入口已迁移到首页/资料/趋势页；本页保留身份与配置诊断 -->
				<view class="section-card" v-if="session.status === 'confirmed'">
					<text class="card-title">数据与同步诊断</text>
					<text class="card-sub">正式健康记录、孕期资料与私人心情备注已在首页和相关页面直接读写（B2a 权威源）；此处仅展示同步状态。</text>
					<text class="identity-sub">最近完整同步：{{ diagText }}</text>
					<text class="identity-sub">待同步操作：{{ pendingCount }} 项{{ conflictCount > 0 ? '；冲突 ' + conflictCount + ' 项（相关页面处理）' : '' }}</text>
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
	confirmIdentity, fetchMyOpenid, getSessionState, familyCall, currentEpoch, isExplicitDemo,
	getMemberCache, setMemberCache,
	savePendingUpload, getPendingUpload, clearPendingUpload
} from '@/services/sessionService.js'
import { uploadSingleFile } from '@/services/fileUploadService.js'

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

const diagText = computed(() => {
	try {
		const fam = require('@/services/familyStore.js')
		void fam
	} catch (e) { /* 打包内不可用，占位 */ }
	return lastFullSyncAt.value ? new Date(lastFullSyncAt.value).toLocaleString() : '尚未完成'
})
const lastFullSyncAt = ref(null)
const pendingCount = ref(0)
const conflictCount = ref(0)

async function refreshDiagnostics() {
	try {
		const { useFamilyStore } = await import('@/services/familyStore.js')
		const fam = useFamilyStore()
		lastFullSyncAt.value = fam.lastFullSyncAt
		pendingCount.value = fam.pendingCount
		conflictCount.value = fam.conflictEntries.length
	} catch (e) {
		// 未确认身份等场景：保持默认展示
	}
}

function newOpId(prefix) {
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

// 业务调用的授权失败处理（上传路径仍使用）：
// - 身份拒绝优先 → 同步权威会话、清理上传/诊断展示（收敛后无编辑输入）
// - stale → 零变更（迟到响应不得影响新身份 UI）
function handleAuthFailure(res, epochAtStart) {
	const refusal = res.locked || ['not-family-member', 'wrong-appid', 'unauthenticated', 'not-configured'].includes(res.code)
	if (refusal) {
		session.value = getSessionState()
		uploadMsg.value = '身份被服务端拒绝，会话已锁定；请重新确认身份或联系管理员'
		uploadMsgWarn.value = true
		uploadedImageUrl.value = ''
		registeredFileId.value = ''
		pendingUploadInfo.value = null
		return 'locked'
	}
	if (res.code === 'stale-session' || (epochAtStart !== undefined && currentEpoch() !== epochAtStart)) {
		return 'stale'
	}
	return null
}

// 上传策略与确认（模板引用；收敛后仍保留身份确认与文件闭环入口）
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

async function handleConfirm(manual) {
	const res = await confirmIdentity()
	session.value = getSessionState()
	if (!res.ok) {
		if (res.transient) {
			if (manual) uni.showToast({ title: '网络不可用，请稍后重试', icon: 'none', duration: 2500 })
			return
		}
		if (manual) uni.showToast({ title: rejectText.value, icon: 'none', duration: 2500 })
		return
	}
	await Promise.all([loadUploadPolicy(), refreshDiagnostics()])
	refreshPendingUpload()
	if (manual) uni.showToast({ title: `已确认：${res.member.displayName}`, icon: 'none' })
}

async function loadUploadPolicy() {
	const res = await familyCall('mc-files', { action: 'uploadPolicy' })
	if (!res.ok) {
		filePolicyText.value = `上传策略读取失败：${res.message || res.code}`
		return
	}
	uploadEnabled.value = Boolean(res.data.clientUploadEnabled)
	filePolicyText.value = uploadEnabled.value
		? '上传已启用：图片将先存入你的个人暂存目录，服务端校验后登记为正式副本（两人共享查看）'
		: (res.data.reason || '上传通道未启用')
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
	try {
		// 受控管线已收敛到 fileUploadService（B2b2）；页面保持同一状态机与文案。
		// B1 诊断页语义：暂存过期 → 待办作废需重选（正式报告批次另行保留原件）
		const result = await uploadSingleFile({ uploadId: pending.uploadId, savedFilePath: pending.savedFilePath })
		if (result.locked) {
			session.value = getSessionState()
			uploadMsg.value = '身份被服务端拒绝，会话已锁定；请重新确认身份或联系管理员'
			uploadMsgWarn.value = true
			uploadedImageUrl.value = ''
			registeredFileId.value = ''
			pendingUploadInfo.value = null
			return
		}
		if (result.stale) return // 待办保留原成员名下
		if (!result.ok) {
			if (result.code === 'staged-file-unreadable') {
				clearPendingUpload()
				refreshPendingUpload()
				uploadMsg.value = '暂存文件已过期，请重新选择图片上传'
				uploadMsgWarn.value = true
				return
			}
			if (result.code === 'unsupported-platform') {
				uploadMsg.value = '上传仅在微信小程序端可用（待上传已保留）'
				uploadMsgWarn.value = true
				return
			}
			if (result.stage === 'prepare') {
				uploadMsg.value = `无法获取上传路径：${result.message || result.code}（待上传已保留，可重试）`
				uploadMsgWarn.value = true
				return
			}
			if (result.stage === 'stage') {
				uploadMsg.value = `上传失败：${result.message || '未知错误'}（待上传已保留，可重试同一文件）`
				uploadMsgWarn.value = true
				return
			}
			uploadMsg.value = `登记失败：${result.message || result.code}（待上传已保留，可直接重试同一文件）`
			uploadMsgWarn.value = true
			return
		}
		registeredFileId.value = result.fileId
		clearPendingUpload()
		refreshPendingUpload()
		uploadMsg.value = result.replayed ? '登记完成（重复确认幂等，结果为同一文件）' : '登记完成'
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
	if (isExplicitDemo()) return // 演示优先：诊断页不自动确认/拉取
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
