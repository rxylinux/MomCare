<template>
	<view class="page">
		<!-- Hero -->
		<view class="guide-hero">
			<view class="status-bar">
				<text class="sb-time">9:41</text>
				<view class="sb-icons">
					<text>●●●</text>
					<text>🔋</text>
				</view>
			</view>
			<view class="hero-top">
				<view class="back-btn" @tap="goBack">
					<text class="back-arrow">‹</text>
				</view>
			</view>
				<text class="hero-title">{{ heroTitle }}</text>
				<text class="hero-sub">{{ heroSubtitle }}</text>
				<view class="hero-stats" v-if="guideData">
				<view class="stat-card">
					<text class="stat-val">{{ guideData.babyWeight }}</text>
					<text class="stat-lbl">宝宝体重</text>
				</view>
				<view class="stat-card">
					<text class="stat-val">{{ guideData.babyLength }}</text>
					<text class="stat-lbl">身长</text>
				</view>
				<view class="stat-card">
					<text class="stat-val">{{ guideData.fundalHeight }}</text>
					<text class="stat-lbl">宫底高度</text>
				</view>
				<view class="stat-card">
					<text class="stat-val">{{ daysLeft }}天</text>
					<text class="stat-lbl">距预产期</text>
				</view>
			</view>
		</view>

		<!-- Week selector -->
			<scroll-view class="week-strip" scroll-x :scroll-into-view="scrollTarget" scroll-with-animation>
			<view class="week-strip-inner">
				<view
					v-for="w in weekRange"
					:key="w"
					:id="'week-' + w"
					class="week-chip"
					:class="{ active: w === currentWeek }"
					@tap="selectWeek(w)"
				>
					<text class="week-chip-text">孕{{ w }}周</text>
				</view>
			</view>
		</scroll-view>

		<!-- Content -->
		<scroll-view class="content-scroll" scroll-y v-if="guideData">
			<view class="content">

				<!-- 宝宝发育 -->
				<view class="gc-card">
					<view class="gc-header">
						<text class="gc-header-icon">{{ guideData.baby.icon }}</text>
						<text class="gc-header-title">宝宝本周发育</text>
					</view>
					<view class="gc-body">
						<text class="gc-para" v-for="(p, idx) in guideData.baby.paragraphs" :key="idx">{{ p }}</text>
						<view v-if="guideData.baby.highlight" class="gc-highlight gc-highlight-rose">
							<text>{{ guideData.baby.highlight }}</text>
						</view>
					</view>
				</view>

				<!-- 妈妈变化 -->
				<view class="gc-card">
					<view class="gc-header">
						<text class="gc-header-icon">💆</text>
						<text class="gc-header-title">妈妈本周变化</text>
					</view>
					<view class="gc-body">
						<view class="gc-list">
							<view class="gc-list-item" v-for="(item, idx) in guideData.mom.items" :key="idx">
								<view class="gc-dot gc-dot-rose">
									<text class="gc-dot-text">{{ item.label }}</text>
								</view>
								<text class="gc-list-text">{{ item.text }}</text>
							</view>
						</view>
						<view v-if="guideData.mom.highlight" class="gc-highlight gc-highlight-sage">
							<text>{{ guideData.mom.highlight }}</text>
						</view>
					</view>
				</view>

				<!-- 营养重点 -->
				<view class="gc-card">
					<view class="gc-header">
						<text class="gc-header-icon">🥗</text>
						<text class="gc-header-title">本周营养重点</text>
					</view>
					<scroll-view class="food-scroll" scroll-x>
						<view class="food-scroll-inner">
							<view class="food-item" v-for="(f, idx) in guideData.foods" :key="idx">
								<text class="food-icon">{{ f.icon }}</text>
								<text class="food-name">{{ f.name }}</text>
								<text class="food-why">{{ f.why }}</text>
							</view>
						</view>
					</scroll-view>
					<view v-if="guideData.avoidFood" class="gc-body" style="padding-top: 0;">
						<view class="gc-highlight gc-highlight-amber">
							<text>{{ guideData.avoidFood }}</text>
						</view>
					</view>
				</view>

				<!-- 产检提醒 -->
				<view class="gc-card">
					<view class="gc-header">
						<text class="gc-header-icon">🏥</text>
						<text class="gc-header-title">本阶段产检</text>
					</view>
					<view class="gc-body">
						<view class="gc-list">
							<view class="gc-list-item" v-for="(item, idx) in guideData.checkup" :key="idx">
								<view :class="['gc-dot', item.warn ? 'gc-dot-amber' : 'gc-dot-sage']">
									<text class="gc-dot-text">{{ item.icon }}</text>
								</view>
								<text class="gc-list-text">{{ item.text }}</text>
							</view>
						</view>
					</view>
				</view>

				<!-- 待产准备 -->
				<view class="gc-card">
					<view class="gc-header">
						<text class="gc-header-icon">🎒</text>
						<text class="gc-header-title">现在可以开始做的事</text>
					</view>
					<view class="gc-body">
						<view class="gc-list">
							<view class="gc-list-item" v-for="(item, idx) in guideData.preparation" :key="idx">
								<view class="gc-dot gc-dot-rose">
									<text class="gc-dot-text">{{ idx + 1 }}</text>
								</view>
								<text class="gc-list-text">{{ item }}</text>
							</view>
						</view>
					</view>
				</view>

				<view style="height: 40rpx;"></view>
			</view>
		</scroll-view>

		<!-- 内容未收录（周龄在本地兜底覆盖之外 / 数据缺）——诚实空态，不拿别的周冒充 -->
		<view v-else class="content-scroll">
			<view class="content">
				<view class="gc-card">
					<view class="gc-header">
						<text class="gc-header-icon">📖</text>
						<text class="gc-header-title">本周内容暂未收录</text>
					</view>
					<view class="gc-body">
						<view class="gc-list">
							<view class="gc-list-item">
								<view class="gc-dot gc-dot-sage"><text class="gc-dot-text">→</text></view>
								<text class="gc-list-text">上面选择其他孕周可继续浏览（孕 30 周起内容齐全）</text>
							</view>
						</view>
					</view>
				</view>
			</view>
		</view>
	</view>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { onLoad, onReady } from '@dcloudio/uni-app'
