/**
 * 汽水推荐：点赞/收藏
 * POST /api/recommend/like     { sessionid, track_id, action: 'like'|'unlike' }
 *
 * 上游：
 * - like  : POST /luna/me/collection/track  body.track_ids
 * - unlike: POST /luna/me/collection/track/delete  body.track_ids
 * 备用：/luna/pc/me/collection/media（需要时再升级）
 */

const { endpoints, fixed, getPcQuery, baseUrl } = require('../config/qishui-auth')
const { buildUrl } = require('../utils/http')
const { fetchWithTimeout } = require('../utils/fetch-with-timeout')
const { logger } = require('../utils/logger')

const likeLogger = logger.child('RecommendLike')

async function postJson(url, body, sessionid) {
  const upstream = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      Cookie: `sessionid=${sessionid};`,
      'Content-Type': 'application/json; charset=utf-8',
      'Accept-Encoding': 'gzip, deflate',
      'User-Agent': 'LunaPC/3.7.0(452316191)',
    },
    body: JSON.stringify(body),
  }, 20 * 1000)

  const rawText = await upstream.text()
  let payload = {}
  try {
    payload = rawText ? JSON.parse(rawText) : {}
  } catch {
    payload = { status_code: upstream.status, message: rawText.slice(0, 200) }
  }

  return { status: upstream.status, payload }
}

module.exports = {
  name: 'recommend-like',
  method: 'post',
  path: '/api/recommend/like',
  handler: async (req, res) => {
    const { sessionid, track_id, action = 'like' } = req.body || {}
    if (!sessionid || !track_id) {
      res.status(400).json({ message: 'sessionid and track_id are required' })
      return
    }

    const like = String(action).toLowerCase() !== 'unlike'
    const path = like
      ? `${baseUrl}/luna/me/collection/track`
      : `${baseUrl}/luna/me/collection/track/delete`
    const target = buildUrl(path, getPcQuery({ aid: fixed.aid }))

    try {
      const { status, payload } = await postJson(target, {
        track_ids: [String(track_id)],
        // 播放器红心点击
        collect_action: 1,
        scene_name: 'player',
      }, sessionid)

      const businessCode = Number(payload?.status_code)
      const ok = status < 400 && (!Number.isFinite(businessCode) || businessCode === 0)

      likeLogger.info('recommend.likeResult', {
        track_id,
        action: like ? 'like' : 'unlike',
        status,
        statusCode: businessCode,
        ok,
      })

      res.status(status >= 400 ? status : 200).json({
        status_code: Number.isFinite(businessCode) ? businessCode : 0,
        message: payload?.message || (ok ? 'success' : '操作失败'),
        liked: like,
        track_id: String(track_id),
      })
    } catch (error) {
      likeLogger.error('recommend.likeFailed', {
        track_id,
        action,
        error: error?.message,
      })
      res.status(error.status || 500).json({
        message: error?.message || '点赞失败',
      })
    }
  },
}
