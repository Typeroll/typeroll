import { collectStepFields } from "@typeroll/shared";
import {
  callFormProvider,
  extensionFormType,
  formProviders,
  validateContributionConfig,
} from "../extensions/form-contract";
import type { FormActionDef } from "./actions";

export async function extensionActions(
  orgId: string,
  siteId: string,
): Promise<FormActionDef[]> {
  const result: FormActionDef[] = [];
  for (const provider of await formProviders(orgId, siteId))
    for (const def of provider.version.manifest.forms!.actions) {
      result.push({
        type: extensionFormType(provider.installation.id, def.id),
        label: def.label,
        description: def.description,
        config_fields: def.config_fields,
        admin_only: true,
        required: true,
        async run(action, ctx) {
          const error = validateContributionConfig(def, action.config);
          if (error) throw new Error(error);
          const map = action.config.field_map;
          if (!map || typeof map !== "object" || Array.isArray(map))
            throw new Error("Configure the app action field mapping");
          const allowed = new Set(
            (ctx.form?.steps ?? [])
              .flatMap((s) => collectStepFields(s.blocks))
              .map((f) => f.name),
          );
          const data: Record<string, unknown> = {};
          for (const [target, source] of Object.entries(map)) {
            if (
              !/^[a-z][a-z0-9_]{0,63}$/.test(target) ||
              ["constructor", "prototype"].includes(target) ||
              typeof source !== "string" ||
              !allowed.has(source)
            )
              throw new Error(
                "App actions may only receive explicitly mapped form fields",
              );
            if (Object.hasOwn(ctx.data, source))
              data[target] = ctx.data[source];
          }
          if (!ctx.subject?.id || !ctx.formId || !ctx.submittedAt)
            throw new Error("The app action requires a saved submission");
          const response = await callFormProvider(provider, "form_action", {
            operation: def.id,
            config: action.config,
            form_id: ctx.formId,
            submission_id: ctx.subject.id,
            submitted_at: ctx.submittedAt,
            data,
          });
          const value = response.public_result;
          if (value === undefined) return;
          if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            JSON.stringify(value).length > 4000
          )
            throw new Error("The app returned an invalid completion result");
          return value as Record<string, unknown>;
        },
      });
    }
  return result;
}
