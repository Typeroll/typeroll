// Pure helpers behind the Packages page (import and export) and the block
// template list. The components are covered in packages-ui.test.ts.

import { describe, expect, it } from 'vitest';
import {
  actionLabel, choosableEntries, countLines, designLines, importBlockers, importOptions, onlyFromSelection, packageApiError,
  packageFileProblem, packageFormData, planGroups, publisherLine, reportCounts, reportSections, signatureNotice,
} from '../../components/package-import-model';
import {
  downloadFilename, exportBody, exportProblems, fontGroups, initialExportDraft, packageSlug, sectionChoice, withName,
} from '../../components/package-export-model';
import { groupBlockTemplates, importedFromLabel, templateKindLabel } from '../../components/block-template-model';
import { exportable, inspected } from './package-fixtures';

describe('the package file', () => {
  it('takes only .typeroll files within the size limit', () => {
    expect(packageFileProblem(null)).toBe('Choose a .typeroll file.');
    expect(packageFileProblem({ name: 'pack.zip', size: 10 })).toContain('ending in .typeroll');
    expect(packageFileProblem({ name: 'pack.typeroll', size: 0 })).toBe('The file is empty.');
    expect(packageFileProblem({ name: 'pack.typeroll', size: 300 * 1024 * 1024 })).toContain('at most 200.0 MB');
    expect(packageFileProblem({ name: 'Pack.TYPEROLL', size: 10 })).toBeNull();
  });

  it('sends the file and the options as a JSON string', async () => {
    const data = packageFormData(new File(['zip'], 'pack.typeroll'), { design: 'full', fonts: true, only: ['block_templates.hero'] });
    expect((data.get('file') as File).name).toBe('pack.typeroll');
    expect(JSON.parse(String(data.get('options')))).toEqual({ design: 'full', fonts: true, only: ['block_templates.hero'] });
  });

  it('sends fonts only with the whole look, and the licence confirmation only when given', () => {
    expect(importOptions({ design: 'content', includeFonts: true })).toEqual({ design: 'content' });
    expect(importOptions({ design: 'full', includeFonts: false })).toEqual({ design: 'full', fonts: false });
    expect(importOptions({ design: 'full', includeFonts: true, fontLicenceConfirmed: true, only: ['pages.home'] }))
      .toEqual({ design: 'full', fonts: true, only: ['pages.home'], font_licence_confirmed: true });
  });
});

describe('the signature', () => {
  it('names the trusted publisher of a verified package', () => {
    const notice = signatureNotice({ status: 'verified', publisher: 'Typeroll' });
    expect(notice).toMatchObject({ tone: 'ok', label: 'Verified', blocks: false });
    expect(notice.text).toContain('Signed by Typeroll, a trusted publisher');
    expect(publisherLine(inspected({ signature: { status: 'verified', publisher: 'Typeroll' } }))).toBe('Typeroll');
  });

  it('marks the claimed author of an unsigned or unknown-key package as not verified', () => {
    expect(signatureNotice({ status: 'unsigned' }, { name: 'Acme Studio' }).text).toContain('It says it comes from Acme Studio, but that is not verified.');
    expect(signatureNotice({ status: 'unknown_key' }).label).toBe('Unknown key');
    expect(publisherLine(inspected())).toBe('Acme Studio (not verified)');
  });

  it('blocks a package with an invalid signature', () => {
    expect(signatureNotice({ status: 'invalid' })).toMatchObject({ tone: 'danger', blocks: true });
    expect(importBlockers({ result: inspected({ signature: { status: 'invalid' } }), isAdmin: true, fontLicenceConfirmed: false }))
      .toEqual(['The signature is invalid, so the package can’t be imported.']);
  });
});

describe('the plan', () => {
  it('counts the contents', () => {
    expect(countLines(inspected().package.counts)).toEqual(['2 block templates', '1 page template', '1 global block', '1 block type', '3 styles', '4 media files']);
  });

  it('groups entries by kind with what happens to each style: create, reuse, rename to a new id', () => {
    const groups = planGroups(inspected().plan);
    expect(groups.map(group => group.label)).toEqual(['Block templates', 'Page templates', 'Global blocks', 'Site fields', 'Block types', 'Styles']);
    const styles = groups.find(group => group.section === 'styles')!.rows;
    expect(styles.map(row => row.actionLabel)).toEqual(['Create', 'Reuse existing', 'Rename → hero-2']);
    expect(styles[1].detail).toBe('The site already has an identical style.');
    expect(styles[2]).toMatchObject({ name: 'Hero (imported)', id: 'hero' });
    expect(styles[2].detail).toContain('different style with this id');
    expect(actionLabel('replace', 'body')).toBe('Replace');
    expect(groups.find(group => group.section === 'site_field_groups')!.rows[0]).toMatchObject({ actionLabel: 'Skip', name: 'contact' });
  });

  it('names headers and footers among the global blocks', () => {
    const plan = { ...inspected().plan, global_blocks: [{ action: 'create' as const, from: 'header', to: 'header', name: 'Top', kind: 'header' as const }] };
    expect(planGroups(plan).find(group => group.section === 'global_blocks')!.rows[0].name).toBe('Top (Header)');
  });

  it('lists the design settings a whole-look import replaces', () => {
    expect(designLines({ colors: {}, typography: {}, fonts: { heading: 'Inter' }, font_services: [] })).toEqual(['Colours', 'Typography', 'Font roles']);
    expect(designLines(null)).toEqual([]);
  });
});

