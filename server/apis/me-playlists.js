/*
 * 我创建的歌单列表 API
 * 功能：转发到汽水音乐后端 /luna/pc/me/playlist，获取当前登录账号自建的歌单
 *
 * 修复：
 *  1) fetch 超时 30s，避免后端慢响应悬挂
 *  2) 日志埋点；非 JSON 响应兜底解析
 */
const { endpoints, fixed, getPcQuery } = require('../config/qishui-auth')
const { buildUrl } = require('../utils/http')
const { fetchWithTimeout } = require('../utils/fetch-with-timeout')
const { logger } = require('../utils/logger')

const apiLogger = logger.child('MePlaylistsApi')

const request = {
  method: 'post',
  path: '/api/me/playlists',
  query: {},
  headers: {
    'content-type': 'application/json',
  },
  body: {
    aid: fixed.aid,
    sessionid: 'string',
  },
}

const response = {
  status_info: {
    log_id: 'string',
    now: 0,
    now_ts_ms: 0,
  },
  playlists: [
    {
      id: 'string',
      title: 'string',
      count_tracks: 0,
      owner: {
        id: 'string',
        nickname: 'string',
      },
    },
  ],
  total_num: 0,
}

module.exports = {
  name: 'me-playlists',
  method: request.method,
  path: request.path,
  request,
  response,
  handler: async (req, res) => {
    const startTime = Date.now()
    const { aid = fixed.aid, sessionid } = req.body || {}

    apiLogger.debug(`MePlaylists request`)

    if (!sessionid) {
      apiLogger.warn(`MePlaylists missing sessionid`)
      res.status(400).json({
        message: 'sessionid is required',
      })
      return
    }

    try {
      const target = buildUrl(endpoints.mePlaylists, getPcQuery({ aid }))
      const upstream = await fetchWithTimeout(target, {
        headers: {
          Cookie: `sessionid=${sessionid};`,
          'Accept-Encoding': 'gzip, deflate',
        },
      }, 30 * 1000)

      const rawText = await upstream.text()
      let payload
      try {
        payload = rawText ? JSON.parse(rawText) : {}
      } catch (parseErr) {
        apiLogger.warn(`MePlaylists upstream non-JSON response`, {
          status: upstream.status,
          contentPreview: rawText.slice(0, 200),
        })
        payload = {
          status_code: upstream.status,
          message: `Upstream returned non-JSON content (HTTP ${upstream.status})`,
          _raw: rawText.slice(0, 500),
        }
      }

      apiLogger.debug(`MePlaylists response`, {
        status: upstream.status,
        statusCode: payload?.status_code,
        playlistsCount: Array.isArray(payload?.playlists) ? payload.playlists.length : 0,
        totalNum: payload?.total_num,
        elapsedMs: Date.now() - startTime,
      })

      res.status(upstream.status).json(payload)
    } catch (error) {
      apiLogger.error(`MePlaylists failed`, {
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
