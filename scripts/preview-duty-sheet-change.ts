/** Offline owner preview: exact changed cells, automatic rules version, and stale-snapshot detection. */
import { readFileSync } from "node:fs";

import { AppError } from "../agent/lib/app-error.js";
import { prepareDutySheetChange, planDutySheetWrite } from "../agent/lib/duty-scheduling/duty-sheet-change.js";
import { createDutySheetSource } from "../agent/lib/duty-scheduling/duty-sheet-format.js";

const response = JSON.parse(readFileSync(new URL("../agent/lib/duty-scheduling/fixtures/sheets-example.json", import.meta.url), "utf8"));
const source = createDutySheetSource("duty-example-sheet", "fictional-profile");
const { input, plan } = prepareDutySheetChange(source, response, [
  { action: "upsert", section: "exceptions", key: "r02/2026-11-09", values: { residentId: "r02", date: "2026-11-09", morning: false } },
  { action: "upsert", section: "settings", key: "lookbackDays", values: { value: 14 } },
]);
console.log("Предпросмотр правок. Google и база не вызываются.");
console.log(`Операция: ${input.operationId}`);
for (const cell of plan.cells) console.log(`${cell.range}: ${JSON.stringify(cell.before)} → ${JSON.stringify(cell.after)}`);
console.log(`Новая версия правил: ${plan.after.data.rules.version}`);
console.log(`Режим записи: RAW. Изменяемых ячеек: ${plan.cells.length}.`);
response.valueRanges[0].values[1][2] = "РучнаяПравка";
try {
  planDutySheetWrite(input, response);
  throw new Error("Expected a conflict");
} catch (error) {
  if (!(error instanceof AppError) || error.code !== "AGENT_DUTY_SHEET_CONFLICT") throw error;
  console.log("После ручной правки: конфликт, запись остановлена.");
}
