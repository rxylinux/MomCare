<template>
  <view class="page">
    <!-- Hero 区域 -->
    <view class="hero">
      <!-- 导航栏 -->
      <NavBar title="体重记录" theme="dark" transparent class="hero-navbar"></NavBar>

      <!-- Hero 内容 -->
      <view class="hero-content" v-if="stats.count > 0">
        <text class="hero-label">最新体重</text>
        <view class="hero-value-row">
          <text class="hero-value">{{ stats.latest }}</text>
          <text class="hero-unit">kg</text>
        </view>
        <text class="hero-sub" v-if="stats.preWeight">孕前体重 {{ stats.preWeight }}kg · 孕期增重 {{ stats.gain }}kg</text>
        <text class="hero-sub" v-else>暂未设置孕前体重</text>
        <view class="hero-chips">
          <view class="chip chip-who">
            <text class="chip-text">WHO 推荐增重范围</text>
          </view>
          <view class="chip chip-progress">
            <text class="chip-text">{{ stats.gain && parseFloat(stats.gain) >= 0 ? '增重正常' : '需关注' }}</text>
          </view>
        </view>
        <view v-if="dataSource === 'family'" class="hero-add-btn" @tap="openAdd">
          <text class="hero-add-btn-text">＋ 记一笔（可选日期）</text>
        </view>
      </view>
      <!-- 无数据 Hero -->
      <view class="hero-content" v-else>
        <text class="hero-label">暂无体重记录</text>
        <text class="hero-sub">去首页开始记录体重吧</text>
        <view v-if="dataSource === 'family'" class="hero-add-btn" @tap="openAdd">
          <text class="hero-add-btn-text">＋ 记一笔（可选日期）</text>
        </view>
      </view>
    </view>

    <!-- 滚动内容区 -->
    <scroll-view scroll-y class="scroll-content">
      <!-- 有数据时显示图表 -->
      <view v-if="stats.count > 0" class="section-card chart-card">
        <view class="section-header">
          <text class="section-title">体重趋势</text>
          <view class="range-tabs">
            <view
              v-for="(tab, idx) in rangeTabs"
              :key="idx"
              class="range-tab"
              :class="{ 'range-tab-active': activeRange === idx }"
              @tap="activeRange = idx"
            >
              <text class="range-tab-text" :class="{ 'range-tab-text-active': activeRange === idx }">{{ tab }}</text>
            </view>
          </view>
        </view>

        <!-- 占位图表 -->
        <view class="chart-placeholder">
          <view class="chart-area">
            <view class="chart-who-zone"></view>
            <view class="chart-line-container">
              <view
                v-for="(pt, idx) in chartPoints"
                :key="'pt-' + idx"
                class="mock-point"
                :style="{ left: pt.x + '%', bottom: pt.y + '%' }"
              ></view>
            </view>
            <view class="chart-y-labels">
              <text class="chart-y-label">{{ yLabels[0] }}</text>
              <text class="chart-y-label">{{ yLabels[1] }}</text>
              <text class="chart-y-label">{{ yLabels[2] }}</text>
            </view>
          </view>
        </view>

        <view class="chart-hint">
          <view class="hint-dot"></view>
          <text class="hint-text">绿色区域为 WHO 推荐增重范围</text>
        </view>
      </view>

      <!-- 历史记录 -->
      <view class="section-card" v-if="historyList.length > 0">
        <view class="section-header">
          <text class="section-title">历史记录</text>
        </view>
        <view class="history-list">
          <view
            v-for="(item, idx) in historyList"
            :key="idx"
            class="history-item"
            :class="{ 'history-item-editable': dataSource === 'family' }"
            @tap="dataSource === 'family' && openEdit(item)"
          >
            <view class="history-left">
              <view class="history-dot" :style="{ backgroundColor: item.dotColor }"></view>
              <view class="history-info">
                <text class="history-date">{{ item.dateDisplay }}</text>
                <text class="history-week">{{ item.week }}</text>
              </view>
            </view>
            <view class="history-right">
              <text class="history-value">{{ item.weight }}</text>
              <text class="history-unit-label">kg</text>
              <view class="history-diff" :class="item.diffClass">
                <text class="history-diff-text">{{ item.diff }}</text>
              </view>
            </view>
          </view>
        </view>
      </view>

      <!-- 空状态 -->
      <view class="section-card empty-state" v-if="stats.count === 0">
        <view class="empty-icon">⚖️</view>
        <text class="empty-title">暂无体重记录</text>
        <text class="empty-desc">在首页日历中选择日期，记录体重数据</text>
        <view class="empty-btn" @tap="goHome">
          <text class="empty-btn-text">去首页记录</text>
        </view>
      </view>

      <view class="bottom-spacer"></view>
    </scroll-view>

    <!-- 按日编辑/补录/删除（family 权威通道；demo 只读） -->
    <DayRecordEditSheet
      v-model:visible="editSheet.visible"
      :mode="editSheet.mode"
      :date-key="editSheet.dateKey"
      :initial="editSheet.initial"
      :exists="editSheet.exists"
      @save="handleSheetSave"
      @remove="handleSheetRemove"
    />
  </view>
