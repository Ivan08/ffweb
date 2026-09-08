/**
 * Building a command out of a project.
 *
 * These assert the shape of what is emitted, not that ffmpeg likes it — that is
 * `ops.ffmpeg.test.ts`, which runs the real thing. What they are guarding is
 * the part a person cannot see: the difference between a command that is
 * accepted and a command that does what the timeline says.
 */

import { describe, expect, it } from 'vitest'

import { buildProject, containerFor, outputNameFor } from '../core/build'
import { emptyProject } from '../core/project'
import {
  argAfter,
  build,
  caption,
  clip,
  effect,
  FILES,
  graphChunks,
  LOGO,
  MUSIC,
  overlay,
  sound,
  PRIMARY,
  project,
  SECOND,
  SILENT,
  SUBS,
} from './fixtures'

/** The `-filter_complex` graph as one string, for substring assertions. */
const graph = (args: string[]) => argAfter(args, '-filter_complex') ?? ''

describe('the simple case', () => {
  it('builds the flat command it always did, with no graph at all', () => {
    const { args } = build(project())
    expect(args).not.toContain('-filter_complex')
    expect(args.slice(0, 2)).toEqual(['-i', '@in0'])
    expect(args[args.length - 1]).toBe('@out')
    expect(args).toContain('-c:v')
  })

  it('seeks before the input and limits after it', () => {
    const { args } = build(project({ clips: [clip(PRIMARY, { in: 4, out: 9 })] }))
    // `-ss` before `-i` is the fast seek; putting it after would decode
    // everything up to the fourth second first.
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'))
    expect(argAfter(args, '-ss')).toBe('4.000')
    expect(args.indexOf('-t')).toBeGreaterThan(args.indexOf('@in0'))
    expect(argAfter(args, '-t')).toBe('5.000')
  })

  it('leaves the trim out entirely when the clip covers the file', () => {
    const { args } = build(project())
    expect(args).not.toContain('-ss')
    expect(args).not.toContain('-t')
  })

  it('puts effects in a flat -vf chain', () => {
    const { args } = build(
      project({ effects: [effect('crop', { w: 640, h: 480, x: 0, y: 0 }), effect('adjust')] }),
    )
    const chain = argAfter(args, '-vf') ?? ''
    expect(chain).toContain('crop=')
    expect(chain).toContain('eq=')
    expect(args).not.toContain('-filter_complex')
  })

  it('reports the length so progress has something to measure against', () => {
    expect(build(project({ clips: [clip(PRIMARY, { in: 4, out: 9 })] })).duration).toBe(5)
  })
})

describe('joining', () => {
  it('concatenates the clips in the order they sit on the track', () => {
    const { args } = build(project({ clips: [clip(PRIMARY), clip(SECOND)] }))
    expect(graph(args)).toContain('concat=n=2:v=1:a=1')
    expect(args.filter((arg) => arg === '-i')).toHaveLength(2)
    expect(args).toContain('@in0')
    expect(args).toContain('@in1')
  })

  it('brings every clip to one size, aspect and frame rate first', () => {
    // `concat` refuses inputs that disagree, and a mismatched frame rate makes
    // the join stutter rather than fail, which is worse.
    const chunks = graphChunks(build(project({ clips: [clip(PRIMARY), clip(SECOND)] })).args)
    const pads = chunks.filter((chunk) => chunk.startsWith('[0:v]') || chunk.startsWith('[1:v]'))
    expect(pads).toHaveLength(2)
    for (const pad of pads) {
      expect(pad).toContain('scale=')
      expect(pad).toContain('setsar=1')
      expect(pad).toContain('fps=')
    }
  })

  it('brings every soundtrack to one format', () => {
    const chunks = graphChunks(build(project({ clips: [clip(PRIMARY), clip(SECOND)] })).args)
    const audio = chunks.filter((chunk) => chunk.includes('aformat='))
    expect(audio.length).toBeGreaterThanOrEqual(2)
  })

  it('pads a silent clip with silence rather than dropping the sound of the rest', () => {
    const { args } = build(project({ clips: [clip(PRIMARY), clip(SILENT)] }))
    expect(graph(args)).toContain('anullsrc=')
    expect(graph(args)).toContain('concat=n=2:v=1:a=1')
  })

  it('trims each clip at its own input, not once for all of them', () => {
    const { args } = build(
      project({ clips: [clip(PRIMARY, { in: 1, out: 3 }), clip(SECOND, { in: 5, out: 6 })] }),
    )
    // Two `-ss`, each immediately before the input it belongs to.
    const first = args.indexOf('@in0')
    const second = args.indexOf('@in1')
    expect(args.slice(0, first)).toEqual(['-ss', '1.000', '-t', '2.000', '-i'])
    expect(args.slice(first + 1, second)).toEqual(['-ss', '5.000', '-t', '1.000', '-i'])
  })

  it('stacks them side by side when asked to', () => {
    const { args } = build(
      project({ clips: [clip(PRIMARY), clip(SECOND)], layout: 'side-by-side' }),
    )
    expect(graph(args)).toContain('hstack=inputs=2')
    expect(graph(args)).not.toContain('concat=')
  })

  it('stacks them vertically when asked for that', () => {
    const { args } = build(
      project({
        clips: [clip(PRIMARY), clip(SECOND)],
        layout: 'side-by-side',
        stackDirection: 'vertical',
      }),
    )
    expect(graph(args)).toContain('vstack=inputs=2')
  })
})

