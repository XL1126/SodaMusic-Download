<script setup>
import { computed, h, ref, watch } from 'vue'
import {
  NButton,
  NCheckbox,
  NDataTable,
  NEmpty,
  NModal,
  NProgress,
  NResult,
  NSelect,
  NSpace,
  NTag,
  NText,
  createDiscreteApi,
} from 'naive-ui'
import {
  downloadPlaylistBatchZipWithProgress,
  fetchPlaylistBatchProgress,
  fetchPlaylistDetail,
} from '../api/playlists'
import {
  fetchVideoV2,
} from '../api/videos'

const props = defineProps({
  show: {
    type: Boolean,
    default: false,
  },
  playlist: {
    type: Object,
    default: null,
  },
  userProfile: {
    type: Object,
    default: null,
  },
})

const emit = defineEmits(['update:show'])

const loadingResources = ref(false)
const loadingError = ref('')
const taskRows = ref([])
const downloadVideoMusic = ref(true)
const downloadAudioMusic = ref(true)
const convertVideoToAudio = ref(false)
const audioQualityPreference = ref('highest')
const running = ref(false)
const completedCount = ref(0)
const checkedTaskKeys = ref([])
const batchProgress = ref(0)
const currentBatchId = ref('')
let progressPollTimer = null
const { message } = createDiscreteApi(['message'])

const audioQualityOptions = [
  { label: '最高', value: 'highest' },
  { label: '最低', value: 'lowest' },
]

const taskColumns = [
  {
    title: '#',
    key: 'order',
    width: 64,
  },
  {
    title: '歌曲',
    key: 'title',
    minWidth: 220,
  },
  {
    title: '资源类型',
    key: 'resourceType',
    width: 100,
  },
  {
    title: '下载目标',
    key: 'targetType',
    width: 120,
  },
  {
    title: '质量',
    key: 'qualityLabel',
    width: 120,
  },
  {
    title: '状态',
    key: 'status',
    width: 120,
  },
  {
    title: '说明',
    key: 'message',
    minWidth: 220,
  },
]

const selectedTaskRows = computed(() => taskRows.value.filter((row) => checkedTaskKeys.value.includes(row.key)))
const totalTasks = computed(() => selectedTaskRows.value.length)
const overallProgress = computed(() => (
  running.value
    ? batchProgress.value
    : totalTasks.value > 0
    ? Math.round((completedCount.value / totalTasks.value) * 100)
    : 0
))

const allChecked = computed(() => totalTasks.value > 0 && checkedTaskKeys.value.length === taskRows.value.length)
const indeterminate = computed(() => checkedTaskKeys.value.length > 0 && checkedTaskKeys.value.length < taskRows.value.length)

function getTagVNode(row) {
  if (!row) {
    return '-'
  }

  const labelMap = {
    pending: '待下载',
    running: '下载中',
    completed: '已完成',
    failed: '失败',
  }

  return labelMap[row.status]
}

taskColumns[5].render = (row) => {
  const tag = getTagVNode(row)

  if (!tag) {
    return '-'
  }

  return h(
    NTag,
    {
      type: {
        pending: 'default',
        running: 'info',
        completed: 'success',
        failed: 'error',
      }[row.status],
      round: true,
      size: 'small',
    },
    { default: () => tag },
  )
}

taskColumns.unshift({
  title: () => h(
    'div',
    {
      style: {
        display: 'flex',
        justifyContent: 'center',
      },
    },
    [
      h(
        NCheckbox,
        {
          checked: allChecked.value,
          indeterminate: indeterminate.value,
          disabled: running.value || taskRows.value.length === 0,
          onUpdateChecked(checked) {
            checkedTaskKeys.value = checked ? taskRows.value.map((row) => row.key) : []
          },
        },
      ),
    ],
  ),
  key: 'checked',
  width: 56,
  align: 'center',
  render(row) {
    return h(
      'div',
      {
        style: {
          display: 'flex',
          justifyContent: 'center',
        },
      },
      [
        h(
          NCheckbox,
          {
            checked: checkedTaskKeys.value.includes(row.key),
            disabled: running.value,
            onUpdateChecked(checked) {
              if (checked) {
                checkedTaskKeys.value = [...new Set([...checkedTaskKeys.value, row.key])]
                return
              }

              checkedTaskKeys.value = checkedTaskKeys.value.filter((key) => key !== row.key)
            },
          },
        ),
      ],
    )
  },
})

