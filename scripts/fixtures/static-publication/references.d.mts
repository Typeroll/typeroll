export function replaceReferences<T>(value: T, replacements: Iterable<[string, string]>, options?: { origins?: boolean; skipCanonical?: boolean }): T;
export function resolvePublicationReferences<T extends Record<string, any>>(publication: T): T;

export function findReferences(text: string, references: Iterable<string>): Set<string>;
