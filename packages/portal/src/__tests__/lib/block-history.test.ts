// Undo/redo stack semantics for the block editor (components/block-history).
// The invariant that matters: stack[index] always mirrors the server's
// working-copy state, so a failed network apply must be recoverable with a
// pure pointer move (revertUndo/revertRedo).

import { describe, it, expect } from 'vitest';
import { createBlockHistory } from '../../components/block-history';
import type { Block } from '@typeroll/shared';

const b = (id: string): Block[] => [{ id, type: 'core/prose', data: {} } as Block];

function make(nowRef: { t: number }, opts?: { cap?: number; coalesceMs?: number }) {
  return createBlockHistory({ ...opts, now: () => nowRef.t });
}

describe('block history', () => {
  it('undo walks back through recorded states, redo walks forward', () => {
    const now = { t: 0 };
    const h = make(now);
    h.init(b('s0'));
    h.record(b('s1'));
    h.record(b('s2'));

    expect(h.canUndo()).toBe(true);
    expect(h.undo()![0].id).toBe('s1');
    expect(h.undo()![0].id).toBe('s0');
    expect(h.undo()).toBeNull();
    expect(h.redo()![0].id).toBe('s1');
    expect(h.redo()![0].id).toBe('s2');
    expect(h.redo()).toBeNull();
  });

  it('recording after an undo drops the redo branch', () => {
    const now = { t: 0 };
    const h = make(now);
    h.init(b('s0'));
    h.record(b('s1'));
    h.undo();
    h.record(b('s1b'));
    expect(h.canRedo()).toBe(false);
    expect(h.undo()![0].id).toBe('s0');
    expect(h.redo()![0].id).toBe('s1b');
  });

  it('same-signature records inside the window coalesce into one step', () => {
    const now = { t: 0 };
    const h = make(now, { coalesceMs: 1000 });
    h.init(b('s0'));
    now.t = 100; h.record(b('t1'), 'patch:x:text');
    now.t = 500; h.record(b('t2'), 'patch:x:text');   // coalesced
    now.t = 900; h.record(b('t3'), 'patch:x:text');   // coalesced (window slides)
    // One undo returns to the pre-burst state, not t2/t1.
    expect(h.undo()![0].id).toBe('s0');
    expect(h.redo()![0].id).toBe('t3');
  });

  it('a different signature or an expired window starts a new step', () => {
    const now = { t: 0 };
    const h = make(now, { coalesceMs: 1000 });
    h.init(b('s0'));
    now.t = 100; h.record(b('t1'), 'patch:x:text');
    now.t = 200; h.record(b('u1'), 'patch:y:text');   // other field → new step
    now.t = 2000; h.record(b('u2'), 'patch:y:text');  // window expired → new step
    expect(h.undo()![0].id).toBe('u1');
    expect(h.undo()![0].id).toBe('t1');
    expect(h.undo()![0].id).toBe('s0');
  });

  it('never coalesces into the baseline (first record after init is always a step)', () => {
    const now = { t: 0 };
    const h = make(now, { coalesceMs: 1000 });
    h.init(b('s0'));
    now.t = 10; h.record(b('t1'), 'sig');
    now.t = 20; h.record(b('t2'), 'sig'); // coalesces with t1, not with s0
    expect(h.undo()![0].id).toBe('s0');
  });

  it('revertUndo/revertRedo restore the pointer after a failed apply', () => {
    const now = { t: 0 };
    const h = make(now);
    h.init(b('s0'));
    h.record(b('s1'));

    expect(h.undo()![0].id).toBe('s0');
    h.revertUndo(); // network failed — still at s1
    expect(h.canRedo()).toBe(false);
    expect(h.undo()![0].id).toBe('s0'); // retry works

    expect(h.redo()![0].id).toBe('s1');
    h.revertRedo(); // network failed — still at s0, redo stays available
    expect(h.canRedo()).toBe(true);
    expect(h.redo()![0].id).toBe('s1');
  });

  it('caps the stack by dropping the oldest entries', () => {
    const now = { t: 0 };
    const h = make(now, { cap: 3 });
    h.init(b('s0'));
    for (let i = 1; i <= 5; i++) { now.t = i * 10_000; h.record(b(`s${i}`)); }
    // cap=3 → only the two most recent restore points survive.
    expect(h.undo()![0].id).toBe('s4');
    expect(h.undo()![0].id).toBe('s3');
    expect(h.undo()).toBeNull();
  });

  it('init resets everything (external refresh)', () => {
    const now = { t: 0 };
    const h = make(now);
    h.init(b('s0'));
    h.record(b('s1'));
    h.init(b('fresh'));
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
    expect(h.undo()).toBeNull();
  });
});
