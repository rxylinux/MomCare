import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { request, isLoggedIn as isAuthed, isRealAuthed, isGuestMode, setToken, removeToken, getToken, GUEST_TOKEN, tokenFingerprint } from '@/utils/api.js'
import { useReportStore } from '@/stores/report.js'
import {
  getDataMode, setDataMode, healthStorageKey, ensureLegacyBackup,
  createFormalBackups, FORMAL_HEALTH_KEY, FORMAL_REPORTS_KEY,
  DEMO_HEALTH_KEY, DEMO_REPORTS_KEY
} from '@/utils/storage.js'

// 孕期计算工具函数
export function calcPregDay(lmpDate, targetDate) {
	const a = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate())
	const b = new Date(lmpDate.getFullYear(), lmpDate.getMonth(), lmpDate.getDate())
	return Math.floor((a - b) / 86400000)
}

export function calcWeekInfo(lmpDate, targetDate) {
	if (!lmpDate || !targetDate) return null
	const n = calcPregDay(lmpDate, targetDate)
	if (n < 0) return null
	return { week: Math.floor(n / 7), day: n % 7, total: n }
}

export function getTrimester(week) {
	if (week <= 12) return 'early'
	if (week <= 27) return 'mid'
	return 'late'
}

export function getTrimesterName(t) {
	return t === 'early' ? '孕早期' : t === 'mid' ? '孕中期' : '孕晚期'
}

// 宝宝大小比喻数据
const FRUIT_DATA = {
	4: { emoji: '🫘', name: '罂粟籽' },
	5: { emoji: '🍎', name: '苹果籽' },
	6: { emoji: '🫛', name: '甜豌豆' },
	7: { emoji: '🫐', name: '蓝莓' },
	8: { emoji: '🍇', name: '葡萄' },
	9: { emoji: '🍒', name: '樱桃' },
	10: { emoji: '🍓', name: '草莓' },
	11: { emoji: '🍋', name: '青柠' },
	12: { emoji: '🥝', name: '猕猴桃' },
	13: { emoji: '🍑', name: '桃子' },
	14: { emoji: '🍋', name: '柠檬' },
	15: { emoji: '🍎', name: '苹果' },
	16: { emoji: '🥑', name: '牛油果' },
	17: { emoji: '🧅', name: '洋葱' },
	18: { emoji: '🫑', name: '甜椒' },
	19: { emoji: '🍅', name: '大番茄' },
	20: { emoji: '🍌', name: '香蕉' },
	21: { emoji: '🥕', name: '胡萝卜' },
	22: { emoji: '🥭', name: '芒果' },
	23: { emoji: '🍠', name: '红薯' },
	24: { emoji: '🌽', name: '玉米' },
	25: { emoji: '🥦', name: '花椰菜' },
	26: { emoji: '🥬', name: '生菜' },
	27: { emoji: '🍆', name: '小茄子' },
	28: { emoji: '🍆', name: '长茄子' },
	29: { emoji: '🥥', name: '小椰子' },
	30: { emoji: '🥥', name: '椰子' },
	31: { emoji: '🍍', name: '菠萝' },
	32: { emoji: '🥬', name: '大白菜' },
	33: { emoji: '🍈', name: '哈密瓜' },
	34: { emoji: '🍈', name: '甜瓜' },
	35: { emoji: '🍯', name: '小蜜瓜' },
	36: { emoji: '🍯', name: '蜜瓜' },
	37: { emoji: '🍉', name: '小西瓜' },
	38: { emoji: '🍉', name: '西瓜' },
	39: { emoji: '🎃', name: '南瓜' },
	40: { emoji: '🍉', name: '大西瓜' }
};

// 标准产检推荐时间表
const CHECKUP_TEMPLATES = [
	{
		dayOffset: 42,
		week: 7,
		label: '孕7周',
		required: ['早孕B超', '血常规', '尿常规', '血型', '甲状腺功能'],
		optional: []
	},
	{
		dayOffset: 84,
		week: 12,
		label: '孕12周',
		required: ['NT检查', '早期唐筛', '血常规', '尿常规'],
		optional: []
	},
	{
		dayOffset: 119,
		week: 17,
		label: '孕17周',
		required: ['中期唐筛', '血常规', '尿常规'],
		optional: ['无创DNA']
	},
	{
		dayOffset: 147,
		week: 21,
		label: '孕21周',
		required: ['大排畸B超', '血常规', '尿常规'],
		optional: []
	},
	{
		dayOffset: 182,
		week: 26,
		label: '孕26周',
		required: ['糖耐量试验(OGTT)', '血常规', '尿常规'],
		optional: []
	},
	{
		dayOffset: 203,
		week: 29,
		label: '孕29周',
		required: ['常规产检', '小排畸B超'],
		optional: []
	},
	{
		dayOffset: 224,
		week: 32,
		label: '孕32周',
		required: ['胎心监护(NST)', '血常规', '尿常规', 'B超'],
		optional: []
	},
	{
		dayOffset: 238,
		week: 34,
		label: '孕34周',
		required: ['胎心监护', '常规产检'],
		optional: []
	},
	{
		dayOffset: 252,
		week: 36,
		label: '孕36周',
		required: ['B超(评估胎位和羊水)', '胎心监护', '血常规'],
		optional: []
	},
	{
		dayOffset: 259,
		week: 37,
		label: '孕37周',
		required: ['胎心监护', '常规产检', '骨盆测量'],
		optional: []
	},
	{
		dayOffset: 266,
		week: 38,
		label: '孕38周',
		required: ['胎心监护', '常规产检'],
		optional: []
	},
	{
		dayOffset: 273,
		week: 39,
		label: '孕39周',
		required: ['胎心监护', 'B超'],
		optional: []
	},
	{
		dayOffset: 280,
		week: 40,
		label: '孕40周',
		required: ['胎心监护', '常规产检'],
		optional: []
	}
]

export function getFruitComparison(week) {
	const keys = Object.keys(FRUIT_DATA).map(Number).sort((a, b) => a - b)
	let result = FRUIT_DATA[4]
	for (const k of keys) {
		if (week >= k) result = FRUIT_DATA[k]
	}
	return result
}

const AI_INTERPRET_DAILY_LIMIT = 5

