/**
 * Whether the generated commands are valid *as ffmpeg*.
 *
 * The other suites check that a project says what it meant to say. These check
 * that what it said is a legal thing to say to ffmpeg — the rules that make a
 * command fail no matter how sensible each argument looks on its own: filtering
 * a stream you are also copying, two filtergraphs at once, encoder settings for
 * a stream you just disabled, a graph label consumed twice.
 *
 * The matrix matters as much as the rules. Most of these faults only appear in
 * a combination — a project that copies the video is fine until an effect ends
 * up in the same command — so every export target is checked against every
 * container, against a single clip and a join, with and without effects, sound
 * and overlays.
 */

import { describe, expect, it } from 'vitest'

import { CONTAINERS } from '../core/containers'
import { emptyProject, type ExportTarget, type Project } from '../core/project'
import {
  build, caption, clip, effect, LOGO, MUSIC, overlay, PRIMARY, project, SECOND, SILENT, sound, SUBS,
} from './fixtures'

/** Options that take a value, so a scan can skip over it. */
const VALUE_OPTIONS = new Set([
  '-i', '-ss', '-t', '-to', '-vf', '-af', '-filter_complex', '-map', '-c', '-c:v', '-c:a', '-c:s',
  '-crf', '-preset', '-b:v', '-b:a', '-pix_fmt', '-movflags', '-loop', '-frames:v', '-q:v',
  '-map_metadata', '-map_chapters', '-stream_loop', '-r', '-ar', '-ac', '-row-mt', '-shortest',
  '-framerate', '-update',
])

const TARGETS: ExportTarget[] = ['video', 'gif', 'audio', 'still']

/** The shapes a timeline can take, named so a failure says which one broke. */
const SHAPES: Array<{ label: string; project: Project }> = [
  { label: 'one clip', project: project() },
  { label: 'one clip trimmed', project: project({ clips: [clip(PRIMARY, { in: 2, out: 9 })] }) },
  { label: 'two clips joined', project: project({ clips: [clip(PRIMARY), clip(SECOND)] }) },
  {
    label: 'a silent clip among noisy ones',
    project: project({ clips: [clip(PRIMARY), clip(SILENT)] }),
  },
  {
    label: 'side by side',
    project: project({ clips: [clip(PRIMARY), clip(SECOND)], layout: 'side-by-side' }),
  },
  { label: 'sped up', project: project({ clips: [clip(PRIMARY, { speed: 2 })] }) },
  { label: 'reversed', project: project({ clips: [clip(PRIMARY, { reverse: true })] }) },
  { label: 'repeated', project: project({ clips: [clip(PRIMARY, { loop: 2 })] }) },
  { label: 'there and back', project: project({ clips: [clip(PRIMARY, { boomerang: true })] }) },
  { label: 'silent', project: project({ audio: { ...emptyProject().audio, source: 'none' } }) },
  {
    label: 'another soundtrack',
    project: project({
      audio: { ...emptyProject().audio, source: 'none' }, sounds: [sound('s1', MUSIC, { at: 3, in: 0, out: 20 })],
    }),
  },
  {
    label: 'a soundtrack mixed in',
    project: project({
      sounds: [sound('s1', MUSIC, { at: 0, in: 0, out: 20 })],
    }),
  },
  {
    label: 'levelled sound',
    project: project({ audio: { ...emptyProject().audio, gain: 4, normalize: true } }),
  },
  {
    label: 'an overlay',
    project: project({
      overlays: [overlay('o1', LOGO, { x: 0.9, y: 0.9, opacity: 0.8, from: 1, to: 3 })],
    }),
  },
  { label: 'faded', project: project({ fadeIn: 1, fadeOut: 1 }) },
  {
    label: 'a caption',
    project: project({ overlays: [caption('t1', "50% off — don't miss it: today", { from: 1, to: 4 })] }),
  },
  {
    label: 'a caption over an overlay',
    project: project({
      overlays: [overlay('o1', LOGO, { from: 0, to: 3 }), caption('t1', 'hello', { from: 1, to: 2 })],
    }),
  },
  {
    label: 'dissolved',
    project: project({
      clips: [clip(PRIMARY), clip(SECOND, { transition: { duration: 1, kind: 'fade' } })],
    }),
  },
  {
    label: 'dissolved with a repeat and a silent clip',
    project: project({
      clips: [
        clip(PRIMARY, { loop: 2 }),
        // The repeat on a clip that *arrives* is the case where a botched
        // fold leaves the second showing of it connected to nothing.
        clip(SILENT, { loop: 2, transition: { duration: 0.5, kind: 'wipeleft' } }),
        clip(SECOND, { boomerang: true, transition: { duration: 1, kind: 'circleopen' } }),
      ],
    }),
  },
  {
    label: 'burnt-in subtitles',
    project: project({ subtitles: { fileId: SUBS.id, mode: 'burn', fontSize: 24 } }),
  },
  {
    label: 'soft subtitles',
    project: project({ subtitles: { fileId: SUBS.id, mode: 'soft', fontSize: 24 } }),
  },
]

