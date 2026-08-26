// lib/working-copy — key construction, merge semantics, overlay.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';
const CTX = { orgId: ORG, siteId: SITE, versionId: MAIN_VERSION_ID };

async function lib() {
  return import('../../lib/working-copy');
}

describe('working-copy lib', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
  });

  it('builds distinct keys per kind', async () => {
    const { wcKey } = await lib();
    expect(wcKey({ kind: 'page', id: 'home' })).toBe('page--home');
    expect(wcKey({ kind: 'partial', id: 'header' })).toBe('partial--header');
    expect(wcKey({ kind: 'item', collection: 'blog', id: 'post-1' })).toBe('item--blog--post-1');
  });

  it('read returns null when no copy exists', async () => {
    const { readWorkingCopy } = await lib();
    expect(await readWorkingCopy(CTX, { kind: 'page', id: 'home' })).toBeNull();
  });

  it('merge creates then shallow-merges fields across writes', async () => {
    const { mergeWorkingCopy, readWorkingCopy } = await lib();
    await mergeWorkingCopy(CTX, { kind: 'page', id: 'home' }, { title: 'New title' }, 'a@b.se');
    await mergeWorkingCopy(CTX, { kind: 'page', id: 'home' }, { seo_title: 'SEO' });
    const wc = await readWorkingCopy(CTX, { kind: 'page', id: 'home' });
    expect(wc?.fields).toEqual({ title: 'New title', seo_title: 'SEO' });
    expect(wc?.kind).toBe('page');
    expect(wc?.target_id).toBe('home');
    expect(wc?.updated_at).toBeTruthy();
  });

  it('merge overwrites a field with the latest value (whole-field semantics)', async () => {
    const { mergeWorkingCopy, readWorkingCopy } = await lib();
    await mergeWorkingCopy(CTX, { kind: 'page', id: 'home' }, { blocks: [{ id: 'a', type: 'core/prose', data: {} }] });
    await mergeWorkingCopy(CTX, { kind: 'page', id: 'home' }, { blocks: [] });
    const wc = await readWorkingCopy(CTX, { kind: 'page', id: 'home' });
    expect(wc?.fields.blocks).toEqual([]);
  });

  it('item copies carry their collection and do not collide across collections', async () => {
    const { mergeWorkingCopy, readWorkingCopy } = await lib();
    await mergeWorkingCopy(CTX, { kind: 'item', collection: 'blog', id: 'x' }, { title: 'Blog X' });
    await mergeWorkingCopy(CTX, { kind: 'item', collection: 'team', id: 'x' }, { title: 'Team X' });
    const blog = await readWorkingCopy(CTX, { kind: 'item', collection: 'blog', id: 'x' });
    const team = await readWorkingCopy(CTX, { kind: 'item', collection: 'team', id: 'x' });
    expect(blog?.fields.title).toBe('Blog X');
    expect(team?.fields.title).toBe('Team X');
    expect(blog?.collection).toBe('blog');
  });

  it('discard removes the copy and is a no-op when absent', async () => {
    const { mergeWorkingCopy, discardWorkingCopy, readWorkingCopy } = await lib();
    await mergeWorkingCopy(CTX, { kind: 'partial', id: 'header' }, { html_content: '<nav/>' });
    await discardWorkingCopy(CTX, { kind: 'partial', id: 'header' });
    expect(await readWorkingCopy(CTX, { kind: 'partial', id: 'header' })).toBeNull();
    await discardWorkingCopy(CTX, { kind: 'partial', id: 'header' }); // no throw
  });

  it('overlay applies fields shallowly and is identity without a copy', async () => {
    const { overlayWorkingCopy } = await lib();
    const doc = { id: 'home', title: 'Old', status: 'published' };
    expect(overlayWorkingCopy(doc, null)).toBe(doc);
    const out = overlayWorkingCopy(doc, {
      id: 'page--home', kind: 'page', target_id: 'home',
      fields: { title: 'New' }, updated_at: 'now',
    });
    expect(out.title).toBe('New');
    expect(out.status).toBe('published');
  });
});