</template>

<script setup>
import { ref, computed, onMounted, watch, reactive } from 'vue'
import { useHealthStore } from '@/stores/health.js'
import { getSessionState, subscribeSession, isExplicitDemo, isExplicitLoggedOut } from '@/services/sessionService.js'
import { useFamilyStore } from '@/services/familyStore.js'
import NavBar from '@/components/NavBar.vue'
import DayRecordEditSheet from '@/components/DayRecordEditSheet.vue'

console.log('[weight-records] setup start')
const healthStore = useHealthStore()
const familyStore = useFamilyStore()
const dataSource = ref(isExplicitDemo() ? 'demo' : (getSessionState().status === 'confirmed' && !isExplicitLoggedOut() ? 'family' : 'prompt'))
// 响应式会话门控：权威会话失效（退出/锁定/切换）立即离开 family 展示
const __sessionVersion = subscribeSession()
watch(__sessionVersion, () => {
  dataSource.value = isExplicitDemo() ? 'demo' : (getSessionState().status === 'confirmed' && !isExplicitLoggedOut() ? 'family' : 'prompt')
})
if (dataSource.value === 'family') {
  familyStore.restoreFromCache()
  familyStore.pullAll().catch(() => {})
}
console.log('[weight-records] store ready')

onMounted(() => {
  console.log('[weight-records] page onMounted')
})

// 范围选项卡
const rangeTabs = ['1月', '3月', '全程']
const activeRange = ref(1)

// 数据源：正式=家庭云（权威），演示=旧演示 store，未确认=空
const famStats = computed(() => {
  if (dataSource.value !== 'family') return null
  const hist = familyStore.dailyHistoryAsc().map(r => ({
    date: r.dateKey, weight: r.fields && r.fields.weightKg != null ? String(r.fields.weightKg) : ''
  })).filter(r => r.weight !== '')
  if (hist.length === 0) return { latest: null, gain: null, count: 0 }
  const latest = hist[hist.length - 1].weight
  const pre = familyStore.pregnancy && familyStore.pregnancy.fields && familyStore.pregnancy.fields.preWeightKg
  let gain = null
  if (pre) gain = (parseFloat(latest) - Number(pre)).toFixed(1)
  return { latest: parseFloat(latest).toFixed(1), gain: gain !== null ? (gain >= 0 ? `+${gain}` : gain) : null, count: hist.length, preWeight: pre || null }
})

// 从 store 获取统计数据
const stats = computed(() => {
  if (dataSource.value === 'family') return famStats.value
  if (dataSource.value === 'demo') return healthStore.getWeightStats()
  return { latest: null, gain: null, count: 0, preWeight: null }
})

// 历史（权威源转换）——revision 随行：编辑/删除的版本基线（点击时快照，提交带基线防覆盖对端并发修改）
const famHistory = computed(() => {
  if (dataSource.value !== 'family') return []
  const hist = familyStore.dailyHistoryAsc().map(r => ({
    date: r.dateKey, weight: r.fields && r.fields.weightKg != null ? String(r.fields.weightKg) : '', revision: r.revision || 0
  })).filter(r => r.weight !== '')
  return hist.slice().reverse().map((h, i, arr) => {
    const prev = arr[i + 1]
    const diff = prev ? (parseFloat(h.weight) - parseFloat(prev.weight)).toFixed(1) : null
    return { ...h, dateDisplay: h.date, diff: diff === null ? '±0' : (diff >= 0 ? `+${diff}` : diff) }
  })
})

