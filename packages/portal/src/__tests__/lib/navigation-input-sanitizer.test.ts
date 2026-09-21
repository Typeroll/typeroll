import { it, expect } from "vitest";
import { buildCoreBlockRegistry, renderBlocks } from "@typeroll/shared";
import { sanitizeBody } from "../../lib/sanitize";
import { sanitizeBody as sanitizeStatic } from "../../../../site-template/src/lib/sanitize";
it("preserves the native navigation input contract in preview and static sanitization", () => {
  const html = renderBlocks(
    [
      {
        id: "start",
        type: "core/navigation_form",
        data: {
          destination: "/quote/",
          fields: [
            { name: "area", label: "Area", kind: "number", min: 1, step: 0.5 },
          ],
        },
      },
    ],
    { registry: buildCoreBlockRegistry() },
  );
  for (const clean of [sanitizeBody(html), sanitizeStatic(html)]) {
    expect(clean).toMatch(/data-navigation-continue[^>]*hidden/);
    expect(clean).toContain('step="0.5"');
    expect(clean).toContain('maxlength="512"');
    expect(clean).toContain('min="1"');
    expect(clean).toContain('for="nav-start-area"');
    expect(clean).not.toContain("<form");
  }
});
