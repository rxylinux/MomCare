<template>
  <view class="page">
    <!-- Single scroll container for everything -->
    <scroll-view scroll-y class="scroll-full" :show-scrollbar="false">
      <!-- Hero (scrolls with content) -->
      <view class="hero">
        <NavBar title="待产包清单" theme="dark" transparent :showBack="true" />
        <view class="hero-content">
          <text class="hero-label">已完成</text>
          <text class="hero-number">{{ doneCount }} / {{ totalCount }} 项</text>
          <text class="hero-sub">还剩 {{ totalCount - doneCount }} 项待准备 · 距预产期 {{ daysUntilDue }} 天</text>
        </view>
      </view>

      <!-- Content Body -->
      <view class="content-body">
        <!-- 保存失败持续提示（不只靠 toast） -->
        <view v-if="saveFailed" class="save-failed-banner">
          <text class="save-failed-text">上次更改未能保存到本机，当前显示可能未持久；再次点击任意项目可重试保存。</text>
        </view>

        <!-- Progress Card -->
        <view class="progress-card">
          <view class="progress-row">
            <text class="progress-label">总体进度</text>
            <text class="progress-percent">{{ progressPercent }}%</text>
          </view>
          <view class="progress-track">
            <view class="progress-fill" :style="{ width: progressPercent + '%' }"></view>
          </view>
        </view>

        <!-- Category Filter Strip (plain flex, no nested scroll-view) -->
        <view class="filter-row">
          <view
            v-for="cat in categoryFilters"
            :key="cat.key"
            class="filter-btn"
            :class="{ 'filter-btn-active': activeCategory === cat.key }"
            @tap="activeCategory = cat.key"
          >
            <text class="filter-text" :class="{ 'filter-text-active': activeCategory === cat.key }">
              {{ cat.name }} {{ cat.count }}
            </text>
          </view>
        </view>

        <!-- Checklist Sections -->
        <template v-for="section in filteredSections" :key="section.key">
          <view class="section-header">
            <text class="section-title">{{ section.name }}</text>
            <text class="section-count">{{ section.doneCount }}/{{ section.totalCount }}</text>
          </view>
          <view
            v-for="(item, idx) in section.items"
            :key="idx"
            class="check-item"
            :class="{ 'check-item-done': item.done }"
            @tap="toggleItem(item)"
            @longpress="handleLongPress(item)"
          >
            <!-- Checkbox -->
            <view class="checkbox" :class="{ 'checkbox-checked': item.done }">
              <text v-if="item.done" class="checkbox-tick">✓</text>
            </view>
            <!-- Text -->
            <text class="check-text" :class="{ 'check-text-done': item.done }">{{ item.text }}</text>
            <!-- Category Badge -->
            <text class="cat-badge" :class="[badgeClass(item.category), { 'cat-badge-faded': item.done }]">
              {{ badgeLabel(item.category) }}
            </text>
          </view>
        </template>
      </view>

      <view class="bottom-spacer"></view>
    </scroll-view>

    <!-- 悬浮添加按钮 -->
    <view class="fab" @tap="showAddSheet = true">
      <text class="fab-icon">＋</text>
    </view>

    <!-- 添加物品弹窗 -->
    <view v-if="showAddSheet" class="sheet-mask" @tap="showAddSheet = false">
      <view class="sheet-body" @tap.stop>
        <text class="sheet-title">添加物品</text>
        <input
          class="sheet-input"
          v-model="newItemText"
          placeholder="输入物品名称"
          :focus="showAddSheet"
          confirm-type="done"
          @confirm="addItem"
        />
        <text class="sheet-label">选择分类</text>
        <view class="sheet-cats">
          <view
            v-for="cat in addCategoryOptions"
            :key="cat.key"
            class="sheet-cat-btn"
            :class="{ 'sheet-cat-btn-active': newItemCategory === cat.key }"
            @tap="newItemCategory = cat.key"
          >
            <text class="sheet-cat-text" :class="{ 'sheet-cat-text-active': newItemCategory === cat.key }">{{ cat.name }}</text>
          </view>
        </view>
        <view class="sheet-actions">
          <view class="sheet-btn sheet-btn-cancel" @tap="showAddSheet = false">
            <text class="sheet-btn-text-cancel">取消</text>
          </view>
          <view class="sheet-btn sheet-btn-confirm" @tap="addItem">
            <text class="sheet-btn-text-confirm">添加</text>
          </view>
        </view>
      </view>
    </view>

    <!-- 删除确认弹窗 -->
    <ConfirmModal
      v-model:visible="showDeleteModal"
      title="删除物品"
      :content="`确定删除「${deleteTarget?.text || ''}」吗？`"
      confirmText="删除"
      confirmType="danger"
      @confirm="doDelete"
    />
  </view>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import ConfirmModal from '@/components/common/ConfirmModal.vue'
