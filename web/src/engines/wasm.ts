/**
 * The wasm engine: ffmpeg compiled to WebAssembly, running in a worker.
 *
 * Everything it loads is served same-origin by the ffweb process from its own
 * cache, so there is no CDN in the picture at run time and the core is
 * downloaded exactly once per machine.
 */

import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'
// Vite bundles the library's own worker and emits it as a same-origin asset.
// Browsers refuse to start a cross-origin module worker even when CORS allows
// the fetch, which is the wall the original CDN-based tool ran into. Importing
// the file through the `?worker&url` query also keeps its ambient
// `/// <reference lib="webworker" />` out of the app's TypeScript program,
// where it would replace the DOM globals.
import classWorkerURL from '@ffmpeg/ffmpeg/worker?worker&url'

import { api } from '../api/client'
import { extensionOf } from '../core/format'
import { toNames } from '../core/placeholders'
import type { MediaFile } from '../core/types'
import type { Engine, RunCallbacks, RunHandle, RunRequest } from './types'
import { CanceledError } from './types'

/**
 * Which core build to load.
 *
 * The single-threaded core is the default even though the page is
 * cross-origin-isolated and `SharedArrayBuffer` is available. The published
 * multi-threaded build of 0.12.10 stalls after "Stream mapping" on ordinary
 * jobs and never returns, so it is opt-in via `?core=mt` rather than something
 * a user can stumble into. The tool this replaces shipped the single-threaded
 * core for the same reason.
 */
function preferredVariant(): 'mt' | 'st' {
  const forced = new URLSearchParams(window.location.search).get('core')
  if (forced === 'st' || forced === 'mt') return forced
  return 'st'
}

let instance: FFmpeg | null = null
let loaded = false

function reset() {
  instance = null
  loaded = false
}

async function ensureLoaded(onProgress?: (message: string) => void): Promise<FFmpeg> {
  if (instance && loaded) return instance

  const variant = preferredVariant()
  onProgress?.(`loading the ${variant === 'mt' ? 'multi-threaded' : 'single-threaded'} core`)

  // Make sure the server has the files before the worker asks for them, so a
  // first-run download reports progress here instead of stalling silently.
  const status = await api.wasmStatus()
  const ready = variant === 'mt' ? status.mt_ready : status.st_ready
  if (!ready) {
    onProgress?.('downloading the ffmpeg core (~32 MB, once per machine)')
    await api.fetchWasm()
  }

  const ffmpeg = new FFmpeg()
  // Only for the duration of the load: `run` attaches its own listener, and
  // leaving this one on would double every line in the job log.
  const loadLogger = ({ message }: { message: string }) => {
    if (message) onProgress?.(message)
  }
  ffmpeg.on('log', loadLogger)

  await ffmpeg.load({
    classWorkerURL,
    coreURL: `/wasm/${variant}/ffmpeg-core.js`,
    wasmURL: `/wasm/${variant}/ffmpeg-core.wasm`,
    ...(variant === 'mt' ? { workerURL: `/wasm/${variant}/ffmpeg-core.worker.js` } : {}),
  })

  ffmpeg.off('log', loadLogger)
  instance = ffmpeg
  loaded = true
  return ffmpeg
}

/** Read a file into the wasm filesystem, wherever it currently lives. */
async function readInput(file: MediaFile): Promise<Uint8Array> {
  if (file.blob) return new Uint8Array(await file.blob.arrayBuffer())
  return fetchFile(api.fileUrl(file.path))
}

export const wasmEngine: Engine = {
  id: 'wasm',

  async prepare(onProgress) {
    await ensureLoaded(onProgress)
  },

  run(request: RunRequest, callbacks: RunCallbacks): RunHandle {
    let canceled = false
    let cancel = () => {
      canceled = true
    }

    const done = (async () => {
      const ffmpeg = await ensureLoaded(callbacks.onLog)
      if (canceled) throw new CanceledError()

      cancel = () => {
        canceled = true
        // There is no way to interrupt a running encode from outside, so the
        // whole worker goes; the next run rebuilds it.
        ffmpeg.terminate()
        reset()
      }

      // Map the placeholders onto names inside the wasm filesystem.
      const names = request.inputs.map((file, index) => `in${index}.${extensionOf(file.name) || 'bin'}`)
      const outputName = request.outputName
      const args = toNames(request.args, names, outputName)

      const logHandler = ({ message }: { message: string }) => callbacks.onLog(message)
      const progressHandler = ({ progress, time }: { progress: number; time: number }) => {
        callbacks.onProgress({
          // ffmpeg.wasm reports a fraction that can overshoot slightly on the
          // final frame; the UI expects it clamped.
          progress: Math.max(0, Math.min(1, progress)),
          outTime: time / 1_000_000,
        })
      }

      ffmpeg.on('log', logHandler)
      ffmpeg.on('progress', progressHandler)

      // Keep the screen awake: a long encode that stops when the display sleeps
      // is the single most common way a browser-side run gets lost.
      const wakeLock = await requestWakeLock()

      try {
        for (let i = 0; i < request.inputs.length; i += 1) {
          callbacks.onLog(`loading ${request.inputs[i].name}`)
          await ffmpeg.writeFile(names[i], await readInput(request.inputs[i]))
          if (canceled) throw new CanceledError()
        }

        callbacks.onLog(`ffmpeg ${args.join(' ')}`)
        const code = await ffmpeg.exec(args)
        if (canceled) throw new CanceledError()
        if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`)

        const data = await ffmpeg.readFile(outputName)
        const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data)
        const blob = new Blob([bytes as BlobPart], { type: mimeFor(outputName) })

        return { url: URL.createObjectURL(blob), size: blob.size }
      } finally {
        wakeLock?.release().catch(() => {})
        if (loaded && instance === ffmpeg) {
          ffmpeg.off('log', logHandler)
          ffmpeg.off('progress', progressHandler)
          // Free the virtual filesystem; a few large files fill the wasm heap
          // and the next run fails with an unhelpful out-of-memory error.
          for (const name of [...names, outputName]) {
            await ffmpeg.deleteFile(name).catch(() => {})
          }
        }
      }
    })()

    return { done, cancel: () => cancel() }
  },
}

async function requestWakeLock(): Promise<WakeLockSentinel | null> {
  try {
    return await navigator.wakeLock?.request('screen')
  } catch {
    // Denied, unsupported, or the tab is hidden: not worth reporting.
    return null
  }
}

const MIME_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  gif: 'image/gif',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  flac: 'audio/flac',
  opus: 'audio/ogg',
  ogg: 'audio/ogg',
}

function mimeFor(name: string): string {
  return MIME_TYPES[extensionOf(name)] ?? 'application/octet-stream'
}
