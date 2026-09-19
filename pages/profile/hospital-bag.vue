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
        <!-- 生成标准待产包清单（空档案入口） -->
        <view v-if="dataSource === 'family' && items.length === 0" class="generate-card" @tap="generateTemplates">
          <view class="generate-icon"><text class="generate-icon-text">🎒</text></view>
          <view class="generate-body">
            <text class="generate-title">生成标准待产包清单</text>
            <text class="generate-desc">按推荐清单一键创建（共享，两人可编辑）</text>
          </view>
          <text class="generate-arrow">›</text>
        </view>

        <!-- 保存失败持续提示（不只靠 toast） -->
        <view v-if="saveFailed" class="save-failed-banner">
          <text class="save-failed-text">上次更改未能保存到本机，当前显示可能未持久；再次点击任意项目可重试保存。</text>
        </view>

        <!-- Progress Card -->
        <!-- family 同步状态：待办可重试；冲突可见且可解决（采用云端/确认重提） -->
        <view v-if="dataSource === 'family' && (bagPendingEntries.length > 0 || bagConflictList.length > 0)" class="sync-banner">
          <view class="sync-banner-row">
            <text class="sync-banner-title">{{ bagConflictList.length > 0 ? bagConflictList.length + ' 项冲突待处理' : bagPendingEntries.length + ' 项待同步' }}</text>
            <view v-if="bagPendingEntries.length > 0" class="sync-banner-btn" @tap="retrySync">
              <text class="sync-banner-btn-text">重试同步</text>
            </view>
          </view>
          <text class="sync-banner-time">{{ bagLastSyncLabel }}</text>
          <!-- 冲突卡：本地改动 vs 云端版本，逐项显式解决 -->
          <view v-for="ce in bagConflictList" :key="ce.id" class="conflict-card">
            <text class="conflict-title">「{{ conflictLabel(ce) }}」双方都做了修改</text>
            <view class="conflict-row">
              <text class="conflict-side">我的改动</text>
              <text class="conflict-val">{{ describeFields(ce.payload) || '（准备状态）' }}</text>
            </view>
            <view class="conflict-row">
              <text class="conflict-side">云端版本</text>
              <text class="conflict-val">{{ describeFields(ce.currentRecord) || '（未知，点采用云端获取）' }}</text>
            </view>
            <view class="conflict-actions">
              <view class="conflict-btn conflict-btn-ghost" @tap="adoptCloudFor(ce.id)">
                <text class="conflict-btn-ghost-text">采用云端</text>
              </view>
              <view class="conflict-btn conflict-btn-solid" @tap="resubmitFor(ce.id)">
                <text class="conflict-btn-solid-text">确认重提</text>
              </view>
            </view>
          </view>
        </view>

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
            <!-- Text + 数量/位置/负责人 meta -->
            <view class="check-text-col">
              <view class="check-text-row">
                <text class="check-text" :class="{ 'check-text-done': item.done }">{{ item.text }}</text>
                <text v-if="item.quantity && item.quantity > 1" class="qty-chip">×{{ item.quantity }}</text>
              </view>
              <text v-if="itemMeta(item)" class="check-meta">{{ itemMeta(item) }}</text>
            </view>
            <!-- 编辑（family 云端条目） -->
            <view v-if="item._cloud" class="item-edit-btn" @tap.stop="openEdit(item)">
              <text class="item-edit-icon">✎</text>
            </view>
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
        <text class="sheet-label">数量</text>
        <view class="qty-row">
          <view class="qty-btn" @tap="bumpQty('new', -1)"><text class="qty-btn-text">−</text></view>
          <text class="qty-num">{{ newItemQuantity }}</text>
          <view class="qty-btn" @tap="bumpQty('new', 1)"><text class="qty-btn-text">＋</text></view>
        </view>
        <input class="sheet-input sheet-input-2" v-model="newItemLocation" placeholder="存放位置（可选，如：床头柜）" />
        <text class="sheet-label">负责人</text>
        <view class="sheet-cats">
          <view
            v-for="a in assigneeOptions"
            :key="a.key"
            class="sheet-cat-btn"
            :class="{ 'sheet-cat-btn-active': newItemAssignee === a.key }"
            @tap="newItemAssignee = a.key"
          >
            <text class="sheet-cat-text" :class="{ 'sheet-cat-text-active': newItemAssignee === a.key }">{{ a.name }}</text>
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

    <!-- 编辑物品弹窗（family：打开时捕获 revision 基线） -->
    <view v-if="showEditSheet" class="sheet-mask" @tap="showEditSheet = false">
      <view class="sheet-body" @tap.stop>
        <text class="sheet-title">编辑物品</text>
        <input class="sheet-input" v-model="editName" placeholder="物品名称" />
        <text class="sheet-label">分类</text>
        <view class="sheet-cats">
          <view
            v-for="cat in addCategoryOptions"
            :key="cat.key"
            class="sheet-cat-btn"
            :class="{ 'sheet-cat-btn-active': editCategory === cat.key }"
            @tap="editCategory = cat.key"
          >
            <text class="sheet-cat-text" :class="{ 'sheet-cat-text-active': editCategory === cat.key }">{{ cat.name }}</text>
          </view>
        </view>
        <text class="sheet-label">数量</text>
        <view class="qty-row">
          <view class="qty-btn" @tap="bumpQty('edit', -1)"><text class="qty-btn-text">−</text></view>
          <text class="qty-num">{{ editQuantity }}</text>
          <view class="qty-btn" @tap="bumpQty('edit', 1)"><text class="qty-btn-text">＋</text></view>
        </view>
        <input class="sheet-input sheet-input-2" v-model="editLocation" placeholder="存放位置（可选）" />
        <text class="sheet-label">负责人</text>
        <view class="sheet-cats">
          <view
            v-for="a in assigneeOptions"
            :key="a.key"
            class="sheet-cat-btn"
            :class="{ 'sheet-cat-btn-active': editAssignee === a.key }"
            @tap="editAssignee = a.key"
          >
            <text class="sheet-cat-text" :class="{ 'sheet-cat-text-active': editAssignee === a.key }">{{ a.name }}</text>
          </view>
        </view>
        <view class="sheet-actions">
          <view class="sheet-btn sheet-btn-cancel" @tap="showEditSheet = false">
            <text class="sheet-btn-text-cancel">取消</text>
          </view>
          <view class="sheet-btn sheet-btn-confirm" @tap="saveEdit">
            <text class="sheet-btn-text-confirm">保存</text>
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
import { getSessionState, subscribeSession, isExplicitDemo, isExplicitLoggedOut } from '@/services/sessionService.js'
import { useFamilyStore } from '@/services/familyStore.js'
import { getOutbox } from '@/services/outbox.js'
import NavBar from '@/components/NavBar.vue'

