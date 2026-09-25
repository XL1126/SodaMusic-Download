<script setup>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import {
  NButton,
  NIcon,
  NSpin,
  NTag,
  createDiscreteApi,
} from 'naive-ui'
import {
  Heart,
  HeartOutline,
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
import { createPlayEngine } from '../utils/playEngine'
import {
  ensureWindowPrepared,
  getPreparedTrack,
  getRecommendSnapshot,
  refreshRecommendQueue,
  setCurrentIndex,
  subscribeRecommendQueue,
  warmupRecommendQueue,
} from '../utils/recommendQueue'
import {
  likeRecommendTrack,
  reportRecommendPlay,
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

const VOLUME_KEY = 'sodaRecommend.volume'
const REPORT_EVERY_MS = 15000

const loading = ref(false)
const starting = ref(false)
const currentIndex = ref(-1)
const tracks = ref([])
const currentTrack = ref(null)
const lyricLines = ref([])
const activeLyricIndex = ref(-1)
const activeLineProgress = ref(0)
const lyricListRef = ref(null)
const barRef = ref(null)
const playing = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const coverSrc = ref('')
const volume = ref(clampVolume(Number(localStorage.getItem(VOLUME_KEY))))
const muted = ref(false)
const seeking = ref(false)
const seekPreviewTime = ref(0)
const liked = ref(false)
const liking = ref(false)
const playError = ref('')
const unsubscribe = ref(null)
const engine = shallowRef(null)
const startedAt = ref(0)
const lastReportMs = ref(0)
const mediaSessionHandlers = ref(false)

const hasLogin = computed(() => Boolean(getStoredSession()?.sessionid))
const queueSize = computed(() => tracks.value.length)
const displayTime = computed(() => (seeking.value ? seekPreviewTime.value : currentTime.value))
const progressPercent = computed(() => {
  const total = duration.value
  if (!total || !Number.isFinite(total) || total <= 0) return 0
  return Math.min(100, Math.max(0, (displayTime.value / total) * 100))
})
const volumeIcon = computed(() => {
  if (muted.value || volume.value <= 0) return VolumeMuteOutline
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
    if (!mediaSessionHandlers.value) {
      navigator.mediaSession.setActionHandler('play', () => engine.value?.play().catch(() => {}))
      navigator.mediaSession.setActionHandler('pause', () => engine.value?.pause())
      navigator.mediaSession.setActionHandler('previoustrack', () => playRelative(-1))
      navigator.mediaSession.setActionHandler('nexttrack', () => playRelative(1))
      mediaSessionHandlers.value = true
    }
    navigator.mediaSession.playbackState = playing.value ? 'playing' : 'paused'
  } catch {
    // ignore
  }
}

async function flushPlayReport(event = 'progress') {
  if (!currentTrack.value?.id || !startedAt.value) return
  const playedMs = engine.value?.getPlayedMs() || 0
  if (playedMs < 500 && event === 'progress') return

  await reportRecommendPlay({
    trackId: currentTrack.value.id,
    playMs: playedMs,
    startedAt: startedAt.value,
    scene: 'recommend',
    event,
  })
  engine.value?.resetPlayedMs()
  lastReportMs.value = Date.now()
}

function onEngineChange(payload) {
  playing.value = payload.playing
  if (!seeking.value) {
    currentTime.value = payload.currentTime || 0
  }
  if (payload.duration > 0) {
    duration.value = payload.duration
  }
  playError.value = payload.error || ''
  syncLyricIndex(displayTime.value)

  if (playing.value && 'mediaSession' in navigator) {
    try {
      navigator.mediaSession.playbackState = 'playing'
    } catch {
      // ignore
    }
  } else if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.playbackState = 'paused'
    } catch {
      // ignore
    }
  }

  if (playing.value && startedAt.value && Date.now() - lastReportMs.value >= REPORT_EVERY_MS) {
    flushPlayReport('progress').catch(() => {})
  }
}

function applyTrackToUi(info) {
  currentTrack.value = info
  lyricLines.value = info.lyricLines || []
  duration.value = Number(info.duration) || 0
  coverSrc.value = resolveCover(info)
  liked.value = Boolean(info.liked || info.isCollected)
  activeLyricIndex.value = -1
  activeLineProgress.value = 0
  syncLyricIndex(0)
  updateMediaSession(info)
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
  playError.value = ''

  // 切歌前结算上一首播放时长
  await flushPlayReport('ended').catch(() => {})

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

    startedAt.value = Date.now()
    await engine.value.load({
      src: info.streamUrl,
      trackId: info.id,
      autoplay,
      startAt: 0,
    })

    ensureWindowPrepared()
  } catch (error) {
    // 自动播放被拒绝时不算致命错误，展示可点击播放
    const msg = parseApiError(error, '播放失败')
    if (/play\(\)|NotAllowedError|用户没有交互/i.test(msg)) {
      playError.value = '点击播放按钮开始收听'
    } else {
      playError.value = msg
      message.error(msg)
      // 失败自动跳下一首（避免卡死）
      if (tracks.value.length > 1) {
        setTimeout(() => {
          playRelative(1)
        }, 400)
      }
    }
  } finally {
    starting.value = false
  }
}

