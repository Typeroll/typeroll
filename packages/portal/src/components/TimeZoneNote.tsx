import { Globe } from 'lucide-react';

/**
 * Which time zone "today" follows, with a link to change it. Shown where days
 * matter: dated snippets and opening hours. `zone` is `siteTimeZone(settings)`.
 */
export default function TimeZoneNote({ siteId, zone, className = '' }: { siteId: string; zone: string; className?: string }) {
  return (
    <p className={`tz-note ${className}`.trim()} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', margin: 0, fontSize: '.82rem' }}>
      <Globe size={14} aria-hidden="true" />
      <span>Days follow {zone} (the site's time zone).</span>
      {/* The time zone sits next to Language, in the SEO section of the settings. */}
      <a href={`/app/sites/${encodeURIComponent(siteId)}/settings?section=seo`}>Change it in Settings, next to Language.</a>
    </p>
  );
}
