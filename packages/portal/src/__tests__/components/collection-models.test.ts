// The pure helpers behind the organization collection and the Members page.

import { describe, expect, it } from 'vitest';
import {
  canInsertIntoPage, entryFieldProblems, entryPatch, filterEntries, groupEntries, insertBody, insertedLine, isEditableEntry,
  knownCategories, libraryActionLabel, publisherOf, renamedStyles, saveBody, saveChoices, sourceFilterOf, sourceLine, summaryLine, templateSaveKind,
} from '../../components/collection-model';
import {
  inviteBody, inviteProblems, initialInviteDraft, memberApiError, roleOptions, sortMembers,
} from '../../components/members-model';
import { collectionEntries, entry, insertReport } from './collection-fixtures';
import { exportable } from './package-fixtures';

describe('collection entries', () => {
  it('filters by source and by every search word', () => {
    const entries = collectionEntries();
    expect(filterEntries(entries, { query: '', source: 'typeroll' }).map(e => e.id)).toEqual(['typeroll-feature-page', 'typeroll-template-article']);
    expect(filterEntries(entries, { query: '', source: 'organization' }).map(e => e.id)).toEqual(['hero-split', 'pricing-row']);
    expect(filterEntries(entries, { query: '', source: 'packages' }).map(e => e.id)).toEqual(['site-header']);
    expect(filterEntries(entries, { query: '', source: 'apps' }).map(e => e.id)).toEqual(['booking-card']);
    expect(filterEntries(entries, { query: 'acme header', source: 'all' }).map(e => e.id)).toEqual(['site-header']);
    expect(filterEntries(entries, { query: 'headline', source: 'all' }).map(e => e.id)).toEqual(['hero-split']);
    expect(filterEntries(entries, { query: '', source: 'all', kind: 'page_template' }).map(e => e.id)).toEqual(['typeroll-template-article']);
  });

  it('groups by kind in a fixed order, then by category with uncategorized last', () => {
    const groups = groupEntries([...collectionEntries(), entry('cta', { category: undefined }), entry('about', { category: 'About' })]);
    expect(groups.map(group => group.kind)).toEqual(['section', 'block_template', 'global_block', 'page_template', 'block_type']);
    expect(groups[0].label).toBe('Sections');
    expect(groups[0].categories.map(c => c.category)).toEqual(['About', 'Heroes', 'Page layouts', null]);
    expect(groups[0].count).toBe(4);
  });

  it('describes where an entry came from and who published it', () => {
    expect(sourceLine({ type: 'builtin' })).toBe('Typeroll built-in');
    expect(sourceLine({ type: 'site', site_id: 's1' }, { s1: 'Café' })).toBe('Saved from Café');
    expect(sourceLine({ type: 'site', site_id: 's2' })).toBe('Saved by your organization');
    expect(sourceLine({ type: 'package', package_name: 'Acme', version: '1.2.0' })).toBe('From Acme 1.2.0');
    expect(sourceLine({ type: 'app', publisher: 'Bookly' })).toBe('From an app by Bookly');
    expect(publisherOf({ type: 'builtin' })).toEqual({ name: 'Typeroll', verified: true });
    expect(publisherOf({ type: 'package', publisher: 'Acme' })).toEqual({ name: 'Acme', verified: false });
    expect(publisherOf({ type: 'site' })).toBeNull();
    expect(sourceFilterOf({ type: 'app' })).toBe('apps');
  });

  it('says what an entry carries and what can be done with it', () => {
    expect(summaryLine({ block_count: 1, styles: 2, block_types: 1, media: 3 })).toBe('1 block · 2 styles · 1 block type · 3 media files');
    expect(summaryLine({ styles: 0, block_types: 0, media: 0 })).toBe('');
    expect(canInsertIntoPage({ kind: 'global_block' })).toBe(true);
    expect(canInsertIntoPage({ kind: 'page_template' })).toBe(false);
    expect(libraryActionLabel('block_type')).toBe('Add to this site’s block types');
    expect(isEditableEntry({ source: { type: 'builtin' } })).toBe(false);
    expect(isEditableEntry({ read_only: true, source: { type: 'package' } })).toBe(false);
    expect(isEditableEntry({ source: { type: 'site' } })).toBe(true);
    expect(knownCategories(collectionEntries())).toEqual(['Heroes', 'Page layouts', 'Pricing']);
  });

  it('reads renamed styles from an insert report in either shape', () => {
    expect(renamedStyles(insertReport().report)).toEqual([{ from: 'hero-title', to: 'hero-title-2' }]);
    expect(renamedStyles({ renamed: { styles: { lead: 'lead-2' } } })).toEqual([{ from: 'lead', to: 'lead-2' }]);
    expect(renamedStyles(null)).toEqual([]);
    expect(insertedLine('Hero split', insertReport().report)).toBe('Inserted Hero split. Styles: created 1 style; renamed hero-title → hero-title-2.');
    expect(insertedLine('Quote', { created: {} })).toBe('Inserted Quote.');
  });

  it('checks and patches only the edited fields', () => {
    expect(entryFieldProblems({ name: ' ', description: '', category: 'x'.repeat(61) })).toEqual({ name: 'Give it a name.', category: 'The category can be at most 60 characters.' });
    const current = entry('hero', { name: 'Hero', description: 'Old', category: 'Heroes' });
    expect(entryPatch(current, { name: 'Hero', description: '', category: ' Heroes ' })).toEqual({ description: '' });
    expect(entryPatch(current, { name: ' Big hero ', description: 'Old', category: 'Heroes' })).toEqual({ name: 'Big hero' });
  });

  it('offers what a site can save, with the collection kind of each', () => {
    const choices = saveChoices(exportable);
    expect(choices.map(choice => choice.key)).toEqual(['section:hero', 'block_template:quote', 'page_template:landing', 'global_block:cta', 'block_type:price-row']);
    expect(choices[0]).toMatchObject({ label: 'Hero', group: 'Block templates and sections', category: 'Heroes' });
    expect(templateSaveKind({ kind: 'section' })).toBe('section');
    expect(templateSaveKind({})).toBe('block_template');
    expect(saveBody({ kind: 'section', id: 'hero' }, { name: ' Hero ', description: '', category: 'Heroes' })).toEqual({ kind: 'section', id: 'hero', name: 'Hero', category: 'Heroes' });
    expect(saveChoices(null)).toEqual([]);
  });

  it('builds the insert body for the library and for a page', () => {
    expect(insertBody({ target: 'library' })).toEqual({ target: 'library' });
    expect(insertBody({ target: 'page', page_id: 'home', after_block_id: 'b1', position: 2 })).toEqual({ target: 'page', page_id: 'home', after_block_id: 'b1' });
    expect(insertBody({ target: 'page', page_id: 'home', position: 0 })).toEqual({ target: 'page', page_id: 'home', position: 0 });
  });
});

