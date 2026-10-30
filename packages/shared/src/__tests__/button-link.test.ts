// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { buildCoreBlockRegistry, renderBlock } from '../index.js';
const registry = buildCoreBlockRegistry();
function button(data: Record<string, unknown>, editable = false) {
  const root = document.createElement('div');
  root.innerHTML = renderBlock({ id: 'cta', type: 'core/button', data: { label: 'Compare offers', href: '/offers/?partner=example&market=se#start', ...data } }, { registry, editable });
  return root.querySelector('a')!;
}
describe('native CTA link semantics', () => {
  it('renders new-tab behavior in static HTML without requiring script', () => {
    const link = button({ new_tab: true });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(new Set(link.rel.split(' '))).toEqual(new Set(['noopener', 'noreferrer']));
    expect(link.getAttribute('href')).toBe('/offers/?partner=example&market=se#start');
  });
  it.each([undefined, false, 'false', 'true', 1])('retains same-tab navigation unless a boolean opts in: %s', new_tab => {
    const link = button({ new_tab });
    expect(link.hasAttribute('target')).toBe(false);
    expect(link.hasAttribute('rel')).toBe(false);
  });
  it('escapes labels and URLs and ignores forged prepared attributes', () => {
    const label = '<img src=x onerror=alert(1)> & Continue';
    const href = '/offers/?q=" onclick="alert(1)&campaign=hello#step';
    const link = button({ label, href, new_tab: false, button_new_tab: true }, true);
    expect(link.textContent).toBe(label);
    expect(link.getAttribute('href')).toBe(href);
    expect(link.querySelector('img')).toBeNull();
    expect(link.hasAttribute('onclick')).toBe(false);
    expect(link.hasAttribute('target')).toBe(false);
    expect(link.outerHTML).toContain('data-edit="cta:label"');
  });
  it('keeps affiliate rel tokens and adds noopener only for a new tab', () => {
    const link = button({ link_rel: 'nofollow Sponsored "onclick=alert(1)', new_tab: true, button_link_attrs: ' onclick="x"' });
    expect(new Set(link.rel.split(' '))).toEqual(new Set(['nofollow', 'sponsored', 'noopener', 'noreferrer']));
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.hasAttribute('onclick')).toBe(false);
    const sameTab = button({ link_rel: 'nofollow sponsored' });
    expect(sameTab.rel).toBe('nofollow sponsored');
    expect(sameTab.hasAttribute('target')).toBe(false);
  });
});
