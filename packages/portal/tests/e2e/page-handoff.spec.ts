/**
 * The page handoff end to end: a visitor types into a native navigation
 * banner, continues, and the destination page is prefilled — by a native
 * receiving form or by an Extension component through `context.handoff`.
 *
 * Published pages keep the handoff in tab storage. Preview links run the page
 * in an opaque frame without Web Storage, where the trusted shell keeps it.
 * Values must never reach a URL or a request.
 */
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildCoreBlockRegistry,
  buildExtensionRuntimeScript,
  collectBlockAssets,
  renderBlocks,
  type Block,
  type BlockType,
  type ExtensionRuntimeSnapshot,
} from "@typeroll/shared";
import { sanitizeBody } from "../../src/lib/sanitize";
import {
  buildExtensionPreviewShell,
  extensionPreviewShellHeaders,
} from "../../src/lib/extensions/preview-shell";
import {
  buildPreviewNavigationBridgeScript,
  rewriteInternalHrefs,
} from "../../src/lib/preview-navigation-bridge";
import { isolatedPreviewHeaders } from "../../src/lib/preview-headers";

const FROM = "Storgatan 1, 111 22 Stockholm";
const TO = "Kungsgatan 2, Uppsala";
const PRIVATE_VALUES = ["Storgatan", "Kungsgatan", "111%2022", "111 22"];

function banner(destination: string): Block {
  return {
    id: "banner",
    type: "core/navigation_form",
    data: {
      destination,
      handoff_key: "moveria-moving",
      button_label: "Get quotes",
      fields: [
        { name: "address_from", label: "Moving from", required: true, suggest_address: true },
        { name: "address_to", label: "Moving to", required: true },
        { name: "m2", label: "Area", kind: "number" },
      ],
    },
  };
}

// A stand-in for the address suggestion provider: every keystroke "selects"
// the typed address, so the banner carries structured parts as it would after
// a real suggestion was picked.
const FAKE_ADDRESS_PROVIDER = `window.TyperollClientCapabilities={address_autocomplete:{attach:function(input,options,select){input.addEventListener("input",function(){select({street:"Storgatan",street_number:"1",postal_code:"111 22",locality:"Stockholm",country:"SE",formatted:input.value});});return true;}}};`;

