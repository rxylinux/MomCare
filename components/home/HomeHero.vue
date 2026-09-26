<template>
  <view class="hero" :style="{ paddingTop: statusBarHeight + 'px' }">
    <!-- Radial highlight overlay -->
    <view class="hero-overlay"></view>

    <!-- Greeting row（点按攒订阅推送配额——首弹勾"总是保持"后完全静默） -->
    <view class="hero-top" @tap="onGreetingTap">
      <text class="hero-greet">{{ greeting }}</text>
    </view>

    <!-- Week + Due date row -->
    <view class="hero-row" v-if="pregInfoSet">
      <!-- Left: week block -->
      <view class="week-block">
        <text class="week-label">今天是孕</text>
        <view class="week-big-row">
          <text class="week-number">{{ weekInfo.week }}</text>
          <text class="week-unit">周</text>
        </view>
        <text class="week-days">+ {{ weekInfo.day }} 天</text>
      </view>

      <!-- Right: due badge -->
      <view class="due-block">
        <view class="due-badge">
          <text class="due-number">{{ daysUntilDue }}</text>
          <text class="due-unit">DAYS</text>
          <text class="due-label">距预产期</text>
        </view>
      </view>
    </view>

    <!-- 未设置孕期信息时的引导 -->
    <view class="hero-row setup-guide" v-else @tap="goSetup">
      <view class="setup-content">
        <text class="setup-icon">📝</text>
        <view class="setup-text-wrap">
          <text class="setup-title">开始您的孕期旅程</text>
          <text class="setup-desc">点击填写孕期信息，获取专属每日指南和产检提醒</text>
        </view>
        <text class="setup-arrow">›</text>
      </view>
    </view>

    <!-- Fruit comparison pill -->
    <view class="fruit-row" v-if="pregInfoSet">
      <text class="fruit-emoji">{{ fruitComparison.emoji }}</text>
      <text class="fruit-text">宝宝现在像一颗 <text class="fruit-name">{{ fruitComparison.name }}</text> 那么大</text>
      <view class="fruit-stats">
        <view class="fruit-stat">
          <text class="fruit-stat-val">{{ babyWeight }}</text>
          <text class="fruit-stat-lbl">体重</text>
        </view>
        <view class="fruit-stat-divider"></view>
        <view class="fruit-stat">
          <text class="fruit-stat-val">{{ babyLength }}</text>
          <text class="fruit-stat-lbl">身长</text>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue'
import { getTrimester, getTrimesterName } from '@/stores/health.js'
import { navigateToPage } from '@/utils/navigation.js'
import { requestPushSubscribe } from '@/utils/pushSubscribe.js'

const statusBarHeight = ref(0)
const app = getApp()
if (app && app.globalData) {
  statusBarHeight.value = app.globalData.statusBarHeight || 0
}

const props = defineProps({
  greeting: {
    type: String,
    default: '早上好，宝妈'
  },
  weekInfo: {
    type: Object,
    default: () => ({ week: 0, day: 0, total: 0 })
  },
  daysUntilDue: {
    type: Number,
    default: 0
  },
  fruitComparison: {
    type: Object,
    default: () => ({ emoji: '🫘', name: '种子' })
  },
  pregInfoSet: {
    type: Boolean,
    default: false
  }
})

const trimesterLabel = computed(() => {
  if (!props.weekInfo || !props.weekInfo.week) return ''
  return getTrimesterName(getTrimester(props.weekInfo.week))
})

// 宝宝体重与身长数据（与孕期指南页面一致）
const BABY_DATA = {
  4: { weight: '<1g', length: '0.04cm' },
  5: { weight: '<1g', length: '0.13cm' },
  6: { weight: '<1g', length: '0.6cm' },
  7: { weight: '<1g', length: '1.2cm' },
  8: { weight: '1g', length: '1.6cm' },
  9: { weight: '2g', length: '2.3cm' },
  10: { weight: '4g', length: '3.1cm' },
  11: { weight: '7g', length: '4.1cm' },
  12: { weight: '14g', length: '5.4cm' },
  13: { weight: '23g', length: '7.4cm' },
  14: { weight: '43g', length: '8.7cm' },
  15: { weight: '70g', length: '10.1cm' },
  16: { weight: '100g', length: '11.6cm' },
  17: { weight: '140g', length: '13cm' },
  18: { weight: '190g', length: '14.2cm' },
  19: { weight: '240g', length: '15.3cm' },
  20: { weight: '300g', length: '25cm' },
  21: { weight: '360g', length: '26.7cm' },
  22: { weight: '430g', length: '27.8cm' },
  23: { weight: '500g', length: '28.9cm' },
  24: { weight: '600g', length: '30cm' },
  25: { weight: '660g', length: '34.6cm' },
  26: { weight: '760g', length: '35.6cm' },
  27: { weight: '875g', length: '36.6cm' },
  28: { weight: '1.0kg', length: '37.6cm' },
  29: { weight: '1.15kg', length: '38.6cm' },
  30: { weight: '1.3kg', length: '40cm' },
  31: { weight: '1.5kg', length: '41cm' },
  32: { weight: '1.8kg', length: '42cm' },
  33: { weight: '2.0kg', length: '43cm' },
  34: { weight: '2.2kg', length: '44cm' },
  35: { weight: '2.4kg', length: '45cm' },
  36: { weight: '2.6kg', length: '46cm' },
  37: { weight: '2.9kg', length: '47cm' },
  38: { weight: '3.1kg', length: '48cm' },
  39: { weight: '3.3kg', length: '49cm' },
  40: { weight: '3.5kg', length: '50cm' }
}

