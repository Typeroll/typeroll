// Pure planning for the Extension id reservation audit. No datastore access.
//
// Extensions are stored per developer organization
// (`organizations/{org}/extensions/{id}`), but every token Typeroll issues for
// an installation uses the Extension id as its audience. Reservations at
// `extension_ids/{id}` make the id unique for new registrations; this plan
// finds ids registered by more than one organization and the ids that can be
// reserved for their single owner.

const EXTENSION_PATH = /^organizations\/([^/]+)\/extensions\/([^/]+)$/;

/** Parse an Extension document path, or null for any other `extensions` collection. */
export function parseExtensionPath(path) {
  const match = EXTENSION_PATH.exec(path);
  return match ? { developer_org_id: match[1], extension_id: match[2] } : null;
}

/**
 * @param {object} input
 * @param {Array<{ developer_org_id: string, extension_id: string, created_at?: string }>} input.extensions
 * @param {Map<string, string>} input.reservations extension id -> reserving developer organization
 * @param {Map<string, string>} input.catalog extension id -> public catalog developer organization
 */
export function planExtensionIdReservations({ extensions, reservations, catalog }) {
  const owners = new Map();
  for (const entry of extensions) {
    const list = owners.get(entry.extension_id) ?? [];
    list.push({ developer_org_id: entry.developer_org_id, created_at: entry.created_at ?? null });
    owners.set(entry.extension_id, list);
  }
  const plan = { contested: [], backfill: [], reserved: [], conflicts: [], orphaned_reservations: [] };
  for (const [extensionId, registrations] of [...owners].sort(([a], [b]) => a.localeCompare(b))) {
    registrations.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.developer_org_id.localeCompare(b.developer_org_id));
    const orgIds = [...new Set(registrations.map((entry) => entry.developer_org_id))];
    const reservedBy = reservations.get(extensionId) ?? null;
    const catalogOrg = catalog.get(extensionId) ?? null;
    if (orgIds.length > 1) {
      // Choosing an owner is a decision for the operator; never write one.
      plan.contested.push({ extension_id: extensionId, registrations, reserved_by: reservedBy, catalog_developer_org_id: catalogOrg });
      continue;
    }
    const [owner] = orgIds;
    if (reservedBy === owner) {
      plan.reserved.push({ extension_id: extensionId, developer_org_id: owner });
    } else if (reservedBy || (catalogOrg && catalogOrg !== owner)) {
      plan.conflicts.push({ extension_id: extensionId, developer_org_id: owner, reserved_by: reservedBy, catalog_developer_org_id: catalogOrg });
    } else {
      plan.backfill.push({ extension_id: extensionId, developer_org_id: owner });
    }
  }
  for (const [extensionId, reservedBy] of [...reservations].sort(([a], [b]) => a.localeCompare(b))) {
    if (!owners.has(extensionId)) plan.orphaned_reservations.push({ extension_id: extensionId, reserved_by: reservedBy });
  }
  return plan;
}
