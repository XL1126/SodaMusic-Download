const express = require('express')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

const APP_NAME = 'SodaMusic-Download'
const APP_VERSION = 'v2.1.0'
const BOOT_STARTED_AT = Date.now()

const { t } = require('./utils/i18n')
const {
  logger,
  getLogFilePath,
  printStartupBanner,
  printServerReady,
  printPlatformUnsupported,
} = require('./utils/logger')

// ============================================================
// 平台检测：仅支持 Windows
// bdms.node（汽水音乐安全签名模块）依赖 SodaMusic PC 客户端的
// 原生 DLL，仅在 Windows 上可用。Linux/macOS 无法运行。
// ============================================================
if (process.platform !== 'win32') {
  printPlatformUnsupported([
    t('server.platformUnsupported.app', { app: APP_NAME, version: APP_VERSION }),
    t('server.platformUnsupported.reason'),
    t('server.platformUnsupported.system', { platform: process.platform }),
    t('server.platformUnsupported.node', { nodeVersion: process.version }),
    t('server.platformUnsupported.hint1'),
    t('server.platformUnsupported.hint2'),
  ])
  process.exit(1)
}

const apiDefinitions = require('./apis')

const serverLogger = logger.child('Server')

const app = express()
const port = process.env.PORT || 3001
const distPath = path.join(__dirname, '..', 'dist')

printStartupBanner(APP_NAME, APP_VERSION)
serverLogger.info('server.booting')

app.use((req, _res, next) => {
  const start = Date.now()
  const method = req.method.toUpperCase()
  const url = req.originalUrl || req.url

  const origSend = _res.send.bind(_res)
  const origJson = _res.json.bind(_res)
  let logged = false

  const logOneLine = () => {
    if (logged) return
    logged = true
    const elapsed = Date.now() - start
    const status = _res.statusCode
    serverLogger.logHttpAccess('server.httpAccess', {
      method,
      url,
      status,
      statusCode: status,
      elapsedMs: elapsed,
      elapsed,
    })
  }

  _res.send = (body) => {
    logOneLine()
    return origSend(body)
  }
  _res.json = (body) => {
    logOneLine()
    return origJson(body)
  }
  _res.once('finish', logOneLine)
  _res.once('close', logOneLine)

  next()
})

app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: false, limit: '10mb' }))

for (const definition of apiDefinitions) {
  const method = definition.method.toLowerCase()
  const routePath = definition.path

  // 路由明细仅写入日志文件 / DEBUG，避免终端刷屏
  serverLogger.debug('server.routeRegisteredDebug', {
    method: method.toUpperCase(),
    path: routePath,
    name: definition.name,
  })

  app[method](routePath, async (req, res, next) => {
    try {
      await definition.handler(req, res, next)
    } catch (err) {
      serverLogger.error('server.routeError', {
        method: method.toUpperCase(),
        path: routePath,
        name: definition.name,
        error: err?.message,
        errorName: err?.name,
        status: err?.status,
        stack: err?.stack?.slice(0, 800),
      })
      if (!res.headersSent) {
        res.status(err?.status || 500).json({
          message: 'Internal Server Error',
          error: err?.message || 'Unknown error',
        })
      } else {
        res.destroy(err)
      }
    }
  })
}

serverLogger.info('server.routesRegistered', { count: apiDefinitions.length })

if (fs.existsSync(distPath)) {
  serverLogger.info('server.staticServing', { distPath })
  app.use(express.static(distPath))

  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'))
  })
} else {
  serverLogger.info('server.staticMissing')
}

process.on('uncaughtException', (err) => {
  serverLogger.error('server.uncaughtException', {
    error: err?.message,
    errorName: err?.name,
    stack: err?.stack,
  })
})

process.on('unhandledRejection', (reason, promise) => {
  serverLogger.error('server.unhandledRejection', {
    reason: reason?.message || String(reason),
    name: reason?.name,
    stack: reason?.stack?.slice(0, 800),
    promise: String(promise).slice(0, 200),
  })
})

/**
 * 项目启动后自动打开浏览器。
 * - npm start / 直接 node server/index.js：打开 http://localhost:PORT
 * - npm run dev（nodemon）：由 Vite open 打开前端，避免重复弹窗
 * - AUTO_OPEN=0 可关闭；AUTO_OPEN=1 可强制打开
 */
function openBrowser(url) {
  try {
    const child = spawn('cmd', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      shell: false,
    })
    child.unref()
    serverLogger.info('server.openBrowser', { url })
  } catch (err) {
    serverLogger.warn('server.openBrowserFailed', { url, error: err?.message })
  }
}

function shouldOpenBrowser() {
  if (process.env.AUTO_OPEN === '0') return false
  if (process.env.AUTO_OPEN === '1') return true
  const lifecycle = process.env.npm_lifecycle_event
  if (lifecycle === 'dev' || lifecycle === 'dev:server') return false
  return true
}

const server = app.listen(port, () => {
  const appUrl = `http://localhost:${port}`
  const logFilePath = getLogFilePath()

  serverLogger.info('server.listening', { url: appUrl, port })
  serverLogger.info('server.listeningMeta', {
    port,
    nodeVersion: process.version,
    platform: process.platform,
    pid: process.pid,
  })
  serverLogger.info('server.logFile', { logFilePath })
  printServerReady({ url: appUrl, elapsedMs: Date.now() - BOOT_STARTED_AT })

  if (fs.existsSync(distPath) && shouldOpenBrowser()) {
    openBrowser(appUrl)
  }
})

server.on('error', (err) => {
  serverLogger.error('server.serverError', {
    error: err?.message,
    code: err?.code,
    stack: err?.stack?.slice(0, 500),
  })
})
