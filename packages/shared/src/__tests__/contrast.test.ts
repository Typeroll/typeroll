import { describe, it, expect } from 'vitest';
import {
  apcaContrast,
  apcaLc,
  apcaLuminance,
  contrastRatio,
  formatContrast,
  onColorApca,
  onColorWcag,
  requiredContrast,
  textContrast,
} from '../index.js';

describe('APCA-W3 0.0.98G-4g', () => {
  // The test vectors of the reference implementation (apca-w3 0.1.9,
  // test/index.js), text colour first.
  const reference: [string, string, number][] = [
    ['#888', '#fff', 63.056469930209424],
    ['#fff', '#888', -68.54146436644962],
    ['#000', '#aaa', 58.146262578561334],
    ['#aaa', '#000', -56.24113336839742],
    ['#123', '#def', 91.66830811481631],
    ['#def', '#123', -93.06770049484275],
    ['#123', '#444', 8.32326136957393],
    ['#444', '#123', -7.526878460278154],
    ['#0006', '#fff', 54.62184067441377],
  ];

  it.each(reference)('%s on %s is Lc %d', (text, background, lc) => {
    expect(apcaContrast(text, background)).toBeCloseTo(lc, 9);
  });

  it('measures the moveria.se secondary colour', () => {
    expect(apcaContrast('#ffffff', '#00a19c')).toBeCloseTo(-63.88, 2);
    expect(contrastRatio('#ffffff', '#00a19c')).toBeCloseTo(3.19, 2);
    expect(apcaContrast('#111827', '#00a19c')).toBeCloseTo(44.05, 2);
    expect(contrastRatio('#111827', '#00a19c')).toBeCloseTo(5.56, 2);
  });

  it('returns 0 for equal or invalid luminance and null for unknown colours', () => {
    expect(apcaContrast('#777', '#777')).toBe(0);
    expect(apcaLc(Number.NaN, 1)).toBe(0);
    expect(apcaLc(0.5, 2)).toBe(0);
    expect(apcaContrast('var(--x)', '#fff')).toBeNull();
    expect(apcaContrast('#000', 'rgba(0,0,0,0.5)')).toBeNull();
    expect(apcaLuminance([255, 255, 255])).toBeCloseTo(1, 6);
  });

  it('formats both measures with Lc as a magnitude', () => {
    expect(formatContrast({ lc: -63.876, wcag: 3.1912 })).toBe('APCA Lc 63.9, WCAG 2 3.19:1');
  });
});

describe('automatic text colour on a theme colour', () => {
  it('differs from WCAG 2 on mid-dark saturated colours', () => {
    for (const color of ['#00a19c', '#3b82f6', '#16a34a']) {
      expect(onColorWcag(color), color).toBe('#111827');
      expect(onColorApca(color), color).toBe('#ffffff');
    }
  });

  it('agrees on clearly light and dark colours', () => {
    for (const [color, text] of [['#f59e0b', '#111827'], ['#facc15', '#111827'], ['#1e293b', '#ffffff'], ['#2563eb', '#ffffff']]) {
      expect(onColorWcag(color), color).toBe(text);
      expect(onColorApca(color), color).toBe(text);
    }
  });
});

describe('required contrast', () => {
  it('asks Lc 75 for body text and Lc 60 for secondary text', () => {
    expect(requiredContrast({ use: 'body' })).toMatchObject({ lc: 75, wcag: 4.5 });
    expect(requiredContrast({ use: 'sub_fluent', px: 14 })).toMatchObject({ lc: 60, wcag: 4.5 });
    expect(requiredContrast({ use: 'body', px: 12 }).lc).toBe(90);
    expect(requiredContrast({ use: 'body', weight: 300 }).lc).toBe(90);
  });

  it('takes size and weight into account for non-body text', () => {
    expect(requiredContrast({ use: 'content', px: 16, weight: 600 })).toMatchObject({ lc: 60, wcag: 4.5, label: '16px/600 non-body text' });
    expect(requiredContrast({ use: 'content', px: 16, weight: 700 }).lc).toBe(60);
    expect(requiredContrast({ use: 'content', px: 16, weight: 400 }).lc).toBe(75);
    expect(requiredContrast({ use: 'content', px: 21, weight: 500 }).lc).toBe(60);
    expect(requiredContrast({ use: 'content', px: 13, weight: 700 }).lc).toBe(75);
    expect(requiredContrast({ use: 'content', px: 24, weight: 700 })).toMatchObject({ lc: 45, wcag: 3 });
    expect(requiredContrast({ use: 'content', px: 36, weight: 400 }).lc).toBe(45);
    expect(requiredContrast({ use: 'content', px: 36, weight: 300 }).lc).toBe(60);
    expect(requiredContrast({ use: 'content', px: 19, weight: 700 }).wcag).toBe(3);
  });

  it('passes white 16px/600 on #00a19c for buttons, but not as body text', () => {
    const button = textContrast('#ffffff', '#00a19c', { use: 'content', px: 16, weight: 600 })!;
    expect(button).toMatchObject({ apca_pass: true, wcag_pass: false });
    const dark = textContrast('#111827', '#00a19c', { use: 'content', px: 16, weight: 600 })!;
    expect(dark).toMatchObject({ apca_pass: false, wcag_pass: true });
    expect(textContrast('#ffffff', '#00a19c', { use: 'body' })!.apca_pass).toBe(false);
  });

  it('compares Lc rounded to a whole number', () => {
    // #2563eb on white is Lc 74.86: body text at Lc 75.
    expect(textContrast('#2563eb', '#ffffff', { use: 'body' })!.apca_pass).toBe(true);
    expect(textContrast('#64748b', '#ffffff', { use: 'body' })!.apca_pass).toBe(false);
  });
});
