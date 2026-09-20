/**
 * 汽水推荐：播放资源
 * 1) POST /api/recommend/play-token  申请短时播放令牌
 * 2) GET  /api/recommend/stream      用令牌拉取解密后的音频流（浏览器 <audio> 用）
 * 3) POST /api/recommend/play-info   返回封面/歌词/可播信息（不直接下发加密 URL）
 */

const crypto = require('crypto')
const { fixed } = require('../config/qishui-auth')
const {
  downloadTrackMedia,
  fetchTrackPayload,
  getTrackV2Payload,
} = require('../utils/track-download')
const { extractPlayMetaFromTrackPayload } = require('../utils/recommend-utils')
const { logger } = require('../utils/logger')

const recLogger = logger.child('RecommendStream')

const tokenStore = new Map()
const TOKEN_TTL_MS = 10 * 60 * 1000

function cleanupTokens() {
  const now = Date.now()
  for (const [key, value] of tokenStore.entries()) {
    if (value.expiresAt <= now) tokenStore.delete(key)
  }
}

function issueToken({ sessionid, trackId }) {
  cleanupTokens()
  const token = crypto.randomBytes(24).toString('hex')
  tokenStore.set(token, {
    sessionid,
    trackId: String(trackId),
    expiresAt: Date.now() + TOKEN_TTL_MS,
  })
  return token
}

async function preparePlayableBuffer({ sessionid, trackId }) {
  const result = await downloadTrackMedia({
    aid: fixed.aid,
    sessionid,
    track_id: trackId,
    quality: 'highest',
  })
  return result
}

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
      const token = issueToken({ sessionid, trackId: track_id })
      recLogger.debug('recommend.tokenIssued', { track_id })
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
      const entry = tokenStore.get(token)
      if (!entry || entry.expiresAt <= Date.now()) {
        if (token) tokenStore.delete(token)
        res.status(401).json({ message: '播放令牌无效或已过期' })
        return
      }

      try {
        const result = await preparePlayableBuffer({
          sessionid: entry.sessionid,
          trackId: entry.trackId,
        })

        recLogger.info('recommend.streamReady', {
          track_id: entry.trackId,
          contentType: result.contentType,
          size: result.buffer?.length || 0,
        })

        res.setHeader('Content-Type', result.contentType || 'audio/mp4')
        res.setHeader('Content-Length', result.buffer.length)
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Accept-Ranges', 'none')
        res.send(result.buffer)
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

      try {
        const payload = await fetchTrackPayload({
          aid: fixed.aid,
          sessionid,
          track_id,
        })
        const meta = extractPlayMetaFromTrackPayload(payload)
        const token = issueToken({ sessionid, trackId: track_id })

        res.json({
          status_code: 0,
          track: meta,
          token,
          stream_url: `/api/recommend/stream?token=${token}`,
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
