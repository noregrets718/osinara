/** Owner-private persistent snapshots, exact approval and transactional version replacement. */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";

import { AppError } from "../app-error.js";
import type { PrivateTelegramOwner } from "../family-context.js";
import { prepareDutyDraft } from "./duty-allocation.js";
import { dutyDateSchema, parseDutyData } from "./duty-data.js";
import { parseDutyHistory } from "./duty-history.js";
import {
  DUTY_VERSION_COLUMNS, dutyApprovalEvidenceSchema, dutyApprovalInputSchema, dutyDraftSourceSchema, hashDutyJson, presentDutyVersion,
  type DutyApprovalEvidence, type DutyApprovalInput, type DutySnapshot, type DutyVersionRow,
} from "./duty-snapshot.js";
import { dutyApprovalProof, lockDutyDay, requireDutyApproval, requireDutyGroup, storedDutyHistory, withDutyOwner as transaction } from "./duty-storage.js";

const saveSchema = z.object({
  groupId: z.uuid(), date: dutyDateSchema, operationKey: z.string().trim().min(1).max(300), data: z.unknown(), history: z.unknown(), source: dutyDraftSourceSchema.optional(),
}).strict();
type SaveDutyInput = z.infer<typeof saveSchema>;

async function currentApproved(client: PoolClient, familyId: string, chatId: string, date: string): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    "SELECT id FROM duty_schedule_versions WHERE family_id = $1 AND telegram_chat_id = $2 AND duty_date = $3::date AND status = 'approved'",
    [familyId, chatId, date],
  );
  return result.rows[0]?.id ?? null;
}

function stale(): AppError {
  return new AppError("AGENT_DUTY_VERSION_STALE", "График уже изменился: прочитайте последнюю версию и подтвердите её заново");
}

