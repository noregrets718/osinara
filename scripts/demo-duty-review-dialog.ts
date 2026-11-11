/** Isolated *_test demo: uncertain fake write → saved review → exact private decision → no resend. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ToolContext } from "eve/tools";
import { closeDatabase } from "../agent/lib/database.js";
import { requirePrivateTelegramOwner } from "../agent/lib/family-context.js";
import { loadDutyReviewApproval } from "../agent/lib/duty-scheduling/duty-review-approval.js";
import { createDutyReviewDialog } from "../agent/lib/duty-scheduling/duty-review-dialog.js";
import { dutyReviewPreviews } from "../agent/lib/duty-scheduling/duty-review-previews.js";
import { DUTY_SHEET_WRITE_TOOL, prepareDutySheetChange } from "../agent/lib/duty-scheduling/duty-sheet-change.js";
import { createDutySheetSource } from "../agent/lib/duty-scheduling/duty-sheet-format.js";
import { createDutySheetReader } from "../agent/lib/duty-scheduling/duty-sheet-reader.js";
import { createDutySheetReviewer, DUTY_SHEET_REVIEW_TOOL } from "../agent/lib/duty-scheduling/duty-sheet-review.js";
import { dutySheetWriteLog as log } from "../agent/lib/duty-scheduling/duty-sheet-write-log.js";
import { createDutySheetWriter } from "../agent/lib/duty-scheduling/duty-sheet-writer.js";
import { withDutyOwner } from "../agent/lib/duty-scheduling/duty-storage.js";
import { createDutyFixture, recordDutyApproval, requireDutyTestDatabase } from "../agent/lib/duty-scheduling/duty-storage.integration-fixtures.js";

requireDutyTestDatabase();
let fixture: Awaited<ReturnType<typeof createDutyFixture>> | undefined;
try {
  const f = await createDutyFixture(); fixture = f;
  const source = createDutySheetSource(`sheet-${randomUUID()}`, "fictional-personal-profile");
  const remote = JSON.parse(readFileSync(new URL("../examples/duty-scheduling/sheets-example.json", import.meta.url), "utf8"));
  remote.spreadsheetId = source.spreadsheetId;
  const context = (receipt?: Awaited<ReturnType<typeof recordDutyApproval>>): ToolContext => ({
    callId: receipt?.toolCallId ?? randomUUID(), abortSignal: new AbortController().signal,
    session: { id: receipt?.eveSessionId ?? randomUUID(), turn: { id: randomUUID(), sequence: 1 }, auth: { initiator: null, current: {
      principalId: f.auth.userId, principalType: "user", authenticator: "telegram", attributes: {
        familyId: f.auth.familyId, role: "owner", telegramChatId: f.auth.telegramChatId, telegramChatType: "private", telegramUserId: f.auth.telegramChatId,
        telegramActorKind: "telegram_user", telegramActorId: f.auth.telegramChatId, applicationSessionId: receipt?.applicationSessionId ?? randomUUID(),
      },
    } } },
  } as unknown as ToolContext);
  let attempts = 0, reads = 0;
  const read = createDutySheetReader({ requireOwner: requirePrivateTelegramOwner, withOwner: withDutyOwner,
    execute: async () => { reads++; return { kind: "read", scope: "personal", profileRef: source.profileRef, completed: true, stdout: JSON.stringify(remote), stderr: "" }; } });
  const writer = createDutySheetWriter({ owner: requirePrivateTelegramOwner, read, log, withOwner: withDutyOwner,
    execute: async () => { attempts++; remote.valueRanges[0].values[1][2] = "Учебная"; throw new Error("Тестовый timeout после применения ячейки"); } });
  const { input } = prepareDutySheetChange(source, remote, [{ action: "upsert", section: "residents", key: "r01", values: { lastName: "Учебная" } }]);
  // These consumed receipts are fictional records only inside the separate test database.
  const originalReceipt = await recordDutyApproval(f, input, DUTY_SHEET_WRITE_TOOL);
  console.log(`После сбоя: ${(await writer(input, originalReceipt, context(originalReceipt))).state}`);
  const reviewer = createDutySheetReviewer({ owner: requirePrivateTelegramOwner, read, log });
  const dialog = createDutyReviewDialog({ reviewer, previews: dutyReviewPreviews, log });
  const ctx = context();
  const pending = await dialog.inspect({ action: "list" }, ctx);
  if (!("operations" in pending) || !pending.operations) throw new Error("Expected operation list");
  console.log(`Незавершённых операций: ${pending.operations.length}`);
  const view = await dialog.inspect({ action: "inspect", operationId: input.operationId }, ctx);
  if (!("confirmationInput" in view) || !view.confirmationInput) throw new Error("Expected saved review");
  console.log(view.previewText);
  console.log((await loadDutyReviewApproval(view.confirmationInput, ctx)).prompt);
  const approved = context(await recordDutyApproval(f, view.confirmationInput, DUTY_SHEET_REVIEW_TOOL));
  const result = await dialog.resolve(view.confirmationInput, approved);
  console.log(`После решения: ${result.state}; completed=${result.completed}; resolved=${result.resolved}.`);
  const beforeReconnectReads = reads;
  await closeDatabase();
  const repeated = await dialog.resolve(view.confirmationInput, approved);
  console.log(`Повтор: ${repeated.state}; новых чтений: ${reads - beforeReconnectReads}.`);
  await writer(input, originalReceipt, context(originalReceipt));
  console.log(`Всего отправок модели Google: ${attempts}. Сверка ничего не отправляла.`);
  console.log("Реальные Google/Telegram не вызывались. Публикация графика не выполнялась.");
} finally {
  try { await fixture?.cleanup(); } finally { await closeDatabase(); }
}