import { useHealthStore } from '@/stores/health.js'
import NavBar from '@/components/NavBar.vue'

const healthStore = useHealthStore()

// Category filter definitions (static keys + names)
const categoryDefs = [
  { key: 'all', name: '全部' },
  { key: 'mom', name: '妈妈用品' },
  { key: 'baby', name: '宝宝用品' },
  { key: 'doc', name: '证件资料' },
  { key: 'other', name: '其他' }
]

const activeCategory = ref('all')

// 默认待产包清单模板
const DEFAULT_ITEMS = [
  // 妈妈用品
  { text: '产妇卫生巾', done: false, category: 'mom' },
  { text: '哺乳内衣', done: false, category: 'mom' },
  { text: '拖鞋', done: false, category: 'mom' },
  { text: '吸奶器', done: false, category: 'mom' },
  { text: '产后收腹带', done: false, category: 'mom' },
  { text: '产妇睡衣', done: false, category: 'mom' },
  { text: '哺乳枕', done: false, category: 'mom' },
  { text: '一次性内裤', done: false, category: 'mom' },
  { text: '洗漱用品', done: false, category: 'mom' },
  { text: '防溢乳垫', done: false, category: 'mom' },
  { text: '出院服', done: false, category: 'mom' },
  { text: '保温杯', done: false, category: 'mom' },
  // 宝宝用品
  { text: '纸尿裤', done: false, category: 'baby' },
  { text: '抱被', done: false, category: 'baby' },
  { text: '连体爬服', done: false, category: 'baby' },
  { text: '婴儿湿巾', done: false, category: 'baby' },
  { text: '奶瓶', done: false, category: 'baby' },
  { text: '婴儿面霜', done: false, category: 'baby' },
  { text: '口水巾', done: false, category: 'baby' },
  { text: '婴儿帽', done: false, category: 'baby' },
  { text: '包被', done: false, category: 'baby' },
  { text: '婴儿指甲剪', done: false, category: 'baby' },
  // 证件资料
  { text: '身份证', done: false, category: 'doc' },
  { text: '健康手册', done: false, category: 'doc' },
  { text: '医保卡', done: false, category: 'doc' },
  { text: '产检记录本', done: false, category: 'doc' },
  // 其他
  { text: '充电器', done: false, category: 'other' },
  { text: '零食能量棒', done: false, category: 'other' }
]

// 从本地存储加载，无数据则用默认模板
function loadItems() {
  try {
    const saved = uni.getStorageSync('hospital_bag_items')
    if (saved) {
      return JSON.parse(saved)
    }
  } catch (e) {
    console.error('loadItems error:', e)
  }
  return DEFAULT_ITEMS.map(i => ({ ...i }))
}

const items = ref(loadItems())

// 最近一次保存是否失败（界面持续提示，避免"看起来已保存"）
const saveFailed = ref(false)

// 持久化到本地存储
function saveItems() {
  try {
    uni.setStorageSync('hospital_bag_items', JSON.stringify(items.value))
    saveFailed.value = false
    return true
  } catch (e) {
    console.error('saveItems error:', e)
    saveFailed.value = true
    uni.showToast({ title: '本机保存失败，更改仍显示在页面中，请重试', icon: 'none', duration: 2500 })
    return false
  }
}

