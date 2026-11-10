/**
 * core/embed — the one-off scripting escape hatch, and the per-instance
 * script plumbing that carries it.
 *
 * The load-bearing property: a block's `js` field must reach the visitor's
 * browser WITHOUT the renderer emitting a <script> into the page body, since
 * everything in the body runs through the customer-HTML sanitizer. It rides
 * the same bundle as per-type BlockType.script, outside the sanitized body.
 */
import { describe, it, expect } from 'vitest';
import { buildCoreBlockRegistry, collectBlockAssets, renderBlocks } from '../index';
import type { Block } from '../index';

const registry = buildCoreBlockRegistry();

const embedBlock = (data: Record<string, unknown>, id = 'blk_embed'): Block =>
  ({ id, type: 'core/embed', data }) as Block;

describe('core/embed block type', () => {
  it('is registered and declares js as its only code field', () => {
    const bt = registry.get('core/embed');
    expect(bt).toBeDefined();
    // The declaration is what puts the field under the platform script gate.
    // If this list grows silently, fields become executable without anyone
    // deciding they should be.
    expect(bt!.script_fields).toEqual(['js']);
  });

  it('keeps html an ordinary markup field, not a code field', () => {
    const bt = registry.get('core/embed');
    expect(bt!.script_fields).not.toContain('html');
  });
});

describe('per-instance script emission', () => {
  it('puts the js in the asset bundle, never in the rendered body', () => {
    const blocks = [embedBlock({ html: '<div id="x"></div>', js: 'el.dataset.ran = "1"' })];

    const body = renderBlocks(blocks, { registry });
    // The whole point: nothing script-shaped in the body, because the body
    // gets sanitized and a <script> there would simply vanish.
    expect(body).not.toContain('<script');
    expect(body).toContain('<div id="x"></div>');

    const { js } = collectBlockAssets(blocks, registry);
    expect(js).toContain('el.dataset.ran = "1"');
  });

  it('scopes the code to its own element via data-bid', () => {
    const blocks = [embedBlock({ html: '<p>hi</p>', js: 'el.textContent = "ran"' })];
    const body = renderBlocks(blocks, { registry });
    // Without data-bid on the root the IIFE's querySelector finds nothing and
    // the script silently no-ops on the deployed site.
    expect(body).toContain('data-bid="blk_embed"');
    expect(collectBlockAssets(blocks, registry).js)
      .toContain('document.querySelector(\'[data-bid="blk_embed"]\')');
  });

  it('emits nothing for an embed with no js', () => {
    const blocks = [embedBlock({ html: '<p>just markup</p>' })];
    expect(collectBlockAssets(blocks, registry).js).toBe('');
  });

  it('ignores a whitespace-only js field', () => {
    const blocks = [embedBlock({ html: '<p>x</p>', js: '   \n  ' })];
    expect(collectBlockAssets(blocks, registry).js).toBe('');
  });

  it('neutralises </script> so the code cannot break out of the bundle tag', () => {
    // The bundle is written into a <script> element by BaseLayout. A literal
    // </script> in author code would close it early and dump the remainder
    // into the document as markup.
    const blocks = [embedBlock({ html: '', js: 'var s = "</script><img src=x onerror=alert(1)>"' })];
    const { js } = collectBlockAssets(blocks, registry);
    expect(js).not.toContain('</script>');
    expect(js).toContain('<\\/script');
  });

  it('collects nested embeds in document order', () => {
    const blocks: Block[] = [
      {
        id: 'sec', type: 'core/section', data: {},
        children: [
          embedBlock({ js: 'first()' }, 'blk_a'),
          embedBlock({ js: 'second()' }, 'blk_b'),
        ],
      } as Block,
    ];
    const { js } = collectBlockAssets(blocks, registry);
    // Document order, not sorted-by-id: instance scripts can depend on DOM
    // order and that's the only ordering an author can reason about.
    expect(js.indexOf('first()')).toBeLessThan(js.indexOf('second()'));
  });

  it('drops all JS when includeScripts is false', () => {
    // How the portal preview keeps foreign block JS off its own origin.
    const blocks = [embedBlock({ html: '<p>x</p>', js: 'steal(document.cookie)' })];
    const { js, css } = collectBlockAssets(blocks, registry, { includeScripts: false });
    expect(js).toBe('');
    // …without taking the styles down with it — the preview must still look right.
    expect(css).not.toBe('');
  });
});

