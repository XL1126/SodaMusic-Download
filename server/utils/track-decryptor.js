/**
 * 单音轨解密核心类（MP4 / FLAC 通用）
 *
 * 解密流程：
 *  1. resolveKey(spadeA)          → 根据后端下发的 spade_a 字符串反解出 AES-128 key
 *  2. decrypt({encryptedBuffer, …})→ 解析 MP4 atom 树 (moov → trak → mdia → minf → stbl)
 *                                    读出 sample 尺寸 / chunk 表 / senc IV，
 *                                    对 mdat 中的每个加密 sample 按 AES-128-CTR 解密；
 *                                    根据 stsd 中是否内嵌 fLaC metadata 判断最终输出 FLAC 还是 M4A
 *
 * 原问题 / 修复点：
 *  - decryptSampleList 的入参 stscEntries、chunkCount 原本声明但完全未使用，
 *    造成「看起来按 chunk 算了 offset，实际却没算」的误导。
 *    原因：当前汽水音乐的 muxer 生成的都是「线性 mdat：chunk 与 sample 严格 1:1 且连续排布」
 *    的 MP4，因此 sampleOffset 直接累加 sampleSize 是正确的；但为避免未来支持复杂 muxing
 *    时维护者踩坑，这里显式把未使用参数重命名为 _stscEntries / _chunkCount 并加说明注释。
 *    真正需要支持 stsc/stco 按 chunk 偏移重排时，可在注释位置补入按 stsc 查表的实现。
 */

const { Mp4Box } = require('./mp4-box')
const {
  aesCtrDecrypt,
  decryptSpadeA,
  hexToBuffer,
  parseSenc,
  parseStsc,
  parseStsz,
  replaceEncaWithMp4a,
  sanitizeFilenamePart,
  scanForFlacMetadata,
} = require('./decrypt-utils')

class TrackDecryptor {
  resolveKey(spadeA) {
    if (!spadeA) {
      throw new Error('spade_a is required for decryption.')
    }

    const isHex = /^[0-9a-fA-F]+$/.test(spadeA)
    const keyHex = isHex ? spadeA : decryptSpadeA(spadeA)

    if (!keyHex) {
      throw new Error('Failed to resolve decryption key from spade_a.')
    }

    return hexToBuffer(keyHex)
  }

  // 按顺序解密 mdat 中所有 sample（当前假定 sample 在 mdat 内连续线性排布）
  //
  //  _stscEntries / _chunkCount 【注意：当前故意不使用】
  //    - 汽水音乐服务端 MP4 muxer 目前生成的是 1 chunk = 1 sample 且 chunk 在 mdat 中
  //      与 sample 顺序完全一致的简单布局，因此 sampleOffset 直接累加 sampleSize 就等价于
  //      走 stsc → stco 查表得到的文件偏移。
  //    - 若未来上游更换 muxer（出现「1 chunk 多 sample」或「sample 与 mdat 顺序错位」），
  //      会出现「解密前几个正常，后面全是杂音」的现象，此时应在本函数开头按
  //      stco (chunk offset) + stsc (samplesPerChunk per chunk) 重新算出每个 sample
  //      在文件内的绝对偏移，再线性解密。
  decryptSampleList({ fileBuffer, key, sampleSizes, ivs, mdatOffset, _stscEntries, _chunkCount }) {
    const decryptedSamples = []
    let sampleOffset = mdatOffset + 8 // mdat box body 从 size+type (8字节) 后开始

    for (let index = 0; index < sampleSizes.length; index += 1) {
      const size = sampleSizes[index]
      const iv = ivs[index]

      if (!iv) {
        throw new Error(`Missing IV for sample ${index}.`)
      }

      const encrypted = fileBuffer.subarray(sampleOffset, sampleOffset + size)
      decryptedSamples.push(aesCtrDecrypt(key, iv, encrypted))
      sampleOffset += size
    }

    return decryptedSamples
  }

  // 把 FLAC 元数据块 + 所有已解密的 FLAC frame 拼接成标准 fLaC 文件
  //   - 注意：汽水音乐在 stsd 中内嵌的 metadata 前 4 字节并非 'fLaC'，
  //     而是它所属 box 的 fourcc（'dfLa'），因此取 subarray(4) 剥掉 header
  buildFlacFile(flacMetadata, decryptedSamples) {
    const flacSignature = Buffer.from('fLaC')
    const metadataBody = flacMetadata.length > 4
      ? flacMetadata.subarray(4)
      : flacMetadata

    return Buffer.concat([flacSignature, metadataBody, ...decryptedSamples])
  }

