<template>
  <view class="page">
		<view v-if="aiDisabled" class="ai-disabled-banner">
			<text class="ai-disabled-title">AI 解读未启用</text>
			<text class="ai-disabled-desc">未配置 OCR/DeepSeek 服务；本页不提供自动解读，请以原始报告和医生意见为准。</text>
		</view>
    <!-- Gradient Header Zone -->
    <view v-if="!aiDisabled" class="ai-header-zone">
      <NavBar title="AI 解读报告" theme="dark" transparent />

      <view class="ai-header-card">
        <view class="ai-header-meta">
          <text class="ai-header-type">{{ typeLabel }} · {{ weekText }}</text>
          <text class="ai-header-date">{{ report.report_date || '' }}</text>
        </view>
        <view class="ai-conclusion">
          <text class="ai-conclusion-icon">{{ conclusionIcon }}</text>
          <text class="ai-conclusion-text">{{ overallSummary }}</text>
        </view>
      </view>
    </view>

    <!-- Scrollable Content（AI 未启用时不渲染任何解读结果） -->
    <scroll-view v-if="!aiDisabled" scroll-y class="scroll">
      <!-- Indicators Section -->
      <view class="ai-section-title-wrap">
        <text class="ai-section-title">逐项解读</text>
      </view>
      <view class="indicator-list">
        <view
          v-for="(ind, idx) in indicators"
          :key="idx"
          class="indicator-row"
          :class="ind.rowClass"
        >
          <view class="indicator-status" :class="ind.status"></view>
          <view class="indicator-body">
            <view class="indicator-name-row">
              <text class="indicator-name">{{ ind.name }}</text>
              <text class="indicator-value" :class="ind.status">{{ ind.value }}</text>
            </view>
            <text class="indicator-ref">{{ ind.ref }}</text>
            <text class="indicator-explain">{{ ind.explain }}</text>
          </view>
        </view>
      </view>

      <!-- Suggestions Section -->
      <view v-if="suggestions.length > 0" class="ai-section-title-wrap">
        <text class="ai-section-title">行动建议</text>
      </view>
      <view class="suggestion-list">
        <view
          v-for="(sug, idx) in suggestions"
          :key="idx"
          class="suggestion-card"
        >
          <text class="suggestion-icon">{{ sug.icon }}</text>
          <text class="suggestion-text">{{ sug.text }}</text>
        </view>
      </view>

      <!-- Disclaimer -->
      <view class="disclaimer">
        <text class="disclaimer-text">✦ 以上解读由 AI 生成，仅供参考，不构成医疗诊断建议。如有疑问，请及时就诊咨询您的产科医生。</text>
      </view>

      <!-- Feedback Row -->
      <view class="ai-feedback-row">
        <view class="feedback-btn" :class="{ 'feedback-done': feedbackGiven === 'helpful' }" @tap="onFeedback('helpful')">
          <text class="feedback-btn-text">👍 有帮助</text>
        </view>
        <view class="feedback-btn" :class="{ 'feedback-done': feedbackGiven === 'issue' }" @tap="onFeedback('issue')">
          <text class="feedback-btn-text">✏️ 有问题</text>
        </view>
      </view>
    </scroll-view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import NavBar from '@/components/NavBar.vue'
import { useReportStore, getTypeInfo } from '@/stores/report'
import { getSessionState, isExplicitDemo, isExplicitLoggedOut } from '@/services/sessionService.js'

const reportStore = useReportStore()
// B2b2：AI 在配置/真实验证前明确未启用——正式态不显示任何"解读完成/全部正常"式内容
const isFamilyMode = () => getSessionState().status === 'confirmed' && !isExplicitDemo() && !isExplicitLoggedOut()
const aiDisabled = ref(false)
import { watch } from 'vue'
import { subscribeSession } from '@/services/sessionService.js'
watch(subscribeSession(), () => {
  // 演示/未确认与正式之间切换：立即按当前身份重估（正式恒为未启用态）
  aiDisabled.value = !isExplicitDemo() || !(getSessionState().status === 'confirmed')
})

const report = ref({})
const feedbackGiven = ref('')

const typeLabel = computed(() => {
  const info = getTypeInfo(report.value.report_type)
  return info ? info.label : '报告'
})

const weekText = computed(() => {
  const w = report.value.week_of_pregnancy
  return w ? `孕 ${w} 周` : ''
})