const healthStore = useHealthStore()

// 分类键与服务器 BAG_CATEGORIES 一致：mom/baby/documents/going/other
// （旧页 doc 键已废弃；going 不得成为不可见分类）
const categoryDefs = [
  { key: 'all', name: '全部' },
  { key: 'mom', name: '妈妈用品' },
  { key: 'baby', name: '宝宝用品' },
  { key: 'documents', name: '证件资料' },
  { key: 'going', name: '随身用品' },
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
  { text: '身份证', done: false, category: 'documents' },
  { text: '健康手册', done: false, category: 'documents' },
  { text: '医保卡', done: false, category: 'documents' },
  { text: '产检记录本', done: false, category: 'documents' },
  // 随身用品（going）
  { text: '充电宝', done: false, category: 'going' },
  { text: '口罩', done: false, category: 'going' },
  // 其他
  { text: '充电器', done: false, category: 'other' },
  { text: '零食能量棒', done: false, category: 'other' }
]

// 从本地存储加载，无数据则用默认模板
// B2b1：正式模式零读零写旧 hospital_bag_items（B3 来源确认后迁移）；
// 演示模式用独立键 MOMCARE_DEMO_BAG_ITEMS；family 模式从 familyStore 读
const DEMO_BAG_KEY = 'MOMCARE_DEMO_BAG_ITEMS'
const familyStore = useFamilyStore()
const dataSource = ref(isExplicitDemo() ? 'demo' : (getSessionState().status === 'confirmed' && !isExplicitLoggedOut() ? 'family' : 'prompt'))

