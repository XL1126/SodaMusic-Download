const { Readable } = require('stream')
const crypto = require('crypto')
const archiver = require('archiver')
const { downloadTrackMedia } = require('../utils/track-download')
const { fetchVideoStream } = require('../utils/video-download')
const { VideoAudioExtractor } = require('../utils/video-audio-extractor')
const {
  createBatchProgress,
  deleteBatchProgress,
  updateBatchProgress,
} = require('../utils/batch-progress-store')
const { logger } = require('../utils/logger')

const batchLogger = logger.child('BatchDownload')

const request = {
  method: 'post',
  path: '/api/playlist/batch-download',
  headers: {
    'content-type': 'application/json; charset=utf-8',
  },
  body: {
    sessionid: 'string',
    playlist_title: 'string?',
    batch_id: 'string?',
    tasks: 'array',
  },
}

function sanitizeFilename(fileName, fallback = 'file') {
  const baseName = String(fileName || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .trim()

  return baseName || fallback
}

const ARCHIVE_APPEND_TIMEOUT_MS = 2 * 60 * 1000 // 2 minutes per append operation

function appendToArchive(archive, input, name) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup()
      const err = new Error(`Archive append timed out for "${name}" after ${ARCHIVE_APPEND_TIMEOUT_MS}ms`)
      err.name = 'ArchiveAppendTimeoutError'
      reject(err)
    }, ARCHIVE_APPEND_TIMEOUT_MS)

    let resolved = false

    const handleEntry = (entry) => {
      if (resolved) {
        return
      }
      if (entry?.name !== name) {
        return
      }

      resolved = true
      cleanup()
      batchLogger.debug(`Archive entry appended`, { entryName: name, entrySize: entry?.stats?.size || entry?.size || 'unknown' })
      resolve()
    }

    const handleFinish = () => {
      if (resolved) {
        return
      }
      // If finish fires before our specific entry event, consider it done
      resolved = true
      cleanup()
      batchLogger.warn(`Archive entry resolved via finish event (entry event missed)`, { entryName: name })
      resolve()
    }

    const handleError = (error) => {
      if (resolved) {
        return
      }
      resolved = true
      cleanup()
      batchLogger.error(`Archive error during append`, { entryName: name, error: error?.message })
      reject(error)
    }

    const cleanup = () => {
      clearTimeout(timeoutId)
      archive.off('entry', handleEntry)
      archive.off('finish', handleFinish)
      archive.off('error', handleError)
    }

    archive.on('entry', handleEntry)
    archive.on('finish', handleFinish)
    archive.on('error', handleError)

    batchLogger.debug(`Appending to archive`, { entryName: name, inputType: Buffer.isBuffer(input) ? `buffer(${input.length}b)` : typeof input })
    archive.append(input, { name })
  })
}

const TASK_TIMEOUT_FALLBACK_MS = 8 * 60 * 1000 // fallback per-task timeout

function withTaskTimeout(promise, taskDescription, timeoutMs = TASK_TIMEOUT_FALLBACK_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        const err = new Error(`Task timed out after ${timeoutMs}ms: ${taskDescription}`)
        err.name = 'TaskTimeoutError'
        batchLogger.error(`Task timeout`, { task: taskDescription, timeoutMs })
        reject(err)
      }, timeoutMs)
    }),
  ])
}

