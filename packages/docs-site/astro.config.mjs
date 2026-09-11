import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';
import { docsTarget } from './scripts/docs-target.mjs';

const target = docsTarget();

export default defineConfig({
  site: target.site,
  base: target.base,
  outDir: target.output,
  integrations: [
    starlight({
      title: 'Typeroll CMS',
      components: { Head: './src/components/DocsHead.astro', PageTitle: './src/components/DocsPageTitle.astro' },
      plugins: [starlightLlmsTxt({
        projectName: 'Typeroll CMS',
        description: 'Documentation for the open-source CMS: visual editing, AI agents, static publishing and self-hosting.',
      })],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/typeroll/typeroll' },
      ],
      editLink: {
        baseUrl: 'https://github.com/typeroll/typeroll/edit/main/packages/docs-site/',
      },
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Introduction', slug: 'getting-started/introduction' },
            { label: 'Install the MCP Server', slug: 'getting-started/mcp-server' },
            { label: 'Your First Site', slug: 'getting-started/first-site' },
          ],
        },
        {
          label: 'Visual editor',
          items: [
            { label: 'Edit pages', slug: 'guides/the-editor' },
            { label: 'Drafts, saving and review', slug: 'tools/drafts-and-saving' },
            { label: 'Blocks and templates', slug: 'tools/blocks' },
          ],
        },
        {
          label: 'Publishing',
          items: [
            { label: 'Connect your accounts', slug: 'guides/customer-publishing' },
            { label: 'Cloudflare hosting and builds', slug: 'publishing/cloudflare' },
            { label: 'Website and media domains', slug: 'publishing/domains' },
            { label: 'Deploy and preview tools', slug: 'tools/deploy' },
          ],
        },
        {
          label: 'Migration',
          items: [
            { label: 'From WordPress', slug: 'guides/wordpress-migration' },
            { label: 'From Squarespace', slug: 'guides/migrate-from-squarespace' },
            { label: 'From Wix', slug: 'guides/migrate-from-wix' },
            { label: 'From Webflow', slug: 'guides/migrate-from-webflow' },
          ],
        },
        {
          label: 'Skills',
          items: [
            { label: 'What are Skills?', slug: 'skills/overview' },
            { label: 'New Site', slug: 'skills/tr-new-site' },
            { label: 'Branding', slug: 'skills/tr-brand' },
            { label: 'Blog', slug: 'skills/tr-blog' },
            { label: 'Forms', slug: 'skills/tr-forms' },
            { label: 'SEO', slug: 'skills/tr-seo' },
            { label: 'Import from URL', slug: 'skills/tr-import-url' },
            { label: 'Migrate from WordPress', slug: 'skills/tr-migrate-wp' },
            { label: 'Migrate a multisite', slug: 'skills/tr-migrate-multisite' },
          ],
        },
        {
          label: 'Core modules',
          items: [
            { label: 'Overview', slug: 'apps/overview' },
            {
              label: 'Analytics',
              items: [
                { label: 'Overview', slug: 'apps/analytics' },
                { label: 'Attribution', slug: 'apps/funnel-attribution' },
                { label: 'Events & conversions', slug: 'apps/events' },
              ],
            },
            { label: 'Forms', slug: 'apps/forms' },
            { label: 'Integrations', slug: 'apps/integrations' },
            { label: 'Directory', slug: 'apps/directory' },
          ],
        },
        {
          label: 'Extensions',
          items: [
            { label: 'Overview', slug: 'extensions/overview' },
            { label: 'Build an Extension', slug: 'extensions/getting-started' },
            { label: 'Reference architectures', slug: 'extensions/reference-architectures' },
            { label: 'Frontend & recipient links', slug: 'extensions/frontend' },
            { label: 'Provider backend & admin SSO', slug: 'extensions/backend' },
            { label: 'Manifest reference', slug: 'extensions/manifest' },
          ],
        },
        {
          label: 'Recipes',
          items: [
            { label: 'Booking-link attribution', slug: 'recipes/booking-link-attribution' },
          ],
        },
        {
          label: 'MCP Tool Reference',
          items: [
            { label: 'Overview', slug: 'tools/overview' },
            { label: 'Drafts & Saving', slug: 'tools/drafts-and-saving' },
            { label: 'Pages', slug: 'tools/pages' },
            { label: 'Blocks', slug: 'tools/blocks' },
            { label: 'Partials', slug: 'tools/partials' },
            { label: 'Settings', slug: 'tools/settings' },
            { label: 'Collections', slug: 'tools/collections' },
            { label: 'Forms', slug: 'tools/forms' },
            { label: 'Media', slug: 'tools/media' },
            { label: 'Redirects', slug: 'tools/redirects' },
            { label: 'Migration URLs', slug: 'tools/migration-urls' },
            { label: 'Deploy', slug: 'tools/deploy' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Legacy managed domains', slug: 'guides/custom-domain' },
            { label: 'Self-Hosting', slug: 'guides/self-hosting' },
          ],
        },
        {
          label: 'Technical Reference',
          items: [
            { label: 'Overview', slug: 'technical/overview' },
            { label: 'SEO & indexing', slug: 'technical/seo-and-indexing' },
          ],
        },
      ],
    }),
  ],
});
