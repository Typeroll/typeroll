import { vstore } from '../version-store';
import { requireImportStorage } from '../media/import-policy';
import { mapTransfers } from '../media/transfer';
// Migration preserves source content, stable identities and shared taxonomy
// relations. Presentation is reviewed separately in reusable Page templates.
// Media still transfers directly to the organization's verified storage.

import { paths, slugify, MAIN_VERSION_ID, contentPagePath, DEFAULT_CONTENT_TYPE } from '@typeroll/shared';
import type {
  ContentType,
  Page,
  Redirect,
  SiteSettings,
} from '@typeroll/shared';
import type { ReadWriteStore } from '../datastore';
import { WPClient, type WPItem, type WPPage } from '../wp/client';
import { runMigrationPreflight, summarizePreflight } from '../migration-preflight';
import { cleanWordPressHtml } from '../wp/clean-html';
import { extractGlobals } from '../wp/globals';
import { WPMediaTransfer, buildMediaMap, mediaTransferAvailability } from '../wp/media';
import { planTaxonomyImport, type TaxonomySource } from '../wp/taxonomy-import';
import { htmlToBlocks } from '../html-to-blocks';
import { inferContentType, projectItemFields } from '../wp/custom-types';
import { fetchRendered, extractMainContent } from '../wp/page-fetcher';
import { extractImageUrls } from '../wp/extract-image-urls';
import { extractInternalLinks, resolveSourceRedirectsInHtml } from '../wp/internal-links';
import { discoverSitemap } from '../wp/sitemap';
import { addInventoryUrl, addWordPressBareSlugGuess, analyzeCoverage, pathFromUrl } from '../wp/url-inventory';
import { WPHelperClient, type HelperItem } from '../wp/helper-client';
import { normalizeWordPressPlainText } from '../wp/plain-text';
import { reviewGate, type WorkflowDef } from './types';

// REST `content.rendered` shorter than this triggers the public-page fallback —
// page builders sometimes return just shortcode markup that hasn't been
// expanded, and we'd rather see the actual rendered HTML.
const THIN_CONTENT_THRESHOLD = 200;

interface StoredContentTypeRef {
  source_slug: string;
  source_rest_base: string;
  name: string;
  item_field: string;
}

const migrationVersion = (ctx: { config: Record<string, unknown> }): string => typeof ctx.config.version === 'string' && ctx.config.version ? ctx.config.version : MAIN_VERSION_ID;

