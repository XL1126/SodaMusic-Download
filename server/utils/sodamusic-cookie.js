/**
 * SodaMusic（汽水音乐 PC 客户端）本机 Cookies 数据库读取工具
 *  - 汽水音乐 PC 客户端基于 Chromium Embedded，Cookie 持久化使用 SQLite + leveldb。
 *    Windows 下路径固定为 %HOMEDIR%\AppData\Roaming\SodaMusic\Network\Cookies
 *  - 本文件通过 better-sqlite3 只读打开该数据库（fileMustExist=true），
 *    查询 host_key ∈ qishui.com 的 sessionid，即可免扫码登录。
 *
 * 注意：
 *  - 汽水音乐客户端正在运行时，SQLite 文件会被进程以共享写入方式打开，
 *    better-sqlite3 可能抛「locked / EBUSY」，调用方（一键登录 / 文件登录）
 *    需捕获并提示用户先关闭汽水音乐客户端。
 *  - 本工具只读 sessionid，绝不修改任何 Cookie 数据库数据。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const Database = require('better-sqlite3')
const { logger } = require('./logger')

const cookieLogger = logger.child('SodaMusicCookie')

const COOKIE_DB_PATH = path.join(
  os.homedir(),
  'AppData',
  'Roaming',
  'SodaMusic',
  'Network',
  'Cookies',
)

function getCookieDbPath() {
  return COOKIE_DB_PATH
}

function isWindowsPlatform() {
  return process.platform === 'win32'
}

function readSessionIdFromCookieDatabase(databasePath) {
  let database = null

  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true })

    const row = database.prepare(`
      SELECT name, value, host_key
      FROM cookies
      WHERE host_key IN ('.qishui.com', 'qishui.com')
        AND name = 'sessionid'
      LIMIT 1
    `).get()

    const sessionid = String(row?.value || '').trim()
    cookieLogger.debug(`readSessionIdFromCookieDatabase`, {
      databasePath,
      found: Boolean(sessionid),
    })
    return sessionid
  } catch (error) {
    // 这里不吞异常，让上层根据 message 关键词分类返回用户友好提示；
    // 但先打 ERROR 日志，线上可以直接从 log 文件看出到底是 NOTADB / CORRUPT / 锁定还是其他。
    cookieLogger.error(`readSessionIdFromCookieDatabase error`, {
      databasePath,
      message: error?.message,
      code: error?.code,
    })
    throw error
  } finally {
    if (database) {
      try { database.close() } catch (_) { /* 关闭失败不影响结果 */ }
    }
  }
}

function getSessionIdFromSodaMusicCookies() {
  if (!isWindowsPlatform()) {
    cookieLogger.warn(`getSessionIdFromSodaMusicCookies called on non-win32`)
    return {
      supported: false,
      reason: '当前后端非Windows系统，无法使用一键登录',
      cookieDbPath: getCookieDbPath(),
      sessionid: '',
    }
  }

  const cookieDbPath = getCookieDbPath()

  if (!fs.existsSync(cookieDbPath)) {
    cookieLogger.warn(`cookie db file not exist`, { cookieDbPath })
    return {
      supported: false,
      reason: '请先安装PC端汽水音乐，并完成登录',
      cookieDbPath,
      sessionid: '',
    }
  }

  try {
    const sessionid = readSessionIdFromCookieDatabase(cookieDbPath)

    if (!sessionid) {
      cookieLogger.warn(`no sessionid row in cookie db`, { cookieDbPath })
      return {
        supported: false,
        reason: '汽水音乐登录状态获取失败，请确保账号已正常登录',
        cookieDbPath,
        sessionid: '',
      }
    }

    cookieLogger.info(`got sessionid from soda cookie db ok`, { cookieDbPath })
    return {
      supported: true,
      reason: '',
      cookieDbPath,
      sessionid,
    }
  } catch (error) {
    const message = String(error?.message || '')

    if (
      message.includes('EBUSY') ||
      message.includes('locked') ||
      message.includes('busy') ||
      message.includes('unable to open database file')
    ) {
      cookieLogger.warn(`cookie db locked/busy`, { cookieDbPath, message })
      return {
        supported: false,
        reason: '汽水音乐正在运行中，请退出后再使用一键登录',
        cookieDbPath,
        sessionid: '',
      }
    }

    // 其他未分类错误往上抛，交给上层 HTTP handler 统一 500 并打堆栈
    throw error
  }
}

module.exports = {
  getCookieDbPath,
  getSessionIdFromSodaMusicCookies,
  isWindowsPlatform,
  readSessionIdFromCookieDatabase,
}
