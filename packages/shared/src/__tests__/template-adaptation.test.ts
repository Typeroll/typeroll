import { describe, expect, it } from 'vitest';
import {
  bracketPlaceholders, getPageBodyStarter, handoverProgress, localizedTemplate, planPackageImport, resolveAuthoredVariables,
  siteHandoverErrors, sitePackageErrors, structureLocked, type SitePackage, type SiteStyle,
} from '../index.js';

describe('authored site variables', () => {
  const context = { year: 2026, siteName: 'Bistro <Lykta>', fields: { phone: '08-000 00 00', seats: 30, open: true, hours: { mon: '9' } } };
  it('expands the site name and simple site fields from render version 15, escaped', () => {
    expect(resolveAuthoredVariables('<p>{{site.name}} · {{ site.fields.phone }} · {{site.fields.seats}} · {{site.current_year}}</p>', { ...context, renderVersion: 15 }))
      .toBe('<p>Bistro &lt;Lykta&gt; · 08-000 00 00 · 30 · 2026</p>');
    expect(resolveAuthoredVariables('{{site.fields.hours}}{{site.fields.missing}}', { ...context, renderVersion: 15 })).toBe('');
  });
  it('leaves them alone before render version 15', () => {
    expect(resolveAuthoredVariables('{{site.name}} {{site.current_year}}', { ...context, renderVersion: 14 })).toBe('{{site.name}} 2026');
  });
});

describe('template languages', () => {
  const template = { id: 'hero', name: 'Hero', description: 'English', blocks: [{ id: 'a', type: 'core/prose', data: { html: '<p>Hello</p>' } }],
    translations: { sv: { name: 'Startsektion', blocks: [{ id: 'a', type: 'core/prose', data: { html: '<p>Hej</p>' } }] } } };
  it('picks the site language, then the base language, else the template text', () => {
    expect(localizedTemplate(template, 'sv')).toMatchObject({ name: 'Startsektion', description: 'English', language: 'sv' });
    expect(localizedTemplate(template, 'sv-FI').blocks![0].data.html).toBe('<p>Hej</p>');
    const english = localizedTemplate(template, 'de');
    expect(english.name).toBe('Hero');
    expect('translations' in english).toBe(false);
  });
  it('validates translated trees and counts their styles and media', () => {
    const pkg: SitePackage = {
      format: 'typeroll-package', format_version: 1, kind: 'collection', id: 'p', name: 'P', version: '1', created_at: '2026-11-07T00:00:00Z',
      contents: { block_templates: [{ ...template, translations: { sv: { blocks: [{ id: 'b', type: 'core/prose', data: { html: '<img src="typeroll-media:pic">', style_id: 'lead' } }] } } }] },
      media: [], integrity: { algorithm: 'sha256', files: {} },
    };
    expect(sitePackageErrors(pkg)).toContain('content refers to media "pic", which the package does not contain');
    const plan = planPackageImport(pkg, { styles: [], blockTypes: [], blockTemplateIds: [], pageTemplateIds: [], globalBlockIds: [], menuIds: [] }, { design: 'content' });
    expect(plan.media).toEqual(['pic']);
  });
});

describe('a style neither the package nor the site has', () => {
  it('uses the site style of the same standard role', () => {
    const pkg: SitePackage = {
      format: 'typeroll-package', format_version: 1, kind: 'collection', id: 'p', name: 'P', version: '1', created_at: '2026-11-07T00:00:00Z',
      contents: { block_templates: [{ id: 't', name: 'T', blocks: [{ id: 'b', type: 'core/button', data: { style_id: 'button-secondary' } }] }] },
      media: [], integrity: { algorithm: 'sha256', files: {} },
    };
    const site = [{ id: 'knapp-2', name: 'Sekundär knapp', role: 'button_secondary', targets: ['button'], base: {} }] as SiteStyle[];
    const plan = planPackageImport(pkg, { styles: site, blockTypes: [], blockTemplateIds: [], pageTemplateIds: [], globalBlockIds: [], menuIds: [] }, { design: 'content' });
    expect([...plan.maps.styles]).toEqual([['button-secondary', 'knapp-2']]);
    expect(plan.warnings[0]).toMatch(/Sekundär knapp/);
  });
});

describe('handover', () => {
  it('validates the object', () => {
    expect(siteHandoverErrors({ lock_structure: true, start_page: 'home', checklist: [{ id: 'domain', label: 'Connect the domain', href: '/app/sites/s1/publishing' }], handed_over_at: '2026-11-07T12:00:00Z' })).toEqual([]);
    expect(siteHandoverErrors({ lock: true, checklist: [{ id: 'a', label: '' }, { id: 'a', label: 'x', href: 'https://evil.example' }] })).toEqual([
      'handover.lock is not allowed', 'handover.checklist[0].label must be text up to 200 characters',
      'handover.checklist[1].id "a" is used twice', 'handover.checklist[1].href must be a portal path starting with /',
    ]);
    expect(siteHandoverErrors(null)).toEqual([]);
  });
  it('locks structure only for people without design rights', () => {
    expect(structureLocked({ lock_structure: true }, false)).toBe(true);
    expect(structureLocked({ lock_structure: true }, true)).toBe(false);
    expect(structureLocked(undefined, false)).toBe(false);
    expect(handoverProgress({ checklist: [{ id: 'a', label: 'A', done: true }, { id: 'b', label: 'B' }] })).toEqual({ done: 1, total: 2 });
  });
});

describe('bracketPlaceholders', () => {
  it('finds the starters’ placeholders but not links, ids or lower-case brackets', () => {
    const found = bracketPlaceholders(getPageBodyStarter('feature_page'));
    expect(found).toContain('[Feature name]');
    expect(bracketPlaceholders([{ id: '[X]', type: 'core/prose', data: { html: '<p>See [the docs](https://x) and [a note] and <a href="/[Y]">x</a></p>' } }])).toEqual([]);
    expect(bracketPlaceholders({ html: '<p>[Your product] vs [Other product]</p>' })).toEqual(['[Your product]', '[Other product]']);
  });
});
