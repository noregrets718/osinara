/** Owner-private Sheets import using the existing live Google authorization and exact-argv executor. */
import type { ToolContext } from "eve/tools";

import { AppError } from "../app-error.js";
import { requirePrivateTelegramOwner } from "../family-context.js";
import { executeGoogleWorkspace } from "../google-workspace/google-workspace-executor.js";
import { dutySheetRanges, parseDutySheetSource } from "./duty-sheet-format.js";
import { previewDutySheetImport, type DutySheetBaseline } from "./duty-sheet-import.js";
import { withDutyOwner } from "./duty-storage.js";

interface Dependencies {
  requireOwner: typeof requirePrivateTelegramOwner;
  withOwner: typeof withDutyOwner;
  execute: typeof executeGoogleWorkspace;
}

export function createDutySheetReader(dependencies: Dependencies) {
  return async (rawSource: unknown, ctx: ToolContext, baseline?: DutySheetBaseline) => {
    const owner = dependencies.requireOwner(ctx);
    const source = parseDutySheetSource(rawSource);
    const previous = baseline === undefined ? undefined : structuredClone(baseline);
    // Release the owner connection before the executor obtains its own database connections.
    // Holding both can exhaust the shared pool under concurrent reads. Recheck before returning.
    await dependencies.withOwner(owner, async () => undefined);
    const result = await dependencies.execute({
      argv: ["sheets", "spreadsheets", "values", "batchGet", "--params", JSON.stringify({
        spreadsheetId: source.spreadsheetId, ranges: dutySheetRanges(source), majorDimension: "ROWS",
        valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "FORMATTED_STRING",
      })], expectedProfileRef: source.profileRef,
    }, ctx);
    return dependencies.withOwner(owner, async () => {
      if (result.kind !== "read" || result.scope !== "personal" || result.profileRef !== source.profileRef || !result.completed || !result.stdout) {
        throw new AppError("AGENT_DUTY_SHEET_READ_INVALID", "Не удалось получить полный ответ из выбранного личного Google-профиля");
      }
      let response: unknown;
      try { response = JSON.parse(result.stdout); } catch {
        throw new AppError("AGENT_DUTY_SHEET_READ_INVALID", "Google вернул некорректный JSON вместо таблицы");
      }
      const preview = previewDutySheetImport(source, response, previous);
      return { ...preview, owner: { familyId: owner.familyId, userId: owner.userId } };
    });
  };
}

export const readDutySheet = createDutySheetReader({ requireOwner: requirePrivateTelegramOwner, withOwner: withDutyOwner, execute: executeGoogleWorkspace });
