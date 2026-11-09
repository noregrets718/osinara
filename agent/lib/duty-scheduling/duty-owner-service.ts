/** Root owner dialog: discover groups, prepare from the saved source, and read immutable versions. */
import type { ToolContext } from "eve/tools";
import { AppError } from "../app-error.js";
import { isScheduledSession } from "../agent-schedules/scheduled-session.js";
import { requirePrivateTelegramOwner } from "../family-context.js";
import { readConfiguredDutySheet } from "./duty-configured-sheet.js";
import { listDutyOwnerGroups } from "./duty-owner-groups.js";
import { parseDutyOwnerInput } from "./duty-owner-input.js";
import { dutyOwnerView } from "./duty-owner-view.js";
import { dutyScheduleRepository } from "./duty-schedule-repository.js";
import { hashDutyJson } from "./duty-snapshot.js";

type Dependencies = { owner: typeof requirePrivateTelegramOwner; groups: typeof listDutyOwnerGroups; load: typeof readConfiguredDutySheet; schedules: typeof dutyScheduleRepository };
export function createDutyOwnerManager(deps: Dependencies) {
  return async (raw: unknown, ctx: ToolContext) => {
    const input = parseDutyOwnerInput(raw);
    const auth = deps.owner(ctx);
    if (ctx.session.parent || isScheduledSession(ctx)) throw new AppError("AGENT_DUTY_INTERACTIVE_OWNER_REQUIRED", "Подготовка и просмотр графика доступны владельцу в обычном личном диалоге");
    ctx.abortSignal.throwIfAborted();
    if (input.action === "groups") return { groups: await deps.groups(auth) };
    if (input.action === "get") return dutyOwnerView(await deps.schedules.get(auth, input.id));
    if (input.action === "latest") return dutyOwnerView(await deps.schedules.latest(auth, input.groupId, input.date));
    if (!ctx.callId || !ctx.session.id) throw new AppError("AGENT_DUTY_CALL_CONTEXT_INVALID", "Не удалось определить устойчивый ID вызова");
    const operationKey = `duty-draft:${hashDutyJson({ sessionId: ctx.session.id, callId: ctx.callId })}`;
    const previous = await deps.schedules.findOperation(auth, operationKey);
    if (previous) {
      if (previous.date !== input.date || previous.snapshot.destination.groupId !== input.groupId) throw new AppError("AGENT_DUTY_OPERATION_CONFLICT", "Этот вызов уже сохранил график для другой группы или даты");
      return { ...dutyOwnerView(previous), reused: true };
    }
    const loaded = await deps.load(input.groupId, ctx);
    ctx.abortSignal.throwIfAborted();
    const version = await deps.schedules.save(auth, { groupId: input.groupId, date: input.date, operationKey,
      data: loaded.data, history: loaded.history,
      source: { id: loaded.configuration.id, version: loaded.configuration.version, readHash: loaded.source.contentHash } });
    return { ...dutyOwnerView(version), reused: false };
  };
}
export const manageDutyOwner = createDutyOwnerManager({ owner: requirePrivateTelegramOwner, groups: listDutyOwnerGroups, load: readConfiguredDutySheet, schedules: dutyScheduleRepository });
