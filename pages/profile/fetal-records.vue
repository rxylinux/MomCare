<template>
  <view class="page">
    <!-- Hero 区域 -->
    <view class="hero">
      <NavBar title="胎动记录" theme="dark" transparent class="hero-navbar" />

      <view class="hero-content" v-if="stats.count > 0">
        <text class="hero-label">今日总计</text>
        <text class="hero-count">{{ stats.today }}次</text>
        <text class="hero-sub">已记录 {{ stats.count }} 天 · 昨日 {{ stats.yesterday }}次</text>
        <view class="hero-chips">
          <view class="chip chip-normal">
            <text class="chip-text">日正常 ≥10次</text>
          </view>
          <view class="chip" :class="stats.today >= 10 ? 'chip-status-normal' : 'chip-status-warn'">
            <text class="chip-text">{{ stats.today >= 10 ? '正常' : '偏少' }}</text>
          </view>
        </view>
      </view>
      <view class="hero-content" v-else>
        <text class="hero-label">暂无胎动记录</text>
        <text class="hero-sub">去首页开始记录胎动吧</text>
      </view>
    </view>

    <!-- 滚动区域 -->
    <scroll-view scroll-y class="scroll-content">
      <!-- 胎动热力图 -->
      <view class="heatmap-card" v-if="stats.count > 0">
        <view class="heatmap-header">
          <text class="heatmap-title">{{ fetalData.heatmap.month + 1 }}月胎动热力图</text>
          <view class="heatmap-legend">
            <text class="legend-label">少</text>
            <view class="legend-block heat-0"></view>
            <view class="legend-block heat-1"></view>
            <view class="legend-block heat-2"></view>
            <view class="legend-block heat-3"></view>
            <view class="legend-block heat-4"></view>
            <text class="legend-label">多</text>
          </view>
        </view>

        <!-- 星期头 -->
        <view class="heatmap-week-header">
          <text
            v-for="day in weekDays"
            :key="day"
            class="week-day-text"
          >{{ day }}</text>
        </view>

        <!-- 日期网格 -->
        <view class="heatmap-grid">
          <view
            v-for="n in fetalData.heatmap.firstDayOfWeek"
            :key="'empty-' + n"
            class="heatmap-cell heatmap-cell-empty"
          ></view>
          <view
            v-for="(item, idx) in fetalData.heatmap.data"
            :key="'day-' + idx"
            class="heatmap-cell"
            :class="[item.heatClass, { 'heatmap-cell-today': item.isToday }]"
          >
            <text class="cell-day">{{ item.day }}</text>
          </view>
        </view>
      </view>

      <!-- 空状态 -->
      <view class="section-card empty-state" v-if="stats.count === 0">
        <view class="empty-icon">👣</view>
        <text class="empty-title">暂无胎动记录</text>
        <text class="empty-desc">在首页日历中选择日期，记录胎动数据</text>
        <view class="empty-btn" @tap="goHome">
          <text class="empty-btn-text">去首页记录</text>
        </view>
      </view>

      <view class="bottom-spacer"></view>
    </scroll-view>
  </view>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useHealthStore } from '@/stores/health.js'
import { getSessionState, subscribeSession, isExplicitDemo, isExplicitLoggedOut } from '@/services/sessionService.js'
import { useFamilyStore } from '@/services/familyStore.js'
import NavBar from '@/components/NavBar.vue'

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

const weekDays = ['日', '一', '二', '三', '四', '五', '六']

// 从 store 获取统计数据
const famFetalEntries = computed(() => {
  if (dataSource.value !== 'family') return []
  // 区分"明确记录 0"与"未记录"：fetalCount 字段存在（含 0）即为已记录
  return familyStore.dailyHistoryAsc()
    .filter(r => r.fields && r.fields.fetalCount !== undefined)
    .map(r => ({ date: r.dateKey, count: Number(r.fields.fetalCount) }))
})

