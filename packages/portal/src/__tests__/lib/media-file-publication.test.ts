import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { paths, type Media } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { connectionPath, sealCredentials } from '../../lib/publishing/connections';
import { getOrganizationDomains, organizationDomainConfigPath } from '../../lib/publishing/domain-config';
import { publishMediaFile, withMediaFileOperation } from '../../lib/media/file-publication';
import { S3Client, CopyObjectCommand } from '../../lib/net/s3';
import { safeFetch } from '../../lib/net/safe-fetch';
import { publicMediaUrl } from '../../lib/media/presentation';
import { finalizedMediaRecord } from '../../lib/media/client-upload';
import { recordPublishedMedia } from '../../lib/publishing/published-media';
vi.mock('../../lib/net/safe-fetch', () => ({ safeFetch: vi.fn() }));
const pdf = Buffer.from('%PDF-1.4\nSynthetic test PDF\n%%EOF');
const hash = createHash('sha256').update(pdf).digest('hex');
const path = `${paths.media('org', 'site')}/pdf`;
const account = 'a'.repeat(32);
const url = 'https://media.example.com/media/abcdefghij/report.pdf';
let copy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  vi.stubEnv('INTEGRATIONS_SECRET_KEY', 'synthetic-encryption-key-for-tests-only-32chars');
  await getStore().setDoc(paths.site('org','site'), { media_id: 'abcdefghij' });
  await getStore().setDoc(connectionPath('org','cloudflare'), { revision: 'connected', status: 'connected', media_ready: true,
    cloudflare: { account_id: account, bucket: 'private', public_bucket: 'public' },
    encrypted_credentials: sealCredentials('org','cloudflare', { access_key_id: 'synthetic-key', secret_access_key: 'synthetic-secret' }) });
  await getOrganizationDomains('org');
  await getStore().updateDoc(organizationDomainConfigPath('org'), { media_host:'media.example.com' });
  await getStore().setDoc(path, { filename:'report.pdf', mime_type:'application/pdf', created_at:'2026-01-01', sha256:hash, size_bytes:pdf.length,
    cdn_url:'https://portal.example/api/sites/site/media/pdf/content', storage:{ provider:'organization_r2', state:'ready', account_id:account, bucket:'private', key:'private/media/abcdefghij/originals/report.pdf', generation:'connected' } });
  copy = vi.spyOn(S3Client.prototype,'send').mockResolvedValue({});
  vi.mocked(safeFetch).mockImplementation(async () => new Response(pdf, {headers:{'Content-Type':'application/pdf'}}));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it('copies a private PDF in R2, verifies anonymous bytes and never needs a build', async () => {
  expect(publicMediaUrl((await getStore().getDoc<Media>(path))!)).toBeNull();
  const result = await publishMediaFile('org','site','pdf');
  expect(result).toMatchObject({ state:'public', public_url:url, website_build_required:false });
  const command = copy.mock.calls[0][0] as CopyObjectCommand;
  expect(command).toBeInstanceOf(CopyObjectCommand);
  expect(command.input).toMatchObject({ Bucket:'public', CopySource:'private/private/media/abcdefghij/originals/report.pdf', ContentType:'application/pdf', ContentDisposition:'inline' });
  expect(vi.mocked(safeFetch).mock.calls[0][1]).toEqual({ redirect:'error', headers:{'Cache-Control':'no-cache'} });
  const saved = (await getStore().getDoc<Media>(path))!;
  expect(saved.source_aliases).toContain(url);
  expect(saved.cdn_url).toContain('/api/sites/');
  expect(publicMediaUrl(saved)).toBe(url);
  expect(saved.file_operation).toBeNull();
  expect(await getStore().listDocs(paths.deploys('org','site'))).toEqual([]);
});
it('preserves the public link across retries, renamed display filenames and unrelated site builds', async () => {
  await publishMediaFile('org','site','pdf');
  await getStore().updateDoc(path,{filename:'renamed.pdf', published_url:'https://website.example/report.pdf'});
  expect((await publishMediaFile('org','site','pdf')).public_url).toBe(url);
  await recordPublishedMedia('org','site',[],{main:true});
  expect(publicMediaUrl((await getStore().getDoc<Media>(path))!)).toBe(url);
});
it.each([
  ['upload not ready', {storage:{state:'uploading'}}],
  ['image', {mime_type:'image/png'}],
  ['wrong storage', {storage:{provider:'draft_r2',state:'ready'}}],
  ['replaced file', {replacement_media_id:'other'}],
])('refuses %s without making a copy',async (_name, update) => {
  await getStore().updateDoc(path,update);
  await expect(publishMediaFile('org','site','pdf')).rejects.toThrow();
  expect(copy).not.toHaveBeenCalled();
});
it('requires the organization media domain and never invents one',async () => {
  await getStore().updateDoc(organizationDomainConfigPath('org'),{media_host:null});
  await expect(publishMediaFile('org','site','pdf')).rejects.toMatchObject({code:'media_domain_required'});
  expect(copy).not.toHaveBeenCalled();
});
it.each(['wrong bytes','html','404','network'])('does not expose an unverified link after %s, preserves cleanup identity and allows retry',async kind => {
  vi.mocked(safeFetch).mockImplementation(async () => {
    if(kind==='network')throw Error('offline');
    return new Response(kind==='wrong bytes' ? 'wrong' : pdf,{status:kind==='404'?404:200,headers:{'Content-Type':kind==='html'?'text/html':'application/pdf'}});
  });
  await expect(publishMediaFile('org','site','pdf')).rejects.toMatchObject({code:'media_file_verification_pending'});
  const media=(await getStore().getDoc<Media>(path))!;
  expect(media.file_publication?.state).toBe('pending'); expect(media.source_aliases).toContain(url); expect(publicMediaUrl(media)).toBeNull();
  vi.mocked(safeFetch).mockImplementation(async()=>new Response(pdf,{headers:{'Content-Type':'application/pdf'}}));
  expect((await publishMediaFile('org','site','pdf')).public_url).toBe(url);
});
it('excludes simultaneous publication and deletion and releases the operation after failure',async () => {
  await withMediaFileOperation('org','site','pdf',async()=> {
    await expect(publishMediaFile('org','site','pdf')).rejects.toMatchObject({code:'media_file_busy'});
    const { deleteMediaItem }=await import('../../lib/media-deletion');
    await expect(deleteMediaItem('org','site','pdf')).rejects.toMatchObject({code:'media_file_busy'});
  });
  copy.mockRejectedValueOnce(Error('storage unavailable'));
  await expect(publishMediaFile('org','site','pdf')).rejects.toMatchObject({code:'media_file_copy_failed'});
  expect((await publishMediaFile('org','site','pdf')).state).toBe('public');
});
it('cannot access another site or organization',async()=> {
  await expect(publishMediaFile('other','site','pdf')).rejects.toMatchObject({status:404});
  await expect(publishMediaFile('org','other','pdf')).rejects.toMatchObject({status:404});
  expect(copy).not.toHaveBeenCalled();
});
it('uses the real finalized upload id rather than an optimistic local id',async()=> {
  const read=vi.fn(async()=>Response.json({id:'real',storage:{state:'ready'}}));
  expect(await finalizedMediaRecord('site',{mediaId:'real'},read)).toMatchObject({id:'real'});
  expect(read).toHaveBeenCalledWith('/api/sites/site/media/real');
  await expect(finalizedMediaRecord('site',{mediaId:'real'},async()=>Response.json({id:'real',storage:{state:'uploading'}}))).rejects.toThrow('not complete');
  await expect(finalizedMediaRecord('site',{},read)).rejects.toThrow('media id');
});
it('never offers an authenticated content URL as a public link',()=> {
  for(const candidate of ['https://portal.example/api/sites/site/media/id/content','javascript:alert(1)']) {
    expect(publicMediaUrl({cdn_url:candidate,published_url:candidate} as Media)).toBeNull();
  }
});