function triggerDownload(blob, filename) {
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = filename
  link.rel = 'noopener'
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(objectUrl)
}

function stopProgressPolling() {
  if (progressPollTimer) {
    clearInterval(progressPollTimer)
    progressPollTimer = null
  }
}

/**
 * 【修复-失败列表展示】按后端轮询返回的 progress.failed_list 精准标记失败行。
 *
 *  原问题：syncRunningTaskStates 仅看 completed count（=已成功数），
 *  把 selectedRows.slice(0, completed) 全部当成 completed，
 *  后面那个当成 running，其他 pending。
 *  → 如果中间有失败项（比如 #1 成功、#2 失败、#3 正在跑），
 *    原来的逻辑会把 #2 也算 completed（因为它在 slice(0,1) 之外的 running 判断里会落到 pending 但其实 completed=1 slice 刚好到 #1，其实还行，但整体"失败"状态完全没处理）。
 *
 *  新逻辑：
 *   1. 根据 failed_list[i].index（后端任务原始下标），从 selectedRows 中定位对应的 key，
 *      组成 failedKeys Set，对应的行直接显示 status='failed' + 失败原因。
 *   2. 剩下的未失败任务，仍按 completed 做「线性分配 completed / running / pending」，
 *      但是计算 runningIdx 的时候必须把失败的跳过，否则失败的那一行会被当作"正在跑"。
 */
function syncRunningTaskStates(completed, failedList) {
  const selectedRows = selectedTaskRows.value
  const failed = Array.isArray(failedList) ? failedList : []

  // failedList[i].index 是后端 tasks[] 的原始下标（0-based）；selectedRows 就是按同样顺序传递的。
  const failedKeys = new Set(
    failed
      .filter((f) => typeof f.index === 'number')
      .map((f) => selectedRows[f.index]?.key)
      .filter(Boolean),
  )
  // 给失败 key → 失败原因，方便显示到 message 列
  const failedMsgByKey = new Map()
  for (const f of failed) {
    if (typeof f.index === 'number') {
      const key = selectedRows[f.index]?.key
      if (key) {
        failedMsgByKey.set(key, f.error || '下载失败')
      }
    }
  }

  // 把非失败的行按原始顺序重新编号，用于分配 completed / running / pending 位置
  const nonFailedOrderByKey = new Map()
  let order = 0
  for (const row of selectedRows) {
    if (!failedKeys.has(row.key)) {
      nonFailedOrderByKey.set(row.key, order)
      order += 1
    }
  }
  const nonFailedTotal = order
  const safeCompleted = Math.min(completed, nonFailedTotal)
  const runningOrder = safeCompleted // 当前正在跑的那一首（非失败队列里第 N 首）
  const currentRunningKey = [...nonFailedOrderByKey.entries()]
    .find(([, ord]) => ord === runningOrder)?.[0] || ''
  const completedKeys = new Set(
    [...nonFailedOrderByKey.entries()]
      .filter(([, ord]) => ord < safeCompleted)
      .map(([key]) => key),
  )

  taskRows.value = taskRows.value.map((row) => {
    if (!checkedTaskKeys.value.includes(row.key)) {
      return row
    }

    if (failedKeys.has(row.key)) {
      return {
        ...row,
        status: 'failed',
        message: failedMsgByKey.get(row.key) || '下载失败',
      }
    }

    if (completedKeys.has(row.key)) {
      return {
        ...row,
        status: 'completed',
        message: '已打包进压缩包',
      }
    }

    if (row.key === currentRunningKey) {
      return {
        ...row,
        status: 'running',
        message: '正在下载并打包',
      }
    }

    return {
      ...row,
      status: 'pending',
      message: '等待打包',
    }
  })
}

