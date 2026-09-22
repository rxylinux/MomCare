import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useHealthStore } from '@/stores/health.js'
import { request, API_BASE, getToken, isRealAuthed, isGuestMode } from '@/utils/api.js'
import { useToolsStore } from '@/services/toolsStore.js'
import { reportsStorageKey, isDemoMode, FORMAL_REPORTS_KEY } from '@/utils/storage.js'
import { legacyFormalStoresEnabled, formalStoresQuarantineMessage, legacyHttpEnabled, legacyDisabledMessage } from '@/utils/backendGate.js'
import { isFamilyMode } from '@/services/sessionService.js'

// 报告类型映射
export const REPORT_TYPES = [
  { key: 'blood_routine', label: '血常规', icon: '🩸', typeClass: 'type-blood' },
  { key: 'ultrasound', label: 'B 超', icon: '📊', typeClass: 'type-ultrasound' },
  { key: 'down_screening', label: '唐氏筛查', icon: '🧬', typeClass: 'type-screen' },
  { key: 'ogtt', label: '糖耐量', icon: '🍬', typeClass: 'type-sugar' },
  { key: 'urine', label: '尿常规', icon: '🔬', typeClass: 'type-urine' },
  { key: 'nipt', label: '无创 DNA', icon: '🧾', typeClass: 'type-screen' },
  { key: 'obstetric', label: '产科记录', icon: '🩺', typeClass: 'type-other' },
  { key: 'biochemical', label: '生化全套', icon: '🧪', typeClass: 'type-blood' },
  { key: 'other', label: '其他', icon: '📋', typeClass: 'type-other' }
]

// Tab 分组定义
export const TAB_DEFS = [
  { key: 'all', name: '全部' },
  { key: 'blood', name: '血液检查', types: ['blood_routine', 'biochemical', 'ogtt'] },
  { key: 'ultrasound', name: 'B 超', types: ['ultrasound'] },
  { key: 'screening', name: '筛查', types: ['down_screening', 'nipt'] },
  { key: 'urine', name: '尿常规', types: ['urine'] },
  { key: 'obstetric', name: '产科记录', types: ['obstetric'] },
  { key: 'other', name: '其他', types: ['other'] }
]

export function getTypeInfo(typeKey) {
  return REPORT_TYPES.find(t => t.key === typeKey) || REPORT_TYPES[REPORT_TYPES.length - 1]
}

// 将 AI 返回的中文报告类型映射为系统 key
function mapChineseTypeToKey(chineseType) {
  if (!chineseType) return ''
  const mapping = {
    '血常规': 'blood_routine',
    '尿常规': 'urine',
    'b超': 'ultrasound',
    'B超': 'ultrasound',
    '彩超': 'ultrasound',
    '唐筛': 'down_screening',
    '唐氏筛查': 'down_screening',
    '糖耐': 'ogtt',
    '糖耐量': 'ogtt',
    '葡萄糖耐量': 'ogtt',
    '无创dna': 'nipt',
    '无创DNA': 'nipt',
    '无创': 'nipt',
    '产科': 'obstetric',
    '产科记录': 'obstetric',
    '生化': 'biochemical',
    '生化全套': 'biochemical',
    '大排畸': 'ultrasound',
    '小排畸': 'ultrasound',
    '三维': 'ultrasound',
    '四维': 'ultrasound',
    '胎心监护': 'obstetric'
  }
  if (mapping[chineseType]) return mapping[chineseType]
  const lower = chineseType.toLowerCase()
  for (const [cn, key] of Object.entries(mapping)) {
    if (lower.includes(cn.toLowerCase()) || cn.toLowerCase().includes(lower)) {
      return key
    }
  }
  return ''
}

