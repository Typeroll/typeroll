// @vitest-environment happy-dom
//
// The behaviour M26 exists for, exercised against the real runtime string.
//
// Both acceptance directions: with the capability registered, an opted-in
// field binds and its structured components survive the handoff; with nothing
// registered — no key, a blocked script, the editor canvas, the preview shell
// — the field stays a plain input, navigation still works, and nothing throws.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { navigationForm } from '../navigation-form.js';

interface CapturedAttach { input: HTMLInputElement; options: { country?: string }; onSelect: (parts: Record<string, string>) => void }

function mount(html: string): (el: Element) => void {
  let init: (el: Element) => void = () => { throw new Error('Initializer missing'); };
  Object.assign(window, { TyperollBlocks: { register: (_id: string, callback: typeof init) => { init = callback; } } });
  document.body.innerHTML = html;
  (0, eval)(navigationForm.script!);
  return init;
}

const BANNER = `<div id="navigation-b1" data-block="navigation_form" data-handoff-key="page-defaults" data-mode="navigate" data-address-country="se">
  <div class="navigation-field"><input id="a" name="address_from" class="navigation-input" type="text" data-navigation-suggest="address"></div>
  <div class="navigation-field"><input id="r" name="rooms" class="navigation-input" type="text"></div>
  <div class="navigation-actions"><a data-navigation-fallback href="/offert/">Continue</a><button type="button" data-navigation-continue hidden>Continue</button></div>
</div>`;

let assigned = '';
// A block that never binds keeps listening for a late loader, which is correct
// on a real page and leaks between tests here, since one document is reused.
// Tracked and torn down so each test sees only its own block.
const listeners: Array<[string, EventListenerOrEventListenerObject]> = [];
const addEventListener = document.addEventListener.bind(document);

beforeEach(() => {
  sessionStorage.clear();
  assigned = '';
  listeners.length = 0;
  document.addEventListener = ((type: string, handler: EventListenerOrEventListenerObject, options?: unknown) => {
    listeners.push([type, handler]);
    addEventListener(type, handler, options as AddEventListenerOptions);
  }) as typeof document.addEventListener;
  vi.spyOn(window.location, 'assign').mockImplementation((url: string) => { assigned = String(url); });
});
afterEach(() => {
  for (const [type, handler] of listeners) document.removeEventListener(type, handler);
  document.addEventListener = addEventListener;
  document.body.innerHTML = '';
  delete (window as unknown as Record<string, unknown>).TyperollClientCapabilities;
  vi.restoreAllMocks();
});

function registerCapability(): CapturedAttach[] {
  const calls: CapturedAttach[] = [];
  (window as unknown as Record<string, unknown>).TyperollClientCapabilities = {
    address_autocomplete: {
      attach: (input: HTMLInputElement, options: { country?: string }, onSelect: (p: Record<string, string>) => void) => {
        calls.push({ input, options, onSelect });
        return true;
      },
    },
  };
  return calls;
}

function stored() {
  const raw = sessionStorage.getItem('typeroll:page-defaults:v1:page-defaults');
  return raw ? JSON.parse(raw).values as Record<string, string> : null;
}

it('binds only the opted-in field, and passes the block country restriction', () => {
  const calls = registerCapability();
  mount(BANNER)(document.getElementById('navigation-b1')!);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.input.name).toBe('address_from');
  expect(calls[0]!.options.country).toBe('se');
});

it('carries structured components through the handoff, not only the display string', () => {
  const calls = registerCapability();
  mount(BANNER)(document.getElementById('navigation-b1')!);
  const input = document.getElementById('a') as HTMLInputElement;
  input.value = 'Storgatan 1, Stockholm';
  calls[0]!.onSelect({ street: 'Storgatan', street_number: '1', postal_code: '111 22', locality: 'Stockholm', country: 'SE' });

  (document.querySelector('[data-navigation-continue]') as HTMLElement).click();

  expect(stored()).toMatchObject({
    address_from: 'Storgatan 1, Stockholm',
    address_from_street: 'Storgatan',
    address_from_street_number: '1',
    address_from_postal_code: '111 22',
    address_from_locality: 'Stockholm',
  });
  expect(assigned).toContain('/offert/');
});

