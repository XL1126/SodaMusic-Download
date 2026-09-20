/**
 * 本机音乐播放管理
 * - 将解密后的音频写入临时文件
 * - 通过 Windows Media Player COM 播放，使系统媒体控件能识别到音乐
 * - 维护内存中的当前播放状态，供前端轮询
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')
const { logger } = require('./logger')

const localLogger = logger.child('LocalPlayer')

const PLAY_DIR = path.join(os.tmpdir(), 'sodamusic-local-play')
const STATUS_FILE = path.join(PLAY_DIR, 'status.json')
const CONTROL_FILE = path.join(PLAY_DIR, 'control.txt')

const state = {
  trackId: '',
  title: '',
  artist: '',
  cover: '',
  filePath: '',
  mode: 'idle',
  playing: false,
  position: 0,
  duration: 0,
  message: '',
  updatedAt: 0,
}

let powershell = null

function ensurePlayDir() {
  if (!fs.existsSync(PLAY_DIR)) {
    fs.mkdirSync(PLAY_DIR, { recursive: true })
  }
}

function writeStatusFile() {
  try {
    ensurePlayDir()
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      trackId: state.trackId,
      title: state.title,
      artist: state.artist,
      cover: state.cover,
      filePath: state.filePath,
      mode: state.mode,
      playing: state.playing,
      position: state.position,
      duration: state.duration,
      message: state.message,
      updatedAt: state.updatedAt,
    }), 'utf8')
  } catch {
    // ignore
  }
}

function getPowerShellScript() {
  return `
$ErrorActionPreference = 'Stop'
$filePath = $env:SODA_LOCAL_AUDIO
$statusFile = $env:SODA_LOCAL_STATUS
$controlFile = $env:SODA_LOCAL_CONTROL
$cover = $env:SODA_LOCAL_COVER
$title = $env:SODA_LOCAL_TITLE
$artist = $env:SODA_LOCAL_ARTIST
$trackId = $env:SODA_LOCAL_TRACK_ID

function Write-Status($playing, $position, $duration, $message) {
  $obj = [ordered]@{
    trackId = $trackId
    title = $title
    artist = $artist
    cover = $cover
    filePath = $filePath
    mode = 'local'
    playing = [bool]$playing
    position = [double]$position
    duration = [double]$duration
    message = $message
    updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }
  $json = $obj | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($statusFile, $json, [System.Text.Encoding]::UTF8)
}

if (-not (Test-Path $filePath)) {
  Write-Status $false 0 0 '音频文件不存在'
  exit 1
}

try {
  $wmp = New-Object -ComObject WMPlayer.OCX
  $wmp.URL = $filePath
  $wmp.settings.autoStart = $true
  # 让系统媒体控件 / 音量合成器能识别到该播放任务
  $wmp.settings.setMode('loop', $false)
  $wmp.controls.play()
  Write-Status $true 0 0 '本机播放已启动'

  $idleCount = 0
  while ($true) {
    Start-Sleep -Milliseconds 400

    if (Test-Path $controlFile) {
      $cmd = (Get-Content $controlFile -Raw -ErrorAction SilentlyContinue)
      if ($cmd) {
        $cmd = $cmd.Trim()
        Remove-Item $controlFile -Force -ErrorAction SilentlyContinue
        switch ($cmd) {
          'pause' {
            $wmp.controls.pause()
            Write-Status $false $wmp.controls.currentPosition $wmp.currentMedia.duration '已暂停'
          }
          'resume' {
            $wmp.controls.play()
            Write-Status $true $wmp.controls.currentPosition $wmp.currentMedia.duration '播放中'
          }
          'stop' {
            $wmp.controls.stop()
            Write-Status $false 0 $wmp.currentMedia.duration '已停止'
            try { $wmp.close() } catch {}
            exit 0
          }
        }
      }
    }

    $pos = 0
    $dur = 0
    $playState = 0
    try {
      $pos = $wmp.controls.currentPosition
      $dur = $wmp.currentMedia.duration
      $playState = $wmp.playState
    } catch {}

    # 8 = media ended, 1 = stopped
    if ($playState -eq 8 -or $playState -eq 1) {
      Write-Status $false $pos $dur '播放结束'
      try { $wmp.close() } catch {}
      exit 0
    }

    $playing = ($playState -eq 3 -or $playState -eq 4 -or $playState -eq 6 -or $playState -eq 9)
    Write-Status $playing $pos $dur $(if ($playing) { '播放中' } else { '待命' })
    $idleCount = 0
  }
} catch {
  Write-Status $false 0 0 ("播放失败: " + $_.Exception.Message)
  exit 1
}
`
}

function stopCurrentProcess() {
  if (powershell && !powershell.killed) {
    try {
      fs.writeFileSync(CONTROL_FILE, 'stop', 'utf8')
    } catch {
      // ignore
    }
    try {
      powershell.kill()
    } catch {
      // ignore
    }
  }
  powershell = null
}

function startLocalPlayback({ buffer, contentType, title, artist, cover, trackId }) {
  ensurePlayDir()
  stopCurrentProcess()

  const ext = contentType?.includes('flac') || contentType?.includes('x-flac')
    ? '.flac'
    : contentType?.includes('mpeg') || contentType?.includes('mp3')
      ? '.mp3'
      : '.m4a'

  const safeTitle = String(title || 'track').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
  const filePath = path.join(PLAY_DIR, `now-playing${ext}`)

  fs.writeFileSync(filePath, buffer)
  try {
    if (fs.existsSync(CONTROL_FILE)) fs.unlinkSync(CONTROL_FILE)
  } catch {
    // ignore
  }

  state.trackId = String(trackId || '')
  state.title = title || safeTitle
  state.artist = artist || ''
  state.cover = cover || ''
  state.filePath = filePath
  state.mode = 'local'
  state.playing = true
  state.position = 0
  state.duration = 0
  state.message = '正在启动本机播放...'
  state.updatedAt = Date.now()
  writeStatusFile()

  const env = {
    ...process.env,
    SODA_LOCAL_AUDIO: filePath,
    SODA_LOCAL_STATUS: STATUS_FILE,
    SODA_LOCAL_CONTROL: CONTROL_FILE,
    SODA_LOCAL_COVER: cover || '',
    SODA_LOCAL_TITLE: title || '',
    SODA_LOCAL_ARTIST: artist || '',
    SODA_LOCAL_TRACK_ID: String(trackId || ''),
  }

  powershell = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', getPowerShellScript()],
    {
      env,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )

  powershell.stderr?.on('data', (chunk) => {
    localLogger.warn('recommend.localPlayStderr', { message: String(chunk).slice(0, 300) })
  })

  powershell.on('exit', (code) => {
    localLogger.info('recommend.localPlayExit', { code, trackId: state.trackId })
    powershell = null
    if (state.playing && code !== 0) {
      state.playing = false
      state.message = state.message || '本机播放进程已退出'
      state.updatedAt = Date.now()
      writeStatusFile()
    }
  })

  localLogger.info('recommend.localPlayStart', { trackId, title, filePath, size: buffer.length })
  return getLocalStatus()
}

function sendControl(command) {
  ensurePlayDir()
  fs.writeFileSync(CONTROL_FILE, command, 'utf8')

  if (command === 'stop') {
    state.playing = false
    state.message = '已停止'
    state.updatedAt = Date.now()
  }
  if (command === 'pause') {
    state.playing = false
    state.message = '已暂停'
    state.updatedAt = Date.now()
  }
  if (command === 'resume') {
    state.playing = true
    state.message = '播放中'
    state.updatedAt = Date.now()
  }
  writeStatusFile()
  return getLocalStatus()
}

function syncStatusFromFile() {
  try {
    if (!fs.existsSync(STATUS_FILE)) return
    const raw = fs.readFileSync(STATUS_FILE, 'utf8')
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object') return
    state.trackId = data.trackId || state.trackId
    state.title = data.title || state.title
    state.artist = data.artist || state.artist
    state.cover = data.cover || state.cover
    state.filePath = data.filePath || state.filePath
    state.mode = data.mode || state.mode
    state.playing = Boolean(data.playing)
    state.position = Number(data.position || 0)
    state.duration = Number(data.duration || 0)
    state.message = data.message || state.message
    state.updatedAt = Number(data.updatedAt || Date.now())
  } catch {
    // ignore
  }
}

function getLocalStatus() {
  syncStatusFromFile()
  return {
    ...state,
    available: process.platform === 'win32',
  }
}

function stopLocalPlayback() {
  sendControl('stop')
  stopCurrentProcess()
  return getLocalStatus()
}

module.exports = {
  startLocalPlayback,
  sendControl,
  getLocalStatus,
  stopLocalPlayback,
  PLAY_DIR,
}
