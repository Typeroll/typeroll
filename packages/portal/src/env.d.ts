/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    /** Active site version. Set by middleware from the `typeroll_version` cookie. */
    versionId: string;
  }
}

interface ImportMetaEnv {
  // Server-side
  /** Optional Anthropic-compatible endpoint. AI keys are per organization, not server variables. */
  readonly ANTHROPIC_BASE_URL?: string;
  readonly R2_ACCOUNT_ID: string;
  readonly R2_ACCESS_KEY_ID: string;
  readonly R2_SECRET_ACCESS_KEY: string;
  readonly R2_BUCKET: string;
  readonly R2_PUBLIC_BASE_URL: string;
  readonly POSTMARK_API_KEY?: string;
  readonly TYPEROLL_FIXTURES_DIR?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
