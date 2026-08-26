import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  TEMPLATE_CONTENT_SLOT_TYPE_ID,
  paths,
  type Block,
  type BlockType,
  type BlockOrigin,
  type BlockPackageRef,
  type PageTemplate,
  type PageTemplateStatus,
} from '../types.js';

// These tests lock the data-contract field names + path layout that the
// Phase 1+ work depends on. If you rename a field, you must update both the
// implementation AND this test in the same commit — the test exists so a
// silent rename can't break round-tripping across the renderer, the editor,
// the MCP server, and stored Firestore docs.

describe('TEMPLATE_CONTENT_SLOT_TYPE_ID', () => {
  it('is the reserved string used by templates to mark the content slot', () => {
    expect(TEMPLATE_CONTENT_SLOT_TYPE_ID).toBe('template_content_slot');
  });
});

describe('BlockOrigin', () => {
  it('includes third_party alongside core/user/ai', () => {
    const origins: BlockOrigin[] = ['core', 'ai', 'user', 'third_party'];
    expect(origins).toHaveLength(4);
  });
});

describe('BlockType shape', () => {
  it('accepts script + origin + imported_from fields', () => {
    const bt: BlockType = {
      id: 'hero-bold',
      name: 'hero_bold',
      label: 'Bold Hero',
      category: 'layout',
      container: false,
      schema: [
        { name: 'title', type: 'text', label: 'Title', required: true },
        { name: 'subtitle', type: 'text', label: 'Subtitle' },
      ],
      template: '<section class="hero-bold"><h1>{{title}}</h1><p>{{subtitle}}</p></section>',
      styles: '.hero-bold { padding: 4rem 0; }',
      script: 'window.TyperollBlocks.register("hero-bold", (el) => { /* … */ });',
      origin: 'third_party',
      imported_from: {
        package_name: 'tcblocks-marketing-pack',
        version: '1.2.0',
        imported_at: '2026-05-22T10:00:00Z',
      },
      created_at: '2026-05-22T10:00:00Z',
    };
    expect(bt.script).toContain('register');
    expect(bt.origin).toBe('third_party');
    expect(bt.imported_from?.package_name).toBe('tcblocks-marketing-pack');
  });

  it('still accepts the legacy created_by field for back-compat reads', () => {
    const legacy: BlockType = {
      id: 'old',
      name: 'old',
      label: 'Old',
      category: 'content',
      container: false,
      schema: [],
      created_by: 'user',
      created_at: '2026-01-01T00:00:00Z',
    };
    expect(legacy.created_by).toBe('user');
  });

  it('container can be true | false | slots, with slot metadata when slotted', () => {
    const slotted: BlockType = {
      id: 'cols-2',
      name: 'columns_2',
      label: 'Two Columns',
      category: 'layout',
      container: 'slots',
      slot_count: 2,
      slot_labels: ['Left', 'Right'],
      schema: [],
      origin: 'core',
      created_at: '2026-05-22T10:00:00Z',
    };
    expect(slotted.container).toBe('slots');
    expect(slotted.slot_count).toBe(2);
  });
});

describe('PageTemplate shape', () => {
  it('carries a block tree and a status', () => {
    const tpl: PageTemplate = {
      id: 'blog-post',
      name: 'blog_post',
      label: 'Blog post',
      applies_to: 'collection:blog',
      blocks: [
        {
          id: 'b1',
          type: 'section',
          data: { width: 'narrow' },
          children: [
            { id: 'b2', type: TEMPLATE_CONTENT_SLOT_TYPE_ID, data: {} },
          ],
        },
      ],
      status: 'published',
      created_at: '2026-05-22T10:00:00Z',
    };
    expect(tpl.blocks[0].children?.[0].type).toBe(TEMPLATE_CONTENT_SLOT_TYPE_ID);

    expectTypeOf<PageTemplateStatus>().toEqualTypeOf<'draft' | 'published'>();
  });

  it("applies_to template-string permits collection:* literals", () => {
    const a: PageTemplate['applies_to'] = 'collection:blog';
    const b: PageTemplate['applies_to'] = 'page';
    const c: PageTemplate['applies_to'] = 'any';
    expect([a, b, c]).toEqual(['collection:blog', 'page', 'any']);
  });
});

describe('Block tree primitives unchanged', () => {
  it('Block still has children + slots for hierarchy', () => {
    const b: Block = {
      id: 'root',
      type: 'columns_2',
      data: {},
      slots: [
        [{ id: 'a', type: 'prose', data: { html: '<p>left</p>' } }],
        [{ id: 'b', type: 'prose', data: { html: '<p>right</p>' } }],
      ],
    };
    expect(b.slots?.length).toBe(2);
  });
});

describe('BlockPackageRef shape', () => {
  it('locks the field names used by import/export tools', () => {
    const ref: BlockPackageRef = {
      package_name: 'pkg',
      version: '1.0.0',
      imported_at: '2026-05-22T10:00:00Z',
    };
    expect(Object.keys(ref).sort()).toEqual(['imported_at', 'package_name', 'version']);
  });
});

describe('paths for block_types + page_templates', () => {
  it('blockTypes points at the per-version collection', () => {
    expect(paths.blockTypes('org1', 'site1')).toBe(
      'organizations/org1/sites/site1/versions/main/block_types',
    );
    expect(paths.blockTypes('org1', 'site1', 'branch-a')).toBe(
      'organizations/org1/sites/site1/versions/branch-a/block_types',
    );
  });

  it('blockType points at a single doc inside that collection', () => {
    expect(paths.blockType('org1', 'site1', 'hero-bold')).toBe(
      'organizations/org1/sites/site1/versions/main/block_types/hero-bold',
    );
  });

  it('pageTemplates and pageTemplate follow the same per-version layout', () => {
    expect(paths.pageTemplates('org1', 'site1')).toBe(
      'organizations/org1/sites/site1/versions/main/page_templates',
    );
    expect(paths.pageTemplate('org1', 'site1', 'blog-post')).toBe(
      'organizations/org1/sites/site1/versions/main/page_templates/blog-post',
    );
  });
});
