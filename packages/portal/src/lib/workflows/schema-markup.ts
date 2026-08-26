// SCHEMA_MARKUP workflow.
//
// For each published page, determine the appropriate schema.org type and
// generate JSON-LD. The result is written into the page's json_ld field,
// which the renderer drops into a <script type="application/ld+json"> tag.

import { paths , MAIN_VERSION_ID } from '@typeroll/shared';
import { vstore } from '../version-store';
import type { Page, SiteSettings } from '@typeroll/shared';
import { type WorkflowDef } from './types';
import { generateJson } from '../ai/claude';

interface SchemaProposal {
  page_id: string;
  type: string;
  json_ld: Record<string, unknown>;
}

export const schemaMarkupWorkflow: WorkflowDef = {
  type: 'schema_markup',
  label: 'Schema markup',
  description: 'Generate JSON-LD structured data for every published page.',
  steps: [
    {
      name: 'analyze_and_generate',
      label: 'Analyze + generate JSON-LD',
      async run(ctx) {
        const pages = await vstore.pages(ctx.orgId, ctx.siteId, MAIN_VERSION_ID);
        const published = pages.filter((p) => p.status === 'published');
        const settings = await vstore.settings(ctx.orgId, ctx.siteId, MAIN_VERSION_ID);
        ctx.log(`Analyzing ${published.length} pages`);

        const proposals: SchemaProposal[] = [];
        for (let i = 0; i < published.length; i++) {
          const p = published[i];
          ctx.setProgress({ total: published.length, completed: i });

          let proposal: SchemaProposal;
          try {
            const result = await generateJson<{ type: string; json_ld: Record<string, unknown> }>(
              ctx.orgId,
              `You generate schema.org JSON-LD for individual web pages. Pick the single most appropriate type (Organization, LocalBusiness, Service, Article, FAQPage, Person, etc.) and produce a minimal but accurate JSON-LD object.`,
              `Site name: ${settings?.site_name ?? ''}
Page title: ${p.title}
Page URL: /${p.slug}
Body excerpt:
${stripTags(p.html_content ?? '').slice(0, 800)}

Return { "type": "<schema-type>", "json_ld": <object> }`
            );
            proposal = { page_id: p.id, ...result };
          } catch (e) {
            ctx.log(`Skipped ${p.title}: ${e instanceof Error ? e.message : e}`);
            continue;
          }

          proposals.push(proposal);
          // Write into the page so the renderer picks it up automatically.
          await ctx.store.updateDoc(paths.page(ctx.orgId, ctx.siteId, p.id), {
            json_ld: JSON.stringify(proposal.json_ld),
            date_updated: new Date().toISOString(),
          });
        }

        ctx.log(`Generated schema for ${proposals.length} pages`);
        return { results: { proposals } };
      },
    },
  ],
};

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
