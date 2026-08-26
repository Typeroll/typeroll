// @vitest-environment happy-dom
// @vitest-environment-options {"settings": {"handleDisabledFileLoadingAsSuccess": true}}
import { describe, it, expect, beforeEach } from 'vitest';
import { wrapConsentScripts, buildConsentRuntime } from '../consent-scripts';

// End-to-end check of the browser half: the runtime's activate() must be
// able to bring wrapConsentScripts() output back to life. The old
// implementation set s.text = textContent on ONE node — so HTML content
// (script tags, noscript) was injected as raw "JavaScript" and threw a
// SyntaxError even after consent. Asserts on DOM structure, not vendor
// JS side effects, so the snippets here use inert bodies/URLs.

declare global {
  interface Window {
    typerollConsent: {
      open: () => void;
      close: () => void;
      set: (choice: string) => void;
      get: () => string | null;
    };
  }
}

const SNIPPET = `<script async src="https://tracker.example/lib.js?id=G-TEST"></script>
<script>window.__trConfigRan = true;</script>
<noscript><img src="https://tracker.example/px" alt="" /></noscript>`;

function runRuntime(reload = false): void {
  // Indirect eval = global scope, same as a real inline <script>.
  (0, eval)(buildConsentRuntime(reload));
}

function consentScripts(): HTMLScriptElement[] {
  return Array.from(document.querySelectorAll('script'));
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.cookie = 'tr_consent=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
});

describe('consent runtime activate()', () => {
  it('keeps everything inert before consent', () => {
    document.body.innerHTML = wrapConsentScripts(SNIPPET);
    runRuntime();

    for (const s of consentScripts()) {
      expect(s.getAttribute('type')).toBe('text/plain');
    }
    // noscript img is template content — not a live DOM node yet.
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('noscript')).toBeNull();
  });

  it('recreates each script as a real element after consent, preserving attributes', () => {
    document.body.innerHTML = wrapConsentScripts(SNIPPET);
    runRuntime();
    window.typerollConsent.set('all');

    const scripts = consentScripts();
    expect(scripts).toHaveLength(2);
    // None left gated:
    expect(document.querySelector('script[type="text/plain"]')).toBeNull();
    expect(document.querySelector('template[data-tr-consent="optional"]')).toBeNull();

    // Document order preserved: external loader first, inline config second.
    const [loader, config] = scripts;
    expect(loader.getAttribute('src')).toBe('https://tracker.example/lib.js?id=G-TEST');
    expect(loader.hasAttribute('async')).toBe(true);
    expect(loader.getAttribute('type')).toBeNull();
    expect(config.text).toBe('window.__trConfigRan = true;');
  });

  it('stamps out template content (noscript fallback) after consent', () => {
    document.body.innerHTML = wrapConsentScripts(SNIPPET);
    runRuntime();
    window.typerollConsent.set('all');

    const noscript = document.querySelector('noscript');
    expect(noscript).not.toBeNull();
    expect(noscript!.innerHTML).toContain('tracker.example/px');
  });

  it('does not activate on "necessary" or "rejected"', () => {
    document.body.innerHTML = wrapConsentScripts(SNIPPET);
    runRuntime();
    window.typerollConsent.set('necessary');

    expect(document.querySelectorAll('script[type="text/plain"]')).toHaveLength(2);
    expect(document.querySelector('template[data-tr-consent="optional"]')).not.toBeNull();
    expect(document.cookie).toContain('tr_consent=necessary');
  });

  it('announces consent changes for consent-aware site apps', () => {
    runRuntime();
    const choices: string[] = [];
    document.addEventListener('typeroll:consent', (event) => {
      choices.push((event as CustomEvent<{ choice: string }>).detail.choice);
    }, { once: true });
    window.typerollConsent.set('all');
    expect(choices).toEqual(['all']);
  });

  it('activates on load when a prior all-consent cookie exists', () => {
    document.cookie = 'tr_consent=all; path=/';
    document.body.innerHTML = wrapConsentScripts(SNIPPET);
    runRuntime();

    expect(document.querySelector('script[type="text/plain"]')).toBeNull();
    expect(document.querySelector('noscript')).not.toBeNull();
  });

  it('back-compat: activates a bare-JS field as one inline script', () => {
    document.body.innerHTML = wrapConsentScripts(`window.__bare = 1;`);
    runRuntime();
    window.typerollConsent.set('all');

    const scripts = consentScripts();
    expect(scripts).toHaveLength(1);
    expect(scripts[0].getAttribute('type')).toBeNull();
    expect(scripts[0].text).toBe('window.__bare = 1;');
  });
});
