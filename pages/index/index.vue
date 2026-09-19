<template>
	<view class="page">
		<!-- Loading 状态 -->
		<view v-if="loading" class="loading-container">
			<view class="loading-spinner"></view>
			<text class="loading-text">加载中...</text>
		</view>

		<!-- 主内容（加载完成后显示） -->
		<template v-else>
		<scroll-view scroll-y class="scroll-content" @scrolltolower="onScrollBottom">
			<!-- Hero 区域 -->
			<HomeHero
				:greeting="greeting"
				:weekInfo="heroWeekInfo"
				:daysUntilDue="heroDaysUntilDue"
				:fruitComparison="heroFruit"
				:pregInfoSet="heroPregInfoSet"
			/>

			<template v-if="heroPregInfoSet">
				<!-- 每日变化卡片 -->
				<DailyChanges
					:weekInfo="heroWeekInfo"
					:selectedDate="selectedDate"
					:slidesData="dailySlides"
				/>

				<!-- 本周指南卡片 -->
				<WeeklyGuideCard
					:weekInfo="heroWeekInfo"
					:daysUntilDue="heroDaysUntilDue"
				/>

				<!-- 孕期日历 -->
				<PregnancyCalendar
					:lmpDate="editLmpDate"
					:dueDate="heroDueDate"
					:hasRecord="pageHasRecord"
					:selectedDate="selectedDate"
					@selectDate="onSelectDate"
				/>

				<!-- 每日记录面板 -->
				<DayRecordPanel
					:selectedDate="selectedDate"
					:record="currentRecord"
					:lmpDate="editLmpDate"
					@edit="openEdit"
				/>
			</template>

			<!-- 待同步/冲突持久提示（family 模式）：真实冲突解决与重试入口 -->
			<view v-if="dataMode === 'family' && (familyPending > 0 || familyConflicts.length > 0)" class="sync-banner">
				<view class="sync-banner-row">
					<text class="sync-banner-title">{{ familyConflicts.length > 0 ? `${familyConflicts.length} 项冲突待处理` : `${familyPending} 项待同步` }}</text>
					<view v-if="familyPending > 0 && familyConflicts.length === 0" class="sync-banner-btn" @tap="handleFlushAll">
						<text class="sync-banner-btn-text">重试全部</text>
					</view>
				</view>
				<view v-for="c in familyConflicts" :key="c.id" class="conflict-row">
					<text class="conflict-text">{{ conflictLabel(c) }}（你的版本 r{{ c.expectedRevision }} → 云端 r{{ c.currentRevision }}）</text>
					<view v-for="d in conflictDiff(c)" :key="d.field" class="conflict-diff-row">
						<text class="conflict-diff-field">{{ d.field }}</text>
						<text class="conflict-diff-local">你：{{ d.local }}</text>
						<text class="conflict-diff-cloud">云端：{{ d.cloud }}</text>
					</view>
					<view class="conflict-actions">
						<view class="conflict-btn adopt" @tap="handleAdoptCloud(c.id)"><text class="conflict-btn-text">采用云端</text></view>
						<view class="conflict-btn resub" @tap="handleResubmit(c.id)"><text class="conflict-btn-text">重新提交</text></view>
					</view>
				</view>
			</view>

			<!-- 未确认身份/未建档：可操作入口（不依赖演示或旧 token） -->
			<view v-if="dataMode === 'unconfirmed'" class="section-card-style setup-guide" @tap="goFamilyEntry">
				<text class="setup-title">进入家庭空间</text>
				<text class="setup-desc">确认家庭成员身份后使用共享健康档案（或使用演示模式）</text>
			</view>
			<view v-else-if="dataMode === 'family' && !heroPregInfoSet" class="section-card-style setup-guide" @tap="goPregnancyForm">
				<text class="setup-title">填写孕期资料</text>
				<text class="setup-desc">补充末次月经/预产期，开启孕周、日历与记录</text>
			</view>

			<view class="bottom-spacer"></view>
		</scroll-view>

		<!-- 记录编辑弹窗 -->
		<RecordEditSheet
			v-if="heroPregInfoSet"
			:visible="editVisible"
			:mode="editMode"
			:record="currentRecord"
			:selectedDate="selectedDate"
			:lmpDate="editLmpDate"
			@update:visible="editVisible = $event"
			@save="handleSave"
		/>
		</template>
		<CustomTabBar :active="0" />
	</view>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { useHealthStore, getFruitComparison } from '@/stores/health.js'
