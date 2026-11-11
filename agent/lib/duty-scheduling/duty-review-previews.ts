/** Immutable lean review facts; full imported residents/history never enter the confirmation ticket. */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { AppError } from "../app-error.js";
import type { PrivateTelegramOwner } from "../family-context.js";
import { dutySheetReviewInputSchema, type DutySheetReviewInput } from "./duty-review-input.js";
import type { DutySheetReviewSnapshot } from "./duty-sheet-review.js";
import { hashDutyJson } from "./duty-snapshot.js";
import { withDutyOwner } from "./duty-storage.js";

const cell = z.union([z.string(), z.number(), z.boolean()]);
export const dutyReviewViewSchema = z.object({ operationId: z.uuid(), requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  state: z.enum(["checking", "writing", "unknown"]), classification: z.enum(["not_sent", "matches_expected", "differs_from_expected"]),
  spreadsheetId: z.string(), profileRef: z.string(),
  cells: z.array(z.object({ range: z.string(), before: cell, after: cell, current: cell }).strict()),
}).strict();
export type DutyReviewView = z.infer<typeof dutyReviewViewSchema>;
type Row = { id: string; input: DutySheetReviewInput; view: DutyReviewView; content_hash: string; created_at: Date };
function present(row: Row) {
  const input = dutySheetReviewInputSchema.parse(row.input), view = dutyReviewViewSchema.parse(row.view);
  if (hashDutyJson({ input: row.input, view: row.view }) !== row.content_hash || input.previewId || input.operationId !== view.operationId || input.profileRef !== view.profileRef ||
      (view.state === "checking" ? input.decision !== "cancel_unstarted" || view.classification !== "not_sent" : input.decision !== "accept_current" || input.acknowledgeUncertainOutcome !== true)) {
    throw new AppError("AGENT_DUTY_REVIEW_PREVIEW_INVALID", "Снимок сверки не прошёл проверку");
  }
  return { id: row.id, input, view, createdAt: row.created_at.toISOString() };
}
async function load(client: PoolClient, auth: PrivateTelegramOwner, id: string) {
  const result = await client.query<Row>("SELECT * FROM duty_sheet_review_previews WHERE id=$1 AND family_id=$2", [id, auth.familyId]);
  if (!result.rows[0]) throw new AppError("AGENT_DUTY_REVIEW_PREVIEW_NOT_FOUND", "Снимок сверки не найден");
  return present(result.rows[0]);
}
export async function requireDutyReviewPreview(client: PoolClient, auth: PrivateTelegramOwner, input: DutySheetReviewInput) {
  if (!input.previewId) return;
  const saved = await load(client, auth, input.previewId);
  const { previewId: _id, ...original } = input;
  if (hashDutyJson(original) !== hashDutyJson(saved.input)) throw new AppError("AGENT_DUTY_REVIEW_PREVIEW_INVALID", "Решение не совпадает с сохранённым снимком сверки");
}
export const dutyReviewPreviews = {
  async save(auth: PrivateTelegramOwner, raw: DutySheetReviewSnapshot) {
    const snapshot = structuredClone(raw);
    const { reviewHash, ...payload } = snapshot;
    if (hashDutyJson(payload) !== reviewHash || snapshot.familyId !== auth.familyId || snapshot.ownerUserId !== auth.userId) throw new AppError("AGENT_DUTY_REVIEW_PREVIEW_INVALID", "Неверные реквизиты прочитанной сверки");
    const decision = snapshot.state === "checking" ? "cancel_unstarted" as const : "accept_current" as const;
    const input = dutySheetReviewInputSchema.parse({ operationId: snapshot.operationId, profileRef: snapshot.source.profileRef, reviewHash, decision,
      ...(decision === "accept_current" ? { acknowledgeUncertainOutcome: true } : {}) });
    const view = dutyReviewViewSchema.parse({ operationId: snapshot.operationId, requestHash: snapshot.requestHash, state: snapshot.state, classification: snapshot.classification,
      spreadsheetId: snapshot.source.spreadsheetId, profileRef: snapshot.source.profileRef, cells: snapshot.observedCells });
    if (Buffer.byteLength(JSON.stringify({ input, view })) > 128 * 1024) throw new AppError("AGENT_DUTY_PREVIEW_TOO_LARGE", "Сверка слишком велика для одного подтверждения");
    return withDutyOwner(auth, async (client) => {
      const record = await client.query<{ state: string; request_hash: string; spreadsheet_id: string }>("SELECT state, request_hash, spreadsheet_id FROM duty_sheet_writes WHERE id=$1 AND family_id=$2 FOR SHARE", [input.operationId, auth.familyId]);
      if (record.rows[0]?.state !== view.state || record.rows[0]?.request_hash !== view.requestHash || record.rows[0]?.spreadsheet_id !== view.spreadsheetId) throw new AppError("AGENT_DUTY_SHEET_REVIEW_STALE", "Операция изменилась во время просмотра. Повторите сверку");
      const result = await client.query<Row>("INSERT INTO duty_sheet_review_previews (id,operation_id,family_id,input,view,content_hash,created_by) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7) RETURNING *",
        [randomUUID(), input.operationId, auth.familyId, JSON.stringify(input), JSON.stringify(view), hashDutyJson({ input, view }), auth.userId]);
      return present(result.rows[0]);
    });
  },
  async get(auth: PrivateTelegramOwner, id: string) { return withDutyOwner(auth, (client) => load(client, auth, z.uuid().parse(id))); },
};