function startProgressPolling(batchId) {
  stopProgressPolling()

  progressPollTimer = setInterval(async () => {
    try {
      const progress = await fetchPlaylistBatchProgress(batchId)
      const total = Number(progress?.total) || 0
      const completed = Math.min(total, Number(progress?.completed) || 0)
      // 【修复】轮询时同时把 failed_list 传入 syncRunningTaskStates，让失败行实时显示
      const failedList = Array.isArray(progress?.failed_list) ? progress.failed_list : []
      const failed = Number(progress?.failed) || failedList.length

      completedCount.value = completed
      // 进度条百分比：(completed + failed) / total → 已经处理过的数量占比（更符合"整体进度"直觉）
      const processed = Math.min(total, completed + failed)
      batchProgress.value = total > 0
        ? Math.min(progress?.status === 'completed' ? 100 : 99, Math.round((processed / total) * 100))
        : 0

      syncRunningTaskStates(completed, failedList)

      if (progress?.status === 'completed' || progress?.status === 'failed') {
        stopProgressPolling()
      }
    } catch {
      // Ignore transient polling failures while download is still in progress.
    }
  }, 700)
}

function getTrackPermission(track) {
  if (!track?.label_info) {
    return false
  }

  const qualityMap = track.label_info.quality_map || {}

  if (track.label_info.only_vip_playable) {
    return true
  }

  const availableQualities = Array.isArray(track.bit_rates)
    ? track.bit_rates.map((item) => item?.quality).filter(Boolean)
    : []

  if (availableQualities.length === 0) {
    return false
  }

  return availableQualities.every((quality) => Boolean(qualityMap?.[quality]?.play_detail?.need_vip))
}

function isTrackUnavailable(track) {
  if (!track) {
    return false
  }

  if (track.status === 10) {
    return true
  }

  return track?.album?.id === '0' && !track?.album?.name
}

function getQualityRequirement(detail) {
  if (!detail) {
    return '不支持'
  }

  if (detail.need_purchase) {
    return detail.need_vip ? 'VIP + 购买' : '购买'
  }

  return detail.need_vip ? 'VIP' : '免费'
}

function canUseByPlayPermission(requirement) {
  if (requirement === '免费') {
    return true
  }

  if (requirement === 'VIP') {
    return Boolean(props.userProfile?.isVip)
  }

  return false
}

function chooseAudioQuality(resource) {
  const track = resource?.entity?.track_wrapper?.track
  const qualityMap = track?.label_info?.quality_map || {}
  const bitRates = Array.isArray(track?.bit_rates) ? track.bit_rates : []

  const availableList = bitRates.filter((item) => {
    const playRequirement = getQualityRequirement(qualityMap?.[item?.quality]?.play_detail)
    return canUseByPlayPermission(playRequirement)
  })

  if (availableList.length === 0) {
    return null
  }

  const sorted = [...availableList].sort((left, right) => {
    const leftSize = typeof left?.size === 'number' ? left.size : -1
    const rightSize = typeof right?.size === 'number' ? right.size : -1
    return rightSize - leftSize
  })

  return audioQualityPreference.value === 'lowest'
    ? sorted[sorted.length - 1]
    : sorted[0]
}

function parseVideoRowsFromPayload(payload) {
  const playerInfos = Array.isArray(payload?.player_infos) ? payload.player_infos : []
  const videoTitle = payload?.video?.title || payload?.video?.description || 'video'
  const rows = []

  for (const playerInfo of playerInfos) {
    const videoModelRaw = playerInfo?.video_model
    if (!videoModelRaw) {
      continue
    }

    let videoModel = null

    try {
      videoModel = JSON.parse(videoModelRaw)
    } catch {
      continue
    }

    const videoList = Array.isArray(videoModel?.video_list) ? videoModel.video_list : []
    for (const item of videoList) {
      if (!item?.main_url && !item?.backup_url) {
        continue
      }

      rows.push({
        quality: item?.video_meta?.quality || '-',
        definition: item?.video_meta?.definition || '-',
        size: typeof item?.video_meta?.size === 'number' ? item.video_meta.size : -1,
        downloadUrl: item?.main_url || item?.backup_url || '',
        videoFileName: `${videoTitle}-${item?.video_meta?.definition || item?.video_meta?.quality || 'video'}.${item?.video_meta?.vtype || 'mp4'}`,
        audioFileName: `${videoTitle}-${item?.video_meta?.definition || item?.video_meta?.quality || 'audio'}.mp3`,
      })
    }
  }

  return rows
}

function chooseVideoQuality(rows) {
  if (!rows.length) {
    return null
  }

  const sorted = [...rows].sort((left, right) => right.size - left.size)

  return audioQualityPreference.value === 'lowest'
    ? sorted[sorted.length - 1]
    : sorted[0]
}

