/**
 * 本机音乐播放管理（Windows）
 *
 * 可用性探测结论（本机）：
 * - Windows Media Player COM / wmplayer.exe 通常不存在
 * - Edge 浏览器存在，可用 --app 打开本地播放页，并注册系统媒体控件
 * - System.Media.SoundPlayer 可播放 WAV（后备）
 * - WinRT MediaPlayer 需先显式加载类型再 ::new()（后备）
 *
 * 主链路：生成短时 token → 打开 Edge 应用窗口播放本地音频 → 前端轮询状态
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
const PS_SCRIPT_FILE = path.join(PLAY_DIR, 'local-play.ps1')

let ffmpegPath = resolveFfmpegPath()

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
  engine: '',
  playerPid: 0,
  streamUrl: '',
  updatedAt: 0,
}

let powershell = null
let edgeProcess = null
let heartbeat = { position: 0, duration: 0, playing: false, updatedAt: 0 }

function resolveFfmpegPath() {
  try {
    const installer = require('@ffmpeg-installer/ffmpeg')
    if (installer?.path && fs.existsSync(installer.path)) return installer.path
  } catch {
    // ignore
  }
  const local = path.join(__dirname, '..', '..', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe')
  return fs.existsSync(local) ? local : ''
}

function findEdgePath() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
  ]
  return candidates.find((p) => {
    try { return fs.existsSync(p) } catch { return false }
  }) || ''
}

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
      engine: state.engine,
      playerPid: state.playerPid,
      streamUrl: state.streamUrl,
      updatedAt: state.updatedAt,
    }), 'utf8')
  } catch {
    // ignore
  }
}

function updateState(patch) {
  Object.assign(state, patch)
  state.updatedAt = Date.now()
  writeStatusFile()
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error('ffmpeg not found'))
      return
    }
    const child = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
      if (stderr.length > 2000) stderr = stderr.slice(-2000)
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr || `ffmpeg exit ${code}`))
    })
  })
}

async function ensurePlayableFile(buffer, contentType, trackId) {
  ensurePlayDir()
  const base = `now-playing-${trackId || Date.now()}`
  const isWav = contentType?.includes('wav')
  const inputExt = contentType?.includes('flac') || contentType?.includes('x-flac')
    ? '.flac'
    : contentType?.includes('mpeg') || contentType?.includes('mp3')
      ? '.mp3'
      : isWav
        ? '.wav'
        : '.m4a'
  const inputPath = path.join(PLAY_DIR, `${base}${inputExt}`)
  fs.writeFileSync(inputPath, buffer)

  // 已是 WAV 时无需再转码
  if (isWav) {
    return { filePath: inputPath, inputPath, converted: false }
  }

  const wavPath = path.join(PLAY_DIR, `${base}.wav`)
  if (ffmpegPath) {
    try {
      await runFfmpeg([
        '-y', '-i', inputPath,
        '-vn', '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2',
        wavPath,
      ])
      if (fs.existsSync(wavPath) && fs.statSync(wavPath).size > 1000) {
        return { filePath: wavPath, inputPath, converted: true }
      }
    } catch (err) {
      localLogger.warn('recommend.wavConvertFailed', { error: String(err?.message || '').slice(0, 300), trackId })
    }
  }
  return { filePath: inputPath, inputPath, converted: false }
}

function stopEdgeProcess() {
  if (edgeProcess && !edgeProcess.killed) {
    try { edgeProcess.kill() } catch { /* ignore */ }
  }
  edgeProcess = null
}

function stopPowerShellProcess() {
  if (powershell && !powershell.killed) {
    try {
      fs.writeFileSync(CONTROL_FILE, 'stop', 'utf8')
    } catch { /* ignore */ }
    try { powershell.kill() } catch { /* ignore */ }
  }
  powershell = null
}

function stopCurrentProcess() {
  stopEdgeProcess()
  stopPowerShellProcess()
}