import { isLoggedIn } from '@/utils/api.js'
import { getSessionState, foregroundRecheck, coldStartConfirm, isExplicitDemo, isExplicitLoggedOut } from '@/services/sessionService.js'
import { useFamilyStore } from '@/services/familyStore.js'
import { useStaticDataStore } from '@/stores/staticData.js'
import HomeHero from '@/components/home/HomeHero.vue'
import DailyChanges from '@/components/home/DailyChanges.vue'
import WeeklyGuideCard from '@/components/home/WeeklyGuideCard.vue'
import PregnancyCalendar from '@/components/common/PregnancyCalendar.vue'
import DayRecordPanel from '@/components/home/DayRecordPanel.vue'
import RecordEditSheet from '@/components/home/RecordEditSheet.vue'
import CustomTabBar from '@/components/CustomTabBar.vue'

const healthStore = useHealthStore()
const staticDataStore = useStaticDataStore()
const familyStore = useFamilyStore()

// B2a：正式模式数据源 = familyStore（身份确认后）；演示模式沿用演示 store
const dataMode = ref('unknown') // 'family' | 'demo' | 'unconfirmed'

const loading = ref(true)
const selectedDate = ref(new Date())
// 孕周/倒计时直接依赖 healthStore.today（生产时钟，见 famWeekInfo）
const editVisible = ref(false)
const editMode = ref('weight')
const dailySlides = ref([]) // 每日变化云端数据

const greeting = computed(() => {
	const base = healthStore.getGreeting()
	if (dataMode.value === 'demo') return `演示模式 · ${base}`
	if (dataMode.value === 'family') {
		const nickname = familyStore.pregnancy?.fields?.nickname || '妈妈'
		const hour = new Date().getHours()
		const hi = hour < 6 ? '夜深了' : hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好'
		return `${hi}，${nickname}`
	}
	return base
})

// 家庭模式孕周/倒计时（Asia/Shanghai 日号语义由服务端 dateKey 保证，本地按本地日）
// 上海日期 → 真实公历日序（UTC 日序）：Date.UTC(y,m,d)/86400000，
// 跨月/跨年/闰日均为正确日差（YYYYMMDD 整数相减不是日历运算）
function shanghaiDayOrdinal(date) {
  const sh = new Date(date.getTime() + (8 * 60 + date.getTimezoneOffset()) * 60000)
  return Date.UTC(sh.getFullYear(), sh.getMonth(), sh.getDate()) / 86400000
}
function shanghaiKeyToOrdinal(key) {
  const [y, m, d] = String(key).split('-').map(Number)
  return Date.UTC(y, m - 1, d) / 86400000
}

// 依赖 healthStore.today（App 分钟时钟 refreshToday 驱动的响应式时钟）：
// 停留页面跨上海午夜时时钟推进 → 孕周/倒计时自动重算（非本地午夜）
const famWeekInfo = computed(() => {
	void healthStore.today // 响应式依赖生产时钟
	const preg = familyStore.pregnancy
	const lmpKey = preg && preg.fields && preg.fields.lmpDate
	if (!lmpKey) return null
	const days = shanghaiDayOrdinal(healthStore.today) - shanghaiKeyToOrdinal(lmpKey)
	if (days < 0) return null
	return { week: Math.floor(days / 7), day: days % 7, total: days }
})
const famDaysUntilDue = computed(() => {
	void healthStore.today
	const preg = familyStore.pregnancy
	const dueKey = preg && preg.fields && preg.fields.dueDate
	if (!dueKey) return 0
	return Math.max(0, shanghaiKeyToOrdinal(dueKey) - shanghaiDayOrdinal(healthStore.today))
})
const famPregInfoSet = computed(() => {
	const preg = familyStore.pregnancy
	return Boolean(preg && preg.fields && (preg.fields.lmpDate || preg.fields.dueDate))
})

const heroWeekInfo = computed(() => dataMode.value === 'family'
	? (famWeekInfo.value || { week: 0, day: 0, total: 0 })
	: (healthStore.todayWeekInfo || { week: 0, day: 0, total: 0 }))
