// Parent-side helpers for the opaque-origin editor canvas (see
// editor-canvas-bridge.ts for the script that runs inside the frame).
//
// A canvas frame renders customer content. The parent accepts its messages
// only when all of these hold:
//   - they come from that frame's own window,
//   - from an opaque origin ('null'): the preview responses and the frame's
//     sandbox attribute both drop same-origin, so a frame that navigated to
//     some real origin no longer counts as the canvas,
//   - for the protocol version and this mount's random canvas id.
import { useEffect, useState } from 'react';
import { EDITOR_CANVAS_PROTOCOL_VERSION } from './editor-canvas-bridge';
import { PREVIEW_SANDBOX } from './preview-headers';

/** Sandbox attribute for canvas iframes: the same flags the preview responses send, never allow-same-origin. */
export const EDITOR_CANVAS_FRAME_SANDBOX = PREVIEW_SANDBOX.replace(/^sandbox\s+/, '');

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
): event is MessageEvent<Record<string, unknown>> {
  if (!canvasId || !frame?.contentWindow || event.source !== frame.contentWindow || event.origin !== 'null') return false;
  const data = event.data as Record<string, unknown> | null;
  return !!data && typeof data === 'object'
    && data.channel === 'typeroll.editor-canvas'
    && data.version === EDITOR_CANVAS_PROTOCOL_VERSION
    && data.canvas_id === canvasId;
}
