const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { fetchWithTimeout, DEFAULT_TIMEOUT_MS } = require('./fetch-with-timeout')
const { logger } = require('./logger')

const flacLogger = logger.child('FlacMetadataWriter')

const FLAC_TAG_TIMEOUT_MS = 2 * 60 * 1000 // 2 minutes for FLAC tag writing
const MODULE_LOAD_TIMEOUT_MS = 30 * 1000

class FlacMetadataWriter {
  async getModule() {
    flacLogger.debug(`Loading flac-tagger module`)
    const startTime = Date.now()

    const loadPromise = import('flac-tagger')
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`flac-tagger module load timed out after ${MODULE_LOAD_TIMEOUT_MS}ms`))
      }, MODULE_LOAD_TIMEOUT_MS)
    })

    try {
      const module = await Promise.race([loadPromise, timeoutPromise])
      flacLogger.debug(`flac-tagger module loaded`, { elapsedMs: Date.now() - startTime })
      return module
    } catch (err) {
      flacLogger.error(`Failed to load flac-tagger module`, {
        error: err?.message,
        elapsedMs: Date.now() - startTime,
      })
      throw err
    }
  }

  createTempFilePath() {
    const fileName = `pop-downloader-${crypto.randomUUID()}.flac`
    const p = path.join(os.tmpdir(), fileName)
    flacLogger.debug(`Created temp FLAC path`, { tempPath: p })
    return p
  }

  toTagValue(value) {
    if (Array.isArray(value)) {
      const list = value
        .map((item) => String(item || '').trim())
        .filter(Boolean)

      return list.length > 0 ? list : null
    }

    const normalized = String(value || '').trim()
    return normalized ? normalized : null
  }

  buildTagMap(metadata = {}) {
    const tagMap = {}

    const entries = {
      TITLE: metadata.title,
      ARTIST: metadata.artist,
      ALBUM: metadata.album,
      ALBUMARTIST: metadata.albumArtist,
      DATE: metadata.date,
      YEAR: metadata.year,
      GENRE: metadata.genre,
      COMPOSER: metadata.composer,
      LYRICIST: metadata.lyricist,
      COMMENT: metadata.comment,
      TRACKNUMBER: metadata.trackNumber,
      DISCNUMBER: metadata.discNumber,
    }

    for (const [key, value] of Object.entries(entries)) {
      const normalizedValue = this.toTagValue(value)

      if (normalizedValue) {
        tagMap[key] = normalizedValue
      }
    }

    flacLogger.debug(`Built FLAC tag map`, {
      tags: Object.keys(tagMap),
      title: metadata?.title ? String(metadata.title).slice(0, 80) : '',
    })

    return tagMap
  }

  async writeBufferTags({ flacBuffer, metadata = {}, coverBuffer = null, coverMime = null }) {
    if (!Buffer.isBuffer(flacBuffer) || flacBuffer.length === 0) {
      throw new Error('flacBuffer must be a non-empty Buffer.')
    }

    const startTime = Date.now()
    flacLogger.info(`Writing FLAC buffer tags`, {
      inputSize: flacBuffer.length,
      hasCover: Boolean(coverBuffer && coverBuffer.length > 0),
      coverSize: coverBuffer?.length || 0,
    })

    const { writeFlacTags } = await this.getModule()
    const filePath = this.createTempFilePath()

    const workPromise = (async () => {
      try {
        await fs.writeFile(filePath, flacBuffer)
        flacLogger.debug(`FLAC temp file written`, {
          filePath,
          size: flacBuffer.length,
          writeMs: Date.now() - startTime,
        })

        const tagMap = this.buildTagMap(metadata)
        const tags = { tagMap }

        if (Buffer.isBuffer(coverBuffer) && coverBuffer.length > 0) {
          tags.picture = {
            buffer: coverBuffer,
            mime: coverMime || undefined,
          }
        }

        const tagStart = Date.now()
        await writeFlacTags(tags, filePath)
        flacLogger.debug(`FLAC tags written via flac-tagger`, {
          tagWriteMs: Date.now() - tagStart,
        })

        const readStart = Date.now()
        const resultBuffer = await fs.readFile(filePath)
        flacLogger.debug(`Tagged FLAC read back`, {
          readMs: Date.now() - readStart,
          outputSize: resultBuffer.length,
        })
        return resultBuffer
      } finally {
        await fs.rm(filePath, { force: true }).catch((rmErr) => {
          flacLogger.warn(`Failed to remove temp FLAC file`, {
            filePath,
            error: rmErr?.message,
          })
        })
      }
    })()

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        const err = new Error(`FLAC tag writing timed out after ${FLAC_TAG_TIMEOUT_MS}ms`)
        err.name = 'FlacTagTimeoutError'
        reject(err)
      }, FLAC_TAG_TIMEOUT_MS)
    })

    try {
      const result = await Promise.race([workPromise, timeoutPromise])
      flacLogger.info(`FLAC tag write complete`, {
        outputSize: result.length,
        totalMs: Date.now() - startTime,
      })
      return result
    } catch (err) {
      flacLogger.error(`FLAC tag write failed`, {
        error: err?.message,
        errorName: err?.name,
        totalMs: Date.now() - startTime,
        stack: err?.stack?.slice(0, 500),
      })
      throw err
    }
  }

  async fetchCoverBuffer(imageUrl) {
    if (!imageUrl) {
      return null
    }

    const startTime = Date.now()
    flacLogger.debug(`Fetching FLAC cover`, {
      urlPreview: String(imageUrl).slice(0, 120) + '...',
    })

    const response = await fetchWithTimeout(imageUrl, {}, DEFAULT_TIMEOUT_MS)
    if (!response.ok) {
      flacLogger.warn(`Cover fetch non-200`, {
        status: response.status,
        elapsedMs: Date.now() - startTime,
      })
      throw new Error(`Failed to fetch FLAC cover: ${response.status}`)
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    const mime = response.headers.get('content-type') || undefined

    flacLogger.debug(`Cover fetched`, {
      size: buffer.length,
      mime,
      elapsedMs: Date.now() - startTime,
    })

    return {
      buffer,
      mime,
    }
  }
}

module.exports = {
  FlacMetadataWriter,
}
