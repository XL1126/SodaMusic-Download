/*
 * 单首乐曲信息查询代理 API
 * 功能：将前端请求转发到汽水音乐后端 /luna/pc/track_v2 接口，
 *       获取 track 元数据以及包含下载 URL 的 track_player.video_model
 *
 * 修复：
 *  1) 增加 fetch 超时（30s），避免后端无响应时 Node 连接永久悬挂
 *  2) 增加详细日志（入口/参数校验/转发耗时/错误详情）
 *  3) 增加响应解析兜底：当 upstream 返回非 JSON 时使用 text() 作为错误详情，
 *     避免 upstream.json() 直接抛错导致只看到 "failed"
 */
const { endpoints, fixed, getPcQuery } = require('../config/qishui-auth')
const { buildUrl } = require('../utils/http')
const { fetchWithTimeout } = require('../utils/fetch-with-timeout')
const { initSigner, generateSignatureHeaders } = require('../utils/bdms-signer')
const { logger } = require('../utils/logger')

const apiLogger = logger.child('TrackV2Api')

const request = {
  method: 'post',
  path: '/api/track/v2',
  query: {
    aid: fixed.aid,
  },
  headers: {
    'content-type': 'application/json; charset=utf-8',
  },
  body: {
    aid: fixed.aid,
    sessionid: 'string',
    track_id: 'string',
    media_type: 'track',
    queue_type: 'search_one_track',
    scene_name: 'search',
  },
}

const response = {
  track: {
    id: 'string',
    name: 'string',
  },
  track_player: {
    video_model: 'string',
  },
}

module.exports = {
  name: 'track-v2',
  method: request.method,
  path: request.path,
  request,
  response,
  handler: async (req, res) => {
    const startTime = Date.now()
    const {
      aid = fixed.aid,
      sessionid,
      track_id,
      media_type = 'track',
      queue_type = 'search_one_track',
      scene_name = 'search',
    } = req.body || {}

    apiLogger.debug(`TrackV2 request`, { track_id, media_type, queue_type, scene_name })

    if (!sessionid) {
      apiLogger.warn(`TrackV2 missing sessionid`)
      res.status(400).json({
        message: 'sessionid is required',
      })
      return
    }

    if (!track_id) {
      apiLogger.warn(`TrackV2 missing track_id`)
      res.status(400).json({
        message: 'track_id is required',
      })
      return
    }

    try {
      const target = buildUrl(endpoints.trackV2, getPcQuery({ aid }))

      // 初始化 BDMS 签名模块并生成签名头
      initSigner('2117006317868281')
      const sigHeaders = generateSignatureHeaders(target, {
        'content-type': request.headers['content-type'],
        'user-agent': 'LunaPC/3.7.0(452316191)',
        'accept-encoding': 'gzip, deflate',
      })

      const upstream = await fetchWithTimeout(target, {
        method: 'POST',
        headers: {
          Cookie: `sessionid=${sessionid};`,
          'Content-Type': request.headers['content-type'],
          'Accept-Encoding': 'gzip, deflate',
          'User-Agent': 'LunaPC/3.7.0(452316191)',
          ...sigHeaders,
        },
        body: JSON.stringify({
          track_id,
          media_type,
          queue_type,
          scene_name,
        }),
      }, 30 * 1000)

      // —— 健壮响应解析：先取原始内容，再判断是否能按 JSON 解析
      const rawText = await upstream.text()
      let payload
      try {
        payload = rawText ? JSON.parse(rawText) : {}
      } catch (parseErr) {
        apiLogger.warn(`TrackV2 upstream non-JSON response`, {
          track_id,
          status: upstream.status,
          contentPreview: rawText.slice(0, 200),
        })
        payload = {
          status_code: upstream.status,
          message: `Upstream returned non-JSON content (HTTP ${upstream.status})`,
          _raw: rawText.slice(0, 500),
        }
      }

      // 【与 track-download.js 保持一致的多路径兼容判断】
      //  汽水音乐可能改字段名（video_model→audio_model）或外层结构（track_player→audio_player、加 data 包裹），
      //  单路径判断会造成 hasVideoModel 永远 false → 误导排查。
      const hasVideoModel = Boolean(
        payload?.track_player?.video_model
        || payload?.track_player?.audio_model
        || payload?.track?.video_model
        || payload?.track?.audio_model
        || payload?.data?.track_player?.video_model
        || payload?.data?.tracks?.[0]?.video_model,
      )
      apiLogger.debug(`TrackV2 response`, {
        track_id,
        status: upstream.status,
        statusCode: payload?.status_code,
        trackName: payload?.track?.name ? String(payload.track.name).slice(0, 60) : '',
        hasVideoModel,
        trackPlayerKeys: payload?.track_player ? Object.keys(payload.track_player).slice(0, 20) : null,
        topKeys: Object.keys(payload || {}).slice(0, 20),
        elapsedMs: Date.now() - startTime,
      })

      res.status(upstream.status).json(payload)
    } catch (error) {
      apiLogger.error(`TrackV2 failed`, {
        track_id,
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
