// MIGRATION workflow — bring a WordPress site to Typeroll.
//
// Strategy:
//   The new site has its OWN design — colors, fonts, header/footer partials,
//   and ideally one or two design-reference pages — set up BEFORE migration.
//   We do NOT import the old site's globals.
//
//   For each page / post / custom-post-type item, we:
//     1. Get the source HTML (REST `content.rendered`; fall back to the
//        public page when REST is thin or empty).
//     2. Find every image URL referenced on the page (inline <img>, srcset,
//        background-image, plus the featured image). Move each to the new
//        CDN just-in-time — only images actually used on imported pages
//        end up on the new R2 bucket. Cached across pages so we don't
//        re-upload shared images.
//     3. Pass the cleaned content + featured image + custom fields + the
//        target site's design context (existing pages, settings) to Claude,
//        which reconstructs the page in the new design while preserving
//        every text/image/table/heading.
//   When ANTHROPIC_API_KEY is missing, the cleaned source HTML is used as-is.
//
//   The migration prefers the Typeroll Helper plugin (PHP, in
//   wp-helper-plugin/) when the customer has installed it and provided
//   the API key — it gives reliable access to custom post types, ACF
//   fields, and featured-image metadata regardless of how the source
//   site's REST is configured. Falls back to standard /wp-json/wp/v2/.
//
// Steps:
//   discover              — verify the WP site; probe helper plugin
//   extract_site_info     — site name + tagline (target site's design left alone)
//   enumerate_custom_types — find CPTs, create matching collections
//   extract_content        — pages + posts + custom items, with JIT media
//                            transfer and AI reconstruction
//   generate_redirects     — old URL → new slug
//   review                 — paused gate before publish

import { paths, slugify, MAIN_VERSION_ID } from '@typeroll/shared';
import type {
  CollectionDef,
  CollectionItem,
  Page,
  Redirect,
  SiteSettings,
} from '@typeroll/shared';
import type { ReadWriteStore } from '../datastore';
import { WPClient, type WPItem, type WPPage } from '../wp/client';
import { runMigrationPreflight, summarizePreflight } from '../migration-preflight';
import { cleanWordPressHtml } from '../wp/clean-html';
import { extractGlobals } from '../wp/globals';
import { WPMediaTransfer, buildMediaMap, readMediaConfig } from '../wp/media';
import {
  reconstructPage,
  isAIReconstructAvailable,
} from '../wp/ai-reconstruct';
import { loadDesignContext } from '../wp/design-context';
import { htmlToBlocks } from '../html-to-blocks';
import { inferCollection, projectItemFields } from '../wp/custom-types';
import { fetchRendered, extractMainContent } from '../wp/page-fetcher';
import { extractImageUrls } from '../wp/extract-image-urls';
import { extractInternalLinks, resolveSourceRedirectsInHtml } from '../wp/internal-links';
import { discoverSitemap } from '../wp/sitemap';
import { addInventoryUrl, addWordPressBareSlugGuess, analyzeCoverage, pathFromUrl } from '../wp/url-inventory';
import { WPHelperClient, type HelperItem } from '../wp/helper-client';
import { reviewGate, type WorkflowDef } from './types';

// REST `content.rendered` shorter than this triggers the public-page fallback —
// page builders sometimes return just shortcode markup that hasn't been
// expanded, and we'd rather see the actual rendered HTML.
const THIN_CONTENT_THRESHOLD = 200;

interface StoredCollectionRef {
  source_slug: string;
  source_rest_base: string;
  name: string;
  item_field: string;
}