const heroDaysUntilDue = computed(() => dataMode.value === 'family' ? famDaysUntilDue.value : healthStore.daysUntilDue)
const heroFruit = computed(() => {
	if (dataMode.value !== 'family') return healthStore.fruitComparison
	const w = famWeekInfo.value
	if (!w) return { emoji: '🫘', name: '种子' }
	return getFruitComparison(w.week)
})
const pageHasRecord = (date) => {
	if (dataMode.value === 'family') {
		const key = dateKeyOf(date)
		const d = familyStore.dailyRecord(key)
		const m = familyStore.moodRecord(key)
		return Boolean((d && d.fields && Object.keys(d.fields).length) || (m && m.fields && Object.keys(m.fields).length))
	}
	return healthStore.hasRecord(date)
}

const editLmpDate = computed(() => {
	if (dataMode.value === 'family') {
		const lmp = familyStore.pregnancy?.fields?.lmpDate
		return lmp ? new Date(lmp + 'T00:00:00') : new Date()
	}
	return healthStore.lmpDate || new Date()
})

const heroDueDate = computed(() => {
	if (dataMode.value === 'family') {
		const due = familyStore.pregnancy?.fields?.dueDate
		return due ? new Date(due + 'T00:00:00') : null
	}
	return healthStore.dueDate
})

const heroPregInfoSet = computed(() => dataMode.value === 'family' ? famPregInfoSet.value : healthStore.pregInfoSet)

const currentRecord = computed(() => {
	if (dataMode.value === 'family') {
		const key = dateKeyOf(selectedDate.value)
		const d = familyStore.dailyRecord(key)
		const m = familyStore.moodRecord(key)
		const rec = {}
		if (d && d.fields) {
			if (d.fields.weightKg != null) rec.weight = String(d.fields.weightKg)
			if (d.fields.systolic != null && d.fields.diastolic != null) rec.bp = `${d.fields.systolic}/${d.fields.diastolic}`
			if (d.fields.fetalCount != null) rec.fetal = String(d.fields.fetalCount)
		}
		if (m && m.fields) {
			if (m.fields.mood) rec.mood = m.fields.mood
			if (Array.isArray(m.fields.symptoms)) rec.symptoms = m.fields.symptoms
			if (m.fields.note) rec.note = m.fields.note
			if (Array.isArray(m.fields.plans)) rec.plans = m.fields.plans
		}
		return rec
	}
	return healthStore.getRecord(selectedDate.value) || {}
})

onMounted(async () => {
	try {
		const session = getSessionState()
		if (isExplicitDemo()) {
			// 演示优先（即便此前有已确认会话）
			dataMode.value = 'demo'
			await Promise.all([
				healthStore.loadUserProfile(),
				healthStore.loadRecords()
			])
		} else if (session.status === 'confirmed') {
			// 正式模式：恢复成员快照并按需拉取（未确认前不加载任何成员数据）
			dataMode.value = 'family'
			familyStore.restoreFromCache()
			familyStore.pullAll().catch(() => {})
		} else if (session.status === 'rejected' || session.status === 'not-configured' || session.status === 'unavailable') {
			dataMode.value = 'unconfirmed'
		} else {
			// 冷启动未确认：先看演示态（旧演示会话），否则提示确认身份
			await Promise.all([
				healthStore.loadUserProfile(),
				healthStore.loadRecords()
			])
			if (isLoggedIn()) {
				dataMode.value = 'demo'
			} else {
				dataMode.value = 'unconfirmed'
			}
		}
		loadDailySlides()
	} catch (e) {
		console.error('首页数据加载失败:', e)
		dataMode.value = 'unconfirmed'
	} finally {
		loading.value = false
	}
})

async function loadDailySlides() {
		const wi = dataMode.value === 'family' ? famWeekInfo.value : healthStore.todayWeekInfo
		if (!wi) return
		if (!staticDataStore.loaded) await staticDataStore.loadData()
		const todayTotal = wi.total
		const minDay = Math.max(0, todayTotal - 2)
		const maxDay = todayTotal + 2
		dailySlides.value = staticDataStore.getDailyRange(minDay, maxDay)
	}

