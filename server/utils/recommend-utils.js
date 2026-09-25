/**
 * 推荐播放共用工具：封面 / 歌词解析
 */

function getFirstImageUrl(imageLike) {
  if (!imageLike || typeof imageLike === 'string') {
    return typeof imageLike === 'string' ? imageLike : ''
  }
  if (Array.isArray(imageLike)) {
    return getFirstImageUrl(imageLike[0])
  }
  if (Array.isArray(imageLike.urls) && imageLike.urls.length > 0) {
    return imageLike.urls[0]
  }
  return ''
}

function resolveImageUrl(imageLike) {
  if (!imageLike) return ''
  if (typeof imageLike === 'string') return imageLike

  const firstUrl = getFirstImageUrl(imageLike)
  const uri = imageLike.uri || ''
  const templatePrefix = imageLike.template_prefix || ''

  if (!firstUrl || !uri) return firstUrl

  const templateSuffix = templatePrefix
    ? `~${templatePrefix}-crop-center:400:400.jpg`
    : ''

  if (!firstUrl.includes(uri)) {
    return `${firstUrl}${uri}${templateSuffix}`
  }
  return `${firstUrl}${templateSuffix}`
}

function pickCoverUrl(track = {}) {
  return (
    resolveImageUrl(track.album?.url_cover)
    || resolveImageUrl(track.url_cover)
    || resolveImageUrl(track.cover)
    || resolveImageUrl(track.cover_url)
    || resolveImageUrl(track.medium_cover_url)
    || resolveImageUrl(track.large_cover_url)
    || resolveImageUrl(track.origin_cover)
    || resolveImageUrl(track.album?.cover)
    || resolveImageUrl(track.album?.cover_url)
    || resolveImageUrl(track.album?.thumb_cover_url)
    || resolveImageUrl(track.album?.img_url)
    || ''
  )
}

function getArtistNames(artists) {
  if (!Array.isArray(artists)) return []
  return artists
    .map((artist) => (
      artist?.simple_display_name
      || artist?.user_info?.nickname
      || artist?.name
      || ''
    ))
    .filter(Boolean)
}

function pickTrackFromFeedItem(item) {
  if (!item || typeof item !== 'object') return null
  return (
    item.track
    || item.media
    || item.card?.media
    || item.card?.track
    || item.resource
    || item.item
    || (item.id && item.name ? item : null)
    || null
  )
}

function toProxiedCover(url) {
  if (!url) return ''
  return `/api/recommend/image?src=${encodeURIComponent(url)}`
}

function normalizeRecommendTrack(raw) {
  const track = pickTrackFromFeedItem(raw) || raw
  if (!track || !(track.id || track.track_id || track.media_id)) {
    return null
  }

  const id = String(track.id || track.track_id || track.media_id)
  const name = track.name || track.title || track.track_name || ''
  const artists = getArtistNames(track.artists || track.artist_list || track.artists_v2)
  const album = track.album?.name || track.album_name || ''
  const cover = pickCoverUrl(track)

  return {
    id,
    name: name || `曲目 ${id}`,
    artists,
    artistText: artists.join(' / '),
    album,
    cover,
    coverProxy: toProxiedCover(cover),
    duration: typeof track.duration === 'number'
      ? track.duration
      : (track.duration_ms ? Math.floor(track.duration_ms / 1000) : 0),
  }
}

/**
 * 解析歌词行，支持：
 * - 标准 LRC [mm:ss.xx]
 * - 毫秒 [12345]
 * - KRC 行 [startMs,duration] + 词级 <ms,dur,flag>字
 * 返回 { time, endTime, text, words? }
 */