import { useStaticDataStore } from '@/stores/staticData.js'

const staticDataStore = useStaticDataStore()

// 0 = 未就绪（参数未达/非法）。不再写死演示假默认 32——那个假默认会在首次渲染
// 瞬间把周条滚动并高亮到孕 32 周，参数纠正后高亮移走但滚动不跟随（真机已复现）。
const currentWeek = ref(0)
const cloudData = ref(null)
const loadError = ref(false)

// 周条定位目标：首渲染恒为空（不抢跑），onReady 布局完成后一次性定位到真实孕周；
// 切周时先清空再赋值，保证 scroll-into-view 属性发生真实变更（微信端才可靠触发）
const scrollTarget = ref('')
function locateWeek() {
	scrollTarget.value = ''
	nextTick(() => {
		scrollTarget.value = currentWeek.value > 0 ? `week-${currentWeek.value}` : ''
	})
}
watch(currentWeek, () => locateWeek())
onReady(() => locateWeek())

const heroTitle = computed(() => currentWeek.value > 0 ? `孕 ${currentWeek.value} 周完整指南` : '孕期指南')

// Load from page options (uni-app lifecycle)
onLoad((options) => {
	const w = parseInt(options && options.week)
	if (w >= 1 && w <= 40) {
		currentWeek.value = w
	}
	if (currentWeek.value > 0) {
		loadGuideData(currentWeek.value)
	}
})

const weekRange = computed(() => {
	// 显示完整的 1-40 周范围，让用户可以自由切换
	const range = []
	for (let i = 1; i <= 40; i++) range.push(i)
	return range
})

const daysLeft = computed(() => {
	const w = currentWeek.value
	return Math.max(0, (40 - w) * 7)
})

const heroSubtitle = computed(() => {
	const w = currentWeek.value
	if (w < 1 || !guideData.value) return '选择孕周查看对应指南'
	let month = ''
	if (w <= 12) month = '孕早期'
	else if (w <= 27) month = '孕中期'
	else month = '孕晚期'
	const data = guideData.value
	const weight = data.babyWeight || '未知'
	return `${month} · 宝宝约 ${weight} · 还有约 ${daysLeft.value} 天`
})

function selectWeek(w) {
	currentWeek.value = w
}

function goBack() {
	uni.navigateBack()
}

// ── 数据加载 ──
async function loadGuideData(week) {
		if (week < 1 || week > 40) return
		loadError.value = false
		if (!staticDataStore.loaded) await staticDataStore.loadData()
		cloudData.value = staticDataStore.getWeeklyGuide(week)
		if (!cloudData.value) loadError.value = true
	}

// 监听 currentWeek 变化时重新加载数据
watch(currentWeek, (newWeek) => {
	loadGuideData(newWeek)
})

// 将数据库记录映射为页面格式
function cloudToPageData(record) {
	if (!record) return null
	return {
		babyWeight: record.baby_weight,
		babyLength: record.baby_length,
		fundalHeight: record.fundal_height,
		baby: record.baby,
		mom: record.mom,
		foods: record.foods,
		avoidFood: record.avoid_food,
		checkup: record.checkup,
		preparation: record.preparation
	}
}

