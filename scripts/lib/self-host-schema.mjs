// Versions of the self-host tooling in this checkout. `npm run release:bump`
// keeps SELF_HOST_CORE_VERSION in lockstep with the Core release, so the
// Cloudflare self-host profile installs, by default, the Worker bundle of the
// release this checkout was published as.
export const SELF_HOST_BACKUP_FORMAT_VERSION = 2;
export const SELF_HOST_CORE_VERSION = '0.3.15';
