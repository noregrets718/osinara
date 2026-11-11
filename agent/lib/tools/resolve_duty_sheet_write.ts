/** An exact owner decision closes a reviewed attempt; no provider mutation is available here. */
import { defineTool } from "eve/tools";
import { dutyReviewDialog } from "../duty-scheduling/duty-review-dialog.js";
import { dutyReviewResolveSchema, parseDutyReviewResolve } from "../duty-scheduling/duty-review-input.js";
export default defineTool({
  approval: ({ toolInput }) => {
    try { parseDutyReviewResolve(toolInput); return "user-approval"; }
    catch (error) { return { type: "denied", reason: error instanceof Error ? error.message : "Нужен сохранённый снимок сверки" }; }
  },
  description: [
    "Закрыть спорную попытку записи после отдельного личного подтверждения владельца. Передай только confirmationInput из inspect_duty_sheet_write inspect.",
    "Для неотправленной checking закрывается неотправленная попытка. Для writing/unknown владелец явно принимает наблюдаемое состояние с неопределённым исходом; окно подтверждения объясняет последствия и риск позднего эффекта Google.",
    "Старые правки не отправляются; reviewed и completed=false не означают успешную запись. После сбоя сначала проверь статус исходной операции, не начинай новую отправку автоматически.",
    "При изменении таблицы, состояния операции или профиля нужен новый просмотр и новое подтверждение. Новые изменения после сверки требуют собственного предпросмотра и согласия.",
  ].join(" "),
  inputSchema: dutyReviewResolveSchema,
  async execute(input, ctx) { return dutyReviewDialog.resolve(input, ctx); },
});
