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

/**
 * 汽水图片 URLInfo：{ urls[], uri, template_prefix }
 * 与 ResourceDetailModal.resolveImageUrl 保持一致。
 */
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
    || resolveImageUrl(track.medium_cover_url)
    || resolveImageUrl(track.large_cover_url)
    || resolveImageUrl(track.album?.cover)
    || resolveImageUrl(track.album?.thumb_cover_url)
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
 * 解析歌词行为。
 * 支持：
 * 1) 标准 LRC：[mm:ss.xx]文本
 * 2) 毫秒戳：[12345]文本 / [12345.6]文本
 * 3) 汽水/类 KRC 行：[startMs,duration]文本（去掉 <词级时间> 标签）
 */
function parseLrcToLines(lyricText) {
  if (!lyricText || typeof lyricText !== 'string') return []

  const rows = lyricText.replace(/\r\n/g, '\n').split('\n')
  const lines = []

  for (const rawRow of rows) {
    const row = rawRow.trim()
    if (!row) continue

    // [startMs,duration] content
    const krc = row.match(/^\[(\d+)\s*,\s*(\d+)\](.*)$/)
    if (krc) {
      const startMs = Number(krc[1] || 0)
      const text = String(krc[3] || '')
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
      if (text) {
        lines.push({ time: startMs / 1000, text })
      }
      continue
    }

    // [mm:ss.xx] or [mm:ss.xxx] or [mm:ss]
    const lrcTags = [...row.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)]
    if (lrcTags.length > 0) {
      const text = row
        .replace(/\[[^\]]*\]/g, '')
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
      if (!text) continue
      for (const match of lrcTags) {
        const minutes = Number(match[1] || 0)
        const seconds = Number(match[2] || 0)
        const fracRaw = match[3] || '0'
        const frac = fracRaw.length === 1
          ? Number(fracRaw) / 10
          : fracRaw.length === 2
            ? Number(fracRaw) / 100
            : Number(fracRaw) / 1000
        lines.push({ time: minutes * 60 + seconds + frac, text })
      }
      continue
    }

    // [12345] text（纯毫秒）
    const msTag = row.match(/^\[(\d{1,8})\](.*)$/)
    if (msTag) {
      const text = String(msTag[2] || '')
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
      if (text) {
        lines.push({ time: Number(msTag[1] || 0) / 1000, text })
      }
    }
  }

  // 去重（同一时间同一句）
  const seen = new Set()
  const unique = []
  for (const line of lines) {
    const key = `${line.time.toFixed(3)}|${line.text}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(line)
  }
  unique.sort((a, b) => a.time - b.time)
  return unique
}

function flattenLyricNode(node, depth = 0) {
  if (node == null || depth > 6) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) {
    return node.map((item) => flattenLyricNode(item, depth + 1)).filter(Boolean).join('\n')
  }
  if (typeof node === 'object') {
    // 汽水客户端使用 lyric.content
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
    // 兜底：扫描所有字符串字段
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
  return {
    id: String(track.id || payload?.track_id || ''),
    name: track.name || '',
    artists,
    artistText: artists.join(' / '),
    album: track.album?.name || '',
    cover,
    coverProxy: cover ? `/api/recommend/image?src=${encodeURIComponent(cover)}` : '',
    duration: typeof track.duration === 'number' ? track.duration : 0,
    lyricText,
    lyricLines: parseLrcToLines(lyricText),
  }
}

function toProxiedCover(url) {
  if (!url) return ''
  return `/api/recommend/image?src=${encodeURIComponent(url)}`
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
