import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const hostPage = path.resolve(
  here,
  '../../pages/app/sites/[siteId]/extensions/[installationId]/[pageId].astro',
);

describe('Extension admin host', () => {
  it('uses the canonical signed-token issuer for the launch form', () => {
    const source = fs.readFileSync(hostPage, 'utf8');
    expect(source).toContain("import { extensionIssuer, issueExtensionLaunchGrant }");
    expect(source).toContain('value={extensionIssuer()}');
    expect(source).not.toContain('process.env.PORTAL_PUBLIC_URL ?? Astro.url.origin');
  });
});
