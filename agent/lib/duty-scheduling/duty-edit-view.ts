/** Exact owner cell view; no truncation of an approved value and no raw source tables. */
import { flattenDisplayText } from "../display-text.js";
import type { dutyEditPreviews } from "./duty-edit-previews.js";
import type { DutySheetWriteResult } from "./duty-sheet-write-log.js";

export type DutyEditPreview = Awaited<ReturnType<typeof dutyEditPreviews.get>>;
const scalar = (value: string | number | boolean) => typeof value === "string" ? JSON.stringify(value).replace(/\p{Cf}/gu, (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`) : String(value);
export function dutyEditPreviewText(saved: DutyEditPreview) {
  return [
    `Изменений ячеек: ${saved.plan.cells.length}.`,
    ...saved.plan.cells.map((cell) => `${flattenDisplayText(saved.plan.labels[cell.range] ?? cell.range)}: ${scalar(cell.before)} → ${scalar(cell.after)}`),
    `Версия правил: ${flattenDisplayText(saved.plan.rulesBefore)} → ${flattenDisplayText(saved.plan.rulesAfter)}.`,
    "Изменения применятся к новым расчётам. Сохранённые графики сохранят свои данные и правила.",
  ].join("\n");
}
export function dutyEditResult(result: DutySheetWriteResult) {
  const messages = {
    checking: "Проверка ещё не завершена. Повторная отправка запрещена.",
    writing: "Запись начата; её исход ещё не известен. Повторная отправка запрещена.",
    applied: "Запись выполнена и проверена повторным чтением.",
    conflict: "Таблица изменилась после просмотра. Правки не отправлены; нужен новый предпросмотр и подтверждение.",
    failed: "Попытка остановлена до отправки. Проверьте причину; новая попытка требует нового предпросмотра и подтверждения.",
    unknown: "Исход записи не подтверждён. Правки могли примениться. Повторная отправка и новые записи в эту таблицу запрещены до сверки.",
    reviewed: "Спорная попытка закрыта после сверки. Это не доказательство успешной записи.",
  };
  return { operationId: result.operationId, state: result.state, completed: result.completed, retryAllowed: false as const,
    errorCode: result.errorCode, message: messages[result.state], publicationPerformed: false as const };
}
