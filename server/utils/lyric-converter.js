/**
 * 歌词格式转换工具
 *  目前只实现 krcToLrc：KRC（酷狗逐字歌词，内含毫秒级时间戳 + 每个字的起止）→ 标准 LRC。
 *   - KRC 行格式：[行起始毫秒, 行总时长]逐字<wordStart,wordDur,0>字1<...>字2...
 *   - 这里只按行取整（丢掉每字级别精度），把每行内容拼接后以 [mm:ss.xx] 前缀写进 LRC，
 *     主流桌面/移动端播放器都能识别。
 */

// 把毫秒格式化成 LRC 标准前缀 [mm:ss.xx]，xx 取 10ms 精度（2 位百分秒）
function formatLrcTimestamp(startMs) {
  const totalSeconds = Math.floor(startMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  const centiseconds = Math.floor((startMs % 1000) / 10)

  return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}]`
}

function krcToLrc(krcContent, title = '', artist = '') {
  if (!krcContent || typeof krcContent !== 'string') {
    return ''
  }

  const lines = []

  if (title || artist) {
    const header = [title, artist].filter(Boolean).join(' - ')
    if (header) {
      lines.push(`[00:00.00]${header}`)
    }
  }

  const lineRegex = /\[(\d+),\d+\](.*)/g
  let lineMatch = lineRegex.exec(krcContent)

  while (lineMatch) {
    const startMs = Number(lineMatch[1] || 0)
    const wordsPart = lineMatch[2] || ''
    const wordRegex = /<\d+,\d+,\d+>([^<]+)/g
    const fragments = []
    let wordMatch = wordRegex.exec(wordsPart)

    while (wordMatch) {
      fragments.push(wordMatch[1])
      wordMatch = wordRegex.exec(wordsPart)
    }

    const lineText = fragments.join('')
    lines.push(`${formatLrcTimestamp(startMs)}${lineText}`)
    lineMatch = lineRegex.exec(krcContent)
  }

  return lines.join('\n')
}

module.exports = {
  krcToLrc,
}
