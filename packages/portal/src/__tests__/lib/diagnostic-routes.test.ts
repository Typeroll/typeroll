import { describe, expect, it } from 'vitest';
import { GET as health } from '../../pages/api/healthz';
import { GET as version } from '../../pages/api/version';

describe('public diagnostic routes', () => {
  it('exposes a cache-free liveness response without touching dependencies', async () => {
    const response = await health({} as never);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('exposes the public release contract without secrets', async () => {
    const response = await version({} as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.core_version).toBeTruthy();
    expect(body.data_schema_version).toBeTypeOf('number');
    expect(body.template_capabilities_version).toBeTruthy();
    expect(body.mcp_version).toBeTruthy();
    expect(body).not.toHaveProperty('firebase_service_account');
  });
});
