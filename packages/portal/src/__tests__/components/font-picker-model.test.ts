// Pure helpers behind the font picker, the site's font settings and the
// font previews: sections and filters, role labels, preview stylesheets and
// font services.

import { describe, expect, it } from 'vitest';
import type { FontService, SiteFontFile } from '@typeroll/shared';
import {
  PREVIEW_FONT_CSP, addService, describeFontValue, describeWeights, effectiveRoleFamilies, flatOptions, fontPickerSections, fontRoleChoices,
  googlePreviewUrl, isFontRoleField, moveActive, parseServiceInput, parseServicesValue, previewFontHead, previewStylesheet, roleOptionLabel,
  rolesUsingFamilies, sampleCharacters, serializeServices, serviceFontOptions, sitePreviewFonts, uploadFontFaceCss, uploadedFontOptions,
} from '../../components/font-picker-model';

const file = (id: string, family: string, weight: SiteFontFile['weight'], style: 'normal' | 'italic' = 'normal'): SiteFontFile => ({
  id, family, weight, style, category: 'serif',
  file: { format: 'woff2', bytes: 40_000, sha256: id, key: `fonts/${id}.woff2` },
  licence: { confirmed: true, by: 'anna@example.com', at: '2026-11-01T10:00:00.000Z' },
  created_at: '2026-11-01T10:00:00.000Z',
});
const brand = [file('b400', 'Brand Serif', 400), file('b700', 'Brand Serif', 700), file('b400i', 'Brand Serif', 400, 'italic')];
const variable = [file('v', 'Brand Sans', [100, 900])];
const adobe: FontService = { provider: 'adobe', kit: 'abc1def', families: ['Freight Text Pro', 'Proxima Nova'] };
const bunny: FontService = { provider: 'bunny', url: 'https://fonts.bunny.net/css?family=inter:400,700', families: ['Inter Tight'] };

describe('picker options', () => {
  it('groups uploaded files into one family with its weights, italics and variable range', () => {
    const [sans, serif] = uploadedFontOptions([...brand, ...variable]);
    expect(serif).toMatchObject({ family: 'Brand Serif', source: 'upload', weights: [400, 700], italic: true, category: 'serif' });
    expect(sans).toMatchObject({ family: 'Brand Sans', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], variable: [100, 900], italic: false });
    expect(describeWeights(sans!)).toBe('Serif · weights 100–900 · variable · your font');
    expect(describeWeights(serif!)).toBe('Serif · weights 400, 700 · italic · your font');
  });

  it('lists each service family once with its provider', () => {
    expect(serviceFontOptions([adobe, bunny, { ...adobe, kit: 'zzz9999' }]).map(option => [option.family, option.provider]))
      .toEqual([['Freight Text Pro', 'adobe'], ['Proxima Nova', 'adobe'], ['Inter Tight', 'bunny']]);
  });

  it('describes the current value by where it comes from', () => {
    expect(describeFontValue('Brand Serif', brand, []).source).toBe('upload');
    expect(describeFontValue('proxima nova', [], [adobe]).source).toBe('service');
    expect(describeFontValue('system').source).toBe('system');
    expect(describeFontValue('Inter')).toMatchObject({ source: 'catalog', variable: [100, 900] });
    expect(describeFontValue('Some Rare Family')).toMatchObject({ source: 'custom' });
    expect(describeWeights(describeFontValue('Some Rare Family'))).toContain('not in the catalog');
  });
});

describe('picker sections', () => {
  it('puts the site’s fonts, services and the system font before the catalog', () => {
    const sections = fontPickerSections({ uploads: brand, services: [adobe] });
    expect(sections.map(section => section.id)).toEqual(['uploads', 'services', 'system', 'catalog']);
    expect(sections.find(section => section.id === 'catalog')!.options.length).toBeGreaterThan(200);
  });

  it('searches every section and offers a Google family by name that is in none of them', () => {
    const sections = fontPickerSections({ query: 'brand', uploads: brand, services: [adobe] });
    expect(sections.map(section => section.id)).toEqual(['uploads', 'custom']);
    expect(fontPickerSections({ query: 'Playfair Display' }).map(section => section.id)).toEqual(['catalog']);
    const custom = fontPickerSections({ query: 'Zilla Slab Highlight' }).find(section => section.id === 'custom')!;
    expect(custom.options[0]).toMatchObject({ family: 'Zilla Slab Highlight', source: 'custom' });
    expect(fontPickerSections({ query: '<script>' }).some(section => section.id === 'custom')).toBe(false);
  });

  it('filters by category, variable, italic and extended Latin', () => {
    const serif = flatOptions(fontPickerSections({ filters: { category: 'serif' }, uploads: brand }));
    expect(serif.every(option => option.category === 'serif')).toBe(true);
    expect(serif[0]!.family).toBe('Brand Serif');
    const variableItalic = flatOptions(fontPickerSections({ filters: { variable: true, italic: true } }));
    expect(variableItalic.length).toBeGreaterThan(10);
    expect(variableItalic.every(option => option.variable && option.italic)).toBe(true);
    // Filters hide the system font and services, whose properties are unknown.
    expect(fontPickerSections({ filters: { latin_ext: true }, services: [adobe] }).map(section => section.id)).toEqual(['catalog']);
  });

  it('moves the active option with the keyboard', () => {
    expect(moveActive('ArrowDown', -1, 5)).toBe(0);
    expect(moveActive('ArrowDown', 4, 5)).toBe(4);
    expect(moveActive('ArrowUp', 2, 5)).toBe(1);
    expect(moveActive('End', 0, 5)).toBe(4);
    expect(moveActive('Home', 3, 5)).toBe(0);
    expect(moveActive('a', 3, 5)).toBeNull();
    expect(moveActive('ArrowDown', -1, 0)).toBeNull();
  });
});

