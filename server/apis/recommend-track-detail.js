/**
 * 汽水推荐：曲目详情 + 歌词 + 封面
 * POST /api/recommend/track-detail
 */

const { fixed } = require('../config/qishui-auth')
const { fetchTrackPayload } = require('../utils/track-download')
const { extractPlayMetaFromTrackPayload } = require('../utils/recommend-utils')
const { logger } = require('../utils/logger')

const recLogger = logger.child('RecommendDetail')

module.exports = {
  name: 'recommend-track-detail',
  method: 'post',
  path: '/api/recommend/track-detail',
  handler: async (req, res) => {
    const { sessionid, track_id } = req.body || {}

    if (!sessionid) {
      res.status(400).json({ message: 'sessionid is required' })
      return
    }
    if (!track_id) {
      res.status(400).json({ message: 'track_id is required' })
      return
    }

    try {
      const payload = await fetchTrackPayload({
        aid: fixed.aid,
        sessionid,
        track_id,
      })

      const meta = extractPlayMetaFromTrackPayload(payload)
      if (!meta.id && !meta.name) {
        recLogger.warn('recommend.detailEmpty', { track_id, topKeys: Object.keys(payload || {}).slice(0, 20) })
      }

      recLogger.debug('recommend.detailOk', {
        track_id,
        name: meta.name,
        hasLyric: Boolean(meta.lyricText),
        lyricLines: meta.lyricLines.length,
      })

      res.json({
        status_code: 0,
        track: meta,
      })
    } catch (error) {
      recLogger.error('recommend.detailFailed', {
        track_id,
        error: error?.message,
        status: error?.status,
      })
      res.status(error.status || 500).json({
        message: error?.message || '获取曲目详情失败',
      })
    }
  },
}
