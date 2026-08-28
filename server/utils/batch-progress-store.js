/**
 * 批量下载进度的内存存储（进程内 Map + 自动过期清理）
 *
 * 原问题：
 *  - store 是纯内存 Map，没有清理机制。
 *    如果前端在下载中途关闭页面 / 崩溃 / 长时间不调用 deleteBatchProgress，
 *    则对应 batchId 会永久残留在 Map 中。
 *    长时间运行的服务（或高频批量任务）会造成内存缓慢但无限增长 → 内存泄漏。
 *
 * 修复：
 *  - 每 60 秒执行一次 GC：删除「updatedAt 距今 > 30 分钟」或「createdAt 距今 > 2 小时」的条目。
 *  - 正常批量打包下载 500 首歌曲也会在 < 30 分钟内完成并主动 delete；
 *    超过 30 分钟未更新可安全视为已放弃。
 */

const { logger } = require('./logger')

const progressLogger = logger.child('BatchProgressStore')

const store = new Map()

// 超过此时间未 updatedAt，认为任务已被客户端放弃，自动回收
const STALE_ENTRY_MS = 30 * 60 * 1000 // 30 分钟
// 无论如何，任务创建超过 MAX_ENTRY_AGE_MS 都要回收（防止 updatedAt 误刷永远不回收）
const MAX_ENTRY_AGE_MS = 2 * 60 * 60 * 1000 // 2 小时
// GC 轮询间隔
const GC_INTERVAL_MS = 60 * 1000 // 1 分钟

// GC 定时器：进程生命周期唯一一次注册；unref() 表示不阻塞 node 进程正常退出
const _gcTimer = setInterval(() => {
  const now = Date.now()
  let evicted = 0

  for (const [batchId, snapshot] of store.entries()) {
    const staleFor = now - (snapshot.updatedAt || snapshot.createdAt || now)
    const age = now - (snapshot.createdAt || now)
    if (staleFor > STALE_ENTRY_MS || age > MAX_ENTRY_AGE_MS) {
      store.delete(batchId)
      evicted += 1
    }
  }

  if (evicted > 0) {
    progressLogger.info(`GC evicted stale batch progress entries`, {
      evicted,
      remaining: store.size,
    })
  }
}, GC_INTERVAL_MS)
if (typeof _gcTimer.unref === 'function') _gcTimer.unref()

function createBatchProgress(batchId, total) {
  const snapshot = {
    batchId,
    total: Number(total) || 0,
    completed: 0,
    // 【修复】新增 failed 数字与 failed_list 数组，用于：
    //  ① 后端累计失败数量；② 前端根据 failed_list[i].index 精准定位哪一行失败并显示原因
    failed: 0,
    failed_list: [],
    status: 'running',
    error: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  store.set(batchId, snapshot)
  progressLogger.info(`Created batch progress`, { batchId, total: snapshot.total })
  return snapshot
}

function updateBatchProgress(batchId, patch) {
  const current = store.get(batchId)

  if (!current) {
    progressLogger.warn(`updateBatchProgress: batchId not found`, { batchId })
    return null
  }

  const next = {
    ...current,
    ...patch,
    updatedAt: Date.now(),
  }

  // 【修复-根因②】completed 绝对赋值 → 基于 current 值的增量式兜底
  //  若调用方直接传 completed=绝对数，仍按原数写入（兼容 playlist-batch-download 当前显式传 successCount）；
  //  但若出现只传 incCompleted=true 的新调用场景，则在 current.completed 上 +1，
  //  这样即使将来引入 skip/并行，不会因为"并发覆盖写"导致 completed 回退。
  if (patch?.incCompleted === true && patch.completed === undefined) {
    next.completed = (current.completed || 0) + 1
  }

  store.set(batchId, next)

  if (patch.status || patch.completed !== undefined || patch.failed !== undefined) {
    progressLogger.debug(`Updated batch progress`, {
      batchId,
      completed: next.completed,
      failed: next.failed,
      total: next.total,
      status: next.status,
      error: patch.error || '',
    })
  }

  return next
}

function getBatchProgress(batchId) {
  const snapshot = store.get(batchId) || null
  progressLogger.debug(`getBatchProgress`, {
    batchId,
    found: Boolean(snapshot),
    completed: snapshot?.completed,
    total: snapshot?.total,
    status: snapshot?.status,
  })
  return snapshot
}

function deleteBatchProgress(batchId) {
  const existed = store.has(batchId)
  store.delete(batchId)
  if (existed) {
    progressLogger.info(`Deleted batch progress`, { batchId })
  }
}

module.exports = {
  createBatchProgress,
  updateBatchProgress,
  getBatchProgress,
  deleteBatchProgress,
}
