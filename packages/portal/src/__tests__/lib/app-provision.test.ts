/**
 * App provisioning + composable form actions.
 *
 * The model: an app ships forms, enabling it makes them placeable as blocks,
 * the site extends their fields, and the app owns what happens on submit —
 * with actions composed from core, this app, and any other.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import type { BlockType, Form } from '@typeroll/shared';
import { directoryApp } from '../../lib/apps/directory';
import { appBlockTypeId, appFormId, provisionApp } from '../../lib/apps/provision';

const ORG = 'default';
const SITE = 's1';

const readForm = async (id: string) => {
  const { getStore } = await import('../../lib/datastore');
  return getStore().getDoc<Form>(`${paths.forms(ORG, SITE)}/${id}`);
};
const readBlock = async (id: string) => {
  const { getStore } = await import('../../lib/datastore');
  return getStore().getDoc<BlockType>(paths.blockType(ORG, SITE, id, 'main'));
};

describe('enabling an app installs its surface', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
  });

  it('seeds every form the app ships', async () => {
    const out = await provisionApp(ORG, SITE, directoryApp, true);
    expect(out.forms_created.sort()).toEqual([
      appFormId('directory', 'edit-listing'),
      appFormId('directory', 'request-link'),
    ].sort());
    const edit = await readForm(appFormId('directory', 'edit-listing'));
    expect(edit?.steps?.[0]?.blocks?.length ?? 0).toBeGreaterThan(0);
  });

  it('carries the app-owned target so the site never configures it', async () => {
    await provisionApp(ORG, SITE, directoryApp, true);
    const edit = await readForm(appFormId('directory', 'edit-listing'));
    expect(edit?.target).toEqual({ app: 'directory', hydrate: true, session_param: 't' });
    // The request form is a different endpoint of the SAME app, and needs
    // neither prefill nor a session — there's nothing to prefill from yet.
    const req = await readForm(appFormId('directory', 'request-link'));
    expect(req?.target).toEqual({ app: 'directory', form: 'request-link' });
  });

  it('writes a block per form into the site’s own block_types', async () => {
    // The reason this is boring and works everywhere: the picker, the agent's
    // list_block_types, the renderer, the preview and materialize all already
    // read this collection.
    await provisionApp(ORG, SITE, directoryApp, true);
    const bt = await readBlock(appBlockTypeId('directory', 'edit-listing'));
    expect(bt?.label).toBe('Edit listing');
    expect(bt?.expand_to).toEqual({
      target: 'core/form',
      defaults: { form_id: appFormId('directory', 'edit-listing') },
    });
  });

  it('is idempotent', async () => {
    await provisionApp(ORG, SITE, directoryApp, true);
    const second = await provisionApp(ORG, SITE, directoryApp, true);
    expect(second.forms_created).toEqual([]);
    expect(second.forms_kept).toHaveLength(2);
  });

  it('NEVER overwrites fields the site added', async () => {
    // The whole reason re-enabling is safe. Losing an operator's added fields
    // to a settings toggle would be silent and unrecoverable.
    await provisionApp(ORG, SITE, directoryApp, true);
    const id = appFormId('directory', 'edit-listing');
    const { getStore } = await import('../../lib/datastore');
    const form = (await readForm(id))!;
    form.steps![0]!.blocks!.push({ id: 'extra', type: 'form/text', data: { name: 'phone' } } as never);
    const { id: _drop, ...body } = form;
    await getStore().setDoc(`${paths.forms(ORG, SITE)}/${id}`, body);

    await provisionApp(ORG, SITE, directoryApp, true);
    const after = await readForm(id);
    expect(after?.steps?.[0]?.blocks?.some((b) => b.id === 'extra')).toBe(true);
  });
});

describe('disabling', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
    await provisionApp(ORG, SITE, directoryApp, true);
  });

  it('removes the blocks so they leave the picker', async () => {
    await provisionApp(ORG, SITE, directoryApp, false);
    expect(await readBlock(appBlockTypeId('directory', 'edit-listing'))).toBeNull();
  });

  it('KEEPS the forms — a settings toggle must not delete content', async () => {
    // A form may carry fields the site added and pages that reference it.
    await provisionApp(ORG, SITE, directoryApp, false);
    expect(await readForm(appFormId('directory', 'edit-listing'))).toBeTruthy();
  });
});

describe('form actions compose across sources', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
    const { _resetActionRegistryForTests } = await import('../../lib/forms/actions');
    _resetActionRegistryForTests();
  });

  it('registers core types', async () => {
    const { actionRegistry } = await import('../../lib/forms/actions');
    expect((await actionRegistry()).has('email')).toBe(true);
    expect((await actionRegistry()).get('webhook')).toMatchObject({ admin_only: true });
  });

  it('runs several actions from different owners in one list', async () => {
    const { actionRegistry, runFormActions } = await import('../../lib/forms/actions');
    const seen: string[] = [];
    // Stand in for a Slack app and a directory-owned action.
    (await actionRegistry()).set('slack', { type: 'slack', label: 'Slack', run: async () => { seen.push('slack'); } });
    (await actionRegistry()).set('moderate', { type: 'moderate', label: 'Moderate', run: async () => { seen.push('moderate'); } });

    const res = await runFormActions(
      { actions: [{ type: 'slack', config: {} }, { type: 'moderate', config: {} }] },
      { orgId: ORG, siteId: SITE, data: {} },
    );
    expect(seen).toEqual(['slack', 'moderate']);
    expect(res.ran).toEqual(['slack', 'moderate']);
  });

  it('one failing action does not stop the next', async () => {
    // They have different owners; a broken Slack webhook must not cost you
    // the confirmation email.
    const { actionRegistry, runFormActions } = await import('../../lib/forms/actions');
    const seen: string[] = [];
    (await actionRegistry()).set('boom', { type: 'boom', label: 'x', run: async () => { throw new Error('nope'); } });
    (await actionRegistry()).set('after', { type: 'after', label: 'x', run: async () => { seen.push('after'); } });

    const res = await runFormActions(
      { actions: [{ type: 'boom', config: {} }, { type: 'after', config: {} }] },
      { orgId: ORG, siteId: SITE, data: {} },
    );
    expect(res.failed).toEqual(['boom']);
    expect(seen).toEqual(['after']);
  });

  it('skips an unknown type instead of throwing', async () => {
    // An action whose app was disabled, or one from a newer release.
    const { runFormActions } = await import('../../lib/forms/actions');
    const res = await runFormActions(
      { actions: [{ type: 'from-a-disabled-app', config: {} }] },
      { orgId: ORG, siteId: SITE, data: {} },
    );
    expect(res.ran).toEqual([]);
    expect(res.failed).toEqual([]);
  });

  it('keeps email out of the agent-writable set', async () => {
    // A recipient address a model can set is an exfiltration vector.
    const { agentWritableActionTypes } = await import('../../lib/forms/actions');
    expect(await agentWritableActionTypes()).not.toContain('email');
  });
});

describe('pre-submit hooks', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
    const { _resetActionRegistryForTests } = await import('../../lib/forms/actions');
    _resetActionRegistryForTests();
  });

  it('lets an action veto the submit', async () => {
    const { actionRegistry, runBeforeActions } = await import('../../lib/forms/actions');
    (await actionRegistry()).set('gate', {
      type: 'gate', label: 'Gate',
      before: async () => ({ reject: 'Not accepting submissions right now.' }),
      run: async () => {},
    });
    const res = await runBeforeActions(
      { actions: [{ type: 'gate', config: {} }] },
      { orgId: ORG, siteId: SITE, data: {} },
    );
    expect(res).toEqual({ ok: false, reason: 'Not accepting submissions right now.' });
  });

  it('treats a THROWN before-hook as a rejection, not approval', async () => {
    // The asymmetry that matters: post-submit failures are swallowed because
    // the thing already happened, but a moderation check that crashes must
    // never be read as "approved".
    const { actionRegistry, runBeforeActions } = await import('../../lib/forms/actions');
    (await actionRegistry()).set('crash', {
      type: 'crash', label: 'Crash',
      before: async () => { throw new Error('boom'); },
      run: async () => {},
    });
    const res = await runBeforeActions(
      { actions: [{ type: 'crash', config: {} }] },
      { orgId: ORG, siteId: SITE, data: {} },
    );
    expect(res.ok).toBe(false);
  });

  it('passes when no action declares one', async () => {
    const { runBeforeActions } = await import('../../lib/forms/actions');
    expect(await runBeforeActions(
      { actions: [{ type: 'email', config: {} }] },
      { orgId: ORG, siteId: SITE, data: {} },
    )).toEqual({ ok: true });
  });
});

describe('prefill sources', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
    const { _resetPrefillRegistryForTests } = await import('../../lib/forms/prefill');
    _resetPrefillRegistryForTests();
  });

  const ctx = (query: Record<string, string> = {}) => ({ orgId: ORG, siteId: SITE, query });

  it('fills from the page URL', async () => {
    const { resolvePrefill } = await import('../../lib/forms/prefill');
    const out = await resolvePrefill(
      { prefill: [{ type: 'query', config: {} }] },
      ctx({ plan: 'pro' }), ['plan'],
    );
    expect(out.values).toEqual({ plan: 'pro' });
  });

  it('maps parameter names to different field names', async () => {
    const { resolvePrefill } = await import('../../lib/forms/prefill');
    const out = await resolvePrefill(
      { prefill: [{ type: 'query', config: { map: 'ref=referrer' } }] },
      ctx({ ref: 'newsletter' }), ['referrer'],
    );
    expect(out.values).toEqual({ referrer: 'newsletter' });
  });

  it('drops values for fields the form does not have', async () => {
    // A misconfigured source must not smuggle a value into a field that
    // isn't on the form.
    const { resolvePrefill } = await import('../../lib/forms/prefill');
    const out = await resolvePrefill(
      { prefill: [{ type: 'query', config: {} }] },
      ctx({ admin: 'true' }), ['name'],
    );
    expect(out.values).toEqual({});
  });

  it('composes sources in order, later winning', async () => {
    // So a site can put an app's source first and override single fields.
    const { resolvePrefill } = await import('../../lib/forms/prefill');
    const out = await resolvePrefill(
      {
        prefill: [
          { type: 'constant', config: { values: 'source=default' } },
          { type: 'query', config: {} },
        ],
      },
      ctx({ source: 'from-url' }), ['source'],
    );
    expect(out.values).toEqual({ source: 'from-url' });
  });

  it('degrades rather than failing when a source throws', async () => {
    // A partial prefill still beats an empty form.
    const { prefillRegistry, resolvePrefill } = await import('../../lib/forms/prefill');
    (await prefillRegistry()).set('bad', {
      type: 'bad', label: 'Bad', resolve: async () => { throw new Error('nope'); },
    });
    const out = await resolvePrefill(
      { prefill: [{ type: 'bad', config: {} }, { type: 'constant', config: { values: 'a=1' } }] },
      ctx(), ['a'],
    );
    expect(out.failed).toEqual(['bad']);
    expect(out.values).toEqual({ a: '1' });
  });

  it('picks up sources an app contributes', async () => {
    const { prefillRegistry } = await import('../../lib/forms/prefill');
    expect((await prefillRegistry()).has('directory/listing')).toBe(true);
  });
});

describe('saving actions the registry knows', () => {
  it('accepts an app-contributed type', async () => {
    // Before this, the editor could add an action that saving then deleted.
    const { validateEmailActions } = await import('../../lib/forms-admin');
    const out = validateEmailActions(
      [{ type: 'directory/moderate', config: { queue: 'new' } }],
      ['email', 'directory/moderate'],
    );
    expect(Array.isArray(out)).toBe(true);
    expect((out as Array<{ type: string }>)[0].type).toBe('directory/moderate');
  });

  it('still refuses a type the registry does not know', async () => {
    const { validateEmailActions } = await import('../../lib/forms-admin');
    expect(typeof validateEmailActions([{ type: 'typo', config: {} }], ['email'])).toBe('string');
  });

  it('still validates email config properly', async () => {
    const { validateEmailActions } = await import('../../lib/forms-admin');
    expect(typeof validateEmailActions([{ type: 'email', config: {} }], ['email'])).toBe('string');
  });
});
