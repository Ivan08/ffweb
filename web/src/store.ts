/** Application state. */

import { create } from 'zustand'

import { api } from './api/client'
import { buildProject, outputNameFor, type BuiltCommand } from './core/build'
import { type Quality } from './core/containers'
import { baseName } from './core/format'
import { defaultParams, type Params } from './core/ops'
import { parseCommandLine } from './core/shell'
import { downloadJob } from './core/download'
import { classifyLog, uniqueOutputName } from './core/jobs'
import { toPlaceholders, withOutputPlaceholder } from './core/placeholders'
import { applyTheme, initialTheme, readFlag, writeFlag, writeString } from './core/preferences'
import {
  clipOf,
  emptyProject,
  moveClip,
  fileOverlay,
  resolveInputs,
  soundOf,
  textOverlay,
  timelineDuration,
  type AudioTrack,
  type Clip,
  type EffectId,
  type ExportTarget,
  type Overlay,
  type Project,
  type Sound,
  type Subtitles,
} from './core/project'
import { appendLine, runJob } from './core/runner'
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

/** What the inspector on the right is currently editing. */
export type Focus =
  | { kind: 'none' }
  | { kind: 'clip'; uid: string }
  | { kind: 'overlay'; uid: string }
  | { kind: 'sound'; uid: string }
  | { kind: 'audio' }
  | { kind: 'subtitles' }

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

  addClips: (fileIds: string[]) => void
  removeClip: (uid: string) => void
  moveClipBy: (uid: string, delta: number) => void
  patchClip: (uid: string, patch: Partial<Clip>) => void
  setLayout: (layout: Project['layout'], direction?: Project['stackDirection']) => void

  patchAudio: (patch: Partial<AudioTrack>) => void
  addSound: (fileId: string, at?: number) => void
  removeSound: (uid: string) => void
  patchSound: (uid: string, patch: Partial<Sound>) => void
  addOverlay: (fileId: string) => void
  addCaption: () => void
  removeOverlay: (uid: string) => void
  patchOverlay: (uid: string, patch: Partial<Overlay>) => void
  setSubtitles: (subtitles: Subtitles | null) => void

  addEffect: (op: EffectId) => void
  removeEffect: (uid: string) => void
  moveEffect: (uid: string, delta: number) => void
  toggleEffect: (uid: string) => void
  setEffectParam: (uid: string, key: string, value: Params[string]) => void

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

/** Every project edit invalidates a command the user typed over the top. */
function edit(project: Project): Pick<AppState, 'project' | 'commandOverride'> {
  return { project, commandOverride: null }
}

