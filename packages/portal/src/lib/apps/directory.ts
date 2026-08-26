// The directory app — self-service editing for the entities a directory
// lists.
//
// The app itself is thin, which is the point: everything underneath it is a
// general platform primitive (per-field write authority, item references,
// taxonomy pages, the completeness report, coalesced auto-deploy). What's
// genuinely directory-specific is only "which collection holds the listings,
// and which of its fields carries the address we mail an edit link to".
//
// Enabling it is what opens the public edit-link endpoints for a site. They
// 404 otherwise — a site that never asked for self-service editing shouldn't
// have an unauthenticated write surface at all, however well guarded.

import type { AppDef } from './types';

export const DIRECTORY_COLLECTION_KEY = 'collection';
export const DIRECTORY_EMAIL_FIELD_KEY = 'email_field';
export const DIRECTORY_LINK_TTL_KEY = 'link_ttl_hours';

// The app's own contributions to the two generic registries. Neither the
// forms module nor the form editor knows what a listing is — they see a
// labelled source and a labelled action like any other.
export const directoryPrefillSources = [
  {
    type: 'directory/listing',
    label: 'The listing this edit link points at',
    description: "Fills the form with the listed business's current values.",
    // Values are fetched by the runtime from the session endpoint rather than
    // resolved here: only that endpoint knows which listing the visitor's
    // session is bound to, and it must stay the only thing that decides.
    resolve: async () => ({}),
  },
];

export const directoryApp: AppDef = {
  id: 'directory',
  name: 'Directory',
  description:
    'Let the businesses you list correct their own record. They request a one-time link, it is mailed ' +
    'to the address already on their listing, and they edit only the fields you marked owner-writable. ' +
    'No account, no password. Requires an email integration to send from.',
  category: 'marketing',
  // Doesn't change the built site directly, but the editing surface writes
  // content that does — and enabling it is worth a redeploy prompt so the
  // operator sees their listings republish.
  affects_build: true,
  fields: [
    {
      key: DIRECTORY_COLLECTION_KEY,
      label: 'Listings collection',
      type: 'text',
      required: true,
      placeholder: 'companies',
      help: 'Machine name of the collection holding the listings.',
    },
    {
      key: DIRECTORY_EMAIL_FIELD_KEY,
      label: 'Contact email field',
      type: 'text',
      required: true,
      placeholder: 'email',
      help:
        'Field on each item holding the address an edit link may be mailed to. A request for any ' +
        'other address is refused — this is what stops a stranger from having a link mailed to a ' +
        'business on their behalf.',
    },
    {
      key: DIRECTORY_LINK_TTL_KEY,
      label: 'Link lifetime (hours)',
      type: 'number',
      default: 48,
      help: 'How long an issued edit link stays valid. Shorter is safer; a link that works for a week is a link that leaks.',
    },
  ],
  // Nothing here reaches the built site: the edit surface is server-side, and
  // the collection/field names are configuration the renderer never reads.
  public_keys: [],
  // One app, two endpoints — the request form and the edit form are
  // different surfaces with different auth. `form` selects between them.
  formEndpoint: ({ siteId, portalUrl, form }) =>
    form === 'request-link'
      ? `${portalUrl}/api/directory/${siteId}/request-link`
      : `${portalUrl}/api/directory/${siteId}/session`,

  // The two forms this app ships. Enabling it seeds them and registers a
  // block for each, so they show up in the picker and for the agent. The
  // BASE fields are here; a site adds whatever else it wants edited through
  // the ordinary forms UI, and re-enabling never overwrites those additions.
  prefill_sources: directoryPrefillSources,
  forms: [
    {
      id: 'request-link',
      name: 'Request an edit link',
      label: 'Request edit link',
      icon: '✉️',
      description:
        'Lets a listed business ask for a one-time link to its own record. The link is only ever '
        + 'mailed to the address already on the listing.',
      submit_text: 'Send me a link',
      success_message: 'If that address is on file, a link is on its way.',
      // Posts to request-link rather than the session endpoint — no prefill,
      // no session, since there is nothing to prefill from yet.
      target: { app: 'directory', form: 'request-link' },
      fields: [
        { name: 'item_id', type: 'text', label: 'Your listing id', required: true },
        { name: 'email', type: 'email', label: 'Email on your listing', required: true },
      ],
    },
    {
      id: 'edit-listing',
      name: 'Edit your listing',
      label: 'Edit listing',
      icon: '📝',
      description:
        'The self-service edit form. Opens from the emailed link, prefills the current values, and '
        + 'writes back only the fields marked owner-writable.',
      submit_text: 'Save',
      success_message: 'Saved. Your listing updates shortly.',
      target: { app: 'directory', hydrate: true, session_param: 't' },
      // Declared rather than implied: the values come from the listing the
      // visitor's link points at, and a site can add a `query` or `constant`
      // source after this one to override individual fields.
      prefill: [{ type: 'directory/listing', config: {} }],
      // Deliberately minimal: `title` is the one field almost every directory
      // wants editable. Everything else is the site's call, added here and
      // opted into with writable_by on the collection field.
      fields: [
        { name: 'title', type: 'text', label: 'Name', required: true },
      ],
    },
  ],
};

export interface DirectoryConfig {
  collection: string;
  emailField: string;
  ttlHours: number;
}

/** Read the app's config, or null when the site hasn't enabled it. */
export function directoryConfig(
  apps: { apps?: { directory?: { enabled?: boolean; config?: Record<string, unknown> } } } | undefined,
): DirectoryConfig | null {
  const state = apps?.apps?.directory;
  if (!state?.enabled) return null;
  const collection = String(state.config?.[DIRECTORY_COLLECTION_KEY] ?? '').trim();
  const emailField = String(state.config?.[DIRECTORY_EMAIL_FIELD_KEY] ?? '').trim();
  if (!collection || !emailField) return null;
  const ttlRaw = Number(state.config?.[DIRECTORY_LINK_TTL_KEY]);
  return {
    collection,
    emailField,
    ttlHours: Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.min(ttlRaw, 168) : 48,
  };
}
