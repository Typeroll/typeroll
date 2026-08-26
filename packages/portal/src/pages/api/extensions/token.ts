import type { APIRoute } from 'astro';
import { json } from '../../../lib/access';
import { exchangeExtensionLaunchCode, ExtensionAuthError } from '../../../lib/extensions/auth';

export const POST: APIRoute = async ({ request }) => {
  const contentType = request.headers.get('content-type') ?? '';
  let body: Record<string, unknown> | null = null;
  if (contentType.includes('application/json')) {
    body = await request.json().catch(() => null) as Record<string, unknown> | null;
  } else {
    const form = await request.formData().catch(() => null);
    if (form) body = Object.fromEntries(form.entries());
  }
  if (!body) return json({ error: 'Invalid request body' }, 400);
  try {
    return json(await exchangeExtensionLaunchCode({
      code: String(body.code ?? ''),
      clientId: String(body.client_id ?? ''),
      clientSecret: String(body.client_secret ?? ''),
    }));
  } catch (error) {
    if (error instanceof ExtensionAuthError) return json({ error: error.message }, error.status);
    return json({ error: 'Token exchange failed' }, 500);
  }
};
