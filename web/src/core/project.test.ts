/**
 * The project model.
 *
 * These are the sums the whole timeline rests on: how long a clip runs once it
 * has been sped up and repeated, where the inputs are numbered, and whether the
 * project is simple enough to skip the filter graph. A mistake in any of them
 * is invisible in the interface and wrong in the file.
 */

import { describe, expect, it } from 'vitest'

import {
  clampOverlay,
  clipDuration,
  contentEnd,
  hasPicture,
  isStill,
  STILL_SECONDS,
  clipOf,
  clipStart,
  emptyProject,
  isTrivial,
  moveClip,
  fileOverlay,
  resolveInputs,
  sourceLength,
  timelineDuration,
  type Clip,
} from './project'
import type { MediaFile } from './types'

const file = (id: string, duration: number, hasAudio = true): MediaFile => ({
  id,
  path: `/clips/${id}.mp4`,
  name: `${id}.mp4`,
  size: 1000,
  info: {
    duration,
    size: 1000,
    bit_rate: 1000,
    format_name: 'mp4',
    width: 1920,
    height: 1080,
    fps: 25,
    video_codec: 'h264',
    audio_codec: hasAudio ? 'aac' : null,
    has_video: true,
    has_audio: hasAudio,
    raw: {},
  },
})

const clip = (patch: Partial<Clip> = {}): Clip => ({
  ...clipOf('c1', file('a', 10)),
  ...patch,
})

describe('how long a clip runs', () => {
  it('is the trimmed part of the source when nothing else is set', () => {
    expect(sourceLength(clip({ in: 2, out: 7 }))).toBe(5)
    expect(clipDuration(clip({ in: 2, out: 7 }))).toBe(5)
  })

  it('shrinks with speed', () => {
    expect(clipDuration(clip({ in: 0, out: 10, speed: 2 }))).toBe(5)
    expect(clipDuration(clip({ in: 0, out: 10, speed: 0.5 }))).toBe(20)
  })

  it('doubles when it plays there and back', () => {
    expect(clipDuration(clip({ in: 0, out: 10, boomerang: true }))).toBe(20)
  })

  it('multiplies when it repeats', () => {
    expect(clipDuration(clip({ in: 0, out: 10, loop: 3 }))).toBe(30)
  })

  it('combines all three', () => {
    // Ten seconds at double speed is five, there and back is ten, twice is
    // twenty. Getting this wrong puts every overlay on the wrong second.
    expect(clipDuration(clip({ in: 0, out: 10, speed: 2, boomerang: true, loop: 2 }))).toBe(20)
  })

  it('treats a nonsensical speed as untouched rather than dividing by zero', () => {
    expect(clipDuration(clip({ in: 0, out: 10, speed: 0 }))).toBe(10)
  })

  it('never goes negative when the trim is inverted', () => {
    expect(sourceLength(clip({ in: 8, out: 3 }))).toBe(0)
  })
})

describe('the length of the timeline', () => {
  it('adds the clips up when they play in sequence', () => {
    const p = emptyProject()
    p.clips = [clip({ uid: 'a', in: 0, out: 6 }), clip({ uid: 'b', in: 0, out: 4 })]
    expect(timelineDuration(p)).toBe(10)
  })

  it('takes the longest when they play together', () => {
    const p = emptyProject()
    p.layout = 'side-by-side'
    p.clips = [clip({ uid: 'a', in: 0, out: 6 }), clip({ uid: 'b', in: 0, out: 4 })]
    expect(timelineDuration(p)).toBe(6)
  })

  it('is zero with nothing on it', () => {
    expect(timelineDuration(emptyProject())).toBe(0)
  })

  it('places each clip after the ones before it', () => {
    const p = emptyProject()
    p.clips = [clip({ uid: 'a', in: 0, out: 6 }), clip({ uid: 'b', in: 0, out: 4 })]
    expect(clipStart(p, 'a')).toBe(0)
    expect(clipStart(p, 'b')).toBe(6)
  })
})

