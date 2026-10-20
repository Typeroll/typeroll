/**
 * An address field with suggestions looks like the plain field beside it.
 *
 * The Places loader hides the block's input and shows Google's
 * PlaceAutocompleteElement instead. That element brought its own border,
 * radius, height, fonts and `color-scheme: light dark`, so a banner showed two
 * kinds of field side by side, and dark in a dark-mode browser on a light site.
 *
 * The stand-in has the same closed shadow structure and default styles as
 * Google's element (copied from Maps JS 3.65/3.66), so the mapping is checked
 * without the network; the `google` variant checks it against the real
 * element.
 */
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import {
  buildCoreBlockRegistry,
  collectBlockAssets,
  integrationConfigKey,
  renderBlocks,
  renderClientCapabilityScripts,
  type Block,
} from '@typeroll/shared';

const registry = buildCoreBlockRegistry();
const reset = fs.readFileSync(new URL('../../../site-template/src/styles/reset.css', import.meta.url), 'utf8');

const banner: Block = {
  id: 'banner', type: 'core/navigation_form',
  data: {
    destination: '/quote/', button_label: 'Beräkna pris', button_icon: '→', button_icon_size_px: 20, button_font_weight: 700,
    font: 'body', show_labels: false, columns: { mobile: 1, laptop: 4 },
    input_height_px: 52, input_padding_x_px: 16, input_padding_y_px: 12, input_border_width_px: 2, radius_px: 4,
    font_size_px: 16, line_height: 1.5, input_border_color: '#ffffff', input_background: '#ffffff', input_color: '#333333',
    fields: [
      { name: 'address_from', label: 'Moving from', placeholder: 'Moving from', suggest_address: true },
      { name: 'm2', label: 'Area', placeholder: 'Area', kind: 'number' },
    ],
  },
};

// Same parts, slots and defaults as Google's element. The shadow root is
// closed, as Google's is, so only supported styling can reach it.
const STAND_IN = `
class PlaceAutocompleteElement extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'closed' });
    root.innerHTML = '<style>:host{background-color:light-dark(#fff,#131314);border:1px solid #000;border-radius:3px;box-sizing:border-box;color:light-dark(#1f1f1f,#e3e3e3);color-scheme:light dark;display:block;font-family:"Google Sans Text","Google Sans",Roboto,Arial,sans-serif;font-size:16px}'
      + '.widget-container{border-radius:inherit;box-sizing:border-box;display:flex;flex-direction:column;height:100%;width:100%}'
      + '.input-container{display:flex;align-items:center;flex-direction:row;height:100%;border-radius:inherit;justify-content:space-evenly;position:relative}'
      + '.autocomplete-icon{display:flex;align-items:center;justify-content:center;flex:0 0 auto;height:48px;width:48px;color:inherit}'
      + 'input{border:none;flex:1 1 auto;background-color:inherit;color:inherit;font:inherit;height:calc(100% - 2px);min-width:0;outline:none}</style>'
      + '<div class="widget-container"><div class="input-container"><div class="autocomplete-icon"><slot name="input-icon"><svg width="24" height="24"></svg></slot></div>'
      + '<input part="input"></div><div part="prediction-list"></div></div>';
    this.input = root.querySelector('input');
    // The Maps API inserts its fonts the first time an element is created.
    for (const href of ['https://fonts.googleapis.com/css?family=Google+Sans+Text:400&text=%E2%86%90', 'https://fonts.googleapis.com/css?family=Roboto:300,400,500,700|Google+Sans:400,500,700']) {
      const link = document.createElement('link'); link.setAttribute('rel', 'stylesheet'); link.setAttribute('href', href);
      document.head.insertBefore(link, document.head.firstChild);
    }
  }
  set placeholder(value) { this.input.placeholder = value; }
}
customElements.define('gmp-place-autocomplete', PlaceAutocompleteElement);
window.google = { maps: { places: { PlaceAutocompleteElement } } };`;

