const fs = require('fs')
const os = require('os')
const path = require('path')
const ffmpeg = require('fluent-ffmpeg')
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg')
const { downloadVideoToFile } = require('./video-download')
const { logger } = require('./logger')

const extractLogger = logger.child('VideoAudioExtractor')

ffmpeg.setFfmpegPath(ffmpegInstaller.path)
extractLogger.debug(`FFmpeg path configured`, { ffmpegPath: ffmpegInstaller.path })

function sanitizeFilenamePart(value, fallback = 'video-audio') {
  const normalized = String(value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .trim()

  return normalized || fallback
}

async function safeUnlink(filePath) {
  if (!filePath) {
    return
  }

  try {
    await fs.promises.unlink(filePath)
  } catch {
    // ignore cleanup errors
  }
}

const FFMPEG_TIMEOUT_MS = 8 * 60 * 1000 // 8 minutes for ffmpeg transcoding

class VideoAudioExtractor {
  extractAudioFromVideo(videoPath, audioPath, kbps = 320) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now()
      let timeoutId = null
      let ffmpegCommand = null
      let settled = false

      timeoutId = setTimeout(() => {
        if (settled) {
          return
        }
        settled = true
        extractLogger.error(`FFmpeg transcoding timed out`, {
          videoPath,
          audioPath,
          kbps,
          timeoutMs: FFMPEG_TIMEOUT_MS,
          elapsedMs: Date.now() - startTime,
        })
        try {
          if (ffmpegCommand && typeof ffmpegCommand.kill === 'function') {
            ffmpegCommand.kill('SIGKILL')
          }
        } catch (killErr) {
          extractLogger.warn(`Failed to kill ffmpeg process`, { error: killErr?.message })
        }
        const err = new Error(`FFmpeg transcoding timed out after ${FFMPEG_TIMEOUT_MS}ms`)
        err.name = 'FFmpegTimeoutError'
        reject(err)
      }, FFMPEG_TIMEOUT_MS)

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }
      }

      ffmpegCommand = ffmpeg(videoPath)
        .noVideo()
        .audioCodec('libmp3lame')
        .audioBitrate(`${kbps}k`)
        .format('mp3')
        .on('start', (cmdLine) => {
          extractLogger.debug(`FFmpeg started`, {
            videoPath,
            kbps,
            cmdLine: String(cmdLine).slice(0, 300),
          })
        })
        .on('progress', (progress) => {
          extractLogger.debug(`FFmpeg progress`, {
            videoPath: path.basename(videoPath),
            percent: progress?.percent,
            currentFps: progress?.currentFps,
            targetSize: progress?.targetSize,
            timemark: progress?.timemark,
          })
        })
        .on('end', () => {
          if (settled) {
            return
          }
          settled = true
          cleanup()
          extractLogger.info(`FFmpeg transcoding complete`, {
            videoPath,
            audioPath,
            kbps,
            elapsedMs: Date.now() - startTime,
          })
          resolve()
        })
        .on('error', (error) => {
          if (settled) {
            return
          }
          settled = true
          cleanup()
          extractLogger.error(`FFmpeg transcoding failed`, {
            videoPath,
            audioPath,
            error: error?.message,
            elapsedMs: Date.now() - startTime,
            stack: error?.stack?.slice(0, 400),
          })
          reject(error)
        })
        .save(audioPath)
    })
  }

  async extractMp3FromVideoUrl(url, options = {}) {
    const overallStart = Date.now()
    const baseName = sanitizeFilenamePart(
      options.baseName || (() => {
        try {
          const parsedUrl = new URL(url)
          return path.basename(parsedUrl.pathname, path.extname(parsedUrl.pathname))
        } catch {
          return 'video-audio'
        }
      })(),
    )
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'popmusic-video-audio-'))
    const videoPath = path.join(tempDir, `${baseName}.mp4`)
    const audioPath = path.join(tempDir, `${baseName}.mp3`)

    extractLogger.info(`Starting video->audio extraction`, {
      baseName,
      tempDir,
      urlPreview: String(url).slice(0, 120) + '...',
      kbps: options.kbps || 320,
    })

    try {
      await downloadVideoToFile(url, videoPath)

      const transcodeStart = Date.now()
      await this.extractAudioFromVideo(videoPath, audioPath, options.kbps || 320)

      let fileSize = 0
      try {
        const stat = await fs.promises.stat(audioPath)
        fileSize = stat.size
      } catch {}

      const buffer = await fs.promises.readFile(audioPath)

      extractLogger.info(`Video->audio extraction complete`, {
        baseName,
        outputSize: buffer.length,
        fileSize,
        transcodeMs: Date.now() - transcodeStart,
        totalElapsedMs: Date.now() - overallStart,
      })

      return {
        buffer,
        outputExtension: '.mp3',
        contentType: 'audio/mpeg',
      }
    } catch (err) {
      extractLogger.error(`Video->audio extraction failed`, {
        baseName,
        error: err?.message,
        errorName: err?.name,
        totalElapsedMs: Date.now() - overallStart,
        stack: err?.stack?.slice(0, 500),
      })
      throw err
    } finally {
      await safeUnlink(videoPath)
      await safeUnlink(audioPath)
      try {
        await fs.promises.rm(tempDir, { recursive: true, force: true })
        extractLogger.debug(`Temp dir cleaned up`, { tempDir })
      } catch (cleanupErr) {
        extractLogger.warn(`Failed to remove temp dir`, {
          tempDir,
          error: cleanupErr?.message,
        })
      }
    }
  }
}

module.exports = {
  VideoAudioExtractor,
}
