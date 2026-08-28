const { endpoints, fixed, getPcQuery } = require('../config/qishui-auth')
const { buildUrl } = require('./http')
const { TrackDecryptor } = require('./track-decryptor')
const { FlacMetadataWriter } = require('./flac-metadata')
const { fetchWithTimeout, LONG_TIMEOUT_MS } = require('./fetch-with-timeout')
const { initSigner, generateSignatureHeaders } = require('./bdms-signer')
const { logger } = require('./logger')

const trackLogger = logger.child('TrackDownload')

function getArtistName(trackPayload) {
  const artists = Array.isArray(trackPayload?.track?.artists) ? trackPayload.track.artists : []
  const firstArtist = artists[0]

  return (
    firstArtist?.simple_display_name ||
    firstArtist?.user_info?.nickname ||
    firstArtist?.name ||
    ''
  )
}

function getArtistNames(trackPayload) {
  const artists = Array.isArray(trackPayload?.track?.artists) ? trackPayload.track.artists : []

  return artists
    .map((artist) => (
      artist?.simple_display_name ||
      artist?.user_info?.nickname ||
      artist?.name ||
      ''
    ))
    .filter(Boolean)
}

function getNames(list) {
  if (!Array.isArray(list)) {
    return []
  }

  return list
    .map((item) => item?.name || '')
    .filter(Boolean)
}

function getReleaseDate(trackPayload) {
  const releaseTimestamp = trackPayload?.track?.album?.release_date

  if (typeof releaseTimestamp !== 'number' || Number.isNaN(releaseTimestamp) || releaseTimestamp <= 0) {
    return ''
  }

  return new Date(releaseTimestamp * 1000).toISOString().slice(0, 10)
}

function getGenreNames(trackPayload) {
  const tags = Array.isArray(trackPayload?.track?.tags) ? trackPayload.track.tags : []
  const genreNames = []

  for (const tag of tags) {
    const secondLevel = tag?.second_level_tag?.tag_name
    const firstLevel = tag?.first_level_tag?.tag_name

    if (secondLevel) {
      genreNames.push(secondLevel)
      continue
    }

    if (firstLevel) {
      genreNames.push(firstLevel)
    }
  }

  return [...new Set(genreNames)]
}

function getFirstImageUrl(imageLike) {
  if (!imageLike || !Array.isArray(imageLike.urls) || imageLike.urls.length === 0) {
    return ''
  }

  return imageLike.urls[0]
}

function resolveImageUrl(imageLike) {
  if (!imageLike) {
    return ''
  }

  const firstUrl = getFirstImageUrl(imageLike)
  const uri = imageLike.uri || ''
  const templatePrefix = imageLike.template_prefix || ''

  if (!firstUrl || !uri) {
    return firstUrl
  }

  const templateSuffix = templatePrefix
    ? `~${templatePrefix}-crop-center:800:800.jpg`
    : ''

  if (!firstUrl.includes(uri)) {
    return `${firstUrl}${uri}${templateSuffix}`
  }

  return `${firstUrl}${templateSuffix}`
}

function buildFlacMetadata(trackPayload) {
  const artists = getArtistNames(trackPayload)
  const composers = getNames(trackPayload?.track?.song_maker_team?.composers)
  const lyricists = getNames(trackPayload?.track?.song_maker_team?.lyricists)
  const genres = getGenreNames(trackPayload)
  const releaseDate = getReleaseDate(trackPayload)

  return {
    title: trackPayload?.track?.name || '',
    artist: artists,
    album: trackPayload?.track?.album?.name || '',
    albumArtist: artists,
    date: releaseDate,
    year: releaseDate ? releaseDate.slice(0, 4) : '',
    genre: genres,
    composer: composers,
    lyricist: lyricists,
  }
}

function getTrackV2Payload(reqBody) {
  const {
    aid = fixed.aid,
    sessionid,
    track_id,
  } = reqBody || {}

  return {
    aid,
    sessionid,
    track_id,
    media_type: 'track',
    queue_type: 'search_one_track',
    scene_name: 'search',
  }
}

