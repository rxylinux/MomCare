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
import { calcWeekInfo, getTrimesterName } from '@/stores/health.js'
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

// Mock data for week 32 (5 days: -2, -1, 0, +1, +2)
const MOCK_DATA = [
  {
    baby: { icon: '👶', text: '手指甲已完全形成，会自己抓握' },
    mom: { icon: '💆', text: '腰背酸痛加重，建议用孕妇枕' },
    tip: { icon: '💡', text: '保持左侧卧，有助于改善胎儿血液供应，减轻腰背不适' }
  },
  {
    baby: { icon: '🫁', text: '肺部继续发育，已能进行呼吸练习' },
    mom: { icon: '🦵', text: '腿部抽筋常见，睡前补充钙和镁' },
    tip: { icon: '💡', text: '脚踝水肿若明显加重，应及时告知产科医生' }
  },
  {
    baby: { icon: '👶', text: '约 1.8kg，头部开始朝下入盆' },
    mom: { icon: '💆', text: '子宫扩大，气短与胃部不适明显' },
    tip: { icon: '💡', text: '少量多餐，每天记录胎动，12小时少于10次请就医' }
  },
  {
    baby: { icon: '🧠', text: '皮下脂肪积累，皮肤越来越圆润' },
    mom: { icon: '🤱', text: '乳房准备哺乳，初乳开始分泌' },
    tip: { icon: '💡', text: '开始准备待产包清单，还有约55天哦，提前列好清单' }
  },
  {
    baby: { icon: '✨', text: '大脑褶皱加深，神经系统快速完善' },
    mom: { icon: '💤', text: '胎动越来越明显，感受宝宝翻滚' },
    tip: { icon: '💡', text: '每天数胎动3次，每次1小时，形成规律记录习惯' }
  }
]