// 旧正式键隔离（R2）：非演示模式下 YUNTU_REPORTS_DATA 读取返回空、写入拒绝，
// 数据保留磁盘待 B3 迁移
function _loadStorage() {
  const key = reportsStorageKey()
  if (!key) {
    console.error('_loadStorage: storage mode unknown, refuse to read')
    return null
  }
  if (!legacyFormalStoresEnabled() && key === FORMAL_REPORTS_KEY) {
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

// 写盘失败必须可观测：返回 boolean，由调用方决定如何提示。
// 模式未知时拒绝写入（fail closed）
function _saveStorage(data) {
  const key = reportsStorageKey()
  if (!key) {
    console.error('_saveStorage: storage mode unknown, refuse to write')
    return false
  }
  if (!legacyFormalStoresEnabled() && key === FORMAL_REPORTS_KEY) {
    console.warn('_saveStorage: formal key quarantined until B3 migration')
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

function _generateId() {
  return 'rpt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
}

function _normalizeFileUrls(r) {
  return Array.isArray(r.file_urls) ? r.file_urls : (r.file_urls ? [r.file_urls] : [])
}

// AI 结果结构校验：OCR 成功与 AI 解读成功分开判断。
// 仅 OCR 文本、错误对象、畸形指标列表、空解读都不能证明解读完成。
// 可展示解读 = overall_summary 文本，或结构化指标列表，或行动建议列表
// （与 pages/archives/ai-result.vue 实际消费的字段一致）。
export function isValidAiResult(aiData) {
  if (!aiData || typeof aiData !== 'object' || Array.isArray(aiData)) return false
  // 明确的错误/失败载体不是解读结果
  if (typeof aiData.error === 'string' && aiData.error.trim()) return false
  if (aiData.status === 'error' || aiData.status === 'failed') return false
  if (aiData.report_type === '解析失败') return false

  if (typeof aiData.overall_summary === 'string' && aiData.overall_summary.trim().length > 0) {
    return true
  }
  const indicators = aiData.abnormal_indicators
  if (Array.isArray(indicators) && indicators.length > 0 &&
      indicators.every(i => i && typeof i === 'object' && !Array.isArray(i) && typeof i.name === 'string' && i.name.trim())
  ) {
    return true
  }
  const suggestions = aiData.action_suggestions
  if (Array.isArray(suggestions) && suggestions.length > 0 &&
      suggestions.every(s => typeof s === 'string' && s.trim().length > 0)
  ) {
    return true
  }
  return false
}

// OCR 是否成功（独立于 AI 解读判断）
export function hasValidOcrText(aiData) {
  return Boolean(aiData && typeof aiData === 'object' &&
    typeof aiData.ocr_text === 'string' && aiData.ocr_text.trim().length > 0)
}

export const useReportStore = defineStore('report', () => {
  let healthStore = null

  // ── State ──
  const reports = ref([])
  const unarchivedReports = ref([])
  const currentFilter = ref({
    tab: 'all',
    keyword: '',
    weekRange: null,
    timeRange: null
  })
  const aiStatusMap = ref({})
  const pendingUpload = ref(null)
  const batchItemUpdate = ref(null)
  const listNeedsRefresh = ref(false)
  // 最近一次云同步结果：'' 无尝试 / 'ok' / 'network' / 'server' / 'unauthenticated'
  const lastSyncStatus = ref('')
  const lastSyncAt = ref(null)
  const lastPersistError = ref('')

  // ── Persist helper ──
  function _persist() {
    const ok = _saveStorage({
      reports: reports.value,
      unarchivedReports: unarchivedReports.value
    })
    if (!ok && !legacyFormalStoresEnabled() && !isDemoMode()) {
      lastPersistError.value = formalStoresQuarantineMessage()
    } else {
      lastPersistError.value = ok ? '' : '本地保存失败：存储空间不足或不可写，数据暂保留在内存中'
    }
    return ok
  }

  // ── Getters ──

  const filteredReports = computed(() => {
    let list = reports.value

    const tabDef = TAB_DEFS.find(t => t.key === currentFilter.value.tab)
    if (tabDef && tabDef.types) {
      list = list.filter(r => tabDef.types.includes(r.report_type))
    }

    const kw = (currentFilter.value.keyword || '').trim().toLowerCase()
    if (kw) {
      list = list.filter(r => {
        const typeInfo = getTypeInfo(r.report_type)
        const typeName = typeInfo ? typeInfo.label : ''
        const date = r.report_date || ''
        const week = r.week_of_pregnancy != null ? String(r.week_of_pregnancy) : ''
        return typeName.toLowerCase().includes(kw) ||
               date.includes(kw) ||
               date.replace(/-/g, '/').includes(kw) ||
               week.includes(kw)
      })
    }

    const wr = currentFilter.value.weekRange
    if (wr) {
      list = list.filter(r => {
        const w = Number(r.week_of_pregnancy)
        return !isNaN(w) && w >= wr.min && w <= wr.max
      })
    }

    const tr = currentFilter.value.timeRange
    if (tr) {
      const now = new Date()
      let months
      if (tr === '1m') months = 1
      else if (tr === '3m') months = 3
      else if (tr === '6m') months = 6
      if (months) {
        const cutoff = new Date(now.getFullYear(), now.getMonth() - months, now.getDate())
        list = list.filter(r => {
          const d = new Date(r.report_date)
          return d >= cutoff
        })
      }
    }

    return list
  })

  const groupedReports = computed(() => {
    const groups = {}
    const sorted = [...filteredReports.value].sort((a, b) => {
      const da = a.report_date || a.create_time || ''
      const db = b.report_date || b.create_time || ''
      return db.localeCompare(da)
    })
    for (const r of sorted) {
      const dateStr = r.report_date || ''
      let monthKey = ''
      if (dateStr) {
        const d = new Date(dateStr)
        if (!isNaN(d.getTime())) {
          monthKey = `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`
        }
      }
      if (!monthKey) monthKey = '未知日期'
      if (!groups[monthKey]) groups[monthKey] = []
      groups[monthKey].push(r)
    }
    return Object.entries(groups).map(([month, reports]) => ({ month, reports }))
  })

  const tabCounts = computed(() => {
    return TAB_DEFS.map(tab => {
      if (tab.key === 'all') {
        const count = reports.value.length
        return count > 99 ? '99+' : count
      }
      const count = reports.value.filter(r => tab.types.includes(r.report_type)).length
      return count > 99 ? '99+' : count
    })
  })

  const hasActiveFilter = computed(() => {
    return currentFilter.value.weekRange != null || currentFilter.value.timeRange != null
  })

  const activeFilterCount = computed(() => {
    let count = 0
    if (currentFilter.value.weekRange) count++
    if (currentFilter.value.timeRange) count++
    return count
  })

  // 是否存在未同步到云端的本地内容（仅真实登录时有意义）
  const hasPendingSync = computed(() => {
    if (!isRealAuthed()) return false
    return [...reports.value, ...unarchivedReports.value].some(r => r._pendingSync || r._local)
  })

  // ── Actions ──

  function getHealthStore() {
    if (!healthStore) {
      healthStore = useHealthStore()
    }
    return healthStore
  }

  // ── Cloud Sync ──

  // 拉取云端报告并与本地合并：
  // - 网络/业务失败：本地数据原样保留，返回 false（绝不把失败当成功）
  // - 成功：云端为准更新已同步报告；本地待同步/本地新建的报告保留，不被空列表清除
  async function syncReportsFromCloud() {
    if (!isRealAuthed()) {
      lastSyncStatus.value = isGuestMode() ? 'unauthenticated' : 'unauthenticated'
      return false
    }

    let res
    try {
      res = await request({
        url: '/api/reports',
        method: 'GET',
      })
    } catch (e) {
      console.warn('syncReportsFromCloud: network failed, keep local state:', e)
      lastSyncStatus.value = 'network'
      return false
    }

    if (res.statusCode !== 200 || res.data?.code !== 0) {
      console.warn('syncReportsFromCloud: server rejected:', res.statusCode, res.data)
      lastSyncStatus.value = 'server'
      return false
    }
    if (!Array.isArray(res.data.data)) {
      console.warn('syncReportsFromCloud: unexpected payload shape')
      lastSyncStatus.value = 'server'
      return false
    }

    const serverReports = res.data.data
    const localAll = [...reports.value, ...unarchivedReports.value]

    const byId = new Map()
    for (const r of serverReports) {
      byId.set(r._id ?? r.id, { ...r, _id: r._id ?? r.id, file_urls: _normalizeFileUrls(r), _pendingSync: false, _local: false })
    }

    // 本地内容不丢失：
    // - 与云端同 ID 且本地有未同步的用户修改（_pendingSync）：保留本地版本
    // - 其余（含读取边界标记的未确认旧副本）：服务端版本为准，
    //   成功下行同步即视为服务端确认，清除未确认标记
    // - 云端不存在：待同步、本地新建、以及旧版本遗留（无标志、来源无法确认）
    //   的记录一律保留，空云列表不删除无法确认已同步的旧记录
    for (const r of localAll) {
      if (byId.has(r._id)) {
        if (r._pendingSync) {
          byId.set(r._id, { ...r, _pendingSync: true })
        }
      } else {
        byId.set(r._id, r._local
          ? r
          : { ...r, _local: true, _originUnverified: true })
      }
    }

    const merged = [...byId.values()]
    reports.value = merged.filter(r => r.archive_status === 'archived')
    unarchivedReports.value = merged.filter(r => r.archive_status !== 'archived')
    const persisted = _persist()
    if (!persisted) {
      // 云端拉取与合并成功，但本机缓存写入失败：如实暴露，不当作完整成功
      lastSyncStatus.value = 'persist'
      return false
    }
    lastSyncStatus.value = 'ok'
    lastSyncAt.value = Date.now()
    return true
  }

// 读取边界标记：持久层中既无 _local 也无 _pendingSync 的记录来自旧版本，
// 来源未知——一律保守标记为未确认本地记录，写/删/AI 上传入口据此拦截；
// 成功的云端下行同步会用服务端版本（可信）替换这些标记
function _markUnverifiedOnRead(list) {
  return list.map(r => (r._local === undefined && r._pendingSync === undefined)
    ? { ...r, _local: true, _originUnverified: true }
    : r)
}

// 查询已归档报告（本地存储）
  async function fetchReports() {
    const data = _loadStorage()
    if (data && data.reports) {
      reports.value = _markUnverifiedOnRead(data.reports).map(r => ({
        ...r,
        file_urls: _normalizeFileUrls(r)
      }))
    }
  }

  // 查询未归档报告（本地存储）
  async function fetchUnarchivedReports() {
    const data = _loadStorage()
    if (data && data.unarchivedReports) {
      unarchivedReports.value = _markUnverifiedOnRead(data.unarchivedReports).map(r => ({
        ...r,
        file_urls: _normalizeFileUrls(r)
      }))
    }
  }

  // 创建报告记录。
  // 返回 { id, synced, pendingSync }；id 为 null 表示参数错误。
  async function createReport(data) {
    if (!data.report_type || !data.report_date) {
      uni.showToast({ title: '请选择报告类型和日期', icon: 'none' })
      return null
    }

    // If the caller already has a server-issued report_id (e.g. from direct upload flow), use it
    if (data._serverReportId && data._serverImageUrl) {
      const record = {
        _id: data._serverReportId,
        report_type: data.report_type,
        report_name: data.report_name || getTypeInfo(data.report_type).label,
        file_urls: [data._serverImageUrl],
        file_type: data.file_type || 'image',
        report_date: data.report_date,
        week_of_pregnancy: data.week_of_pregnancy || null,
        hospital: data.hospital || '',
        notes: data.notes || '',
        archive_status: data.archive_status || 'archived',
        ocr_status: 'pending',
        ocr_text: '',
        ai_status: 'pending',
        ai_result: {},
        abnormal_indicators: [],
        is_abnormal: false,
        create_time: Date.now(),
        ocr_confidence: null,
        ai_type_guess: data.ai_type_guess || '',
        ai_type_confidence: data.ai_type_confidence || null,
        _pendingSync: false,
        _local: false
      }

      // Write-through: update D1 with metadata.
      // 元数据登记失败时图片已在服务端：本地保留并标记待同步，不假装已同步，也不丢弃。
      let metadataSynced = true
      if (isRealAuthed()) {
        try {
          const res = await request({
            url: `/api/reports/${data._serverReportId}`,
            method: 'PUT',
            data: {
              report_type: data.report_type,
              report_name: record.report_name,
              report_date: data.report_date,
              week_of_pregnancy: data.week_of_pregnancy || null,
              hospital: data.hospital || '',
              notes: data.notes || '',
              archive_status: data.archive_status || 'archived',
            },
          })
          if (res.statusCode !== 200 || res.data?.code !== 0) {
            throw new Error(res.data?.msg || '创建报告失败')
          }
        } catch (e) {
          console.warn('createReport: metadata write-through failed, kept pending:', e)
          metadataSynced = false
          record._pendingSync = true
        }
      } else if (isGuestMode()) {
        // 演示模式不应携带占位 token 访问真实后端；本地保存
        metadataSynced = false
      }

      if (record.archive_status === 'archived') {
        reports.value.unshift(record)
      } else {
        unarchivedReports.value.unshift(record)
      }
      const persisted = _persist()
      if (!persisted) {
        // 本机写盘失败：回滚刚加入的内存记录，保证调用方重试不产生重复；
        // 输入草稿由页面保留
        reports.value = reports.value.filter(r => r._id !== record._id)
        unarchivedReports.value = unarchivedReports.value.filter(r => r._id !== record._id)
      }
      listNeedsRefresh.value = true
      // persisted=false：记录未落盘，调用方不得显示“已保存”
      return persisted
        ? { id: data._serverReportId, synced: metadataSynced, pendingSync: record._pendingSync, persisted: true, message: '' }
        : { id: data._serverReportId, synced: metadataSynced, pendingSync: record._pendingSync, persisted: false, message: '本机保存失败，记录未保存，请重试' }
    }

    // Fallback: local-only record (no image to upload) — 标记 _local，云同步时不会被空列表清除。
    // _draftId：落盘失败后的重试复用原 ID，以同一记录重试持久化，不生成第二个 ID
    const newId = (typeof data._draftId === 'string' && data._draftId) ? data._draftId : _generateId()
    const record = {
      _id: newId,
      report_type: data.report_type,
      report_name: data.report_name || getTypeInfo(data.report_type).label,
      file_urls: data.file_urls || [],
      file_type: data.file_type || 'image',
      report_date: data.report_date,
      week_of_pregnancy: data.week_of_pregnancy || null,
      hospital: data.hospital || '',
      notes: data.notes || '',
      archive_status: data.archive_status || 'archived',
      ocr_status: 'pending',
      ocr_text: '',
      ai_status: 'pending',
      ai_result: {},
      abnormal_indicators: [],
      is_abnormal: false,
      create_time: Date.now(),
      ocr_confidence: null,
      ai_type_guess: data.ai_type_guess || '',
      ai_type_confidence: data.ai_type_confidence || null,
      _pendingSync: false,
      _local: true
    }

    if (record.archive_status === 'archived') {
      reports.value.unshift(record)
    } else {
      unarchivedReports.value.unshift(record)
    }
    const persisted = _persist()
    if (!persisted) {
      // 本机写盘失败：回滚内存记录，重试不产生重复
      reports.value = reports.value.filter(r => r._id !== record._id)
      unarchivedReports.value = unarchivedReports.value.filter(r => r._id !== record._id)
    }
    listNeedsRefresh.value = true
    return persisted
      ? { id: newId, synced: false, pendingSync: false, local: true, persisted: true, message: '' }
      : { id: newId, synced: false, pendingSync: false, local: true, persisted: false, message: '本机保存失败，记录未保存，请重试' }
  }

  // 按归档状态把报告放到正确的数组
  function _rebucketReports() {
    const all = [...reports.value, ...unarchivedReports.value]
    reports.value = all.filter(r => r.archive_status === 'archived')
    unarchivedReports.value = all.filter(r => r.archive_status !== 'archived')
  }

  function _applyLocalUpdate(reportId, updates) {
    for (const list of [reports.value, unarchivedReports.value]) {
      const idx = list.findIndex(r => r._id === reportId)
      if (idx >= 0) {
        list[idx] = { ...list[idx], ...updates }
      }
    }
    _rebucketReports()
    return _persist()
  }

  // 更新报告信息 (write-through: API first, then local)。
  // 返回 { ok, synced, pendingSync, persisted, message }：
  // - 真实登录 + 云端确认 → synced: true
  // - 真实登录 + 云端网络失败 → 本地保留待同步，synced: false, pendingSync: true
  // - 演示/未登录 → 纯本地保存，synced: false
  // - persisted: false 表示本机持久化失败（内存已更新，重启会丢），调用方不得显示纯成功
  async function updateReport(reportId, data) {
    const allowedFields = ['report_type', 'report_name', 'report_date', 'week_of_pregnancy', 'hospital', 'notes', 'ai_type_guess', 'ai_type_confidence', 'archive_status']
    const updateData = {}
    for (const key of allowedFields) {
      if (data[key] !== undefined) updateData[key] = data[key]
    }

    const targetForOrigin = reports.value.find(r => r._id === reportId) ||
      unarchivedReports.value.find(r => r._id === reportId)

    // 来源未确认的旧报告不推送云端：避免把未确认数据上传/归属当前身份。
    // 本地编辑仍标记 _pendingSync（与信任状态独立）：真实用户输入必须在
    // 下行同步合并中保留，不能被服务端旧版本覆盖
    if (isRealAuthed() && targetForOrigin && targetForOrigin._originUnverified) {
      const persisted = _applyLocalUpdate(reportId, { ...updateData, _pendingSync: true })
      return persisted
        ? { ok: true, synced: false, pendingSync: true, persisted: true, message: '旧数据来源待确认，已仅保存到本机（我的页面可确认归属）' }
        : { ok: true, synced: false, pendingSync: true, persisted: false, message: '旧数据来源待确认且本机写入失败，内容仅在内存中，请重试' }
    }

    if (isRealAuthed()) {
      try {
        const res = await request({
          url: `/api/reports/${reportId}`,
          method: 'PUT',
          data: updateData,
        })
        if (res.statusCode !== 200 || res.data?.code !== 0) {
          throw new Error(res.data?.msg || '更新失败')
        }
        const persisted = _applyLocalUpdate(reportId, { ...updateData, _pendingSync: false })
        return persisted
          ? { ok: true, synced: true, pendingSync: false, persisted: true, message: '' }
          : { ok: true, synced: true, pendingSync: false, persisted: false, message: '云端已保存，但本机缓存写入失败，重启后可能丢失' }
      } catch (e) {
        if (e && e.networkError) {
          console.warn('updateReport: offline, kept local pending:', e)
          const persisted = _applyLocalUpdate(reportId, { ...updateData, _pendingSync: true })
          return persisted
            ? { ok: true, synced: false, pendingSync: true, persisted: true, message: '网络不可用，已保存到本机，联网后同步' }
            : { ok: true, synced: false, pendingSync: true, persisted: false, message: '网络不可用，且本机写入失败，内容仅在内存中，请勿关闭应用' }
        }
        // 服务端明确拒绝：不落本地假状态，把失败交回页面
        console.error('updateReport: cloud write-through failed:', e)
        return { ok: false, synced: false, pendingSync: false, persisted: false, message: e.message || '更新失败' }
      }
    }

    // 演示模式 / 未登录：本地保存，不发起云端请求
    const target = reports.value.find(r => r._id === reportId) ||
      unarchivedReports.value.find(r => r._id === reportId)
    const persisted = _applyLocalUpdate(reportId, { ...updateData, _pendingSync: target?._pendingSync || false })
    return persisted
      ? { ok: true, synced: false, pendingSync: target?._pendingSync || false, persisted: true, message: '' }
      : { ok: true, synced: false, pendingSync: target?._pendingSync || false, persisted: false, message: '本机写入失败，内容仅在内存中，请重试' }
  }

  // 删除报告 (write-through: API first, then local)。
  // 云端未确认删除前不本地移除：既不假装删除成功，也避免下次同步复活造成误导。
  async function deleteReport(reportId) {
    const target = reports.value.find(r => r._id === reportId) ||
      unarchivedReports.value.find(r => r._id === reportId)

    // 演示/未登录 或 本地新建（从未上传）的报告：直接本地删除即可
    if (!isRealAuthed() || (target && target._local)) {
      reports.value = reports.value.filter(r => r._id !== reportId)
      unarchivedReports.value = unarchivedReports.value.filter(r => r._id !== reportId)
      const persisted = _persist()
      return persisted
        ? { ok: true, synced: !isRealAuthed() ? false : true, persisted: true }
        : { ok: true, persisted: false, message: '本机写入失败，删除仅在内存生效，重启后会恢复，请重试' }
    }

    try {
      const res = await request({
        url: `/api/reports/${reportId}`,
        method: 'DELETE',
      })
      if (res.statusCode !== 200 || res.data?.code !== 0) {
        throw new Error(res.data?.msg || '删除失败')
      }
    } catch (e) {
      console.error('deleteReport: cloud delete failed:', e)
      return { ok: false, synced: false, persisted: false, message: (e && e.networkError) ? '网络不可用，暂时无法删除，报告已保留' : (e.message || '删除失败') }
    }

    reports.value = reports.value.filter(r => r._id !== reportId)
    unarchivedReports.value = unarchivedReports.value.filter(r => r._id !== reportId)
    const persisted = _persist()
    return persisted
      ? { ok: true, synced: true, persisted: true }
      : { ok: true, synced: true, persisted: false, message: '云端已删除，但本机缓存写入失败，重启后可能重新出现' }
  }

  // 将未归档报告标记为已归档 (write-through)
  async function archiveReport(reportId) {
    return updateReport(reportId, { archive_status: 'archived' })
  }

  // 批量归档 (write-through)；返回 { archived, failed, pending }
  async function batchArchive(reportIds) {
    let archived = 0
    let pending = false
    const failed = []
    for (const id of reportIds) {
      const result = await updateReport(id, { archive_status: 'archived' })
      if (result.ok && result.persisted) {
        archived++
        if (result.pendingSync) pending = true
      } else {
        failed.push({ id, error: result.message || '归档失败' })
      }
    }
    if (failed.length > 0) {
      return { archived, failed, pending, message: `部分归档失败：${failed.length} 份` }
    }
    return { archived, failed: [], pending }
  }

  // 触发 AI 解读流水线 — Phase F：全面转接 CloudBase 原生网关 mc-tools 的 ai.analyzeReport
  // （经 toolsStore.analyzeReportWithAi → sessionService.familyCall('mc-tools')），
  // 拔除旧 Cloudflare HTTP /api/analyze-report；未配置 Key 时优雅返回提示，不抛错不假死。
  async function triggerAiPipeline(reportId) {
    const report = _findReport(reportId)
    if (!report) {
      uni.showToast({ title: '报告不存在', icon: 'none' })
      return false
    }

    if (isGuestMode()) {
      // 演示模式没有真实 AI 后端：明确不可用，不发起请求、不扣次数、不显示完成
      uni.showToast({ title: '演示模式暂不支持 AI 解读', icon: 'none', duration: 2500 })
      return false
    }

    if (report._originUnverified) {
      // 来源未确认的旧报告：不在当前身份下发起 AI 处理（属于迁出通路）
      uni.showToast({ title: '旧报告来源待确认，确认后再使用 AI 解读', icon: 'none', duration: 2500 })
      return false
    }

    const health = getHealthStore()
    if (!canUseAi(health)) {
      uni.showToast({ title: '今日 50 次 AI 解读已用完，明天再来吧', icon: 'none', duration: 3000 })
      return false
    }

    const previousAiStatus = report.ai_status || 'pending'
    const previousOcrStatus = report.ocr_status || 'pending'
    // family 模式：权威持久化在云端（mc-tools CAS 写 ai_result/ocr_result/vision_result），
    // 本管线全程不读写旧本地库（B3 隔离恒拒写——读写都会产生误导态或"本机保存失败"误报）。
    // demo/legacy：本地库标记/持久化照旧，失败如实提示。
    const familyMode = isFamilyMode()
    const localMark = familyMode ? () => {} : updates => _updateReportField(reportId, updates)
    localMark({ ai_status: 'processing', ocr_status: 'processing' })

    try {
      uni.showLoading({ title: 'AI 正在分析…', mask: true })

      const toolsStore = useToolsStore()
      const res = await toolsStore.analyzeReportWithAi({ reportId })

      uni.hideLoading()

      if (!res.ok) {
        // 云端调用失败（网络/鉴权/报告不存在等）：如实失败，不消耗次数
        localMark({ ai_status: previousAiStatus, ocr_status: previousOcrStatus })
        uni.showToast({ title: res.message || 'AI 解读失败，请稍后重试', icon: 'none', duration: 2500 })
        return false
      }

      const data = res.data

      if (data.enabled === false) {
        // 未配置 DeepSeek/OCR 服务：优雅提示（规格原文），不抛错、不改失败态、不扣次数
        localMark({ ai_status: previousAiStatus, ocr_status: previousOcrStatus })
        uni.showToast({
          title: '报告自动 OCR / DeepSeek 解读服务未配置；请以原始检验单与主治医生诊断为准',
          icon: 'none',
          duration: 3500
        })
        return false
      }

      // 启用：把网关返回的解读文本包装成本地既有的 ai_result 结构
      const aiData = {
        overall_summary: String(data.answer || ''),
        suggestions: ['以上内容为 AI 生成的一般性说明，不构成医疗诊断；请以原始检验单与主治医生诊断为准'],
        disclaimer: data.disclaimer || ''
      }

      // 结构校验：空结果不能标记完成，也不能当作成功扣次数
      if (!isValidAiResult(aiData)) {
        console.warn('triggerAiPipeline: invalid AI payload, treated as failure:', aiData)
        localMark({ ai_status: previousAiStatus, ocr_status: previousOcrStatus })
        uni.showToast({ title: 'AI 未返回有效解读内容，未消耗次数，请稍后重试', icon: 'none', duration: 3000 })
        return false
      }

      let persisted = true
      if (!familyMode) {
        persisted = _updateReportField(reportId, {
          ai_status: 'done',
          ocr_status: 'done',
          ai_result: aiData,
          // Phase G：存服务端 OCR 提取原文（未含 OCR 时为空串）——修复旧占位把 AI 回答误存为 ocr_text
          ocr_text: typeof data.ocrText === 'string' ? data.ocrText : ''
        })
      }
      await health.consumeAiInterpretQuota()

      uni.showToast({
        title: persisted ? '解读完成' : '解读完成，但本机保存失败，重启后可能丢失',
        icon: persisted ? 'success' : 'none',
        duration: persisted ? 1500 : 3000
      })
      return true
    } catch (err) {
      console.error('AI pipeline failed:', err)
      uni.hideLoading()
      localMark({ ai_status: previousAiStatus, ocr_status: previousOcrStatus })
      uni.showToast({ title: err?.message || 'AI 解读失败', icon: 'none', duration: 2500 })
      return false
    }
  }

  function canUseAi(health) {
    return typeof health.canUseAiInterpret === 'function' ? health.canUseAiInterpret() : true
  }

  // 上传图片到服务端并创建报告记录（解耦后的新入口）。
  // 返回 { id, synced, pendingSync }；null 表示失败（页面保留输入让用户重试）。
  async function uploadAndCreateReport(data) {
    if (!data.report_type || !data.report_date) {
      uni.showToast({ title: '请选择报告类型和日期', icon: 'none' })
      return null
    }

    // 集中边界门（R2）：旧二进制上传与 request() 同属旧 Cloudflare 正式路径，
    // 未开启旧 HTTP 时 fail closed——不得绕过 utils/api 的集中关闭直连旧外部域名
    if (!legacyHttpEnabled()) {
      uni.showToast({ title: legacyDisabledMessage(), icon: 'none', duration: 2500 })
      return null
    }

    if (isGuestMode()) {
      uni.showToast({ title: '演示模式不支持上传报告', icon: 'none', duration: 2500 })
      return null
    }

    const localPath = (data.localPaths && data.localPaths[0]) || (data.file_urls && data.file_urls[0])
    if (!localPath) {
      uni.showToast({ title: '请选择报告图片', icon: 'none' })
      return null
    }

    try {
      uni.showLoading({ title: '上传中…' })

      // Compress image before upload
      let uploadPath = localPath
      try {
        const compressRes = await new Promise((resolve, reject) => {
          uni.compressImage({
            src: localPath,
            quality: 20,
            success: resolve,
            fail: reject,
          })
        })
        uploadPath = compressRes.tempFilePath
      } catch {
        // compression failed, use original
      }

      const token = getToken()
      const uploadRes = await new Promise((resolve, reject) => {
        uni.uploadFile({
          url: API_BASE + '/api/reports/upload',
          filePath: uploadPath,
          name: 'file',
          header: {
            Authorization: token ? `Bearer ${token}` : '',
          },
          formData: {
            report_type: data.report_type,
            report_name: data.report_name || getTypeInfo(data.report_type).label,
            report_date: data.report_date,
            week_of_pregnancy: data.week_of_pregnancy || '',
            hospital: data.hospital || '',
            notes: data.notes || '',
            archive_status: data.archive_status || 'archived',
          },
          success: (res) => resolve(res),
          fail: (err) => reject(err),
        })
      })
      uni.hideLoading()

      // uni.uploadFile returns res.data as a JSON string, not an object
      let parsed
      try {
        parsed = typeof uploadRes.data === 'string' ? JSON.parse(uploadRes.data) : uploadRes.data
      } catch (e) {
        throw new Error('上传响应格式异常')
      }

      if (uploadRes.statusCode !== 200 || parsed.code !== 0) {
        throw new Error(parsed?.msg || '上传失败')
      }

      const { report_id, image_url } = parsed.data

      const result = await createReport({
        ...data,
        _serverReportId: report_id,
        _serverImageUrl: image_url,
      })

      return result
    } catch (err) {
      uni.hideLoading()
      console.error('uploadAndCreateReport failed:', err)
      const msg = err && err.errMsg && /fail/i.test(err.errMsg)
        ? '网络不可用，上传失败，请检查网络后重试'
        : (err.message || '上传失败，请重试')
      uni.showToast({ title: msg, icon: 'none', duration: 2500 })
      return null
    }
  }

  // 设置筛选条件
  function setFilter(filter) {
    currentFilter.value = { ...currentFilter.value, ...filter }
  }

  // 重置筛选条件
  function resetFilter() {
    currentFilter.value = {
      tab: currentFilter.value.tab,
      keyword: '',
      weekRange: null,
      timeRange: null
    }
  }

  function _findReport(id) {
    return reports.value.find(r => r._id === id) ||
           unarchivedReports.value.find(r => r._id === id)
  }

  function _updateReportField(id, updates) {
    const idx1 = reports.value.findIndex(r => r._id === id)
    if (idx1 >= 0) {
      reports.value[idx1] = { ...reports.value[idx1], ...updates }
    }
    const idx2 = unarchivedReports.value.findIndex(r => r._id === id)
    if (idx2 >= 0) {
      unarchivedReports.value[idx2] = { ...unarchivedReports.value[idx2], ...updates }
    }
    return _persist()
  }

  // 清除本机数据时由 health store 调用：仅重置内存态（存储键由调用方处理）
  function resetLocalState() {
    reports.value = []
    unarchivedReports.value = []
    listNeedsRefresh.value = true
  }

  return {
    // state
    reports,
    unarchivedReports,
    currentFilter,
    aiStatusMap,
    pendingUpload,
    batchItemUpdate,
    listNeedsRefresh,
    lastSyncStatus,
    lastSyncAt,
    lastPersistError,
    // getters
    filteredReports,
    groupedReports,
    tabCounts,
    hasActiveFilter,
    activeFilterCount,
    hasPendingSync,
    // actions
    fetchReports,
    fetchUnarchivedReports,
    syncReportsFromCloud,
    createReport,
    updateReport,
    deleteReport,
    archiveReport,
    batchArchive,
    triggerAiPipeline,
    uploadAndCreateReport,
    resetLocalState,
    setFilter,
    resetFilter
  }
})
