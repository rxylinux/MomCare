<template>
	<view class="page">
		<!-- Hero -->
		<view class="hero-rose">
			<NavBar title="产检提醒" theme="dark" transparent :showBack="true" class="hero-navbar" />
			<view class="hero-content">
				<template v-if="nextCheckup">
					<text class="hero-label">下次产检日期</text>
					<text class="hero-date">{{ heroDate }}</text>
					<text class="hero-sub">{{ heroSub }}</text>
					<view class="countdown-pill" :class="{ 'pill-overdue': isOverdue }">
						<text class="countdown-num">{{ isOverdue ? overdueDays : daysUntil }}</text>
						<text class="countdown-lbl">{{ isOverdue ? '天前已到期' : '天后' }}</text>
					</view>
				</template>
				<template v-else>
					<text class="hero-label">产检安排</text>
					<text class="hero-date">{{ dataSource === 'family' ? '暂无安排' : '已全部完成' }}</text>
					<text class="hero-sub">{{ dataSource === 'family' ? '可在下方生成标准产检安排' : '所有产检日程已完成，祝您一切顺利' }}</text>
				</template>
			</view>
		</view>

		<scroll-view scroll-y class="scroll-content">
			<!-- 无数据时初始化提示 -->
			<view v-if="loading" class="loading-container">
				<view class="loading-spinner"></view>
				<text class="loading-text">加载中...</text>
			</view>

			<template v-else>
				<!-- family 同步状态：checkup 域待办可重试；冲突可见且可显式解决 -->
				<view v-if="dataSource === 'family' && (chkPendingEntries.length > 0 || chkConflictList.length > 0)" class="sync-banner">
					<view class="sync-banner-row">
						<text class="sync-banner-title">{{ chkConflictList.length > 0 ? chkConflictList.length + ' 项冲突待处理' : chkPendingEntries.length + ' 项待同步' }}</text>
						<view v-if="chkPendingEntries.length > 0" class="sync-banner-btn" @tap="retrySync">
							<text class="sync-banner-btn-text">重试同步</text>
						</view>
					</view>
					<text class="sync-banner-time">{{ chkLastSyncLabel }}</text>
					<view v-for="ce in chkConflictList" :key="ce.id" class="conflict-card">
						<text class="conflict-title">「{{ conflictLabel(ce) }}」双方都做了修改</text>
						<view class="conflict-row">
							<text class="conflict-side">我的改动</text>
							<text class="conflict-val">{{ describeCheckup(ce.payload) || '（检查项勾选）' }}</text>
						</view>
						<view class="conflict-row">
							<text class="conflict-side">云端版本</text>
							<text class="conflict-val">{{ describeCheckup(ce.currentRecord) || '（未知，点采用云端获取）' }}</text>
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

				<!-- family：孕期日期已修改 → 自动安排需迁移（预览后确认） -->
				<view v-if="dataSource === 'family' && migrationInfo" class="migrate-banner" @tap="openMigrationPreview">
					<view class="migrate-body">
						<text class="migrate-title">孕期日期已修改</text>
						<text class="migrate-desc">未完成的自动安排需要调整日期，点此预览并确认（已完成/跳过/手动改期不变）</text>
					</view>
					<text class="migrate-arrow">›</text>
				</view>

				<!-- family：空档案显式生成标准产检安排（不后台悄悄写模板） -->
				<view v-if="dataSource === 'family' && famCheckupCount === 0" class="generate-card" @tap="generateSchedule">
					<view class="generate-icon"><text class="generate-icon-text">🗓</text></view>
					<view class="generate-body">
						<text class="generate-title">生成标准产检安排</text>
						<text class="generate-desc">按末次月经日期一键创建推荐日程（共享，两人可编辑）</text>
					</view>
					<text class="generate-arrow">›</text>
				</view>

				<template v-if="nextCheckup">
					<!-- 产检信息卡片 -->
					<view class="info-card">
						<text class="info-title">本次产检信息</text>
						<view class="info-row">
							<text class="info-icon">📅</text>
							<text class="info-text">{{ infoDate }}</text>
						</view>
						<view class="info-row">
							<text class="info-icon">🏥</text>
							<text class="info-text">{{ infoHospital }}</text>
						</view>
						<view class="info-row">
							<text class="info-icon">👩‍⚕️</text>
							<text class="info-text">预计孕周：{{ nextCheckup.week_label }}</text>
						</view>
						<view v-if="nextCheckup.companion" class="info-row">
							<text class="info-icon">👨‍👩‍👧</text>
							<text class="info-text">陪同：{{ nextCheckup.companion }}</text>
						</view>
						<view v-if="nextCheckup.materials && nextCheckup.materials.length" class="info-row">
							<text class="info-icon">🎒</text>
							<text class="info-text">材料：{{ nextCheckup.materials.join('、') }}</text>
						</view>
						<view v-if="nextCheckup.questions && nextCheckup.questions.length" class="info-row">
							<text class="info-icon">❓</text>
							<text class="info-text">问题：{{ nextCheckup.questions.join('；') }}</text>
						</view>
						<view v-if="dataSource === 'family'" class="edit-chk-btn" @tap="openEditor">
							<text class="edit-chk-btn-text">编辑日期 / 时间 / 医院 / 陪同 / 材料 / 问题</text>
						</view>
					</view>

					<!-- 检查项目清单 -->
					<text class="section-title">本次需要做的检查</text>
					<view class="exam-list">
						<view
							v-for="(item, idx) in nextCheckup.exam_items"
							:key="item.itemId || ('idx-' + idx)"
							class="exam-item"
							:class="{ 'exam-checked': item.done }"
							@tap="handleToggleItem(nextCheckup._id, item.itemId, idx)"
						>
							<view class="exam-check">
								<text v-if="item.done" class="check-mark">✓</text>
							</view>
							<text class="exam-text" :class="{ 'exam-text-done': item.done }">{{ item.text }}</text>
							<view class="exam-tag" :class="item.required ? 'tag-req' : 'tag-opt'">
								<text class="exam-tag-text">{{ item.required ? '必查' : '选查' }}</text>
							</view>
						</view>
					</view>

					<!-- 添加检查项 -->
					<view class="exam-add" @tap="handleAddItem">
						<text class="exam-add-text">+ 添加检查项</text>
					</view>

					<!-- 操作按钮 -->
					<view class="action-area">
						<view class="btn-primary" @tap="handleMarkCompleted">
							<text class="btn-primary-text">标记为已完成</text>
						</view>
						<view class="btn-text" @tap="handleSkipCheckup">
							<text class="btn-text-label">跳过本次产检</text>
						</view>
					</view>
				</template>

				<!-- 历史产检记录 -->
				<template v-if="completedCheckups.length > 0">
					<text class="section-title">历史产检记录</text>
					<view class="history-list">
						<view
							v-for="(item, idx) in completedCheckups"
							:key="'h-' + idx"
							class="history-item"
							@tap="toggleHistoryExpand(idx)"
						>
							<view class="history-row">
								<view class="history-left">
									<view class="history-dot" :class="{ 'history-dot-skip': item.status === 'skipped' }"></view>
									<view class="history-info">
										<text class="history-date">{{ formatHistoryDate(item.checkup_date) }}</text>
										<text class="history-week">{{ item.status === 'skipped' ? '已跳过 · ' : '' }}{{ item.week_label }}</text>
									</view>
								</view>
								<view class="history-right">
									<text class="history-done-count">{{ countDoneItems(item) }}/{{ item.exam_items.length }}</text>
									<text class="history-done-label">项已完成</text>
									<text class="history-arrow" :class="{ 'arrow-up': expandedHistory[idx] }">▸</text>
								</view>
							</view>
							<view v-if="expandedHistory[idx]" class="history-detail">
								<view
									v-for="(exam, ei) in item.exam_items"
									:key="'e-' + (exam.itemId || ei)"
									class="detail-row"
								>
									<text class="detail-check">{{ exam.done ? '✓' : '○' }}</text>
									<text class="detail-text" :class="{ 'detail-done': exam.done }">{{ exam.text }}</text>
									<view class="detail-tag" :class="exam.required ? 'tag-req' : 'tag-opt'">
										<text class="exam-tag-text">{{ exam.required ? '必查' : '选查' }}</text>
									</view>
								</view>
							</view>
						</view>
					</view>
				</template>
			</template>

			<view class="bottom-spacer"></view>
		</scroll-view>

		<!-- 跳过确认弹窗 -->
		<ConfirmModal
			v-model:visible="showSkipModal"
			title="确认跳过"
			content="确定要跳过本次产检吗？\n此操作不可撤销。"
			confirmType="danger"
			@confirm="doSkipCheckup"
		/>

		<!-- 添加检查项弹窗 -->
		<ConfirmModal
			v-model:visible="showAddItemModal"
			title="添加检查项"
			content="请输入检查项目名称"
			:editable="true"
			placeholder="输入检查项目名称"
			@confirm="doAddItem"
		/>

		<!-- 编辑产检信息弹窗（family：打开捕获旧 revision 基线） -->
		<view v-if="showEditor" class="sheet-mask" @tap="showEditor = false">
			<view class="sheet-body" @tap.stop>
				<text class="sheet-title">编辑产检信息</text>
				<text class="ed-label">日期</text>
				<picker mode="date" :value="edDate" @change="onPickDate">
					<view class="ed-value">{{ edDate || '选择日期' }}</view>
				</picker>
				<view class="ed-time-row">
					<picker mode="time" :value="edTime" @change="onPickTime">
						<text class="ed-value">{{ edTime || '时间（可选）' }}</text>
					</picker>
					<view v-if="edTime" class="ed-clear" @tap="edTime = ''">
						<text class="ed-clear-text">清除时间</text>
					</view>
				</view>
				<text class="ed-label">医院</text>
				<input class="ed-input" v-model="edHospital" placeholder="医院（可选）" />
				<text class="ed-label">陪同人</text>
				<input class="ed-input" v-model="edCompanion" placeholder="陪同人（可选）" />
				<text class="ed-label">要带的材料（每行一项）</text>
				<textarea class="ed-textarea" v-model="edMaterials" placeholder="如：医保卡、母子健康手册" />
				<text class="ed-label">要问医生的问题（每行一项）</text>
				<textarea class="ed-textarea" v-model="edQuestions" placeholder="如：最近胎动偏少正常吗？" />
				<view class="sheet-actions">
					<view class="sheet-btn sheet-btn-cancel" @tap="showEditor = false">
						<text class="sheet-btn-text-cancel">取消</text>
					</view>
					<view class="sheet-btn sheet-btn-confirm" @tap="saveEditor">
						<text class="sheet-btn-text-confirm">保存</text>
					</view>
				</view>
			</view>
		</view>

		<!-- 日期迁移预览/确认弹窗（family） -->
		<view v-if="showMigrationSheet" class="sheet-mask" @tap="showMigrationSheet = false">
			<view class="sheet-body" @tap.stop>
				<text class="sheet-title">调整自动产检安排</text>
				<text class="mig-desc">孕期日期已修改（{{ migrationInfo ? migrationInfo.oldLmpDateKey : '' }} → {{ migrationInfo ? migrationInfo.newLmpDateKey : '' }}，整体偏移 {{ migrationPreview ? migrationPreview.shiftDays : 0 }} 天）。以下未完成的自动安排将调整日期；已完成、跳过、手动改期及自建产检不变。</text>
				<view v-if="migrationPreview && migrationPreview.toUpdate.length > 0" class="mig-list">
					<view v-for="it in migrationPreview.toUpdate" :key="it.id" class="mig-row">
						<text class="mig-date">{{ it.oldDateKey }}</text>
						<text class="mig-arrow">→</text>
						<text class="mig-date mig-date-new">{{ it.newDateKey }}</text>
					</view>
				</view>
				<view v-else class="mig-empty">
					<text class="mig-empty-text">没有需要调整的自动安排</text>
				</view>
				<view class="sheet-actions">
					<view class="sheet-btn sheet-btn-cancel" @tap="showMigrationSheet = false">
						<text class="sheet-btn-text-cancel">暂不调整</text>
					</view>
					<view
						v-if="migrationPreview && migrationPreview.toUpdate.length > 0"
						class="sheet-btn sheet-btn-confirm"
						@click="confirmMigration"
					>
						<text class="sheet-btn-text-confirm">{{ migrationApplying ? '调整中…' : '确认调整' }}</text>
					</view>
				</view>
			</view>
		</view>
	</view>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useHealthStore, calcWeekInfo } from '@/stores/health.js'
