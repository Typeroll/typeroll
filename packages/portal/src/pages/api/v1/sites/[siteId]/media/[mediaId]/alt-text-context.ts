// GET /api/v1/sites/{siteId}/media/{mediaId}/alt-text-context
//
// Returns everything an agent needs to generate good alt-text WITHOUT us
// actually doing the vision call. The agent has its own Claude vision
// capability; this endpoint provides:
//
//   - image_url           the CDN URL of the image
//   - suggested_prompt    a prompt the agent passes to vision, tuned for
//                         SEO + accessibility-grade alt-text
//   - language            the site's content language (defaults to "en")
//                         so the agent writes alt-text in the right
//                         language rather than its default
//   - used_on_pages       pages that reference this CDN URL, with the
//                         heading nearest the image so vision has context
//                         ("hero of /pricing" vs. "thumbnail in /blog/foo")
//   - filename, current_alt_text
//
// The "agent does the actual generation" split keeps the platform out of
// the AI roundtrip business — same architectural rule as the rest of the
// MCP surface.

import type { APIRoute } from 'astro';
import { apiError, apiResponse, requireApiKey } from '../../../../../../../lib/api-auth';
import { getStore } from '../../../../../../../lib/datastore';
import { vstore } from '../../../../../../../lib/version-store';
import { paths } from '@typeroll/shared';
import type { Media, Page, SiteSettings } from '@typeroll/shared';

interface PageUsage {
  page_id: string;
  title: string;
  slug: string;
  nearest_heading?: string;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Minimal BCP-47 → English language name lookup for the most common
 * site languages, so the alt-text prompt reads naturally ("Write in
 * Swedish" not "Write in sv-SE"). Unknown tags fall through verbatim
 * — the LLM understands plain tags too.
 */
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', sv: 'Swedish', no: 'Norwegian', nb: 'Norwegian',
  da: 'Danish', fi: 'Finnish', de: 'German', fr: 'French',
  es: 'Spanish', it: 'Italian', pt: 'Portuguese', nl: 'Dutch',
  pl: 'Polish', ru: 'Russian', ja: 'Japanese', zh: 'Chinese',
  ko: 'Korean', ar: 'Arabic', he: 'Hebrew', tr: 'Turkish',
};
function bcpToName(tag: string): string {
  const primary = tag.toLowerCase().split('-')[0]!;
  return LANGUAGE_NAMES[primary] ?? tag;
}

/**
 * Find the heading text nearest to the first occurrence of `cdnUrl` in the
 * page body. The vision-side prompt does much better when it knows "this
 * is the hero of a pricing page" vs. just "this is an image."
 */
function findNearestHeading(html: string, cdnUrl: string): string | undefined {
  const idx = html.indexOf(cdnUrl);
  if (idx < 0) return undefined;
  // Scan backwards from the image position for the most recent heading.
  const before = html.slice(0, idx);
  const headingRe = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let last: string | undefined;
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(before)) !== null) {
    // Strip inner tags from heading text.
    last = m[2]!.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  }
  return last && last.length > 0 ? last.slice(0, 120) : undefined;
}

function buildPrompt(args: {
  siteName: string;
  language: string;
  usedOn: PageUsage[];
  brandTone?: string;
}): string {
  const lines: string[] = [];
  lines.push(`Generate alt-text for this image to be used on the website "${args.siteName}".`);
  lines.push('');
  lines.push('Requirements:');
  lines.push(`- Write in ${args.language}.`);
  lines.push('- 5-15 words, sentence case, no trailing period.');
  lines.push('- Describe what is in the image, not what it represents or means.');
  lines.push('- Skip phrases like "image of", "picture of", "photo showing" — screen readers add that.');
  lines.push('- Include text that appears in the image if it\'s legible and load-bearing.');
  lines.push('- Decorative images (purely visual, no information) → return empty string.');
  if (args.usedOn.length > 0) {
    lines.push('');
    lines.push('Context — this image appears on:');
    for (const u of args.usedOn.slice(0, 3)) {
      const heading = u.nearest_heading ? ` (near heading: "${u.nearest_heading}")` : '';
      lines.push(`  - /${u.slug}: ${u.title}${heading}`);
    }
    lines.push('');
    lines.push('Let that context inform what aspect of the image matters most.');
  }
  if (args.brandTone) {
    lines.push('');
    lines.push(`Site voice: ${args.brandTone}.`);
  }
  lines.push('');
  lines.push('Return ONLY the alt-text string. No preamble, no quotes.');
  return lines.join('\n');
}

export const GET: APIRoute = async ({ request, params }) => {
  const guard = await requireApiKey(request, params.siteId);
  if (!guard.ok) return guard.response;
  const ctx = guard.value;
  const mediaId = params.mediaId;
  if (!mediaId) return apiError('Missing mediaId');

  const store = getStore();
  const media = await store.getDoc<Media>(`${paths.media(ctx.orgId, ctx.siteId)}/${mediaId}`);
  if (!media) return apiError('Not found', 404);

  const settings = (await vstore.settings(ctx.orgId, ctx.siteId, ctx.versionId)) ?? {} as SiteSettings;
  // Language precedence: typed Site.language → legacy settings.language
  // (untyped extension that pre-existed the Site.language field) →
  // English as the conservative default. BCP-47 tag is what we store;
  // the prompt verbalises it as a language name for vision (e.g.
  // "sv" → "Swedish") via a tiny lookup.
  const siteLang = (ctx.site as { language?: string }).language;
  const settingsRaw = settings as unknown as Record<string, unknown>;
  const settingsLang = typeof settingsRaw.language === 'string' ? settingsRaw.language : undefined;
  const language = bcpToName(siteLang ?? settingsLang ?? 'en');
  const brandTone = (settings as { tagline?: string }).tagline;

  // Find pages that reference this image so we can pass the use-site
  // context to the prompt. Cheap regex scan over page bodies; same
  // pattern as lib/partials-usage.
  const pages = await vstore.pages(ctx.orgId, ctx.siteId, ctx.versionId);
  const usedOn: PageUsage[] = [];
  const cdnEscape = escapeRegex(media.cdn_url);
  const re = new RegExp(cdnEscape, 'i');
  for (const p of pages) {
    const html = typeof p.html_content === 'string' ? p.html_content : '';
    if (!re.test(html)) continue;
    usedOn.push({
      page_id: p.id,
      title: p.title,
      slug: p.slug,
      nearest_heading: findNearestHeading(html, media.cdn_url),
    });
  }

  const suggested_prompt = buildPrompt({
    siteName: ctx.site.name,
    language,
    usedOn,
    brandTone,
  });

  return apiResponse(ctx, {
    media_id: mediaId,
    image_url: media.cdn_url,
    filename: media.filename,
    current_alt_text: media.alt_text ?? null,
    language,
    used_on_pages: usedOn,
    suggested_prompt,
    next_step: 'Pass image_url + suggested_prompt to your vision model, then call update_media to save the result.',
  });
};
