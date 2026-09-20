/**
 * 汽水推荐前端 API（浏览器播放）
 */

import { getStoredSession } from '../utils/authStorage'
import { fetchWithTimeout, parseApiResponse } from '../utils/apiHelpers'

function getSession() {
  const session = getStoredSession()
  if (!session?.sessionid) {
    throw new Error('当前未登录，请先登录汽水音乐账号。')
  }
  return session
}

export async function fetchRecommendTracks({
  count = 20,
  preferenceMode = 'fresh',
  feedMode = 'track',
  isFirstRequest = false,
  playedTracks = [],
} = {}) {
  const session = getSession()
  const response = await fetchWithTimeout('/api/recommend/song-tab', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...session,
      count,
      preference_mode: preferenceMode,
      feed_mode: feedMode,
      is_first_request: isFirstRequest,
      played_tracks: playedTracks,
    }),
  })
  return parseApiResponse(response, '获取汽水推荐失败')
}

export async function fetchRecommendPlayInfo(trackId) {
  const session = getSession()
  const response = await fetchWithTimeout('/api/recommend/play-info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...session,
      track_id: trackId,
    }),
  })
  return parseApiResponse(response, '获取播放信息失败')
}
