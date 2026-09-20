<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
  VolumeHighOutline,
  VolumeLowOutline,
  VolumeMuteOutline,
} from '@vicons/ionicons5'
import { getStoredSession } from '../utils/authStorage'
import {
  ensureWindowPrepared,
  getPreparedTrack,
  getRecommendSnapshot,
  refreshRecommendQueue,
  setCurrentIndex,
  subscribeRecommendQueue,
  warmupRecommendQueue,
} from '../utils/recommendQueue'

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

const VOLUME_KEY = 'sodaRecommend.volume'

const loading = ref(false)
const starting = ref(false)
const currentIndex = ref(-1)
const tracks = ref([])
const currentTrack = ref(null)
const lyricLines = ref([])
const activeLyricIndex = ref(-1)
const activeLineProgress = ref(0)
const streamUrl = ref('')
const audioRef = ref(null)
const lyricListRef = ref(null)
const barRef = ref(null)
const playing = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const coverSrc = ref('')
const volume = ref(clampVolume(Number(localStorage.getItem(VOLUME_KEY))))
const seeking = ref(false)
const seekPreviewTime = ref(0)
const unsubscribe = ref(null)

const hasLogin = computed(() => Boolean(getStoredSession()?.sessionid))
const queueSize = computed(() => tracks.value.length)
const displayTime = computed(() => (seeking.value ? seekPreviewTime.value : currentTime.value))
const progressPercent = computed(() => {
  const total = duration.value
  if (!total || !Number.isFinite(total)) return 0
  return Math.min(100, Math.max(0, (displayTime.value / total) * 100))
})
const volumeIcon = computed(() => {
  if (volume.value <= 0) return VolumeMuteOutline
  if (volume.value < 0.45) return VolumeLowOutline
  return VolumeHighOutline
})

function clampVolume(value) {
  if (!Number.isFinite(value)) return 0.8
  return Math.min(1, Math.max(0, value))
}

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

function syncSnapshot(snapshot) {
  tracks.value = snapshot.tracks || []
  currentIndex.value = snapshot.currentIndex
  loading.value = Boolean(snapshot.loading)
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

function applyVolumeToAudio() {
  const audio = audioRef.value
  if (!audio) return
  audio.volume = clampVolume(volume.value)
}

function resetPlayerUi() {
  playing.value = false
  currentTime.value = 0
  duration.value = 0
  seeking.value = false
  seekPreviewTime.value = 0
  activeLyricIndex.value = -1
  activeLineProgress.value = 0
}

function applyTrackToUi(info) {
  currentTrack.value = info
  lyricLines.value = info.lyricLines || []
  duration.value = Number(info.duration) || 0
  coverSrc.value = resolveCover(info)
  streamUrl.value = info.streamUrl || ''
  updateMediaSession(info)
  syncLyricIndex(0)
}

async function loadIntoAudio(info, { autoplay = true } = {}) {
  const audio = audioRef.value
  if (!audio || !info?.streamUrl) {
    throw new Error('未能获取浏览器播放地址')
  }

  applyVolumeToAudio()
  audio.src = info.streamUrl
  audio.load()

  await new Promise((resolve) => {
    const onReady = () => {
      cleanup()
      resolve()
    }
    const onFail = () => {
      cleanup()
      resolve()
    }
    const cleanup = () => {
      audio.removeEventListener('loadedmetadata', onReady)
      audio.removeEventListener('error', onFail)
    }
    audio.addEventListener('loadedmetadata', onReady, { once: true })
    audio.addEventListener('error', onFail, { once: true })
    // 兜底，避免事件未触发卡死
    setTimeout(cleanup, 8000)
  })

  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    duration.value = audio.duration
  }

  if (autoplay) {
    await audio.play()
    playing.value = true
  }
}

async function playTrackAt(index, { autoplay = true } = {}) {
  if (!tracks.value.length) {
    await warmupRecommendQueue()
    syncSnapshot(getRecommendSnapshot())
  }
  if (!tracks.value.length) {
    message.info('暂无推荐曲目，请先登录或稍后重试')
    return
  }

  const target = ((index % tracks.value.length) + tracks.value.length) % tracks.value.length
  starting.value = true
  resetPlayerUi()

  try {
    setCurrentIndex(target)
    currentIndex.value = target

    const prepared = await getPreparedTrack(target)
    const info = prepared?.track || tracks.value[target]
    if (!info?.streamUrl) {
      throw new Error('该曲目暂无播放地址')
    }

    tracks.value[target] = { ...tracks.value[target], ...info }
    applyTrackToUi(info)
    await loadIntoAudio(info, { autoplay })
    ensureWindowPrepared()
  } catch (error) {
    message.error(parseApiError(error, '播放失败'))
  } finally {
    starting.value = false
  }
}