// 正式热力图：从权威源记录生成模板需要的形状（month/firstDayOfWeek/data），
// 与旧 store 热力图同构；月份基于记录的上海日号
const famFetalHeatmap = computed(() => {
  const entries = famFetalEntries.value
  if (entries.length === 0) return null
  // 取最新记录月份（dateKey YYYY-MM-DD）
  const latest = entries[entries.length - 1].date
  const [y, m] = latest.split('-').map(Number)
  const daysInMonth = new Date(y, m, 0).getDate()
  const firstDayOfWeek = new Date(y, m - 1, 1).getDay()
  const byDate = {}
  for (const e of entries) byDate[e.date] = e.count
  void healthStore.today // 与 stats 同一响应式上海时钟（跨日重算 isToday）
  const todaySh = new Date(healthStore.today.getTime() + (8 * 60 + healthStore.today.getTimezoneOffset()) * 60000)
  const todayKey = `${todaySh.getFullYear()}-${String(todaySh.getMonth() + 1).padStart(2, '0')}-${String(todaySh.getDate()).padStart(2, '0')}`
  const data = []
  for (let d = 1; d <= daysInMonth; d++) {
    const dk = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    const count = byDate[dk] !== undefined ? byDate[dk] : 0
    data.push({ day: d, count, heatClass: count > 0 ? 'heat-1' : 'heat-0', isToday: dk === todayKey })
  }
  return { year: y, month: m - 1, daysInMonth, firstDayOfWeek, data }
})
const todayKeyStr = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` })()
const famFetalStats = computed(() => {
  void healthStore.today // 响应式跨日：App 时钟推进时今日/昨日重算
  const entries = famFetalEntries.value // 已含明确 0（不再过滤）
  const todaySh = new Date(healthStore.today.getTime() + (8 * 60 + healthStore.today.getTimezoneOffset()) * 60000)
  const tk = `${todaySh.getFullYear()}-${String(todaySh.getMonth()+1).padStart(2,'0')}-${String(todaySh.getDate()).padStart(2,'0')}`
  const ySh = new Date(todaySh.getTime() - 86400000)
  const yk = `${ySh.getFullYear()}-${String(ySh.getMonth()+1).padStart(2,'0')}-${String(ySh.getDate()).padStart(2,'0')}`
  return {
    today: entries.find(e => e.date === tk)?.count ?? 0,
    yesterday: entries.find(e => e.date === yk)?.count ?? 0,
    count: entries.length
  }
})
const stats = computed(() => {
  if (dataSource.value === 'family') return famFetalStats.value
  if (dataSource.value === 'demo') return healthStore.getFetalStats()
  return { today: 0, yesterday: 0, count: 0 } // prompt：空态不读旧 store
})

// 从 store 获取胎动历史和热力图数据
const fetalData = computed(() => {
  if (dataSource.value === 'family') {
    return {
      // 已记录条目（含 0）降序；未记录日期不出现（count>0 过滤已移除）
      entries: famFetalEntries.value.slice().reverse().map(e => ({ date: e.date, dateDisplay: e.date, week: '', count: e.count })),
      heatmap: famFetalHeatmap.value
    }
  }
  if (dataSource.value !== 'demo') return { entries: [], heatmap: null }
  return healthStore.getFetalHistory()
})

function goHome() {
  uni.switchTab({ url: '/pages/index/index' })
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

/* Hero */
.hero {
  flex-shrink: 0;
  background: linear-gradient(155deg, #4A7A64 0%, #7BA08C 45%, #B0D0C0 100%);
  padding-bottom: 48rpx;
}



.hero-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 24rpx 32rpx 0;
}

.hero-label {
  font-size: 26rpx;
  color: rgba(255, 255, 255, 0.8);
  margin-bottom: 8rpx;
}

.hero-count {
  font-size: 80rpx;
  font-weight: 700;
  color: #FFFFFF;
  line-height: 1.1;
  margin-bottom: 12rpx;
}

.hero-sub {
  font-size: 24rpx;
  color: rgba(255, 255, 255, 0.7);
  margin-bottom: 24rpx;
}

.hero-chips {
  display: flex;
  gap: 16rpx;
}

.chip {
  padding: 8rpx 20rpx;
  border-radius: 24rpx;
}

.chip-normal {
  background: rgba(255, 255, 255, 0.2);
}

.chip-status-normal {
  background: rgba(76, 175, 130, 0.35);
}

.chip-status-warn {
  background: rgba(232, 120, 152, 0.35);
}

.chip-text {
  font-size: 22rpx;
  color: rgba(255, 255, 255, 0.9);
}

/* Scroll */
.scroll-content {
  flex: 1;
}

/* Heatmap Card */
.heatmap-card {
  background: #FFFFFF;
  border-radius: 32rpx;
  box-shadow: 0 4rpx 28rpx rgba(60, 30, 10, 0.07);
  margin: 24rpx 24rpx 0;
  padding: 32rpx;
}

.heatmap-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24rpx;
}

.heatmap-title {
  font-size: 30rpx;
  font-weight: 600;
  color: #3A3834;
}

.heatmap-legend {
  display: flex;
  align-items: center;
  gap: 6rpx;
}

.legend-label {
  font-size: 20rpx;
  color: #9B9590;
}

.legend-block {
  width: 24rpx;
  height: 24rpx;
  border-radius: 6rpx;
}

.heatmap-week-header {
  display: flex;
  margin-bottom: 8rpx;
}

.week-day-text {
  flex: 1;
  text-align: center;
  font-size: 22rpx;
  color: #9B9590;
  font-weight: 500;
}

.heatmap-grid {
  display: flex;
  flex-wrap: wrap;
}

.heatmap-cell {
  width: calc(100% / 7);
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8rpx;
  box-sizing: border-box;
  position: relative;
}

.heatmap-cell-empty {
  background: transparent;
}

.heatmap-cell-today {
  border: 4rpx solid #E87898;
}

.cell-day {
  font-size: 22rpx;
  color: #6B6560;
  font-weight: 500;
}

/* Heat levels */
.heat-0 {
  background: #F2F0EE;
}

.heat-1 {
  background: #FFF0F3;
}

.heat-2 {
  background: #FFD8E3;
}

.heat-3 {
  background: #F5A0B8;
}

.heat-4 {
  background: #E87898;

  .cell-day {
    color: #FFFFFF;
  }
}

/* ── Empty State ── */
.section-card {
  background: #FFFFFF;
  border-radius: 32rpx;
  box-shadow: 0 4rpx 28rpx rgba(60, 30, 10, 0.07);
  overflow: hidden;
  margin: 24rpx 24rpx 0;
  padding: 32rpx;
}

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
  background: linear-gradient(135deg, #4A7A64, #7BA08C);
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

.bottom-spacer {
  height: 120rpx;
}
</style>
