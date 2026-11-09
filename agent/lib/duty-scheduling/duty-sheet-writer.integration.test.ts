/** Real audit/approval transactions with a deterministic fake Sheets transport; no external mutations. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ToolContext } from "eve/tools";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import { closeDatabase, database } from "../database.js";
import { DUTY_SHEET_WRITE_TOOL, prepareDutySheetChange } from "./duty-sheet-change.js";
import { createDutySheetSource } from "./duty-sheet-format.js";
import { previewDutySheetImport } from "./duty-sheet-import.js";
import { createDutySheetWriter } from "./duty-sheet-writer.js";
import { dutySheetWriteLog } from "./duty-sheet-write-log.js";
import { createDutyFixture, recordDutyApproval, requireDutyTestDatabase, type DutyFixture } from "./duty-storage.integration-fixtures.js";
import { withDutyOwner } from "./duty-storage.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled) requireDutyTestDatabase();
const fixtures: DutyFixture[] = [];

async function setup() {
  const family = await createDutyFixture();
  fixtures.push(family);
  const remote = JSON.parse(readFileSync(new URL("./fixtures/sheets-example.json", import.meta.url), "utf8"));
  const source = createDutySheetSource("duty-example-sheet", randomUUID());
  const { input, plan } = prepareDutySheetChange(source, remote, [{ action: "upsert", section: "residents", key: "r01", values: { lastName: "НоваяФамилия" } }]);
  const evidence = await recordDutyApproval(family, input, DUTY_SHEET_WRITE_TOOL);
  const ctx = { abortSignal: new AbortController().signal } as ToolContext;
  const owner = vi.fn().mockReturnValue(family.auth);
  const read = vi.fn(async () => ({ ...previewDutySheetImport(source, remote), response: structuredClone(remote), owner: { familyId: family.auth.familyId, userId: family.auth.userId } }));
  function apply(argv: string[]) {
    expect(argv.slice(0, 5)).toEqual(["sheets", "spreadsheets", "values", "batchUpdate", "--params"]);
    const payload = JSON.parse(argv[7]);
    expect(payload.valueInputOption).toBe("RAW");
    for (const cell of payload.data) {
      const match = /^'(.*)'!([A-Z])(\d+)$/u.exec(cell.range);
      if (!match) throw new Error("Bad mock range");
      const table = remote.valueRanges.find((tab: { range: string }) => tab.range.startsWith(`'${match[1]}'!`));
      const row = Number(match[3]) - 1;
      const column = match[2].charCodeAt(0) - 65;
      while (table.values.length <= row) table.values.push([]);
      while (table.values[row].length <= column) table.values[row].push("");
      table.values[row][column] = cell.values[0][0];
    }
  }
  const success = { kind: "mutation" as const, scope: "personal" as const, profileRef: source.profileRef, completed: true as const, stdout: "{}", stderr: "" };
  const execute = vi.fn(async (command: { argv: string[]; expectedProfileRef?: string }) => {
    expect(command.expectedProfileRef).toBe(source.profileRef);
    apply(command.argv);
    return success;
  });
  const write = createDutySheetWriter({ owner, read, execute, log: dutySheetWriteLog, withOwner: withDutyOwner });
  return { family, input, plan, evidence, ctx, remote, read, execute, write, apply, success };
}

(enabled ? describe : describe.skip)("duty sheet writer", () => {
  afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
  afterAll(closeDatabase);

  it("writes once, verifies the result, and replays a completed operation after reconnect without Google", async () => {
    const f = await setup();
    expect(await f.write(f.input, f.evidence, f.ctx)).toMatchObject({ state: "applied", completed: true, retryAllowed: false, plan: { cells: f.plan.cells } });
    expect(f.remote.valueRanges[0].values[1][2]).toBe("НоваяФамилия");
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.read).toHaveBeenCalledTimes(2);
    await closeDatabase();
    await database().query("UPDATE conversation_sessions SET retired_at = now() WHERE id = $1", [f.evidence.applicationSessionId]);
    expect(await f.write(f.input, f.evidence, f.ctx)).toMatchObject({ state: "applied" });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.read).toHaveBeenCalledTimes(2);
  });

  it("rejects changed input or a confirmation for another tool before accessing Google", async () => {
    const f = await setup();
    f.input.edits[0] = { action: "upsert", section: "residents", key: "r01", values: { lastName: "Подменено" } };
    await expect(f.write(f.input, f.evidence, f.ctx)).rejects.toThrow(/AGENT_TOOL_APPROVAL_EVIDENCE_INVALID/u);
    const other = await recordDutyApproval(f.family, f.input); // Schedule approval cannot authorize a Sheets write.
    await expect(f.write(f.input, other, f.ctx)).rejects.toThrow(/AGENT_TOOL_APPROVAL_EVIDENCE_INVALID/u);
    expect(f.read).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("preserves a manual edit made after the reviewed snapshot", async () => {
    const f = await setup();
    f.remote.valueRanges[0].values[1][2] = "РучнаяПравка";
    expect(await f.write(f.input, f.evidence, f.ctx)).toMatchObject({ state: "conflict", completed: false, errorCode: "AGENT_DUTY_SHEET_CONFLICT" });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.remote.valueRanges[0].values[1][2]).toBe("РучнаяПравка");
  });

  it("records a preflight connection failure without attempting mutation", async () => {
    const f = await setup();
    f.read.mockRejectedValueOnce(new AppError("AGENT_GOOGLE_WORKSPACE_PROFILE_CHANGED", "Профиль изменился"));
    expect(await f.write(f.input, f.evidence, f.ctx)).toMatchObject({ state: "failed", errorCode: "AGENT_GOOGLE_WORKSPACE_PROFILE_CHANGED" });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("rechecks a receipt retired while preflight was running", async () => {
    const f = await setup();
    f.read.mockImplementationOnce(async () => {
      await database().query("UPDATE conversation_sessions SET retired_at = now() WHERE id = $1", [f.evidence.applicationSessionId]);
      return { ...previewDutySheetImport(f.input.source, f.remote), response: f.remote, owner: { familyId: f.family.auth.familyId, userId: f.family.auth.userId } };
    });
    expect(await f.write(f.input, f.evidence, f.ctx)).toMatchObject({ state: "failed", errorCode: "AGENT_TOOL_APPROVAL_EVIDENCE_INVALID" });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("allows only one attempt for concurrent calls with the same operation ID", async () => {
    const f = await setup();
    const results = await Promise.allSettled([f.write(f.input, f.evidence, f.ctx), f.write(f.input, f.evidence, f.ctx)]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(await dutySheetWriteLog.get(f.family.auth, f.input.operationId)).toMatchObject({ state: "applied" });
    await expect(f.write({ ...f.input, expectedSourceHash: "0".repeat(64) }, f.evidence, f.ctx)).rejects.toThrow(/AGENT_DUTY_SHEET_OPERATION_CONFLICT/u);
  });

  it("blocks a different operation while a write to the same source is in flight", async () => {
    const f = await setup();
    let release = () => {};
    let entered = () => {};
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    f.execute.mockImplementationOnce(async ({ argv }) => { entered(); await pending; f.apply(argv); return f.success; });
    const running = f.write(f.input, f.evidence, f.ctx);
    await started;
    try {
      const next = { ...f.input, operationId: randomUUID() };
      const approval = await recordDutyApproval(f.family, next, DUTY_SHEET_WRITE_TOOL);
      await expect(f.write(next, approval, f.ctx)).rejects.toThrow(/AGENT_DUTY_SHEET_BUSY/u);
    } finally { release(); }
    expect(await running).toMatchObject({ state: "applied" });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("records timeout as unknown whether or not Google already changed cells: %s", async (applied) => {
    const f = await setup();
    f.execute.mockImplementationOnce(async ({ argv }) => { if (applied) f.apply(argv); throw new Error("provider timeout"); });
    expect(await f.write(f.input, f.evidence, f.ctx)).toMatchObject({ state: "unknown", completed: false, retryAllowed: false });
    expect(await f.write(f.input, f.evidence, f.ctx)).toMatchObject({ state: "unknown" });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.read).toHaveBeenCalledTimes(1);
    const next = { ...f.input, operationId: randomUUID() };
    await expect(f.write(next, await recordDutyApproval(f.family, next, DUTY_SHEET_WRITE_TOOL), f.ctx)).rejects.toThrow(/AGENT_DUTY_SHEET_BUSY/u);
  });

  it("does not repair or overwrite an unexpected post-write result", async () => {
    const f = await setup();
    f.execute.mockImplementationOnce(async ({ argv }) => { f.apply(argv); f.remote.valueRanges[0].values[2][2] = "ЧужаяПравка"; return f.success; });
    expect(await f.write(f.input, f.evidence, f.ctx)).toMatchObject({ state: "unknown", errorCode: "AGENT_DUTY_SHEET_WRITE_UNVERIFIED" });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.remote.valueRanges[0].values[2][2]).toBe("ЧужаяПравка");
  });

  it("does not repeat a successful provider write when verification cannot connect", async () => {
    const f = await setup();
    f.execute.mockImplementationOnce(async ({ argv }) => { f.apply(argv); f.read.mockRejectedValueOnce(new Error("read timeout")); return f.success; });
    expect(await f.write(f.input, f.evidence, f.ctx)).toMatchObject({ state: "unknown", completed: false });
    expect(f.remote.valueRanges[0].values[1][2]).toBe("НоваяФамилия");
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.read).toHaveBeenCalledTimes(2);
  });

  it("keeps an uncertain spreadsheet blocked even after switching Google accounts", async () => {
    const f = await setup();
    f.execute.mockRejectedValueOnce(new Error("timeout"));
    await f.write(f.input, f.evidence, f.ctx);
    const next = { ...f.input, operationId: randomUUID(), source: { ...f.input.source, profileRef: randomUUID() } };
    const approval = await recordDutyApproval(f.family, next, DUTY_SHEET_WRITE_TOOL);
    await expect(f.write(next, approval, f.ctx)).rejects.toThrow(/AGENT_DUTY_SHEET_BUSY/u);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("records an uncertain outcome even if the owner role was revoked during the request", async () => {
    const f = await setup();
    f.execute.mockImplementationOnce(async () => {
      await database().query("UPDATE family_memberships SET role = 'member' WHERE family_id = $1 AND user_id = $2", [f.family.auth.familyId, f.family.auth.userId]);
      throw new Error("timeout after role change");
    });
    await expect(f.write(f.input, f.evidence, f.ctx)).rejects.toThrow(/AGENT_OWNER_REQUIRED/u);
    const row = await database().query("SELECT state FROM duty_sheet_writes WHERE id = $1", [f.input.operationId]);
    expect(row.rows[0].state).toBe("unknown");
  });

  it("keeps a verified success if final access was revoked and prevents cross-family reads", async () => {
    const f = await setup();
    const ownerCheck: typeof withDutyOwner = async () => { throw new AppError("AGENT_OWNER_REQUIRED", "Роль отозвана"); };
    const writer = createDutySheetWriter({ owner: () => f.family.auth, read: f.read, execute: f.execute, log: dutySheetWriteLog, withOwner: ownerCheck });
    await expect(writer(f.input, f.evidence, f.ctx)).rejects.toThrow(/AGENT_OWNER_REQUIRED/u);
    expect(await dutySheetWriteLog.get(f.family.auth, f.input.operationId)).toMatchObject({ state: "applied" });
    const other = await createDutyFixture(); fixtures.push(other);
    await expect(dutySheetWriteLog.get(other.auth, f.input.operationId)).rejects.toThrow(/AGENT_DUTY_SHEET_OPERATION_NOT_FOUND/u);
  });

  it("protects immutable audit contents and prevents replaying a terminal write", async () => {
    const f = await setup();
    await f.write(f.input, f.evidence, f.ctx);
    await expect(database().query("UPDATE duty_sheet_writes SET input = '{}'::jsonb WHERE id = $1", [f.input.operationId])).rejects.toThrow(/AGENT_DUTY_SHEET_AUDIT_IMMUTABLE/u);
    await expect(database().query("UPDATE duty_sheet_writes SET state = 'writing', finished_at = NULL WHERE id = $1", [f.input.operationId])).rejects.toThrow(/AGENT_DUTY_SHEET_STATE_INVALID/u);
    await expect(database().query("DELETE FROM duty_sheet_writes WHERE id = $1", [f.input.operationId])).rejects.toThrow(/AGENT_DUTY_SHEET_AUDIT_IMMUTABLE/u);
  });
});
