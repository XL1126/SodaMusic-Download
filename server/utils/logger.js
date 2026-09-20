const fs = require('fs')
const path = require('path')
const { t, getLocale } = require('./i18n')

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
}

/**
 * 日志目录：项目根目录 ./logs
 * 终端格式（类似 Minecraft 服务端）：
 *   [HH:mm:ss] [Module/LEVEL]: message
 * 文件格式保留完整 meta，便于排查。
 * 文案经 i18n 解析，不写死在业务代码中。
 */
function resolveProjectLogDir() {
  if (require.main && require.main.filename) {
    return path.resolve(path.dirname(require.main.filename), '..', 'logs')
  }
  return path.resolve(process.cwd(), 'logs')
}

const LOG_DIR = resolveProjectLogDir()
let logFilePath = null
let fileWriteStream = null

function ensureLogDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true })
    }
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    logFilePath = path.join(LOG_DIR, `sodamusic-download-${dateStr}.log`)
    fileWriteStream = fs.createWriteStream(logFilePath, { flags: 'a', encoding: 'utf8' })
  } catch (err) {
    console.error(`[00:00:00] [Logger/${t('level.error')}]: ${t('logger.fileInitFailed', { error: err.message })}`)
  }
}

ensureLogDir()

function getLevelName(level) {
  return Object.keys(LOG_LEVELS).find((k) => LOG_LEVELS[k] === level) || 'INFO'
}

