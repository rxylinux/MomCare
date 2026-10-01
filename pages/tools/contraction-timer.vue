<template>
	<view class="page">
		<view class="head">
			<text class="title">宫缩计时</text>
			<text class="subtitle">记录持续时长与发作间隔 · 511 规律仅为辅助参考</text>
		</view>

		<!-- 本地未保存警示（R1 A04：存储写入失败如实披露，绝不显示"已暂存"） -->
		<view v-if="unsaved" class="unsaved-banner">
			<text class="unsaved-banner-text">本地保存失败：当前记录仅保留在内存中，重启会丢失。请清理手机存储空间后继续记录。</text>
		</view>

		<!-- F1：旧版计时记录待确认入口（未确认前不展示正文/不上传/不自动归属） -->
		<view v-if="legacyPending && legacyPending.total > 0" class="legacy-banner">
			<text class="legacy-banner-text">{{ legacySummaryText }}</text>
			<view class="legacy-banner-row">
				<view class="legacy-banner-btn primary" @tap="onLegacyAdopt"><text class="legacy-banner-btn-text">确认归属并迁入</text></view>
				<view class="legacy-banner-btn" @tap="onLegacyExport"><text class="legacy-banner-btn-text">导出保留</text></view>
			</view>
			<text v-if="legacyResultText" class="legacy-banner-result">{{ legacyResultText }}</text>
		</view>

		<!-- 恢复异常持久披露（R1 审核6/第二轮6 + R3 审核2：如实区分已备份/未备份） -->
		<view v-if="restoreWarnings.length > 0" class="restore-banner">
			<text class="restore-banner-text">{{ restoreWarningText }}</text>
			<view v-if="recoveryBlocked" class="restore-banner-btn" @tap="onAckRestore">
				<text class="restore-banner-btn-text">我已知悉异常，恢复自动同步</text>
			</view>
		</view>

		<!-- 建档医院/医生/急救电话卡片 -->
		<view class="hospital-card">
			<view class="hospital-row">
				<text class="hospital-label">建档医院</text>
				<text class="hospital-value">{{ hospitalName }}</text>
			</view>
			<view class="hospital-row">
				<text class="hospital-label">主治医生</text>
				<text class="hospital-value">{{ doctorName }}</text>
			</view>
			<view class="call-btn" :class="{ empty: !hospitalPhone }" @tap="onCall">
				<text class="call-btn-text">{{ hospitalPhone ? `拨打就医电话 ${hospitalPhone}` : '尚未填写就医电话——去完善' }}</text>
			</view>
		</view>

		<!-- 核心起止切换按键 -->
		<view class="toggle-btn" :class="{ ongoing: !!active }" @tap="onToggle">
			<text class="toggle-btn-text">{{ active ? '宫缩结束了' : '宫缩开始了' }}</text>
			<text v-if="active" class="toggle-btn-sub">已持续 {{ currentDurationText }}</text>
		</view>

		<!-- 实时统计 -->
		<view class="stat-card">
			<view class="stat-item">
				<text class="stat-num">{{ avgDurationSec === null ? '—' : avgDurationSec + 's' }}</text>
				<text class="stat-label">平均持续（近 1 小时）</text>
			</view>
			<view class="stat-item">
				<text class="stat-num">{{ avgIntervalMin === null ? '—' : avgIntervalMin + ' 分钟' }}</text>
				<text class="stat-label">平均间隔（近 1 小时）</text>
			</view>
		</view>

		<!-- 511 临产规律提示卡（辅助参考——不构成医疗诊断） -->
		<view class="p511-card" :class="{ hit: is511 }">
			<text class="p511-title">{{ is511 ? '符合 511 规律，建议联系医院或准备就医' : '当前未符合 511 规律' }}</text>
			<text class="p511-desc">511 参考：约每 5 分钟 1 次、每次持续约 1 分钟、规律持续约 1 小时</text>
			<text class="p511-disclaimer">{{ disclaimer }}</text>
		</view>

		<!-- R3 重启 1：全部未完成输入（跨日可见）——独立于最近一天时间线；披露不随展示窗消失 -->
		<view v-if="unfinishedList.length > 0" class="unfinished-card">
			<text class="unfinished-title">未完成同步的记录（{{ unfinishedList.length }} 条）</text>
			<text class="unfinished-desc">以下本机输入尚未同步到云端（含跨日）；联网后自动重试，冲突项需核对两台设备。</text>
			<view v-for="r in unfinishedList" :key="'uf-' + (r.recordId || r.localRef || r.startTime)" class="unfinished-row">
				<text class="unfinished-line">{{ unfinishedTimeText(r) }} · {{ r.durationSec === null ? '—' : r.durationSec + 's' }}{{ r.intensity ? ' · ' + intensityText(r.intensity) : '' }}</text>
				<text v-if="r.conflict === true" class="unfinished-conflict">⚠️ 与其他设备的记录冲突：本机输入未同步，需处理</text>
				<text v-else class="unfinished-pending">待同步（本机保留，联网后自动重试；未同步到云端）</text>
			</view>
		</view>


		<!-- 历史时间线 -->
		<view class="timeline-card">
			<text class="timeline-title">宫缩时间线</text>
			<view v-if="recentContractions.length === 0" class="timeline-empty"><text class="timeline-empty-text">还没有宫缩记录</text></view>
			<view v-for="r in recentContractions" :key="r.recordId || r.startTime" class="timeline-row">
				<view class="timeline-main">
					<text class="timeline-line">{{ timeText(r.startTime) }} 开始</text>
					<text class="timeline-meta">持续 {{ r.durationSec === null ? '—' : r.durationSec + 's' }} · 间隔 {{ r.intervalSec === null ? '—' : Math.round(r.intervalSec / 60) + ' 分钟' }}{{ r.intensity ? ' · ' + intensityText(r.intensity) : '' }}</text>
					<!-- R3 终审 1：未同步/冲突如实可见——不与已同步记录同观 -->
					<text v-if="r.synced === false && r.conflict === true" class="timeline-conflict">⚠️ 与其他设备的记录冲突：本机输入未同步，需处理（重试仍失败请核对两台设备）</text>
					<text v-else-if="r.synced === false" class="timeline-pending">待同步（本机保留，联网后自动重试；未同步到云端）</text>
				</view>
				<view class="timeline-del" @tap="onDelete(r)"><text class="timeline-del-text">删除</text></view>
			</view>
		</view>
	</view>