const EFFECT_SETS: Array<{ label: string; effects: Project['effects'] }> = [
  { label: '', effects: [] },
  { label: ' + effects', effects: [effect('adjust'), effect('resizecompress')] },
  {
    label: ' + a crop',
    effects: [effect('crop', { w: 640, h: 480, x: 10, y: 10 })],
  },
]

interface Command {
  args: string[]
  label: string
}

/** Every combination worth checking. */
function matrix(): Command[] {
  const commands: Command[] = []
  for (const shape of SHAPES) {
    for (const set of EFFECT_SETS) {
      for (const target of TARGETS) {
        const base = { ...shape.project, effects: set.effects, target }
        commands.push({
          args: build(base).args,
          label: `${shape.label}${set.label} → ${target}`,
        })
        for (const container of CONTAINERS) {
          commands.push({
            args: build({ ...base, container: container.ext }).args,
            label: `${shape.label}${set.label} → ${target} in ${container.ext}`,
          })
        }
      }
    }
  }
  return commands.filter((command) => command.args.length > 0)
}

const COMMANDS = matrix()

/** Value of an option, or undefined when it is absent. */
function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

/** True when the command copies the given stream rather than encoding it. */
function copies(args: string[], stream: 'v' | 'a'): boolean {
  return valueOf(args, '-c') === 'copy' || valueOf(args, `-c:${stream}`) === 'copy'
}

