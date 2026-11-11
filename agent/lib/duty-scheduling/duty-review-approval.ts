/** Trusted confirmation of a stored observation. The original operation, not the current source, is the subject. */
import type { SessionContext } from "eve/context";
import { AppError } from "../app-error.js";
import { approvalFact, buildApprovalMessage, sanitizeApprovalLine } from "../telegram-hitl/approval-message.js";
import { requireInteractiveDutyOwner } from "./duty-owner-context.js";
import { parseDutyReviewResolve } from "./duty-review-input.js";
import { dutyReviewPreviews } from "./duty-review-previews.js";
import { dutyReviewText } from "./duty-review-view.js";
import { dutySheetWriteLog } from "./duty-sheet-write-log.js";

export function createDutyReviewApproval(deps: { previews: typeof dutyReviewPreviews; log: typeof dutySheetWriteLog }) {
  return async (raw: unknown, ctx: Pick<SessionContext, "session">) => {
    const { previewId } = parseDutyReviewResolve(raw), auth = requireInteractiveDutyOwner(ctx);
    const saved = await deps.previews.get(auth, previewId);
    const record = await deps.log.reviewRecord(auth, saved.input.operationId);
    if (record.state !== saved.view.state || record.request_hash !== saved.view.requestHash) throw new AppError("AGENT_DUTY_SHEET_REVIEW_STALE", "Операция уже изменилась. Повторите просмотр её состояния");
    return { approveLabel: saved.input.decision === "cancel_unstarted" ? "Закрыть неотправленную попытку" : "Принять состояние и закрыть попытку",
      prompt: buildApprovalMessage({ actionLabel: "закрыть спорную попытку записи дежурств после сверки",
        facts: [ ...approvalFact("Таблица исходной операции", `https://docs.google.com/spreadsheets/d/${saved.view.spreadsheetId}/edit`),
          ...approvalFact("Личный профиль для сверки", saved.view.profileRef),
          ...approvalFact("Личный профиль исходной операции", record.input.source.profileRef) ],
        section: { title: "Сохранённый результат просмотра:", lines: dutyReviewText(saved.view).split("\n").map(sanitizeApprovalLine) },
        consequence: "Будет сохранено решение владельца и состояние reviewed, а не applied. Старые правки не отправятся. Перед решением состояние проверяется заново; его изменение потребует нового просмотра и подтверждения.",
      }) };
  };
}
export const loadDutyReviewApproval = createDutyReviewApproval({ previews: dutyReviewPreviews, log: dutySheetWriteLog });
