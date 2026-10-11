export function stableJson(value: unknown): string;
export function publicationContentFiles(publication: Record<string, any>): Record<string, string>;
export function readPublicationContent(metadata: Record<string, any>, readFile: (name: string) => Promise<string>, manifest: { files: Record<string, string> }): Promise<Record<string, any>>;