describe('what a clip can be told to do', () => {
  it('changes the speed of the picture and the sound together', () => {
    const { args } = build(project({ clips: [clip(PRIMARY, { speed: 2 }), clip(SECOND)] }))
    expect(graph(args)).toContain('setpts=0.500000*PTS')
    expect(graph(args)).toContain('atempo=')
  })

  it('resets the timestamps after reversing, or everything downstream misreads them', () => {
    const { args } = build(project({ clips: [clip(PRIMARY, { reverse: true }), clip(SECOND)] }))
    expect(graph(args)).toContain('reverse,setpts=PTS-STARTPTS')
    expect(graph(args)).toContain('areverse')
  })

  it('splits rather than naming a label twice when a clip repeats', () => {
    // A graph label may be consumed exactly once, so repeating means splitting.
    const { args } = build(project({ clips: [clip(PRIMARY, { loop: 3 })] }))
    expect(graph(args)).toContain('split=3')
    expect(graph(args)).toContain('asplit=3')
    expect(graph(args)).toContain('concat=n=3')
  })

  it('plays there and back', () => {
    const { args } = build(project({ clips: [clip(PRIMARY, { boomerang: true })] }))
    expect(graph(args)).toContain('reverse')
    expect(graph(args)).toContain('concat=n=2')
  })
})