async function fetchTrackPayload({ aid = fixed.aid, sessionid, track_id }) {
  const trackV2Url = buildUrl(endpoints.trackV2, getPcQuery({ aid }))
  trackLogger.debug(`Fetching track payload`, { track_id, aid })

  // 初始化 BDMS 签名模块（使用 SodaMusic 的 device_id）
  initSigner('2117006317868281')

  const requestBody = JSON.stringify({
    track_id,
    media_type: 'track',
    queue_type: 'search_one_track',
    scene_name: 'search',
  })

  // 生成签名头
  const sigHeaders = generateSignatureHeaders(trackV2Url, {
    'content-type': 'application/json; charset=utf-8',
    'user-agent': 'LunaPC/3.7.0(452316191)',
    'accept-encoding': 'gzip, deflate',
  })

  const startTime = Date.now()
  const trackV2Response = await fetchWithTimeout(trackV2Url, {
    method: 'POST',
    headers: {
      Cookie: `sessionid=${sessionid};`,
      'Content-Type': 'application/json; charset=utf-8',
      'Accept-Encoding': 'gzip, deflate',
      'User-Agent': 'LunaPC/3.7.0(452316191)',
      ...sigHeaders,
    },
    body: requestBody,
  }, 30 * 1000)

  // 【修复 JSON 解析错误】与 server/apis/track-v2.js 保持一致：text-first 健壮解析
  //  原代码直接 trackV2Response.json() → qishui 后端 session 过期 / 限流 / 空响应 / 返回 HTML 登录页时，
  //  JSON.parse 会直接抛 "Unexpected end of JSON input"，没有任何原始回包上下文，无法排查。
  const rawText = await trackV2Response.text()
  trackLogger.debug(`Track payload raw response`, {
    track_id,
    status: trackV2Response.status,
    contentType: trackV2Response.headers?.get?.('content-type') || '',
    rawLength: rawText?.length || 0,
    rawPreview: String(rawText || '').slice(0, 500),
  })
  let trackPayload
  try {
    trackPayload = rawText ? JSON.parse(rawText) : {}
  } catch (parseErr) {
    const preview = String(rawText || '').slice(0, 500)
    const looksLikeHtml = /<html|<body|<title/i.test(preview)
    trackLogger.error(`Track payload JSON parse failed`, {
      track_id,
      status: trackV2Response.status,
      contentType: trackV2Response.headers?.get?.('content-type') || '',
      isHtml: looksLikeHtml,
      rawPreview: preview,
      error: parseErr?.message,
      elapsedMs: Date.now() - startTime,
    })
    const friendly = looksLikeHtml
      ? '会话已过期或后端返回登录页（HTML），请重新登录汽水音乐'
      : `汽水音乐返回非 JSON 内容（HTTP ${trackV2Response.status}）：${preview.slice(0, 80)}`
    const error = new Error(friendly)
    error.status = trackV2Response.status >= 400 ? trackV2Response.status : 502
    error.payload = { rawText: preview }
    throw error
  }

  if (!trackV2Response.ok) {
    trackLogger.error(`Track payload request failed`, {
      track_id,
      status: trackV2Response.status,
      error: trackPayload?.error || trackPayload?.message,
      statusCode: trackPayload?.status_code,
      elapsedMs: Date.now() - startTime,
    })
    const error = new Error(trackPayload?.error || trackPayload?.message || `获取音频信息失败（HTTP ${trackV2Response.status}）`)
    error.status = trackV2Response.status
    error.payload = trackPayload
    throw error
  }

  // 【修复 status_code 业务校验】汽水音乐接口即使 HTTP 200，业务失败也会通过 status_code !== 0 返回
  //  典型：status_code=100003（登录态过期）、status_code=100004（无权限/地区限制）。
  //  不拦截的话，下面 video_model 为空 → 抛 "video_model not found"，看不出真实原因。
  const businessCode = Number(trackPayload?.status_code)
  if (Number.isFinite(businessCode) && businessCode !== 0) {
    const msg = trackPayload?.message || trackPayload?.status_msg || `汽水音乐业务错误 status_code=${businessCode}`
    trackLogger.warn(`Track payload business error`, {
      track_id,
      status_code: businessCode,
      message: msg,
      elapsedMs: Date.now() - startTime,
    })
    const error = new Error(msg)
    error.status = 422
    error.payload = trackPayload
    throw error
  }

  // 【修复 video_model 缺失根因定位不足】原日志只打印 hasVideoModel=true/false，
  //  全部为 false 时完全不知道是 (a) 顶层字段改名（如 track_player→audio_player），
  //  (b) video_model→audio_model，(c) 登录态虽然 status_code=0 但资源字段被隐藏。
  //  现在强化：当 hasVideoModel=false 时，把顶层 keys / track_player keys / track keys 全打印出来。
  const trackPlayerKeys = trackPayload?.track_player
    ? Object.keys(trackPayload.track_player).slice(0, 30)
    : null
  const trackKeys = trackPayload?.track
    ? Object.keys(trackPayload.track).slice(0, 30)
    : null
  const dataTopKeys = trackPayload?.data
    ? Object.keys(trackPayload.data).slice(0, 30)
    : null
  const hasTrackPlayer = Boolean(trackPayload?.track_player)
  const hasTrack = Boolean(trackPayload?.track)
  const hasData = Boolean(trackPayload?.data)
  trackLogger.debug(`Track payload fetched`, {
    track_id,
    trackName: trackPayload?.track?.name || trackPayload?.data?.track?.name,
    status_code: businessCode,
    topKeys: Object.keys(trackPayload || {}).slice(0, 30),
    hasTrackPlayer,
    hasTrack,
    hasData,
    trackPlayerKeys,
    trackKeys,
    dataKeys: dataTopKeys,
    hasVideoModel: Boolean(
      trackPayload?.track_player?.video_model
      || trackPayload?.track_player?.audio_model
      || trackPayload?.track?.video_model
      || trackPayload?.data?.track_player?.video_model
      || trackPayload?.data?.tracks?.[0]?.video_model,
    ),
    elapsedMs: Date.now() - startTime,
  })

  return trackPayload
}

