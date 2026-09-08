/**
 * The two directions of one mapping.
 *
 * Commands are composed with `@in0`, `@in1` and `@out` in place of paths, which
 * is what lets the server substitute them itself and refuse anything else. The
 * interface has to show names instead, the browser engine has to use names in
 * its virtual filesystem, and a hand-edited command comes back written with
 * names. All three are this mapping, forwards or backwards, and having had
 * three copies of it was one copy away from them disagreeing.
 */

/** Placeholder for the n-th input file. */
export const IN_PREFIX = '@in'
/** Placeholder for the output file. */
export const OUT = '@out'

/**
 * Replace the placeholders with names, including inside a filter argument
 * such as `subtitles=@in1`.
 *
 * Later inputs are substituted first so `@in1` is never mistaken for `@in0`
 * followed by a stray `1`.
 */
export function toNames(args: string[], inputs: string[], output: string): string[] {
  return args.map((arg) => {
    let text = arg.split(OUT).join(output)
    for (let index = inputs.length - 1; index >= 0; index -= 1) {
      text = text.split(`${IN_PREFIX}${index}`).join(inputs[index])
    }
    return text
  })
}

/**
 * Replace names with the placeholders the server expects.
 *
 * The longest name goes first, so a name contained in another cannot consume
 * it: with `clip.mp4` and `my-clip.mp4`, doing the short one first would leave
 * `my-@in0`.
 */
export function toPlaceholders(args: string[], inputs: string[], output: string): string[] {
  const ordered = inputs
    .map((name, index) => ({ name, index }))
    .filter(({ name }) => name)
    .sort((a, b) => b.name.length - a.name.length)

  return args.map((arg) => {
    let text = output ? arg.split(output).join(OUT) : arg
    for (const { name, index } of ordered) {
      text = text.split(name).join(`${IN_PREFIX}${index}`)
    }
    return text
  })
}

/**
 * Make sure a hand-edited command still names its output as a placeholder.
 *
 * Editing the command is supported, and renaming the output file while doing so
 * is an obvious thing to try. The server only accepts `@out`, so without this
 * the answer was "argument list has no @out placeholder" — true, and useless to
 * anyone who just wanted a different file name. The last argument of an ffmpeg
 * command is its output, so that is what gets substituted.
 */
export function withOutputPlaceholder(
  args: string[],
  fallbackName: string,
): { args: string[]; outputName: string } {
  if (args.includes(OUT)) return { args, outputName: fallbackName }

  const last = args.at(-1)
  // A trailing flag means the command is incomplete; leave it to be reported.
  if (!last || last.startsWith('-')) return { args, outputName: fallbackName }

  return {
    args: [...args.slice(0, -1), OUT],
    outputName: last.split(/[\\/]/).pop() || fallbackName,
  }
}
