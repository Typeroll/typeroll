import { afterEach, expect, it, vi } from 'vitest';
import { confirmPublicationDestination } from '../../components/confirmPublicationDestination';
afterEach(() => vi.unstubAllGlobals());
it('confirms the future host with its exact revision, or cancels without authorizing it', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({next_publication:{revision:'r7',error:'Does not update the current host.',current_host:'old.example.com',future_host:'new.example.com'}})));
  const confirm = vi.fn().mockReturnValue(true);
  vi.stubGlobal('fetch',fetch); vi.stubGlobal('confirm',confirm);
  expect(await confirmPublicationDestination('site',true,'Publish?')).toEqual({domain_candidate_revision:'r7'});
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Current: old.example.com\nFuture: new.example.com'));
  fetch.mockResolvedValue(new Response(JSON.stringify({next_publication:{revision:'r7'}}))); confirm.mockReturnValue(false);
  expect(await confirmPublicationDestination('site',true,'Publish?')).toBeNull();
});
it('preserves ordinary confirmation when no domain change applies', async () => {
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({next_publication:null}))));
  const confirm=vi.fn().mockReturnValue(true); vi.stubGlobal('confirm',confirm);
  expect(await confirmPublicationDestination('site',true,'Publish this Version?')).toEqual({});
  expect(confirm).toHaveBeenCalledWith('Publish this Version?');
});
it('fails closed when the destination cannot be checked', async () => {
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({error:'Unavailable'}),{status:503})));
  const confirm=vi.fn(); vi.stubGlobal('confirm',confirm);
  await expect(confirmPublicationDestination('site',true,'Publish?')).rejects.toThrow('Unavailable');
  expect(confirm).not.toHaveBeenCalled();
});
