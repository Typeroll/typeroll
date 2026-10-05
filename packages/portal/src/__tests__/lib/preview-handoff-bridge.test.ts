// The page handoff across an opaque preview: the frame has no Web Storage, so
// the trusted shell keeps a native navigation form's handoff for the tab and
// the frame-side bridge reads it back on the next page. Both halves run here
// as the shipped scripts in happy-dom.

import { afterEach, describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { buildExtensionPreviewShell } from '../../lib/extensions/preview-shell';
import { buildPreviewNavigationBridgeScript } from '../../lib/preview-navigation-bridge';

const BRIDGE_ID = '12345678-1234-1234-1234-123456789abc';
const ORIGIN = 'https://app.typeroll.com';
const CHANNEL = { channel: 'typeroll.extension-preview', version: 1, bridge_id: BRIDGE_ID };
const PACKET = JSON.stringify({ version: 1, target: '/preview/site/quote/', expires: Date.now() + 60_000, values: { address_from: 'Storgatan 1' } });

const windows: Window[] = [];
afterEach(async () => {
  for (const browser of windows.splice(0)) await browser.happyDOM.close();
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function shell() {
  const browser = new Window({ url: `${ORIGIN}/preview/site/start/?t=ticket`, settings: { navigation: { disableChildFrameNavigation: true } } });
  windows.push(browser);
  const replies: Array<Record<string, unknown>> = [];
  const frameWindow = { postMessage: (message: Record<string, unknown>) => { replies.push(message); } };
  Object.defineProperty(browser.HTMLIFrameElement.prototype, 'contentWindow', { get: () => frameWindow });
  const html = buildExtensionPreviewShell({ siteId: 'site', bridgeId: BRIDGE_ID, rootPath: '/preview/site', storageScope: 'ticket', carriedQuery: { t: 'ticket' } });
  browser.document.body.innerHTML = '<iframe id="preview"></iframe>';
  browser.eval(html.match(/<script>([\s\S]*)<\/script>/)![1]!);
  const send = (data: Record<string, unknown>, from: { source?: unknown; origin?: string } = {}) =>
    browser.dispatchEvent(new browser.MessageEvent('message', { source: (from.source ?? frameWindow) as never, origin: from.origin ?? 'null', data: { ...CHANNEL, ...data } }));
  const init = () => {
    replies.length = 0;
    send({ action: 'storage.ready' });
    return (replies.find((reply) => reply.action === 'storage.init')?.storage as { handoff?: Record<string, string> }).handoff;
  };
  return { browser, send, init };
}

describe('preview shell handoff slot', () => {
  it('keeps one handoff per tab and hands it to the next frame', () => {
    const { browser, send, init } = shell();
    send({ action: 'handoff.set', key: 'moving', value: PACKET });
    expect(init()).toEqual({ moving: PACKET });
    // Persisted with the rest of the tab-scoped preview state.
    expect(browser.sessionStorage.getItem('typeroll:extension-preview:site:ticket')).toContain('"handoff"');

    // A new banner replaces an abandoned one, as on a published site.
    send({ action: 'handoff.set', key: 'cleaning', value: PACKET });
    expect(init()).toEqual({ cleaning: PACKET });

    send({ action: 'handoff.remove', key: 'cleaning' });
    expect(init()).toEqual({});
  });

  it('ignores malformed values and messages from anything but its frame', () => {
    const { send, init } = shell();
    send({ action: 'handoff.set', key: '../moving', value: PACKET });
    send({ action: 'handoff.set', key: 'moving', value: 'not json' });
    send({ action: 'handoff.set', key: 'moving', value: 'x'.repeat(20001) });
    send({ action: 'handoff.set', key: 'moving', value: PACKET }, { origin: 'https://evil.example' });
    send({ action: 'handoff.set', key: 'moving', value: PACKET }, { source: {} });
    expect(init()).toEqual({});
  });
});

function frame() {
  const browser = new Window({ url: `${ORIGIN}/preview/site/start/?t=ticket&frame=1&bridge=${BRIDGE_ID}` });
  windows.push(browser);
  const posted: Array<Record<string, unknown>> = [];
  browser.postMessage = ((message: Record<string, unknown>) => { posted.push(message); }) as typeof browser.postMessage;
  browser.eval(buildPreviewNavigationBridgeScript({
    browseRoot: '/preview/site',
    embedSuffix: '?t=ticket',
    extensionPreviewBridge: { id: BRIDGE_ID, parentOrigin: ORIGIN },
  }));
  const bridge = (browser as unknown as Record<string, unknown>).__TYPEROLL_PREVIEW_BRIDGE__ as {
    navigate(href: string): boolean;
    storeHandoff(key: string, packet: string): void;
    takeHandoff(key: string): Promise<string | null>;
  };
  const reply = (handoff: Record<string, string>, origin = ORIGIN) => browser.dispatchEvent(new browser.MessageEvent('message', {
    source: browser.eval('parent') as never, origin, data: { ...CHANNEL, action: 'storage.init', storage: { session: {}, local: {}, handoff } },
  }));
  return { bridge, posted, reply };
}

describe('frame-side preview bridge for native blocks', () => {
  it('moves the shell to a preview-relative path without the preview ticket', () => {
    const { bridge, posted } = frame();
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(bridge.navigate(`${ORIGIN}/preview/site/flyttfirmeoffert/?t=ticket`)).toBe(true);
    expect(posted).toEqual([{ ...CHANNEL, action: 'site.navigate', path: '/flyttfirmeoffert/' }]);
    expect(bridge.navigate('https://elsewhere.example/preview/site/x/')).toBe(false);
    expect(bridge.navigate(`${ORIGIN}/app/sites/`)).toBe(false);
    expect(posted).toHaveLength(1);
  });

  it('stores a handoff in the shell and takes it back exactly once', async () => {
    const { bridge, posted, reply } = frame();
    bridge.storeHandoff('moving', PACKET);
    expect(posted).toEqual([{ ...CHANNEL, action: 'handoff.set', key: 'moving', value: PACKET }]);

    const taken = bridge.takeHandoff('moving');
    await tick();
    expect(posted).toContainEqual({ ...CHANNEL, action: 'storage.ready' });
    reply({ moving: PACKET }, 'https://evil.example');
    reply({ moving: PACKET });
    await expect(taken).resolves.toBe(PACKET);
    expect(posted).toContainEqual({ ...CHANNEL, action: 'handoff.remove', key: 'moving' });
    await expect(bridge.takeHandoff('moving')).resolves.toBeNull();
  });
});
