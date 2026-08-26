import { describe, it, expect } from 'vitest';
import { FORM_BLOCK_TYPES } from '../form-blocks.js';
import { buildCoreBlockRegistry } from '../core-blocks.js';
import { renderBlock } from '../render-blocks.js';

const registry = buildCoreBlockRegistry();

describe('form/* block family — structural invariants', () => {
  it('all 16 blocks are registered in the core registry', () => {
    expect(FORM_BLOCK_TYPES.length).toBe(16);
    for (const bt of FORM_BLOCK_TYPES) {
      expect(registry.get(bt.id), bt.id).toBeDefined();
      expect(bt.id.startsWith('form/'), bt.id).toBe(true);
      expect(bt.origin).toBe('core');
    }
  });

  it('every input block carries an error slot wired to the field name', () => {
    const inputs = FORM_BLOCK_TYPES.filter((b) =>
      b.schema.some((f) => f.name === 'name'),
    ).filter((b) => b.id !== 'form/hidden');
    for (const bt of inputs) {
      expect(bt.template, bt.id).toContain('data-error-for="{{name}}"');
    }
  });

  it('no form block uses the bare required attribute (conditional-attr trap)', () => {
    for (const bt of FORM_BLOCK_TYPES) {
      // ` required` as a bare attribute would force required="false" to
      // still validate as required — the family uses data-required.
      expect(bt.template, bt.id).not.toMatch(/<(input|textarea|select)[^>]* required[ />]/);
    }
  });
});

describe('form/* rendering', () => {
  it('form/text renders a labelled input with wire name', () => {
    const html = renderBlock(
      {
        id: 'f1', type: 'form/text',
        data: { name: 'company', label: 'Företag', placeholder: 'AB Exempel', required: true },
      },
      { registry },
    );
    expect(html).toContain('name="company"');
    expect(html).toContain('id="ff-company"');
    expect(html).toContain('<label for="ff-company">Företag</label>');
    expect(html).toContain('data-required="true"');
  });

  it('form/select derives escaped <option> rows from choices', () => {
    const html = renderBlock(
      {
        id: 'f2', type: 'form/select',
        data: {
          name: 'storlek', label: 'Lagstorlek',
          choices: [
            { value: 'sm', label: 'Upp till 10' },
            { value: 'lg', label: '"Stort" <lag>' },
          ],
        },
      },
      { registry },
    );
    expect(html).toContain('<option value="sm">Upp till 10</option>');
    expect(html).toContain('&quot;Stort&quot; &lt;lag&gt;');
    expect(html).not.toContain('<lag>');
  });

  it('form/radio_group derives radio rows carrying the group name', () => {
    const html = renderBlock(
      {
        id: 'f3', type: 'form/radio_group',
        data: { name: 'roll', label: 'Roll', choices: [{ value: 'coach', label: 'Tränare' }] },
      },
      { registry },
    );
    expect(html).toContain('type="radio"');
    expect(html).toContain('name="roll"');
    expect(html).toContain('<span>Tränare</span>');
  });

  it('form blocks compose inside ordinary layout containers', () => {
    const html = renderBlock(
      {
        id: 'g1', type: 'core/grid', data: { cols: 2, gap: 'md' },
        children: [
          { id: 'a', type: 'form/text', data: { name: 'fornamn', label: 'Förnamn' } },
          { id: 'b', type: 'form/text', data: { name: 'efternamn', label: 'Efternamn' } },
        ],
      } as never,
      { registry },
    );
    expect(html).toContain('name="fornamn"');
    expect(html).toContain('name="efternamn"');
  });

  it('form/hidden renders a hidden input only', () => {
    const html = renderBlock(
      { id: 'h1', type: 'form/hidden', data: { name: 'campaign', value: 'spring<>' } },
      { registry },
    );
    expect(html).toContain('type="hidden"');
    expect(html).toContain('value="spring&lt;&gt;"');
  });
});
