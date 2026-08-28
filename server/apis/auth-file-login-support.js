/**
 * 文件登录接口（POST /api/auth/file-login-support）
 *  - 接收前端上传的 SodaMusic Cookies SQLite 数据库文件（base64），
 *    落盘到临时文件后通过 better-sqlite3 只读打开，读取 qishui.com 域的 sessionid。
 *
 * 原问题 / 修复：
 *  1) 临时文件命名使用 `Date.now()+Math.random().toString(16).slice(2)` ：
 *     Math.random() 非密码学安全随机且位数有限，在高并发上传场景下存在同毫秒
 *     碰撞风险（虽然后端目前单机，但防御性地改为 crypto.randomUUID()）。
 *  2) readSessionIdFromCookieDatabase 抛出的 better-sqlite3 错误没有分类：
 *     「文件不是合法 sqlite」「数据库损坏」「文件锁定被占用」三种
 *     原本会抛同一段 generic 文案，用户无法判断该怎么做。
 *     现根据错误 message 关键词分类输出更友好的中文提示。
 */

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { readSessionIdFromCookieDatabase } = require('../utils/sodamusic-cookie')
const { logger } = require('../utils/logger')

const fileAuthLogger = logger.child('AuthFileLogin')

module.exports = {
  name: 'auth-file-login-support',
  method: 'post',
  path: '/api/auth/file-login-support',
  handler: async (req, res) => {
    const startTime = Date.now()
    const fileName = String(req.body?.file_name || '').trim()
    const fileContentBase64 = String(req.body?.file_content_base64 || '').trim()

    if (!fileContentBase64) {
      fileAuthLogger.warn(`file login: missing file_content_base64`, { fileName })
      res.status(400).json({
        supported: false,
        sessionid: '',
        message: '请先选择 Cookies 文件',
      })
      return
    }

    // 【修复1】用 crypto.randomUUID() 取代 Math.random 后缀，杜绝高并发下临时文件碰撞
    const tempPath = path.join(
      os.tmpdir(),
      `sodamusic-upload-${process.pid}-${Date.now()}-${crypto.randomUUID()}.sqlite`,
    )

    fileAuthLogger.info(`file login: temp file created`, { fileName, tempPath, base64Len: fileContentBase64.length })

    try {
      const buffer = Buffer.from(fileContentBase64, 'base64')
      fs.writeFileSync(tempPath, buffer)

      const sessionid = readSessionIdFromCookieDatabase(tempPath)

      if (!sessionid) {
        fileAuthLogger.warn(`file login: sessionid not found in db`, { fileName })
        res.json({
          supported: false,
          sessionid: '',
          file_name: fileName,
          message: '汽水音乐登录状态获取失败，请确保账号已正常登录',
        })
        return
      }

      fileAuthLogger.info(`file login: sessionid parsed ok`, { fileName, elapsedMs: Date.now() - startTime })

      res.json({
        supported: true,
        sessionid,
        file_name: fileName,
        message: 'Cookies 文件解析成功',
      })
    } catch (error) {
      const rawMsg = String(error?.message || '')
      fileAuthLogger.error(`file login failed`, {
        fileName,
        error: rawMsg,
        code: error?.code,
        elapsedMs: Date.now() - startTime,
        stack: error?.stack?.slice(0, 600),
      })

      // 【修复2】根据 better-sqlite3 常见错误关键词给出分类友好提示
      let userMessage = 'Cookies 文件解析失败'
      if (
        rawMsg.includes('SQLITE_NOTADB') ||
        rawMsg.includes('not a database') ||
        rawMsg.includes('file is not a database')
      ) {
        userMessage = '上传的文件不是合法的 SQLite Cookies 数据库，请选择正确的 SodaMusic Cookies 文件。'
      } else if (
        rawMsg.includes('SQLITE_CORRUPT') ||
        rawMsg.includes('database disk image is malformed') ||
        rawMsg.includes('corrupt')
      ) {
        userMessage = 'Cookies 文件已损坏，请重新从汽水音乐安装目录拷贝或重新登录。'
      } else if (
        rawMsg.includes('SQLITE_EMPTY') ||
        (error && error.code === 'SQLITE_EMPTY')
      ) {
        userMessage = 'Cookies 文件为空，请确保汽水音乐已经登录并产生过会话数据。'
      } else if (
        rawMsg.includes('EBUSY') ||
        rawMsg.includes('locked') ||
        rawMsg.includes('busy')
      ) {
        userMessage = 'Cookies 文件正在被占用，请关闭汽水音乐客户端后再上传。'
      }

      res.status(500).json({
        supported: false,
        sessionid: '',
        file_name: fileName,
        message: userMessage,
        error: error.message,
      })
    } finally {
      if (fs.existsSync(tempPath)) {
        try { fs.rmSync(tempPath, { force: true }) } catch (_) { /* best-effort 删除 */ }
      }
    }
  },
}
