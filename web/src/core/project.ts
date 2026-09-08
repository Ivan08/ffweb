/**
 * The project: what is on the timeline, and what comes out of it.
 *
 * This replaces the older "one selected operation plus a stack of filters"
 * model, in which the same operation could be both selected and stacked, and in
 * which choosing a multi-input operation silently threw the stack away. Here
 * there is one description of the work and every part of it has one home.
 *
 * The division that makes the rest of the code simple: **clip properties change
 * time, effects do not**. Speed, reversal and looping belong to a clip; crop,
 * scale and colour belong to the effect chain. That is why an overlay can name
 * a plain `from`/`to` in seconds — the timeline those seconds refer to is the
 * one the user is looking at, and no effect can move it underneath them.
 */

import { DEFAULT_QUALITY, type Quality } from './containers'
import { clamp } from './geometry'
import type { OpId, Params } from './ops'
import type { MediaFile } from './types'

/** Effects are per-frame, video-only, and leave the length alone. */
export type EffectId = OpId

export type ExportTarget = 'video' | 'gif' | 'audio' | 'still'

/** One piece of source footage on the video track. */
export interface Clip {
  /** Identity within the track, so clips can be reordered and removed. */
  uid: string
  fileId: string
  /** Seconds into the source where the clip starts. */
  in: number
  /** Seconds into the source where it ends. */
  out: number
  /** 1 is untouched; 2 plays twice as fast. */
  speed: number
  reverse: boolean
  /** Play forwards then backwards, which doubles the length. */
  boomerang: boolean
  /** How many times the clip plays; 1 is once. */
  loop: number
}

/**
 * The sound that came with the footage, and what is done to the finished mix.
 *
 * Added sounds are not here: they are a list, because there is no reason to be
 * able to lay down one and not two. "Replace the soundtrack" is this set to
 * `none` with one sound added, and "add music from 0:05" is this left alone
 * with the same — which is why the two no longer need a flag to tell them
 * apart.
 */
export interface AudioTrack {
  source: 'clips' | 'none'
  /** Decibels applied to the whole mix; 0 leaves the level alone. */
  gain: number
  normalize: boolean
}

/** A sound laid onto the timeline at a moment of its own. */
export interface Sound {
  uid: string
  fileId: string
  /** Where it starts on the timeline, in seconds. */
  at: number
  /** The part of the file to use. */
  in: number
  out: number
  /** Decibels for this sound alone. */
  gain: number
}

/**
 * Something drawn on top for part of the timeline: a picture, a clip, or a
 * line of text.
 *
 * Text is here rather than on a track of its own because it answers the same
 * question — what is on screen, and when — and putting it anywhere else would
 * mean two places to ask it.
 */
export interface Overlay {
  uid: string
  /** Set when the overlay is a file laid over the picture. */
  fileId?: string
  /** Set when the overlay is a line of text drawn onto the picture. */
  text?: string
  /** Text height as a fraction of the frame's, so it survives a resize. */
  fontSize: number
  /** `#rrggbb`. */
  colour: string
  /** A dark plate behind the text, for when the footage is busy. */
  box: boolean
  /** Top-left corner as a fraction of the frame, so it survives a resize. */
  x: number
  y: number
  /** Width as a fraction of the frame width; files only. */
  scale: number
  /** 0..1. */
  opacity: number
  /** Seconds on the timeline. */
  from: number
  to: number
}

export interface Subtitles {
  fileId: string
  /** `soft` muxes a selectable track; `burn` paints it into the picture. */
  mode: 'soft' | 'burn'
  fontSize: number
}

/** One entry in the effect chain. */
export interface EffectItem {
  uid: string
  op: EffectId
  params: Params
  enabled: boolean
}

export interface Project {
  clips: Clip[]
  /** `sequence` plays the clips one after another; `side-by-side` stacks them. */
  layout: 'sequence' | 'side-by-side'
  stackDirection: 'horizontal' | 'vertical'
  audio: AudioTrack
  /** Sounds laid on top of, or instead of, the footage's own. */
  sounds: Sound[]
  overlays: Overlay[]
  subtitles: Subtitles | null
  effects: EffectItem[]
  /** Seconds of fade at each end of the finished timeline. */
  fadeIn: number
  fadeOut: number
  target: ExportTarget
  container: string
  quality: Quality
  stripMeta: boolean
  /** Which frame the `still` target grabs, in seconds on the timeline. */
  still: number
  /** Set when the user has named the result by hand. */
  name?: string
}