// 回前台/冷启动协调（沿用 B2a 首页模式）：去重身份确认；异步确认成功（任何入口）
// → watcher 立即激活 family 并拉取；拒绝锁定/显式退出 → 清屏
import { onShow as __onShow } from '@dcloudio/uni-app'
import { foregroundRecheck, coldStartConfirm } from '@/services/sessionService.js'

function pullDomain() {
  familyStore.pullBagItems().catch(() => {})
}
let __activatedMember = null
function activateFamilyDomain() {
  dataSource.value = 'family'
  const s = getSessionState()
  const mid = s.member ? s.member.memberId : null
  if (__activatedMember !== mid) {
    familyStore.restoreFromCache()
    pullDomain()
    __activatedMember = mid
  }
}

const __sessionVersion = subscribeSession()
watch(__sessionVersion, () => {
  if (isExplicitDemo()) {
    dataSource.value = 'demo'
    __activatedMember = null
    return
  }
  const s = getSessionState()
  if (s.status === 'confirmed' && !isExplicitLoggedOut()) {
    activateFamilyDomain()
  } else if (s.status === 'rejected' || isExplicitLoggedOut()) {
    dataSource.value = 'prompt'
    __activatedMember = null
  }
})

// setup 时已确认（热路径）：恢复成员快照并拉取
if (dataSource.value === 'family') {
  familyStore.restoreFromCache()
  pullDomain()
  __activatedMember = getSessionState().member ? getSessionState().member.memberId : null
}

__onShow(() => {
  const session = getSessionState()
  if (isExplicitDemo()) return // 演示优先：不确认不拉取正式数据
  if (isExplicitLoggedOut() && session.status !== 'confirmed') return
  if (session.status === 'confirmed' && !isExplicitLoggedOut()) {
    activateFamilyDomain()
    foregroundRecheck().then(res => {
      if (!res || !res.ok) return // 拒绝已锁定/离线按暖离线保留
      pullDomain()
      familyStore.flushAll().catch(() => {})
    }).catch(() => {})
  } else if (session.status === 'unconfirmed' && dataSource.value !== 'demo') {
    // 冷启动：持久会话标记触发联网确认（去重），成功前不展示成员缓存
    coldStartConfirm().then(res => {
      if (res && res.ok) activateFamilyDomain()
    }).catch(() => {})
  }
})

function loadDemoItems() {
  try {
    const saved = uni.getStorageSync(DEMO_BAG_KEY)
    if (saved) return JSON.parse(saved)
  } catch (e) { /* */ }
  return DEFAULT_ITEMS.map(i => ({ ...i }))
}

function saveDemoItems() {
  try {
    uni.setStorageSync(DEMO_BAG_KEY, JSON.stringify(items.value))
    saveFailed.value = false
  } catch (e) {
    saveFailed.value = true
    uni.showToast({ title: '本机保存失败，更改仍显示在页面中', icon: 'none', duration: 2500 })
  }
}

// 演示/未确认的本地 items（family 模式用 familyStore.bagItems）
const localItems = ref(dataSource.value === 'demo' ? loadDemoItems() : [])
const items = computed(() => {
  if (dataSource.value === 'family') {
    // 权威源 → 展示形状（含 prepared/quantity/location/assignee）
    return Object.values(familyStore.bagItems).filter(r => !r.deleted).map(r => ({
      id: r.id,
      name: r.name || '',
      text: r.name || '',  // 模板消费 item.text（与演示模式同构）
      category: r.category || 'other',
      done: Boolean(r.prepared),
      quantity: r.quantity || 1,
      location: r.location || '',
      assignee: r.assignee || '',
      revision: r.revision || 0,
      _cloud: true
    }))
  }
  if (dataSource.value === 'demo') return localItems.value
  return [] // prompt：空态
})

// 演示模式 watch deep 保存（family 模式不写本地键）
watch(localItems, () => {
  if (dataSource.value === 'demo') saveDemoItems()
}, { deep: true })

// 最近一次保存是否失败（界面持续提示，避免"看起来已保存"）
const saveFailed = ref(false)

// 保存由三态路由管理：demo → saveDemoItems；family → familyStore 云端

// 手动重试保存（demo 模式重写本地键；family 由 flushAll 重试）
function retrySave() {
  if (dataSource.value === 'demo') {
    saveDemoItems()
  }
}