import { getSessionState, subscribeSession, isExplicitDemo, isExplicitLoggedOut } from '@/services/sessionService.js'
import { useFamilyStore } from '@/services/familyStore.js'
import { getOutbox } from '@/services/outbox.js'
import ConfirmModal from '@/components/common/ConfirmModal.vue'
import NavBar from '@/components/NavBar.vue'

const healthStore = useHealthStore()
const familyStore = useFamilyStore()
const loading = ref(true)

// B2b1 三态数据源：family=权威源 / demo=旧 store / prompt=空
const dataSource = ref(isExplicitDemo() ? 'demo' : (getSessionState().status === 'confirmed' && !isExplicitLoggedOut() ? 'family' : 'prompt'))
const __sessionVersion = subscribeSession()

// 回前台/冷启动协调（沿用 B2a 首页模式）：与 App 共享去重身份确认；
// 异步确认成功（任何入口触发）→ watcher 立即激活 family 并拉取，不等再次进入；
// 拒绝锁定/显式退出 → 清屏为空态
import { onShow as __onShow } from '@dcloudio/uni-app'
import { foregroundRecheck, coldStartConfirm } from '@/services/sessionService.js'

function pullDomain() {
	familyStore.pullCheckups().catch(() => {})
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

// 公历日序（Asia/Shanghai 日期键的 UTC 日历算术，与迁移一致）
function dayOrd(dk) {
  const [y, m, d] = dk.split('-').map(Number)
  return Date.UTC(y, m - 1, d) / 86400000
}

// family 模式当前 LMP（权威 pregnancy），demo 回退旧 store
const famLmpKey = computed(() => {
  const f = familyStore.pregnancy && familyStore.pregnancy.fields && familyStore.pregnancy.fields.lmpDate
  return f || null
})
function weekLabelFor(dateKey) {
  let lmp = null
  if (dataSource.value === 'family') lmp = famLmpKey.value
  else if (dataSource.value === 'demo' && healthStore.lmpDate) lmp = healthStore.getRecordKey(healthStore.lmpDate)
  if (!lmp || !dateKey) return ''
  const n = dayOrd(dateKey) - dayOrd(lmp)
  if (n < 0) return ''
  return `孕${Math.floor(n / 7)}周+${n % 7}`
}

// 将权威 checkup 映射为旧模板消费形状（checkup_date/_id/exam_items 等）
// time 保留真实 HH:mm（编辑器保存 16:45 就显示 16:45，不回落编造的 09:30/14:00）
function famCheckupToLegacy(c) {
  if (!c || c.deleted) return null
  return {
    _id: c.id,
    checkup_date: c.dateKey,
    time: c.time || '',
    time_slot: c.time ? (c.time < '12:00' ? 'morning' : 'afternoon') : '',
    hospital: c.hospital || '',
    department: c.department || '',
    companion: c.companion || '',
    materials: c.materials || [],
    questions: c.questions || [],
    status: c.status === 'pending' ? 'upcoming' : c.status,
    exam_items: (c.examItems || []).map(it => ({ text: it.text, required: it.required, done: it.done, itemId: it.itemId })),
    examItemsById: c.examItems || [],
    notes: c.notes || '',
    week_label: weekLabelFor(c.dateKey),
    _cloud: true,
    revision: c.revision || 0
  }
}

// family 权威产检总数（含 pending/完成/跳过，不含墓碑）
const famCheckupCount = computed(() => {
  if (dataSource.value !== 'family') return 0
  return Object.values(familyStore.checkups).filter(c => !c.deleted).length
})

// 下一次产检（family 权威源 / demo 旧 store / prompt 空）
const nextCheckup = computed(() => {
  if (dataSource.value === 'family') {
    return Object.values(familyStore.checkups)
      .filter(c => !c.deleted && c.status === 'pending')
      .sort((a, b) => (a.dateKey || '').localeCompare(b.dateKey || ''))
      .map(famCheckupToLegacy)[0] || null
  }
  if (dataSource.value !== 'demo') return null
  return healthStore.nextCheckup
})
const completedCheckups = computed(() => {
  if (dataSource.value === 'family') {
    return Object.values(familyStore.checkups)
      .filter(c => !c.deleted && (c.status === 'completed' || c.status === 'skipped'))
      .sort((a, b) => (b.dateKey || '').localeCompare(a.dateKey || ''))
      .map(famCheckupToLegacy)
  }
  if (dataSource.value !== 'demo') return []
  return healthStore.completedCheckups
})

// 上海日号 + 响应式时钟（B2a 已验收模式）：依赖 healthStore.today（App 分钟时钟
// refreshToday 驱动），停留页面跨上海午夜时倒计时/逾期自动重算，预约记录不变也更新
function shanghaiDayOrdinal(date) {
	const sh = new Date(date.getTime() + (8 * 60 + date.getTimezoneOffset()) * 60000)
	return Date.UTC(sh.getFullYear(), sh.getMonth(), sh.getDate()) / 86400000
}
function dateKeyToOrdinal(key) {
	const [y, m, d] = String(key).split('-').map(Number)
	return Date.UTC(y, m - 1, d) / 86400000
}
const todayShanghaiOrd = computed(() => {
	void healthStore.today // 响应式依赖生产时钟
	return shanghaiDayOrdinal(healthStore.today)
})

// 是否过期 / 逾期天数 / 倒计时：按上海日号差（非瞬时时差）
const isOverdue = computed(() => {
	if (!nextCheckup.value) return false
	return dateKeyToOrdinal(nextCheckup.value.checkup_date) < todayShanghaiOrd.value
})

const overdueDays = computed(() => {
	if (!nextCheckup.value) return 0
	return Math.max(1, todayShanghaiOrd.value - dateKeyToOrdinal(nextCheckup.value.checkup_date))
})

// 日期键按日历字段直读（YYYY-MM-DD 不做时区换算——负时区下 new Date(key) 会回退一天）；
// 星期以对应 UTC 日历算术求得，与上海日号倒计时一致
function dateKeyParts(key) {
	const [y, m, d] = String(key).split('-').map(Number)
	return { y, m, d }
}
function weekdayOfDateKey(key) {
	const { y, m, d } = dateKeyParts(key)
	const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
	return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][wd]
}

