// @vitest-environment happy-dom
//
// The native navigation form's page handoff beyond address suggestions:
// receiving forms of realistic size, and the opaque preview, where there is
// no Web Storage and the preview shell's bridge carries the handoff instead.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { navigationForm } from '../navigation-form.js';

const KEY = 'typeroll:page-defaults:v1:moving';

function mount(html: string): void {
  let init: (el: Element) => void = () => { throw new Error('Initializer missing'); };
  Object.assign(window, { TyperollBlocks: { register: (_id: string, callback: typeof init) => { init = callback; } } });
  document.body.innerHTML = html;
  (0, eval)(navigationForm.script!);
  init(document.querySelector('[data-block="navigation_form"]')!);
}

const field = (name: string) => `<div class="navigation-field"><input id="${name}" name="${name}" class="navigation-input" type="text"></div>`;
const value = (name: string) => (document.getElementById(name) as HTMLInputElement).value;
const BANNER = `<div data-block="navigation_form" data-handoff-key="moving" data-mode="navigate">${field('address_from')}${field('m2')}
  <div class="navigation-actions"><a data-navigation-fallback href="/preview/site/flyttfirmeoffert/?t=ticket">Continue</a><button type="button" data-navigation-continue hidden>Continue</button></div></div>`;
const RECEIVER = `<div data-block="navigation_form" data-handoff-key="moving" data-mode="receive">${['address_from', 'address_from_postal_code', 'address_to', 'm2', 'rooms', 'floor'].map(field).join('')}</div>`;

function packet(values: Record<string, string>) {
  return JSON.stringify({ version: 1, target: location.pathname, expires: Date.now() + 60_000, values });
}

let assigned: string[] = [];
beforeEach(() => {
  sessionStorage.clear();
  assigned = [];
  vi.spyOn(window.location, 'assign').mockImplementation((url: string | URL) => { assigned.push(String(url)); });
});
afterEach(() => {
  document.body.innerHTML = '';
  delete (window as unknown as Record<string, unknown>).__TYPEROLL_PREVIEW_BRIDGE__;
  vi.restoreAllMocks();
});

it('prefills a receiving form with more than four fields', () => {
  // Every field is offered with its six address parts; the allowlist must
  // admit that for any form the block can render (up to 32 fields).
  sessionStorage.setItem(KEY, packet({ address_from: 'Storgatan 1', address_from_postal_code: '111 22', address_to: 'Kungsgatan 2', m2: '75', rooms: '3', floor: '2' }));
  mount(RECEIVER);
  expect(['address_from', 'address_from_postal_code', 'address_to', 'm2', 'rooms', 'floor'].map(value))
    .toEqual(['Storgatan 1', '111 22', 'Kungsgatan 2', '75', '3', '2']);
  expect(sessionStorage.getItem(KEY)).toBeNull();
});

it('consumes an invalid handoff without prefilling anything', () => {
  sessionStorage.setItem(KEY, JSON.stringify({ version: 1, target: '/elsewhere/', expires: Date.now() + 60_000, values: { m2: '75' } }));
  mount(RECEIVER);
  expect(value('m2')).toBe('');
  expect(sessionStorage.getItem(KEY)).toBeNull();
});

function previewBridge(options: { navigates?: boolean; held?: string | null } = {}) {
  const bridge = {
    storeHandoff: vi.fn(),
    navigate: vi.fn(() => options.navigates !== false),
    takeHandoff: vi.fn(async () => options.held ?? null),
  };
  Object.defineProperty(window, '__TYPEROLL_PREVIEW_BRIDGE__', { value: bridge, configurable: true });
  return bridge;
}

it('hands off through the preview bridge and moves the shell, not the frame', () => {
  const bridge = previewBridge();
  mount(BANNER);
  (document.getElementById('address_from') as HTMLInputElement).value = 'Storgatan 1';
  (document.getElementById('m2') as HTMLInputElement).value = '75';
  (document.querySelector('[data-navigation-continue]') as HTMLElement).click();

  expect(bridge.storeHandoff).toHaveBeenCalledTimes(1);
  const [key, stored] = bridge.storeHandoff.mock.calls[0] as unknown as [string, string];
  expect(key).toBe('moving');
  expect(JSON.parse(stored)).toMatchObject({ version: 1, target: '/preview/site/flyttfirmeoffert/', values: { address_from: 'Storgatan 1', m2: '75' } });
  expect(bridge.navigate).toHaveBeenCalledWith(new URL('/preview/site/flyttfirmeoffert/?t=ticket', location.href).href);
  expect(assigned).toEqual([]);
  expect(sessionStorage.getItem(KEY)).toBeNull();
});

it('falls back to ordinary navigation when the bridge cannot route the target', () => {
  previewBridge({ navigates: false });
  mount(BANNER);
  (document.querySelector('[data-navigation-continue]') as HTMLElement).click();
  expect(assigned).toHaveLength(1);
});

it('prefills a receiving form from the handoff the preview shell kept', async () => {
  const bridge = previewBridge({ held: packet({ address_from: 'Storgatan 1', address_from_postal_code: '111 22', m2: '75' }) });
  mount(RECEIVER);
  expect(bridge.takeHandoff).toHaveBeenCalledWith('moving');
  await vi.waitFor(() => expect(value('address_from')).toBe('Storgatan 1'));
  expect(value('address_from_postal_code')).toBe('111 22');
  expect(value('m2')).toBe('75');
  expect(value('rooms')).toBe('');
});

it('leaves a preview receiving form empty when the shell holds nothing', async () => {
  const bridge = previewBridge({ held: null });
  mount(RECEIVER);
  await bridge.takeHandoff.mock.results[0]!.value;
  await Promise.resolve();
  expect(value('address_from')).toBe('');
});