export const migrationWorkflow: WorkflowDef = {
  type: 'migration',
  label: 'Migrate from WordPress',
  description:
    'Crawl a WordPress site and reconstruct each page in the new site\'s design. Images move to the new CDN as they\'re referenced. Pages, posts, custom post types, and ACF fields all supported.',
  steps: [
    {
      name: 'preflight',
      label: 'Check migration readiness',
      async run(ctx) {
        // First step on purpose. Every blocker here is invisible AFTER the
        // fact — without R2 the pages import fine and keep serving images
        // from the old host — so discovering one at the end means redoing
        // the expensive part of the job.
        const report = await runMigrationPreflight(ctx.orgId, ctx.siteId, MAIN_VERSION_ID, {
          sourceUrl: String(ctx.config.wp_url ?? '').trim() || undefined,
        });
        for (const c of report.checks) {
          ctx.log(`${c.status === 'ok' ? '✓' : c.severity === 'blocker' ? '✗' : '!'} ${c.label}: ${c.detail}`);
        }
        if (!report.ready) {
          if (ctx.config.skip_preflight === true || ctx.config.skip_preflight === 'true') {
            // Deliberate override, recorded in the log so the decision is
            // attributable when someone asks why the images point at the
            // old domain six months from now.
            ctx.log(`OVERRIDE: starting despite ${report.blockers.length} blocker(s) — ${summarizePreflight(report)}`);
          } else {
            throw new Error(
              `Migration not started — ${summarizePreflight(report)} ` +
              'Fix the blockers and start again, or set skip_preflight=true to proceed anyway.',
            );
          }
        }
        return { results: { preflight: report } };
      },
    },

    {
      name: 'discover',
      label: 'Discover',
      async run(ctx) {
        const url = String(ctx.config.wp_url ?? '').trim();
        if (!url) throw new Error('Missing wp_url in config');
        const helperKey = String(ctx.config.helper_api_key ?? '').trim() || null;

        const client = new WPClient(url);
        ctx.log(`Probing ${url}/wp-json …`);
        const info = await client.siteInfo();
        ctx.log(`Found "${info.name}" — ${info.description ?? 'no description'}`);

        let helperOk = false;
        let sourceLanguage: string | null = null;
        if (helperKey) {
          const helperInfo = await WPHelperClient.probe(url, helperKey);
          if (helperInfo) {
            helperOk = true;
            // WP returns language as "sv-SE", "en-US"; BCP 47 is dash-cased,
            // so we keep it as-is (matches our SiteSettings expectation).
            sourceLanguage = helperInfo.language ?? null;
            ctx.log(
              `Typeroll Helper plugin v${helperInfo.plugin_version} detected. ACF: ${helperInfo.acf_active ? 'yes' : 'no'}. Language: ${sourceLanguage ?? 'unknown'}.`
            );
          } else {
            ctx.log('Helper API key provided but plugin did not respond. Falling back to standard REST.');
          }
        } else {
          ctx.log('No helper API key — using standard /wp-json/wp/v2/. Custom post types and ACF may be incomplete.');
        }

        if (!isAIReconstructAvailable()) {
          ctx.log('NOTE: ANTHROPIC_API_KEY not set. Pages will be imported as cleaned source HTML, not reconstructed in the new design.');
        }

        await ctx.store.updateDoc(paths.site(ctx.orgId, ctx.siteId), {
          source_wp_url: url,
          source_builder: 'classic',
        });

        return {
          state: {
            wp_url: url,
            helper_api_key: helperKey,
            helper_active: helperOk,
            site_name: info.name,
            site_description: info.description ?? null,
            source_language: sourceLanguage,
          },
        };
      },
    },

    {
      name: 'extract_site_info',
      label: 'Import site info (name, tagline, SEO)',
      async run(ctx) {
        const settingsPath = paths.settings(ctx.orgId, ctx.siteId);
        const existing = (await ctx.store.getDoc<SiteSettings>(settingsPath)) ?? null;
        const looksUnconfigured =
          !existing ||
          existing.site_name === 'New Site' ||
          existing.site_name === 'ACME Studio';

        const patch: Partial<SiteSettings> = {};
        if (looksUnconfigured) {
          patch.site_name = String(ctx.state.site_name ?? 'My Site');
          if (ctx.state.site_description) patch.tagline = String(ctx.state.site_description);
          ctx.log(`Imported site name (${patch.site_name}) — target was unconfigured.`);
        } else {
          ctx.log('Target site already has name/tagline; leaving them alone.');
        }

        // Language: prefer the source site's setting over the default 'en',
        // unless the customer already explicitly chose a non-default value.
        if (ctx.state.source_language && (!existing?.language || existing.language === 'en')) {
          patch.language = String(ctx.state.source_language);
          ctx.log(`Imported language: ${patch.language}.`);
        }

        // Site-wide SEO from whichever plugin the customer's WP is running
        // (helper plugin only — there's no reliable way to read this without
        // it). Always import: even on a configured target, the org schema
        // and default OG image are usually missing and worth bringing in.
        const helperKey = ctx.state.helper_api_key as string | null;
        const wpUrl = String(ctx.state.wp_url);
        if (helperKey) {
          try {
            const { plugin, site: seo } = await new WPHelperClient(wpUrl, helperKey).seo();
            if (plugin !== 'none') {
              const setIfMissing = (key: keyof SiteSettings, value: string | null | undefined) => {
                if (!value) return;
                const before = (existing as Record<string, unknown> | null)?.[key];
                if (!before) (patch as Record<string, unknown>)[key] = value;
              };
              setIfMissing('default_meta_description', seo.default_meta_description ?? undefined);
              setIfMissing('default_og_image',         seo.default_og_image ?? undefined);

              if (seo.organization && (seo.organization.name || seo.organization.logo)) {
                const existingOrg = existing?.organization ?? {};
                patch.organization = {
                  name: existingOrg.name ?? seo.organization.name ?? undefined,
                  logo: existingOrg.logo ?? seo.organization.logo ?? undefined,
                  same_as: existingOrg.same_as && existingOrg.same_as.length
                    ? existingOrg.same_as
                    : (seo.organization.same_as ?? []),
                };
              }

              // Social profile URLs — merge into existing social block.
              if (seo.social) {
                const existingSocial = existing?.social ?? {};
                patch.social = {
                  facebook:  existingSocial.facebook  ?? seo.social.facebook  ?? undefined,
                  instagram: existingSocial.instagram ?? seo.social.instagram ?? undefined,
                  linkedin:  existingSocial.linkedin  ?? seo.social.linkedin  ?? undefined,
                  x:         existingSocial.x         ?? seo.social.twitter   ?? undefined,
                  youtube:   existingSocial.youtube   ?? seo.social.youtube   ?? undefined,
                };
              }

              // Title separator → repurpose default_seo_suffix when it makes sense.
              if (seo.title_separator && !existing?.default_seo_suffix) {
                patch.default_seo_suffix = ` ${seo.title_separator} ${patch.site_name ?? existing?.site_name ?? ''}`.trimEnd();
              }

              ctx.log(`Imported site-wide SEO from ${plugin}.`);
            } else {
              ctx.log('No SEO plugin detected on the source — skipping site-wide SEO import.');
            }
          } catch (e) {
            ctx.log(`Site-wide SEO import skipped: ${e instanceof Error ? e.message : 'unknown'}.`);
          }
        }

        if (Object.keys(patch).length > 0) {
          await ctx.store.updateDoc(settingsPath, patch);
        }

        // Probe globals (currently a no-op on the design side; here only so
        // future versions of extractGlobals can populate contact/social).
        try {
          await extractGlobals(String(ctx.state.wp_url));
        } catch {
          /* ignore */
        }

        return {};
      },
    },

    {
      name: 'inventory_urls',
      label: 'Inventory old-site URLs (sitemap + helper plugin)',
      async run(ctx) {
        const url = String(ctx.state.wp_url);
        const helperActive = Boolean(ctx.state.helper_active);
        const helperKey = ctx.state.helper_api_key as string | null;
        const sourceOrigin = new URL(url).origin;

        let added = 0;
        const addByUrl = async (fullUrl: string, source: string): Promise<void> => {
          const path = pathFromUrl(fullUrl, sourceOrigin);
          if (!path) return;
          await addInventoryUrl(ctx.store, ctx.orgId, ctx.siteId, {
            path,
            full_url: fullUrl,
            source,
          });
          added++;
        };

        // 1. Sitemap (works for nearly every WP site).
        ctx.log('Fetching sitemap…');
        const sitemap = await discoverSitemap(url);
        ctx.log(`Sitemap returned ${sitemap.length} URL(s).`);
        for (const entry of sitemap) await addByUrl(entry.loc, 'sitemap');

        // 2. Helper plugin's /urls (most reliable, when present).
        if (helperActive && helperKey) {
          try {
            const items = await new WPHelperClient(url, helperKey).urls();
            ctx.log(`Helper plugin returned ${items.length} URL(s).`);
            for (const item of items) await addByUrl(item.url, 'helper');
          } catch (e) {
            ctx.log(`Helper /urls failed: ${e instanceof Error ? e.message : e}`);
          }
        }

        ctx.log(`Inventory after sitemap + helper: ${added} insert/merge(s).`);
        return {};
      },
    },

    {
      name: 'enumerate_custom_types',
      label: 'Find custom post types',
      async run(ctx) {
        const url = String(ctx.state.wp_url);
        const helperActive = Boolean(ctx.state.helper_active);
        const helperKey = ctx.state.helper_api_key as string | null;

        const created: StoredCollectionRef[] = [];

        if (helperActive && helperKey) {
          // Helper plugin path — sees every post type, even those without
          // show_in_rest, with ACF inlined.
          const helper = new WPHelperClient(url, helperKey);
          const types = (await helper.postTypes()).filter(
            (t) => !t.is_builtin && t.count_published > 0
          );
          ctx.log(`Helper plugin: ${types.length} custom post type(s) with published items.`);
          for (const type of types) {
            const items = await helper.listItems(type.slug);
            const sample = items[0] as unknown as WPItem | undefined;
            if (!sample) continue;
            await registerCollection(ctx, type.slug, type.name, sample, created);
          }
        } else {
          // Standard REST path. Won't see types with show_in_rest=false.
          const client = new WPClient(url);
          const types = await client.listCustomPostTypes();
          ctx.log(`Standard REST: ${types.length} custom post type(s) visible.`);
          for (const type of types) {
            let sample: WPItem | undefined;
            try {
              const items = await client.listItemsOfType(type.rest_base);
              sample = items[0];
            } catch (e) {
              ctx.log(`Couldn't sample "${type.slug}": ${e instanceof Error ? e.message : e}. Skipping.`);
              continue;
            }
            if (!sample) {
              ctx.log(`Type "${type.slug}" has no items; skipping.`);
              continue;
            }
            await registerCollection(ctx, type.slug, type.name, sample, created);
          }
        }

        return { state: { collections_created: created } };
      },
    },

    {
      name: 'extract_content',
      label: 'Reconstruct pages in the new design (media moves as it\'s used)',
      async run(ctx) {
        const url = String(ctx.state.wp_url);
        const sourceOrigin = new URL(url).origin;
        const helperActive = Boolean(ctx.state.helper_active);
        const helperKey = ctx.state.helper_api_key as string | null;

        const transfer = new WPMediaTransfer(
          ctx.orgId,
          ctx.siteId,
          ctx.store,
          readMediaConfig()
        );
        if (!readMediaConfig()) {
          ctx.log('R2 not configured — image URLs will keep their original WordPress origin.');
        }

        const design = await loadDesignContext(ctx.store, ctx.orgId, ctx.siteId);
        if (!design.example_pages.length) {
          ctx.log(
            'No design-reference pages on the target site — add 1–2 example pages before migration for best results.'
          );
        } else {
          ctx.log(`Using ${design.example_pages.length} design-reference page(s).`);
        }

        // Ensure a "posts" collection exists so WordPress posts can be
        // imported as collection items (route_template /blog/{slug}) instead
        // of as flat pages with slash-slugs. See docs/page-slug-audit.md
        // for the motivation; the legacy slash-slug path is no longer used
        // for new imports.
        const postsCollectionName = await ensurePostsCollection(
          ctx.store,
          ctx.orgId,
          ctx.siteId,
        );

        // Collect items to process.
        const pages: WPPage[] = [];
        const posts: WPPage[] = [];
        const customItems: Array<{ ref: StoredCollectionRef; item: WPItem }> = [];

        const customRefs = (ctx.state.collections_created ?? []) as StoredCollectionRef[];

        if (helperActive && helperKey) {
          const helper = new WPHelperClient(url, helperKey);
          for (const i of await helper.listItems('page')) pages.push(helperToWP(i));
          for (const i of await helper.listItems('post')) posts.push(helperToWP(i));
          for (const ref of customRefs) {
            const items = await helper.listItems(ref.source_slug);
            for (const i of items) customItems.push({ ref, item: helperToWP(i) as unknown as WPItem });
          }
        } else {
          const client = new WPClient(url);
          pages.push(...(await client.listPages()));
          posts.push(...(await client.listPosts()));
          for (const ref of customRefs) {
            try {
              const items = await client.listItemsOfType(ref.source_rest_base);
              for (const i of items) customItems.push({ ref, item: i });
            } catch (e) {
              ctx.log(`Failed to list ${ref.source_slug}: ${e instanceof Error ? e.message : e}`);
            }
          }
        }

        const total = pages.length + posts.length + customItems.length;
        ctx.log(`Reconstructing ${pages.length} page(s), ${posts.length} post(s), ${customItems.length} custom-type item(s)…`);

        let done = 0;
        let aiCount = 0;
        let fallbackCount = 0;
        let imagesMoved = 0;
        const slugMap: Record<string, string> = {};
        const sourceRedirectCache = new Map<string, Promise<string>>();

        // ── per-page helpers ─────────────────────────────────────────────

        const moveImagesAndBuildMap = async (
          rawHtml: string,
          featuredOldUrl: string | null,
          featuredAlt: string
        ): Promise<{ mediaMap: Map<string, string>; featuredNewUrl: string | null }> => {
          const urls = extractImageUrls(rawHtml, { sourceOrigin });
          const records = await Promise.all(
            urls.map(async (u) => {
              try {
                const r = await transfer.ensureUrl(u.url, u.alt);
                imagesMoved++;
                return r;
              } catch (e) {
                ctx.log(`Image transfer failed for ${u.url}: ${e instanceof Error ? e.message : e}`);
                return null;
              }
            })
          );
          let featuredNewUrl: string | null = null;
          if (featuredOldUrl) {
            try {
              const r = await transfer.ensureUrl(featuredOldUrl, featuredAlt);
              records.push(r);
              imagesMoved++;
              featuredNewUrl = r.cdnUrl;
            } catch (e) {
              ctx.log(`Featured image transfer failed: ${e instanceof Error ? e.message : e}`);
              featuredNewUrl = featuredOldUrl;
            }
          }
          const mediaMap = buildMediaMap(records.filter((r): r is NonNullable<typeof r> => r != null));
          return { mediaMap, featuredNewUrl };
        };

        const reconstructAndSave = async (
          item: WPPage,
          kind: 'page' | 'post'
        ): Promise<void> => {
          // Track this item's old URL in the inventory.
          await addInventoryUrl(ctx.store, ctx.orgId, ctx.siteId, {
            path: pathFromUrl(item.link, sourceOrigin) ?? '/' + item.slug,
            full_url: item.link,
            source: kind === 'page' ? 'rest-page' : 'rest-post',
          });
          await addWordPressBareSlugGuess(
            ctx.store, ctx.orgId, ctx.siteId, item.link, item.slug, sourceOrigin,
          );

          let rawHtml = item.content?.rendered ?? '';

          if (rawHtml.replace(/<[^>]+>/g, '').trim().length < THIN_CONTENT_THRESHOLD) {
            const fetched = await fetchRendered(item.link);
            if (fetched) {
              const main = extractMainContent(fetched.html);
              if (main.length > rawHtml.length) {
                ctx.log(`[${item.slug}] thin REST content; using ${fetched.source}-rendered page (${main.length} chars).`);
                rawHtml = main;
              }
            }
          }

          rawHtml = await resolveSourceRedirectsInHtml(rawHtml, sourceOrigin, {
            cache: sourceRedirectCache,
          });

          // Pick up internal links from the source body — anything pointing
          // at the old origin that the sitemap missed becomes a future
          // unhandled URL the customer can address before cutover.
          for (const p of extractInternalLinks(rawHtml, sourceOrigin)) {
            await addInventoryUrl(ctx.store, ctx.orgId, ctx.siteId, {
              path: p,
              full_url: sourceOrigin + p,
              source: 'internal-link',
            });
          }

          const featuredOldUrl = (item as unknown as { _featured_url?: string })._featured_url ?? null;
          const featuredAlt = (item as unknown as { _featured_alt?: string })._featured_alt ?? '';
          const { mediaMap, featuredNewUrl } = await moveImagesAndBuildMap(
            rawHtml,
            featuredOldUrl,
            featuredAlt
          );

          const cleaned = cleanWordPressHtml(rawHtml, {
            mediaMap,
            sourceOrigin,
            collapseWhitespace: true,
          });

          const featuredImage = featuredNewUrl
            ? { url: featuredNewUrl, alt: featuredAlt }
            : undefined;
          const excerpt = item.excerpt?.rendered ? stripTags(item.excerpt.rendered) : undefined;
          const extras = collectExtras(item);

          const result = await reconstructPage(design, {
            title: stripTags(item.title.rendered),
            slug: item.slug,
            url: item.link,
            cleaned_html: cleaned,
            featured_image: featuredImage,
            excerpt,
            extras,
          });
          if (result.used_ai) aiCount++;
          else fallbackCount++;
          if (result.notes) ctx.log(`[${item.slug}] ${result.notes}`);

          const rawSlug = item.slug || slugify(item.title.rendered) || `page-${item.id}`;

          // SEO: prefer the helper plugin's normalized `seo` field (works for
          // Yoast/RankMath/SEOPress/AIOSEO). Fall back to yoast_head_json from
          // public WP REST (Yoast-only). Default to the page title when both
          // are empty so seo_title is never blank.
          const helperSEO = (item as unknown as { _seo?: HelperItem['seo'] })._seo;
          const yoast = item.yoast_head_json;
          const seoTitle = helperSEO?.title ?? yoast?.title ?? stripTags(item.title.rendered);
          const seoDesc  = helperSEO?.description ?? yoast?.description;
          const seoCanon = helperSEO?.canonical ?? yoast?.canonical;
          const noindex  = helperSEO?.noindex === true ? true : undefined;
          const rawOgImage = helperSEO?.og_image ?? yoast?.og_image?.[0]?.url;
          const ogImage = rawOgImage
            ? (mediaMap.get(rawOgImage) ?? rawOgImage)
            : featuredImage?.url;

          if (kind === 'post') {
            // Modern path: blog posts become items in the `posts` collection
            // with route_template /blog/{slug}, not flat pages with
            // slash-slugs. See docs/page-slug-audit.md for the why.
            // The collection's item_template_html renders {{{body}}} +
            // {{title}} + {{#hero_image}}…{{/hero_image}}; we populate
            // those fields plus the SEO ones the schema declares.
            const itemId = makeSafeDocId(rawSlug);
            const now = new Date().toISOString();
            const itemDoc = {
              title: stripTags(item.title.rendered),
              slug: rawSlug,
              date: (item.date ?? now).slice(0, 10),
              updated_date: (item.modified ?? now).slice(0, 10),
              author: undefined,
              excerpt: excerpt ?? undefined,
              body: result.html,
              hero_image: featuredImage?.url,
              seo_title: seoTitle,
              seo_description: seoDesc,
              og_image: ogImage,
              canonical_url: seoCanon,
              noindex,
              old_wp_url: item.link,
              ai_generated: result.used_ai,
              // CollectionItem only has draft|published; we land all
              // imported posts as draft so the customer reviews them
              // before publishing (parallels the 'review' page status).
              status: 'draft' as const,
              created_at: item.date ?? now,
              updated_at: item.modified ?? now,
            };
            await ctx.store.setDoc(
              paths.collectionItem(ctx.orgId, ctx.siteId, postsCollectionName, itemId),
              itemDoc,
            );
            // The URL the redirect machinery should point at. The
            // collection's route_template is /blog/{slug}, so the resolved
            // URL is /blog/<rawSlug> — same shape as the legacy path.
            slugMap[item.link] = `/blog/${rawSlug}`;
          } else {
            // Pages stay pages. No slash-slug at this branch — pages live
            // at top-level paths only.
            let slug = rawSlug;
            if (item.slug === 'home' || isLikelyHome(item, url)) slug = 'home';
            const pageId = makeSafeDocId(slug);
            // Run the heuristic converter on the reconstructed HTML so the
            // imported page lands in blocks-mode by default — consistent
            // with create_page's default and the editor it'll open in.
            // Customers who want the raw HTML can opt out by setting
            // `target_content_mode: 'html'` in the migration config.
            const targetMode = String(ctx.config.target_content_mode ?? 'blocks');
            const useBlocks = targetMode !== 'html';
            const blocks = useBlocks ? htmlToBlocks(result.html).blocks : undefined;
            const doc: Omit<Page, 'id'> = {
              title: stripTags(item.title.rendered),
              slug,
              content_mode: useBlocks ? 'blocks' : 'html',
              html_content: result.html,
              ...(blocks ? { blocks } : {}),
              seo_title: seoTitle,
              seo_description: seoDesc,
              og_image: ogImage,
              canonical_url: seoCanon,
              noindex,
              kind: 'page',
              status: 'review',
              old_wp_url: item.link,
              ai_generated: result.used_ai,
              date_published: item.date,
              date_updated: item.modified,
            };
            await ctx.store.setDoc(`${paths.pages(ctx.orgId, ctx.siteId)}/${pageId}`, doc);
            slugMap[item.link] = `/${slug}`;
          }
          done++;
          if (done % 3 === 0 || done === total) {
            ctx.setProgress({ total, completed: done });
            ctx.log(`Done ${done}/${total} — AI: ${aiCount}, src-kept: ${fallbackCount}, images moved: ${imagesMoved}`);
          }
        };

        for (const p of pages) await reconstructAndSave(p, 'page');
        for (const p of posts) await reconstructAndSave(p, 'post');

        // ── Custom-type items → collection items ─────────────────────────

        for (const { ref, item } of customItems) {
          const coll = await ctx.store.getDoc<CollectionDef>(
            paths.collection(ctx.orgId, ctx.siteId, ref.name)
          );
          if (!coll) continue;

          if (item.link) {
            await addInventoryUrl(ctx.store, ctx.orgId, ctx.siteId, {
              path: pathFromUrl(item.link, sourceOrigin) ?? '/' + (item.slug ?? ''),
              full_url: item.link,
              source: `rest-${ref.source_slug}`,
            });
            await addWordPressBareSlugGuess(
              ctx.store, ctx.orgId, ctx.siteId, item.link, item.slug ?? '', sourceOrigin,
            );
          }

          let rawHtml = item.content?.rendered ?? '';
          rawHtml = await resolveSourceRedirectsInHtml(rawHtml, sourceOrigin, {
            cache: sourceRedirectCache,
          });
          // Pick up internal links from the source body.
          for (const p of extractInternalLinks(rawHtml, sourceOrigin)) {
            await addInventoryUrl(ctx.store, ctx.orgId, ctx.siteId, {
              path: p,
              full_url: sourceOrigin + p,
              source: 'internal-link',
            });
          }
          const featuredOldUrl = (item as unknown as { _featured_url?: string })._featured_url ?? null;
          const featuredAlt = (item as unknown as { _featured_alt?: string })._featured_alt ?? '';
          const { mediaMap, featuredNewUrl } = await moveImagesAndBuildMap(
            rawHtml,
            featuredOldUrl,
            featuredAlt
          );

          const cleaned = cleanWordPressHtml(rawHtml, {
            mediaMap,
            sourceOrigin,
            collapseWhitespace: true,
          });
          const featuredImage = featuredNewUrl
            ? { url: featuredNewUrl, alt: featuredAlt }
            : undefined;

          let bodyHtml = cleaned;
          if (coll.fields.some((f) => f.name === 'body')) {
            const result = await reconstructPage(design, {
              title: stripTags(item.title?.rendered ?? ''),
              slug: item.slug ?? '',
              url: item.link ?? '',
              cleaned_html: cleaned,
              featured_image: featuredImage,
              excerpt: item.excerpt?.rendered ? stripTags(item.excerpt.rendered) : undefined,
              extras: collectExtras(item),
            });
            bodyHtml = result.html;
            if (result.used_ai) aiCount++;
            else fallbackCount++;
          }

          const fields = projectItemFields(item, coll.fields, featuredImage?.url, bodyHtml);
          const itemId = makeSafeDocId(item.slug ?? `i-${item.id}`);
          const docPath = paths.collectionItem(ctx.orgId, ctx.siteId, ref.name, itemId);
          const now = new Date().toISOString();
          await ctx.store.setDoc(docPath, {
            ...fields,
            status: 'published',
            created_at: item.date ?? now,
            updated_at: item.modified ?? now,
          });
          done++;
          if (done % 3 === 0 || done === total) {
            ctx.setProgress({ total, completed: done });
          }
        }

        ctx.log(
          `Reconstruction complete. AI-reconstructed: ${aiCount}, source-kept: ${fallbackCount}, images moved to CDN: ${imagesMoved}.`
        );
        return {
          state: { slug_map: slugMap, imported_count: done, images_moved: imagesMoved },
        };
      },
    },

    {
      name: 'generate_redirects',
      label: 'Generate redirects from old URLs',
      async run(ctx) {
        const slugMap = ctx.state.slug_map as Record<string, string>;
        const sourceOrigin = new URL(String(ctx.state.wp_url)).origin;
        let added = 0;
        let importedExisting = 0;

        // 1. Pull in whatever the customer already has in their WP redirect
        //    plugin (helper plugin only — falls back silently if it's not
        //    installed). Write these first so the slug-map rules below can
        //    overwrite when they target the same `from`.
        const helperKey = ctx.state.helper_api_key as string | null;
        const wpUrl = String(ctx.state.wp_url);
        if (helperKey) {
          try {
            const { redirects, sources, total } = await new WPHelperClient(wpUrl, helperKey).redirects();
            for (const r of redirects) {
              const oldPath = relativize(r.from, sourceOrigin);
              const newPath = relativize(r.to, sourceOrigin);
              if (!oldPath || oldPath === newPath) continue;
              const redirect: Omit<Redirect, 'id'> = {
                from_path: oldPath,
                to_path: newPath,
                // The schema only supports 301/302; map other 3xx codes down
                // to the closest equivalent.
                status_code: r.status_code === 302 ? 302 : 301,
                auto_generated: true,
              };
              const id = makeSafeDocId(oldPath);
              await ctx.store.setDoc(`${paths.redirects(ctx.orgId, ctx.siteId)}/${id}`, redirect);
              importedExisting++;
            }
            if (total > 0) {
              const breakdown = Object.entries(sources).map(([k, v]) => `${k}=${v}`).join(', ');
              ctx.log(`Imported ${importedExisting} existing redirect(s) from WP (${breakdown}).`);
            }
          } catch (e) {
            ctx.log(`Existing-redirects import skipped: ${e instanceof Error ? e.message : 'unknown error'}.`);
          }
        }

        // 2. Add slug-change rules from the migration's own old→new mapping.
        for (const [oldUrl, newPath] of Object.entries(slugMap)) {
          const oldPath = relativize(oldUrl, sourceOrigin);
          if (oldPath === newPath) continue;
          const redirect: Omit<Redirect, 'id'> = {
            from_path: oldPath,
            to_path: newPath,
            status_code: 301,
            auto_generated: true,
          };
          const id = makeSafeDocId(oldPath);
          await ctx.store.setDoc(`${paths.redirects(ctx.orgId, ctx.siteId)}/${id}`, redirect);
          added++;
        }
        ctx.log(`Wrote ${added} slug-change redirect rule(s).`);
        return {
          results: {
            redirects: added + importedExisting,
            redirects_from_wp: importedExisting,
            redirects_from_slug_map: added,
            pages: ctx.state.imported_count,
            images_moved: ctx.state.images_moved,
          },
        };
      },
    },

    {
      name: 'analyze_coverage',
      label: 'Analyze URL coverage',
      async run(ctx) {
        const { summary } = await analyzeCoverage(ctx.store, ctx.orgId, ctx.siteId);
        ctx.log(
          `Coverage: ${summary.total} URL(s) — ${summary.migrated} migrated, ${summary.redirected} redirected, ${summary.excluded} excluded, ${summary.unhandled} unhandled.`
        );
        return {
          state: { coverage: summary },
          results: { coverage: summary },
        };
      },
    },

    {
      name: 'review',
      label: 'Review before publish',
      needsReview: true,
      async run(ctx) {
        const collectionsCreated = (ctx.state.collections_created ?? []) as StoredCollectionRef[];
        const coverage = ctx.state.coverage as
          | { total: number; migrated: number; redirected: number; unhandled: number; excluded: number }
          | undefined;
        const unhandled = coverage?.unhandled ?? 0;
        const message =
          unhandled > 0
            ? `Migration complete. ${unhandled} URL(s) are unhandled — resolve them on the Migration page before switching DNS, or mark them as intentional 404s.`
            : 'Migration complete. Every discovered URL is handled.';
        return reviewGate(message, {
            imported_pages: ctx.state.imported_count,
            images_moved: ctx.state.images_moved,
            collections_created: collectionsCreated.map((c) => c.name),
            redirects: Object.keys((ctx.state.slug_map ?? {}) as Record<string, string>).length,
            coverage,
          }
        );
      },
    },
  ],
};