// Hero 区域数据
const heroDate = computed(() => {
	if (!nextCheckup.value) return ''
	const { m, d } = dateKeyParts(nextCheckup.value.checkup_date)
	return `${m}月${d}日`
})

const heroSub = computed(() => {
	if (!nextCheckup.value) return ''
	const c = nextCheckup.value
	// 真实可选 HH:mm 优先；未设置不编造时间
	const timeLabel = c.time || (c.time_slot === 'morning' ? '上午' : c.time_slot === 'afternoon' ? '下午' : '')
	let sub = weekdayOfDateKey(c.checkup_date)
	if (timeLabel) sub += ` · ${timeLabel}`
	if (c.hospital) sub += ` · ${c.hospital}`
	if (c.department) sub += ` · ${c.department}`
	return sub
})

const daysUntil = computed(() => {
	if (!nextCheckup.value) return 0
	return Math.max(0, dateKeyToOrdinal(nextCheckup.value.checkup_date) - todayShanghaiOrd.value)
})

// 产检信息卡片数据
const infoDate = computed(() => {
	if (!nextCheckup.value) return ''
	const c = nextCheckup.value
	const { y, m, d } = dateKeyParts(c.checkup_date)
	// 展示真实保存的 HH:mm（如 16:45）；未设置不编造 09:30/14:00
	const timeLabel = c.time || (c.time_slot === 'morning' ? '上午' : c.time_slot === 'afternoon' ? '下午' : '')
	return `${y}年${m}月${d}日（${weekdayOfDateKey(c.checkup_date)}）${timeLabel}`
})