async function togglePlay() {
  if (!engine.value) return
  if (!currentTrack.value) {
    await playTrackAt(currentIndex.value >= 0 ? currentIndex.value : 0)
    return
  }

  try {
    await engine.value.toggle()
    playError.value = ''
  } catch (error) {
    playError.value = parseApiError(error, '播放失败')
    message.error(playError.value)
  }
}

async function playRelative(step) {
  if (!tracks.value.length) return
  const next = ((currentIndex.value + step) % tracks.value.length + tracks.value.length) % tracks.value.length
  await playTrackAt(next)
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
  if (!duration.value || !Number.isFinite(duration.value) || duration.value <= 0) return
  seeking.value = true
  engine.value?.beginSeek()
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
  seeking.value = true
  seekPreviewTime.value = targetTime

  try {
    const next = await engine.value.commitSeek(targetTime)
    currentTime.value = next
    seekPreviewTime.value = next
    syncLyricIndex(next)
    playError.value = ''
  } catch (error) {
    playError.value = parseApiError(error, '调整进度失败')
    message.error(playError.value)
  } finally {
    seeking.value = false
  }
}

function onVolumeInput(event) {
  const value = clampVolume(Number(event.target.value))
  volume.value = value
  muted.value = value <= 0
  localStorage.setItem(VOLUME_KEY, String(value))
  engine.value?.setVolume(value)
  engine.value?.setMuted(value <= 0)
}

function toggleMute() {
  muted.value = !muted.value
  if (!muted.value && volume.value <= 0) {
    volume.value = 0.8
    localStorage.setItem(VOLUME_KEY, String(volume.value))
  }
  engine.value?.setMuted(muted.value)
  if (!muted.value) engine.value?.setVolume(volume.value)
}

