import { describe, expect, it } from 'vitest';
import { editorCanvasBridgeScript } from '../../lib/editor-canvas-bridge';
import { isolatedPreviewHeaders, PREVIEW_SANDBOX } from '../../lib/preview-headers';
import { buildExtensionEditorHostScript } from '../../lib/extensions/editor-runtime';

describe('isolated editor canvas bridge', () => {
  it('uses an opaque-origin sandbox without allow-same-origin', () => {
    expect(PREVIEW_SANDBOX).toContain('sandbox');
    expect(PREVIEW_SANDBOX).toContain('allow-scripts');
    expect(PREVIEW_SANDBOX).not.toContain('allow-same-origin');
    expect(isolatedPreviewHeaders()['Content-Security-Policy']).toBe(PREVIEW_SANDBOX);
  });

  it('binds messages to protocol and canvas id and carries editor interactions', () => {
    const script = editorCanvasBridgeScript('canvas-test-editorbridge');
    expect(script).toContain('typeroll.editor-canvas');
    expect(script).toContain('canvas-test-editorbridge');
    expect(script).toContain('event.source!==parent');
    expect(script).toContain('"geometry"');
    expect(script).toContain('"edit"');
    expect(script).toContain('data-tr-drop-indicator');
    expect(() => new Function(script)).not.toThrow();
  });

  it('keeps third-party code in a nested opaque-origin frame', () => {
    const script = buildExtensionEditorHostScript(
      { runtime_version: '0.38.0', protocol_version: 3, installations: [] },
      {},
      'site-one',
      'canvas-test-editorbridge',
    );
    expect(script).toContain('frame.setAttribute("sandbox","allow-scripts allow-forms allow-modals allow-popups")');
    expect(script).not.toContain('allow-same-origin');
    expect(() => new Function(script)).not.toThrow();
  });
});