// ─── Helpers ─────────────────────────────────────────────────────────────

async function registerCollection(
  ctx: Parameters<NonNullable<(typeof migrationWorkflow.steps)[number]['run']>>[0],
  slug: string,
  name: string,
  sample: WPItem,
  out: StoredCollectionRef[]
): Promise<void> {
  const def = inferCollection({ slug, name, rest_base: slug } as Parameters<typeof inferCollection>[0], sample);
  const collectionPath = paths.collection(ctx.orgId, ctx.siteId, def.name);
  const existing = await ctx.store.getDoc<CollectionDef>(collectionPath);
  if (existing) {
    ctx.log(`Collection "${def.name}" already exists — keeping schema.`);
  } else {
    const doc: Omit<CollectionDef, 'id'> = {
      name: def.name,
      label_singular: def.label_singular,
      label_plural: def.label_plural,
      icon: def.icon,
      fields: def.fields,
      sort_field: 'published_at',
      sort_dir: 'desc',
      created_at: new Date().toISOString(),
    };
    await ctx.store.setDoc(collectionPath, doc);
    ctx.log(`Created collection "${def.label_plural}" (${def.name}) with ${def.fields.length} field(s).`);
  }
  out.push({
    source_slug: slug,
    source_rest_base: slug,
    name: def.name,
    item_field: 'body',
  });
}