async function downloadTrackMedia({ sessionid, track_id, quality, aid = fixed.aid }) {
  const overallStart = Date.now()
  trackLogger.info(`Starting track download`, { track_id, quality, aid })

  const flacMetadataWriter = new FlacMetadataWriter()
  const trackPayload = await fetchTrackPayload({ aid, sessionid, track_id })

  // 【修复 video_model 提取路径单一 + 错误信息无差别】
  //  原代码只取 trackPayload.track_player.video_model → 一旦汽水改字段名 / 换外层结构
  //  → 全部 undefined → 统一抛 "track video_model not found"，完全无法区分是：
  //  (a) 字段名变 audio_model / video_info
  //  (b) 外层从 track_player 变成 audio_player
  //  (c) 内容包了一层 data（data.track_player... 或 data.tracks[0]...）
  //  (d) 登录态虽然 status_code=0 但该曲目受版权/会员/地区限制，资源字段被整体隐藏
  //  现在按优先级做 6 条路径兼容，并把每一层的缺失原因翻译成明确的中文错误。
  const videoModelCandidates = [
    // ① 标准路径：汽水 PC 客户端的旧/当前接口返回
    { path: 'trackPayload.track_player.video_model', value: trackPayload?.track_player?.video_model },
    // ② 兼容：可能改名为 audio_model（音频资源字段改名）
    { path: 'trackPayload.track_player.audio_model', value: trackPayload?.track_player?.audio_model },
    // ③ 兼容：可能直接挂在 track 对象上
    { path: 'trackPayload.track.video_model', value: trackPayload?.track?.video_model },
    // ④ 兼容：可能外层多包了一层 data（代理 API / 新接口结构）
    { path: 'trackPayload.data.track_player.video_model', value: trackPayload?.data?.track_player?.video_model },
    // ⑤ 兼容：可能是 data.tracks 数组结构（和原代码注释中的老结构一致）
    { path: 'trackPayload.data.tracks[0].video_model', value: trackPayload?.data?.tracks?.[0]?.video_model },
    // ⑥ 兼容：track 自己有 audio_model 的可能
    { path: 'trackPayload.track.audio_model', value: trackPayload?.track?.audio_model },
  ]
  const match = videoModelCandidates.find((c) => typeof c.value === 'string' && c.value.length > 0)
  const videoModelRaw = match ? match.value : undefined

  if (!videoModelRaw) {
    // 【分层中文错误】告诉用户具体是哪一层缺失，而不是千篇一律的 track video_model not found
    const hasTrackPlayer = Boolean(trackPayload?.track_player)
    const hasTrack = Boolean(trackPayload?.track)
    const trackPlayerKeys = trackPayload?.track_player ? Object.keys(trackPayload.track_player).slice(0, 20) : []
    const trackKeys = trackPayload?.track ? Object.keys(trackPayload.track).slice(0, 20) : []
    const trackPlayerKeysStr = trackPlayerKeys.length ? trackPlayerKeys.join(',') : '（无）'
    const trackKeysStr = trackKeys.length ? trackKeys.join(',') : '（无）'
    let reason
    if (!hasTrackPlayer && !hasTrack) {
      reason = `响应结构异常：既没有 track_player 也没有 track 字段；顶层 keys=${Object.keys(trackPayload || {}).slice(0, 20).join(',')}`
    } else if (hasTrackPlayer && !trackPlayerKeys.some((k) => /video_model|audio_model|resource|media/i.test(k))) {
      reason = `该曲目暂无可用音频资源（可能受版权/会员/地区限制，或登录态权限不足）：track_player 中无 video_model/audio_model 字段，实际包含：${trackPlayerKeysStr}`
    } else if (hasTrackPlayer) {
      reason = `track_player 存在，但其中 video_model/audio_model 字段内容为空，实际包含：${trackPlayerKeysStr}`
    } else {
      reason = `未找到视频/音频元数据字段：track_player 不存在，track 仅含 ${trackKeysStr}；可能曲目无资源或接口结构已变更`
    }
    trackLogger.error(`Track 资源解析失败`, {
      track_id,
      reason,
      usedPath: null,
      triedPaths: videoModelCandidates.map((c) => c.path),
      hasTrackPlayer,
      hasTrack,
      trackPlayerKeys,
      trackKeys,
      dataTopKeys: trackPayload?.data ? Object.keys(trackPayload.data).slice(0, 20) : null,
    })
    const error = new Error(reason)
    error.status = 404
    throw error
  }

  let videoModel = null

  try {
    videoModel = JSON.parse(videoModelRaw)
  } catch (parseErr) {
    trackLogger.error(`Track video_model parse failed`, {
      track_id,
      error: parseErr?.message,
      rawPreview: String(videoModelRaw).slice(0, 200),
    })
    const error = new Error('track video_model parse failed')
    error.status = 500
    throw error
  }

  const videoList = Array.isArray(videoModel?.video_list) ? videoModel.video_list : []
  trackLogger.debug(`Available qualities`, {
    track_id,
    qualities: videoList.map((v) => ({
      quality: v?.video_meta?.quality,
      definition: v?.video_meta?.definition,
      size: v?.video_meta?.size,
      vtype: v?.video_meta?.vtype,
    })).filter((q) => q.quality),
    requestedQuality: quality,
  })

  // 【修复 quality 匹配策略】前端 / batch 任务传入的 quality 是：
  //   - 'highest' / 'lowest' （语义型：选最高/最低品质）
  //   - 或具体品质标识字符串（如 'flac' / 'hires' / 'standard' 等）
  //  原代码只做 find(item.quality === quality) 全等匹配 → 当传 'highest' 时匹配不到任何项，
  //  → 抛 quality download url not found → 任务失败 → 用户看到 .bin。
  let matchedItem = null
  const listWithSize = videoList
    .filter((item) => item?.main_url || item?.backup_url)
    .map((item) => ({
      item,
      size: typeof item?.video_meta?.size === 'number' ? item.video_meta.size : -1,
    }))
  if (listWithSize.length === 0) {
    // 继续走下面的 quality not found 统一错误
  } else if (quality === 'highest' || !quality) {
    // 最高品质：按 size 降序取第一
    listWithSize.sort((a, b) => b.size - a.size)
    matchedItem = listWithSize[0]?.item
  } else if (quality === 'lowest') {
    // 最低品质：按 size 升序取第一（忽略 -1 的未知大小项排到最后）
    const known = listWithSize.filter((x) => x.size >= 0)
    const unknown = listWithSize.filter((x) => x.size < 0)
    known.sort((a, b) => a.size - b.size)
    const sorted = known.concat(unknown)
    matchedItem = sorted[0]?.item
  } else {
    matchedItem = videoList.find((item) => item?.video_meta?.quality === quality)
  }

  if (!matchedItem?.main_url) {
    trackLogger.error(`Quality not found`, {
      track_id,
      requestedQuality: quality,
      availableQualities: videoList.map((v) => v?.video_meta?.quality).filter(Boolean),
    })
    const error = new Error(
      videoList.length === 0
        ? '该曲目暂无可用的下载资源（可能受版权/地区/会员限制）'
        : `品质 ${quality} 未找到可用下载地址；可用品质：${videoList.map((v) => v?.video_meta?.quality).filter(Boolean).join(', ') || '无'}`,
    )
    error.status = 404
    throw error
  }

  trackLogger.debug(`Fetching encrypted media`, {
    track_id,
    quality,
    urlPreview: String(matchedItem.main_url).slice(0, 100) + '...',
  })

  const mediaStart = Date.now()
  const mediaResponse = await fetchWithTimeout(matchedItem.main_url, {
    headers: {
      'User-Agent': 'libcurl-agent/1.0',
    },
    redirect: 'follow',
  }, LONG_TIMEOUT_MS)

  if (!mediaResponse.ok) {
    const errorText = await mediaResponse.text().catch(() => '')
    trackLogger.error(`Media fetch failed`, {
      track_id,
      status: mediaResponse.status,
      error: errorText?.slice(0, 300) || mediaResponse.statusText,
      elapsedMs: Date.now() - mediaStart,
    })
    const error = new Error(errorText || `upstream status ${mediaResponse.status}`)
    error.status = mediaResponse.status
    throw error
  }

  const encryptedBuffer = Buffer.from(await mediaResponse.arrayBuffer())
  trackLogger.debug(`Encrypted media downloaded`, {
    track_id,
    sizeBytes: encryptedBuffer.length,
    elapsedMs: Date.now() - mediaStart,
  })

  trackLogger.debug(`Starting decryption`, { track_id, hasSpadeA: Boolean(matchedItem?.encrypt_info?.spade_a) })
  const decryptStart = Date.now()
  const decryptor = new TrackDecryptor()
  let result
  try {
    result = decryptor.decrypt({
      encryptedBuffer,
      spadeA: matchedItem?.encrypt_info?.spade_a || '',
      media: {
        title: trackPayload?.track?.name || '',
        artist: getArtistName(trackPayload),
      },
    })
    trackLogger.debug(`Decryption complete`, {
      track_id,
      extension: result.extension,
      isFlac: result.meta?.isFlac,
      sampleCount: result.meta?.sampleCount,
      outputSize: result.buffer.length,
      elapsedMs: Date.now() - decryptStart,
    })
  } catch (decryptErr) {
    trackLogger.error(`Decryption failed`, {
      track_id,
      error: decryptErr?.message,
      stack: decryptErr?.stack?.slice(0, 500),
    })
    throw decryptErr
  }

  let outputBuffer = result.buffer

  if (result.extension === '.flac') {
    trackLogger.debug(`Writing FLAC metadata`, { track_id })
    const metaStart = Date.now()
    try {
      const metadata = buildFlacMetadata(trackPayload)
      const coverUrl = resolveImageUrl(trackPayload?.track?.album?.url_cover)
      let coverData = null

      if (coverUrl) {
        try {
          coverData = await flacMetadataWriter.fetchCoverBuffer(coverUrl)
          trackLogger.debug(`Cover fetched`, {
            track_id,
            coverSize: coverData?.buffer?.length,
            mime: coverData?.mime,
          })
        } catch (coverErr) {
          trackLogger.warn(`Cover fetch failed, skipping`, {
            track_id,
            error: coverErr?.message,
          })
          coverData = null
        }
      }

      outputBuffer = await flacMetadataWriter.writeBufferTags({
        flacBuffer: result.buffer,
        metadata,
        coverBuffer: coverData?.buffer || null,
        coverMime: coverData?.mime || null,
      })
      trackLogger.debug(`FLAC metadata written`, {
        track_id,
        outputSize: outputBuffer.length,
        elapsedMs: Date.now() - metaStart,
      })
    } catch (metaErr) {
      trackLogger.warn(`FLAC metadata write failed, using raw buffer`, {
        track_id,
        error: metaErr?.message,
        stack: metaErr?.stack?.slice(0, 300),
      })
      outputBuffer = result.buffer
    }
  }

  trackLogger.info(`Track download completed`, {
    track_id,
    quality,
    fileName: result.fileName,
    outputSize: outputBuffer.length,
    contentType: result.extension === '.flac' ? 'audio/flac' : 'audio/mp4',
    totalElapsedMs: Date.now() - overallStart,
  })

  return {
    buffer: outputBuffer,
    fileName: result.fileName,
    contentType: result.extension === '.flac' ? 'audio/flac' : 'audio/mp4',
    trackPayload,
  }
}

module.exports = {
  getTrackV2Payload,
  downloadTrackMedia,
}
