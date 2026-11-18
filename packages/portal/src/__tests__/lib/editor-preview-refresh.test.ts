import { afterEach, expect, it, vi } from 'vitest';
import { changesVisualPreview, changedEditorFields, createPreviewRefreshQueue } from '../../lib/editor-preview-refresh';
afterEach(() => vi.useRealTimers());
it('coalesces edits, holds draft flushes during Save, and cancels unmounted work', () => {
  vi.useFakeTimers(); const refresh = vi.fn(), queue = createPreviewRefreshQueue(refresh);
  queue.request(); queue.request(); vi.advanceTimersByTime(120); expect(refresh).toHaveBeenCalledTimes(1);
  queue.hold(); queue.request(); queue.request(); vi.advanceTimersByTime(1000); expect(refresh).toHaveBeenCalledTimes(1);
  queue.release(); vi.advanceTimersByTime(120); expect(refresh).toHaveBeenCalledTimes(2);
  queue.request(); queue.dispose(); vi.advanceTimersByTime(1000); expect(refresh).toHaveBeenCalledTimes(2);
});
it('sends changed fields only and keeps visual and head-only changes distinct', () => {
  const before = { html_content: '<p>Hello</p>', seo_title: 'Old', fields: { image: 'a' } };
  const fields = changedEditorFields({ ...before, seo_title: 'New' }, before);
  expect(fields).toEqual({ seo_title: 'New' }); expect(changesVisualPreview(fields)).toBe(false);
  expect(changesVisualPreview({ title: 'Heading' })).toBe(true);
  expect(changesVisualPreview({ fields: { image: 'b' } })).toBe(true);
  expect(changedEditorFields(before, before)).toEqual({});
});
