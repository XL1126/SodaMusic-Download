<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  NButton,
  NIcon,
  NSpin,
  NTag,
  NText,
  createDiscreteApi,
} from 'naive-ui'
import {
  PauseOutline,
  PlaySkipBackOutline,
  PlaySkipForwardOutline,
  PlayOutline,
  RadioOutline,
  RefreshOutline,
} from '@vicons/ionicons5'
import { getStoredSession } from '../utils/authStorage'
import {
  fetchRecommendPlayInfo,
  fetchRecommendTracks,
} from '../api/recommend'

const props = defineProps({
  isAuthenticated: {
    type: Boolean,
    default: false,
  },
  userProfile: {
    type: Object,
    default: null,
  },
})

const { message } = createDiscreteApi(['message'])

const tracks = ref([])
const loading = ref(false)
const starting = ref(false)
const currentIndex = ref(-1)
const currentTrack = ref(null)
const lyricLines = ref([])
const activeLyricIndex = ref(-1)
const activeLineProgress = ref(0)
const streamUrl = ref('')
const audioRef = ref(null)
const lyricListRef = ref(null)
const playing = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const coverSrc = ref('')

const hasLogin = computed(() => Boolean(getStoredSession()?.sessionid))
const queueSize = computed(() => tracks.value.length)

function formatTime(seconds) {
  const value = Number(seconds) || 0
  const m = Math.floor(value / 60)
  const s = Math.floor(value % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function parseApiError(error, fallback) {
  return error?.message || fallback
}

function resolveCover(trackLike = {}) {
  return (
    trackLike.coverProxy
    || (trackLike.cover ? `/api/recommend/image?src=${encodeURIComponent(trackLike.cover)}` : '')
  )
}

function lineProgress(line, next, time) {
  if (!line) return 0
  const start = Number(line.time) || 0
  const end = line.endTime != null
    ? Number(line.endTime)
    : (next ? Number(next.time) : (duration.value || start + 3))
  if (time <= start) return 0
  if (end <= start) return time >= start ? 100 : 0
  if (time >= end) return 100
  return ((time - start) / (end - start)) * 100
}

function syncLyricIndex(time) {
  const lines = lyricLines.value
  if (!lines.length) {
    activeLyricIndex.value = -1
    activeLineProgress.value = 0
    return
  }

  let idx = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (time + 0.05 >= lines[i].time) idx = i
    else break
  }

  if (idx !== activeLyricIndex.value) {
    activeLyricIndex.value = idx
    scrollLyricIntoView(idx)
  }

  if (idx >= 0) {
    activeLineProgress.value = lineProgress(lines[idx], lines[idx + 1], time)
  } else {
    activeLineProgress.value = 0
  }
}

function scrollLyricIntoView(index) {
  const container = lyricListRef.value
  if (!container || index < 0) return
  const node = container.querySelector(`[data-lyric-index="${index}"]`)
  if (!node) return
  const offset = node.offsetTop - container.clientHeight / 2 + node.clientHeight / 2
  container.scrollTo({ top: Math.max(offset, 0), behavior: 'smooth' })
}

function updateMediaSession(track) {
  if (!('mediaSession' in navigator) || !track) return
  try {
    const artwork = coverSrc.value
      ? [{ src: coverSrc.value, sizes: '400x400', type: 'image/jpeg' }]
      : []
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: track.name || '未知曲目',
      artist: track.artistText || track.artists?.join(' / ') || '',
      album: track.album || '汽水推荐',
      artwork,
    })
    navigator.mediaSession.setActionHandler('play', () => togglePlay())
    navigator.mediaSession.setActionHandler('pause', () => togglePlay())
    navigator.mediaSession.setActionHandler('previoustrack', () => playRelative(-1))
    navigator.mediaSession.setActionHandler('nexttrack', () => playRelative(1))
  } catch {
    // ignore
  }
}

function resetPlayerUi() {
  playing.value = false
  currentTime.value = 0
  duration.value = 0
  activeLyricIndex.value = -1
  activeLineProgress.value = 0
}

async function ensurePlayInfo(track) {
  const payload = await fetchRecommendPlayInfo(track.id)
  const detail = payload?.track || {}
  return {
    ...track,
    name: detail.name || track.name,
    artistText: detail.artistText || track.artistText,
    artists: detail.artists?.length ? detail.artists : track.artists,
    album: detail.album || track.album,
    cover: detail.cover || track.cover,
    coverProxy: detail.coverProxy || resolveCover(detail.cover || track.cover),
    duration: detail.duration || track.duration || 0,
    lyricLines: detail.lyricLines || [],
    lyricText: detail.lyricText || '',
    streamUrl: payload?.stream_url || '',
  }
}

