// Public form submission endpoint.
//
// This is the only unauthenticated write endpoint in the API. Static customer
// sites POST contact-form data here. Four defenses, in order:
//
//   1. Rate limit per IP (30 submissions per 5 minutes; cheap rejection
//      before we burn CPU on signature checks).
//   2. HMAC token verification. The form's hidden `_token` field is
//      `orgId.siteId.formId.signature` — signed with FORMS_HMAC_SECRET at
//      form-save time. Without it, the form isn't accepted, full stop.
//      No more "anyone can POST {orgId,siteId,formId} and our action
//      handlers fire emails".
//   3. Honeypot: a hidden `_hp` field that humans never fill but bots do.
//      If non-empty, we return 200 success and silently drop. (Returning
//      4xx would let bot frameworks discover the trap.)
//   4. Required-field validation against the saved form schema.
//
// CORS: requests come from arbitrary customer domains. The HMAC token is
// what authorizes them — the Origin header is not used for authorization
// because customer sites legitimately live on many origins.
//
// Two request shapes, one pipeline:
//   - JSON `{ token, data }` (fetch-based embeds) → JSON responses. The
//     original contract, unchanged.
//   - Form-encoded POST (urlencoded/multipart) with a hidden `_token` field
//     → minimal HTML responses (confirmation page with the form's
//     success_message + a back link). This is the no-JS path: the page
//     sanitizer strips inline <script> from customer HTML, so a plain
//     <form method="POST"> must work without any client-side code.

import type { APIRoute } from 'astro';
import { getStore } from '../../../lib/datastore';
import { paths } from '@typeroll/shared';
import type { Form } from '@typeroll/shared';
import {
  verifyFormToken,
  isFormsSigningConfigured,
  verifyPow,
  signFormState,
  verifyFormState,
} from '../../../lib/forms-signing';
import { rateLimit, clientIp } from '../../../lib/rate-limit';
import {
  collectStepFields,
  getStep,
  nextStep,
  validateFieldValues,
  defaultErrorMessage,
  buildCoreBlockRegistry,
  renderBlocks,
  MAIN_VERSION_ID,
} from '@typeroll/shared';
import type { BlockType, FormStep } from '@typeroll/shared';
import { sanitizeBody } from '../../../lib/sanitize';

const RATE_LIMIT_PER_IP = 30;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
// Submissions WITHOUT a valid proof-of-work get a much tighter budget —
// no-JS humans never notice, bulk bots must either burn CPU or throttle.
const RATE_LIMIT_NO_POW = 5;
// Per-form ceiling protects the shared service from one hot/abused form.
const RATE_LIMIT_PER_FORM = 120;
const MAX_BODY_BYTES = 64 * 1024;
const MIN_STEP_INTERVAL_MS = 1500;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export const OPTIONS: APIRoute = () => new Response(null, { status: 204, headers: corsHeaders });

