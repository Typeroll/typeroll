import type { APIRoute } from "astro";
import { paths, type Form } from "@typeroll/shared";
import { getStore } from "../../../lib/datastore";
import { verifyFormToken } from "../../../lib/forms-signing";
import { liveOptions } from "../../../lib/extensions/form-contract";
import { assertOrganizationAccess } from "../../../lib/organization-access";
import { rateLimit, clientIp } from "../../../lib/rate-limit";
import {
  readBoundedBody,
  parseJsonBody,
} from "../../../lib/forms/request-body";
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers });
export const OPTIONS: APIRoute = () =>
  new Response(null, { status: 204, headers });
export const POST: APIRoute = async (ctx) => {
  let socket: string | undefined;
  try {
    socket = ctx.clientAddress;
  } catch {}
  if (
    !rateLimit(
      `form-options:${clientIp(ctx.request.headers, socket)}`,
      60,
      60_000,
    ).allowed
  )
    return json({ error: "Please wait before refreshing choices" }, 429);
  let body;
  try {
    body = parseJsonBody(await readBoundedBody(ctx.request, 2048)) as {
      token?: unknown;
    };
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  const parts =
    typeof body?.token === "string" ? verifyFormToken(body.token) : null;
  if (!parts) return json({ error: "Invalid form token" }, 403);
  try {
    await assertOrganizationAccess(parts.orgId, "forms");
    const form = await getStore().getDoc<Form>(
      `${paths.forms(parts.orgId, parts.siteId)}/${parts.formId}`,
    );
    if (!form || form.target) return json({ error: "Form not found" }, 404);
    return json({
      options: await liveOptions(parts.orgId, parts.siteId, form),
    });
  } catch {
    return json({ error: "Live choices are temporarily unavailable" }, 503);
  }
};
