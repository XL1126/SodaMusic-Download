/**
 * 封面代理：避免 CDN 防盗链 / CORS 导致前端封面加载失败
 * GET /api/recommend/image?src=https://...
 */

const { fetchWithTimeout } = require('../utils/fetch-with-timeout')
const { logger } = require('../utils/logger')

const imgLogger = logger.child('RecommendImage')

const ALLOW_HOST_RE = /(^|\.)(qishui\.com|douyin\.com|byteimg\.com|snssdk\.com|bytedance\.com|zijieapi\.com)$/i

function isAllowedImageUrl(raw) {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return ALLOW_HOST_RE.test(url.hostname)
  } catch {
    return false
  }
}

module.exports = {
  name: 'recommend-image',
  method: 'get',
  path: '/api/recommend/image',
  handler: async (req, res) => {
    const src = String(req.query.src || '')
    if (!src || !isAllowedImageUrl(src)) {
      res.status(400).json({ message: '非法图片地址' })
      return
    }

    try {
      const upstream = await fetchWithTimeout(src, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Referer: 'https://www.qishui.com/',
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
        redirect: 'follow',
      }, 20 * 1000)

      if (!upstream.ok) {
        imgLogger.warn('recommend.imageUpstreamFailed', { status: upstream.status, src: src.slice(0, 120) })
        res.status(upstream.status).json({ message: '封面拉取失败' })
        return
      }

      const contentType = upstream.headers.get('content-type') || 'image/jpeg'
      const buffer = Buffer.from(await upstream.arrayBuffer())
      res.setHeader('Content-Type', contentType)
      res.setHeader('Content-Length', buffer.length)
      res.setHeader('Cache-Control', 'public, max-age=86400')
      res.send(buffer)
    } catch (error) {
      imgLogger.error('recommend.imageFailed', { error: error?.message, src: src.slice(0, 120) })
      res.status(500).json({ message: error?.message || '封面代理失败' })
    }
  },
}