describe('how far the timeline reaches', () => {
  const withClips = () => {
    const p = emptyProject()
    p.clips = [clip({ uid: 'a', in: 0, out: 6 })]
    return p
  }

  it('is the picture when nothing outlasts it', () => {
    expect(contentEnd(withClips())).toBe(6)
  })

  it('reaches past the picture for a soundtrack that outlasts it', () => {
    // The result is still six seconds — the picture decides that — but the
    // sound is on the timeline and has to be drawn.
    const p = withClips()
    p.sounds = [{ uid: 's1', fileId: 'm', at: 4, in: 0, out: 20, gain: 0 }]
    expect(timelineDuration(p)).toBe(6)
    expect(contentEnd(p)).toBe(24)
  })

  it('reaches past the picture for an overlay that does', () => {
    const p = withClips()
    p.overlays = [{ ...fileOverlay('o1', file('f', 30), 6), from: 2, to: 9 }]
    expect(contentEnd(p)).toBe(9)
  })
})

describe('reordering', () => {
  const clips = [clip({ uid: 'a' }), clip({ uid: 'b' }), clip({ uid: 'c' })]

  it('moves a clip one place', () => {
    expect(moveClip(clips, 'a', 1).map((c) => c.uid)).toEqual(['b', 'a', 'c'])
    expect(moveClip(clips, 'c', -1).map((c) => c.uid)).toEqual(['a', 'c', 'b'])
  })

  it('refuses to move past either end', () => {
    expect(moveClip(clips, 'a', -1)).toBe(clips)
    expect(moveClip(clips, 'c', 1)).toBe(clips)
  })

  it('ignores a clip that is not there', () => {
    expect(moveClip(clips, 'zzz', 1)).toBe(clips)
  })
})

describe('the window a laid-on file gets', () => {
  const still = (): MediaFile => ({
    id: 'p', path: '/card.png', name: 'card.png', size: 1,
    info: { duration: null, size: 1, bit_rate: null, format_name: 'png_pipe', width: 800, height: 600,
      fps: null, video_codec: 'png', audio_codec: null, has_video: true, has_audio: false, raw: {} },
  })

  it("is the clip's own length, not the whole timeline", () => {
    // Claiming all eight seconds for a four-second clip said it would be there
    // when it has nothing left to show.
    expect(fileOverlay('o1', file('a', 4), 8).to).toBe(4)
  })

  it('is the timeline when the clip outlasts it', () => {
    expect(fileOverlay('o1', file('a', 20), 8).to).toBe(8)
  })

  it('is the whole timeline for a still, which has no length of its own', () => {
    expect(fileOverlay('o1', still(), 8).to).toBe(8)
  })
})

describe('an overlay window', () => {
  it('stays inside the timeline', () => {
    const overlay = { ...fileOverlay('o1', file('f1', 30), 10), from: -5, to: 40 }
    expect(clampOverlay(overlay, 10)).toMatchObject({ from: 0, to: 10 })
  })

  it('cannot end before it starts', () => {
    const overlay = { ...fileOverlay('o1', file('f1', 30), 10), from: 8, to: 3 }
    const clamped = clampOverlay(overlay, 10)
    expect(clamped.to).toBeGreaterThanOrEqual(clamped.from)
  })
})

describe('numbering the inputs', () => {
  const files = [file('a', 10), file('b', 10), file('m', 60)]

  it('runs clips first, then the sounds, then the overlays', () => {
    const p = emptyProject()
    p.clips = [clip({ uid: 'c1', fileId: 'a' }), clip({ uid: 'c2', fileId: 'b' })]
    p.sounds = [{ uid: 's1', fileId: 'm', at: 0, in: 0, out: 10, gain: 0 }]
    p.overlays = [fileOverlay('o1', file('a', 30), 10)]

    const resolved = resolveInputs(p, files)
    expect(resolved.files.map((f) => f.id)).toEqual(['a', 'b', 'm', 'a'])
    expect(resolved.clips.get('c1')).toBe(0)
    expect(resolved.clips.get('c2')).toBe(1)
    expect(resolved.sounds.get('s1')).toBe(2)
    // The same file used twice gets two slots, because a graph refers to an
    // input by number and each `-i` is its own stream.
    expect(resolved.overlays.get('o1')).toBe(3)
  })

  it('reports a part whose file has gone instead of renumbering around it', () => {
    const p = emptyProject()
    p.clips = [clip({ uid: 'c1', fileId: 'a' }), clip({ uid: 'c2', fileId: 'gone' })]
    const resolved = resolveInputs(p, files)
    expect(resolved.files.map((f) => f.id)).toEqual(['a'])
    expect(resolved.clips.has('c2')).toBe(false)
    expect(resolved.missing).toContain('clip')
  })
})