// 监听变化自动保存
watch(items, saveItems, { deep: true })

// 手动重试保存
function retrySave() {
  saveItems()
}

// 距预产期天数
const daysUntilDue = computed(() => healthStore.daysUntilDue)

// Computed stats
const doneCount = computed(() => items.value.filter(i => i.done).length)
const totalCount = computed(() => items.value.length)
const progressPercent = computed(() => {
  if (totalCount.value === 0) return 0
  return Math.round((doneCount.value / totalCount.value) * 100)
})

// Category counts (reactive)
const categoryCounts = computed(() => {
  const counts = { all: totalCount.value, mom: 0, baby: 0, doc: 0, other: 0 }
  items.value.forEach(item => {
    if (counts[item.category] !== undefined) {
      counts[item.category]++
    }
  })
  return counts
})

// Filter buttons with live counts
const categoryFilters = computed(() => {
  return categoryDefs.map(cat => ({
    ...cat,
    count: categoryCounts.value[cat.key] || 0
  }))
})

// Build sections for grouped display
const sectionDefs = [
  { key: 'mom', name: '妈妈用品' },
  { key: 'baby', name: '宝宝用品' },
  { key: 'doc', name: '证件资料' },
  { key: 'other', name: '其他' }
]

const filteredSections = computed(() => {
  const sections = []
  const keysToShow = activeCategory.value === 'all'
    ? sectionDefs.map(s => s.key)
    : [activeCategory.value]

  keysToShow.forEach(key => {
    const def = sectionDefs.find(s => s.key === key)
    if (!def) return
    const sectionItems = items.value.filter(i => i.category === key)
    if (sectionItems.length === 0) return
    sections.push({
      key,
      name: def.name,
      items: sectionItems,
      doneCount: sectionItems.filter(i => i.done).length,
      totalCount: sectionItems.length
    })
  })

  return sections
})

// Toggle item done state
function toggleItem(item) {
  item.done = !item.done
}

// ── 添加物品 ──
const showAddSheet = ref(false)
const newItemText = ref('')
const newItemCategory = ref('other')
const addCategoryOptions = [
  { key: 'mom', name: '妈妈用品' },
  { key: 'baby', name: '宝宝用品' },
  { key: 'doc', name: '证件资料' },
  { key: 'other', name: '其他' }
]

function addItem() {
  const text = newItemText.value.trim()
  if (!text) {
    uni.showToast({ title: '请输入物品名称', icon: 'none' })
    return
  }
  items.value.push({
    text,
    done: false,
    category: newItemCategory.value
  })
  newItemText.value = ''
  showAddSheet.value = false
  uni.showToast({ title: '已添加', icon: 'success' })
}

// ── 长按删除 ──
const showDeleteModal = ref(false)
const deleteTarget = ref(null)

function handleLongPress(item) {
  deleteTarget.value = item
  showDeleteModal.value = true
}

function doDelete() {
  if (!deleteTarget.value) return
  const idx = items.value.indexOf(deleteTarget.value)
  if (idx >= 0) {
    items.value.splice(idx, 1)
    uni.showToast({ title: '已删除', icon: 'success' })
  }
  deleteTarget.value = null
}

// Badge helpers
function badgeClass(category) {
  const map = {
    mom: 'badge-mom',
    baby: 'badge-baby',
    doc: 'badge-doc',
    other: 'badge-other'
  }
  return map[category] || ''
}

