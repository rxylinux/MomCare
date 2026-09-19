<template>
  <view class="page">
    <!-- Hero 区域 -->
    <view class="hero">
      <NavBar title="血压记录" theme="dark" transparent class="hero-navbar"></NavBar>

      <!-- Hero 内容 -->
      <view class="hero-content" v-if="stats.count > 0">
        <text class="hero-label">最新血压</text>
        <view class="hero-value-row">
          <text class="hero-value">{{ stats.latest }}</text>
          <text class="hero-unit">mmHg</text>
        </view>
        <text class="hero-sub">收缩压 {{ stats.systolic }} · 舒张压 {{ stats.diastolic }} · 脉压差 {{ stats.systolic - stats.diastolic }}</text>
        <view class="hero-chips">
          <view class="chip chip-normal">
            <text class="chip-text">正常参考 &lt;140/90</text>
          </view>
          <view class="chip" :class="stats.status === '正常' ? 'chip-status-normal' : 'chip-status-warn'">
            <text class="chip-text">血压{{ stats.status }}</text>
          </view>
        </view>
      </view>
      <!-- 无数据 Hero -->
      <view class="hero-content" v-else>
        <text class="hero-label">暂无血压记录</text>
        <text class="hero-sub">去首页开始记录血压吧</text>
      </view>
    </view>

    <!-- 滚动内容区 -->
    <scroll-view scroll-y class="scroll-content">
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
          >
            <view class="history-left">
              <view class="history-dot" :style="{ backgroundColor: item.dotColor }"></view>
              <view class="history-info">
                <text class="history-date">{{ item.dateDisplay }}</text>
                <text class="history-week">{{ item.week }}</text>
              </view>
            </view>
            <view class="history-right">
              <text class="history-value">{{ item.systolic }}/{{ item.diastolic }}</text>
              <text class="history-unit-label">mmHg</text>
              <view class="history-badge" :class="item.statusClass">
                <text class="history-badge-text">{{ item.status }}</text>
              </view>
            </view>
          </view>
        </view>
      </view>

      <!-- 空状态 -->
      <view class="section-card empty-state" v-if="stats.count === 0">
        <view class="empty-icon">💗</view>
        <text class="empty-title">暂无血压记录</text>
        <text class="empty-desc">在首页日历中选择日期，记录血压数据</text>
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

// 从 store 获取统计数据
const famBpEntries = computed(() => {
  if (dataSource.value !== 'family') return []
  return familyStore.dailyHistoryAsc()
    .map(r => ({
      date: r.dateKey,
      systolic: r.fields && r.fields.systolic != null ? Number(r.fields.systolic) : null,
      diastolic: r.fields && r.fields.diastolic != null ? Number(r.fields.diastolic) : null
    }))
    .filter(e => e.systolic != null && e.diastolic != null)
    .slice().reverse()
})
const famBpStats = computed(() => {
  const entries = famBpEntries.value
  if (entries.length === 0) return { latest: null, status: '', count: 0 }
  // famBpEntries 已按日期降序（最新在前）——最新 = 第一条
  const last = entries[0]
  return {
    latest: `${last.systolic}/${last.diastolic}`,
    status: last.systolic >= 140 || last.diastolic >= 90 ? '偏高' : '正常',
    systolic: last.systolic, diastolic: last.diastolic,
    count: entries.length
  }
})
const stats = computed(() => {
  if (dataSource.value === 'family') return famBpStats.value
  if (dataSource.value === 'demo') return healthStore.getBpStats()
  return { latest: null, status: '', count: 0 } // prompt：空态不读旧 store
})

// 从 store 获取历史记录
const historyList = computed(() => {
  if (dataSource.value === 'family') {
    return famBpEntries.value.map(e => ({
      date: e.date, dateDisplay: e.date, week: '',
      systolic: String(e.systolic), diastolic: String(e.diastolic),
      bpText: `${e.systolic}/${e.diastolic}`,
      status: e.systolic >= 140 || e.diastolic >= 90 ? '偏高' : '正常',
      statusClass: e.systolic >= 140 || e.diastolic >= 90 ? 'badge-high' : 'badge-normal'
    }))
  }
  if (dataSource.value !== 'demo') return []
  const list = healthStore.getBpHistory()
  return list.map(item => ({
    ...item,
    dotColor: item.status === '正常' ? '#4CAF82' : '#F0A940'
  }))
})

function goHome() {
  uni.switchTab({ url: '/pages/index/index' })
}
</script>

<style scoped lang="scss">
page {
  --sky: #3A70A8;
  --sky-light: #EBF2FB;
  --sky-mid: #5B8FC9;
  --sky-pale: #A0C8F0;
  --green: #4CAF82;
  --green-light: #EAF7EF;
  --amber: #F0A940;
  --amber-light: #FEF4E3;
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
  background: linear-gradient(155deg, #3A70A8 0%, #5B8FC9 45%, #A0C8F0 100%);
  position: relative;
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

.chip-status-normal {
  background: rgba(76, 175, 130, 0.35);
}

.chip-status-warn {
  background: rgba(240, 169, 64, 0.35);
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

.history-badge {
  padding: 4rpx 20rpx;
  border-radius: 999rpx;
}

.badge-normal {
  background: #EAF7EF;
}

.badge-high {
  background: #FEF4E3;
}

.history-badge-text {
  font-size: 22rpx;
  font-weight: 600;
}

.badge-normal .history-badge-text {
  color: #4CAF82;
}

.badge-high .history-badge-text {
  color: #F0A940;
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
  background: linear-gradient(135deg, #3A70A8, #5B8FC9);
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
</style>
