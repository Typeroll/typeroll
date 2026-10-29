import { paths, type Form } from "@typeroll/shared";
import { getStore } from "../datastore";
import { runFormActions, RequiredFormActionError } from "./actions";

export interface RequiredCompletion {
  state: "pending" | "running" | "failed" | "notifying" | "done";
  form: Pick<Form, "id" | "actions" | "steps">;
  results?: Array<{ type: string; result: Record<string, unknown> }>;
}
export const hasRequiredActions = (form: Pick<Form, "actions">) =>
  (form.actions ?? []).some((a) => a.type.startsWith("extension:"));
/** Store this snapshot atomically with final submission data. Retries cannot change its effect. */
export function pendingCompletion(form: Form): {
  required_completion?: RequiredCompletion;
} {
  return hasRequiredActions(form)
    ? {
        required_completion: {
          state: "pending",
          form: {
            id: form.id,
            actions: form.actions ?? [],
            steps: form.steps ?? [],
          },
        },
      }
    : {};
}
export async function completeRequiredActions(
  orgId: string,
  siteId: string,
  formId: string,
  submissionId: string,
) {
  const store = getStore(),
    path = `${paths.submissions(orgId, siteId)}/${submissionId}`;
  type Saved = {
    form_id: string;
    status: string;
    data: Record<string, unknown>;
    updated_at: string;
    required_completion: RequiredCompletion;
  };
  const saved = await store.getDoc<Saved>(path);
  if (
    !saved ||
    saved.form_id !== formId ||
    saved.status !== "complete" ||
    !saved.required_completion
  )
    throw new RequiredFormActionError("This submission cannot be resumed");
  const job = saved.required_completion;
  if (job.state === "done" || job.state === "notifying")
    return job.results ?? [];
  const claimed = await store.compareAndUpdateDoc<Saved>(
    path,
    (s) => ["pending", "failed"].includes(s.required_completion?.state),
    { required_completion: { ...job, state: "running" } },
  );
  if (!claimed)
    throw new RequiredFormActionError(
      "Your submission is being processed. Contact the organizer if it does not complete.",
    );
  const ctx = {
    orgId,
    siteId,
    formId,
    data: saved.data,
    submittedAt: saved.updated_at,
    subject: { kind: "submission" as const, id: submissionId },
  };
  let results: NonNullable<RequiredCompletion["results"]>;
  try {
    results = (
      await runFormActions(
        {
          ...job.form,
          actions: job.form.actions?.filter((a) =>
            a.type.startsWith("extension:"),
          ),
        },
        ctx,
      )
    ).results;
  } catch (error) {
    await store.updateDoc(path, {
      required_completion: { ...job, state: "failed" },
    });
    throw new RequiredFormActionError(
      error instanceof RequiredFormActionError
        ? error.message
        : "The connected app could not complete your submission. Try again; your answers are saved.",
    );
  }
  // This claim is never reclaimed on a timer. Unknown email delivery must not become duplicate mail.
  await store.updateDoc(path, {
    required_completion: { ...job, state: "notifying", results },
  });
  await runFormActions(
    {
      ...job.form,
      actions: job.form.actions?.filter(
        (a) => !a.type.startsWith("extension:"),
      ),
    },
    ctx,
  );
  await store.updateDoc(path, {
    required_completion: { ...job, state: "done", results },
  });
  return results;
}