describe('the generated commands are legal ffmpeg', () => {
  it('never filters a stream it also copies', () => {
    // "Filtering and streamcopy cannot be used together" — ffmpeg refuses the
    // whole command, so this is a hard failure and not a quality issue.
    const broken = COMMANDS.filter(
      ({ args }) =>
        (args.includes('-vf') && copies(args, 'v')) || (args.includes('-af') && copies(args, 'a')),
    )
    expect(broken.map((c) => c.label)).toEqual([])
  })

  it('never uses a simple filter and a filter graph at once', () => {
    // `-vf` and `-filter_complex` are mutually exclusive for the same output.
    const broken = COMMANDS.filter(
      ({ args }) => args.includes('-filter_complex') && (args.includes('-vf') || args.includes('-af')),
    )
    expect(broken.map((c) => c.label)).toEqual([])
  })

  it('states each filter option only once', () => {
    for (const { args, label } of COMMANDS) {
      for (const flag of ['-vf', '-af', '-filter_complex']) {
        const count = args.filter((arg) => arg === flag).length
        expect(count, `${label} repeats ${flag}`).toBeLessThanOrEqual(1)
      }
    }
  })

  it('never encodes a stream it just disabled', () => {
    for (const { args, label } of COMMANDS) {
      if (args.includes('-an')) {
        expect(args, `${label} disables audio and configures it`).not.toContain('-c:a')
        expect(args, `${label} disables audio and sets its bitrate`).not.toContain('-b:a')
        expect(args, `${label} disables audio and filters it`).not.toContain('-af')
      }
      if (args.includes('-vn')) {
        expect(args, `${label} disables video and configures it`).not.toContain('-c:v')
        expect(args, `${label} disables video and filters it`).not.toContain('-vf')
      }
    }
  })

  it('never both disables and maps the same stream', () => {
    for (const { args, label } of COMMANDS) {
      const maps = args.filter((_, index) => args[index - 1] === '-map')
      if (args.includes('-an')) {
        expect(maps.filter((m) => m.includes(':a') && !m.endsWith('?')), label).toEqual([])
      }
    }
  })

  it('gives every option that needs a value one that is not another option', () => {
    for (const { args, label } of COMMANDS) {
      args.forEach((arg, index) => {
        if (!VALUE_OPTIONS.has(arg) || arg === '-shortest') return
        const value = args[index + 1]
        expect(value, `${label}: ${arg} has no value`).toBeDefined()
        // `-2` and `-1` are legitimate values; a real option is a letter.
        expect(/^-[a-zA-Z]/.test(value ?? ''), `${label}: ${arg} is followed by ${value}`).toBe(false)
      })
    }
  })

  it('attaches every input-side option to the input it belongs to', () => {
    // `-ss`, `-t`, `-loop` and `-framerate` are *per-input* options. Putting
    // them all before the first `-i`, as the earlier builder did, silently
    // applied one clip's trim to every clip in a join. Each one must therefore
    // sit in the run of arguments between the previous input and its own.
    //
    // `-t`, `-loop` and `-framerate` are read either side of an input — `-t` on
    // the output bounds the whole run, `-loop 0` there is a GIF's repeat count —
    // so those are only checked when they appear before one. `-ss` and
    // `-stream_loop` after the last input would be the slow decode-everything
    // path, so they must always have an owner.
    const perInput = new Set(['-ss', '-t', '-loop', '-framerate', '-stream_loop'])
    const alwaysInput = new Set(['-ss', '-stream_loop'])
    for (const { args, label } of COMMANDS) {
      const inputs: number[] = []
      args.forEach((arg, index) => {
        if (arg === '-i') inputs.push(index)
      })
      expect(inputs.length, `${label}: no inputs`).toBeGreaterThan(0)
      const lastInput = inputs[inputs.length - 1]

      for (const [flag, index] of args.map((arg, i) => [arg, i] as const)) {
        if (!perInput.has(flag)) continue
        if (index > lastInput) {
          expect(alwaysInput.has(flag), `${label}: ${flag} is after the last input`).toBe(false)
          continue
        }
        const owner = inputs.find((position) => position > index)
        expect(owner, `${label}: ${flag} at ${index} belongs to no input`).toBeDefined()
        // Nothing but other input-side options may separate it from its `-i`.
        for (const stray of args.slice(index + 2, owner)) {
          if (stray.startsWith('-')) {
            expect(perInput.has(stray), `${label}: ${stray} sits between ${flag} and its input`).toBe(true)
          }
        }
      }
    }
  })

  it('puts the output-side options after the last input', () => {
    for (const { args, label } of COMMANDS) {
      const lastInput = args.lastIndexOf('-i')
      // `-t` is deliberately absent: it is an input option as well, and one
      // appears before each trimmed clip.
      for (const flag of ['-vf', '-af', '-filter_complex', '-c:v', '-c:a', '-crf']) {
        const index = args.indexOf(flag)
        if (index >= 0) expect(index, `${label}: ${flag} is before an input`).toBeGreaterThan(lastInput)
      }
    }
  })

  it('writes a filter graph that is balanced', () => {
    for (const { args, label } of COMMANDS) {
      for (const flag of ['-vf', '-af', '-filter_complex']) {
        const graph = valueOf(args, flag)
        if (!graph) continue
        const opens = (graph.match(/\[/g) ?? []).length
        const closes = (graph.match(/\]/g) ?? []).length
        expect(opens, `${label}: unbalanced brackets in ${flag}`).toBe(closes)
        expect(graph, `${label}: ${flag} ends with a separator`).not.toMatch(/[,;]$/)
        expect(graph, `${label}: ${flag} has an empty link`).not.toMatch(/,,|;;/)
        expect(graph.trim(), `${label}: ${flag} is empty`).not.toBe('')
      }
    }
  })

  it('leaves no pad in a filter graph unconsumed', () => {
    // ffmpeg refuses a graph whose output goes nowhere — "Filter has output
    // unconnected" — rather than quietly ignoring it. That is how a soundtrack
    // replacing the original left the clips' own audio dangling.
    for (const { args, label } of COMMANDS) {
      const graph = valueOf(args, '-filter_complex')
      if (!graph) continue

      const produced = new Set<string>()
      const consumed = new Set<string>()
      for (const chunk of graph.split(';')) {
        // Labels may carry a colon, as in `[0:v]`, so the brackets are matched
        // by what they are not rather than by an alphabet.
        const leading = /^(\[[^\]]+\])+/.exec(chunk)?.[0] ?? ''
        const trailing = /(\[[^\]]+\])+$/.exec(chunk.slice(leading.length))?.[0] ?? ''
        const names = (run: string) =>
          Array.from(run.matchAll(/\[([^\]]+)\]/g), (match) => match[1])
        for (const name of names(leading)) consumed.add(name)
        for (const name of names(trailing)) produced.add(name)
      }

      const mapped = new Set(
        args
          .filter((arg, index) => args[index - 1] === '-map' && arg.startsWith('['))
          .map((arg) => arg.slice(1, -1)),
      )

      for (const name of produced) {
        // A stream straight off an input is not a pad the graph produced.
        if (/^\d+:[va]\??$/.test(name)) continue
        expect(
          consumed.has(name) || mapped.has(name),
          `${label}: [${name}] is produced and never used`,
        ).toBe(true)
      }
    }
  })

  it('labels every pad it uses in a filter graph', () => {
    for (const { args, label } of COMMANDS) {
      const graph = valueOf(args, '-filter_complex')
      if (!graph) continue
      // A `-map [name]` has to refer to a pad the graph actually defines.
      const defined = new Set(Array.from(graph.matchAll(/\[([a-z0-9_]+)\]/gi), (m) => m[1]))
      args.forEach((arg, index) => {
        if (args[index - 1] !== '-map') return
        const match = /^\[(.+)\]$/.exec(arg)
        if (!match) return
        expect(defined, `${label}: -map ${arg} names an undefined pad`).toContain(match[1])
      })
    }
  })

  it('maps a subtitle stream only from an input it opened', () => {
    // A soft track is the one thing mapped straight from an input rather than
    // from a pad, so it is the one place a stale index would name a file that
    // is not there — and ffmpeg would refuse the whole command.
    for (const { args, label } of COMMANDS) {
      const opened = args.filter((arg) => arg === '-i').length
      args.forEach((arg, index) => {
        if (args[index - 1] !== '-map') return
        const match = /^(\d+):s$/.exec(arg)
        if (!match) return
        expect(
          Number(match[1]),
          `${label}: -map ${arg} names an input that was never opened`,
        ).toBeLessThan(opened)
      })
    }
  })

  it('names a subtitle codec whenever it maps a subtitle stream', () => {
    // The codec is per container, so a map without one means the container
    // takes no subtitles and the whole track should have been left off.
    for (const { args, label } of COMMANDS) {
      const maps = args.filter((arg, index) => args[index - 1] === '-map' && /^\d+:s$/.test(arg))
      if (maps.length === 0) continue
      expect(args, `${label}: maps a subtitle stream without saying how to write it`).toContain('-c:s')
    }
  })

  it('maps the source audio only with the optional marker', () => {
    for (const { args, label } of COMMANDS) {
      args.forEach((arg, index) => {
        if (args[index - 1] !== '-map') return
        // `0:a` fails outright on a silent source, and the source is whatever
        // the user opened. `0:a?` is how you say "if there is one".
        //
        // A later input is different: it was chosen for this operation, so if
        // the file picked as a soundtrack has no audio, failing loudly is the
        // right answer rather than quietly producing silence.
        if (arg === '0:a') {
          expect.fail(`${label}: -map 0:a should be 0:a? to tolerate a silent source`)
        }
      })
    }
  })
})

