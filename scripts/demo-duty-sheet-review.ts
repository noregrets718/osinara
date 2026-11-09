/** Test-database-only demo: saved source, uncertain fake Google result, explicit review, no resend. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ToolContext } from "eve/tools";
import { closeDatabase } from "../agent/lib/database.js";
import { DUTY_SHEET_WRITE_TOOL, prepareDutySheetChange } from "../agent/lib/duty-scheduling/duty-sheet-change.js";
import { createDutySheetSource } from "../agent/lib/duty-scheduling/duty-sheet-format.js";
import { previewDutySheetImport } from "../agent/lib/duty-scheduling/duty-sheet-import.js";
import { createDutySheetReviewer, DUTY_SHEET_REVIEW_TOOL, type DutySheetReviewInput } from "../agent/lib/duty-scheduling/duty-sheet-review.js";
import { DUTY_SOURCE_TOOL, dutySheetSourceRepository } from "../agent/lib/duty-scheduling/duty-sheet-source-repository.js";
import { dutySheetWriteLog } from "../agent/lib/duty-scheduling/duty-sheet-write-log.js";
import { createDutySheetWriter } from "../agent/lib/duty-scheduling/duty-sheet-writer.js";
import { withDutyOwner } from "../agent/lib/duty-scheduling/duty-storage.js";
import { createDutyFixture, recordDutyApproval, requireDutyTestDatabase } from "../agent/lib/duty-scheduling/duty-storage.integration-fixtures.js";

requireDutyTestDatabase();
let family: Awaited<ReturnType<typeof createDutyFixture>> | undefined;
try {
  const f = await createDutyFixture(); family = f;
  const source = createDutySheetSource(`sheet-${randomUUID()}`, randomUUID());
  const configure = { operationId: randomUUID(), groupId: f.input.groupId, expectedVersion: 0, source };
  await dutySheetSourceRepository.save(f.auth, configure, await recordDutyApproval(f, configure, DUTY_SOURCE_TOOL));
  await closeDatabase();
  console.log(`Настройка после переподключения: версия ${(await dutySheetSourceRepository.get(f.auth, f.input.groupId)).version}`);
  const remote = JSON.parse(readFileSync(new URL("../agent/lib/duty-scheduling/fixtures/sheets-example.json", import.meta.url), "utf8"));
  remote.spreadsheetId = source.spreadsheetId;
  const read = async (selected: unknown) => ({ ...previewDutySheetImport(selected, remote), response: structuredClone(remote), owner: { familyId: f.auth.familyId, userId: f.auth.userId } });
  const ctx = { abortSignal: new AbortController().signal } as ToolContext;
  let attempts = 0;
  const writer = createDutySheetWriter({ owner: () => f.auth, read, log: dutySheetWriteLog, withOwner: withDutyOwner,
    execute: async () => { attempts++; remote.valueRanges[0].values[1][2] = "Учебная"; throw new Error("Тестовый сбой после изменения ячеек"); } });
  const { input } = prepareDutySheetChange(source, remote, [{ action: "upsert", section: "residents", key: "r01", values: { lastName: "Учебная" } }]);
  const approved = await recordDutyApproval(f, input, DUTY_SHEET_WRITE_TOOL);
  console.log(`После сбоя: ${(await writer(input, approved, ctx)).state}`);
  const reviewer = createDutySheetReviewer({ owner: () => f.auth, read, log: dutySheetWriteLog });
  const view = await reviewer.inspect(input.operationId, ctx);
  console.log(`Наблюдение: ${view.classification}; журнал остаётся ${(await dutySheetWriteLog.get(f.auth, input.operationId)).state}`);
  const resolve: DutySheetReviewInput = { operationId: input.operationId, reviewHash: view.reviewHash, decision: "accept_current", acknowledgeUncertainOutcome: true };
  const result = await reviewer.resolve(resolve, await recordDutyApproval(f, resolve, DUTY_SHEET_REVIEW_TOOL), ctx);
  console.log(`После отдельного подтверждения: ${result.state}; completed=${result.completed}`);
  await writer(input, approved, ctx);
  console.log(`Всего попыток отправки: ${attempts}. Сверка не отправляла правки.`);
} finally {
  try { await family?.cleanup(); } finally { await closeDatabase(); }
}
