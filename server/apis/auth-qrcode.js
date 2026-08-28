/*
 * 登录二维码获取 API
 * 功能：转发到汽水音乐 /passport/web/get_qrcode/，返回扫码登录所需的 token、base64 二维码、过期时间
 *
 * 修复：fetch 超时 30s + 日志 + 非 JSON 响应兜底（防止 WAF 返回 HTML 时直接 500）
 */
const { endpoints, fixed } = require('../config/qishui-auth')
const { buildUrl } = require('../utils/http')
const { fetchWithTimeout } = require('../utils/fetch-with-timeout')
const { logger } = require('../utils/logger')

const apiLogger = logger.child('AuthQrcodeApi')

const request = {
  method: 'get',
  path: '/api/auth/qrcode',
  query: {
    passport_jssdk_version: fixed.passport_jssdk_version,
    passport_jssdk_type: fixed.passport_jssdk_type,
    is_from_ttaccountsdk: fixed.is_from_ttaccountsdk,
    aid: fixed.aid,
    next: fixed.next,
  },
  headers: {},
  body: null,
}

const response = {
  message: 'success',
  data: {
    token: 'string',
    qrcode: 'data:image/png;base64,...',
    expire_time: 0,
    qrcode_index_url: 'string',
  },
}

module.exports = {
  name: 'auth-qrcode',
  method: request.method,
  path: request.path,
  request,
  response,
  handler: async (_req, res) => {
    const startTime = Date.now()
    apiLogger.debug(`AuthQrcode request`)

    try {
      const target = buildUrl(endpoints.getQrcode, request.query)
      const upstream = await fetchWithTimeout(target, {
        headers: { 'Accept-Encoding': 'gzip, deflate' },
      }, 30 * 1000)

      const rawText = await upstream.text()
      let payload
      try {
        payload = rawText ? JSON.parse(rawText) : {}
      } catch (parseErr) {
        apiLogger.warn(`AuthQrcode upstream non-JSON response`, {
          status: upstream.status,
          contentPreview: rawText.slice(0, 200),
        })
        payload = {
          message: `Upstream returned non-JSON content (HTTP ${upstream.status})`,
          _raw: rawText.slice(0, 500),
        }
      }

      apiLogger.debug(`AuthQrcode response`, {
        status: upstream.status,
        msg: payload?.message || '',
        hasToken: Boolean(payload?.data?.token),
        hasQrcode: Boolean(payload?.data?.qrcode),
        expireTime: payload?.data?.expire_time,
        elapsedMs: Date.now() - startTime,
      })

      res.status(upstream.status).json(payload)
    } catch (error) {
      apiLogger.error(`AuthQrcode failed`, {
        error: error?.message,
        errorName: error?.name,
        status: error?.status || 500,
        elapsedMs: Date.now() - startTime,
        stack: error?.stack?.slice(0, 500),
      })
      res.status(error.status || 500).json({
        message: 'failed',
        error: error.message,
      })
    }
  },
}
