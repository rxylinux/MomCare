<template>
  <view class="sec">
    <view class="card">
      <!-- Navigation header -->
      <view class="daily-nav">
        <view class="d-nav-btn" @tap="slideDay(-1)">
          <text class="d-nav-arrow">‹</text>
        </view>
        <view class="d-nav-center">
          <view class="d-nav-main">
            <text>{{ navLabel }}</text>
            <text v-if="isCurrentToday" class="today-chip">今天</text>
          </view>
          <view class="d-nav-sub">{{ navDate }}</view>
        </view>
        <view class="d-nav-right">
          <view v-if="!isCurrentToday" class="back-day-btn" @tap="goToday">
            <text class="back-day-text">回今天</text>
          </view>
          <view class="d-nav-btn" @tap="slideDay(1)">
            <text class="d-nav-arrow">›</text>
          </view>
        </view>
      </view>

      <!-- Swiper -->
      <swiper
        class="slides-outer"
        :current="currentIndex"
        :duration="300"
        :circular="false"
        @animationfinish="onSwiperChange"
      >
        <swiper-item v-for="(slide, sIdx) in slides" :key="sIdx">
          <view class="slide">
            <view class="ditem-row">
              <!-- Baby change -->
              <view class="ditem baby" @tap="goDetail">
                <view class="di-header">
                  <text class="di-icon">👶</text>
                  <text class="di-lbl">宝宝</text>
                </view>
                <text class="di-text">{{ slide.baby.text }}</text>
              </view>
              <!-- Mom change -->
              <view class="ditem mom" @tap="goDetail">
                <view class="di-header">
                  <text class="di-icon">💆</text>
                  <text class="di-lbl">妈妈</text>
                </view>
                <text class="di-text">{{ slide.mom.text }}</text>
              </view>
            </view>
            <!-- Daily tip -->
            <view class="ditem tip">
              <view class="di-header">
                <text class="di-icon">{{ slide.tip.icon }}</text>
                <text class="di-lbl">今日提醒</text>
                <view v-if="slide.tipTag" class="tip-tag">
                  <text class="tip-tag-text">{{ slide.tipTag }}</text>
                </view>
              </view>
              <text class="di-text">{{ slide.tip.text }}</text>
            </view>
          </view>
        </swiper-item>
      </swiper>

      <!-- Pagination dots -->
      <view class="slide-dots">
        <view
          v-for="i in 5"
          :key="i"
          class="sdot"
          :class="{ active: i - 1 === currentIndex }"
        ></view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { navigateToPage } from '@/utils/navigation.js'

const props = defineProps({
  weekInfo: {
    type: Object,
    default: () => ({ week: 32, day: 3, total: 226 })
  },
  selectedDate: {
    type: Date,
    default: () => new Date()
  },
  slidesData: {
    type: Array,
    default: () => []
  },
  // 今日提醒瀑布覆盖（utils/dailyTipCore.buildTodayTip 产出：
  // {tag,icon,text} | null）——null/无 text 时回落静态内容库，行为与旧版一致
  todayTip: {
    type: Object,
    default: null
  }
})

// Current slide index: 0-4, where 2 = today
const currentIndex = ref(2)

// Offset from today (-2 to +2)
const offset = computed(() => currentIndex.value - 2)

// Whether the currently viewed slide is "today"
const isCurrentToday = computed(() => offset.value === 0)

// Generate date for a given offset from today
function getDateByOffset(off) {
  const d = new Date(props.selectedDate)
  d.setDate(d.getDate() + off)
  return d
}

// Format date label for navigation header
function formatDate(date) {
  const y = date.getFullYear()
  const m = date.getMonth() + 1
  const d = date.getDate()
  return `${y}年${m}月${d}日`
}

// Navigation label: shows current slide's week/day info
const navLabel = computed(() => {
  const baseTotal = props.weekInfo.total
  const adjustedTotal = baseTotal + offset.value
  if (adjustedTotal >= 0) {
    const week = Math.floor(adjustedTotal / 7)
    const day = adjustedTotal % 7
    return `孕 ${week} 周 ${day} 天`
  }
  return `孕 ${props.weekInfo.week} 周 ${props.weekInfo.day} 天`
})

// Navigation date string
const navDate = computed(() => {
  const date = getDateByOffset(offset.value)
  return formatDate(date)
})

// 数据缺位占位（2026-10-01 死代码清理：原 MOCK_DATA/WEEKLY_CHANGES/FALLBACK 三块
// 本地兜底在词库 v2 随包分发后永不可达，且 FALLBACK 内为旧口径文案——一并移除，
// 换单一诚实占位。正常情况打包静态库恒在，此占位仅防御数据链异常）
const PLACEHOLDER = {
	baby: { icon: '🌱', text: '当日数据待更新' },
	mom: { icon: '💆', text: '当日数据待更新' },
	tip: { icon: '💡', text: '当日内容待更新' }
}

function cloudToSlide(record) {
  return {
    baby: { icon: record.baby_icon || '👶', text: record.baby_detail || record.baby_summary || '' },
    mom: { icon: record.mom_icon || '💆', text: record.mom_detail || record.mom_summary || '' },
    tip: { icon: record.tip_icon || '💡', text: record.tip_text || '' },
    totalDays: record.total_days
  }
}

