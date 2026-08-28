/**
 * 单首加密曲目下载接口（POST /api/track/download-encrypted）
 *  - 调用 track-download.downloadTrackMedia 完成「上游 fetch → 解密（MP4 senc → AES-128-CTR）→ FLAC 打标签 / M4A enca→mp4a」
 *  - 最终以附件形式返回音频 buffer，含 Content-Disposition 文件名。
 *
 * 原问题 / 修复：
 *  - Content-Disposition 只写了 filename="%E4%..."，不符合 RFC 6266 对非 ASCII 文件名的编码规范。
 *    实际上浏览器对 filename="百分号编码" 的支持不一致，会导致下载的中文歌曲名显示成 %XX%YY 乱码。
 *    修复：改为 RFC 5987 filename*=UTF-8''<percent-encoded> + filename="<ASCII fallback>" 双写方式，
 *    与批量下载 / 视频下载接口保持一致。
 */

const { fixed } = require('../config/qishui-auth')
const { downloadTrackMedia, getTrackV2Payload } = require('../utils/track-download')
const { logger } = require('../utils/logger')

const singleLogger = logger.child('SingleTrackDownload')

const request = {
  method: 'post',
  path: '/api/track/download-encrypted',
  query: {},
  headers: {
    'content-type': 'application/json',
  },
  body: {
    aid: fixed.aid,
    sessionid: 'string',
    track_id: 'string',
    quality: 'string',
  },
}

const response = {
  contentType: 'audio/mp4',
  fileName: '[track] - artist.m4a',
}

module.exports = {
  name: 'track-download-encrypted',
  method: request.method,
  path: request.path,
  request,
  response,
  handler: async (req, res) => {
    const startTime = Date.now()
    const { quality = '' } = req.body || {}
    const trackV2Payload = getTrackV2Payload(req.body)

    singleLogger.info(`Single track download request`, {
      track_id: trackV2Payload.track_id,
      quality,
    })

    if (!trackV2Payload.sessionid) {
      singleLogger.warn(`Missing sessionid`)
      res.status(400).json({
        message: 'sessionid is required',
      })
      return
    }

    if (!trackV2Payload.track_id) {
      singleLogger.warn(`Missing track_id`)
      res.status(400).json({
        message: 'track_id is required',
      })
      return
    }

    if (!quality) {
      singleLogger.warn(`Missing quality`)
      res.status(400).json({
        message: 'quality is required',
      })
      return
    }

    try {
      const result = await downloadTrackMedia({
        aid: trackV2Payload.aid,
        sessionid: trackV2Payload.sessionid,
        track_id: trackV2Payload.track_id,
        quality,
      })

      singleLogger.info(`Single track download ready to send`, {
        track_id: trackV2Payload.track_id,
        quality,
        fileName: result.fileName,
        size: result.buffer.length,
        totalMs: Date.now() - startTime,
      })

      res.setHeader('Content-Type', result.contentType)

      // 【RFC 5987 文件名双写】
      //  - filename*=UTF-8''...  现代浏览器 / wget / curl 优先取这个，支持完整中文
      //  - filename="..."        老浏览器 fallback，这里只取 ASCII 兼容部分（去掉中文不会丢关键信息）
      const encoded = encodeURIComponent(result.fileName)
      const asciiFallback = result.fileName
        .replace(/[^\x20-\x7E]/g, '_')
        .replace(/"/g, "'")
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encoded}; filename="${asciiFallback}"`,
      )
      res.setHeader('Content-Length', result.buffer.length)

      res.send(result.buffer)
    } catch (error) {
      singleLogger.error(`Single track download failed`, {
        track_id: trackV2Payload.track_id,
        quality,
        error: error?.message,
        status: error?.status || 500,
        totalMs: Date.now() - startTime,
        stack: error?.stack?.slice(0, 600),
      })
      res.status(error.status || 500).json({
        message: 'failed',
        error: error.message,
      })
    }
  },
}