async function fetchAllPlaylistResources(playlistId) {
  const resources = []
  let cursor = ''
  let hasMore = true

  while (hasMore) {
    const payload = await fetchPlaylistDetail({
      playlistId,
      cursor,
      count: 100,
    })

    const pageResources = Array.isArray(payload?.media_resources) ? payload.media_resources : []
    resources.push(...pageResources)
    hasMore = Boolean(payload?.has_more)
    cursor = payload?.next_cursor || ''

    if (hasMore && !cursor) {
      break
    }
  }

  return resources
}

async function buildTaskList() {
  if (!props.playlist?.id) {
    message.error('当前歌单缺少 ID。')
    return
  }

  if (!downloadVideoMusic.value && !downloadAudioMusic.value && !convertVideoToAudio.value) {
    message.warning('至少选择一种下载类型。')
    return
  }

  loadingResources.value = true
  loadingError.value = ''
  taskRows.value = []
  completedCount.value = 0

  try {
    const resources = await fetchAllPlaylistResources(props.playlist.id)
    const rows = []
    let order = 1

    for (const resource of resources) {
      const track = resource?.entity?.track_wrapper?.track
      const video = resource?.entity?.video
      const title = track?.name || video?.title || '未命名资源'

      if (resource?.type === 'video') {
        const videoId = video?.video_id || video?.vid || ''

        if (!videoId) {
          continue
        }

        let selectedVideoQuality = null
        try {
          const payload = await fetchVideoV2(videoId)
          selectedVideoQuality = chooseVideoQuality(parseVideoRowsFromPayload(payload))
        } catch (videoErr) {
          // 视频信息获取失败，跳过该视频，继续处理后续资源
          console.warn(`视频 ${title} 信息获取失败，跳过:`, videoErr?.message)
          continue
        }

        if (!selectedVideoQuality) {
          continue
        }

        if (downloadVideoMusic.value) {
          rows.push({
            key: `task-${resource.id}-video`,
            order: order,
            title,
            resourceType: '视频',
            targetType: '下载视频',
            qualityLabel: selectedVideoQuality.definition || selectedVideoQuality.quality,
            status: 'pending',
            message: '等待开始',
            action: 'video',
            downloadUrl: selectedVideoQuality.downloadUrl,
            fileName: selectedVideoQuality.videoFileName,
          })
          order += 1
        }

        if (convertVideoToAudio.value) {
          rows.push({
            key: `task-${resource.id}-video-audio`,
            order: order,
            title,
            resourceType: '视频',
            targetType: '转音频',
            qualityLabel: selectedVideoQuality.definition || selectedVideoQuality.quality,
            status: 'pending',
            message: '等待开始',
            action: 'video-audio',
            downloadUrl: selectedVideoQuality.downloadUrl,
            fileName: selectedVideoQuality.audioFileName,
          })
          order += 1
        }

        continue
      }

      if (!downloadAudioMusic.value || !track || isTrackUnavailable(track)) {
        continue
      }

      const selectedAudioQuality = chooseAudioQuality(resource)

      if (!selectedAudioQuality?.quality) {
        continue
      }

      rows.push({
        key: `task-${resource.id}-audio`,
        order: order,
        title,
        resourceType: '音频',
        targetType: '下载音频',
        qualityLabel: selectedAudioQuality.quality,
        status: 'pending',
        message: getTrackPermission(track) ? '按播放权限筛选' : '等待开始',
        action: 'audio',
        trackId: track.id,
        quality: selectedAudioQuality.quality,
      })
      order += 1
    }

    taskRows.value = rows
    checkedTaskKeys.value = rows.map((row) => row.key)

    if (rows.length === 0) {
      loadingError.value = '当前配置下没有可下载的音乐。'
    }
  } catch (error) {
    taskRows.value = []
    loadingError.value = error?.message || '获取乐曲列表失败'
  } finally {
    loadingResources.value = false
  }
}

function updateTaskRow(key, patch) {
  taskRows.value = taskRows.value.map((row) => (
    row.key === key
      ? { ...row, ...patch }
      : row
  ))
}

function runTask(task) {
  return {
    action: task.action,
    title: task.title,
    trackId: task.trackId || '',
    quality: task.quality || '',
    downloadUrl: task.downloadUrl || '',
    fileName: task.fileName || '',
  }
}

