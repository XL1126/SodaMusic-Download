/**
 * 一键登录支持性检测（GET /api/auth/one-click-support）
 *  - 仅在 Windows 平台可用：直接读取本机 %HOMEDIR%\AppData\Roaming\SodaMusic\Network\Cookies
 *    SQLite 数据库中的 qishui.com sessionid，前端拿到后可直接免扫码登录。
 *  - 如果汽水音乐正在运行，better-sqlite3 会抛出文件锁定错误，
 *    sodamusic-cookie.getSessionIdFromSodaMusicCookies 已把这类错误转成友好文案。
 */

const { getSessionIdFromSodaMusicCookies, isWindowsPlatform } = require('../utils/sodamusic-cookie')
const { logger } = require('../utils/logger')

const oneClickLogger = logger.child('AuthOneClick')

module.exports = {
  name: 'auth-one-click-support',
  method: 'get',
  path: '/api/auth/one-click-support',
  handler: async (_req, res) => {
    try {
      const result = getSessionIdFromSodaMusicCookies()
      oneClickLogger.info(`one-click support checked`, {
        supported: result.supported,
        reason: result.reason || '',
        hasSessionid: Boolean(result.sessionid),
      })
      res.json({
        supported: result.supported,
        is_windows: isWindowsPlatform(),
        cookie_db_path: result.cookieDbPath,
        sessionid: result.sessionid,
        message: result.reason || (result.supported ? '支持一键登录' : '当前环境不支持一键登录'),
      })
    } catch (error) {
      oneClickLogger.error(`one-click support check failed`, {
        error: error?.message,
        stack: error?.stack?.slice(0, 600),
      })
      res.status(500).json({
        supported: false,
        is_windows: isWindowsPlatform(),
        sessionid: '',
        message: '检测一键登录支持失败',
        error: error.message,
      })
    }
  },
}
