// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Media } from '@typeroll/shared';
import MediaPicker from '../../components/MediaPicker';
import MediaDetail from '../../components/MediaDetail';
import MediaLibrary from '../../components/MediaLibrary';

let root: Root;
const item = (id: string, failed = false) => ({ id, filename: `${id}.jpg`, cdn_url: `https://cms.example.com/api/sites/site/media/${id}/content`,
  created_at: '2026-01-01T00:00:00Z', mime_type: 'image/jpeg', source_url: 'https://source.example.com/a.jpg',
  import_pending: id !== 'ready', storage: { state: id === 'ready' ? 'ready' : 'uploading' }, migration_failed: failed } as unknown as Media);
const items = [item('ready'), item('pending'), item('failed', true)];
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); });
async function render(component: ReturnType<typeof createElement>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(component)); return container;
}

it('disables unavailable picker entries without requesting their image URLs', async () => {
  const change = vi.fn(); vi.stubGlobal('fetch', vi.fn(async () => Response.json(items)));
  const container = await render(createElement(MediaPicker, { value: '', onChange: change, siteId: 'site' }));
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Media library')!.click());
  const tiles = [...container.querySelectorAll<HTMLButtonElement>('.media-picker__tile')];
  expect(tiles.map(tile => tile.disabled)).toEqual([false, true, true]);
  expect(container.querySelectorAll('img')).toHaveLength(1);
  expect(container.querySelector('img')?.src).toBe(items[0].cdn_url);
  await act(async () => { tiles[1].click(); tiles[2].click(); }); expect(change).not.toHaveBeenCalled();
  await act(async () => tiles[0].click()); expect(change).toHaveBeenCalledExactlyOnceWith(items[0].cdn_url);
});

it('reports a stopped import in details without promising a finishing upload or preview', async () => {
  const container = await render(createElement(MediaDetail, { siteId: 'site', item: items[2], onClose: vi.fn(), onUpdated: vi.fn(), onDeleted: vi.fn() }));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not be imported or copied');
  expect(container.textContent).not.toContain('Finishing upload');
  expect(container.textContent).toContain('No verified file is available');
  expect(container.textContent).not.toContain('Publish a page that uses this file');
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('a[href="' + items[2].cdn_url + '"]')).toBeNull();
});

it('refreshes a completed pending import when the picker is reopened', async () => {
  let current = [item('pending')];
  const fetcher = vi.fn(async () => Response.json(current)); vi.stubGlobal('fetch', fetcher);
  const change = vi.fn();
  const container = await render(createElement(MediaPicker, { value: '', onChange: change, siteId: 'site' }));
  const toggle = () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Media library')!;
  await act(async () => toggle().click());
  expect(container.querySelector<HTMLButtonElement>('.media-picker__tile')?.disabled).toBe(true);
  await act(async () => toggle().click());
  current = [{ ...item('pending'), storage: { state: 'ready' } } as Media];
  await act(async () => toggle().click());
  const tile = container.querySelector<HTMLButtonElement>('.media-picker__tile')!;
  expect(tile.disabled).toBe(false);
  await act(async () => tile.click());
  expect(change).toHaveBeenCalledExactlyOnceWith(current[0].cdn_url);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('also refuses unavailable files in the selectable library', async () => {
  const select = vi.fn(); vi.stubGlobal('fetch', vi.fn(async () => Response.json({ enabled: true, state: 'complete', completed: 0, total: 0 })));
  const container = await render(createElement(MediaLibrary, { siteId: 'site', initialItems: items, selectable: true, onSelect: select }));
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')].filter(button => button.textContent === 'Select');
  expect(buttons.map(button => button.disabled)).toEqual([false, true, true]);
  await act(async () => { buttons[1].click(); buttons[2].click(); }); expect(select).not.toHaveBeenCalled();
});