describe('choosing entries', () => {
  const entries = choosableEntries(inspected().plan);

  it('offers content entries, not the styles and block types that follow them; site fields as site_fields.<id>', () => {
    expect(entries.map(entry => entry.key)).toEqual([
      'block_templates.hero', 'block_templates.pricing', 'page_templates.landing', 'global_blocks.cta', 'site_fields.contact',
    ]);
  });

  it('sends only when something is left out', () => {
    expect(onlyFromSelection(entries, new Set(entries.map(entry => entry.key)))).toBeUndefined();
    expect(onlyFromSelection(entries, new Set(['block_templates.hero', 'site_fields.contact']))).toEqual(['block_templates.hero', 'site_fields.contact']);
    expect(onlyFromSelection(entries, new Set())).toEqual([]);
    expect(importBlockers({ result: inspected(), isAdmin: true, fontLicenceConfirmed: false, only: [] })).toEqual(['Choose at least one entry.']);
  });

  it('needs an admin for the whole look and the font licence when fonts come', () => {
    const result = inspected({ needs: { admin: true, font_licence: true } });
    expect(importBlockers({ result, isAdmin: false, fontLicenceConfirmed: false })).toEqual([
      'This import changes the site’s look; only an administrator or builder can import it.', 'Confirm the font licence first.',
    ]);
    expect(importBlockers({ result, isAdmin: true, fontLicenceConfirmed: true })).toEqual([]);
  });
});

describe('errors and the report', () => {
  it('shows the API error with its validation details', () => {
    expect(packageApiError({ error: 'The package is not valid', code: 'invalid_package', details: ['style hero: invalid id', { path: 'media.m1', message: 'missing from integrity' }] }, 422, 'Reading'))
      .toEqual({ message: 'The package is not valid', details: ['style hero: invalid id', 'media.m1: missing from integrity'] });
    expect(packageApiError(null, 413, 'Reading').message).toBe('The file is too large.');
    expect(packageApiError(null, 500, 'The import').message).toBe('The import failed (500).');
  });

  it('links each kind of imported entry to where it is managed', () => {
    const report = {
      created: { block_templates: ['hero'], styles: [{ from: 'card', to: 'card', name: 'Card' }], global_blocks: ['cta'], media: 4 },
      reused: { styles: ['lead'] },
      renamed: { block_templates: { pricing: 'pricing-2' }, styles: [{ from: 'hero', to: 'hero-2', name: 'Hero (imported)' }] },
      warnings: [],
    };
    const sections = reportSections(report, 'site-1');
    expect(sections.map(section => [section.label, section.href])).toEqual([
      ['Block templates', '/app/sites/site-1/partials#block-templates'],
      ['Global blocks', '/app/sites/site-1/partials'],
      ['Styles', '/app/sites/site-1/styles'],
      ['Media files', '/app/sites/site-1/media'],
    ]);
    expect(sections[0].renamed).toEqual([{ label: 'pricing-2 (was pricing)', href: '/app/sites/site-1/partials#block-templates' }]);
    expect(sections[1].created).toEqual([{ label: 'cta', href: '/app/sites/site-1/partials/cta' }]);
    expect(reportCounts(sections[2], report)).toBe('1 created, 1 reused, 1 renamed');
    expect(reportCounts(sections[3], report)).toBe('4 created');
  });
});

