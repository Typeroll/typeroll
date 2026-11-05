import { expect, it } from 'vitest';
import { SITE_STYLE_FIELDS, STYLE_PROP_KEYS, STYLE_BREAKPOINTS, siteStylesCss } from '@typeroll/shared';
import { projectStyle } from '../../../../../scripts/lib/static-publication.mjs';

// A style that sets every stored field and property: what the renderer receives must be all of it.
const props = { font: 'heading', size: 'lg', weight: 700, line_height: 'normal', letter_spacing: 'normal', transform: 'none', italic: false, color: 'primary', background: 'surface',
  align: 'left', decoration: 'underline', space_before: 'md', space_after: 'md', padding: 'md', max_width: 'prose', radius: 'md', border: { width: '1px', style: 'solid', color: 'primary', sides: 'all' },
  opacity: 1, shadow: 'none', gap: 'md' };
const style = { id: 'link', name: 'Link', role: 'link', targets: [], description: 'Links', base: props, at: Object.fromEntries(STYLE_BREAKPOINTS.map(bp => [bp, props])),
  hover: props, visited: { color: 'primary' }, css: '', parts: [], updated_at: '2026-11-04T23:25:00Z' };

it('publishes every stored style field except its timestamp', () => {
  expect(Object.keys(props).sort()).toEqual([...STYLE_PROP_KEYS].sort());
  expect(Object.keys(style).sort()).toEqual([...SITE_STYLE_FIELDS].sort());
  const projected = projectStyle(style) as Record<string, any>;
  expect(Object.keys(projected).sort()).toEqual(SITE_STYLE_FIELDS.filter(field => field !== 'updated_at').sort());
  for (const state of ['base', 'hover'] as const) expect(projected[state]).toEqual(props);
  expect(Object.keys(projected.at)).toEqual([...STYLE_BREAKPOINTS]);
});

it('keeps the link role visited colour so the published CSS has its :visited rule (SE-04)', () => {
  const link = { id: 'link', name: 'Link', role: 'link', base: { color: 'primary' }, hover: { color: 'primary' }, visited: { color: 'secondary' } };
  const css = siteStylesCss([projectStyle(link)], { breakpoints: { mobile: 0, tablet: 768, laptop: 1024, desktop: 1280, wide: 1536 }, colors: { primary: '#0056a0', secondary: '#5b2a86' }, renderVersion: 11 });
  expect(css).toMatch(/:where\(a\):visited,:where\(\[data-block="prose"\]\) a:visited\{color:[^}]+\}/);
});