export const POST: APIRoute = async ({ request }) => {
  const ip = clientIp(request.headers);

  const len = Number(request.headers.get('content-length') ?? 0);
  if (len > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ error: 'Payload too large' }), { status: 413, headers: corsHeaders });
  }

  // `wantsHtml` tracks which response format the client gets back: JSON for
  // fetch-based embeds, a minimal HTML page for plain no-JS form POSTs.
  const contentType = request.headers.get('content-type') ?? '';
  const wantsHtml =
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('multipart/form-data');
  const backUrl = safeReferer(request.headers.get('referer'));

  // 1. Rate limit.
  const rl = rateLimit(`forms:${ip}`, RATE_LIMIT_PER_IP, RATE_LIMIT_WINDOW_MS);
  if (!rl.allowed) {
    return respond(wantsHtml, { error: 'Too many submissions. Try again later.' }, 429, backUrl, {
      'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)),
      'X-RateLimit-Limit': String(RATE_LIMIT_PER_IP),
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': String(Math.floor(rl.resetAt / 1000)),
    });
  }

  // Parse either shape into the same { token, data } pair.

  let token: string | undefined;
  let data: Record<string, unknown> | undefined;
  if (wantsHtml) {
    const fd = await request.formData().catch(() => null);
    if (fd) {
      token = String(fd.get('_token') ?? '') || undefined;
      const collected: Record<string, unknown> = {};
      fd.forEach((v, k) => {
        // Files can't be stored in a submission doc; ignore non-string values.
        if (k !== '_token' && typeof v === 'string') collected[k] = v;
      });
      data = collected;
    }
  } else {
    const body = (await request.json().catch(() => null)) as {
      token?: string;
      data?: Record<string, unknown>;
    } | null;
    token = body?.token;
    data = body?.data;
  }
  if (!token || !data) {
    return respond(wantsHtml, { error: 'token and data are required' }, 400, backUrl);
  }

  // 2. HMAC token.
  if (!isFormsSigningConfigured()) {
    return respond(
      wantsHtml,
      { error: 'Form signing is not configured on this server (FORMS_HMAC_SECRET missing).' },
      503,
      backUrl
    );
  }
  const parts = verifyFormToken(token);
  if (!parts) {
    return respond(wantsHtml, { error: 'Invalid token' }, 403, backUrl);
  }
  const { orgId, siteId, formId } = parts;

  // 2b. Proof-of-work + per-form ceiling. A valid `_pow` (computed by the
  // forms runtime in the background) buys the normal budget; without it
  // the per-IP budget shrinks hard. Verification is a single hash.
  const hasPow = typeof data._pow === 'string' && verifyPow(token, data._pow);
  if (!hasPow) {
    const strict = rateLimit(`forms-nopow:${ip}`, RATE_LIMIT_NO_POW, RATE_LIMIT_WINDOW_MS);
    if (!strict.allowed) {
      return respond(wantsHtml, { error: 'Too many submissions. Try again later.' }, 429, backUrl);
    }
  }
  const perForm = rateLimit(`forms-form:${orgId}:${formId}`, RATE_LIMIT_PER_FORM, RATE_LIMIT_WINDOW_MS);
  if (!perForm.allowed) {
    return respond(wantsHtml, { error: 'This form is receiving too many submissions right now.' }, 429, backUrl);
  }

  const wantsProtocol =
    data._protocol === '1' || (request.headers.get('accept') ?? '').includes('application/json');
  // The forms-runtime shell always sets _protocol=1 and expects the v1 JSON
  // protocol ({ok, done, errors:[{field,code,message}]}). Keyed on the
  // explicit flag only — Accept: application/json alone keeps the legacy
  // {errors: string[]} shape so pre-runtime custom JS consumers don't break.
  const wantsRuntimeProtocol = data._protocol === '1';

  // 3. Honeypot: a non-empty `_hp` field means a bot filled it. Return 200
  // so the bot thinks the submission succeeded and moves on.
  if (typeof data._hp === 'string' && data._hp.trim().length > 0) {
    if (wantsRuntimeProtocol) return jsonCors({ ok: true, done: true, message: 'Thanks!' }, 200);
    return respond(wantsHtml, { success: true, message: 'Thanks!' }, 200, backUrl);
  }

  // 4. Load form & dispatch. Steps are the ONLY form model — a flat
  //    fields[] input converts to a single static step at write time
  //    (fieldsToSteps), so a stored form without steps is broken/empty,
  //    not a legacy shape.
  const store = getStore();
  const form = await store.getDoc<Form>(`${paths.forms(orgId, siteId)}/${formId}`);
  if (!form) return respond(wantsHtml, { error: 'Form not found' }, 404, backUrl);
  if (!Array.isArray(form.steps) || form.steps.length === 0) {
    return respond(wantsHtml, { error: 'This form has no steps configured.' }, 422, backUrl);
  }
  return handleStepsMode({ request, form, orgId, siteId, formId, data, ip, wantsHtml, wantsProtocol, backUrl });
};

// Post-submission actions now dispatch through the shared registry in
// lib/forms/actions.ts, so a form can combine core actions with ones an app
// contributes. Kept as a thin local wrapper because callers pass orgId/siteId
// positionally.
/** Pre-submit veto. Returns a reason when the submission must be refused. */
export async function runFormGate(
  orgId: string,
  siteId: string,
  form: Form,
  data: Record<string, unknown>,
): Promise<string | null> {
  const { runBeforeActions } = await import('../../../lib/forms/actions');
  const res = await runBeforeActions(form, { orgId, siteId, data, subject: { kind: 'submission' } });
  return res.ok ? null : res.reason;
}

async function runFormActions(
  orgId: string,
  siteId: string,
  form: Form,
  data: Record<string, unknown>,
  submissionId: string,
) {
  const { runFormActions: run } = await import('../../../lib/forms/actions');
  await run(form, { orgId, siteId, formId: form.id, data, subject: { kind: 'submission', id: submissionId } });
}

function jsonCors(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
      ...extra,
    },
  });
}

interface SubmitOutcome {
  success?: boolean;
  message?: string;
  error?: string;
  errors?: string[];
}

function respond(
  wantsHtml: boolean,
  outcome: SubmitOutcome,
  status = 200,
  backUrl: string | null = null,
  extra: Record<string, string> = {}
) {
  if (!wantsHtml) return jsonCors(outcome, status, extra);
  return htmlPage(outcome, status, backUrl, extra);
}

