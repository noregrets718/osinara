/** Persistence, immutable snapshots, exact owner approvals and effective history on real PostgreSQL. */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { rankDutyCandidates } from "./duty-candidates.js";
import { parseDutyHistory } from "./duty-history.js";
import { dutyScheduleRepository as repository } from "./duty-schedule-repository.js";
import { hashDutyJson } from "./duty-snapshot.js";
import { approvalInput, createDutyFixture, recordDutyApproval, requireDutyTestDatabase, type DutyFixture } from "./duty-storage.integration-fixtures.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled) requireDutyTestDatabase();
const fixtures: DutyFixture[] = [];
async function setup() {
  const fixture = await createDutyFixture();
  fixtures.push(fixture);
  return fixture;
}
async function approved(fixture: DutyFixture) {
  const version = await repository.save(fixture.auth, fixture.input);
  const input = approvalInput(version);
  const evidence = await recordDutyApproval(fixture, input);
  return repository.approve(fixture.auth, input, evidence);
}

(enabled ? describe : describe.skip)("dutyScheduleRepository", () => {
  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.cleanup();
  });
  afterAll(closeDatabase);

  it("preserves a calculation and its input snapshot across reconnects and later rule changes", async () => {
    const f = await setup();
    const first = await repository.save(f.auth, f.input);
    expect(first).toMatchObject({ version: 1, status: "draft", approvedAt: null, snapshot: { draft: { filledSlots: 6 } } });
    expect(first.contentHash).toBe(hashDutyJson(first.snapshot));
    f.input.data.rules.version = "edited-2";
    f.input.data.objects[0].name = "Новая столовая";
    const second = await repository.save(f.auth, { ...f.input, operationKey: randomUUID() });
    expect(second.version).toBe(2);
    expect(second.snapshot.draft.rulesVersion).toBe("edited-2");
    await closeDatabase();
    expect(await repository.get(f.auth, first.id)).toEqual(first);
    expect(first.snapshot.data.objects[0].name).toBe("Столовая");
  });

  it("returns the same version for an exact operation replay and rejects changed inputs", async () => {
    const f = await setup();
    const [a, b] = await Promise.all([repository.save(f.auth, f.input), repository.save(f.auth, f.input)]);
    expect(a).toEqual(b);
    f.input.data.rules.version = "changed";
    await expect(repository.save(f.auth, f.input)).rejects.toThrow(/AGENT_DUTY_OPERATION_CONFLICT/u);
  });

  it("serializes concurrent saves into unique consecutive versions", async () => {
    const f = await setup();
    const versions = await Promise.all(Array.from({ length: 4 }, () => repository.save(f.auth, { ...f.input, operationKey: randomUUID() })));
    expect(versions.map((row) => row.version).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it("isolates families and rejects members, forged private identities and revoked owners", async () => {
    const f = await setup();
    const other = await setup();
    const row = await repository.save(f.auth, f.input);
    await expect(repository.get(other.auth, row.id)).rejects.toThrow(/AGENT_DUTY_VERSION_NOT_FOUND/u);
    await expect(repository.get(f.member, row.id)).rejects.toThrow(/AGENT_OWNER_REQUIRED/u);
    await expect(repository.get({ ...f.member, role: "owner" }, row.id)).rejects.toThrow(/AGENT_OWNER_REQUIRED/u);
    await expect(repository.get({ ...f.auth, telegramChatId: f.member.telegramChatId }, row.id)).rejects.toThrow(/AGENT_PRIVATE_CHAT_REQUIRED/u);
    await expect(repository.save(other.auth, f.input)).rejects.toThrow(/AGENT_DUTY_GROUP_INVALID/u);
    await database().query("UPDATE family_memberships SET role = 'member' WHERE family_id = $1 AND user_id = $2", [f.auth.familyId, f.auth.userId]);
    await expect(repository.get(f.auth, row.id)).rejects.toThrow(/AGENT_OWNER_REQUIRED/u);
  });

  it("rejects a family group as the publication destination", async () => {
    const f = await setup();
    await database().query("UPDATE telegram_groups SET type = 'family_private' WHERE id = $1", [f.input.groupId]);
    await expect(repository.save(f.auth, f.input)).rejects.toThrow(/AGENT_DUTY_GROUP_INVALID/u);
  });

  it.each(["snapshot = '{}'::jsonb", "content_hash = repeat('0', 64)", "version = 50", "duty_date = '2026-11-10'", "base_approved_id = gen_random_uuid()"])("protects archived calculation from SQL mutation: %s", async (change) => {
    const f = await setup();
    const row = await repository.save(f.auth, f.input);
    await expect(database().query(`UPDATE duty_schedule_versions SET ${change} WHERE id = $1`, [row.id])).rejects.toThrow(/AGENT_DUTY_SNAPSHOT_IMMUTABLE/u);
    expect(await repository.get(f.auth, row.id)).toEqual(row);
  });

  it("blocks individual deletion and resurrection of cancelled drafts", async () => {
    const f = await setup();
    const row = await repository.save(f.auth, f.input);
    await expect(database().query("DELETE FROM duty_schedule_versions WHERE id = $1", [row.id])).rejects.toThrow(/AGENT_DUTY_SNAPSHOT_IMMUTABLE/u);
    await database().query("UPDATE duty_schedule_versions SET status = 'cancelled' WHERE id = $1", [row.id]);
    await expect(database().query("UPDATE duty_schedule_versions SET status = 'draft' WHERE id = $1", [row.id])).rejects.toThrow(/AGENT_DUTY_VERSION_INVALID/u);
  });

  it("requires an actual receipt and rejects substituted snapshot hashes", async () => {
    const f = await setup();
    const row = await repository.save(f.auth, f.input);
    const input = approvalInput(row);
    await expect(repository.approve(f.auth, input, { applicationSessionId: randomUUID(), eveSessionId: "missing", toolCallId: "missing" }))
      .rejects.toThrow(/AGENT_TOOL_APPROVAL_EVIDENCE_INVALID/u);
    const evidence = await recordDutyApproval(f, input);
    await expect(repository.approve(f.auth, { ...input, contentHash: "0".repeat(64) }, evidence)).rejects.toThrow(/AGENT_DUTY_VERSION_STALE/u);
    await expect(repository.approve(f.auth, input, evidence)).resolves.toMatchObject({ status: "approved" });
  });

  it.each([
    "tool_input_hash = repeat('0', 64)", "tool_name = 'other_tool'", "tool_call_id = 'another-call'",
    "telegram_chat_type = 'supergroup'", "telegram_chat_id = '-1000000000'", "expected_telegram_user_id = '123'",
    "selected_option_id = 'deny'", "consumed_at = NULL", "request_kind = 'question'",
    "timed_out_at = now()",
  ])("rejects mismatched or unusable approval receipts: %s", async (change) => {
    const f = await setup();
    const row = await repository.save(f.auth, f.input);
    const input = approvalInput(row);
    const evidence = await recordDutyApproval(f, input);
    await database().query(`UPDATE telegram_hitl_approvals SET ${change} WHERE application_session_id = $1`, [evidence.applicationSessionId]);
    await expect(repository.approve(f.auth, input, evidence)).rejects.toThrow(/AGENT_TOOL_APPROVAL_EVIDENCE_INVALID/u);
    expect((await repository.get(f.auth, row.id)).status).toBe("draft");
  });

  it("rejects approvals from retired sessions and from another family's session", async () => {
    const f = await setup();
    const other = await setup();
    const row = await repository.save(f.auth, f.input);
    const input = approvalInput(row);
    const evidence = await recordDutyApproval(f, input);
    await database().query("UPDATE conversation_sessions SET retired_at = now() WHERE id = $1", [evidence.applicationSessionId]);
    await expect(repository.approve(f.auth, input, evidence)).rejects.toThrow(/AGENT_TOOL_APPROVAL_EVIDENCE_INVALID/u);
    await database().query("UPDATE conversation_sessions SET retired_at = NULL, family_id = $2 WHERE id = $1", [evidence.applicationSessionId, other.auth.familyId]);
    await expect(repository.approve(f.auth, input, evidence)).rejects.toThrow(/AGENT_TOOL_APPROVAL_EVIDENCE_INVALID/u);
  });

  it("rejects outdated drafts and accepts the latest exact approval idempotently", async () => {
    const f = await setup();
    const first = await repository.save(f.auth, f.input);
    const input = approvalInput(first);
    const evidence = await recordDutyApproval(f, input);
    const second = await repository.save(f.auth, { ...f.input, operationKey: randomUUID() });
    await expect(repository.approve(f.auth, input, evidence)).rejects.toThrow(/AGENT_DUTY_VERSION_STALE/u);
    const next = approvalInput(second);
    const receipt = await recordDutyApproval(f, next);
    const [a, b] = await Promise.all([repository.approve(f.auth, next, receipt), repository.approve(f.auth, next, receipt)]);
    expect(a).toEqual(b);
    expect(a.approvedAt).not.toBeNull();
    expect(a.status).toBe("approved");
  });

  it("replaces the effective version atomically and counts only its assignments", async () => {
    const f = await setup();
    const first = await approved(f);
    f.input.data.exceptions.push({ residentId: "r01", date: f.input.date, morning: false, evening: false });
    const second = await repository.save(f.auth, { ...f.input, operationKey: randomUUID() });
    expect(second.baseApprovedId).toBe(first.id);
    const input = approvalInput(second);
    const receipt = await recordDutyApproval(f, input);
    await repository.approve(f.auth, input, receipt);
    expect((await repository.get(f.auth, first.id)).status).toBe("superseded");
    await expect(repository.approve(f.auth, approvalInput(first), receipt)).rejects.toThrow(/AGENT_DUTY_VERSION_STALE/u);
    const history = await repository.history(f.auth, f.input.groupId, f.input.data, f.input.history);
    if (history.mode === "not_loaded") throw new Error("Expected loaded history");
    expect(history.schedules.filter((row) => row.date === f.input.date).map((row) => row.status)).toEqual(["superseded", "approved"]);
    // Check through the actual accounting module: the six new assignments add six, not twelve.
    const comparisonData = { ...f.input.data, workShifts: [
      ...f.input.data.workShifts,
      ...f.input.data.residents.filter((row) => row.workSchedule === "shift").map((row) => ({ residentId: row.id, date: "2026-11-10", state: "off" as const })),
    ] };
    const before = rankDutyCandidates(comparisonData, f.input.history, "dining", "2026-11-10");
    const after = rankDutyCandidates(comparisonData, history, "dining", "2026-11-10");
    const sum = (rows: typeof after) => rows.candidates.reduce((total, person) => total + person.load, 0);
    expect(after.candidates).toHaveLength(10);
    expect(history.schedules.filter((row) => row.date === f.input.date && row.status === "approved").flatMap((row) => row.assignments)).toHaveLength(6);
    expect(sum(after) - sum(before)).toBe(6);
  });

  it("keeps imported history under drafts, replaces it after approval, and does not resurrect it on cancellation", async () => {
    const f = await setup();
    const imported = parseDutyHistory({ mode: "imported", fromDate: "2026-10-01", schedules: [
      { id: "imported-same-date", date: f.input.date, version: 1, status: "approved", assignments: [{ residentId: "r01", objectId: "dining", credit: 99 }] },
    ] }, f.input.data);
    f.input.history = imported;
    const draft = await repository.save(f.auth, f.input);
    expect(await repository.history(f.auth, f.input.groupId, f.input.data, imported)).toEqual(imported);
    const input = approvalInput(draft);
    await repository.approve(f.auth, input, await recordDutyApproval(f, input));
    const history = await repository.history(f.auth, f.input.groupId, f.input.data, imported);
    if (history.mode === "not_loaded") throw new Error("Expected loaded history");
    expect(history.schedules.map((row) => row.id)).toEqual([draft.id]);
    await database().query("UPDATE duty_schedule_versions SET status = 'cancelled' WHERE id = $1", [draft.id]);
    const cancelled = await repository.history(f.auth, f.input.groupId, f.input.data, imported);
    if (cancelled.mode === "not_loaded") throw new Error("Expected loaded history");
    expect(cancelled.schedules).toMatchObject([{ id: draft.id, status: "cancelled" }]);
    expect(await repository.history(f.auth, f.input.groupId, f.input.data, { mode: "not_loaded" })).toEqual({ mode: "not_loaded" });
  });

  it("leaves the approved version active if the replacement has invalid approval evidence", async () => {
    const f = await setup();
    const first = await approved(f);
    const second = await repository.save(f.auth, { ...f.input, operationKey: randomUUID() });
    const input = approvalInput(second);
    await expect(repository.approve(f.auth, input, { applicationSessionId: randomUUID(), eveSessionId: "missing", toolCallId: "missing" })).rejects.toThrow(/AGENT_TOOL_APPROVAL_EVIDENCE_INVALID/u);
    expect((await repository.get(f.auth, first.id)).status).toBe("approved");
  });

  it("honors the stored completeness policy", async () => {
    const f = await setup();
    f.input.data.rules.allowIncompleteSchedules = false;
    f.input.data.exceptions.push({ residentId: "r04", date: f.input.date, morning: false, evening: false }, { residentId: "r08", date: f.input.date, morning: false, evening: false });
    const draft = await repository.save(f.auth, f.input);
    expect(draft.snapshot.draft.canApprove).toBe(false);
    const input = approvalInput(draft);
    await expect(repository.approve(f.auth, input, await recordDutyApproval(f, input))).rejects.toThrow(/AGENT_DUTY_INCOMPLETE/u);
  });

  it("keeps an archived snapshot after group deletion and prevents new approval for that group", async () => {
    const f = await setup();
    const row = await repository.save(f.auth, f.input);
    const input = approvalInput(row);
    const evidence = await recordDutyApproval(f, input);
    await database().query("DELETE FROM telegram_groups WHERE id = $1", [f.input.groupId]);
    expect(await repository.get(f.auth, row.id)).toEqual(row);
    await expect(repository.approve(f.auth, input, evidence)).rejects.toThrow(/AGENT_DUTY_GROUP_INVALID/u);
  });
});
