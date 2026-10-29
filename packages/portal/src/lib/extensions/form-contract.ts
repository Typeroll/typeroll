import { createHash, randomUUID } from "node:crypto";
import {
  paths,
  collectStepFields,
  type Extension,
  type ExtensionFormContribution,
  type ExtensionInstallation,
  type ExtensionVersion,
  type Form,
} from "@typeroll/shared";
import { getStore } from "../datastore";
import { resolveExtensionVersion } from "./resolution";
import { extensionIssuer, signInstallationAssertion } from "./auth";
import { adminDestination, requestApprovedAdmin } from "./admin-request";

export const extensionFormType = (installation: string, id: string) =>
  `extension:${installation}:${id}`;
export interface FormProvider {
  installation: ExtensionInstallation;
  version: ExtensionVersion;
}
export async function formProviders(
  orgId: string,
  siteId: string,
): Promise<FormProvider[]> {
  const store = getStore(),
    result: FormProvider[] = [];
  for (const installation of await store.listDocs<ExtensionInstallation>(
    paths.extensionInstallations(orgId, siteId),
  )) {
    if (
      installation.status !== "enabled" ||
      installation.owner_org_id !== orgId ||
      installation.site_id !== siteId ||
      !installation.granted_scopes.includes("forms:actions")
    )
      continue;
    const version = (await resolveExtensionVersion(installation)).version;
    if (!version?.manifest.forms || !version.manifest.api) continue;
    const extension = await store.getDoc<Extension>(
      paths.extension(installation.developer_org_id, installation.extension_id),
    );
    if (
      !extension ||
      extension.status !== "active" ||
      !extension.trusted_origins.includes(
        new URL(version.manifest.api.base_url).origin,
      )
    )
      continue;
    result.push({ installation, version });
  }
  return result;
}
export function validateContributionConfig(
  def: ExtensionFormContribution,
  value: unknown,
): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "Action configuration must be an object";
  const data = value as Record<string, unknown>,
    fields = def.config_fields ?? [];
  if (Object.keys(data).some((k) => !fields.some((f) => f.key === k)))
    return "Unknown app configuration field";
  for (const f of fields) {
    const v = data[f.key];
    if (v === undefined || v === "") {
      if (f.required) return `${f.label} is required`;
      continue;
    }
    if (
      f.type === "json"
        ? typeof v !== "object" || v === null || Array.isArray(v)
        : typeof v !== (f.type === "text" ? "string" : f.type)
    )
      return `${f.label} has an invalid type`;
    if (JSON.stringify(v).length > 8000) return `${f.label} is too large`;
  }
  return null;
}
/** Approved, purpose-bound server transport. No form value selects a URL or issuer. */
export async function callFormProvider(
  provider: FormProvider,
  purpose: "form_action" | "form_options",
  body: Record<string, unknown>,
) {
  const manifest = provider.version.manifest;
  const request = {
    page_id: "forms",
    method: "POST" as const,
    path: manifest.forms!.path,
    body,
  };
  const url = adminDestination(manifest.api!.base_url, request);
  const token = signInstallationAssertion({
    installation: provider.installation,
    scopes: ["forms:actions"],
    correlationId: randomUUID(),
    purpose,
    version: provider.version.version,
    bodySha256: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
  });
  const response = await requestApprovedAdmin(
    url,
    request,
    token,
    extensionIssuer(),
  );
  if (response.status < 200 || response.status >= 300) {
    const data = response.data as { error?: unknown };
    throw new Error(
      typeof data?.error === "string" && data.error.length <= 500
        ? data.error
        : "The connected app could not complete this operation",
    );
  }
  return response.data as Record<string, unknown>;
}
export async function validateExtensionFormConfig(
  orgId: string,
  siteId: string,
  form: Pick<Form, "actions" | "steps" | "option_sources" | "target">,
): Promise<string | null> {
  if (
    form.option_sources !== undefined &&
    (!Array.isArray(form.option_sources) || form.option_sources.length > 20)
  )
    return "option_sources must be an array of at most 20 entries";
  if (
    !form.option_sources?.length &&
    !(form.actions ?? []).some((a) => a.type.startsWith("extension:"))
  )
    return null;
  if (form.target) return "Live app actions belong to ordinary site forms";
  const providers = await formProviders(orgId, siteId);
  const fields = (form.steps ?? []).flatMap((s) => collectStepFields(s.blocks));
  for (const [kind, entries] of [
    ["actions", form.actions ?? []],
    ["option_sources", form.option_sources ?? []],
  ] as const) {
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || typeof entry.type !== "string")
        return "Invalid app form configuration";
      if (!entry.type.startsWith("extension:")) {
        if (kind === "option_sources")
          return "Choose an installed app option source";
        continue;
      }
      let found = false;
      for (const p of providers)
        for (const def of p.version.manifest.forms![kind] ?? []) {
          if (extensionFormType(p.installation.id, def.id) !== entry.type)
            continue;
          found = true;
          const error = validateContributionConfig(def, entry.config);
          if (error) return error;
          if (kind === "actions") {
            if (
              "trigger" in entry &&
              entry.trigger &&
              entry.trigger !== "complete"
            )
              return "App actions run only on completed submissions";
            const map = entry.config.field_map;
            if (
              !map ||
              typeof map !== "object" ||
              Array.isArray(map) ||
              Object.keys(map).length > 100
            )
              return "Configure an app action field_map";
            if (
              Object.entries(map).some(
                ([target, source]) =>
                  !/^[a-z][a-z0-9_]{0,63}$/.test(target) ||
                  ["constructor", "prototype"].includes(target) ||
                  typeof source !== "string" ||
                  !fields.some((f) => f.name === source),
              )
            )
              return "App actions may receive only explicitly mapped form fields";
          }
        }
      if (!found) return "The app action or option source is unavailable";
      if (kind === "option_sources") {
        const source = entry as NonNullable<Form["option_sources"]>[number];
        const field = fields.find((f) => f.name === source.field);
        if (!field || !["select", "radio"].includes(field.type))
          return "Live options require a declared select or radio field";
        if (
          source.notice_field &&
          !fields.some(
            (f) => f.name === source.notice_field && f.type === "hidden",
          )
        )
          return "Declare the notice version as a hidden form field";
      }
    }
  }
  if (
    new Set((form.option_sources ?? []).map((s) => s.field)).size !==
    (form.option_sources ?? []).length
  )
    return "Each field can have only one option source";
  return null;
}
export async function liveOptions(orgId: string, siteId: string, form: Form) {
  const providers = await formProviders(orgId, siteId),
    result: Record<
      string,
      {
        options: Array<{ value: string; label: string }>;
        required: boolean;
        notice?: { field: string; version: string; text: string };
      }
    > = {};
  for (const source of form.option_sources ?? []) {
    let found = false;
    for (const p of providers)
      for (const def of p.version.manifest.forms!.option_sources ?? []) {
        if (extensionFormType(p.installation.id, def.id) !== source.type)
          continue;
        found = true;
        const response = await callFormProvider(p, "form_options", {
          operation: def.id,
          config: source.config,
          form_id: form.id,
        });
        if (!Array.isArray(response.options) || response.options.length > 200)
          throw new Error("The app returned invalid options");
        const options = response.options.map((raw) => {
          const o = raw as { value: unknown; label: unknown };
          if (
            typeof o.value !== "string" ||
            typeof o.label !== "string" ||
            o.value.length > 128 ||
            o.label.length > 500
          )
            throw new Error("Invalid app option");
          return { value: o.value, label: o.label };
        });
        if (new Set(options.map((o) => o.value)).size !== options.length)
          throw new Error("Duplicate app option IDs");
        const notice = response.notice as
          { version?: unknown; text?: unknown } | undefined;
        if (
          source.notice_field &&
          (!notice ||
            typeof notice.version !== "string" ||
            !notice.version ||
            notice.version.length > 128 ||
            typeof notice.text !== "string" ||
            !notice.text.trim() ||
            notice.text.length > 4000)
        )
          throw new Error("The app returned an invalid registration notice");
        result[source.field] = {
          options,
          required: (form.steps ?? [])
            .flatMap((s) => collectStepFields(s.blocks))
            .some((f) => f.name === source.field && f.required),
          ...(source.notice_field &&
          typeof notice?.version === "string" &&
          typeof notice.text === "string" &&
          notice.version.length <= 128 &&
          notice.text.length <= 4000
            ? {
                notice: {
                  field: source.notice_field,
                  version: notice.version,
                  text: notice.text,
                },
              }
            : {}),
        };
      }
    if (!found) throw new Error("The connected form app is unavailable");
  }
  return result;
}