async function toggleLike() {
  if (!currentTrack.value?.id) return
  if (!hasLogin.value && !props.isAuthenticated) {
    message.warning('请先登录后再点赞')
    return
  }
  if (liking.value) return

  const next = !liked.value
  liking.value = true
  // 乐观更新
  liked.value = next
  currentTrack.value = {
    ...currentTrack.value,
    liked: next,
    isCollected: next,
  }

  try {
    await likeRecommendTrack(currentTrack.value.id, next)
    message.success(next ? '已添加到喜欢' : '已取消喜欢')
  } catch (error) {
    // 回滚
    liked.value = !next
    currentTrack.value = {
      ...currentTrack.value,
      liked: !next,
      isCollected: !next,
    }
    message.error(parseApiError(error, next ? '点赞失败' : '取消点赞失败'))
  } finally {
    liking.value = false
  }
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

onMounted(async () => {
  engine.value = createPlayEngine({ onChange: onEngineChange })
  engine.value.setVolume(volume.value)
  engine.value.setMuted(muted.value)

  unsubscribe.value = subscribeRecommendQueue(syncSnapshot)
  syncSnapshot(getRecommendSnapshot())

  if (props.isAuthenticated || hasLogin.value) {
    if (!tracks.value.length) {
      await warmupRecommendQueue()
      syncSnapshot(getRecommendSnapshot())
    }
    if (currentIndex.value >= 0 && tracks.value.length) {
      await playTrackAt(currentIndex.value, { autoplay: false })
    }
  }
})

onBeforeUnmount(async () => {
  unsubscribe.value?.()
  await flushPlayReport('ended').catch(() => {})
  engine.value?.destroy()
  engine.value = null
})
</script>

<template>
  <div class="soda-player">
    <div class="soda-backdrop" :style="coverSrc ? { backgroundImage: `url(${coverSrc})` } : null" />
    <div class="soda-shade" />

    <div class="soda-topbar">
      <div class="soda-brand">
        <span class="soda-logo" />
        <span>汽水推荐</span>
        <span class="soda-pill">随机播放</span>
      </div>
      <button class="soda-ghost-btn" type="button" :disabled="loading" @click="handleRefresh">
        <n-icon :size="16"><refresh-outline /></n-icon>
        <span>换一批</span>
      </button>
    </div>

    <n-spin :show="loading || starting">
      <div class="soda-stage">
        <aside class="soda-left">
          <div
            class="soda-cover"
            :class="{ 'has-image': coverSrc }"
            :style="coverSrc ? { backgroundImage: `url(${coverSrc})` } : null"
          >
            <div class="soda-cover-fallback">
              <n-icon size="56" color="#00e27a">
                <radio-outline />
              </n-icon>
            </div>
          </div>

          <div class="soda-song">
            <div class="soda-song-title">
              {{ currentTrack?.name || '汽水推荐' }}
            </div>
            <div class="soda-song-artist">
              {{ currentTrack?.artistText || currentTrack?.artists?.join(' / ') || '随机音乐' }}
            </div>
            <div class="soda-song-sub">
              {{ currentTrack?.album || '浏览器播放' }}
              <span v-if="queueSize"> · 队列 {{ queueSize }}</span>
            </div>

            <button
              class="soda-like"
              :class="{ active: liked }"
              type="button"
              :disabled="liking || !currentTrack?.id"
              @click="toggleLike"
            >
              <n-icon :size="20">
                <heart v-if="liked" />
                <heart-outline v-else />
              </n-icon>
              <span>{{ liked ? '已喜欢' : '喜欢' }}</span>
            </button>
          </div>
        </aside>

        <section class="soda-right">
          <div ref="lyricListRef" class="soda-lyric">
            <div v-if="!lyricLines.length" class="soda-lyric-empty">
              {{ currentTrack ? '暂无歌词' : '启动后会自动预取随机音乐' }}
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

          <div v-if="playError" class="soda-error">
            {{ playError }}
          </div>
        </section>
      </div>

      <div class="soda-control">
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

        <div class="soda-actions">
          <div class="soda-volume">
            <button class="soda-icon-btn" type="button" @click="toggleMute">
              <n-icon :size="18"><component :is="volumeIcon" /></n-icon>
            </button>
            <input
              class="soda-volume-range"
              type="range"
              min="0"
              max="1"
              step="0.01"
              :value="muted ? 0 : volume"
              @input="onVolumeInput"
            />
            <span class="soda-volume-text">{{ Math.round((muted ? 0 : volume) * 100) }}%</span>
          </div>

          <div class="soda-main-actions">
            <button class="soda-icon-btn" type="button" :disabled="!queueSize" @click="playRelative(-1)">
              <n-icon :size="22"><play-skip-back-outline /></n-icon>
            </button>
            <button
              class="soda-play-btn"
              type="button"
              :disabled="starting || (!queueSize && !currentTrack)"
              @click="togglePlay"
            >
              <n-icon :size="26">
                <pause-outline v-if="playing" />
                <play-outline v-else />
              </n-icon>
            </button>
            <button class="soda-icon-btn" type="button" :disabled="!queueSize" @click="playRelative(1)">
              <n-icon :size="22"><play-skip-forward-outline /></n-icon>
            </button>
          </div>

          <div class="soda-side-actions">
            <button
              class="soda-icon-btn like-mini"
              :class="{ active: liked }"
              type="button"
              :disabled="liking || !currentTrack?.id"
              @click="toggleLike"
            >
              <n-icon :size="20">
                <heart v-if="liked" />
                <heart-outline v-else />
              </n-icon>
            </button>
          </div>
        </div>
      </div>
    </n-spin>
  </div>
</template>

<style scoped>
.soda-player {
  position: relative;
  min-height: 100%;
  color: #f7faf8;
  font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  overflow: hidden;
  border-radius: 18px;
}

.soda-backdrop {
  position: absolute;
  inset: -30px;
  background-size: cover;
  background-position: center;
  filter: blur(28px) saturate(1.15);
  transform: scale(1.08);
  opacity: 0.55;
}

.soda-shade {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(180deg, rgba(8, 12, 10, 0.55), rgba(8, 12, 10, 0.88) 55%, rgba(6, 10, 8, 0.96)),
    radial-gradient(circle at 20% 20%, rgba(0, 203, 100, 0.18), transparent 40%);
}

.soda-topbar,
.soda-stage,
.soda-control {
  position: relative;
  z-index: 1;
}

.soda-topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 18px;
}

.soda-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 650;
  letter-spacing: 0.02em;
}

.soda-logo {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #00e27a;
  box-shadow: 0 0 14px rgba(0, 226, 122, 0.8);
}

.soda-pill {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 999px;
  color: #062015;
  background: linear-gradient(180deg, #b7ffc8, #31e44c);
}

.soda-ghost-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.08);
  color: #f7faf8;
  border-radius: 999px;
  padding: 8px 14px;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
}

.soda-ghost-btn:hover {
  background: rgba(0, 226, 122, 0.16);
  border-color: rgba(0, 226, 122, 0.35);
}

.soda-ghost-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.soda-stage {
  display: grid;
  grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
  gap: 28px;
  align-items: stretch;
}

@media (max-width: 860px) {
  .soda-stage {
    grid-template-columns: 1fr;
  }
}

