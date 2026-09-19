<script>
	import { useHealthStore } from '@/stores/health.js'
	import { isRealAuthed } from '@/utils/api.js'
	import { legacyHttpEnabled } from '@/utils/backendGate.js'

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
			startDayClock() {
				if (dayClockTimer) clearInterval(dayClockTimer)
				dayClockTimer = setInterval(() => {
					try {
						const healthStore = useHealthStore()
						const now = new Date()
						const sameDay = healthStore.today.getFullYear() === now.getFullYear() &&
							healthStore.today.getMonth() === now.getMonth() &&
							healthStore.today.getDate() === now.getDate()
						if (!sameDay) {
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