export const migrationWorkflow: WorkflowDef = {
  type: 'migration',
  label: 'Migrate from WordPress',
  description:
    'Import WordPress pages, shared categories and references without rewriting content. Convert bodies to editable blocks, move referenced media to your storage, then review templates and fidelity before publishing.',
  steps: [
    {
      name: 'preflight',
      label: 'Check migration readiness',
      async run(ctx) {
        await requireImportStorage(ctx.orgId);
        // The engine checks organization storage before creating the workflow.
        // Recheck the remaining migration requirements before source discovery.
        const report = await runMigrationPreflight(ctx.orgId, ctx.siteId, migrationVersion(ctx), {
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
        const helperInfo = helperKey ? await new WPHelperClient(url, helperKey).info() : null;
        if (helperInfo) {
          const [major, minor, patch] = helperInfo.plugin_version.split('.').map(Number);
          if (!(major > 0 || minor > 3 || (minor === 3 && patch >= 2))) {
            throw new Error(`Update Typeroll Helper in WordPress to 0.3.2 or later before importing. Installed: ${helperInfo.plugin_version}. Shared category export is required.`);
          }
        }
        ctx.log(`Reading WordPress site information from ${url}.`);
        const info = helperInfo ?? await client.siteInfo();
        ctx.log(`Found "${info.name}" — ${info.description ?? 'no description'}`);
        const helperOk = Boolean(helperInfo);
        const sourceLanguage = helperInfo?.language ?? null;
        if (helperInfo) {
          ctx.log(`Typeroll Helper v${helperInfo.plugin_version}. ACF: ${helperInfo.acf_active ? 'yes' : 'no'}. Language: ${sourceLanguage ?? 'unknown'}.`);
        } else {
          ctx.log('Using standard WordPress REST. Only REST-exposed content types, taxonomies and custom fields are available; review source coverage before launch.');
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
        const existing = await vstore.settings(ctx.orgId, ctx.siteId, migrationVersion(ctx));
        const looksUnconfigured =
          !existing ||
          existing.site_name === 'New Site' ||
          existing.site_name === 'ACME Studio';

        const patch: Partial<SiteSettings> = {};
        if (looksUnconfigured) {
          patch.site_name = normalizeWordPressPlainText(String(ctx.state.site_name ?? 'My Site'));
          if (ctx.state.site_description) {
            patch.tagline = normalizeWordPressPlainText(String(ctx.state.site_description));
          }
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
              setIfMissing(
                'default_meta_description',
                seo.default_meta_description
                  ? normalizeWordPressPlainText(seo.default_meta_description)
                  : undefined,
              );
              setIfMissing('default_og_image',         seo.default_og_image ?? undefined);

              if (seo.organization && (seo.organization.name || seo.organization.logo)) {
                const existingOrg = existing?.organization ?? {};
                patch.organization = {
                  name: existingOrg.name ?? (
                    seo.organization.name
                      ? normalizeWordPressPlainText(seo.organization.name)
                      : undefined
                  ),
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
          await vstore.writeSettings(ctx.orgId, ctx.siteId, migrationVersion(ctx), patch);
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

        const created: StoredContentTypeRef[] = [];

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
            if (!items.length) continue;
            await registerContentType(ctx, type.slug, type.name, type.rest_base || type.slug, items.map(helperToWP) as WPItem[], created);
          }
        } else {
          // Standard REST path. Won't see types with show_in_rest=false.
          const client = new WPClient(url);
          const types = await client.listCustomPostTypes();
          ctx.log(`Standard REST: ${types.length} custom post type(s) visible.`);
          for (const type of types) {
            let items: WPItem[];
            try {
              items = await client.listItemsOfType(type.rest_base);
            } catch (e) {
              throw new Error(`Could not read content type "${type.slug}": ${e instanceof Error ? e.message : e}`);
            }
            if (!items.length) {
              ctx.log(`Type "${type.slug}" has no items; skipping.`);
              continue;
            }
            await registerContentType(ctx, type.slug, type.name, type.rest_base || type.slug, items, created);
          }
        }

        return { state: { content_types_created: created } };
      },
    },

    {
      name: 'extract_content',
      label: 'Import shared categories, page content and media',
      async run(ctx) {
        const url = String(ctx.state.wp_url);
        const sourceOrigin = new URL(url).origin;
        const helperActive = Boolean(ctx.state.helper_active);
        const helperKey = ctx.state.helper_api_key as string | null;

        const transfer = new WPMediaTransfer(
          ctx.orgId,
          ctx.siteId,
          ctx.store
        );
        const mediaAvailability = await mediaTransferAvailability(ctx.orgId, ctx.siteId);
        if (!mediaAvailability.configured) {
          throw new Error('Import storage is not ready. Connect and verify organization media storage before importing.');
        } else {
          ctx.log(`Imported media will be saved to ${mediaAvailability.destination}.`);
        }

        // Ensure an article content type exists so WordPress posts can be
        // imported as pages (route_template /blog/{slug}) instead
        // of as flat pages with slash-slugs. See docs/page-slug-audit.md
        // for the motivation; the legacy slash-slug path is no longer used
        // for new imports.
        const postsContentType = await ensurePostsContentType(
          ctx.store,
          ctx.orgId,
          ctx.siteId,
          migrationVersion(ctx),
        );

        // Collect items to process.
        const pages: WPPage[] = [];
        const posts: WPPage[] = [];
        const customItems: Array<{ ref: StoredContentTypeRef; item: WPItem }> = [];

        const customRefs = (ctx.state.content_types_created ?? []) as StoredContentTypeRef[];

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
              throw new Error(`Failed to list ${ref.source_slug}: ${e instanceof Error ? e.message : e}`);
            }
          }
        }

        const entries = [
          ...pages.map(item => ({ item: item as WPItem, sourceType: 'page', targetType: 'page' })),
          ...posts.map(item => ({ item: item as WPItem, sourceType: 'post', targetType: postsContentType })),
          ...customItems.map(({ ref, item }) => ({ item, sourceType: ref.source_slug, targetType: ref.name })),
        ];
        const pageIdFor = (item: WPPage, sourceType: string): string => sourceType === 'page' && isLikelyHome(item, url) ? 'home' : `wp-${sourceType}-${item.id}`;
        const parentIds = new Map(entries.map(({ item, sourceType }) => [`${sourceType}:${item.id}`, pageIdFor(item, sourceType)]));

        if (!helperActive || !helperKey) {
          const items = [...pages, ...posts, ...customItems.map(value => value.item)];
          const mediaIds = items.map(item => item.featured_media ?? 0).filter(Boolean);
          if (mediaIds.length) {
            const media = await new WPClient(url).getMediaBatch(mediaIds);
            for (const item of items) if (item.featured_media) {
              const image = media.get(item.featured_media);
              if (!image) throw new Error(`Featured media ${item.featured_media} could not be read for page ${item.id}.`);
              Object.assign(item, { _featured_url: image.source_url, _featured_alt: image.alt_text ?? '' });
            }
          }
        }

        // Fetch shared terms separately. An unavailable taxonomy endpoint must
        // fail visibly rather than silently dropping category membership.
        const taxonomyClient = helperActive && helperKey ? new WPHelperClient(url, helperKey) : new WPClient(url);
        const sourceTypes = new Set(['page', 'post', ...customRefs.map(ref => ref.source_slug)]);
        const taxonomies = (await taxonomyClient.listTaxonomies()).filter(taxonomy => taxonomy.types.some(type => sourceTypes.has(type)));
        const taxonomySources: TaxonomySource[] = [];
        for (const taxonomy of taxonomies) taxonomySources.push({ taxonomy, terms: await taxonomyClient.listTerms(taxonomy) });
        const taxonomyPlan = planTaxonomyImport(taxonomySources, sourceOrigin, new Date().toISOString());
        // Validate all references before creating category pages or importing bodies.
        for (const { item, sourceType } of entries) {
          taxonomyPlan.valuesFor(item, sourceType);
          taxonomyPlan.parentFor(item, sourceType);
          if (item.parent && !parentIds.has(`${sourceType}:${item.parent}`)) {
            throw new Error(`Missing parent ${sourceType}:${item.parent} for ${item.id}; include the parent page before importing.`);
          }
        }
        const existingPages = await vstore.pages(ctx.orgId, ctx.siteId, migrationVersion(ctx));
        const existingTypes = await vstore.contentTypes(ctx.orgId, ctx.siteId, migrationVersion(ctx));
        const resolvedPaths = new Map(existingPages.map(page => [page.id, contentPagePath(page,
          existingTypes.find(type => type.id === (page.content_type ?? 'page')) ?? DEFAULT_CONTENT_TYPE)]));
        const sourcePages = [
          ...taxonomyPlan.pages.map(page => ({ id: page.id, path: page.path!, url: page.old_wp_url! })),
          ...entries.map(({ item, sourceType }) => ({
            id: pageIdFor(item, sourceType), path: pathFromUrl(item.link, sourceOrigin) ?? `/${item.slug}`, url: item.link,
          })),
        ];
        const existingById = new Map(existingPages.map(page => [page.id, page]));
        const existingByPath = new Map(existingPages.flatMap(page => resolvedPaths.get(page.id) ? [[resolvedPaths.get(page.id)!.replace(/\/+$/, '') || '/', page] as const] : []));
        const plannedPaths = new Map<string, string>();
        for (const candidate of sourcePages) {
          const normalizedPath = candidate.path.replace(/\/+$/, '') || '/';
          const planned = plannedPaths.get(normalizedPath);
          if (planned && planned !== candidate.id) throw new Error(`Source URLs collide at ${candidate.path}; map the archive and page before importing.`);
          plannedPaths.set(normalizedPath, candidate.id);
          const sameId = existingById.get(candidate.id);
          const samePath = existingByPath.get(normalizedPath);
          const conflict = sameId && sameId.old_wp_url !== candidate.url ? sameId : samePath && samePath.id !== candidate.id ? samePath : undefined;
          if (conflict) throw new Error(`Import conflicts with existing page ${conflict.id} at ${candidate.path}; map the existing page before importing.`);
        }
        for (const contentType of taxonomyPlan.contentTypes) {
          const existing = await vstore.contentType(ctx.orgId, ctx.siteId, migrationVersion(ctx), contentType.name);
          if (existing && contentType.fields.some(field => !existing.fields.some(value => value.name === field.name && value.type === field.type))) {
            throw new Error(`Taxonomy schema ${contentType.name} changed. Review its field mapping before importing.`);
          }
        }
        // Declare reference fields on the owning content type, not copies of
        // term names, icons or other shared metadata on each article.
        for (const [sourceType, targetType] of [['page', 'page'], ['post', postsContentType], ...customRefs.map(ref => [ref.source_slug, ref.name])]) {
          const sourceItems = entries.filter(entry => entry.sourceType === sourceType).map(entry => entry.item);
          const customFields = sourceItems.length ? inferContentType({ slug: sourceType, name: sourceType, rest_base: sourceType }, sourceItems).fields : [];
          const fields = [...customFields, ...taxonomyPlan.fieldsFor(sourceType)];
          if (!fields.length) continue;
          const existing = await vstore.contentType(ctx.orgId, ctx.siteId, migrationVersion(ctx), targetType);
          for (const field of fields) {
            const previous = existing?.fields.find(value => value.name === field.name);
            if (previous && (previous.type !== field.type || previous.ref_content_type !== field.ref_content_type)) {
              throw new Error(`Field ${targetType}.${field.name} conflicts with the imported field mapping.`);
            }
          }
          await ctx.store.setDoc(paths.contentType(ctx.orgId, ctx.siteId, targetType, migrationVersion(ctx)), {
            ...(existing ?? { name: targetType, label_singular: 'Page', label_plural: 'Pages', route_template: '/{slug}', created_at: new Date().toISOString() }),
            fields: [...(existing?.fields ?? []), ...fields.filter(field => !existing?.fields.some(value => value.name === field.name))],
          });
        }
        for (const contentType of taxonomyPlan.contentTypes) {
          await ctx.store.createDocIfMissing(paths.contentType(ctx.orgId, ctx.siteId, contentType.name, migrationVersion(ctx)), contentType);
        }

        const targetTypes = new Map((await vstore.contentTypes(ctx.orgId, ctx.siteId, migrationVersion(ctx))).map(type => [type.id, type]));

        const total = pages.length + posts.length + customItems.length;
        ctx.log(`Importing ${pages.length} page(s), ${posts.length} post(s), ${customItems.length} custom-type item(s)…`);

        let done = 0;
        let skippedExisting = 0;
        const conversionReview: Array<{ page_id: string; notes: string[]; html_blocks: number }> = [];
        let imagesMoved = 0;
        const slugMap: Record<string, string> = {};
        const sourceRedirectCache = new Map<string, Promise<string>>();

        // ── per-page helpers ─────────────────────────────────────────────

        const moveImagesAndBuildMap = async (
          rawHtml: string,
          featuredOldUrl: string | null,
          featuredAlt: string,
          mediaBaseUrl: string = sourceOrigin,
        ): Promise<{ mediaMap: Map<string, string>; featuredNewUrl: string | null }> => {
          const urls = extractImageUrls(rawHtml, { baseUrl: mediaBaseUrl });
          const records = await mapTransfers(urls, async (u) => {
              try {
                const r = await transfer.ensureUrl(u.url, u.alt);
                imagesMoved++;
                return r;
              } catch (e) {
                throw new Error(`Image transfer failed for ${u.url}; retry the import after resolving storage/source access. ${e instanceof Error ? e.message : e}`);
              }
            });
          let featuredNewUrl: string | null = null;
          if (featuredOldUrl) {
            try {
              const r = await transfer.ensureUrl(new URL(featuredOldUrl, mediaBaseUrl).href, featuredAlt);
              records.push(r);
              imagesMoved++;
              featuredNewUrl = r.cdnUrl;
            } catch (e) {
              throw new Error(`Featured image transfer failed; retry the import after resolving storage/source access. ${e instanceof Error ? e.message : e}`);
            }
          }
          const mediaMap = buildMediaMap(records.filter((r): r is NonNullable<typeof r> => r != null));
          return { mediaMap, featuredNewUrl };
        };

        // Term descriptions and images use the same verified media path as
        // article bodies. Do not strand shared media at the WordPress origin.
        for (const page of taxonomyPlan.pages) {
          const { id, ...doc } = page;
          if (!existingById.has(id)) {
            const source = taxonomySources.find(value => value.taxonomy.slug && `wp_taxonomy_${value.taxonomy.slug.replace(/-/g, '_')}` === page.content_type)!;
            const term = source.terms.find(value => `wp-term-${source.taxonomy.slug}-${value.id}` === id)!;
            const { mediaMap } = await moveImagesAndBuildMap(term.description ?? '', null, '', term.link);
            const converted = htmlToBlocks(cleanWordPressHtml(term.description ?? '', { mediaMap, sourceOrigin, mediaBaseUrl: term.link, collapseWhitespace: true }));
            for (const field of taxonomyPlan.contentTypes.find(type => type.name === page.content_type)!.fields) {
              if (field.type === 'image' && typeof doc.fields?.[field.name] === 'string' && doc.fields[field.name]) {
                const image = await transfer.ensureUrl(doc.fields[field.name] as string, '');
                doc.fields[field.name] = image.cdnUrl;
              }
            }
            doc.blocks = [page.blocks![0], ...converted.blocks, page.blocks![page.blocks!.length - 1]];
            if (converted.notes.length) conversionReview.push({ page_id: id, notes: converted.notes, html_blocks: converted.summary.find(entry => entry.block_type === 'core/html')?.count ?? 0 });
            await ctx.store.createDocIfMissing(paths.page(ctx.orgId, ctx.siteId, id, migrationVersion(ctx)), doc);
          }
          await addInventoryUrl(ctx.store, ctx.orgId, ctx.siteId, { path: page.path!, full_url: page.old_wp_url!, source: 'taxonomy' });
        }

        const importAndSave = async (
          item: WPItem,
          sourceType: string,
          contentType: string,
        ): Promise<void> => {
          // Track this item's old URL in the inventory.
          await addInventoryUrl(ctx.store, ctx.orgId, ctx.siteId, {
            path: pathFromUrl(item.link, sourceOrigin) ?? '/' + item.slug,
            full_url: item.link,
            source: `rest-${sourceType}`,
          });
          await addWordPressBareSlugGuess(
            ctx.store, ctx.orgId, ctx.siteId, item.link, item.slug, sourceOrigin,
          );

          const isHome = sourceType === 'page' && isLikelyHome(item, url);
          const pageId = pageIdFor(item, sourceType);
          const existing = existingById.get(pageId);
          if (existing) {
            slugMap[item.link] = existing.path ?? pathFromUrl(item.link, sourceOrigin) ?? `/${item.slug}`;
            skippedExisting++; done++;
            ctx.log(`[${item.slug}] Already imported; preserving saved content and edits.`);
            return;
          }

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
            featuredAlt,
            item.link,
          );

          const cleaned = cleanWordPressHtml(rawHtml, {
            mediaMap,
            sourceOrigin,
            mediaBaseUrl: item.link,
            collapseWhitespace: true,
          });

          const featuredImage = featuredNewUrl
            ? { url: featuredNewUrl, alt: featuredAlt }
            : undefined;
          const rawSlug = item.slug || slugify(normalizeWordPressPlainText(item.title.rendered)) || `page-${item.id}`;

          // SEO: prefer the helper plugin's normalized `seo` field (works for
          // Yoast/RankMath/SEOPress/AIOSEO). Fall back to yoast_head_json from
          // public WP REST (Yoast-only). Default to the page title when both
          // are empty so seo_title is never blank.
          const helperSEO = (item as unknown as { _seo?: HelperItem['seo'] })._seo;
          const yoast = item.yoast_head_json;
          const seoTitle = normalizeWordPressPlainText(
            helperSEO?.title ?? yoast?.title ?? item.title.rendered,
          );
          const rawSeoDesc = helperSEO?.description ?? yoast?.description;
          const seoDesc = rawSeoDesc ? normalizeWordPressPlainText(rawSeoDesc) : undefined;
          const seoCanon = helperSEO?.canonical ?? yoast?.canonical;
          const noindex  = helperSEO?.noindex === true ? true : undefined;
          const rawOgImage = helperSEO?.og_image ?? yoast?.og_image?.[0]?.url;
          const ogImage = rawOgImage
            ? (mediaMap.get(rawOgImage) ?? (await transfer.ensureUrl(new URL(rawOgImage, item.link).href, '')).cdnUrl)
            : featuredImage?.url;

          const path = isHome ? '/' : pathFromUrl(item.link, sourceOrigin) ?? `/${rawSlug}`;
          const useBlocks = String(ctx.config.target_content_mode ?? 'blocks') !== 'html';
          const converted = htmlToBlocks(cleaned);
          if (/<(?:form|script|object|embed)\b/i.test(rawHtml)) converted.notes.push('Source contains interactive markup. Recreate and test the corresponding Form or Extension; imported content alone does not activate it.');
          if (converted.notes.length) conversionReview.push({ page_id: pageId, notes: converted.notes, html_blocks: converted.summary.find(entry => entry.block_type === 'core/html')?.count ?? 0 });
          const fieldSchema = targetTypes.get(contentType)?.fields ?? [];
          const fields = { ...projectItemFields(item, fieldSchema, featuredImage?.url), ...taxonomyPlan.valuesFor(item, sourceType) };
          // Existing article types may use hero_image; retain their declared mapping.
          if (fieldSchema.some(field => field.name === 'hero_image')) fields.hero_image = featuredImage?.url ?? '';
          for (const field of fieldSchema) {
            const value = fields[field.name];
            if (field.type === 'image' && typeof value === 'string' && value && value !== featuredImage?.url) {
              fields[field.name] = (await transfer.ensureUrl(new URL(value, item.link).href, '')).cdnUrl;
            }
          }
          const doc: Omit<Page, 'id'> = {
            title: normalizeWordPressPlainText(item.title.rendered),
            slug: isHome ? '' : rawSlug, path, content_type: contentType,
            fields,
            parent: item.parent ? parentIds.get(`${sourceType}:${item.parent}`) : taxonomyPlan.parentFor(item, sourceType),
            sort_order: item.menu_order,
            content_mode: useBlocks ? 'blocks' : 'html',
            ...(useBlocks ? { blocks: converted.blocks } : { html_content: cleaned }),
            seo_title: seoTitle, seo_description: seoDesc, og_image: ogImage, canonical_url: seoCanon, noindex,
            kind: sourceType === 'page' ? 'page' : 'article', status: 'review',
            old_wp_url: item.link, ai_generated: false,
            date_published: item.date, date_updated: item.modified,
          };
          await ctx.store.createDocIfMissing(paths.page(ctx.orgId, ctx.siteId, pageId, migrationVersion(ctx)), doc);
          slugMap[item.link] = path;
          done++;
          if (done % 3 === 0 || done === total) {
            ctx.setProgress({ total, completed: done });
            ctx.log(`Done ${done}/${total} — existing preserved: ${skippedExisting}, images moved: ${imagesMoved}`);
          }
        };

        for (const { item, sourceType, targetType } of entries) await importAndSave(item, sourceType, targetType);

        ctx.log(
          `Import complete. Existing pages preserved: ${skippedExisting}, shared terms: ${taxonomyPlan.pages.length}, images moved: ${imagesMoved}. Review desktop/mobile layout and integrations before publishing.`
        );
        return {
          state: { slug_map: { ...Object.fromEntries(taxonomyPlan.pages.map(page => [page.old_wp_url!, page.path!])), ...slugMap }, imported_count: done, images_moved: imagesMoved, shared_terms: taxonomyPlan.pages.length, skipped_existing: skippedExisting, conversion_review: conversionReview },
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
              await ctx.store.setDoc(`${paths.redirects(ctx.orgId, ctx.siteId, migrationVersion(ctx))}/${id}`, redirect);
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
          await ctx.store.setDoc(`${paths.redirects(ctx.orgId, ctx.siteId, migrationVersion(ctx))}/${id}`, redirect);
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
        const { summary } = await analyzeCoverage(ctx.store, ctx.orgId, ctx.siteId, migrationVersion(ctx));
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
        const collectionsCreated = (ctx.state.content_types_created ?? []) as StoredContentTypeRef[];
        const coverage = ctx.state.coverage as
          | { total: number; migrated: number; redirected: number; unhandled: number; excluded: number }
          | undefined;
        const unhandled = coverage?.unhandled ?? 0;
        const message =
          unhandled > 0
            ? `Migration complete. ${unhandled} URL(s) are unhandled — resolve them on the Migration page before switching DNS, or mark them as intentional 404s.`
            : 'Migration complete. Every discovered URL is handled.';
        return reviewGate(message + ' Content is imported for review, not approved for launch. Compare representative articles, an archive and the home page on desktop and mobile. Check shared categories, templates, media and live integrations; record intentional differences.', {
            imported_pages: ctx.state.imported_count,
            images_moved: ctx.state.images_moved,
            shared_terms: ctx.state.shared_terms,
            skipped_existing: ctx.state.skipped_existing,
            conversion_review: ctx.state.conversion_review,
            visual_review: 'required',
            content_types_created: collectionsCreated.map((c) => c.name),
            redirects: Object.keys((ctx.state.slug_map ?? {}) as Record<string, string>).length,
            coverage,
          }
        );
      },
    },
  ],
};

// ─── Helpers ─────────────────────────────────────────────────────────────

async function registerContentType(
  ctx: Parameters<NonNullable<(typeof migrationWorkflow.steps)[number]['run']>>[0],
  slug: string,
  name: string,
  restBase: string,
  sample: WPItem[],
  out: StoredContentTypeRef[]
): Promise<void> {
  const def = inferContentType({ slug, name, rest_base: restBase } as Parameters<typeof inferContentType>[0], sample);
  const collectionPath = paths.contentType(ctx.orgId, ctx.siteId, def.name, migrationVersion(ctx));
  const existing = await vstore.contentType(ctx.orgId, ctx.siteId, migrationVersion(ctx), def.name);
  if (existing) {
    const missing = def.fields.filter(field => !existing.fields.some(value => value.name === field.name && value.type === field.type));
    if (missing.length) throw new Error(`Content type "${def.name}" needs a reviewed field mapping: ${missing.map(field => field.name).join(', ')}`);
    ctx.log(`Content type "${def.name}" already exists — keeping schema.`);
  } else {
    const doc: Omit<ContentType, 'id'> = {
      name: def.name,
      label_singular: def.label_singular,
      label_plural: def.label_plural,
      icon: def.icon,
      fields: def.fields,
      route_template: `/${def.name}/{slug}`,
      sort_field: 'date_published',
      sort_dir: 'desc',
      created_at: new Date().toISOString(),
    };
    await ctx.store.setDoc(collectionPath, doc);
    ctx.log(`Created content type "${def.label_plural}" (${def.name}) with ${def.fields.length} field(s).`);
  }
  out.push({
    source_slug: slug,
    source_rest_base: restBase,
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
    _taxonomies: h.taxonomies,
    _primary_terms: h.primary_terms,
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

function makeSafeDocId(s: string): string {
  return s.replace(/[\/\\]/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || `doc-${Date.now()}`;
}

/** Reuse an existing article content type or create a default native Page template. */
async function ensurePostsContentType(
  store: ReadWriteStore,
  orgId: string,
  siteId: string,
  versionId: string = MAIN_VERSION_ID,
): Promise<string> {
  const COLL_NAME = 'posts';
  const existing = await vstore.contentType(orgId, siteId, versionId, COLL_NAME);
  if (existing) return existing.name;

  // Also check if a content type with /blog/{slug} routing exists under another
  // name (e.g. `blog`) so we don't double-create.
  const all = await vstore.contentTypes(orgId, siteId, versionId);
  const blogish = all.find((c) =>
    typeof c.route_template === 'string' &&
    /^\/(blog|posts|news|articles)\/\{slug\}$/.test(c.route_template),
  );
  if (blogish) return blogish.name;

  const templateBase = 'article-default';
  let templateId = templateBase, suffix = 2;
  while (!await store.createDocIfMissing(paths.pageTemplate(orgId, siteId, templateId, versionId), {
    name: templateId, label: 'Article', status: 'published', created_at: new Date().toISOString(),
    blocks: [{ id: 'article', type: 'core/section', data: { width: 'narrow' }, children: [
      { id: 'title', type: 'template/page_title', data: { size: 'article' } },
      { id: 'date', type: 'template/page_date', data: { field: 'date_published' } },
      { id: 'body', type: 'template_content_slot', data: {} },
    ] }],
  })) templateId = `${templateBase}-${suffix++}`;
  const def: Omit<ContentType, 'id'> = {
    name: COLL_NAME, label_singular: 'Article', label_plural: 'Articles', icon: 'file-text',
    sort_field: 'date_published', sort_dir: 'desc', route_template: '/blog/{slug}', template: templateId,
    fields: [{ name: 'excerpt', type: 'textarea', label: 'Excerpt' }, { name: 'hero_image', type: 'image', label: 'Hero image' }],
    created_at: new Date().toISOString(),
  };
  await store.setDoc(paths.contentType(orgId, siteId, COLL_NAME, versionId), def);
  return COLL_NAME;
}
