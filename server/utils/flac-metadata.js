const { fetchWithTimeout, DEFAULT_TIMEOUT_MS } = require('./fetch-with-timeout')
const { logger } = require('./logger')

const flacLogger = logger.child('FlacMetadataWriter')

const FLAC_STREAM_MARKER = 'fLaC'
const BLOCK_TYPE_STREAMINFO = 0
const BLOCK_TYPE_PADDING = 1
const BLOCK_TYPE_VORBIS_COMMENT = 4
const BLOCK_TYPE_PICTURE = 6
const VORBIS_VENDOR = 'SodaMusic-Download'

function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return 'image/jpeg'
  }
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png'
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return 'image/gif'
  }
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return 'image/bmp'
  }
  if (
    buffer[0] === 0x52
    && buffer[1] === 0x49
    && buffer[2] === 0x46
    && buffer[3] === 0x46
    && buffer[8] === 0x57
    && buffer[9] === 0x45
    && buffer[10] === 0x42
    && buffer[11] === 0x50
  ) {
    return 'image/webp'
  }
  return 'image/jpeg'
}

function parseJpegSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null
  }
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = buffer[offset + 1]
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const segmentLength = buffer.readUInt16BE(offset + 2)
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof && offset + 9 < buffer.length) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      }
    }
    if (segmentLength < 2) {
      return null
    }
    offset += 2 + segmentLength
  }
  return null
}

function parsePngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) {
    return null
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  }
}

function parseImageSize(buffer, mime) {
  if (mime === 'image/png') {
    return parsePngSize(buffer)
  }
  return parseJpegSize(buffer) || parsePngSize(buffer)
}

function buildVorbisCommentBlock(tagMap) {
  const vendorBuffer = Buffer.from(VORBIS_VENDOR, 'utf8')
  const comments = []

  for (const [key, value] of Object.entries(tagMap)) {
    const values = Array.isArray(value) ? value : [value]
    for (const single of values) {
      const text = String(single ?? '').trim()
      if (!text) {
        continue
      }
      comments.push(Buffer.from(`${key.toUpperCase()}=${text}`, 'utf8'))
    }
  }

  const parts = []
  const vendorLength = Buffer.alloc(4)
  vendorLength.writeUInt32LE(vendorBuffer.length, 0)
  parts.push(vendorLength, vendorBuffer)

  const countBuffer = Buffer.alloc(4)
  countBuffer.writeUInt32LE(comments.length, 0)
  parts.push(countBuffer)

  for (const comment of comments) {
    const lengthBuffer = Buffer.alloc(4)
    lengthBuffer.writeUInt32LE(comment.length, 0)
    parts.push(lengthBuffer, comment)
  }

  return Buffer.concat(parts)
}

function buildPictureBlock({ buffer, mime }) {
  const resolvedMime = mime || detectImageMime(buffer)
  const size = parseImageSize(buffer, resolvedMime) || { width: 0, height: 0 }
  const mimeBuffer = Buffer.from(resolvedMime, 'ascii')
  const descriptionBuffer = Buffer.alloc(0)

  const parts = []
  const pictureType = Buffer.alloc(4)
  pictureType.writeUInt32BE(3, 0)
  parts.push(pictureType)

  const mimeLength = Buffer.alloc(4)
  mimeLength.writeUInt32BE(mimeBuffer.length, 0)
  parts.push(mimeLength, mimeBuffer)

  const descLength = Buffer.alloc(4)
  descLength.writeUInt32BE(descriptionBuffer.length, 0)
  parts.push(descLength, descriptionBuffer)

  const widthBuf = Buffer.alloc(4)
  widthBuf.writeUInt32BE(size.width || 0, 0)
  parts.push(widthBuf)

  const heightBuf = Buffer.alloc(4)
  heightBuf.writeUInt32BE(size.height || 0, 0)
  parts.push(heightBuf)

  const depthBuf = Buffer.alloc(4)
  depthBuf.writeUInt32BE(24, 0)
  parts.push(depthBuf)

  const colorsBuf = Buffer.alloc(4)
  colorsBuf.writeUInt32BE(0, 0)
  parts.push(colorsBuf)

  const dataLength = Buffer.alloc(4)
  dataLength.writeUInt32BE(buffer.length, 0)
  parts.push(dataLength, buffer)

  return Buffer.concat(parts)
}

/**
 * 有边界检查的 FLAC 元数据块解析。
 * 不使用 flac-tagger：其 MetadataBlockHeader.isLast 位判断写错（===1 恒为 false），
 * 且 parseBlock 在 buffer 耗尽时直接 readUInt8 → ERR_BUFFER_OUT_OF_BOUNDS。
 */
function parseFlacMetadataBlocks(flacBuffer) {
  if (!Buffer.isBuffer(flacBuffer) || flacBuffer.length < 8) {
    throw new Error('FLAC buffer too short')
  }

  const marker = flacBuffer.subarray(0, 4).toString('latin1')
  if (marker !== FLAC_STREAM_MARKER) {
    throw new Error(`Invalid FLAC marker: ${JSON.stringify(marker)}`)
  }

  const blocks = []
  let offset = 4

  while (offset + 4 <= flacBuffer.length) {
    const headerByte = flacBuffer[offset]
    const isLast = (headerByte & 0x80) !== 0
    const type = headerByte & 0x7f
    const dataLength = flacBuffer.readUIntBE(offset + 1, 3)
    const dataStart = offset + 4
    const dataEnd = dataStart + dataLength

    if (dataEnd > flacBuffer.length) {
      throw new Error(
        `FLAC metadata block overruns buffer: type=${type} dataLength=${dataLength} available=${flacBuffer.length - dataStart}`,
      )
    }

    blocks.push({
      type,
      isLast,
      data: flacBuffer.subarray(dataStart, dataEnd),
      raw: flacBuffer.subarray(offset, dataEnd),
    })

    offset = dataEnd
    if (isLast) {
      break
    }
  }

  if (blocks.length === 0) {
    throw new Error('No FLAC metadata blocks found')
  }
  if (blocks[0].type !== BLOCK_TYPE_STREAMINFO) {
    throw new Error(`First FLAC metadata block must be STREAMINFO, got type=${blocks[0].type}`)
  }

  return {
    blocks,
    frameData: flacBuffer.subarray(offset),
  }
}

