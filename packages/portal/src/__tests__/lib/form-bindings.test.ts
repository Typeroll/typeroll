import { describe, expect, it } from 'vitest';
import { assertDeployableFormBindings } from '../../lib/deploy/form-bindings';

describe('Extension form bindings', () => {
  const snapshot = (token: string | null = 'signed') => ({
    runtime_version: '0.38.0', protocol_version: 3, installations: [{
      installation_id: 'install-one', extension_id: 'com.example.quote', version: '1.0.0',
      public_config: {}, components: [{
        id: 'calculator', label: 'Calculator', render_mode: 'bundled_component' as const,
        block_type_id: 'extension--install-one--calculator',
        entry: { script_url: 'https://provider.example/index.js', script_sha256: 'a'.repeat(64) },
        resolved_form_bindings: {
          lead: {
            id: 'lead', form_id: 'quote-leads',
            submit_url: 'https://forms.typeroll.com/api/forms/submit',
            submit_token: token, pow_bits: 15,
          },
        },
      }],
    }],
  });

  it('fails a deploy when a bound form is missing or signing is unavailable', async () => {
    await expect(assertDeployableFormBindings(snapshot(), async () => false))
      .rejects.toThrow('binds missing form "quote-leads"');
    await expect(assertDeployableFormBindings(snapshot(null), async () => true))
      .rejects.toThrow('FORMS_HMAC_SECRET');
    await expect(assertDeployableFormBindings(snapshot(), async (id) => id === 'quote-leads'))
      .resolves.toHaveLength(1);
  });

  it('keeps the absolute Forms endpoint in the static snapshot', async () => {
    const [binding] = await assertDeployableFormBindings(snapshot(), async () => true);
    expect(binding.submit_url).toBe('https://forms.typeroll.com/api/forms/submit');
  });

  it('rejects a relative or insecure Forms endpoint before upload', async () => {
    const relative = snapshot();
    relative.installations[0]!.components[0]!.resolved_form_bindings!.lead!.submit_url = '/api/forms/submit';
    await expect(assertDeployableFormBindings(relative, async () => true))
      .rejects.toThrow('must provide an absolute Forms endpoint');

    const insecure = snapshot();
    insecure.installations[0]!.components[0]!.resolved_form_bindings!.lead!.submit_url = 'http://forms.example/api/forms/submit';
    await expect(assertDeployableFormBindings(insecure, async () => true))
      .rejects.toThrow('must use HTTPS');
  });
});
