// Pure helpers behind the Fonts library page: grouping, labels, the upload
// draft and its form data, prefilling from an inspected file and edits.

import { describe, expect, it } from 'vitest';
import type { SiteFontFile } from '@typeroll/shared';
import {
  describeInspected, emptyUploadDraft, fontFormatLabel, fontPatch, formatBytes, formatFontWeight, groupFontFamilies, parseFontWeight,
  prefillFromInspect, uploadFormData, uploadProblems,
} from '../../components/font-library-model';

const font = (id: string, family: string, weight: SiteFontFile['weight'], style: 'normal' | 'italic' = 'normal', extra: Partial<SiteFontFile> = {}): SiteFontFile => ({
  id, family, weight, style,
  file: { format: 'woff2', bytes: 48_128, sha256: id, key: `fonts/${id}.woff2` },
  licence: { confirmed: true, by: 'anna@example.com', at: '2026-11-01T10:00:00.000Z' },
  created_at: '2026-11-01T10:00:00.000Z',
  ...extra,
});
const fontFile = (name: string, size = 1000) => new File([new Uint8Array(size)], name);

describe('the library list', () => {
  it('groups files by family, upright before italic, light to bold, with the roles using it', () => {
    const groups = groupFontFamilies([
      font('b7', 'Brand', 700), font('b4i', 'Brand', 400, 'italic'), font('b4', 'brand', 400, 'normal', { category: 'serif' }), font('a', 'Acme Sans', [100, 900]),
    ], { Brand: ['heading', 'display', 'nonsense'] });
    expect(groups.map(group => group.family)).toEqual(['Acme Sans', 'Brand']);
    expect(groups[1]!.files.map(file => file.id)).toEqual(['b4', 'b7', 'b4i']);
    expect(groups[1]!.roles).toEqual(['heading', 'display']);
    expect(groups[1]!.category).toBe('serif');
    expect(groups[0]!.roles).toEqual([]);
  });

  it('labels weights, sizes and formats', () => {
    expect(formatFontWeight(font('x', 'X', 400))).toBe('400 Regular');
    expect(formatFontWeight(font('x', 'X', 700, 'italic'))).toBe('700 Bold italic');
    expect(formatFontWeight(font('x', 'X', [100, 900]))).toBe('100–900 variable');
    expect(formatBytes(48_128)).toBe('47 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(fontFormatLabel(font('x', 'X', 400))).toBe('WOFF2');
    expect(fontFormatLabel(font('x', 'X', 400, 'normal', { original: { format: 'ttf', bytes: 1, sha256: 'o', key: 'k' } }))).toBe('WOFF2, converted from TTF');
  });
});

describe('the upload draft', () => {
  it('parses a weight or a variable range', () => {
    expect(parseFontWeight('400')).toBe(400);
    expect(parseFontWeight(' 100-900 ')).toEqual([100, 900]);
    expect(parseFontWeight('100–900')).toEqual([100, 900]);
    expect(parseFontWeight('900-100')).toBeNull();
    expect(parseFontWeight('bold')).toBeNull();
    expect(parseFontWeight('450')).toBeNull();
  });

  it('needs a font file within the limit, a valid weight and the licence confirmation', () => {
    expect(uploadProblems(emptyUploadDraft())).toEqual({ file: 'Choose a font file.', licence: expect.stringContaining('licence') });
    expect(uploadProblems({ ...emptyUploadDraft(), file: fontFile('brand.pdf'), licence_confirmed: true }).file).toBe('Use a WOFF2, WOFF, TTF or OTF file.');
    expect(uploadProblems({ ...emptyUploadDraft(), file: fontFile('big.ttf', 10 * 1024 * 1024 + 1), licence_confirmed: true }).file).toContain('the limit is 10.0 MB');
    expect(uploadProblems({ ...emptyUploadDraft(), file: fontFile('brand.otf'), weight: 'heavy', family: 'Bad;Name', licence_confirmed: true }))
      .toEqual({ weight: expect.any(String), family: expect.any(String) });
    expect(uploadProblems({ ...emptyUploadDraft(), file: fontFile('Brand.WOFF2'), licence_confirmed: true })).toEqual({});
  });

  it('builds the multipart body the upload route reads', () => {
    const data = uploadFormData({ file: fontFile('brand.ttf'), family: ' Brand ', weight: '100–900', style: 'italic', category: 'serif', licence_confirmed: true, licence_note: ' Order 12 ' });
    expect((data.get('file') as File).name).toBe('brand.ttf');
    expect(Object.fromEntries([...data.entries()].filter(([key]) => key !== 'file')))
      .toEqual({ family: 'Brand', weight: '100-900', style: 'italic', category: 'serif', licence_confirmed: 'true', licence_note: 'Order 12' });
    const bare = uploadFormData({ ...emptyUploadDraft(), file: fontFile('a.woff2'), licence_confirmed: true });
    expect(bare.has('family')).toBe(false);
    expect(bare.has('category')).toBe(false);
    expect(bare.get('weight')).toBe('400');
  });

  it('prefills family, weight range and style from the inspected file', () => {
    const draft = prefillFromInspect(emptyUploadDraft(), { format: 'ttf', family: 'Brand Sans', subfamily: 'Italic', italic: true, weight: 400, variable: { axes: ['wght', 'opsz'], wght: [200, 800] } });
    expect(draft).toMatchObject({ family: 'Brand Sans', weight: '200-800', style: 'italic' });
    expect(prefillFromInspect(emptyUploadDraft(), { variable: { wght: [250, 850] } }).weight).toBe('300-800');
    expect(prefillFromInspect(emptyUploadDraft(), { weight: 350 }).weight).toBe('400');
    expect(describeInspected({ format: 'ttf', family: 'Brand Sans', subfamily: 'Italic', variable: { axes: ['wght', 'opsz'], wght: [200, 800] } }))
      .toBe('Brand Sans Italic · variable font, weights 200–800 (axes wght, opsz) · TTF, converted to WOFF2 when saved');
    expect(describeInspected({ format: 'woff2', family: 'Brand', weight: 700 })).toBe('Brand · weight 700 · WOFF2');
  });
});

describe('editing a file', () => {
  it('sends only the changed fields', () => {
    const file = font('b4', 'Brand', 400, 'normal', { category: 'sans', licence: { confirmed: true, by: 'a', at: 'b', note: 'Order 1' } });
    const same = { family: 'Brand', weight: '400', style: 'normal' as const, category: 'sans' as const, licence_note: 'Order 1' };
    expect(fontPatch(file, same)).toBeNull();
    expect(fontPatch(file, { ...same, family: 'Brand Text', weight: '300-700', style: 'italic', category: 'serif', licence_note: '' }))
      .toEqual({ family: 'Brand Text', weight: [300, 700], style: 'italic', category: 'serif', licence_note: '' });
  });
});
