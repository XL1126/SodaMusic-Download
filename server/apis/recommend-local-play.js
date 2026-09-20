/**
 * 汽水推荐：本机播放
 * POST /api/recommend/local-play     在运行项目的电脑上播放音频
 * POST /api/recommend/local-control  pause / resume / stop
 * GET  /api/recommend/local-status   查询本机播放状态
 */

const { fixed } = require('../config/qishui-auth')
const { downloadTrackMedia, fetchTrackPayload } = require('../utils/track-download')
const { extractPlayMetaFromTrackPayload } = require('../utils/recommend-utils')
const {
  startLocalPlayback,
  sendControl,
  getLocalStatus,
  stopLocalPlayback,
} = require('../utils/local-music-player')
const { logger } = require('../utils/logger')

const recLogger = logger.child('RecommendLocal')

module.exports = [
  {
    name: 'recommend-local-play',
    method: 'post',
    path: '/api/recommend/local-play',
    handler: async (req, res) => {
      if (process.platform !== 'win32') {
        res.status(400).json({
          message: '本机播放仅支持 Windows 系统',
        })
        return
      }

      const { sessionid, track_id } = req.body || {}
      if (!sessionid || !track_id) {
        res.status(400).json({ message: 'sessionid and track_id are required' })
        return
      }

      try {
        recLogger.info('recommend.localPlayRequest', { track_id })

        const detail = await fetchTrackPayload({
          aid: fixed.aid,
          sessionid,
          track_id,
        })
        const meta = extractPlayMetaFromTrackPayload(detail)

        const media = await downloadTrackMedia({
          aid: fixed.aid,
          sessionid,
          track_id,
          quality: 'highest',
        })

        const status = startLocalPlayback({
          buffer: media.buffer,
          contentType: media.contentType,
          title: meta.name || media.fileName || '未知曲目',
          artist: meta.artistText || '',
          cover: meta.cover || '',
          trackId: track_id,
        })

        res.json({
          status_code: 0,
          message: '本机播放已启动',
          track: meta,
          local: status,
        })
      } catch (error) {
        recLogger.error('recommend.localPlayFailed', {
          track_id,
          error: error?.message,
          stack: error?.stack?.slice(0, 400),
        })
        res.status(error.status || 500).json({
          message: error?.message || '本机播放失败',
        })
      }
    },
  },
  {
    name: 'recommend-local-control',
    method: 'post',
    path: '/api/recommend/local-control',
    handler: async (req, res) => {
      const action = String(req.body?.action || '').toLowerCase()
      if (!['pause', 'resume', 'stop'].includes(action)) {
        res.status(400).json({ message: 'action 必须是 pause / resume / stop' })
        return
      }

      try {
        const status = action === 'stop'
          ? stopLocalPlayback()
          : sendControl(action)
        res.json({
          status_code: 0,
          local: status,
        })
      } catch (error) {
        recLogger.error('recommend.localControlFailed', {
          action,
          error: error?.message,
        })
        res.status(500).json({ message: error?.message || '本机播放控制失败' })
      }
    },
  },
  {
    name: 'recommend-local-status',
    method: 'get',
    path: '/api/recommend/local-status',
    handler: async (_req, res) => {
      res.json({
        status_code: 0,
        local: getLocalStatus(),
      })
    },
  },
]
