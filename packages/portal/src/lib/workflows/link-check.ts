// LINK_CHECK workflow.
//
// Scans every published page for outbound and internal links, then verifies
// each one with a HEAD request. Reports broken links with their location so
// the customer (or AI) can fix them.

import { paths , MAIN_VERSION_ID } from '@typeroll/shared';
import { vstore } from '../version-store';
import type { Page, Site } from '@typeroll/shared';
import { type WorkflowDef } from './types';

interface BrokenLink {
  page_id: string;
  page_title: string;
  url: string;
  status: number | 'error';
  text?: string;
}

export const linkCheckWorkflow: WorkflowDef = {
  type: 'link_check',
  label: 'Link checker',
  description: 'Verify every internal and external link on the site.',
  steps: [
    {
      name: 'extract_links',
      label: 'Extract links from pages',
      async run(ctx) {
        const pages = await vstore.pages(ctx.orgId, ctx.siteId, MAIN_VERSION_ID);
        const published = pages.filter((p) => p.status === 'published');
        const site = await ctx.store.getDoc<Site>(paths.site(ctx.orgId, ctx.siteId));
        const origin = site?.domain ? `https://${site.domain}` : null;
        const links: Array<{ page_id: string; page_title: string; url: string; text: string }> = [];
        for (const p of published) {
          const html = p.html_content ?? '';
          for (const m of html.matchAll(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
            let url = m[1];
            if (url.startsWith('/') && origin) url = `${origin}${url}`;
            if (url.startsWith('mailto:') || url.startsWith('tel:') || url.startsWith('#')) continue;
            links.push({ page_id: p.id, page_title: p.title, url, text: stripTags(m[2]).slice(0, 80) });
          }
        }
        ctx.log(`Extracted ${links.length} links from ${published.length} pages`);
        return { state: { links } };
      },
    },

    {
      name: 'verify_links',
      label: 'Check each link',
      async run(ctx) {
        const links = ctx.state.links as Array<{ page_id: string; page_title: string; url: string; text: string }>;
        const broken: BrokenLink[] = [];
        const concurrency = 8;
        let cursor = 0;

        const worker = async () => {
          while (true) {
            const i = cursor++;
            if (i >= links.length) return;
            const link = links[i];
            try {
              const res = await fetch(link.url, {
                method: 'HEAD',
                redirect: 'follow',
                signal: AbortSignal.timeout(10_000),
              });
              if (!res.ok) {
                broken.push({ page_id: link.page_id, page_title: link.page_title, url: link.url, status: res.status, text: link.text });
              }
            } catch {
              broken.push({ page_id: link.page_id, page_title: link.page_title, url: link.url, status: 'error', text: link.text });
            }
            if ((i + 1) % 25 === 0) {
              ctx.setProgress({ total: links.length, completed: i + 1, error: broken.length });
              ctx.log(`Checked ${i + 1}/${links.length}; ${broken.length} broken`);
            }
          }
        };
        await Promise.all(Array.from({ length: concurrency }, () => worker()));
        ctx.log(`${broken.length} broken link(s) out of ${links.length}`);
        return { results: { broken_links: broken, total_links: links.length } };
      },
    },
  ],
};

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').trim();
}
