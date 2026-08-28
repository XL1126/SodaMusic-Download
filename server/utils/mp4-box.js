/**
 * 极简 ISO BMFF (MP4 / M4A) Box 解析器
 *  - Box 标准头 = [ size: uint32 | type: 4 字节 ASCII ]
 *  - 扩展情况：
 *      size==0  → 本 box 延伸到文件末尾（流式容器）。原本代码中 size==0 会造成
 *                 position += 0 陷入死循环，必须显式处理（当前文件是完整 buffer，
 *                 遇到 size==0 直接把 rest 算成 size）。
 *      size==1  → 真实 size 在 type 之后的 64-bit uint64 (大端)，原本不支持，
 *                 会误以为 size=1 只读到 header，导致后面 box 偏移全部错位。
 *  - findBox：在 [offset, end) 范围内线性搜索 fourcc == boxType 的第一个 box 并返回 Mp4Box。
 */

class Mp4Box {
  constructor({ size, type, offset, data }) {
    this.size = size
    this.type = type
    this.offset = offset
    this.data = data
  }

  isEmpty() {
    return this.size === 0
  }

  static fromBuffer(buffer, offset) {
    if (!Buffer.isBuffer(buffer) || offset + 8 > buffer.length) {
      return new Mp4Box({
        size: 0,
        type: '',
        offset: 0,
        data: Buffer.alloc(0),
      })
    }

    let size = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')

    // body 起始偏移（考虑 size==1 扩展 64 位头）
    let headerSize = 8

    // 【修复 size==1】ISO BMFF 扩展 size：type 后面紧跟 8 字节 uint64BE
    if (size === 1) {
      if (offset + 16 > buffer.length) {
        // 扩展头声明但实际 buffer 不够 → 认为是损坏 box，返回空
        return new Mp4Box({ size: 0, type: '', offset: 0, data: Buffer.alloc(0) })
      }
      // 不支持超过 Number.MAX_SAFE_INTEGER (≈ 2^53) 的巨型 box，
      // 汽水音乐单个歌曲 mp4/m4a 不会 > 150MB，远在安全范围内。
      const high = buffer.readUInt32BE(offset + 8)
      const low = buffer.readUInt32BE(offset + 12)
      size = high * 0x100000000 + low
      headerSize = 16
      if (size < headerSize) {
        return new Mp4Box({ size: 0, type: '', offset: 0, data: Buffer.alloc(0) })
      }
    } else if (size === 0) {
      // 【修复 size==0】流式场景：box 从 offset 延伸到 buffer 末尾
      //  原本 size==0 会让 findBox 做 position += 0 死循环，必须改为剩余长度。
      size = buffer.length - offset
    }

    const end = size >= headerSize && offset + size <= buffer.length ? offset + size : buffer.length

    return new Mp4Box({
      size: end - offset,
      type,
      offset,
      data: buffer.subarray(offset + headerSize, end),
    })
  }

  static findBox(buffer, boxType, offset = 0, end = buffer.length) {
    let position = offset

    while (position < end) {
      if (position + 8 > end) {
        break
      }

      const rawSize = buffer.readUInt32BE(position)

      // ---------- 计算当前 box 的实际 size（包含扩展头处理）----------
      let boxSize = rawSize
      let headerSize = 8
      if (rawSize === 1) {
        if (position + 16 > end) break
        const high = buffer.readUInt32BE(position + 8)
        const low = buffer.readUInt32BE(position + 12)
        boxSize = high * 0x100000000 + low
        headerSize = 16
      } else if (rawSize === 0) {
        // 【死循环修复】size==0：把剩余长度当 size 使，避免 position += 0 卡死 CPU 100%
        boxSize = end - position
        headerSize = 8
      }

      // 合法性：boxSize 必须至少能装下 header，且不能越出 end。
      //  未通过 → 说明后续数据是残缺 / 非 box 内容，直接退出（比死循环安全）
      if (boxSize < headerSize || position + boxSize > end) {
        break
      }

      const type = buffer.subarray(position + 4, position + 8).toString('ascii')
      if (type === boxType) {
        return Mp4Box.fromBuffer(buffer, position)
      }

      position += boxSize
    }

    return new Mp4Box({
      size: 0,
      type: '',
      offset: 0,
      data: Buffer.alloc(0),
    })
  }
}

module.exports = {
  Mp4Box,
}