export const dutyScheduleRepository = {
  async save(auth: PrivateTelegramOwner, raw: SaveDutyInput) {
    const input = saveSchema.parse(raw);
    // Parse synchronously: later caller mutations cannot alter an in-flight snapshot.
    const data = parseDutyData(input.data);
    const baseHistory = parseDutyHistory(input.history, data);
    const requestHash = hashDutyJson({ groupId: input.groupId, date: input.date, data, history: baseHistory, source: input.source });
    return transaction(auth, async (client) => {
      const chatId = await requireDutyGroup(client, auth.familyId, input.groupId);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`duty-op:${auth.familyId}:${input.operationKey}`]);
      await lockDutyDay(client, auth.familyId, chatId, input.date);
      const previous = await client.query<DutyVersionRow>(
        `SELECT ${DUTY_VERSION_COLUMNS} FROM duty_schedule_versions WHERE family_id = $1 AND operation_key = $2`,
        [auth.familyId, input.operationKey],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].request_hash !== requestHash) throw new AppError("AGENT_DUTY_OPERATION_CONFLICT", "Этот ключ операции уже использован для других данных");
        return presentDutyVersion(previous.rows[0]);
      }
      if (input.source) {
        // Same lock as source configuration: a new draft cannot persist against a switched source.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`duty-source:${input.groupId}`]);
        const current = await client.query<{ id: string; version: number }>("SELECT id, version FROM duty_sheet_sources WHERE group_id = $1 AND family_id = $2 ORDER BY version DESC LIMIT 1", [input.groupId, auth.familyId]);
        if (current.rows[0]?.id !== input.source.id || current.rows[0]?.version !== input.source.version) {
          throw new AppError("AGENT_DUTY_SOURCE_VERSION_STALE", "Источник изменился после чтения. Подготовьте черновик заново");
        }
      }
      const history = await storedDutyHistory(client, auth.familyId, chatId, data, baseHistory);
      const draft = prepareDutyDraft(data, history, input.date);
      const baseApprovedId = await currentApproved(client, auth.familyId, chatId, input.date);
      const count = await client.query<{ version: number }>(
        "SELECT coalesce(max(version), 0) + 1 AS version FROM duty_schedule_versions WHERE family_id = $1 AND telegram_chat_id = $2 AND duty_date = $3::date",
        [auth.familyId, chatId, input.date],
      );
      const version = count.rows[0].version;
      const id = randomUUID();
      const group = await client.query<{ title: string }>("SELECT title FROM telegram_groups WHERE id = $1", [input.groupId]);
      const snapshot: DutySnapshot = { schemaVersion: 1, id, version, familyId: auth.familyId, createdBy: auth.userId,
        destination: { groupId: input.groupId, telegramChatId: chatId, title: group.rows[0].title }, baseApprovedId, data, history, draft,
        ...(input.source ? { source: input.source } : {}) };
      const inserted = await client.query<DutyVersionRow>(
        `INSERT INTO duty_schedule_versions
          (id, family_id, group_id, telegram_chat_id, duty_date, version, base_approved_id, snapshot, content_hash, operation_key, request_hash, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12) RETURNING ${DUTY_VERSION_COLUMNS}`,
        [id, auth.familyId, input.groupId, chatId, input.date, version, baseApprovedId, JSON.stringify(snapshot), hashDutyJson(snapshot), input.operationKey, requestHash, auth.userId],
      );
      return presentDutyVersion(inserted.rows[0]);
    });
  },

  async findOperation(auth: PrivateTelegramOwner, operationKey: string) {
    return transaction(auth, async (client) => {
      const result = await client.query<DutyVersionRow>(`SELECT ${DUTY_VERSION_COLUMNS} FROM duty_schedule_versions WHERE family_id = $1 AND operation_key = $2`, [auth.familyId, operationKey]);
      return result.rows[0] ? presentDutyVersion(result.rows[0]) : null;
    });
  },

  async latest(auth: PrivateTelegramOwner, groupId: string, date: string) {
    const id = z.uuid().parse(groupId);
    const day = dutyDateSchema.parse(date);
    return transaction(auth, async (client) => {
      const chatId = await requireDutyGroup(client, auth.familyId, id);
      const result = await client.query<DutyVersionRow>(`SELECT ${DUTY_VERSION_COLUMNS} FROM duty_schedule_versions WHERE family_id = $1 AND telegram_chat_id = $2 AND duty_date = $3::date ORDER BY version DESC LIMIT 1`, [auth.familyId, chatId, day]);
      if (!result.rows[0]) throw new AppError("AGENT_DUTY_VERSION_NOT_FOUND", "На эту дату ещё нет сохранённого графика");
      return presentDutyVersion(result.rows[0]);
    });
  },

  async get(auth: PrivateTelegramOwner, id: string) {
    const parsedId = z.uuid().parse(id);
    return transaction(auth, async (client) => {
      const result = await client.query<DutyVersionRow>(
        `SELECT ${DUTY_VERSION_COLUMNS} FROM duty_schedule_versions WHERE id = $1 AND family_id = $2`, [parsedId, auth.familyId],
      );
      if (!result.rows[0]) throw new AppError("AGENT_DUTY_VERSION_NOT_FOUND", "Сохранённый график не найден");
      return presentDutyVersion(result.rows[0]);
    });
  },

  async history(auth: PrivateTelegramOwner, groupId: string, rawData: unknown, rawHistory: unknown) {
    const data = parseDutyData(rawData);
    const base = parseDutyHistory(rawHistory, data);
    return transaction(auth, async (client) => {
      const chatId = await requireDutyGroup(client, auth.familyId, z.uuid().parse(groupId));
      return storedDutyHistory(client, auth.familyId, chatId, data, base);
    });
  },

  async approve(auth: PrivateTelegramOwner, input: DutyApprovalInput, rawEvidence: DutyApprovalEvidence) {
    const parsed = dutyApprovalInputSchema.parse(input);
    const evidence = dutyApprovalEvidenceSchema.parse(rawEvidence);
    const proof = dutyApprovalProof(auth, input, evidence);
    return transaction(auth, async (client) => {
      const selected = await client.query<DutyVersionRow>(
        `SELECT ${DUTY_VERSION_COLUMNS} FROM duty_schedule_versions WHERE id = $1 AND family_id = $2`, [parsed.id, auth.familyId],
      );
      const row = selected.rows[0];
      if (!row) throw new AppError("AGENT_DUTY_VERSION_NOT_FOUND", "Сохранённый график не найден");
      const chatId = await requireDutyGroup(client, auth.familyId, row.group_id);
      if (chatId !== row.telegram_chat_id) throw stale();
      await lockDutyDay(client, auth.familyId, chatId, row.date);
      const refreshed = await client.query<DutyVersionRow>(`SELECT ${DUTY_VERSION_COLUMNS} FROM duty_schedule_versions WHERE id = $1 FOR UPDATE`, [row.id]);
      const current = refreshed.rows[0];
      const stored = presentDutyVersion(current);
      if (stored.contentHash !== parsed.contentHash || stored.baseApprovedId !== parsed.expectedApprovedId) throw stale();
      if (stored.status === "approved" && hashDutyJson(current.approval_evidence) === hashDutyJson(proof)) return stored;
      const latest = await client.query<{ version: number }>(
        "SELECT max(version) AS version FROM duty_schedule_versions WHERE family_id = $1 AND telegram_chat_id = $2 AND duty_date = $3::date",
        [auth.familyId, chatId, row.date],
      );
      if (stored.status !== "draft" || latest.rows[0].version !== stored.version ||
          await currentApproved(client, auth.familyId, chatId, row.date) !== parsed.expectedApprovedId) throw stale();
      if (!stored.snapshot.draft.canApprove) throw new AppError("AGENT_DUTY_INCOMPLETE", "По этой версии правил неполный график нельзя утвердить");
      await requireDutyApproval(client, auth, proof);
      await client.query("UPDATE duty_schedule_versions SET status = 'superseded' WHERE id = $1 AND family_id = $2 AND status = 'approved'", [parsed.expectedApprovedId, auth.familyId]);
      const updated = await client.query<DutyVersionRow>(
        `UPDATE duty_schedule_versions SET status = 'approved', approved_by = $2, approved_at = now(), approval_evidence = $3::jsonb
         WHERE id = $1 RETURNING ${DUTY_VERSION_COLUMNS}`, [parsed.id, auth.userId, JSON.stringify(proof)],
      );
      return presentDutyVersion(updated.rows[0]);
    });
  },
};
