const fs = require('fs')
const path = require('path')
const { logger, getLogFilePath, getLogDir } = require('../utils/logger')

const logsLogger = logger.child('LogsApi')

const request = {
  method: 'get',
  path: '/api/system/logs',
  query: {
    lines: 'number?',
  },
}

function readLastLines(filePath, maxLines = 500) {
  if (!fs.existsSync(filePath)) {
    return []
  }

  let content = ''
  try {
    const stat = fs.statSync(filePath)
    const fileSize = stat.size
    const chunkSize = Math.min(fileSize, 2 * 1024 * 1024) // 2MB max read

    const fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(chunkSize)
    const start = Math.max(0, fileSize - chunkSize)
    const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, start)
    fs.closeSync(fd)

    content = buffer.slice(0, bytesRead).toString('utf8')
  } catch (err) {
    logsLogger.warn(`Failed to read log file`, {
      filePath,
      error: err?.message,
    })
    return []
  }

  const lines = content.split(/\r?\n/).filter(Boolean)
  return lines.slice(-maxLines)
}

module.exports = {
  name: 'system-logs',
  method: request.method,
  path: request.path,
  request,
  response: {},
  handler: (req, res) => {
    const maxLines = Number(req.query?.lines) || 500
    const safeLines = Math.min(Math.max(1, maxLines), 2000)

    const logFilePath = getLogFilePath()
    // 【修复】与 logger 保持一致：统一读取项目根目录 ./logs，不再去 %TEMP%
    const logDir = getLogDir()

    logsLogger.debug(`Logs request`, { lines: safeLines, logFilePath, logDir })

    let todayLines = []
    if (logFilePath) {
      todayLines = readLastLines(logFilePath, safeLines)
    }

    let recentFiles = []
    try {
      if (fs.existsSync(logDir)) {
        const entries = fs.readdirSync(logDir)
          .filter((f) => f.startsWith('popdownloader-') && f.endsWith('.log'))
          .sort()
          .reverse()
          .slice(0, 7)
        recentFiles = entries.map((f) => {
          const p = path.join(logDir, f)
          try {
            const stat = fs.statSync(p)
            return { name: f, size: stat.size, mtime: stat.mtime.toISOString() }
          } catch {
            return { name: f, size: 0, mtime: null }
          }
        })
      }
    } catch (dirErr) {
      logsLogger.warn(`Failed to list log dir`, { error: dirErr?.message })
    }

    res.json({
      ok: true,
      logFilePath,
      logDir,
      safeLines,
      recentFiles,
      lines: todayLines,
    })
  },
}
