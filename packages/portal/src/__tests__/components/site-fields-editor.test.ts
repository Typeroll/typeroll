// Server render of the portal's site fields page. The editing operations are
// covered in site-fields-model.test.ts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { openingHoursField, type SiteFields } from '@typeroll/shared';
import SiteFieldsEditor, { GroupDefinition, type DefinitionContext } from '../../components/SiteFieldsEditor';

const fields: SiteFields = {
  updated_at: '2026-11-07T10:00:00.000Z',
  groups: [
    { id: 'contact', label: 'Contact', description: 'How visitors reach us', access: 'editor', fields: [
      { name: 'phone', type: 'text', label: 'Phone' },
      { name: 'show_booking', type: 'boolean', label: 'Show booking' },
      openingHoursField(),
    ] },
    { id: 'legal', label: 'Legal', access: 'admin', fields: [{ name: 'org_number', type: 'text', label: 'Organisation number' }] },
  ],
  values: {
    phone: '+46 8 123 45',
    show_booking: true,
    org_number: '556000-0000',
    opening_hours: { days: [{ day: 'monday', closed: false, opens: '09:00', closes: '17:00' }], exceptions: [{ date: '2026-12-24', closed: true, note: 'Christmas Eve' }] },
  },
};

const render = (permission: 'read' | 'write' | 'admin', initial: SiteFields | null = fields) =>
  renderToString(createElement(SiteFieldsEditor, { siteId: 'site', permission, initial }));

describe('SiteFieldsEditor', () => {
  it('shows a tab per settings page and the first page’s fields', () => {
    const html = render('write');
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Contact/);
    expect(html).toContain('Legal');
    expect(html).toContain('How visitors reach us');
    expect(html).toContain('value="+46 8 123 45"');
    expect(html).toContain('Save Contact');
  });

  it('gives opening hours a week of rows and the exceptions', () => {
    const html = render('write');
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) expect(html).toContain(`aria-label="${day} closed"`);
    expect(html).toMatch(/aria-label="Monday opens" value="09:00"/);
    expect(html).toContain('value="2026-12-24"');
    expect(html).toContain('value="Christmas Eve"');
    expect(html).toContain('Deviating hours on a date');
    expect(html).toContain('Comment shown to visitors');
    expect(html).toContain('Add date');
    expect(html).toContain('Copy Monday to Tuesday–Friday');
  });

  it('shows how to use each field, with a copy button', () => {
    const html = render('write');
    expect(html).toContain('{{site.fields.phone}}');
    expect(html).toContain('aria-label="Copy the placeholder for Phone"');
    expect(html).toContain('site.fields.show_booking');
    expect(html).toContain('Site field block');
  });

  it('offers admins the definitions and the history, not editors', () => {
    expect(render('admin')).toContain('Define fields');
    expect(render('admin')).toContain('History');
    expect(render('write')).not.toContain('Define fields');
  });

  it('is read-only without write access', () => {
    const html = render('read');
    expect(html).not.toContain('Save Contact');
    expect(html).toContain('Changing them needs write access');
    expect(html).toContain('+46 8 123 45');
    expect(html).not.toContain('value="+46 8 123 45"');
  });

  it('explains settings pages when there are none, with a create button for admins', () => {
    const empty: SiteFields = { groups: [], values: {} };
    const admin = render('admin', empty);
    expect(admin).toContain('No settings pages yet');
    expect(admin).toContain('Create a settings page');
    const editor = render('write', empty);
    expect(editor).toContain('No settings pages yet');
    expect(editor).not.toContain('Create a settings page');
    expect(editor).toContain('An administrator');
  });

  it('loads the fields itself without server data', () => {
    expect(render('write', null)).toContain('Loading the site fields');
  });

  it('keeps its stylesheet as raw text so hydration matches', () => {
    const css = [...render('write').matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]).find((text) => text!.includes('.sf-hours'));
    expect(css).toContain('[type="checkbox"]');
    expect(css).not.toMatch(/&(?:gt|lt|quot|amp);/);
  });
});

describe('GroupDefinition', () => {
  const props = (open: string[], errors: DefinitionContext['errors'] = { general: [], byKey: new Map() }): DefinitionContext & { onRemove: () => void; onMove: (delta: -1 | 1) => void } => ({
    domId: 'd', groups: fields.groups, groupIndex: 0, savedNames: new Set(['phone', 'show_booking', 'opening_hours', 'org_number']),
    savedGroupIds: new Set(['contact', 'legal']), values: fields.values, errors, open: new Set(open), setOpen: () => {},
    pendingFocus: { current: null }, onChange: () => {}, onRemove: () => {}, onMove: () => {},
  });
  const renderDefinition = (...args: Parameters<typeof props>) => renderToString(createElement(GroupDefinition, props(...args)));

  it('lists the fields with their names and types, and the page settings', () => {
    const html = renderDefinition([]);
    expect(html).toContain('value="Contact"');
    expect(html).toContain('value="contact"');
    expect(html).toContain('Editors and administrators');
    expect(html).toContain('phone · Text');
    expect(html).toContain('show_booking · Checkbox (yes / no)');
    expect(html).toContain('opening_hours · Opening hours');
    expect(html).toContain('Add opening hours');
    expect(html).toMatch(/aria-label="Move Phone up"[^>]*disabled=""/);
  });

  it('opens a field to edit it and warns that renaming a saved one deletes its value', () => {
    const html = renderDefinition(['0:0']);
    expect(html).toContain('value="phone"');
    expect(html).toContain('Renaming deletes the saved value under the old name.');
    expect(html).toContain('{{site.fields.phone}}');
  });

  it('shows the validator’s problems on the field they belong to', () => {
    const errors = { general: [], byKey: new Map([['0:1', [{ property: 'label', message: 'Give the field a label' }]]]) };
    const closed = renderDefinition([], errors);
    expect(closed).toContain('Give the field a label');
    expect(closed).toContain('sf-defcard--error');
  });
});

describe('site fields page', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const portal = path.resolve(here, '../..');

  it('is linked from the site sidebar for everyone with access', () => {
    const layout = fs.readFileSync(path.join(portal, 'layouts/AppLayout.astro'), 'utf8');
    const link = layout.indexOf('href={`/app/sites/${siteId}/site-fields`}');
    expect(link).toBeGreaterThan(0);
    // Not inside an admin-only block.
    const before = layout.slice(Math.max(0, link - 200), link);
    expect(before).not.toContain("activePermission === 'admin'");
  });

  it('renders the editor with the server-loaded fields', () => {
    const page = fs.readFileSync(path.join(portal, 'pages/app/sites/[siteId]/site-fields/index.astro'), 'utf8');
    expect(page).toContain('<SiteFieldsEditor client:load');
    expect(page).toContain('vstore.siteFields(');
  });
});