// ── Guide data for each week ──
const GUIDE_DATA = {
	30: {
		babyWeight: '1.3kg', babyLength: '40cm', fundalHeight: '30cm',
		baby: {
			icon: '🥥',
			paragraphs: [
				'宝宝约 1.3kg，大脑在快速发育，脑回加深，表面开始出现沟裂。',
				'大脑皮层开始有更复杂的功能分区，宝宝的学习能力正在打基础。'
			],
			highlight: '🎉 从现在开始，宝宝的大脑发育进入冲刺期，DHA补充很关键！'
		},
		mom: {
			items: [
				{ label: '心', text: '心输出量达到孕期峰值，活动后容易气短' },
				{ label: '肿', text: '手脚水肿常见，避免久站久坐' },
				{ label: '腰', text: '腰背酸痛加剧，使用托腹带有帮助' }
			],
			highlight: '💡 气短是因为子宫压迫横膈膜，休息时左侧卧可以缓解'
		},
		foods: [
			{ icon: '🐟', name: '深海鱼', why: 'DHA脑发育' },
			{ icon: '🥩', name: '红肉', why: '补铁防贫血' },
			{ icon: '🥛', name: '牛奶', why: '每天500ml' },
			{ icon: '🥚', name: '鸡蛋', why: '优质蛋白' },
			{ icon: '🥦', name: '西兰花', why: '叶酸+VC' }
		],
		avoidFood: '🚫 避免：生鱼片、高汞鱼（金枪鱼）、酒精、过量咖啡因',
		checkup: [
			{ icon: '✓', text: '孕 30-32 周：产科检查 + 血常规 + 尿常规' },
			{ icon: '✓', text: '胎心监护开始（高危孕妇）' },
			{ icon: '!', text: '注意血压变化，预防妊娠高血压', warn: true }
		],
		preparation: [
			'了解分娩方式选择，与医生讨论分娩计划',
			'开始学习拉玛泽呼吸法',
			'准备待产包清单',
			'确认就诊医院路线和紧急联系方式'
		]
	},
	31: {
		babyWeight: '1.5kg', babyLength: '41cm', fundalHeight: '30cm',
		baby: {
			icon: '🥥',
			paragraphs: [
				'宝宝约 1.5kg，五官已经非常精致，能够转头、做出面部表情。',
				'五官精致，能转头、做出面部表情。五感发育更加完善，能感受到光线和声音。'
			],
			highlight: '🎉 宝宝已经能记忆一些反复出现的声音，多和宝宝说话吧！'
		},
		mom: {
			items: [
				{ label: '气', text: '气短和尿频加重，活动后需要多休息' },
				{ label: '胃', text: '胃被挤压，少量多餐很重要' },
				{ label: '便', text: '便秘可能加重，多喝水多吃纤维' }
			],
			highlight: '💡 尝试左侧卧位睡觉，在两腿间夹一个枕头会更舒服'
		},
		foods: [
			{ icon: '🥩', name: '红肉', why: '补铁防贫血' },
			{ icon: '🥛', name: '牛奶', why: '每天500ml' },
			{ icon: '🐟', name: '三文鱼', why: 'DHA脑发育' },
			{ icon: '🥦', name: '深色蔬菜', why: '叶酸/铁/VC' },
			{ icon: '🫐', name: '蓝莓', why: '抗氧化' }
		],
		avoidFood: '🚫 避免：生鱼片、高汞鱼（金枪鱼）、酒精、过量咖啡因',
		checkup: [
			{ icon: '✓', text: '孕 30-32 周：产科检查 + 血常规' },
			{ icon: '✓', text: 'B 超评估胎儿体重、胎位、羊水量' },
			{ icon: '!', text: '出现规律宫缩或出血请立即就医', warn: true }
		],
		preparation: [
			'学习分娩呼吸法，每天练习几分钟',
			'了解母乳喂养基础知识',
			'准备哺乳用品（文胸、防溢乳垫）',
			'安排好产假和工作交接'
		]
	},
	32: {
		babyWeight: '1.8kg', babyLength: '42cm', fundalHeight: '31cm',
		baby: {
			icon: '👶',
			paragraphs: [
				'宝宝进入孕 8 月，体重约 1.8kg，身长约 42cm，皮下脂肪继续积累，皮肤越来越圆润饱满。',
				'本周最重要的变化：大脑皮层快速发育，褶皱（脑回）持续加深，智力基础正在形成；肺部接近成熟，表面活性物质分泌充足。'
			],
			highlight: '🎉 宝宝已经可以在子宫内做出精细动作——吸吮手指、抓握，甚至出现打嗝！'
		},
		mom: {
			items: [
				{ label: '气', text: '横膈膜被上推，气短感加剧，活动后喘气明显' },
				{ label: '胃', text: '胃被挤压，消化变慢，饭后腹胀不适' },
				{ label: '腰', text: '腰背酸痛持续，骨盆韧带松弛' },
				{ label: '肿', text: '脚踝和手部水肿常见，久站后更明显' },
				{ label: '奶', text: '乳房继续增大，少量初乳分泌属正常' }
			],
			highlight: '💡 气短感在孕 36 周宝宝入盆后会明显减轻，再坚持一下！'
		},
		foods: [
			{ icon: '🥩', name: '红肉', why: '补铁防贫血' },
			{ icon: '🥛', name: '牛奶', why: '每天500ml' },
			{ icon: '🐟', name: '三文鱼', why: 'DHA脑发育' },
			{ icon: '🥦', name: '深色蔬菜', why: '叶酸/铁/VC' },
			{ icon: '🥚', name: '鸡蛋', why: '优质蛋白质' },
			{ icon: '🫐', name: '蓝莓', why: '抗氧化' }
		],
		avoidFood: '🚫 避免：生鱼片、高汞鱼（金枪鱼）、酒精、过量咖啡因',
		checkup: [
			{ icon: '✓', text: '孕 32-34 周：产科检查 + 血常规 + 胎心监护（NST）' },
			{ icon: '✓', text: 'B 超评估胎儿体重、胎位、羊水量' },
			{ icon: '✓', text: 'GBS（B 族链球菌）筛查在孕 35-37 周进行' },
			{ icon: '!', text: '若宝宝是臀位，医生可能建议外转胎位术（ECV）', warn: true }
		],
		preparation: [
			'准备待产包：妈妈用品、宝宝用品、证件资料',
			'了解分娩方式（顺产/剖宫产），与医生确认方向',
			'学习拉玛泽呼吸法，帮助分娩时减痛',
			'确认就诊医院、产房及相关手续流程'
		]
	},
	33: {
		babyWeight: '2.0kg', babyLength: '43cm', fundalHeight: '32cm',
		baby: {
			icon: '👶',
			paragraphs: [
				'宝宝约 2kg，皮肤不再那么红皱，皮下脂肪越来越丰富，变得更白嫩。',
				'免疫系统正在发育，从母体接收抗体，为出生后建立抵抗力做准备。'
			],
			highlight: '🎉 给宝宝放轻柔的音乐是很好的早教，宝宝出生后可能会对这些声音更敏感！'
		},
		mom: {
			items: [
				{ label: '骨', text: '骨盆韧带松弛，走路更吃力' },
				{ label: '奶', text: '乳房在为哺乳做准备，初乳分泌增加' },
				{ label: '睡', text: '睡眠质量下降，翻身困难' },
				{ label: '频', text: '尿频加重，夜间需要多次起夜' }
			],
			highlight: '💡 骨盆痛是正常现象，穿低跟舒适的鞋子可以缓解不适'
		},
		foods: [
			{ icon: '🥛', name: '牛奶', why: '每天500ml' },
			{ icon: '🥩', name: '红肉', why: '补铁' },
			{ icon: '🐟', name: '深海鱼', why: 'DHA' },
			{ icon: '🥜', name: '坚果', why: '优质脂肪' },
			{ icon: '🥦', name: '深色蔬菜', why: '铁+VC' }
		],
		avoidFood: '🚫 避免：生食、高糖食品、过量水果（防妊娠糖尿病）',
		checkup: [
			{ icon: '✓', text: '产检改为每两周一次' },
			{ icon: '✓', text: '胎心监护（NST）每次产检都做' },
			{ icon: '!', text: '注意区分破水和漏尿，破水需立即就医', warn: true }
		],
		preparation: [
			'提前安排月嫂或家人陪护',
			'准备新生儿用品（衣服、尿布、奶瓶）',
			'了解哺乳姿势和开奶知识',
			'确认待产包是否齐全'
		]
	},
	34: {
		babyWeight: '2.2kg', babyLength: '44cm', fundalHeight: '32cm',
		baby: {
			icon: '🧠',
			paragraphs: [
				'宝宝约 2.2kg，中枢神经系统继续成熟，肺部也接近完全成熟。',
				'如果现在出生，宝宝已经可以自主呼吸，不需要太多医疗辅助。'
			],
			highlight: '🎉 从这个阶段开始，宝宝的肺部基本成熟，是一个重要的里程碑！'
		},
		mom: {
			items: [
				{ label: '呼', text: '胎头入盆后呼吸会轻松一些' },
				{ label: '频', text: '尿频更加明显，膀胱被压迫' },
				{ label: '肿', text: '手脚水肿继续，抬高双脚有帮助' }
			],
			highlight: '💡 宝宝入盆后你会感觉上腹部轻松了，但下腹部坠胀感会增加'
		},
		foods: [
			{ icon: '🥩', name: '红肉', why: '补铁' },
			{ icon: '🥛', name: '酸奶', why: '钙+益生菌' },
			{ icon: '🍠', name: '红薯', why: '膳食纤维' },
			{ icon: '🥚', name: '鸡蛋', why: '优质蛋白' },
			{ icon: '🍊', name: '橙子', why: '维C' }
		],
		avoidFood: '🚫 避免：高盐食品（加重水肿）、生冷食物、酒精',
		checkup: [
			{ icon: '✓', text: '每两周产检：血压、体重、胎心监护' },
			{ icon: '✓', text: 'GBS筛查安排在下次产检（35-37周）' },
			{ icon: '!', text: '了解早产征兆：规律宫缩、破水、见红', warn: true }
		],
		preparation: [
			'了解分娩流程和入院手续',
			'练习分娩呼吸法',
			'确认待产包已准备齐全',
			'了解新生儿护理基础知识'
		]
	},
	35: {
		babyWeight: '2.4kg', babyLength: '45cm', fundalHeight: '33cm',
		baby: {
			icon: '✨',
			paragraphs: [
				'宝宝约 2.4kg，皮下脂肪越来越丰满，圆润可爱。',
				'肾脏已经发育成熟，肝脏也在积蓄铁质，为出生后做准备。'
			],
			highlight: '🎉 大部分宝宝到这一周已经头部朝下，做好了入盆准备！'
		},
		mom: {
			items: [
				{ label: '奶', text: '初乳开始分泌，乳房在为哺乳做最后准备' },
				{ label: '坠', text: '下腹坠胀感明显，宝宝在向下移动' },
				{ label: '宫', text: '假性宫缩可能更频繁' }
			],
			highlight: '💡 学习哺乳姿势和含接方法，提前了解能减少产后焦虑'
		},
		foods: [
			{ icon: '🥛', name: '牛奶', why: '补钙' },
			{ icon: '🐟', name: '深海鱼', why: 'DHA' },
			{ icon: '🥩', name: '瘦肉', why: '补铁' },
			{ icon: '🥑', name: '牛油果', why: '优质脂肪' },
			{ icon: '🍲', name: '少量多餐', why: '减轻胃部不适' }
		],
		avoidFood: '🚫 避免：高糖食品、咖啡因、生食、辛辣刺激',
		checkup: [
			{ icon: '✓', text: 'GBS（B 族链球菌）筛查本周进行' },
			{ icon: '✓', text: '产检改为每周一次' },
			{ icon: '✓', text: '胎位确认，如为臀位需讨论分娩方案' },
			{ icon: '!', text: '出现规律宫缩（每10分钟1次）请立即联系医院', warn: true }
		],
		preparation: [
			'学习哺乳姿势和开奶知识',
			'保持乳房清洁，准备哺乳文胸和防溢乳垫',
			'了解新生儿疫苗接种计划',
			'安排好产后照护和月子计划'
		]
	},
	36: {
		babyWeight: '2.6kg', babyLength: '46cm', fundalHeight: '34cm',
		baby: {
			icon: '🍈',
			paragraphs: [
				'宝宝约 2.6kg，头部已入盆固定，为分娩做好准备。',
				'肺部已基本成熟，各项器官已具备出生后独立运作的能力。'
			],
			highlight: '🎉 宝宝现在如果出生就是足月了，大部分宝宝都能健康存活！'
		},
		mom: {
			items: [
				{ label: '坠', text: '下腹坠胀感强烈，宝宝完全入盆了' },
				{ label: '频', text: '尿频非常严重，膀胱被完全压迫' },
				{ label: '走', text: '走路更加困难，像企鹅一样摇摆' },
				{ label: '睡', text: '几乎找不到舒服的睡姿' }
			],
			highlight: '💡 每周一次产检非常重要，密切监测胎心和胎位'
		},
		foods: [
			{ icon: '🍯', name: '蜂蜜水', why: '补充能量' },
			{ icon: '🥛', name: '牛奶', why: '补钙' },
			{ icon: '🍌', name: '香蕉', why: '防便秘' },
			{ icon: '🥩', name: '红肉', why: '补铁' },
			{ icon: '🍲', name: '少量多餐', why: '轻松消化' }
		],
		avoidFood: '🚫 避免：辛辣刺激（可能引发宫缩）、高糖高盐、生食',
		checkup: [
			{ icon: '✓', text: '每周产检：胎心监护 + 宫高腹围测量' },
			{ icon: '✓', text: '确认胎位和入盆状态' },
			{ icon: '!', text: '分辨真假宫缩，真宫缩5-6分钟一次且逐渐增强', warn: true }
		],
		preparation: [
			'确认入院流程和手续',
			'准备好所有证件资料',
			'了解无痛分娩选项',
			'确认紧急联系人和医院路线'
		]
	},
	37: {
		babyWeight: '2.9kg', babyLength: '47cm', fundalHeight: '34cm',
		baby: {
			icon: '🍈',
			paragraphs: [
				'宝宝约 2.9kg，肺部已完全成熟，随时可以出生。',
				'从本周起宝宝已足月，免疫系统已准备好迎接外部世界。'
			],
			highlight: '🎉 宝宝已经足月啦！随时准备见面！'
		},
		mom: {
			items: [
				{ label: '松', text: '宝宝入盆后胃部轻松了一些' },
				{ label: '坠', text: '下腹坠胀感更明显' },
				{ label: '宫', text: '假性宫缩频繁，注意区分真假' },
				{ label: '黏', text: '可能出现宫颈黏液栓排出（见红前兆）' }
			],
			highlight: '💡 见红不必慌张，只有出现规律宫缩或破水才需要立即去医院'
		},
		foods: [
			{ icon: '🍯', name: '蜂蜜水', why: '补充能量' },
			{ icon: '🥚', name: '鸡蛋', why: '优质蛋白' },
			{ icon: '🍲', name: '粥类', why: '易消化' },
			{ icon: '🥛', name: '牛奶', why: '补钙' },
			{ icon: '🍌', name: '香蕉', why: '防便秘' }
		],
		avoidFood: '🚫 避免：不易消化的食物、过饱饮食、刺激性食物',
		checkup: [
			{ icon: '✓', text: '每周产检：胎心监护、内检评估宫颈条件' },
			{ icon: '✓', text: '确认分娩方式和入院流程' },
			{ icon: '!', text: '破水后立即平躺去医院，不可洗澡', warn: true }
		],
		preparation: [
			'随时准备入院，待产包放在显眼位置',
			'分辨真假宫缩',
			'破水后立即平躺去医院',
			'保持电话畅通，确认陪产人员'
		]
	},
	38: {
		babyWeight: '3.1kg', babyLength: '48cm', fundalHeight: '35cm',
		baby: {
			icon: '🍉',
			paragraphs: [
				'宝宝约 3.1kg，继续积累脂肪，越来越圆润。',
				'肠道内开始积聚胎便（墨绿色），出生后1-2天会排出。'
			],
			highlight: '🎉 宝宝已经做好了一切准备，随时等待与你见面！'
		},
		mom: {
			items: [
				{ label: '宫', text: '随时可能发动，注意宫缩规律' },
				{ label: '走', text: '走路非常困难，尽量休息' },
				{ label: '睡', text: '几乎无法好好睡觉' }
			],
			highlight: '💡 规律宫缩5-6分钟一次、每次持续30秒以上就该去医院了'
		},
		foods: [
			{ icon: '🍯', name: '蜂蜜水', why: '分娩能量' },
			{ icon: '🍫', name: '巧克力', why: '快速补充能量' },
			{ icon: '🍲', name: '清淡饮食', why: '减轻胃部负担' },
			{ icon: '🥛', name: '牛奶', why: '补钙' }
		],
		avoidFood: '🚫 避免：过饱饮食、不易消化食物、生冷食物',
		checkup: [
			{ icon: '✓', text: '每周产检：密切监测胎心和胎位' },
			{ icon: '!', text: '规律宫缩、破水、大量见红是三大临产信号', warn: true },
			{ icon: '!', text: '超过预产期一周医生会评估是否催产', warn: true }
		],
		preparation: [
			'规律宫缩5-6分钟一次就去医院',
			'见红不必慌张，观察出血量',
			'破水要立即平躺去医院',
			'保持手机充满电，准备好待产包'
		]
	},
	39: {
		babyWeight: '3.3kg', babyLength: '49cm', fundalHeight: '35cm',
		baby: {
			icon: '🍉',
			paragraphs: [
				'宝宝约 3.3kg，已经足月完全成熟，随时准备出生。',
				'宝宝的头部已经深入骨盆，做好了最后的出发准备。'
			],
			highlight: '🎉 宝宝已经在门口等着了，保持好心态，即将见面！'
		},
		mom: {
			items: [
				{ label: '待', text: '随时准备入院待产' },
				{ label: '宫', text: '假性宫缩更加频繁' },
				{ label: '松', text: '可能突然觉得上腹部轻松了（胎儿下降）' }
			],
			highlight: '💡 适当散步有助于胎儿入盆和顺产，但不要过度劳累'
		},
		foods: [
			{ icon: '🍯', name: '蜂蜜水', why: '分娩能量' },
			{ icon: '🍫', name: '巧克力', why: '快速能量' },
			{ icon: '🥚', name: '鸡蛋羹', why: '易消化蛋白' },
			{ icon: '🍲', name: '粥类', why: '清淡饮食' }
		],
		avoidFood: '🚫 避免：大鱼大肉、辛辣刺激、不易消化食物',
		checkup: [
			{ icon: '✓', text: '每周产检：密切关注临产征兆' },
			{ icon: '!', text: '注意胎动变化，明显减少需就医', warn: true }
		],
		preparation: [
			'注意临产征兆：规律宫缩、破水、见红',
			'保持适度活动有助顺产',
			'练习呼吸法，保持好心态',
			'确认待产包已装车，随时出发'
		]
	},
	40: {
		babyWeight: '3.5kg', babyLength: '50cm', fundalHeight: '35cm',
		baby: {
			icon: '🍉',
			paragraphs: [
				'宝宝约 3.5kg，已完全成熟，随时准备出生！',
				'宝宝已经做好了迎接新世界的全部准备，所有器官都已发育成熟。'
			],
			highlight: '🎉 到了预产期别焦虑，只有约5%的宝宝在预产期当天出生！'
		},
		mom: {
			items: [
				{ label: '心', text: '调整好心态，保持积极乐观' },
				{ label: '待', text: '随时准备入院' },
				{ label: '练', text: '继续练习呼吸法' }
			],
			highlight: '💡 超过预产期不必焦虑，医生会在41周评估是否需要催产'
		},
		foods: [
			{ icon: '🍯', name: '蜂蜜水', why: '分娩能量' },
			{ icon: '🍫', name: '巧克力', why: '快速能量' },
			{ icon: '🍲', name: '清淡饮食', why: '保持体力' },
			{ icon: '💧', name: '充足饮水', why: '保持水分' }
		],
		avoidFood: '🚫 避免：大鱼大肉、过饱饮食、生冷食物',
		checkup: [
			{ icon: '!', text: '超过41周医生会评估是否需要催产', warn: true },
			{ icon: '!', text: '胎动明显减少（12小时少于10次）请立即就医', warn: true },
			{ icon: '✓', text: '保持每周产检，密切监测' }
		],
		preparation: [
			'到了预产期别焦虑，耐心等待',
			'超过41周医生会评估催产方案',
			'规律宫缩、破水、见红是三大信号',
			'相信自己和宝宝，即将见面，加油！'
		]
	}
}

