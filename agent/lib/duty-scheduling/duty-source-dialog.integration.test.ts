/** Owner source dialog with real PostgreSQL/receipts and a fake Google transport. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ToolContext } from "eve/tools";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, database } from "../database.js";
import { requirePrivateTelegramOwner, type PrivateTelegramOwner } from "../family-context.js";
import { createDutySheetReader } from "./duty-sheet-reader.js";
import { DUTY_SOURCE_TOOL, dutySheetSourceRepository as sources } from "./duty-sheet-source-repository.js";
import { withDutyOwner } from "./duty-storage.js";
import { createDutySourceDialog } from "./duty-source-dialog.js";
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
  const profileRef = randomUUID();
  const remote = JSON.parse(readFileSync(new URL("../../../examples/duty-scheduling/sheets-example.json", import.meta.url), "utf8"));
  remote.valueRanges[0].values[0].push("Телефон"); remote.valueRanges[0].values[1].push("fake-private-phone");
  const execute = vi.fn().mockImplementation(async () => ({ kind: "read", scope: "personal", profileRef, completed: true, stdout: JSON.stringify(remote), stderr: "" }));
  const read = vi.fn(createDutySheetReader({ requireOwner: requirePrivateTelegramOwner, withOwner: withDutyOwner, execute }));
  const dialog = createDutySourceDialog({ sources, read });
  const ctx = context(f.auth);
  const previewInput = { action: "preview", groupId: f.input.groupId, spreadsheetId: "duty-example-sheet", profileRef };
  const preview = async () => {
    const result = await dialog.inspect(previewInput, ctx);
    if (!("confirmationInput" in result) || !result.confirmationInput) throw new Error("Expected preview");
    return result;
  };
  const approved = async (input: unknown, toolName: string = DUTY_SOURCE_TOOL) => context(f.auth, await recordDutyApproval(f, input, toolName));
  return { ...f, ctx, dialog, execute, read, remote, preview, previewInput, approved };
}

(enabled ? describe : describe.skip)("duty source dialog", () => {
  afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
  afterAll(closeDatabase);
  it("reports missing configuration and previews validated counts without saving or leaking table data", async () => {
    const f = await setup();
    expect(await f.dialog.inspect({ action: "get", groupId: f.input.groupId }, f.ctx)).toMatchObject({ configured: false, configuration: null });
    expect(f.read).not.toHaveBeenCalled();
    const view = await f.preview();
    expect(view).toMatchObject({ configurationSaved: false, counts: { residents: 10, objects: 6 }, confirmationInput: { expectedVersion: 0 } });
    expect(JSON.stringify(view)).not.toContain("fake-private-phone");
    expect(view).not.toHaveProperty("data"); expect(view).not.toHaveProperty("response");
    await expect(sources.get(f.auth, f.input.groupId)).rejects.toThrow(/NOT_CONFIGURED/u);
    expect(f.execute.mock.calls[0][0].argv.slice(0, 5)).toEqual(["sheets", "spreadsheets", "values", "batchGet", "--params"]);
  });
  it("saves only the confirmed read and replays across reconnect without Google, even after a later source change", async () => {
    const f = await setup(); const { confirmationInput: input } = await f.preview(); const ctx = await f.approved(input);
    const first = await f.dialog.configure(input, ctx);
    expect(first).toMatchObject({ configurationSaved: true, reused: false, configuration: { id: input.operationId, version: 1 } });
    expect(f.read).toHaveBeenCalledTimes(2);
    const second = (await f.preview()).confirmationInput;
    await f.dialog.configure(second, await f.approved(second));
    await closeDatabase(); f.read.mockRejectedValue(new Error("Google offline"));
    expect(await f.dialog.configure(input, ctx)).toEqual({ ...first, reused: true });
    expect((await sources.get(f.auth, input.groupId)).version).toBe(2);
    const count = await database().query("SELECT count(*)::int AS n FROM duty_sheet_sources WHERE family_id=$1", [f.auth.familyId]);
    expect(count.rows[0].n).toBe(2);
  });
  it("rejects a direct call and a different tool's receipt before another Google read", async () => {
    const f = await setup(); const { confirmationInput: input } = await f.preview();
    await expect(f.dialog.configure(input, f.ctx)).rejects.toThrow(/APPROVAL_EVIDENCE_INVALID/u);
    await expect(f.dialog.configure(input, await f.approved(input, "approve_duty_schedule"))).rejects.toThrow(/APPROVAL_EVIDENCE_INVALID/u);
    expect(f.read).toHaveBeenCalledTimes(1);
  });
  it("does not reuse approval for changed fields or a different call", async () => {
    const f = await setup(); const { confirmationInput: input } = await f.preview(); const ctx = await f.approved(input);
    await expect(f.dialog.configure({ ...input, readHash: "b".repeat(64) }, ctx)).rejects.toThrow(/APPROVAL_EVIDENCE_INVALID/u);
    await expect(f.dialog.configure(input, { ...ctx, callId: randomUUID() })).rejects.toThrow(/APPROVAL_EVIDENCE_INVALID/u);
    expect(f.read).toHaveBeenCalledTimes(1);
  });
  it.each(["timeout", "deny", "retired"])("rejects %s approval receipts before Google", async (mode) => {
    const f = await setup(); const input = (await f.preview()).confirmationInput;
    const evidence = await recordDutyApproval(f, input, DUTY_SOURCE_TOOL);
    if (mode === "retired") await database().query("UPDATE conversation_sessions SET retired_at=now() WHERE id=$1", [evidence.applicationSessionId]);
    else await database().query(mode === "timeout" ? "UPDATE telegram_hitl_approvals SET timed_out_at=now() WHERE application_session_id=$1" : "UPDATE telegram_hitl_approvals SET selected_option_id='deny' WHERE application_session_id=$1", [evidence.applicationSessionId]);
    await expect(f.dialog.configure(input, context(f.auth, evidence))).rejects.toThrow(/APPROVAL_EVIDENCE_INVALID/u);
    expect(f.read).toHaveBeenCalledTimes(1);
  });
  it("rejects a role revoked after preview even with a valid receipt", async () => {
    const f = await setup(); const input = (await f.preview()).confirmationInput; const ctx = await f.approved(input);
    await database().query("UPDATE family_memberships SET role='member' WHERE family_id=$1 AND user_id=$2", [f.auth.familyId, f.auth.userId]);
    await expect(f.dialog.configure(input, ctx)).rejects.toThrow(/OWNER_REQUIRED/u);
    expect(f.read).toHaveBeenCalledTimes(1);
  });
  it("requires a new preview and approval when any read cells change", async () => {
    const f = await setup(); const { confirmationInput: input } = await f.preview();
    f.remote.valueRanges[0].values[1][1] = "Изменённое имя";
    await expect(f.dialog.configure(input, await f.approved(input))).rejects.toThrow(/SOURCE_READ_CHANGED/u);
    await expect(sources.get(f.auth, input.groupId)).rejects.toThrow(/NOT_CONFIGURED/u);
    const next = (await f.preview()).confirmationInput;
    expect(next.readHash).not.toBe(input.readHash);
    await expect(f.dialog.configure(next, await f.approved(next))).resolves.toMatchObject({ configurationSaved: true });
  });
  it("rejects stale settings before Google and rejects switching during confirmation read", async () => {
    const f = await setup(); const first = (await f.preview()).confirmationInput; const stale = (await f.preview()).confirmationInput;
    await f.dialog.configure(first, await f.approved(first));
    f.read.mockClear();
    await expect(f.dialog.configure(stale, await f.approved(stale))).rejects.toThrow(/VERSION_STALE/u);
    expect(f.read).not.toHaveBeenCalled();
    const next = (await f.preview()).confirmationInput;
    const competing = { ...next, operationId: randomUUID() };
    const evidence = await recordDutyApproval(f, competing, DUTY_SOURCE_TOOL);
    const normalRead = f.read.getMockImplementation()!;
    f.read.mockImplementationOnce(async (...args) => { const loaded = await normalRead(...args); await sources.save(f.auth, competing, evidence); return loaded; });
    await expect(f.dialog.configure(next, await f.approved(next))).rejects.toThrow(/VERSION_STALE/u);
    expect((await sources.get(f.auth, next.groupId)).id).toBe(competing.operationId);
  });
  it("rejects a source switched while previewing", async () => {
    const f = await setup(); const input = (await f.preview()).confirmationInput; const evidence = await recordDutyApproval(f, input, DUTY_SOURCE_TOOL);
    const normalRead = f.read.getMockImplementation()!;
    f.read.mockImplementationOnce(async (...args) => { const result = await normalRead(...args); await sources.save(f.auth, input, evidence); return result; });
    await expect(f.preview()).rejects.toThrow(/VERSION_STALE/u);
  });
  it.each(["member", "group", "scheduled", "child"])("rejects %s contexts before Google", async (mode) => {
    const f = await setup(); const ctx = context(mode === "member" ? f.member : f.auth);
    const current = ctx.session.auth.current!;
    const altered = { ...ctx, session: { ...ctx.session, ...(mode === "child" ? { parent: { callId: "p", sessionId: "p", rootSessionId: "p", turn: { id: "t", sequence: 1 } } } : {}),
      auth: { ...ctx.session.auth, current: { ...current, attributes: { ...current.attributes, ...(mode === "group" ? { telegramChatType: "supergroup" } : {}), ...(mode === "scheduled" ? { scheduledRunId: randomUUID() } : {}) } } } } };
    await expect(f.dialog.inspect(f.previewInput, altered)).rejects.toThrow(/OWNER_REQUIRED|PRIVATE_CHAT_REQUIRED|INTERACTIVE_OWNER_REQUIRED/u);
    const input = (await f.preview()).confirmationInput;
    await expect(f.dialog.configure(input, altered)).rejects.toThrow(/OWNER_REQUIRED|PRIVATE_CHAT_REQUIRED|INTERACTIVE_OWNER_REQUIRED/u);
    expect(f.read).toHaveBeenCalledTimes(1);
  });
  it("checks the live owner role and foreign group before Google", async () => {
    const f = await setup(); const other = await createDutyFixture(); fixtures.push(other);
    await expect(f.dialog.inspect({ ...f.previewInput, groupId: other.input.groupId }, f.ctx)).rejects.toThrow(/GROUP_INVALID/u);
    await database().query("UPDATE family_memberships SET role='member' WHERE family_id=$1 AND user_id=$2", [f.auth.familyId, f.auth.userId]);
    await expect(f.preview()).rejects.toThrow(/OWNER_REQUIRED/u);
    expect(f.read).not.toHaveBeenCalled();
  });
  it("does not save when the current Google profile differs or the response is malformed", async () => {
    const f = await setup(); const input = (await f.preview()).confirmationInput; const ctx = await f.approved(input);
    f.execute.mockResolvedValueOnce({ kind: "read", scope: "personal", profileRef: "switched", completed: true, stdout: JSON.stringify(f.remote) });
    await expect(f.dialog.configure(input, ctx)).rejects.toThrow(/SHEET_READ_INVALID/u);
    f.execute.mockResolvedValueOnce({ kind: "read", scope: "personal", profileRef: f.previewInput.profileRef, completed: true, stdout: "not-json" });
    await expect(f.dialog.configure(input, ctx)).rejects.toThrow(/SHEET_READ_INVALID/u);
    await expect(sources.get(f.auth, input.groupId)).rejects.toThrow(/NOT_CONFIGURED/u);
  });
  it("warns about missing history without silently opting into zero-start", async () => {
    const f = await setup();
    const settings = f.remote.valueRanges[5].values;
    settings.find((row: unknown[]) => row[0] === "historyMode")[1] = "not_loaded";
    settings.find((row: unknown[]) => row[0] === "historyFromDate")[1] = "";
    f.remote.valueRanges[7].values.splice(1); f.remote.valueRanges[8].values.splice(1);
    const view = await f.preview();
    expect(view.previewText).toContain("История ещё не загружена");
    expect(view.historyMode).toBe("not_loaded");
    await f.dialog.configure(view.confirmationInput, await f.approved(view.confirmationInput));
  });
});