const infoHospital = computed(() => {
	if (!nextCheckup.value) return ''
	const c = nextCheckup.value
	// 三态：family 只读权威字段（未设置就明示），不混入旧本地档案
	if (dataSource.value === 'family') {
		return c.hospital || '未设置医院'
	}
	let text = c.hospital || healthStore.userInfo.hospital || '未设置医院'
	if (c.department) text += ` · ${c.department}`
	return text
})

// 交互：按【点击时捕获的父记录 ID + 稳定 itemId】勾选——点击与处理之间
// nextCheckup 被对端完成/顶替、列表重排，都不落错记录/误勾他项
async function handleToggleItem(recId, itemId, idx) {
	if (!recId) return
	if (dataSource && dataSource.value === 'family' && familyStore) {
		// 权威源：按捕获记录 ID 定位（不读当前 nextCheckup）
		if (!itemId) return
		const cloud = familyStore.checkups[recId]
		if (!cloud || cloud.deleted) {
			uni.showToast({ title: '该产检已更新，请刷新后重试', icon: 'none', duration: 2500 })
			familyStore.pullCheckups().catch(() => {})
			return
		}
		const r = await familyStore.toggleCheckupItem(recId, itemId)
		if (!r.ok && r.code === 'revision-conflict') {
			uni.showToast({ title: '对方已修改，请刷新后重试', icon: 'none', duration: 2500 })
			familyStore.pullCheckups().catch(() => {})
		} else if (!r.ok) {
			uni.showToast({ title: r.message || '操作失败，请重试', icon: 'none', duration: 2500 })
		}
		return
	}
	if (dataSource && dataSource.value !== 'demo' && dataSource.value !== undefined) return
	// 演示旧 store：按捕获记录定位，项优先稳定 itemId，旧数据回退下标
	const rec = (healthStore.checkupSchedules || []).find(c => c._id === recId)
	if (!rec) return
	let targetIdx = idx
	if (itemId) {
		const found = (rec.exam_items || []).findIndex(i => i.itemId === itemId)
		if (found >= 0) targetIdx = found
	}
	if (targetIdx === undefined || targetIdx < 0) return
	const ok = await healthStore.toggleExamItem(recId, targetIdx)
	if (!ok) {
		uni.showToast({ title: '本机保存失败，已还原，请重试', icon: 'none', duration: 2500 })
	}
}

async function handleMarkCompleted() {
	if (!nextCheckup.value || !nextCheckup.value._id) return
	if (dataSource && dataSource.value === 'family' && familyStore) {
		const r = await familyStore.markCheckupStatus(nextCheckup.value._id, 'completed')
		if (r.ok) {
			uni.showToast({ title: '已标记完成', icon: 'success' })
		} else if (r.code === 'revision-conflict') {
			uni.showToast({ title: '对方已修改，请刷新后重试', icon: 'none', duration: 2500 })
			familyStore.pullCheckups().catch(() => {})
		} else {
			uni.showToast({ title: r.message || '操作失败，请重试', icon: 'none', duration: 2500 })
		}
		return
	}
	if (dataSource && dataSource.value !== 'demo' && dataSource.value !== undefined) return
	const ok = await healthStore.markCheckupCompleted(nextCheckup.value._id)
	if (ok) {
		uni.showToast({ title: '已标记完成', icon: 'success' })
	} else {
		uni.showToast({ title: '本机保存失败，已还原，请重试', icon: 'none', duration: 2500 })
	}
}

const showSkipModal = ref(false)
const showAddItemModal = ref(false)
// 弹层打开时固定原记录身份与版本：确认前 nextCheckup 可能被对端完成/顶替，
// 提交绝不落到顶替记录（冲突按旧基线如实暴露，由用户在冲突卡解决）
const skipTarget = ref(null)     // { id, revision }
const addItemTarget = ref(null)  // { id, revision }

function handleSkipCheckup() {
	if (dataSource.value === 'family') {
		const cloud = familyStore.checkups[nextCheckup.value && nextCheckup.value._id]
		skipTarget.value = cloud && !cloud.deleted ? { id: cloud.id, revision: cloud.revision || 0 } : null
	} else {
		skipTarget.value = nextCheckup.value ? { id: nextCheckup.value._id } : null
	}
	showSkipModal.value = true
}

async function doSkipCheckup() {
	const target = skipTarget.value
	skipTarget.value = null
	if (!target || !target.id) return
	if (dataSource.value === 'family') {
		const cloud = familyStore.checkups[target.id]
		if (!cloud || cloud.deleted) {
			uni.showToast({ title: '该产检已被删除或已更新，请刷新后重试', icon: 'none', duration: 2500 })
			familyStore.pullCheckups().catch(() => {})
			return
		}
		// 以打开弹窗时捕获的旧 revision 为基线：对端期间推进 → 冲突，不改落他条
		const r = await familyStore.markCheckupStatus(target.id, 'skipped', target.revision)
		if (r.ok) uni.showToast({ title: '已跳过', icon: 'success' })
		else if (r.code === 'revision-conflict') {
			uni.showToast({ title: '对方已修改本次产检，请在同步横幅中处理', icon: 'none', duration: 2500 })
			familyStore.pullCheckups().catch(() => {})
		} else {
			uni.showToast({ title: r.message || '操作失败', icon: 'none', duration: 2500 })
		}
		return
	}
	if (dataSource.value !== 'demo') return
	const ok = await healthStore.skipCheckup(target.id)
	if (ok) {
		uni.showToast({ title: '已跳过', icon: 'success' })
	} else {
		uni.showToast({ title: '本机保存失败，已还原，请重试', icon: 'none', duration: 2500 })
	}
}

function handleAddItem() {
	if (dataSource.value === 'family') {
		const cloud = familyStore.checkups[nextCheckup.value && nextCheckup.value._id]
		addItemTarget.value = cloud && !cloud.deleted ? { id: cloud.id, revision: cloud.revision || 0 } : null
	} else {
		addItemTarget.value = nextCheckup.value ? { id: nextCheckup.value._id } : null
	}
	showAddItemModal.value = true
}

