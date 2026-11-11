// App contracts in shared code: manifest validation, mount markup (blocks and
// the <x-extension> directive), default markup injection into built pages,
// and the browser runtime's live module import.

import { afterEach, describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { validateExtensionManifest, type ExtensionManifest, type ExtensionRuntimeSnapshot } from '../extensions';
import { buildExtensionRuntimeScript } from '../extensions-runtime';
import { expandExtensionIncludes } from '../global-blocks';
import { renderBlocks } from '../render-blocks';
import { buildCoreBlockRegistry } from '../core-blocks';
import { extensionMarkupKey, injectExtensionMarkup, type FrozenExtensionMarkup } from '../extension-markup';
import type { BlockType } from '../types';

function contractManifest(patch: Record<string, unknown> = {}, component: Record<string, unknown> = {}): ExtensionManifest {
  return {
    schema_version: 3, id: 'com.typeroll.recurring-events', name: 'Recurring Events', version: '0.2.0',
    runtime_compatibility: '>=0.46.0 <1.0.0', distribution: 'private', contract: 1,
    developer: { name: 'Typeroll', support_url: 'https://typeroll.example/support', privacy_url: 'https://typeroll.example/privacy' },
    permissions: [{ scope: 'content:read', reason: 'Reads pages.' }, { scope: 'email:send', reason: 'Reminders.', optional: true }],
    frontend: { components: [{
      id: 'next-occurrence', label: 'Next occurrence', render_mode: 'contract_component',
      entry: { module_url: 'https://events.typeroll.example/v1/next-occurrence.js' },
      variants: { path: '/variants' }, default_markup: { path: '/default-markup' }, ...component,
    }] },
    api: { base_url: 'https://events.typeroll.example/v1', authentication: 'signed_installation', routes: [] },
    ...patch,
  } as ExtensionManifest;
}

describe('contract manifest validation', () => {
  it('accepts a contract with variants, default markup and optional permissions', () => {
    expect(validateExtensionManifest(contractManifest()).errors).toEqual([]);
  });

  it('accepts a static contract component without a module', () => {
    expect(validateExtensionManifest(contractManifest({}, { entry: {} })).errors).toEqual([]);
  });

  it.each([
    ['a non-integer contract', contractManifest({ contract: 1.5 }), 'contract must be an integer'],
    ['contract 0', contractManifest({ contract: 0 }), 'contract must be an integer'],
    ['a contract without an API', contractManifest({ api: undefined }), 'contract requires api.base_url'],
    ['an http module', contractManifest({}, { entry: { module_url: 'http://events.example/m.js' } }), 'module_url'],
    ['a module digest', contractManifest({}, { entry: { module_url: 'https://events.typeroll.example/m.js', script_sha256: 'a'.repeat(64) } }), 'entry.script_sha256 is not supported'],
    ['props', contractManifest({}, { props_schema: { type: 'object', properties: {} } }), 'props_schema is not supported'],
    ['page handoff', contractManifest({}, { page_handoff: true }), 'page_handoff is not supported'],
    ['an absolute variants path', contractManifest({}, { variants: { path: 'https://x.example/v' } }), 'variants.path'],
    ['unknown call fields', contractManifest({}, { default_markup: { path: '/m', url: 'x' } }), 'default_markup.url'],
  ])('rejects %s', (_label, manifest, message) => {
    expect(validateExtensionManifest(manifest).errors.join('\n')).toContain(message);
  });

  it('keeps contract fields out of manifests without a contract', () => {
    const legacy = contractManifest({ contract: undefined });
    const errors = validateExtensionManifest(legacy).errors.join('\n');
    expect(errors).toContain('contract_component requires a contract');
    expect(errors).toContain('optional requires a contract');
    const bundled = contractManifest({ contract: undefined, permissions: [] }, {
      render_mode: 'bundled_component', entry: { script_url: 'https://cdn.example/a.js', script_sha256: 'a'.repeat(64) },
    });
    expect(validateExtensionManifest(bundled).errors.join('\n')).toContain('variants requires render_mode contract_component');
  });
});

const contractType: BlockType = {
  id: 'extension--inst-1--next-occurrence', name: 'events-next', label: 'Next occurrence', icon: 'Blocks', category: 'custom', container: false,
  schema: [{ name: 'variant', type: 'text', label: 'Variant', default: 'standard' }, { name: 'reserve_px', type: 'number', label: 'Reserved height' }],
  template: '<div class="tr-extension-mount"><p class="tr-extension-placeholder">Next occurrence loads on the published site.</p></div>',
  extension: { extension_id: 'com.typeroll.recurring-events', installation_id: 'inst-1', component_id: 'next-occurrence', render_mode: 'contract_component' },
  created_at: '1970-01-01T00:00:00.000Z',
};

describe('contract mount markup', () => {
  const registry = buildCoreBlockRegistry();
  registry.set(contractType.id, contractType);

  it('names the variant and reserves height, without block data', () => {
    const html = renderBlocks([{ id: 'b1', type: contractType.id, data: { variant: 'lunch-page', reserve_px: 160 } }], { registry });
    expect(html).toContain('data-tr-extension="com.typeroll.recurring-events"');
    expect(html).toContain('data-tr-extension-installation="inst-1"');
    expect(html).toContain('data-tr-extension-component="next-occurrence"');
    expect(html).toContain('data-tr-extension-variant="lunch-page"');
    expect(html).toContain('min-height:160px');
    expect(html).not.toContain('data-block-data');
  });

  it('renders standard for a missing or invalid variant', () => {
    expect(renderBlocks([{ id: 'b2', type: contractType.id, data: {} }], { registry })).toContain('data-tr-extension-variant="standard"');
    expect(renderBlocks([{ id: 'b3', type: contractType.id, data: { variant: '<x>' } }], { registry })).toContain('data-tr-extension-variant="standard"');
  });

  it('expands the directive with a variant instead of props', () => {
    const html = expandExtensionIncludes('<x-extension block="known" variant="series-7" reserve="90" props=\'{"a":1}\' />', () => ({
      extension_id: 'com.typeroll.recurring-events', installation_id: 'inst-1', component_id: 'next-occurrence', label: 'Next', render_mode: 'contract_component',
    }));
    expect(html).toBe('<div class="tr-extension-mount" data-tr-extension="com.typeroll.recurring-events" data-tr-extension-installation="inst-1" data-tr-extension-component="next-occurrence" data-tr-extension-variant="series-7" style="min-height:90px"><p class="tr-extension-placeholder">Next loads on the published site.</p></div>');
  });
});

describe('default markup injection', () => {
  const frozen: FrozenExtensionMarkup = {
    format: 1, default_language: 'sv',
    apps: { 'inst-1': {
      extension_id: 'com.typeroll.recurring-events',
      markup: {
        [extensionMarkupKey('next-occurrence', 'lunch-page', 'sv')]: '<a href="#anmalan">Anmäl dig</a><script type="module" src="/_assets/apps/x/0123456789abcdef/a.js"></script>',
        [extensionMarkupKey('next-occurrence', 'standard', 'sv')]: '<p>Nästa tillfälle</p>',
      },
      assets: [],
      styles: ['/_assets/apps/com-typeroll-recurring-events/0123456789abcdef/events.css'],
    } },
  };
  const page = (lang: string, body: string) => `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><link rel="stylesheet" href="/_astro/site.css"><style>body{}</style></head><body>${body}</body></html>`;
  const mount = (variant: string) => `<div class="tr-extension-mount" data-tr-extension="com.typeroll.recurring-events" data-tr-extension-installation="inst-1" data-tr-extension-component="next-occurrence" data-tr-extension-variant="${variant}"><p class="tr-extension-placeholder">Next loads on the published site.</p></div>`;

  it('writes the markup unfiltered inside each mount and links the app styles before site CSS, once', () => {
    const html = injectExtensionMarkup(page('sv', mount('lunch-page') + mount('lunch-page') + mount('standard')), frozen);
    expect(html).toContain('data-tr-extension-variant="lunch-page"><a href="#anmalan">Anmäl dig</a><script type="module"');
    expect(html).toContain('data-tr-extension-variant="standard"><p>Nästa tillfälle</p></div>');
    expect(html).not.toContain('tr-extension-placeholder');
    expect(html.match(/data-tr-extension-style/g)).toHaveLength(1);
    expect(html.indexOf('events.css')).toBeLessThan(html.indexOf('/_astro/site.css'));
  });

  it('falls back to the default language and leaves unknown mounts as they are', () => {
    expect(injectExtensionMarkup(page('en', mount('standard')), frozen)).toContain('<p>Nästa tillfälle</p>');
    // The app's styles still apply to the page; the mount itself stays empty (placeholder hidden).
    expect(injectExtensionMarkup(page('sv', mount('other')), frozen)).toContain(`${mount('other')}</body>`);
  });

  it('does not touch pages without contract mounts or legacy mounts', () => {
    const legacy = page('sv', '<div data-tr-extension-installation="inst-1" data-tr-extension-component="next-occurrence" data-block-data="{}"></div>');
    expect(injectExtensionMarkup(legacy, frozen)).toBe(legacy);
  });
});

describe('contract runtime', () => {
  const windows: Window[] = [];
  afterEach(async () => { for (const browser of windows.splice(0)) await browser.happyDOM.close(); });

  async function run(body: string, entry: Record<string, unknown>, mountImpl?: () => Promise<never>) {
    const browser = new Window({ url: 'https://site.example/', settings: { disableIframePageLoading: true } });
    windows.push(browser);
    const imports: string[] = [];
    const mounts: Array<{ props: unknown; variant: unknown; html: string }> = [];
    (browser as unknown as Record<string, unknown>).__importForTest = async (url: string) => {
      imports.push(url);
      if (mountImpl) return mountImpl();
      return { mount: (el: { innerHTML: string }, props: unknown, context: { variant?: unknown }) => { mounts.push({ props, variant: context.variant, html: el.innerHTML }); } };
    };
    const snapshot: ExtensionRuntimeSnapshot = { runtime_version: '0.46.0', protocol_version: 3, installations: [{
      installation_id: 'inst-1', extension_id: 'com.typeroll.recurring-events', version: '0.2.0', contract: 1, public_config: {},
      components: [{ id: 'next-occurrence', block_type_id: contractType.id, label: 'Next', render_mode: 'contract_component', entry: entry as never }],
    }] };
    const runtime = buildExtensionRuntimeScript(snapshot);
    expect(runtime).toContain('await import(component.entry.module_url)');
    browser.document.body.innerHTML = body;
    browser.eval(runtime.replace('await import(component.entry.module_url)', 'await window.__importForTest(component.entry.module_url)'));
    browser.document.dispatchEvent(new browser.Event('DOMContentLoaded'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { imports, mounts, html: browser.document.body.innerHTML };
  }
  const mountHtml = '<div data-tr-extension-installation="inst-1" data-tr-extension-component="next-occurrence" data-tr-extension-variant="lunch-page" data-block-data=\'{"x":1}\'><a href="#anmalan">Anmäl dig</a></div>';

  it('imports the stable module and mounts with the variant, keeping the default markup in place', async () => {
    const result = await run(mountHtml, { module_url: 'https://events.typeroll.example/v1/next.js' });
    expect(result.imports).toEqual(['https://events.typeroll.example/v1/next.js']);
    expect(result.mounts).toEqual([{ props: { variant: 'lunch-page' }, variant: 'lunch-page', html: '<a href="#anmalan">Anmäl dig</a>' }]);
  });

  it('keeps the default markup when the module cannot load', async () => {
    const result = await run(mountHtml, { module_url: 'https://events.typeroll.example/v1/next.js' }, async () => { throw new Error('offline'); });
    expect(result.html).toContain('Anmäl dig');
    expect(result.html).not.toContain('tr-extension-unavailable');
  });

  it('loads nothing for a static component', async () => {
    const result = await run(mountHtml, {});
    expect(result.imports).toEqual([]);
    expect(result.html).toContain('Anmäl dig');
  });
});