const babyWeight = computed(() => {
  if (!props.pregInfoSet || !props.weekInfo || !props.weekInfo.week) return '--'
  return BABY_DATA[props.weekInfo.week]?.weight || '--'
})

const babyLength = computed(() => {
  if (!props.pregInfoSet || !props.weekInfo || !props.weekInfo.week) return '--'
  return BABY_DATA[props.weekInfo.week]?.length || '--'
})

function goSetup() {
  navigateToPage('/pages/profile/onboarding')
}

// 问候卡点按：攒订阅消息配额（fire-and-forget；模板未配置时整体 no-op）
function onGreetingTap() {
  void requestPushSubscribe()
}
</script>

<style scoped lang="scss">
.hero {
  position: relative;
  flex-shrink: 0;
  overflow: visible;
  padding: 0 40rpx 36rpx;
  background: linear-gradient(158deg, #C45070 0%, #E07898 36%, #F0A8BA 66%, #F8DDE8 100%);
}

.hero-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: radial-gradient(ellipse at 78% 8%, rgba(255, 255, 255, 0.18) 0%, transparent 55%);
  pointer-events: none;
}

/* ── Greeting row ── */
.hero-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 16rpx;
  position: relative;
}

.hero-greet {
  font-size: 26rpx;
  color: rgba(255, 255, 255, 0.85);
}

/* ── Week + Due row ── */
.hero-row {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  position: relative;
}

.week-block {
  flex: 1;
}

.week-label {
  font-size: 22rpx;
  color: rgba(255, 255, 255, 0.7);
  letter-spacing: 0.1em;
  margin-bottom: 2rpx;
}

.week-big-row {
  display: flex;
  align-items: baseline;
}

.week-number {
  font-family: 'Noto Serif SC', serif;
  font-size: 120rpx;
  font-weight: 700;
  color: white;
  line-height: 1;
  letter-spacing: -4rpx;
}

.week-unit {
  font-family: 'Noto Serif SC', serif;
  font-size: 52rpx;
  font-weight: 400;
  color: white;
  opacity: 0.85;
  margin-left: 4rpx;
  line-height: 1;
}

.week-days {
  font-size: 28rpx;
  color: rgba(255, 255, 255, 0.8);
  margin-top: 2rpx;
}

/* ── Due badge ── */
.due-block {
  text-align: right;
}

.due-badge {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  background: rgba(255, 255, 255, 0.2);
  border: 2rpx solid rgba(255, 255, 255, 0.3);
  border-radius: 28rpx;
  padding: 14rpx 28rpx;
}

.due-number {
  font-family: 'Noto Serif SC', serif;
  font-size: 56rpx;
  font-weight: 700;
  color: white;
  line-height: 1;
}

.due-unit {
  font-size: 20rpx;
  color: rgba(255, 255, 255, 0.65);
  letter-spacing: 0.05em;
}

.due-label {
  font-size: 22rpx;
  color: rgba(255, 255, 255, 0.75);
  margin-top: 4rpx;
}

/* ── Fruit pill ── */
.fruit-row {
  display: flex;
  align-items: center;
  gap: 12rpx;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 999rpx;
  padding: 10rpx 24rpx;
  margin-top: 16rpx;
  position: relative;
  z-index: 2;
}

.fruit-emoji {
  font-size: 24rpx;
  line-height: 1;
  flex-shrink: 0;
}

.fruit-text {
  font-size: 24rpx;
  color: rgba(255, 255, 255, 0.9);
  white-space: nowrap;
}

.fruit-name {
  color: white;
  font-weight: 600;
}

.fruit-stats {
  display: flex;
  align-items: center;
  gap: 16rpx;
  margin-left: auto;
  flex-shrink: 0;
}

.fruit-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.fruit-stat-val {
  font-size: 22rpx;
  font-weight: 600;
  color: white;
  line-height: 1.2;
}

.fruit-stat-lbl {
  font-size: 18rpx;
  color: rgba(255, 255, 255, 0.7);
}

.fruit-stat-divider {
  width: 1rpx;
  height: 32rpx;
  background: rgba(255, 255, 255, 0.3);
}

/* ── Setup guide ── */
.setup-guide {
  padding: 12rpx 0;
}

.setup-content {
  display: flex;
  align-items: center;
  gap: 20rpx;
  background: rgba(255, 255, 255, 0.2);
  border: 2rpx solid rgba(255, 255, 255, 0.3);
  border-radius: 24rpx;
  padding: 28rpx 28rpx;
  width: 100%;
  box-sizing: border-box;
}

.setup-icon {
  font-size: 44rpx;
  flex-shrink: 0;
}

.setup-text-wrap {
  flex: 1;
}

.setup-title {
  display: block;
  font-size: 30rpx;
  font-weight: 600;
  color: #FFFFFF;
  margin-bottom: 4rpx;
}

.setup-desc {
  display: block;
  font-size: 22rpx;
  color: rgba(255, 255, 255, 0.8);
}

.setup-arrow {
  font-size: 40rpx;
  color: rgba(255, 255, 255, 0.7);
  flex-shrink: 0;
}
</style>
