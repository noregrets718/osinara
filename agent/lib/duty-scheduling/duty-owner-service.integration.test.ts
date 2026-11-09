/** Owner workflow through real authorization/storage and a fake Google read. No outgoing messages or Sheets writes. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ToolContext } from "eve/tools";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, database } from "../database.js";
import { requirePrivateTelegramOwner, type PrivateTelegramOwner } from "../family-context.js";
import tool from "../tools/manage_duty_schedule.js";
import { createConfiguredDutySheetReader } from "./duty-configured-sheet.js";
import { listDutyOwnerGroups } from "./duty-owner-groups.js";
import { createDutyOwnerManager } from "./duty-owner-service.js";
import { dutyScheduleRepository as schedules } from "./duty-schedule-repository.js";
import { createDutySheetSource } from "./duty-sheet-format.js";
import { previewDutySheetImport } from "./duty-sheet-import.js";
import { DUTY_SOURCE_TOOL, dutySheetSourceRepository as sources } from "./duty-sheet-source-repository.js";
import { createDutyFixture, recordDutyApproval, requireDutyTestDatabase, type DutyFixture } from "./duty-storage.integration-fixtures.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled) requireDutyTestDatabase();
const fixtures: DutyFixture[] = [];
function context(auth: PrivateTelegramOwner, options: { chatType?: string; role?: string; scheduled?: boolean; child?: boolean } = {}): ToolContext {
  return { callId: randomUUID(), abortSignal: new AbortController().signal,
    session: { id: `fixture-${randomUUID()}`, turn: { id: randomUUID(), sequence: 1 },
      ...(options.child ? { parent: { callId: "parent-call", sessionId: "parent", rootSessionId: "parent", turn: { id: "t", sequence: 1 } } } : {}),
      auth: { initiator: null, current: { principalId: auth.userId, principalType: "user", authenticator: "telegram", attributes: {
        familyId: auth.familyId, role: options.role ?? auth.role, telegramChatId: auth.telegramChatId, telegramChatType: options.chatType ?? "private",
        telegramUserId: auth.telegramChatId, telegramActorKind: "telegram_user", telegramActorId: auth.telegramChatId, memoryScopes: ["personal", "family"],
        ...(options.scheduled ? { scheduledRunId: randomUUID() } : {}),
      } } } },
  } as unknown as ToolContext;
}
async function setup() {
  const f = await createDutyFixture(); fixtures.push(f);
  const source = createDutySheetSource("duty-example-sheet", randomUUID());
  const configure = { operationId: randomUUID(), groupId: f.input.groupId, expectedVersion: 0, source };
  const config = await sources.save(f.auth, configure, await recordDutyApproval(f, configure, DUTY_SOURCE_TOOL));
  const remote = JSON.parse(readFileSync(new URL("../../../examples/duty-scheduling/sheets-example.json", import.meta.url), "utf8"));
  remote.valueRanges[0].values[0].push("Телефон"); remote.valueRanges[0].values[1].push("private-fictional-phone");
  const read = vi.fn(async (selected: unknown) => ({ ...previewDutySheetImport(selected, remote), response: remote, owner: { familyId: f.auth.familyId, userId: f.auth.userId } }));
  const load = createConfiguredDutySheetReader({ owner: requirePrivateTelegramOwner, read, sources });
  const manager = createDutyOwnerManager({ owner: requirePrivateTelegramOwner, groups: listDutyOwnerGroups, load, schedules });
  return { ...f, config, configure, remote, read, load, manager, ctx: context(f.auth), request: { action: "prepare", groupId: f.input.groupId, date: "2026-11-09" } as const };
}
async function nextSource(f: Awaited<ReturnType<typeof setup>>) {
  const input = { ...f.configure, operationId: randomUUID(), expectedVersion: 1, source: { ...f.configure.source, profileRef: randomUUID() } };
  return sources.save(f.auth, input, await recordDutyApproval(f, input, DUTY_SOURCE_TOOL));
}

(enabled ? describe : describe.skip)("duty owner workflow", () => {
  afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
  afterAll(closeDatabase);

  it("lists only this owner's external groups with source status and no Google profile details", async () => {
    const f = await setup();
    const other = await createDutyFixture(); fixtures.push(other);
    const result = await f.manager({ action: "groups" }, f.ctx);
    expect(result).toMatchObject({ groups: [{ groupId: f.input.groupId, configured: true, sourceVersion: 1 }] });
    expect(JSON.stringify(result)).not.toContain(f.configure.source.profileRef);
    expect(f.read).not.toHaveBeenCalled();
  });

  it("prepares from the saved source and returns the frozen version without Google on get/latest", async () => {
    const f = await setup();
    const view = await f.manager(f.request, f.ctx);
    if (!("id" in view)) throw new Error("Expected schedule");
    expect(view).toMatchObject({ status: "draft", version: 1, filledSlots: 6, reused: false, configuration: { id: f.config.id, version: 1 } });
    expect(JSON.stringify(view)).not.toContain("private-fictional-phone");
    const saved = await schedules.get(f.auth, view.id);
    expect(saved.snapshot.source).toMatchObject({ id: f.config.id, version: 1, readHash: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    f.remote.valueRanges[0].values[1][2] = "ПоменялосьПослеРасчёта";
    f.read.mockRejectedValue(new Error("Google unavailable"));
    await closeDatabase();
    const get = await f.manager({ action: "get", id: view.id }, f.ctx);
    const latest = await f.manager({ action: "latest", groupId: f.input.groupId, date: f.request.date }, f.ctx);
    expect(get).toMatchObject({ id: view.id, previewText: view.previewText });
    expect(latest).toMatchObject({ id: view.id, previewText: view.previewText });
    expect(f.read).toHaveBeenCalledTimes(1);
  });

  it("reuses one call before rereading Sheets, while a new call uses the new source version", async () => {
    const f = await setup();
    const first = await f.manager(f.request, f.ctx);
    if (!("id" in first)) throw new Error("Expected schedule");
    const config = await nextSource(f);
    expect(await f.manager(f.request, f.ctx)).toMatchObject({ id: first.id, reused: true, version: 1 });
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(await f.manager(f.request, context(f.auth))).toMatchObject({ version: 2, configuration: { id: config.id, version: 2 } });
    await expect(f.manager({ ...f.request, date: "2026-11-10" }, f.ctx)).rejects.toThrow(/AGENT_DUTY_OPERATION_CONFLICT/u);
    expect(f.read).toHaveBeenCalledTimes(2);
  });

  it("rejects a source switched after the read but before persistence", async () => {
    const f = await setup();
    const manager = createDutyOwnerManager({ owner: requirePrivateTelegramOwner, groups: listDutyOwnerGroups, schedules,
      load: async (id, ctx) => { const loaded = await f.load(id, ctx); await nextSource(f); return loaded; } });
    await expect(manager(f.request, f.ctx)).rejects.toThrow(/AGENT_DUTY_SOURCE_VERSION_STALE/u);
    await expect(schedules.latest(f.auth, f.input.groupId, f.request.date)).rejects.toThrow(/AGENT_DUTY_VERSION_NOT_FOUND/u);
  });

  it("keeps unknown history unknown and reports missing shifts without relaxing constraints", async () => {
    const f = await setup();
    for (const row of f.remote.valueRanges[5].values) {
      if (row[0] === "historyMode") row[1] = "not_loaded";
      if (row[0] === "historyFromDate") row[1] = "";
    }
    f.remote.valueRanges[7].values.splice(1); f.remote.valueRanges[8].values.splice(1);
    await expect(f.manager(f.request, f.ctx)).rejects.toThrow(/AGENT_DUTY_HISTORY_NOT_READY/u);
    await expect(schedules.latest(f.auth, f.input.groupId, f.request.date)).rejects.toThrow(/AGENT_DUTY_VERSION_NOT_FOUND/u);
    for (const row of f.remote.valueRanges[5].values) {
      if (row[0] === "historyMode") row[1] = "zero_start";
      if (row[0] === "historyFromDate") row[1] = "2026-11-01";
    }
    expect(await f.manager({ ...f.request, date: "2026-11-10" }, context(f.auth))).toMatchObject({ complete: false, missingShifts: expect.any(Array), unfilledSlots: expect.any(Number) });
  });

  it("blocks a revoked owner before Google and isolates versions between families", async () => {
    const f = await setup();
    const view = await f.manager(f.request, f.ctx);
    if (!("id" in view)) throw new Error("Expected schedule");
    const other = await createDutyFixture(); fixtures.push(other);
    await expect(f.manager({ action: "get", id: view.id }, context(other.auth))).rejects.toThrow(/AGENT_DUTY_VERSION_NOT_FOUND/u);
    await database().query("UPDATE family_memberships SET role = 'member' WHERE family_id = $1 AND user_id = $2", [f.auth.familyId, f.auth.userId]);
    await expect(f.manager(f.request, context(f.auth))).rejects.toThrow(/AGENT_OWNER_REQUIRED/u);
    expect(f.read).toHaveBeenCalledTimes(1);
  });

  it.each([
    { role: "member" }, { chatType: "supergroup" }, { scheduled: true }, { child: true },
  ])("rejects a replayed handler invocation from a forbidden context: %j", async (mode) => {
    const f = await setup();
    await expect(tool.execute(f.request, context(f.auth, mode))).rejects.toThrow(/AGENT_(OWNER_REQUIRED|PRIVATE_CHAT_REQUIRED|DUTY_INTERACTIVE_OWNER_REQUIRED)/u);
    expect(f.read).not.toHaveBeenCalled();
  });

  it("shows an archived version by ID after group deletion, while latest rejects the removed group", async () => {
    const f = await setup();
    const view = await f.manager(f.request, f.ctx);
    if (!("id" in view)) throw new Error("Expected schedule");
    await database().query("DELETE FROM telegram_groups WHERE id = $1", [f.input.groupId]);
    expect(await f.manager({ action: "get", id: view.id }, f.ctx)).toMatchObject({ previewText: view.previewText });
    await expect(f.manager({ action: "latest", groupId: f.input.groupId, date: f.request.date }, f.ctx)).rejects.toThrow(/AGENT_DUTY_GROUP_INVALID/u);
  });
});