// 数据展示：优先使用云端数据，降级到兜底数据
const guideData = computed(() => {
	// 如果有云端数据，使用云端数据
	if (cloudData.value) {
		const pageData = cloudToPageData(cloudData.value)
		if (pageData) return pageData
	}

	// 降级到本地兜底数据（仅覆盖孕 30-40 周）。覆盖之外的周龄诚实返回 null——
	// 模板显示"暂未收录"空态，不再拿孕 30/32 周内容冒充（原 closest 初值取首键，
	// 30 周以前会静默展示孕 30 周内容）
	const w = currentWeek.value
	if (GUIDE_DATA[w]) return GUIDE_DATA[w]
	const keys = Object.keys(GUIDE_DATA).map(Number).sort((a, b) => a - b)
	const closest = keys.filter(k => k <= w).pop()
	return closest ? GUIDE_DATA[closest] : null
})
</script>

<style scoped lang="scss">
$cream: #FBF7F2;
$cream2: #F5EFE6;
$cream3: #EDE3D6;
$rose: #D4627A;
$rose-lt: #FAEAEE;
$rose-dk: #B04560;
$sage: #7BA08C;
$sage-lt: #EAF2EE;
$amber: #C98A3A;
$amber-lt: #FDF3E3;
$lavender: #9B7EC8;
$lav-lt: #F2EDFB;
$gray400: #9C9890;
$gray600: #4A4844;
$gray900: #1C1A17;
$border: #E8DDD0;