// ── 同步状态（family）：只统计本领域（bag*）待办与冲突，不混入其他域/私人正文 ──
const bagPendingEntries = computed(() => {
  void familyStore.pendingCount // 响应式失效源（outbox/会话版本）
  try { return getOutbox().filter(e => e.kind.startsWith('bag') && !e.conflict) } catch (e) { return [] }
})
const bagConflictList = computed(() => {
  void familyStore.conflictEntries
  try { return getOutbox().filter(e => e.kind.startsWith('bag') && e.conflict) } catch (e) { return [] }
})
const bagLastSyncLabel = computed(() => {
  const t = familyStore.lastBagSyncAt
  return t ? '上次完整同步 ' + new Date(t).toLocaleString() : '尚未完整同步'
})

async function retrySync() {
  const r = await familyStore.flushAll()
  if (r && r.ok === false && r.reason === 'busy') return
  familyStore.pullBagItems().catch(() => {})
}

// 冲突描述/解决
function conflictLabel(entry) {
  return (entry.payload && entry.payload.name) || (entry.currentRecord && entry.currentRecord.name) || '未命名物品'
}
function describeFields(p) {
  if (!p) return ''
  const parts = []
  if (p.name !== undefined && p.name !== null) parts.push(`名称 ${p.name}`)
  if (p.quantity !== undefined && p.quantity !== null) parts.push(`数量 ${p.quantity}`)
  if (p.location) parts.push(`位置 ${p.location}`)
  if (p.assignee) parts.push(`负责人 ${p.assignee === 'mama' ? '妈妈' : '爸爸'}`)
  if (p.prepared !== undefined) parts.push(p.prepared ? '已准备' : '未准备')
  return parts.join(' · ')
}
async function adoptCloudFor(entryId) {
  const ok = await familyStore.adoptCloud(entryId)
  if (!ok) {
    uni.showToast({ title: '获取云端版本失败，待办已保留', icon: 'none', duration: 2500 })
    return
  }
  uni.showToast({ title: '已采用云端版本', icon: 'none' })
  familyStore.pullBagItems().catch(() => {})
}
async function resubmitFor(entryId) {
  const r = await familyStore.resubmit(entryId)
  if (r && r.ok) {
    uni.showToast({ title: '已重新提交', icon: 'none' })
    familyStore.pullBagItems().catch(() => {})
  } else if (r && r.code === 'revision-conflict') {
    uni.showToast({ title: '云端又有更新，请采用云端或稍后再试', icon: 'none', duration: 2500 })
  } else {
    uni.showToast({ title: (r && r.message) || '提交失败，待办已保留', icon: 'none', duration: 2500 })
  }
}

// 生成标准待产包：持久可恢复协议（一条模板一条待办，断网/丢响应重启后自动续传）
async function generateTemplates() {
  if (dataSource.value !== 'family') return
  const templates = DEFAULT_ITEMS.map((item, idx) => ({
    templateKey: 'std_bag_' + idx,
    name: item.text || item.name || '',
    category: item.category || 'other',
    quantity: 1
  }))
  uni.showLoading({ title: '生成中…' })
  let res
  try {
    res = await familyStore.initializeBagTemplates(templates)
  } finally {
    uni.hideLoading()
  }
  if (!res) return
  const created = res.results.filter(r => r.ok && !r.skipped).length
  const skipped = res.results.filter(r => r.skipped).length
  if (res.ok) {
    uni.showToast({ title: created > 0 ? `已生成 ${created} 项` : (skipped > 0 ? '清单已存在' : '已生成'), icon: 'none' })
  } else {
    const failed = res.results.filter(r => !r.ok && !r.skipped).length
    uni.showToast({ title: failed > 0 ? `${failed} 项待同步，可在上方重试` : '生成未完成，请重试', icon: 'none', duration: 2500 })
  }
  familyStore.pullBagItems().catch(() => {})
}