// 从 store 获取历史记录
const historyList = computed(() => {
  if (dataSource.value === 'family') {
    return famHistory.value.map(item => ({
      ...item,
      dotColor: parseFloat(item.diff) > 0 ? '#C45070' : parseFloat(item.diff) < 0 ? '#4CAF82' : '#9C9890'
    }))
  }
  if (dataSource.value !== 'demo') return [] // family 已在上方返回；prompt/rejected 空
  const list = healthStore.getWeightHistory()
  return list.map(item => ({
    ...item,
    dotColor: parseFloat(item.diff) > 0 ? '#C45070' : parseFloat(item.diff) < 0 ? '#4CAF82' : '#9C9890'
  }))
})

// 生成图表点位（正式=权威源，演示=旧 store）
const chartSource = computed(() => {
  if (dataSource.value === 'family') return famHistory.value
  if (dataSource.value === 'demo') return healthStore.getWeightHistory()
  return []
})
const chartPoints = computed(() => {
  const list = chartSource.value
  if (list.length === 0) return []

  const reversed = [...list].reverse()
  const weights = reversed.map(r => parseFloat(r.weight))
  const minW = Math.min(...weights)
  const maxW = Math.max(...weights)
  const range = maxW - minW || 1

  return reversed.map((r, i) => {
    const x = list.length === 1 ? 50 : (i / (list.length - 1)) * 80 + 5
    const y = ((parseFloat(r.weight) - minW) / range) * 60 + 20
    return { x, y }
  })
})

// Y 轴标签
const yLabels = computed(() => {
  const list = chartSource.value
  if (list.length === 0) return ['--', '--', '--']
  const weights = list.map(r => parseFloat(r.weight))
  const maxW = Math.ceil(Math.max(...weights))
  const minW = Math.floor(Math.min(...weights))
  const mid = Math.round((maxW + minW) / 2)
  return [String(maxW), String(mid), String(minW)]
})

function goHome() {
  uni.switchTab({ url: '/pages/index/index' })
}

// ── 按日编辑/补录/删除（family 权威通道；demo 只读不挂编辑交互）──
const editSheet = reactive({
  visible: false, mode: 'weight', dateKey: '', initial: {}, exists: false, revision: 0
})
function todayKeyLocal() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function openAdd() {
  if (dataSource.value !== 'family') return
  editSheet.mode = 'weight'
  editSheet.dateKey = todayKeyLocal()
  editSheet.initial = {}
  editSheet.exists = false
  editSheet.revision = 0
  editSheet.visible = true
}
function openEdit(item) {
  editSheet.mode = 'weight'
  editSheet.dateKey = item.date
  editSheet.initial = { value: item.weight }
  editSheet.exists = true
  editSheet.revision = item.revision || 0
  editSheet.visible = true
}
function conflictToast() {
  uni.showToast({ title: '已被对方更新，请刷新后重试', icon: 'none', duration: 2500 })
}
async function handleSheetSave({ dateKey, originalDateKey, payload }) {
  if (originalDateKey && originalDateKey !== dateKey) {
    // 挪日：目标日先写入（基线=目标日当前版本），成功后清除原日该字段
    // （两步独立提交；第二步失败如实提示，待同步队列重试或手动处理）
    const target = familyStore.dailyRecord(dateKey)
    const r1 = await familyStore.saveDaily(dateKey, payload, target ? (target.revision || 0) : 0)
    if (!r1.ok) {
      if (r1.code === 'revision-conflict') conflictToast()
      else uni.showToast({ title: '保存失败，请稍后重试', icon: 'none' })
      return
    }
    editSheet.visible = false
    const r2 = await familyStore.saveDaily(originalDateKey, { weightKg: null }, editSheet.revision)
    if (!r2.ok && r2.code !== 'outbox-persist-failed') {
      uni.showToast({ title: '已记录到新日期；原日期清除未完成，请稍后重试', icon: 'none', duration: 2500 })
    }
    return
  }
  const r = await familyStore.saveDaily(dateKey, payload, editSheet.revision)
  if (r.ok) {
    editSheet.visible = false
    uni.showToast({ title: r.replayed ? '已保存（幂等重放）' : '已保存并同步', icon: 'none' })
  } else if (r.code === 'revision-conflict') {
    conflictToast()
  } else {
    uni.showToast({ title: '保存失败，请稍后重试', icon: 'none' })
  }
}
async function handleSheetRemove({ dateKey }) {
  // 字段级清除：同日的血压/胎动/备注不受影响
  const r = await familyStore.saveDaily(dateKey, { weightKg: null }, editSheet.revision)
  if (r.ok) {
    editSheet.visible = false
    uni.showToast({ title: '已删除并同步', icon: 'none' })
  } else if (r.code === 'revision-conflict') {
    conflictToast()
  } else {
    uni.showToast({ title: '删除失败，请稍后重试', icon: 'none' })
  }
}
</script>

