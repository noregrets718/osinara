/** Root owner recovery with durable receipts, real PostgreSQL leases and a read-only fake Google transport. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ToolContext } from "eve/tools";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, database } from "../database.js";
import { requirePrivateTelegramOwner, type PrivateTelegramOwner } from "../family-context.js";
import { createDutyReviewApproval } from "./duty-review-approval.js";
import { createDutyReviewDialog } from "./duty-review-dialog.js";
import { dutyReviewPreviews } from "./duty-review-previews.js";
import { DUTY_SHEET_WRITE_TOOL, prepareDutySheetChange } from "./duty-sheet-change.js";
import { createDutySheetSource } from "./duty-sheet-format.js";
import { createDutySheetReader } from "./duty-sheet-reader.js";
import { createDutySheetReviewer, DUTY_SHEET_REVIEW_TOOL } from "./duty-sheet-review.js";
import { dutySheetWriteLog as log } from "./duty-sheet-write-log.js";
import { withDutySheetWorker } from "./duty-sheet-worker.js";
import { createDutySheetWriter } from "./duty-sheet-writer.js";
import { withDutyOwner } from "./duty-storage.js";
import { createDutyFixture, recordDutyApproval, requireDutyTestDatabase, type DutyFixture } from "./duty-storage.integration-fixtures.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled) requireDutyTestDatabase();
const fixtures: DutyFixture[] = [];
function context(auth: PrivateTelegramOwner, receipt?: Awaited<ReturnType<typeof recordDutyApproval>>): ToolContext {
  return { callId: receipt?.toolCallId ?? randomUUID(), abortSignal: new AbortController().signal,
    session: { id: receipt?.eveSessionId ?? randomUUID(), turn: { id: randomUUID(), sequence: 1 }, auth: { initiator: null, current: {
      principalId: auth.userId, principalType: "user", authenticator: "telegram", attributes: {
        familyId: auth.familyId, role: auth.role, telegramChatId: auth.telegramChatId, telegramChatType: "private", telegramUserId: auth.telegramChatId,
        telegramActorKind: "telegram_user", telegramActorId: auth.telegramChatId, applicationSessionId: receipt?.applicationSessionId ?? randomUUID(),
      },
    } } },
  } as unknown as ToolContext;
}
async function setup(state: "fresh" | "checking" | "writing" | "unknown" = "unknown", matches = false) {
  const f = await createDutyFixture(); fixtures.push(f);
  const remote = JSON.parse(readFileSync(new URL("../../../examples/duty-scheduling/sheets-example.json", import.meta.url), "utf8"));
  remote.spreadsheetId = `sheet-${randomUUID()}`;
  remote.valueRanges[0].values[0].push("Телефон"); remote.valueRanges[0].values[1].push("private-review-phone");
  const source = createDutySheetSource(remote.spreadsheetId, randomUUID());
  const { input, plan } = prepareDutySheetChange(source, remote, [{ action: "upsert", section: "residents", key: "r01", values: { lastName: "Новая" } }]);
  const receipt = await recordDutyApproval(f, input, DUTY_SHEET_WRITE_TOOL);
  if (state !== "fresh") await log.claim(f.auth, input, input, receipt);
  if (state === "writing" || state === "unknown") await log.start(f.auth, input, input, receipt, plan);
  if (state === "unknown") await log.finish(input.operationId, "unknown", "TEST_TIMEOUT");
  if (matches) remote.valueRanges[0].values[1][2] = "Новая";
  const activeProfile = { value: source.profileRef };
  const transport = vi.fn().mockImplementation(async () => ({ kind: "read", scope: "personal", profileRef: activeProfile.value, completed: true, stdout: JSON.stringify(remote), stderr: "" }));
  const read = vi.fn(createDutySheetReader({ requireOwner: requirePrivateTelegramOwner, withOwner: withDutyOwner, execute: transport }));
  const reviewer = createDutySheetReviewer({ owner: requirePrivateTelegramOwner, read, log });
  const dialog = createDutyReviewDialog({ reviewer, previews: dutyReviewPreviews, log });
  const execute = vi.fn(async () => { remote.valueRanges[0].values[1][2] = "Новая"; throw new Error("Timeout after sending"); });
  const writer = createDutySheetWriter({ owner: requirePrivateTelegramOwner, read, execute, log, withOwner: withDutyOwner });
  const ctx = context(f.auth);
  const inspect = async (profileRef?: string) => {
    const result = await dialog.inspect({ action: "inspect", operationId: input.operationId, ...(profileRef ? { profileRef } : {}) }, ctx);
    if (!("confirmationInput" in result) || !result.confirmationInput) throw new Error("Expected review preview");
    return result;
  };
  const approved = async (request: unknown, toolName = DUTY_SHEET_REVIEW_TOOL) => context(f.auth, await recordDutyApproval(f, request, toolName));
  return { ...f, family: f, input, plan, receipt, remote, read, transport, activeProfile, reviewer, dialog, execute, writer, ctx, inspect, approved };
}
(enabled ? describe : describe.skip)("owner review dialog", () => {
  afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); }); afterAll(closeDatabase);
  it("lists only this family's pending writes and leaves a read-only observation blocked", async () => {
    const f = await setup(); const other = await setup();
    expect(await f.dialog.inspect({ action: "list" }, f.ctx)).toMatchObject({ operations: [{ operationId: f.input.operationId }], nextOffset: null });
    expect(JSON.stringify(await f.dialog.inspect({ action: "list" }, f.ctx))).not.toContain(other.input.operationId);
    const view = await f.inspect();
    expect(view).toMatchObject({ classification: "differs_from_expected", completed: false, resolved: false, sheetWritten: false });
    expect(view.cells).toEqual(f.plan.cells.map((cell) => ({ ...cell, current: cell.before })));
    expect(view.previewText).toContain("планировалось"); expect(view.previewText).toContain("сейчас");
    expect((await log.get(f.auth, f.input.operationId)).state).toBe("unknown");
    expect(JSON.stringify(view)).not.toContain("private-review-phone");
    const saved = await dutyReviewPreviews.get(f.auth, view.previewId);
    expect(saved.view).not.toHaveProperty("observation"); expect(saved.view).not.toHaveProperty("data");
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("closes a real uncertain write with a separate exact receipt and never resends it", async () => {
    const f = await setup("fresh");
    expect(await f.writer(f.input, f.receipt, context(f.auth, f.receipt))).toMatchObject({ state: "unknown" });
    const view = await f.inspect(); expect(view.classification).toBe("matches_expected");
    expect(view.cells[0].current).toBe("Новая");
    const subject = await createDutyReviewApproval({ previews: dutyReviewPreviews, log })(view.confirmationInput, f.ctx);
    expect(subject.prompt).toContain("не доказывает успешность"); expect(subject.prompt).toContain("неопределённым исходом");
    expect(subject.approveLabel).toContain("Принять состояние");
    const ctx = await f.approved(view.confirmationInput);
    const result = await f.dialog.resolve(view.confirmationInput, ctx);
    expect(result).toMatchObject({ state: "reviewed", completed: false, resolved: true, sheetWritten: false });
    await closeDatabase(); f.read.mockRejectedValue(new Error("Google offline"));
    expect(await f.dialog.resolve(view.confirmationInput, ctx)).toEqual(result);
    expect((await f.writer(f.input, f.receipt, context(f.auth, f.receipt))).state).toBe("reviewed");
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(await f.dialog.inspect({ action: "list" }, f.ctx)).toMatchObject({ operations: [] });
    const next = { ...f.input, operationId: randomUUID() };
    expect((await log.claim(f.auth, next, next, await recordDutyApproval(f.family, next, DUTY_SHEET_WRITE_TOOL))).claimed).toBe(true);
  });
  it("cancels an unstarted orphan without Google and fences its old worker", async () => {
    const f = await setup("checking"); const view = await f.inspect();
    expect(view).toMatchObject({ classification: "not_sent", cells: [] });
    const subject = await createDutyReviewApproval({ previews: dutyReviewPreviews, log })(view.confirmationInput, f.ctx);
    expect(subject.approveLabel).toContain("неотправленную");
    await f.dialog.resolve(view.confirmationInput, await f.approved(view.confirmationInput));
    await expect(log.start(f.auth, f.input, f.input, f.receipt, f.plan)).rejects.toThrow(/STATE_INVALID/u);
    expect(f.read).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  });
  it("requires the separate receipt and forbids using it for a different preview or decision", async () => {
    const f = await setup(); const first = await f.inspect(); const second = await f.inspect();
    await expect(f.dialog.resolve(first.confirmationInput, f.ctx)).rejects.toThrow(/APPROVAL_EVIDENCE_INVALID/u);
    await expect(f.dialog.resolve(first.confirmationInput, await f.approved(first.confirmationInput, DUTY_SHEET_WRITE_TOOL))).rejects.toThrow(/APPROVAL_EVIDENCE_INVALID/u);
    await expect(f.dialog.resolve(second.confirmationInput, await f.approved(first.confirmationInput))).rejects.toThrow(/APPROVAL_EVIDENCE_INVALID/u);
    const saved = await dutyReviewPreviews.get(f.auth, first.previewId);
    const receipt = await recordDutyApproval(f.family, first.confirmationInput, DUTY_SHEET_REVIEW_TOOL);
    await expect(f.reviewer.resolve({ ...saved.input, decision: "cancel_unstarted", previewId: saved.id }, receipt, context(f.auth, receipt))).rejects.toThrow(/REVIEW_PREVIEW_INVALID/u);
    expect(f.read).toHaveBeenCalledTimes(2); expect(f.execute).not.toHaveBeenCalled();
  });
  it("pages pending operations without exposing other families", async () => {
    const f = await setup("checking");
    for (let n = 0; n < 50; n++) {
      const source = { ...f.input.source, spreadsheetId: `page-${n}-${randomUUID()}` };
      const { input } = prepareDutySheetChange(source, { ...f.remote, spreadsheetId: source.spreadsheetId }, f.input.edits);
      await log.claim(f.auth, input, input, await recordDutyApproval(f.family, input, DUTY_SHEET_WRITE_TOOL));
    }
    const first = await f.dialog.inspect({ action: "list" }, f.ctx);
    expect(first).toMatchObject({ nextOffset: 50 });
    if (!("operations" in first)) throw new Error("Expected operation page");
    expect(first.operations).toHaveLength(50);
    const second = await f.dialog.inspect({ action: "list", offset: 50 }, f.ctx);
    expect(second).toMatchObject({ nextOffset: null });
    if (!("operations" in second)) throw new Error("Expected operation page");
    expect(second.operations).toHaveLength(1);
    expect(f.read).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  });
  it("leaves a failed Google observation blocked without creating a decision", async () => {
    const f = await setup(); const view = await f.inspect(); const ctx = await f.approved(view.confirmationInput);
    f.transport.mockRejectedValue(new Error("Google unavailable"));
    await expect(f.dialog.resolve(view.confirmationInput, ctx)).rejects.toThrow(/Google unavailable/u);
    expect((await log.get(f.auth, f.input.operationId)).state).toBe("unknown");
    expect((await database().query("SELECT 1 FROM duty_sheet_reviews WHERE operation_id=$1", [f.input.operationId])).rowCount).toBe(0);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("requires a fresh read and confirmation if the table changed", async () => {
    const f = await setup(); const view = await f.inspect();
    f.remote.valueRanges[0].values[1][2] = "Изменено вручную";
    await expect(f.dialog.resolve(view.confirmationInput, await f.approved(view.confirmationInput))).rejects.toThrow(/REVIEW_STALE/u);
    expect((await log.get(f.auth, f.input.operationId)).state).toBe("unknown");
    const fresh = await f.inspect(); expect(fresh.cells[0].current).toBe("Изменено вручную");
    await expect(f.dialog.resolve(fresh.confirmationInput, await f.approved(fresh.confirmationInput))).resolves.toMatchObject({ state: "reviewed" });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("refuses inspection and resolution while a real operation lease is held", async () => {
    const f = await setup(); const view = await f.inspect(); const ctx = await f.approved(view.confirmationInput);
    f.read.mockClear();
    await withDutySheetWorker(f.input.operationId, async () => {
      await expect(f.inspect()).rejects.toThrow(/WORKER_ACTIVE/u);
      await expect(f.dialog.resolve(view.confirmationInput, ctx)).rejects.toThrow(/WORKER_ACTIVE/u);
    });
    expect(f.read).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  });
  it("supports an explicitly selected new profile and rejects another switch after preview", async () => {
    const f = await setup(); f.activeProfile.value = randomUUID();
    await expect(f.inspect()).rejects.toThrow(/SHEET_READ_INVALID/u);
    const view = await f.inspect(f.activeProfile.value);
    expect(view.profileRef).toBe(f.activeProfile.value);
    const subject = await createDutyReviewApproval({ previews: dutyReviewPreviews, log })(view.confirmationInput, f.ctx);
    expect(subject.prompt).toContain(f.input.source.profileRef); expect(subject.prompt).toContain(f.activeProfile.value);
    const ctx = await f.approved(view.confirmationInput); f.activeProfile.value = randomUUID();
    await expect(f.dialog.resolve(view.confirmationInput, ctx)).rejects.toThrow(/SHEET_READ_INVALID/u);
    expect((await log.get(f.auth, f.input.operationId)).state).toBe("unknown");
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("reviews the original source after the group's registration is removed", async () => {
    const f = await setup();
    // The write's exact source remains in the journal, independently of the current registry.
    await database().query("DELETE FROM telegram_groups WHERE family_id=$1", [f.auth.familyId]);
    const view = await f.inspect(); expect(view.spreadsheetId).toBe(f.input.source.spreadsheetId);
    await expect(f.dialog.resolve(view.confirmationInput, await f.approved(view.confirmationInput))).resolves.toMatchObject({ state: "reviewed" });
  });
  it("rejects stale operation state and an already closed attempt", async () => {
    const f = await setup("checking"); const view = await f.inspect();
    await log.start(f.auth, f.input, f.input, f.receipt, f.plan);
    await expect(createDutyReviewApproval({ previews: dutyReviewPreviews, log })(view.confirmationInput, f.ctx)).rejects.toThrow(/REVIEW_STALE/u);
    await expect(f.dialog.resolve(view.confirmationInput, await f.approved(view.confirmationInput))).rejects.toThrow(/REVIEW_STALE/u);
    const next = await f.inspect(); await f.dialog.resolve(next.confirmationInput, await f.approved(next.confirmationInput));
    await expect(f.inspect()).rejects.toThrow(/REVIEW_NOT_NEEDED/u);
  });
  it("keeps review previews immutable and refuses modified observations", async () => {
    const f = await setup(); const view = await f.inspect();
    await expect(database().query("UPDATE duty_sheet_review_previews SET view='{}'::jsonb WHERE id=$1", [view.previewId])).rejects.toThrow(/REVIEW_PREVIEW_IMMUTABLE/u);
    await expect(database().query("DELETE FROM duty_sheet_review_previews WHERE id=$1", [view.previewId])).rejects.toThrow(/REVIEW_PREVIEW_IMMUTABLE/u);
    const snapshot = await f.reviewer.inspect(f.input.operationId, f.ctx); snapshot.observedCells[0].current = "Подмена";
    await expect(dutyReviewPreviews.save(f.auth, snapshot)).rejects.toThrow(/REVIEW_PREVIEW_INVALID/u);
  });
  it("rejects foreign operations/previews and a role revoked after viewing", async () => {
    const f = await setup(); const other = await setup(); const view = await f.inspect();
    await expect(other.dialog.inspect({ action: "inspect", operationId: f.input.operationId }, other.ctx)).rejects.toThrow(/OPERATION_NOT_FOUND/u);
    await expect(other.dialog.resolve(view.confirmationInput, other.ctx)).rejects.toThrow(/REVIEW_PREVIEW_NOT_FOUND/u);
    const ctx = await f.approved(view.confirmationInput);
    await database().query("UPDATE family_memberships SET role='member' WHERE family_id=$1 AND user_id=$2", [f.auth.familyId, f.auth.userId]);
    await expect(f.dialog.resolve(view.confirmationInput, ctx)).rejects.toThrow(/OWNER_REQUIRED/u); expect(f.execute).not.toHaveBeenCalled();
  });
  it.each(["member", "group", "scheduled", "child"])("rejects %s context before Google", async (mode) => {
    const f = await setup(); const view = await f.inspect(); const base = context(mode === "member" ? f.member : f.auth); const caller = base.session.auth.current!;
    const ctx = { ...base, session: { ...base.session, ...(mode === "child" ? { parent: { callId: "p", sessionId: "p", rootSessionId: "p", turn: { id: "p", sequence: 1 } } } : {}),
      auth: { ...base.session.auth, current: { ...caller, attributes: { ...caller.attributes, ...(mode === "group" ? { telegramChatType: "supergroup" } : {}), ...(mode === "scheduled" ? { scheduledRunId: randomUUID() } : {}) } } } } };
    await expect(f.dialog.inspect({ action: "list" }, ctx)).rejects.toThrow(/OWNER_REQUIRED|PRIVATE_CHAT_REQUIRED|INTERACTIVE_OWNER_REQUIRED/u);
    await expect(f.dialog.resolve(view.confirmationInput, ctx)).rejects.toThrow(/OWNER_REQUIRED|PRIVATE_CHAT_REQUIRED|INTERACTIVE_OWNER_REQUIRED/u);
    expect(f.read).toHaveBeenCalledTimes(1); expect(f.execute).not.toHaveBeenCalled();
  });
});
