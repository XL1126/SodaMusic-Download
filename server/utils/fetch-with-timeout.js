const { logger } = require('./logger')

const DEFAULT_TIMEOUT_MS = 60 * 1000 // 60 seconds default timeout
const LONG_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes for large media

function createTimeoutSignal(timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => {
    controller.abort()
  }, timeoutMs)

  return {
    signal: controller.signal,
    clearTimeout: () => clearTimeout(timeoutId),
    timeoutMs,
  }
}

async function fetchWithTimeout(resource, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const { signal: userSignal, ...restOptions } = options
  const { signal, clearTimeout } = createTimeoutSignal(timeoutMs)

  let combinedSignal = signal

  if (userSignal) {
    if ('any' in AbortSignal) {
      combinedSignal = AbortSignal.any([signal, userSignal])
    } else {
      const abortBoth = () => {
        if (!signal.aborted) {
          try {
            const controller = new AbortController()
            controller.abort()
          } catch {}
        }
      }
      if (userSignal.aborted) {
        abortBoth()
      } else {
        userSignal.addEventListener('abort', abortBoth, { once: true })
      }
    }
  }

  const startTime = Date.now()
  const resourceStr = typeof resource === 'string' ? resource : resource?.url || 'unknown'

  try {
    logger.debug(`[fetchWithTimeout] Starting request`, {
      url: resourceStr.length > 200 ? resourceStr.slice(0, 200) + '...' : resourceStr,
      method: restOptions.method || 'GET',
      timeoutMs,
    })

    const response = await fetch(resource, {
      ...restOptions,
      signal: combinedSignal,
    })

    const elapsed = Date.now() - startTime
    logger.debug(`[fetchWithTimeout] Request completed`, {
      url: resourceStr.length > 200 ? resourceStr.slice(0, 200) + '...' : resourceStr,
      status: response.status,
      elapsedMs: elapsed,
    })

    return response
  } catch (error) {
    const elapsed = Date.now() - startTime
    if (error?.name === 'AbortError') {
      logger.warn(`[fetchWithTimeout] Request timed out`, {
        url: resourceStr.length > 200 ? resourceStr.slice(0, 200) + '...' : resourceStr,
        timeoutMs,
        elapsedMs: elapsed,
      })
      const timeoutError = new Error(`Request timed out after ${timeoutMs}ms`)
      timeoutError.name = 'TimeoutError'
      timeoutError.cause = error
      timeoutError.status = 504
      throw timeoutError
    }

    logger.error(`[fetchWithTimeout] Request failed`, {
      url: resourceStr.length > 200 ? resourceStr.slice(0, 200) + '...' : resourceStr,
      error: error?.message,
      elapsedMs: elapsed,
    })
    throw error
  } finally {
    clearTimeout()
  }
}

module.exports = {
  fetchWithTimeout,
  createTimeoutSignal,
  DEFAULT_TIMEOUT_MS,
  LONG_TIMEOUT_MS,
}
