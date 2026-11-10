/** Trusted source confirmation facts from the exact tool input and the live owner/group check. */
import type { SessionContext } from "eve/context";
import { AppError } from "../app-error.js";
import { approvalFact, buildApprovalMessage } from "../telegram-hitl/approval-message.js";
import { requireInteractiveDutyOwner } from "./duty-owner-context.js";
import { dutySheetSections } from "./duty-sheet-format.js";
import { dutySheetSourceRepository } from "./duty-sheet-source-repository.js";
import { parseDutySourceConfirmation } from "./duty-source-dialog-input.js";

export function createDutySourceApproval(sources: typeof dutySheetSourceRepository) {
  return async (raw: unknown, ctx: Pick<SessionContext, "session">) => {
    const input = parseDutySourceConfirmation(raw);
    const state = await sources.inspect(requireInteractiveDutyOwner(ctx), input.groupId);
    if ((state.configuration?.version ?? 0) !== input.expectedVersion) throw new AppError("AGENT_DUTY_SOURCE_VERSION_STALE", "Настройка уже изменилась. Сделайте новый предпросмотр");
    return buildApprovalMessage({
      actionLabel: "сохранить источник графиков уборки",
      facts: [
        ...approvalFact("Группа", `${state.group.title} (${state.group.telegramChatId})`),
        ...approvalFact("Новая таблица", `https://docs.google.com/spreadsheets/d/${input.source.spreadsheetId}/edit`),
        ...approvalFact("Личный Google-профиль", input.source.profileRef),
        ...approvalFact("Предыдущая таблица", state.configuration ? `https://docs.google.com/spreadsheets/d/${state.configuration.source.spreadsheetId}/edit` : "не настроена"),
        ...approvalFact("Предыдущий Google-профиль", state.configuration?.source.profileRef ?? "не настроен"),
        ...approvalFact("Версия настройки", `${input.expectedVersion} → ${input.expectedVersion + 1}`),
        ...approvalFact("Стандартные листы", dutySheetSections.map((section) => input.source.mapping[section].sheet).join(", ")),
      ],
      consequence: "Новые графики этой группы будут загружать жильцов, смены, историю и правила из выбранного источника. Старые снимки сохранятся. Ячейки таблицы и сообщения группы не изменятся. Перед сохранением таблица будет проверена повторно; изменение потребует нового предпросмотра и подтверждения.",
    });
  };
}
export const loadDutySourceApproval = createDutySourceApproval(dutySheetSourceRepository);
