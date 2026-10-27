import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import {
  buildCoreBlockRegistry,
  collectBlockAssets,
  renderBlocks,
  siteThemeCss,
  siteStylesCss,
  defaultSiteSettings,
  contentWellCss,
  newSiteStyles,
  resolveBreakpointWidths,
  type Block,
} from "@typeroll/shared";
const globalCss = readFileSync(
  new URL("../../../site-template/src/styles/global.css", import.meta.url),
  "utf8",
);
const registry = buildCoreBlockRegistry();
const heading = (id: string, text: string): Block => ({
  id,
  type: "core/heading",
  data: { level: "h2", size: "theme", text },
});
const prose = (id: string): Block => ({
  id,
  type: "core/prose",
  data: { html: "<p>Content below the heading.</p>" },
});
const links = (id: string, gap?: number): Block => ({
  id,
  type: "core/navigation_links",
  data: {
    density: "compact-desktop",
    ...(gap === undefined ? {} : { gap_px: gap }),
    links: [
      { label: "First destination", href: "/first" },
      { label: "Second destination", href: "/second" },
    ],
  },
});
const fixture: Block[] = [
  {
    id: "columns",
    type: "core/columns",
    data: {},
    slots: [
      [
        {
          id: "article",
          type: "core/container",
          data: { rhythm: "article" },
          children: [
            heading("opening", "Opening title"),
            {
              id: "image",
              type: "core/html",
              data: {
                html: '<div id="image" style="height:120px;background:#ccc" role="img" aria-label="Image"></div>',
              },
            },
            heading("after-image", "Heading after image"),
            prose("article-text"),
            {
              id: "prose-headings",
              type: "core/prose",
              data: {
                html: "<p>Paragraph.</p><h2>Later prose heading</h2><p>More content.</p>",
              },
            },
          ],
        },
      ],
      [heading("column-opening", "Column opening")],
    ],
  },
  {
    id: "card",
    type: "core/post_card",
    data: { title: "Card title", title_tag: "h2", excerpt: "Card description" },
  },
  {
    id: "override",
    type: "core/container",
    data: { rhythm: "article", heading_before_px: 18, heading_after_px: 7 },
    children: [
      prose("override-intro"),
      heading("explicit", "Explicit spacing"),
      prose("override-text"),
    ],
  },
  {
    id: "footer",
    type: "core/container",
    data: { gap: "sm" },
    children: [
      heading("footer-heading", "Destinations"),
      links("footer-links"),
    ],
  },
  links("explicit-links", 20),
  {
    ...heading("named", "Named spacing"),
    data: {
      ...heading("named", "Named spacing").data,
      style_id: "tight-heading",
    },
  },
];
for (const width of [375, 768, 1280])
  for (const savedStyles of [false, true])
    test(`contextual spacing at ${width}px, saved roles ${savedStyles}`, async ({
      page,
    }, info) => {
      const version = 11;
      await page.setViewportSize({ width, height: 1000 });
      const settings = {
        ...structuredClone(defaultSiteSettings),
        render_version: version,
        styles: [
          ...(savedStyles ? newSiteStyles() : []),
          {
            id: "tight-heading",
            name: "Tight heading",
            targets: ["heading" as const],
            base: { space_before: "0", space_after: "0" },
          },
        ],
      };
      const assets = collectBlockAssets(fixture, registry, {
        renderVersion: version,
      });
      await page.setContent(
        `<style>${globalCss}${contentWellCss(version)}${assets.css}${siteThemeCss(settings)}${siteStylesCss(settings.styles, { colors: settings.colors, breakpoints: resolveBreakpointWidths(), renderVersion: version })}</style><main class="page-content">${renderBlocks(fixture, { registry, renderVersion: version, annotate: true, provenance: true })}</main>`,
      );
      const image = await page.locator("#image").boundingBox();
      const title = await page
        .getByRole("heading", { name: "Heading after image", exact: true })
        .boundingBox();
      expect(title!.y - image!.y - image!.height).toBeGreaterThan(20);
      for (const name of [
        "Opening title",
        "Column opening",
        "Card title",
        "Destinations",
      ])
        await expect(
          page.getByRole("heading", { name, exact: true }),
        ).toHaveCSS("margin-top", "0px");
      expect(
        await page
          .getByRole("heading", { name: "Later prose heading" })
          .evaluate((el) => parseFloat(getComputedStyle(el).marginTop)),
      ).toBeGreaterThan(20);
      await expect(
        page.getByRole("heading", { name: "Explicit spacing" }),
      ).toHaveCSS("margin-top", "18px");
      await expect(
        page.getByRole("heading", { name: "Explicit spacing" }),
      ).toHaveCSS("margin-bottom", "7px");
      await expect(
        page.locator('[data-source-block-id="explicit-links"]'),
      ).toHaveCSS("row-gap", "20px");
      await expect(
        page.getByRole("heading", { name: "Named spacing" }),
      ).toHaveCSS("margin-top", "0px");
      await expect(
        page.getByRole("heading", { name: "Named spacing" }),
      ).toHaveCSS("margin-bottom", "0px");
      const footer = page.locator('[data-source-block-id="footer-links"]');
      if (width < 1024) {
        await expect(footer).toHaveCSS("row-gap", "0px");
        const first = await footer.locator("a").first().boundingBox();
        const second = await footer.locator("a").nth(1).boundingBox();
        const textGap = await page.evaluate(() => {
          const glyph = (el: Element) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            return range.getBoundingClientRect();
          };
          const heading = glyph(
            document.querySelector(
              '[data-source-block-id="footer-heading"] h2',
            )!,
          );
          const links = document.querySelectorAll(
            '[data-source-block-id="footer-links"] a',
          );
          const first = glyph(links[0]);
          const second = glyph(links[1]);
          return {
            headingToLink: first.top - heading.bottom,
            betweenLinks: second.top - first.bottom,
          };
        });
        expect(textGap.headingToLink).toBeGreaterThan(textGap.betweenLinks);
        expect(first!.height).toBeGreaterThanOrEqual(44);
        expect(second!.y - first!.y - first!.height).toBeCloseTo(0);
      } else await expect(footer).toHaveCSS("row-gap", "4px");
      await page.screenshot({
        path: info.outputPath(`rhythm-${width}-${savedStyles}.png`),
        fullPage: true,
      });
    });