.page {
	min-height: 100vh;
	background: $cream;
	display: flex;
	flex-direction: column;
}

/* Hero */
.guide-hero {
	background: linear-gradient(140deg, #8A5A6A 0%, #C07080 40%, #E0A0B0 100%);
	padding: 0 40rpx 50rpx;
	flex-shrink: 0;
	position: relative;
	overflow: hidden;
}

.status-bar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 20rpx 0;
	font-size: 24rpx;
	font-weight: 600;
	color: white;
}

.sb-icons {
	display: flex;
	gap: 10rpx;
	font-size: 22rpx;
}

.hero-top {
	display: flex;
	align-items: center;
	margin-bottom: 20rpx;
}

.back-btn {
	width: 64rpx;
	height: 64rpx;
	border-radius: 50%;
	background: rgba(255, 255, 255, 0.2);
	display: flex;
	align-items: center;
	justify-content: center;
}

.back-arrow {
	font-size: 36rpx;
	color: white;
	line-height: 1;
}

.hero-title {
	font-size: 48rpx;
	font-weight: 700;
	color: white;
	display: block;
	margin-bottom: 8rpx;
}

.hero-sub {
	font-size: 26rpx;
	color: rgba(255, 255, 255, 0.8);
	line-height: 1.6;
	display: block;
}

