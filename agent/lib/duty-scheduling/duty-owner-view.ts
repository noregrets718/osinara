/** Bounded owner preview from stored facts only: never rereads Sheets or recalculates assignments. */
import { AppError } from "../app-error.js";
import { clipText, flattenDisplayText } from "../display-text.js";
import type { StoredDutyVersion } from "./duty-snapshot.js";

const states = { draft: "Черновик", approved: "Утверждённая версия", superseded: "Заменённая версия", cancelled: "Отменённая версия" };
const periods = { morning: "утро", evening: "вечер" };
const priorities = { least_duties: "меньшая нагрузка", longest_since_duty: "давность последнего дежурства", longest_since_object: "давность уборки этого объекта" };
const display = (value: string) => clipText(flattenDisplayText(value), 200);

export function dutyOwnerView(stored: StoredDutyVersion) {
  const { data, draft, destination } = stored.snapshot;
  // Keep the complete response reviewable; do not silently omit assignments to fit a model result.
  if (draft.requiredSlots > 150 || draft.objects.length > 50 || draft.missingShiftResidentIds.length > 150) {
    throw new AppError("AGENT_DUTY_PREVIEW_TOO_LARGE", "График слишком велик для одного просмотра. Нужен постраничный просмотр");
  }
  const names = new Map(data.residents.map((row) => [row.id, display([row.firstName, row.lastName].filter(Boolean).join(" ")) || row.id]));
  const duplicates = new Set([...names.values()].filter((name, index, rows) => rows.indexOf(name) !== index));
  const name = (id: string) => { const value = names.get(id) ?? id; return duplicates.has(value) ? `${value} (${id})` : value; };
  const objects = draft.objects.map((object) => ({
    objectId: object.objectId, name: display(object.name), people: object.people, samePeriod: object.samePeriod,
    assignments: object.assignments.map((row) => ({ ...row, name: name(row.residentId) })),
    unfilledSlots: object.unfilledSlots, unfilledReason: object.unfilledReason === null ? null : display(object.unfilledReason),
  }));
  const missingShifts = draft.missingShiftResidentIds.map((id) => ({ residentId: id, name: name(id) }));
  const criteria = data.rules.priorities.map((key) => priorities[key]);
  const lines = [
    `${states[stored.status]} на ${stored.date}, версия ${stored.version}.`,
    `Группа: ${display(destination.title ?? destination.telegramChatId)}. Часовой пояс: ${data.timezone}.`,
    `Мест: ${draft.requiredSlots}. Назначено: ${draft.filledSlots}. Не закрыто: ${draft.unfilledSlots}.`,
    `Максимум назначений на человека в день: ${data.rules.maxAssignmentsPerDay}.`,
    `Нагрузка учитывается с ${draft.accounting.countedFrom} по ${draft.accounting.windowEnd}; черновики в неё не входят.`,
    ...(draft.accounting.mode === "zero_start" ? [`Учёт начат с нуля: ${draft.accounting.fromDate}.`] : []),
    `Подбор всего графика сначала закрывает максимум мест, затем сравнивает: ${criteria.join(" → ")}.`,
  ];
  for (const object of objects) {
    lines.push(`${object.name}:`);
    for (const row of object.assignments) {
      lines.push(`— ${row.name}, ${periods[row.period]}. Нагрузка до назначения: ${row.loadBefore}; дежурств за период: ${row.dutyCountBefore}; последнее дежурство: ${row.lastDutyDate ?? "нет в истории"}; последний этот объект: ${row.lastObjectDate ?? "нет в истории"}.`);
    }
    if (object.people > 1 && object.samePeriod && object.assignments.length) lines.push("Участники назначены вместе в одном периоде.");
    if (object.unfilledSlots) lines.push(`Не закрыто мест: ${object.unfilledSlots}. ${object.unfilledReason ?? "Нужно уточнение владельца."}`);
  }
  if (missingShifts.length) lines.push(`Не загружены смены: ${missingShifts.map((row) => row.name).join(", ")}.`);
  if (!draft.canApprove) lines.push("Текущие правила запрещают утверждать этот неполный график.");
  const result = { id: stored.id, version: stored.version, status: stored.status, date: stored.date, createdAt: stored.createdAt,
    contentHash: stored.contentHash, baseApprovedId: stored.baseApprovedId, groupId: destination.groupId,
    rulesVersion: draft.rulesVersion, configuration: stored.snapshot.source ?? null,
    complete: draft.complete, canApprove: draft.canApprove, filledSlots: draft.filledSlots, requiredSlots: draft.requiredSlots,
    unfilledSlots: draft.unfilledSlots, objects, missingShifts, previewText: lines.join("\n"),
    approvalInput: stored.status === "draft" && draft.canApprove ? { id: stored.id, contentHash: stored.contentHash, expectedApprovedId: stored.baseApprovedId } : null,
    publicationPerformed: false as const, approvalPerformed: false as const };
  if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024) throw new AppError("AGENT_DUTY_PREVIEW_TOO_LARGE", "График слишком велик для одного просмотра");
  return result;
}
