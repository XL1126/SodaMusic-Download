const fs = require('fs')
const path = require('path')

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
}

/**
 * 【修复】日志输出目录
 *  原先是 os.tmpdir()/popdownloader-logs（Windows 下是 %TEMP%，深路径用户根本找不到）。
 *  现在改为直接放在项目根目录的 ./logs 下面，方便用户直接打开目录定位问题：
 *    <项目根>/logs/popdownloader-YYYYMMDD.log
 *  并通过 require.main 判断是否能拿到 server 启动目录（兼容 unit test 场景下 process.cwd() 不是项目根）。
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
    logFilePath = path.join(LOG_DIR, `popdownloader-${dateStr}.log`)
    fileWriteStream = fs.createWriteStream(logFilePath, { flags: 'a' })
  } catch (err) {
    console.error('[Logger] Failed to init log file:', err.message)
  }
}

ensureLogDir()

function getLevelName(level) {
  return Object.keys(LOG_LEVELS).find((k) => LOG_LEVELS[k] === level) || 'INFO'
}

/**
 * 【修复-日志整理】把 meta 中"超长字段"统一截断，避免一整行 meta JSON 几 KB，根本没法读。
 *  典型超长字段：stack、rawPreview、payload、error.stack、contentPreview、raw 等。
 *  规则：
 *    - 字符串值 > 200 字符：截断到前 200 + "...(+N bytes)"
 *    - 对象值递归再剪一遍（最深 1 层）
 *    - null / undefined 从输出中剔除（让 JSON 更紧凑）
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
      // 数组保留前 5 个元素
      const cut = raw.slice(0, 5)
      out[key] = raw.length > 5 ? [...cut, `...(+${raw.length - 5} items)`] : cut
    } else if (typeof raw === 'object' && depth < 1) {
      const inner = trimMeta(raw, depth + 1)
      // 子对象长度控制：超过 10 个 key 只留前 10
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

function formatMessage(level, message, meta) {
  const timestamp = new Date().toISOString()
  const levelStr = getLevelName(level).padEnd(5)
  const trimmed = trimMeta(meta)
  const metaStr = trimmed && Object.keys(trimmed).length > 0
    ? ` | ${JSON.stringify(trimmed)}`
    : ''
  return `[${timestamp}] [${levelStr}] ${message}${metaStr}`
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

function log(level, message, meta) {
  // 【修复-日志不乱】Console 端默认输出 INFO 及以上（用户看命令行能一目了然）；
  // 文件端保持 DEBUG（保留完整现场，需要排查时看 ./logs 下文件）。
  // 环境变量 LOG_LEVEL 可覆盖两者（设 LOG_LEVEL=DEBUG 则 console 也打全量）。
  const envLevel = process.env.LOG_LEVEL
  const consoleMinLevel = envLevel
    ? (LOG_LEVELS[envLevel] ?? LOG_LEVELS.INFO)
    : LOG_LEVELS.INFO
  const fileMinLevel = envLevel
    ? (LOG_LEVELS[envLevel] ?? LOG_LEVELS.DEBUG)
    : LOG_LEVELS.DEBUG

  const formatted = formatMessage(level, message, meta)

  if (level >= consoleMinLevel) {
    switch (level) {
      case LOG_LEVELS.ERROR:
        console.error(formatted)
        break
      case LOG_LEVELS.WARN:
        console.warn(formatted)
        break
      case LOG_LEVELS.INFO:
        console.log(formatted)
        break
      default:
        console.log(formatted)
    }
  }

  if (level >= fileMinLevel) {
    writeToFile(formatted)
  }
}

function createLogger(context) {
  const prefix = context ? `[${context}] ` : ''

  return {
    debug: (msg, meta) => log(LOG_LEVELS.DEBUG, `${prefix}${msg}`, meta),
    info: (msg, meta) => log(LOG_LEVELS.INFO, `${prefix}${msg}`, meta),
    warn: (msg, meta) => log(LOG_LEVELS.WARN, `${prefix}${msg}`, meta),
    error: (msg, meta) => log(LOG_LEVELS.ERROR, `${prefix}${msg}`, meta),
    child: (childContext) => createLogger(context ? `${context}:${childContext}` : childContext),
    getLogFilePath: () => logFilePath,
  }
}

const logger = createLogger('PopDownloader')

logger.info('Logger initialized', { logFilePath, pid: process.pid })

function getLogDir() {
  return LOG_DIR
}

module.exports = {
  logger,
  createLogger,
  LOG_LEVELS,
  getLogFilePath: () => logFilePath,
  getLogDir,
}
