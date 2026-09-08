/** Splitting and re-quoting an ffmpeg command line typed by hand. */

/**
 * Split a command line into arguments, honouring single and double quotes and
 * backslash escapes. Raw mode lets people paste real commands, and filter
 * graphs are full of quotes and commas, so a naive `split(' ')` breaks at once.
 */
export function parseArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]

    if (char === '\\' && quote !== "'" && i + 1 < input.length) {
      current += input[i + 1]
      started = true
      i += 1
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        args.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }

  if (started) args.push(current)
  return args
}

/** Quote a single argument for display, only when it actually needs it. */
export function quoteArg(arg: string): string {
  if (arg === '') return "''"
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, "'\\''")}'`
}

/**
 * Parse a command line the user typed into the command bar.
 *
 * The bar shows the command the way it would be pasted into a terminal, program
 * name and all, so that leading `ffmpeg` has to come back off before the
 * arguments reach an engine — passing it through makes ffmpeg treat it as an
 * output file and fail with "Unable to find a suitable output format".
 */
export function parseCommandLine(input: string): string[] {
  const args = parseArgs(input)
  const first = args[0]?.split(/[\\/]/).pop()?.replace(/\.exe$/i, '')
  if (first === 'ffmpeg' || first === 'ffprobe') return args.slice(1)
  return args
}

/** Render an argument list as a copy-pasteable command line. */
export function formatCommand(args: string[], program = 'ffmpeg'): string {
  return [program, ...args.map(quoteArg)].join(' ')
}