describe('the soundtrack', () => {
  it('places another file at the moment it was dropped', () => {
    const { args } = build(
      project({ audio: { ...emptyProject().audio, source: 'none' }, sounds: [sound('s1', MUSIC, { at: 5, in: 0, out: 20 })] }),
    )
    // `all=1` matters: the bare form delays only the first channel.
    expect(graph(args)).toContain('adelay=delays=5000:all=1')
    expect(graph(args)).toContain('atrim=0.000:20.000')
  })

  it('leaves out the delay when the soundtrack starts at the beginning', () => {
    const { args } = build(
      project({ audio: { ...emptyProject().audio, source: 'none' }, sounds: [sound('s1', MUSIC, { at: 0, in: 0, out: 20 })] }),
    )
    expect(graph(args)).not.toContain('adelay')
  })

  it('mixes without letting ffmpeg halve both sides', () => {
    const { args } = build(
      project({
        sounds: [sound('s1', MUSIC, { at: 0, in: 0, out: 20 })],
      }),
    )
    expect(graph(args)).toContain('amix=inputs=2')
    expect(graph(args)).toContain('normalize=0')
  })

  it('replaces rather than mixes when it is not asked to mix', () => {
    const { args } = build(
      project({ audio: { ...emptyProject().audio, source: 'none' }, sounds: [sound('s1', MUSIC, { at: 0, in: 0, out: 20 })] }),
    )
    expect(graph(args)).not.toContain('amix')
  })

  it('bounds the run with -t rather than -shortest', () => {
    // With a filter graph, `-shortest` is where truncations and hangs live, and
    // the project already knows how long it is meant to be.
    const { args } = build(
      project({ audio: { ...emptyProject().audio, source: 'none' }, sounds: [sound('s1', MUSIC, { at: 5, in: 0, out: 90 })] }),
    )
    expect(args).not.toContain('-shortest')
    expect(args).toContain('-t')
  })

  it('drops the sound entirely when the track is silent', () => {
    const { args } = build(project({ audio: { ...emptyProject().audio, source: 'none' } }))
    expect(args).toContain('-an')
    expect(args).not.toContain('-c:a')
  })

  it('applies the level and the loudness once, over the finished mix', () => {
    const { args } = build(
      project({
        clips: [clip(PRIMARY), clip(SECOND)],
        audio: { ...emptyProject().audio, gain: 4, normalize: true },
      }),
    )
    expect(graph(args)).toContain('volume=4dB')
    expect(graph(args)).toContain('loudnorm=')
    expect(graph(args).match(/loudnorm=/g)).toHaveLength(1)
  })

  it('lays several sounds down at once and mixes them', () => {
    const { args } = build(
      project({
        sounds: [
          sound('s1', MUSIC, { at: 0, in: 0, out: 10 }),
          sound('s2', MUSIC, { at: 6, in: 0, out: 8, gain: -6 }),
        ],
      }),
    )
    // The footage's own sound and both of theirs: three into one mix.
    expect(graph(args)).toContain('amix=inputs=3')
    expect(graph(args)).toContain('adelay=delays=6000:all=1')
    expect(graph(args)).toContain('volume=-6dB')
    expect(args.filter((arg) => arg === '-i')).toHaveLength(3)
  })

  it('still makes sound when the footage has been muted', () => {
    // Replacing the soundtrack is exactly this, and reading only the footage's
    // own setting made the result silent.
    const { args } = build(
      project({
        audio: { ...emptyProject().audio, source: 'none' },
        sounds: [sound('s1', MUSIC, { at: 0, in: 0, out: 10 })],
      }),
    )
    expect(args).not.toContain('-an')
    expect(graph(args)).toContain('atrim=0.000:10.000')
    expect(graph(args)).not.toContain('amix')
  })

})

describe('overlays', () => {
  const withLogo = () =>
    project({
      overlays: [
        overlay('o1', LOGO, { x: 0.9, y: 0.9, scale: 0.25, opacity: 1, from: 3, to: 7 }),
      ],
    })

  it('appears and disappears when the block says', () => {
    const { args } = build(withLogo())
    expect(graph(args)).toContain("enable='between(t,3.000,7.000)'")
  })

  it('is sized against the picture as it is by then, not against the original', () => {
    const { args } = build({ ...withLogo(), effects: [effect('crop', { w: 640, h: 480, x: 0, y: 0 })] })
    expect(graph(args)).toContain('scale2ref=w=iw*0.2500')
  })

  it('is drawn after the effects, so a crop cannot cut it off', () => {
    // Ordering is the whole reason effects are a separate stage. Reverse it and
    // a logo placed in the corner disappears the moment somebody crops, with
    // nothing failing to say why.
    const { args } = build({ ...withLogo(), effects: [effect('crop', { w: 640, h: 480, x: 0, y: 0 })] })
    expect(graph(args).indexOf('crop=')).toBeLessThan(graph(args).indexOf('overlay='))
  })

  it('is positioned as a fraction, so a resize does not move it', () => {
    const { args } = build(withLogo())
    expect(graph(args)).toContain('overlay=x=(W-w)*0.9000:y=(H-h)*0.9000')
  })

  it('starts a laid-on clip when it appears, not partway through itself', () => {
    // Measured against real ffmpeg: without the shift, a four-second clip
    // placed at three seconds showed its *last* frame there, because it had
    // been playing against the main timeline all along.
    const { args } = build(
      project({ overlays: [overlay('o1', SECOND, { from: 3, to: 7 })] }),
    )
    expect(graph(args)).toContain('setpts=PTS-STARTPTS+3.000/TB')
  })

  it('does not shift a still, which has only the one frame', () => {
    const { args } = build(project({ overlays: [overlay('o1', LOGO, { from: 3, to: 7 })] }))
    expect(graph(args)).not.toContain('setpts=PTS-STARTPTS+')
  })

  it('does not shift anything laid on from the very beginning', () => {
    const { args } = build(project({ overlays: [overlay('o1', SECOND, { from: 0, to: 4 })] }))
    expect(graph(args)).not.toContain('setpts=PTS-STARTPTS+')
  })

  it('never asks the overlay to stand aside, which would hide a still entirely', () => {
    // `eof_action=pass` bypasses the overlay once the second input ends, and a
    // single-frame image ends immediately: the logo would never be drawn.
    expect(graph(build(withLogo()).args)).not.toContain('eof_action=pass')
  })

  it('bounds a still image input so its timestamps stay sane', () => {
    const { args } = build(withLogo())
    const logoIndex = args.indexOf('@in1')
    expect(args.slice(0, logoIndex)).toContain('-loop')
    expect(args.slice(0, logoIndex)).toContain('-framerate')
  })

  it('only builds the alpha plumbing when it is see-through', () => {
    expect(graph(build(withLogo()).args)).not.toContain('colorchannelmixer')
    const faded = withLogo()
    faded.overlays[0].opacity = 0.5
    expect(graph(build(faded).args)).toContain('format=rgba,colorchannelmixer=aa=0.50')
  })

  it('stacks several in order', () => {
    const two = withLogo()
    two.overlays.push({ ...two.overlays[0], uid: 'o2', from: 8, to: 9 })
    const { args } = build(two)
    expect(graph(args).match(/overlay=/g)).toHaveLength(2)
  })
})

