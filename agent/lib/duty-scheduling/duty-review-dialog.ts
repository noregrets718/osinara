/** Owner recovery dialog: discover, inspect and confirm a saved observation. No Google mutation dependency. */
import type { ToolContext } from "eve/tools";
import { applicationSessionId } from "../sessions/session-context.js";
import { requireInteractiveDutyOwner } from "./duty-owner-context.js";
import { parseDutyReviewInspect, parseDutyReviewResolve } from "./duty-review-input.js";
import { dutyReviewPreviews } from "./duty-review-previews.js";
import { dutyReviewText } from "./duty-review-view.js";
import { DUTY_SHEET_REVIEW_TOOL, dutySheetReviewer } from "./duty-sheet-review.js";
import { dutySheetWriteLog } from "./duty-sheet-write-log.js";
import { dutyOwnerApprovalProof, requireDutyApproval, withDutyOwner } from "./duty-storage.js";

export function createDutyReviewDialog(deps: { reviewer: typeof dutySheetReviewer; previews: typeof dutyReviewPreviews; log: typeof dutySheetWriteLog }) {
  return {
    async inspect(raw: unknown, ctx: ToolContext) {
      const input = parseDutyReviewInspect(raw), auth = requireInteractiveDutyOwner(ctx); ctx.abortSignal.throwIfAborted();
      if (input.action === "list") return deps.log.pending(auth, input.offset ?? 0);
      const snapshot = await deps.reviewer.inspect(input.operationId, ctx, input.profileRef);
      ctx.abortSignal.throwIfAborted();
      const saved = await deps.previews.save(auth, snapshot);
      return { previewId: saved.id, operationId: saved.input.operationId, state: saved.view.state, classification: saved.view.classification,
        cells: saved.view.cells, spreadsheetId: saved.view.spreadsheetId, profileRef: saved.view.profileRef, previewText: dutyReviewText(saved.view),
        confirmationInput: { previewId: saved.id }, completed: false as const, resolved: false as const, sheetWritten: false as const };
    },
    async resolve(raw: unknown, ctx: ToolContext) {
      const input = parseDutyReviewResolve(raw), auth = requireInteractiveDutyOwner(ctx); ctx.abortSignal.throwIfAborted();
      const saved = await deps.previews.get(auth, input.previewId);
      const evidence = { applicationSessionId: applicationSessionId(ctx), eveSessionId: ctx.session.id, toolCallId: ctx.callId };
      await withDutyOwner(auth, (client) => requireDutyApproval(client, auth, dutyOwnerApprovalProof(auth, raw, evidence, DUTY_SHEET_REVIEW_TOOL)));
      const result = await deps.reviewer.resolve({ ...saved.input, previewId: saved.id }, evidence, ctx);
      return { operationId: result.review.operationId, state: result.state, completed: false as const, resolved: true as const,
        classification: result.review.classification, resolvedAt: result.resolvedAt, sheetWritten: false as const, retryAllowed: false as const,
        message: "Решение сохранено: спорная попытка закрыта без повторной отправки. Это не доказательство успешной записи. Новые изменения требуют нового предпросмотра и подтверждения." };
    },
  };
}
export const dutyReviewDialog = createDutyReviewDialog({ reviewer: dutySheetReviewer, previews: dutyReviewPreviews, log: dutySheetWriteLog });
