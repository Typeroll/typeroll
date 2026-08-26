// Migration readiness — the checks that must pass BEFORE content starts
// moving, not after.
//
// Every item here shares one property: when it's missing, the migration
// still appears to succeed. Pages import, previews render, the customer
// signs off — and something is quietly wrong in a way that only surfaces
// weeks later:
//
//   - No R2: every `<img>` keeps its WordPress URL. The new site looks
//     perfect and is still served by the old host. The day the customer
//     cancels that hosting, every image on every page breaks at once.
//   - Stub hosting adapter: "deploys" return a fake id and no URL, so
//     nothing is actually published — but the job goes green.
//   - No verification origin: the pre-cutover parity check has nothing to
//     test against, so the one gate that would catch lost URLs can't run.
//
// The expensive part of a migration is the content work. Discovering a
// blocker afterwards means redoing it, which is why this runs first and
// why `blocker` means the migration workflow refuses to start.
//
// Checks are read-only and cheap: env lookups plus at most three small
// datastore reads.

import { paths } from '@typeroll/shared';
import type { Form, Partial as PartialDoc, Site, SiteIntegrations } from '@typeroll/shared';
import { getStore } from './datastore';
import { vstore } from './version-store';
import { readMediaConfig } from './wp/media';
import { getHostingAdapter } from './hosting';
import { publicUrlsFor } from './site-public-urls';

export type CheckSeverity = 'blocker' | 'warning';
export type CheckStatus = 'ok' | 'fail';

export interface PreflightCheck {
  id: string;
  label: string;
  status: CheckStatus;
  /** Severity if this check fails. Meaningless when status is 'ok'. */
  severity: CheckSeverity;
  /** What the current state is, in one sentence. */
  detail: string;
  /** What to do about it. Absent when the check passes. */
  fix?: string;
}

export interface PreflightOptions {
  /** Origin of the site being migrated FROM. When given, the source is
   *  probed too — you cannot migrate what you can't fetch, and finding that
   *  out before the content work rather than during it is the whole point of
   *  this module. */
  sourceUrl?: string;
  /** Injected for tests; the source probe is the only network call here. */
  fetchImpl?: typeof fetch;
}

export interface PreflightReport {
  /** False when any blocker failed. The migration workflow refuses to start. */
  ready: boolean;
  blockers: PreflightCheck[];
  warnings: PreflightCheck[];
  checks: PreflightCheck[];
}

