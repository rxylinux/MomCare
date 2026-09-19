// 正式后端选型门（B1/R2）：正式云后端已确定为 CloudBase。
//
// 两条集中关闭的边界（fail closed，不依赖页面零散守卫）：
// 1. legacyHttpEnabled()===false —— utils/api.js request() 一律拒绝（零旧 HTTP），
//    覆盖 store 内部的同步/上传/分析与所有页面调用。
// 2. legacyFormalStoresEnabled()===false —— 旧正式本地键（YUNTU_HEALTH_DATA /
//    YUNTU_REPORTS_DATA，归属未确认）对读写渲染全面隔离：store 的 _loadStorage
//    返回空、_saveStorage 拒写，直到 B3 显式迁移确认。数据保留在磁盘，不删除。
//    演示键（MOMCARE_DEMO_*）与已验证成员缓存（mc_cache_*）不受影响。
//
// __setLegacyHttpEnabledForTests / __setLegacyFormalStoresEnabledForTests：
// 仅供历史回归套件显式开启旧路径，继续验证阶段 A 的数据安全语义（回滚/幂等/
// 不伪成功）；生产恒为 false，两套结果在交接中分别如实标注。

export const FORMAL_BACKEND = 'cloudbase'

let legacyHttpEnabledFlag = false
let legacyFormalStoresEnabledFlag = false

export function legacyHttpEnabled() {
  return legacyHttpEnabledFlag
}

export function legacyFormalStoresEnabled() {
  return legacyFormalStoresEnabledFlag
}

export function legacyDisabledMessage() {
  return '旧云服务已停用（正式后端切换为 CloudBase，阶段 B 配置后启用）'
}

export function formalStoresQuarantineMessage() {
  return '旧正式数据已隔离（来源未确认，阶段 B3 迁移确认后启用）；演示模式与家庭云空间不受影响'
}

// 测试专用：显式开启旧路径（历史 A 套件语义验证）；生产代码不得调用
export function __setLegacyHttpEnabledForTests(enabled) {
  legacyHttpEnabledFlag = Boolean(enabled)
}

export function __setLegacyFormalStoresEnabledForTests(enabled) {
  legacyFormalStoresEnabledFlag = Boolean(enabled)
}