function getWinrtScript() {
  return `
$ErrorActionPreference = 'Stop'
$filePath = $env:SODA_LOCAL_AUDIO
$statusFile = $env:SODA_LOCAL_STATUS
$controlFile = $env:SODA_LOCAL_CONTROL
$title = $env:SODA_LOCAL_TITLE
$artist = $env:SODA_LOCAL_ARTIST
$trackId = $env:SODA_LOCAL_TRACK_ID
$cover = $env:SODA_LOCAL_COVER

function Write-Status($playing, $position, $duration, $message, $engine) {
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
    engine = $engine
    playerPid = $PID
    updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }
  [System.IO.File]::WriteAllText($statusFile, ($obj | ConvertTo-Json -Compress), [System.Text.Encoding]::UTF8)
}

if (-not (Test-Path -LiteralPath $filePath)) {
  Write-Status $false 0 0 'Audio file not found' 'none'
  exit 1
}

try {
  [void][Windows.Media.Playback.MediaPlayer, Windows.Media.Playback, ContentType = WindowsRuntime]
  $player = [Windows.Media.Playback.MediaPlayer]::new()
  $uri = [System.Uri]::new($filePath)
  $source = [Windows.Media.Core.MediaSource]::CreateFromUri($uri)
  $player.Source = $source
  $player.Play()
  Write-Status $true 0 0 'WinRT MediaPlayer started' 'winrt-mediaplayer'
} catch {
  Write-Status $false 0 0 ('WinRT init failed: ' + $_.Exception.Message) 'failed'
  exit 1
}

while ($true) {
  Start-Sleep -Milliseconds 400
  if (Test-Path -LiteralPath $controlFile) {
    $cmd = ''
    try { $cmd = (Get-Content -LiteralPath $controlFile -Raw) } catch {}
    if ($cmd) {
      $cmd = $cmd.Trim()
      Remove-Item -LiteralPath $controlFile -Force -ErrorAction SilentlyContinue
      switch ($cmd) {
        'pause' { $player.Pause() }
        'resume' { $player.Play() }
        'stop' {
          try { $player.Pause() } catch {}
          try { $player.Source = $null } catch {}
          Write-Status $false 0 0 'Stopped' 'winrt-mediaplayer'
          exit 0
        }
      }
    }
  }
  $pos = 0.0; $dur = 0.0; $st = 0
  try {
    $session = $player.PlaybackSession
    $pos = $session.Position.TotalSeconds
    if ($session.NaturalDuration.TotalSeconds -gt 0) { $dur = $session.NaturalDuration.TotalSeconds }
    $st = [int]$session.PlaybackState
  } catch {}
  if ($st -eq 4 -and $pos -gt 0) {
    Write-Status $false $pos $dur 'Ended' 'winrt-mediaplayer'
    exit 0
  }
  $playing = ($st -eq 2)
  $msg = if ($playing) { 'Playing' } elseif ($st -eq 3) { 'Paused' } else { 'Working' }
  Write-Status $playing $pos $dur $msg 'winrt-mediaplayer'
}
`
}

function startWinrtFallback({ filePath, title, artist, cover, trackId }) {
  ensurePlayDir()
  fs.writeFileSync(PS_SCRIPT_FILE, getWinrtScript(), 'utf8')
  const env = {
    ...process.env,
    SODA_LOCAL_AUDIO: filePath,
    SODA_LOCAL_STATUS: STATUS_FILE,
    SODA_LOCAL_CONTROL: CONTROL_FILE,
    SODA_LOCAL_TITLE: title || '',
    SODA_LOCAL_ARTIST: artist || '',
    SODA_LOCAL_TRACK_ID: String(trackId || ''),
    SODA_LOCAL_COVER: cover || '',
  }
  powershell = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS_SCRIPT_FILE],
    { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
  )
  powershell.stderr?.on('data', (chunk) => {
    localLogger.warn('recommend.localPlayStderr', { message: String(chunk).slice(0, 300) })
  })
  powershell.on('exit', (code) => {
    localLogger.info('recommend.localPlayExit', { code, engine: 'winrt' })
    powershell = null
  })
  return 'winrt-mediaplayer'
}