export async function runMigrationPreflight(
  orgId: string,
  siteId: string,
  versionId: string,
  opts: PreflightOptions = {},
): Promise<PreflightReport> {
  const site = await getStore().getDoc<Site>(paths.site(orgId, siteId));
  const checks: PreflightCheck[] = [];

  // ─── Blockers ──────────────────────────────────────────────────────────

  const media = readMediaConfig();
  checks.push(media
    ? {
        id: 'media_storage',
        label: 'Media storage (R2)',
        status: 'ok',
        severity: 'blocker',
        detail: `Configured — images transfer to ${media.publicBaseUrl}.`,
      }
    : {
        id: 'media_storage',
        label: 'Media storage (R2)',
        status: 'fail',
        severity: 'blocker',
        detail:
          'Not configured. Imported pages would keep their original image URLs, so the new site ' +
          'would still be served images by the old host — invisible until that hosting is cancelled, ' +
          'at which point every image breaks at once.',
        fix: 'Set R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_PUBLIC_BASE_URL on the portal, then re-run this check.',
      });

  const adapter = getHostingAdapter(site?.hosting_adapter ?? 'cloudflare', site?.hosting_config);
  checks.push(adapter.name !== 'stub'
    ? {
        id: 'hosting',
        label: 'Hosting adapter',
        status: 'ok',
        severity: 'blocker',
        detail: `Deploys go to ${adapter.name}.`,
      }
    : {
        id: 'hosting',
        label: 'Hosting adapter',
        status: 'fail',
        severity: 'blocker',
        detail:
          'No hosting credentials — deploys run against the stub adapter, which returns a job id and ' +
          'publishes nothing. Builds would report success while the site never goes live.',
        fix: 'Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, and make sure the site has a Pages project (hosting_config.pages_project).',
      });

  // ─── Warnings ──────────────────────────────────────────────────────────

  const urls = site ? publicUrlsFor({ ...site, id: siteId }) : null;
  const verifyOrigin = urls?.fallback ?? urls?.production ?? null;
  checks.push(verifyOrigin
    ? {
        id: 'verification_origin',
        label: 'Pre-cutover verification URL',
        status: 'ok',
        severity: 'warning',
        detail: `URL parity can be checked against ${verifyOrigin} while the domain still points at the old site.`,
      }
    : {
        id: 'verification_origin',
        label: 'Pre-cutover verification URL',
        status: 'fail',
        severity: 'warning',
        detail:
          'The site has no fallback subdomain and no live domain, so verify_migration_urls has nothing to ' +
          'request against. The gate that catches lost URLs before DNS moves cannot run.',
        fix: 'Set SITES_BASE_DOMAIN (or provision a Pages project) so the site gets a fallback URL — or pass target_origin explicitly to the parity check.',
      });

  checks.push(process.env.ANTHROPIC_API_KEY
    ? {
        id: 'ai_reconstruction',
        label: 'AI reconstruction',
        status: 'ok',
        severity: 'warning',
        detail: 'Imported pages are rebuilt in the target design.',
      }
    : {
        id: 'ai_reconstruction',
        label: 'AI reconstruction',
        status: 'fail',
        severity: 'warning',
        detail:
          'No ANTHROPIC_API_KEY. The in-portal migration falls back to the cleaned source HTML, which ' +
          'carries the old design rather than the new one.',
        fix: 'Set ANTHROPIC_API_KEY, or drive the migration from an agent (Claude Code / MCP) that does the reconstruction itself.',
      });

  // Forms: only a problem once the site actually has one. A site with no
  // forms yet isn't misconfigured — it just hasn't got there.
  const forms = await getStore().listDocs<Form>(paths.forms(orgId, siteId));
  if (forms.length > 0) {
    const integrations = await getStore().getDoc<SiteIntegrations>(paths.integrations(orgId, siteId));
    checks.push(integrations?.email
      ? {
          id: 'forms_email',
          label: 'Form notification email',
          status: 'ok',
          severity: 'warning',
          detail: `${forms.length} form(s); notifications send via ${integrations.email.type}.`,
        }
      : {
          id: 'forms_email',
          label: 'Form notification email',
          status: 'fail',
          severity: 'warning',
          detail:
            `${forms.length} form(s) exist but no email connector is configured. Submissions are stored ` +
            'and nobody is notified — which looks fine in testing and loses enquiries in production.',
          fix: 'Configure an email connector in Settings → Integrations (admin only — this is deliberately not writable from an API key or the chat AI).',
        });
  }

  // Design reference: the migration's whole posture is "rebuild the old
  // content in the NEW design". With no header/footer and no example page
  // there is no new design to rebuild into.
  const [partials, pages] = await Promise.all([
    vstore.partials(orgId, siteId, versionId),
    vstore.pages(orgId, siteId, versionId),
  ]);
  const hasHeader = partials.some((p: PartialDoc) => p.kind === 'header' && p.status === 'published');
  const examplePages = pages.filter((p) => p.status === 'published' || p.status === 'unlisted');
  checks.push(hasHeader && examplePages.length > 0
    ? {
        id: 'design_reference',
        label: 'Target design',
        status: 'ok',
        severity: 'warning',
        detail: `Header partial plus ${examplePages.length} live page(s) to imitate.`,
      }
    : {
        id: 'design_reference',
        label: 'Target design',
        status: 'fail',
        severity: 'warning',
        detail:
          'No published header partial and/or no live page. A migration rebuilds old content in the ' +
          'TARGET design — with nothing to imitate, imported pages inherit the old site\'s look.',
        fix: 'Build the design first (tr-new-site / tr-brand): settings, header + footer, and one or two example pages.',
      });

  // ─── Source site ───────────────────────────────────────────────────────
  // Only when the caller says what it's migrating from. A readiness check on
  // a site that isn't importing anything shouldn't invent a source.
  if (opts.sourceUrl) {
    checks.push(...await checkSource(opts.sourceUrl, opts.fetchImpl ?? fetch));
  }

  const blockers = checks.filter((c) => c.status === 'fail' && c.severity === 'blocker');
  const warnings = checks.filter((c) => c.status === 'fail' && c.severity === 'warning');
  return { ready: blockers.length === 0, blockers, warnings, checks };
}

