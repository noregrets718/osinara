/** Read-only reconciliation, then an exact owner-approved acknowledgement. Never dispatches Google writes. */
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { AppError } from "../app-error.js";
import { requirePrivateTelegramOwner, type PrivateTelegramOwner } from "../family-context.js";
import { dutySheetDataHash } from "./duty-sheet-change.js";
import { readDutySheet } from "./duty-sheet-reader.js";
import { dutySheetWriteLog } from "./duty-sheet-write-log.js";
import { dutySheetWorkerContext, withDutySheetWorker, type DutySheetWorker } from "./duty-sheet-worker.js";
import { dutyApprovalEvidenceSchema, hashDutyJson, type DutyApprovalEvidence } from "./duty-snapshot.js";
import { dutyOwnerApprovalProof, requireDutyApproval, withDutyOwner } from "./duty-storage.js";

export const DUTY_SHEET_REVIEW_TOOL = "resolve_duty_sheet_write";
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const inputSchema = z.object({ operationId: z.uuid(), profileRef: z.string().min(1).max(300).optional(), reviewHash: hash,
  decision: z.enum(["cancel_unstarted", "accept_current"]), acknowledgeUncertainOutcome: z.literal(true).optional() }).strict();
export type DutySheetReviewInput = z.infer<typeof inputSchema>;
const planSchema = z.object({ expectedDataHash: hash, cells: z.array(z.object({ range: z.string(), before: z.union([z.string(), z.number(), z.boolean()]), after: z.union([z.string(), z.number(), z.boolean()]) })) });
type Dependencies = { owner: typeof requirePrivateTelegramOwner; read: typeof readDutySheet; log: typeof dutySheetWriteLog; withWorker?: typeof withDutySheetWorker };
type SavedReview = { request_hash: string; input: DutySheetReviewInput; snapshot: DutySheetReviewSnapshot; resolved_at: Date };

export type DutySheetReviewSnapshot = Awaited<ReturnType<ReturnType<typeof createDutySheetReviewer>["inspect"]>>;

