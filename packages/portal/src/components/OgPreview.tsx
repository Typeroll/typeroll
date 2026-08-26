/**
 * Social-share preview for the editor's SEO tab. Mirrors how Facebook /
 * LinkedIn / Slack render an Open Graph card: a 1.91:1 image on top, the
 * site host underneath, then the title and description.
 *
 * Renders next to SerpPreview so editors can scan both Google + social
 * formats at once and see whether their title/description/image actually
 * present well.
 */

interface Props {
  title: string;
  description: string;
  /** Resolved og:image URL (page > site default > logo). */
  image?: string;
  /** Display host, e.g. "autopilot.se". */
  host: string;
  /** Alt text for the OG image (a11y + small SEO signal). */
  imageAlt?: string;
}

export default function OgPreview({ title, description, image, host, imageAlt }: Props) {
  const trimmedTitle = title.length > 90 ? title.slice(0, 87) + '…' : title;
  const trimmedDesc = description.length > 200 ? description.slice(0, 197) + '…' : description;
  const isSvg = !!image && /\.svg(\?|#|$)/i.test(image);

  return (
    <div className="og">
      <div className="og__label">Social share preview (Facebook / LinkedIn)</div>
      <div className="og__card">
        <div className="og__image">
          {image ? (
            <img src={image} alt={imageAlt ?? ''} loading="lazy" />
          ) : (
            <div className="og__placeholder">No image. Most platforms require a 1200×630 raster image.</div>
          )}
          {isSvg && (
            <div className="og__warning">
              SVG won't preview correctly on most social platforms. Set a raster default_og_image in site settings.
            </div>
          )}
        </div>
        <div className="og__body">
          <div className="og__host">{host.toUpperCase()}</div>
          <div className="og__title">{trimmedTitle || 'Untitled page'}</div>
          {trimmedDesc && <div className="og__desc">{trimmedDesc}</div>}
        </div>
      </div>
      <style>{`
        .og { margin-top: 1.25rem; }
        .og__label {
          font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em;
          color: var(--color-text-muted); font-weight: 600; margin-bottom: 0.4rem;
        }
        .og__card {
          max-width: 500px;
          border: 1px solid #ced0d4;
          border-radius: 8px;
          overflow: hidden;
          background: #fff;
          font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif;
        }
        .og__image {
          aspect-ratio: 1.91 / 1;
          background: #f0f2f5;
          position: relative;
        }
        .og__image img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .og__placeholder {
          display: flex; align-items: center; justify-content: center;
          width: 100%; height: 100%; padding: 1rem;
          color: #65676b; font-size: 0.85rem; text-align: center;
        }
        .og__warning {
          position: absolute; left: 0; right: 0; bottom: 0;
          background: rgba(220, 38, 38, 0.92); color: #fff;
          font-size: 0.72rem; padding: 0.35rem 0.5rem;
        }
        .og__body { padding: 0.65rem 0.85rem 0.85rem; background: #f0f2f5; }
        .og__host {
          color: #65676b; font-size: 0.72rem; letter-spacing: 0.02em;
          text-transform: uppercase; margin-bottom: 0.2rem;
        }
        .og__title {
          color: #050505; font-size: 1rem; line-height: 1.3; font-weight: 600;
          margin-bottom: 0.25rem;
          display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .og__desc {
          color: #65676b; font-size: 0.82rem; line-height: 1.35;
          display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
          overflow: hidden;
        }
      `}</style>
    </div>
  );
}
