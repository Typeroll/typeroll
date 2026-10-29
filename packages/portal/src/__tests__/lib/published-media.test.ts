import { beforeEach, describe, expect, it } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';

const ORG = 'org', SITE = 'site';
const sha = (c: string) => c.repeat(64);
const entry = (id: string, c: string, path: string) => ({
  id, sha256: sha(c), cdn_url: `https://www.example.at${path}`, public_path: path, aliases: [{ url: `https://media.example.com/site${path}` }],
});

async function seed(id: string, doc: Record<string, unknown>) {
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(`${paths.media(ORG, SITE)}/${id}`, { filename: `${id}.jpg`, created_at: '2026-10-01T00:00:00Z', ...doc });
}
async function read(id: string) {
  const { getStore } = await import('../../lib/datastore');
  return getStore().getDoc<any>(`${paths.media(ORG, SITE)}/${id}`);
}

describe('recordPublishedMedia', () => {
  beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); });

  it('records the address a main publication serves and clears files it no longer publishes', async () => {
    const { recordPublishedMedia } = await import('../../lib/publishing/published-media');
    await seed('used', { sha256: sha('a'), source_aliases: ['https://old.example/wp-content/uploads/used.jpg'] });
    await seed('dropped', { sha256: sha('b'), published_url: 'https://www.example.at/media/bbbb-dropped.jpg', published_path: '/media/bbbb-dropped.jpg' });
    await seed('never', { sha256: sha('c') });
    await recordPublishedMedia(ORG, SITE, [entry('used', 'a', '/media/aaaaaaaaaaaaaaaa-used_name.jpg')], { main: true });

    const used = await read('used');
    expect(used).toMatchObject({ published_url: 'https://www.example.at/media/aaaaaaaaaaaaaaaa-used_name.jpg', published_path: '/media/aaaaaaaaaaaaaaaa-used_name.jpg' });
    expect(used.source_aliases).toEqual(expect.arrayContaining([
      'https://old.example/wp-content/uploads/used.jpg', 'https://www.example.at/media/aaaaaaaaaaaaaaaa-used_name.jpg', 'https://media.example.com/site/media/aaaaaaaaaaaaaaaa-used_name.jpg',
    ]));
    expect(await read('dropped')).toMatchObject({ published_url: null, published_path: null });
    expect((await read('never')).published_url).toBeUndefined();
  });

  it('only adds aliases for a non-main version', async () => {
    const { recordPublishedMedia } = await import('../../lib/publishing/published-media');
    await seed('used', { sha256: sha('a'), published_url: 'https://www.example.at/media/live.jpg', published_path: '/media/live.jpg' });
    await recordPublishedMedia(ORG, SITE, [entry('used', 'a', '/media/preview.jpg')], { main: false });
    const used = await read('used');
    expect(used).toMatchObject({ published_url: 'https://www.example.at/media/live.jpg', published_path: '/media/live.jpg' });
    expect(used.source_aliases).toContain('https://www.example.at/media/preview.jpg');
  });

  it('leaves a file whose bytes changed since the publication was prepared', async () => {
    const { recordPublishedMedia } = await import('../../lib/publishing/published-media');
    await seed('used', { sha256: sha('d') });
    await recordPublishedMedia(ORG, SITE, [entry('used', 'a', '/media/aaaa-used.jpg')], { main: true });
    expect((await read('used')).published_url).toBeUndefined();
  });
});
