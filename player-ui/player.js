/* 汽水推荐播放器预览逻辑（本地 UI Demo，可对接真实 API） */
(function () {
  const demoTracks = [
    {
      id: 'demo-1',
      name: '我们就走到这吧',
      artist: '浩铭',
      album: '汽水推荐',
      // 官方分享页封面（演示代理后可替换为 /api/recommend/image?src=...）
      cover: 'https://p3-luna.douyinpic.com/img/tos-cn-v-2774c002/ow9WyCiQSEB1l4AB4jAQfgi91FEvslqghAEpPA~c5_375x375.jpg',
      duration: 30,
      lyrics: [
        { time: 0, text: '汽水推荐播放器预览' },
        { time: 3, text: '封面走本地代理加载' },
        { time: 6.5, text: '歌词随播放进度逐句高亮' },
        { time: 10, text: '当前句会显示填充进度' },
        { time: 14, text: '其余歌词保持暗色' },
        { time: 18, text: '上一首 / 播放 / 下一首' },
        { time: 22, text: '可对接项目真实推荐接口' },
        { time: 26, text: '风格参考官方网页播放器' },
      ],
    },
    {
      id: 'demo-2',
      name: '示例曲目 B',
      artist: '未知歌手',
      album: '演示队列',
      cover: '',
      duration: 20,
      lyrics: [
        { time: 0, text: '第二首演示' },
        { time: 4, text: '进度条与歌词同步' },
        { time: 8, text: '换一批可刷新队列' },
        { time: 12, text: '无封面时显示占位' },
        { time: 16, text: '本文件可独立浏览器打开' },
      ],
    },
  ]

  let queue = demoTracks.slice()
  let index = 0
  let playing = false
  let simulatedTime = 0
  let timer = null

  const el = {
    title: document.getElementById('title'),
    artist: document.getElementById('artist'),
    album: document.getElementById('album'),
    cover: document.getElementById('cover'),
    lyric: document.getElementById('lyric'),
    cur: document.getElementById('cur'),
    dur: document.getElementById('dur'),
    fill: document.getElementById('fill'),
    thumb: document.getElementById('thumb'),
    bar: document.getElementById('bar'),
    btnToggle: document.getElementById('btnToggle'),
    btnPrev: document.getElementById('btnPrev'),
    btnNext: document.getElementById('btnNext'),
    btnRefresh: document.getElementById('btnRefresh'),
    vinyl: document.getElementById('vinyl'),
  }

  function fmt(s) {
    s = Math.max(0, Number(s) || 0)
    const m = Math.floor(s / 60)
    const r = Math.floor(s % 60)
    return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0')
  }

  function proxiedCover(url) {
    if (!url) return ''
    // 预览页无后端时直接显示原图；接入项目后可改为 /api/recommend/image?src=
    return url
  }

  function currentTrack() {
    return queue[index] || queue[0]
  }

  function renderMeta() {
    const t = currentTrack()
    el.title.textContent = t.name
    el.artist.textContent = t.artist
    el.album.textContent = t.album
    el.dur.textContent = fmt(t.duration)

    const coverUrl = proxiedCover(t.cover)
    if (coverUrl) {
      el.cover.classList.add('has-image')
      el.cover.style.backgroundImage = `linear-gradient(145deg, rgba(0,203,100,.2), rgba(0,0,0,.35)), url("${coverUrl}")`
      el.cover.style.backgroundSize = 'cover'
      el.cover.style.backgroundPosition = 'center'
    } else {
      el.cover.classList.remove('has-image')
      el.cover.style.backgroundImage = 'linear-gradient(145deg, rgba(0,203,100,.25), rgba(0,0,0,.4))'
    }
  }

  function renderLyrics() {
    const t = currentTrack()
    el.lyric.innerHTML = ''
    t.lyrics.forEach((line, i) => {
      const row = document.createElement('div')
      row.className = 'soda-lyric-line'
      row.dataset.index = String(i)
      row.innerHTML = `<span class="base"></span><span class="fill"></span>`
      row.querySelector('.base').textContent = line.text
      row.querySelector('.fill').textContent = line.text
      el.lyric.appendChild(row)
    })
  }

  function lineProgress(line, next, time) {
    const start = Number(line.time) || 0
    const end = next ? Number(next.time) : (currentTrack().duration || 0)
    if (end <= start) return time >= start ? 100 : 0
    if (time <= start) return 0
    if (time >= end) return 100
    return ((time - start) / (end - start)) * 100
  }

  function updateLyricHighlight() {
    const t = currentTrack()
    const lines = t.lyrics || []
    const nodes = el.lyric.querySelectorAll('.soda-lyric-line')
    let active = -1
    for (let i = 0; i < lines.length; i += 1) {
      if (simulatedTime + 0.05 >= lines[i].time) active = i
      else break
    }

    nodes.forEach((node, i) => {
      const isActive = i === active
      node.classList.toggle('active', isActive)
      const fill = node.querySelector('.fill')
      if (!fill) return
      if (!isActive) {
        fill.style.width = i < active ? '100%' : '0%'
        fill.style.opacity = i < active ? '0.35' : '0'
      } else {
        const pct = lineProgress(lines[i], lines[i + 1], simulatedTime)
        fill.style.opacity = '1'
        fill.style.width = pct + '%'
        const top = node.offsetTop - el.lyric.clientHeight / 2 + node.clientHeight / 2
        el.lyric.scrollTo({ top: Math.max(top, 0), behavior: 'smooth' })
      }
    })
  }

  function updateProgress() {
    const t = currentTrack()
    const pct = t.duration ? Math.min(100, (simulatedTime / t.duration) * 100) : 0
    el.cur.textContent = fmt(simulatedTime)
    el.fill.style.width = pct + '%'
    el.thumb.style.left = pct + '%'
    updateLyricHighlight()
  }

  function stopTimer() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  function startTimer() {
    stopTimer()
    timer = setInterval(() => {
      simulatedTime += 0.25
      const t = currentTrack()
      if (simulatedTime >= (t.duration || 0)) {
        playRelative(1)
        return
      }
      updateProgress()
    }, 250)
  }

  function setPlaying(next) {
    playing = next
    el.btnToggle.textContent = playing ? '⏸' : '▶'
    el.vinyl.classList.toggle('playing', playing)
    if (playing) startTimer()
    else stopTimer()
  }

  function loadTrack(i, autoplay) {
    index = ((i % queue.length) + queue.length) % queue.length
    simulatedTime = 0
    renderMeta()
    renderLyrics()
    updateProgress()
    setPlaying(Boolean(autoplay))
  }

  function playRelative(step) {
    loadTrack(index + step, true)
  }

  el.btnToggle.addEventListener('click', () => setPlaying(!playing))
  el.btnPrev.addEventListener('click', () => playRelative(-1))
  el.btnNext.addEventListener('click', () => playRelative(1))
  el.btnRefresh.addEventListener('click', () => {
    queue = queue.slice().sort(() => Math.random() - 0.5)
    loadTrack(0, true)
  })
  el.bar.addEventListener('click', (e) => {
    const rect = el.bar.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    simulatedTime = ratio * (currentTrack().duration || 0)
    updateProgress()
  })

  loadTrack(0, false)
})()
