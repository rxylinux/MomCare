// B3b H5 平台适配器（设计 §4.2）：仅本地验包/预览（活体云端导出/恢复在 H5 不可用——
// cloudAdapter unavailable-platform，不发明 H5 鉴权）。File.slice 分块读，禁止整包驻留。
import { ContainerError } from './container.js'

export function h5FileReader(file) {
  if (!file || typeof file.slice !== 'function') {
    throw new ContainerError('invalid-type', 'H5 读取需要 File/Blob')
  }
  return {
    async size() {
      return file.size
    },
    async readChunk(position, length) {
      const blob = file.slice(position, position + length)
      const ab = await blob.arrayBuffer()
      return new Uint8Array(ab)
    }
  }
}
