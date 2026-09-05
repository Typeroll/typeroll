import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { MAIN_VERSION_ID, paths } from '@typeroll/shared';
import type { Site, SiteVersion } from '@typeroll/shared';

const ORG = 'orgone';
const SITE = 'mysite';
const BRANCH = 'settings-branch';
let outputDir = '';

describe('materializeFixtures — branch settings', () => {
  beforeEach(async () => {
    makeTmpFixtures();
    await resetDatastore();
    outputDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'typeroll-materialize-settings-'));
  });

  afterEach(async () => {
    if (outputDir) await fs.promises.rm(outputDir, { recursive: true, force: true });
  });

  it('writes the version-aware consent settings consumed by the static builder', async () => {
    const { getStore } = await import('../../lib/datastore');
    const store = getStore();
    await store.setDoc(paths.site(ORG, SITE), {
      name: 'Branch site', created_at: new Date().toISOString(),
    } satisfies Partial<Site>);
    await store.setDoc(paths.version(ORG, SITE, MAIN_VERSION_ID), {
      name: 'Main', kind: 'main', created_at: new Date().toISOString(), robots_blocked: false,
    } satisfies Partial<SiteVersion>);
    await store.setDoc(paths.version(ORG, SITE, BRANCH), {
      name: 'Branch', kind: 'branch', base_version_id: MAIN_VERSION_ID,
      created_at: new Date().toISOString(), robots_blocked: true,
    } satisfies Partial<SiteVersion>);
    await store.setDoc(paths.settings(ORG, SITE, MAIN_VERSION_ID), {
      language: 'en', cookie_consent: { enabled: false, text: 'Main copy' },
    });
    await store.setDoc(paths.settings(ORG, SITE, BRANCH), {
      language: 'en', cookie_consent: { enabled: true, text: 'Branch consent marker' },
    });

    const { materializeFixtures } = await import('../../lib/deploy/runner');
    await materializeFixtures(store, ORG, SITE, BRANCH, outputDir, {
      runtime_version: '0.39.1', protocol_version: 3, installations: [],
    });

    const settingsPath = path.join(outputDir, `${paths.settings(ORG, SITE, BRANCH)}.json`);
    const settings = JSON.parse(await fs.promises.readFile(settingsPath, 'utf8')) as {
      cookie_consent?: { enabled?: boolean; text?: string };
    };
    expect(settings.cookie_consent).toEqual({ enabled: true, text: 'Branch consent marker' });
  });
});
