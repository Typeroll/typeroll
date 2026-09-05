/**
 * Version of the public Typeroll Core contract shipped by this source tree.
 *
 * This is intentionally independent of the MCP package and template
 * capability versions. A Core release may contain several independently
 * versioned surfaces, all reported together by the portal release manifest.
 */
export const CORE_VERSION = '0.1.6';

/** Current persistent-data schema written by this Core release. */
export const DATA_SCHEMA_VERSION = 1;

/** Oldest/newest persistent-data schema this release can safely read. */
export const DATA_SCHEMA_READABLE_MIN = 1;
export const DATA_SCHEMA_READABLE_MAX = 1;
