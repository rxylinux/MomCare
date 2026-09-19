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
            <text class="opt-sub">拍摄报告单，自动矫正图片</text>
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
import { request, API_BASE, getToken, isGuestMode } from '@/utils/api.js'

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['update:show', 'select'])
const reportStore = useReportStore()

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
  close()
  try {
    await uni.authorize({ scope: 'scope.camera' })
    await doCamera()
  } catch (e) {
    // 权限被拒绝
    showPermissionDialog('camera')
  }
}

async function doCamera() {
  try {
    const res = await new Promise((resolve, reject) => {
      uni.chooseImage({
        count: 9,
        sourceType: ['camera'],
        sizeType: ['compressed'],
        success: resolve,
        fail: reject
      })
    })
    await handleUploadResult(res.tempFilePaths)
  } catch (e) {
    console.error('Camera error:', e)
  }
}

// 相册选择
async function onGallery() {
  close()
  try {
    const res = await new Promise((resolve, reject) => {
      uni.chooseImage({
        count: 20,
        sourceType: ['album'],
        sizeType: ['compressed'],
        success: resolve,
        fail: reject
      })
    })
    if (res.tempFilePaths.length > 20) {
      uni.showToast({ title: '最多一次上传 20 张', icon: 'none' })
      return
    }
    await handleUploadResult(res.tempFilePaths)
  } catch (e) {
    console.error('Gallery error:', e)
    if (e && e.errMsg && e.errMsg.includes('deny')) {
      showPermissionDialog('album')
    }
  }
}

// 处理图片上传结果 — 立即上传到服务端
async function handleUploadResult(tempFilePaths) {
  if (!tempFilePaths || tempFilePaths.length === 0) return

  // 演示模式没有真实后端身份：明确不可上传，不发起请求、不产生假成功
  if (isGuestMode()) {
    uni.showToast({ title: '演示模式不支持上传报告，请退出演示后使用', icon: 'none', duration: 2500 })
    return
  }

  uni.showLoading({ title: '上传中…' })
  const uploadedItems = []   // { report_id, image_url }
  const localPaths = []      // 本地临时路径（用于预览）
  let failedCount = 0

  for (const filePath of tempFilePaths) {
    try {
      // Compress image before upload
      let uploadPath = filePath
      try {
        const compressRes = await new Promise((resolve, reject) => {
          uni.compressImage({
            src: filePath,
            quality: 20,
            success: resolve,
            fail: reject,
          })
        })
        uploadPath = compressRes.tempFilePath
      } catch {
        // compression failed, use original
      }

      // Upload via uni.uploadFile (binary, not base64)
      // token 读取与登录模块统一使用 momcare_token 键（getToken），
      // 不再读旧的 'token' 键导致鉴权头缺失
      const token = getToken()
      const uploadRes = await new Promise((resolve, reject) => {
        uni.uploadFile({
          url: API_BASE + '/api/reports/upload',
          filePath: uploadPath,
          name: 'file',
          header: { Authorization: token ? `Bearer ${token}` : '' },
          formData: {
            archive_status: 'archived',
          },
          success: resolve,
          fail: reject,
        })
      })

      const parsed = typeof uploadRes.data === 'string' ? JSON.parse(uploadRes.data) : uploadRes.data
      if (uploadRes.statusCode === 200 && parsed.code === 0) {
        uploadedItems.push({
          report_id: parsed.data.report_id,
          image_url: parsed.data.image_url,
        })
        localPaths.push(filePath)
      } else {
        failedCount++
      }
    } catch (e) {
      console.error('Upload failed for file:', filePath, e)
      failedCount++
    }
  }

  uni.hideLoading()

  if (failedCount > 0 && uploadedItems.length === 0) {
    uni.showToast({ title: '上传失败，请检查网络后重试', icon: 'none', duration: 2500 })
    return
  }

  if (failedCount > 0) {
    uni.showToast({ title: `${failedCount} 张上传失败已跳过，${uploadedItems.length} 张成功`, icon: 'none', duration: 2500 })
  }

  // Store upload data with server-issued ids
  const uploadData = {
    items: uploadedItems,
    fileUrls: uploadedItems.map(i => i.image_url),
    localPaths: localPaths,
    fileType: 'image',
    fileCount: uploadedItems.length
  }
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
