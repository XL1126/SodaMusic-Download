import { getStoredSession } from '../utils/authStorage'
import { fetchWithTimeout, parseApiResponse, DEFAULT_FETCH_TIMEOUT_MS, DOWNLOAD_XHR_TIMEOUT_MS } from '../utils/apiHelpers'

/**
 * 前端「歌曲 / 单曲下载」API 层
 * 涉及：
 *  - fetchTrackV2()            → 以 session 为凭证查曲目元数据（含加密 spade_a、清晰度列表等）
 *  - downloadEncryptedTrack()  → 普通 Promise 下载单曲（无进度回调）
 *  - downloadEncryptedTrackWithProgress() → XMLHttpRequest.onprogress 进度回调式下载
 *
 * 【原有问题 & 修复点】
 *  1) parseApiResponse 未检查后端业务层 status_code：
 *     后端已在 HTTP 200 下以 { status_code:!=0, message:'...' } 报告业务错误，
 *     playlists.js 里做了该检查但 tracks.js 没做，导致 UI 把失败响应当成成功 payload
 *     使用，后续报「Cannot read property of undefined」等难排查错误。
 *     修复：与 playlists.js 保持完全一致的 status_code 校验分支。
 *  2) 所有 fetch() 调用无超时：浏览器 fetch 默认无超时，服务器或网络故障时 Promise 永不 settle，
 *     用户只能关页面重来。修复：每个 fetch 包一层 AbortController + 30s setTimeout。
 *  3) XHR 下载 progress 回调方法未设 xhr.timeout：批量 FLAC 单首几十 MB，大文件 + 弱网可能
 *     长时间不进展也不报错。修复：设置 xhr.timeout = 10 分钟，ontimeout 抛明确错误。
 *  4) 单曲下载的 Content-Disposition 解析正则只匹配 filename="..."，不支持 RFC 5987
 *     filename*=UTF-8''xxx：后端已改为双写，前端解析需要同时匹配（优先 filename*）。
 */

function getSessionPayload() {
  const session = getStoredSession()

  if (!session?.sessionid) {
    throw new Error('当前未登录。')
  }

  return session
}

export async function fetchTrackV2(trackId) {
  if (!trackId) {
    throw new Error('缺少乐曲 ID。')
  }

  // 【修复2】使用 fetchWithTimeout 包一层，30s 超时
  const response = await fetchWithTimeout('/api/track/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...getSessionPayload(),
      track_id: trackId,
      media_type: 'track',
      queue_type: 'search_one_track',
      scene_name: 'search',
    }),
  })

  return parseApiResponse(response, '获取乐曲信息失败')
}

export async function downloadEncryptedTrack({ trackId, quality }) {
  if (!trackId) {
    throw new Error('缺少乐曲 ID。')
  }

  if (!quality) {
    throw new Error('缺少音质信息。')
  }

  const response = await fetchWithTimeout('/api/track/download-encrypted', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...getSessionPayload(),
      track_id: trackId,
      quality,
    }),
  })

  if (!response.ok) {
    let payload = null

    try {
      payload = await response.json()
    } catch {
      throw new Error('下载加密文件失败')
    }

    throw new Error(payload?.error || payload?.message || '下载加密文件失败')
  }

  const disposition = response.headers.get('content-disposition') || ''
  // 【修复4】同时匹配 filename*=UTF-8''xxx 和 filename="..."，优先 RFC 5987 以拿到正确中文名
  const fileNameMatch = disposition.match(/filename\*=UTF-8''([^;]+)|filename="?([^"]+)"?/)
  const fileName = fileNameMatch?.[1] || fileNameMatch?.[2]
  const blob = await response.blob()

  return {
    blob,
    fileName: fileName ? decodeURIComponent(fileName) : '',
  }
}

export function downloadEncryptedTrackWithProgress({ trackId, quality, onProgress }) {
  if (!trackId) {
    return Promise.reject(new Error('缺少乐曲 ID。'))
  }

  if (!quality) {
    return Promise.reject(new Error('缺少音质信息。'))
  }

  const sessionPayload = getSessionPayload()

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/track/download-encrypted', true)
    xhr.responseType = 'blob'
    xhr.setRequestHeader('Content-Type', 'application/json')

    // 【修复3】XHR 设置总超时 10 分钟，弱网不再永远 pending
    xhr.timeout = DOWNLOAD_XHR_TIMEOUT_MS

    xhr.onprogress = (event) => {
      if (typeof onProgress === 'function') {
        onProgress({
          loaded: event.loaded,
          total: event.lengthComputable ? event.total : 0,
          percent: event.lengthComputable && event.total > 0
            ? Math.min(100, Math.round((event.loaded / event.total) * 100))
            : 0,
        })
      }
    }

    xhr.ontimeout = () => {
      reject(new Error('下载超时（10 分钟），请稍后重试。'))
    }

    xhr.onload = async () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        const text = typeof xhr.responseText === 'string' ? xhr.responseText : ''

        try {
          const payload = JSON.parse(text)
          reject(new Error(payload?.error || payload?.message || '下载加密文件失败'))
        } catch {
          reject(new Error('下载加密文件失败'))
        }
        return
      }

      const disposition = xhr.getResponseHeader('content-disposition') || ''
      // 【修复4】XHR 路径同样补 filename*=UTF-8'' 优先解析
      const fileNameMatch = disposition.match(/filename\*=UTF-8''([^;]+)|filename="?([^"]+)"?/)
      const fileName = fileNameMatch?.[1] || fileNameMatch?.[2]

      resolve({
        blob: xhr.response,
        fileName: fileName ? decodeURIComponent(fileName) : '',
      })
    }

    xhr.onerror = () => {
      reject(new Error('下载加密文件失败'))
    }

    xhr.send(JSON.stringify({
      ...sessionPayload,
      track_id: trackId,
      quality,
    }))
  })
}
