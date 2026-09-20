/**
 * 静默自动登录（GET /api/auth/auto-login）
 *
 * 场景：前端首次启动且未登录时，后台静默尝试一次，不弹任何 UI。
 * 规则：
 *  - 仅 Windows：非 Windows 直接 skip，不读 Cookies
 *  - 读取本机 SodaMusic Cookies 中的 sessionid
 *  - 若有 sessionid，再请求 /luna/pc/me 校验并返回资料
 *  - 调用方应只尝试一次；本接口本身无会话状态
 */

const { getSessionIdFromSodaMusicCookies, isWindowsPlatform } = require('../utils/sodamusic-cookie')
const { fetchWithTimeout } = require('../utils/fetch-with-timeout')
const { buildUrl } = require('../utils/http')
const { endpoints, fixed } = require('../config/qishui-auth')
const { logger } = require('../utils/logger')

const autoLoginLogger = logger.child('AuthAutoLogin')

function extractProfile(payload) {
  const myInfo = payload?.my_info
  if (!myInfo?.id || !myInfo?.nickname) {
    return null
  }

  const urls = myInfo.medium_avatar_url?.urls
  return {
    id: myInfo.id,
    nickname: myInfo.nickname,
    douyinId: myInfo.douyin_id || '',
    avatar: Array.isArray(urls) && urls.length > 0 ? urls[0] : '',
    isVip: Boolean(myInfo.is_vip),
    vipStage: myInfo.vip_stage || '',
  }
}

async function fetchProfileWithSession(sessionid) {
  const target = buildUrl(endpoints.me, {
    aid: fixed.aid,
    app_name: fixed.app_name,
    region: fixed.region,
    geo_region: fixed.geo_region,
    os_region: fixed.os_region,
  })

  const upstream = await fetchWithTimeout(target, {
    headers: {
      Cookie: `sessionid=${sessionid}`,
      'User-Agent': `LunaPC/${fixed.version_name}`,
    },
  }, 15 * 1000)

  const rawText = await upstream.text()
  let payload
  try {
    payload = rawText ? JSON.parse(rawText) : {}
  } catch {
    autoLoginLogger.warn('auth.autoLoginProfileFailed', {
      status: upstream.status,
      reason: 'non-json',
    })
    return { ok: false, status: upstream.status, payload: null }
  }

  const statusCode = payload?.status_code
  if (typeof statusCode === 'number' && statusCode !== 0) {
    autoLoginLogger.warn('auth.autoLoginProfileFailed', {
      status: upstream.status,
      statusCode,
      message: payload?.message || '',
    })
    return { ok: false, status: upstream.status, payload }
  }

  const profile = extractProfile(payload)
  if (!profile) {
    autoLoginLogger.warn('auth.autoLoginProfileFailed', {
      status: upstream.status,
      reason: 'invalid-profile-shape',
    })
    return { ok: false, status: upstream.status, payload }
  }

  return { ok: true, status: upstream.status, profile, payload }
}

module.exports = {
  name: 'auth-auto-login',
  method: 'get',
  path: '/api/auth/auto-login',
  handler: async (_req, res) => {
    if (!isWindowsPlatform()) {
      autoLoginLogger.info('auth.autoLoginSkip', { reason: 'non-windows', platform: process.platform })
      return res.json({
        success: false,
        skipped: true,
        is_windows: false,
        supported: false,
        reason: 'non_windows',
        message: '当前非 Windows 系统，已跳过自动登录',
        session: null,
        profile: null,
      })
    }

    let cookieResult
    try {
      cookieResult = getSessionIdFromSodaMusicCookies()
    } catch (error) {
      autoLoginLogger.error('auth.autoLoginFailed', {
        stage: 'cookies',
        error: error?.message,
      })
      return res.json({
        success: false,
        skipped: false,
        is_windows: true,
        supported: false,
        reason: 'cookie_error',
        message: error?.message || '读取本地登录态失败',
        session: null,
        profile: null,
      })
    }

    const sessionid = String(cookieResult.sessionid || '').trim()
    if (!cookieResult.supported || !sessionid) {
      autoLoginLogger.info('auth.autoLoginSkip', {
        reason: cookieResult.reason || 'no_sessionid',
        supported: cookieResult.supported,
      })
      return res.json({
        success: false,
        skipped: true,
        is_windows: true,
        supported: false,
        reason: 'no_local_session',
        message: cookieResult.reason || '未检测到本地汽水音乐登录态',
        session: null,
        profile: null,
      })
    }

    try {
      const profileResult = await fetchProfileWithSession(sessionid)
      if (!profileResult.ok) {
        autoLoginLogger.warn('auth.autoLoginProfileFailed', {
          status: profileResult.status,
        })
        return res.json({
          success: false,
          skipped: false,
          is_windows: true,
          supported: true,
          reason: 'profile_invalid',
          message: '本地登录态无效或已过期',
          session: null,
          profile: null,
        })
      }

      const session = {
        aid: fixed.aid,
        sessionid,
        platform: 'pc',
      }

      autoLoginLogger.info('auth.autoLoginOk', {
        userId: profileResult.profile.id,
        nickname: profileResult.profile.nickname,
      })

      return res.json({
        success: true,
        skipped: false,
        is_windows: true,
        supported: true,
        reason: '',
        message: '自动登录成功',
        session,
        profile: profileResult.profile,
      })
    } catch (error) {
      autoLoginLogger.error('auth.autoLoginFailed', {
        stage: 'profile',
        error: error?.message,
        stack: error?.stack?.slice(0, 400),
      })
      return res.json({
        success: false,
        skipped: false,
        is_windows: true,
        supported: true,
        reason: 'profile_request_failed',
        message: error?.message || '自动登录失败',
        session: null,
        profile: null,
      })
    }
  },
}