async function startBatchDownload() {
  if (running.value) {
    return
  }

  if (selectedTaskRows.value.length === 0) {
    message.warning('请先获取乐曲列表。')
    return
  }

  const selectedKeys = new Set(checkedTaskKeys.value)
  taskRows.value = taskRows.value.map((row) => ({
    ...row,
    status: selectedKeys.has(row.key) ? 'running' : row.status,
    message: selectedKeys.has(row.key) ? '等待打包' : row.message,
  }))

  running.value = true
  completedCount.value = 0
  batchProgress.value = 0
  currentBatchId.value = typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `batch-${Date.now()}-${Math.random().toString(16).slice(2)}`
  startProgressPolling(currentBatchId.value)

  try {
    const { blob, fileName } = await downloadPlaylistBatchZipWithProgress({
      playlistTitle: props.playlist?.title || 'playlist-batch-download',
      batchId: currentBatchId.value,
      tasks: selectedTaskRows.value.map(runTask),
      onProgress(progress) {
        if (progress.total > 0) {
          batchProgress.value = Math.max(batchProgress.value, progress.percent)
        }
      },
    })

    stopProgressPolling()
    triggerDownload(blob, fileName || `${props.playlist?.title || 'playlist-batch-download'}.zip`)

    // 【修复-最终失败汇总】不要无脑把所有勾选项标 completed，
    //  要根据轮询最后一帧中的 failed_list 分别标记：
    //   - 成功项 → completed；
    //   - 失败项 → failed，并显示具体原因；
    //   - 最后给一个 message.warning / success 汇总，用户一眼知道 X 成功 Y 失败。
    let latestFailedList = []
    try {
      const finalProgress = await fetchPlaylistBatchProgress(currentBatchId.value)
      if (finalProgress && Array.isArray(finalProgress.failed_list)) {
        latestFailedList = finalProgress.failed_list
      }
      completedCount.value = Number(finalProgress?.completed) || completedCount.value
    } catch {
      // ignore: 可能已经被后端 5 分钟 cleanup 删除
    }

    const failedSet = new Set(
      latestFailedList
        .filter((f) => typeof f.index === 'number')
        .map((f) => selectedTaskRows.value[f.index]?.key)
        .filter(Boolean),
    )
    const failedMsgByKey = new Map()
    for (const f of latestFailedList) {
      if (typeof f.index === 'number') {
        const key = selectedTaskRows.value[f.index]?.key
        if (key) failedMsgByKey.set(key, f.error || '下载失败')
      }
    }

    let okCount = 0
    let failCount = 0
    taskRows.value = taskRows.value.map((row) => {
      if (!selectedKeys.has(row.key)) return row
      if (failedSet.has(row.key)) {
        failCount += 1
        return { ...row, status: 'failed', message: failedMsgByKey.get(row.key) || '下载失败' }
      }
      okCount += 1
      return { ...row, status: 'completed', message: '已打包进压缩包' }
    })

    batchProgress.value = 100
    if (failCount === 0) {
      message.success(`压缩包已开始下载（${okCount} 首全部成功）。`)
    } else {
      message.warning(`${okCount} 首成功，${failCount} 首失败；失败原因见压缩包内的 __errors__.txt 或表格说明列。`)
    }
  } catch (error) {
    stopProgressPolling()

    // 【修复】只有真正"整批失败"（xhr.onerror / status !=200）才把所有选中项标 failed，
    //  否则（部分失败但 ZIP 仍下发）上面的 try 分支已经正确分类了。
    // 先尝试读最后一轮 progress，避免把之前已经成功的也标成 failed。
    let latestFailedList = []
    try {
      const finalProgress = await fetchPlaylistBatchProgress(currentBatchId.value)
      if (finalProgress && Array.isArray(finalProgress.failed_list)) {
        latestFailedList = finalProgress.failed_list
      }
    } catch {
      // ignore
    }
    const nonFailedKeys = new Set()
    const successCount = latestFailedList.length > 0
      ? 0
      : 0
    // 如果有 progress.failed_list，则除了 failed_list 里的 index，其他都算"至少尝试过"；
    // 如果连 progress 都没，则全部标 failed（最保守）。
    const failedSet = new Set(
      latestFailedList
        .filter((f) => typeof f.index === 'number')
        .map((f) => selectedTaskRows.value[f.index]?.key)
        .filter(Boolean),
    )
    const failedMsgByKey = new Map()
    for (const f of latestFailedList) {
      if (typeof f.index === 'number') {
        const key = selectedTaskRows.value[f.index]?.key
        if (key) failedMsgByKey.set(key, f.error || error?.message || '下载失败')
      }
    }

    taskRows.value = taskRows.value.map((row) => {
      if (!selectedKeys.has(row.key)) return row
      if (latestFailedList.length > 0 && !failedSet.has(row.key)) {
        // 已经有 failed_list 的情况下，不在 failedSet 中的至少不是已知失败
        return { ...row, status: 'pending', message: error?.message || '打包中断' }
      }
      if (failedSet.has(row.key)) {
        return { ...row, status: 'failed', message: failedMsgByKey.get(row.key) || error?.message || '打包下载失败' }
      }
      return { ...row, status: 'failed', message: error?.message || '打包下载失败' }
    })
    void successCount
    void nonFailedKeys
    message.error(error?.message || '打包下载失败')
  } finally {
    running.value = false
    currentBatchId.value = ''
  }
}

