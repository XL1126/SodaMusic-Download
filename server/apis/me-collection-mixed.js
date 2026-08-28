/*
 * 我收藏的歌单 / 混合收藏列表 API
 * 功能：转发到汽水音乐后端 /luna/pc/me/collection/mixed
 *
 * 修复：fetch 超时 30s + 日志 + 非 JSON 响应兜底
 */
const { endpoints, fixed } = require('../config/qishui-auth')
const { buildUrl } = require('../utils/http')
const { fetchWithTimeout } = require('../utils/fetch-with-timeout')
const { logger } = require('../utils/logger')

const apiLogger = logger.child('MeCollectionMixedApi')

const request = {
  method: 'post',
  path: '/api/me/collection/mixed',
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
  mixed_collections: [
    {
      item_type: 'playlist',
      playlist: {
        id: 'string',
        title: 'string',
        count_tracks: 0,
      },
    },
  ],
  total_num: 0,
}

module.exports = {
  name: 'me-collection-mixed',
  method: request.method,
  path: request.path,
  request,
  response,
  handler: async (req, res) => {
    const startTime = Date.now()
    const { aid = fixed.aid, sessionid } = req.body || {}

    apiLogger.debug(`MeCollectionMixed request`)

    if (!sessionid) {
      apiLogger.warn(`MeCollectionMixed missing sessionid`)
      res.status(400).json({
        message: 'sessionid is required',
      })
      return
    }

    try {
      const target = buildUrl(endpoints.meCollectionMixed, { aid })
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
        apiLogger.warn(`MeCollectionMixed upstream non-JSON response`, {
          status: upstream.status,
          contentPreview: rawText.slice(0, 200),
        })
        payload = {
          status_code: upstream.status,
          message: `Upstream returned non-JSON content (HTTP ${upstream.status})`,
          _raw: rawText.slice(0, 500),
        }
      }

      apiLogger.debug(`MeCollectionMixed response`, {
        status: upstream.status,
        statusCode: payload?.status_code,
        collectionsCount: Array.isArray(payload?.mixed_collections) ? payload.mixed_collections.length : 0,
        totalNum: payload?.total_num,
        elapsedMs: Date.now() - startTime,
      })

      res.status(upstream.status).json(payload)
    } catch (error) {
      apiLogger.error(`MeCollectionMixed failed`, {
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