// ── 孕期每日变化数据库（按孕周组织） ──
const WEEKLY_CHANGES = {
  4: {
    baby: { icon: '🫘', text: '胚胎刚着床，约罂粟籽大小，细胞快速分裂' },
    mom: { icon: '🌡', text: '可能出现轻微腹痛，类似经前感' },
    tips: ['开始补充叶酸，每天0.4mg', '避免剧烈运动和高温环境', '远离烟酒和有害化学物质', '确认怀孕后尽早建档', '记录末次月经日期，计算预产期']
  },
  5: {
    baby: { icon: '🍎', text: '约苹果籽大小，心脏开始形成并跳动' },
    mom: { icon: '💊', text: '早孕反应可能出现，恶心嗜睡' },
    tips: ['少食多餐缓解孕吐', '保持充足睡眠', '选择清淡易消化食物', '准备早孕试纸确认怀孕', '开始记录孕期日记']
  },
  6: {
    baby: { icon: '🫐', text: '约蓝莓大小，面部五官开始成形' },
    mom: { icon: '😴', text: '嗜睡乏力明显，乳房胀痛' },
    tips: ['孕吐严重可尝试生姜水', '穿舒适的内衣减轻胀痛', '避免长时间站立', '多喝水保持水分', '情绪波动是正常的，适当休息']
  },
  7: {
    baby: { icon: '🫐', text: '约蓝莓大小，手指脚趾开始分化' },
    mom: { icon: '🤢', text: '孕吐高峰期，嗅觉变得敏感' },
    tips: ['柠檬水有助缓解恶心', '远离刺激性气味', '维B6可能缓解孕吐', '饭后不要立即躺下', '如果孕吐严重无法进食请就医']
  },
  8: {
    baby: { icon: '🍇', text: '约葡萄大小，四肢可活动，尾巴消失' },
    mom: { icon: '🩲', text: '腰围开始变粗，子宫如拳头大' },
    tips: ['选择宽松舒适的孕妇装', '第一次B超检查可以安排', '继续补充叶酸', '记录体重变化', '适当散步有助缓解不适']
  },
  9: {
    baby: { icon: '🍒', text: '约樱桃大小，所有器官已初步形成' },
    mom: { icon: '😤', text: '情绪波动大，容易烦躁或哭泣' },
    tips: ['与伴侣分享你的感受', '听舒缓音乐放松心情', '适当运动改善情绪', '孕期瑜伽是不错的选择', '加入孕妈交流群获取支持']
  },
  10: {
    baby: { icon: '🍓', text: '约草莓大小，手指脚趾完全分开' },
    mom: { icon: '💫', text: '孕吐开始减轻，食欲逐渐恢复' },
    tips: ['营养均衡，增加蛋白质摄入', '可以选择合适的孕妇奶粉', '开始做孕妇操', '注意口腔卫生', '预约11-13周NT检查']
  },
  11: {
    baby: { icon: '🍋', text: '约柠檬大小，生殖器开始发育' },
    mom: { icon: '😊', text: '早孕反应消退，进入舒适期' },
    tips: ['趁精力好，规划产检时间表', '学习孕期营养知识', '选购孕妇装', '可以开始轻柔的产前运动', '告诉家人和朋友好消息']
  },
  12: {
    baby: { icon: '🍋', text: '约柠檬大小，骨骼硬化，能做表情' },
    mom: { icon: '💪', text: '流产风险降低，身体更稳定' },
    tips: ['NT检查最佳时间（11-13周+6）', '开始建档和全面产检', '血压和体重基线检测', '告知单位怀孕消息', '拍摄孕照留念']
  },
  13: {
    baby: { icon: '🍑', text: '约桃子大小，指纹已形成' },
    mom: { icon: '🌟', text: '孕中期开始，精力恢复，食欲好' },
    tips: ['进入孕中期，注意营养均衡', '体重增长每周约0.5kg为正常', '适当增加运动量', '开始涂抹妊娠纹预防霜', '学习数胎动的方法']
  },
  14: {
    baby: { icon: '🍋', text: '约柠檬大小，长出细软胎毛' },
    mom: { icon: '🎀', text: '腹部微微隆起，可能长妊娠线' },
    tips: ['左侧卧位有助于血液循环', '开始进行凯格尔运动', '注意补钙，每天800mg', '保持规律作息', '可以选择孕妇游泳']
  },
  16: {
    baby: { icon: '🥑', text: '约牛油果大小，可能在吸吮手指' },
    mom: { icon: '🎈', text: '肚子明显隆起，开始显怀' },
    tips: ['唐筛/无创DNA最佳时间', '开始感受胎动（初产妇可能还早）', '选择舒适的平底鞋', '注意补铁预防贫血', '可以开始胎教音乐']
  },
  18: {
    baby: { icon: '🫑', text: '约甜椒大小，能听到声音了' },
    mom: { icon: '🦶', text: '胎动明显，初产妇感受到第一次' },
    tips: ['记录第一次胎动的时间', '和宝宝说话、听音乐', '增加DHA摄入促进宝宝大脑', '侧卧时用枕头支撑腹部', '预约20-24周大排畸B超']
  },
  20: {
    baby: { icon: '🍌', text: '约香蕉大小，全身覆盖胎脂' },
    mom: { icon: '📐', text: '宫底到肚脐，肚子越来越大' },
    tips: ['大排畸B超（20-24周）', '每天规律数胎动', '注意是否有宫缩', '准备孕妇托腹带', '学习拉玛泽呼吸法']
  },
  22: {
    baby: { icon: '🥭', text: '约芒果大小，眉毛眼睑成型' },
    mom: { icon: '🦵', text: '腿部可能开始抽筋' },
    tips: ['睡前拉伸小腿预防抽筋', '补充钙和镁', '监测血压', '保持适度运动', '开始准备宝宝用品清单']
  },
  24: {
    baby: { icon: '🌽', text: '约玉米大小，肺部快速发育' },
    mom: { icon: '🔍', text: '肚子更圆更大，重心前移' },
    tips: ['糖耐量试验(OGTT)最佳时间', '注意妊娠糖尿病风险', '控制甜食和水果摄入', '产检频率变为每两周一次', '开始考虑待产包清单']
  },
  26: {
    baby: { icon: '🥬', text: '约生菜大小，眼睛能睁开了' },
    mom: { icon: '💤', text: '睡眠质量下降，翻身困难' },
    tips: ['使用孕妇枕改善睡眠', '避免仰卧位', '注意胎位是否正常', '监测体重增长速度', '了解早产征兆']
  },
  28: {
    baby: { icon: '🍆', text: '约茄子大小，约1kg，能做梦了' },
    mom: { icon: '📊', text: '进入孕晚期，产检更频繁' },
    tips: ['开始数胎动，每天3次每次1小时', '产检改为每两周一次', '注意是否有水肿', '了解胎位不正的纠正方法', '开始准备待产包']
  },
  29: {
    baby: { icon: '🥥', text: '约椰子大小，骨骼在快速钙化' },
    mom: { icon: '📋', text: '假性宫缩可能出现' },
    tips: ['区分真假宫缩', '了解早产征兆', '继续数胎动', '注意休息避免劳累', '确认待产医院路线']
  },
  30: {
    baby: { icon: '🥥', text: '约椰子大小，约1.3kg，大脑快速发育' },
    mom: { icon: '💓', text: '心输出量达到峰值，容易气短' },
    tips: ['补充DHA和铁', '避免长时间站立', '了解分娩征兆', '和医生讨论分娩计划', '练习拉玛泽呼吸']
  },
  31: {
    baby: { icon: '🥥', text: '约椰子大小，五官精致，能转头' },
    mom: { icon: '🫁', text: '气短尿频加重' },
    tips: ['少量多餐减轻胃部不适', '保持大便通畅', '学习分娩呼吸法', '了解无痛分娩选项', '准备哺乳用品']
  },
  32: {
    baby: { icon: '👶', text: '约1.8kg，头部开始朝下入盆' },
    mom: { icon: '💆', text: '子宫扩大，气短与胃部不适明显' },
    tips: ['少量多餐，每天记录胎动', '12小时胎动少于10次请就医', '准备待产包', '了解剖腹产指征', '确认陪产人员']
  },
  33: {
    baby: { icon: '👶', text: '约2kg，皮肤不再那么红皱' },
    mom: { icon: '🦵', text: '骨盆韧带松弛，走路更吃力' },
    tips: ['产检改为每周一次', '注意区分破水和漏尿', '了解催产素', '准备新生儿用品', '提前安排月嫂或家人陪护']
  },
  34: {
    baby: { icon: '🧠', text: '约2.2kg，中枢神经系统成熟中' },
    mom: { icon: '🫁', text: '胎头入盆后呼吸轻松一些' },
    tips: ['了解分娩流程', '练习分娩呼吸', '确认待产包是否齐全', '了解新生儿护理基础', '准备宝宝的衣服和尿布']
  },
  35: {
    baby: { icon: '✨', text: '约2.4kg，皮下脂肪丰满起来' },
    mom: { icon: '🤱', text: '初乳开始分泌' },
    tips: ['学习哺乳姿势', '了解开奶知识', '保持乳房清洁', '准备哺乳文胸和防溢乳垫', '了解新生儿疫苗接种']
  },
  36: {
    baby: { icon: '🍈', text: '约2.6kg，头部入盆固定' },
    mom: { icon: '💪', text: '下腹坠胀感，尿频严重' },
    tips: ['每周产检一次', '了解入院流程', '准备证件资料', '了解无痛分娩', '确认紧急联系人']
  },
  37: {
    baby: { icon: '🍈', text: '约2.9kg，肺部已成熟，随时可出生' },
    mom: { icon: '🎯', text: '宝宝入盆，胃部轻松些了' },
    tips: ['已足月，随时准备入院', '分辨真假宫缩', '破水后立即去医院', '准备好证件和待产包', '保持电话畅通']
  },
  38: {
    baby: { icon: '🍉', text: '约3.1kg，继续积累脂肪' },
    mom: { icon: '⏰', text: '随时可能发动，注意征兆' },
    tips: ['规律宫缩5-6分钟一次就去医院', '见红不必慌张，观察量', '破水要立即平躺去医院', '保持手机充满电', '深呼吸保持冷静']
  },
  39: {
    baby: { icon: '🍉', text: '约3.3kg，已经足月完全成熟' },
    mom: { icon: '🏥', text: '随时准备入院待产' },
    tips: ['注意临产征兆', '保持适度活动有助顺产', '练习呼吸法', '确认待产包已装车', '保持好心态']
  },
  40: {
    baby: { icon: '🍉', text: '约3.5kg，已完全成熟，准备出生' },
    mom: { icon: '🌹', text: '临产在即，调整好心态' },
    tips: ['到了预产期别焦虑', '超过41周医生会评估催产', '规律宫缩、破水、见红是三大信号', '相信自己和宝宝', '即将见面，加油！']
  }
}

