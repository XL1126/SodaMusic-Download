/*
 * 视频信息查询代理 API
 * 功能：转发到汽水音乐后端 /luna/pc/video_v2，获取视频元信息和下载 URL
 *
 * 修复：
 *  1) 增加 fetch 超时 30s，防止后端无响应时永久挂起
 *  2) 增加日志埋点（请求入口 / 响应耗时 / 错误详情）
 *  3) 非 JSON 响应兜底：先 text() 再解析，遇到 HTML/纯文本错误不直接抛 500
 */
const { endpoints, fixed } = require('../config/qishui-auth')
const { buildUrl } = require('../utils/http')
const { fetchWithTimeout } = require('../utils/fetch-with-timeout')
const { logger } = require('../utils/logger')

const apiLogger = logger.child('VideoV2Api')

const request = {
  method: 'post',
  path: '/api/video/v2',
  query: {
    aid: fixed.aid,
  },
  headers: {
    'content-type': 'application/json; charset=utf-8',
  },
  body: {
    aid: fixed.aid,
    sessionid: 'string',
    video_id: 'string',
    type: 'ugc_video',
    scene_name: 'library',
    queue_type: 'favorite_track_playlist',
  },
}

const response = {
  video: {
    video_id: 'string',
    title: 'string',
  },
}

module.exports = {
  name: 'video-v2',
  method: request.method,
  path: request.path,
  request,
  response,
  handler: async (req, res) => {
    const startTime = Date.now()
    const {
      aid = fixed.aid,
      sessionid,
      video_id,
      type = 'ugc_video',
      scene_name = 'library',
      queue_type = 'favorite_track_playlist',
    } = req.body || {}

    apiLogger.debug(`VideoV2 request`, { video_id, type, scene_name, queue_type })

    if (!sessionid) {
      apiLogger.warn(`VideoV2 missing sessionid`)
      res.status(400).json({
        message: 'sessionid is required',
      })
      return
    }

    if (!video_id) {
      apiLogger.warn(`VideoV2 missing video_id`)
      res.status(400).json({
        message: 'video_id is required',
      })
      return
    }

    try {
      const target = buildUrl(endpoints.videoV2, { aid })
      const upstream = await fetchWithTimeout(target, {
        method: 'POST',
        headers: {
          Cookie: `sessionid=${sessionid};`,
          'Content-Type': request.headers['content-type'],
          'Accept-Encoding': 'gzip, deflate',
        },
        body: JSON.stringify({
          video_id,
          type,
          scene_name,
          queue_type,
        }),
      }, 30 * 1000)

      // —— 健壮响应解析：先读取原始文本再判断是不是合法 JSON
      const rawText = await upstream.text()
      let payload
      try {
        payload = rawText ? JSON.parse(rawText) : {}
      } catch (parseErr) {
        apiLogger.warn(`VideoV2 upstream non-JSON response`, {
          video_id,
          status: upstream.status,
          contentPreview: rawText.slice(0, 200),
        })
        payload = {
          status_code: upstream.status,
          message: `Upstream returned non-JSON content (HTTP ${upstream.status})`,
          _raw: rawText.slice(0, 500),
        }
      }

      apiLogger.debug(`VideoV2 response`, {
        video_id,
        status: upstream.status,
        statusCode: payload?.status_code,
        videoTitle: payload?.video?.title ? String(payload.video.title).slice(0, 60) : '',
        elapsedMs: Date.now() - startTime,
      })

      res.status(upstream.status).json(payload)
    } catch (error) {
      apiLogger.error(`VideoV2 failed`, {
        video_id,
        error: error?.message,
        errorName: error?.name,
        status: error?.status || 500,
        elapsedMs: Date.now() - startTime,
        stack: error?.stack?.slice(0, 500),
      })
      res.status(error.status || 500).json({
        message: 'failed',
        error: error.message,
      })
    }
  },
}
