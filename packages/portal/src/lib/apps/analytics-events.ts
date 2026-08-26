import crypto from "node:crypto";
import { paths } from "@typeroll/shared";
import type { AnalyticsEvent } from "@typeroll/shared";
import type { ReadWriteStore } from "../datastore";

const PREFIX = "analytics-v1";
const SEPARATOR = ".";

function secret(): string {
  const value = process.env.FORMS_HMAC_SECRET;
  if (!value || value.length < 32)
    throw new Error("FORMS_HMAC_SECRET is not configured");
  return value;
}

export function isAnalyticsEventSigningConfigured(): boolean {
  return Boolean(
    process.env.FORMS_HMAC_SECRET && process.env.FORMS_HMAC_SECRET.length >= 32,
  );
}

export function signAnalyticsEventToken(orgId: string, siteId: string): string {
  const payload = `${PREFIX}${SEPARATOR}${orgId}${SEPARATOR}${siteId}`;
  const signature = crypto
    .createHmac("sha256", secret())
    .update(payload)
    .digest("base64url");
  return `${payload}${SEPARATOR}${signature}`;
}

export function verifyAnalyticsEventToken(
  token: string,
): { orgId: string; siteId: string } | null {
  if (typeof token !== "string") return null;
  const parts = token.split(SEPARATOR);
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  const [, orgId, siteId, signature] = parts;
  if (!orgId || !siteId || !signature) return null;
  let expected: string;
  try {
    expected = crypto
      .createHmac("sha256", secret())
      .update(`${PREFIX}${SEPARATOR}${orgId}${SEPARATOR}${siteId}`)
      .digest("base64url");
  } catch {
    return null;
  }
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  return { orgId, siteId };
}

export function analyticsEventEmbedInfo(
  orgId: string,
  siteId: string,
): {
  event_endpoint: string;
  event_token: string | null;
} {
  const base = (
    process.env.FORMS_PUBLIC_URL ??
    process.env.PORTAL_PUBLIC_URL ??
    ""
  ).replace(/\/$/, "");
  return {
    event_endpoint: base ? `${base}/api/analytics/events` : "",
    event_token: isAnalyticsEventSigningConfigured()
      ? signAnalyticsEventToken(orgId, siteId)
      : null,
  };
}

export interface ConversionInsights {
  total_events: number;
  by_event: Array<{ name: string; destination: string; count: number }>;
  by_source: Array<{ source: string; count: number }>;
  by_campaign: Array<{ campaign: string; count: number }>;
  truncated: boolean;
}

export async function cleanupExpiredAnalyticsEvents(
  store: ReadWriteStore,
  orgId: string,
  siteId: string,
): Promise<number> {
  const expired = await store.listDocs<AnalyticsEvent>(
    paths.analyticsEvents(orgId, siteId),
    {
      filters: [
        { field: "expires_at", op: "<=", value: new Date().toISOString() },
      ],
      limit: 100,
    },
  );
  await Promise.all(
    expired.map((row) =>
      store.deleteDoc(`${paths.analyticsEvents(orgId, siteId)}/${row.id}`),
    ),
  );
  return expired.length;
}

export async function getConversionInsights(
  store: ReadWriteStore,
  orgId: string,
  siteId: string,
  days: number,
): Promise<ConversionInsights> {
  await cleanupExpiredAnalyticsEvents(store, orgId, siteId);
  const limit = 5_000;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = await store.listDocs<AnalyticsEvent>(
    paths.analyticsEvents(orgId, siteId),
    {
      filters: [{ field: "created_at", op: ">=", value: since }],
      limit,
    },
  );
  const events = new Map<
    string,
    { name: string; destination: string; count: number }
  >();
  const sources = new Map<string, number>();
  const campaigns = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.name}\u0000${row.destination}`;
    const current = events.get(key) ?? {
      name: row.name,
      destination: row.destination,
      count: 0,
    };
    current.count += 1;
    events.set(key, current);
    const source = row.attribution?.utm_source;
    if (source) sources.set(source, (sources.get(source) ?? 0) + 1);
    const campaign = row.attribution?.utm_campaign;
    if (campaign) campaigns.set(campaign, (campaigns.get(campaign) ?? 0) + 1);
  }
  return {
    total_events: rows.length,
    by_event: Array.from(events.values()).sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name),
    ),
    by_source: Array.from(sources, ([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source))
      .slice(0, 15),
    by_campaign: Array.from(campaigns, ([campaign, count]) => ({
      campaign,
      count,
    }))
      .sort((a, b) => b.count - a.count || a.campaign.localeCompare(b.campaign))
      .slice(0, 15),
    truncated: rows.length === limit,
  };
}
