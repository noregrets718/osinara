/** Check the saved source under its configuration lock, within the caller's owner transaction. */
import type { PoolClient } from "pg";
import { AppError } from "../app-error.js";
import type { PrivateTelegramOwner } from "../family-context.js";
import type { DutySheetWriteInput } from "./duty-sheet-change.js";
import { hashDutyJson } from "./duty-snapshot.js";
import { requireDutyGroup } from "./duty-storage.js";

export async function requireDutyWriteBinding(client: PoolClient, auth: PrivateTelegramOwner, input: DutySheetWriteInput) {
  if (!input.binding) return; // Older internal callers use exact source inputs, without the dialog.
  const { groupId, id, version } = input.binding;
  await requireDutyGroup(client, auth.familyId, groupId);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`duty-source:${groupId}`]);
  const result = await client.query<{ id: string; version: number; input: { source: unknown } }>("SELECT id, version, input FROM duty_sheet_sources WHERE family_id=$1 AND group_id=$2 ORDER BY version DESC LIMIT 1", [auth.familyId, groupId]);
  const current = result.rows[0];
  if (!current || current.id !== id || current.version !== version || hashDutyJson(current.input.source) !== hashDutyJson(input.source)) {
    throw new AppError("AGENT_DUTY_SOURCE_VERSION_STALE", "Источник группы изменился. Подготовьте и подтвердите правки заново");
  }
}
