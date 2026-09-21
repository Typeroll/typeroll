import { sanitizeBody } from "../../src/lib/sanitize";
import { expect, test } from "@playwright/test";
import {
  buildCoreBlockRegistry,
  collectBlockAssets,
  renderBlocks,
  type Block,
} from "@typeroll/shared";

const registry = buildCoreBlockRegistry();
const documentFor = (blocks: Block[]) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>*{box-sizing:border-box}body{margin:0;padding:20px;background:#edf3f5;font:14.4px/1.1 Arial;color:#222}${collectBlockAssets(blocks, registry).css}</style>${sanitizeBody(renderBlocks(blocks, { registry, annotate: true }))}`;

test("explicit compact links keep a 28px rhythm on phones and desktops while wrapped labels grow", async ({
  page,
}, info) => {
  const links = [
    { label: "Moving checklist", href: "/checklist/" },
    { label: "Packing advice", href: "/packing/" },
    {
      label:
        "Advice about your move with a deliberately long category label that wraps naturally",
      href: "/long/",
    },
  ];
  const blocks: Block[] = [
    {
      id: "compact",
      type: "core/navigation_links",
      data: {
        density: "compact",
        links,
        font_size_px: 14.4,
        line_height: 1.1,
        padding_y_px: 0,
        gap_px: 4,
      },
    },
    {
      id: "comfortable",
      type: "core/navigation_links",
      data: { links: links.slice(0, 1) },
    },
    {
      id: "responsive",
      type: "core/navigation_links",
      data: {
        density: "compact",
        links: links.slice(0, 1),
        link_min_height_px: { mobile: 24, desktop: 32 },
      },
    },
  ];
  await page.setContent(documentFor(blocks));
  for (const width of [320, 390, 576, 577, 768, 769, 1024, 1280]) {
    await page.setViewportSize({ width, height: 650 });
    const items = page.locator('[data-block-id="compact"] a');
    const first = (await items.nth(0).boundingBox())!,
      second = (await items.nth(1).boundingBox())!;
    expect(first.height).toBeCloseTo(24, 2);
    expect(second.y - first.y).toBeCloseTo(28, 2);
    expect((await items.nth(2).boundingBox())!.height).toBeGreaterThanOrEqual(
      24,
    );
    expect(
      (await page.locator('[data-block-id="comfortable"] a').boundingBox())!
        .height,
    ).toBeCloseTo(44, 2);
    expect(
      (await page.locator('[data-block-id="responsive"] a').boundingBox())!
        .height,
    ).toBeCloseTo(width < 1280 ? 24 : 32, 2);
    await items.first().focus();
    await expect(items.first()).toHaveCSS("outline-style", "solid");
    expect(
      await items.evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("href")),
      ),
    ).toEqual(links.map((link) => link.href));
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    if ([320, 390, 768, 1280].includes(width))
      await page.screenshot({
        path: info.outputPath(`compact-${width}.png`),
        fullPage: true,
      });
  }
});