async function doAddItem(text) {
	const trimmed = (text || '').trim()
	// 按弹窗打开时捕获的记录执行（nextCheckup 顶替后不落到他条）
	const target = addItemTarget.value
	addItemTarget.value = null
	if (!trimmed || !target || !target.id) return
	if (dataSource.value === 'family' && familyStore) {
		const cloud = familyStore.checkups[target.id]
		if (!cloud || cloud.deleted) {
			uni.showToast({ title: '该产检已被删除或已更新，请刷新后重试', icon: 'none', duration: 2500 })
			familyStore.pullCheckups().catch(() => {})
			return
		}
		const items = (cloud.examItems || []).map(it => ({
			itemId: it.itemId, text: it.text, required: Boolean(it.required), done: Boolean(it.done)
		}))
		if (items.length >= 50) {
			uni.showToast({ title: '检查项已达上限', icon: 'none' })
			return
		}
		items.push({
			itemId: 'itm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
			text: trimmed.slice(0, 50), required: false, done: false
		})
		// 打开弹窗时捕获的旧 revision 基线：对端期间推进 → 冲突，由用户解决
		const r = await familyStore.saveCheckup(target.id, { examItems: items }, undefined, target.revision)
		if (r.ok) {
			uni.showToast({ title: '已添加', icon: 'success' })
		} else if (r.code === 'revision-conflict') {
			uni.showToast({ title: '对方已修改，请在同步横幅中处理', icon: 'none', duration: 2500 })
			familyStore.pullCheckups().catch(() => {})
		} else {
			uni.showToast({ title: r.message || '操作失败，请重试', icon: 'none', duration: 2500 })
		}
		return
	}
	if (dataSource.value !== 'demo') return
	const ok = await healthStore.addCustomExamItem(target.id, trimmed)
	if (ok) {
		uni.showToast({ title: '已添加', icon: 'success' })
	} else {
		uni.showToast({ title: '本机保存失败，已还原，请重试', icon: 'none', duration: 2500 })
	}
}

// ── 完整编辑器（family：日期/时间/医院/陪同/材料/问题；打开捕获旧 revision 基线）──
const showEditor = ref(false)
const editChk = ref(null) // { id, baseline }
const edDate = ref('')
const edTime = ref('')
const edHospital = ref('')
const edCompanion = ref('')
const edMaterials = ref('')
const edQuestions = ref('')

function openEditor() {
	if (dataSource.value !== 'family' || !nextCheckup.value || !nextCheckup.value._id) return
	const cloud = familyStore.checkups[nextCheckup.value._id]
	if (!cloud) return
	editChk.value = { id: cloud.id, baseline: cloud.revision || 0 } // 基线：后台刷新不抬高提交版本
	edDate.value = cloud.dateKey || ''
	edTime.value = cloud.time || ''
	edHospital.value = cloud.hospital || ''
	edCompanion.value = cloud.companion || ''
	edMaterials.value = (cloud.materials || []).join('\n')
	edQuestions.value = (cloud.questions || []).join('\n')
	showEditor.value = true
}
function onPickDate(e) { edDate.value = e.detail.value }
function onPickTime(e) { edTime.value = e.detail.value }

async function saveEditor() {
	if (!editChk.value) return
	if (!/^\d{4}-\d{2}-\d{2}$/.test(edDate.value || '')) {
		uni.showToast({ title: '请选择日期', icon: 'none' })
		return
	}
	const materials = edMaterials.value.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 20)
	const questions = edQuestions.value.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 20)
	const r = await familyStore.saveCheckup(editChk.value.id, {
		dateKey: edDate.value,
		time: edTime.value || null,
		hospital: edHospital.value.trim() || null,
		companion: edCompanion.value.trim() || null,
		materials, questions
	}, undefined, editChk.value.baseline)
	if (r.ok) {
		showEditor.value = false
		uni.showToast({ title: '已保存（共享）', icon: 'none' })
	} else if (r.code === 'revision-conflict') {
		uni.showToast({ title: '对方已修改，请刷新后重试', icon: 'none', duration: 2500 })
		familyStore.pullCheckups().catch(() => {})
	} else {
		uni.showToast({ title: r.message || '保存失败，请重试', icon: 'none', duration: 2500 })
	}
}

// ── 空档案生成标准产检安排（按当前 LMP 计算日期；持久可恢复协议）──
const STANDARD_SCHEDULE = [
	{ week: 8, items: ['建档登记', '血压体重', '血常规', '尿常规', '血型RH', '肝肾功能', '传染病筛查'] },
	{ week: 12, items: ['NT检查', '早期唐筛', '血压体重'] },
	{ week: 16, items: ['中期唐筛/无创DNA', '血压体重', '听胎心'] },
	{ week: 20, items: ['血压体重', '听胎心', '宫高腹围'] },
	{ week: 24, items: ['系统B超（大排畸）', '血压体重', '听胎心'] },
	{ week: 28, items: ['OGTT糖耐量试验', '血常规', '血压体重'] },
	{ week: 30, items: ['血压体重', '听胎心', '宫高腹围'] },
	{ week: 32, items: ['B超评估', '胎心监护', '血压体重'] },
	{ week: 34, items: ['血压体重', '听胎心'] },
	{ week: 36, items: ['B超', '胎心监护', '骨盆评估', '血压体重'] },
	{ week: 37, items: ['胎心监护', '血压体重'] },
	{ week: 38, items: ['胎心监护', 'B超', '血压体重'] },
	{ week: 39, items: ['胎心监护', '血压体重'] },
	{ week: 40, items: ['胎心监护', 'B超', '分娩评估'] }
]
function scheduleDateKey(lmpKey, week) {
	const [y, m, d] = lmpKey.split('-').map(Number)
	const t = new Date(Date.UTC(y, m - 1, d) + week * 7 * 86400000)
	return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}
async function generateSchedule() {
	if (dataSource.value !== 'family') return
	const lmp = famLmpKey.value
	if (!lmp || !/^\d{4}-\d{2}-\d{2}$/.test(lmp)) {
		uni.showToast({ title: '请先在「我的-孕期信息」设置末次月经日期', icon: 'none', duration: 2500 })
		return
	}
	const templates = STANDARD_SCHEDULE.map(s => ({
		templateKey: 'std_w' + s.week,
		dateKey: scheduleDateKey(lmp, s.week),
		examItems: s.items.map((t, i) => ({ itemId: `w${s.week}_i${i}`, text: t, required: i === 0 }))
	}))
	uni.showLoading({ title: '生成中…' })
	let res
	try {
		res = await familyStore.initializeCheckupTemplates(templates)
	} finally {
		uni.hideLoading()
	}
	if (!res) return
	const created = res.results.filter(r => r.ok && !r.skipped).length
	if (res.ok) {
		uni.showToast({ title: created > 0 ? `已生成 ${created} 次产检` : '安排已存在', icon: 'none' })
	} else {
		uni.showToast({ title: '部分未完成，待同步稍后自动重试', icon: 'none', duration: 2500 })
	}
	familyStore.pullCheckups().catch(() => {})
}

