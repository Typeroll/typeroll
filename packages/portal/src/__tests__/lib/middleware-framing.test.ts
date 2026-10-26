import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('astro:middleware', () => ({ defineMiddleware: (handler: unknown) => handler }));
vi.mock('../../lib/load-env', () => ({}));
vi.mock('../../lib/data-schema', () => ({ requireCurrentDataSchema: vi.fn() }));
vi.mock('../../lib/auth', () => ({
  getSessionIdentity: vi.fn(async () => null),
  sessionNeedsRefresh: vi.fn(() => false),
  refreshSessionForUser: vi.fn(),
}));
import { onRequest } from '../../middleware';

beforeEach(() => { vi.stubEnv('DEPLOY_QUEUE', 'cloud_tasks'); vi.stubEnv('SERVICE_ROLE', 'portal'); });

async function respond(pathname: string, response: Response): Promise<Response> {
  const url = new URL(pathname, 'https://cms.example.test');
  const context = { url, request: new Request(url), cookies: { get: () => undefined }, locals: {}, redirect: () => new Response(null, { status: 302 }) };
  return await onRequest(context as never, (async () => response) as never) as Response;
}

const html = (headers: Record<string, string> = {}) => new Response('<!doctype html><p>x</p>', { headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });

describe('portal anti-framing headers', () => {
  it('denies framing of portal pages', async () => {
    for (const pathname of ['/app', '/app/sites/s1/pages/p1', '/login', '/onboarding', '/verify-email']) {
      const response = await respond(pathname, html());
      expect(response.headers.get('content-security-policy'), pathname).toBe("frame-ancestors 'none'");
      expect(response.headers.get('x-frame-options'), pathname).toBe('DENY');
    }
  });

  it('keeps portal-framed previews frameable by the portal only, beside their sandbox policy', async () => {
    for (const pathname of [
      '/api/sites/s1/preview/browse/about',
      '/api/sites/s1/preview/p1',
      '/api/sites/s1/pages/p1/revisions/r1/preview',
      '/preview/s1/about',
    ]) {
      const response = await respond(pathname, html({ 'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups' }));
      expect(response.headers.get('content-security-policy'), pathname)
        .toBe("sandbox allow-scripts allow-forms allow-popups, frame-ancestors 'self'");
      expect(response.headers.get('x-frame-options'), pathname).toBe('SAMEORIGIN');
    }
  });

  it('leaves an explicit framing policy, non-HTML responses and customer-site endpoints alone', async () => {
    const consent = await respond('/mcp/consent', html({ 'Content-Security-Policy': "frame-ancestors 'none'" }));
    expect(consent.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(consent.headers.get('x-frame-options')).toBe('DENY');

    const json = await respond('/api/sites/s1', new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
    expect(json.headers.get('x-frame-options')).toBeNull();
    expect(json.headers.get('content-security-policy')).toBeNull();

    for (const pathname of ['/api/forms/submit', '/api/extensions/runtime/frame']) {
      const response = await respond(pathname, html());
      expect(response.headers.get('x-frame-options'), pathname).toBeNull();
      expect(response.headers.get('content-security-policy'), pathname).toBeNull();
    }
  });

  it('handles responses with immutable headers', async () => {
    const immutable = html();
    Object.defineProperty(immutable, 'headers', { value: new Proxy(immutable.headers, {
      get(target, key) {
        if (key === 'set' || key === 'append') return () => { throw new TypeError('immutable'); };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) });
    const response = await respond('/app', immutable);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });
});