export function createDutySheetReviewer(deps: Dependencies) {
  async function observe(auth: PrivateTelegramOwner, id: string, ctx: ToolContext, worker: DutySheetWorker, profileRef?: string) {
    const record = await deps.log.reviewRecord(auth, id);
    if (!["checking", "writing", "unknown"].includes(record.state)) throw new AppError("AGENT_DUTY_SHEET_REVIEW_NOT_NEEDED", "Для этого состояния сверка не требуется");
    const source = { ...record.input.source, profileRef: profileRef ?? record.input.source.profileRef };
    const plan = record.state === "checking" ? null : planSchema.parse(record.plan);
    const loaded = record.state === "checking" ? null : await deps.read(source, dutySheetWorkerContext(ctx, worker), undefined, { formulas: true });
    await worker.check();
    const observation = loaded ? { sourceHash: loaded.source.contentHash, dataHash: dutySheetDataHash(loaded), data: loaded.data, history: loaded.history } : null;
    const snapshot = { operationId: id, familyId: auth.familyId, ownerUserId: auth.userId, state: record.state, requestHash: record.request_hash,
      source, plannedCells: plan?.cells ?? [], observation,
      classification: !observation ? "not_sent" as const : observation.dataHash === plan?.expectedDataHash ? "matches_expected" as const : "differs_from_expected" as const };
    return withDutyOwner(auth, async () => ({ ...snapshot, reviewHash: hashDutyJson(snapshot) }));
  }

  return {
    async inspect(operationId: string, ctx: ToolContext, profileRef?: string) {
      const auth = deps.owner(ctx);
      const id = z.uuid().parse(operationId);
      if (profileRef !== undefined) z.string().min(1).max(300).parse(profileRef);
      // Verify access before taking a resource lock on an operation supplied by the caller.
      await deps.log.reviewRecord(auth, id);
      return (deps.withWorker ?? withDutySheetWorker)(id, (worker) => observe(auth, id, ctx, worker, profileRef));
    },

    async resolve(raw: unknown, rawEvidence: DutyApprovalEvidence, ctx: ToolContext) {
      const auth = deps.owner(ctx);
      const input = inputSchema.parse(raw);
      const approval = dutyOwnerApprovalProof(auth, raw, dutyApprovalEvidenceSchema.parse(rawEvidence), DUTY_SHEET_REVIEW_TOOL);
      await deps.log.reviewRecord(auth, input.operationId);
      return (deps.withWorker ?? withDutySheetWorker)(input.operationId, async (worker) => {
        const old = await withDutyOwner(auth, async (client) => {
          const result = await client.query<SavedReview>("SELECT * FROM duty_sheet_reviews WHERE operation_id = $1 AND family_id = $2", [input.operationId, auth.familyId]);
          if (!result.rows[0]) await requireDutyApproval(client, auth, approval);
          return result.rows[0];
        });
        if (old) {
          const { reviewHash, ...payload } = old.snapshot;
          if (hashDutyJson(old.input) !== old.request_hash || hashDutyJson(payload) !== reviewHash || old.input.reviewHash !== reviewHash) {
            throw new AppError("AGENT_DUTY_SHEET_REVIEW_INVALID", "Контрольная сумма сохранённой сверки не совпадает");
          }
          if (old.request_hash !== hashDutyJson(input)) throw new AppError("AGENT_DUTY_SHEET_REVIEW_CONFLICT", "Операция уже сверена с другим решением");
          return { state: "reviewed" as const, completed: false as const, review: old.snapshot, resolvedAt: old.resolved_at.toISOString() };
        }
        const snapshot = await observe(auth, input.operationId, ctx, worker, input.profileRef);
        if (snapshot.reviewHash !== input.reviewHash) throw new AppError("AGENT_DUTY_SHEET_REVIEW_STALE", "Состояние изменилось после просмотра. Выполните сверку и подтвердите её заново");
        if ((snapshot.state === "checking" && input.decision !== "cancel_unstarted") ||
            (snapshot.state !== "checking" && (input.decision !== "accept_current" || input.acknowledgeUncertainOutcome !== true))) {
          throw new AppError("AGENT_DUTY_SHEET_REVIEW_DECISION_INVALID", "Нужно явно принять текущее состояние с неопределённым исходом; это не подтверждение успешной записи");
        }
        await worker.check();
        return withDutyOwner(auth, async (client) => {
          await requireDutyApproval(client, auth, approval);
          const current = await client.query<{ state: string }>("SELECT state FROM duty_sheet_writes WHERE id = $1 AND family_id = $2 FOR UPDATE", [input.operationId, auth.familyId]);
          if (current.rows[0]?.state !== snapshot.state) throw new AppError("AGENT_DUTY_SHEET_REVIEW_STALE", "Исполнитель уже изменил состояние операции");
          const saved = await client.query<SavedReview>(
            "INSERT INTO duty_sheet_reviews (operation_id, family_id, input, request_hash, snapshot, approval_evidence, resolved_by) VALUES ($1,$2,$3::jsonb,$4,$5::jsonb,$6::jsonb,$7) RETURNING *",
            [input.operationId, auth.familyId, JSON.stringify(input), hashDutyJson(input), JSON.stringify(snapshot), JSON.stringify(approval), auth.userId],
          );
          await client.query("UPDATE duty_sheet_writes SET state = 'reviewed', finished_at = coalesce(finished_at, now()) WHERE id = $1", [input.operationId]);
          return { state: "reviewed" as const, completed: false as const, review: snapshot, resolvedAt: saved.rows[0].resolved_at.toISOString() };
        });
      });
    },
  };
}

export const dutySheetReviewer = createDutySheetReviewer({ owner: requirePrivateTelegramOwner, read: readDutySheet, log: dutySheetWriteLog });
