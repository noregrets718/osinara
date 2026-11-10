/** Owner dialog over the saved group source, immutable previews and the existing single-attempt writer. */
import type { ToolContext } from "eve/tools";
import { AppError } from "../app-error.js";
import { applicationSessionId } from "../sessions/session-context.js";
import { dutyEditPreviews } from "./duty-edit-previews.js";
import { parseDutyApplyPreview, parseDutyEditDialog } from "./duty-edit-input.js";
import { dutyEditPreviewText, dutyEditResult } from "./duty-edit-view.js";
import { requireInteractiveDutyOwner } from "./duty-owner-context.js";
import { DUTY_SHEET_WRITE_TOOL, dutySheetRowKey, prepareDutySheetChange } from "./duty-sheet-change.js";
import { readDutySheetTables } from "./duty-sheet-format.js";
import { readDutySheet } from "./duty-sheet-reader.js";
import { dutySheetSourceRepository } from "./duty-sheet-source-repository.js";
import { dutySheetWriteLog } from "./duty-sheet-write-log.js";
import { writeDutySheet } from "./duty-sheet-writer.js";
import { dutyOwnerApprovalProof, requireDutyApproval, withDutyOwner } from "./duty-storage.js";

export function createDutyEditDialog(deps: { read: typeof readDutySheet; sources: typeof dutySheetSourceRepository; previews: typeof dutyEditPreviews; write: typeof writeDutySheet; log: typeof dutySheetWriteLog }) {
  return {
    async inspect(raw: unknown, ctx: ToolContext) {
      const input = parseDutyEditDialog(raw); const auth = requireInteractiveDutyOwner(ctx);
      ctx.abortSignal.throwIfAborted();
      if (input.action === "status") return dutyEditResult(await deps.log.get(auth, input.operationId));
      const config = await deps.sources.get(auth, input.groupId);
      const loaded = await deps.read(config.source, ctx, undefined, input.action === "preview" ? { formulas: true } : undefined);
      ctx.abortSignal.throwIfAborted();
      if ((await deps.sources.get(auth, input.groupId)).id !== config.id) throw new AppError("AGENT_DUTY_SOURCE_VERSION_STALE", "Источник изменился во время чтения. Прочитайте данные заново");
      const tables = readDutySheetTables(config.source, loaded.response);
      if (input.action === "read") {
        const rows = tables.tables[input.section].map((row) => ({ key: dutySheetRowKey(input.section, row), values: row.cells })).filter((row) => !input.key || row.key === input.key);
        const offset = input.offset ?? 0; const page = rows.slice(offset, offset + 50);
        const result = { groupId: input.groupId, section: input.section, sourceVersion: config.version, rows: page, total: rows.length, nextOffset: offset + page.length < rows.length ? offset + page.length : null };
        if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024) throw new AppError("AGENT_DUTY_PREVIEW_TOO_LARGE", "Уточните чтение постоянным ключом строки");
        return result;
      }
      const { input: change, plan } = prepareDutySheetChange(config.source, loaded.response, input.edits);
      const labels = Object.fromEntries(plan.cells.map((cell) => {
        const match = /^'(.*)'!([A-Z])(\d+)$/u.exec(cell.range)!;
        const tab = tables.response.valueRanges.find((row) => row.range.startsWith(`'${match[1]}'!`) || row.range.startsWith(`${match[1].replaceAll("''", "'")}!`));
        const header = tab?.values[0]?.[match[2].charCodeAt(0) - 65] ?? match[2];
        return [cell.range, `${match[1].replaceAll("''", "'")}, строка ${match[3]}, ${header} (${cell.range})`];
      }));
      const saved = await deps.previews.save(auth, { ...change, binding: { groupId: input.groupId, id: config.id, version: config.version } },
        { cells: plan.cells, labels, expectedDataHash: plan.expectedDataHash, rulesBefore: loaded.data.rules.version, rulesAfter: plan.after.data.rules.version });
      return { previewId: saved.id, operationId: saved.id, confirmationInput: { previewId: saved.id }, previewText: dutyEditPreviewText(saved), cells: saved.plan.cells, sheetWritten: false as const };
    },
    async apply(raw: unknown, ctx: ToolContext) {
      const request = parseDutyApplyPreview(raw); const auth = requireInteractiveDutyOwner(ctx);
      ctx.abortSignal.throwIfAborted();
      const saved = await deps.previews.get(auth, request.previewId);
      const evidence = { applicationSessionId: applicationSessionId(ctx), eveSessionId: ctx.session.id, toolCallId: ctx.callId };
      await withDutyOwner(auth, (client) => requireDutyApproval(client, auth, dutyOwnerApprovalProof(auth, raw, evidence, DUTY_SHEET_WRITE_TOOL)));
      return dutyEditResult(await deps.write({ ...saved.input, previewId: saved.id }, evidence, ctx));
    },
  };
}
export const dutyEditDialog = createDutyEditDialog({ read: readDutySheet, sources: dutySheetSourceRepository, previews: dutyEditPreviews, write: writeDutySheet, log: dutySheetWriteLog });
