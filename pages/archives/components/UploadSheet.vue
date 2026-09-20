<template>
  <view v-if="show" class="overlay" @tap="close">
    <view class="overlay-spacer"></view>
    <view class="upload-sheet" :class="{ 'sheet-visible': animShow }" @tap.stop>
      <view class="sheet-handle"></view>
      <text class="sheet-title">上传产检报告</text>
      <view class="upload-options">
        <view class="upload-opt" @tap="onCamera">
          <view class="opt-icon camera">
            <text class="opt-icon-emoji">📷</text>
          </view>
          <view class="opt-text">
            <text class="opt-label">拍照上传</text>
            <text class="opt-sub">拍摄报告单，保留原件上传（不压缩替代原件）</text>
          </view>
          <text class="opt-arrow">›</text>
        </view>
        <view class="upload-opt" @tap="onGallery">
          <view class="opt-icon gallery">
            <text class="opt-icon-emoji">🖼️</text>
          </view>
          <view class="opt-text">
            <text class="opt-label">从相册选择</text>
            <text class="opt-sub">可多选，支持批量上传</text>
          </view>
          <text class="opt-arrow">›</text>
        </view>
      </view>
    </view>

    <!-- 权限引导弹窗 -->
    <ConfirmModal
      v-model:visible="showPermModal"
      :title="'需要权限'"
      :content="permModalContent"
      confirmText="去设置"
      @confirm="() => uni.openSetting()"
    />
  </view>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { useReportStore } from '@/stores/report'
import ConfirmModal from '@/components/common/ConfirmModal.vue'
import { request, getToken, isGuestMode } from '@/utils/api.js'
import { getSessionState, isExplicitDemo, isExplicitLoggedOut, currentEpoch } from '@/services/sessionService.js'
import { useReportFamilyStore } from '@/services/reportFamilyStore.js'

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['update:show', 'select'])
const reportStore = useReportStore()
const reportFamilyStore = useReportFamilyStore()
// B2b2 三态：family=权威批次上传 / 其余保持既有拦截（演示不假成功）
const isFamilyMode = () => getSessionState().status === 'confirmed' && !isExplicitDemo() && !isExplicitLoggedOut()

const animShow = ref(false)

watch(() => props.show, (val) => {
  if (val) {
    nextTick(() => {
      setTimeout(() => {
        animShow.value = true
      }, 50)
    })
  } else {
    animShow.value = false
  }
})

function close() {
  animShow.value = false
  setTimeout(() => {
    emit('update:show', false)
  }, 250)
}

// 拍照上传
async function onCamera() {
  // 操作级 epoch：授权/选图/持久副本/批次/导航贯穿同一次操作
  const opEpoch = currentEpoch()
  close()
  try {
    await uni.authorize({ scope: 'scope.camera' })
    await doCamera(opEpoch)
  } catch (e) {
    // 权限被拒绝
    showPermissionDialog('camera')
  }
}

async function doCamera(opEpoch) {
  try {
    const res = await new Promise((resolve, reject) => {
      uni.chooseImage({
        count: 9,
        sourceType: ['camera'],
        sizeType: ['original'], // 原件：不默认压缩替代原件
        success: resolve,
        fail: reject
      })
    })
    await handleUploadResult(res.tempFilePaths, opEpoch)
  } catch (e) {
    console.error('Camera error:', e)
  }
}

// 相册选择
async function onGallery() {
  const opEpoch = currentEpoch()
  close()
  try {
    const res = await new Promise((resolve, reject) => {
      uni.chooseImage({
        count: 20,
        sourceType: ['album'],
        sizeType: ['original'], // 原件：不默认压缩替代原件
        success: resolve,
        fail: reject
      })
    })
    if (res.tempFilePaths.length > 20) {
      uni.showToast({ title: '最多一次上传 20 张', icon: 'none' })
      return
    }
    await handleUploadResult(res.tempFilePaths, opEpoch)
  } catch (e) {
    console.error('Gallery error:', e)
    if (e && e.errMsg && e.errMsg.includes('deny')) {
      showPermissionDialog('album')
    }
  }
}

