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
  /**
   * How this clip arrives out of the one before it. Absent is a hard cut.
   *
   * It lives on the clip that *arrives* rather than in a list of joins,
   * because a join has no identity of its own: a list running alongside the
   * clips would have to be spliced in step by every reorder, removal, addition
   * and split, and the first one to forget would apply a dissolve to the wrong
   * pair without saying so. Carried here it moves, copies and disappears with
   * the clip that owns it, and the first clip's is simply ignored.
   */
  transition?: Transition | null
}

/** How one clip gives way to the next. */
export interface Transition {
  /** Seconds of overlap with the clip before. */
  duration: number
  kind: TransitionKind
}

/**
 * The shapes a transition can take.
 *
 * A small, deliberate set out of the several dozen `xfade` offers: each one
 * has to be recognisable at a glance in a list, and a wipe is a wipe whichever
 * of eight directions it runs in.
 */
export const TRANSITIONS = ['fade', 'fadeblack', 'wipeleft', 'slideleft', 'circleopen'] as const
export type TransitionKind = (typeof TRANSITIONS)[number]

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

/**
 * A window of the workspace that reaches the result.
 *
 * The timeline is the workspace: every clip is laid out at its full length,
 * whatever anyone means to keep of it. What is *kept* is these windows, and
 * they are what the export is made of, joined in the order they are listed.
 *
 * Trimming used to be done to the clip itself, which meant the timeline showed
 * the result and everything cut away vanished from it — leaving the block
 * filling the axis again with nowhere to drag back to, so a trim could be made
 * shorter and never longer. A window has room on both sides because the
 * footage it was cut from is still drawn underneath it.
 */
export interface Range {
  uid: string
  /** Seconds on the workspace timeline. */
  from: number
  to: number
}

export interface Subtitles {
  fileId: string
  /** `soft` muxes a selectable track; `burn` paints it into the picture. */
  mode: 'soft' | 'burn'
  fontSize: number
}

/**
 * Whether a file is subtitles, judged by its name.
 *
 * There is nothing to probe: a subtitle file has no streams, so ffprobe
 * reports neither picture nor sound and it looks exactly like a file that
 * failed to open. The four extensions are the ones the server already accepts
 * as media.
 */
export function isSubtitleFile(name: string): boolean {
  return /\.(srt|vtt|ass|ssa)$/i.test(name)
}

/**
 * Whether the subtitles on this project reach the result at all.
 *
 * They do not when there is no picture to paint them onto, and they do not
 * when the container carries no subtitle track. Asking here rather than only
 * where they are emitted is what keeps a useless `-i` off the command: the
 * input list is built from this, so a subtitle file that cannot be used is
 * never opened in the first place.
 */
