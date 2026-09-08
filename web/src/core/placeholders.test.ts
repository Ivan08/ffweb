/** Both directions of the placeholder mapping, and that they agree. */

import { describe, expect, it } from 'vitest'

import { toNames, toPlaceholders, withOutputPlaceholder } from './placeholders'

describe('unwinding a hand-edited command', () => {
  it('maps names back onto the placeholders the server expects', () => {
    const typed = ['-i', 'clip.mp4', '-c:v', 'libx264', 'clip-convert.mp4']
    expect(toPlaceholders(typed, ['clip.mp4'], 'clip-convert.mp4')).toEqual([
      '-i', '@in0', '-c:v', 'libx264', '@out',
    ])
  })

  it('numbers several inputs in order', () => {
    const typed = ['-i', 'first.mp4', '-i', 'second.mp4', 'out.mp4']
    expect(toPlaceholders(typed, ['first.mp4', 'second.mp4'], 'out.mp4')).toEqual([
      '-i', '@in0', '-i', '@in1', '@out',
    ])
  })

  it('does not let one name eat another it is contained in', () => {
    // Replacing `clip.mp4` first would leave `my-@in1` where `my-clip.mp4`
    // was, and the server would then be handed a path it refuses.
    const typed = ['-i', 'my-clip.mp4', '-i', 'clip.mp4', 'out.mp4']
    expect(toPlaceholders(typed, ['clip.mp4', 'my-clip.mp4'], 'out.mp4')).toEqual([
      '-i', '@in1', '-i', '@in0', '@out',
    ])
  })

  it('substitutes inside a filter argument', () => {
    const typed = ['-vf', "subtitles=captions.srt:force_style='FontSize=24'"]
    expect(toPlaceholders(typed, ['clip.mp4', 'captions.srt'], 'out.mp4')).toEqual([
      '-vf', "subtitles=@in1:force_style='FontSize=24'",
    ])
  })

  it('replaces every occurrence, not only the first', () => {
    const typed = ['-filter_complex', 'movie=a.mp4;movie=a.mp4']
    expect(toPlaceholders(typed, ['a.mp4'], 'out.mp4')).toEqual([
      '-filter_complex', 'movie=@in0;movie=@in0',
    ])
  })

  it('leaves a command alone when nothing matches', () => {
    const typed = ['-c', 'copy']
    expect(toPlaceholders(typed, ['clip.mp4'], 'out.mp4')).toEqual(typed)
  })

  it('ignores an empty name rather than replacing everything with it', () => {
    const typed = ['-i', 'clip.mp4', 'out.mp4']
    expect(toPlaceholders(typed, ['', 'clip.mp4'], 'out.mp4')).toEqual(['-i', '@in1', '@out'])
  })
})

describe('a hand-edited command that renames its output', () => {
  it('substitutes the name the user typed', () => {
    // Renaming the output while editing is an obvious thing to try, and the
    // server only accepts a placeholder.
    const typed = ['-i', '@in0', '-c:v', 'libx264', 'my-result.mp4']
    const mapped = withOutputPlaceholder(typed, 'holiday-convert.mp4')
    expect(mapped.args.at(-1)).toBe('@out')
    expect(mapped.outputName).toBe('my-result.mp4')
  })

  it('leaves a command that already has a placeholder alone', () => {
    const typed = ['-i', '@in0', '@out']
    const mapped = withOutputPlaceholder(typed, 'holiday.mp4')
    expect(mapped.args).toEqual(typed)
    expect(mapped.outputName).toBe('holiday.mp4')
  })

  it('keeps only the file name from a path that was typed', () => {
    const mapped = withOutputPlaceholder(['-i', '@in0', 'sub/dir/out.mp4'], 'fallback.mp4')
    expect(mapped.outputName).toBe('out.mp4')
  })

  it('does not treat a trailing option as an output', () => {
    // An unfinished command should be reported, not silently reinterpreted.
    const typed = ['-i', '@in0', '-c:v']
    expect(withOutputPlaceholder(typed, 'holiday.mp4').args).toEqual(typed)
    expect(withOutputPlaceholder([], 'holiday.mp4').args).toEqual([])
  })
})

describe('replacing placeholders with names', () => {
  it('names the inputs and the output', () => {
    const args = ['-i', '@in0', '-i', '@in1', '-c:v', 'libx264', '@out']
    expect(toNames(args, ['a.mp4', 'b.mp4'], 'out.mp4')).toEqual([
      '-i', 'a.mp4', '-i', 'b.mp4', '-c:v', 'libx264', 'out.mp4',
    ])
  })

  it('substitutes inside a filter argument', () => {
    expect(toNames(['-vf', 'subtitles=@in1'], ['a.mp4', 'subs.srt'], 'out.mp4')).toEqual([
      '-vf', 'subtitles=subs.srt',
    ])
  })

  it('does not mistake @in1 for @in0 followed by a one', () => {
    // Substituting the lower index first would turn `@in1` into `a.mp41`.
    expect(toNames(['-i', '@in0', '-i', '@in1'], ['a.mp4', 'b.mp4'], 'out.mp4')).toEqual([
      '-i', 'a.mp4', '-i', 'b.mp4',
    ])
  })

  it('leaves a command with no placeholders alone', () => {
    expect(toNames(['-c', 'copy'], ['a.mp4'], 'out.mp4')).toEqual(['-c', 'copy'])
  })
})

describe('the two directions agree', () => {
  const cases: Array<{ args: string[]; inputs: string[]; output: string }> = [
    { args: ['-i', '@in0', '@out'], inputs: ['clip.mp4'], output: 'out.mp4' },
    {
      args: ['-i', '@in0', '-i', '@in1', '-filter_complex', 'concat=n=2', '@out'],
      inputs: ['first.mp4', 'second.mp4'],
      output: 'joined.mp4',
    },
    {
      args: ['-vf', "subtitles=@in1:force_style='FontSize=24'", '@out'],
      inputs: ['clip.mp4', 'captions.srt'],
      output: 'subbed.mp4',
    },
    {
      // One name contained in the other, which is where a naive replacement
      // corrupts the command.
      args: ['-i', '@in0', '-i', '@in1', '@out'],
      inputs: ['clip.mp4', 'my-clip.mp4'],
      output: 'out.mp4',
    },
  ]

  for (const { args, inputs, output } of cases) {
    it(`round-trips ${args.join(' ')}`, () => {
      const named = toNames(args, inputs, output)
      expect(toPlaceholders(named, inputs, output)).toEqual(args)
    })
  }
})