it('keeps an already verified legacy hash PDF address instead of creating a new link', async () => {
  const key = `media/abcdefghij/${hash.slice(0,16)}-report.pdf`, legacy = `https://media.example.com/${key}`;
  await getStore().updateDoc(path, { file_publication: { state: 'public', key, url: legacy, sha256: hash, verified_at: '2026-11-01T00:00:00Z' } });
  expect((await publishMediaFile('org','site','pdf')).public_url).toBe(legacy);
  expect((copy.mock.calls[0][0] as CopyObjectCommand).input.Key).toBe(key);
});
it('encodes a Unicode public URL while storing the actual Unicode object key', async () => {
  await getStore().updateDoc(path, { filename: 'Höstlöv.pdf' });
  expect((await publishMediaFile('org','site','pdf')).public_url).toBe('https://media.example.com/media/abcdefghij/H%C3%B6stl%C3%B6v.pdf');
  expect((copy.mock.calls[0][0] as CopyObjectCommand).input.Key).toBe('media/abcdefghij/Höstlöv.pdf');
  expect((await publishMediaFile('org','site','pdf')).public_url).toBe('https://media.example.com/media/abcdefghij/H%C3%B6stl%C3%B6v.pdf');
});

it('applies an explicitly changed PDF public path and can return to the root', async () => {
  await publishMediaFile('org','site','pdf');
  await getStore().updateDoc(path, { public_path: '/documents/report.pdf' });
  expect((await publishMediaFile('org','site','pdf')).public_url).toBe('https://media.example.com/media/abcdefghij/documents/report.pdf');
  await getStore().updateDoc(path, { public_path: null });
  expect((await publishMediaFile('org','site','pdf')).public_url).toBe(url);
  expect((await getStore().getDoc<Media>(path))?.source_aliases).toContain('https://media.example.com/media/abcdefghij/documents/report.pdf');
});
