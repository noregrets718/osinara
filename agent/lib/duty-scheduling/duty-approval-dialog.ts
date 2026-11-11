/** Private exact-version approval. The frozen calculation is shown and approved without Google or group delivery. */
import type { SessionContext } from "eve/context";
import type { ToolContext } from "eve/tools";
import { AppError } from "../app-error.js";
import { applicationSessionId } from "../sessions/session-context.js";
import { approvalFact, buildApprovalMessage, sanitizeApprovalLine } from "../telegram-hitl/approval-message.js";
import { requireInteractiveDutyOwner } from "./duty-owner-context.js";
import { dutyOwnerView } from "./duty-owner-view.js";
import { dutyScheduleRepository } from "./duty-schedule-repository.js";
import { dutyApprovalInputSchema } from "./duty-snapshot.js";
import { dutyApprovalProof, requireDutyApproval, withDutyOwner } from "./duty-storage.js";

export function parseDutyApprovalRequest(raw: unknown) {
  const result = dutyApprovalInputSchema.safeParse(raw);
  if (!result.success) throw new AppError("AGENT_DUTY_APPROVAL_INPUT_INVALID", "Передайте только approvalInput из сохранённого черновика: id, contentHash и expectedApprovedId");
  return result.data;
}
export function createDutyApprovalDialog(schedules: typeof dutyScheduleRepository) {
  return {
    async present(raw: unknown, ctx: Pick<SessionContext, "session">) {
      const input = parseDutyApprovalRequest(raw), auth = requireInteractiveDutyOwner(ctx);
      const preview = await schedules.approvalPreview(auth, input);
      const view = dutyOwnerView(preview.version);
      return buildApprovalMessage({ actionLabel: "утвердить конкретную версию графика дежурств",
        facts: [ ...approvalFact("Группа", `${preview.group.title} (${preview.group.telegramChatId})`),
          ...approvalFact("Версия правил", view.rulesVersion),
          ...approvalFact("Полнота", view.complete ? "Все места закрыты" : "Есть незакрытые места; сохранённые правила разрешают утверждение"),
          ...approvalFact("Замена", preview.previousVersion === null ? "В архиве агента на эту дату ещё нет утверждённой версии" : `Ранее утверждённая версия ${preview.previousVersion} будет заменена версией ${view.version}`) ],
        section: { title: "Сохранённый график для утверждения:", lines: view.previewText.split("\n").map(sanitizeApprovalLine) },
        consequence: "Будет утверждена именно показанная версия без пересчёта. Её назначения учитываются в нагрузке для новых расчётов; при замене прежняя версия перестаёт учитываться. Публикация в группу этим действием не выполняется. Если появился новый черновик или изменилась утверждённая версия, потребуется новое подтверждение.",
      });
    },
    async approve(raw: unknown, ctx: ToolContext) {
      const input = parseDutyApprovalRequest(raw), auth = requireInteractiveDutyOwner(ctx); ctx.abortSignal.throwIfAborted();
      const evidence = { applicationSessionId: applicationSessionId(ctx), eveSessionId: ctx.session.id, toolCallId: ctx.callId };
      await withDutyOwner(auth, (client) => requireDutyApproval(client, auth, dutyApprovalProof(auth, input, evidence)));
      const stored = await schedules.approve(auth, input, evidence);
      return { ...dutyOwnerView(stored), approvedAt: stored.approvedAt, approvalPerformed: true as const,
        message: "Показанная версия утверждена и учитывается в нагрузке. Публикация в группу ещё не выполнялась этим действием." };
    },
  };
}
export const dutyApprovalDialog = createDutyApprovalDialog(dutyScheduleRepository);
