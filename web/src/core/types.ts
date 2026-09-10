/** Shapes shared by the API client, the stores and the command builder. */

export interface NativeCapabilities {
  available: boolean
  ffprobe: boolean
  path: string | null
  version: string | null
  versionNumber: string | null
  encoders: string[]
  decoders: string[]
  filters: string[]
  muxers: string[]
  hwaccels: string[]
}

export interface WasmCacheStatus {
  dir: string
  version: string
  offline: boolean
  st_ready: boolean
  mt_ready: boolean
  bytes: number
  missing: string[]
}

export interface Capabilities {
  version: string
  backend: EngineId
  backendLocked: boolean
  native: NativeCapabilities
  wasm: { coreVersion: string; cache: WasmCacheStatus }
  roots: { browse: string; out: string }
  preload: string[]
  unsafeArgs: boolean
}

export type EngineId = 'native' | 'wasm'

export interface FsEntry {
  name: string
  path: string
  is_dir: boolean
  size: number
  modified: number
  is_media: boolean
}

export interface FsListing {
  path: string
  parent: string | null
  entries: FsEntry[]
}

export interface MediaInfo {
  duration: number | null
  size: number | null
  bit_rate: number | null
  format_name: string | null
  width: number | null
  height: number | null
  fps: number | null
  video_codec: string | null
  audio_codec: string | null
  has_video: boolean
  has_audio: boolean
  raw: unknown
}

/** A file the user has picked, plus whatever we know about it. */
export interface MediaFile {
  /** Stable client-side id. */
  id: string
  /** Absolute path on disk, or the name only for browser-held files. */
  path: string
  name: string
  size: number
  /** Present when the file came from a drop and still lives in the browser. */
  blob?: File
  info?: MediaInfo
  /** Set when probing failed, so the UI can explain why. */
  infoError?: string
}

/** How loud a file is over time: one magnitude per slice, 0 to 1. */
export interface Peaks {
  duration: number
  from: number
  peaks: number[]
}

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'canceled'

export interface Job {
  id: string
  label: string
  state: JobState
  progress: number
  engine: EngineId
  /** Argument list as executed, without the server's own prefix. */
  command: string[]
  inputName: string
  outputName: string
  /** Where the result lives: a path for native, an object URL for wasm. */
  outputPath?: string
  outputUrl?: string
  outputSize?: number
  duration?: number
  outTime?: number
  speed?: number
  fps?: number
  error?: string
  log: LogLine[]
  createdAt: number
  finishedAt?: number
}

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogLine {
  level: LogLevel
  text: string
}

export interface JobEventMessage {
  type: 'log' | 'progress' | 'state'
  line?: string
  progress?: number
  out_time?: number | null
  speed?: number | null
  fps?: number | null
  frame?: number | null
  size?: number | null
  state?: JobState
  error?: string | null
}