export function emptyAudioTrack(): AudioTrack {
  return { source: 'clips', gain: 0, normalize: false }
}

export function soundOf(uid: string, file: MediaFile, at = 0): Sound {
  return { uid, fileId: file.id, at, in: 0, out: file.info?.duration ?? 0, gain: 0 }
}

/** How long a sound occupies the timeline. */
export function soundLength(sound: Sound): number {
  return Math.max(0, sound.out - sound.in)
}

export function emptyProject(): Project {
  return {
    clips: [],
    layout: 'sequence',
    stackDirection: 'horizontal',
    audio: emptyAudioTrack(),
    sounds: [],
    overlays: [],
    subtitles: null,
    effects: [],
    fadeIn: 0,
    fadeOut: 0,
    target: 'video',
    container: 'mp4',
    quality: { ...DEFAULT_QUALITY },
    stripMeta: false,
    still: 0,
  }
}

/** A clip covering the whole of a file. */
export function clipOf(uid: string, file: MediaFile): Clip {
  return {
    uid,
    fileId: file.id,
    in: 0,
    out: isStill(file) ? STILL_SECONDS : (file.info?.duration ?? 0),
    speed: 1,
    reverse: false,
    boomerang: false,
    loop: 1,
  }
}

export function fileOf(files: MediaFile[], id: string | undefined): MediaFile | undefined {
  return id ? files.find((file) => file.id === id) : undefined
}

/** How much of the source a clip uses, before speed and repetition. */
export function sourceLength(clip: Clip): number {
  return Math.max(0, clip.out - clip.in)
}

/** How long the clip occupies on the timeline, once it is played. */
export function clipDuration(clip: Clip): number {
  const speed = clip.speed > 0 ? clip.speed : 1
  const once = sourceLength(clip) / speed
  const repeats = Math.max(1, Math.floor(clip.loop))
  return once * (clip.boomerang ? 2 : 1) * repeats
}

/** How long the finished result runs. */
export function timelineDuration(project: Project): number {
  const lengths = project.clips.map(clipDuration)
  if (lengths.length === 0) return 0
  // Side by side plays the clips together, so the longest one decides.
  return project.layout === 'sequence'
    ? lengths.reduce((total, length) => total + length, 0)
    : Math.max(...lengths)
}

/**
 * Where the last thing on the timeline finishes, picture or not.
 *
 * A soundtrack laid down at five seconds and running for ninety does not make
 * the result ninety seconds long — the picture decides that, and the rest is
 * cut. But it is *on* the timeline, and a track that stopped drawing at the end
 * of the picture hid the very thing the user had just added.
 */
export function contentEnd(project: Project): number {
  let end = timelineDuration(project)
  for (const sound of project.sounds) end = Math.max(end, sound.at + soundLength(sound))
  for (const overlay of project.overlays) end = Math.max(end, overlay.to)
  return end
}

/** Where a clip begins on the timeline. */
export function clipStart(project: Project, uid: string): number {
  if (project.layout !== 'sequence') return 0
  let offset = 0
  for (const clip of project.clips) {
    if (clip.uid === uid) return offset
    offset += clipDuration(clip)
  }
  return offset
}

export function moveClip(clips: Clip[], uid: string, delta: number): Clip[] {
  const index = clips.findIndex((clip) => clip.uid === uid)
  if (index < 0) return clips
  const target = index + delta
  if (target < 0 || target >= clips.length) return clips
  const next = [...clips]
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved)
  return next
}

/**
 * Keep an overlay's window inside the timeline and the right way round.
 *
 * A zero-length window would produce `enable='between(t,4,4)'`, which ffmpeg
 * accepts and which shows nothing at all — a silent way to lose a logo.
 */
export function clampOverlay(overlay: Overlay, duration: number): Overlay {
  const limit = Math.max(0, duration)
  const from = clamp(overlay.from, 0, limit)
  const to = clamp(overlay.to, from, limit)
  return { ...overlay, from, to }
}

const OVERLAY_DEFAULTS = {
  fontSize: 0.08,
  colour: '#ffffff',
  box: true,
  scale: 0.25,
  opacity: 1,
} as const

/**
 * A file laid over the picture, for as long as it has to give.
 *
 * A clip's window is its own length, not the whole timeline: laying a
 * four-second clip on an eight-second one and having it claim all eight said it
 * would be there when it has nothing left to show. A still has no length of its
 * own, so it takes what it is given.
 */
