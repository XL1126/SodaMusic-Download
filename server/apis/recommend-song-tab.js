/**
 * 汽水推荐：随机/信息流曲目列表
 * POST /api/recommend/song-tab
 */

const { endpoints, fixed, getPcQuery } = require('../config/qishui-auth')
const { buildUrl } = require('../utils/http')
const { fetchWithTimeout } = require('../utils/fetch-with-timeout')
const { normalizeRecommendTrack } = require('../utils/recommend-utils')
const { logger } = require('../utils/logger')

const recLogger = logger.child('RecommendList')

module.exports = {
  name: 'recommend-song-tab',
  method: 'post',
  path: '/api/recommend/song-tab',
  handler: async (req, res) => {
    const startTime = Date.now()
    const {
      sessionid,
      count = 20,
      preference_mode = 'fresh',
      feed_mode = 'track',
      is_first_request = false,
      played_tracks = [],
    } = req.body || {}

    if (!sessionid) {
      res.status(400).json({ message: 'sessionid is required' })
      return
    }

    try {
      const { baseUrl } = require('../config/qishui-auth')
      const url = buildUrl(`${baseUrl}/luna/pc/feed/song-tab`, getPcQuery({ aid: fixed.aid }))

      const body = {
        count: Number(count) || 20,
        preference_mode,
        feed_mode,
        is_first_request: Boolean(is_first_request),
        is_did_first_request: Boolean(is_first_request),
        played_tracks: Array.isArray(played_tracks) ? played_tracks : [],
        with_client_cache: false,
        full_media: true,
      }

      recLogger.debug('recommend.songTabRequest', {
        count: body.count,
        preference_mode,
        feed_mode,
        is_first_request: body.is_first_request,
        played: body.played_tracks.length,
      })

      const upstream = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          Cookie: `sessionid=${sessionid};`,
          'Content-Type': 'application/json; charset=utf-8',
          'Accept-Encoding': 'gzip, deflate',
          'User-Agent': 'LunaPC/3.7.0(452316191)',
        },
        body: JSON.stringify(body),
      }, 30 * 1000)

      const rawText = await upstream.text()
      let payload
      try {
        payload = rawText ? JSON.parse(rawText) : {}
      } catch {
        payload = {
          status_code: upstream.status,
          message: '上游返回非 JSON',
          _raw: rawText.slice(0, 300),
        }
      }

      const items = Array.isArray(payload?.items) ? payload.items : []
      const tracks = items
        .map((item) => normalizeRecommendTrack(item))
        .filter(Boolean)

      recLogger.info('recommend.songTabResponse', {
        status: upstream.status,
        statusCode: payload?.status_code,
        itemCount: items.length,
        trackCount: tracks.length,
        hasMore: Boolean(payload?.has_more),
        sampleKeys: items[0] ? Object.keys(items[0]).slice(0, 20) : [],
        elapsedMs: Date.now() - startTime,
      })

      // 兜底：多路径抽取曲目
      let finalTracks = tracks
      if (finalTracks.length === 0) {
        const altSources = [
          payload?.media_resources,
          payload?.data?.items,
          payload?.data?.media_resources,
          payload?.extra?.items,
          payload?.tracks,
          payload?.data?.tracks,
          payload?.cards,
          payload?.data?.cards,
        ]
        for (const source of altSources) {
          if (!Array.isArray(source)) continue
          finalTracks = source.map((item) => normalizeRecommendTrack(item)).filter(Boolean)
          if (finalTracks.length > 0) break
        }

        // 再兜底：深度扫描对象数组中的 track-like 结构
        if (finalTracks.length === 0) {
          const deepScan = (node, depth = 0) => {
            if (!node || depth > 4) return []
            if (Array.isArray(node)) {
              const mapped = node.map((x) => normalizeRecommendTrack(x)).filter(Boolean)
              if (mapped.length) return mapped
              for (const child of node) {
                const found = deepScan(child, depth + 1)
                if (found.length) return found
              }
              return []
            }
            if (typeof node === 'object') {
              for (const value of Object.values(node)) {
                const found = deepScan(value, depth + 1)
                if (found.length) return found
              }
            }
            return []
          }
          finalTracks = deepScan(payload)
        }
      }

      res.status(upstream.status).json({
        status_code: payload?.status_code ?? 0,
        message: payload?.message || 'success',
        has_more: Boolean(payload?.has_more),
        tracks: finalTracks,
        rawItemCount: items.length,
        debugTopKeys: Object.keys(payload || {}).slice(0, 20),
      })
    } catch (error) {
      recLogger.error('recommend.songTabFailed', {
        error: error?.message,
        stack: error?.stack?.slice(0, 500),
        elapsedMs: Date.now() - startTime,
      })
      res.status(error.status || 500).json({
        message: error?.message || '获取推荐曲目失败',
      })
    }
  },
}