describe('role labels', () => {
  const fonts = { heading: 'Playfair Display', body: 'Inter', mono: 'JetBrains Mono', accent: 'Lora' };

  it('names each role’s family, and the fallback of an unset role', () => {
    expect(roleOptionLabel('heading', fonts, 15)).toBe('Heading — Playfair Display');
    expect(roleOptionLabel('display', fonts, 15)).toBe('Display — same as heading');
    expect(roleOptionLabel('accent', fonts, 15)).toBe('Accent — Lora');
    expect(roleOptionLabel('mono', {}, 15)).toBe('Monospace — system monospace');
    expect(roleOptionLabel('body', { body: 'system' }, 15)).toBe('Body — system font');
    expect(roleOptionLabel('accent', fonts, 14)).toBe('Accent — same as body until render version 15');
    expect(roleOptionLabel('inherit', fonts, 15)).toBe('Inherit');
    expect(roleOptionLabel('display', null, null)).toBe('Display (render version 15)');
  });

  it('leaves display and accent out below render version 15 unless already chosen', () => {
    const options = ['inherit', 'body', 'heading', 'display', 'accent', 'mono'];
    expect(fontRoleChoices(options, fonts, 14).map(choice => choice.value)).toEqual(['inherit', 'body', 'heading', 'mono']);
    expect(fontRoleChoices(options, fonts, 14, 'accent').map(choice => choice.value)).toContain('accent');
    expect(fontRoleChoices(options, fonts, 15).map(choice => choice.value)).toEqual(options);
    expect(fontRoleChoices(options, null, null).map(choice => choice.value)).toEqual(options);
  });

  it('uses heading and body for display and accent before render version 15', () => {
    expect(effectiveRoleFamilies({ heading: 'Lora', display: 'Anton' }, 14).display).toBe('Lora');
    expect(effectiveRoleFamilies({ heading: 'Lora', display: 'Anton' }, 15).display).toBe('Anton');
  });

  it('recognises font role fields', () => {
    expect(isFontRoleField({ type: 'select', name: 'font', options: ['inherit', 'body', 'heading', 'display', 'accent', 'mono'] })).toBe(true);
    expect(isFontRoleField({ type: 'select', name: 'title_font', options: ['heading', 'body'] })).toBe(true);
    expect(isFontRoleField({ type: 'select', name: 'font', options: ['small', 'large'] })).toBe(false);
    expect(isFontRoleField({ type: 'select', name: 'font_weight', options: ['400', '700'] })).toBe(false);
    expect(isFontRoleField({ type: 'text', name: 'font' })).toBe(false);
  });
});

