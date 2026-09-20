/**
 * 推荐 / 本机播放日志键补充由 locales 承载；此处为推荐播放共用工具。
 */

function getFirstImageUrl(imageLike) {
  if (!imageLike || !Array.isArray(imageLike.urls) || imageLike.urls.length === 0) {
    return ''
  }
  return imageLike.urls[0]
}

function resolveImageUrl(imageLike) {
  if (!imageLike) return ''
  const firstUrl = getFirstImageUrl(imageLike)
  const uri = imageLike.uri || ''
  const templatePrefix = imageLike.template_prefix || ''
  if (!firstUrl || !uri) return firstUrl
  const templateSuffix = templatePrefix ? `~${templatePrefix}-crop-center:400:400.jpg` : ''
  if (!firstUrl.includes(uri)) {
    return `${firstUrl}${uri}${templateSuffix}`
  }
  return `${firstUrl}${templateSuffix}`
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
  const cover = resolveImageUrl(
    track.cover
    || track.album?.cover
    || track.album?.image
    || track.cover_url
    || track.image
    || track.medium_cover_url
    || track.large_cover_url
  )

  return {
    id,
    name: name || `曲目 ${id}`,
    artists,
    artistText: artists.join(' / '),
    album,
    cover,
    duration: typeof track.duration === 'number' ? track.duration : (track.duration_ms ? Math.floor(track.duration_ms / 1000) : 0),
  }
}

function parseLrcToLines(lyricText) {
  if (!lyricText || typeof lyricText !== 'string') return []

  const rows = lyricText.split(/\r?\n/)
  const lines = []

  for (const row of rows) {
    const matches = [...row.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)]
    if (matches.length === 0) continue
    const text = row.replace(/\[[^\]]+\]/g, '').trim()
    if (!text) continue
    for (const match of matches) {
      const minutes = Number(match[1] || 0)
      const seconds = Number(match[2] || 0)
      const fracRaw = match[3] || '0'
      const frac = fracRaw.length === 1
        ? Number(fracRaw) / 10
        : fracRaw.length === 2
          ? Number(fracRaw) / 100
          : Number(fracRaw) / 1000
      const time = minutes * 60 + seconds + frac
      lines.push({ time, text })
    }
  }

  lines.sort((a, b) => a.time - b.time)
  return lines
}

function extractLyricText(payload) {
  const lyric = payload?.lyric
  if (!lyric) return ''
  if (typeof lyric === 'string') return lyric
  return (
    lyric.lyric
    || lyric.lrc
    || lyric.content
    || lyric.lyric_content
    || lyric.default_lyric
    || ''
  )
}

function extractPlayMetaFromTrackPayload(payload) {
  const track = payload?.track || payload?.data?.track || {}
  const artists = getArtistNames(track.artists)
  const cover = resolveImageUrl(
    track.cover
    || track.medium_cover_url
    || track.large_cover_url
    || track.album?.cover
  )
  const lyricText = extractLyricText(payload)
  return {
    id: String(track.id || payload?.track_id || ''),
    name: track.name || '',
    artists,
    artistText: artists.join(' / '),
    album: track.album?.name || '',
    cover,
    duration: typeof track.duration === 'number' ? track.duration : 0,
    lyricText,
    lyricLines: parseLrcToLines(lyricText),
  }
}

module.exports = {
  getFirstImageUrl,
  resolveImageUrl,
  getArtistNames,
  normalizeRecommendTrack,
  parseLrcToLines,
  extractLyricText,
  extractPlayMetaFromTrackPayload,
}