test("a real thumbnail and a configured missing-image panel share card geometry and accessible links", async ({
  page,
}, info) => {
  const image =
    "data:image/svg+xml," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#87b6c6"/><circle cx="320" cy="180" r="75" fill="#eaf4f7"/></svg>',
    );
  const blocks: Block[] = [
    {
      id: "cards",
      type: "core/repeater",
      data: {
        source_type: "static",
        item_block: "core/post_card",
        layout: "grid",
        cols: "2",
        mobile_cols: "1",
        items: [
          {
            title: "Guide with a photo",
            url: "/photo/",
            image,
            image_alt: "Illustrated packing box",
          },
          { title: "Guide without a photo", url: "/placeholder/", image: "" },
        ],
        item_overrides: {
          appearance: "card",
          missing_image: "placeholder",
          placeholder_icon: "🚚",
          placeholder_background: "#00aaaa",
          placeholder_icon_size_px: 56,
          image_sizing: "fixed",
          image_height_px: 160,
          image_fit: "cover",
          whole_card_link: true,
          show_date: false,
        },
      },
    },
  ];
  await page.setContent(documentFor(blocks));
  for (const width of [320, 390, 576, 768, 1024, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    const cards = page.locator('[data-block="post_card"]'),
      real = cards.nth(0).locator("img"),
      placeholder = cards.nth(1).locator(".block-postcard-placeholder");
    await expect(real).toHaveJSProperty("complete", true);
    expect(await real.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(
      640,
    );
    expect((await real.boundingBox())!.height).toBeCloseTo(160, 2);
    const panel = (await placeholder.boundingBox())!,
      icon = (await placeholder.locator("span").boundingBox())!;
    expect(panel.height).toBeCloseTo(160, 2);
    await expect(placeholder).toHaveCSS("background-color", "rgb(0, 170, 170)");
    expect(
      Math.abs(icon.x + icon.width / 2 - panel.x - panel.width / 2),
    ).toBeLessThan(1);
    expect(
      Math.abs(icon.y + icon.height / 2 - panel.y - panel.height / 2),
    ).toBeLessThan(1);
    await expect(
      cards
        .nth(1)
        .getByRole("link", { name: "Guide without a photo", exact: true }),
    ).toHaveCount(1);
    await expect(cards.nth(1).getByRole("img")).toHaveCount(0);
    if (width >= 768)
      expect((await cards.nth(0).locator("h3").boundingBox())!.y).toBe(
        (await cards.nth(1).locator("h3").boundingBox())!.y,
      );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    if ([390, 768, 1280].includes(width))
      await page.screenshot({
        path: info.outputPath(`placeholder-${width}.png`),
        fullPage: true,
      });
  }
});

const navigationBlocks: Block[] = [
  {
    id: "services",
    type: "core/tabs",
    data: {
      collapse_below: "1025",
      collapse_mode: "panels",
      labels: [
        { label: "Moving", icon: "🚚" },
        { label: "Cleaning", icon: "🧹" },
        { label: "Broadband", icon: "🌐", href: "/broadband/" },
      ],
    },
    slots: [
      [
        {
          id: "move",
          type: "core/navigation_form",
          data: {
            destination: "/quote/",
            handoff_key: "move",
            columns: "2",
            responsive_breakpoints: {
              tablet: 577,
              laptop: 769,
              desktop: 1025,
              wide: 1536,
            },
            column_widths: {
              mobile: "1fr 1fr",
              tablet: "1fr 180px",
              laptop: "1fr 240px",
              desktop: "2fr 2fr 1fr 1fr",
            },
            button_column: { mobile: "2", desktop: "4" },
            button_row: { mobile: "3", tablet: "2", desktop: "1" },
            fields: [
              {
                name: "address_from",
                label: "From",
                required: true,
                column: { mobile: "full", tablet: "1", desktop: "1" },
                row: "1",
              },
              {
                name: "address_to",
                label: "To",
                required: true,
                column: { mobile: "full", tablet: "1", desktop: "2" },
                row: { mobile: "2", desktop: "1" },
              },
              {
                name: "area",
                label: "Area",
                kind: "number",
                column: { mobile: "1", tablet: "2", desktop: "3" },
                row: { mobile: "3", tablet: "1" },
              },
            ],
          },
        },
      ],
      [
        {
          id: "clean",
          type: "core/navigation_form",
          data: {
            destination: "/clean/",
            handoff_key: "clean",
            fields: [{ name: "address", label: "Address" }],
          },
        },
      ],
    ],
  },
];
const receiver: Block[] = [
  {
    id: "receive",
    type: "core/navigation_form",
    data: {
      mode: "receive",
      handoff_key: "move",
      fields: [
        { name: "address_from", label: "From" },
        { name: "area", label: "Area", kind: "number" },
      ],
    },
  },
];
const interactiveDocument = (blocks: Block[]) =>
  documentFor(blocks) +
  `<script>window.TyperollBlocks={register(id,init){document.querySelectorAll('[data-block-type="'+id+'"]').forEach(init)}};${collectBlockAssets(blocks, registry).js}</script>`;

async function mockNavigationSite(
  page: import("@playwright/test").Page,
  options: { storageDisabled?: boolean; noScript?: boolean } = {},
) {
  if (options.storageDisabled)
    await page.addInitScript(() => {
      Object.defineProperty(window, "sessionStorage", {
        get() {
          throw new Error("Storage unavailable");
        },
      });
    });
  const requests: string[] = [];
  page.on("request", (request) =>
    requests.push(request.method() + " " + request.url()),
  );
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin !== "https://navigation.test")
      return route.abort();
    const blocks =
      new URL(route.request().url()).pathname === "/quote/"
        ? receiver
        : navigationBlocks;
    return route.fulfill({
      contentType: "text/html",
      body: options.noScript
        ? documentFor(blocks)
        : interactiveDocument(blocks),
    });
  });
  await page.goto("https://navigation.test/start/");
  return requests;
}

