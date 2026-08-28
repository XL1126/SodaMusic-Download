/*
 * 二维码登录状态轮询 API
 * 功能：转发到 /passport/web/check_qrconnect/ 轮询「新建 / 已扫码 / 已确认」三种状态，
 *       并从 upstream 的 Set-Cookie 里抽 sessionid 返回给前端保存
 *
 * 修复：
 *  1) fetch 超时 30s，轮询请求长时间悬挂时能自动中断
 *  2) 日志；非 JSON 响应兜底；保留了原有的 sessionid 提取逻辑
 */
const { endpoints, fixed } = require('../config/qishui-auth')
const { buildUrl, getSessionIdFromSetCookie } = require('../utils/http')
const { fetchWithTimeout } = require('../utils/fetch-with-timeout')
const { logger } = require('../utils/logger')

const apiLogger = logger.child('AuthQrcodeStatusApi')

const request = {
  method: 'post',
  path: '/api/auth/qrcode/status',
  query: {
    passport_jssdk_version: fixed.passport_jssdk_version,
    passport_jssdk_type: fixed.passport_jssdk_type,
    is_from_ttaccountsdk: fixed.is_from_ttaccountsdk,
    aid: fixed.aid,
    iid: fixed.iid,
  },
  headers: {
    'content-type': 'application/x-www-form-urlencoded',
  },
  body: {
    need_logo: fixed.need_logo,
    need_short_url: fixed.need_short_url,
    is_frontier: fixed.is_frontier,
    token: 'string',
    is_new_login: fixed.is_new_login,
    next: fixed.next,
  },
}

const response = {
  message: 'success',
  data: {
    status: 'new | scanned | confirmed',
  },
  auth: {
    aid: fixed.aid,
    sessionid: '',
  },
}

module.exports = {
  name: 'auth-qrcode-status',
  method: request.method,
  path: request.path,
  request,
  response,
  handler: async (req, res) => {
    const startTime = Date.now()
    const { token } = req.body || {}

    apiLogger.debug(`AuthQrcodeStatus request`, { tokenLen: token ? token.length : 0 })

    if (!token) {
      apiLogger.warn(`AuthQrcodeStatus missing token`)
      res.status(400).json({
        message: 'token is required',
      })
      return
    }

    try {
      const target = buildUrl(endpoints.checkQrConnect, request.query)
      // 注：后端要求使用 application/x-www-form-urlencoded，保持原有实现
      const body = new URLSearchParams({
        ...request.body,
        token,
      })

      const upstream = await fetchWithTimeout(target, {
        method: 'POST',
        headers: request.headers,
        body,
      }, 30 * 1000)

      const rawText = await upstream.text()
      let payload
      try {
        payload = rawText ? JSON.parse(rawText) : {}
      } catch (parseErr) {
        apiLogger.warn(`AuthQrcodeStatus upstream non-JSON`, {
          status: upstream.status,
          contentPreview: rawText.slice(0, 200),
        })
        payload = {
          message: `Upstream returned non-JSON content (HTTP ${upstream.status})`,
          _raw: rawText.slice(0, 500),
        }
      }

      // —— 关键：从 upstream 的 Set-Cookie 里抽取 sessionid
      const sessionid = getSessionIdFromSetCookie(upstream.headers)

      apiLogger.debug(`AuthQrcodeStatus response`, {
        status: upstream.status,
        msg: payload?.message || '',
        dataStatus: payload?.data?.status || '',
        hasSession: Boolean(sessionid),
        sessionLen: sessionid ? sessionid.length : 0,
        elapsedMs: Date.now() - startTime,
      })

      res.status(upstream.status).json({
        ...payload,
        auth: {
          aid: fixed.aid,
          sessionid,
        },
      })
    } catch (error) {
      apiLogger.error(`AuthQrcodeStatus failed`, {
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
