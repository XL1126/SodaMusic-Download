<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  NButton,
  NCard,
  NIcon,
  NImage,
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

function syncLyricIndex(time) {
  const lines = lyricLines.value
  if (!lines.length) {
    activeLyricIndex.value = -1
    return
  }
  let idx = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (time + 0.15 >= lines[i].time) idx = i
    else break
  }
  if (idx !== activeLyricIndex.value) {
    activeLyricIndex.value = idx
    scrollLyricIntoView(idx)
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
      message.info('暂未获取到推荐曲目，可稍后重试或先在汽水音乐中听几首')
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
    } else if (currentIndex.value < 0 && merged.length > 0) {
      // 静默准备第一首信息，不强制播放
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
  <div class="recommend-page">
    <div class="toolbar">
      <div class="toolbar-left">
        <div class="title-row">
          <n-icon size="20" color="#18a058">
            <radio-outline />
          </n-icon>
          <span class="page-title">汽水推荐</span>
          <n-tag size="small" round type="success" :bordered="false">
            随机播放
          </n-tag>
        </div>
        <n-text depth="3" class="mode-hint">
          在浏览器中播放汽水随机推荐；封面与歌词走本地代理，更稳定。
        </n-text>
      </div>

      <n-button secondary size="small" :loading="loading" @click="loadQueueAndMaybePlay({ autoplay: false })">
        <template #icon>
          <n-icon>
            <refresh-outline />
          </n-icon>
        </template>
        换一批
      </n-button>
    </div>

    <n-spin :show="loading || starting">
      <n-card class="player-card" size="small" :bordered="true">
        <div class="player-body">
          <div class="cover-wrap">
            <n-image
              v-if="coverSrc"
              class="cover"
              :src="coverSrc"
              object-fit="cover"
              :alt="currentTrack?.name || 'cover'"
              width="240"
              height="240"
              :img-props="{ referrerpolicy: 'no-referrer' }"
              @error="coverSrc = ''"
            />
            <div v-else class="cover placeholder">
              <n-icon size="52" color="#18a058">
                <radio-outline />
              </n-icon>
            </div>
          </div>

          <div class="meta-lyric">
            <div class="meta-block">
              <div class="track-name">
                {{ currentTrack?.name || '点击播放，开始收听汽水推荐' }}
              </div>
              <div class="track-artist">
                {{ currentTrack?.artistText || currentTrack?.artists?.join(' / ') || '随机音乐 · 浏览器播放' }}
              </div>
              <div class="track-album">
                {{ currentTrack?.album || (queueSize ? `队列 ${queueSize} 首` : '等待推荐队列') }}
              </div>
            </div>

            <div ref="lyricListRef" class="lyric-panel">
              <div v-if="!lyricLines.length" class="lyric-empty">
                {{ currentTrack ? '暂无歌词' : '歌词将在此滚动显示' }}
              </div>
              <div
                v-for="(line, index) in lyricLines"
                :key="`${index}-${line.time}`"
                :data-lyric-index="index"
                class="lyric-line"
                :class="{ active: index === activeLyricIndex }"
              >
                {{ line.text }}
              </div>
            </div>
          </div>
        </div>

        <div class="progress-row">
          <span class="time">{{ formatTime(currentTime) }}</span>
          <input
            class="progress"
            type="range"
            min="0"
            :max="Math.max(duration, 0.1)"
            step="0.1"
            :value="currentTime"
            :style="{ '--progress': `${progressPercent}%` }"
            @input="onSeekInput"
          />
          <span class="time">{{ formatTime(duration) }}</span>
        </div>

        <div class="controls">
          <n-button secondary circle size="large" :disabled="!queueSize" @click="playRelative(-1)">
            <template #icon>
              <n-icon><play-skip-back-outline /></n-icon>
            </template>
          </n-button>
          <n-button
            type="primary"
            circle
            size="large"
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
          <n-button secondary circle size="large" :disabled="!queueSize" @click="playRelative(1)">
            <template #icon>
              <n-icon><play-skip-forward-outline /></n-icon>
            </template>
          </n-button>
        </div>

        <audio
          ref="audioRef"
          preload="none"
          @timeupdate="onTimeUpdate"
          @ended="onAudioEnded"
          @play="playing = true"
          @pause="playing = false"
        />
      </n-card>
    </n-spin>
  </div>
</template>

<style scoped>
.recommend-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 100%;
}

.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.page-title {
  font-size: 18px;
  font-weight: 600;
}

.mode-hint {
  display: block;
  margin-top: 6px;
  font-size: 12px;
}

.player-card {
  border-radius: 14px;
}

.player-body {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: 20px;
  min-height: 300px;
}

@media (max-width: 720px) {
  .player-body {
    grid-template-columns: 1fr;
  }
}

.cover-wrap {
  width: 240px;
  max-width: 100%;
}

@media (max-width: 720px) {
  .cover-wrap {
    width: min(240px, 70vw);
    margin: 0 auto;
  }
}

.cover {
  width: 240px;
  height: 240px;
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.18);
}

@media (max-width: 720px) {
  .cover {
    width: 100%;
  }
}

.cover.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background:
    radial-gradient(circle at 30% 20%, rgba(24, 160, 88, 0.25), transparent 50%),
    linear-gradient(145deg, #1f2a24, #121816);
  border: 1px solid rgba(24, 160, 88, 0.25);
}

.meta-lyric {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 10px;
}

.meta-block {
  min-height: 72px;
}

.track-name {
  font-size: 22px;
  font-weight: 650;
  line-height: 1.35;
  word-break: break-word;
}

.track-artist {
  margin-top: 8px;
  opacity: 0.85;
}

.track-album {
  margin-top: 4px;
  font-size: 12px;
  opacity: 0.65;
}

.lyric-panel {
  flex: 1;
  min-height: 180px;
  max-height: 260px;
  overflow: auto;
  padding: 8px 4px;
  mask-image: linear-gradient(to bottom, transparent, #000 12%, #000 88%, transparent);
}

.lyric-empty {
  height: 100%;
  min-height: 160px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.45;
  font-size: 13px;
}

.lyric-line {
  text-align: center;
  padding: 7px 8px;
  font-size: 14px;
  line-height: 1.5;
  opacity: 0.45;
  transition: opacity 0.2s ease, transform 0.2s ease, color 0.2s ease;
}

.lyric-line.active {
  opacity: 1;
  transform: scale(1.05);
  color: #18a058;
  font-weight: 600;
}

@media (prefers-reduced-motion: reduce) {
  .lyric-line {
    transition: none;
  }
}

.progress-row {
  display: grid;
  grid-template-columns: 44px 1fr 44px;
  gap: 10px;
  align-items: center;
  margin-top: 14px;
}

.time {
  font-size: 12px;
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}

.progress {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 6px;
  border-radius: 999px;
  background:
    linear-gradient(to right, #18a058 var(--progress, 0%), rgba(127, 127, 127, 0.28) var(--progress, 0%));
  outline: none;
  cursor: pointer;
}

.progress::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #18a058;
  border: 2px solid #fff;
}

.controls {
  margin-top: 14px;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 16px;
}
</style>
