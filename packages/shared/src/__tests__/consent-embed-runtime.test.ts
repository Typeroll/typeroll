// @vitest-environment happy-dom
// @vitest-environment-options {"settings": {"handleDisabledFileLoadingAsSuccess": true}}
import { describe, it, expect, beforeEach } from 'vitest';
import { buildConsentRuntime, buildCoreBlockRegistry, collectBlockAssets, renderBlocks } from '../index';
import type { Block } from '../index';

// The browser half of a consent-gated core/embed, in the order a published
// page runs it: the block bundle (with the embed's js) before the consent
// runtime at the end of <body>. Before optional consent nothing of the embed
// may exist in the DOM or run; after it the html is stamped out, the
// placeholder disappears and the js runs with `el` holding the html. A vendor
// pixel stands in for the widget's iframe, which happy-dom would try to load;
// what matters is whether the element exists.

declare global {
  interface Window {
    typerollConsent: { open: () => void; close: () => void; set: (choice: string) => void; get: () => string | null };
    __embedRuns?: number;
    __embedSawMarkup?: boolean;
  }
}

const registry = buildCoreBlockRegistry();
const blocks: Block[] = [{
  id: 'cmp',
  type: 'core/embed',
  data: {
    html: '<div class="dc-tool"></div><img class="dc-pixel" src="https://tool.vendor.example/px.gif" alt="">',
    js: 'window.__embedRuns = (window.__embedRuns || 0) + 1; window.__embedSawMarkup = !!el.querySelector("img"); document.cookie = "vc=1; path=/";',
    consent: 'optional',
  },
} as Block];

function loadPage(): void {
  document.body.innerHTML = renderBlocks(blocks, { registry });
  // Indirect eval = global scope, like the page's inline scripts.
  (0, eval)(collectBlockAssets(blocks, registry).js);
  (0, eval)(buildConsentRuntime(false));
}

function cookieNames(): string[] {
  return document.cookie.split(';').map(part => part.trim().split('=')[0]!).filter(Boolean).sort();
}

beforeEach(() => {
  for (const name of cookieNames()) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  document.body.innerHTML = '';
  delete window.__embedRuns;
  delete window.__embedSawMarkup;
});

describe('consent-gated embed in the browser', () => {
  it('loads nothing and sets no cookie before the visitor answers', () => {
    loadPage();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('.dc-tool')).toBeNull();
    expect(window.__embedRuns).toBeUndefined();
    expect(cookieNames()).toEqual([]);
    expect(document.querySelector('[data-tr-consent-placeholder]')).not.toBeNull();
  });

  it('opens the cookie banner from the placeholder button', () => {
    loadPage();
    (document.querySelector('[data-tr-consent-placeholder] button') as HTMLButtonElement).click();
    expect(document.documentElement.classList.contains('tr-consent-needed')).toBe(true);
    document.documentElement.classList.remove('tr-consent-needed');
  });

  it('shows the embed and runs its js once after accepting all cookies', () => {
    loadPage();
    window.typerollConsent.set('all');

    const root = document.querySelector('[data-bid="cmp"]')!;
    expect(root.getAttribute('data-tr-consent-embed')).toBe('active');
    expect(root.querySelector('img')?.getAttribute('src')).toBe('https://tool.vendor.example/px.gif');
    expect(root.querySelector('template')).toBeNull();
    expect(root.querySelector('[data-tr-consent-placeholder]')).toBeNull();
    expect(window.__embedRuns).toBe(1);
    // The js ran after the html was in place, so it can find its markup.
    expect(window.__embedSawMarkup).toBe(true);
    expect(cookieNames()).toEqual(['tr_consent', 'vc']);

    // Accepting again from the banner neither duplicates the html nor reruns the js.
    window.typerollConsent.set('all');
    expect(root.querySelectorAll('img')).toHaveLength(1);
    expect(window.__embedRuns).toBe(1);
  });

  it('keeps the embed off for necessary-only and rejected', () => {
    for (const choice of ['necessary', 'rejected']) {
      loadPage();
      window.typerollConsent.set(choice);
      expect(document.querySelector('img')).toBeNull();
      expect(document.querySelector('[data-tr-consent-placeholder]')).not.toBeNull();
      expect(window.__embedRuns).toBeUndefined();
      expect(cookieNames()).toEqual(['tr_consent']);
    }
  });

  it('shows the embed at once on a later visit with stored consent', () => {
    document.cookie = 'tr_consent=all; path=/';
    loadPage();
    expect(document.querySelector('img')).not.toBeNull();
    expect(document.querySelector('[data-tr-consent-placeholder]')).toBeNull();
    expect(window.__embedRuns).toBe(1);
    expect(window.__embedSawMarkup).toBe(true);
  });

  it('keeps it off on a later visit after necessary-only', () => {
    document.cookie = 'tr_consent=necessary; path=/';
    loadPage();
    expect(document.querySelector('img')).toBeNull();
    expect(window.__embedRuns).toBeUndefined();
  });

  it('starts the js when the runtime activated the block before the bundle ran', () => {
    // Defensive ordering: a page that runs the consent runtime first still starts the js.
    document.cookie = 'tr_consent=all; path=/';
    document.body.innerHTML = renderBlocks(blocks, { registry });
    (0, eval)(buildConsentRuntime(false));
    (0, eval)(collectBlockAssets(blocks, registry).js);
    expect(window.__embedRuns).toBe(1);
  });
});
