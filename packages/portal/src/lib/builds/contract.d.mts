export const BUILD_PROTOCOL: 1;
export const BUILD_RUNTIME: string;
export const MAX_SOURCE_BYTES: number;
export const MAX_ARTIFACT_BYTES: number;
export const MAX_RENDER_CACHE_BYTES: number;
export interface RenderReport { format: 1; mode: 'full' | 'partial'; rendered: number; reused: number; total: number; removed: number; reason: string }
export function renderReport(value: unknown): RenderReport | undefined;
export interface BuildIdentity { protocol: 1; org_id: string; site_id: string; version_id: string; job_id: string; publication_id: string; source_sha256: string; commit: string; branch: string; node_version: string }
export function sha256(bytes: string | Uint8Array): string;
export function assertFilePath(name: string, options?: { artifact?: boolean }): void;
export function assertBuildIdentity(value: unknown): BuildIdentity;
export function encodeSource(files: Record<string, string>): Buffer;
export function decodeSource(bytes: Buffer, expectedHash: string): Record<string, string>;
export function encodeArtifact(identity: BuildIdentity, files: Record<string, Uint8Array>): Buffer;
export function decodeArtifact(bytes: Buffer, identity: BuildIdentity, expectedHash: string): Record<string, Buffer>;

export const SEO_VALIDATOR_VERSION: number;
export const MAX_SEO_REPORT_CHARACTERS: number;
export const MAX_SEO_REPORT_BYTES: number;
export const MAX_RUNNER_RESULT_BYTES: number;
export interface SeoIssue { code: string; url: string; source: { file: string; line: number; element?: string; block_id?: string; page_id?: string; field?: string }; message: string; remediation: string }
export interface SeoReport { version: number; publication_id: string; source_sha256: string; configuration_sha256: string; artifact_tree_sha256: string; checked_pages: number; passed: boolean; error_count: number; warning_count: number; errors: SeoIssue[]; warnings: SeoIssue[]; artifact_sha256?: string }
export function seoReport(value: unknown, publicationId: string): SeoReport;
export function outputDigest(files: Record<string, { sha256: string; size: number }>): string;
