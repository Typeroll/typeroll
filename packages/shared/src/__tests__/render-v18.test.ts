import { describe, expect, it } from 'vitest';
import { LATEST_RENDER_VERSION, isRenderVersion } from '../render-version.js';
import { siteStylesCss } from '../site-styles.js';
import { defaultSiteSettings, resolveBreakpointWidths } from '../index.js';

const css = (renderVersion: number) =>
  siteStylesCss([], { renderVersion, colors: defaultSiteSettings.colors, breakpoints: resolveBreakpointWidths(undefined) });
const PAGE_OPENING = '.page-content--blocks > :where([data-block="heading"],[data-block="rich_heading"]):first-child';

describe('render version 18', () => {
  it('is a known render version', () => {
    expect(isRenderVersion(18)).toBe(true);
    expect(LATEST_RENDER_VERSION).toBeGreaterThanOrEqual(18);
  });

  it('removes the top margin of a heading that opens the page, after the editorial heading rule', () => {
    const out = css(18);
    const editorial = out.indexOf('.35em');
    const opening = out.indexOf(PAGE_OPENING);
    expect(editorial).toBeGreaterThan(-1);
    expect(opening).toBeGreaterThan(editorial);
    expect(out.slice(opening)).toMatch(/:not\(#\\#\)\{margin-block-start:0\}/);
    expect(out).toContain('.page-content--blocks > [data-block="prose"]:first-child > :is(h1,h2,h3,h4,h5,h6):first-child');
  });

  it('leaves render version 17 and older as they were', () => {
    expect(css(17)).not.toContain(PAGE_OPENING);
    expect(css(14)).not.toContain(PAGE_OPENING);
  });
});