function onSelectDate(date) {
	selectedDate.value = new Date(date)
}

// 编辑基线：弹层打开时捕获当日 daily/mood 的 revision——后台刷新不改变基线，
// 保存按打开时版本提交，对方修改返回真实冲突而非静默覆盖
const editBaseline = { dailyRevision: 0, moodRevision: 0 }
function openEdit(mode) {
	editMode.value = mode
	if (dataMode.value === 'family') {
		const key = dateKeyOf(selectedDate.value)
		const d = familyStore.dailyRecord(key)
		const m = familyStore.moodRecord(key)
		editBaseline.dailyRevision = d ? d.revision : 0
		editBaseline.moodRevision = m ? m.revision : 0
	}
	editVisible.value = true
}

// Asia/Shanghai 日号（与 familyStore.todayKeyOf 同一公式；handleSave 传 Date
// 由 store 转换，此函数仅用于显示与选择日期）
function dateKeyOf(d) {
	const sh = new Date(d.getTime() + (8 * 60 + d.getTimezoneOffset()) * 60000)
	return `${sh.getFullYear()}-${String(sh.getMonth() + 1).padStart(2, '0')}-${String(sh.getDate()).padStart(2, '0')}`
}

// 记录保存路由：正式模式 → familyStore（共享数字 / 私人心情备注分开走云路径）；
// 演示模式 → 演示 store。失败保留弹层输入并如实提示（含待同步/冲突状态）
async function handleSave(data) {
	if (dataMode.value === 'family') {
		// 传 Date：由 familyStore.todayKeyOf 统一做 Asia/Shanghai 日号转换
		const date = selectedDate.value
		let result
		if ('weight' in data) {
			result = await familyStore.saveDaily(date, { weightKg: Number(data.weight) }, editBaseline.dailyRevision)
		} else if ('bp' in data) {
			const [systolic, diastolic] = String(data.bp).split('/').map(Number)
			result = await familyStore.saveDaily(date, { systolic, diastolic }, editBaseline.dailyRevision)
		} else if ('fetal' in data) {
			result = await familyStore.saveDaily(date, { fetalCount: Number(data.fetal) }, editBaseline.dailyRevision)
		} else if ('mood' in data || 'symptoms' in data) {
			result = await familyStore.saveMood(date, { mood: data.mood || null, symptoms: data.symptoms || [] }, editBaseline.moodRevision)
		} else if ('note' in data || 'plans' in data) {
			result = await familyStore.saveMood(date, { note: data.note || null, plans: data.plans || [] }, editBaseline.moodRevision)
		} else {
			return
		}
		if (result.ok) {
			editVisible.value = false
			uni.showToast({ title: result.replayed ? '已保存（幂等重放）' : '已保存并同步', icon: 'none' })
		} else if (result.code === 'revision-conflict') {
			uni.showToast({ title: '已被对方更新，请刷新后重试；输入已保留', icon: 'none', duration: 2500 })
		} else if (result.code === 'outbox-persist-failed') {
			uni.showToast({ title: result.message, icon: 'none', duration: 2500 })
		} else {
			uni.showToast({ title: `保存失败（${result.message || result.code}）；输入已保留`, icon: 'none', duration: 2500 })
		}
		return
	}
	// 演示模式（旧本地演示行为）
	const result = await healthStore.saveRecord(selectedDate.value, data)
	if (result && result.persisted) {
		editVisible.value = false
	} else {
		uni.showToast({ title: '本地保存失败，内容已保留，请重试', icon: 'none', duration: 2500 })
	}
}

function goProfile() {
	uni.switchTab({
		url: '/pages/profile/index'
	})
}

function onScrollBottom() {
	// 预留加载更多
}