function getLevelLabel(level) {
  return t(`level.${getLevelName(level).toLowerCase()}`)
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function formatConsoleTime(date = new Date()) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 截断超长 meta，避免文件日志被 stack/payload 撑爆。
 */
function trimMeta(meta, depth = 0) {
  if (!meta || typeof meta !== 'object') return meta

  const out = {}
  for (const key of Object.keys(meta)) {
    const raw = meta[key]
    if (raw === undefined || raw === null) continue

    if (typeof raw === 'string') {
      if (raw.length <= 200) {
        out[key] = raw
      } else {
        out[key] = `${raw.slice(0, 200)}...(+${raw.length - 200} chars)`
      }
    } else if (Array.isArray(raw)) {
      const cut = raw.slice(0, 5)
      out[key] = raw.length > 5 ? [...cut, `...(+${raw.length - 5} items)`] : cut
    } else if (typeof raw === 'object' && depth < 1) {
      const inner = trimMeta(raw, depth + 1)
      const keys = Object.keys(inner)
      if (keys.length > 10) {
        const sliced = {}
        for (const k of keys.slice(0, 10)) sliced[k] = inner[k]
        sliced['...'] = `(+${keys.length - 10} keys)`
        out[key] = sliced
      } else {
        out[key] = inner
      }
    } else if (typeof raw === 'object') {
      out[key] = '[Object]'
    } else {
      out[key] = raw
    }
  }
  return out
}

function formatMetaBrief(meta) {
  const trimmed = trimMeta(meta)
  if (!trimmed || typeof trimmed !== 'object') return ''
  const keys = Object.keys(trimmed)
  if (keys.length === 0) return ''

  // 终端只保留关键字段，保持干净
  const preferred = [
    'method', 'path', 'status', 'statusCode', 'elapsedMs',
    'error', 'reason', 'count', 'port', 'track_id', 'video_id',
    'batchId', 'supported', 'platform', 'locale', 'logFilePath',
  ]
  const parts = []
  const seen = new Set()

  for (const key of preferred) {
    if (key in trimmed && !seen.has(key)) {
      seen.add(key)
      parts.push(`${key}=${trimmed[key]}`)
    }
  }

  if (parts.length === 0) {
    for (const key of keys.slice(0, 4)) {
      const value = trimmed[key]
      if (value == null || typeof value === 'object') continue
      parts.push(`${key}=${value}`)
    }
  }

  return parts.length ? ` | ${parts.join(' ')}` : ''
}

function formatConsoleLine(level, moduleLabel, message, meta) {
  const time = formatConsoleTime()
  const levelLabel = getLevelLabel(level)
  const brief = level >= LOG_LEVELS.WARN ? formatMetaBrief(meta) : ''
  return `[${time}] [${moduleLabel}/${levelLabel}]: ${message}${brief}`
}

function formatFileLine(level, moduleLabel, message, meta) {
  const timestamp = new Date().toISOString()
  const levelStr = getLevelName(level)
  const trimmed = trimMeta(meta)
  const metaStr = trimmed && Object.keys(trimmed).length > 0
    ? ` | ${JSON.stringify(trimmed)}`
    : ''
  return `[${timestamp}] [${levelStr}] [${moduleLabel}] ${message}${metaStr}`
}

function writeToFile(formatted) {
  try {
    if (fileWriteStream && !fileWriteStream.destroyed) {
      fileWriteStream.write(`${formatted}\n`)
    }
  } catch {
    // ignore file write errors
  }
}

function resolveLevels() {
  const envLevel = process.env.LOG_LEVEL
  const consoleMinLevel = envLevel
    ? (LOG_LEVELS[envLevel] ?? LOG_LEVELS.INFO)
    : LOG_LEVELS.INFO
  const fileMinLevel = envLevel
    ? (LOG_LEVELS[envLevel] ?? LOG_LEVELS.DEBUG)
    : LOG_LEVELS.DEBUG
  return { consoleMinLevel, fileMinLevel }
}

/**
 * HTTP 访问日志策略（保持终端干净，类似 MC 不刷屏）：
 * - 默认：2xx/3xx 仅写文件（DEBUG）；4xx WARN；5xx ERROR 上终端
 * - LOG_HTTP=1：全部请求 INFO 上终端
 */
function shouldConsoleHttp(status) {
  if (process.env.LOG_HTTP === '1') return true
  return status >= 400
}

function log(level, messageOrKey, meta) {
  const { consoleMinLevel, fileMinLevel } = resolveLevels()
  const message = t(messageOrKey, meta || {})
  const moduleLabel = log._moduleLabel || 'Main'

  const consoleLine = formatConsoleLine(level, moduleLabel, message, meta)
  const fileLine = formatFileLine(level, moduleLabel, message, meta)

  if (level >= consoleMinLevel) {
    switch (level) {
      case LOG_LEVELS.ERROR:
        console.error(consoleLine)
        break
      case LOG_LEVELS.WARN:
        console.warn(consoleLine)
        break
      default:
        console.log(consoleLine)
    }
  }

  if (level >= fileMinLevel) {
    writeToFile(fileLine)
  }
}

function createLogger(context) {
  // 终端模块名保持短标签：根 logger 为 Main，child 直接用子模块名（如 Server）
  const moduleLabel = context || 'Main'

  const write = (level, messageOrKey, meta) => {
    const prev = log._moduleLabel
    log._moduleLabel = moduleLabel
    try {
      log(level, messageOrKey, meta)
    } finally {
      log._moduleLabel = prev
    }
  }

  return {
    debug: (msg, meta) => write(LOG_LEVELS.DEBUG, msg, meta),
    info: (msg, meta) => write(LOG_LEVELS.INFO, msg, meta),
    warn: (msg, meta) => write(LOG_LEVELS.WARN, msg, meta),
    error: (msg, meta) => write(LOG_LEVELS.ERROR, msg, meta),
    // 子 logger 使用自身短名，避免 Main:Server 这类冗长前缀刷屏
    child: (childContext) => createLogger(childContext || moduleLabel),
    getLogFilePath: () => logFilePath,
    logHttpAccess: (messageOrKey, meta) => {
      const status = Number(meta?.statusCode ?? meta?.status ?? 0)
      const level = status >= 500
        ? LOG_LEVELS.ERROR
        : status >= 400
          ? LOG_LEVELS.WARN
          : LOG_LEVELS.DEBUG
      const prev = log._moduleLabel
      log._moduleLabel = moduleLabel
      try {
        if (process.env.LOG_HTTP === '1' && status < 400) {
          log(LOG_LEVELS.INFO, messageOrKey, meta)
          return
        }
        if (shouldConsoleHttp(status) || status >= 400) {
          log(level, messageOrKey, meta)
          return
        }
        // 成功请求默认只进文件
        const message = t(messageOrKey, meta || {})
        writeToFile(formatFileLine(LOG_LEVELS.DEBUG, moduleLabel, message, meta))
      } finally {
        log._moduleLabel = prev
      }
    },
  }
}

const logger = createLogger('Main')

/**
 * Minecraft 风格控制台输出：[HH:mm:ss] [Module/LEVEL]: message
 * 业务代码请使用 createLogger / logger，不要直接 console.*
 */
function writeConsole(level, moduleLabel, message, meta) {
  const line = formatConsoleLine(level, moduleLabel, message, meta)
  switch (level) {
    case LOG_LEVELS.ERROR:
      console.error(line)
      break
    case LOG_LEVELS.WARN:
      console.warn(line)
      break
    default:
      console.log(line)
  }
}

function printStartupBanner(appName, appVersion) {
  const line = '========================================'
  writeConsole(LOG_LEVELS.INFO, 'Main', line)
  writeConsole(LOG_LEVELS.INFO, 'Main', t('server.banner.app', { app: appName, version: appVersion }))
  writeConsole(LOG_LEVELS.INFO, 'Main', t('server.banner.desc'))
  writeConsole(LOG_LEVELS.INFO, 'Main', line)
  logger.info('logger.lang', { locale: getLocale() })
  logger.info('logger.init', { logFilePath, pid: process.pid })
}

/**
 * 启动完成提示，对齐 MC 服务端：Done (x.xxxs)! ...
 */
function printServerReady({ url, elapsedMs } = {}) {
  const elapsedSec = typeof elapsedMs === 'number' && elapsedMs >= 0
    ? (elapsedMs / 1000).toFixed(3)
    : '0.000'
  const message = t('server.readyDone', { elapsed: elapsedSec, url: url || '' })
  writeConsole(LOG_LEVELS.INFO, 'Server', message)
  writeToFile(formatFileLine(LOG_LEVELS.INFO, 'Server', message))
}

/**
 * 平台不支持时的启动失败输出（时间戳格式与正常日志一致）。
 */
function printPlatformUnsupported(lines = []) {
  const line = '========================================'
  writeConsole(LOG_LEVELS.ERROR, 'Main', line)
  for (const text of lines) {
    writeConsole(LOG_LEVELS.ERROR, 'Main', text)
  }
  writeConsole(LOG_LEVELS.ERROR, 'Main', line)
}

function getLogDir() {
  return LOG_DIR
}

module.exports = {
  logger,
  createLogger,
  LOG_LEVELS,
  printStartupBanner,
  printServerReady,
  printPlatformUnsupported,
  getLogFilePath: () => logFilePath,
  getLogDir,
}