export function fileOverlay(uid: string, file: MediaFile, timeline: number): Overlay {
  const own = isStill(file) ? Infinity : (file.info?.duration ?? Infinity)
  const to = Math.max(0, Math.min(timeline, own))
  return { ...OVERLAY_DEFAULTS, uid, fileId: file.id, x: 0.05, y: 0.05, from: 0, to }
}

export function textOverlay(uid: string, text: string, duration: number): Overlay {
  // Centred near the bottom, where a caption belongs and where it is least
  // likely to sit on top of the subject.
  return { ...OVERLAY_DEFAULTS, uid, text, x: 0.5, y: 0.85, from: 0, to: Math.max(0, duration) }
}

/**
 * How long a still image runs when it is put on the video track.
 *
 * A picture has no duration of its own, so without a default a title card
 * placed between two clips would be zero seconds long — on the timeline, in the
 * command, and in the result.
 */
export const STILL_SECONDS = 4

/** A file with a picture but no running time is a still image. */
export function isStill(file: MediaFile): boolean {
  const info = file.info
  if (info) return info.has_video && !info.has_audio && (info.duration ?? 0) <= 0.05
  return /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(file.name)
}

/** Whether anything on the timeline has a picture to work on. */
export function hasPicture(project: Project, files: MediaFile[]): boolean {
  return project.clips.some((clip) => {
    const info = fileOf(files, clip.fileId)?.info
    return info ? info.has_video : true
  })
}

/**
 * Whether the project is simple enough to skip `-filter_complex` entirely.
 *
 * One clip played straight, with its own sound and nothing on top, is the
 * common case and deserves the command it always had: a fast seek, a flat
 * `-vf` chain, and the chance of a stream copy. Everything that would need a
 * labelled graph is listed here, so adding a track cannot quietly leave this
 * predicate behind.
 */
export function isTrivial(project: Project): boolean {
  if (project.clips.length !== 1) return false
  if (project.overlays.length > 0) return false
  if (project.subtitles !== null) return false
  if (project.fadeIn > 0 || project.fadeOut > 0) return false

  const [clip] = project.clips
  if (clip.speed !== 1 || clip.reverse || clip.boomerang || Math.floor(clip.loop) !== 1) return false

  if (project.sounds.length > 0) return false
  const { audio } = project
  if (audio.source !== 'clips') return false
  return audio.gain === 0 && !audio.normalize
}

/**
 * Every file the project needs, and which `-i` each one became.
 *
 * The graph refers to inputs by number (`[2:v]`), so the numbering and the
 * input list have to be decided in one place or they drift apart. A file that
 * cannot be resolved is dropped from both at once — and reported, because
 * silently renumbering the inputs around a missing file would point half the
 * graph at the wrong footage.
 */
export interface ResolvedInputs {
  /** In placeholder order: index `n` is `@in{n}`. */
  files: MediaFile[]
  clips: Map<string, number>
  overlays: Map<string, number>
  sounds: Map<string, number>
  subtitles?: number
  /** Parts whose file is gone, named so the interface can say so. */
  missing: string[]
}

export function resolveInputs(project: Project, files: MediaFile[]): ResolvedInputs {
  const resolved: ResolvedInputs = {
    files: [],
    clips: new Map(),
    overlays: new Map(),
    sounds: new Map(),
    missing: [],
  }

  const add = (id: string | undefined, what: string): number | undefined => {
    const file = fileOf(files, id)
    if (!file) {
      resolved.missing.push(what)
      return undefined
    }
    resolved.files.push(file)
    return resolved.files.length - 1
  }

  for (const clip of project.clips) {
    const index = add(clip.fileId, 'clip')
    if (index !== undefined) resolved.clips.set(clip.uid, index)
  }
  for (const sound of project.sounds) {
    const index = add(sound.fileId, 'sound')
    if (index !== undefined) resolved.sounds.set(sound.uid, index)
  }
  for (const overlay of project.overlays) {
    // A caption is drawn onto the picture, so it costs no input at all.
    if (overlay.text !== undefined) continue
    const index = add(overlay.fileId, 'overlay')
    if (index !== undefined) resolved.overlays.set(overlay.uid, index)
  }
  if (project.subtitles) resolved.subtitles = add(project.subtitles.fileId, 'subtitles')

  return resolved
}
