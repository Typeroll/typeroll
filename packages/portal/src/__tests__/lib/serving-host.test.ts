import { describe, expect, it } from 'vitest';
import { observeRedirectHost, observeWebsiteHost, otherHostRemedy, providerHint, servingIssue } from '../../lib/publishing/serving-host';

const expected = 'a'.repeat(64);
const marker = '/.well-known/typeroll/publication.json';

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;
const fake = (route: Route) => (async (input: string | URL | Request, init?: RequestInit) =>
  route(new URL(input instanceof Request ? input.url : String(input)), init)) as typeof fetch;

const typeroll = (id: string) => fake(url => url.pathname === marker
  ? Response.json({ id, paths: ['/'] }, { headers: { 'x-typeroll-publication': id } })
  : new Response(null, { status: 200, headers: { 'x-typeroll-publication': id } }));

// The CH-06 response: the apex is answered by Kinsta's Cloudflare for SaaS hostname.
const kinsta = fake(url => new Response(url.pathname === marker ? '<!doctype html><title>Page not found</title>' : null, {
  status: url.pathname === marker ? 404 : 200,
  headers: { 'x-kinsta-cache': 'HIT', link: '<https://moveria.ch/wp-json/>; rel="https://api.w.org/"', server: 'cloudflare' },
}));

describe('website host observation', () => {
  it('accepts the expected Typeroll publication', async () => {
    expect(await observeWebsiteHost('moveria.ch', expected, typeroll(expected))).toMatchObject({ status: 'serving', publication: expected, provider_hint: null });
  });

  it('names Kinsta and gives the Cloudflare for SaaS remedy', async () => {
    const observation = await observeWebsiteHost('moveria.ch', expected, kinsta);
    expect(observation).toMatchObject({ status: 'other_host', publication: null, http_status: 200,
      provider_hint: { provider: 'kinsta', name: 'Kinsta', evidence: 'x-kinsta-cache: HIT', cloudflare_for_saas: true } });
    const issue = servingIssue(observation, expected)!;
    expect(issue.code).toBe('domain_served_by_other_host');
    expect(issue.message).toContain('moveria.ch is not served by Typeroll');
    expect(issue.remedy).toBe("Remove the domain from the previous host's dashboard (for example MyKinsta → Domains); its Cloudflare for SaaS hostname outranks your own DNS.");
  });

  it('reports a different Typeroll publication', async () => {
    const observation = await observeWebsiteHost('moveria.ch', expected, typeroll('b'.repeat(64)));
    expect(observation).toMatchObject({ status: 'other_publication', publication: 'b'.repeat(64) });
    expect(servingIssue(observation, expected)).toMatchObject({ code: 'domain_serving_other_publication' });
  });

  it('falls back to publication.json when the header is absent', async () => {
    const bodyOnly = fake(url => url.pathname === marker ? Response.json({ id: expected, paths: ['/'] }) : new Response(null, { status: 301, headers: { location: '/sv/' } }));
    expect(await observeWebsiteHost('moveria.ch', expected, bodyOnly)).toMatchObject({ status: 'serving', publication: expected });
  });

  it('treats a transport error as inconclusive, never as another host', async () => {
    const down = fake(() => { throw new TypeError('fetch failed'); });
    const observation = await observeWebsiteHost('moveria.ch', expected, down);
    expect(observation).toMatchObject({ status: 'inconclusive', http_status: null, error: 'fetch failed' });
    expect(servingIssue(observation, expected)).toBeNull();
  });

  it('does not count an edge error or a Cloudflare challenge as another host', async () => {
    const edge = fake(() => new Response('error code: 522', { status: 522, headers: { server: 'cloudflare' } }));
    expect((await observeWebsiteHost('moveria.ch', expected, edge)).status).toBe('inconclusive');
    const challenge = fake(() => new Response('Just a moment...', { status: 403, headers: { 'cf-mitigated': 'challenge' } }));
    expect((await observeWebsiteHost('moveria.ch', expected, challenge)).status).toBe('inconclusive');
  });
});

describe('redirect host observation', () => {
  it('accepts the approved 301 to the website host', async () => {
    const redirect = fake(url => new Response(null, { status: 301, headers: { location: `https://www.moveria.ch${url.pathname}${url.search}` } }));
    expect(await observeRedirectHost('moveria.ch', 'www.moveria.ch', expected, redirect)).toMatchObject({ status: 'serving', role: 'redirect' });
  });

  it('reports another host that answers instead of the redirect', async () => {
    const observation = await observeRedirectHost('moveria.ch', 'www.moveria.ch', expected, kinsta);
    expect(observation).toMatchObject({ status: 'other_host', provider_hint: { provider: 'kinsta' } });
    expect(servingIssue(observation, expected)?.message).toContain('neither redirects to the website');
  });
});

describe('provider hints', () => {
  it('keeps a small explicit table and prefers a specific host over generic WordPress', () => {
    const headers = (init: Record<string, string>) => new Headers(init);
    expect(providerHint(headers({ 'x-powered-by': 'WP Engine', link: '<https://x.test/wp-json/>; rel="https://api.w.org/"' }))).toMatchObject({ provider: 'wp_engine', cloudflare_for_saas: true });
    expect(providerHint(headers({ 'x-wix-request-id': '1' }))).toMatchObject({ provider: 'wix', cloudflare_for_saas: false });
    expect(providerHint(headers({ 'x-served-by': 'Squarespace' }))).toMatchObject({ provider: 'squarespace' });
    expect(providerHint(headers({ link: '<https://x.test/wp-json/>; rel="https://api.w.org/"' }))).toMatchObject({ provider: 'wordpress' });
    expect(providerHint(headers({ 'x-powered-by': 'PHP/8.2', server: 'cloudflare' }))).toBeNull();
    expect(otherHostRemedy(providerHint(headers({ 'x-wix-request-id': '1' })))).toBe('Remove the domain from Wix and check that its DNS records point to Typeroll.');
  });
});
