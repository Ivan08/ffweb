/** The contract both execution engines satisfy. */

import type { EngineId, MediaFile } from '../core/types'

export interface RunRequest {
  /** Placeholder-bearing argument list from the command builder. */
  args: string[]
  /** Input files in `@in0`, `@in1`, ... order. */
  inputs: MediaFile[]
  /** Output file name, extension included. */
  outputName: string
  /** Expected duration, used to turn progress into a percentage. */
  duration?: number
  label?: string
}

export interface RunHandle {
  /** Resolves when the run finishes; rejects with the failure reason. */
  done: Promise<RunResult>
  /** Ask the engine to stop. */
  cancel: () => void
}

export interface RunResult {
  /**
   * What the result ended up being called. The server picks the final name so
   * it does not overwrite a file from an earlier session, which means the name
   * the client asked for is only a request.
   */
  name?: string
  /** Absolute path, for results written to disk by the native engine. */
  path?: string
  /** Object URL, for results produced in the browser. */
  url?: string
  size?: number
}

export interface RunCallbacks {
  onLog: (line: string) => void
  onProgress: (update: { progress: number; outTime?: number; speed?: number; fps?: number; size?: number }) => void
}

export interface Engine {
  readonly id: EngineId
  /** Prepare the engine; for wasm this downloads and instantiates the core. */
  prepare: (onProgress?: (message: string) => void) => Promise<void>
  run: (request: RunRequest, callbacks: RunCallbacks) => RunHandle
}

/** Raised when the user cancels; distinguished so it is not shown as a failure. */
export class CanceledError extends Error {
  constructor() {
    super('canceled')
    this.name = 'CanceledError'
  }
}