async function togglePlay() {
  const audio = audioRef.value
  if (!audio || !currentTrack.value) {
    await playTrackAt(currentIndex.value >= 0 ? currentIndex.value : 0)
    return
  }

  if (audio.paused) {
    try {
      if (!audio.src && streamUrl.value) {
        await loadIntoAudio(currentTrack.value, { autoplay: true })
        return
      }
      applyVolumeToAudio()
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
  const next = ((currentIndex.value + step) % tracks.value.length + tracks.value.length) % tracks.value.length
  await playTrackAt(next)
}

function onTimeUpdate() {
  if (seeking.value) return
  const audio = audioRef.value
  if (!audio) return
  currentTime.value = audio.currentTime || 0
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    duration.value = audio.duration
  }
  syncLyricIndex(currentTime.value)
}

function onLoadedMetadata() {
  const audio = audioRef.value
  if (!audio) return
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    duration.value = audio.duration
  }
}

async function onAudioEnded() {
  playing.value = false
  await playRelative(1)
}

function timeFromPointer(event) {
  const bar = barRef.value
  if (!bar) return 0
  const rect = bar.getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
  const total = duration.value
  if (!total || !Number.isFinite(total)) return 0
  return ratio * total
}

function onBarPointerDown(event) {
  if (!duration.value || !Number.isFinite(duration.value)) return
  seeking.value = true
  seekPreviewTime.value = timeFromPointer(event)
  try {
    event.currentTarget.setPointerCapture?.(event.pointerId)
  } catch {
    // ignore
  }
}

function onBarPointerMove(event) {
  if (!seeking.value) return
  seekPreviewTime.value = timeFromPointer(event)
}

async function onBarPointerUp(event) {
  if (!seeking.value) return
  const targetTime = timeFromPointer(event)
  seeking.value = false
  seekPreviewTime.value = targetTime
  currentTime.value = targetTime
  syncLyricIndex(targetTime)

  const audio = audioRef.value
  if (!audio) return
  try {
    if (!audio.src && streamUrl.value) {
      await loadIntoAudio(currentTrack.value, { autoplay: playing.value })
    }
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      duration.value = audio.duration
    }
    audio.currentTime = Math.min(targetTime, Math.max(0, duration.value - 0.05))
  } catch (error) {
    message.error(parseApiError(error, '调整进度失败'))
  }
}

function onVolumeInput(event) {
  const value = clampVolume(Number(event.target.value))
  volume.value = value
  localStorage.setItem(VOLUME_KEY, String(value))
  applyVolumeToAudio()
}

function toggleMute() {
  volume.value = volume.value > 0 ? 0 : 0.8
  localStorage.setItem(VOLUME_KEY, String(volume.value))
  applyVolumeToAudio()
}

async function handleRefresh() {
  try {
    loading.value = true
    await refreshRecommendQueue({ append: true })
    syncSnapshot(getRecommendSnapshot())
    message.success('已刷新推荐队列')
    ensureWindowPrepared()
  } catch (error) {
    message.error(parseApiError(error, '刷新推荐失败'))
  } finally {
    loading.value = false
  }
}

watch(volume, () => {
  applyVolumeToAudio()
})

onMounted(async () => {
  unsubscribe.value = subscribeRecommendQueue(syncSnapshot)
  syncSnapshot(getRecommendSnapshot())

  if (props.isAuthenticated || hasLogin.value) {
    if (!tracks.value.length) {
      await warmupRecommendQueue()
      syncSnapshot(getRecommendSnapshot())
    }
    // 进入页面时准备当前曲，不强制自动播放（浏览器策略）
    if (currentIndex.value >= 0 && tracks.value.length) {
      await playTrackAt(currentIndex.value, { autoplay: false })
    }
  }
})

