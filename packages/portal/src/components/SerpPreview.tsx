/**
 * Google SERP-style preview for the editor's SEO tab. Shows roughly what
 * the title + URL + description will look like in a search result, with
 * character counters so editors don't blow past Google's truncation
 * thresholds.
 *
 * Thresholds are approximate — Google measures in pixels, not characters,
 * and varies by viewport. 50-60 / 150-160 is the widely-cited safe band.
 */
import { useMemo } from 'react';

interface Props {
  title: string;
  description: string;
  siteName?: string;
  /** Default suffix appended to title in the live <title> tag. */
  titleSuffix?: string;
  /** Full URL we'd render. Falls back to a stub if missing. */
  url: string;
}

const TITLE_TARGET = [50, 60] as const;
const DESC_TARGET = [150, 160] as const;

function widthClass(len: number, range: readonly [number, number]): string {
  if (len === 0) return 'serp__counter--empty';
  if (len < range[0]) return 'serp__counter--under';
  if (len <= range[1]) return 'serp__counter--ok';
  return 'serp__counter--over';
}

export default function SerpPreview({ title, description, siteName, titleSuffix, url }: Props) {
  const fullTitle = useMemo(() => {
    if (!title) return siteName ?? '';
    if (!titleSuffix) return title;
    return title.endsWith(titleSuffix) ? title : `${title}${titleSuffix}`;
  }, [title, titleSuffix, siteName]);

  const truncatedTitle = fullTitle.length > 60 ? fullTitle.slice(0, 57) + '…' : fullTitle;
  const truncatedDesc = description.length > 160 ? description.slice(0, 157) + '…' : description;

  const displayUrl = (() => {
    try {
      const u = new URL(url);
      const path = u.pathname === '/' ? '' : ` › ${u.pathname.replace(/^\/+|\/+$/g, '').replace(/\//g, ' › ')}`;
      return `${u.hostname}${path}`;
    } catch {
      return url;
    }
  })();

  return (
    <div className="serp">
      <div className="serp__label">Google SERP preview</div>
      <div className="serp__card">
        <div className="serp__url">{displayUrl}</div>
        <div className="serp__title">{truncatedTitle || 'Untitled page'}</div>
        <div className="serp__desc">{truncatedDesc || 'No meta description.'}</div>
      </div>
      <div className="serp__counters">
        <span className={`serp__counter ${widthClass(fullTitle.length, TITLE_TARGET)}`}>
          Title {fullTitle.length} chars {fullTitle.length > 0 && `(target ${TITLE_TARGET[0]}–${TITLE_TARGET[1]})`}
        </span>
        <span className={`serp__counter ${widthClass(description.length, DESC_TARGET)}`}>
          Description {description.length} chars {description.length > 0 && `(target ${DESC_TARGET[0]}–${DESC_TARGET[1]})`}
        </span>
      </div>
      <style>{`
        .serp { margin-top: 0.75rem; }
        .serp__label {
          font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em;
          color: var(--color-text-muted); font-weight: 600; margin-bottom: 0.4rem;
        }
        .serp__card {
          background: var(--color-bg);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          padding: 0.85rem 1rem;
          font-family: arial, sans-serif;
          max-width: 600px;
        }
        .serp__url { color: #202124; font-size: 0.78rem; line-height: 1.3; margin-bottom: 0.15rem; }
        .serp__title {
          color: #1a0dab; font-size: 1.125rem; line-height: 1.35; font-weight: 400;
          margin-bottom: 0.2rem;
          overflow-wrap: anywhere;
        }
        .serp__desc {
          color: #4d5156; font-size: 0.85rem; line-height: 1.45;
          overflow-wrap: anywhere;
        }
        .serp__counters {
          display: flex; gap: 0.75rem; flex-wrap: wrap;
          margin-top: 0.5rem; font-size: 0.78rem;
        }
        .serp__counter--empty, .serp__counter--under { color: var(--color-text-muted); }
        .serp__counter--ok { color: var(--color-success); }
        .serp__counter--over { color: var(--color-danger); font-weight: 500; }
      `}</style>
    </div>
  );
}
