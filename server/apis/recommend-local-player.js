/**
 * 本机 Edge 播放页
 * GET /api/recommend/local-player?token=&title=&artist=&cover=
 */

const { logger } = require('../utils/logger')
const { reportHeartbeat } = require('../utils/local-music-player')

const recLogger = logger.child('LocalPlayerPage')

// 与 recommend-play.js 共享 token 校验：这里通过 query.token 传 stream token
// 简化：local-player 直接使用 stream?token= 播放

module.exports = [
  {
    name: 'recommend-local-player-page',
    method: 'get',
    path: '/api/recommend/local-player',
    handler: (req, res) => {
      const token = String(req.query.token || '')
      const title = String(req.query.title || '汽水推荐').replace(/[<>&"]/g, '')
      const artist = String(req.query.artist || '').replace(/[<>&"]/g, '')
      const cover = String(req.query.cover || '')
      const streamUrl = token.includes('stream') ? token : `/api/recommend/stream?token=${encodeURIComponent(token)}`

      const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · 汽水推荐</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 16px;
    background: radial-gradient(circle at 20% 20%, rgba(24,160,88,.22), transparent 45%), #0f1412;
    color: #e8efe9; font-family: system-ui, "Segoe UI", sans-serif; padding: 24px;
  }
  .cover {
    width: 220px; height: 220px; border-radius: 18px; object-fit: cover;
    background: #1a2420; box-shadow: 0 16px 40px rgba(0,0,0,.35);
    display:flex; align-items:center; justify-content:center; font-size:48px; color:#18a058;
  }
  .title { font-size: 20px; font-weight: 650; text-align:center; word-break: break-word; }
  .artist { opacity: .75; font-size: 14px; }
  .controls { display: flex; gap: 12px; align-items: center; margin-top: 8px; }
  button {
    border: 0; border-radius: 999px; min-width: 48px; height: 48px; padding: 0 18px;
    background: #18a058; color: #fff; font-size: 14px; cursor: pointer;
  }
  button.secondary { background: rgba(255,255,255,.12); }
  .bar { width: min(320px, 90vw); }
  input[type=range] { width: 100%; }
  .time { display:flex; justify-content:space-between; font-size:12px; opacity:.7; font-variant-numeric: tabular-nums; }
  .tag { font-size:12px; opacity:.65; }
</style>
</head>
<body>
  ${cover ? `<img class="cover" src="${cover}" alt="cover" referrerpolicy="no-referrer" />` : `<div class="cover">♪</div>`}
  <div class="title">${title}</div>
  <div class="artist">${artist || '汽水推荐 · 本机播放'}</div>
  <div class="tag">系统媒体会话已注册 · Edge 本地播放</div>
  <audio id="audio" src="${streamUrl}" autoplay preload="auto"></audio>
  <div class="controls">
    <button class="secondary" id="btnPrev" type="button">上一首</button>
    <button id="btnToggle" type="button">暂停</button>
    <button class="secondary" id="btnNext" type="button">下一首</button>
  </div>
  <div class="bar">
    <input id="seek" type="range" min="0" max="100" value="0" step="0.1" />
    <div class="time"><span id="cur">00:00</span><span id="dur">00:00</span></div>
  </div>
<script>
  const audio = document.getElementById('audio')
  const btnToggle = document.getElementById('btnToggle')
  const seek = document.getElementById('seek')
  const cur = document.getElementById('cur')
  const dur = document.getElementById('dur')
  const meta = {
    title: ${JSON.stringify(title)},
    artist: ${JSON.stringify(artist)},
    cover: ${JSON.stringify(cover)},
  }

  function fmt(s) {
    s = Math.max(0, Number(s) || 0)
    const m = Math.floor(s / 60)
    const r = Math.floor(s % 60)
    return String(m).padStart(2,'0') + ':' + String(r).padStart(2,'0')
  }

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: meta.title,
        artist: meta.artist,
        album: '汽水推荐',
        artwork: meta.cover ? [{ src: meta.cover, sizes: '400x400', type: 'image/jpeg' }] : []
      })
      navigator.mediaSession.setActionHandler('play', () => audio.play())
      navigator.mediaSession.setActionHandler('pause', () => audio.pause())
    } catch (e) {}
  }

  function heartbeat() {
    fetch('/api/recommend/local-heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        position: audio.currentTime || 0,
        duration: audio.duration || 0,
        playing: !audio.paused && !audio.ended,
      })
    }).catch(() => {})
  }
  setInterval(heartbeat, 1000)

  audio.addEventListener('timeupdate', () => {
    cur.textContent = fmt(audio.currentTime)
    if (audio.duration) {
      dur.textContent = fmt(audio.duration)
      seek.value = String((audio.currentTime / audio.duration) * 100)
    }
  })
  audio.addEventListener('ended', () => {
    btnToggle.textContent = '播放'
    heartbeat()
  })
  audio.addEventListener('play', () => { btnToggle.textContent = '暂停'; heartbeat() })
  audio.addEventListener('pause', () => { btnToggle.textContent = '播放'; heartbeat() })

  btnToggle.addEventListener('click', async () => {
    if (audio.paused) await audio.play().catch(() => {})
    else audio.pause()
  })
  seek.addEventListener('input', () => {
    if (!audio.duration) return
    audio.currentTime = (Number(seek.value) / 100) * audio.duration
  })
  document.getElementById('btnPrev').addEventListener('click', () => {
    audio.currentTime = Math.max(0, audio.currentTime - 10)
  })
  document.getElementById('btnNext').addEventListener('click', () => {
    if (audio.duration) audio.currentTime = Math.min(audio.duration - 0.1, audio.currentTime + 10)
  })
</script>
</body>
</html>`

      recLogger.debug('recommend.localPlayerPage', { hasToken: Boolean(token), title })
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.send(html)
    },
  },
  {
    name: 'recommend-local-heartbeat',
    method: 'post',
    path: '/api/recommend/local-heartbeat',
    handler: (req, res) => {
      const status = reportHeartbeat(req.body || {})
      res.json({ status_code: 0, local: status })
    },
  },
]
