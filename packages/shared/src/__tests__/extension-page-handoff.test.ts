// context.handoff, exercised against the real browser host.
//
// A native navigation form on the previous page wrote the handoff. The
// component asks only for "the values the visitor already typed on the way
// here": it never names a storage key and never touches Web Storage. These
// tests run the generated runtime in happy-dom, on a published page (tab
// storage) and in an opaque preview (the parent shell's postMessage bridge).

import { afterEach, describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { buildExtensionRuntimeScript } from '../extensions-runtime';
import type { ExtensionRuntimeHostConfig, ExtensionRuntimeSnapshot } from '../extensions';

const KEY = 'typeroll:page-defaults:v1:moveria-moving';
const BRIDGE = { id: '12345678-1234-1234-1234-123456789abc', parent_origin: 'https://app.typeroll.com' };
const VALUES = {
  address_from: 'Storgatan 1, 111 22 Stockholm',
  address_from_street: 'Storgatan',
  address_from_street_number: '1',
  address_from_postal_code: '111 22',
  address_from_locality: 'Stockholm',
  address_from_country: 'SE',
  address_to: 'Kungsgatan 2, Uppsala',
  m2: '75',
};

function packet(patch: Record<string, unknown> = {}, target = '/flyttfirmeoffert/') {
  return JSON.stringify({ version: 1, target, expires: Date.now() + 600_000, values: VALUES, ...patch });
}

interface Mount { props: Record<string, unknown>; context: { handoff?: { key: string | null; read(): Promise<unknown> } } & Record<string, unknown> }

interface RunOptions {
  url?: string;
  stored?: string | null;
  preview?: { handoff?: Record<string, string> } | 'no-bridge';
  declares?: boolean;
  props?: Array<Record<string, unknown>>;
}

const windows: Window[] = [];
afterEach(async () => {
  for (const browser of windows.splice(0)) await browser.happyDOM.close();
});

async function run(options: RunOptions = {}) {
  const browser = new Window({ url: options.url ?? 'https://moveria.example/flyttfirmeoffert/', settings: { disableIframePageLoading: true } });
  windows.push(browser);
  const preview = options.preview !== undefined;
  const bridged = options.preview && options.preview !== 'no-bridge' ? options.preview : null;
  if (options.stored) browser.sessionStorage.setItem(KEY, options.stored);
  if (preview) {
    // An opaque origin has no Web Storage at all.
    Object.defineProperty(browser, 'sessionStorage', { get() { throw new Error('SecurityError'); } });
  }
  const mounts: Mount[] = [];
  const posted: Array<Record<string, unknown>> = [];
  (browser as unknown as Record<string, unknown>).__importForTest = async () => ({
    mount: (_el: unknown, props: Record<string, unknown>, context: Mount['context']) => { mounts.push({ props, context }); },
  });
  browser.postMessage = ((message: Record<string, unknown>) => { posted.push(message); }) as typeof browser.postMessage;
  const snapshot: ExtensionRuntimeSnapshot = {
    runtime_version: '0.43.0',
    protocol_version: 3,
    installations: [{
      installation_id: 'market-engine', extension_id: 'se.autopilot.market-engine', version: '1.0.0', public_config: {},
      ...(preview ? { preview: true as const } : {}),
      components: [{
        id: 'lead-form', block_type_id: 'extension--market-engine--lead-form', label: 'Lead form',
        render_mode: 'bundled_component', local_script_url: 'test:lead-form',
        entry: { script_url: 'https://cdn.example/lead-form.js', script_sha256: 'a'.repeat(64) },
        ...(options.declares === false ? {} : { page_handoff: true }),
      }],
    }],
  };
  const host: ExtensionRuntimeHostConfig = bridged ? { preview_bridge: BRIDGE } : {};
  const runtime = buildExtensionRuntimeScript(snapshot, host);
  // happy-dom cannot import an ES module from an evaluated script; everything
  // else is the shipped runtime.
  const testable = runtime.replace('await import(component.local_script_url)', 'await window.__importForTest(component.local_script_url)');
  expect(testable).not.toBe(runtime);
  for (const props of options.props ?? [{ page_handoff_key: 'moveria-moving' }]) {
    const el = browser.document.createElement('div');
    el.setAttribute('data-tr-extension-installation', 'market-engine');
    el.setAttribute('data-tr-extension-component', 'lead-form');
    el.setAttribute('data-block-data', JSON.stringify(props));
    browser.document.body.appendChild(el);
  }
  browser.eval(testable);
  browser.document.dispatchEvent(new browser.Event('DOMContentLoaded'));
  if (bridged) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(posted).toContainEqual(expect.objectContaining({ action: 'storage.ready', bridge_id: BRIDGE.id }));
    browser.dispatchEvent(new browser.MessageEvent('message', {
      // The evaluated script's own global, which is what `parent` is there.
      source: browser.eval('parent') as never,
      origin: BRIDGE.parent_origin,
      data: {
        channel: 'typeroll.extension-preview', version: 1, bridge_id: BRIDGE.id, action: 'storage.init',
        storage: { session: {}, local: {}, ...(bridged.handoff ? { handoff: bridged.handoff } : {}) },
      },
    }));
  }
  for (let i = 0; i < 50 && mounts.length < (options.props?.length ?? 1); i++) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(mounts).toHaveLength(options.props?.length ?? 1);
  return { browser, mounts, posted };
}

