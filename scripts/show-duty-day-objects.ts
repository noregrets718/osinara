/** Demonstrates required objects and executor slots for a household calendar date. */
import { readFileSync } from "node:fs";

import { AppError } from "../agent/lib/app-error.js";
import { parseDutyData, parseDutyDate } from "../agent/lib/duty-scheduling/duty-data.js";
import { getDutyObjectsForDate } from "../agent/lib/duty-scheduling/duty-day-objects.js";

try {
  const date = parseDutyDate(process.argv[2]);
  const path = process.argv[3] ?? new URL("../examples/duty-scheduling/example.json", import.meta.url);
  const data = parseDutyData(JSON.parse(readFileSync(path, "utf8")));
  const result = getDutyObjectsForDate(data.objects, date);
  console.log(`Объекты уборки на ${date}`);
  console.table(result.objects.map((object) => ({
    ID: object.objectId,
    Объект: object.name,
    Исполнителей: object.people,
    Вместе: object.samePeriod ? "Да" : "Нет",
    Периоды: object.periods.map((period) => period === "morning" ? "Утро" : "Вечер").join(" / "),
    Зачёт: object.creditPerPerson,
  })));
  console.log(`Объектов: ${result.objects.length}. Мест для исполнителей: ${result.requiredSlots}.`);
} catch (error) {
  console.error(error instanceof AppError ? error.message : "Не удалось прочитать корректный JSON-файл.");
  process.exitCode = 1;
}