</template>

<script setup>
import { ref, computed } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { useToolsStore } from '@/services/toolsStore.js'
import { getSessionState } from '@/services/sessionService.js'

// 宫缩计时页：起止切换 + 平均统计 + 511 辅助参考（免责声明）+ 就医电话联动
const toolsStore = useToolsStore()

const nowTick = ref(Date.now())
let ticker = null

const active = computed(() => toolsStore.activeContraction)
const unsaved = computed(() => toolsStore.contraUnsaved)
// 恢复异常持久披露（R1 审核6/第二轮6 + R3 审核2 + 终审2）：页面级横幅，非 console/toast
// 一闪而过。三态如实：已隔离备份 / 未能备份（原字节保留未动）/ 孤儿 RAM 草稿恢复
// （orphan-draft-restored 是内存恢复，没有做任何耐久备份——不得归类为"已备份"）。
// 同步状态同步披露：未确认=暂停，已确认=已恢复。
const restoreWarnings = computed(() => toolsStore.restoreWarnings)
const recoveryBlocked = computed(() => toolsStore.recoveryBlocked)
const RESTORE_WARNING_LABELS = {
	'error': '缓存读取失败',
	'corrupt': '缓存数据损坏',
	'corrupt-frozen': '缓存数据损坏且备份失败',
	'invalid-shape': '缓存结构不合法',
	'invalid-shape-unbacked': '缓存结构不合法且备份失败',
	'scope-foreign': '存在其他成员的数据',
	'scope-foreign-unbacked': '存在其他成员的数据且备份失败'
}
const UNBACKED_STATUSES = ['error', 'corrupt-frozen', 'invalid-shape-unbacked', 'scope-foreign-unbacked']
const restoreWarningText = computed(() => {
	const segs = []
	const integrity = restoreWarnings.value.filter(w => w.status !== 'orphan-draft-restored')
	if (integrity.length > 0) {
		const parts = [...new Set(integrity.map(w => RESTORE_WARNING_LABELS[w.status] || w.status))]
		const hasUnbacked = integrity.some(w => UNBACKED_STATUSES.includes(w.status))
		const backup = hasUnbacked ? '异常数据未能备份（原数据保留在原位、未被覆写）' : '异常数据已隔离备份'
		segs.push(`本地记录恢复异常（${parts.join('、')}）：${backup}，自动同步${recoveryBlocked.value ? '已暂停' : '已恢复（已确认）'}`)
	}
	if (restoreWarnings.value.some(w => w.status === 'orphan-draft-restored')) {
		segs.push('检测到未落盘的记录草稿，已从内存恢复——数据仍未保存到本地存储')
	}
	return segs.join('。')
})
function onAckRestore() {
	// 显式确认（R3 审核2：含义明确——仅解除自动同步暂停；不改变数据、不删警告）
	toolsStore.acknowledgeRestoreWarnings()
	uni.showToast({ title: '已确认：自动同步恢复，异常提示保留至数据恢复', icon: 'none' })
}
// ── F1：旧版计时记录找回入口（检测 → 显式确认归属 / 原始字节导出保留）──
const legacyPending = computed(() => toolsStore.legacyPending)
const legacySummaryText = computed(() => toolsStore.legacySummaryText)
const legacyResultText = ref('')
async function onLegacyAdopt() {
	// 确认提示：旧记录无身份信息，无法自动证明所有者；显式确认后按当前完整作用域迁入
	// （有服务端 ID 的记录仍会先验证云端归属——确认本身不直接赋予操作权限）
	uni.showModal({
		title: '确认旧记录归属？',
		content: '旧版记录不含身份信息，无法自动证明属于当前成员。确认后将以当前成员身份迁入（已有云端 ID 的记录会先核验云端归属；冲突/无法核验的将保留待处理，不会静默丢弃）。',
		confirmText: '确认迁入',
		cancelText: '取消',
		success: async res => {
			if (!res || !res.confirm) return
			const r = await toolsStore.confirmLegacyAdoption()
			if (r.ok && r.adopted > 0 && (!r.conflicts || r.conflicts.length === 0) && (!r.rejected || r.rejected.length === 0) && (!r.unverifiable || r.unverifiable.length === 0)) {
				legacyResultText.value = `已迁入 ${r.adopted} 条旧记录（原始字节已备份保留）`
				uni.showToast({ title: `已迁入 ${r.adopted} 条旧记录`, icon: 'none' })
			} else if (r.ok) {
				const bits = []
				if (r.adopted > 0) bits.push(`已迁入 ${r.adopted} 条`)
				if (r.conflicts && r.conflicts.length > 0) bits.push(`冲突 ${r.conflicts.length} 项（当前已有进行中记录，旧数据保留未覆盖，可导出）`)
				if (r.rejected && r.rejected.length > 0) bits.push(`归属不符 ${r.rejected.length} 项（云端记录属其他成员，保留待处理）`)
				if (r.unverifiable && r.unverifiable.length > 0) bits.push(`无法核验 ${r.unverifiable.length} 项（保留待处理，不发写入）`)
				legacyResultText.value = bits.join('；') || '没有可迁入的旧记录'
				uni.showToast({ title: bits[0] || '旧记录待处理', icon: 'none', duration: 3000 })
			} else {
				legacyResultText.value = r.message || '迁移未完成（旧数据保持原样）'
				uni.showToast({ title: r.message || '迁移未完成，旧数据保持原样', icon: 'none', duration: 3000 })
			}
		}
	})
}
function onLegacyExport() {
	const r = toolsStore.exportLegacyRaw()
	if (r.ok && r.exported.length > 0) {
		legacyResultText.value = `已导出保留 ${r.exported.length} 个旧键的原始字节（本地备份键）`
		uni.showToast({ title: `已导出保留 ${r.exported.length} 项原始数据`, icon: 'none' })
	} else {
		legacyResultText.value = r.failed.length > 0 ? `导出失败 ${r.failed.length} 项（存储异常，旧数据保持原样）` : '没有可导出的旧记录'
		uni.showToast({ title: r.failed.length > 0 ? '导出失败，旧数据保持原样' : '没有可导出的旧记录', icon: 'none' })
	}
}