.soda-left {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.soda-cover {
  width: min(320px, 72vw);
  aspect-ratio: 1;
  border-radius: 28px;
  background: linear-gradient(145deg, rgba(0, 226, 122, 0.2), rgba(0, 0, 0, 0.35)) center/cover no-repeat;
  box-shadow: 0 28px 60px rgba(0, 0, 0, 0.42);
  overflow: hidden;
  position: relative;
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

.soda-song-title {
  font-size: 28px;
  font-weight: 700;
  line-height: 1.25;
  word-break: break-word;
}

.soda-song-artist {
  margin-top: 8px;
  color: #8dffb8;
  font-size: 15px;
}

.soda-song-sub {
  margin-top: 6px;
  color: rgba(247, 250, 248, 0.55);
  font-size: 12px;
}

.soda-like {
  margin-top: 16px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.08);
  color: #f7faf8;
  border-radius: 999px;
  padding: 10px 16px;
  cursor: pointer;
  font: inherit;
  font-size: 14px;
  width: fit-content;
}

.soda-like:hover {
  border-color: rgba(0, 226, 122, 0.4);
  background: rgba(0, 226, 122, 0.14);
}

.soda-like.active {
  color: #062015;
  background: linear-gradient(180deg, #b7ffc8, #00e27a);
  border-color: transparent;
}

.soda-like:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.soda-right {
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: rgba(12, 16, 14, 0.42);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 24px;
  padding: 22px;
  min-height: 360px;
}

.soda-lyric {
  flex: 1;
  min-height: 280px;
  max-height: 420px;
  overflow: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
  mask-image: linear-gradient(to bottom, transparent, #000 8%, #000 92%, transparent);
  padding: 12px 4px;
}

.soda-lyric::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}

.soda-lyric-empty {
  height: 100%;
  min-height: 240px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(247, 250, 248, 0.38);
  font-size: 14px;
}

.soda-lyric-line {
  position: relative;
  text-align: center;
  padding: 10px 8px;
  font-size: 16px;
  line-height: 1.6;
  color: rgba(247, 250, 248, 0.28);
}

.soda-lyric-line.active {
  color: rgba(247, 250, 248, 0.42);
  transform: scale(1.05);
}

.soda-lyric-line .base,
.soda-lyric-line .fill {
  display: block;
}

.soda-lyric-line .fill {
  position: absolute;
  left: 0;
  right: 0;
  top: 10px;
  bottom: 10px;
  overflow: hidden;
  white-space: nowrap;
  color: #7dffb0;
  font-weight: 700;
  text-align: center;
  pointer-events: none;
}

.soda-error {
  margin-top: 10px;
  text-align: center;
  color: #ffb4b4;
  font-size: 12px;
}

.soda-control {
  margin-top: 18px;
  background: rgba(12, 16, 14, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 22px;
  padding: 16px 18px 18px;
}

.soda-progress {
  display: grid;
  grid-template-columns: 48px 1fr 48px;
  gap: 12px;
  align-items: center;
  user-select: none;
  touch-action: none;
  cursor: pointer;
}

.soda-time {
  font-size: 12px;
  color: rgba(247, 250, 248, 0.5);
  font-variant-numeric: tabular-nums;
}

.soda-bar {
  position: relative;
  height: 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.14);
}

.soda-bar-fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #00cb64, #7dffb0);
  pointer-events: none;
}

.soda-bar-thumb {
  position: absolute;
  top: 50%;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid #00e27a;
  transform: translate(-50%, -50%);
  pointer-events: none;
}

.soda-actions {
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
}

.soda-volume-range {
  width: min(140px, 26vw);
  accent-color: #00e27a;
}

.soda-volume-text {
  font-size: 12px;
  color: rgba(247, 250, 248, 0.48);
  min-width: 36px;
  font-variant-numeric: tabular-nums;
}

.soda-main-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
}

.soda-side-actions {
  display: flex;
  justify-content: flex-end;
}

.soda-icon-btn {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  border: 0;
  background: rgba(255, 255, 255, 0.08);
  color: #f7faf8;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.soda-icon-btn:hover {
  background: rgba(0, 226, 122, 0.16);
}

.soda-icon-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.soda-icon-btn.like-mini.active {
  color: #062015;
  background: linear-gradient(180deg, #b7ffc8, #00e27a);
}

.soda-play-btn {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  border: 0;
  cursor: pointer;
  color: #062015;
  background: linear-gradient(180deg, #b7ffc8, #00e27a);
  box-shadow: 0 12px 30px rgba(0, 226, 122, 0.35);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.soda-play-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

@media (max-width: 720px) {
  .soda-actions {
    grid-template-columns: 1fr;
  }

  .soda-volume,
  .soda-side-actions {
    justify-content: center;
  }
}
</style>
