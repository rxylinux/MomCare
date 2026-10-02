<template>
	<view class="page">
		<view class="head">
			<text class="title">孕期食谱</text>
			<text class="subtitle">孕周 → 营养重点 → 今天吃什么 · 本地菜谱库离线可查</text>
		</view>

		<!-- 阶段卡：自动定位（已登记末次月经）或手动切换（未登记不猜，零假安全口径） -->
		<view class="stage-card">
			<view class="stage-row">
				<text class="stage-label">{{ currentStage ? currentStage.label : '' }}</text>
				<text v-if="weekInfo" class="stage-week">孕{{ weekInfo.week }}周+{{ weekInfo.day }}</text>
			</view>
			<text class="stage-note">{{ currentStage ? currentStage.stageNote : '' }}</text>
			<view v-if="!weekInfo" class="stage-hint">
				<text class="stage-hint-text">未登记末次月经，已默认孕早期——请手动选择阶段或去档案页完善孕周信息</text>
			</view>
			<scroll-view scroll-x class="stage-switch">
				<view class="stage-switch-row">
					<view
						v-for="st in stageList"
						:key="st.key"
						class="stage-pill"
						:class="{ active: stageKey === st.key }"
						@tap="setStage(st.key)"
					>
						<text class="stage-pill-text" :class="{ active: stageKey === st.key }">{{ st.label }}</text>
					</view>
				</view>
			</scroll-view>
		</view>

		<!-- 今日三餐卡：无状态确定性轮换（同一天打开组合相同；频率受限菜永不自动入选） -->
		<view class="meals-card">
			<view class="meals-head">
				<text class="meals-title">今日三餐</text>
				<view class="meals-mode">
					<text class="meals-mode-text">{{ meals.mode === 'weekend' ? '周末 · 现做鲜货' : '工作日 · 午餐带饭友好' }}</text>
				</view>
			</view>
			<view class="meal-row" v-for="m in mealRows" :key="m.slot">
				<text class="meal-slot">{{ m.slotLabel }}</text>
				<text class="meal-name">{{ m.recipe ? m.recipe.name : '本阶段暂无推荐' }}</text>
				<text class="meal-tag" v-if="m.recipe">{{ primaryOf(m.recipe) }}</text>
			</view>
			<view class="meals-foot">
				<text class="meals-focus" v-if="meals.focusTags.length">今日主打：{{ meals.focusTags.map(nutrientName).join(' · ') }}</text>
				<view class="meals-shuffle" @tap="shuffleOffset++">
					<text class="meals-shuffle-text">换一组</text>
				</view>
			</view>
		</view>

		<!-- 营养重点胶囊：点开看"为什么补 + 食物量口径（主展示）+ 数值来源" -->
		<scroll-view scroll-x class="nutrient-scroll">
			<view class="nutrient-row">
				<view
					v-for="nut in stageFocusNutrients"
					:key="nut.key"
					class="nutrient-pill"
					:class="{ active: openNutrient === nut.key }"
					@tap="toggleNutrient(nut.key)"
				>
					<text class="nutrient-pill-text" :class="{ active: openNutrient === nut.key }">{{ nut.name }}</text>
				</view>
			</view>
		</scroll-view>
		<view v-if="openNutrientInfo" class="nutrient-panel">
			<text class="nutrient-why">{{ openNutrientInfo.why }}</text>
			<text class="nutrient-guide">{{ openNutrientInfo.foodGuide }}</text>
			<text class="nutrient-ref">{{ openNutrientInfo.reference }}</text>
		</view>

		<!-- tab + 带饭筛选 -->
		<view class="tabs">
			<view v-for="t in TABS" :key="t.key" class="tab" :class="{ active: tab === t.key }" @tap="tab = t.key">
				<text class="tab-text" :class="{ active: tab === t.key }">{{ t.label }}</text>
			</view>
		</view>
		<view v-if="tab !== 'search'" class="bento-row" @tap="bentoOnly = !bentoOnly">
			<text class="bento-text" :class="{ active: bentoOnly }">🍱 只看适合带饭（{{ bentoCount }} 道）</text>
		</view>

		<!-- 搜索框（搜索 tab） -->
		<view v-if="tab === 'search'" class="search-row">
			<input
				class="search-input"
				v-model="keyword"
				placeholder="搜菜名或食材，如：牛肉、豆腐、鱼"
				placeholder-class="search-placeholder"
				confirm-type="search"
			/>
			<view v-if="keyword" class="search-clear" @tap="clearKeyword">
				<text class="search-clear-text">✕</text>
			</view>
		</view>

		<!-- 分组卡片流（本阶段视图） -->
		<view v-if="tab === 'stage'">
			<view v-for="group in stageGroups" :key="group.key">
				<text class="group-head">{{ group.label }}（{{ group.items.length }}）</text>
				<view v-for="item in group.items" :key="item.id" class="card">
					<view class="card-head" @tap="toggleDetail(item.id)">
						<text class="card-name">{{ item.name }}</text>
						<view class="card-tags">
							<text class="mini-tag">{{ mealLabel(item) }}</text>
							<text class="mini-tag nutrient" v-if="primaryOf(item)">{{ primaryOf(item) }}</text>
						</view>
						<text class="card-arrow">{{ expanded[item.id] ? '收起' : '详情' }}</text>
					</view>
					<text class="card-summary">{{ item.summary }}</text>
					<view v-if="expanded[item.id]" class="card-detail">
						<view class="detail-block">
							<text class="detail-label">食材</text>
							<text class="detail-text">{{ item.ingredients.map(i => `${i.name} ${i.amount}`).join('；') }}</text>
						</view>
						<view class="detail-block">
							<text class="detail-label">做法</text>
							<text class="detail-text">{{ item.steps.join(' → ') }}</text>
						</view>
						<view class="detail-block">
							<text class="detail-label">营养说明</text>
							<text class="detail-text">{{ item.nutritionNote }}</text>
						</view>
						<view class="detail-block" v-if="item.cautions && item.cautions.length">
							<text class="detail-label warn">注意</text>
							<text class="detail-text warn" v-for="(c, i) in item.cautions" :key="i">· {{ c }}</text>
						</view>
					</view>
				</view>
			</view>
		</view>

		<!-- 全部视图（平铺） -->
		<view v-else-if="tab === 'all'">
			<view v-for="item in allList" :key="item.id" class="card">
				<view class="card-head" @tap="toggleDetail(item.id)">
					<text class="card-name">{{ item.name }}</text>
					<view class="card-tags">
						<text class="mini-tag">{{ mealLabel(item) }}</text>
						<text class="mini-tag nutrient" v-if="primaryOf(item)">{{ primaryOf(item) }}</text>
					</view>
					<text class="card-arrow">{{ expanded[item.id] ? '收起' : '详情' }}</text>
				</view>
				<text class="card-summary">{{ item.summary }}</text>
				<view v-if="expanded[item.id]" class="card-detail">
					<view class="detail-block">
						<text class="detail-label">食材</text>
						<text class="detail-text">{{ item.ingredients.map(i => `${i.name} ${i.amount}`).join('；') }}</text>
					</view>
					<view class="detail-block">
						<text class="detail-label">做法</text>
						<text class="detail-text">{{ item.steps.join(' → ') }}</text>
					</view>
					<view class="detail-block">
						<text class="detail-label">营养说明</text>
						<text class="detail-text">{{ item.nutritionNote }}</text>
					</view>
					<view class="detail-block" v-if="item.cautions && item.cautions.length">
						<text class="detail-label warn">注意</text>
						<text class="detail-text warn" v-for="(c, i) in item.cautions" :key="i">· {{ c }}</text>
					</view>
				</view>
			</view>
		</view>

		<!-- 搜索视图 + 三态空态（诚实口径） -->
		<view v-else>
			<view v-if="searchResults.length > 0">
				<view v-for="item in searchResults" :key="item.id" class="card">
					<view class="card-head" @tap="toggleDetail(item.id)">
						<text class="card-name">{{ item.name }}</text>
						<view class="card-tags">
							<text class="mini-tag">{{ mealLabel(item) }}</text>
							<text class="mini-tag nutrient" v-if="primaryOf(item)">{{ primaryOf(item) }}</text>
						</view>
						<text class="card-arrow">{{ expanded[item.id] ? '收起' : '详情' }}</text>
					</view>
					<text class="card-summary">{{ item.summary }}</text>
					<view v-if="expanded[item.id]" class="card-detail">
						<view class="detail-block">
							<text class="detail-label">食材</text>
							<text class="detail-text">{{ item.ingredients.map(i => `${i.name} ${i.amount}`).join('；') }}</text>
						</view>
						<view class="detail-block">
							<text class="detail-label">做法</text>
							<text class="detail-text">{{ item.steps.join(' → ') }}</text>
						</view>
						<view class="detail-block">
							<text class="detail-label">营养说明</text>
							<text class="detail-text">{{ item.nutritionNote }}</text>
						</view>
						<view class="detail-block" v-if="item.cautions && item.cautions.length">
							<text class="detail-label warn">注意</text>
							<text class="detail-text warn" v-for="(c, i) in item.cautions" :key="i">· {{ c }}</text>
						</view>
					</view>
				</view>
			</view>
			<view v-else-if="keyword.trim() !== ''" class="empty-card">
				<text class="empty-title">未收录此菜品</text>
				<text class="empty-desc">菜谱库（92 道）未查到「{{ keyword.trim() }}」——可换个说法再搜（如搜食材"豆腐"），或到饮食安全速查确认某种食材能不能吃</text>
			</view>
			<view v-else class="empty-card">
				<text class="empty-title">搜索菜谱</text>
				<text class="empty-desc">输入菜名或食材名称，如：鲈鱼、菠菜、豆腐、牛肉</text>
			</view>
		</view>

		<!-- 底部医学免责声明（固定渲染） -->
		<view class="footer-disclaimer">
			<text class="footer-text">{{ DISCLAIMER }}</text>
		</view>
	</view>
