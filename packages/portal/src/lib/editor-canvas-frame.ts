// Preview messages are accepted only from the mounted frame, its exact configured
// origin (or the opaque fallback), and this mount's random protocol identifier.
import { useEffect, useState } from 'react';
import { EDITOR_CANVAS_PROTOCOL_VERSION } from './editor-canvas-bridge';
import { PREVIEW_SANDBOX } from './preview-headers';

/** Sandbox attribute for canvas iframes: the opaque fallback used when no separate preview origin is configured. */
export const EDITOR_CANVAS_FRAME_SANDBOX = PREVIEW_SANDBOX.replace(/^sandbox\s+/, '');

export function editorCanvasSandbox(origin?: string | null): string {
  return EDITOR_CANVAS_FRAME_SANDBOX + (origin ? ' allow-same-origin' : '');
}

/** Unguessable per-mount canvas id, valid for the preview routes' `canvas` parameter. */
export function createEditorCanvasId(prefix: string): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * A canvas id created after mount, so server-rendered and hydrated markup
 * agree. Null until then: render the canvas iframe only once it is set.
 */
export function useEditorCanvasId(prefix: string): string | null {
  const [canvasId, setCanvasId] = useState<string | null>(null);
  useEffect(() => setCanvasId(createEditorCanvasId(prefix)), [prefix]);
  return canvasId;
}

/** True when `event` is a bridge message from the canvas in `frame` with `canvasId`. */
export function isEditorCanvasMessage(
  event: MessageEvent,
  frame: HTMLIFrameElement | null | undefined,
  canvasId: string | null,
  previewOrigin?: string | null,
): event is MessageEvent<Record<string, unknown>> {
  if (!canvasId || !frame?.contentWindow || event.source !== frame.contentWindow || event.origin !== (previewOrigin || 'null')) return false;
  const data = event.data as Record<string, unknown> | null;
  return !!data && typeof data === 'object'
    && data.channel === 'typeroll.editor-canvas'
    && data.version === EDITOR_CANVAS_PROTOCOL_VERSION
    && data.canvas_id === canvasId;
}
