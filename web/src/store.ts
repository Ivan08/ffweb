/** Application state. */

import { create } from 'zustand'

import { api } from './api/client'
import { translate, useLanguage } from './i18n'
import { buildProject, outputNameFor, type BuiltCommand } from './core/build'
import { findContainer, pickEncoder, type Quality } from './core/containers'
import { baseName } from './core/format'
import { defaultParams, type Params } from './core/ops'
import { parseCommandLine } from './core/shell'
import { downloadJob } from './core/download'
import { classifyLog, looksLikeMissingHardware, uniqueOutputName } from './core/jobs'
import { toPlaceholders, withOutputPlaceholder } from './core/placeholders'
import { cleared, record, redo as redoStep, undo as undoStep, type History } from './core/history'
import { applyTheme, initialTheme, readFlag, writeFlag, writeString } from './core/preferences'
import {
  clipOf,
  contentEnd,
  emptyProject,
  isSubtitleFile,
  moveClip,
  splitAt,
  fileOverlay,
  soundOf,
  textOverlay,
  timelineDuration,
  type AudioTrack,
  type Clip,
  type EffectId,
  type ExportTarget,
  type Overlay,
  type Project,
  type Range,
  type Sound,
  type Subtitles,
  type Transition,
} from './core/project'
import { appendLine, runJob } from './core/runner'
import { layout, sourceAt } from './core/timeline'
import type { Capabilities, EngineId, Job, MediaFile } from './core/types'
import { nativeEngine } from './engines/native'
import type { Engine } from './engines/types'
import { wasmEngine } from './engines/wasm'
import { getOp } from './ops'

let nextId = 1
const uid = (prefix: string) => `${prefix}${nextId++}`

/**
 * What the application is busy with, when it is worth taking the screen for.
 *
 * The two are genuinely different and the difference matters: **copying** means
 * bytes are being written into a scratch folder, which is what a dropped file
 * costs and how long it takes depends on its size; **reading** means ffprobe is
 * inspecting files where they already lie, which is quick and copies nothing.
 */
export interface Busy {
  kind: 'copying' | 'reading'
  /** How many files the whole operation covers. */
  count: number
  /** How many are finished. */
  done: number
  /** The one being worked on, when there is a single obvious answer. */
  name?: string
}

/**
 * The picture on the stage, for the keyboard.
 *
 * `PreviewPanel` owns the `<video>` and registers this while it is mounted.
 * There is no element at all while the crop rectangle is up, which is why
 * every one of these is allowed to do nothing.
 */
export interface Player {
  play: () => void
  pause: () => void
  playing: () => boolean
}

/** The timeline's zoom, which lives in the axis rather than in this store. */
export interface TimelineHandle {
  zoomIn: () => void
  zoomOut: () => void
  fit: () => void
}

/** What the inspector on the right is currently editing. */
export type Focus =
  | { kind: 'none' }
  | { kind: 'clip'; uid: string }
  | { kind: 'overlay'; uid: string }
  | { kind: 'sound'; uid: string }
  | { kind: 'audio' }
  | { kind: 'subtitles' }
  | { kind: 'range'; uid: string }

interface AppState {
  capabilities: Capabilities | null
  capabilitiesError: string | null
  engine: EngineId
  theme: 'light' | 'dark'

  files: MediaFile[]
  /** Ids of the files ticked in the source strip, in the order they were ticked. */
  selection: string[]

  /** The whole description of the work. */
  project: Project
  /** Earlier states of that description, and the way forward out of an undo. */
  history: History<Project>
  /** Where the playhead sits on the timeline, in seconds. */
  playhead: number
  focus: Focus

  /** Set when the user has taken the command over by hand. */
  commandOverride: string | null

  jobs: Job[]
  /** Job whose result is shown in the preview pane. */
  activeJobId: string | null

  /** Set while files are being copied in or read, and nothing else can be done. */
  busy: Busy | null

  error: string | null
  /** Save each finished result straight away, without being asked. */
  autoDownload: boolean
  /** Short-lived confirmation shown in the corner; clears itself. */
  notice: string | null
  wasmMessage: string | null

  init: () => Promise<void>
  setEngine: (engine: EngineId) => void
  toggleTheme: () => void
  setError: (error: string | null) => void
  setNotice: (notice: string | null) => void
  setBusy: (busy: Busy | null) => void
  setAutoDownload: (value: boolean) => void

