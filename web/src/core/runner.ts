/**
 * Driving one job from start to finish.
 *
 * This is the sequence a run goes through — prepare the engine, stream the log
 * and the progress, end in exactly one of done, cancelled or failed — which is
 * logic, not state. The store owns where the results are put; this owns what
 * happens and in what order.
 */

import { CanceledError, type Engine } from '../engines/types'
import type { Job, LogLine, MediaFile } from './types'

/** How much of a long encode's log is worth keeping: the tail is what is read. */
const LOG_LIMIT = 1000

export interface RunRequest {
  engine: Engine
  inputs: MediaFile[]
  args: string[]
  outputName: string
  duration?: number
}

export interface RunReporter {
  /** Change some fields of the job being run. */
  patch: (patch: Partial<Job>) => void
  /** One line of ffmpeg's output. */
  log: (line: LogLine) => void
  /**
   * The browser engine has to fetch and instantiate a 32 MB core before it can
   * start, which is worth saying out loud; null clears the message.
   */
  preparing: (message: string | null) => void
  /** Hand back a way to stop the run, for as long as it is running. */
  cancellable: (cancel: () => void) => void
  /** Something went wrong in a way the user should be told about. */
  failed: (message: string) => void
}

/** Grow a bounded log tail. */
export function appendLine(log: LogLine[], line: LogLine): LogLine[] {
  return [...log, line].slice(-LOG_LIMIT)
}

/**
 * Run a job, reporting everything through `report`.
 *
 * Never throws: a run ends in a state, and the state is the report.
 */
export async function runJob(
  request: RunRequest,
  classify: (line: string) => LogLine,
  report: RunReporter,
): Promise<void> {
  const { engine, inputs, args, outputName, duration } = request
  const log = (line: string) => report.log(classify(line))

  try {
    report.patch({ state: 'running' })

    if (engine.id === 'wasm') {
      report.preparing('preparing')
      await engine.prepare(log)
      report.preparing(null)
    }

    const handle = engine.run(
      { args, inputs, outputName, duration, label: outputName },
      {
        onLog: log,
        onProgress: (progress) =>
          report.patch({
            progress: progress.progress,
            outTime: progress.outTime,
            speed: progress.speed,
            fps: progress.fps,
          }),
      },
    )
    report.cancellable(handle.cancel)

    const result = await handle.done
    report.patch({
      state: 'done',
      progress: 1,
      // The engine has the last word on the name: the server may have chosen a
      // different one rather than overwrite an existing file.
      ...(result.name ? { outputName: result.name, label: result.name } : {}),
      outputPath: result.path,
      outputUrl: result.url,
      outputSize: result.size,
      finishedAt: Date.now(),
    })
  } catch (error) {
    // Cancelling is a decision, not a fault, and is not reported as one.
    if (error instanceof CanceledError) {
      report.patch({ state: 'canceled', finishedAt: Date.now() })
    } else {
      const message = (error as Error).message
      report.patch({ state: 'failed', error: message, finishedAt: Date.now() })
      report.failed(message)
    }
  } finally {
    report.preparing(null)
  }
}