</template>

<script setup>
import { ref, computed, reactive } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { useHealthStore } from '@/stores/health.js'
import {
	RECIPE_NUTRIENTS, RECIPE_STAGES, RECIPE_ENTRIES,
	getStageByWeek, getStageFocus, listRecipes, searchRecipes, buildDailyMeals
} from '@/services/toolsStore.js'

// 孕期食谱页：阶段定位 → 今日三餐（确定性轮换）→ 营养重点 → 分组菜谱 → 卡片展开。
// 全部检索/轮换逻辑在 toolsStore 纯函数区（可测），本页只做渲染与交互态。
const healthStore = useHealthStore()

const DISCLAIMER = '本页内容仅供健康教育参考，不构成医疗诊断、处方或个体化建议；最终请以产检医生的意见为准。'
const TABS = [
	{ key: 'stage', label: '本阶段' },
	{ key: 'all', label: '全部' },
	{ key: 'search', label: '搜索' }
]
const SLOT_LABELS = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' }

const stageKey = ref('early')
const tab = ref('stage')
const keyword = ref('')
const bentoOnly = ref(false)
const openNutrient = ref('')
const shuffleOffset = ref(0)
const expanded = reactive({})
const manualStage = ref(false)

const stageList = RECIPE_STAGES
const weekInfo = computed(() => healthStore.todayWeekInfo)
const currentStage = computed(() => RECIPE_STAGES.find(s => s.key === stageKey.value) || null)
const stageFocusNutrients = computed(() => {
	const focus = getStageFocus(stageKey.value)
	return focus ? focus.nutrients : []
})
const openNutrientInfo = computed(() => RECIPE_NUTRIENTS.find(n => n.key === openNutrient.value) || null)

