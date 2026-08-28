/*
 * 当前登录用户资料 API
 * 功能：转发到汽水音乐 /luna/pc/me，返回昵称、抖音号、VIP 状态等
 *
 * 修复：fetch 超时 30s + 日志 + 非 JSON 响应兜底
 */
const { endpoints, fixed } = require('../config/qishui-auth')
const { buildUrl } = require('../utils/http')
const { fetchWithTimeout } = require('../utils/fetch-with-timeout')
const { logger } = require('../utils/logger')

const apiLogger = logger.child('AuthProfileApi')

const request = {
  method: 'post',
  path: '/api/auth/profile',
  query: {},
  headers: {
    'content-type': 'application/json',
  },
  body: {
    aid: fixed.aid,
    sessionid: 'string',
  },
}

const response = {
  status_code: 0,
  my_info: {
    id: 'string',
    nickname: 'string',
    douyin_id: 'string',
    is_vip: false,
    vip_stage: 'string',
  },
}

module.exports = {
  name: 'auth-profile',
  method: request.method,
  path: request.path,
  request,
  response,
  handler: async (req, res) => {
    const startTime = Date.now()
    const { aid = fixed.aid, sessionid } = req.body || {}

    apiLogger.debug(`AuthProfile request`)

    if (!sessionid) {
      apiLogger.warn(`AuthProfile missing sessionid`)
      res.status(400).json({
        message: 'sessionid is required',
      })
      return
    }

    try {
      const target = buildUrl(endpoints.me, { aid })
      const upstream = await fetchWithTimeout(target, {
        headers: {
          Cookie: `sessionid=${sessionid};`,
          'Accept-Encoding': 'gzip, deflate',
        },
      }, 30 * 1000)

      const rawText = await upstream.text()
      let payload
      try {
        payload = rawText ? JSON.parse(rawText) : {}
      } catch (parseErr) {
        apiLogger.warn(`AuthProfile upstream non-JSON response`, {
          status: upstream.status,
          contentPreview: rawText.slice(0, 200),
        })
        payload = {
          status_code: upstream.status,
          message: `Upstream returned non-JSON content (HTTP ${upstream.status})`,
          _raw: rawText.slice(0, 500),
        }
      }

      apiLogger.debug(`AuthProfile response`, {
        status: upstream.status,
        statusCode: payload?.status_code,
        userId: payload?.my_info?.id || '',
        nickname: payload?.my_info?.nickname ? String(payload.my_info.nickname).slice(0, 40) : '',
        isVip: payload?.my_info?.is_vip,
        vipStage: payload?.my_info?.vip_stage || '',
        elapsedMs: Date.now() - startTime,
      })

      res.status(upstream.status).json(payload)
    } catch (error) {
      apiLogger.error(`AuthProfile failed`, {
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