/** Coerce a helper-plugin item into the WPPage shape the rest of the code uses. */
function helperToWP(h: HelperItem): WPPage {
  return {
    id: h.id,
    slug: h.slug,
    status: h.status,
    title: h.title,
    content: { rendered: h.content?.rendered ?? '' },
    excerpt: { rendered: h.excerpt?.rendered ?? '' },
    link: h.link,
    date: h.date,
    modified: h.modified,
    parent: h.parent,
    menu_order: h.menu_order,
    featured_media: h.featured_image?.id ?? 0,
    // Stash the featured image's URL + alt so the page handler can transfer
    // it without needing a separate REST call.
    _featured_url: h.featured_image?.url,
    _featured_alt: h.featured_image?.alt,
    acf: h.acf,
    meta: h.meta,
    // Stash the normalized SEO so the page handler can prefer it over
    // yoast_head_json (which only Yoast exposes).
    _seo: h.seo,
  } as WPPage & { _featured_url?: string; _featured_alt?: string; _seo?: HelperItem['seo'] };
}

function relativize(url: string, originOrUrl: string): string {
  try {
    const origin = originOrUrl.startsWith('http') ? new URL(originOrUrl).origin : originOrUrl;
    const u = new URL(url);
    if (u.origin === origin) return u.pathname + u.search;
    return url;
  } catch {
    return url;
  }
}

