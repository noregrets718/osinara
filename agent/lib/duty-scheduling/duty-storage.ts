/** Transaction-local owner, destination and approval checks, plus a compact history projection. */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import type { PrivateTelegramOwner } from "../family-context.js";
import { requireLockedOwner } from "../family-repository-checks.js";
import { sha256Json } from "../json-hash.js";
import type { DutyData } from "./duty-data.js";
import { parseDutyHistory, type DutyHistory } from "./duty-history.js";
import { DUTY_APPROVAL_TOOL, type DutyApprovalEvidence, type DutyApprovalInput } from "./duty-snapshot.js";

export async function requireDutyOwner(client: PoolClient, auth: PrivateTelegramOwner): Promise<void> {
  if (auth.role !== "owner") throw new AppError("AGENT_OWNER_REQUIRED", "Это действие доступно только владельцу");
  await requireLockedOwner(client, auth.familyId, auth.userId);
  const owner = await client.query("SELECT 1 FROM users WHERE id = $1 AND telegram_user_id = $2 FOR SHARE", [auth.userId, auth.telegramChatId]);
  if (!owner.rowCount) throw new AppError("AGENT_PRIVATE_CHAT_REQUIRED", "Используйте личный чат владельца");
}

export async function requireDutyGroup(client: PoolClient, familyId: string, groupId: string | null): Promise<string> {
  const result = await client.query<{ telegram_chat_id: string }>(
    "SELECT telegram_chat_id FROM telegram_groups WHERE id = $1 AND family_id = $2 AND type = 'external' FOR SHARE",
    [groupId, familyId],
  );
  if (!result.rows[0]) throw new AppError("AGENT_DUTY_GROUP_INVALID", "Нужна действующая внешняя группа этой семьи");
  return result.rows[0].telegram_chat_id;
}

export async function lockDutyDay(client: PoolClient, familyId: string, chatId: string, date: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`duty:${familyId}:${chatId}:${date}`]);
}

export function dutyApprovalProof(auth: PrivateTelegramOwner, input: DutyApprovalInput, evidence: DutyApprovalEvidence) {
  return { ...evidence, telegramUserId: auth.telegramChatId, toolName: DUTY_APPROVAL_TOOL, toolInputHash: sha256Json(input), approvedByUserId: auth.userId };
}

export async function requireDutyApproval(client: PoolClient, auth: PrivateTelegramOwner, proof: ReturnType<typeof dutyApprovalProof>): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM telegram_hitl_approvals a JOIN conversation_sessions s ON s.id = a.application_session_id
     WHERE a.application_session_id = $1 AND a.eve_session_id = $2 AND a.tool_call_id = $3
       AND a.tool_name = $4 AND a.tool_input_hash = $5 AND a.expected_telegram_user_id = $6
       AND a.telegram_chat_type = 'private' AND a.telegram_chat_id = $6
       AND a.consumed_at IS NOT NULL AND a.timed_out_at IS NULL
       AND a.selected_option_id = 'approve' AND a.request_kind = 'tool-approval'
       AND s.eve_session_id = a.eve_session_id AND s.retired_at IS NULL
       AND s.family_id = $7 AND s.owner_user_id = $8 AND s.scope = 'personal'
     FOR SHARE OF a, s`,
    [proof.applicationSessionId, proof.eveSessionId, proof.toolCallId, proof.toolName, proof.toolInputHash,
      auth.telegramChatId, auth.familyId, auth.userId],
  );
  if (!result.rowCount) throw new AppError("AGENT_TOOL_APPROVAL_EVIDENCE_INVALID", "Нет точного подтверждения этого графика в личном чате владельца");
}

export async function storedDutyHistory(client: PoolClient, familyId: string, chatId: string, data: DutyData, base: DutyHistory): Promise<DutyHistory> {
  if (base.mode === "not_loaded") return base;
  const result = await client.query<{ id: string; date: string; version: number; status: string; assignments: unknown[] }>(
    `SELECT v.id, v.duty_date::text AS date, v.version, v.status,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('residentId', a->>'residentId', 'objectId', o->>'objectId', 'credit', a->'credit'))
         FROM jsonb_array_elements(v.snapshot#>'{draft,objects}') o,
              jsonb_array_elements(o->'assignments') a), '[]'::jsonb) AS assignments
     FROM duty_schedule_versions v
     WHERE v.family_id = $1 AND v.telegram_chat_id = $2 AND v.approved_at IS NOT NULL AND v.duty_date >= $3::date
     ORDER BY v.duty_date, v.version`,
    [familyId, chatId, base.fromDate],
  );
  const replacedDates = new Set(result.rows.map((row) => row.date));
  return parseDutyHistory({ ...base, schedules: [
    ...base.schedules.filter((schedule) => !replacedDates.has(schedule.date)), ...result.rows,
  ] }, data);
}
