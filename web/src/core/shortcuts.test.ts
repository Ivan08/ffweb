/** What a keystroke means, and that no two shortcuts claim the same one. */

import { describe, expect, it } from 'vitest'

import { labelFor, matches, SHORTCUTS, shortcutFor, type Shortcut } from './shortcuts'

/** A keystroke, shaped like the part of the event the matcher reads. */
function press(
  key: string,
  modifiers: { mod?: boolean; shift?: boolean; alt?: boolean } = {},
): KeyboardEvent {
  return {
    key,
    ctrlKey: modifiers.mod ?? false,
    metaKey: false,
    shiftKey: modifiers.shift ?? false,
    altKey: modifiers.alt ?? false,
  } as KeyboardEvent
}

const byId = (id: string): Shortcut => SHORTCUTS.find((s) => s.id === id)!

describe('the table itself', () => {
  it('claims no chord twice', () => {
    // Two shortcuts on one chord means one of them silently never happens, and
    // which one depends on the order they were written in.
    const seen = new Map<string, string>()
    for (const shortcut of SHORTCUTS) {
      const chord = [
        shortcut.mod ? 'mod' : '',
        shortcut.shift ? 'shift' : '',
        shortcut.key.toLowerCase(),
      ].join('+')
      expect(seen.get(chord), `${shortcut.id} and ${seen.get(chord)} share ${chord}`).toBeUndefined()
      seen.set(chord, shortcut.id)
    }
  })

  it('gives every id exactly one entry', () => {
    const ids = SHORTCUTS.map((shortcut) => shortcut.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('leaves bare letters alone but for the one that earns it', () => {
    // The command bar is a textarea that is always mounted. Every bare letter
    // taken here is a letter somebody cannot type into it, so the list of them
    // is pinned rather than left to grow by habit.
    const bare = SHORTCUTS.filter(
      (shortcut) => !shortcut.mod && !shortcut.shift && /^[a-z]$/i.test(shortcut.key),
    )
    expect(bare.map((shortcut) => shortcut.id)).toEqual(['split'])
  })
})

describe('reading a keystroke', () => {
  it('tells undo from redo by the shift key', () => {
    // The pair that a rule ignoring shift would get exactly backwards.
    expect(shortcutFor(press('z', { mod: true }))?.id).toBe('undo')
    expect(shortcutFor(press('z', { mod: true, shift: true }))?.id).toBe('redo')
  })

  it('prefers the more specific of two matching entries', () => {
    // Both `undo` and `redo` name the z key; the one with more modifiers wins,
    // whichever order the table happens to be in.
    const shifted = press('z', { mod: true, shift: true })
    expect(matches(byId('undo'), shifted)).toBe(false)
    expect(matches(byId('redo'), shifted)).toBe(true)
  })

  it('ignores the case of the key', () => {
    // A capital S arrives when caps lock is on, and still means split.
    expect(shortcutFor(press('S'))?.id).toBe('split')
  })

  it('leaves anything with alt to the system', () => {
    expect(shortcutFor(press('s', { alt: true }))).toBeUndefined()
    expect(shortcutFor(press('z', { mod: true, alt: true }))).toBeUndefined()
  })

  it('does not answer a bare key when the shortcut wants a modifier', () => {
    expect(shortcutFor(press('o'))).toBeUndefined()
    expect(shortcutFor(press('o', { mod: true }))?.id).toBe('open')
  })

  it('tells a step from a skip by the shift key', () => {
    expect(shortcutFor(press('ArrowLeft'))?.id).toBe('stepBack')
    expect(shortcutFor(press('ArrowLeft', { shift: true }))?.id).toBe('skipBack')
  })

  it('knows nothing of a key it was never given', () => {
    expect(shortcutFor(press('q'))).toBeUndefined()
  })
})

describe('writing a shortcut down', () => {
  it('spells the modifier for the platform', () => {
    expect(labelFor('open')).toBe('Ctrl+O')
    expect(labelFor('open', true)).toBe('⌘O')
  })

  it('spells shift as part of the chord', () => {
    expect(labelFor('redo')).toBe('Ctrl+Shift+Z')
    expect(labelFor('redo', true)).toBe('⌘⇧Z')
  })

  it('names the keys that have no letter', () => {
    expect(labelFor('playPause')).toBe('Space')
    expect(labelFor('stepBack')).toBe('←')
    expect(labelFor('toStart')).toBe('Home')
  })

  it('gives every shortcut something to show', () => {
    for (const shortcut of SHORTCUTS) {
      expect(labelFor(shortcut.id), `${shortcut.id} has no label`).not.toBe('')
    }
  })
})