// 回前台：family 模式拉取 + 冲突外待办重试；未确认时重新联网确认（确认前不展示成员缓存）
onShow(() => {
	const session = getSessionState()
	if (isExplicitDemo()) return // 演示优先：不确认不拉取正式数据
	if (isExplicitLoggedOut() && session.status !== 'confirmed') return
	if (session.status === 'confirmed' && !isExplicitLoggedOut()) {
		// 已确认会话：立即激活 family（权威状态同步可用），复核异步进行；
		// 复核发现成员变化由 sessionVersion watch 切换数据；拒绝锁定同样由 watch 清屏
		const wasFamily = dataMode.value === 'family'
		dataMode.value = 'family'
		if (!wasFamily) {
			familyStore.restoreFromCache()
			loadDailySlides()
		}
		foregroundRecheck().then(res => {
			if (!res || !res.ok) return // 拒绝已锁定/离线按暖离线保留
			familyStore.pullAll().catch(() => {})
			familyStore.flushAll().catch(() => {})
		}).catch(() => {})
	} else if (session.status === 'unconfirmed' && dataMode.value !== 'demo') {
		// 冷启动协调（复现20）：与 App.onShow 共享同一去重确认 Promise（只发一次
		// 网络请求）；持久标记触发联网确认，确认成功前不展示成员缓存
		coldStartConfirm().then(res => {
			if (res && res.ok) {
				dataMode.value = 'family'
				familyStore.restoreFromCache()
				familyStore.pullAll().catch(() => {})
				loadDailySlides()
			}
		}).catch(() => {})
	}
})

// 冲突解决与待办重试（真实处理器，走 familyStore→outbox→云函数）
const familyPending = computed(() => familyStore.pendingCount)
const familyConflicts = computed(() => familyStore.conflictEntries)

// 冲突比较值：本地提交 payload vs 云端 currentRecord（仅渲染当前成员可见字段；
// 墓碑显示"已删除"，显式清除显示"(已清除)"）
const FIELD_LABELS = { weightKg: '体重(kg)', systolic: '收缩压', diastolic: '舒张压', fetalCount: '胎动', sharedNote: '共享备注', note: '备注', mood: '心情', symptoms: '症状', plans: '计划', lmpDate: '末次月经', dueDate: '预产期', nickname: '昵称', babyNickname: '宝宝昵称', hospital: '医院', doctor: '医生', hospitalPhone: '联系电话', preWeightKg: '孕前体重', heightCm: '身高' }
const REPORT_FIELD_LABELS = { dateKey: '日期', reportType: '类型', archiveStatus: '归档状态', note: '备注' }
function conflictDiff(entry) {
  // 报告域冲突（B2b2）：本地 payload vs 云端 currentRecord 顶层字段
  if (entry.kind && entry.kind.startsWith('report')) {
    const p = entry.payload || {}
    const c = entry.currentRecord || {}
    const diffs = []
    const push = (field, mine, cloud) => {
      const label = REPORT_FIELD_LABELS[field] || field
      const localStr = mine === null || mine === undefined || mine === '' ? '(空)' : String(mine)
      let cloudStr
      if (c.deleted) cloudStr = '(云端已删除)'
      else if (cloud === undefined) cloudStr = '(未设置)'
      else if (cloud === null || cloud === '') cloudStr = '(空)'
      else cloudStr = String(cloud)
      diffs.push({ field: label, local: localStr, cloud: cloudStr })
    }
    push('dateKey', p.dateKey, c.dateKey)
    push('reportType', p.reportType, c.reportType)
    push('archiveStatus', p.archiveStatus, c.archiveStatus)
    push('note', p.note, c.note)
    return diffs
  }
  const diffs = []
  const localPayload = entry.payload || {}
  const cloudRecord = entry.currentRecord
  const cloudFields = cloudRecord && cloudRecord.fields ? cloudRecord.fields : {}
  for (const [field, localVal] of Object.entries(localPayload)) {
    const label = FIELD_LABELS[field] || field
    const localStr = localVal === null || localVal === '' ? '(已清除)' : (Array.isArray(localVal) ? JSON.stringify(localVal) : String(localVal))
    let cloudStr
    if (cloudRecord && cloudRecord.deleted) {
      cloudStr = '(云端已删除)'
    } else if (cloudFields[field] === undefined) {
      cloudStr = '(未设置)'
    } else if (cloudFields[field] === null || cloudFields[field] === '') {
      cloudStr = '(已清除)'
    } else if (Array.isArray(cloudFields[field])) {
      cloudStr = JSON.stringify(cloudFields[field])
    } else {
      cloudStr = String(cloudFields[field])
    }
    diffs.push({ field: label, local: localStr, cloud: cloudStr })
  }
  return diffs
}
function conflictLabel(entry) {
	if (entry.kind && entry.kind.startsWith('report')) return '报告'
	if (entry.kind === 'pregnancy') return '孕期资料'
	if (entry.kind === 'mood') return '私人心情/备注'
	return `健康记录 ${entry.extra && entry.extra.dateKey ? entry.extra.dateKey : ''}`
}
async function handleAdoptCloud(entryId) {
	const ok = await familyStore.adoptCloud(entryId)
	uni.showToast({ title: ok ? '已采用云端版本' : '操作失败，请重试', icon: 'none', duration: 2000 })
}
async function handleResubmit(entryId) {
	const r = await familyStore.resubmit(entryId)
	uni.showToast({ title: r.ok ? '已重新提交' : (r.code === 'revision-conflict' ? '仍冲突，请采用云端' : `提交失败（${r.code}）`), icon: 'none', duration: 2200 })
}
async function handleFlushAll() {
	const r = await familyStore.flushAll()
	uni.showToast({ title: r.ok ? '已重试待同步项' : (r.message || '重试失败'), icon: 'none', duration: 2200 })
}

