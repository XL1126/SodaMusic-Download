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

export async function startLocalPlay(trackId) {
  const session = getSession()
  const response = await fetchWithTimeout('/api/recommend/local-play', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...session,
      track_id: trackId,
    }),
  }, 120000)
  return parseApiResponse(response, '本机播放启动失败')
}

export async function controlLocalPlay(action) {
  const response = await fetchWithTimeout('/api/recommend/local-control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  return parseApiResponse(response, '本机播放控制失败')
}

export async function fetchLocalPlayStatus() {
  const response = await fetchWithTimeout('/api/recommend/local-status', {
    method: 'GET',
  })
  return parseApiResponse(response, '获取本机播放状态失败')
}
