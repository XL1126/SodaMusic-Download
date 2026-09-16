const express = require('express')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

const APP_NAME = 'SodaMusic-Download'
const APP_VERSION = 'v2.0.1'

// ============================================================
// 平台检测：仅支持 Windows
// bdms.node（汽水音乐安全签名模块）依赖 SodaMusic PC 客户端的
// 原生 DLL，仅在 Windows 上可用。Linux/macOS 无法运行。
// ============================================================
if (process.platform !== 'win32') {
  console.error('')
  console.error('═══════════════════════════════════════════════════════════')
  console.error(`  ${APP_NAME} ${APP_VERSION} 仅支持 Windows 系统运行`)
  console.error('═══════════════════════════════════════════════════════════')
  console.error('')
  console.error('  原因：项目依赖汽水音乐 PC 客户端（SodaMusic）的')
  console.error('  bdms.node 原生安全签名模块，该模块仅在 Windows 上可用。')
  console.error('')
  console.error('  当前系统：' + process.platform)
  console.error('  Node.js：' + process.version)
  console.error('')
  console.error('  如需在非 Windows 系统上使用，请考虑：')
  console.error('  1. 使用 Windows 虚拟机或 WSL + Windows 容器')
  console.error('  2. 等待跨平台替代方案')
  console.error('')
  console.error('═══════════════════════════════════════════════════════════')
  console.error('')
  process.exit(1)
}

const apiDefinitions = require('./apis')
const { logger, getLogFilePath } = require('./utils/logger')

const serverLogger = logger.child('Server')

const app = express()
const port = process.env.PORT || 3001
const distPath = path.join(__dirname, '..', 'dist')

app.use((req, _res, next) => {
  const start = Date.now()
  const method = req.method.toUpperCase()
  const url = req.originalUrl || req.url

  // 【修复-日志不乱】接口请求/响应分级：
  //  ① 700ms 一次的高频轮询接口 GET /api/playlist/batch-progress
  //    → 用 DEBUG（仅 ./logs 文件里保留），用户 console 端不会被刷屏。
  //  ② 其他请求 → INFO 一条，显示 method + url + statusCode + elapsedMs（清爽一行）。
  //  不再请求一条 debug + 响应一条 debug（原来是双倍刷屏，而且一堆 content-length 等无意义字段）。
  const isProgressPoll = url === '/api/playlist/batch-progress'
    || url.startsWith('/api/playlist/batch-progress?')

  const origSend = _res.send.bind(_res)
  const origJson = _res.json.bind(_res)
  let logged = false

  const logOneLine = () => {
    if (logged) return
    logged = true
    const elapsed = Date.now() - start
    const status = _res.statusCode
    const msg = `${method} ${url} ${status} (${elapsed}ms)`
    if (isProgressPoll) {
      // 高频轮询降级 DEBUG，只写文件不 console
      serverLogger.debug(msg, { method, url, statusCode: status, elapsedMs: elapsed })
    } else {
      serverLogger.info(msg, { method, url, statusCode: status, elapsedMs: elapsed })
    }
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

  serverLogger.info(`Registering route`, { method: method.toUpperCase(), path: routePath, name: definition.name })

  app[method](routePath, async (req, res, next) => {
    try {
      await definition.handler(req, res, next)
    } catch (err) {
      serverLogger.error(`Unhandled error in route handler`, {
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

if (fs.existsSync(distPath)) {
  serverLogger.info(`Serving static frontend from ${distPath}`)
  app.use(express.static(distPath))

  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'))
  })
}

process.on('uncaughtException', (err) => {
  serverLogger.error(`UNCAUGHT EXCEPTION`, {
    error: err?.message,
    errorName: err?.name,
    stack: err?.stack,
  })
})

process.on('unhandledRejection', (reason, promise) => {
  serverLogger.error(`UNHANDLED REJECTION`, {
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
    // Windows: start "" "url"；空 title 避免 url 被当成窗口标题
    const child = spawn('cmd', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      shell: false,
    })
    child.unref()
    serverLogger.info(`Opened browser at ${url}`, { url })
  } catch (err) {
    serverLogger.warn(`Failed to open browser`, { url, error: err?.message })
  }
}

function shouldOpenBrowser() {
  if (process.env.AUTO_OPEN === '0') return false
  if (process.env.AUTO_OPEN === '1') return true
  // 开发模式交给 Vite 打开 5173，避免同时弹出 3001
  const lifecycle = process.env.npm_lifecycle_event
  if (lifecycle === 'dev' || lifecycle === 'dev:server') return false
  return true
}

const server = app.listen(port, () => {
  const appUrl = `http://localhost:${port}`
  serverLogger.info(`${APP_NAME} ${APP_VERSION} server listening on ${appUrl}`, {
    port,
    logFilePath: getLogFilePath(),
    nodeVersion: process.version,
    platform: process.platform,
    pid: process.pid,
  })

  // 仅在提供前端静态页时自动打开，纯 API 模式不弹浏览器
  if (fs.existsSync(distPath) && shouldOpenBrowser()) {
    openBrowser(appUrl)
  }
})

server.on('error', (err) => {
  serverLogger.error(`Server error`, {
    error: err?.message,
    code: err?.code,
    stack: err?.stack?.slice(0, 500),
  })
})

