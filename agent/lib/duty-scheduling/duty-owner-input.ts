/** Object-shaped Eve descriptor plus exact action contracts; input never contains source data or actor IDs. */
import { z } from "zod";
import { AppError } from "../app-error.js";
import { dutyDateSchema } from "./duty-data.js";

export const dutyOwnerInputSchema = z.object({
  action: z.enum(["groups", "prepare", "get", "latest"]),
  groupId: z.uuid().optional().describe("ID внешней группы только из результата action=groups"),
  date: dutyDateSchema.optional().describe("Точная календарная дата YYYY-MM-DD в часовом поясе проживания"),
  id: z.uuid().optional().describe("ID сохранённой версии из prepare или latest; только для action=get"),
}).strict();
const contracts = z.discriminatedUnion("action", [
  z.object({ action: z.literal("groups") }).strict(),
  z.object({ action: z.literal("prepare"), groupId: z.uuid(), date: dutyDateSchema }).strict(),
  z.object({ action: z.literal("get"), id: z.uuid() }).strict(),
  z.object({ action: z.literal("latest"), groupId: z.uuid(), date: dutyDateSchema }).strict(),
]);
export type DutyOwnerInput = z.infer<typeof contracts>;
export function parseDutyOwnerInput(raw: unknown): DutyOwnerInput {
  const parsed = contracts.safeParse(raw);
  if (!parsed.success) throw new AppError("AGENT_DUTY_OWNER_INPUT_INVALID", "Передайте только поля выбранного действия: groups — action; prepare/latest — action, groupId, date YYYY-MM-DD; get — action, id");
  return parsed.data;
}