describe('the arguments the server will accept', () => {
  // Mirrors src/validate.rs: the server substitutes the paths itself and
  // refuses anything that names one, so a command that breaks these rules is
  // rejected before ffmpeg ever sees it.
  const FORBIDDEN_PROTOCOLS = ['file:', 'pipe:', 'concat:', 'http:', 'https:', 'data:', 'fd:']
  const FILE_VALUED_FILTER_KEYS = [
    'subtitles=', 'ass=', 'textfile=', 'fontfile=', 'filename=', 'sub_file=', 'movie=', 'amovie=',
  ]

  it('has exactly one output placeholder, at the end', () => {
    for (const { args, label } of COMMANDS) {
      expect(args.filter((arg) => arg === '@out'), label).toHaveLength(1)
      expect(args.at(-1), label).toBe('@out')
    }
  })

  it('names no path outside a placeholder', () => {
    for (const { args, label } of COMMANDS) {
      for (const arg of args) {
        if (/^@(in\d+|out)$/.test(arg)) continue
        expect(
          arg.startsWith('/') || arg.startsWith('~') || arg.startsWith('./') || arg.startsWith('../'),
          `${label}: "${arg}" is a path`,
        ).toBe(false)
      }
    }
  })

  it('uses no protocol the server refuses', () => {
    for (const { args, label } of COMMANDS) {
      for (const arg of args) {
        for (const proto of FORBIDDEN_PROTOCOLS) {
          expect(arg.toLowerCase().includes(proto), `${label}: "${arg}" uses ${proto}`).toBe(false)
        }
      }
    }
  })

  it('gives every file-valued filter option a placeholder', () => {
    for (const { args, label } of COMMANDS) {
      for (const arg of args) {
        const lower = arg.toLowerCase()
        for (const key of FILE_VALUED_FILTER_KEYS) {
          let from = 0
          for (;;) {
            const found = lower.indexOf(key, from)
            if (found < 0) break
            const value = arg.slice(found + key.length).replace(/^['"]/, '')
            expect(
              value.startsWith('@in') || value.startsWith('@out'),
              `${label}: ${key} is given "${value.slice(0, 30)}" instead of a placeholder`,
            ).toBe(true)
            from = found + key.length
          }
        }
      }
    }
  })

  it('numbers its input placeholders from zero without gaps', () => {
    for (const { args, label } of COMMANDS) {
      const used = new Set<number>()
      for (const arg of args) {
        for (const match of arg.matchAll(/@in(\d+)/g)) used.add(Number(match[1]))
      }
      const sorted = [...used].sort((a, b) => a - b)
      expect(sorted, label).toEqual(sorted.map((_, index) => index))
    }
  })
})