async function loadQueueAndMaybePlay({ autoplay = false } = {}) {
  if (!hasLogin.value && !props.isAuthenticated) {
    message.warning('请先登录后再使用汽水推荐')
    return
  }

  loading.value = true
  try {
    const payload = await fetchRecommendTracks({
      count: 20,
      preferenceMode: 'fresh',
      feedMode: 'track',
      isFirstRequest: tracks.value.length === 0,
      playedTracks: tracks.value.slice(0, 8).map((item) => ({ id: item.id })),
    })

    const nextTracks = Array.isArray(payload?.tracks) ? payload.tracks : []
    if (nextTracks.length === 0) {
      message.info('暂未获取到推荐曲目，可稍后重试')
      return
    }

    const seen = new Set(tracks.value.map((item) => item.id))
    const merged = [...tracks.value]
    for (const item of nextTracks) {
      if (!item?.id || seen.has(item.id)) continue
      seen.add(item.id)
      merged.push(item)
    }
    tracks.value = merged

    if (autoplay && currentIndex.value < 0) {
      await playTrackAt(0)
      return
    }

    if (currentIndex.value < 0 && merged.length > 0) {
      starting.value = true
      try {
        const info = await ensurePlayInfo(merged[0])
        currentIndex.value = 0
        currentTrack.value = info
        tracks.value[0] = { ...merged[0], ...info }
        lyricLines.value = info.lyricLines || []
        duration.value = info.duration || 0
        coverSrc.value = resolveCover(info)
        streamUrl.value = info.streamUrl || ''
        updateMediaSession(info)
        syncLyricIndex(0)
      } catch {
        // ignore prepare errors
      } finally {
        starting.value = false
      }
    }
  } catch (error) {
    message.error(parseApiError(error, '获取汽水推荐失败'))
  } finally {
    loading.value = false
  }
}

async function playTrackAt(index, { autoplay = true } = {}) {
  if (!tracks.value.length) {
    await loadQueueAndMaybePlay({ autoplay: true })
    return
  }
  if (index < 0 || index >= tracks.value.length) return

  const track = tracks.value[index]
  currentIndex.value = index
  starting.value = true
  resetPlayerUi()

  try {
    const info = await ensurePlayInfo(track)
    currentTrack.value = info
    lyricLines.value = info.lyricLines || []
    duration.value = info.duration || 0
    tracks.value[index] = { ...track, ...info }
    coverSrc.value = resolveCover(info)
    streamUrl.value = info.streamUrl || ''
    updateMediaSession(info)

    const audio = audioRef.value
    if (audio && streamUrl.value) {
      audio.src = streamUrl.value
      audio.load()
      if (autoplay) {
        await audio.play()
        playing.value = true
      }
    } else {
      message.error('未能获取浏览器播放地址')
    }
  } catch (error) {
    message.error(parseApiError(error, '播放失败'))
  } finally {
    starting.value = false
  }
}

async function togglePlay() {
  if (!currentTrack.value || !streamUrl.value) {
    await playTrackAt(currentIndex.value >= 0 ? currentIndex.value : 0)
    return
  }

  const audio = audioRef.value
  if (!audio) return
  if (audio.paused) {
    try {
      if (!audio.src && streamUrl.value) {
        audio.src = streamUrl.value
        audio.load()
      }
      await audio.play()
      playing.value = true
    } catch (error) {
      message.error(parseApiError(error, '播放失败'))
    }
  } else {
    audio.pause()
    playing.value = false
  }
}

async function playRelative(step) {
  if (!tracks.value.length) return
  let next = currentIndex.value + step
  if (next < 0) next = tracks.value.length - 1
  if (next >= tracks.value.length) next = 0
  await playTrackAt(next)
}

function onTimeUpdate() {
  const audio = audioRef.value
  if (!audio) return
  currentTime.value = audio.currentTime || 0
  if (audio.duration && Number.isFinite(audio.duration)) {
    duration.value = audio.duration
  }
  syncLyricIndex(currentTime.value)
}

async function onAudioEnded() {
  playing.value = false
  await playRelative(1)
}

function onSeekInput(event) {
  const value = Number(event.target.value) || 0
  currentTime.value = value
  if (audioRef.value) {
    audioRef.value.currentTime = value
  }
  syncLyricIndex(value)
}

