export const BUILD_PROTOCOL: 1;
export const BUILD_RUNTIME: string;
export const MAX_SOURCE_BYTES: number;
export const MAX_ARTIFACT_BYTES: number;
export interface BuildIdentity { protocol: 1; org_id: string; site_id: string; version_id: string; job_id: string; publication_id: string; source_sha256: string; commit: string; branch: string; node_version: string }
export function sha256(bytes: string | Uint8Array): string;
export function assertFilePath(name: string, options?: { artifact?: boolean }): void;
export function assertBuildIdentity(value: unknown): BuildIdentity;
export function encodeSource(files: Record<string, string>): Buffer;
export function decodeSource(bytes: Buffer, expectedHash: string): Record<string, string>;
export function encodeArtifact(identity: BuildIdentity, files: Record<string, Uint8Array>): Buffer;
export function decodeArtifact(bytes: Buffer, identity: BuildIdentity, expectedHash: string): Record<string, Buffer>;