// 距预产期天数（三态：family 读权威 pregnancy.dueDate + 响应式上海时钟；
// demo/未确认回退旧 store——正式页不混入历史本地档案）
function __shanghaiDayOrdinal(date) {
  const sh = new Date(date.getTime() + (8 * 60 + date.getTimezoneOffset()) * 60000)
  return Date.UTC(sh.getFullYear(), sh.getMonth(), sh.getDate()) / 86400000
}
function __dateKeyToOrdinal(key) {
  const [y, m, d] = String(key).split('-').map(Number)
  return Date.UTC(y, m - 1, d) / 86400000
}
const daysUntilDue = computed(() => {
  if (dataSource.value === 'family') {
    void healthStore.today // 响应式依赖生产时钟（跨上海午夜自动更新）
    const due = familyStore.pregnancy && familyStore.pregnancy.fields && familyStore.pregnancy.fields.dueDate
    if (!due) return 0
    return Math.max(0, __dateKeyToOrdinal(due) - __shanghaiDayOrdinal(healthStore.today))
  }
  return healthStore.daysUntilDue
})

// Computed stats
const doneCount = computed(() => items.value.filter(i => i.done).length)
const totalCount = computed(() => items.value.length)
const progressPercent = computed(() => {
  if (totalCount.value === 0) return 0
  return Math.round((doneCount.value / totalCount.value) * 100)
})