function _loadStorage() {
	const key = healthStorageKey()
	if (!key) {
		// 模式未知（读取报错）：拒绝读取，防止读错命名空间
		console.error('_loadStorage: storage mode unknown, refuse to read')
		return null
	}
	try {
		const raw = uni.getStorageSync(key)
		return raw ? JSON.parse(raw) : null
	} catch (e) {
		console.error('_loadStorage error:', e)
		return null
	}
}

// 写盘失败必须可观测：返回 boolean，由调用方决定如何提示，不再吞掉错误。
// 模式未知时拒绝写入（fail closed），避免演示数据覆盖正式档案
function _saveStorage(data) {
	const key = healthStorageKey()
	if (!key) {
		console.error('_saveStorage: storage mode unknown, refuse to write')
		return false
	}
	try {
		uni.setStorageSync(key, JSON.stringify(data))
		return true
	} catch (e) {
		console.error('_saveStorage error:', e)
		return false
	}
}

// 一次性迁移更早版本的独立存储键到统一键（只搬真实历史数据，不注入默认值）
function _migrateOldKeys() {
	if (isGuestModeByMode()) return
	if (_loadStorage()) return

	const data = {
		schemaVersion: 2,
		origin: 'formal',
		lmpDate: null,
		dueDate: null,
		userInfo: { nickname: '', avatar: '🌸', hospital: '', babyNickname: '' },
		records: {},
		checkupSchedules: [],
		openid: '',
		aiInterpretUsage: null
	}

	let migratedAny = false
	try {
		const profileRaw = uni.getStorageSync('user_profile')
		if (profileRaw) {
			const profile = JSON.parse(profileRaw)
			if (profile.lmpDate) { data.lmpDate = profile.lmpDate; migratedAny = true }
			if (profile.dueDate) { data.dueDate = profile.dueDate; migratedAny = true }
			if (profile.userInfo) { Object.assign(data.userInfo, profile.userInfo); migratedAny = true }
		}

		const recordsRaw = uni.getStorageSync('health_records')
		if (recordsRaw) {
			data.records = JSON.parse(recordsRaw)
			migratedAny = true
		}

		const guestId = uni.getStorageSync('guest_id')
		if (guestId) { data.openid = guestId; migratedAny = true }
	} catch (e) {
		console.warn('_migrateOldKeys: migration partial', e)
		migratedAny = true
	}

	if (migratedAny) {
		// 来源未经用户确认，标记为 legacy；是否包含演示数据由用户在迁移时决定
		data.origin = 'legacy-unverified'
	}
	_saveStorage(data)
}

function isGuestModeByMode() {
	return getDataMode() === 'demo'
}

