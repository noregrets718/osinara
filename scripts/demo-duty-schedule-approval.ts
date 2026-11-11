/** Separate *_test database only: frozen draft → native prompt → exact receipt → approval and replacement. */
import { randomUUID } from "node:crypto";
import type { ToolContext } from "eve/tools";
import { closeDatabase } from "../agent/lib/database.js";
import { dutyApprovalDialog } from "../agent/lib/duty-scheduling/duty-approval-dialog.js";
import { dutyOwnerView } from "../agent/lib/duty-scheduling/duty-owner-view.js";
import { dutyScheduleRepository as schedules } from "../agent/lib/duty-scheduling/duty-schedule-repository.js";
import { createDutyFixture, recordDutyApproval, requireDutyTestDatabase } from "../agent/lib/duty-scheduling/duty-storage.integration-fixtures.js";

requireDutyTestDatabase();
let fixture: Awaited<ReturnType<typeof createDutyFixture>> | undefined;
try {
  const f = await createDutyFixture(); fixture = f;
  const context = (receipt?: Awaited<ReturnType<typeof recordDutyApproval>>): ToolContext => ({
    callId: receipt?.toolCallId ?? randomUUID(), abortSignal: new AbortController().signal,
    session: { id: receipt?.eveSessionId ?? randomUUID(), turn: { id: randomUUID(), sequence: 1 }, auth: { initiator: null, current: {
      principalId: f.auth.userId, principalType: "user", authenticator: "telegram", attributes: {
        familyId: f.auth.familyId, role: "owner", telegramChatId: f.auth.telegramChatId, telegramChatType: "private", telegramUserId: f.auth.telegramChatId,
        telegramActorKind: "telegram_user", telegramActorId: f.auth.telegramChatId, applicationSessionId: receipt?.applicationSessionId ?? randomUUID(),
      },
    } } },
  } as unknown as ToolContext);
  const draft = await schedules.save(f.auth, f.input), request = dutyOwnerView(draft).approvalInput;
  if (!request) throw new Error("Expected approvable draft");
  console.log(await dutyApprovalDialog.present(request, context()));
  // Only a fictional consumed callback in the isolated database; no real Telegram messages.
  const approvedCtx = context(await recordDutyApproval(f, request));
  const first = await dutyApprovalDialog.approve(request, approvedCtx);
  console.log(`Утверждена версия ${first.version}; status=${first.status}; publicationPerformed=${first.publicationPerformed}.`);
  await closeDatabase();
  const repeated = await dutyApprovalDialog.approve(request, approvedCtx);
  console.log(`Повтор после переподключения: та же версия и время — ${repeated.id === first.id && repeated.approvedAt === first.approvedAt}.`);
  f.input.data.exceptions.push({ residentId: "r01", date: f.input.date, morning: false, evening: false });
  const replacement = await schedules.save(f.auth, { ...f.input, operationKey: randomUUID() }), next = dutyOwnerView(replacement).approvalInput;
  if (!next) throw new Error("Expected approvable replacement");
  console.log(await dutyApprovalDialog.present(next, context()));
  await dutyApprovalDialog.approve(next, context(await recordDutyApproval(f, next)));
  const history = await schedules.history(f.auth, f.input.groupId, f.input.data, f.input.history);
  if (history.mode === "not_loaded") throw new Error("Expected loaded history");
  const effective = history.schedules.filter((row) => row.date === f.input.date && row.status === "approved");
  console.log(`После замены: старая версия ${(await schedules.get(f.auth, first.id)).status}; действующих версий: ${effective.length}; назначений: ${effective.flatMap((row) => row.assignments).length}.`);
  console.log("Google/Telegram не вызывались; публикации в группу не было.");
} finally {
  try { await fixture?.cleanup(); } finally { await closeDatabase(); }
}
