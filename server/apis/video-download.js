const path = require('path')
const { fetchVideoStream } = require('../utils/video-download')
const { logger } = require('../utils/logger')

const videoApiLogger = logger.child('VideoDownloadApi')

const STREAM_WRITE_TIMEOUT_MS = 12 * 60 * 1000 // 12 minutes for streaming
const CHUNK_IDLE_TIMEOUT_MS = 60 * 1000 // 60s between chunks

const request = {
  method: 'post',
  path: '/api/video/download',
  headers: {
    'content-type': 'application/json; charset=utf-8',
  },
  body: {
    url: 'string',
    file_name: 'string?',
  },
}

function sanitizeFilename(fileName) {
  const baseName = String(fileName || 'video.mp4')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .trim()

  if (!baseName) {
    return 'video.mp4'
  }

  return baseName
}

module.exports = {
  name: 'video-download',
  method: request.method,
  path: request.path,
  request,
  response: {},
  handler: async (req, res) => {
    const startTime = Date.now()
    const { url, file_name } = req.body || {}

    videoApiLogger.info(`Video download API request`, {
      urlPreview: String(url).slice(0, 120) + '...',
      fileName: file_name || '(default)',
    })

    if (!url) {
      videoApiLogger.warn(`Missing url`)
      res.status(400).json({
        message: 'url is required',
      })
      return
    }

    try {
      const upstream = await fetchVideoStream(url)
      const upstreamType = upstream.headers.get('content-type') || 'application/octet-stream'
      const upstreamLength = upstream.headers.get('content-length')
      const fallbackExtension = (() => {
        try {
          return path.extname(new URL(url).pathname) || '.mp4'
        } catch {
          return '.mp4'
        }
      })()
      const safeName = sanitizeFilename(file_name || `video${fallbackExtension}`)

      videoApiLogger.debug(`Video stream headers set`, {
        contentType: upstreamType,
        contentLength: upstreamLength,
        fileName: safeName,
      })

      res.setHeader('Content-Type', upstreamType)
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`)

      if (upstreamLength) {
        res.setHeader('Content-Length', upstreamLength)
      }

      const reader = upstream.body.getReader()
      let bytes = 0
      let chunks = 0
      let lastChunkAt = Date.now()

      const overallTimeoutId = setTimeout(() => {
        videoApiLogger.error(`Video stream write overall timeout`, {
          bytes,
          chunks,
          elapsedMs: Date.now() - startTime,
        })
        try { reader.releaseLock() } catch {}
        const err = new Error(`Video streaming timed out after ${STREAM_WRITE_TIMEOUT_MS}ms`)
        err.name = 'VideoStreamTimeoutError'
        if (!res.headersSent) {
          res.status(504).json({ message: 'timeout', error: err.message })
        } else {
          res.destroy(err)
        }
      }, STREAM_WRITE_TIMEOUT_MS)

      const idleCheckId = setInterval(() => {
        const since = Date.now() - lastChunkAt
        if (since > CHUNK_IDLE_TIMEOUT_MS && bytes > 0) {
          videoApiLogger.warn(`Video stream idle too long between chunks`, {
            idleMs: since,
            bytes,
            chunks,
          })
        }
      }, 15000)

      try {
        while (true) {
          const readPromise = reader.read()
          const idleTimeoutPromise = new Promise((_, reject) => {
            const t = setTimeout(() => {
              const err = new Error(`Video stream chunk read idle timeout after ${CHUNK_IDLE_TIMEOUT_MS}ms`)
              err.name = 'VideoStreamIdleTimeoutError'
              reject(err)
            }, CHUNK_IDLE_TIMEOUT_MS)
            readPromise.finally(() => clearTimeout(t))
          })

          const { done, value } = await Promise.race([readPromise, idleTimeoutPromise])
          lastChunkAt = Date.now()

          if (done) {
            break
          }

          const buf = Buffer.from(value)
          bytes += buf.length
          chunks += 1
          res.write(buf)

          if (chunks % 50 === 0) {
            videoApiLogger.debug(`Video streaming progress`, {
              chunks,
              bytes,
              elapsedMs: Date.now() - startTime,
            })
          }
        }

        res.end()
        clearTimeout(overallTimeoutId)
        clearInterval(idleCheckId)

        videoApiLogger.info(`Video download stream complete`, {
          bytes,
          chunks,
          fileName: safeName,
          totalElapsedMs: Date.now() - startTime,
        })
      } catch (streamErr) {
        clearTimeout(overallTimeoutId)
        clearInterval(idleCheckId)
        try { reader.releaseLock() } catch {}
        throw streamErr
      }
    } catch (error) {
      videoApiLogger.error(`Video download API failed`, {
        error: error?.message,
        errorName: error?.name,
        status: error?.status || 500,
        totalElapsedMs: Date.now() - startTime,
        stack: error?.stack?.slice(0, 600),
      })
      if (!res.headersSent) {
        res.status(error.status || 500).json({
          message: 'failed to download video',
          error: error.message,
        })
      } else {
        res.destroy(error)
      }
    }
  },
}
