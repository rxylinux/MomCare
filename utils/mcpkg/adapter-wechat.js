// B3b 微信平台适配器（设计 §4.1）：FileSystemManager 合约封装。
// - writeFile 首写 / appendFile 顺序追加（typings 16985–17012，基础库 ≥2.1.0）
// - readFile position/length 分块读（禁止整包/整段读取）
// - 发布：rename 可用则改名（不假设原子），否则复制到目标后由调用方整包复验（设计 §2.5 C3/C4）
import { LIMITS, ContainerError } from './container.js'

function fsm() {
  if (typeof wx === 'undefined' || !wx.getFileSystemManager) return null
  return wx.getFileSystemManager()
}

export function wechatFsAvailable() {
  return fsm() !== null
}

function callFs(api, opts) {
  const manager = fsm()
  return new Promise((resolve, reject) => {
    manager[api]({ ...opts, success: resolve, fail: e => reject(new ContainerError('fs-error', `${api} 失败：${e && e.errMsg}`)) })
  })
}

export async function ensureDir(path) {
  const manager = fsm()
  if (!manager || !manager.mkdir) return
  await new Promise(resolve => {
    manager.mkdir({ dirPath: path, recursive: true, success: resolve, fail: () => resolve() })
  })
}

export async function removeFile(path) {
  const manager = fsm()
  if (!manager || !manager.unlink) return
  await new Promise(resolve => {
    manager.unlink({ filePath: path, success: resolve, fail: () => resolve() })
  })
}

export async function removeDir(path) {
  const manager = fsm()
  if (!manager || !manager.rmdir) return
  await new Promise(resolve => {
    manager.rmdir({ dirPath: path, recursive: true, success: resolve, fail: () => resolve() })
  })
}

// 分块读适配器（reader 契约：size()/readChunk）
export function wechatFileReader(path) {
  return {
    async size() {
      const r = await callFs('stat', { path })
      return r && r.stats && r.stats.size
    },
    async readChunk(position, length) {
      const r = await callFs('readFile', { filePath: path, position, length })
      const ab = r && r.data
      if (!(ab instanceof ArrayBuffer)) throw new ContainerError('fs-error', 'readFile 未返回 ArrayBuffer')
      return new Uint8Array(ab)
    }
  }
}

// 写入适配器：writeChunk(data, {append})；readChunk/size 供逐段回读校验
export function wechatFileWriter(path) {
  return {
    path,
    async writeChunk(data, { append = false } = {}) {
      if (!(data instanceof Uint8Array)) throw new ContainerError('invalid-type', 'writeChunk 只接受 Uint8Array')
      // 写入预算：单次 fsm 调用 ≤64KiB（大 manifest/大段分多次 append——rev6 有界写入）
      let offset = 0
      let first = !append
      while (offset < data.length) {
        const n = Math.min(LIMITS.CHUNK_BYTES, data.length - offset)
        const part = data.subarray(offset, offset + n)
        const copy = part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength)
        if (first) { await callFs('writeFile', { filePath: path, data: copy }); first = false }
        else await callFs('appendFile', { filePath: path, data: copy })
        offset += n
      }
      if (offset === 0 && !append) await callFs('writeFile', { filePath: path, data: new ArrayBuffer(0) })
    },
    async size() {
      const r = await callFs('stat', { path })
      return r && r.stats && r.stats.size
    },
    async readChunk(position, length) {
      const r = await callFs('readFile', { filePath: path, position, length })
      if (!(r && r.data instanceof ArrayBuffer)) throw new ContainerError('fs-error', 'readFile 未返回 ArrayBuffer')
      return new Uint8Array(r.data)
    }
  }
}

// C3 发布：临时名 → 目标名。rename 可用则改名（原子性不作假设——C4 复验兜底）；
// 否则分块复制到目标。发布后调用方必须对目标文件整包分块复验。
export async function publishToTarget(fromPath, toPath) {
  const manager = fsm()
  if (manager && typeof manager.rename === 'function') {
    await callFs('rename', { oldPath: fromPath, newPath: toPath })
    return 'renamed'
  }
  const reader = wechatFileReader(fromPath)
  const writer = wechatFileWriter(toPath)
  const size = await reader.size()
  let offset = 0
  while (offset < size) {
    const n = Math.min(LIMITS.CHUNK_BYTES, size - offset)
    const chunk = await reader.readChunk(offset, n)
    await writer.writeChunk(chunk, { append: offset > 0 })
    offset += n
  }
  return 'copied'
}

// 临时路径约定（USER_DATA_PATH 下；卸载即失——如实边界）
export function exportPaths(batchId) {
  const base = `${wx.env.USER_DATA_PATH}/MomCareExport`
  return {
    base,
    tmpDir: `${base}/tmp`,
    tmpFile: fi => `${base}/tmp/${batchId}_f${fi}.bin`,
    partial: `${base}/${batchId}.mcpkg.partial`,
    target: `${base}/${batchId}.mcpkg`
  }
}