// ── 孕期日期迁移：预览 → 确认（逐条持久待办，部分失败可恢复续传）──
const migrationInfo = computed(() => {
	if (dataSource.value !== 'family' || !familyStore) return null
	return familyStore.lmpMigrationInfo
})
const showMigrationSheet = ref(false)
const migrationPreview = ref(null) // { shiftDays, toUpdate: [{id, oldDateKey, newDateKey, revision}] }
const migrationApplying = ref(false)

async function openMigrationPreview() {
	if (!migrationInfo.value) return
	uni.showLoading({ title: '加载预览…' })
	let res
	try {
		res = await familyStore.previewCheckupMigration()
	} finally {
		uni.hideLoading()
	}
	if (!res.ok) {
		uni.showToast({ title: res.message || '预览失败，请稍后重试', icon: 'none', duration: 2500 })
		return
	}
	migrationPreview.value = res
	showMigrationSheet.value = true
}

async function confirmMigration() {
	const pv = migrationPreview.value
	if (!pv || !pv.toUpdate || pv.toUpdate.length === 0) {
		showMigrationSheet.value = false
		return
	}
	migrationApplying.value = true
	let res
	try {
		res = await familyStore.applyCheckupMigration(pv.toUpdate)
	} finally {
		migrationApplying.value = false
	}
	if (res.ok) {
		uni.showToast({ title: '调整完成', icon: 'success' })
		showMigrationSheet.value = false
		migrationPreview.value = null
		familyStore.pullCheckups().catch(() => {})
		return
	}
	const failed = (res.results || []).filter(r => !r.ok && !r.resolved).length
	const resolved = (res.results || []).filter(r => !r.ok && r.resolved).length
	uni.showToast({
		title: `部分完成：${failed} 项待重试` + (resolved ? `，${resolved} 项已无需调整` : ''),
		icon: 'none', duration: 3000
	})
	// 刷新预览：剩余项仍在待办中，可重试续传（已移动的不再出现）
	const again = await familyStore.previewCheckupMigration().catch(() => null)
	if (again && again.ok) migrationPreview.value = again
}

// ── 同步状态（family）：只统计本领域（checkup*）待办与冲突 ──
const chkPendingEntries = computed(() => {
	void familyStore.pendingCount // 响应式失效源
	try { return getOutbox().filter(e => e.kind.startsWith('checkup') && !e.conflict) } catch (e) { return [] }
})
const chkConflictList = computed(() => {
	void familyStore.conflictEntries
	try { return getOutbox().filter(e => e.kind.startsWith('checkup') && e.conflict) } catch (e) { return [] }
})
const chkLastSyncLabel = computed(() => {
	const t = familyStore.lastCheckupSyncAt
	return t ? '上次完整同步 ' + new Date(t).toLocaleString() : '尚未完整同步'
})

async function retrySync() {
	const r = await familyStore.flushAll()
	if (r && r.ok === false && r.reason === 'busy') return
	familyStore.pullCheckups().catch(() => {})
}
function conflictLabel(entry) {
	return (entry.currentRecord && entry.currentRecord.dateKey) ||
		(entry.payload && entry.payload.dateKey) ||
		(entry.extra && entry.extra.id) || '产检'
}
function describeCheckup(p) {
	if (!p) return ''
	const parts = []
	if (p.dateKey) parts.push(`日期 ${p.dateKey}`)
	if (p.time) parts.push(`时间 ${p.time}`)
	if (p.hospital) parts.push(`医院 ${p.hospital}`)
	if (p.companion) parts.push(`陪同 ${p.companion}`)
	if (p.status) parts.push(`状态 ${p.status}`)
	if (p.examItems) parts.push(`检查项 ${p.examItems.length} 项`)
	if (p.targetDone !== undefined) parts.push(p.targetDone ? '勾选检查项' : '取消勾选检查项')
	return parts.join(' · ')
}
async function adoptCloudFor(entryId) {
	const ok = await familyStore.adoptCloud(entryId)
	if (!ok) {
		uni.showToast({ title: '获取云端版本失败，待办已保留', icon: 'none', duration: 2500 })
		return
	}
	uni.showToast({ title: '已采用云端版本', icon: 'none' })
	familyStore.pullCheckups().catch(() => {})
}
async function resubmitFor(entryId) {
	const r = await familyStore.resubmit(entryId)
	if (r && r.ok) {
		uni.showToast({ title: '已重新提交', icon: 'none' })
		familyStore.pullCheckups().catch(() => {})
	} else if (r && r.code === 'revision-conflict') {
		uni.showToast({ title: '云端又有更新，请采用云端或稍后再试', icon: 'none', duration: 2500 })
	} else {
		uni.showToast({ title: (r && r.message) || '提交失败，待办已保留', icon: 'none', duration: 2500 })
	}
}

function formatHistoryDate(dateStr) {
	if (!dateStr) return ''
	const { y, m, d } = dateKeyParts(dateStr)
	return `${y}年${m}月${d}日`
}

function countDoneItems(schedule) {
	if (!schedule.exam_items) return 0
	return schedule.exam_items.filter(i => i.done).length
}

// 历史记录展开/折叠
const expandedHistory = ref({})
function toggleHistoryExpand(idx) {
	expandedHistory.value[idx] = !expandedHistory.value[idx]
}

// 加载数据：正式模式不后台悄悄写模板（空档案显式生成入口）；
// 仅演示模式沿用旧本地初始化
onMounted(async () => {
	if (dataSource.value !== 'family') {
		await healthStore.loadCheckupSchedules()
		if (dataSource.value === 'demo' && healthStore.checkupSchedules.length === 0) {
			await healthStore.initCheckupSchedules()
		}
	}
	loading.value = false
})
</script>

<style scoped lang="scss">
.page {
	display: flex;
	flex-direction: column;
	height: 100vh;
	background-color: #FBF7F2;
}