describe('context.handoff on a published page', () => {
  it('delivers the values and structured address parts a native banner collected', async () => {
    const { browser, mounts } = await run({ stored: packet() });
    const handoff = mounts[0]!.context.handoff!;
    expect(handoff.key).toBe('moveria-moving');
    const received = await handoff.read();
    expect(received).toEqual({
      key: 'moveria-moving',
      source: 'navigation_form',
      values: VALUES,
      parts: {
        address_from: { street: 'Storgatan', street_number: '1', postal_code: '111 22', locality: 'Stockholm', country: 'SE' },
      },
    });
    // Taken out of tab storage like the native receiving form does, so a
    // reload or another page cannot replay it; this mount keeps its copy.
    expect(browser.sessionStorage.getItem(KEY)).toBeNull();
    expect(await handoff.read()).toEqual(received);
  });

  it('gives every bound mount on the page the same values', async () => {
    const { mounts } = await run({ stored: packet(), props: [{ page_handoff_key: 'moveria-moving' }, { page_handoff_key: 'moveria-moving' }] });
    const [first, second] = await Promise.all(mounts.map((mount) => mount.context.handoff!.read()));
    expect(first).toEqual(second);
    expect((first as { values: Record<string, string> }).values.m2).toBe('75');
  });

  it.each([
    ['absent', null],
    ['expired', packet({ expires: Date.now() - 1 })],
    ['implausibly long-lived', packet({ expires: Date.now() + 3_600_000 })],
    ['for another page', packet({}, '/stadoffert/')],
    ['from an unknown format', packet({ version: 2 })],
    ['malformed', '{"version":1,'],
  ])('resolves null for a handoff that is %s, without throwing', async (_label, stored) => {
    const { browser, mounts } = await run({ stored });
    await expect(mounts[0]!.context.handoff!.read()).resolves.toBeNull();
    expect(browser.sessionStorage.getItem(KEY)).toBeNull();
  });

  it('keeps unsafe names and non-string values out of the result', async () => {
    const { mounts } = await run({
      stored: JSON.stringify({
        version: 1, target: '/flyttfirmeoffert/', expires: Date.now() + 60_000,
        values: { address_from: 'Ok', constructor: 'x', access_token: 'x', m2: 75, __proto__x: 'x', note: 'n'.repeat(513) },
      }),
    });
    expect(await mounts[0]!.context.handoff!.read()).toEqual({ key: 'moveria-moving', source: 'navigation_form', values: { address_from: 'Ok' }, parts: {} });
  });

  it('resolves null and leaves the handoff alone for an unbound instance', async () => {
    const { browser, mounts } = await run({ stored: packet(), props: [{}] });
    expect(mounts[0]!.context.handoff!.key).toBeNull();
    await expect(mounts[0]!.context.handoff!.read()).resolves.toBeNull();
    expect(browser.sessionStorage.getItem(KEY)).not.toBeNull();
  });

  it('resolves null for another key than the one the author bound', async () => {
    const { browser, mounts } = await run({ stored: packet(), props: [{ page_handoff_key: 'moveria-cleaning' }] });
    await expect(mounts[0]!.context.handoff!.read()).resolves.toBeNull();
    expect(browser.sessionStorage.getItem(KEY)).not.toBeNull();
  });

  it('withholds the handoff from a component whose access was not granted', async () => {
    // The snapshot carries page_handoff only when the component declared it
    // and the installation was granted page_handoff:read.
    const { browser, mounts } = await run({ stored: packet(), declares: false });
    expect(mounts[0]!.context.handoff!.key).toBeNull();
    await expect(mounts[0]!.context.handoff!.read()).resolves.toBeNull();
    expect(browser.sessionStorage.getItem(KEY)).not.toBeNull();
  });
});

