// Undo/redo stack for the block editor. Pure and framework-free so it's
// unit-testable; BlockPageEditor owns the wiring (apply = PUT the snapshot
// back into the page's working copy — the buffer model makes undo cheap:
// nothing here ever touches the saved page).
//
// The stack holds full Block[] snapshots INCLUDING the current state:
// stack[index] is always what the editor shows. That makes network-failure
// recovery a pointer move (revertUndo/revertRedo) instead of stack surgery.
// Snapshots are cheap: block trees are small (tens of nodes) and treated
// immutably (every entry is a fresh server response, never mutated).

import type { Block } from '@typeroll/shared';

export interface BlockHistory {
  /** Reset to a single baseline state (initial load, external refresh). */
  init(blocks: Block[]): void;
  /**
   * Record the state AFTER a successful mutation. `sig` coalesces bursts:
   * consecutive records with the same sig within the coalesce window
   * replace the current entry instead of pushing (so debounced field
   * typing is one undo step back to the pre-burst state, not N).
   */
  record(next: Block[], sig?: string): void;
  /** Step back; returns the snapshot to apply, or null at the bottom. */
  undo(): Block[] | null;
  /** Step forward; returns the snapshot to apply, or null at the top. */
  redo(): Block[] | null;
  /** Roll the pointer back after a FAILED apply of undo()/redo(). */
  revertUndo(): void;
  revertRedo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
}

interface Entry {
  blocks: Block[];
  sig?: string;
  at: number;
}

export function createBlockHistory(opts?: {
  cap?: number;
  coalesceMs?: number;
  now?: () => number;
}): BlockHistory {
  const cap = opts?.cap ?? 100;
  const coalesceMs = opts?.coalesceMs ?? 2500;
  const now = opts?.now ?? (() => Date.now());

  let stack: Entry[] = [{ blocks: [], at: 0 }];
  let index = 0;

  return {
    init(blocks) {
      stack = [{ blocks, at: now() }];
      index = 0;
    },
    record(next, sig) {
      const t = now();
      const cur = stack[index];
      const atTop = index === stack.length - 1;
      if (sig && atTop && cur.sig === sig && t - cur.at < coalesceMs && index > 0) {
        // Same burst: the restore point (stack[index-1]) stays put; only
        // the current state advances.
        stack[index] = { blocks: next, sig, at: t };
        return;
      }
      stack = stack.slice(0, index + 1);
      stack.push({ blocks: next, sig, at: t });
      if (stack.length > cap) stack.shift();
      index = stack.length - 1;
    },
    undo() {
      if (index === 0) return null;
      index -= 1;
      return stack[index].blocks;
    },
    redo() {
      if (index >= stack.length - 1) return null;
      index += 1;
      return stack[index].blocks;
    },
    revertUndo() {
      if (index < stack.length - 1) index += 1;
    },
    revertRedo() {
      if (index > 0) index -= 1;
    },
    canUndo: () => index > 0,
    canRedo: () => index < stack.length - 1,
  };
}