.hero-stats {
	display: flex;
	gap: 16rpx;
	margin-top: 24rpx;
}

.stat-card {
	background: rgba(255, 255, 255, 0.2);
	border-radius: 20rpx;
	padding: 16rpx 20rpx;
	flex: 1;
	text-align: center;
}

.stat-val {
	font-size: 32rpx;
	font-weight: 700;
	color: white;
	display: block;
}

.stat-lbl {
	font-size: 18rpx;
	color: rgba(255, 255, 255, 0.75);
	display: block;
	margin-top: 4rpx;
}

/* Week strip */
.week-strip {
	background: white;
	border-bottom: 2rpx solid $border;
	flex-shrink: 0;
	white-space: nowrap;
}

.week-strip-inner {
	display: flex;
	padding: 20rpx 28rpx;
	gap: 16rpx;
}

.week-chip {
	padding: 12rpx 28rpx;
	border-radius: 999rpx;
	background: $cream2;
	display: inline-flex;
	align-items: center;
	flex-shrink: 0;
}

.week-chip.active {
	background: $rose;
}

.week-chip-text {
	font-size: 24rpx;
	font-weight: 500;
	color: $gray600;
}

.week-chip.active .week-chip-text {
	color: white;
}

/* Content scroll */
.content-scroll {
	flex: 1;
	height: 0;
}

