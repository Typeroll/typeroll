import { beforeEach, expect, it } from 'vitest';
import { paths } from '@typeroll/shared';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { generatedCloudflareNames } from '../../lib/publishing/cloudflare-account-claims';
import { generatedRepositoryDescription, readableRepositoryName, siteRepositoryName } from '../../lib/publishing/site-repository';

const legacy = generatedCloudflareNames('org', 'moveria-de').pages_project!;
const githubWith = (repos: Record<string, { description?: string }>) => async (path: string) => {
  const name = path.split('/').pop()!;
  return repos[name] ? { name, ...repos[name] } : null;
};
const saved = async () => (await getStore().getDoc<any>(paths.site('org', 'moveria-de')))?.git_repository;

beforeEach(async () => {
  makeTmpFixtures(); await resetDatastore();
  await getStore().setDoc(paths.site('org', 'moveria-de'), { id: 'moveria-de', name: 'Moveria.de' });
});

it('names a new site repository after the site and saves the choice', async () => {
  expect(await siteRepositoryName('org', 'moveria-de', null, githubWith({}), 'Moveria-AB')).toBe('typeroll-moveria-de');
  expect(await saved()).toBe('typeroll-moveria-de');
});

it('keeps the hash name for a site that already has a repository', async () => {
  expect(await siteRepositoryName('org', 'moveria-de', null, githubWith({ [legacy]: {} }), 'Moveria-AB')).toBe(legacy);
  expect(await saved()).toBe(legacy);
});

it('adds a short suffix when another repository has the readable name', async () => {
  const name = await siteRepositoryName('org', 'moveria-de', null, githubWith({ 'typeroll-moveria-de': { description: 'Someone else' } }), 'Moveria-AB');
  expect(name).toMatch(/^typeroll-moveria-de-[a-f0-9]{4}$/);
});

it('recovers a lost saved choice from the repository description', async () => {
  const github = githubWith({ 'typeroll-moveria-de': { description: generatedRepositoryDescription('org', 'moveria-de') } });
  expect(await siteRepositoryName('org', 'moveria-de', null, github, 'Moveria-AB')).toBe('typeroll-moveria-de');
});

it('never changes a saved choice', async () => {
  await getStore().updateDoc(paths.site('org', 'moveria-de'), { git_repository: 'typeroll-chosen' });
  const site = await getStore().getDoc<any>(paths.site('org', 'moveria-de'));
  expect(await siteRepositoryName('org', 'moveria-de', site, githubWith({}), 'Moveria-AB')).toBe('typeroll-chosen');
});

it('maps site ids to GitHub repository characters', () => {
  expect(readableRepositoryName('Moveria_DE.2026')).toBe('typeroll-moveria-de-2026');
  expect(readableRepositoryName('--a--b--')).toBe('typeroll-a-b');
  expect(readableRepositoryName('___')).toBeNull();
});