function encodeMetadataBlock(type, data, isLast) {
  const header = Buffer.alloc(4)
  header[0] = (isLast ? 0x80 : 0x00) | (type & 0x7f)
  header.writeUIntBE(data.length, 1, 3)
  return Buffer.concat([header, data])
}

function rebuildFlacWithTags({ flacBuffer, tagMap, coverBuffer, coverMime }) {
  const { blocks, frameData } = parseFlacMetadataBlocks(flacBuffer)

  const kept = blocks.filter((block) => (
    block.type !== BLOCK_TYPE_PADDING
    && block.type !== BLOCK_TYPE_VORBIS_COMMENT
    && block.type !== BLOCK_TYPE_PICTURE
  ))

  const rebuilt = []
  for (const block of kept) {
    rebuilt.push({ type: block.type, data: block.data })
  }

  rebuilt.push({
    type: BLOCK_TYPE_VORBIS_COMMENT,
    data: buildVorbisCommentBlock(tagMap),
  })

  if (Buffer.isBuffer(coverBuffer) && coverBuffer.length > 0) {
    rebuilt.push({
      type: BLOCK_TYPE_PICTURE,
      data: buildPictureBlock({
        buffer: coverBuffer,
        mime: coverMime,
      }),
    })
  }

  const encoded = rebuilt.map((block, index) => (
    encodeMetadataBlock(block.type, block.data, index === rebuilt.length - 1)
  ))

  return Buffer.concat([
    Buffer.from(FLAC_STREAM_MARKER, 'latin1'),
    ...encoded,
    frameData,
  ])
}

class FlacMetadataWriter {
  toTagValue(value) {
    if (Array.isArray(value)) {
      const list = value
        .map((item) => String(item || '').trim())
        .filter(Boolean)

      return list.length > 0 ? list : null
    }

    const normalized = String(value || '').trim()
    return normalized ? normalized : null
  }

  buildTagMap(metadata = {}) {
    const tagMap = {}

    const entries = {
      TITLE: metadata.title,
      ARTIST: metadata.artist,
      ALBUM: metadata.album,
      ALBUMARTIST: metadata.albumArtist,
      DATE: metadata.date,
      YEAR: metadata.year,
      GENRE: metadata.genre,
      COMPOSER: metadata.composer,
      LYRICIST: metadata.lyricist,
      COMMENT: metadata.comment,
      TRACKNUMBER: metadata.trackNumber,
      DISCNUMBER: metadata.discNumber,
    }

    for (const [key, value] of Object.entries(entries)) {
      const normalizedValue = this.toTagValue(value)

      if (normalizedValue) {
        tagMap[key] = normalizedValue
      }
    }

    flacLogger.debug(`Built FLAC tag map`, {
      tags: Object.keys(tagMap),
      title: metadata?.title ? String(metadata.title).slice(0, 80) : '',
    })

    return tagMap
  }

  async writeBufferTags({ flacBuffer, metadata = {}, coverBuffer = null, coverMime = null }) {
    if (!Buffer.isBuffer(flacBuffer) || flacBuffer.length === 0) {
      throw new Error('flacBuffer must be a non-empty Buffer.')
    }

    const startTime = Date.now()
    flacLogger.info('flac.writeStart', {
      inputSize: flacBuffer.length,
      hasCover: Boolean(coverBuffer && coverBuffer.length > 0),
      coverSize: coverBuffer?.length || 0,
    })

    try {
      const tagMap = this.buildTagMap(metadata)
      const resultBuffer = rebuildFlacWithTags({
        flacBuffer,
        tagMap,
        coverBuffer,
        coverMime,
      })

      flacLogger.info('flac.writeComplete', {
        outputSize: resultBuffer.length,
        totalMs: Date.now() - startTime,
      })
      return resultBuffer
    } catch (err) {
      flacLogger.error('flac.writeFailed', {
        error: err?.message,
        errorName: err?.name,
        totalMs: Date.now() - startTime,
        stack: err?.stack?.slice(0, 500),
      })
      throw err
    }
  }

  async fetchCoverBuffer(imageUrl) {
    if (!imageUrl) {
      return null
    }

    const startTime = Date.now()
    flacLogger.debug(`Fetching FLAC cover`, {
      urlPreview: String(imageUrl).slice(0, 120) + '...',
    })

    const response = await fetchWithTimeout(imageUrl, {}, DEFAULT_TIMEOUT_MS)
    if (!response.ok) {
      flacLogger.warn('flac.coverFetchFailed', {
        status: response.status,
        elapsedMs: Date.now() - startTime,
      })
      throw new Error(`Failed to fetch FLAC cover: ${response.status}`)
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    const mime = response.headers.get('content-type') || undefined

    flacLogger.debug(`Cover fetched`, {
      size: buffer.length,
      mime,
      elapsedMs: Date.now() - startTime,
    })

    return {
      buffer,
      mime,
    }
  }
}

module.exports = {
  FlacMetadataWriter,
}
