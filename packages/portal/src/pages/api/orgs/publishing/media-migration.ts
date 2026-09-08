import type { APIRoute } from 'astro';
import { publishingAdmin, privateJson, connectionFailure, connectionBody } from '../../../../lib/publishing/http';
import { mediaMigrationStatus, requestMediaMigration } from '../../../../lib/publishing/media-migration';

export const GET: APIRoute = async context => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) return guard.response;
  try { return privateJson({ migration: await mediaMigrationStatus(guard.value.orgId) }); }
  catch (error) { return connectionFailure(error); }
};
export const POST: APIRoute = async context => {
  const guard = await publishingAdmin(context);
  if (!guard.ok) return guard.response;
  try {
    await connectionBody(context.request);
    await requestMediaMigration(guard.value.orgId);
    return privateJson({ migration: await mediaMigrationStatus(guard.value.orgId) });
  } catch (error) { return connectionFailure(error); }
};
