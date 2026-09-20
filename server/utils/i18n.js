/**
 * 轻量 i18n：终端日志等文案不写死在业务代码里。
 * 语言包：server/locales/<locale>.json
 * 默认语言：zh-CN，可用环境变量 APP_LANG 覆盖（如 APP_LANG=en-US）
 */
const fs = require('fs')
const path = require('path')

const LOCALES_DIR = path.join(__dirname, '..', 'locales')
const SUPPORTED_LOCALES = ['zh-CN', 'en-US']
const DEFAULT_LOCALE = 'zh-CN'

const catalogs = Object.create(null)
let currentLocale = DEFAULT_LOCALE

function normalizeLocale(locale) {
  if (!locale) return DEFAULT_LOCALE
  const value = String(locale).trim()
  if (SUPPORTED_LOCALES.includes(value)) return value
  const lower = value.toLowerCase()
  if (lower.startsWith('zh')) return 'zh-CN'
  if (lower.startsWith('en')) return 'en-US'
  return DEFAULT_LOCALE
}

function loadCatalog(locale) {
  const normalized = normalizeLocale(locale)
  if (catalogs[normalized]) return catalogs[normalized]

  const filePath = path.join(LOCALES_DIR, `${normalized}.json`)
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    catalogs[normalized] = JSON.parse(raw)
  } catch {
    catalogs[normalized] = {}
  }
  return catalogs[normalized]
}

function initI18n(locale) {
  currentLocale = normalizeLocale(locale || process.env.APP_LANG || DEFAULT_LOCALE)
  loadCatalog(currentLocale)
  loadCatalog(DEFAULT_LOCALE)
  return currentLocale
}

function setLocale(locale) {
  return initI18n(locale)
}

function getLocale() {
  return currentLocale
}

function getSupportedLocales() {
  return [...SUPPORTED_LOCALES]
}

/**
 * 翻译消息。若 key 不在语言包中，原样返回（兼容自由文本日志）。
 * 模板占位符：{name}
 */
function t(key, params = {}) {
  if (key == null || key === '') return ''
  const keyStr = String(key)

  const dict = catalogs[currentLocale] || loadCatalog(currentLocale)
  const fallback = catalogs[DEFAULT_LOCALE] || loadCatalog(DEFAULT_LOCALE)
  let template = dict[keyStr]

  if (template == null) {
    template = fallback[keyStr]
  }
  if (template == null) {
    return keyStr
  }

  return String(template).replace(/\{(\w+)\}/g, (match, name) => {
    if (params && Object.prototype.hasOwnProperty.call(params, name) && params[name] != null) {
      return String(params[name])
    }
    return match
  })
}

initI18n()

module.exports = {
  t,
  initI18n,
  setLocale,
  getLocale,
  getSupportedLocales,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
}
