<script>
	import { useHealthStore } from '@/stores/health.js'
	import { isRealAuthed } from '@/utils/api.js'
	import { legacyHttpEnabled } from '@/utils/backendGate.js'
	import { getSessionState, foregroundRecheck, coldStartConfirm, persistedSessionExists, isExplicitDemo, isExplicitLoggedOut } from '@/services/sessionService.js'
	import { useFamilyStore } from '@/services/familyStore.js'

	// 跨日/回前台刷新 today：孕周等依赖日期的计算随 ref 更新
	let dayClockTimer = null

	export default {
		globalData: {
			statusBarHeight: 20,
			navBarHeight: 44,
			menuButtonRightPadding: 0
		},
		onLaunch: function() {
			console.log('MomCare Launch')

			// 初始化本地数据（正式模式不注入演示数据，不自动生成身份）
			try {
				const healthStore = useHealthStore()
				healthStore.initializeApp()
			} catch (e) {
				console.warn('初始化失败:', e)
			}

			// 启动跨日时钟：每分钟检查一次日期变化
			this.startDayClock()

			try {
				// 使用新 API 获取窗口信息（替代已废弃的 getSystemInfoSync）
				const windowInfo = uni.getWindowInfo()
				const statusBarHeight = windowInfo.statusBarHeight || 20
				const windowWidth = windowInfo.windowWidth || 375
				let navBarHeight = 44
				let menuButtonRightPadding = 0

				// #ifdef MP-WEIXIN
				try {
					const menuButton = uni.getMenuButtonBoundingClientRect()
					if (menuButton) {
						// 导航栏内容高度 = 胶囊按钮高度 + (胶囊距状态栏顶部的间距 * 2)
						navBarHeight = (menuButton.bottom - menuButton.top) + (menuButton.top - statusBarHeight) * 2
						// 右侧 padding = 屏幕宽度 - 胶囊左侧距离 + 额外间距
						menuButtonRightPadding = windowWidth - menuButton.left + 8
					}
				} catch (e) {
					console.warn('getMenuButtonBoundingClientRect failed', e)
				}
				// #endif

				this.globalData.statusBarHeight = statusBarHeight
				this.globalData.navBarHeight = navBarHeight
				this.globalData.menuButtonRightPadding = menuButtonRightPadding
			} catch (e) {
				console.error('App onLaunch error:', e)
			}
		},
		onShow: function() {
			console.log('MomCare Show')

			// 回前台重新计算真实经过时间（含跨日）
			try {
				const healthStore = useHealthStore()
				healthStore.refreshToday()
			} catch (e) {
				console.warn('refreshToday failed:', e)
			}

			// B2a：回前台身份复核（复现17修复）——先复核当前身份再恢复业务读写。
			// foregroundRecheck 是 App/页面共享的唯一确认入口（in-flight 去重，
			// 不竞争确认）；成员变化由 sessionVersion 驱动 store 清空旧数据；
			// 临时离线按暖离线保留已确认会话，明确拒绝锁定清屏。
			try {
				const session = getSessionState()
				// 演示优先（复验：已确认用户切演示后零正式请求）——先于一切 confirmed 分支
				if (isExplicitDemo()) {
					// 演示模式：不确认、不拉取正式数据
				} else {
				// 自动复核资格：显式演示/显式退出不被后台自动确认（R3-3）；
				// 冷启动 unconfirmed 只有持久会话标记（曾显式确认过）才自动复核
				let sessionMode = ''
				let hasPersistedSession = false
				try {
					sessionMode = uni.getStorageSync('mc_session_mode') || ''
					hasPersistedSession = persistedSessionExists()
				} catch (e) { /* 忽略 */ }
				const shouldRecheck = !isExplicitLoggedOut() && (session.status === 'confirmed' || (session.status === 'unconfirmed' && hasPersistedSession && sessionMode !== 'demo-explicit'))
				if (shouldRecheck) {
					// 冷启动（未确认+持久标记）走 coldStartConfirm：标记只触发网络确认，
					// 不放行缓存；已确认走 foregroundRecheck 复核。二者共享去重 Promise。
					const confirmFn = session.status === 'confirmed' ? foregroundRecheck : coldStartConfirm
					confirmFn().then(res => {
						if (res && res.ok) {
							const fam = useFamilyStore()
							fam.restoreFromCache()
							fam.pullAll().catch(() => {})
							fam.flushAll().catch(() => {})
						}
						// res.transient → 暖离线：已确认会话保留可用，不强制清屏
						// res.locked → confirmIdentity 已锁定并清空
					}).catch(() => {})
				}
				} // 演示优先分支闭合
			} catch (e) {
				console.warn('App.onShow family sync failed:', e)
			}

			// B1：旧 Cloudflare 云同步停用（正式后端切换 CloudBase，入口在家庭共享页）；
			// 失败保留本地数据，不伪成功
			if (legacyHttpEnabled() && isRealAuthed()) {
				try {
					const healthStore = useHealthStore()
					healthStore.syncCloudData().catch(e => {
						console.warn('onShow sync failed:', e)
					})
				} catch (e) {
					console.warn('onShow sync error:', e)
				}
			}
		},
		onHide: function() {
			console.log('MomCare Hide')
		},
		methods: {
			// 比较上海日号（非设备本地日期）：UTC 设备在上海午夜跨日时正确触发
			// refreshToday——与 familyStore/首页的 Asia/Shanghai 日号同一语义
			shanghaiDayKey(date) {
				const sh = new Date(date.getTime() + (8 * 60 + date.getTimezoneOffset()) * 60000)
				return sh.getFullYear() * 10000 + (sh.getMonth() + 1) * 100 + sh.getDate()
			},
			startDayClock() {
				if (dayClockTimer) clearInterval(dayClockTimer)
				dayClockTimer = setInterval(() => {
					try {
						const healthStore = useHealthStore()
						const now = new Date()
						if (this.shanghaiDayKey(healthStore.today) !== this.shanghaiDayKey(now)) {
							healthStore.refreshToday(now)
						}
					} catch (e) {
						// 时钟失败不影响其他功能
					}
				}, 60000)
			}
		}
	}
