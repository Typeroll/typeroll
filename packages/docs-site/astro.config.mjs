import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';
import { docsTarget } from './scripts/docs-target.mjs';
import { llmsOptions } from './scripts/llms-config.mjs';

const target = docsTarget();

export default defineConfig({
  site: target.site,
  base: target.base,
  outDir: target.output,
  integrations: [
    starlight({
      title: 'Typeroll CMS',
      components: {
        Head: './src/components/DocsHead.astro',
        PageTitle: './src/components/DocsPageTitle.astro',
        SiteTitle: './src/components/DocsSiteTitle.astro',
        SocialIcons: './src/components/DocsSocialLinks.astro',
      },
      plugins: [starlightLlmsTxt(llmsOptions(target.publicUrl))],
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
            { label: 'Cloud and self-hosting', slug: 'getting-started/cloud-and-self-hosting' },
            { label: 'Build a website with Claude Code', slug: 'guides/build-with-claude-code' },
            { label: 'Using Typeroll Cloud', slug: 'guides/typeroll-cloud' },
            { label: 'Cloud trial and access', slug: 'guides/cloud-trial' },
            { label: 'Incoming email', slug: 'guides/incoming-email' },
            { label: 'Connect your AI agent', slug: 'getting-started/mcp-server' },
            { label: 'Setup by client', slug: 'getting-started/connect-your-agent' },
            { label: 'Personal AI connections', slug: 'guides/ai-connections' },
            { label: 'Built-in AI assistant', slug: 'guides/ai-assistant' },
            { label: 'Client compatibility', slug: 'getting-started/client-compatibility' },
            { label: 'Your First Site', slug: 'getting-started/first-site' },
            { label: 'Agent workspace', slug: 'getting-started/agent-workspace' },
            { label: 'Self-hosting quickstart', slug: 'getting-started/self-hosting-quickstart' },
            { label: 'Teams and roles', slug: 'guides/teams-and-roles' },
            { label: 'Agencies and client sites', slug: 'guides/agencies' },
            { label: 'Export and backup', slug: 'guides/export-and-backup' },
            { label: 'Archive a site', slug: 'guides/archive-a-site' },
          ],
        },
        {
          label: 'Visual editor',
          items: [
            { label: 'Edit pages', slug: 'guides/the-editor' },
            { label: 'Drafts, saving and review', slug: 'tools/drafts-and-saving' },
            { label: 'Versions and branches', slug: 'tools/versions' },
            { label: 'Pages, blocks and templates', slug: 'guides/site-structure' },
          ],
        },
        {
          label: 'Build your site',
          items: [
            { label: 'Built-in block catalog', slug: 'guides/block-library' },
            { label: 'Create a Page template', slug: 'guides/page-templates' },
            { label: 'Create your own block type', slug: 'guides/create-block-type' },
            { label: 'Content types and fields', slug: 'tools/content-types' },
            { label: 'Several languages on one site', slug: 'guides/multilingual-sites' },
            { label: 'Global blocks and section starters', slug: 'tools/reusable-blocks' },
            { label: 'Named styles', slug: 'tools/styles' },
            { label: 'Design tokens', slug: 'guides/design-tokens' },
            {
              label: 'Block reference',
              items: [
                { label: 'Block tools', slug: 'tools/blocks' },
                { label: 'Block library', slug: 'tools/blocks/library' },
                { label: 'Responsive and presentation', slug: 'tools/blocks/responsive' },
                { label: 'Parts and site block types', slug: 'tools/blocks/parts' },
                { label: 'Layouts, navigation and cards', slug: 'tools/blocks/layouts' },
                { label: 'Changes by Core version', slug: 'tools/blocks/changelog' },
              ],
            },
            { label: 'Media and images', slug: 'tools/media' },
            { label: 'Images for editors', slug: 'guides/media-for-editors' },
          ],
        },
        {
          label: 'Publishing',
          items: [
            { label: 'Connect your accounts', slug: 'guides/customer-publishing' },
            { label: 'GitHub connection troubleshooting', slug: 'guides/github-troubleshooting' },
            { label: 'Cloudflare connection troubleshooting', slug: 'guides/cloudflare-troubleshooting' },
            { label: 'Cloudflare hosting and builds', slug: 'publishing/cloudflare' },
            { label: 'Website and media domains', slug: 'publishing/domains' },
            { label: 'Different generators on one website', slug: 'publishing/multiple-generators' },
            { label: 'Deploy and preview tools', slug: 'tools/deploy' },
            { label: 'Publication checks', slug: 'guides/publication-validation' },
            { label: 'Launch checklist', slug: 'guides/launch-checklist' },
            { label: 'SEO for your site', slug: 'guides/seo' },
            { label: 'Google Search Console', slug: 'guides/search-console' },
          ],
        },
        {
          label: 'Migration',
          items: [
            { label: 'Choose your approach', slug: 'guides/migration-approach' },
            { label: 'From WordPress', slug: 'guides/wordpress-migration' },
            { label: 'From Astro', slug: 'guides/migrate-from-astro' },
            { label: 'From Squarespace', slug: 'guides/migrate-from-squarespace' },
            { label: 'From Wix', slug: 'guides/migrate-from-wix' },
            { label: 'From Webflow', slug: 'guides/migrate-from-webflow' },
            { label: 'SEO checklist for migrations', slug: 'guides/migration-seo-checklist' },
          ],
        },
        {
          label: 'Skills',
          items: [{ autogenerate: { directory: 'skills' } }],
        },
        {
          label: 'Core modules',
          items: [
            { label: 'Overview', slug: 'apps/overview' },
            {
              label: 'Analytics',
              items: [
                { label: 'Overview', slug: 'apps/analytics' },
                { label: 'Events & conversions', slug: 'apps/events' },
              ],
            },
            { label: 'Forms', slug: 'apps/forms' },
            { label: 'Owner answers & review', slug: 'guides/owner-review' },
            { label: 'Integrations', slug: 'apps/integrations' },
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
          label: 'MCP Tool Reference',
          items: [
            { label: 'Overview', slug: 'tools/overview' },
            { label: 'Pages', slug: 'tools/pages' },
            { label: 'Partials', slug: 'tools/partials' },
            { label: 'Settings', slug: 'tools/settings' },
            { label: 'Site block types', slug: 'tools/custom-block-types' },
            { label: 'Forms', slug: 'tools/forms' },
            { label: 'Email', slug: 'tools/email' },
            { label: 'Redirects', slug: 'tools/redirects' },
            { label: 'Migration URLs', slug: 'tools/migration-urls' },
            { label: 'Organization, access & workflows', slug: 'tools/organization' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Legacy managed domains', slug: 'guides/custom-domain' },
            { label: 'Self-Hosting', slug: 'guides/self-hosting' },
            { label: 'Upgrade to unified Pages', slug: 'guides/unified-pages-upgrade' },
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