// ── 兜底数据（网络异常时使用） ──
const FALLBACK = [
  {
    baby: { icon: '👶', text: '手指甲已完全形成，会自己抓握' },
    mom: { icon: '💆', text: '腰背酸痛加重，建议用孕妇枕' },
    tip: { icon: '💡', text: '保持左侧卧，有助于改善胎儿血液供应' }
  },
  {
    baby: { icon: '🫁', text: '肺部继续发育，已能进行呼吸练习' },
    mom: { icon: '🦵', text: '腿部抽筋常见，睡前补充钙和镁' },
    tip: { icon: '💡', text: '脚踝水肿若明显加重，应及时告知产科医生' }
  },
  {
    baby: { icon: '👶', text: '宝宝持续成长中，关注每日变化' },
    mom: { icon: '💆', text: '注意休息，保持好心情' },
    tip: { icon: '💡', text: '每天记录胎动，保持规律产检' }
  },
  {
    baby: { icon: '🧠', text: '皮下脂肪积累，皮肤越来越圆润' },
    mom: { icon: '🤱', text: '乳房准备哺乳，初乳开始分泌' },
    tip: { icon: '💡', text: '开始准备待产包清单，提前列好清单' }
  },
  {
    baby: { icon: '✨', text: '大脑褶皱加深，神经系统快速完善' },
    mom: { icon: '💤', text: '胎动越来越明显，感受宝宝翻滚' },
    tip: { icon: '💡', text: '每天数胎动3次，每次1小时' }
  }
]