const progressPercent = computed(() => {
  if (!duration.value) return 0
  return Math.min(100, (currentTime.value / duration.value) * 100)
})

onMounted(async () => {
  if (props.isAuthenticated || hasLogin.value) {
    await loadQueueAndMaybePlay({ autoplay: false })
  }
})

onBeforeUnmount(() => {
  try {
    audioRef.value?.pause()
  } catch {
    // ignore
  }
})
</script>

<template>
  <div class="soda-player-page">
    <div class="soda-bg" />

    <div class="soda-top">
      <div class="soda-brand">
        <n-icon size="18" color="#00cb64">
          <radio-outline />
        </n-icon>
        <span>汽水推荐</span>
        <n-tag size="small" round type="success" :bordered="false">
          随机播放
        </n-tag>
      </div>
      <n-button secondary size="small" :loading="loading" @click="loadQueueAndMaybePlay({ autoplay: false })">
        <template #icon>
          <n-icon><refresh-outline /></n-icon>
        </template>
        换一批
      </n-button>
    </div>

    <n-spin :show="loading || starting">
      <div class="soda-main">
        <div class="soda-cover-wrap">
          <div
            class="soda-cover"
            :class="{ 'has-image': coverSrc }"
            :style="coverSrc ? { backgroundImage: `url(${coverSrc})` } : null"
          >
            <div class="soda-cover-fallback">
              <n-icon size="48" color="#00cb64">
                <radio-outline />
              </n-icon>
            </div>
          </div>
          <div class="soda-vinyl" :class="{ playing }" />
        </div>

        <section class="soda-panel">
          <div class="soda-meta">
            <h1 class="soda-title">
              {{ currentTrack?.name || '点击播放，开始收听汽水推荐' }}
            </h1>
            <p class="soda-artist">
              {{ currentTrack?.artistText || currentTrack?.artists?.join(' / ') || '随机音乐' }}
            </p>
            <p class="soda-album">
              {{ currentTrack?.album || '浏览器播放' }}
              <span v-if="queueSize"> · 队列 {{ queueSize }} 首</span>
            </p>
          </div>

          <div ref="lyricListRef" class="soda-lyric">
            <div v-if="!lyricLines.length" class="soda-lyric-empty">
              {{ currentTrack ? '暂无歌词' : '歌词将随播放进度逐句高亮' }}
            </div>
            <div
              v-for="(line, index) in lyricLines"
              :key="`${index}-${line.time}-${line.text}`"
              :data-lyric-index="index"
              class="soda-lyric-line"
              :class="{
                active: index === activeLyricIndex,
                past: index < activeLyricIndex,
              }"
            >
              <span class="base">{{ line.text }}</span>
              <span
                class="fill"
                :style="{
                  width: index === activeLyricIndex
                    ? `${activeLineProgress}%`
                    : (index < activeLyricIndex ? '100%' : '0%'),
                }"
              >{{ line.text }}</span>
            </div>
          </div>

          <div class="soda-progress">
            <span class="soda-time">{{ formatTime(currentTime) }}</span>
            <div class="soda-bar">
              <div class="soda-bar-fill" :style="{ width: `${progressPercent}%` }" />
              <input
                class="soda-range"
                type="range"
                min="0"
                :max="Math.max(duration, 0.1)"
                step="0.1"
                :value="currentTime"
                @input="onSeekInput"
              />
            </div>
            <span class="soda-time">{{ formatTime(duration) }}</span>
          </div>

          <div class="soda-controls">
            <n-button circle secondary size="large" :disabled="!queueSize" @click="playRelative(-1)">
              <template #icon>
                <n-icon><play-skip-back-outline /></n-icon>
              </template>
            </n-button>
            <n-button
              circle
              type="primary"
              size="large"
              class="soda-play"
              :loading="starting"
              :disabled="!queueSize && !currentTrack"
              @click="togglePlay"
            >
              <template #icon>
                <n-icon size="22">
                  <pause-outline v-if="playing" />
                  <play-outline v-else />
                </n-icon>
              </template>
            </n-button>
            <n-button circle secondary size="large" :disabled="!queueSize" @click="playRelative(1)">
              <template #icon>
                <n-icon><play-skip-forward-outline /></n-icon>
              </template>
            </n-button>
          </div>

          <n-text depth="3" class="soda-hint">
            封面经本地代理加载；歌词按播放进度逐句填充高亮
          </n-text>
        </section>
      </div>
    </n-spin>

    <audio
      ref="audioRef"
      preload="none"
      @timeupdate="onTimeUpdate"
      @ended="onAudioEnded"
      @play="playing = true"
      @pause="playing = false"
    />
  </div>
