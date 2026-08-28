const fs = require('fs')
const { pipeline } = require('stream/promises')
const { Readable } = require('stream')
const { fetchWithTimeout, LONG_TIMEOUT_MS } = require('./fetch-with-timeout')
const { logger } = require('./logger')

const videoLogger = logger.child('VideoDownload')

const PIPELINE_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes for large video files

async function fetchVideoStream(url) {
  const startTime = Date.now()
  videoLogger.debug(`Fetching video stream`, {
    urlPreview: String(url).slice(0, 120) + '...',
  })

  const upstream = await fetchWithTimeout(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Referer: 'https://music.douyin.com',
    },
  }, LONG_TIMEOUT_MS)

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '')
    videoLogger.error(`Video stream fetch failed`, {
      status: upstream.status,
      error: text?.slice(0, 300) || upstream.statusText,
      elapsedMs: Date.now() - startTime,
    })
    const error = new Error(text || upstream.statusText || `下载视频失败: ${upstream.status}`)
    error.status = upstream.status || 502
    throw error
  }

  videoLogger.debug(`Video stream ready`, {
    status: upstream.status,
    contentLength: upstream.headers.get('content-length') || 'unknown',
    contentType: upstream.headers.get('content-type') || 'unknown',
    elapsedMs: Date.now() - startTime,
  })

  return upstream
}

async function downloadVideoToFile(url, outputPath) {
  const overallStart = Date.now()
  videoLogger.info(`Downloading video to file`, {
    outputPath,
    urlPreview: String(url).slice(0, 120) + '...',
  })

  const upstream = await fetchVideoStream(url)

  const downloadStart = Date.now()
  const pipelinePromise = pipeline(
    Readable.fromWeb(upstream.body),
    fs.createWriteStream(outputPath),
  )

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      const err = new Error(`Video download pipeline timed out after ${PIPELINE_TIMEOUT_MS}ms`)
      err.name = 'PipelineTimeoutError'
      reject(err)
    }, PIPELINE_TIMEOUT_MS)
  })

  try {
    await Promise.race([pipelinePromise, timeoutPromise])
  } catch (pipeErr) {
    videoLogger.error(`Video download pipeline failed`, {
      outputPath,
      error: pipeErr?.message,
      errorName: pipeErr?.name,
      elapsedMs: Date.now() - downloadStart,
      stack: pipeErr?.stack?.slice(0, 400),
    })
    throw pipeErr
  }

  let fileSize = 0
  try {
    const stat = await fs.promises.stat(outputPath)
    fileSize = stat.size
  } catch {}

  const result = {
    contentType: upstream.headers.get('content-type') || 'application/octet-stream',
    contentLength: upstream.headers.get('content-length') || '',
    fileSize,
  }

  videoLogger.info(`Video download complete`, {
    outputPath,
    fileSize,
    downloadMs: Date.now() - downloadStart,
    totalElapsedMs: Date.now() - overallStart,
  })

  return result
}

module.exports = {
  fetchVideoStream,
  downloadVideoToFile,
}