export function carriesSubtitles(project: Project, container?: { subtitles?: string }): boolean {
  if (!project.subtitles) return false
  if (project.target === 'audio') return false
  return project.subtitles.mode === 'burn' || container?.subtitles !== undefined
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
  /**
   * What of the workspace reaches the result, in the order it is joined.
   *
   * Empty means the whole of it, which is what an untouched project is: there
   * is nothing to say until somebody says it.
   */
  ranges: Range[]
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
    ranges: [],
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

/**
 * Seconds each clip overlaps the one before it, in clip order.
 *
 * The first never overlaps anything. Beyond that an overlap can be no longer
 * than either side has left to give: three two-second clips dissolving over
 * two seconds each would otherwise collapse the timeline to nothing, and hand
 * ffmpeg a transition starting before the clip it is transitioning from.
 *
 * This is the one place the arithmetic lives. Everything that asks where a
 * clip sits, how long the result runs, or which clip is playing goes through
 * it, so there is no second answer to keep in step.
 */
export function overlaps(clips: Clip[]): number[] {
  const result: number[] = []
  // What the clip before still has to spare, after its own overlap.
  let spare = 0
  for (const clip of clips) {
    const length = clipDuration(clip)
    const wanted = clip.transition?.duration ?? 0
    // Bounded by what the clip before has left, which for the first clip is
    // nothing — so a transition set on it is ignored without a special case.
    const overlap = Math.max(0, Math.min(wanted, spare, length))
    result.push(overlap)
    spare = length - overlap
  }
  return result
}

/** How long the finished result runs. */
export function timelineDuration(project: Project): number {
  if (project.clips.length === 0) return 0
  const lengths = project.clips.map(clipDuration)
  // Side by side plays the clips together, so the longest one decides — and a
  // transition means nothing when nothing follows anything.
  if (project.layout !== 'sequence') return Math.max(...lengths)

  const gaps = overlaps(project.clips)
  return lengths.reduce((total, length, index) => total + length - gaps[index], 0)
}

/**
 * Where a moment on a clip's block falls inside the file it came from.
 *
 * A reversed clip runs the other way: the first frame on the timeline is the
 * *last* frame of the part being used, so the walk starts at `out` and counts
 * down. Getting this backwards reads the wrong end of the file.
 */
export function sourceAt(clip: Clip, offsetIntoBlock: number): number {
  const speed = clip.speed > 0 ? clip.speed : 1
  const travelled = offsetIntoBlock * speed
  return clip.reverse ? clip.out - travelled : clip.in + travelled
}

/**
 * A piece of one clip that reaches the result.
 *
 * Where a window falls across the join between two clips, it yields one piece
 * of each: that is what "a single range across two files" means, and it is
 * why the export is built from pieces rather than from clips.
 */
export interface Piece {
  clip: Clip
  /** Seconds of the clip's own source. Ascending, even when reversed. */
  from: number
  to: number
}

/**
 * The windows that reach the result, tidied.
 *
 * Sorted and merged, because two windows that touch or overlap describe one
 * stretch of footage and would otherwise export it twice. Nothing is dropped
 * silently: an empty list means the whole workspace, which is what a project
 * says before anybody has marked anything.
 */
export function exportWindows(project: Project): Array<{ from: number; to: number }> {
  const whole = timelineDuration(project)
  if (project.ranges.length === 0) return whole > 0 ? [{ from: 0, to: whole }] : []

  const sorted = project.ranges
    .map((range) => ({
      from: clamp(Math.min(range.from, range.to), 0, whole),
      to: clamp(Math.max(range.from, range.to), 0, whole),
    }))
    .filter((range) => range.to - range.from > 0.001)
    .sort((left, right) => left.from - right.from)

  const merged: Array<{ from: number; to: number }> = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.from <= last.to + 0.001) last.to = Math.max(last.to, range.to)
    else merged.push({ ...range })
  }
  return merged
}

/**
 * The free stretch of workspace at a moment, or null if it is already kept.
 *
 * What "add a window here" means: from where the playhead stands to wherever
 * the next window begins, or to the end of the workspace. Marking by hand needs
 * a way in that does not depend on finding bare pixels in a thirty-pixel row.
 */
export function freeSpanAt(project: Project, seconds: number): { from: number; to: number } | null {
  const whole = timelineDuration(project)
  if (whole <= 0) return null
  const at = clamp(seconds, 0, whole)

  let to = whole
  for (const window of exportWindows(project)) {
    if (project.ranges.length === 0) return null
    if (at >= window.from - 0.001 && at <= window.to + 0.001) return null
    if (window.from > at) {
      to = Math.min(to, window.from)
      break
    }
  }
  return to - at > 0.05 ? { from: at, to } : null
}

/** How long the result runs: the windows, not the workspace they sit on. */
export function exportDuration(project: Project): number {
  return exportWindows(project).reduce((total, range) => total + (range.to - range.from), 0)
}

/**
 * The pieces the export is made of, in the order they are joined.
 *
 * A clip that repeats or plays there-and-back is taken whole or not at all: a
 * window over part of it would have to say which showing it meant, and there
 * is no honest answer. Everything else is cut where the window falls.
 */
export function exportPieces(project: Project): Piece[] {
  const pieces: Piece[] = []
  if (project.layout !== 'sequence') {
    // Side by side plays the clips together; there is no run of time to cut.
    for (const clip of project.clips) pieces.push({ clip, from: clip.in, to: clip.out })
    return pieces
  }

  const blocks = laidOut(project.clips)
  for (const window of exportWindows(project)) {
    for (const block of blocks) {
      const from = Math.max(window.from, block.start)
      const to = Math.min(window.to, block.end)
      if (to - from <= 0.001) continue

      const whole = !canSplit(block.clip)
      if (whole) {
        pieces.push({ clip: block.clip, from: block.clip.in, to: block.clip.out })
        continue
      }

      // Where those moments fall inside the file the clip came from — which
      // for a reversed clip is the other way round.
      const head = sourceAt(block.clip, from - block.start)
      const tail = sourceAt(block.clip, to - block.start)
      pieces.push({ clip: block.clip, from: Math.min(head, tail), to: Math.max(head, tail) })
    }
  }
  return pieces
}

/**
 * Where each clip sits on the workspace.
 *
 * The same walk `timeline.ts` draws with, kept here so the model can answer
 * without reaching into the interface. `layout` there calls this.
 */