// Try to recover the real AI result from raw_text when parseAiJson fell back
const aiResult = computed(() => {
  const raw = report.value.ai_result || {}
  if (raw.report_type !== '解析失败' || !raw.raw_text) return raw

  // raw_text contains the actual LLM output that failed server-side parsing
  try {
    let text = raw.raw_text.trim()
    // Strip markdown fences
    text = text.replace(/^```(?:json|html|text|javascript|js)?\s*\n?/i, '')
    text = text.replace(/\n?```\s*$/i, '')
    text = text.trim()
    // Balance unclosed brackets
    const start = text.indexOf('{')
    if (start !== -1) text = text.slice(start)
    let depthCurly = 0, depthSquare = 0, inStr = false, esc = false
    for (const ch of text) {
      if (esc) { esc = false; continue }
      if (ch === '\\') { esc = true; continue }
      if (ch === '"') { inStr = !inStr; continue }
      if (inStr) continue
      if (ch === '{') depthCurly++
      else if (ch === '}') depthCurly--
      else if (ch === '[') depthSquare++
      else if (ch === ']') depthSquare--
    }
    while (depthSquare > 0) { text += ']'; depthSquare-- }
    while (depthCurly > 0) { text += '}'; depthCurly-- }

    const recovered = JSON.parse(text)
    if (recovered.report_type && recovered.overall_summary) return recovered
  } catch (e) {
    console.error('[ai-result] raw_text recovery failed:', e.message)
  }
  return raw
})

const overallSummary = computed(() => {
  return aiResult.value.overall_summary || '暂无解读结果'
})

const conclusionIcon = computed(() => {
  const abnormal = aiResult.value.abnormal_indicators || []
  if (abnormal.length === 0) return '✅'
  const hasDanger = abnormal.some(i => i.severity === 'danger')
  if (hasDanger) return '⚠️'
  return '⚡'
})

const indicators = computed(() => {
  const items = aiResult.value.abnormal_indicators || []
  if (items.length === 0) return []

  return items.map(ind => ({
    name: ind.name || '',
    value: ind.value || '',
    status: mapSeverity(ind.severity),
    ref: `参考范围：${ind.reference_range || '未知'}`,
    explain: ind.explanation || '',
    rowClass: ind.severity === 'danger' ? 'indicator-row-abnormal' :
              ind.severity === 'warning' ? 'indicator-row-watch' : ''
  }))
})

const suggestions = computed(() => {
  const actionSuggestions = aiResult.value.action_suggestions || []
  const icons = ['🥩', '📋', '🚫', '💊', '🏃']
  return actionSuggestions.map((text, idx) => ({
    icon: icons[idx % icons.length],
    text
  }))
})

function mapSeverity(severity) {
  switch (severity) {
    case 'danger': return 'abnormal'
    case 'warning': return 'watch'
    default: return 'normal'
  }
}

onLoad(async (options) => {
  aiDisabled.value = !isExplicitDemo()
  if (aiDisabled.value) return // 正式态：不读取旧档案、不呈现解读结果/伪成功
  if (isExplicitDemo()) {
    uni.showToast && uni.showToast({ title: '演示模式：以下为示例内容，非真实解读', icon: 'none', duration: 2500 })
  }
  aiDisabled.value = !isExplicitDemo()
  if (options.id) {
    const found = reportStore.reports.find(r => r._id === options.id) ||
                  reportStore.unarchivedReports.find(r => r._id === options.id)
    if (found) {
      report.value = found
    }
  }
})

function onFeedback(type) {
  if (feedbackGiven.value) return
  feedbackGiven.value = type
  uni.showToast({
    title: type === 'helpful' ? '感谢反馈！' : '感谢您的反馈',
    icon: 'none'
  })
}
</script>

<style scoped lang="scss">
page {
  --rose: #E8637A;
  --rose-light: #FDEEF1;
  --rose-dark: #C0405A;
  --amber: #F0A940;
  --amber-light: #FEF4E3;
  --green: #5BBF7C;
  --green-light: #EAF7EF;
  --gray-50: #FAF9F8;
  --gray-100: #F2F0EE;
  --gray-200: #E4E1DC;
  --gray-300: #C8C4BC;
  --gray-400: #9C9890;
  --gray-500: #6E6A64;
  --gray-700: #3A3834;
  --gray-900: #1C1A17;
  --radius-sm: 10px;
  --radius-pill: 999px;
  --shadow: 0 2px 16px rgba(0, 0, 0, 0.07);
}

.page {
  display: flex; flex-direction: column; height: 100vh;
  background-color: #FAF9F8;
  font-family: 'DM Sans', 'Noto Sans SC', sans-serif;
  position: relative;
}