const hospitalName = computed(() => toolsStore.hospitalName)
const doctorName = computed(() => toolsStore.doctorName)
const hospitalPhone = computed(() => toolsStore.hospitalPhone)
const recentContractions = computed(() => toolsStore.recentContractions)
// R3 重启 1：全部未完成输入（跨日可见——独立于 recentContractions 的一天窗口）
const unfinishedList = computed(() => toolsStore.unfinishedContractions)
function unfinishedTimeText(r) {
  const d = new Date(r.startTime)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const avgDurationSec = computed(() => toolsStore.avgDurationSec)
const avgIntervalSec = computed(() => toolsStore.avgIntervalSec)
const avgIntervalMin = computed(() => (avgIntervalSec.value === null ? null : Math.round(avgIntervalSec.value / 60)))
const is511 = computed(() => toolsStore.is511Pattern)
const disclaimer = toolsStore.disclaimer

const currentDurationText = computed(() => {
	void nowTick.value
	if (!active.value) return ''
	const sec = Math.max(0, Math.floor((nowTick.value - active.value.startTime) / 1000))
	return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`
})

function timeText(ms) {
	const d = new Date(ms)
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function intensityText(v) {
	return { mild: '轻度', moderate: '中度', strong: '强度' }[v] || v
}

function ensureTicker() {
	if (ticker) return
	ticker = setInterval(() => { nowTick.value = Date.now() }, 1000)
}

function onCall() {
	toolsStore.callHospital()
}

function onToggle() {
	if (active.value) {
		toolsStore.stopContraction().then(r => {
			if (r.ok) uni.showToast({ title: '已记录本次宫缩', icon: 'none' })
			else if (r.code === 'offline-pending') uni.showToast({ title: '已暂存，联网后同步', icon: 'none' })
			else if (r.code === 'local-persist-failed') uni.showToast({ title: r.message || '本地保存未全部成功', icon: 'none' })
			else uni.showToast({ title: r.message || '记录失败', icon: 'none' })
		})
	} else {
		toolsStore.startContraction().then(r => {
			if (r.ok) { uni.vibrateShort({ type: 'light' }); ensureTicker() }
			else if (r.code === 'offline-pending') { uni.showToast({ title: '已开始（联网后同步）', icon: 'none' }); ensureTicker() }
			else if (r.code === 'local-persist-failed') uni.showToast({ title: r.message || '本地保存失败，重启会丢失', icon: 'none' })
			else uni.showToast({ title: r.message || '开始失败', icon: 'none' })
		})
	}
}

function onDelete(r) {
	uni.showModal({
		title: '删除这条误录？',
		content: '删除后不再计入统计',
		confirmText: '删除',
		cancelText: '取消',
		success: res => {
			if (!res || !res.confirm) return
			toolsStore.deleteContraction(r.recordId).then(res2 => {
				if (res2.ok) uni.showToast({ title: '已删除', icon: 'none' })
				else uni.showToast({ title: res2.message || '删除失败', icon: 'none' })
			})
		}
	})
}

onShow(() => {
	nowTick.value = Date.now()
	ensureTicker()
	const s = getSessionState()
	if (s.status === 'confirmed' && s.member) {
		toolsStore.restoreFromCache()
		toolsStore.retryPending().catch(() => {})
		toolsStore.pullContractions().catch(() => {})
	}
})
</script>

<style>
.page {
	min-height: 100vh;
	background: #f5f7fb;
	padding-bottom: calc(40rpx + env(safe-area-inset-bottom));
}
.head {
	padding: 40rpx 32rpx 16rpx;
}
.title {
	font-size: 40rpx;
	font-weight: 700;
	color: #11222e;
}
.subtitle {
	display: block;
	margin-top: 8rpx;
	font-size: 24rpx;
	color: #8a94a6;
}
.unsaved-banner {
	margin: 20rpx 32rpx 0;
	padding: 16rpx 24rpx;
	border-radius: 16rpx;
	background: #fdeeee;
}
.unsaved-banner-text {
	font-size: 22rpx;
	color: #c0392b;
	line-height: 1.6;
}
/* F1：旧版记录待确认入口 */
.legacy-banner {
	margin: 16rpx 24rpx 0;
	padding: 20rpx 24rpx;
	border-radius: 14rpx;
	background: #f4f0e4;
	border: 1rpx solid #e3d9bd;
}
.legacy-banner-text { display: block; font-size: 24rpx; color: #6b5d33; line-height: 1.6; }
.legacy-banner-row { margin-top: 14rpx; display: flex; flex-direction: row; gap: 12rpx; }
.legacy-banner-btn { padding: 10rpx 22rpx; border-radius: 999rpx; background: #ffffff; border: 1rpx solid #d8c99a; }
.legacy-banner-btn.primary { background: #8a763a; border-color: #8a763a; }
.legacy-banner-btn-text { font-size: 24rpx; color: #6b5d33; }
.legacy-banner-btn.primary .legacy-banner-btn-text { color: #ffffff; }
.legacy-banner-result { display: block; margin-top: 10rpx; font-size: 22rpx; color: #8a7440; line-height: 1.5; }
.restore-banner {
	margin: 20rpx 32rpx 0;
	padding: 16rpx 24rpx;
	border-radius: 16rpx;
	background: #fdf6e8;
}
.restore-banner-text {
	font-size: 22rpx;
	color: #9a7b2d;
	line-height: 1.6;
}
.restore-banner-btn {
	margin-top: 12rpx;
	align-self: flex-end;
	padding: 8rpx 20rpx;
	border-radius: 999rpx;
	background: #f0e3c0;
}
.restore-banner-btn-text {
	font-size: 22rpx;
	color: #7a6120;
}
.hospital-card {
	margin: 24rpx 32rpx 0;
	padding: 28rpx;
	border-radius: 24rpx;
	background: #ffffff;
	box-shadow: 0 4rpx 20rpx rgba(17, 22, 34, 0.06);
}
.hospital-row {
	display: flex;
	flex-direction: row;
	justify-content: space-between;
	padding: 10rpx 0;
}
.hospital-label {
	font-size: 26rpx;
	color: #8a94a6;
}
.hospital-value {
	font-size: 26rpx;
	color: #2a3444;
}
.call-btn {
	margin-top: 16rpx;
	padding: 22rpx 0;
	border-radius: 999rpx;
	background: #e8f5ec;
	display: flex;
	justify-content: center;
}
.call-btn.empty {
	background: #f2f5fa;
}
.call-btn-text {
	font-size: 28rpx;
	color: #2f7d4e;
	font-weight: 600;
}
.call-btn.empty .call-btn-text {
	color: #8a94a6;
	font-weight: 400;
}
.toggle-btn {
	margin: 40rpx 48rpx;
	min-height: 220rpx;
	border-radius: 32rpx;
	background: linear-gradient(135deg, #4a7cf7, #6a5cf6);
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	box-shadow: 0 12rpx 36rpx rgba(74, 124, 247, 0.35);
}
.toggle-btn.ongoing {
	background: linear-gradient(135deg, #ff8a65, #ff6d3f);
	box-shadow: 0 12rpx 36rpx rgba(255, 109, 63, 0.4);
}
.toggle-btn-text {
	font-size: 44rpx;
	font-weight: 700;
	color: #ffffff;
}
.toggle-btn-sub {
	margin-top: 10rpx;
	font-size: 26rpx;
	color: rgba(255, 255, 255, 0.9);
}
.stat-card {
	margin: 0 32rpx;
	padding: 28rpx;
	border-radius: 24rpx;
	background: #ffffff;
	display: flex;
	flex-direction: row;
	box-shadow: 0 4rpx 20rpx rgba(17, 22, 34, 0.06);
}
.stat-item {
	flex: 1;
	display: flex;
	flex-direction: column;
	align-items: center;
}
.stat-num {
	font-size: 38rpx;
	font-weight: 700;
	color: #2a3444;
}
.stat-label {
	margin-top: 6rpx;
	font-size: 22rpx;
	color: #8a94a6;
}
.p511-card {
	margin: 24rpx 32rpx 0;
	padding: 28rpx;
	border-radius: 24rpx;
	background: #f7f9fc;
	border: 2rpx solid #e3e8f0;
}
.p511-card.hit {
	background: #fff7f0;
	border-color: #ffb38a;
}
.p511-title {
	font-size: 28rpx;
	font-weight: 600;
	color: #2a3444;
}
.p511-card.hit .p511-title {
	color: #d9534f;
}
.p511-desc {
	display: block;
	margin-top: 10rpx;
	font-size: 24rpx;
	color: #46536a;
}
.p511-disclaimer {
	display: block;
	margin-top: 12rpx;
	font-size: 22rpx;
	color: #8a94a6;
	line-height: 1.6;
}
.unfinished-card {
	margin: 24rpx 32rpx 0;
	padding: 24rpx 28rpx;
	border-radius: 24rpx;
	background: #fdf6e8;
	border: 2rpx solid #f0e3c0;
}
.unfinished-title { font-size: 28rpx; font-weight: 600; color: #7a6120; }
.unfinished-desc { display: block; margin-top: 6rpx; font-size: 22rpx; color: #9a7b2d; line-height: 1.5; }
.unfinished-row { margin-top: 16rpx; display: flex; flex-direction: column; }
.unfinished-line { font-size: 26rpx; color: #2a3444; }
.unfinished-conflict { margin-top: 4rpx; font-size: 22rpx; color: #c0392b; line-height: 1.5; }
.unfinished-pending { margin-top: 4rpx; font-size: 22rpx; color: #d98a2b; line-height: 1.5; }
.timeline-card {
	margin: 24rpx 32rpx 0;
	padding: 28rpx;
	border-radius: 24rpx;
	background: #ffffff;
	box-shadow: 0 4rpx 20rpx rgba(17, 22, 34, 0.06);
}
.timeline-title {
	font-size: 30rpx;
	font-weight: 600;
	color: #11222e;
}
.timeline-empty {
	padding: 32rpx 0;
	display: flex;
	justify-content: center;
}
.timeline-empty-text {
	font-size: 24rpx;
	color: #9aa4b5;
}
.timeline-row {
	display: flex;
	flex-direction: row;
	align-items: center;
	justify-content: space-between;
	padding: 20rpx 0;
	border-bottom: 1rpx solid #f0f3f8;
}
.timeline-main {
	display: flex;
	flex-direction: column;
}
.timeline-line {
	font-size: 26rpx;
	color: #2a3444;
}
.timeline-conflict { display: block; margin-top: 4rpx; font-size: 22rpx; color: #c0392b; line-height: 1.5; }
.timeline-pending { display: block; margin-top: 4rpx; font-size: 22rpx; color: #d98a2b; line-height: 1.5; }
.timeline-meta {
	margin-top: 6rpx;
	font-size: 22rpx;
	color: #8a94a6;
}
.timeline-del {
	padding: 8rpx 20rpx;
	border-radius: 12rpx;
	background: #fdeeee;
}
.timeline-del-text {
	font-size: 22rpx;
	color: #d9534f;
}
</style>
