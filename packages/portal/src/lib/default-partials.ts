/**
 * Starter HTML for the header + footer of a newly created site.
 *
 * Goals:
 *  - Minimal but visually present — so a fresh site renders as a real page,
 *    not a stack of unstyled headings.
 *  - Uses the site's CSS variables (--color-*, --spacing-*, --font-heading,
 *    --container-medium) so it stays in sync with whatever theme the user
 *    or migration sets up.
 *  - Inline-style only — the markup survives sanitization unchanged and
 *    doesn't require companion CSS files anywhere.
 *  - Clearly structured so the AI chat can extend it confidently: brand
 *    block, nav block, copyright block, all wrapped in containers it can
 *    swap without touching the rest.
 *
 * These are the seed values only — the user (or the AI chat) is expected to
 * iterate on them once the site is set up.
 */

function esc(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function defaultHeaderHtml(siteName: string): string {
  const name = esc(siteName || 'Your brand');
  return `<div style="background:var(--color-surface);border-bottom:1px solid color-mix(in srgb,var(--color-text) 8%,transparent)">
  <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--spacing-lg);max-width:var(--container-medium);margin:0 auto;padding:var(--spacing-md)">
    <a href="/" style="font-family:var(--font-heading),sans-serif;font-weight:700;font-size:1.2rem;color:var(--color-text);text-decoration:none;letter-spacing:-0.01em">${name}</a>
    <nav style="display:flex;align-items:center;gap:var(--spacing-md);flex-wrap:wrap">
      <a href="/" style="color:var(--color-text);text-decoration:none;font-weight:500;padding:0.35rem 0">Home</a>
      <a href="/about" style="color:var(--color-text);text-decoration:none;font-weight:500;padding:0.35rem 0">About</a>
      <a href="/contact" style="background:var(--color-primary);color:var(--color-background);text-decoration:none;font-weight:600;padding:0.45rem 0.9rem;border-radius:var(--radius-md);line-height:1">Contact</a>
    </nav>
  </div>
</div>`;
}

export function defaultFooterHtml(siteName: string, tagline?: string): string {
  const name = esc(siteName || 'Your brand');
  const taglineHtml = tagline && tagline.trim()
    ? `<p style="color:var(--color-text-light);font-size:0.95rem;margin:0;max-width:32ch">${esc(tagline)}</p>`
    : `<p style="color:var(--color-text-light);font-size:0.95rem;margin:0;max-width:32ch">A timeless website. No databases, no maintenance burden — just files on a CDN.</p>`;
  const year = new Date().getFullYear();
  return `<div style="background:var(--color-surface);border-top:1px solid color-mix(in srgb,var(--color-text) 8%,transparent);margin-top:var(--spacing-xl)">
  <div style="max-width:var(--container-medium);margin:0 auto;padding:var(--spacing-lg) var(--spacing-md);display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:var(--spacing-lg)">
    <div>
      <div style="font-family:var(--font-heading),sans-serif;font-weight:700;font-size:1.05rem;color:var(--color-text);margin-bottom:var(--spacing-xs)">${name}</div>
      ${taglineHtml}
    </div>
    <div>
      <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.1em;color:var(--color-text-light);font-weight:600;margin-bottom:var(--spacing-sm)">Site</div>
      <ul style="list-style:none;padding:0;margin:0;display:grid;gap:0.4rem">
        <li><a href="/about" style="color:var(--color-text);text-decoration:none">About</a></li>
        <li><a href="/team" style="color:var(--color-text);text-decoration:none">Team</a></li>
        <li><a href="/contact" style="color:var(--color-text);text-decoration:none">Contact</a></li>
      </ul>
    </div>
    <div>
      <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.1em;color:var(--color-text-light);font-weight:600;margin-bottom:var(--spacing-sm)">Get in touch</div>
      <p style="color:var(--color-text-light);font-size:0.92rem;margin:0">hello@example.com</p>
    </div>
  </div>
  <div style="border-top:1px solid color-mix(in srgb,var(--color-text) 6%,transparent)">
    <div style="max-width:var(--container-medium);margin:0 auto;padding:var(--spacing-md);display:flex;justify-content:space-between;align-items:center;gap:var(--spacing-md);flex-wrap:wrap;color:var(--color-text-light);font-size:0.85rem">
      <span>&copy; ${year} ${name}. All rights reserved.</span>
      <span>Built with <a href="https://typeroll.com" style="color:var(--color-text-light);text-decoration:underline;text-underline-offset:2px">Typeroll</a></span>
    </div>
  </div>
</div>`;
}