function isLikelyHome(item: WPPage, baseUrl: string): boolean {
  try {
    const base = new URL(baseUrl);
    const link = new URL(item.link);
    return link.pathname === '/' || link.pathname === '' || link.href === base.href;
  } catch {
    return false;
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').trim();
}

function makeSafeDocId(s: string): string {
  return s.replace(/[\/\\]/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || `doc-${Date.now()}`;
}

function collectExtras(item: WPPage | WPItem): Record<string, unknown> | undefined {
  const extras: Record<string, unknown> = {};
  const acf = (item as WPPage).acf ?? {};
  const meta = (item as WPPage).meta ?? {};
  for (const [k, v] of Object.entries(acf)) {
    if (!k.startsWith('_') && v !== null && v !== '') extras[k] = v;
  }
  for (const [k, v] of Object.entries(meta)) {
    if (!k.startsWith('_') && v !== null && v !== '') extras[`meta.${k}`] = v;
  }
  return Object.keys(extras).length ? extras : undefined;
}

/**
 * Ensure a `posts` collection exists on the target site so WordPress posts
 * can be imported as collection items (modern primitive) rather than as
 * flat pages with slash-slugs (the legacy pattern that docs/page-slug-audit.md
 * flagged for replacement). Returns the resolved collection name so callers
 * can write items to it.
 *
 * The schema mirrors the field set tr-blog skill recommends — title, slug,
 * date, author, excerpt, hero_image, richtext body — plus SEO fields the
 * migration already populates (seo_title, seo_description, og_image,
 * canonical_url, noindex, old_wp_url, ai_generated).
 *
 * Idempotent: if a posts collection already exists (or one with a
 * `route_template` of "/blog/{slug}" / "/posts/{slug}" / "/news/{slug}"),
 * we reuse it and don't touch the schema — customer may have edited it.
 *
 * `item_template_html` is set to a minimal article template only when
 * creating fresh. The customer can refine it post-migration.
 */
async function ensurePostsCollection(
  store: ReadWriteStore,
  orgId: string,
  siteId: string,
): Promise<string> {
  const COLL_NAME = 'posts';
  const existing = await store.getDoc<CollectionDef>(
    paths.collection(orgId, siteId, COLL_NAME),
  );
  if (existing) return existing.name;

  // Also check if a collection with /blog/{slug} routing exists under another
  // name (e.g. `blog`) so we don't double-create.
  const all = await store.listDocs<CollectionDef>(paths.collections(orgId, siteId));
  const blogish = all.find((c) =>
    typeof c.route_template === 'string' &&
    /^\/(blog|posts|news|articles)\/\{slug\}$/.test(c.route_template),
  );
  if (blogish) return blogish.name;

  const def: Omit<CollectionDef, 'id'> = {
    name: COLL_NAME,
    label_singular: 'Post',
    label_plural: 'Posts',
    icon: '📝',
    slug_field: 'slug',
    sort_field: 'date',
    sort_dir: 'desc',
    route_template: '/blog/{slug}',
    item_template_html:
      '<article class="post">\n' +
      '  <header class="post__header">\n' +
      '    <time>{{date}}</time>\n' +
      '    <h1>{{title}}</h1>\n' +
      '    {{#author}}<p class="byline">av {{author}}</p>{{/author}}\n' +
      '  </header>\n' +
      '  {{#hero_image}}<img class="post__hero" src="{{hero_image}}" alt="{{title}}" />{{/hero_image}}\n' +
      '  <div class="post__body">{{{body}}}</div>\n' +
      '</article>\n' +
      '<style>\n' +
      '.post{max-width:42rem;margin:3rem auto;padding:0 1rem}\n' +
      '.post__header time{color:var(--color-text-light);font-size:0.85rem}\n' +
      '.post__header h1{font-family:var(--font-heading);font-size:2.25rem;margin:0.25rem 0}\n' +
      '.byline{color:var(--color-text-light);font-size:0.9rem}\n' +
      '.post__hero{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:0.5rem;margin:2rem 0}\n' +
      '.post__body{font-size:1.05rem;line-height:1.7}\n' +
      '</style>',
    fields: [
      { name: 'title',           type: 'text',     label: 'Title',         required: true },
      { name: 'slug',            type: 'text',     label: 'URL slug',      required: true },
      { name: 'date',            type: 'date',     label: 'Date',          required: true },
      { name: 'updated_date',    type: 'date',     label: 'Updated date' },
      { name: 'author',          type: 'text',     label: 'Author' },
      { name: 'excerpt',         type: 'textarea', label: 'Excerpt' },
      { name: 'body',            type: 'richtext', label: 'Body' },
      { name: 'hero_image',      type: 'image',    label: 'Hero image' },
      { name: 'seo_title',       type: 'text',     label: 'SEO title' },
      { name: 'seo_description', type: 'textarea', label: 'SEO description' },
      { name: 'og_image',        type: 'text',     label: 'Open Graph image URL' },
      { name: 'canonical_url',   type: 'text',     label: 'Canonical URL' },
      { name: 'noindex',         type: 'boolean',  label: 'No-index' },
      { name: 'old_wp_url',      type: 'text',     label: 'Old WordPress URL' },
      { name: 'ai_generated',    type: 'boolean',  label: 'AI-reconstructed' },
    ],
    created_at: new Date().toISOString(),
  };
  await store.setDoc(paths.collection(orgId, siteId, COLL_NAME), def);
  return COLL_NAME;
}