  // 【M4A 回写】
  //  把解密后的 sample 字节原封不动塞回原 mdat 的 body 区（MP4 容器本身长度不变），
  //  然后把 stsd 里表示「加密编码」的 fourcc 'enca' 换成明文编码 'mp4a'，
  //  得到一个可被标准播放器识别的 M4A/MP4 文件。
  buildM4aFile(fileBuffer, decryptedSamples, mdat, stsd) {
    const output = Buffer.from(fileBuffer)
    let writePointer = mdat.offset + 8

    for (const sample of decryptedSamples) {
      sample.copy(output, writePointer)
      writePointer += sample.length
    }

    replaceEncaWithMp4a(output, stsd.offset, stsd.offset + stsd.size)
    return output
  }

  // 生成输出文件名：`标题 - 艺术家.ext`，并把 Windows 非法路径字符替换为下划线
  createFileName({ title, artist, extension }) {
    const safeTitle = sanitizeFilenamePart(title, 'track')
    const safeArtist = sanitizeFilenamePart(artist, 'unknown')
    return `${safeTitle} - ${safeArtist}${extension}`
  }

  // 【顶层 decrypt 入口】
  //  - 解析 MP4 atom 树：moov → trak/mdia/minf/stbl → stsd/stsz/stsc/stco/senc + mdat
  //  - 如果 senc 不在 moov 根下，再退回 stbl 内查找（不同 muxer 布局不同）
  //  - 如果 stsd 中找到了 fLaC metadata 说明是无损 FLAC，走 FLAC 重建；否则走 M4A 回写
  decrypt({ encryptedBuffer, spadeA, media = {} }) {
    if (!Buffer.isBuffer(encryptedBuffer) || encryptedBuffer.length === 0) {
      throw new Error('encryptedBuffer must be a non-empty Buffer.')
    }

    const key = this.resolveKey(spadeA)

    const moov = Mp4Box.findBox(encryptedBuffer, 'moov')
    if (moov.isEmpty()) {
      throw new Error("Decrypt failed: 'moov' atom not found.")
    }

    const trak = Mp4Box.findBox(encryptedBuffer, 'trak', moov.offset + 8, moov.offset + moov.size)
    const mdia = Mp4Box.findBox(encryptedBuffer, 'mdia', trak.offset + 8, trak.offset + trak.size)
    const minf = Mp4Box.findBox(encryptedBuffer, 'minf', mdia.offset + 8, mdia.offset + mdia.size)
    const stbl = Mp4Box.findBox(encryptedBuffer, 'stbl', minf.offset + 8, minf.offset + minf.size)
    const stsd = Mp4Box.findBox(encryptedBuffer, 'stsd', stbl.offset + 8, stbl.offset + stbl.size)
    const stsz = Mp4Box.findBox(encryptedBuffer, 'stsz', stbl.offset + 8, stbl.offset + stbl.size)
    const stsc = Mp4Box.findBox(encryptedBuffer, 'stsc', stbl.offset + 8, stbl.offset + stbl.size)
    const stco = Mp4Box.findBox(encryptedBuffer, 'stco', stbl.offset + 8, stbl.offset + stbl.size)

    let senc = Mp4Box.findBox(encryptedBuffer, 'senc', moov.offset + 8, moov.offset + moov.size)
    if (senc.isEmpty()) {
      senc = Mp4Box.findBox(encryptedBuffer, 'senc', stbl.offset + 8, stbl.offset + stbl.size)
    }

    if (senc.isEmpty()) {
      throw new Error("Decrypt failed: 'senc' atom not found.")
    }

    const mdat = Mp4Box.findBox(encryptedBuffer, 'mdat')
    if (mdat.isEmpty()) {
      throw new Error("Decrypt failed: 'mdat' atom not found.")
    }

    const flacMetadata = scanForFlacMetadata(stsd.data)
    const isFlac = flacMetadata.length > 0

    const sampleSizes = parseStsz(stsz.data)
    const stscEntries = parseStsc(stsc.data)
    const chunkCount = stco.data.readUInt32BE(4)
    const ivs = parseSenc(senc.data)

    if (sampleSizes.length !== ivs.length) {
      throw new Error(`Decrypt failed: sample count ${sampleSizes.length} does not match iv count ${ivs.length}.`)
    }

    const decryptedSamples = this.decryptSampleList({
      fileBuffer: encryptedBuffer,
      key,
      sampleSizes,
      ivs,
      mdatOffset: mdat.offset,
      stscEntries,
      chunkCount,
    })

    const outputBuffer = isFlac
      ? this.buildFlacFile(flacMetadata, decryptedSamples)
      : this.buildM4aFile(encryptedBuffer, decryptedSamples, mdat, stsd)

    const extension = isFlac ? '.flac' : '.m4a'

    return {
      buffer: outputBuffer,
      extension,
      fileName: this.createFileName({
        title: media.title,
        artist: media.artist,
        extension,
      }),
      meta: {
        isFlac,
        sampleCount: sampleSizes.length,
        chunkCount,
      },
    }
  }
}

module.exports = {
  TrackDecryptor,
}