function resetState() {
  stopProgressPolling()
  loadingResources.value = false
  loadingError.value = ''
  taskRows.value = []
  running.value = false
  completedCount.value = 0
  checkedTaskKeys.value = []
  batchProgress.value = 0
  currentBatchId.value = ''
  downloadVideoMusic.value = true
  downloadAudioMusic.value = true
  convertVideoToAudio.value = false
  audioQualityPreference.value = 'highest'
}

watch(
  () => props.show,
  (show) => {
    if (show) {
      resetState()
    }
  },
)
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    style="width: 1080px;"
    title="打包下载"
    :mask-closable="!running"
    :close-on-esc="!running"
    :closable="!running"
    @update:show="(value) => { if (!running) emit('update:show', value) }"
  >
    <n-space vertical size="large">
      <n-space vertical :size="12">
        <n-text strong>下载设置</n-text>
        <n-space>
          <n-checkbox v-model:checked="downloadVideoMusic">
            下载视频音乐
          </n-checkbox>
          <n-checkbox v-model:checked="downloadAudioMusic">
            下载音频音乐
          </n-checkbox>
          <n-checkbox v-model:checked="convertVideoToAudio">
            将视频音乐转换为音频
          </n-checkbox>
        </n-space>
        <n-space align="center">
          <n-text>音频质量</n-text>
          <n-select
            v-model:value="audioQualityPreference"
            :options="audioQualityOptions"
            style="width: 180px;"
          />
          <n-button secondary :loading="loadingResources" :disabled="running" @click="buildTaskList">
            获取乐曲列表
          </n-button>
        </n-space>
      </n-space>

      <n-result
        v-if="loadingError"
        status="warning"
        title="没有可下载的任务"
        :description="loadingError"
      />

      <template v-else>
        <n-space align="center" justify="space-between" :wrap="false">
          <n-space vertical :size="4">
            <n-text strong>
              共勾选 {{ totalTasks }} 个待处理文件
            </n-text>
            <n-text depth="3">
              {{ props.playlist?.title || '当前歌单' }}
            </n-text>
          </n-space>

          <n-button
            type="primary"
            :disabled="totalTasks === 0 || running"
            :loading="running"
            @click="startBatchDownload"
          >
            开始下载
          </n-button>
        </n-space>

        <n-empty v-if="!loadingResources && taskRows.length === 0" description="先设置条件并获取乐曲列表" />

        <n-data-table
          v-else
          :columns="taskColumns"
          :data="taskRows"
          :pagination="false"
          :single-line="false"
          size="small"
          max-height="360"
        />
      </template>

      <n-space v-if="taskRows.length > 0" vertical size="small">
        <n-text strong>整体进度</n-text>
        <n-progress
          type="line"
          :percentage="overallProgress"
          :indicator-placement="'inside'"
          :processing="running"
        />
        <n-text depth="3">
          <span v-if="running">已完成 {{ completedCount }} / {{ totalTasks }} 个文件，正在继续打包...</span>
          <span v-else>已完成 {{ completedCount }} / {{ totalTasks }} 个文件</span>
        </n-text>
      </n-space>
    </n-space>
  </n-modal>
</template>