// 处理图片上传结果：family 走权威批次（持久副本→受控暂存→登记→报告），
// 演示/未确认保持明确拦截（不发起请求、不产生假成功）
async function handleUploadResult(tempFilePaths, opEpoch) {
  if (!tempFilePaths || tempFilePaths.length === 0) return
  // 选图返回后核对操作会话：挂起期间切成员，旧选择不得以新成员身份继续
  if (opEpoch !== undefined && currentEpoch() !== opEpoch) {
    uni.showToast({ title: '会话已切换，本次选择已取消', icon: 'none', duration: 2500 })
    return
  }

  // 演示模式没有真实后端身份：明确不可上传
  if (isGuestMode() || isExplicitDemo()) {
    uni.showToast({ title: '演示模式不支持上传报告，请退出演示后使用', icon: 'none', duration: 2500 })
    return
  }
  if (!isFamilyMode()) {
    uni.showToast({ title: '请先在「我的 → 家庭共享（云）」确认身份后上传', icon: 'none', duration: 3000 })
    return
  }
  // family：建批次（本机持久副本+完整清单落盘→逐项推进），交由分类页创建报告
  uni.showLoading({ title: '准备上传…' })
  let res
  try {
    res = await reportFamilyStore.createBatchFromTempPaths(tempFilePaths)
  } finally {
    uni.hideLoading()
  }
  if (!res.ok) {
    uni.showToast({ title: res.message || res.code || '无法建立上传批次', icon: 'none', duration: 2500 })
    return
  }
  if (!res.started) {
    uni.showToast({ title: '会话已切换，批次已保留在原成员名下', icon: 'none', duration: 2500 })
    return
  }
  const b = reportFamilyStore.batch(res.batchId)
  const uploadData = {
    batchId: res.batchId,
    items: b ? b.items.map(i => ({ order: i.order, uploadId: i.uploadId, fileId: i.fileId || '', state: i.state })) : [],
    fileUrls: [], // 附件以 fileId 引用；临时 URL 不持久化（详情页按需签发）
    localPaths: b ? b.items.map(i => i.savedFilePath) : [],
    fileType: 'image',
    fileCount: b ? b.items.length : tempFilePaths.length
  }
  // 单次交付：父页只收到一次 select（重复导航/重复批次由此杜绝）
  reportStore.pendingUpload = uploadData
  emit('select', uploadData)
}

// 权限拒绝引导
const showPermModal = ref(false)
const permType = ref('camera')

const permModalContent = computed(() => {
  const typeName = permType.value === 'camera' ? '相机' : '相册'
  return `需要${typeName}权限才能上传报告，是否前往设置开启？`
})

function showPermissionDialog(type) {
  permType.value = type
  showPermModal.value = true
}
</script>

<style scoped lang="scss">
.overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  flex-direction: column;
  z-index: 1000;
}

.overlay-spacer {
  flex: 1;
}

.upload-sheet {
  background: white;
  border-radius: 56rpx 56rpx 0 0;
  padding: 40rpx 40rpx 64rpx;
  transform: translateY(100%);
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.sheet-visible {
  transform: translateY(0);
}

.sheet-handle {
  width: 72rpx;
  height: 8rpx;
  background: #E4E1DC;
  border-radius: 4rpx;
  margin: 0 auto 40rpx;
}

.sheet-title {
  font-size: 32rpx;
  font-weight: 600;
  color: #1C1A17;
  margin-bottom: 32rpx;
  display: block;
}

.upload-options {
  display: flex;
  flex-direction: column;
  gap: 16rpx;
}

.upload-opt {
  display: flex;
  align-items: center;
  gap: 28rpx;
  padding: 28rpx 32rpx;
  background: #FAF9F8;
  border-radius: 20rpx;
}

.opt-icon {
  width: 80rpx;
  height: 80rpx;
  border-radius: 20rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.opt-icon-emoji {
  font-size: 36rpx;
}

.opt-icon.camera { background: #FDEEF1; }
.opt-icon.gallery { background: #EBF3FE; }

.opt-text { flex: 1; }

.opt-label {
  font-size: 28rpx;
  font-weight: 500;
  color: #1C1A17;
  display: block;
}

.opt-sub {
  font-size: 24rpx;
  color: #9C9890;
  margin-top: 2rpx;
  display: block;
}

.opt-arrow {
  font-size: 28rpx;
  color: #C8C4BC;
  flex-shrink: 0;
}
</style>