onBeforeUnmount(() => {
  unsubscribe.value?.()
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
      <n-button secondary size="small" :loading="loading" @click="handleRefresh">
        <template #icon>
          <n-icon><refresh-outline /></n-icon>
        </template>
        换一批
      </n-button>
    </div>

    <n-spin :show="loading || starting">
      <div class="soda-layout">
        <div class="soda-left">
          <div
            class="soda-cover"
            :class="{ 'has-image': coverSrc }"
            :style="coverSrc ? { backgroundImage: `url(${coverSrc})` } : null"
          >
            <div class="soda-cover-fallback">
              <n-icon size="52" color="#00cb64">
                <radio-outline />
              </n-icon>
            </div>
          </div>
          <div class="soda-vinyl" :class="{ playing }" />
        </div>

        <section class="soda-right">
          <div class="soda-meta">
            <h1 class="soda-title">
              {{ currentTrack?.name || '汽水推荐' }}
            </h1>
            <p class="soda-artist">
              {{ currentTrack?.artistText || currentTrack?.artists?.join(' / ') || '随机音乐' }}
            </p>
            <p class="soda-album">
              {{ currentTrack?.album || '浏览器播放' }}
              <span v-if="queueSize"> · 队列 {{ queueSize }}</span>
            </p>
          </div>

          <div ref="lyricListRef" class="soda-lyric">
            <div v-if="!lyricLines.length" class="soda-lyric-empty">
              {{ currentTrack ? '暂无歌词' : '启动项目后会自动预取随机音乐' }}
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
        </section>
      </div>

      <div class="soda-bottom">
        <div
          ref="barRef"
          class="soda-progress"
          @pointerdown="onBarPointerDown"
          @pointermove="onBarPointerMove"
          @pointerup="onBarPointerUp"
          @pointercancel="onBarPointerUp"
        >
          <span class="soda-time">{{ formatTime(displayTime) }}</span>
          <div class="soda-bar">
            <div class="soda-bar-fill" :style="{ width: `${progressPercent}%` }" />
            <div class="soda-bar-thumb" :style="{ left: `${progressPercent}%` }" />
          </div>
          <span class="soda-time">{{ formatTime(duration) }}</span>
        </div>

        <div class="soda-controls">
          <div class="soda-volume">
            <n-button text class="soda-volume-btn" @click="toggleMute">
              <template #icon>
                <n-icon :size="18"><component :is="volumeIcon" /></n-icon>
              </template>
            </n-button>
            <input
              class="soda-volume-range"
              type="range"
              min="0"
              max="1"
              step="0.01"
              :value="volume"
              @input="onVolumeInput"
            />
            <span class="soda-volume-text">{{ Math.round(volume * 100) }}%</span>
          </div>

          <div class="soda-buttons">
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
            启动即预取 · 当前曲上下各缓冲 2 首
          </n-text>
        </div>
      </div>
    </n-spin>

    <audio
      ref="audioRef"
      preload="auto"
      @timeupdate="onTimeUpdate"
      @loadedmetadata="onLoadedMetadata"
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
    radial-gradient(circle at 18% 18%, rgba(0, 203, 100, 0.22), transparent 42%),
    radial-gradient(circle at 80% 0%, rgba(49, 228, 76, 0.1), transparent 34%),
    linear-gradient(160deg, #101814, #090c0a 60%, #0d1410);
  border-radius: 18px;
  z-index: 0;
}

.soda-top,
.soda-layout,
.soda-bottom {
  position: relative;
  z-index: 1;
}

.soda-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.soda-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.soda-layout {
  display: grid;
  grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
  gap: 28px;
  align-items: stretch;
}

@media (max-width: 760px) {
  .soda-layout {
    grid-template-columns: 1fr;
  }
}

.soda-left {
  position: relative;
  display: flex;
  justify-content: center;
  align-items: flex-start;
}

.soda-cover {
  width: min(280px, 70vw);
  aspect-ratio: 1;
  border-radius: 24px;
  background: linear-gradient(145deg, rgba(0, 203, 100, 0.22), rgba(0, 0, 0, 0.4)) center/cover no-repeat;
  box-shadow: 0 22px 50px rgba(0, 0, 0, 0.42);
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
  right: max(0px, calc(50% - 180px));
  top: 50%;
  width: 150px;
  height: 150px;
  margin-top: -75px;
  border-radius: 50%;
  background: radial-gradient(circle at center, #222 0 18%, #111 19% 22%, #1b1b1b 23% 100%);
  z-index: 1;
  opacity: 0.88;
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

.soda-right {
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: rgba(18, 22, 20, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 20px;
  padding: 22px 24px;
  min-height: 320px;
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

/* 歌词区：隐藏滚动条 */
.soda-lyric {
  margin-top: 14px;
  flex: 1;
  min-height: 180px;
  max-height: 260px;
  overflow: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
  mask-image: linear-gradient(to bottom, transparent, #000 10%, #000 90%, transparent);
}

.soda-lyric::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}

.soda-lyric-empty {
  height: 100%;
  min-height: 160px;
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

.soda-bottom {
  margin-top: 18px;
  background: rgba(18, 22, 20, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 20px;
  padding: 16px 20px 18px;
}

.soda-progress {
  display: grid;
  grid-template-columns: 44px 1fr 44px;
  gap: 10px;
  align-items: center;
  user-select: none;
  touch-action: none;
  cursor: pointer;
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
}

.soda-bar-fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #00cb64, #31e44c);
  pointer-events: none;
}

.soda-bar-thumb {
  position: absolute;
  top: 50%;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid #00cb64;
  transform: translate(-50%, -50%);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  pointer-events: none;
}

.soda-controls {
  margin-top: 14px;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 12px;
  align-items: center;
}

.soda-volume {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.soda-volume-btn {
  color: rgba(244, 247, 245, 0.85);
}

.soda-volume-range {
  width: min(140px, 28vw);
  accent-color: #00cb64;
}

.soda-volume-text {
  font-size: 12px;
  color: rgba(244, 247, 245, 0.45);
  min-width: 36px;
  font-variant-numeric: tabular-nums;
}

.soda-buttons {
  display: flex;
  justify-content: center;
  gap: 14px;
}

.soda-play {
  box-shadow: 0 10px 28px rgba(0, 203, 100, 0.3);
}

.soda-hint {
  justify-self: end;
  font-size: 12px;
  text-align: right;
}

@media (max-width: 760px) {
  .soda-controls {
    grid-template-columns: 1fr;
  }

  .soda-volume,
  .soda-hint {
    justify-content: center;
    justify-self: center;
  }
}
</style>