describe('captions', () => {
  const withText = (text: string, patch = {}) =>
    project({ overlays: [caption('t1', text, { from: 2, to: 5, ...patch })] })

  it('draws the text onto the picture at the moment it says', () => {
    const { args } = build(withText('hello'))
    expect(graph(args)).toContain('drawtext=expansion=none:text=hello')
    expect(graph(args)).toContain("enable='between(t,2.000,5.000)'")
  })

  it('costs no input of its own', () => {
    const { args } = build(withText('hello'))
    expect(args.filter((arg) => arg === '-i')).toHaveLength(1)
  })

  it('turns off expansion, or a per cent sign is read as a date', () => {
    // `drawtext` treats % as a strftime escape and refuses the whole graph over
    // a caption that says "50%".
    expect(graph(build(withText('50% off')).args)).toContain('expansion=none')
  })

  it('escapes what the two parsers around it would otherwise eat', () => {
    const chunk = graph(build(withText("a:b,c;d[e]f'g")).args)
    expect(chunk).toContain("a\\\\:b\\,c\\;d\\[e\\]f\\'g")
  })

  it('keeps a web address out of the argument the server scans', () => {
    // The server refuses any argument containing `http:`, which is how a
    // filtergraph reaches the network. An escaped colon is both what ffmpeg
    // wants and what keeps a caption about a website from being rejected.
    const chunk = graph(build(withText('see http://example.com')).args)
    expect(chunk.toLowerCase()).not.toContain('http:')
  })

  it('sizes the text against the frame, so a resize carries it', () => {
    expect(graph(build(withText('hi', { fontSize: 0.1 })).args)).toContain('fontsize=h*0.1000')
  })

  it('puts a plate behind it only when asked', () => {
    expect(graph(build(withText('hi', { box: true })).args)).toContain('box=1')
    expect(graph(build(withText('hi', { box: false })).args)).not.toContain('box=1')
  })
})

describe('fading the whole result', () => {
  it('anchors the fade-out to the end of the timeline', () => {
    const { args } = build(project({ clips: [clip(PRIMARY, { out: 10 })], fadeIn: 1, fadeOut: 2 }))
    expect(graph(args)).toContain('fade=t=in:st=0:d=1')
    expect(graph(args)).toContain('fade=t=out:st=8.000:d=2')
    expect(graph(args)).toContain('afade=t=out:st=8.000:d=2')
  })

  it('skips a fade-out longer than the result rather than guessing', () => {
    const { args } = build(project({ clips: [clip(PRIMARY, { out: 1 })], fadeOut: 5 }))
    expect(graph(args)).not.toContain('fade=t=out')
  })
})