function badgeLabel(category) {
  const map = {
    mom: '妈妈',
    baby: '宝宝',
    doc: '证件',
    other: '其他'
  }
  return map[category] || ''
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

/* ── Single scroll container ── */
.scroll-full {
  flex: 1;
}

/* ── Hero (inside scroll) ── */
.hero {
  background: linear-gradient(155deg, #8A5818 0%, #C98A3A 45%, #F0C878 100%);
  position: relative;
  overflow: hidden;
}

/* NavBar 透明覆盖 */
.hero :deep(.nav-bar-dark) {
  background: transparent;
}

.hero :deep(.status-bar-dark) {
  background: transparent;
}

.hero-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0 36rpx 40rpx;
  position: relative;
  z-index: 1;
}

.hero-label {
  display: block;
  font-size: 24rpx;
  color: rgba(255, 255, 255, 0.75);
  margin-bottom: 8rpx;
}

.hero-number {
  display: block;
  font-size: 56rpx;
  font-weight: 700;
  color: #FFFFFF;
  line-height: 1.2;
  margin-bottom: 12rpx;
}

.hero-sub {
  display: block;
  font-size: 24rpx;
  color: rgba(255, 255, 255, 0.65);
}

/* ── Content Body (below hero) ── */
.content-body {
  padding: 28rpx 28rpx 0;
  box-sizing: border-box;
}

/* ── 保存失败横幅 ── */
.save-failed-banner {
  background: #FEF4E3;
  border: 2rpx solid rgba(240, 169, 64, 0.4);
  border-radius: 20rpx;
  padding: 20rpx 24rpx;
  margin-bottom: 20rpx;
}

.save-failed-text {
  font-size: 24rpx;
  color: #B07818;
  line-height: 1.6;
}

/* ── Progress Card ── */
.progress-card {
  background: #FFFFFF;
  border-radius: 32rpx;
  box-shadow: 0 4rpx 28rpx rgba(60, 30, 10, 0.07);
  padding: 28rpx 32rpx;
  box-sizing: border-box;
}

.progress-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16rpx;
}

.progress-label {
  font-size: 26rpx;
  font-weight: 500;
  color: #6E6A64;
}

.progress-percent {
  font-size: 30rpx;
  font-weight: 700;
  color: #C98A3A;
}

.progress-track {
  height: 16rpx;
  background: #F2F0EE;
  border-radius: 999rpx;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #C98A3A, #F0C878);
  border-radius: 999rpx;
  transition: width 0.3s ease;
}

/* ── Filter Strip (plain flex, no scroll-view) ── */
.filter-row {
  display: flex;
  flex-wrap: wrap;
  padding: 24rpx 0 12rpx;
  gap: 16rpx;
}

.filter-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 64rpx;
  padding: 0 28rpx;
  border-radius: 999rpx;
  background: #F2F0EE;
}

.filter-btn-active {
  background: #C98A3A;
}

.filter-text {
  font-size: 24rpx;
  font-weight: 500;
  color: #9C9890;
  white-space: nowrap;
}

.filter-text-active {
  color: #FFFFFF;
}

/* ── Section Header ── */
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 28rpx 0 12rpx;
}

.section-title {
  font-size: 26rpx;
  font-weight: 600;
  color: #1C1A17;
}

.section-count {
  font-size: 24rpx;
  font-weight: 500;
  color: #9C9890;
}

/* ── Check Item ── */
.check-item {
  display: flex;
  align-items: center;
  background: #FFFFFF;
  border-radius: 20rpx;
  box-shadow: 0 4rpx 28rpx rgba(60, 30, 10, 0.07);
  padding: 24rpx 26rpx;
  margin-bottom: 16rpx;
  gap: 20rpx;
}

.check-item:active {
  opacity: 0.85;
  transform: scale(0.98);
}

.check-item-done {
  opacity: 0.7;
}

/* ── Checkbox ── */
.checkbox {
  width: 44rpx;
  height: 44rpx;
  border-radius: 10rpx;
  border: 3rpx solid #E4E1DC;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: #FAF9F8;
  transition: all 0.2s ease;
}

.checkbox-checked {
  background: #7BA08C;
  border-color: #7BA08C;
}

.checkbox-tick {
  font-size: 26rpx;
  font-weight: 700;
  color: #FFFFFF;
  line-height: 1;
}

/* ── Check Text ── */
.check-text {
  flex: 1;
  font-size: 28rpx;
  font-weight: 500;
  color: #3A3834;
  line-height: 1.4;
}

