/** Model-facing edits use stable row keys and a server-selected source; confirmation carries only an ID. */
import { z } from "zod";
import { AppError } from "../app-error.js";
import { dutySheetEditSchema, dutyWritableSectionSchema } from "./duty-sheet-change.js";

export const dutyEditDialogSchema = z.object({
  action: z.enum(["read", "preview", "status"]), groupId: z.uuid().optional(),
  section: dutyWritableSectionSchema.optional(), key: z.string().min(1).max(200).optional(),
  offset: z.number().int().min(0).max(5000).optional(), edits: z.array(dutySheetEditSchema).min(1).max(10).optional(), operationId: z.uuid().optional(),
}).strict();
const actions = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read"), groupId: z.uuid(), section: dutyWritableSectionSchema, key: dutyEditDialogSchema.shape.key, offset: dutyEditDialogSchema.shape.offset }).strict(),
  z.object({ action: z.literal("preview"), groupId: z.uuid(), edits: z.array(dutySheetEditSchema).min(1).max(10) }).strict(),
  z.object({ action: z.literal("status"), operationId: z.uuid() }).strict(),
]);
export const dutyApplyPreviewSchema = z.object({ previewId: z.uuid() }).strict();
export function parseDutyEditDialog(raw: unknown) {
  const result = actions.safeParse(raw);
  if (!result.success) throw new AppError("AGENT_DUTY_EDIT_INPUT_INVALID", "read: groupId, section и необязательные key/offset; preview: groupId и edits; status: operationId. Лишние поля запрещены");
  return result.data;
}
export function parseDutyApplyPreview(raw: unknown) {
  const result = dutyApplyPreviewSchema.safeParse(raw);
  if (!result.success) throw new AppError("AGENT_DUTY_EDIT_INPUT_INVALID", "Передайте только previewId из сохранённого предпросмотра");
  return result.data;
}
