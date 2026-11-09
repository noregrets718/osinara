/** Shows ordered candidates from fictional or supplied household/history snapshots. */
import { readFileSync } from "node:fs";

import { AppError } from "../agent/lib/app-error.js";
import { rankDutyCandidates } from "../agent/lib/duty-scheduling/duty-candidates.js";
import { parseDutyData, parseDutyDate } from "../agent/lib/duty-scheduling/duty-data.js";
import { parseDutyHistory } from "../agent/lib/duty-scheduling/duty-history.js";

try {
  const date = parseDutyDate(process.argv[2]);
  const objectId = process.argv[3];
  const dataPath = process.argv[4] ?? new URL("../examples/duty-scheduling/example.json", import.meta.url);
  const historyPath = process.argv[5] ?? new URL("../examples/duty-scheduling/history.json", import.meta.url);
  const data = parseDutyData(JSON.parse(readFileSync(dataPath, "utf8")));
  const history = parseDutyHistory(JSON.parse(readFileSync(historyPath, "utf8")), data);
  const result = rankDutyCandidates(data, history, objectId ?? "", date);
  console.log(`Кандидаты: ${objectId}, ${date}. Окно: ${result.windowStart} — ${result.windowEnd}.`);
  console.log(`Режим: ${result.mode}. Учёт с ${result.accountingFrom}.`);
  if (result.countedFrom > result.windowEnd) {
    console.log("До даты запроса ещё нет дней учёта.");
  } else if (result.countedFrom !== result.windowStart) {
    console.log(`В этом окне считаем назначения с ${result.countedFrom}.`);
  }
  console.table(result.candidates.map((candidate) => {
    const resident = data.residents.find((item) => item.id === candidate.residentId);
    return {
      ID: candidate.residentId,
      Жилец: [resident?.firstName, resident?.lastName].filter(Boolean).join(" "),
      Периоды: candidate.periods.map((period) => period === "morning" ? "Утро" : "Вечер").join(" / "),
      Дежурств: candidate.dutyCount,
      Нагрузка: candidate.load,
      Последнее: candidate.lastDutyDate ?? "Нет в истории",
      НаОбъекте: candidate.lastObjectDate ?? "Нет в истории",
    };
  }));
} catch (error) {
  console.error(error instanceof AppError ? error.message : "Не удалось прочитать корректные JSON-файлы.");
  process.exitCode = 1;
}