// Only link back to http(s) URLs — Referer is attacker-controlled input and
// must never become a javascript:/data: href on our confirmation page.
function safeReferer(referer: string | null): string | null {
  if (!referer) return null;
  try {
    const u = new URL(referer);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
  } catch {
    /* malformed — drop */
  }
  return null;
}

// Minimal self-contained confirmation/error page for no-JS form posts. The
// visitor language is whatever the customer wrote in success_message /
// field labels; our chrome (the back link) stays language-neutral.
function htmlPage(
  outcome: SubmitOutcome,
  status: number,
  backUrl: string | null,
  extra: Record<string, string> = {}
) {
  const ok = Boolean(outcome.success);
  const heading = ok ? '&#10003;' : '&#9888;';
  const lines = ok
    ? [outcome.message ?? 'Thanks!']
    : (outcome.errors ?? [outcome.error ?? 'Submission failed.']);
  const back = backUrl
    ? `<p><a href="${escapeHtml(backUrl)}">&larr; ${escapeHtml(new URL(backUrl).hostname)}</a></p>`
    : '';
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${ok ? 'OK' : 'Error'}</title>
<style>
  body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#f7f7f5;color:#1a1a1a}
  main{max-width:28rem;padding:2.5rem;background:#fff;border-radius:0.75rem;box-shadow:0 1px 4px rgba(0,0,0,0.08);text-align:center}
  .mark{font-size:2rem;line-height:1;margin-bottom:0.75rem;color:${ok ? '#15803d' : '#b91c1c'}}
  p{margin:0.5rem 0}
  a{color:inherit}
</style>
</head>
<body>
<main>
  <div class="mark">${heading}</div>
  ${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('\n  ')}
  ${back}
</main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders, ...extra },
  });
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// ─── Forms 2.0 steps-mode pipeline ────────────────────────────────────────
//
// One POST per step. The continuation (`_state`, HMAC-signed) carries the
// submission id + last completed step; values accumulate on one partial
// submission doc that flips to complete on the last step. The v1 JSON
// protocol (docs/plans/forms-funnels.md) answers fetch clients; plain
// no-JS POSTs get the legacy HTML page after step 1 (documented v1 cut:
// later steps need the runtime).

interface StepsCtx {
  request: Request;
  form: Form;
  orgId: string;
  siteId: string;
  formId: string;
  data: Record<string, unknown>;
  ip: string;
  wantsHtml: boolean;
  wantsProtocol: boolean;
  backUrl: string | null;
}

