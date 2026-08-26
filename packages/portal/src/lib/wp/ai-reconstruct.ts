// AI page reconstruction.
//
// The flow: rather than dumping cleaned WP HTML directly into the new site
// (which carries the old layout assumptions), we feed Claude:
//   1. A "design context" — the target site's existing pages, partials, and
//      settings. These show the visual style the migrated pages should match.
//   2. The source content — title, body HTML (already cleaned via
//      cleanWordPressHtml), featured image, custom fields, scraped HTML if
//      available.
// Claude produces new HTML in the target site's style, preserving every
// piece of content from the source (text, headings, images, tables, lists).
//
// When the platform Anthropic key is missing we fall back to the cleaned
// source HTML — the migration still completes, the result just isn't
// re-styled.

import Anthropic from '@anthropic-ai/sdk';

const MODEL_ID = 'claude-sonnet-4-6';
const MAX_OUTPUT_TOKENS = 8192;

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (cachedClient) return cachedClient;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  cachedClient = new Anthropic({ apiKey: key });
  return cachedClient;
}

export interface DesignContext {
  site_name: string;
  tagline?: string;
  colors: Record<string, string>;
  fonts: { heading: string; body: string };
  /** Example page bodies from the target site. The AI uses these as style references. */
  example_pages: Array<{ title: string; html: string }>;
}

export interface SourcePage {
  title: string;
  slug: string;
  url: string;
  /** Cleaned HTML body from WP REST (with image URLs already rewritten to the new CDN). */
  cleaned_html: string;
  /** Featured image URL (CDN, post-rewrite) + alt, when one exists. */
  featured_image?: { url: string; alt: string };
  /** Anything from acf / meta / scraped extras, free-form. */
  extras?: Record<string, unknown>;
  /** Excerpt / description for the AI to use as a brief. */
  excerpt?: string;
}

export interface ReconstructResult {
  html: string;
  used_ai: boolean;
  /** Filled when the AI explicitly couldn't / fell back to source. */
  notes?: string;
}

export function isAIReconstructAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Reconstruct a single page in the target site's design.
 * Falls back to the cleaned source HTML when AI isn't configured.
 */
export async function reconstructPage(
  design: DesignContext,
  source: SourcePage
): Promise<ReconstructResult> {
  const client = getClient();
  if (!client) {
    return {
      html: buildFallbackHtml(source),
      used_ai: false,
      notes: 'ANTHROPIC_API_KEY not configured — source HTML kept as-is.',
    };
  }

  const system = buildSystemPrompt(design);
  const user = buildUserPrompt(source);

  try {
    const response = await client.messages.create({
      model: MODEL_ID,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      messages: [{ role: 'user', content: user }],
    });

    const text = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
      .trim();

    const html = stripCodeFences(text);
    if (!html || !looksLikeHtml(html)) {
      return {
        html: buildFallbackHtml(source),
        used_ai: false,
        notes: `Model returned non-HTML output; kept source. First 100 chars: ${text.slice(0, 100)}`,
      };
    }
    return { html, used_ai: true };
  } catch (e) {
    return {
      html: buildFallbackHtml(source),
      used_ai: false,
      notes: `AI call failed; kept source. ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ─── Prompt construction ─────────────────────────────────────────────────

function buildSystemPrompt(design: DesignContext): string {
  const examples = design.example_pages
    .slice(0, 3)
    .map(
      (p, i) =>
        `## Example ${i + 1}: "${p.title}"\n\`\`\`html\n${truncateHtml(p.html, 2500)}\n\`\`\``
    )
    .join('\n\n');

  return `You are migrating pages from an old WordPress site to a new Typeroll site. Your job: rewrite each page's HTML to match the new site's design while preserving every piece of content (text, headings, images, tables, lists, links, videos) from the source.

# The new site

Site name: ${design.site_name}
${design.tagline ? `Tagline: ${design.tagline}\n` : ''}Primary color: ${design.colors.primary ?? '—'}, accent: ${design.colors.accent ?? '—'}
Heading font: ${design.fonts.heading}, body font: ${design.fonts.body}

CSS variables you can use in inline styles:
- Colors: var(--color-primary), var(--color-secondary), var(--color-accent),
  var(--color-background), var(--color-surface), var(--color-text), var(--color-text-light)
- Spacing: var(--spacing-xs), var(--spacing-sm), var(--spacing-md), var(--spacing-lg), var(--spacing-xl)
- Radius: var(--radius-sm), var(--radius-md), var(--radius-lg)

# Design references (target site)

These are pages already on the new site. They show the desired visual style. Match this style — same kind of sections, same spacing/rhythm, same use of inline styles. Do NOT copy the *content* of these examples; only adopt the look.

${examples || '(No example pages provided — produce clean, minimal semantic HTML using the CSS variables above.)'}

# Output rules

- Output the page BODY HTML only. No <html>, <head>, <body> wrappers. No navigation, header, or footer (those are partials, handled separately).
- Output HTML directly. No markdown fences. No commentary before or after.
- Use semantic tags: <section>, <h1>, <h2>, <h3>, <p>, <ul>/<li>, <a>, <img>, <figure>, <figcaption>, <table>/<thead>/<tbody>/<tr>/<th>/<td>, <blockquote>.
- Inline styles or the CSS variables above. NO CSS classes. NO div soup. Match the rhythm of the examples.
- Preserve EVERY content element from the source:
  - Every heading (don't drop or merge)
  - Every paragraph (you may rephrase for clarity, but keep the substance)
  - Every image (use the exact src URL given — do not invent URLs)
  - Every table (rebuild as semantic <table> with <thead>/<tbody>)
  - Every list, link, blockquote, video embed
- If a featured image is provided, use it as the page's hero.
- Don't invent content. If a section is short, keep it short.
- Use semantic HTML5 elements where appropriate (e.g. <section> for major divisions).`;
}

function buildUserPrompt(source: SourcePage): string {
  const extras = source.extras && Object.keys(source.extras).length
    ? `\n## Custom fields (use these where relevant)\n\`\`\`json\n${JSON.stringify(source.extras, null, 2)}\n\`\`\`\n`
    : '';
  const featured = source.featured_image
    ? `\n## Featured image\n- URL: ${source.featured_image.url}\n- Alt: ${source.featured_image.alt}\n`
    : '';
  const excerpt = source.excerpt ? `\n## Excerpt\n${source.excerpt}\n` : '';

  return `# Source page

Title: ${source.title}
Old URL: ${source.url}
${featured}${excerpt}${extras}
## Body HTML from source (already cleaned of WordPress class soup)

\`\`\`html
${truncateHtml(source.cleaned_html, 12000)}
\`\`\`

Rewrite this page body in the new design. Output the HTML directly, nothing else.`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function buildFallbackHtml(source: SourcePage): string {
  // When AI isn't available, at least inline the featured image so it's not
  // lost. The cleaner already runs on cleaned_html earlier in the pipeline.
  if (source.featured_image) {
    return `<figure><img src="${escapeAttr(source.featured_image.url)}" alt="${escapeAttr(source.featured_image.alt)}" loading="eager"></figure>\n${source.cleaned_html}`;
  }
  return source.cleaned_html;
}

function stripCodeFences(s: string): string {
  return s
    .replace(/^```(?:html)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
}

function looksLikeHtml(s: string): boolean {
  return /<\/?[a-z][\s\S]*?>/i.test(s);
}

function truncateHtml(html: string, maxChars: number): string {
  if (html.length <= maxChars) return html;
  return html.slice(0, maxChars) + '\n<!-- …truncated… -->';
}

function escapeAttr(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
