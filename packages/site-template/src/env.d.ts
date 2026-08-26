/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly TYPEROLL_ORG_ID: string;
  readonly TYPEROLL_SITE_ID: string;
  readonly TYPEROLL_SITE_URL: string;
  readonly TYPEROLL_CDN_URL: string;
  readonly FIREBASE_SERVICE_ACCOUNT: string;
  readonly TYPEROLL_FIXTURES_DIR?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