  addFiles: (paths: Array<{ path: string; name: string; size: number; blob?: File }>) => Promise<void>
  removeFile: (id: string) => void
  selectFile: (id: string, additive?: boolean) => void
  /** Empty the workspace: files, timeline, settings, queue. */
  clearWorkspace: () => void

  /** Step the project back, and forward again. Both do nothing when they cannot. */
  undo: () => void
  redo: () => void

  /** Which modal is up, if any. A modal owns the keyboard while it is. */
  dialog: 'files' | 'export' | null
  openDialog: (dialog: 'files' | 'export') => void
  closeDialog: () => void

  /**
   * Handles onto the two things the keyboard needs that state cannot hold: the
   * `<video>` on the stage and the timeline's own zoom. Both are registered by
   * the component that owns them and are null while it is not on screen.
   */
  player: Player | null
  timelineView: TimelineHandle | null
  registerPlayer: (player: Player | null) => void
  registerTimelineView: (view: TimelineHandle | null) => void

  addClips: (fileIds: string[]) => void
  removeClip: (uid: string) => void
  /** Cut the clip in two at a moment on the timeline. */
  splitClip: (uid: string, seconds: number) => void
  moveClipBy: (uid: string, delta: number) => void
  patchClip: (uid: string, patch: Partial<Clip>) => void
  setLayout: (layout: Project['layout'], direction?: Project['stackDirection']) => void
  /** How a clip arrives out of the one before it; null is a hard cut. */
  setTransition: (uid: string, transition: Transition | null) => void

  patchAudio: (patch: Partial<AudioTrack>) => void
  addSound: (fileId: string, at?: number) => void
  removeSound: (uid: string) => void
  patchSound: (uid: string, patch: Partial<Sound>) => void
  addOverlay: (fileId: string) => void
  addCaption: () => void
  removeOverlay: (uid: string) => void
  patchOverlay: (uid: string, patch: Partial<Overlay>) => void
  setSubtitles: (subtitles: Subtitles | null) => void

  /**
   * What of the workspace reaches the result.
   *
   * No range at all means all of it, so the first one marked is the moment the
   * project starts saying which parts it wants.
   */
  addRange: (from: number, to: number) => void
  patchRange: (uid: string, patch: Partial<Range>) => void
  removeRange: (uid: string) => void
  clearRanges: () => void

  addEffect: (op: EffectId) => void
  removeEffect: (uid: string) => void
  moveEffect: (uid: string, delta: number) => void
  toggleEffect: (uid: string) => void
  setEffectParam: (uid: string, key: string, value: Params[string]) => void
  /**
   * Several of an effect's parameters at once.
   *
   * A crop rectangle is four numbers that mean nothing apart, so writing them
   * one at a time made a drag four steps of history per pointer move — and
   * left undo restoring a width without its height, which is a rectangle that
   * was never on screen.
   */
  patchEffect: (uid: string, params: Params) => void

  setFade: (fadeIn: number, fadeOut: number) => void
  setTarget: (target: ExportTarget) => void
  setContainer: (container: string) => void
  setQuality: (quality: Partial<Quality>) => void
  setStripMeta: (value: boolean) => void
  setOutputName: (name: string | undefined) => void

  setPlayhead: (seconds: number) => void
  setFocus: (focus: Focus) => void
  setCommandOverride: (command: string | null) => void

  currentCommand: () => BuiltCommand | null
  run: () => Promise<void>
  cancelJob: (id: string) => void
  clearFinishedJobs: () => void
  setActiveJob: (id: string | null) => void
}

const cancelers = new Map<string, () => void>()

function engineFor(id: EngineId): Engine {
  return id === 'native' ? nativeEngine : wasmEngine
}

/**
 * Every project edit invalidates a command the user typed over the top, and
 * every one is a step you can take back.
 *
 * `key` is what makes a drag one step instead of forty. Continuous edits — a
 * trim handle, a slider, a caption being typed — pass the same key and merge;
 * structural ones — adding, removing, reordering — pass none and never merge.
 */
