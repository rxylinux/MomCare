<template>
	<view class="page">
		<NavBar title="完整备份导出" theme="dark" transparent :showBack="true" class="hero-navbar" />
		<scroll-view scroll-y class="scroll">
			<view class="notice-card">
				<text class="notice-title">什么是完整备份</text>
				<text class="notice-desc">从服务端完整分页读取所选范围的全部数据（含报告原件字节），生成单一 .mcpkg 备份文件。文件保存在本机沙箱（卸载即失）；仅在您主动分享到微信聊天后才成为可搬移副本。云端导出仅在微信小程序端可用。</text>
			</view>

			<!-- 范围选择 -->
			<view class="card">
				<text class="card-title">备份范围</text>
				<view class="scope-row" @tap="includeShared = !includeShared">
					<text class="scope-main">共享数据（孕期/日健康/产检/待产包/报告）</text>
					<text class="scope-tag">{{ includeShared ? '已选' : '未选' }}</text>
				</view>
				<view class="scope-row" @tap="togglePrivate">
					<text class="scope-main">我的私人心情（仅本人可导出）</text>
					<text class="scope-tag">{{ includePrivate ? '已选' : '未选' }}</text>
				</view>
				<text class="scope-label">将生成：{{ scopeLabel }}</text>
			</view>

			<!-- 来源不可读（indeterminate 且五类皆空时也必须显示） -->
			<view v-if="pendingIndeterminate" class="card warn-card">
				<text class="card-title">待处理来源不可读</text>
				<text class="warn-desc">部分待处理来源（本机队列/草稿/批次缓存）当前损坏或不可读——无法判定完整性，只能生成诊断包。</text>
			</view>

			<!-- 待处理清单 -->
			<view v-if="pendingCount > 0" class="card warn-card">
				<text class="card-title">有待处理项（{{ pendingCount }}）</text>
				<text class="warn-desc">存在未同步/冲突/草稿/未完成迁移时只能生成「诊断包」——不完整、不能用于恢复。请先处理以上待办再导出完整备份。</text>
				<view v-for="item in pendingItems" :key="item" class="pending-item">
					<text class="pending-text">{{ item }}</text>
				</view>
			</view>

			<!-- 状态机 -->
			<view class="card">
				<text class="card-title">导出状态</text>
				<text class="state-text">{{ stateText }}</text>
				<view class="export-btn" :class="{ disabled: building }" @tap="doExport">
					<text class="export-btn-t">{{ building ? '导出中…' : '开始导出' }}</text>
				</view>
			</view>

			<!-- 已发布包列表 -->
			<template v-if="publishedList.length > 0">
				<text class="section-title">已发布的备份包</text>
				<view v-for="p in publishedList" :key="p.batchId" class="card pkg-card">
					<text class="pkg-line">{{ timeOf(p.publishedAt) }} · {{ p.complete ? '完整包' : '诊断包（不可用于恢复）' }} · {{ p.scopeLabel === 'shared-plus-own-private' ? '共享+本人私人' : '仅共享' }}</text>
					<text v-if="p.deliveredAt" class="pkg-sub">已于 {{ timeOf(p.deliveredAt) }} 分享过</text>
					<view class="pkg-actions">
						<view class="share-btn" @tap="doShare(p.batchId)">
							<text class="share-btn-t">分享到聊天</text>
						</view>
						<view class="del-btn" @tap="doRemove(p.batchId)">
							<text class="del-btn-t">删除本机包</text>
						</view>
					</view>
				</view>
			</template>

			<view class="bottom-spacer"></view>
		</scroll-view>
	</view>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import NavBar from '@/components/NavBar.vue'
import { getSessionState, subscribeSession, currentEpoch } from '@/services/sessionService.js'
import { buildAndPublishPackage, listPublished, sharePublishedPackage, removePublishedRecord, collectPendingLists, recoverInterruptedExport } from '@/services/mcpkgExportService.js'

const dataSource = ref(getSessionState().status === 'confirmed' ? 'family' : 'prompt')
// 订阅会话版本：成员/家庭变化立即清旧列表并从新作用域重读（旧成员元数据不得残留）
watch(subscribeSession(), () => {
  dataSource.value = getSessionState().status === 'confirmed' ? 'family' : 'prompt'
  // 身份变化：旧导出 continuation 的 epoch 门会丢弃其写入；building 是共享 UI 态——
  // 立即复位，新身份可开始自己的导出（陈旧导出不得钉死 building）
  building.value = false
  publishedList.value = []
  pending.value = { outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] }
  refresh()
})

