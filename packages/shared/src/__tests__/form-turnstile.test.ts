import { Window } from "happy-dom";
import { afterEach, expect, it } from "vitest";
import { buildCoreBlockRegistry } from "../index.js";
import { renderFormHtml } from "../render-form.js";
import { FORMS_RUNTIME_JS } from "../forms-runtime.js";
import type { Form } from "../types.js";

const form: Form = {
  id: "lead",
  name: "Lead",
  created_at: "x",
  actions: [],
  steps: [
    { id: "one", blocks: [{ id: "n", type: "form/text", data: { name: "name", label: "Name" } }] },
    { id: "two", blocks: [{ id: "m", type: "form/text", data: { name: "note", label: "Note" } }] },
  ],
};
const embed = { submit_url: "https://forms.example.test/api/forms/submit", submit_token: "signed", turnstile_site_key: "0x4AAAAAAAsitekey" };
let open: Window | null = null;
afterEach(async () => { await open?.happyDOM.close(); open = null; });

it("renders the Turnstile container only for published forms with a valid site key", () => {
  const registry = buildCoreBlockRegistry();
  expect(renderFormHtml(form, embed, { registry })).toContain('data-tr-turnstile="0x4AAAAAAAsitekey"');
  expect(renderFormHtml(form, { ...embed, preview: true, submit_token: null }, { registry })).not.toContain("data-tr-turnstile");
  expect(renderFormHtml(form, { ...embed, turnstile_site_key: '"><script>' }, { registry })).not.toContain("data-tr-turnstile");
  expect(renderFormHtml(form, { submit_url: embed.submit_url, submit_token: "signed" }, { registry })).not.toContain("data-tr-turnstile");
});

it("sends the widget answer with the first step only, asks for a fresh one after a post and hides the widget afterwards", async () => {
  const window = new Window({ url: "https://site.example.test/contact" });
  open = window;
  const rendered: Array<{ sitekey: string; callback: (token: string) => void }> = [];
  let resets = 0;
  // The page loads Cloudflare's script; this stands in for it.
  (window as unknown as { turnstile: unknown }).turnstile = {
    render: (_box: unknown, options: { sitekey: string; callback: (token: string) => void }) => { rendered.push(options); return "w1"; },
    reset: () => { resets++; setTimeout(() => rendered[0]!.callback(`answer-${resets + 1}`), 0); },
  };
  window.document.body.innerHTML = renderFormHtml(form, embed, { registry: buildCoreBlockRegistry() });
  const posts: FormData[] = [];
  window.fetch = (async (_url: string, init: RequestInit) => {
    posts.push(init.body as FormData);
    const body = posts.length === 1
      ? { ok: false, errors: [{ field: null, code: "spam_check_failed", message: "Try again" }] }
      : posts.length === 2 ? { ok: true, state: "signed-state", next_step: "two" } : { ok: true, done: true };
    return new Response(JSON.stringify(body));
  }) as never;
  window.eval(FORMS_RUNTIME_JS);
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  const el = window.document.querySelector("form")!;
  el.dispatchEvent(new window.Event("focusin"));
  await new Promise((r) => setTimeout(r, 10));
  expect(rendered).toHaveLength(1);
  expect(rendered[0]!.sitekey).toBe("0x4AAAAAAAsitekey");
  rendered[0]!.callback("answer-1");

  const submit = async () => { el.dispatchEvent(new window.Event("submit", { cancelable: true })); await new Promise((r) => setTimeout(r, 30)); };
  (window.document.querySelector("[name=name]") as unknown as { value: string }).value = "Ada";
  await submit();
  expect(posts[0]!.get("cf-turnstile-response")).toBe("answer-1");
  expect(resets).toBe(1);
  await submit();
  expect(posts[1]!.get("cf-turnstile-response")).toBe("answer-2");
  expect((window.document.querySelector("[data-tr-turnstile]") as unknown as { hidden: boolean }).hidden).toBe(true);
  await submit();
  expect(posts[2]!.get("_state")).toBe("signed-state");
  expect(posts[2]!.has("cf-turnstile-response")).toBe(false);
});

it("still posts when the Turnstile script cannot load, leaving the decision to the server", async () => {
  const window = new Window({ url: "https://site.example.test/contact", settings: { disableJavaScriptFileLoading: true, handleDisabledFileLoadingAsSuccess: false } });
  open = window;
  window.document.body.innerHTML = renderFormHtml(form, embed, { registry: buildCoreBlockRegistry() });
  const posts: FormData[] = [];
  window.fetch = (async (_url: string, init: RequestInit) => { posts.push(init.body as FormData); return new Response(JSON.stringify({ ok: true, done: true })); }) as never;
  window.eval(FORMS_RUNTIME_JS);
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  const el = window.document.querySelector("form")!;
  el.dispatchEvent(new window.Event("submit", { cancelable: true }));
  await new Promise((r) => setTimeout(r, 50));
  expect(posts).toHaveLength(1);
  expect(posts[0]!.has("cf-turnstile-response")).toBe(false);
});
