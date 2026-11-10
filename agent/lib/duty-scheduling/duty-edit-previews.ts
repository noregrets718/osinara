/** Immutable owner previews bind a small confirmation ID to the exact source, edits and cell plan. */
import type { PoolClient } from "pg";
import { z } from "zod";
import { AppError } from "../app-error.js";
import type { PrivateTelegramOwner } from "../family-context.js";
import { parseDutySheetWrite, type DutySheetWriteInput, type DutySheetWritePlan } from "./duty-sheet-change.js";
import { hashDutyJson } from "./duty-snapshot.js";
import { withDutyOwner } from "./duty-storage.js";
import { requireDutyWriteBinding } from "./duty-write-binding.js";

const cell = z.union([z.string(), z.number(), z.boolean()]);
const planSchema = z.object({ cells: z.array(z.object({ range: z.string(), before: cell, after: cell }).strict()).min(1),
  labels: z.record(z.string(), z.string()), expectedDataHash: z.string().regex(/^[a-f0-9]{64}$/u), rulesBefore: z.string(), rulesAfter: z.string() }).strict();
export type DutyEditPreviewPlan = z.infer<typeof planSchema>;
type Row = { id: string; input: DutySheetWriteInput; plan: DutyEditPreviewPlan; content_hash: string; created_at: Date };
function present(row: Row) {
  if (hashDutyJson({ input: row.input, plan: row.plan }) !== row.content_hash || row.id !== row.input.operationId || row.input.previewId || !row.input.binding) {
    throw new AppError("AGENT_DUTY_PREVIEW_INVALID", "Сохранённый предпросмотр не прошёл проверку");
  }
  return { id: row.id, input: parseDutySheetWrite(row.input), plan: planSchema.parse(row.plan), createdAt: row.created_at.toISOString() };
}
async function load(client: PoolClient, auth: PrivateTelegramOwner, id: string) {
  const result = await client.query<Row>("SELECT * FROM duty_sheet_change_previews WHERE id=$1 AND family_id=$2", [id, auth.familyId]);
  if (!result.rows[0]) throw new AppError("AGENT_DUTY_PREVIEW_NOT_FOUND", "Предпросмотр не найден");
  return present(result.rows[0]);
}
export async function requireDutyEditPreview(client: PoolClient, auth: PrivateTelegramOwner, input: DutySheetWriteInput, plan?: DutySheetWritePlan) {
  if (!input.previewId) return;
  const stored = await load(client, auth, input.previewId);
  const { previewId: _id, ...original } = input;
  if (hashDutyJson(original) !== hashDutyJson(stored.input)) throw new AppError("AGENT_DUTY_PREVIEW_INVALID", "Правки не совпадают с сохранённым предпросмотром");
  if (plan && hashDutyJson({ cells: plan.cells, expectedDataHash: plan.expectedDataHash }) !== hashDutyJson({ cells: stored.plan.cells, expectedDataHash: stored.plan.expectedDataHash })) {
    throw new AppError("AGENT_DUTY_PREVIEW_INVALID", "План записи изменился. Нужен новый предпросмотр");
  }
}
export const dutyEditPreviews = {
  async save(auth: PrivateTelegramOwner, rawInput: unknown, rawPlan: DutyEditPreviewPlan) {
    const input = parseDutySheetWrite(rawInput); const plan = planSchema.parse(rawPlan);
    if (!input.binding || input.previewId) throw new AppError("AGENT_DUTY_PREVIEW_INVALID", "Нужен источник группы без ссылки на прежний предпросмотр");
    if (Buffer.byteLength(JSON.stringify({ input, plan })) > 64 * 1024) throw new AppError("AGENT_DUTY_PREVIEW_TOO_LARGE", "Разделите правки на меньшие независимые изменения");
    return withDutyOwner(auth, async (client) => {
      await requireDutyWriteBinding(client, auth, input);
      const result = await client.query<Row>("INSERT INTO duty_sheet_change_previews (id,family_id,group_id,input,plan,content_hash,created_by) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7) RETURNING *",
        [input.operationId, auth.familyId, input.binding!.groupId, JSON.stringify(input), JSON.stringify(plan), hashDutyJson({ input, plan }), auth.userId]);
      return present(result.rows[0]);
    });
  },
  async get(auth: PrivateTelegramOwner, id: string) { return withDutyOwner(auth, (client) => load(client, auth, z.uuid().parse(id))); },
};