// 今日三餐：dateKey/weekday 取本机当天（渲染确定性由纯函数保证）
const meals = computed(() => {
	const now = new Date()
	const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
	const week = weekInfo.value ? weekInfo.value.week : stageDefaultWeek(stageKey.value)
	return buildDailyMeals({ dateKey, week, weekday: now.getDay(), shuffleOffset: shuffleOffset.value })
})
const mealRows = computed(() => [
	{ slot: 'breakfast', slotLabel: '早餐', recipe: meals.value.breakfast },
	{ slot: 'lunch', slotLabel: '午餐', recipe: meals.value.lunch },
	{ slot: 'dinner', slotLabel: '晚餐', recipe: meals.value.dinner },
	{ slot: 'snack', slotLabel: '加餐', recipe: meals.value.snack }
])

const bentoCount = computed(() => listRecipes(stageKey.value).filter(r => r.bentoFriendly).length)

// 本阶段分组：按段 priority 顺序聚拢（"补铁 8 道"组头），不命中 priority 的进"其他"
const stageGroups = computed(() => {
	const focus = getStageFocus(stageKey.value)
	const pool = listRecipes(stageKey.value).filter(r => !bentoOnly.value || r.bentoFriendly)
	if (!focus) return [{ key: 'all', label: '全部', items: pool }]
	const groups = []
	for (const nut of focus.nutrients) {
		const items = pool.filter(r => r.nutrients.some(n => n.key === nut.key && n.weight === 'primary'))
		if (items.length) groups.push({ key: nut.key, label: `主打${nut.name}`, items })
	}
	const rest = pool.filter(r => !groups.some(g => g.items.includes(r)))
	if (rest.length) groups.push({ key: 'rest', label: '其他', items: rest })
	return groups
})