async function handleStepsMode(ctx: StepsCtx): Promise<Response> {
  const { form, orgId, siteId, formId, data } = ctx;
  const store = getStore();
  const protocolJson = (body: unknown, status = 200) =>
    jsonCors({ v: 1, ...(body as Record<string, unknown>) }, status);

  // Continuation: absent → this POST is for the first step.
  let state = null as ReturnType<typeof verifyFormState>;
  if (typeof data._state === 'string' && data._state) {
    state = verifyFormState(data._state);
    if (!state || state.orgId !== orgId || state.siteId !== siteId || state.formId !== formId) {
      return protocolJson({ ok: false, errors: [{ field: null, code: 'bad_state', message: 'Session expired — reload the page.' }] }, 403);
    }
    // Faster than any human moves between steps → automated.
    if (Date.now() - state.iat < MIN_STEP_INTERVAL_MS) {
      return protocolJson({ ok: false, errors: [{ field: null, code: 'too_fast', message: 'Slow down and try again.' }] }, 429);
    }
  }

  const current: FormStep | undefined = state
    ? (() => { const prev = getStep(form, state!.step); return prev ? nextStep(form, prev) : undefined; })()
    : getStep(form, undefined);
  if (!current) {
    return protocolJson({ ok: false, errors: [{ field: null, code: 'bad_state', message: 'Session expired — reload the page.' }] }, 409);
  }

  let lang = 'en';
  try {
    const site = await store.getDoc<{ language?: string }>(paths.site(orgId, siteId));
    if (site?.language) lang = site.language;
  } catch { /* en */ }

  // Validate THIS step's fields (derived from its form/* blocks).
  const fields = collectStepFields(current.blocks);
  const userData: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!k.startsWith('_')) userData[k] = v;
  }
  const fieldErrors = validateFieldValues(fields, userData);
  if (fieldErrors.length) {
    const errors = fieldErrors.map((e) => {
      const label = fields.find((f) => f.name === e.field)?.label ?? e.field;
      const custom = fields.find((f) => f.name === e.field)?.error_messages?.[e.code];
      return { field: e.field, code: e.code, message: custom ?? defaultErrorMessage(e.code, label, lang) };
    });
    if (ctx.wantsHtml && !ctx.wantsProtocol) {
      return respond(true, { errors: errors.map((e) => e.message) }, 400, ctx.backUrl);
    }
    return protocolJson({ ok: false, errors }, 400);
  }

  // Upsert the (partial) submission. Only this step's declared fields are
  // accepted — undeclared keys never reach storage.
  const accepted: Record<string, unknown> = {};
  for (const f of fields) if (f.name in userData) accepted[f.name] = userData[f.name];
  const now = new Date();
  const ttlDays = form.partial_ttl_days ?? 30;
  const subsPath = paths.submissions(orgId, siteId);
  let submissionId: string;
  let existing: Record<string, unknown> | null = null;
  if (state) {
    submissionId = state.submissionId;
    existing = await store.getDoc<Record<string, unknown>>(`${subsPath}/${submissionId}`);
    if (!existing || existing.form_id !== formId || existing.status !== 'partial' || existing.step !== state.step) {
      return protocolJson({ ok: false, errors: [{ field: null, code: 'bad_state', message: 'Session expired — reload the page.' }] }, 409);
    }
  } else {
    submissionId = '';
  }

  // Pre-submit actions run after schema projection but before this step has
  // any effect. For later steps they see the accumulated accepted data, so a
  // gate can validate a cross-field rule without receiving undeclared keys.
  const gateData = {
    ...((existing?.data as Record<string, unknown> | undefined) ?? {}),
    ...accepted,
  };
  const gateReason = await runFormGate(orgId, siteId, form, gateData);
  if (gateReason) {
    if (ctx.wantsHtml && !ctx.wantsProtocol) {
      return respond(true, { errors: [gateReason] }, 422, ctx.backUrl);
    }
    return protocolJson({ ok: false, errors: [{ field: null, code: 'action_rejected', message: gateReason }] }, 422);
  }

  const next = nextStep(form, current);
  const acceptedData = { ...((existing?.data as Record<string, unknown>) ?? {}), ...accepted };
  if (state) {
    // Only one request may advance a continuation. In particular, completing
    // the final step and claiming its actions must be one atomic transition.
    const advanced = await store.compareAndUpdateDoc<Record<string, unknown>>(
      `${subsPath}/${submissionId}`,
      (saved) => saved.form_id === formId && saved.status === 'partial' && saved.step === state!.step,
      {
        data: acceptedData,
        step: current.id,
        status: next ? 'partial' : 'complete',
        ...(!next ? { expires_at: null } : {}),
        updated_at: now.toISOString(),
      },
    );
    if (!advanced) {
      return protocolJson({ ok: false, errors: [{ field: null, code: 'bad_state', message: 'This step has already been submitted — reload the page.' }] }, 409);
    }
  } else {
    submissionId = await store.addDoc(subsPath, {
      form_id: formId,
      data: acceptedData,
      status: next ? 'partial' : 'complete',
      step: current.id,
      submitted_from_ip: ctx.ip,
      user_agent: ctx.request.headers.get('user-agent') ?? null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      expires_at: next ? new Date(now.getTime() + ttlDays * 86_400_000).toISOString() : null,
    });
  }

  if (!next) {
    try {
      await runFormActions(orgId, siteId, form, acceptedData, submissionId);
    } catch (e) {
      console.error('Form actions failed:', e);
    }
    if (ctx.wantsHtml && !ctx.wantsProtocol) {
      return respond(true, { success: true, message: form.success_message ?? 'Thanks!' }, 200, ctx.backUrl);
    }
    return protocolJson({ ok: true, done: true });
  }

  const newState = signFormState({ orgId, siteId, formId, submissionId, step: current.id });
  if (ctx.wantsHtml && !ctx.wantsProtocol) {
    // No-JS visitors can't advance prerendered steps — store what we got
    // and confirm honestly (documented v1 limitation).
    return respond(true, { success: true, message: form.success_message ?? 'Thanks!' }, 200, ctx.backUrl);
  }

  if (next.render === 'dynamic') {
    const registry = buildCoreBlockRegistry();
    try {
      const custom = await store.listDocs<BlockType>(paths.blockTypes(orgId, siteId, MAIN_VERSION_ID));
      for (const bt of custom) registry.set(bt.id, bt);
    } catch { /* core-only */ }
    const title = next.title ? `<h3 class="form-step-title">${escapeHtml(next.title)}</h3>` : '';
    const html = sanitizeBody(`${title}${renderBlocks(next.blocks ?? [], { registry })}`);
    return protocolJson({ ok: true, html, state: newState });
  }
  return protocolJson({ ok: true, next_step: next.id, state: newState });
}
