/** Native confirmation renders the immutable server preview, never model-supplied before/after values. */
import type { SessionContext } from "eve/context";
import { approvalFact, buildApprovalMessage, sanitizeApprovalLine } from "../telegram-hitl/approval-message.js";
import { dutyEditPreviews } from "./duty-edit-previews.js";
import { parseDutyApplyPreview } from "./duty-edit-input.js";
import { dutyEditPreviewText } from "./duty-edit-view.js";
import { requireInteractiveDutyOwner } from "./duty-owner-context.js";
import { withDutyOwner } from "./duty-storage.js";
import { requireDutyWriteBinding } from "./duty-write-binding.js";

export function createDutyEditApproval(previews: typeof dutyEditPreviews) {
  return async (raw: unknown, ctx: Pick<SessionContext, "session">) => {
    const { previewId } = parseDutyApplyPreview(raw); const auth = requireInteractiveDutyOwner(ctx);
    const saved = await previews.get(auth, previewId);
    const group = await withDutyOwner(auth, async (client) => {
      await requireDutyWriteBinding(client, auth, saved.input);
      const result = await client.query<{ title: string; telegram_chat_id: string }>("SELECT title, telegram_chat_id FROM telegram_groups WHERE id=$1", [saved.input.binding!.groupId]);
      return result.rows[0];
    });
    return buildApprovalMessage({ actionLabel: "изменить данные и правила дежурств в Google Sheets",
      facts: [ ...approvalFact("Группа", `${group.title} (${group.telegram_chat_id})`),
        ...approvalFact("Таблица", `https://docs.google.com/spreadsheets/d/${saved.input.source.spreadsheetId}/edit`),
        ...approvalFact("Личный Google-профиль", saved.input.source.profileRef) ],
      section: { title: "Подтверждаемые изменения:", lines: dutyEditPreviewText(saved).split("\n").map(sanitizeApprovalLine) },
      consequence: "Эти ячейки будут записаны в таблицу после повторной проверки. Сохранённые графики не изменятся. При неясном исходе автоматического повтора не будет: потребуется сверка.",
    });
  };
}
export const loadDutyEditApproval = createDutyEditApproval(dutyEditPreviews);
