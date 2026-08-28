/**
 * 分享链接解析接口（POST /api/share/resolve）
 * 接收用户粘贴的分享文本 / 分享链接，GET 访问分享落地页 HTML，
 * 通过正则提取其中夹带的 track_id / video_id / aweme_id 等资源 ID，
 * 交给前端再根据资源类型走后续的音乐 / 视频下载流程。
 *
 * 原本存在的问题：
 *  1) fetch() 没有设置超时：网络/目标站无响应时请求会永久挂起，
 *     前端表现为「解析中」永远转圈（与其它下载卡住属同一类 bug）。
 *  2) upstream.text() 未限制大小：若用户粘贴的 URL 指向视频/压缩包等二进制资源，
 *     会直接把几百 MB 内容读进内存，造成后端 OOM。
 *  3) 缺少请求 / 响应日志：线上出现解析失败时无法快速定位具体分享链接和原因。
 */

const { fetchWithTimeout } = require('../utils/fetch-with-timeout')
const { logger } = require('../utils/logger')

const shareResolveLogger = logger.child('ShareResolve')

// 分享落地页 HTML 的最大响应字节。正常 qishui / douyin share 页 < 5MB。
// 超过上限认为粘贴了视频/二进制直链，直接拒绝防止内存爆炸。
const MAX_HTML_SIZE_BYTES = 5 * 1024 * 1024

function extractFirstUrl(input) {
  if (typeof input !== 'string') {
    return ''
  }

  const match = input.match(/https?:\/\/[^\s]+/i)
  return match ? match[0].trim() : ''
}

function normalizeShareUrl(input) {
  const rawUrl = extractFirstUrl(input) || String(input || '').trim()

  if (!rawUrl) {
    return ''
  }

  try {
    const url = new URL(rawUrl)
    url.hash = ''
    return url.toString()
  } catch {
    return ''
  }
}

function getIdFromUrl(url, key) {
  if (!url) {
    return ''
  }

  try {
    const target = new URL(url)
    return target.searchParams.get(key) || ''
  } catch {
    return ''
  }
}

function matchFirst(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match?.[1]) {
      return match[1]
    }
  }

  return ''
}

function resolveTrackId(html, finalUrl) {
  return (
    getIdFromUrl(finalUrl, 'track_id') ||
    // 从 URL 路径提取：/share/music/{id}、/qishui/song/{id} 等
    matchFirst(finalUrl, [
      /\/share\/music\/(\d+)/i,
      /\/qishui\/song\/(\d+)/i,
    ]) ||
    matchFirst(html, [
      /"track_id":"?(\d+)"/i,
      /"track_id":(\d+)/i,
      /\btrack_id=(\d+)/i,
      /"trackId":"?(\d+)"/i,
    ])
  )
}

function resolveVideoId(html, finalUrl) {
  return (
    getIdFromUrl(finalUrl, 'video_id') ||
    getIdFromUrl(finalUrl, 'item_id') ||
    getIdFromUrl(finalUrl, 'aweme_id') ||
    // 从 URL 路径提取：/video/{id}、/share/video/{id} 等
    matchFirst(finalUrl, [
      /\/video\/(\d+)/i,
      /\/share\/video\/(\d+)/i,
    ]) ||
    matchFirst(html, [
      /"video_id":"?(\d+)"/i,
      /"video_id":(\d+)/i,
      /"videoId":"?(\d+)"/i,
      /"aweme_id":"?(\d+)"/i,
    ])
  )
}

module.exports = {
  name: 'share-resolve',
  method: 'post',
  path: '/api/share/resolve',
  handler: async (req, res) => {
    const startTime = Date.now()
    const shareText = req.body?.share_text || req.body?.url || ''
    const shareUrl = normalizeShareUrl(shareText)

    shareResolveLogger.info(`Share resolve request received`, {
      shareUrlPreview: shareUrl ? shareUrl.slice(0, 160) : '',
      hasBody: Boolean(shareText),
    })

    // ---- 输入校验：必须能提取出合法 HTTP URL ----
    if (!shareUrl) {
      shareResolveLogger.warn(`Share resolve: invalid share url`)
      res.status(400).json({
        message: '分享链接格式无效，请粘贴完整链接。',
      })
      return
    }

    try {
      // 【修复1】使用带超时的 fetchWithTimeout，30 秒没响应直接抛 504 TimeoutError
      const upstream = await fetchWithTimeout(shareUrl, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          referer: 'https://qishui.douyin.com/',
        },
      }, 30 * 1000)

      const finalUrl = upstream.url || shareUrl

      // 【修复2】在 text() 之前先检查 content-length 上限；超大响应直接截断，避免 OOM
      const contentLength = Number(upstream.headers.get('content-length')) || 0
      if (contentLength > MAX_HTML_SIZE_BYTES) {
        shareResolveLogger.warn(`Share resolve: upstream response too large`, {
          shareUrl,
          contentLength,
          limit: MAX_HTML_SIZE_BYTES,
          finalUrl,
        })
        res.status(422).json({
          message: '分享链接响应过大，请确认粘贴的是普通分享页而非二进制文件直链。',
          final_url: finalUrl,
        })
        return
      }

      // 读之前再次兜底：即使 content-length 缺失，也只读上限 + 1 字节，
      // 若实际超出上限就抛错（避免 chunked 传输把大文件整段读入内存）。
      const rawBuffer = Buffer.from(await upstream.arrayBuffer())
      if (rawBuffer.length > MAX_HTML_SIZE_BYTES) {
        shareResolveLogger.warn(`Share resolve: upstream body exceeded limit`, {
          shareUrl,
          bodyLength: rawBuffer.length,
          limit: MAX_HTML_SIZE_BYTES,
        })
        res.status(422).json({
          message: '分享链接响应过大，请确认粘贴的是普通分享页而非二进制文件直链。',
          final_url: finalUrl,
        })
        return
      }

      const html = rawBuffer.toString('utf8')
      const trackId = resolveTrackId(html, finalUrl)
      const videoId = resolveVideoId(html, finalUrl)

      shareResolveLogger.debug(`Share resolve: parsed ids`, {
        finalUrl,
        trackId,
        videoId,
        htmlLength: html.length,
        httpStatus: upstream.status,
        elapsedMs: Date.now() - startTime,
      })

      if (!trackId && !videoId) {
        shareResolveLogger.warn(`Share resolve: no resource id found`, { finalUrl, httpStatus: upstream.status })
        res.status(422).json({
          message: '未能从分享页中解析出 track_id 或 video_id。',
          final_url: finalUrl,
        })
        return
      }

      shareResolveLogger.info(`Share resolve success`, {
        finalUrl,
        resource_type: trackId ? 'track' : 'video',
        trackId,
        videoId,
        elapsedMs: Date.now() - startTime,
      })

      res.json({
        share_url: shareUrl,
        final_url: finalUrl,
        resource_type: trackId ? 'track' : 'video',
        track_id: trackId,
        video_id: videoId,
      })
    } catch (error) {
      shareResolveLogger.error(`Share resolve failed`, {
        shareUrl,
        error: error?.message,
        name: error?.name,
        status: error?.status || 500,
        elapsedMs: Date.now() - startTime,
        stack: error?.stack?.slice(0, 600),
      })
      res.status(error.status || 500).json({
        message: error.name === 'TimeoutError' ? '解析分享链接超时，请稍后重试。' : '解析分享链接失败',
        error: error.message,
      })
    }
  },
}
