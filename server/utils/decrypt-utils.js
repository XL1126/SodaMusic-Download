/**
 * 解密与 MP4 元数据解析工具集
 * 本文件提供 TrackDecryptor 依赖的原子能力：
 *  - decryptSpadeA：汽水音乐自定义 spade_a 密钥字符串 → 16 字节 AES-128 key（hex/base64 两种密文形态）
 *  - hexToBuffer / aesCtrDecrypt：标准 AES-128-CTR 解密 primitive
 *  - parseStsz / parseStsc / parseSenc：解析 MP4 stbl 下的 sample 大小/块映射/加密 senc IV 表
 *  - scanForFlacMetadata：从 stsd 里提取汽水音乐内嵌的 fLaC 原始元数据块（FLAC 专用）
 *  - replaceEncaWithMp4a：解密输出 M4A 时把 stsd 中的密文 fourcc 'enca' 替换回明文 'mp4a'
 *  - sanitizeFilenamePart：文件名非法字符过滤
 */

const crypto = require('crypto')

function bitCount(value) {
  let current = value
  current = current - ((current >> 1) & 0x55555555)
  current = (current & 0x33333333) + ((current >> 2) & 0x33333333)
  return (((current + (current >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24
}

function decodeBase36(charCode) {
  if (charCode >= 48 && charCode <= 57) {
    return charCode - 48
  }

  if (charCode >= 97 && charCode <= 122) {
    return charCode - 97 + 10
  }

  return 0xff
}

function decryptSpadeInner(spadeKey) {
  const result = Buffer.from(spadeKey)
  const working = Buffer.alloc(spadeKey.length + 2)
  working[0] = 0xfa
  working[1] = 0x55
  spadeKey.copy(working, 2)

  for (let index = 0; index < result.length; index += 1) {
    let value = (spadeKey[index] ^ working[index]) - bitCount(index) - 21

    while (value < 0) {
      value += 0xff
    }

    result[index] = value & 0xff
  }

  return result
}

function decryptSpade(spadeKeyBytes) {
  if (!Buffer.isBuffer(spadeKeyBytes) || spadeKeyBytes.length < 3) {
    return ''
  }

  const paddingLength = (spadeKeyBytes[0] ^ spadeKeyBytes[1] ^ spadeKeyBytes[2]) - 48
  if (spadeKeyBytes.length < paddingLength + 2) {
    return ''
  }

  const innerInput = spadeKeyBytes.subarray(1, spadeKeyBytes.length - paddingLength)
  const tempBuffer = decryptSpadeInner(innerInput)

  if (tempBuffer.length === 0) {
    return ''
  }

  const skipBytes = decodeBase36(tempBuffer[0])
  const decodedMessageLength = spadeKeyBytes.length - paddingLength - 2
  const endIndex = 1 + decodedMessageLength - skipBytes

  if (endIndex > tempBuffer.length) {
    return ''
  }

  return tempBuffer.subarray(1, endIndex).toString('utf8')
}

function decryptSpadeA(spadeA) {
  try {
    return decryptSpade(Buffer.from(spadeA, 'base64'))
  } catch {
    return ''
  }
}

function hexToBuffer(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0) {
    throw new Error('Hex string length must be even.')
  }

  return Buffer.from(hex, 'hex')
}

function aesCtrDecrypt(key, iv, encrypted) {
  const decipher = crypto.createDecipheriv('aes-128-ctr', key, iv)
  return Buffer.concat([decipher.update(encrypted), decipher.final()])
}

// 解析 MP4 stsz box：返回每个 sample 的明文字节长度表
// sample_size 字段为 0 表示「每个 sample 变长、逐条读取」；非 0 表示固定大小
function parseStsz(data) {
  const sampleSize = data.readUInt32BE(4)
  const count = data.readUInt32BE(8)

  if (sampleSize !== 0) {
    return Array.from({ length: count }, () => sampleSize)
  }

  const sizes = []
  for (let index = 0; index < count; index += 1) {
    sizes.push(data.readUInt32BE(12 + index * 4))
  }

  return sizes
}

// 解析 MP4 stsc box：sample-to-chunk 映射表
// 条目含义：从第 firstChunk 块开始，每 chunk 内包含 samplesPerChunk 个 sample
//   - 用于非等长 muxing 时根据 chunk 编号反查 sample 在 chunk 中的偏移
function parseStsc(data) {
  const entryCount = data.readUInt32BE(4)
  const entries = []

  for (let index = 0; index < entryCount; index += 1) {
    const base = 8 + index * 12
    entries.push({
      firstChunk: data.readUInt32BE(base),
      samplesPerChunk: data.readUInt32BE(base + 4),
      id: data.readUInt32BE(base + 8),
    })
  }

  return entries
}

// 解析 MP4 senc box：senc = Sample ENCryption box（Common Encryption ISO/IEC 23001-7 简化版）
//
// 【关键说明 / 修复动机】
// 汽水音乐的 senc 每个 sample IV 只写入 8 字节（64-bit nonce），
// 而 AES-128-CTR 的 IV 需求是 128-bit。我们将其解释为：
//   - 高 8 字节 = senc 中读取到的 nonce
//   - 低 8 字节 = 0（CTR 计数器起始值 0，由 OpenSSL 内部按 block 自增）
// 这与「64-bit nonce + 64-bit counter」的标准 CTR 约定一致，
// 因此不再填充随机/其他默认值，而是明确 zero-fill 高 8 字节以外的部分，
// 避免「Buffer.alloc 默认 0」这种隐式语义让后续维护者产生误解。
// 若 senc 实际写入 16 字节 IV，未来只需调整 copy 长度即可。
function parseSenc(data) {
  const count = data.readUInt32BE(4)
  const ivs = []
  let position = 8

  for (let index = 0; index < count; index += 1) {
    const iv = Buffer.alloc(16, 0x00) // 明确以 0 填充（含低 8 字节计数器起始）
    data.copy(iv, 0, position, position + 8) // 拷贝高 8 字节 nonce
    ivs.push(iv)
    position += 8
  }

  return ivs
}

// 在 stsd box 中扫描汽水音乐 FLAC 资源内嵌的 fLaC 元数据块（STREAMINFO + VorbisComment 等）
//  - marker 4 字节 = 0x64 0x66 0x4c 0x61（即 ASCII 'dfLa'，内部 box fourcc）
//  - 向前回溯 4 字节读 box size，按 size 截出完整 FLAC metadata payload
function scanForFlacMetadata(stsdData) {
  const marker = Buffer.from([0x64, 0x66, 0x4c, 0x61])
  const index = stsdData.indexOf(marker)

  if (index === -1 || index < 4) {
    return Buffer.alloc(0)
  }

  const boxSize = stsdData.readUInt32BE(index - 4)
  const contentStart = index + 4
  const contentEnd = Math.min(index - 4 + boxSize, stsdData.length)

  if (contentEnd <= contentStart) {
    return Buffer.alloc(0)
  }

  return stsdData.subarray(contentStart, contentEnd)
}

// 在 stsd box 的明文 fourcc 位置内，把密文态 'enca' 替换为明文态 'mp4a'
//   - 这样 decrypted M4A 就能被系统/播放器正确识别为 AAC MP4 音频
//   - 只替换搜索范围内首个命中，避免误改其他字段
function replaceEncaWithMp4a(buffer, searchStart, searchEnd) {
  const target = Buffer.from('enca')
  const replacement = Buffer.from('mp4a')

  for (let index = searchStart; index + 4 <= searchEnd; index += 1) {
    if (buffer.subarray(index, index + 4).equals(target)) {
      replacement.copy(buffer, index)
      break
    }
  }
}

// 文件名安全化：去掉 Windows 下不允许出现在路径中的字符
function sanitizeFilenamePart(value, fallback) {
  const normalized = String(value || fallback)
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()

  return normalized || fallback
}

module.exports = {
  aesCtrDecrypt,
  decryptSpadeA,
  hexToBuffer,
  parseSenc,
  parseStsc,
  parseStsz,
  replaceEncaWithMp4a,
  sanitizeFilenamePart,
  scanForFlacMetadata,
}
