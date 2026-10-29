import { Window } from "happy-dom";
import { expect, it, vi } from "vitest";
import { buildCoreBlockRegistry } from "../index.js";
import { renderFormHtml } from "../render-form.js";
import { FORMS_RUNTIME_JS } from "../forms-runtime.js";
import type { Form } from "../types.js";
const form: Form = {
  id: "signup",
  name: "Signup",
  created_at: "x",
  actions: [],
  option_sources: [
    {
      field: "date",
      type: "extension:app:choices",
      config: {},
      notice_field: "notice",
    },
  ],
  steps: [
    {
      id: "first",
      blocks: [
        {
          id: "date",
          type: "form/radio_group",
          data: {
            name: "date",
            label: "Date",
            required: true,
            choices: [{ value: "old", label: "Old label" }],
          },
        },
        {
          id: "notice",
          type: "form/hidden",
          data: { name: "notice", value: "old-notice" },
        },
      ],
    },
  ],
};
async function mount(preview = false, emptyChoices = false) {
  const window = new Window({ url: "https://site.example.test/register" });
  window.document.body.innerHTML = renderFormHtml(
    emptyChoices
      ? {
          ...form,
          steps: [
            {
              ...form.steps![0],
              blocks: form.steps![0]!.blocks!.map((b) =>
                b.id === "date"
                  ? { ...b, data: { ...b.data, choices: [] } }
                  : b,
              ),
            },
          ],
        }
      : form,
    {
      submit_url: "https://cms.example.test/api/forms/submit",
      submit_token: "signed",
      preview,
    },
    { registry: buildCoreBlockRegistry() },
  );
  const calls: Array<{ url: string; data?: FormData }> = [];
  let submitCount = 0;
  window.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, data: init.body as FormData });
    return new Response(
      JSON.stringify(
        url.endsWith("/options")
          ? {
              options: {
                date: {
                  required: true,
                  options: [
                    { value: "new", label: "New date" },
                    { value: "interest", label: "Future invitations" },
                  ],
                  notice: {
                    field: "notice",
                    version: "v2",
                    text: "Registration includes future invitations, not newsletters.",
                  },
                },
              },
            }
          : ++submitCount === 1
            ? {
                ok: false,
                retry: "saved-retry",
                errors: [{ field: null, message: "Retry saved submission" }],
              }
            : {
                ok: true,
                done: true,
                form_id: "signup",
                results: [
                  {
                    type: "extension:app:register",
                    result: { interest_only: true },
                  },
                ],
              },
      ),
    );
  }) as never;
  window.eval(FORMS_RUNTIME_JS);
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  await new Promise((r) => setTimeout(r, 20));
  return { window, calls };
}
it("replaces stale choice labels with stable IDs and displays the notice actually submitted", async () => {
  const { window, calls } = await mount();
  const document = window.document;
  expect(calls).toHaveLength(1);
  expect(
    [...document.querySelectorAll("input[type=radio]")].map(
      (e) =>
        e.getAttribute("value") ?? (e as unknown as { value: string }).value,
    ),
  ).toEqual(["new", "interest"]);
  expect(
    (document.querySelector("[name=notice]") as unknown as { value: string })
      .value,
  ).toBe("v2");
  expect(document.body.textContent).toContain("not newsletters");
  await window.happyDOM.close();
});
it("emits success only after a completed retry and never includes submitted personal fields", async () => {
  const { window, calls } = await mount();
  const events: unknown[] = [];
  window.document.addEventListener("typeroll:form-success", (e) =>
    events.push((e as unknown as { detail: unknown }).detail),
  );
  const el = window.document.querySelector("form")!;
  el.dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true }),
  );
  await new Promise((r) => setTimeout(r, 20));
  expect(events).toEqual([]);
  el.dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true }),
  );
  await new Promise((r) => setTimeout(r, 20));
  expect(calls.at(-1)?.data?.get("_retry")).toBe("saved-retry");
  expect(events).toEqual([
    {
      form_id: "signup",
      results: [
        { type: "extension:app:register", result: { interest_only: true } },
      ],
    },
  ]);
  await window.happyDOM.close();
});
it("makes no live option request and emits no real success event in preview", async () => {
  const { window, calls } = await mount(true);
  const listener = vi.fn();
  window.document.addEventListener("typeroll:form-success", listener);
  window.document
    .querySelector("form")!
    .dispatchEvent(new window.Event("submit", { cancelable: true }));
  expect(calls).toEqual([]);
  expect(listener).not.toHaveBeenCalled();
  await window.happyDOM.close();
});

it("populates an initially empty radio group and preserves required validation and choice styling", async () => {
  const { window } = await mount(false, true);
  const choices = [
    ...window.document.querySelectorAll(".form-choice input[type=radio]"),
  ];
  expect(choices).toHaveLength(2);
  expect(
    choices.every((input) => (input as unknown as HTMLInputElement).required),
  ).toBe(true);
  expect(window.document.querySelector("legend")?.textContent).toBe("Date");
  await window.happyDOM.close();
});