.check-text-done {
  text-decoration: line-through;
  color: #9C9890;
}

/* ── Category Badge ── */
.cat-badge {
  font-size: 22rpx;
  font-weight: 500;
  padding: 6rpx 16rpx;
  border-radius: 999rpx;
  flex-shrink: 0;
  transition: opacity 0.2s ease;
}

.cat-badge-faded {
  opacity: 0.4;
}

.badge-mom {
  background: #FDEEF1;
  color: #C0405A;
}

.badge-baby {
  background: #F0ECFB;
  color: #5A40A8;
}

.badge-doc {
  background: #EBF3FE;
  color: #2A6FCC;
}

.badge-other {
  background: #FEF4E3;
  color: #8C5A10;
}

/* ── Bottom Spacer ── */
.bottom-spacer {
  height: calc(180rpx + env(safe-area-inset-bottom));
}

/* ── FAB ── */
.fab {
  position: fixed;
  right: 32rpx;
  bottom: calc(80rpx + env(safe-area-inset-bottom));
  width: 100rpx;
  height: 100rpx;
  border-radius: 50%;
  background: linear-gradient(135deg, #C98A3A, #F0C878);
  box-shadow: 0 8rpx 32rpx rgba(160, 110, 30, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.fab:active {
  opacity: 0.85;
  transform: scale(0.95);
}

.fab-icon {
  font-size: 48rpx;
  font-weight: 300;
  color: #FFFFFF;
  line-height: 1;
}

/* ── Sheet Mask ── */
.sheet-mask {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 200;
  display: flex;
  align-items: flex-end;
}

/* ── Sheet Body ── */
.sheet-body {
  width: 100%;
  background: #FFFFFF;
  border-radius: 32rpx 32rpx 0 0;
  padding: 40rpx 36rpx;
  padding-bottom: calc(40rpx + env(safe-area-inset-bottom));
  box-sizing: border-box;
}

.sheet-title {
  display: block;
  font-size: 32rpx;
  font-weight: 600;
  color: #1C1A17;
  margin-bottom: 28rpx;
}

.sheet-input {
  width: 100%;
  height: 88rpx;
  background: #F2F0EE;
  border-radius: 16rpx;
  padding: 0 24rpx;
  font-size: 28rpx;
  color: #1C1A17;
  margin-bottom: 24rpx;
  box-sizing: border-box;
}

.sheet-label {
  display: block;
  font-size: 24rpx;
  font-weight: 500;
  color: #9C9890;
  margin-bottom: 16rpx;
}

.sheet-cats {
  display: flex;
  gap: 16rpx;
  flex-wrap: wrap;
  margin-bottom: 36rpx;
}

.sheet-cat-btn {
  height: 64rpx;
  padding: 0 28rpx;
  border-radius: 999rpx;
  background: #F2F0EE;
  display: flex;
  align-items: center;
  justify-content: center;
}

.sheet-cat-btn-active {
  background: #C98A3A;
}

.sheet-cat-text {
  font-size: 24rpx;
  font-weight: 500;
  color: #6E6A64;
  white-space: nowrap;
}

.sheet-cat-text-active {
  color: #FFFFFF;
}

.sheet-actions {
  display: flex;
  gap: 20rpx;
}

.sheet-btn {
  flex: 1;
  height: 88rpx;
  border-radius: 44rpx;
  display: flex;
  align-items: center;
  justify-content: center;
}

.sheet-btn-cancel {
  background: #F2F0EE;
}

.sheet-btn-confirm {
  background: linear-gradient(135deg, #C98A3A, #F0C878);
}

.sheet-btn:active {
  opacity: 0.85;
}

.sheet-btn-text-cancel {
  font-size: 28rpx;
  font-weight: 600;
  color: #6E6A64;
}

.sheet-btn-text-confirm {
  font-size: 28rpx;
  font-weight: 600;
  color: #FFFFFF;
}
</style>
