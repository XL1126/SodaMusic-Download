<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  NButton,
  NCard,
  NEmpty,
  NFlex,
  NIcon,
  NImage,
  NRadioButton,
  NRadioGroup,
  NSpin,
  NTag,
  NText,
  NTooltip,
  createDiscreteApi,
} from 'naive-ui'
import {
  ListOutline,
  PauseOutline,
  PlaySkipBackOutline,
  PlaySkipForwardOutline,
  PlayOutline,
  RadioOutline,
  RefreshOutline,
} from '@vicons/ionicons5'
import { getStoredSession } from '../utils/authStorage'
import {
  controlLocalPlay,
  fetchLocalPlayStatus,
  fetchRecommendPlayInfo,
  fetchRecommendTracks,
  startLocalPlay,
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

const PLAY_MODE_KEY = 'sodaRecommend.playMode'
const playMode = ref(localStorage.getItem(PLAY_MODE_KEY) || 'browser')
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
const localStatus = ref(null)
const localTimer = ref(null)

const hasLogin = computed(() => Boolean(getStoredSession()?.sessionid))
const modeHint = computed(() => (
  playMode.value === 'browser'
    ? '在浏览器中播放，并注册系统媒体信息'
    : '通过后端在本机播放，系统可识别为音乐任务'
))

function persistMode() {
  localStorage.setItem(PLAY_MODE_KEY, playMode.value)
}

watch(playMode, () => {
  persistMode()
})

function formatTime(seconds) {
  const value = Number(seconds) || 0
  const m = Math.floor(value / 60)
  const s = Math.floor(value % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function parseApiError(error, fallback) {
  return error?.message || fallback
}

async function loadTracks({ silent = false } = {}) {
  if (!hasLogin.value) {
    message.warning('请先登录后再使用汽水推荐')
    return
  }

  if (!silent) loading.value = true
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
      if (!silent) message.info('暂未获取到推荐曲目，可稍后重试或先在汽水音乐中听几首')
      return
    }

    // 去重合并
    const seen = new Set(tracks.value.map((item) => item.id))
    const merged = [...tracks.value]
    for (const item of nextTracks) {
      if (!item?.id || seen.has(item.id)) continue
      seen.add(item.id)
      merged.push(item)
    }
    tracks.value = merged
    if (currentIndex.value < 0 && merged.length > 0) {
      // 不自动播放，仅准备列表
    }
  } catch (error) {
    message.error(parseApiError(error, '获取汽水推荐失败'))
  } finally {
    loading.value = false
  }
}

function clearLocalTimer() {
  if (localTimer.value) {
    clearInterval(localTimer.value)
    localTimer.value = null
  }
}

function updateMediaSession(track) {
  if (!('mediaSession' in navigator) || !track) return
  try {
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: track.name || '未知曲目',
      artist: track.artistText || track.artists?.join(' / ') || '',
      album: track.album || '汽水推荐',
      artwork: track.cover
        ? [{ src: track.cover, sizes: '400x400', type: 'image/jpeg' }]
        : [],
    })
    navigator.mediaSession.setActionHandler('play', () => togglePlay())
    navigator.mediaSession.setActionHandler('pause', () => togglePlay())
    navigator.mediaSession.setActionHandler('previoustrack', () => playRelative(-1))
    navigator.mediaSession.setActionHandler('nexttrack', () => playRelative(1))
  } catch {
    // 某些环境不支持 mediaSession
  }
}

function resetPlayerUi() {
  playing.value = false
  currentTime.value = 0
  duration.value = 0
  activeLyricIndex.value = -1
}

function stopLocalIfAny() {
  clearLocalTimer()
  localStatus.value = null
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
    duration: detail.duration || track.duration || 0,
    lyricLines: detail.lyricLines || [],
    lyricText: detail.lyricText || '',
    streamUrl: payload?.stream_url || '',
  }
}

async function playTrackAt(index, { autoplay = true } = {}) {
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
    updateMediaSession(info)

    if (playMode.value === 'browser') {
      stopLocalIfAny()
      streamUrl.value = info.streamUrl || ''
      await new Promise((resolve) => setTimeout(resolve, 0))
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
    } else {
      // 本机播放：清空浏览器音频
      if (audioRef.value) {
        audioRef.value.pause()
        audioRef.value.removeAttribute('src')
        audioRef.value.load()
      }
      streamUrl.value = ''
      const payload = await startLocalPlay(track.id)
      localStatus.value = payload?.local || null
      duration.value = Number(payload?.track?.duration || info.duration || localStatus.value?.duration || 0)
      playing.value = Boolean(localStatus.value?.playing)
      message.success('已切换到本机播放')
      startLocalStatusPolling()
    }
  } catch (error) {
    message.error(parseApiError(error, '播放失败'))
  } finally {
    starting.value = false
  }
}