test.describe("Extension component on a page after a native banner", () => {
  const registry = buildCoreBlockRegistry();
  const leadForm: BlockType = {
    id: "extension--market-engine--lead-form",
    name: "market-engine-lead-form",
    label: "Lead form",
    icon: "Blocks",
    category: "custom",
    container: false,
    schema: [{ name: "page_handoff_key", type: "text", label: "Prefill from navigation inputs" }],
    template: '<div class="tr-extension-mount"><p class="tr-extension-placeholder">Lead form loads on the published site.</p></div>',
    origin: "third_party",
    extension: {
      extension_id: "se.autopilot.market-engine",
      installation_id: "market-engine",
      component_id: "lead-form",
      render_mode: "bundled_component",
    },
    created_at: "1970-01-01T00:00:00.000Z",
  };
  registry.set(leadForm.id, leadForm);

  // The provider bundle. It only asks the host; it never names a storage key.
  const BUNDLE = `export async function mount(el, props, context) {
  el.innerHTML = '<form><label>From <input name="from"></label><label>From postal code <input name="from_postal_code"></label><label>To <input name="to"></label><label>Square metres <input name="area"></label></form>';
  const form = el.querySelector("form");
  const handoff = context.handoff ? await context.handoff.read() : null;
  if (handoff) {
    form.from.value = handoff.values.address_from || "";
    form.from_postal_code.value = (handoff.parts.address_from && handoff.parts.address_from.postal_code) || "";
    form.to.value = handoff.values.address_to || "";
    form.area.value = handoff.values.m2 || "";
  }
  el.dataset.handoff = handoff ? "received" : "empty";
}`;
  const BLOCKS_RUNTIME = (js: string) =>
    `(function(){var registry={};window.TyperollBlocks={register:function(id,init){registry[id]=init;},init:function(){Object.keys(registry).forEach(function(id){document.querySelectorAll('[data-block-type="'+id+'"]').forEach(function(el){try{registry[id](el,JSON.parse(el.getAttribute('data-block-data')||'{}'));}catch(e){console.error('[block init]',id,e);}});});}};${js};window.TyperollBlocks.init();})();`;

  function snapshot(scriptUrl: string, preview: boolean): ExtensionRuntimeSnapshot {
    return {
      runtime_version: "0.43.0",
      protocol_version: 3,
      installations: [{
        installation_id: "market-engine",
        extension_id: "se.autopilot.market-engine",
        version: "1.0.0",
        ...(preview ? { preview: true as const } : {}),
        public_config: {},
        components: [{
          id: "lead-form",
          block_type_id: leadForm.id,
          label: "Lead form",
          render_mode: "bundled_component",
          page_handoff: true,
          local_script_url: scriptUrl,
          entry: { script_url: "https://cdn.market-engine.example/lead-form.js", script_sha256: "a".repeat(64) },
        }],
      }],
    };
  }

  /** Mirrors the published layout and the preview renderer: block scripts,
   *  then the Extension host, with the preview bridge first in a preview. */
  function documentFor(blocks: Block[], scripts: { previewBridge?: string; extensionRuntime?: string; rewrite?: (html: string) => string }) {
    const assets = collectBlockAssets(blocks, registry);
    const body = sanitizeBody(renderBlocks(blocks, { registry }));
    return `<!doctype html><html lang="sv"><head><meta charset="utf-8"><style>${assets.css}</style><script>${FAKE_ADDRESS_PROVIDER}</script></head><body><main>${scripts.rewrite ? scripts.rewrite(body) : body}</main>${scripts.previewBridge ? `<script>${scripts.previewBridge}</script>` : ""}<script>${BLOCKS_RUNTIME(assets.js)}</script>${scripts.extensionRuntime && body.includes("data-tr-extension-installation") ? `<script>${scripts.extensionRuntime}</script>` : ""}</body></html>`;
  }

  const quoteBlocks: Block[] = [{ id: "lead", type: leadForm.id, data: { page_handoff_key: "moveria-moving" } }];

  async function fillBanner(scope: Page | ReturnType<Page["frameLocator"]>) {
    await scope.getByLabel("Moving from", { exact: true }).fill(FROM);
    await scope.getByLabel("Moving to", { exact: true }).fill(TO);
    await scope.getByLabel("Area", { exact: true }).fill("75");
    await scope.getByRole("button", { name: "Get quotes" }).click();
  }

  async function expectPrefilled(scope: Page | ReturnType<Page["frameLocator"]>) {
    await expect(scope.locator('[data-handoff="received"]')).toBeVisible();
    await expect(scope.getByLabel("From", { exact: true })).toHaveValue(FROM);
    await expect(scope.getByLabel("From postal code")).toHaveValue("111 22");
    await expect(scope.getByLabel("To", { exact: true })).toHaveValue(TO);
    await expect(scope.getByLabel("Square metres")).toHaveValue("75");
  }

  async function expectEmpty(scope: Page | ReturnType<Page["frameLocator"]>) {
    await expect(scope.locator('[data-handoff="empty"]')).toBeVisible();
    for (const label of ["From", "To", "Square metres"]) await expect(scope.getByLabel(label, { exact: true })).toHaveValue("");
  }

  test("published: the component receives the banner's values and parts without touching storage itself", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    const assetPath = "/_assets/extensions/se.autopilot.market-engine/1.0.0/lead-form/index.js";
    const runtime = buildExtensionRuntimeScript(snapshot(assetPath, false));
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "https://moveria.test") return route.abort();
      if (url.pathname === assetPath) return route.fulfill({ contentType: "text/javascript", body: BUNDLE });
      const blocks = url.pathname === "/flyttfirmeoffert/" ? quoteBlocks : [banner("/flyttfirmeoffert/")];
      return route.fulfill({ contentType: "text/html", body: documentFor(blocks, { extensionRuntime: runtime }) });
    });

    await page.goto("https://moveria.test/");
    await fillBanner(page);
    await page.waitForURL("https://moveria.test/flyttfirmeoffert/");
    await expectPrefilled(page);
    // Taken once: the private key is gone and a reload renders the empty form.
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.includes("page-defaults")))).toEqual([]);
    await page.reload();
    await expectEmpty(page);

    // Expired data renders the empty form, without an error or partial prefill.
    await page.evaluate(() => sessionStorage.setItem("typeroll:page-defaults:v1:moveria-moving", JSON.stringify({
      version: 1, target: "/flyttfirmeoffert/", expires: Date.now() - 1, values: { address_from: "Stale" },
    })));
    await page.reload();
    await expectEmpty(page);

    for (const value of PRIVATE_VALUES) expect(requests.filter((url) => url.includes(value))).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("preview link: the opaque frame gets the handoff from the shell, not from sessionStorage", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    const origin = "https://app.typeroll.test";
    const root = "/preview/site";
    const bundleUrl = `data:text/javascript;base64,${Buffer.from(BUNDLE).toString("base64")}`;
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || !url.pathname.startsWith(`${root}/`)) return route.abort();
      if (url.searchParams.get("frame") !== "1") {
        return route.fulfill({
          headers: extensionPreviewShellHeaders(),
          body: buildExtensionPreviewShell({ siteId: "site", bridgeId: "00000000-0000-4000-8000-000000000001", rootPath: root, storageScope: "ticket", carriedQuery: { t: "ticket" } }),
        });
      }
      const bridge = { id: url.searchParams.get("bridge")!, parentOrigin: origin };
      const navigation = { browseRoot: root, embedSuffix: "?t=ticket", extensionPreviewBridge: bridge };
      const blocks = url.pathname === `${root}/flyttfirmeoffert/` ? quoteBlocks : [banner("/flyttfirmeoffert/")];
      return route.fulfill({
        headers: { ...isolatedPreviewHeaders(), "Content-Type": "text/html; charset=utf-8" },
        body: documentFor(blocks, {
          previewBridge: buildPreviewNavigationBridgeScript(navigation),
          extensionRuntime: buildExtensionRuntimeScript(snapshot(bundleUrl, true), {
            site_navigation: { base_path: root, suffix: "?t=ticket" },
            preview_bridge: { id: bridge.id, parent_origin: origin },
          }),
          rewrite: (html) => rewriteInternalHrefs(html, root, "?t=ticket"),
        }),
      });
    });

    await page.goto(`${origin}${root}/?t=ticket`);
    const frame = page.frameLocator("#preview");
    // The frame really is opaque: a naive sessionStorage read would fail here.
    await expect(frame.getByRole("button", { name: "Get quotes" })).toBeVisible();
    expect(await page.frames()[1]!.evaluate(() => { try { return typeof window.sessionStorage; } catch { return "denied"; } })).toBe("denied");

    await fillBanner(frame);
    await page.waitForURL(`${origin}${root}/flyttfirmeoffert/?t=ticket`);
    await expectPrefilled(frame);

    await page.reload();
    await expectEmpty(page.frameLocator("#preview"));

    for (const value of PRIVATE_VALUES) expect(requests.filter((url) => url.includes(value))).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test.describe("native receiving form in a real preview link", () => {
  const SITE = path.join(os.tmpdir(), "typeroll-e2e-fixtures", "organizations/default/sites/default");

  test("the banner's handoff reaches the next preview page through the shell", async ({ page, baseURL }) => {
    const id = `e2ehandoff${Date.now()}`;
    const start = path.join(SITE, "versions/main/pages", `${id}.json`);
    const quote = path.join(SITE, "versions/main/pages", `${id}-quote.json`);
    const page_ = (title: string, slug: string, blocks: Block[]) => JSON.stringify({
      title, slug, path: `/${slug}`, content_mode: "blocks", status: "published",
      content_type: "page", fields: {}, date_updated: new Date().toISOString(), blocks,
    });
    await fs.writeFile(start, page_("Handoff start", id, [banner(`/${id}-quote/`)]));
    await fs.writeFile(quote, page_("Handoff quote", `${id}-quote`, [{
      id: "receive",
      type: "core/navigation_form",
      data: {
        mode: "receive",
        handoff_key: "moveria-moving",
        fields: [
          { name: "address_from", label: "From" },
          { name: "address_from_postal_code", label: "Postal code" },
          { name: "address_to", label: "To" },
          { name: "m2", label: "Square metres", kind: "number" },
          { name: "rooms", label: "Rooms" },
        ],
      },
    }]));
    try {
      const link = await page.request.post("/api/sites/default/preview-link", { headers: { Origin: new URL(baseURL!).origin }, data: { path: id } });
      expect(link.status(), await link.text()).toBe(200);
      const { url } = await link.json() as { url: string };
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const requests: string[] = [];
      page.on("request", (request) => requests.push(request.url()));

      await page.goto(url);
      const frame = page.frameLocator("iframe");
      const decline = frame.getByRole("button", { name: "Neka" });
      if (await decline.isVisible({ timeout: 5_000 }).catch(() => false)) await decline.click();
      await frame.getByLabel("Moving from", { exact: true }).fill(FROM);
      await frame.getByLabel("Moving to", { exact: true }).fill(TO);
      await frame.getByLabel("Area", { exact: true }).fill("75");
      await frame.getByRole("button", { name: "Get quotes" }).click();

      // The shell moved, not just the frame, and kept the preview ticket.
      await page.waitForURL((current) => current.pathname === `/preview/default/${id}-quote/` && current.searchParams.has("t"));
      const next = page.frameLocator("iframe");
      await expect(next.getByLabel("From", { exact: true })).toHaveValue(FROM);
      await expect(next.getByLabel("To", { exact: true })).toHaveValue(TO);
      await expect(next.getByLabel("Square metres")).toHaveValue("75");
      // No suggestion provider runs in preview, so no parts were carried.
      await expect(next.getByLabel("Postal code")).toHaveValue("");

      await page.reload();
      await expect(page.frameLocator("iframe").getByLabel("From", { exact: true })).toHaveValue("");
      for (const value of PRIVATE_VALUES) expect(requests.filter((request) => request.includes(value))).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await fs.rm(start, { force: true });
      await fs.rm(quote, { force: true });
    }
  });
});
