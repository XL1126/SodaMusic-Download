/**
 * 汽水推荐播放队列（共享状态）
 * - App 启动后即可预取随机曲目
 * - 当前曲上下各缓冲 2 首，共维护约 5 首可播缓存
 */

import { getStoredSession } from './authStorage'
import { fetchRecommendPlayInfo, fetchRecommendTracks } from '../api/recommend'

const BUFFER_RADIUS = 2

const state = {
  tracks: [],
  currentIndex: -1,
  loading: false,
  ready: false,
  playInfoCache: new Map(), // id -> playInfo
  preparing: new Set(),
}

const listeners = new Set()

function emit() {
  for (const fn of listeners) {
    try { fn(getSnapshot()) } catch { /* ignore */ }
  }
}

function getSnapshot() {
  return {
    tracks: state.tracks,
    currentIndex: state.currentIndex,
    loading: state.loading,
    ready: state.ready,
  }
}

export function subscribeRecommendQueue(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getRecommendSnapshot() {
  return getSnapshot()
}

export function getPlayInfoFromCache(trackId) {
  return state.playInfoCache.get(String(trackId)) || null
}

export function setCurrentIndex(index) {
  state.currentIndex = index
  emit()
  ensureWindowPrepared()
}

function hasLogin() {
  return Boolean(getStoredSession()?.sessionid)
}

function unwrapTracks(payload) {
  return Array.isArray(payload?.tracks) ? payload.tracks : []
}

function mergeTracks(incoming) {
  const seen = new Set(state.tracks.map((item) => item.id))
  const merged = [...state.tracks]
  for (const item of incoming) {
    if (!item?.id || seen.has(item.id)) continue
    seen.add(item.id)
    merged.push(item)
  }
  state.tracks = merged
  return merged
}

/**
 * 启动时预取随机队列（不自动播放）
 */
export async function warmupRecommendQueue({ count = 20 } = {}) {
  if (!hasLogin()) return getSnapshot()
  if (state.loading) return getSnapshot()
  if (state.ready && state.tracks.length > 0) {
    ensureWindowPrepared()
    return getSnapshot()
  }

  state.loading = true
  emit()

  try {
    const payload = await fetchRecommendTracks({
      count,
      preferenceMode: 'fresh',
      feedMode: 'track',
      isFirstRequest: state.tracks.length === 0,
      playedTracks: [],
    })
    mergeTracks(unwrapTracks(payload))
    if (state.currentIndex < 0 && state.tracks.length > 0) {
      state.currentIndex = 0
    }
    state.ready = true
  } catch (error) {
    // 启动预取失败不打断页面；进入推荐页时会再试
    state.ready = false
  } finally {
    state.loading = false
    emit()
    ensureWindowPrepared()
  }

  return getSnapshot()
}

export async function refreshRecommendQueue({ append = true } = {}) {
  if (!hasLogin()) {
    throw new Error('当前未登录，请先登录汽水音乐账号。')
  }

  state.loading = true
  emit()

  try {
    const payload = await fetchRecommendTracks({
      count: 20,
      preferenceMode: 'fresh',
      feedMode: 'track',
      isFirstRequest: !append && state.tracks.length === 0,
      playedTracks: state.tracks.slice(0, 8).map((item) => ({ id: item.id })),
    })
    const incoming = unwrapTracks(payload)
    if (!append) {
      state.tracks = []
      state.playInfoCache.clear()
      state.currentIndex = -1
    }
    mergeTracks(incoming)
    if (state.currentIndex < 0 && state.tracks.length > 0) {
      state.currentIndex = 0
    }
    state.ready = state.tracks.length > 0
    if (!state.tracks.length) {
      throw new Error('暂未获取到推荐曲目，可稍后重试')
    }
  } finally {
    state.loading = false
    emit()
    ensureWindowPrepared()
  }

  return getSnapshot()
}

/**
 * 预取当前曲上下 BUFFER_RADIUS 首的播放信息（含 stream token / 封面 / 歌词）
 */
export async function ensureWindowPrepared() {
  if (!hasLogin() || state.currentIndex < 0 || !state.tracks.length) return

  const start = Math.max(0, state.currentIndex - BUFFER_RADIUS)
  const end = Math.min(state.tracks.length - 1, state.currentIndex + BUFFER_RADIUS)
  const jobs = []

  for (let i = start; i <= end; i += 1) {
    const track = state.tracks[i]
    if (!track?.id) continue
    const id = String(track.id)
    if (state.playInfoCache.has(id) || state.preparing.has(id)) continue
    state.preparing.add(id)
    jobs.push(
      fetchRecommendPlayInfo(id)
        .then((payload) => {
          const detail = payload?.track || {}
          const info = {
            ...track,
            ...detail,
            id: detail.id || track.id,
            name: detail.name || track.name,
            artistText: detail.artistText || track.artistText,
            cover: detail.cover || track.cover,
            coverProxy: detail.coverProxy || (detail.cover
              ? `/api/recommend/image?src=${encodeURIComponent(detail.cover)}`
              : track.coverProxy),
            lyricLines: detail.lyricLines || [],
            duration: detail.duration || track.duration || 0,
            streamUrl: payload?.stream_url || '',
          }
          state.playInfoCache.set(id, info)
          state.tracks[i] = { ...state.tracks[i], ...info }
        })
        .catch(() => {
          // 单曲预取失败忽略
        })
        .finally(() => {
          state.preparing.delete(id)
        }),
    )
  }

  if (jobs.length) {
    await Promise.all(jobs)
    emit()
  }
}

export async function getPreparedTrack(index) {
  const track = state.tracks[index]
  if (!track) return null

  const id = String(track.id)
  if (state.playInfoCache.has(id)) {
    return { index, track: state.playInfoCache.get(id) }
  }

  try {
    const payload = await fetchRecommendPlayInfo(id)
    const detail = payload?.track || {}
    const info = {
      ...track,
      ...detail,
      id: detail.id || track.id,
      name: detail.name || track.name,
      artistText: detail.artistText || track.artistText,
      cover: detail.cover || track.cover,
      coverProxy: detail.coverProxy || (detail.cover
        ? `/api/recommend/image?src=${encodeURIComponent(detail.cover)}`
        : track.coverProxy),
      lyricLines: detail.lyricLines || [],
      duration: detail.duration || track.duration || 0,
      streamUrl: payload?.stream_url || '',
    }
    state.playInfoCache.set(id, info)
    state.tracks[index] = { ...state.tracks[index], ...info }
    emit()
    return { index, track: info }
  } catch (error) {
    throw error
  }
}

export function wrapIndex(index) {
  const len = state.tracks.length
  if (!len) return -1
  let next = index
  if (next < 0) next = len - 1
  if (next >= len) next = 0
  return next
}

export const RECOMMEND_BUFFER_RADIUS = BUFFER_RADIUS