test("mixed tabs preserve local inputs, expose links, and navigate without sending values", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const requests = await mockNavigationSite(page);
  for (const width of [320, 390, 576, 577, 768, 769, 1024, 1025, 1280, 1536]) {
    await page.setViewportSize({ width, height: 750 });
    const moving = page.getByRole("tab", { name: "Moving" });
    if (!(await page.getByLabel("From", { exact: true }).isVisible()))
      await moving.click();
    await page.getByLabel("From", { exact: true }).fill("12 Private Street");
    await page.getByLabel("To", { exact: true }).fill("34 Destination Road");
    await page.getByLabel("Area", { exact: true }).fill("75");
    const from = (await page
        .getByLabel("From", { exact: true })
        .boundingBox())!,
      to = (await page.getByLabel("To", { exact: true }).boundingBox())!,
      area = (await page.getByLabel("Area", { exact: true }).boundingBox())!,
      button = (await page
        .getByRole("button", { name: "Continue", exact: true })
        .boundingBox())!;
    if (width <= 576) {
      expect(to.y).toBeGreaterThan(from.y);
      expect(Math.abs(area.y - button.y)).toBeLessThan(1);
      expect(area.width).toBeLessThan(from.width);
    } else if (width < 1025) {
      expect(from.y).toBe(area.y);
      expect(Math.abs(to.y - button.y)).toBeLessThan(1);
      expect(area.x).toBe(button.x);
    } else {
      expect(from.y).toBe(to.y);
      expect(to.y).toBe(area.y);
      expect(Math.abs(area.y - button.y)).toBeLessThan(1);
    }
    await page.getByRole("tab", { name: "Cleaning" }).click();
    await expect(page.getByLabel("Address", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Cleaning" }).press("ArrowLeft");
    await expect(moving).toBeFocused();
    await expect(page.getByLabel("From", { exact: true })).toHaveValue(
      "12 Private Street",
    );
    await expect(page.getByRole("link", { name: "Broadband" })).toHaveAttribute(
      "href",
      "/broadband/",
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    if ([390, 768, 1280].includes(width))
      await page.screenshot({
        path: info.outputPath(`banner-${width}.png`),
        fullPage: true,
      });
  }
  expect(errors).toEqual([]);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForURL("https://navigation.test/quote/");
  await expect(page.getByLabel("From", { exact: true })).toHaveValue(
    "12 Private Street",
  );
  await expect(page.getByLabel("Area", { exact: true })).toHaveValue("75");
  expect(requests).toEqual([
    "GET https://navigation.test/start/",
    "GET https://navigation.test/quote/",
  ]);
  expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
  await page.reload();
  // Firefox may restore native input state. The handoff itself must be consumed.
  expect(
    await page.evaluate(
      "window.TyperollPageHandoff.consume('move', ['address_from'])",
    ),
  ).toEqual({});
});

test("storage denial and missing JavaScript retain safe navigation without query defaults", async ({
  page,
}) => {
  await mockNavigationSite(page, { storageDisabled: true });
  await page.getByRole("tab", { name: "Moving" }).click();
  await page.getByLabel("From", { exact: true }).fill("Private");
  await page.getByLabel("To", { exact: true }).fill("Address");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL("https://navigation.test/quote/");
  await expect(page.getByLabel("From", { exact: true })).toHaveValue("");
  await mockNavigationSite(page, { noScript: true });
  await page.getByLabel("From", { exact: true }).fill("Private");
  await page.getByRole("link", { name: "Continue" }).first().click();
  await page.waitForURL("https://navigation.test/quote/");
  await expect(page.getByLabel("From", { exact: true })).toHaveValue("");
});

test("handoff validates expiry, target and field allowlist before prefilling", async ({
  page,
}) => {
  await mockNavigationSite(page);
  for (const patch of [
    { expires: Date.now() - 1 },
    { expires: Date.now() + 910000 },
    { target: "/other/" },
  ]) {
    await page.evaluate(
      (patch) =>
        sessionStorage.setItem(
          "typeroll:page-defaults:v1:move",
          JSON.stringify({
            version: 1,
            expires: Date.now() + 900000,
            target: "/quote/",
            values: { address_from: "Private" },
            ...patch,
          }),
        ),
      patch,
    );
    await page.goto("https://navigation.test/quote/");
    await expect(page.getByLabel("From", { exact: true })).toHaveValue("");
  }
  await page.evaluate(() =>
    sessionStorage.setItem(
      "typeroll:page-defaults:v1:move",
      JSON.stringify({
        version: 1,
        expires: Date.now() + 900000,
        target: "/quote/",
        values: {
          address_from: "Allowed",
          area: "85",
          admin: "true",
          constructor: "evil",
          address_to: "Not accepted here",
        },
      }),
    ),
  );
  await page.reload();
  await expect(page.getByLabel("From", { exact: true })).toHaveValue("Allowed");
  await expect(page.getByLabel("Area", { exact: true })).toHaveValue("85");
  expect(
    await page.evaluate(() =>
      Object.prototype.hasOwnProperty.call(Object.prototype, "admin"),
    ),
  ).toBe(false);
});

test("preview navigation keeps its preview route and suffix while passing private defaults locally", async ({
  page,
}) => {
  await page.route("https://navigation.test/**", (route) => {
    const receiving =
      new URL(route.request().url()).pathname === "/preview/demo/quote/";
    return route.fulfill({
      contentType: "text/html",
      body: interactiveDocument(
        receiving ? receiver : navigationBlocks,
      ).replaceAll('href="/quote/"', 'href="/preview/demo/quote/?embed=1"'),
    });
  });
  await page.goto("https://navigation.test/preview/demo/start/?embed=1");
  await page
    .getByLabel("From", { exact: true })
    .fill("Private preview address");
  await page.getByLabel("To", { exact: true }).fill("Destination");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL("https://navigation.test/preview/demo/quote/?embed=1");
  await expect(page.getByLabel("From", { exact: true })).toHaveValue(
    "Private preview address",
  );
});
