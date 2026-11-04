import { describe, expect, it } from 'vitest';
import { buildMediaLookup, leadingBackgroundImage, transformBodyForSeo } from '../seo-transform.js';

const empty = buildMediaLookup([]);
const imgs = (html: string) => html.match(/<img\b[^>]*>/g) ?? [];

describe('leading image loading', () => {
  it('makes only the first visual image eager, even when it marks itself lazy', () => {
    const html = '<span class="block-image-frame"><img src="/a.webp" alt="" loading="lazy" decoding="async" /></span><p>x</p><img src="/b.webp" alt="" loading="lazy" /><img src="/c.webp" alt="" loading="lazy" />';
    const [first, second, third] = imgs(transformBodyForSeo(html, empty));
    expect(first).toContain('loading="eager"');
    expect(first).toContain('fetchpriority="high"');
    expect(second).toContain('loading="lazy"');
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

describe('art-directed images and distant images', () => {
  const variants = (base: string) => [320, 1024].flatMap(width => (['avif', 'webp'] as const).map(format => ({ width, format, cdn_url: `${base}.w${width}.${format}` })));
  const lookup = buildMediaLookup([
    { id: 'd', cdn_url: 'https://m.example/desk.png', width: 1510, height: 566, variants: variants('https://m.example/desk.png') },
    { id: 'm', cdn_url: 'https://m.example/mob.png', width: 750, height: 900, variants: variants('https://m.example/mob.png') },
  ] as never);

  it('gives both images of an art-directed core/image their AVIF and WebP variants', () => {
    const html = '<picture data-tr-art-direction><source media="(width < 768px)" srcset="https://m.example/mob.png" /><img src="https://m.example/desk.png" alt="Offer" width="755" height="283" loading="lazy" decoding="async" /></picture>';
    const out = transformBodyForSeo(html, lookup);
    const sources = out.match(/<source\b[^>]*>/g) ?? [];
    expect(sources).toHaveLength(5);
    expect(sources[0]).toContain('media="(width < 768px)" type="image/avif" srcset="https://m.example/mob.png.w320.avif 320w');
    expect(sources[1]).toContain('type="image/webp"');
    expect(sources[1]).toContain('mob.png.w1024.webp 1024w');
    expect(sources[2]).toBe('<source media="(width < 768px)" srcset="https://m.example/mob.png" />');
    expect(sources[3]).toContain('type="image/avif" srcset="https://m.example/desk.png.w320.avif');
    expect(sources[3]).not.toContain('media=');
    expect(out.match(/<picture/g)).toHaveLength(1);
    expect(transformBodyForSeo(out, lookup)).toBe(out);
  });

  it('expands the art-directed picture after an HTML parser rewrote it', () => {
    const html = '<picture data-tr-art-direction><source media="(width &lt; 768px)" srcset="https://m.example/mob.png"></source><img src="https://m.example/desk.png" sizes="(max-width: 1023px) 100vw, 75vw" alt="Offer" width="755" height="283" loading="lazy" decoding="async" /></picture>';
    const out = transformBodyForSeo(html, lookup);
    const sources = out.match(/<source\b[^>]*>/g) ?? [];
    expect(sources).toHaveLength(5);
    expect(sources[0]).toContain('media="(width &lt; 768px)" type="image/avif"');
    expect(sources[4]).toContain('sizes="(max-width: 1023px) 100vw, 75vw"');
    expect(out).not.toContain('data-tr-art-direction');
  });

  it('keeps a second image lazy when it is far below the first', () => {
    const html = `<img src="/hero.webp" alt="" /><p>${'Text. '.repeat(1000)}</p><img src="/banner.webp" alt="" loading="lazy" />`;
    const [hero, banner] = imgs(transformBodyForSeo(html, empty));
    expect(hero).toContain('fetchpriority="high"');
    expect(banner).toContain('loading="lazy"');
    expect(banner).not.toContain('fetchpriority');
  });
});
