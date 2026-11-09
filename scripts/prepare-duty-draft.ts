/** Local, unsaved draft from fictional or supplied snapshots; no messages are sent. */
import { readFileSync } from "node:fs";

import { AppError } from "../agent/lib/app-error.js";
import { prepareDutyDraft } from "../agent/lib/duty-scheduling/duty-allocation.js";
import { parseDutyData, parseDutyDate } from "../agent/lib/duty-scheduling/duty-data.js";
import { parseDutyHistory } from "../agent/lib/duty-scheduling/duty-history.js";

try {
  const date = parseDutyDate(process.argv[2]);
  const dataPath = process.argv[3] ?? new URL("../agent/lib/duty-scheduling/fixtures/example.json", import.meta.url);
  const historyPath = process.argv[4] ?? new URL("../agent/lib/duty-scheduling/fixtures/history.json", import.meta.url);
  const data = parseDutyData(JSON.parse(readFileSync(dataPath, "utf8")));
  const history = parseDutyHistory(JSON.parse(readFileSync(historyPath, "utf8")), data);
  const draft = prepareDutyDraft(data, history, date);
  console.log(`Черновик на ${date}. Правила: ${draft.rulesVersion}. Учёт с ${draft.accounting.fromDate}.`);
  console.table(draft.objects.flatMap((object) => {
    const rows = object.assignments.map((assignment) => {
      const resident = data.residents.find((item) => item.id === assignment.residentId);
      return {
        Объект: object.name, Период: assignment.period === "morning" ? "Утро" : "Вечер",
        Жилец: [resident?.firstName, resident?.lastName].filter(Boolean).join(" "),
        НагрузкаДо: String(assignment.loadBefore), МестоВРейтинге: String(assignment.rank),
      };
    });
    if (object.unfilledSlots > 0) rows.push({ Объект: object.name, Период: "—", Жилец: `Не назначены: ${object.unfilledSlots}`, НагрузкаДо: "—", МестоВРейтинге: "—" });
    return rows;
  }));
  console.log(`Мест: ${draft.requiredSlots}. Назначено: ${draft.filledSlots}. Не закрыто: ${draft.unfilledSlots}.`);
  console.log(`По правилу полноты допустим к утверждению: ${draft.canApprove ? "Да" : "Нет"}.`);
  if (draft.missingShiftResidentIds.length > 0) {
    const missing = data.residents.filter((resident) => draft.missingShiftResidentIds.includes(resident.id))
      .map((resident) => [resident.firstName, resident.lastName].filter(Boolean).join(" "));
    console.log(`Нужны смены на дату: ${missing.join(", ")}.`);
  }
} catch (error) {
  console.error(error instanceof AppError ? error.message : "Не удалось прочитать корректные JSON-файлы.");
  process.exitCode = 1;
}
