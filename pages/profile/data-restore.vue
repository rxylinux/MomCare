<template>
	<view class="page">
		<NavBar title="备份包验证" theme="dark" transparent :showBack="true" class="hero-navbar" />
		<scroll-view scroll-y class="scroll">
			<view class="notice-card">
				<text class="notice-title">本地验包（阶段一）</text>
				<text class="notice-desc">选择一个 .mcpkg 备份文件，在本机逐块校验其完整性（容器结构、逐文件 SHA-256、清单声明一致性）。云端隔离恢复将在下一阶段提供——当前版本不执行任何恢复写入。</text>
			</view>

			<!-- 平台能力 -->
			<view v-if="!canPick" class="card warn-card">
				<text class="warn-desc">当前平台缺少文件选择能力——无法本地验包。</text>
			</view>

			<view v-else class="card">
				<view class="pick-btn" @tap="pickFile">
					<text class="pick-btn-t">{{ isWechat ? '从聊天记录选择备份文件' : '选择备份文件' }}</text>
				</view>
				<text v-if="isWechat" class="pick-hint">提示：请先在微信聊天中找到备份文件（导出时分享得到的 .mcpkg）</text>
			</view>

			<!-- 校验结果 -->
			<template v-if="result">
				<view class="card" :class="result.ok ? 'ok-card' : 'bad-card'">
					<text class="card-title">{{ result.ok ? '校验通过' : '校验未通过' }}</text>
					<text class="line">包类型：{{ kindText }}</text>
					<text class="line">范围：{{ result.manifest.scopeLabel === 'shared-plus-own-private' ? '共享+本人私人' : '仅共享' }}</text>
					<text class="line">导出时间：{{ timeOf(result.manifest.createdAt) }}</text>
					<text class="line">整包摘要：{{ short(result.packageDigest) }}</text>
					<text class="line">清单摘要：{{ short(result.manifestDigest) }}</text>
					<text class="line">推导总长：{{ result.derivedTotal }} 字节（与实际 {{ result.actualSize }} 一致：{{ result.derivedTotal === result.actualSize ? '是' : '否' }}）</text>
				</view>

				<!-- 领域概览 -->
				<view class="card">
					<text class="card-title">领域概览</text>
					<view v-for="(entry, domain) in result.manifest.domains" :key="domain" class="domain-row">
						<text class="domain-name">{{ domainLabel(domain) }}</text>
						<text class="domain-tag" :class="'st-' + entry.status">{{ domainText(entry) }}</text>
					</view>
				</view>

				<!-- 问题清单 -->
				<view v-if="result.problems.length > 0" class="card bad-card">
					<text class="card-title">问题（{{ result.problems.length }}）</text>
					<view v-for="(p, i) in result.problems" :key="i" class="prob-row">
						<text class="prob-text">⚠ {{ p.code }}：{{ p.message }}</text>
					</view>
				</view>

				<view v-if="result.manifest.packageKind === 'diagnostic'" class="card warn-card">
					<text class="warn-desc">诊断包——导出时不完整（原因：{{ (result.manifest.incompleteReasons || []).join('；') || '未知' }}）。不能用于恢复。</text>
				</view>

				<view class="card">
					<text class="next-note">恢复能力（上传到隔离区、逐项校验、差异预览）将在下一阶段提供。当前版本只做本地验证，不写入任何数据。</text>
				</view>
			</template>

			<view class="bottom-spacer"></view>
		</scroll-view>
	</view>
</template>

<script setup>
import { ref, computed } from 'vue'
import NavBar from '@/components/NavBar.vue'
import { validatePackage, ContainerError } from '@/utils/mcpkg/container.js'

const isWechat = computed(() => typeof wx !== 'undefined' && wx.getFileSystemManager)
// 非浏览器判别用 window（零 document 访问——document 可能是被计数的代理）；
// 真实 H5 有 window；Node/无 DOM 环境 window 未定义 → 如实不可用
const hasBrowserEnv = computed(() => typeof window !== 'undefined' && !!window)
const canPick = computed(() => isWechat.value || hasBrowserEnv.value)
const result = ref(null)
const picking = ref(false)

