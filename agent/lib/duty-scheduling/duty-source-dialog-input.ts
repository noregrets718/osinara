/** Exact read/preview and confirmation contracts. The initial dialog uses the standard template. */
import { z } from "zod";
import { AppError } from "../app-error.js";
import { createDutySheetSource, dutySheetSourceSchema } from "./duty-sheet-format.js";
import { hashDutyJson } from "./duty-snapshot.js";

export const dutySourceDialogSchema = z.object({
  action: z.enum(["get", "preview"]), groupId: z.uuid(),
  spreadsheetId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u).optional().describe("ID таблицы из ссылки владельца"),
  profileRef: z.string().min(1).max(300).optional().describe("Личный profileRef из результата Google-инструмента; не придумывать"),
}).strict();
const reads = z.discriminatedUnion("action", [
  z.object({ action: z.literal("get"), groupId: z.uuid() }).strict(),
  dutySourceDialogSchema.extend({ action: z.literal("preview"), spreadsheetId: dutySourceDialogSchema.shape.spreadsheetId.unwrap(), profileRef: dutySourceDialogSchema.shape.profileRef.unwrap() }),
]);
export const dutySourceConfirmationSchema = z.object({
  operationId: z.uuid(), groupId: z.uuid(), expectedVersion: z.number().int().nonnegative(),
  source: dutySheetSourceSchema, readHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export function parseDutySourceDialog(raw: unknown) {
  const result = reads.safeParse(raw);
  if (!result.success) throw new AppError("AGENT_DUTY_SOURCE_INPUT_INVALID", "get: только action и groupId; preview: action, groupId, spreadsheetId и profileRef");
  return result.data;
}
export function parseDutySourceConfirmation(raw: unknown) {
  const result = dutySourceConfirmationSchema.safeParse(raw);
  if (!result.success) throw new AppError("AGENT_DUTY_SOURCE_INPUT_INVALID", "Передайте confirmationInput из свежего предпросмотра без изменений");
  const { source } = result.data;
  if (hashDutyJson(source) !== hashDutyJson(createDutySheetSource(source.spreadsheetId, source.profileRef))) {
    throw new AppError("AGENT_DUTY_SOURCE_INPUT_INVALID", "В этом шаге диалог поддерживает только стандартный шаблон листов и столбцов");
  }
  return result.data;
}
