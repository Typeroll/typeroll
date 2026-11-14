import { afterEach, describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { EARLY_IMAGE_LOADING_RUNTIME_JS } from '../early-image-loading.js';

const windows: Window[] = [];
afterEach(async () => { for (const browser of windows.splice(0)) await browser.happyDOM.close(); });

function page(html: string) {
  const browser = new Window({ url: 'https://example.com/' });
  windows.push(browser);
  type Entry = { isIntersecting: boolean; target: unknown };
  const observers: Array<{ callback: (entries: Entry[]) => void; options: Record<string, unknown>; observed: unknown[] }> = [];
  (browser as unknown as Record<string, unknown>).IntersectionObserver = class {
    observed: unknown[] = [];
    constructor(public callback: (entries: Entry[]) => void, public options: Record<string, unknown>) { observers.push(this as never); }
    observe(target: unknown) { this.observed.push(target); }
    unobserve(target: unknown) { this.observed = this.observed.filter(item => item !== target); }
  };
  browser.document.body.innerHTML = html;
  browser.eval(EARLY_IMAGE_LOADING_RUNTIME_JS);
  return { browser, observer: observers[0]! };
}

describe('early image loading', () => {
  it('starts a lazy image two screen heights before it scrolls in, measured from the document', () => {
    const { browser, observer } = page('<img id="far" src="/a.avif" loading="lazy"><img id="eager" src="/b.avif" loading="eager"><img id="plain" src="/c.avif">');
    expect(observer.options).toMatchObject({ root: browser.document, rootMargin: '200% 0px 200% 0px' });
    const far = browser.document.getElementById('far')!;
    expect(observer.observed).toEqual([far]);
    observer.callback([{ isIntersecting: false, target: far }]);
    expect(far.getAttribute('loading')).toBe('lazy');
    observer.callback([{ isIntersecting: true, target: far }]);
    expect(far.getAttribute('loading')).toBe('eager');
    expect(observer.observed).toEqual([]);
  });

  it('also watches lazy images added later, once each', async () => {
    const { browser, observer } = page('<img id="first" src="/a.avif" loading="lazy">');
    const later = browser.document.createElement('img');
    later.setAttribute('loading', 'lazy');
    browser.document.body.appendChild(later);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(observer.observed).toHaveLength(2);
    expect(observer.observed[1]).toBe(later);
  });

  it('never contains a closing script tag', () => {
    expect(EARLY_IMAGE_LOADING_RUNTIME_JS).not.toMatch(/<\/script/i);
  });
});