function edit(
  state: AppState,
  project: Project,
  key?: string,
): Pick<AppState, 'project' | 'commandOverride' | 'history'> {
  return {
    project,
    commandOverride: null,
    history: record(state.history, state.project, key, Date.now()),
  }
}

/** Name a patch by what it touches, so two handles of one clip stay apart. */
function patchKey(what: string, patch: object): string {
  return `${what}:${Object.keys(patch).sort().join(',')}`
}

/**
 * Put a remembered project back on screen.
 *
 * The playhead is not in the history — moving it is not an edit — but it has to
 * stay somewhere the timeline still reaches, or stepping back to a shorter
 * timeline leaves the cursor past the end of everything.
 */
function restored(
  state: AppState,
  step: { history: History<Project>; present: Project },
): Partial<AppState> {
  return {
    project: step.present,
    history: step.history,
    commandOverride: null,
    playhead: Math.max(0, Math.min(state.playhead, contentEnd(step.present))),
  }
}

export const useStore = create<AppState>((set, get) => ({
  capabilities: null,
  capabilitiesError: null,
  engine: 'native',
  theme: initialTheme(),

  files: [],
  selection: [],

  project: emptyProject(),
  history: cleared<Project>(),
  playhead: 0,
  focus: { kind: 'none' },

  dialog: null,
  player: null,
  timelineView: null,

  commandOverride: null,

  jobs: [],
  activeJobId: null,

  busy: null,

  error: null,
  autoDownload: readFlag('ffweb.autoDownload', true),
  notice: null,
  wasmMessage: null,

  async init() {
    applyTheme(get().theme)
    try {
      const capabilities = await api.capabilities()
      set({ capabilities, engine: capabilities.backend, capabilitiesError: null })
      if (capabilities.preload.length > 0) {
        await get().addFiles(
          capabilities.preload.map((path) => ({ path, name: baseName(path), size: 0 })),
        )
      }
    } catch (error) {
      set({ capabilitiesError: (error as Error).message })
    }
  },

  setEngine(engine) {
    set({ engine })
  },

  toggleTheme() {
    const theme = get().theme === 'dark' ? 'light' : 'dark'
    writeString('ffweb.theme', theme)
    applyTheme(theme)
    set({ theme })
  },

  setError(error) {
    set({ error })
  },

  setBusy(busy) {
    set({ busy })
  },

  setAutoDownload(value) {
    writeFlag('ffweb.autoDownload', value)
    set({ autoDownload: value })
  },

  setNotice(notice) {
    set({ notice })
    if (notice) {
      // A confirmation that stays on screen becomes furniture; this one leaves.
      window.setTimeout(() => {
        if (get().notice === notice) set({ notice: null })
      }, 4000)
    }
  },

  async addFiles(entries) {
    const existing = new Set(get().files.map((file) => file.path))
    const added: MediaFile[] = []
    for (const entry of entries) {
      if (existing.has(entry.path)) continue
      added.push({
        id: uid('f'),
        path: entry.path,
        name: entry.name,
        size: entry.size,
        blob: entry.blob,
      })
    }
    if (added.length === 0) return

    set((state) => ({
      files: [...state.files, ...added],
      selection: state.selection.length === 0 ? [added[0].id] : state.selection,
    }))

    // Probing needs the server's ffprobe; without it the UI still works, it just
    // knows less about the file.
    if (get().capabilities?.native.ffprobe) {
      const toRead = added.filter((file) => !file.blob)
      // Reading a long file off a slow disk is not instant, and an interface
      // that looks idle while it happens invites a second click.
      if (toRead.length > 0) {
        set({ busy: { kind: 'reading', count: toRead.length, done: 0, name: toRead[0].name } })
      }
      await Promise.all(
        toRead
          .map(async (file) => {
            try {
              const info = await api.probe(file.path)
              set((state) => ({
                files: state.files.map((f) =>
                  f.id === file.id ? { ...f, info, size: info.size ?? f.size } : f,
                ),
                // A clip put on the timeline before its file had been probed
                // has no length yet, and nothing would ever give it one. Only
                // an untouched clip is adjusted: a trim the user has already
                // made is theirs.
                project: {
                  ...state.project,
                  clips: state.project.clips.map((clip) =>
                    clip.fileId === file.id && clip.in === 0 && clip.out === 0
                      ? { ...clip, out: info.duration ?? 0 }
                      : clip,
                  ),
                },
              }))
            } catch (error) {
              set((state) => ({
                files: state.files.map((f) =>
                  f.id === file.id ? { ...f, infoError: (error as Error).message } : f,
                ),
              }))
            } finally {
              set((state) => ({
                busy: state.busy ? { ...state.busy, done: state.busy.done + 1 } : null,
              }))
            }
          }),
      )
      set({ busy: null })
    }

    // The first file opened is what the user came to work on, so it goes on the
    // timeline without being asked. Later ones wait to be placed, because by
    // then there is a timeline whose order matters.
    //
    // A subtitle file is the exception: it has no picture and no sound, so
    // putting it on the video track would make a clip of nothing at all.
    const first = added.find((file) => !isSubtitleFile(file.name))
    if (first && get().project.clips.length === 0) get().addClips([first.id])
  },

  removeFile(id) {
    set((state) => ({
      files: state.files.filter((file) => file.id !== id),
      selection: state.selection.filter((selected) => selected !== id),
      // Anything on the timeline that pointed at the file goes with it, rather
      // than leaving a clip whose footage is gone.
      project: {
        ...state.project,
        clips: state.project.clips.filter((clip) => clip.fileId !== id),
        overlays: state.project.overlays.filter((overlay) => overlay.fileId !== id),
        sounds: state.project.sounds.filter((sound) => sound.fileId !== id),
        subtitles: state.project.subtitles?.fileId === id ? null : state.project.subtitles,
      },
      commandOverride: null,
      // History goes with it. Ids are minted afresh on every open, so a
      // remembered project naming a file that has gone could never be put back
      // on screen — and a history full of dead references is worse than none.
      history: cleared<Project>(),
    }))
  },

  selectFile(id, additive = false) {
    set((state) => {
      if (!additive) return { selection: [id] }
      const already = state.selection.includes(id)
      // Order is kept because joining plays the clips in the order they were
      // ticked, and an empty selection is allowed: nothing depends on one.
      return {
        selection: already
          ? state.selection.filter((selected) => selected !== id)
          : [...state.selection, id],
      }
    })
  },

  clearWorkspace() {
    // Stopping first matters: a native job left running keeps encoding on the
    // server, and a wasm one keeps a worker busy, both writing progress into a
    // job that is no longer on the list.
    for (const cancel of cancelers.values()) cancel()
    cancelers.clear()

    // Browser-engine results are object URLs owned by this tab; dropping the
    // job without revoking them leaks the blob for as long as the tab lives.
    for (const job of get().jobs) {
      if (job.outputUrl) URL.revokeObjectURL(job.outputUrl)
    }

    set({
      files: [],
      selection: [],
      project: emptyProject(),
      history: cleared<Project>(),
      playhead: 0,
      focus: { kind: 'none' },
      commandOverride: null,
      jobs: [],
      activeJobId: null,
      busy: null,
      error: null,
      notice: null,
      wasmMessage: null,
    })
  },

  openDialog(dialog) {
    set({ dialog })
  },

  closeDialog() {
    set({ dialog: null })
  },

  registerPlayer(player) {
    set({ player })
  },

  registerTimelineView(timelineView) {
    set({ timelineView })
  },

  undo() {
    set((state) => {
      const back = undoStep(state.history, state.project)
      return back ? restored(state, back) : state
    })
  },

  redo() {
    set((state) => {
      const forward = redoStep(state.history, state.project)
      return forward ? restored(state, forward) : state
    })
  },

  addClips(fileIds) {
    set((state) => {
      const clips = [...state.project.clips]
      for (const id of fileIds) {
        const file = state.files.find((candidate) => candidate.id === id)
        if (file) clips.push(clipOf(uid('c'), file))
      }
      return edit(state, { ...state.project, clips })
    })
  },

  removeClip(clipUid) {
    set((state) =>
      edit(state, { ...state.project, clips: state.project.clips.filter((clip) => clip.uid !== clipUid) }),
    )
  },

  splitClip(clipUid, seconds) {
    set((state) => {
      const index = state.project.clips.findIndex((clip) => clip.uid === clipUid)
      if (index < 0) return state

      const placed = layout(state.project.clips).find((block) => block.uid === clipUid)
      if (!placed) return state

      const halves = splitAt(
        state.project.clips[index],
        sourceAt(state.project.clips[index], seconds - placed.start),
        uid('c'),
      )
      if (!halves) return state

      const clips = [...state.project.clips]
      clips.splice(index, 1, ...halves)
      return edit(state, { ...state.project, clips })
    })
  },

  moveClipBy(clipUid, delta) {
    set((state) => edit(state, { ...state.project, clips: moveClip(state.project.clips, clipUid, delta) },
        `clip:${clipUid}:order`,
      ))
  },

  patchClip(clipUid, patch) {
    set((state) =>
      edit(state, {
        ...state.project,
        clips: state.project.clips.map((clip) =>
          clip.uid === clipUid ? { ...clip, ...patch } : clip,
        ),
      }, patchKey(`clip:${clipUid}`, patch)),
    )
  },

  setTransition(clipUid, transition) {
    set((state) =>
      edit(
        state,
        {
          ...state.project,
          clips: state.project.clips.map((clip) =>
            clip.uid === clipUid ? { ...clip, transition } : clip,
          ),
        },
        `clip:${clipUid}:transition`,
      ),
    )
  },

  setLayout(layout, direction) {
    set((state) =>
      edit(state, {
        ...state.project,
        layout,
        stackDirection: direction ?? state.project.stackDirection,
      }),
    )
  },

  patchAudio(patch) {
    set((state) => edit(state, { ...state.project, audio: { ...state.project.audio, ...patch } }, patchKey('audio', patch)))
  },

  addSound(fileId, at = 0) {
    set((state) => {
      const file = state.files.find((candidate) => candidate.id === fileId)
      if (!file) return state
      const sound = soundOf(uid('s'), file, at)
      return {
        ...edit(state, { ...state.project, sounds: [...state.project.sounds, sound] }),
        focus: { kind: 'sound', uid: sound.uid } as Focus,
      }
    })
  },

  removeSound(soundUid) {
    set((state) =>
      edit(state, { ...state.project, sounds: state.project.sounds.filter((s) => s.uid !== soundUid) }),
    )
  },

  patchSound(soundUid, patch) {
    set((state) =>
      edit(state, {
        ...state.project,
        sounds: state.project.sounds.map((sound) =>
          sound.uid === soundUid ? { ...sound, ...patch } : sound,
        ),
      }, patchKey(`sound:${soundUid}`, patch)),
    )
  },

  addOverlay(fileId) {
    set((state) => {
      const file = state.files.find((candidate) => candidate.id === fileId)
      if (!file) return state
      const overlay = fileOverlay(uid('o'), file, timelineDuration(state.project))
      return {
        ...edit(state, { ...state.project, overlays: [...state.project.overlays, overlay] }),
        focus: { kind: 'overlay', uid: overlay.uid } as Focus,
      }
    })
  },

  addCaption() {
    set((state) => {
      const overlay = textOverlay(uid('o'), '', timelineDuration(state.project))
      return {
        ...edit(state, { ...state.project, overlays: [...state.project.overlays, overlay] }),
        focus: { kind: 'overlay', uid: overlay.uid } as Focus,
      }
    })
  },

  removeOverlay(overlayUid) {
    set((state) =>
      edit(state, {
        ...state.project,
        overlays: state.project.overlays.filter((overlay) => overlay.uid !== overlayUid),
      }),
    )
  },

  patchOverlay(overlayUid, patch) {
    set((state) =>
      edit(state, {
        ...state.project,
        overlays: state.project.overlays.map((overlay) =>
          overlay.uid === overlayUid ? { ...overlay, ...patch } : overlay,
        ),
      }, patchKey(`overlay:${overlayUid}`, patch)),
    )
  },

  setSubtitles(subtitles) {
    set((state) => edit(state, { ...state.project, subtitles }))
  },

  addRange(from, to) {
    set((state) => {
      const range = { uid: uid('r'), from: Math.min(from, to), to: Math.max(from, to) }
      return {
        ...edit(state, { ...state.project, ranges: [...state.project.ranges, range] }),
        focus: { kind: 'range', uid: range.uid } as Focus,
      }
    })
  },

  patchRange(rangeUid, patch) {
    set((state) =>
      edit(
        state,
        {
          ...state.project,
          ranges: state.project.ranges.map((range) =>
            range.uid === rangeUid ? { ...range, ...patch } : range,
          ),
        },
        patchKey(`range:${rangeUid}`, patch),
      ),
    )
  },

  removeRange(rangeUid) {
    set((state) =>
      edit(state, {
        ...state.project,
        ranges: state.project.ranges.filter((range) => range.uid !== rangeUid),
      }),
    )
  },

  clearRanges() {
    set((state) => edit(state, { ...state.project, ranges: [] }))
  },

  addEffect(op) {
    set((state) =>
      edit(state, {
        ...state.project,
        effects: [
          ...state.project.effects,
          { uid: uid('e'), op, params: defaultParams(getOp(op)), enabled: true },
        ],
      }),
    )
  },

  removeEffect(itemUid) {
    set((state) =>
      edit(state, {
        ...state.project,
        effects: state.project.effects.filter((item) => item.uid !== itemUid),
      }),
    )
  },

  moveEffect(itemUid, delta) {
    set((state) => {
      const effects = [...state.project.effects]
      const index = effects.findIndex((item) => item.uid === itemUid)
      const target = index + delta
      if (index < 0 || target < 0 || target >= effects.length) return state
      const [moved] = effects.splice(index, 1)
      effects.splice(target, 0, moved)
      return edit(state, { ...state.project, effects })
    })
  },

  toggleEffect(itemUid) {
    set((state) =>
      edit(state, {
        ...state.project,
        effects: state.project.effects.map((item) =>
          item.uid === itemUid ? { ...item, enabled: !item.enabled } : item,
        ),
      }),
    )
  },

  setEffectParam(itemUid, key, value) {
    get().patchEffect(itemUid, { [key]: value })
  },

  patchEffect(itemUid, params) {
    set((state) =>
      edit(
        state,
        {
          ...state.project,
          effects: state.project.effects.map((item) =>
            item.uid === itemUid ? { ...item, params: { ...item.params, ...params } } : item,
          ),
        },
        patchKey(`effect:${itemUid}`, params),
      ),
    )
  },

  setFade(fadeIn, fadeOut) {
    set((state) => edit(state, { ...state.project, fadeIn, fadeOut }, 'fade'))
  },

  setTarget(target) {
    set((state) => edit(state, { ...state.project, target }))
  },

  setContainer(container) {
    set((state) => {
      // A chosen encoder outlives the container it was chosen for. Keeping a
      // dead one would hide it: the builder falls back silently, so the dialog
      // would go on naming an encoder that is not writing anything.
      const def = findContainer(container)
      const keeps = def ? pickEncoder(def, state.project.quality.encoder) !== undefined : false
      const quality = keeps
        ? state.project.quality
        : { ...state.project.quality, encoder: 'auto' }
      return edit(state, { ...state.project, container, quality })
    })
  },

  setQuality(quality) {
    set((state) => edit(state, { ...state.project, quality: { ...state.project.quality, ...quality } }, patchKey('quality', quality)))
  },

  setStripMeta(stripMeta) {
    set((state) => edit(state, { ...state.project, stripMeta }))
  },

  setOutputName(name) {
    set((state) => edit(state, { ...state.project, name }, 'name'))
  },

  setPlayhead(seconds) {
    const limit = timelineDuration(get().project)
    const playhead = Math.max(0, Math.min(seconds, limit))
    // The still frame is whatever the playhead is on, so the two move together
    // rather than making the user type a timestamp they can already see.
    set((state) => ({ playhead, project: { ...state.project, still: playhead } }))
  },

  setFocus(focus) {
    set({ focus })
  },

  setCommandOverride(command) {
    set({ commandOverride: command })
  },

  /**
   * The command the timeline describes, never the one typed over the top.
   *
   * A hand-edited command is parsed back into placeholders in `run`, where it
   * is needed. Returning it from here as well made this function report the
   * edit back to whoever asked what the form would produce — so a ready-made
   * recipe, which builds from that answer, would compound its own last result.
   */
  currentCommand() {
    const state = get()
    if (state.project.clips.length === 0) return null

    const built = buildProject({
      project: state.project,
      files: state.files,
      engine: state.engine,
    })
    return built.args.length === 0 ? null : built
  },

  async run() {
    const state = get()
    if (state.project.clips.length === 0) return

    // Applying one project to several files only makes sense when the project
    // is a single clip: with a timeline, the other files are already on it.
    const single = state.project.clips.length === 1
    const batch =
      single && state.selection.length > 1
        ? state.selection.filter((id) => state.files.some((file) => file.id === id))
        : [state.project.clips[0].fileId]

    for (const fileId of batch) {
      const file = state.files.find((candidate) => candidate.id === fileId)
      if (!file) continue

      const project =
        single && fileId !== state.project.clips[0].fileId
          ? {
              ...state.project,
              clips: [{ ...state.project.clips[0], fileId, in: 0, out: file.info?.duration ?? 0 }],
            }
          : state.project

      const built = buildProject({ project, files: state.files, engine: state.engine })
      if (built.args.length === 0) continue

      // Straight from the builder rather than worked out again: whether a file
      // is opened can depend on the container, so a second walk of the project
      // is a second answer.
      const names = built.inputs.map((file) => file.name)
      const edited =
        state.commandOverride !== null && batch.length === 1
          ? withOutputPlaceholder(
              toPlaceholders(parseCommandLine(state.commandOverride), names, built.outputName),
              built.outputName,
            )
          : { args: built.args, outputName: built.outputName }
      const args = edited.args
      const outputName = uniqueOutputName(get().jobs, edited.outputName)

      const inputs = built.inputs
      const job: Job = {
        id: uid('j'),
        label: outputName,
        state: 'queued',
        progress: 0,
        engine: state.engine,
        command: args,
        inputName: file.name,
        outputName,
        duration: built.duration,
        log: [],
        createdAt: Date.now(),
      }
      set((current) => ({ jobs: [job, ...current.jobs], activeJobId: job.id }))

      void execute(job, inputs, args, outputName, set, get)
    }
  },

  cancelJob(id) {
    cancelers.get(id)?.()
  },

  clearFinishedJobs() {
    set((state) => ({
      jobs: state.jobs.filter((job) => job.state === 'queued' || job.state === 'running'),
    }))
  },

  setActiveJob(id) {
    set({ activeJobId: id })
  },
}))