describe('the export', () => {
  it('derives the id from the name until it is typed', () => {
    expect(packageSlug('Café Sections — Spring 2027!')).toBe('cafe-sections-spring-2027');
    const draft = initialExportDraft(exportable, 'sv');
    const named = withName(draft.meta, 'Acme Sections');
    expect(named.id).toBe('acme-sections');
    expect(withName({ ...named, id: 'mine', idEdited: true }, 'Other').id).toBe('mine');
    expect(draft.meta.version).toBe('1.0.0');
    expect(draft.meta.languages).toBe('sv');
    expect(draft.demoMedia).toEqual(['m1']);
  });

  it('sends all when every entry of a section is chosen', () => {
    expect(sectionChoice([], exportable.block_templates)).toBeUndefined();
    expect(sectionChoice(['quote'], exportable.block_templates)).toEqual(['quote']);
    expect(sectionChoice(['quote', 'hero'], exportable.block_templates)).toBe('all');
    expect(sectionChoice(['gone'], exportable.block_templates)).toBeUndefined();
  });

  it('groups fonts by source', () => {
    expect(fontGroups(exportable.font_families)).toEqual({ upload: ['Acme', 'Brand Serif'], catalog: ['Inter'], service: ['Proxima Nova'] });
  });

  it('checks the details, the entries and the font licence', () => {
    const draft = initialExportDraft(exportable);
    expect(exportProblems(draft, exportable, false)).toMatchObject({ name: expect.any(String), id: expect.any(String), entries: 'Choose at least one entry to export.' });
    const ready = { ...draft, chosen: { ...draft.chosen, block_templates: ['hero'] }, meta: withName(draft.meta, 'Acme') };
    expect(exportProblems(ready, exportable, false)).toEqual({});
    expect(exportProblems({ ...ready, meta: { ...ready.meta, authorUrl: 'acme.example', languages: 'en, English' } }, exportable, false))
      .toEqual({ authorUrl: 'Enter a web address starting with https://.', languages: '“English” is not a language code such as en or sv.' });
    expect(exportProblems({ ...ready, design: true, fonts: ['Acme'] }, exportable, false).fonts).toContain('Confirm that the licence allows');
    expect(exportProblems({ ...ready, kind: 'site' }, exportable, false).kind).toBe('Only a site admin can export the whole site.');
    expect(exportProblems({ ...ready, kind: 'site' }, exportable, true)).toEqual({});
  });

  it('builds the export body of a collection', () => {
    const draft = initialExportDraft(exportable);
    const body = exportBody({
      ...draft, chosen: { block_templates: ['hero', 'quote'], page_templates: [], global_blocks: ['cta'], block_types: [] },
      styles: 'all', design: true, fonts: ['Acme'], fontsConfirmed: true, demoMedia: ['m1', 'gone'],
      meta: { ...withName(draft.meta, 'Acme Sections'), description: ' Heroes ', authorName: 'Acme Studio', authorUrl: 'https://acme.example', licenceName: 'CC BY 4.0', licenceUrl: '', languages: 'en, sv' },
    }, exportable);
    expect(body).toEqual({
      selection: { kind: 'collection', block_templates: 'all', global_blocks: 'all', styles: 'all', design: true, fonts: { families: ['Acme'], redistributable_confirmed: true }, demo_media: ['m1'] },
      meta: { id: 'acme-sections', name: 'Acme Sections', version: '1.0.0', description: 'Heroes', author: { name: 'Acme Studio', url: 'https://acme.example' }, licence: { name: 'CC BY 4.0' }, languages: ['en', 'sv'] },
    });
  });

  it('leaves fonts out of a collection without its design, and exports the whole site with its design', () => {
    const draft = { ...initialExportDraft(exportable), fonts: ['Acme'], fontsConfirmed: true, meta: withName(initialExportDraft(null).meta, 'Site') };
    expect(exportBody(draft, exportable).selection.fonts).toBeUndefined();
    expect(exportBody({ ...draft, kind: 'site' }, exportable).selection).toEqual({ kind: 'site', styles: 'all', design: true, fonts: { families: ['Acme'], redistributable_confirmed: true }, demo_media: ['m1'] });
  });

  it('names the download from Content-Disposition, else from the id and version', () => {
    const meta = { id: 'acme', version: '1.2.0' };
    expect(downloadFilename('attachment; filename="acme-1.2.0.typeroll"', meta)).toBe('acme-1.2.0.typeroll');
    expect(downloadFilename("attachment; filename*=UTF-8''caf%C3%A9.typeroll", meta)).toBe('café.typeroll');
    expect(downloadFilename('attachment; filename="../../etc/passwd"', meta)).toBe('_.._etc_passwd');
    expect(downloadFilename(null, meta)).toBe('acme-1.2.0.typeroll');
  });
});

describe('block templates', () => {
  it('labels kind and origin', () => {
    expect(templateKindLabel({ kind: 'section' })).toBe('Section');
    expect(templateKindLabel({ kind: 'block' })).toBe('Block');
    expect(templateKindLabel({})).toBeNull();
    expect(importedFromLabel({ imported_from: { package_id: 'acme', package_name: 'Acme Sections', version: '1.2.0', imported_at: '2026-11-07T10:00:00.000Z' } })).toBe('From Acme Sections 1.2.0');
    expect(importedFromLabel({})).toBeNull();
  });

  it('groups by category, uncategorized last', () => {
    const groups = groupBlockTemplates([{ name: 'Zed' }, { name: 'Pricing B', category: 'Pricing' }, { name: 'Hero', category: 'Heroes' }, { name: 'Pricing A', category: ' Pricing ' }]);
    expect(groups.map(group => [group.category, group.templates.map(t => t.name)])).toEqual([
      ['Heroes', ['Hero']], ['Pricing', ['Pricing A', 'Pricing B']], [null, ['Zed']],
    ]);
  });
});

describe('import report from the route', () => {
  it('groups renamed entries by kind and lists them once', async () => {
    const { reportSections, reportCounts } = await import('../../components/package-import-model');
    const report = { created: { block_templates: ['hero-2', 'plain'] }, reused: { styles: ['lead'] }, renamed: [{ section: 'block_templates', from: 'hero', to: 'hero-2' }] };
    const sections = reportSections(report, 's1');
    const templates = sections.find(section => section.section === 'block_templates')!;
    expect(templates.created.map(item => item.label)).toEqual(['plain']);
    expect(templates.renamed.map(item => item.label)).toEqual(['hero-2 (was hero)']);
    expect(reportCounts(templates, report)).toBe('1 created, 1 renamed');
  });
});
