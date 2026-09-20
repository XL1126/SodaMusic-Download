/**
 * 汽水推荐：播放资源（带缓存，起播更快）
 */

const { fetchTrackPayload } = require('../utils/track-download')
const { extractPlayMetaFromTrackPayload } = require('../utils/recommend-utils')
const {
  getPlayableAudio,
  issuePlayToken,
  consumePlayToken,
  TOKEN_TTL_MS,
} = require('../utils/play-cache')
const { fixed } = require('../config/qishui-auth')
const { logger } = require('../utils/logger')

const recLogger = logger.child('RecommendStream')

module.exports = [
  {
    name: 'recommend-play-token',
    method: 'post',
    path: '/api/recommend/play-token',
    handler: async (req, res) => {
      const { sessionid, track_id } = req.body || {}
      if (!sessionid || !track_id) {
        res.status(400).json({ message: 'sessionid and track_id are required' })
        return
      }
      const token = issuePlayToken({ sessionid, trackId: track_id })
      res.json({
        token,
        stream_url: `/api/recommend/stream?token=${token}`,
        expires_in_ms: TOKEN_TTL_MS,
      })
    },
  },
  {
    name: 'recommend-stream',
    method: 'get',
    path: '/api/recommend/stream',
    handler: async (req, res) => {
      const token = String(req.query.token || '')
      const entry = consumePlayToken(token)
      if (!entry) {
        res.status(401).json({ message: '播放令牌无效或已过期' })
        return
      }

      try {
        const playable = await getPlayableAudio({
          sessionid: entry.sessionid,
          trackId: entry.trackId,
          quality: req.query.quality === 'highest' ? 'highest' : 'lowest',
          useCache: true,
        })

        recLogger.info('recommend.streamReady', {
          track_id: entry.trackId,
          contentType: playable.contentType,
          size: playable.buffer?.length || 0,
        })

        res.setHeader('Content-Type', playable.contentType || 'audio/mp4')
        res.setHeader('Content-Length', playable.buffer.length)
        res.setHeader('Cache-Control', 'private, max-age=600')
        res.setHeader('Accept-Ranges', 'none')
        res.send(playable.buffer)
      } catch (error) {
        recLogger.error('recommend.streamFailed', {
          track_id: entry.trackId,
          error: error?.message,
        })
        res.status(error.status || 500).json({
          message: error?.message || '音频流获取失败',
        })
      }
    },
  },
  {
    name: 'recommend-play-info',
    method: 'post',
    path: '/api/recommend/play-info',
    handler: async (req, res) => {
      const { sessionid, track_id } = req.body || {}
      if (!sessionid || !track_id) {
        res.status(400).json({ message: 'sessionid and track_id are required' })
        return
      }

      const token = issuePlayToken({ sessionid, trackId: track_id })
      const streamUrl = `/api/recommend/stream?token=${token}`

      try {
        const detailPromise = fetchTrackPayload({
          aid: fixed.aid,
          sessionid,
          track_id,
        }).then((payload) => extractPlayMetaFromTrackPayload(payload)).catch((err) => {
          recLogger.warn('recommend.playInfoMetaFailed', { track_id, error: err?.message })
          return null
        })

        const playablePromise = getPlayableAudio({
          sessionid,
          trackId: track_id,
          quality: 'lowest',
          useCache: true,
        }).catch((err) => {
          recLogger.warn('recommend.playInfoAudioFailed', { track_id, error: err?.message })
          return null
        })

        const [detail, playable] = await Promise.all([detailPromise, playablePromise])
        const meta = detail || playable?.meta || {
          id: String(track_id),
          name: '',
          artists: [],
          artistText: '',
          album: '',
          cover: '',
          duration: 0,
          lyricText: '',
          lyricLines: [],
        }

        res.json({
          status_code: 0,
          track: meta,
          token,
          stream_url: streamUrl,
          cache_ready: Boolean(playable?.buffer?.length),
        })
      } catch (error) {
        recLogger.error('recommend.playInfoFailed', {
          track_id,
          error: error?.message,
        })
        res.status(error.status || 500).json({
          message: error?.message || '获取播放信息失败',
        })
      }
    },
  },
]
