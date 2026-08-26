// Customer content export — the anti-lock-in feature. Zips the site's full
// content tree (settings, pages, partials, collections + items, forms,
// redirects, block types, page templates, media docs) as JSON files in the
// exact fixtures layout the OSS site-template builds from: an exported zip
// unpacked into a fixtures dir IS a working local site.
//
// The snapshot comes from materializeFixtures — the same chain-resolved
// write path deploys use — so branch exports inherit main's non-overridden
// docs and the export can never drift from what a deploy would ship.
//
// Media BINARIES are not included (they live on the CDN); the media docs in
// the zip carry every cdn_url + variant URL, listed flat in the manifest so
// a mirror script is a one-liner per file.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { paths } from '@typeroll/shared';
import type { Media } from '@typeroll/shared';
import { getStore } from './datastore';
import { materializeFixtures } from './deploy/runner';

export const EXPORT_FORMAT_VERSION = 1;

export interface ContentExport {
  zip: Buffer;
  filename: string;
}

async function walkFiles(dir: string, base: string, out: string[] = []): Promise<string[]> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkFiles(full, base, out);
    else out.push(path.relative(base, full));
  }
  return out;
}

export async function buildContentExport(
  orgId: string,
  siteId: string,
  versionId: string,
): Promise<ContentExport> {
  const store = getStore();
  const tmpBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), `tr-export-${siteId}-`));
  try {
    const fixturesDir = path.join(tmpBase, 'fixtures');
    await materializeFixtures(store, orgId, siteId, versionId, fixturesDir);

    const zip = new JSZip();
    for (const rel of await walkFiles(fixturesDir, fixturesDir)) {
      // Zip entries use forward slashes regardless of host OS.
      zip.file(rel.split(path.sep).join('/'), await fs.promises.readFile(path.join(fixturesDir, rel)));
    }

    // Flat media URL list — everything a mirror script needs to also pull
    // the binaries. Best-effort: an unreadable media collection never
    // blocks a content export.
    let mediaUrls: string[] = [];
    try {
      const media = await store.listDocs<Media>(paths.media(orgId, siteId));
      mediaUrls = media.flatMap((m) => [
        ...(m.cdn_url ? [m.cdn_url] : []),
        ...(m.variants ?? []).map((v) => v.cdn_url).filter((u): u is string => !!u),
      ]);
    } catch {
      /* media listing is optional */
    }

    zip.file(
      'export-manifest.json',
      JSON.stringify(
        {
          format: 'typeroll-content-export',
          format_version: EXPORT_FORMAT_VERSION,
          site_id: siteId,
          version_id: versionId,
          exported_at: new Date().toISOString(),
          notes: [
            'The fixtures tree in this zip is the exact layout the Typeroll site-template builds from: point TYPEROLL_FIXTURES_DIR at the unpacked directory for a working local site.',
            'Media binaries are not included; media_urls lists every original + variant CDN URL for mirroring.',
          ],
          media_urls: mediaUrls,
        },
        null,
        2,
      ),
    );

    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const stamp = new Date().toISOString().slice(0, 10);
    return { zip: buf, filename: `${siteId}-content-${stamp}.zip` };
  } finally {
    await fs.promises.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
  }
}
