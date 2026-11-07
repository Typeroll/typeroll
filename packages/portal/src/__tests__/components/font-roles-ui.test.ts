// Font roles elsewhere in the portal: a block's font setting and a style's
// font name the site's families, and the typography preview loads the site's
// fonts inside its sandbox.

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CORE_BLOCK_TYPES, defaultBreakpointWidths, defaultSiteSettings, type FieldDefinition, type SiteStyle } from '@typeroll/shared';
import FieldInput, { RenderVersionContext, SiteFontsContext } from '../../components/FieldInput';
import StyleLibrary from '../../components/StyleLibrary';
import { typographyPreviewDocument } from '../../components/TypographyPreview';

const proseFont = CORE_BLOCK_TYPES.find(type => type.id === 'core/prose')!.schema.find(field => field.name === 'font')! as FieldDefinition;
const fonts = { heading: 'Playfair Display', body: 'Inter', size_base: 16 };

function fontField(renderVersion: number | null, siteFonts: typeof fonts | null, value = 'inherit') {
  return renderToStaticMarkup(createElement(RenderVersionContext.Provider, { value: renderVersion },
    createElement(SiteFontsContext.Provider, { value: siteFonts },
      createElement(FieldInput, { siteId: 'site-1', field: proseFont, value, onChange: () => {} }))));
}

describe('a block’s font setting', () => {
  it('names each role’s family from render version 15', () => {
    const html = fontField(15, fonts);
    expect(html).toContain('>Heading — Playfair Display</option>');
    expect(html).toContain('>Body — Inter</option>');
    expect(html).toContain('>Display — same as heading</option>');
    expect(html).toContain('>Accent — same as body</option>');
    expect(html).toContain('>Monospace — system monospace</option>');
  });

  it('hides display and accent below render version 15 unless chosen', () => {
    expect(fontField(14, fonts)).not.toContain('value="display"');
    expect(fontField(14, fonts)).not.toContain('value="accent"');
    expect(fontField(14, fonts, 'display')).toContain('>Display — same as heading until render version 15</option>');
  });

  it('marks display and accent when the render version is unknown', () => {
    expect(fontField(null, null)).toContain('>Display (render version 15)</option>');
  });
});

describe('a style’s font', () => {
  const styles: SiteStyle[] = [{ id: 'lead', name: 'Lead', targets: ['text'], base: { font: 'display' } }];
  const render = (renderVersion: number) => renderToStaticMarkup(createElement(StyleLibrary, {
    siteId: 'site-1', initialStyles: styles, colors: defaultSiteSettings.colors, breakpoints: defaultBreakpointWidths,
    renderVersion, baseCss: '', canEdit: true, fonts: { ...fonts, display: 'Anton' }, language: 'sv',
  }));

  it('labels each role with the site’s family and shows a sample in the chosen one', () => {
    const html = render(15);
    expect(html).toContain('>Heading — Playfair Display</option>');
    expect(html).toContain('>Display — Anton</option>');
    expect(html).toContain('>Accent — same as body</option>');
    expect(html).toMatch(/font-family:&#x27;Anton&#x27;[^"]*">Flygande bäckasiner söka hwila/);
    // The sandboxed preview waits for the site's Fonts library before linking any family.
    expect(html).not.toContain('fonts.googleapis.com');
  });

  it('keeps a chosen display role visible on an older site', () => {
    const html = render(14);
    expect(html).toContain('>Display — same as heading until render version 15</option>');
    expect(html).not.toContain('>Accent');
  });
});

describe('the typography preview', () => {
  it('allows only font sources besides inline styles and puts the fonts after the policy', () => {
    const head = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&amp;display=swap">';
    const html = typographyPreviewDocument(defaultSiteSettings, head);
    const policy = /content="([^"]+)"/.exec(html)![1]!;
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain('style-src \'unsafe-inline\' https://fonts.googleapis.com');
    expect(policy).toContain('font-src data: https://fonts.gstatic.com');
    expect(policy).not.toMatch(/script-src|img-src|connect-src/);
    expect(html.indexOf(head)).toBeGreaterThan(html.indexOf('Content-Security-Policy'));
    expect(html).not.toContain('<script');
  });
});
