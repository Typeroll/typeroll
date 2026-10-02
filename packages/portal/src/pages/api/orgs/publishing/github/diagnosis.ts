import type { APIRoute } from 'astro';
import { ConnectionError } from '../../../../../lib/publishing/connections';
import { currentGithubDiagnosis } from '../../../../../lib/publishing/github-diagnosis';
import { recheckGithubDiagnosis } from '../../../../../lib/publishing/github-recheck';
import { connectionBody, connectionFailure, privateJson, publishingAdmin } from '../../../../../lib/publishing/http';

// GET  — the signed-in person's current GitHub diagnosis.
// POST { action: 'recheck', owner? } — check again with the publisher App's
//      authority and the GitHub identity this person proved within the hour.
//      Consumes nothing; repeated calls within five seconds return the same result.
export const GET: APIRoute = async (context) => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) return guard.response;
  try { return privateJson({ diagnosis: await currentGithubDiagnosis(guard.value.orgId, guard.value) }); }
  catch (error) { return connectionFailure(error); }
};

export const POST: APIRoute = async (context) => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) return guard.response;
  try {
    const body = await connectionBody(context.request) as Record<string, unknown>;
    if (body.action !== 'recheck') throw new ConnectionError('action must be recheck', 400);
    const owner = typeof body.owner === 'string' ? body.owner.trim() : undefined;
    return privateJson({ diagnosis: await recheckGithubDiagnosis(guard.value, { person: true, ...(owner ? { owner } : {}) }) });
  } catch (error) { return connectionFailure(error); }
};
