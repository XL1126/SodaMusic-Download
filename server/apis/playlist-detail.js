/*
 * 歌单详情查询代理 API
 * 功能：转发到汽水音乐后端 /luna/pc/playlist/detail，分页获取歌单内曲目列表
 *
 * 修复：
 *  1) 增加 fetch 超时 30s，防止后端慢响应时连接永久悬挂
 *  2) 增加日志埋点（入口 / 响应结果 / 耗时）
 *  3) 解析响应兜底：非 JSON 时把原始内容作为 _raw 字段返回，便于排查 WAF/封禁
 */
const { endpoints, fixed, getPcQuery } = require('../config/qishui-auth')
const { buildUrl } = require('../utils/http')
const { fetchWithTimeout } = require('../utils/fetch-with-timeout')
const { logger } = require('../utils/logger')

const apiLogger = logger.child('PlaylistDetailApi')

const request = {
  method: 'post',
  path: '/api/playlist/detail',
  query: {
    aid: fixed.aid,
    region: fixed.region,
    geo_region: fixed.geo_region,
    os_region: fixed.os_region,
    sim_region: fixed.sim_region,
    playlist_id: 'string',
    cursor: '',
    count: 15,
  },
  headers: {
    'content-type': 'application/json',
  },
  body: {
    aid: fixed.aid,
    sessionid: 'string',
    playlist_id: 'string',
    cursor: '',
    count: 15,
  },
}

const response = {
  has_more: true,
  next_cursor: 'string',
  playlist: {
    id: 'string',
    title: 'string',
  },
  media_resources: [],
}

module.exports = {
  name: 'playlist-detail',
  method: request.method,
  path: request.path,
  request,
  response,
  handler: async (req, res) => {
    const startTime = Date.now()
    const {
      aid = fixed.aid,
      sessionid,
      playlist_id,
      cursor = '',
      count = 15,
    } = req.body || {}

    apiLogger.debug(`PlaylistDetail request`, { playlist_id, cursor: cursor || '(first)', count })

    if (!sessionid) {
      apiLogger.warn(`PlaylistDetail missing sessionid`)
      res.status(400).json({
        message: 'sessionid is required',
      })
      return
    }

    if (!playlist_id) {
      apiLogger.warn(`PlaylistDetail missing playlist_id`)
      res.status(400).json({
        message: 'playlist_id is required',
      })
      return
    }

    try {
      const target = buildUrl(endpoints.playlistDetail, {
        ...getPcQuery({ aid }),
        playlist_id,
        cursor,
        count,
      })

      const upstream = await fetchWithTimeout(target, {
        headers: {
          Cookie: `sessionid=${sessionid};`,
          'Accept-Encoding': 'gzip, deflate',
        },
      }, 30 * 1000)

      // —— 兜底解析：非 JSON 内容时回传原始文本片段
      const rawText = await upstream.text()
      let payload
      try {
        payload = rawText ? JSON.parse(rawText) : {}
      } catch (parseErr) {
        apiLogger.warn(`PlaylistDetail upstream non-JSON response`, {
          playlist_id,
          status: upstream.status,
          contentPreview: rawText.slice(0, 200),
        })
        payload = {
          status_code: upstream.status,
          message: `Upstream returned non-JSON content (HTTP ${upstream.status})`,
          _raw: rawText.slice(0, 500),
        }
      }

      apiLogger.debug(`PlaylistDetail response`, {
        playlist_id,
        status: upstream.status,
        statusCode: payload?.status_code,
        playlistTitle: payload?.playlist?.title ? String(payload.playlist.title).slice(0, 60) : '',
        hasMore: payload?.has_more,
        nextCursor: payload?.next_cursor ? String(payload.next_cursor).slice(0, 20) : '',
        resources: Array.isArray(payload?.media_resources) ? payload.media_resources.length : 0,
        elapsedMs: Date.now() - startTime,
      })

      res.status(upstream.status).json(payload)
    } catch (error) {
      apiLogger.error(`PlaylistDetail failed`, {
        playlist_id,
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