</script>

<style lang="scss">
	/* ==================== MomCare 全局样式 ==================== */
	/* 设计系统：柔韧之美 (Modern Feminine Strength) */

	/* CSS 变量 - 用于全局访问 */
	:root {
		--color-primary: #C2185B;
		--color-primary-dark: #9B0044;
		--color-primary-light: #E91E63;
		--color-primary-container: #FCE7F3;

		--color-surface: #FFFFFF;
		--color-surface-low: #F5F7FA;
		--color-surface-container: #F2F4F7;
		--color-surface-high: #E8EAED;

		--color-text: #191C1E;
		--color-text-secondary: #757575;
		--color-text-hint: #9E9E9E;

		--color-error: #EF5350;
		--color-success: #4cd964;
		--color-warning: #FFA726;

		--radius-sm: 8px;
		--radius-md: 12px;
		--radius-lg: 16px;
		--radius-xl: 24px;
		--radius-full: 9999px;

		--shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.04);
		--shadow-md: 0 4px 16px rgba(0, 0, 0, 0.06);
		--shadow-lg: 0 8px 32px rgba(194, 24, 91, 0.08);

		/* 小程序导航栏适配变量（兜底值，由 App.vue onLaunch 动态覆盖） */
		--status-bar-height: 20px;
		--nav-bar-height: 44px;
		--menu-button-right-padding: 0px;
	}

	/* 重置样式 */
	page {
		background-color: var(--color-surface-low);
		color: var(--color-text);
		font-size: 14px;
		line-height: 1.6;
	}

	/* 全局容器 */
	.momcare-container {
		min-height: 100vh;
		background-color: var(--color-surface-low);
	}

	/* 卡片组件 - 无边框设计 */
	.momcare-card {
		background-color: var(--color-surface);
		border-radius: var(--radius-lg);
		padding: 24rpx;
		margin: 16rpx;

		/* 幽灵边框 - 仅在必要时使用 */
		&.has-border {
			border: 1px solid rgba(0, 0, 0, 0.08);
		}
	}

	/* 主按钮 - Primary Button */
	.momcare-btn-primary {
		background: linear-gradient(180deg, var(--color-primary-light) 0%, var(--color-primary) 100%);
		color: #FFFFFF;
		border-radius: var(--radius-full);
		padding: 24rpx 48rpx;
		font-size: 16px;
		font-weight: 600;
		border: none;
		transition: all 0.2s ease;

		&:active {
			opacity: 0.9;
			transform: scale(0.98);
		}
	}

	/* 次要按钮 - Tertiary Button */
	.momcare-btn-tertiary {
		color: var(--color-primary);
		background: transparent;
		padding: 16rpx 24rpx;
		position: relative;

		&::after {
			content: '';
			position: absolute;
			bottom: 4px;
			left: 50%;
			transform: translateX(-50%);
			width: 0;
			height: 4px;
			background-color: var(--color-primary-container);
			border-radius: 2px;
			transition: width 0.2s ease;
		}

		&:active::after {
			width: 80%;
		}
	}

	/* Hero Number - 英雄数字 */
	.momcare-hero-number {
		font-size: 56px;
		font-weight: 700;
		color: var(--color-primary);
		line-height: 1;
		letter-spacing: -0.02em;
	}

	/* 标题层级 */
	.momcare-headline-lg {
		font-size: 28px;
		font-weight: 600;
		color: var(--color-text);
		line-height: 1.3;
	}

	.momcare-headline-md {
		font-size: 22px;
		font-weight: 600;
		color: var(--color-text);
		line-height: 1.4;
	}

	.momcare-body-lg {
		font-size: 16px;
		font-weight: 400;
		color: var(--color-text-secondary);
		line-height: 1.6;
	}

	/* 进度环形 */
	.momcare-progress-ring {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;

		&__bg {
			stroke: var(--color-surface-high);
		}

		&__progress {
			stroke: var(--color-primary);
			stroke-linecap: round;
			transform: rotate(-90deg);
			transform-origin: center;
		}
	}

	/* 玻璃态效果 */
	.momcare-glass {
		background: rgba(255, 255, 255, 0.85);
		backdrop-filter: blur(20px);
		-webkit-backdrop-filter: blur(20px);
	}

	/* 工具类 */
	.text-primary {
		color: var(--color-primary) !important;
	}

	.text-error {
		color: var(--color-error) !important;
	}

	.bg-surface {
		background-color: var(--color-surface) !important;
	}

	.bg-surface-low {
		background-color: var(--color-surface-low) !important;
	}

	/* 禁用状态 */
	.disabled {
		opacity: 0.3;
		pointer-events: none;
	}
</style>
