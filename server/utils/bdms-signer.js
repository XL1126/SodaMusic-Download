/**
 * BDMS 签名生成模块
 * 使用 SodaMusic 客户端的 bdms.node 原生模块生成 API 请求签名头
 *
 * 从逆向分析发现：
 *  - bdms.init({ deviceId }) 初始化
 *  - bdms.generateHttpSignatureHeaders(url, headersStr) 生成签名
 *  - headersStr 格式: "key1\\r\\nvalue1\\r\\nkey2\\r\\nvalue2"
 *  - 返回值: "\\r\\n" 分隔的 key-value 对
 */
const path = require('path')
const { logger } = require('./logger')

const signerLogger = logger.child('BdmsSigner')

// SodaMusic 客户端中 bdms.node 的路径
const SODAMUSIC_PATH = process.env.SODAMUSIC_PATH
  || path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Programs', 'Soda Music', '3.5.1')

const BDMS_NODE_PATH = path.join(SODAMUSIC_PATH, 'resources', 'app.asar.unpacked', 'bdms.node')
const METASECML_DIR = path.join(SODAMUSIC_PATH, 'resources', 'app.asar.unpacked')

let bdms = null
let initialized = false
let currentDeviceId = ''

/**
 * 初始化 BDMS 签名模块
 * @param {string} deviceId - 设备 ID（从 SodaMusic 请求参数中获取）
 */
function initSigner(deviceId) {
  if (initialized) {
    signerLogger.debug(`Signer already initialized`)
    return true
  }

  try {
    // 确保 metasecml.dll 在 PATH 中
    if (!process.env.PATH.includes(METASECML_DIR)) {
      process.env.PATH = METASECML_DIR + ';' + (process.env.PATH || '')
    }

    bdms = require(BDMS_NODE_PATH)
    currentDeviceId = deviceId

    bdms.init({ deviceId })
    initialized = true

    signerLogger.info(`BDMS signer initialized`, { deviceId })
    return true
  } catch (error) {
    signerLogger.error(`BDMS signer init failed`, {
      error: error.message,
      bdmsPath: BDMS_NODE_PATH,
      deviceId,
    })
    return false
  }
}

/**
 * 构建 headers 字符串（bdms.node 要求的格式）
 * @param {Object} headers - { key: value } 或 { key: [value1, value2] }
 * @returns {string} "key1\r\nvalue1\r\nkey2\r\nvalue2"
 */
function buildHeadersString(headers) {
  const lines = []
  for (const [key, values] of Object.entries(headers)) {
    for (const value of (Array.isArray(values) ? values : [values])) {
      lines.push(`${key}\r\n${value}`)
    }
  }
  return lines.join('\r\n')
}

/**
 * 解析 bdms 返回的签名头字符串
 * @param {string} result - "\r\n" 分隔的 key-value 对
 * @returns {Object} { 'X-Helios': '...', 'X-Medusa': '...' }
 */
function parseSignatureResult(result) {
  if (!result || result.length === 0) {
    return {}
  }

  const headers = {}
  const parts = result.split('\r\n').filter(t => t.trim())

  for (let i = 0; i < parts.length; i += 2) {
    const key = parts[i]
    const value = parts[i + 1]
    if (key && value) {
      headers[key] = value
    }
  }

  return headers
}

/**
 * 为请求生成签名头
 * @param {string} url - 完整的请求 URL
 * @param {Object} existingHeaders - 已有的请求头
 * @returns {Object} 包含 X-Helios, X-Medusa 等签名头
 */
function generateSignatureHeaders(url, existingHeaders = {}) {
  if (!initialized || !bdms) {
    signerLogger.warn(`Signer not initialized, skipping signature`)
    return {}
  }

  try {
    const headersStr = buildHeadersString(existingHeaders)
    const result = bdms.generateHttpSignatureHeaders(url, headersStr)
    const headers = parseSignatureResult(result)

    signerLogger.debug(`Signature generated`, {
      url: url.substring(0, 100),
      headerCount: Object.keys(headers).length,
      headerNames: Object.keys(headers).join(', '),
    })

    return headers
  } catch (error) {
    signerLogger.error(`Signature generation failed`, {
      error: error.message,
      url: url.substring(0, 100),
    })
    return {}
  }
}

module.exports = {
  initSigner,
  generateSignatureHeaders,
  buildHeadersString,
  parseSignatureResult,
  isInitialized: () => initialized,
}
