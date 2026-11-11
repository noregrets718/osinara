/** Root-private exact snapshot approval; publication is a separate action. */
import { defineTool } from "eve/tools";
import { dutyApprovalDialog, parseDutyApprovalRequest } from "../duty-scheduling/duty-approval-dialog.js";
import { dutyApprovalInputSchema } from "../duty-scheduling/duty-snapshot.js";
export default defineTool({
  approval: ({ toolInput }) => {
    try { parseDutyApprovalRequest(toolInput); return "user-approval"; }
    catch (error) { return { type: "denied", reason: error instanceof Error ? error.message : "Нужен сохранённый черновик" }; }
  },
  description: [
    "Утвердить конкретную сохранённую версию графика дежурств по просьбе владельца, только основным агентом в обычном личном диалоге.",
    "Сначала покажи результат manage_duty_schedule prepare/get/latest. Передай его approvalInput без изменений; не составляй хеш, ID или ожидаемую прежнюю версию самостоятельно.",
    "Окно подтверждения загрузит сохранённые назначения, периоды, нагрузку, незакрытые места и версию правил. При замене покажет номер прежней утверждённой версии.",
    "Исполнение повторно проверяет точное личное подтверждение, роль владельца, группу, последний черновик, хеш, допустимость полноты и ожидаемую прежнюю версию. При конфликте прочитай latest и покажи новый график; не подменяй параметры в старом подтверждении.",
    "Утверждается сохранённый расчёт без повторного чтения Google. Если нужны актуальные данные и новые назначения, по просьбе владельца сначала подготовь новый черновик.",
    "Назначения утверждённой версии учитываются в нагрузке; при замене учитывается только действующая версия. Повтор того же вызова не создаёт повторное утверждение и не удваивает нагрузку.",
    "После ошибки сначала прочитай сохранённую версию через get, не создавай новый график автоматически. Утверждение не публикует сообщения в группу; не обходи это другой отправкой и не называй график опубликованным.",
  ].join(" "),
  inputSchema: dutyApprovalInputSchema,
  async execute(input, ctx) { return dutyApprovalDialog.approve(input, ctx); },
});