<style scoped lang="scss">
page {
  --rose: #C45070;
  --rose-light: #FDEEF1;
  --rose-mid: #E07898;
  --rose-pale: #F4C0CC;
  --sky: #3A70A8;
  --green: #4CAF82;
  --green-light: #EAF7EF;
  --amber: #F0A940;
  --gray-50: #FAF9F8;
  --gray-100: #F2F0EE;
  --gray-200: #E4E1DC;
  --gray-300: #C8C4BC;
  --gray-400: #9C9890;
  --gray-500: #6E6A64;
  --gray-700: #3A3834;
  --gray-900: #1C1A17;
}

.page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background-color: #FBF7F2;
  box-sizing: border-box;
}

/* ── Hero ── */
.hero {
  flex-shrink: 0;
  background: linear-gradient(155deg, #C45070 0%, #E07898 40%, #F4C0CC 100%);
  border-radius: 0 0 40rpx 40rpx;
  overflow: hidden;
}



.hero-content {
  padding: 16rpx 40rpx 44rpx;
}

.hero-label {
  font-size: 26rpx;
  color: rgba(255, 255, 255, 0.75);
  display: block;
  margin-bottom: 8rpx;
}

.hero-value-row {
  display: flex;
  align-items: baseline;
  gap: 8rpx;
  margin-bottom: 12rpx;
}

.hero-value {
  font-size: 80rpx;
  font-weight: 700;
  color: #FFFFFF;
  line-height: 1;
}

.hero-unit {
  font-size: 32rpx;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.8);
}

.hero-sub {
  font-size: 24rpx;
  color: rgba(255, 255, 255, 0.7);
  display: block;
  margin-bottom: 24rpx;
}

.hero-chips {
  display: flex;
  gap: 16rpx;
  flex-wrap: wrap;
}

.chip {
  padding: 8rpx 24rpx;
  border-radius: 999rpx;
  background: rgba(255, 255, 255, 0.2);
}

.chip-text {
  font-size: 22rpx;
  color: rgba(255, 255, 255, 0.9);
  font-weight: 500;
}

/* ── Scroll Content ── */
.scroll-content {
  flex: 1;
  padding-bottom: 20rpx;
}

.section-card {
  background: #FFFFFF;
  border-radius: 32rpx;
  box-shadow: 0 4rpx 28rpx rgba(60, 30, 10, 0.07);
  overflow: hidden;
  margin: 24rpx 24rpx 0;
  padding: 32rpx;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 28rpx;
}

.section-title {
  font-size: 32rpx;
  font-weight: 600;
  color: #1C1A17;
}

/* ── Range Tabs ── */
.range-tabs {
  display: flex;
  background: #F2F0EE;
  border-radius: 999rpx;
  padding: 4rpx;
}

.range-tab {
  padding: 8rpx 24rpx;
  border-radius: 999rpx;
}

.range-tab-active {
  background: #FFFFFF;
  box-shadow: 0 2rpx 12rpx rgba(0, 0, 0, 0.08);
}

.range-tab-text {
  font-size: 24rpx;
  color: #9C9890;
  font-weight: 500;
}

.range-tab-text-active {
  color: #C45070;
  font-weight: 600;
}

/* ── Chart Placeholder ── */
.chart-placeholder {
  margin-bottom: 20rpx;
}

.chart-area {
  position: relative;
  height: 320rpx;
  background: #FAF9F8;
  border-radius: 20rpx;
  overflow: hidden;
}

