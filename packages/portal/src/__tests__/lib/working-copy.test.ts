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

  it('normalizes partial editor trees before storing and rejects malformed nodes', async () => {
    const { filterWcFields } = await lib();
    const input = { blocks: [{ type: 'core/section', data: {}, children: [{ type: 'core/prose', data: {} }] }] };
    const out = await filterWcFields(CTX, { kind: 'partial', id: 'header' }, input);
    expect((out.blocks as any[])[0].id).toMatch(/^blk_/);
    expect((out.blocks as any[])[0].children[0].id).toMatch(/^blk_/);
    expect(input.blocks[0]).not.toHaveProperty('id');
    await expect(filterWcFields(CTX, { kind: 'partial', id: 'header' }, { blocks: [null] })).rejects.toThrow('blocks[0]');
  });
  it('builds distinct keys per kind', async () => {
    const { wcKey } = await lib();
    expect(wcKey({ kind: 'page', id: 'home' })).toBe('page--home');
    expect(wcKey({ kind: 'partial', id: 'header' })).toBe('partial--header');
    expect(wcKey({ kind: 'page', id: 'post-1' })).toBe('page--post-1');
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

  it('all content types use global page identities for working copies', async () => {
    const { mergeWorkingCopy, readWorkingCopy } = await lib();
    await mergeWorkingCopy(CTX, { kind: 'page', id: 'blog-x' }, { title: 'Blog X' });
    await mergeWorkingCopy(CTX, { kind: 'page', id: 'team-x' }, { title: 'Team X' });
    const blog = await readWorkingCopy(CTX, { kind: 'page', id: 'blog-x' });
    const team = await readWorkingCopy(CTX, { kind: 'page', id: 'team-x' });
    expect(blog?.fields.title).toBe('Blog X');
    expect(team?.fields.title).toBe('Team X');
    expect(blog?.kind).toBe('page');
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
