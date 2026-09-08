/**
 * The native engine: the local ffmpeg binary, driven through the ffweb server.
 *
 * Files are never copied — the server resolves the placeholders to the paths
 * the files already occupy on disk and hands them straight to ffmpeg.
 */

import { api, subscribeToJob } from '../api/client'
import { baseName } from '../core/format'
import type { Engine, RunCallbacks, RunHandle, RunRequest } from './types'
import { CanceledError } from './types'

export const nativeEngine: Engine = {
  id: 'native',

  async prepare() {
    // Nothing to load: the binary is already on the machine.
  },

  run(request: RunRequest, callbacks: RunCallbacks): RunHandle {
    let cancel = () => {}

    const done = (async () => {
      const job = await api.createJob({
        inputs: request.inputs.map((file) => file.path),
        args: request.args,
        output: request.outputName,
        duration: request.duration,
        label: request.label,
      })

      let unsubscribe = () => {}
      let canceled = false
      cancel = () => {
        canceled = true
        void api.cancelJob(job.id).catch(() => {
          // The job may already have finished; nothing to report.
        })
      }

      let lastSize: number | undefined
      await new Promise<void>((resolve, reject) => {
        unsubscribe = subscribeToJob(
          job.id,
          (event) => {
            if (event.type === 'log' && event.line) {
              callbacks.onLog(event.line)
            } else if (event.type === 'progress') {
              callbacks.onProgress({
                progress: event.progress ?? 0,
                outTime: event.out_time ?? undefined,
                speed: event.speed ?? undefined,
                fps: event.fps ?? undefined,
                size: event.size ?? undefined,
              })
              if (typeof event.size === 'number') lastSize = event.size
            } else if (event.type === 'state') {
              if (event.state === 'done') resolve()
              else if (event.state === 'canceled') reject(new CanceledError())
              else if (event.state === 'failed') reject(new Error(event.error ?? 'ffmpeg failed'))
            }
          },
          (error) => {
            if (!canceled) reject(error)
          },
        )
      }).finally(() => unsubscribe())

      // The size reported during encoding is the muxer's running total; the
      // final figure comes from the file itself.
      const finished = await api.job(job.id).catch(() => null)
      return { path: job.output, name: baseName(job.output), size: finished?.output_size ?? lastSize }
    })()

    return {
      done,
      cancel: () => cancel(),
    }
  },
}