const allList = computed(() => RECIPE_ENTRIES.filter(r => !bentoOnly.value || r.bentoFriendly))
const searchResults = computed(() => searchRecipes({ keyword: keyword.value }))

function stageDefaultWeek(key) {
	const st = RECIPE_STAGES.find(s => s.key === key)
	return st ? st.range[0] : 1
}
function nutrientName(key) {
	const n = RECIPE_NUTRIENTS.find(x => x.key === key)
	return n ? n.name : key
}
function primaryOf(recipe) {
	const p = (recipe.nutrients || []).find(n => n.weight === 'primary')
	return p ? nutrientName(p.key) : ''
}
function mealLabel(recipe) {
	return (recipe.mealType || []).map(m => SLOT_LABELS[m] || m).join('/')
}
function toggleDetail(id) {
	expanded[id] = !expanded[id]
}
function setStage(key) {
	manualStage.value = true // 手动切换后 onShow 不再覆盖（自动定位只作用于未手动干预时）
	stageKey.value = key
}
function toggleNutrient(key) {
	openNutrient.value = openNutrient.value === key ? '' : key
}
function clearKeyword() {
	keyword.value = ''
}

onShow(() => {
	// 已登记末次月经且用户未手动切换 → 自动定位周段；登记了不覆盖手动选择
	if (weekInfo.value && !manualStage.value) stageKey.value = getStageByWeek(weekInfo.value.week)
})
</script>

