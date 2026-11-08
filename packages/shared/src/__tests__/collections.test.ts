import { describe, expect, it } from 'vitest';
import {
  ASSIGNABLE_ROLES, builtinCollectionEntries, collectionEntryBlocks, collectionEntryFieldErrors, collectionEntryTarget,
  isOrganizationRole, planPackageImport, roleCanDesign, roleCanManageOrganization, roleCanUseCollection, sitePackageErrors, paths,
} from '../index.js';

describe('organization roles', () => {
  it('lets builders design and use the collection but not manage the organization', () => {
    expect(roleCanDesign('builder')).toBe(true);
    expect(roleCanUseCollection('builder')).toBe(true);
    expect(roleCanManageOrganization('builder')).toBe(false);
    expect(roleCanDesign('editor')).toBe(false);
    expect(roleCanUseCollection('editor')).toBe(false);
    expect(roleCanManageOrganization('admin')).toBe(true);
    expect(isOrganizationRole('builder')).toBe(true);
    expect(isOrganizationRole('client')).toBe(false);
    expect(ASSIGNABLE_ROLES).not.toContain('owner');
  });
});

describe('built-in collection entries', () => {
  const entries = builtinCollectionEntries({ renderVersion: 15 });

  it('offers page layouts, page templates, a header and footer and block types as valid packages', () => {
    expect(new Set(entries.map(entry => entry.kind))).toEqual(new Set(['section', 'page_template', 'global_block', 'block_type']));
    expect(new Set(entries.map(entry => entry.id)).size).toBe(entries.length);
    for (const entry of entries) {
      expect(entry.read_only).toBe(true);
      expect(entry.source).toEqual({ type: 'builtin', publisher: 'Typeroll' });
      expect(sitePackageErrors(entry.package), entry.id).toEqual([]);
      expect(collectionEntryTarget(entry), entry.id).toBeTruthy();
    }
  });

  it('inserts a section as blocks and a header only with a whole site', () => {
    const section = entries.find(entry => entry.id === 'typeroll-pricing-page')!;
    expect(collectionEntryBlocks(section)?.length).toBeGreaterThan(0);
    const header = entries.find(entry => entry.id === 'typeroll-header')!;
    expect(collectionEntryTarget(header)).toBe('global_blocks.header');
    const plan = planPackageImport(section.package, { styles: [], blockTypes: [], blockTemplateIds: [], pageTemplateIds: [], globalBlockIds: [], menuIds: [] }, { design: 'content', only: [collectionEntryTarget(section)!] });
    expect(plan.block_templates.map(t => t.from)).toEqual(['pricing-page']);
  });

  it('checks editable fields and has an organization path', () => {
    expect(collectionEntryFieldErrors({ name: 'Hero', category: 'Heroes' })).toEqual([]);
    expect(collectionEntryFieldErrors({ name: '', description: 'x'.repeat(501) })).toHaveLength(2);
    expect(paths.collectionEntry('org1', 'hero')).toBe('organizations/org1/collection/hero');
  });
});
