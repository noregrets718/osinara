/** Local check of decoded duty input; no Telegram, database or Google connection. */
import { readFileSync } from "node:fs";

import { AppError } from "../agent/lib/app-error.js";
import { parseDutyData } from "../agent/lib/duty-scheduling/duty-data.js";

try {
  const path = process.argv[2] ?? new URL("../examples/duty-scheduling/example.json", import.meta.url);
  const data = parseDutyData(JSON.parse(readFileSync(path, "utf8")));
  const shiftWorkers = data.residents.filter((resident) => resident.workSchedule === "shift").length;
  console.log([
    "Данные дежурств корректны.",
    `Жильцы: ${data.residents.length} (сменных: ${shiftWorkers})`,
    `Объекты уборки: ${data.objects.length}`,
    `Записи смен: ${data.workShifts.length}`,
    `Версия правил: ${data.rules.version}`,
    `Часовой пояс: ${data.timezone}`,
  ].join("\n"));
} catch (error) {
  console.error(error instanceof AppError ? error.message : "Не удалось прочитать корректный JSON-файл.");
  process.exitCode = 1;
}
