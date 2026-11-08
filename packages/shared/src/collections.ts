/**
 * The organization collection: templates, sections, page templates, global
 * blocks, block types and whole packages stored once for an organization
 * and inserted into any of its sites.
 *
 * Each entry holds a `collection` package (site-package.ts) with what the
 * entry needs: its blocks, the styles and block types they use and their
 * media (files kept in the organization's storage). Inserting an entry into a
 * site is a package import: styles are created there, never mapped.
 *
 * Who sees it: the organization's owners, administrators and builders. A
 * client given access to one site (a share to another organization) does not.
 * Typeroll's built-in starters appear as read-only entries.
 */
import type { Block, MemberRole } from './types.js';
import type { SitePackage } from './site-package.js';
import { SITE_PACKAGE_FORMAT, SITE_PACKAGE_FORMAT_VERSION } from './site-package.js';
import { PAGE_BODY_STARTER_KINDS, getPageBodyStarter, type PageBodyStarterKind } from './page-body-starters.js';
import { getPageTemplateStarter, type PageTemplateStarterKind } from './page-template-starters.js';
import { getPartialCompositionStarter } from './site-compositions.js';
import { BLOCK_TYPE_STARTERS } from './block-type-starters.js';

// ── Roles ─────────────────────────────────────────────────────────────────

export const ORGANIZATION_ROLES = ['owner', 'admin', 'builder', 'editor'] as const;
export const isOrganizationRole = (value: unknown): value is MemberRole => typeof value === 'string' && (ORGANIZATION_ROLES as readonly string[]).includes(value);

/** Roles an owner or administrator can give when inviting or changing a member. */
export const ASSIGNABLE_ROLES: readonly MemberRole[] = ['admin', 'builder', 'editor'];

export const ROLE_LABELS: Record<MemberRole, string> = { owner: 'Owner', admin: 'Administrator', builder: 'Builder', editor: 'Editor' };
export const ROLE_DESCRIPTIONS: Record<MemberRole, string> = {
  owner: 'Everything, including the organization itself.',
  admin: 'Everything on every site: members, publishing, domains, keys and design.',
  builder: 'Structure, design, templates and the collection on every site; no members, billing or publishing connections.',
  editor: 'Pages and content on every site.',
};

/**
 * Design work: colours, fonts, typography, styles, block types, menus,
 * templates, site field definitions, package imports with the whole look,
 * and the organization collection.
 */
export function roleCanDesign(role: unknown): boolean {
  return role === 'owner' || role === 'admin' || role === 'builder';
}

/** Members, invites, billing and publishing connections. */
export function roleCanManageOrganization(role: unknown): boolean {
  return role === 'owner' || role === 'admin';
}

/** The organization collection is visible to owners, administrators and builders. */
export const roleCanUseCollection = roleCanDesign;

// ── Entries ───────────────────────────────────────────────────────────────

export const COLLECTION_ENTRY_KINDS = ['section', 'block_template', 'page_template', 'global_block', 'block_type', 'package'] as const;
export type CollectionEntryKind = typeof COLLECTION_ENTRY_KINDS[number];
export const COLLECTION_ENTRY_ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;
export const MAX_COLLECTION_ENTRIES = 2000;

export interface CollectionEntrySource {
  type: 'site' | 'package' | 'builtin' | 'app';
  site_id?: string;
  package_id?: string;
  package_name?: string;
  version?: string;
  publisher?: string;
  /** Verified publisher signature on the package it came from. */
  verified?: boolean;
  extension_id?: string;
}

export interface CollectionEntry {
  id: string;
  kind: CollectionEntryKind;
  name: string;
  description?: string;
  category?: string;
  /** Package media id of a preview image. */
  preview?: string;
  languages?: string[];
  /** The entry's content and what it needs. Its media files are in the organization's storage. */
  package: SitePackage;
  source: CollectionEntrySource;
  /** Built-in entries cannot be changed or removed. */
  read_only?: boolean;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

/** The package entry a collection entry inserts: `<section>.<id>` for PackageImportOptions.only. */
export function collectionEntryTarget(entry: Pick<CollectionEntry, 'kind' | 'package'>): string | null {
  const c = entry.package.contents;
  switch (entry.kind) {
    case 'section': case 'block_template': return c.block_templates?.[0] ? `block_templates.${c.block_templates[0].id}` : null;
    case 'page_template': return c.page_templates?.[0] ? `page_templates.${c.page_templates[0].id}` : null;
    case 'global_block': return c.global_blocks?.[0] ? `global_blocks.${c.global_blocks[0].id}` : null;
    case 'block_type': return c.block_types?.[0] ? `block_types.${c.block_types[0].id}` : null;
    default: return null;
  }
}

/** The blocks an entry places on a page, if it places any. */
export function collectionEntryBlocks(entry: Pick<CollectionEntry, 'kind' | 'package'>): Block[] | null {
  const c = entry.package.contents;
  if (entry.kind === 'section' || entry.kind === 'block_template') return c.block_templates?.[0]?.blocks ?? null;
  if (entry.kind === 'global_block') return c.global_blocks?.[0] ? [{ id: 'global', type: 'core/global_block', data: { global_block_id: c.global_blocks[0].id } }] : null;
  return null;
}

/** Errors in the editable fields of an entry. */
export function collectionEntryFieldErrors(input: { name?: unknown; description?: unknown; category?: unknown }): string[] {
  const errors: string[] = [];
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120)) errors.push('name must be text up to 120 characters');
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 500)) errors.push('description must be text up to 500 characters');
  if (input.category !== undefined && (typeof input.category !== 'string' || input.category.length > 60)) errors.push('category must be text up to 60 characters');
  return errors;
}