module.exports = {
  name: 'playlist-batch-download',
  method: request.method,
  path: request.path,
  request,
  response: {},
  handler: async (req, res) => {
    const startTime = Date.now()
    const { sessionid, playlist_title, tasks, batch_id } = req.body || {}
    // 【修复-根因③】batch_id 未传时，后端兜底生成一个 UUID，保证 createBatchProgress / updateBatchProgress 必被执行
    //  否则 if(batchId) 分支整体跳过，前端轮询接口会 404，进度条永远卡 0%。
    const rawBatchId = String(batch_id || '').trim()
    const batchId = rawBatchId || crypto.randomUUID()
    if (!rawBatchId) {
      // 将新生成的 batchId 写回响应头，方便前端/调试感知
      res.setHeader('X-Batch-Id', batchId)
      batchLogger.info(`Batch id not provided by client, server-generated fallback`, { batchId })
    }
    const taskCount = Array.isArray(tasks) ? tasks.length : 0

    batchLogger.info(`Batch download request started`, {
      batchId,
      playlistTitle: playlist_title || '(untitled)',
      taskCount,
    })

    // 超时时间 = 歌曲数量 × 1 分钟（整体），单任务超时按比例分配
    const totalTimeoutMs = Math.max(60 * 1000, taskCount * 60 * 1000)
    const taskTimeoutMs = Math.max(60 * 1000, Math.floor(totalTimeoutMs / taskCount))

    if (!sessionid) {
      batchLogger.warn(`Missing sessionid`)
      res.status(400).json({
        message: 'sessionid is required',
      })
      return
    }

    if (!Array.isArray(tasks) || tasks.length === 0) {
      batchLogger.warn(`Empty tasks array`)
      res.status(400).json({
        message: 'tasks is required',
      })
      return
    }

    const zipName = `${sanitizeFilename(playlist_title || 'playlist-batch-download')}.zip`
    const archive = archiver('zip', { zlib: { level: 9 } })

    archive.on('error', (error) => {
      batchLogger.error(`Archive error`, { batchId, error: error?.message, stack: error?.stack?.slice(0, 500) })
      if (batchId) {
        updateBatchProgress(batchId, {
          status: 'failed',
          error: error.message,
        })
      }

      if (!res.headersSent) {
        res.status(500).json({
          message: 'failed',
          error: error.message,
        })
        return
      }

      res.destroy(error)
    })

    archive.on('warning', (warning) => {
      batchLogger.warn(`Archive warning`, { batchId, warning: warning?.message })
    })

    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`)

    archive.pipe(res)

    // 【修复-根因③】batchId 现在必然存在（客户端不传则后端兜底生成），不再加 if(batchId) 判断
    batchLogger.info(`Creating batch progress`, { batchId, total: taskCount })
    createBatchProgress(batchId, tasks.length)

    try {
      // 【修复-根因①②④】整批处理改为"尽力而为"语义：
      //   - successCount：累计成功数，每首成功递增（绝对赋值→增量，避免未来有 skip 时错位）
      //   - failedList：记录每首失败的 {index, title, fileName, error}，后续写入 ZIP 内 __errors__.txt
      //   - 单曲失败不再 throw taskError → continue 下一首
      //   - 最终：successCount>0 → status='completed'（下发 ZIP，里面包含成功的文件 + __errors__.txt）
      //          successCount===0 → 全部失败 → status='failed'
      let successCount = 0
      const failedList = []

      for (let index = 0; index < tasks.length; index += 1) {
        const task = tasks[index]
        const taskNum = index + 1
        const fallbackPrefix = `${String(taskNum).padStart(3, '0')}-${sanitizeFilename(task?.title || 'file')}`
        const taskDesc = `[${taskNum}/${taskCount}] action=${task?.action || 'unknown'} title="${task?.title || '(untitled)'}"`
        const taskFileName = sanitizeFilename(task?.fileName || `${fallbackPrefix}.bin`)

        batchLogger.info(`Processing task ${taskDesc}`, {
          batchId,
          index,
          action: task?.action,
          trackId: task?.trackId,
        })

        const taskStart = Date.now()
        let taskOk = false

        try {
          if (task?.action === 'audio') {
            const result = await withTaskTimeout(
              downloadTrackMedia({
                sessionid,
                track_id: task.trackId,
                quality: task.quality,
              }),
              `${taskDesc} - downloadTrackMedia`,
              taskTimeoutMs,
            )
            const entryName = sanitizeFilename(task.fileName || result.fileName || `${fallbackPrefix}.bin`)
            batchLogger.debug(`Audio download complete`, {
              batchId,
              taskNum,
              entryName,
              bufferSize: result.buffer?.length,
              elapsedMs: Date.now() - taskStart,
            })
            await appendToArchive(archive, result.buffer, entryName)
            taskOk = true
          } else if (task?.action === 'video') {
            const upstream = await withTaskTimeout(
              fetchVideoStream(task.downloadUrl),
              `${taskDesc} - fetchVideoStream`,
              taskTimeoutMs,
            )
            const entryName = sanitizeFilename(task.fileName || `${fallbackPrefix}.mp4`)
            batchLogger.debug(`Video stream ready`, {
              batchId,
              taskNum,
              entryName,
              status: upstream.status,
              elapsedMs: Date.now() - taskStart,
            })
            await appendToArchive(archive, Readable.fromWeb(upstream.body), entryName)
            taskOk = true
          } else if (task?.action === 'video-audio') {
            const extractor = new VideoAudioExtractor()
            const result = await withTaskTimeout(
              extractor.extractMp3FromVideoUrl(task.downloadUrl, {
                baseName: sanitizeFilename(task.title || fallbackPrefix),
              }),
              `${taskDesc} - extractMp3FromVideoUrl`,
              taskTimeoutMs,
            )
            const entryName = sanitizeFilename(task.fileName || `${fallbackPrefix}.mp3`)
            batchLogger.debug(`Video->Audio extraction complete`, {
              batchId,
              taskNum,
              entryName,
              bufferSize: result.buffer?.length,
              elapsedMs: Date.now() - taskStart,
            })
            await appendToArchive(archive, result.buffer, entryName)
            taskOk = true
          } else {
            batchLogger.warn(`Skipping unknown task action`, {
              batchId,
              taskNum,
              action: task?.action,
            })
            // 未知 action 既不算成功，也不算失败；但会让后续 completed 计数与 selectedRows 切片错位。
            // 按"跳过"视为"失败"记录，用户能在 __errors__.txt 看到原因。
            failedList.push({
              index,
              title: task?.title || '(untitled)',
              fileName: taskFileName,
              error: `未知的任务 action：${task?.action}`,
            })
          }
        } catch (taskError) {
          // 【修复-根因①】关键修复：单曲失败不 throw，仅记录 + continue
          //  原代码 throw taskError → 整批中断 → archive.destroy() → 后续所有任务不处理、completed 永不更新
          //  → 用户永远看到"进度 0% / 第一首下载中"的卡住视觉。
          const errMsg = taskError?.message || String(taskError)
          batchLogger.error(`Task failed: ${taskDesc}`, {
            batchId,
            taskNum,
            error: errMsg,
            errorName: taskError?.name,
            elapsedMs: Date.now() - taskStart,
            stack: taskError?.stack?.slice(0, 500),
          })
          failedList.push({
            index,
            title: task?.title || '(untitled)',
            fileName: taskFileName,
            error: errMsg,
          })
        }

        if (taskOk) {
          // 【修复-根因②】completed 使用 successCount 递增赋值，不再使用绝对 taskNum 赋值
          //  这样中间有跳过/失败项时，进度 completed 依然与"实际已成功的数量"一致，
          //  不会出现 selectedRows.slice(0, taskNum) 把失败项也算作 completed 的情况。
          successCount += 1
          const taskElapsed = Date.now() - taskStart
          batchLogger.info(`Task completed: ${taskDesc}`, {
            batchId,
            taskNum,
            successCount,
            elapsedMs: taskElapsed,
          })
          updateBatchProgress(batchId, {
            completed: successCount,
            failed: failedList.length,
            failed_list: failedList,
          })
        } else {
          // 失败/跳过也要立刻更新 progress，前端可立即显示失败数量 / 失败原因
          updateBatchProgress(batchId, {
            failed: failedList.length,
            failed_list: failedList,
          })
        }
      }

      // 【修复-根因④】将失败清单写进 ZIP 的 __errors__.txt（若有）
      //  用户拿到压缩包后能一眼看到：哪些歌没下载成功、失败原因是什么。
      if (failedList.length > 0) {
        const lines = [
          `批量下载完成，但以下 ${failedList.length} 个任务失败：`,
          `（说明：其他已成功的歌曲仍在 ZIP 中，可以正常使用）`,
          '',
        ]
        for (let i = 0; i < failedList.length; i += 1) {
          const f = failedList[i]
          lines.push(`#${i + 1}  [index=${f.index}]  ${f.title}`)
          lines.push(`  文件名：${f.fileName}`)
          lines.push(`  失败原因：${f.error}`)
          lines.push('')
        }
        const errorsTxt = Buffer.from(lines.join('\n'), 'utf8')
        batchLogger.info(`Appending __errors__.txt to archive`, {
          batchId,
          failedCount: failedList.length,
        })
        try {
          await appendToArchive(archive, errorsTxt, '__errors__.txt')
        } catch (appendErr) {
          batchLogger.warn(`Failed to append __errors__.txt (non-fatal)`, {
            batchId,
            error: appendErr?.message,
          })
        }
      }

      batchLogger.info(`All tasks processed, finalizing archive`, {
        batchId,
        totalTasks: taskCount,
        successCount,
        failedCount: failedList.length,
        elapsedMs: Date.now() - startTime,
      })

      const finalizeStart = Date.now()
      await withTaskTimeout(
        archive.finalize(),
        `archive.finalize()`,
        5 * 60 * 1000,
      )
      batchLogger.info(`Archive finalized`, {
        batchId,
        finalizeMs: Date.now() - finalizeStart,
        totalBytes: archive.pointer(),
      })

      // 【修复-根因④】最终 status 语义：
      //   - successCount > 0（至少 1 首成功）→ 'completed'（下发 ZIP）
      //   - successCount === 0（全部失败）   → 'failed'
      if (successCount > 0) {
        updateBatchProgress(batchId, {
          completed: successCount,
          failed: failedList.length,
          failed_list: failedList,
          status: 'completed',
        })
        setTimeout(() => {
          batchLogger.debug(`Cleaning up batch progress`, { batchId })
          deleteBatchProgress(batchId)
        }, 5 * 60 * 1000)

        batchLogger.info(`Batch download completed (partial OK)`, {
          batchId,
          totalTasks: taskCount,
          successCount,
          failedCount: failedList.length,
          totalBytes: archive.pointer(),
          totalElapsedMs: Date.now() - startTime,
        })
      } else {
        // 全失败 → 没有任何成功内容可给用户 → 视为失败
        const allFailedMsg = `全部 ${taskCount} 个任务均失败，ZIP 为空；详情见日志。`
        batchLogger.error(`Batch download: all tasks failed`, {
          batchId,
          totalTasks: taskCount,
          failedCount: failedList.length,
          totalElapsedMs: Date.now() - startTime,
        })
        updateBatchProgress(batchId, {
          completed: 0,
          failed: failedList.length,
          failed_list: failedList,
          status: 'failed',
          error: allFailedMsg,
        })
        setTimeout(() => {
          deleteBatchProgress(batchId)
        }, 5 * 60 * 1000)

        try {
          archive.destroy()
        } catch (destroyErr) {
          batchLogger.warn(`Archive destroy error`, { error: destroyErr?.message })
        }
        if (!res.headersSent) {
          res.status(500).json({
            message: 'failed',
            error: allFailedMsg,
            failed_list: failedList,
          })
          return
        }
        res.destroy(new Error(allFailedMsg))
      }
    } catch (error) {
      // 走到这里一般是 archive.pipe / finalize 级别的严重错误（不是单曲失败）
      batchLogger.error(`Batch download fatal error`, {
        batchId,
        error: error?.message,
        errorName: error?.name,
        totalElapsedMs: Date.now() - startTime,
        stack: error?.stack?.slice(0, 800),
      })

      try {
        archive.destroy()
      } catch (destroyErr) {
        batchLogger.warn(`Archive destroy error`, { error: destroyErr?.message })
      }

      updateBatchProgress(batchId, {
        status: 'failed',
        error: error.message,
      })
      setTimeout(() => {
        deleteBatchProgress(batchId)
      }, 5 * 60 * 1000)

      if (!res.headersSent) {
        res.status(error.status || 500).json({
          message: 'failed',
          error: error.message,
        })
        return
      }

      res.destroy(error)
    }
  },
}
