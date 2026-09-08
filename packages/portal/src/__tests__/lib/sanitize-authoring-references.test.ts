import { describe, expect, it } from 'vitest';
import { expandFormIncludes } from '@typeroll/shared';
import { sanitizeBody as portal } from '../../lib/sanitize';
import { sanitizeBody as renderer } from '../../../../site-template/src/lib/sanitize';

describe.each([['portal', portal], ['renderer', renderer]] as const)('%s authoring references', (_name, sanitize) => {
  it('expands a saved self-closing form before following content', () => {
    const input = '<section><x-form id="contact" /><p><a href="/next">Next</a></p></section>';
    const saved = sanitize(input);
    const rendered = expandFormIncludes(saved, id => id === 'contact' ? '<form><button>Send</button></form>' : undefined);
    expect(rendered).toBe('<section><form><button>Send</button></form><p><a href="/next">Next</a></p></section>');
    expect(sanitize(saved)).toBe(saved);
  });

  it.each(['x-form', 'x-include', 'x-extension'])('keeps %s separate from following markup without allowing scripts', tag => {
    const saved = sanitize(`<${tag} id="contact" name="cta" block="counter" onclick="alert(1)" /><p>After</p><script>alert(1)</script>`);
    expect(saved).toContain(`></${tag}><p>After</p>`);
    expect(saved).not.toContain('onclick');
    expect(saved).not.toContain('<script');
    expect(saved).not.toContain('alert(1)');
  });
});