// Category counts (reactive) — 键与服务端分类一致
const categoryCounts = computed(() => {
  const counts = { all: totalCount.value, mom: 0, baby: 0, documents: 0, going: 0, other: 0 }
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
  { key: 'documents', name: '证件资料' },
  { key: 'going', name: '随身用品' },
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
  if (dataSource.value === 'family' && item._cloud) {
    familyStore.toggleBagItem(item.id).then(r => {
      if (!r.ok && r.code === 'revision-conflict') {
        uni.showToast({ title: '对方已修改，请刷新后重试', icon: 'none', duration: 2500 })
        familyStore.pullBagItems().catch(() => {})
      } else if (!r.ok) {
        uni.showToast({ title: r.message || '操作失败，请重试', icon: 'none', duration: 2500 })
      }
    })
    return
  }
  if (dataSource.value !== 'demo') return
  item.done = !item.done
}

// ── 添加物品 ──
const showAddSheet = ref(false)
const newItemText = ref('')
const pendingDraftId = ref('') // 失败重试复用的草稿 ID
const newItemCategory = ref('other')
const newItemQuantity = ref(1)
const newItemLocation = ref('')
const newItemAssignee = ref('')
const assigneeOptions = [
  { key: '', name: '暂不指定' },
  { key: 'mama', name: '妈妈' },
  { key: 'papa', name: '爸爸' }
]
const addCategoryOptions = [
  { key: 'mom', name: '妈妈用品' },
  { key: 'baby', name: '宝宝用品' },
  { key: 'documents', name: '证件资料' },
  { key: 'going', name: '随身用品' },
  { key: 'other', name: '其他' }
]

// 数量步进（1-99 正整数，与服务端校验一致）
function bumpQty(which, delta) {
  if (which === 'new') {
    newItemQuantity.value = Math.min(99, Math.max(1, (parseInt(newItemQuantity.value, 10) || 1) + delta))
  } else {
    editQuantity.value = Math.min(99, Math.max(1, (parseInt(editQuantity.value, 10) || 1) + delta))
  }
}

function addItem() {
  const text = newItemText.value.trim()
  if (!text) {
    uni.showToast({ title: '请输入物品名称', icon: 'none' })
    return
  }
  if (dataSource.value === 'family') {
    // 正式模式：云端创建——失败重试复用同一草稿 ID（不重复创建）
    if (!pendingDraftId.value) {
      pendingDraftId.value = 'bag_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    }
    const id = pendingDraftId.value
    familyStore.saveBagItem(id, {
      name: text,
      category: newItemCategory.value || 'other',
      quantity: Math.min(99, Math.max(1, parseInt(newItemQuantity.value, 10) || 1)),
      location: newItemLocation.value.trim() || null,
      assignee: newItemAssignee.value || null,
      prepared: false
    }, 0).then(r => {
      if (r.ok) {
        pendingDraftId.value = ''
        newItemText.value = ''
        newItemLocation.value = ''
        newItemAssignee.value = ''
        newItemQuantity.value = 1
        showAddSheet.value = false
        uni.showToast({ title: '已添加（共享）', icon: 'none' })
      } else if (r.code === 'revision-conflict') {
        uni.showToast({ title: '对方已修改，请刷新后重试', icon: 'none', duration: 2500 })
      } else {
        uni.showToast({ title: r.message || '添加失败', icon: 'none', duration: 2500 })
      }
    })
    return
  }
  if (dataSource.value !== 'demo') return
  localItems.value.push({
    text,
    done: false,
    category: newItemCategory.value
  })
  newItemText.value = ''
  newItemQuantity.value = 1
  showAddSheet.value = false
  uni.showToast({ title: '已添加', icon: 'success' })
}

// ── 编辑物品（family：打开时捕获旧 revision 基线，后台刷新不抬高提交版本）──
const showEditSheet = ref(false)
const editTargetId = ref('')
const editBaselineRevision = ref(0)
const editName = ref('')
const editCategory = ref('other')
const editQuantity = ref(1)
const editLocation = ref('')
const editAssignee = ref('')

function openEdit(item) {
  if (dataSource.value !== 'family' || !item || !item._cloud) return
  const cloud = familyStore.bagItems[item.id]
  if (!cloud) return
  editTargetId.value = item.id
  editBaselineRevision.value = cloud.revision || 0 // 基线：以此版本提交，靠服务端冲突检测
  editName.value = cloud.name || ''
  editCategory.value = cloud.category || 'other'
  editQuantity.value = cloud.quantity || 1
  editLocation.value = cloud.location || ''
  editAssignee.value = cloud.assignee || ''
  showEditSheet.value = true
}

async function saveEdit() {
  const name = editName.value.trim()
  if (!editTargetId.value) return
  if (!name) {
    uni.showToast({ title: '名称不能为空', icon: 'none' })
    return
  }
  const r = await familyStore.saveBagItem(editTargetId.value, {
    name,
    category: editCategory.value || 'other',
    quantity: Math.min(99, Math.max(1, parseInt(editQuantity.value, 10) || 1)),
    location: editLocation.value.trim() || null,
    assignee: editAssignee.value || null
  }, editBaselineRevision.value)
  if (r.ok) {
    showEditSheet.value = false
    uni.showToast({ title: '已保存（共享）', icon: 'none' })
  } else if (r.code === 'revision-conflict') {
    uni.showToast({ title: '对方已修改，请采用云端后重试', icon: 'none', duration: 2500 })
    familyStore.pullBagItems().catch(() => {})
  } else {
    uni.showToast({ title: r.message || '保存失败，请重试', icon: 'none', duration: 2500 })
  }
}

// 行内 meta：数量/位置/负责人
function itemMeta(item) {
  const parts = []
  if (item.location) parts.push(item.location)
  if (item.assignee) parts.push(item.assignee === 'mama' ? '妈妈准备' : '爸爸准备')
  return parts.join(' · ')
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
  const target = deleteTarget.value
  deleteTarget.value = null
  showDeleteModal.value = false

  if (dataSource.value === 'family' && target._cloud) {
    // 正式模式：云端删除（服务端墓碑，不从主 store 误删）
    familyStore.deleteBagItem(target.id, target.revision || 0).then(r => {
      if (r.ok) {
        uni.showToast({ title: '已删除', icon: 'success' })
        familyStore.pullBagItems().catch(() => {})
      } else if (r.code === 'revision-conflict') {
        uni.showToast({ title: '对方已修改，请刷新后重试', icon: 'none', duration: 2500 })
        familyStore.pullBagItems().catch(() => {})
      } else {
        uni.showToast({ title: r.message || '删除失败，请重试', icon: 'none', duration: 2500 })
      }
    })
    return
  }
  if (dataSource.value !== 'demo') return
  const idx = localItems.value.indexOf(target)
  if (idx >= 0) {
    localItems.value.splice(idx, 1)
    uni.showToast({ title: '已删除', icon: 'success' })
  }
}

// Badge helpers — documents（服务端键）映射证件徽标；going 有自己的可见徽标
function badgeClass(category) {
  const map = {
    mom: 'badge-mom',
    baby: 'badge-baby',
    documents: 'badge-doc',
    going: 'badge-going',
    other: 'badge-other'
  }
  return map[category] || ''
}

function badgeLabel(category) {
  const map = {
    mom: '妈妈',
    baby: '宝宝',
    documents: '证件',
    going: '随身',
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

/* ── 模板生成入口 ── */
.generate-card { display: flex; align-items: center; margin-bottom: 20rpx; padding: 28rpx; background: #FFF0F5; border: 2rpx solid #F8BBD0; border-radius: 24rpx; }
.generate-icon { width: 80rpx; height: 80rpx; border-radius: 20rpx; background: #FDEEF1; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.generate-icon-text { font-size: 36rpx; }
.generate-body { flex: 1; margin-left: 20rpx; }
.generate-title { font-size: 28rpx; font-weight: 600; color: #1C1A17; display: block; }
.generate-desc { font-size: 22rpx; color: #9C9890; margin-top: 4rpx; display: block; }
.generate-arrow { font-size: 32rpx; color: #C8C4BC; }

/* ── 同步状态 banner ── */
.sync-banner { margin-bottom: 16rpx; padding: 20rpx 24rpx; background: #FEF4E3; border: 2rpx solid rgba(240,169,64,0.4); border-radius: 20rpx; }
.sync-banner-row { display: flex; align-items: center; justify-content: space-between; }
.sync-banner-title { font-size: 26rpx; font-weight: 600; color: #B07818; }
.sync-banner-btn { background: #F0A940; border-radius: 999rpx; padding: 8rpx 24rpx; }
.sync-banner-btn-text { font-size: 22rpx; color: #FFFFFF; font-weight: 600; }
.sync-banner-time { font-size: 20rpx; color: #B07818; margin-top: 8rpx; display: block; opacity: 0.8; }

/* ── 冲突卡（本地 vs 云端 + 显式解决） ── */
.conflict-card { margin-top: 16rpx; padding: 20rpx; background: #FFFFFF; border: 2rpx solid rgba(240,169,64,0.5); border-radius: 16rpx; }
.conflict-title { font-size: 24rpx; font-weight: 600; color: #8C5A10; display: block; margin-bottom: 12rpx; }
.conflict-row { display: flex; gap: 12rpx; margin-bottom: 8rpx; align-items: flex-start; }
.conflict-side { font-size: 22rpx; color: #9C9890; flex-shrink: 0; width: 110rpx; }
.conflict-val { font-size: 22rpx; color: #4A4844; line-height: 1.5; flex: 1; }
.conflict-actions { display: flex; gap: 16rpx; margin-top: 12rpx; }
.conflict-btn { flex: 1; height: 64rpx; border-radius: 32rpx; display: flex; align-items: center; justify-content: center; }
.conflict-btn-ghost { background: #F2F0EE; }
.conflict-btn-solid { background: #C98A3A; }
.conflict-btn-ghost-text { font-size: 24rpx; font-weight: 600; color: #6E6A64; }
.conflict-btn-solid-text { font-size: 24rpx; font-weight: 600; color: #FFFFFF; }

/* ── 行内 meta（数量/位置/负责人） ── */
.check-text-col { flex: 1; display: flex; flex-direction: column; gap: 4rpx; min-width: 0; }
.check-text-row { display: flex; align-items: center; gap: 12rpx; }
.qty-chip { font-size: 22rpx; color: #C98A3A; font-weight: 600; flex-shrink: 0; }
.check-meta { font-size: 22rpx; color: #9C9890; line-height: 1.4; }
.item-edit-btn { width: 56rpx; height: 56rpx; border-radius: 14rpx; background: #F2F0EE; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.item-edit-btn:active { opacity: 0.7; }
.item-edit-icon { font-size: 26rpx; color: #9C9890; }

/* ── 数量步进 ── */
.qty-row { display: flex; align-items: center; gap: 24rpx; margin-bottom: 24rpx; }
.qty-btn { width: 64rpx; height: 64rpx; border-radius: 16rpx; background: #F2F0EE; display: flex; align-items: center; justify-content: center; }
.qty-btn:active { opacity: 0.7; }
.qty-btn-text { font-size: 32rpx; color: #6E6A64; }
.qty-num { font-size: 30rpx; font-weight: 700; color: #C98A3A; min-width: 80rpx; text-align: center; }
.sheet-input-2 { margin-bottom: 24rpx; }

.badge-going {
  background: #EAF7EF;
  color: #3A8C5A;
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
