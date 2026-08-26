// Public, first-party Analytics event intake. Published sites receive a
// site-bound HMAC token at build time. The endpoint accepts only events that
// match an enabled Funnel attribution rule; arbitrary event names, fields,
// destinations, and personal data never reach storage.

import type { APIRoute } from "astro";
import { asFunnelAttributionConfig, paths } from "@typeroll/shared";
import type { AnalyticsEvent, Site, SiteApps } from "@typeroll/shared";
import { getStore } from "../../../lib/datastore";
import {
  cleanupExpiredAnalyticsEvents,
  verifyAnalyticsEventToken,
} from "../../../lib/apps/analytics-events";
import { clientIp, rateLimit } from "../../../lib/rate-limit";

const MAX_BODY_BYTES = 8 * 1024;
const MAX_VALUE_LENGTH = 1024;
const RETENTION_DAYS = 90;
const EVENT_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

export const OPTIONS: APIRoute = () =>
  new Response(null, { status: 204, headers: corsHeaders });

function response(status: number): Response {
  return new Response(null, { status, headers: corsHeaders });
}

function allowedOrigin(request: Request, site: Site & { id: string }): boolean {
  const raw = request.headers.get("origin");
  if (!raw) return false;
  let host: string;
  try {
    const origin = new URL(raw);
    if (
      origin.protocol !== "https:" &&
      origin.hostname !== "localhost" &&
      origin.hostname !== "127.0.0.1"
    )
      return false;
    host = origin.hostname.toLowerCase();
  } catch {
    return false;
  }
  const exact = new Set(
    [site.domain, site.domain_alias, site.hosting_config?.fallback_subdomain]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase()),
  );
  if (exact.has(host)) return true;
  const project = site.hosting_config?.pages_project?.toLowerCase();
  if (
    project &&
    (host === `${project}.pages.dev` || host.endsWith(`.${project}.pages.dev`))
  )
    return true;
  const base = (process.env.SITES_BASE_DOMAIN ?? "")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .toLowerCase();
  const label = (site.slug ?? site.id).toLowerCase();
  if (base && host === `${label}.${base}`) return true;
  return (
    process.env.NODE_ENV !== "production" &&
    (host === "localhost" || host === "127.0.0.1")
  );
}

export const POST: APIRoute = async ({ request }) => {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) return response(413);

  const ip = clientIp(request.headers);
  const ipLimit = rateLimit(`analytics-events-ip:${ip}`, 120, 60_000);
  if (!ipLimit.allowed) return response(429);

  const raw = await request.text().catch(() => "");
  if (!raw || new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES)
    return response(400);
  let body: {
    token?: string;
    event?: {
      name?: string;
      funnel_id?: string;
      destination?: string;
      path?: string;
      attribution?: Record<string, unknown>;
    };
  };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return response(400);
  }

  const token = verifyAnalyticsEventToken(body.token ?? "");
  if (!token) return response(403);

  const store = getStore();
  const [site, appsDoc] = await Promise.all([
    store.getDoc<Site>(paths.site(token.orgId, token.siteId)),
    store.getDoc<SiteApps>(paths.apps(token.orgId, token.siteId)),
  ]);
  if (!site || !allowedOrigin(request, site)) return response(403);
  if (
    !appsDoc?.apps?.analytics?.enabled ||
    !appsDoc.apps.funnel_attribution?.enabled
  )
    return response(404);

  const config = asFunnelAttributionConfig({
    funnels: appsDoc.apps.funnel_attribution.config?.funnels,
    allow_personal_data:
      appsDoc.apps.funnel_attribution.config?.allow_personal_data === true,
    allow_synthetic_fallbacks:
      appsDoc.apps.funnel_attribution.config?.allow_synthetic_fallbacks ===
      true,
  });
  const event = body.event;
  if (!config || !event || !event.name || !EVENT_RE.test(event.name))
    return response(400);
  const rule = config.funnels.find(
    (candidate) => candidate.id === event.funnel_id,
  );
  const target = rule?.targets.find(
    (candidate) =>
      candidate.click_event === event.name &&
      (candidate.destination ?? candidate.host) === event.destination,
  );
  if (!rule || !target) return response(400);
  if (
    typeof event.path !== "string" ||
    !event.path.startsWith("/") ||
    event.path.length > 500
  )
    return response(400);
  if (rule.page_paths?.length && !rule.page_paths.includes(event.path))
    return response(400);

  const allowedParameters = new Map(
    rule.parameters.map((parameter) => [
      parameter.to ?? parameter.from,
      parameter.max_length ?? 255,
    ]),
  );
  const attribution: Record<string, string> = {};
  if (
    event.attribution &&
    typeof event.attribution === "object" &&
    !Array.isArray(event.attribution)
  ) {
    for (const [key, value] of Object.entries(event.attribution)) {
      const limit = allowedParameters.get(key);
      if (
        !limit ||
        typeof value !== "string" ||
        !value ||
        value.length > Math.min(limit, MAX_VALUE_LENGTH)
      )
        continue;
      if (/[\u0000-\u001f\u007f]/.test(value)) continue;
      attribution[key] = value;
    }
  }

  const siteLimit = rateLimit(
    `analytics-events-site:${token.orgId}:${token.siteId}`,
    2_000,
    60_000,
  );
  if (!siteLimit.allowed) return response(429);
  const cleanupLimit = rateLimit(
    `analytics-events-cleanup:${token.orgId}:${token.siteId}`,
    1,
    60 * 60_000,
  );
  if (cleanupLimit.allowed)
    await cleanupExpiredAnalyticsEvents(store, token.orgId, token.siteId);
  const now = new Date();
  const stored: Omit<AnalyticsEvent, "id"> = {
    name: event.name,
    funnel_id: rule.id,
    destination: event.destination!,
    path: event.path,
    attribution,
    created_at: now.toISOString(),
    expires_at: new Date(
      now.getTime() + RETENTION_DAYS * 86_400_000,
    ).toISOString(),
  };
  await store.addDoc(paths.analyticsEvents(token.orgId, token.siteId), stored);
  return response(202);
};
