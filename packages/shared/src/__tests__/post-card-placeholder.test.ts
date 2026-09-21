import { describe, expect, it } from "vitest";
import { buildCoreBlockRegistry, renderBlock, type Block } from "../index.js";
const registry = buildCoreBlockRegistry();
const settings = {
  missing_image: "placeholder",
  placeholder_icon: "🚚",
  placeholder_background: "#00aaaa",
  image_sizing: "fixed",
  image_height_px: 160,
};
describe("post-card missing-image presentation", () => {
  for (const surface of ["standalone", "page_list", "repeater"])
    for (const image of [undefined, null, "", "   "])
      it(`${surface} renders the configured placeholder for ${JSON.stringify(image)}`, () => {
        const item = {
          title: "Moving guide",
          url: "/guide/",
          href: "/guide/",
          image,
        };
        const block: Block =
          surface === "standalone"
            ? {
                id: "card",
                type: "core/post_card",
                data: { ...item, ...settings },
              }
            : {
                id: "cards",
                type:
                  surface === "page_list" ? "core/page_list" : "core/repeater",
                data: {
                  content_type: "article",
                  source_type: "static",
                  item_block: "core/post_card",
                  items: [item],
                  item_overrides: settings,
                },
              };
        const html = renderBlock(block, { registry, pageSource: () => [item] });
        expect(html).toContain("block-postcard-placeholder");
        expect(html).not.toContain("<img");
        expect(html).toMatch(
          /<a[^>]+aria-label="Moving guide"[^>]*><div[^>]+aria-hidden="true"/,
        );
        expect(html).toContain("🚚");
        expect(html).toContain("--placeholder-bg:#00aaaa");
      });
  it("keeps the default omission, explicit image hiding and real image unchanged", () => {
    const render = (data: Record<string, unknown>) =>
      renderBlock(
        {
          id: "card",
          type: "core/post_card",
          data: { title: "Guide", href: "/guide/", ...data },
        },
        { registry },
      );
    expect(render({})).not.toContain("block-postcard-media");
    expect(render({ ...settings, show_image: false })).not.toContain(
      "block-postcard-media",
    );
    const real = render({
      ...settings,
      image: "/real.jpg",
      image_alt: "Packing boxes",
      image_fit: "cover",
    });
    expect(real).toContain('src="/real.jpg" alt="Packing boxes"');
    expect(real).not.toContain("block-postcard-placeholder");
    const whole = render({ ...settings, whole_card_link: true });
    expect(whole.match(/<a\b/g)).toHaveLength(1);
    expect(
      render({ ...settings, placeholder_background: "red;display:none" }),
    ).not.toContain("red;display:none");
  });
});
