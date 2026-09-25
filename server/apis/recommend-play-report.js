/**
 * 汽水推荐：播放时长/行为上报
 * POST /api/recommend/play-report
 * body: { sessionid, track_id, play_ms, started_at, scene }
 */

const { fixed, getPcQuery, baseUrl } = require('../config/qishui-auth')
const { buildUrl } = require('../utils/http')
const { fetchWithTimeout } = require('../utils/fetch-with-timeout')
const { logger } = require('../utils/logger')

const reportLogger = logger.child('RecommendPlayReport')

async function postJson(path, body, sessionid) {
  const target = buildUrl(path, getPcQuery({ aid: fixed.aid }))
  const upstream = await fetchWithTimeout(target, {
    method: 'POST',
    headers: {
      Cookie: `sessionid=${sessionid};`,
      'Content-Type': 'application/json; charset=utf-8',
      'User-Agent': 'LunaPC/3.7.0(452316191)',
    },
    body: JSON.stringify(body),
  }, 15 * 1000)

  const rawText = await upstream.text()
  let payload = {}
  try {
    payload = rawText ? JSON.parse(rawText) : {}
  } catch {
    payload = { status_code: upstream.status, raw: rawText.slice(0, 120) }
  }
  return { status: upstream.status, payload }
}

module.exports = {
  name: 'recommend-play-report',
  method: 'post',
  path: '/api/recommend/play-report',
  handler: async (req, res) => {
    const {
      sessionid,
      track_id,
      play_ms = 0,
      started_at = 0,
      scene = 'recommend',
      event = 'progress',
    } = req.body || {}

    if (!sessionid || !track_id) {
      res.status(400).json({ message: 'sessionid and track_id are required' })
      return
    }

    const playSeconds = Math.max(0, Math.round(Number(play_ms) / 1000))

    try {
      // 1) 听歌统计（主）
      const listen = await postJson(`${baseUrl}/luna/me/listen_stats`, {
        track_id: String(track_id),
        duration: playSeconds,
        play_duration: playSeconds,
        play_time: playSeconds,
        scene_name: scene,
      }, sessionid)

      // 2) 事件上报（辅，失败不影响）
      let eventResult = null
      try {
        eventResult = await postJson(`${baseUrl}/luna/log/event`, {
          event_key: event === 'ended' ? 'play_end' : 'play_progress',
          details: JSON.stringify({
            track_id: String(track_id),
            play_ms: Number(play_ms) || 0,
            started_at: Number(started_at) || 0,
            scene,
          }),
        }, sessionid)
      } catch {
        eventResult = null
      }

      reportLogger.debug('recommend.playReport', {
        track_id,
        play_ms,
        event,
        listenStatus: listen.status,
        listenCode: listen.payload?.status_code,
        eventStatus: eventResult?.status,
      })

      res.json({
        status_code: 0,
        message: 'ok',
        listen_status: listen.status,
        event_status: eventResult?.status || 0,
      })
    } catch (error) {
      reportLogger.warn('recommend.playReportFailed', {
        track_id,
        error: error?.message,
      })
      // 上报失败不阻断播放
      res.json({
        status_code: 0,
        message: 'report skipped',
      })
    }
  },
}