describe('preview stylesheets', () => {
  it('asks Google for only the sample characters, in both cases', () => {
    const text = sampleCharacters('sv');
    expect(text).toContain('ä');
    expect(text).toContain('Ä');
    expect(text).not.toContain(' ');
    expect(new Set(text).size).toBe(text.length);
    const url = googlePreviewUrl('Playfair Display', { text: 'Åb', weights: [400, 700] });
    expect(url).toBe('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&text=%C3%85b&display=swap');
  });

  it('loads catalog families at the weights nearest 400 and 700, other names at their default', () => {
    expect(previewStylesheet('Inter', {})).toBe('https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap');
    expect(previewStylesheet('Abril Fatface', { text: 'Ab' })).toBe('https://fonts.googleapis.com/css2?family=Abril+Fatface:wght@400&text=Ab&display=swap');
    expect(previewStylesheet('Rare Name', {})).toBe('https://fonts.googleapis.com/css2?family=Rare+Name&display=swap');
    expect(previewStylesheet('Proxima Nova', { services: [adobe] })).toBe('https://use.typekit.net/abc1def.css');
    expect(previewStylesheet('Brand Serif', { uploads: brand })).toBeNull();
    expect(previewStylesheet('system', {})).toBeNull();
  });

  it('declares uploaded files with their weight range and style', () => {
    const css = uploadFontFaceCss([...variable, brand[2]!], f => `/api/sites/s/fonts/${f.id}/file`);
    expect(css).toContain(`@font-face{font-family:'Brand Sans';src:url("/api/sites/s/fonts/v/file") format("woff2");font-weight:100 900;font-style:normal;font-display:swap}`);
    expect(css).toContain(`font-family:'Brand Serif';src:url("/api/sites/s/fonts/b400i/file") format("woff2");font-weight:400;font-style:italic`);
    expect(uploadFontFaceCss(brand, () => null)).toBe('');
  });

  it('plans a site preview: Google families, service stylesheets and uploaded files', () => {
    const plan = sitePreviewFonts({ heading: 'Brand Serif', body: 'Inter', accent: 'Proxima Nova', mono: 'system', services: [adobe] }, brand);
    expect(plan.uploads.map(f => f.id)).toEqual(['b400', 'b700', 'b400i']);
    expect(plan.stylesheets).toEqual(['https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap', 'https://use.typekit.net/abc1def.css']);
    // Display unset follows the heading: nothing extra to load.
    expect(sitePreviewFonts({ heading: 'Inter', body: 'Inter' }, []).stylesheets).toHaveLength(1);
  });

  it('writes escaped markup for a sandboxed preview frame', () => {
    const head = previewFontHead({ stylesheets: ['https://fonts.googleapis.com/css2?family=A&text=%3C"'], uploads: [brand[0]!] }, () => 'data:font/woff2;base64,AAAA');
    expect(head).toContain('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=A&amp;text=%3C&quot;">');
    expect(head).toContain('<style>@font-face{font-family:\'Brand Serif\';src:url("data:font/woff2;base64,AAAA")');
    expect(PREVIEW_FONT_CSP).toContain("font-src data: https://fonts.gstatic.com");
    expect(PREVIEW_FONT_CSP).toContain("default-src 'none'");
    expect(PREVIEW_FONT_CSP).not.toContain('script-src');
  });
});

describe('font services', () => {
  it('reads an Adobe web project ID, its stylesheet, or a Bunny or Fontshare stylesheet', () => {
    expect(parseServiceInput(' abc1def ')).toEqual({ request: { provider: 'adobe', kit: 'abc1def' } });
    expect(parseServiceInput('https://use.typekit.net/abc1def.css')).toEqual({ request: { provider: 'adobe', kit: 'abc1def' } });
    expect(parseServiceInput(bunny.url)).toEqual({ request: { provider: 'bunny', url: bunny.url } });
    expect(parseServiceInput('https://api.fontshare.com/v2/css?f[]=satoshi@400&display=swap')).toMatchObject({ request: { provider: 'fontshare' } });
    expect(parseServiceInput('https://example.com/fonts.css')).toMatchObject({ error: expect.stringContaining('fonts.bunny.net') });
    expect(parseServiceInput('Not a kit')).toMatchObject({ error: expect.stringContaining('web project ID') });
    expect(parseServiceInput('')).toMatchObject({ error: expect.any(String) });
  });

  it('refuses duplicates and more than four services', () => {
    expect(addService([adobe], { ...adobe })).toEqual({ error: 'This font service is already added.' });
    const four = ['aaaaa1', 'bbbbb2', 'ccccc3', 'ddddd4'].map(kit => ({ provider: 'adobe' as const, kit, families: ['X'] }));
    expect(addService(four, bunny)).toMatchObject({ error: expect.stringContaining('at most 4') });
    expect(addService([adobe], bunny)).toEqual({ services: [adobe, bunny] });
  });

  it('serialises the hidden fonts.services value and reads it back', () => {
    expect(serializeServices([])).toBe('');
    expect(parseServicesValue(serializeServices([adobe]))).toEqual([adobe]);
    expect(parseServicesValue('')).toBeUndefined();
    expect(parseServicesValue('{oops')).toBeUndefined();
  });

  it('finds roles that still use a removed service’s families', () => {
    expect(rolesUsingFamilies({ heading: 'Proxima Nova', body: 'Inter', accent: 'freight text pro' }, adobe.families)).toEqual(['heading', 'accent']);
  });
});
