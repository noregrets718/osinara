/** Confirmed, versioned source configuration for one registered external group. */
import { z } from "zod";
import { AppError } from "../app-error.js";
import type { PrivateTelegramOwner } from "../family-context.js";
import { parseDutySheetSource } from "./duty-sheet-format.js";
import { hashDutyJson, type DutyApprovalEvidence } from "./duty-snapshot.js";
import { dutyOwnerApprovalProof, requireDutyApproval, requireDutyGroup, withDutyOwner } from "./duty-storage.js";

export const DUTY_SOURCE_TOOL = "configure_duty_sheet_source";
const inputSchema = z.object({ operationId: z.uuid(), groupId: z.uuid(), expectedVersion: z.number().int().nonnegative(), source: z.unknown(), readHash: z.string().regex(/^[a-f0-9]{64}$/u).optional() }).strict();
export function parseDutySourceChange(raw: unknown) {
  const value = inputSchema.parse(raw);
  return { ...value, source: parseDutySheetSource(value.source) };
}
type SourceRow = { id: string; version: number; family_id: string; input: ReturnType<typeof parseDutySourceChange>; request_hash: string; created_at: Date };
function present(row: SourceRow) {
  if (hashDutyJson(row.input) !== row.request_hash || row.id !== row.input.operationId || row.version !== row.input.expectedVersion + 1) {
    throw new AppError("AGENT_DUTY_SOURCE_INVALID", "Реквизиты сохранённой настройки не совпадают");
  }
  return { id: row.id, version: row.version, groupId: row.input.groupId, source: row.input.source, createdAt: row.created_at.toISOString() };
}

export const dutySheetSourceRepository = {
  async inspect(auth: PrivateTelegramOwner, groupId: string) {
    const id = z.uuid().parse(groupId);
    return withDutyOwner(auth, async (client) => {
      const telegramChatId = await requireDutyGroup(client, auth.familyId, id);
      const group = await client.query<{ title: string }>("SELECT title FROM telegram_groups WHERE id = $1", [id]);
      const result = await client.query<SourceRow>("SELECT * FROM duty_sheet_sources WHERE group_id = $1 AND family_id = $2 ORDER BY version DESC LIMIT 1", [id, auth.familyId]);
      return { group: { groupId: id, title: group.rows[0].title, telegramChatId }, configuration: result.rows[0] ? present(result.rows[0]) : null };
    });
  },

  async findOperation(auth: PrivateTelegramOwner, raw: unknown) {
    const input = parseDutySourceChange(raw);
    return withDutyOwner(auth, async (client) => {
      await requireDutyGroup(client, auth.familyId, input.groupId);
      const result = await client.query<SourceRow>("SELECT * FROM duty_sheet_sources WHERE id = $1", [input.operationId]);
      if (!result.rows[0]) return null;
      if (result.rows[0].family_id !== auth.familyId || result.rows[0].request_hash !== hashDutyJson(input)) {
        throw new AppError("AGENT_DUTY_SOURCE_OPERATION_CONFLICT", "ID настройки уже использован для других данных");
      }
      return present(result.rows[0]);
    });
  },

  async save(auth: PrivateTelegramOwner, raw: unknown, evidence: DutyApprovalEvidence) {
    const input = parseDutySourceChange(raw);
    const approval = dutyOwnerApprovalProof(auth, raw, evidence, DUTY_SOURCE_TOOL);
    return withDutyOwner(auth, async (client) => {
      const chatId = await requireDutyGroup(client, auth.familyId, input.groupId);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`duty-source-op:${input.operationId}`]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`duty-source:${input.groupId}`]);
      const old = await client.query<SourceRow>("SELECT * FROM duty_sheet_sources WHERE id = $1", [input.operationId]);
      if (old.rows[0]) {
        if (old.rows[0].family_id !== auth.familyId || old.rows[0].request_hash !== hashDutyJson(input)) {
          throw new AppError("AGENT_DUTY_SOURCE_OPERATION_CONFLICT", "ID настройки уже использован для других данных");
        }
        return present(old.rows[0]);
      }
      await requireDutyApproval(client, auth, approval);
      const latest = await client.query<{ version: number }>("SELECT coalesce(max(version), 0) AS version FROM duty_sheet_sources WHERE group_id = $1 AND family_id = $2", [input.groupId, auth.familyId]);
      if (latest.rows[0].version !== input.expectedVersion) throw new AppError("AGENT_DUTY_SOURCE_VERSION_STALE", "Настройка уже изменилась. Прочитайте последнюю версию и подтвердите изменение заново");
      const result = await client.query<SourceRow>(
        "INSERT INTO duty_sheet_sources (id, family_id, group_id, telegram_chat_id, version, request_hash, input, approval_evidence, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9) RETURNING *",
        [input.operationId, auth.familyId, input.groupId, chatId, input.expectedVersion + 1, hashDutyJson(input), JSON.stringify(input), JSON.stringify(approval), auth.userId],
      );
      return present(result.rows[0]);
    });
  },

  async get(auth: PrivateTelegramOwner, groupId: string) {
    const id = z.uuid().parse(groupId);
    return withDutyOwner(auth, async (client) => {
      await requireDutyGroup(client, auth.familyId, id);
      const result = await client.query<SourceRow>("SELECT * FROM duty_sheet_sources WHERE group_id = $1 AND family_id = $2 ORDER BY version DESC LIMIT 1", [id, auth.familyId]);
      if (!result.rows[0]) throw new AppError("AGENT_DUTY_SOURCE_NOT_CONFIGURED", "Сначала выберите таблицу для этой внешней группы");
      return present(result.rows[0]);
    });
  },
};