export function laidOut(clips: Clip[]): Array<{ clip: Clip; start: number; end: number }> {
  const gaps = overlaps(clips)
  const placed: Array<{ clip: Clip; start: number; end: number }> = []
  let offset = 0
  clips.forEach((clip, index) => {
    offset -= gaps[index]
    const length = clipDuration(clip)
    placed.push({ clip, start: offset, end: offset + length })
    offset += length
  })
  return placed
}

/**
 * Where a moment on the workspace lands in the result.
 *
 * Everything on the timeline is placed against the workspace, because that is
 * what is on screen. The result is the windows joined, so anything after a
 * gap moves earlier by however much the gap took out. A moment inside a gap
 * lands on the join, which is where it would be seen.
 */
export function toResult(project: Project, seconds: number): number {
  let elapsed = 0
  for (const window of exportWindows(project)) {
    if (seconds < window.from) return elapsed
    if (seconds <= window.to) return elapsed + (seconds - window.from)
    elapsed += window.to - window.from
  }
  return elapsed
}

/**
 * The project as the result sees it: the pieces, laid end to end.
 *
 * Everything that builds a command works on this rather than on the workspace,
 * so the windows are accounted for once, here, and the graph goes on seeing a
 * plain run of clips. When nothing has been marked this is the project itself,
 * which is what keeps an untouched export exactly the command it always was.
 */
export function forExport(project: Project): Project {
  if (project.ranges.length === 0) return project

  const pieces = exportPieces(project)
  const seen = new Set<string>()
  const clips = pieces.map((piece, index) => {
    // Only the first piece cut from a clip keeps how that clip arrived: the
    // rest follow their own halves and there is nothing to arrive out of.
    const first = !seen.has(piece.clip.uid)
    seen.add(piece.clip.uid)
    return {
      ...piece.clip,
      uid: `${piece.clip.uid}~${index}`,
      in: piece.from,
      out: piece.to,
      transition: first ? piece.clip.transition : null,
    }
  })

  return {
    ...project,
    clips,
    ranges: [],
    still: toResult(project, project.still),
    overlays: project.overlays.map((overlay) => ({
      ...overlay,
      from: toResult(project, overlay.from),
      to: toResult(project, overlay.to),
    })),
    sounds: project.sounds.map((sound) => ({ ...sound, at: toResult(project, sound.at) })),
  }
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
  const gaps = overlaps(project.clips)
  let offset = 0
  for (const [index, clip] of project.clips.entries()) {
    offset -= gaps[index]
    if (clip.uid === uid) return offset
    offset += clipDuration(clip)
  }
  return offset
}

/**
 * Whether a clip can be cut in two at all.
 *
 * Repeats and there-and-back are properties of a whole clip: half of a clip
 * that plays three times, or half of one that plays forwards then backwards,
 * would have to show material the other half has already shown. There is no
 * honest answer, so the answer is no — said plainly, rather than by producing
 * something plausible.
 */
export function canSplit(clip: Clip): boolean {
  return Math.floor(clip.loop) <= 1 && !clip.boomerang
}

/**
 * Cut a clip in two at a moment inside it, measured in seconds of its source.
 *
 * Null when the cut would leave either half too short to be a clip, or when the
 * clip is one that cannot be cut at all.
 *
 * A reversed clip hands its halves over the other way round: the part playing
 * first on the timeline is the part nearest the *end* of the source, so the
 * left-hand clip is the one that keeps `out` and takes the cut as its `in`.
 */
export function splitAt(clip: Clip, sourceSeconds: number, rightUid: string): [Clip, Clip] | null {
  if (!canSplit(clip)) return null

  // Both halves are measured in source seconds, so the floor is too: a tenth of
  // a second of footage played at half speed is still a tenth of a second of
  // footage, and a clip shorter than this cannot be trimmed either.
  const floor = MIN_SOURCE_SPAN
  if (sourceSeconds <= clip.in + floor || sourceSeconds >= clip.out - floor) return null

  const left = { ...clip, [clip.reverse ? 'in' : 'out']: sourceSeconds }
  const right = { ...clip, uid: rightUid, [clip.reverse ? 'out' : 'in']: sourceSeconds }
  return [left, right]
}

/** The shortest piece of source worth calling a clip, in seconds. */
export const MIN_SOURCE_SPAN = 0.05

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

export function resolveInputs(
  project: Project,
  files: MediaFile[],
  container?: { subtitles?: string },
): ResolvedInputs {
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
  if (project.subtitles && carriesSubtitles(project, container)) {
    resolved.subtitles = add(project.subtitles.fileId, 'subtitles')
  }

  return resolved
}