/**
 * Probe the source site: is it reachable at all, and does it expose the WP
 * REST API?
 *
 * Reachability is a blocker — an import from a host that answers 403 to our
 * IP produces empty pages, and every minute spent on the target before
 * discovering that is wasted. REST availability is only a warning: the
 * importer has a scrape fallback, it just loses ACF/custom fields and
 * anything the builder renders client-side.
 */
async function checkSource(rawUrl: string, doFetch: typeof fetch): Promise<PreflightCheck[]> {
  let origin: string;
  try {
    const u = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
    origin = u.origin;
  } catch {
    return [{
      id: 'source_reachable',
      label: 'Source site',
      status: 'fail',
      severity: 'blocker',
      detail: `"${rawUrl}" is not a usable URL.`,
      fix: 'Pass the source site as an absolute URL, e.g. https://oldsite.com.',
    }];
  }

  const root = await probe(doFetch, origin);
  if (!root.ok) {
    return [{
      id: 'source_reachable',
      label: 'Source site',
      status: 'fail',
      severity: 'blocker',
      detail: `${origin} did not answer: ${root.error}. An import would produce empty pages.`,
      fix: 'Check the URL, that the old site is still up, and that it does not block server-side requests (Cloudflare bot protection, IP allowlists, HTTP auth on a staging host).',
    }];
  }
  if (root.status >= 400) {
    const botBlocked = root.status === 403 || root.status === 401 || root.status === 429;
    return [{
      id: 'source_reachable',
      label: 'Source site',
      status: 'fail',
      severity: 'blocker',
      detail: botBlocked
        ? `${origin} answered ${root.status} — the old host is refusing our requests, so imported pages would be empty or contain a block page.`
        : `${origin} answered ${root.status}.`,
      fix: botBlocked
        ? 'Ask the customer to allowlist the importer (or migrate from an export / a staging copy without bot protection). A scraped block page reads as real content.'
        : 'Verify the URL — pass the site root, not a subpage.',
    }];
  }

  const checks: PreflightCheck[] = [{
    id: 'source_reachable',
    label: 'Source site',
    status: 'ok',
    severity: 'blocker',
    detail: `${origin} answers ${root.status}.`,
  }];

  const rest = await probe(doFetch, `${origin}/wp-json`);
  const restOk = rest.ok && rest.status < 400 && (rest.contentType?.includes('json') ?? false);
  checks.push(restOk
    ? {
        id: 'source_wp_rest',
        label: 'Source WordPress REST API',
        status: 'ok',
        severity: 'warning',
        detail: `${origin}/wp-json responds — pages, posts and custom types can be read structurally.`,
      }
    : {
        id: 'source_wp_rest',
        label: 'Source WordPress REST API',
        status: 'fail',
        severity: 'warning',
        detail:
          `${origin}/wp-json is not available (${rest.ok ? `status ${rest.status}` : rest.error}). ` +
          'The importer falls back to scraping public HTML, which loses ACF/custom fields and anything ' +
          'the page builder renders client-side.',
        fix: 'Enable the WP REST API, or install the Typeroll helper plugin and pass helper_api_key — it also exposes custom post types with show_in_rest=false. If the source is not WordPress, ignore this.',
      });
  return checks;
}

type Probe =
  | { ok: true; status: number; contentType?: string }
  | { ok: false; error: string };

async function probe(doFetch: typeof fetch, url: string): Promise<Probe> {
  try {
    const res = await doFetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
      headers: { 'user-agent': 'Typeroll-Migration-Preflight/1.0' },
    });
    void res.body?.cancel?.().catch(() => {});
    return { ok: true, status: res.status, contentType: res.headers.get('content-type') ?? undefined };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** One-line summary for logs and workflow errors. */
export function summarizePreflight(report: PreflightReport): string {
  if (report.ready && report.warnings.length === 0) return 'All migration preflight checks passed.';
  const parts: string[] = [];
  if (report.blockers.length) {
    parts.push(`BLOCKED: ${report.blockers.map((c) => `${c.label} — ${c.detail} Fix: ${c.fix}`).join(' | ')}`);
  }
  if (report.warnings.length) {
    parts.push(`Warnings: ${report.warnings.map((c) => c.label).join(', ')}`);
  }
  return parts.join(' ');
}
