/**
 * The operation model.
 *
 * Every operation knows how to turn its parameters into ffmpeg arguments, and
 * this is the only place that knowledge lives: the native engine and the wasm
 * engine both execute the argument list produced here, so the two can never
 * drift apart. It is also what the command bar displays.
 */

import type { EngineId, MediaInfo } from './types'

/**
 * Effects are the only operations left: everything else became a track on the
 * timeline or a choice in the export dialog.
 */
export type OpId =
  | 'resizecompress'
  | 'crop'
  | 'rotate'
  | 'adjust'
  | 'denoise'
  | 'sharpenblur'
  | 'pad'

export type OpGroup = 'convert' | 'transform' | 'look' | 'audio' | 'compose' | 'extract' | 'advanced'

export type ParamValue = string | number | boolean

export type Params = Record<string, ParamValue>

export interface SelectOption {
  value: string
  /** Shown as-is when there is no translation for it (codec names, presets). */
  label?: string
}

export type ParamSpec =
  | { key: string; kind: 'select'; options: SelectOption[]; default: string }
  | {
      key: string
      kind: 'number'
      min?: number
      max?: number
      step?: number
      unit?: string
      default: number
      placeholder?: string
    }
  | { key: string; kind: 'slider'; min: number; max: number; step: number; unit?: string; default: number }
  | { key: string; kind: 'toggle'; default: boolean }
  | { key: string; kind: 'text'; default: string; multiline?: boolean; placeholder?: string }
  /** Picks a second file from the queue: overlays, concat, subtitle tracks. */
  | { key: string; kind: 'input'; default: string }

/** Filter fragments an operation contributes to the shared chain. */
export interface FilterFragments {
  video?: string[]
  audio?: string[]
}

export interface BuildContext {
  /** Metadata of the primary input, when it could be probed. */
  source?: MediaInfo
  /** Output container extension chosen in the Output panel. */
  container: string
  /** Which engine will run this, so operations can avoid what wasm cannot do. */
  engine: EngineId
  /** Effective duration after trimming, used by time-dependent filters. */
  duration?: number
  /** Number of input files bound to the job. */
  inputCount: number
  /**
   * Filter fragments contributed by the stack. Terminal operations that build
   * their own graph fold these in themselves, so stacking still works with a
   * GIF export or a thumbnail.
   */
  stackVideo?: string[]
  stackAudio?: string[]
}

/** What a terminal operation contributes to the command. */
export interface OpBuild {
  /** Arguments placed before the first `-i`, e.g. `-stream_loop`. */
  pre?: string[]
  /** Arguments placed after the inputs and before the output. */
  args: string[]
  /** Overrides the output extension. */
  ext?: string
  /** Set when the operation already emits its own filter arguments. */
  ownsFilters?: boolean
  /** Set when the operation must not receive the global codec settings. */
  ownsCodecs?: boolean
  /**
   * Set when the operation drops the audio. The container would otherwise add
   * an audio codec next to the `-an` that removes the stream.
   */
  dropsAudio?: boolean
}

export interface OpDef {
  id: OpId
  group: OpGroup
  /** Name of a lucide-react icon. */
  icon: string
  /** Chainable operations stack into one filter graph and one re-encode. */
  chainable: boolean
  /** Whether the operation makes sense applied to a whole selection of files. */
  batchable: boolean
  /** Additional input files this operation needs beyond the primary one. */
  extraInputs: number
  /**
   * Set when the operation works on everything selected rather than on one
   * named second file. Joining is the case: picking files one at a time from a
   * dropdown does not scale past two, and the selection is already ordered.
   */
  usesSelection?: boolean
  params: ParamSpec[]
  /** ffmpeg components the operation cannot work without. */
  requires?: { encoders?: string[]; filters?: string[] }
  /** Chainable operations describe themselves as filter fragments. */
  filters?: (p: Params, ctx: BuildContext) => FilterFragments
  /** Terminal operations build the command themselves. */
  build?: (p: Params, ctx: BuildContext) => OpBuild
  /**
   * Whether a terminal operation folds the filter stack into its own graph.
   * Multi-input operations build a labelled graph that the stack cannot join,
   * so the UI says so instead of silently dropping the filters.
   */
  acceptsStack?: boolean
  /**
   * What the operation produces, when it is not simply whatever container was
   * chosen. Muting a clip into an mp3 would leave nothing at all, so the
   * output panel does not offer the combination and the builder will not make
   * it either.
   */
  outputs?: 'video' | 'audio' | 'image'
  /** True when the operation only inspects the file and runs nothing. */
  inspectOnly?: boolean
}

export function defaultParams(op: OpDef): Params {
  const params: Params = {}
  for (const spec of op.params) params[spec.key] = spec.default
  return params
}

/** Read a parameter as a number, falling back when the field is empty. */
export function num(params: Params, key: string, fallback = 0): number {
  const value = params[key]
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

export function str(params: Params, key: string, fallback = ''): string {
  const value = params[key]
  return value === undefined || value === null ? fallback : String(value)
}

export function bool(params: Params, key: string, fallback = false): boolean {
  const value = params[key]
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Video dimensions must be even for yuv420p encoders. `-2` tells ffmpeg to
 * derive the missing side from the aspect ratio and round it, which is why it
 * appears instead of `-1` throughout.
 */
export function evenOrAuto(value: number): string {
  if (!value || value <= 0) return '-2'
  return String(Math.max(2, Math.round(value / 2) * 2))
}
