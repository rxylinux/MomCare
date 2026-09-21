<template>
	<view class="page">
		<NavBar title="关于孕途伴侣" />
		<scroll-view scroll-y class="scroll-content">
			<!-- 应用信息 -->
			<view class="app-header">
				<text class="app-icon">🌸</text>
				<text class="app-name">孕途伴侣</text>
				<text class="app-version">版本 v{{ appVersion }}</text>
				<text class="app-desc">您的贴心孕期管理助手，陪伴您度过这段美好旅程</text>
			</view>

			<!-- 功能介绍 -->
			<view class="section">
				<text class="section-lbl">核心功能</text>
				<view class="feature-card">
					<view class="feature-item">
						<view class="feature-icon" style="background: #FAEAEE;">
							<text>📊</text>
						</view>
						<view class="feature-body">
							<text class="feature-title">孕期日历</text>
							<text class="feature-sub">三阶段着色日历，直观展示孕程</text>
						</view>
					</view>
					<view class="feature-item">
						<view class="feature-icon" style="background: #EAF2EE;">
							<text>⚖️</text>
						</view>
						<view class="feature-body">
							<text class="feature-title">健康记录</text>
							<text class="feature-sub">体重、血压、胎动、心情全面追踪</text>
						</view>
					</view>
					<view class="feature-item">
						<view class="feature-icon" style="background: #FDEEF1;">
							<text>👨‍👩‍👧</text>
						</view>
						<view class="feature-body">
							<text class="feature-title">家庭共享</text>
							<text class="feature-sub">与另一半云同步，任务互助代记</text>
						</view>
					</view>
					<view class="feature-item">
						<view class="feature-icon" style="background: #EBF2FB;">
							<text>🤖</text>
						</view>
						<view class="feature-body">
							<text class="feature-title">报告档案与 AI 解读</text>
							<text class="feature-sub">拍照存档产检报告，智能解读关注异常指标</text>
						</view>
					</view>
					<view class="feature-item">
						<view class="feature-icon" style="background: #EAF7EF;">
							<text>⏱️</text>
						</view>
						<view class="feature-body">
							<text class="feature-title">孕期工具</text>
							<text class="feature-sub">胎动计时、宫缩计时与 511 判定、超声体重估算</text>
						</view>
					</view>
					<view class="feature-item">
						<view class="feature-icon" style="background: #F0F5E8;">
							<text>🥗</text>
						</view>
						<view class="feature-body">
							<text class="feature-title">饮食速查</text>
							<text class="feature-sub">孕期饮食安全词典与 AI 咨询</text>
						</view>
					</view>
					<view class="feature-item">
						<view class="feature-icon" style="background: #F2F0EE;">
							<text>📚</text>
						</view>
						<view class="feature-body">
							<text class="feature-title">知识库</text>
							<text class="feature-sub">孕期知识文章安心阅读</text>
						</view>
					</view>
					<view class="feature-item">
						<view class="feature-icon" style="background: #EBF0FA;">
							<text>📅</text>
						</view>
						<view class="feature-body">
							<text class="feature-title">产检提醒</text>
							<text class="feature-sub">产检日程自动安排提醒</text>
						</view>
					</view>
					<view class="feature-item">
						<view class="feature-icon" style="background: #FDF3E3;">
							<text>🎒</text>
						</view>
						<view class="feature-body">
							<text class="feature-title">待产清单</text>
							<text class="feature-sub">分类清单帮您做好充分准备</text>
						</view>
					</view>
				</view>
			</view>

			<!-- 法律信息 (暂时隐藏) -->
			<view class="section" v-if="false">
				<text class="section-lbl">法律信息</text>
				<view class="legal-card">
					<view class="legal-row" @tap="openLink('privacy')">
						<text class="legal-title">隐私政策</text>
						<text class="legal-arrow">›</text>
					</view>
					<view class="legal-row" @tap="openLink('terms')">
						<text class="legal-title">用户协议</text>
						<text class="legal-arrow">›</text>
					</view>
					<view class="legal-row" @tap="openLink('opensource')">
						<text class="legal-title">开源许可</text>
						<text class="legal-arrow">›</text>
					</view>
				</view>
			</view>

			<!-- 联系我们 -->
			<view class="section">
				<text class="section-lbl">联系我们</text>
				<view class="feature-card">
					<view class="feature-item" @tap="copyEmail">
						<view class="feature-icon" style="background: #F0E8F5;">
							<text>✉️</text>
						</view>
						<view class="feature-body">
							<text class="feature-title">客服与反馈</text>
							<text class="feature-sub">344566495@qq.com · 点击复制邮箱</text>
						</view>
					</view>
				</view>
			</view>

			<view class="footer">
				<text class="footer-text">Made with ❤️ for every mom</text>
			</view>

			<view class="bottom-spacer"></view>
		</scroll-view>
	</view>