const slides = computed(() => {
	const baseTotal = props.weekInfo.total
	const cloudMap = {}
	for (const r of props.slidesData) {
		cloudMap[r.total_days] = cloudToSlide(r)
	}
	const baseSlides = [-2, -1, 0, 1, 2].map(off => {
		const dayTotal = baseTotal + off
		return (dayTotal >= 0 && cloudMap[dayTotal]) || PLACEHOLDER
	})
	// 瀑布覆盖只作用于"今天"这一屏（offset 0）——左右滑动的昨天/明天是
	// 历史回看视角，维持静态内容库文案
	return baseSlides.map((slide, idx) => withTodayTip(idx - 2, slide))
})

function withTodayTip(off, slide) {
  const tip = props.todayTip
  if (off !== 0 || !tip || !tip.text) return slide
  return {
    ...slide,
    tip: { icon: tip.icon || '💡', text: tip.text },
    tipTag: tip.tag || ''
  }
}

// Navigation methods
function slideDay(dir) {
  const next = currentIndex.value + dir
  if (next >= 0 && next <= 4) {
    currentIndex.value = next
  }
}

function goToday() {
  currentIndex.value = 2
}

function goDetail() {
  const total = props.weekInfo.total + offset.value
  navigateToPage(`/pages/daily/detail?totalDays=${total}`)
}

function onSwiperChange(e) {
  const idx = e.detail.current
  if (typeof idx === 'number' && idx >= 0 && idx <= 4) {
    currentIndex.value = idx
  }
}

// Reset to today when selectedDate changes
watch(
  () => props.selectedDate,
  () => {
    currentIndex.value = 2
  }
)
</script>

<style scoped lang="scss">
// ── Colors ──
$cream: #FBF7F2;
$cream3: #EDE3D6;
$border: #E8DDD0;
$rose: #D4627A;
$rose-lt: #FAEAEE;
$rose-dk: #B04560;
$sage: #7BA08C;
$sage-lt: #EAF2EE;
$amber: #C98A3A;
$amber-lt: #FDF3E3;
$gray100: #F2F0EE;
$gray200: #E4E1DC;
$gray300: #C8C4BC;
$gray400: #9C9890;
$gray600: #4A4844;
$gray900: #1C1A17;
$r: 32rpx;
$r-sm: 20rpx;
$rp: 999rpx;
$sh: 0 4rpx 28rpx rgba(60, 30, 10, 0.07);

.sec {
  margin: 20rpx 24rpx 0;
}

.card {
  background: white;
  border-radius: $r;
  box-shadow: $sh;
  overflow: hidden;
}

// ── Navigation header ──
.daily-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20rpx 28rpx 16rpx;
  border-bottom: 2rpx solid $border;
}

.d-nav-btn {
  width: 56rpx;
  height: 56rpx;
  border-radius: 50%;
  background: $gray100;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.d-nav-arrow {
  font-size: 30rpx;
  color: $gray600;
  line-height: 1;
}

.d-nav-center {
  text-align: center;
  flex: 1;
}

.d-nav-main {
  font-size: 26rpx;
  font-weight: 600;
  color: $gray900;
  display: flex;
  align-items: center;
  justify-content: center;
}

.today-chip {
  font-size: 18rpx;
  font-weight: 700;
  background: $rose;
  color: white;
  padding: 2rpx 12rpx;
  border-radius: $rp;
  margin-left: 10rpx;
}

.d-nav-sub {
  font-size: 20rpx;
  color: $gray400;
  margin-top: 2rpx;
}

.d-nav-right {
  display: flex;
  align-items: center;
  gap: 12rpx;
}

.back-day-btn {
  background: $rose-lt;
  border-radius: $rp;
  padding: 6rpx 16rpx;
}

.back-day-text {
  font-size: 20rpx;
  font-weight: 600;
  color: $rose;
}

// ── Swiper slides ──
.slides-outer {
  width: 100%;
  height: 380rpx;
}

.slide {
  padding: 20rpx 24rpx 20rpx;
  display: flex;
  flex-direction: column;
  gap: 12rpx;
}

.ditem-row {
  display: flex;
  gap: 12rpx;
}

.ditem {
  background: $cream;
  border-radius: $r-sm;
  padding: 18rpx 20rpx;
  border: 2rpx solid $cream3;
  transition: transform 0.15s;
  overflow: hidden;

  &.baby {
    flex: 1;
    border-left: 5rpx solid $rose;
  }

  &.mom {
    flex: 1;
    border-left: 5rpx solid $sage;
  }

  &.tip {
    border-left: 5rpx solid $amber;
  }
}

.di-header {
  display: flex;
  align-items: center;
  gap: 8rpx;
  margin-bottom: 8rpx;
}

.di-icon {
  font-size: 32rpx;
}

.di-lbl {
  font-size: 18rpx;
  font-weight: 600;
  color: $gray400;
  letter-spacing: 2rpx;
}

// 今日提醒来源标签（瀑布级：产检/待办）——为什么提醒我这个，一眼可见
.tip-tag {
  margin-left: auto;
  background: $amber-lt;
  border-radius: $rp;
  padding: 2rpx 12rpx;
}

.tip-tag-text {
  font-size: 18rpx;
  font-weight: 600;
  color: $amber;
}

.di-text {
  font-size: 22rpx;
  color: $gray900;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
}

// ── Pagination dots ──
.slide-dots {
  display: flex;
  justify-content: center;
  gap: 10rpx;
  padding: 16rpx 0 20rpx;
}

.sdot {
  width: 10rpx;
  height: 10rpx;
  border-radius: 50%;
  background: $gray300;
  transition: all 0.2s;

  &.active {
    width: 32rpx;
    border-radius: 6rpx;
    background: $rose;
  }
}
</style>
