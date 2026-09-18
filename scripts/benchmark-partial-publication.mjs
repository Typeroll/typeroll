#!/usr/bin/env node
// Measures the real generated build entry point, excluding npm/provider startup.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { publicationBuildHarness } from './lib/publication-build-harness.mjs';

const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const results = [];
for (const blocksPerPage of [1, 40]) {
  const publication = { format: 'typeroll-static-publication', format_version: 2,
    publication_id: 'a'.repeat(64), core_commit: 'a'.repeat(40), site_url: 'https://benchmark.invalid', version_id: 'main',
    site: { name: 'Benchmark' }, settings: { site_name: 'Benchmark', trailing_slash: 'always' },
    pages: Array.from({ length: 50 }, (_, n) => ({ id: `page-${n}`, slug: `page-${n}`, title: `Page ${n}`,
      status: 'published', content_mode: 'blocks', blocks: Array.from({ length: blocksPerPage }, (_, b) => ({
        id: `block-${b}`, type: 'core/prose', data: { html: `<h2>Section ${b}</h2><p>${'A paragraph of representative article text with a <strong>formatted phrase</strong> and an <a href="/page-1/">internal link</a>. '.repeat(5)}</p>` },
      })) })),
    media: [], partials: [], contentTypes: [], pageTemplates: [], blockTypes: [], forms: [],
  };
  const harness = await publicationBuildHarness(publication);
  try {
    await harness.run(true);
    const cacheFile = path.join(harness.destination, '.publication-cache.json');
    const baseline = await fs.readFile(cacheFile);
    publication.pages[0].blocks[0].data.html += '<p>Edited paragraph.</p>';
    const samples = { full: [], partial: [] };
    let expected;
    for (let i = 0; i < 10; i++) {
      for (const mode of i % 2 ? ['partial', 'full'] : ['full', 'partial']) {
        await fs.writeFile(cacheFile, baseline);
        const { report, milliseconds } = await harness.run(mode === 'full');
        assert.equal(report.rendered, mode === 'full' ? 50 : 1);
        assert.equal(report.reused, mode === 'full' ? 0 : 49);
        samples[mode].push(milliseconds);
        const output = await harness.output();
        expected ??= output;
        assert.deepEqual(output, expected);
      }
    }
    const full = median(samples.full), partial = median(samples.partial);
    const result = { pages: 50, blocks_per_page: blocksPerPage, runs_per_mode: 10,
      full_ms: Math.round(full), partial_ms: Math.round(partial), speedup: +(full / partial).toFixed(2),
      reduction_percent: +((1 - partial / full) * 100).toFixed(1), samples };
    results.push(result);
    console.log(JSON.stringify(result));
  } finally { await harness.cleanup(); }
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, results }, null, 2));
