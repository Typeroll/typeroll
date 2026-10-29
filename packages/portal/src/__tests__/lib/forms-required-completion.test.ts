import { beforeEach, expect, it, vi } from "vitest";
import { paths, type Form } from "@typeroll/shared";
import { getStore } from "../../lib/datastore";
import { makeTmpFixtures, resetDatastore } from "../helpers/tmp-fixtures";
import {
  completeRequiredActions,
  pendingCompletion,
} from "../../lib/forms/required-completion";
import { submissionView } from "../../lib/form-submissions";
const run = vi.hoisted(() => vi.fn());
vi.mock("../../lib/forms/actions", async (original) => ({
  ...(await original<object>()),
  runFormActions: run,
}));
const path = `${paths.submissions("org", "site")}/submission`;
const form = {
  id: "form",
  steps: [],
  actions: [
    { type: "email", config: { secret: "hidden" } },
    { type: "extension:install:save", config: {} },
  ],
} as unknown as Form;
beforeEach(async () => {
  vi.resetAllMocks();
  makeTmpFixtures();
  await resetDatastore();
  await getStore().setDoc(path, {
    form_id: "form",
    status: "complete",
    data: { answer: "original" },
    updated_at: "2026-10-28T12:00:00Z",
    ...pendingCompletion(form),
  });
  run.mockResolvedValue({ ran: [], failed: [], results: [] });
});
it("resumes failed required effects with saved answers and runs optional mail only once", async () => {
  run.mockRejectedValueOnce(Error("unavailable"));
  await expect(
    completeRequiredActions("org", "site", "form", "submission"),
  ).rejects.toThrow("saved");
  expect(run).toHaveBeenCalledTimes(1);
  await completeRequiredActions("org", "site", "form", "submission");
  expect(
    run.mock.calls[1][0].actions.map((a: { type: string }) => a.type),
  ).toEqual(["extension:install:save"]);
  expect(run.mock.calls[1][1]).toMatchObject({
    data: { answer: "original" },
    submittedAt: "2026-10-28T12:00:00Z",
  });
  expect(
    run.mock.calls[2][0].actions.map((a: { type: string }) => a.type),
  ).toEqual(["email"]);
  await completeRequiredActions("org", "site", "form", "submission");
  expect(run).toHaveBeenCalledTimes(3);
});
it("does not reclaim a running operation on a clock or repeat uncertain optional delivery", async () => {
  await getStore().updateDoc(path, {
    required_completion: {
      ...pendingCompletion(form).required_completion,
      state: "running",
    },
  });
  await expect(
    completeRequiredActions("org", "site", "form", "submission"),
  ).rejects.toThrow("processed");
  expect(run).not.toHaveBeenCalled();
  await getStore().updateDoc(path, {
    required_completion: {
      ...pendingCompletion(form).required_completion,
      state: "notifying",
      results: [
        { type: "extension:install:save", result: { record_id: "safe" } },
      ],
    },
  });
  expect(
    await completeRequiredActions("org", "site", "form", "submission"),
  ).toHaveLength(1);
  expect(run).not.toHaveBeenCalled();
});
it("hides the frozen action configuration from submission reads and enforces form identity", async () => {
  const saved = await getStore().getDoc(path);
  expect(JSON.stringify(submissionView(saved as never, true))).not.toContain(
    "hidden",
  );
  await expect(
    completeRequiredActions("org", "site", "other", "submission"),
  ).rejects.toThrow("cannot be resumed");
});
