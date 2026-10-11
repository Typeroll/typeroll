import { describe, expect, it, vi } from 'vitest';
import { extensionTools } from '../src/tools/extensions.js';

describe('Extension installation MCP tools', () => {
  it('lists and reads installations through the bearer API', async () => {
    const get = vi.fn().mockResolvedValue({ extensions: [] });
    const client = { get } as never;
    const list = extensionTools.find((tool) => tool.name === 'list_extension_installations')!;
    const read = extensionTools.find((tool) => tool.name === 'read_extension_installation')!;

    await list.handler({}, { client, siteId: 'site-a' });
    expect(get).toHaveBeenCalledWith('site-a', 'extensions', { version: undefined });

    await read.handler({ installation_id: 'install/a' }, { client, siteId: 'site-a' });
    expect(get).toHaveBeenCalledWith('site-a', 'extensions/install%2Fa', { version: undefined });
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
      { version: undefined },
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


it('explicit release activation only patches the selected installation and never deploys', async () => {
  const tool = extensionTools.find(tool => tool.name === 'activate_extension_release')!;
  const client = { patch: vi.fn().mockResolvedValue({ installation: { version: '2.0.0' } }), post: vi.fn() };
  await tool.handler({ installation_id: 'install/a', version: '2.0.0', config: { endpoint: 'new' } }, { client, siteId: 'one' } as any);
  expect(client.patch).toHaveBeenCalledWith('one', 'extensions/install%2Fa', { version: '2.0.0', config: { endpoint: 'new' } });
  expect(client.post).not.toHaveBeenCalled();
});


it('keeps branch configuration reads, writes and publication on that branch', async () => {
  const client = { get: vi.fn().mockResolvedValue({}), patch: vi.fn().mockResolvedValue({}), post: vi.fn().mockResolvedValue({}) };
  const ctx = { client, siteId: 'site-a' } as any;
  await extensionTools.find(t => t.name === 'list_extension_installations')!.handler({ version: 'redesign' }, ctx);
  await extensionTools.find(t => t.name === 'read_extension_installation')!.handler({ installation_id: 'inst', version: 'redesign' }, ctx);
  await extensionTools.find(t => t.name === 'update_extension_installation_config')!.handler({ installation_id: 'inst', version: 'redesign', config: { heading: 'Test' } }, ctx);
  expect(client.get).toHaveBeenCalledWith('site-a', 'extensions', { version: 'redesign' });
  expect(client.get).toHaveBeenCalledWith('site-a', 'extensions/inst', { version: 'redesign' });
  expect(client.patch).toHaveBeenCalledWith('site-a', 'extensions/inst', { config: { heading: 'Test' } }, { version: 'redesign' });
  expect(client.post).toHaveBeenCalledExactlyOnceWith('site-a', 'deploy', { environment: 'staging', version: 'redesign' });
});