function domainLabel(d) {
	return { pregnancy: '孕期资料', daily: '日健康', mood: '私人心情', checkup: '产检安排', bag: '待产包', reports: '产检报告' }[d] || d
}
function domainText(entry) {
	if (entry.status === 'present') {
		const base = `${entry.recordCount} 条${entry.pagingComplete ? '' : '（分页未完成）'}`
		return base + (entry.visibility === 'private' ? ' · 私人' : '')
	}
	if (entry.status === 'omitted') return '未选择/无权（不算不完整）'
	return `读取失败：${entry.reason}`
}
function timeOf(ts) {
	if (!ts) return '未知'
	const d = new Date(ts)
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function short(hex) {
	return hex ? hex.slice(0, 16) + '…' : '—'
}
const kindText = computed(() => {
	if (!result.value) return '—'
	return result.value.manifest.packageKind === 'full' ? '完整包' : '诊断包（不完整，不可恢复）'
})

async function verifyWithReader(reader) {
	try {
		const r = await validatePackage(reader)
		result.value = r
		uni.showToast({ title: r.ok ? '校验通过' : `校验未通过（${r.problems.length} 个问题）`, icon: 'none', duration: 2500 })
	} catch (e) {
		result.value = { ok: false, problems: [{ code: e.code || 'verify-error', message: e.message || String(e) }], manifest: { domains: {}, scopeLabel: '', packageKind: 'unknown', createdAt: 0 }, manifestDigest: '—', packageDigest: '—', derivedTotal: 0, actualSize: 0 }
		uni.showToast({ title: e.message || '校验失败', icon: 'none', duration: 3000 })
	}
}

function pickFile() {
	if (picking.value) return
	picking.value = true
	if (isWechat.value) {
		wx.chooseMessageFile({
			count: 1,
			type: 'file',
			extension: ['mcpkg'],
			success: async r => {
				const f = r.tempFiles && r.tempFiles[0]
				if (!f) { picking.value = false; return }
				const { wechatFileReader } = await import('@/utils/mcpkg/adapter-wechat.js')
				await verifyWithReader(wechatFileReader(f.path))
				picking.value = false
			},
			fail: () => { picking.value = false } // 用户取消——不报错
		})
		return
	}
	// H5：input[type=file]（活体云端操作在 H5 不可用；本地验包无需身份）
	// document 访问只在用户点击且 window 存在时发生（非浏览器环境零访问）
	if (!hasBrowserEnv.value || typeof document === 'undefined' || !document.createElement) {
		picking.value = false
		uni.showToast({ title: '当前环境不支持文件选择', icon: 'none', duration: 2500 })
		return
	}
	const input = document.createElement('input')
	input.type = 'file'
	input.accept = '.mcpkg'
	input.onchange = async () => {
		const f = input.files && input.files[0]
		if (!f) { picking.value = false; return }
		const { h5FileReader } = await import('@/utils/mcpkg/adapter-h5.js')
		await verifyWithReader(h5FileReader(f))
		picking.value = false
	}
	input.click()
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
.ok-card { border: 2rpx solid #3A8C5A; }
.bad-card { border: 2rpx solid #C0405A; }
.warn-card { border: 2rpx solid #F0A940; background: #FFFBF5; }
.warn-desc { font-size: 22rpx; color: #B07818; line-height: 1.6; display: block; }
.line { font-size: 23rpx; color: #4A4844; line-height: 1.7; display: block; word-break: break-all; }
.domain-row { display: flex; justify-content: space-between; padding: 8rpx 0; }
.domain-name { font-size: 24rpx; color: #4A4844; }
.domain-tag { font-size: 22rpx; }
.st-present { color: #3A8C5A; }
.st-omitted { color: #9C9890; }
.st-missing { color: #C0405A; }
.prob-row { padding: 4rpx 0; }
.prob-text { font-size: 22rpx; color: #C0405A; line-height: 1.5; }
.pick-btn { padding: 22rpx; background: linear-gradient(135deg, #C98A3A, #F0C878); border-radius: 16rpx; text-align: center; }
.pick-btn-t { font-size: 26rpx; font-weight: 600; color: #FFF; }
.pick-hint { font-size: 22rpx; color: #9C9890; margin-top: 10rpx; display: block; line-height: 1.5; }
.next-note { font-size: 22rpx; color: #757575; line-height: 1.6; }
.bottom-spacer { height: 60rpx; }
</style>