<style>
.page {
	min-height: 100vh;
	background: #f5f7fb;
	padding-bottom: 200rpx;
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
.stage-card {
	margin: 24rpx 32rpx 0;
	padding: 28rpx;
	border-radius: 24rpx;
	background: linear-gradient(135deg, #4a7cf7, #6a5cf7);
	box-shadow: 0 8rpx 24rpx rgba(74, 124, 247, 0.25);
}
.stage-row {
	display: flex;
	flex-direction: row;
	align-items: center;
	justify-content: space-between;
}
.stage-label {
	font-size: 34rpx;
	font-weight: 700;
	color: #ffffff;
}
.stage-week {
	font-size: 26rpx;
	font-weight: 600;
	color: rgba(255, 255, 255, 0.9);
}
.stage-note {
	display: block;
	margin-top: 10rpx;
	font-size: 24rpx;
	color: rgba(255, 255, 255, 0.85);
	line-height: 1.6;
}
.stage-hint {
	margin-top: 12rpx;
}
.stage-hint-text {
	font-size: 22rpx;
	color: rgba(255, 255, 255, 0.75);
	line-height: 1.5;
}
.stage-switch {
	margin-top: 16rpx;
	white-space: nowrap;
}
.stage-switch-row {
	display: flex;
	flex-direction: row;
	gap: 12rpx;
}
.stage-pill {
	padding: 8rpx 24rpx;
	border-radius: 999rpx;
	background: rgba(255, 255, 255, 0.18);
	border: 2rpx solid rgba(255, 255, 255, 0.35);
}
.stage-pill.active {
	background: #ffffff;
	border-color: #ffffff;
}
.stage-pill-text {
	font-size: 22rpx;
	color: rgba(255, 255, 255, 0.9);
}
.stage-pill-text.active {
	color: #4a7cf7;
	font-weight: 700;
}
.meals-card {
	margin: 24rpx 32rpx 0;
	padding: 28rpx;
	border-radius: 24rpx;
	background: #ffffff;
	box-shadow: 0 4rpx 20rpx rgba(17, 22, 34, 0.06);
}
.meals-head {
	display: flex;
	flex-direction: row;
	align-items: center;
	justify-content: space-between;
}
.meals-title {
	font-size: 30rpx;
	font-weight: 700;
	color: #11222e;
}
.meals-mode {
	padding: 6rpx 18rpx;
	border-radius: 999rpx;
	background: #eef3fe;
}
.meals-mode-text {
	font-size: 20rpx;
	color: #4a7cf7;
}
.meal-row {
	display: flex;
	flex-direction: row;
	align-items: center;
	gap: 16rpx;
	padding: 14rpx 0;
	border-bottom: 1rpx solid #f5f7fb;
}
.meal-slot {
	width: 80rpx;
	font-size: 24rpx;
	color: #8a94a6;
}
.meal-name {
	flex: 1;
	font-size: 26rpx;
	font-weight: 600;
	color: #11222e;
}
.meal-tag {
	font-size: 20rpx;
	color: #6a5cf7;
	background: #f3f0ff;
	border-radius: 999rpx;
	padding: 4rpx 16rpx;
}
.meals-foot {
	display: flex;
	flex-direction: row;
	align-items: center;
	justify-content: space-between;
	margin-top: 14rpx;
}
.meals-focus {
	font-size: 22rpx;
	color: #4a7cf7;
}
.meals-shuffle {
	padding: 10rpx 28rpx;
	border-radius: 999rpx;
	background: linear-gradient(90deg, #4a7cf7, #6a5cf7);
}
.meals-shuffle-text {
	font-size: 22rpx;
	font-weight: 600;
	color: #ffffff;
}
.nutrient-scroll {
	margin-top: 24rpx;
	white-space: nowrap;
}
.nutrient-row {
	display: flex;
	flex-direction: row;
	gap: 16rpx;
	padding: 0 32rpx;
}
.nutrient-pill {
	padding: 10rpx 28rpx;
	border-radius: 999rpx;
	background: #ffffff;
	border: 2rpx solid #e3e8f0;
}
.nutrient-pill.active {
	background: #eef3fe;
	border-color: #4a7cf7;
}
.nutrient-pill-text {
	font-size: 24rpx;
	color: #46536a;
}
.nutrient-pill-text.active {
	color: #4a7cf7;
	font-weight: 600;
}
.nutrient-panel {
	margin: 20rpx 32rpx 0;
	padding: 24rpx;
	border-radius: 24rpx;
	background: #ffffff;
	box-shadow: 0 4rpx 20rpx rgba(17, 22, 34, 0.06);
	display: flex;
	flex-direction: column;
}
.nutrient-why {
	font-size: 24rpx;
	color: #8a94a6;
	line-height: 1.6;
}
.nutrient-guide {
	margin-top: 12rpx;
	font-size: 28rpx;
	font-weight: 600;
	color: #11222e;
	line-height: 1.6;
}
.nutrient-ref {
	margin-top: 12rpx;
	font-size: 22rpx;
	color: #8a94a6;
	line-height: 1.6;
}
.tabs {
	display: flex;
	flex-direction: row;
	margin: 24rpx 32rpx 0;
	padding: 8rpx;
	border-radius: 999rpx;
	background: #ffffff;
	box-shadow: 0 4rpx 20rpx rgba(17, 22, 34, 0.06);
}
.tab {
	flex: 1;
	padding: 14rpx 0;
	border-radius: 999rpx;
	display: flex;
	justify-content: center;
}
.tab.active {
	background: linear-gradient(90deg, #4a7cf7, #6a5cf7);
}
.tab-text {
	font-size: 26rpx;
	color: #46536a;
}
.tab-text.active {
	color: #ffffff;
	font-weight: 600;
}
.bento-row {
	margin: 16rpx 32rpx 0;
	padding: 12rpx 24rpx;
	border-radius: 999rpx;
	background: #ffffff;
	border: 2rpx dashed #d4dcec;
	display: flex;
	align-items: center;
}
.bento-text {
	font-size: 24rpx;
	color: #8a94a6;
}
.bento-text.active {
	color: #4a7cf7;
	font-weight: 600;
}
.search-row {
	display: flex;
	flex-direction: row;
	align-items: center;
	margin: 24rpx 32rpx 0;
	padding: 0 24rpx;
	border-radius: 999rpx;
	background: #ffffff;
	box-shadow: 0 4rpx 20rpx rgba(17, 22, 34, 0.06);
}
.search-input {
	flex: 1;
	height: 88rpx;
	font-size: 28rpx;
	color: #2a3444;
}
.search-placeholder {
	color: #b6bfce;
}
.search-clear {
	width: 56rpx;
	height: 56rpx;
	border-radius: 50%;
	background: #eef1f6;
	display: flex;
	align-items: center;
	justify-content: center;
}
.search-clear-text {
	font-size: 26rpx;
	color: #8a94a6;
}
.group-head {
	display: block;
	margin: 28rpx 32rpx 0;
	font-size: 26rpx;
	font-weight: 700;
	color: #46536a;
}
.card {
	margin: 16rpx 32rpx 0;
	padding: 28rpx;
	border-radius: 24rpx;
	background: #ffffff;
	box-shadow: 0 4rpx 20rpx rgba(17, 22, 34, 0.06);
}
.card-head {
	display: flex;
	flex-direction: row;
	align-items: center;
	gap: 16rpx;
}
.card-name {
	flex: 1;
	font-size: 30rpx;
	font-weight: 600;
	color: #11222e;
}
.card-tags {
	display: flex;
	flex-direction: row;
	gap: 8rpx;
}
.mini-tag {
	font-size: 20rpx;
	color: #8a94a6;
	background: #f2f5fa;
	border-radius: 999rpx;
	padding: 4rpx 14rpx;
}
.mini-tag.nutrient {
	color: #6a5cf7;
	background: #f3f0ff;
}
.card-arrow {
	font-size: 22rpx;
	color: #4a7cf7;
}
.card-summary {
	display: block;
	margin-top: 14rpx;
	font-size: 26rpx;
	color: #2a3444;
	line-height: 1.6;
}
.card-detail {
	margin-top: 18rpx;
	padding-top: 18rpx;
	border-top: 1rpx solid #f0f3f8;
}
.detail-block {
	margin-bottom: 16rpx;
	display: flex;
	flex-direction: column;
}
.detail-label {
	font-size: 22rpx;
	color: #8a94a6;
	margin-bottom: 6rpx;
}
.detail-label.warn {
	color: #c0453f;
}
.detail-text {
	font-size: 24rpx;
	color: #46536a;
	line-height: 1.6;
}
.detail-text.warn {
	color: #a03a35;
}
.empty-card {
	margin: 40rpx 32rpx 0;
	padding: 48rpx 32rpx;
	border-radius: 24rpx;
	background: #ffffff;
	border: 2rpx dashed #d4dcec;
	display: flex;
	flex-direction: column;
	align-items: center;
}
.empty-title {
	font-size: 30rpx;
	font-weight: 600;
	color: #2a3444;
}
.empty-desc {
	margin-top: 12rpx;
	font-size: 24rpx;
	color: #8a94a6;
	text-align: center;
	line-height: 1.6;
}
.footer-disclaimer {
	position: fixed;
	left: 0;
	right: 0;
	bottom: 0;
	padding: 20rpx 32rpx calc(20rpx + env(safe-area-inset-bottom));
	background: rgba(255, 255, 255, 0.96);
	border-top: 1rpx solid #eef1f6;
}
.footer-text {
	font-size: 22rpx;
	color: #8a94a6;
	line-height: 1.6;
}
</style>