.chart-who-zone {
  position: absolute;
  left: 60rpx;
  right: 20rpx;
  top: 20%;
  bottom: 30%;
  background: rgba(76, 175, 130, 0.1);
  border-top: 2rpx dashed rgba(76, 175, 130, 0.3);
  border-bottom: 2rpx dashed rgba(76, 175, 130, 0.3);
  border-radius: 8rpx;
}

.chart-line-container {
  position: absolute;
  left: 60rpx;
  right: 20rpx;
  top: 0;
  bottom: 0;
}

.mock-point {
  position: absolute;
  width: 16rpx;
  height: 16rpx;
  border-radius: 50%;
  background: #C45070;
  border: 3rpx solid #FFFFFF;
  box-shadow: 0 2rpx 8rpx rgba(196, 80, 112, 0.3);
  z-index: 2;
}

.chart-y-labels {
  position: absolute;
  left: 8rpx;
  top: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 16rpx 0;
}

.chart-y-label {
  font-size: 20rpx;
  color: #C8C4BC;
}

.chart-hint {
  display: flex;
  align-items: center;
  gap: 12rpx;
  padding-top: 16rpx;
}

.hint-dot {
  width: 20rpx;
  height: 20rpx;
  border-radius: 6rpx;
  background: rgba(76, 175, 130, 0.25);
  border: 2rpx solid rgba(76, 175, 130, 0.5);
}

.hint-text {
  font-size: 22rpx;
  color: #9C9890;
}

/* ── History List ── */
.history-list {
  display: flex;
  flex-direction: column;
}

.history-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 24rpx 0;
  border-bottom: 1px solid #F2F0EE;
}

.history-item:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.history-left {
  display: flex;
  align-items: center;
  gap: 20rpx;
}

.history-dot {
  width: 20rpx;
  height: 20rpx;
  border-radius: 50%;
  flex-shrink: 0;
}

.history-info {
  display: flex;
  flex-direction: column;
  gap: 4rpx;
}

.history-date {
  font-size: 28rpx;
  font-weight: 600;
  color: #1C1A17;
}

.history-week {
  font-size: 22rpx;
  color: #9C9890;
}

.history-right {
  display: flex;
  align-items: center;
  gap: 8rpx;
}

.history-value {
  font-size: 32rpx;
  font-weight: 700;
  color: #1C1A17;
}

.history-unit-label {
  font-size: 22rpx;
  color: #9C9890;
  margin-right: 12rpx;
}

.history-diff {
  padding: 4rpx 16rpx;
  border-radius: 999rpx;
}

.diff-up {
  background: #FDEEF1;
}

.diff-down {
  background: #EAF7EF;
}

.diff-zero {
  background: #F2F0EE;
}

.history-diff-text {
  font-size: 22rpx;
  font-weight: 600;
}

.diff-up .history-diff-text {
  color: #C45070;
}

.diff-down .history-diff-text {
  color: #4CAF82;
}

.diff-zero .history-diff-text {
  color: #9C9890;
}

/* ── Empty State ── */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 60rpx 32rpx;
}

.empty-icon {
  font-size: 80rpx;
  margin-bottom: 24rpx;
}

.empty-title {
  font-size: 32rpx;
  font-weight: 600;
  color: #1C1A17;
  margin-bottom: 12rpx;
}

.empty-desc {
  font-size: 26rpx;
  color: #9C9890;
  text-align: center;
  margin-bottom: 40rpx;
}

.empty-btn {
  background: linear-gradient(135deg, #C45070, #E07898);
  border-radius: 48rpx;
  padding: 20rpx 64rpx;
}

.empty-btn:active {
  opacity: 0.85;
}

.empty-btn-text {
  font-size: 28rpx;
  color: #FFFFFF;
  font-weight: 600;
}

/* ── Bottom Spacer ── */
.bottom-spacer {
  height: 120rpx;
}

/* ── 按日编辑/补录入口 ── */
.hero-add-btn {
  margin-top: 24rpx;
  padding: 16rpx 40rpx;
  border-radius: 999rpx;
  border: 3rpx solid rgba(255, 255, 255, 0.6);
  background: rgba(255, 255, 255, 0.16);
  align-self: flex-start;
}
.hero-add-btn:active { opacity: 0.8; }
.hero-add-btn-text {
  font-size: 24rpx;
  font-weight: 600;
  color: #FFFFFF;
}
.history-item-editable:active {
  background: #FAF9F8;
  border-radius: 16rpx;
}
</style>
