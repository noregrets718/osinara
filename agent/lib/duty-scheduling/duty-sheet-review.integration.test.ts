/** Recovery never writes Google and cannot run over an active worker; resolutions remain explicit owner decisions. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ToolContext } from "eve/tools";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../app-error.js";
import { closeDatabase, database } from "../database.js";
import { DUTY_SHEET_WRITE_TOOL, prepareDutySheetChange } from "./duty-sheet-change.js";
import { createDutySheetSource } from "./duty-sheet-format.js";
import { previewDutySheetImport } from "./duty-sheet-import.js";
import { createDutySheetReviewer, DUTY_SHEET_REVIEW_TOOL, type DutySheetReviewInput, type DutySheetReviewSnapshot } from "./duty-sheet-review.js";
import { createDutySheetWriter } from "./duty-sheet-writer.js";
import { dutySheetWriteLog as log } from "./duty-sheet-write-log.js";
import { dutySheetWorkerContext, withDutySheetWorker } from "./duty-sheet-worker.js";
import { withDutyOwner } from "./duty-storage.js";
import { createDutyFixture, recordDutyApproval, requireDutyTestDatabase, type DutyFixture } from "./duty-storage.integration-fixtures.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled) requireDutyTestDatabase();
const fixtures: DutyFixture[] = [];
async function setup(state: "fresh" | "checking" | "writing" | "unknown" = "unknown", observedExpected = false) {
  const family = await createDutyFixture(); fixtures.push(family);
  const remote = JSON.parse(readFileSync(new URL("./fixtures/sheets-example.json", import.meta.url), "utf8"));
  remote.spreadsheetId = `sheet-${randomUUID()}`;
  const source = createDutySheetSource(remote.spreadsheetId, randomUUID());
  const { input, plan } = prepareDutySheetChange(source, remote, [{ action: "upsert", section: "residents", key: "r01", values: { lastName: "Новая" } }]);
  const approval = await recordDutyApproval(family, input, DUTY_SHEET_WRITE_TOOL);
  if (state !== "fresh") await log.claim(family.auth, input, input, approval);
  if (state === "writing" || state === "unknown") await log.start(family.auth, input, input, approval, plan);
  if (state === "unknown") await log.finish(input.operationId, "unknown", "TEST_TIMEOUT");
  if (observedExpected) remote.valueRanges[0].values[1][2] = "Новая";
  const ctx = { abortSignal: new AbortController().signal } as ToolContext;
  const read = vi.fn(async (selected: unknown) => ({ ...previewDutySheetImport(selected, remote), response: structuredClone(remote), owner: { familyId: family.auth.familyId, userId: family.auth.userId } }));
  const reviewer = createDutySheetReviewer({ owner: () => family.auth, read, log });
  const execute = vi.fn(async () => {
    remote.valueRanges[0].values[1][2] = "Новая";
    return { kind: "mutation" as const, scope: "personal" as const, profileRef: source.profileRef, completed: true as const, stdout: "{}", stderr: "" };
  });
  const writer = createDutySheetWriter({ owner: () => family.auth, read, execute, log, withOwner: withDutyOwner });
  return { family, remote, source, input, plan, approval, ctx, read, reviewer, execute, writer };
}
function decision(view: DutySheetReviewSnapshot, profileRef?: string): DutySheetReviewInput {
  return { operationId: view.operationId, reviewHash: view.reviewHash, profileRef,
    decision: view.state === "checking" ? "cancel_unstarted" : "accept_current",
    ...(view.state === "checking" ? {} : { acknowledgeUncertainOutcome: true as const }) };
}

(enabled ? describe : describe.skip)("duty sheet review", () => {
  afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
  afterAll(closeDatabase);

  it("inspects expected data without declaring success or releasing the write gate", async () => {
    const f = await setup("unknown", true);
    const review = await f.reviewer.inspect(f.input.operationId, f.ctx);
    expect(review).toMatchObject({ state: "unknown", classification: "matches_expected", plannedCells: f.plan.cells });
    expect((await log.get(f.family.auth, f.input.operationId)).state).toBe("unknown");
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.execute).not.toHaveBeenCalled();
    const next = { ...f.input, operationId: randomUUID() };
    await expect(log.claim(f.family.auth, next, next, await recordDutyApproval(f.family, next, DUTY_SHEET_WRITE_TOOL))).rejects.toThrow(/AGENT_DUTY_SHEET_BUSY/u);
  });

  it.each(["writing", "unknown"] as const)("records an explicit acceptance of %s, without replaying the old mutation", async (state) => {
    const f = await setup(state);
    const review = await f.reviewer.inspect(f.input.operationId, f.ctx);
    expect(review.classification).toBe("differs_from_expected");
    const input = decision(review);
    const receipt = await recordDutyApproval(f.family, input, DUTY_SHEET_REVIEW_TOOL);
    const saved = await f.reviewer.resolve(input, receipt, f.ctx);
    expect(saved).toMatchObject({ state: "reviewed", completed: false, review: { state, classification: "differs_from_expected" } });
    expect(await f.writer(f.input, f.approval, f.ctx)).toMatchObject({ state: "reviewed", completed: false });
    expect(f.execute).not.toHaveBeenCalled();
    const next = { ...f.input, operationId: randomUUID() };
    expect((await log.claim(f.family.auth, next, next, await recordDutyApproval(f.family, next, DUTY_SHEET_WRITE_TOOL))).claimed).toBe(true);
  });

  it("cancels an unstarted orphan without Google and fences an old worker's start", async () => {
    const f = await setup("checking");
    const review = await f.reviewer.inspect(f.input.operationId, f.ctx);
    expect(review).toMatchObject({ classification: "not_sent", observation: null });
    const input = decision(review);
    await f.reviewer.resolve(input, await recordDutyApproval(f.family, input, DUTY_SHEET_REVIEW_TOOL), f.ctx);
    expect(f.read).not.toHaveBeenCalled();
    await expect(log.start(f.family.auth, f.input, f.input, f.approval, f.plan)).rejects.toThrow(/AGENT_DUTY_SHEET_STATE_INVALID/u);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("rejects a stale read and leaves the operation blocked", async () => {
    const f = await setup();
    const input = decision(await f.reviewer.inspect(f.input.operationId, f.ctx));
    const receipt = await recordDutyApproval(f.family, input, DUTY_SHEET_REVIEW_TOOL);
    f.remote.valueRanges[0].values[1][2] = "РучнаяПравка";
    await expect(f.reviewer.resolve(input, receipt, f.ctx)).rejects.toThrow(/AGENT_DUTY_SHEET_REVIEW_STALE/u);
    expect((await log.get(f.family.auth, f.input.operationId)).state).toBe("unknown");
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("requires a separate exact confirmation before another Google read", async () => {
    const f = await setup();
    const input = decision(await f.reviewer.inspect(f.input.operationId, f.ctx));
    const receipt = await recordDutyApproval(f.family, input, DUTY_SHEET_WRITE_TOOL);
    f.read.mockClear();
    await expect(f.reviewer.resolve(input, receipt, f.ctx)).rejects.toThrow(/AGENT_TOOL_APPROVAL_EVIDENCE_INVALID/u);
    expect(f.read).not.toHaveBeenCalled();
  });

  it("requires an explicit uncertainty acknowledgement and the correct decision", async () => {
    const f = await setup();
    const input = decision(await f.reviewer.inspect(f.input.operationId, f.ctx));
    delete input.acknowledgeUncertainOutcome;
    await expect(f.reviewer.resolve(input, await recordDutyApproval(f.family, input, DUTY_SHEET_REVIEW_TOOL), f.ctx)).rejects.toThrow(/AGENT_DUTY_SHEET_REVIEW_DECISION_INVALID/u);
    input.decision = "cancel_unstarted";
    await expect(f.reviewer.resolve(input, await recordDutyApproval(f.family, input, DUTY_SHEET_REVIEW_TOOL), f.ctx)).rejects.toThrow(/AGENT_DUTY_SHEET_REVIEW_DECISION_INVALID/u);
  });

  it("supports a newly selected Google profile and binds its snapshot to confirmation", async () => {
    const f = await setup();
    const profile = randomUUID();
    const review = await f.reviewer.inspect(f.input.operationId, f.ctx, profile);
    expect(review.source.profileRef).toBe(profile);
    expect(f.read.mock.calls[0][0]).toMatchObject({ profileRef: profile, spreadsheetId: f.source.spreadsheetId });
    const input = decision(review, profile);
    expect(await f.reviewer.resolve(input, await recordDutyApproval(f.family, input, DUTY_SHEET_REVIEW_TOOL), f.ctx)).toMatchObject({ state: "reviewed" });
  });

  it("replays a saved decision after reconnect without rereading Google", async () => {
    const f = await setup();
    const input = decision(await f.reviewer.inspect(f.input.operationId, f.ctx));
    const receipt = await recordDutyApproval(f.family, input, DUTY_SHEET_REVIEW_TOOL);
    const saved = await f.reviewer.resolve(input, receipt, f.ctx);
    const reads = f.read.mock.calls.length;
    await closeDatabase();
    await database().query("UPDATE conversation_sessions SET retired_at = now() WHERE id = $1", [receipt.applicationSessionId]);
    expect(await f.reviewer.resolve(input, receipt, f.ctx)).toEqual(saved);
    expect(f.read).toHaveBeenCalledTimes(reads);
    await expect(f.reviewer.resolve({ ...input, reviewHash: "0".repeat(64) }, receipt, f.ctx)).rejects.toThrow(/AGENT_DUTY_SHEET_REVIEW_CONFLICT/u);
  });

  it("refuses inspection while the actual writer is awaiting Google", async () => {
    const f = await setup("fresh");
    let release = () => {};
    let entered = () => {};
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    f.execute.mockImplementationOnce(async () => {
      entered(); await pending; f.remote.valueRanges[0].values[1][2] = "Новая";
      return { kind: "mutation", scope: "personal", profileRef: f.source.profileRef, completed: true, stdout: "{}", stderr: "" };
    });
    const running = f.writer(f.input, f.approval, f.ctx);
    await started;
    try {
      await expect(f.reviewer.inspect(f.input.operationId, f.ctx)).rejects.toThrow(/AGENT_DUTY_SHEET_WORKER_ACTIVE/u);
      const input: DutySheetReviewInput = { operationId: f.input.operationId, reviewHash: "0".repeat(64), decision: "accept_current", acknowledgeUncertainOutcome: true };
      await expect(f.reviewer.resolve(input, await recordDutyApproval(f.family, input, DUTY_SHEET_REVIEW_TOOL), f.ctx)).rejects.toThrow(/AGENT_DUTY_SHEET_WORKER_ACTIVE/u);
      expect(f.read).toHaveBeenCalledTimes(1);
    } finally { release(); }
    expect(await running).toMatchObject({ state: "applied" });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("aborts before dispatch when worker ownership is lost", async () => {
    const f = await setup("fresh");
    const check = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new AppError("AGENT_DUTY_SHEET_WORKER_LOST", "Потеряна блокировка"));
    const writer = createDutySheetWriter({ owner: () => f.family.auth, read: f.read, execute: f.execute, log, withOwner: withDutyOwner,
      withWorker: async (_id, action) => action({ signal: new AbortController().signal, check }) });
    expect(await writer(f.input, f.approval, f.ctx)).toMatchObject({ state: "unknown" });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("does not expose another family's operation or a revoked owner's read", async () => {
    const f = await setup();
    const other = await createDutyFixture(); fixtures.push(other);
    const foreign = createDutySheetReviewer({ owner: () => other.auth, read: f.read, log });
    await expect(foreign.inspect(f.input.operationId, f.ctx)).rejects.toThrow(/AGENT_DUTY_SHEET_OPERATION_NOT_FOUND/u);
    await database().query("UPDATE family_memberships SET role = 'member' WHERE family_id = $1 AND user_id = $2", [f.family.auth.familyId, f.family.auth.userId]);
    await expect(f.reviewer.inspect(f.input.operationId, f.ctx)).rejects.toThrow(/AGENT_OWNER_REQUIRED/u);
    expect(f.read).not.toHaveBeenCalled();
  });

  it("preserves immutable review evidence and prevents forging a reviewed state without it", async () => {
    const f = await setup();
    await expect(database().query("UPDATE duty_sheet_writes SET state = 'reviewed' WHERE id = $1", [f.input.operationId])).rejects.toThrow(/AGENT_DUTY_SHEET_REVIEW_REQUIRED/u);
    const input = decision(await f.reviewer.inspect(f.input.operationId, f.ctx));
    await f.reviewer.resolve(input, await recordDutyApproval(f.family, input, DUTY_SHEET_REVIEW_TOOL), f.ctx);
    await expect(database().query("UPDATE duty_sheet_reviews SET snapshot = '{}'::jsonb WHERE operation_id = $1", [f.input.operationId])).rejects.toThrow(/AGENT_DUTY_SHEET_REVIEW_IMMUTABLE/u);
    await expect(database().query("DELETE FROM duty_sheet_reviews WHERE operation_id = $1", [f.input.operationId])).rejects.toThrow(/AGENT_DUTY_SHEET_REVIEW_IMMUTABLE/u);
    await expect(database().query("UPDATE duty_sheet_writes SET state = 'writing', finished_at = NULL WHERE id = $1", [f.input.operationId])).rejects.toThrow(/AGENT_DUTY_SHEET_STATE_INVALID/u);
  });

  it("releases the advisory lock after a failed inspection", async () => {
    const f = await setup();
    f.read.mockRejectedValueOnce(new Error("Google unavailable"));
    await expect(f.reviewer.inspect(f.input.operationId, f.ctx)).rejects.toThrow(/Google unavailable/u);
    await expect(withDutySheetWorker(f.input.operationId, async () => "released")).resolves.toBe("released");
  });

  it("propagates a real PostgreSQL worker disconnect to the operation's abort signal", async () => {
    const f = await setup();
    await withDutySheetWorker(f.input.operationId, async (worker) => {
      const scoped = dutySheetWorkerContext(f.ctx, worker);
      const connections = await database().query<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE application_name = 'duty-sheet-worker' AND datname = current_database() AND usename = current_user");
      expect(connections.rows).toHaveLength(1);
      const aborted = new Promise<void>((resolve) => worker.signal.addEventListener("abort", () => resolve(), { once: true }));
      await database().query("SELECT pg_terminate_backend($1)", [connections.rows[0].pid]);
      await aborted;
      expect(scoped.abortSignal.aborted).toBe(true);
      expect(f.ctx.abortSignal.aborted).toBe(false);
      await expect(worker.check()).rejects.toThrow(/AGENT_DUTY_SHEET_WORKER_LOST/u);
    });
  });
});