export const useHealthStore = defineStore('health', () => {
	// ── State ──
	const lmpDate = ref(null)
	const dueDate = ref(null)
	const records = ref({})
	const userProfileLoaded = ref(false)
	const dataMode = ref(getDataMode())
	const lastPersistError = ref('')

	const userInfo = ref({
		nickname: '',
		avatar: '🌸',
		hospital: '',
		babyNickname: ''
	})

	const checkupSchedules = ref([])
	const isLoggedIn = ref(false)
	const openid = ref('')
	const aiInterpretUsage = ref({
		date: '',
		used: 0
	})
	// 数据来源：'formal'（用户确认/全新）| 'legacy-unverified'（旧版本遗留，未确认归属）
	// | 'demo'。legacy-unverified 在用户显式确认前不得上传或绑定当前身份
	const dataOrigin = ref('formal')
	// 归属确认记录：数据归属被确认时所在登录身份的令牌指纹。
	// schemaVersion/origin 字段是结构信息，不代表用户同意；只有本字段与当前
	// token 指纹一致才允许上传。换 token 登录即失配，需重新确认
	const ownerFingerprint = ref('')
	// 当前会话身份的响应式镜像：token 读取不是响应式依赖，镜像只在
	// 身份相关入口（初始化/登录/退出/云同步/确认）刷新供界面横幅使用；
	// 上传守卫一律在动作时新鲜读取，不依赖镜像
	const sessionTokenFp = ref('')
	const sessionAuthed = ref(false)
	const lastSyncBlockReason = ref('')

	function _refreshSessionIdentity() {
		sessionTokenFp.value = tokenFingerprint(getToken())
		sessionAuthed.value = isRealAuthed()
	}
	_refreshSessionIdentity()

	// 动作时新鲜求值：本地是否存在未绑定当前身份的数据（上传/确认守卫用）
	function _unclaimedDataNow() {
		if (dataMode.value === 'demo') return false
		if (!hasLocalData.value) return false
		if (dataOrigin.value === 'legacy-unverified') return true
		if (!isRealAuthed()) return false
		return ownerFingerprint.value !== tokenFingerprint(getToken())
	}

	// ── Persist helper: serialize current state to storage; surface failures ──
	// origin/ownerTokenFingerprint 随状态携带：普通保存、重启不改变来源与归属；
	// legacy-unverified 或归属失配只有显式确认才解除
	function _persist() {
		normalizeAiInterpretUsage()
		const ok = _saveStorage({
			schemaVersion: 2,
			origin: dataMode.value === 'demo' ? 'demo' : dataOrigin.value,
			ownerTokenFingerprint: dataMode.value === 'demo' ? '' : ownerFingerprint.value,
			lmpDate: lmpDate.value ? lmpDate.value.toISOString() : null,
			dueDate: dueDate.value ? dueDate.value.toISOString() : null,
			userInfo: { ...userInfo.value },
			records: records.value,
			checkupSchedules: checkupSchedules.value,
			openid: openid.value,
			aiInterpretUsage: { ...aiInterpretUsage.value }
		})
		lastPersistError.value = ok ? '' : '本地保存失败：存储空间不足或不可写，数据暂保留在内存中'
		return ok
	}

	// ── Getters ──
	// today 为响应式 ref：由 refreshToday() 在回前台/跨日时刷新，依赖它的孕周等计算随之更新
	const today = ref(new Date())

	function refreshToday(now) {
		today.value = new Date(now ?? Date.now())
	}

	const pregInfoSet = computed(() => lmpDate.value !== null)

	// 本地是否存在实质数据（用于判断"有数据待归属确认"）
	const hasLocalData = computed(() =>
		Boolean(lmpDate.value || userInfo.value.nickname ||
			Object.keys(records.value).length > 0 || checkupSchedules.value.length > 0)
	)

	// 存在未绑定当前身份的本地数据：来源未确认，或归属指纹与当前登录令牌失配
	//（换账号登录、旧版本数据都属此类）。确认前禁止上传/绑定当前身份。
	// 响应式镜像驱动界面横幅；上传守卫用 _unclaimedDataNow 动作时新鲜求值
	const needsLegacyConfirm = computed(() => {
		if (dataMode.value === 'demo') return false
		if (!hasLocalData.value) return false
		if (dataOrigin.value === 'legacy-unverified') return true
		if (!sessionAuthed.value) return false
		return ownerFingerprint.value !== sessionTokenFp.value
	})

	const todayWeekInfo = computed(() => {
		if (!lmpDate.value) return null
		return calcWeekInfo(lmpDate.value, today.value)
	})

	const daysUntilDue = computed(() => {
		if (!dueDate.value) return 0
		const diff = dueDate.value.getTime() - today.value.getTime()
		return Math.max(0, Math.ceil(diff / 86400000))
	})

	const totalPregDays = computed(() => {
		return todayWeekInfo.value ? todayWeekInfo.value.total : 0
	})

	const progressPercent = computed(() => {
		if (!todayWeekInfo.value) return 0
		return Math.min(100, Math.round((todayWeekInfo.value.total / 280) * 1000) / 10)
	})

	const trimester = computed(() => {
		if (!todayWeekInfo.value) return 'early'
		return getTrimester(todayWeekInfo.value.week)
	})

	const fruitComparison = computed(() => {
		if (!todayWeekInfo.value) return { emoji: '🫘', name: '种子' }
		return getFruitComparison(todayWeekInfo.value.week)
	})

	// ── 产检日程 Getters ──

	const nextCheckup = computed(() => {
		return checkupSchedules.value
			.filter(s => s.status === 'upcoming')
			.sort((a, b) => a.checkup_date.localeCompare(b.checkup_date))[0] || null
	})

	const completedCheckups = computed(() => {
		return checkupSchedules.value
			.filter(s => s.status === 'completed')
			.sort((a, b) => b.checkup_date.localeCompare(a.checkup_date))
	})

	const upcomingCheckups = computed(() => {
		return checkupSchedules.value
			.filter(s => s.status === 'upcoming')
			.sort((a, b) => a.checkup_date.localeCompare(b.checkup_date))
	})

	const aiInterpretRemaining = computed(() => {
		normalizeAiInterpretUsage()
		return Math.max(0, AI_INTERPRET_DAILY_LIMIT - aiInterpretUsage.value.used)
	})

	const aiInterpretQuota = computed(() => {
		normalizeAiInterpretUsage()
		return {
			date: aiInterpretUsage.value.date,
			limit: AI_INTERPRET_DAILY_LIMIT,
			used: aiInterpretUsage.value.used,
			remaining: aiInterpretRemaining.value
		}
	})

	function getRecordKey(date) {
		const y = date.getFullYear()
		const m = String(date.getMonth() + 1).padStart(2, '0')
		const d = String(date.getDate()).padStart(2, '0')
		return `${y}-${m}-${d}`
	}

	function normalizeAiInterpretUsage(input = aiInterpretUsage.value) {
		const todayKey = getRecordKey(today.value)
		const source = input && typeof input === 'object' ? input : {}
		const hasUsageFields = source.used != null ||
			source.used_today != null ||
			source.ai_interpret_used_today != null ||
			source.remaining != null
		const date = source.date || source.used_date || source.ai_interpret_used_date || (hasUsageFields ? todayKey : '')
		const usedRaw = source.used ?? source.used_today ?? source.ai_interpret_used_today ??
			(source.remaining != null ? AI_INTERPRET_DAILY_LIMIT - Number(source.remaining) : 0)
		const used = Math.max(0, Math.min(AI_INTERPRET_DAILY_LIMIT, Number(usedRaw) || 0))

		const normalized = date === todayKey
			? { date: todayKey, used }
			: { date: todayKey, used: 0 }
		if (
			aiInterpretUsage.value.date !== normalized.date ||
			aiInterpretUsage.value.used !== normalized.used
		) {
			aiInterpretUsage.value = normalized
		}
		return aiInterpretUsage.value
	}

	function canUseAiInterpret() {
		normalizeAiInterpretUsage()
		return aiInterpretUsage.value.used < AI_INTERPRET_DAILY_LIMIT
	}

	async function consumeAiInterpretQuota() {
		if (!canUseAiInterpret()) return false
		aiInterpretUsage.value.used += 1
		_persist()
		await syncAiInterpretQuotaToCloud()
		return true
	}

	function updateAiInterpretQuota(usage) {
		normalizeAiInterpretUsage(usage)
		_persist()
	}

	async function syncAiInterpretQuotaToCloud() {
		if (!isRealAuthed()) return false
		try {
			return await syncProfileToCloud()
		} catch (e) {
			console.error('syncAiInterpretQuotaToCloud failed:', e)
			return false
		}
	}

	function getRecord(date) {
		return records.value[getRecordKey(date)] || null
	}

	function hasRecord(date) {
		const r = getRecord(date)
		return Boolean(r && (r.weight || r.bp || r.mood || r.fetal || r.note))
	}

	function getWeekInfo(date) {
		return calcWeekInfo(lmpDate.value, date)
	}

	function isToday(date) {
		return date.getFullYear() === today.value.getFullYear() &&
			date.getMonth() === today.value.getMonth() &&
			date.getDate() === today.value.getDate()
	}

	function isDueDate(date) {
		if (!dueDate.value) return false
		return date.getFullYear() === dueDate.value.getFullYear() &&
			date.getMonth() === dueDate.value.getMonth() &&
			date.getDate() === dueDate.value.getDate()
	}

	// ── 用户资料 ──

	function _applyPersisted(data) {
		if (!data) return
		if (data.origin) dataOrigin.value = data.origin
		// 归属指纹可能不存在（旧版本/全新数据）：留空即视为未绑定当前身份
		ownerFingerprint.value = typeof data.ownerTokenFingerprint === 'string' ? data.ownerTokenFingerprint : ''
		if (data.lmpDate) lmpDate.value = new Date(data.lmpDate)
		if (data.dueDate) dueDate.value = new Date(data.dueDate)
		if (data.userInfo) Object.assign(userInfo.value, data.userInfo)
		if (data.records) records.value = data.records
		if (data.checkupSchedules) checkupSchedules.value = data.checkupSchedules
		if (data.openid) openid.value = data.openid
		if (data.aiInterpretUsage) normalizeAiInterpretUsage(data.aiInterpretUsage)
	}

	async function loadUserProfile() {
		const data = _loadStorage()
		if (data) {
			if (data.lmpDate) lmpDate.value = new Date(data.lmpDate)
			if (data.dueDate) dueDate.value = new Date(data.dueDate)
			if (data.userInfo) Object.assign(userInfo.value, data.userInfo)
			if (data.openid) openid.value = data.openid
			if (data.aiInterpretUsage) normalizeAiInterpretUsage(data.aiInterpretUsage)
		}
		userProfileLoaded.value = true
	}

	// 保存资料；若末次月经发生变化则迁移未完成产检安排（保留历史与手动日期）。
	// 返回 { ok, schedulesMigrated }：ok 只有在“全部需要落盘的写入都成功”时才为 true
	async function saveUserProfile() {
		const persisted = _loadStorage()
		const previousLmp = persisted && persisted.lmpDate ? new Date(persisted.lmpDate) : null
		const lmpChanged = lmpDate.value && previousLmp &&
			getRecordKey(lmpDate.value) !== getRecordKey(previousLmp)

		// 首次设置孕期资料时初始化标准产检时间表（用户显式保存动作触发）
		if (lmpDate.value && checkupSchedules.value.length === 0) {
			initCheckupSchedulesInternal()
		}

		const profilePersisted = _persist()
		let schedulesPersisted = true
		let schedulesMigrated = false

		if (profilePersisted && lmpChanged) {
			schedulesMigrated = true
			// 迁移后的第二次写入结果不能忽略：失败时 ok 必须为 false
			schedulesPersisted = migrateCheckupSchedulesForNewLmp(lmpDate.value)
		}
		return { ok: profilePersisted && schedulesPersisted, schedulesMigrated }
	}

	// Sync all profile data to backend D1 (write-through)。
	// 旧缓存来源未经确认时禁止上传：不把未确认数据自动归属到当前登录者。
	// 身份判断在动作时新鲜读取（token 变更不依赖响应式缓存）
	async function syncProfileToCloud() {
		if (!isRealAuthed()) return false
		if (_unclaimedDataNow()) {
			console.warn('syncProfileToCloud blocked: local data not claimed by current identity')
			lastSyncBlockReason.value = '本机数据尚未确认归属当前账号；确认前不会上传或绑定（我的页面可确认）'
			_refreshSessionIdentity()
			return false
		}
		_refreshSessionIdentity()
		lastSyncBlockReason.value = ''

		const updateData = {}
		if (dueDate.value) {
			const y = dueDate.value.getFullYear()
			const m = String(dueDate.value.getMonth() + 1).padStart(2, '0')
			const d = String(dueDate.value.getDate()).padStart(2, '0')
			updateData.expected_due_date = `${y}-${m}-${d}`
		}
		if (lmpDate.value) {
			const y = lmpDate.value.getFullYear()
			const m = String(lmpDate.value.getMonth() + 1).padStart(2, '0')
			const d = String(lmpDate.value.getDate()).padStart(2, '0')
			updateData.lmp_date = `${y}-${m}-${d}`
		}
		if (userInfo.value.nickname) {
			updateData.nickname = userInfo.value.nickname
		}
		updateData.profile_data = {
			babyNickname: userInfo.value.babyNickname || '',
			preWeight: userInfo.value.preWeight || '',
			height: userInfo.value.height || '',
			hospital: userInfo.value.hospital || '',
			doctor: userInfo.value.doctor || '',
			hospitalPhone: userInfo.value.hospitalPhone || '',
			aiInterpretUsage: { ...normalizeAiInterpretUsage() },
		}

		try {
			const res = await request({
				url: '/api/user/profile',
				method: 'PUT',
				data: updateData,
			})
			return res.statusCode === 200 && res.data?.code === 0
		} catch (e) {
			console.error('syncProfileToCloud failed:', e)
			return false
		}
	}

	// Fetch profile from backend and overwrite local state (cloud is source of truth)
	async function syncProfileFromCloud() {
		if (!isRealAuthed()) return false

		try {
			const res = await request({
				url: '/api/user/profile',
				method: 'GET',
			})
			if (res.statusCode === 200 && res.data?.code === 0) {
				const serverUser = res.data.data
				uni.setStorageSync('momcare_user', JSON.stringify(serverUser))

				if (serverUser.expected_due_date) {
					const due = new Date(serverUser.expected_due_date)
					if (!isNaN(due.getTime())) {
						dueDate.value = due
					}
				}
				if (serverUser.lmp_date) {
					const lmp = new Date(serverUser.lmp_date)
					if (!isNaN(lmp.getTime())) {
						lmpDate.value = lmp
					}
				} else if (serverUser.expected_due_date) {
					const due = new Date(serverUser.expected_due_date)
					lmpDate.value = new Date(due.getTime() - 280 * 86400000)
				}
				if (serverUser.nickname) {
					userInfo.value.nickname = serverUser.nickname
				}
				if (serverUser.profile_data) {
					const pd = serverUser.profile_data
					if (pd.babyNickname) userInfo.value.babyNickname = pd.babyNickname
					if (pd.preWeight) userInfo.value.preWeight = pd.preWeight
					if (pd.height) userInfo.value.height = pd.height
					if (pd.hospital) userInfo.value.hospital = pd.hospital
					if (pd.doctor) userInfo.value.doctor = pd.doctor
					if (pd.hospitalPhone) userInfo.value.hospitalPhone = pd.hospitalPhone
					if (pd.aiInterpretUsage) normalizeAiInterpretUsage(pd.aiInterpretUsage)
				}
				if (serverUser.ai_interpret_used_date || serverUser.ai_interpret_used_today != null) {
					normalizeAiInterpretUsage({
						date: serverUser.ai_interpret_used_date,
						used: serverUser.ai_interpret_used_today
					})
				}
				_persist()
				return true
			}
			return false
		} catch (e) {
			// 网络失败：本地数据保持不动，不伪装成同步成功
			console.error('syncProfileFromCloud failed:', e)
			return false
		}
	}

	// Unified cloud sync: pull both profile and reports from cloud
	async function syncCloudData() {
		if (!isRealAuthed()) return false

		let profileOk = false
		let reportsOk = false

		try {
			profileOk = await syncProfileFromCloud()
		} catch (e) {
			console.error('syncCloudData: profile sync failed', e)
		}

		try {
			const reportStore = useReportStore()
			reportsOk = await reportStore.syncReportsFromCloud()
		} catch (e) {
			console.error('syncCloudData: reports sync failed', e)
		}

		return profileOk || reportsOk
	}

	// ── 健康记录（纯本地） ──

	async function loadRecords() {
		const data = _loadStorage()
		if (data && data.records) {
			records.value = data.records
		}
	}

	// 返回 { ok, persisted }：写盘失败时内存保留记录，调用方必须向用户提示失败
	async function saveRecord(date, data) {
		const key = getRecordKey(date)
		records.value[key] = { ...records.value[key], ...data }
		const persisted = _persist()
		return { ok: persisted, persisted }
	}

	// ── 产检日程（纯本地） ──

	function _templateToSchedule(template, lmpDateVal, hospitalDefault) {
		const date = new Date(lmpDateVal.getTime() + template.dayOffset * 86400000)
		const dateKey = getRecordKey(date)
		const examItems = [
			...template.required.map(text => ({ text, required: true, done: false })),
			...template.optional.map(text => ({ text, required: false, done: false }))
		]
		return {
			_id: 'local_' + template.week + '_' + dateKey,
			checkup_date: dateKey,
			week_of_pregnancy: template.week,
			week_label: template.label,
			hospital: hospitalDefault || '',
			department: '产科门诊',
			time_slot: 'morning',
			status: 'upcoming',
			exam_items: examItems,
			notes: '',
			remind_days_before: [1, 3]
		}
	}

	async function loadCheckupSchedules() {
		const data = _loadStorage()
		if (data && data.checkupSchedules) {
			checkupSchedules.value = data.checkupSchedules
		}
	}

	function initCheckupSchedulesInternal() {
		if (!lmpDate.value) return
		const hospitalDefault = userInfo.value.hospital || ''
		checkupSchedules.value = CHECKUP_TEMPLATES.map(template =>
			_templateToSchedule(template, lmpDate.value, hospitalDefault)
		)
		_persist()
	}

	async function initCheckupSchedules() {
		initCheckupSchedulesInternal()
	}

	// 末次月经调整后迁移产检安排：
	// - 只重算“可确认由模板生成、未完成、未手动改期”的安排（模板槽位）
	// - 已完成/已跳过/手动日期/自定义安排，以及同孕周的多条历史记录，全部原样保留
	// - 不用“同孕周”推断同一条记录：同周第二条起视为独立历史/自定义安排
	function migrateCheckupSchedulesForNewLmp(newLmpDate) {
		if (!newLmpDate) return false
		const hospitalDefault = userInfo.value.hospital || ''
		const existing = [...checkupSchedules.value]
		const consumed = new Set()
		const result = []

		const isTemplateSlot = s => s && s.status === 'upcoming' && !s.date_manually_set &&
			typeof s._id === 'string' && s._id.startsWith('local_')

		for (const template of CHECKUP_TEMPLATES) {
			const candidates = existing.filter(s => s.week_of_pregnancy === template.week && !consumed.has(s._id))
			const slot = candidates.find(isTemplateSlot)
			if (slot) {
				consumed.add(slot._id)
				const fresh = _templateToSchedule(template, newLmpDate, slot.hospital || hospitalDefault)
				result.push({
					...slot,
					checkup_date: fresh.checkup_date,
					exam_items: slot.exam_items && slot.exam_items.length
						? slot.exam_items
						: fresh.exam_items
				})
			} else if (candidates.length === 0) {
				// 该孕周完全没有记录时才新增模板安排；已有历史/手动记录则不重复添加
				result.push(_templateToSchedule(template, newLmpDate, hospitalDefault))
			}
		}

		// 未被模板槽位消费的记录（同孕周历史、手动日期、自定义安排）全部保留
		for (const s of existing) {
			if (!consumed.has(s._id)) {
				result.push(s)
			}
		}

		result.sort((a, b) => a.checkup_date.localeCompare(b.checkup_date))
		checkupSchedules.value = result
		return _persist()
	}

	async function updateCheckupSchedule(scheduleId, data) {
		const idx = checkupSchedules.value.findIndex(s => s._id === scheduleId)
		if (idx >= 0) {
			checkupSchedules.value[idx] = { ...checkupSchedules.value[idx], ...data }
		}
		return _persist()
	}

	async function toggleExamItem(scheduleId, itemIdx) {
		const schedule = checkupSchedules.value.find(s => s._id === scheduleId)
		if (!schedule) return false

		const items = schedule.exam_items.map(item => ({ ...item }))
		items[itemIdx].done = !items[itemIdx].done
		const ok = await updateCheckupSchedule(scheduleId, { exam_items: items })
		if (!ok) {
			// 写盘失败回滚，避免界面显示与持久层不一致
			items[itemIdx].done = !items[itemIdx].done
			await updateCheckupSchedule(scheduleId, { exam_items: items })
		}
		return ok
	}

	async function markCheckupCompleted(scheduleId) {
		const schedule = checkupSchedules.value.find(s => s._id === scheduleId)
		const prev = schedule ? schedule.status : null
		const ok = await updateCheckupSchedule(scheduleId, { status: 'completed' })
		if (!ok && prev) await updateCheckupSchedule(scheduleId, { status: prev })
		return ok
	}

	async function skipCheckup(scheduleId) {
		const schedule = checkupSchedules.value.find(s => s._id === scheduleId)
		const prev = schedule ? schedule.status : null
		const ok = await updateCheckupSchedule(scheduleId, { status: 'skipped' })
		if (!ok && prev) await updateCheckupSchedule(scheduleId, { status: prev })
		return ok
	}

	async function addCustomExamItem(scheduleId, text) {
		const schedule = checkupSchedules.value.find(s => s._id === scheduleId)
		if (!schedule) return false
		const items = schedule.exam_items.map(item => ({ ...item }))
		items.push({ text, required: false, done: false })
		const ok = await updateCheckupSchedule(scheduleId, { exam_items: items })
		if (!ok) {
			// 写盘失败：移除刚加入的条目，保持与持久层一致
			const reverted = schedule.exam_items.filter(i => i !== items[items.length - 1])
			await updateCheckupSchedule(scheduleId, { exam_items: reverted })
		}
		return ok
	}

	// ── 统计方法 ──

	function getWeightStats() {
		const entries = []
		for (const [dateKey, record] of Object.entries(records.value)) {
			if (record.weight) {
				entries.push({ date: dateKey, weight: record.weight })
			}
		}
		entries.sort((a, b) => b.date.localeCompare(a.date))

		if (entries.length === 0) {
			return { latest: null, gain: null, count: 0 }
		}

		const latest = parseFloat(entries[0].weight)
		const preWeight = parseFloat(userInfo.value.preWeight)
		let gain = null
		if (preWeight && latest) {
			gain = (latest - preWeight).toFixed(1)
		}

		return {
			latest: latest ? latest.toFixed(1) : null,
			gain: gain !== null ? (gain >= 0 ? `+${gain}` : gain) : null,
			preWeight: preWeight || null,
			count: entries.length
		}
	}

	function getBpStats() {
		const entries = []
		for (const [dateKey, record] of Object.entries(records.value)) {
			if (record.bp) {
				const parts = String(record.bp).split('/')
				const systolic = parts[0] ? parseInt(parts[0]) : 0
				const diastolic = parts[1] ? parseInt(parts[1]) : 0
				entries.push({
					date: dateKey,
					bpText: String(record.bp),
					systolic,
					diastolic,
					status: systolic >= 140 || diastolic >= 90 ? '偏高' : '正常'
				})
			}
		}
		entries.sort((a, b) => b.date.localeCompare(a.date))

		if (entries.length === 0) {
			return { latest: null, status: '', count: 0 }
		}

		return {
			latest: entries[0].bpText,
			status: entries[0].status,
			systolic: entries[0].systolic,
			diastolic: entries[0].diastolic,
			count: entries.length
		}
	}

	function getFetalStats() {
		const todayKey = getRecordKey(today.value)
		const yesterday = new Date(today.value)
		yesterday.setDate(yesterday.getDate() - 1)
		const yesterdayKey = getRecordKey(yesterday)

		const entries = []
		for (const [dateKey, record] of Object.entries(records.value)) {
			if (record.fetal) {
				entries.push({ date: dateKey, count: parseInt(record.fetal) || 0 })
			}
		}
		entries.sort((a, b) => b.date.localeCompare(a.date))

		const todayCount = entries.find(e => e.date === todayKey)?.count || 0
		const yesterdayCount = entries.find(e => e.date === yesterdayKey)?.count || 0

		return {
			today: todayCount,
			yesterday: yesterdayCount,
			count: entries.length
		}
	}

	function getWeightHistory() {
		const entries = []
		for (const [dateKey, record] of Object.entries(records.value)) {
			if (record.weight) {
				const weekInfo = calcWeekInfo(lmpDate.value, new Date(dateKey))
				entries.push({
					date: dateKey,
					dateDisplay: _formatDateDisplay(dateKey),
					week: weekInfo ? `孕${weekInfo.week}周+${weekInfo.day}` : '',
					weight: parseFloat(record.weight).toFixed(1),
					weekInfo
				})
			}
		}
		entries.sort((a, b) => b.date.localeCompare(a.date))

		for (let i = 0; i < entries.length; i++) {
			if (i < entries.length - 1) {
				const diff = (parseFloat(entries[i].weight) - parseFloat(entries[i + 1].weight)).toFixed(1)
				entries[i].diff = diff >= 0 ? `+${diff}` : diff
				entries[i].diffClass = diff > 0 ? 'diff-up' : diff < 0 ? 'diff-down' : 'diff-zero'
			} else {
				entries[i].diff = '±0'
				entries[i].diffClass = 'diff-zero'
			}
		}

		return entries
	}

	function getBpHistory() {
		const entries = []
		for (const [dateKey, record] of Object.entries(records.value)) {
			if (record.bp) {
				const parts = String(record.bp).split('/')
				const systolic = parts[0] ? parseInt(parts[0]) : 0
				const diastolic = parts[1] ? parseInt(parts[1]) : 0
				const weekInfo = calcWeekInfo(lmpDate.value, new Date(dateKey))
				entries.push({
					date: dateKey,
					dateDisplay: _formatDateDisplay(dateKey),
					week: weekInfo ? `孕${weekInfo.week}周+${weekInfo.day}` : '',
					systolic: String(systolic),
					diastolic: String(diastolic),
					bpText: String(record.bp),
					status: systolic >= 140 || diastolic >= 90 ? '偏高' : '正常',
					statusClass: systolic >= 140 || diastolic >= 90 ? 'badge-high' : 'badge-normal',
					weekInfo
				})
			}
		}
		entries.sort((a, b) => b.date.localeCompare(a.date))
		return entries
	}

	function getFetalHistory() {
		const entries = []
		for (const [dateKey, record] of Object.entries(records.value)) {
			if (record.fetal) {
				const weekInfo = calcWeekInfo(lmpDate.value, new Date(dateKey))
				entries.push({
					date: dateKey,
					dateDisplay: _formatDateDisplay(dateKey),
					week: weekInfo ? `孕${weekInfo.week}周+${weekInfo.day}` : '',
					count: parseInt(record.fetal) || 0,
					weekInfo
				})
			}
		}
		entries.sort((a, b) => b.date.localeCompare(a.date))

		const now = today.value
		const year = now.getFullYear()
		const month = now.getMonth()
		const daysInMonth = new Date(year, month + 1, 0).getDate()
		const firstDayOfWeek = new Date(year, month, 1).getDay()

		const heatmapData = []
		for (let d = 1; d <= daysInMonth; d++) {
			const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
			const entry = entries.find(e => e.date === dateKey)
			const count = entry ? entry.count : 0
			heatmapData.push({
				day: d,
				count,
				heatClass: _getHeatLevel(count),
				isToday: d === now.getDate()
			})
		}

		return {
			entries,
			heatmap: {
				year,
				month,
				daysInMonth,
				firstDayOfWeek,
				data: heatmapData
			}
		}
	}

	function _getHeatLevel(count) {
		if (!count || count === 0) return 'heat-0'
		if (count >= 10 && count < 14) return 'heat-1'
		if (count >= 14 && count < 18) return 'heat-2'
		if (count >= 18 && count < 22) return 'heat-3'
		if (count >= 22) return 'heat-4'
		return 'heat-0'
	}

	function _formatDateDisplay(dateKey) {
		const parts = dateKey.split('-')
		return `${parseInt(parts[1])}月${parseInt(parts[2])}日`
	}

	function getGreeting() {
		const name = userInfo.value.nickname || '宝妈'
		const hour = today.value.getHours()
		if (hour < 6) return `夜深了，${name}`
		if (hour < 11) return `早上好，${name}`
		if (hour < 14) return `中午好，${name}`
		if (hour < 18) return `下午好，${name}`
		return `晚上好，${name}`
	}

	// ── 会话与数据模式 ──

	function _resetState() {
		lmpDate.value = null
		dueDate.value = null
		records.value = {}
		checkupSchedules.value = []
		openid.value = ''
		userInfo.value = { nickname: '', avatar: '🌸', hospital: '', babyNickname: '' }
		aiInterpretUsage.value = { date: '', used: 0 }
		dataOrigin.value = 'formal'
		ownerFingerprint.value = ''
		sessionTokenFp.value = ''
		sessionAuthed.value = false
		lastSyncBlockReason.value = ''
	}

	// 启动初始化：恢复持久化数据；正式模式绝不注入演示数据、
	// 不自动生成 token 或用户身份。旧数据先做一次性可恢复备份。
	function initializeApp() {
		try {
			_refreshSessionIdentity()
			ensureLegacyBackup()
			dataMode.value = getDataMode()

			if (dataMode.value === 'demo') {
				// 恢复演示会话：演示数据在演示键内，缺失则补齐演示样例
				setToken(GUEST_TOKEN)
				_migrateDemoKeys()
				const data = _loadStorage()
				_applyPersisted(data)
				isLoggedIn.value = true
				userProfileLoaded.value = true
				_persist()
				return true
			}

			_migrateOldKeys()
			const data = _loadStorage()
			_applyPersisted(data)

			// 旧版本遗留的游客 token 不再伪装为登录态：清除后由用户真实登录或显式进入演示
			if (isGuestMode()) {
				removeToken()
				try { uni.removeStorageSync('momcare_user') } catch (e) { /* ignore */ }
			}

			// 旧版本数据（无 schemaVersion）：来源未经用户确认，标记为
			// legacy-unverified；不删除、不清洗任何内容，确认前禁止上传/认领
			if (data && !data.schemaVersion) {
				dataOrigin.value = 'legacy-unverified'
				_persist()
			}

			// 正式模式身份只来自真实登录；此处不设置 token、不造假用户
			isLoggedIn.value = isAuthed()
			userProfileLoaded.value = true
			return true
		} catch (e) {
			console.error('initializeApp error:', e)
			return false
		}
	}

	function _migrateDemoKeys() {
		if (_loadStorage()) return
		_saveStorage({
			schemaVersion: 2,
			origin: 'demo',
			lmpDate: null,
			dueDate: null,
			userInfo: { nickname: '', avatar: '🌸', hospital: '', babyNickname: '' },
			records: {},
			checkupSchedules: [],
			openid: '',
			aiInterpretUsage: null
		})
	}

	// 显式进入演示模式（登录页"一键体验"按钮）：
	// 示例数据只写入演示存储，正式档案不受影响。
	// 模式标记写入或读回失败时中止，避免演示数据落到正式存储键
	function enterDemoMode() {
		try {
			ensureLegacyBackup()
			if (!setDataMode('demo') || getDataMode() !== 'demo') {
				console.error('enterDemoMode: cannot persist demo mode, abort')
				return false
			}
			_refreshSessionIdentity()
			dataMode.value = 'demo'
			setToken(GUEST_TOKEN)

			_resetState()
			_migrateDemoKeys()

			const now = new Date()
			const defaultLmp = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 112)
			lmpDate.value = defaultLmp
			dueDate.value = new Date(defaultLmp.getTime() + 280 * 86400000)
			openid.value = generateGuestId()
			userInfo.value = {
				nickname: '幸福准妈妈',
				avatar: '🌸',
				babyNickname: '小糯米',
				preWeight: '52',
				height: '165',
				hospital: '市妇幼保健院'
			}

			initCheckupSchedulesInternal()

			// 演示示例记录：字段名与真实记录一致（bp/fetal/note），展示统计一致
			const y = now.getFullYear()
			const m = String(now.getMonth() + 1).padStart(2, '0')
			const d = String(now.getDate()).padStart(2, '0')
			records.value = {
				[`${y}-${m}-${d}`]: {
					weight: 55.8,
					bp: '116/76',
					fetal: 8,
					mood: 'happy',
					note: '今天宝宝在肚子里轻轻动了一下，感觉很幸福！'
				}
			}

			isLoggedIn.value = true
			userProfileLoaded.value = true
			_persist()
			return true
		} catch (e) {
			console.error('enterDemoMode error:', e)
			return false
		}
	}

	// 退出当前会话（演示或登录）：清 token 与身份标记；
	// 本地健康数据不删除（保留待用户处理），模式回到正式。
	// 模式未知或从演示切回正式的写入失败时中止退出并返回 false，
	// 不允许在错误命名空间继续运行
	function exitSession() {
		const mode = getDataMode()
		if (mode === null) {
			console.error('exitSession: storage mode unknown, abort')
			lastPersistError.value = '退出失败：本地存储状态未知，请重启应用后重试'
			return false
		}
		if (mode === 'demo') {
			if (!setDataMode('formal') || getDataMode() !== 'formal') {
				console.error('exitSession: cannot persist formal mode, abort logout')
				lastPersistError.value = '退出失败：本地模式切换未生效，请重试'
				return false
			}
		}
		try {
			uni.removeStorageSync('momcare_user')
		} catch (e) {
			console.warn('exitSession remove user failed:', e)
		}
		dataMode.value = 'formal'
		_resetState()
		_refreshSessionIdentity()
		isLoggedIn.value = false
		userProfileLoaded.value = false
		return true
	}

	// 登录/注册成功后恢复正式档案（云端资料由调用方另行同步）。
	// 模式标记写入或读回失败时中止：避免把演示存储当成正式档案加载
	function afterRealLogin() {
		if (!setDataMode('formal') || getDataMode() !== 'formal') {
			console.error('afterRealLogin: cannot persist formal mode, abort')
			lastPersistError.value = '进入正式模式失败：本地模式切换未生效，请重试'
			return false
		}
		dataMode.value = 'formal'
		ensureLegacyBackup()
		_resetState()
		_refreshSessionIdentity()
		const data = _loadStorage()
		_applyPersisted(data)
		// 登录前本机没有实质数据 = 全新账号：此后新建的数据直接归属当前身份；
		// 若已有数据（无论 origin 字段写什么），登录本身不构成归属确认
		const dataExisted = Boolean(data && (data.lmpDate || (data.userInfo && data.userInfo.nickname) ||
			Object.keys(data.records || {}).length > 0 || (data.checkupSchedules || []).length > 0))
		if (!dataExisted) {
			ownerFingerprint.value = tokenFingerprint(getToken())
			_persist()
		} else if (data && !data.schemaVersion) {
			// 旧版本数据：保持未确认来源
			dataOrigin.value = 'legacy-unverified'
			_persist()
		}
		isLoggedIn.value = true
		userProfileLoaded.value = true
		return true
	}

	// 清除本机数据：只作用于当前模式的存储键。
	// - 演示模式：只清演示键，绝不触碰正式数据
	// - 正式模式：先写备份，备份全部成功才清除；随后全量重置内存
	//   （含档案/身份字段），避免后续持久化把旧内容写回
	function clearLocalData() {
		const mode = getDataMode()
		if (mode === null) {
			// 模式未知：清除属危险操作，一律拒绝
			return { ok: false, scope: 'unknown', message: '本地存储状态未知，为保护数据已取消操作' }
		}
		if (mode === 'demo') {
			try {
				uni.removeStorageSync(DEMO_HEALTH_KEY)
				uni.removeStorageSync(DEMO_REPORTS_KEY)
			} catch (e) {
				console.error('clearLocalData: demo keys remove failed:', e)
				return { ok: false, scope: 'demo', message: '清除失败，请重试' }
			}
			_resetState()
			try {
				const reportStore = useReportStore()
				reportStore.resetLocalState()
			} catch (e) {
				console.warn('clearLocalData: report store reset failed:', e)
			}
			return { ok: true, scope: 'demo', message: '演示数据已清除' }
		}

		const backup = createFormalBackups()
		if (!backup.ok) {
			return { ok: false, scope: 'formal', message: '备份写入不成功，已保留原数据' }
		}
		try {
			uni.removeStorageSync(FORMAL_HEALTH_KEY)
			uni.removeStorageSync(FORMAL_REPORTS_KEY)
		} catch (e) {
			console.error('clearLocalData: formal keys remove failed:', e)
			return { ok: false, scope: 'formal', message: '清除失败，请重试' }
		}
		_resetState()
		try {
			const reportStore = useReportStore()
			reportStore.resetLocalState()
		} catch (e) {
			console.warn('clearLocalData: report store reset failed:', e)
		}
		return { ok: true, scope: 'formal', message: backup.healthKey || backup.reportsKey
			? '已清除，已自动创建备份'
			: '已清除（本机原本没有数据）' }
	}

	// 用户显式确认本地数据归属当前登录身份：写入与当前令牌绑定的归属指纹，
	// 此后才恢复上传通路。换 token 登录会令指纹失配、重新进入待确认。
	// 确认动作本身落盘成功才算完成；身份判断动作时新鲜读取
	function confirmLegacyOrigin() {
		if (!_unclaimedDataNow()) return { ok: true, changed: false }
		const prevOrigin = dataOrigin.value
		const prevOwner = ownerFingerprint.value
		dataOrigin.value = 'formal'
		ownerFingerprint.value = tokenFingerprint(getToken())
		const ok = _persist()
		if (!ok) {
			// 落盘失败回滚，保持未确认状态
			dataOrigin.value = prevOrigin
			ownerFingerprint.value = prevOwner
			return { ok: false, changed: false, message: '确认未保存成功，请重试' }
		}
		_refreshSessionIdentity()
		lastSyncBlockReason.value = ''
		return { ok: true, changed: true }
	}

	function generateGuestId() {
		const timestamp = Date.now()
		const random = String(Math.floor(Math.random() * 10000)).padStart(4, '0')
		return `guest_${timestamp}${random}`
	}

	// ── 头像选择（H5 本地） ──

	async function chooseAvatar() {
		try {
			const res = await new Promise((resolve, reject) => {
				uni.chooseImage({
					count: 1,
					sourceType: ['album', 'camera'],
					success: resolve,
					fail: reject
				})
			})
			if (res.tempFilePaths && res.tempFilePaths.length > 0) {
				const prevAvatar = userInfo.value.avatar
				userInfo.value.avatar = res.tempFilePaths[0]
				if (_persist()) {
					uni.showToast({ title: '头像已更新', icon: 'success' })
				} else {
					userInfo.value.avatar = prevAvatar
					uni.showToast({ title: '头像保存失败，请重试', icon: 'none' })
				}
				return true
			}
		} catch (e) {
			if (e.errMsg && e.errMsg.includes('cancel')) return false
			console.warn('chooseAvatar error:', e)
			uni.showToast({ title: '选择头像失败', icon: 'none' })
		}
		return false
	}

	return {
		// state
		lmpDate,
		dueDate,
		records,
		userInfo,
		userProfileLoaded,
		pregInfoSet,
		dataMode,
		lastPersistError,
		// getters
		today,
		todayWeekInfo,
		daysUntilDue,
		totalPregDays,
		progressPercent,
		trimester,
		fruitComparison,
		// methods
		getRecordKey,
		getRecord,
		hasRecord,
		getWeekInfo,
		isToday,
		isDueDate,
		refreshToday,
		// profile
		loadUserProfile,
		saveUserProfile,
		syncProfileToCloud,
		syncProfileFromCloud,
		syncCloudData,
		// actions
		loadRecords,
		saveRecord,
		// checkup schedules
		checkupSchedules,
		nextCheckup,
		completedCheckups,
		upcomingCheckups,
		aiInterpretUsage,
		aiInterpretRemaining,
		aiInterpretQuota,
		canUseAiInterpret,
		consumeAiInterpretQuota,
		updateAiInterpretQuota,
		syncAiInterpretQuotaToCloud,
		loadCheckupSchedules,
		initCheckupSchedules,
		migrateCheckupSchedulesForNewLmp,
		updateCheckupSchedule,
		toggleExamItem,
		markCheckupCompleted,
		skipCheckup,
		addCustomExamItem,
		// statistics
		getWeightStats,
		getBpStats,
		getFetalStats,
		getWeightHistory,
		getBpHistory,
		getFetalHistory,
		// greeting
		getGreeting,
		// session / mode
		isLoggedIn,
	openid,
	dataOrigin,
	ownerFingerprint,
	needsLegacyConfirm,
	lastSyncBlockReason,
	confirmLegacyOrigin,
		initializeApp,
		enterDemoMode,
		exitSession,
		afterRealLogin,
		clearLocalData,
		chooseAvatar,
	}
})
