const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { fetchTrackPayload, downloadTrackMedia } = require('./track-download')
const { fixed } = require('../config/qishui-auth')
const { extractPlayMetaFromTrackPayload } = require('./recommend-utils')
const { logger } = require('./logger')

const playLogger = logger.child('PlayCache')

const MEMORY_TTL_MS = 15 * 60 * 1000
const MAX_MEMORY_ITEMS = 24
const memoryCache = new Map() // trackId -> { meta, buffer, contentType, expiresAt }
const tokenStore = new Map()
const TOKEN_TTL_MS = 15 * 60 * 1000

const DISK_DIR = path.join(os.tmpdir(), 'sodamusic-play-cache')

function ensureDiskDir() {
  if (!fs.existsSync(DISK_DIR)) {
    fs.mkdirSync(DISK_DIR, { recursive: true })
  }
}

function diskPathFor(trackId, contentType) {
  const ext = contentType?.includes('flac') ? '.flac' : contentType?.includes('mpeg') ? '.mp3' : '.m4a'
  return path.join(DISK_DIR, `${trackId}${ext}`)
}

function pruneMemory() {
  const now = Date.now()
  for (const [key, value] of memoryCache.entries()) {
    if (value.expiresAt <= now) memoryCache.delete(key)
  }
  while (memoryCache.size > MAX_MEMORY_ITEMS) {
    const oldest = memoryCache.keys().next().value
    if (!oldest) break
    memoryCache.delete(oldest)
  }
}

function cleanupTokens() {
  const now = Date.now()
  for (const [key, value] of tokenStore.entries()) {
    if (value.expiresAt <= now) tokenStore.delete(key)
  }
}

function issuePlayToken({ sessionid, trackId }) {
  cleanupTokens()
  const token = crypto.randomBytes(24).toString('hex')
  tokenStore.set(token, {
    sessionid,
    trackId: String(trackId),
    expiresAt: Date.now() + TOKEN_TTL_MS,
  })
  return token
}

function consumePlayToken(token) {
  cleanupTokens()
  const entry = tokenStore.get(String(token || ''))
  if (!entry || entry.expiresAt <= Date.now()) {
    return null
  }
  // 播放过程中可能多次请求同一 token，不在读取时删除
  return entry
}

function putMemory(trackId, entry) {
  pruneMemory()
  memoryCache.set(String(trackId), {
    ...entry,
    expiresAt: Date.now() + MEMORY_TTL_MS,
  })
}

function getMemory(trackId) {
  const entry = memoryCache.get(String(trackId))
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    memoryCache.delete(String(trackId))
    return null
  }
  return entry
}

function getDisk(trackId) {
  ensureDiskDir()
  const candidates = ['.m4a', '.flac', '.mp3'].map((ext) => path.join(DISK_DIR, `${trackId}${ext}`))
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue
    try {
      const stat = fs.statSync(file)
      if (Date.now() - stat.mtimeMs > MEMORY_TTL_MS) continue
      const buffer = fs.readFileSync(file)
      const contentType = file.endsWith('.flac')
        ? 'audio/flac'
        : file.endsWith('.mp3')
          ? 'audio/mpeg'
          : 'audio/mp4'
      return { buffer, contentType, fileName: path.basename(file) }
    } catch {
      // ignore
    }
  }
  return null
}

function putDisk(trackId, buffer, contentType) {
  try {
    ensureDiskDir()
    const file = diskPathFor(trackId, contentType)
    fs.writeFileSync(file, buffer)
  } catch (err) {
    playLogger.warn('recommend.cacheDiskWriteFailed', { track_id: trackId, error: err?.message })
  }
}

/**
 * 获取可播放音频 + 元数据。
 * - quality 默认 lowest：体积更小，起播更快
 * - skipFlacTags：播放路径跳过 FLAC 封面写入
 */
async function getPlayableAudio({ sessionid, trackId, quality = 'lowest', useCache = true }) {
  const id = String(trackId)

  if (useCache) {
    const mem = getMemory(id)
    if (mem?.buffer?.length) {
      playLogger.debug('recommend.cacheHitMemory', { track_id: id, size: mem.buffer.length })
      return mem
    }
    const disk = getDisk(id)
    if (disk?.buffer?.length) {
      playLogger.debug('recommend.cacheHitDisk', { track_id: id, size: disk.buffer.length })
      const entry = {
        meta: null,
        buffer: disk.buffer,
        contentType: disk.contentType,
        fileName: disk.fileName,
      }
      putMemory(id, entry)
      return entry
    }
  }

  const started = Date.now()
  let meta = null
  try {
    const payload = await fetchTrackPayload({
      aid: fixed.aid,
      sessionid,
      track_id: id,
    })
    meta = extractPlayMetaFromTrackPayload(payload)
  } catch (err) {
    playLogger.warn('recommend.metaFetchFailed', { track_id: id, error: err?.message })
  }

  const media = await downloadTrackMedia({
    aid: fixed.aid,
    sessionid,
    track_id: id,
    quality,
    skipFlacTags: true,
  })

  const entry = {
    meta,
    buffer: media.buffer,
    contentType: media.contentType,
    fileName: media.fileName,
  }

  putMemory(id, entry)
  putDisk(id, media.buffer, media.contentType)

  playLogger.info('recommend.playableReady', {
    track_id: id,
    quality,
    contentType: entry.contentType,
    size: entry.buffer.length,
    elapsedMs: Date.now() - started,
  })

  return entry
}

function clearPlayCache() {
  memoryCache.clear()
}

module.exports = {
  getPlayableAudio,
  clearPlayCache,
  issuePlayToken,
  consumePlayToken,
  DISK_DIR,
  TOKEN_TTL_MS,
}