</template>

<style scoped>
.soda-player-page {
  position: relative;
  min-height: 100%;
  color: #f4f7f5;
  font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
}

.soda-bg {
  position: absolute;
  inset: -20px;
  background:
    radial-gradient(circle at 18% 18%, rgba(0, 203, 100, 0.2), transparent 40%),
    radial-gradient(circle at 80% 0%, rgba(49, 228, 76, 0.1), transparent 32%),
    linear-gradient(160deg, #101814, #090c0a 60%, #0d1410);
  border-radius: 18px;
  z-index: 0;
}

.soda-top,
.soda-main {
  position: relative;
  z-index: 1;
}

.soda-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 22px;
}

.soda-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.soda-main {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  gap: 24px;
  align-items: center;
}

@media (max-width: 760px) {
  .soda-main {
    grid-template-columns: 1fr;
  }
}

.soda-cover-wrap {
  position: relative;
  width: 260px;
  height: 260px;
  margin: 0 auto;
}

.soda-cover {
  width: 260px;
  height: 260px;
  border-radius: 22px;
  background: linear-gradient(145deg, rgba(0, 203, 100, 0.22), rgba(0, 0, 0, 0.4)) center/cover no-repeat;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.4);
  position: relative;
  z-index: 2;
  overflow: hidden;
}

.soda-cover-fallback {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.soda-cover.has-image .soda-cover-fallback {
  display: none;
}

.soda-vinyl {
  position: absolute;
  right: -40px;
  top: 50%;
  width: 160px;
  height: 160px;
  margin-top: -80px;
  border-radius: 50%;
  background: radial-gradient(circle at center, #222 0 18%, #111 19% 22%, #1b1b1b 23% 100%);
  z-index: 1;
  opacity: 0.85;
}

.soda-vinyl.playing {
  animation: soda-spin 8s linear infinite;
}

@keyframes soda-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .soda-vinyl.playing { animation: none; }
}

.soda-panel {
  min-width: 0;
  background: rgba(18, 22, 20, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 20px;
  padding: 22px;
}

.soda-title {
  margin: 0;
  font-size: 26px;
  font-weight: 650;
  line-height: 1.3;
  word-break: break-word;
}

.soda-artist {
  margin: 8px 0 0;
  color: #7dffb0;
  font-size: 15px;
}

.soda-album {
  margin: 4px 0 0;
  font-size: 12px;
  color: rgba(244, 247, 245, 0.45);
}

.soda-lyric {
  margin-top: 16px;
  height: 170px;
  overflow: auto;
  mask-image: linear-gradient(to bottom, transparent, #000 12%, #000 88%, transparent);
}

.soda-lyric-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(244, 247, 245, 0.35);
  font-size: 13px;
}

.soda-lyric-line {
  position: relative;
  text-align: center;
  padding: 8px 6px;
  font-size: 15px;
  line-height: 1.55;
  color: rgba(244, 247, 245, 0.28);
}

.soda-lyric-line.active {
  color: rgba(244, 247, 245, 0.4);
  transform: scale(1.04);
}

.soda-lyric-line .base,
.soda-lyric-line .fill {
  display: block;
}

.soda-lyric-line .fill {
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  overflow: hidden;
  white-space: nowrap;
  color: #7dffb0;
  font-weight: 650;
  text-align: center;
  box-sizing: border-box;
  padding: 0 6px;
  pointer-events: none;
}

.soda-progress {
  margin-top: 18px;
  display: grid;
  grid-template-columns: 44px 1fr 44px;
  gap: 10px;
  align-items: center;
}

.soda-time {
  font-size: 12px;
  color: rgba(244, 247, 245, 0.45);
  font-variant-numeric: tabular-nums;
}

.soda-bar {
  position: relative;
  height: 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
  overflow: visible;
}

.soda-bar-fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #00cb64, #31e44c);
}

.soda-range {
  position: absolute;
  inset: -8px 0;
  width: 100%;
  opacity: 0;
  cursor: pointer;
}

.soda-controls {
  margin-top: 18px;
  display: flex;
  justify-content: center;
  gap: 14px;
}

.soda-play {
  box-shadow: 0 10px 28px rgba(0, 203, 100, 0.3);
}

.soda-hint {
  display: block;
  margin-top: 14px;
  text-align: center;
  font-size: 12px;
}
</style>