.content {
	padding: 24rpx 28rpx;
	display: flex;
	flex-direction: column;
	gap: 24rpx;
}

/* Guide cards */
.gc-card {
	background: white;
	border-radius: 32rpx;
	box-shadow: 0 4rpx 28rpx rgba(60, 30, 10, 0.07);
	overflow: hidden;
}

.gc-header {
	display: flex;
	align-items: center;
	gap: 16rpx;
	padding: 28rpx 32rpx;
	border-bottom: 2rpx solid $cream2;
}

.gc-header-icon {
	font-size: 40rpx;
}

.gc-header-title {
	font-size: 30rpx;
	font-weight: 600;
	color: $gray900;
}

.gc-body {
	padding: 28rpx 32rpx;
}

.gc-para {
	font-size: 26rpx;
	color: $gray600;
	line-height: 1.8;
	display: block;
	margin-bottom: 16rpx;
}

.gc-para:last-child {
	margin-bottom: 0;
}

.gc-highlight {
	border-radius: 20rpx;
	padding: 20rpx 28rpx;
	margin-top: 20rpx;
	font-size: 24rpx;
	line-height: 1.7;
	border-left: 6rpx solid;
}

.gc-highlight-rose {
	background: $rose-lt;
	border-left-color: $rose;
	color: $rose-dk;
}

