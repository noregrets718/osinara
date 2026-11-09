/** Durable single-attempt gate. All transactions finish before any Google request begins. */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { PrivateTelegramOwner } from "../family-context.js";
import { sha256Json } from "../json-hash.js";
import { DUTY_SHEET_WRITE_TOOL, type DutySheetWriteInput, type DutySheetWritePlan } from "./duty-sheet-change.js";
import { dutyApprovalEvidenceSchema, hashDutyJson, type DutyApprovalEvidence } from "./duty-snapshot.js";
import { requireDutyApproval, withDutyOwner } from "./duty-storage.js";

export type DutySheetWriteState = "checking" | "writing" | "applied" | "conflict" | "failed" | "unknown";
type WriteRow = { id: string; family_id: string; created_by: string | null; request_hash: string; input: DutySheetWriteInput;
  state: DutySheetWriteState; plan: unknown; error_code: string | null; approval_evidence: unknown };
export type DutySheetWriteResult = { operationId: string; state: DutySheetWriteState; completed: boolean; retryAllowed: false; plan: unknown; errorCode: string | null };

function proof(auth: PrivateTelegramOwner, raw: unknown, evidence: DutyApprovalEvidence) {
  // The common guard accepts the same proof shape; this operation has its own tool name and exact input hash.
  return { ...dutyApprovalEvidenceSchema.parse(evidence), telegramUserId: auth.telegramChatId,
    toolName: DUTY_SHEET_WRITE_TOOL, toolInputHash: sha256Json(raw), approvedByUserId: auth.userId };
}
function present(row: WriteRow): DutySheetWriteResult {
  if (hashDutyJson(row.input) !== row.request_hash) throw new AppError("AGENT_DUTY_SHEET_AUDIT_INVALID", "Реквизиты операции не совпадают с её контрольной суммой");
  return { operationId: row.id, state: row.state, completed: row.state === "applied", retryAllowed: false, plan: row.plan, errorCode: row.error_code };
}

export const dutySheetWriteLog = {
  async claim(auth: PrivateTelegramOwner, input: DutySheetWriteInput, rawInput: unknown, evidence: DutyApprovalEvidence) {
    const approval = proof(auth, rawInput, evidence);
    return withDutyOwner(auth, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`duty-sheet-operation:${input.operationId}`]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`duty-sheet:${input.source.spreadsheetId}`]);
      const old = await client.query<WriteRow>("SELECT * FROM duty_sheet_writes WHERE id = $1", [input.operationId]);
      if (old.rows[0]) {
        const row = old.rows[0];
        if (row.family_id !== auth.familyId || row.created_by !== auth.userId || row.request_hash !== hashDutyJson(input)) {
          throw new AppError("AGENT_DUTY_SHEET_OPERATION_CONFLICT", "Этот ID операции уже использован для других данных");
        }
        return { claimed: false, result: present(row) };
      }
      await requireDutyApproval(client, auth, approval);
      const busy = await client.query("SELECT 1 FROM duty_sheet_writes WHERE spreadsheet_id = $1 AND state IN ('checking', 'writing', 'unknown')", [input.source.spreadsheetId]);
      if (busy.rowCount) throw new AppError("AGENT_DUTY_SHEET_BUSY", "Предыдущая запись ещё выполняется или требует сверки. Новая запись остановлена");
      const inserted = await client.query<WriteRow>(
        "INSERT INTO duty_sheet_writes (id, family_id, created_by, profile_ref, spreadsheet_id, request_hash, input, approval_evidence) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) RETURNING *",
        [input.operationId, auth.familyId, auth.userId, input.source.profileRef, input.source.spreadsheetId, hashDutyJson(input), JSON.stringify(input), JSON.stringify(approval)],
      );
      return { claimed: true, result: present(inserted.rows[0]) };
    });
  },

  async start(auth: PrivateTelegramOwner, input: DutySheetWriteInput, rawInput: unknown, evidence: DutyApprovalEvidence, plan: DutySheetWritePlan) {
    return withDutyOwner(auth, async (client) => {
      await requireDutyApproval(client, auth, proof(auth, rawInput, evidence));
      const saved = { cells: plan.cells, changes: plan.changes, expectedDataHash: plan.expectedDataHash };
      const updated = await client.query<WriteRow>(
        "UPDATE duty_sheet_writes SET state = 'writing', plan = $3::jsonb, write_started_at = now() WHERE id = $1 AND family_id = $2 AND state = 'checking' AND request_hash = $4 RETURNING *",
        [input.operationId, auth.familyId, JSON.stringify(saved), hashDutyJson(input)],
      );
      if (!updated.rowCount) throw new AppError("AGENT_DUTY_SHEET_STATE_INVALID", "Попытка записи уже была начата");
    });
  },

  /** Trusted worker outcome recording: an already-started effect must be recorded even after role revocation. */
  async finish(id: string, state: "applied" | "unknown" | "conflict" | "failed", errorCode: string | null = null) {
    const expected = state === "applied" || state === "unknown" ? "writing" : "checking";
    const result = await database().query<WriteRow>(
      "UPDATE duty_sheet_writes SET state = $2, error_code = $3, finished_at = now() WHERE id = $1 AND state = $4 RETURNING *", [id, state, errorCode, expected],
    );
    if (!result.rowCount) throw new AppError("AGENT_DUTY_SHEET_STATE_INVALID", "Не удалось сохранить результат попытки. Проверьте журнал перед следующей записью");
    return present(result.rows[0]);
  },

  async get(auth: PrivateTelegramOwner, id: string) {
    return withDutyOwner(auth, async (client) => {
      const result = await client.query<WriteRow>("SELECT * FROM duty_sheet_writes WHERE id = $1 AND family_id = $2", [id, auth.familyId]);
      if (!result.rows[0]) throw new AppError("AGENT_DUTY_SHEET_OPERATION_NOT_FOUND", "Операция записи не найдена");
      return present(result.rows[0]);
    });
  },
};