it('drops the components when the visitor edits the field after selecting', () => {
  // Otherwise the destination receives parts describing a different address
  // from the one the visitor can see in the box.
  const calls = registerCapability();
  mount(BANNER)(document.getElementById('navigation-b1')!);
  const input = document.getElementById('a') as HTMLInputElement;
  input.value = 'Storgatan 1, Stockholm';
  calls[0]!.onSelect({ street: 'Storgatan', postal_code: '111 22' });
  input.value = 'Storgatan 9, Stockholm';

  (document.querySelector('[data-navigation-continue]') as HTMLElement).click();
  const values = stored()!;
  expect(values.address_from).toBe('Storgatan 9, Stockholm');
  expect(values.address_from_street).toBeUndefined();
  expect(values.address_from_postal_code).toBeUndefined();
});

it('falls back to a plain input when nothing registers, and still navigates', () => {
  // The no-key case, and the editor canvas and preview shell cases, are all
  // this one: no capability on the page.
  mount(BANNER)(document.getElementById('navigation-b1')!);
  const input = document.getElementById('a') as HTMLInputElement;
  input.value = 'Storgatan 1';
  (document.querySelector('[data-navigation-continue]') as HTMLElement).click();

  expect(stored()).toEqual({ address_from: 'Storgatan 1', rooms: '' });
  expect(assigned).toContain('/offert/');
});

it('binds when the loader registers after the block initialised', () => {
  // Script order between the head loader and the end-of-body block runtime is
  // not guaranteed, so both orders have to work.
  mount(BANNER)(document.getElementById('navigation-b1')!);
  const calls = registerCapability();
  document.dispatchEvent(new CustomEvent('typeroll:capability', { detail: { name: 'address_autocomplete' } }));
  expect(calls).toHaveLength(1);
});

it('ignores an unrelated capability announcement', () => {
  mount(BANNER)(document.getElementById('navigation-b1')!);
  const calls = registerCapability();
  document.dispatchEvent(new CustomEvent('typeroll:capability', { detail: { name: 'something_else' } }));
  expect(calls).toHaveLength(0);
});

it('survives a provider whose attach throws, leaving the field usable', () => {
  (window as unknown as Record<string, unknown>).TyperollClientCapabilities = {
    address_autocomplete: { attach: () => { throw new Error('provider exploded'); } },
  };
  expect(() => mount(BANNER)(document.getElementById('navigation-b1')!)).not.toThrow();
  (document.getElementById('a') as HTMLInputElement).value = 'Storgatan 1';
  (document.querySelector('[data-navigation-continue]') as HTMLElement).click();
  expect(stored()!.address_from).toBe('Storgatan 1');
});

it('prefills structured parts on the receiving page', () => {
  sessionStorage.setItem('typeroll:page-defaults:v1:page-defaults', JSON.stringify({
    version: 1,
    target: location.pathname,
    expires: Date.now() + 60_000,
    values: { address_from: 'Storgatan 1', address_from_postal_code: '111 22' },
  }));
  const receiver = `<div id="navigation-r1" data-block="navigation_form" data-handoff-key="page-defaults" data-mode="receive">
    <div class="navigation-field"><input id="f" name="address_from" class="navigation-input" type="text"></div>
    <div class="navigation-field"><input id="p" name="address_from_postal_code" class="navigation-input" type="text"></div>
  </div>`;
  mount(receiver)(document.getElementById('navigation-r1')!);
  expect((document.getElementById('f') as HTMLInputElement).value).toBe('Storgatan 1');
  expect((document.getElementById('p') as HTMLInputElement).value).toBe('111 22');
});
