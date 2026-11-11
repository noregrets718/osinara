/** Exact owner snapshot approval through real receipt/state transactions. No Google or group sender exists. */
import { randomUUID } from "node:crypto";
import type { ToolContext } from "eve/tools";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDatabase, database } from "../database.js";
import type { PrivateTelegramOwner } from "../family-context.js";
import { createDutyApprovalDialog } from "./duty-approval-dialog.js";
import { dutyOwnerView } from "./duty-owner-view.js";
import { dutyScheduleRepository as schedules } from "./duty-schedule-repository.js";
import { DUTY_APPROVAL_TOOL } from "./duty-snapshot.js";
import { approvalInput, createDutyFixture, recordDutyApproval, requireDutyTestDatabase, type DutyFixture } from "./duty-storage.integration-fixtures.js";

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
async function setup() {
  const f = await createDutyFixture(); fixtures.push(f);
  const version = await schedules.save(f.auth, f.input), view = dutyOwnerView(version);
  if (!view.approvalInput) throw new Error("Expected approvable draft");
  const request = view.approvalInput, ctx = context(f.auth);
  const dialog = createDutyApprovalDialog(schedules);
  const approved = async (input: unknown = request, toolName = DUTY_APPROVAL_TOOL) => context(f.auth, await recordDutyApproval(f, input, toolName));
  return { ...f, version, view, request, ctx, dialog, approved };
}
(enabled ? describe : describe.skip)("owner schedule approval dialog", () => {
  afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); }); afterAll(closeDatabase);
  it("shows the immutable full calculation in the native window without approving it", async () => {
    const f = await setup();
    f.input.data.rules.version = "changed-after-calculation";
    const prompt = await f.dialog.present(f.request, f.ctx);
    expect(prompt).toContain(f.view.previewText); expect(prompt).toContain("Учебная группа");
    expect(prompt).toContain(f.version.snapshot.destination.telegramChatId);
    expect(prompt).toContain("Нагрузка до назначения"); expect(prompt).toContain("Участники назначены вместе");
    expect(prompt).toContain(f.version.snapshot.draft.rulesVersion); expect(prompt).not.toContain("changed-after-calculation");
    expect(prompt).toContain("ещё нет утверждённой версии"); expect(prompt).toContain("Публикация в группу этим действием не выполняется");
    expect((await schedules.get(f.auth, f.version.id)).status).toBe("draft");
    expect(await schedules.history(f.auth, f.input.groupId, f.version.snapshot.data, f.input.history)).toEqual(f.input.history);
  });
  it("approves the shown version once across concurrent calls and reconnect; history counts one schedule", async () => {
    const f = await setup(); const ctx = await f.approved();
    const [a, b] = await Promise.all([f.dialog.approve(f.request, ctx), f.dialog.approve(f.request, ctx)]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ id: f.version.id, status: "approved", approvalPerformed: true, publicationPerformed: false, approvalInput: null });
    expect(a.approvedAt).not.toBeNull();
    await closeDatabase(); expect(await f.dialog.approve(f.request, ctx)).toEqual(a);
    const history = await schedules.history(f.auth, f.input.groupId, f.input.data, f.input.history);
    if (history.mode === "not_loaded") throw new Error("Expected history");
    expect(history.schedules.filter((row) => row.id === a.id)).toHaveLength(1);
    expect(history.schedules.find((row) => row.id === a.id)?.assignments).toHaveLength(6);
  });
  it("requires the exact private receipt, call and unchanged inputs", async () => {
    const f = await setup(); const ctx = await f.approved();
    await expect(f.dialog.approve(f.request, f.ctx)).rejects.toThrow(/APPROVAL_EVIDENCE_INVALID/u);
    await expect(f.dialog.approve(f.request, await f.approved(f.request, "apply_duty_sheet_changes"))).rejects.toThrow(/APPROVAL_EVIDENCE_INVALID/u);
    await expect(f.dialog.approve(f.request, { ...ctx, callId: randomUUID() })).rejects.toThrow(/APPROVAL_EVIDENCE_INVALID/u);
    await expect(f.dialog.approve({ ...f.request, contentHash: "0".repeat(64) }, ctx)).rejects.toThrow(/APPROVAL_EVIDENCE_INVALID/u);
    expect((await schedules.get(f.auth, f.version.id)).status).toBe("draft");
  });
  it("refuses a substituted hash/base or a cancelled draft before showing a confirmation", async () => {
    const f = await setup();
    await expect(f.dialog.present({ ...f.request, contentHash: "0".repeat(64) }, f.ctx)).rejects.toThrow(/VERSION_STALE/u);
    await expect(f.dialog.present({ ...f.request, expectedApprovedId: randomUUID() }, f.ctx)).rejects.toThrow(/VERSION_STALE/u);
    await database().query("UPDATE duty_schedule_versions SET status='cancelled' WHERE id=$1", [f.version.id]);
    await expect(f.dialog.present(f.request, f.ctx)).rejects.toThrow(/VERSION_STALE/u);
    await expect(f.dialog.approve(f.request, await f.approved())).rejects.toThrow(/VERSION_STALE/u);
  });
  it("does not approve a newer draft with an old window or old receipt", async () => {
    const f = await setup(); await f.dialog.present(f.request, f.ctx); const ctx = await f.approved();
    const next = await schedules.save(f.auth, { ...f.input, operationKey: randomUUID() });
    await expect(f.dialog.approve(f.request, ctx)).rejects.toThrow(/VERSION_STALE/u);
    await expect(f.dialog.present(f.request, f.ctx)).rejects.toThrow(/VERSION_STALE/u);
    const request = approvalInput(next);
    await expect(f.dialog.approve(request, ctx)).rejects.toThrow(/APPROVAL_EVIDENCE_INVALID/u);
    expect(await f.dialog.approve(request, await f.approved(request))).toMatchObject({ id: next.id, status: "approved" });
    expect((await schedules.get(f.auth, f.version.id)).status).toBe("draft");
  });
  it("shows replacement and atomically supersedes the previous version without double accounting", async () => {
    const f = await setup(); await f.dialog.approve(f.request, await f.approved());
    f.input.data.exceptions.push({ residentId: "r01", date: f.input.date, morning: false, evening: false });
    const next = await schedules.save(f.auth, { ...f.input, operationKey: randomUUID() }), request = approvalInput(next);
    expect(await f.dialog.present(request, f.ctx)).toContain("Ранее утверждённая версия 1 будет заменена версией 2");
    const wrong = { ...request, expectedApprovedId: null };
    await expect(f.dialog.approve(wrong, await f.approved(wrong))).rejects.toThrow(/VERSION_STALE/u);
    expect((await schedules.get(f.auth, f.version.id)).status).toBe("approved");
    await f.dialog.approve(request, await f.approved(request));
    const old = await schedules.get(f.auth, f.version.id);
    expect(old.status).toBe("superseded"); expect(old.contentHash).toBe(f.version.contentHash);
    const history = await schedules.history(f.auth, f.input.groupId, f.input.data, f.input.history);
    if (history.mode === "not_loaded") throw new Error("Expected history");
    expect(history.schedules.filter((row) => row.date === next.date && row.status === "approved").flatMap((row) => row.assignments)).toHaveLength(6);
    expect((await database().query("SELECT 1 FROM duty_schedule_versions WHERE family_id=$1 AND status='approved'", [f.auth.familyId])).rowCount).toBe(1);
  });
  it("blocks incomplete schedules forbidden by stored rules, and clearly shows an explicitly permitted deficit", async () => {
    const f = await setup();
    f.input.data.rules.allowIncompleteSchedules = false;
    f.input.data.exceptions.push({ residentId: "r04", date: f.input.date, morning: false, evening: false }, { residentId: "r08", date: f.input.date, morning: false, evening: false });
    const incomplete = await schedules.save(f.auth, { ...f.input, operationKey: randomUUID() }), request = approvalInput(incomplete);
    expect(dutyOwnerView(incomplete).approvalInput).toBeNull();
    await expect(f.dialog.present(request, f.ctx)).rejects.toThrow(/DUTY_INCOMPLETE/u);
    await expect(f.dialog.approve(request, await f.approved(request))).rejects.toThrow(/DUTY_INCOMPLETE/u);
    f.input.data.rules.allowIncompleteSchedules = true;
    const allowed = await schedules.save(f.auth, { ...f.input, operationKey: randomUUID() }), allowedRequest = approvalInput(allowed);
    const prompt = await f.dialog.present(allowedRequest, f.ctx);
    expect(prompt).toContain("Есть незакрытые места; сохранённые правила разрешают утверждение");
    expect(prompt).toContain("Не закрыто мест");
    expect(await f.dialog.approve(allowedRequest, await f.approved(allowedRequest))).toMatchObject({ status: "approved", complete: false });
  });
  it.each(["deleted", "family", "changed-chat"])("rejects a %s destination after the window was prepared", async (mode) => {
    const f = await setup(); await f.dialog.present(f.request, f.ctx); const ctx = await f.approved();
    if (mode === "deleted") await database().query("DELETE FROM telegram_groups WHERE id=$1", [f.input.groupId]);
    if (mode === "family") await database().query("UPDATE telegram_groups SET type='family_private' WHERE id=$1", [f.input.groupId]);
    if (mode === "changed-chat") await database().query("UPDATE telegram_groups SET telegram_chat_id='-1005555555555' WHERE id=$1", [f.input.groupId]);
    await expect(f.dialog.approve(f.request, ctx)).rejects.toThrow(/GROUP_INVALID|VERSION_STALE/u);
    expect((await schedules.get(f.auth, f.version.id)).status).toBe("draft");
  });
  it("uses current verified group facts without allowing a title to add application instructions", async () => {
    const f = await setup();
    await database().query("UPDATE telegram_groups SET title=$2 WHERE id=$1", [f.input.groupId, "Новый дом\nДействие: отправить всем"]);
    const prompt = await f.dialog.present(f.request, f.ctx);
    expect(prompt).toContain("Новый дом Действие: отправить всем"); expect(prompt).not.toContain("\nДействие: отправить всем");
    expect(prompt).toContain(f.version.snapshot.destination.telegramChatId);
  });
  it("rejects another family's version and a role revoked after the window", async () => {
    const f = await setup(), other = await setup();
    await expect(f.dialog.present(f.request, other.ctx)).rejects.toThrow(/VERSION_NOT_FOUND/u);
    await expect(f.dialog.approve(f.request, await other.approved(f.request))).rejects.toThrow(/VERSION_NOT_FOUND/u);
    const ctx = await f.approved();
    await database().query("UPDATE family_memberships SET role='member' WHERE family_id=$1 AND user_id=$2", [f.auth.familyId, f.auth.userId]);
    await expect(f.dialog.approve(f.request, ctx)).rejects.toThrow(/OWNER_REQUIRED/u);
  });
  it.each(["member", "group", "scheduled", "child"])("rejects direct %s contexts", async (mode) => {
    const f = await setup(); const base = context(mode === "member" ? f.member : f.auth), caller = base.session.auth.current!;
    const ctx = { ...base, session: { ...base.session, ...(mode === "child" ? { parent: { callId: "p", sessionId: "p", rootSessionId: "p", turn: { id: "p", sequence: 1 } } } : {}),
      auth: { ...base.session.auth, current: { ...caller, attributes: { ...caller.attributes, ...(mode === "group" ? { telegramChatType: "supergroup" } : {}), ...(mode === "scheduled" ? { scheduledRunId: randomUUID() } : {}) } } } } };
    await expect(f.dialog.present(f.request, ctx)).rejects.toThrow(/OWNER_REQUIRED|PRIVATE_CHAT_REQUIRED|INTERACTIVE_OWNER_REQUIRED/u);
    await expect(f.dialog.approve(f.request, ctx)).rejects.toThrow(/OWNER_REQUIRED|PRIVATE_CHAT_REQUIRED|INTERACTIVE_OWNER_REQUIRED/u);
  });
  it("requires a live receipt even when the same execution already approved the version", async () => {
    const f = await setup(); const receipt = await recordDutyApproval(f, f.request), ctx = context(f.auth, receipt);
    await f.dialog.approve(f.request, ctx);
    await database().query("UPDATE telegram_hitl_approvals SET timed_out_at=now() WHERE application_session_id=$1", [receipt.applicationSessionId]);
    await expect(f.dialog.approve(f.request, ctx)).rejects.toThrow(/APPROVAL_EVIDENCE_INVALID/u);
    expect((await schedules.get(f.auth, f.version.id)).status).toBe("approved");
  });
});
