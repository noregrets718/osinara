/** Lean, exact review text: what was planned, what is read now, and what accepting it means. */
import { flattenDisplayText } from "../display-text.js";
import type { DutyReviewView } from "./duty-review-previews.js";
const scalar = (value: string | number | boolean) => typeof value === "string" ? JSON.stringify(value).replace(/\p{Cf}/gu, (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`) : String(value);
const explanations = {
  not_sent: "Отправка не была начата. Google не читался; можно закрыть неотправленную попытку.",
  matches_expected: "Текущие данные дежурств совпадают с ожидаемыми. Это не доказывает успешность именно прежнего запроса: данные мог изменить человек.",
  differs_from_expected: "Текущие данные дежурств отличаются от ожидаемых. Прежние правки не будут отправлены заново.",
};
export function dutyReviewText(view: DutyReviewView) {
  return [ `Операция: ${view.operationId}. Состояние при просмотре: ${view.state}.`, explanations[view.classification],
    ...view.cells.map((cell) => `${flattenDisplayText(cell.range)}: было ${scalar(cell.before)}; планировалось ${scalar(cell.after)}; сейчас ${scalar(cell.current)}.`),
    view.state === "checking" ? "Решение: закрыть неотправленную попытку. Старый исполнитель больше не сможет начать её запись." :
      "Решение: принять наблюдаемое состояние и закрыть спорную попытку с неопределённым исходом. Это не подтверждение успешной записи.",
    "После подтверждения будет сохранено решение и снята блокировка этой попытки. Другие незавершённые операции могут продолжать блокировать таблицу. Старые правки не отправляются; новая запись требует нового предпросмотра и подтверждения.",
    ...(view.state === "checking" ? [] : ["Уже принятый Google-запрос может дать поздний эффект после сетевого сбоя; сверка не гарантирует его отмену."]),
  ].join("\n");
}
