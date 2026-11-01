import { describe, expect, it } from 'vitest';
import { buildMediaLookup, leadingBackgroundImage, transformBodyForSeo } from '../seo-transform.js';

const empty = buildMediaLookup([]);
const imgs = (html: string) => html.match(/<img\b[^>]*>/g) ?? [];

describe('leading image loading', () => {
  it('makes a block image that marks itself lazy eager when it is the first visual image', () => {
    const html = '<span class="block-image-frame"><img src="/a.webp" alt="" loading="lazy" decoding="async" /></span><p>x</p><img src="/b.webp" alt="" loading="lazy" /><img src="/c.webp" alt="" loading="lazy" />';
    const [first, second, third] = imgs(transformBodyForSeo(html, empty));
    expect(first).toContain('loading="eager"');
    expect(first).toContain('fetchpriority="high"');
    expect(second).toContain('loading="eager"');
    expect(third).toContain('loading="lazy"');
    expect(third).not.toContain('fetchpriority');
  });
  it('never emits lazy together with high priority', () => {
    const out = transformBodyForSeo('<img src="/x" alt="" fetchpriority="high" loading="lazy" />'.repeat(3), empty);
    for (const tag of imgs(out)) expect(tag.includes('loading="lazy"') && tag.includes('fetchpriority="high"')).toBe(false);
  });
  it('does not treat logos or small icons as the largest paint', () => {
    const html = '<div data-block="logo_item" data-grayscale="false">\n  <a href="" class="block-logo-link"><img src="/logo.svg" alt="Acme" loading="lazy" /></a>\n</div>'
      + '<img src="/icon.png" alt="" width="32" height="32" />'
      + '<img src="/hero.webp" alt="Hero" loading="lazy" />';
    const [logo, icon, hero] = imgs(transformBodyForSeo(html, empty));
    expect(logo).toContain('loading="lazy"');
    expect(logo).not.toContain('fetchpriority');
    expect(icon).toContain('loading="lazy"');
    expect(hero).toContain('loading="eager"');
    expect(hero).toContain('fetchpriority="high"');
  });
  it('is idempotent', () => {
    const html = '<img src="/a.webp" alt="" loading="lazy" /><img src="/b.webp" alt="" /><img src="/c.webp" alt="" />';
    const once = transformBodyForSeo(html, empty);
    expect(transformBodyForSeo(once, empty)).toBe(once);
  });
});

describe('leading background image', () => {
  it('returns the first section background a container shows', () => {
    expect(leadingBackgroundImage('<section data-block="container" style="--bg:;--bg-image:url(https://cdn.test/hero.jpg);--x:1"><h1>Hi</h1></section>')).toBe('https://cdn.test/hero.jpg');
  });
  it('ignores empty backgrounds and backgrounds below the first content', () => {
    expect(leadingBackgroundImage('<section data-block="container" style="--bg-image:url()"><h1>Hi</h1></section><section data-block="container" style="--bg-image:url(/late.jpg)"></section>')).toBeNull();
  });
  it('counts a hero only in the full-image layout and a CTA only with a background image position', () => {
    expect(leadingBackgroundImage('<section data-block="hero" style="--layout:split;--bg-image:url(/h.jpg)"><h1>x</h1></section>')).toBeNull();
    expect(leadingBackgroundImage('<section data-block="hero" style="--layout:full-image;--bg-image:url(/h.jpg)"><h1>x</h1></section>')).toBe('/h.jpg');
    expect(leadingBackgroundImage('<section data-block="cta" data-image-pos="background" style="--bg-image:url(/c.jpg)"><h2>x</h2></section>')).toBe('/c.jpg');
    expect(leadingBackgroundImage('<section data-block="cta" data-image-pos="left" style="--bg-image:url(/c.jpg)"><h2>x</h2></section>')).toBeNull();
  });
  it('never preloads data or script URLs', () => {
    expect(leadingBackgroundImage('<div data-block="container" style="--bg-image:url(data:image/png;base64,AAA)"><p>x</p></div>')).toBeNull();
  });
});
