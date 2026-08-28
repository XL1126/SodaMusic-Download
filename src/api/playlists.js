import { getStoredSession } from '../utils/authStorage'
import { fetchWithTimeout, parseApiResponse, DEFAULT_FETCH_TIMEOUT_MS, DOWNLOAD_XHR_TIMEOUT_MS } from '../utils/apiHelpers'

function getSessionPayload() {
  const session = getStoredSession()

  if (!session?.sessionid) {
    throw new Error('当前未登录。')
  }

  return session
}

export async function fetchPlaylistBatchProgress(batchId) {
  if (!batchId) {
    throw new Error('缺少批量任务 ID。')
  }

  const response = await fetchWithTimeout(`/api/playlist/batch-progress?batch_id=${encodeURIComponent(batchId)}`)
  return parseApiResponse(response, '获取打包进度失败')
}

export function downloadPlaylistBatchZipWithProgress({ playlistTitle, tasks, batchId, onProgress }) {
  const sessionPayload = getSessionPayload()

  if (!Array.isArray(tasks) || tasks.length === 0) {
    return Promise.reject(new Error('缺少批量下载任务。'))
  }

  if (!batchId) {
    return Promise.reject(new Error('缺少批量任务 ID。'))
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/playlist/batch-download', true)
    xhr.responseType = 'blob'
    xhr.setRequestHeader('Content-Type', 'application/json')

    // 超时时间 = 歌曲数量 × 1 分钟（每首歌最多 1 分钟）
    const taskCount = Array.isArray(tasks) ? tasks.length : 1
    xhr.timeout = Math.max(60 * 1000, taskCount * 60 * 1000)

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
      const minutes = Math.round(xhr.timeout / 60000)
      reject(new Error(`打包下载超时（${minutes} 分钟），请稍后重试。`))
    }

    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        const text = typeof xhr.responseText === 'string' ? xhr.responseText : ''

        try {
          const payload = JSON.parse(text)
          reject(new Error(payload?.error || payload?.message || '下载压缩包失败'))
        } catch {
          reject(new Error('下载压缩包失败'))
        }
        return
      }

      const disposition = xhr.getResponseHeader('content-disposition') || ''
      const fileNameMatch = disposition.match(/filename\*=UTF-8''([^;]+)|filename="?([^"]+)"?/)
      const fileName = fileNameMatch?.[1] || fileNameMatch?.[2]

      resolve({
        blob: xhr.response,
        fileName: fileName ? decodeURIComponent(fileName) : '',
      })
    }

    xhr.onerror = () => {
      reject(new Error('下载压缩包失败'))
    }

    xhr.send(JSON.stringify({
      ...sessionPayload,
      playlist_title: playlistTitle,
      batch_id: batchId,
      tasks,
    }))
  })
}

export async function fetchMyPlaylists() {
  const response = await fetchWithTimeout('/api/me/playlists', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(getSessionPayload()),
  })

  return parseApiResponse(response, '获取我创建的歌单失败')
}

export async function fetchCollectedPlaylists() {
  const response = await fetchWithTimeout('/api/me/collection/mixed', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(getSessionPayload()),
  })

  return parseApiResponse(response, '获取我收藏的歌单失败')
}

export async function fetchPlaylistDetail({ playlistId, cursor = '', count = 15 }) {
  const response = await fetchWithTimeout('/api/playlist/detail', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...getSessionPayload(),
      playlist_id: playlistId,
      cursor,
      count,
    }),
  })

  return parseApiResponse(response, '获取歌单详情失败')
}
