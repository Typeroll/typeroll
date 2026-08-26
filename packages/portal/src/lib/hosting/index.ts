// Hosting adapter interface. Cloudflare Pages is the default, ships with core.
// Additional adapters (Netlify, Vercel, Firebase) can be added without
// touching this file.

import { CloudflarePagesAdapter } from './cloudflare-pages';

export interface DeployOptions {
  environment: 'staging' | 'production';
  siteId: string;
  buildId?: string;
  /** Adapter-specific overrides, sourced from Site.hosting_config so each
   *  customer's deploy targets their own CF Pages project. */
  hostingConfig?: { pages_project?: string };
  /** When set, deploy to a *branch-scoped* preview environment instead of
   *  the production environment of the CF Pages project. The adapter
   *  passes this through to `wrangler pages deploy --branch=<name>`;
   *  CF Pages then serves the deploy at
   *  `https://{branch}.{project}.pages.dev`. Used for non-main version
   *  deploys so each branch gets a stable, shareable URL. */
  branchName?: string;
}

export interface DeployResult {
  deployId: string;
  // url is optional — the stub adapter (no Cloudflare credentials configured)
  // returns no url rather than an `example.com` placeholder, so downstream
  // callers must treat the absent case as "no deploy URL available; ask the
  // user or fall back to the canonical site.domain".
  url?: string;
  environment: 'staging' | 'production';
  createdAt: string;
}

export interface RedirectRule {
  from: string;
  to: string;
  statusCode: 301 | 302;
}

export interface HostingAdapter {
  name: string;
  deploy(buildDir: string, opts: DeployOptions): Promise<DeployResult>;
  configureRedirects(buildDir: string, redirects: RedirectRule[]): Promise<void>;
}

// Stub adapter for when Cloudflare credentials aren't available — returns a
// fake deploy id so the workflow surface can be exercised end-to-end without
// touching the network. Returns no `url` so callers (and agents) get an
// honest "deployed but I don't know where" signal rather than a hardcoded
// placeholder that looked like a real URL.
class StubAdapter implements HostingAdapter {
  name = 'stub';

  async deploy(_buildDir: string, opts: DeployOptions): Promise<DeployResult> {
    return {
      deployId: `dep_stub_${Date.now()}`,
      environment: opts.environment,
      createdAt: new Date().toISOString(),
    };
  }

  async configureRedirects(_buildDir: string, _redirects: RedirectRule[]): Promise<void> {}
}

export function getHostingAdapter(name: string, hostingConfig?: { pages_project?: string }): HostingAdapter {
  switch (name) {
    case 'cloudflare': {
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      const apiToken = process.env.CLOUDFLARE_API_TOKEN;
      // Per-site CF Pages project lives on Site.hosting_config; the env-var
      // form is the legacy shared-project fallback so older sites without
      // a provisioned project keep deploying.
      const projectName = hostingConfig?.pages_project ?? process.env.CLOUDFLARE_PAGES_PROJECT;
      if (!accountId || !apiToken || !projectName) {
        return new StubAdapter();
      }
      return new CloudflarePagesAdapter({ accountId, apiToken, projectName });
    }
    default:
      return new StubAdapter();
  }
}