</template>

<script setup>
import NavBar from '@/components/NavBar.vue'
import manifest from '@/manifest.json'

const appVersion = manifest.versionName || '1.0.0'
const SUPPORT_EMAIL = '344566495@qq.com'

function copyEmail() {
	uni.setClipboardData({
		data: SUPPORT_EMAIL,
		success: () => {
			uni.showToast({ title: '邮箱已复制', icon: 'success' })
		}
	})
}

function openLink(type) {
	uni.showToast({ title: '功能开发中', icon: 'none' })
}
</script>

<style scoped lang="scss">
.page {
	display: flex;
	flex-direction: column;
	height: 100vh;
	background-color: #FBF7F2;
}

.scroll-content { flex: 1; }

.app-header {
	display: flex;
	flex-direction: column;
	align-items: center;
	padding: 48rpx 40rpx 32rpx;
}

.app-icon { font-size: 96rpx; margin-bottom: 16rpx; }

.app-name {
	font-size: 40rpx;
	font-weight: 700;
	color: #1C1A17;
}

.app-version {
	font-size: 26rpx;
	color: #9C9890;
	margin-top: 8rpx;
}

.app-desc {
	font-size: 26rpx;
	color: #4A4844;
	text-align: center;
	margin-top: 16rpx;
	line-height: 1.6;
}

.section { margin: 20rpx 28rpx 0; }

.section-lbl {
	display: block;
	font-size: 22rpx;
	font-weight: 700;
	color: #9C9890;
	text-transform: uppercase;
	letter-spacing: 3rpx;
	margin-bottom: 14rpx;
}

.feature-card, .legal-card, .contact-card {
	background: #FFFFFF;
	border-radius: 32rpx;
	box-shadow: 0 4rpx 28rpx rgba(60, 30, 10, 0.07);
	overflow: hidden;
}

.feature-item {
	display: flex;
	align-items: center;
	padding: 24rpx 28rpx;
	border-bottom: 1rpx solid #E8DDD0;
}

.feature-item:last-child { border-bottom: none; }

.feature-icon {
	width: 64rpx;
	height: 64rpx;
	border-radius: 18rpx;
	display: flex;
	align-items: center;
	justify-content: center;
	font-size: 30rpx;
	margin-right: 22rpx;
	flex-shrink: 0;
}

.feature-body { flex: 1; }

.feature-title {
	display: block;
	font-size: 28rpx;
	font-weight: 500;
	color: #1C1A17;
}

.feature-sub {
	display: block;
	font-size: 22rpx;
	color: #9C9890;
	margin-top: 2rpx;
}

.legal-row {
	display: flex;
	align-items: center;
	padding: 26rpx 28rpx;
	border-bottom: 1rpx solid #E8DDD0;
}

.legal-row:last-child { border-bottom: none; }

.legal-title {
	flex: 1;
	font-size: 28rpx;
	color: #1C1A17;
}

.legal-arrow { font-size: 28rpx; color: #C8C4BC; }

.contact-row {
	display: flex;
	align-items: center;
	padding: 22rpx 28rpx;
	border-bottom: 1rpx solid #E8DDD0;
}

.contact-row:last-child { border-bottom: none; }

.contact-icon { font-size: 28rpx; margin-right: 16rpx; }

.contact-text { font-size: 26rpx; color: #4A4844; }

.footer {
	text-align: center;
	padding: 40rpx 0 20rpx;
}

.footer-text {
	font-size: 22rpx;
	color: #C8C4BC;
}

.bottom-spacer { height: 40rpx; }
</style>