describe('consent-gated embeds', () => {
  const html = '<iframe src="https://tool.vendor.example/compare" title="Compare"></iframe>';

  it('renders an embed without consent exactly as before', () => {
    // consent "none" is the default and must not change a byte of existing output.
    const plain = renderBlocks([embedBlock({ html, js: 'x()' })], { registry });
    expect(renderBlocks([embedBlock({ html, js: 'x()', consent: 'none' })], { registry })).toBe(plain);
    expect(plain).not.toContain('<template');
    expect(plain).not.toContain('data-tr-consent');
    expect(collectBlockAssets([embedBlock({ html, js: 'x()', consent: 'none' })], registry))
      .toEqual(collectBlockAssets([embedBlock({ html, js: 'x()' })], registry));
  });

  it('keeps the html inert in a consent template next to a placeholder', () => {
    const body = renderBlocks([embedBlock({ html, consent: 'optional' })], { registry });
    expect(body).toContain('data-tr-consent-embed="optional"');
    expect(body).toContain(`<template data-tr-consent="optional">${html}</template>`);
    // The iframe exists only inside the template.
    expect(body.replace(/<template[\s\S]*<\/template>/, '')).not.toContain('<iframe');
    expect(body).toContain('<div class="tr-consent-embed" data-tr-consent-placeholder>');
    expect(body).toContain('<button type="button" class="tr-consent-embed__button" data-tr-open-consent>Manage cookie settings</button>');
    expect(body).toContain('This content is shown when you accept all cookies.');
  });

  it('writes the placeholder in the page language and uses the site label', () => {
    const body = renderBlocks([embedBlock({ html, consent: 'optional' })], {
      registry,
      context: { page: { language: 'nl-NL' }, site: { cookie_consent: { enabled: true } } },
    });
    expect(body).toContain('Deze inhoud wordt getoond als je alle cookies accepteert.');
    expect(body).toContain('>Cookie-instellingen beheren</button>');
    const labelled = renderBlocks([embedBlock({ html, consent: 'optional' })], {
      registry,
      context: { page: { language: 'nl' }, site: { cookie_consent: { enabled: true, labels: { manage: 'Cookievoorkeuren' } } } },
    });
    expect(labelled).toContain('>Cookievoorkeuren</button>');
  });

  it('shows the block\'s own placeholder text, escaped', () => {
    const body = renderBlocks([embedBlock({ html, consent: 'optional', consent_placeholder: 'Vergelijker <na> toestemming' })], { registry });
    expect(body).toContain('<p class="tr-consent-embed__text">Vergelijker &lt;na&gt; toestemming</p>');
  });

  it('runs the js only after the consent runtime activated the block', () => {
    const blocks = [embedBlock({ html, js: 'el.dataset.ran = "1"', consent: 'optional' })];
    const { js, css } = collectBlockAssets(blocks, registry);
    expect(js).toContain('typeroll:consent-embed');
    expect(js).toContain('el.dataset.ran = "1"');
    expect(css).toContain('.tr-consent-embed');
    expect(renderBlocks(blocks, { registry })).toContain('data-bid="blk_embed"');
  });

  it('ships the placeholder styles only on pages with a gated embed', () => {
    expect(collectBlockAssets([embedBlock({ html })], registry).css).not.toContain('tr-consent-embed');
    const nested: Block[] = [{ id: 'sec', type: 'core/section', data: {}, children: [embedBlock({ html, consent: 'optional' })] } as Block];
    expect(collectBlockAssets(nested, registry).css).toContain('tr-consent-embed');
  });
});
