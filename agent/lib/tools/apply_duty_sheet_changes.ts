/** A single approved write of an immutable owner preview. No source, cells or edits in model arguments. */
import { defineTool } from "eve/tools";
import { dutyEditDialog } from "../duty-scheduling/duty-edit-dialog.js";
import { dutyApplyPreviewSchema, parseDutyApplyPreview } from "../duty-scheduling/duty-edit-input.js";
export default defineTool({
  approval: ({ toolInput }) => {
    try { parseDutyApplyPreview(toolInput); return "user-approval"; }
    catch (error) { return { type: "denied", reason: error instanceof Error ? error.message : "Нужен сохранённый предпросмотр" }; }
  },
  description: [
    "Записать в Google Sheets точные правки дежурств из сохранённого предпросмотра после личного подтверждения владельца.",
    "Передай только confirmationInput из inspect_duty_sheet_changes preview. Источник, поля и значения подставляет сервер из неизменяемого снимка.",
    "completed=true и state=applied означают проверенную запись. Это не утверждение и не публикация графика.",
    "При conflict/failed исправь причину и запроси новый предпросмотр и согласие. При unknown/checking/writing остановись: исход не подтверждён, автоматический повтор и новая обходная операция запрещены. Сначала status, затем сверка.",
    "Повтор с тем же previewId возвращает журнал прежней попытки без повторной отправки. Сохранённые графики остаются прежними; новые расчёты прочитают актуальную таблицу.",
  ].join(" "),
  inputSchema: dutyApplyPreviewSchema,
  async execute(input, ctx) { return dutyEditDialog.apply(input, ctx); },
});
