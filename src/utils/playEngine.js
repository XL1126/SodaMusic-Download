/**
 * HTML5 播放引擎（严格状态管理，减少 seek / 切歌竞态）
 */

export function createPlayEngine({ onChange } = {}) {
  const audio = new Audio()
  audio.preload = 'auto'
  // 同源流不要设置 crossOrigin，避免被 CORS 策略拦下

  const state = {
    src: '',
    trackId: '',
    playing: false,
    currentTime: 0,
    duration: 0,
    volume: 0.8,
    muted: false,
    ready: false,
    seeking: false,
    error: '',
    loadToken: 0,
    playedMs: 0,
    lastTick: 0,
  }

  let rafId = 0
  let reportTimer = 0

  function emit() {
    if (typeof onChange === 'function') {
      onChange({
        playing: state.playing,
        currentTime: state.currentTime,
        duration: state.duration,
        volume: state.volume,
        muted: state.muted,
        ready: state.ready,
        seeking: state.seeking,
        error: state.error,
        trackId: state.trackId,
        playedMs: state.playedMs,
      })
    }
  }

  function clampTime(t) {
    const dur = Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration
      : (Number.isFinite(state.duration) && state.duration > 0 ? state.duration : 0)
    if (!dur) return Math.max(0, Number(t) || 0)
    return Math.min(Math.max(0, Number(t) || 0), Math.max(0, dur - 0.05))
  }

  function syncDuration() {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      state.duration = audio.duration
    }
    emit()
  }

  function tick() {
    if (!state.seeking) {
      state.currentTime = audio.currentTime || 0
    }
    syncDuration()

    const now = performance.now()
    if (state.playing && state.lastTick) {
      const delta = now - state.lastTick
      if (delta > 0 && delta < 2000) {
        state.playedMs += delta
      }
    }
    state.lastTick = now

    if (state.playing) {
      rafId = requestAnimationFrame(tick)
    }
  }

  function startTick() {
    state.lastTick = performance.now()
    cancelAnimationFrame(rafId)
    rafId = requestAnimationFrame(tick)
  }

  function stopTick() {
    cancelAnimationFrame(rafId)
    rafId = 0
    state.lastTick = 0
  }

  audio.addEventListener('loadedmetadata', () => {
    state.ready = true
    state.error = ''
    syncDuration()
    emit()
  })

  audio.addEventListener('durationchange', syncDuration)

  audio.addEventListener('timeupdate', () => {
    if (!state.seeking) {
      state.currentTime = audio.currentTime || 0
    }
    syncDuration()
  })

  audio.addEventListener('play', () => {
    state.playing = true
    startTick()
    emit()
  })

  audio.addEventListener('pause', () => {
    state.playing = false
    stopTick()
    emit()
  })

  audio.addEventListener('ended', () => {
    state.playing = false
    state.currentTime = state.duration
    stopTick()
    emit()
  })

  audio.addEventListener('error', () => {
    state.playing = false
    state.ready = false
    state.error = '音频加载失败'
    stopTick()
    emit()
  })

  audio.addEventListener('waiting', () => {
    state.error = ''
    emit()
  })

  function applyVolume() {
    audio.muted = Boolean(state.muted)
    audio.volume = Math.min(1, Math.max(0, state.muted ? 0 : state.volume))
    emit()
  }

  async function load({ src, trackId, autoplay = true, startAt = 0 }) {
    if (!src) {
      throw new Error('缺少播放地址')
    }

    state.loadToken += 1
    const token = state.loadToken
    state.src = src
    state.trackId = String(trackId || '')
    state.ready = false
    state.error = ''
    state.currentTime = Number(startAt) || 0
    state.playedMs = 0
    state.seeking = false
    applyVolume()

    audio.pause()
    audio.src = src
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
        audio.removeEventListener('canplay', onReady)
        audio.removeEventListener('error', onFail)
      }
      audio.addEventListener('loadedmetadata', onReady, { once: true })
      audio.addEventListener('canplay', onReady, { once: true })
      audio.addEventListener('error', onFail, { once: true })
      setTimeout(() => {
        cleanup()
        resolve()
      }, 10000)
    })

    if (token !== state.loadToken) {
      return
    }

    syncDuration()

    if (startAt > 0) {
      try {
        audio.currentTime = clampTime(startAt)
        state.currentTime = audio.currentTime
      } catch {
        // ignore
      }
    }

    if (autoplay) {
      try {
        await audio.play()
      } catch (error) {
        // 自动播放策略可能拒绝，交给用户点击
        state.playing = false
        emit()
        throw error
      }
    }

    emit()
  }

  async function play() {
    if (!audio.src) {
      throw new Error('尚未加载音频')
    }
    applyVolume()
    await audio.play()
    state.playing = true
    startTick()
    emit()
  }

  function pause() {
    audio.pause()
    state.playing = false
    stopTick()
    emit()
  }

  async function toggle() {
    if (state.playing) {
      pause()
      return
    }
    await play()
  }

  function beginSeek() {
    state.seeking = true
    emit()
  }

  function previewSeek(time) {
    state.seeking = true
    state.currentTime = clampTime(time)
    emit()
    return state.currentTime
  }

  async function commitSeek(time) {
    const target = clampTime(time)
    state.seeking = true
    state.currentTime = target
    emit()

    try {
      if (!audio.src && state.src) {
        audio.src = state.src
        audio.load()
      }
      audio.currentTime = target
      state.currentTime = audio.currentTime || target
    } catch (error) {
      state.error = '调整进度失败'
      state.seeking = false
      emit()
      throw error
    }

    state.seeking = false
    syncDuration()
    emit()
    return state.currentTime
  }

  function setVolume(value) {
    state.volume = Math.min(1, Math.max(0, Number(value) || 0))
    if (state.volume > 0) state.muted = false
    applyVolume()
  }

  function setMuted(muted) {
    state.muted = Boolean(muted)
    applyVolume()
  }

  function getPlayedMs() {
    return Math.round(state.playedMs)
  }

  function resetPlayedMs() {
    state.playedMs = 0
    state.lastTick = performance.now()
  }

  function destroy() {
    stopTick()
    clearInterval(reportTimer)
    try {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    } catch {
      // ignore
    }
  }

  return {
    audio,
    load,
    play,
    pause,
    toggle,
    beginSeek,
    previewSeek,
    commitSeek,
    setVolume,
    setMuted,
    getPlayedMs,
    resetPlayedMs,
    destroy,
    getState: () => ({ ...state }),
  }
}