describe('context.handoff in an opaque preview', () => {
  it('reads the handoff the parent shell kept for the tab and tells the shell it was taken', async () => {
    const { mounts, posted } = await run({ preview: { handoff: { 'moveria-moving': packet() } } });
    const received = await mounts[0]!.context.handoff!.read() as { values: Record<string, string>; parts: Record<string, Record<string, string>> };
    expect(received.values).toEqual(VALUES);
    expect(received.parts.address_from!.postal_code).toBe('111 22');
    expect(posted).toContainEqual({
      channel: 'typeroll.extension-preview', version: 1, bridge_id: BRIDGE.id, action: 'handoff.remove', key: 'moveria-moving',
    });
  });

  it('resolves null when the shell holds nothing or something expired', async () => {
    for (const handoff of [undefined, { 'moveria-moving': packet({ expires: Date.now() - 1 }) }]) {
      const { mounts } = await run({ preview: { handoff } });
      await expect(mounts[0]!.context.handoff!.read()).resolves.toBeNull();
    }
  });

  it('resolves null without a bridge, where the frame has no storage at all', async () => {
    const { mounts } = await run({ preview: 'no-bridge' });
    await expect(mounts[0]!.context.handoff!.read()).resolves.toBeNull();
  });
});

describe('embedded applications', () => {
  it('answer a handoff request through the versioned message bridge', async () => {
    const browser = new Window({ url: 'https://moveria.example/flyttfirmeoffert/', settings: { disableIframePageLoading: true } });
    windows.push(browser);
    browser.sessionStorage.setItem(KEY, packet());
    const runtime = buildExtensionRuntimeScript({
      runtime_version: '0.43.0', protocol_version: 3,
      installations: [{
        installation_id: 'market-engine', extension_id: 'se.autopilot.market-engine', version: '1.0.0', public_config: {},
        components: [{
          id: 'lead-form', block_type_id: 'extension--market-engine--lead-form', label: 'Lead form', page_handoff: true,
          render_mode: 'embedded_app', entry: { frame_url: 'https://app.market-engine.example/lead' },
        }],
      }],
    });
    const el = browser.document.createElement('div');
    el.setAttribute('data-tr-extension-installation', 'market-engine');
    el.setAttribute('data-tr-extension-component', 'lead-form');
    el.setAttribute('data-block-data', JSON.stringify({ page_handoff_key: 'moveria-moving' }));
    browser.document.body.appendChild(el);
    // The provider frame never loads here; stand in for its window.
    const replies: unknown[] = [];
    const providerWindow = { postMessage: (message: unknown) => { replies.push(message); } };
    Object.defineProperty(browser.HTMLIFrameElement.prototype, 'contentWindow', { get: () => providerWindow });
    browser.eval(runtime);
    browser.document.dispatchEvent(new browser.Event('DOMContentLoaded'));
    for (let i = 0; i < 20 && !el.querySelector('iframe'); i++) await new Promise((resolve) => setTimeout(resolve, 0));
    browser.dispatchEvent(new browser.MessageEvent('message', {
      source: providerWindow as never,
      origin: 'https://app.market-engine.example',
      data: { type: 'typeroll.extension.handoff.read', version: 3, installation_id: 'market-engine', component_id: 'lead-form', request_id: 'r1' },
    }));
    for (let i = 0; i < 20 && !replies.length; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(replies).toEqual([expect.objectContaining({
      type: 'typeroll.extension.handoff.result', request_id: 'r1', ok: true,
      handoff: expect.objectContaining({ key: 'moveria-moving', values: VALUES }),
    })]);
  });
});
