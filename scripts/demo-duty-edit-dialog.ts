/** Isolated *_test demo: saved source → immutable rules preview → exact receipt → single fake write. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ToolContext } from "eve/tools";
import { closeDatabase } from "../agent/lib/database.js";
import { requirePrivateTelegramOwner } from "../agent/lib/family-context.js";
import { loadDutyEditApproval } from "../agent/lib/duty-scheduling/duty-edit-approval.js";
import { createDutyEditDialog } from "../agent/lib/duty-scheduling/duty-edit-dialog.js";
import { dutyEditPreviews } from "../agent/lib/duty-scheduling/duty-edit-previews.js";
import { DUTY_SHEET_WRITE_TOOL } from "../agent/lib/duty-scheduling/duty-sheet-change.js";
import { createDutySheetSource } from "../agent/lib/duty-scheduling/duty-sheet-format.js";
import { createDutySheetReader } from "../agent/lib/duty-scheduling/duty-sheet-reader.js";
import { DUTY_SOURCE_TOOL, dutySheetSourceRepository as sources } from "../agent/lib/duty-scheduling/duty-sheet-source-repository.js";
import { dutySheetWriteLog } from "../agent/lib/duty-scheduling/duty-sheet-write-log.js";
import { createDutySheetWriter } from "../agent/lib/duty-scheduling/duty-sheet-writer.js";
import { withDutyOwner } from "../agent/lib/duty-scheduling/duty-storage.js";
import { createDutyFixture, recordDutyApproval, requireDutyTestDatabase } from "../agent/lib/duty-scheduling/duty-storage.integration-fixtures.js";

requireDutyTestDatabase();
let fixture: Awaited<ReturnType<typeof createDutyFixture>> | undefined;
try {
  const f = await createDutyFixture(); fixture = f;
  const source = createDutySheetSource("duty-example-sheet", "fictional-personal-profile");
  const configure = { operationId: randomUUID(), groupId: f.input.groupId, expectedVersion: 0, source };
  await sources.save(f.auth, configure, await recordDutyApproval(f, configure, DUTY_SOURCE_TOOL));
  const remote = JSON.parse(readFileSync(new URL("../examples/duty-scheduling/sheets-example.json", import.meta.url), "utf8"));
  const context = (evidence?: Awaited<ReturnType<typeof recordDutyApproval>>): ToolContext => ({
    callId: evidence?.toolCallId ?? randomUUID(), abortSignal: new AbortController().signal,
    session: { id: evidence?.eveSessionId ?? randomUUID(), turn: { id: randomUUID(), sequence: 1 }, auth: { initiator: null, current: {
      principalId: f.auth.userId, principalType: "user", authenticator: "telegram", attributes: {
        familyId: f.auth.familyId, role: "owner", telegramChatId: f.auth.telegramChatId, telegramChatType: "private", telegramUserId: f.auth.telegramChatId,
        telegramActorKind: "telegram_user", telegramActorId: f.auth.telegramChatId, applicationSessionId: evidence?.applicationSessionId ?? randomUUID(),
      },
    } } },
  } as unknown as ToolContext);
  let writes = 0;
  const read = createDutySheetReader({ requireOwner: requirePrivateTelegramOwner, withOwner: withDutyOwner,
    execute: async () => ({ kind: "read", scope: "personal", profileRef: source.profileRef, completed: true, stdout: JSON.stringify(remote), stderr: "" }) });
  const write = createDutySheetWriter({ owner: requirePrivateTelegramOwner, read, log: dutySheetWriteLog, withOwner: withDutyOwner,
    execute: async ({ argv }) => {
      writes++;
      for (const cell of JSON.parse(argv[7]).data) {
        const match = /^'(.*)'!([A-Z])(\d+)$/u.exec(cell.range)!;
        const tab = remote.valueRanges.find((row: { range: string }) => row.range.startsWith(`'${match[1]}'!`));
        const row = Number(match[3]) - 1, column = match[2].charCodeAt(0) - 65;
        while (tab.values.length <= row) tab.values.push([]);
        while (tab.values[row].length <= column) tab.values[row].push("");
        tab.values[row][column] = cell.values[0][0];
      }
      return { kind: "mutation", scope: "personal", profileRef: source.profileRef, completed: true, stdout: "{}", stderr: "" };
    } });
  const dialog = createDutyEditDialog({ read, write, sources, previews: dutyEditPreviews, log: dutySheetWriteLog });
  const ctx = context();
  const view = await dialog.inspect({ action: "preview", groupId: f.input.groupId,
    edits: [{ action: "upsert", section: "settings", key: "lookbackDays", values: { value: 14 } }] }, ctx);
  if (!("confirmationInput" in view) || !view.confirmationInput) throw new Error("Expected edit preview");
  console.log(view.previewText);
  console.log(await loadDutyEditApproval(view.confirmationInput, ctx));
  // Fictional consumed callback only inside the isolated test database; no Telegram request.
  const approved = context(await recordDutyApproval(f, view.confirmationInput, DUTY_SHEET_WRITE_TOOL));
  const result = await dialog.apply(view.confirmationInput, approved);
  console.log(`Результат: ${result.state}; completed=${result.completed}. Отправок модели Google: ${writes}.`);
  await closeDatabase();
  const repeated = await dialog.apply(view.confirmationInput, approved);
  console.log(`Повтор после переподключения: ${repeated.state}. Отправок по-прежнему: ${writes}.`);
  console.log("Реальные Google/Telegram не вызывались. Сохранённые графики не менялись; публикации не было.");
} finally {
  try { await fixture?.cleanup(); } finally { await closeDatabase(); }
}
