/**
 * 批量下载进度查询接口（GET /api/playlist/batch-progress）
 *
 * 作用：前端每隔数百毫秒轮询一次该接口，根据 batch_id 拿到
 *       当前打包下载任务的 total / completed / status / error，
 *       用于刷新进度条与最终状态提示。
 *
 * 进度数据本身由 playlist-batch-download.js 通过 batch-progress-store
 * 在服务端内存中维护（已在上一轮改造中加入了 TTL 自动清理机制）。
 *
 * 原问题：
 *  - 该接口完全没有日志，batch_id 不存在 / 非法时无法追踪。
 */

const { getBatchProgress } = require('../utils/batch-progress-store')
const { logger } = require('../utils/logger')

const progressLogger = logger.child('PlaylistBatchProgress')

module.exports = {
  name: 'playlist-batch-progress',
  method: 'get',
  path: '/api/playlist/batch-progress',
  handler: async (req, res) => {
    const batchId = String(req.query?.batch_id || '').trim()

    if (!batchId) {
      progressLogger.warn(`batch progress: missing batch_id`)
      res.status(400).json({
        message: 'batch_id is required',
      })
      return
    }

    const progress = getBatchProgress(batchId)

    if (!progress) {
      progressLogger.warn(`batch progress: batch_id not found`, { batchId })
      res.status(404).json({
        message: 'batch progress not found',
      })
      return
    }

    progressLogger.debug(`batch progress: return snapshot`, {
      batchId,
      completed: progress.completed,
      total: progress.total,
      status: progress.status,
      ageMs: Date.now() - (progress.updatedAt || progress.createdAt || Date.now()),
    })

    res.json(progress)
  },
}