describe('export targets', () => {
  it('makes a GIF with its own palette and no sound', () => {
    const { args, outputName } = build(project({ target: 'gif' }))
    const chain = argAfter(args, '-vf') ?? graph(args)
    expect(chain).toContain('palettegen')
    expect(chain).toContain('paletteuse')
    expect(args).toContain('-an')
    expect(args).not.toContain('-c:a')
    expect(outputName.endsWith('.gif')).toBe(true)
  })

  it('makes a sound file with no picture', () => {
    const { args, outputName } = build(project({ target: 'audio', container: 'mp3' }))
    expect(args).toContain('-vn')
    expect(args).not.toContain('-vf')
    expect(outputName.endsWith('.mp3')).toBe(true)
  })

  it('takes one frame where the playhead is', () => {
    const { args } = build(project({ target: 'still', still: 6, clips: [clip(PRIMARY, { in: 2 })] }))
    expect(args).toContain('-frames:v')
    // The playhead is on the timeline; the input wants a place in the file.
    expect(argAfter(args, '-ss')).toBe('8.000')
  })

  it('refuses an impossible pairing instead of producing an empty file', () => {
    // Asking for the soundtrack in an mp4 would make a video with no picture.
    expect(containerFor('audio', 'mp4')).toBe('mp3')
    expect(containerFor('video', 'mp3')).toBe('mp4')
    expect(containerFor('gif', 'mp4')).toBe('gif')
    expect(containerFor('video', 'mkv')).toBe('mkv')
  })

  it('names the result after the footage and what was made of it', () => {
    expect(outputNameFor('holiday clip.mp4', 'gif', 'gif')).toBe('holiday_clip-gif.gif')
    expect(build(project()).outputName).toBe('holiday-video.mp4')
  })

  it('honours a name the user typed', () => {
    expect(build(project({ name: 'mine.mp4' })).outputName).toBe('mine.mp4')
  })

  it('strips metadata when asked', () => {
    const { args } = build(project({ stripMeta: true }))
    expect(args).toContain('-map_metadata')
    expect(argAfter(args, '-map_metadata')).toBe('-1')
  })
})

describe('subtitles', () => {
  it('burns them in through a placeholder, never a path', () => {
    const { args } = build(
      project({ subtitles: { fileId: SUBS.id, mode: 'burn', fontSize: 28 } }),
    )
    expect(graph(args)).toContain('subtitles=@in1')
    expect(graph(args)).toContain("force_style='FontSize=28'")
  })
})

describe('the placeholder contract', () => {
  const projects = [
    project(),
    project({ clips: [clip(PRIMARY), clip(SECOND), clip(SILENT)] }),
    project({ target: 'gif' }),
    project({ target: 'audio' }),
    project({ target: 'still' }),
    project({
      overlays: [
        overlay('o1', LOGO, { x: 0.5, y: 0.5, scale: 0.3, opacity: 0.8, from: 1, to: 2 }),
      ],
    }),
    project({ audio: { ...emptyProject().audio, source: 'none' }, sounds: [sound('s1', MUSIC, { at: 2, in: 0, out: 10 })] }),
  ]

  it.each(projects.map((p, index) => [index, p] as const))(
    'numbers the inputs consecutively from zero (%i)',
    (_index, p) => {
      const { args } = build(p)
      const placeholders = args.filter((arg) => arg.startsWith('@in'))
      expect(placeholders).toEqual(placeholders.map((_, i) => `@in${i}`))
    },
  )

  it.each(projects.map((p, index) => [index, p] as const))(
    'ends with exactly one @out (%i)',
    (_index, p) => {
      const { args } = build(p)
      expect(args.filter((arg) => arg === '@out')).toHaveLength(1)
      expect(args[args.length - 1]).toBe('@out')
    },
  )

  it('shows the command with real names rather than placeholders', () => {
    const { display } = build(project({ clips: [clip(PRIMARY), clip(SECOND)] }))
    expect(display).toContain('holiday.mp4')
    expect(display).toContain('second.mp4')
    expect(display.some((arg) => arg.startsWith('@'))).toBe(false)
  })
})

describe('when something is missing', () => {
  it('says so instead of building a command with a hole in it', () => {
    const p = project({ clips: [clip(PRIMARY), { ...clip(SECOND), fileId: 'gone' }] })
    const built = build(p)
    expect(built.missing).toContain('clip')
    // The clip that is still there is built; the one that is not is not
    // silently renumbered over.
    expect(built.args.filter((arg) => arg === '-i')).toHaveLength(1)
  })

  it('builds nothing at all with an empty timeline', () => {
    expect(buildProject({ project: emptyProject(), files: FILES, engine: 'native' }).args).toEqual([])
  })
})
