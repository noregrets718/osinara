/** Offline step-7.1 preview from a captured batchGet response; never connects to Google or a database. */
import { readFileSync } from "node:fs";

import { createDutySheetSource } from "../agent/lib/duty-scheduling/duty-sheet-format.js";
import { previewDutySheetImport } from "../agent/lib/duty-scheduling/duty-sheet-import.js";

function json(path: string | URL) { return JSON.parse(readFileSync(path, "utf8")); }
const responsePath = process.argv[2] ?? new URL("../agent/lib/duty-scheduling/fixtures/sheets-example.json", import.meta.url);
const source = process.argv[3] ? json(process.argv[3]) : createDutySheetSource("duty-example-sheet", "fictional-profile");
const previous = process.argv[4] ? json(process.argv[4]) : undefined;
const preview = previewDutySheetImport(source, json(responsePath), previous);
console.log("Предпросмотр загрузки таблицы. Сохранение не выполнялось.");
console.log(`Жильцов: ${preview.counts.residents}. Объектов: ${preview.counts.objects}. Смен: ${preview.counts.workShifts}.`);
console.log(`История: ${preview.history.mode}. Графиков: ${preview.counts.schedules}. Назначений: ${preview.counts.assignments}.`);
console.log(`Версия правил: ${preview.data.rules.version}. Изменений: ${preview.changes.length}.`);
for (const change of preview.changes) console.log(`${change.kind}: ${change.section}/${change.key}`);
