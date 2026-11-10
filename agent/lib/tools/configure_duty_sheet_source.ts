/** Exact personal HITL confirmation followed by a fresh read and versioned source save. */
import { defineTool } from "eve/tools";
import { dutySourceDialog } from "../duty-scheduling/duty-source-dialog.js";
import { dutySourceConfirmationSchema, parseDutySourceConfirmation } from "../duty-scheduling/duty-source-dialog-input.js";

export default defineTool({
  approval: ({ toolInput }) => {
    try { parseDutySourceConfirmation(toolInput); return "user-approval"; }
    catch (error) { return { type: "denied", reason: error instanceof Error ? error.message : "Нужен свежий предпросмотр источника" }; }
  },
  description: [
    "Сохранить источник графиков уборки после точного подтверждения владельца в личном чате.",
    "Передай только confirmationInput из inspect_duty_sheet_source preview без изменений; не составляй его сам.",
    "При выполнении заново проверяются личное подтверждение, права владельца, версия настройки и содержимое таблицы.",
    "reused=true возвращает результат прежней операции, не делает старую версию текущей; актуальную настройку смотри через inspect get.",
    "Если таблица или настройка изменились, сделай новый предпросмотр и запроси новое подтверждение. После неопределённого сбоя проверь inspect get; не создавай новый operationId автоматически.",
    "Сохраняется настройка для новых графиков. Старые снимки сохраняются. Ячейки Google, утверждение графика и публикация в группу не выполняются.",
  ].join(" "),
  inputSchema: dutySourceConfirmationSchema,
  async execute(input, ctx) { return dutySourceDialog.configure(input, ctx); },
});
