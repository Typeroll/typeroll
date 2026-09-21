// M26: a Site holding a public, browser-exposed third-party client key that a
// native block can read, without an Extension installation.
//
// The acceptance points these pin: one provider script per page however many
// blocks want it; nothing at all when the key is absent or malformed; nothing
// on pages whose blocks did not ask; and identical markup either way, which is
// what lets the editor canvas and the preview shell — neither of which can run
// a provider script — show the honest fallback rather than a dead field.

import { describe, it, expect } from 'vitest';
import { renderClientCapabilityScripts, integrationConfigKey, INTEGRATION_PROVIDERS } from '../integrations.js';
import { collectClientCapabilities } from '../render-blocks.js';
import { navigationForm, prepareNavigationForm } from '../navigation-form.js';
import type { Block } from '../types.js';

const KEY = 'AIza' + 'b'.repeat(35);
const configured = { [integrationConfigKey('google_places', 'browser_key')]: KEY };

const banner = (id: string, suggest: boolean): Block => ({
  id,
  type: 'core/navigation_form',
  data: {
    destination: '/offert/',
    fields: [
      { name: 'address_from', label: 'From', kind: 'text', suggest_address: suggest },
      { name: 'rooms', label: 'Rooms', kind: 'number' },
    ],
  },
});

describe('collectClientCapabilities', () => {
  it('asks for nothing when no field opted in', () => {
    expect([...collectClientCapabilities([banner('a', false)])]).toEqual([]);
  });

  it('asks once when a field opted in', () => {
    expect([...collectClientCapabilities([banner('a', true)])]).toEqual(['address_autocomplete']);
  });

  it('still asks once for a header and a footer banner — one script per page', () => {
    expect([...collectClientCapabilities([banner('header', true), banner('footer', true)])])
      .toEqual(['address_autocomplete']);
  });

  it('finds blocks nested in children and slots', () => {
    const nested: Block = { id: 'section', type: 'core/section', children: [banner('inner', true)], data: {} };
    expect([...collectClientCapabilities([nested])]).toEqual(['address_autocomplete']);
    const slotted: Block = { id: 'cols', type: 'core/columns', slots: [[banner('slotted', true)]], data: {} };
    expect([...collectClientCapabilities([slotted])]).toEqual(['address_autocomplete']);
  });
});

describe('renderClientCapabilityScripts', () => {
  it('emits one consent-categorised loader carrying the key', () => {
    const out = renderClientCapabilityScripts(configured, ['address_autocomplete']);
    expect(out.emitted).toEqual(['address_autocomplete']);
    // functional, not necessary — so it routes through the site's consent gate.
    expect(out.tags).toBe('');
    expect(out.consentTags).toContain(KEY);
    expect(out.consentTags).toContain('maps.googleapis.com/maps/api/js');
  });

  it('emits exactly one script tag even though two blocks asked', () => {
    const out = renderClientCapabilityScripts(configured, ['address_autocomplete', 'address_autocomplete']);
    expect(out.consentTags.match(/<script>/g)).toHaveLength(1);
  });

  it('emits nothing when the key is absent — the no-key fallback', () => {
    const out = renderClientCapabilityScripts({}, ['address_autocomplete']);
    expect(out).toEqual({ tags: '', consentTags: '', emitted: [] });
  });

  it('emits nothing for a key that fails its pattern, rather than a half-built script', () => {
    const out = renderClientCapabilityScripts(
      { [integrationConfigKey('google_places', 'browser_key')]: 'not-a-key' },
      ['address_autocomplete'],
    );
    expect(out.emitted).toEqual([]);
    expect(out.consentTags).toBe('');
  });

  it('emits nothing on a page whose blocks asked for nothing, even with a key configured', () => {
    expect(renderClientCapabilityScripts(configured, []).emitted).toEqual([]);
  });

  it('never closes the script element it is injected into', () => {
    const out = renderClientCapabilityScripts(configured, ['address_autocomplete']);
    expect(out.consentTags.slice(0, -'</script>'.length)).not.toContain('</script');
  });

  it('keeps the provider off every other page — no site-wide tag', () => {
    const places = INTEGRATION_PROVIDERS.find((p) => p.id === 'google_places');
    expect(places?.snippet({ browser_key: KEY })).toBe('');
  });
});

describe('navigation_form markup', () => {
  const render = (suggest: boolean, country?: string) => {
    const data: Record<string, unknown> = {
      destination: '/offert/',
      address_country: country,
      fields: [{ name: 'address_from', label: 'From', kind: 'text', suggest_address: suggest }],
    };
    prepareNavigationForm(data, 'b1', data);
    return data;
  };

  it('marks an opted-in field for the capability', () => {
    expect(String(render(true).navigation_fields_html)).toContain('data-navigation-suggest="address"');
  });

  it('leaves a field that did not opt in completely alone', () => {
    expect(String(render(false).navigation_fields_html)).not.toContain('data-navigation-suggest');
  });

  it('produces the same field markup whether or not a key exists anywhere', () => {
    // The block never sees the key, so there is nothing for it to vary on.
    // This is what makes preview, editor canvas and published output agree.
    expect(render(true).navigation_fields_html).toBe(render(true).navigation_fields_html);
  });

  it('normalises the country restriction and drops nonsense', () => {
    expect(render(true, 'SE').address_country).toBe('se');
    expect(render(true, 'sweden').address_country).toBe('');
    expect(render(true).address_country).toBe('');
  });

  it('offers the capability opt-in and the country restriction in the schema', () => {
    const fields = navigationForm.schema.find((f) => f.name === 'fields') as { fields: Array<{ name: string }> };
    expect(fields.fields.map((f) => f.name)).toContain('suggest_address');
    expect(navigationForm.schema.map((f) => f.name)).toContain('address_country');
  });

  it('carries structured parts and the capability registry in the runtime', () => {
    expect(navigationForm.script).toContain('TyperollClientCapabilities');
    expect(navigationForm.script).toContain('address_autocomplete');
    // Structured components, not only the display string.
    expect(navigationForm.script).toContain('postal_code');
  });
});

describe('provider API generation', () => {
  // google.maps.places.Autocomplete is unavailable to Google accounts created
  // on or after 2025-03-01. Building only on it would ship a capability that
  // loads, validates and produces nothing for exactly the new customers this
  // request was written to serve — silently, with only a deprecation warning.
  const loader = () => renderClientCapabilityScripts(configured, ['address_autocomplete']).consentTags;

  it('prefers PlaceAutocompleteElement', () => {
    expect(loader()).toContain('PlaceAutocompleteElement');
  });

  it('keeps legacy Autocomplete only as a fallback for existing projects', () => {
    const script = loader();
    expect(script).toContain('places.Autocomplete');
    // Modern is tried first; legacy is only reached when it returns false.
    expect(script.indexOf('PlaceAutocompleteElement')).toBeLessThan(script.indexOf('function legacy'));
  });

  it('registers nothing when the provider offers neither, which is the no-key fallback', () => {
    const script = loader();
    expect(script).toContain("typeof Element!=='function'");
    expect(script).toContain("typeof W.google.maps.places.Autocomplete!=='function'");
  });

  it('keeps the block field as the value carrier so the handoff is unchanged', () => {
    expect(loader()).toContain("input.style.display='none'");
    expect(loader()).toContain('input.value=parts.formatted');
  });
});