function parseLrcToLines(lyricText) {
  if (!lyricText || typeof lyricText !== 'string') return []

  const rows = lyricText.replace(/\r\n/g, '\n').split('\n')
  const lines = []

  const pushLine = (timeSec, rawText) => {
    const source = String(rawText || '')
    const wordMatches = [...source.matchAll(/<(\d+)\s*,\s*(\d+)\s*,\s*\d+>([^<]*)/g)]
    let text = source
    const words = []

    if (wordMatches.length > 0) {
      text = wordMatches.map((m) => m[3]).join('')
      for (const m of wordMatches) {
        const wText = m[3]
        if (!wText) continue
        words.push({ time: Number(m[1]) / 1000, text: wText })
      }
    } else {
      text = source
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    }

    if (!text) return
    const line = { time: Number(timeSec) || 0, text }
    if (words.length > 0) line.words = words
    lines.push(line)
  }

  for (const rawRow of rows) {
    const row = rawRow.trim()
    if (!row) continue

    const krc = row.match(/^\[(\d+)\s*,\s*(\d+)\](.*)$/)
    if (krc) {
      pushLine(Number(krc[1] || 0) / 1000, krc[3] || '')
      continue
    }

    const lrcTags = [...row.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)]
    if (lrcTags.length > 0) {
      const body = row.replace(/\[[^\]]*\]/g, '')
      for (const match of lrcTags) {
        const minutes = Number(match[1] || 0)
        const seconds = Number(match[2] || 0)
        const fracRaw = match[3] || '0'
        const frac = fracRaw.length === 1
          ? Number(fracRaw) / 10
          : fracRaw.length === 2
            ? Number(fracRaw) / 100
            : Number(fracRaw) / 1000
        pushLine(minutes * 60 + seconds + frac, body)
      }
      continue
    }

    const msTag = row.match(/^\[(\d{1,8})\](.*)$/)
    if (msTag) {
      pushLine(Number(msTag[1] || 0) / 1000, msTag[2] || '')
    }
  }

  const seen = new Set()
  const unique = []
  for (const line of lines) {
    const key = `${line.time.toFixed(3)}|${line.text}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(line)
  }
  unique.sort((a, b) => a.time - b.time)

  for (let i = 0; i < unique.length; i += 1) {
    const next = unique[i + 1]
    unique[i].endTime = next ? next.time : null
  }

  return unique
}

function flattenLyricNode(node, depth = 0) {
  if (node == null || depth > 6) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) {
    return node.map((item) => flattenLyricNode(item, depth + 1)).filter(Boolean).join('\n')
  }
  if (typeof node === 'object') {
    const preferred = [
      node.content,
      node.lyric,
      node.lrc,
      node.lyric_content,
      node.default_lyric,
      node.text,
      node.value,
    ]
    for (const value of preferred) {
      const text = flattenLyricNode(value, depth + 1)
      if (text && text.trim()) return text
    }
    for (const value of Object.values(node)) {
      if (typeof value === 'string' && /\[/.test(value) && value.length > 5) {
        return value
      }
    }
    for (const value of Object.values(node)) {
      const text = flattenLyricNode(value, depth + 1)
      if (text && text.trim()) return text
    }
  }
  return ''
}

function extractLyricText(payload) {
  const candidates = [
    payload?.lyric,
    payload?.data?.lyric,
    payload?.track?.lyric,
    payload?.track_wrapper?.lyric,
  ]
  for (const node of candidates) {
    const text = flattenLyricNode(node)
    if (text && text.trim()) return text
  }
  return ''
}

function extractPlayMetaFromTrackPayload(payload) {
  const track = payload?.track || payload?.data?.track || {}
  const artists = getArtistNames(track.artists)
  const cover = pickCoverUrl(track)
  const lyricText = extractLyricText(payload)
  const isCollected = Boolean(
    payload?.is_collected
    ?? track.is_collected
    ?? track.collected
    ?? track.is_liked
  )
  return {
    id: String(track.id || payload?.track_id || ''),
    name: track.name || '',
    artists,
    artistText: artists.join(' / '),
    album: track.album?.name || '',
    cover,
    coverProxy: toProxiedCover(cover),
    duration: typeof track.duration === 'number' ? track.duration : 0,
    lyricText,
    lyricLines: parseLrcToLines(lyricText),
    isCollected,
    liked: isCollected,
  }
}

module.exports = {
  getFirstImageUrl,
  resolveImageUrl,
  pickCoverUrl,
  getArtistNames,
  normalizeRecommendTrack,
  parseLrcToLines,
  extractLyricText,
  extractPlayMetaFromTrackPayload,
  toProxiedCover,
}
