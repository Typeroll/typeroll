// Cloudflare Pages deployment adapter.
//
// Delegates to `wrangler pages deploy` rather than driving CF's Direct
// Upload API directly. We previously hand-rolled the upload (hash files,
// dedup via check-missing, POST to /pages/assets/upload) but kept hitting
// CF Error 1101 — their worker would silently change the expected payload
// shape between releases and our reverse-engineered client would break.
// Wrangler is CF's own tool; if anyone keeps the format right, it's them.
//
// Tradeoff: wrangler is ~30MB on disk and adds a process spawn per deploy.
// Worth it for the reliability + freedom from "they changed the API again"
// regressions.

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeployOptions, DeployResult, HostingAdapter, RedirectRule } from './index';

interface CloudflareConfig {
  accountId: string;
  apiToken: string;
  projectName: string;
}

export class CloudflarePagesAdapter implements HostingAdapter {
  name = 'cloudflare';

  constructor(private cfg: CloudflareConfig) {}

  async deploy(buildDir: string, opts: DeployOptions): Promise<DeployResult> {
    if (!fs.existsSync(buildDir)) {
      throw new Error(`Build directory does not exist: ${buildDir}`);
    }
    // Branch precedence:
    //   1. opts.branchName  — explicit override from runDeploy for a non-
    //      main version; CF Pages will serve at <branch>.<project>.pages.dev
    //   2. environment      — production → "main", staging → "staging".
    // Slugify the branch label so CF Pages accepts it (lowercase, [a-z0-9-]).
    const branch =
      opts.branchName
        ? opts.branchName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'preview'
        : opts.environment === 'production' ? 'main' : 'staging';
    const wranglerBin = findWranglerBin();

    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          wranglerBin,
          'pages',
          'deploy',
          buildDir,
          `--project-name=${this.cfg.projectName}`,
          `--branch=${branch}`,
          '--commit-dirty=true',
        ],
        {
          env: {
            ...process.env,
            CLOUDFLARE_ACCOUNT_ID: this.cfg.accountId,
            CLOUDFLARE_API_TOKEN: this.cfg.apiToken,
          },
          stdio: 'pipe',
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', reject);
      child.on('exit', (code) => {
        console.log(`[deploy] wrangler exit=${code}`);
        if (stdout) console.log(`[deploy] wrangler stdout:\n${stdout.slice(-2000)}`);
        if (stderr) console.log(`[deploy] wrangler stderr:\n${stderr.slice(-2000)}`);
        if (code !== 0) {
          reject(new Error(`wrangler pages deploy exited ${code}: ${(stderr || stdout).slice(-500)}`));
          return;
        }
        // Wrangler prints the deployment URL as the last "✨ ... Take a peek over at https://<id>.<project>.pages.dev" line.
        // Fallback URL is branch-aware: production → bare project URL,
        // anything else → branch-prefixed (matches what CF Pages serves).
        const fallback =
          branch === 'main'
            ? `https://${this.cfg.projectName}.pages.dev`
            : `https://${branch}.${this.cfg.projectName}.pages.dev`;
        const url = extractDeployUrl(stdout) ?? fallback;
        const deployId = extractDeployId(stdout) ?? `dep_${Date.now()}`;
        resolve({
          deployId,
          url,
          environment: opts.environment,
          createdAt: new Date().toISOString(),
        });
      });
    });
  }

  async configureRedirects(buildDir: string, redirects: RedirectRule[]): Promise<void> {
    const lines = redirects.map((r) => `${r.from}  ${r.to}  ${r.statusCode}`);
    await fs.promises.writeFile(path.join(buildDir, '_redirects'), lines.join('\n') + '\n');
  }
}

/** Find the wrangler CLI inside the container — workspace-hoisted first,
 *  then the portal package's own node_modules as a fallback. */
function findWranglerBin(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // packages/portal/src/lib/hosting → repo root: 5 levels up; or 4 levels
  // up in a flatter layout.
  const candidates = [
    path.resolve(here, '..', '..', '..', '..', '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
    path.resolve(here, '..', '..', '..', '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
    // Compiled-bundle layout (after astro build): node_modules sit two up
    // from the bundle chunks.
    path.resolve(here, '..', '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
    path.resolve(process.cwd(), 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`Cannot find wrangler binary. Tried:\n  - ${candidates.join('\n  - ')}`);
}

function extractDeployUrl(stdout: string): string | null {
  // Wrangler prints the URL on a "✨" / "Deployment complete!" line.
  // Match either a *.pages.dev URL or the customer's own custom domain.
  const m = stdout.match(/https?:\/\/[\w.-]+\.pages\.dev[\w./-]*/);
  return m ? m[0] : null;
}

function extractDeployId(stdout: string): string | null {
  // The deployment id appears as the subdomain prefix of the .pages.dev URL.
  const m = stdout.match(/https?:\/\/([\w-]+)\.[\w.-]+\.pages\.dev/);
  return m ? m[1] : null;
}
