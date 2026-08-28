const path = require('path')
const { VideoAudioExtractor } = require('../utils/video-audio-extractor')
const { logger } = require('../utils/logger')

const audioApiLogger = logger.child('VideoDownloadAudioApi')

const request = {
  method: 'post',
  path: '/api/video/download-audio',
  headers: {
    'content-type': 'application/json; charset=utf-8',
  },
  body: {
    url: 'string',
    file_name: 'string?',
  },
}

function sanitizeFilename(fileName) {
  const baseName = String(fileName || 'video-audio.mp3')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .trim()

  if (!baseName) {
    return 'video-audio.mp3'
  }

  return baseName
}

module.exports = {
  name: 'video-download-audio',
  method: request.method,
  path: request.path,
  request,
  response: {},
  handler: async (req, res) => {
    const startTime = Date.now()
    const { url, file_name } = req.body || {}

    audioApiLogger.info(`Video->audio download API request`, {
      urlPreview: String(url).slice(0, 120) + '...',
      fileName: file_name || '(default)',
    })

    if (!url) {
      audioApiLogger.warn(`Missing url`)
      res.status(400).json({
        message: 'url is required',
      })
      return
    }

    try {
      const extractor = new VideoAudioExtractor()
      const result = await extractor.extractMp3FromVideoUrl(url)

      const defaultBaseName = (() => {
        try {
          const u = new URL(url)
          return path.basename(u.pathname, path.extname(u.pathname)) || 'video-audio'
        } catch {
          return 'video-audio'
        }
      })()
      const safeName = sanitizeFilename(file_name || `${defaultBaseName}${result.outputExtension}`)

      audioApiLogger.info(`Video->audio ready to send`, {
        fileName: safeName,
        outputSize: result.buffer.length,
        totalElapsedMs: Date.now() - startTime,
      })

      res.setHeader('Content-Type', result.contentType)
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`)
      res.setHeader('Content-Length', result.buffer.length)

      res.send(result.buffer)
    } catch (error) {
      audioApiLogger.error(`Video->audio API failed`, {
        error: error?.message,
        errorName: error?.name,
        totalElapsedMs: Date.now() - startTime,
        stack: error?.stack?.slice(0, 600),
      })
      res.status(error.status || 500).json({
        message: 'failed',
        error: error.message,
      })
    }
  },
}
