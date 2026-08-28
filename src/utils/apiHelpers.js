/**
 * 通用前端 API 辅助工具
 * 提取自 tracks.js / playlists.js / share.js 中重复的 fetchWithTimeout 和 parseApiResponse
 */

const DEFAULT_FETCH_TIMEOUT_MS = 30 * 1000
const DOWNLOAD_XHR_TIMEOUT_MS = 10 * 60 * 1000

export async function fetchWithTimeout(resource, options, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(resource, {
      ...options,
      signal: controller.signal,
    })
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('请求超时，请检查网络后重试。')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export async function parseApiResponse(response, fallbackMessage) {
  let payload = null

  try {
    payload = await response.json()
  } catch {
    throw new Error(fallbackMessage)
  }

  if (!response.ok) {
    throw new Error(payload?.error || payload?.message || fallbackMessage)
  }

  if (typeof payload?.status_code === 'number' && payload.status_code !== 0) {
    throw new Error(payload?.message || fallbackMessage)
  }

  return payload
}

export { DEFAULT_FETCH_TIMEOUT_MS, DOWNLOAD_XHR_TIMEOUT_MS }
