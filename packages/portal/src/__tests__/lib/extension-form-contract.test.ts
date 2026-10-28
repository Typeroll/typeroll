import { beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type {
  ExtensionInstallation,
  ExtensionVersion,
  Form,
} from "@typeroll/shared";
import {
  formProviders,
  liveOptions,
  validateExtensionFormConfig,
} from "../../lib/extensions/form-contract";
import { extensionActions } from "../../lib/forms/extension-actions";
const state = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  resolve: vi.fn(),
  sign: vi.fn(),
  send: vi.fn(),
}));
vi.mock("../../lib/datastore", () => ({
  getStore: () => ({ listDocs: state.list, getDoc: state.get }),
}));
vi.mock("../../lib/extensions/resolution", () => ({
  resolveExtensionVersion: state.resolve,
}));
vi.mock("../../lib/extensions/auth", () => ({
  signInstallationAssertion: state.sign,
  extensionIssuer: () => "https://cms.example.test",
}));
vi.mock("../../lib/extensions/admin-request", () => ({
  adminDestination: (base: string, req: { path: string }) => base + req.path,
  requestApprovedAdmin: state.send,
}));
const installation = {
  id: "install",
  owner_org_id: "org",
  site_id: "site",
  developer_org_id: "vendor",
  extension_id: "com.example.forms",
  status: "enabled",
  granted_scopes: ["forms:actions"],
} as ExtensionInstallation;
const version = {
  version: "1.0.0",
  manifest: {
    api: { base_url: "https://provider.example/v1" },
    forms: {
      protocol: 1,
      path: "/forms",
      actions: [
        {
          id: "save",
          label: "Save",
          config_fields: [
            {
              key: "field_map",
              label: "Field mapping",
              type: "json",
              required: true,
            },
          ],
        },
      ],
      option_sources: [{ id: "choices", label: "Choices" }],
    },
  },
} as ExtensionVersion;
const form: Form = {
  id: "form",
  name: "Signup",
  created_at: "2026-10-28",
  steps: [
    {
      id: "step",
      blocks: [
        {
          id: "email",
          type: "form/email",
          data: { name: "email", label: "Email" },
        },
        {
          id: "choice",
          type: "form/radio_group",
          data: {
            name: "choice",
            label: "Choice",
            required: true,
            choices: [],
          },
        },
        {
          id: "notice",
          type: "form/hidden",
          data: { name: "notice", value: "" },
        },
      ],
    },
  ],
  actions: [
    {
      type: "extension:install:save",
      config: { field_map: { email: "email" } },
    },
  ],
  option_sources: [
    {
      field: "choice",
      type: "extension:install:choices",
      config: {},
      notice_field: "notice",
    },
  ],
};
beforeEach(() => {
  vi.resetAllMocks();
  state.list.mockResolvedValue([installation]);
  state.resolve.mockResolvedValue({ version });
  state.get.mockResolvedValue({
    status: "active",
    trusted_origins: ["https://provider.example"],
  });
  state.sign.mockReturnValue("synthetic-proof");
  state.send.mockResolvedValue({
    status: 200,
    data: {
      options: [{ value: "available", label: "Available" }],
      notice: { version: "v1", text: "Invitation notice" },
    },
  });
});
it("discovers only enabled same-Site installations with an approved provider and explicit grant", async () => {
  expect(await formProviders("org", "site")).toHaveLength(1);
  for (const patch of [
    { status: "disabled" },
    { site_id: "another" },
    { owner_org_id: "another" },
    { granted_scopes: [] },
  ]) {
    state.list.mockResolvedValue([{ ...installation, ...patch }]);
    expect(await formProviders("org", "site")).toEqual([]);
  }
  state.list.mockResolvedValue([installation]);
  state.get.mockResolvedValue({ status: "active", trusted_origins: [] });
  expect(await formProviders("org", "site")).toEqual([]);
});
it("validates declared input fields, hidden notice and operation configuration before saving", async () => {
  expect(await validateExtensionFormConfig("org", "site", form)).toBeNull();
  expect(
    await validateExtensionFormConfig("org", "site", {
      ...form,
      actions: [
        {
          type: "extension:install:save",
          config: { field_map: { email: "not-declared" } },
        },
      ],
    }),
  ).toMatch(/explicitly mapped/);
  expect(
    await validateExtensionFormConfig("org", "site", {
      ...form,
      option_sources: [{ ...form.option_sources![0]!, notice_field: "email" }],
    }),
  ).toMatch(/hidden/);
  expect(
    await validateExtensionFormConfig("org", "site", {
      ...form,
      actions: [
        {
          type: "extension:install:save",
          config: {
            field_map: { email: "email" },
            url: "https://unapproved.example",
          },
        },
      ],
    }),
  ).toMatch(/Unknown/);
});
it("forwards only mapped answers with a stable submission identity and proof of exact request bytes", async () => {
  state.send.mockResolvedValue({
    status: 200,
    data: { public_result: { interest_only: true } },
  });
  const [action] = await extensionActions("org", "site");
  await action!.run(form.actions![0]!, {
    orgId: "org",
    siteId: "site",
    formId: "form",
    form,
    data: { email: "synthetic@example.test", unmapped: "private" },
    subject: { kind: "submission", id: "submission" },
    submittedAt: "2026-10-28T12:00:00Z",
  });
  const request = state.send.mock.calls[0]![1];
  expect(request.body.data).toEqual({ email: "synthetic@example.test" });
  expect(request.body).toMatchObject({
    submission_id: "submission",
    submitted_at: "2026-10-28T12:00:00Z",
  });
  expect(state.sign).toHaveBeenCalledWith(
    expect.objectContaining({
      purpose: "form_action",
      scopes: ["forms:actions"],
      bodySha256: createHash("sha256")
        .update(JSON.stringify(request.body))
        .digest("hex"),
    }),
  );
});
it("rejects broken notices and duplicate choice IDs instead of serving stale defaults", async () => {
  const result = await liveOptions("org", "site", form);
  expect(result.choice).toMatchObject({
    required: true,
    notice: { field: "notice", version: "v1" },
  });
  state.send.mockResolvedValue({
    status: 200,
    data: { options: [{ value: "a", label: "A" }] },
  });
  await expect(liveOptions("org", "site", form)).rejects.toThrow(/notice/);
  state.send.mockResolvedValue({
    status: 200,
    data: {
      options: [
        { value: "a", label: "A" },
        { value: "a", label: "Again" },
      ],
    },
  });
  await expect(liveOptions("org", "site", form)).rejects.toThrow(/Duplicate/);
});
