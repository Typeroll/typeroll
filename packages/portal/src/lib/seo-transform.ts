// Thin re-export — the implementation moved to `@typeroll/shared` so the
// site-template can apply the same SEO/Core Web Vitals transform to its
// block-rendered HTML at build time (block-mode pages otherwise bypass
// the save-time transform that html-mode pages get).
//
// All existing call sites (cookie-auth + v1 page handlers, tests) keep
// the same import path.
export { buildMediaLookup, transformBodyForSeo, lintBodyForSeo } from '@typeroll/shared';
export type { TransformOptions } from '@typeroll/shared';
