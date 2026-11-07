// Live site fields: fields marked `live: true` are also published as one
// public file, `live/_fields.json` = { values, time_zone, updated_at }, the
// moment their values or definitions are saved on main. The `core/site_field`
// block shows the value of the latest publication and the browser then reads
// the newest one from the file. Other fields wait for the next publication.

import { MAIN_VERSION_ID, liveSiteFieldNames, siteTimeZone, type LiveSiteFieldsFile, type SiteFields } from '@typeroll/shared';
import { vstore } from './version-store';
import { deleteLiveFile, LIVE_FIELDS_FILE, publishLiveFile, type LiveWriteResult } from './publishing/live-files';

export function liveSiteFieldsFile(siteFields: SiteFields, timeZone: string): LiveSiteFieldsFile {
  const values: Record<string, unknown> = {};
  // An emptied live field is written as null, so pages replace the published value with the empty state.
  for (const name of liveSiteFieldNames(siteFields.groups)) values[name] = siteFields.values[name] ?? null;
  return { values, time_zone: timeZone, updated_at: siteFields.updated_at ?? new Date(0).toISOString() };
}

const liveView = (doc: SiteFields | null | undefined) => {
  if (!doc) return '';
  const names = liveSiteFieldNames(doc.groups);
  return names.length ? JSON.stringify(names.map((name) => [name, doc.values[name] ?? null])) : '';
};

/**
 * Publishes (or removes) the live fields file after a save. Only main is
 * live; a save that changes no live field or value writes nothing.
 */
export async function publishLiveSiteFields(
  ctx: { orgId: string; siteId: string; versionId: string }, next: SiteFields, previous?: SiteFields | null, options: { force?: boolean } = {},
): Promise<LiveWriteResult | { published: false; removed: true } | undefined> {
  if (ctx.versionId !== MAIN_VERSION_ID) return undefined;
  const before = liveView(previous), after = liveView(next);
  if (!options.force && before === after) return undefined;
  if (!after) {
    await deleteLiveFile(ctx.orgId, ctx.siteId, LIVE_FIELDS_FILE).catch(() => undefined);
    return { published: false, removed: true };
  }
  const settings = await vstore.settings(ctx.orgId, ctx.siteId, MAIN_VERSION_ID);
  return publishLiveFile(ctx.orgId, ctx.siteId, LIVE_FIELDS_FILE, liveSiteFieldsFile(next, siteTimeZone(settings ?? undefined)));
}