const includeShared = ref(true)
const includePrivate = ref(false)
const building = ref(false)
// building 绑定发起作用域：操作令牌（单调序号）+ epoch 双重绑定——陈旧导出的迟到
// finally 不得清除新身份/新任务在途导出的 building，也不得触发其 refresh 污染
let activeExportToken = 0
const stateText = ref('未开始')
const pending = ref({ outboxPending: [], conflicts: [], localDrafts: [], uploadBatches: [], migrationIncomplete: [] })
const publishedList = ref([])

const scopeLabel = computed(() => {
	if (includePrivate.value) return '共享 + 本人私人'
	if (includeShared.value) return '仅共享'
	return '（未选择任何范围）'
})
const pendingItems = computed(() => {
	const p = pending.value
	return [
		...p.outboxPending.map(x => `待同步：${x}`),
		...p.conflicts.map(x => `冲突：${x}`),
		...p.localDrafts.map(x => `本机草稿：${x}`),
		...p.uploadBatches.map(x => `未完成上传批次：${x}`),
		...p.migrationIncomplete.map(x => `未完成迁移批次：${x}`)
	]
})
const pendingIndeterminate = computed(() => Boolean(pending.value.indeterminate))
const pendingCount = computed(() => pendingItems.value.length)

const refreshToken = { seq: 0 }
function refresh() {
	if (dataSource.value !== 'family') return
	pending.value = collectPendingLists()
	publishedList.value = listPublished()
	// 中断导出恢复：异步整包复验晋升——完成后列表才出现已验证条目（验证前列表无临时条目）
	const my = ++refreshToken.seq
	recoverInterruptedExport()
		.then(() => { if (refreshToken.seq === my) publishedList.value = listPublished() })
		.catch(() => { /* 恢复失败保持现状（无未处理拒绝） */ })
}
refresh()
watch(dataSource, refresh)

function togglePrivate() {
	includePrivate.value = !includePrivate.value
}