/** Wire one job's run into the store. */
function execute(
  job: Job,
  inputs: MediaFile[],
  args: string[],
  outputName: string,
  set: (updater: (state: AppState) => Partial<AppState>) => void,
  get: () => AppState,
) {
  const onJob = (patch: Partial<Job>) =>
    set((state) => ({
      jobs: state.jobs.map((existing) =>
        existing.id === job.id ? { ...existing, ...patch } : existing,
      ),
    }))

  return runJob(
    {
      engine: engineFor(job.engine),
      inputs,
      args,
      outputName,
      duration: job.duration,
    },
    classifyLog,
    {
      patch: onJob,
      log: (line) =>
        set((state) => ({
          jobs: state.jobs.map((existing) =>
            existing.id === job.id
              ? { ...existing, log: appendLine(existing.log, line) }
              : existing,
          ),
        })),
      preparing: (message) => set(() => ({ wasmMessage: message })),
      cancellable: (cancel) => cancelers.set(job.id, cancel),
      failed: (message) =>
        set((state) => {
          const failing = state.jobs.find((candidate) => candidate.id === job.id)
          // A hardware encoder that ffmpeg was built with but has no driver
          // for fails with a message about a shared library or a device, which
          // says nothing about the setting that caused it.
          const hint =
            failing && looksLikeMissingHardware(failing.command, failing.log)
              ? ` ${translate(useLanguage.getState().language, 'error.hardwareEncoder')}`
              : ''
          return { error: `${message}${hint}` }
        }),
    },
  ).then(() => {
    cancelers.delete(job.id)
    const finished = get().jobs.find((candidate) => candidate.id === job.id)
    // Handing the result straight to the browser saves going to look for it,
    // and a result the browser engine produced would otherwise be lost on a
    // reload.
    if (finished?.state === 'done' && get().autoDownload) downloadJob(finished)
  })
}



export { outputNameFor }

/** The file whose picture the preview shows: the first clip on the timeline. */
export function primaryFile(state: Pick<AppState, 'project' | 'files'>): MediaFile | undefined {
  const first = state.project.clips[0]
  return first ? state.files.find((file) => file.id === first.fileId) : undefined
}