function startSoundPlayerFallback({ filePath }) {
  ensurePlayDir()
  const script = `
$ErrorActionPreference = 'Stop'
$filePath = $env:SODA_LOCAL_AUDIO
$statusFile = $env:SODA_LOCAL_STATUS
$controlFile = $env:SODA_LOCAL_CONTROL
$title = $env:SODA_LOCAL_TITLE
$artist = $env:SODA_LOCAL_ARTIST
$trackId = $env:SODA_LOCAL_TRACK_ID
$cover = $env:SODA_LOCAL_COVER
function Write-Status($playing, $position, $duration, $message, $engine) {
  $obj = [ordered]@{
    trackId=$trackId; title=$title; artist=$artist; cover=$cover; filePath=$filePath
    mode='local'; playing=[bool]$playing; position=[double]$position; duration=[double]$duration
    message=$message; engine=$engine; playerPid=$PID; updatedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }
  [System.IO.File]::WriteAllText($statusFile, ($obj | ConvertTo-Json -Compress), [System.Text.Encoding]::UTF8)
}
try {
  $player = New-Object System.Media.SoundPlayer $filePath
  $player.Play()
  Write-Status $true 0 0 'SoundPlayer started' 'soundplayer'
  $elapsed = 0.0
  while ($elapsed -lt 3600) {
    Start-Sleep -Milliseconds 400
    $elapsed += 0.4
    if (Test-Path -LiteralPath $controlFile) {
      $cmd = (Get-Content -LiteralPath $controlFile -Raw)
      Remove-Item -LiteralPath $controlFile -Force -ErrorAction SilentlyContinue
      if ($cmd.Trim() -eq 'stop') { $player.Stop(); Write-Status $false $elapsed 0 'Stopped' 'soundplayer'; exit 0 }
      if ($cmd.Trim() -eq 'pause') { $player.Stop(); Write-Status $false $elapsed 0 'Paused' 'soundplayer' }
      if ($cmd.Trim() -eq 'resume') { $player.Play(); Write-Status $true $elapsed 0 'Playing' 'soundplayer' }
    }
    Write-Status $true $elapsed 0 'Playing' 'soundplayer'
  }
} catch {
  Write-Status $false 0 0 ('SoundPlayer failed: ' + $_.Exception.Message) 'failed'
  exit 1
}
`
  fs.writeFileSync(path.join(PLAY_DIR, 'soundplayer.ps1'), script, 'utf8')
  const env = {
    ...process.env,
    SODA_LOCAL_AUDIO: filePath,
    SODA_LOCAL_STATUS: STATUS_FILE,
    SODA_LOCAL_CONTROL: CONTROL_FILE,
    SODA_LOCAL_TITLE: state.title || '',
    SODA_LOCAL_ARTIST: state.artist || '',
    SODA_LOCAL_TRACK_ID: state.trackId || '',
    SODA_LOCAL_COVER: state.cover || '',
  }
  powershell = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PLAY_DIR, 'soundplayer.ps1')],
    { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
  )
  powershell.on('exit', () => { powershell = null })
  return 'soundplayer'
}

/**
 * Edge 应用窗口播放：系统媒体控件可识别
 * @param {object} options
 * @param {string} options.streamUrl 后端流地址（相对路径即可，由调用方拼 host）
 * @param {string} options.localPlayerUrl 本地播放页 URL
 */
