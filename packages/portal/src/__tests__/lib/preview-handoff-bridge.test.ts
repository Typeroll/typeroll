// The page handoff across an opaque preview: the frame has no Web Storage, so
// the trusted shell keeps a native navigation form's handoff for the tab and
// the frame-side bridge reads it back on the next page. Both halves run here
// as the shipped scripts in happy-dom.

import { afterEach, describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { buildExtensionPreviewShell } from '../../lib/extensions/preview-shell';
import { buildPreviewNavigationBridgeScript, offsitePreviewUrl } from '../../lib/preview-navigation-bridge';

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
  const replaced: string[] = [];
  const frameWindow = {
    postMessage: (message: Record<string, unknown>) => { replies.push(message); },
    location: { replace: (url: string) => { replaced.push(url); } },
  };
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
  return { browser, send, init, replaced };
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

describe('preview shell navigation history', () => {
  it('adds one history entry per page so Back returns to the previous page', () => {
    const { browser, send, replaced } = shell();
    const frameEl = browser.document.getElementById('preview')!;
    const initialSrc = frameEl.getAttribute('src');
    expect(initialSrc).toBe(`/preview/site/start/?t=ticket&frame=1&bridge=${BRIDGE_ID}`);
    const before = browser.history.length;

    send({ action: 'site.navigate', path: '/pricing/' });
    expect(browser.history.length).toBe(before + 1);
    expect(browser.location.pathname).toBe('/preview/site/pricing/');
    // The frame moves in place instead of adding its own history entry.
    expect(frameEl.getAttribute('src')).toBe(initialSrc);
    expect(replaced).toEqual([`/preview/site/pricing/?t=ticket&frame=1&bridge=${BRIDGE_ID}`]);

    // Back: the shell's address changes first and the frame follows it.
    browser.history.replaceState(null, '', '/preview/site/start/?t=ticket');
    browser.dispatchEvent(new browser.PopStateEvent('popstate', { state: null }));
    expect(replaced.at(-1)).toBe(`/preview/site/start/?t=ticket&frame=1&bridge=${BRIDGE_ID}`);
    expect(frameEl.getAttribute('src')).toBe(initialSrc);
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

describe('off-site links in the preview frame', () => {
  const FRAME = `${ORIGIN}/preview/site/start/?t=ticket&frame=1&bridge=${BRIDGE_ID}`;

  it('opens other origins and portal pages outside the preview root in a new tab', () => {
    expect(offsitePreviewUrl('https://typeroll.com/docs/blocks/reusable/', FRAME, '/preview/site'))
      .toBe('https://typeroll.com/docs/blocks/reusable/');
    expect(offsitePreviewUrl(`${ORIGIN}/login?mode=signup`, FRAME, '/preview/site')).toBe(`${ORIGIN}/login?mode=signup`);
    expect(offsitePreviewUrl('//cdn.example.test/file.pdf', FRAME, '/preview/site')).toBe('https://cdn.example.test/file.pdf');
    expect(offsitePreviewUrl('http://example.test/', FRAME, '/preview/site/')).toBe('http://example.test/');
    // Another site's preview is not this site.
    expect(offsitePreviewUrl(`${ORIGIN}/preview/sites/x/`, FRAME, '/preview/site')).toBe(`${ORIGIN}/preview/sites/x/`);
  });

  it('leaves in-site, hash, mailto, tel and script links alone', () => {
    for (const href of [
      `${ORIGIN}/preview/site/about/?t=ticket`,
      `${ORIGIN}/preview/site`,
      '/preview/site/media/m1?token=ticket',
      '#pricing',
      '?page=2',
      'mailto:hello@example.test',
      'tel:+46123456',
      'javascript:void(0)',
      'data:text/html,hi',
      'http://[bad',
    ]) expect(offsitePreviewUrl(href, FRAME, '/preview/site'), href).toBeNull();
  });

  function clickFrame(html: string, init?: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }) {
    const { posted } = frame();
    const browser = windows[windows.length - 1]!;
    browser.document.body.innerHTML = html;
    const anchor = browser.document.querySelector('a')!;
    const event = new browser.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
    anchor.dispatchEvent(event);
    return { posted, prevented: event.defaultPrevented };
  }

  it('asks the shell to open an off-site link and keeps the frame on the page', () => {
    const { posted, prevented } = clickFrame('<a href="https://typeroll.com/docs/">Reusable blocks</a>');
    expect(prevented).toBe(true);
    expect(posted).toEqual([{ ...CHANNEL, action: 'site.open', url: 'https://typeroll.com/docs/' }]);
  });

  it('keeps in-site links on site.navigate and leaves explicit targets, downloads and modifier clicks to the browser', () => {
    expect(clickFrame('<a href="/preview/site/about/?t=ticket">About</a>').posted)
      .toEqual([{ ...CHANNEL, action: 'site.navigate', path: '/about/' }]);
    for (const [html, init] of [
      ['<a href="https://typeroll.com/" target="_blank">x</a>', undefined],
      ['<a href="https://typeroll.com/" download>x</a>', undefined],
      ['<a href="https://typeroll.com/">x</a>', { metaKey: true }],
      ['<a href="https://typeroll.com/">x</a>', { ctrlKey: true }],
      ['<a href="https://typeroll.com/">x</a>', { shiftKey: true }],
      ['<a href="mailto:hello@example.test">x</a>', undefined],
      ['<a href="#top">x</a>', undefined],
    ] as const) {
      const { posted, prevented } = clickFrame(html, init);
      expect(posted.filter((message) => message.action === 'site.open'), html).toEqual([]);
      if (!html.includes('#top')) expect(prevented, html).toBe(false);
    }
  });
});

describe('preview shell opens off-site links', () => {
  function shellWithOpen() {
    const opened: unknown[][] = [];
    const parts = shell();
    parts.browser.open = ((...args: unknown[]) => { opened.push(args); return null; }) as typeof parts.browser.open;
    return { ...parts, opened };
  }

  it('opens http(s) URLs from its frame in a new tab without an opener', () => {
    const { send, opened } = shellWithOpen();
    send({ action: 'site.open', url: 'https://typeroll.com/docs/' });
    expect(opened).toEqual([['https://typeroll.com/docs/', '_blank', 'noopener,noreferrer']]);
  });

  it('ignores other schemes, malformed URLs and messages from anything but its frame', () => {
    const { send, opened } = shellWithOpen();
    send({ action: 'site.open', url: 'javascript:alert(1)' });
    send({ action: 'site.open', url: 'data:text/html,hi' });
    send({ action: 'site.open', url: '/relative' });
    send({ action: 'site.open', url: 42 });
    send({ action: 'site.open', url: `https://typeroll.com/${'x'.repeat(8200)}` });
    send({ action: 'site.open', url: 'https://typeroll.com/' }, { origin: 'https://evil.example' });
    send({ action: 'site.open', url: 'https://typeroll.com/' }, { source: {} });
    expect(opened).toEqual([]);
  });
});