// ── Typeroll's built-in starters as entries ───────────────────────────────

const BUILTIN_DATE = '2026-11-07T00:00:00.000Z';
const builtinPackage = (id: string, name: string, contents: SitePackage['contents']): SitePackage => ({
  format: SITE_PACKAGE_FORMAT, format_version: SITE_PACKAGE_FORMAT_VERSION, kind: 'collection',
  id: `typeroll-${id}`, name, version: '1', author: { name: 'Typeroll' }, licence: { name: 'Free to use on Typeroll sites' },
  created_at: BUILTIN_DATE, contents, media: [], integrity: { algorithm: 'sha256', files: {} },
});

const PAGE_BODY_NAMES: Record<PageBodyStarterKind, [string, string]> = {
  feature_page: ['Feature page', 'A feature: what it does, how it works, proof and a call to action.'],
  comparison_page: ['Comparison page', 'A product compared with an alternative, point by point.'],
  integration_page: ['Integration page', 'How a product connects with another tool.'],
  pricing_page: ['Pricing page', 'Plans, what each includes and common questions.'],
  use_case_page: ['Use case page', 'A problem, the solution and an example.'],
};
const PAGE_TEMPLATE_NAMES: Array<[PageTemplateStarterKind, string, string]> = [
  ['article', 'Article', 'Title, date, image and the article text.'],
  ['blog', 'Blog post', 'A post with author, date and related posts.'],
  ['landing', 'Landing page', 'A hero and room for sections.'],
  ['team', 'Team member', 'A profile with photo, role and contact.'],
  ['events', 'Event', 'Date, place and details of an event.'],
  ['products', 'Product', 'A product with image, price and details.'],
  ['checklist', 'Checklist', 'Steps to tick off.'],
  ['profile', 'Profile', 'A person or organization profile.'],
];

/**
 * Typeroll's built-in starters as read-only collection entries: page bodies
 * as sections, page templates, a header and footer, and block type starters.
 */
export function builtinCollectionEntries(options: { renderVersion?: number } = {}): CollectionEntry[] {
  const entry = (id: string, kind: CollectionEntryKind, name: string, description: string, category: string, contents: SitePackage['contents']): CollectionEntry => ({
    id: `typeroll-${id}`, kind, name, description, category, package: builtinPackage(id, name, contents),
    source: { type: 'builtin', publisher: 'Typeroll' }, read_only: true, created_at: BUILTIN_DATE, updated_at: BUILTIN_DATE,
  });
  const entries: CollectionEntry[] = [];
  for (const kind of PAGE_BODY_STARTER_KINDS) {
    const [name, description] = PAGE_BODY_NAMES[kind];
    entries.push(entry(kind.replace(/_/g, '-'), 'section', name, description, 'Page layouts', { block_templates: [{ id: kind.replace(/_/g, '-'), name, description, kind: 'section', category: 'Page layouts', blocks: getPageBodyStarter(kind) }] }));
  }
  for (const [kind, name, description] of PAGE_TEMPLATE_NAMES) {
    const blocks = getPageTemplateStarter(kind);
    if (blocks) entries.push(entry(`template-${kind}`, 'page_template', name, description, 'Page templates', { page_templates: [{ id: kind, name: kind, label: name, applies_to: 'any', blocks }] }));
  }
  for (const kind of ['header', 'footer'] as const) {
    const name = kind === 'header' ? 'Header with menu' : 'Footer with menu';
    entries.push(entry(kind, 'global_block', name, `A ${kind} with the logo and the site's ${kind === 'header' ? 'primary' : 'footer'} menu.`, 'Headers and footers', {
      global_blocks: [{ id: kind, name, kind, blocks: getPartialCompositionStarter(kind, { links: [], renderVersion: options.renderVersion }) }],
    }));
  }
  for (const starter of BLOCK_TYPE_STARTERS) {
    entries.push(entry(`block-${starter.id.replace(/_/g, '-')}`, 'block_type', starter.label, starter.description, 'Block types', {
      block_types: [{ id: starter.definition.name, ...starter.definition } as never],
    }));
  }
  return entries;
}
