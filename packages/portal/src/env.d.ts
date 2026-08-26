/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    /** Active site version. Set by middleware from the `typeroll_version` cookie. */
    versionId: string;
  }
}

interface ImportMetaEnv {
  // Server-side
  readonly FIREBASE_SERVICE_ACCOUNT: string;
  readonly ANTHROPIC_API_KEY: string;
  readonly R2_ACCOUNT_ID: string;
  readonly R2_ACCESS_KEY_ID: string;
  readonly R2_SECRET_ACCESS_KEY: string;
  readonly R2_BUCKET: string;
  readonly R2_PUBLIC_BASE_URL: string;
  readonly POSTMARK_API_KEY?: string;
  readonly TYPEROLL_FIXTURES_DIR?: string;

  // Client-side (PUBLIC_ prefix exposes them to the browser)
  readonly PUBLIC_FIREBASE_API_KEY: string;
  readonly PUBLIC_FIREBASE_AUTH_DOMAIN: string;
  readonly PUBLIC_FIREBASE_PROJECT_ID: string;
  readonly PUBLIC_FIREBASE_APP_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
