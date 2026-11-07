// Copy and paste of blocks in the block editor (the format is in shared
// block-clipboard.ts; the server routes are /api/sites/{id}/clipboard/*).
//
// Copying asks the server for the clipboard (it adds the styles, block types
// and global blocks the blocks use) and writes it to the system clipboard:
// the JSON as text/plain, so a paste in any Typeroll editor finds it, and,
// where the browser takes several flavours, the blocks' text as text/html
// for pasting into a document or e-mail. Pasting prefers the paste event's
// clipboardData, which needs no permission; when the browser fires no paste
// event outside a text field (Safari), it falls back to reading the
// clipboard after Cmd/Ctrl+V. Text that is not copied Typeroll blocks is
// ignored, and keys in text fields and contenteditable keep their usual
// meaning.

import { looksLikeBlockClipboard, type Block } from '@typeroll/shared';

export interface CopyResponse {
  clipboard_text: string;
  clipboard_html: string;
  count: { top: number; total: number };
  warnings: string[];
}

export interface PasteResponse {
  page: { id: string; added_ids: string[]; blocks: Block[] };
  mode: 'same_site' | 'other_site';
  media: { copied: number; reused: number; left_out: number; kept_external: number };
  message: string;
  report: { warnings?: string[] };
}

type ClipboardLike = Pick<Clipboard, 'writeText'> & Partial<Pick<Clipboard, 'write' | 'readText'>>;

export const clipboardApi = (siteId: string) => `/api/sites/${encodeURIComponent(siteId)}/clipboard`;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function failure(response: Response, action: string): Promise<Error> {
  const body = await response.json().catch(() => ({})) as { error?: string };
  return new Error(body.error || `${action} failed (${response.status})`);
}

async function requestCopy(siteId: string, pageId: string, blockIds: string[]): Promise<CopyResponse> {
  const response = await fetch(`${clipboardApi(siteId)}/copy`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ page_id: pageId, block_ids: blockIds }),
  });
  if (!response.ok) throw await failure(response, 'Copying');
  return await response.json() as CopyResponse;
}

/**
 * Copy blocks of a page's draft to the system clipboard. A ClipboardItem
 * built from a promise keeps the key press's permission while the server
 * answers; browsers without it get the JSON through writeText.
 */
export async function copyBlocksToClipboard(siteId: string, pageId: string, blockIds: string[], clipboard: ClipboardLike | undefined = globalThis.navigator?.clipboard): Promise<CopyResponse> {
  if (!clipboard) throw new Error('This browser does not allow writing to the clipboard here.');
  const pending = requestCopy(siteId, pageId, blockIds);
  const Item = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
  if (Item && clipboard.write) {
    try {
      await clipboard.write([new Item({
        'text/plain': pending.then(result => new Blob([result.clipboard_text], { type: 'text/plain' })),
        'text/html': pending.then(result => new Blob([result.clipboard_html], { type: 'text/html' })),
      })]);
      return await pending;
    } catch (error) {
      // A refused copy request is the answer; a refused write gets one more try as text.
      await pending;
      void error;
    }
  }
  const result = await pending;
  await clipboard.writeText(result.clipboard_text);
  return result;
}

/** Paste copied blocks after a block (or at the end of the page). */
export async function pasteClipboardText(siteId: string, pageId: string, text: string, afterBlockId?: string | null): Promise<PasteResponse> {
  const response = await fetch(`${clipboardApi(siteId)}/paste`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clipboard: text, page_id: pageId, ...(afterBlockId ? { after_block_id: afterBlockId } : {}) }),
  });
  if (!response.ok) throw await failure(response, 'Pasting');
  return await response.json() as PasteResponse;
}

/** "Copied 1 block", "Cut 2 blocks". */
export function copiedLine(count: number, cut = false): string {
  return `${cut ? 'Cut' : 'Copied'} ${plural(count, 'block')}`;
}

/** The server's line ("Pasted 2 blocks; created the style Hero (imported)"), with the first warning. */
export function pastedLine(result: Pick<PasteResponse, 'message' | 'report'>): string {
  const warnings = result.report?.warnings ?? [];
  return warnings.length ? `${result.message}. ${warnings[0]}${warnings.length > 1 ? ` (+${warnings.length - 1} more)` : ''}` : result.message;
}

/** Text fields and contenteditable keep their own copy, cut and paste. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== 'string') return false;
  return element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT' || element.isContentEditable === true
    || (typeof element.closest === 'function' && element.closest('[contenteditable]:not([contenteditable="false"])') !== null);
}

export interface ClipboardShortcutHandlers {
  /** Whether a block is selected to copy. */
  canCopy(): boolean;
  copy(cut: boolean): void;
  /** Called with clipboard text that holds copied Typeroll blocks. */
  paste(text: string): void;
  /** Reads the clipboard when the browser fires no paste event (default: navigator.clipboard.readText). */
  readText?(): Promise<string>;
}

/**
 * Cmd/Ctrl+C, X and V for blocks. Selected text is copied as text, as usual;
 * nothing happens in text fields. Returns the function that removes the
 * listeners.
 */
export function installClipboardShortcuts(win: Window, handlers: ClipboardShortcutHandlers, options: { fallbackMs?: number } = {}): () => void {
  let pending: ReturnType<typeof setTimeout> | null = null;
  const clear = () => { if (pending !== null) { clearTimeout(pending); pending = null; } };
  const readText = handlers.readText ?? (() => win.navigator.clipboard?.readText?.() ?? Promise.resolve(''));
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey) || isEditableTarget(event.target)) return;
    const key = event.key.toLowerCase();
    if (key === 'c' || key === 'x') {
      if ((win.getSelection?.()?.toString() ?? '') !== '' || !handlers.canCopy()) return;
      event.preventDefault();
      handlers.copy(key === 'x');
    } else if (key === 'v') {
      clear();
      pending = setTimeout(() => {
        pending = null;
        readText().then(text => { if (looksLikeBlockClipboard(text)) handlers.paste(text); }, () => { /* No permission: nothing to paste. */ });
      }, options.fallbackMs ?? 150);
    }
  };
  const onPaste = (event: ClipboardEvent) => {
    if (isEditableTarget(event.target)) return;
    clear();
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (!looksLikeBlockClipboard(text)) return;
    event.preventDefault();
    handlers.paste(text);
  };
  win.addEventListener('keydown', onKey);
  win.addEventListener('paste', onPaste);
  return () => { clear(); win.removeEventListener('keydown', onKey); win.removeEventListener('paste', onPaste); };
}

/** Read the clipboard for a Paste button, and keep only copied blocks. */
export async function readBlockClipboard(clipboard: Partial<Pick<Clipboard, 'readText'>> | undefined = globalThis.navigator?.clipboard): Promise<string | null> {
  if (!clipboard?.readText) throw new Error('This browser does not allow reading the clipboard here; press ⌘V / Ctrl+V instead.');
  const text = await clipboard.readText();
  return looksLikeBlockClipboard(text) ? text : null;
}
