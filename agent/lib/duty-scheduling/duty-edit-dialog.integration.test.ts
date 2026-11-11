/** Immutable edit tickets, exact private receipts and single-attempt writes on real test PostgreSQL. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ToolContext } from "eve/tools";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, database } from "../database.js";
import { requirePrivateTelegramOwner, type PrivateTelegramOwner } from "../family-context.js";
import { createDutyEditApproval } from "./duty-edit-approval.js";
import { createDutyEditDialog } from "./duty-edit-dialog.js";
import { dutyEditPreviews } from "./duty-edit-previews.js";
import { DUTY_SHEET_WRITE_TOOL, type DutySheetEdit } from "./duty-sheet-change.js";
import { dutyScheduleRepository } from "./duty-schedule-repository.js";
import { createDutySheetSource } from "./duty-sheet-format.js";
import { previewDutySheetImport } from "./duty-sheet-import.js";
import { createDutySheetReader } from "./duty-sheet-reader.js";
import { DUTY_SOURCE_TOOL, dutySheetSourceRepository as sources } from "./duty-sheet-source-repository.js";
import { dutySheetWriteLog } from "./duty-sheet-write-log.js";
import { createDutySheetWriter } from "./duty-sheet-writer.js";
import { withDutyOwner } from "./duty-storage.js";
import { createDutyFixture, recordDutyApproval, requireDutyTestDatabase, type DutyFixture } from "./duty-storage.integration-fixtures.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled) requireDutyTestDatabase();
const fixtures: DutyFixture[] = [];
function context(auth: PrivateTelegramOwner, evidence?: Awaited<ReturnType<typeof recordDutyApproval>>): ToolContext {
  return { callId: evidence?.toolCallId ?? randomUUID(), abortSignal: new AbortController().signal,
    session: { id: evidence?.eveSessionId ?? randomUUID(), turn: { id: randomUUID(), sequence: 1 }, auth: { initiator: null, current: {
      principalId: auth.userId, principalType: "user", authenticator: "telegram", attributes: {
        familyId: auth.familyId, role: auth.role, telegramChatId: auth.telegramChatId, telegramChatType: "private", telegramUserId: auth.telegramChatId,
        telegramActorKind: "telegram_user", telegramActorId: auth.telegramChatId, applicationSessionId: evidence?.applicationSessionId ?? randomUUID(),
      },
    } } },
  } as unknown as ToolContext;
}
async function setup() {
  const f = await createDutyFixture(); fixtures.push(f);
  const source = createDutySheetSource("duty-example-sheet", randomUUID());
  const configure = { operationId: randomUUID(), groupId: f.input.groupId, expectedVersion: 0, source };
  await sources.save(f.auth, configure, await recordDutyApproval(f, configure, DUTY_SOURCE_TOOL));
  const remote = JSON.parse(readFileSync(new URL("../../../examples/duty-scheduling/sheets-example.json", import.meta.url), "utf8"));
  remote.valueRanges[0].values[0].push("Телефон"); remote.valueRanges[0].values[1].push("private-test-phone");
  const transport = vi.fn().mockImplementation(async () => ({ kind: "read", scope: "personal", profileRef: source.profileRef, completed: true, stdout: JSON.stringify(remote), stderr: "" }));
  const read = vi.fn(createDutySheetReader({ requireOwner: requirePrivateTelegramOwner, withOwner: withDutyOwner, execute: transport }));
  const execute = vi.fn(async (command: { argv: string[] }) => {
    const payload = JSON.parse(command.argv[7]); expect(payload.valueInputOption).toBe("RAW");
    for (const cell of payload.data) {
      const match = /^'(.*)'!([A-Z])(\d+)$/u.exec(cell.range)!;
      const tab = remote.valueRanges.find((row: { range: string }) => row.range.startsWith(`'${match[1]}'!`));
      const row = Number(match[3]) - 1, column = match[2].charCodeAt(0) - 65;
      while (tab.values.length <= row) tab.values.push([]);
      while (tab.values[row].length <= column) tab.values[row].push("");
      tab.values[row][column] = cell.values[0][0];
    }
    return { kind: "mutation" as const, scope: "personal" as const, profileRef: source.profileRef, completed: true as const, stdout: "{}", stderr: "" };
  });
  const writer = createDutySheetWriter({ owner: requirePrivateTelegramOwner, read, execute, log: dutySheetWriteLog, withOwner: withDutyOwner });
  const dialog = createDutyEditDialog({ read, sources, previews: dutyEditPreviews, write: writer, log: dutySheetWriteLog });
  const ctx = context(f.auth);
  const edits: DutySheetEdit[] = [{ action: "upsert", section: "residents", key: "r01", values: { lastName: "НоваяФамилия" } }];
  const preview = async (changes = edits) => {
    const view = await dialog.inspect({ action: "preview", groupId: f.input.groupId, edits: changes }, ctx);
    if (!("confirmationInput" in view) || !view.confirmationInput) throw new Error("Expected edit preview");
    return view;
  };
  const approved = async (input: unknown, toolName = DUTY_SHEET_WRITE_TOOL) => context(f.auth, await recordDutyApproval(f, input, toolName));
  const nextSource = async () => {
    const current = await sources.get(f.auth, f.input.groupId);
    const input = { ...configure, operationId: randomUUID(), expectedVersion: current.version };
    return sources.save(f.auth, input, await recordDutyApproval(f, input, DUTY_SOURCE_TOOL));
  };
  return { ...f, source, remote, read, execute, writer, dialog, ctx, preview, approved, nextSource };
}
(enabled ? describe : describe.skip)("owner edit dialog", () => {
  afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); }); afterAll(closeDatabase);
  it("reads supported keyed fields only and persists a preview without Google writes", async () => {
    const f = await setup();
    const rows = await f.dialog.inspect({ action: "read", groupId: f.input.groupId, section: "residents", key: "r01" }, f.ctx);
    expect(rows).toMatchObject({ total: 1, rows: [{ key: "r01", values: { id: "r01" } }], nextOffset: null });
    expect(JSON.stringify(rows)).not.toContain("private-test-phone");
    const view = await f.preview();
    expect(view.previewText).toContain("НоваяФамилия"); expect(view.sheetWritten).toBe(false);
    expect(await dutyEditPreviews.get(f.auth, view.previewId)).toMatchObject({ input: { binding: { groupId: f.input.groupId, version: 1 } } });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("shows the saved exact values in the native prompt and writes once across reconnect", async () => {
    const f = await setup(); const view = await f.preview();
    const text = await createDutyEditApproval(dutyEditPreviews)(view.confirmationInput, f.ctx);
    expect(text).toContain(view.previewText); expect(text).toContain("Учебная группа");
    const ctx = await f.approved(view.confirmationInput);
    expect(await f.dialog.apply(view.confirmationInput, ctx)).toMatchObject({ state: "applied", completed: true });
    expect(f.remote.valueRanges[0].values[1][2]).toBe("НоваяФамилия");
    await closeDatabase(); f.read.mockRejectedValue(new Error("Google offline"));
    expect(await f.dialog.apply(view.confirmationInput, ctx)).toMatchObject({ state: "applied" });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(await f.dialog.inspect({ action: "status", operationId: view.operationId }, f.ctx)).toMatchObject({ state: "applied", retryAllowed: false });
  });
  it("pages supported rows without silently dropping residents", async () => {
    const f = await setup(); const rows = f.remote.valueRanges[0].values;
    for (let n = 0; n < 45; n++) { const row = structuredClone(rows[1]); row[0] = `extra-${n}`; rows.push(row); }
    const request = { action: "read", groupId: f.input.groupId, section: "residents" };
    const first = await f.dialog.inspect(request, f.ctx);
    expect(first).toMatchObject({ total: 55, nextOffset: 50 });
    if (!("rows" in first)) throw new Error("Expected rows");
    expect(first.rows).toHaveLength(50);
    const next = await f.dialog.inspect({ ...request, offset: 50 }, f.ctx);
    expect(next).toMatchObject({ total: 55, nextOffset: null });
    if (!("rows" in next)) throw new Error("Expected rows");
    expect(next.rows).toHaveLength(5);
  });
  it("changes rules only for new calculations and includes the generated rulesVersion in approval", async () => {
    const f = await setup(); const initial = previewDutySheetImport(f.source, f.remote);
    const old = await dutyScheduleRepository.save(f.auth, { ...f.input, data: initial.data, history: initial.history });
    const view = await f.preview([{ action: "upsert", section: "settings", key: "lookbackDays", values: { value: 14 } }]);
    expect(view.previewText).toContain("30 → 14"); expect(view.previewText).toContain(`rules-${view.previewId}`);
    await f.dialog.apply(view.confirmationInput, await f.approved(view.confirmationInput));
    const after = previewDutySheetImport(f.source, f.remote);
    const next = await dutyScheduleRepository.save(f.auth, { ...f.input, operationKey: randomUUID(), data: after.data, history: after.history });
    expect(next.snapshot.data.rules.lookbackDays).toBe(14);
    expect((await dutyScheduleRepository.get(f.auth, old.id)).contentHash).toBe(old.contentHash);
    expect((await dutyScheduleRepository.get(f.auth, old.id)).snapshot.data.rules.lookbackDays).toBe(30);
  });
  it("requires an exact receipt and rejects approval for a different preview or action", async () => {
    const f = await setup(); const first = await f.preview(); const second = await f.preview(); const ctx = await f.approved(first.confirmationInput);
    await expect(f.dialog.apply(first.confirmationInput, f.ctx)).rejects.toThrow(/APPROVAL_EVIDENCE_INVALID/u);
    await expect(f.dialog.apply(second.confirmationInput, ctx)).rejects.toThrow(/APPROVAL_EVIDENCE_INVALID/u);
    await expect(f.dialog.apply(first.confirmationInput, await f.approved(first.confirmationInput, DUTY_SOURCE_TOOL))).rejects.toThrow(/APPROVAL_EVIDENCE_INVALID/u);
    expect(f.execute).not.toHaveBeenCalled(); expect(f.read).toHaveBeenCalledTimes(2);
  });
  it("preserves manual edits and stops at conflict", async () => {
    const f = await setup(); const view = await f.preview(); f.remote.valueRanges[0].values[1][2] = "Вручную";
    expect(await f.dialog.apply(view.confirmationInput, await f.approved(view.confirmationInput))).toMatchObject({ state: "conflict", completed: false });
    expect(f.execute).not.toHaveBeenCalled(); expect(f.remote.valueRanges[0].values[1][2]).toBe("Вручную");
  });
  it("blocks stale sources both before claiming and after preflight", async () => {
    const f = await setup(); const view = await f.preview(); await f.nextSource();
    await expect(createDutyEditApproval(dutyEditPreviews)(view.confirmationInput, f.ctx)).rejects.toThrow(/VERSION_STALE/u);
    await expect(f.dialog.apply(view.confirmationInput, await f.approved(view.confirmationInput))).rejects.toThrow(/VERSION_STALE/u);
    const fresh = await f.preview(); const normal = f.read.getMockImplementation()!;
    f.read.mockImplementationOnce(async (...args) => { const loaded = await normal(...args); await f.nextSource(); return loaded; });
    expect(await f.dialog.apply(fresh.confirmationInput, await f.approved(fresh.confirmationInput))).toMatchObject({ state: "failed", errorCode: "AGENT_DUTY_SOURCE_VERSION_STALE" });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("does not save a preview if the source changes while reading", async () => {
    const f = await setup(); const normal = f.read.getMockImplementation()!;
    f.read.mockImplementationOnce(async (...args) => { const result = await normal(...args); await f.nextSource(); return result; });
    await expect(f.preview()).rejects.toThrow(/VERSION_STALE/u);
    expect((await database().query("SELECT 1 FROM duty_sheet_change_previews WHERE family_id=$1", [f.auth.familyId])).rowCount).toBe(0);
  });
  it("rejects forged internal edit contents even with a valid ID-only receipt", async () => {
    const f = await setup(); const view = await f.preview(); const saved = await dutyEditPreviews.get(f.auth, view.previewId);
    const evidence = await recordDutyApproval(f, view.confirmationInput, DUTY_SHEET_WRITE_TOOL);
    await expect(f.writer({ ...saved.input, previewId: saved.id, edits: [{ action: "upsert", section: "residents", key: "r01", values: { lastName: "Подмена" } }] }, evidence, context(f.auth, evidence))).rejects.toThrow(/PREVIEW_INVALID/u);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("binds the receipt to the actual ticket even if a caller passes unrelated raw input", async () => {
    const f = await setup(); const first = await f.preview(); const second = await f.preview();
    const saved = await dutyEditPreviews.get(f.auth, second.previewId);
    const evidence = await recordDutyApproval(f, first.confirmationInput, DUTY_SHEET_WRITE_TOOL);
    await expect(dutySheetWriteLog.claim(f.auth, { ...saved.input, previewId: saved.id }, first.confirmationInput, evidence)).rejects.toThrow(/APPROVAL_EVIDENCE_INVALID/u);
  });
  it("blocks plan replacement and modification/deletion of the immutable preview", async () => {
    const f = await setup(); const view = await f.preview(); const saved = await dutyEditPreviews.get(f.auth, view.previewId);
    await expect(database().query("UPDATE duty_sheet_change_previews SET plan='{}'::jsonb WHERE id=$1", [view.previewId])).rejects.toThrow(/PREVIEW_IMMUTABLE/u);
    await expect(database().query("DELETE FROM duty_sheet_change_previews WHERE id=$1", [view.previewId])).rejects.toThrow(/PREVIEW_IMMUTABLE/u);
    const evidence = await recordDutyApproval(f, view.confirmationInput, DUTY_SHEET_WRITE_TOOL);
    const input = { ...saved.input, previewId: saved.id };
    await dutySheetWriteLog.claim(f.auth, input, input, evidence);
    const { planDutySheetWrite } = await import("./duty-sheet-change.js");
    const plan = planDutySheetWrite(input, f.remote); plan.cells[0].after = "Подменённый план";
    await expect(dutySheetWriteLog.start(f.auth, input, input, evidence, plan)).rejects.toThrow(/PREVIEW_INVALID/u);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("preserves unknown outcome, never resends and blocks a new operation", async () => {
    const f = await setup(); const view = await f.preview(); const ctx = await f.approved(view.confirmationInput);
    f.execute.mockRejectedValueOnce(new Error("provider timeout"));
    expect(await f.dialog.apply(view.confirmationInput, ctx)).toMatchObject({ state: "unknown", retryAllowed: false });
    expect(await f.dialog.apply(view.confirmationInput, ctx)).toMatchObject({ state: "unknown" });
    const next = await f.preview();
    await expect(f.dialog.apply(next.confirmationInput, await f.approved(next.confirmationInput))).rejects.toThrow(/SHEET_BUSY/u);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it("rejects foreign previews and a role revoked after preview before any write", async () => {
    const f = await setup(); const other = await createDutyFixture(); fixtures.push(other); const view = await f.preview();
    await expect(f.dialog.apply(view.confirmationInput, context(other.auth))).rejects.toThrow(/PREVIEW_NOT_FOUND/u);
    const ctx = await f.approved(view.confirmationInput);
    await database().query("UPDATE family_memberships SET role='member' WHERE family_id=$1 AND user_id=$2", [f.auth.familyId, f.auth.userId]);
    await expect(f.dialog.apply(view.confirmationInput, ctx)).rejects.toThrow(/OWNER_REQUIRED/u); expect(f.execute).not.toHaveBeenCalled();
  });
  it.each(["member", "group", "scheduled", "child"])("rejects %s context before reads/writes", async (mode) => {
    const f = await setup(); const view = await f.preview(); const base = context(mode === "member" ? f.member : f.auth); const caller = base.session.auth.current!;
    const ctx = { ...base, session: { ...base.session, ...(mode === "child" ? { parent: { callId: "p", sessionId: "p", rootSessionId: "p", turn: { id: "p", sequence: 1 } } } : {}),
      auth: { ...base.session.auth, current: { ...caller, attributes: { ...caller.attributes, ...(mode === "group" ? { telegramChatType: "supergroup" } : {}), ...(mode === "scheduled" ? { scheduledRunId: randomUUID() } : {}) } } } } };
    await expect(f.dialog.apply(view.confirmationInput, ctx)).rejects.toThrow(/OWNER_REQUIRED|PRIVATE_CHAT_REQUIRED|INTERACTIVE_OWNER_REQUIRED/u);
    await expect(f.dialog.inspect({ action: "read", groupId: f.input.groupId, section: "settings" }, ctx)).rejects.toThrow(/OWNER_REQUIRED|PRIVATE_CHAT_REQUIRED|INTERACTIVE_OWNER_REQUIRED/u);
    expect(f.read).toHaveBeenCalledTimes(1); expect(f.execute).not.toHaveBeenCalled();
  });
});