describe('a still image', () => {
  const png = (): MediaFile => ({
    id: 'p',
    path: '/clips/card.png',
    name: 'card.png',
    size: 100,
    info: {
      duration: null, size: 100, bit_rate: null, format_name: 'png_pipe',
      width: 800, height: 600, fps: null, video_codec: 'png', audio_codec: null,
      has_video: true, has_audio: false, raw: {},
    },
  })

  it('is recognised as one', () => {
    expect(isStill(png())).toBe(true)
    expect(isStill(file('a', 10))).toBe(false)
  })

  it('is recognised by its name when it could not be probed', () => {
    expect(isStill({ id: 'x', path: '/a/card.jpg', name: 'card.jpg', size: 1 })).toBe(true)
  })

  it('gets a length when it goes on the track, or it would be nothing at all', () => {
    // A picture has no duration of its own. Without a default, a title card
    // placed between two clips is zero seconds long everywhere.
    expect(clipDuration(clipOf('c', png()))).toBe(STILL_SECONDS)
  })
})

describe('whether there is a picture to work on', () => {
  it('is true for footage and false for sound alone', () => {
    const withVideo = emptyProject()
    withVideo.clips = [clip({ uid: 'c1', fileId: 'a' })]
    expect(hasPicture(withVideo, [file('a', 10)])).toBe(true)

    const soundOnly = { ...file('a', 10) }
    soundOnly.info = { ...soundOnly.info!, has_video: false }
    expect(hasPicture(withVideo, [soundOnly])).toBe(false)
  })
})

describe('the simple case', () => {
  it('is one untouched clip with its own sound', () => {
    expect(isTrivial(project1())).toBe(true)
  })

  it('is still simple with effects on it, because those are a flat chain', () => {
    const p = project1()
    p.effects = [{ uid: 'e1', op: 'crop', params: {}, enabled: true }]
    expect(isTrivial(p)).toBe(true)
  })

  it.each([
    ['a second clip', (p: ReturnType<typeof project1>) => p.clips.push(clip({ uid: 'c2' }))],
    ['an overlay', (p: ReturnType<typeof project1>) => p.overlays.push(fileOverlay('o1', file('a', 30), 10))],
    ['subtitles', (p: ReturnType<typeof project1>) => (p.subtitles = { fileId: 's', mode: 'burn', fontSize: 24 })],
    ['a fade', (p: ReturnType<typeof project1>) => (p.fadeIn = 1)],
    ['a speed change', (p: ReturnType<typeof project1>) => (p.clips[0].speed = 2)],
    ['a reversal', (p: ReturnType<typeof project1>) => (p.clips[0].reverse = true)],
    ['a repeat', (p: ReturnType<typeof project1>) => (p.clips[0].loop = 2)],
    ['there-and-back', (p: ReturnType<typeof project1>) => (p.clips[0].boomerang = true)],
    ['a sound laid on it', (p: ReturnType<typeof project1>) => p.sounds.push({ uid: 's1', fileId: 'm', at: 0, in: 0, out: 5, gain: 0 })],
    ['no sound at all', (p: ReturnType<typeof project1>) => (p.audio.source = 'none')],
    ['a level change', (p: ReturnType<typeof project1>) => (p.audio.gain = 3)],
    ['loudness levelling', (p: ReturnType<typeof project1>) => (p.audio.normalize = true)],
  ])('stops being simple with %s', (_label, mutate) => {
    const p = project1()
    mutate(p)
    expect(isTrivial(p)).toBe(false)
  })
})

function project1() {
  const p = emptyProject()
  p.clips = [clip({ uid: 'c1', fileId: 'a' })]
  return p
}
