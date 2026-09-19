export const API_BASE = 'https://momcare-api.dpc7775223.workers.dev'

const TOKEN_KEY = 'momcare_token'

// 演示模式专用占位 token：不代表任何已认证身份，仅用于本地演示态判断
export const GUEST_TOKEN = 'guest_mock_token'

function buildUrl(url) {
  if (/^https?:\/\//i.test(url)) return url
  return `${API_BASE}${url.startsWith('/') ? url : `/${url}`}`
}

export function getToken() {
  try {
    return uni.getStorageSync(TOKEN_KEY) || ''
  } catch (e) {
    console.warn('getToken failed:', e)
    return ''
  }
}

export function setToken(token) {
  try {
    uni.setStorageSync(TOKEN_KEY, token || '')
  } catch (e) {
    console.warn('setToken failed:', e)
  }
}

export function removeToken() {
  try {
    uni.removeStorageSync(TOKEN_KEY)
  } catch (e) {
    console.warn('removeToken failed:', e)
  }
}

export function isLoggedIn() {
  const token = getToken()
  return Boolean(token)
}

// 演示模式：持有的是本地占位 token，不是服务端认证
export function isGuestMode() {
  return getToken() === GUEST_TOKEN
}

// 真实认证：只有非演示 token 才允许发起需要鉴权的云端读写
export function isRealAuthed() {
  const token = getToken()
  return Boolean(token) && token !== GUEST_TOKEN
}

// 令牌指纹（本地非加密摘要）：用于把"数据归属确认"绑定到具体登录身份。
// 换 token 登录即指纹失配，确认状态随之失效、上传重新关闭
export function tokenFingerprint(token) {
  const s = String(token || '')
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `fp1_${h.toString(16)}_${s.length}`
}

// 网络层只负责传输结果：
// - 请求失败按失败传递（reject），绝不伪造成 200/业务成功
// - 业务状态由调用方根据 statusCode 与 data.code 判断
export function request(options = {}) {
  const token = getToken()
  const headers = {
    ...(options.header || options.headers || {})
  }

  if (token && !headers.Authorization) {
    headers.Authorization = `Bearer ${token}`
  }

  return new Promise((resolve, reject) => {
    uni.request({
      ...options,
      url: buildUrl(options.url || ''),
      header: headers,
      success: (res) => {
        if (res.statusCode === 401 && !options.skipAuthRedirect) {
          if (token !== GUEST_TOKEN) {
            removeToken()
            uni.showToast({ title: '登录已过期，请重新登录', icon: 'none' })
            setTimeout(() => {
              uni.redirectTo({ url: '/pages/login/index' })
            }, 600)
          }
          // 演示 token 收到 401 时不做伪成功降级，原样返回失败状态
        }
        resolve(res)
      },
      fail: (err) => {
        console.warn('uni.request failed:', err)
        const error = new Error((err && err.errMsg) || '网络请求失败')
        error.networkError = true
        error.errMsg = err && err.errMsg
        reject(error)
      }
    })
  })
}