function goFamilyEntry() {
	uni.navigateTo({ url: '/pages/family/index' })
}
function goPregnancyForm() {
	uni.navigateTo({ url: '/pages/profile/pregnancy-info' })
}
</script>

<style scoped lang="scss">
.page {
	display: flex;
	flex-direction: column;
	height: 100vh;
	background-color: #FBF7F2;
	box-sizing: border-box;
}

.scroll-content {
	flex: 1;
	padding-bottom: 20rpx;
}

.bottom-spacer {
	height: calc(120rpx + env(safe-area-inset-bottom));
}

/* ── 同步/冲突提示条 ── */
.sync-banner {
	margin: 16rpx 24rpx 0;
	background: #FEF4E3;
	border: 2rpx solid rgba(240, 169, 64, 0.4);
	border-radius: 20rpx;
	padding: 20rpx 24rpx;
}
.sync-banner-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
}
.sync-banner-title {
	font-size: 26rpx;
	font-weight: 600;
	color: #B07818;
}
.sync-banner-btn {
	background: #F0A940;
	border-radius: 999rpx;
	padding: 8rpx 24rpx;
}
.sync-banner-btn-text {
	font-size: 22rpx;
	color: #FFFFFF;
	font-weight: 600;
}
.conflict-row {
	margin-top: 16rpx;
	padding-top: 16rpx;
	border-top: 2rpx solid rgba(240, 169, 64, 0.25);
}
.conflict-text {
	display: block;
	font-size: 22rpx;
	color: #B07818;
	margin-bottom: 10rpx;
}
.conflict-diff-row {
	display: flex;
	gap: 12rpx;
	align-items: baseline;
	margin-bottom: 6rpx;
}
.conflict-diff-field {
	font-size: 22rpx;
	font-weight: 600;
	color: #8A5A10;
	min-width: 120rpx;
}
.conflict-diff-local {
	font-size: 22rpx;
	color: #C2185B;
	flex: 1;
}
.conflict-diff-cloud {
	font-size: 22rpx;
	color: #2E7D32;
	flex: 1;
}

.conflict-actions {
	display: flex;
	gap: 16rpx;
}
.conflict-btn {
	border-radius: 999rpx;
	padding: 8rpx 28rpx;
}
.conflict-btn.adopt { background: #F2F0EE; }
.conflict-btn.resub { background: #C2185B; }
.conflict-btn.adopt .conflict-btn-text { color: #6E6A64; }
.conflict-btn.resub .conflict-btn-text { color: #FFFFFF; }
.conflict-btn-text {
	font-size: 22rpx;
	font-weight: 600;
}

/* ── Loading ── */
.loading-container {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	height: 100vh;
	background-color: #FBF7F2;
}

.loading-spinner {
	width: 64rpx;
	height: 64rpx;
	border: 6rpx solid #F2F0EE;
	border-top-color: #C45070;
	border-radius: 50%;
	animation: spin 0.8s linear infinite;
	margin-bottom: 24rpx;
}

@keyframes spin {
	to { transform: rotate(360deg); }
}

.loading-text {
	font-size: 28rpx;
	color: #9C9890;
}
</style>
