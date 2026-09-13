/**
 * 本地自测：不依赖外部服务，验证 FLAC 标签写入与 withTaskTimeout 清理逻辑。
 * 运行：node scripts/fix-selftest.js
 */
const path = require('path')
const {
  FlacMetadataWriter,
} = require('../server/utils/flac-metadata')

function assert(cond, message) {
  if (!cond) {
    throw new Error(message)
  }
}

function buildMinimalFlac() {
  // fLaC + STREAMINFO (type 0, last=false, 34 bytes) + VORBIS_COMMENT (type 4, last=true)
  const streamInfoData = Buffer.alloc(34, 0)
  // min/max block size
  streamInfoData.writeUInt16BE(4096, 0)
  streamInfoData.writeUInt16BE(4096, 2)
  // sample rate 44100 at bits 80-99
  streamInfoData.writeUIntBE(44100, 10, 3) // simplified placement; not used by tag writer
  // channels-1 / bps-1 / total samples
  streamInfoData[13] = (1 << 1) | ((16 - 1) >> 4)
  streamInfoData[14] = ((16 - 1) & 0x0f) << 4

  const streamInfoHeader = Buffer.alloc(4)
  streamInfoHeader[0] = 0x00 // not last, type 0
  streamInfoHeader.writeUIntBE(34, 1, 3)

  const oldComment = Buffer.from('vendor\0\0\0\0\0\0\0\0', 'utf8')
  const commentHeader = Buffer.alloc(4)
  commentHeader[0] = 0x80 | 4 // last, type 4
  commentHeader.writeUIntBE(oldComment.length, 1, 3)

  // 伪帧数据：以 0xFF 开头，模拟 FLAC frame sync
  const frames = Buffer.concat([Buffer.from([0xff, 0xf8, 0x00, 0x01, 0x02, 0x03]), Buffer.alloc(64, 0x11)])

  return Buffer.concat([
    Buffer.from('fLaC', 'latin1'),
    streamInfoHeader,
    streamInfoData,
    commentHeader,
    oldComment,
    frames,
  ])
}

function buildTinyJpeg() {
  // SOI + APP0/JFIF 最小头 + SOF0(8x8) + EOI，足够被 parseJpegSize 识别
  const sof = Buffer.from([
    0xff, 0xc0, 0x00, 0x0b,
    0x08, // precision
    0x00, 0x08, // height
    0x00, 0x08, // width
    0x01, // components
    0x01, 0x11, 0x00,
  ])
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'latin1'),
    Buffer.alloc(11, 0),
    sof,
    Buffer.from([0xff, 0xd9]),
  ])
}

async function testFlacTagWrite() {
  const writer = new FlacMetadataWriter()
  const input = buildMinimalFlac()
  const cover = buildTinyJpeg()

  const output = await writer.writeBufferTags({
    flacBuffer: input,
    metadata: {
      title: '测试歌曲',
      artist: ['歌手A', '歌手B'],
      album: '测试专辑',
      date: '2026-09-13',
    },
    coverBuffer: cover,
    coverMime: 'image/jpeg',
  })

  assert(Buffer.isBuffer(output) && output.length > 0, 'output must be a non-empty buffer')
  assert(output.subarray(0, 4).toString('latin1') === 'fLaC', 'output must start with fLaC')
  assert(output.length > input.length, 'output should grow after adding tags/cover')

  // 解析回来验证 isLast 与块结构
  const headerByte = output[4]
  assert((headerByte & 0x7f) === 0, 'first block must be STREAMINFO')
  assert((headerByte & 0x80) === 0, 'STREAMINFO must not be last')

  // 找到最后一个 metadata block，确认 isLast=1
  let offset = 4
  let lastIsLast = false
  let sawComment = false
  let sawPicture = false
  let guard = 0
  while (offset + 4 <= output.length && guard < 32) {
    guard += 1
    const b = output[offset]
    const isLast = (b & 0x80) !== 0
    const type = b & 0x7f
    const len = output.readUIntBE(offset + 1, 3)
    if (type === 4) sawComment = true
    if (type === 6) sawPicture = true
    lastIsLast = isLast
    offset += 4 + len
    if (isLast) break
  }

  assert(sawComment, 'must contain VORBIS_COMMENT')
  assert(sawPicture, 'must contain PICTURE')
  assert(lastIsLast, 'last metadata block must set isLast')
  assert(offset <= output.length, 'metadata must not overrun buffer')

  // 帧数据应原样保留
  const frameStart = offset
  assert(output[frameStart] === 0xff, 'frame data should start after metadata')

  console.log('[PASS] FLAC tag write / rebuild')
}

