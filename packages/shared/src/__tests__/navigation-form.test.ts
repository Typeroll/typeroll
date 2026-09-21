import { describe, it, expect } from "vitest";
import { buildCoreBlockRegistry } from "../core-blocks.js";
import { renderBlocks } from "../render-blocks.js";
const registry = buildCoreBlockRegistry();
const render = (data: Record<string, unknown>) =>
  renderBlocks([{ id: "start", type: "core/navigation_form", data }], {
    registry,
  });
describe("local navigation inputs", () => {
  it("renders native labelled fields without a submission endpoint or URL values", () => {
    const html = render({
      destination: "/quote/",
      fields: [
        { name: "address", label: "Address" },
        { name: "area", label: "Area", kind: "number" },
      ],
    });
    expect(html).toContain('role="form"');
    expect(html).toContain('href="/quote/"');
    expect(html).toContain('type="number"');
    expect(html).toContain('for="nav-start-address"');
    expect(html).not.toMatch(/<form\b|\baction=|\bmethod=|data-tr-form/);
  });
  it("rejects external, protocol-relative, query-bearing and encoded unsafe destinations", () => {
    for (const destination of [
      "https://other.test/",
      "//other.test/",
      "/quote/?address=x",
      "/\\evil.test/",
      "/%2fother.test/",
    ])
      expect(render({ destination, fields: [] })).not.toContain("href=");
  });
  it("does not render private or duplicate field names and escapes authored markup", () => {
    const html = render({
      destination: "/quote/",
      fields: [
        { name: "__proto__", label: "Bad" },
        { name: "address", label: "<script>x</script>" },
        { name: "address", label: "Duplicate" },
        { name: "password", label: "Secret", kind: "password" },
      ],
    });
    expect(html).not.toContain("Bad");
    expect(html).not.toContain("Duplicate");
    expect(html).not.toContain('type="password"');
    expect(html).toContain("&lt;script&gt;");
    expect(html.match(/name="address"/g) || []).toHaveLength(1);
  });
});

it("renders tab slots, icons and direct links in the static artifact", () => {
  const html = renderBlocks(
    [
      {
        id: "services",
        type: "core/tabs",
        data: {
          labels: [
            { label: "Move", icon: "🚚" },
            { label: "Internet", href: "/internet/" },
            { label: "Unsafe", href: "javascript:alert(1)" },
          ],
        },
        slots: [
          [
            {
              id: "input",
              type: "core/navigation_form",
              data: {
                destination: "/quote/",
                fields: [{ name: "area", label: "Area" }],
              },
            },
          ],
        ],
      },
    ],
    { registry },
  );
  expect(html).toContain('role="tab"');
  expect(html).toContain('href="/internet/"');
  expect(html).toContain('aria-hidden="true">🚚');
  expect(html).toContain('name="area"');
  expect(html).not.toContain("{{slot:");
  expect(html).not.toContain("javascript:");
});

it("uses validated responsive placement without permitting arbitrary CSS", () => {
  const html = render({
    column_widths: { mobile: "1fr 1fr", tablet: "1fr 180px" },
    button_column: "2",
    fields: [
      {
        name: "address",
        label: "Address",
        column: { mobile: "full", desktop: "1" },
        row: "1",
      },
    ],
  });
  expect(html).toContain("grid-column:1 / -1");
  expect(html).toContain("grid-template-columns:minmax(0,1fr) 180px");
  expect(html).toContain("@media(min-width:640px)");
  const unsafe = render({
    column_widths: "1fr;}body{display:none",
    fields: [{ name: "area", column: "1;}body{display:none" }],
  });
  expect(unsafe).not.toContain("body{display:none");
});

it("preserves native number limits and optional accessible-only labels", () => {
  const html = render({
    show_labels: false,
    fields: [
      {
        name: "area",
        label: "Area",
        kind: "number",
        min: 1,
        max: 999,
        step: 0.5,
      },
    ],
  });
  expect(html).toContain('min="1" max="999" step="0.5"');
  expect(html).toContain('data-show-labels="false"');
  expect(html).toContain('<label for="nav-start-area">Area</label>');
});

it("keeps the mobile mapped headline baseline and wider override", () => {
  const html = renderBlocks(
    [
      {
        id: "tabs",
        type: "core/tabs",
        data: {
          headline: "Get prices",
          headline_full_width: { mobile: true, laptop: false },
          labels: [{ label: "Link", href: "/quote/" }],
        },
      },
    ],
    { registry },
  );
  expect(html).toContain('data-headline-full="true"');
  expect(html).toContain("--headline-basis:auto;");
});