describe('members', () => {
  it('sorts owners first and offers Owner only on an owner’s row', () => {
    const sorted = sortMembers([
      { email: 'zed@example.com', role: 'editor' as const },
      { email: 'bo@example.com', role: 'builder' as const },
      { email: 'amy@example.com', role: 'owner' as const, display_name: 'Amy' },
      { email: 'al@example.com', role: 'admin' as const },
    ]);
    expect(sorted.map(member => member.role)).toEqual(['owner', 'admin', 'builder', 'editor']);
    expect(roleOptions('owner')).toEqual(['owner', 'admin', 'builder', 'editor']);
    expect(roleOptions('editor')).toEqual(['admin', 'builder', 'editor']);
    expect(roleOptions('editor', 'owner')).toEqual(['owner', 'admin', 'builder', 'editor']);
  });

  it('defaults invites to Editor and checks the options', () => {
    const draft = initialInviteDraft();
    expect(draft.role).toBe('editor');
    expect(inviteProblems(draft)).toEqual({});
    expect(inviteProblems({ ...draft, role: 'owner', email: 'nope', ttlDays: 31, maxUses: 0 })).toEqual({
      role: expect.any(String), email: expect.any(String), ttlDays: expect.any(String), maxUses: expect.any(String),
    });
    expect(inviteBody({ ...draft, role: 'builder', email: ' Bo@Example.com ' })).toEqual({ role: 'builder', ttlDays: 7, max_uses: 1, email: 'bo@example.com' });
    expect(inviteBody(draft)).not.toHaveProperty('email');
  });

  it('explains the last-owner refusal', () => {
    expect(memberApiError({ code: 'last_owner', error: 'x' }, 409, 'Changing')).toMatch(/at least one owner/);
    expect(memberApiError({ error: 'Nope' }, 400, 'Changing')).toBe('Nope');
    expect(memberApiError(null, 403, 'Changing')).toMatch(/owners and administrators/);
    expect(memberApiError(null, 500, 'Changing')).toBe('Changing failed (500).');
  });
});
