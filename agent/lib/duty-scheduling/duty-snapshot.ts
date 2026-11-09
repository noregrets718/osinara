/** Canonical hashes and stored calculation snapshots; reads never recalculate old assignments. */
import { createHash } from "node:crypto";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { canonicalJson } from "../json-hash.js";
import type { DutyDraft } from "./duty-allocation.js";
import type { DutyData } from "./duty-data.js";
import type { DutyHistory } from "./duty-history.js";

export const DUTY_APPROVAL_TOOL = "approve_duty_schedule";
export const dutyApprovalInputSchema = z.object({
  id: z.uuid(), contentHash: z.string().regex(/^[0-9a-f]{64}$/u), expectedApprovedId: z.uuid().nullable(),
}).strict();
export const dutyApprovalEvidenceSchema = z.object({
  applicationSessionId: z.uuid(), eveSessionId: z.string().min(1).max(300), toolCallId: z.string().min(1).max(300),
}).strict();
export type DutyApprovalInput = z.infer<typeof dutyApprovalInputSchema>;
export type DutyApprovalEvidence = z.infer<typeof dutyApprovalEvidenceSchema>;

export type DutySnapshot = Readonly<{
  schemaVersion: 1; id: string; version: number; familyId: string; createdBy: string; baseApprovedId: string | null;
  destination: Readonly<{ groupId: string; telegramChatId: string }>;
  data: DutyData; history: DutyHistory; draft: DutyDraft;
}>;
export type StoredDutyVersion = Readonly<{
  id: string; version: number; date: string; status: "draft" | "approved" | "superseded" | "cancelled";
  contentHash: string; baseApprovedId: string | null; createdAt: string; approvedAt: string | null; snapshot: DutySnapshot;
}>;
export type DutyVersionRow = {
  id: string; family_id: string; group_id: string | null; telegram_chat_id: string; date: string; version: number;
  status: StoredDutyVersion["status"]; content_hash: string; base_approved_id: string | null;
  created_at: Date; approved_at: Date | null; snapshot: DutySnapshot; request_hash: string; approval_evidence: unknown;
};
export const DUTY_VERSION_COLUMNS = "*, duty_date::text AS date";

export function hashDutyJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function presentDutyVersion(row: DutyVersionRow): StoredDutyVersion {
  const snapshot = row.snapshot;
  if (hashDutyJson(snapshot) !== row.content_hash || snapshot.schemaVersion !== 1 ||
      snapshot.id !== row.id || snapshot.version !== row.version || snapshot.familyId !== row.family_id ||
      snapshot.draft?.date !== row.date || snapshot.destination?.telegramChatId !== row.telegram_chat_id ||
      snapshot.baseApprovedId !== row.base_approved_id) {
    throw new AppError("AGENT_DUTY_SNAPSHOT_INVALID", "Контрольная сумма или реквизиты сохранённого графика не совпадают");
  }
  return { id: row.id, version: row.version, date: row.date, status: row.status,
    contentHash: row.content_hash, baseApprovedId: row.base_approved_id, createdAt: row.created_at.toISOString(),
    approvedAt: row.approved_at?.toISOString() ?? null, snapshot };
}
