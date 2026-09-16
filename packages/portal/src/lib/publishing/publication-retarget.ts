import { replaceReferences } from '../../../../../scripts/fixtures/static-publication/references.mjs';

/** Retarget known site origins; preserve external URLs, query strings and fragments. */
export function retargetWebsite<T>(value: T, previousOrigins: string[], nextOrigin: string): T {
  return replaceReferences(value, previousOrigins.filter(Boolean).map(origin => [new URL(origin).origin, nextOrigin]), { origins: true });
}
