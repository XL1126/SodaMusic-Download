/**
 * 封面代理：避免 CDN 防盗链 / CORS 导致前端封面加载失败
 * GET /api/recommend/image?src=https://...
 */

const { fetchWithTimeout } = require('../utils/fetch-with-timeout')
const { logger } = require('../utils/logger')

const imgLogger = logger.child('RecommendImage')

// 汽水/抖音/字节系图片 CDN 主机（官方分享页封面在 p3-luna.douyinpic.com）
const ALLOW_HOST_RE = /(^|\.)(qishui\.com|douyin\.com|douyinpic\.com|douyinstatic\.com|byteimg\.com|bytescm\.com|ibytedtos\.com|ibytedapm\.com|snssdk\.com|bytedance\.com|bytedance\.net|zijieapi\.com|pstatp\.com|ecombdimg\.com)$/i

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
      try {
        const host = new URL(src).hostname
        imgLogger.warn('recommend.imageHostRejected', { host, src: src.slice(0, 120) })
      } catch {
        // ignore
      }
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
        imgLogger.warn('recommend.imageUpstreamFailed', {
          status: upstream.status,
          src: src.slice(0, 120),
        })
        res.status(upstream.status).json({ message: '封面拉取失败' })
        return
      }

      const contentType = upstream.headers.get('content-type') || 'image/jpeg'
      const buffer = Buffer.from(await upstream.arrayBuffer())
      if (!buffer.length) {
        res.status(502).json({ message: '封面内容为空' })
        return
      }

      res.setHeader('Content-Type', contentType.includes('image/') ? contentType : 'image/jpeg')
      res.setHeader('Content-Length', buffer.length)
      res.setHeader('Cache-Control', 'public, max-age=86400')
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.send(buffer)
    } catch (error) {
      imgLogger.error('recommend.imageFailed', {
        error: error?.message,
        src: src.slice(0, 120),
      })
      res.status(500).json({ message: error?.message || '封面代理失败' })
    }
  },
}