function startEdgePlayer({ localPlayerUrl }) {
  const edgePath = findEdgePath()
  if (!edgePath) return ''

  const child = spawn(edgePath, [
    `--app=${localPlayerUrl}`,
    '--window-size=420,640',
    '--autoplay-policy=no-user-gesture-required',
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.unref()
  edgeProcess = child
  return 'edge-app'
}

async function startLocalPlayback({ buffer, contentType, title, artist, cover, trackId, playerToken = '', port = 3001 }) {
  ensurePlayDir()
  stopCurrentProcess()
  heartbeat = { position: 0, duration: 0, playing: false, updatedAt: 0 }

  const prepared = await ensurePlayableFile(buffer, contentType, trackId)
  try {
    if (fs.existsSync(CONTROL_FILE)) fs.unlinkSync(CONTROL_FILE)
  } catch { /* ignore */ }

  const localPlayerUrl = playerToken
    ? `http://127.0.0.1:${port}/api/recommend/local-player?token=${encodeURIComponent(playerToken)}&title=${encodeURIComponent(title || '')}&artist=${encodeURIComponent(artist || '')}&cover=${encodeURIComponent(cover || '')}`
    : ''

  let engine = ''
  if (localPlayerUrl) {
    engine = startEdgePlayer({ localPlayerUrl })
  }

  if (!engine) {
    engine = startWinrtFallback({
      filePath: prepared.filePath,
      title,
      artist,
      cover,
      trackId,
    })
  }

  // WinRT 失败时再尝试 SoundPlayer
  // （由 status 文件/进程退出后前端可再触发）

  updateState({
    trackId: String(trackId || ''),
    title: title || '未知曲目',
    artist: artist || '',
    cover: cover || '',
    filePath: prepared.filePath,
    mode: 'local',
    playing: true,
    position: 0,
    duration: 0,
    message: engine === 'edge-app'
      ? '已在系统播放窗口中启动（Edge）'
      : engine === 'winrt-mediaplayer'
        ? '已启动 WinRT 本机播放'
        : '已启动本机播放',
    engine,
    playerPid: edgeProcess?.pid || powershell?.pid || 0,
    streamUrl: localPlayerUrl,
  })

  if (edgeProcess) {
    edgeProcess.on('exit', () => {
      edgeProcess = null
      if (state.engine === 'edge-app' && state.playing) {
        updateState({ playing: false, message: '播放窗口已关闭' })
      }
    })
  }

  localLogger.info('recommend.localPlayStart', {
    trackId,
    title,
    engine,
    filePath: prepared.filePath,
    converted: prepared.converted,
    size: buffer.length,
  })

  return getLocalStatus()
}

function reportHeartbeat(payload = {}) {
  heartbeat = {
    position: Number(payload.position || 0),
    duration: Number(payload.duration || 0),
    playing: Boolean(payload.playing),
    updatedAt: Date.now(),
  }
  updateState({
    position: heartbeat.position,
    duration: heartbeat.duration || state.duration,
    playing: heartbeat.playing,
    message: payload.message || (heartbeat.playing ? '播放中' : state.message),
  })
  return getLocalStatus()
}

function sendControl(command) {
  ensurePlayDir()

  // Edge 模式：前端播放页自己响应控件；这里尽量通知
  if (state.engine === 'edge-app') {
    if (command === 'stop') {
      stopEdgeProcess()
      updateState({ playing: false, message: '已停止' })
    } else if (command === 'pause') {
      updateState({ playing: false, message: '已暂停（请在播放窗口中确认）' })
    } else if (command === 'resume') {
      updateState({ playing: true, message: '播放中' })
    }
    return getLocalStatus()
  }

  fs.writeFileSync(CONTROL_FILE, command, 'utf8')
  if (command === 'stop') updateState({ playing: false, message: '已停止' })
  if (command === 'pause') updateState({ playing: false, message: '已暂停' })
  if (command === 'resume') updateState({ playing: true, message: '播放中' })
  return getLocalStatus()
}

function syncStatusFromFile() {
  try {
    if (!fs.existsSync(STATUS_FILE)) return
    const data = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'))
    if (!data || typeof data !== 'object') return
    // Edge 模式优先信任心跳/内存状态，避免被旧 status 文件覆盖
    if (state.engine === 'edge-app' && Date.now() - heartbeat.updatedAt < 5000) {
      return
    }
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
    state.engine = data.engine || state.engine
    state.updatedAt = Number(data.updatedAt || Date.now())
  } catch {
    // ignore
  }
}

function getLocalStatus() {
  if (state.engine !== 'edge-app') {
    syncStatusFromFile()
  } else if (edgeProcess && !edgeProcess.killed) {
    state.playing = heartbeat.playing || state.playing
  } else if (!edgeProcess) {
    state.playing = false
  }

  return {
    ...state,
    available: process.platform === 'win32',
    ffmpeg: Boolean(ffmpegPath),
    edge: Boolean(findEdgePath()),
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
  reportHeartbeat,
  PLAY_DIR,
}
