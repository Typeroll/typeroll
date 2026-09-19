import type { APIRoute } from 'astro';
import { decideOwnerProposal, ProposalError } from '../../lib/owner-proposals';
import { proposalView, REVIEW_HEADERS } from '../../lib/owner-review-http';
const handle: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const values = ['org', 'site', 'version', 'proposal'].map(key => url.searchParams.get(key) ?? '');
  if (values.some(value => !/^[a-zA-Z0-9_-]{1,200}$/.test(value))) return Response.json({ error: 'Invalid review link' }, { status: 400, headers: REVIEW_HEADERS });
  const [orgId, siteId, versionId, id] = values;
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  try {
    const scope = { orgId, siteId, versionId };
    const result = request.method === 'GET' ? await proposalView(scope, id, token)
      : await decideOwnerProposal(scope, id, { token }, await request.json());
    return Response.json(result, { headers: REVIEW_HEADERS });
  } catch (error) {
    return Response.json({ error: error instanceof ProposalError ? error.message : 'Review is temporarily unavailable' },
      { status: error instanceof ProposalError ? error.status : 503, headers: REVIEW_HEADERS });
  }
};
export const GET = handle;
export const POST = handle;
