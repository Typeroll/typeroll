import { beforeEach, expect, it } from 'vitest';
import { paths, type Media } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { createPage } from '../../lib/page-create';
import { commitWorkingCopy, mergeWorkingCopy, readWorkingCopy } from '../../lib/working-copy';
import { mediaReadiness } from '../../lib/media/readiness';

const ctx = { orgId: 'org', siteId: 'site', versionId: 'main' };
const target = { kind: 'page' as const, id: 'home' };
const mediaPath = `${paths.media('org', 'site')}/photo`;
const source = 'https://cms.example.com/api/sites/site/media/photo/content';
const blocks = [{ id: 'photo', type: 'core/image', data: { src: source, alt: 'Photo' } }];
beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  await getStore().setDoc(paths.site('org', 'site'), { name: 'Synthetic' });
  await getStore().setDoc(paths.version('org', 'site', 'main'), { kind: 'main' });
  await getStore().setDoc(mediaPath, { filename: 'photo.jpg', cdn_url: source, source_url: 'https://source.example.com/photo.jpg', import_pending: true, storage: { state: 'uploading' } });
});

it.each(['html', 'blocks', 'og_image'] as const)('refuses a new page with an unverified %s reference before writing it', async kind => {
  const input = kind === 'html' ? { content_mode: 'html' as const, html_content: `<img src="${source}">` }
    : kind === 'blocks' ? { blocks } : { og_image: source };
  await expect(createPage(ctx, { title: 'Home', ...input }, 'portal', 'synthetic')).rejects.toMatchObject({ status: 409, code: 'media_not_ready', details: { media_id: 'photo', state: 'pending' } });
  expect(await getStore().listDocs(paths.pages('org', 'site', 'main'))).toHaveLength(0);
});

it('refuses a new unverified reference in drafts and rechecks older drafts on Save', async () => {
  await getStore().setDoc(paths.page('org', 'site', 'home', 'main'), { title: 'Home', slug: 'home', status: 'draft', content_mode: 'blocks', blocks: [] });
  await expect(mergeWorkingCopy(ctx, target, { blocks })).rejects.toMatchObject({ code: 'media_not_ready' });
  expect(await readWorkingCopy(ctx, target)).toBeNull();
  // A draft made by an older release is checked before it reaches saved content.
  await getStore().setDoc(paths.workingCopy('org', 'site', 'page--home', 'main'), { kind: 'page', target_id: 'home', fields: { blocks }, updated_at: new Date().toISOString() });
  await expect(commitWorkingCopy(ctx, target, 'synthetic')).rejects.toMatchObject({ code: 'media_not_ready' });
  expect(await getStore().getDoc(paths.page('org', 'site', 'home', 'main'))).toMatchObject({ blocks: [] });
  expect(await readWorkingCopy(ctx, target)).not.toBeNull();
  await getStore().updateDoc(mediaPath, { storage: { state: 'ready' }, import_pending: false });
  expect(await commitWorkingCopy(ctx, target, 'synthetic')).toMatchObject({ committed: true });
  expect(await getStore().getDoc(paths.page('org', 'site', 'home', 'main'))).toMatchObject({ blocks });
});

it('keeps existing broken references editable and allows their removal', async () => {
  await getStore().updateDoc(mediaPath, { migration_failed: true });
  await getStore().setDoc(paths.page('org', 'site', 'home', 'main'), { title: 'Home', slug: 'home', status: 'draft', content_mode: 'blocks', blocks });
  await mergeWorkingCopy(ctx, target, { title: 'Updated', blocks });
  expect(await commitWorkingCopy(ctx, target, 'synthetic')).toMatchObject({ committed: true });
  await mergeWorkingCopy(ctx, target, { blocks: [] });
  expect(await commitWorkingCopy(ctx, target, 'synthetic')).toMatchObject({ committed: true });
  expect(await getStore().getDoc(paths.page('org', 'site', 'home', 'main'))).toMatchObject({ title: 'Updated', blocks: [] });
});

it('checks partial drafts and does not accept a missing or foreign private identity', async () => {
  await expect(mergeWorkingCopy(ctx, { kind: 'partial', id: 'header' }, { html_content: `<img src="${source}">` })).rejects.toMatchObject({ code: 'media_not_ready' });
  await expect(createPage(ctx, { title: 'Foreign', og_image: source.replace('/sites/site/', '/sites/other/') }, 'portal', 'synthetic')).rejects.toMatchObject({ code: 'media_not_ready', details: { state: 'missing' } });
  await getStore().deleteDoc(mediaPath);
  await expect(createPage(ctx, { title: 'Missing', og_image: source }, 'portal', 'synthetic')).rejects.toMatchObject({ code: 'media_not_ready', details: { state: 'missing' } });
});

it('preserves existing custom-field media while another custom field has an unsaved edit', async () => {
  await getStore().updateDoc(mediaPath, { migration_failed: true });
  await getStore().setDoc(paths.page('org', 'site', 'home', 'main'), { title: 'Home', slug: 'home', status: 'draft', fields: { photo: source, caption: 'Before' } });
  await mergeWorkingCopy(ctx, target, { fields: { caption: 'After' } });
  await expect(mergeWorkingCopy(ctx, target, { fields: { photo: source } })).resolves.toMatchObject({ fields: { fields: { photo: source, caption: 'After' } } });
});

it('distinguishes pending and stopped imports while retaining legacy and verified media', async () => {
  const media = (await getStore().getDoc<Media>(mediaPath))!;
  expect(mediaReadiness(media)).toMatchObject({ state: 'pending', selectable: false });
  expect(mediaReadiness({ ...media, migration_failed: true } as Media)).toMatchObject({ state: 'failed', selectable: false });
  expect(mediaReadiness({ ...media, storage: { state: 'ready' }, migration_failed: true } as unknown as Media)).toMatchObject({ state: 'ready', selectable: true });
  expect(mediaReadiness({ id: 'missing', created_at: '', filename: 'missing.jpg', cdn_url: source })).toMatchObject({ state: 'failed', selectable: false });
  expect(mediaReadiness({ id: 'legacy', created_at: '', filename: 'legacy.jpg', cdn_url: 'https://cdn.example.com/legacy.jpg', r2_key: 'legacy.jpg', source_url: 'https://old.example.com/a.jpg' } as Media)).toMatchObject({ state: 'ready', selectable: true });
});