.hero-rose {
	background: linear-gradient(155deg, #C45070 0%, #E07898 40%, #F4C0CC 100%);
	flex-shrink: 0;
	position: relative;
	overflow: hidden;
}



.hero-content {
	padding: 0 36rpx 40rpx;
	position: relative;
	z-index: 1;
}

.hero-label {
	display: block;
	font-size: 22rpx;
	color: rgba(255, 255, 255, 0.7);
	letter-spacing: 3rpx;
	margin-bottom: 6rpx;
}

.hero-date {
	display: block;
	font-size: 84rpx;
	font-weight: 700;
	color: #FFFFFF;
	line-height: 1;
}

.hero-sub {
	display: block;
	font-size: 24rpx;
	color: rgba(255, 255, 255, 0.8);
	margin-top: 6rpx;
}

.countdown-pill {
	display: inline-flex;
	align-items: center;
	gap: 12rpx;
	background: rgba(255, 255, 255, 0.2);
	border: 2rpx solid rgba(255, 255, 255, 0.3);
	border-radius: 999rpx;
	padding: 12rpx 28rpx;
	margin-top: 20rpx;
}

.countdown-num {
	font-size: 44rpx;
	font-weight: 700;
	color: #FFFFFF;
}

.countdown-lbl {
	font-size: 22rpx;
	color: rgba(255, 255, 255, 0.8);
}

.scroll-content { flex: 1; }

.loading-container {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	padding: 120rpx 0;
}

.loading-spinner {
	width: 48rpx;
	height: 48rpx;
	border: 4rpx solid #E4E1DC;
	border-top-color: #C45070;
	border-radius: 50%;
	animation: spin 0.8s linear infinite;
	margin-bottom: 16rpx;
}

@keyframes spin {
	to { transform: rotate(360deg); }
}

.loading-text {
	font-size: 26rpx;
	color: #9C9890;
}

.info-card {
	background: #FFFFFF;
	border-radius: 32rpx;
	box-shadow: 0 4rpx 28rpx rgba(60, 30, 10, 0.07);
	margin: 28rpx 28rpx 0;
	padding: 28rpx;
}

.info-title {
	display: block;
	font-size: 28rpx;
	font-weight: 600;
	color: #1C1A17;
	margin-bottom: 20rpx;
}

.info-row {
	display: flex;
	gap: 16rpx;
	margin-bottom: 16rpx;
	align-items: flex-start;
}

.info-row:last-child { margin-bottom: 0; }

.info-icon {
	font-size: 28rpx;
	flex-shrink: 0;
	margin-top: 2rpx;
}

.info-text {
	font-size: 26rpx;
	color: #4A4844;
	line-height: 1.6;
}

.section-title {
	display: block;
	padding: 20rpx 28rpx 12rpx;
	font-size: 26rpx;
	font-weight: 600;
	color: #1C1A17;
}

.exam-list {
	padding: 0 28rpx;
}

.exam-item {
	background: #FFFFFF;
	border-radius: 20rpx;
	box-shadow: 0 4rpx 28rpx rgba(60, 30, 10, 0.07);
	padding: 24rpx 26rpx;
	margin-bottom: 16rpx;
	display: flex;
	align-items: center;
	gap: 20rpx;
}

.exam-item:active {
	opacity: 0.85;
	transform: scale(0.98);
}

.exam-check {
	width: 40rpx;
	height: 40rpx;
	border-radius: 10rpx;
	border: 4rpx solid #E8DDD0;
	background: #F2F0EE;
	display: flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
}

.exam-checked .exam-check {
	background: #7BA08C;
	border-color: #7BA08C;
}

.check-mark {
	font-size: 22rpx;
	color: #FFFFFF;
}

.exam-text {
	font-size: 26rpx;
	color: #1C1A17;
	flex: 1;
}

.exam-text-done {
	text-decoration: line-through;
	color: #9C9890;
}

.exam-tag {
	padding: 4rpx 14rpx;
	border-radius: 999rpx;
	flex-shrink: 0;
}

.tag-req { background: #FAEAEE; }
.tag-req .exam-tag-text { color: #B04560; }
.tag-opt { background: #F2F0EE; }
.tag-opt .exam-tag-text { color: #9C9890; }

.exam-tag-text {
	font-size: 20rpx;
	font-weight: 600;
}

/* ── 历史记录 ── */
.history-list {
	padding: 0 28rpx;
}

.history-item {
	background: #FFFFFF;
	border-radius: 20rpx;
	box-shadow: 0 4rpx 28rpx rgba(60, 30, 10, 0.07);
	padding: 24rpx 26rpx;
	margin-bottom: 16rpx;
}

.history-item:active { opacity: 0.85; }

.history-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
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
	background: #7BA08C;
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
	gap: 4rpx;
}

.history-arrow {
	font-size: 22rpx;
	color: #9C9890;
	margin-left: 8rpx;
	transition: transform 0.2s;
}

.arrow-up {
	display: inline-block;
	transform: rotate(90deg);
}

/* ── 历史详情展开 ── */
.history-detail {
	margin-top: 20rpx;
	padding-top: 16rpx;
	border-top: 2rpx solid #F2F0EE;
}

.detail-row {
	display: flex;
	align-items: center;
	gap: 16rpx;
	padding: 10rpx 0;
}

.detail-check {
	font-size: 22rpx;
	color: #7BA08C;
	flex-shrink: 0;
	width: 28rpx;
	text-align: center;
}

.detail-text {
	font-size: 24rpx;
	color: #1C1A17;
	flex: 1;
}

.detail-done {
	color: #9C9890;
	text-decoration: line-through;
}

.detail-tag {
	padding: 2rpx 10rpx;
	border-radius: 999rpx;
	flex-shrink: 0;
}

.history-done-count {
	font-size: 28rpx;
	font-weight: 700;
	color: #7BA08C;
}

.history-done-label {
	font-size: 22rpx;
	color: #9C9890;
}

.bottom-spacer { height: 40rpx; }

/* ── 同步状态 banner（checkup 域） ── */
.sync-banner { margin: 20rpx 28rpx 0; padding: 20rpx 24rpx; background: #FEF4E3; border: 2rpx solid rgba(240,169,64,0.4); border-radius: 20rpx; }
.sync-banner-row { display: flex; align-items: center; justify-content: space-between; }
.sync-banner-title { font-size: 26rpx; font-weight: 600; color: #B07818; }
.sync-banner-btn { background: #F0A940; border-radius: 999rpx; padding: 8rpx 24rpx; }
.sync-banner-btn-text { font-size: 22rpx; color: #FFFFFF; font-weight: 600; }
.sync-banner-time { font-size: 20rpx; color: #B07818; margin-top: 8rpx; display: block; opacity: 0.8; }

.conflict-card { margin-top: 16rpx; padding: 20rpx; background: #FFFFFF; border: 2rpx solid rgba(240,169,64,0.5); border-radius: 16rpx; }
.conflict-title { font-size: 24rpx; font-weight: 600; color: #8C5A10; display: block; margin-bottom: 12rpx; }
.conflict-row { display: flex; gap: 12rpx; margin-bottom: 8rpx; align-items: flex-start; }
.conflict-side { font-size: 22rpx; color: #9C9890; flex-shrink: 0; width: 110rpx; }
.conflict-val { font-size: 22rpx; color: #4A4844; line-height: 1.5; flex: 1; }
.conflict-actions { display: flex; gap: 16rpx; margin-top: 12rpx; }
.conflict-btn { flex: 1; height: 64rpx; border-radius: 32rpx; display: flex; align-items: center; justify-content: center; }
.conflict-btn-ghost { background: #F2F0EE; }
.conflict-btn-solid { background: #C45070; }
.conflict-btn-ghost-text { font-size: 24rpx; font-weight: 600; color: #6E6A64; }
.conflict-btn-solid-text { font-size: 24rpx; font-weight: 600; color: #FFFFFF; }

/* ── 孕期日期迁移横幅 ── */
.migrate-banner { margin: 20rpx 28rpx 0; padding: 24rpx; background: #FDF3E3; border: 2rpx solid rgba(240,169,64,0.5); border-radius: 20rpx; display: flex; align-items: center; }
.migrate-body { flex: 1; }
.migrate-title { font-size: 26rpx; font-weight: 600; color: #8C5A10; display: block; }
.migrate-desc { font-size: 22rpx; color: #A87F3A; margin-top: 6rpx; display: block; line-height: 1.5; }
.migrate-arrow { font-size: 32rpx; color: #C8C4BC; margin-left: 12rpx; }

/* ── 空档案生成入口 ── */
.generate-card { margin: 20rpx 28rpx 0; display: flex; align-items: center; padding: 28rpx; background: #FAEAEE; border: 2rpx solid #F0C4D0; border-radius: 24rpx; }
.generate-icon { width: 80rpx; height: 80rpx; border-radius: 20rpx; background: #FDEEF1; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.generate-icon-text { font-size: 36rpx; }
.generate-body { flex: 1; margin-left: 20rpx; }
.generate-title { font-size: 28rpx; font-weight: 600; color: #1C1A17; display: block; }
.generate-desc { font-size: 22rpx; color: #9C9890; margin-top: 4rpx; display: block; }
.generate-arrow { font-size: 32rpx; color: #C8C4BC; }

/* ── 编辑产检信息入口 ── */
.edit-chk-btn { margin-top: 20rpx; padding: 16rpx; border-radius: 14rpx; background: #FAEAEE; text-align: center; }
.edit-chk-btn:active { opacity: 0.7; }
.edit-chk-btn-text { font-size: 24rpx; color: #B04560; font-weight: 600; }

/* ── 编辑/迁移弹层 ── */
.sheet-mask { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.45); z-index: 200; display: flex; align-items: flex-end; }
.sheet-body { width: 100%; max-height: 80vh; overflow-y: auto; background: #FFFFFF; border-radius: 32rpx 32rpx 0 0; padding: 40rpx 36rpx; padding-bottom: calc(40rpx + env(safe-area-inset-bottom)); box-sizing: border-box; }
.sheet-title { display: block; font-size: 32rpx; font-weight: 600; color: #1C1A17; margin-bottom: 28rpx; }
.ed-label { display: block; font-size: 24rpx; font-weight: 500; color: #9C9890; margin: 20rpx 0 12rpx; }
.ed-value { height: 80rpx; line-height: 80rpx; background: #F2F0EE; border-radius: 16rpx; padding: 0 24rpx; font-size: 28rpx; color: #3A3834; display: inline-block; min-width: 320rpx; }
.ed-time-row { display: flex; align-items: center; gap: 16rpx; }
.ed-clear { padding: 8rpx 20rpx; }
.ed-clear-text { font-size: 22rpx; color: #B04560; }
.ed-input { width: 100%; height: 88rpx; background: #F2F0EE; border-radius: 16rpx; padding: 0 24rpx; font-size: 28rpx; color: #1C1A17; box-sizing: border-box; }
.ed-textarea { width: 100%; height: 160rpx; background: #F2F0EE; border-radius: 16rpx; padding: 20rpx 24rpx; font-size: 26rpx; color: #1C1A17; box-sizing: border-box; }
.sheet-actions { display: flex; gap: 20rpx; margin-top: 32rpx; }
.sheet-btn { flex: 1; height: 88rpx; border-radius: 44rpx; display: flex; align-items: center; justify-content: center; }
.sheet-btn-cancel { background: #F2F0EE; }
.sheet-btn-confirm { background: linear-gradient(135deg, #C45070, #D86888); }
.sheet-btn-text-cancel { font-size: 28rpx; font-weight: 600; color: #6E6A64; }
.sheet-btn-text-confirm { font-size: 28rpx; font-weight: 600; color: #FFFFFF; }

.mig-desc { display: block; font-size: 24rpx; color: #6E6A64; line-height: 1.6; margin-bottom: 20rpx; }
.mig-list { max-height: 480rpx; overflow-y: auto; background: #FBF7F2; border-radius: 16rpx; padding: 12rpx 20rpx; }
.mig-row { display: flex; align-items: center; gap: 16rpx; padding: 12rpx 0; }
.mig-date { font-size: 26rpx; color: #6E6A64; }
.mig-date-new { color: #C45070; font-weight: 600; }
.mig-arrow { font-size: 26rpx; color: #C8C4BC; }
.mig-empty { padding: 32rpx 0; text-align: center; }
.mig-empty-text { font-size: 24rpx; color: #9C9890; }

.history-dot-skip { background: #C8C4BC; }

/* ── 添加检查项 ── */
.exam-add {
	margin: 0 28rpx;
	padding: 20rpx;
	text-align: center;
	background: #FFFFFF;
	border-radius: 20rpx;
	border: 2rpx dashed #D8D2C8;
}

.exam-add:active { opacity: 0.7; }

.exam-add-text {
	font-size: 26rpx;
	color: #9C9890;
}

/* ── 操作按钮 ── */
.action-area {
	padding: 16rpx 28rpx 0;
	display: flex;
	flex-direction: column;
	gap: 16rpx;
}

.btn-primary {
	background: linear-gradient(135deg, #C45070, #D86888);
	border-radius: 20rpx;
	padding: 24rpx;
	text-align: center;
	box-shadow: 0 6rpx 24rpx rgba(196, 80, 112, 0.25);
}

.btn-primary:active { opacity: 0.85; transform: scale(0.98); }

.btn-primary-text {
	font-size: 28rpx;
	font-weight: 600;
	color: #FFFFFF;
}

.btn-text {
	padding: 20rpx;
	text-align: center;
}

.btn-text:active { opacity: 0.7; }

.btn-text-label {
	font-size: 26rpx;
	color: #9C9890;
	text-decoration: underline;
}

/* ── 过期状态 ── */
.pill-overdue {
	background: rgba(255, 200, 200, 0.3);
	border-color: rgba(255, 200, 200, 0.4);
}
</style>
