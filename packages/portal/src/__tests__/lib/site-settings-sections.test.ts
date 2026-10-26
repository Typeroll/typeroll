import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSiteSettings, paths, type SiteSettings } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { POST } from '../../pages/api/sites/[siteId]/settings';

beforeEach(async () => {
  makeTmpFixtures();
  await resetDatastore();
  await getStore().setDoc(paths.site('default', 'settings-test'), { name: 'Settings test', staging_url: 'https://preview.example.test' });
  await getStore().setDoc(paths.version('default', 'settings-test', 'main'), { name: 'Main', kind: 'main', robots_blocked: false });
  await getStore().setDoc(paths.settings('default', 'settings-test', 'main'), {
    ...defaultSiteSettings, site_name: 'Original', tagline: 'Keep this', sitewide_noindex: true,
    cookie_consent: { enabled: true, text: 'Consent', scripts_optional: '<script>consent()</script>' },
    scripts_head: '<script>head()</script>', agent_instructions: 'Keep these instructions',
    organization: { name: 'Organization' }, seo_review: { notes: ['Keep the editorial rule'] },
  });
});
async function post(values: Record<string, string>) {
  const body = new FormData();
  for (const [key, value] of Object.entries(values)) body.set(key, value);
  return POST({ request: new Request('http://localhost/api/sites/settings-test/settings', { method: 'POST', headers: { accept: 'application/json' }, body }),
    cookies: { get: () => undefined, set: () => {}, delete: () => {}, has: () => false }, params: { siteId: 'settings-test' }, locals: {},
    redirect: (url: string) => new Response(null, { status: 303, headers: { location: url } }),
  } as never);
}
const read = () => getStore().getDoc<SiteSettings>(paths.settings('default', 'settings-test', 'main'));
describe('independent Site settings sections', () => {
  it('saves identity without clearing SEO, consent, scripts or AI instructions', async () => {
    const before = await read();
    expect((await post({ settings_section: 'general', site_name: 'Changed', tagline: 'Keep this' })).status).toBe(200);
    expect(await read()).toEqual({ ...before, site_name: 'Changed' });
  });
  it('ignores out-of-section fields and cannot change the domain through this form', async () => {
    const before = await read();
    await post({ settings_section: 'access', agent_instructions: 'Updated instructions', sitewide_noindex: '', scripts_head: 'replace', staging_url: 'https://wrong.test', domain: 'wrong.test' });
    expect(await read()).toEqual({ ...before, agent_instructions: 'Updated instructions' });
    expect(await getStore().getDoc(paths.site('default', 'settings-test'))).toMatchObject({ staging_url: 'https://preview.example.test' });
    expect(await getStore().getDoc(paths.site('default', 'settings-test'))).not.toHaveProperty('domain');
  });
  it('clears an unchecked consent toggle only in Integrations', async () => {
    const before = await read();
    await post({ settings_section: 'integrations' });
    const { cookie_consent: _removed, ...rest } = before!;
    expect(await read()).toEqual(rest);
  });
  it('saves the preview address without rewriting versioned settings', async () => {
    const before = await read();
    await post({ settings_section: 'publishing', staging_url: 'https://other.example.test/' });
    expect(await read()).toEqual(before);
    expect(await getStore().getDoc(paths.site('default', 'settings-test'))).toMatchObject({ staging_url: 'https://other.example.test' });
  });
  it('preserves a concurrent save to another section', async () => {
    const store = getStore(), compare = store.compareAndReplaceDoc.bind(store);
    const spy = vi.spyOn(store, 'compareAndReplaceDoc').mockImplementationOnce(async (path, expected, data) => {
      await store.updateDoc(path, { sitewide_noindex: false });
      return compare(path, expected, data);
    });
    try {
      expect((await post({ settings_section: 'general', site_name: 'Changed', tagline: 'Keep this' })).status).toBe(200);
      expect(await read()).toMatchObject({ site_name: 'Changed', sitewide_noindex: false });
      expect(spy).toHaveBeenCalledTimes(2);
    } finally { spy.mockRestore(); }
  });
  it('saves design tokens and fonts without changing other sections', async () => {
    const before = await read();
    expect((await post({ settings_section: 'design', 'colors.surface_hover': '#eeeeee', 'fonts.mono': 'Roboto Mono', 'design_scales.type_size.xs': '0.8rem' })).status).toBe(200);
    const after = await read();
    expect(after).toMatchObject({ design_scales: { type_size: { xs: '0.8rem' } }, colors: { surface_hover: '#eeeeee' }, fonts: { mono: 'Roboto Mono' }, agent_instructions: before!.agent_instructions, sitewide_noindex: true });
    expect((await post({ settings_section: 'general', site_name: 'Renamed' })).status).toBe(200);
    expect(await read()).toMatchObject({ design_scales: after!.design_scales, colors: after!.colors, fonts: after!.fonts });
  });
  it('rejects an invalid scope before writing anything', async () => {
    const before = await read();
    expect((await post({ settings_section: 'invalid', site_name: 'Lost' })).status).toBe(400);
    expect(await read()).toEqual(before);
  });
});

it('round-trips responsive scales and typography without changing another section', async () => {
  const result=await post({settings_section:'design','design_scales.type_size.xs':'','design_scales.type_size.3xl':'clamp(2rem, 1rem + 2vw, 3rem)','design_scales.space.lg':'{"mobile":"1rem","desktop":"2rem"}','typography.ratio_mobile':'1.2','typography.ratio_desktop':'1.25','typography.rhythm':'1.2','typography.line_length':'68'});
  expect(result.status).toBe(200);
  expect(await read()).toMatchObject({site_name:'Original',typography:{rhythm:1.2,line_length:68},design_scales:{space:{lg:{mobile:'1rem',desktop:'2rem'}}}});
});
it('rejects malformed responsive JSON before saving',async()=>{
  const before=await read();
  expect((await post({settings_section:'design','design_scales.type_size.xs':'{broken'})).status).toBe(400);
  expect(await read()).toEqual(before);
});
