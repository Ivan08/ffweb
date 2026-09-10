/** Taking a step back: what counts as one step, and how far back they go. */

import { describe, expect, it } from 'vitest'

import { cleared, HISTORY_LIMIT, MERGE_MS, record, redo, undo, type History } from './history'

/** History is generic, so the value under test can be a number. */
const start = (): History<number> => cleared<number>()

/** Record a run of edits, each with its own key and clock. */
function run(steps: Array<[value: number, key: string | undefined, at: number]>): History<number> {
  let history = start()
  for (const [value, key, at] of steps) history = record(history, value, key, at)
  return history
}

describe('what counts as one step', () => {
  it('merges two edits of the same kind made close together', () => {
    // One drag of a trim handle is one intention, however many times the
    // pointer moved during it.
    const history = run([
      [1, 'clip:c1:out', 0],
      [2, 'clip:c1:out', 100],
      [3, 'clip:c1:out', 200],
    ])
    expect(history.past).toHaveLength(1)
    expect(history.past[0].value).toBe(1)
  })

  it('keeps the value from before the gesture, not the one part way through', () => {
    const history = run([
      [1, 'clip:c1:out', 0],
      [2, 'clip:c1:out', 100],
    ])
    // Undoing lands on 1 — where the clip was before the drag — not on 2.
    expect(undo(history, 3)?.present).toBe(1)
  })

  it('takes a new step once the same kind of edit comes late enough', () => {
    const history = run([
      [1, 'clip:c1:out', 0],
      [2, 'clip:c1:out', MERGE_MS + 1],
    ])
    expect(history.past).toHaveLength(2)
  })

  it('goes on merging while a slow drag continues', () => {
    // Each move is within the window of the one before it, so the whole drag
    // is one step even though it ran far longer than the window.
    const history = run([
      [1, 'clip:c1:out', 0],
      [2, 'clip:c1:out', 400],
      [3, 'clip:c1:out', 800],
      [4, 'clip:c1:out', 1200],
    ])
    expect(history.past).toHaveLength(1)
    expect(history.past[0].value).toBe(1)
  })

  it('separates two kinds of edit made at the same moment', () => {
    // Dragging the start handle and then the end handle of one clip is two
    // intentions, so the key names the fields and not just the clip.
    const history = run([
      [1, 'clip:c1:in', 0],
      [2, 'clip:c1:out', 10],
    ])
    expect(history.past).toHaveLength(2)
  })

  it('never merges a structural edit, however fast it follows', () => {
    // Two removals collapsed into one is not an undo anybody asked for.
    const history = run([
      [1, undefined, 0],
      [2, undefined, 1],
    ])
    expect(history.past).toHaveLength(2)
  })
})

describe('stepping back and forward', () => {
  it('goes back to the value before the edit', () => {
    const history = run([[1, undefined, 0]])
    const back = undo(history, 2)
    expect(back?.present).toBe(1)
    expect(back?.history.past).toHaveLength(0)
  })

  it('returns nothing at all when there is nowhere to go back to', () => {
    expect(undo(start(), 1)).toBeNull()
    expect(redo(start(), 1)).toBeNull()
  })

  it('round-trips through undo and redo', () => {
    const history = run([[1, undefined, 0]])
    const back = undo(history, 2)!
    const forward = redo(back.history, back.present)!
    expect(forward.present).toBe(2)
    expect(forward.history.past).toHaveLength(1)
    expect(forward.history.future).toHaveLength(0)
  })

  it('forgets the way forward once a new edit is made', () => {
    // Having gone a different way, the way back from is gone.
    const history = run([[1, undefined, 0]])
    const back = undo(history, 2)!
    expect(back.history.future).toHaveLength(1)

    const edited = record(back.history, back.present, undefined, 10)
    expect(edited.future).toHaveLength(0)
    expect(redo(edited, 9)).toBeNull()
  })

  it('forgets the way forward even when the new edit merges into the last step', () => {
    // The awkward case: undo leaves a step on top whose kind matches the edit
    // about to be made, and it is recent enough to merge. Merging must still
    // throw the redo stack away — otherwise redo jumps to a value that was
    // never on the way forward from here.
    const history = run([
      [1, 'clip:c1:out', 0],
      [2, 'clip:c1:in', 10],
    ])
    const back = undo(history, 3)!
    expect(back.history.future).toEqual([3])

    const merged = record(back.history, back.present, 'clip:c1:out', 100)
    expect(merged.past).toHaveLength(1)
    expect(merged.future).toHaveLength(0)
  })

  it('does not let a redone step merge with the edit that follows it', () => {
    const history = run([[1, 'clip:c1:out', 0]])
    const back = undo(history, 2)!
    const forward = redo(back.history, back.present)!
    const after = record(forward.history, forward.present, 'clip:c1:out', 10)
    expect(after.past).toHaveLength(2)
  })
})

describe('how far back it goes', () => {
  it('drops the oldest step rather than growing without end', () => {
    let history = start()
    for (let index = 0; index < HISTORY_LIMIT + 10; index += 1) {
      history = record(history, index, undefined, index * (MERGE_MS + 1))
    }
    expect(history.past).toHaveLength(HISTORY_LIMIT)
    // The floor is the oldest step still kept, not the oldest ever made.
    expect(history.past[0].value).toBe(10)
  })

  it('still walks all the way back to the floor', () => {
    let history = start()
    for (let index = 0; index < HISTORY_LIMIT + 10; index += 1) {
      history = record(history, index, undefined, index * (MERGE_MS + 1))
    }

    let present = HISTORY_LIMIT + 10
    for (let step = 0; step < HISTORY_LIMIT; step += 1) {
      const back = undo(history, present)
      expect(back, `ran out of history after ${step} steps`).not.toBeNull()
      history = back!.history
      present = back!.present
    }
    expect(present).toBe(10)
    expect(undo(history, present)).toBeNull()
  })
})