async function testFlacTagWriteNoCover() {
  const writer = new FlacMetadataWriter()
  const input = buildMinimalFlac()
  const output = await writer.writeBufferTags({
    flacBuffer: input,
    metadata: { title: 'NoCover' },
  })
  assert(output.subarray(0, 4).toString('latin1') === 'fLaC', 'output must start with fLaC')
  console.log('[PASS] FLAC tag write without cover')
}

async function testInvalidFlac() {
  const writer = new FlacMetadataWriter()
  let threw = false
  try {
    await writer.writeBufferTags({
      flacBuffer: Buffer.from('NOTAFLACFILE'),
      metadata: { title: 'x' },
    })
  } catch (err) {
    threw = true
    assert(/Invalid FLAC marker|too short/i.test(err.message), `unexpected error: ${err.message}`)
  }
  assert(threw, 'invalid flac must throw')
  console.log('[PASS] invalid FLAC rejected')
}

function testWithTaskTimeoutClears() {
  // 复刻 playlist-batch-download 中的 withTaskTimeout 逻辑
  const logs = []
  function withTaskTimeout(promise, taskDescription, timeoutMs) {
    let timeoutId = null
    let settled = false
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        if (settled) return
        settled = true
        logs.push(`timeout:${taskDescription}`)
        reject(new Error('timeout'))
      }, timeoutMs)
    })
    return Promise.race([
      Promise.resolve(promise).then(
        (value) => {
          settled = true
          if (timeoutId != null) clearTimeout(timeoutId)
          return value
        },
        (error) => {
          settled = true
          if (timeoutId != null) clearTimeout(timeoutId)
          throw error
        },
      ),
      timeoutPromise,
    ])
  }

  return (async () => {
    const result = await withTaskTimeout(Promise.resolve('ok'), 'fast-task', 50)
    assert(result === 'ok', 'fast task should resolve')
    await new Promise((r) => setTimeout(r, 80))
    assert(logs.length === 0, `timeout should not fire after settle, logs=${JSON.stringify(logs)}`)
    console.log('[PASS] withTaskTimeout clears timer after settle')
  })()
}

function testWithTaskTimeoutStillFires() {
  const logs = []
  function withTaskTimeout(promise, taskDescription, timeoutMs) {
    let timeoutId = null
    let settled = false
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        if (settled) return
        settled = true
        logs.push(`timeout:${taskDescription}`)
        reject(Object.assign(new Error('timeout'), { name: 'TaskTimeoutError' }))
      }, timeoutMs)
    })
    return Promise.race([
      Promise.resolve(promise).then(
        (value) => {
          settled = true
          if (timeoutId != null) clearTimeout(timeoutId)
          return value
        },
        (error) => {
          settled = true
          if (timeoutId != null) clearTimeout(timeoutId)
          throw error
        },
      ),
      timeoutPromise,
    ])
  }

  return (async () => {
    let timedOut = false
    try {
      await withTaskTimeout(new Promise(() => {}), 'slow-task', 30)
    } catch (err) {
      timedOut = err.name === 'TaskTimeoutError'
    }
    assert(timedOut, 'slow task should timeout')
    assert(logs.includes('timeout:slow-task'), 'timeout should be logged once')
    console.log('[PASS] withTaskTimeout still fires on real timeout')
  })()
}

async function main() {
  await testFlacTagWrite()
  await testFlacTagWriteNoCover()
  await testInvalidFlac()
  await testWithTaskTimeoutClears()
  await testWithTaskTimeoutStillFires()
  console.log('\nAll self-tests passed.')
}

main().catch((err) => {
  console.error('[FAIL]', err)
  process.exitCode = 1
})