function timeOf(ts) {
	if (!ts) return '未知时间'
	const d = new Date(ts)
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function doExport() {
	if (building.value) return
	if (dataSource.value !== 'family') {
		uni.showToast({ title: '请先确认身份（云端导出仅在微信小程序端可用）', icon: 'none', duration: 2500 })
		return
	}
	if (!includeShared.value && !includePrivate.value) {
		uni.showToast({ title: '请至少选择一个范围', icon: 'none' })
		return
	}
	building.value = true
	const s = getSessionState()
	const epochAtExport = currentEpoch() // 进度与完成态写入均绑定发起 epoch
	const exportToken = ++activeExportToken // 操作令牌：同 epoch 内先后两次导出也能区分
	const isCurrent = () => activeExportToken === exportToken && currentEpoch() === epochAtExport
	try {
		const r = await buildAndPublishPackage({
			includeShared: includeShared.value,
			includePrivateOf: includePrivate.value ? s.member.memberId : null,
			onProgress: p => {
				if (!isCurrent()) return
				stateText.value = stageText(p.stage) + (p.detail ? `：${p.detail}` : '')
			}
		})
		// 完成态写入前核对令牌+epoch——旧 continuation 不得覆盖新身份页面状态
		if (!isCurrent()) {
			uni.showToast({ title: '导出期间会话切换——结果未应用', icon: 'none', duration: 3000 })
			return
		}
		if (r.ok) {
			stateText.value = r.complete ? '已发布（完整包，校验通过）' : '已发布（诊断包——不完整，不可用于恢复）'
			uni.showToast({ title: r.complete ? '完整包已生成并校验通过' : '诊断包已生成（不完整）', icon: 'none', duration: 2500 })
		} else {
			stateText.value = `失败：${r.code}`
			uni.showToast({ title: r.message || r.code || '导出失败', icon: 'none', duration: 3000 })
		}
	} catch (err) {
		if (isCurrent()) {
			stateText.value = `失败：${(err && err.message) || '异常'}`
			uni.showToast({ title: (err && err.message) || '导出异常', icon: 'none', duration: 3000 })
		}
	} finally {
		// 仅当仍是当前操作令牌+epoch 时复位 building 与刷新——陈旧导出不得影响新任务
		if (isCurrent()) {
			building.value = false
			refresh()
		}
	}
}

function stageText(stage) {
	return {
		collecting: '收集（服务端全量分页）',
		'manifest-built': '清单已构成',
		assembling: '组装 .partial（逐段分块回读校验）',
		'publish-check': '发布前二次检查',
		'target-written': '发布到目标文件',
		verified: '目标文件整包复验',
		published: '已发布'
	}[stage] || stage
}

async function doShare(batchId) {
	const r = await sharePublishedPackage(batchId)
	if (r.ok) {
		uni.showToast({ title: '已发起分享', icon: 'none' })
	} else if (r.code === 'delivery-cancelled') {
		uni.showToast({ title: r.message, icon: 'none', duration: 2500 })
	} else {
		uni.showToast({ title: r.message || r.code || '分享失败', icon: 'none', duration: 3000 })
	}
	refresh()
}

function doRemove(batchId) {
	uni.showModal({
		title: '删除本机备份包',
		content: '将删除本机沙箱中的该备份文件与其发布记录。若您从未分享过它，删除后该备份不再存在。',
		confirmText: '删除',
		confirmColor: '#C0405A',
		success: async res => {
			if (!res.confirm) return
			const r = await removePublishedRecord(batchId)
			uni.showToast({ title: r.ok ? '已删除' : (r.message || r.code || '删除失败'), icon: 'none', duration: 3000 })
			refresh()
		}
	})
}
</script>

<style scoped lang="scss">
.page { display: flex; flex-direction: column; height: 100vh; background: #FBF7F2; }
.scroll { flex: 1; }
.notice-card { margin: 24rpx; padding: 32rpx; background: #FFF; border-radius: 24rpx; }
.notice-title { font-size: 28rpx; font-weight: 600; color: #1C1A17; display: block; margin-bottom: 8rpx; }
.notice-desc { font-size: 24rpx; color: #757575; line-height: 1.6; }
.card { margin: 20rpx 24rpx; padding: 28rpx; background: #FFF; border-radius: 20rpx; }
.card-title { font-size: 26rpx; font-weight: 600; color: #1C1A17; display: block; margin-bottom: 12rpx; }
.scope-row { display: flex; justify-content: space-between; align-items: center; padding: 14rpx 0; }
.scope-main { font-size: 24rpx; color: #4A4844; flex: 1; }
.scope-tag { font-size: 22rpx; color: #C98A3A; flex-shrink: 0; }
.scope-label { font-size: 22rpx; color: #9C9890; margin-top: 8rpx; display: block; }
.warn-card { border: 2rpx solid #F0A940; background: #FFFBF5; }
.warn-desc { font-size: 22rpx; color: #B07818; line-height: 1.6; display: block; margin-bottom: 8rpx; }
.pending-item { padding: 4rpx 0; }
.pending-text { font-size: 22rpx; color: #8C5A10; }
.state-text { font-size: 24rpx; color: #4A4844; line-height: 1.6; display: block; margin-bottom: 16rpx; }
.export-btn { padding: 22rpx; background: linear-gradient(135deg, #C98A3A, #F0C878); border-radius: 16rpx; text-align: center; }
.export-btn.disabled { opacity: 0.5; }
.export-btn-t { font-size: 26rpx; font-weight: 600; color: #FFF; }
.section-title { display: block; padding: 20rpx 28rpx 12rpx; font-size: 26rpx; font-weight: 600; color: #1C1A17; }
.pkg-card { border: 2rpx dashed #D8D4CC; }
.pkg-line { font-size: 24rpx; color: #4A4844; display: block; }
.pkg-sub { font-size: 22rpx; color: #3A8C5A; margin-top: 4rpx; display: block; }
.pkg-actions { display: flex; gap: 16rpx; margin-top: 16rpx; }
.share-btn { padding: 14rpx 28rpx; background: #EAF7EF; border-radius: 999rpx; border: 2rpx solid #3A8C5A; }
.share-btn-t { font-size: 24rpx; color: #3A8C5A; font-weight: 600; }
.del-btn { padding: 14rpx 28rpx; background: #FDEEF1; border-radius: 999rpx; border: 2rpx solid #C0405A; }
.del-btn-t { font-size: 24rpx; color: #C0405A; font-weight: 600; }
.bottom-spacer { height: 60rpx; }
</style>
