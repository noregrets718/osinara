/** Load a group's saved source privately, rejecting a source switched during the network read. */
import type { ToolContext } from "eve/tools";
import { AppError } from "../app-error.js";
import { requirePrivateTelegramOwner } from "../family-context.js";
import { readDutySheet } from "./duty-sheet-reader.js";
import { dutySheetSourceRepository } from "./duty-sheet-source-repository.js";

export function createConfiguredDutySheetReader(deps: { owner: typeof requirePrivateTelegramOwner; read: typeof readDutySheet; sources: typeof dutySheetSourceRepository }) {
  return async (groupId: string, ctx: ToolContext) => {
    const auth = deps.owner(ctx);
    const config = await deps.sources.get(auth, groupId);
    const loaded = await deps.read(config.source, ctx);
    if ((await deps.sources.get(auth, groupId)).id !== config.id) throw new AppError("AGENT_DUTY_SOURCE_VERSION_STALE", "Источник изменился во время чтения. Загрузите данные заново");
    return { ...loaded, configuration: { id: config.id, version: config.version, groupId } };
  };
}
export const readConfiguredDutySheet = createConfiguredDutySheetReader({ owner: requirePrivateTelegramOwner, read: readDutySheet, sources: dutySheetSourceRepository });