// The published page's block runtime, as in page-handoff.spec.ts.
const blocksRuntime = (js: string) =>
  `(function(){var registry={};window.TyperollBlocks={register:function(id,init){registry[id]=init;},init:function(){Object.keys(registry).forEach(function(id){document.querySelectorAll('[data-block-type="'+id+'"]').forEach(function(el){registry[id](el);});});}};${js};window.TyperollBlocks.init();})();`;

function documentHtml(): string {
  const assets = collectBlockAssets([banner], registry);
  const loader = renderClientCapabilityScripts({ [integrationConfigKey('google_places', 'browser_key')]: 'AIza' + 'b'.repeat(35) }, ['address_autocomplete']);
  return `<!doctype html><html lang="sv"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${reset}:root{--font-body:Georgia,serif}body{margin:0;padding:16px;background:#3a7bbf}${assets.css}</style>`
    + `<body>${renderBlocks([banner], { registry })}${loader.tags}${loader.consentTags}<script>${blocksRuntime(assets.js)}</script></body></html>`;
}

// The block runtime needs a real origin (same-origin destination check).
async function open(page: Page) {
  await page.route('https://site.test/', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: documentHtml() }));
  await page.goto('https://site.test/');
}

// `stand-in` runs everywhere. `google` loads the real Maps JavaScript API from
// the quarterly channel the loader uses, with a placeholder key: the element
// still renders with Google's own styles, so a Google change to them shows up
// here. It is skipped, with the reason, only when Google cannot be reached.
for (const provider of ['stand-in', 'google'] as const) for (const colorScheme of ['light', 'dark'] as const) {
  test(`suggest field matches the plain field (${provider}, ${colorScheme} browser)`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    if (provider === 'stand-in') {
      await page.route('https://maps.googleapis.com/**', route => route.fulfill({
        contentType: 'text/javascript', body: `${STAND_IN};window.__typerollPlacesReady();`,
      }));
    }
    let unreachable = '';
    page.on('requestfailed', request => { if (request.url().startsWith('https://maps.googleapis.com/')) unreachable = request.failure()?.errorText ?? 'failed'; });
    await open(page);
    const replaced = page.locator('gmp-place-autocomplete[data-typeroll-field]');
    if (provider === 'google') {
      await replaced.waitFor({ state: 'attached', timeout: 15_000 }).catch(() => undefined);
      test.skip(Boolean(unreachable) && await replaced.count() === 0, `Google Maps JavaScript API unreachable: ${unreachable}`);
    }
    await expect(replaced).toHaveCount(1);
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      const [suggest, plain] = await Promise.all([replaced, page.locator('input[name="m2"]')].map(locator => locator.evaluate(element => {
        const style = getComputedStyle(element);
        return {
          border: style.borderTop, radius: style.borderRadius, height: element.getBoundingClientRect().height,
          background: style.backgroundColor, color: style.color, font: `${style.fontFamily} ${style.fontSize} ${style.lineHeight}`,
          scheme: style.colorScheme === 'normal' ? 'page' : style.colorScheme,
        };
      })));
      expect(suggest, `${width}px`).toEqual(plain);
      expect(suggest.height).toBe(52);
    }
    // The icon takes the field's text colour; Google's own icon is fixed grey.
    expect(await replaced.locator('[slot="input-icon"]').evaluate(icon => getComputedStyle(icon).color)).toBe('rgb(51, 51, 51)');
    // The Maps API's own font stylesheets are not added; the page's are.
    expect(await page.locator('link[href*="fonts.googleapis.com/css?family="]').count()).toBe(0);
    // The block input is still the value carrier.
    await expect(page.locator('input[name="address_from"]')).toBeHidden();
  });
}

test('button icon keeps the button size', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  const button = page.locator('[data-navigation-continue]');
  const icon = button.locator('.navigation-button-icon');
  await expect(icon).toHaveAttribute('aria-hidden', 'true');
  expect(await icon.evaluate(element => getComputedStyle(element).fontSize)).toBe('20px');
  expect(await button.evaluate(element => getComputedStyle(element).fontWeight)).toBe('700');
  expect((await button.boundingBox())!.height).toBe(52);
  await expect(button).toHaveAccessibleName('Beräkna pris');
});