function startLocalStatusPolling() {
  clearLocalTimer()
  localTimer.value = setInterval(async () => {
    try {
      const payload = await fetchLocalPlayStatus()
      localStatus.value = payload?.local || null
      playing.value = Boolean(payload?.local?.playing)
      currentTime.value = Number(payload?.local?.position || 0)
      if (Number(payload?.local?.duration) > 0) {
        duration.value = Number(payload.local.duration)
      }
      syncLyricIndex(currentTime.value)
      if (payload?.local && payload.local.playing === false && Number(payload.local.position) > 0 && /结束/.test(payload.local.message || '')) {
        playRelative(1)
      }
    } catch {
      // 忽略轮询错误
    }
  }, 800)
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

async function togglePlay() {
  if (!currentTrack.value) {
    if (tracks.value.length > 0) {
      await playTrackAt(currentIndex.value >= 0 ? currentIndex.value : 0)
    }
    return
  }

  if (playMode.value === 'browser') {
    const audio = audioRef.value
    if (!audio) return
    if (audio.paused) {
      try {
        await audio.play()
        playing.value = true
      } catch (error) {
        message.error(parseApiError(error, '播放失败'))
      }
    } else {
      audio.pause()
      playing.value = false
    }
    return
  }

  // 本机
  const action = playing.value ? 'pause' : 'resume'
  try {
    const payload = await controlLocalPlay(action)
    localStatus.value = payload?.local || null
    playing.value = Boolean(payload?.local?.playing)
  } catch (error) {
    message.error(parseApiError(error, '控制失败'))
  }
}

async function playRelative(step) {
  if (tracks.value.length === 0) return
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
  if (playMode.value === 'browser' && audioRef.value) {
    audioRef.value.currentTime = value
  }
  syncLyricIndex(value)
}

async function onSeekChange() {
  if (playMode.value === 'local') {
    message.info('本机播放暂不支持拖动进度，可在系统媒体控件中查看')
  }
}

function handleModeChange(value) {
  playMode.value = value
  // 切换模式后若已有曲目，重新走播放链路
  if (currentTrack.value && currentIndex.value >= 0) {
    playTrackAt(currentIndex.value)
  }
}

const progressPercent = computed(() => {
  if (!duration.value) return 0
  return Math.min(100, (currentTime.value / duration.value) * 100)
})

onMounted(async () => {
  if (props.isAuthenticated || hasLogin.value) {
    await loadTracks()
  }
})

onBeforeUnmount(() => {
  clearLocalTimer()
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
          {{ modeHint }}
        </n-text>
      </div>

      <div class="toolbar-right">
        <n-radio-group
          :value="playMode"
          size="small"
          @update:value="handleModeChange"
        >
          <n-radio-button value="browser">
            浏览器播放
          </n-radio-button>
          <n-radio-button value="local">
            本机播放
          </n-radio-button>
        </n-radio-group>
        <n-tooltip>
          <template #trigger>
            <n-button secondary size="small" :loading="loading" @click="loadTracks()">
              <template #icon>
                <n-icon>
                  <refresh-outline />
                </n-icon>
              </template>
              换一批
            </n-button>
          </template>
          拉取新的随机推荐曲目
        </n-tooltip>
      </div>
    </div>

    <div class="content-grid">
      <n-card class="player-card" size="small" :bordered="true">
        <div class="player-body">
          <div class="cover-wrap">
            <n-image
              v-if="currentTrack?.cover"
              class="cover"
              :src="currentTrack.cover"
              object-fit="cover"
              :alt="currentTrack.name"
              width="220"
              height="220"
            />
            <div v-else class="cover placeholder">
              <n-icon size="48" color="#18a058">
                <radio-outline />
              </n-icon>
            </div>
            <div class="cover-glow" />
          </div>

          <div class="meta-lyric">
            <div class="meta-block">
              <div class="track-name">
                {{ currentTrack?.name || '选择一首推荐曲目开始播放' }}
              </div>
              <div class="track-artist">
                {{ currentTrack?.artistText || currentTrack?.artists?.join(' / ') || '汽水推荐 · 随机音乐' }}
              </div>
              <div class="track-album">
                {{ currentTrack?.album || (playMode === 'local' ? '本机播放模式' : '浏览器播放模式') }}
              </div>
              <n-tag v-if="playMode === 'local'" size="small" type="info" :bordered="false" round>
                系统媒体任务
              </n-tag>
            </div>

            <div ref="lyricListRef" class="lyric-panel">
              <div
                v-if="!lyricLines.length"
                class="lyric-empty"
              >
                {{ currentTrack ? '暂无歌词或歌词加载中' : '歌词将在此滚动显示' }}
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
            @change="onSeekChange"
          />
          <span class="time">{{ formatTime(duration) }}</span>
        </div>

        <div class="controls">
          <n-button secondary circle size="large" :disabled="!tracks.length" @click="playRelative(-1)">
            <template #icon>
              <n-icon><play-skip-back-outline /></n-icon>
            </template>
          </n-button>
          <n-button
            type="primary"
            circle
            size="large"
            :loading="starting"
            :disabled="!tracks.length && !currentTrack"
            @click="togglePlay"
          >
            <template #icon>
              <n-icon size="22">
                <pause-outline v-if="playing" />
                <play-outline v-else />
              </n-icon>
            </template>
          </n-button>
          <n-button secondary circle size="large" :disabled="!tracks.length" @click="playRelative(1)">
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

      <n-card class="list-card" size="small" :bordered="true">
        <div class="list-header">
          <n-flex align="center" :size="8">
            <n-icon color="#18a058"><list-outline /></n-icon>
            <span>推荐列表</span>
            <n-tag size="small" :bordered="false">{{ tracks.length }}</n-tag>
          </n-flex>
        </div>

        <n-spin :show="loading && tracks.length === 0">
          <n-empty
            v-if="!tracks.length && !loading"
            description="暂无推荐。请确认已登录，然后点击「换一批」"
          >
            <template #extra>
              <n-button type="primary" size="small" @click="loadTracks()">
                获取推荐
              </n-button>
            </template>
          </n-empty>

          <div v-else class="track-list">
            <button
              v-for="(item, index) in tracks"
              :key="item.id"
              type="button"
              class="track-item"
              :class="{ active: index === currentIndex }"
              @click="playTrackAt(index)"
            >
              <span class="idx">{{ String(index + 1).padStart(2, '0') }}</span>
              <img
                v-if="item.cover"
                class="thumb"
                :src="item.cover"
                :alt="item.name"
                referrerpolicy="no-referrer"
              />
              <div v-else class="thumb placeholder-thumb" />
              <div class="item-main">
                <div class="item-name">{{ item.name }}</div>
                <div class="item-artist">{{ item.artistText || item.artists?.join(' / ') || '未知歌手' }}</div>
              </div>
              <span class="item-duration">
                {{ item.duration ? formatTime(item.duration) : '--:--' }}
              </span>
            </button>
          </div>
        </n-spin>
      </n-card>
    </div>
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

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.content-grid {
  display: grid;
  grid-template-columns: minmax(320px, 1.1fr) minmax(280px, 0.9fr);
  gap: 16px;
  align-items: stretch;
}

@media (max-width: 960px) {
  .content-grid {
    grid-template-columns: 1fr;
  }
}

.player-card,
.list-card {
  border-radius: 14px;
  height: 100%;
}

.player-body {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 16px;
  min-height: 280px;
}

@media (max-width: 720px) {
  .player-body {
    grid-template-columns: 1fr;
  }
}

.cover-wrap {
  position: relative;
  width: 220px;
  height: 220px;
}

@media (max-width: 720px) {
  .cover-wrap {
    width: 100%;
    max-width: 260px;
    margin: 0 auto;
  }
}

.cover {
  width: 220px;
  height: 220px;
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.18);
  position: relative;
  z-index: 1;
}

@media (max-width: 720px) {
  .cover {
    width: 100%;
    max-width: 260px;
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

.cover-glow {
  position: absolute;
  inset: 20px;
  border-radius: 16px;
  background: rgba(24, 160, 88, 0.18);
  filter: blur(24px);
  z-index: 0;
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
  font-size: 20px;
  font-weight: 650;
  line-height: 1.35;
  word-break: break-word;
}

.track-artist {
  margin-top: 6px;
  opacity: 0.85;
}

.track-album {
  margin-top: 4px;
  font-size: 12px;
  opacity: 0.65;
}

.lyric-panel {
  flex: 1;
  min-height: 160px;
  max-height: 220px;
  overflow: auto;
  padding: 8px 4px;
  mask-image: linear-gradient(to bottom, transparent, #000 12%, #000 88%, transparent);
}

.lyric-empty {
  height: 100%;
  min-height: 140px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.45;
  font-size: 13px;
}

.lyric-line {
  text-align: center;
  padding: 6px 8px;
  font-size: 14px;
  line-height: 1.5;
  opacity: 0.45;
  transform: scale(0.98);
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
  margin-top: 12px;
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
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
}

.progress::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #18a058;
  border: 2px solid #fff;
}

.controls {
  margin-top: 12px;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 16px;
}

.list-header {
  margin-bottom: 10px;
  font-weight: 600;
}

.track-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 560px;
  overflow: auto;
}

.track-item {
  width: 100%;
  display: grid;
  grid-template-columns: 28px 40px 1fr auto;
  gap: 10px;
  align-items: center;
  border: 1px solid transparent;
  background: transparent;
  border-radius: 10px;
  padding: 8px;
  cursor: pointer;
  text-align: left;
  color: inherit;
}

.track-item:hover,
.track-item:focus-visible {
  background: rgba(24, 160, 88, 0.08);
  outline: none;
}

.track-item.active {
  border-color: rgba(24, 160, 88, 0.35);
  background: rgba(24, 160, 88, 0.12);
}

.idx {
  font-size: 12px;
  opacity: 0.55;
  font-variant-numeric: tabular-nums;
}

.thumb {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  object-fit: cover;
  background: rgba(127, 127, 127, 0.15);
}

.placeholder-thumb {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  background: rgba(127, 127, 127, 0.15);
}

.item-main {
  min-width: 0;
}

.item-name {
  font-size: 14px;
  font-weight: 550;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-artist {
  margin-top: 2px;
  font-size: 12px;
  opacity: 0.65;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-duration {
  font-size: 12px;
  opacity: 0.55;
  font-variant-numeric: tabular-nums;
}
</style>
