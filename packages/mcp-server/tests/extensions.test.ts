import { describe, expect, it, vi } from 'vitest';
import { extensionTools } from '../src/tools/extensions.js';

describe('Extension installation MCP tools', () => {
  it('lists and reads installations through the bearer API', async () => {
    const get = vi.fn().mockResolvedValue({ extensions: [] });
    const client = { get } as never;
    const list = extensionTools.find((tool) => tool.name === 'list_extension_installations')!;
    const read = extensionTools.find((tool) => tool.name === 'read_extension_installation')!;

    await list.handler({}, { client, siteId: 'site-a' });
    expect(get).toHaveBeenCalledWith('site-a', 'extensions');

    await read.handler({ installation_id: 'install/a' }, { client, siteId: 'site-a' });
    expect(get).toHaveBeenCalledWith('site-a', 'extensions/install%2Fa');
  });

  it('patches schema-defined installation config and deploys by default', async () => {
    const patch = vi.fn().mockResolvedValue({
      installation: {}, config: {}, affects_build: true, redeploy_required: true,
    });
    const post = vi.fn().mockResolvedValue({ job_id: 'deploy-1' });
    const client = { patch, post } as never;
    const update = extensionTools.find((tool) => tool.name === 'update_extension_installation_config')!;
    const config = {
      consent_text: 'Jag samtycker till att {subject} behandlar mina uppgifter.',
      policy_link_text: 'integritetspolicyn',
      policy_url: '/anvandarvillkor/',
    };

    const result = await update.handler(
      { installation_id: 'install/a', config },
      { client, siteId: 'site-a' },
    );

    expect(patch).toHaveBeenCalledWith(
      'site-a',
      'extensions/install%2Fa',
      { config },
    );
    expect(post).toHaveBeenCalledWith('site-a', 'deploy', { environment: 'production' });
    expect(result.content[0].text).toContain('"redeploy_required": true');
    expect(result.content[0].text).toContain('"job_id": "deploy-1"');
  });

  it('can update config without deploying when requested', async () => {
    const patch = vi.fn().mockResolvedValue({ redeploy_required: true });
    const post = vi.fn();
    const client = { patch, post } as never;
    const update = extensionTools.find((tool) => tool.name === 'update_extension_installation_config')!;

    await update.handler(
      { installation_id: 'install/a', config: { heading: 'Preview' }, deploy: false },
      { client, siteId: 'site-a' },
    );

    expect(patch).toHaveBeenCalledOnce();
    expect(post).not.toHaveBeenCalled();
  });
});