.gc-highlight-sage {
	background: $sage-lt;
	border-left-color: $sage;
	color: #2D5A48;
}

.gc-highlight-amber {
	background: $amber-lt;
	border-left-color: $amber;
	color: #7A4A10;
}

/* List items */
.gc-list {
	display: flex;
	flex-direction: column;
	gap: 16rpx;
}

.gc-list-item {
	display: flex;
	align-items: flex-start;
	gap: 16rpx;
}

.gc-dot {
	width: 40rpx;
	height: 40rpx;
	border-radius: 50%;
	display: flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
	margin-top: 4rpx;
}

.gc-dot-text {
	font-size: 20rpx;
	font-weight: 700;
}

.gc-dot-rose {
	background: $rose-lt;
	color: $rose;
}

.gc-dot-sage {
	background: $sage-lt;
	color: $sage;
}

.gc-dot-amber {
	background: $amber-lt;
	color: $amber;
}

.gc-list-text {
	font-size: 26rpx;
	color: $gray600;
	line-height: 1.6;
}

/* Food scroll */
.food-scroll {
	white-space: nowrap;
}

.food-scroll-inner {
	display: flex;
	gap: 20rpx;
	padding: 28rpx 32rpx;
}

.food-item {
	flex-shrink: 0;
	background: $cream;
	border-radius: 20rpx;
	padding: 20rpx 24rpx;
	border: 2rpx solid $border;
	text-align: center;
	width: 240rpx;
	/* 重置外层 nowrap，允许内部文字换行 */
	white-space: normal;
}

.food-icon {
	font-size: 48rpx;
	display: block;
	margin-bottom: 8rpx;
}

.food-name {
	font-size: 24rpx;
	font-weight: 500;
	color: $gray900;
	display: block;
}

.food-why {
	font-size: 20rpx;
	color: $gray400;
	display: block;
	margin-top: 4rpx;
	line-height: 1.4;
	/* 强制换行 */
	white-space: normal;
	word-wrap: break-word;
	word-break: break-word;
	/* 多行省略 */
	display: -webkit-box;
	-webkit-box-orient: vertical;
	-webkit-line-clamp: 2;
	overflow: hidden;
	text-overflow: ellipsis;
}
</style>