export const useStore = create<AppState>((set, get) => ({
  capabilities: null,
  capabilitiesError: null,
  engine: 'native',
  theme: initialTheme(),

  files: [],
  selection: [],

  project: emptyProject(),
  playhead: 0,
  focus: { kind: 'none' },

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
    if (get().project.clips.length === 0) get().addClips([added[0].id])
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

  addClips(fileIds) {
    set((state) => {
      const clips = [...state.project.clips]
      for (const id of fileIds) {
        const file = state.files.find((candidate) => candidate.id === id)
        if (file) clips.push(clipOf(uid('c'), file))
      }
      return edit({ ...state.project, clips })
    })
  },

  removeClip(clipUid) {
    set((state) =>
      edit({ ...state.project, clips: state.project.clips.filter((clip) => clip.uid !== clipUid) }),
    )
  },

  moveClipBy(clipUid, delta) {
    set((state) => edit({ ...state.project, clips: moveClip(state.project.clips, clipUid, delta) }))
  },

  patchClip(clipUid, patch) {
    set((state) =>
      edit({
        ...state.project,
        clips: state.project.clips.map((clip) =>
          clip.uid === clipUid ? { ...clip, ...patch } : clip,
        ),
      }),
    )
  },

  setLayout(layout, direction) {
    set((state) =>
      edit({
        ...state.project,
        layout,
        stackDirection: direction ?? state.project.stackDirection,
      }),
    )
  },

  patchAudio(patch) {
    set((state) => edit({ ...state.project, audio: { ...state.project.audio, ...patch } }))
  },

  addSound(fileId, at = 0) {
    set((state) => {
      const file = state.files.find((candidate) => candidate.id === fileId)
      if (!file) return state
      const sound = soundOf(uid('s'), file, at)
      return {
        ...edit({ ...state.project, sounds: [...state.project.sounds, sound] }),
        focus: { kind: 'sound', uid: sound.uid } as Focus,
      }
    })
  },

  removeSound(soundUid) {
    set((state) =>
      edit({ ...state.project, sounds: state.project.sounds.filter((s) => s.uid !== soundUid) }),
    )
  },

  patchSound(soundUid, patch) {
    set((state) =>
      edit({
        ...state.project,
        sounds: state.project.sounds.map((sound) =>
          sound.uid === soundUid ? { ...sound, ...patch } : sound,
        ),
      }),
    )
  },

  addOverlay(fileId) {
    set((state) => {
      const file = state.files.find((candidate) => candidate.id === fileId)
      if (!file) return state
      const overlay = fileOverlay(uid('o'), file, timelineDuration(state.project))
      return {
        ...edit({ ...state.project, overlays: [...state.project.overlays, overlay] }),
        focus: { kind: 'overlay', uid: overlay.uid } as Focus,
      }
    })
  },

  addCaption() {
    set((state) => {
      const overlay = textOverlay(uid('o'), '', timelineDuration(state.project))
      return {
        ...edit({ ...state.project, overlays: [...state.project.overlays, overlay] }),
        focus: { kind: 'overlay', uid: overlay.uid } as Focus,
      }
    })
  },

  removeOverlay(overlayUid) {
    set((state) =>
      edit({
        ...state.project,
        overlays: state.project.overlays.filter((overlay) => overlay.uid !== overlayUid),
      }),
    )
  },

  patchOverlay(overlayUid, patch) {
    set((state) =>
      edit({
        ...state.project,
        overlays: state.project.overlays.map((overlay) =>
          overlay.uid === overlayUid ? { ...overlay, ...patch } : overlay,
        ),
      }),
    )
  },

  setSubtitles(subtitles) {
    set((state) => edit({ ...state.project, subtitles }))
  },

  addEffect(op) {
    set((state) =>
      edit({
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
      edit({
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
      return edit({ ...state.project, effects })
    })
  },

  toggleEffect(itemUid) {
    set((state) =>
      edit({
        ...state.project,
        effects: state.project.effects.map((item) =>
          item.uid === itemUid ? { ...item, enabled: !item.enabled } : item,
        ),
      }),
    )
  },

  setEffectParam(itemUid, key, value) {
    set((state) =>
      edit({
        ...state.project,
        effects: state.project.effects.map((item) =>
          item.uid === itemUid ? { ...item, params: { ...item.params, [key]: value } } : item,
        ),
      }),
    )
  },

  setFade(fadeIn, fadeOut) {
    set((state) => edit({ ...state.project, fadeIn, fadeOut }))
  },

  setTarget(target) {
    set((state) => edit({ ...state.project, target }))
  },

  setContainer(container) {
    set((state) => edit({ ...state.project, container }))
  },

  setQuality(quality) {
    set((state) => edit({ ...state.project, quality: { ...state.project.quality, ...quality } }))
  },

  setStripMeta(stripMeta) {
    set((state) => edit({ ...state.project, stripMeta }))
  },

  setOutputName(name) {
    set((state) => edit({ ...state.project, name }))
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

      const names = inputNames({ ...state, project })
      const edited =
        state.commandOverride !== null && batch.length === 1
          ? withOutputPlaceholder(
              toPlaceholders(parseCommandLine(state.commandOverride), names, built.outputName),
              built.outputName,
            )
          : { args: built.args, outputName: built.outputName }
      const args = edited.args
      const outputName = uniqueOutputName(get().jobs, edited.outputName)

      const inputs = inputFiles({ ...state, project })
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
      failed: (message) => set(() => ({ error: message })),
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

/**
 * The files the command refers to, in placeholder order.
 *
 * This goes through the same helper the builder uses, so the two can never
 * disagree about which file became which `-i`.
 */
function inputFiles(state: Pick<AppState, 'project' | 'files'>): MediaFile[] {
  return resolveInputs(state.project, state.files).files
}

function inputNames(state: Pick<AppState, 'project' | 'files'>): string[] {
  return inputFiles(state).map((file) => file.name)
}

export { outputNameFor }

/** The file whose picture the preview shows: the first clip on the timeline. */
export function primaryFile(state: Pick<AppState, 'project' | 'files'>): MediaFile | undefined {
  const first = state.project.clips[0]
  return first ? state.files.find((file) => file.id === first.fileId) : undefined
}
