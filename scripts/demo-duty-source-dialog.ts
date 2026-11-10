/** Fictional owner source preview/confirmation/draft scenario; separate *_test database only. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ToolContext } from "eve/tools";
import { closeDatabase } from "../agent/lib/database.js";
import { requirePrivateTelegramOwner } from "../agent/lib/family-context.js";
import { createConfiguredDutySheetReader } from "../agent/lib/duty-scheduling/duty-configured-sheet.js";
import { listDutyOwnerGroups } from "../agent/lib/duty-scheduling/duty-owner-groups.js";
import { createDutyOwnerManager } from "../agent/lib/duty-scheduling/duty-owner-service.js";
import { dutyScheduleRepository } from "../agent/lib/duty-scheduling/duty-schedule-repository.js";
import { createDutySheetReader } from "../agent/lib/duty-scheduling/duty-sheet-reader.js";
import { DUTY_SOURCE_TOOL, dutySheetSourceRepository } from "../agent/lib/duty-scheduling/duty-sheet-source-repository.js";
import { withDutyOwner } from "../agent/lib/duty-scheduling/duty-storage.js";
import { loadDutySourceApproval } from "../agent/lib/duty-scheduling/duty-source-approval.js";
import { createDutySourceDialog } from "../agent/lib/duty-scheduling/duty-source-dialog.js";
import { createDutyFixture, recordDutyApproval, requireDutyTestDatabase } from "../agent/lib/duty-scheduling/duty-storage.integration-fixtures.js";

requireDutyTestDatabase();
let fixture: Awaited<ReturnType<typeof createDutyFixture>> | undefined;
try {
  const f = await createDutyFixture(); fixture = f;
  const profileRef = "fictional-personal-profile";
  const remote = JSON.parse(readFileSync(new URL("../examples/duty-scheduling/sheets-example.json", import.meta.url), "utf8"));
  let reads = 0;
  // Only the Google transport is fictional; the reader and role/receipt SQL checks remain real.
  const read = createDutySheetReader({ requireOwner: requirePrivateTelegramOwner, withOwner: withDutyOwner,
    execute: async () => { reads++; return { kind: "read", scope: "personal", profileRef, completed: true, stdout: JSON.stringify(remote), stderr: "", command: "fictional-read" }; } });
  const context = (evidence?: Awaited<ReturnType<typeof recordDutyApproval>>): ToolContext => ({
    callId: evidence?.toolCallId ?? randomUUID(), abortSignal: new AbortController().signal,
    session: { id: evidence?.eveSessionId ?? randomUUID(), turn: { id: randomUUID(), sequence: 1 },
      auth: { initiator: null, current: { principalId: f.auth.userId, principalType: "user", authenticator: "telegram", attributes: {
        familyId: f.auth.familyId, role: "owner", telegramChatType: "private", telegramChatId: f.auth.telegramChatId,
        telegramUserId: f.auth.telegramChatId, telegramActorKind: "telegram_user", telegramActorId: f.auth.telegramChatId,
        applicationSessionId: evidence?.applicationSessionId ?? randomUUID(),
      } } } },
  } as unknown as ToolContext);
  const ctx = context();
  const dialog = createDutySourceDialog({ read, sources: dutySheetSourceRepository });
  const preview = await dialog.inspect({ action: "preview", groupId: f.input.groupId, spreadsheetId: "duty-example-sheet", profileRef }, ctx);
  if (!("confirmationInput" in preview) || !preview.confirmationInput) throw new Error("Expected source preview");
  console.log(preview.previewText);
  console.log(await loadDutySourceApproval(preview.confirmationInput, ctx));
  // Simulates the consumed Telegram callback in *_test; never asks a real person or sends messages.
  const approvedCtx = context(await recordDutyApproval(f, preview.confirmationInput, DUTY_SOURCE_TOOL));
  const saved = await dialog.configure(preview.confirmationInput, approvedCtx);
  console.log(`Сохранена настройка: версия ${saved.configuration.version}. Проверенных чтений: ${reads}.`);
  await closeDatabase();
  const replay = await dialog.configure(preview.confirmationInput, approvedCtx);
  console.log(`Повтор после переподключения: reused=${replay.reused}; чтений по-прежнему ${reads}.`);
  const load = createConfiguredDutySheetReader({ owner: requirePrivateTelegramOwner, read, sources: dutySheetSourceRepository });
  const manage = createDutyOwnerManager({ owner: requirePrivateTelegramOwner, groups: listDutyOwnerGroups, load, schedules: dutyScheduleRepository });
  const draft = await manage({ action: "prepare", groupId: f.input.groupId, date: "2026-11-09" }, context());
  if (!("previewText" in draft)) throw new Error("Expected saved duty draft");
  console.log(draft.previewText);
  console.log("Реальные Google/Telegram не вызывались; публикация и утверждение графика не выполнялись.");
} finally {
  try { await fixture?.cleanup(); } finally { await closeDatabase(); }
}