// 将云端数据映射为 slides 格式
function cloudToSlide(record) {
  return {
    baby: { icon: record.baby_icon || '👶', text: record.baby_detail || record.baby_summary || '' },
    mom: { icon: record.mom_icon || '💆', text: record.mom_detail || record.mom_summary || '' },
    tip: { icon: record.tip_icon || '💡', text: record.tip_text || '' },
    totalDays: record.total_days
  }
}

// 根据孕周和日期偏移生成幻灯片数据（兜底用）
function getSlideForDay(dayTotal) {
  const week = Math.floor(dayTotal / 7)
  // 查找最近的可用周数据
  const weeks = Object.keys(WEEKLY_CHANGES).map(Number).sort((a, b) => a - b)
  let dataWeek = weeks[0]
  for (const w of weeks) {
    if (w <= week) dataWeek = w
    else break
  }
  const data = WEEKLY_CHANGES[dataWeek]
  if (!data) return MOCK_DATA[2]

  const dayInWeek = dayTotal % 7
  return {
    baby: data.baby,
    mom: data.mom,
    tip: { icon: '💡', text: data.tips[dayInWeek % data.tips.length] }
  }
}

const slides = computed(() => {
  const baseTotal = props.weekInfo.total
  let baseSlides
  // 优先使用云端数据
  if (props.slidesData && props.slidesData.length > 0) {
    const cloudMap = {}
    for (const r of props.slidesData) {
      cloudMap[r.total_days] = cloudToSlide(r)
    }
    baseSlides = [-2, -1, 0, 1, 2].map(off => {
      const dayTotal = baseTotal + off
      if (dayTotal < 0) return FALLBACK[off + 2]
      return cloudMap[dayTotal] || FALLBACK[off + 2]
    })
  } else {
    // 降级使用本地数据
    baseSlides = [-2, -1, 0, 1, 2].map(off => {
      const dayTotal = baseTotal + off
      if (dayTotal < 0) return MOCK_DATA[off + 2]
      return getSlideForDay(dayTotal)
    })
  }
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
