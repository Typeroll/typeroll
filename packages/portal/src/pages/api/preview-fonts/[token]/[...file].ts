// GET /api/preview-fonts/{token}/{fonts.css | <hash>.woff2 | g/<path>}
//
// The site's self-hosted fonts for sandboxed previews, which have an opaque
// origin and send no session. The token is signed by lib/fonts/preview-fonts
// and names the only stylesheet and files it serves.

import type { APIRoute } from 'astro';
import { servePreviewFont } from '../../../../lib/fonts/preview-fonts';

export const prerender = false;

export const GET: APIRoute = async ({ params }) => servePreviewFont(params.token ?? '', params.file ?? '');
