import { standardStylesBefore037 } from './fixtures/legacy-standard-styles.js';
import { expect, it } from 'vitest';
import { siteThemeCss, defaultSiteSettings, designScalesError, typographyError, newSiteStyles, validateSiteStyle, siteStylesCss, resolveBreakpointWidths } from '../index.js';
it('emits fluid scales, keeps authored overrides, and isolates legacy defaults', () => {
  const settings = { ...defaultSiteSettings, render_version:10, typography:{ratio_mobile:1.2,ratio_desktop:1.25,rhythm:1.2,line_length:70}, design_scales:{space:{md:{mobile:'1rem',desktop:'2rem'}},type_size:{lg:'clamp(1rem, 0.8rem + 1vw, 2rem)'}} };
  const css = siteThemeCss(settings);
  expect(css).toContain('--type-size-3xl:clamp(');
  expect(css).toContain('--type-size-lg:clamp(1rem, 0.8rem + 1vw, 2rem)');
  expect(css).toContain('--space-md:1rem');
  expect(css).toContain('@media(min-width:1280px){:root{--space-md:2rem;}}');
  expect(css).toContain('--measure-prose:70ch');
  const inherited = siteThemeCss({...settings,design_scales:{space:{lg:{desktop:'4rem'}}}});
  expect(inherited).toContain('--space-lg:clamp(');
  expect(inherited).toContain('@media(min-width:1280px){:root{--space-lg:4rem;}}');
  expect(siteThemeCss({...defaultSiteSettings,render_version:9})).toContain('--type-size-3xl:3rem;');
});
it('emits a prose measure that lets prose fill its column for line_length "none"', () => {
  const settings = { ...defaultSiteSettings, render_version:16 };
  expect(typographyError({line_length:'none'})).toBeNull();
  for (const value of ['auto','None',30,'65ch',null]) expect(typographyError({line_length:value})).toBeTruthy();
  const measured = siteThemeCss({...settings, typography:{line_length:65}});
  expect(measured).toContain('--measure-prose:65ch;');
  expect(measured).toBe(siteThemeCss(settings));
  const none = siteThemeCss({...settings, typography:{line_length:'none'}});
  // 100%, not none: blockDefaultsCss reads it inside min(100%, …), where none is invalid.
  expect(none).toContain('--measure-prose:100%;');
  expect(none).toContain(':where([data-block=prose]){max-inline-size:var(--measure-prose)}');
  expect(none.replace('--measure-prose:100%;', '--measure-prose:65ch;')).toBe(measured);
});
it('rejects unsafe and malformed scalar/map controls, including persisted values', () => {
  for (const value of ['1rem; color:red','clamp(1rem, url(x), 3rem)','calc(2rem)','var(--x)','</style>',{phone:'1rem'},{mobile:12},{},[]]) expect(designScalesError({space:{md:value}})).toBeTruthy();
  for (const value of [{rhythm:NaN},{ratio_mobile:1},{line_length:100},{unknown:1}]) expect(typographyError(value)).toBeTruthy();
  expect(siteThemeCss({...defaultSiteSettings, design_scales:{space:{md:'</style>'}}})).not.toContain('</style>');
});
it('uses valid token-based roles without fixed breakpoint sizes', () => {
  for (const style of newSiteStyles()) expect(validateSiteStyle(style).errors).toEqual([]);
  for (const style of newSiteStyles().filter(s => /^h[1-6]$/.test(s.role ?? '') || s.role === 'body')) {
    expect(style.base.size).not.toMatch(/rem|px/); expect(style.at).toBeUndefined();
  }
});
it('limits role rhythm to editorial flow and excludes opening headings at render version 10', () => {
  const opts = {colors:defaultSiteSettings.colors,breakpoints:resolveBreakpointWidths()};
  const modern = siteStylesCss(standardStylesBefore037(newSiteStyles()),{...opts,renderVersion:10});
  expect(modern).toContain(':not(:where(:where([data-block="container"]');
  expect(modern).toContain('margin-block-start:calc(1em * var(--type-rhythm,1))');
  expect(siteStylesCss(newSiteStyles(),{...opts,renderVersion:9})).not.toContain('var(--type-rhythm');
});
