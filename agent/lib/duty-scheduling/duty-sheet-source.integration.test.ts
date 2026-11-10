/** Versioned private source configuration, immutable history and group-scoped reads on PostgreSQL. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ToolContext } from "eve/tools";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, database } from "../database.js";
import { createConfiguredDutySheetReader } from "./duty-configured-sheet.js";
import { createDutySheetSource } from "./duty-sheet-format.js";
import { previewDutySheetImport } from "./duty-sheet-import.js";
import { DUTY_SOURCE_TOOL, dutySheetSourceRepository as sources } from "./duty-sheet-source-repository.js";
import { createDutyFixture, recordDutyApproval, requireDutyTestDatabase, type DutyFixture } from "./duty-storage.integration-fixtures.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled) requireDutyTestDatabase();
const fixtures: DutyFixture[] = [];
async function fixture() {
  const f = await createDutyFixture(); fixtures.push(f);
  const input = { operationId: randomUUID(), groupId: f.input.groupId, expectedVersion: 0, source: createDutySheetSource("duty-example-sheet", randomUUID()) };
  const evidence = await recordDutyApproval(f, input, DUTY_SOURCE_TOOL);
  return { ...f, change: input, evidence };
}

(enabled ? describe : describe.skip)("duty sheet sources", () => {
  afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
  afterAll(closeDatabase);

  it("persists a confirmed source and replays it across reconnection", async () => {
    const f = await fixture();
    const first = await sources.save(f.auth, f.change, f.evidence);
    expect(first).toMatchObject({ version: 1, groupId: f.input.groupId, source: f.change.source });
    await closeDatabase();
    expect(await sources.get(f.auth, f.input.groupId)).toEqual(first);
    expect(await sources.save(f.auth, f.change, f.evidence)).toEqual(first);
  });

  it("serializes concurrent configuration changes and keeps the first version unchanged", async () => {
    const f = await fixture();
    const original = await sources.save(f.auth, f.change, f.evidence);
    const changes = ["one", "two"].map((title) => ({ ...f.change, operationId: randomUUID(), expectedVersion: 1,
      source: { ...f.change.source, mapping: { ...f.change.source.mapping, residents: { ...f.change.source.mapping.residents, sheet: title } } } }));
    const approvals = await Promise.all(changes.map((input) => recordDutyApproval(f, input, DUTY_SOURCE_TOOL)));
    const results = await Promise.allSettled(changes.map((input, index) => sources.save(f.auth, input, approvals[index])));
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((row) => row.status === "rejected")).toMatchObject([{ reason: { code: "AGENT_DUTY_SOURCE_VERSION_STALE" } }]);
    expect((await sources.get(f.auth, f.input.groupId)).version).toBe(2);
    expect(await sources.save(f.auth, f.change, f.evidence)).toEqual(original);
    await expect(sources.save({ ...f.auth }, { ...f.change, expectedVersion: 1 }, f.evidence)).rejects.toThrow(/AGENT_DUTY_SOURCE_OPERATION_CONFLICT/u);
  });

  it("requires the exact personal approval, live owner role and the family's external group", async () => {
    const f = await fixture();
    const wrong = await recordDutyApproval(f, f.change);
    await expect(sources.save(f.auth, f.change, wrong)).rejects.toThrow(/AGENT_TOOL_APPROVAL_EVIDENCE_INVALID/u);
    await expect(sources.save(f.member, f.change, f.evidence)).rejects.toThrow(/AGENT_OWNER_REQUIRED/u);
    const other = await fixture();
    await expect(sources.save(other.auth, f.change, f.evidence)).rejects.toThrow(/AGENT_DUTY_GROUP_INVALID/u);
    await sources.save(f.auth, f.change, f.evidence);
    await database().query("UPDATE family_memberships SET role = 'member' WHERE family_id = $1 AND user_id = $2", [f.auth.familyId, f.auth.userId]);
    await expect(sources.get(f.auth, f.input.groupId)).rejects.toThrow(/AGENT_OWNER_REQUIRED/u);
  });

  it("rejects missing configuration and invalid source mappings", async () => {
    const f = await fixture();
    await expect(sources.get(f.auth, f.input.groupId)).rejects.toThrow(/AGENT_DUTY_SOURCE_NOT_CONFIGURED/u);
    const bad = structuredClone(f.change);
    bad.source.mapping.residents.sheet = bad.source.mapping.objects.sheet;
    await expect(sources.save(f.auth, bad, f.evidence)).rejects.toThrow(/AGENT_DUTY_SHEET_INVALID/u);
    await database().query("UPDATE telegram_groups SET type = 'family_private' WHERE id = $1", [f.input.groupId]);
    await expect(sources.save(f.auth, f.change, f.evidence)).rejects.toThrow(/AGENT_DUTY_GROUP_INVALID/u);
  });

  it("keeps archival metadata after group deletion without using that source again", async () => {
    const f = await fixture();
    await sources.save(f.auth, f.change, f.evidence);
    await database().query("DELETE FROM telegram_groups WHERE id = $1", [f.input.groupId]);
    await expect(sources.get(f.auth, f.input.groupId)).rejects.toThrow(/AGENT_DUTY_GROUP_INVALID/u);
    const row = await database().query("SELECT group_id, input FROM duty_sheet_sources WHERE id = $1", [f.change.operationId]);
    expect(row.rows[0]).toMatchObject({ group_id: null, input: { groupId: f.input.groupId } });
  });

  it("blocks rewriting or individually deleting a source version", async () => {
    const f = await fixture();
    await sources.save(f.auth, f.change, f.evidence);
    await expect(database().query("UPDATE duty_sheet_sources SET input = '{}'::jsonb WHERE id = $1", [f.change.operationId])).rejects.toThrow(/AGENT_DUTY_SOURCE_IMMUTABLE/u);
    await expect(database().query("DELETE FROM duty_sheet_sources WHERE id = $1", [f.change.operationId])).rejects.toThrow(/AGENT_DUTY_SOURCE_IMMUTABLE/u);
  });

  it("reads the saved source and returns its version with the loaded data", async () => {
    const f = await fixture();
    await sources.save(f.auth, f.change, f.evidence);
    const raw = JSON.parse(readFileSync(new URL("../../../examples/duty-scheduling/sheets-example.json", import.meta.url), "utf8"));
    const read = vi.fn(async (_source: unknown) => ({ ...previewDutySheetImport(f.change.source, raw), response: raw, owner: { familyId: f.auth.familyId, userId: f.auth.userId } }));
    const load = createConfiguredDutySheetReader({ owner: () => f.auth, read, sources });
    const result = await load(f.input.groupId, { abortSignal: new AbortController().signal } as ToolContext);
    expect(result.configuration).toEqual({ id: f.change.operationId, version: 1, groupId: f.input.groupId });
    expect(read.mock.calls[0][0]).toEqual(f.change.source);
  });

  it("does not return a read from a source switched during the Google request", async () => {
    const f = await fixture();
    await sources.save(f.auth, f.change, f.evidence);
    const raw = JSON.parse(readFileSync(new URL("../../../examples/duty-scheduling/sheets-example.json", import.meta.url), "utf8"));
    const read = vi.fn(async () => {
      const next = { ...f.change, operationId: randomUUID(), expectedVersion: 1 };
      await sources.save(f.auth, next, await recordDutyApproval(f, next, DUTY_SOURCE_TOOL));
      return { ...previewDutySheetImport(f.change.source, raw), response: raw, owner: { familyId: f.auth.familyId, userId: f.auth.userId } };
    });
    const load = createConfiguredDutySheetReader({ owner: () => f.auth, read, sources });
    await expect(load(f.input.groupId, { abortSignal: new AbortController().signal } as ToolContext)).rejects.toThrow(/AGENT_DUTY_SOURCE_VERSION_STALE/u);
  });
});
