/**
 * 歌词补充获取：track_v2 未带 lyric 时，回退请求 /luna/pc/track
 */

const { endpoints, fixed, getPcQuery, baseUrl } = require('../config/qishui-auth')
const { buildUrl } = require('./http')
const { fetchWithTimeout } = require('./fetch-with-timeout')
const { initSigner, generateSignatureHeaders } = require('./bdms-signer')
const { extractLyricText } = require('./recommend-utils')
const { logger } = require('./logger')

const lyricLogger = logger.child('LyricFetch')

async function fetchTrackLyricFallback({ sessionid, track_id, aid = fixed.aid }) {
  const candidates = [
    `${baseUrl}/luna/pc/track`,
    `${baseUrl}/luna/track`,
  ]

  for (const endpoint of candidates) {
    try {
      const target = buildUrl(endpoint, getPcQuery({ aid }))
      initSigner('2117006317868281')
      const sigHeaders = generateSignatureHeaders(target, {
        'content-type': 'application/json; charset=utf-8',
        'user-agent': 'LunaPC/3.7.0(452316191)',
      })

      const upstream = await fetchWithTimeout(target, {
        method: 'POST',
        headers: {
          Cookie: `sessionid=${sessionid};`,
          'Content-Type': 'application/json; charset=utf-8',
          'User-Agent': 'LunaPC/3.7.0(452316191)',
          ...sigHeaders,
        },
        body: JSON.stringify({
          track_id,
          media_type: 'track',
          includes: ['track', 'lyric', 'track_player'],
        }),
      }, 20 * 1000)

      const rawText = await upstream.text()
      let payload = {}
      try {
        payload = rawText ? JSON.parse(rawText) : {}
      } catch {
        payload = {}
      }

      const lyricText = extractLyricText(payload)
      lyricLogger.debug('lyric.fallbackResult', {
        track_id,
        endpoint,
        status: upstream.status,
        statusCode: payload?.status_code,
        hasLyric: Boolean(lyricText),
        lyricLength: lyricText?.length || 0,
        topKeys: Object.keys(payload || {}).slice(0, 15),
      })

      if (lyricText) {
        return lyricText
      }
    } catch (error) {
      lyricLogger.warn('lyric.fallbackFailed', {
        track_id,
        endpoint,
        error: error?.message,
      })
    }
  }

  return ''
}

module.exports = {
  fetchTrackLyricFallback,
}