/* ── AI Header Zone (unified gradient) ── */
.ai-header-zone {
  background: linear-gradient(135deg, #E8637A 0%, #C84070 100%);
  flex-shrink: 0;
}

/* ── AI Header Card ── */
.ai-header-card {
  padding: 8rpx 32rpx 44rpx;
}
.ai-header-meta { display: flex; align-items: center; gap: 16rpx; margin-bottom: 8rpx; }
.ai-header-type { font-size: 26rpx; font-weight: 600; color: rgba(255, 255, 255, 0.7); }
.ai-header-date {
  font-size: 22rpx; background: rgba(255, 255, 255, 0.2);
  color: white; padding: 4rpx 16rpx; border-radius: 999px;
}
.ai-conclusion {
  background: rgba(255, 255, 255, 0.15); border-radius: 20rpx;
  padding: 24rpx 28rpx; margin-top: 24rpx;
  display: flex; gap: 20rpx; align-items: flex-start;
}
.ai-conclusion-icon { font-size: 40rpx; flex-shrink: 0; }
.ai-conclusion-text { font-size: 28rpx; color: rgba(255, 255, 255, 0.95); line-height: 1.6; }

/* ── Scroll ── */
.scroll { flex: 1; padding-bottom: 24rpx; }

/* ── Section Title ── */
.ai-section-title-wrap { padding: 0 32rpx; margin-top: 36rpx; }
.ai-section-title {
  font-size: 24rpx; font-weight: 600; color: #9C9890;
  text-transform: uppercase; letter-spacing: 0.06em;
}

/* ── Indicators ── */
.indicator-list { padding: 20rpx 32rpx 0; display: flex; flex-direction: column; gap: 16rpx; }
.indicator-row {
  background: white; border-radius: 20rpx; padding: 24rpx 28rpx;
  display: flex; gap: 24rpx; align-items: flex-start;
  box-shadow: 0 4rpx 32rpx rgba(0, 0, 0, 0.07);
}
.indicator-row-abnormal { background: #FFF8F9; border-left: 6rpx solid #E8637A; }
.indicator-row-watch { background: #FFFDF7; border-left: 6rpx solid #F0A940; }

.indicator-status {
  width: 16rpx; height: 16rpx; border-radius: 50%;
  flex-shrink: 0; margin-top: 10rpx;
}
.indicator-status.normal { background: #5BBF7C; }
.indicator-status.abnormal { background: #E8637A; }
.indicator-status.watch { background: #F0A940; }

.indicator-body { flex: 1; }
.indicator-name-row { display: flex; align-items: baseline; gap: 12rpx; margin-bottom: 6rpx; }
.indicator-name { font-size: 26rpx; font-weight: 600; color: #2A2826; }
.indicator-value { font-size: 26rpx; font-weight: 600; }
.indicator-value.normal { color: #5BBF7C; }
.indicator-value.abnormal { color: #E8637A; }
.indicator-value.watch { color: #F0A940; }
.indicator-ref { font-size: 22rpx; color: #9C9890; margin-bottom: 8rpx; display: block; }
.indicator-explain { font-size: 24rpx; color: #6E6A64; line-height: 1.6; }

/* ── Suggestions ── */
.suggestion-list { padding: 20rpx 32rpx 0; display: flex; flex-direction: column; gap: 16rpx; }
.suggestion-card {
  background: #EAF7EF; border-radius: 20rpx; padding: 24rpx 28rpx;
  display: flex; gap: 20rpx;
}
.suggestion-icon { font-size: 32rpx; flex-shrink: 0; }
.suggestion-text { font-size: 26rpx; color: #2A6040; line-height: 1.6; }

/* ── Disclaimer ── */
.disclaimer { margin: 24rpx 32rpx; background: #F2F0EE; border-radius: 20rpx; padding: 20rpx 28rpx; }
.disclaimer-text { font-size: 22rpx; color: #9C9890; line-height: 1.6; }

/* ── Feedback Row ── */
.ai-feedback-row {
  display: flex; gap: 16rpx; padding: 0 32rpx 32rpx;
  padding-bottom: calc(32rpx + env(safe-area-inset-bottom));
}
.feedback-btn {
  flex: 1; height: 76rpx; background: white;
  border: 2rpx solid #E4E1DC; border-radius: 999px;
  display: flex; align-items: center; justify-content: center;
}
.feedback-btn-text { font-size: 26rpx; font-weight: 500; color: #6E6A64; }
.feedback-done {
  background: #EAF7EF; border-color: #5BBF7C;
}

.ai-disabled-banner { margin: 24rpx; padding: 28rpx; background: #FEF4E3; border: 2rpx solid rgba(240,169,64,.4); border-radius: 20rpx; }
.ai-disabled-title { display: block; font-size: 28rpx; font-weight: 600; color: #B07818; margin-bottom: 8rpx; }
.ai-disabled-desc { display: block; font-size: 24rpx; color: #8C5A10; line-height: 1.6; }
</style>
