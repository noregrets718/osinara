/** Demonstrates availability on a requested day using fictional or supplied data. */
import { readFileSync } from "node:fs";

import { AppError } from "../agent/lib/app-error.js";
import { getDutyAvailability, type DutyAvailability } from "../agent/lib/duty-scheduling/duty-availability.js";
import { parseDutyData, parseDutyDate } from "../agent/lib/duty-scheduling/duty-data.js";

const labels: Record<DutyAvailability["basis"], string> = {
  five_two_workday: "5/2: рабочий день",
  five_two_day_off: "5/2: выходной",
  shift_day: "Дневная смена",
  shift_night: "Ночная смена",
  shift_recovery: "Отсыпной",
  shift_off_workday: "Сменный: выходной в будний день",
  shift_off_day_off: "Сменный: выходной в выходной день",
  missing_shift: "Смена не загружена",
  not_yet_resident: "Ещё не заселился",
  departed: "Уже выехал",
};

try {
  const date = parseDutyDate(process.argv[2]);
  const path = process.argv[3] ?? new URL("../examples/duty-scheduling/example.json", import.meta.url);
  const data = parseDutyData(JSON.parse(readFileSync(path, "utf8")));
  console.log(`Доступность на ${date} (${data.timezone})`);
  console.table(data.residents.map((resident) => {
    const result = getDutyAvailability(data, resident.id, date);
    return {
      ID: resident.id,
      Жилец: [resident.firstName, resident.lastName].filter(Boolean).join(" "),
      Утро: result.morning ? "Да" : "Нет",
      Вечер: result.evening ? "Да" : "Нет",
      Основание: labels[result.basis],
      Исключение: result.exceptionApplied ? "Да" : "Нет",
    };
  }));
} catch (error) {
  console.error(error instanceof AppError ? error.message : "Не удалось прочитать корректный JSON-файл.");
  process.exitCode = 1;
}
