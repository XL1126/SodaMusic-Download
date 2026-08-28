import { fetchWithTimeout, parseApiResponse } from '../utils/apiHelpers'

export async function resolveShareResource(shareText) {
  if (!shareText || !String(shareText).trim()) {
    throw new Error('请输入分享链接。')
  }

  const response = await fetchWithTimeout('/api/share/resolve', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      share_text: shareText,
    }),
  })

  return parseApiResponse(response, '解析分享链接失败')
}
